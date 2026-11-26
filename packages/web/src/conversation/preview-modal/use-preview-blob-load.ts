/**
 * 产物 / 工作区文件预览弹窗共用的 Blob 加载 Hook（纯 .ts，Fast Refresh 安全）。
 */
import { useEffect, useRef, useState } from 'react'
import type { FilePreviewLoadState } from '../use-file-preview.js'

export type PreviewBlobLoader = (signal: AbortSignal) => Promise<Blob>

/**
 * 按 `resetKey` 加载预览 Blob：每次切换目标先回到 loading，成功创建 ObjectURL，
 * 失败显式落 error（不编造空内容）；清理时标记 cancelled、abort 在途请求并回收 ObjectURL。
 * 加载函数经 ref 调用，调用方无需 useCallback 也不会因引用变化重新触发加载。
 */
export function usePreviewBlobLoad(resetKey: string, load: PreviewBlobLoader): FilePreviewLoadState {
  const [state, setState] = useState<FilePreviewLoadState>({ phase: 'loading' })
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    const controller = new AbortController()
    setState({ phase: 'loading' })
    void loadRef
      .current(controller.signal)
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setState({ phase: 'loaded', blob, blobUrl: objectUrl })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
        }
      })
    return () => {
      cancelled = true
      controller.abort()
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [resetKey])

  return state
}
