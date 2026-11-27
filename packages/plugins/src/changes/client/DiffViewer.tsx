/**
 * Structured single-file Git diff viewer (reuses host `--diff-*` CSS variables and
 * `trace-diff-*` visual language). Exports only React components and TS types.
 */
import { Fragment, useMemo, useState, type ReactNode } from 'react'
import {
  Badge,
  Button,
  Callout,
  CopyButton,
  EmptyState,
  LoadingState,
  resolveLocalizedText,
  usePluginLocale,
  type BadgeTone,
  type LocalizedText,
} from '@helmx/plugin-client'
import type { GitDiffFileResult, GitDiffFileStatus } from '../../contracts-types.js'
import {
  CHG_COPY,
  chgBytesLabel,
  chgCollapseDiff,
  chgExpandRemaining,
  chgSpecialFileDetail,
  statusLabelText,
} from './copy.ts'
import {
  decorateHunksWithWordDiff,
  formatInspectGitCommand,
  splitFilePath,
  type DecoratedHunkRow,
  type WordSegment,
} from './diff-model.ts'

export interface DiffViewerProps {
  filePath?: string
  oldPath?: string
  status?: GitDiffFileStatus
  loading?: boolean
  error?: string
  result?: GitDiffFileResult
  diffBase: 'baseCommit' | 'HEAD' | 'upstream' | 'commit'
  baseCommit?: string
  selectedCommit?: string
  headerActions?: ReactNode
  onRetry?: () => void
  onBack?: () => void
}

const FOLD_THRESHOLD_ROWS = 350

function statusBadgeTone(status: GitDiffFileStatus): BadgeTone {
  switch (status) {
    case 'A':
    case 'U':
      return 'ok'
    case 'D':
      return 'err'
    case 'R':
    case 'C':
      return 'accent'
    case 'M':
      return 'warn'
  }
}

function DiffLineRow({ row }: { row: DecoratedHunkRow }): ReactNode {
  const sign = row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '
  const rowClass =
    row.kind === 'add'
      ? 'chg-diff-row-add'
      : row.kind === 'remove'
        ? 'chg-diff-row-remove'
        : 'chg-diff-row-context'
  const wordClass = row.kind === 'add' ? 'chg-diff-word-add' : 'chg-diff-word-remove'

  return (
    <div className={`chg-diff-row ${rowClass}`}>
      <span className="chg-diff-num">{row.kind !== 'add' && row.oldLine !== undefined ? String(row.oldLine) : ''}</span>
      <span className="chg-diff-num">{row.kind !== 'remove' && row.newLine !== undefined ? String(row.newLine) : ''}</span>
      <span className="chg-diff-content">
        <span className="chg-diff-sign">{sign}</span>
        {row.word !== undefined
          ? row.word.map((seg: WordSegment, idx: number) =>
              seg.changed ? (
                <span key={idx} className={wordClass}>{seg.text}</span>
              ) : (
                <span key={idx}>{seg.text}</span>
              ),
            )
          : row.text === ''
            ? ' '
            : row.text}
      </span>
    </div>
  )
}

export function DiffViewer(props: DiffViewerProps): ReactNode {
  const locale = usePluginLocale()
  const t = (text: LocalizedText): string => resolveLocalizedText(text, locale)
  const { filePath, oldPath, status, loading, error, result, diffBase, baseCommit, selectedCommit, headerActions, onRetry, onBack } = props
  const [expandedFileKey, setExpandedFileKey] = useState<string | undefined>(undefined)

  const currentKey = `${filePath ?? ''}\u0000${diffBase}\u0000${baseCommit ?? ''}\u0000${selectedCommit ?? ''}`
  const expanded = expandedFileKey === currentKey

  const decoratedHunks = useMemo(() => {
    if (result === undefined || (result.kind !== 'diff' && result.kind !== 'untracked')) return []
    return decorateHunksWithWordDiff(result.hunks)
  }, [result])

  const totalRows = useMemo(
    () => decoratedHunks.reduce((sum, h) => sum + h.rows.length, 0),
    [decoratedHunks],
  )

  if (filePath === undefined) {
    return (
      <div className="chg-viewer-empty">
        <EmptyState compact icon="file-diff" title={t(CHG_COPY.selectFileHint)} />
      </div>
    )
  }

  const effectiveStatus = (result !== undefined && 'status' in result ? result.status : undefined) ?? status ?? 'M'
  const effectiveOldPath = (result !== undefined && 'oldPath' in result ? result.oldPath : undefined) ?? oldPath
  const { dir, name } = splitFilePath(filePath)
  const additions = result !== undefined && 'additions' in result ? result.additions : undefined
  const deletions = result !== undefined && 'deletions' in result ? result.deletions : undefined
  const gitCommand =
    effectiveStatus === 'U' ? undefined : formatInspectGitCommand({ filePath, diffBase, baseCommit, selectedCommit })

  let renderedBody: ReactNode = null
  if (loading && result === undefined) {
    renderedBody = (
      <div className="chg-viewer-state">
        <LoadingState label={t(CHG_COPY.loadingFile)} />
      </div>
    )
  } else if (error !== undefined) {
    renderedBody = (
      <div className="chg-viewer-state">
        <Callout tone="err">
          <div className="chg-state-stack">
            <div className="break-word">{error}</div>
            {onRetry !== undefined ? (
              <Button size="xs" icon="rotate-cw" onClick={onRetry}>
                {t(CHG_COPY.retry)}
              </Button>
            ) : null}
          </div>
        </Callout>
      </div>
    )
  } else if (result !== undefined) {
    if (result.kind === 'binary') {
      renderedBody = (
        <div className="chg-viewer-state">
          <Callout tone="warn" title={t(CHG_COPY.binaryFileTitle)}>
            <div className="chg-state-stack">
              <div>{t(CHG_COPY.binaryFileDesc)}</div>
              {result.size !== undefined ? (
                <div className="mono text-muted">{chgBytesLabel(result.size)}</div>
              ) : null}
              {gitCommand !== undefined ? <CopyButton text={gitCommand} label={t(CHG_COPY.copyCommand)} /> : null}
            </div>
          </Callout>
        </div>
      )
    } else if (result.kind === 'too_large') {
      renderedBody = (
        <div className="chg-viewer-state">
          <Callout tone="warn" title={t(CHG_COPY.tooLargeTitle)}>
            <div className="chg-state-stack">
              <div>
                {result.reason === 'line_budget_exceeded'
                  ? t(CHG_COPY.tooLargeLineReason)
                  : t(CHG_COPY.tooLargeByteReason)}
              </div>
              <div className="chg-too-large-stats mono tabular-nums">
                <span className="chg-stat-add">{`+${result.additions}`}</span>
                <span className="chg-stat-del">{`−${result.deletions}`}</span>
                {result.size !== undefined ? <span className="text-muted">{chgBytesLabel(result.size)}</span> : null}
              </div>
              {gitCommand !== undefined ? (
                <div className="chg-command-row">
                  <code className="mono chg-command-code">{gitCommand}</code>
                  <CopyButton text={gitCommand} label={t(CHG_COPY.copyCommand)} />
                </div>
              ) : null}
            </div>
          </Callout>
        </div>
      )
    } else if (result.kind === 'special_file') {
      renderedBody = (
        <div className="chg-viewer-state">
          <Callout tone="warn" title={t(CHG_COPY.specialFileTitle)}>
            <div>{chgSpecialFileDetail(result.fileKind, locale)}</div>
          </Callout>
        </div>
      )
    } else if (result.kind === 'absent') {
      renderedBody = (
        <div className="chg-viewer-state">
          <EmptyState compact title={t(CHG_COPY.absentFileTitle)} />
        </div>
      )
    } else if (result.kind === 'unchanged' || (decoratedHunks.length === 0 && (result.kind === 'diff' || result.kind === 'untracked'))) {
      renderedBody = (
        <div className="chg-viewer-state">
          <EmptyState compact title={t(CHG_COPY.unchangedFileTitle)} />
        </div>
      )
    } else {
      let remainingBudget = expanded ? Number.MAX_SAFE_INTEGER : FOLD_THRESHOLD_ROWS
      const hiddenCount = Math.max(0, totalRows - FOLD_THRESHOLD_ROWS)
      renderedBody = (
        <div className="chg-diff-surface selectable">
          {result.kind === 'untracked' ? (
            <div className="chg-diff-banner">{t(CHG_COPY.untrackedBadge)}</div>
          ) : null}
          <div className="chg-diff-table">
            {decoratedHunks.map((hunk, hIdx) => {
              if (remainingBudget <= 0) return null
              const slice = hunk.rows.slice(0, remainingBudget)
              remainingBudget -= slice.length
              return (
                <Fragment key={hIdx}>
                  <div className="chg-diff-hunk mono">{hunk.header}</div>
                  {slice.map((row, rIdx) => (
                    <DiffLineRow key={`${hIdx}:${rIdx}`} row={row} />
                  ))}
                </Fragment>
              )
            })}
            {hiddenCount > 0 ? (
              <div className="chg-diff-fold-bar">
                <Button
                  variant="inline"
                  size="xs"
                  icon={expanded ? 'chevron-up' : 'chevron-down'}
                  onClick={() => setExpandedFileKey((cur) => (cur === currentKey ? undefined : currentKey))}
                >
                  {expanded ? chgCollapseDiff(locale) : chgExpandRemaining(hiddenCount, locale)}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      )
    }
  }

  return (
    <div className="chg-viewer">
      <div className="chg-viewer-head">
        <div className="chg-viewer-head-main">
          {onBack !== undefined ? (
            <Button
              variant="ghost"
              size="xs"
              icon="arrow-left"
              className="chg-mobile-back"
              onClick={onBack}
            >
              {t(CHG_COPY.backToFiles)}
            </Button>
          ) : null}
          <Badge tone={statusBadgeTone(effectiveStatus)}>{statusLabelText(effectiveStatus, locale)}</Badge>
          <div className="chg-viewer-path mono" title={effectiveOldPath ? `${effectiveOldPath} -> ${filePath}` : filePath}>
            {effectiveOldPath !== undefined ? (
              <>
                <span className="text-muted">{`${effectiveOldPath} -> `}</span>
                <span className="chg-viewer-filename">{filePath}</span>
              </>
            ) : (
              <>
                {dir !== '' ? <span className="text-muted">{dir}</span> : null}
                <span className="chg-viewer-filename">{name}</span>
              </>
            )}
          </div>
          {additions !== undefined && deletions !== undefined ? (
            <span className="chg-viewer-stats mono tabular-nums">
              <span className="chg-stat-add">{`+${additions}`}</span>
              <span className="chg-stat-del">{`−${deletions}`}</span>
            </span>
          ) : null}
        </div>
        <div className="chg-viewer-head-actions">
          <CopyButton text={filePath} label={t(CHG_COPY.copyPath)} />
          {headerActions}
        </div>
      </div>
      <div className="chg-viewer-body">{renderedBody}</div>
    </div>
  )
}
