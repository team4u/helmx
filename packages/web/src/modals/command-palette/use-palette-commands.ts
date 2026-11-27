/**
 * 命令面板的命令目录装配与执行：上下文 / 最近 / 导航 / 工具四组命令、插件命令预览与调用、
 * 行执行（导航含分屏与待命页聚焦）；拥有「关闭后跳过自动聚焦」标记以承载跳转类命令。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { resolveLocalizedText, type CommandSpec, type ConversationSummary } from '@helmx/protocol/browser'
import { openStandbyWithFocus } from '../../conversation/standby-focus.js'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import {
  commandActionPluginId,
  commandsForConversation,
  type QualifiedCommand,
} from '../../lib/commands-model.js'
import { activeTargetForPanel, resolveFocusedPanel } from '../../lib/panel-focus.js'
import {
  useAuthConnection,
  useConversationBackgroundSlice,
  useConversations,
  useGroupedUi,
  useLocationTargets,
  usePlugins,
  useProfilesSlice,
  useSidebarCollapsed,
  useStoreActions,
  useThemePreferencesState,
  useWorkbenchState,
} from '../../lib/store-context.js'
import type { LocalePreference } from '../../lib/types.js'
import { collectEnabledPluginIds } from '../../shell/conversation-status-model.js'
import {
  buildPaletteContextCommands,
  buildPaletteNavigationCommands,
  buildPaletteRecentRows,
  buildPaletteUtilityCommands,
} from '../command-palette-catalog.js'
import {
  buildPaletteRows,
  resolveRowNavigation,
  type PaletteRow,
  type PaletteSearchHit,
  type PaletteSearchHitRow,
  type PaletteSection,
} from '../command-palette-model.js'

export interface PalettePreviewCommand {
  pluginId: string
  spec: CommandSpec
}

export interface PaletteCommandsOptions {
  onClose: () => void
  query: string
  hits: PaletteSearchHit[]
}

export interface PaletteCommands {
  close: () => void
  activePanel: ReturnType<typeof resolveFocusedPanel>
  background: ReturnType<typeof useConversationBackgroundSlice>['snapshot']['byConversation']
  paletteConversation: ReturnType<typeof useConversations>[number] | undefined
  contextCommands: ReturnType<typeof buildPaletteContextCommands>
  recentConversationRows: ReturnType<typeof buildPaletteRecentRows>
  navigationCommands: ReturnType<typeof buildPaletteNavigationCommands>
  utilityCommands: ReturnType<typeof buildPaletteUtilityCommands>
  scopedPluginCommands: QualifiedCommand[]
  /** 调用插件 action（预览面板「执行」按钮复用）。 */
  invokePluginCommand: (cmd: QualifiedCommand) => void
  sections: PaletteSection[]
  rows: PaletteRow[]
  previewCmd: PalettePreviewCommand | null
  setPreviewCmd: (next: PalettePreviewCommand | null) => void
  openShortcutsModal: () => void
  executeRow: (row: PaletteRow, forceSplit: boolean) => void
  /** Dialog 关闭自动聚焦：跳转类命令已接管焦点时跳过一次。 */
  handleCloseAutoFocus: (event: Event) => void
}

export function usePaletteCommands({ onClose, query, hits }: PaletteCommandsOptions): PaletteCommands {
  const conversations = useConversations()
  const { authenticated } = useAuthConnection()
  const { primaryTarget, splitTarget, focusedPanel } = useLocationTargets()
  const { workbenchOpen } = useWorkbenchState()
  const sidebarCollapsed = useSidebarCollapsed()
  const { themePreference, localePreference: storeLocalePref, quietNotifyEnabled } = useThemePreferencesState()
  const groupedUi = useGroupedUi()
  const plugins = usePlugins()
  const { badgeDocs, pendingBadgeDocs, snapshot: backgroundSnapshot } = useConversationBackgroundSlice()
  const { profiles } = useProfilesSlice()
  const actions = useStoreActions()
  const { locale, t } = useWebLocale()

  const [previewCmd, setPreviewCmd] = useState<PalettePreviewCommand | null>(null)
  const skipCloseAutoFocusRef = useRef(false)

  const background = backgroundSnapshot.byConversation
  useEffect(() => {
    if (!authenticated) return
    for (const ref of badgeDocs) {
      if (pendingBadgeDocs.has(`${ref.pluginId}/${ref.doc}`)) {
        void actions.ensurePluginDoc(ref.pluginId, ref.doc)
      }
    }
  }, [badgeDocs, pendingBadgeDocs, authenticated, actions.ensurePluginDoc])

  const close = useCallback(() => onClose(), [onClose])

  const activePanel = resolveFocusedPanel(focusedPanel ?? 'primary', splitTarget)
  const activeTarget = activeTargetForPanel(primaryTarget, splitTarget, activePanel)

  const enabledPluginIds = useMemo(() => collectEnabledPluginIds(plugins), [plugins])

  const paletteConversation = useMemo(() => {
    if (activeTarget.kind !== 'conversation') return undefined
    return conversations.find((c) => c.id === activeTarget.conversationId)
  }, [activeTarget, conversations])

  const openShortcutsModal = useCallback(() => {
    skipCloseAutoFocusRef.current = true
    actions.setActiveModal({ kind: 'shortcuts' })
  }, [actions.setActiveModal])

  const contextCommands = useMemo(
    () =>
      buildPaletteContextCommands({
        activeTarget,
        activePanel,
        workbenchOpen,
        conversations,
        profiles,
        plugins,
        sidebarItems: groupedUi.sidebarItems,
        locale,
        splitTarget,
        setWorkbenchOpen: actions.setWorkbenchOpen,
        closeSplit: actions.closeSplit,
        t,
      }),
    [
      activePanel,
      activeTarget,
      actions.closeSplit,
      actions.setWorkbenchOpen,
      conversations,
      groupedUi.sidebarItems,
      locale,
      plugins,
      profiles,
      splitTarget,
      t,
      workbenchOpen,
    ],
  )

  const recentConversationRows = useMemo(
    () => buildPaletteRecentRows(conversations, paletteConversation?.id, background, t),
    [conversations, paletteConversation?.id, background, t],
  )

  const navigationCommands = useMemo(
    () =>
      buildPaletteNavigationCommands({
        profiles,
        enabledPluginIds,
        screens: groupedUi.screens,
        plugins,
        locale,
        t,
      }),
    [profiles, enabledPluginIds, groupedUi.screens, plugins, locale, t],
  )

  const invokePluginCommand = useCallback(
    (cmd: QualifiedCommand) => {
      const actionId = cmd.spec.actionId
      if (!actionId) return
      void actions
        .invokePluginAction(commandActionPluginId(cmd), actionId, cmd.spec.input, paletteConversation?.id)
        .then(() =>
          actions.pushNotice({
            type: 'notification',
            level: 'info',
            title: t('modals.palette.cmdExecuted'),
            body: resolveLocalizedText(cmd.spec.title, locale),
          }),
        )
        .catch((err: unknown) =>
          actions.pushNotice({
            type: 'notification',
            level: 'error',
            title: t('modals.palette.cmdFailed'),
            body: err instanceof Error ? err.message : String(err),
          }),
        )
    },
    [actions, locale, paletteConversation?.id, t],
  )

  const scopedPluginCommands = useMemo(
    () => commandsForConversation(groupedUi.commands, paletteConversation),
    [groupedUi.commands, paletteConversation],
  )

  const localePref: LocalePreference = storeLocalePref ?? 'auto'

  const utilityCommands = useMemo(
    () =>
      buildPaletteUtilityCommands({
        scopedPluginCommands,
        locale,
        sidebarCollapsed,
        themePreference,
        localePref,
        quietNotifyEnabled,
        onPreviewCommand: setPreviewCmd,
        onInvokePluginCommand: invokePluginCommand,
        openShortcuts: openShortcutsModal,
        toggleSidebarCollapsed: actions.toggleSidebarCollapsed,
        toggleTheme: actions.toggleTheme,
        setLocalePreference: actions.setLocalePreference,
        setLocale: actions.setLocale,
        setQuietNotify: actions.setQuietNotify,
        t,
      }),
    [
      scopedPluginCommands,
      locale,
      sidebarCollapsed,
      themePreference,
      localePref,
      quietNotifyEnabled,
      invokePluginCommand,
      openShortcutsModal,
      actions.toggleSidebarCollapsed,
      actions.toggleTheme,
      actions.setLocalePreference,
      actions.setLocale,
      actions.setQuietNotify,
      t,
    ],
  )

  const executeRow = useCallback(
    (row: PaletteRow, forceSplit: boolean) => {
      const nav = resolveRowNavigation(row, activePanel, forceSplit)
      if (nav !== null) {
        skipCloseAutoFocusRef.current = true
        const opts =
          nav.split || nav.highlightEntryId !== undefined
            ? {
                ...(nav.split ? { split: true } : {}),
                ...(nav.highlightEntryId !== undefined ? { highlightEntryId: nav.highlightEntryId } : {}),
              }
            : undefined
        if (nav.target.kind === 'agent') {
          const agentProfileId = nav.target.profileId
          openStandbyWithFocus(
            { panel: nav.split ? 'split' : 'primary', profileId: agentProfileId },
            () => {
              close()
              actions.openTarget(nav.target, opts)
            },
          )
          return
        }
        close()
        actions.openTarget(nav.target, opts)
        return
      }
      if (row.kind === 'command') {
        const isClientPreview = scopedPluginCommands.some(
          (c) => c.spec.client !== undefined && `plugin:${c.pluginId}/${c.spec.id}` === row.id,
        )
        if (isClientPreview) {
          row.run?.()
          return
        }
        if (row.skipCloseAutoFocus) {
          skipCloseAutoFocusRef.current = true
        }
        close()
        row.run?.()
      }
    },
    [actions, activePanel, close, scopedPluginCommands],
  )

  const makeConversationRow = useCallback(
    (conv: ConversationSummary): PaletteSearchHitRow => ({
      kind: 'search-hit',
      id: `conv:${conv.id}`,
      group: 'recent',
      conv,
      isLocalConversation: true,
      hit: {
        conversationId: conv.id,
        title: conv.title,
        entryId: '',
        snippet: t('modals.palette.convSnippet', { id: conv.id, profileId: conv.profileId }),
      },
    }),
    [t],
  )

  const { sections, rows } = useMemo(
    () =>
      buildPaletteRows({
        query,
        contextCommands,
        recentConversations: recentConversationRows,
        navigationCommands,
        utilityCommands,
        conversations,
        ftsHits: hits,
        makeConversationRow,
      }),
    [
      query,
      contextCommands,
      recentConversationRows,
      navigationCommands,
      utilityCommands,
      conversations,
      hits,
      makeConversationRow,
    ],
  )

  const handleCloseAutoFocus = useCallback((event: Event) => {
    if (skipCloseAutoFocusRef.current) {
      skipCloseAutoFocusRef.current = false
      event.preventDefault()
    }
  }, [])

  return {
    close,
    activePanel,
    background,
    paletteConversation,
    contextCommands,
    recentConversationRows,
    navigationCommands,
    utilityCommands,
    scopedPluginCommands,
    invokePluginCommand,
    sections,
    rows,
    previewCmd,
    setPreviewCmd,
    openShortcutsModal,
    executeRow,
    handleCloseAutoFocus,
  }
}
