/**
 * Hub-side TCP listener & EnvFabric tunnel forwarding manager for `builtin:port-forward`.
 *
 * Design guarantees:
 * - Orthogonal state: when `rule.enabled` is true, Hub always holds the local TCP
 *   listener open regardless of whether the remote node is currently online (so the
 *   port cannot be hijacked by unrelated processes during transient disconnects);
 * - Per-rule serial lock (`createKeyedQueue`) prevents concurrent start/stop/reconcile/
 *   delete races from ever leaking orphaned `net.Server` sockets;
 * - Post-listen race guard checks `disposed` / `paused` / rule match after `server.listen`
 *   completes and closes immediately on race loss;
 * - Throttled transient `runtime` doc (`durable: false`) publishes immediately on
 *   state/error/0<->1 transitions and coalesces steady-state connection count ticks;
 * - `stop()` clears pending timers, aborts dials, destroys active Duplexes & sockets,
 *   awaits all `server.close()` callbacks, drains rule locks, and clears runtime state
 *   inside the stop window before returning.
 */
import net from 'node:net'
import type { Duplex } from 'node:stream'
import {
  HelmxError,
  type HelmxHostApi,
  type PluginDocHandle,
  type PluginInUseItem,
} from '@helmx/protocol'
import { createKeyedQueue, errorMessageOf } from '../shared-helpers.js'
import type {
  PortForwardRule,
  PortForwardRuntimeDoc,
  PortForwardRuntimeEntry,
} from './contracts.js'
import { assertListenHostAllowed } from './validation.js'

const DEFAULT_RUNTIME_THROTTLE_MS = 1000

interface ActiveRuleRuntime {
  ruleId: string
  specKey: string
  ruleSnapshot: PortForwardRule
  server: net.Server
  pendingOpens: Set<AbortController>
  inFlightOpens: Set<Promise<void>>
  /** Every active or closing tunnel Duplex mapped to a Promise that settles on its `'close'` event. */
  liveTunnels: Map<Duplex, Promise<void>>
  activeSockets: Set<net.Socket>
  stopped: boolean
  stopPromise: Promise<void> | undefined
}

export interface PortForwardManagerOptions {
  host: HelmxHostApi
  runtimeDoc: PluginDocHandle<PortForwardRuntimeDoc>
  getRules: () => ReadonlyArray<PortForwardRule>
  getAllowPublicBind: () => boolean
  throttleMs?: number
}

function specKeyOf(rule: PortForwardRule): string {
  return `${rule.nodeId}\0${rule.listenHost}\0${rule.listenPort}\0${rule.targetHost}\0${rule.targetPort}`
}

function emptyRuntimeEntry(): PortForwardRuntimeEntry {
  return {
    listenerState: 'stopped',
    activeConnections: 0,
    totalConnections: 0,
  }
}

function closeNetServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve())
    } catch {
      resolve()
    }
  })
}

/** Track a Duplex's real `'close'` emission (independent of synchronous `stream.closed` flags in Node 24). */
function trackTunnelClose(tunnel: Duplex): Promise<void> {
  if (tunnel.destroyed && tunnel.closed) {
    return new Promise((resolve) => setImmediate(resolve))
  }
  return new Promise((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      tunnel.removeListener('close', done)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, 1_000)
    timer.unref?.()
    tunnel.once('close', done)
  })
}

export class PortForwardManager {
  readonly #host: HelmxHostApi
  readonly #runtimeDoc: PluginDocHandle<PortForwardRuntimeDoc>
  readonly #getRules: () => ReadonlyArray<PortForwardRule>
  readonly #getAllowPublicBind: () => boolean
  readonly #throttleMs: number
  readonly #ruleLocks = createKeyedQueue<string>()
  readonly #runtimes = new Map<string, ActiveRuleRuntime>()
  readonly #entries = new Map<string, PortForwardRuntimeEntry>()

  #disposed = false
  #paused = false
  #flushTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: PortForwardManagerOptions) {
    this.#host = options.host
    this.#runtimeDoc = options.runtimeDoc
    this.#getRules = options.getRules
    this.#getAllowPublicBind = options.getAllowPublicBind
    this.#throttleMs = options.throttleMs ?? DEFAULT_RUNTIME_THROTTLE_MS
  }

  /** Reset lifecycle flags during `service.prepare()` before `reconcile()`. */
  resetForStart(): void {
    this.#disposed = false
    this.#paused = false
  }

  /** Read current transient runtime snapshot for one rule. */
  getRuntimeEntry(ruleId: string): PortForwardRuntimeEntry {
    const entry = this.#entries.get(ruleId)
    return entry === undefined ? emptyRuntimeEntry() : { ...entry }
  }

  /** Report active Hub listeners for `service.inUse()` (`409 plugin_in_use` unless `--force`). */
  inUseItems(): PluginInUseItem[] {
    const out: PluginInUseItem[] = []
    for (const rt of this.#runtimes.values()) {
      if (rt.stopped) continue
      const r = rt.ruleSnapshot
      out.push({
        kind: 'port_forward',
        id: r.id,
        label: `${r.name} (${r.listenHost}:${r.listenPort} -> ${r.nodeId}:${r.targetHost}:${r.targetPort})`,
      })
    }
    return out
  }

  /** Run a per-rule serialized operation (`writeChain -> ruleLock` order respected by callers). */
  runRuleLocked<T>(ruleId: string, fn: () => Promise<T>): Promise<T> {
    return this.#ruleLocks.enqueue(ruleId, fn)
  }

  /**
   * Ensure a rule's listener is active (caller should hold `runRuleLocked(rule.id)`
   * or call through `startRule`).
   */
  async startRule(rule: PortForwardRule, opts: { suppressErrorThrow?: boolean } = {}): Promise<void> {
    return this.#ruleLocks.enqueue(rule.id, () => this.#startRuleUnlocked(rule, opts))
  }

  /** Idempotently stop a rule's listener and drop or reset its runtime state. */
  async stopRule(ruleId: string, opts: { removeEntry?: boolean } = {}): Promise<void> {
    return this.#ruleLocks.enqueue(ruleId, () => this.#stopRuleUnlocked(ruleId, opts))
  }

  /** Remove any transient runtime entry for a rule ID (e.g. after rolling back a failed create). */
  clearEntry(ruleId: string): void {
    if (this.#disposed) return
    if (this.#entries.delete(ruleId)) {
      this.#publishRuntime(true)
    }
  }

  /**
   * Startup reconciliation: start all persisted `enabled` rules after Hub's
   * node-join grace window. Failures on individual rules record `'error'` status
   * without crashing Hub startup.
   */
  async reconcile(): Promise<void> {
    if (this.#disposed) return
    this.#paused = false
    const rules = this.#getRules()
    for (const rule of rules) {
      if (this.#disposed) break
      if (!rule.enabled) continue
      await this.#ruleLocks.enqueue(rule.id, () =>
        this.#startRuleUnlocked(rule, { suppressErrorThrow: true }),
      )
    }
  }

  /**
   * Evict all live listeners and active `openTunnel` Duplex streams in memory so
   * `liveTasks` drops to zero before `reload`/`disable`, while preserving all
   * persisted `enabled: true` flags in `rulesDoc`.
   */
  async pauseAllRuntime(): Promise<{ stoppedListeners: number; closedConnections: number }> {
    this.#paused = true
    const active = [...this.#runtimes.values()].filter((rt) => !rt.stopped)
    const stoppedListeners = active.length
    let closedConnections = 0
    for (const rt of active) {
      closedConnections += rt.liveTunnels.size
    }
    await Promise.allSettled(
      active.map((rt) =>
        this.#ruleLocks.enqueue(rt.ruleId, () => this.#stopRuleUnlocked(rt.ruleId, { removeEntry: false })),
      ),
    )
    this.#publishRuntime(true)
    return { stoppedListeners, closedConnections }
  }

  /**
   * Service teardown: mark disposed, clear timers, close all listeners and tunnels,
   * drain per-rule queues, and reset transient `runtimeDoc` inside the stop window.
   */
  async stop(): Promise<void> {
    this.#disposed = true
    if (this.#flushTimer !== undefined) {
      clearTimeout(this.#flushTimer)
      this.#flushTimer = undefined
    }
    const current = [...this.#runtimes.values()]
    await Promise.allSettled(current.map((rt) => this.#closeActiveRuntime(rt)))
    this.#runtimes.clear()
    this.#entries.clear()
    await this.#ruleLocks.drain()
    this.#runtimeDoc.set({ byId: {} })
  }

  async #startRuleUnlocked(
    rule: PortForwardRule,
    opts: { suppressErrorThrow?: boolean },
  ): Promise<void> {
    if (this.#disposed) return
    this.#paused = false
    const wantedKey = specKeyOf(rule)
    const existing = this.#runtimes.get(rule.id)
    if (existing !== undefined && !existing.stopped) {
      if (existing.specKey === wantedKey) {
        existing.ruleSnapshot = { ...rule }
        return
      }
      await this.#closeActiveRuntime(existing)
      this.#runtimes.delete(rule.id)
    }

    try {
      assertListenHostAllowed(rule.listenHost, this.#getAllowPublicBind())
    } catch (err) {
      const message = this.#redactError(err)
      this.#setErrorEntry(rule.id, message)
      this.#publishRuntime(true)
      if (opts.suppressErrorThrow) return
      throw err
    }

    const pendingOpens = new Set<AbortController>()
    const inFlightOpens = new Set<Promise<void>>()
    const liveTunnels = new Map<Duplex, Promise<void>>()
    const activeSockets = new Set<net.Socket>()
    let runtimeRef: ActiveRuleRuntime | undefined

    const server = net.createServer((socket) => {
      const rt = runtimeRef
      if (rt === undefined || rt.stopped || this.#disposed) {
        socket.destroy()
        return
      }
      socket.on('error', () => undefined)
      const entry = this.#ensureEntry(rule.id)
      entry.totalConnections += 1

      const controller = new AbortController()
      pendingOpens.add(controller)
      let socketGone = false
      const onSocketGone = (): void => {
        socketGone = true
        controller.abort()
      }
      socket.once('close', onSocketGone)
      socket.once('error', onSocketGone)

      const openTask = (async () => {
        let tunnel: Duplex | undefined
        try {
          tunnel = await this.#host.openTunnel(
            rule.nodeId,
            { host: rule.targetHost, port: rule.targetPort },
            controller.signal,
          )
        } catch (err) {
          if (!socketGone && !rt.stopped && !this.#disposed) {
            const currentEntry = this.#ensureEntry(rule.id)
            const msg = this.#redactError(err)
            const changed = currentEntry.lastError !== msg
            currentEntry.lastError = msg
            if (changed) this.#publishRuntime(true)
          }
          socket.destroy()
          return
        } finally {
          pendingOpens.delete(controller)
          socket.removeListener('close', onSocketGone)
          socket.removeListener('error', onSocketGone)
        }

        const tunnelClosed = trackTunnelClose(tunnel).finally(() => {
          liveTunnels.delete(tunnel!)
        })
        liveTunnels.set(tunnel, tunnelClosed)

        if (socketGone || rt.stopped || this.#disposed) {
          tunnel.destroy()
          socket.destroy()
          await tunnelClosed
          return
        }

        activeSockets.add(socket)
        const activeEntry = this.#ensureEntry(rule.id)
        const prevActive = activeEntry.activeConnections
        const hadError = activeEntry.lastError !== undefined
        activeEntry.activeConnections = prevActive + 1
        delete activeEntry.lastError
        this.#publishRuntime(prevActive === 0 || hadError)

        let cleaned = false
        const cleanup = (): void => {
          if (cleaned) return
          cleaned = true
          socket.removeListener('close', cleanup)
          socket.removeListener('error', cleanup)
          tunnel!.removeListener('close', cleanup)
          tunnel!.removeListener('error', cleanup)
          activeSockets.delete(socket)
          socket.destroy()
          tunnel!.destroy()
          if (!rt.stopped && !this.#disposed) {
            const cur = this.#entries.get(rule.id)
            if (cur !== undefined) {
              cur.activeConnections = Math.max(0, cur.activeConnections - 1)
              this.#publishRuntime(cur.activeConnections === 0)
            }
          }
        }
        socket.once('close', cleanup)
        socket.once('error', cleanup)
        tunnel.once('close', cleanup)
        tunnel.once('error', cleanup)
        socket.pipe(tunnel)
        tunnel.pipe(socket)
      })()
      inFlightOpens.add(openTask)
      void openTask.finally(() => {
        inFlightOpens.delete(openTask)
      })
    })

    try {
      await new Promise<void>((resolve, reject) => {
        const onListenError = (err: NodeJS.ErrnoException): void => {
          reject(
            new HelmxError(
              'port_forward_listen_failed',
              `Failed to listen on ${rule.listenHost}:${rule.listenPort}: ${err.message}`,
              409,
              {
                ruleId: rule.id,
                listenHost: rule.listenHost,
                listenPort: rule.listenPort,
                ...(err.code !== undefined ? { code: err.code } : {}),
              },
            ),
          )
        }
        server.once('error', onListenError)
        server.listen(
          {
            host: rule.listenHost,
            port: rule.listenPort,
            ...(rule.listenHost === '::' ? { ipv6Only: true } : {}),
          },
          () => {
            server.removeListener('error', onListenError)
            server.on('error', (err) => {
              if (this.#disposed || runtimeRef?.stopped) return
              const cur = this.#ensureEntry(rule.id)
              cur.lastError = this.#redactError(err)
              this.#publishRuntime(true)
            })
            resolve()
          },
        )
      })
    } catch (err) {
      await closeNetServer(server)
      if (!this.#disposed) {
        this.#setErrorEntry(rule.id, this.#redactError(err))
        this.#publishRuntime(true)
      }
      if (opts.suppressErrorThrow) return
      throw err
    }

    // Post-listen race check: never publish a listener if disposed/paused/superseded mid-bind.
    if (this.#disposed || this.#paused) {
      await closeNetServer(server)
      return
    }

    const rt: ActiveRuleRuntime = {
      ruleId: rule.id,
      specKey: wantedKey,
      ruleSnapshot: { ...rule },
      server,
      pendingOpens,
      inFlightOpens,
      liveTunnels,
      activeSockets,
      stopped: false,
      stopPromise: undefined,
    }
    runtimeRef = rt
    this.#runtimes.set(rule.id, rt)

    const prev = this.#entries.get(rule.id)
    const entry: PortForwardRuntimeEntry = {
      listenerState: 'listening',
      activeConnections: 0,
      totalConnections: prev?.totalConnections ?? 0,
      startedAt: Date.now(),
    }
    this.#entries.set(rule.id, entry)
    this.#publishRuntime(true)
  }

  async #stopRuleUnlocked(ruleId: string, opts: { removeEntry?: boolean }): Promise<void> {
    const rt = this.#runtimes.get(ruleId)
    if (rt !== undefined) {
      await this.#closeActiveRuntime(rt)
      if (this.#runtimes.get(ruleId) === rt) {
        this.#runtimes.delete(ruleId)
      }
    }
    if (this.#disposed) return
    if (opts.removeEntry) {
      this.#entries.delete(ruleId)
    } else {
      const prev = this.#entries.get(ruleId)
      this.#entries.set(ruleId, {
        listenerState: 'stopped',
        activeConnections: 0,
        totalConnections: prev?.totalConnections ?? 0,
      })
    }
    this.#publishRuntime(true)
  }

  #closeActiveRuntime(rt: ActiveRuleRuntime): Promise<void> {
    if (rt.stopPromise !== undefined) return rt.stopPromise
    rt.stopped = true
    rt.stopPromise = (async () => {
      for (const controller of [...rt.pendingOpens]) {
        controller.abort()
      }
      rt.pendingOpens.clear()
      const tunnelCloses: Array<Promise<void>> = []
      for (const [tunnel, closedPromise] of rt.liveTunnels) {
        tunnelCloses.push(closedPromise)
        tunnel.destroy()
      }
      for (const socket of [...rt.activeSockets]) {
        socket.destroy()
      }
      rt.activeSockets.clear()
      await Promise.allSettled([
        ...tunnelCloses,
        ...rt.inFlightOpens,
        closeNetServer(rt.server),
      ])
    })()
    return rt.stopPromise
  }

  #ensureEntry(ruleId: string): PortForwardRuntimeEntry {
    let entry = this.#entries.get(ruleId)
    if (entry === undefined) {
      entry = emptyRuntimeEntry()
      this.#entries.set(ruleId, entry)
    }
    return entry
  }

  #setErrorEntry(ruleId: string, lastError: string): void {
    const prev = this.#entries.get(ruleId)
    this.#entries.set(ruleId, {
      listenerState: 'error',
      activeConnections: 0,
      totalConnections: prev?.totalConnections ?? 0,
      lastError,
    })
  }

  #redactError(err: unknown): string {
    return this.#host.redact(errorMessageOf(err))
  }

  #buildSnapshot(): PortForwardRuntimeDoc {
    const byId: Record<string, PortForwardRuntimeEntry> = {}
    for (const [id, entry] of this.#entries) {
      byId[id] = { ...entry }
    }
    return { byId }
  }

  #publishRuntime(immediate: boolean): void {
    if (this.#disposed) return
    if (immediate) {
      if (this.#flushTimer !== undefined) {
        clearTimeout(this.#flushTimer)
        this.#flushTimer = undefined
      }
      this.#runtimeDoc.set(this.#buildSnapshot())
      return
    }
    if (this.#flushTimer !== undefined) return
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined
      if (!this.#disposed) {
        this.#runtimeDoc.set(this.#buildSnapshot())
      }
    }, this.#throttleMs)
    this.#flushTimer.unref?.()
  }
}
