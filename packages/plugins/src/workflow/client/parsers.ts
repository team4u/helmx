/**
 * Pure boundary parsers and text formatting helpers for builtin:workflow UI
 * (zero React/DOM dependencies; strict validation at every external boundary).
 */
import { DEFAULT_HELMX_LOCALE, type HelmxLocale } from '@helmx/ui'
import type { ConversationEntry, ConversationSummary, ToolViewProps } from '@helmx/protocol/browser'
import {
  buildWorkflowEditRequestLines,
  libArgsInvalidJson,
} from './copy.js'

// ---------------------------------------------------------------------------
// Text & formatting primitives
// ---------------------------------------------------------------------------

export function asPlainRecord(source: unknown): Record<string, unknown> | undefined {
  return source !== null && typeof source === 'object' && !Array.isArray(source)
    ? (source as Record<string, unknown>)
    : undefined
}

export function inspectString(record: Record<string, unknown>, key: string): string | undefined {
  const val = record[key]
  if (typeof val !== 'string') return undefined
  const trimmed = val.trim()
  return trimmed !== '' ? trimmed : undefined
}

export function inputString(input: unknown, key: string): string | undefined {
  const rec = asPlainRecord(input)
  return rec !== undefined ? inspectString(rec, key) : undefined
}

export function firstLineOf(text: string, maxChars = 120): string {
  const line = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (line.length <= maxChars) return line
  return `${line.slice(0, Math.max(1, maxChars - 1))}…`
}

export function stripStructuredOutputContract(text: string): string {
  return text.replace(/<structured_output_contract>[\s\S]*?<\/structured_output_contract>/gi, '').trim()
}

export function cleanInlineMarkdown(text: string): string {
  return text
    .replace(/^\s*(?:#{1,6}|[-*+>]|\d+\.)\s+/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractCleanPreviewLine(text: string, maxChars = 100): string {
  const lines = stripStructuredOutputContract(text).split(/\r?\n/)
  for (const raw of lines) {
    const cleaned = cleanInlineMarkdown(raw)
    if (cleaned === '' || /^[-=_*#]{2,}$/.test(cleaned)) continue
    return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, Math.max(1, maxChars - 1))}…`
  }
  return ''
}

export function stringifyPretty(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function formatShortModelName(model: string | undefined): string | undefined {
  if (model === undefined) return undefined
  const trimmed = model.trim()
  if (trimmed === '') return undefined
  const slash = trimmed.lastIndexOf('/')
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed
}

export function isPlaceholderRunName(name: string | undefined, runId?: string): boolean {
  if (name === undefined) return true
  const t = name.trim()
  if (t === '') return true
  if (runId !== undefined && t === runId) return true
  return /^wf_[0-9a-zA-Z_-]+$/.test(t) || /^subagent(?::[^\s]+)?$/i.test(t)
}

export function isPlaceholderNodeLabel(label: string | undefined): boolean {
  if (label === undefined) return true
  const t = label.trim()
  if (t === '') return true
  return /^(?:agent|action|subagent)(?:-\d+|:[^\s]+)?$/i.test(t) || /^wf_[0-9a-zA-Z_-]+$/.test(t)
}

export function isPlaceholderSubagentTitle(title: string | undefined, conversationId: number): boolean {
  if (title === undefined) return true
  const t = title.trim()
  if (t === '') return true
  const escaped = String(conversationId)
  return new RegExp(`^(?:subagent|子代理|子会话)\\s*#?${escaped}$`, 'i').test(t) || t === 'Subagent' || t === '子代理'
}

export function summarizeJsonPreview(value: unknown, maxChars = 120): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return extractCleanPreviewLine(value, maxChars)
  try {
    const serialized = JSON.stringify(value) ?? String(value)
    return serialized.length <= maxChars ? serialized : `${serialized.slice(0, Math.max(1, maxChars - 1))}…`
  } catch {
    return firstLineOf(String(value), maxChars)
  }
}

// ---------------------------------------------------------------------------
// Subagent tool presentationMeta parser
// ---------------------------------------------------------------------------

export interface SubagentExecutionInfo {
  nodeId?: string
  conversationId?: number
  executionId?: string
  effectiveCwd?: string
  worktree?: { path: string; branch: string; id?: string; baseCommit?: string }
  runId?: string
  background?: boolean
  status?: string
}

export function readToolPresentationMeta(props: Pick<ToolViewProps, 'presentationMeta'>): Readonly<Record<string, unknown>> | undefined {
  return asPlainRecord(props.presentationMeta)
}

export function parseSubagentExecutionInfo(presentationMeta: unknown): SubagentExecutionInfo | undefined {
  const envelope = asPlainRecord(presentationMeta)
  if (envelope === undefined) return undefined
  if (envelope['execution'] === undefined && envelope['runId'] === undefined) return undefined
  const info: SubagentExecutionInfo = {}
  const exec = asPlainRecord(envelope['execution'])
  if (exec !== undefined) {
    const nodeId = inspectString(exec, 'nodeId')
    if (nodeId !== undefined) info.nodeId = nodeId
    const convId = exec['conversationId']
    if (typeof convId === 'number' && Number.isSafeInteger(convId) && convId > 0) info.conversationId = convId
    const executionId = inspectString(exec, 'executionId')
    if (executionId !== undefined) info.executionId = executionId
    const effectiveCwd = inspectString(exec, 'effectiveCwd')
    if (effectiveCwd !== undefined) info.effectiveCwd = effectiveCwd
    const wt = asPlainRecord(exec['worktree'])
    if (wt !== undefined && typeof wt['path'] === 'string' && wt['path'] !== '' && typeof wt['branch'] === 'string') {
      const id = inspectString(wt, 'id')
      const baseCommit = inspectString(wt, 'baseCommit')
      info.worktree = {
        path: wt['path'],
        branch: wt['branch'],
        ...(id !== undefined ? { id } : {}),
        ...(baseCommit !== undefined ? { baseCommit } : {}),
      }
    }
  }
  const runId = inspectString(envelope, 'runId')
  if (runId !== undefined) info.runId = runId
  if (typeof envelope['background'] === 'boolean') info.background = envelope['background']
  const status = inspectString(envelope, 'status')
  if (status !== undefined) info.status = status

  return info.conversationId !== undefined ||
    info.executionId !== undefined ||
    info.worktree !== undefined ||
    info.runId !== undefined
    ? info
    : undefined
}

// ---------------------------------------------------------------------------
// Background settlement report parser
// ---------------------------------------------------------------------------

export type BackgroundReportKind = 'subagent_report' | 'workflow_report'
export type BackgroundReportStatus = 'completed' | 'failed' | 'aborted'

export interface BackgroundReportOtherTask {
  runId: string
  name: string
  kind: string
}

export interface BackgroundReportView {
  invalid: false
  kind: BackgroundReportKind
  runId: string
  name?: string
  status: BackgroundReportStatus
  createdAt?: number
  hasResult: boolean
  result: unknown
  error: string | undefined
  executionConversationId: number | undefined
  otherRunningTasks: BackgroundReportOtherTask[]
  rawText: string
}

export interface BackgroundReportInvalidView {
  invalid: true
  createdAt?: number
  rawText: string
}

export type BackgroundReportParse = BackgroundReportView | BackgroundReportInvalidView

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'aborted'])

function isSafePositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function extractEntryCreatedAt(entry: ConversationEntry, data: Record<string, unknown> | undefined): number | undefined {
  if (typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) && entry.createdAt > 0) return entry.createdAt
  const raw = data?.['createdAt']
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw
  return undefined
}

function invalidReport(entry: ConversationEntry): BackgroundReportInvalidView {
  const rec = asPlainRecord(entry.data)
  const text = typeof rec?.['text'] === 'string' ? rec['text'] : ''
  const createdAt = extractEntryCreatedAt(entry, rec)
  return {
    invalid: true,
    ...(createdAt !== undefined ? { createdAt } : {}),
    rawText: text,
  }
}

export function parseBackgroundReportEntry(entry: ConversationEntry): BackgroundReportParse {
  const d = asPlainRecord(entry.data)
  if (d === undefined || typeof d['text'] !== 'string') return invalidReport(entry)
  const createdAt = extractEntryCreatedAt(entry, d)
  const m = asPlainRecord(d['meta'])
  if (m === undefined) return invalidReport(entry)
  const kind: BackgroundReportKind | undefined =
    m['kind'] === 'subagent_report' || m['kind'] === 'workflow_report' ? m['kind'] : undefined
  const backgroundRunId = inspectString(m, 'backgroundRunId')
  if (kind === undefined || backgroundRunId === undefined) return invalidReport(entry)

  const r = asPlainRecord(m['report'])
  if (r === undefined) return invalidReport(entry)
  if (r['runId'] !== backgroundRunId) return invalidReport(entry)
  if (typeof r['status'] !== 'string' || !TERMINAL_STATUSES.has(r['status'])) return invalidReport(entry)
  if (r['name'] !== undefined && typeof r['name'] !== 'string') return invalidReport(entry)
  if (r['error'] !== undefined && typeof r['error'] !== 'string') return invalidReport(entry)
  const rawName = typeof r['name'] === 'string' ? r['name'].trim() : ''
  const name = rawName !== '' && !isPlaceholderRunName(rawName, backgroundRunId) ? rawName : undefined

  let executionConversationId: number | undefined
  if (r['execution'] !== undefined) {
    const exec = asPlainRecord(r['execution'])
    if (exec === undefined) return invalidReport(entry)
    if (exec['conversationId'] !== undefined) {
      if (!isSafePositiveInt(exec['conversationId'])) return invalidReport(entry)
      executionConversationId = exec['conversationId']
    }
  }

  const otherRunningTasks: BackgroundReportOtherTask[] = []
  if (r['otherRunningTasks'] !== undefined) {
    if (!Array.isArray(r['otherRunningTasks'])) return invalidReport(entry)
    for (const item of r['otherRunningTasks']) {
      const t = asPlainRecord(item)
      if (t === undefined || typeof t['runId'] !== 'string' || typeof t['name'] !== 'string' || typeof t['kind'] !== 'string') {
        return invalidReport(entry)
      }
      otherRunningTasks.push({ runId: t['runId'], name: t['name'], kind: t['kind'] })
    }
  }

  return {
    invalid: false,
    kind,
    runId: backgroundRunId,
    ...(name !== undefined ? { name } : {}),
    status: r['status'] as BackgroundReportStatus,
    ...(createdAt !== undefined ? { createdAt } : {}),
    hasResult: Object.hasOwn(r, 'result'),
    result: r['result'],
    error: typeof r['error'] === 'string' ? r['error'] : undefined,
    executionConversationId,
    otherRunningTasks,
    rawText: d['text'],
  }
}

export function isBackgroundReportDefaultOpen(view: BackgroundReportParse): boolean {
  return view.invalid || view.status === 'failed' || view.status === 'aborted'
}

export function backgroundReportPreview(view: BackgroundReportView, maxChars = 120): string {
  if ((view.status === 'failed' || view.status === 'aborted') && view.error !== undefined && view.error.trim() !== '') {
    return extractCleanPreviewLine(view.error, maxChars)
  }
  if (!view.hasResult) return ''
  return summarizeJsonPreview(view.result, maxChars)
}

// ---------------------------------------------------------------------------
// Workflow library & resume_failed parsers
// ---------------------------------------------------------------------------

export interface SavedWorkflowView {
  name: string
  path?: string
  updatedAt: number
  size: number
  metadataError?: string
  description?: string
  whenToUse?: string
  phases?: Array<{ title: string; detail?: string; model?: string }>
}

export interface SavedWorkflowDetailView extends SavedWorkflowView {
  script: string
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseSavedWorkflowEntry(item: unknown): SavedWorkflowView | undefined {
  const rec = asPlainRecord(item)
  if (rec === undefined) return undefined
  const name = inspectString(rec, 'name')
  if (name === undefined || !nonNegativeInteger(rec['updatedAt']) || !nonNegativeInteger(rec['size'])) return undefined
  let phases: Array<{ title: string; detail?: string; model?: string }> | undefined
  if (rec['phases'] !== undefined) {
    if (!Array.isArray(rec['phases'])) return undefined
    const list: Array<{ title: string; detail?: string; model?: string }> = []
    for (const p of rec['phases']) {
      const pr = asPlainRecord(p)
      const title = pr !== undefined ? inspectString(pr, 'title') : undefined
      if (pr === undefined || title === undefined) return undefined
      const detail = inspectString(pr, 'detail')
      const model = inspectString(pr, 'model')
      list.push({ title, ...(detail !== undefined ? { detail } : {}), ...(model !== undefined ? { model } : {}) })
    }
    if (list.length > 0) phases = list
  }
  const path = inspectString(rec, 'path')
  const metadataError = inspectString(rec, 'metadataError')
  const description = inspectString(rec, 'description')
  const whenToUse = inspectString(rec, 'whenToUse')
  return {
    name,
    updatedAt: rec['updatedAt'],
    size: rec['size'],
    ...(path !== undefined ? { path } : {}),
    ...(metadataError !== undefined ? { metadataError } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    ...(phases !== undefined ? { phases } : {}),
  }
}

export function parseSavedWorkflowList(raw: unknown): SavedWorkflowView[] | undefined {
  const rec = asPlainRecord(raw)
  if (rec === undefined || !Array.isArray(rec['workflows'])) return undefined
  const out: SavedWorkflowView[] = []
  for (const item of rec['workflows']) {
    const entry = parseSavedWorkflowEntry(item)
    if (entry === undefined) return undefined
    out.push(entry)
  }
  return out
}

export function parseWorkflowDetail(raw: unknown): SavedWorkflowDetailView | undefined {
  const rec = asPlainRecord(raw)
  if (rec === undefined) return undefined
  const wf = asPlainRecord(rec['workflow'])
  const entry = parseSavedWorkflowEntry(wf)
  if (entry === undefined || typeof wf?.['script'] !== 'string' || wf['script'] === '') return undefined
  return { ...entry, script: wf['script'] }
}

export function parseWorkflowArgsInput(
  text: string,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): { ok: true; args?: unknown } | { ok: false; error: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true }
  try {
    return { ok: true, args: JSON.parse(trimmed) as unknown }
  } catch (error) {
    return { ok: false, error: libArgsInvalidJson(error instanceof Error ? error.message : String(error), locale) }
  }
}

export function filterSavedWorkflows(items: ReadonlyArray<SavedWorkflowView>, query: string): SavedWorkflowView[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...items]
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(q) ||
      (item.description ?? '').toLowerCase().includes(q) ||
      (item.whenToUse ?? '').toLowerCase().includes(q),
  )
}

export function buildWorkflowRunTargetOptions(
  conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'parentConversationId' | 'updatedAt' | 'title' | 'profileId'>>,
): Array<{ value: string; label: string }> {
  return conversations
    .filter((c) => c.parentConversationId === undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 50)
    .map((c) => ({
      value: String(c.id),
      label: `#${c.id} ${c.title && c.title !== '' ? c.title : c.profileId}`.slice(0, 40),
    }))
}

export function buildWorkflowEditRequest(
  name: string,
  detail?: { description?: string },
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  const desc = detail?.description !== undefined ? firstLineOf(detail.description, 120) : undefined
  return buildWorkflowEditRequestLines(name, desc, locale).join('\n')
}

export function parseResumeFailedResult(raw: unknown): { resumedCount: number; skippedCount: number } | undefined {
  const rec = asPlainRecord(raw)
  if (rec === undefined || !Array.isArray(rec['resumed']) || !Array.isArray(rec['skipped'])) return undefined
  for (const item of rec['resumed']) {
    const r = asPlainRecord(item)
    if (r === undefined || typeof r['id'] !== 'string' || r['id'] === '') return undefined
  }
  for (const item of rec['skipped']) {
    const s = asPlainRecord(item)
    if (s === undefined || typeof s['runId'] !== 'string' || typeof s['reason'] !== 'string') return undefined
  }
  return { resumedCount: rec['resumed'].length, skippedCount: rec['skipped'].length }
}
