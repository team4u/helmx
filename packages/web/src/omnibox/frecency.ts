/**
 * Bounded localStorage LRU frecency store for Omnibox.
 *
 * Security & privacy invariant: persists ONLY `{ id, count, lastUsedAt }`
 * (max 32 entries) — NEVER stores search query strings, titles, snippets,
 * credentials, or user input text.
 */
import {
  readStorageItem,
  removeStorageItem,
  writeStorageItem,
  type StorageReader,
  type StorageRemover,
  type StorageWriter,
} from '../lib/storage.js'

export const OMNIBOX_FRECENCY_STORAGE_KEY = 'helmx:omnibox-frecency'
export const MAX_OMNIBOX_FRECENCY_ENTRIES = 32
export const MAX_FRECENCY_BONUS = 45

const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000

export interface FrecencyEntry {
  id: string
  count: number
  lastUsedAt: number
}

function isValidFrecencyEntry(raw: unknown): raw is FrecencyEntry {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
  const rec = raw as Record<string, unknown>
  return (
    typeof rec['id'] === 'string' &&
    rec['id'].trim() !== '' &&
    rec['id'].length <= 256 &&
    typeof rec['count'] === 'number' &&
    Number.isFinite(rec['count']) &&
    rec['count'] >= 1 &&
    typeof rec['lastUsedAt'] === 'number' &&
    Number.isFinite(rec['lastUsedAt']) &&
    rec['lastUsedAt'] >= 0
  )
}

function normalizeEntries(entries: ReadonlyArray<FrecencyEntry>): FrecencyEntry[] {
  const byId = new Map<string, FrecencyEntry>()
  for (const entry of entries) {
    const existing = byId.get(entry.id)
    if (existing === undefined || entry.lastUsedAt > existing.lastUsedAt) {
      byId.set(entry.id, {
        id: entry.id,
        count: Math.max(1, Math.min(1000, Math.floor(entry.count))),
        lastUsedAt: Math.floor(entry.lastUsedAt),
      })
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, MAX_OMNIBOX_FRECENCY_ENTRIES)
}

export function loadFrecencyEntries(storage?: StorageReader | null): FrecencyEntry[] {
  const raw = readStorageItem(OMNIBOX_FRECENCY_STORAGE_KEY, storage)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const valid = parsed.filter(isValidFrecencyEntry)
    return normalizeEntries(valid)
  } catch {
    return []
  }
}

export function recordFrecencyUse(
  entries: ReadonlyArray<FrecencyEntry>,
  id: string,
  nowMs: number = Date.now(),
  storage?: StorageWriter | null,
): FrecencyEntry[] {
  const trimmed = id.trim()
  if (trimmed === '' || trimmed.length > 256) return [...entries]
  const existing = entries.find((item) => item.id === trimmed)
  const updated: FrecencyEntry = {
    id: trimmed,
    count: Math.min(1000, (existing?.count ?? 0) + 1),
    lastUsedAt: Math.floor(nowMs),
  }
  const next = normalizeEntries([...entries.filter((item) => item.id !== trimmed), updated])
  writeStorageItem(OMNIBOX_FRECENCY_STORAGE_KEY, JSON.stringify(next), storage)
  return next
}

export function clearFrecencyStorage(storage?: StorageRemover | null): void {
  removeStorageItem(OMNIBOX_FRECENCY_STORAGE_KEY, storage)
}

export function indexFrecencyEntries(entries: ReadonlyArray<FrecencyEntry>): ReadonlyMap<string, FrecencyEntry> {
  return new Map(entries.map((entry) => [entry.id, entry] as const))
}

/**
 * Computes a bounded frecency ranking boost (`0..MAX_FRECENCY_BONUS`) so
 * frequently & recently opened items rise naturally within their match tier
 * without ever overpowering an exact match.
 */
export function computeFrecencyBonus(entry: FrecencyEntry | undefined, nowMs: number = Date.now()): number {
  if (entry === undefined) return 0
  const ageMs = Math.max(0, nowMs - entry.lastUsedAt)
  const decay = Math.pow(0.5, ageMs / HALF_LIFE_MS)
  const raw = Math.log2(entry.count + 1) * 14 * decay
  return Math.min(MAX_FRECENCY_BONUS, Math.round(raw * 10) / 10)
}
