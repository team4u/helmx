/** Display copy for the builtin:mermaid client (Fast Refresh friendly). */
import { resolveLocalizedText, type HelmxLocale, type LocalizedText } from '@helmx/ui'

export const MERMAID_COPY = {
  zoomIn: { en: 'Zoom in', 'zh-CN': '放大预览' },
  copySource: { en: 'Copy source', 'zh-CN': '复制源码' },
  renderFailed: { en: 'Mermaid render failed', 'zh-CN': 'Mermaid 渲染失败' },
  rendering: { en: 'Rendering Mermaid diagram...', 'zh-CN': '正在渲染 Mermaid 图表...' },
  retry: { en: 'Retry', 'zh-CN': '重试' },
  previewTitle: { en: 'Mermaid preview', 'zh-CN': 'Mermaid 图预览' },
  zoomInTitle: { en: 'Zoom in (+)', 'zh-CN': '放大 (+)' },
  zoomOutTitle: { en: 'Zoom out (-)', 'zh-CN': '缩小 (-)' },
  resetTitle: { en: 'Reset zoom & position (0 / 1)', 'zh-CN': '重置缩放与位置 (0 / 1)' },
  reset: { en: 'Reset', 'zh-CN': '重置' },
  viewSource: { en: 'View source', 'zh-CN': '查看源码' },
  viewDiagram: { en: 'View diagram', 'zh-CN': '查看图形' },
  closeTitle: { en: 'Close (Esc)', 'zh-CN': '关闭 (Esc)' },
  close: { en: 'Close', 'zh-CN': '关闭' },
} as const satisfies Record<string, LocalizedText>

export function mermaidModalStatus(error: string | null, locale: HelmxLocale): string {
  return error !== null
    ? resolveLocalizedText({ en: `Render failed: ${error}`, 'zh-CN': `渲染失败：${error}` }, locale)
    : resolveLocalizedText({ en: 'Rendering…', 'zh-CN': '正在渲染…' }, locale)
}
