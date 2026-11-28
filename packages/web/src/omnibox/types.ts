/**
 * Unified data contract for the clean-slate Helmx Omnibox (zero React / DOM deps).
 * Replaces the legacy PaletteCommandRow | PaletteSearchHitRow split with a single
 * OmniboxItem model carrying weighted search terms, typed intents, optional secondary
 * actions, and sync/async zone metadata.
 */
import type { CommandSpec, ConversationSummary } from '@helmx/protocol/browser'
import type { FocusedPanel, ResolvedTarget } from '../lib/types.js'

export const OMNIBOX_SCOPES = ['all', 'pages', 'commands', 'conversations'] as const
export type OmniboxScope = (typeof OMNIBOX_SCOPES)[number]
export type DedicatedOmniboxScope = Exclude<OmniboxScope, 'all'>

export type OmniboxKind =
  | 'page'
  | 'setting'
  | 'command'
  | 'conversation'
  | 'message'
  | 'resource'

export type OmniboxGroupKey =
  | 'context'
  | 'recent'
  | 'quick'
  | 'top-hit'
  | 'pages'
  | 'commands'
  | 'conversations'
  | 'resources'
  | 'messages'

export type OmniboxZone = 'top' | 'sync' | 'async'

export type OmniboxBadgeTone = 'neutral' | 'ok' | 'warn' | 'accent'

export interface OmniboxStatusBadge {
  label: string
  tone?: OmniboxBadgeTone
}

export type OmniboxIntent =
  | {
      type: 'navigate'
      target: ResolvedTarget
      focusAnchor?: string
      highlightEntryId?: string
    }
  | {
      type: 'workbench'
      tab: string
      conversationId?: number
      params?: Record<string, unknown>
    }
  | {
      type: 'run'
      run: () => void
      /** Prevents Dialog onCloseAutoFocus from reclaiming focus when the command focuses another target (e.g. composer, shortcuts modal, model picker). */
      skipCloseAutoFocus?: boolean
    }
  | {
      type: 'preview'
      pluginId: string
      spec: CommandSpec
    }

export interface OmniboxSecondaryAction {
  label: string
  icon?: string
  intent: OmniboxIntent
}

export interface OmniboxSearchTerms {
  /** Primary display titles & canonical labels across all locales (highest weight). */
  primary: ReadonlyArray<string>
  /** Breadcrumb / parent center / owning plugin names across all locales (medium weight). */
  breadcrumb?: ReadonlyArray<string>
  /** Descriptions, keywords, child model IDs, CLI paths, slash words, tags (lower weight). */
  aliases?: ReadonlyArray<string>
  /** Exact triggers eligible for Top Hit promotion (e.g. '/plan', canonical IDs). */
  exactTokens?: ReadonlyArray<string>
}

export interface SearchHighlightSpan {
  /** Inclusive UTF-16 start offset. */
  start: number
  /** Exclusive UTF-16 end offset (end > start). */
  end: number
}

export interface HighlightSegment {
  text: string
  highlighted: boolean
}

export interface OmniboxProviderModelHint {
  id: string
  name: string
}

/**
 * Declarative intent swap for single-entity dedup items (e.g., Profiles,
 * screen-bearing Plugins) when browsing the Pages scope or querying with
 * settings/configuration intent.
 */
export interface OmniboxSettingIntentSwap {
  /** When true, also swaps primary/secondary when browsing the `pages` scope (e.g. Profiles). When false/omitted, swaps only on explicit setting/config query intent (e.g. plugin Screens). */
  swapInPagesScope?: boolean
  title?: string
  subtitle?: string
  intent: OmniboxIntent
  secondaryAction: OmniboxSecondaryAction
}

export interface OmniboxItem {
  id: string
  kind: OmniboxKind
  scope: DedicatedOmniboxScope
  group: OmniboxGroupKey
  title: string
  breadcrumb?: ReadonlyArray<string>
  subtitle?: string
  /** Optional trailing monospace metadata (e.g. `#42` on conversations/messages). */
  metaText?: string
  icon?: string
  statusBadge?: OmniboxStatusBadge
  shortcut?: string
  searchTerms: OmniboxSearchTerms
  intent: OmniboxIntent
  secondaryAction?: OmniboxSecondaryAction
  conv?: ConversationSummary
  /** Backend-provided UTF-16 highlight spans on message snippets (empty array = honest no-highlight). */
  snippetHighlights?: ReadonlyArray<SearchHighlightSpan>
  /** Computed UTF-16 highlight spans on `title` for the current query. */
  titleHighlights?: ReadonlyArray<SearchHighlightSpan>
  /** True for 200ms async backend hits (placed strictly below sync items). */
  isAsync?: boolean
  /** Backend provider relevance score (0..100). */
  providerScore?: number
  /** Whether this item appears in the curated empty-state view for `all` scope. */
  emptyStateVisible?: boolean
  /** Whether selecting this item records it for empty-state Recent recall. */
  recentEligible?: boolean
  /** Child model descriptors on provider entries for reverse model-to-provider search notes. */
  providerModels?: ReadonlyArray<OmniboxProviderModelHint>
  /** Optional primary/secondary swap under Pages scope or setting/config intent. */
  settingIntentSwap?: OmniboxSettingIntentSwap
}

export interface OmniboxSection {
  key: OmniboxGroupKey
  zone: OmniboxZone
  items: OmniboxItem[]
  /** Full number of matched items before Top-K truncation in `all` scope. */
  totalCount: number
  /** Dedicated scope tab to jump to when truncated (renders "View all N · Tab"). */
  viewAllScope?: DedicatedOmniboxScope
}

export type OmniboxScopeCounts = Record<OmniboxScope, number>

export type OmniboxPrefixMode = '>' | '#' | null

export interface ParsedOmniboxQuery {
  raw: string
  trimmed: string
  prefixMode: OmniboxPrefixMode
  effectiveScope: OmniboxScope
  searchText: string
  searchLower: string
  tokens: ReadonlyArray<string>
  /** Exact `#123` conversation pin (only when raw trimmed is `#<positive-int>`). */
  exactConversationId: number | null
  /** Plain positive integer query (e.g. `123`). */
  numericId: number | null
  /** True when the user's query expresses configuration/settings intent. */
  hasSettingIntent: boolean
}

export interface OmniboxNavigationDispatch {
  target: ResolvedTarget
  split: boolean
  focusAnchor?: string
  highlightEntryId?: string
}

export type OmniboxEscapeAction =
  | 'ignore-ime'
  | 'close-preview'
  | 'clear-query'
  | 'reset-scope'
  | 'close-modal'

export interface OmniboxPreviewCommand {
  pluginId: string
  spec: CommandSpec
}

export function resolveIntentNavigation(
  intent: OmniboxIntent,
  activePanel: FocusedPanel,
  forceSplit: boolean,
): OmniboxNavigationDispatch | null {
  if (intent.type !== 'navigate') return null
  return {
    target: intent.target,
    split: forceSplit || activePanel === 'split',
    ...(intent.focusAnchor !== undefined ? { focusAnchor: intent.focusAnchor } : {}),
    ...(intent.highlightEntryId !== undefined ? { highlightEntryId: intent.highlightEntryId } : {}),
  }
}
