/**
 * Lightweight coordinator between `DuoMenuItem` (which unmounts on menu close) and
 * `DuoToolbarPill` (which stays mounted in the composer toolbar) to open Duo setup cleanly.
 */
const listeners = new Map<string, Set<() => void>>()

export function duoSetupTargetKey(conversationId?: number, profileId?: string): string {
  return conversationId !== undefined ? `conv:${conversationId}` : `standby:${profileId ?? ''}`
}

export function subscribeDuoSetup(key: string, listener: () => void): () => void {
  let set = listeners.get(key)
  if (set === undefined) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(listener)
  return () => {
    set!.delete(listener)
    if (set!.size === 0) listeners.delete(key)
  }
}

export function requestDuoSetup(key: string): boolean {
  const set = listeners.get(key)
  if (set === undefined || set.size === 0) return false
  for (const fn of [...set]) fn()
  return true
}
