/**
 * Profile Detail drawer extension section (`PROFILE_DETAIL_SECTION_SLOT`) for configuring
 * Profile-level Duo defaults (`executorModel`, `executorThinkingLevel`, `maxExecutionSteps`).
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import type { ProfileDetailSlotProps } from '@helmx/protocol/browser'
import {
  Button,
  Callout,
  Card,
  ErrorText,
  Field,
  HelmxIcon,
  HelperText,
  Input,
  Stack,
  Switch,
} from '@helmx/ui'
import {
  ModelPickerControl,
  resolveDefaultChainThinkingLevel,
  useHostModels,
  usePluginAction,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
} from '@helmx/plugin-client'
import { DUO_COPY as C, buildDuoPickerCopy, duoActionFailed } from './copy.ts'
import {
  DUO_DEFAULT_MAX_STEPS,
  DUO_MAX_STEPS_LIMIT,
  DUO_PROFILES_DOC,
  parseDuoProfilesDoc,
  resolveModelAvailabilityWarning,
  validateMaxStepsInput,
} from './models.ts'
import './styles.css'

export function DuoProfileSection(props: ProfileDetailSlotProps): ReactNode {
  const { profileId, isNew, disabled } = props
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const locale = usePluginLocale()
  const rawProfiles = usePluginDoc(DUO_PROFILES_DOC)
  const profiles = useMemo(() => parseDuoProfilesDoc(rawProfiles), [rawProfiles])
  const hostModels = useHostModels()
  const pickerCopy = useMemo(() => buildDuoPickerCopy(locale), [locale])
  const stepsId = useId()

  const actions = usePluginAction({
    formatError: (err) => duoActionFailed(err, locale),
  })

  const saved = !isNew && profileId ? profiles[profileId] : undefined

  const [enabledDraft, setEnabledDraft] = useState(saved?.enabled === true)
  const [executorModel, setExecutorModel] = useState(saved?.executorModel ?? '')
  const [thinkingLevel, setThinkingLevel] = useState(saved?.executorThinkingLevel ?? '')
  const [maxStepsText, setMaxStepsText] = useState(
    String(saved?.maxExecutionSteps ?? DUO_DEFAULT_MAX_STEPS),
  )
  const [validationError, setValidationError] = useState<string | null>(null)

  useEffect(() => {
    setEnabledDraft(saved?.enabled === true)
    setExecutorModel(saved?.executorModel ?? '')
    setThinkingLevel(saved?.executorThinkingLevel ?? '')
    setMaxStepsText(String(saved?.maxExecutionSteps ?? DUO_DEFAULT_MAX_STEPS))
    setValidationError(null)
  }, [
    profileId,
    isNew,
    saved?.enabled,
    saved?.executorModel,
    saved?.executorThinkingLevel,
    saved?.maxExecutionSteps,
  ])

  const cardTitle = (
    <Stack direction="horizontal" align="center" gap="xs" inline>
      <HelmxIcon name="git-pull-request" size={12} />
      <span>{t(C.profileTitle)}</span>
    </Stack>
  )

  if (isNew || !profileId) {
    return (
      <Card variant="subtle" title={cardTitle}>
        <HelperText>{t(C.profileSaveFirst)}</HelperText>
      </Card>
    )
  }

  const parsedSteps = validateMaxStepsInput(maxStepsText)
  const dirty =
    enabledDraft !== (saved?.enabled === true) ||
    executorModel.trim() !== (saved?.executorModel ?? '') ||
    thinkingLevel.trim() !== (saved?.executorThinkingLevel ?? '') ||
    (parsedSteps ?? -1) !== (saved?.maxExecutionSteps ?? DUO_DEFAULT_MAX_STEPS)

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
  const availabilityWarning = enabledDraft
    ? resolveModelAvailabilityWarning(executorModel, hostModels?.models ?? [])
    : undefined

  const persistProfile = async (nextEnabled: boolean, overrideModel?: string, overrideThinking?: string): Promise<void> => {
    const targetModel = (overrideModel ?? executorModel).trim()
    const targetThinking = (overrideThinking ?? thinkingLevel).trim()
    const steps = validateMaxStepsInput(maxStepsText)
    if (nextEnabled && !targetModel) {
      setValidationError(t(C.errExecutorRequired))
      return
    }
    if (steps === null) {
      setValidationError(t(C.errMaxStepsInvalid))
      return
    }
    setValidationError(null)
    const ok = await actions.run('set_profile', {
      profileId,
      enabled: nextEnabled,
      ...(targetModel ? { executorModel: targetModel } : {}),
      ...(targetThinking ? { executorThinkingLevel: targetThinking } : {}),
      maxExecutionSteps: steps,
    })
    if (ok !== undefined) {
      ctx.notify(t(C.savedNotice), 'info')
    }
  }

  const handleToggle = (next: boolean): void => {
    setEnabledDraft(next)
    setValidationError(null)
    if (!next) {
      if (saved !== undefined) {
        void persistProfile(false)
      }
      return
    }
    if (executorModel.trim()) {
      void persistProfile(true)
    }
  }

  const handleClear = async (): Promise<void> => {
    setValidationError(null)
    const ok = await actions.run('clear_profile', { profileId })
    if (ok !== undefined) {
      ctx.notify(t(C.clearedNotice), 'info')
    }
  }

  const shownError = validationError ?? actions.error ?? null

  return (
    <Card
      variant="subtle"
      title={cardTitle}
      actions={
        <Switch
          checked={enabledDraft}
          disabled={disabled || actions.pending}
          label={t(C.profileSwitchLabel)}
          onChange={handleToggle}
        />
      }
    >
      <Stack gap="sm">
        {shownError !== null && (
          <Callout tone="err">
            <ErrorText live>{shownError}</ErrorText>
          </Callout>
        )}

        {!enabledDraft ? (
          <HelperText>{t(C.profileDisabledHint)}</HelperText>
        ) : (
          <>
            <HelperText>{t(C.profilePlannerNote)}</HelperText>

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
                disabled={disabled || actions.pending}
                copy={pickerCopy}
                onNotice={(msg, tone) => ctx.notify(msg, tone)}
                onApply={(model, level) => {
                  setValidationError(null)
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
                  disabled={disabled || actions.pending}
                  onChange={(e) => {
                    setValidationError(null)
                    setMaxStepsText(e.target.value)
                  }}
                />
                <span className="duo-steps-unit">{t(C.fieldMaxStepsUnit)}</span>
              </div>
            </div>

            <Stack direction="horizontal" align="center" gap="sm" wrap>
              <Button
                variant="primary"
                size="sm"
                icon="save"
                pending={actions.pending}
                disabled={disabled || actions.pending || (!dirty && saved?.enabled === true) || !executorModel.trim()}
                onClick={() => void persistProfile(true)}
              >
                {actions.pending ? t(C.saving) : t(C.save)}
              </Button>
              {saved !== undefined && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled || actions.pending}
                  onClick={() => void handleClear()}
                >
                  {t(C.clearOverride)}
                </Button>
              )}
            </Stack>
          </>
        )}
      </Stack>
    </Card>
  )
}
