/**
 * Compact modal dialog to choose an Executor model and step limit when enabling Duo Mode
 * on a conversation that does not inherit a Duo-configured Profile yet.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  Button,
  Callout,
  ErrorText,
  Field,
  Input,
  ModalDialog,
  Stack,
} from '@helmx/ui'
import {
  ModelPickerControl,
  resolveDefaultChainThinkingLevel,
  useHostModels,
  usePluginLocale,
  usePluginTranslator,
} from '@helmx/plugin-client'
import { DUO_COPY as C, buildDuoPickerCopy } from './copy.ts'
import {
  DUO_DEFAULT_MAX_STEPS,
  DUO_MAX_STEPS_LIMIT,
  resolveModelAvailabilityWarning,
  validateMaxStepsInput,
} from './models.ts'
import './styles.css'

export interface DuoSetupDialogProps {
  open: boolean
  initialExecutorModel?: string
  initialExecutorThinkingLevel?: string
  initialMaxSteps?: number
  pending?: boolean
  error?: string | null
  onConfirm: (config: {
    executorModel: string
    executorThinkingLevel?: string
    maxExecutionSteps: number
  }) => void
  onClose: () => void
}

export function DuoSetupDialog(props: DuoSetupDialogProps): ReactNode {
  const { open, pending = false, error = null, onConfirm, onClose } = props
  const t = usePluginTranslator()
  const locale = usePluginLocale()
  const hostModels = useHostModels()
  const pickerCopy = useMemo(() => buildDuoPickerCopy(locale), [locale])
  const stepsId = useId()

  const [executorModel, setExecutorModel] = useState(props.initialExecutorModel ?? '')
  const [thinkingLevel, setThinkingLevel] = useState(props.initialExecutorThinkingLevel ?? '')
  const [maxStepsText, setMaxStepsText] = useState(
    String(props.initialMaxSteps ?? DUO_DEFAULT_MAX_STEPS),
  )
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setExecutorModel(props.initialExecutorModel ?? '')
    setThinkingLevel(props.initialExecutorThinkingLevel ?? '')
    setMaxStepsText(String(props.initialMaxSteps ?? DUO_DEFAULT_MAX_STEPS))
    setLocalError(null)
  }, [open, props.initialExecutorModel, props.initialExecutorThinkingLevel, props.initialMaxSteps])

  const displayThinkingLevel = resolveDefaultChainThinkingLevel(
    hostModels,
    executorModel,
    thinkingLevel,
  )
  const buttonTitle = executorModel
    ? displayThinkingLevel && displayThinkingLevel !== 'off'
      ? `${executorModel} · ${displayThinkingLevel}`
      : executorModel
    : t(C.pickExecutorModel)

  const availabilityWarning = resolveModelAvailabilityWarning(executorModel, hostModels?.models ?? [])
  const combinedError = localError ?? error

  const handleSubmit = (): void => {
    const trimmed = executorModel.trim()
    if (!trimmed) {
      setLocalError(t(C.errExecutorRequired))
      return
    }
    const steps = validateMaxStepsInput(maxStepsText)
    if (steps === null) {
      setLocalError(t(C.errMaxStepsInvalid))
      return
    }
    setLocalError(null)
    onConfirm({
      executorModel: trimmed,
      ...(thinkingLevel.trim() ? { executorThinkingLevel: thinkingLevel.trim() } : {}),
      maxExecutionSteps: steps,
    })
  }

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      closeDisabled={pending}
      size="sm"
      icon="git-pull-request"
      title={t(C.setupDialogTitle)}
      description={t(C.setupDialogDescription)}
      footer={
        <Stack direction="horizontal" align="center" justify="end" gap="sm">
          <Button variant="ghost" size="sm" disabled={pending} onClick={onClose}>
            {t(C.cancel)}
          </Button>
          <Button
            variant="primary"
            size="sm"
            pending={pending}
            disabled={pending || !executorModel.trim()}
            onClick={handleSubmit}
          >
            {t(C.setupEnableBtn)}
          </Button>
        </Stack>
      }
    >
      <Stack gap="md">
        {combinedError !== null && (
          <Callout tone="err">
            <ErrorText live>{combinedError}</ErrorText>
          </Callout>
        )}

        {availabilityWarning !== undefined && (
          <Callout tone="warn">
            <span>
              {t(availabilityWarning === 'disabled' ? C.errModelDisabled : C.errModelUnavailable)}
            </span>
          </Callout>
        )}

        <Field label={t(C.fieldExecutorModel)} required>
          <ModelPickerControl
            variant="field"
            size="md"
            buttonAriaLabel={t(C.fieldExecutorModel)}
            effectiveModel={executorModel || undefined}
            activeThinkingLevel={displayThinkingLevel}
            placeholderLabel={t(C.pickExecutorModel)}
            buttonTitle={buttonTitle}
            resetLabel={t(C.clearModel)}
            resetTitle={t(C.clearModel)}
            enableShortcut={false}
            allowTiers={true}
            disabled={pending}
            copy={pickerCopy}
            onApply={(model, level) => {
              setLocalError(null)
              setExecutorModel(model)
              setThinkingLevel(level ?? '')
            }}
            onResetDefault={() => {
              setExecutorModel('')
              setThinkingLevel('')
            }}
          />
        </Field>

        <div className="duo-steps-row">
          <div className="duo-steps-label-col">
            <label htmlFor={stepsId} className="helmx-field-label">
              {t(C.fieldMaxSteps)}
            </label>
            <span className="duo-steps-hint">{t(C.fieldMaxStepsHint)}</span>
          </div>
          <div className="duo-steps-control">
            <Input
              id={stepsId}
              type="number"
              size="sm"
              mono
              className="duo-steps-input"
              min={0}
              max={DUO_MAX_STEPS_LIMIT}
              value={maxStepsText}
              disabled={pending}
              onChange={(e) => {
                setLocalError(null)
                setMaxStepsText(e.target.value)
              }}
            />
            <span className="duo-steps-unit">{t(C.fieldMaxStepsUnit)}</span>
          </div>
        </div>
      </Stack>
    </ModalDialog>
  )
}
