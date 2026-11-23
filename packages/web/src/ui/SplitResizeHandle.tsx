/**
 * Desktop vertical split-pane resize handle:
 * - Visual 1px hairline matching Quiet Surface, 9px pointer hit zone;
 * - Supports pointer drag (setPointerCapture), double-click reset to 50/50,
 *   and accessible keyboard resizing (ArrowLeft / ArrowRight / Home / End / Enter / 0);
 * - Fast Refresh compliant (component + TS type exports only).
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  clampSplitRatio,
  DEFAULT_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  SPLIT_RATIO_STEP,
  stepSplitRatio,
} from '../shell/split-ratio-model.js'

export interface SplitResizeHandleProps {
  ratio: number
  containerRef: RefObject<HTMLDivElement | null>
  onChange: (nextRatio: number) => void
  onCommit: (nextRatio: number) => void
  onDraggingChange?: (dragging: boolean) => void
}

export function SplitResizeHandle({
  ratio,
  containerRef,
  onChange,
  onCommit,
  onDraggingChange,
}: SplitResizeHandleProps) {
  const { t } = useWebLocale()
  const [dragging, setDragging] = useState(false)
  const activePointerIdRef = useRef<number | null>(null)
  const latestRatioRef = useRef(ratio)
  latestRatioRef.current = ratio

  const finishDrag = (el: HTMLDivElement, pointerId: number | null) => {
    if (activePointerIdRef.current === null) return
    const activeId = activePointerIdRef.current
    activePointerIdRef.current = null
    if (pointerId !== null && pointerId === activeId) {
      try {
        if (el.hasPointerCapture?.(pointerId)) {
          el.releasePointerCapture(pointerId)
        }
      } catch {
        // Ignore release errors when element unmounted or capture already lost.
      }
    }
    setDragging(false)
    onDraggingChange?.(false)
    onCommit(latestRatioRef.current)
  }

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    activePointerIdRef.current = event.pointerId
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // Fallback gracefully in environments without pointer capture support.
    }
    setDragging(true)
    onDraggingChange?.(true)
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (activePointerIdRef.current === null || event.pointerId !== activePointerIdRef.current) return
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    if (rect.width <= 0) return
    const next = clampSplitRatio((event.clientX - rect.left) / rect.width)
    latestRatioRef.current = next
    onChange(next)
  }

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerId !== activePointerIdRef.current) return
    finishDrag(event.currentTarget, event.pointerId)
  }

  const handleDoubleClick = () => {
    latestRatioRef.current = DEFAULT_SPLIT_RATIO
    onChange(DEFAULT_SPLIT_RATIO)
    onCommit(DEFAULT_SPLIT_RATIO)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null
    if (event.key === 'ArrowLeft') {
      next = stepSplitRatio(ratio, -SPLIT_RATIO_STEP)
    } else if (event.key === 'ArrowRight') {
      next = stepSplitRatio(ratio, SPLIT_RATIO_STEP)
    } else if (event.key === 'Home') {
      next = MIN_SPLIT_RATIO
    } else if (event.key === 'End') {
      next = MAX_SPLIT_RATIO
    } else if (event.key === 'Enter' || event.key === '0') {
      next = DEFAULT_SPLIT_RATIO
    }
    if (next === null) return
    event.preventDefault()
    latestRatioRef.current = next
    onChange(next)
    onCommit(next)
  }

  const percent = Math.round(clampSplitRatio(ratio) * 100)

  return (
    <div
      role="separator"
      tabIndex={0}
      className="helmx-split-resizer"
      aria-orientation="vertical"
      aria-label={t('shell.split.resizeAria')}
      aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)}
      aria-valuemax={Math.round(MAX_SPLIT_RATIO * 100)}
      aria-valuenow={percent}
      title={t('shell.split.resizeHint')}
      data-dragging={dragging ? 'true' : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onLostPointerCapture={(event) => finishDrag(event.currentTarget, null)}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    />
  )
}
