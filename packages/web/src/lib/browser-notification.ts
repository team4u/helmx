/**
 * Browser Notification API and Service Worker notification boundary wrapper:
 * this is the only module in the whole Web app that touches the global
 * Notification and navigator.serviceWorker. Preferences and the state machine
 * live in store / quiet-notify-model so the remaining layers stay testable
 * under happy-dom and degrade honestly without Notification / in insecure
 * contexts.
 *
 * Desktop prefers the activated Service Worker (unified click-focus and routing
 * semantics) and falls back to `new Notification(...)` when it is inactive or
 * unavailable; Android Chrome (which only allows SW showNotification delivery
 * and forbids the `new Notification` constructor) is probed asynchronously via
 * `getRegistration('/')` for a redelivery while the SW is not cached yet — the
 * synchronous return stays honest either way (false when delivery is
 * unconfirmed).
 */
import type { BrowserNotificationPermission } from '../shell/quiet-notify-model.js'

const SERVICE_WORKER_SCRIPT_URL = '/sw.js'
const SERVICE_WORKER_SCOPE = '/'
const NOTIFICATION_ICON_URL = '/icon-192.png'
const NOTIFICATION_BADGE_URL = '/notification-badge-96.png'
const MAX_CLICK_HANDLERS = 100

export type BrowserNotificationNavigator = (url: string) => void

export interface BrowserNotificationRequest {
  title: string
  body?: string
  /** A new notification with the same tag replaces the old one (no pile-up). */
  tag?: string
  /** Same-origin relative path navigated to on notification click (e.g. `/#/c/123`). */
  url?: string
  onClick?: () => void
}

function reportNotificationBoundaryFailure(context: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error)
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(`[helmx:notification] ${context}: ${reason}`)
  }
}

function getServiceWorkerContainer(): ServiceWorkerContainer | null {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  try {
    const container = navigator.serviceWorker
    if (container == null || typeof container !== 'object') return null
    return container
  } catch (error) {
    reportNotificationBoundaryFailure('navigator.serviceWorker access failed', error)
    return null
  }
}

/**
 * Encapsulates Service Worker registration caches, click handler maps, and
 * external hash navigation injection without leaking test-only globals.
 */
export class BrowserNotificationClient {
  private cachedRegistration: ServiceWorkerRegistration | null = null
  private registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null
  private messageListenerContainer: ServiceWorkerContainer | null = null
  private clickIdSeq = 0
  private swStateGeneration = 0
  private readonly clickHandlers = new Map<string, () => void>()
  private navigator: BrowserNotificationNavigator | null = null

  private readonly handleServiceWorkerMessage = (event: Event): void => {
    const data = (event as MessageEvent<unknown>).data
    if (typeof data !== 'object' || data === null) return
    const payload = data as { type?: unknown; url?: unknown; clickId?: unknown }
    if (payload.type !== 'helmx:notification-click') return

    const clickId = typeof payload.clickId === 'string' && payload.clickId !== '' ? payload.clickId : undefined
    const handler = clickId !== undefined ? this.clickHandlers.get(clickId) : undefined
    if (clickId !== undefined) {
      this.clickHandlers.delete(clickId)
    }
    if (handler !== undefined) {
      handler()
      return
    }
    this.navigateToRelativeHashUrl(payload.url)
  }

  private navigateToRelativeHashUrl(url: unknown): void {
    if (typeof url !== 'string' || !url.startsWith('/#')) return
    this.navigator?.(url)
  }

  private ensureServiceWorkerMessageListener(container: ServiceWorkerContainer): void {
    if (this.messageListenerContainer === container) return
    this.detachMessageListener()
    if (typeof container.addEventListener !== 'function') return
    try {
      container.addEventListener('message', this.handleServiceWorkerMessage)
      this.messageListenerContainer = container
    } catch (error) {
      reportNotificationBoundaryFailure('serviceWorker message listener registration failed', error)
    }
  }

  private detachMessageListener(): void {
    if (
      this.messageListenerContainer !== null &&
      typeof this.messageListenerContainer.removeEventListener === 'function'
    ) {
      try {
        this.messageListenerContainer.removeEventListener('message', this.handleServiceWorkerMessage)
      } catch (error) {
        reportNotificationBoundaryFailure('serviceWorker message listener cleanup failed', error)
      }
    }
    this.messageListenerContainer = null
  }

  private registerClickHandler(onClick: () => void): string {
    const clickId = `helmx-click-${++this.clickIdSeq}`
    this.clickHandlers.set(clickId, onClick)
    while (this.clickHandlers.size > MAX_CLICK_HANDLERS) {
      const oldestKey = this.clickHandlers.keys().next().value
      if (oldestKey === undefined) break
      this.clickHandlers.delete(oldestKey)
    }
    return clickId
  }

  private showViaServiceWorkerRegistration(
    reg: ServiceWorkerRegistration,
    request: BrowserNotificationRequest,
  ): boolean {
    if (reg.active == null || typeof reg.showNotification !== 'function') return false
    const container = getServiceWorkerContainer()
    if (container !== null) this.ensureServiceWorkerMessageListener(container)

    const clickId = request.onClick !== undefined ? this.registerClickHandler(request.onClick) : undefined
    const data: { url: string; clickId?: string } = {
      url: request.url ?? '/',
      ...(clickId !== undefined ? { clickId } : {}),
    }

    try {
      const pending = reg.showNotification(request.title, {
        body: request.body,
        tag: request.tag,
        icon: NOTIFICATION_ICON_URL,
        badge: NOTIFICATION_BADGE_URL,
        data,
      })
      if (pending !== undefined && typeof (pending as Promise<unknown>).catch === 'function') {
        void (pending as Promise<unknown>).catch((error) => {
          if (clickId !== undefined) this.clickHandlers.delete(clickId)
          reportNotificationBoundaryFailure('async reg.showNotification rejected', error)
        })
      }
      return true
    } catch (error) {
      if (clickId !== undefined) this.clickHandlers.delete(clickId)
      reportNotificationBoundaryFailure('reg.showNotification threw', error)
      return false
    }
  }

  private async fallbackViaExistingServiceWorkerRegistration(
    request: BrowserNotificationRequest,
    generation: number,
  ): Promise<void> {
    const container = getServiceWorkerContainer()
    if (container === null || typeof container.getRegistration !== 'function') return
    try {
      let reg = await container.getRegistration(SERVICE_WORKER_SCOPE)
      if (generation !== this.swStateGeneration) return
      if ((reg == null || reg.active == null) && container.ready != null) {
        reg = await container.ready
        if (generation !== this.swStateGeneration) return
      }
      if (reg == null) return
      this.cachedRegistration = reg
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
      this.showViaServiceWorkerRegistration(reg, request)
    } catch (error) {
      reportNotificationBoundaryFailure('fallback serviceWorker getRegistration failed', error)
    }
  }

  /** Registers the host-injected route navigator (typically bound inside HelmxStoreProvider) and returns its disposer. */
  registerNavigator(handler: BrowserNotificationNavigator | null): () => void {
    this.navigator = handler
    return () => {
      if (this.navigator === handler) {
        this.navigator = null
      }
    }
  }

  async registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
    const container = getServiceWorkerContainer()
    if (container === null || typeof container.register !== 'function') return null
    this.ensureServiceWorkerMessageListener(container)

    if (this.cachedRegistration !== null) return this.cachedRegistration
    if (this.registrationPromise !== null) return this.registrationPromise

    const generation = this.swStateGeneration
    let task: Promise<ServiceWorkerRegistration | null> | null = null
    task = (async () => {
      try {
        const reg = await container.register(SERVICE_WORKER_SCRIPT_URL, { scope: SERVICE_WORKER_SCOPE })
        if (generation !== this.swStateGeneration) return null
        this.cachedRegistration = reg ?? null
        return this.cachedRegistration
      } catch (error) {
        reportNotificationBoundaryFailure('serviceWorker register failed', error)
        return null
      } finally {
        if (generation === this.swStateGeneration && this.registrationPromise === task) {
          this.registrationPromise = null
        }
      }
    })()

    this.registrationPromise = task
    return task
  }

  async requestPermission(): Promise<BrowserNotificationPermission> {
    if (typeof Notification === 'undefined') return 'unsupported'
    let permission: BrowserNotificationPermission
    try {
      const outcome = await Notification.requestPermission()
      permission = outcome ?? readBrowserNotificationPermission()
    } catch (error) {
      reportNotificationBoundaryFailure('Notification.requestPermission threw', error)
      permission = readBrowserNotificationPermission()
    }
    if (
      permission === 'granted' &&
      this.cachedRegistration === null &&
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator
    ) {
      void this.registerServiceWorker()
    }
    return permission
  }

  showNotification(request: BrowserNotificationRequest): boolean {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false

    if (
      this.cachedRegistration !== null &&
      this.cachedRegistration.active != null &&
      typeof this.cachedRegistration.showNotification === 'function'
    ) {
      return this.showViaServiceWorkerRegistration(this.cachedRegistration, request)
    }

    try {
      const notification = new Notification(request.title, {
        body: request.body,
        tag: request.tag,
        icon: NOTIFICATION_ICON_URL,
      })
      const onClick = request.onClick
      if (onClick !== undefined) {
        notification.onclick = () => {
          window.focus()
          onClick()
        }
      } else if (typeof request.url === 'string' && request.url.startsWith('/#')) {
        const targetUrl = request.url
        notification.onclick = () => {
          window.focus()
          this.navigateToRelativeHashUrl(targetUrl)
        }
      }
      return true
    } catch (error) {
      reportNotificationBoundaryFailure('new Notification fallback threw', error)
      const container = getServiceWorkerContainer()
      if (container !== null && typeof container.getRegistration === 'function') {
        void this.fallbackViaExistingServiceWorkerRegistration(request, this.swStateGeneration)
      }
      return false
    }
  }

  /** Releases cached Service Worker state, click handlers, registered navigator, and message listener bindings. */
  reset(): void {
    this.swStateGeneration += 1
    this.cachedRegistration = null
    this.registrationPromise = null
    this.clickHandlers.clear()
    this.clickIdSeq = 0
    this.navigator = null
    this.detachMessageListener()
  }
}

export function createBrowserNotificationClient(): BrowserNotificationClient {
  return new BrowserNotificationClient()
}

export const browserNotificationClient = createBrowserNotificationClient()

export function registerBrowserNotificationNavigator(handler: BrowserNotificationNavigator | null): () => void {
  return browserNotificationClient.registerNavigator(handler)
}

export function registerBrowserNotificationServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  return browserNotificationClient.registerServiceWorker()
}

/** Read the current notification permission; hosts without the Notification API return 'unsupported'. */
export function readBrowserNotificationPermission(): BrowserNotificationPermission {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

/**
 * Whether the current page is foreground-active and focused:
 * - no document (non-DOM/SSR environment) returns false;
 * - otherwise the page must be visible (!document.hidden) and the window
 *   focused (document.hasFocus()).
 */
export function isPageActive(): boolean {
  if (typeof document === 'undefined') return false
  return !document.hidden && (typeof document.hasFocus === 'function' ? document.hasFocus() : false)
}

export function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
  return browserNotificationClient.requestPermission()
}

/** Deliver one browser notification; returns true once delivery is confirmed as started, false when unauthorized or unconfirmed. */
export function showBrowserNotification(request: BrowserNotificationRequest): boolean {
  return browserNotificationClient.showNotification(request)
}
