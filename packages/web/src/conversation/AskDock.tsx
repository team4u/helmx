import { useEffect, useId, useMemo, useRef, useState } from 'react'
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
  Badge,
  Button,
  Callout,
  Field,
  HelperText,
  HelmxIcon,
  IconButton,
  Input,
  ModelPickerControl,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  Select,
  Stack,
  StatusLight,
  Textarea,
} from '@helmx/plugin-client'
import { useConversations, usePendingAsks, useStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { collectSubtreeIds } from './ancestry-model.js'
import { useModelPickerControlAdapter } from './model-picker-adapter.js'
import {
  composeMultiChoiceValues,
  extractTerminalSnapshot,
  findNextUnansweredStep,
  initialAskAnswers,
  isFieldAnswered,
  isMultiChoiceField,
  isPresetOptionValue,
  isSingleRequiredConfirm,
  missingRequiredFields,
  resolveAskKind,
  shouldUseQuestionStepper,
} from './ask-dock-model.js'

export interface AskDockProps {
  conversationId: number
}

/** Source-conversation badge: shown when the ask belongs to another
 * conversation; clicking opens that child conversation's drawer. */
interface AskSourceInfo {
  conversationId: number
  title: string
}

function AskChoiceGroup({
  field,
  fieldLabel,
  value,
  disabled,
  focusCustomSignal,
  onChange,
  onEnterNextOrSubmit,
}: {
  field: AskFieldSpec
  fieldLabel: string
  value: AskAnswerValue | undefined
  disabled: boolean
  focusCustomSignal: number
  onChange: (next: AskAnswerValue, meta?: { fromPresetClick?: boolean }) => void
  onEnterNextOrSubmit?: () => void
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

  const isCustomActive = allowCustom && (customOpen || (multiple ? externalMultiCustom !== undefined : externalSingleCustom))
  const selectedPresets = useMemo(
    () => (multiple ? multiList.filter((item) => presetValues.has(item)) : []),
    [multiple, multiList, presetValues],
  )
  const selectedPresetSet = useMemo(() => new Set(selectedPresets), [selectedPresets])

  useEffect(() => {
    if (focusCustomSignal > 0 && allowCustom) {
      setCustomOpen(true)
      setFocusRequestCount((n) => n + 1)
    }
  }, [focusCustomSignal, allowCustom])

  useEffect(() => {
    if (focusRequestCount > 0 && isCustomActive) {
      customInputRef.current?.focus()
    }
  }, [focusRequestCount, isCustomActive])

  const totalChoices = options.length + (allowCustom ? 1 : 0)
  const selectedSingleIndex = multiple
    ? -1
    : isCustomActive
      ? options.length
      : options.findIndex((opt) => opt.value === singleStr)
  const tabStopIndex = selectedSingleIndex >= 0 ? selectedSingleIndex : 0

  const handleRadioKeyDown = (index: number, e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (multiple || disabled || totalChoices === 0) return
    if (e.altKey || e.ctrlKey || e.metaKey) return
    let nextIndex: number | null = null
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      nextIndex = (index + 1) % totalChoices
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      nextIndex = (index - 1 + totalChoices) % totalChoices
    } else if (e.key === 'Home') {
      nextIndex = 0
    } else if (e.key === 'End') {
      nextIndex = totalChoices - 1
    }
    if (nextIndex === null) return
    e.preventDefault()
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

  const customInputValue = multiple
    ? (externalMultiCustom !== undefined ? externalMultiCustom : customDraft)
    : (externalSingleCustom ? singleStr : customDraft)

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
              tabIndex={multiple ? 0 : index === tabStopIndex ? 0 : -1}
              className={`ask-dock-choice-btn${selected ? ' ask-dock-choice-btn--selected' : ''}`}
              disabled={disabled}
              onClick={() => handlePresetClick(opt.value)}
              onKeyDown={(e) => handleRadioKeyDown(index, e)}
            >
              <span className="ask-dock-choice-key" aria-hidden="true">
                {index + 1}
              </span>
              <span className="ask-dock-choice-body">
                <span className="ask-dock-choice-header">
                  <span className="ask-dock-choice-label">{optLabel}</span>
                  {opt.recommended === true ? (
                    <Badge tone="accent" className="ask-dock-choice-badge">
                      {t('composer.ask.recommended')}
                    </Badge>
                  ) : null}
                </span>
                {optDesc !== undefined && optDesc !== '' ? (
                  <span className="ask-dock-choice-desc">{optDesc}</span>
                ) : null}
              </span>
              <span
                className={`ask-dock-choice-check${multiple ? ' ask-dock-choice-check--multi' : ''}${selected ? ' ask-dock-choice-check--active' : ''}`}
                aria-hidden="true"
              >
                {selected ? <HelmxIcon name="check" size={13} /> : null}
              </span>
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
              tabIndex={multiple ? 0 : options.length === tabStopIndex ? 0 : -1}
              className={`ask-dock-choice-btn ask-dock-choice-btn--custom${isCustomActive ? ' ask-dock-choice-btn--selected' : ''}`}
              disabled={disabled}
              onClick={handleCustomButtonClick}
              onKeyDown={(e) => handleRadioKeyDown(options.length, e)}
            >
              <span className="ask-dock-choice-key" aria-hidden="true">
                {options.length + 1}
              </span>
              <span className="ask-dock-choice-body">
                <span className="ask-dock-choice-header">
                  <span className="ask-dock-choice-label">{t('composer.ask.otherOption')}</span>
                </span>
              </span>
              <span
                className={`ask-dock-choice-check${multiple ? ' ask-dock-choice-check--multi' : ''}${isCustomActive ? ' ask-dock-choice-check--active' : ''}`}
                aria-hidden="true"
              >
                {isCustomActive ? <HelmxIcon name="check" size={13} /> : null}
              </span>
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
                    if (e.key === 'Enter') {
                      if (e.nativeEvent.isComposing || e.keyCode === 229) {
                        e.preventDefault()
                        e.stopPropagation()
                        return
                      }
                      if (onEnterNextOrSubmit !== undefined) {
                        e.preventDefault()
                        onEnterNextOrSubmit()
                      }
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
  field,
  fieldId,
  fieldLabel,
  value,
  thinkingLevelValue,
  focusCustomSignal,
  onPatchAnswers,
  onEnterNextOrSubmit,
  disabled,
}: {
  conversationId: number
  askKind: AskKind
  field: AskFieldSpec
  fieldId: string
  fieldLabel: string
  value: AskAnswerValue | undefined
  thinkingLevelValue?: string
  focusCustomSignal: number
  onPatchAnswers: (patch: AskAnswers, meta?: { fromPresetClick?: boolean }) => void
  onEnterNextOrSubmit?: () => void
  disabled: boolean
}) {
  const { locale, t } = useWebLocale()
  const pickerAdapter = useModelPickerControlAdapter(conversationId)
  const stringValue = typeof value === 'string' ? value : ''
  const onStringChange = (v: string): void => onPatchAnswers({ [field.name]: v })

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
        focusCustomSignal={focusCustomSignal}
        onChange={(nextVal, meta) => onPatchAnswers({ [field.name]: nextVal }, meta)}
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
          variant={stringValue === 'true' ? 'primary' : 'default'}
          size="sm"
          icon={<HelmxIcon name="check" size={12} />}
          disabled={disabled}
          onClick={() => onStringChange('true')}
        >
          {yesText}
        </Button>
        <Button
          variant={stringValue === 'false' ? 'danger' : 'default'}
          size="sm"
          icon={<HelmxIcon name="x" size={12} />}
          disabled={disabled}
          onClick={() => onStringChange('false')}
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
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            if (onEnterNextOrSubmit !== undefined) {
              e.preventDefault()
              onEnterNextOrSubmit()
            }
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
        if (e.key === 'Enter') {
          if (e.nativeEvent.isComposing || e.keyCode === 229) {
            e.preventDefault()
            e.stopPropagation()
            return
          }
          if (onEnterNextOrSubmit !== undefined) {
            e.preventDefault()
            onEnterNextOrSubmit()
          }
        }
      }}
      autoComplete="off"
    />
  )
}

function AskCard({ ask, source }: { ask: AskSpec; source?: AskSourceInfo }) {
  const { openConversationDrawer } = useStoreActions()
  const { locale, t } = useWebLocale()
  // The same approval/prompt can appear in both an ancestor panel and a child
  // conversation drawer; form labels associate with this instance only.
  const formId = useId()
  const [answers, setAnswers] = useState<AskAnswers>(() => initialAskAnswers(ask.fields))
  const [submitting, setSubmitting] = useState<'answer' | 'cancel' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const [activeStep, setActiveStep] = useState(0)
  const [customFocusSignals, setCustomFocusSignals] = useState<Record<string, number>>({})

  const askKind = resolveAskKind(ask)
  const isQuestion = askKind === 'question'
  const isStepper = shouldUseQuestionStepper(ask)
  const safeActiveStep = isStepper ? Math.min(activeStep, Math.max(0, ask.fields.length - 1)) : 0
  const isSingleConfirm = isSingleRequiredConfirm(ask)

  const titleText = resolveLocalizedText(ask.title, locale)
  const descText = ask.description !== undefined ? resolveLocalizedText(ask.description, locale) : ''
  const hintText = ask.hint !== undefined ? resolveLocalizedText(ask.hint, locale) : ''
  const snapshot = useMemo(() => extractTerminalSnapshot(ask, descText), [ask, descText])
  const missingRequired = useMemo(() => missingRequiredFields(ask, answers), [ask, answers])
  const lastStepIndex = Math.max(0, ask.fields.length - 1)

  const submitAnswers = async (payload: AskAnswers): Promise<void> => {
    setSubmitting('answer')
    setError(null)
    try {
      await asksApi.answer(ask.id, payload, ask.expectedStateSeq)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(null)
    }
  }

  const submit = async (): Promise<void> => {
    if (isSingleConfirm || submitting !== null || missingRequired.length > 0) return
    await submitAnswers(answers)
  }

  const cancel = async (): Promise<void> => {
    setSubmitting('cancel')
    setError(null)
    try {
      await asksApi.cancel(ask.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(null)
    }
  }

  const applyFieldPatch = (
    fieldIndex: number,
    patch: AskAnswers,
    meta?: { fromPresetClick?: boolean },
  ): void => {
    const nextAnswers: AskAnswers = { ...answers, ...patch }
    setAnswers((prev) => ({ ...prev, ...patch }))
    if (isSingleConfirm) {
      void submitAnswers(patch)
      return
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
  }

  const handleEnterNextOrSubmit = (fieldIndex: number): void => {
    if (isStepper && fieldIndex < lastStepIndex) {
      setActiveStep(fieldIndex + 1)
      return
    }
    if (!isSingleConfirm && submitting === null && missingRequired.length === 0) {
      void submitAnswers(answers)
    }
  }

  const handleFormKeyDown = (e: React.KeyboardEvent<HTMLFormElement>): void => {
    if (submitting !== null) return
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      if (!isSingleConfirm && missingRequired.length === 0) {
        e.preventDefault()
        void submitAnswers(answers)
      }
      return
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    if (!/^[1-9]$/.test(e.key)) return

    const target = e.target as HTMLElement | null
    if (target !== null) {
      const tag = target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
        return
      }
    }

    let targetField: AskFieldSpec | undefined
    let targetIndex = -1
    if (isStepper) {
      const active = ask.fields[safeActiveStep]
      if (active?.type === 'choice') {
        targetField = active
        targetIndex = safeActiveStep
      }
    } else {
      const choiceIndices = ask.fields
        .map((field, index) => (field.type === 'choice' ? index : -1))
        .filter((index) => index >= 0)
      if (choiceIndices.length === 1) {
        targetIndex = choiceIndices[0]!
        targetField = ask.fields[targetIndex]
      }
    }
    if (targetField === undefined || targetIndex < 0) return

    const opts = targetField.options ?? []
    const idx = Number(e.key) - 1
    if (idx >= 0 && idx < opts.length) {
      const opt = opts[idx]!
      e.preventDefault()
      if (isMultiChoiceField(targetField)) {
        const cur = Array.isArray(answers[targetField.name]) ? (answers[targetField.name] as string[]) : []
        const presetSet = new Set(cur.filter((v) => isPresetOptionValue(targetField, v)))
        if (presetSet.has(opt.value)) presetSet.delete(opt.value)
        else presetSet.add(opt.value)
        const customItem = cur.find((v) => !isPresetOptionValue(targetField, v))
        applyFieldPatch(targetIndex, {
          [targetField.name]: composeMultiChoiceValues(targetField, [...presetSet], customItem),
        })
      } else {
        applyFieldPatch(targetIndex, { [targetField.name]: opt.value }, { fromPresetClick: true })
      }
      return
    }
    if (targetField.allowCustom === true && idx === opts.length) {
      e.preventDefault()
      setCustomFocusSignals((prev) => ({
        ...prev,
        [targetField.name]: (prev[targetField.name] ?? 0) + 1,
      }))
    }
  }

  const visibleDescription =
    snapshot?.source === 'description'
      ? snapshot.prefix
      : descText.trim() ? descText : undefined

  const activeField = isStepper ? ask.fields[safeActiveStep] : undefined
  const activeChoiceShortcut =
    (isStepper && activeField?.type === 'choice') ||
    (!isStepper && ask.fields.filter((f) => f.type === 'choice').length === 1)

  return (
    <form
      className={`ask-dock ask-dock--${askKind}`}
      data-ask-kind={askKind}
      tabIndex={-1}
      onKeyDown={handleFormKeyDown}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="ask-dock-header">
        <StatusLight
          tone="blocked"
          label={t(isQuestion ? 'composer.ask.awaitingQuestion' : 'composer.ask.awaitingApproval')}
        />
        <span className="ask-dock-title">{titleText}</span>
        {isStepper ? (
          <span className="ask-dock-step-counter tabular-nums" aria-live="polite">
            {t('composer.ask.stepCounter', {
              current: safeActiveStep + 1,
              total: ask.fields.length,
            })}
          </span>
        ) : null}
        {(ask.ownerPluginId !== undefined || ask.expectedStateSeq !== undefined) && (
          <PopoverRoot>
            <PopoverTrigger asChild>
              <IconButton
                icon="info"
                variant="ghost"
                size="xs"
                className="ask-dock-meta-btn"
                label={t(isQuestion ? 'composer.ask.metaAriaQuestion' : 'composer.ask.metaAria')}
              />
            </PopoverTrigger>
            <PopoverContent align="start" className="ask-dock-meta-popover">
              <div className="kv-list">
                {ask.ownerPluginId !== undefined ? (
                  <>
                    <div className="kv-key">{t('composer.ask.metaOwner')}</div>
                    <div className="kv-val mono">{ask.ownerPluginId}</div>
                  </>
                ) : null}
                {ask.expectedStateSeq !== undefined ? (
                  <>
                    <div className="kv-key">{t('composer.ask.metaSeq')}</div>
                    <div className="kv-val mono tabular-nums">{ask.expectedStateSeq}</div>
                  </>
                ) : null}
              </div>
              {ask.expectedStateSeq !== undefined ? (
                <HelperText className="ask-dock-meta-hint">{t('composer.ask.casTitle')}</HelperText>
              ) : null}
            </PopoverContent>
          </PopoverRoot>
        )}
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
            onClick={() => openConversationDrawer(source.conversationId)}
          >
            {t('composer.ask.fromSource', { id: source.conversationId })}
          </Button>
        ) : null}
      </div>
      {isStepper ? (
        <div className="ask-dock-stepper">
          <div className="ask-dock-step-pills" role="navigation" aria-label={titleText}>
            {ask.fields.map((field, index) => {
              const answered = isFieldAnswered(field, answers)
              const active = index === safeActiveStep
              const stepLabel = resolveLocalizedText(field.label, locale)
              return (
                <button
                  key={field.name}
                  type="button"
                  aria-current={active ? 'step' : undefined}
                  title={stepLabel}
                  disabled={submitting !== null}
                  className={`ask-dock-step-pill${active ? ' ask-dock-step-pill--active' : ''}${answered ? ' ask-dock-step-pill--answered' : ''}`}
                  onClick={() => setActiveStep(index)}
                >
                  <span className="ask-dock-step-num tabular-nums">{index + 1}</span>
                  <span className="ask-dock-step-label">{stepLabel}</span>
                  {answered ? <HelmxIcon name="check" size={11} className="ask-dock-step-check" /> : null}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
      {visibleDescription !== undefined ? (
        <div className="ask-dock-desc">
          {visibleDescription}
        </div>
      ) : null}
      {snapshot !== undefined ? (
        <div className="ask-dock-snapshot">
          <Button
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
            return (
              <div
                key={field.name}
                className="ask-dock-step-panel"
                hidden={stepHidden}
              >
                <Field
                  className="ask-dock-field"
                  label={fieldLabel}
                  required={field.required === true}
                  htmlFor={field.type === 'confirm' || field.type === 'choice' ? false : fieldId}
                >
                  <AskFieldInput
                    conversationId={ask.conversationId}
                    askKind={askKind}
                    field={field}
                    fieldId={fieldId}
                    fieldLabel={fieldLabel}
                    value={answers[field.name]}
                    thinkingLevelValue={typeof rawThinking === 'string' ? rawThinking : undefined}
                    focusCustomSignal={customFocusSignals[field.name] ?? 0}
                    disabled={submitting !== null}
                    onPatchAnswers={(patch, meta) => applyFieldPatch(index, patch, meta)}
                    onEnterNextOrSubmit={() => handleEnterNextOrSubmit(index)}
                  />
                </Field>
              </div>
            )
          })}
        </Stack>
      ) : null}
      {hintText.trim() !== '' || activeChoiceShortcut ? (
        <div className="ask-dock-footer-hints">
          {hintText.trim() !== '' ? (
            <HelperText className="ask-dock-hint">{hintText}</HelperText>
          ) : null}
          {activeChoiceShortcut ? (
            <span className="ask-dock-shortcut-hint">{t('composer.ask.shortcutHint')}</span>
          ) : null}
        </div>
      ) : null}
      {error !== null ? (
        <Callout tone="err">
          <span className="callout-text">{error}</span>
        </Callout>
      ) : null}
      <Stack direction="horizontal" justify="between" wrap gap="sm" className="ask-dock-actions">
        <Button
          pending={submitting === 'cancel'}
          disabled={submitting !== null && submitting !== 'cancel'}
          onClick={() => void cancel()}
        >
          {t(isQuestion ? 'composer.ask.skip' : 'common.cancel')}
        </Button>
        {isStepper ? (
          <Stack direction="horizontal" inline gap="sm" className="ask-dock-step-actions">
            {safeActiveStep > 0 ? (
              <Button
                variant="default"
                disabled={submitting !== null}
                onClick={() => setActiveStep((s) => Math.max(0, s - 1))}
              >
                {t('composer.ask.stepPrev')}
              </Button>
            ) : null}
            {safeActiveStep < lastStepIndex ? (
              <Button
                variant={missingRequired.length === 0 ? 'default' : 'primary'}
                disabled={submitting !== null}
                onClick={() => setActiveStep((s) => Math.min(lastStepIndex, s + 1))}
              >
                {t('composer.ask.stepNext')}
              </Button>
            ) : null}
            {safeActiveStep === lastStepIndex || missingRequired.length === 0 ? (
              <Button
                type="submit"
                variant="primary"
                icon={<HelmxIcon name="check" size={12} />}
                pending={submitting === 'answer'}
                disabled={(submitting !== null && submitting !== 'answer') || missingRequired.length > 0}
              >
                {t('composer.ask.confirm')}
              </Button>
            ) : null}
          </Stack>
        ) : !isSingleConfirm ? (
          <Button
            type="submit"
            variant="primary"
            icon={<HelmxIcon name="check" size={12} />}
            pending={submitting === 'answer'}
            disabled={(submitting !== null && submitting !== 'answer') || missingRequired.length > 0}
          >
            {t(isQuestion ? 'composer.ask.confirm' : 'composer.ask.submit')}
          </Button>
        ) : null}
      </Stack>
    </form>
  )
}

function AskDockActive({
  conversationId,
  pendingAsks,
}: {
  conversationId: number
  pendingAsks: ReadonlyArray<AskSpec>
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
      {pending.map((ask) => (
        <AskCard
          key={ask.id}
          ask={ask}
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
export function AskDock({ conversationId }: AskDockProps) {
  const pendingAsks = usePendingAsks()
  if (!pendingAsks.some((a) => a.status === 'pending')) return null
  return <AskDockActive conversationId={conversationId} pendingAsks={pendingAsks} />
}
