import { useEffect, useMemo, useRef, useState } from 'react'
import type * as React from 'react'
import {
  resolveLocalizedText,
  type AskAnswers,
  type AskAnswerValue,
  type AskFieldSpec,
  type AskKind,
} from '@helmx/protocol/browser'
import {
  Button,
  HelmxIcon,
  Input,
  ModelPickerControl,
  Select,
  Stack,
  Textarea,
} from '@helmx/plugin-client'
import { isImeComposing } from '../lib/ime.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useModelPickerControlAdapter } from './model-picker-adapter.js'
import {
  composeMultiChoiceValues,
  isMultiChoiceField,
} from './ask-dock-model.js'

export interface FocusChoiceOptionRequest {
  index: number
  seq: number
}

interface AskChoiceGroupProps {
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
}

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
}: AskChoiceGroupProps) {
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

    if (e.key === 'Enter' && !isImeComposing(e)) {
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

  const handleCustomInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape' && !isImeComposing(e)) {
      e.preventDefault()
      e.stopPropagation()
      optionRefs.current[options.length]?.focus()
      return
    }
    if (
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !isImeComposing(e) &&
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
      if (isImeComposing(e)) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      e.preventDefault()
      onEnterNextOrSubmit()
    }
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
                  onKeyDown={handleCustomInputKeyDown}
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

interface AskModelFieldProps {
  conversationId: number
  field: AskFieldSpec
  fieldId: string
  fieldLabel: string
  stringValue: string
  thinkingLevelValue?: string
  disabled: boolean
  onPatchAnswers: (patch: AskAnswers, meta?: { fromPresetClick?: boolean }) => void
}

/**
 * Isolated model-field renderer: subscribes to `useModelPickerControlAdapter`
 * only when the AskCard actually contains a `type: 'model'` field.
 */
function AskModelField({
  conversationId,
  field,
  fieldId,
  fieldLabel,
  stringValue,
  thinkingLevelValue,
  disabled,
  onPatchAnswers,
}: AskModelFieldProps) {
  const { t } = useWebLocale()
  const pickerAdapter = useModelPickerControlAdapter(conversationId)
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

interface AskConfirmButtonsProps {
  askKind: AskKind
  field: AskFieldSpec
  stringValue: string
  disabled: boolean
  onStringChange: (value: string) => void
}

function AskConfirmButtons({
  askKind,
  field,
  stringValue,
  disabled,
  onStringChange,
}: AskConfirmButtonsProps) {
  const { locale, t } = useWebLocale()
  const confirmYesRef = useRef<HTMLButtonElement | null>(null)
  const confirmNoRef = useRef<HTMLButtonElement | null>(null)
  const defaultConfirmText =
    askKind === 'question' ? t('composer.ask.confirmYes') : t('composer.ask.approve')
  const defaultRejectText =
    askKind === 'question' ? t('composer.ask.confirmNo') : t('composer.ask.reject')
  const yesText =
    field.confirmLabel !== undefined ? resolveLocalizedText(field.confirmLabel, locale) : defaultConfirmText
  const noText =
    field.rejectLabel !== undefined ? resolveLocalizedText(field.rejectLabel, locale) : defaultRejectText

  const swapFocus = (e: React.KeyboardEvent<HTMLButtonElement>, targetRef: React.RefObject<HTMLButtonElement | null>) => {
    if (
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'ArrowDown')
    ) {
      e.preventDefault()
      targetRef.current?.focus()
    }
  }

  return (
    <Stack direction="horizontal" inline gap="xs" className="ask-dock-confirm-actions">
      <Button
        ref={confirmYesRef}
        variant={stringValue === 'true' ? 'primary' : 'secondary'}
        size="sm"
        icon={<HelmxIcon name="check" size={12} />}
        disabled={disabled}
        onClick={() => onStringChange('true')}
        onKeyDown={(e) => swapFocus(e, confirmNoRef)}
      >
        {yesText}
      </Button>
      <Button
        ref={confirmNoRef}
        variant={stringValue === 'false' ? 'danger' : 'secondary'}
        size="sm"
        icon={<HelmxIcon name="x" size={12} />}
        disabled={disabled}
        onClick={() => onStringChange('false')}
        onKeyDown={(e) => swapFocus(e, confirmYesRef)}
      >
        {noText}
      </Button>
    </Stack>
  )
}

export interface AskFieldInputProps {
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
}

/** Field control dispatcher inside AskCard. */
export function AskFieldInput({
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
}: AskFieldInputProps) {
  const { locale, t } = useWebLocale()
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
    return (
      <AskModelField
        conversationId={conversationId}
        field={field}
        fieldId={fieldId}
        fieldLabel={fieldLabel}
        stringValue={stringValue}
        thinkingLevelValue={thinkingLevelValue}
        disabled={disabled}
        onPatchAnswers={onPatchAnswers}
      />
    )
  }
  if (field.type === 'confirm') {
    return (
      <AskConfirmButtons
        askKind={askKind}
        field={field}
        stringValue={stringValue}
        disabled={disabled}
        onStringChange={onStringChange}
      />
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
          if (e.key === 'Escape' && !isImeComposing(e)) {
            e.preventDefault()
            e.stopPropagation()
            onExitTextToCard()
            return
          }
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !isImeComposing(e)) {
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
        if (e.key === 'Escape' && !isImeComposing(e)) {
          e.preventDefault()
          e.stopPropagation()
          onExitTextToCard()
          return
        }
        if (e.key === 'Enter') {
          if (isImeComposing(e)) {
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
