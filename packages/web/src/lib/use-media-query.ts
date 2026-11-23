/**
 * 视口媒体查询 Hook（matchMedia 驱动，SSR 与测试环境安全降级为 false）。
 * 供侧栏区分移动抽屉与桌面常驻形态、Composer 窄屏占位符等响应式渲染语义；不承担业务判定。
 * 订阅回调提升至模块级并按断点缓存，避免每次组件重渲染重复解绑/重绑 MediaQueryList 监听器。
 */
import { useSyncExternalStore } from 'react'
import { COMPACT_MOBILE_MAX_WIDTH, isCompactMobileViewport } from './types.js'

const NOOP_UNSUBSCRIBE = (): void => {}
const SERVER_FALSE = (): boolean => false

function subscribeMediaQuery(query: string, listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return NOOP_UNSUBSCRIBE
  const mql = window.matchMedia(query)
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', listener)
    return () => mql.removeEventListener('change', listener)
  }
  const legacy = mql as unknown as {
    addListener?: (cb: () => void) => void
    removeListener?: (cb: () => void) => void
  }
  if (typeof legacy.addListener === 'function') {
    legacy.addListener(listener)
    return () => legacy.removeListener?.(listener)
  }
  return NOOP_UNSUBSCRIBE
}

const COMPACT_MOBILE_QUERY = `(max-width: ${COMPACT_MOBILE_MAX_WIDTH}px)`

function subscribeCompactMobileViewport(listener: () => void): () => void {
  return subscribeMediaQuery(COMPACT_MOBILE_QUERY, listener)
}

interface MaxWidthQueryStore {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => boolean
}

const maxWidthStoreCache = new Map<number, MaxWidthQueryStore>()

function getMaxWidthQueryStore(maxWidth: number): MaxWidthQueryStore {
  let entry = maxWidthStoreCache.get(maxWidth)
  if (entry === undefined) {
    const query = `(max-width: ${maxWidth}px)`
    entry = {
      subscribe: (listener: () => void) => subscribeMediaQuery(query, listener),
      getSnapshot: () =>
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia(query).matches
          : false,
    }
    maxWidthStoreCache.set(maxWidth, entry)
  }
  return entry
}

/** 当前是否移动端视口（移动抽屉形态语义的总开关；与 isCompactMobileViewport 同口径）。 */
export function useIsMobileViewport(): boolean {
  return useSyncExternalStore(
    subscribeCompactMobileViewport,
    isCompactMobileViewport,
    isCompactMobileViewport,
  )
}

/** 订阅任意 `(max-width: Npx)` 媒体查询（供 Composer 等按阈值响应式切换，模块级订阅稳定）。 */
export function useMaxWidthMediaQuery(maxWidth: number): boolean {
  const store = getMaxWidthQueryStore(maxWidth)
  return useSyncExternalStore(store.subscribe, store.getSnapshot, SERVER_FALSE)
}
