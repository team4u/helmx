/**
 * Pure keyboard handlers for AskCard (no hooks, no JSX). Each handler owns one
 * key family, mutates the card only through the bridge it is handed, and
 * reports whether the event is settled so the orchestrating hook can stop the
 * shared form/window key chain.
 */
import type * as React from 'react'
import type { AskAnswers, AskFieldSpec, AskSpec } from '@helmx/protocol/browser'
import {
  composeMultiChoiceValues,
  findNextUnansweredStep,
  isMultiChoiceField,
  isPresetOptionValue,
  missingRequiredFields,
  resolveAskKeyboardChoiceTarget,
} from '../ask-dock-model.js'

/** Structural subset shared by DOM and React keyboard events (both key chains reuse the handlers). */
export interface AskKeyEvent {
  key: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  defaultPrevented: boolean
  target: EventTarget | null
  preventDefault(): void
  stopPropagation(): void
}

export type AskKeyboardChoiceTarget = NonNullable<ReturnType<typeof resolveAskKeyboardChoiceTarget>>

type FieldPatchMeta = { fromPresetClick?: boolean }

/** Everything a key handler needs to know about the card at the moment of the event. */
export interface AskCardKeyboardBridge {
  ask: AskSpec
  isStepper: boolean
  isSingleConfirm: boolean
  lastStepIndex: number
  formEl: HTMLFormElement
  targetEl: HTMLElement | null
  sourceOrigin: 'form' | 'window'
  /** Active step and answers are read through refs so a late key event never acts on stale values. */
  curStep: number
  curAnswers: AskAnswers
  choiceTarget: AskKeyboardChoiceTarget | undefined
  cancelBtnRef: React.RefObject<HTMLButtonElement | null>
  setActiveStep: React.Dispatch<React.SetStateAction<number>>
  focusStepPrimaryControl: (stepIndex: number) => boolean
  submitAnswers: (payload: AskAnswers) => Promise<void>
  applyFieldPatch: (fieldIndex: number, patch: AskAnswers, meta?: FieldPatchMeta) => AskAnswers
  advanceOrSubmitFromStep: (fieldIndex: number, candidateAnswers: AskAnswers) => void
  requestOptionFocus: (fieldName: string, index: number) => void
  requestCustomFocus: (fieldName: string) => void
}

/** Stepper: the active step when it is a confirm; flat card: the sole confirm field, else -1. */
function resolveConfirmStepIndex(ask: AskSpec, isStepper: boolean, activeStep: number): number {
  if (isStepper) return ask.fields[activeStep]?.type === 'confirm' ? activeStep : -1
  const confirmIndices = ask.fields.flatMap((field, index) => (field.type === 'confirm' ? [index] : []))
  return confirmIndices.length === 1 ? confirmIndices[0]! : -1
}

/** Ctrl/Cmd+Enter submits when complete (never a single-confirm), otherwise lets the stepper advance or submit. */
export function handleModifierEnter(kb: AskCardKeyboardBridge, e: AskKeyEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.key !== 'Enter' || e.altKey) return false
  e.preventDefault()
  if (!kb.isSingleConfirm && missingRequiredFields(kb.ask, kb.curAnswers).length === 0) {
    void kb.submitAnswers(kb.curAnswers)
  } else if (kb.isStepper) {
    kb.advanceOrSubmitFromStep(kb.curStep, kb.curAnswers)
  }
  return true
}

/** Escape inside the form moves focus to Cancel/Skip so a second Escape yields to the global abort. */
export function handleEscapeToCancel(kb: AskCardKeyboardBridge, e: AskKeyEvent): boolean {
  if (kb.sourceOrigin !== 'form' || e.key !== 'Escape' || e.shiftKey) return false
  const cancelBtn = kb.cancelBtnRef.current
  if (kb.targetEl !== cancelBtn && cancelBtn !== null && !cancelBtn.disabled) {
    e.preventDefault()
    e.stopPropagation()
    cancelBtn.focus()
  }
  return true
}

/** Stepper navigation: PageUp / `[` / ArrowLeft step back, PageDown / `]` / ArrowRight step forward. */
export function handleStepNavigationKeys(kb: AskCardKeyboardBridge, e: AskKeyEvent): boolean {
  if (!kb.isStepper) return false
  if (e.key === 'PageUp' || e.key === '[' || (!e.shiftKey && e.key === 'ArrowLeft')) {
    e.preventDefault()
    kb.setActiveStep((step) => Math.max(0, step - 1))
    return true
  }
  if (e.key === 'PageDown' || e.key === ']' || (!e.shiftKey && e.key === 'ArrowRight')) {
    e.preventDefault()
    kb.setActiveStep((step) => Math.min(kb.lastStepIndex, step + 1))
    return true
  }
  return false
}

/** With no choice field owning digits, 1/2 focus the enabled confirm buttons (Approve / Reject). */
export function focusConfirmButtonByDigit(kb: AskCardKeyboardBridge, e: AskKeyEvent): boolean {
  if (kb.choiceTarget !== undefined || e.shiftKey || (e.key !== '1' && e.key !== '2')) return false
  const confirmStepIdx = resolveConfirmStepIndex(kb.ask, kb.isStepper, kb.curStep)
  if (confirmStepIdx < 0) return false
  const panels = [...kb.formEl.querySelectorAll<HTMLElement>('.ask-dock-step-panel')]
  const panelEl = panels[confirmStepIdx] ?? kb.formEl
  const buttons = [...panelEl.querySelectorAll<HTMLButtonElement>('.ask-dock-confirm-actions button:not(:disabled)')]
  const targetBtn = buttons[Number(e.key) - 1]
  if (targetBtn === undefined) return false
  e.preventDefault()
  targetBtn.focus()
  return true
}

/** Digits 1-9 pick a preset (single-select) or toggle it (multi-select); the digit after the last preset opens Other. */
export function selectChoiceByDigit(kb: AskCardKeyboardBridge, e: AskKeyEvent): boolean {
  const target = kb.choiceTarget
  if (e.shiftKey || !/^[1-9]$/.test(e.key) || target === undefined) return false
  const opts = target.field.options ?? []
  const idx = Number(e.key) - 1
  if (idx >= 0 && idx < opts.length) {
    e.preventDefault()
    const optValue = opts[idx]!.value
    if (isMultiChoiceField(target.field)) toggleMultiChoicePreset(kb, target.field, target.fieldIndex, optValue, idx)
    else pickSingleChoicePreset(kb, target.field, target.fieldIndex, optValue, idx)
    return true
  }
  if (target.field.allowCustom === true && idx === opts.length) {
    e.preventDefault()
    kb.requestCustomFocus(target.field.name)
    return true
  }
  return false
}

function toggleMultiChoicePreset(
  kb: AskCardKeyboardBridge,
  field: AskFieldSpec,
  fieldIndex: number,
  optValue: string,
  idx: number,
): void {
  const current = Array.isArray(kb.curAnswers[field.name]) ? (kb.curAnswers[field.name] as string[]) : []
  const presetSet = new Set(current.filter((value) => isPresetOptionValue(field, value)))
  if (presetSet.has(optValue)) presetSet.delete(optValue)
  else presetSet.add(optValue)
  const customItem = current.find((value) => !isPresetOptionValue(field, value))
  kb.applyFieldPatch(fieldIndex, {
    [field.name]: composeMultiChoiceValues(field, [...presetSet], customItem),
  })
  kb.requestOptionFocus(field.name, idx)
}

function pickSingleChoicePreset(
  kb: AskCardKeyboardBridge,
  field: AskFieldSpec,
  fieldIndex: number,
  optValue: string,
  idx: number,
): void {
  const nextAnswers = kb.applyFieldPatch(fieldIndex, { [field.name]: optValue }, { fromPresetClick: kb.isStepper })
  // A stepper auto-advance hands focus to the next step's control; otherwise focus stays on the picked option.
  const staysOnSameStep = !kb.isStepper || findNextUnansweredStep(kb.ask, nextAnswers, fieldIndex) === -1
  if (staysOnSameStep) kb.requestOptionFocus(field.name, idx)
}

/**
 * ArrowDown / ArrowUp outside a radio/checkbox: move through the active choice field
 * (multi-select only moves focus, single-select also picks) or, with no choice target,
 * enter the active step's first control from the card or window.
 */
export function handleArrowKeys(kb: AskCardKeyboardBridge, e: AskKeyEvent): boolean {
  const targetRole = kb.targetEl?.getAttribute('role') ?? ''
  if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || targetRole === 'radio' || targetRole === 'checkbox') {
    return false
  }
  if (kb.choiceTarget !== undefined) {
    moveChoiceByArrow(kb, e, kb.choiceTarget)
    return true
  }
  if (kb.sourceOrigin === 'window' || kb.targetEl === kb.formEl) {
    e.preventDefault()
    kb.focusStepPrimaryControl(kb.curStep)
  }
  return true
}

function moveChoiceByArrow(kb: AskCardKeyboardBridge, e: AskKeyEvent, target: AskKeyboardChoiceTarget): void {
  const { field, fieldIndex } = target
  const opts = field.options ?? []
  const total = opts.length + (field.allowCustom === true ? 1 : 0)
  if (total === 0) return
  e.preventDefault()
  if (isMultiChoiceField(field)) {
    kb.requestOptionFocus(field.name, e.key === 'ArrowDown' ? 0 : total - 1)
    return
  }
  const currentValue =
    typeof kb.curAnswers[field.name] === 'string' ? (kb.curAnswers[field.name] as string) : ''
  const currentIdx = opts.findIndex((opt) => opt.value === currentValue)
  const nextIdx =
    e.key === 'ArrowDown'
      ? currentIdx >= 0 ? (currentIdx + 1) % total : 0
      : currentIdx >= 0 ? (currentIdx - 1 + total) % total : total - 1
  if (nextIdx >= opts.length) {
    kb.requestCustomFocus(field.name)
    return
  }
  kb.applyFieldPatch(fieldIndex, { [field.name]: opts[nextIdx]!.value }, { fromPresetClick: false })
  kb.requestOptionFocus(field.name, nextIdx)
}

/** Enter on a non-interactive target advances the stepper or submits; buttons/links keep their native activation. */
export function handleEnterAdvance(kb: AskCardKeyboardBridge, e: AskKeyEvent): boolean {
  if (e.key !== 'Enter' || e.shiftKey) return false
  const tag = kb.targetEl?.tagName ?? ''
  const isInteractiveTarget =
    tag === 'BUTTON' ||
    tag === 'A' ||
    (kb.targetEl !== null && kb.targetEl.closest('button, a, [role="button"], [role="menuitem"], [role="option"]') !== null)
  if (isInteractiveTarget) return false
  e.preventDefault()
  kb.advanceOrSubmitFromStep(kb.curStep, kb.curAnswers)
  return true
}
