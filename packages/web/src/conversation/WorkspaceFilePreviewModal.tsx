import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Badge, SegmentedControl } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { conversationsApi } from '../lib/api.js'
import { useStoreActions } from '../lib/store-context.js'
import { FilePreviewBody } from './FilePreviewBody.js'
import { MarkdownOutlinePopover } from './MarkdownOutlinePopover.js'
import { PreviewModalShell } from './PreviewModalShell.js'
import { deriveFilePreviewKind } from './preview-modal/preview-kind-model.js'
import { usePreviewBlobLoad } from './preview-modal/use-preview-blob-load.js'
import { useFilePreviewText, useMarkdownOutlineSync } from './use-file-preview.js'

export interface WorkspaceFilePreviewModalProps {
  conversationId: number
  path: string
  startLine?: number
  endLine?: number
  onClose: () => void
  /** Force inline rendering (skips body portal in node test environments). */
  inline?: boolean
}

function posixDirname(filePath: string): string | undefined {
  const slashIdx = filePath.lastIndexOf('/')
  if (slashIdx <= 0) return undefined
  return filePath.slice(0, slashIdx)
}

function posixBasename(filePath: string): string {
  const slashIdx = filePath.lastIndexOf('/')
  return slashIdx === -1 ? filePath : filePath.slice(slashIdx + 1)
}

/**
 * Workspace file preview modal: loads `/api/conversations/:id/files/content`
 * and renders media, rich Markdown (with recursive `workspaceBaseDir`), or
 * syntax-highlighted source with optional `#L<start>(-L<end>)` line highlight.
 */
export function WorkspaceFilePreviewModal({
  conversationId,
  path,
  startLine,
  endLine,
  onClose,
  inline,
}: WorkspaceFilePreviewModalProps): ReactNode {
  const { pushNotice } = useStoreActions()
  const { t } = useWebLocale()
  const state = usePreviewBlobLoad(`${conversationId}:${path}`, (signal) =>
    conversationsApi.fetchWorkspaceFileBlob(conversationId, path, true, signal),
  )
  const [view, setView] = useState<'rich' | 'source'>(() => (startLine !== undefined ? 'source' : 'rich'))
  const modalBodyRef = useRef<HTMLDivElement | null>(null)
  const markdownPreviewRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setView(startLine !== undefined ? 'source' : 'rich')
  }, [conversationId, path, startLine])

  const fileName = posixBasename(path)
  const workspaceBaseDir = posixDirname(path)
  const fileMeta = useMemo(() => ({ name: fileName }), [fileName])
  const mime = state.phase === 'loaded' ? state.blob.type : ''
  const loadedBlob = state.phase === 'loaded' ? state.blob : undefined
  const { text, textState } = useFilePreviewText(loadedBlob, fileMeta, mime)
  const { isTextLike, markdown, language } = deriveFilePreviewKind(fileName, mime)

  const { markdownOutline, activeMarkdownHeading, jumpToMarkdownHeading } = useMarkdownOutlineSync({
    markdown,
    active: view === 'rich',
    text,
    modalBodyRef,
    markdownPreviewRef,
    resetKey: `${conversationId}:${path}`,
  })

  const highlightLines = useMemo(
    () => (startLine !== undefined ? { start: startLine, ...(endLine !== undefined ? { end: endLine } : {}) } : undefined),
    [startLine, endLine],
  )

  const lineBadge =
    startLine !== undefined
      ? endLine !== undefined && endLine > startLine
        ? t('conv.workspaceFile.lineRange', { start: startLine, end: endLine })
        : t('conv.workspaceFile.lineSingle', { line: startLine })
      : null

  const download = (): void => {
    void conversationsApi
      .downloadWorkspaceFileToBrowser(conversationId, path, fileName)
      .catch((error: unknown) =>
        pushNotice({
          type: 'notification',
          level: 'error',
          title: t('conv.artifact.downloadFailed'),
          body: error instanceof Error ? error.message : String(error),
        }),
      )
  }

  return (
    <PreviewModalShell
      title={path}
      ariaLabel={t('conv.workspaceFile.previewAria', { path })}
      inline={inline}
      onClose={onClose}
      onDownload={download}
      state={state}
      loadingLabel={t('conv.workspaceFile.loading')}
      errorLabel={state.phase === 'error' ? t('conv.workspaceFile.loadFailed', { message: state.message }) : ''}
      copyText={text}
      modalBodyRef={modalBodyRef}
      headerBadges={
        lineBadge !== null ? (
          <Badge tone="neutral" mono className="tabular-nums">{lineBadge}</Badge>
        ) : undefined
      }
      headerActions={
        markdown ? (
          <>
            {view === 'rich' && markdownOutline.length > 0 ? (
              <MarkdownOutlinePopover
                text={text ?? ''}
                activeHeadingIndex={activeMarkdownHeading}
                onSelectHeading={jumpToMarkdownHeading}
              />
            ) : null}
            <SegmentedControl<'rich' | 'source'>
              value={view}
              onValueChange={(v) => setView(v)}
              aria-label={t('conv.artifact.viewModeAria')}
              items={[
                { value: 'rich', label: t('conv.artifact.viewRich') },
                { value: 'source', label: t('conv.artifact.viewSource') },
              ]}
            />
          </>
        ) : null
      }
    >
      {state.phase === 'loaded' ? (
        <FilePreviewBody
          name={fileName}
          mime={mime}
          blobUrl={state.blobUrl}
          text={text}
          textState={textState}
          isTextLike={isTextLike}
          markdown={markdown}
          view={view}
          language={language}
          conversationId={conversationId}
          workspaceBaseDir={workspaceBaseDir}
          markdownPreviewRef={markdownPreviewRef}
          showLineNumbers={text !== null}
          highlightLines={highlightLines}
        />
      ) : null}
    </PreviewModalShell>
  )
}
