import React, { useEffect, useRef, useState } from 'react'
import { Button, Callout, Card, Field, HelperText, HelmxIcon, IconButton, Stack } from '@helmx/ui'
import { ModelPickerControl, useHostModels } from '@helmx/plugin-client'
import { resolveDefaultChainThinkingLevel } from '@helmx/plugin-client/pure'
import { assetsApi } from '../lib/api.js'
import { useOptionalStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useModelPickerControlAdapter } from '../conversation/model-picker-adapter.js'
import {
  modelThinkingLevelsFromRows,
  reviewModelThinkingRows,
  rowsFromModelThinkingLevels,
  type ModelThinkingRow,
} from './global-defaults-model.js'

export interface DefaultModelInfo {
  defaultModel: string
  defaultThinkingLevel: string
  modelThinkingLevels?: Record<string, string>
  defaultCompactionModel?: string
  defaultCompactionThinkingLevel?: string
}

export interface GlobalDefaultsPanelProps {
  /** Currently effective global default model info (fetched by ModelCenter). */
  defaultModelInfo: DefaultModelInfo | null
  /** Reports a successful save back to the ModelCenter state. */
  onSaved: (info: DefaultModelInfo) => void
}

/**
 * Inline configuration form inside the "Global default" tab:
 * - reuses `ModelPickerControl` (same single-row `model · thinking` picker as
 *   the conversation composer) for the global default model, the global
 *   compaction model, and each per-model thinking default row;
 * - saving goes through `assetsApi.setDefaultModel` (empty strings clear keys;
 *   per-model rows are submitted as one complete map together with the other
 *   global defaults);
 * - external `defaultModelInfo` sync (`syncGeneration`) and save requests
 *   (`saveGeneration`) track separate generations so external state refreshes
 *   triggered by a save never prevent `saving` cleanup, while stale or
 *   post-unmount save responses remain guarded;
 * - strictly zero Emoji and built on design primitives.
 */
interface KeyedModelThinkingRow extends ModelThinkingRow {
  key: number
}

let nextPerModelRowKey = 1

function toKeyedRows(rows: ReadonlyArray<ModelThinkingRow>): KeyedModelThinkingRow[] {
  return rows.map((row) => ({ ...row, key: nextPerModelRowKey++ }))
}

export function GlobalDefaultsPanel({
  defaultModelInfo,
  onSaved,
}: GlobalDefaultsPanelProps): React.JSX.Element {
  const actions = useOptionalStoreActions()
  const { t } = useWebLocale()
  const hostModels = useHostModels()
  const { copy, onNotice } = useModelPickerControlAdapter()

  const [formModel, setFormModel] = useState(() => defaultModelInfo?.defaultModel ?? '')
  const [formLevel, setFormLevel] = useState(() => defaultModelInfo?.defaultThinkingLevel ?? '')
  const [formCompactionModel, setFormCompactionModel] = useState(
    () => defaultModelInfo?.defaultCompactionModel ?? '',
  )
  const [formCompactionLevel, setFormCompactionLevel] = useState(
    () => defaultModelInfo?.defaultCompactionThinkingLevel ?? '',
  )
  const [perModelRows, setPerModelRows] = useState<KeyedModelThinkingRow[]>(() =>
    toKeyedRows(rowsFromModelThinkingLevels(defaultModelInfo?.modelThinkingLevels)),
  )
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const syncGeneration = useRef(0)
  const saveGeneration = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      saveGeneration.current += 1
    }
  }, [])

  // Sync the local form when external state changes (deep-link navigation /
  // catalog refresh); only for passive property synchronization.
  useEffect(() => {
    if (!defaultModelInfo) return
    const gen = ++syncGeneration.current
    setFormModel(defaultModelInfo.defaultModel ?? '')
    setFormLevel(defaultModelInfo.defaultThinkingLevel ?? '')
    setFormCompactionModel(defaultModelInfo.defaultCompactionModel ?? '')
    setFormCompactionLevel(defaultModelInfo.defaultCompactionThinkingLevel ?? '')
    setPerModelRows(toKeyedRows(rowsFromModelThinkingLevels(defaultModelInfo.modelThinkingLevels)))
    return () => {
      syncGeneration.current = Math.max(syncGeneration.current, gen)
    }
  }, [defaultModelInfo])

  // Triggers display the level each reference actually runs at, per the kernel chain:
  // the default model follows `tier preset > per-model default > global level`, the
  // compaction model follows `compaction level > tier preset > per-model default`.
  const defaultPickerLevel = resolveDefaultChainThinkingLevel(hostModels, formModel, formLevel)
  const compactionPickerLevel = resolveDefaultChainThinkingLevel(
    hostModels,
    formCompactionModel,
    formCompactionLevel,
    'compaction',
  )
  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    const gen = ++saveGeneration.current
    const requestSyncGeneration = syncGeneration.current
    try {
      const issue = reviewModelThinkingRows(perModelRows)
      if (issue !== null) {
        setSaveError(
          issue.kind === 'duplicate'
            ? t('models.defaults.perModelDuplicate', { model: issue.model })
            : t('models.defaults.perModelMissingLevel', { model: issue.model }),
        )
        return
      }
      const res = await assetsApi.setDefaultModel(
        formModel,
        formLevel,
        formCompactionModel,
        formCompactionLevel,
        undefined,
        modelThinkingLevelsFromRows(perModelRows),
      )
      if (!mountedRef.current || gen !== saveGeneration.current) return
      if (requestSyncGeneration !== syncGeneration.current) return
      if (actions?.refreshAssets) {
        await actions.refreshAssets()
      }
      if (!mountedRef.current || gen !== saveGeneration.current) return
      onSaved({
        defaultModel: res.defaultModel,
        defaultThinkingLevel: res.defaultThinkingLevel,
        modelThinkingLevels: res.modelThinkingLevels,
        defaultCompactionModel: res.defaultCompactionModel,
        defaultCompactionThinkingLevel: res.defaultCompactionThinkingLevel,
      })
      const noticeBody = res.defaultModel
        ? t('models.defaults.noticeSetTo', { model: res.defaultModel })
        : res.defaultCompactionModel
          ? t('models.defaults.noticeCompactionSetTo', { model: res.defaultCompactionModel })
          : t('models.defaults.noticeCleared')
      actions?.pushNotice?.({
        type: 'notification',
        level: 'info',
        title: t('models.defaults.noticeUpdated'),
        body: noticeBody,
      })
    } catch (err) {
      if (!mountedRef.current || gen !== saveGeneration.current) return
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current && gen === saveGeneration.current) {
        setSaving(false)
      }
    }
  }

  const handleReset = () => {
    setFormModel(defaultModelInfo?.defaultModel ?? '')
    setFormLevel(defaultModelInfo?.defaultThinkingLevel ?? '')
    setFormCompactionModel(defaultModelInfo?.defaultCompactionModel ?? '')
    setFormCompactionLevel(defaultModelInfo?.defaultCompactionThinkingLevel ?? '')
    setPerModelRows(toKeyedRows(rowsFromModelThinkingLevels(defaultModelInfo?.modelThinkingLevels)))
    setSaveError(null)
  }

  return (
    <div className="model-defaults-panel" data-search-anchor="models:defaults">
      <Card
        variant="subtle"
        title={
          <Stack direction="horizontal" gap="xs" align="center" inline>
            <HelmxIcon name="sliders" size={14} />
            <span>{t('models.defaults.section')}</span>
          </Stack>
        }
        subtitle={t('models.defaults.inheritanceHelp')}
      >
        <Stack direction="vertical" gap="md">
          <Field
            label={t('models.defaults.modelLabel')}
            htmlFor="model-defaults-model"
            hint={t('models.defaults.modelHint')}
            layout="horizontal"
          >
            <ModelPickerControl
              variant="field"
              buttonId="model-defaults-model"
              buttonAriaLabel={t('models.defaults.modelAria')}
              buttonTitle={formModel || t('models.defaults.optionUnset')}
              placeholderLabel={t('models.defaults.optionUnset')}
              effectiveModel={formModel}
              activeThinkingLevel={defaultPickerLevel}
              resetLabel={t('models.defaults.optionUnset')}
              resetTitle={t('models.defaults.optionUnset')}
              enableShortcut={false}
              allowOrchestratorTiers={true}
              disabled={saving}
              copy={copy}
              onNotice={onNotice}
              onApply={(id, lvl) => {
                setFormModel(id)
                setFormLevel(lvl ?? '')
              }}
              onResetDefault={() => {
                setFormModel('')
                setFormLevel('')
              }}
            />
          </Field>

          <Field
            label={t('models.defaults.compactionLabel')}
            htmlFor="model-defaults-compaction-model"
            hint={t('models.defaults.compactionHint')}
            layout="horizontal"
          >
            <ModelPickerControl
              variant="field"
              buttonId="model-defaults-compaction-model"
              buttonAriaLabel={t('models.defaults.compactionAria')}
              buttonTitle={formCompactionModel || t('models.defaults.compactionOptionUnset')}
              placeholderLabel={t('models.defaults.compactionOptionUnset')}
              effectiveModel={formCompactionModel}
              activeThinkingLevel={compactionPickerLevel}
              resetLabel={t('models.defaults.compactionOptionUnset')}
              resetTitle={t('models.defaults.compactionOptionUnset')}
              enableShortcut={false}
              disabled={saving}
              copy={copy}
              onNotice={onNotice}
              onApply={(id, lvl) => {
                setFormCompactionModel(id)
                setFormCompactionLevel(lvl ?? '')
              }}
              onResetDefault={() => {
                setFormCompactionModel('')
                setFormCompactionLevel('')
              }}
            />
          </Field>
        </Stack>

        <div className="model-defaults-permodel">
          <div className="model-defaults-permodel-head">
            <span className="model-defaults-permodel-title">{t('models.defaults.perModelTitle')}</span>
            <Button
              variant="ghost"
              size="sm"
              icon="plus"
              onClick={() => setPerModelRows((rows) => [...rows, { key: nextPerModelRowKey++, model: '', level: '' }])}
              disabled={saving}
            >
              {t('models.defaults.perModelAdd')}
            </Button>
          </div>
          <HelperText>{t('models.defaults.perModelHelp')}</HelperText>
          {perModelRows.length === 0 && (
            <HelperText>{t('models.defaults.perModelEmpty')}</HelperText>
          )}
          {perModelRows.map((row, index) => (
            <div className="model-defaults-row" key={row.key}>
              <ModelPickerControl
                variant="field"
                buttonId={`model-defaults-permodel-${index}`}
                buttonAriaLabel={t('models.defaults.perModelAria')}
                buttonTitle={row.model || t('models.defaults.perModelPick')}
                placeholderLabel={t('models.defaults.perModelPick')}
                effectiveModel={row.model}
                activeThinkingLevel={row.level}
                resetLabel={t('models.defaults.perModelClear')}
                resetTitle={t('models.defaults.perModelClear')}
                enableShortcut={false}
                allowTiers={false}
                disabled={saving}
                copy={copy}
                onNotice={onNotice}
                onApply={(id, lvl) =>
                  setPerModelRows((rows) =>
                    rows.map((existing) => (existing.key === row.key ? { ...existing, model: id, level: lvl ?? '' } : existing)),
                  )
                }
                onResetDefault={() =>
                  setPerModelRows((rows) =>
                    rows.map((existing) => (existing.key === row.key ? { ...existing, model: '', level: '' } : existing)),
                  )
                }
              />
              <IconButton
                icon="x"
                variant="ghost"
                size="md"
                onClick={() => setPerModelRows((rows) => rows.filter((existing) => existing.key !== row.key))}
                disabled={saving}
                label={t('models.defaults.perModelRemove')}
              />
            </div>
          ))}
        </div>

        <Stack direction="horizontal" gap="sm" align="center" className="model-defaults-form-actions">
          <Button
            variant="primary"
            icon="check"
            pending={saving}
            onClick={handleSave}
          >
            {saving ? t('models.saving') : t('models.defaults.save')}
          </Button>
          <Button variant="ghost" onClick={handleReset} disabled={saving}>
            {t('models.defaults.reset')}
          </Button>
        </Stack>
        {saveError && (
          <Callout tone="err">
            <span className="callout-text" role="alert">{saveError}</span>
          </Callout>
        )}
      </Card>
    </div>
  )
}
