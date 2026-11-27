/**
 * Shared happy-dom test harness for @helmx/ui:
 * - Idempotent GlobalRegistrator registration (safe under --test-isolation=none);
 * - Clean DOM & storage reset between tests/files without tearing down the shared Window.
 */
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let registered = false

export function ensureHappyDom(): void {
  if (!registered) {
    if (!GlobalRegistrator.isRegistered && (typeof window === 'undefined' || typeof document === 'undefined')) {
      try {
        GlobalRegistrator.register()
      } catch {
        // Another module in the same shared-process shard already registered happy-dom.
      }
    }
    registered = true
  }
  const g = globalThis as Record<string, unknown>
  g.React = React
  g.IS_REACT_ACT_ENVIRONMENT = true
  if (g.ResizeObserver === undefined) {
    g.ResizeObserver = NoopResizeObserver
  }
}

export function resetHappyDom(): void {
  if (typeof document !== 'undefined') {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    document.body.innerHTML = ''
    for (const attr of Array.from(document.body.attributes)) {
      document.body.removeAttribute(attr.name)
    }
    document.head.innerHTML = ''
    document.title = ''
    for (const attr of Array.from(document.documentElement.attributes)) {
      document.documentElement.removeAttribute(attr.name)
    }
  }
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.clear()
    } catch {
      // Ignore storage access errors in synthetic environments
    }
    try {
      window.sessionStorage.clear()
    } catch {
      // Ignore storage access errors in synthetic environments
    }
    try {
      window.history.replaceState(null, '', '/')
    } catch {
      // Ignore history access errors in synthetic environments
    }
  }
}
