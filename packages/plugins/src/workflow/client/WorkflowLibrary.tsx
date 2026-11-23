/**
 * Workflow Library fullscreen view (`screen` extension point) + right DetailDrawer.
 * Built 100% on `@helmx/plugin-client` primitives: Screen, ScreenSection,
 * ScreenToolbar, SearchBox, DetailDrawer, KvGrid, Select, ConfirmDialog,
 * CopyButton, EmptyState, LoadingState, Callout, and usePluginAction.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ScreenProps } from '@helmx/protocol'
import {
  Callout,
  ConfirmDialog,
  CopyButton,
  DetailDrawer,
  EmptyState,
  HelmxIcon,
  KvGrid,
  LoadingState,
  Screen,
  ScreenSection,
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

  const runCtl = usePluginAction({
    notifyError: true,
    formatError: (err) => actionFailedNotice(t(COPY.run), err instanceof Error ? err.message : String(err), locale),
  })
  const deleteCtl = usePluginAction({
    formatError: (err) => actionFailedNotice(t(COPY.delete), err instanceof Error ? err.message : String(err), locale),
  })

  const loadDetail = async (): Promise<void> => {
    const current = ++generation.current
    setDetailLoading(true)
    setDetailError(undefined)
    try {
      const raw = await ctx.callAction('get', { name: item.name })
      if (generation.current !== current) return
      const parsed = parseWorkflowDetail(raw)
      if (parsed === undefined) setDetailError(libDetailInvalid(locale))
      else setDetail(parsed)
    } catch (err) {
      if (generation.current !== current) return
      setDetailError(err instanceof Error ? err.message : String(err))
    } finally {
      if (generation.current === current) setDetailLoading(false)
    }
  }

  useEffect(() => {
    setDetail(undefined)
    setDetailError(undefined)
    setDetailLoading(true)
    setArgsDraft('')
    setArgsError(undefined)
    setConversationId('')
    setConfirmOpen(false)
    deleteCtl.clearError()
    void loadDetail()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.name])

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
            <span className="badge badge-neutral tabular-nums">{formatBytes(item.size)}</span>
            <span className="badge badge-neutral tabular-nums">{formatTime(item.updatedAt)}</span>
            {item.metadataError ? <span className="badge badge-warn">{t(COPY.libMetadataBadge)}</span> : null}
          </>
        }
        icon={<HelmxIcon name="workflow" size={18} />}
        meta={item.path ?? item.name}
        closeLabel={t(COPY.close)}
        closeButtonClassName="btn btn-ghost btn-sm"
        closeIcon={<HelmxIcon name="x" size={14} />}
        footer={
          <>
            <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
              {t(COPY.close)}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost btn-danger"
              disabled={deleteCtl.pending}
              onClick={() => setConfirmOpen(true)}
            >
              <HelmxIcon name="trash-2" size={12} />
              <span>{t(COPY.delete)}</span>
            </button>
          </>
        }
      >
        {item.metadataError ? <Callout tone="warn">{libMetadataErrorText(item.metadataError, locale)}</Callout> : null}

        <KvGrid items={kvItems} />

        <div className="wf-drawer-section">
          <div className="wf-section-head">
            <span className="trace-section-label">{t(COPY.libSourceSection)}</span>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={detailLoading}
              onClick={() => void loadDetail()}
            >
              <HelmxIcon name="rotate-cw" size={11} className={detailLoading ? SPIN_CLASS : undefined} />
              <span>{t(COPY.refresh)}</span>
            </button>
          </div>
          {detailLoading && detail === undefined ? <LoadingState label={t(COPY.loading)} /> : null}
          {detailError ? (
            <Callout tone="err">
              <div>{detailError}</div>
              <button type="button" className="btn btn-xs" onClick={() => void loadDetail()}>
                {t(COPY.retry)}
              </button>
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
            <input
              type="text"
              className="wf-lib-args"
              placeholder={t(COPY.libArgsPlaceholder)}
              value={argsDraft}
              onChange={(e) => {
                setArgsDraft(e.target.value)
                setArgsError(undefined)
              }}
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={runCtl.pending || conversationOptions.length === 0}
              title={conversationOptions.length === 0 ? t(COPY.libNoConversations) : undefined}
              onClick={handleRun}
            >
              <HelmxIcon name={runCtl.pending ? 'loader' : 'play'} size={11} className={runCtl.pending ? SPIN_CLASS : undefined} />
              <span>{t(COPY.run)}</span>
            </button>
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

  const selectedName = props.params['wf']
  const selectedItem = selectedName !== undefined ? items?.find((i) => i.name === selectedName) : undefined
  const filtered = useMemo(() => (items === undefined ? undefined : filterSavedWorkflows(items, queryDraft)), [items, queryDraft])

  return (
    <Screen
      className="wf-lib-screen"
      title={
        <span className="wf-lib-title">
          <HelmxIcon name="workflow" size={16} />
          <span>{t(COPY.libTitle)}</span>
        </span>
      }
      subtitle={libSubtitle(items?.length ?? 0, locale)}
      actions={
        <button type="button" className="btn btn-sm" disabled={loading} onClick={() => void reload()}>
          <HelmxIcon name="rotate-cw" size={12} className={loading ? SPIN_CLASS : undefined} />
          <span>{t(COPY.refresh)}</span>
        </button>
      }
    >
      <ScreenSection>
        <ScreenToolbar label={t(COPY.libSearchAria)}>
          <SearchBox
            value={queryDraft}
            onChange={(value) => {
              setQueryDraft(value)
              props.setParams({ q: value === '' ? undefined : value })
            }}
            placeholder={t(COPY.libSearchPlaceholder)}
            ariaLabel={t(COPY.libSearchAria)}
          />
        </ScreenToolbar>

        {loading && items === undefined ? <LoadingState label={t(COPY.loading)} /> : null}
        {error ? (
          <Callout tone="err">
            <div>{error}</div>
            <button type="button" className="btn btn-xs" onClick={() => void reload()}>
              {t(COPY.retry)}
            </button>
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
          <div className="wf-lib-grid">
            {filtered.map((item) => (
              <button
                key={item.name}
                type="button"
                className={`wf-lib-card${item.metadataError ? ' wf-lib-card-warn' : ''}`}
                onClick={() => props.setParams({ wf: item.name })}
              >
                <div className="wf-lib-card-head">
                  <HelmxIcon name="workflow" size={14} />
                  <strong className="wf-lib-card-name" title={item.path ?? item.name}>
                    {item.name}
                  </strong>
                </div>
                {item.metadataError ? (
                  <div className="wf-lib-card-warn-text">{libMetadataErrorText(firstLineOf(item.metadataError, 120), locale)}</div>
                ) : (
                  <>
                    <div className={`wf-lib-card-desc${item.description ? '' : ' wf-lib-card-desc-empty'}`}>
                      {item.description ? firstLineOf(item.description, 140) : t(COPY.libNoDescription)}
                    </div>
                    {item.phases ? (
                      <div className="wf-lib-card-phases" title={item.phases.map((p) => p.title).join(' → ')}>
                        {libPhasesSummary(item.phases.length, item.phases.map((p) => p.title).join(' / '), locale)}
                      </div>
                    ) : null}
                  </>
                )}
                <div className="wf-lib-card-footer">
                  <span className="wf-lib-card-facts tabular-nums">
                    {formatTime(item.updatedAt)} · {formatBytes(item.size)}
                  </span>
                  <HelmxIcon name="chevron-right" size={12} />
                </div>
              </button>
            ))}
          </div>
        ) : null}
      </ScreenSection>

      {selectedItem !== undefined ? (
        <WorkflowLibraryDrawer
          item={selectedItem}
          inline={props.inlineDrawer}
          onClose={() => props.setParams({ wf: undefined })}
          onDeleted={() => {
            void reload()
            props.setParams({ wf: undefined })
          }}
        />
      ) : null}
    </Screen>
  )
}
