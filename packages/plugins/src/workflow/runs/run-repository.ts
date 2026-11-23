/**
 * runs/run-repository.ts — Single persistence truth for workflow & background subagent runs.
 *
 * Design:
 * - Compact `RunHeader` rows live in `ctx.kv('runs')` (one key per runId; O(1) SQLite row UPSERT,
 *   auto-redacted by PluginKvRegistry, zero 2 MiB whole-array doc ceiling, bounded memory footprint);
 * - Heavy `RunDetail` (`script`, `args`, `result`, full `nodes` with prompt/schema/output, `progress`
 *   logs, `subagentSpec`) lives lazily in `artifacts/<convId>/wf-<runId>.detail.json` with a 128-entry
 *   in-memory LRU cache — `listRuns()` and session projections perform ZERO disk I/O;
 * - Takeover tracking (`resumedByRunId`) is NEVER dual-written to storage: derived purely in memory
 *   from each header's single-key atomic `replayedFrom` field (`takenOverBy` reverse index),
 *   eliminating dual-write crash windows and 4-surface ghost probing.
 */
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  compareCodeUnit,
  HelmxError,
  isValidNodeId,
  redactJsonValue,
  type PluginKvHandle,
  type PluginKvListOptions,
  type PluginKvListResult,
} from '@helmx/protocol'
import type {
  WorkflowNodeState,
  WorkflowRunStatus,
  WorkflowRunSummary,
} from '../../contracts.js'
import type { RunDetail, RunHeader, RunPhase } from './types.js'

const VALID_STATUSES: ReadonlySet<string> = new Set<WorkflowRunStatus>(['running', 'completed', 'failed', 'aborted'])
const VALID_PHASES: ReadonlySet<string> = new Set<RunPhase>(['running', 'suspended', 'cleanup_pending', 'settled'])
const MAX_HEADER_NODES = 128
const MAX_HEADER_PROGRESS = 64
const MAX_HEADER_PROMPT_CHARS = 256
const MAX_HEADER_TEXT_CHARS = 512
const MAX_DETAIL_TEXT_CHARS = 1024
const RESULT_PREVIEW_MAX_CHARS = 200
const DETAIL_LRU_CAP = 128

export type WorkflowKvStore<T = RunHeader> = PluginKvHandle<T>
export type AnyWorkflowKvStore = PluginKvHandle<RunHeader> | PluginKvHandle<unknown>

export function newRunId(): string {
  return `wf_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

export function formatResultPreview(result: unknown): string {
  if (typeof result === 'string') {
    const firstLine = result.trim().split(/\r?\n/, 1)[0]!.trim()
    return truncateText(firstLine, RESULT_PREVIEW_MAX_CHARS)
  }
  const serialized = JSON.stringify(result) ?? String(result)
  return truncateText(serialized, RESULT_PREVIEW_MAX_CHARS)
}

/** Slim node for compact RunHeader storage in KV (strips schema/output; bounds prompt/error/gate.output). */
export function slimNodeForHeader(node: WorkflowNodeState, redact: (text: string) => string): WorkflowNodeState {
  const { schema: _s, output: _o, ...rest } = node
  const clean = redactJsonValue(rest, redact) as WorkflowNodeState
  if (clean.prompt !== undefined) clean.prompt = truncateText(clean.prompt, MAX_HEADER_PROMPT_CHARS)
  if (clean.error !== undefined) clean.error = truncateText(clean.error, MAX_HEADER_TEXT_CHARS)
  if (clean.gate !== undefined) {
    clean.gate = { ...clean.gate, output: truncateText(clean.gate.output, MAX_HEADER_TEXT_CHARS) }
  }
  return clean
}

function slimProgressForHeader(
  progress: RunHeader['progress'],
  redact: (text: string) => string,
): RunHeader['progress'] {
  if (progress === undefined || progress.length === 0) return undefined
  return progress.slice(-MAX_HEADER_PROGRESS).map((entry) =>
    entry.kind === 'phase'
      ? { at: entry.at, kind: 'phase' as const, index: entry.index, title: truncateText(redact(entry.title), MAX_HEADER_PROMPT_CHARS) }
      : { at: entry.at, kind: 'log' as const, message: truncateText(redact(entry.message), MAX_HEADER_PROMPT_CHARS) },
  )
}

/** Redact & bound node for RunDetail persistence (single-pass redaction; preserves prompt/schema/output). */
export function redactNodeForDetail(node: WorkflowNodeState, redact: (text: string) => string): WorkflowNodeState {
  const clean = redactJsonValue(node, redact) as WorkflowNodeState
  if (clean.prompt !== undefined) clean.prompt = truncateText(clean.prompt, MAX_DETAIL_TEXT_CHARS)
  if (clean.error !== undefined) clean.error = truncateText(clean.error, MAX_DETAIL_TEXT_CHARS)
  if (clean.gate !== undefined) {
    clean.gate = { ...clean.gate, output: truncateText(clean.gate.output, MAX_DETAIL_TEXT_CHARS) }
  }
  return clean
}

/** Standalone in-memory KV handle for unit tests that construct WorkflowService directly. */
export function createMemoryKvStore<T = unknown>(): PluginKvHandle<T> {
  const map = new Map<string, { value: T; updatedAt: number }>()
  return {
    get: (key) => {
      const hit = map.get(key)
      return hit === undefined ? undefined : structuredClone(hit.value)
    },
    set: (key, value) => {
      map.set(key, { value: structuredClone(value), updatedAt: Date.now() })
    },
    delete: (key) => map.delete(key),
    list: (opts?: PluginKvListOptions): PluginKvListResult<T> => {
      const keys = [...map.keys()]
        .filter((k) => (opts?.prefix === undefined || k.startsWith(opts.prefix)) && (opts?.cursor === undefined || compareCodeUnit(k, opts.cursor) > 0))
        .sort(compareCodeUnit)
      const limit = opts?.limit ?? 1000
      const hasMore = keys.length > limit
      const page = hasMore ? keys.slice(0, limit) : keys
      const items = page.map((key) => {
        const entry = map.get(key)!
        return { key, value: structuredClone(entry.value), updatedAt: entry.updatedAt }
      })
      return {
        items,
        ...(hasMore && items.length > 0 ? { nextCursor: items[items.length - 1]!.key } : {}),
      }
    },
    clear: () => {
      map.clear()
    },
    flush: async () => {},
  }
}

function validateHeader(key: string, value: unknown): RunHeader {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HelmxError('workflow_record_corrupt', `workflow run ${key} header is not an object`, 500, { runId: key })
  }
  const r = value as Record<string, unknown>
  if (r['id'] !== key) {
    throw new HelmxError('workflow_record_corrupt', `workflow run ${key} header id mismatch`, 500, { runId: key })
  }
  if (typeof r['name'] !== 'string') {
    throw new HelmxError('workflow_record_corrupt', `workflow run ${key} header name invalid`, 500, { runId: key })
  }
  if (!Number.isInteger(r['conversationId']) || (r['conversationId'] as number) < 1) {
    throw new HelmxError('workflow_record_corrupt', `workflow run ${key} header conversationId invalid`, 500, { runId: key })
  }
  if (typeof r['status'] !== 'string' || !VALID_STATUSES.has(r['status'])) {
    throw new HelmxError('workflow_record_corrupt', `workflow run ${key} header status invalid`, 500, { runId: key })
  }
  if (typeof r['phase'] !== 'string' || !VALID_PHASES.has(r['phase'])) {
    throw new HelmxError('workflow_record_corrupt', `workflow run ${key} header phase invalid`, 500, { runId: key })
  }
  if (r['kind'] !== 'workflow' && r['kind'] !== 'subagent') {
    throw new HelmxError('workflow_record_corrupt', `workflow run ${key} header kind invalid`, 500, { runId: key })
  }
  if (typeof r['createdAt'] !== 'number' || !Number.isFinite(r['createdAt'])) {
    throw new HelmxError('workflow_record_corrupt', `workflow run ${key} header createdAt invalid`, 500, { runId: key })
  }
  if (typeof r['updatedAt'] !== 'number' || !Number.isFinite(r['updatedAt'])) {
    throw new HelmxError('workflow_record_corrupt', `workflow run ${key} header updatedAt invalid`, 500, { runId: key })
  }
  if (r['settledAt'] !== undefined && (typeof r['settledAt'] !== 'number' || !Number.isFinite(r['settledAt']) || r['settledAt'] < 0)) {
    throw new HelmxError('workflow_record_corrupt', `workflow run ${key} header settledAt invalid`, 500, { runId: key })
  }
  if (r['errorCode'] !== undefined && typeof r['errorCode'] !== 'string') {
    throw new HelmxError('workflow_record_corrupt', `workflow run ${key} header errorCode invalid`, 500, { runId: key })
  }
  if (r['kind'] === 'workflow' && (typeof r['journalPath'] !== 'string' || r['journalPath'] === '')) {
    throw new HelmxError('workflow_record_corrupt', `workflow run ${key} header journalPath invalid`, 500, { runId: key })
  }
  return value as RunHeader
}

export function childIdsOfHeader(header: RunHeader): number[] {
  const ids = new Set<number>()
  for (const id of header.childConversationIds ?? []) ids.add(id)
  if (header.kind === 'subagent' && header.execution?.conversationId !== undefined) {
    ids.add(header.execution.conversationId)
  }
  for (const node of header.nodes ?? []) {
    if (node.conversationId !== undefined) ids.add(node.conversationId)
  }
  return [...ids]
}

export interface RunRepositoryOptions {
  dataDir: string
  kv: AnyWorkflowKvStore
  redact: (text: string) => string
  /** Fires when a newly saved `replayedFrom` run takes over a prior run, carrying the updated prior summary. */
  onTakeoverUpdated?: (priorSummary: WorkflowRunSummary) => void
}

export class RunRepository {
  private readonly dataDir: string
  private readonly kv: AnyWorkflowKvStore
  private readonly redact: (text: string) => string
  private readonly onTakeoverUpdated?: (priorSummary: WorkflowRunSummary) => void

  private hydrated = false
  private readonly headers = new Map<string, RunHeader>()
  /** Derived single-source reverse index: `oldRunId -> newRunId` built exclusively from `header.replayedFrom`. */
  private readonly takenOverBy = new Map<string, string>()
  /** Bounded LRU cache for lazy-loaded RunDetail files. */
  private readonly detailLru = new Map<string, RunDetail>()

  constructor(options: RunRepositoryOptions) {
    this.dataDir = options.dataDir
    this.kv = options.kv
    this.redact = options.redact
    this.onTakeoverUpdated = options.onTakeoverUpdated
  }

  artifactsDir(conversationId: number): string {
    return join(this.dataDir, 'artifacts', String(conversationId))
  }

  journalPathFor(conversationId: number, runId: string): string {
    return join(this.artifactsDir(conversationId), `workflow-${runId}.jsonl`)
  }

  detailPathFor(conversationId: number, runId: string): string {
    return join(this.artifactsDir(conversationId), `wf-${runId}.detail.json`)
  }

  /** Clear cached header index so next access re-hydrates from KV (e.g. after a failed init flush). */
  invalidate(): void {
    this.hydrated = false
    this.headers.clear()
    this.takenOverBy.clear()
  }

  /** Hydrate all RunHeaders from `ctx.kv('runs')` via paginated listing (O(N) pure memory reads). */
  ensureHydrated(): void {
    if (this.hydrated) return
    this.headers.clear()
    this.takenOverBy.clear()
    let cursor: string | undefined
    for (;;) {
      let page: PluginKvListResult<unknown>
      try {
        page = this.kv.list({ limit: 1000, ...(cursor !== undefined ? { cursor } : {}) })
      } catch (error) {
        if (error instanceof HelmxError) throw error
        throw new HelmxError(
          'workflow_index_corrupt',
          `failed to list workflow runs from KV store: ${errorMessage(error)}`,
          500,
          { cause: errorMessage(error) },
        )
      }
      for (const item of page.items) {
        const header = validateHeader(item.key, item.value)
        this.headers.set(header.id, header)
        if (header.replayedFrom !== undefined) {
          this.takenOverBy.set(header.replayedFrom, header.id)
        }
      }
      if (page.nextCursor === undefined) break
      cursor = page.nextCursor
    }
    this.hydrated = true
  }

  listHeaders(): RunHeader[] {
    this.ensureHydrated()
    return [...this.headers.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  getHeader(runId: string): RunHeader {
    this.ensureHydrated()
    const header = this.headers.get(runId)
    if (header === undefined) {
      throw new HelmxError('not_found', `workflow run ${runId} does not exist`, 404, { runId })
    }
    return header
  }

  tryGetHeader(runId: string): RunHeader | undefined {
    this.ensureHydrated()
    return this.headers.get(runId)
  }

  getTakenOverBy(runId: string): string | undefined {
    this.ensureHydrated()
    return this.takenOverBy.get(runId)
  }

  /** O(N_mem) lookup by (conversationId, parentToolCallId) with zero disk I/O. */
  findByParentToolCall(conversationId: number, parentToolCallId: string): RunHeader | undefined {
    if (parentToolCallId === '') return undefined
    this.ensureHydrated()
    let match: RunHeader | undefined
    for (const header of this.headers.values()) {
      if (header.conversationId === conversationId && header.parentToolCallId === parentToolCallId) {
        if (match === undefined || header.createdAt > match.createdAt) match = header
      }
    }
    return match
  }

  /** Build a compact header snapshot safe for KV storage and persist atomically as one KV row. */
  saveHeader(header: RunHeader): void {
    this.ensureHydrated()
    const compactNodes =
      header.nodes !== undefined && header.nodes.length > 0
        ? header.nodes.slice(0, MAX_HEADER_NODES).map((n) => slimNodeForHeader(n, this.redact))
        : undefined
    const compactProgress = slimProgressForHeader(header.progress, this.redact)
    const compact: RunHeader = {
      ...header,
      ...(compactNodes !== undefined ? { nodes: compactNodes } : { nodes: undefined }),
      ...(compactProgress !== undefined ? { progress: compactProgress } : { progress: undefined }),
    }
    if (compact.nodes === undefined) delete compact.nodes
    if (compact.progress === undefined) delete compact.progress
    this.kv.set(compact.id, compact)
    this.headers.set(compact.id, compact)
    if (compact.replayedFrom !== undefined) {
      const had = this.takenOverBy.get(compact.replayedFrom)
      this.takenOverBy.set(compact.replayedFrom, compact.id)
      if (had !== compact.id) {
        const prior = this.headers.get(compact.replayedFrom)
        if (prior !== undefined) {
          this.onTakeoverUpdated?.(this.summaryOfHeader(prior))
        }
      }
    }
  }

  /** Atomically write heavy RunDetail to disk and cache in bounded LRU. */
  saveDetail(conversationId: number, detail: RunDetail): void {
    const dir = this.artifactsDir(conversationId)
    mkdirSync(dir, { recursive: true })
    const target = this.detailPathFor(conversationId, detail.id)
    const tmp = join(dir, `.detail-${detail.id}-${randomUUID()}.tmp`)
    const sanitized: RunDetail = {
      id: detail.id,
      ...(detail.result !== undefined ? { result: redactJsonValue(detail.result, this.redact) } : {}),
      ...(detail.script !== undefined ? { script: detail.script } : {}),
      ...(detail.args !== undefined ? { args: redactJsonValue(detail.args, this.redact) } : {}),
      ...(detail.nodes !== undefined ? { nodes: detail.nodes.map((n) => redactNodeForDetail(n, this.redact)) } : {}),
      ...(detail.progress !== undefined ? { progress: detail.progress } : {}),
      ...(detail.subagentSpec !== undefined ? { subagentSpec: detail.subagentSpec } : {}),
      ...(detail.subagentMeta !== undefined ? { subagentMeta: detail.subagentMeta } : {}),
    }
    try {
      const fd = openSync(tmp, 'wx', 0o644)
      try {
        writeSync(fd, JSON.stringify(sanitized), null, 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, target)
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch {
        // Already consumed or never created.
      }
      if (error instanceof HelmxError) throw error
      const err = error as NodeJS.ErrnoException
      throw new HelmxError('io_error', `failed to write workflow detail ${target}: ${err.message}`, 500, {
        path: target,
        code: err.code,
      })
    }
    this.cacheDetail(sanitized)
  }

  /** Lazy-read RunDetail (LRU cache first, then disk; missing file returns minimal `{ id }`). */
  loadDetail(header: RunHeader): RunDetail {
    const cached = this.detailLru.get(header.id)
    if (cached !== undefined) {
      this.detailLru.delete(header.id)
      this.detailLru.set(header.id, cached)
      return cached
    }
    const path = this.detailPathFor(header.conversationId, header.id)
    let raw: string
    try {
      raw = readFileSync(path, 'utf-8')
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') return { id: header.id }
      throw new HelmxError('workflow_record_corrupt', `failed to read workflow detail ${path}: ${err.message}`, 500, {
        runId: header.id,
        path,
      })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new HelmxError('workflow_record_corrupt', `workflow detail ${path} is invalid JSON: ${errorMessage(error)}`, 500, {
        runId: header.id,
        path,
      })
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as Record<string, unknown>)['id'] !== header.id) {
      throw new HelmxError('workflow_record_corrupt', `workflow detail ${path} has corrupted shape or id mismatch`, 500, {
        runId: header.id,
        path,
      })
    }
    const detail = parsed as RunDetail
    if (
      detail.subagentSpec !== undefined &&
      detail.subagentSpec.nodeId !== undefined &&
      !isValidNodeId(detail.subagentSpec.nodeId)
    ) {
      throw new HelmxError('workflow_record_corrupt', `workflow detail ${path} has invalid subagentSpec.nodeId`, 500, {
        runId: header.id,
        path,
      })
    }
    this.cacheDetail(detail)
    return detail
  }

  private cacheDetail(detail: RunDetail): void {
    this.detailLru.delete(detail.id)
    this.detailLru.set(detail.id, detail)
    if (this.detailLru.size > DETAIL_LRU_CAP) {
      const oldest = this.detailLru.keys().next().value
      if (oldest !== undefined) this.detailLru.delete(oldest)
    }
  }

  async flush(): Promise<void> {
    await this.kv.flush()
  }

  /** Zero-IO compact summary derived purely from RunHeader + reverse takeover index. */
  summaryOfHeader(header: RunHeader): WorkflowRunSummary {
    const resumedByRunId = this.takenOverBy.get(header.id)
    const resumable =
      header.status === 'failed'
        ? header.resumable === true && resumedByRunId === undefined
        : undefined
    return {
      id: header.id,
      name: header.name,
      conversationId: header.conversationId,
      kind: header.kind,
      ...(header.kind === 'workflow' && header.savedName !== undefined ? { savedName: header.savedName } : {}),
      ...(header.kind === 'workflow' && header.description !== undefined ? { description: header.description } : {}),
      ...(header.kind === 'workflow' && header.phases !== undefined ? { phases: header.phases } : {}),
      ...(header.parentToolCallId !== undefined ? { parentToolCallId: header.parentToolCallId } : {}),
      status: header.status,
      createdAt: header.createdAt,
      updatedAt: header.updatedAt,
      ...(header.settledAt !== undefined ? { settledAt: header.settledAt } : {}),
      ...(header.error !== undefined ? { error: header.error } : {}),
      ...(header.errorCode !== undefined ? { errorCode: header.errorCode } : {}),
      ...(resumable !== undefined ? { resumable } : {}),
      ...(header.hasResult !== undefined ? { hasResult: header.hasResult } : {}),
      ...(header.resultPreview !== undefined ? { resultPreview: header.resultPreview } : {}),
      ...(header.nodes !== undefined ? { nodes: header.nodes } : {}),
      ...(header.progress !== undefined && header.progress.length > 0 ? { progress: header.progress } : {}),
      ...(header.replayedFrom !== undefined ? { replayedFrom: header.replayedFrom } : {}),
      ...(resumedByRunId !== undefined ? { resumedByRunId } : {}),
      ...(header.journalIoErrors !== undefined && header.journalIoErrors.length > 0
        ? { journalIoErrors: header.journalIoErrors }
        : {}),
    }
  }

  /** Full inspect summary combining RunHeader with lazy-loaded RunDetail (full result, nodes, timeline). */
  fullSummaryOf(header: RunHeader, detailOverride?: RunDetail): WorkflowRunSummary {
    const base = this.summaryOfHeader(header)
    const detail = detailOverride ?? this.loadDetail(header)
    return {
      ...base,
      ...(detail.result !== undefined ? { result: detail.result } : {}),
      ...(detail.nodes !== undefined && detail.nodes.length > 0 ? { nodes: detail.nodes } : {}),
      ...(detail.progress !== undefined && detail.progress.length > 0 ? { progress: detail.progress } : {}),
    }
  }
}
