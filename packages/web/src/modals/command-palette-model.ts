/**
 * Pure matching, ranking, deduplication, highlight slicing, split-navigation,
 * and layered Escape logic for CommandPaletteModal (zero React / DOM deps).
 */
import type { ConversationSummary, SearchHit } from '@helmx/protocol/browser'
import { isConversationArchived } from '../conversation/archive-model.js'
import type { FocusedPanel, ResolvedTarget } from '../lib/types.js'

export type PaletteGroupKey = 'context' | 'recent' | 'navigation' | 'commands'

export interface SearchHighlightSpan {
  /** Inclusive UTF-16 start offset. */
  start: number
  /** Exclusive UTF-16 end offset (end > start). */
  end: number
}

export type PaletteSearchHit = SearchHit & {
  highlights?: ReadonlyArray<SearchHighlightSpan>
}

export interface PaletteCommandRow {
  kind: 'command'
  id: string
  group: Exclude<PaletteGroupKey, 'recent'>
  title: string
  hint?: string
  shortcut?: string
  icon?: string
  keywords?: ReadonlyArray<string>
  target?: ResolvedTarget
  run?: () => void
  /** Keeps dialog close auto-focus from returning to the background trigger when the command moves focus itself (e.g. composer, shortcuts modal, model picker). */
  skipCloseAutoFocus?: boolean
}

export interface PaletteSearchHitRow {
  kind: 'search-hit'
  id: string
  group: 'recent'
  hit: PaletteSearchHit
  conv?: ConversationSummary
  isLocalConversation?: boolean
}

export type PaletteRow = PaletteCommandRow | PaletteSearchHitRow

export interface PaletteSection {
  key: PaletteGroupKey
  items: PaletteRow[]
}

export interface PaletteNavigationDispatch {
  target: ResolvedTarget
  split: boolean
  highlightEntryId?: string
}

export interface HighlightSegment {
  text: string
  highlighted: boolean
}

export type PaletteEscapeAction = 'ignore-ime' | 'close-preview' | 'clear-query' | 'close-modal'

const COMMAND_CATEGORY_RANK: Record<PaletteCommandRow['group'], number> = {
  context: 0,
  navigation: 1,
  commands: 2,
}

const MAX_LOCAL_CONVERSATION_MATCHES = 6
const MAX_FTS_HITS = 8
const MAX_FALLBACK_HIGHLIGHT_MATCHES_PER_TOKEN = 32

export function tokenizePaletteQuery(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

export function parseNumericIdQuery(query: string): { id: number; explicitHash: boolean } | null {
  const m = /^(#?)(\d+)$/.exec(query.trim())
  if (m === null) return null
  const id = Number(m[2])
  if (!Number.isSafeInteger(id) || id <= 0) return null
  return { id, explicitHash: m[1] === '#' }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
 * Resolve snippet highlight segments honestly:
 * - When `highlights` is provided (including `[]`), trust the backend ranges
 *   verbatim and never fabricate token matches (e.g. title-only hits keep `[]`).
 * - When `highlights` is `undefined` (legacy/minimal stubs), fall back to
 *   case-insensitive literal token matching on `snippet`.
 */
export function resolveSnippetHighlightSegments(
  snippet: string,
  highlights: ReadonlyArray<SearchHighlightSpan> | undefined,
  query: string,
): HighlightSegment[] {
  const spans = highlights !== undefined ? highlights : findQueryTokenRanges(snippet, query)
  return splitTextByHighlightRanges(snippet, spans)
}

export function resolveTitleHighlightSegments(title: string, query: string): HighlightSegment[] {
  return splitTextByHighlightRanges(title, findQueryTokenRanges(title, query))
}

function scoreCommandRow(
  row: PaletteCommandRow,
  trimmedLower: string,
  tokens: ReadonlyArray<string>,
): number | null {
  const title = row.title.toLowerCase()
  const hint = (row.hint ?? '').toLowerCase()
  const shortcut = (row.shortcut ?? '').toLowerCase()
  const keywords = (row.keywords ?? []).map((k) => k.toLowerCase()).filter(Boolean)
  const allFields = [title, hint, shortcut, ...keywords].filter(Boolean)

  for (const tok of tokens) {
    if (!allFields.some((field) => field.includes(tok))) {
      return null
    }
  }

  if (
    title === trimmedLower ||
    (row.id.startsWith('profile:') && hint !== '' && hint === trimmedLower) ||
    (row.target?.kind === 'agent' && row.target.profileId.toLowerCase() === trimmedLower) ||
    keywords.some((k) => k.startsWith('/') && k === trimmedLower)
  ) {
    return 0
  }

  const allInTitle = tokens.every((tok) => title.includes(tok))
  if (title.startsWith(trimmedLower) || (tokens.length > 1 && allInTitle && title.startsWith(tokens[0]!))) {
    return 1
  }

  if (
    allInTitle ||
    (tokens.some((tok) => title.includes(tok)) &&
      hint !== '' &&
      tokens.every((tok) => title.includes(tok) || hint.includes(tok)))
  ) {
    return 2
  }

  return 3
}

function scoreConversationMatch(
  conv: ConversationSummary,
  trimmedLower: string,
  tokens: ReadonlyArray<string>,
  idTarget: { id: number; explicitHash: boolean } | null,
): number | null {
  const title = conv.title.toLowerCase()
  const profileId = conv.profileId.toLowerCase()
  const idPlain = String(conv.id)
  const idWithHash = `#${conv.id}`

  for (const tok of tokens) {
    if (/^#\d+$/.test(tok)) {
      if (idWithHash !== tok && !title.includes(tok)) return null
    } else if (/^\d+$/.test(tok)) {
      if (idPlain !== tok && !title.includes(tok) && !profileId.includes(tok)) return null
    } else if (!title.includes(tok) && !profileId.includes(tok)) {
      return null
    }
  }

  if ((idTarget !== null && conv.id === idTarget.id) || title === trimmedLower) {
    return 0
  }
  if (title.startsWith(trimmedLower)) {
    return 1
  }
  if (tokens.every((tok) => title.includes(tok))) {
    return 2
  }
  return 3
}

export interface BuildPaletteRowsInput {
  query: string
  contextCommands: ReadonlyArray<PaletteCommandRow>
  recentConversations: ReadonlyArray<PaletteSearchHitRow>
  navigationCommands: ReadonlyArray<PaletteCommandRow>
  utilityCommands: ReadonlyArray<PaletteCommandRow>
  conversations: ReadonlyArray<ConversationSummary>
  ftsHits: ReadonlyArray<PaletteSearchHit>
  makeConversationRow: (conv: ConversationSummary) => PaletteSearchHitRow
}

export interface BuildPaletteRowsResult {
  sections: PaletteSection[]
  rows: PaletteRow[]
}

export function buildPaletteRows(input: BuildPaletteRowsInput): BuildPaletteRowsResult {
  const trimmed = input.query.trim()
  if (trimmed === '') {
    const sections: PaletteSection[] = []
    if (input.contextCommands.length > 0) {
      sections.push({ key: 'context', items: [...input.contextCommands] })
    }
    if (input.recentConversations.length > 0) {
      sections.push({ key: 'recent', items: [...input.recentConversations] })
    }
    if (input.navigationCommands.length > 0) {
      sections.push({ key: 'navigation', items: [...input.navigationCommands] })
    }
    if (input.utilityCommands.length > 0) {
      sections.push({ key: 'commands', items: [...input.utilityCommands] })
    }
    return {
      sections,
      rows: sections.flatMap((section) => section.items),
    }
  }

  const trimmedLower = trimmed.toLowerCase()
  const tokens = tokenizePaletteQuery(trimmed)
  const idTarget = parseNumericIdQuery(trimmed)

  type ScoredLocal =
    | {
        kind: 'command'
        tier: number
        categoryRank: number
        originalIdx: number
        row: PaletteCommandRow
      }
    | {
        kind: 'conv'
        tier: number
        automatedRank: number
        archivedRank: number
        updatedAt: number
        convId: number
        conv: ConversationSummary
      }

  const allCommands = [
    ...input.contextCommands,
    ...input.navigationCommands,
    ...input.utilityCommands,
  ]
  const scoredCommands: Extract<ScoredLocal, { kind: 'command' }>[] = []
  allCommands.forEach((row, originalIdx) => {
    const tier = scoreCommandRow(row, trimmedLower, tokens)
    if (tier !== null) {
      scoredCommands.push({
        kind: 'command',
        tier,
        categoryRank: COMMAND_CATEGORY_RANK[row.group],
        originalIdx,
        row,
      })
    }
  })

  const scoredConvs: Extract<ScoredLocal, { kind: 'conv' }>[] = []
  const convById = new Map<number, ConversationSummary>()
  for (const conv of input.conversations) {
    convById.set(conv.id, conv)
    const tier = scoreConversationMatch(conv, trimmedLower, tokens, idTarget)
    if (tier !== null) {
      scoredConvs.push({
        kind: 'conv',
        tier,
        automatedRank: conv.ownedBy === 'helmx' ? 1 : 0,
        archivedRank: isConversationArchived(conv) ? 1 : 0,
        updatedAt: conv.updatedAt,
        convId: conv.id,
        conv,
      })
    }
  }
  scoredConvs.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.automatedRank - b.automatedRank ||
      a.archivedRank - b.archivedRank ||
      b.updatedAt - a.updatedAt ||
      b.convId - a.convId,
  )
  const topConvs = scoredConvs.slice(0, MAX_LOCAL_CONVERSATION_MATCHES)

  const localScored: ScoredLocal[] = [...scoredCommands, ...topConvs]
  localScored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    if (a.kind !== b.kind) {
      if (idTarget !== null) return a.kind === 'conv' ? -1 : 1
      return a.kind === 'command' ? -1 : 1
    }
    if (a.kind === 'command' && b.kind === 'command') {
      return a.categoryRank - b.categoryRank || a.originalIdx - b.originalIdx
    }
    if (a.kind === 'conv' && b.kind === 'conv') {
      return (
        a.automatedRank - b.automatedRank ||
        a.archivedRank - b.archivedRank ||
        b.updatedAt - a.updatedAt ||
        b.convId - a.convId
      )
    }
    return 0
  })

  const localRows: PaletteRow[] = localScored.map((entry) =>
    entry.kind === 'command' ? entry.row : input.makeConversationRow(entry.conv),
  )

  const matchedConvIds = new Set(topConvs.map((entry) => entry.convId))
  const seenFtsKeys = new Set<string>()
  const ftsRows: PaletteSearchHitRow[] = []
  for (const hit of input.ftsHits) {
    const entryKey = hit.entryId ? String(hit.entryId) : ''
    const key = `${hit.conversationId}:${entryKey}`
    if (seenFtsKeys.has(key)) continue
    if (entryKey === '' && matchedConvIds.has(hit.conversationId)) continue
    seenFtsKeys.add(key)
    ftsRows.push({
      kind: 'search-hit',
      id: `hit:${key}`,
      group: 'recent',
      conv: convById.get(hit.conversationId),
      hit,
      isLocalConversation: false,
    })
    if (ftsRows.length >= MAX_FTS_HITS) break
  }

  return {
    sections: [],
    rows: [...localRows, ...ftsRows],
  }
}

export function resolveSelectedIndex(rows: ReadonlyArray<PaletteRow>, selectedId: string | null): number {
  if (rows.length === 0) return -1
  if (selectedId !== null) {
    const idx = rows.findIndex((row) => row.id === selectedId)
    if (idx !== -1) return idx
  }
  return 0
}

export function resolveRowNavigation(
  row: PaletteRow,
  activePanel: FocusedPanel,
  forceSplit: boolean,
): PaletteNavigationDispatch | null {
  const split = forceSplit || activePanel === 'split'
  if (row.kind === 'command') {
    if (row.target === undefined) return null
    return { target: row.target, split }
  }
  const entryId = row.hit.entryId?.trim()
  return {
    target: { kind: 'conversation', conversationId: row.hit.conversationId },
    split,
    ...(entryId ? { highlightEntryId: entryId } : {}),
  }
}

export function resolvePaletteEscapeAction(state: {
  isComposing: boolean
  hasPreview: boolean
  query: string
}): PaletteEscapeAction {
  if (state.isComposing) return 'ignore-ime'
  if (state.hasPreview) return 'close-preview'
  if (state.query !== '') return 'clear-query'
  return 'close-modal'
}
