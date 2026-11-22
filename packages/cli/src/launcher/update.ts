/**
 * Update orchestration: the launcher-owned commit sequence with candidate readiness gating and
 * rollback. Product policy lives here (activity busy gate, CLI usage errors); every generic
 * mechanism — registry lookup, verified staging, immutable `releases/`, `current.json` /
 * `update-blocked.json` state, `upgrade.lock`, cooldown check, and commit→start→rollback —
 * comes from `@helmx/env-io`.
 *
 * Flow (`upgrade.lock` critical section; stop→commit→start holds `lifecycle.lock` atomically):
 *   resolve target (explicit --version | registry dist-tag) → blocked-cooldown gate
 *   → same-version no-op → downgrade guard → stage candidate (survives deferral)
 *   → [if running] activity check → graceful stop (control channel first, pid-proof fallback)
 *   → `commitAndSwitchHubRelease` (atomic `current.json` → start candidate → rollback + blocked on failure).
 */
import { compareStrictSemver, isStrictSemver, type HubActivityCounts } from '@helmx/protocol';
import {
  commitAndSwitchHubRelease,
  isBlockedVersionActive,
  readBlockedRelease,
  readCurrentRelease,
  resolveBlockedCooldownMs,
  withUpdateLock,
} from '@helmx/env-io';
import { defaultHubUpdateCore, stageHubRelease, type HubUpdateCore } from '@helmx/env-io/hub-payload';
import { defaultHubDataDir, pathsOf } from './layout.js';
import {
  readLaunchConfig,
  readPidRecord,
  resolveEffectiveLaunchConfig,
  type LaunchConfig,
} from './records.js';
import { isAliveOf, UsageError, type LauncherIo } from './io.js';
import { startHubLocked, stopHubGracefulLocked, withLifecycleLock } from './process.js';
import { readHubActivityGate, type HubActivityGate } from './activity.js';

export interface PerformUpdateOptions {
  io: LauncherIo;
  root: string;
  pkgName: string;
  registryUrl?: string;
  /** Explicit target version (strict SemVer). */
  targetVersion?: string;
  /** npm dist-tag channel used when no explicit version is given (default `latest`). */
  tag?: string;
  /** Local tarball install source; requires `targetVersion`. */
  tarballPath?: string;
  force?: boolean;
  /** Start the Hub after committing even when it was not running before. */
  startIfNotRunning?: boolean;
  /** Launch flags for the post-commit start (highest precedence, persisted on success). */
  launchFlags?: LaunchConfig;
  fetchFn?: typeof fetch;
  /** Test seam: port-shaped fake standing in for the real adapter (registry/npm seams). */
  core?: HubUpdateCore;
  healthTimeoutMs?: number;
  pollMs?: number;
  stopTimeoutMs?: number;
  payloadCheckTimeoutMs?: number;
}

export interface UpdateOutcome {
  previousVersion: string | null;
  targetVersion: string;
  /** False when the target already matched current and nothing was staged or restarted. */
  changed: boolean;
  /** True when the Hub was running and was restarted onto the new release. */
  restarted: boolean;
  /** True when the update started the Hub although it was not running before. */
  started: boolean;
  /**
   * Present when the update was deferred by the busy gate: the running hub's activity heartbeat
   * reported live work (AI runs / compactions / queued input / settlement), so nothing was
   * stopped, the active release pointer is untouched and no blocked marker was written,
   * and the next cycle retries (the staged candidate stays cached for it).
   */
  deferred?: { reason: 'hub_busy'; counts: HubActivityCounts };
  pid?: number;
  url?: string;
}

/** Resolve and validate the effective target version (explicit flag, or the registry dist-tag). */
async function resolveTargetVersion(options: PerformUpdateOptions): Promise<string> {
  if (options.tarballPath !== undefined) {
    if (options.targetVersion === undefined) {
      throw new UsageError('--tarball requires an explicit --version to name the staged release', 'tarball_requires_version');
    }
    return options.targetVersion;
  }
  if (options.targetVersion !== undefined) return options.targetVersion;
  const core = options.core ?? defaultHubUpdateCore();
  const latest = await core.fetchLatestVersion(options.pkgName, {
    ...(options.registryUrl !== undefined ? { registryUrl: options.registryUrl } : {}),
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    ...(options.tag !== undefined ? { tag: options.tag } : {}),
  });
  if (!isStrictSemver(latest)) {
    throw new Error(`registry latest version is not strict SemVer: "${latest}"`);
  }
  return latest;
}

/** Read activity for the running process rather than the next launch configuration. */
async function activityGateOf(options: PerformUpdateOptions): Promise<HubActivityGate> {
  const record = await readPidRecord(options.root);
  if (record === null) return { kind: 'unknown', detail: 'the running hub has no pid record' };
  const dataDir = record.dataDir ?? defaultHubDataDir(options.io.env);
  return readHubActivityGate(record, dataDir, options.io);
}

function throwActivityUnverifiable(gate: HubActivityGate & { kind: 'unknown' }): never {
  throw new UsageError(
    `cannot verify hub activity before stopping: ${gate.detail}. The candidate remains staged and the running hub was left alone (pass --force to bypass explicitly)`,
    'hub_activity_unverifiable',
  );
}

export async function performHubUpdate(options: PerformUpdateOptions): Promise<UpdateOutcome> {
  const { io, root } = options;
  const paths = pathsOf(root);
  const core = options.core ?? defaultHubUpdateCore();
  return await withUpdateLock(root, async () => {
    const targetVersion = await resolveTargetVersion(options);
    if (!isStrictSemver(targetVersion)) {
      throw new UsageError(
        `invalid target version: "${targetVersion}" (expected strict x.y.z[-pre][+build] without v prefix)`,
        'invalid_version',
      );
    }

    const blocked = await readBlockedRelease(root);
    if (
      options.force !== true &&
      isBlockedVersionActive(blocked, targetVersion, new Date(), resolveBlockedCooldownMs(io.env))
    ) {
      throw new UsageError(
        `update to ${targetVersion} is blocked since ${blocked!.at} (reason: ${blocked!.reason}); wait for the cooldown, pick another --version, or pass --force`,
        'update_blocked_cooldown',
      );
    }

    const current = await readCurrentRelease(root);
    const previousVersion = current?.version ?? null;
    if (previousVersion === targetVersion && options.force !== true) {
      return { previousVersion, targetVersion, changed: false, restarted: false, started: false };
    }
    if (previousVersion !== null && compareStrictSemver(targetVersion, previousVersion) < 0 && options.force !== true) {
      throw new UsageError(
        `target version ${targetVersion} is older than current ${previousVersion}; pass --force to downgrade deliberately`,
        'downgrade_rejected',
      );
    }

    // Program/data separation guard for staging: effective data dir (flags > env > launch.json > ~/.helmx).
    const effectiveDataDir = resolveEffectiveLaunchConfig({
      ...(options.launchFlags !== undefined ? { flags: options.launchFlags } : {}),
      env: io.env,
      saved: await readLaunchConfig(root),
    }).dataDir ?? defaultHubDataDir(io.env);

    const staged = await stageHubRelease({
      env: io.env,
      core,
      root,
      version: targetVersion,
      pkgName: options.pkgName,
      dataDir: effectiveDataDir,
      ...(options.registryUrl !== undefined ? { registryUrl: options.registryUrl } : {}),
      ...(options.tarballPath !== undefined ? { tarballPath: options.tarballPath } : {}),
      ...(options.force ? { force: true } : {}),
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
      ...(options.payloadCheckTimeoutMs !== undefined ? { payloadCheckTimeoutMs: options.payloadCheckTimeoutMs } : {}),
    });

    // One atomic lifecycle section: wasRunning, stop, commit, candidate start (and rollback)
    // never interleave with concurrent start/stop commands on the same machine.
    return await withLifecycleLock(root, async (): Promise<UpdateOutcome> => {
      const pidRecord = await readPidRecord(root);
      const wasRunning = pidRecord !== null && isAliveOf(io)(pidRecord.pid);
      if (wasRunning && options.force !== true) {
        const gate = await activityGateOf(options);
        if (gate.kind === 'unknown') throwActivityUnverifiable(gate);
        if (gate.kind === 'busy') {
          return {
            previousVersion,
            targetVersion,
            changed: false,
            restarted: false,
            started: false,
            deferred: { reason: 'hub_busy', counts: gate.counts },
          };
        }
      }
      if (wasRunning) {
        await stopHubGracefulLocked(root, io, {
          ...(options.stopTimeoutMs !== undefined ? { stopTimeoutMs: options.stopTimeoutMs } : {}),
          ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
        });
      }

      const startOpts = {
        ...(options.launchFlags !== undefined ? { flags: options.launchFlags } : {}),
        ...(options.healthTimeoutMs !== undefined ? { healthTimeoutMs: options.healthTimeoutMs } : {}),
        ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
        ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
      };
      const { started } = await commitAndSwitchHubRelease({
        root,
        targetVersion,
        targetEntryPath: staged.entryPath,
        previousRecord: current,
        shouldStart: wasRunning || options.startIfNotRunning === true,
        restartPreviousOnRollback: wasRunning,
        logPathHint: paths.hubLogPath,
        startRelease: () => startHubLocked(root, io, startOpts),
        formatRestored: (oldStart, prev) => `rolled back to ${prev.version} (pid ${oldStart.pid}, ${oldStart.url})`,
        onStartError: (healthError) => {
          // A concurrently started hub is not a candidate failure: keep the committed pointer.
          if (healthError instanceof UsageError && healthError.code === 'hub_already_running') {
            return new UsageError(
              `current.json was committed to ${targetVersion}, but another hub instance was started concurrently and was not restarted by this update; stop or restart it manually when convenient`,
              'update_race_with_start',
            );
          }
          return 'rollback';
        },
      });

      if (started === undefined) {
        return { previousVersion, targetVersion, changed: true, restarted: false, started: false };
      }
      return {
        previousVersion,
        targetVersion,
        changed: true,
        restarted: wasRunning,
        started: !wasRunning,
        pid: started.pid,
        url: started.url,
      };
    });
  });
}

export interface HubUpgradeCheckResult {
  currentVersion: string | null;
  latestVersion: string;
  updateAvailable: boolean;
  blocked: { version: string; reason: string; at: string } | null;
}

/** Registry check without touching any state (the `check` command). */
export async function checkHubUpgrade(options: {
  io: LauncherIo;
  root: string;
  pkgName: string;
  registryUrl?: string;
  tag?: string;
  fetchFn?: typeof fetch;
  core?: HubUpdateCore;
}): Promise<HubUpgradeCheckResult> {
  const core = options.core ?? defaultHubUpdateCore();
  const latestVersion = await core.fetchLatestVersion(options.pkgName, {
    ...(options.registryUrl !== undefined ? { registryUrl: options.registryUrl } : {}),
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    ...(options.tag !== undefined ? { tag: options.tag } : {}),
  });
  if (!isStrictSemver(latestVersion)) {
    throw new Error(`registry latest version is not strict SemVer: "${latestVersion}"`);
  }
  const current = await readCurrentRelease(options.root);
  const blocked = await readBlockedRelease(options.root);
  return {
    currentVersion: current?.version ?? null,
    latestVersion,
    updateAvailable: current === null || compareStrictSemver(latestVersion, current.version) > 0,
    blocked,
  };
}
