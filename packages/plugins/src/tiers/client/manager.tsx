/** Dedicated full-screen management entrypoint for builtin:tiers (`TiersManagerScreen`). */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ScreenProps } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  LoadingState,
  ModelPickerControl,
  Screen,
  ScreenSection,
  ScreenToolbar,
  SegmentedControl,
  Stack,
  formatModelShortName,
  formatTime,
  useHostModels,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
  type BadgeTone,
  type LocalizedText,
} from '@helmx/plugin-client'
import {
  TIERS_STATE_DOC, buildStarterDraftRows, isDraftDirty, parseTiersStateDoc,
  resolveTierRowStatus, tiersRecordToDraftRows, validateDraftRows, type TierDraftRow, type TierTemplateView,
} from './models.ts'
import {
  TIERS_COPY as C, buildTiersPickerCopy, tiersActionFailed, tiersPickModelWithHint,
  tiersTemplateAppliedNotice, tiersTemplateDeleteConfirmBody, tiersTemplateDeletedNotice, tiersTemplateSavedNotice,
} from './copy.ts'
import './styles.css'

const STATUS_BADGE: Readonly<Record<'available' | 'disabled' | 'unavailable' | 'draft', { tone: BadgeTone; copy: LocalizedText }>> = {
  available: { tone: 'ok', copy: C.statusAvailable },
  disabled: { tone: 'warn', copy: C.statusDisabled },
  unavailable: { tone: 'warn', copy: C.statusUnavailable },
  draft: { tone: 'neutral', copy: C.statusDraft },
}
const VALIDATION_ERROR_COPY = {
  id_required: C.errIdRequired,
  duplicate_id: C.errDuplicateId,
  model_required: C.errModelRequired,
  executor_required: C.errExecutorRequired,
  max_steps_invalid: C.errMaxStepsInvalid,
} as const

export function TiersManagerScreen(_props: ScreenProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const rawDoc = usePluginDoc(TIERS_STATE_DOC)
  const hostModels = useHostModels()
  const parsed = useMemo(() => parseTiersStateDoc(rawDoc), [rawDoc])
  const pickerCopy = useMemo(() => buildTiersPickerCopy(locale), [locale])
  const models = hostModels?.models ?? []

  const [draft, setDraft] = useState<TierDraftRow[]>([])
  const [initialized, setInitialized] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tplForm, setTplForm] = useState({ id: '', name: '', desc: '' })
  const [pendingDelete, setPendingDelete] = useState<TierTemplateView | null>(null)
  const nextRowCounter = useRef(1)
  const dirtyRef = useRef(false)

  const dirty = initialized && isDraftDirty(draft, parsed.tiers)
  dirtyRef.current = dirty

  useEffect(() => {
    if (rawDoc !== undefined && (!initialized || !dirtyRef.current)) {
      setDraft(tiersRecordToDraftRows(parsed.tiers))
      setInitialized(true)
    }
  }, [rawDoc, parsed.tiers, initialized])

  const mutateDraft = (updater: (prev: TierDraftRow[]) => TierDraftRow[]): void => { setError(null); setDraft(updater) }

  const runAction = async (fn: () => Promise<string | void>): Promise<void> => {
    setError(null); setBusy(true)
    try { const msg = await fn(); if (msg) ctx.notify(msg) } catch (err) { setError(tiersActionFailed(err, locale)) } finally { setBusy(false) }
  }

  const saveAll = (): Promise<void> => {
    const checked = validateDraftRows(draft)
    if (!checked.ok) { setError(t(VALIDATION_ERROR_COPY[checked.code])); return Promise.resolve() }
    return runAction(async () => {
      await ctx.callAction('replace', { tiers: checked.tiers })
      setDraft(tiersRecordToDraftRows(checked.tiers))
      return t(C.savedNotice)
    })
  }

  const handleSaveTemplate = (): Promise<void> => {
    const id = tplForm.id.trim()
    const name = tplForm.name.trim()
    const desc = tplForm.desc.trim()
    if (!id || !name) { setError(t(C.errTemplateFields)); return Promise.resolve() }
    return runAction(async () => {
      await ctx.callAction('save_template', { id, name, ...(desc ? { description: desc } : {}) })
      setTplForm({ id: '', name: '', desc: '' })
      return tiersTemplateSavedNotice(name, locale)
    })
  }

  if (rawDoc === undefined) {
    return (
      <Screen title={t(C.screenTitle)} subtitle={t(C.screenSubtitle)}>
        <LoadingState label={t(C.loading)} />
      </Screen>
    )
  }

  const savedCount = Object.keys(parsed.tiers).length

  return (
    <Screen title={t(C.screenTitle)} subtitle={t(C.screenSubtitle)}>
      <ScreenToolbar
        actions={
          <>
            {dirty && <Badge tone="warn">{t(C.unsavedBadge)}</Badge>}
            {draft.length === 0 && (
              <Button
                variant="secondary"
                size="sm"
                icon="sparkles"
                disabled={busy}
                onClick={() => { mutateDraft(() => buildStarterDraftRows(locale)); setInitialized(true) }}
              >
                {t(C.fillStarter)}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              icon="plus"
              disabled={busy}
              onClick={() =>
                mutateDraft((prev) => [
                  ...prev,
                  {
                    key: `new:${nextRowCounter.current++}`,
                    id: '',
                    kind: 'single',
                    model: '',
                    thinkingLevel: '',
                    executorModel: '',
                    executorThinkingLevel: '',
                    maxExecutionSteps: '10',
                    description: '',
                  },
                ])
              }
            >
              {t(C.addRow)}
            </Button>
            {dirty && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => mutateDraft(() => tiersRecordToDraftRows(parsed.tiers))}>
                {t(C.discard)}
              </Button>
            )}
            <Button variant="primary" size="sm" icon="check" pending={busy} disabled={!dirty} onClick={() => void saveAll()}>
              {busy ? t(C.saving) : t(C.saveAll)}
            </Button>
          </>
        }
      >
        <span className="text-muted">{t(C.activeSection)} ({draft.length})</span>
      </ScreenToolbar>

      {error && <Callout tone="err">{error}</Callout>}

      <ScreenSection title={t(C.activeSection)}>
        {draft.length === 0 ? (
          <EmptyState icon="layers" title={t(C.emptyTitle)} hint={t(C.emptyHint)} />
        ) : (
          <Stack gap="md">
            {draft.map((row) => {
              const badge = STATUS_BADGE[resolveTierRowStatus(row, models)]
              const isOrch = row.kind === 'orchestrator'
              const placeholder = !row.model && row.thinkingLevel ? tiersPickModelWithHint(row.thinkingLevel, locale) : t(C.pickModel)
              const buttonTitle = row.model ? (row.thinkingLevel ? `${row.model} · ${row.thinkingLevel}` : row.model) : placeholder
              const execButtonTitle = row.executorModel
                ? (row.executorThinkingLevel ? `${row.executorModel} · ${row.executorThinkingLevel}` : row.executorModel)
                : t(C.pickModel)
              const patch = (p: Partial<TierDraftRow>) => mutateDraft((prev) => prev.map((r) => (r.key === row.key ? { ...r, ...p } : r)))
              return (
                <Card key={row.key} className="tiers-row-card">
                  <div className="tiers-kind-row">
                    <SegmentedControl
                      size="sm"
                      aria-label={`${t(C.tierKindAria)}${row.id.trim() ? ` · tier/${row.id.trim()}` : ''}`}
                      value={row.kind}
                      disabled={busy}
                      onValueChange={(nextValue) =>
                        patch({ kind: nextValue === 'orchestrator' ? 'orchestrator' : 'single' })
                      }
                      items={[
                        { value: 'single', label: t(C.tierKindSingle) },
                        { value: 'orchestrator', label: t(C.tierKindOrchestrator) },
                      ]}
                    />
                  </div>
                  <div className="tiers-card-top">
                    <Field label={t(C.fieldId)}>
                      <div className="tiers-id-wrap">
                        <span className="mono tiers-id-prefix">tier/</span>
                        <Input
                          type="text"
                          mono
                          value={row.id}
                          disabled={busy}
                          placeholder={t(C.fieldIdPlaceholder)}
                          onChange={(e) => patch({ id: e.target.value })}
                        />
                      </div>
                    </Field>
                    <Field label={t(isOrch ? C.fieldPlannerModel : C.fieldModel)} htmlFor={false}>
                      <ModelPickerControl
                        buttonAriaLabel={`${t(isOrch ? C.fieldPlannerModel : C.fieldModel)}${row.id.trim() ? ` · tier/${row.id.trim()}` : ''}`}
                        effectiveModel={row.model || undefined}
                        activeThinkingLevel={row.thinkingLevel}
                        placeholderLabel={placeholder}
                        buttonTitle={buttonTitle}
                        resetLabel={t(C.clearModel)}
                        resetTitle={t(C.clearModel)}
                        popoverSide="bottom"
                        enableShortcut={false}
                        allowTiers={false}
                        disabled={busy}
                        copy={pickerCopy}
                        onNotice={(msg, tone) => ctx.notify(msg, tone)}
                        onApply={(model, level) => patch({ model, thinkingLevel: level ?? '' })}
                        onResetDefault={() => patch({ model: '', thinkingLevel: '' })}
                      />
                    </Field>
                    <div className="tiers-card-actions">
                      <Badge tone={badge.tone}>{t(badge.copy)}</Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="trash-2"
                        disabled={busy}
                        onClick={() => mutateDraft((prev) => prev.filter((r) => r.key !== row.key))}
                      >
                        {t(C.removeRow)}
                      </Button>
                    </div>
                  </div>
                  {isOrch ? (
                    <div className="tiers-orchestrator-row">
                      <Field label={t(C.fieldExecutorModel)} htmlFor={false}>
                        <ModelPickerControl
                          buttonAriaLabel={`${t(C.fieldExecutorModel)}${row.id.trim() ? ` · tier/${row.id.trim()}` : ''}`}
                          effectiveModel={row.executorModel || undefined}
                          activeThinkingLevel={row.executorThinkingLevel}
                          placeholderLabel={t(C.pickModel)}
                          buttonTitle={execButtonTitle}
                          resetLabel={t(C.clearModel)}
                          resetTitle={t(C.clearModel)}
                          popoverSide="bottom"
                          enableShortcut={false}
                          allowTiers={false}
                          disabled={busy}
                          copy={pickerCopy}
                          onNotice={(msg, tone) => ctx.notify(msg, tone)}
                          onApply={(model, level) => patch({ executorModel: model, executorThinkingLevel: level ?? '' })}
                          onResetDefault={() => patch({ executorModel: '', executorThinkingLevel: '' })}
                        />
                      </Field>
                      <Field label={t(C.fieldMaxSteps)}>
                        <Input
                          type="number"
                          mono
                          min={1}
                          max={50}
                          value={row.maxExecutionSteps}
                          disabled={busy}
                          placeholder={t(C.fieldMaxStepsPlaceholder)}
                          onChange={(e) => patch({ maxExecutionSteps: e.target.value })}
                        />
                      </Field>
                    </div>
                  ) : null}
                  <Field label={t(C.fieldDescription)}>
                    <Input
                      type="text"
                      maxLength={240}
                      value={row.description}
                      disabled={busy}
                      placeholder={t(C.fieldDescriptionPlaceholder)}
                      onChange={(e) => patch({ description: e.target.value })}
                    />
                  </Field>
                </Card>
              )
            })}
          </Stack>
        )}
      </ScreenSection>

      <ScreenSection title={t(C.templatesSection)}>
        <p className="text-muted">{t(C.templateSaveTitle)}</p>
        <div className="tiers-template-form">
          {([
            ['id', C.templateIdLabel, C.templateIdPlaceholder, true],
            ['name', C.templateNameLabel, C.templateNamePlaceholder, false],
            ['desc', C.templateDescLabel, C.templateDescPlaceholder, false],
          ] as const).map(([field, label, ph, mono]) => (
            <Field key={field} label={t(label)}>
              <Input
                type="text"
                mono={mono}
                value={tplForm[field]}
                disabled={busy || savedCount === 0}
                placeholder={t(ph)}
                onChange={(e) => setTplForm((prev) => ({ ...prev, [field]: e.target.value }))}
              />
            </Field>
          ))}
          <Button variant="secondary" size="sm" icon="layers" disabled={busy || savedCount === 0} onClick={() => void handleSaveTemplate()}>
            {t(C.templateSaveBtn)}
          </Button>
        </div>

        {parsed.templates.length === 0 ? (
          <p className="text-subtle">{t(C.templateEmpty)}</p>
        ) : (
          <div className="helmx-table-wrap">
            <table className="helmx-table">
              <thead>
                <tr><th>{t(C.colTemplate)}</th><th>{t(C.colRoster)}</th><th>{t(C.colUpdated)}</th><th>{t(C.colActions)}</th></tr>
              </thead>
              <tbody>
                {parsed.templates.map((tpl) => (
                  <tr key={tpl.id}>
                    <td>
                      <div className="flex-col-xs">
                        <span className="flex-row"><strong>{tpl.name}</strong>{parsed.activeTemplate === tpl.id && <Badge tone="ok">{t(C.templateActiveBadge)}</Badge>}</span>
                        <span className="mono text-subtle">{tpl.id}</span>
                        {tpl.description && <span className="text-subtle">{tpl.description}</span>}
                      </div>
                    </td>
                    <td>
                      <Stack direction="horizontal" gap="xs" wrap>
                        {Object.entries(tpl.tiers).map(([tid, spec]) => (
                          <Badge key={tid} tone="neutral" mono title={spec.model}>
                            tier/{tid} → {formatModelShortName(spec.model)}{spec.thinkingLevel ? ` · ${spec.thinkingLevel}` : ''}
                          </Badge>
                        ))}
                      </Stack>
                    </td>
                    <td className="mono text-muted">{tpl.updatedAt > 0 ? formatTime(tpl.updatedAt) : '—'}</td>
                    <td>
                      <Stack direction="horizontal" gap="xs" align="center">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          onClick={() => void runAction(async () => {
                            await ctx.callAction('apply_template', { id: tpl.id })
                            setDraft(tiersRecordToDraftRows(tpl.tiers))
                            return tiersTemplateAppliedNotice(tpl.name, locale)
                          })}
                        >
                          {t(C.templateApply)}
                        </Button>
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPendingDelete(tpl)}>
                          {t(C.templateDelete)}
                        </Button>
                      </Stack>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ScreenSection>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => { if (!open) setPendingDelete(null) }}
        title={t(C.templateDeleteConfirmTitle)}
        description={pendingDelete ? tiersTemplateDeleteConfirmBody(pendingDelete.name, pendingDelete.id, locale) : ''}
        confirmText={t(C.templateDelete)}
        cancelText={t(C.cancel)}
        danger
        onConfirm={() => {
          const target = pendingDelete
          setPendingDelete(null)
          if (target) {
            void runAction(async () => {
              await ctx.callAction('delete_template', { id: target.id })
              return tiersTemplateDeletedNotice(target.name, locale)
            })
          }
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </Screen>
  )
}
