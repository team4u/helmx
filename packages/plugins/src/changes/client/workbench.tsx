/**
 * Conversation right-hand Workbench `Changes` panel (`workbenchPanel` id `'changes'`).
 * Read-only preview: lazy-loads workspace summary on mount, auto-refreshes when the
 * conversation round settles, and opens the Changes Inspector on demand.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import './styles.css'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { WorkbenchPanelProps } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  HelmxIcon,
  LoadingState,
  Stack,
  resolveLocalizedText,
  useConversation,
  usePluginContext,
  usePluginLocale,
  usePlugins,
  type LocalizedText,
} from '@helmx/plugin-client'
import type { WorkspaceInspectResult } from '../../contracts-types.js'
import { CHG_COPY, chgSummaryText, chgUnpushedBadge } from './copy.ts'
import {
  buildChangesScreenTarget,
  parseWorkspaceInspectResult,
  parseWorktreeListResult,
  splitFilePath,
  type ManagedWorktreeSummaryView,
} from './diff-model.ts'

export function ChangesWorkbenchPanel(props: Partial<WorkbenchPanelProps>): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = (text: LocalizedText): string => resolveLocalizedText(text, locale)
  const conversationId = props.conversation?.id ?? ctx.conversationId
  const { plugins } = usePlugins()
  const worktreeEnabled = useMemo(
    () => plugins.some((p) => p.id === 'builtin:worktree' && p.enabled && (p.status === undefined || p.status === 'active')),
    [plugins],
  )

  const conv = useConversation(conversationId, { includeDetail: false })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [workspace, setWorkspace] = useState<WorkspaceInspectResult | undefined>(undefined)
  const [worktrees, setWorktrees] = useState<ManagedWorktreeSummaryView[]>([])
  const [refreshSeq, setRefreshSeq] = useState(0)

  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const loadGen = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    if (conversationId === undefined) return
    const gen = ++loadGen.current
    setLoading(true)
    setError(undefined)
    try {
      const [wsRaw, wtRaw] = await Promise.all([
        ctxRef.current.callAction('inspect_workspace', { conversationId, scope: 'working' }),
        worktreeEnabled
          ? ctxRef.current.callAction('list_worktrees', {}, { pluginId: 'builtin:worktree' }).catch(() => ({ worktrees: [] }))
          : Promise.resolve({ worktrees: [] }),
      ])
      if (loadGen.current !== gen) return
      const parsed = parseWorkspaceInspectResult(wsRaw)
      if (parsed === undefined) {
        setError('Invalid inspect_workspace response')
      } else {
        setWorkspace(parsed)
      }
      const allWt = parseWorktreeListResult(wtRaw)
      setWorktrees(
        allWt.filter(
          (w) => w.status === 'active' && (w.parentConversationId === conversationId || w.conversationId === conversationId),
        ),
      )
    } catch (err) {
      if (loadGen.current !== gen) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (loadGen.current === gen) {
        setLoading(false)
      }
    }
  }, [conversationId, worktreeEnabled])

  useEffect(() => {
    void load()
    return () => {
      loadGen.current += 1
    }
  }, [load, refreshSeq])

  const prevWatchedRef = useRef<{ id?: number; status?: string; completionSeq?: number }>({})
  useEffect(() => {
    const summary = conv.summary
    if (conversationId === undefined || summary === undefined) return
    const prev = prevWatchedRef.current
    if (prev.id === conversationId) {
      const settled =
        ((prev.status === 'working' || prev.status === 'blocked') &&
          (summary.status === 'idle' || summary.status === 'done' || summary.status === 'error')) ||
        (prev.completionSeq !== undefined && summary.completionSeq > prev.completionSeq)
      if (settled) setRefreshSeq((n) => n + 1)
    }
    prevWatchedRef.current = {
      id: conversationId,
      status: summary.status,
      completionSeq: summary.completionSeq,
    }
  }, [conversationId, conv.summary])

  if (conversationId === undefined) {
    return (
      <div className="chg-wb-panel">
        <EmptyState compact title={t(CHG_COPY.noTargetTitle)} />
      </div>
    )
  }

  return (
    <div className="chg-wb-panel">
      <div className="chg-wb-head">
        <div className="chg-wb-title-row">
          <HelmxIcon name="file-diff" size={13} />
          <span className="chg-wb-title">{t(CHG_COPY.workbenchWorkspaceTitle)}</span>
          {workspace?.isGitRepo ? (
            <Badge tone="neutral" icon="git-branch" className="mono">
              {workspace.currentBranch}
            </Badge>
          ) : null}
        </div>
        <Stack direction="horizontal" gap="xs" align="center">
          <Button
            size="xs"
            variant="secondary"
            icon="file-diff"
            onClick={() => ctx.openSplitScreen(buildChangesScreenTarget({ conv: conversationId }))}
          >
            {t(CHG_COPY.openChanges)}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            icon="rotate-cw"
            pending={loading}
            onClick={() => setRefreshSeq((n) => n + 1)}
          >
            {t(CHG_COPY.refresh)}
          </Button>
        </Stack>
      </div>

      {loading && workspace === undefined ? (
        <LoadingState label={t(CHG_COPY.loadingSummary)} />
      ) : error !== undefined ? (
        <Callout tone="err">
          <Stack gap="xs" align="start">
            <div className="break-word">{error}</div>
            <Button size="xs" icon="rotate-cw" onClick={() => setRefreshSeq((n) => n + 1)}>
              {t(CHG_COPY.retry)}
            </Button>
          </Stack>
        </Callout>
      ) : workspace !== undefined && !workspace.isGitRepo ? (
        <EmptyState
          compact
          icon="folder"
          title={t(CHG_COPY.notGitTitle)}
          hint={workspace.nonGitReason === 'bare_repository' ? t(CHG_COPY.bareRepoBody) : t(CHG_COPY.notGitBody)}
        />
      ) : workspace !== undefined && workspace.isGitRepo ? (
        <div className="chg-wb-section">
          <div className="chg-wb-stats-row">
            <span className="mono tabular-nums text-muted">
              {chgSummaryText(
                workspace.summary.totalFiles,
                workspace.summary.additions,
                workspace.summary.deletions,
                locale,
              )}
            </span>
            {workspace.commitsAheadOfUpstream !== undefined && workspace.commitsAheadOfUpstream > 0 ? (
              <Badge tone="accent">{chgUnpushedBadge(workspace.commitsAheadOfUpstream, locale)}</Badge>
            ) : null}
          </div>

          {workspace.files.length === 0 ? (
            <EmptyState
              compact
              title={t(CHG_COPY.workbenchNoChanges)}
              action={
                workspace.commits.length > 0 ? (
                  <Button
                    size="xs"
                    icon="git-commit"
                    onClick={() =>
                      ctx.openSplitScreen(
                        buildChangesScreenTarget({
                          conv: conversationId,
                          scope: 'commit',
                          commit: workspace.commits[0]!.oid,
                        }),
                      )
                    }
                  >
                    {t(CHG_COPY.workbenchViewCommits)}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="chg-wb-files">
              {workspace.files.slice(0, 60).map((f) => {
                const { dir, name } = splitFilePath(f.path)
                return (
                  <button
                    key={f.path}
                    type="button"
                    className="chg-file-row"
                    onClick={() =>
                      ctx.openSplitScreen(
                        buildChangesScreenTarget({
                          conv: conversationId,
                          file: f.path,
                        }),
                      )
                    }
                  >
                    <span className={`chg-status-glyph chg-status-${f.status}`}>{f.status}</span>
                    <span className="chg-file-name-wrap" title={f.path}>
                      <span className="chg-file-name">{name}</span>
                      {dir !== '' ? <span className="chg-file-dir mono">{dir}</span> : null}
                    </span>
                    <span className="chg-file-stats mono tabular-nums">
                      {f.binary ? (
                        <span className="text-muted">BIN</span>
                      ) : f.untracked ? (
                        <span className="chg-stat-add">NEW</span>
                      ) : (
                        <>
                          {f.additions > 0 ? <span className="chg-stat-add">{`+${f.additions}`}</span> : null}
                          {f.deletions > 0 ? <span className="chg-stat-del">{`−${f.deletions}`}</span> : null}
                        </>
                      )}
                    </span>
                  </button>
                )
              })}
              {workspace.files.length > 60 || workspace.filesTruncated ? (
                <div className="chg-files-truncated-note">{t(CHG_COPY.workbenchTruncatedHint)}</div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {worktrees.length > 0 ? (
        <div className="chg-wb-section">
          <div className="chg-wb-title-row">
            <HelmxIcon name="git-branch" size={12} />
            <span className="chg-wb-title">{t(CHG_COPY.workbenchWorktreesTitle)}</span>
            <Badge tone="neutral" className="tabular-nums">{worktrees.length}</Badge>
          </div>
          <div className="chg-wb-worktrees">
            {worktrees.map((wt) => (
              <div key={wt.id} className="chg-wb-wt-row">
                <div className="chg-wb-wt-meta">
                  <span className="mono chg-wb-wt-branch" title={`${wt.branch} · ${wt.path}`}>{wt.branch}</span>
                  <Badge tone="neutral" className="mono">{wt.nodeId}</Badge>
                </div>
                <Button
                  size="xs"
                  variant="secondary"
                  icon="file-diff"
                  onClick={() => ctx.openSplitScreen(buildChangesScreenTarget({ wt: wt.id }))}
                >
                  {t(CHG_COPY.viewChanges)}
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
