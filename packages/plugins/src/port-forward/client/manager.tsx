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
  ConfirmDialog,
  DataTable,
  DetailDrawer,
  EmptyState,
  Field,
  HelmxIcon,
  IconButton,
  Input,
  KvGrid,
  LoadingState,
  MonoId,
  Screen,
  ScreenSection,
  ScreenToolbar,
  SearchBox,
  SegmentedControl,
  Select,
  Stack,
  StatusLight,
  Switch,
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
  createEmptyDraft,
  filterMappingRows,
  isLoopbackHostInput,
  parseRulesDoc,
  parseRuntimeDoc,
  ruleToDraft,
  selectableRowProps,
  synthesizeMappingRow,
  validateDraftForm,
  type PortForwardDraftForm,
  type StatusFilter,
  type SynthesizedPortForwardRow,
} from './models.ts'
import {
  PF_CANCEL,
  PF_CLEAR_NODE_FILTER,
  PF_COL_ACTIONS,
  PF_COL_CONNS,
  PF_COL_LISTEN,
  PF_COL_NAME,
  PF_COL_NODE,
  PF_COL_STATUS,
  PF_COL_TARGET,
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
  PF_EDIT,
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
  PF_KV_ACTIVE_CONNS,
  PF_KV_ERRORS,
  PF_KV_LISTENING,
  PF_KV_TOTAL_RULES,
  PF_LOADING,
  PF_NEW_MAPPING,
  PF_NODES_LOADING,
  PF_NODE_OFFLINE,
  PF_NODE_ONLINE,
  PF_NODE_SELECT_PLACEHOLDER,
  PF_NODE_UNKNOWN,
  PF_PUBLIC_BIND_BLOCKED_HINT,
  PF_PUBLIC_BIND_WARN_BODY,
  PF_PUBLIC_BIND_WARN_TITLE,
  PF_RULES_SECTION,
  PF_SAVE,
  PF_SCREEN_SUBTITLE,
  PF_SCREEN_TITLE,
  PF_SEARCH_PLACEHOLDER,
  PF_SPLIT_SUFFIX,
  PF_STOP_ALL,
  PF_TOGGLE_ENABLE,
  pfActionFailed,
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
  const filteredRows = useMemo(
    () => filterMappingRows(rows, { query, statusFilter, nodeFilter }),
    [rows, query, statusFilter, nodeFilter],
  )

  const editingRule = useMemo(
    () => (editingId !== undefined ? rules.find((r) => r.id === editingId) : undefined),
    [rules, editingId],
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

  const listeningCount = rows.filter((r) => r.listenerState === 'listening').length
  const activeConnsTotal = rows.reduce((sum, r) => sum + r.activeConnections, 0)
  const errorCount = rows.filter((r) => r.listenerState === 'error').length
  const enabledCount = rows.filter((r) => r.enabled).length

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
      <Screen
        title={t(PF_SCREEN_TITLE)}
        subtitle={
          <>
            {t(PF_SCREEN_SUBTITLE)}
            {props.isSplit ? t(PF_SPLIT_SUFFIX) : ''}
          </>
        }
      >
        <LoadingState label={t(PF_LOADING)} />
      </Screen>
    )
  }

  const nodeOptions = buildNodeSelectOptions(nodes, draft.nodeId, locale)
  const nonLoopbackDraft = !isLoopbackHostInput(draft.listenHost)
  const statusTabs: Array<{ value: StatusFilter; label: string }> = [
    { value: 'all', label: t(PF_FILTER_ALL) },
    { value: 'active', label: t(PF_FILTER_ACTIVE) },
    { value: 'stopped', label: t(PF_FILTER_STOPPED) },
    { value: 'error', label: t(PF_FILTER_ERROR) },
  ]

  return (
    <Screen
      title={t(PF_SCREEN_TITLE)}
      subtitle={
        <>
          {t(PF_SCREEN_SUBTITLE)}
          {props.isSplit ? t(PF_SPLIT_SUFFIX) : ''}
        </>
      }
    >
      <ScreenToolbar
        actions={
          <>
            <SegmentedControl
              size="sm"
              value={statusFilter}
              onValueChange={setStatusFilter}
              items={statusTabs}
              aria-label={t(PF_COL_STATUS)}
            />
            <Button
              variant="secondary"
              size="sm"
              icon="rotate-ccw"
              disabled={actions.pending || (listeningCount === 0 && activeConnsTotal === 0)}
              pending={actions.pendingKey === 'pause_runtime'}
              onClick={() => setPendingBulkConfirm('pause')}
            >
              {t(PF_DISCONNECT_ALL)}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon="square"
              disabled={actions.pending || (enabledCount === 0 && listeningCount === 0)}
              pending={actions.pendingKey === 'stop_all'}
              onClick={() => setPendingBulkConfirm('stop_all')}
            >
              {t(PF_STOP_ALL)}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon="plus"
              disabled={actions.pending}
              onClick={openCreateDrawer}
            >
              {t(PF_NEW_MAPPING)}
            </Button>
          </>
        }
      >
        <SearchBox
          variant="toolbar"
          value={query}
          onChange={setQuery}
          placeholder={t(PF_SEARCH_PLACEHOLDER)}
          ariaLabel={t(PF_SEARCH_PLACEHOLDER)}
        />
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
      </ScreenToolbar>

      {actions.error !== undefined && (
        <Callout tone="err">
          <span>{actions.error}</span>
        </Callout>
      )}

      <KvGrid
        items={[
          { key: t(PF_KV_TOTAL_RULES), value: rules.length },
          { key: t(PF_KV_LISTENING), value: listeningCount },
          { key: t(PF_KV_ACTIVE_CONNS), value: activeConnsTotal },
          { key: t(PF_KV_ERRORS), value: errorCount },
        ]}
      />

      <ScreenSection title={t(PF_RULES_SECTION)} titleExtra={filteredRows.length}>
        {rules.length === 0 ? (
          <EmptyState
            icon="network"
            title={t(PF_EMPTY_TITLE)}
            hint={t(PF_EMPTY_HINT)}
            action={
              <Button variant="primary" size="sm" icon="plus" onClick={openCreateDrawer}>
                {t(PF_NEW_MAPPING)}
              </Button>
            }
          />
        ) : (
          <div className="pf-table-wrap">
            <DataTable
              columns={7}
              empty={filteredRows.length === 0}
              emptyLabel={t(PF_FILTER_EMPTY)}
              label={t(PF_RULES_SECTION)}
            >
              <thead>
                <tr>
                  <th>{t(PF_COL_STATUS)}</th>
                  <th>{t(PF_COL_NAME)}</th>
                  <th>{t(PF_COL_LISTEN)}</th>
                  <th>{t(PF_COL_NODE)}</th>
                  <th>{t(PF_COL_TARGET)}</th>
                  <th>{t(PF_COL_CONNS)}</th>
                  <th className="cell-actions">{t(PF_COL_ACTIONS)}</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => {
                  const statusText = pfStatusLabel(row.statusKind, locale)
                  const nodeBadgeTone =
                    row.nodeKnown === false
                      ? 'warn'
                      : row.nodeOnline === true
                        ? 'ok'
                        : row.nodeOnline === false
                          ? 'warn'
                          : 'neutral'
                  const nodeBadgeLabel =
                    row.nodeKnown === false
                      ? t(PF_NODE_UNKNOWN)
                      : row.nodeOnline === true
                        ? t(PF_NODE_ONLINE)
                        : row.nodeOnline === false
                          ? t(PF_NODE_OFFLINE)
                          : t(PF_NODE_UNKNOWN)
                  return (
                    <tr key={row.id} {...selectableRowProps(row.id, editingId, openEditDrawer)}>
                      <td data-label={t(PF_COL_STATUS)}>
                        <div className="pf-status-cell">
                          <StatusLight tone={row.displayTone} label={statusText} />
                          <span>{statusText}</span>
                        </div>
                        {row.lastError !== undefined && (
                          <div className="cell-error" title={row.lastError}>
                            {row.lastError}
                          </div>
                        )}
                      </td>
                      <td data-label={t(PF_COL_NAME)} className="cell-ellipsis" title={row.name}>
                        {row.name}
                      </td>
                      <td data-label={t(PF_COL_LISTEN)}>
                        <MonoId value={row.listenAddr} />
                      </td>
                      <td data-label={t(PF_COL_NODE)}>
                        <div className="pf-node-cell">
                          <span className="mono">{row.nodeId}</span>
                          {nodes !== undefined && <Badge tone={nodeBadgeTone}>{nodeBadgeLabel}</Badge>}
                        </div>
                      </td>
                      <td data-label={t(PF_COL_TARGET)}>
                        <MonoId value={row.targetAddr} />
                      </td>
                      <td data-label={t(PF_COL_CONNS)} className="mono">
                        {row.activeConnections} / {row.totalConnections}
                      </td>
                      <td data-label={t(PF_COL_ACTIONS)} className="cell-actions">
                        <div
                          className="row-actions-group"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <Switch
                            checked={row.enabled}
                            disabled={actions.pending}
                            aria-label={`${t(PF_TOGGLE_ENABLE)}: ${row.name}`}
                            onChange={(checked) => handleToggleRule(row, checked)}
                          />
                          <IconButton
                            icon="edit"
                            size="xs"
                            label={t(PF_EDIT)}
                            disabled={actions.pending}
                            onClick={() => openEditDrawer(row.id)}
                          />
                          <IconButton
                            icon="trash-2"
                            size="xs"
                            variant="ghost"
                            label={t(PF_DELETE)}
                            disabled={actions.pending}
                            pending={actions.pendingKey === `delete:${row.id}`}
                            onClick={() => setPendingDelete(row)}
                          />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </DataTable>
          </div>
        )}
      </ScreenSection>

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
