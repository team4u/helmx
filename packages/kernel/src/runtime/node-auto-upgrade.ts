/**
 * Hub-side automatic node version-follow coordinator (`node-auto-upgrade.ts`).
 *
 * Policy & invariants:
 * - **A. Hub-pinned version & fail-closed installMode gate**: `getTargetVersion()` (`hubVersion()`)
 *   is the sole target version. Upgrades only when a node's reported strict SemVer satisfies
 *   `version < hubVersion()` AND it explicitly reports `installMode === 'release'`.
 *   Never chases npm `latest`, never lets nodes run ahead, and never auto-downgrades.
 *   Enabled by default; disabled explicitly via `options.autoUpgradeNodes = false` or
 *   `HELMX_AUTO_UPGRADE_NODES=0|false|off|no`.
 *   Nodes reporting `installMode === 'source'` (source/link checkouts) are always exempt
 *   (`source_skipped`), regardless of version lag.
 *   Legacy/unannounced nodes with missing or unknown `installMode` (`installMode !== 'release'`)
 *   fail closed into `unknown_mode` without invoking `upgradeNode`, without arming a retry timer,
 *   and without emitting misleading failure/warning alerts, preventing old source daemons from
 *   being overwritten by npm releases.
 * - **B. Startup & busy gating**:
 *   1. Never upgrades before `isHubReady()` (`KernelRuntime.started`, set after node-join grace,
 *      `pluginHost.start()`, conversation alignment, `harness.resume()`, and `pluginHost.reconcile()`).
 *      Eligible nodes connecting earlier park in `pending` and wake on `onHubReady()`.
 *   2. Before triggering `upgradeNode`, queries `describeNodeBusy(nodeId)` synchronously.
 *      Explicit boundary: covers Hub-tracked conversations bound to the node (active runs,
 *      queued inbox, compactions, settling `turn_settled` hooks), active/pending passthrough
 *      tunnels, active foreground port-forwarding sessions, and in-flight Hub-initiated remote
 *      execs. Does NOT inspect external processes outside Hub; a narrow TOCTOU window after the
 *      Hub check is guarded by the node daemon's own `setDraining(true)` + exec/tunnel drain loop.
 *      Busy nodes stay in `pending` and re-check via a bounded unref'd timer (`busyPollMs`) rather
 *      than wiring a cross-subsystem idle event bus across every workload primitive.
 * - **C. State per `(nodeId, targetVersion)` + backoff retry + dedupe**:
 *   Replaces the old permanent `#autoUpgradeAttempted` blacklist. Recoverable failures (network,
 *   npm publish propagation lag, transient offline, unconfirmed restart) record `failed` and retry
 *   with capped exponential backoff while online, or immediately on next reconnect after going
 *   offline. Terminal capabilities (`source_mode`, `unknown_mode`, `not_supported`) are skipped
 *   terminally for the `(nodeId, targetVersion)` pair (a `source_skipped` or `unknown_mode` node
 *   that later reconnects as `release` clears the skip). Concurrent triggers while `upgrading` are
 *   strictly deduplicated.
 * - **D. Observability**:
 *   Every state transition (`pending` / `upgrading` / `failed` / `source_skipped` / `unknown_mode`
 *   / `not_supported` / cleared on convergence) updates `statusOf(nodeId)` (projected onto
 *   `NodeInfo.autoUpgrade`), publishes `node.changed`, logs a diagnostic line, and emits
 *   notifications for terminal skips (`info`) and failures (`warning`).
 */
import {
  HelmxError,
  type NodeAutoUpgradePhase,
  type NodeAutoUpgradeStatus,
  type NodeInstallMode,
  type NodeUpgradeResult,
} from '@helmx/protocol'
import { HelmxUpgradeBusyError } from '../env/index.js'
import { compareStrictSemVer, isStrictSemVer } from './semver.js'

export const DEFAULT_AUTO_UPGRADE_BUSY_POLL_MS = 5_000
export const DEFAULT_AUTO_UPGRADE_RETRY_BASE_MS = 30_000
export const DEFAULT_AUTO_UPGRADE_RETRY_MAX_MS = 15 * 60_000

const FALSY_ENV_VALUES = new Set(['0', 'false', 'off', 'no'])

/** Resolve `HELMX_AUTO_UPGRADE_NODES` env flag (enabled by default; `0`/`false`/`off`/`no` disables). */
export function resolveAutoUpgradeNodesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['HELMX_AUTO_UPGRADE_NODES']
  if (raw === undefined) return true
  const normalized = raw.trim().toLowerCase()
  if (normalized === '') return true
  return !FALSY_ENV_VALUES.has(normalized)
}

export interface NodeAutoUpgradeRetryPolicy {
  /** Delay between busy re-checks while a node has active Hub-visible work (default 5_000ms). */
  busyPollMs?: number
  /** Base exponential backoff delay after a recoverable failure (default 30_000ms). */
  retryBaseMs?: number
  /** Maximum exponential backoff cap (default 15 minutes). */
  retryMaxMs?: number
  /** Clock override for deterministic tests (default `Date.now`). */
  now?: () => number
}

export interface NodeAutoUpgradeDeps {
  isEnabled(): boolean
  isHubReady(): boolean
  getTargetVersion(): string
  getOnlineNode(nodeId: string): { version?: string; installMode?: NodeInstallMode } | undefined
  listOnlineNodeIds(): string[]
  hasNode(nodeId: string): boolean
  hasUpgradeInFlight(nodeId: string): boolean
  describeNodeBusy(nodeId: string): string | undefined
  runUpgrade(nodeId: string, targetVersion: string): Promise<NodeUpgradeResult>
  publishNodeChanged(nodeId: string): void
  publishNotification(payload: { level: 'info' | 'warning' | 'error'; title: string; body?: string }): void
  log(message: string): void
  policy?: NodeAutoUpgradeRetryPolicy
}

interface InternalEntry {
  nodeId: string
  targetVersion: string
  status: NodeAutoUpgradePhase
  attempts: number
  updatedAt: number
  nextRetryAt?: number
  reason?: string
  disconnectedSinceFailure: boolean
  notifiedTerminal: boolean
  timer?: NodeJS.Timeout
}

type EvalTrigger = 'connect' | 'hub_ready' | 'timer'

function isSourceModeUpgradeError(error: unknown): boolean {
  if (!(error instanceof HelmxError)) return false
  if (error.code === 'node_upgrade_source_mode') return true
  const details = error.details as { reason?: unknown; nodeError?: { code?: unknown } } | undefined
  return details?.reason === 'source_mode' || details?.nodeError?.code === 'source_mode'
}

function isNotSupportedUpgradeError(error: unknown): boolean {
  return error instanceof HelmxError && error.code === 'node_upgrade_not_supported'
}

function isBusyUpgradeError(error: unknown): boolean {
  if (error instanceof HelmxUpgradeBusyError) return true
  return error instanceof HelmxError && error.code === 'node_upgrade_busy'
}

export class NodeAutoUpgradeCoordinator {
  readonly #deps: NodeAutoUpgradeDeps
  readonly #busyPollMs: number
  readonly #retryBaseMs: number
  readonly #retryMaxMs: number
  readonly #now: () => number
  readonly #entries = new Map<string, InternalEntry>()
  readonly #inflight = new Set<Promise<void>>()
  #disposed = false

  constructor(deps: NodeAutoUpgradeDeps) {
    this.#deps = deps
    const policy = deps.policy ?? {}
    this.#busyPollMs =
      policy.busyPollMs !== undefined && Number.isFinite(policy.busyPollMs) && policy.busyPollMs > 0
        ? policy.busyPollMs
        : DEFAULT_AUTO_UPGRADE_BUSY_POLL_MS
    this.#retryBaseMs =
      policy.retryBaseMs !== undefined && Number.isFinite(policy.retryBaseMs) && policy.retryBaseMs > 0
        ? policy.retryBaseMs
        : DEFAULT_AUTO_UPGRADE_RETRY_BASE_MS
    this.#retryMaxMs =
      policy.retryMaxMs !== undefined && Number.isFinite(policy.retryMaxMs) && policy.retryMaxMs > 0
        ? Math.max(this.#retryBaseMs, policy.retryMaxMs)
        : Math.max(this.#retryBaseMs, DEFAULT_AUTO_UPGRADE_RETRY_MAX_MS)
    this.#now = policy.now ?? Date.now
  }

  /** Snapshot projected onto `NodeInfo.autoUpgrade` (`undefined` when no auto-upgrade state applies). */
  statusOf(nodeId: string): NodeAutoUpgradeStatus | undefined {
    const entry = this.#entries.get(nodeId)
    if (entry === undefined) return undefined
    return {
      status: entry.status,
      targetVersion: entry.targetVersion,
      attempts: entry.attempts,
      updatedAt: entry.updatedAt,
      ...(entry.nextRetryAt !== undefined ? { nextRetryAt: entry.nextRetryAt } : {}),
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    }
  }

  /** Called when a registered BYOM node comes online. */
  onNodeOnline(nodeId: string): void {
    if (this.#disposed) return
    this.#evaluate(nodeId, 'connect')
  }

  /** Called when a BYOM node disconnects. */
  onNodeOffline(nodeId: string): void {
    if (this.#disposed) return
    const entry = this.#entries.get(nodeId)
    if (entry === undefined) return
    // Active upgrade expects the old socket to drop as the replacement candidate takes over.
    if (entry.status === 'upgrading') return
    this.#clearTimer(entry)
    if (entry.status === 'pending') {
      this.#entries.delete(nodeId)
      return
    }
    if (entry.status === 'failed') {
      entry.disconnectedSinceFailure = true
      entry.nextRetryAt = undefined
    }
  }

  /** Called when a node is removed from the Hub token registry. */
  onNodeRemoved(nodeId: string): void {
    const entry = this.#entries.get(nodeId)
    if (entry === undefined) return
    this.#clearTimer(entry)
    this.#entries.delete(nodeId)
  }

  /** Called once `KernelRuntime.start()` completes startup recovery, scheduler resume, and plugin reconcile. */
  onHubReady(): void {
    if (this.#disposed) return
    for (const nodeId of this.#deps.listOnlineNodeIds()) {
      this.#evaluate(nodeId, 'hub_ready')
    }
  }

  /** Dispose coordinator: cancel all pending retry/poll timers and suppress late callbacks. */
  dispose(): void {
    this.#disposed = true
    for (const entry of this.#entries.values()) {
      this.#clearTimer(entry)
    }
    this.#entries.clear()
  }

  #clearTimer(entry: InternalEntry): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
  }

  #scheduleTimer(entry: InternalEntry, delayMs: number): void {
    this.#clearTimer(entry)
    if (this.#disposed) return
    const boundedDelay = Math.max(1, Math.floor(delayMs))
    entry.nextRetryAt = this.#now() + boundedDelay
    const timer = setTimeout(() => {
      if (entry.timer === timer) entry.timer = undefined
      if (this.#disposed) return
      this.#evaluate(entry.nodeId, 'timer')
    }, boundedDelay)
    timer.unref?.()
    entry.timer = timer
  }

  #recordModeSkip(
    nodeId: string,
    targetVersion: string,
    version: string,
    current: InternalEntry | undefined,
    spec: {
      status: 'source_skipped' | 'unknown_mode'
      reason: string
      notificationTitle: string
    },
  ): void {
    const alreadySkipped = current?.status === spec.status && current.targetVersion === targetVersion
    if (current !== undefined) this.#clearTimer(current)
    const prevReason = alreadySkipped ? current.reason : undefined
    const entry: InternalEntry = alreadySkipped
      ? current
      : {
          nodeId,
          targetVersion,
          status: spec.status,
          attempts: 0,
          updatedAt: this.#now(),
          disconnectedSinceFailure: false,
          notifiedTerminal: false,
        }
    entry.status = spec.status
    entry.targetVersion = targetVersion
    entry.updatedAt = this.#now()
    entry.nextRetryAt = undefined
    entry.disconnectedSinceFailure = false
    entry.reason = spec.reason
    this.#entries.set(nodeId, entry)
    if (!alreadySkipped || prevReason !== spec.reason) {
      this.#deps.log(`[node-auto-upgrade] node=${nodeId} status=${spec.status} version=${version} target=${targetVersion}`)
      this.#deps.publishNodeChanged(nodeId)
    }
    if (!entry.notifiedTerminal) {
      entry.notifiedTerminal = true
      this.#deps.publishNotification({
        level: 'info',
        title: spec.notificationTitle,
        body: spec.reason,
      })
    }
  }

  #evaluate(nodeId: string, trigger: EvalTrigger): void {
    if (this.#disposed) return
    if (!this.#deps.isEnabled()) {
      const existing = this.#entries.get(nodeId)
      if (existing !== undefined && existing.status !== 'upgrading') {
        this.#clearTimer(existing)
      }
      return
    }
    const conn = this.#deps.getOnlineNode(nodeId)
    if (conn === undefined) return

    let targetVersion: string
    try {
      targetVersion = this.#deps.getTargetVersion()
    } catch (error) {
      this.#deps.log(
        `[node-auto-upgrade] node=${nodeId} skipped: hub version unavailable (${error instanceof Error ? error.message : String(error)})`,
      )
      return
    }

    const existing = this.#entries.get(nodeId)
    // Concurrency deduplication: never overlap an in-flight upgrade for the same node.
    if (existing !== undefined && existing.status === 'upgrading') {
      return
    }

    // Target version changed (e.g. different Hub release): discard stale per-(nodeId, targetVersion) state.
    if (existing !== undefined && existing.targetVersion !== targetVersion) {
      this.#clearTimer(existing)
      this.#entries.delete(nodeId)
    }

    const current = this.#entries.get(nodeId)

    // Strict SemVer version gate: only upgrade when node version < Hub version (never downgrade, never guess).
    if (conn.version === undefined || !isStrictSemVer(conn.version)) {
      if (current !== undefined) {
        this.#clearTimer(current)
        this.#entries.delete(nodeId)
        this.#deps.publishNodeChanged(nodeId)
      }
      return
    }
    if (compareStrictSemVer(conn.version, targetVersion) >= 0) {
      if (current !== undefined) {
        this.#clearTimer(current)
        this.#entries.delete(nodeId)
        this.#deps.log(`[node-auto-upgrade] node=${nodeId} status=converged version=${conn.version} target=${targetVersion}`)
        this.#deps.publishNodeChanged(nodeId)
      }
      return
    }

    // Source/link mode exemption: always skip npm self-upgrade regardless of version lag.
    if (conn.installMode === 'source') {
      const reason = `source_mode: node ${nodeId} (${conn.version}) runs in source/link mode (Hub ${targetVersion}); update source checkout and restart helmx-node manually`
      this.#recordModeSkip(nodeId, targetVersion, conn.version, current, {
        status: 'source_skipped',
        reason,
        notificationTitle: `Auto-upgrade skipped for source node ${nodeId}`,
      })
      return
    }

    // Fail-closed installMode gate: only nodes explicitly reporting `installMode === 'release'`
    // may auto-upgrade. Older daemons omitting `installMode` (or reporting an unknown value) could
    // be source/link checkouts and must never be overwritten by npm releases.
    const reportedMode: unknown = conn.installMode
    if (reportedMode !== 'release') {
      const modeDetail =
        reportedMode === undefined
          ? 'did not report installMode'
          : `reported unknown installMode (${String(reportedMode)})`
      const reason = `unknown_mode: legacy node ${nodeId} (${conn.version}) ${modeDetail} (Hub ${targetVersion}); auto-upgrade skipped — restart or upgrade helmx-node manually once`
      this.#recordModeSkip(nodeId, targetVersion, conn.version, current, {
        status: 'unknown_mode',
        reason,
        notificationTitle: `Auto-upgrade skipped for legacy node ${nodeId}`,
      })
      return
    }

    // If a node previously skipped as `source_skipped` or `unknown_mode` reconnects as `release`, clear the old skip.
    if (current !== undefined && (current.status === 'source_skipped' || current.status === 'unknown_mode')) {
      this.#clearTimer(current)
      this.#entries.delete(nodeId)
    }

    const activeEntry = this.#entries.get(nodeId)

    // Terminal capability skip (`not_supported`) for this (nodeId, targetVersion).
    if (activeEntry !== undefined && activeEntry.status === 'not_supported') {
      return
    }

    // Respect active backoff window for recoverable failures unless the node went offline and reconnected,
    // or the backoff timer itself fired.
    if (activeEntry !== undefined && activeEntry.status === 'failed') {
      if (trigger === 'connect' && activeEntry.disconnectedSinceFailure) {
        activeEntry.disconnectedSinceFailure = false
        this.#clearTimer(activeEntry)
        activeEntry.nextRetryAt = undefined
      } else if (trigger !== 'timer' && activeEntry.nextRetryAt !== undefined && this.#now() < activeEntry.nextRetryAt) {
        return
      }
    }

    // Hub startup/recovery completion gate: hold off until KernelRuntime.start() converges.
    if (!this.#deps.isHubReady()) {
      const reason = 'waiting for Hub startup and recovery to complete'
      const changed =
        activeEntry === undefined || activeEntry.status !== 'pending' || activeEntry.reason !== reason
      const entry: InternalEntry = activeEntry ?? {
        nodeId,
        targetVersion,
        status: 'pending',
        attempts: 0,
        updatedAt: this.#now(),
        disconnectedSinceFailure: false,
        notifiedTerminal: false,
      }
      this.#clearTimer(entry)
      entry.status = 'pending'
      entry.updatedAt = this.#now()
      entry.nextRetryAt = undefined
      entry.reason = reason
      this.#entries.set(nodeId, entry)
      if (changed) {
        this.#deps.log(`[node-auto-upgrade] node=${nodeId} status=pending target=${targetVersion} reason="${reason}"`)
        this.#deps.publishNodeChanged(nodeId)
      }
      return
    }

    // Busy gate: never interrupt an in-flight manual upgrade or Hub-visible active work bound to this node.
    const busyReason = this.#deps.hasUpgradeInFlight(nodeId)
      ? 'another upgrade is already in progress for this node'
      : this.#deps.describeNodeBusy(nodeId)
    if (busyReason !== undefined) {
      const changed =
        activeEntry === undefined || activeEntry.status !== 'pending' || activeEntry.reason !== busyReason
      const entry: InternalEntry = activeEntry ?? {
        nodeId,
        targetVersion,
        status: 'pending',
        attempts: 0,
        updatedAt: this.#now(),
        disconnectedSinceFailure: false,
        notifiedTerminal: false,
      }
      entry.status = 'pending'
      entry.updatedAt = this.#now()
      entry.reason = busyReason
      this.#entries.set(nodeId, entry)
      this.#scheduleTimer(entry, this.#busyPollMs)
      if (changed) {
        this.#deps.log(
          `[node-auto-upgrade] node=${nodeId} status=pending target=${targetVersion} retryMs=${this.#busyPollMs} reason="${busyReason}"`,
        )
        this.#deps.publishNodeChanged(nodeId)
      }
      return
    }

    // All gates passed: transition synchronously to `upgrading` before awaiting so concurrent triggers deduplicate.
    const entry: InternalEntry = activeEntry ?? {
      nodeId,
      targetVersion,
      status: 'upgrading',
      attempts: 0,
      updatedAt: this.#now(),
      disconnectedSinceFailure: false,
      notifiedTerminal: false,
    }
    this.#clearTimer(entry)
    entry.status = 'upgrading'
    entry.attempts += 1
    entry.updatedAt = this.#now()
    entry.nextRetryAt = undefined
    entry.disconnectedSinceFailure = false
    entry.reason = `upgrading from ${conn.version} to ${targetVersion}`
    this.#entries.set(nodeId, entry)
    this.#deps.log(
      `[node-auto-upgrade] node=${nodeId} status=upgrading version=${conn.version} target=${targetVersion} attempt=${entry.attempts}`,
    )
    this.#deps.publishNodeChanged(nodeId)

    const task = this.#executeUpgrade(nodeId, targetVersion, entry)
    this.#inflight.add(task)
    void task.finally(() => {
      this.#inflight.delete(task)
    })
  }

  async #executeUpgrade(nodeId: string, targetVersion: string, entry: InternalEntry): Promise<void> {
    try {
      await this.#deps.runUpgrade(nodeId, targetVersion)
      if (this.#disposed || this.#entries.get(nodeId) !== entry) return
      this.#clearTimer(entry)
      this.#entries.delete(nodeId)
      this.#deps.log(
        `[node-auto-upgrade] node=${nodeId} status=succeeded target=${targetVersion} attempts=${entry.attempts}`,
      )
      this.#deps.publishNodeChanged(nodeId)
    } catch (error) {
      if (this.#disposed || this.#entries.get(nodeId) !== entry) return
      if (!this.#deps.hasNode(nodeId)) {
        this.#clearTimer(entry)
        this.#entries.delete(nodeId)
        return
      }
      const message = error instanceof Error ? error.message : String(error)

      if (isSourceModeUpgradeError(error)) {
        this.#clearTimer(entry)
        entry.status = 'source_skipped'
        entry.updatedAt = this.#now()
        entry.nextRetryAt = undefined
        entry.reason = message
        this.#deps.log(`[node-auto-upgrade] node=${nodeId} status=source_skipped target=${targetVersion} reason="${message}"`)
        this.#deps.publishNodeChanged(nodeId)
        if (!entry.notifiedTerminal) {
          entry.notifiedTerminal = true
          this.#deps.publishNotification({
            level: 'info',
            title: `Auto-upgrade skipped for source node ${nodeId}`,
            body: message,
          })
        }
        return
      }

      if (isNotSupportedUpgradeError(error)) {
        this.#clearTimer(entry)
        entry.status = 'not_supported'
        entry.updatedAt = this.#now()
        entry.nextRetryAt = undefined
        entry.reason = message
        this.#deps.log(`[node-auto-upgrade] node=${nodeId} status=not_supported target=${targetVersion} reason="${message}"`)
        this.#deps.publishNodeChanged(nodeId)
        if (!entry.notifiedTerminal) {
          entry.notifiedTerminal = true
          this.#deps.publishNotification({
            level: 'warning',
            title: `Auto-upgrade not supported on node ${nodeId}`,
            body: message,
          })
        }
        return
      }

      if (isBusyUpgradeError(error)) {
        entry.status = 'pending'
        entry.updatedAt = this.#now()
        entry.reason = 'another upgrade is already in progress for this node'
        this.#scheduleTimer(entry, this.#busyPollMs)
        this.#deps.log(
          `[node-auto-upgrade] node=${nodeId} status=pending target=${targetVersion} retryMs=${this.#busyPollMs} reason="${entry.reason}"`,
        )
        this.#deps.publishNodeChanged(nodeId)
        return
      }

      // Check if the node actually converged while an unconfirmed/late RPC error was settling.
      const latestConn = this.#deps.getOnlineNode(nodeId)
      if (
        latestConn?.version !== undefined &&
        isStrictSemVer(latestConn.version) &&
        compareStrictSemVer(latestConn.version, targetVersion) >= 0
      ) {
        this.#clearTimer(entry)
        this.#entries.delete(nodeId)
        this.#deps.log(
          `[node-auto-upgrade] node=${nodeId} status=converged version=${latestConn.version} target=${targetVersion}`,
        )
        this.#deps.publishNodeChanged(nodeId)
        return
      }

      // Recoverable failure: exponential backoff while online, or immediate retry on next reconnect if offline.
      const backoffMs = Math.min(this.#retryMaxMs, this.#retryBaseMs * Math.pow(2, Math.min(entry.attempts - 1, 10)))
      entry.status = 'failed'
      entry.updatedAt = this.#now()
      entry.reason = message
      if (latestConn !== undefined) {
        entry.disconnectedSinceFailure = false
        this.#scheduleTimer(entry, backoffMs)
      } else {
        this.#clearTimer(entry)
        entry.disconnectedSinceFailure = true
        entry.nextRetryAt = undefined
      }
      this.#deps.log(
        `[node-auto-upgrade] node=${nodeId} status=failed target=${targetVersion} attempt=${entry.attempts} retryMs=${latestConn !== undefined ? backoffMs : 'on-reconnect'} reason="${message}"`,
      )
      this.#deps.publishNodeChanged(nodeId)
      this.#deps.publishNotification({
        level: 'warning',
        title: `Auto-upgrade failed for node ${nodeId}`,
        body: `${message} (attempt ${entry.attempts}; will retry automatically)`,
      })
    }
  }
}
