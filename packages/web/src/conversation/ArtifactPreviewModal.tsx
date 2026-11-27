import { useEffect, useMemo, useRef, useState } from 'react'
import { artifactsApi } from '../lib/api.js'
import { SegmentedControl } from '@helmx/ui'
import {
  useConversationArtifacts,
  useStoreActions,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { FilePreviewBody } from './FilePreviewBody.js'
import { MarkdownOutlinePopover } from './MarkdownOutlinePopover.js'
import { PreviewModalShell } from './PreviewModalShell.js'
import { deriveFilePreviewKind } from './preview-modal/preview-kind-model.js'
import { usePreviewBlobLoad } from './preview-modal/use-preview-blob-load.js'
import { useFilePreviewText, useMarkdownOutlineSync } from './use-file-preview.js'

export interface ArtifactPreviewModalProps {
  artifactId: string
  conversationId?: number
  onClose: () => void
  /** 强制内联渲染（跳过 body portal；node 测试环境 Radix portal 不可用时用）。 */
  inline?: boolean
}

/**
 * 产物预览弹窗：宿主默认渲染（图片 / 音视频 / PDF / Markdown / 代码高亮 / 纯文本），
 * 文本仅解码 ≤1MiB（超限显式说明，不截断伪装），ObjectURL 及时回收。
 */
export function ArtifactPreviewModal({ artifactId, conversationId, onClose, inline }: ArtifactPreviewModalProps) {
  const convArtifacts = useConversationArtifacts(conversationId)
  const { loadConversationArtifacts, pushNotice } = useStoreActions()
  const { t } = useWebLocale()
  // 产物加载（含代数竞争保护与 ObjectURL 回收）；MIME 回退在渲染时响应式计算，
  // 深链元数据后到不触发重新拉取。
  const state = usePreviewBlobLoad(artifactId, () => artifactsApi.fetchBlob(artifactId))
  const [view, setView] = useState<'rich' | 'source'>('rich')
  const modalBodyRef = useRef<HTMLDivElement | null>(null)
  const markdownPreviewRef = useRef<HTMLDivElement | null>(null)
  const artifactsLoaded = conversationId !== undefined && convArtifacts !== undefined

  // store 可能以浅拷贝对象传入（如测试 rerender），loadArtifacts 引用会每次变化；
  // 经由 ref 调用，避免 effect 因此重触发导致重复加载。
  const loadArtifactsRef = useRef(loadConversationArtifacts)
  loadArtifactsRef.current = loadConversationArtifacts

  // 深链预览所属会话不一定在主屏或分屏中，不能依赖会话面板预先加载元数据。
  useEffect(() => {
    if (conversationId !== undefined && !artifactsLoaded) void loadArtifactsRef.current(conversationId)
  }, [conversationId, artifactsLoaded])

  const meta = useMemo(() => {
    if (conversationId === undefined) return undefined
    return (convArtifacts ?? []).find((a) => a.id === artifactId)
  }, [convArtifacts, conversationId, artifactId])

  // MIME：已加载用真实 Blob.type，否则回退元数据（响应式，深链元数据后到不重新拉取）。
  const mime = state.phase === 'loaded' ? (state.blob.type || meta?.mimeType || '') : (meta?.mimeType ?? '')
  const loadedBlob = state.phase === 'loaded' ? state.blob : undefined
  const { text, textState } = useFilePreviewText(loadedBlob, meta, mime)

  const name = meta?.name ?? artifactId
  const { isTextLike, markdown, language } = deriveFilePreviewKind(meta?.name, mime)

  const { markdownOutline, activeMarkdownHeading, jumpToMarkdownHeading } = useMarkdownOutlineSync({
    markdown,
    active: view === 'rich',
    text,
    modalBodyRef,
    markdownPreviewRef,
    resetKey: artifactId,
  })

  const download = (): void => {
    void artifactsApi.downloadToBrowser(artifactId, name).catch((error: unknown) => pushNotice({ type: 'notification', level: 'error', title: t('conv.artifact.downloadFailed'), body: error instanceof Error ? error.message : String(error) }))
  }

  return (
    <PreviewModalShell
      title={name}
      ariaLabel={t('conv.artifact.previewAria', { name })}
      inline={inline}
      onClose={onClose}
      onDownload={download}
      state={state}
      fallbackSize={meta?.size}
      loadingLabel={t('conv.artifact.loading')}
      errorLabel={state.phase === 'error' ? t('conv.artifact.loadFailed', { message: state.message }) : ''}
      copyText={markdown ? text : undefined}
      modalBodyRef={modalBodyRef}
      headerActions={
        <>
          {markdown && view === 'rich' && markdownOutline.length > 0 ? (
            <MarkdownOutlinePopover
              text={text ?? ''}
              activeHeadingIndex={activeMarkdownHeading}
              onSelectHeading={jumpToMarkdownHeading}
            />
          ) : null}
          {markdown ? (
            <SegmentedControl<'rich' | 'source'>
              value={view}
              onValueChange={(v) => setView(v)}
              aria-label={t('conv.artifact.viewModeAria')}
              items={[
                { value: 'rich', label: t('conv.artifact.viewRich') },
                { value: 'source', label: t('conv.artifact.viewSource') },
              ]}
            />
          ) : null}
        </>
      }
    >
      {state.phase === 'loaded' ? (
        <FilePreviewBody
          name={name}
          mime={mime}
          blobUrl={state.blobUrl}
          text={text}
          textState={textState}
          isTextLike={isTextLike}
          markdown={markdown}
          view={view}
          language={language}
          conversationId={conversationId}
          markdownPreviewRef={markdownPreviewRef}
        />
      ) : null}
    </PreviewModalShell>
  )
}
