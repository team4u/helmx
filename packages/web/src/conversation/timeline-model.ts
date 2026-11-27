/**
 * Timeline normalization pure-function layer (plain .ts, zero React/DOM deps).
 * Converts backend `ConversationEntry[]` + live `ConversationLive` into structured render items.
 *
 * Types, helper utilities, and step-group folding live in sibling modules
 * (`timeline-types.ts`, `timeline-helpers.ts`, `timeline-folding.ts`) and are
 * re-exported here so existing imports remain stable.
 */
import type {
  ConversationEntry,
  ConversationLive,
  ToolResultTruncation,
} from '@helmx/protocol/browser'
import { foldTurnSegments, isFoldableStep, type RawSegment } from './timeline-folding.js'
import {
  assistantModelFullLabel,
  assistantModelShortLabel,
  buildActiveEntryIndex,
  buildAssistantModelBoundaries,
  buildToolViewIndex,
  buildToolViewProps,
  collectToolCallsByName,
  contentTextOf,
  detectArtifactRef,
  extractUserMessageText,
  filterRewoundEntries,
  findLatestProcessTurnKey,
  findToolView,
  humanItemEntryKind,
  isAssistantTurnBusy,
  isPlainRecord,
  isStringRecord,
  lastEditableHumanInput,
  lastHumanTextOf,
  matchSortedTimelineRenderer,
  matchTimelineRenderer,
  parseAssistantModelIdentity,
  parseHelmxInputData,
  queuedAgentTextCollapse,
  readResultTruncation,
  resolveAssistantAnchorEntry,
  sameAssistantModelIdentity,
  sortByPriorityDescStable,
  toolStatusIcon,
  toolSummaryText,
} from './timeline-helpers.js'
import type {
  AssistantModelIdentity,
  AssistantSegment,
  AssistantTurn,
  AssistantTurnBusyOptions,
  BuildTimelineOptions,
  DividerItem,
  EditRequestTarget,
  FoldableStep,
  HelmxInputData,
  HumanInputItem,
  PluginCardItem,
  ProcessShortcutCommand,
  QualifiedRenderer,
  QualifiedToolView,
  QueuedAgentTextCollapse,
  ThinkingTrace,
  TimelineItem,
  ToolTrace,
  ToolTraceStatus,
} from './timeline-types.js'

export type {
  AssistantModelIdentity,
  AssistantSegment,
  AssistantTurn,
  AssistantTurnBusyOptions,
  BuildTimelineOptions,
  DividerItem,
  EditRequestTarget,
  FoldableStep,
  HelmxInputData,
  HumanInputItem,
  PluginCardItem,
  ProcessShortcutCommand,
  QualifiedRenderer,
  QualifiedToolView,
  QueuedAgentTextCollapse,
  ThinkingTrace,
  TimelineItem,
  ToolResultTruncation,
  ToolTrace,
  ToolTraceStatus,
}

export {
  assistantModelFullLabel,
  assistantModelShortLabel,
  buildActiveEntryIndex,
  buildAssistantModelBoundaries,
  buildToolViewProps,
  collectToolCallsByName,
  detectArtifactRef,
  extractUserMessageText,
  filterRewoundEntries,
  findLatestProcessTurnKey,
  findToolView,
  foldTurnSegments,
  humanItemEntryKind,
  isAssistantTurnBusy,
  isFoldableStep,
  lastEditableHumanInput,
  lastHumanTextOf,
  matchTimelineRenderer,
  parseAssistantModelIdentity,
  parseHelmxInputData,
  queuedAgentTextCollapse,
  readResultTruncation,
  resolveAssistantAnchorEntry,
  sameAssistantModelIdentity,
  sortByPriorityDescStable,
  toolStatusIcon,
  toolSummaryText,
}

// ---------------------------------------------------------------------------
// Turn accumulator & assembly
// ---------------------------------------------------------------------------

interface TurnAcc {
  entryIds: string[]
  segments: RawSegment[]
  toolsByCallId: Map<string, ToolTrace[]>
  model?: { provider: string; model: string }
  modelReference?: { provider: string; model: string }
  modelThinkingLevel?: string
  modelThinkingMixed?: boolean
  modelLocked?: boolean
  startedAt?: number
  settledAt?: number
  modelDurationMs?: number
  toolDurationMs?: number
}

function advanceTurnSettledAt(acc: TurnAcc, timestamp: number | undefined): void {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return
  acc.settledAt = acc.settledAt !== undefined ? Math.max(acc.settledAt, timestamp) : timestamp
}

function newTurn(): TurnAcc {
  return { entryIds: [], segments: [], toolsByCallId: new Map() }
}

function registerTurnTool(acc: TurnAcc, tool: ToolTrace): void {
  if (tool.callId === undefined) return
  const bucket = acc.toolsByCallId.get(tool.callId)
  if (bucket !== undefined) bucket.push(tool)
  else acc.toolsByCallId.set(tool.callId, [tool])
}

function makeToolTrace(
  key: string,
  toolName: string,
  opts: {
    callId?: string
    input?: unknown
    status?: ToolTraceStatus
    isError?: boolean
    resultText?: string
    resultTruncation?: ToolResultTruncation
    resultEntryId?: string
    presentationMeta?: Readonly<Record<string, unknown>>
    startedAt?: number
    durationMs?: number
    toolViewByName?: ReadonlyMap<string, QualifiedToolView>
  },
): ToolTrace {
  const status = opts.status ?? 'unknown'
  const toolView = opts.toolViewByName?.get(toolName)
  return {
    key,
    toolName,
    ...(opts.callId !== undefined ? { callId: opts.callId } : {}),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    status,
    isError: opts.isError ?? status === 'error',
    ...(opts.resultText !== undefined ? { resultText: opts.resultText } : {}),
    ...(opts.resultTruncation !== undefined ? { resultTruncation: opts.resultTruncation } : {}),
    ...(opts.resultEntryId !== undefined ? { resultEntryId: opts.resultEntryId } : {}),
    ...(opts.presentationMeta !== undefined ? { presentationMeta: opts.presentationMeta } : {}),
    ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
    ...(opts.startedAt !== undefined ? { startedAt: opts.startedAt } : {}),
    ...(toolView !== undefined ? { toolView } : {}),
  }
}

function flushTurn(
  acc: TurnAcc | null,
  items: TimelineItem[],
  live: boolean,
  fallbackPrevKey = 'root',
): void {
  if (acc === null) return
  if (live) {
    for (const seg of acc.segments) {
      if (seg.kind === 'tool' && seg.tool !== undefined && seg.tool.status === 'unknown') {
        seg.tool.status = 'running'
      }
    }
  }
  const segments = foldTurnSegments(acc.segments, live)
  if (segments.length === 0) return
  const prevKey = items.length > 0 ? items[items.length - 1]!.key : fallbackPrevKey
  const spanDurationMs =
    acc.startedAt !== undefined && acc.settledAt !== undefined && acc.settledAt > acc.startedAt
      ? acc.settledAt - acc.startedAt
      : undefined
  const fallbackDurationMs =
    acc.modelDurationMs !== undefined || acc.toolDurationMs !== undefined
      ? (acc.modelDurationMs ?? 0) + (acc.toolDurationMs ?? 0)
      : undefined
  const durationMs = spanDurationMs ?? fallbackDurationMs
  const turnModel: AssistantModelIdentity | undefined =
    acc.model !== undefined
      ? {
          provider: acc.model.provider,
          model: acc.model.model,
          ...(acc.modelThinkingMixed !== true && acc.modelThinkingLevel !== undefined
            ? { thinkingLevel: acc.modelThinkingLevel }
            : {}),
        }
      : undefined
  items.push({
    kind: 'assistant',
    key: `turn:${prevKey}`,
    entryIds: [...acc.entryIds],
    segments,
    live,
    ...(turnModel !== undefined ? { model: turnModel } : {}),
    ...(acc.startedAt !== undefined ? { startedAt: acc.startedAt } : {}),
    ...(acc.settledAt !== undefined ? { settledAt: acc.settledAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(acc.modelDurationMs !== undefined ? { modelDurationMs: acc.modelDurationMs } : {}),
    ...(acc.toolDurationMs !== undefined ? { toolDurationMs: acc.toolDurationMs } : {}),
  })
}

function isEligibleProcessContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  let hasThinking = false
  let hasToolCall = false
  let hasVisibleText = false
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown; thinking?: unknown }
    if (b.type === 'thinking') {
      if (typeof b.thinking === 'string' && b.thinking.trim() !== '') hasThinking = true
    } else if (b.type === 'text') {
      if (typeof b.text === 'string' && b.text !== '') hasVisibleText = true
    } else if (b.type === 'toolCall' || b.type === 'tool_use') {
      hasToolCall = true
    }
  }
  return hasThinking && hasToolCall && !hasVisibleText
}

function readPositiveTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function readNonNegativeMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Pins the turn's model label to the first assistant message carrying one. A later message
 * without identity drops the label (the turn no longer has a single provenance); a differing
 * thinking level marks the label mixed so the UI omits the level suffix. */
function lockTurnModel(acc: TurnAcc, modelIdentity: AssistantModelIdentity | undefined): void {
  if (acc.modelLocked !== true) {
    if (modelIdentity !== undefined) {
      const core = { provider: modelIdentity.provider, model: modelIdentity.model }
      acc.model = core
      acc.modelReference = core
      acc.modelThinkingLevel = modelIdentity.thinkingLevel
    }
    acc.modelLocked = true
  } else if (modelIdentity === undefined) {
    acc.model = undefined
  } else if (
    acc.modelReference !== undefined &&
    modelIdentity.thinkingLevel !== acc.modelThinkingLevel
  ) {
    acc.modelThinkingMixed = true
  }
}

/** Timing context shared by the content blocks of one assistant message. */
interface AssistantBlockTiming {
  timestamp: number | undefined
  durationMs: number | undefined
  /** Latency of a process-only response (thinking + tool calls, no visible text);
   * attached to the first non-empty thinking block only. */
  responseMs: number | undefined
}

interface AssistantMessageShape {
  timestamp?: unknown
  durationMs?: unknown
  content?: unknown
}

/** Folds one assistant message's timing into the turn span: its timestamp opens or extends
 * the span (settled at timestamp + latency) and its latency joins the model time. */
function applyAssistantMessageTiming(
  acc: TurnAcc,
  m: AssistantMessageShape,
  entry: ConversationEntry,
): AssistantBlockTiming {
  const timestamp = readPositiveTimestamp(m.timestamp) ?? readPositiveTimestamp(entry.createdAt)
  const durationMs = readNonNegativeMs(m.durationMs)
  if (timestamp !== undefined) {
    acc.startedAt = acc.startedAt !== undefined ? Math.min(acc.startedAt, timestamp) : timestamp
    advanceTurnSettledAt(acc, timestamp + (durationMs ?? 0))
  }
  if (durationMs !== undefined) {
    acc.modelDurationMs = (acc.modelDurationMs ?? 0) + durationMs
  }
  return {
    timestamp,
    durationMs,
    responseMs:
      durationMs !== undefined && durationMs > 0 && isEligibleProcessContent(m.content)
        ? durationMs
        : undefined,
  }
}

interface AssistantContentBlockShape {
  type?: unknown
  text?: unknown
  thinking?: unknown
  id?: unknown
  callId?: unknown
  name?: unknown
  arguments?: unknown
  input?: unknown
}

function appendToolCallBlock(
  acc: TurnAcc,
  entry: ConversationEntry,
  key: string,
  b: AssistantContentBlockShape,
  timing: AssistantBlockTiming,
  toolViewByName: ReadonlyMap<string, QualifiedToolView> | undefined,
): void {
  const callId = typeof b.id === 'string' ? b.id : typeof b.callId === 'string' ? b.callId : undefined
  const name = typeof b.name === 'string' ? b.name : '(unknown tool)'
  const input = 'arguments' in b ? b.arguments : b.input
  // The call starts once its message finishes responding.
  const startedAt =
    timing.timestamp !== undefined && timing.durationMs !== undefined
      ? timing.timestamp + timing.durationMs
      : entry.createdAt
  const toolKey = `tool:${callId ?? key}`
  const tool = makeToolTrace(toolKey, name, {
    callId,
    input,
    startedAt,
    toolViewByName,
  })
  acc.segments.push({ kind: 'tool', key: toolKey, tool })
  registerTurnTool(acc, tool)
}

function appendContentBlocks(
  acc: TurnAcc,
  entry: ConversationEntry,
  mi: number,
  content: ReadonlyArray<unknown>,
  timing: AssistantBlockTiming,
  toolViewByName: ReadonlyMap<string, QualifiedToolView> | undefined,
): void {
  let responseAttached = timing.responseMs === undefined
  for (let bi = 0; bi < content.length; bi++) {
    const block = content[bi]
    if (block === null || typeof block !== 'object') continue
    const b = block as AssistantContentBlockShape
    const key = `${entry.id}:${mi}:${bi}`
    if (b.type === 'thinking') {
      const thinking = typeof b.thinking === 'string' ? b.thinking : ''
      if (thinking.trim() === '') continue
      acc.segments.push({
        kind: 'thinking',
        key: `think:${key}`,
        text: thinking,
        ...(responseAttached === false && timing.responseMs !== undefined
          ? { responseDurationMs: timing.responseMs }
          : {}),
      })
      responseAttached = true
      continue
    }
    if (b.type === 'text') {
      const text = typeof b.text === 'string' ? b.text : ''
      if (text !== '') acc.segments.push({ kind: 'text', key: `text:${key}`, text })
      continue
    }
    if (b.type === 'toolCall' || b.type === 'tool_use') {
      appendToolCallBlock(acc, entry, key, b, timing, toolViewByName)
    }
  }
}

function appendAssistantEntry(
  acc: TurnAcc,
  entry: ConversationEntry,
  toolViewByName: ReadonlyMap<string, QualifiedToolView> | undefined,
  modelIdentity: AssistantModelIdentity | undefined,
): void {
  acc.entryIds.push(entry.id)
  lockTurnModel(acc, modelIdentity)
  const model = entry.model
  if (!Array.isArray(model)) {
    // Without a message array the entry's own creation time is the whole turn span.
    const createdAt = readPositiveTimestamp(entry.createdAt)
    if (createdAt !== undefined) {
      acc.startedAt = acc.startedAt !== undefined ? Math.min(acc.startedAt, createdAt) : createdAt
      advanceTurnSettledAt(acc, createdAt)
    }
    return
  }
  for (let mi = 0; mi < model.length; mi++) {
    const msg = model[mi]
    if (msg === null || typeof msg !== 'object') continue
    const m = msg as AssistantMessageShape
    const timing = applyAssistantMessageTiming(acc, m, entry)
    if (!Array.isArray(m.content)) continue
    appendContentBlocks(acc, entry, mi, m.content, timing, toolViewByName)
  }
}

/** Normalized fields of one persisted tool-result message. */
interface ToolResultFields {
  callId: string | undefined
  toolName: string
  resultText: string
  isError: boolean
  durationMs: number | undefined
  truncation: ToolResultTruncation | undefined
  presentationMeta: Readonly<Record<string, unknown>> | undefined
}

interface ToolResultMessageShape {
  role?: unknown
  toolCallId?: unknown
  toolName?: unknown
  content?: unknown
  isError?: unknown
  durationMs?: unknown
  details?: unknown
}

function readToolResultFields(m: ToolResultMessageShape): ToolResultFields | undefined {
  if (m.role !== 'toolResult' && m.role !== 'tool') return undefined
  const details = m.details
  return {
    callId: typeof m.toolCallId === 'string' ? m.toolCallId : undefined,
    toolName: typeof m.toolName === 'string' ? m.toolName : '(unknown tool)',
    resultText: contentTextOf(m.content),
    isError: m.isError === true,
    durationMs: readNonNegativeMs(m.durationMs),
    truncation: readResultTruncation(m),
    presentationMeta: isPlainRecord(details)
      ? (details as Readonly<Record<string, unknown>>)
      : undefined,
  }
}

/** Fills a persisted result into an awaiting tool-call trace in place. */
function applyToolResultToTrace(
  acc: TurnAcc,
  trace: ToolTrace,
  entryId: string,
  fields: ToolResultFields,
): void {
  trace.status = fields.isError ? 'error' : 'done'
  trace.isError = fields.isError
  if (fields.resultText !== '') trace.resultText = fields.resultText
  if (fields.presentationMeta !== undefined) trace.presentationMeta = fields.presentationMeta
  if (fields.durationMs !== undefined) {
    trace.durationMs = fields.durationMs
    if (trace.startedAt !== undefined) {
      advanceTurnSettledAt(acc, trace.startedAt + fields.durationMs)
    }
  }
  trace.artifactRef = detectArtifactRef(trace.resultText)
  if (fields.truncation !== undefined) {
    trace.resultTruncation = fields.truncation
    trace.resultEntryId = entryId
  }
}

/** Pairs the result with the newest awaiting trace of the same call (never one that already
 * carries a result or is still running); false when nothing awaits. */
function pairToolResult(
  acc: TurnAcc,
  entryId: string,
  callId: string,
  fields: ToolResultFields,
): boolean {
  const candidates = acc.toolsByCallId.get(callId)
  if (candidates === undefined) return false
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i]!
    if (candidate.resultText !== undefined || candidate.status === 'running') continue
    applyToolResultToTrace(acc, candidate, entryId, fields)
    return true
  }
  return false
}

function appendToolResult(
  acc: TurnAcc,
  entry: ConversationEntry,
  mi: number,
  fields: ToolResultFields,
  toolViewByName: ReadonlyMap<string, QualifiedToolView> | undefined,
): void {
  if (fields.callId !== undefined && pairToolResult(acc, entry.id, fields.callId, fields)) return
  // No awaiting trace in this turn (call filtered by rewind, already paired, or belonging to
  // an earlier turn): surface the result as its own trace instead of dropping it.
  const key = `tool:${fields.callId ?? `${entry.id}:${mi}`}`
  const tool = makeToolTrace(key, fields.toolName, {
    callId: fields.callId,
    status: fields.isError ? 'error' : 'done',
    isError: fields.isError,
    ...(fields.resultText !== '' ? { resultText: fields.resultText } : {}),
    ...(fields.truncation !== undefined ? { resultTruncation: fields.truncation, resultEntryId: entry.id } : {}),
    ...(fields.presentationMeta !== undefined ? { presentationMeta: fields.presentationMeta } : {}),
    ...(fields.durationMs !== undefined ? { durationMs: fields.durationMs } : {}),
    toolViewByName,
  })
  tool.artifactRef = detectArtifactRef(tool.resultText)
  acc.segments.push({ kind: 'tool', key, tool })
  registerTurnTool(acc, tool)
}

function appendToolResultEntry(
  acc: TurnAcc,
  entry: ConversationEntry,
  toolViewByName: ReadonlyMap<string, QualifiedToolView> | undefined,
): void {
  acc.entryIds.push(entry.id)
  advanceTurnSettledAt(acc, entry.createdAt)
  const model = entry.model
  if (!Array.isArray(model)) return
  for (let mi = 0; mi < model.length; mi++) {
    const msg = model[mi]
    if (msg === null || typeof msg !== 'object') continue
    const fields = readToolResultFields(msg as ToolResultMessageShape)
    if (fields === undefined) continue
    if (fields.durationMs !== undefined) {
      acc.toolDurationMs = (acc.toolDurationMs ?? 0) + fields.durationMs
    }
    appendToolResult(acc, entry, mi, fields, toolViewByName)
  }
}

function mergeLiveIntoTurn(
  acc: TurnAcc,
  live: ConversationLive,
  toolViewByName: ReadonlyMap<string, QualifiedToolView> | undefined,
): void {
  const genContent = live.generation?.message?.content
  if (genContent !== undefined) {
    for (let bi = 0; bi < genContent.length; bi++) {
      const block = genContent[bi]
      if (block?.type !== 'thinking' || block.thinking.trim() === '') continue
      if (acc.segments.some((s) => s.kind === 'thinking' && s.text === block.thinking)) continue
      acc.segments.push({
        kind: 'thinking',
        key: `think:live:${bi}`,
        text: block.thinking,
        ...(bi === genContent.length - 1 ? { live: 'generation' as const } : {}),
      })
    }
  } else if (typeof live.thinking === 'string' && live.thinking.trim() !== '') {
    const persistedThinking = acc.segments.findLast((segment) => segment.kind === 'thinking')?.text
    if (!persistedThinking?.startsWith(live.thinking)) {
      acc.segments.push({ kind: 'thinking', key: 'think:live', text: live.thinking, live: 'flat' })
    }
  }
  for (const lt of live.tools) {
    if (typeof lt?.callId !== 'string' || typeof lt.toolName !== 'string') continue
    const existing = acc.toolsByCallId.get(lt.callId)?.[0]
    if (existing !== undefined) {
      if (existing.status !== 'done' && existing.status !== 'error') existing.status = lt.status
      if (lt.status === 'error') {
        existing.status = 'error'
        existing.isError = true
      }
      if (existing.input === undefined && lt.input !== undefined) existing.input = lt.input
      if (existing.resultText === undefined && lt.result !== undefined) {
        const text = typeof lt.result === 'string' ? lt.result : contentTextOf(lt.result)
        if (text !== '') existing.resultText = text
      }
      continue
    }
    const key = `tool:${lt.callId}`
    const tool = makeToolTrace(key, lt.toolName, {
      callId: lt.callId,
      ...(lt.input !== undefined ? { input: lt.input } : {}),
      status: lt.status,
      toolViewByName,
    })
    acc.segments.push({ kind: 'tool', key, tool })
    registerTurnTool(acc, tool)
  }
  if (typeof live.text === 'string' && live.text.trim() !== '') {
    const persistedText = acc.segments.findLast((segment) => segment.kind === 'text')?.text
    if (persistedText?.startsWith(live.text)) return
    acc.segments.push({ kind: 'text', key: 'text:live', text: live.text })
  }
}

export interface SettledTimelinePrefix {
  readonly items: TimelineItem[]
  readonly tailTurnEntries: ReadonlyArray<ConversationEntry>
  readonly seenInputIds: ReadonlySet<string>
  readonly lastItemKey: string
}

/** Mutable state of the settled-prefix walk: the trailing open assistant turn (accumulator
 * plus raw entries, handed to {@link buildLiveTimelineTail}) and the last seen human input
 * text (suppresses the persisted `pi.user` echo of the same submission). */
interface SettledPrefixState {
  turn: TurnAcc | null
  tailTurnEntries: ConversationEntry[]
  lastHumanInputText: string | undefined
}

function closeSettledTurn(state: SettledPrefixState, items: TimelineItem[]): void {
  flushTurn(state.turn, items, false)
  state.turn = null
  state.tailTurnEntries = []
}

/** Remembers a `helmx.input` for the rest of the walk: its inputId dedups queued inputs in
 * the live tail, its text suppresses the persisted `pi.user` echo. */
function noteHumanInput(state: SettledPrefixState, seenInputIds: Set<string>, data: HelmxInputData): void {
  state.lastHumanInputText = data.text
  if (data.id !== undefined) seenInputIds.add(data.id)
}

function humanItemOf(entry: ConversationEntry, data: HelmxInputData, fallback: boolean): HumanInputItem {
  const createdAt = readPositiveTimestamp(data.createdAt) ?? readPositiveTimestamp(entry.createdAt)
  return {
    kind: 'human',
    key: data.id !== undefined ? `human:id:${data.id}` : `human:${entry.id}`,
    entryId: entry.id,
    ...(data.id !== undefined ? { inputId: data.id } : {}),
    text: data.text,
    origin: data.origin,
    ...(data.meta !== undefined ? { meta: data.meta } : {}),
    ...(data.attachments !== undefined && data.attachments.length > 0 ? { attachments: data.attachments } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    fallback,
  }
}

/** A plugin-rendered `helmx.input` still is the submission's human input for the tail. */
function appendPluginCard(
  state: SettledPrefixState,
  items: TimelineItem[],
  seenInputIds: Set<string>,
  entry: ConversationEntry,
  renderer: QualifiedRenderer,
): void {
  if (entry.kind === 'helmx.input') {
    const data = parseHelmxInputData(entry.data)
    if (data !== undefined) noteHumanInput(state, seenInputIds, data)
  }
  closeSettledTurn(state, items)
  items.push({ kind: 'plugin-card', key: `card:${entry.id}`, entryId: entry.id, entry, renderer })
}

function appendHelmxInput(
  state: SettledPrefixState,
  items: TimelineItem[],
  seenInputIds: Set<string>,
  entry: ConversationEntry,
): void {
  const data = parseHelmxInputData(entry.data)
  if (data === undefined) return
  noteHumanInput(state, seenInputIds, data)
  closeSettledTurn(state, items)
  items.push(humanItemOf(entry, data, false))
}

function appendUserMessage(state: SettledPrefixState, items: TimelineItem[], entry: ConversationEntry): void {
  const text = extractUserMessageText(entry)
  if (text === '') return
  // `pi.user` mirrors the `helmx.input` of the same submission in persisted history: skip the echo.
  if (state.lastHumanInputText === text) return
  state.lastHumanInputText = text
  closeSettledTurn(state, items)
  items.push(humanItemOf(entry, { text, origin: 'human' }, true))
}

/** A model switch inside the trailing turn starts a new turn so each item carries one label. */
function turnModelSwitched(turn: TurnAcc | null, next: AssistantModelIdentity | undefined): boolean {
  return (
    turn !== null &&
    turn.modelLocked === true &&
    turn.modelReference !== undefined &&
    next !== undefined &&
    !sameAssistantModelIdentity(next, turn.modelReference)
  )
}

function appendAssistantTurnEntry(
  state: SettledPrefixState,
  items: TimelineItem[],
  entry: ConversationEntry,
  toolViewByName: ReadonlyMap<string, QualifiedToolView> | undefined,
): void {
  const modelIdentity = parseAssistantModelIdentity(entry)
  if (turnModelSwitched(state.turn, modelIdentity)) closeSettledTurn(state, items)
  if (state.turn === null) state.turn = newTurn()
  appendAssistantEntry(state.turn, entry, toolViewByName, modelIdentity)
  state.tailTurnEntries.push(entry)
}

function appendToolResultTurnEntry(
  state: SettledPrefixState,
  entry: ConversationEntry,
  toolViewByName: ReadonlyMap<string, QualifiedToolView> | undefined,
): void {
  if (state.turn === null) state.turn = newTurn()
  appendToolResultEntry(state.turn, entry, toolViewByName)
  state.tailTurnEntries.push(entry)
}

function appendResetDivider(state: SettledPrefixState, items: TimelineItem[], entry: ConversationEntry): void {
  const dataText = isStringRecord(entry.data) && typeof entry.data.handoff === 'string' ? entry.data.handoff : undefined
  const handoff = dataText !== undefined && dataText !== '' ? dataText : extractUserMessageText(entry)
  closeSettledTurn(state, items)
  state.lastHumanInputText = undefined
  items.push({
    kind: 'divider',
    key: `divider:${entry.id}`,
    entryId: entry.id,
    divider: 'reset',
    ...(handoff !== '' ? { handoff } : {}),
  })
}

function appendCompactionDivider(state: SettledPrefixState, items: TimelineItem[], entry: ConversationEntry): void {
  const summary = extractUserMessageText(entry)
  closeSettledTurn(state, items)
  state.lastHumanInputText = undefined
  items.push({
    kind: 'divider',
    key: `divider:${entry.id}`,
    entryId: entry.id,
    divider: 'compaction',
    ...(summary !== '' ? { summary } : {}),
  })
}

/**
 * Memo-friendly settled prefix builder: normalizes every closed historical turn, human input,
 * plugin card, and divider independently of `live` / `working` / `compacting`, isolating only
 * the trailing open assistant turn entries (`tailTurnEntries`) for {@link buildLiveTimelineTail}.
 *
 * Historical `TimelineItem` and `ToolTrace` instances in `items` retain strict `===` identity
 * across all streaming token deltas.
 */
export function buildSettledTimelinePrefix(
  entries: ReadonlyArray<ConversationEntry>,
  options: Pick<BuildTimelineOptions, 'timelineRenderers' | 'toolViews'> = {},
): SettledTimelinePrefix {
  const activeEntries = filterRewoundEntries(entries)
  const sortedRenderers =
    options.timelineRenderers !== undefined && options.timelineRenderers.length > 0
      ? sortByPriorityDescStable(options.timelineRenderers)
      : undefined
  const toolViewByName = buildToolViewIndex(options.toolViews)
  const items: TimelineItem[] = []
  const seenInputIds = new Set<string>()
  const state: SettledPrefixState = { turn: null, tailTurnEntries: [], lastHumanInputText: undefined }

  for (const entry of activeEntries) {
    const renderer = matchSortedTimelineRenderer(entry, sortedRenderers)
    if (renderer !== undefined) {
      appendPluginCard(state, items, seenInputIds, entry, renderer)
      continue
    }
    switch (entry.kind) {
      case 'helmx.input':
        appendHelmxInput(state, items, seenInputIds, entry)
        break
      case 'pi.user':
        appendUserMessage(state, items, entry)
        break
      case 'pi.assistant':
        appendAssistantTurnEntry(state, items, entry, toolViewByName)
        break
      case 'pi.tool-result':
        appendToolResultTurnEntry(state, entry, toolViewByName)
        break
      case 'pi.reset':
        appendResetDivider(state, items, entry)
        break
      case 'pi.compaction':
        appendCompactionDivider(state, items, entry)
        break
      case 'pi.system':
      default:
        break
    }
  }

  return {
    items,
    tailTurnEntries: state.tailTurnEntries,
    seenInputIds,
    lastItemKey: items.length > 0 ? items[items.length - 1]!.key : 'root',
  }
}

/**
 * Rebuilds only the trailing assistant turn + live stream (`thinking`, mid-turn `tools` stitching,
 * `text`), pending compaction divider, and deduplicated `queuedInputs` (`queued-pill` /
 * `queued-transition`) on top of {@link SettledTimelinePrefix}.
 */
export function buildLiveTimelineTail(
  prefix: SettledTimelinePrefix,
  options: BuildTimelineOptions = {},
): TimelineItem[] {
  const toolViewByName = buildToolViewIndex(options.toolViews)
  const tailItems: TimelineItem[] = []
  let turn: TurnAcc | null = null

  for (const entry of prefix.tailTurnEntries) {
    if (entry.kind === 'pi.assistant') {
      if (turn === null) turn = newTurn()
      appendAssistantEntry(turn, entry, toolViewByName, parseAssistantModelIdentity(entry))
    } else if (entry.kind === 'pi.tool-result') {
      if (turn === null) turn = newTurn()
      appendToolResultEntry(turn, entry, toolViewByName)
    }
  }

  const isLive = options.working ?? (options.live !== undefined)
  if (options.live !== undefined) {
    if (turn === null) turn = newTurn()
    mergeLiveIntoTurn(turn, options.live, toolViewByName)
  }
  flushTurn(turn, tailItems, isLive, prefix.lastItemKey)

  if (options.compacting === true) {
    tailItems.push({
      kind: 'divider',
      key: 'divider:compacting',
      entryId: 'compacting:live',
      divider: 'compaction',
      pending: true,
    })
  }

  const queuedInputs = options.live?.queuedInputs
  if (queuedInputs !== undefined && queuedInputs.length > 0) {
    const tailSeenIds = new Set<string>()
    for (const q of queuedInputs) {
      if (typeof q?.id !== 'string' || q.id === '' || typeof q.text !== 'string') continue
      if (q.mode !== 'steer' && q.mode !== 'followUp') continue
      if (prefix.seenInputIds.has(q.id) || tailSeenIds.has(q.id)) continue
      tailSeenIds.add(q.id)
      tailItems.push({
        kind: 'human',
        key: `human:id:${q.id}`,
        entryId: `queued:${q.submissionId}`,
        inputId: q.id,
        text: q.text,
        origin: q.origin === 'agent' || q.origin === 'trigger' ? q.origin : 'human',
        ...(Array.isArray(q.attachments) && q.attachments.length > 0 ? { attachments: q.attachments } : {}),
        ...(typeof q.createdAt === 'number' && Number.isFinite(q.createdAt) && q.createdAt > 0
          ? { createdAt: q.createdAt }
          : {}),
        fallback: false,
        queuedMode: q.mode,
      })
    }
  }
  return tailItems
}

/**
 * Main timeline normalization function.
 * Input contract: entries are in chronological order (old -> new, guaranteed by getConversationDetail).
 */
export function buildTimelineItems(
  entries: ReadonlyArray<ConversationEntry>,
  options: BuildTimelineOptions = {},
): TimelineItem[] {
  const prefix = buildSettledTimelinePrefix(entries, options)
  const tail = buildLiveTimelineTail(prefix, options)
  return tail.length === 0 ? prefix.items : [...prefix.items, ...tail]
}
