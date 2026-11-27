/**
 * Update orchestration: check, stage, drain, activate, roll back.
 *
 * `performUpdate` commits strictly at `replacement.commit()`: the state pointer is
 * written first, then the replacement confirms activation. Failure rolls back the
 * pointer and records a cooldown block; `UpgradeCommitUnconfirmedError` (activation
 * was signaled but confirmation was lost) never aborts or rolls back, because the
 * candidate may already have committed upstream.
 *
 * Product policy (what counts as in-flight work, how a replacement is spawned and
 * confirmed) is injected; the mechanism (lock with dead-PID stale recovery, cooldown,
 * drain gate, commit order) lives here. `upgrade.lock` gives cross-process exclusion.
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withCrossProcessFileLock } from '../process-utils.js';
import { UpgradeCommitUnconfirmedError, UpgradeRejectedError } from './errors.js';
import { assertStrictSemver, compareSemver, normalizeTargetVersion } from './semver.js';
import { fetchLatestVersion, resolveRegistryUrl } from './registry.js';
import {
  clearBlockedRelease,
  deleteCurrentRelease,
  isBlockedVersionActive,
  readBlockedRelease,
  readCurrentRelease,
  resolveBlockedCooldownMs,
  writeBlockedRelease,
  writeCurrentRelease,
  type BlockedReleaseRecord,
  type CurrentReleaseRecord,
} from './state.js';
import { stageRelease, type ReleaseLayout, type StageExtractor, type StagedRelease } from './staging.js';

const DRAIN_POLL_INTERVAL_MS = 50;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/** What is being updated: which registry package decides `latest`, plus fallback version hook. */
export interface UpdateSource {
  /** Registry package queried for the `latest` dist-tag (Node: `@helmx/node`; Hub: the payload package). */
  packageName: string;
  /**
   * Current-version fallback when `current.json` is absent and no explicit `currentVersion`
   * was passed (e.g. reading the running package's own `package.json`).
   */
  getFallbackVersion?: () => string;
}

export interface UpdateSpec extends UpdateSource {
  /** Staging layout used when no `stageExtractor` is injected. */
  layout: ReleaseLayout;
}

export interface CheckForUpdateOptions {
  registryUrl?: string;
  currentVersion?: string;
  fetchFn?: typeof fetch;
  /** npm dist-tag to track (`latest` by default; e.g. `beta` for a pre-release channel). */
  tag?: string;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  blocked?: BlockedReleaseRecord;
}

export interface PerformUpdateOptions {
  targetVersion?: string;
  registryUrl?: string;
  force?: boolean;
  attemptId?: string;
  currentVersion?: string;
  fetchFn?: typeof fetch;
  /** npm dist-tag used when resolving the default target version (`latest` unless overridden). */
  tag?: string;
  /** Extra npm install args passed through to staging (consumer policy, e.g. `--ignore-scripts`). */
  npmInstallArgs?: string[];
  /** Overrides npm staging entirely (see `StageExtractor`). */
  stageExtractor?: StageExtractor;
  /**
   * Prepares and activates the replacement process; `commit()` confirms activation,
   * `abort()` kills it. Required — the engine never fabricates a PID.
   */
  prepareReplacement?: (
    release: StagedRelease,
    context: { attemptId: string; previousVersion: string; targetVersion: string },
  ) => Promise<PreparedReplacement>;
  /** Returns count of in-flight operations to drain before activating the replacement. */
  getActiveExecCount?: () => number;
  setDraining?: (value: boolean) => void;
  drainTimeoutMs?: number;
  onScheduleShutdown?: (pid: number) => void;
}

/** A replacement process managed by the consumer; the engine only orchestrates commit/abort. */
export interface PreparedReplacement {
  pid: number;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

export interface UpdateResult {
  ok: boolean;
  previousVersion: string;
  targetVersion: string;
  upgraded: boolean;
  pid?: number;
}

/** Query the registry for the latest version and compare it against the current one. */
export async function checkForUpdate(
  stateDir: string,
  source: UpdateSource,
  options?: CheckForUpdateOptions,
): Promise<UpdateCheckResult> {
  const registryUrl = resolveRegistryUrl(options?.registryUrl);
  const fetchImpl = options?.fetchFn ?? fetch;

  const latestVersion = assertStrictSemver(
    await fetchLatestVersion(registryUrl, source.packageName, fetchImpl, options?.tag ?? 'latest'),
    'latest',
  );

  const currentVersion = await resolveCurrentVersion(stateDir, source, options?.currentVersion, 'checkForUpdate');
  const blocked = (await readBlockedRelease(stateDir)) || undefined;

  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareSemver(latestVersion, currentVersion) > 0,
    ...(blocked ? { blocked } : {}),
  };
}

async function resolveCurrentVersion(
  stateDir: string,
  source: UpdateSource,
  explicit: string | undefined,
  label: string,
): Promise<string> {
  if (explicit !== undefined && explicit !== '') return explicit;
  const current = await readCurrentRelease(stateDir);
  if (current !== null) return current.version;
  if (source.getFallbackVersion !== undefined) return source.getFallbackVersion();
  throw new UpgradeRejectedError(
    `${label}: no current version resolvable (current.json is absent, no explicit currentVersion, and the update source provides no getFallbackVersion)`,
  );
}

/**
 * Cross-process exclusive update lock (`upgrade.lock`) backed by `withCrossProcessFileLock`:
 * atomic publish, confirmed-dead PID stale recovery (never deadlocks after SIGKILL),
 * owner-checked CAS release, and fail-closed preservation of live or corrupt lock files.
 */
export async function withUpdateLock<T>(
  stateDir: string,
  fn: () => Promise<T>,
  options?: { isAlive?: (pid: number) => boolean },
): Promise<T> {
  const lockPath = path.join(stateDir, 'upgrade.lock');
  const busyError = (file: string, ownerPid?: number): Error =>
    new UpgradeRejectedError(
      `upgrade already in progress (${ownerPid !== undefined ? `held by pid ${ownerPid}, ` : ''}lock file exists: ${file})`,
    );
  // Recovery in progress leaves a break marker rather than a lock file, so `busyError`'s wording would be wrong here.
  const recoveringError = (_file: string, markers: string[]): Error =>
    new UpgradeRejectedError(
      `stale upgrade lock is being recovered (${markers.join(', ')}): another upgrade is clearing a dead owner's lock; retry shortly; if no upgrade is running, remove the stale marker file(s)`,
    );
  return withCrossProcessFileLock(lockPath, fn, {
    waitMs: 0,
    ...(options?.isAlive !== undefined ? { isAlive: options.isAlive } : {}),
    onBusy: busyError,
    onCorrupt: (file) => busyError(file),
    onRecovering: recoveringError,
    onError: (file, error, phase) =>
      new Error(
        `failed to ${phase} upgrade lock (${file}): ${(error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error))}`,
      ),
  });
}

/** Everything one activation attempt needs, resolved once while holding the update lock. */
interface UpgradeAttempt {
  readonly stateDir: string;
  readonly spec: UpdateSpec;
  readonly options: PerformUpdateOptions;
  /** Required lifecycle hook, proven present before the attempt is built. */
  readonly prepareReplacement: NonNullable<PerformUpdateOptions['prepareReplacement']>;
  readonly attemptId: string;
  readonly previousVersion: string;
  readonly targetVersion: string;
  /** `current.json` as it was before staging; restored verbatim when commit fails (`null` = it was absent). */
  readonly previousRelease: CurrentReleaseRecord | null;
}

/** The replacement has taken over activation; this process must stay drained until it exits. */
interface Activation {
  readonly pid: number;
  /** Set when the replacement was activated but its commit confirmation was lost (never rolled back). */
  readonly unconfirmed?: UpgradeCommitUnconfirmedError;
}

/** Explicit `targetVersion` when given, otherwise the version the registry dist-tag points at. */
async function resolveTargetVersion(
  stateDir: string,
  spec: UpdateSpec,
  options: PerformUpdateOptions,
  previousVersion: string,
): Promise<string> {
  if (options.targetVersion !== undefined && options.targetVersion !== '') {
    return normalizeTargetVersion(options.targetVersion);
  }
  const check = await checkForUpdate(stateDir, spec, {
    registryUrl: options.registryUrl,
    currentVersion: previousVersion,
    fetchFn: options.fetchFn,
    tag: options.tag,
  });
  return check.latestVersion;
}

/** Reject downgrades and versions in failure cooldown (both overridable with `force`). */
async function assertTargetAllowed(
  stateDir: string,
  options: PerformUpdateOptions,
  targetVersion: string,
  previousVersion: string,
): Promise<void> {
  if (!options.force && compareSemver(targetVersion, previousVersion) < 0) {
    throw new UpgradeRejectedError(
      `refusing downgrade from ${previousVersion} to ${targetVersion} (pass force=true to downgrade)`,
    );
  }
  const blocked = await readBlockedRelease(stateDir);
  if (!options.force && isBlockedVersionActive(blocked, targetVersion, new Date(), resolveBlockedCooldownMs())) {
    throw new UpgradeRejectedError(
      `version ${targetVersion} is in failure cooldown, rejecting retry: ${blocked!.reason} (blocked at ${blocked!.at})`,
    );
  }
}

/** Keep draining until the in-flight count reaches zero; a spent drain budget aborts with no changes. */
async function drainInFlight(options: PerformUpdateOptions): Promise<void> {
  const getActiveExecCount = options.getActiveExecCount ?? (() => 0);
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const drainStart = Date.now();
  while (getActiveExecCount() > 0) {
    if (Date.now() - drainStart > drainTimeoutMs) {
      throw new Error(
        `timed out draining in-flight operations (${drainTimeoutMs}ms, ${getActiveExecCount()} remaining); upgrade aborted with no changes`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS));
  }
}

/** Record the failure cooldown; a failure here is reported inline instead of masking the original error. */
async function recordBlockedAttempt(attempt: UpgradeAttempt, reason: string): Promise<string> {
  try {
    await writeBlockedRelease(attempt.stateDir, { version: attempt.targetVersion, reason, at: new Date().toISOString() });
    return `recorded blocked release for ${attempt.targetVersion}`;
  } catch (blockedError) {
    return `write blocked record failed (manual cleanup required): ${blockedError instanceof Error ? blockedError.message : String(blockedError)}`;
  }
}

/** Prepare the replacement, or abort with the current release untouched and a cooldown block recorded. */
async function prepareReplacementOrFail(attempt: UpgradeAttempt, staged: StagedRelease): Promise<PreparedReplacement> {
  const { attemptId, previousVersion, targetVersion } = attempt;
  try {
    return await attempt.prepareReplacement(staged, { attemptId, previousVersion, targetVersion });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const blockedNote = await recordBlockedAttempt(attempt, reason);
    throw new Error(
      `failed to prepare replacement (upgrade to ${targetVersion} aborted; current unchanged, previous process remains active): ${reason}; ${blockedNote}`,
    );
  }
}

/** Put `current.json` back exactly as it was before staging (deleting it when it was absent). */
async function restorePreviousRelease(attempt: UpgradeAttempt): Promise<string> {
  try {
    if (attempt.previousRelease) {
      await writeCurrentRelease(attempt.stateDir, attempt.previousRelease);
      return `current.json restored to ${attempt.previousRelease.version}`;
    }
    await deleteCurrentRelease(attempt.stateDir);
    return 'current.json deleted (was absent)';
  } catch (restoreError) {
    return `current.json restore failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`;
  }
}

/** Undo a failed commit (abort the replacement, restore the previous pointer, record the cooldown) and build the error to surface. */
async function rollbackReplacement(attempt: UpgradeAttempt, replacement: PreparedReplacement, reason: string): Promise<Error> {
  const rollbackNotes: string[] = [];
  try {
    await replacement.abort();
    rollbackNotes.push('replacement aborted');
  } catch (abortError) {
    rollbackNotes.push(`replacement abort failed: ${abortError instanceof Error ? abortError.message : String(abortError)}`);
  }
  rollbackNotes.push(await restorePreviousRelease(attempt));
  rollbackNotes.push(await recordBlockedAttempt(attempt, reason));
  return new Error(
    `upgrade to ${attempt.targetVersion} commit failed and rolled back to ${attempt.previousVersion}: ${reason}; rollback details: ${rollbackNotes.join('; ')}`,
  );
}

/**
 * Point `current.json` at the staged release and let the replacement confirm activation. Returns once
 * the replacement took over (confirmed, or unconfirmed — which is never rolled back); any other
 * commit failure rolls the pointer back and throws.
 */
async function activateReplacement(attempt: UpgradeAttempt, staged: StagedRelease): Promise<Activation> {
  const replacement = await prepareReplacementOrFail(attempt, staged);
  const { stateDir, targetVersion } = attempt;
  try {
    await writeCurrentRelease(stateDir, {
      version: targetVersion,
      entries: staged.entries,
      updatedAt: new Date().toISOString(),
    });
    await clearBlockedRelease(stateDir);
    await replacement.commit();
    return { pid: replacement.pid };
  } catch (error) {
    if (error instanceof UpgradeCommitUnconfirmedError) return { pid: replacement.pid, unconfirmed: error };
    throw await rollbackReplacement(attempt, replacement, error instanceof Error ? error.message : String(error));
  }
}

/** Stage, drain, and activate. The drain gate reopens unless the replacement took over this process. */
async function runActivation(attempt: UpgradeAttempt): Promise<UpdateResult> {
  const { options, spec, stateDir, targetVersion } = attempt;
  let reopenGate = true;
  try {
    const staged = await stageRelease(stateDir, targetVersion, spec.layout, {
      registryUrl: options.registryUrl,
      fetchFn: options.fetchFn,
      npmInstallArgs: options.npmInstallArgs,
      force: options.force,
      stageExtractor: options.stageExtractor,
    });

    options.setDraining?.(true);
    await drainInFlight(options);

    const activation = await activateReplacement(attempt, staged);
    // From here on the replacement owns draining (confirmed or not): stay drained until this process exits.
    reopenGate = false;
    options.onScheduleShutdown?.(activation.pid);
    if (activation.unconfirmed !== undefined) {
      throw new Error(
        `upgrade to ${targetVersion}: replacement was activated, but confirmation was unconfirmed (${activation.unconfirmed.message}); not rolling back (current.json points to ${targetVersion}, candidate will retry commit idempotently, previous process scheduled to exit)`,
        { cause: activation.unconfirmed },
      );
    }
    return { ok: true, previousVersion: attempt.previousVersion, targetVersion, upgraded: true, pid: activation.pid };
  } finally {
    if (reopenGate) await options.setDraining?.(false);
  }
}

/**
 * Perform a full update: resolve the target, stage it, drain in-flight work, activate
 * the replacement, and commit or roll back. See the module header for the commit
 * ordering and rollback invariants.
 */
export async function performUpdate(
  stateDir: string,
  spec: UpdateSpec,
  options?: PerformUpdateOptions,
): Promise<UpdateResult> {
  return withUpdateLock(stateDir, async () => {
    if (!options?.prepareReplacement) {
      throw new UpgradeRejectedError(
        'upgrade rejected: prepareReplacement was not provided (an injected replacement lifecycle is required to register and commit activation; refusing to fabricate a PID)',
      );
    }

    const previousVersion = await resolveCurrentVersion(stateDir, spec, options.currentVersion, 'performUpdate');
    const targetVersion = await resolveTargetVersion(stateDir, spec, options, previousVersion);

    if (!options.force && targetVersion === previousVersion) {
      return { ok: true, previousVersion, targetVersion, upgraded: false };
    }
    await assertTargetAllowed(stateDir, options, targetVersion, previousVersion);

    const attempt: UpgradeAttempt = {
      stateDir,
      spec,
      options,
      prepareReplacement: options.prepareReplacement,
      attemptId: options.attemptId ?? randomUUID(),
      previousVersion,
      targetVersion,
      previousRelease: await readCurrentRelease(stateDir),
    };
    return await runActivation(attempt);
  });
}
