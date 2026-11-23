/** builtin:tiers client.tsx components (Fast Refresh compliant: component exports only). */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ScreenProps } from '@helmx/protocol'
import {
  Callout, ConfirmDialog, EmptyState, HelmxIcon, KvGrid, ModelPickerControl, Screen, ScreenSection, ScreenToolbar,
  formatModelShortName, formatTime, useHostModels, usePluginContext, usePluginDoc, usePluginLocale, usePluginTranslator,
} from '@helmx/plugin-client'
import {
  TIERS_PLUGIN_ID, TIERS_SCREEN_ID, TIERS_STATE_DOC, buildStarterDraftRows, isDraftDirty, parseTiersStateDoc,
  resolveTierRowStatus, tiersRecordToDraftRows, validateDraftRows, type TierDraftRow, type TierTemplateView,
} from './models.ts'
import {
  TIERS_COPY as C, buildTiersPickerCopy, tiersActionFailed, tiersPickModelWithHint,
  tiersTemplateAppliedNotice, tiersTemplateDeleteConfirmBody, tiersTemplateSavedNotice,
} from './copy.ts'
import './styles.css'

const STATUS_BADGE = {
  available: { tone: 'badge-ok', copy: C.statusAvailable },
  disabled: { tone: 'badge-warn', copy: C.statusDisabled },
  unavailable: { tone: 'badge-warn', copy: C.statusUnavailable },
  draft: { tone: 'badge-neutral', copy: C.statusDraft },
} as const
const VALIDATION_ERROR_COPY = { id_required: C.errIdRequired, duplicate_id: C.errDuplicateId, model_required: C.errModelRequired } as const

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
  const [notice, setNotice] = useState<string | null>(null)
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

  const mutateDraft = (updater: (prev: TierDraftRow[]) => TierDraftRow[]): void => { setError(null); setNotice(null); setDraft(updater) }

  const runAction = async (fn: () => Promise<string | void>): Promise<void> => {
    setError(null); setNotice(null); setBusy(true)
    try { const msg = await fn(); if (msg) setNotice(msg) } catch (err) { setError(tiersActionFailed(err, locale)) } finally { setBusy(false) }
  }

  const saveAll = (): Promise<void> => {
    const checked = validateDraftRows(draft)
    if (!checked.ok) { setNotice(null); setError(t(VALIDATION_ERROR_COPY[checked.code])); return Promise.resolve() }
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
    if (!id || !name) { setNotice(null); setError(t(C.errTemplateFields)); return Promise.resolve() }
    return runAction(async () => {
      await ctx.callAction('save_template', { id, name, ...(desc ? { description: desc } : {}) })
      setTplForm({ id: '', name: '', desc: '' })
      return tiersTemplateSavedNotice(name, locale)
    })
  }

  if (rawDoc === undefined) {
    return (
      <Screen title={t(C.screenTitle)} subtitle={t(C.screenSubtitle)}>
        <div className="loading-state" role="status"><HelmxIcon name="loader" size={14} className="spin-slow" /><span>{t(C.loading)}</span></div>
      </Screen>
    )
  }

  const savedCount = Object.keys(parsed.tiers).length

  return (
    <Screen title={t(C.screenTitle)} subtitle={t(C.screenSubtitle)}>
      <ScreenToolbar
        actions={
          <>
            {dirty && <span className="badge badge-warn">{t(C.unsavedBadge)}</span>}
            {draft.length === 0 && (
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { mutateDraft(() => buildStarterDraftRows(locale)); setInitialized(true) }}>
                <HelmxIcon name="sparkles" size={13} /><span>{t(C.fillStarter)}</span>
              </button>
            )}
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => mutateDraft((prev) => [...prev, { key: `new:${nextRowCounter.current++}`, id: '', model: '', thinkingLevel: '', description: '' }])}>
              <HelmxIcon name="plus" size={13} /><span>{t(C.addRow)}</span>
            </button>
            {dirty && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => mutateDraft(() => tiersRecordToDraftRows(parsed.tiers))}><span>{t(C.discard)}</span></button>}
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !dirty} onClick={() => void saveAll()}>
              <HelmxIcon name="check" size={13} /><span>{busy ? t(C.saving) : t(C.saveAll)}</span>
            </button>
          </>
        }
      >
        <span className="text-muted">{t(C.activeSection)} ({draft.length})</span>
      </ScreenToolbar>

      {error && <Callout tone="err">{error}</Callout>}
      {notice && <Callout tone="ok">{notice}</Callout>}

      <ScreenSection title={t(C.activeSection)}>
        {draft.length === 0 ? (
          <EmptyState icon="layers" title={t(C.emptyTitle)} hint={t(C.emptyHint)} />
        ) : (
          <div className="tiers-list">
            {draft.map((row) => {
              const badge = STATUS_BADGE[resolveTierRowStatus(row.model, models)]
              const placeholder = !row.model && row.thinkingLevel ? tiersPickModelWithHint(row.thinkingLevel, locale) : t(C.pickModel)
              const buttonTitle = row.model ? (row.thinkingLevel ? `${row.model} · ${row.thinkingLevel}` : row.model) : placeholder
              const patch = (p: Partial<TierDraftRow>) => mutateDraft((prev) => prev.map((r) => (r.key === row.key ? { ...r, ...p } : r)))
              return (
                <div key={row.key} className="tiers-card">
                  <div className="tiers-card-top">
                    <label className="tiers-field">
                      <span className="tiers-field-label">{t(C.fieldId)}</span>
                      <div className="tiers-id-wrap">
                        <span className="mono tiers-id-prefix">tier/</span>
                        <input type="text" className="input mono" value={row.id} disabled={busy} placeholder={t(C.fieldIdPlaceholder)} onChange={(e) => patch({ id: e.target.value })} />
                      </div>
                    </label>
                    <div className="tiers-field">
                      <span className="tiers-field-label">{t(C.fieldModel)}</span>
                      <ModelPickerControl
                        buttonAriaLabel={`${t(C.fieldModel)}${row.id.trim() ? ` · tier/${row.id.trim()}` : ''}`}
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
                    </div>
                    <div className="tiers-card-actions">
                      <span className={`badge ${badge.tone}`}>{t(badge.copy)}</span>
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => mutateDraft((prev) => prev.filter((r) => r.key !== row.key))}>
                        <HelmxIcon name="trash-2" size={13} /><span>{t(C.removeRow)}</span>
                      </button>
                    </div>
                  </div>
                  <label className="tiers-field">
                    <span className="tiers-field-label">{t(C.fieldDescription)}</span>
                    <input type="text" className="input" maxLength={240} value={row.description} disabled={busy} placeholder={t(C.fieldDescriptionPlaceholder)} onChange={(e) => patch({ description: e.target.value })} />
                  </label>
                </div>
              )
            })}
          </div>
        )}
      </ScreenSection>

      <ScreenSection title={t(C.templatesSection)}>
        <p className="text-muted">{t(C.templateSaveTitle)}</p>
        <div className="tiers-template-form">
          {([['id', C.templateIdLabel, C.templateIdPlaceholder, 'input mono'], ['name', C.templateNameLabel, C.templateNamePlaceholder, 'input'], ['desc', C.templateDescLabel, C.templateDescPlaceholder, 'input']] as const).map(([field, label, ph, cls]) => (
            <label key={field} className="tiers-field">
              <span className="tiers-field-label">{t(label)}</span>
              <input type="text" className={cls} value={tplForm[field]} disabled={busy || savedCount === 0} placeholder={t(ph)} onChange={(e) => setTplForm((prev) => ({ ...prev, [field]: e.target.value }))} />
            </label>
          ))}
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || savedCount === 0} onClick={() => void handleSaveTemplate()}>
            <HelmxIcon name="layers" size={13} /><span>{t(C.templateSaveBtn)}</span>
          </button>
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
                        <span className="flex-row"><strong>{tpl.name}</strong>{parsed.activeTemplate === tpl.id && <span className="badge badge-ok">{t(C.templateActiveBadge)}</span>}</span>
                        <span className="mono text-subtle">{tpl.id}</span>
                        {tpl.description && <span className="text-subtle">{tpl.description}</span>}
                      </div>
                    </td>
                    <td>
                      <div className="tiers-roster-pills">
                        {Object.entries(tpl.tiers).map(([tid, spec]) => (
                          <span key={tid} className="badge badge-neutral mono" title={spec.model}>
                            tier/{tid} → {formatModelShortName(spec.model)}{spec.thinkingLevel ? ` · ${spec.thinkingLevel}` : ''}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="mono text-muted">{tpl.updatedAt > 0 ? formatTime(tpl.updatedAt) : '—'}</td>
                    <td>
                      <div className="tiers-row-actions">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={busy}
                          onClick={() => void runAction(async () => {
                            await ctx.callAction('apply_template', { id: tpl.id })
                            setDraft(tiersRecordToDraftRows(tpl.tiers))
                            return tiersTemplateAppliedNotice(tpl.name, locale)
                          })}
                        >
                          <span>{t(C.templateApply)}</span>
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setPendingDelete(tpl)}><span>{t(C.templateDelete)}</span></button>
                      </div>
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
          if (target) void runAction(() => ctx.callAction('delete_template', { id: target.id }).then(() => undefined))
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </Screen>
  )
}

export function TiersSettingsPanel(): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const rawDoc = usePluginDoc(TIERS_STATE_DOC)
  const parsed = useMemo(() => parseTiersStateDoc(rawDoc), [rawDoc])
  if (rawDoc === undefined) {
    return <div className="loading-state" role="status"><HelmxIcon name="loader" size={12} className="spin-slow" /><span>{t(C.loading)}</span></div>
  }
  const activeTemplate = parsed.templates.find((tpl) => tpl.id === parsed.activeTemplate)
  return (
    <div className="tiers-settings-body">
      <p className="text-muted">{t(C.settingsHint)}</p>
      <KvGrid
        items={[
          { key: t(C.settingsKvActive), value: String(Object.keys(parsed.tiers).length) },
          { key: t(C.settingsKvTemplates), value: String(parsed.templates.length) },
          { key: t(C.settingsKvTemplate), value: activeTemplate ? activeTemplate.name : t(C.settingsNone) },
        ]}
      />
      <div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => ctx.openScreen(`screen:${TIERS_PLUGIN_ID}/${TIERS_SCREEN_ID}`)}>
          <HelmxIcon name="layers" size={13} /><span>{t(C.settingsOpen)}</span>
        </button>
      </div>
    </div>
  )
}
