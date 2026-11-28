/** Dedicated full-screen management entrypoint for builtin:orchestrator (`OrchestratorManagerScreen`). */
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
  ORCHESTRATOR_COPY,
  buildOrchestratorPickerCopy,
  formatOrchestratorRemovedNotice,
  formatOrchestratorSavedNotice,
  formatOrchestratorStepsBadge,
  getOrchestratorValidationMessage,
} from './copy.ts'
import { OrchestratorDetailDrawer } from './OrchestratorDetailDrawer.tsx'
import {
  ORCHESTRATOR_DEFAULT_MAX_STEPS,
  ORCHESTRATOR_STATE_DOC,
  collectExternalTierIds,
  countOrchestratorItemsByStatus,
  createEmptyOrchestratorDraft,
  filterOrchestratorItems,
  getStarterOrchestratorPresets,
  isOrchestratorDraftDirty,
  itemToDraft,
  parseOrchestratorStateDoc,
  synthesizeOrchestratorItems,
  validateOrchestratorDraft,
  type OrchestratorAvailability,
  type OrchestratorDraft,
  type OrchestratorStatusFilter,
  type OrchestratorViewItem,
  type StarterOrchestratorPreset,
} from './models.ts'
import './styles.css'

const STATUS_META: Readonly<Record<OrchestratorAvailability, { tone: StatusLightTone; copy: LocalizedText }>> = {
  available: { tone: 'done', copy: ORCHESTRATOR_COPY.statusAvailable },
  disabled: { tone: 'blocked', copy: ORCHESTRATOR_COPY.statusDisabled },
  unavailable: { tone: 'aborted', copy: ORCHESTRATOR_COPY.statusUnavailable },
}

function isInUseConflictError(err: unknown, message: string): boolean {
  if (typeof err === 'object' && err !== null) {
    const rec = err as { status?: unknown; code?: unknown }
    if (rec.status === 409 || rec.code === 'model_tier_in_use') return true
  }
  return /in use|model_tier_in_use/i.test(message)
}

export function OrchestratorManagerScreen(
  props: Partial<ScreenProps> & { inlineDrawer?: boolean },
): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const hostModels = useHostModels()
  const rawDoc = usePluginDoc(ORCHESTRATOR_STATE_DOC)
  const stateDoc = useMemo(() => parseOrchestratorStateDoc(rawDoc), [rawDoc])

  const actions = usePluginAction({
    formatError: (err) => (err instanceof Error ? err.message : String(err)),
  })

  const drawer = useScreenDrawer({ param: 'edit', createParam: 'create', scope: props })

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<OrchestratorStatusFilter>('all')
  const [draft, setDraft] = useState<OrchestratorDraft>(() => createEmptyOrchestratorDraft())
  const [baseline, setBaseline] = useState<OrchestratorDraft>(() => createEmptyOrchestratorDraft())
  const [drawerError, setDrawerError] = useState<string | null>(null)
  const [stageError, setStageError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<OrchestratorViewItem | null>(null)
  const [forceDeleteTarget, setForceDeleteTarget] = useState<{ item: OrchestratorViewItem; message: string } | null>(null)

  const pickerCopy = useMemo(() => buildOrchestratorPickerCopy(locale), [locale])
  const allItems = useMemo(
    () => synthesizeOrchestratorItems(stateDoc.items, hostModels),
    [stateDoc.items, hostModels],
  )
  const statusCounts = useMemo(() => countOrchestratorItemsByStatus(allItems), [allItems])
  const visibleItems = useMemo(
    () => filterOrchestratorItems(allItems, search, statusFilter),
    [allItems, search, statusFilter],
  )
  const existingItemIds = useMemo(() => new Set(Object.keys(stateDoc.items)), [stateDoc.items])
  const externalTierIds = useMemo(() => collectExternalTierIds(hostModels), [hostModels])
  const starterPresets = useMemo(() => getStarterOrchestratorPresets(locale, hostModels), [locale, hostModels])

  const editingItem = useMemo(
    () => (drawer.itemId ? allItems.find((i) => i.item.id === drawer.itemId) : undefined),
    [allItems, drawer.itemId],
  )

  const prevDrawerSyncKeyRef = useRef<string>('')
  const pendingPresetDraftRef = useRef<OrchestratorDraft | null>(null)
  useEffect(() => {
    const syncKey = `${drawer.mode}:${drawer.itemId ?? ''}:${editingItem?.item.updatedAt ?? ''}`
    if (syncKey === prevDrawerSyncKeyRef.current) return
    prevDrawerSyncKeyRef.current = syncKey

    setDrawerError(null)
    if (drawer.mode === 'create') {
      const next = pendingPresetDraftRef.current ?? createEmptyOrchestratorDraft()
      const base = createEmptyOrchestratorDraft()
      pendingPresetDraftRef.current = null
      setDraft(next)
      setBaseline(base)
      return
    }
    if (drawer.mode === 'edit' && editingItem !== undefined) {
      pendingPresetDraftRef.current = null
      const next = itemToDraft(editingItem.item)
      setDraft(next)
      setBaseline(next)
    }
  }, [drawer.mode, drawer.itemId, editingItem])

  const openCreateWithPreset = useCallback(
    (preset?: StarterOrchestratorPreset) => {
      const next = createEmptyOrchestratorDraft(preset)
      pendingPresetDraftRef.current = next
      setDraft(next)
      setBaseline(createEmptyOrchestratorDraft())
      setDrawerError(null)
      drawer.openCreate()
    },
    [drawer],
  )

  const handleApplyPreset = useCallback((preset: StarterOrchestratorPreset) => {
    setDraft(createEmptyOrchestratorDraft(preset))
    setDrawerError(null)
  }, [])

  const resetFilters = useCallback(() => {
    setSearch('')
    setStatusFilter('all')
  }, [])

  const handleSave = useCallback(() => {
    const mode = drawer.mode === 'edit' ? 'edit' : 'create'
    const validationErr = validateOrchestratorDraft(draft, {
      mode,
      existingItemIds,
      externalTierIds,
    })
    if (validationErr !== null) {
      setDrawerError(getOrchestratorValidationMessage(validationErr, locale))
      return
    }

    const parsedSteps = Number(draft.maxExecutionSteps.trim())
    const maxExecutionSteps = Number.isInteger(parsedSteps) ? parsedSteps : ORCHESTRATOR_DEFAULT_MAX_STEPS
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
        ctx.notify(formatOrchestratorSavedNotice(id, locale), 'info')
        const saved = itemToDraft({
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
  }, [drawer, draft, existingItemIds, externalTierIds, locale, actions, ctx])

  const executeDelete = useCallback(
    (entry: OrchestratorViewItem, force: boolean) => {
      setStageError(null)
      setDrawerError(null)
      void actions.run(
        'remove',
        { id: entry.item.id, ...(force ? { force: true } : {}) },
        {
          key: `remove:${entry.item.id}`,
          onSuccess: () => {
            setDeleteTarget(null)
            setForceDeleteTarget(null)
            if (drawer.itemId === entry.item.id) {
              drawer.close()
            }
            ctx.notify(formatOrchestratorRemovedNotice(entry.item.id, locale), 'info')
          },
          onError: (msg, err) => {
            if (!force && isInUseConflictError(err, msg)) {
              setDeleteTarget(null)
              setForceDeleteTarget({ item: entry, message: msg })
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

  const dirty = useMemo(() => isOrchestratorDraftDirty(draft, baseline), [draft, baseline])
  const saving = actions.pending && actions.pendingKey?.startsWith('set:') === true
  const deleting = actions.pending && actions.pendingKey?.startsWith('remove:') === true
  const busy = actions.pending

  if (rawDoc === undefined) {
    return (
      <Screen layout="contained" title={t(ORCHESTRATOR_COPY.screenTitle)}>
        <LoadingState label={t(ORCHESTRATOR_COPY.loading)} />
      </Screen>
    )
  }

  return (
    <Screen
      layout="contained"
      className="orch-screen"
      title={t(ORCHESTRATOR_COPY.screenTitle)}
      actions={
        <Button
          variant="primary"
          size="sm"
          icon="plus"
          aria-label={t(ORCHESTRATOR_COPY.createItem)}
          title={t(ORCHESTRATOR_COPY.createItem)}
          disabled={busy}
          onClick={() => openCreateWithPreset()}
        >
          <span className="pane-action-label">{t(ORCHESTRATOR_COPY.createItem)}</span>
        </Button>
      }
      toolbar={
        allItems.length > 0 ? (
          <ScreenToolbar
            label={t(ORCHESTRATOR_COPY.screenTitle)}
            actions={
              <SearchBox
                variant="toolbar"
                size="sm"
                value={search}
                onChange={setSearch}
                placeholder={t(ORCHESTRATOR_COPY.searchPlaceholder)}
                ariaLabel={t(ORCHESTRATOR_COPY.searchLabel)}
              />
            }
          >
            <Tabs
              value={statusFilter}
              onValueChange={(nextValue) => setStatusFilter(nextValue as OrchestratorStatusFilter)}
              variant="pills"
              size="sm"
            >
              <TabsList aria-label={t(ORCHESTRATOR_COPY.filterAria)}>
                <TabsTrigger value="all">
                  <span>{t(ORCHESTRATOR_COPY.filterAll)}</span>
                  <TabCount>{statusCounts.all}</TabCount>
                </TabsTrigger>
                <TabsTrigger value="ready">
                  <span>{t(ORCHESTRATOR_COPY.filterReady)}</span>
                  <TabCount>{statusCounts.ready}</TabCount>
                </TabsTrigger>
                <TabsTrigger value="attention">
                  <span>{t(ORCHESTRATOR_COPY.filterAttention)}</span>
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
            className="orch-empty"
            icon="git-pull-request"
            title={t(ORCHESTRATOR_COPY.emptyTitle)}
            hint={t(ORCHESTRATOR_COPY.emptyHint)}
            hintSubtle
            action={
              <Button
                variant="primary"
                size="sm"
                icon="plus"
                disabled={busy}
                onClick={() => openCreateWithPreset()}
              >
                {t(ORCHESTRATOR_COPY.createItem)}
              </Button>
            }
          />
          {starterPresets.length > 0 && (
            <ScreenSection title={t(ORCHESTRATOR_COPY.startersHeading)}>
              <List label={t(ORCHESTRATOR_COPY.startersHeading)}>
                {starterPresets.map((preset) => (
                  <ListRow
                    key={preset.id}
                    data-starter-orchestrator={preset.id}
                    selected={drawer.creating && draft.id === preset.id}
                    leading={<HelmxIcon name="sparkles" size={12} className="orch-starter-icon" />}
                    title={<span>{preset.name}</span>}
                    meta={
                      <>
                        <code className="mono orch-id-code">
                          <span className="orch-prefix">tier/</span>
                          {preset.id}
                        </code>
                        {preset.plannerModel ? (
                          <span className="orch-model-endpoint" title={preset.plannerModel}>
                            <code className="orch-model-name">
                              {formatModelShortName(preset.plannerModel)}
                            </code>
                          </span>
                        ) : null}
                        {preset.plannerModel && preset.executorModel ? (
                          <HelmxIcon name="arrow-right" size={11} className="orch-model-arrow" />
                        ) : null}
                        {preset.executorModel ? (
                          <span className="orch-model-endpoint" title={preset.executorModel}>
                            <code className="orch-model-name">
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
                        className="orch-starter-cta"
                        onClick={() => openCreateWithPreset(preset)}
                      >
                        <span>{t(ORCHESTRATOR_COPY.useStarter)}</span>
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
          className="orch-empty"
          icon="search"
          title={t(ORCHESTRATOR_COPY.noMatchTitle)}
          action={
            <Button variant="secondary" size="sm" icon="rotate-ccw" onClick={resetFilters}>
              {t(ORCHESTRATOR_COPY.resetFilters)}
            </Button>
          }
        />
      ) : (
        <List label={t(ORCHESTRATOR_COPY.screenTitle)}>
          {visibleItems.map((entry) => {
            const statusMeta = STATUS_META[entry.status]
            const statusLabel = t(statusMeta.copy)
            const plannerRef = entry.item.plannerModel
            const executorRef = entry.item.executorModel
            const plannerShort = formatModelShortName(entry.resolvedPlannerModel ?? plannerRef)
            const executorShort = formatModelShortName(entry.resolvedExecutorModel ?? executorRef)
            const plannerLevel =
              entry.resolvedPlannerThinkingLevel ??
              resolveDefaultChainThinkingLevel(
                hostModels ?? undefined,
                plannerRef,
                entry.item.plannerThinkingLevel,
                'tier',
              )
            const execLevel =
              entry.resolvedExecutorThinkingLevel ??
              resolveDefaultChainThinkingLevel(
                hostModels ?? undefined,
                executorRef,
                entry.item.executorThinkingLevel,
                'tier',
              )
            const showPlannerLevel = plannerLevel !== '' && plannerLevel !== 'off'
            const showExecLevel = execLevel !== '' && execLevel !== 'off'
            const stepsBadge = formatOrchestratorStepsBadge(entry.item.maxExecutionSteps, locale)

            return (
              <ListRow
                key={entry.item.id}
                data-orchestrator-id={entry.item.id}
                selected={drawer.mode === 'edit' && drawer.itemId === entry.item.id}
                tone={entry.status !== 'available' ? 'warn' : 'default'}
                leading={<StatusLight tone={statusMeta.tone} label={statusLabel} />}
                title={<span>{entry.item.name}</span>}
                meta={
                  <>
                    <code className="mono orch-id-code">
                      <span className="orch-prefix">tier/</span>
                      {entry.item.id}
                    </code>
                    <span className="orch-model-endpoint" title={plannerRef}>
                      <code className="orch-model-name">{plannerShort}</code>
                      {showPlannerLevel && <span className="orch-model-level">· {plannerLevel}</span>}
                    </span>
                    <HelmxIcon name="arrow-right" size={11} className="orch-model-arrow" />
                    <span className="orch-model-endpoint" title={executorRef}>
                      <code className="orch-model-name">{executorShort}</code>
                      {showExecLevel && <span className="orch-model-level">· {execLevel}</span>}
                    </span>
                    <Badge tone="accent" className="tabular-nums">
                      {stepsBadge}
                    </Badge>
                    {entry.status !== 'available' && <Badge tone="warn">{statusLabel}</Badge>}
                  </>
                }
                description={entry.unavailableReason || entry.item.description || undefined}
                actions={
                  <IconButton
                    icon="trash-2"
                    size="xs"
                    variant="ghost"
                    className="orch-row-delete-btn"
                    label={`${t(ORCHESTRATOR_COPY.deleteItem)} ${entry.item.name}`}
                    disabled={busy}
                    pending={actions.pendingKey === `remove:${entry.item.id}`}
                    onClick={() => setDeleteTarget(entry)}
                  />
                }
                onSelect={() => drawer.openItem(entry.item.id)}
              />
            )
          })}
        </List>
      )}

      <OrchestratorDetailDrawer
        open={drawer.open}
        mode={drawer.mode === 'edit' ? 'edit' : 'create'}
        inline={props.inlineDrawer}
        draft={draft}
        editingItem={editingItem}
        existingItemIds={existingItemIds}
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
        onRequestDelete={(entry) => setDeleteTarget(entry)}
        onClose={drawer.close}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDeleteTarget(null)
        }}
        title={t(ORCHESTRATOR_COPY.deleteConfirmTitle)}
        description={
          deleteTarget
            ? `${deleteTarget.item.name} (tier/${deleteTarget.item.id}) · ${t(ORCHESTRATOR_COPY.deleteConfirmDescription)}`
            : ''
        }
        danger
        inline={props.inlineDrawer}
        pending={deleting}
        confirmText={t(ORCHESTRATOR_COPY.deleteItem)}
        cancelText={t(ORCHESTRATOR_COPY.cancel)}
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
        title={t(ORCHESTRATOR_COPY.forceDeleteConfirmTitle)}
        description={forceDeleteTarget?.message ?? ''}
        danger
        inline={props.inlineDrawer}
        pending={deleting}
        confirmText={t(ORCHESTRATOR_COPY.forceDeleteConfirmAction)}
        cancelText={t(ORCHESTRATOR_COPY.cancel)}
        onConfirm={() => {
          if (forceDeleteTarget) executeDelete(forceDeleteTarget.item, true)
        }}
        onCancel={() => setForceDeleteTarget(null)}
      />
    </Screen>
  )
}
