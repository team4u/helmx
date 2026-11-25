/**
 * Shared validation and secondary-index helpers for `HelmxStore` table repositories.
 */

import { HelmxError } from '@helmx/protocol'

/** Validate persisted JSON: fails explicitly on corruption (with location context) rather than falling back to empty values. */
export function parseStoredJson<T>(what: string, raw: string): T {
  if (typeof raw !== 'string') {
    throw new HelmxError(
      'store_data_corrupted',
      `Persisted data corrupted (${what}): expected JSON string, got ${raw === null ? 'null' : typeof raw}`,
      500,
      { what },
    )
  }
  try {
    return JSON.parse(raw) as T
  } catch (cause) {
    throw new HelmxError(
      'store_data_corrupted',
      `Persisted data corrupted (${what}): JSON parse failed: ${String(cause)}`,
      500,
      { what, raw: raw.slice(0, 200), cause: String(cause) },
    )
  }
}

export function parseStoredStringArray(what: string, raw: string): string[] {
  const parsed = parseStoredJson<unknown>(what, raw)
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new HelmxError(
      'store_data_corrupted',
      `Persisted data corrupted (${what}): expected JSON array of strings`,
      500,
      { what, raw: raw.slice(0, 200) },
    )
  }
  return parsed
}

export function addConvIndex(index: Map<number, Set<string>>, conversationId: number, key: string): void {
  let set = index.get(conversationId)
  if (set === undefined) {
    set = new Set()
    index.set(conversationId, set)
  }
  set.add(key)
}

export function removeConvIndex(index: Map<number, Set<string>>, conversationId: number, key: string): void {
  const set = index.get(conversationId)
  if (set === undefined) return
  set.delete(key)
  if (set.size === 0) index.delete(conversationId)
}
