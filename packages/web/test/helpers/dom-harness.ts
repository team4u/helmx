/**
 * 共享 happy-dom 测试宿主原语：
 * - 不静态引入 @helmx/plugin-client / Radix / react-dom/client，确保需要交互展开 Radix 浮层
 *   的测试可在调用 ensureHappyDom() 后再动态 import 相关模块；
 * - 提供幂等 DOM 注册、跨测试全局/DOM 状态复位、输入控制、微任务/宏任务冲刷与条件等待；JSON 响应构造复用 @helmx/test-kit。
 */
import * as React from 'react'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { resetDomEnvironment } from '@helmx/test-kit'
import type { Root } from 'react-dom/client'
import { resetServerClock } from '../../src/lib/server-clock.js'

let registered = false

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

interface BaselineGlobals {
  fetch: typeof globalThis.fetch
  createObjectURL: typeof URL.createObjectURL
  revokeObjectURL: typeof URL.revokeObjectURL
  Blob: typeof globalThis.Blob
  matchMedia: typeof window.matchMedia
  intersectionObserverDesc: PropertyDescriptor | undefined
  notificationDesc: PropertyDescriptor | undefined
  docHiddenDesc: PropertyDescriptor | undefined
  docVisibilityDesc: PropertyDescriptor | undefined
  navLanguageDesc: PropertyDescriptor | undefined
  navLanguagesDesc: PropertyDescriptor | undefined
  navClipboardDesc: PropertyDescriptor | undefined
}

let baseline: BaselineGlobals | undefined

function captureBaseline(): void {
  if (baseline !== undefined) return
  baseline = {
    fetch: globalThis.fetch,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
    Blob: globalThis.Blob,
    matchMedia: window.matchMedia,
    intersectionObserverDesc: Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver'),
    notificationDesc: Object.getOwnPropertyDescriptor(globalThis, 'Notification'),
    docHiddenDesc: Object.getOwnPropertyDescriptor(document, 'hidden'),
    docVisibilityDesc: Object.getOwnPropertyDescriptor(document, 'visibilityState'),
    navLanguageDesc: Object.getOwnPropertyDescriptor(navigator, 'language'),
    navLanguagesDesc: Object.getOwnPropertyDescriptor(navigator, 'languages'),
    navClipboardDesc: Object.getOwnPropertyDescriptor(navigator, 'clipboard'),
  }
}

function restoreProperty(target: object, key: string, desc: PropertyDescriptor | undefined): void {
  if (desc !== undefined) {
    Object.defineProperty(target, key, desc)
  } else {
    delete (target as Record<string, unknown>)[key]
  }
}

/** 幂等注册 happy-dom 全局宿主并配置 React act 环境与 ResizeObserver 兜底。 */
export function ensureHappyDom(): void {
  if (!registered) {
    if (!GlobalRegistrator.isRegistered && (typeof window === 'undefined' || typeof document === 'undefined')) {
      try {
        GlobalRegistrator.register()
      } catch {
        // 同进程中可能已注册全局 happy-dom 单例
      }
    }
    registered = true
  }
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const g = globalThis as Record<string, unknown>
    // happy-dom exposes an unimplemented stub IntersectionObserver (no-op observe)
    // that would stall IntersectionObserver consumers in tests; remove the stub
    // upfront so SSR/fallback paths run immediately unless a test installs a fake.
    if (
      typeof g.IntersectionObserver === 'function' &&
      String((g.IntersectionObserver as { prototype?: { observe?: unknown } }).prototype?.observe).includes('TODO: Implement')
    ) {
      delete g.IntersectionObserver
    }
    captureBaseline()
  }
  const g = globalThis as Record<string, unknown>
  g.React = React
  g.IS_REACT_ACT_ENVIRONMENT = true
  if (g.ResizeObserver === undefined) {
    g.ResizeObserver = NoopResizeObserver
  }
}

/** 获取 happy-dom 初始注册时的基线 fetch，避免共享进程中捕获前序测试的 mock fetch。 */
export function getBaselineFetch(): typeof globalThis.fetch {
  ensureHappyDom()
  return baseline?.fetch ?? globalThis.fetch
}

/**
 * 复位共享 happy-dom 与常用浏览器全局状态（不卸载全局 Window 单例，安全支持
 * `--test-isolation=none` 跨文件复跑）。
 */
export function resetHappyDom(): void {
  ensureHappyDom()
  if (baseline !== undefined) {
    globalThis.fetch = baseline.fetch
    URL.createObjectURL = baseline.createObjectURL
    URL.revokeObjectURL = baseline.revokeObjectURL
    globalThis.Blob = baseline.Blob
    window.matchMedia = baseline.matchMedia
    restoreProperty(globalThis, 'IntersectionObserver', baseline.intersectionObserverDesc)
    restoreProperty(globalThis, 'Notification', baseline.notificationDesc)
    restoreProperty(document, 'hidden', baseline.docHiddenDesc)
    restoreProperty(document, 'visibilityState', baseline.docVisibilityDesc)
    restoreProperty(navigator, 'language', baseline.navLanguageDesc)
    restoreProperty(navigator, 'languages', baseline.navLanguagesDesc)
    restoreProperty(navigator, 'clipboard', baseline.navClipboardDesc)
  }
  const g = globalThis as Record<string, unknown>
  g.React = React
  g.IS_REACT_ACT_ENVIRONMENT = true
  g.ResizeObserver = NoopResizeObserver
  resetServerClock()

  resetDomEnvironment()
}

/** 向受控 input 或 textarea 写入文本并触发 React 兼容的 input 事件。 */
export function typeIntoControl(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  const tracker = (el as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
  const prev = tracker?.getValue() ?? ''
  setter?.call(el, text)
  tracker?.setValue(prev)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** 在 React act 作用域内冲刷两轮微任务队列，等待 Promise 链路提交。 */
export async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** 在 React act 作用域内推进一轮宏任务（默认 0ms）。 */
export async function flushMacrotask(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms))
  })
}

/**
 * 轮询等待条件成立（默认 5s 超时、2ms 步长），每轮等待包裹在 act 中以便捕获异步 React 更新。
 */
export async function waitForCondition(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 2,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await pred())) {
    if (Date.now() >= deadline) {
      throw new Error(`waitForCondition timed out after ${timeoutMs}ms`)
    }
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
    })
  }
}

export interface MountedDomRoot {
  host: HTMLElement
  rerender: (element: React.ReactElement) => Promise<void>
  unmount: () => void
}

/** 创建挂载节点并用动态导入的 createRoot 渲染 React 元素，返回重渲染与清理句柄。 */
export async function mountDomRoot(element: React.ReactElement): Promise<MountedDomRoot> {
  ensureHappyDom()
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: Root | undefined
  await act(async () => {
    root = createRoot(host)
    root.render(element)
  })
  return {
    host,
    rerender: async (next: React.ReactElement) => {
      await act(async () => {
        root?.render(next)
      })
    },
    unmount: () => {
      if (root !== undefined) {
        act(() => { root?.unmount() })
        root = undefined
      }
      host.remove()
    },
  }
}
