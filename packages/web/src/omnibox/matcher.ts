/**
 * Pure zero-DOM query parser, prefix router, tiered bilingual + acronym + fuzzy
 * matcher, highlight slicer, and layered Escape / Tab-cycle helpers for Omnibox.
 */
import {
  OMNIBOX_SCOPES,
  type HighlightSegment,
  type OmniboxEscapeAction,
  type OmniboxItem,
  type OmniboxPrefixMode,
  type OmniboxScope,
  type ParsedOmniboxQuery,
  type SearchHighlightSpan,
} from './types.js'

const MAX_FALLBACK_HIGHLIGHT_MATCHES_PER_TOKEN = 32

const SETTING_INTENT_TOKENS: ReadonlySet<string> = new Set([
  'setting',
  'settings',
  'config',
  'configure',
  'configuration',
  'edit',
  'manage',
  '设置',
  '配置',
  '编辑',
  '管理',
])

const WORD_SEPARATOR_RE = /[\s\-_/:.&()[\]{},·]+/

export interface OmniboxMatchResult {
  score: number
  tier: 0 | 1 | 2 | 3
  isExactTopHit: boolean
  titleHighlights: SearchHighlightSpan[]
  matchedModelName?: string
}

export function tokenizeOmniboxQuery(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

export function parsePositiveIntStrict(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * Parses raw omnibox input with ONLY `>` (commands) and `#` (conversations) prefix routing.
 * Deliberately never hijacks `:` or `@` so plugin IDs (`builtin:triggers`, `core:host`) and
 * node/mention queries search literally.
 */
export function parseOmniboxQuery(raw: string, selectedScope: OmniboxScope): ParsedOmniboxQuery {
  const trimmed = raw.trim()
  let prefixMode: OmniboxPrefixMode = null
  let effectiveScope: OmniboxScope = selectedScope
  let searchText = trimmed

  if (trimmed.startsWith('>')) {
    prefixMode = '>'
    effectiveScope = 'commands'
    searchText = trimmed.slice(1).trim()
  } else if (trimmed.startsWith('#')) {
    prefixMode = '#'
    effectiveScope = 'conversations'
    searchText = trimmed.slice(1).trim()
  }

  const exactConversationId =
    prefixMode === '#' && !/\s/.test(trimmed) ? parsePositiveIntStrict(trimmed.slice(1)) : null
  const numericId = prefixMode === null ? parsePositiveIntStrict(trimmed) : null
  const searchLower = searchText.toLowerCase()
  const tokens = tokenizeOmniboxQuery(searchText)
  const hasSettingIntent = tokens.some((tok) => SETTING_INTENT_TOKENS.has(tok))

  return {
    raw,
    trimmed,
    prefixMode,
    effectiveScope,
    searchText,
    searchLower,
    tokens,
    exactConversationId,
    numericId,
    hasSettingIntent,
  }
}

export function resolveNextOmniboxScope(current: OmniboxScope, delta: 1 | -1): OmniboxScope {
  const idx = OMNIBOX_SCOPES.indexOf(current)
  const safeIdx = idx === -1 ? 0 : idx
  const nextIdx = (safeIdx + delta + OMNIBOX_SCOPES.length) % OMNIBOX_SCOPES.length
  return OMNIBOX_SCOPES[nextIdx]!
}

export function resolveOmniboxEscapeAction(state: {
  isComposing: boolean
  hasPreview: boolean
  query: string
  scope: OmniboxScope
}): OmniboxEscapeAction {
  if (state.isComposing) return 'ignore-ime'
  if (state.hasPreview) return 'close-preview'
  if (state.query !== '') return 'clear-query'
  if (state.scope !== 'all') return 'reset-scope'
  return 'close-modal'
}

export function normalizeHighlightSpans(
  textLength: number,
  spans: ReadonlyArray<SearchHighlightSpan>,
): SearchHighlightSpan[] {
  if (textLength <= 0 || spans.length === 0) return []
  const valid = spans
    .filter(
      (s) =>
        Number.isInteger(s.start) &&
        Number.isInteger(s.end) &&
        s.start >= 0 &&
        s.end <= textLength &&
        s.start < s.end,
    )
    .map((s) => ({ start: s.start, end: s.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: SearchHighlightSpan[] = []
  for (const span of valid) {
    const prev = merged[merged.length - 1]
    if (prev !== undefined && span.start <= prev.end) {
      if (span.end > prev.end) prev.end = span.end
    } else {
      merged.push(span)
    }
  }
  return merged
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function findQueryTokenRanges(text: string, query: string): SearchHighlightSpan[] {
  if (text === '') return []
  const rawTokens = query.trim().split(/\s+/).filter(Boolean)
  if (rawTokens.length === 0) return []

  const seenLower = new Set<string>()
  const uniqueTokens: string[] = []
  for (const tok of rawTokens) {
    const lower = tok.toLowerCase()
    if (seenLower.has(lower)) continue
    seenLower.add(lower)
    uniqueTokens.push(tok)
  }
  uniqueTokens.sort((a, b) => b.length - a.length)

  const spans: SearchHighlightSpan[] = []
  for (const tok of uniqueTokens) {
    const re = new RegExp(escapeRegExp(tok), 'gi')
    let count = 0
    for (let match = re.exec(text); match !== null; match = re.exec(text)) {
      if (match[0].length === 0) break
      spans.push({ start: match.index, end: match.index + match[0].length })
      count += 1
      if (count >= MAX_FALLBACK_HIGHLIGHT_MATCHES_PER_TOKEN) break
    }
  }
  return normalizeHighlightSpans(text.length, spans)
}

export function splitTextByHighlightRanges(
  text: string,
  spans: ReadonlyArray<SearchHighlightSpan>,
): HighlightSegment[] {
  if (text === '') return []
  const normalized = normalizeHighlightSpans(text.length, spans)
  if (normalized.length === 0) return [{ text, highlighted: false }]
  const segments: HighlightSegment[] = []
  let cursor = 0
  for (const span of normalized) {
    if (span.start > cursor) {
      segments.push({ text: text.slice(cursor, span.start), highlighted: false })
    }
    segments.push({ text: text.slice(span.start, span.end), highlighted: true })
    cursor = span.end
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), highlighted: false })
  }
  return segments
}

/**
 * Resolves snippet highlight segments honestly:
 * - When `highlights` is provided (including `[]`), trusts backend UTF-16 ranges verbatim
 *   and never fabricates token matches (e.g. title-only FTS hits keep `[]`).
 * - When `highlights` is `undefined`, falls back to case-insensitive literal token matching.
 */
export function resolveSnippetHighlightSegments(
  snippet: string,
  highlights: ReadonlyArray<SearchHighlightSpan> | undefined,
  query: string,
): HighlightSegment[] {
  const spans = highlights !== undefined ? highlights : findQueryTokenRanges(snippet, query)
  return splitTextByHighlightRanges(snippet, spans)
}

export function resolveTitleHighlightSegments(
  title: string,
  titleHighlights: ReadonlyArray<SearchHighlightSpan> | undefined,
  query: string,
): HighlightSegment[] {
  const spans = titleHighlights !== undefined ? titleHighlights : findQueryTokenRanges(title, query)
  return splitTextByHighlightRanges(title, spans)
}

interface WordInitial {
  char: string
  index: number
}

/** Extracts word-initial characters and their UTF-16 offsets (splitting on punctuation/whitespace and camelCase). */
export function extractWordInitials(text: string): WordInitial[] {
  const initials: WordInitial[] = []
  let atBoundary = true
  let prevWasLower = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (WORD_SEPARATOR_RE.test(ch)) {
      atBoundary = true
      prevWasLower = false
      continue
    }
    const isUpper = ch >= 'A' && ch <= 'Z'
    const isLower = ch >= 'a' && ch <= 'z'
    if (atBoundary || (isUpper && prevWasLower)) {
      initials.push({ char: ch.toLowerCase(), index: i })
      atBoundary = false
    }
    prevWasLower = isLower
  }
  return initials
}

/**
 * Matches a compact alphanumeric query against word initials (e.g. `pf` -> `port-forward`,
 * `md` -> `models/defaults`). Returns exact UTF-16 spans on `text`, or null if no match.
 */
export function matchWordInitialAcronym(
  text: string,
  queryLower: string,
): { exact: boolean; spans: SearchHighlightSpan[] } | null {
  if (queryLower.length < 2 || !/^[a-z0-9]+$/.test(queryLower)) return null
  const initials = extractWordInitials(text)
  if (initials.length < queryLower.length) return null
  const initialStr = initials.map((item) => item.char).join('')
  if (!initialStr.startsWith(queryLower)) return null
  const spans = initials.slice(0, queryLower.length).map((item) => ({
    start: item.index,
    end: item.index + 1,
  }))
  return {
    exact: initialStr.length === queryLower.length,
    spans: normalizeHighlightSpans(text.length, spans),
  }
}

/**
 * Compact ordered subsequence match on `text` with boundary quality checks so
 * scattered unrelated characters never pollute search results.
 */
export function matchFuzzySubsequence(
  text: string,
  queryLower: string,
): { spans: SearchHighlightSpan[]; score: number } | null {
  if (queryLower.length < 2 || /\s/.test(queryLower)) return null
  const lower = text.toLowerCase()
  const positions: number[] = []
  let cursor = 0
  let boundaryHits = 0
  let consecutiveBonus = 0

  for (let qi = 0; qi < queryLower.length; qi += 1) {
    const target = queryLower[qi]!
    let found = -1
    // Prefer a boundary occurrence when available close to cursor before taking an interior char
    let firstInterior = -1
    for (let i = cursor; i < lower.length; i += 1) {
      if (lower[i] !== target) continue
      const isBoundary = i === 0 || WORD_SEPARATOR_RE.test(text[i - 1]!) || (text[i]! >= 'A' && text[i]! <= 'Z')
      if (isBoundary) {
        found = i
        boundaryHits += 1
        break
      }
      if (firstInterior === -1) firstInterior = i
    }
    if (found === -1) found = firstInterior
    if (found === -1) return null
    if (positions.length > 0 && found === positions[positions.length - 1]! + 1) {
      consecutiveBonus += 1
    }
    positions.push(found)
    cursor = found + 1
  }

  const spanLen = positions[positions.length - 1]! - positions[0]! + 1
  const maxAllowedSpan = queryLower.length * 3 + 4
  if (spanLen > maxAllowedSpan) return null
  if (boundaryHits === 0 && consecutiveBonus < queryLower.length - 1) return null

  const spans = normalizeHighlightSpans(
    text.length,
    positions.map((pos) => ({ start: pos, end: pos + 1 })),
  )
  const compactness = Math.max(0, 40 - (spanLen - queryLower.length) * 4)
  const score = Math.min(520, 400 + compactness + boundaryHits * 18 + consecutiveBonus * 10)
  return { spans, score }
}

function findMatchedProviderModel(item: OmniboxItem, tokens: ReadonlyArray<string>): string | undefined {
  if (!item.providerModels || item.providerModels.length === 0 || tokens.length === 0) return undefined
  const firstDirect = item.providerModels.find((m) => {
    const idLower = m.id.toLowerCase()
    const nameLower = m.name.toLowerCase()
    return tokens.every((tok) => idLower.includes(tok) || nameLower.includes(tok))
  })
  if (firstDirect) return firstDirect.name || firstDirect.id
  const partial = item.providerModels.find((m) => {
    const idLower = m.id.toLowerCase()
    const nameLower = m.name.toLowerCase()
    return tokens.some((tok) => tok.length >= 2 && (idLower.includes(tok) || nameLower.includes(tok)))
  })
  return partial ? partial.name || partial.id : undefined
}

function scoreConversationItem(
  item: OmniboxItem,
  parsed: ParsedOmniboxQuery,
  frecencyBonus: number,
): OmniboxMatchResult | null {
  const conv = item.conv
  if (!conv) return null

  // Strict `#123` pin: match ONLY the exact conversation ID, never `#4` -> `#40`
  if (parsed.exactConversationId !== null) {
    if (conv.id !== parsed.exactConversationId) return null
    return {
      score: 1000,
      tier: 0,
      isExactTopHit: true,
      titleHighlights: [],
    }
  }

  if (parsed.tokens.length === 0) {
    return {
      score: 500 + frecencyBonus,
      tier: 2,
      isExactTopHit: false,
      titleHighlights: [],
    }
  }

  const titleLower = conv.title.toLowerCase()
  const profileLower = conv.profileId.toLowerCase()
  const idPlain = String(conv.id)
  const idWithHash = `#${conv.id}`
  const extraAliases = (item.searchTerms.aliases ?? []).map((a) => a.toLowerCase())

  for (const tok of parsed.tokens) {
    if (/^#\d+$/.test(tok)) {
      if (idWithHash !== tok && !titleLower.includes(tok)) return null
    } else if (/^\d+$/.test(tok)) {
      if (idPlain !== tok && !titleLower.includes(tok) && !profileLower.includes(tok)) return null
    } else if (
      !titleLower.includes(tok) &&
      !profileLower.includes(tok) &&
      !extraAliases.some((a) => a.includes(tok))
    ) {
      return null
    }
  }

  if (parsed.numericId !== null && conv.id === parsed.numericId) {
    return {
      score: 990,
      tier: 0,
      isExactTopHit: true,
      titleHighlights: [],
    }
  }

  if (titleLower === parsed.searchLower) {
    return {
      score: 980,
      tier: 0,
      isExactTopHit: true,
      titleHighlights: findQueryTokenRanges(item.title, parsed.searchText),
    }
  }

  const titleSpans = findQueryTokenRanges(item.title, parsed.searchText)
  if (titleLower.startsWith(parsed.searchLower)) {
    return {
      score: 900 + frecencyBonus,
      tier: 1,
      isExactTopHit: false,
      titleHighlights: titleSpans,
    }
  }

  if (parsed.tokens.every((tok) => titleLower.includes(tok))) {
    return {
      score: 760 + frecencyBonus,
      tier: 2,
      isExactTopHit: false,
      titleHighlights: titleSpans,
    }
  }

  return {
    score: 620 + frecencyBonus,
    tier: 2,
    isExactTopHit: false,
    titleHighlights: titleSpans,
  }
}

export function scoreOmniboxItem(
  item: OmniboxItem,
  parsed: ParsedOmniboxQuery,
  frecencyBonus = 0,
): OmniboxMatchResult | null {
  if (item.kind === 'conversation' && item.conv !== undefined) {
    return scoreConversationItem(item, parsed, frecencyBonus)
  }

  if (parsed.exactConversationId !== null) {
    return null
  }

  const { searchText, searchLower, tokens } = parsed
  if (tokens.length === 0) {
    return {
      score: 500 + frecencyBonus,
      tier: 2,
      isExactTopHit: false,
      titleHighlights: [],
    }
  }

  const primaryRaw = item.searchTerms.primary.filter((s) => s.trim() !== '')
  const primaryLower = primaryRaw.map((s) => s.toLowerCase())
  const breadcrumbLower = (item.searchTerms.breadcrumb ?? []).map((s) => s.toLowerCase()).filter(Boolean)
  const aliasesLower = (item.searchTerms.aliases ?? []).map((s) => s.toLowerCase()).filter(Boolean)
  const exactTokensLower = (item.searchTerms.exactTokens ?? []).map((s) => s.toLowerCase()).filter(Boolean)
  const matchedModelName = findMatchedProviderModel(item, tokens)

  // Tier 0: Exact canonical token (e.g. '/plan', 'anthropic', 'coder', 'builtin:triggers') or exact primary title
  if (exactTokensLower.includes(searchLower)) {
    return {
      score: 1000,
      tier: 0,
      isExactTopHit: true,
      titleHighlights: findQueryTokenRanges(item.title, searchText),
      ...(matchedModelName !== undefined ? { matchedModelName } : {}),
    }
  }
  if (primaryLower.includes(searchLower)) {
    return {
      score: 980,
      tier: 0,
      isExactTopHit: true,
      titleHighlights: findQueryTokenRanges(item.title, searchText),
      ...(matchedModelName !== undefined ? { matchedModelName } : {}),
    }
  }

  // Tier 1a: Prefix match on primary title / any locale primary / exactToken
  const displayLower = item.title.toLowerCase()
  if (displayLower.startsWith(searchLower)) {
    return {
      score: 920 + frecencyBonus,
      tier: 1,
      isExactTopHit: false,
      titleHighlights: [{ start: 0, end: Math.min(item.title.length, searchText.length) }],
      ...(matchedModelName !== undefined ? { matchedModelName } : {}),
    }
  }
  if (primaryLower.some((p) => p.startsWith(searchLower)) || exactTokensLower.some((e) => e.startsWith(searchLower))) {
    return {
      score: 890 + frecencyBonus,
      tier: 1,
      isExactTopHit: false,
      titleHighlights: findQueryTokenRanges(item.title, searchText),
      ...(matchedModelName !== undefined ? { matchedModelName } : {}),
    }
  }

  // Tier 1b: Word-initial acronym match (`pf` -> `port-forward`, `md` -> `models/defaults`)
  if (tokens.length === 1) {
    const displayAcronym = matchWordInitialAcronym(item.title, searchLower)
    if (displayAcronym !== null) {
      return {
        score: (displayAcronym.exact ? 875 : 845) + frecencyBonus,
        tier: 1,
        isExactTopHit: false,
        titleHighlights: displayAcronym.spans,
        ...(matchedModelName !== undefined ? { matchedModelName } : {}),
      }
    }
    for (const candidate of [...primaryRaw, ...(item.searchTerms.exactTokens ?? []), ...(item.searchTerms.aliases ?? [])]) {
      const acronym = matchWordInitialAcronym(candidate, searchLower)
      if (acronym !== null) {
        return {
          score: (acronym.exact ? 855 : 825) + frecencyBonus,
          tier: 1,
          isExactTopHit: false,
          titleHighlights: findQueryTokenRanges(item.title, searchText),
          ...(matchedModelName !== undefined ? { matchedModelName } : {}),
        }
      }
    }
  }

  // Tier 2: Multi-token AND substring matching across weighted fields
  const allFields = [...primaryLower, ...exactTokensLower, ...breadcrumbLower, ...aliasesLower]
  const allTokensMatch = tokens.every((tok) => allFields.some((field) => field.includes(tok)))
  if (allTokensMatch) {
    const titleHitsAll = tokens.every((tok) => displayLower.includes(tok))
    const primaryHitsAll = tokens.every((tok) => primaryLower.some((p) => p.includes(tok)))
    const primaryOrCrumbHitsAll = tokens.every(
      (tok) =>
        primaryLower.some((p) => p.includes(tok)) ||
        exactTokensLower.some((e) => e.includes(tok)) ||
        breadcrumbLower.some((b) => b.includes(tok)),
    )
    const primaryHitsSome = tokens.some(
      (tok) => primaryLower.some((p) => p.includes(tok)) || exactTokensLower.some((e) => e.includes(tok)),
    )

    let baseScore = 620
    if (titleHitsAll) {
      baseScore = displayLower.startsWith(tokens[0]!) ? 780 : 760
    } else if (primaryHitsAll) {
      baseScore = 740
    } else if (primaryOrCrumbHitsAll) {
      baseScore = 690
    } else if (primaryHitsSome) {
      baseScore = 650
    }

    return {
      score: baseScore + frecencyBonus,
      tier: 2,
      isExactTopHit: false,
      titleHighlights: findQueryTokenRanges(item.title, searchText),
      ...(matchedModelName !== undefined ? { matchedModelName } : {}),
    }
  }

  // Tier 3: Compact ordered fuzzy subsequence on primary titles / exactTokens (single-token queries only)
  if (tokens.length === 1) {
    const displayFuzzy = matchFuzzySubsequence(item.title, searchLower)
    if (displayFuzzy !== null) {
      return {
        score: displayFuzzy.score + frecencyBonus,
        tier: 3,
        isExactTopHit: false,
        titleHighlights: displayFuzzy.spans,
        ...(matchedModelName !== undefined ? { matchedModelName } : {}),
      }
    }
    for (const candidate of [...primaryRaw, ...(item.searchTerms.exactTokens ?? [])]) {
      const fuzzy = matchFuzzySubsequence(candidate, searchLower)
      if (fuzzy !== null) {
        return {
          score: Math.max(400, fuzzy.score - 20) + frecencyBonus,
          tier: 3,
          isExactTopHit: false,
          titleHighlights: [],
          ...(matchedModelName !== undefined ? { matchedModelName } : {}),
        }
      }
    }
  }

  return null
}
