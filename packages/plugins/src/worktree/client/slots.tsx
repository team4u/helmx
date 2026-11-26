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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  CopyButton,
  HelmxIcon,
  IconButton,
  KvGrid,
  Stack,
  resolveLocalizedText,
  usePluginContext,
  usePluginLocale,
} from '@helmx/plugin-client'
import {
  WT_COPY,
  buildWorktreeReviewRequest,
  buildWorktreeSelector,
  isWorktreeUsageUnverifiableError,
  parseWorktreeInspectResult,
  wtAheadCount,
  wtBaseValue,
  wtBranchMismatchTitle,
  wtCleanupDone,
  wtCleanupFailed,
  wtCleanupUnverifiedDone,
  wtDiffStatSection,
  wtDirtyCount,
  wtInspectFailed,
  wtSubmitFailed,
  wtUnavailableCta,
  wtUnverifiedConfirmDesc,
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
  const worktreeId = worktree?.id
  const worktreePath = worktree?.path
  const targetKey = worktreePath === undefined ? '' : `${worktreeId ?? ''}\u0000${worktreePath}\u0000${props.nodeId ?? ''}`

  const [open, setOpen] = useState(false)
  const [loadingKey, setLoadingKey] = useState<string | undefined>(undefined)
  const [errorState, setErrorState] = useState<{ key: string; message: string } | undefined>(undefined)
  const [dataState, setDataState] = useState<{ key: string; view: WorktreeInspectView } | undefined>(undefined)
  const [sending, setSending] = useState(false)
  const generation = useRef(0)
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const localeRef = useRef(locale)
  localeRef.current = locale

  const loading = targetKey !== '' && loadingKey === targetKey
  const error = targetKey !== '' && errorState?.key === targetKey ? errorState.message : undefined
  const data = targetKey !== '' && dataState?.key === targetKey ? dataState.view : undefined

  const load = useCallback(async (): Promise<void> => {
    if (worktreePath === undefined || targetKey === '') return
    const current = ++generation.current
    setLoadingKey(targetKey)
    setErrorState(undefined)
    try {
      const selector = buildWorktreeSelector({ id: worktreeId, path: worktreePath }, props.nodeId)
      const raw = await ctxRef.current.callAction('inspect_worktree', selector, {
        pluginId: 'builtin:worktree',
      })
      if (generation.current !== current) return
      const parsed = parseWorktreeInspectResult(raw)
      if (parsed === undefined) {
        setErrorState({ key: targetKey, message: resolveLocalizedText(WT_COPY.inspectInvalid, localeRef.current) })
      } else {
        setDataState({ key: targetKey, view: parsed })
      }
    } catch (err) {
      if (generation.current !== current) return
      setErrorState({ key: targetKey, message: err instanceof Error ? err.message : String(err) })
    } finally {
      if (generation.current === current) {
        setLoadingKey((cur) => (cur === targetKey ? undefined : cur))
      }
    }
  }, [worktreeId, worktreePath, props.nodeId, targetKey])

  useEffect(() => {
    generation.current += 1
    setDataState((cur) => (cur?.key === targetKey ? cur : undefined))
    setErrorState((cur) => (cur?.key === targetKey ? cur : undefined))
    setLoadingKey((cur) => (cur === targetKey ? cur : undefined))
    return () => {
      generation.current += 1
    }
  }, [targetKey])

  useEffect(() => {
    // Fetch on first expansion only; re-expansions reuse the cached view.
    if (worktreePath !== undefined && open && data === undefined && error === undefined && !loading) {
      void load()
    }
  }, [worktreePath, open, data, error, loading, load])

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
        <Button
          variant="ghost"
          size="xs"
          icon={open ? 'chevron-down' : 'chevron-right'}
          onClick={() => setOpen((v) => !v)}
          title={resolveLocalizedText(open ? WT_COPY.collapseTitle : WT_COPY.expandTitle, locale)}
        >
          <Stack direction="horizontal" gap="xs" align="center" inline>
            <HelmxIcon name="git-branch" size={11} />
            <span>{resolveLocalizedText(WT_COPY.overview, locale)}</span>
          </Stack>
        </Button>
        {open && data !== undefined ? (
          <Button
            variant="ghost"
            size="xs"
            icon="rotate-cw"
            pending={loading}
            onClick={() => void load()}
            title={resolveLocalizedText(WT_COPY.reinspectTitle, locale)}
          >
            {resolveLocalizedText(WT_COPY.refresh, locale)}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="worktree-inspect-body">
          {loading && data === undefined ? (
            <div className="worktree-inspect-empty">{resolveLocalizedText(WT_COPY.inspecting, locale)}</div>
          ) : null}
          {error !== undefined ? (
            <Callout tone="err">
              <Stack gap="xs" align="start">
                <div>{wtInspectFailed(error, locale)}</div>
                <Button size="xs" onClick={() => void load()}>
                  {resolveLocalizedText(WT_COPY.retry, locale)}
                </Button>
              </Stack>
            </Callout>
          ) : null}
          {data !== undefined ? (
            <>
              {unavailableText !== undefined ? (
                <Callout tone="warn">{wtUnavailableCta(unavailableText, locale)}</Callout>
              ) : null}
              <KvGrid
                items={[
                  {
                    key: resolveLocalizedText(WT_COPY.kvBranch, locale),
                    value: (
                      <span className="mono">
                        {data.currentBranch ?? data.branch}
                        {data.branchChanged === true ? (
                          <Badge tone="warn" title={wtBranchMismatchTitle(data.branch, locale)}>
                            {resolveLocalizedText(WT_COPY.branchMismatch, locale)}
                          </Badge>
                        ) : null}
                      </span>
                    ),
                  },
                  {
                    key: resolveLocalizedText(WT_COPY.kvBase, locale),
                    value: (
                      <span className="mono" title={data.baseCommit !== '' ? data.baseCommit : undefined}>
                        {data.baseCommit !== ''
                          ? wtBaseValue(data.baseCommit, data.diffBase, locale)
                          : resolveLocalizedText(WT_COPY.noBase, locale)}
                      </span>
                    ),
                  },
                  {
                    key: resolveLocalizedText(WT_COPY.kvDirty, locale),
                    value: wtDirtyCount(data.dirtyFileCount, data.dirtyFilesTruncated, locale),
                  },
                  ...(data.commitsAhead !== undefined
                    ? [{ key: resolveLocalizedText(WT_COPY.kvAhead, locale), value: wtAheadCount(data.commitsAhead, locale) }]
                    : []),
                  ...(data.currentHead !== undefined
                    ? [{ key: resolveLocalizedText(WT_COPY.kvHead, locale), value: <span className="mono">{data.currentHead.slice(0, 12)}</span> }]
                    : []),
                ]}
              />
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
                      <Badge tone="neutral">{resolveLocalizedText(WT_COPY.diffTruncated, locale)}</Badge>
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
          <Stack direction="horizontal" gap="xs" align="center" wrap>
            <Button
              size="xs"
              icon="git-pull-request"
              pending={sending}
              onClick={sendReview}
              title={resolveLocalizedText(WT_COPY.reviewTitle, locale)}
            >
              {resolveLocalizedText(WT_COPY.reviewButton, locale)}
            </Button>
            <CopyButton text={reviewText} label={resolveLocalizedText(WT_COPY.copyReview, locale)} />
          </Stack>
        </div>
      ) : null}
    </div>
  )
}

export function WorktreeCleanupSlot(props: WorktreeCleanupSlotProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const [cleaning, setCleaning] = useState(false)
  const [unverifiedDetail, setUnverifiedDetail] = useState<string | undefined>(undefined)
  const { worktree, nodeId, compact } = props
  if (worktree === undefined) return null

  const runCleanup = (allowUnverifiedUsage: boolean): void => {
    if (cleaning) return
    setCleaning(true)
    ctx
      .callAction(
        'cleanup_worktree',
        {
          ...buildWorktreeSelector(worktree, nodeId),
          ...(allowUnverifiedUsage ? { allowUnverifiedUsage: true } : {}),
        },
        { pluginId: 'builtin:worktree' },
      )
      .then(() =>
        ctx.notify(
          allowUnverifiedUsage
            ? wtCleanupUnverifiedDone(worktree.branch, locale)
            : wtCleanupDone(worktree.branch, locale),
        ),
      )
      .catch((err: unknown) => {
        if (!allowUnverifiedUsage && isWorktreeUsageUnverifiableError(err)) {
          setUnverifiedDetail(err instanceof Error ? err.message : String(err))
          return
        }
        ctx.notify(wtCleanupFailed(err instanceof Error ? err.message : String(err), locale), 'error')
      })
      .finally(() => setCleaning(false))
  }

  const handleCleanup = (e: MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation()
    runCleanup(false)
  }

  const trigger =
    compact === true ? (
      <IconButton
        variant="default"
        size="xs"
        icon="trash-2"
        pending={cleaning}
        className="worktree-cleanup-compact"
        label={resolveLocalizedText(WT_COPY.cleanupAria, locale)}
        title={resolveLocalizedText(WT_COPY.cleanupTitle, locale)}
        onClick={handleCleanup}
      />
    ) : (
      <Button
        variant="default"
        size="xs"
        icon="trash-2"
        pending={cleaning}
        onClick={handleCleanup}
      >
        {resolveLocalizedText(WT_COPY.cleanupLabel, locale)}
      </Button>
    )

  return (
    <>
      {trigger}
      <ConfirmDialog
        open={unverifiedDetail !== undefined}
        onOpenChange={(open) => {
          if (!open) setUnverifiedDetail(undefined)
        }}
        title={resolveLocalizedText(WT_COPY.unverifiedConfirmTitle, locale)}
        description={wtUnverifiedConfirmDesc(worktree.branch, unverifiedDetail ?? '', locale)}
        confirmText={resolveLocalizedText(WT_COPY.unverifiedConfirmButton, locale)}
        cancelText={resolveLocalizedText(WT_COPY.unverifiedCancelButton, locale)}
        danger
        pending={cleaning}
        onConfirm={() => {
          setUnverifiedDetail(undefined)
          runCleanup(true)
        }}
        onCancel={() => setUnverifiedDetail(undefined)}
      />
    </>
  )
}
