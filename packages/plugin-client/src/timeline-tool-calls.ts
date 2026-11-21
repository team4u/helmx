/**
 * Per-timeline sharded external store and hook for lightweight tool call summaries
 * (Fast Refresh friendly: Context + store factory + hook only, no components).
 *
 * Host wiring point: ConversationTimeline wraps its timeline body in
 * `<TimelineToolCallsContext.Provider value={store}>` using a single stable
 * `createTimelineToolCallsStore()` instance fed from its already-computed
 * timeline items (no second state ledger in HelmxExternalStore / PluginClientHostPort).
 * Outside the Provider (e.g. standalone SSR, workbench drawers, or isolated
 * tests), `useTimelineToolCalls(toolName)` returns a shared frozen empty array.
 */
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import type { TimelineToolCallStatus, TimelineToolCallSummary } from '@helmx/protocol/browser'

export interface TimelineToolCallsStore {
  /** Subscribe to changes for one `toolName` shard; unrelated `toolName` updates must not notify `listener`. */
  subscribe(toolName: string, listener: () => void): () => void
  /** Current chronological summaries for `toolName` (referentially stable when unchanged; never undefined). */
  getSnapshot(toolName: string): ReadonlyArray<TimelineToolCallSummary>
}

export type TimelineToolCallsInput =
  | ReadonlyMap<string, ReadonlyArray<TimelineToolCallSummary>>
  | ReadonlyArray<TimelineToolCallSummary>

export interface TimelineToolCallsStoreController extends TimelineToolCallsStore {
  /**
   * Atomically reconcile all `toolName` shards with the timeline's latest
   * derived summaries. Validates all entries before committing; preserves array
   * references and suppresses notifications for unchanged `toolName` shards.
   * Returns true if at least one shard changed.
   */
  update(next: TimelineToolCallsInput): boolean
}

const EMPTY_TIMELINE_TOOL_CALLS: ReadonlyArray<TimelineToolCallSummary> = Object.freeze([])
const NOOP_UNSUBSCRIBE = (): void => {}
const FORBIDDEN_BULKY_KEYS = ['result', 'resultText', 'resultTruncation', 'structuredOutput'] as const

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isValidStatus(value: unknown): value is TimelineToolCallStatus {
  return value === 'running' || value === 'done' || value === 'error'
}

function normalizeSummary(raw: unknown, expectedToolName?: string): TimelineToolCallSummary {
  if (!isPlainRecord(raw)) {
    throw new TypeError('TimelineToolCallSummary must be a plain object')
  }
  for (const key of FORBIDDEN_BULKY_KEYS) {
    if (Object.hasOwn(raw, key) && raw[key] !== undefined) {
      throw new TypeError(`TimelineToolCallSummary must not carry bulky field "${key}"`)
    }
  }
  const callId = raw['callId']
  if (typeof callId !== 'string' || callId === '') {
    throw new TypeError('TimelineToolCallSummary.callId must be a non-empty string')
  }
  const toolName = raw['toolName']
  if (typeof toolName !== 'string' || toolName === '') {
    throw new TypeError('TimelineToolCallSummary.toolName must be a non-empty string')
  }
  if (expectedToolName !== undefined && toolName !== expectedToolName) {
    throw new TypeError(`TimelineToolCallSummary.toolName "${toolName}" does not match shard key "${expectedToolName}"`)
  }
  const index = raw['index']
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    throw new TypeError('TimelineToolCallSummary.index must be a non-negative safe integer')
  }
  const status = raw['status']
  if (!isValidStatus(status)) {
    throw new TypeError('TimelineToolCallSummary.status must be "running", "done", or "error"')
  }
  const input = raw['input']
  const presentationMeta = raw['presentationMeta']
  if (presentationMeta !== undefined && !isPlainRecord(presentationMeta)) {
    throw new TypeError('TimelineToolCallSummary.presentationMeta must be a plain object when provided')
  }
  const normalized: TimelineToolCallSummary = {
    callId,
    toolName,
    index,
    status,
    ...(input !== undefined ? { input } : {}),
    ...(presentationMeta !== undefined ? { presentationMeta } : {}),
  }
  return Object.freeze(normalized)
}

function isMapInput(
  input: unknown,
): input is ReadonlyMap<string, ReadonlyArray<TimelineToolCallSummary>> {
  return (
    input instanceof Map ||
    (typeof input === 'object' &&
      input !== null &&
      !Array.isArray(input) &&
      typeof (input as { forEach?: unknown }).forEach === 'function' &&
      typeof (input as { get?: unknown }).get === 'function')
  )
}

function normalizeInput(input: TimelineToolCallsInput): Map<string, TimelineToolCallSummary[]> {
  const grouped = new Map<string, TimelineToolCallSummary[]>()
  if (Array.isArray(input)) {
    for (const raw of input) {
      const summary = normalizeSummary(raw)
      let bucket = grouped.get(summary.toolName)
      if (bucket === undefined) {
        bucket = []
        grouped.set(summary.toolName, bucket)
      }
      bucket.push(summary)
    }
    return grouped
  }
  if (isMapInput(input)) {
    input.forEach((rawItems, toolName) => {
      if (typeof toolName !== 'string' || toolName === '') {
        throw new TypeError('TimelineToolCallsStore shard key must be a non-empty string')
      }
      if (!Array.isArray(rawItems)) {
        throw new TypeError(`TimelineToolCallsStore shard "${toolName}" must be an array`)
      }
      if (rawItems.length === 0) return
      const normalizedItems: TimelineToolCallSummary[] = []
      for (const raw of rawItems) {
        normalizedItems.push(normalizeSummary(raw, toolName))
      }
      grouped.set(toolName, normalizedItems)
    })
    return grouped
  }
  throw new TypeError('TimelineToolCallsStore.update expects a ReadonlyMap or ReadonlyArray')
}

function sameSummary(a: TimelineToolCallSummary, b: TimelineToolCallSummary): boolean {
  return (
    a === b ||
    (a.callId === b.callId &&
      a.toolName === b.toolName &&
      a.index === b.index &&
      a.status === b.status &&
      Object.is(a.input, b.input) &&
      Object.is(a.presentationMeta, b.presentationMeta))
  )
}

function sameShardList(
  prev: ReadonlyArray<TimelineToolCallSummary>,
  next: ReadonlyArray<TimelineToolCallSummary>,
): boolean {
  if (prev === next) return true
  if (prev.length !== next.length) return false
  for (let i = 0; i < prev.length; i++) {
    if (!sameSummary(prev[i]!, next[i]!)) return false
  }
  return true
}

/**
 * Create a sharded external store for timeline tool call summaries.
 * Each `toolName` maintains an independent frozen array snapshot and listener
 * set so updates to unrelated tools never notify subscribers.
 */
export function createTimelineToolCallsStore(
  initial?: TimelineToolCallsInput,
): TimelineToolCallsStoreController {
  const shards = new Map<string, ReadonlyArray<TimelineToolCallSummary>>()
  const listeners = new Map<string, Set<() => void>>()

  function update(next: TimelineToolCallsInput): boolean {
    const nextByTool = normalizeInput(next)
    const changedTools: string[] = []

    for (const existingTool of [...shards.keys()]) {
      if (!nextByTool.has(existingTool)) {
        shards.delete(existingTool)
        changedTools.push(existingTool)
      }
    }

    for (const [toolName, nextItems] of nextByTool) {
      const prevItems = shards.get(toolName)
      if (prevItems !== undefined && sameShardList(prevItems, nextItems)) {
        continue
      }
      const committed = nextItems.map((item, i) =>
        prevItems !== undefined && i < prevItems.length && sameSummary(prevItems[i]!, item)
          ? prevItems[i]!
          : item,
      )
      shards.set(toolName, Object.freeze(committed))
      changedTools.push(toolName)
    }

    if (changedTools.length === 0) return false

    for (const toolName of changedTools) {
      const set = listeners.get(toolName)
      if (set === undefined || set.size === 0) continue
      for (const listener of [...set]) {
        listener()
      }
    }
    return true
  }

  if (initial !== undefined) {
    update(initial)
  }

  return {
    subscribe(toolName: string, listener: () => void): () => void {
      if (typeof toolName !== 'string' || toolName === '') return NOOP_UNSUBSCRIBE
      let set = listeners.get(toolName)
      if (set === undefined) {
        set = new Set()
        listeners.set(toolName, set)
      }
      set.add(listener)
      let released = false
      return () => {
        if (released) return
        released = true
        const current = listeners.get(toolName)
        if (current === undefined) return
        current.delete(listener)
        if (current.size === 0) listeners.delete(toolName)
      }
    },
    getSnapshot(toolName: string): ReadonlyArray<TimelineToolCallSummary> {
      if (typeof toolName !== 'string' || toolName === '') return EMPTY_TIMELINE_TOOL_CALLS
      return shards.get(toolName) ?? EMPTY_TIMELINE_TOOL_CALLS
    },
    update,
  }
}

/** Provided by the host timeline around rendered turns (undefined outside a timeline). */
export const TimelineToolCallsContext = createContext<TimelineToolCallsStore | undefined>(undefined)

/**
 * Subscribe reactively to lightweight chronological summaries for one `toolName`
 * within the enclosing timeline. Returns a referentially stable frozen empty
 * array when called outside `<TimelineToolCallsContext.Provider>`, on SSR without
 * a store, or with an empty `toolName`. Unrelated `toolName` updates never
 * trigger a re-render.
 */
export function useTimelineToolCalls(toolName: string): ReadonlyArray<TimelineToolCallSummary> {
  const store = useContext(TimelineToolCallsContext)
  const activeStore = typeof toolName === 'string' && toolName !== '' ? store : undefined

  const subscribe = useCallback(
    (listener: () => void) => (activeStore !== undefined ? activeStore.subscribe(toolName, listener) : NOOP_UNSUBSCRIBE),
    [activeStore, toolName],
  )

  const getSnapshot = useCallback(
    () => (activeStore !== undefined ? activeStore.getSnapshot(toolName) : EMPTY_TIMELINE_TOOL_CALLS),
    [activeStore, toolName],
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
