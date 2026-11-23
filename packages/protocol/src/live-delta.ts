/**
 * Pure LCP (longest-common-prefix) delta codec and structural comparator for `ConversationLive`.
 *
 * Shared by `@helmx/kernel` (`EventHub` transient SSE encoding & `ConversationTracker` deduplication)
 * and `@helmx/web` (`live-state` SSE frame application). Zero runtime dependencies, browser-safe.
 *
 * Design invariants:
 * - Redaction runs on the full `ConversationLive` BEFORE diffing so secrets spanning chunk boundaries
 *   are safely replaced (the LCP prefix naturally steps back across the redacted tail and overwrites it);
 * - Every delta carries `(baseRev, rev)` validated strictly against the receiver's current `ConversationLive.rev`;
 *   any revision/bounds mismatch throws explicitly so the SSE client performs a clean full re-sync.
 */

import type { ConversationLive, ConversationLiveGeneration, ConversationLiveMessage } from './conversation.js'

/** Longest-common-prefix string patch: keep `prefix` leading UTF-16 code units from previous string and append `append`. */
export type TextPrefixPatch = readonly [prefix: number, append: string]

/** Block-level incremental patch for `ConversationLiveMessage.content`. */
export type LiveContentBlockPatch =
  | { readonly op: 'same' }
  | { readonly op: 'text'; readonly patch: TextPrefixPatch }
  | { readonly op: 'thinking'; readonly patch: TextPrefixPatch }
  | { readonly op: 'replace'; readonly block: ConversationLiveMessage['content'][number] }

/** Generation field update inside a `ConversationLiveDelta`. */
export type LiveGenerationDelta =
  | null
  | { readonly mode: 'replace'; readonly value: ConversationLiveGeneration }
  | {
      readonly mode: 'patch'
      readonly taskId: number
      readonly attempt: number
      /** Block patches aligned 1:1 with the resulting `message.content`; `null` clears `message`; omitted keeps existing `content`. */
      readonly blocks?: ReadonlyArray<LiveContentBlockPatch> | null
      /** Updated provider cumulative output usage; `null` clears `usage`; omitted keeps existing `usage`. */
      readonly usage?: { output: number } | null
    }

/** Incremental transient live patch (`event: conversation.live.delta`). */
export interface ConversationLiveDelta {
  conversationId: number
  /** Server-assigned monotonic per-conversation live revision this patch applies onto. */
  baseRev: number
  /** New revision after applying this patch (strictly greater than `baseRev`). */
  rev: number
  updatedAt: number
  /** LCP patch for `live.text` (omitted when unchanged). */
  text?: TextPrefixPatch
  /** LCP patch for `live.thinking` (`null` clears; omitted when unchanged). */
  thinking?: TextPrefixPatch | null
  /** Full replacement for `live.tools` (omitted when unchanged). */
  tools?: ConversationLive['tools']
  /** Full replacement for `live.queuedInputs` (`null` clears; omitted when unchanged). */
  queuedInputs?: ConversationLive['queuedInputs'] | null
  /** Incremental patch or full replacement for `live.generation` (`null` clears; omitted when unchanged). */
  generation?: LiveGenerationDelta
}

/** Structural JSON value equality (zero serialization allocations). */
function sameJsonLike(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (!sameJsonLike(a[i], b[i])) return false
    }
    return true
  }
  const recA = a as Record<string, unknown>
  const recB = b as Record<string, unknown>
  const keysA = Object.keys(recA)
  let countA = 0
  for (const k of keysA) {
    const va = recA[k]
    if (va === undefined) continue
    countA += 1
    if (!Object.hasOwn(recB, k) || recB[k] === undefined || !sameJsonLike(va, recB[k])) return false
  }
  let countB = 0
  for (const k of Object.keys(recB)) {
    if (recB[k] !== undefined) countB += 1
  }
  return countA === countB
}

/** Structural equality for `ConversationLive['queuedInputs']` (treats `undefined` and `[]` as equivalent). */
export function sameQueuedInputs(
  a: ConversationLive['queuedInputs'],
  b: ConversationLive['queuedInputs'],
): boolean {
  const listA = a ?? []
  const listB = b ?? []
  if (listA.length === 0 && listB.length === 0) return true
  return sameJsonLike(listA, listB)
}

function sameGeneration(
  a: ConversationLiveGeneration | undefined,
  b: ConversationLiveGeneration | undefined,
): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  if (a.taskId !== b.taskId || a.attempt !== b.attempt) return false
  const msgA = a.message
  const msgB = b.message
  if (msgA === msgB) return true
  if (msgA === undefined || msgB === undefined) return false
  if (msgA.usage?.output !== msgB.usage?.output) return false
  if (msgA.content.length !== msgB.content.length) return false
  for (let i = 0; i < msgA.content.length; i += 1) {
    const ba = msgA.content[i]!
    const bb = msgB.content[i]!
    if (ba === bb) continue
    if (ba.type !== bb.type) return false
    if (ba.type === 'text' && bb.type === 'text') {
      if (ba.text !== bb.text) return false
    } else if (ba.type === 'thinking' && bb.type === 'thinking') {
      if (ba.thinking !== bb.thinking) return false
    } else if (ba.type === 'toolCall' && bb.type === 'toolCall') {
      if (ba.name !== bb.name || !sameJsonLike(ba.arguments, bb.arguments)) return false
    } else {
      return false
    }
  }
  return true
}

/**
 * Structural content equality for two `ConversationLive` snapshots (ignores `updatedAt` and `rev`).
 * Avoids `JSON.stringify` allocations on every streaming tick: string length differences short-circuit in O(1).
 */
export function sameConversationLiveContent(a: ConversationLive, b: ConversationLive): boolean {
  if (a === b) return true
  if (a.conversationId !== b.conversationId) return false
  if (a.text !== b.text) return false
  if ((a.thinking ?? '') !== (b.thinking ?? '')) return false
  if (!sameGeneration(a.generation, b.generation)) return false
  if (!sameJsonLike(a.tools, b.tools)) return false
  if (!sameQueuedInputs(a.queuedInputs, b.queuedInputs)) return false
  return true
}

/** Compute an LCP prefix patch transforming `prev` into `next`. */
export function diffTextPrefix(prev: string, next: string): TextPrefixPatch {
  if (prev.length === 0) return [0, next]
  if (next.length >= prev.length && next.startsWith(prev)) {
    return [prev.length, next.slice(prev.length)]
  }
  const limit = Math.min(prev.length, next.length)
  let prefix = 0
  while (prefix < limit && prev.charCodeAt(prefix) === next.charCodeAt(prefix)) {
    prefix += 1
  }
  return [prefix, next.slice(prefix)]
}

/** Validate and apply an LCP prefix patch onto `prev`. Throws on malformed or out-of-range patches. */
export function applyTextPrefix(prev: string, patch: unknown, field: string): string {
  if (!Array.isArray(patch) || patch.length !== 2) {
    throw new Error(`Invalid conversation.live.delta ${field} patch format`)
  }
  const [prefix, append] = patch as [unknown, unknown]
  if (
    typeof prefix !== 'number' ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > prev.length ||
    typeof append !== 'string'
  ) {
    throw new Error(`Invalid conversation.live.delta ${field} patch bounds`)
  }
  if (prefix === prev.length) return append === '' ? prev : prev + append
  return prev.slice(0, prefix) + append
}

function diffGeneration(
  prev: ConversationLiveGeneration | undefined,
  next: ConversationLiveGeneration | undefined,
): LiveGenerationDelta | undefined {
  if (next === undefined) {
    return prev === undefined ? undefined : null
  }
  if (prev === undefined || prev.taskId !== next.taskId || prev.attempt !== next.attempt) {
    return { mode: 'replace', value: next }
  }
  const prevMsg = prev.message
  const nextMsg = next.message
  if (nextMsg === undefined) {
    return prevMsg === undefined ? undefined : { mode: 'patch', taskId: next.taskId, attempt: next.attempt, blocks: null }
  }
  const prevBlocks = prevMsg?.content ?? []
  const nextBlocks = nextMsg.content
  const patches: LiveContentBlockPatch[] = new Array(nextBlocks.length)
  let blocksChanged = prevMsg === undefined || prevBlocks.length !== nextBlocks.length
  for (let i = 0; i < nextBlocks.length; i += 1) {
    const nb = nextBlocks[i]!
    const pb = prevBlocks[i]
    if (pb !== undefined && pb.type === nb.type) {
      if (nb.type === 'text' && pb.type === 'text') {
        if (pb.text === nb.text) {
          patches[i] = { op: 'same' }
        } else {
          blocksChanged = true
          patches[i] = { op: 'text', patch: diffTextPrefix(pb.text, nb.text) }
        }
        continue
      }
      if (nb.type === 'thinking' && pb.type === 'thinking') {
        if (pb.thinking === nb.thinking) {
          patches[i] = { op: 'same' }
        } else {
          blocksChanged = true
          patches[i] = { op: 'thinking', patch: diffTextPrefix(pb.thinking, nb.thinking) }
        }
        continue
      }
      if (nb.type === 'toolCall' && pb.type === 'toolCall') {
        if (pb.name === nb.name && sameJsonLike(pb.arguments, nb.arguments)) {
          patches[i] = { op: 'same' }
        } else {
          blocksChanged = true
          patches[i] = { op: 'replace', block: nb }
        }
        continue
      }
    }
    blocksChanged = true
    patches[i] = { op: 'replace', block: nb }
  }
  const prevOutput = prevMsg?.usage?.output
  const nextOutput = nextMsg.usage?.output
  const usageChanged = prevOutput !== nextOutput
  if (!blocksChanged && !usageChanged) return undefined
  return {
    mode: 'patch',
    taskId: next.taskId,
    attempt: next.attempt,
    ...(blocksChanged ? { blocks: patches } : {}),
    ...(usageChanged ? { usage: nextMsg.usage ?? null } : {}),
  }
}

/** Build a compact LCP delta transforming `prev` (at `baseRev`) into `next` (at `rev`). */
export function diffConversationLive(
  prev: ConversationLive,
  next: ConversationLive,
  baseRev: number,
  rev: number,
): ConversationLiveDelta {
  const delta: ConversationLiveDelta = {
    conversationId: next.conversationId,
    baseRev,
    rev,
    updatedAt: next.updatedAt,
  }
  if (next.text !== prev.text) {
    delta.text = diffTextPrefix(prev.text, next.text)
  }
  if (next.thinking === undefined) {
    if (prev.thinking !== undefined) delta.thinking = null
  } else if (next.thinking !== prev.thinking) {
    delta.thinking = diffTextPrefix(prev.thinking ?? '', next.thinking)
  }
  if (!sameJsonLike(prev.tools, next.tools)) {
    delta.tools = next.tools
  }
  if (next.queuedInputs === undefined) {
    if (prev.queuedInputs !== undefined) delta.queuedInputs = null
  } else if (!sameJsonLike(prev.queuedInputs, next.queuedInputs)) {
    delta.queuedInputs = next.queuedInputs
  }
  const genDelta = diffGeneration(prev.generation, next.generation)
  if (genDelta !== undefined) {
    delta.generation = genDelta
  }
  return delta
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function isValidContentBlock(block: unknown): block is ConversationLiveMessage['content'][number] {
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return false
  const b = block as Record<string, unknown>
  if (b['type'] === 'text') return typeof b['text'] === 'string'
  if (b['type'] === 'thinking') return typeof b['thinking'] === 'string'
  if (b['type'] === 'toolCall') return typeof b['name'] === 'string'
  return false
}

function applyGenerationDelta(
  prev: ConversationLiveGeneration | undefined,
  genDelta: LiveGenerationDelta,
): ConversationLiveGeneration | undefined {
  if (genDelta === null) return undefined
  if (genDelta === undefined || typeof genDelta !== 'object' || Array.isArray(genDelta)) {
    throw new Error('Invalid conversation.live.delta generation format')
  }
  if (genDelta.mode === 'replace') {
    const val = genDelta.value
    if (
      val === null ||
      typeof val !== 'object' ||
      !isPositiveSafeInt(val.taskId) ||
      !isPositiveSafeInt(val.attempt)
    ) {
      throw new Error('Invalid conversation.live.delta generation replace value')
    }
    return val
  }
  if (genDelta.mode !== 'patch') {
    throw new Error('Invalid conversation.live.delta generation mode')
  }
  if (
    prev === undefined ||
    !isPositiveSafeInt(genDelta.taskId) ||
    !isPositiveSafeInt(genDelta.attempt) ||
    prev.taskId !== genDelta.taskId ||
    prev.attempt !== genDelta.attempt
  ) {
    throw new Error('Invalid conversation.live.delta generation patch baseline')
  }
  if (genDelta.blocks === null) {
    return { taskId: genDelta.taskId, attempt: genDelta.attempt }
  }
  const prevBlocks = prev.message?.content ?? []
  let content: ConversationLiveMessage['content']
  if (genDelta.blocks === undefined) {
    if (prev.message === undefined) {
      throw new Error('Invalid conversation.live.delta generation patch missing message baseline')
    }
    content = prevBlocks
  } else {
    if (!Array.isArray(genDelta.blocks)) {
      throw new Error('Invalid conversation.live.delta generation blocks format')
    }
    content = genDelta.blocks.map((patch, index): ConversationLiveMessage['content'][number] => {
      if (patch === null || typeof patch !== 'object') {
        throw new Error(`Invalid conversation.live.delta block[${index}]`)
      }
      if (patch.op === 'same') {
        const existing = prevBlocks[index]
        if (existing === undefined) {
          throw new Error(`Invalid conversation.live.delta block[${index}] same reference out of range`)
        }
        return existing
      }
      if (patch.op === 'text') {
        const existing = prevBlocks[index]
        if (existing === undefined || existing.type !== 'text') {
          throw new Error(`Invalid conversation.live.delta block[${index}] text baseline mismatch`)
        }
        return { type: 'text', text: applyTextPrefix(existing.text, patch.patch, `generation.blocks[${index}].text`) }
      }
      if (patch.op === 'thinking') {
        const existing = prevBlocks[index]
        if (existing === undefined || existing.type !== 'thinking') {
          throw new Error(`Invalid conversation.live.delta block[${index}] thinking baseline mismatch`)
        }
        return {
          type: 'thinking',
          thinking: applyTextPrefix(existing.thinking, patch.patch, `generation.blocks[${index}].thinking`),
        }
      }
      if (patch.op === 'replace') {
        if (!isValidContentBlock(patch.block)) {
          throw new Error(`Invalid conversation.live.delta block[${index}] replace payload`)
        }
        return patch.block
      }
      throw new Error(`Invalid conversation.live.delta block[${index}] op`)
    })
  }
  let usage: { output: number } | undefined
  if (genDelta.usage === undefined) {
    usage = prev.message?.usage
  } else if (genDelta.usage === null) {
    usage = undefined
  } else {
    if (
      typeof genDelta.usage !== 'object' ||
      typeof genDelta.usage.output !== 'number' ||
      !Number.isFinite(genDelta.usage.output) ||
      genDelta.usage.output <= 0
    ) {
      throw new Error('Invalid conversation.live.delta generation usage')
    }
    usage = { output: genDelta.usage.output }
  }
  return {
    taskId: genDelta.taskId,
    attempt: genDelta.attempt,
    message: {
      content,
      ...(usage !== undefined ? { usage } : {}),
    },
  }
}

/**
 * Strictly validate and apply a `ConversationLiveDelta` onto `prev`.
 * Throws explicitly on malformed payloads or `baseRev` mismatch (triggering clean SSE resync).
 */
export function applyConversationLiveDelta(
  prev: ConversationLive | undefined,
  delta: unknown,
): ConversationLive {
  if (delta === null || typeof delta !== 'object' || Array.isArray(delta)) {
    throw new Error('Invalid transient conversation.live.delta frame format')
  }
  const d = delta as ConversationLiveDelta
  if (
    !isPositiveSafeInt(d.conversationId) ||
    !isPositiveSafeInt(d.baseRev) ||
    !isPositiveSafeInt(d.rev) ||
    d.rev <= d.baseRev ||
    typeof d.updatedAt !== 'number' ||
    !Number.isFinite(d.updatedAt)
  ) {
    throw new Error('Invalid transient conversation.live.delta metadata')
  }
  if (prev === undefined || prev.conversationId !== d.conversationId || prev.rev !== d.baseRev) {
    throw new Error('Transient conversation.live.delta revision mismatch; re-syncing')
  }
  const text = d.text !== undefined ? applyTextPrefix(prev.text, d.text, 'text') : prev.text
  let thinking = prev.thinking
  if (d.thinking === null) {
    thinking = undefined
  } else if (d.thinking !== undefined) {
    thinking = applyTextPrefix(prev.thinking ?? '', d.thinking, 'thinking')
  }
  let tools = prev.tools
  if (d.tools !== undefined) {
    if (!Array.isArray(d.tools)) throw new Error('Invalid conversation.live.delta tools format')
    tools = d.tools
  }
  let queuedInputs = prev.queuedInputs
  if (d.queuedInputs === null) {
    queuedInputs = undefined
  } else if (d.queuedInputs !== undefined) {
    if (!Array.isArray(d.queuedInputs)) throw new Error('Invalid conversation.live.delta queuedInputs format')
    queuedInputs = d.queuedInputs
  }
  const generation =
    d.generation !== undefined ? applyGenerationDelta(prev.generation, d.generation) : prev.generation
  return {
    conversationId: d.conversationId,
    text,
    ...(thinking !== undefined ? { thinking } : {}),
    tools,
    ...(generation !== undefined ? { generation } : {}),
    ...(queuedInputs !== undefined ? { queuedInputs } : {}),
    updatedAt: d.updatedAt,
    rev: d.rev,
  }
}
