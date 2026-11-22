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

function flushTurn(acc: TurnAcc | null, items: TimelineItem[], live: boolean): void {
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
  const prevKey = items.length > 0 ? items[items.length - 1]!.key : 'root'
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

function appendAssistantEntry(
  acc: TurnAcc,
  entry: ConversationEntry,
  toolViewByName: ReadonlyMap<string, QualifiedToolView> | undefined,
  modelIdentity: AssistantModelIdentity | undefined,
): void {
  acc.entryIds.push(entry.id)
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
  const model = entry.model
  if (Array.isArray(model)) {
    for (let mi = 0; mi < model.length; mi++) {
      const msg = model[mi]
      if (msg === null || typeof msg !== 'object') continue
      const m = msg as {
        role?: unknown
        timestamp?: unknown
        durationMs?: unknown
        content?: unknown
      }

      const msgTimestamp =
        typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) && m.timestamp > 0
          ? m.timestamp
          : typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) && entry.createdAt > 0
            ? entry.createdAt
            : undefined

      const msgDurationMs =
        typeof m.durationMs === 'number' && Number.isFinite(m.durationMs) && m.durationMs >= 0
          ? m.durationMs
          : undefined

      if (msgTimestamp !== undefined) {
        acc.startedAt = acc.startedAt !== undefined ? Math.min(acc.startedAt, msgTimestamp) : msgTimestamp
        advanceTurnSettledAt(acc, msgTimestamp + (msgDurationMs ?? 0))
      }
      if (msgDurationMs !== undefined) {
        acc.modelDurationMs = (acc.modelDurationMs ?? 0) + msgDurationMs
      }

      const eligibleResponseMs =
        msgDurationMs !== undefined && msgDurationMs > 0 && isEligibleProcessContent(m.content)
          ? msgDurationMs
          : undefined
      let responseDurationAttached = eligibleResponseMs === undefined

      const content = m.content
      if (!Array.isArray(content)) continue
      for (let bi = 0; bi < content.length; bi++) {
        const block = content[bi]
        if (block === null || typeof block !== 'object') continue
        const b = block as { type?: unknown; text?: unknown; thinking?: unknown; id?: unknown; callId?: unknown; name?: unknown; arguments?: unknown; input?: unknown }
        const key = `${entry.id}:${mi}:${bi}`
        if (b.type === 'thinking') {
          if (typeof b.thinking === 'string' && b.thinking.trim() !== '') {
            acc.segments.push({
              kind: 'thinking',
              key: `think:${key}`,
              text: b.thinking,
              ...(responseDurationAttached === false && eligibleResponseMs !== undefined
                ? { responseDurationMs: eligibleResponseMs }
                : {}),
            })
            if (eligibleResponseMs !== undefined) responseDurationAttached = true
          }
          continue
        }
        if (b.type === 'text') {
          if (typeof b.text === 'string' && b.text !== '') {
            acc.segments.push({ kind: 'text', key: `text:${key}`, text: b.text })
          }
          continue
        }
        if (b.type === 'toolCall' || b.type === 'tool_use') {
          const callId = typeof b.id === 'string' ? b.id : typeof b.callId === 'string' ? b.callId : undefined
          const name = typeof b.name === 'string' ? b.name : '(unknown tool)'
          const input = 'arguments' in b ? b.arguments : b.input
          const callStartedAt =
            msgTimestamp !== undefined && msgDurationMs !== undefined ? msgTimestamp + msgDurationMs : entry.createdAt
          const toolKey = `tool:${callId ?? key}`
          const tool = makeToolTrace(toolKey, name, {
            callId,
            input,
            startedAt: callStartedAt,
            toolViewByName,
          })
          acc.segments.push({ kind: 'tool', key: toolKey, tool })
          registerTurnTool(acc, tool)
        }
      }
    }
  } else if (typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) && entry.createdAt > 0) {
    acc.startedAt = acc.startedAt !== undefined ? Math.min(acc.startedAt, entry.createdAt) : entry.createdAt
    acc.settledAt = acc.settledAt !== undefined ? Math.max(acc.settledAt, entry.createdAt) : entry.createdAt
  }
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
    const m = msg as { role?: unknown; toolCallId?: unknown; toolName?: unknown; content?: unknown; isError?: unknown; durationMs?: unknown; details?: unknown }
    if (m.role !== 'toolResult' && m.role !== 'tool') continue
    const callId = typeof m.toolCallId === 'string' ? m.toolCallId : undefined
    const toolName = typeof m.toolName === 'string' ? m.toolName : '(unknown tool)'
    const resultText = contentTextOf(m.content)
    const isError = m.isError === true
    const durationMs =
      typeof m.durationMs === 'number' && Number.isFinite(m.durationMs) && m.durationMs >= 0
        ? m.durationMs
        : undefined
    if (durationMs !== undefined) {
      acc.toolDurationMs = (acc.toolDurationMs ?? 0) + durationMs
    }
    const truncation = readResultTruncation(m)
    const details = m.details
    const presentationMeta = isPlainRecord(details)
      ? (details as Readonly<Record<string, unknown>>)
      : undefined
    if (callId !== undefined) {
      const candidates = acc.toolsByCallId.get(callId)
      if (candidates !== undefined) {
        let paired = false
        for (let i = candidates.length - 1; i >= 0; i--) {
          const candidate = candidates[i]!
          if (candidate.resultText !== undefined || candidate.status === 'running') continue
          candidate.status = isError ? 'error' : 'done'
          candidate.isError = isError
          if (resultText !== '') candidate.resultText = resultText
          if (presentationMeta !== undefined) candidate.presentationMeta = presentationMeta
          if (durationMs !== undefined) {
            candidate.durationMs = durationMs
            if (candidate.startedAt !== undefined) {
              advanceTurnSettledAt(acc, candidate.startedAt + durationMs)
            }
          }
          candidate.artifactRef = detectArtifactRef(candidate.resultText)
          if (truncation !== undefined) {
            candidate.resultTruncation = truncation
            candidate.resultEntryId = entry.id
          }
          paired = true
          break
        }
        if (paired) continue
      }
    }
    const key = `tool:${callId ?? `${entry.id}:${mi}`}`
    const tool = makeToolTrace(key, toolName, {
      callId,
      status: isError ? 'error' : 'done',
      isError,
      ...(resultText !== '' ? { resultText } : {}),
      ...(truncation !== undefined ? { resultTruncation: truncation, resultEntryId: entry.id } : {}),
      ...(presentationMeta !== undefined ? { presentationMeta } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      toolViewByName,
    })
    tool.artifactRef = detectArtifactRef(tool.resultText)
    acc.segments.push({ kind: 'tool', key, tool })
    registerTurnTool(acc, tool)
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

/**
 * Main timeline normalization function.
 * Input contract: entries are in chronological order (old -> new, guaranteed by getConversationDetail).
 */
export function buildTimelineItems(
  entries: ReadonlyArray<ConversationEntry>,
  options: BuildTimelineOptions = {},
): TimelineItem[] {
  const activeEntries = filterRewoundEntries(entries)
  const sortedRenderers =
    options.timelineRenderers !== undefined && options.timelineRenderers.length > 0
      ? sortByPriorityDescStable(options.timelineRenderers)
      : undefined
  const toolViewByName = buildToolViewIndex(options.toolViews)
  const items: TimelineItem[] = []
  const seenInputIds = new Set<string>()
  let turn: TurnAcc | null = null
  let lastHumanInputText: string | undefined

  const pushHuman = (entry: ConversationEntry, data: HelmxInputData, fallback: boolean): void => {
    flushTurn(turn, items, false)
    turn = null
    const createdAt =
      typeof data.createdAt === 'number' && Number.isFinite(data.createdAt) && data.createdAt > 0
        ? data.createdAt
        : typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) && entry.createdAt > 0
          ? entry.createdAt
          : undefined
    items.push({
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
    })
  }

  for (const entry of activeEntries) {
    const renderer = matchSortedTimelineRenderer(entry, sortedRenderers)
    if (renderer !== undefined) {
      if (entry.kind === 'helmx.input') {
        const data = parseHelmxInputData(entry.data)
        if (data !== undefined) {
          lastHumanInputText = data.text
          if (data.id !== undefined) seenInputIds.add(data.id)
        }
      }
      flushTurn(turn, items, false)
      turn = null
      items.push({ kind: 'plugin-card', key: `card:${entry.id}`, entryId: entry.id, entry, renderer })
      continue
    }

    switch (entry.kind) {
      case 'helmx.input': {
        const data = parseHelmxInputData(entry.data)
        if (data === undefined) break
        lastHumanInputText = data.text
        if (data.id !== undefined) seenInputIds.add(data.id)
        pushHuman(entry, data, false)
        break
      }
      case 'pi.user': {
        const text = extractUserMessageText(entry)
        if (text === '') break
        if (lastHumanInputText !== undefined && lastHumanInputText === text) break
        lastHumanInputText = text
        pushHuman(entry, { text, origin: 'human' }, true)
        break
      }
      case 'pi.assistant': {
        const modelIdentity = parseAssistantModelIdentity(entry)
        if (
          turn !== null &&
          turn.modelLocked === true &&
          turn.modelReference !== undefined &&
          modelIdentity !== undefined &&
          !sameAssistantModelIdentity(modelIdentity, turn.modelReference)
        ) {
          flushTurn(turn, items, false)
          turn = newTurn()
        }
        if (turn === null) turn = newTurn()
        appendAssistantEntry(turn, entry, toolViewByName, modelIdentity)
        break
      }
      case 'pi.tool-result': {
        if (turn === null) turn = newTurn()
        appendToolResultEntry(turn, entry, toolViewByName)
        break
      }
      case 'pi.reset': {
        const dataText = isStringRecord(entry.data) && typeof entry.data.handoff === 'string' ? entry.data.handoff : undefined
        const handoff = dataText !== undefined && dataText !== '' ? dataText : extractUserMessageText(entry)
        flushTurn(turn, items, false)
        turn = null
        lastHumanInputText = undefined
        items.push({
          kind: 'divider',
          key: `divider:${entry.id}`,
          entryId: entry.id,
          divider: 'reset',
          ...(handoff !== '' ? { handoff } : {}),
        })
        break
      }
      case 'pi.compaction': {
        const summary = extractUserMessageText(entry)
        flushTurn(turn, items, false)
        turn = null
        lastHumanInputText = undefined
        items.push({
          kind: 'divider',
          key: `divider:${entry.id}`,
          entryId: entry.id,
          divider: 'compaction',
          ...(summary !== '' ? { summary } : {}),
        })
        break
      }
      case 'pi.system':
      default:
        break
    }
  }

  const isLive = options.working ?? (options.live !== undefined)
  if (options.live !== undefined) {
    if (turn === null) turn = newTurn()
    mergeLiveIntoTurn(turn, options.live, toolViewByName)
  }
  flushTurn(turn, items, isLive)

  if (options.compacting === true) {
    items.push({
      kind: 'divider',
      key: 'divider:compacting',
      entryId: 'compacting:live',
      divider: 'compaction',
      pending: true,
    })
  }

  for (const q of options.live?.queuedInputs ?? []) {
    if (typeof q?.id !== 'string' || q.id === '' || typeof q.text !== 'string') continue
    if (q.mode !== 'steer' && q.mode !== 'followUp') continue
    if (seenInputIds.has(q.id)) continue
    seenInputIds.add(q.id)
    items.push({
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
  return items
}
