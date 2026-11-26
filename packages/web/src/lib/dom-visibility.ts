/**
 * Pure DOM visibility predicate shared across focus restoration, shortcut
 * guards, AskDock, Composer, and version-watcher dirty checks.
 */
export interface ElementVisibilityOptions {
  /** Stop walking ancestors when reaching `stopAt` (without inspecting `stopAt` itself). */
  stopAt?: Element | null
  /** Treat `inert` ancestors as hidden (used when collecting focusable dialog elements). */
  checkInert?: boolean
  /** Check computed `visibility === 'hidden'` in addition to `display: none`. */
  checkVisibilityStyle?: boolean
}

/**
 * Whether an element is connected and not hidden via `hidden`, `display: none`
 * (covering React `<Activity mode="hidden">`), or optional `inert` / `visibility`.
 */
export function isElementVisibleInDocument(
  el: Element | null,
  options?: ElementVisibilityOptions,
): boolean {
  if (el === null) return false
  const stopAt = options?.stopAt
  if (stopAt === undefined && !el.isConnected) return false
  const win = el.ownerDocument?.defaultView
  const checkInert = options?.checkInert === true
  const checkVisibilityStyle = options?.checkVisibilityStyle === true
  let cur: Element | null = el
  while (cur !== null && cur !== stopAt) {
    if ((cur as HTMLElement).hidden === true) return false
    if (checkInert && cur.hasAttribute('inert')) return false
    if ((cur as HTMLElement).style?.display === 'none') return false
    if (win !== null && win !== undefined) {
      try {
        const computed = win.getComputedStyle(cur)
        if (computed.display === 'none') return false
        if (checkVisibilityStyle && computed.visibility === 'hidden') return false
      } catch {
        /* ignore detached/foreign elements */
      }
    }
    cur = cur.parentElement
  }
  return true
}
