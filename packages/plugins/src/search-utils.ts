/**
 * Shared lightweight matching, scoring, and text normalization helpers for
 * built-in plugin `helmx.search` capability providers.
 */

export interface SearchableTextFields {
  /** Primary identifiers or display names (highest match weight). */
  primary: ReadonlyArray<string | undefined>
  /** Secondary descriptors (descriptions, schedules, model refs, endpoints). */
  secondary?: ReadonlyArray<string | undefined>
  /** Category/alias keywords (lower standalone weight, assists multi-token queries). */
  keywords?: ReadonlyArray<string | undefined>
}

export interface RankSearchOptions<T, R> {
  query: string
  limit: number
  signal?: AbortSignal
  items: Iterable<T>
  fields: (item: T) => SearchableTextFields
  tieBreaker: (item: T) => string
  toResult: (item: T, score: number) => R
}

/** Collapse whitespace/newlines to a single line and truncate cleanly for compact search subtitles. */
export function compactOneLine(text: string | undefined, maxLength = 140): string | undefined {
  if (typeof text !== 'string') return undefined
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return undefined
  if (collapsed.length <= maxLength) return collapsed
  return `${collapsed.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
}

/** Normalize a requested search result limit into a non-negative integer bound. */
export function normalizeSearchLimit(limit: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return 0
  return Math.floor(limit)
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function normalizeList(values: ReadonlyArray<string | undefined> | undefined): string[] {
  if (values === undefined || values.length === 0) return []
  const out: string[] = []
  for (const raw of values) {
    if (typeof raw !== 'string') continue
    const norm = normalizeText(raw)
    if (norm.length > 0) out.push(norm)
  }
  return out
}

function tokenScore(
  token: string,
  primary: readonly string[],
  secondary: readonly string[],
  keywords: readonly string[],
): { score: number; keywordOnly: boolean } | undefined {
  for (const text of primary) {
    if (text === token) return { score: 92, keywordOnly: false }
  }
  for (const text of primary) {
    if (text.startsWith(token)) return { score: 84, keywordOnly: false }
  }
  for (const text of primary) {
    if (text.includes(token)) return { score: 74, keywordOnly: false }
  }
  for (const text of secondary) {
    if (text.startsWith(token)) return { score: 64, keywordOnly: false }
  }
  for (const text of secondary) {
    if (text.includes(token)) return { score: 54, keywordOnly: false }
  }
  for (const text of keywords) {
    if (text === token) return { score: 44, keywordOnly: true }
  }
  for (const text of keywords) {
    if (text.startsWith(token)) return { score: 38, keywordOnly: true }
  }
  for (const text of keywords) {
    if (text.includes(token)) return { score: 32, keywordOnly: true }
  }
  return undefined
}

/**
 * Score a candidate's text fields against a search query.
 * Returns a finite score in `1..100` on match, or `undefined` when unmatched.
 */
export function scoreSearchFields(query: string, fields: SearchableTextFields): number | undefined {
  const q = normalizeText(query)
  if (q.length === 0) return undefined

  const primary = normalizeList(fields.primary)
  const secondary = normalizeList(fields.secondary)
  const keywords = normalizeList(fields.keywords)

  // Fast full-query phrase checks (highest fidelity).
  for (const text of primary) {
    if (text === q) return 100
  }
  for (const text of primary) {
    if (text.startsWith(q)) return 90
  }
  for (const text of primary) {
    if (text.includes(q)) return 78
  }
  for (const text of secondary) {
    if (text.startsWith(q)) return 66
  }
  for (const text of secondary) {
    if (text.includes(q)) return 56
  }

  const tokens = q.split(' ')
  if (tokens.length === 1) {
    for (const text of keywords) {
      if (text === q) return 48
    }
    for (const text of keywords) {
      if (text.startsWith(q)) return 42
    }
    for (const text of keywords) {
      if (text.includes(q)) return 36
    }
    return undefined
  }

  // Multi-token AND match across primary, secondary, and category keywords.
  let sum = 0
  let allKeywordOnly = true
  for (const token of tokens) {
    const match = tokenScore(token, primary, secondary, keywords)
    if (match === undefined) return undefined
    sum += match.score
    if (!match.keywordOnly) allKeywordOnly = false
  }
  const avg = Math.round(sum / tokens.length)
  return allKeywordOnly ? Math.min(45, avg) : Math.min(95, Math.max(1, avg))
}

/**
 * Match, score, sort deterministically, and slice candidates up to `limit`
 * while honoring `AbortSignal` before and during iteration.
 */
export function rankSearchCandidates<T, R>(options: RankSearchOptions<T, R>): R[] {
  const { query, limit, signal, items, fields, tieBreaker, toResult } = options
  if (signal?.aborted) return []
  const maxResults = normalizeSearchLimit(limit)
  if (maxResults === 0) return []
  const q = normalizeText(query)
  if (q.length === 0) return []

  const matched: Array<{ item: T; score: number; key: string }> = []
  for (const item of items) {
    if (signal?.aborted) return []
    const score = scoreSearchFields(q, fields(item))
    if (score !== undefined) {
      matched.push({ item, score, key: tieBreaker(item) })
    }
  }

  matched.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
  return matched.slice(0, maxResults).map((entry) => toResult(entry.item, entry.score))
}
