/** builtin:token-speed public contracts, constants, and boundary event guards. */
import { isJsonObject, type ConversationLiveMessage } from '@helmx/protocol/browser'
import { asConversationEntryEvent } from '../shared-helpers.js'

export const TOKEN_SPEED_PLUGIN_ID = 'builtin:token-speed'
export const TOKEN_SPEED_DOC = 'speed'
export const DEFAULT_SLIDING_WINDOW_MS = 1000
export const MIN_SLIDING_WINDOW_MS = 100
export const MAX_SLIDING_WINDOW_MS = 30_000
export const DOC_WRITE_INTERVAL_MS = 120
export const CONTEXT_INVALIDATION_ENTRY_KINDS: ReadonlySet<string> = new Set(['pi.reset', 'pi.compaction', 'helmx.rewind'])

export type TokenSpeedSource = 'provider' | 'estimate' | 'mixed'
export interface TokenSpeedStatus {
  phase: 'decoding' | 'tools' | 'settled'
  tps?: number
  outputTokens: number
  decodeMs: number
  source: TokenSpeedSource
  ttftMs?: number
  windowMs: number
  updatedAt: number
}

const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

export function contentCharsOfBlocks(content: readonly unknown[]): number {
  let chars = 0
  for (const b of content) {
    if (!isJsonObject(b)) continue
    if (b.type === 'text' && typeof b.text === 'string') chars += b.text.length
    else if (b.type === 'thinking' && typeof b.thinking === 'string') chars += b.thinking.length
    else if (b.type === 'toolCall' && typeof b.name === 'string') {
      chars += b.name.length
      if (b.arguments !== undefined) {
        try { const s = JSON.stringify(b.arguments); if (typeof s === 'string') chars += s.length } catch { /* skip non-JSON */ }
      }
    }
  }
  return chars
}

export function asConversationLiveFrame(payload: unknown): {
  conversationId: number
  generation?: { taskId: number; attempt: number; message?: ConversationLiveMessage }
  hasTools: boolean
  updatedAt: number
} | undefined {
  if (!isJsonObject(payload) || payload.type !== 'conversation.live' || !isJsonObject(payload.live)) return undefined
  const live = payload.live
  if (!isPositiveInt(live.conversationId) || typeof live.updatedAt !== 'number' || !Number.isFinite(live.updatedAt) || live.updatedAt < 0) return undefined
  const hasTools = Array.isArray(live.tools) && live.tools.length > 0
  const gen = live.generation
  if (gen === undefined) return { conversationId: live.conversationId, hasTools, updatedAt: live.updatedAt }
  if (!isJsonObject(gen) || !isPositiveInt(gen.taskId) || !isPositiveInt(gen.attempt)) return undefined
  const msg = gen.message
  if (msg === undefined) return { conversationId: live.conversationId, generation: { taskId: gen.taskId, attempt: gen.attempt }, hasTools, updatedAt: live.updatedAt }
  if (!isJsonObject(msg) || !Array.isArray(msg.content)) return undefined
  if (msg.usage !== undefined && (!isJsonObject(msg.usage) || typeof msg.usage.output !== 'number')) return undefined
  return {
    conversationId: live.conversationId,
    generation: { taskId: gen.taskId, attempt: gen.attempt, message: msg as unknown as ConversationLiveMessage },
    hasTools,
    updatedAt: live.updatedAt,
  }
}

export function asAssistantCompletion(payload: unknown): {
  conversationId: number
  taskId: number | undefined
  entryId: string | undefined
  usageOutput: number | undefined
  stopReason: string
  contentChars?: number
} | undefined {
  const env = asConversationEntryEvent(payload)
  if (!env || env.kind !== 'pi.assistant') return undefined
  const entry = (payload as Record<string, unknown>).entry as Record<string, unknown>
  const model = entry.model
  if (!Array.isArray(model) || !isJsonObject(model[0])) return undefined
  const first = model[0]
  if (first.role !== 'assistant' || typeof first.stopReason !== 'string' || !first.stopReason) return undefined
  const output = isJsonObject(first.usage) ? first.usage.output : undefined
  const usageOutput = typeof output === 'number' && Number.isFinite(output) && output > 0 ? output : undefined
  const contentChars = Array.isArray(first.content) ? contentCharsOfBlocks(first.content) : undefined
  return {
    conversationId: env.conversationId,
    taskId: isPositiveInt(entry.taskId) ? entry.taskId : undefined,
    entryId: typeof entry.id === 'string' ? entry.id : undefined,
    usageOutput,
    stopReason: first.stopReason,
    ...(contentChars !== undefined ? { contentChars } : {}),
  }
}
