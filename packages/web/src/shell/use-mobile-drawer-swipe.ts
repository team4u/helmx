/**
 * 移动端侧栏滑动手势 Hook：全程 { passive: true } 绑定在壳层容器，不阻塞原生滚动线程。
 * 状态机与全部防误触守卫内聚于 mobile-drawer-gesture.ts。
 */
import { useEffect, useRef, type RefObject } from 'react'
import {
  beginDrawerSwipe,
  endDrawerSwipe,
  hasActiveTextSelection,
  hasBlockingOverlay,
  isSwipeExcludedTarget,
  moveDrawerSwipe,
  type DrawerSwipeSession,
} from './mobile-drawer-gesture.js'

export interface UseMobileDrawerSwipeOptions {
  /** 壳层容器 ref（监听冒泡 touch 事件与作为祖先遍历边界）。 */
  containerRef: RefObject<HTMLElement | null>
  /** 是否启用（仅移动端视口且无主弹窗/抽屉栈时启用）。 */
  enabled: boolean
  /** 当前移动端侧栏是否展开。 */
  sidebarOpen: boolean
  onOpen: () => void
  onClose: () => void
}

export function useMobileDrawerSwipe(options: UseMobileDrawerSwipeOptions): void {
  const { containerRef, enabled, sidebarOpen, onOpen, onClose } = options
  const latestRef = useRef({ sidebarOpen, onOpen, onClose })
  latestRef.current = { sidebarOpen, onOpen, onClose }

  useEffect(() => {
    const el = containerRef.current
    if (!enabled || el === null) return

    let session: DrawerSwipeSession | null = null

    const onTouchStart = (event: TouchEvent): void => {
      session = null
      if (event.touches.length !== 1) return
      const touch = event.touches[0]
      if (touch === undefined) return
      const doc = el.ownerDocument
      const win = doc.defaultView ?? (typeof window !== 'undefined' ? window : null)
      if (hasBlockingOverlay(doc)) return
      if (hasActiveTextSelection(win)) return
      if (isSwipeExcludedTarget(event.target, el)) return
      const viewportWidth = win?.innerWidth ?? el.clientWidth
      session = beginDrawerSwipe({
        x: touch.clientX,
        y: touch.clientY,
        timeMs: event.timeStamp > 0 ? event.timeStamp : Date.now(),
        viewportWidth,
        sidebarOpen: latestRef.current.sidebarOpen,
      })
    }

    const onTouchMove = (event: TouchEvent): void => {
      if (session === null) return
      if (event.touches.length !== 1) {
        session = null
        return
      }
      const touch = event.touches[0]
      if (touch === undefined) {
        session = null
        return
      }
      session = moveDrawerSwipe(session, {
        x: touch.clientX,
        y: touch.clientY,
        timeMs: event.timeStamp > 0 ? event.timeStamp : Date.now(),
      })
      if (session.phase === 'canceled') {
        session = null
      }
    }

    const onTouchEnd = (event: TouchEvent): void => {
      const active = session
      session = null
      if (active === null) return
      const touch = event.changedTouches[0]
      const doc = el.ownerDocument
      const win = doc.defaultView ?? (typeof window !== 'undefined' ? window : null)
      if (hasBlockingOverlay(doc)) return
      const action = endDrawerSwipe(active, {
        x: touch?.clientX ?? active.lastX,
        y: touch?.clientY ?? active.lastY,
        timeMs: event.timeStamp > 0 ? event.timeStamp : Date.now(),
        hasNonCollapsedSelection: hasActiveTextSelection(win),
      })
      if (action === 'open') latestRef.current.onOpen()
      else if (action === 'close') latestRef.current.onClose()
    }

    const onTouchCancel = (): void => {
      session = null
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchCancel, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchCancel)
    }
  }, [containerRef, enabled])
}
