/**
 * Pure presentation helpers for DrawerStackShell (breadcrumb titles, frame
 * labels, dialog aria labels). Kept separate from .tsx to obey Fast Refresh.
 */
import type { ConversationSummary, HelmxLocale } from '@helmx/protocol/browser'
import { resolveLocalizedText } from '@helmx/protocol/browser'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import type { DrawerFrame, GroupedUiSpecs } from '../lib/types.js'

export function meaningfulDrawerTitle(title: string | undefined, conversationId: number): string | undefined {
  const trimmed = title?.trim()
  if (!trimmed) return undefined
  if (
    trimmed.toLowerCase() === `subagent ${conversationId}` ||
    trimmed === `子代理 ${conversationId}` ||
    trimmed === `子会话 ${conversationId}`
  ) {
    return undefined
  }
  return trimmed
}

export function resolveWorkbenchTabTitle(
  tab: string,
  workbenchPanels: GroupedUiSpecs['workbenchPanels'],
  locale: HelmxLocale,
  t: WebMessageTranslator,
): string {
  if (tab === 'artifacts') return t('conv.workbench.artifactsTab')
  if (tab.startsWith('plugin:')) {
    const rest = tab.slice('plugin:'.length)
    const slash = rest.lastIndexOf('/')
    if (slash > 0) {
      const pluginId = rest.slice(0, slash)
      const panelId = rest.slice(slash + 1)
      const matched = workbenchPanels.find(
        (item) => item.pluginId === pluginId && item.spec.id === panelId,
      )
      if (matched !== undefined) {
        return resolveLocalizedText(matched.spec.label, locale)
      }
    }
  }
  return t('conv.drawer.workbenchLabel')
}

export function resolveDrawerFrameLabel(input: {
  frame: DrawerFrame
  resolvedConversationId?: number
  conversations: ReadonlyArray<ConversationSummary>
  conversationDetails: Readonly<Record<number, ConversationSummary | undefined>>
  workbenchPanels: GroupedUiSpecs['workbenchPanels']
  locale: HelmxLocale
  t: WebMessageTranslator
}): string {
  const { frame, conversations, conversationDetails, workbenchPanels, locale, t } = input
  if (frame.kind === 'conversation') {
    const summary =
      conversations.find((c) => c.id === frame.conversationId) ?? conversationDetails[frame.conversationId]
    const customTitle = meaningfulDrawerTitle(summary?.title, frame.conversationId)
    return customTitle !== undefined
      ? t('conv.drawer.convLabelWithName', { id: frame.conversationId, title: customTitle })
      : t('conv.drawer.convLabel', { id: frame.conversationId })
  }
  const tabTitle = resolveWorkbenchTabTitle(frame.tab, workbenchPanels, locale, t)
  if (frame.conversationId !== undefined) {
    return `${tabTitle} · #${frame.conversationId}`
  }
  return tabTitle
}

export function resolveDrawerDialogAriaLabel(input: {
  topFrame: DrawerFrame
  topLabel: string
  conversations: ReadonlyArray<ConversationSummary>
  conversationDetails: Readonly<Record<number, ConversationSummary | undefined>>
  t: WebMessageTranslator
}): string {
  const { topFrame, conversations, conversationDetails, t } = input
  if (topFrame.kind === 'workbench') {
    return t('conv.workbench.drawerAria')
  }
  const summary =
    conversations.find((c) => c.id === topFrame.conversationId) ?? conversationDetails[topFrame.conversationId]
  const customTitle = meaningfulDrawerTitle(summary?.title, topFrame.conversationId)
  return customTitle !== undefined
    ? t('conv.drawer.titleWithName', { id: topFrame.conversationId, title: customTitle })
    : t('conv.drawer.title', { id: topFrame.conversationId })
}
