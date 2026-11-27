/** Right-side detail drawer for creating or editing a single model tier (`builtin:tiers`). */
import { useId, type KeyboardEvent, type ReactNode } from 'react'
import type { HostModelsSlice } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  Callout,
  DetailDrawer,
  Field,
  HelmxIcon,
  Input,
  ModelPickerControl,
  SegmentedControl,
  Stack,
  Textarea,
  resolveDefaultChainThinkingLevel,
  type BadgeTone,
  type LocalizedText,
  type ModelPickerControlCopy,
} from '@helmx/plugin-client'
import {
  ORCHESTRATOR_MAX_STEPS_LIMIT,
  type StarterTierPreset,
  type TierAvailabilityStatus,
  type TierFormDraft,
  type TierItemView,
} from './models.ts'
import { TIERS_COPY as C, tiersPickModelWithHint } from './copy.ts'

const STATUS_BADGE: Readonly<Record<TierAvailabilityStatus, { tone: BadgeTone; copy: LocalizedText }>> = {
  available: { tone: 'ok', copy: C.statusAvailable },
  disabled: { tone: 'warn', copy: C.statusDisabled },
  unavailable: { tone: 'warn', copy: C.statusUnavailable },
}

export interface TierDetailDrawerProps {
  open: boolean
  mode: 'create' | 'edit'
  inline?: boolean
  draft: TierFormDraft
  editingItem?: TierItemView
  existingIds: ReadonlySet<string>
  starterPresets: ReadonlyArray<StarterTierPreset>
  hostModels: HostModelsSlice | undefined
  pickerCopy: Partial<ModelPickerControlCopy>
  dirty: boolean
  saving: boolean
  busy: boolean
  error: string | null
  locale: 'en' | 'zh-CN'
  translate: (text: LocalizedText) => string
  onNotice: (message: string, tone: 'info' | 'warning' | 'error') => void
  onChange: (patch: Partial<TierFormDraft>) => void
  onApplyPreset: (preset: StarterTierPreset) => void
  onSave: () => void
  onRequestDelete: (item: TierItemView) => void
  onClose: () => void
}

export function TierDetailDrawer({
  open,
  mode,
  inline,
  draft,
  editingItem,
  existingIds,
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
}: TierDetailDrawerProps): ReactNode {
  const maxStepsId = useId()
  const missingEditingTarget = mode === 'edit' && editingItem === undefined
  const isOrch = draft.kind === 'orchestrator'
  const availablePresets =
    mode === 'create' ? starterPresets.filter((preset) => !existingIds.has(preset.id)) : []

  const displayThinkingLevel = resolveDefaultChainThinkingLevel(hostModels, draft.model, draft.thinkingLevel, 'tier')
  const displayExecThinkingLevel = resolveDefaultChainThinkingLevel(
    hostModels,
    draft.executorModel,
    draft.executorThinkingLevel,
    'tier',
  )
  const placeholder =
    !draft.model && draft.suggestedThinkingLevel
      ? tiersPickModelWithHint(draft.suggestedThinkingLevel, locale)
      : t(C.pickModel)
  const buttonTitle = draft.model
    ? (displayThinkingLevel && displayThinkingLevel !== 'off' ? `${draft.model} · ${displayThinkingLevel}` : draft.model)
    : placeholder
  const execButtonTitle = draft.executorModel
    ? (displayExecThinkingLevel && displayExecThinkingLevel !== 'off'
        ? `${draft.executorModel} · ${displayExecThinkingLevel}`
        : draft.executorModel)
    : t(C.pickModel)

  const statusBadge = editingItem !== undefined ? STATUS_BADGE[editingItem.status] : undefined
  const canSave = !busy && (mode === 'create' || dirty)

  const handleFormKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSave) {
      e.preventDefault()
      onSave()
    }
  }

  return (
    <DetailDrawer
      open={open}
      onClose={onClose}
      inline={inline}
      className="tiers-drawer-shell"
      bodyClassName="tiers-drawer"
      title={
        mode === 'create' ? (
          t(C.drawerCreateTitle)
        ) : editingItem !== undefined ? (
          <span className="mono tiers-drawer-title-id">
            <span className="tiers-prefix">tier/</span>
            {editingItem.id}
          </span>
        ) : (
          t(C.drawerNotFoundTitle)
        )
      }
      titleExtra={
        mode === 'edit' && statusBadge !== undefined ? (
          <Badge tone={statusBadge.tone}>{t(statusBadge.copy)}</Badge>
        ) : undefined
      }
      footer={
        missingEditingTarget ? (
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t(C.close)}
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
                {t(C.deleteTier)}
              </Button>
            )}
            <div className="flex-1" />
            <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
              {t(C.cancel)}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon="check"
              pending={saving}
              disabled={!canSave}
              onClick={onSave}
            >
              {saving ? t(C.saving) : mode === 'create' ? t(C.createTier) : t(C.saveTier)}
            </Button>
          </>
        )
      }
    >
      {missingEditingTarget ? (
        <Callout tone="warn">{t(C.drawerNotFoundBody)}</Callout>
      ) : (
        <div className="tiers-drawer-form" onKeyDown={handleFormKeyDown}>
          <Stack gap="md">
            {error !== null && (
              <Callout tone="err">
                <span>{error}</span>
              </Callout>
            )}

            {availablePresets.length > 0 && (
              <div className="tiers-starter-chips">
                <span className="tiers-starter-chips-label">{t(C.starterPresetsLabel)}</span>
                <div className="tiers-starter-chips-list">
                  {availablePresets.map((preset) => (
                    <Button
                      key={preset.id}
                      size="xs"
                      variant={draft.id.trim() === preset.id ? 'secondary' : 'ghost'}
                      disabled={busy}
                      onClick={() => onApplyPreset(preset)}
                    >
                      {preset.id}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {mode === 'create' ? (
              <div className="tiers-form-head-row">
                <Field label={t(C.fieldId)} required className="tiers-head-id-field">
                  <div className="tiers-id-wrap">
                    <span className="mono tiers-id-prefix">tier/</span>
                    <Input
                      type="text"
                      mono
                      className="tiers-id-input"
                      value={draft.id}
                      disabled={busy}
                      placeholder={t(C.fieldIdPlaceholder)}
                      onChange={(e) => onChange({ id: e.target.value })}
                    />
                  </div>
                </Field>
                <Field label={t(C.tierKindAria)} htmlFor={false} className="tiers-head-mode-field">
                  <SegmentedControl
                    size="sm"
                    aria-label={`${t(C.tierKindAria)}${draft.id.trim() ? ` · tier/${draft.id.trim()}` : ''}`}
                    value={draft.kind}
                    disabled={busy}
                    onValueChange={(nextValue) =>
                      onChange({ kind: nextValue === 'orchestrator' ? 'orchestrator' : 'single' })
                    }
                    items={[
                      { value: 'single', label: t(C.tierKindSingle) },
                      { value: 'orchestrator', label: t(C.tierKindOrchestrator) },
                    ]}
                  />
                </Field>
              </div>
            ) : (
              <div className="tiers-mode-row" role="group" aria-label={t(C.tierKindAria)}>
                <span className="helmx-field-label">{t(C.tierKindAria)}</span>
                <SegmentedControl
                  size="sm"
                  aria-label={`${t(C.tierKindAria)}${draft.id.trim() ? ` · tier/${draft.id.trim()}` : ''}`}
                  value={draft.kind}
                  disabled={busy}
                  onValueChange={(nextValue) =>
                    onChange({ kind: nextValue === 'orchestrator' ? 'orchestrator' : 'single' })
                  }
                  items={[
                    { value: 'single', label: t(C.tierKindSingle) },
                    { value: 'orchestrator', label: t(C.tierKindOrchestrator) },
                  ]}
                />
              </div>
            )}

            {!isOrch ? (
              <Field label={t(C.fieldModel)} htmlFor={false} required>
                <ModelPickerControl
                  buttonAriaLabel={`${t(C.fieldModel)}${draft.id.trim() ? ` · tier/${draft.id.trim()}` : ''}`}
                  effectiveModel={draft.model || undefined}
                  activeThinkingLevel={displayThinkingLevel}
                  placeholderLabel={placeholder}
                  buttonTitle={buttonTitle}
                  resetLabel={t(C.clearModel)}
                  resetTitle={t(C.clearModel)}
                  popoverSide="bottom"
                  enableShortcut={false}
                  allowTiers={false}
                  disabled={busy}
                  copy={pickerCopy}
                  onNotice={onNotice}
                  onApply={(model, level) => onChange({ model, thinkingLevel: level ?? '' })}
                  onResetDefault={() => onChange({ model: '', thinkingLevel: '' })}
                />
              </Field>
            ) : (
              <div className="tiers-orchestrator-fields">
                <Field label={t(C.fieldPlannerModel)} htmlFor={false} required>
                  <ModelPickerControl
                    buttonAriaLabel={`${t(C.fieldPlannerModel)}${draft.id.trim() ? ` · tier/${draft.id.trim()}` : ''}`}
                    effectiveModel={draft.model || undefined}
                    activeThinkingLevel={displayThinkingLevel}
                    placeholderLabel={placeholder}
                    buttonTitle={buttonTitle}
                    resetLabel={t(C.clearModel)}
                    resetTitle={t(C.clearModel)}
                    popoverSide="bottom"
                    enableShortcut={false}
                    allowTiers={false}
                    disabled={busy}
                    copy={pickerCopy}
                    onNotice={onNotice}
                    onApply={(model, level) => onChange({ model, thinkingLevel: level ?? '' })}
                    onResetDefault={() => onChange({ model: '', thinkingLevel: '' })}
                  />
                </Field>
                <div className="tiers-orch-connector" aria-hidden="true">
                  <HelmxIcon name="arrow-down" size={12} />
                </div>
                <Field label={t(C.fieldExecutorModel)} htmlFor={false} required>
                  <ModelPickerControl
                    buttonAriaLabel={`${t(C.fieldExecutorModel)}${draft.id.trim() ? ` · tier/${draft.id.trim()}` : ''}`}
                    effectiveModel={draft.executorModel || undefined}
                    activeThinkingLevel={displayExecThinkingLevel}
                    placeholderLabel={t(C.pickModel)}
                    buttonTitle={execButtonTitle}
                    resetLabel={t(C.clearModel)}
                    resetTitle={t(C.clearModel)}
                    popoverSide="bottom"
                    enableShortcut={false}
                    allowTiers={false}
                    disabled={busy}
                    copy={pickerCopy}
                    onNotice={onNotice}
                    onApply={(model, level) => onChange({ executorModel: model, executorThinkingLevel: level ?? '' })}
                    onResetDefault={() => onChange({ executorModel: '', executorThinkingLevel: '' })}
                  />
                </Field>
                <div className="tiers-steps-row">
                  <div className="tiers-steps-label-col">
                    <label htmlFor={maxStepsId} className="helmx-field-label">
                      {t(C.fieldMaxSteps)}
                    </label>
                    <span className="tiers-steps-hint">{t(C.fieldMaxStepsHint)}</span>
                  </div>
                  <div className="tiers-steps-control">
                    <Input
                      id={maxStepsId}
                      type="number"
                      size="sm"
                      mono
                      className="tiers-steps-input"
                      min={0}
                      max={ORCHESTRATOR_MAX_STEPS_LIMIT}
                      value={draft.maxExecutionSteps}
                      disabled={busy}
                      placeholder={t(C.fieldMaxStepsPlaceholder)}
                      onChange={(e) => onChange({ maxExecutionSteps: e.target.value })}
                    />
                    <span className="tiers-steps-unit">{t(C.fieldMaxStepsUnit)}</span>
                  </div>
                </div>
              </div>
            )}

            <Field
              className="tiers-desc-field"
              label={
                <span className="tiers-desc-label-row">
                  <span>{t(C.fieldDescription)}</span>
                  {draft.description.length > 0 && (
                    <span className="tiers-char-count tabular-nums">{draft.description.length}/240</span>
                  )}
                </span>
              }
            >
              <Textarea
                rows={2}
                maxLength={240}
                className="tiers-desc-textarea"
                value={draft.description}
                disabled={busy}
                placeholder={t(C.fieldDescriptionPlaceholder)}
                onChange={(e) => onChange({ description: e.target.value })}
              />
            </Field>
          </Stack>
        </div>
      )}
    </DetailDrawer>
  )
}
