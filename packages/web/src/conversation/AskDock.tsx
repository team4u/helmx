import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import type * as React from 'react'
import {
  resolveLocalizedText,
  type AskAnswers,
  type AskAnswerValue,
  type AskFieldSpec,
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
  Input,
  ModelPickerControl,
  Select,
  Stack,
  Textarea,
} from '@helmx/plugin-client'
import { topDrawerFrame } from '../lib/drawer-stack-model.js'
import { HelmxExternalStoreContext, useConversations, usePendingAsks, useStoreActions } from '../lib/store-context.js'
import { hasAnyOpenOverlay, isEditableShortcutTarget, resolveFocusedPanel } from '../shell/shortcuts-model.js'
import { isElementVisibleInDocument } from '../shell/version-watch-model.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { collectSubtreeIds } from './ancestry-model.js'
import { useModelPickerControlAdapter } from './model-picker-adapter.js'
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

interface FocusChoiceOptionRequest {
  index: number
  seq: number
}

const FOCUSABLE_STEP_CONTROL_SELECTOR = [
  '[role="radio"][tabindex="0"]',
  '[role="checkbox"][tabindex="0"]',
  '[role="radio"]',
  '[role="checkbox"]',
  'input:not(:disabled)',
  'textarea:not(:disabled)',
  '.ask-dock-confirm-actions button:not(:disabled)',
  'select:not(:disabled)',
  'button.composer-model-button:not(:disabled)',
].join(', ')

function AskChoiceGroup({
  field,
  fieldLabel,
  value,
  disabled,
  isStepper,
  focusCustomSignal,
  focusOptionReq,
  onChange,
  onSingleOptionEnter,
  onEnterNextOrSubmit,
}: {
  field: AskFieldSpec
  fieldLabel: string
  value: AskAnswerValue | undefined
  disabled: boolean
  isStepper: boolean
  focusCustomSignal: number
  focusOptionReq?: FocusChoiceOptionRequest
  onChange: (next: AskAnswerValue, meta?: { fromPresetClick?: boolean }) => void
  onSingleOptionEnter: (optValue: string) => void
  onEnterNextOrSubmit: () => void
}) {
  const { locale, t } = useWebLocale()
  const options = field.options ?? []
  const multiple = isMultiChoiceField(field)
  const allowCustom = field.allowCustom === true
  const customPlaceholder =
    field.placeholder !== undefined ? resolveLocalizedText(field.placeholder, locale) : undefined
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const customInputRef = useRef<HTMLInputElement | null>(null)
  const presetValues = useMemo(() => new Set(options.map((opt) => opt.value)), [options])

  const singleStr = !multiple && typeof value === 'string' ? value : ''
  const multiList = multiple && Array.isArray(value) ? value : []
  const externalSingleCustom = !multiple && singleStr !== '' && !presetValues.has(singleStr)
  const externalMultiCustom = multiple ? multiList.find((item) => !presetValues.has(item)) : undefined

  const [customOpen, setCustomOpen] = useState<boolean>(
    () => allowCustom && (multiple ? externalMultiCustom !== undefined : externalSingleCustom),
  )
  const [customDraft, setCustomDraft] = useState<string>(
    () => (multiple ? externalMultiCustom : externalSingleCustom ? singleStr : '') ?? '',
  )
  const [focusRequestCount, setFocusRequestCount] = useState(0)
  const [focusedMultiIndex, setFocusedMultiIndex] = useState(0)

  const isCustomActive = allowCustom && (customOpen || (multiple ? externalMultiCustom !== undefined : externalSingleCustom))
  const selectedPresets = useMemo(
    () => (multiple ? multiList.filter((item) => presetValues.has(item)) : []),
    [multiple, multiList, presetValues],
  )
  const selectedPresetSet = useMemo(() => new Set(selectedPresets), [selectedPresets])
  const totalChoices = options.length + (allowCustom ? 1 : 0)
  const clampedMultiIndex = Math.min(focusedMultiIndex, Math.max(0, totalChoices - 1))

  const prevFocusCustomSignalRef = useRef(focusCustomSignal)
  useEffect(() => {
    if (focusCustomSignal > prevFocusCustomSignalRef.current && allowCustom) {
      setCustomOpen(true)
      setFocusRequestCount((n) => n + 1)
      if (multiple) {
        setFocusedMultiIndex(options.length)
        onChange(composeMultiChoiceValues(field, selectedPresets, customDraft), { fromPresetClick: false })
      } else {
        onChange(customDraft, { fromPresetClick: false })
      }
    }
    prevFocusCustomSignalRef.current = focusCustomSignal
  }, [focusCustomSignal, allowCustom, multiple, options.length, field, selectedPresets, customDraft, onChange])

  useEffect(() => {
    if (focusRequestCount > 0 && isCustomActive) {
      customInputRef.current?.focus()
    }
  }, [focusRequestCount, isCustomActive])

  useEffect(() => {
    if (focusOptionReq === undefined) return
    const targetBtn = optionRefs.current[focusOptionReq.index]
    if (targetBtn !== null && targetBtn !== undefined) {
      if (multiple) setFocusedMultiIndex(focusOptionReq.index)
      targetBtn.focus()
    }
  }, [focusOptionReq, multiple])

  const selectedSingleIndex = multiple
    ? -1
    : isCustomActive
      ? options.length
      : options.findIndex((opt) => opt.value === singleStr)
  const tabStopIndex = selectedSingleIndex >= 0 ? selectedSingleIndex : 0

  const customInputValue = multiple
    ? (externalMultiCustom !== undefined ? externalMultiCustom : customDraft)
    : (externalSingleCustom ? singleStr : customDraft)

  const handleChoiceKeyDown = (index: number, e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled || totalChoices === 0) return
    if (e.altKey || e.ctrlKey || e.metaKey) return

    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault()
      if (allowCustom && index === options.length) {
        if (multiple) {
          if (!isCustomActive) {
            setCustomOpen(true)
            setFocusRequestCount((n) => n + 1)
            onChange(composeMultiChoiceValues(field, selectedPresets, customDraft), { fromPresetClick: false })
            return
          }
          onEnterNextOrSubmit()
          return
        }
        if (!isCustomActive || customInputValue.trim() === '') {
          setCustomOpen(true)
          setFocusRequestCount((n) => n + 1)
          onChange(customDraft, { fromPresetClick: false })
          return
        }
        onEnterNextOrSubmit()
        return
      }
      if (multiple) {
        onEnterNextOrSubmit()
        return
      }
      const opt = options[index]
      if (opt !== undefined) {
        setCustomOpen(false)
        onSingleOptionEnter(opt.value)
      }
      return
    }

    let nextIndex: number | null = null
    if (e.key === 'ArrowDown' || (!isStepper && e.key === 'ArrowRight')) {
      nextIndex = (index + 1) % totalChoices
    } else if (e.key === 'ArrowUp' || (!isStepper && e.key === 'ArrowLeft')) {
      nextIndex = (index - 1 + totalChoices) % totalChoices
    } else if (e.key === 'Home') {
      nextIndex = 0
    } else if (e.key === 'End') {
      nextIndex = totalChoices - 1
    }
    if (nextIndex === null) return

    e.preventDefault()
    if (multiple) {
      setFocusedMultiIndex(nextIndex)
      optionRefs.current[nextIndex]?.focus()
      return
    }

    optionRefs.current[nextIndex]?.focus()
    if (allowCustom && nextIndex === options.length) {
      setCustomOpen(true)
      onChange(customDraft, { fromPresetClick: false })
      return
    }
    const nextOpt = options[nextIndex]
    if (nextOpt === undefined) return
    setCustomOpen(false)
    onChange(nextOpt.value, { fromPresetClick: false })
  }

  const handlePresetClick = (optValue: string): void => {
    if (multiple) {
      const nextSet = new Set(selectedPresetSet)
      if (nextSet.has(optValue)) nextSet.delete(optValue)
      else nextSet.add(optValue)
      onChange(
        composeMultiChoiceValues(field, [...nextSet], isCustomActive ? (externalMultiCustom ?? customDraft) : undefined),
        { fromPresetClick: false },
      )
      return
    }
    setCustomOpen(false)
    onChange(optValue, { fromPresetClick: true })
  }

  const handleCustomButtonClick = (): void => {
    if (!allowCustom) return
    if (multiple) {
      setFocusedMultiIndex(options.length)
      if (isCustomActive) {
        setCustomOpen(false)
        onChange(composeMultiChoiceValues(field, selectedPresets, undefined), { fromPresetClick: false })
      } else {
        setCustomOpen(true)
        setFocusRequestCount((n) => n + 1)
        const nextArr = composeMultiChoiceValues(field, selectedPresets, customDraft)
        onChange(nextArr, { fromPresetClick: false })
      }
      return
    }
    setCustomOpen(true)
    setFocusRequestCount((n) => n + 1)
    onChange(customDraft, { fromPresetClick: false })
  }

  return (
    <div className="ask-dock-choice-wrap">
      {multiple ? (
        <div className="ask-dock-choice-meta">{t('composer.ask.multiHint')}</div>
      ) : null}
      <div
        className="ask-dock-choice-group"
        role={multiple ? 'group' : 'radiogroup'}
        aria-label={fieldLabel}
      >
        {options.map((opt, index) => {
          const selected = multiple ? selectedPresetSet.has(opt.value) : !isCustomActive && singleStr === opt.value
          const optLabel = resolveLocalizedText(opt.label, locale)
          const optDesc =
            opt.description !== undefined ? resolveLocalizedText(opt.description, locale) : undefined
          return (
            <button
              key={opt.value}
              ref={(el) => {
                optionRefs.current[index] = el
              }}
              type="button"
              role={multiple ? 'checkbox' : 'radio'}
              aria-checked={selected}
              tabIndex={multiple ? (index === clampedMultiIndex ? 0 : -1) : index === tabStopIndex ? 0 : -1}
              className={`ask-dock-choice-btn${selected ? ' ask-dock-choice-btn--selected' : ''}`}
              disabled={disabled}
              onFocus={() => {
                if (multiple) setFocusedMultiIndex(index)
              }}
              onClick={() => handlePresetClick(opt.value)}
              onKeyDown={(e) => handleChoiceKeyDown(index, e)}
            >
              <span className="ask-dock-choice-key" aria-hidden="true">
                {index + 1}
              </span>
              <span className="ask-dock-choice-body">
                <span className="ask-dock-choice-header">
                  <span className="ask-dock-choice-label">{optLabel}</span>
                  {opt.recommended === true ? (
                    <span className="ask-dock-choice-badge">{t('composer.ask.recommended')}</span>
                  ) : null}
                </span>
                {optDesc !== undefined && optDesc !== '' ? (
                  <span className="ask-dock-choice-desc">{optDesc}</span>
                ) : null}
              </span>
              {multiple || selected ? (
                <span
                  className={`ask-dock-choice-check${multiple ? ' ask-dock-choice-check--multi' : ''}${selected ? ' ask-dock-choice-check--active' : ''}`}
                  aria-hidden="true"
                >
                  {selected ? <HelmxIcon name="check" size={13} /> : null}
                </span>
              ) : null}
            </button>
          )
        })}
        {allowCustom ? (
          <>
            <button
              key="__custom__"
              ref={(el) => {
                optionRefs.current[options.length] = el
              }}
              type="button"
              role={multiple ? 'checkbox' : 'radio'}
              aria-checked={isCustomActive}
              tabIndex={
                multiple
                  ? (options.length === clampedMultiIndex ? 0 : -1)
                  : (options.length === tabStopIndex ? 0 : -1)
              }
              className={`ask-dock-choice-btn ask-dock-choice-btn--custom${isCustomActive ? ' ask-dock-choice-btn--selected' : ''}`}
              disabled={disabled}
              onFocus={() => {
                if (multiple) setFocusedMultiIndex(options.length)
              }}
              onClick={handleCustomButtonClick}
              onKeyDown={(e) => handleChoiceKeyDown(options.length, e)}
            >
              <span className="ask-dock-choice-key" aria-hidden="true">
                {options.length + 1}
              </span>
              <span className="ask-dock-choice-body">
                <span className="ask-dock-choice-header">
                  <span className="ask-dock-choice-label">{t('composer.ask.otherOption')}</span>
                </span>
              </span>
              {multiple || isCustomActive ? (
                <span
                  className={`ask-dock-choice-check${multiple ? ' ask-dock-choice-check--multi' : ''}${isCustomActive ? ' ask-dock-choice-check--active' : ''}`}
                  aria-hidden="true"
                >
                  {isCustomActive ? <HelmxIcon name="check" size={13} /> : null}
                </span>
              ) : null}
            </button>
            {isCustomActive ? (
              <div className="ask-dock-choice-custom">
                <Input
                  ref={customInputRef}
                  type="text"
                  size="sm"
                  value={customInputValue}
                  disabled={disabled}
                  placeholder={customPlaceholder ?? t('composer.ask.otherPlaceholder')}
                  aria-label={t('composer.ask.otherOption')}
                  onChange={(e) => {
                    const nextText = e.target.value
                    setCustomDraft(nextText)
                    if (multiple) {
                      onChange(composeMultiChoiceValues(field, selectedPresets, nextText), {
                        fromPresetClick: false,
                      })
                    } else {
                      onChange(nextText, { fromPresetClick: false })
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                      e.preventDefault()
                      e.stopPropagation()
                      optionRefs.current[options.length]?.focus()
                      return
                    }
                    if (
                      !e.altKey &&
                      !e.ctrlKey &&
                      !e.metaKey &&
                      !e.nativeEvent.isComposing &&
                      e.keyCode !== 229 &&
                      (e.key === 'ArrowUp' || e.key === 'ArrowDown')
                    ) {
                      e.preventDefault()
                      e.stopPropagation()
                      if (e.key === 'ArrowUp') {
                        if (customInputValue.trim() === '' && options.length > 0) {
                          const prevIdx = options.length - 1
                          if (multiple) {
                            setFocusedMultiIndex(prevIdx)
                          } else {
                            setCustomOpen(false)
                            onChange(options[prevIdx]!.value, { fromPresetClick: false })
                          }
                          optionRefs.current[prevIdx]?.focus()
                        } else {
                          optionRefs.current[options.length]?.focus()
                        }
                        return
                      }
                      if (options.length > 0) {
                        if (multiple) {
                          setFocusedMultiIndex(0)
                        } else {
                          setCustomOpen(false)
                          onChange(options[0]!.value, { fromPresetClick: false })
                        }
                        optionRefs.current[0]?.focus()
                      } else {
                        optionRefs.current[options.length]?.focus()
                      }
                      return
                    }
                    if (e.key === 'Enter') {
                      if (e.nativeEvent.isComposing || e.keyCode === 229) {
                        e.preventDefault()
                        e.stopPropagation()
                        return
                      }
                      e.preventDefault()
                      onEnterNextOrSubmit()
                    }
                  }}
                  autoComplete="off"
                />
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  )
}

function AskFieldInput({
  conversationId,
  askKind,
  isStepper,
  field,
  fieldId,
  fieldLabel,
  value,
  thinkingLevelValue,
  focusCustomSignal,
  focusOptionReq,
  onPatchAnswers,
  onSingleOptionEnter,
  onEnterNextOrSubmit,
  onExitTextToCard,
  disabled,
}: {
  conversationId: number
  askKind: AskKind
  isStepper: boolean
  field: AskFieldSpec
  fieldId: string
  fieldLabel: string
  value: AskAnswerValue | undefined
  thinkingLevelValue?: string
  focusCustomSignal: number
  focusOptionReq?: FocusChoiceOptionRequest
  onPatchAnswers: (patch: AskAnswers, meta?: { fromPresetClick?: boolean }) => void
  onSingleOptionEnter: (optValue: string) => void
  onEnterNextOrSubmit: () => void
  onExitTextToCard: () => void
  disabled: boolean
}) {
  const { locale, t } = useWebLocale()
  const pickerAdapter = useModelPickerControlAdapter(conversationId)
  const stringValue = typeof value === 'string' ? value : ''
  const onStringChange = (v: string): void => onPatchAnswers({ [field.name]: v })
  const confirmYesRef = useRef<HTMLButtonElement | null>(null)
  const confirmNoRef = useRef<HTMLButtonElement | null>(null)

  if (field.type === 'select') {
    const options = [
      { value: '', label: t('composer.ask.selectPlaceholder') },
      ...(field.options ?? []).map((opt) => ({
        value: opt.value,
        label: resolveLocalizedText(opt.label, locale),
      })),
    ]
    return (
      <Select
        value={stringValue}
        disabled={disabled}
        options={options}
        onChange={(e) => onStringChange(e.target.value)}
      />
    )
  }
  if (field.type === 'choice') {
    return (
      <AskChoiceGroup
        field={field}
        fieldLabel={fieldLabel}
        value={value}
        disabled={disabled}
        isStepper={isStepper}
        focusCustomSignal={focusCustomSignal}
        focusOptionReq={focusOptionReq}
        onChange={(nextVal, meta) => onPatchAnswers({ [field.name]: nextVal }, meta)}
        onSingleOptionEnter={onSingleOptionEnter}
        onEnterNextOrSubmit={onEnterNextOrSubmit}
      />
    )
  }
  if (field.type === 'model') {
    const placeholder = t('composer.ask.modelKeepCurrent')
    const thinkingField =
      typeof field.thinkingLevelField === 'string' && field.thinkingLevelField !== ''
        ? field.thinkingLevelField
        : undefined
    const activeThinking = thinkingField !== undefined ? (thinkingLevelValue ?? '') : ''
    const displayTitle = stringValue
      ? activeThinking !== ''
        ? `${stringValue} · ${activeThinking}`
        : stringValue
      : placeholder
    return (
      <ModelPickerControl
        buttonId={fieldId}
        buttonAriaLabel={`${fieldLabel}: ${displayTitle}`}
        buttonTitle={displayTitle}
        placeholderLabel={placeholder}
        effectiveModel={stringValue || undefined}
        activeThinkingLevel={activeThinking}
        resetLabel={placeholder}
        resetTitle={t('composer.ask.modelResetTitle')}
        popoverSide="top"
        enableShortcut={false}
        showThinkingLevels={thinkingField !== undefined}
        disabled={disabled}
        copy={pickerAdapter.copy}
        onNotice={pickerAdapter.onNotice}
        onOpenModelsCenter={pickerAdapter.onOpenModelsCenter}
        onApply={(id, level) =>
          onPatchAnswers(
            thinkingField !== undefined
              ? { [field.name]: id, [thinkingField]: level ?? '' }
              : { [field.name]: id },
          )
        }
        onResetDefault={() =>
          onPatchAnswers(
            thinkingField !== undefined
              ? { [field.name]: '', [thinkingField]: '' }
              : { [field.name]: '' },
          )
        }
      />
    )
  }
  if (field.type === 'confirm') {
    const defaultConfirmText =
      askKind === 'question' ? t('composer.ask.confirmYes') : t('composer.ask.approve')
    const defaultRejectText =
      askKind === 'question' ? t('composer.ask.confirmNo') : t('composer.ask.reject')
    const yesText =
      field.confirmLabel !== undefined ? resolveLocalizedText(field.confirmLabel, locale) : defaultConfirmText
    const noText =
      field.rejectLabel !== undefined ? resolveLocalizedText(field.rejectLabel, locale) : defaultRejectText
    return (
      <Stack direction="horizontal" inline gap="xs" className="ask-dock-confirm-actions">
        <Button
          ref={confirmYesRef}
          variant={stringValue === 'true' ? 'primary' : 'default'}
          size="sm"
          icon={<HelmxIcon name="check" size={12} />}
          disabled={disabled}
          onClick={() => onStringChange('true')}
          onKeyDown={(e) => {
            if (
              !e.altKey &&
              !e.ctrlKey &&
              !e.metaKey &&
              (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp')
            ) {
              e.preventDefault()
              confirmNoRef.current?.focus()
            }
          }}
        >
          {yesText}
        </Button>
        <Button
          ref={confirmNoRef}
          variant={stringValue === 'false' ? 'danger' : 'default'}
          size="sm"
          icon={<HelmxIcon name="x" size={12} />}
          disabled={disabled}
          onClick={() => onStringChange('false')}
          onKeyDown={(e) => {
            if (
              !e.altKey &&
              !e.ctrlKey &&
              !e.metaKey &&
              (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'ArrowDown')
            ) {
              e.preventDefault()
              confirmYesRef.current?.focus()
            }
          }}
        >
          {noText}
        </Button>
      </Stack>
    )
  }
  const placeholderText =
    field.placeholder !== undefined ? resolveLocalizedText(field.placeholder, locale) : fieldLabel
  if (field.multiline === true) {
    return (
      <Textarea
        value={stringValue}
        disabled={disabled}
        placeholder={placeholderText}
        rows={3}
        onChange={(e) => onStringChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault()
            e.stopPropagation()
            onExitTextToCard()
            return
          }
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault()
            onEnterNextOrSubmit()
          }
        }}
      />
    )
  }
  return (
    <Input
      type="text"
      value={stringValue}
      disabled={disabled}
      placeholder={placeholderText}
      onChange={(e) => onStringChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
          e.preventDefault()
          e.stopPropagation()
          onExitTextToCard()
          return
        }
        if (e.key === 'Enter') {
          if (e.nativeEvent.isComposing || e.keyCode === 229) {
            e.preventDefault()
            e.stopPropagation()
            return
          }
          e.preventDefault()
          onEnterNextOrSubmit()
        }
      }}
      autoComplete="off"
    />
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
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setSubmitting(null)
        submittingRef.current = null
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
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(null)
      submittingRef.current = null
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
        if (fieldIndex < lastStepIndex && nextUnanswered > fieldIndex) {
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
      if (submittingRef.current !== null) return
      if (e.defaultPrevented) return
      const nativeEv = 'nativeEvent' in e ? e.nativeEvent : e
      if (nativeEv.isComposing || nativeEv.keyCode === 229) return

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

      if (e.altKey || e.ctrlKey || e.metaKey) return

      if (inEditable) return

      if (sourceOrigin === 'form' && e.key === 'Escape' && !e.shiftKey) {
        if (
          targetEl !== cancelBtnRef.current &&
          cancelBtnRef.current !== null &&
          !cancelBtnRef.current.disabled
        ) {
          e.preventDefault()
          e.stopPropagation()
          cancelBtnRef.current.focus()
          return
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
      <div className="ask-dock-header">
        <span className="ask-dock-title">{headerTitle}</span>
        {isStepper ? (
          <div className="ask-dock-step-nav">
            <button
              type="button"
              className="ask-dock-step-nav-btn"
              aria-label={t('composer.ask.stepPrev')}
              title={t('composer.ask.stepPrev')}
              disabled={submitting !== null || safeActiveStep === 0}
              onClick={() => setActiveStep((s) => Math.max(0, s - 1))}
            >
              <HelmxIcon name="chevron-left" size={13} />
            </button>
            <span className="ask-dock-step-counter tabular-nums" aria-live="polite">
              {t('composer.ask.stepCounter', {
                current: safeActiveStep + 1,
                total: ask.fields.length,
              })}
            </span>
            <button
              type="button"
              className="ask-dock-step-nav-btn"
              aria-label={t('composer.ask.stepNext')}
              title={t('composer.ask.stepNext')}
              disabled={submitting !== null || safeActiveStep >= lastStepIndex}
              onClick={() => setActiveStep((s) => Math.min(lastStepIndex, s + 1))}
            >
              <HelmxIcon name="chevron-right" size={13} />
            </button>
          </div>
        ) : null}
        {source !== undefined ? (
          <Button
            ref={cancelBtnRef}
            variant="ghost"
            size="sm"
            icon={<HelmxIcon name="corner-down-right" size={11} />}
            className="ask-dock-source-btn"
            title={source.title !== ''
              ? t('composer.ask.openChildTitle', { id: source.conversationId, title: source.title })
              : t('composer.ask.openChildDrawer', { id: source.conversationId })}
            aria-label={t('composer.ask.openChildDrawer', { id: source.conversationId })}
            onClick={() => openConversationDrawer(source.conversationId)}
          >
            {t('composer.ask.fromSource', { id: source.conversationId })}
          </Button>
        ) : null}
      </div>
      {visibleDescription !== undefined ? (
        <div className="ask-dock-desc">
          {visibleDescription}
        </div>
      ) : null}
      {snapshot !== undefined ? (
        <div className="ask-dock-snapshot">
          <Button
            ref={cancelBtnRef}
            variant="ghost"
            size="sm"
            icon={<HelmxIcon name={snapshotOpen ? 'chevron-down' : 'chevron-right'} size={12} />}
            className="ask-dock-snapshot-btn"
            onClick={() => setSnapshotOpen((v) => !v)}
          >
            {t('composer.ask.terminalSnapshot')}
          </Button>
          {snapshotOpen ? (
            <pre className="code-block-pre selectable ask-dock-snapshot-pre">
              <code>{snapshot.text}</code>
            </pre>
          ) : null}
        </div>
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
      <Stack direction="horizontal" justify="between" wrap gap="sm" className="ask-dock-actions">
        <div className="ask-dock-actions-left">
          <Button
            ref={cancelBtnRef}
            variant="ghost"
            size="sm"
            pending={submitting === 'cancel'}
            disabled={submitting !== null && submitting !== 'cancel'}
            onClick={() => void cancel()}
          >
            {t(isQuestion ? 'composer.ask.skip' : 'common.cancel')}
          </Button>
          {showShortcutHint ? (
            <span className="ask-dock-shortcut-hint">{t(shortcutHintKey)}</span>
          ) : null}
        </div>
        {isSingleConfirm ? null : isStepper && safeActiveStep < lastStepIndex && missingRequired.length > 0 ? (
          <Button
            variant="primary"
            size="sm"
            disabled={submitting !== null}
            onClick={() => setActiveStep((s) => Math.min(lastStepIndex, s + 1))}
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
            disabled={(submitting !== null && submitting !== 'answer') || missingRequired.length > 0}
          >
            {t(isQuestion ? 'composer.ask.confirm' : 'composer.ask.submit')}
          </Button>
        )}
      </Stack>
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
