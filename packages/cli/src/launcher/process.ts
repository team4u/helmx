/**
 * Hub process lifecycle owned by the launcher:
 *
 * - `startHub` delegates detached spawning, `Helmx Hub: <url>` listen-line gating, and strict
 *   URL matching to `@helmx/env-io`'s `spawnDetachedHubRelease`, then probes auxiliary health
 *   and atomically persists `hub.pid` + sticky `launch.json`;
 * - `stopHubGraceful` prefers the verified control channel (`stopHubViaControlChannel` in
 *   `@helmx/env-io`), falling back to fail-closed Linux `/proc` start-time identity proof
 *   (`stopHubLocked`);
 * - `lifecycle.lock` serializes every process-state mutation (start/stop and the update
 *   stop→commit→start window via `*Locked` primitives).
 */
import type { ChildProcess } from 'node:child_process';
import process from 'node:process';
import {
  killProcessTree,
  readLogTailBounded,
  spawnDetachedHubRelease,
  stopHubViaControlChannel,
  waitForPidExit,
  withCrossProcessFileLock,
} from '@helmx/env-io';
import { DEFAULTS, assertInstallIsolation, defaultHubDataDir, pathsOf } from './layout.js';
import {
  assertEntryExists,
  persistableLaunchConfig,
  readLaunchConfig,
  readPidRecord,
  readProcessStartTime,
  removePidFileIfMatch,
  resolveEffectiveLaunchConfig,
  writeLaunchConfig,
  writePidRecord,
  type HubPidRecord,
  type LaunchConfig,
} from './records.js';
import { hubHealthUrl, probeHubHealth, type HubHealthStatus } from './health.js';
import { isAliveOf, UsageError, type LauncherIo } from './io.js';
import { readCurrentEntry } from './current.js';

const LOG_TAIL_LINES = 40;

export interface StartHubOptions {
  /** Explicit flags (highest precedence) folded into the effective launch configuration. */
  flags?: LaunchConfig;
  healthTimeoutMs?: number;
  pollMs?: number;
  fetchFn?: typeof fetch;
  /** Receives the spawned hub `ChildProcess` right after spawn (used by foreground `run`). */
  onSpawn?: (child: ChildProcess) => void;
}

export interface StartHubResult {
  pid: number;
  version: string;
  entryPath: string;
  url: string;
  logPath: string;
  logStartOffset: number;
  /** Auxiliary health confirmation; `null` means the probe did not answer (readiness already confirmed by the listen line). */
  health: HubHealthStatus | null;
}

export interface StopHubOptions {
  stopTimeoutMs?: number;
  escalationWaitMs?: number;
  fetchFn?: typeof fetch;
}

export interface StopHubResult {
  wasRunning: boolean;
  pid?: number;
  /** True when the process only exited after `killProcessTree` escalation. */
  escalated: boolean;
  /** True when a dead pid record was found and removed (nothing was running). */
  cleanedStalePid: boolean;
}

/**
 * Held across every process-state mutation (start/stop and the update commit window) so they
 * never interleave on one machine. Uses shared cross-process lock with dead-PID stale recovery.
 */
export async function withLifecycleLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = pathsOf(root).lifecycleLockPath;
  const busyError = (file: string, ownerPid?: number): Error =>
    new UsageError(
      `concurrent lifecycle operation conflict: ${file} already exists${ownerPid !== undefined ? ` (held by pid ${ownerPid})` : ''} (another start/stop/update is in progress, or a previous one crashed); confirm nothing is running and remove the lock file before retrying`,
      'lifecycle_lock_busy',
    );
  return await withCrossProcessFileLock(lockPath, fn, {
    waitMs: 0,
    onBusy: busyError,
    onCorrupt: (file) => busyError(file),
  });
}

/**
 * Refuse to start when a pid record claims a live Hub. A dead record is cleaned up; a live one is
 * verified against the health endpoint (identity confirmation) before being rejected.
 */
async function assertNoLiveHub(
  root: string,
  io: LauncherIo,
  fetchFn: typeof fetch | undefined,
): Promise<void> {
  const existing = await readPidRecord(root);
  if (existing === null) return;
  const isAlive = isAliveOf(io);
  if (!isAlive(existing.pid)) {
    await removePidFileIfMatch(root, existing);
    return;
  }
  const health = await probeHubHealth(existing.port, existing.host, {
    fetchFn,
    timeoutMs: DEFAULTS.identityProbeTimeoutMs,
  });
  if (health !== null) {
    throw new UsageError(
      `hub is already running (pid ${existing.pid}, version ${existing.version}, ${hubHealthUrl(existing.port, existing.host)}); use restart or stop first`,
      'hub_already_running',
    );
  }
  throw new UsageError(
    `pid ${existing.pid} is alive, but the hub health endpoint is unreachable (${hubHealthUrl(existing.port, existing.host)}): cannot verify identity safely (possible pid reuse); verify the process manually, stop it directly, or remove ${pathsOf(root).pidPath}`,
    'hub_identity_unverifiable',
  );
}

/**
 * Start the committed Hub release detached; persists `hub.pid` + `launch.json` only after
 * readiness. Unlocked body of `startHub` (update holds `lifecycle.lock` across stop→commit→start).
 */
export async function startHubLocked(root: string, io: LauncherIo, options: StartHubOptions): Promise<StartHubResult> {
  const paths = pathsOf(root);
  const isAlive = isAliveOf(io);
  await assertNoLiveHub(root, io, options.fetchFn);
  const current = await readCurrentEntry(root);
  await assertEntryExists(current.entryPath, `current.json (version ${current.version})`);
  const config = resolveEffectiveLaunchConfig({
    flags: options.flags,
    env: io.env,
    saved: await readLaunchConfig(root),
  });
  assertInstallIsolation(root, config.dataDir, io.env);

  const spawned = await spawnDetachedHubRelease({
    root,
    entryPath: current.entryPath,
    config,
    env: io.env,
    timeoutMs: options.healthTimeoutMs ?? DEFAULTS.healthTimeoutMs,
    pollMs: options.pollMs ?? DEFAULTS.healthPollMs,
    isAlive,
    onSpawn: options.onSpawn,
  });

  try {
    // Auxiliary confirmation only: the listen line already proves the candidate is serving.
    const health = await probeHubHealth(config.port, config.host, {
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
      timeoutMs: DEFAULTS.healthRequestTimeoutMs,
    });
    await writePidRecord(root, {
      pid: spawned.pid,
      launchId: spawned.launchId,
      version: current.version,
      entryPath: current.entryPath,
      port: config.port,
      ...(config.host !== undefined ? { host: config.host } : {}),
      ...(config.dataDir !== undefined ? { dataDir: config.dataDir } : {}),
      startedAt: new Date().toISOString(),
      ...(spawned.startTime !== null ? { startTime: spawned.startTime } : {}),
    });
    await writeLaunchConfig(root, persistableLaunchConfig(config));
    return {
      pid: spawned.pid,
      version: current.version,
      entryPath: current.entryPath,
      url: spawned.listenUrl,
      logPath: spawned.logPath,
      logStartOffset: spawned.logStartOffset,
      health,
    };
  } catch (error) {
    killProcessTree(spawned.pid);
    await waitForPidExit(spawned.pid, 5_000, isAlive).catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    const tail = await readLogTailBounded(paths.hubLogPath, LOG_TAIL_LINES);
    throw new Error(
      `hub failed to become ready: ${reason}${tail !== '' && !reason.includes('---') ? `\n--- ${paths.hubLogPath} last ${LOG_TAIL_LINES} lines ---\n${tail}` : ''}`,
    );
  }
}

/** Public start: one atomic lifecycle-lock section. */
export function startHub(root: string, io: LauncherIo, options: StartHubOptions): Promise<StartHubResult> {
  return withLifecycleLock(root, () => startHubLocked(root, io, options));
}

/**
 * Stop the recorded Hub gracefully; identity is proven before any signal is sent. Unlocked body
 * of `stopHub`.
 */
export async function stopHubLocked(root: string, io: LauncherIo, options?: StopHubOptions): Promise<StopHubResult> {
  const paths = pathsOf(root);
  const isAlive = isAliveOf(io);
  const record = await readPidRecord(root);
  if (record === null) return { wasRunning: false, escalated: false, cleanedStalePid: false };
  if (!isAlive(record.pid)) {
    await removePidFileIfMatch(root, record);
    return { wasRunning: false, escalated: false, cleanedStalePid: true };
  }
  if (record.startTime === undefined) {
    throw new UsageError(
      `pid ${record.pid} cannot be verified as this launcher's hub: the pid record carries no process start-time proof (no /proc start time on this platform or at spawn time), and a health endpoint alone cannot prove the pid was not reused; refusing to signal it — stop the hub from the foreground 'helmx start' session that owns it (Ctrl+C), or verify the process manually, stop it directly, and remove ${paths.pidPath}`,
      'hub_identity_unverifiable',
    );
  }
  const current = await readProcessStartTime(record.pid);
  if (current === null || current !== record.startTime) {
    throw new UsageError(
      `pid ${record.pid} no longer matches the recorded process start time (recorded ${record.startTime}, current ${current ?? 'unavailable'}): the hub exited and the pid was probably reused; refusing to signal it — remove ${paths.pidPath} after verifying, then start the hub again`,
      'hub_identity_unverifiable',
    );
  }
  process.kill(record.pid, 'SIGTERM');
  const stopTimeoutMs = options?.stopTimeoutMs ?? DEFAULTS.stopTimeoutMs;
  if (await waitForPidExit(record.pid, stopTimeoutMs, isAlive)) {
    await removePidFileIfMatch(root, record);
    return { wasRunning: true, pid: record.pid, escalated: false, cleanedStalePid: false };
  }
  killProcessTree(record.pid);
  const escalationWaitMs = options?.escalationWaitMs ?? DEFAULTS.stopEscalationWaitMs;
  if (!(await waitForPidExit(record.pid, escalationWaitMs, isAlive))) {
    throw new Error(
      `hub pid ${record.pid} did not exit within ${stopTimeoutMs}ms graceful budget plus ${escalationWaitMs}ms after escalation; pid file retained for diagnostics (${paths.pidPath})`,
    );
  }
  await removePidFileIfMatch(root, record);
  return { wasRunning: true, pid: record.pid, escalated: true, cleanedStalePid: false };
}

/** Public stop: one atomic lifecycle-lock section. */
export function stopHub(root: string, io: LauncherIo, options?: StopHubOptions): Promise<StopHubResult> {
  return withLifecycleLock(root, () => stopHubLocked(root, io, options));
}

export interface GracefulStopResult extends StopHubResult {
  /** Which stop mechanism actually addressed the hub. */
  via: 'control-channel' | 'pid-proof';
}

/**
 * Unlocked body of `stopHubGraceful`. Tries the verified control channel first (uniform across
 * Linux/macOS/Windows), then falls back to `stopHubLocked` (`/proc` start-time proof).
 */
export async function stopHubGracefulLocked(root: string, io: LauncherIo, options?: StopHubOptions): Promise<GracefulStopResult> {
  const isAlive = isAliveOf(io);
  const record = await readPidRecord(root);
  if (record === null) return { wasRunning: false, escalated: false, cleanedStalePid: false, via: 'pid-proof' };
  if (!isAlive(record.pid)) {
    await removePidFileIfMatch(root, record);
    return { wasRunning: false, escalated: false, cleanedStalePid: true, via: 'pid-proof' };
  }

  const dataDir =
    record.dataDir ??
    resolveEffectiveLaunchConfig({ env: io.env, saved: await readLaunchConfig(root) }).dataDir ??
    defaultHubDataDir(io.env);
  const controlOutcome = await stopHubViaControlChannel({
    dataDir,
    pid: record.pid,
    stopTimeoutMs: options?.stopTimeoutMs ?? DEFAULTS.stopTimeoutMs,
    escalationWaitMs: options?.escalationWaitMs ?? DEFAULTS.stopEscalationWaitMs,
    escalateOnTimeout: true,
    isAlive,
  });
  if (controlOutcome.stopped) {
    await removePidFileIfMatch(root, record);
    return { wasRunning: true, pid: record.pid, escalated: controlOutcome.escalated, cleanedStalePid: false, via: 'control-channel' };
  }

  // Channel unavailable or rejected: proof-based stop (keeps its explicit platform refusal).
  const result = await stopHubLocked(root, io, options);
  return { ...result, via: 'pid-proof' };
}

/** Stop the running Hub gracefully, control channel first, serialized inside `lifecycle.lock`. */
export function stopHubGraceful(root: string, io: LauncherIo, options?: StopHubOptions): Promise<GracefulStopResult> {
  return withLifecycleLock(root, () => stopHubGracefulLocked(root, io, options));
}

export interface RunningHubInfo {
  record: HubPidRecord;
  alive: boolean;
  health: HubHealthStatus | null;
}

/** Read-only snapshot for `status`: pid record liveness plus a short health probe. */
export async function readRunningHub(
  root: string,
  io: LauncherIo,
  fetchFn?: typeof fetch,
): Promise<RunningHubInfo | null> {
  const record = await readPidRecord(root);
  if (record === null) return null;
  const alive = isAliveOf(io)(record.pid);
  const health = alive
    ? await probeHubHealth(record.port, record.host, {
        ...(fetchFn !== undefined ? { fetchFn } : {}),
        timeoutMs: DEFAULTS.identityProbeTimeoutMs,
      })
    : null;
  return { record, alive, health };
}
