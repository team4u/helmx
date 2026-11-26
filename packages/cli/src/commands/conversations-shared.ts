/**
 * Shared display helpers and flags for conversation commands and SSE watchers.
 */
import { isPlainObject, type ConversationStatus, type ConversationSummary } from '@helmx/protocol'
import { type FlagSpec } from '../args.js'
import { resolveDisplayString } from '../output.js'
import { formatConversationTiming, projectConversationForHuman } from '../timing.js'
import type { CommandContext } from './shared.js'
import { printResult } from './shared.js'

export const convFlags: FlagSpec[] = [
  { name: 'current', type: 'boolean', help: 'use HELMX_CONVERSATION_ID from environment' },
]

/** Turn-terminal statuses for `conversations watch`: blocked keeps waiting (an Ask may still resolve it). */
export const WATCH_SETTLED_STATUSES = new Set<ConversationStatus>(['done', 'idle', 'error'])

/**
 * Render a single conversation summary/detail object: `--json` emits raw server fields untouched
 * (preserving `runDurationMs`, `runStartedAt`, `pendingAskSince`); human mode synthesizes a clean
 * `timing` field when timing data exists and omits raw epoch/ms fields.
 */
export function printConversationRecord(ctx: CommandContext, value: unknown): void {
  if (ctx.json || value === null || typeof value !== 'object' || Array.isArray(value)) {
    printResult(ctx, value)
    return
  }
  printResult(ctx, projectConversationForHuman(value as Record<string, unknown>, Date.now()))
}

/** Local wall-clock time as HH:MM:SS (display-only progress prefix). */
export function clock(date: Date): string {
  return date.toTimeString().slice(0, 8)
}

/** Single-line human-readable summary of an incremental SSE event. */
export function summarizeEvent(payload: unknown): string {
  if (!isPlainObject(payload)) return JSON.stringify(payload)
  const seq = typeof payload['seq'] === 'number' ? payload['seq'] : '?'
  const event = payload['event']
  if (!isPlainObject(event) || typeof event['type'] !== 'string') {
    return `${seq}  ${JSON.stringify(payload)}`
  }
  let extra = ''
  switch (event['type']) {
    case 'conversation.upsert': {
      const c = isPlainObject(event['conversation'])
        ? (event['conversation'] as Partial<ConversationSummary>)
        : undefined
      const timing = c ? formatConversationTiming(c, Date.now()) : ''
      extra = `#${c?.id ?? '?'} ${c?.title ?? ''} (${c?.status ?? '?'})${timing ? ` — ${timing}` : ''}`
      break
    }
    case 'conversation.deleted':
      extra = `#${String(event['conversationId'] ?? '?')}`
      break
    case 'ask.upsert': {
      const a = isPlainObject(event['ask']) ? event['ask'] : undefined
      extra = `${String(a?.['id'] ?? '?')} ${resolveDisplayString(a?.['title'] ?? '')}`
      break
    }
    case 'ask.resolved':
      extra = `${String(event['askId'] ?? '?')} -> ${String(event['status'] ?? '?')}`
      break
    case 'plugin.changed': {
      const p = isPlainObject(event['plugin']) ? event['plugin'] : undefined
      extra = String(p?.['id'] ?? '?')
      break
    }
    case 'notification':
      extra = String(event['title'] ?? '')
      break
    default:
      extra = JSON.stringify(event)
  }
  return `${seq}  ${event['type']}  ${extra}`
}
