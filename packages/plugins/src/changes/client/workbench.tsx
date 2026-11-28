/**
 * Conversation right-hand Workbench `Changes` panel (`workbenchPanel` id `'changes'`).
 * In-place read-only Git diff workflow:
 * - Single compact scope bar (`SegmentedControl`) + Refresh / Split Expand icon actions;
 * - Scopes target switching strictly to the current conversation workspace & its active worktrees
 *   (hides the target selector completely when no worktrees exist);
 * - Single-open accordion rows expand on-demand colored single-file diffs right inside the drawer;
 * - Auto-refreshes when the conversation round settles and closes the drawer cleanly before opening split view.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import './styles.css'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { WorkbenchPanelProps } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  Callout,
  CopyButton,
  EmptyState,
  HelmxIcon,
  IconButton,
  LoadingState,
  SearchBox,
  SegmentedControl,
  Select,
  Stack,
  formatCompactTimestamp,
  resolveLocalizedText,
  type LocalizedText,
  type SelectOption,
} from '@helmx/ui'
import {
  useConversation,
  usePluginContext,
  usePluginLocale,
  usePlugins,
} from '@helmx/plugin-client'
import type {
  GitDiffFileResult,
  WorkspaceDiffScope,
  WorkspaceInspectResult,
  WorktreeDiffScope,
} from '../../contracts-types.js'
import {
  CHG_COPY,
  chgCommitsAheadBadge,
  chgSummaryText,
  chgUnmergedBadge,
  chgUnpushedBadge,
  chgUntrackedBadge,
} from './copy.ts'
import { DiffContent } from './DiffViewer.tsx'
import {
  buildChangesScreenTarget,
  buildFileCacheKey,
  filterFiles,
  normalizeWorkspaceScopeParam,
  normalizeWorktreeScopeParam,
  parseGitDiffFileResult,
  parseWorkspaceInspectResult,
  parseWorktreeInspectResult,
  parseWorktreeListResult,
  splitFilePath,
  type ManagedWorktreeSummaryView,
  type WorktreeInspectView,
} from './diff-model.ts'

const ALL_COMMITTED_VALUE = '__all__'
const CURRENT_WORKSPACE_VALUE = '__workspace__'
const MAX_WORKBENCH_FILES = 100

function readNonEmptyString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed !== '' ? trimmed : undefined
}

interface ParsedWorkbenchParams {
  wt?: string
  workspaceScope: WorkspaceDiffScope
  worktreeScope: WorktreeDiffScope
  commit?: string
  file?: string
}

function readWorkbenchChangesParams(params: Readonly<Record<string, unknown>> | undefined): ParsedWorkbenchParams {
  const wt = readNonEmptyString(params?.['wt'])
  const rawScope = typeof params?.['scope'] === 'string' ? params['scope'] : undefined
  const workspaceScope = normalizeWorkspaceScopeParam(rawScope)
  const worktreeScope = normalizeWorktreeScopeParam(rawScope)
  const commit = readNonEmptyString(params?.['commit'])
  const file = readNonEmptyString(params?.['file'])
  return {
    ...(wt !== undefined ? { wt } : {}),
    workspaceScope: workspaceScope === 'since' ? 'working' : workspaceScope,
    worktreeScope,
    ...(commit !== undefined ? { commit } : {}),
    ...(file !== undefined ? { file } : {}),
  }
}

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

  const initialParamsRef = useRef<ParsedWorkbenchParams | null>(null)
  if (initialParamsRef.current === null) {
    initialParamsRef.current = readWorkbenchChangesParams(props.params)
  }
  const initialParams = initialParamsRef.current
  const [activeWorktreeId, setActiveWorktreeId] = useState<string | undefined>(initialParams.wt)
  const [workspaceScope, setWorkspaceScope] = useState<WorkspaceDiffScope>(initialParams.workspaceScope)
  const [worktreeScope, setWorktreeScope] = useState<WorktreeDiffScope>(initialParams.worktreeScope)
  const [selectedCommit, setSelectedCommit] = useState<string | undefined>(initialParams.commit)
  const [expandedFile, setExpandedFile] = useState<string | undefined>(initialParams.file)
  const [wrapLines, setWrapLines] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [refreshSeq, setRefreshSeq] = useState(0)

  const [worktrees, setWorktrees] = useState<ManagedWorktreeSummaryView[]>([])
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState<string | undefined>(undefined)
  const [worktreeData, setWorktreeData] = useState<{ key: string; data: WorktreeInspectView } | undefined>(undefined)
  const [workspaceData, setWorkspaceData] = useState<{ key: string; data: WorkspaceInspectResult } | undefined>(undefined)

  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState<string | undefined>(undefined)
  const [fileState, setFileState] = useState<{ cacheKey: string; result: GitDiffFileResult } | undefined>(undefined)

  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const fileCacheRef = useRef<Map<string, GitDiffFileResult>>(new Map())
  const listGen = useRef(0)
  const summaryGen = useRef(0)
  const fileGen = useRef(0)
  const lastConvIdRef = useRef<number | undefined>(conversationId)
  const lastHandledParamsRef = useRef<Readonly<Record<string, unknown>> | undefined>(props.params)

  useEffect(() => {
    const convChanged = lastConvIdRef.current !== conversationId
    const paramsChanged = lastHandledParamsRef.current !== props.params
    if (!convChanged && !paramsChanged) return

    if (convChanged) {
      lastConvIdRef.current = conversationId
      fileCacheRef.current.clear()
      setWorktrees([])
      setWorktreeData(undefined)
      setWorkspaceData(undefined)
      setSummaryError(undefined)
      setFileState(undefined)
      setFileError(undefined)
      setSearchQuery('')
      if (!paramsChanged) {
        setActiveWorktreeId(undefined)
        setWorkspaceScope('working')
        setWorktreeScope('all')
        setSelectedCommit(undefined)
        setExpandedFile(undefined)
        return
      }
    }

    if (paramsChanged) {
      lastHandledParamsRef.current = props.params
      const p = props.params
      if (p === undefined) {
        if (convChanged) {
          setActiveWorktreeId(undefined)
          setWorkspaceScope('working')
          setWorktreeScope('all')
          setSelectedCommit(undefined)
          setExpandedFile(undefined)
        }
        return
      }

      const rawWt = p['wt']
      const parsed = readWorkbenchChangesParams(p)
      if (typeof rawWt === 'string') {
        setActiveWorktreeId(parsed.wt)
        setWorkspaceScope(parsed.workspaceScope)
        setWorktreeScope(parsed.worktreeScope)
        setSelectedCommit(parsed.commit)
        setExpandedFile(parsed.file)
        setSearchQuery('')
      } else if (convChanged) {
        setActiveWorktreeId(undefined)
        setWorkspaceScope(parsed.workspaceScope)
        setWorktreeScope('all')
        setSelectedCommit(parsed.commit)
        setExpandedFile(parsed.file)
      } else {
        if (typeof p['scope'] === 'string') {
          setWorkspaceScope(parsed.workspaceScope)
          setWorktreeScope(parsed.worktreeScope)
        }
        if (typeof p['commit'] === 'string') {
          setSelectedCommit(parsed.commit)
        }
        if (typeof p['file'] === 'string') {
          setExpandedFile(parsed.file)
        }
      }
    }
  }, [conversationId, props.params])

  useEffect(() => {
    if (conversationId === undefined || !worktreeEnabled) {
      setWorktrees([])
      return
    }
    const gen = ++listGen.current
    void ctxRef.current
      .callAction('list_worktrees', {}, { pluginId: 'builtin:worktree' })
      .then((raw) => {
        if (listGen.current !== gen) return
        const allWt = parseWorktreeListResult(raw)
        setWorktrees(
          allWt.filter(
            (w) => w.status === 'active' && (w.parentConversationId === conversationId || w.conversationId === conversationId),
          ),
        )
      })
      .catch(() => {
        if (listGen.current !== gen) return
        setWorktrees([])
      })
  }, [conversationId, worktreeEnabled, refreshSeq])

  const targetKey =
    activeWorktreeId !== undefined
      ? `wt:${activeWorktreeId}`
      : conversationId !== undefined
        ? `conv:${conversationId}`
        : ''
  const activeScope = activeWorktreeId !== undefined ? worktreeScope : workspaceScope
  const summaryScopeKey = `${targetKey}\u0000${activeScope}\u0000${selectedCommit ?? ''}`

  const loadSummary = useCallback(async (): Promise<void> => {
    if (conversationId === undefined && activeWorktreeId === undefined) return
    const gen = ++summaryGen.current
    setSummaryLoading(true)
    setSummaryError(undefined)
    try {
      if (activeWorktreeId !== undefined) {
        const raw = await ctxRef.current.callAction(
          'inspect_worktree',
          {
            worktreeId: activeWorktreeId,
            scope: worktreeScope,
            ...(worktreeScope === 'committed' && selectedCommit !== undefined ? { commit: selectedCommit } : {}),
          },
          { pluginId: 'builtin:worktree' },
        )
        if (summaryGen.current !== gen) return
        const parsed = parseWorktreeInspectResult(raw)
        if (parsed === undefined) {
          setSummaryError('Invalid inspect_worktree response')
        } else {
          setWorktreeData({ key: summaryScopeKey, data: parsed })
          setWorkspaceData(undefined)
        }
      } else if (conversationId !== undefined) {
        const effectiveScope = workspaceScope === 'since' ? 'working' : workspaceScope
        const raw = await ctxRef.current.callAction('inspect_workspace', {
          conversationId,
          scope: effectiveScope,
          ...(effectiveScope === 'commit' && selectedCommit !== undefined ? { commit: selectedCommit } : {}),
        })
        if (summaryGen.current !== gen) return
        const parsed = parseWorkspaceInspectResult(raw)
        if (parsed === undefined) {
          setSummaryError('Invalid inspect_workspace response')
        } else {
          setWorkspaceData({ key: summaryScopeKey, data: parsed })
          setWorktreeData(undefined)
        }
      }
    } catch (err) {
      if (summaryGen.current !== gen) return
      setSummaryError(err instanceof Error ? err.message : String(err))
    } finally {
      if (summaryGen.current === gen) {
        setSummaryLoading(false)
      }
    }
  }, [conversationId, activeWorktreeId, worktreeScope, workspaceScope, selectedCommit, summaryScopeKey])

  useEffect(() => {
    void loadSummary()
    return () => {
      summaryGen.current += 1
    }
  }, [loadSummary, refreshSeq])

  const conv = useConversation(conversationId, { includeDetail: false })
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
      if (settled) {
        fileCacheRef.current.clear()
        setRefreshSeq((n) => n + 1)
      }
    }
    prevWatchedRef.current = {
      id: conversationId,
      status: summary.status,
      completionSeq: summary.completionSeq,
    }
  }, [conversationId, conv.summary])

  const currentWorktree = worktreeData?.key === summaryScopeKey ? worktreeData.data : undefined
  const currentWorkspace = workspaceData?.key === summaryScopeKey ? workspaceData.data : undefined

  const activeFiles = useMemo(() => {
    if (currentWorktree !== undefined && currentWorktree.exists) return currentWorktree.files
    if (currentWorkspace !== undefined && currentWorkspace.isGitRepo) return currentWorkspace.files
    return []
  }, [currentWorktree, currentWorkspace])

  const filteredFiles = useMemo(() => filterFiles(activeFiles, searchQuery), [activeFiles, searchQuery])

  const activeCommits = useMemo(() => {
    if (currentWorktree !== undefined && currentWorktree.exists) return currentWorktree.commits
    if (currentWorkspace !== undefined && currentWorkspace.isGitRepo) return currentWorkspace.commits
    return []
  }, [currentWorktree, currentWorkspace])

  const selectedFileEntry = useMemo(
    () => (expandedFile !== undefined ? activeFiles.find((f) => f.path === expandedFile) : undefined),
    [activeFiles, expandedFile],
  )

  const activeSummaryHead =
    currentWorktree?.currentHead ?? (currentWorkspace?.isGitRepo ? currentWorkspace.currentHead : undefined)
  const activeDirtyCount =
    currentWorktree?.summary.dirtyFileCount ??
    (currentWorkspace?.isGitRepo ? currentWorkspace.summary.dirtyFileCount : 0)

  const activeFileCacheKey =
    targetKey !== '' && selectedFileEntry !== undefined
      ? buildFileCacheKey({
          targetKey,
          head: activeSummaryHead,
          dirtyCount: activeDirtyCount,
          scope: activeScope,
          commit: selectedCommit,
          filePath: selectedFileEntry.path,
          refreshSeq,
        })
      : ''

  const loadSelectedFile = useCallback(async (bypassCache = false): Promise<void> => {
    if (selectedFileEntry === undefined || activeFileCacheKey === '') return
    if (activeWorktreeId !== undefined && (!currentWorktree || !currentWorktree.exists)) return
    if (activeWorktreeId === undefined && (!currentWorkspace || !currentWorkspace.isGitRepo)) return

    if (!bypassCache) {
      const cached = fileCacheRef.current.get(activeFileCacheKey)
      if (cached !== undefined) {
        setFileState({ cacheKey: activeFileCacheKey, result: cached })
        setFileError(undefined)
        setFileLoading(false)
        return
      }
    }

    const gen = ++fileGen.current
    setFileLoading(true)
    setFileError(undefined)
    try {
      let raw: unknown
      if (activeWorktreeId !== undefined) {
        raw = await ctxRef.current.callAction(
          'inspect_worktree_file',
          {
            worktreeId: activeWorktreeId,
            filePath: selectedFileEntry.path,
            ...(selectedFileEntry.oldPath !== undefined ? { oldPath: selectedFileEntry.oldPath } : {}),
            scope: worktreeScope,
            ...(worktreeScope === 'committed' && selectedCommit !== undefined ? { commit: selectedCommit } : {}),
          },
          { pluginId: 'builtin:worktree' },
        )
      } else if (conversationId !== undefined) {
        const effectiveScope = workspaceScope === 'since' ? 'working' : workspaceScope
        raw = await ctxRef.current.callAction('inspect_workspace_file', {
          conversationId,
          filePath: selectedFileEntry.path,
          ...(selectedFileEntry.oldPath !== undefined ? { oldPath: selectedFileEntry.oldPath } : {}),
          scope: effectiveScope,
          ...(effectiveScope === 'commit' && selectedCommit !== undefined ? { commit: selectedCommit } : {}),
        })
      }
      if (fileGen.current !== gen) return
      const parsed = parseGitDiffFileResult(raw)
      if (parsed === undefined) {
        setFileError('Invalid inspect file response')
      } else {
        fileCacheRef.current.set(activeFileCacheKey, parsed)
        setFileState({ cacheKey: activeFileCacheKey, result: parsed })
      }
    } catch (err) {
      if (fileGen.current !== gen) return
      setFileError(err instanceof Error ? err.message : String(err))
    } finally {
      if (fileGen.current === gen) {
        setFileLoading(false)
      }
    }
  }, [
    selectedFileEntry,
    activeFileCacheKey,
    activeWorktreeId,
    conversationId,
    currentWorktree,
    currentWorkspace,
    worktreeScope,
    workspaceScope,
    selectedCommit,
  ])

  useEffect(() => {
    void loadSelectedFile(false)
    return () => {
      fileGen.current += 1
    }
  }, [loadSelectedFile])

  const triggerManualRefresh = useCallback((): void => {
    fileCacheRef.current.clear()
    setRefreshSeq((n) => n + 1)
  }, [])

  const activeFileResult = fileState?.cacheKey === activeFileCacheKey ? fileState.result : undefined
  const activeDiffBase =
    currentWorktree?.diffBase ?? (currentWorkspace?.isGitRepo ? currentWorkspace.diffBase : 'HEAD')
  const activeBaseCommit =
    currentWorktree?.record.baseCommit ?? (currentWorkspace?.isGitRepo ? currentWorkspace.baseCommit : undefined)
  const activeSelectedCommit =
    currentWorktree?.selectedCommit ?? (currentWorkspace?.isGitRepo ? currentWorkspace.selectedCommit : undefined)

  const workspaceHasUnpushed =
    currentWorkspace?.isGitRepo === true &&
    currentWorkspace.upstream !== undefined &&
    (currentWorkspace.commitsAheadOfUpstream ?? 0) > 0

  const scopeSegmentItems = useMemo(() => {
    if (activeWorktreeId !== undefined) {
      return [
        { value: 'all', label: t(CHG_COPY.scopeAll) },
        { value: 'committed', label: t(CHG_COPY.scopeCommitted) },
        { value: 'uncommitted', label: t(CHG_COPY.scopeUncommitted) },
      ]
    }
    const items: Array<{ value: string; label: string }> = [
      { value: 'working', label: t(CHG_COPY.scopeWorking) },
    ]
    if (workspaceHasUnpushed || workspaceScope === 'unpushed') {
      items.push({ value: 'unpushed', label: t(CHG_COPY.scopeUnpushed) })
    }
    items.push({ value: 'commit', label: t(CHG_COPY.scopeCommit) })
    return items
  }, [activeWorktreeId, workspaceHasUnpushed, workspaceScope, locale])

  const showTargetSelector = worktrees.length > 0 || activeWorktreeId !== undefined
  const targetSelectValue = activeWorktreeId !== undefined ? `wt:${activeWorktreeId}` : CURRENT_WORKSPACE_VALUE
  const targetOptions = useMemo<SelectOption<string>[]>(() => {
    if (!showTargetSelector) return []
    const opts: SelectOption<string>[] = [
      {
        value: CURRENT_WORKSPACE_VALUE,
        label: t(CHG_COPY.workbenchCurrentWorkspace),
        icon: 'folder',
      },
    ]
    const seen = new Set<string>()
    for (const wt of worktrees) {
      const value = `wt:${wt.id}`
      seen.add(value)
      opts.push({
        value,
        label: wt.nodeId && wt.nodeId !== 'local' ? `${wt.branch} (${wt.nodeId})` : wt.branch,
        icon: 'git-branch',
        meta: wt.nodeId && wt.nodeId !== 'local' ? wt.nodeId : 'worktree',
      })
    }
    if (activeWorktreeId !== undefined && !seen.has(`wt:${activeWorktreeId}`)) {
      opts.push({
        value: `wt:${activeWorktreeId}`,
        label: activeWorktreeId,
        icon: 'git-branch',
        meta: 'worktree',
      })
    }
    return opts
  }, [showTargetSelector, worktrees, activeWorktreeId, locale])

  const showCommitSelector =
    activeCommits.length > 0 &&
    ((activeWorktreeId !== undefined && worktreeScope === 'committed') ||
      (activeWorktreeId === undefined && workspaceScope === 'commit'))

  const commitOptions = useMemo<SelectOption<string>[]>(() => {
    if (!showCommitSelector) return []
    const entries: SelectOption<string>[] = activeCommits.map((c) => ({
      value: c.oid,
      label: `${c.shortOid} · ${c.subject}`,
      icon: 'git-commit',
      meta: c.committedAt > 0 ? formatCompactTimestamp(c.committedAt) : undefined,
    }))
    if (activeWorktreeId !== undefined) {
      return [{ value: ALL_COMMITTED_VALUE, label: t(CHG_COPY.allCommittedFilter), icon: 'git-branch' }, ...entries]
    }
    return entries
  }, [showCommitSelector, activeCommits, activeWorktreeId, locale])

  const commitSelectValue =
    activeWorktreeId !== undefined
      ? (selectedCommit ?? ALL_COMMITTED_VALUE)
      : (selectedCommit ?? activeSelectedCommit ?? activeCommits[0]?.oid ?? '')

  const handleOpenSplit = (): void => {
    const commitParam =
      activeWorktreeId !== undefined
        ? (worktreeScope === 'committed' ? selectedCommit : undefined)
        : (workspaceScope === 'commit' ? (selectedCommit ?? activeSelectedCommit) : undefined)
    const target =
      activeWorktreeId !== undefined
        ? buildChangesScreenTarget({
            wt: activeWorktreeId,
            ...(worktreeScope !== 'all' ? { scope: worktreeScope } : {}),
            ...(commitParam !== undefined ? { commit: commitParam } : {}),
            ...(selectedFileEntry !== undefined ? { file: selectedFileEntry.path } : {}),
          })
        : buildChangesScreenTarget({
            conv: conversationId,
            ...(workspaceScope !== 'working' ? { scope: workspaceScope } : {}),
            ...(commitParam !== undefined ? { commit: commitParam } : {}),
            ...(selectedFileEntry !== undefined ? { file: selectedFileEntry.path } : {}),
          })
    ctx.closeWorkbench()
    ctx.openSplitScreen(target)
  }

  if (conversationId === undefined && activeWorktreeId === undefined) {
    return (
      <div className="chg-wb-panel">
        <EmptyState compact title={t(CHG_COPY.noTargetTitle)} />
      </div>
    )
  }

  const isUnavailableWorktree = currentWorktree !== undefined && !currentWorktree.exists
  const isNonGitWorkspace = currentWorkspace !== undefined && !currentWorkspace.isGitRepo
  const hasReadySummary =
    (currentWorktree !== undefined && currentWorktree.exists) ||
    (currentWorkspace !== undefined && currentWorkspace.isGitRepo)
  const showSearch = activeFiles.length >= 8 || searchQuery !== ''
  const isFilesTruncated = Boolean(
    currentWorktree?.filesTruncated || (currentWorkspace?.isGitRepo && currentWorkspace.filesTruncated),
  )
  const visibleFiles = filteredFiles.slice(0, MAX_WORKBENCH_FILES)

  return (
    <div className="chg-wb-panel">
      <div className="chg-wb-bar">
        <SegmentedControl
          size="sm"
          aria-label="Diff scope"
          value={activeScope}
          items={scopeSegmentItems}
          onValueChange={(nextScope) => {
            setSearchQuery('')
            setExpandedFile(undefined)
            if (activeWorktreeId !== undefined) {
              setWorktreeScope(nextScope as WorktreeDiffScope)
              if (nextScope !== 'committed') setSelectedCommit(undefined)
            } else {
              const nextWsScope = nextScope as WorkspaceDiffScope
              setWorkspaceScope(nextWsScope)
              setSelectedCommit(nextWsScope === 'commit' ? (selectedCommit ?? activeCommits[0]?.oid) : undefined)
            }
          }}
        />
        <div className="chg-wb-bar-actions">
          <IconButton
            size="sm"
            variant="ghost"
            icon="rotate-cw"
            pending={summaryLoading}
            label={t(CHG_COPY.refresh)}
            onClick={triggerManualRefresh}
          />
          <IconButton
            size="sm"
            variant="ghost"
            icon="columns"
            label={t(CHG_COPY.expandSplit)}
            onClick={handleOpenSplit}
          />
        </div>
      </div>

      {showTargetSelector || (showCommitSelector && commitOptions.length > 0) ? (
        <div className="chg-wb-controls-row">
          {showTargetSelector ? (
            <Select
              size="sm"
              aria-label={t(CHG_COPY.workbenchTargetLabel)}
              value={targetSelectValue}
              options={targetOptions}
              onChange={(ev) => {
                const next = ev.target.value
                setSearchQuery('')
                setExpandedFile(undefined)
                setSelectedCommit(undefined)
                if (next === CURRENT_WORKSPACE_VALUE) {
                  setActiveWorktreeId(undefined)
                } else if (next.startsWith('wt:')) {
                  setActiveWorktreeId(next.slice(3))
                  setWorktreeScope('all')
                }
              }}
            />
          ) : null}
          {showCommitSelector && commitOptions.length > 0 ? (
            <Select
              size="sm"
              aria-label={t(CHG_COPY.commitSelectLabel)}
              value={commitSelectValue}
              options={commitOptions}
              onChange={(ev) => {
                const next = ev.target.value
                setSearchQuery('')
                setExpandedFile(undefined)
                setSelectedCommit(
                  activeWorktreeId !== undefined && next === ALL_COMMITTED_VALUE ? undefined : next,
                )
              }}
            />
          ) : null}
        </div>
      ) : null}

      {hasReadySummary ? (
        <div className="chg-wb-meta-row">
          {currentWorktree !== undefined && currentWorktree.exists ? (
            <>
              <Badge tone="neutral" icon="git-branch" className="mono">
                {currentWorktree.currentBranch ?? currentWorktree.record.branch}
              </Badge>
              <span className="mono tabular-nums text-muted">
                {chgSummaryText(
                  currentWorktree.summary.totalFiles,
                  currentWorktree.summary.additions,
                  currentWorktree.summary.deletions,
                  locale,
                )}
              </span>
              {currentWorktree.branchChanged === true ? (
                <Badge tone="warn">{t(CHG_COPY.branchMismatch)}</Badge>
              ) : null}
              {currentWorktree.commitsAhead !== undefined && currentWorktree.commitsAhead > 0 ? (
                <Badge tone="accent">{chgCommitsAheadBadge(currentWorktree.commitsAhead, locale)}</Badge>
              ) : null}
              {currentWorktree.unmergedCommits !== undefined && currentWorktree.unmergedCommits > 0 ? (
                <Badge tone="warn">{chgUnmergedBadge(currentWorktree.unmergedCommits, locale)}</Badge>
              ) : null}
              {currentWorktree.record.hold !== undefined ? (
                <Badge tone="neutral" icon="lock" title={currentWorktree.record.hold.label}>
                  {t(CHG_COPY.heldBadge)}
                </Badge>
              ) : null}
            </>
          ) : null}

          {currentWorkspace !== undefined && currentWorkspace.isGitRepo ? (
            <>
              <Badge tone="neutral" icon="git-branch" className="mono">
                {currentWorkspace.currentBranch}
              </Badge>
              <span className="mono tabular-nums text-muted">
                {chgSummaryText(
                  currentWorkspace.summary.totalFiles,
                  currentWorkspace.summary.additions,
                  currentWorkspace.summary.deletions,
                  locale,
                )}
              </span>
              {currentWorkspace.commitsAheadOfUpstream !== undefined && currentWorkspace.commitsAheadOfUpstream > 0 ? (
                <Badge tone="accent">{chgUnpushedBadge(currentWorkspace.commitsAheadOfUpstream, locale)}</Badge>
              ) : null}
              {currentWorkspace.summary.untrackedCount > 0 ? (
                <Badge tone="neutral">{chgUntrackedBadge(currentWorkspace.summary.untrackedCount, locale)}</Badge>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {summaryLoading && currentWorktree === undefined && currentWorkspace === undefined ? (
        <LoadingState label={t(CHG_COPY.loadingSummary)} />
      ) : summaryError !== undefined ? (
        <Callout tone="err">
          <Stack gap="xs" align="start">
            <div className="break-word">{summaryError}</div>
            <Button variant="secondary" size="xs" icon="rotate-cw" onClick={triggerManualRefresh}>
              {t(CHG_COPY.retry)}
            </Button>
          </Stack>
        </Callout>
      ) : isNonGitWorkspace ? (
        <EmptyState
          compact
          icon="folder"
          title={t(CHG_COPY.notGitTitle)}
          hint={currentWorkspace.nonGitReason === 'bare_repository' ? t(CHG_COPY.bareRepoBody) : t(CHG_COPY.notGitBody)}
        />
      ) : isUnavailableWorktree ? (
        <Callout
          tone="warn"
          title={
            currentWorktree.unavailableReason === 'removed'
              ? t(CHG_COPY.wtRemovedTitle)
              : t(CHG_COPY.wtMissingTitle)
          }
        >
          <div>
            {currentWorktree.unavailableReason === 'removed'
              ? t(CHG_COPY.wtRemovedBody)
              : t(CHG_COPY.wtMissingBody)}
          </div>
          <div className="mono text-muted">{`${currentWorktree.record.branch} @ ${currentWorktree.record.path}`}</div>
        </Callout>
      ) : hasReadySummary ? (
        <>
          {showSearch ? (
            <SearchBox
              size="sm"
              surface="subtle"
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder={t(CHG_COPY.searchFiles)}
              ariaLabel={t(CHG_COPY.searchFiles)}
            />
          ) : null}

          {activeFiles.length === 0 ? (
            activeWorktreeId === undefined && workspaceScope === 'working' && activeCommits.length > 0 ? (
              <EmptyState
                compact
                title={t(CHG_COPY.workbenchNoChanges)}
                action={
                  <Button
                    variant="secondary"
                    size="xs"
                    icon="git-commit"
                    onClick={() => {
                      setExpandedFile(undefined)
                      setSearchQuery('')
                      setWorkspaceScope('commit')
                      setSelectedCommit(activeCommits[0]!.oid)
                    }}
                  >
                    {t(CHG_COPY.workbenchViewCommits)}
                  </Button>
                }
              />
            ) : (
              <EmptyState compact title={t(CHG_COPY.noFiles)} />
            )
          ) : filteredFiles.length === 0 ? (
            <EmptyState compact title={t(CHG_COPY.noMatchingFiles)} />
          ) : (
            <div className="chg-wb-files">
              {visibleFiles.map((f) => {
                const isExpanded = selectedFileEntry?.path === f.path
                const { dir, name } = splitFilePath(f.path)
                const fullPathTitle = f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path
                return (
                  <div
                    key={f.path}
                    className={`chg-wb-file-item${isExpanded ? ' is-expanded' : ''}`}
                  >
                    <button
                      type="button"
                      className={`chg-file-row${isExpanded ? ' is-selected' : ''}`}
                      aria-expanded={isExpanded}
                      onClick={() => setExpandedFile((cur) => (cur === f.path ? undefined : f.path))}
                    >
                      <HelmxIcon
                        name={isExpanded ? 'chevron-down' : 'chevron-right'}
                        size={12}
                        className="chg-wb-chevron"
                      />
                      <span className={`chg-status-glyph chg-status-${f.status}`}>{f.status}</span>
                      <span className="chg-file-name-wrap" title={fullPathTitle}>
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
                    {isExpanded ? (
                      <div className="chg-wb-diff-drawer">
                        <div className="chg-wb-diff-bar">
                          <span className="chg-wb-diff-path mono" title={fullPathTitle}>
                            {fullPathTitle}
                          </span>
                          <div className="chg-wb-diff-actions">
                            <IconButton
                              variant="ghost"
                              size="xs"
                              icon="wrap-text"
                              active={wrapLines}
                              label={t(wrapLines ? CHG_COPY.unwrapLines : CHG_COPY.wrapLines)}
                              onClick={() => setWrapLines((v) => !v)}
                            />
                            <CopyButton text={f.path} className="btn btn-ghost btn-icon-xs" />
                          </div>
                        </div>
                        <DiffContent
                          filePath={f.path}
                          status={f.status}
                          loading={fileLoading}
                          error={fileError}
                          result={activeFileResult}
                          diffBase={activeDiffBase}
                          baseCommit={activeBaseCommit}
                          selectedCommit={activeSelectedCommit}
                          wrapLines={wrapLines}
                          onRetry={() => void loadSelectedFile(true)}
                          stateClassName="chg-wb-diff-state"
                        />
                      </div>
                    ) : null}
                  </div>
                )
              })}
              {filteredFiles.length > MAX_WORKBENCH_FILES || isFilesTruncated ? (
                <div className="chg-files-truncated-note">{t(CHG_COPY.workbenchTruncatedHint)}</div>
              ) : null}
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}
