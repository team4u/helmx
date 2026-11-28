/**
 * Shell execution engine (`runShell` / `runGate` / `bash` tool).
 *
 * - Delegates shell execution to SDK `NodeExecutionEnv.exec` (`@earendil-works/pi-durable/env/node`):
 *   never spawns on pre-aborted `Context`; kills entire process groups on abort/timeout and reliably awaits
 *   process exit (cleans up all listeners/timers, zero orphan leaks); incremental per-stream UTF-8 decoding
 *   via `StreamDecoder` so multi-byte characters split across chunks stay intact; aggregates `onOutput` in
 *   arrival order (never stdout-before-stderr).
 * - Cross-node execution (`EnvFabric`): runs on `(nodeId, cwd, conversationId)`; `nodeId !== 'local'` goes
 *   through `deps.envFabric` (offline throws `node_offline`, disconnect returns `unknown`; local falls back to
 *   short-lived direct env creation only when EnvFabric isn't injected, whereas remote explicitly fails
 *   `env_fabric_missing` via `guards.ts` — never reading/writing Hub's local disk).
 * - Target-platform-aware cwd/path normalization (sole implementation `runtime/target-platform.ts`, reusing
 *   `@helmx/protocol` `normalizeTargetPath`/`targetPlatformOf` without duplicating rules in entry points):
 *   SDK `NodeExecutionEnv`/remote exec receive pre-normalized paths (converges `bash` / `runGate` /
 *   `POST /api/env/exec` and `WorktreeAllocator.execGit` via `runShell`).
 * - Fallback redaction for inherited host `HELMX_TOKEN`: `runShell` can be invoked without the caller
 *   registering it in `deps.redact`, so any host token is captured and explicitly redacted across returned text.
 * - Fails explicitly with `output_limit_exceeded` when output exceeds `maxOutputBytes` (never silently truncates).
 */
import { StringDecoder } from 'node:string_decoder'
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { int, obj, opt, str } from '@earendil-works/pi-schema'
import { createLocalExecutionEnv } from '../../env/local-host-env.js'
import { redactJsonValue } from '../../redact.js'
import { MAX_ARTIFACT_BYTES } from '../../services/artifacts.js'
import { SecretStash } from '../../services/secret-stash.js'
import { invalidPathText, normalizePathForTarget, targetPlatformForNode } from '../target-platform.js'
import { throwIfToolAborted, type HelmxToolDeps } from '../tool-deps.js'
import { remoteShellGuardText, shellEnvFabricMissingText } from './guards.js'
import { buildToolEnv } from './managed-env.js'

const DEFAULT_TIMEOUT_MS = 120_000
/** Maximum `timeoutMs`: bounded proportionally to default to prevent unbounded waits. */
export const MAX_TIMEOUT_MS = 600_000
/** `runShell` output aggregation cap (UTF-8 bytes): exceeding fails explicitly rather than truncating silently. */
export const MAX_OUTPUT_BYTES = 1024 * 1024
/** Streaming mode (`onOutputChunk`) aggregation budget: per-chunk streaming reaches the client directly, while Hub
 * keeps only terminal diagnostics; overflows fail explicitly with `output_limit_exceeded` (avoiding 64 MiB duplication leaks). */
export const STREAM_AGGREGATE_LIMIT_BYTES = 256 * 1024
/** Model-facing `bash` tool tail budget (matches `pi-durable` defaults; excess spills to an artifact). */
export const BASH_TAIL_MAX_LINES = 2_000
export const BASH_TAIL_MAX_BYTES = 50 * 1024
const BASH_SPILL_READ_CHUNK_BYTES = 256 * 1024
const TAIL_COALESCE_CHARS = 8 * 1024

export interface ShellRunResult {
  ok: boolean
  exitCode: number | null
  output: string
  timedOut: boolean
  signal: string | null
  /** Actual execution node (resolved from explicit arg/conversation binding; echoed in bash structured output, outside protocol response). */
  nodeId?: string
  /** Actual starting working directory (post-`normalizePathForTarget`, with win32 paths converted). */
  cwd?: string
}

/** Validate `timeoutMs`: positive finite integer <= cap; fails loudly without silent coercion. */
function assertTimeoutMs(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(
      `invalid_timeout: timeoutMs must be an integer in (0, ${MAX_TIMEOUT_MS}], received ${timeoutMs}`,
    )
  }
}

/** Attach an external `AbortSignal` to SDK `Context` (pre-aborted contexts refuse spawning immediately). */
function contextWithSignal(signal: AbortSignal | undefined): Context {
  return signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT)
}

interface ResolvedShellTarget {
  nodeId: string
  cwd: string
  shell: ExecutionEnv
  shellEnv: Record<string, string> | undefined
  shellInheritEnv: boolean | undefined
  ephemeralEnv: ExecutionEnv | undefined
}

function buildRedactAll(deps: HelmxToolDeps): (text: string) => string {
  // Fallback redaction for inherited host `HELMX_TOKEN`: callers (e.g. direct unit tests) might not register it in
  // `deps.redact`, so capture and redact any non-empty host token across all shell outputs and artifacts.
  const hostToken = process.env['HELMX_TOKEN']
  return (text: string): string => {
    const base = deps.redact(text)
    return hostToken !== undefined && hostToken !== '' ? base.split(hostToken).join('[REDACTED]') : base
  }
}

function createCombinedStreamingRedactor(
  deps: HelmxToolDeps,
  redactAll: (text: string) => string,
): { push(chunk: string): string; flush(): string } {
  const hostToken = process.env['HELMX_TOKEN']
  let hostStream: { push(text: string): string; flush(): string } | undefined
  if (hostToken !== undefined && hostToken !== '') {
    const stash = new SecretStash()
    stash.addRedaction(hostToken)
    hostStream = stash.createStreamingRedactor()
  }
  const primary = deps.createStreamingRedactor?.()
  return {
    push(chunk: string): string {
      if (chunk === '') return ''
      const step1 = primary !== undefined ? primary.push(chunk) : redactAll(chunk)
      return hostStream !== undefined ? hostStream.push(step1) : step1
    },
    flush(): string {
      const step1 = primary !== undefined ? primary.flush() : ''
      const step2 = hostStream !== undefined ? hostStream.push(step1) + hostStream.flush() : step1
      return redactAll(step2)
    },
  }
}

function prepareShellTarget(
  deps: HelmxToolDeps,
  options: {
    requestedCwd: string
    nodeId: string
    conversationId?: number
    env?: Record<string, string>
    apiEnv?: ExecutionEnv
    redactAll: (text: string) => string
  },
):
  | { ok: true; target: ResolvedShellTarget }
  | { ok: false; kind: 'invalid_path' | 'remote_guard'; message: string; nodeId: string; cwd?: string } {
  const { nodeId, requestedCwd, conversationId, apiEnv, redactAll } = options
  const platformInfo = targetPlatformForNode(deps.envFabric, nodeId)
  const cwdNorm = normalizePathForTarget(requestedCwd, platformInfo)
  if (!cwdNorm.ok) {
    return {
      ok: false,
      kind: 'invalid_path',
      message: redactAll(invalidPathText(cwdNorm)),
      nodeId,
    }
  }
  const cwd = cwdNorm.path
  if (nodeId !== 'local') {
    const guardOutput = remoteShellGuardText(deps.envFabric, nodeId)
    if (guardOutput !== undefined) {
      return { ok: false, kind: 'remote_guard', message: guardOutput, nodeId, cwd }
    }
  }

  let shell: ExecutionEnv
  let shellEnv: Record<string, string> | undefined = options.env
  let shellInheritEnv: boolean | undefined
  let ephemeralEnv: ExecutionEnv | undefined

  if (apiEnv !== undefined && apiEnv.cwd === cwd) {
    shell = apiEnv
  } else if (deps.envFabric !== undefined) {
    shell = deps.envFabric.envForTarget({
      nodeId,
      cwd,
      ...(conversationId === undefined ? {} : { conversationId }),
    })
  } else if (nodeId === 'local') {
    ephemeralEnv = createLocalExecutionEnv({ cwd })
    shell = ephemeralEnv
    shellEnv = buildToolEnv(deps, cwd, conversationId, options.env, nodeId)
    shellInheritEnv = false
  } else {
    return {
      ok: false,
      kind: 'remote_guard',
      message: shellEnvFabricMissingText(nodeId),
      nodeId,
      cwd,
    }
  }

  return {
    ok: true,
    target: { nodeId, cwd, shell, shellEnv, shellInheritEnv, ephemeralEnv },
  }
}

function countNewlines(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1
  }
  return count
}

function countTextLines(text: string): number {
  if (text.length === 0) return 0
  const newlines = countNewlines(text)
  return text.charCodeAt(text.length - 1) === 10 ? newlines : newlines + 1
}

function sliceLastLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  if (text.length === 0 || maxLines <= 0) {
    return text.length === 0 ? { text: '', truncated: false } : { text: '', truncated: true }
  }
  const endLimit = text.charCodeAt(text.length - 1) === 10 ? text.length - 1 : text.length
  let seen = 0
  for (let i = endLimit - 1; i >= 0; i -= 1) {
    if (text.charCodeAt(i) === 10) {
      seen += 1
      if (seen === maxLines) {
        return { text: text.slice(i + 1), truncated: true }
      }
    }
  }
  return { text, truncated: false }
}

function tailUtf8Safe(text: string, maxBytes: number): { text: string; sliced: boolean } {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= maxBytes) return { text, sliced: false }
  let start = buf.byteLength - maxBytes
  while (start < buf.byteLength && (buf[start]! & 0xc0) === 0x80) {
    start += 1
  }
  return { text: buf.subarray(start).toString('utf8'), sliced: true }
}

interface TailChunk {
  text: string
  bytes: number
  newlines: number
}

/**
 * Amortized O(N) rolling tail buffer retaining at most `maxLines` / `maxBytes` of UTF-8 output.
 * Coalesces small chunks before pushing to a head-indexed queue so `dd bs=1` byte floods stay sub-millisecond.
 */
class RollingTailBuffer {
  private readonly chunks: TailChunk[] = []
  private head = 0
  private pending = ''
  private queueBytes = 0
  private queueNewlines = 0
  private totalBytes = 0
  private totalNewlines = 0
  private hasAnyOutput = false
  private lastCharCode = 0
  private droppedBy: 'lines' | 'bytes' | undefined

  constructor(
    private readonly maxLines: number,
    private readonly maxBytes: number,
  ) {}

  push(text: string): void {
    if (text.length === 0) return
    this.hasAnyOutput = true
    this.lastCharCode = text.charCodeAt(text.length - 1)
    this.totalBytes += Buffer.byteLength(text, 'utf8')
    this.totalNewlines += countNewlines(text)
    this.pending += text
    if (this.pending.length >= TAIL_COALESCE_CHARS) {
      this.flushPendingChunk()
    }
  }

  private flushPendingChunk(): void {
    if (this.pending.length === 0) return
    let text = this.pending
    this.pending = ''
    let bytes = Buffer.byteLength(text, 'utf8')
    // Guard against a multi-megabyte single chunk with no newlines holding memory between flushes.
    if (bytes > this.maxBytes * 2) {
      this.chunks.length = 0
      this.head = 0
      this.queueBytes = 0
      this.queueNewlines = 0
      text = tailUtf8Safe(text, this.maxBytes).text
      bytes = Buffer.byteLength(text, 'utf8')
      this.droppedBy ??= 'bytes'
    }
    this.chunks.push({ text, bytes, newlines: countNewlines(text) })
    this.queueBytes += bytes
    this.queueNewlines += this.chunks[this.chunks.length - 1]!.newlines
    this.trimQueue()
  }

  private trimQueue(): void {
    while (this.chunks.length - this.head > 1) {
      const oldest = this.chunks[this.head]!
      const excessBytes = this.queueBytes - oldest.bytes >= this.maxBytes
      const excessLines = this.queueNewlines - oldest.newlines >= this.maxLines
      if (!excessBytes && !excessLines) break
      this.head += 1
      this.queueBytes -= oldest.bytes
      this.queueNewlines -= oldest.newlines
      this.droppedBy ??= excessBytes ? 'bytes' : 'lines'
    }
    if (this.head > 64) {
      this.chunks.splice(0, this.head)
      this.head = 0
    }
  }

  finish(redactAll: (text: string) => string): {
    text: string
    truncated: boolean
    truncatedBy: 'lines' | 'bytes' | undefined
    totalLines: number
    totalBytes: number
    retainedLines: number
    retainedBytes: number
  } {
    this.flushPendingChunk()
    const rawCombined = this.chunks.slice(this.head).map((c) => c.text).join('')
    const safeCombined = redactAll(rawCombined)
    const lineTrim = sliceLastLines(safeCombined, this.maxLines)
    const byteTrim = tailUtf8Safe(lineTrim.text, this.maxBytes)

    let truncatedBy = this.droppedBy
    if (byteTrim.sliced) truncatedBy ??= 'bytes'
    else if (lineTrim.truncated) truncatedBy ??= 'lines'

    const totalLines = !this.hasAnyOutput
      ? 0
      : this.lastCharCode === 10
        ? this.totalNewlines
        : this.totalNewlines + 1

    return {
      text: byteTrim.text,
      truncated: truncatedBy !== undefined,
      truncatedBy,
      totalLines,
      totalBytes: this.totalBytes,
      retainedLines: countTextLines(byteTrim.text),
      retainedBytes: Buffer.byteLength(byteTrim.text, 'utf8'),
    }
  }
}

async function readSpillFileBounded(
  shell: ExecutionEnv,
  spillPath: string,
): Promise<{ ok: true; text: string; capped: boolean; totalBytes: number } | { ok: false; error: string }> {
  const openR = await shell.openBinaryReader(spillPath, undefined, BACKGROUND_CONTEXT)
  if (!openR.ok) {
    return { ok: false, error: openR.error.message }
  }
  const reader = openR.value
  try {
    const infoR = await reader.info(BACKGROUND_CONTEXT)
    if (!infoR.ok) {
      return { ok: false, error: infoR.error.message }
    }
    const totalBytes = infoR.value.size
    const targetBytes = Math.min(totalBytes, MAX_ARTIFACT_BYTES)
    const capped = totalBytes > MAX_ARTIFACT_BYTES
    const decoder = new StringDecoder('utf8')
    let text = ''
    let offset = 0
    while (offset < targetBytes) {
      const length = Math.min(BASH_SPILL_READ_CHUNK_BYTES, targetBytes - offset)
      const chunkR = await reader.read(offset, length, BACKGROUND_CONTEXT)
      if (!chunkR.ok) {
        return { ok: false, error: chunkR.error.message }
      }
      if (chunkR.value.byteLength === 0) break
      const view = Buffer.from(chunkR.value.buffer, chunkR.value.byteOffset, chunkR.value.byteLength)
      text += decoder.write(view)
      offset += chunkR.value.byteLength
    }
    if (!capped) {
      text += decoder.end()
    }
    return { ok: true, text, capped, totalBytes }
  } finally {
    await reader.close(BACKGROUND_CONTEXT).catch(() => undefined)
  }
}

async function persistShellSpillToArtifact(
  shell: ExecutionEnv,
  deps: HelmxToolDeps,
  conversationId: number,
  callId: string,
  spillPath: string,
  redactAll: (text: string) => string,
): Promise<string> {
  const readR = await readSpillFileBounded(shell, spillPath)
  if (!readR.ok) {
    return `\n[Note: failed to collect spilled command output (${redactAll(readR.error)})]`
  }
  const redactedFull = redactAll(readR.text)
  const capNote = readR.capped
    ? `\n[Note: full command output (${readR.totalBytes} bytes) exceeded the 15 MiB artifact cap; saved artifact contains the first 15 MiB]`
    : ''
  if (deps.artifacts.writeSpillArtifact !== undefined) {
    const meta = await deps.artifacts.writeSpillArtifact(conversationId, callId, redactedFull)
    return `${capNote}\n[Artifact] id=${meta.id} path=${meta.path} (call tool read_artifact to get full text)`
  }
  const spill = await deps.artifacts.spill(conversationId, callId, redactedFull)
  if (spill.artifact !== undefined) {
    return `${capNote}\n[Artifact] id=${spill.artifact.id} path=${spill.artifact.path} (call tool read_artifact to get full text)`
  }
  return capNote
}

/**
 * Real shell execution (shared by `runGate` and `/api/env/exec`). Delegates to SDK `NodeExecutionEnv`:
 * process-group spawning, timeout/abort group termination, per-stream incremental UTF-8 decoding, arrival-order
 * aggregation. Never fabricates success; exceeds limits -> `output_limit_exceeded`.
 */
export async function runShell(
  deps: HelmxToolDeps,
  command: string,
  options: {
    cwd?: string
    conversationId?: number
    /** Target compute node (falls back to conversation binding, then `'local'`). */
    nodeId?: string
    timeoutMs?: number
    signal?: AbortSignal
    maxOutputBytes?: number
    /**
     * Per-chunk streaming callback (`stdout`/`stderr` in arrival order; aggregation budget still applies):
     * used by `POST /api/env/exec` NDJSON streaming without altering aggregate redaction semantics.
     */
    onOutputChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void
    /**
     * Caller-injected environment (e.g. Herdr plugin `Profile.runtime.env` + managed env): overrides matching
     * keys from `process.env`, while managed variables (`HELMX_*` and managed tokens) remain pinned.
     */
    env?: Record<string, string>
  } = {},
): Promise<ShellRunResult> {
  const requestedCwd = options.cwd ?? deps.defaultCwd
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  assertTimeoutMs(timeoutMs)
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES
  // Node resolution: explicit `nodeId` > conversation binding (`nodeIdOf`) > `'local'`.
  const explicitNodeId = options.nodeId ?? (options.conversationId !== undefined ? deps.nodeIdOf?.(options.conversationId) : undefined)
  const nodeId = explicitNodeId ?? 'local'
  const redactAll = buildRedactAll(deps)
  const prepared = prepareShellTarget(deps, {
    requestedCwd,
    nodeId,
    ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
    ...(options.env === undefined ? {} : { env: options.env }),
    redactAll,
  })
  if (!prepared.ok) {
    return {
      ok: false,
      exitCode: null,
      output: prepared.message,
      timedOut: false,
      signal: null,
      ...(prepared.kind === 'remote_guard' ? { nodeId: prepared.nodeId, cwd: prepared.cwd } : {}),
    }
  }
  const { cwd, shell, shellEnv, shellInheritEnv, ephemeralEnv } = prepared.target
  // Echo execution facts (`nodeId` + normalized starting `cwd`) into shell output; internal only,
  // excluded from the HTTP `EnvExecResponse` protocol payload.
  const withTarget = (r: ShellRunResult): ShellRunResult => ({ ...r, nodeId, cwd })
  // Arrival-order aggregation (stdout/stderr interleaved by arrival order, never stdout-then-stderr).
  // Redact across complete concatenated output so secrets split across chunks still match completely.
  // Streaming mode (`onOutputChunk`) uses a smaller aggregation budget and fails explicitly with `output_limit_exceeded`
  // on overflow (streaming clients already received all chunks; terminal output is purely diagnostic).
  const aggregateLimit = options.onOutputChunk !== undefined ? STREAM_AGGREGATE_LIMIT_BYTES : maxOutputBytes
  let combined = ''
  let outputBytes = 0
  let exceeded = false
  try {
    const result = await shell.exec(
      command,
      {
        cwd,
        ...(shellEnv === undefined ? {} : { env: shellEnv }),
        ...(shellInheritEnv === undefined ? {} : { inheritEnv: shellInheritEnv }),
        timeout: timeoutMs / 1000,
        onOutput: (text, _ctx, info) => {
          // Streaming chunk delivery runs unaffected by hub-side terminal diagnostic aggregation overflow.
          if (options.onOutputChunk !== undefined) {
            try {
              options.onOutputChunk({ stream: info.stream, text })
            } catch {
              // Streaming callback errors do not halt aggregation.
            }
          }
          if (exceeded) return
          outputBytes += Buffer.byteLength(text, 'utf8')
          if (outputBytes > aggregateLimit) {
            exceeded = true
            combined = ''
            return
          }
          combined += text
        },
      },
      contextWithSignal(options.signal),
    )
    if (!result.ok && result.error.code === 'unknown') {
      // Remote disconnect: command already started and outcome is unknown (`error.code === 'unknown'`); never retry.
      return withTarget({
        ok: false,
        exitCode: null,
        output: redactAll(combined + (combined === '' ? '' : '\n') + `[shell unknown: ${result.error.message}]`),
        timedOut: false,
        signal: null,
      })
    }
    if (exceeded) {
      const limit = options.onOutputChunk !== undefined ? aggregateLimit : maxOutputBytes
      const streamNote =
        options.onOutputChunk !== undefined
          ? ' (streaming mode: all chunks were already pushed; only terminal diagnostic aggregation exceeded the cap)'
          : ''
      return withTarget({
        ok: false,
        exitCode: null,
        output: redactAll(
          `output_limit_exceeded: output exceeded ${limit}-byte aggregation cap and aggregation was aborted.${streamNote} ` +
            'Redirect output to a file and read it paginated with read_artifact/read, or narrow the command output.',
        ),
        timedOut: false,
        signal: null,
      })
    }
    if (!result.ok) {
      const error = result.error
      const timedOut = error.code === 'timeout'
      const aborted = error.code === 'aborted'
      const label = aborted ? 'aborted' : timedOut ? `timeout after ${timeoutMs}ms` : error.code
      return withTarget({
        ok: false,
        exitCode: null,
        output: redactAll(
          combined + (combined === '' ? '' : '\n') + `[shell ${label}: ${error.message}]`,
        ),
        timedOut,
        signal: null,
      })
    }
    return withTarget({
      ok: result.value.exitCode === 0,
      exitCode: result.value.exitCode,
      output: redactAll(combined),
      timedOut: false,
      signal: null,
    })
  } finally {
    if (ephemeralEnv !== undefined) {
      await ephemeralEnv.cleanup(BACKGROUND_CONTEXT).catch(() => undefined)
    }
  }
}

/**
 * Gate verification command runner (shared by standalone subagents and Workflow adapters; guaranteed single execution).
 * `env` keeps local Gate consistent with real Herdr task environments (plugins pass `Profile.runtime.env` +
 * managed env via `spawnEnv`, sharing the same CI/tool PATH); managed variables stay pinned.
 * Optional `timeoutMs` (default `120_000`) bounds each gate run; `runShell` kills the entire process group
 * (`SIGTERM` -> `SIGKILL`) on timeout and surfaces `{ timedOut: true, exitCode: null }`.
 * Failures never report success; outputs are redacted.
 */
export async function runGate(
  deps: HelmxToolDeps,
  command: string,
  options: {
    cwd?: string
    conversationId?: number
    nodeId?: string
    /** Per-run gate timeout in ms (default `120_000`; integer in `(0, 600_000]` validated by `runShell`). */
    timeoutMs?: number
    signal?: AbortSignal
    env?: Record<string, string>
  } = {},
): Promise<{ ok: boolean; output: string; exitCode: number | null; timedOut: boolean }> {
  const result = await runShell(deps, command, {
    ...options,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })
  return { ok: result.ok, output: result.output, exitCode: result.exitCode, timedOut: result.timedOut }
}

const bashParameters = obj({
  command: str({ description: 'Shell command to execute' }),
  timeoutMs: opt(
    int({
      minimum: 1,
      maximum: MAX_TIMEOUT_MS,
      description: `Optional timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`,
    }),
  ),
})

/** `bash` tool (SDK `defineTool`; streams redacted chunks live, keeps 2,000-line / 50 KiB tail, spills excess to artifact). */
export function createBashTool(deps: HelmxToolDeps): ToolRegistration<typeof bashParameters> {
  return defineTool({
    name: 'bash',
    description:
      "Execute a shell command on the conversation's bound node (local runs on Hub; remote runs on the target node). " +
      'Working directory is the conversation cwd; default timeout 120s (max 600s); streams output live and retains ' +
      'the trailing 2000 lines / 50 KiB cleanly, automatically spilling oversized full output to a conversation artifact (use read_artifact to paginate).',
    parameters: bashParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        exitCode: { type: ['number', 'null'] },
        output: { type: 'string' },
        timedOut: { type: 'boolean' },
        nodeId: { type: 'string', description: 'Actual execution node (resolved from conversation binding)' },
        cwd: { type: 'string', description: 'Actual starting working directory (normalized per target platform; not raw input)' },
      },
      required: ['ok', 'output'],
    },
    async execute(args, api, context) {
      const execCtx: Context = context ?? BACKGROUND_CONTEXT
      const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const redactAll = buildRedactAll(deps)
      try {
        assertTimeoutMs(timeoutMs)
      } catch (error) {
        // Argument errors such as `invalid_timeout` fail explicitly without silent defaulting (rethrows if already aborted).
        throwIfToolAborted(execCtx.abortSignal)
        return {
          output: [{ type: 'text', text: redactAll(String(error)) }],
          isError: true,
        }
      }

      const agent = await api.agent(execCtx)
      const requestedCwd = agent.cwd ?? deps.defaultCwd
      const conversationId = api.conversationId as number
      const nodeId = deps.nodeIdOf?.(conversationId) ?? 'local'
      const prepared = prepareShellTarget(deps, {
        requestedCwd,
        nodeId,
        conversationId,
        ...(api.env === undefined ? {} : { apiEnv: api.env }),
        redactAll,
      })

      if (!prepared.ok) {
        const structured = redactJsonValue(
          {
            ok: false,
            exitCode: null,
            output: prepared.message,
            timedOut: false,
            nodeId: prepared.nodeId,
            ...(prepared.cwd !== undefined ? { cwd: prepared.cwd } : {}),
          },
          redactAll,
        )
        const { output: _uiDropped, ...uiFacts } = structured as Record<string, JsonValue>
        return {
          output: [{ type: 'text', text: prepared.message }],
          isError: true,
          structuredOutput: structured as JsonValue,
          details: uiFacts as JsonValue,
        }
      }

      const { cwd, shell, shellEnv, shellInheritEnv, ephemeralEnv } = prepared.target
      const redactor = createCombinedStreamingRedactor(deps, redactAll)
      const tail = new RollingTailBuffer(BASH_TAIL_MAX_LINES, BASH_TAIL_MAX_BYTES)
      const pushLive = (safeDelta: string): void => {
        if (safeDelta === '' || typeof api.output !== 'function') return
        try {
          api.output(safeDelta)
        } catch {
          // Ignore late output after tool call settlement.
        }
      }

      let spillPath: string | undefined
      try {
        const execResult = await shell.exec(
          args.command,
          {
            cwd,
            ...(shellEnv === undefined ? {} : { env: shellEnv }),
            ...(shellInheritEnv === undefined ? {} : { inheritEnv: shellInheritEnv }),
            timeout: timeoutMs / 1000,
            spill: { afterBytes: BASH_TAIL_MAX_BYTES, afterLines: BASH_TAIL_MAX_LINES },
            onOutput: (text) => {
              const safeDelta = redactor.push(text)
              if (safeDelta !== '') {
                tail.push(safeDelta)
                pushLive(safeDelta)
              }
            },
          },
          contextWithSignal(execCtx.abortSignal),
        )
        const flushed = redactor.flush()
        if (flushed !== '') {
          tail.push(flushed)
          pushLive(flushed)
        }
        spillPath = execResult.ok ? execResult.value.spillPath : execResult.error.spillPath
        // Do not write meaningless spill artifact files during shutdown/cancellation windows.
        throwIfToolAborted(execCtx.abortSignal)

        const tailResult = tail.finish(redactAll)
        let bodyText = tailResult.text
        if (!execResult.ok) {
          const error = execResult.error
          const statusLine =
            error.code === 'unknown'
              ? `[shell unknown: ${error.message}]`
              : error.code === 'timeout'
                ? `[shell timeout after ${timeoutMs}ms: ${error.message}]`
                : `[shell ${error.code}: ${error.message}]`
          bodyText = bodyText === '' ? redactAll(statusLine) : `${bodyText}\n${redactAll(statusLine)}`
        }

        let artifactNote = ''
        if (spillPath !== undefined) {
          artifactNote = await persistShellSpillToArtifact(
            shell,
            deps,
            conversationId,
            api.callId,
            spillPath,
            redactAll,
          )
        }
        const truncationNote = tailResult.truncated
          ? `\n\n[Output truncated (${tailResult.truncatedBy ?? 'limit'}): showing trailing ${tailResult.retainedLines} lines / ${tailResult.retainedBytes} bytes of ${tailResult.totalLines} lines / ${tailResult.totalBytes} total bytes]`
          : ''
        const fallbackNote = tailResult.truncated && spillPath === undefined
          ? '\n[Note: environment did not provide a spill file for omitted prefix]'
          : ''
        const extraNote = artifactNote !== '' ? artifactNote : fallbackNote
        const finalText = redactAll(`${bodyText}${truncationNote}${extraNote}`)

        const ok = execResult.ok && execResult.value.exitCode === 0
        const exitCode = execResult.ok ? execResult.value.exitCode : null
        const timedOut = !execResult.ok && execResult.error.code === 'timeout'

        // Structured echo of real execution facts (`nodeId` + normalized starting `cwd`); details are persisted
        // to the UI channel without duplicating `output`.
        const structured = redactJsonValue(
          {
            ok,
            exitCode,
            output: finalText,
            timedOut,
            nodeId,
            cwd,
          },
          redactAll,
        )
        const { output: _uiDropped, ...uiFacts } = structured as Record<string, JsonValue>
        return {
          output: [{ type: 'text', text: finalText }],
          isError: !ok,
          structuredOutput: structured as JsonValue,
          details: uiFacts as JsonValue,
        }
      } finally {
        if (spillPath !== undefined) {
          await shell.remove(spillPath, undefined, BACKGROUND_CONTEXT).catch(() => undefined)
        }
        if (ephemeralEnv !== undefined) {
          await ephemeralEnv.cleanup(BACKGROUND_CONTEXT).catch(() => undefined)
        }
      }
    },
  })
}
