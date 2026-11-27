/**
 * Full-screen / split-screen pure read-only Git Diff Inspector (`screen:builtin:changes/inspector`).
 * Supports both ordinary conversation workspaces (`conv`) and managed worktrees (`wt`),
 * URL param sync via `useScreenParams()`, URL-driven narrow mobile navigation (`sp.file`),
 * on-demand single-file loading, bounded in-memory caching, and auto-refresh on turn settle.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import './styles.css'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ScreenProps } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  LoadingState,
  Screen,
  SearchBox,
  SegmentedControl,
  Select,
  Stack,
  formatCompactTimestamp,
  resolveLocalizedText,
  useConversation,
  useConversations,
  usePluginContext,
  usePluginLocale,
  usePlugins,
  useScreenParams,
  type LocalizedText,
  type SelectOption,
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
import { DiffViewer } from './DiffViewer.tsx'
import {
  filterFiles,
  parseGitDiffFileResult,
  parseWorkspaceInspectResult,
  parseWorktreeInspectResult,
  parseWorktreeListResult,
  splitFilePath,
  type ChangesTargetSelection,
  type ManagedWorktreeSummaryView,
  type WorktreeInspectView,
} from './diff-model.ts'

export interface ChangesInspectorScreenProps extends Partial<ScreenProps> {}

const ALL_COMMITTED_VALUE = '__all__'

function parsePositiveIntParam(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined
  const num = Number(raw)
  return Number.isSafeInteger(num) && num > 0 ? num : undefined
}

function normalizeWorktreeScopeParam(raw: string | undefined): WorktreeDiffScope {
  return raw === 'committed' || raw === 'uncommitted' ? raw : 'all'
}

function normalizeWorkspaceScopeParam(raw: string | undefined): WorkspaceDiffScope {
  if (raw === 'unpushed' || raw === 'commit' || raw === 'since') return raw
  return 'working'
}

function buildFileCacheKey(parts: {
  targetKey: string
  head?: string
  dirtyCount: number
  scope: string
  commit?: string
  base?: string
  filePath: string
  refreshSeq: number
}): string {
  return [
    parts.targetKey,
    parts.head ?? '',
    String(parts.dirtyCount),
    parts.scope,
    parts.commit ?? '',
    parts.base ?? '',
    parts.filePath,
    String(parts.refreshSeq),
  ].join('\u0000')
}

export function ChangesInspectorScreen(props: ChangesInspectorScreenProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = (text: LocalizedText): string => resolveLocalizedText(text, locale)
  const screenScope = useScreenParams()
  const conversations = useConversations()
  const { plugins } = usePlugins()

  const worktreeEnabled = useMemo(
    () => plugins.some((p) => p.id === 'builtin:worktree' && p.enabled && (p.status === undefined || p.status === 'active')),
    [plugins],
  )

  const [localParams, setLocalParams] = useState<Record<string, string>>(() => ({ ...(props.params ?? {}) }))
  const params = screenScope?.params ?? props.params ?? localParams
  const setParamsFn = screenScope?.setParams ?? props.setParams
  const updateParams = useCallback(
    (patch: Record<string, string | undefined>, options?: { push?: boolean }): void => {
      if (setParamsFn !== undefined) {
        setParamsFn(patch, options)
        return
      }
      setLocalParams((prev) => {
        const next = { ...prev }
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined || v === '') delete next[k]
          else next[k] = v
        }
        return next
      })
    },
    [setParamsFn],
  )

  const [worktrees, setWorktrees] = useState<ManagedWorktreeSummaryView[]>([])
  const [refreshSeq, setRefreshSeq] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')

  const ctxRef = useRef(ctx)
  ctxRef.current = ctx

  const listGen = useRef(0)
  useEffect(() => {
    if (!worktreeEnabled) {
      setWorktrees([])
      return
    }
    const gen = ++listGen.current
    void ctxRef.current
      .callAction('list_worktrees', {}, { pluginId: 'builtin:worktree' })
      .then((raw) => {
        if (listGen.current !== gen) return
        setWorktrees(parseWorktreeListResult(raw))
      })
      .catch(() => {
        if (listGen.current !== gen) return
        setWorktrees([])
      })
  }, [worktreeEnabled, refreshSeq])

  const paramWt = params['wt']?.trim() || undefined
  const paramConv = parsePositiveIntParam(params['conv'])
  const paramFile = params['file']?.trim() || undefined
  const paramCommit = params['commit']?.trim() || undefined
  const paramBase = params['base']?.trim() || undefined

  const activeSelection = useMemo<ChangesTargetSelection | undefined>(() => {
    if (paramWt !== undefined) return { kind: 'worktree', worktreeId: paramWt }
    if (paramConv !== undefined) return { kind: 'workspace', conversationId: paramConv }
    const withCwd =
      conversations.find((c) => !c.tags.includes('archived') && c.cwd.trim() !== '') ??
      conversations.find((c) => c.cwd.trim() !== '')
    if (withCwd !== undefined) return { kind: 'workspace', conversationId: withCwd.id }
    const activeWt = worktrees.find((w) => w.status === 'active') ?? worktrees[0]
    if (activeWt !== undefined) return { kind: 'worktree', worktreeId: activeWt.id }
    return undefined
  }, [paramWt, paramConv, conversations, worktrees])

  const targetKey =
    activeSelection === undefined
      ? ''
      : activeSelection.kind === 'worktree'
        ? `wt:${activeSelection.worktreeId}`
        : `conv:${activeSelection.conversationId}`

  const worktreeScope = normalizeWorktreeScopeParam(params['scope'])
  const workspaceScope = normalizeWorkspaceScopeParam(params['scope'])
  const activeScope = activeSelection?.kind === 'worktree' ? worktreeScope : workspaceScope

  const targetOptions = useMemo<SelectOption<string>[]>(() => {
    const opts: SelectOption<string>[] = []
    const seen = new Set<string>()
    for (const c of conversations) {
      if (c.cwd.trim() === '') continue
      const value = `conv:${c.id}`
      seen.add(value)
      const labelTitle = c.title.trim() !== '' ? c.title.trim() : `#${c.id}`
      opts.push({
        value,
        label: `${labelTitle} (${c.nodeId || 'local'})`,
        icon: 'folder',
        meta: `#${c.id}`,
      })
    }
    if (worktreeEnabled) {
      for (const wt of worktrees) {
        if (wt.status !== 'active' && wt.id !== paramWt) continue
        const value = `wt:${wt.id}`
        seen.add(value)
        opts.push({
          value,
          label: `${wt.branch} (${wt.nodeId})`,
          icon: 'git-branch',
          meta: wt.status === 'removed' ? 'removed' : 'worktree',
        })
      }
    }
    if (targetKey !== '' && !seen.has(targetKey)) {
      opts.unshift({
        value: targetKey,
        label: activeSelection?.kind === 'worktree' ? activeSelection.worktreeId : `#${activeSelection?.conversationId}`,
        icon: activeSelection?.kind === 'worktree' ? 'git-branch' : 'folder',
      })
    }
    return opts
  }, [conversations, worktrees, worktreeEnabled, targetKey, activeSelection, paramWt])

  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState<string | undefined>(undefined)
  const [worktreeData, setWorktreeData] = useState<{ key: string; data: WorktreeInspectView } | undefined>(undefined)
  const [workspaceData, setWorkspaceData] = useState<{ key: string; data: WorkspaceInspectResult } | undefined>(undefined)

  const fileCacheRef = useRef<Map<string, GitDiffFileResult>>(new Map())
  const summaryGen = useRef(0)

  const summaryScopeKey = `${targetKey}\u0000${activeScope}\u0000${paramCommit ?? ''}\u0000${paramBase ?? ''}`

  const loadSummary = useCallback(async (): Promise<void> => {
    if (activeSelection === undefined) return
    const gen = ++summaryGen.current
    setSummaryLoading(true)
    setSummaryError(undefined)
    try {
      if (activeSelection.kind === 'worktree') {
        const raw = await ctxRef.current.callAction(
          'inspect_worktree',
          {
            worktreeId: activeSelection.worktreeId,
            scope: worktreeScope,
            ...(worktreeScope === 'committed' && paramCommit !== undefined ? { commit: paramCommit } : {}),
          },
          { pluginId: 'builtin:worktree' },
        )
        if (summaryGen.current !== gen) return
        const parsed = parseWorktreeInspectResult(raw)
        if (parsed === undefined) {
          setSummaryError('Invalid inspect_worktree response shape')
        } else {
          setWorktreeData({ key: summaryScopeKey, data: parsed })
          setWorkspaceData(undefined)
        }
      } else {
        const effectiveScope = workspaceScope === 'since' && paramBase === undefined ? 'working' : workspaceScope
        const raw = await ctxRef.current.callAction('inspect_workspace', {
          conversationId: activeSelection.conversationId,
          scope: effectiveScope,
          ...(effectiveScope === 'commit' && paramCommit !== undefined ? { commit: paramCommit } : {}),
          ...(effectiveScope === 'since' && paramBase !== undefined ? { baseCommit: paramBase } : {}),
        })
        if (summaryGen.current !== gen) return
        const parsed = parseWorkspaceInspectResult(raw)
        if (parsed === undefined) {
          setSummaryError('Invalid inspect_workspace response shape')
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
  }, [activeSelection, worktreeScope, workspaceScope, paramCommit, paramBase, summaryScopeKey])

  useEffect(() => {
    void loadSummary()
    return () => {
      summaryGen.current += 1
    }
  }, [loadSummary, refreshSeq])

  const currentWorktree = worktreeData?.key === summaryScopeKey ? worktreeData.data : undefined
  const currentWorkspace = workspaceData?.key === summaryScopeKey ? workspaceData.data : undefined

  const watchedConvId =
    activeSelection?.kind === 'workspace'
      ? activeSelection.conversationId
      : currentWorktree?.record.conversationId
  const watchedConv = useConversation(watchedConvId, { includeDetail: false })
  const prevWatchedRef = useRef<{ id?: number; status?: string; completionSeq?: number }>({})

  const triggerManualRefresh = useCallback((): void => {
    fileCacheRef.current.clear()
    setRefreshSeq((n) => n + 1)
  }, [])

  useEffect(() => {
    const summary = watchedConv.summary
    if (watchedConvId === undefined || summary === undefined) return
    const prev = prevWatchedRef.current
    if (prev.id === watchedConvId) {
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
      id: watchedConvId,
      status: summary.status,
      completionSeq: summary.completionSeq,
    }
  }, [watchedConvId, watchedConv.summary])

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

  const explicitFile = useMemo(
    () => (paramFile !== undefined ? activeFiles.find((f) => f.path === paramFile) : undefined),
    [activeFiles, paramFile],
  )
  const isSingleFile = activeFiles.length === 1
  const isNarrowDiff = !isSingleFile && explicitFile !== undefined
  const showNarrowDiffPane = isSingleFile || isNarrowDiff

  const selectedFileEntry = useMemo(() => {
    if (activeFiles.length === 0) return undefined
    if (explicitFile !== undefined) return explicitFile
    return filteredFiles[0] ?? activeFiles[0]
  }, [activeFiles, explicitFile, filteredFiles])

  const navFiles = useMemo(() => {
    if (selectedFileEntry !== undefined && filteredFiles.some((f) => f.path === selectedFileEntry.path)) {
      return filteredFiles
    }
    return activeFiles
  }, [activeFiles, filteredFiles, selectedFileEntry])

  const selectedIndex = useMemo(
    () => (selectedFileEntry !== undefined ? navFiles.findIndex((f) => f.path === selectedFileEntry.path) : -1),
    [navFiles, selectedFileEntry],
  )

  const activeSummaryHead =
    currentWorktree?.currentHead ?? (currentWorkspace?.isGitRepo ? currentWorkspace.currentHead : undefined)
  const activeDirtyCount =
    currentWorktree?.summary.dirtyFileCount ??
    (currentWorkspace?.isGitRepo ? currentWorkspace.summary.dirtyFileCount : 0)

  const activeFileCacheKey =
    activeSelection !== undefined && selectedFileEntry !== undefined
      ? buildFileCacheKey({
          targetKey,
          head: activeSummaryHead,
          dirtyCount: activeDirtyCount,
          scope: activeScope,
          commit: paramCommit,
          base: paramBase,
          filePath: selectedFileEntry.path,
          refreshSeq,
        })
      : ''

  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState<string | undefined>(undefined)
  const [fileState, setFileState] = useState<{ cacheKey: string; result: GitDiffFileResult } | undefined>(undefined)
  const fileGen = useRef(0)

  const loadSelectedFile = useCallback(async (bypassCache = false): Promise<void> => {
    if (activeSelection === undefined || selectedFileEntry === undefined || activeFileCacheKey === '') return
    if (activeSelection.kind === 'worktree' && (!currentWorktree || !currentWorktree.exists)) return
    if (activeSelection.kind === 'workspace' && (!currentWorkspace || !currentWorkspace.isGitRepo)) return

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
      if (activeSelection.kind === 'worktree') {
        raw = await ctxRef.current.callAction(
          'inspect_worktree_file',
          {
            worktreeId: activeSelection.worktreeId,
            filePath: selectedFileEntry.path,
            ...(selectedFileEntry.oldPath !== undefined ? { oldPath: selectedFileEntry.oldPath } : {}),
            scope: worktreeScope,
            ...(worktreeScope === 'committed' && paramCommit !== undefined ? { commit: paramCommit } : {}),
          },
          { pluginId: 'builtin:worktree' },
        )
      } else {
        const effectiveScope = workspaceScope === 'since' && paramBase === undefined ? 'working' : workspaceScope
        raw = await ctxRef.current.callAction('inspect_workspace_file', {
          conversationId: activeSelection.conversationId,
          filePath: selectedFileEntry.path,
          ...(selectedFileEntry.oldPath !== undefined ? { oldPath: selectedFileEntry.oldPath } : {}),
          scope: effectiveScope,
          ...(effectiveScope === 'commit' && paramCommit !== undefined ? { commit: paramCommit } : {}),
          ...(effectiveScope === 'since' && paramBase !== undefined ? { baseCommit: paramBase } : {}),
        })
      }
      if (fileGen.current !== gen) return
      const parsed = parseGitDiffFileResult(raw)
      if (parsed === undefined) {
        setFileError('Invalid inspect file response shape')
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
    activeSelection,
    selectedFileEntry,
    activeFileCacheKey,
    currentWorktree,
    currentWorkspace,
    worktreeScope,
    workspaceScope,
    paramCommit,
    paramBase,
  ])

  useEffect(() => {
    void loadSelectedFile(false)
    return () => {
      fileGen.current += 1
    }
  }, [loadSelectedFile])

  const selectFile = (filePath: string): void => {
    updateParams({ file: filePath }, paramFile === undefined ? { push: true } : undefined)
  }

  const backToFiles = (): void => {
    updateParams({ file: undefined })
  }

  const stepFile = (delta: -1 | 1): void => {
    if (selectedIndex < 0) return
    const nextFile = navFiles[selectedIndex + delta]
    if (nextFile !== undefined) {
      updateParams({ file: nextFile.path })
    }
  }

  const handleFileListKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (filteredFiles.length === 0) return
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const idx = selectedFileEntry ? filteredFiles.findIndex((f) => f.path === selectedFileEntry.path) : -1
    const nextIdx =
      e.key === 'ArrowDown'
        ? Math.min(filteredFiles.length - 1, idx < 0 ? 0 : idx + 1)
        : Math.max(0, idx <= 0 ? 0 : idx - 1)
    const nextFile = filteredFiles[nextIdx]
    if (nextFile !== undefined) {
      updateParams({ file: nextFile.path })
    }
  }

  const workspaceHasUnpushed =
    currentWorkspace?.isGitRepo === true &&
    currentWorkspace.upstream !== undefined &&
    (currentWorkspace.commitsAheadOfUpstream ?? 0) > 0

  const scopeSegmentItems = useMemo(() => {
    if (activeSelection?.kind === 'worktree') {
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
    if (workspaceScope === 'since' && paramBase !== undefined) {
      items.push({ value: 'since', label: t(CHG_COPY.scopeSince) })
    }
    return items
  }, [activeSelection?.kind, workspaceHasUnpushed, workspaceScope, paramBase, locale])

  const activeFileResult = fileState?.cacheKey === activeFileCacheKey ? fileState.result : undefined
  const activeDiffBase =
    currentWorktree?.diffBase ?? (currentWorkspace?.isGitRepo ? currentWorkspace.diffBase : 'HEAD')
  const activeBaseCommit =
    currentWorktree?.record.baseCommit ?? (currentWorkspace?.isGitRepo ? currentWorkspace.baseCommit : undefined)
  const activeSelectedCommit =
    currentWorktree?.selectedCommit ?? (currentWorkspace?.isGitRepo ? currentWorkspace.selectedCommit : undefined)

  const showCommitSelector =
    activeCommits.length > 0 &&
    ((activeSelection?.kind === 'worktree' && worktreeScope === 'committed') ||
      (activeSelection?.kind === 'workspace' && workspaceScope === 'commit'))

  const commitOptions = useMemo<SelectOption<string>[]>(() => {
    if (!showCommitSelector) return []
    const entries: SelectOption<string>[] = activeCommits.map((c) => ({
      value: c.oid,
      label: `${c.shortOid} · ${c.subject}`,
      icon: 'git-commit',
      meta: c.committedAt > 0 ? formatCompactTimestamp(c.committedAt) : undefined,
    }))
    if (activeSelection?.kind === 'worktree') {
      return [{ value: ALL_COMMITTED_VALUE, label: t(CHG_COPY.allCommittedFilter), icon: 'git-branch' }, ...entries]
    }
    return entries
  }, [showCommitSelector, activeCommits, activeSelection?.kind, locale])

  const commitSelectValue =
    activeSelection?.kind === 'worktree'
      ? (paramCommit ?? ALL_COMMITTED_VALUE)
      : (activeSelectedCommit ?? activeCommits[0]?.oid ?? '')

  const isUnavailableWorktree = currentWorktree !== undefined && !currentWorktree.exists
  const isNonGitWorkspace = currentWorkspace !== undefined && !currentWorkspace.isGitRepo
  const hasStageContent =
    activeSelection !== undefined &&
    !(summaryLoading && currentWorktree === undefined && currentWorkspace === undefined) &&
    summaryError === undefined &&
    !isNonGitWorkspace &&
    !isUnavailableWorktree

  const showSearch = activeFiles.length >= 8 || searchQuery !== ''
  const screenClass = hasStageContent && isNarrowDiff ? 'chg-screen chg-is-narrow-diff' : 'chg-screen'

  const refreshAction = (
    <Button
      size="sm"
      variant="ghost"
      icon="rotate-cw"
      pending={summaryLoading}
      title={t(CHG_COPY.refresh)}
      aria-label={t(CHG_COPY.refresh)}
      onClick={triggerManualRefresh}
    >
      <span className="pane-action-label">{t(CHG_COPY.refresh)}</span>
    </Button>
  )

  return (
    <Screen
      layout="full-bleed"
      className={screenClass}
      title={t(CHG_COPY.screenTitle)}
      actions={refreshAction}
    >
      <div className="chg-topbar">
        <div className="chg-topbar-left">
          <div className="chg-target-select-wrap">
            <Select
              size="sm"
              aria-label={t(CHG_COPY.targetPlaceholder)}
              placeholder={t(CHG_COPY.targetPlaceholder)}
              value={targetKey}
              options={targetOptions}
              popoverClassName="helmx-select-popover-wide"
              onChange={(ev) => {
                const next = ev.target.value
                setSearchQuery('')
                if (next.startsWith('wt:')) {
                  updateParams(
                    { wt: next.slice(3), conv: undefined, scope: undefined, commit: undefined, base: undefined, file: undefined },
                    { push: true },
                  )
                } else if (next.startsWith('conv:')) {
                  updateParams(
                    { conv: next.slice(5), wt: undefined, scope: undefined, commit: undefined, base: undefined, file: undefined },
                    { push: true },
                  )
                }
              }}
            />
          </div>
          {activeSelection !== undefined ? (
            <SegmentedControl
              size="sm"
              aria-label="Diff scope"
              value={activeScope}
              items={scopeSegmentItems}
              onValueChange={(nextScope) => {
                setSearchQuery('')
                if (activeSelection.kind === 'worktree') {
                  updateParams({
                    scope: nextScope,
                    commit: nextScope === 'committed' ? paramCommit : undefined,
                    file: undefined,
                  })
                } else {
                  const defaultCommit = nextScope === 'commit' ? (paramCommit ?? activeCommits[0]?.oid) : undefined
                  updateParams({
                    scope: nextScope,
                    commit: defaultCommit,
                    base: nextScope === 'since' ? paramBase : undefined,
                    file: undefined,
                  })
                }
              }}
            />
          ) : null}
          {showCommitSelector && commitOptions.length > 0 ? (
            <div className="chg-commit-select-wrap">
              <Select
                size="sm"
                aria-label={t(CHG_COPY.commitSelectLabel)}
                value={commitSelectValue}
                options={commitOptions}
                popoverClassName="helmx-select-popover-wide"
                onChange={(ev) => {
                  const next = ev.target.value
                  setSearchQuery('')
                  if (activeSelection?.kind === 'worktree') {
                    updateParams({
                      scope: 'committed',
                      commit: next === ALL_COMMITTED_VALUE ? undefined : next,
                      file: undefined,
                    })
                  } else {
                    updateParams({
                      scope: 'commit',
                      commit: next,
                      base: undefined,
                      file: undefined,
                    })
                  }
                }}
              />
            </div>
          ) : null}
        </div>

        <div className="chg-topbar-right">
          {currentWorktree !== undefined && currentWorktree.exists ? (
            <>
              <Badge tone="neutral" icon="git-branch" className="mono">
                {currentWorktree.currentBranch ?? currentWorktree.record.branch}
              </Badge>
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
              <Badge tone="neutral" className="mono tabular-nums">
                {chgSummaryText(
                  currentWorktree.summary.totalFiles,
                  currentWorktree.summary.additions,
                  currentWorktree.summary.deletions,
                  locale,
                )}
              </Badge>
            </>
          ) : null}

          {currentWorkspace !== undefined && currentWorkspace.isGitRepo ? (
            <>
              <Badge tone="neutral" icon="git-branch" className="mono">
                {currentWorkspace.currentBranch}
              </Badge>
              {currentWorkspace.commitsAheadOfUpstream !== undefined && currentWorkspace.commitsAheadOfUpstream > 0 ? (
                <Badge tone="accent">{chgUnpushedBadge(currentWorkspace.commitsAheadOfUpstream, locale)}</Badge>
              ) : null}
              <Badge tone="neutral" className="mono tabular-nums">
                {chgSummaryText(
                  currentWorkspace.summary.totalFiles,
                  currentWorkspace.summary.additions,
                  currentWorkspace.summary.deletions,
                  locale,
                )}
              </Badge>
              {currentWorkspace.summary.untrackedCount > 0 ? (
                <Badge tone="neutral">{chgUntrackedBadge(currentWorkspace.summary.untrackedCount, locale)}</Badge>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {activeSelection === undefined ? (
        <div className="chg-stage-state">
          <EmptyState icon="file-diff" title={t(CHG_COPY.noTargetTitle)} hint={t(CHG_COPY.noTargetHint)} />
        </div>
      ) : summaryLoading && currentWorktree === undefined && currentWorkspace === undefined ? (
        <div className="chg-stage-state">
          <LoadingState label={t(CHG_COPY.loadingSummary)} />
        </div>
      ) : summaryError !== undefined ? (
        <div className="chg-stage-state">
          <Callout tone="err">
            <Stack gap="xs" align="start">
              <div className="break-word">{summaryError}</div>
              <Button size="xs" icon="rotate-cw" onClick={triggerManualRefresh}>
                {t(CHG_COPY.retry)}
              </Button>
            </Stack>
          </Callout>
        </div>
      ) : isNonGitWorkspace ? (
        <div className="chg-stage-state">
          <Callout tone="warn" title={t(CHG_COPY.notGitTitle)}>
            <div>
              {currentWorkspace.nonGitReason === 'bare_repository' ? t(CHG_COPY.bareRepoBody) : t(CHG_COPY.notGitBody)}
            </div>
            <div className="mono text-muted">{`${currentWorkspace.nodeId}:${currentWorkspace.cwd}`}</div>
          </Callout>
        </div>
      ) : isUnavailableWorktree ? (
        <div className="chg-stage-state">
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
        </div>
      ) : (
        <div className={`chg-split-stage ${showNarrowDiffPane ? 'chg-mode-diff' : 'chg-mode-list'}`}>
          <aside className="chg-sidebar">
            {showSearch ? (
              <div className="chg-sidebar-search">
                <SearchBox
                  value={searchQuery}
                  onChange={setSearchQuery}
                  placeholder={t(CHG_COPY.searchFiles)}
                  ariaLabel={t(CHG_COPY.searchFiles)}
                />
              </div>
            ) : null}

            <div
              className="chg-files-list"
              role="listbox"
              aria-label="Changed files"
              tabIndex={0}
              onKeyDown={handleFileListKeyDown}
            >
              {activeFiles.length === 0 ? (
                <EmptyState compact title={t(CHG_COPY.noFiles)} />
              ) : filteredFiles.length === 0 ? (
                <EmptyState compact title={t(CHG_COPY.noMatchingFiles)} />
              ) : (
                filteredFiles.map((file) => {
                  const selected = selectedFileEntry?.path === file.path
                  const { dir, name } = splitFilePath(file.path)
                  return (
                    <button
                      key={file.path}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`chg-file-row${selected ? ' is-selected' : ''}`}
                      onClick={() => selectFile(file.path)}
                    >
                      <span className={`chg-status-glyph chg-status-${file.status}`}>{file.status}</span>
                      <span className="chg-file-name-wrap" title={file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}>
                        <span className="chg-file-name">{name}</span>
                        {dir !== '' ? <span className="chg-file-dir mono">{dir}</span> : null}
                      </span>
                      <span className="chg-file-stats mono tabular-nums">
                        {file.binary ? (
                          <span className="text-muted">BIN</span>
                        ) : file.untracked ? (
                          <span className="chg-stat-add">NEW</span>
                        ) : (
                          <>
                            {file.additions > 0 ? <span className="chg-stat-add">{`+${file.additions}`}</span> : null}
                            {file.deletions > 0 ? <span className="chg-stat-del">{`−${file.deletions}`}</span> : null}
                          </>
                        )}
                      </span>
                    </button>
                  )
                })
              )}
              {(currentWorktree?.filesTruncated || (currentWorkspace?.isGitRepo && currentWorkspace.filesTruncated)) ? (
                <div className="chg-files-truncated-note">{t(CHG_COPY.filesTruncatedNote)}</div>
              ) : null}
            </div>
          </aside>

          <main className="chg-main-diff">
            <DiffViewer
              filePath={selectedFileEntry?.path}
              oldPath={selectedFileEntry?.oldPath}
              status={selectedFileEntry?.status}
              loading={fileLoading}
              error={fileError}
              result={activeFileResult}
              diffBase={activeDiffBase}
              baseCommit={activeBaseCommit}
              selectedCommit={activeSelectedCommit}
              fileIndex={selectedIndex}
              totalFiles={navFiles.length}
              onPrevFile={selectedIndex > 0 ? () => stepFile(-1) : undefined}
              onNextFile={selectedIndex >= 0 && selectedIndex < navFiles.length - 1 ? () => stepFile(1) : undefined}
              onRetry={() => void loadSelectedFile(true)}
              onBack={isNarrowDiff ? backToFiles : undefined}
            />
          </main>
        </div>
      )}
    </Screen>
  )
}
