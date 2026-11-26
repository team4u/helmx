import { useEffect, useState, type ReactNode } from 'react'

export interface LazyMountProps {
  children: ReactNode
  /** Minimum height (px) reserved while offscreen to reduce scroll calibration jumps. */
  minHeight?: number
  /** Render inline placeholder (`<span>`) when placed inside phrasing content such as `<p>`. */
  inline?: boolean
  /** Optional className on the placeholder wrapper prior to mount. */
  className?: string
  /** Optional CSS selector matched with `.closest(...)` to bind the observer to a scroll container root. */
  scrollRootSelector?: string
  /** IntersectionObserver rootMargin around the scroll root (defaults to `'400px 0px'`). */
  rootMargin?: string
  /** Lightweight fallback shown before the element enters the near-viewport zone. */
  fallback?: ReactNode
  /** Bypass deferral and mount immediately. */
  eager?: boolean
}

function hasIntersectionObserver(): boolean {
  return typeof IntersectionObserver === 'function'
}

interface SharedObserverPoolEntry {
  observer: IntersectionObserver
  callbacks: Map<Element, () => void>
}

const observerPoolsByCtor = new WeakMap<
  typeof IntersectionObserver,
  Map<Element | null, Map<string, SharedObserverPoolEntry>>
>()

function observeInSharedPool(
  root: Element | null,
  rootMargin: string,
  target: Element,
  onIntersect: () => void,
): () => void {
  const Ctor = IntersectionObserver
  let byRoot = observerPoolsByCtor.get(Ctor)
  if (byRoot === undefined) {
    byRoot = new Map()
    observerPoolsByCtor.set(Ctor, byRoot)
  }
  let byMargin = byRoot.get(root)
  if (byMargin === undefined) {
    byMargin = new Map()
    byRoot.set(root, byMargin)
  }
  let entry = byMargin.get(rootMargin)
  if (entry === undefined) {
    const callbacks = new Map<Element, () => void>()
    const observer = new Ctor(
      (entries) => {
        for (const item of entries) {
          if (!item.isIntersecting) continue
          const cb = callbacks.get(item.target)
          if (cb !== undefined) {
            cleanupTarget(item.target)
            cb()
          }
        }
      },
      { root, rootMargin },
    )
    entry = { observer, callbacks }
    byMargin.set(rootMargin, entry)
  }

  const poolEntry = entry
  const cleanupTarget = (el: Element): void => {
    if (!poolEntry.callbacks.has(el)) return
    poolEntry.callbacks.delete(el)
    poolEntry.observer.unobserve(el)
    if (poolEntry.callbacks.size === 0) {
      poolEntry.observer.disconnect()
      byMargin?.delete(rootMargin)
      if (byMargin !== undefined && byMargin.size === 0) {
        byRoot?.delete(root)
      }
    }
  }

  poolEntry.callbacks.set(target, onIntersect)
  poolEntry.observer.observe(target)
  return () => cleanupTarget(target)
}

/**
 * Near-viewport one-way lazy mount wrapper.
 * Pools a single `IntersectionObserver` per `(scrollRoot, rootMargin)` (with `rootMargin: '400px 0px'` by default)
 * and unwraps directly to `children` once near-visible, never unmounting afterward.
 * Falls back to immediate mounting in SSR / environments without IntersectionObserver.
 */
export function LazyMount({
  children,
  minHeight,
  inline = false,
  className,
  scrollRootSelector,
  rootMargin = '400px 0px',
  fallback = null,
  eager = false,
}: LazyMountProps): ReactNode {
  const [mounted, setMounted] = useState<boolean>(() => eager || !hasIntersectionObserver())
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null)

  useEffect(() => {
    if (eager) {
      setMounted(true)
      return
    }
    if (mounted || slotEl === null) return
    if (!hasIntersectionObserver()) {
      setMounted(true)
      return
    }
    const root = scrollRootSelector !== undefined ? slotEl.closest(scrollRootSelector) : null
    return observeInSharedPool(root, rootMargin, slotEl, () => {
      setMounted(true)
    })
  }, [eager, mounted, slotEl, scrollRootSelector, rootMargin])

  if (mounted) return children

  if (inline) {
    return (
      <span ref={setSlotEl} className={className ? `lazy-mount-inline ${className}` : 'lazy-mount-inline'}>
        {fallback}
      </span>
    )
  }

  return (
    <div
      ref={setSlotEl}
      className={className ? `lazy-mount ${className}` : 'lazy-mount'}
      style={minHeight !== undefined ? { minHeight } : undefined}
    >
      {fallback}
    </div>
  )
}
