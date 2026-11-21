/**
 * FTS5 trigram search query builder, safe plain-text snippet windowing, and UTF-16 highlight computation.
 *
 * Design notes (empirically verified on Node 24 / SQLite 3.50.4):
 * - SQLite FTS5 `trigram` indexes 3-code-point sliding windows: terms with >= 3 Unicode code points use
 *   the inverted trigram index via `MATCH` (AND across whitespace-separated phrases) with `bm25()` ranking.
 * - Terms with < 3 Unicode code points (e.g. two-character CJK words like "登录"/"配置" or short ASCII
 *   tokens like "AI"/"x") produce zero trigrams: trigram `MATCH` returns 0 rows alone and silently ignores
 *   < 3 phrases inside multi-word AND queries. Therefore < 3 terms are never placed in `MATCH`; instead
 *   they are enforced via `instr(lower(title), ?) > 0 OR instr(lower(body), ?) > 0` (matching SQLite's
 *   ASCII-only `lower()`, with zero LIKE `%`/`_` wildcard pitfalls and avoiding `MULTI-INDEX OR` overhead).
 * - Per-conversation caps run inside a nested CTE + `ROW_NUMBER()` over `rowid` before joining back to
 *   fetch `title`/`body` for only the final `<= limit` hits, preventing a single verbose conversation from
 *   crowding out all other conversations.
 * - Snippets and highlight ranges are computed uniformly on plain redacted text (zero HTML tags or control
 *   sentinels), guaranteeing sorted, non-overlapping UTF-16 `[start, end)` spans in `0 <= start < end <= snippet.length`.
 */

import type { SearchHighlightRange } from '@helmx/protocol'

export const DEFAULT_SEARCH_LIMIT = 20
export const DEFAULT_MAX_PER_CONVERSATION = 2
const MAX_SEARCH_TERMS = 12
const SNIPPET_MAX_CHARS = 140
const SNIPPET_LEAD_CHARS = 36
const WORD_SNAP_MAX = 16
const MAX_ANCHOR_HITS_PER_TERM = 16
const MAX_OVERSIZED_TERM_WINDOW = 256

export interface SearchOptions {
  /** Maximum total hits returned (positive integer; defaults to 20). */
  limit?: number
  /** Maximum hits returned from any single conversation (positive integer; defaults to 2). */
  maxPerConversation?: number
}

export interface ParsedSearchQuery {
  /** All deduplicated search terms (in original user order, capped at `MAX_SEARCH_TERMS`). */
  terms: string[]
  /** Terms with >= 3 Unicode code points (indexed by FTS5 `trigram`). */
  trigramTerms: string[]
  /** Terms with 1..2 Unicode code points (filtered via `instr(lower(...))`). */
  shortTerms: string[]
}

export interface FtsSqlQuery {
  sql: string
  params: Array<string | number>
  /** Normalized final hit limit to enforce after collapsing duplicate title-only rows. */
  limit: number
}

/** Match SQLite built-in `lower()` behavior (ASCII A-Z only; leaves non-ASCII unchanged). */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (ch) => ch.toLowerCase())
}

/**
 * Parse a user search query into deduplicated AND terms split by trigram eligibility (>= 3 Unicode code points).
 * Strips NUL bytes (`\0`) which terminate C strings inside SQLite's FTS5 query parser.
 */
export function parseSearchTerms(query: string): ParsedSearchQuery {
  const cleaned = query.replace(/\0/g, ' ').trim()
  if (cleaned.length === 0) return { terms: [], trigramTerms: [], shortTerms: [] }
  const seen = new Set<string>()
  const terms: string[] = []
  const trigramTerms: string[] = []
  const shortTerms: string[] = []
  for (const raw of cleaned.split(/\s+/)) {
    if (raw.length === 0) continue
    const key = raw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(raw)
    if (Array.from(raw).length >= 3) {
      trigramTerms.push(raw)
    } else {
      shortTerms.push(raw)
    }
    if (terms.length >= MAX_SEARCH_TERMS) break
  }
  return { terms, trigramTerms, shortTerms }
}

/** Quote a literal phrase for FTS5 `MATCH` (escaping `"` as `""` prevents syntax injection). */
export function quoteFtsPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
}

/** Build an FTS5 implicit-AND `MATCH` expression from trigram-eligible terms (>= 3 code points). */
export function buildFtsMatchExpr(trigramTerms: readonly string[]): string {
  return trigramTerms.map(quoteFtsPhrase).join(' ')
}

/**
 * Build the parameterized SQLite query for ranked, per-conversation-capped FTS5 search.
 * Returns `undefined` when the parsed query contains zero terms.
 */
export function buildFtsSearchSql(
  parsed: ParsedSearchQuery,
  options?: SearchOptions,
): FtsSqlQuery | undefined {
  if (parsed.terms.length === 0) return undefined
  const limit = normalizePositiveInt(options?.limit, DEFAULT_SEARCH_LIMIT)
  const maxPerConv = normalizePositiveInt(options?.maxPerConversation, DEFAULT_MAX_PER_CONVERSATION)
  // Over-fetch slightly so collapsing duplicate title-only hits per conversation never under-fills `limit`.
  const fetchLimit = limit + Math.min(limit, DEFAULT_SEARCH_LIMIT)

  if (parsed.trigramTerms.length > 0) {
    // Prioritize entries whose `body` actually contains at least one query term ahead of short title-only
    // entries inside the same conversation (BM25 length normalization can otherwise rank a short "ok"
    // message above a longer message in the same conversation that genuinely discusses the query).
    const bodyMatchExpr = parsed.terms.map(() => 'instr(lower(body), ?) > 0').join(' OR ')
    const params: Array<string | number> = [
      ...parsed.terms.map(asciiLower),
      buildFtsMatchExpr(parsed.trigramTerms),
    ]
    const shortClauses: string[] = []
    for (const term of parsed.shortTerms) {
      const needle = asciiLower(term)
      shortClauses.push('AND (instr(lower(title), ?) > 0 OR instr(lower(body), ?) > 0)')
      params.push(needle, needle)
    }
    params.push(maxPerConv, fetchLimit)
    const sql = `
      WITH matched AS (
        SELECT
          rowid AS rid,
          conversation_id,
          (CASE WHEN (${bodyMatchExpr}) THEN 1 ELSE 0 END) AS has_body_match,
          bm25(helmx_conversation_fts, 0.0, 0.0, 2.0, 1.0) AS score
        FROM helmx_conversation_fts
        WHERE helmx_conversation_fts MATCH ?
        ${shortClauses.join('\n        ')}
      ),
      ranked AS (
        SELECT
          rid,
          score,
          ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY has_body_match DESC, score ASC, rid DESC) AS rn
        FROM matched
      ),
      top_hits AS (
        SELECT rid, score
        FROM ranked
        WHERE rn <= ?
        ORDER BY score ASC, rid DESC
        LIMIT ?
      )
      SELECT f.conversation_id, f.entry_id, f.title, f.body
      FROM top_hits t
      JOIN helmx_conversation_fts f ON f.rowid = t.rid
      ORDER BY t.score ASC, t.rid DESC
    `
    return { sql, params, limit }
  }

  // All query terms have < 3 code points: trigram MATCH cannot match them, so scan honestly with
  // `instr(lower(...))` AND predicates, ranking title hits above body-only hits and newer entries first,
  // while still preferring body-matching entries over title-only entries within the same conversation.
  const needles = parsed.shortTerms.map(asciiLower)
  const titleScoreExpr = needles.map(() => '(CASE WHEN instr(lower(title), ?) > 0 THEN 1 ELSE 0 END)').join(' + ')
  const bodyScoreExpr = needles.map(() => '(CASE WHEN instr(lower(body), ?) > 0 THEN 1 ELSE 0 END)').join(' + ')
  const whereClauses = needles.map(() => '(instr(lower(title), ?) > 0 OR instr(lower(body), ?) > 0)').join(' AND ')
  const params: Array<string | number> = []
  for (const needle of needles) params.push(needle)
  for (const needle of needles) params.push(needle)
  for (const needle of needles) params.push(needle, needle)
  params.push(maxPerConv, fetchLimit)
  const sql = `
    WITH matched AS (
      SELECT
        rowid AS rid,
        conversation_id,
        (${titleScoreExpr}) AS title_hits,
        (${bodyScoreExpr}) AS body_hits
      FROM helmx_conversation_fts
      WHERE ${whereClauses}
    ),
    ranked AS (
      SELECT
        rid,
        title_hits,
        body_hits,
        ROW_NUMBER() OVER (
          PARTITION BY conversation_id
          ORDER BY (CASE WHEN body_hits > 0 THEN 1 ELSE 0 END) DESC, title_hits DESC, body_hits DESC, rid DESC
        ) AS rn
      FROM matched
    ),
    top_hits AS (
      SELECT rid, title_hits, body_hits
      FROM ranked
      WHERE rn <= ?
      ORDER BY title_hits DESC, body_hits DESC, rid DESC
      LIMIT ?
    )
    SELECT f.conversation_id, f.entry_id, f.title, f.body
    FROM top_hits t
    JOIN helmx_conversation_fts f ON f.rowid = t.rid
    ORDER BY t.title_hits DESC, t.body_hits DESC, t.rid DESC
  `
  return { sql, params, limit }
}

/**
 * Compute sorted, non-overlapping UTF-16 `[start, end)` highlight spans for all `terms` in `text`.
 * Runs case-insensitive RegExp directly against `text` so UTF-16 offsets never drift on Unicode case folding.
 */
export function findHighlightRanges(text: string, terms: readonly string[]): SearchHighlightRange[] {
  if (text.length === 0 || terms.length === 0) return []
  const raw: SearchHighlightRange[] = []
  for (const term of terms) {
    if (term.length === 0) continue
    const re = new RegExp(escapeRegExp(term), 'gi')
    let match: RegExpExecArray | null
    while ((match = re.exec(text)) !== null) {
      if (match[0].length === 0) {
        re.lastIndex += 1
        continue
      }
      raw.push({ start: match.index, end: match.index + match[0].length })
    }
  }
  if (raw.length === 0) return []
  raw.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: SearchHighlightRange[] = [raw[0]!]
  for (let i = 1; i < raw.length; i += 1) {
    const next = raw[i]!
    const prev = merged[merged.length - 1]!
    if (next.start <= prev.end) {
      if (next.end > prev.end) prev.end = next.end
    } else {
      merged.push({ start: next.start, end: next.end })
    }
  }
  return merged
}

/**
 * Extract a compact plain-text snippet window from `rawBody` around the densest matched term cluster,
 * returning both the final plain-text `snippet` and exact UTF-16 `highlights` into that `snippet`.
 * Synthetic leading/trailing `'...'` ellipses are never included in highlight ranges.
 */
export function buildSearchSnippet(
  rawBody: string,
  terms: readonly string[],
): { snippet: string; highlights: SearchHighlightRange[] } {
  const body = rawBody.replace(/\s+/g, ' ').trim()
  if (body.length === 0) return { snippet: '', highlights: [] }

  if (body.length <= SNIPPET_MAX_CHARS) {
    return { snippet: body, highlights: findHighlightRanges(body, terms) }
  }

  const anchor = pickBestSnippetAnchor(body, terms)
  let winStart: number
  let winEnd: number
  if (anchor === undefined) {
    winStart = 0
    winEnd = SNIPPET_MAX_CHARS
  } else {
    const windowWidth = Math.max(
      SNIPPET_MAX_CHARS,
      Math.min(anchor.end - anchor.start, MAX_OVERSIZED_TERM_WINDOW),
    )
    winStart = Math.max(0, anchor.start - SNIPPET_LEAD_CHARS)
    winEnd = Math.min(body.length, winStart + windowWidth)
    if (winEnd === body.length) {
      winStart = Math.max(0, winEnd - windowWidth)
    }
  }

  // Avoid cutting ASCII words mid-identifier when nearby whitespace exists (CJK slices cleanly at char bounds).
  const minEnd = anchor !== undefined ? Math.min(body.length, Math.max(anchor.end, winStart + 1)) : winStart + 1
  const maxStart = anchor !== undefined ? anchor.start : winStart
  winStart = snapWindowStart(body, winStart, maxStart)
  winEnd = snapWindowEnd(body, winEnd, minEnd)

  // Never slice inside a UTF-16 surrogate pair.
  winStart = avoidSurrogateSplitStart(body, winStart)
  winEnd = avoidSurrogateSplitEnd(body, winStart, winEnd)

  // Trim whitespace at clipped window edges while preserving exact slice offsets.
  while (winStart < winEnd && body[winStart] === ' ') winStart += 1
  while (winEnd > winStart && body[winEnd - 1] === ' ') winEnd -= 1

  const windowText = body.slice(winStart, winEnd)
  const prefix = winStart > 0 ? '...' : ''
  const suffix = winEnd < body.length ? '...' : ''
  const snippet = `${prefix}${windowText}${suffix}`

  // Compute highlights strictly inside `windowText` and shift by `prefix.length` so synthetic ellipses never match.
  const windowRanges = findHighlightRanges(windowText, terms)
  const highlights =
    prefix.length === 0
      ? windowRanges
      : windowRanges.map((r) => ({ start: r.start + prefix.length, end: r.end + prefix.length }))

  return { snippet, highlights }
}

interface AnchorHit {
  start: number
  end: number
  termIndex: number
}

function pickBestSnippetAnchor(body: string, terms: readonly string[]): AnchorHit | undefined {
  const hits: AnchorHit[] = []
  for (let termIndex = 0; termIndex < terms.length; termIndex += 1) {
    const term = terms[termIndex]!
    if (term.length === 0) continue
    const re = new RegExp(escapeRegExp(term), 'gi')
    let count = 0
    let match: RegExpExecArray | null
    while (count < MAX_ANCHOR_HITS_PER_TERM && (match = re.exec(body)) !== null) {
      if (match[0].length === 0) {
        re.lastIndex += 1
        continue
      }
      hits.push({ start: match.index, end: match.index + match[0].length, termIndex })
      count += 1
    }
  }
  if (hits.length === 0) return undefined
  hits.sort((a, b) => a.start - b.start || a.end - b.end)
  if (terms.length <= 1) return hits[0]

  let best = hits[0]!
  let bestDistinct = 0
  for (let i = 0; i < hits.length; i += 1) {
    const candidate = hits[i]!
    const wStart = Math.max(0, candidate.start - SNIPPET_LEAD_CHARS)
    const wEnd = wStart + SNIPPET_MAX_CHARS
    const covered = new Set<number>()
    for (let j = 0; j < hits.length; j += 1) {
      const h = hits[j]!
      if (h.start >= wEnd) break
      if (h.start >= wStart && h.end <= wEnd) covered.add(h.termIndex)
    }
    if (covered.size > bestDistinct) {
      bestDistinct = covered.size
      best = candidate
      if (bestDistinct === terms.length) break
    }
  }
  return best
}

function isAsciiWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false
  const c = ch.charCodeAt(0)
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
}

function snapWindowStart(body: string, start: number, maxStart: number): number {
  if (start <= 0 || !isAsciiWordChar(body[start - 1]) || !isAsciiWordChar(body[start])) return start
  const limit = Math.min(maxStart, start + WORD_SNAP_MAX)
  for (let i = start; i < limit; i += 1) {
    if (body[i] === ' ' && i + 1 <= maxStart) return i + 1
  }
  return start
}

function snapWindowEnd(body: string, end: number, minEnd: number): number {
  if (end >= body.length || !isAsciiWordChar(body[end - 1]) || !isAsciiWordChar(body[end])) return end
  const floor = Math.max(minEnd, end - WORD_SNAP_MAX)
  for (let i = end; i > floor; i -= 1) {
    if (body[i - 1] === ' ' && i - 1 >= minEnd) return i - 1
  }
  return end
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function avoidSurrogateSplitStart(text: string, start: number): number {
  if (start > 0 && start < text.length && isLowSurrogate(text.charCodeAt(start))) {
    return start + 1
  }
  return start
}

function avoidSurrogateSplitEnd(text: string, start: number, end: number): number {
  if (end > start && end < text.length && isLowSurrogate(text.charCodeAt(end))) {
    return end - 1
  }
  return end
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.floor(value))
}
