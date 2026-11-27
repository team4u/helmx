/**
 * Focus ownership for AskCard: whether this card currently owns window-level
 * shortcuts, how to focus a step's primary control, and the two focus rules —
 * auto-focus on mount / promotion to primary card while focus is neutral, and
 * follow the step whenever a stepper advances or retreats.
 */
import { useCallback, useContext, useEffect, useRef } from 'react'
import type * as React from 'react'
import { isElementVisibleInDocument } from '../../lib/dom-visibility.js'
import { topDrawerFrame } from '../../lib/drawer-stack-model.js'
import { resolveFocusedPanel } from '../../lib/panel-focus.js'
import { HelmxExternalStoreContext } from '../../lib/store-context.js'
import { hasAnyOpenOverlay } from '../../shell/shortcuts-model.js'
import { shouldAutoFocusAskDock } from '../ask-dock-model.js'

const FOCUSABLE_STEP_CONTROL_SELECTOR = [
  '[role="radio"][tabindex="0"]',
  '[role="checkbox"][tabindex="0"]',
  '[role="radio"]',
  '[role="checkbox"]',
  'input:not(:disabled)',
  'textarea:not(:disabled)',
  '.ask-dock-confirm-actions button:not(:disabled)',
  'button.helmx-model-picker-trigger:not(:disabled)',
  'button.composer-model-button:not(:disabled)',
].join(', ')

interface AskCardFocusOptions {
  askId: string
  formRef: React.RefObject<HTMLFormElement | null>
  isPrimaryCard: boolean
  safeActiveStep: number
  safeActiveStepRef: React.RefObject<number>
  shortcutPanel: 'primary' | 'split' | 'drawer'
  shortcutActive: boolean
  hostConversationId: number
}

export interface AskCardFocus {
  isWindowShortcutOwner: () => boolean
  focusStepPrimaryControl: (stepIndex: number) => boolean
}

export function useAskCardFocus({
  askId,
  formRef,
  isPrimaryCard,
  safeActiveStep,
  safeActiveStepRef,
  shortcutPanel,
  shortcutActive,
  hostConversationId,
}: AskCardFocusOptions): AskCardFocus {
  const externalStore = useContext(HelmxExternalStoreContext)

  const isWindowShortcutOwner = useCallback((): boolean => {
    if (!isPrimaryCard || !shortcutActive) return false
    const formEl = formRef.current
    if (formEl === null || !isElementVisibleInDocument(formEl)) return false
    const activeModal = externalStore?.getActiveModal() ?? null
    if (activeModal !== null || hasAnyOpenOverlay(null, false)) return false
    if (externalStore === null) return true
    const drawerStack = externalStore.getDrawerStack()
    const topFrame = topDrawerFrame(drawerStack)
    if (topFrame !== undefined) {
      return (
        topFrame.kind === 'conversation' &&
        shortcutPanel === 'drawer' &&
        topFrame.conversationId === hostConversationId
      )
    }
    const focused = resolveFocusedPanel(externalStore.getFocusedPanel(), externalStore.getSplitTarget())
    return focused === shortcutPanel
  }, [isPrimaryCard, shortcutActive, externalStore, shortcutPanel, hostConversationId, formRef])

  const focusStepPrimaryControl = useCallback((stepIndex: number): boolean => {
    const formEl = formRef.current
    if (formEl === null) return false
    const panels = [...formEl.querySelectorAll<HTMLElement>('.ask-dock-step-panel')]
    const panelEl = panels[stepIndex] ?? formEl
    const target = panelEl.querySelector<HTMLElement>(FOCUSABLE_STEP_CONTROL_SELECTOR)
    if (target === null) return false
    target.focus()
    return true
  }, [formRef])

  // Auto-focus first control on mount or when promoted to primary card while focus is neutral or inside an empty composer.
  const prevAutoFocusKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const nextKey = isPrimaryCard ? askId : null
    if (nextKey === null || prevAutoFocusKeyRef.current === nextKey) {
      if (nextKey === null) prevAutoFocusKeyRef.current = null
      return
    }
    prevAutoFocusKeyRef.current = nextKey
    if (!isWindowShortcutOwner()) return
    const formEl = formRef.current
    if (!shouldAutoFocusAskDock(document.activeElement, formEl)) return
    focusStepPrimaryControl(safeActiveStepRef.current)
  }, [askId, isPrimaryCard, isWindowShortcutOwner, focusStepPrimaryControl, formRef, safeActiveStepRef])

  // Move focus into the newly revealed step whenever safeActiveStep advances or retreats.
  const prevStepEffectRef = useRef<number | null>(null)
  useEffect(() => {
    if (prevStepEffectRef.current === null) {
      prevStepEffectRef.current = safeActiveStep
      return
    }
    if (prevStepEffectRef.current === safeActiveStep) return
    prevStepEffectRef.current = safeActiveStep
    const formEl = formRef.current
    if (formEl === null) return
    const active = document.activeElement
    if (shouldAutoFocusAskDock(active, formEl) || isWindowShortcutOwner()) {
      focusStepPrimaryControl(safeActiveStep)
    }
  }, [safeActiveStep, focusStepPrimaryControl, isWindowShortcutOwner, formRef])

  return { isWindowShortcutOwner, focusStepPrimaryControl }
}
