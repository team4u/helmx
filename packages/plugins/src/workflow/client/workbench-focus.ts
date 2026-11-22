/**
 * In-plugin workbench run focus bus for the builtin:workflow plugin (pure
 * in-memory state + subscription, zero React/DOM dependencies).
 *
 * State is stored on a shared `Symbol.for(...)` slot on `globalThis` so
 * separately compiled surface entrypoints (`active-tray.tsx`, `tool-views.tsx`,
 * `workbench.tsx`) coordinate on the exact same focus bus without bundling a
 * monolithic single entry.
 */

export interface WorkbenchRunFocusRequest {
  conversationId: number
  runId: string
  seq: number
}

type FocusListener = (request: WorkbenchRunFocusRequest) => void

interface FocusBusState {
  pendingFocus: WorkbenchRunFocusRequest | undefined
  focusSeq: number
  listeners: Set<FocusListener>
}

const FOCUS_BUS_KEY = Symbol.for('helmx:builtin:workflow:workbench-focus')

function getBus(): FocusBusState {
  const g = globalThis as Record<PropertyKey, unknown>
  let bus = g[FOCUS_BUS_KEY] as FocusBusState | undefined
  if (bus === undefined) {
    bus = { pendingFocus: undefined, focusSeq: 0, listeners: new Set() }
    g[FOCUS_BUS_KEY] = bus
  }
  return bus
}

/** Request the right workbench to focus and expand a run.id of a conversation. */
export function requestWorkbenchRunFocus(conversationId: number, runId: string): void {
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0 || runId === '') return
  const bus = getBus()
  bus.focusSeq += 1
  const request: WorkbenchRunFocusRequest = { conversationId, runId, seq: bus.focusSeq }
  bus.pendingFocus = request
  for (const listener of [...bus.listeners]) {
    listener(request)
  }
}

/** Non-destructive peek at a pending run focus request for the current conversation (SSR safe). */
export function peekWorkbenchRunFocus(conversationId: number): WorkbenchRunFocusRequest | undefined {
  const pending = getBus().pendingFocus
  return pending?.conversationId === conversationId ? pending : undefined
}

/** Clear the pending focus request of a conversation (optionally matching runId exactly). */
export function clearWorkbenchRunFocus(conversationId: number, runId?: string): void {
  const bus = getBus()
  if (bus.pendingFocus === undefined || bus.pendingFocus.conversationId !== conversationId) return
  if (runId !== undefined && bus.pendingFocus.runId !== runId) return
  bus.pendingFocus = undefined
}

/** Subscribe to later focus requests (for a mounted WorkflowWorkbenchPanel to jump live). */
export function subscribeWorkbenchRunFocus(listener: FocusListener): () => void {
  const bus = getBus()
  bus.listeners.add(listener)
  return () => {
    bus.listeners.delete(listener)
  }
}
