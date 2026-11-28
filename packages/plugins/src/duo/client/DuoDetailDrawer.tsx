/** Right-side detail drawer for creating or editing an Orchestrator (`builtin:duo`). */
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
import { DUO_COPY, getDuoValidationMessage } from './copy.ts'
import {
  DUO_DESCRIPTION_MAX_LENGTH,
  DUO_MAX_STEPS_LIMIT,
  collectExternalTierIds,
  validateDuoDraft,
  type DuoRecipeAvailability,
  type DuoRecipeDraft,
  type DuoRecipeViewItem,
  type StarterDuoPreset,
} from './models.ts'

export interface DuoDetailDrawerProps {
  open: boolean
  mode: 'create' | 'edit'
  inline?: boolean
  draft: DuoRecipeDraft
  editingItem?: DuoRecipeViewItem
  existingRecipeIds: ReadonlySet<string>
  starterPresets: ReadonlyArray<StarterDuoPreset>
  hostModels: HostModelsSlice | null | undefined
  pickerCopy: Partial<ModelPickerControlCopy>
  dirty: boolean
  saving: boolean
  busy: boolean
  error: string | null
  locale: HelmxLocale
  translate: (text: LocalizedText) => string
  onNotice: (message: string, tone: 'info' | 'warning' | 'error') => void
  onChange: (patch: Partial<DuoRecipeDraft>) => void
  onApplyPreset: (preset: StarterDuoPreset) => void
  onSave: () => void
  onRequestDelete: (item: DuoRecipeViewItem) => void
  onClose: () => void
}

const STATUS_BADGE: Readonly<Record<DuoRecipeAvailability, { tone: BadgeTone; copy: LocalizedText }>> = {
  available: { tone: 'ok', copy: DUO_COPY.statusAvailable },
  disabled: { tone: 'warn', copy: DUO_COPY.statusDisabled },
  unavailable: { tone: 'warn', copy: DUO_COPY.statusUnavailable },
}

export function DuoDetailDrawer({
  open,
  mode,
  inline,
  draft,
  editingItem,
  existingRecipeIds,
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
}: DuoDetailDrawerProps): ReactNode {
  const maxStepsId = useId()
  const externalTierIds = useMemo(() => collectExternalTierIds(hostModels), [hostModels])

  const validationError = useMemo(
    () =>
      validateDuoDraft(draft, {
        mode,
        existingRecipeIds,
        externalTierIds,
      }),
    [draft, mode, existingRecipeIds, externalTierIds],
  )

  const missingEditingTarget = mode === 'edit' && editingItem === undefined
  const statusMeta = editingItem !== undefined ? STATUS_BADGE[editingItem.status] : undefined
  const availablePresets =
    mode === 'create'
      ? starterPresets.filter((preset) => !existingRecipeIds.has(preset.id))
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
    : t(DUO_COPY.pickModelPlaceholder)
  const executorButtonTitle = draft.executorModel
    ? executorThinkingDisplay !== '' && executorThinkingDisplay !== 'off'
      ? `${draft.executorModel} · ${executorThinkingDisplay}`
      : draft.executorModel
    : t(DUO_COPY.pickModelPlaceholder)

  const idError =
    validationError === 'id_required' || validationError === 'id_invalid' || validationError === 'id_conflict'
      ? getDuoValidationMessage(validationError, locale)
      : undefined
  const nameError =
    validationError === 'name_required' || validationError === 'name_too_long'
      ? getDuoValidationMessage(validationError, locale)
      : undefined
  const plannerError =
    validationError === 'planner_required' || validationError === 'planner_duo_ref'
      ? getDuoValidationMessage(validationError, locale)
      : undefined
  const executorError =
    validationError === 'executor_required' || validationError === 'executor_duo_ref'
      ? getDuoValidationMessage(validationError, locale)
      : undefined
  const stepsError =
    validationError === 'steps_invalid' ? getDuoValidationMessage(validationError, locale) : undefined
  const descError =
    validationError === 'description_too_long' ? getDuoValidationMessage(validationError, locale) : undefined

  const title =
    mode === 'create'
      ? t(DUO_COPY.drawerCreateTitle)
      : editingItem !== undefined
        ? editingItem.recipe.name
        : t(DUO_COPY.drawerNotFoundTitle)

  return (
    <DetailDrawer
      open={open}
      onClose={onClose}
      inline={inline}
      className="duo-drawer-shell"
      bodyClassName="duo-drawer"
      title={title}
      titleExtra={
        mode === 'edit' && statusMeta !== undefined ? (
          <Badge tone={statusMeta.tone}>{t(statusMeta.copy)}</Badge>
        ) : undefined
      }
      meta={
        mode === 'edit' && editingItem !== undefined ? (
          <MonoId value={`tier/${editingItem.recipe.id}`} />
        ) : undefined
      }
      footer={
        missingEditingTarget ? (
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t(DUO_COPY.close)}
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
                {t(DUO_COPY.deleteItem)}
              </Button>
            )}
            <div className="flex-1" />
            <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
              {t(DUO_COPY.cancel)}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon="check"
              pending={saving}
              disabled={!canSave}
              onClick={onSave}
            >
              {saving ? t(DUO_COPY.saving) : mode === 'create' ? t(DUO_COPY.saveCreate) : t(DUO_COPY.saveUpdate)}
            </Button>
          </>
        )
      }
    >
      {missingEditingTarget ? (
        <Callout tone="warn">{t(DUO_COPY.drawerNotFoundHint)}</Callout>
      ) : (
        <div className="duo-drawer-form" onKeyDown={handleFormKeyDown}>
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
              <div className="duo-starter-chips">
                <span className="duo-starter-chips-label">{t(DUO_COPY.starterPresetsLabel)}</span>
                <div className="duo-starter-chips-list">
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
              label={t(DUO_COPY.fieldId)}
              required
              hint={mode === 'create' ? t(DUO_COPY.fieldIdHintCreate) : t(DUO_COPY.fieldIdHintLocked)}
              error={draft.id.length > 0 || mode === 'edit' ? idError : undefined}
              htmlFor="duo-recipe-id"
            >
              <Input
                id="duo-recipe-id"
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
              label={t(DUO_COPY.fieldName)}
              required
              error={draft.name.length > 0 ? nameError : undefined}
              htmlFor="duo-recipe-name"
            >
              <Input
                id="duo-recipe-name"
                size="md"
                value={draft.name}
                disabled={busy}
                invalid={Boolean(nameError && draft.name.length > 0)}
                placeholder={t(DUO_COPY.fieldNamePlaceholder)}
                onChange={(e) => onChange({ name: e.target.value })}
              />
            </Field>

            <div className="duo-orchestrator-fields">
              <Field
                label={t(DUO_COPY.fieldPlanner)}
                required
                error={draft.plannerModel.length > 0 ? plannerError : undefined}
                htmlFor={false}
              >
                <ModelPickerControl
                  variant="field"
                  size="md"
                  buttonAriaLabel={`${t(DUO_COPY.fieldPlanner)}${draft.id.trim() ? ` · tier/${draft.id.trim()}` : ''}`}
                  effectiveModel={draft.plannerModel || undefined}
                  activeThinkingLevel={plannerThinkingDisplay}
                  placeholderLabel={t(DUO_COPY.pickModelPlaceholder)}
                  buttonTitle={plannerButtonTitle}
                  resetLabel={t(DUO_COPY.clearModel)}
                  resetTitle={t(DUO_COPY.clearModel)}
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

              <div className="duo-orch-connector" aria-hidden="true">
                <HelmxIcon name="arrow-down" size={12} />
              </div>

              <Field
                label={t(DUO_COPY.fieldExecutor)}
                required
                error={draft.executorModel.length > 0 ? executorError : undefined}
                htmlFor={false}
              >
                <ModelPickerControl
                  variant="field"
                  size="md"
                  buttonAriaLabel={`${t(DUO_COPY.fieldExecutor)}${draft.id.trim() ? ` · tier/${draft.id.trim()}` : ''}`}
                  effectiveModel={draft.executorModel || undefined}
                  activeThinkingLevel={executorThinkingDisplay}
                  placeholderLabel={t(DUO_COPY.pickModelPlaceholder)}
                  buttonTitle={executorButtonTitle}
                  resetLabel={t(DUO_COPY.clearModel)}
                  resetTitle={t(DUO_COPY.clearModel)}
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

              <div className="duo-steps-row">
                <div className="duo-steps-label-col">
                  <label htmlFor={maxStepsId} className="helmx-field-label">
                    {t(DUO_COPY.fieldMaxSteps)}
                  </label>
                  <span className="duo-steps-hint">{t(DUO_COPY.fieldMaxStepsHint)}</span>
                </div>
                <div className="duo-steps-control">
                  <Input
                    id={maxStepsId}
                    type="number"
                    size="sm"
                    mono
                    className="duo-steps-input tabular-nums"
                    min={0}
                    max={DUO_MAX_STEPS_LIMIT}
                    step={1}
                    value={draft.maxExecutionSteps}
                    disabled={busy}
                    invalid={Boolean(stepsError)}
                    placeholder="30"
                    onChange={(e) => onChange({ maxExecutionSteps: e.target.value })}
                  />
                  <span className="duo-steps-unit">{t(DUO_COPY.stepsUnit)}</span>
                </div>
              </div>
              {stepsError !== undefined && <ErrorText>{stepsError}</ErrorText>}
            </div>

            <Field
              className="duo-desc-field"
              label={
                <span className="duo-desc-label-row">
                  <span>{t(DUO_COPY.fieldDescription)}</span>
                  {draft.description.length > 0 && (
                    <span className="duo-char-count tabular-nums">
                      {draft.description.length}/{DUO_DESCRIPTION_MAX_LENGTH}
                    </span>
                  )}
                </span>
              }
              error={descError}
              htmlFor="duo-recipe-description"
            >
              <Textarea
                id="duo-recipe-description"
                rows={2}
                maxLength={DUO_DESCRIPTION_MAX_LENGTH}
                className="duo-desc-textarea"
                value={draft.description}
                disabled={busy}
                invalid={Boolean(descError)}
                placeholder={t(DUO_COPY.fieldDescriptionPlaceholder)}
                onChange={(e) => onChange({ description: e.target.value })}
              />
            </Field>
          </Stack>
        </div>
      )}
    </DetailDrawer>
  )
}
