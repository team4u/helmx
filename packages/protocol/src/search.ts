/**
 * Global Omnibox search & plugin config catalog contracts (browser-safe: zero `node:*`,
 * zero `typebox`, zero `@earendil-works/pi-*` dependencies).
 *
 * Exported jointly by `@helmx/protocol` and `@helmx/protocol/browser`.
 */
import type { SearchHit } from './http.js'
import type { HelmxLocale, LocalizedText } from './locale.js'
import type { MaybePromise } from './plugin-dto.js'
import type { PluginManifestConfigField } from './plugin-manifest.js'

/** Capability ID registered via `ctx.provide(HELMX_SEARCH_CAPABILITY_ID, provider)` for Omnibox dynamic search. */
export const HELMX_SEARCH_CAPABILITY_ID = 'helmx.search' as const

/** Allowed item kinds for plugin dynamic search results. */
export const PLUGIN_SEARCH_ITEM_KINDS = ['page', 'setting', 'resource', 'command'] as const
export type PluginSearchItemKind = (typeof PLUGIN_SEARCH_ITEM_KINDS)[number]

/** Query passed to active `helmx.search` capability providers. */
export interface PluginSearchQuery {
  query: string
  limit: number
  locale?: HelmxLocale
  conversationId?: number
}

/** Single search item returned by a plugin `helmx.search` provider. */
export interface PluginSearchItem {
  id: string
  kind?: PluginSearchItemKind
  title: LocalizedText
  subtitle?: LocalizedText
  breadcrumb?: LocalizedText[]
  icon?: string
  badge?: LocalizedText
  target: string
  focusAnchor?: string
  score?: number
}

/** Backend dynamic search capability implemented by plugins via `ctx.provide('helmx.search', provider)`. */
export interface PluginSearchProvider {
  search(input: PluginSearchQuery, signal: AbortSignal): MaybePromise<PluginSearchItem[]>
}

/** Plugin dynamic search hit returned by `GET /api/omnibox/search` (`id` is `${pluginId}/${itemId}`). */
export interface OmniboxPluginHit extends Omit<PluginSearchItem, 'id'> {
  pluginId: string
  itemId: string
  id: string
}

/** Validated query parameters of `GET /api/omnibox/search`. */
export interface OmniboxSearchQuery {
  q: string
  limit?: number
  locale?: HelmxLocale
  conversationId?: number
}

/** Aggregated response of `GET /api/omnibox/search`. */
export interface OmniboxSearchResponse {
  query: string
  messages: SearchHit[]
  pluginItems: OmniboxPluginHit[]
  messagesUnavailable?: boolean
  failedPlugins?: string[]
}

/** Static, secret-stripped plugin config schema entry returned by `GET /api/plugins/config-catalog`. */
export interface PluginConfigCatalogEntry {
  pluginId: string
  pluginName: LocalizedText
  pluginIcon?: string
  enabled: boolean
  fields: PluginManifestConfigField[]
}
