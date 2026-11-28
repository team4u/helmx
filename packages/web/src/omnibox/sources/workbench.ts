/**
 * 0ms synchronous Workbench panel entries (active conversation context only):
 * host `artifacts` tab + all conversation-scoped `groupedUi.workbenchPanels`.
 */
import { resolveLocalizedText, type ConversationSummary, type HelmxLocale, type PluginSummary } from '@helmx/protocol/browser'
import { WORKBENCH_ARTIFACTS_TAB_ID } from '../../conversation/workbench-model.js'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import { matchesUiScope, type GroupedUiSpecs } from '../../lib/types.js'
import type { OmniboxItem } from '../types.js'
import { dedupeStrings, extractLocalizedStrings } from './helpers.js'

export interface BuildWorkbenchItemsInput {
  activeConversation: ConversationSummary | undefined
  workbenchPanels: GroupedUiSpecs['workbenchPanels']
  plugins: ReadonlyArray<PluginSummary>
  locale: HelmxLocale
  t: WebMessageTranslator
}

export function buildWorkbenchItems(input: BuildWorkbenchItemsInput): OmniboxItem[] {
  const { activeConversation, workbenchPanels, plugins, locale, t } = input
  if (activeConversation === undefined) return []

  const items: OmniboxItem[] = []
  const pluginById = new Map(plugins.map((p) => [p.id, p] as const))
  const workbenchCrumb = t('modals.omnibox.crumb.workbench')

  // Host built-in Artifacts tab
  const artifactsLabel = t('conv.workbench.artifactsTab')
  items.push({
    id: `workbench:${WORKBENCH_ARTIFACTS_TAB_ID}`,
    kind: 'command',
    scope: 'commands',
    group: 'commands',
    title: t('modals.omnibox.cmd.openWorkbenchTab', { label: artifactsLabel }),
    breadcrumb: [workbenchCrumb],
    icon: 'package',
    emptyStateVisible: false,
    searchTerms: {
      primary: dedupeStrings([
        t('modals.omnibox.cmd.openWorkbenchTab', { label: artifactsLabel }),
        artifactsLabel,
        'Artifacts',
        '产物',
      ]),
      breadcrumb: dedupeStrings([workbenchCrumb, 'Workbench', '工作台']),
      aliases: ['workbench', 'artifacts', 'files', 'attachments', '工作台', '产物', '附件'],
    },
    intent: {
      type: 'workbench',
      tab: WORKBENCH_ARTIFACTS_TAB_ID,
      conversationId: activeConversation.id,
    },
  })

  // Scoped plugin workbench.panel contributions
  for (const panel of workbenchPanels) {
    if (!matchesUiScope(activeConversation, panel.spec.scope)) continue
    const plugin = pluginById.get(panel.pluginId)
    const pluginName =
      plugin !== undefined ? resolveLocalizedText(plugin.name, locale) || panel.pluginId : panel.pluginId
    const label = resolveLocalizedText(panel.spec.label, locale) || panel.spec.id
    const tabId = `plugin:${panel.pluginId}/${panel.spec.id}`

    items.push({
      id: `workbench:${panel.pluginId}/${panel.spec.id}`,
      kind: 'command',
      scope: 'commands',
      group: 'commands',
      title: t('modals.omnibox.cmd.openWorkbenchTab', { label }),
      breadcrumb: [workbenchCrumb, pluginName],
      icon: panel.spec.icon ?? 'panel-right',
      emptyStateVisible: false,
      searchTerms: {
        primary: dedupeStrings([
          t('modals.omnibox.cmd.openWorkbenchTab', { label }),
          label,
          ...extractLocalizedStrings(panel.spec.label),
          panel.spec.id,
        ]),
        breadcrumb: dedupeStrings([
          workbenchCrumb,
          pluginName,
          ...(plugin !== undefined ? extractLocalizedStrings(plugin.name) : []),
          'Workbench',
          '工作台',
        ]),
        aliases: dedupeStrings([
          panel.pluginId,
          `${panel.pluginId}/${panel.spec.id}`,
          'workbench',
          'panel',
          'drawer',
          '工作台',
          '面板',
        ]),
      },
      intent: {
        type: 'workbench',
        tab: tabId,
        conversationId: activeConversation.id,
      },
    })
  }

  return items
}
