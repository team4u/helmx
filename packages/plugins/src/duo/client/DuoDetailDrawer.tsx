import { useMemo, type ReactNode } from 'react'
import {
  Badge,
  Button,
  Callout,
  DetailDrawer,
  Field,
  Input,
  Textarea,
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

const STATUS_BADGE: Readonly<Record<DuoRecipeAvailability, { tone: 'ok' | 'warn' | 'err'; copy: LocalizedText }>> = {
  available: { tone: 'ok', copy: DUO_COPY.statusAvailable },
  disabled: { tone: 'warn', copy: DUO_COPY.statusDisabled },
  unavailable: { tone: 'err', copy: DUO_COPY.statusUnavailable },
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
  const canSave = !busy && !missingEditingTarget && validationError === null && (mode === 'create' || dirty)

  const plannerThinkingDisplay = resolveDefaultChainThinkingLevel(
    hostModels ?? undefined,
    draft.plannerModel || undefined,
    draft.plannerThinkingLevel || undefined,
    'compaction',
  )
  const executorThinkingDisplay = resolveDefaultChainThinkingLevel(
    hostModels ?? undefined,
    draft.executorModel || undefined,
    draft.executorThinkingLevel || undefined,
    'compaction',
  )

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
    mode === 'create' ? (
      t(DUO_COPY.drawerCreateTitle)
    ) : editingItem !== undefined ? (
      editingItem.recipe.name
    ) : (
      t(DUO_COPY.drawerNotFoundTitle)
    )

  const titleExtra =
    mode === 'edit' && editingItem !== undefined ? (
      <>
        <Badge tone="neutral" mono>
          tier/{editingItem.recipe.id}
        </Badge>
        {statusMeta !== undefined && <Badge tone={statusMeta.tone}>{t(statusMeta.copy)}</Badge>}
      </>
    ) : undefined

  const footer = missingEditingTarget ? (
    <Button variant="ghost" size="sm" onClick={onClose}>
      {t(DUO_COPY.close)}
    </Button>
  ) : (
    <div className="duo-drawer-footer-split">
      {mode === 'edit' && editingItem !== undefined ? (
        <Button
          variant="danger"
          size="sm"
          icon="trash-2"
          disabled={busy}
          onClick={() => onRequestDelete(editingItem)}
        >
          {t(DUO_COPY.deleteRecipe)}
        </Button>
      ) : (
        <span />
      )}
      <div className="duo-drawer-footer-right">
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
          {mode === 'create' ? t(DUO_COPY.saveCreate) : t(DUO_COPY.saveUpdate)}
        </Button>
      </div>
    </div>
  )

  return (
    <DetailDrawer
      open={open}
      onClose={onClose}
      inline={inline}
      className="duo-drawer-shell"
      bodyClassName="duo-drawer"
      title={title}
      titleExtra={titleExtra}
      meta={mode === 'edit' && editingItem?.unavailableReason ? editingItem.unavailableReason : undefined}
      footer={footer}
    >
      {error && <Callout tone="err">{error}</Callout>}

      {missingEditingTarget ? (
        <Callout tone="warn">{t(DUO_COPY.drawerNotFoundHint)}</Callout>
      ) : (
        <>
          {mode === 'create' && starterPresets.length > 0 && (
            <div className="duo-drawer-presets">
              <span className="duo-char-count">{t(DUO_COPY.startersHeading)}</span>
              <div className="duo-drawer-preset-row">
                {starterPresets.map((preset) => (
                  <Button
                    key={preset.id}
                    variant="secondary"
                    size="sm"
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

          <div className="duo-drawer-flow">
            <Field label={t(DUO_COPY.fieldPlanner)} required error={plannerError} htmlFor={false}>
              <ModelPickerControl
                variant="field"
                size="md"
                buttonAriaLabel={t(DUO_COPY.fieldPlanner)}
                effectiveModel={draft.plannerModel || undefined}
                activeThinkingLevel={plannerThinkingDisplay}
                placeholderLabel={t(DUO_COPY.pickModelPlaceholder)}
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

            <Field label={t(DUO_COPY.fieldExecutor)} required error={executorError} htmlFor={false}>
              <ModelPickerControl
                variant="field"
                size="md"
                buttonAriaLabel={t(DUO_COPY.fieldExecutor)}
                effectiveModel={draft.executorModel || undefined}
                activeThinkingLevel={executorThinkingDisplay}
                placeholderLabel={t(DUO_COPY.pickModelPlaceholder)}
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
          </div>

          <Field
            label={t(DUO_COPY.fieldMaxSteps)}
            hint={t(DUO_COPY.fieldMaxStepsHint)}
            error={stepsError}
            htmlFor="duo-recipe-max-steps"
          >
            <Input
              id="duo-recipe-max-steps"
              size="md"
              mono
              type="number"
              min={0}
              max={DUO_MAX_STEPS_LIMIT}
              step={1}
              value={draft.maxExecutionSteps}
              disabled={busy}
              invalid={Boolean(stepsError)}
              onChange={(e) => onChange({ maxExecutionSteps: e.target.value })}
            />
          </Field>

          <Field
            label={
              <span className="duo-desc-label-row">
                <span>{t(DUO_COPY.fieldDescription)}</span>
                <span className="duo-char-count">
                  {draft.description.length}/{DUO_DESCRIPTION_MAX_LENGTH}
                </span>
              </span>
            }
            error={descError}
            htmlFor="duo-recipe-description"
          >
            <Textarea
              id="duo-recipe-description"
              rows={2}
              value={draft.description}
              disabled={busy}
              invalid={Boolean(descError)}
              placeholder={t(DUO_COPY.fieldDescriptionPlaceholder)}
              onChange={(e) => onChange({ description: e.target.value })}
            />
          </Field>
        </>
      )}
    </DetailDrawer>
  )
}
