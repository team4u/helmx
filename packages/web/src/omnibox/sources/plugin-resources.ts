/**
 * Maps asynchronous `/api/omnibox/search` `pluginItems` (`OmniboxPluginHit[]`)
 * into unified `OmniboxItem` rows with strict target validation.
 */
import {
  resolveLocalizedText,
  type ConversationSummary,
  type HelmxLocale,
  type OmniboxPluginHit,
  type PluginSummary,
} from '@helmx/protocol/browser'
import { resolveTargetString } from '../../lib/types.js'
import type { DedicatedOmniboxScope, OmniboxItem, OmniboxKind } from '../types.js'
import { dedupeStrings, extractLocalizedStrings, resolveOptionalLocalizedText } from './helpers.js'

export function buildAsyncPluginResourceItems(
  hits: ReadonlyArray<OmniboxPluginHit>,
  conversations: ReadonlyArray<ConversationSummary>,
  plugins: ReadonlyArray<PluginSummary>,
  locale: HelmxLocale,
): OmniboxItem[] {
  const pluginById = new Map(plugins.map((p) => [p.id, p] as const))
  const out: OmniboxItem[] = []
  const seen = new Set<string>()

  for (const hit of hits) {
    if (seen.has(hit.id)) continue
    const resolvedTarget = resolveTargetString(hit.target, [...conversations])
    if (resolvedTarget === null) continue
    seen.add(hit.id)

    const title = resolveLocalizedText(hit.title, locale).trim()
    if (title === '') continue
    const subtitle = resolveOptionalLocalizedText(hit.subtitle, locale)
    const badgeLabel = resolveOptionalLocalizedText(hit.badge, locale)
    const plugin = pluginById.get(hit.pluginId)
    const pluginName =
      plugin !== undefined ? resolveLocalizedText(plugin.name, locale) || hit.pluginId : hit.pluginId
    const breadcrumb =
      Array.isArray(hit.breadcrumb) && hit.breadcrumb.length > 0
        ? hit.breadcrumb
            .map((part) => resolveLocalizedText(part, locale).trim())
            .filter(Boolean)
        : [pluginName]

    const kind: OmniboxKind = hit.kind ?? 'resource'
    const scope: DedicatedOmniboxScope = kind === 'command' ? 'commands' : 'pages'

    out.push({
      id: `plugin-hit:${hit.id}`,
      kind,
      scope,
      group: 'resources',
      title,
      ...(breadcrumb.length > 0 ? { breadcrumb } : {}),
      ...(subtitle !== undefined ? { subtitle } : {}),
      icon: hit.icon ?? 'puzzle',
      ...(badgeLabel !== undefined ? { statusBadge: { label: badgeLabel, tone: 'neutral' as const } } : {}),
      isAsync: true,
      ...(typeof hit.score === 'number' && Number.isFinite(hit.score) ? { providerScore: hit.score } : {}),
      searchTerms: {
        primary: dedupeStrings([title, ...extractLocalizedStrings(hit.title)]),
        breadcrumb: dedupeStrings([
          ...breadcrumb,
          ...(hit.breadcrumb ?? []).flatMap((b) => extractLocalizedStrings(b)),
          hit.pluginId,
        ]),
        aliases: dedupeStrings([
          ...extractLocalizedStrings(hit.subtitle),
          hit.itemId,
          hit.id,
        ]),
      },
      intent: {
        type: 'navigate',
        target: resolvedTarget,
        ...(typeof hit.focusAnchor === 'string' && hit.focusAnchor.trim() !== ''
          ? { focusAnchor: hit.focusAnchor.trim() }
          : {}),
      },
    })
  }

  return out
}
