/**
 * Full-screen management UI for `builtin:port-forward` (`PortForwardManagerScreen`).
 * Fast Refresh compliant: exports only React components and TypeScript types.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import './styles.css'
import type { ScreenProps } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardGrid,
  ConfirmDialog,
  DetailDrawer,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  HelmxIcon,
  IconButton,
  Input,
  KvGrid,
  LoadingState,
  MonoId,
  Screen,
  SearchBox,
  Select,
  SelectCard,
  Stack,
  StatusLight,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  useHostNodes,
  usePluginAction,
  usePluginConfig,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
} from '@helmx/plugin-client'
import {
  PF_RULES_DOC,
  PF_RUNTIME_DOC,
  buildNodeSelectOptions,
  countRulesByStatus,
  createEmptyDraft,
  filterMappingRows,
  isLoopbackHostInput,
  parseRulesDoc,
  parseRuntimeDoc,
  ruleToDraft,
  synthesizeMappingRow,
  validateDraftForm,
  type PortForwardDraftForm,
  type StatusFilter,
  type SynthesizedPortForwardRow,
} from './models.ts'
import {
  PF_CANCEL,
  PF_CLEAR_NODE_FILTER,
  PF_COL_STATUS,
  PF_CONFIRM_DELETE_TITLE,
  PF_CONFIRM_PAUSE_BODY,
  PF_CONFIRM_PAUSE_TITLE,
  PF_CONFIRM_STOP_ALL_BODY,
  PF_CONFIRM_STOP_ALL_TITLE,
  PF_CREATE,
  PF_DELETE,
  PF_DISCONNECT_ALL,
  PF_DRAWER_CREATE_TITLE,
  PF_DRAWER_EDIT_TITLE,
  PF_DRAWER_NOT_FOUND_BODY,
  PF_DRAWER_NOT_FOUND_TITLE,
  PF_EMPTY_HINT,
  PF_EMPTY_TITLE,
  PF_FIELD_ENABLED,
  PF_FIELD_LISTEN_HOST,
  PF_FIELD_LISTEN_HOST_HINT,
  PF_FIELD_LISTEN_PORT,
  PF_FIELD_NAME,
  PF_FIELD_NAME_PLACEHOLDER,
  PF_FIELD_NODE,
  PF_FIELD_NODE_HINT,
  PF_FIELD_TARGET_HOST,
  PF_FIELD_TARGET_HOST_HINT,
  PF_FIELD_TARGET_PORT,
  PF_FILTER_ACTIVE,
  PF_FILTER_ALL,
  PF_FILTER_EMPTY,
  PF_FILTER_ERROR,
  PF_FILTER_STOPPED,
  PF_KV_CONNECTIONS,
  PF_KV_LAST_ERROR,
  PF_KV_STATUS,
  PF_LOADING,
  PF_MORE_ACTIONS,
  PF_NEW_MAPPING,
  PF_NODES_LOADING,
  PF_NODE_OFFLINE,
  PF_NODE_SELECT_PLACEHOLDER,
  PF_NODE_UNKNOWN,
  PF_PUBLIC_BIND_BLOCKED_HINT,
  PF_PUBLIC_BIND_WARN_BODY,
  PF_PUBLIC_BIND_WARN_TITLE,
  PF_RESET_FILTERS,
  PF_SAVE,
  PF_SCREEN_TITLE,
  PF_SEARCH_PLACEHOLDER,
  PF_STOP_ALL,
  PF_TOGGLE_ENABLE,
  pfActionFailed,
  pfActiveConnsPill,
  pfCardConnectionsLabel,
  pfConfirmDeleteBody,
  pfNodeFilterLabel,
  pfPausedRuntimeNotice,
  pfRuleCreatedNotice,
  pfRuleDeletedNotice,
  pfRuleStartedNotice,
  pfRuleStoppedNotice,
  pfRuleUpdatedNotice,
  pfStatusLabel,
  pfStoppedAllNotice,
  pfValidationErrorMessage,
} from './copy.ts'

type PendingBulkConfirm = 'pause' | 'stop_all' | null

function statusBadgeTone(
  statusKind: SynthesizedPortForwardRow['statusKind'],
): 'err' | 'warn' | 'ok' | 'neutral' {
  if (statusKind === 'error') return 'err'
  if (statusKind === 'waiting_node') return 'warn'
  if (statusKind === 'active_traffic' || statusKind === 'listening') return 'ok'
  return 'neutral'
}

export function PortForwardManagerScreen(
  props: ScreenProps & { inlineDrawer?: boolean },
): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const rawRules = usePluginDoc(PF_RULES_DOC)
  const rawRuntime = usePluginDoc(PF_RUNTIME_DOC)
  const nodes = useHostNodes()
  const config = usePluginConfig<{ allowPublicBind?: boolean }>()
  const allowPublicBind = config.allowPublicBind === true

  const actions = usePluginAction({
    notifyError: true,
    formatError: (err) => pfActionFailed(err, locale),
  })

  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [pendingDelete, setPendingDelete] = useState<SynthesizedPortForwardRow | null>(null)
  const [pendingBulkConfirm, setPendingBulkConfirm] = useState<PendingBulkConfirm>(null)

  const nodeFilter = props.params['node'] ?? ''
  const editingId = props.params['edit']
  const creating = props.params['create'] === '1'
  const drawerOpen = creating || editingId !== undefined

  const rules = useMemo(() => parseRulesDoc(rawRules), [rawRules])
  const runtimeById = useMemo(() => parseRuntimeDoc(rawRuntime), [rawRuntime])
  const rows = useMemo(
    () => rules.map((rule) => synthesizeMappingRow(rule, runtimeById, nodes)),
    [rules, runtimeById, nodes],
  )
  const counts = useMemo(() => countRulesByStatus(rows), [rows])
  const filteredRows = useMemo(
    () => filterMappingRows(rows, { query, statusFilter, nodeFilter }),
    [rows, query, statusFilter, nodeFilter],
  )

  const editingRule = useMemo(
    () => (editingId !== undefined ? rules.find((r) => r.id === editingId) : undefined),
    [rules, editingId],
  )
  const editingRow = useMemo(
    () => (editingId !== undefined ? rows.find((r) => r.id === editingId) : undefined),
    [rows, editingId],
  )

  const [draft, setDraft] = useState<PortForwardDraftForm>(() => createEmptyDraft(nodeFilter || 'local'))
  const [formError, setFormError] = useState<string | null>(null)
  const hydratedKeyRef = useRef<string | null>(null)

  const hasEditingRule = editingRule !== undefined
  const drawerTargetKey = creating
    ? `create:${nodeFilter}`
    : editingId !== undefined
      ? `edit:${editingId}:${hasEditingRule ? 'ready' : 'missing'}`
      : 'closed'

  useEffect(() => {
    if (!drawerOpen) {
      hydratedKeyRef.current = null
      setFormError(null)
      return
    }
    if (hydratedKeyRef.current === drawerTargetKey) return
    hydratedKeyRef.current = drawerTargetKey
    setFormError(null)
    if (creating) {
      setDraft(createEmptyDraft(nodeFilter || 'local'))
    } else if (editingRule !== undefined) {
      setDraft(ruleToDraft(editingRule))
    }
  }, [drawerOpen, drawerTargetKey, creating, editingRule, nodeFilter])

  const closeDrawer = (): void => {
    setFormError(null)
    props.setParams({ create: undefined, edit: undefined })
  }

  const openCreateDrawer = (): void => {
    setFormError(null)
    setDraft(createEmptyDraft(nodeFilter || 'local'))
    props.setParams({ create: '1', edit: undefined })
  }

  const openEditDrawer = (ruleId: string): void => {
    setFormError(null)
    props.setParams({ edit: ruleId, create: undefined })
  }

  const handleToggleRule = (row: SynthesizedPortForwardRow, nextEnabled: boolean): void => {
    actions.clearError()
    const actionId = nextEnabled ? 'start' : 'stop'
    void actions.run(
      actionId,
      { id: row.id },
      {
        key: `toggle:${row.id}`,
        onSuccess: () => {
          ctx.notify(
            nextEnabled ? pfRuleStartedNotice(row.name, locale) : pfRuleStoppedNotice(row.name, locale),
          )
        },
      },
    )
  }

  const handleSubmitDraft = async (): Promise<void> => {
    setFormError(null)
    actions.clearError()
    const checked = validateDraftForm(draft, allowPublicBind)
    if (!checked.ok) {
      setFormError(pfValidationErrorMessage(checked.errorCode, locale))
      return
    }
    if (creating) {
      await actions.run('create', checked.payload, {
        key: 'save-drawer',
        onSuccess: (res) => {
          const item = (res as { item?: { name?: string } } | undefined)?.item
          ctx.notify(pfRuleCreatedNotice(item?.name ?? checked.payload.name ?? checked.payload.nodeId, locale))
          closeDrawer()
        },
      })
      return
    }
    if (editingRule === undefined) return
    await actions.run(
      'update',
      { id: editingRule.id, ...checked.payload },
      {
        key: 'save-drawer',
        onSuccess: (res) => {
          const item = (res as { item?: { name?: string } } | undefined)?.item
          ctx.notify(pfRuleUpdatedNotice(item?.name ?? editingRule.name, locale))
          closeDrawer()
        },
      },
    )
  }

  const confirmDelete = (): void => {
    const target = pendingDelete
    if (target === null) return
    setPendingDelete(null)
    void actions.run(
      'delete',
      { id: target.id },
      {
        key: `delete:${target.id}`,
        onSuccess: () => {
          ctx.notify(pfRuleDeletedNotice(target.name, locale))
          if (editingId === target.id) closeDrawer()
        },
      },
    )
  }

  const confirmBulk = (): void => {
    const kind = pendingBulkConfirm
    if (kind === null) return
    setPendingBulkConfirm(null)
    if (kind === 'pause') {
      void actions.run(
        'pause_runtime',
        {},
        {
          key: 'pause_runtime',
          onSuccess: (res) => {
            const out = (res as { stoppedListeners?: number; closedConnections?: number } | undefined) ?? {}
            ctx.notify(
              pfPausedRuntimeNotice(out.stoppedListeners ?? 0, out.closedConnections ?? 0, locale),
            )
          },
        },
      )
      return
    }
    void actions.run(
      'stop_all',
      {},
      {
        key: 'stop_all',
        onSuccess: (res) => {
          const out = (res as { stopped?: number } | undefined) ?? {}
          ctx.notify(pfStoppedAllNotice(out.stopped ?? 0, locale))
        },
      },
    )
  }

  if (rawRules === undefined) {
    return (
      <Screen layout="full-bleed" className="pf-screen" title={t(PF_SCREEN_TITLE)}>
        <div className="pf-stage">
          <LoadingState label={t(PF_LOADING)} />
        </div>
      </Screen>
    )
  }

  const nodeOptions = buildNodeSelectOptions(nodes, draft.nodeId, locale)
  const nonLoopbackDraft = !isLoopbackHostInput(draft.listenHost)
  const statusTabs: Array<{ value: StatusFilter; label: string; count: number }> = [
    { value: 'all', label: t(PF_FILTER_ALL), count: counts.all },
    { value: 'active', label: t(PF_FILTER_ACTIVE), count: counts.active },
    { value: 'stopped', label: t(PF_FILTER_STOPPED), count: counts.stopped },
    { value: 'error', label: t(PF_FILTER_ERROR), count: counts.error },
  ]

  return (
    <Screen layout="full-bleed" className="pf-screen" title={t(PF_SCREEN_TITLE)}>
      <div className="pf-toolbar">
        <div className="pf-toolbar-main">
          <SearchBox
            variant="toolbar"
            value={query}
            onChange={setQuery}
            placeholder={t(PF_SEARCH_PLACEHOLDER)}
            ariaLabel={t(PF_SEARCH_PLACEHOLDER)}
          />
          <Tabs
            value={statusFilter}
            onValueChange={(nextValue) => setStatusFilter(nextValue as StatusFilter)}
            variant="pills"
          >
            <TabsList aria-label={t(PF_COL_STATUS)}>
              {statusTabs.map((pill) => (
                <TabsTrigger key={pill.value} value={pill.value}>
                  <span>{pill.label}</span>
                  <Badge className="tabular-nums">{pill.count}</Badge>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {nodeFilter !== '' && (
            <Badge tone="accent" icon="server">
              <span>{pfNodeFilterLabel(nodeFilter, locale)}</span>
              <button
                type="button"
                className="btn btn-ghost btn-icon-xs"
                aria-label={t(PF_CLEAR_NODE_FILTER)}
                title={t(PF_CLEAR_NODE_FILTER)}
                onClick={() => props.setParams({ node: undefined })}
              >
                <HelmxIcon name="x" size={11} />
              </button>
            </Badge>
          )}
          {counts.activeConnections > 0 && (
            <Badge tone="accent" icon="activity" className="tabular-nums">
              {pfActiveConnsPill(counts.activeConnections, locale)}
            </Badge>
          )}
        </div>

        <div className="pf-toolbar-actions">
          {rules.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  variant="default"
                  size="sm"
                  icon="more-horizontal"
                  label={t(PF_MORE_ACTIONS)}
                  disabled={actions.pending}
                  pending={actions.pendingKey === 'pause_runtime' || actions.pendingKey === 'stop_all'}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent portalled inline={props.inlineDrawer} align="end">
                <DropdownMenuItem
                  disabled={actions.pending || (counts.active === 0 && counts.activeConnections === 0)}
                  onSelect={() => setPendingBulkConfirm('pause')}
                >
                  <HelmxIcon name="rotate-ccw" size={13} />
                  <span>{t(PF_DISCONNECT_ALL)}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  danger
                  disabled={actions.pending || (counts.enabled === 0 && counts.active === 0)}
                  onSelect={() => setPendingBulkConfirm('stop_all')}
                >
                  <HelmxIcon name="square" size={13} />
                  <span>{t(PF_STOP_ALL)}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            variant="primary"
            size="sm"
            icon="plus"
            disabled={actions.pending}
            onClick={openCreateDrawer}
          >
            {t(PF_NEW_MAPPING)}
          </Button>
        </div>
      </div>

      <div className="pf-stage">
        {actions.error !== undefined && !drawerOpen && (
          <Callout tone="err">
            <span>{actions.error}</span>
          </Callout>
        )}

        {rules.length === 0 ? (
          <EmptyState
            prominent
            icon="network"
            title={t(PF_EMPTY_TITLE)}
            hint={t(PF_EMPTY_HINT)}
            hintSubtle
          />
        ) : filteredRows.length === 0 ? (
          <EmptyState
            prominent
            icon="search"
            title={t(PF_FILTER_EMPTY)}
            action={
              <Button
                size="sm"
                icon="rotate-ccw"
                onClick={() => {
                  setQuery('')
                  setStatusFilter('all')
                  if (nodeFilter !== '') props.setParams({ node: undefined })
                }}
              >
                {t(PF_RESET_FILTERS)}
              </Button>
            }
          />
        ) : (
          <CardGrid minWidth="lg" gap="md">
            {filteredRows.map((row) => {
              const statusText = pfStatusLabel(row.statusKind, locale)
              return (
                <SelectCard
                  key={row.id}
                  className={`pf-card ${row.enabled ? 'is-enabled' : 'is-stopped'}`}
                  data-rule-id={row.id}
                  selected={editingId === row.id}
                  tone={
                    row.statusKind === 'error'
                      ? 'danger'
                      : row.statusKind === 'waiting_node'
                        ? 'warn'
                        : 'default'
                  }
                  onSelect={() => openEditDrawer(row.id)}
                  title={
                    <span className="pf-card-title-row">
                      <StatusLight tone={row.displayTone} label={statusText} />
                      <span className="pf-card-name" title={row.name}>
                        {row.name}
                      </span>
                    </span>
                  }
                  subtitle={
                    <span className="pf-card-node-line">
                      <HelmxIcon name={row.nodeId === 'local' ? 'laptop' : 'server'} size={11} />
                      <span className="mono">{row.nodeId}</span>
                      {nodes !== undefined && row.nodeKnown === false && (
                        <Badge tone="warn">{t(PF_NODE_UNKNOWN)}</Badge>
                      )}
                      {nodes !== undefined && row.nodeKnown === true && row.nodeOnline === false && (
                        <Badge tone="warn">{t(PF_NODE_OFFLINE)}</Badge>
                      )}
                    </span>
                  }
                  actions={
                    <Switch
                      checked={row.enabled}
                      disabled={actions.pending}
                      aria-label={`${t(PF_TOGGLE_ENABLE)}: ${row.name}`}
                      onChange={(checked) => handleToggleRule(row, checked)}
                    />
                  }
                  footer={
                    <>
                      <div className="pf-card-meta-row">
                        <span className={`pf-card-status pf-status-${row.statusKind}`}>{statusText}</span>
                        <span className="pf-card-dot" aria-hidden="true">
                          ·
                        </span>
                        <span className="pf-card-conns tabular-nums">
                          {pfCardConnectionsLabel(row.activeConnections, row.totalConnections, locale)}
                        </span>
                      </div>
                      <IconButton
                        icon="trash-2"
                        size="xs"
                        variant="ghost"
                        className="pf-card-delete-btn"
                        label={t(PF_DELETE)}
                        disabled={actions.pending}
                        pending={actions.pendingKey === `delete:${row.id}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          setPendingDelete(row)
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                      />
                    </>
                  }
                >
                  <div className="pf-route-box">
                    <MonoId value={row.listenAddr} className="pf-route-listen" />
                    <HelmxIcon name="arrow-right" size={12} className="pf-route-arrow" />
                    <code className="pf-route-target" title={row.targetAddr}>
                      {row.targetAddr}
                    </code>
                  </div>
                  {row.lastError !== undefined && (
                    <div className="pf-card-error" title={row.lastError}>
                      {row.lastError}
                    </div>
                  )}
                </SelectCard>
              )
            })}
          </CardGrid>
        )}
      </div>

      <DetailDrawer
        open={drawerOpen}
        onClose={closeDrawer}
        inline={props.inlineDrawer}
        icon={<HelmxIcon name="network" size={16} />}
        title={
          creating
            ? t(PF_DRAWER_CREATE_TITLE)
            : editingRule !== undefined
              ? t(PF_DRAWER_EDIT_TITLE)
              : t(PF_DRAWER_NOT_FOUND_TITLE)
        }
        titleExtra={
          !creating && editingRow !== undefined ? (
            <Badge tone={statusBadgeTone(editingRow.statusKind)}>
              {pfStatusLabel(editingRow.statusKind, locale)}
            </Badge>
          ) : undefined
        }
        meta={editingRule?.id}
        footer={
          creating || editingRule !== undefined ? (
            <>
              {editingRule !== undefined && (
                <Button
                  variant="danger"
                  size="sm"
                  icon="trash-2"
                  disabled={actions.pending}
                  onClick={() => {
                    const matched = rows.find((r) => r.id === editingRule.id)
                    if (matched !== undefined) setPendingDelete(matched)
                  }}
                >
                  {t(PF_DELETE)}
                </Button>
              )}
              <div className="flex-1" />
              <Button variant="ghost" size="sm" disabled={actions.pending} onClick={closeDrawer}>
                {t(PF_CANCEL)}
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon="check"
                pending={actions.pendingKey === 'save-drawer'}
                disabled={actions.pending}
                onClick={() => void handleSubmitDraft()}
              >
                {creating ? t(PF_CREATE) : t(PF_SAVE)}
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={closeDrawer}>
              {t(PF_CANCEL)}
            </Button>
          )
        }
      >
        {!creating && editingRule === undefined ? (
          <Callout tone="warn">{t(PF_DRAWER_NOT_FOUND_BODY)}</Callout>
        ) : (
          <Stack gap="md">
            {(formError !== null || actions.error !== undefined) && (
              <Callout tone="err">
                <span>{formError ?? actions.error}</span>
              </Callout>
            )}

            {!creating && editingRow !== undefined && (
              <Card variant="subtle">
                <KvGrid
                  items={[
                    {
                      key: t(PF_KV_STATUS),
                      value: (
                        <span className="pf-status-cell">
                          <StatusLight
                            tone={editingRow.displayTone}
                            label={pfStatusLabel(editingRow.statusKind, locale)}
                          />
                          <span>{pfStatusLabel(editingRow.statusKind, locale)}</span>
                        </span>
                      ),
                    },
                    {
                      key: t(PF_KV_CONNECTIONS),
                      value: `${editingRow.activeConnections} / ${editingRow.totalConnections}`,
                    },
                    ...(editingRow.lastError !== undefined
                      ? [
                          {
                            key: t(PF_KV_LAST_ERROR),
                            value: <span className="pf-error-text">{editingRow.lastError}</span>,
                          },
                        ]
                      : []),
                  ]}
                />
              </Card>
            )}

            <Field label={t(PF_FIELD_NAME)}>
              <Input
                value={draft.name}
                placeholder={t(PF_FIELD_NAME_PLACEHOLDER)}
                onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
              />
            </Field>

            <Field label={t(PF_FIELD_NODE)} hint={t(PF_FIELD_NODE_HINT)} required>
              <Select
                value={draft.nodeId}
                disabled={nodes === undefined}
                inline={props.inlineDrawer}
                placeholder={nodes === undefined ? t(PF_NODES_LOADING) : t(PF_NODE_SELECT_PLACEHOLDER)}
                options={nodeOptions}
                onChange={(e) => setDraft((prev) => ({ ...prev, nodeId: e.target.value }))}
              />
            </Field>

            <div className="pf-form-pair">
              <Field label={t(PF_FIELD_LISTEN_HOST)} hint={t(PF_FIELD_LISTEN_HOST_HINT)}>
                <Input
                  mono
                  value={draft.listenHost}
                  placeholder="127.0.0.1"
                  onChange={(e) => setDraft((prev) => ({ ...prev, listenHost: e.target.value }))}
                />
              </Field>
              <Field label={t(PF_FIELD_LISTEN_PORT)} required>
                <Input
                  mono
                  inputMode="numeric"
                  value={draft.listenPort}
                  placeholder="8080"
                  onChange={(e) => setDraft((prev) => ({ ...prev, listenPort: e.target.value }))}
                />
              </Field>
            </div>

            {nonLoopbackDraft && (
              <Callout tone="warn" title={t(PF_PUBLIC_BIND_WARN_TITLE)}>
                <Stack gap="xs">
                  <span>{t(PF_PUBLIC_BIND_WARN_BODY)}</span>
                  {!allowPublicBind && <span>{t(PF_PUBLIC_BIND_BLOCKED_HINT)}</span>}
                </Stack>
              </Callout>
            )}

            <div className="pf-form-pair">
              <Field label={t(PF_FIELD_TARGET_HOST)} hint={t(PF_FIELD_TARGET_HOST_HINT)}>
                <Input
                  mono
                  value={draft.targetHost}
                  placeholder="127.0.0.1"
                  onChange={(e) => setDraft((prev) => ({ ...prev, targetHost: e.target.value }))}
                />
              </Field>
              <Field label={t(PF_FIELD_TARGET_PORT)} required>
                <Input
                  mono
                  inputMode="numeric"
                  value={draft.targetPort}
                  placeholder="3000"
                  onChange={(e) => setDraft((prev) => ({ ...prev, targetPort: e.target.value }))}
                />
              </Field>
            </div>

            <Field htmlFor={false}>
              <Switch
                checked={draft.enabled}
                label={t(PF_FIELD_ENABLED)}
                onChange={(checked) => setDraft((prev) => ({ ...prev, enabled: checked }))}
              />
            </Field>
          </Stack>
        )}
      </DetailDrawer>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        title={t(PF_CONFIRM_DELETE_TITLE)}
        description={
          pendingDelete !== null
            ? pfConfirmDeleteBody(pendingDelete.name, pendingDelete.listenAddr, locale)
            : ''
        }
        confirmText={t(PF_DELETE)}
        cancelText={t(PF_CANCEL)}
        danger
        inline={props.inlineDrawer}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={pendingBulkConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setPendingBulkConfirm(null)
        }}
        title={
          pendingBulkConfirm === 'pause'
            ? t(PF_CONFIRM_PAUSE_TITLE)
            : t(PF_CONFIRM_STOP_ALL_TITLE)
        }
        description={
          pendingBulkConfirm === 'pause'
            ? t(PF_CONFIRM_PAUSE_BODY)
            : t(PF_CONFIRM_STOP_ALL_BODY)
        }
        confirmText={
          pendingBulkConfirm === 'pause' ? t(PF_DISCONNECT_ALL) : t(PF_STOP_ALL)
        }
        cancelText={t(PF_CANCEL)}
        danger={pendingBulkConfirm === 'stop_all'}
        inline={props.inlineDrawer}
        onConfirm={confirmBulk}
        onCancel={() => setPendingBulkConfirm(null)}
      />
    </Screen>
  )
}
