/**
 * Render item, trace, and options types for the timeline model.
 */
import type {
  ConversationAttachmentRef,
  ConversationEntry,
  ConversationLive,
  InputOrigin,
  TimelineRendererSpec,
  ToolResultTruncation,
  ToolViewSpec,
  WhenBusy,
} from '@helmx/protocol/browser'

export type { ToolResultTruncation }

export interface QualifiedRenderer {
  pluginId: string
  spec: TimelineRendererSpec
}

export interface QualifiedToolView {
  pluginId: string
  spec: ToolViewSpec
}

export interface HelmxInputData {
  id?: string
  text: string
  origin: InputOrigin
  whenBusy?: WhenBusy
  createdAt?: number
  meta?: Record<string, unknown>
  attachments?: ConversationAttachmentRef[]
}

export type ToolTraceStatus = 'running' | 'done' | 'error' | 'unknown'

export interface ToolTrace {
  key: string
  toolName: string
  callId?: string
  input?: unknown
  status: ToolTraceStatus
  isError: boolean
  resultText?: string
  /** Server preview truncation marker; omitted when not truncated or for live results. */
  resultTruncation?: ToolResultTruncation
  /** entry id of the pi.tool-result carrying this result (precise key for on-demand full-text fetch when truncated). */
  resultEntryId?: string
  /** Time of the persisted entry holding the tool call; omitted while a streaming call has no record yet. */
  startedAt?: number
  durationMs?: number
  /** Artifact reference detected in the output (kernel Spill marker / art_ prefix), feeding the "open full artifact" button. */
  artifactRef?: string
  /** Persisted bounded UI presentation metadata (toolResult message details channel; plain object only); omitted otherwise. */
  presentationMeta?: Readonly<Record<string, unknown>>
  /** Matched a plugin tool.view (e.g. dispatch_worker): exempt from folding, renders a business card. */
  toolView?: QualifiedToolView
}

export interface ThinkingTrace {
  key: string
  text: string
  active?: boolean
  /** Provenance of a streaming thinking block ('generation' | 'flat'); persisted blocks carry neither. */
  live?: 'generation' | 'flat'
  /** Eligible model-response duration (ms) of the assistant message that produced this thinking block. */
  responseDurationMs?: number
}

export type FoldableStep =
  | { kind: 'thinking'; thinking: ThinkingTrace }
  | { kind: 'tool'; tool: ToolTrace }

export type AssistantSegment =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'step-group'; key: string; stepCount: number; steps: FoldableStep[]; active?: boolean }
  | { kind: 'tool'; key: string; tool: ToolTrace }

export interface AssistantModelIdentity {
  provider: string
  model: string
  /** Requested thinking level (off/minimal/low/medium/high/xhigh/max); omitted for legacy or inconsistent data. */
  thinkingLevel?: string
}

export interface AssistantTurn {
  kind: 'assistant'
  key: string
  /** All entry ids involved in this turn (hover fork uses the last one). */
  entryIds: string[]
  segments: AssistantSegment[]
  /** true = in-flight turn merged with ConversationLive. */
  live: boolean
  model?: AssistantModelIdentity
  startedAt?: number
  settledAt?: number
  durationMs?: number
  modelDurationMs?: number
  toolDurationMs?: number
}

export interface HumanInputItem {
  kind: 'human'
  key: string
  entryId: string
  text: string
  origin: InputOrigin
  meta?: Record<string, unknown>
  attachments?: ConversationAttachmentRef[]
  inputId?: string
  queuedMode?: 'steer' | 'followUp'
  fallback: boolean
  createdAt?: number
}

export interface DividerItem {
  kind: 'divider'
  key: string
  entryId: string
  divider: 'reset' | 'compaction'
  pending?: boolean
  handoff?: string
  summary?: string
}

export interface PluginCardItem {
  kind: 'plugin-card'
  key: string
  entryId: string
  entry: ConversationEntry
  renderer: QualifiedRenderer
}

export type TimelineItem = HumanInputItem | DividerItem | PluginCardItem | AssistantTurn

export interface EditRequestTarget {
  text: string
  entryId?: number
  attachments?: ConversationAttachmentRef[]
}

export interface BuildTimelineOptions {
  live?: ConversationLive
  working?: boolean
  compacting?: boolean
  timelineRenderers?: ReadonlyArray<QualifiedRenderer>
  toolViews?: ReadonlyArray<QualifiedToolView>
}

export interface QueuedAgentTextCollapse {
  collapsed: boolean
  preview: string
}

export interface AssistantTurnBusyOptions {
  isLatestTurn?: boolean
  activeToolCallIds?: ReadonlySet<string>
}
