/** Right-side detail drawer for creating or editing an Orchestrator (`builtin:orchestrator`). */
import { useId, useMemo, type KeyboardEvent, type ReactNode } from 'react'
import {
  Badge,
  Button,
  Callout,
  DetailDrawer,
  ErrorText,
  Field,
  HelmxIcon,
  Input,
  MonoId,
  Stack,
  Textarea,
  type BadgeTone,
  type LocalizedText,
} from '@helmx/ui'
import {
  ModelPickerControl,
  resolveDefaultChainThinkingLevel,
  type HelmxLocale,
  type HostModelsSlice,
  type ModelPickerControlCopy,
} from '@helmx/plugin-client'
import { ORCHESTRATOR_COPY, getOrchestratorValidationMessage } from './copy.ts'
import {
  ORCHESTRATOR_DESCRIPTION_MAX_LENGTH,
  ORCHESTRATOR_MAX_STEPS_LIMIT,
  collectExternalTierIds,
  validateOrchestratorDraft,
  type OrchestratorAvailability,
  type OrchestratorDraft,
  type OrchestratorViewItem,
  type StarterOrchestratorPreset,
} from './models.ts'

export interface OrchestratorDetailDrawerProps {
  open: boolean
  mode: 'create' | 'edit'
  inline?: boolean
  draft: OrchestratorDraft
  editingItem?: OrchestratorViewItem
  existingItemIds: ReadonlySet<string>
  starterPresets: ReadonlyArray<StarterOrchestratorPreset>
  hostModels: HostModelsSlice | null | undefined
  pickerCopy: Partial<ModelPickerControlCopy>
  dirty: boolean
  saving: boolean
  busy: boolean
  error: string | null
  locale: HelmxLocale
  translate: (text: LocalizedText) => string
  onNotice: (message: string, tone: 'info' | 'warning' | 'error') => void
  onChange: (patch: Partial<OrchestratorDraft>) => void
  onApplyPreset: (preset: StarterOrchestratorPreset) => void
  onSave: () => void
  onRequestDelete: (item: OrchestratorViewItem) => void
  onClose: () => void
}

const STATUS_BADGE: Readonly<Record<OrchestratorAvailability, { tone: BadgeTone; copy: LocalizedText }>> = {
  available: { tone: 'ok', copy: ORCHESTRATOR_COPY.statusAvailable },
  disabled: { tone: 'warn', copy: ORCHESTRATOR_COPY.statusDisabled },
  unavailable: { tone: 'warn', copy: ORCHESTRATOR_COPY.statusUnavailable },
}

export function OrchestratorDetailDrawer({
  open,
  mode,
  inline,
  draft,
  editingItem,
  existingItemIds,
  starterPresets,
  hostModels,
  pickerCopy,
  dirty,
  saving,
  busy,
  error,
  locale,
  translate: t,
  onNotice,
  onChange,
  onApplyPreset,
  onSave,
  onRequestDelete,
  onClose,
}: OrchestratorDetailDrawerProps): ReactNode {
  const maxStepsId = useId()
  const externalTierIds = useMemo(() => collectExternalTierIds(hostModels), [hostModels])

  const validationError = useMemo(
    () =>
      validateOrchestratorDraft(draft, {
        mode,
        existingItemIds,
        externalTierIds,
      }),
    [draft, mode, existingItemIds, externalTierIds],
  )

  const missingEditingTarget = mode === 'edit' && editingItem === undefined
  const statusMeta = editingItem !== undefined ? STATUS_BADGE[editingItem.status] : undefined
  const availablePresets =
    mode === 'create'
      ? starterPresets.filter((preset) => !existingItemIds.has(preset.id))
      : []

  const canSave = !busy && !missingEditingTarget && validationError === null && (mode === 'create' || dirty)

  const handleFormKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSave) {
      e.preventDefault()
      onSave()
    }
  }

  const plannerThinkingDisplay = resolveDefaultChainThinkingLevel(
    hostModels ?? undefined,
    draft.plannerModel || undefined,
    draft.plannerThinkingLevel || undefined,
    'tier',
  )
  const executorThinkingDisplay = resolveDefaultChainThinkingLevel(
    hostModels ?? undefined,
    draft.executorModel || undefined,
    draft.executorThinkingLevel || undefined,
    'tier',
  )
  const plannerButtonTitle = draft.plannerModel
    ? plannerThinkingDisplay !== '' && plannerThinkingDisplay !== 'off'
      ? `${draft.plannerModel} · ${plannerThinkingDisplay}`
      : draft.plannerModel
    : t(ORCHESTRATOR_COPY.pickModelPlaceholder)
  const executorButtonTitle = draft.executorModel
    ? executorThinkingDisplay !== '' && executorThinkingDisplay !== 'off'
      ? `${draft.executorModel} · ${executorThinkingDisplay}`
      : draft.executorModel
    : t(ORCHESTRATOR_COPY.pickModelPlaceholder)

  const idError =
    validationError === 'id_required' || validationError === 'id_invalid' || validationError === 'id_conflict'
      ? getOrchestratorValidationMessage(validationError, locale)
      : undefined
  const nameError =
    validationError === 'name_required' || validationError === 'name_too_long'
      ? getOrchestratorValidationMessage(validationError, locale)
      : undefined
  const plannerError =
    validationError === 'planner_required' || validationError === 'planner_orchestrator_ref'
      ? getOrchestratorValidationMessage(validationError, locale)
      : undefined
  const executorError =
    validationError === 'executor_required' || validationError === 'executor_orchestrator_ref'
      ? getOrchestratorValidationMessage(validationError, locale)
      : undefined
  const stepsError =
    validationError === 'steps_invalid' ? getOrchestratorValidationMessage(validationError, locale) : undefined
  const descError =
    validationError === 'description_too_long' ? getOrchestratorValidationMessage(validationError, locale) : undefined

  const title =
    mode === 'create'
      ? t(ORCHESTRATOR_COPY.drawerCreateTitle)
      : editingItem !== undefined
        ? editingItem.item.name
        : t(ORCHESTRATOR_COPY.drawerNotFoundTitle)

  return (
    <DetailDrawer
      open={open}
      onClose={onClose}
      inline={inline}
      className="orch-drawer-shell"
      bodyClassName="orch-drawer"
      title={title}
      titleExtra={
        mode === 'edit' && statusMeta !== undefined ? (
          <Badge tone={statusMeta.tone}>{t(statusMeta.copy)}</Badge>
        ) : undefined
      }
      meta={
        mode === 'edit' && editingItem !== undefined ? (
          <MonoId value={`tier/${editingItem.item.id}`} />
        ) : undefined
      }
      footer={
        missingEditingTarget ? (
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t(ORCHESTRATOR_COPY.close)}
          </Button>
        ) : (
          <>
            {mode === 'edit' && editingItem !== undefined && (
              <Button
                variant="danger"
                size="sm"
                icon="trash-2"
                disabled={busy}
                onClick={() => onRequestDelete(editingItem)}
              >
                {t(ORCHESTRATOR_COPY.deleteItem)}
              </Button>
            )}
            <div className="flex-1" />
            <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
              {t(ORCHESTRATOR_COPY.cancel)}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon="check"
              pending={saving}
              disabled={!canSave}
              onClick={onSave}
            >
              {saving
                ? t(ORCHESTRATOR_COPY.saving)
                : mode === 'create'
                  ? t(ORCHESTRATOR_COPY.saveCreate)
                  : t(ORCHESTRATOR_COPY.saveUpdate)}
            </Button>
          </>
        )
      }
    >
      {missingEditingTarget ? (
        <Callout tone="warn">{t(ORCHESTRATOR_COPY.drawerNotFoundHint)}</Callout>
      ) : (
        <div className="orch-drawer-form" onKeyDown={handleFormKeyDown}>
          <Stack gap="md">
            {error !== null && (
              <Callout tone="err">
                <span>{error}</span>
              </Callout>
            )}

            {mode === 'edit' && editingItem?.unavailableReason && (
              <Callout tone="warn">
                <span>{editingItem.unavailableReason}</span>
              </Callout>
            )}

            {availablePresets.length > 0 && (
              <div className="orch-starter-chips">
                <span className="orch-starter-chips-label">{t(ORCHESTRATOR_COPY.starterPresetsLabel)}</span>
                <div className="orch-starter-chips-list">
                  {availablePresets.map((preset) => (
                    <Button
                      key={preset.id}
                      size="xs"
                      variant={draft.id.trim() === preset.id ? 'secondary' : 'ghost'}
                      disabled={busy}
                      onClick={() => onApplyPreset(preset)}
                    >
                      {preset.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <Field
              label={t(ORCHESTRATOR_COPY.fieldId)}
              required
              hint={mode === 'create' ? t(ORCHESTRATOR_COPY.fieldIdHintCreate) : t(ORCHESTRATOR_COPY.fieldIdHintLocked)}
              error={draft.id.length > 0 || mode === 'edit' ? idError : undefined}
              htmlFor="orch-id"
            >
              <Input
                id="orch-id"
                size="md"
                mono
                prefix="tier/"
                value={draft.id}
                disabled={mode === 'edit' || busy}
                invalid={Boolean(idError && (draft.id.length > 0 || mode === 'edit'))}
                placeholder="architect_coder"
                onChange={(e) => onChange({ id: e.target.value })}
              />
            </Field>

            <Field
              label={t(ORCHESTRATOR_COPY.fieldName)}
              required
              error={draft.name.length > 0 ? nameError : undefined}
              htmlFor="orch-name"
            >
              <Input
                id="orch-name"
                size="md"
                value={draft.name}
                disabled={busy}
                invalid={Boolean(nameError && draft.name.length > 0)}
                placeholder={t(ORCHESTRATOR_COPY.fieldNamePlaceholder)}
                onChange={(e) => onChange({ name: e.target.value })}
              />
            </Field>

            <div className="orch-fields">
              <Field
                label={t(ORCHESTRATOR_COPY.fieldPlanner)}
                required
                error={draft.plannerModel.length > 0 ? plannerError : undefined}
                htmlFor={false}
              >
                <ModelPickerControl
                  variant="field"
                  size="md"
                  buttonAriaLabel={`${t(ORCHESTRATOR_COPY.fieldPlanner)}${draft.id.trim() ? ` · tier/${draft.id.trim()}` : ''}`}
                  effectiveModel={draft.plannerModel || undefined}
                  activeThinkingLevel={plannerThinkingDisplay}
                  placeholderLabel={t(ORCHESTRATOR_COPY.pickModelPlaceholder)}
                  buttonTitle={plannerButtonTitle}
                  resetLabel={t(ORCHESTRATOR_COPY.clearModel)}
                  resetTitle={t(ORCHESTRATOR_COPY.clearModel)}
                  enableShortcut={false}
                  allowTiers
                  allowPreserveRefTiers={false}
                  disabled={busy}
                  copy={pickerCopy}
                  onNotice={onNotice}
                  onApply={(model, level) =>
                    onChange({ plannerModel: model, plannerThinkingLevel: level ?? '' })
                  }
                  onResetDefault={() => onChange({ plannerModel: '', plannerThinkingLevel: '' })}
                />
              </Field>

              <div className="orch-connector" aria-hidden="true">
                <HelmxIcon name="arrow-down" size={12} />
              </div>

              <Field
                label={t(ORCHESTRATOR_COPY.fieldExecutor)}
                required
                error={draft.executorModel.length > 0 ? executorError : undefined}
                htmlFor={false}
              >
                <ModelPickerControl
                  variant="field"
                  size="md"
                  buttonAriaLabel={`${t(ORCHESTRATOR_COPY.fieldExecutor)}${draft.id.trim() ? ` · tier/${draft.id.trim()}` : ''}`}
                  effectiveModel={draft.executorModel || undefined}
                  activeThinkingLevel={executorThinkingDisplay}
                  placeholderLabel={t(ORCHESTRATOR_COPY.pickModelPlaceholder)}
                  buttonTitle={executorButtonTitle}
                  resetLabel={t(ORCHESTRATOR_COPY.clearModel)}
                  resetTitle={t(ORCHESTRATOR_COPY.clearModel)}
                  enableShortcut={false}
                  allowTiers
                  allowPreserveRefTiers={false}
                  disabled={busy}
                  copy={pickerCopy}
                  onNotice={onNotice}
                  onApply={(model, level) =>
                    onChange({ executorModel: model, executorThinkingLevel: level ?? '' })
                  }
                  onResetDefault={() => onChange({ executorModel: '', executorThinkingLevel: '' })}
                />
              </Field>

              <div className="orch-steps-row">
                <div className="orch-steps-label-col">
                  <label htmlFor={maxStepsId} className="helmx-field-label">
                    {t(ORCHESTRATOR_COPY.fieldMaxSteps)}
                  </label>
                  <span className="orch-steps-hint">{t(ORCHESTRATOR_COPY.fieldMaxStepsHint)}</span>
                </div>
                <div className="orch-steps-control">
                  <Input
                    id={maxStepsId}
                    type="number"
                    size="sm"
                    mono
                    className="orch-steps-input tabular-nums"
                    min={0}
                    max={ORCHESTRATOR_MAX_STEPS_LIMIT}
                    step={1}
                    value={draft.maxExecutionSteps}
                    disabled={busy}
                    invalid={Boolean(stepsError)}
                    placeholder="30"
                    onChange={(e) => onChange({ maxExecutionSteps: e.target.value })}
                  />
                  <span className="orch-steps-unit">{t(ORCHESTRATOR_COPY.stepsUnit)}</span>
                </div>
              </div>
              {stepsError !== undefined && <ErrorText>{stepsError}</ErrorText>}
            </div>

            <Field
              className="orch-desc-field"
              label={
                <span className="orch-desc-label-row">
                  <span>{t(ORCHESTRATOR_COPY.fieldDescription)}</span>
                  {draft.description.length > 0 && (
                    <span className="orch-char-count tabular-nums">
                      {draft.description.length}/{ORCHESTRATOR_DESCRIPTION_MAX_LENGTH}
                    </span>
                  )}
                </span>
              }
              error={descError}
              htmlFor="orch-description"
            >
              <Textarea
                id="orch-description"
                rows={2}
                maxLength={ORCHESTRATOR_DESCRIPTION_MAX_LENGTH}
                className="orch-desc-textarea"
                value={draft.description}
                disabled={busy}
                invalid={Boolean(descError)}
                placeholder={t(ORCHESTRATOR_COPY.fieldDescriptionPlaceholder)}
                onChange={(e) => onChange({ description: e.target.value })}
              />
            </Field>
          </Stack>
        </div>
      )}
    </DetailDrawer>
  )
}
