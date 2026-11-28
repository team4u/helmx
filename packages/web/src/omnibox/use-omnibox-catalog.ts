/**
 * Assembles all 0ms synchronous sources + 200ms async search sources into the
 * ranked Omnibox view and executes typed `OmniboxIntent` actions cleanly.
 *
 * Subscribes strictly to narrow domain store hooks (never `useHelmxStore()`) so
 * high-frequency `conversation.live` updates cause zero re-renders of the modal.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { resolveLocalizedText, type OmniboxPluginHit } from '@helmx/protocol/browser'
import { openStandbyWithFocus } from '../conversation/standby-focus.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  commandActionPluginId,
  commandsForConversation,
  type QualifiedCommand,
} from '../lib/commands-model.js'
import { activeTargetForPanel, resolveFocusedPanel } from '../lib/panel-focus.js'
import {
  useAuthConnection,
  useCatalogActions,
  useConversationBackgroundSlice,
  useConversations,
  useCredentials,
  useGroupedUi,
  useLocationTargets,
  useModels,
  useNodes,
  usePluginConfigCatalog,
  usePlugins,
  useProfilesSlice,
  useProviders,
  useSidebarCollapsed,
  useSkills,
  useStoreActions,
  useThemePreferencesState,
  useWorkbenchState,
} from '../lib/store-context.js'
import type { LocalePreference } from '../lib/types.js'
import { collectEnabledPluginIds } from '../shell/conversation-status-model.js'
import { loadFrecencyEntries, recordFrecencyUse, type FrecencyEntry } from './frecency.js'
import { buildOmniboxView } from './ranker.js'
import { buildContextCommandItems, buildUtilityAndPluginCommandItems } from './sources/commands.js'
import {
  buildAsyncMessageItems,
  buildLocalConversationItems,
  buildRecentConversationItems,
  type OmniboxMessageHit,
} from './sources/conversations.js'
import { buildNavigationItems } from './sources/navigation.js'
import { buildAsyncPluginResourceItems } from './sources/plugin-resources.js'
import { buildSettingsItems } from './sources/settings.js'
import { buildWorkbenchItems } from './sources/workbench.js'
import {
  resolveIntentNavigation,
  type OmniboxItem,
  type OmniboxPreviewCommand,
  type OmniboxScope,
  type OmniboxScopeCounts,
  type OmniboxSection,
  type ParsedOmniboxQuery,
} from './types.js'

export interface UseOmniboxCatalogOptions {
  onClose: () => void
  query: string
  scope: OmniboxScope
  asyncMessages: ReadonlyArray<OmniboxMessageHit>
  asyncPluginHits: ReadonlyArray<OmniboxPluginHit>
}

export interface ExecuteOmniboxItemOptions {
  forceSplit?: boolean
  secondary?: boolean
}

export interface OmniboxCatalog {
  close: () => void
  activePanel: ReturnType<typeof resolveFocusedPanel>
  background: ReturnType<typeof useConversationBackgroundSlice>['snapshot']['byConversation']
  activeConversation: ReturnType<typeof useConversations>[number] | undefined
  scopedPluginCommands: QualifiedCommand[]
  invokePluginCommand: (cmd: QualifiedCommand) => void
  parsed: ParsedOmniboxQuery
  effectiveScope: OmniboxScope
  sections: OmniboxSection[]
  rows: OmniboxItem[]
  scopeCounts: OmniboxScopeCounts
  previewCmd: OmniboxPreviewCommand | null
  setPreviewCmd: (next: OmniboxPreviewCommand | null) => void
  openShortcutsModal: () => void
  executeItem: (item: OmniboxItem, options?: ExecuteOmniboxItemOptions) => void
  handleCloseAutoFocus: (event: Event) => void
}

export function useOmniboxCatalog({
  onClose,
  query,
  scope,
  asyncMessages,
  asyncPluginHits,
}: UseOmniboxCatalogOptions): OmniboxCatalog {
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
  const providers = useProviders()
  const credentials = useCredentials()
  const models = useModels()
  const skills = useSkills()
  const nodes = useNodes()
  const catalogActions = useCatalogActions()
  const pluginConfigCatalog = usePluginConfigCatalog()
  const actions = useStoreActions()
  const { locale, t } = useWebLocale()

  const [previewCmd, setPreviewCmd] = useState<OmniboxPreviewCommand | null>(null)
  const [frecencyEntries, setFrecencyEntries] = useState<FrecencyEntry[]>(() => loadFrecencyEntries())
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

  const activeConversation = useMemo(() => {
    if (activeTarget.kind !== 'conversation') return undefined
    return conversations.find((c) => c.id === activeTarget.conversationId)
  }, [activeTarget, conversations])

  const openShortcutsModal = useCallback(() => {
    skipCloseAutoFocusRef.current = true
    actions.setActiveModal({ kind: 'shortcuts' })
  }, [actions.setActiveModal])

  const invokePluginCommand = useCallback(
    (cmd: QualifiedCommand) => {
      const actionId = cmd.spec.actionId
      if (!actionId) return
      void actions
        .invokePluginAction(commandActionPluginId(cmd), actionId, cmd.spec.input, activeConversation?.id)
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
    [actions, locale, activeConversation?.id, t],
  )

  const scopedPluginCommands = useMemo(
    () => commandsForConversation(groupedUi.commands, activeConversation),
    [groupedUi.commands, activeConversation],
  )

  const contextItems = useMemo(
    () =>
      buildContextCommandItems({
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

  const recentConversationItems = useMemo(
    () => buildRecentConversationItems(conversations, activeConversation?.id, background, t),
    [conversations, activeConversation?.id, background, t],
  )

  const localConversationItems = useMemo(
    () => buildLocalConversationItems(conversations, t),
    [conversations, t],
  )

  const navigationItems = useMemo(
    () =>
      buildNavigationItems({
        profiles,
        enabledPluginIds,
        screens: groupedUi.screens,
        plugins,
        providers,
        credentials,
        models,
        skills,
        nodes,
        actions: catalogActions,
        locale,
        t,
      }),
    [
      profiles,
      enabledPluginIds,
      groupedUi.screens,
      plugins,
      providers,
      credentials,
      models,
      skills,
      nodes,
      catalogActions,
      locale,
      t,
    ],
  )

  const settingsItems = useMemo(
    () =>
      buildSettingsItems({
        settingsPanels: groupedUi.settingsPanels,
        pluginConfigCatalog,
        plugins,
        locale,
        t,
      }),
    [groupedUi.settingsPanels, pluginConfigCatalog, plugins, locale, t],
  )

  const pageItems = useMemo(
    () => [...navigationItems, ...settingsItems],
    [navigationItems, settingsItems],
  )

  const workbenchItems = useMemo(
    () =>
      buildWorkbenchItems({
        activeConversation,
        workbenchPanels: groupedUi.workbenchPanels,
        plugins,
        locale,
        t,
      }),
    [activeConversation, groupedUi.workbenchPanels, plugins, locale, t],
  )

  const localePref: LocalePreference = storeLocalePref ?? 'auto'

  const openTargetRaw = useCallback(
    (target: string) => {
      actions.openTarget(target)
    },
    [actions.openTarget],
  )

  const utilityAndPluginCommands = useMemo(
    () =>
      buildUtilityAndPluginCommandItems({
        scopedPluginCommands,
        conversations,
        locale,
        sidebarCollapsed,
        themePreference,
        localePref,
        quietNotifyEnabled,
        onInvokePluginCommand: invokePluginCommand,
        openTargetRaw,
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
      conversations,
      locale,
      sidebarCollapsed,
      themePreference,
      localePref,
      quietNotifyEnabled,
      invokePluginCommand,
      openTargetRaw,
      openShortcutsModal,
      actions.toggleSidebarCollapsed,
      actions.toggleTheme,
      actions.setLocalePreference,
      actions.setLocale,
      actions.setQuietNotify,
      t,
    ],
  )

  const commandItems = useMemo(
    () => [...workbenchItems, ...utilityAndPluginCommands],
    [workbenchItems, utilityAndPluginCommands],
  )

  const asyncMessageItems = useMemo(
    () => buildAsyncMessageItems(asyncMessages, conversations, t),
    [asyncMessages, conversations, t],
  )

  const asyncPluginItems = useMemo(
    () => buildAsyncPluginResourceItems(asyncPluginHits, conversations, plugins, locale),
    [asyncPluginHits, conversations, plugins, locale],
  )

  const formatMatchedModelSubtitle = useCallback(
    (modelName: string, currentSubtitle?: string) => {
      const note = t('modals.omnibox.matchedModel', { model: modelName })
      return currentSubtitle !== undefined && currentSubtitle !== '' ? `${note} · ${currentSubtitle}` : note
    },
    [t],
  )

  const view = useMemo(
    () =>
      buildOmniboxView({
        query,
        scope,
        contextItems,
        recentConversationItems,
        pageItems,
        commandItems,
        conversationItems: localConversationItems,
        asyncPluginItems,
        asyncMessageItems,
        frecencyEntries,
        formatMatchedModelSubtitle,
      }),
    [
      query,
      scope,
      contextItems,
      recentConversationItems,
      pageItems,
      commandItems,
      localConversationItems,
      asyncPluginItems,
      asyncMessageItems,
      frecencyEntries,
      formatMatchedModelSubtitle,
    ],
  )

  const executeItem = useCallback(
    (item: OmniboxItem, options?: ExecuteOmniboxItemOptions) => {
      const intent =
        options?.secondary === true && item.secondaryAction !== undefined
          ? item.secondaryAction.intent
          : item.intent

      // Only record explicitly eligible local pages/settings so transient async plugin hits never evict the 32-entry LRU.
      if (item.recentEligible === true) {
        setFrecencyEntries((prev) => recordFrecencyUse(prev, item.id))
      }

      if (intent.type === 'preview') {
        setPreviewCmd({ pluginId: intent.pluginId, spec: intent.spec })
        return
      }

      if (intent.type === 'workbench') {
        skipCloseAutoFocusRef.current = true
        close()
        actions.openWorkbenchDrawer({
          tab: intent.tab,
          ...(intent.conversationId !== undefined ? { conversationId: intent.conversationId } : {}),
          ...(intent.params !== undefined ? { params: intent.params } : {}),
        })
        return
      }

      const nav = resolveIntentNavigation(intent, activePanel, options?.forceSplit === true)
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
        if (nav.focusAnchor !== undefined) {
          actions.focusSearchAnchor(nav.focusAnchor)
        }
        return
      }

      if (intent.type === 'run') {
        if (intent.skipCloseAutoFocus) {
          skipCloseAutoFocusRef.current = true
        }
        close()
        intent.run()
      }
    },
    [actions, activePanel, close],
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
    activeConversation,
    scopedPluginCommands,
    invokePluginCommand,
    parsed: view.parsed,
    effectiveScope: view.effectiveScope,
    sections: view.sections,
    rows: view.rows,
    scopeCounts: view.scopeCounts,
    previewCmd,
    setPreviewCmd,
    openShortcutsModal,
    executeItem,
    handleCloseAutoFocus,
  }
}
