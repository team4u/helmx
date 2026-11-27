/** Dedicated full-screen management entrypoint for builtin:tiers (`TiersManagerScreen`). */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ScreenProps } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardGrid,
  ConfirmDialog,
  EmptyState,
  HelmxIcon,
  IconButton,
  LoadingState,
  Screen,
  ScreenSection,
  ScreenToolbar,
  SearchBox,
  SelectCard,
  Stack,
  StatusLight,
  Tabs,
  TabsList,
  TabsTrigger,
  formatModelShortName,
  formatTime,
  resolveDefaultChainThinkingLevel,
  useHostModels,
  usePluginAction,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
  useScreenDrawer,
  type LocalizedText,
  type StatusLightTone,
} from '@helmx/plugin-client'
import {
  ORCHESTRATOR_DEFAULT_MAX_STEPS,
  TIERS_STATE_DOC,
  countTierItemsByKind,
  createEmptyTierDraft,
  filterTierItems,
  getStarterTierPresets,
  isTierDraftDirty,
  parseTiersStateDoc,
  synthesizeTierItems,
  tierSpecToDraft,
  validateTierDraft,
  type StarterTierPreset,
  type TierAvailabilityStatus,
  type TierFormDraft,
  type TierItemView,
  type TierKindFilter,
  type TierTemplateView,
  type TiersManagerTab,
} from './models.ts'
import {
  TIERS_COPY as C,
  buildTiersPickerCopy,
  tiersActionFailed,
  tiersOrchestratorStepsBadge,
  tiersSuggestedLevelBadge,
  tiersTemplateAppliedNotice,
  tiersTemplateDeleteConfirmBody,
  tiersTemplateDeletedNotice,
  tiersTemplateSavedNotice,
  tiersTierDeleteConfirmBody,
  tiersTierDeletedNotice,
  tiersTierSavedNotice,
} from './copy.ts'
import { TierDetailDrawer } from './TierDetailDrawer.tsx'
import { SaveTemplateDialog } from './SaveTemplateDialog.tsx'
import './styles.css'

const STATUS_META: Readonly<Record<TierAvailabilityStatus, { tone: StatusLightTone; copy: LocalizedText }>> = {
  available: { tone: 'done', copy: C.statusAvailable },
  disabled: { tone: 'blocked', copy: C.statusDisabled },
  unavailable: { tone: 'aborted', copy: C.statusUnavailable },
}

const VALIDATION_ERROR_COPY = {
  id_required: C.errIdRequired,
  duplicate_id: C.errDuplicateId,
  model_required: C.errModelRequired,
  executor_required: C.errExecutorRequired,
  max_steps_invalid: C.errMaxStepsInvalid,
} as const

export function TiersManagerScreen(
  props: Partial<ScreenProps> & { inlineDrawer?: boolean },
): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const rawDoc = usePluginDoc(TIERS_STATE_DOC)
  const hostModels = useHostModels()
  const parsed = useMemo(() => parseTiersStateDoc(rawDoc), [rawDoc])
  const pickerCopy = useMemo(() => buildTiersPickerCopy(locale), [locale])
  const starterPresets = useMemo(() => getStarterTierPresets(locale), [locale])
  const models = hostModels?.models ?? []

  const actions = usePluginAction({
    formatError: (err) => tiersActionFailed(err, locale),
  })

  const drawer = useScreenDrawer({ param: 'edit', createParam: 'create', scope: props })
  const hasHostParams = typeof props.setParams === 'function'
  const [localTab, setLocalTab] = useState<TiersManagerTab>('tiers')

  const activeTab: TiersManagerTab = hasHostParams
    ? (props.params?.['tab'] === 'templates' ? 'templates' : 'tiers')
    : localTab
  const editingId = drawer.itemId
  const creating = drawer.creating
  const drawerOpen = drawer.open

  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<TierKindFilter>('all')
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false)
  const [templateSaveError, setTemplateSaveError] = useState<string | null>(null)
  const [pendingDeleteTier, setPendingDeleteTier] = useState<TierItemView | null>(null)
  const [pendingDeleteTemplate, setPendingDeleteTemplate] = useState<TierTemplateView | null>(null)

  const [pendingPreset, setPendingPreset] = useState<StarterTierPreset | undefined>(undefined)
  const [draft, setDraft] = useState<TierFormDraft>(() => createEmptyTierDraft())
  const [formError, setFormError] = useState<string | null>(null)
  const hydratedKeyRef = useRef<string | null>(null)

  const setActiveTab = (tab: TiersManagerTab): void => {
    if (hasHostParams) {
      props.setParams?.({ tab: tab === 'tiers' ? undefined : tab })
      return
    }
    setLocalTab(tab)
  }

  const tierItems = useMemo(() => synthesizeTierItems(parsed.tiers, models), [parsed.tiers, models])
  const kindCounts = useMemo(() => countTierItemsByKind(tierItems), [tierItems])
  const filteredItems = useMemo(
    () => filterTierItems(tierItems, { query, kindFilter }),
    [tierItems, query, kindFilter],
  )
  const existingIds = useMemo(() => new Set(Object.keys(parsed.tiers)), [parsed.tiers])
  const editingItem = useMemo(
    () => (editingId !== undefined ? tierItems.find((item) => item.id === editingId) : undefined),
    [tierItems, editingId],
  )

  const hasEditingItem = editingItem !== undefined
  const drawerTargetKey = creating
    ? `create:${pendingPreset?.id ?? ''}`
    : editingId !== undefined
      ? `edit:${editingId}:${hasEditingItem ? 'ready' : 'missing'}`
      : 'closed'

  useEffect(() => {
    if (!drawerOpen) {
      if (hydratedKeyRef.current !== null) {
        hydratedKeyRef.current = null
        setPendingPreset(undefined)
        setFormError(null)
        setPendingDeleteTier(null)
      }
      return
    }
    if (hydratedKeyRef.current === drawerTargetKey) return
    hydratedKeyRef.current = drawerTargetKey
    setFormError(null)
    if (creating) {
      setDraft(createEmptyTierDraft(pendingPreset))
    } else if (editingItem !== undefined) {
      setDraft(tierSpecToDraft(editingItem.id, editingItem.spec))
    }
  }, [drawerOpen, drawerTargetKey, creating, pendingPreset, editingItem])

  const openCreateDrawer = (preset?: StarterTierPreset): void => {
    actions.clearError()
    setFormError(null)
    setPendingPreset(preset)
    setDraft(createEmptyTierDraft(preset))
    drawer.openCreate()
  }

  const openEditDrawer = (tierId: string): void => {
    actions.clearError()
    setFormError(null)
    setPendingPreset(undefined)
    drawer.openItem(tierId)
  }

  const closeDrawer = (): void => {
    setFormError(null)
    setPendingPreset(undefined)
    drawer.close()
  }

  const mutateDraft = (patch: Partial<TierFormDraft>): void => {
    setFormError(null)
    setDraft((prev) => ({ ...prev, ...patch }))
  }

  const applyPresetInDrawer = (preset: StarterTierPreset): void => {
    setFormError(null)
    setDraft((prev) => ({
      ...prev,
      id: preset.id,
      suggestedThinkingLevel: preset.suggestedThinkingLevel,
      description: preset.description,
    }))
  }

  const dirty = creating
    ? true
    : editingItem !== undefined && isTierDraftDirty(draft, editingItem.id, editingItem.spec)

  const handleSaveTier = async (): Promise<void> => {
    setFormError(null)
    actions.clearError()
    const mode: 'create' | 'edit' = creating ? 'create' : 'edit'
    const checked = validateTierDraft(draft, { mode, existingIds })
    if (!checked.ok) {
      setFormError(t(VALIDATION_ERROR_COPY[checked.code]))
      return
    }
    await actions.run('set', checked.payload, {
      key: 'save-tier',
      onSuccess: () => {
        ctx.notify(tiersTierSavedNotice(checked.payload.id, locale))
        setPendingPreset(undefined)
        if (creating && !hasHostParams) setLocalTab('tiers')
        drawer.close(creating ? { tab: undefined } : undefined)
      },
      onError: (msg) => {
        setFormError(msg)
      },
    })
  }

  const confirmDeleteTier = (): void => {
    const target = pendingDeleteTier
    if (target === null) return
    setPendingDeleteTier(null)
    actions.clearError()
    void actions.run(
      'remove',
      { id: target.id },
      {
        key: `remove:${target.id}`,
        onSuccess: () => {
          ctx.notify(tiersTierDeletedNotice(target.id, locale))
          if (editingId === target.id) closeDrawer()
        },
        onError: (msg) => {
          if (drawerOpen) setFormError(msg)
        },
      },
    )
  }

  const handleSaveTemplate = (payload: { id: string; name: string; description?: string }): void => {
    setTemplateSaveError(null)
    actions.clearError()
    void actions.run('save_template', payload, {
      key: 'save-template',
      onSuccess: () => {
        setSaveTemplateOpen(false)
        ctx.notify(tiersTemplateSavedNotice(payload.name, locale))
      },
      onError: (msg) => {
        setTemplateSaveError(msg)
      },
    })
  }

  const handleApplyTemplate = (tpl: TierTemplateView): void => {
    actions.clearError()
    void actions.run(
      'apply_template',
      { id: tpl.id },
      {
        key: `apply-tpl:${tpl.id}`,
        onSuccess: () => {
          ctx.notify(tiersTemplateAppliedNotice(tpl.name, locale))
        },
      },
    )
  }

  const confirmDeleteTemplate = (): void => {
    const target = pendingDeleteTemplate
    if (target === null) return
    setPendingDeleteTemplate(null)
    actions.clearError()
    void actions.run(
      'delete_template',
      { id: target.id },
      {
        key: `delete-tpl:${target.id}`,
        onSuccess: () => {
          ctx.notify(tiersTemplateDeletedNotice(target.name, locale))
        },
      },
    )
  }

  if (rawDoc === undefined) {
    return (
      <Screen layout="full-bleed" className="tiers-screen" title={t(C.screenTitle)}>
        <div className="tiers-stage">
          <LoadingState label={t(C.loading)} />
        </div>
      </Screen>
    )
  }

  const savedCount = tierItems.length

  return (
    <Screen
      layout="full-bleed"
      className="tiers-screen"
      title={t(C.screenTitle)}
      actions={
        <>
          {savedCount > 0 && (
            <Button
              variant="default"
              size="sm"
              icon="layers"
              aria-label={t(C.saveAsTemplate)}
              title={t(C.saveAsTemplate)}
              disabled={actions.pending}
              onClick={() => {
                setTemplateSaveError(null)
                setSaveTemplateOpen(true)
              }}
            >
              <span className="pane-action-label">{t(C.saveAsTemplate)}</span>
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            icon="plus"
            aria-label={t(C.addRow)}
            title={t(C.addRow)}
            disabled={actions.pending}
            onClick={() => openCreateDrawer()}
          >
            <span className="pane-action-label">{t(C.addRow)}</span>
          </Button>
        </>
      }
    >
      <ScreenToolbar className="tiers-toolbar" label={t(C.screenTitle)}>
        <Tabs
          value={activeTab}
          onValueChange={(nextValue) =>
            setActiveTab(nextValue === 'templates' ? 'templates' : 'tiers')
          }
          variant="pills"
        >
          <TabsList aria-label={t(C.screenTitle)}>
            <TabsTrigger value="tiers">
              <span>{t(C.tabTiers)}</span>
              <Badge className="tabular-nums">{savedCount}</Badge>
            </TabsTrigger>
            <TabsTrigger value="templates">
              <span>{t(C.tabTemplates)}</span>
              <Badge className="tabular-nums">{parsed.templates.length}</Badge>
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {activeTab === 'tiers' && savedCount > 0 && (
          <>
            <SearchBox
              variant="toolbar"
              value={query}
              onChange={setQuery}
              placeholder={t(C.searchPlaceholder)}
              ariaLabel={t(C.searchPlaceholder)}
            />
            <Tabs
              value={kindFilter}
              onValueChange={(nextValue) => setKindFilter(nextValue as TierKindFilter)}
              variant="pills"
            >
              <TabsList aria-label={t(C.tierKindAria)}>
                <TabsTrigger value="all">
                  <span>{t(C.filterAll)}</span>
                  <Badge className="tabular-nums">{kindCounts.all}</Badge>
                </TabsTrigger>
                <TabsTrigger value="single">
                  <span>{t(C.filterSingle)}</span>
                  <Badge className="tabular-nums">{kindCounts.single}</Badge>
                </TabsTrigger>
                <TabsTrigger value="orchestrator">
                  <span>{t(C.filterOrchestrator)}</span>
                  <Badge className="tabular-nums">{kindCounts.orchestrator}</Badge>
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </>
        )}
      </ScreenToolbar>

      <div className="tiers-stage">
        {actions.error !== undefined && !drawerOpen && !saveTemplateOpen && (
          <Callout tone="err">
            <span>{actions.error}</span>
          </Callout>
        )}

        {activeTab === 'tiers' ? (
          savedCount === 0 ? (
            <>
              <EmptyState
                prominent
                icon="layers"
                title={t(C.emptyTitle)}
                hint={t(C.emptyHint)}
                hintSubtle
                action={
                  <Button
                    variant="primary"
                    size="sm"
                    icon="plus"
                    disabled={actions.pending}
                    onClick={() => openCreateDrawer()}
                  >
                    {t(C.addRow)}
                  </Button>
                }
              />
              <ScreenSection title={t(C.starterSectionTitle)}>
                <CardGrid minWidth="md" gap="md">
                  {starterPresets.map((preset) => (
                    <SelectCard
                      key={preset.id}
                      className="tiers-starter-card"
                      data-starter-tier={preset.id}
                      selected={creating && pendingPreset?.id === preset.id}
                      onSelect={() => openCreateDrawer(preset)}
                      title={
                        <span className="tiers-card-title-row">
                          <HelmxIcon name="sparkles" size={13} className="tiers-starter-icon" />
                          <span className="mono tiers-card-id">tier/{preset.id}</span>
                        </span>
                      }
                      actions={
                        preset.suggestedThinkingLevel !== '' ? (
                          <Badge tone="neutral">{tiersSuggestedLevelBadge(preset.suggestedThinkingLevel, locale)}</Badge>
                        ) : undefined
                      }
                      footer={
                        <span className="tiers-starter-cta">
                          <span>{t(C.starterCardCta)}</span>
                          <HelmxIcon name="arrow-right" size={12} />
                        </span>
                      }
                    >
                      <p className="tiers-card-desc" title={preset.description}>
                        {preset.description}
                      </p>
                    </SelectCard>
                  ))}
                </CardGrid>
              </ScreenSection>
            </>
          ) : filteredItems.length === 0 ? (
            <EmptyState
              prominent
              icon="search"
              title={t(C.filterEmptyTitle)}
              action={
                <Button
                  size="sm"
                  icon="rotate-ccw"
                  onClick={() => {
                    setQuery('')
                    setKindFilter('all')
                  }}
                >
                  {t(C.resetFilters)}
                </Button>
              }
            />
          ) : (
            <CardGrid minWidth="md" gap="md">
              {filteredItems.map((item) => {
                const statusMeta = STATUS_META[item.status]
                const statusLabel = t(statusMeta.copy)
                const primaryDisplayLevel = resolveDefaultChainThinkingLevel(
                  hostModels,
                  item.spec.model,
                  item.spec.thinkingLevel,
                  'tier',
                )
                const execDisplayLevel =
                  item.kind === 'orchestrator' && item.spec.executorModel !== undefined
                    ? resolveDefaultChainThinkingLevel(
                        hostModels,
                        item.spec.executorModel,
                        item.spec.executorThinkingLevel,
                        'tier',
                      )
                    : ''
                const showPrimaryLevel = primaryDisplayLevel !== '' && primaryDisplayLevel !== 'off'
                const showExecLevel = execDisplayLevel !== '' && execDisplayLevel !== 'off'

                return (
                  <SelectCard
                    key={item.id}
                    className="tiers-card"
                    data-tier-id={item.id}
                    selected={editingId === item.id}
                    tone={item.status === 'available' ? 'default' : 'warn'}
                    onSelect={() => openEditDrawer(item.id)}
                    title={
                      <span className="tiers-card-title-row">
                        <StatusLight tone={statusMeta.tone} label={statusLabel} />
                        <span className="mono tiers-card-id">tier/{item.id}</span>
                      </span>
                    }
                    actions={
                      item.kind === 'orchestrator' ? (
                        <Badge tone="accent" icon="workflow">
                          {tiersOrchestratorStepsBadge(
                            item.spec.maxExecutionSteps ?? ORCHESTRATOR_DEFAULT_MAX_STEPS,
                            locale,
                          )}
                        </Badge>
                      ) : showPrimaryLevel ? (
                        <Badge tone="neutral">{primaryDisplayLevel}</Badge>
                      ) : undefined
                    }
                    footer={
                      <>
                        <span className={`tiers-card-status tiers-status-${item.status}`}>{statusLabel}</span>
                        <IconButton
                          icon="trash-2"
                          size="xs"
                          variant="ghost"
                          className="tiers-card-delete-btn"
                          label={t(C.deleteTier)}
                          disabled={actions.pending}
                          pending={actions.pendingKey === `remove:${item.id}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            setPendingDeleteTier(item)
                          }}
                          onKeyDown={(e) => e.stopPropagation()}
                        />
                      </>
                    }
                  >
                    <div className="tiers-model-box">
                      <span className="tiers-model-endpoint" title={item.spec.model}>
                        <code className="tiers-model-name">{formatModelShortName(item.spec.model)}</code>
                        {showPrimaryLevel && <span className="tiers-model-level">· {primaryDisplayLevel}</span>}
                      </span>
                      {item.kind === 'orchestrator' && item.spec.executorModel !== undefined && (
                        <>
                          <HelmxIcon name="arrow-right" size={12} className="tiers-model-arrow" />
                          <span className="tiers-model-endpoint" title={item.spec.executorModel}>
                            <code className="tiers-model-name">{formatModelShortName(item.spec.executorModel)}</code>
                            {showExecLevel && <span className="tiers-model-level">· {execDisplayLevel}</span>}
                          </span>
                        </>
                      )}
                    </div>
                    {item.spec.description !== undefined && item.spec.description !== '' && (
                      <p className="tiers-card-desc" title={item.spec.description}>
                        {item.spec.description}
                      </p>
                    )}
                  </SelectCard>
                )
              })}
            </CardGrid>
          )
        ) : parsed.templates.length === 0 ? (
          <EmptyState
            prominent
            icon="layers"
            title={t(C.templateEmptyTitle)}
            hint={t(C.templateEmpty)}
            hintSubtle
            action={
              savedCount > 0 ? (
                <Button
                  variant="primary"
                  size="sm"
                  icon="layers"
                  disabled={actions.pending}
                  onClick={() => {
                    setTemplateSaveError(null)
                    setSaveTemplateOpen(true)
                  }}
                >
                  {t(C.saveAsTemplate)}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <CardGrid minWidth="lg" gap="md">
            {parsed.templates.map((tpl) => (
              <Card
                key={tpl.id}
                className="tiers-template-card"
                data-template-id={tpl.id}
                title={tpl.name}
                subtitle={<span className="mono">{tpl.id}</span>}
                actions={
                  parsed.activeTemplate === tpl.id ? (
                    <Badge tone="ok">{t(C.templateActiveBadge)}</Badge>
                  ) : undefined
                }
                footer={
                  <>
                    <span className="mono text-muted tiers-template-updated">
                      {tpl.updatedAt > 0 ? formatTime(tpl.updatedAt) : '—'}
                    </span>
                    <Stack direction="horizontal" gap="xs" align="center">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={actions.pending}
                        pending={actions.pendingKey === `apply-tpl:${tpl.id}`}
                        onClick={() => handleApplyTemplate(tpl)}
                      >
                        {t(C.templateApply)}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={actions.pending}
                        pending={actions.pendingKey === `delete-tpl:${tpl.id}`}
                        onClick={() => setPendingDeleteTemplate(tpl)}
                      >
                        {t(C.templateDelete)}
                      </Button>
                    </Stack>
                  </>
                }
              >
                <Stack gap="sm">
                  {tpl.description !== undefined && tpl.description !== '' && (
                    <p className="text-subtle tiers-template-desc">{tpl.description}</p>
                  )}
                  <Stack direction="horizontal" gap="xs" wrap>
                    {Object.entries(tpl.tiers).map(([tid, spec]) => (
                      <Badge key={tid} tone="neutral" mono title={spec.model}>
                        tier/{tid} → {formatModelShortName(spec.model)}{spec.thinkingLevel ? ` · ${spec.thinkingLevel}` : ''}
                      </Badge>
                    ))}
                  </Stack>
                </Stack>
              </Card>
            ))}
          </CardGrid>
        )}
      </div>

      <TierDetailDrawer
        open={drawerOpen}
        mode={creating ? 'create' : 'edit'}
        inline={props.inlineDrawer}
        draft={draft}
        editingItem={editingItem}
        existingIds={existingIds}
        starterPresets={starterPresets}
        hostModels={hostModels}
        pickerCopy={pickerCopy}
        dirty={dirty}
        saving={actions.pendingKey === 'save-tier'}
        busy={actions.pending}
        error={formError}
        locale={locale}
        translate={t}
        onNotice={(msg, tone) => ctx.notify(msg, tone)}
        onChange={mutateDraft}
        onApplyPreset={applyPresetInDrawer}
        onSave={() => void handleSaveTier()}
        onRequestDelete={(item) => setPendingDeleteTier(item)}
        onClose={closeDrawer}
      />

      <SaveTemplateDialog
        open={saveTemplateOpen}
        inline={props.inlineDrawer}
        activeTierCount={savedCount}
        pending={actions.pendingKey === 'save-template'}
        error={templateSaveError}
        locale={locale}
        translate={t}
        onSubmit={handleSaveTemplate}
        onClose={() => setSaveTemplateOpen(false)}
      />

      <ConfirmDialog
        open={pendingDeleteTier !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteTier(null)
        }}
        title={t(C.tierDeleteConfirmTitle)}
        description={
          pendingDeleteTier !== null
            ? tiersTierDeleteConfirmBody(pendingDeleteTier.id, pendingDeleteTier.spec.model, locale)
            : ''
        }
        confirmText={t(C.deleteTier)}
        cancelText={t(C.cancel)}
        danger
        inline={props.inlineDrawer}
        onConfirm={confirmDeleteTier}
        onCancel={() => setPendingDeleteTier(null)}
      />

      <ConfirmDialog
        open={pendingDeleteTemplate !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteTemplate(null)
        }}
        title={t(C.templateDeleteConfirmTitle)}
        description={
          pendingDeleteTemplate !== null
            ? tiersTemplateDeleteConfirmBody(pendingDeleteTemplate.name, pendingDeleteTemplate.id, locale)
            : ''
        }
        confirmText={t(C.templateDelete)}
        cancelText={t(C.cancel)}
        danger
        inline={props.inlineDrawer}
        onConfirm={confirmDeleteTemplate}
        onCancel={() => setPendingDeleteTemplate(null)}
      />
    </Screen>
  )
}
