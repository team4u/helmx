/**
 * Pure helper functions for timeline rewind filtering, input/model parsing,
 * plugin matcher arbitration, tool/artifact formatting, and view queries.
 */
import type {
  ConversationAttachmentRef,
  ConversationEntry,
  InputOrigin,
  TimelineToolCallSummary,
  ToolResultTruncation,
  ToolViewProps,
} from '@helmx/protocol/browser'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import type {
  AssistantModelIdentity,
  AssistantTurn,
  AssistantTurnBusyOptions,
  EditRequestTarget,
  HelmxInputData,
  HumanInputItem,
  QualifiedRenderer,
  QualifiedToolView,
  QueuedAgentTextCollapse,
  TimelineItem,
  ToolTrace,
} from './timeline-types.js'

const SPILL_ID_RE = /\[Artifact\]\s+id=([A-Za-z0-9][A-Za-z0-9._:-]{0,127})/
const ART_REF_RE = /\bart_[A-Za-z0-9_-]{1,127}\b/
const QUEUED_AGENT_COLLAPSE_CHARS = 600
const QUEUED_AGENT_COLLAPSE_LINES = 8
const QUEUED_AGENT_PREVIEW_CHARS = 240

export function isStringRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isSafePositiveInt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

export function readResultTruncation(message: unknown): ToolResultTruncation | undefined {
  if (message === null || typeof message !== 'object') return undefined
  const m = message as Record<string, unknown>
  if (m['truncated'] !== true) return undefined
  const totalChars = m['totalChars']
  const totalLines = m['totalLines']
  return {
    truncated: true,
    ...(typeof totalChars === 'number' && Number.isFinite(totalChars) && totalChars >= 0 ? { totalChars } : {}),
    ...(typeof totalLines === 'number' && Number.isFinite(totalLines) && totalLines >= 0 ? { totalLines } : {}),
  }
}

export function filterRewoundEntries(entries: ReadonlyArray<ConversationEntry>): ConversationEntry[] {
  const rewindEntryIds = new Set<string>()
  const ranges: Array<[number, number]> = []
  for (const entry of entries) {
    if (entry.kind !== 'helmx.rewind') continue
    rewindEntryIds.add(entry.id)
    const data = isStringRecord(entry.data) ? entry.data : undefined
    const markerId = Number(entry.id)
    const fromEntryId = Number(data?.fromEntryId)
    const throughEntryId = Number(data?.throughEntryId)
    if (
      isSafePositiveInt(fromEntryId) &&
      isSafePositiveInt(throughEntryId) &&
      throughEntryId >= fromEntryId &&
      isSafePositiveInt(markerId) &&
      markerId > throughEntryId
    ) {
      ranges.push([fromEntryId, throughEntryId])
    }
  }
  if (rewindEntryIds.size === 0) return [...entries]
  return entries.filter((entry) => {
    if (rewindEntryIds.has(entry.id)) return false
    if (ranges.length === 0) return true
    const id = Number(entry.id)
    if (!Number.isFinite(id)) return true
    return !ranges.some(([from, through]) => id >= from && id <= through)
  })
}

export function parseHelmxInputData(data: unknown): HelmxInputData | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const d = data as Record<string, unknown>
  if (typeof d.text !== 'string') return undefined
  const origin: InputOrigin = d.origin === 'agent' || d.origin === 'trigger' ? d.origin : 'human'
  const attachments: ConversationAttachmentRef[] = Array.isArray(d.attachments)
    ? d.attachments.filter(
        (a): a is ConversationAttachmentRef =>
          a !== null && typeof a === 'object' && typeof (a as { id?: unknown }).id === 'string',
      )
    : []
  return {
    ...(typeof d.id === 'string' && d.id !== '' ? { id: d.id } : {}),
    text: d.text,
    origin,
    ...(d.whenBusy === 'steer' || d.whenBusy === 'followUp' || d.whenBusy === 'reject'
      ? { whenBusy: d.whenBusy }
      : {}),
    ...(typeof d.createdAt === 'number' && Number.isFinite(d.createdAt) ? { createdAt: d.createdAt } : {}),
    ...(isStringRecord(d.meta) ? { meta: d.meta } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  }
}

export function contentTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') text += b.text
  }
  return text
}

export function extractUserMessageText(entry: ConversationEntry): string {
  const model = entry.model
  if (!Array.isArray(model)) return ''
  let text = ''
  for (const msg of model) {
    if (msg === null || typeof msg !== 'object') continue
    if ((msg as { role?: unknown }).role !== 'user') continue
    text += contentTextOf((msg as { content?: unknown }).content)
  }
  return text
}

export function lastEditableHumanInput(entries: ReadonlyArray<ConversationEntry>): EditRequestTarget | undefined {
  const active = filterRewoundEntries(entries)
  for (let i = active.length - 1; i >= 0; i--) {
    const entry = active[i]!
    if (entry.kind === 'pi.reset' || entry.kind === 'pi.compaction') return undefined
    if (entry.kind === 'helmx.input') {
      const data = parseHelmxInputData(entry.data)
      const entryId = Number(entry.id)
      if (
        data !== undefined &&
        data.origin === 'human' &&
        data.text.trim() !== '' &&
        isSafePositiveInt(entryId)
      ) {
        return {
          text: data.text,
          entryId,
          ...(data.attachments !== undefined && data.attachments.length > 0 ? { attachments: data.attachments } : {}),
        }
      }
      continue
    }
    if (entry.kind === 'pi.user') {
      const text = extractUserMessageText(entry)
      const entryId = Number(entry.id)
      if (text.trim() !== '' && isSafePositiveInt(entryId)) {
        return { text, entryId }
      }
    }
  }
  return undefined
}

export function sortByPriorityDescStable<T extends { spec: { priority?: number } }>(
  items: ReadonlyArray<T>,
): T[] {
  return items
    .map((item, index) => ({ item, index, priority: item.spec.priority ?? 0 }))
    .sort((a, b) => (a.priority !== b.priority ? b.priority - a.priority : a.index - b.index))
    .map((entry) => entry.item)
}

export function matchSortedTimelineRenderer(
  entry: ConversationEntry,
  sortedRenderers: ReadonlyArray<QualifiedRenderer> | undefined,
): QualifiedRenderer | undefined {
  if (!sortedRenderers || sortedRenderers.length === 0) return undefined
  const data = isStringRecord(entry.data) ? entry.data : undefined
  const meta = data && isStringRecord(data.meta) ? data.meta : undefined
  const metaRenderer = typeof meta?.renderer === 'string' ? meta.renderer : undefined
  const ownRenderer = typeof data?.renderer === 'string' ? data.renderer : undefined
  for (const r of sortedRenderers) {
    const kinds = r.spec.kinds
    if (kinds !== undefined && (!Array.isArray(kinds) || !kinds.includes(entry.kind))) continue
    const want = r.spec.matchMeta?.renderer
    if (want !== undefined && metaRenderer !== want && ownRenderer !== want) continue
    return r
  }
  return undefined
}

export function matchTimelineRenderer(
  entry: ConversationEntry,
  renderers: ReadonlyArray<QualifiedRenderer> | undefined,
): QualifiedRenderer | undefined {
  if (!renderers || renderers.length === 0) return undefined
  return matchSortedTimelineRenderer(entry, sortByPriorityDescStable(renderers))
}

export function buildToolViewIndex(
  toolViews: ReadonlyArray<QualifiedToolView> | undefined,
): ReadonlyMap<string, QualifiedToolView> | undefined {
  if (!toolViews || toolViews.length === 0) return undefined
  const byToolName = new Map<string, QualifiedToolView>()
  for (const tv of sortByPriorityDescStable(toolViews)) {
    if (!Array.isArray(tv.spec.toolNames)) continue
    for (const toolName of tv.spec.toolNames) {
      if (!byToolName.has(toolName)) byToolName.set(toolName, tv)
    }
  }
  return byToolName
}

export function findToolView(
  toolName: string,
  toolViews: ReadonlyArray<QualifiedToolView> | undefined,
): QualifiedToolView | undefined {
  if (!toolViews) return undefined
  for (const tv of sortByPriorityDescStable(toolViews)) {
    if (Array.isArray(tv.spec.toolNames) && tv.spec.toolNames.includes(toolName)) return tv
  }
  return undefined
}

function summarizeValue(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return raw.length > 24 ? `${raw.slice(0, 24)}…` : raw
}

/**
 * One-line summary for a collapsed tool row. A preferred string field is shown verbatim (first
 * line only); the row's CSS `text-overflow: ellipsis` trims it to the actual available width, so
 * wide screens reveal more and narrow ones less — a fixed character cap here would cut short
 * commands on wide screens while leaving the right half of the row empty. Tools without a
 * preferred field get a compact `k=v` digest instead (values capped per entry by design).
 */
export function toolSummaryText(toolName: string, input: unknown): string {
  void toolName
  let raw = ''
  if (typeof input === 'string') {
    raw = input
  } else if (isStringRecord(input)) {
    const preferred = ['command', 'file_path', 'path', 'pattern', 'prompt', 'query', 'url', 'skill_id']
    for (const key of preferred) {
      const v = input[key]
      if (typeof v === 'string' && v !== '') {
        raw = v
        break
      }
    }
    if (raw === '') {
      raw = Object.entries(input)
        .slice(0, 3)
        .map(([k, v]) => `${k}=${summarizeValue(v)}`)
        .join(' ')
    }
  }
  return raw.split('\n')[0]?.trim() ?? ''
}

export function detectArtifactRef(text: string | undefined): string | undefined {
  if (typeof text !== 'string' || text === '') return undefined
  return SPILL_ID_RE.exec(text)?.[1] ?? ART_REF_RE.exec(text)?.[0]
}

export function parseAssistantModelIdentity(entry: ConversationEntry): AssistantModelIdentity | undefined {
  if (entry.kind !== 'pi.assistant') return undefined
  const model = entry.model
  if (!Array.isArray(model) || model.length === 0) return undefined
  const msg = model[0]
  if (msg === null || typeof msg !== 'object') return undefined
  const m = msg as { role?: unknown; provider?: unknown; model?: unknown; thinkingLevel?: unknown }
  if (m.role !== 'assistant') return undefined
  if (typeof m.provider !== 'string' || m.provider.trim() === '') return undefined
  if (typeof m.model !== 'string' || m.model.trim() === '') return undefined
  const thinkingLevel =
    typeof m.thinkingLevel === 'string' && m.thinkingLevel.trim() !== '' ? m.thinkingLevel : undefined
  return {
    provider: m.provider,
    model: m.model,
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  }
}

export function sameAssistantModelIdentity(a: AssistantModelIdentity, b: AssistantModelIdentity): boolean {
  return a.provider === b.provider && a.model === b.model
}

export function assistantModelShortLabel(identity: AssistantModelIdentity): string {
  return identity.model.split('/').pop() ?? identity.model
}

export function assistantModelFullLabel(identity: AssistantModelIdentity, t?: WebMessageTranslator): string {
  const tt = t ?? englishWebTranslator
  const base = `${identity.provider}/${identity.model}`
  return identity.thinkingLevel !== undefined
    ? tt('conv.model.thinkingSuffix', { base, level: identity.thinkingLevel })
    : base
}

export function buildAssistantModelBoundaries(
  items: ReadonlyArray<TimelineItem>,
): Map<string, AssistantModelIdentity> {
  const boundaries = new Map<string, AssistantModelIdentity>()
  let prevAssistant: AssistantTurn | undefined
  for (const item of items) {
    if (item.kind === 'divider') {
      prevAssistant = undefined
      continue
    }
    if (item.kind !== 'assistant') continue
    if (
      prevAssistant !== undefined &&
      prevAssistant.model !== undefined &&
      item.model !== undefined &&
      !sameAssistantModelIdentity(prevAssistant.model, item.model)
    ) {
      boundaries.set(item.key, item.model)
    }
    prevAssistant = item
  }
  return boundaries
}

export function collectToolCallsByName(
  items: ReadonlyArray<TimelineItem>,
): Map<string, TimelineToolCallSummary[]> {
  const byName = new Map<string, TimelineToolCallSummary[]>()
  let index = 0
  const pushTool = (tool: ToolTrace): void => {
    if (tool.callId === undefined || tool.callId === '' || tool.toolName === '') return
    const summary: TimelineToolCallSummary = {
      callId: tool.callId,
      toolName: tool.toolName,
      index: index++,
      status: tool.status === 'running' ? 'running' : tool.status === 'error' ? 'error' : 'done',
      ...(tool.input !== undefined ? { input: tool.input } : {}),
      ...(tool.presentationMeta !== undefined ? { presentationMeta: tool.presentationMeta } : {}),
    }
    let bucket = byName.get(tool.toolName)
    if (bucket === undefined) {
      bucket = []
      byName.set(tool.toolName, bucket)
    }
    bucket.push(summary)
  }
  for (const item of items) {
    if (item.kind !== 'assistant') continue
    for (const seg of item.segments) {
      if (seg.kind === 'tool') {
        pushTool(seg.tool)
      } else if (seg.kind === 'step-group') {
        for (const step of seg.steps) {
          if (step.kind === 'tool') pushTool(step.tool)
        }
      }
    }
  }
  return byName
}

export function lastHumanTextOf(items: ReadonlyArray<TimelineItem>): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind === 'human' && item.text.trim() !== '') return item.text
  }
  return undefined
}

export function humanItemEntryKind(item: HumanInputItem): string {
  return item.fallback ? 'pi.user' : 'helmx.input'
}

export function queuedAgentTextCollapse(text: string): QueuedAgentTextCollapse {
  const lines = text.split('\n')
  if (text.length <= QUEUED_AGENT_COLLAPSE_CHARS && lines.length <= QUEUED_AGENT_COLLAPSE_LINES) {
    return { collapsed: false, preview: text }
  }
  const preview = lines.slice(0, 6).join('\n').slice(0, QUEUED_AGENT_PREVIEW_CHARS)
  return {
    collapsed: true,
    preview: preview.length < text.length ? `${preview}…` : preview,
  }
}

export function isAssistantTurnBusy(
  turn: AssistantTurn,
  conversation: { id: number; status?: string },
  options?: AssistantTurnBusyOptions,
): boolean {
  if (turn.live) return true
  if (
    options?.isLatestTurn &&
    (conversation.status === 'working' || conversation.status === 'blocked')
  ) {
    return true
  }
  const isToolRunning = (tool: ToolTrace): boolean =>
    tool.status === 'running' ||
    tool.status === 'unknown' ||
    (tool.callId !== undefined && options?.activeToolCallIds?.has(tool.callId) === true)

  for (const seg of turn.segments) {
    if (seg.kind === 'tool') {
      if (isToolRunning(seg.tool)) return true
    } else if (seg.kind === 'step-group') {
      if (seg.active) return true
      for (const step of seg.steps) {
        if (step.kind === 'tool' && isToolRunning(step.tool)) return true
      }
    }
  }
  return false
}

export function toolStatusIcon(tool: ToolTrace): string {
  if (tool.status === 'running') return 'loader'
  if (tool.isError) return 'x'
  if (tool.status === 'done') return 'check'
  return 'circle'
}

export function buildToolViewProps(tool: ToolTrace, conversationId: number): ToolViewProps {
  return {
    callId: tool.callId ?? '',
    toolName: tool.toolName,
    ...(tool.input !== undefined ? { input: tool.input } : {}),
    status: tool.status === 'running' ? 'running' : tool.status === 'error' ? 'error' : 'done',
    ...(tool.resultText !== undefined ? { result: tool.resultText } : {}),
    ...(tool.resultTruncation !== undefined ? { resultTruncation: tool.resultTruncation } : {}),
    ...(tool.presentationMeta !== undefined ? { presentationMeta: tool.presentationMeta } : {}),
    isError: tool.isError,
    ...(tool.startedAt !== undefined ? { startedAt: tool.startedAt } : {}),
    ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
    ...(tool.artifactRef !== undefined ? { artifactRef: tool.artifactRef } : {}),
    conversationId,
  }
}

export function buildActiveEntryIndex(entries: ReadonlyArray<ConversationEntry>): Map<string, ConversationEntry> {
  const index = new Map<string, ConversationEntry>()
  for (const entry of filterRewoundEntries(entries)) index.set(entry.id, entry)
  return index
}

function hasAssistantText(entry: ConversationEntry): boolean {
  if (!Array.isArray(entry.model)) return false
  for (const msg of entry.model) {
    if ((msg as { role?: unknown } | null)?.role !== 'assistant') continue
    const content = (msg as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        (block as { type?: unknown } | null)?.type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string' &&
        (block as { text: string }).text !== ''
      ) {
        return true
      }
    }
  }
  return false
}

export function resolveAssistantAnchorEntry(
  entryIds: ReadonlyArray<string>,
  entriesById: ReadonlyMap<string, ConversationEntry>,
): ConversationEntry | undefined {
  let lastAssistant: ConversationEntry | undefined
  let lastTextEntry: ConversationEntry | undefined
  for (const id of entryIds) {
    const entry = entriesById.get(id)
    if (entry === undefined || entry.kind !== 'pi.assistant') continue
    lastAssistant = entry
    if (hasAssistantText(entry)) lastTextEntry = entry
  }
  return lastTextEntry ?? lastAssistant
}

export function findLatestProcessTurnKey(items: ReadonlyArray<TimelineItem>): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind === 'assistant' && item.segments.some((seg) => seg.kind === 'step-group')) {
      return item.key
    }
  }
  return undefined
}
