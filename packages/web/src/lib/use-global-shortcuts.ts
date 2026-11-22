/**
 * The single global single-key shortcut dispatch hook:
 * strictly one key per function (Ctrl+L / Ctrl+O / Mod+K / Mod+B / Mod+J / Esc×2), no aliases.
 * Display copy is not produced here, so no locale seam is needed.
 */
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { LiveState } from './live-state.js'
import { topConversationDrawerId, topDrawerFrame } from './drawer-stack-model.js'
import type { ActiveModal, DrawerFrame, FocusedPanel, ResolvedTarget } from './types.js'
import {
  activeTargetForPanel,
  hasAnyOpenOverlay,
  hasBlockingAlertDialog,
  hasDialogOpen,
  hasNonModelPickerDialogOpen,
  hasNonWorkbenchDialogOpen,
  isConversationAbortable,
  isInlineInputEscapeTarget,
  resolveFocusedPanel,
  type HelmxShortcutDetail,
} from '../shell/shortcuts-model.js'

export interface UseGlobalShortcutsOptions {
  authenticatedRef: MutableRefObject<boolean>
  focusedPanelRef: MutableRefObject<FocusedPanel>
  targets: MutableRefObject<{ primaryTarget: ResolvedTarget; splitTarget: ResolvedTarget | null }>
  activeModalRef: MutableRefObject<ActiveModal>
  drawerStackRef: MutableRefObject<DrawerFrame[]>
  liveRef: MutableRefObject<LiveState>
  clearEscAbortPrompt: () => void
  confirmOrArmEscAbort: (conversationId: number) => void
  setActiveModal: Dispatch<SetStateAction<ActiveModal>>
  setWorkbenchOpen: Dispatch<SetStateAction<boolean>>
  toggleSidebarCollapsed: () => void
}

export function useGlobalShortcuts({
  authenticatedRef,
  focusedPanelRef,
  targets,
  activeModalRef,
  drawerStackRef,
  liveRef,
  clearEscAbortPrompt,
  confirmOrArmEscAbort,
  setActiveModal,
  setWorkbenchOpen,
  toggleSidebarCollapsed,
}: UseGlobalShortcutsOptions): void {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!authenticatedRef.current) return
      if (event.isComposing || event.keyCode === 229) return

      const keyLower = event.key.toLowerCase()
      const isMod = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
      const isCtrlOnly = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      const panel = resolveFocusedPanel(focusedPanelRef.current, targets.current.splitTarget)
      const activeTarget = activeTargetForPanel(
        targets.current.primaryTarget,
        targets.current.splitTarget,
        panel,
      )

      if (isMod && keyLower === 'k') {
        if (event.defaultPrevented || hasBlockingAlertDialog()) return
        event.preventDefault()
        clearEscAbortPrompt()
        setActiveModal((current) => (current?.kind === 'command-palette' ? null : { kind: 'command-palette' }))
        return
      }

      if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (
          event.defaultPrevented ||
          hasAnyOpenOverlay(activeModalRef.current, drawerStackRef.current.length > 0) ||
          isInlineInputEscapeTarget(event.target)
        ) {
          clearEscAbortPrompt()
          return
        }
        if (activeTarget.kind !== 'conversation') {
          clearEscAbortPrompt()
          return
        }
        const convId = activeTarget.conversationId
        const conv =
          liveRef.current.conversations.find((c) => c.id === convId) ??
          liveRef.current.conversationDetails[convId]
        if (!isConversationAbortable(conv)) {
          clearEscAbortPrompt()
          return
        }
        event.preventDefault()
        confirmOrArmEscAbort(convId)
        return
      }

      if (event.defaultPrevented) return

      if (isMod && keyLower === 'j') {
        // 抽屉栈内有会话帧时同样视作会话上下文：Mod+J 可在抽屉顶开合绑定该会话的工作台。
        if (activeModalRef.current !== null || hasNonWorkbenchDialogOpen()) return
        const top = topDrawerFrame(drawerStackRef.current)
        const drawerConversationId = topConversationDrawerId(drawerStackRef.current)
        if (top?.kind !== 'workbench' && activeTarget.kind !== 'conversation' && drawerConversationId === undefined) return
        event.preventDefault()
        clearEscAbortPrompt()
        setWorkbenchOpen((open) => !open)
        return
      }

      if (isMod && keyLower === 'b') {
        if (
          activeModalRef.current !== null ||
          topConversationDrawerId(drawerStackRef.current) !== undefined ||
          hasNonWorkbenchDialogOpen()
        ) return
        event.preventDefault()
        toggleSidebarCollapsed()
        return
      }

      if (activeModalRef.current !== null || drawerStackRef.current.length > 0) return

      if (isCtrlOnly && keyLower === 'l') {
        if (hasNonModelPickerDialogOpen()) return
        event.preventDefault()
        const detail: HelmxShortcutDetail = { action: 'toggle-model-picker', panel }
        window.dispatchEvent(new CustomEvent<HelmxShortcutDetail>('helmx:shortcut', { detail }))
        return
      }

      if (hasDialogOpen()) return

      if (isCtrlOnly && keyLower === 'o') {
        event.preventDefault()
        const detail: HelmxShortcutDetail = { action: 'toggle-process-groups', panel }
        window.dispatchEvent(new CustomEvent<HelmxShortcutDetail>('helmx:shortcut', { detail }))
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [
    activeModalRef,
    authenticatedRef,
    clearEscAbortPrompt,
    confirmOrArmEscAbort,
    drawerStackRef,
    focusedPanelRef,
    liveRef,
    setActiveModal,
    setWorkbenchOpen,
    targets,
    toggleSidebarCollapsed,
  ])
}
