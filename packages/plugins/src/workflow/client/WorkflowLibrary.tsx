/**
 * Workflow Library fullscreen view (`screen` extension point) + right DetailDrawer.
 * Built 100% on `@helmx/plugin-client` primitives: Screen, ScreenSection,
 * ScreenToolbar, SearchBox, DetailDrawer, KvGrid, Select, ConfirmDialog,
 * CopyButton, EmptyState, LoadingState, Callout, and usePluginAction.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ScreenProps } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  CopyButton,
  DetailDrawer,
  EmptyState,
  HelmxIcon,
  Input,
  KvGrid,
  List,
  ListRow,
  LoadingState,
  Screen,
  ScreenToolbar,
  SearchBox,
  Select,
  formatBytes,
  formatTime,
  resolveLocalizedText,
  useConversations,
  usePluginAction,
  usePluginContext,
  usePluginLocale,
  useScreenDrawer,
} from '@helmx/plugin-client'
import {
  COPY,
  SPIN_CLASS,
  actionFailedNotice,
  libDeleteConfirmDesc,
  libDeletedNotice,
  libDetailInvalid,
  libMetadataErrorText,
  libNoMatch,
  libPhasesSummary,
  libPickConversationFirst,
  libRunStarted,
  libSubtitle,
} from './copy.js'
import { useWorkflowLibrary } from './hooks.js'
import {
  buildWorkflowEditRequest,
  buildWorkflowRunTargetOptions,
  filterSavedWorkflows,
  firstLineOf,
  parseWorkflowArgsInput,
  parseWorkflowDetail,
  type SavedWorkflowDetailView,
  type SavedWorkflowView,
} from './parsers.js'

export interface WorkflowLibraryScreenProps extends ScreenProps {
  inlineDrawer?: boolean
}

function WorkflowLibraryDrawer(props: {
  item: SavedWorkflowView
  inline?: boolean
  onClose: () => void
  onDeleted: () => void
}): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)
  const { item, onClose, onDeleted } = props

  const [detail, setDetail] = useState<SavedWorkflowDetailView | undefined>(undefined)
  const [detailError, setDetailError] = useState<string | undefined>(undefined)
  const [detailLoading, setDetailLoading] = useState(true)
  const [argsDraft, setArgsDraft] = useState('')
  const [argsError, setArgsError] = useState<string | undefined>(undefined)
  const [conversationId, setConversationId] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const generation = useRef(0)
  const conversations = useConversations()

  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const localeRef = useRef(locale)
  localeRef.current = locale

  const runCtl = usePluginAction({
    notifyError: true,
    formatError: (err) => actionFailedNotice(t(COPY.run), err instanceof Error ? err.message : String(err), locale),
  })
  const deleteCtl = usePluginAction({
    formatError: (err) => actionFailedNotice(t(COPY.delete), err instanceof Error ? err.message : String(err), locale),
  })
  const clearDeleteErrorRef = useRef(deleteCtl.clearError)
  clearDeleteErrorRef.current = deleteCtl.clearError

  const loadDetail = useCallback(async (): Promise<void> => {
    const current = ++generation.current
    setDetailLoading(true)
    setDetailError(undefined)
    try {
      const raw = await ctxRef.current.callAction('get', { name: item.name })
      if (generation.current !== current) return
      const parsed = parseWorkflowDetail(raw)
      if (parsed === undefined) setDetailError(libDetailInvalid(localeRef.current))
      else setDetail(parsed)
    } catch (err) {
      if (generation.current !== current) return
      setDetailError(err instanceof Error ? err.message : String(err))
    } finally {
      if (generation.current === current) setDetailLoading(false)
    }
  }, [item.name])

  useEffect(() => {
    setDetail(undefined)
    setDetailError(undefined)
    setDetailLoading(true)
    setArgsDraft('')
    setArgsError(undefined)
    setConversationId('')
    setConfirmOpen(false)
    clearDeleteErrorRef.current()
    void loadDetail()
  }, [item.name, loadDetail])

  const conversationOptions = useMemo(() => buildWorkflowRunTargetOptions(conversations), [conversations])
  const editRequestText = useMemo(
    () => buildWorkflowEditRequest(item.name, { description: detail?.description }, locale),
    [item.name, detail?.description, locale],
  )

  const handleRun = (): void => {
    if (conversationId === '') {
      setArgsError(libPickConversationFirst(locale))
      return
    }
    const parsed = parseWorkflowArgsInput(argsDraft, locale)
    if (!parsed.ok) {
      setArgsError(parsed.error)
      return
    }
    setArgsError(undefined)
    void runCtl.run(
      'run',
      {
        name: item.name,
        conversationId: Number(conversationId),
        ...(parsed.args !== undefined ? { args: parsed.args } : {}),
      },
      {
        onSuccess: () => ctx.notify(libRunStarted(item.name, conversationId, locale)),
      },
    )
  }

  const handleDelete = (): void => {
    void deleteCtl.run(
      'delete',
      { name: item.name },
      {
        onSuccess: () => {
          ctx.notify(libDeletedNotice(item.name, locale))
          setConfirmOpen(false)
          onDeleted()
        },
      },
    )
  }

  const phases = detail?.phases ?? item.phases
  const kvItems: Array<{ key: ReactNode; value: ReactNode }> = [
    { key: t(COPY.libKvDescription), value: detail?.description ?? item.description ?? '—' },
    ...((detail?.whenToUse ?? item.whenToUse) !== undefined
      ? [{ key: t(COPY.libKvWhenToUse), value: detail?.whenToUse ?? item.whenToUse }]
      : []),
    {
      key: t(COPY.libKvPhases),
      value: phases ? phases.map((p) => p.title).join(' → ') : t(COPY.libPhasesUndeclared),
    },
  ]

  return (
    <>
      <DetailDrawer
        open
        inline={props.inline}
        onClose={onClose}
        className="wf-lib-drawer"
        title={item.name}
        titleExtra={
          <>
            <Badge tone="neutral" className="tabular-nums">{formatBytes(item.size)}</Badge>
            <Badge tone="neutral" className="tabular-nums">{formatTime(item.updatedAt)}</Badge>
            {item.metadataError ? <Badge tone="warn">{t(COPY.libMetadataBadge)}</Badge> : null}
          </>
        }
        icon={<HelmxIcon name="workflow" size={18} />}
        meta={item.path ?? item.name}
        closeLabel={t(COPY.close)}
        footer={
          <>
            <Button
              variant="danger"
              size="sm"
              icon="trash-2"
              pending={deleteCtl.pending}
              onClick={() => setConfirmOpen(true)}
            >
              {t(COPY.delete)}
            </Button>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t(COPY.close)}
            </Button>
          </>
        }
      >
        {item.metadataError ? <Callout tone="warn">{libMetadataErrorText(item.metadataError, locale)}</Callout> : null}

        <KvGrid items={kvItems} />

        <div className="wf-drawer-section">
          <div className="wf-section-head">
            <span className="trace-section-label">{t(COPY.libSourceSection)}</span>
            <Button
              variant="ghost"
              size="xs"
              icon={<HelmxIcon name="rotate-cw" size={11} className={detailLoading ? SPIN_CLASS : undefined} />}
              disabled={detailLoading}
              onClick={() => void loadDetail()}
            >
              {t(COPY.refresh)}
            </Button>
          </div>
          {detailLoading && detail === undefined ? <LoadingState label={t(COPY.loading)} /> : null}
          {detailError ? (
            <Callout tone="err">
              <div>{detailError}</div>
              <Button size="xs" onClick={() => void loadDetail()}>
                {t(COPY.retry)}
              </Button>
            </Callout>
          ) : null}
          {detail !== undefined ? (
            <>
              <pre className="code-block-pre wf-lib-source selectable">
                <code>{detail.script}</code>
              </pre>
              <CopyButton text={detail.script} label={t(COPY.libCopySource)} />
            </>
          ) : null}
        </div>

        <div className="wf-drawer-section">
          <div className="trace-section-label">{t(COPY.libRunSection)}</div>
          <div className="wf-lib-run-row">
            <div className="wf-lib-run-select">
              <Select
                value={conversationId}
                options={conversationOptions}
                onChange={(e) => setConversationId(e.target.value)}
                placeholder={t(COPY.libRunSelectPlaceholder)}
                aria-label={t(COPY.libRunSelectAria)}
              />
            </div>
            <Input
              type="text"
              className="wf-lib-args"
              invalid={argsError !== undefined}
              placeholder={t(COPY.libArgsPlaceholder)}
              value={argsDraft}
              onChange={(e) => {
                setArgsDraft(e.target.value)
                setArgsError(undefined)
              }}
            />
            <Button
              variant="primary"
              size="md"
              icon="play"
              pending={runCtl.pending}
              disabled={conversationOptions.length === 0}
              title={conversationOptions.length === 0 ? t(COPY.libNoConversations) : undefined}
              onClick={handleRun}
            >
              {t(COPY.run)}
            </Button>
          </div>
          {argsError ? <Callout tone="err">{argsError}</Callout> : null}
        </div>

        <div className="wf-drawer-section">
          <div className="trace-section-label">{t(COPY.libEditSection)}</div>
          <div className="wf-muted-note">{t(COPY.libEditHint)}</div>
          <pre className="code-block-pre wf-pre selectable">
            <code>{editRequestText}</code>
          </pre>
          <CopyButton text={editRequestText} label={t(COPY.libCopyEdit)} />
        </div>

        {deleteCtl.error ? <Callout tone="err">{deleteCtl.error}</Callout> : null}
      </DetailDrawer>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        inline={props.inline}
        danger
        pending={deleteCtl.pending}
        title={t(COPY.libDeleteTitle)}
        description={libDeleteConfirmDesc(item.name, locale)}
        confirmText={deleteCtl.pending ? t(COPY.deleting) : t(COPY.libDeleteConfirmBtn)}
        cancelText={t(COPY.cancel)}
        onConfirm={handleDelete}
      />
    </>
  )
}

export function WorkflowLibraryScreen(props: WorkflowLibraryScreenProps): ReactNode {
  const { items, error, loading, reload } = useWorkflowLibrary()
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)

  const queryParam = props.params['q'] ?? ''
  const [queryDraft, setQueryDraft] = useState(queryParam)
  useEffect(() => {
    setQueryDraft(queryParam)
  }, [queryParam])

  const drawer = useScreenDrawer({
    param: 'wf',
    hasItem: (name) => items === undefined || items.some((i) => i.name === name),
    scope: props,
  })
  const selectedName = drawer.itemId
  const selectedItem = selectedName !== undefined ? items?.find((i) => i.name === selectedName) : undefined
  const filtered = useMemo(() => (items === undefined ? undefined : filterSavedWorkflows(items, queryDraft)), [items, queryDraft])

  return (
    <Screen
      layout="contained"
      className="wf-lib-screen"
      title={t(COPY.libTitle)}
      actions={
        <Button
          variant="secondary"
          size="sm"
          icon={<HelmxIcon name="rotate-cw" size={12} className={loading ? SPIN_CLASS : undefined} />}
          disabled={loading}
          onClick={() => void reload()}
        >
          <span className="pane-action-label">{t(COPY.refresh)}</span>
        </Button>
      }
      toolbar={
        <ScreenToolbar
          label={t(COPY.libSearchAria)}
          actions={
            <SearchBox
              variant="toolbar"
              size="sm"
              value={queryDraft}
              onChange={(value) => {
                setQueryDraft(value)
                props.setParams({ q: value === '' ? undefined : value })
              }}
              placeholder={t(COPY.libSearchPlaceholder)}
              ariaLabel={t(COPY.libSearchAria)}
            />
          }
        >
          <span className="text-muted tabular-nums wf-lib-count">
            {libSubtitle(items?.length ?? 0, locale)}
          </span>
        </ScreenToolbar>
      }
    >
      {loading && items === undefined ? <LoadingState label={t(COPY.loading)} /> : null}
      {error ? (
        <Callout tone="err">
          <div>{error}</div>
          <Button variant="secondary" size="xs" onClick={() => void reload()}>
            {t(COPY.retry)}
          </Button>
        </Callout>
      ) : null}
      {items !== undefined && items.length === 0 && !error ? (
        <EmptyState
          icon={<HelmxIcon name="workflow" size={20} />}
          title={t(COPY.libEmptyTitle)}
          hint={t(COPY.libEmptyHint)}
        />
      ) : null}
      {filtered !== undefined && filtered.length === 0 && queryDraft.trim() !== '' ? (
        <EmptyState compact title={libNoMatch(queryDraft.trim(), locale)} />
      ) : null}

      {filtered !== undefined && filtered.length > 0 ? (
        <List label={t(COPY.libTitle)}>
          {filtered.map((item) => (
            <ListRow
              key={item.name}
              data-workflow-name={item.name}
              selected={selectedName === item.name}
              tone={item.metadataError ? 'warn' : 'default'}
              leading={<HelmxIcon name="workflow" size={14} className="text-muted" />}
              title={
                <span className="mono" title={item.path ?? item.name}>
                  {item.name}
                </span>
              }
              meta={
                item.metadataError ? (
                  <Badge tone="warn">{t(COPY.libMetadataBadge)}</Badge>
                ) : item.phases ? (
                  <Badge tone="neutral" title={item.phases.map((p) => p.title).join(' → ')}>
                    {libPhasesSummary(item.phases.length, item.phases.map((p) => p.title).join(' / '), locale)}
                  </Badge>
                ) : undefined
              }
              description={
                item.metadataError ? (
                  <span className="wf-lib-row-warn">
                    {libMetadataErrorText(firstLineOf(item.metadataError, 120), locale)}
                  </span>
                ) : item.description ? (
                  firstLineOf(item.description, 140)
                ) : (
                  t(COPY.libNoDescription)
                )
              }
              trailing={
                <span className="wf-lib-row-facts tabular-nums">
                  {formatTime(item.updatedAt)} · {formatBytes(item.size)}
                </span>
              }
              onSelect={() => drawer.openItem(item.name)}
            />
          ))}
        </List>
      ) : null}

      {selectedItem !== undefined ? (
        <WorkflowLibraryDrawer
          item={selectedItem}
          inline={props.inlineDrawer}
          onClose={() => drawer.close()}
          onDeleted={() => {
            void reload()
            drawer.close()
          }}
        />
      ) : null}
    </Screen>
  )
}
