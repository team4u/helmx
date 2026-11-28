/** Dedicated full-screen management entrypoint for builtin:duo (`DuoManagerScreen`). */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ScreenProps } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  EmptyState,
  HelmxIcon,
  IconButton,
  List,
  ListRow,
  LoadingState,
  Screen,
  ScreenSection,
  ScreenToolbar,
  SearchBox,
  StatusLight,
  TabCount,
  Tabs,
  TabsList,
  TabsTrigger,
  type LocalizedText,
  type StatusLightTone,
} from '@helmx/ui'
import {
  formatModelShortName,
  resolveDefaultChainThinkingLevel,
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
  formatDuoRemovedNotice,
  formatDuoSavedNotice,
  formatDuoStepsBadge,
  getDuoValidationMessage,
} from './copy.ts'
import { DuoDetailDrawer } from './DuoDetailDrawer.tsx'
import {
  DUO_DEFAULT_MAX_STEPS,
  DUO_STATE_DOC,
  collectExternalTierIds,
  countDuoRecipeItemsByStatus,
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
  type DuoStatusFilter,
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
  const [statusFilter, setStatusFilter] = useState<DuoStatusFilter>('all')
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
  const statusCounts = useMemo(() => countDuoRecipeItemsByStatus(allItems), [allItems])
  const visibleItems = useMemo(
    () => filterDuoRecipeItems(allItems, search, statusFilter),
    [allItems, search, statusFilter],
  )
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

  const resetFilters = useCallback(() => {
    setSearch('')
    setStatusFilter('all')
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
        ctx.notify(formatDuoSavedNotice(id, locale), 'info')
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
            ctx.notify(formatDuoRemovedNotice(item.recipe.id, locale), 'info')
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

  if (rawDoc === undefined) {
    return (
      <Screen layout="contained" title={t(DUO_COPY.screenTitle)}>
        <LoadingState label={t(DUO_COPY.loading)} />
      </Screen>
    )
  }

  return (
    <Screen
      layout="contained"
      className="duo-screen"
      title={t(DUO_COPY.screenTitle)}
      actions={
        <Button
          variant="primary"
          size="sm"
          icon="plus"
          aria-label={t(DUO_COPY.createItem)}
          title={t(DUO_COPY.createItem)}
          disabled={busy}
          onClick={() => openCreateWithPreset()}
        >
          <span className="pane-action-label">{t(DUO_COPY.createItem)}</span>
        </Button>
      }
      toolbar={
        allItems.length > 0 ? (
          <ScreenToolbar
            label={t(DUO_COPY.screenTitle)}
            actions={
              <SearchBox
                variant="toolbar"
                size="sm"
                value={search}
                onChange={setSearch}
                placeholder={t(DUO_COPY.searchPlaceholder)}
                ariaLabel={t(DUO_COPY.searchLabel)}
              />
            }
          >
            <Tabs
              value={statusFilter}
              onValueChange={(nextValue) => setStatusFilter(nextValue as DuoStatusFilter)}
              variant="pills"
              size="sm"
            >
              <TabsList aria-label={t(DUO_COPY.filterAria)}>
                <TabsTrigger value="all">
                  <span>{t(DUO_COPY.filterAll)}</span>
                  <TabCount>{statusCounts.all}</TabCount>
                </TabsTrigger>
                <TabsTrigger value="ready">
                  <span>{t(DUO_COPY.filterReady)}</span>
                  <TabCount>{statusCounts.ready}</TabCount>
                </TabsTrigger>
                <TabsTrigger value="attention">
                  <span>{t(DUO_COPY.filterAttention)}</span>
                  <TabCount>{statusCounts.attention}</TabCount>
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </ScreenToolbar>
        ) : undefined
      }
    >
      {stageError !== null && !drawer.open && (
        <Callout tone="err">
          <span>{stageError}</span>
        </Callout>
      )}

      {allItems.length === 0 ? (
        <>
          <EmptyState
            className="duo-empty"
            icon="git-pull-request"
            title={t(DUO_COPY.emptyTitle)}
            hint={t(DUO_COPY.emptyHint)}
            hintSubtle
            action={
              <Button
                variant="primary"
                size="sm"
                icon="plus"
                disabled={busy}
                onClick={() => openCreateWithPreset()}
              >
                {t(DUO_COPY.createItem)}
              </Button>
            }
          />
          {starterPresets.length > 0 && (
            <ScreenSection title={t(DUO_COPY.startersHeading)}>
              <List label={t(DUO_COPY.startersHeading)}>
                {starterPresets.map((preset) => (
                  <ListRow
                    key={preset.id}
                    data-starter-duo={preset.id}
                    selected={drawer.creating && draft.id === preset.id}
                    leading={<HelmxIcon name="sparkles" size={12} className="duo-starter-icon" />}
                    title={<span>{preset.name}</span>}
                    meta={
                      <>
                        <code className="mono duo-id-code">
                          <span className="duo-prefix">tier/</span>
                          {preset.id}
                        </code>
                        {preset.plannerModel ? (
                          <span className="duo-model-endpoint" title={preset.plannerModel}>
                            <code className="duo-model-name">
                              {formatModelShortName(preset.plannerModel)}
                            </code>
                          </span>
                        ) : null}
                        {preset.plannerModel && preset.executorModel ? (
                          <HelmxIcon name="arrow-right" size={11} className="duo-model-arrow" />
                        ) : null}
                        {preset.executorModel ? (
                          <span className="duo-model-endpoint" title={preset.executorModel}>
                            <code className="duo-model-name">
                              {formatModelShortName(preset.executorModel)}
                            </code>
                          </span>
                        ) : null}
                      </>
                    }
                    description={preset.description}
                    trailing={
                      <Button
                        variant="inline"
                        size="xs"
                        className="duo-starter-cta"
                        onClick={() => openCreateWithPreset(preset)}
                      >
                        <span>{t(DUO_COPY.useStarter)}</span>
                        <HelmxIcon name="arrow-right" size={12} />
                      </Button>
                    }
                    onSelect={() => openCreateWithPreset(preset)}
                  />
                ))}
              </List>
            </ScreenSection>
          )}
        </>
      ) : visibleItems.length === 0 ? (
        <EmptyState
          className="duo-empty"
          icon="search"
          title={t(DUO_COPY.noMatchTitle)}
          action={
            <Button variant="secondary" size="sm" icon="rotate-ccw" onClick={resetFilters}>
              {t(DUO_COPY.resetFilters)}
            </Button>
          }
        />
      ) : (
        <List label={t(DUO_COPY.screenTitle)}>
          {visibleItems.map((item) => {
            const statusMeta = STATUS_META[item.status]
            const statusLabel = t(statusMeta.copy)
            const plannerRef = item.recipe.plannerModel
            const executorRef = item.recipe.executorModel
            const plannerShort = formatModelShortName(item.resolvedPlannerModel ?? plannerRef)
            const executorShort = formatModelShortName(item.resolvedExecutorModel ?? executorRef)
            const plannerLevel =
              item.resolvedPlannerThinkingLevel ??
              resolveDefaultChainThinkingLevel(
                hostModels ?? undefined,
                plannerRef,
                item.recipe.plannerThinkingLevel,
                'tier',
              )
            const execLevel =
              item.resolvedExecutorThinkingLevel ??
              resolveDefaultChainThinkingLevel(
                hostModels ?? undefined,
                executorRef,
                item.recipe.executorThinkingLevel,
                'tier',
              )
            const showPlannerLevel = plannerLevel !== '' && plannerLevel !== 'off'
            const showExecLevel = execLevel !== '' && execLevel !== 'off'
            const stepsBadge = formatDuoStepsBadge(item.recipe.maxExecutionSteps, locale)

            return (
              <ListRow
                key={item.recipe.id}
                data-duo-recipe-id={item.recipe.id}
                selected={drawer.mode === 'edit' && drawer.itemId === item.recipe.id}
                tone={item.status !== 'available' ? 'warn' : 'default'}
                leading={<StatusLight tone={statusMeta.tone} label={statusLabel} />}
                title={<span>{item.recipe.name}</span>}
                meta={
                  <>
                    <code className="mono duo-id-code">
                      <span className="duo-prefix">tier/</span>
                      {item.recipe.id}
                    </code>
                    <span className="duo-model-endpoint" title={plannerRef}>
                      <code className="duo-model-name">{plannerShort}</code>
                      {showPlannerLevel && <span className="duo-model-level">· {plannerLevel}</span>}
                    </span>
                    <HelmxIcon name="arrow-right" size={11} className="duo-model-arrow" />
                    <span className="duo-model-endpoint" title={executorRef}>
                      <code className="duo-model-name">{executorShort}</code>
                      {showExecLevel && <span className="duo-model-level">· {execLevel}</span>}
                    </span>
                    <Badge tone="accent" className="tabular-nums">
                      {stepsBadge}
                    </Badge>
                    {item.status !== 'available' && <Badge tone="warn">{statusLabel}</Badge>}
                  </>
                }
                description={item.unavailableReason || item.recipe.description || undefined}
                actions={
                  <IconButton
                    icon="trash-2"
                    size="xs"
                    variant="ghost"
                    className="duo-row-delete-btn"
                    label={`${t(DUO_COPY.deleteItem)} ${item.recipe.name}`}
                    disabled={busy}
                    pending={actions.pendingKey === `remove:${item.recipe.id}`}
                    onClick={() => setDeleteTarget(item)}
                  />
                }
                onSelect={() => drawer.openItem(item.recipe.id)}
              />
            )
          })}
        </List>
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
        onChange={(patch) => {
          setDrawerError(null)
          setDraft((prev) => ({ ...prev, ...patch }))
        }}
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
            : ''
        }
        danger
        inline={props.inlineDrawer}
        pending={deleting}
        confirmText={t(DUO_COPY.deleteItem)}
        cancelText={t(DUO_COPY.cancel)}
        onConfirm={() => {
          if (deleteTarget) executeDelete(deleteTarget, false)
        }}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={forceDeleteTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setForceDeleteTarget(null)
        }}
        title={t(DUO_COPY.forceDeleteConfirmTitle)}
        description={forceDeleteTarget?.message ?? ''}
        danger
        inline={props.inlineDrawer}
        pending={deleting}
        confirmText={t(DUO_COPY.forceDeleteConfirmAction)}
        cancelText={t(DUO_COPY.cancel)}
        onConfirm={() => {
          if (forceDeleteTarget) executeDelete(forceDeleteTarget.item, true)
        }}
        onCancel={() => setForceDeleteTarget(null)}
      />
    </Screen>
  )
}
