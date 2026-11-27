/**
 * 产物 / 工作区文件预览弹窗共用的内容种类推导（纯函数，无组件导出）。
 */
import { isMarkdown, looksLikeText, shouldDecodeText } from '../artifact-preview-text.js'
import { detectLanguage } from '../code-language.js'

export interface FilePreviewKind {
  isImage: boolean
  isAudio: boolean
  isVideo: boolean
  isPdf: boolean
  /** 是否按文本解码渲染（MIME 文本类，或按文件名命中已知文本后缀）。 */
  isTextLike: boolean
  markdown: boolean
  /** 代码高亮语言；Markdown 源码模式固定 markdown。 */
  language: string
}

/** 按显示名与 MIME 推导预览种类（图片 / 音视频 / PDF / 文本 / Markdown 与高亮语言）。 */
export function deriveFilePreviewKind(name: string | undefined, mime: string): FilePreviewKind {
  const isImage = mime.startsWith('image/')
  const isAudio = mime.startsWith('audio/')
  const isVideo = mime.startsWith('video/')
  const isPdf = mime === 'application/pdf'
  const isTextLike =
    !isImage &&
    !isAudio &&
    !isVideo &&
    !isPdf &&
    (looksLikeText(mime) || isMarkdown(name, mime) || shouldDecodeText({ name }, mime))
  const markdown = isMarkdown(name, mime)
  return {
    isImage,
    isAudio,
    isVideo,
    isPdf,
    isTextLike,
    markdown,
    language: markdown ? 'markdown' : detectLanguage(name, mime),
  }
}
