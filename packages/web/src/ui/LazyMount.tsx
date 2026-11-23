import { useEffect, useState, type ReactNode } from 'react'

export interface LazyMountProps {
  children: ReactNode
  /** Minimum height (px) reserved while offscreen to reduce scroll calibration jumps. */
  minHeight?: number
  /** Render inline placeholder (`<span>`) when placed inside phrasing content such as `<p>`. */
  inline?: boolean
  /** Optional className on the placeholder wrapper prior to mount. */
  className?: string
  /** IntersectionObserver rootMargin around the scroll root (defaults to `'400px 0px'`). */
  rootMargin?: string
  /** Lightweight fallback shown before the element enters the near-viewport zone. */
  fallback?: ReactNode
  /** Bypass deferral and mount immediately. */
  eager?: boolean
}

function hasWorkingIntersectionObserver(): boolean {
  if (typeof IntersectionObserver !== 'function') return false
  try {
    // happy-dom ships a stub IntersectionObserver whose observe() is a no-op with
    // "// TODO: Implement" and never delivers entries; treat it as absent unless
    // a test installs a working fake observer.
    if (
      typeof window !== 'undefined' &&
      'happyDOM' in window &&
      IntersectionObserver.prototype.observe.toString().includes('TODO: Implement')
    ) {
      return false
    }
  } catch {
    return false
  }
  return true
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
  onVisible: () => void,
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

  const cleanupTarget = (el: Element): void => {
    const currentMarginMap = byRoot?.get(root)
    const entry = currentMarginMap?.get(rootMargin)
    if (entry === undefined) return
    if (!entry.callbacks.delete(el)) return
    if (typeof entry.observer.unobserve === 'function') {
      entry.observer.unobserve(el)
    }
    if (entry.callbacks.size === 0) {
      entry.observer.disconnect()
      currentMarginMap?.delete(rootMargin)
      if (currentMarginMap !== undefined && currentMarginMap.size === 0) {
        byRoot?.delete(root)
      }
    }
  }

  let poolEntry = byMargin.get(rootMargin)
  if (poolEntry === undefined) {
    const callbacks = new Map<Element, () => void>()
    const observer = new Ctor(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting || entry.intersectionRatio > 0) {
            const cb = callbacks.get(entry.target)
            if (cb !== undefined) {
              cleanupTarget(entry.target)
              cb()
            }
          }
        }
      },
      { root, rootMargin },
    )
    poolEntry = { observer, callbacks }
    byMargin.set(rootMargin, poolEntry)
  }

  poolEntry.callbacks.set(target, onVisible)
  poolEntry.observer.observe(target)
  return () => cleanupTarget(target)
}

/**
 * Near-viewport one-way lazy mount wrapper.
 * Pools a single `IntersectionObserver` per `(scrollRoot, rootMargin)` (with `rootMargin: '400px 0px'` by default)
 * and unwraps directly to `children` once near-visible, never unmounting afterward.
 * Falls back to immediate mounting in SSR / environments without working IO.
 */
export function LazyMount({
  children,
  minHeight,
  inline = false,
  className,
  rootMargin = '400px 0px',
  fallback = null,
  eager = false,
}: LazyMountProps): ReactNode {
  const [mounted, setMounted] = useState<boolean>(() => eager || !hasWorkingIntersectionObserver())
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null)

  useEffect(() => {
    if (eager) {
      setMounted(true)
      return
    }
    if (mounted || slotEl === null) return
    if (!hasWorkingIntersectionObserver()) {
      setMounted(true)
      return
    }
    const root = slotEl.closest('.timeline-scroll') ?? null
    return observeInSharedPool(root, rootMargin, slotEl, () => {
      setMounted(true)
    })
  }, [eager, mounted, slotEl, rootMargin])

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
