/** Preserve one visible timeline row across content insertion above the viewport. */
export interface TimelineScrollAnchor {
  element: HTMLElement
  top: number
  bottom?: number
  entryId?: string
  turnTailId?: string
}

function findTimelineAnchorByAttr(
  scroller: HTMLElement,
  selector: string,
  readValue: (el: HTMLElement) => string | undefined,
  expected: string | undefined,
): HTMLElement | undefined {
  if (expected === undefined) return undefined
  for (const el of scroller.querySelectorAll<HTMLElement>(selector)) {
    if (readValue(el) === expected) return el
  }
  return undefined
}

export function captureTimelineScrollAnchor(scroller: HTMLElement): TimelineScrollAnchor | undefined {
  const viewport = scroller.getBoundingClientRect()
  const x = viewport.left + viewport.width / 2
  const sampleYs = [
    viewport.top + Math.min(48, viewport.height / 4),
    viewport.top + viewport.height / 2,
    viewport.bottom - Math.min(24, viewport.height / 8),
  ]
  for (const y of sampleYs) {
    const hit = document.elementFromPoint(x, y)
    const row = hit instanceof HTMLElement ? hit.closest<HTMLElement>('[data-entry-id]') : null
    if (row !== null && scroller.contains(row)) {
      const rect = row.getBoundingClientRect()
      const entryId = row.dataset.entryId
      const turnTailId = row.dataset.turnTailId
      return {
        element: row,
        top: rect.top,
        bottom: rect.bottom,
        ...(entryId !== undefined ? { entryId } : {}),
        ...(turnTailId !== undefined ? { turnTailId } : {}),
      }
    }
  }
  return undefined
}

export function restoreTimelineScrollAnchor(
  scroller: HTMLElement,
  anchor: TimelineScrollAnchor | undefined,
): void {
  if (anchor === undefined) return
  const target =
    anchor.element.isConnected && scroller.contains(anchor.element)
      ? anchor.element
      : findTimelineAnchorByAttr(scroller, '[data-turn-tail-id]', (el) => el.dataset.turnTailId, anchor.turnTailId) ??
        findTimelineAnchorByAttr(scroller, '[data-entry-id]', (el) => el.dataset.entryId, anchor.entryId)
  if (target === undefined) return
  const rect = target.getBoundingClientRect()
  const delta =
    anchor.turnTailId !== undefined && anchor.bottom !== undefined
      ? rect.bottom - anchor.bottom
      : rect.top - anchor.top
  if (Math.abs(delta) > 1) scroller.scrollTop += delta
}
