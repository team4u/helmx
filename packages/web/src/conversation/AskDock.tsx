import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import type * as React from 'react'
import {
  resolveLocalizedText,
  type AskAnswers,
  type AskKind,
  type AskSpec,
} from '@helmx/protocol/browser'
import { asksApi } from '../lib/api.js'
import {
  Button,
  Callout,
  Field,
  HelperText,
  HelmxIcon,
  Stack,
} from '@helmx/plugin-client'
import { isElementVisibleInDocument } from '../lib/dom-visibility.js'
import { topDrawerFrame } from '../lib/drawer-stack-model.js'
import { isImeComposing } from '../lib/ime.js'
import { resolveFocusedPanel } from '../lib/panel-focus.js'
import { HelmxExternalStoreContext, useConversations, usePendingAsks, useStoreActions } from '../lib/store-context.js'
import { hasAnyOpenOverlay, isEditableShortcutTarget } from '../shell/shortcuts-model.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { collectSubtreeIds } from './ancestry-model.js'
import {
  AskFieldInput,
  type FocusChoiceOptionRequest,
} from './AskDockFields.js'
import {
  composeMultiChoiceValues,
  extractTerminalSnapshot,
  findNextUnansweredStep,
  initialAskAnswers,
  isMultiChoiceField,
  isPresetOptionValue,
  isSingleQuickChoiceQuestion,
  isSingleRequiredConfirm,
  missingRequiredFields,
  resolveAskKeyboardChoiceTarget,
  resolveAskKind,
  shouldAutoFocusAskDock,
  shouldPromoteFieldLabelToHeader,
  shouldUseQuestionStepper,
} from './ask-dock-model.js'

export interface AskDockProps {
  conversationId: number
  shortcutPanel?: 'primary' | 'split' | 'drawer'
  shortcutActive?: boolean
  onFocusReturn?: () => void
}

/** Source-conversation badge: shown when the ask belongs to another
 * conversation; clicking opens that child conversation's drawer. */
interface AskSourceInfo {
  conversationId: number
  title: string
}

const FOCUSABLE_STEP_CONTROL_SELECTOR = [
  '[role="radio"][tabindex="0"]',
  '[role="checkbox"][tabindex="0"]',
  '[role="radio"]',
  '[role="checkbox"]',
  'input:not(:disabled)',
  'textarea:not(:disabled)',
  '.ask-dock-confirm-actions button:not(:disabled)',
  'button.composer-model-button:not(:disabled)',
].join(', ')

function AskCardHeader({
  headerTitle,
  isStepper,
  safeActiveStep,
  lastStepIndex,
  totalSteps,
  disabled,
  source,
  onPrevStep,
  onNextStep,
  onOpenSource,
}: {
  headerTitle: string
  isStepper: boolean
  safeActiveStep: number
  lastStepIndex: number
  totalSteps: number
  disabled: boolean
  source?: AskSourceInfo
  onPrevStep: () => void
  onNextStep: () => void
  onOpenSource: (conversationId: number) => void
}) {
  const { t } = useWebLocale()
  return (
    <div className="ask-dock-header">
      <span className="ask-dock-title">{headerTitle}</span>
      {isStepper ? (
        <div className="ask-dock-step-nav">
          <button
            type="button"
            className="ask-dock-step-nav-btn"
            aria-label={t('composer.ask.stepPrev')}
            title={t('composer.ask.stepPrev')}
            disabled={disabled || safeActiveStep === 0}
            onClick={onPrevStep}
          >
            <HelmxIcon name="chevron-left" size={13} />
          </button>
          <span className="ask-dock-step-counter tabular-nums" aria-live="polite">
            {t('composer.ask.stepCounter', {
              current: safeActiveStep + 1,
              total: totalSteps,
            })}
          </span>
          <button
            type="button"
            className="ask-dock-step-nav-btn"
            aria-label={t('composer.ask.stepNext')}
            title={t('composer.ask.stepNext')}
            disabled={disabled || safeActiveStep >= lastStepIndex}
            onClick={onNextStep}
          >
            <HelmxIcon name="chevron-right" size={13} />
          </button>
        </div>
      ) : null}
      {source !== undefined ? (
        <Button
          variant="ghost"
          size="sm"
          icon={<HelmxIcon name="corner-down-right" size={11} />}
          className="ask-dock-source-btn"
          title={source.title !== ''
            ? t('composer.ask.openChildTitle', { id: source.conversationId, title: source.title })
            : t('composer.ask.openChildDrawer', { id: source.conversationId })}
          aria-label={t('composer.ask.openChildDrawer', { id: source.conversationId })}
          onClick={() => onOpenSource(source.conversationId)}
        >
          {t('composer.ask.fromSource', { id: source.conversationId })}
        </Button>
      ) : null}
    </div>
  )
}

function AskCardSnapshot({
  text,
  open,
  onToggle,
}: {
  text: string
  open: boolean
  onToggle: () => void
}) {
  const { t } = useWebLocale()
  return (
    <div className="ask-dock-snapshot">
      <Button
        variant="ghost"
        size="sm"
        icon={<HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />}
        className="ask-dock-snapshot-btn"
        onClick={onToggle}
      >
        {t('composer.ask.terminalSnapshot')}
      </Button>
      {open ? (
        <pre className="code-block-pre selectable ask-dock-snapshot-pre">
          <code>{text}</code>
        </pre>
      ) : null}
    </div>
  )
}

function AskCardFooter({
  askKind,
  isQuestion,
  isSingleConfirm,
  isStepper,
  safeActiveStep,
  lastStepIndex,
  missingRequiredCount,
  submitting,
  shortcutHint,
  cancelBtnRef,
  onCancel,
  onNextStep,
}: {
  askKind: AskKind
  isQuestion: boolean
  isSingleConfirm: boolean
  isStepper: boolean
  safeActiveStep: number
  lastStepIndex: number
  missingRequiredCount: number
  submitting: 'answer' | 'cancel' | null
  shortcutHint: string | null
  cancelBtnRef: React.RefObject<HTMLButtonElement | null>
  onCancel: () => void
  onNextStep: () => void
}) {
  const { t } = useWebLocale()
  void askKind
  return (
    <Stack direction="horizontal" justify="between" wrap gap="sm" className="ask-dock-actions">
      <div className="ask-dock-actions-left">
        <Button
          ref={cancelBtnRef}
          variant="ghost"
          size="sm"
          pending={submitting === 'cancel'}
          disabled={submitting !== null && submitting !== 'cancel'}
          onClick={onCancel}
        >
          {t(isQuestion ? 'composer.ask.skip' : 'common.cancel')}
        </Button>
        {shortcutHint !== null ? (
          <span className="ask-dock-shortcut-hint">{shortcutHint}</span>
        ) : null}
      </div>
      {isSingleConfirm ? null : isStepper && safeActiveStep < lastStepIndex && missingRequiredCount > 0 ? (
        <Button
          variant="primary"
          size="sm"
          disabled={submitting !== null}
          onClick={onNextStep}
        >
          {t('composer.ask.stepNext')}
        </Button>
      ) : (
        <Button
          type="submit"
          variant="primary"
          size="sm"
          icon={<HelmxIcon name="check" size={12} />}
          pending={submitting === 'answer'}
          disabled={(submitting !== null && submitting !== 'answer') || missingRequiredCount > 0}
        >
          {t(isQuestion ? 'composer.ask.confirm' : 'composer.ask.submit')}
        </Button>
      )}
    </Stack>
  )
}

function AskCard({
  ask,
  source,
  hostConversationId,
  isPrimaryCard,
  hasNextPendingAsk,
  shortcutPanel,
  shortcutActive,
  onFocusReturn,
}: {
  ask: AskSpec
  source?: AskSourceInfo
  hostConversationId: number
  isPrimaryCard: boolean
  hasNextPendingAsk: boolean
  shortcutPanel: 'primary' | 'split' | 'drawer'
  shortcutActive: boolean
  onFocusReturn?: () => void
}) {
  const { openConversationDrawer } = useStoreActions()
  const externalStore = useContext(HelmxExternalStoreContext)
  const { locale, t } = useWebLocale()
  // The same approval/prompt can appear in both an ancestor panel and a child
  // conversation drawer; form labels associate with this instance only.
  const formId = useId()
  const formRef = useRef<HTMLFormElement | null>(null)
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const [answers, setAnswers] = useState<AskAnswers>(() => initialAskAnswers(ask.fields))
  const answersRef = useRef<AskAnswers>(answers)
  answersRef.current = answers
  const [submitting, setSubmitting] = useState<'answer' | 'cancel' | null>(null)
  const submittingRef = useRef(submitting)
  submittingRef.current = submitting
  const [error, setError] = useState<string | null>(null)
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const [activeStep, setActiveStep] = useState(0)
  const [customFocusSignals, setCustomFocusSignals] = useState<Record<string, number>>({})
  const [optionFocusReqs, setOptionFocusReqs] = useState<Record<string, FocusChoiceOptionRequest>>({})

  const askKind = resolveAskKind(ask)
  const isQuestion = askKind === 'question'
  const isStepper = shouldUseQuestionStepper(ask)
  const safeActiveStep = isStepper ? Math.min(activeStep, Math.max(0, ask.fields.length - 1)) : 0
  const safeActiveStepRef = useRef(safeActiveStep)
  safeActiveStepRef.current = safeActiveStep
  const isSingleConfirm = isSingleRequiredConfirm(ask)
  const isSingleQuickChoice = isSingleQuickChoiceQuestion(ask)

  const titleText = resolveLocalizedText(ask.title, locale)
  const singleField = ask.fields.length === 1 ? ask.fields[0] : undefined
  const promoteLabelToHeader =
    singleField !== undefined &&
    shouldPromoteFieldLabelToHeader(ask, titleText, resolveLocalizedText(singleField.label, locale))
  const headerTitle =
    promoteLabelToHeader && singleField !== undefined ? resolveLocalizedText(singleField.label, locale) : titleText
  const descText = ask.description !== undefined ? resolveLocalizedText(ask.description, locale) : ''
  const hintText = ask.hint !== undefined ? resolveLocalizedText(ask.hint, locale) : ''
  const snapshot = useMemo(() => extractTerminalSnapshot(ask, descText), [ask, descText])
  const missingRequired = useMemo(() => missingRequiredFields(ask, answers), [ask, answers])
  const lastStepIndex = Math.max(0, ask.fields.length - 1)

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
  }, [isPrimaryCard, shortcutActive, externalStore, shortcutPanel, hostConversationId])

  const focusStepPrimaryControl = useCallback((stepIndex: number): boolean => {
    const formEl = formRef.current
    if (formEl === null) return false
    const panels = [...formEl.querySelectorAll<HTMLElement>('.ask-dock-step-panel')]
    const panelEl = panels[stepIndex] ?? formEl
    const target = panelEl.querySelector<HTMLElement>(FOCUSABLE_STEP_CONTROL_SELECTOR)
    if (target === null) return false
    target.focus()
    return true
  }, [])

  // Auto-focus first control on mount or when promoted to primary card while focus is neutral or inside an empty composer.
  const prevAutoFocusKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const nextKey = isPrimaryCard ? ask.id : null
    if (nextKey === null || prevAutoFocusKeyRef.current === nextKey) {
      if (nextKey === null) prevAutoFocusKeyRef.current = null
      return
    }
    prevAutoFocusKeyRef.current = nextKey
    if (!isWindowShortcutOwner()) return
    const formEl = formRef.current
    if (!shouldAutoFocusAskDock(document.activeElement, formEl)) return
    focusStepPrimaryControl(safeActiveStepRef.current)
  }, [ask.id, isPrimaryCard, isWindowShortcutOwner, focusStepPrimaryControl])

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
  }, [safeActiveStep, focusStepPrimaryControl, isWindowShortcutOwner])

  const submitAnswers = useCallback(
    async (payload: AskAnswers): Promise<void> => {
      const hadFocus = formRef.current?.contains(document.activeElement) ?? false
      setSubmitting('answer')
      submittingRef.current = 'answer'
      setError(null)
      try {
        await asksApi.answer(ask.id, payload, ask.expectedStateSeq)
        if (
          !hasNextPendingAsk &&
          (hadFocus || document.activeElement === document.body || document.activeElement === null)
        ) {
          onFocusReturn?.()
        }
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        submittingRef.current = null
        if (mountedRef.current) {
          setSubmitting(null)
        }
      }
    },
    [ask.id, ask.expectedStateSeq, hasNextPendingAsk, onFocusReturn],
  )

  const submit = async (): Promise<void> => {
    const curAnswers = answersRef.current
    if (isSingleConfirm || submittingRef.current !== null || missingRequiredFields(ask, curAnswers).length > 0) {
      return
    }
    await submitAnswers(curAnswers)
  }

  const cancel = async (): Promise<void> => {
    const hadFocus = formRef.current?.contains(document.activeElement) ?? false
    setSubmitting('cancel')
    submittingRef.current = 'cancel'
    setError(null)
    try {
      await asksApi.cancel(ask.id)
      if (
        !hasNextPendingAsk &&
        (hadFocus || document.activeElement === document.body || document.activeElement === null)
      ) {
        onFocusReturn?.()
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      submittingRef.current = null
      if (mountedRef.current) {
        setSubmitting(null)
      }
    }
  }

  const applyFieldPatch = useCallback(
    (
      fieldIndex: number,
      patch: AskAnswers,
      meta?: { fromPresetClick?: boolean },
    ): AskAnswers => {
      const nextAnswers: AskAnswers = { ...answersRef.current, ...patch }
      answersRef.current = nextAnswers
      setAnswers((prev) => ({ ...prev, ...patch }))
      if (isSingleConfirm || (isSingleQuickChoice && meta?.fromPresetClick === true)) {
        void submitAnswers(isSingleConfirm ? patch : nextAnswers)
        return nextAnswers
      }
      const field = ask.fields[fieldIndex]
      if (
        isStepper &&
        meta?.fromPresetClick === true &&
        field !== undefined &&
        field.type === 'choice' &&
        !isMultiChoiceField(field)
      ) {
        const nextIdx = findNextUnansweredStep(ask, nextAnswers, fieldIndex)
        if (nextIdx !== -1) {
          setActiveStep(nextIdx)
        }
      }
      return nextAnswers
    },
    [ask, isSingleConfirm, isSingleQuickChoice, isStepper, submitAnswers],
  )

  const advanceOrSubmitFromStep = useCallback(
    (fieldIndex: number, candidateAnswers: AskAnswers): void => {
      if (isSingleConfirm || submittingRef.current !== null) return
      if (isStepper) {
        const nextUnanswered = findNextUnansweredStep(ask, candidateAnswers, fieldIndex)
        if (nextUnanswered !== -1 && fieldIndex < lastStepIndex) {
          setActiveStep(nextUnanswered)
          return
        }
        if (missingRequiredFields(ask, candidateAnswers).length === 0) {
          void submitAnswers(candidateAnswers)
          return
        }
        if (nextUnanswered !== -1) {
          setActiveStep(nextUnanswered)
          return
        }
      }
      const missing = missingRequiredFields(ask, candidateAnswers)
      if (missing.length === 0) {
        void submitAnswers(candidateAnswers)
        return
      }
      const firstMissingIdx = ask.fields.findIndex((f) => f.name === missing[0]?.name)
      if (firstMissingIdx >= 0) {
        if (isStepper) setActiveStep(firstMissingIdx)
        else focusStepPrimaryControl(firstMissingIdx)
      }
    },
    [ask, focusStepPrimaryControl, isSingleConfirm, isStepper, lastStepIndex, submitAnswers],
  )

  const handleSingleOptionEnter = useCallback(
    (fieldIndex: number, fieldName: string, optValue: string): void => {
      const nextAnswers = applyFieldPatch(fieldIndex, { [fieldName]: optValue }, { fromPresetClick: false })
      advanceOrSubmitFromStep(fieldIndex, nextAnswers)
    },
    [advanceOrSubmitFromStep, applyFieldPatch],
  )

  const handleEnterNextOrSubmit = useCallback(
    (fieldIndex: number): void => {
      advanceOrSubmitFromStep(fieldIndex, answersRef.current)
    },
    [advanceOrSubmitFromStep],
  )

  const handleSharedKeyDown = useCallback(
    (e: KeyboardEvent | React.KeyboardEvent, sourceOrigin: 'form' | 'window'): void => {
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
      const inEditable = isEditableShortcutTarget(targetEl)

      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.altKey) {
        e.preventDefault()
        if (!isSingleConfirm && missingRequiredFields(ask, curAnswers).length === 0) {
          void submitAnswers(curAnswers)
        } else if (isStepper) {
          advanceOrSubmitFromStep(curStep, curAnswers)
        }
        return
      }

      if (e.altKey || e.ctrlKey || e.metaKey || inEditable) return

      if (sourceOrigin === 'form' && e.key === 'Escape' && !e.shiftKey) {
        if (
          targetEl !== cancelBtnRef.current &&
          cancelBtnRef.current !== null &&
          !cancelBtnRef.current.disabled
        ) {
          e.preventDefault()
          e.stopPropagation()
          cancelBtnRef.current.focus()
        }
        return
      }

      if (isStepper && (e.key === 'PageUp' || e.key === '[' || (!e.shiftKey && e.key === 'ArrowLeft'))) {
        e.preventDefault()
        setActiveStep((s) => Math.max(0, s - 1))
        return
      }
      if (isStepper && (e.key === 'PageDown' || e.key === ']' || (!e.shiftKey && e.key === 'ArrowRight'))) {
        e.preventDefault()
        setActiveStep((s) => Math.min(lastStepIndex, s + 1))
        return
      }

      const choiceTarget = resolveAskKeyboardChoiceTarget(ask, isStepper, curStep)

      if (choiceTarget === undefined && !e.shiftKey && (e.key === '1' || e.key === '2')) {
        const confirmStepIdx = isStepper
          ? (ask.fields[curStep]?.type === 'confirm' ? curStep : -1)
          : (() => {
              const indices = ask.fields.map((f, i) => (f.type === 'confirm' ? i : -1)).filter((i) => i >= 0)
              return indices.length === 1 ? indices[0]! : -1
            })()
        if (confirmStepIdx >= 0) {
          const panels = [...formEl.querySelectorAll<HTMLElement>('.ask-dock-step-panel')]
          const panelEl = panels[confirmStepIdx] ?? formEl
          const btns = [...panelEl.querySelectorAll<HTMLButtonElement>('.ask-dock-confirm-actions button:not(:disabled)')]
          const targetBtn = btns[Number(e.key) - 1]
          if (targetBtn !== undefined) {
            e.preventDefault()
            targetBtn.focus()
            return
          }
        }
      }

      if (!e.shiftKey && /^[1-9]$/.test(e.key) && choiceTarget !== undefined) {
        const { field: targetField, fieldIndex: targetIndex } = choiceTarget
        const opts = targetField.options ?? []
        const idx = Number(e.key) - 1
        if (idx >= 0 && idx < opts.length) {
          const opt = opts[idx]!
          e.preventDefault()
          if (isMultiChoiceField(targetField)) {
            const cur = Array.isArray(curAnswers[targetField.name])
              ? (curAnswers[targetField.name] as string[])
              : []
            const presetSet = new Set(cur.filter((v) => isPresetOptionValue(targetField, v)))
            if (presetSet.has(opt.value)) presetSet.delete(opt.value)
            else presetSet.add(opt.value)
            const customItem = cur.find((v) => !isPresetOptionValue(targetField, v))
            applyFieldPatch(targetIndex, {
              [targetField.name]: composeMultiChoiceValues(targetField, [...presetSet], customItem),
            })
            setOptionFocusReqs((prev) => ({
              ...prev,
              [targetField.name]: { index: idx, seq: (prev[targetField.name]?.seq ?? 0) + 1 },
            }))
          } else {
            const nextAnswers = applyFieldPatch(
              targetIndex,
              { [targetField.name]: opt.value },
              { fromPresetClick: isStepper },
            )
            const staysOnSameStep =
              !isStepper || findNextUnansweredStep(ask, nextAnswers, targetIndex) === -1
            if (staysOnSameStep) {
              setOptionFocusReqs((prev) => ({
                ...prev,
                [targetField.name]: { index: idx, seq: (prev[targetField.name]?.seq ?? 0) + 1 },
              }))
            }
          }
          return
        }
        if (targetField.allowCustom === true && idx === opts.length) {
          e.preventDefault()
          setCustomFocusSignals((prev) => ({
            ...prev,
            [targetField.name]: (prev[targetField.name] ?? 0) + 1,
          }))
          return
        }
      }

      // When focus sits on the card or outside the dock (not already inside a radio/checkbox),
      // ArrowDown / ArrowUp / Enter let the user start navigating and confirming purely via keyboard.
      const targetRole = targetEl?.getAttribute('role') ?? ''
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && targetRole !== 'radio' && targetRole !== 'checkbox') {
        if (choiceTarget !== undefined) {
          const opts = choiceTarget.field.options ?? []
          const total = opts.length + (choiceTarget.field.allowCustom === true ? 1 : 0)
          if (total > 0) {
            e.preventDefault()
            if (isMultiChoiceField(choiceTarget.field)) {
              const idx = e.key === 'ArrowDown' ? 0 : total - 1
              setOptionFocusReqs((prev) => ({
                ...prev,
                [choiceTarget.field.name]: { index: idx, seq: (prev[choiceTarget.field.name]?.seq ?? 0) + 1 },
              }))
            } else {
              const curVal = typeof curAnswers[choiceTarget.field.name] === 'string' ? (curAnswers[choiceTarget.field.name] as string) : ''
              const curIdx = opts.findIndex((o) => o.value === curVal)
              const nextIdx =
                e.key === 'ArrowDown'
                  ? curIdx >= 0 ? (curIdx + 1) % total : 0
                  : curIdx >= 0 ? (curIdx - 1 + total) % total : total - 1
              if (nextIdx < opts.length) {
                applyFieldPatch(choiceTarget.fieldIndex, { [choiceTarget.field.name]: opts[nextIdx]!.value }, { fromPresetClick: false })
                setOptionFocusReqs((prev) => ({
                  ...prev,
                  [choiceTarget.field.name]: { index: nextIdx, seq: (prev[choiceTarget.field.name]?.seq ?? 0) + 1 },
                }))
              } else {
                setCustomFocusSignals((prev) => ({
                  ...prev,
                  [choiceTarget.field.name]: (prev[choiceTarget.field.name] ?? 0) + 1,
                }))
              }
            }
          }
          return
        }
        if (sourceOrigin === 'window' || targetEl === formEl) {
          e.preventDefault()
          focusStepPrimaryControl(curStep)
        }
        return
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        const tag = targetEl?.tagName ?? ''
        const isInteractiveTarget =
          tag === 'BUTTON' ||
          tag === 'A' ||
          (targetEl !== null && targetEl.closest('button, a, [role="button"], [role="menuitem"], [role="option"]') !== null)
        if (!isInteractiveTarget) {
          e.preventDefault()
          advanceOrSubmitFromStep(curStep, curAnswers)
        }
      }
    },
    [
      advanceOrSubmitFromStep,
      applyFieldPatch,
      ask,
      focusStepPrimaryControl,
      isSingleConfirm,
      isStepper,
      isWindowShortcutOwner,
      lastStepIndex,
      submitAnswers,
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

  const visibleDescription =
    snapshot?.source === 'description'
      ? snapshot.prefix
      : descText.trim() ? descText : undefined

  const activeField = isStepper ? ask.fields[safeActiveStep] : undefined
  const activeChoiceField = resolveAskKeyboardChoiceTarget(ask, isStepper, safeActiveStep)?.field
  const shortcutHintKey = isStepper
    ? 'composer.ask.shortcutHintStepper'
    : activeChoiceField !== undefined && isMultiChoiceField(activeChoiceField)
      ? 'composer.ask.shortcutHintMulti'
      : 'composer.ask.shortcutHint'
  const showShortcutHint =
    activeChoiceField !== undefined || (isStepper && activeField !== undefined)

  return (
    <form
      ref={formRef}
      className={`ask-dock ask-dock--${askKind}`}
      data-ask-kind={askKind}
      tabIndex={-1}
      onKeyDown={(e) => handleSharedKeyDown(e, 'form')}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <AskCardHeader
        headerTitle={headerTitle}
        isStepper={isStepper}
        safeActiveStep={safeActiveStep}
        lastStepIndex={lastStepIndex}
        totalSteps={ask.fields.length}
        disabled={submitting !== null}
        source={source}
        onPrevStep={() => setActiveStep((s) => Math.max(0, s - 1))}
        onNextStep={() => setActiveStep((s) => Math.min(lastStepIndex, s + 1))}
        onOpenSource={openConversationDrawer}
      />
      {visibleDescription !== undefined ? (
        <div className="ask-dock-desc">{visibleDescription}</div>
      ) : null}
      {snapshot !== undefined ? (
        <AskCardSnapshot
          text={snapshot.text}
          open={snapshotOpen}
          onToggle={() => setSnapshotOpen((v) => !v)}
        />
      ) : null}
      {ask.fields.length > 0 ? (
        <Stack gap="sm" className="ask-dock-fields">
          {ask.fields.map((field, index) => {
            const fieldLabel = resolveLocalizedText(field.label, locale)
            const fieldId = `${formId}-${field.name}`
            const rawThinking =
              typeof field.thinkingLevelField === 'string' && field.thinkingLevelField !== ''
                ? answers[field.thinkingLevelField]
                : undefined
            const stepHidden = isStepper && index !== safeActiveStep
            const control = (
              <AskFieldInput
                conversationId={ask.conversationId}
                askKind={askKind}
                isStepper={isStepper}
                field={field}
                fieldId={fieldId}
                fieldLabel={fieldLabel}
                value={answers[field.name]}
                thinkingLevelValue={typeof rawThinking === 'string' ? rawThinking : undefined}
                focusCustomSignal={customFocusSignals[field.name] ?? 0}
                focusOptionReq={optionFocusReqs[field.name]}
                disabled={submitting !== null}
                onPatchAnswers={(patch, meta) => applyFieldPatch(index, patch, meta)}
                onSingleOptionEnter={(optValue) => handleSingleOptionEnter(index, field.name, optValue)}
                onEnterNextOrSubmit={() => handleEnterNextOrSubmit(index)}
                onExitTextToCard={() => formRef.current?.focus()}
              />
            )
            return (
              <div
                key={field.name}
                className="ask-dock-step-panel"
                hidden={stepHidden}
              >
                {promoteLabelToHeader ? (
                  <div className="ask-dock-field">{control}</div>
                ) : (
                  <Field
                    className="ask-dock-field"
                    label={fieldLabel}
                    required={!isQuestion && field.required === true}
                    htmlFor={field.type === 'confirm' || field.type === 'choice' ? false : fieldId}
                  >
                    {control}
                  </Field>
                )}
              </div>
            )
          })}
        </Stack>
      ) : null}
      {hintText.trim() !== '' ? (
        <HelperText className="ask-dock-hint">{hintText}</HelperText>
      ) : null}
      {error !== null ? (
        <Callout tone="err">
          <span className="callout-text">{error}</span>
        </Callout>
      ) : null}
      <AskCardFooter
        askKind={askKind}
        isQuestion={isQuestion}
        isSingleConfirm={isSingleConfirm}
        isStepper={isStepper}
        safeActiveStep={safeActiveStep}
        lastStepIndex={lastStepIndex}
        missingRequiredCount={missingRequired.length}
        submitting={submitting}
        shortcutHint={showShortcutHint ? t(shortcutHintKey) : null}
        cancelBtnRef={cancelBtnRef}
        onCancel={() => void cancel()}
        onNextStep={() => setActiveStep((s) => Math.min(lastStepIndex, s + 1))}
      />
    </form>
  )
}

function AskDockActive({
  conversationId,
  pendingAsks,
  shortcutPanel,
  shortcutActive,
  onFocusReturn,
}: {
  conversationId: number
  pendingAsks: ReadonlyArray<AskSpec>
  shortcutPanel: 'primary' | 'split' | 'drawer'
  shortcutActive: boolean
  onFocusReturn?: () => void
}) {
  const conversations = useConversations()
  // Ancestry derives purely from conversations; pending asks of
  // descendant conversations are surfaced as well.
  const subtreeIds = useMemo(
    () => collectSubtreeIds(conversations, conversationId),
    [conversations, conversationId],
  )
  const pending = pendingAsks.filter(
    (a) => a.status === 'pending' && subtreeIds.has(a.conversationId),
  )
  if (pending.length === 0) return null
  return (
    <Stack gap="sm" className="ask-dock-stack">
      {pending.map((ask, cardIndex) => (
        <AskCard
          key={ask.id}
          ask={ask}
          hostConversationId={conversationId}
          isPrimaryCard={cardIndex === 0}
          hasNextPendingAsk={pending.length > 1}
          shortcutPanel={shortcutPanel}
          shortcutActive={shortcutActive}
          onFocusReturn={onFocusReturn}
          {...(ask.conversationId !== conversationId
            ? {
                source: {
                  conversationId: ask.conversationId,
                  title: conversations.find((conv) => conv.id === ask.conversationId)?.title ?? '',
                },
              }
            : {})}
        />
      ))}
    </Stack>
  )
}

/** Bottom-docked ask & approval stack: pending AskDoc cards of the current
 * conversation and all of its descendants. AskDoc is conversation-scoped:
 * answer/cancel still go through the original asksApi (with the
 * expectedStateSeq CAS); this dock only aggregates display and changes nothing
 * about the approval chain. */
export function AskDock({
  conversationId,
  shortcutPanel = 'primary',
  shortcutActive = true,
  onFocusReturn,
}: AskDockProps) {
  const pendingAsks = usePendingAsks()
  if (!pendingAsks.some((a) => a.status === 'pending')) return null
  return (
    <AskDockActive
      conversationId={conversationId}
      pendingAsks={pendingAsks}
      shortcutPanel={shortcutPanel}
      shortcutActive={shortcutActive}
      onFocusReturn={onFocusReturn}
    />
  )
}
