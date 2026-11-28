/**
 * 0ms synchronous plugin settings panels (`ctx.ui.settingsPanel`) and
 * plugin configuration fields (`GET /api/plugins/config-catalog`) source builder.
 * Every item navigates to `#/settings/plugins/<pluginId>` with a matching
 * `focusAnchor` (`panel:<pluginId>/<panelId>` or `config:<pluginId>/<fieldKey>`).
 */
import {
  resolveLocalizedText,
  type HelmxLocale,
  type PluginConfigCatalogEntry,
  type PluginSummary,
} from '@helmx/protocol/browser'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import type { GroupedUiSpecs } from '../../lib/types.js'
import type { OmniboxItem } from '../types.js'
import { dedupeStrings, extractLocalizedStrings, resolveOptionalLocalizedText } from './helpers.js'

export interface BuildSettingsItemsInput {
  settingsPanels: GroupedUiSpecs['settingsPanels']
  pluginConfigCatalog: ReadonlyArray<PluginConfigCatalogEntry>
  plugins: ReadonlyArray<PluginSummary>
  locale: HelmxLocale
  t: WebMessageTranslator
}

export function buildSettingsItems(input: BuildSettingsItemsInput): OmniboxItem[] {
  const { settingsPanels, pluginConfigCatalog, plugins, locale, t } = input
  const items: OmniboxItem[] = []
  const pluginById = new Map(plugins.map((p) => [p.id, p] as const))
  const settingsCrumb = t('modals.omnibox.crumb.pluginSettings')
  const configCrumb = t('modals.omnibox.crumb.pluginConfig')

  // 1. Plugin `ctx.ui.settingsPanel` contributions
  for (const panel of settingsPanels) {
    const { spec } = panel
    const plugin = pluginById.get(panel.pluginId)
    const pluginName =
      plugin !== undefined ? resolveLocalizedText(plugin.name, locale) || panel.pluginId : panel.pluginId
    const label = resolveLocalizedText(spec.label, locale) || spec.id
    const description = resolveOptionalLocalizedText(spec.description, locale)

    items.push({
      id: `settings-panel:${panel.pluginId}/${spec.id}`,
      kind: 'setting',
      scope: 'pages',
      group: 'pages',
      title: label,
      breadcrumb: [settingsCrumb, pluginName],
      ...(description !== undefined ? { subtitle: description } : {}),
      icon: 'layout',
      emptyStateVisible: false,
      recentEligible: true,
      searchTerms: {
        primary: dedupeStrings([label, ...extractLocalizedStrings(spec.label), spec.id]),
        breadcrumb: dedupeStrings([
          settingsCrumb,
          pluginName,
          ...(plugin !== undefined ? extractLocalizedStrings(plugin.name) : []),
          panel.pluginId,
        ]),
        aliases: dedupeStrings([
          ...extractLocalizedStrings(spec.description),
          ...(spec.keywords ?? []),
          `${panel.pluginId}/${spec.id}`,
          'settings',
          'panel',
          'config',
          '设置',
          '面板',
          '配置',
        ]),
        exactTokens: dedupeStrings([`${panel.pluginId}/${spec.id}`]),
      },
      intent: {
        type: 'navigate',
        target: { kind: 'plugins', pluginId: panel.pluginId },
        focusAnchor: `panel:${panel.pluginId}/${spec.id}`,
      },
    })
  }

  // 2. Plugin configuration schema fields from `/api/plugins/config-catalog`
  for (const entry of pluginConfigCatalog) {
    const pluginName = resolveLocalizedText(entry.pluginName, locale) || entry.pluginId
    for (const field of entry.fields) {
      const label = resolveOptionalLocalizedText(field.label, locale) ?? field.key
      const description = resolveOptionalLocalizedText(field.description, locale)

      items.push({
        id: `plugin-config:${entry.pluginId}/${field.key}`,
        kind: 'setting',
        scope: 'pages',
        group: 'pages',
        title: label,
        breadcrumb: [configCrumb, pluginName],
        subtitle: description ?? field.key,
        icon: field.secret ? 'lock' : 'sliders',
        ...(!entry.enabled
          ? { statusBadge: { label: t('modals.omnibox.status.disabled'), tone: 'neutral' as const } }
          : {}),
        emptyStateVisible: false,
        recentEligible: true,
        searchTerms: {
          primary: dedupeStrings([label, ...extractLocalizedStrings(field.label), field.key]),
          breadcrumb: dedupeStrings([
            configCrumb,
            pluginName,
            ...extractLocalizedStrings(entry.pluginName),
            entry.pluginId,
          ]),
          aliases: dedupeStrings([
            ...extractLocalizedStrings(field.description),
            `${entry.pluginId}.${field.key}`,
            `${entry.pluginId}/${field.key}`,
            field.format,
            field.type,
            'config',
            'setting',
            'configuration',
            '配置',
            '设置',
          ]),
          exactTokens: dedupeStrings([`${entry.pluginId}.${field.key}`, `${entry.pluginId}/${field.key}`]),
        },
        intent: {
          type: 'navigate',
          target: { kind: 'plugins', pluginId: entry.pluginId },
          focusAnchor: `config:${entry.pluginId}/${field.key}`,
        },
      })
    }
  }

  return items
}
