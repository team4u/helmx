import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardGrid,
  ConfirmDialog,
  EmptyState,
  ErrorText,
  HelmxIcon,
  HelperText,
  Screen,
  ScreenSection,
  ScreenToolbar,
  SearchBox,
  SelectCard,
  StatusLight,
  type LocalizedText,
  type StatusLightTone,
} from '@helmx/ui'
import type { ScreenProps } from '@helmx/protocol/browser'
import {
  formatModelShortName,
  useHostModels,
  usePluginAction,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
  useScreenDrawer,
} from '@helmx/plugin-client'
import {
  DUO_COPY,
  buildDuoPickerCopy,
  formatDuoRecipeRemovedNotice,
  formatDuoRecipeSavedNotice,
  formatDuoStepBudgetLabel,
  getDuoValidationMessage,
} from './copy.ts'
import { DuoDetailDrawer } from './DuoDetailDrawer.tsx'
import {
  DUO_DEFAULT_MAX_STEPS,
  DUO_STATE_DOC,
  collectExternalTierIds,
  createEmptyDuoDraft,
  filterDuoRecipeItems,
  getStarterDuoPresets,
  isDuoDraftDirty,
  parseDuoStateDoc,
  recipeToDraft,
  synthesizeDuoRecipeItems,
  validateDuoDraft,
  type DuoRecipeAvailability,
  type DuoRecipeDraft,
  type DuoRecipeViewItem,
  type StarterDuoPreset,
} from './models.ts'
import './styles.css'

const STATUS_META: Readonly<Record<DuoRecipeAvailability, { tone: StatusLightTone; copy: LocalizedText }>> = {
  available: { tone: 'done', copy: DUO_COPY.statusAvailable },
  disabled: { tone: 'blocked', copy: DUO_COPY.statusDisabled },
  unavailable: { tone: 'aborted', copy: DUO_COPY.statusUnavailable },
}

function isInUseConflictError(err: unknown, message: string): boolean {
  if (typeof err === 'object' && err !== null) {
    const rec = err as { status?: unknown; code?: unknown }
    if (rec.status === 409 || rec.code === 'model_tier_in_use') return true
  }
  return /in use|model_tier_in_use/i.test(message)
}

export function DuoManagerScreen(
  props: Partial<ScreenProps> & { inlineDrawer?: boolean },
): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const hostModels = useHostModels()
  const rawDoc = usePluginDoc(DUO_STATE_DOC)
  const stateDoc = useMemo(() => parseDuoStateDoc(rawDoc), [rawDoc])

  const actions = usePluginAction({
    formatError: (err) => (err instanceof Error ? err.message : String(err)),
  })

  const drawer = useScreenDrawer({ param: 'edit', createParam: 'create', scope: props })

  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState<DuoRecipeDraft>(() => createEmptyDuoDraft())
  const [baseline, setBaseline] = useState<DuoRecipeDraft>(() => createEmptyDuoDraft())
  const [drawerError, setDrawerError] = useState<string | null>(null)
  const [stageError, setStageError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DuoRecipeViewItem | null>(null)
  const [forceDeleteTarget, setForceDeleteTarget] = useState<{ item: DuoRecipeViewItem; message: string } | null>(null)

  const pickerCopy = useMemo(() => buildDuoPickerCopy(locale), [locale])
  const allItems = useMemo(
    () => synthesizeDuoRecipeItems(stateDoc.recipes, hostModels),
    [stateDoc.recipes, hostModels],
  )
  const visibleItems = useMemo(() => filterDuoRecipeItems(allItems, search), [allItems, search])
  const existingRecipeIds = useMemo(() => new Set(Object.keys(stateDoc.recipes)), [stateDoc.recipes])
  const externalTierIds = useMemo(() => collectExternalTierIds(hostModels), [hostModels])
  const starterPresets = useMemo(() => getStarterDuoPresets(locale, hostModels), [locale, hostModels])

  const editingItem = useMemo(
    () => (drawer.itemId ? allItems.find((i) => i.recipe.id === drawer.itemId) : undefined),
    [allItems, drawer.itemId],
  )

  const prevDrawerSyncKeyRef = useRef<string>('')
  const pendingPresetDraftRef = useRef<DuoRecipeDraft | null>(null)
  useEffect(() => {
    const syncKey = `${drawer.mode}:${drawer.itemId ?? ''}:${editingItem?.recipe.updatedAt ?? ''}`
    if (syncKey === prevDrawerSyncKeyRef.current) return
    prevDrawerSyncKeyRef.current = syncKey

    setDrawerError(null)
    if (drawer.mode === 'create') {
      const next = pendingPresetDraftRef.current ?? createEmptyDuoDraft()
      const base = createEmptyDuoDraft()
      pendingPresetDraftRef.current = null
      setDraft(next)
      setBaseline(base)
      return
    }
    if (drawer.mode === 'edit' && editingItem !== undefined) {
      pendingPresetDraftRef.current = null
      const next = recipeToDraft(editingItem.recipe)
      setDraft(next)
      setBaseline(next)
    }
  }, [drawer.mode, drawer.itemId, editingItem])

  const openCreateWithPreset = useCallback(
    (preset?: StarterDuoPreset) => {
      const next = createEmptyDuoDraft(preset)
      pendingPresetDraftRef.current = next
      setDraft(next)
      setBaseline(createEmptyDuoDraft())
      setDrawerError(null)
      drawer.openCreate()
    },
    [drawer],
  )

  const handleApplyPreset = useCallback((preset: StarterDuoPreset) => {
    setDraft(createEmptyDuoDraft(preset))
    setDrawerError(null)
  }, [])

  const handleSave = useCallback(() => {
    const mode = drawer.mode === 'edit' ? 'edit' : 'create'
    const validationErr = validateDuoDraft(draft, {
      mode,
      existingRecipeIds,
      externalTierIds,
    })
    if (validationErr !== null) {
      setDrawerError(getDuoValidationMessage(validationErr, locale))
      return
    }

    const parsedSteps = Number(draft.maxExecutionSteps.trim())
    const maxExecutionSteps = Number.isInteger(parsedSteps) ? parsedSteps : DUO_DEFAULT_MAX_STEPS
    const id = draft.id.trim()
    const payload = {
      id,
      name: draft.name.trim(),
      plannerModel: draft.plannerModel.trim(),
      executorModel: draft.executorModel.trim(),
      maxExecutionSteps,
      plannerThinkingLevel: draft.plannerThinkingLevel.trim(),
      executorThinkingLevel: draft.executorThinkingLevel.trim(),
      description: draft.description.trim(),
    }

    setDrawerError(null)
    void actions.run('set', payload, {
      key: `set:${id}`,
      onSuccess: () => {
        ctx.notify(formatDuoRecipeSavedNotice(id, locale), 'info')
        const saved = recipeToDraft({
          id,
          name: payload.name,
          description: payload.description || undefined,
          plannerModel: payload.plannerModel,
          plannerThinkingLevel: payload.plannerThinkingLevel || undefined,
          executorModel: payload.executorModel,
          executorThinkingLevel: payload.executorThinkingLevel || undefined,
          maxExecutionSteps,
          updatedAt: Date.now(),
        })
        setDraft(saved)
        setBaseline(saved)
        drawer.close()
      },
      onError: (msg) => {
        setDrawerError(msg)
      },
    })
  }, [drawer, draft, existingRecipeIds, externalTierIds, locale, actions, ctx])

  const executeDelete = useCallback(
    (item: DuoRecipeViewItem, force: boolean) => {
      setStageError(null)
      setDrawerError(null)
      void actions.run(
        'remove',
        { id: item.recipe.id, ...(force ? { force: true } : {}) },
        {
          key: `remove:${item.recipe.id}`,
          onSuccess: () => {
            setDeleteTarget(null)
            setForceDeleteTarget(null)
            if (drawer.itemId === item.recipe.id) {
              drawer.close()
            }
            ctx.notify(formatDuoRecipeRemovedNotice(item.recipe.id, locale), 'info')
          },
          onError: (msg, err) => {
            if (!force && isInUseConflictError(err, msg)) {
              setDeleteTarget(null)
              setForceDeleteTarget({ item, message: msg })
              return
            }
            if (drawer.open) {
              setDrawerError(msg)
            } else {
              setStageError(msg)
            }
            setDeleteTarget(null)
            setForceDeleteTarget(null)
          },
        },
      )
    },
    [actions, drawer, ctx, locale],
  )

  const dirty = useMemo(() => isDuoDraftDirty(draft, baseline), [draft, baseline])
  const saving = actions.pending && actions.pendingKey?.startsWith('set:') === true
  const deleting = actions.pending && actions.pendingKey?.startsWith('remove:') === true
  const busy = actions.pending

  return (
    <Screen
      className="duo-screen"
      title={t(DUO_COPY.screenTitle)}
      subtitle={t(DUO_COPY.screenSubtitle)}
      icon="git-pull-request"
      toolbar={
        <ScreenToolbar
          label={t(DUO_COPY.screenTitle)}
          actions={
            <Button
              variant="primary"
              size="sm"
              icon="plus"
              onClick={() => openCreateWithPreset()}
            >
              {t(DUO_COPY.createRecipe)}
            </Button>
          }
        >
          {allItems.length > 0 && (
            <SearchBox
              variant="toolbar"
              size="md"
              value={search}
              onChange={setSearch}
              placeholder={t(DUO_COPY.searchPlaceholder)}
              ariaLabel={t(DUO_COPY.searchLabel)}
            />
          )}
        </ScreenToolbar>
      }
    >
      {stageError && <Callout tone="err">{stageError}</Callout>}

      {allItems.length === 0 ? (
        <ScreenSection>
          <EmptyState
            prominent
            icon="git-pull-request"
            title={t(DUO_COPY.emptyTitle)}
            hint={t(DUO_COPY.emptyHint)}
            action={
              <Button variant="primary" size="md" icon="plus" onClick={() => openCreateWithPreset()}>
                {t(DUO_COPY.createRecipe)}
              </Button>
            }
          />
          {starterPresets.length > 0 && (
            <ScreenSection
              className="duo-starters-section"
              title={t(DUO_COPY.startersHeading)}
            >
              <HelperText>{t(DUO_COPY.startersHint)}</HelperText>
              <CardGrid minWidth="md" gap="md">
                {starterPresets.map((preset) => (
                  <Card key={preset.id} className="duo-starter-card">
                    <div className="duo-starter-header">
                      <span className="duo-starter-title">{preset.name}</span>
                      <Badge tone="neutral" mono>
                        tier/{preset.id}
                      </Badge>
                    </div>
                    <p className="duo-starter-desc">{preset.description}</p>
                    <div className="duo-card-pair">
                      <span className="duo-endpoint-chip">
                        <span className="duo-endpoint-role">{t(DUO_COPY.plannerLabel)}</span>
                        <span className="duo-endpoint-model">
                          {preset.plannerModel ? formatModelShortName(preset.plannerModel) : '—'}
                        </span>
                      </span>
                      <HelmxIcon name="arrow-right" size={12} className="duo-pair-arrow" />
                      <span className="duo-endpoint-chip">
                        <span className="duo-endpoint-role">{t(DUO_COPY.executorLabel)}</span>
                        <span className="duo-endpoint-model">
                          {preset.executorModel ? formatModelShortName(preset.executorModel) : '—'}
                        </span>
                      </span>
                    </div>
                    <div>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon="plus"
                        onClick={() => openCreateWithPreset(preset)}
                      >
                        {t(DUO_COPY.useStarter)}
                      </Button>
                    </div>
                  </Card>
                ))}
              </CardGrid>
            </ScreenSection>
          )}
        </ScreenSection>
      ) : visibleItems.length === 0 ? (
        <ScreenSection>
          <EmptyState
            compact
            icon="search"
            title={t(DUO_COPY.noMatchTitle)}
            action={
              <Button variant="ghost" size="sm" onClick={() => setSearch('')}>
                {t(DUO_COPY.clearSearch)}
              </Button>
            }
          />
        </ScreenSection>
      ) : (
        <ScreenSection>
          <CardGrid minWidth="md" gap="md">
            {visibleItems.map((item) => {
              const { recipe } = item
              const statusMeta = STATUS_META[item.status]
              const plannerDisplay = formatModelShortName(item.resolvedPlannerModel ?? recipe.plannerModel)
              const executorDisplay = formatModelShortName(item.resolvedExecutorModel ?? recipe.executorModel)

              return (
                <SelectCard
                  key={recipe.id}
                  data-duo-recipe-id={recipe.id}
                  icon="git-pull-request"
                  title={recipe.name}
                  selected={drawer.mode === 'edit' && drawer.itemId === recipe.id}
                  tone={item.status !== 'available' ? 'warn' : 'default'}
                  badges={
                    <>
                      <StatusLight tone={statusMeta.tone} label={t(statusMeta.copy)} />
                      <Badge tone="neutral" mono>
                        tier/{recipe.id}
                      </Badge>
                    </>
                  }
                  description={recipe.description}
                  onSelect={() => drawer.openItem(recipe.id)}
                  footer={
                    <div className="duo-card-meta-row">
                      <span>{formatDuoStepBudgetLabel(recipe.maxExecutionSteps, locale)}</span>
                      <div className="duo-card-footer-actions">
                        <Button
                          variant="inline"
                          size="xs"
                          icon="pencil"
                          onClick={(e) => {
                            e.stopPropagation()
                            drawer.openItem(recipe.id)
                          }}
                        >
                          {t(DUO_COPY.editRecipe)}
                        </Button>
                        <Button
                          variant="inline"
                          size="xs"
                          icon="trash-2"
                          onClick={(e) => {
                            e.stopPropagation()
                            setDeleteTarget(item)
                          }}
                        >
                          {t(DUO_COPY.deleteRecipe)}
                        </Button>
                      </div>
                    </div>
                  }
                >
                  <div className="duo-card-pair">
                    <span className="duo-endpoint-chip">
                      <span className="duo-endpoint-role">{t(DUO_COPY.plannerLabel)}</span>
                      <span className="duo-endpoint-model">{plannerDisplay}</span>
                      {item.resolvedPlannerThinkingLevel && (
                        <span className="duo-endpoint-effort">({item.resolvedPlannerThinkingLevel})</span>
                      )}
                    </span>
                    <HelmxIcon name="arrow-right" size={12} className="duo-pair-arrow" />
                    <span className="duo-endpoint-chip">
                      <span className="duo-endpoint-role">{t(DUO_COPY.executorLabel)}</span>
                      <span className="duo-endpoint-model">{executorDisplay}</span>
                      {item.resolvedExecutorThinkingLevel && (
                        <span className="duo-endpoint-effort">({item.resolvedExecutorThinkingLevel})</span>
                      )}
                    </span>
                  </div>
                  {item.unavailableReason && (
                    <div className="duo-card-warning">
                      <ErrorText>{item.unavailableReason}</ErrorText>
                    </div>
                  )}
                </SelectCard>
              )
            })}
          </CardGrid>
        </ScreenSection>
      )}

      <DuoDetailDrawer
        open={drawer.open}
        mode={drawer.mode === 'edit' ? 'edit' : 'create'}
        inline={props.inlineDrawer}
        draft={draft}
        editingItem={editingItem}
        existingRecipeIds={existingRecipeIds}
        starterPresets={starterPresets}
        hostModels={hostModels}
        pickerCopy={pickerCopy}
        dirty={dirty}
        saving={saving}
        busy={busy}
        error={drawerError}
        locale={locale}
        translate={t}
        onNotice={(msg, tone) => ctx.notify(msg, tone)}
        onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
        onApplyPreset={handleApplyPreset}
        onSave={handleSave}
        onRequestDelete={(item) => setDeleteTarget(item)}
        onClose={drawer.close}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDeleteTarget(null)
        }}
        title={t(DUO_COPY.deleteConfirmTitle)}
        description={
          deleteTarget
            ? `${deleteTarget.recipe.name} (tier/${deleteTarget.recipe.id}) · ${t(DUO_COPY.deleteConfirmDescription)}`
            : undefined
        }
        danger
        pending={deleting}
        confirmText={t(DUO_COPY.deleteRecipe)}
        cancelText={t(DUO_COPY.cancel)}
        onConfirm={() => {
          if (deleteTarget) executeDelete(deleteTarget, false)
        }}
      />

      <ConfirmDialog
        open={forceDeleteTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setForceDeleteTarget(null)
        }}
        title={t(DUO_COPY.forceDeleteConfirmTitle)}
        description={forceDeleteTarget?.message}
        danger
        pending={deleting}
        confirmText={t(DUO_COPY.forceDeleteConfirmAction)}
        cancelText={t(DUO_COPY.cancel)}
        onConfirm={() => {
          if (forceDeleteTarget) executeDelete(forceDeleteTarget.item, true)
        }}
      />
    </Screen>
  )
}
