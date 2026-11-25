/**
 * The single global single-key shortcut dispatch hook:
 * strictly one key per function (Ctrl+L / Ctrl+O / Ctrl+. / Mod+K / Mod+/ / Mod+Shift+O / Mod+B / Mod+J / / / Esc×2), no aliases.
 * Display copy is not produced here, so no locale seam is needed.
 */
import { useEffect } from 'react'
import {
  activeTargetForPanel,
  hasAnyOpenOverlay,
  hasBlockingAlertDialog,
  hasDialogOpen,
  hasNonModelPickerDialogOpen,
  hasNonWorkbenchDialogOpen,
  isConversationAbortable,
  isEditableShortcutTarget,
  isInlineInputEscapeTarget,
  isPeriodShortcutKey,
  isSlashShortcutKey,
  resolveFocusedPanel,
  resolveNewTopicTarget,
  type HelmxShortcutDetail,
} from '../shell/shortcuts-model.js'
import { topConversationDrawerId, topDrawerFrame } from './drawer-stack-model.js'
import type { HelmxExternalStore } from './helmx-store.js'
import { isSameResolvedTarget } from './types.js'

export function useGlobalShortcuts(store: HelmxExternalStore): void {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!store.getAuthenticated()) return
      if (event.isComposing || event.keyCode === 229) return

      const keyLower = event.key.toLowerCase()
      const isMod = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
      const isModShift = (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey
      const isCtrlOnly = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      const primaryTarget = store.getPrimaryTarget()
      const splitTarget = store.getSplitTarget()
      const panel = resolveFocusedPanel(store.getFocusedPanel(), splitTarget)
      const activeTarget = activeTargetForPanel(primaryTarget, splitTarget, panel)
      const activeModal = store.getActiveModal()
      const drawerStack = store.getDrawerStack()

      if (isMod && keyLower === 'k') {
        if (event.defaultPrevented || hasBlockingAlertDialog()) return
        event.preventDefault()
        store.clearEscAbortPrompt()
        store.setActiveModal((current) => (current?.kind === 'command-palette' ? null : { kind: 'command-palette' }))
        return
      }

      if (isMod && isSlashShortcutKey(event)) {
        if (event.defaultPrevented || hasBlockingAlertDialog()) return
        event.preventDefault()
        store.clearEscAbortPrompt()
        store.setActiveModal((current) => (current?.kind === 'shortcuts' ? null : { kind: 'shortcuts' }))
        return
      }

      if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (
          event.defaultPrevented ||
          hasAnyOpenOverlay(activeModal, drawerStack.length > 0) ||
          isInlineInputEscapeTarget(event.target)
        ) {
          store.clearEscAbortPrompt()
          return
        }
        if (activeTarget.kind !== 'conversation') {
          store.clearEscAbortPrompt()
          return
        }
        const convId = activeTarget.conversationId
        const conv = store.getConversationSummary(convId) ?? store.getConversationDetail(convId)
        if (!isConversationAbortable(conv)) {
          store.clearEscAbortPrompt()
          return
        }
        event.preventDefault()
        store.confirmOrArmEscAbort(convId)
        return
      }

      if (event.defaultPrevented) return

      if (isMod && keyLower === 'j') {
        // 抽屉栈内有会话帧时同样视作会话上下文：Mod+J 可在抽屉顶开合绑定该会话的工作台。
        if (activeModal !== null || hasNonWorkbenchDialogOpen()) return
        const top = topDrawerFrame(drawerStack)
        const drawerConversationId = topConversationDrawerId(drawerStack)
        if (top?.kind !== 'workbench' && activeTarget.kind !== 'conversation' && drawerConversationId === undefined) return
        event.preventDefault()
        store.clearEscAbortPrompt()
        store.setWorkbenchOpen((open) => !open)
        return
      }

      if (isMod && keyLower === 'b') {
        if (
          activeModal !== null ||
          topConversationDrawerId(drawerStack) !== undefined ||
          hasNonWorkbenchDialogOpen()
        ) return
        event.preventDefault()
        store.toggleSidebarCollapsed()
        return
      }

      if (activeModal !== null || drawerStack.length > 0) return

      if (isCtrlOnly && keyLower === 'l') {
        if (hasNonModelPickerDialogOpen()) return
        event.preventDefault()
        const detail: HelmxShortcutDetail = { action: 'toggle-model-picker', panel }
        window.dispatchEvent(new CustomEvent<HelmxShortcutDetail>('helmx:shortcut', { detail }))
        return
      }

      if (hasDialogOpen()) return

      if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        isSlashShortcutKey(event) &&
        !hasAnyOpenOverlay(activeModal, drawerStack.length > 0) &&
        !isEditableShortcutTarget(
          typeof HTMLElement !== 'undefined' && event.target instanceof HTMLElement
            ? event.target
            : (typeof document !== 'undefined' ? document.activeElement : null),
        )
      ) {
        const detail: HelmxShortcutDetail = { action: 'focus-search', panel }
        const shortcutEvent = new CustomEvent<HelmxShortcutDetail>('helmx:shortcut', {
          detail,
          cancelable: true,
        })
        window.dispatchEvent(shortcutEvent)
        if (shortcutEvent.defaultPrevented) {
          event.preventDefault()
        }
        return
      }

      if (isModShift && keyLower === 'o') {
        event.preventDefault()
        store.clearEscAbortPrompt()
        const target = resolveNewTopicTarget({
          activeTarget,
          conversations: store.getConversations(),
          profiles: store.getProfilesSlice().profiles,
          plugins: store.getPlugins(),
          sidebarItems: store.getGroupedUi().sidebarItems,
          locale: store.getLocale(),
        })
        if (target.kind === 'agent' && isSameResolvedTarget(activeTarget, target)) {
          const detail: HelmxShortcutDetail = { action: 'focus-composer', panel }
          window.dispatchEvent(new CustomEvent<HelmxShortcutDetail>('helmx:shortcut', { detail }))
          return
        }
        store.openTarget(target, panel === 'split' ? { split: true } : undefined)
        return
      }

      if (isCtrlOnly && keyLower === 'o') {
        event.preventDefault()
        const detail: HelmxShortcutDetail = { action: 'toggle-process-groups', panel }
        window.dispatchEvent(new CustomEvent<HelmxShortcutDetail>('helmx:shortcut', { detail }))
        return
      }

      if (isCtrlOnly && isPeriodShortcutKey(event)) {
        event.preventDefault()
        const detail: HelmxShortcutDetail = { action: 'toggle-plan-mode', panel }
        window.dispatchEvent(new CustomEvent<HelmxShortcutDetail>('helmx:shortcut', { detail }))
      }
    }

    const onShortcut = (event: Event) => {
      if (!store.getAuthenticated()) return
      const detail = (event as CustomEvent<Partial<HelmxShortcutDetail> | undefined>).detail
      if (detail?.action !== 'open-shortcuts') return
      if (hasBlockingAlertDialog()) return
      store.clearEscAbortPrompt()
      store.setActiveModal({ kind: 'shortcuts' })
    }

    window.addEventListener('keydown', keydown)
    window.addEventListener('helmx:shortcut', onShortcut)
    return () => {
      window.removeEventListener('keydown', keydown)
      window.removeEventListener('helmx:shortcut', onShortcut)
    }
  }, [store])
}
