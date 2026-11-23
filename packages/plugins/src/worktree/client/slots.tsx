/**
 * builtin:worktree UI slot contributions rendered inside sibling plugins
 * (e.g. builtin:workflow cards & workbench):
 * - WorktreeInspectSlot (`builtin:workflow/worktree-inspect`): collapsible read-only
 *   git inspection + review-request handoff to the parent conversation;
 * - WorktreeCleanupSlot (`builtin:workflow/worktree-cleanup`): managed worktree
 *   cleanup action button.
 *
 * When `builtin:worktree` is disabled, these slots unregister cleanly and render
 * nothing — leaving zero broken worktree actions in `builtin:workflow`.
 * Exports only components and TS types (Fast Refresh compliant).
 */
import './styles-worktree-inspect.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  CopyButton,
  HelmxIcon,
  resolveLocalizedText,
  usePluginContext,
  usePluginLocale,
} from '@helmx/plugin-client'
import {
  WT_COPY,
  WT_SPIN,
  buildWorktreeReviewRequest,
  buildWorktreeSelector,
  parseWorktreeInspectResult,
  wtAheadCount,
  wtBaseValue,
  wtBranchMismatchTitle,
  wtCleanupDone,
  wtCleanupFailed,
  wtDiffStatSection,
  wtDirtyCount,
  wtInspectFailed,
  wtSubmitFailed,
  wtUnavailableCta,
  type WorktreeInspectView,
} from './model-worktree.ts'

export interface WorktreeRef {
  id?: string
  path: string
  branch: string
}

export interface WorktreeInspectSlotProps {
  worktree?: WorktreeRef
  nodeId?: string
  baseCommit?: string
  taskLabel?: string
  parentConversationId?: number
}

export interface WorktreeCleanupSlotProps {
  worktree?: WorktreeRef
  nodeId?: string
  compact?: boolean
}

export function WorktreeInspectSlot(props: WorktreeInspectSlotProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const { worktree, parentConversationId } = props
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [data, setData] = useState<WorktreeInspectView | undefined>(undefined)
  const [sending, setSending] = useState(false)
  const generation = useRef(0)

  const load = async (): Promise<void> => {
    if (worktree === undefined) return
    const current = ++generation.current
    setLoading(true)
    setError(undefined)
    try {
      const raw = await ctx.callAction('inspect_worktree', buildWorktreeSelector(worktree, props.nodeId), {
        pluginId: 'builtin:worktree',
      })
      if (generation.current !== current) return
      const parsed = parseWorktreeInspectResult(raw)
      if (parsed === undefined) {
        setError(resolveLocalizedText(WT_COPY.inspectInvalid, locale))
      } else {
        setData(parsed)
      }
    } catch (err) {
      if (generation.current !== current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (generation.current === current) setLoading(false)
    }
  }

  useEffect(() => {
    // Fetch on first expansion only; re-expansions reuse the cached view.
    if (worktree !== undefined && open && data === undefined && error === undefined && !loading) {
      void load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, worktree?.path, worktree?.id])

  const reviewText = useMemo(
    () =>
      worktree === undefined
        ? ''
        : buildWorktreeReviewRequest(
            {
              path: worktree.path,
              branch: data?.branch ?? worktree.branch,
              nodeId: data?.nodeId ?? props.nodeId,
              baseCommit: data?.baseCommit || props.baseCommit,
              taskLabel: props.taskLabel,
              ...(data !== undefined ? { inspect: data } : {}),
            },
            locale,
          ),
    [worktree, props.nodeId, props.baseCommit, props.taskLabel, data, locale],
  )

  if (worktree === undefined || parentConversationId === undefined) return null

  const sendReview = (): void => {
    setSending(true)
    ctx
      .submitInput(reviewText, { conversationId: parentConversationId, whenBusy: 'steer' })
      .then(() => ctx.notify(resolveLocalizedText(WT_COPY.submitted, locale)))
      .catch((err: unknown) =>
        ctx.notify(wtSubmitFailed(err instanceof Error ? err.message : String(err), locale), 'error'),
      )
      .finally(() => setSending(false))
  }

  const unavailableText =
    data?.unavailableReason === 'removed'
      ? resolveLocalizedText(WT_COPY.unavailableRemoved, locale)
      : data?.unavailableReason === 'directory_missing'
        ? resolveLocalizedText(WT_COPY.unavailableMissing, locale)
        : undefined

  return (
    <div className="worktree-inspect">
      <div className="worktree-inspect-header">
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          onClick={() => setOpen((v) => !v)}
          title={resolveLocalizedText(open ? WT_COPY.collapseTitle : WT_COPY.expandTitle, locale)}
        >
          <HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
          <HelmxIcon name="git-branch" size={11} />
          {resolveLocalizedText(WT_COPY.overview, locale)}
        </button>
        {open && data !== undefined ? (
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            disabled={loading}
            onClick={() => void load()}
            title={resolveLocalizedText(WT_COPY.reinspectTitle, locale)}
          >
            <HelmxIcon name="rotate-cw" size={11} className={loading ? WT_SPIN : undefined} />
            {resolveLocalizedText(WT_COPY.refresh, locale)}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="worktree-inspect-body">
          {loading && data === undefined ? (
            <div className="worktree-inspect-empty">{resolveLocalizedText(WT_COPY.inspecting, locale)}</div>
          ) : null}
          {error !== undefined ? (
            <div className="callout callout--error worktree-inspect-error">
              <div>{wtInspectFailed(error, locale)}</div>
              <button type="button" className="btn btn-xs" onClick={() => void load()}>
                {resolveLocalizedText(WT_COPY.retry, locale)}
              </button>
            </div>
          ) : null}
          {data !== undefined ? (
            <>
              {unavailableText !== undefined ? (
                <div className="callout callout--warning">{wtUnavailableCta(unavailableText, locale)}</div>
              ) : null}
              <div className="kv-grid">
                <span className="kv-key">{resolveLocalizedText(WT_COPY.kvBranch, locale)}</span>
                <span className="kv-val mono">
                  {data.currentBranch ?? data.branch}
                  {data.branchChanged === true ? (
                    <span className="badge badge-warn" title={wtBranchMismatchTitle(data.branch, locale)}>
                      {resolveLocalizedText(WT_COPY.branchMismatch, locale)}
                    </span>
                  ) : null}
                </span>
                <span className="kv-key">{resolveLocalizedText(WT_COPY.kvBase, locale)}</span>
                <span className="kv-val mono" title={data.baseCommit !== '' ? data.baseCommit : undefined}>
                  {data.baseCommit !== ''
                    ? wtBaseValue(data.baseCommit, data.diffBase, locale)
                    : resolveLocalizedText(WT_COPY.noBase, locale)}
                </span>
                <span className="kv-key">{resolveLocalizedText(WT_COPY.kvDirty, locale)}</span>
                <span className="kv-val">{wtDirtyCount(data.dirtyFileCount, data.dirtyFilesTruncated, locale)}</span>
                {data.commitsAhead !== undefined ? (
                  <>
                    <span className="kv-key">{resolveLocalizedText(WT_COPY.kvAhead, locale)}</span>
                    <span className="kv-val">{wtAheadCount(data.commitsAhead, locale)}</span>
                  </>
                ) : null}
                {data.currentHead !== undefined ? (
                  <>
                    <span className="kv-key">{resolveLocalizedText(WT_COPY.kvHead, locale)}</span>
                    <span className="kv-val mono">{data.currentHead.slice(0, 12)}</span>
                  </>
                ) : null}
              </div>
              {data.dirtyFiles.length > 0 ? (
                <pre className="code-block-pre worktree-inspect-files">
                  <code>{data.dirtyFiles.join('\n')}</code>
                </pre>
              ) : data.exists ? (
                <div className="worktree-inspect-empty">{resolveLocalizedText(WT_COPY.noDirty, locale)}</div>
              ) : null}
              {data.exists ? (
                <div className="worktree-inspect-note">{resolveLocalizedText(WT_COPY.diffNote, locale)}</div>
              ) : null}
              {data.diffStat !== undefined ? (
                <div>
                  <div className="trace-section-label">{wtDiffStatSection(data.diffBase, locale)}</div>
                  <pre className="code-block-pre workflow-node-pre">
                    <code>{data.diffStat}</code>
                  </pre>
                </div>
              ) : null}
              {data.diffPreview !== undefined ? (
                <div>
                  <div className="trace-section-label">
                    {resolveLocalizedText(WT_COPY.diffPreviewSection, locale)}
                    {data.diffTruncated ? (
                      <span className="badge badge-neutral">
                        {resolveLocalizedText(WT_COPY.diffTruncated, locale)}
                      </span>
                    ) : null}
                  </div>
                  <pre className="code-block-pre workflow-node-pre worktree-inspect-diff selectable">
                    <code>{data.diffPreview}</code>
                  </pre>
                </div>
              ) : data.exists ? (
                <div className="worktree-inspect-empty">{resolveLocalizedText(WT_COPY.noDiff, locale)}</div>
              ) : null}
            </>
          ) : null}
          <div className="worktree-inspect-actions">
            <button
              type="button"
              className="btn btn-xs"
              disabled={sending}
              onClick={sendReview}
              title={resolveLocalizedText(WT_COPY.reviewTitle, locale)}
            >
              <HelmxIcon name="git-pull-request" size={11} />
              {resolveLocalizedText(WT_COPY.reviewButton, locale)}
            </button>
            <CopyButton text={reviewText} label={resolveLocalizedText(WT_COPY.copyReview, locale)} />
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function WorktreeCleanupSlot(props: WorktreeCleanupSlotProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const [cleaning, setCleaning] = useState(false)
  const { worktree, nodeId, compact } = props
  if (worktree === undefined) return null

  const label = resolveLocalizedText(WT_COPY.cleanupLabel, locale)
  return (
    <button
      type="button"
      className={`btn btn-xs${compact === true ? ' worktree-cleanup-compact' : ''}`}
      disabled={cleaning}
      title={compact === true ? resolveLocalizedText(WT_COPY.cleanupTitle, locale) : undefined}
      aria-label={compact === true ? resolveLocalizedText(WT_COPY.cleanupAria, locale) : undefined}
      onClick={(e) => {
        e.stopPropagation()
        if (cleaning) return
        setCleaning(true)
        ctx
          .callAction('cleanup_worktree', buildWorktreeSelector(worktree, nodeId), { pluginId: 'builtin:worktree' })
          .then(() => ctx.notify(wtCleanupDone(worktree.branch, locale)))
          .catch((err: unknown) =>
            ctx.notify(wtCleanupFailed(err instanceof Error ? err.message : String(err), locale), 'error'),
          )
          .finally(() => setCleaning(false))
      }}
    >
      <HelmxIcon name={cleaning ? 'loader' : 'trash-2'} size={11} className={cleaning ? WT_SPIN : undefined} />
      {compact === true ? null : label}
    </button>
  )
}
