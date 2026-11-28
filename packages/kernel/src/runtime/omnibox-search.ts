/**
 * Global Omnibox async search aggregation (composition layer above ConversationService + PluginHost).
 *
 * Keeps `ConversationService.search` (`GET /api/search`) completely pure and decoupled from
 * `PluginHost`, while running FTS5 message search and all active `helmx.search` capability
 * providers in parallel with strict per-plugin timeout isolation, runtime shape validation,
 * per-plugin result caps, SecretStash redaction, and honest partial-failure diagnostics.
 */
import {
  HELMX_SEARCH_CAPABILITY_ID,
  PLUGIN_SEARCH_ITEM_KINDS,
  compareCodeUnit,
  isPlainObject,
  parseNonEmptyLocalizedText,
  type HelmxLocale,
  type LocalizedText,
  type OmniboxPluginHit,
  type OmniboxSearchQuery,
  type OmniboxSearchResponse,
  type PluginSearchItemKind,
  type PluginSearchProvider,
  type PluginSearchQuery,
  type ProvidedCapability,
  type SearchHit,
} from '@helmx/protocol'
import type { PluginHost } from '../plugins/index.js'
import type { ConversationService } from './conversation-service.js'
import { DEFAULT_SEARCH_LIMIT } from './fts-search.js'

export const OMNIBOX_DEFAULT_LIMIT = DEFAULT_SEARCH_LIMIT
export const OMNIBOX_MAX_ITEMS_PER_PLUGIN = 8
export const OMNIBOX_DEFAULT_PROVIDER_TIMEOUT_MS = 200

const MAX_ITEM_ID_LENGTH = 256
const MAX_TARGET_LENGTH = 512
const MAX_ICON_LENGTH = 64
const MAX_FOCUS_ANCHOR_LENGTH = 256
const MAX_BREADCRUMB_SEGMENTS = 8
const MAX_RAW_ITEMS_INSPECTED_PER_PROVIDER = 256
const SINGLE_LINE_CONTROL_RE = /[\r\n\t\x00-\x1f\x7f]/
const VALID_KINDS: ReadonlySet<string> = new Set(PLUGIN_SEARCH_ITEM_KINDS)

export interface OmniboxSearchDeps {
  readonly conversations: Pick<ConversationService, 'search'>
  readonly plugins: Pick<PluginHost, 'consumeCapability'>
}

export interface OmniboxSearchOptions {
  readonly signal?: AbortSignal
  readonly redact?: (text: string) => string
  /** Per-provider execution budget in milliseconds (defaults to `OMNIBOX_DEFAULT_PROVIDER_TIMEOUT_MS`). */
  readonly providerTimeoutMs?: number
}

const identityRedact = (text: string): string => text

function parseBoundedSingleLineString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength || SINGLE_LINE_CONTROL_RE.test(trimmed)) {
    return undefined
  }
  return trimmed
}

function redactLocalizedText(value: LocalizedText, redact: (text: string) => string): LocalizedText {
  if (typeof value === 'string') return redact(value)
  const out: Partial<Record<HelmxLocale, string>> = {}
  for (const [locale, text] of Object.entries(value)) {
    if (typeof text === 'string') {
      out[locale as HelmxLocale] = redact(text)
    }
  }
  return out
}

function validateAndProjectPluginHit(
  pluginId: string,
  raw: unknown,
  redact: (text: string) => string,
): OmniboxPluginHit | undefined {
  if (!isPlainObject(raw)) return undefined

  const itemId = parseBoundedSingleLineString(raw['id'], MAX_ITEM_ID_LENGTH)
  if (itemId === undefined) return undefined

  const target = parseBoundedSingleLineString(raw['target'], MAX_TARGET_LENGTH)
  if (target === undefined) return undefined

  const title = parseNonEmptyLocalizedText(raw['title'])
  if (title === undefined) return undefined

  let kind: PluginSearchItemKind | undefined
  if (raw['kind'] !== undefined) {
    if (typeof raw['kind'] !== 'string' || !VALID_KINDS.has(raw['kind'])) return undefined
    kind = raw['kind'] as PluginSearchItemKind
  }

  let subtitle: LocalizedText | undefined
  if (raw['subtitle'] !== undefined) {
    subtitle = parseNonEmptyLocalizedText(raw['subtitle'])
    if (subtitle === undefined) return undefined
  }

  let breadcrumb: LocalizedText[] | undefined
  if (raw['breadcrumb'] !== undefined) {
    if (!Array.isArray(raw['breadcrumb']) || raw['breadcrumb'].length > MAX_BREADCRUMB_SEGMENTS) {
      return undefined
    }
    const parsedSegments: LocalizedText[] = []
    for (const seg of raw['breadcrumb']) {
      const parsed = parseNonEmptyLocalizedText(seg)
      if (parsed === undefined) return undefined
      parsedSegments.push(redactLocalizedText(parsed, redact))
    }
    if (parsedSegments.length > 0) breadcrumb = parsedSegments
  }

  let icon: string | undefined
  if (raw['icon'] !== undefined) {
    icon = parseBoundedSingleLineString(raw['icon'], MAX_ICON_LENGTH)
    if (icon === undefined) return undefined
  }

  let badge: LocalizedText | undefined
  if (raw['badge'] !== undefined) {
    badge = parseNonEmptyLocalizedText(raw['badge'])
    if (badge === undefined) return undefined
  }

  let focusAnchor: string | undefined
  if (raw['focusAnchor'] !== undefined) {
    focusAnchor = parseBoundedSingleLineString(raw['focusAnchor'], MAX_FOCUS_ANCHOR_LENGTH)
    if (focusAnchor === undefined) return undefined
  }

  let score: number | undefined
  if (raw['score'] !== undefined) {
    if (typeof raw['score'] !== 'number' || !Number.isFinite(raw['score'])) return undefined
    score = Math.min(100, Math.max(0, raw['score']))
  }

  return {
    pluginId,
    itemId,
    id: `${pluginId}/${itemId}`,
    ...(kind !== undefined ? { kind } : {}),
    title: redactLocalizedText(title, redact),
    ...(subtitle !== undefined ? { subtitle: redactLocalizedText(subtitle, redact) } : {}),
    ...(breadcrumb !== undefined ? { breadcrumb } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(badge !== undefined ? { badge: redactLocalizedText(badge, redact) } : {}),
    target: redact(target),
    ...(focusAnchor !== undefined ? { focusAnchor: redact(focusAnchor) } : {}),
    ...(score !== undefined ? { score } : {}),
  }
}

function redactMessageHit(hit: SearchHit, redact: (text: string) => string): SearchHit {
  const redactedSnippet = redact(hit.snippet)
  const snippetChanged = redactedSnippet !== hit.snippet
  const redactedTitle = hit.title !== undefined ? redact(hit.title) : undefined
  return {
    ...hit,
    snippet: redactedSnippet,
    ...(redactedTitle !== undefined ? { title: redactedTitle } : {}),
    ...(hit.highlights !== undefined ? { highlights: snippetChanged ? [] : hit.highlights } : {}),
  }
}

async function invokeProviderWithTimeout(
  entry: ProvidedCapability<PluginSearchProvider>,
  searchQuery: PluginSearchQuery,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ ok: true; items: unknown[] } | { ok: false }> {
  if (
    entry.impl === null ||
    typeof entry.impl !== 'object' ||
    typeof entry.impl.search !== 'function'
  ) {
    return { ok: false }
  }
  if (parentSignal?.aborted) {
    return { ok: false }
  }

  const controller = new AbortController()
  const onParentAbort = (): void => {
    controller.abort(parentSignal?.reason ?? new Error('omnibox search aborted'))
  }
  parentSignal?.addEventListener('abort', onParentAbort, { once: true })

  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  try {
    const providerPromise = Promise.resolve().then(() =>
      entry.impl.search(searchQuery, controller.signal),
    )
    // Suppress unhandled rejection if provider rejects after timeout wins the race.
    providerPromise.catch(() => {})

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (!settled) {
          controller.abort(new Error(`plugin ${entry.pluginId} search timed out after ${timeoutMs}ms`))
          reject(new Error('timeout'))
        }
      }, timeoutMs)
      timer.unref?.()
    })

    const result = await Promise.race([providerPromise, timeoutPromise])
    settled = true
    if (controller.signal.aborted || !Array.isArray(result)) {
      return { ok: false }
    }
    return { ok: true, items: result }
  } catch {
    settled = true
    return { ok: false }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    parentSignal?.removeEventListener('abort', onParentAbort)
  }
}

/**
 * Runs conversation FTS5 search and all active `helmx.search` capability providers in parallel.
 * Never crashes the full response when FTS or any individual plugin provider fails or times out;
 * surfaces honest `messagesUnavailable` and `failedPlugins` diagnostics instead.
 */
export async function runOmniboxSearch(
  deps: OmniboxSearchDeps,
  input: OmniboxSearchQuery,
  options: OmniboxSearchOptions = {},
): Promise<OmniboxSearchResponse> {
  const query = input.q.trim()
  const messagesLimit = input.limit ?? OMNIBOX_DEFAULT_LIMIT
  const perPluginLimit = Math.min(input.limit ?? OMNIBOX_MAX_ITEMS_PER_PLUGIN, OMNIBOX_MAX_ITEMS_PER_PLUGIN)
  const timeoutMs = options.providerTimeoutMs ?? OMNIBOX_DEFAULT_PROVIDER_TIMEOUT_MS
  const redact = options.redact ?? identityRedact

  const providers = deps.plugins.consumeCapability<PluginSearchProvider>(HELMX_SEARCH_CAPABILITY_ID)

  const pluginQuery: PluginSearchQuery = {
    query,
    limit: perPluginLimit,
    ...(input.locale !== undefined ? { locale: input.locale } : {}),
    ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
  }

  const messagesPromise = (async (): Promise<{ messages: SearchHit[]; unavailable: boolean }> => {
    try {
      const rawHits = await Promise.resolve().then(() =>
        deps.conversations.search(query, { limit: messagesLimit }),
      )
      if (!Array.isArray(rawHits)) {
        return { messages: [], unavailable: true }
      }
      return {
        messages: rawHits.map((hit) => redactMessageHit(hit, redact)),
        unavailable: false,
      }
    } catch {
      return { messages: [], unavailable: true }
    }
  })()

  const providersPromise = Promise.all(
    providers.map(async (entry) => ({
      pluginId: entry.pluginId,
      outcome: await invokeProviderWithTimeout(entry, pluginQuery, options.signal, timeoutMs),
    })),
  )

  const [messagesOutcome, providerOutcomes] = await Promise.all([messagesPromise, providersPromise])

  const failedPluginSet = new Set<string>()
  const acceptedByPlugin = new Map<string, Set<string>>()
  const pluginItems: OmniboxPluginHit[] = []

  for (const { pluginId, outcome } of providerOutcomes) {
    if (!outcome.ok) {
      failedPluginSet.add(pluginId)
      continue
    }
    let seenIds = acceptedByPlugin.get(pluginId)
    if (seenIds === undefined) {
      seenIds = new Set<string>()
      acceptedByPlugin.set(pluginId, seenIds)
    }
    const maxScan = Math.min(outcome.items.length, MAX_RAW_ITEMS_INSPECTED_PER_PROVIDER)
    for (let i = 0; i < maxScan && seenIds.size < perPluginLimit; i += 1) {
      const projected = validateAndProjectPluginHit(pluginId, outcome.items[i], redact)
      if (projected === undefined) continue
      if (seenIds.has(projected.itemId)) continue
      seenIds.add(projected.itemId)
      pluginItems.push(projected)
    }
  }

  pluginItems.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

  const failedPlugins = [...failedPluginSet].sort(compareCodeUnit)
  return {
    query,
    messages: messagesOutcome.messages,
    pluginItems,
    ...(messagesOutcome.unavailable ? { messagesUnavailable: true } : {}),
    ...(failedPlugins.length > 0 ? { failedPlugins } : {}),
  }
}
