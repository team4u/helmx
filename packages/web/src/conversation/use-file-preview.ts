/**
 * Shared state hooks for file/artifact preview modals (pure .ts, Fast Refresh safe).
 */
import { useEffect, useMemo, useState, type RefObject } from 'react'
import { decodePreviewText, shouldDecodeText } from './artifact-preview-text.js'
import {
  buildMarkdownOutline,
  extractMarkdownHeadingLines,
  resolveActiveOutlineEntryId,
  type OutlineHeadingNode,
} from './outline-model.js'

export type FilePreviewLoadState =
  | { phase: 'loading' }
  | { phase: 'loaded'; blob: Blob; blobUrl: string }
  | { phase: 'error'; message: string }

export type FilePreviewTextState = 'idle' | 'decoding' | 'exceeded' | 'binary'

export function useFilePreviewText(
  loadedBlob: Blob | undefined,
  meta: { name?: string } | undefined,
  mime: string,
): { text: string | null; textState: FilePreviewTextState } {
  const [text, setText] = useState<string | null>(null)
  const [textState, setTextState] = useState<FilePreviewTextState>('idle')
  // 仅以「是否需要解码」布尔值作为 effect 依赖：避免元数据对象引用刷新（如产物列表重拉）
  // 导致相同 Blob 被清空重解码并短暂卸载 Markdown 预览视图。
  const wantDecode = loadedBlob !== undefined && shouldDecodeText(meta, mime)

  useEffect(() => {
    if (loadedBlob === undefined) {
      setText(null)
      setTextState('idle')
      return
    }
    if (!wantDecode) {
      setText(null)
      setTextState('binary')
      return
    }
    let cancelled = false
    setText(null)
    setTextState('decoding')
    void decodePreviewText(loadedBlob)
      .then((value) => {
        if (cancelled) return
        if (value === null) {
          setTextState('exceeded')
        } else {
          setText(value)
          setTextState('idle')
        }
      })
      .catch(() => {
        if (!cancelled) setTextState('binary')
      })
    return () => {
      cancelled = true
    }
  }, [loadedBlob, wantDecode])

  return { text, textState }
}

export function useMarkdownOutlineSync(opts: {
  markdown: boolean
  view: 'rich' | 'source'
  text: string | null
  modalBodyRef: RefObject<HTMLDivElement | null>
  markdownPreviewRef: RefObject<HTMLDivElement | null>
  resetKey: string
}): {
  markdownOutline: OutlineHeadingNode[]
  activeMarkdownHeading: number | undefined
  jumpToMarkdownHeading: (headingIndex: number) => void
} {
  const { markdown, view, text, modalBodyRef, markdownPreviewRef, resetKey } = opts
  const [activeMarkdownHeading, setActiveMarkdownHeading] = useState<number | undefined>(undefined)

  const markdownOutline = useMemo(
    () => (markdown && text !== null ? buildMarkdownOutline(text) : []),
    [markdown, text],
  )
  const headingLines = useMemo(
    () => (markdown && text !== null ? extractMarkdownHeadingLines(text) : []),
    [markdown, text],
  )

  useEffect(() => {
    setActiveMarkdownHeading(undefined)
  }, [resetKey, text])

  useEffect(() => {
    if (!markdown || markdownOutline.length === 0) return
    const scrollContainer = modalBodyRef.current
    if (scrollContainer === null) return
    const richContent = view === 'rich' ? markdownPreviewRef.current : null
    if (view === 'rich' && richContent === null) return

    const syncActiveHeading = (): void => {
      const containerTop = scrollContainer.getBoundingClientRect().top
      const offsets: Array<{ entryId: string; top: number }> = []
      if (view === 'rich') {
        for (const heading of richContent!.querySelectorAll<HTMLElement>('[data-heading-index]')) {
          const index = heading.dataset.headingIndex
          if (index !== undefined) {
            offsets.push({ entryId: index, top: heading.getBoundingClientRect().top - containerTop })
          }
        }
      } else {
        for (let headingIndex = 0; headingIndex < headingLines.length; headingIndex++) {
          const lineNum = headingLines[headingIndex]!
          const el = scrollContainer.querySelector<HTMLElement>(`.code-line[data-line="${lineNum}"]`)
          if (el !== null) {
            offsets.push({ entryId: String(headingIndex), top: el.getBoundingClientRect().top - containerTop })
          }
        }
      }
      const activeId = resolveActiveOutlineEntryId(offsets, 48)
      setActiveMarkdownHeading(activeId !== undefined ? Number(activeId) : undefined)
    }

    let frameId = 0
    const onScroll = (): void => {
      if (frameId !== 0) return
      frameId = requestAnimationFrame(() => {
        frameId = 0
        syncActiveHeading()
      })
    }

    syncActiveHeading()
    scrollContainer.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      if (frameId !== 0) cancelAnimationFrame(frameId)
      scrollContainer.removeEventListener('scroll', onScroll)
    }
  }, [markdown, view, markdownOutline.length, headingLines, text, modalBodyRef, markdownPreviewRef])

  const jumpToMarkdownHeading = (headingIndex: number): void => {
    let target: HTMLElement | null | undefined = null
    if (view === 'rich') {
      target = markdownPreviewRef.current?.querySelector<HTMLElement>(`[data-heading-index="${headingIndex}"]`)
    } else {
      const lineNum = headingLines[headingIndex]
      target =
        lineNum !== undefined
          ? modalBodyRef.current?.querySelector<HTMLElement>(`.code-line[data-line="${lineNum}"]`)
          : null
    }
    if (target === null || target === undefined) return
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActiveMarkdownHeading(headingIndex)
  }

  return { markdownOutline, activeMarkdownHeading, jumpToMarkdownHeading }
}
