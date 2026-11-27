/**
 * Shared key chain for AskCard: the same handler serves the form (`onKeyDown`)
 * and the window (when this card owns shortcuts), so card-level keys keep
 * working with focus anywhere. Owns the option/custom focus request signals the
 * handlers raise and AskFieldInput consumes.
 */
import { useCallback, useEffect, useState } from 'react'
import type * as React from 'react'
import type { AskAnswers, AskSpec } from '@helmx/protocol/browser'
import { isImeComposing } from '../../lib/ime.js'
import { isEditableShortcutTarget } from '../../shell/shortcuts-model.js'
import { resolveAskKeyboardChoiceTarget } from '../ask-dock-model.js'
import type { FocusChoiceOptionRequest } from '../AskDockFields.js'
import {
  focusConfirmButtonByDigit,
  handleArrowKeys,
  handleEnterAdvance,
  handleEscapeToCancel,
  handleModifierEnter,
  handleStepNavigationKeys,
  selectChoiceByDigit,
  type AskCardKeyboardBridge,
} from './ask-dock-keyboard-model.js'

export type AskSharedKeyEvent = KeyboardEvent | React.KeyboardEvent

interface AskCardKeyboardOptions {
  ask: AskSpec
  isStepper: boolean
  isSingleConfirm: boolean
  lastStepIndex: number
  formRef: React.RefObject<HTMLFormElement | null>
  cancelBtnRef: React.RefObject<HTMLButtonElement | null>
  safeActiveStepRef: React.RefObject<number>
  answersRef: React.RefObject<AskAnswers>
  submittingRef: React.RefObject<'answer' | 'cancel' | null>
  isWindowShortcutOwner: () => boolean
  focusStepPrimaryControl: (stepIndex: number) => boolean
  submitAnswers: (payload: AskAnswers) => Promise<void>
  applyFieldPatch: (fieldIndex: number, patch: AskAnswers, meta?: { fromPresetClick?: boolean }) => AskAnswers
  advanceOrSubmitFromStep: (fieldIndex: number, candidateAnswers: AskAnswers) => void
  setActiveStep: React.Dispatch<React.SetStateAction<number>>
}

export interface AskCardKeyboard {
  handleSharedKeyDown: (e: AskSharedKeyEvent, sourceOrigin: 'form' | 'window') => void
  optionFocusReqs: Readonly<Record<string, FocusChoiceOptionRequest>>
  customFocusSignals: Readonly<Record<string, number>>
}

export function useAskCardKeyboard(options: AskCardKeyboardOptions): AskCardKeyboard {
  const {
    ask,
    isStepper,
    isSingleConfirm,
    lastStepIndex,
    formRef,
    cancelBtnRef,
    safeActiveStepRef,
    answersRef,
    submittingRef,
    isWindowShortcutOwner,
    focusStepPrimaryControl,
    submitAnswers,
    applyFieldPatch,
    advanceOrSubmitFromStep,
    setActiveStep,
  } = options

  const [optionFocusReqs, setOptionFocusReqs] = useState<Record<string, FocusChoiceOptionRequest>>({})
  const [customFocusSignals, setCustomFocusSignals] = useState<Record<string, number>>({})

  // Focus requests are monotonic seq/signal bumps: AskChoiceGroup reacts to the change, not the value.
  const requestOptionFocus = useCallback((fieldName: string, index: number): void => {
    setOptionFocusReqs((prev) => ({
      ...prev,
      [fieldName]: { index, seq: (prev[fieldName]?.seq ?? 0) + 1 },
    }))
  }, [])

  const requestCustomFocus = useCallback((fieldName: string): void => {
    setCustomFocusSignals((prev) => ({
      ...prev,
      [fieldName]: (prev[fieldName] ?? 0) + 1,
    }))
  }, [])

  const handleSharedKeyDown = useCallback(
    (e: AskSharedKeyEvent, sourceOrigin: 'form' | 'window'): void => {
      if (submittingRef.current !== null || e.defaultPrevented || isImeComposing(e)) return

      const formEl = formRef.current
      if (formEl === null) return
      const targetEl = e.target instanceof Element ? (e.target as HTMLElement) : null
      if (sourceOrigin === 'window') {
        if (!isWindowShortcutOwner()) return
        if (targetEl !== null && formEl.contains(targetEl)) return
      }

      const curStep = safeActiveStepRef.current
      const curAnswers = answersRef.current
      const kb: AskCardKeyboardBridge = {
        ask,
        isStepper,
        isSingleConfirm,
        lastStepIndex,
        formEl,
        targetEl,
        sourceOrigin,
        curStep,
        curAnswers,
        choiceTarget: resolveAskKeyboardChoiceTarget(ask, isStepper, curStep),
        cancelBtnRef,
        setActiveStep,
        focusStepPrimaryControl,
        submitAnswers,
        applyFieldPatch,
        advanceOrSubmitFromStep,
        requestOptionFocus,
        requestCustomFocus,
      }

      if (handleModifierEnter(kb, e)) return
      if (e.altKey || e.ctrlKey || e.metaKey || isEditableShortcutTarget(targetEl)) return
      if (handleEscapeToCancel(kb, e)) return
      if (handleStepNavigationKeys(kb, e)) return
      if (focusConfirmButtonByDigit(kb, e)) return
      if (selectChoiceByDigit(kb, e)) return
      if (handleArrowKeys(kb, e)) return
      handleEnterAdvance(kb, e)
    },
    [
      advanceOrSubmitFromStep,
      answersRef,
      applyFieldPatch,
      ask,
      cancelBtnRef,
      focusStepPrimaryControl,
      formRef,
      isSingleConfirm,
      isStepper,
      isWindowShortcutOwner,
      lastStepIndex,
      requestCustomFocus,
      requestOptionFocus,
      safeActiveStepRef,
      setActiveStep,
      submitAnswers,
      submittingRef,
    ],
  )

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent): void => {
      handleSharedKeyDown(event, 'window')
    }
    window.addEventListener('keydown', onWindowKeyDown)
    return () => {
      window.removeEventListener('keydown', onWindowKeyDown)
    }
  }, [handleSharedKeyDown])

  return { handleSharedKeyDown, optionFocusReqs, customFocusSignals }
}
