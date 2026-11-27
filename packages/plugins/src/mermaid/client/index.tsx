/** builtin:mermaid client component: on-demand ```mermaid code-block rendering with lazy fullscreen modal. */
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { Button, Callout, CopyButton, HelmxIcon, LoadingState, usePluginContext, usePluginTranslator } from '@helmx/plugin-client'
import type { MarkdownCodeBlockProps } from '@helmx/protocol/browser'
import { renderMermaidSvg } from './mermaid-loader.ts'
import { MERMAID_COPY as C } from './copy.ts'
import './styles.css'

type ModalComponent = ComponentType<{ code: string; svg: string | null; onClose: () => void }>

let cachedModal: ModalComponent | null = null
const CACHE_LIMIT = 200
const svgCache = new Map<string, string>()

function cacheSvg(key: string, svg: string): void {
  if (svgCache.size >= CACHE_LIMIT) {
    const oldest = svgCache.keys().next().value
    if (oldest !== undefined) svgCache.delete(oldest)
  }
  svgCache.set(key, svg)
}

function LazyMermaidPreviewModal({ code, svg, onClose }: { code: string; svg: string | null; onClose: () => void }): ReactNode {
  const t = usePluginTranslator()
  const [Modal, setModal] = useState<ModalComponent | null>(() => cachedModal)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (Modal !== null) return
    let active = true
    setLoadError(null)
    void import('./MermaidPreviewModal.tsx')
      .then((mod) => {
        if (!active) return
        cachedModal = mod.MermaidPreviewModal as ModalComponent
        setModal(() => cachedModal)
      })
      .catch((err: unknown) => {
        if (active) setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => { active = false }
  }, [Modal, attempt])

  if (Modal !== null) return <Modal code={code} svg={svg} onClose={onClose} />
  if (loadError !== null) {
    return (
      <Callout tone="err" title={t(C.renderFailed)}>
        <div className="mermaid-error-body">
          <span className="selectable">{loadError}</span>
          <div className="mermaid-error-actions">
            <Button variant="secondary" size="sm" icon="refresh-cw" onClick={() => setAttempt((n) => n + 1)}>
              {t(C.retry)}
            </Button>
          </div>
        </div>
      </Callout>
    )
  }
  return <LoadingState label={t(C.rendering)} />
}

export function MermaidCodeBlock({ code }: MarkdownCodeBlockProps): ReactNode {
  const { theme } = usePluginContext()
  const t = usePluginTranslator()
  const [svg, setSvg] = useState<string | null>(() => svgCache.get(`${theme}:${code}`) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [zoomOpen, setZoomOpen] = useState(false)
  const [retryCount, setRetryCount] = useState(0)
  const seqRef = useRef(0)
  const aliveRef = useRef(true)
  const prevRef = useRef({ code, retryCount })

  useEffect(() => {
    aliveRef.current = true
    const seq = ++seqRef.current
    const isStale = (): boolean => !aliveRef.current || seqRef.current !== seq
    const codeChanged = prevRef.current.code !== code
    const retryRequested = prevRef.current.retryCount !== retryCount
    prevRef.current = { code, retryCount }

    const key = `${theme}:${code}`
    const cached = svgCache.get(key)
    if (cached) {
      setSvg(cached)
      setError(null)
      return () => { aliveRef.current = false }
    }
    if (codeChanged || retryRequested) setSvg(null)
    setError(null)

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const id = `helmx-mermaid-${theme}-${seq}-${Math.random().toString(36).slice(2, 8)}`
          const rendered = await renderMermaidSvg({ theme, id, code, isStale })
          if (isStale()) return
          cacheSvg(key, rendered)
          setSvg(rendered)
          setError(null)
        } catch (err) {
          if (!isStale()) {
            setError(err instanceof Error ? err.message : String(err))
            setSvg(null)
          }
        }
      })()
    }, codeChanged ? 250 : 0)
    return () => {
      aliveRef.current = false
      clearTimeout(timer)
    }
  }, [code, theme, retryCount])

  return (
    <div className="code-block-wrap">
      <div className="code-block-header">
        <span>mermaid</span>
        <span className="code-block-header-actions">
          <Button variant="ghost" size="sm" icon="maximize" onClick={() => setZoomOpen(true)} title={t(C.zoomIn)}>
            {t(C.zoomIn)}
          </Button>
          <CopyButton text={code} label={t(C.copySource)} />
        </span>
      </div>
      <div className="mermaid-body selectable">
        {svg !== null ? (
          <div className="mermaid-svg-host" dangerouslySetInnerHTML={{ __html: svg }} />
        ) : error !== null ? (
          <Callout tone="err" title={t(C.renderFailed)}>
            <div className="mermaid-error-body">
              <span className="selectable">{error}</span>
              <div className="mermaid-error-actions">
                <Button variant="secondary" size="sm" icon="refresh-cw" onClick={() => { setError(null); setSvg(null); setRetryCount((n) => n + 1) }}>
                  {t(C.retry)}
                </Button>
              </div>
              <pre className="code-block-pre code-block-pre-flush selectable"><code>{code}</code></pre>
            </div>
          </Callout>
        ) : (
          <div className="mermaid-placeholder">
            <div className="mermaid-loading-row">
              <HelmxIcon name="loader" size={13} className="spin-slow" />
              <span>{t(C.rendering)}</span>
            </div>
            <pre className="code-block-pre code-block-pre-flush selectable mermaid-source-dim"><code>{code}</code></pre>
          </div>
        )}
      </div>
      {zoomOpen && <LazyMermaidPreviewModal code={code} svg={svg} onClose={() => setZoomOpen(false)} />}
    </div>
  )
}
