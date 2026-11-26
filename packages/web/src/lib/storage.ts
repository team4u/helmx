/**
 * Safe Web Storage helpers shared across preference, layout, auth, and
 * version-watch persistence modules (SSR & restricted WebView tolerant).
 */

export type StorageReader = Pick<Storage, 'getItem'>
export type StorageWriter = Pick<Storage, 'setItem'>
export type StorageRemover = Pick<Storage, 'removeItem'>
export type StorageReadWrite = StorageReader & StorageWriter & StorageRemover

function resolveStorage(storage?: unknown): Storage | null {
  if (storage === null) return null
  if (storage !== undefined) return storage as Storage
  try {
    if (typeof window !== 'undefined' && window.localStorage !== undefined) {
      return window.localStorage
    }
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      return globalThis.localStorage ?? null
    }
  } catch {
    return null
  }
  return null
}

/**
 * Reads a key with explicit availability status so fail-closed guards (e.g.
 * auto-reload loop prevention) can distinguish "missing" from "storage threw".
 */
export function tryReadStorageItem(
  key: string,
  storage?: StorageReader | null,
): { ok: true; value: string | null } | { ok: false } {
  const store = resolveStorage(storage)
  if (store === null || typeof store.getItem !== 'function') {
    return { ok: false }
  }
  try {
    return { ok: true, value: store.getItem(key) }
  } catch {
    return { ok: false }
  }
}

export function readStorageItem(key: string, storage?: StorageReader | null): string | null {
  const result = tryReadStorageItem(key, storage)
  return result.ok ? result.value : null
}

export function writeStorageItem(key: string, value: string, storage?: StorageWriter | null): boolean {
  const store = resolveStorage(storage)
  if (store === null || typeof store.setItem !== 'function') return false
  try {
    store.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function removeStorageItem(key: string, storage?: StorageRemover | null): void {
  const store = resolveStorage(storage)
  if (store === null || typeof store.removeItem !== 'function') return
  try {
    store.removeItem(key)
  } catch {
    /* Storage restricted or unavailable */
  }
}

export function setOrRemoveStorageItem(
  key: string,
  value: string | null,
  storage?: (StorageWriter & StorageRemover) | null,
): void {
  if (value === null) {
    removeStorageItem(key, storage)
  } else {
    writeStorageItem(key, value, storage)
  }
}
