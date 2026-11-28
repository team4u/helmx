/**
 * Pure Omnibox ranking, Top-K sectioning, Sync-Upper / Async-Lower isolation,
 * empty-state curation, and single-entity setting-intent swapping (zero React / DOM deps).
 */
import { isConversationArchived } from '../conversation/archive-model.js'
import { computeFrecencyBonus, indexFrecencyEntries, type FrecencyEntry } from './frecency.js'
import { parseOmniboxQuery, scoreOmniboxItem } from './matcher.js'
import type {
  OmniboxItem,
  OmniboxScope,
  OmniboxScopeCounts,
  OmniboxSection,
  ParsedOmniboxQuery,
} from './types.js'

export const ALL_SCOPE_QUOTAS = {
  pages: 5,
  commands: 4,
  conversations: 4,
  resources: 4,
  messages: 4,
} as const

export const DEDICATED_SCOPE_SYNC_LIMIT = 24
export const DEDICATED_SCOPE_ASYNC_LIMIT = 12
export const EMPTY_STATE_RECENT_PAGES_LIMIT = 3

export interface BuildOmniboxViewInput {
  query: string
  scope: OmniboxScope
  /** Context commands shown at top of empty state (and searchable in `commands`). */
  contextItems: ReadonlyArray<OmniboxItem>
  /** Curated recent conversations for empty state. */
  recentConversationItems: ReadonlyArray<OmniboxItem>
  /** All synchronous 0ms pages & settings items (centers, sub-tabs, profiles, screens, providers, skills, nodes, plugins, core:*, settingsPanels, config fields). */
  pageItems: ReadonlyArray<OmniboxItem>
  /** All synchronous 0ms command items excluding contextItems (quick create, workbench panels, plugin commands, utilities). */
  commandItems: ReadonlyArray<OmniboxItem>
  /** All synchronous 0ms local conversation items (for search & `#` browsing). */
  conversationItems: ReadonlyArray<OmniboxItem>
  /** 200ms asynchronous plugin resource items from `/api/omnibox/search`. */
  asyncPluginItems: ReadonlyArray<OmniboxItem>
  /** 200ms asynchronous FTS message items from `/api/omnibox/search`. */
  asyncMessageItems: ReadonlyArray<OmniboxItem>
  /** Bounded frecency history for ranking boost + empty-state recent pages/settings recall. */
  frecencyEntries?: ReadonlyArray<FrecencyEntry>
  /** Current timestamp in ms (injectable for deterministic tests). */
  nowMs?: number
  /** Formatter for provider-by-model reverse search subtitle enrichment. */
  formatMatchedModelSubtitle?: (modelName: string, currentSubtitle?: string) => string
}

export interface BuildOmniboxViewResult {
  parsed: ParsedOmniboxQuery
  effectiveScope: OmniboxScope
  sections: OmniboxSection[]
  rows: OmniboxItem[]
  scopeCounts: OmniboxScopeCounts
}

interface ScoredItem {
  item: OmniboxItem
  score: number
  tier: 0 | 1 | 2 | 3
  isExactTopHit: boolean
  originalIdx: number
}

function applyIntentSwap(
  item: OmniboxItem,
  options: { inPagesScope: boolean; hasSettingIntent: boolean },
): OmniboxItem {
  const swap = item.settingIntentSwap
  if (swap === undefined) return item
  const shouldSwap = options.hasSettingIntent || (options.inPagesScope && swap.swapInPagesScope === true)
  if (!shouldSwap) return item
  return {
    ...item,
    ...(swap.title !== undefined ? { title: swap.title } : {}),
    ...(swap.subtitle !== undefined ? { subtitle: swap.subtitle } : {}),
    intent: swap.intent,
    secondaryAction: swap.secondaryAction,
  }
}

function compareScoredSync(a: ScoredItem, b: ScoredItem): number {
  if (a.tier !== b.tier) return a.tier - b.tier
  if (b.score !== a.score) return b.score - a.score
  if (a.item.conv !== undefined && b.item.conv !== undefined) {
    const aAuto = a.item.conv.ownedBy === 'helmx' ? 1 : 0
    const bAuto = b.item.conv.ownedBy === 'helmx' ? 1 : 0
    if (aAuto !== bAuto) return aAuto - bAuto
    const aArch = isConversationArchived(a.item.conv) ? 1 : 0
    const bArch = isConversationArchived(b.item.conv) ? 1 : 0
    if (aArch !== bArch) return aArch - bArch
    if (b.item.conv.updatedAt !== a.item.conv.updatedAt) {
      return b.item.conv.updatedAt - a.item.conv.updatedAt
    }
    return b.item.conv.id - a.item.conv.id
  }
  return a.originalIdx - b.originalIdx
}

function deduplicateById(items: ReadonlyArray<OmniboxItem>): OmniboxItem[] {
  const seen = new Set<string>()
  const out: OmniboxItem[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

function buildEmptyStateView(
  input: BuildOmniboxViewInput,
  parsed: ParsedOmniboxQuery,
  frecencyEntries: ReadonlyArray<FrecencyEntry>,
): BuildOmniboxViewResult {
  const pageById = new Map<string, OmniboxItem>()
  for (const item of input.pageItems) pageById.set(item.id, item)

  // Recently visited pages/settings from bounded frecency history (newest first)
  const recentPageItems: OmniboxItem[] = []
  for (const entry of frecencyEntries) {
    if (recentPageItems.length >= EMPTY_STATE_RECENT_PAGES_LIMIT) break
    const matched = pageById.get(entry.id)
    if (matched === undefined || matched.recentEligible === false) continue
    recentPageItems.push({ ...matched, group: 'recent' })
  }

  const allCommandItems = deduplicateById([...input.contextItems, ...input.commandItems])
  const emptyQuickPages = input.pageItems.filter((item) => item.emptyStateVisible === true)
  const emptyQuickCommands = input.commandItems.filter((item) => item.emptyStateVisible === true)

  // Deduplicate empty-state `all` sections cleanly in priority order: context -> recent -> quick
  const contextDedup = deduplicateById(input.contextItems)
  const usedEmptyAllIds = new Set(contextDedup.map((item) => item.id))
  const recentCombined = deduplicateById([...input.recentConversationItems, ...recentPageItems]).filter(
    (item) => !usedEmptyAllIds.has(item.id),
  )
  for (const item of recentCombined) usedEmptyAllIds.add(item.id)
  const quickCombined = deduplicateById([...emptyQuickPages, ...emptyQuickCommands]).filter(
    (item) => !usedEmptyAllIds.has(item.id),
  )

  const scopeCounts: OmniboxScopeCounts = {
    all: contextDedup.length + recentCombined.length + quickCombined.length,
    pages: input.pageItems.length,
    commands: allCommandItems.length,
    conversations: input.conversationItems.length,
  }

  const sections: OmniboxSection[] = []

  if (parsed.effectiveScope === 'all') {
    if (contextDedup.length > 0) {
      sections.push({
        key: 'context',
        zone: 'sync',
        items: contextDedup,
        totalCount: contextDedup.length,
      })
    }
    if (recentCombined.length > 0) {
      sections.push({
        key: 'recent',
        zone: 'sync',
        items: recentCombined,
        totalCount: recentCombined.length,
      })
    }
    if (quickCombined.length > 0) {
      sections.push({
        key: 'quick',
        zone: 'sync',
        items: quickCombined,
        totalCount: quickCombined.length,
      })
    }
  } else if (parsed.effectiveScope === 'pages') {
    const pagesSwapOpts = { inPagesScope: true, hasSettingIntent: false }
    const swappedPages = input.pageItems.map((item) => applyIntentSwap(item, pagesSwapOpts))
    const prioritized = deduplicateById([
      ...recentPageItems.map((item) => applyIntentSwap(item, pagesSwapOpts)),
      ...swappedPages.filter((item) => item.emptyStateVisible === true),
      ...swappedPages,
    ]).slice(0, DEDICATED_SCOPE_SYNC_LIMIT)
    if (prioritized.length > 0) {
      sections.push({
        key: 'pages',
        zone: 'sync',
        items: prioritized,
        totalCount: input.pageItems.length,
      })
    }
  } else if (parsed.effectiveScope === 'commands') {
    const list = allCommandItems.slice(0, DEDICATED_SCOPE_SYNC_LIMIT)
    if (list.length > 0) {
      sections.push({
        key: 'commands',
        zone: 'sync',
        items: list,
        totalCount: allCommandItems.length,
      })
    }
  } else {
    // 'conversations' (including bare `#` prefix)
    const convBrowse = deduplicateById([
      ...input.recentConversationItems,
      ...input.conversationItems,
    ]).slice(0, DEDICATED_SCOPE_SYNC_LIMIT)
    if (convBrowse.length > 0) {
      sections.push({
        key: 'conversations',
        zone: 'sync',
        items: convBrowse,
        totalCount: input.conversationItems.length,
      })
    }
  }

  return {
    parsed,
    effectiveScope: parsed.effectiveScope,
    sections,
    rows: sections.flatMap((s) => s.items),
    scopeCounts,
  }
}

export function buildOmniboxView(input: BuildOmniboxViewInput): BuildOmniboxViewResult {
  const nowMs = input.nowMs ?? Date.now()
  const frecencyEntries = input.frecencyEntries ?? []
  const parsed = parseOmniboxQuery(input.query, input.scope)

  if (parsed.searchText === '') {
    return buildEmptyStateView(input, parsed, frecencyEntries)
  }

  const frecencyById = indexFrecencyEntries(frecencyEntries)
  const pageSwapOpts = {
    inPagesScope: parsed.effectiveScope === 'pages',
    hasSettingIntent: parsed.hasSettingIntent,
  }

  const scoreList = (
    items: ReadonlyArray<OmniboxItem>,
    swapOpts: { inPagesScope: boolean; hasSettingIntent: boolean } | null,
  ): ScoredItem[] => {
    const scored: ScoredItem[] = []
    items.forEach((rawItem, originalIdx) => {
      const item = swapOpts !== null ? applyIntentSwap(rawItem, swapOpts) : rawItem
      const bonus = computeFrecencyBonus(frecencyById.get(item.id), nowMs)
      const match = scoreOmniboxItem(item, parsed, bonus)
      if (match === null) return
      const enrichedSubtitle =
        match.matchedModelName !== undefined && input.formatMatchedModelSubtitle !== undefined
          ? input.formatMatchedModelSubtitle(match.matchedModelName, item.subtitle)
          : item.subtitle
      scored.push({
        item: {
          ...item,
          ...(enrichedSubtitle !== undefined ? { subtitle: enrichedSubtitle } : {}),
          titleHighlights: match.titleHighlights,
        },
        score: match.score,
        tier: match.tier,
        isExactTopHit: match.isExactTopHit,
        originalIdx,
      })
    })
    scored.sort(compareScoredSync)
    return scored
  }

  const scoredPages = scoreList(input.pageItems, pageSwapOpts)
  const allCommands = deduplicateById([...input.contextItems, ...input.commandItems])
  const scoredCommands = scoreList(allCommands, null)
  const scoredConversations = scoreList(input.conversationItems, null)

  // Async plugin items sorted by providerScore desc (then stable order); never reorder upper sync zone!
  const sortedPluginItems = deduplicateById(input.asyncPluginItems)
    .map((item, idx) => ({ item, idx, score: item.providerScore ?? 0 }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .map((entry) => entry.item)

  const asyncPagePluginItems = sortedPluginItems.filter((item) => item.scope === 'pages')
  const asyncCommandPluginItems = sortedPluginItems.filter((item) => item.scope === 'commands')

  // Deduplicate async FTS message hits against local conversation matches (skip title-only hit when conv matched locally).
  // Under strict `#<id>` pin queries, drop unrelated conversations so `#42` never leaks messages from `#99`.
  const matchedLocalConvIds = new Set(
    scoredConversations
      .map((entry) => entry.item.conv?.id)
      .filter((id): id is number => id !== undefined),
  )
  const dedupMessages: OmniboxItem[] = []
  const seenMessageIds = new Set<string>()
  for (const item of input.asyncMessageItems) {
    if (seenMessageIds.has(item.id)) continue
    if (parsed.exactConversationId !== null) {
      if (
        item.intent.type !== 'navigate' ||
        item.intent.target.kind !== 'conversation' ||
        item.intent.target.conversationId !== parsed.exactConversationId
      ) {
        continue
      }
    }
    if (
      item.intent.type === 'navigate' &&
      item.intent.target.kind === 'conversation' &&
      !item.intent.highlightEntryId &&
      matchedLocalConvIds.has(item.intent.target.conversationId)
    ) {
      continue
    }
    seenMessageIds.add(item.id)
    dedupMessages.push(item)
  }

  const pagesTotal = scoredPages.length + asyncPagePluginItems.length
  const commandsTotal = scoredCommands.length + asyncCommandPluginItems.length
  const conversationsTotal = scoredConversations.length + dedupMessages.length
  const scopeCounts: OmniboxScopeCounts = {
    all: pagesTotal + commandsTotal + conversationsTotal,
    pages: pagesTotal,
    commands: commandsTotal,
    conversations: conversationsTotal,
  }

  const sections: OmniboxSection[] = []

  if (parsed.effectiveScope === 'all') {
    // 1. Optional Top Hit (0-1, ONLY on synchronous exact match / exact #id / exact /slash)
    const exactCandidates: Array<{ source: 'pages' | 'commands' | 'conversations'; entry: ScoredItem }> = []
    const topConv = scoredConversations[0]
    if (topConv?.isExactTopHit) exactCandidates.push({ source: 'conversations', entry: topConv })
    const topCmd = scoredCommands[0]
    if (topCmd?.isExactTopHit) exactCandidates.push({ source: 'commands', entry: topCmd })
    const topPage = scoredPages[0]
    if (topPage?.isExactTopHit) exactCandidates.push({ source: 'pages', entry: topPage })

    let pinnedTopHitId: string | null = null
    if (exactCandidates.length > 0) {
      exactCandidates.sort((a, b) => {
        if (parsed.exactConversationId !== null || parsed.numericId !== null) {
          if (a.source === 'conversations' && b.source !== 'conversations') return -1
          if (b.source === 'conversations' && a.source !== 'conversations') return 1
        }
        return b.entry.score - a.entry.score
      })
      const winner = exactCandidates[0]!.entry.item
      pinnedTopHitId = winner.id
      sections.push({
        key: 'top-hit',
        zone: 'top',
        items: [{ ...winner, group: 'top-hit' }],
        totalCount: 1,
      })
    }

    // 2. Upper synchronous zone (0ms, physically isolated from async items below)
    const remainingPages = scoredPages
      .map((s) => s.item)
      .filter((item) => item.id !== pinnedTopHitId)
    if (remainingPages.length > 0) {
      const visible = remainingPages.slice(0, ALL_SCOPE_QUOTAS.pages)
      sections.push({
        key: 'pages',
        zone: 'sync',
        items: visible,
        totalCount: pagesTotal,
        ...(remainingPages.length > visible.length ? { viewAllScope: 'pages' as const } : {}),
      })
    }

    const remainingCommands = scoredCommands
      .map((s) => s.item)
      .filter((item) => item.id !== pinnedTopHitId)
    if (remainingCommands.length > 0) {
      const visible = remainingCommands.slice(0, ALL_SCOPE_QUOTAS.commands)
      sections.push({
        key: 'commands',
        zone: 'sync',
        items: visible,
        totalCount: commandsTotal,
        ...(remainingCommands.length > visible.length ? { viewAllScope: 'commands' as const } : {}),
      })
    }

    const remainingConvs = scoredConversations
      .map((s) => s.item)
      .filter((item) => item.id !== pinnedTopHitId)
    if (remainingConvs.length > 0) {
      const visible = remainingConvs.slice(0, ALL_SCOPE_QUOTAS.conversations)
      sections.push({
        key: 'conversations',
        zone: 'sync',
        items: visible,
        totalCount: conversationsTotal,
        ...(remainingConvs.length > visible.length ? { viewAllScope: 'conversations' as const } : {}),
      })
    }

    // 3. Lower asynchronous zone (200ms, NEVER reorders upper zone or steals pinned selection)
    if (sortedPluginItems.length > 0) {
      const visible = sortedPluginItems.slice(0, ALL_SCOPE_QUOTAS.resources)
      sections.push({
        key: 'resources',
        zone: 'async',
        items: visible,
        totalCount: sortedPluginItems.length,
        ...(sortedPluginItems.length > visible.length ? { viewAllScope: 'pages' as const } : {}),
      })
    }

    if (dedupMessages.length > 0) {
      const visible = dedupMessages.slice(0, ALL_SCOPE_QUOTAS.messages)
      sections.push({
        key: 'messages',
        zone: 'async',
        items: visible,
        totalCount: dedupMessages.length,
        ...(dedupMessages.length > visible.length ? { viewAllScope: 'conversations' as const } : {}),
      })
    }
  } else if (parsed.effectiveScope === 'pages') {
    const syncList = scoredPages.slice(0, DEDICATED_SCOPE_SYNC_LIMIT).map((s) => s.item)
    if (syncList.length > 0) {
      sections.push({
        key: 'pages',
        zone: 'sync',
        items: syncList,
        totalCount: scoredPages.length,
      })
    }
    const asyncList = asyncPagePluginItems.slice(0, DEDICATED_SCOPE_ASYNC_LIMIT)
    if (asyncList.length > 0) {
      sections.push({
        key: 'resources',
        zone: 'async',
        items: asyncList,
        totalCount: asyncPagePluginItems.length,
      })
    }
  } else if (parsed.effectiveScope === 'commands') {
    const syncList = scoredCommands.slice(0, DEDICATED_SCOPE_SYNC_LIMIT).map((s) => s.item)
    if (syncList.length > 0) {
      sections.push({
        key: 'commands',
        zone: 'sync',
        items: syncList,
        totalCount: scoredCommands.length,
      })
    }
    const asyncList = asyncCommandPluginItems.slice(0, DEDICATED_SCOPE_ASYNC_LIMIT)
    if (asyncList.length > 0) {
      sections.push({
        key: 'resources',
        zone: 'async',
        items: asyncList,
        totalCount: asyncCommandPluginItems.length,
      })
    }
  } else {
    // 'conversations'
    const syncList = scoredConversations.slice(0, DEDICATED_SCOPE_SYNC_LIMIT).map((s) => s.item)
    if (syncList.length > 0) {
      sections.push({
        key: 'conversations',
        zone: 'sync',
        items: syncList,
        totalCount: scoredConversations.length,
      })
    }
    const asyncList = dedupMessages.slice(0, DEDICATED_SCOPE_ASYNC_LIMIT)
    if (asyncList.length > 0) {
      sections.push({
        key: 'messages',
        zone: 'async',
        items: asyncList,
        totalCount: dedupMessages.length,
      })
    }
  }

  return {
    parsed,
    effectiveScope: parsed.effectiveScope,
    sections,
    rows: sections.flatMap((s) => s.items),
    scopeCounts,
  }
}

export function resolveSelectedIndex(rows: ReadonlyArray<OmniboxItem>, selectedId: string | null): number {
  if (rows.length === 0) return -1
  if (selectedId !== null) {
    const idx = rows.findIndex((row) => row.id === selectedId)
    if (idx !== -1) return idx
  }
  return 0
}
