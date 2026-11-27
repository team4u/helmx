/**
 * Navigation, space memory, drawer-stack, search-highlight, and double-Esc
 * abort state machine for HelmxExternalStore.
 */
import type { ConversationSummary, LocalizedText } from '@helmx/protocol/browser'
import type { WebMessageKey } from '../../i18n/catalog.js'
import {
  isConversationAbortable,
  persistSidebarCollapsed,
} from '../../shell/shortcuts-model.js'
import { activeTargetForPanel, resolveFocusedPanel } from '../panel-focus.js'
import { conversationsApi } from '../api.js'
import { clearStandbyFocusRequest } from '../../conversation/standby-model.js'
import {
  getRememberedConversationDrawer,
  isSameDrawerStack,
  normalizeWorkbenchTab,
  popDrawerFrame,
  pruneConversationFromDrawerMemory,
  pushDrawerFrame,
  removeConversationFromDrawerStack,
  setRememberedConversationDrawer,
  topConversationDrawerId,
  topDrawerFrame,
  truncateDrawerStackTo,
  updateTopWorkbenchTab,
  type DrawerFrame,
} from '../drawer-stack-model.js'
import { errorText } from '../error-text.js'
import { entryMatchesReference, type LiveState } from '../live-state.js'
import type { StoreRequestManager } from '../request-manager.js'
import {
  applyScreenParamsPatch,
  defaultSpaceTarget,
  partitionScreenParamsPatch,
  resolveSpaceSwitch,
  type SpaceTargetInput,
} from '../space-navigation.js'
import {
  isSameResolvedTarget,
  isWideDesktopViewport,
  resolveTargetString,
  spaceForTarget,
  type ActiveModal,
  type FocusedPanel,
  type GroupedUiSpecs,
  type ResolvedTarget,
  type SidebarSpace,
  type ToastNotice,
} from '../types.js'
import { isSameLocationState, type WorkspaceLocationState } from '../url-hash-model.js'
import { applyUpdater, emptyPlan, ESC_ABORT_NOTICE_ID } from './helpers.js'
import type { CatalogSlice, NavSlice, NotifyPlan, StoreUpdater } from './types.js'

export interface StoreNavHost {
  readonly requests: StoreRequestManager
  setLastSyncedLocation(location: WorkspaceLocationState): void
  setPendingHistoryMode(mode: 'push' | 'replace' | null): void
  getNavSlice(): NavSlice
  getLocationState(): WorkspaceLocationState
  getLiveState(): LiveState
  getCatalogSlice(): CatalogSlice
  getGroupedUi(): GroupedUiSpecs
  getConversationSummary(id: number): ConversationSummary | undefined
  getLoadErrorsMap(): Record<string, string>
  getNotices(): ToastNotice[]
  translate(text: LocalizedText): string
  tt(key: WebMessageKey, params?: Record<string, string | number>): string
  emit(plan: NotifyPlan): void
  patchNav(patch: Partial<NavSlice>, plan?: NotifyPlan, deferEmit?: boolean): void
  setNotices(update: StoreUpdater<ToastNotice[]>, plan?: NotifyPlan, deferEmit?: boolean): void
  pushNotice(notice: Omit<ToastNotice, 'id' | 'createdAt'>): void
  loadEarlierEntries(id: number, opts?: { quiet?: boolean }): Promise<void>
}

export interface StoreNavActions {
  rememberSpaceTarget: (target: ResolvedTarget) => void
  resetSpaceMemory: (initial?: Partial<Record<SidebarSpace, ResolvedTarget>>) => void
  rememberConversationDrawer: (conversationId: number, stack: readonly DrawerFrame[]) => void
  resetConversationDrawerMemory: () => void
  clearEscTimer: () => void
  reconcileEscAbort: (plan: NotifyPlan) => void
  applyPrimaryTarget: (target: ResolvedTarget) => void
  setSplitTarget: (update: StoreUpdater<ResolvedTarget | null>) => void
  setFocusedPanel: (panel: FocusedPanel) => void
  closeSplit: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebarCollapsed: () => void
  openConversationDrawer: (conversationId: number) => void
  openWorkbenchDrawer: (options?: { tab?: string; conversationId?: number; params?: Record<string, unknown> }) => void
  popDrawer: () => void
  truncateDrawerStack: (index: number) => void
  closeAllDrawers: () => void
  pruneConversationFromDrawerStack: (conversationId: number) => void
  setWorkbenchOpen: (update: StoreUpdater<boolean>) => void
  setWorkbenchTab: (update: StoreUpdater<string>) => void
  setActiveModal: (update: StoreUpdater<ActiveModal>) => void
  openTarget: (
    target: string | ResolvedTarget,
    opts?: { split?: boolean; highlightEntryId?: string; history?: 'push' | 'replace' },
  ) => void
  openSpace: (space: SidebarSpace) => void
  setScreenParams: (
    patch: Record<string, string | undefined>,
    options?: { split?: boolean; push?: boolean },
  ) => void
  applyExternalLocation: (parsed: WorkspaceLocationState) => void
  performHomeLanding: (initialLocation: WorkspaceLocationState) => void
  stepHighlightedEntry: () => void
  clearEscAbortPrompt: () => void
  confirmOrArmEscAbort: (conversationId: number) => void
}

export function createStoreNavActions(
  host: StoreNavHost,
  options: { escAbortWindowMs: number },
): StoreNavActions {
  let spaceMemory: Partial<Record<SidebarSpace, ResolvedTarget>> = {}
  const conversationDrawerMemory = new Map<number, DrawerFrame[]>()
  let escAbortTimer: ReturnType<typeof setTimeout> | null = null

  const clearEscTimer = (): void => {
    if (escAbortTimer !== null) {
      clearTimeout(escAbortTimer)
      escAbortTimer = null
    }
  }

  /**
   * 空间记忆写入的唯一入口：boot 初始化、程序导航与 hashchange 同步全部经此收敛；
   * `#/overview` 归属 conversations 空间，切去设置/视图再点回对话可原地恢复总览。
   */
  const rememberSpaceTarget = (target: ResolvedTarget): void => {
    spaceMemory[spaceForTarget(target)] = target
  }

  const resetSpaceMemory = (initial: Partial<Record<SidebarSpace, ResolvedTarget>> = {}): void => {
    spaceMemory = { ...initial }
  }

  const rememberConversationDrawer = (conversationId: number, stack: readonly DrawerFrame[]): void => {
    setRememberedConversationDrawer(conversationDrawerMemory, conversationId, stack)
  }

  const resetConversationDrawerMemory = (): void => {
    conversationDrawerMemory.clear()
  }

  const syncCurrentConversationDrawer = (nav: NavSlice, nextStack: readonly DrawerFrame[]): void => {
    if (nav.primaryTarget.kind !== 'conversation') return
    if (nextStack.length === 0) {
      conversationDrawerMemory.delete(nav.primaryTarget.conversationId)
      return
    }
    if (nav.splitTarget === null && isWideDesktopViewport()) {
      setRememberedConversationDrawer(conversationDrawerMemory, nav.primaryTarget.conversationId, nextStack)
    }
  }

  const resolveActiveStageConversationId = (): number | undefined => {
    const nav = host.getNavSlice()
    const focused = resolveFocusedPanel(nav.focusedPanel, nav.splitTarget)
    const activeTarget = activeTargetForPanel(nav.primaryTarget, nav.splitTarget, focused)
    const fallbackTarget = focused === 'split' ? nav.primaryTarget : nav.splitTarget
    if (activeTarget.kind === 'conversation') return activeTarget.conversationId
    if (fallbackTarget?.kind === 'conversation') return fallbackTarget.conversationId
    return undefined
  }

  const reconcileEscAbort = (plan: NotifyPlan): void => {
    const nav = host.getNavSlice()
    const pendingId = nav.pendingEscAbortConversationId
    if (pendingId === null) return
    const activeTarget = activeTargetForPanel(nav.primaryTarget, nav.splitTarget, nav.focusedPanel)
    const targetInvalid = activeTarget.kind !== 'conversation' || activeTarget.conversationId !== pendingId
    const conv = host.getConversationSummary(pendingId) ?? host.getLiveState().conversationDetails[pendingId]
    if (!targetInvalid && isConversationAbortable(conv)) return

    clearEscTimer()
    host.patchNav({ pendingEscAbortConversationId: null }, plan, true)
    if (host.getNotices().some((item) => item.id === ESC_ABORT_NOTICE_ID)) {
      host.setNotices((prev) => prev.filter((item) => item.id !== ESC_ABORT_NOTICE_ID), plan, true)
    }
  }

  const applyPrimaryTarget = (target: ResolvedTarget): void => {
    rememberSpaceTarget(target)
    host.patchNav({ primaryTarget: target })
  }

  const setSplitTarget = (update: StoreUpdater<ResolvedTarget | null>): void => {
    const next = applyUpdater(host.getNavSlice().splitTarget, update)
    host.patchNav({ splitTarget: next })
  }

  const setFocusedPanel = (panel: FocusedPanel): void => {
    const next = resolveFocusedPanel(panel, host.getNavSlice().splitTarget)
    host.patchNav({ focusedPanel: next })
  }

  const closeSplit = (): void => {
    host.patchNav({ splitTarget: null, focusedPanel: 'primary' })
  }

  const setSidebarCollapsed = (collapsed: boolean): void => {
    persistSidebarCollapsed(collapsed)
    host.patchNav({ sidebarCollapsed: collapsed })
  }

  const toggleSidebarCollapsed = (): void => {
    const next = !host.getNavSlice().sidebarCollapsed
    persistSidebarCollapsed(next)
    host.patchNav({ sidebarCollapsed: next })
  }

  const openConversationDrawer = (conversationId: number): void => {
    const nav = host.getNavSlice()
    const nextStack = pushDrawerFrame(nav.drawerStack, { kind: 'conversation', conversationId })
    syncCurrentConversationDrawer(nav, nextStack)
    host.patchNav({ drawerStack: nextStack })
  }

  const openWorkbenchDrawer = (opts?: { tab?: string; conversationId?: number; params?: Record<string, unknown> }): void => {
    const nav = host.getNavSlice()
    const top = topDrawerFrame(nav.drawerStack)
    const underlyingConvId = topConversationDrawerId(nav.drawerStack)
    const stageConvId = resolveActiveStageConversationId()
    let frameConversationId: number | undefined
    if (opts?.conversationId !== undefined) {
      frameConversationId =
        underlyingConvId === undefined && opts.conversationId === stageConvId
          ? undefined
          : opts.conversationId
    } else if (top?.kind === 'workbench') {
      frameConversationId = top.conversationId
    } else if (underlyingConvId !== undefined) {
      frameConversationId = underlyingConvId
    }
    const tab = normalizeWorkbenchTab(
      opts?.tab ?? (top?.kind === 'workbench' ? top.tab : nav.workbenchTab),
    )
    const nextFrame: DrawerFrame =
      frameConversationId !== undefined
        ? { kind: 'workbench', conversationId: frameConversationId, tab }
        : { kind: 'workbench', tab }
    const nextStack = pushDrawerFrame(nav.drawerStack, nextFrame)
    const nextParams =
      opts?.params !== undefined
        ? {
            tab,
            ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
            params: Object.freeze({ ...opts.params }),
          }
        : null
    syncCurrentConversationDrawer(nav, nextStack)
    host.patchNav({ drawerStack: nextStack, workbenchTab: tab, workbenchParams: nextParams })
  }

  const popDrawer = (): void => {
    const nav = host.getNavSlice()
    if (nav.drawerStack.length === 0) return
    const nextStack = popDrawerFrame(nav.drawerStack)
    syncCurrentConversationDrawer(nav, nextStack)
    host.patchNav({ drawerStack: nextStack })
  }

  const truncateDrawerStack = (index: number): void => {
    const nav = host.getNavSlice()
    if (nav.drawerStack.length === 0) return
    const nextStack = truncateDrawerStackTo(nav.drawerStack, index)
    syncCurrentConversationDrawer(nav, nextStack)
    host.patchNav({ drawerStack: nextStack })
  }

  const closeAllDrawers = (): void => {
    const nav = host.getNavSlice()
    if (nav.drawerStack.length === 0) return
    syncCurrentConversationDrawer(nav, [])
    host.patchNav({ drawerStack: [] })
  }

  const pruneConversationFromDrawerStack = (conversationId: number): void => {
    pruneConversationFromDrawerMemory(conversationDrawerMemory, conversationId)
    const nav = host.getNavSlice()
    const nextStack = removeConversationFromDrawerStack(nav.drawerStack, conversationId)
    if (nextStack !== nav.drawerStack) {
      syncCurrentConversationDrawer(nav, nextStack)
      host.patchNav({ drawerStack: nextStack })
    }
  }

  const setWorkbenchOpen = (update: StoreUpdater<boolean>): void => {
    const currentlyOpen = topDrawerFrame(host.getNavSlice().drawerStack)?.kind === 'workbench'
    const next = applyUpdater(currentlyOpen, update)
    if (next === currentlyOpen) return
    if (next) openWorkbenchDrawer()
    else popDrawer()
  }

  const setWorkbenchTab = (update: StoreUpdater<string>): void => {
    const nav = host.getNavSlice()
    const top = topDrawerFrame(nav.drawerStack)
    const currentTab = top?.kind === 'workbench' ? top.tab : nav.workbenchTab
    const nextTab = normalizeWorkbenchTab(applyUpdater(currentTab, update))
    const nextStack = updateTopWorkbenchTab(nav.drawerStack, nextTab)
    if (nextStack !== nav.drawerStack) {
      syncCurrentConversationDrawer(nav, nextStack)
    }
    host.patchNav({ drawerStack: nextStack, workbenchTab: nextTab })
  }

  const setActiveModal = (update: StoreUpdater<ActiveModal>): void => {
    const next = applyUpdater(host.getNavSlice().activeModal, update)
    // 顶层预览弹窗（文件/产物/命令面板）与右侧抽屉栈正交：互不覆盖、各自按叠层关闭。
    host.patchNav({ activeModal: next })
  }

  const openTarget = (
    target: string | ResolvedTarget,
    opts?: { split?: boolean; highlightEntryId?: string; history?: 'push' | 'replace' },
  ): void => {
    const resolved = typeof target === 'string' ? resolveTargetString(target, host.getLiveState().conversations) : target
    if (!resolved) {
      host.pushNotice({
        type: 'notification',
        level: 'warning',
        title: host.tt('shell.nav.targetNotReady'),
        body: typeof target === 'string' ? target : host.tt('shell.nav.invalidTarget'),
      })
      return
    }
    if (opts?.history !== undefined) host.setPendingHistoryMode(opts.history)
    if (resolved.kind !== 'agent') clearStandbyFocusRequest()
    const patch: Partial<NavSlice> = {}
    if (opts?.split) {
      patch.splitTarget = resolved
    } else {
      const nav = host.getNavSlice()
      if (!isSameResolvedTarget(nav.primaryTarget, resolved)) {
        patch.workbenchParams = null
      }
      rememberSpaceTarget(resolved)
      patch.primaryTarget = resolved
      // 宽屏无分屏时按会话独立记忆并恢复停靠抽屉栈；窄屏、分屏或非会话目标仍自动收起抽屉栈避免遮挡。
      const canDock = nav.splitTarget === null && isWideDesktopViewport()
      if (canDock && nav.primaryTarget.kind === 'conversation' && nav.drawerStack.length > 0) {
        setRememberedConversationDrawer(
          conversationDrawerMemory,
          nav.primaryTarget.conversationId,
          nav.drawerStack,
        )
      }
      const nextDrawerStack =
        canDock && resolved.kind === 'conversation'
          ? (getRememberedConversationDrawer(conversationDrawerMemory, resolved.conversationId) ?? [])
          : []
      if (!isSameDrawerStack(nav.drawerStack, nextDrawerStack)) {
        patch.drawerStack = nextDrawerStack
      }
    }
    if (resolved.kind === 'conversation' && opts?.highlightEntryId) {
      patch.highlightedEntry = { conversationId: resolved.conversationId, entryId: opts.highlightEntryId }
    }
    host.patchNav(patch)
  }

  const buildSpaceTargetInput = (): SpaceTargetInput => {
    const live = host.getLiveState()
    const catalog = host.getCatalogSlice()
    return {
      conversations: live.conversations,
      profiles: catalog.profiles,
      plugins: live.plugins,
      assetsLoaded: catalog.profilesLoaded || catalog.assetsLoaded,
      grouped: host.getGroupedUi(),
    }
  }

  const openSpace = (space: SidebarSpace): void => {
    const resolution = resolveSpaceSwitch(space, host.getNavSlice().primaryTarget, spaceMemory, buildSpaceTargetInput())
    if (resolution.kind === 'already-in-space') return
    if (resolution.clearStaleMemory) delete spaceMemory[space]
    if (resolution.kind === 'unavailable') {
      host.pushNotice({
        type: 'notification',
        level: 'warning',
        title: host.tt('shell.nav.noOpenableEntry'),
        body: space === 'views' ? host.tt('shell.nav.noViewsBody') : host.tt('shell.nav.noConversationsBody'),
      })
      return
    }
    openTarget(resolution.target, { history: 'push' })
  }

  const setScreenParams = (
    patch: Record<string, string | undefined>,
    opts?: { split?: boolean; push?: boolean },
  ): void => {
    const { validEntries, invalidKeys } = partitionScreenParamsPatch(patch)
    for (const key of invalidKeys) {
      host.pushNotice({
        type: 'notification',
        level: 'warning',
        title: host.tt('shell.nav.invalidScreenParamTitle'),
        body: host.tt('shell.nav.invalidScreenParamBody', { key }),
      })
    }
    const nav = host.getNavSlice()
    const currentTarget = opts?.split ? nav.splitTarget : nav.primaryTarget
    if (validEntries.length === 0 || (currentTarget?.kind !== 'screen' && currentTarget?.kind !== 'overview')) return
    if (opts?.push) host.setPendingHistoryMode('push')
    if (opts?.split) {
      setSplitTarget((current) => (current === null ? current : applyScreenParamsPatch(current, validEntries)))
    } else {
      applyPrimaryTarget(applyScreenParamsPatch(currentTarget, validEntries))
    }
  }

  const applyExternalLocation = (parsed: WorkspaceLocationState): void => {
    clearStandbyFocusRequest()
    host.setPendingHistoryMode(null)
    host.setLastSyncedLocation(parsed)
    rememberSpaceTarget(parsed.primaryTarget)
    if (
      parsed.primaryTarget.kind === 'conversation' &&
      parsed.splitTarget === null &&
      isWideDesktopViewport()
    ) {
      setRememberedConversationDrawer(
        conversationDrawerMemory,
        parsed.primaryTarget.conversationId,
        parsed.drawerStack,
      )
    }
    const top = topDrawerFrame(parsed.drawerStack)
    host.patchNav({
      primaryTarget: parsed.primaryTarget,
      splitTarget: parsed.splitTarget,
      drawerStack: parsed.drawerStack,
      ...(top?.kind === 'workbench' ? { workbenchTab: top.tab } : {}),
      activeModal: parsed.activeModal,
    })
  }

  const performHomeLanding = (initialLocation: WorkspaceLocationState): void => {
    if (!isSameLocationState(host.getLocationState(), initialLocation)) return
    const input = buildSpaceTargetInput()
    const home = defaultSpaceTarget('conversations', input)
    if (home === null) return
    openTarget(home, { history: 'replace' })
  }

  const stepHighlightedEntry = (): void => {
    const current = host.getNavSlice().highlightedEntry
    if (current === null) return
    const detail = host.getLiveState().conversationDetails[current.conversationId]
    if (!detail) return
    const matched = detail.entries.find((entry) => entryMatchesReference(entry, current.entryId))
    if (matched) {
      if (matched.id !== current.entryId) {
        host.patchNav({ highlightedEntry: { ...current, entryId: matched.id } })
        return
      }
      host.requests.delay(() => {
        if (host.getNavSlice().highlightedEntry === current) {
          host.patchNav({ highlightedEntry: null })
        }
      }, 5000)
    } else if (detail.nextCursor && !host.getLoadErrorsMap()[`history:${detail.id}`]) {
      void host.loadEarlierEntries(detail.id, { quiet: true })
    } else if (!detail.nextCursor) {
      host.pushNotice({
        type: 'notification',
        level: 'warning',
        title: host.tt('shell.nav.searchEntryGone'),
        target: { kind: 'conversation', conversationId: detail.id },
      })
      host.patchNav({ highlightedEntry: null })
    }
  }

  const clearEscAbortPrompt = (): void => {
    clearEscTimer()
    const plan = emptyPlan()
    if (host.getNavSlice().pendingEscAbortConversationId !== null) {
      host.patchNav({ pendingEscAbortConversationId: null }, plan, true)
    }
    if (host.getNotices().some((item) => item.id === ESC_ABORT_NOTICE_ID)) {
      host.setNotices((prev) => prev.filter((item) => item.id !== ESC_ABORT_NOTICE_ID), plan, true)
    }
    host.emit(plan)
  }

  const armEscAbortPrompt = (conversationId: number): void => {
    clearEscTimer()
    const plan = emptyPlan()
    host.patchNav({ pendingEscAbortConversationId: conversationId }, plan, true)
    host.setNotices(
      (prev) => [
        ...prev.filter((item) => item.id !== ESC_ABORT_NOTICE_ID),
        {
          id: ESC_ABORT_NOTICE_ID,
          type: 'notification',
          level: 'warning',
          title: host.tt('shell.esc.confirmTitle'),
          body: host.tt('shell.esc.confirmBody'),
          target: { kind: 'conversation', conversationId },
          createdAt: Date.now(),
        },
      ],
      plan,
      true,
    )
    host.emit(plan)

    escAbortTimer = setTimeout(() => {
      escAbortTimer = null
      clearEscAbortPrompt()
    }, options.escAbortWindowMs)
    const timerHandle = escAbortTimer as unknown as { unref?: () => void }
    timerHandle.unref?.()
  }

  const confirmOrArmEscAbort = (conversationId: number): void => {
    if (host.getNavSlice().pendingEscAbortConversationId === conversationId) {
      clearEscAbortPrompt()
      void conversationsApi.abort(conversationId).catch((error: unknown) => {
        host.pushNotice({
          type: 'notification',
          level: 'error',
          title: host.tt('shell.esc.abortFailedTitle'),
          body: errorText(error),
          target: { kind: 'conversation', conversationId },
        })
      })
    } else {
      armEscAbortPrompt(conversationId)
    }
  }

  return {
    rememberSpaceTarget,
    resetSpaceMemory,
    rememberConversationDrawer,
    resetConversationDrawerMemory,
    clearEscTimer,
    reconcileEscAbort,
    applyPrimaryTarget,
    setSplitTarget,
    setFocusedPanel,
    closeSplit,
    setSidebarCollapsed,
    toggleSidebarCollapsed,
    openConversationDrawer,
    openWorkbenchDrawer,
    popDrawer,
    truncateDrawerStack,
    closeAllDrawers,
    pruneConversationFromDrawerStack,
    setWorkbenchOpen,
    setWorkbenchTab,
    setActiveModal,
    openTarget,
    openSpace,
    setScreenParams,
    applyExternalLocation,
    performHomeLanding,
    stepHighlightedEntry,
    clearEscAbortPrompt,
    confirmOrArmEscAbort,
  }
}
