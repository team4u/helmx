/** Fullscreen zoom/pan Mermaid preview modal (Radix Dialog, wheel zoom, pointer-capture pan, Esc close). */
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode, type WheelEvent } from 'react'
import {
  Callout, CopyButton, Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle,
  HelmxIcon, usePluginContext, usePluginLocale, usePluginTranslator,
} from '@helmx/plugin-client'
import { renderMermaidSvg } from './mermaid-loader.ts'
import { MERMAID_COPY as C, mermaidModalStatus } from './copy.ts'

const MIN_SCALE = 0.2
const MAX_SCALE = 4
const STEP = 0.2
const clampScale = (v: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(v.toFixed(2))))

export function MermaidPreviewModal({ code, svg, onClose }: { code: string; svg?: string | null; onClose: () => void }): ReactNode {
  const { theme } = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [view, setView] = useState<'diagram' | 'source'>('diagram')
  const [renderedSvg, setRenderedSvg] = useState<string | null>(svg ?? null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [retryCount, setRetryCount] = useState(0)

  const dragRef = useRef<{ id: number; sx: number; sy: number; bx: number; by: number } | null>(null)
  const seqRef = useRef(0)
  const lastRef = useRef({ theme, code, retryCount })

  useEffect(() => {
    if (svg) { seqRef.current += 1; setRenderedSvg(svg); setError(null) }
  }, [svg])

  useEffect(() => {
    const prev = lastRef.current
    const changed = prev.theme !== theme || prev.code !== code || prev.retryCount !== retryCount
    lastRef.current = { theme, code, retryCount }
    if (svg && !changed) return
    if (changed) { setRenderedSvg(null); setError(null) }
    let cancelled = false
    const seq = ++seqRef.current
    const stale = (): boolean => cancelled || seqRef.current !== seq
    void (async () => {
      try {
        const id = `helmx-mermaid-modal-${theme}-${seq}-${Math.random().toString(36).slice(2, 8)}`
        const out = await renderMermaidSvg({ theme, id, code, isStale: stale })
        if (!stale()) { setRenderedSvg(out); setError(null) }
      } catch (err) {
        if (!stale()) { setRenderedSvg(null); setError(err instanceof Error ? err.message : String(err)) }
      }
    })()
    return () => { cancelled = true }
  }, [code, svg, theme, retryCount])

  const resetView = useCallback(() => { setScale(1); setOffset({ x: 0, y: 0 }) }, [])
  const zoomBy = useCallback((d: number) => setScale((s) => clampScale(s + d)), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === '+' || e.key === '=') zoomBy(STEP)
      else if (e.key === '-' || e.key === '_') zoomBy(-STEP)
      else if (e.key === '0' || e.key === '1') resetView()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomBy, resetView])

  const onWheel = (e: WheelEvent<HTMLDivElement>): void => { e.preventDefault(); zoomBy(e.deltaY < 0 ? STEP : -STEP) }
  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, bx: offset.x, by: offset.y }
    setDragging(true)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (d && d.id === e.pointerId) setOffset({ x: Math.round(d.bx + e.clientX - d.sx), y: Math.round(d.by + e.clientY - d.sy) })
  }
  const endDrag = (e: PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.id !== e.pointerId) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    dragRef.current = null
    setDragging(false)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal>
        <DialogOverlay className="modal-backdrop modal-fullscreen-backdrop">
          <DialogContent className="modal modal-fullscreen" aria-label={t(C.previewTitle)}>
            <div className="modal-header mermaid-modal-header">
              <DialogTitle className="modal-title mermaid-modal-title">{t(C.previewTitle)}</DialogTitle>
              <div className="mermaid-modal-actions">
                <span className="badge badge-neutral mono tabular-nums">{Math.round(scale * 100)}%</span>
                <button type="button" className="btn btn-sm" onClick={() => zoomBy(STEP)} title={t(C.zoomInTitle)}><HelmxIcon name="zoom-in" size={12} /></button>
                <button type="button" className="btn btn-sm" onClick={() => zoomBy(-STEP)} title={t(C.zoomOutTitle)}><HelmxIcon name="zoom-out" size={12} /></button>
                <button type="button" className="btn btn-sm" onClick={resetView} title={t(C.resetTitle)}>{t(C.reset)}</button>
                <button type="button" className="btn btn-sm" onClick={() => setView((v) => (v === 'diagram' ? 'source' : 'diagram'))}>
                  {view === 'diagram' ? t(C.viewSource) : t(C.viewDiagram)}
                </button>
                <CopyButton text={code} label={t(C.copySource)} />
              </div>
              <DialogClose asChild>
                <button type="button" className="btn btn-ghost btn-sm mermaid-modal-close" title={t(C.closeTitle)} aria-label={t(C.close)}>
                  <HelmxIcon name="x" size={13} />
                </button>
              </DialogClose>
            </div>
            <div className="modal-body modal-body-flush">
              {view === 'source' ? (
                <pre className="code-block-pre selectable mermaid-source-pre"><code>{code}</code></pre>
              ) : renderedSvg !== null ? (
                <div
                  className={`mermaid-modal-stage${dragging ? ' is-dragging' : ''}`}
                  onDoubleClick={resetView}
                  onWheel={onWheel}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                >
                  <div className="mermaid-transform-plane" style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})` }}>
                    <div className="mermaid-svg-layer" dangerouslySetInnerHTML={{ __html: renderedSvg }} />
                  </div>
                </div>
              ) : error !== null ? (
                <div className="mermaid-modal-status">
                  <Callout tone="err" title={t(C.renderFailed)}>
                    <div className="mermaid-error-body">
                      <span className="selectable">{error}</span>
                      <div className="mermaid-error-actions">
                        <button type="button" className="btn btn-sm" onClick={() => { setError(null); setRenderedSvg(null); setRetryCount((n) => n + 1) }}>
                          <HelmxIcon name="refresh-cw" size={12} />{t(C.retry)}
                        </button>
                      </div>
                    </div>
                  </Callout>
                </div>
              ) : (
                <div className="mermaid-modal-status">
                  <span className="mermaid-status-hint"><HelmxIcon name="loader" size={14} className="spin-slow" />{mermaidModalStatus(null, locale)}</span>
                </div>
              )}
            </div>
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}
