/**
 * Auth, SSE connection metadata, and logout lifecycle controller for HelmxExternalStore.
 */
import type { WebMessageKey } from '../../i18n/catalog.js'
import { authApi, setStoredToken } from '../api.js'
import { errorText } from '../error-text.js'
import { applyUpdater, emptyPlan, shallowEqualAuth } from './helpers.js'
import type { AuthSlice, NotifyPlan, StoreUpdater } from './types.js'

export class StoreAuthController {
  private authState: AuthSlice = {
    authReady: false,
    authConfigured: false,
    authenticated: false,
    authError: null,
    sseConnected: false,
    connectionError: null,
    kernelBootId: null,
  }
  private authCheckEpoch = 0
  private authCheckController: AbortController | null = null
  private logoutImpl: (() => void) | null = null
  private readonly emit: (plan: NotifyPlan) => void
  private readonly tt: (key: WebMessageKey, params?: Record<string, string | number>) => string

  constructor(options: {
    onEmit: (plan: NotifyPlan) => void
    tt: (key: WebMessageKey, params?: Record<string, string | number>) => string
  }) {
    this.emit = options.onEmit
    this.tt = options.tt
  }

  getAuthSlice = (): AuthSlice => this.authState
  getAuthenticated = (): boolean => this.authState.authenticated
  getSseConnected = (): boolean => this.authState.sseConnected

  patchAuth = (patch: Partial<AuthSlice>, plan = emptyPlan(), deferEmit = false): void => {
    const prev = this.authState
    const next: AuthSlice = { ...prev, ...patch }
    if (shallowEqualAuth(prev, next)) return
    this.authState = next
    plan.domains.add('auth')
    plan.domains.add('all')
    if (next.authenticated !== prev.authenticated) plan.domains.add('authenticated')
    if (next.sseConnected !== prev.sseConnected) plan.domains.add('sseConnected')
    if (!deferEmit) this.emit(plan)
  }

  setSseConnected = (update: StoreUpdater<boolean>): void => {
    this.patchAuth({ sseConnected: applyUpdater(this.authState.sseConnected, update) })
  }

  setConnectionError = (update: StoreUpdater<string | null>): void => {
    this.patchAuth({ connectionError: applyUpdater(this.authState.connectionError, update) })
  }

  setKernelBootId = (update: StoreUpdater<string | null>): void => {
    this.patchAuth({ kernelBootId: applyUpdater(this.authState.kernelBootId, update) })
  }

  cancelInFlightAuthCheck(): void {
    this.authCheckEpoch += 1
    this.authCheckController?.abort()
    this.authCheckController = null
  }

  checkAuth = async (): Promise<void> => {
    this.cancelInFlightAuthCheck()
    const epoch = this.authCheckEpoch
    const controller = new AbortController()
    this.authCheckController = controller
    this.patchAuth({ authError: null })
    try {
      const status = await authApi.status({ signal: controller.signal })
      if (epoch !== this.authCheckEpoch || controller.signal.aborted) return
      this.patchAuth({ authConfigured: status.configured, authenticated: status.authenticated, authReady: true })
    } catch (error) {
      if (epoch !== this.authCheckEpoch || controller.signal.aborted) return
      this.patchAuth({
        authReady: true,
        authError: this.tt('shell.auth.kernelConnectFailed', { error: errorText(error) }),
      })
    } finally {
      if (this.authCheckController === controller) {
        this.authCheckController = null
      }
    }
  }

  onAuthenticated = async (token: string): Promise<void> => {
    this.cancelInFlightAuthCheck()
    setStoredToken(token)
    this.patchAuth({ authConfigured: true, authError: null, authenticated: true })
  }

  bindLogout(fn: () => void): () => void {
    this.logoutImpl = fn
    return () => {
      if (this.logoutImpl === fn) this.logoutImpl = null
    }
  }

  logout(fallbackReset: () => void): void {
    if (this.logoutImpl !== null) this.logoutImpl()
    else fallbackReset()
  }
}
