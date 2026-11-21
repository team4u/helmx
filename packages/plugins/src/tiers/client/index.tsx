/**
 * builtin:tiers client.tsx components (component exports only, Fast Refresh contract):
 * - TiersManagerScreen: full-stage semantic model tiers editor + custom preset template manager;
 * - TiersSettingsPanel: compact overview inside Plugin Detail Drawer with quick open action.
 *
 * Strictly reuses @helmx/plugin-client Radix primitives (`ModelPickerControl` with `allowTiers={false}`,
 * `Select`, `Screen`, `ScreenSection`, `ScreenToolbar`, `KvGrid`, `EmptyState`, `Callout`, `HelmxIcon`),
 * zero native `<select>`, zero Emoji.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ScreenProps } from '@helmx/protocol'
import {
  Callout,
  EmptyState,
  HelmxIcon,
  KvGrid,
  ModelPickerControl,
  Screen,
  ScreenSection,
  ScreenToolbar,
  Select,
  formatModelShortName,
  formatTime,
  useHostModels,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
  type SelectOption,
} from '@helmx/plugin-client'
import {
  TIERS_PLUGIN_ID,
  TIERS_SCREEN_ID,
  TIERS_STATE_DOC,
  buildStarterDraftRows,
  isDraftDirty,
  parseTiersStateDoc,
  resolveTierRowStatus,
  thinkingLevelsForConcreteModel,
  tiersRecordToDraftRows,
  validateDraftRows,
  type TierDraftRow,
} from './models.ts'
import {
  TIERS_ACTIVE_SECTION,
  TIERS_ADD_ROW,
  TIERS_CLEAR_MODEL,
  TIERS_COL_ACTIONS,
  TIERS_COL_ROSTER,
  TIERS_COL_TEMPLATE,
  TIERS_COL_UPDATED,
  TIERS_DISCARD,
  TIERS_EMPTY_HINT,
  TIERS_EMPTY_TITLE,
  TIERS_ERR_DUPLICATE_ID,
  TIERS_ERR_ID_REQUIRED,
  TIERS_ERR_MODEL_REQUIRED,
  TIERS_ERR_TEMPLATE_FIELDS,
  TIERS_FIELD_DESCRIPTION,
  TIERS_FIELD_DESCRIPTION_PLACEHOLDER,
  TIERS_FIELD_ID,
  TIERS_FIELD_ID_PLACEHOLDER,
  TIERS_FIELD_MODEL,
  TIERS_FIELD_THINKING,
  TIERS_FILL_STARTER,
  TIERS_LOADING,
  TIERS_PICK_MODEL,
  TIERS_REMOVE_ROW,
  TIERS_SAVED_NOTICE,
  TIERS_SAVE_ALL,
  TIERS_SAVING,
  TIERS_SCREEN_SUBTITLE,
  TIERS_SCREEN_TITLE,
  TIERS_SETTINGS_HINT,
  TIERS_SETTINGS_KV_ACTIVE,
  TIERS_SETTINGS_KV_TEMPLATE,
  TIERS_SETTINGS_KV_TEMPLATES,
  TIERS_SETTINGS_NONE,
  TIERS_SETTINGS_OPEN,
  TIERS_SETTINGS_SECTION,
  TIERS_STATUS_AVAILABLE,
  TIERS_STATUS_DISABLED,
  TIERS_STATUS_DRAFT,
  TIERS_STATUS_UNAVAILABLE,
  TIERS_TEMPLATES_SECTION,
  TIERS_TEMPLATE_ACTIVE_BADGE,
  TIERS_TEMPLATE_APPLY,
  TIERS_TEMPLATE_DELETE,
  TIERS_TEMPLATE_DESC_LABEL,
  TIERS_TEMPLATE_DESC_PLACEHOLDER,
  TIERS_TEMPLATE_EMPTY,
  TIERS_TEMPLATE_ID_LABEL,
  TIERS_TEMPLATE_ID_PLACEHOLDER,
  TIERS_TEMPLATE_NAME_LABEL,
  TIERS_TEMPLATE_NAME_PLACEHOLDER,
  TIERS_TEMPLATE_SAVE_BTN,
  TIERS_TEMPLATE_SAVE_TITLE,
  TIERS_THINKING_DEFAULT,
  TIERS_UNSAVED_BADGE,
  tiersActionFailed,
  tiersTemplateAppliedNotice,
  tiersTemplateSavedNotice,
} from './copy.ts'
import './styles.css'

/** Full-stage Model Tiers & Preset Templates manager (`#/s/builtin:tiers/main`). */
export function TiersManagerScreen(_props: ScreenProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const rawDoc = usePluginDoc(TIERS_STATE_DOC)
  const hostModels = useHostModels()
  const parsed = useMemo(() => parseTiersStateDoc(rawDoc), [rawDoc])
  const models = hostModels?.models ?? []

  const [draft, setDraft] = useState<TierDraftRow[]>([])
  const [initialized, setInitialized] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [tplId, setTplId] = useState('')
  const [tplName, setTplName] = useState('')
  const [tplDesc, setTplDesc] = useState('')
  const nextRowCounter = useRef(1)
  const dirtyRef = useRef(false)

  const dirty = initialized && isDraftDirty(draft, parsed.tiers)
  dirtyRef.current = dirty

  // Sync incoming doc snapshots into the editor when not dirty (e.g. initial load or template switch).
  useEffect(() => {
    if (rawDoc === undefined) return
    if (!initialized || !dirtyRef.current) {
      setDraft(tiersRecordToDraftRows(parsed.tiers))
      setInitialized(true)
    }
  }, [rawDoc, parsed.tiers, initialized])

  const updateRow = (key: string, patch: Partial<TierDraftRow>): void => {
    setError(null)
    setNotice(null)
    setDraft((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  const addEmptyRow = (): void => {
    setError(null)
    setNotice(null)
    const seq = nextRowCounter.current++
    setDraft((prev) => [
      ...prev,
      { key: `new:${seq}`, id: '', model: '', thinkingLevel: '', description: '' },
    ])
  }

  const fillStarter = (): void => {
    setError(null)
    setNotice(null)
    setDraft(buildStarterDraftRows(locale))
    setInitialized(true)
  }

  const removeRow = (key: string): void => {
    setError(null)
    setNotice(null)
    setDraft((prev) => prev.filter((row) => row.key !== key))
  }

  const discardEdits = (): void => {
    setError(null)
    setNotice(null)
    setDraft(tiersRecordToDraftRows(parsed.tiers))
  }

  const saveAll = async (): Promise<void> => {
    setError(null)
    setNotice(null)
    const checked = validateDraftRows(draft)
    if (!checked.ok) {
      if (checked.code === 'id_required') setError(t(TIERS_ERR_ID_REQUIRED))
      else if (checked.code === 'duplicate_id') setError(t(TIERS_ERR_DUPLICATE_ID))
      else setError(t(TIERS_ERR_MODEL_REQUIRED))
      return
    }
    setBusy(true)
    try {
      await ctx.callAction('replace', { tiers: checked.tiers })
      setDraft(tiersRecordToDraftRows(checked.tiers))
      setNotice(t(TIERS_SAVED_NOTICE))
    } catch (err) {
      setError(tiersActionFailed(err, locale))
    } finally {
      setBusy(false)
    }
  }

  const handleSaveTemplate = async (): Promise<void> => {
    setError(null)
    setNotice(null)
    const id = tplId.trim()
    const name = tplName.trim()
    if (id === '' || name === '') {
      setError(t(TIERS_ERR_TEMPLATE_FIELDS))
      return
    }
    setBusy(true)
    try {
      await ctx.callAction('save_template', {
        id,
        name,
        ...(tplDesc.trim() !== '' ? { description: tplDesc.trim() } : {}),
      })
      setTplId('')
      setTplName('')
      setTplDesc('')
      setNotice(tiersTemplateSavedNotice(name, locale))
    } catch (err) {
      setError(tiersActionFailed(err, locale))
    } finally {
      setBusy(false)
    }
  }

  const handleApplyTemplate = async (id: string, name: string): Promise<void> => {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      await ctx.callAction('apply_template', { id })
      dirtyRef.current = false
      setNotice(tiersTemplateAppliedNotice(name, locale))
    } catch (err) {
      setError(tiersActionFailed(err, locale))
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteTemplate = async (id: string): Promise<void> => {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      await ctx.callAction('delete_template', { id })
    } catch (err) {
      setError(tiersActionFailed(err, locale))
    } finally {
      setBusy(false)
    }
  }

  if (rawDoc === undefined) {
    return (
      <Screen title={t(TIERS_SCREEN_TITLE)} subtitle={t(TIERS_SCREEN_SUBTITLE)}>
        <div className="loading-state" role="status">
          <HelmxIcon name="loader" size={14} className="spin-slow" />
          <span>{t(TIERS_LOADING)}</span>
        </div>
      </Screen>
    )
  }

  const savedCount = Object.keys(parsed.tiers).length

  return (
    <Screen title={t(TIERS_SCREEN_TITLE)} subtitle={t(TIERS_SCREEN_SUBTITLE)}>
      <ScreenToolbar
        actions={
          <>
            {dirty ? <span className="badge badge-warn">{t(TIERS_UNSAVED_BADGE)}</span> : null}
            {draft.length === 0 ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={fillStarter}
              >
                <HelmxIcon name="sparkles" size={13} />
                <span>{t(TIERS_FILL_STARTER)}</span>
              </button>
            ) : null}
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={addEmptyRow}>
              <HelmxIcon name="plus" size={13} />
              <span>{t(TIERS_ADD_ROW)}</span>
            </button>
            {dirty ? (
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={discardEdits}>
                <span>{t(TIERS_DISCARD)}</span>
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || !dirty}
              onClick={() => void saveAll()}
            >
              <HelmxIcon name="check" size={13} />
              <span>{busy ? t(TIERS_SAVING) : t(TIERS_SAVE_ALL)}</span>
            </button>
          </>
        }
      >
        <span className="text-muted text-sm">
          {t(TIERS_ACTIVE_SECTION)} ({draft.length})
        </span>
      </ScreenToolbar>

      {error !== null ? <Callout tone="err">{error}</Callout> : null}
      {notice !== null ? <Callout tone="ok">{notice}</Callout> : null}

      <ScreenSection title={t(TIERS_ACTIVE_SECTION)}>
        {draft.length === 0 ? (
          <EmptyState
            icon="layers"
            title={t(TIERS_EMPTY_TITLE)}
            hint={t(TIERS_EMPTY_HINT)}
          />
        ) : (
          <div className="tiers-list">
            {draft.map((row) => {
              const status = resolveTierRowStatus(row.model, models)
              const levels = thinkingLevelsForConcreteModel(row.model, models)
              const thinkingOptions: SelectOption<string>[] = [
                { value: '', label: t(TIERS_THINKING_DEFAULT) },
                ...levels.map((lvl) => ({ value: lvl, label: lvl })),
              ]
              if (row.thinkingLevel !== '' && !levels.includes(row.thinkingLevel)) {
                thinkingOptions.push({ value: row.thinkingLevel, label: row.thinkingLevel })
              }
              const statusBadge =
                status === 'available'
                  ? { tone: 'badge-ok', label: t(TIERS_STATUS_AVAILABLE) }
                  : status === 'disabled'
                    ? { tone: 'badge-warn', label: t(TIERS_STATUS_DISABLED) }
                    : status === 'unavailable'
                      ? { tone: 'badge-warn', label: t(TIERS_STATUS_UNAVAILABLE) }
                      : { tone: 'badge-neutral', label: t(TIERS_STATUS_DRAFT) }

              return (
                <div key={row.key} className="tiers-card">
                  <div className="tiers-card-top">
                    <label className="tiers-field">
                      <span className="tiers-field-label">{t(TIERS_FIELD_ID)}</span>
                      <div className="tiers-id-wrap">
                        <span className="mono tiers-id-prefix">tier/</span>
                        <input
                          type="text"
                          className="input mono"
                          value={row.id}
                          disabled={busy}
                          placeholder={t(TIERS_FIELD_ID_PLACEHOLDER)}
                          onChange={(e) => updateRow(row.key, { id: e.target.value })}
                        />
                      </div>
                    </label>

                    <div className="tiers-field">
                      <span className="tiers-field-label">{t(TIERS_FIELD_MODEL)}</span>
                      <ModelPickerControl
                        effectiveModel={row.model || undefined}
                        activeThinkingLevel=""
                        placeholderLabel={t(TIERS_PICK_MODEL)}
                        buttonTitle={row.model || t(TIERS_PICK_MODEL)}
                        resetLabel={t(TIERS_CLEAR_MODEL)}
                        resetTitle={t(TIERS_CLEAR_MODEL)}
                        popoverSide="bottom"
                        enableShortcut={false}
                        showThinkingLevels={false}
                        allowTiers={false}
                        disabled={busy}
                        onApply={(model) => updateRow(row.key, { model })}
                        onResetDefault={() => updateRow(row.key, { model: '' })}
                      />
                    </div>

                    <div className="tiers-field">
                      <span className="tiers-field-label">{t(TIERS_FIELD_THINKING)}</span>
                      <Select
                        size="sm"
                        aria-label={t(TIERS_FIELD_THINKING)}
                        value={row.thinkingLevel}
                        options={thinkingOptions}
                        disabled={busy}
                        onChange={(e) => updateRow(row.key, { thinkingLevel: e.target.value })}
                      />
                    </div>

                    <div className="tiers-card-actions">
                      <span className={`badge ${statusBadge.tone}`}>{statusBadge.label}</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={() => removeRow(row.key)}
                      >
                        <HelmxIcon name="trash-2" size={13} />
                        <span>{t(TIERS_REMOVE_ROW)}</span>
                      </button>
                    </div>
                  </div>

                  <label className="tiers-field">
                    <span className="tiers-field-label">{t(TIERS_FIELD_DESCRIPTION)}</span>
                    <input
                      type="text"
                      className="input"
                      maxLength={240}
                      value={row.description}
                      disabled={busy}
                      placeholder={t(TIERS_FIELD_DESCRIPTION_PLACEHOLDER)}
                      onChange={(e) => updateRow(row.key, { description: e.target.value })}
                    />
                  </label>
                </div>
              )
            })}
          </div>
        )}
      </ScreenSection>

      <ScreenSection title={t(TIERS_TEMPLATES_SECTION)}>
        <p className="text-muted text-sm">{t(TIERS_TEMPLATE_SAVE_TITLE)}</p>
        <div className="tiers-template-form">
          <label className="tiers-field">
            <span className="tiers-field-label">{t(TIERS_TEMPLATE_ID_LABEL)}</span>
            <input
              type="text"
              className="input mono"
              value={tplId}
              disabled={busy || savedCount === 0}
              placeholder={t(TIERS_TEMPLATE_ID_PLACEHOLDER)}
              onChange={(e) => setTplId(e.target.value)}
            />
          </label>
          <label className="tiers-field">
            <span className="tiers-field-label">{t(TIERS_TEMPLATE_NAME_LABEL)}</span>
            <input
              type="text"
              className="input"
              value={tplName}
              disabled={busy || savedCount === 0}
              placeholder={t(TIERS_TEMPLATE_NAME_PLACEHOLDER)}
              onChange={(e) => setTplName(e.target.value)}
            />
          </label>
          <label className="tiers-field">
            <span className="tiers-field-label">{t(TIERS_TEMPLATE_DESC_LABEL)}</span>
            <input
              type="text"
              className="input"
              value={tplDesc}
              disabled={busy || savedCount === 0}
              placeholder={t(TIERS_TEMPLATE_DESC_PLACEHOLDER)}
              onChange={(e) => setTplDesc(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || savedCount === 0}
            onClick={() => void handleSaveTemplate()}
          >
            <HelmxIcon name="layers" size={13} />
            <span>{t(TIERS_TEMPLATE_SAVE_BTN)}</span>
          </button>
        </div>

        {parsed.templates.length === 0 ? (
          <p className="text-subtle text-sm">{t(TIERS_TEMPLATE_EMPTY)}</p>
        ) : (
          <div className="helmx-table-wrap">
            <table className="helmx-table">
              <thead>
                <tr>
                  <th>{t(TIERS_COL_TEMPLATE)}</th>
                  <th>{t(TIERS_COL_ROSTER)}</th>
                  <th>{t(TIERS_COL_UPDATED)}</th>
                  <th>{t(TIERS_COL_ACTIONS)}</th>
                </tr>
              </thead>
              <tbody>
                {parsed.templates.map((tpl) => {
                  const isActive = parsed.activeTemplate === tpl.id
                  const entries = Object.entries(tpl.tiers)
                  return (
                    <tr key={tpl.id}>
                      <td>
                        <div className="flex-col-xs">
                          <span className="flex-row">
                            <strong>{tpl.name}</strong>
                            {isActive ? (
                              <span className="badge badge-ok">{t(TIERS_TEMPLATE_ACTIVE_BADGE)}</span>
                            ) : null}
                          </span>
                          <span className="mono text-subtle text-xs">{tpl.id}</span>
                          {tpl.description ? <span className="text-subtle text-xs">{tpl.description}</span> : null}
                        </div>
                      </td>
                      <td>
                        <div className="tiers-roster-pills">
                          {entries.map(([tid, spec]) => (
                            <span key={tid} className="badge badge-neutral mono" title={spec.model}>
                              tier/{tid} → {formatModelShortName(spec.model)}
                              {spec.thinkingLevel ? ` · ${spec.thinkingLevel}` : ''}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="mono text-xs">{tpl.updatedAt > 0 ? formatTime(tpl.updatedAt) : '—'}</td>
                      <td>
                        <div className="tiers-row-actions">
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={busy}
                            onClick={() => void handleApplyTemplate(tpl.id, tpl.name)}
                          >
                            <span>{t(TIERS_TEMPLATE_APPLY)}</span>
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            onClick={() => void handleDeleteTemplate(tpl.id)}
                          >
                            <span>{t(TIERS_TEMPLATE_DELETE)}</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </ScreenSection>
    </Screen>
  )
}

/** Compact settings panel inside the Plugin Detail Drawer for `builtin:tiers`. */
export function TiersSettingsPanel(): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const rawDoc = usePluginDoc(TIERS_STATE_DOC)
  const parsed = useMemo(() => parseTiersStateDoc(rawDoc), [rawDoc])

  if (rawDoc === undefined) {
    return (
      <div className="loading-state" role="status">
        <HelmxIcon name="loader" size={12} className="spin-slow" />
        <span>{t(TIERS_LOADING)}</span>
      </div>
    )
  }

  const activeTemplateObj = parsed.templates.find((tpl) => tpl.id === parsed.activeTemplate)

  return (
    <div className="tiers-settings-body">
      <p className="text-muted text-sm">{t(TIERS_SETTINGS_HINT)}</p>
      <KvGrid
        items={[
          { key: t(TIERS_SETTINGS_KV_ACTIVE), value: String(Object.keys(parsed.tiers).length) },
          { key: t(TIERS_SETTINGS_KV_TEMPLATES), value: String(parsed.templates.length) },
          {
            key: t(TIERS_SETTINGS_KV_TEMPLATE),
            value: activeTemplateObj ? activeTemplateObj.name : t(TIERS_SETTINGS_NONE),
          },
        ]}
      />
      <div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => ctx.openScreen(`screen:${TIERS_PLUGIN_ID}/${TIERS_SCREEN_ID}`)}
        >
          <HelmxIcon name="layers" size={13} />
          <span>{t(TIERS_SETTINGS_OPEN)}</span>
        </button>
      </div>
    </div>
  )
}
