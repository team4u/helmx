/**
 * Landing focus highlight hook for Omnibox deep-link anchors (`data-search-anchor`).
 *
 * Watches the store's transient `searchFocusAnchor` (never persisted to the URL hash),
 * locates `[data-search-anchor="<anchorId>"]` immediately or via a bounded MutationObserver
 * (for async drawers/forms/lazy chunks), smoothly scrolls it into view (respecting
 * `prefers-reduced-motion`), applies a 1.5s Quiet Surface highlight ring, then clears.
 */
import { useEffect, type RefObject } from 'react'
import { useOptionalSearchFocusAnchor, useOptionalStoreActions } from './store-context.js'

export const SEARCH_FOCUS_HIGHLIGHT_CLASS = 'search-focus-highlight'
export const SEARCH_FOCUS_HIGHLIGHT_MS = 1500
export const SEARCH_FOCUS_OBSERVER_TIMEOUT_MS = 3000

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function findAnchorElement(root: ParentNode, anchorId: string): HTMLElement | null {
  const candidates = root.querySelectorAll<HTMLElement>('[data-search-anchor]')
  for (const el of candidates) {
    if (el.getAttribute('data-search-anchor') === anchorId) return el
  }
  return null
}

function scrollAnchorIntoView(el: HTMLElement): void {
  if (typeof el.scrollIntoView !== 'function') return
  const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth'
  try {
    el.scrollIntoView({ behavior, block: 'center' })
  } catch {
    el.scrollIntoView()
  }
}

export function useSearchFocusAnchor(containerRef?: RefObject<HTMLElement | null>): void {
  const anchor = useOptionalSearchFocusAnchor()
  const actions = useOptionalStoreActions()

  useEffect(() => {
    if (anchor === null || typeof document === 'undefined') return

    const root: ParentNode = containerRef?.current ?? document
    const seqToken = String(anchor.seq)
    let highlightedEl: HTMLElement | null = null
    let highlightTimer: ReturnType<typeof setTimeout> | null = null
    let waitTimer: ReturnType<typeof setTimeout> | null = null
    let observer: MutationObserver | null = null

    const stopObserving = (): void => {
      if (observer !== null) {
        observer.disconnect()
        observer = null
      }
      if (waitTimer !== null) {
        clearTimeout(waitTimer)
        waitTimer = null
      }
    }

    const activate = (el: HTMLElement): void => {
      stopObserving()
      if (el.dataset.searchFocusSeq === seqToken) return
      el.dataset.searchFocusSeq = seqToken
      highlightedEl = el
      scrollAnchorIntoView(el)
      el.classList.add(SEARCH_FOCUS_HIGHLIGHT_CLASS)
      highlightTimer = setTimeout(() => {
        highlightTimer = null
        el.classList.remove(SEARCH_FOCUS_HIGHLIGHT_CLASS)
        if (el.dataset.searchFocusSeq === seqToken) {
          delete el.dataset.searchFocusSeq
        }
        actions?.clearSearchFocusAnchor()
      }, SEARCH_FOCUS_HIGHLIGHT_MS)
    }

    const immediate = findAnchorElement(root, anchor.anchorId)
    if (immediate !== null) {
      activate(immediate)
    } else if (typeof MutationObserver === 'function') {
      const targetNode: Node = root instanceof Document ? root.body ?? root.documentElement : root
      observer = new MutationObserver(() => {
        const found = findAnchorElement(root, anchor.anchorId)
        if (found !== null) activate(found)
      })
      observer.observe(targetNode, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-search-anchor'] })
      waitTimer = setTimeout(() => {
        stopObserving()
        actions?.clearSearchFocusAnchor()
      }, SEARCH_FOCUS_OBSERVER_TIMEOUT_MS)
    }

    return () => {
      stopObserving()
      if (highlightTimer !== null) {
        clearTimeout(highlightTimer)
        highlightTimer = null
      }
      if (highlightedEl !== null) {
        highlightedEl.classList.remove(SEARCH_FOCUS_HIGHLIGHT_CLASS)
        if (highlightedEl.dataset.searchFocusSeq === seqToken) {
          delete highlightedEl.dataset.searchFocusSeq
        }
      }
    }
  }, [anchor, actions, containerRef])
}
