/**
 * Shared Hub release-switch and lifecycle primitives (tar-free; Node builtins + `@helmx/protocol`
 * + sibling `@helmx/env-io` utilities only) consumed by both the CLI launcher
 * (`packages/cli/src/launcher/*`) and the detached payload update handoff
 * (`packages/payload/src/update-handoff.mjs`).
 *
 * Single source of truth for:
 * - `hub.pid` and `launch.json` atomic state records + effective launch config precedence;
 * - `Helmx Hub: <url>` listen-line readiness gating + strict host/port URL verification
 *   (`assertListenUrlMatches`, `waitForHubListenLine`, `spawnDetachedHubRelease`);
 * - verified control-channel Hub shutdown (`stopHubViaControlChannel`);
 * - atomic commit → start → rollback → blocked-record transaction (`commitAndSwitchHubRelease`).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isStrictSemver } from '@helmx/protocol';
import { atomicWriteJson } from '../atomic-write.js';
import { controlRequest, CONTROL_STOP_TIMEOUT_MS, readHubControlRecord } from '../control.js';
import { killProcessTree } from '../node-shell-config-io.js';
import {
  isProcessAlive,
  readLogFrom,
  readLogTailBounded,
  readProcessStartTime,
  waitForPidExit,
} from '../process-utils.js';
import {
  clearBlockedRelease,
  deleteCurrentRelease,
  readStateJson,
  requireReleaseEntry,
  writeBlockedRelease,
  writeCurrentRelease,
  type CurrentReleaseRecord,
} from './state.js';

const LOG_TAIL_LINES = 40;

/** `@helmx/hub` prints `Helmx Hub: <url>` right after the HTTP server is listening. */
export const HUB_LISTEN_LINE_PATTERN = /^Helmx Hub: (\S+)\s*$/gm;

export const hubPidPath = (root: string): string => path.join(root, 'hub.pid');
export const hubLaunchConfigPath = (root: string): string => path.join(root, 'launch.json');
export const hubLogPath = (root: string): string => path.join(root, 'logs', 'hub.log');
export const hubLifecycleLockPath = (root: string): string => path.join(root, 'lifecycle.lock');

function requireString(rec: Record<string, unknown>, key: string): string {
  const value = rec[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`expected field "${key}" to be a non-empty string`);
  }
  return value;
}

function requirePort(rec: Record<string, unknown>, key: string): number {
  const value = rec[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`expected field "${key}" to be an integer port between 1 and 65535`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// hub.pid — identity of the detached Hub process owned by the install root
// ---------------------------------------------------------------------------

export interface HubPidRecord {
  pid: number;
  launchId?: string;
  version: string;
  entryPath: string;
  port: number;
  host?: string;
  dataDir?: string;
  startedAt: string;
  /**
   * Linux `/proc/<pid>/stat` start time (field 22, clock ticks since boot), captured at spawn.
   * Immutable for a pid's lifetime: a mismatch on stop proves pid reuse and blocks signalling.
   */
  startTime?: number;
}

function validateHubPidRecord(raw: unknown): HubPidRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected JSON object');
  const rec = raw as Record<string, unknown>;
  const pid = rec['pid'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new Error('expected field "pid" to be a positive integer');
  }
  const record: HubPidRecord = {
    pid,
    version: requireString(rec, 'version'),
    entryPath: requireString(rec, 'entryPath'),
    port: requirePort(rec, 'port'),
    startedAt: requireString(rec, 'startedAt'),
  };
  if (!isStrictSemver(record.version)) throw new Error(`invalid SemVer version: "${record.version}"`);
  if (rec['launchId'] !== undefined) record.launchId = requireString(rec, 'launchId');
  if (rec['host'] !== undefined) record.host = requireString(rec, 'host');
  if (rec['dataDir'] !== undefined) record.dataDir = requireString(rec, 'dataDir');
  if (rec['startTime'] !== undefined) {
    const startTime = rec['startTime'];
    if (typeof startTime !== 'number' || !Number.isInteger(startTime) || startTime < 0) {
      throw new Error('expected field "startTime" to be a non-negative integer');
    }
    record.startTime = startTime;
  }
  return record;
}

export function readHubPidRecord(root: string): Promise<HubPidRecord | null> {
  return readStateJson(hubPidPath(root), validateHubPidRecord, 'hub.pid');
}

export async function writeHubPidRecord(root: string, record: HubPidRecord): Promise<void> {
  validateHubPidRecord(record);
  await atomicWriteJson(hubPidPath(root), record, { mode: 0o600 });
}

/** Canonical JSON with recursively sorted keys (order-insensitive record comparison). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Remove `hub.pid` only if it still describes `record` (compare-and-swap against replacements). */
export async function removeHubPidRecordIfMatch(root: string, record: HubPidRecord): Promise<boolean> {
  const current = await readHubPidRecord(root);
  if (current === null || stableStringify(current) !== stableStringify(record)) return false;
  await fsp.rm(hubPidPath(root), { force: true });
  return true;
}

// ---------------------------------------------------------------------------
// launch.json — sticky launch configuration (explicit values only, never secrets)
// ---------------------------------------------------------------------------

export interface LaunchConfig {
  port?: number;
  host?: string;
  dataDir?: string;
  model?: string;
  webDistDir?: string;
}

export interface EffectiveLaunchConfig {
  port: number;
  host: string;
  dataDir?: string;
  model?: string;
  webDistDir?: string;
}

function validateLaunchConfig(raw: unknown): LaunchConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected JSON object');
  const rec = raw as Record<string, unknown>;
  const config: LaunchConfig = {};
  if (rec['port'] !== undefined) config.port = requirePort(rec, 'port');
  for (const key of ['host', 'dataDir', 'model', 'webDistDir'] as const) {
    if (rec[key] !== undefined) config[key] = requireString(rec, key);
  }
  return config;
}

export function readLaunchConfig(root: string): Promise<LaunchConfig | null> {
  return readStateJson(hubLaunchConfigPath(root), validateLaunchConfig, 'launch.json');
}

export async function writeLaunchConfig(root: string, config: LaunchConfig): Promise<void> {
  validateLaunchConfig(config);
  await atomicWriteJson(hubLaunchConfigPath(root), config, { mode: 0o600 });
}

function parsePortEnv(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535 (got "${value}")`);
  }
  return parsed;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}

/**
 * Resolve effective Hub launch configuration. Precedence: explicit flags > environment variables
 * (`HELMX_PORT`, `HELMX_HOST`, `HELMX_DATA_DIR`, `HELMX_MODEL`, `HELMX_WEB_DIST_DIR`) > persisted
 * `launch.json` > product defaults (port 3202, loopback host).
 */
export function resolveEffectiveLaunchConfig(input: {
  flags?: LaunchConfig;
  env: NodeJS.ProcessEnv;
  saved?: LaunchConfig | null;
}): EffectiveLaunchConfig {
  const flags = input.flags ?? {};
  const saved = input.saved ?? {};
  const port = flags.port ?? parsePortEnv(input.env.HELMX_PORT, 'HELMX_PORT') ?? saved.port ?? 3202;
  const host = flags.host ?? nonEmpty(input.env.HELMX_HOST) ?? saved.host ?? '127.0.0.1';
  const dataDir = flags.dataDir ?? nonEmpty(input.env.HELMX_DATA_DIR) ?? saved.dataDir;
  const model = flags.model ?? nonEmpty(input.env.HELMX_MODEL) ?? saved.model;
  const webDistEnv = nonEmpty(input.env.HELMX_WEB_DIST_DIR);
  const webDistDir = flags.webDistDir ?? webDistEnv ?? saved.webDistDir;
  const resolved: EffectiveLaunchConfig = { port, host };
  if (dataDir !== undefined) resolved.dataDir = dataDir;
  if (model !== undefined) resolved.model = model;
  if (webDistDir !== undefined && webDistDir !== 'false' && webDistDir !== '0') resolved.webDistDir = webDistDir;
  else if (webDistDir !== undefined) resolved.webDistDir = 'false';
  return resolved;
}

/** Extract the explicitly-configured subset to persist in `launch.json` after a successful start. */
export function persistableLaunchConfig(config: EffectiveLaunchConfig): LaunchConfig {
  const persisted: LaunchConfig = { port: config.port, host: config.host };
  if (config.dataDir !== undefined) persisted.dataDir = config.dataDir;
  if (config.model !== undefined) persisted.model = config.model;
  if (config.webDistDir !== undefined) persisted.webDistDir = config.webDistDir;
  return persisted;
}

// ---------------------------------------------------------------------------
// Listen-line readiness gate & detached Hub process spawning
// ---------------------------------------------------------------------------

/**
 * Verify that the candidate's `Helmx Hub: <url>` listen banner matches the configured endpoint.
 * A mismatch means the candidate bound somewhere other than requested and fails explicitly.
 */
export function assertListenUrlMatches(listenUrl: string, expected: Pick<EffectiveLaunchConfig, 'host' | 'port'>): void {
  let parsed: URL;
  try {
    parsed = new URL(listenUrl);
  } catch {
    throw new Error(`startup listen line URL is not parseable: "${listenUrl}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`startup listen line URL is not http(s): "${listenUrl}"`);
  }
  const expectedHost = expected.host === '0.0.0.0' || expected.host === '::' ? '127.0.0.1' : expected.host;
  const stripBrackets = (host: string): string => host.replace(/^\[|\]$/g, '');
  if (parsed.port !== String(expected.port) || stripBrackets(parsed.hostname) !== stripBrackets(expectedHost)) {
    throw new Error(
      `startup listen line reports ${listenUrl} but the launch configuration expects http://${expectedHost}:${expected.port}`,
    );
  }
}

/**
 * Primary readiness gate: wait for a post-spawn `Helmx Hub: <url>` banner on `expectedPort`
 * while `pid` stays alive. Rejects with exit details and a bounded log tail on exit or timeout.
 */
export async function waitForHubListenLine(
  logFile: string,
  startOffset: number,
  pid: number,
  isAlive: (pid: number) => boolean,
  options: { timeoutMs: number; pollMs: number; expectedPort: number; exitDetail?: () => string | null },
): Promise<string> {
  const deadline = Date.now() + options.timeoutMs;
  let offset = startOffset;
  let scanned = '';
  for (;;) {
    if (!isAlive(pid)) {
      const tail = await readLogTailBounded(logFile, LOG_TAIL_LINES);
      const detail = options.exitDetail?.() ?? null;
      throw new Error(
        `hub process exited before reporting readiness${detail !== null ? ` ${detail}` : ''} (no "Helmx Hub: " listen line)${tail !== '' ? `\n--- ${logFile} last ${LOG_TAIL_LINES} lines ---\n${tail}` : ''}`,
      );
    }
    const chunk = await readLogFrom(logFile, offset);
    offset = chunk.offset;
    if (chunk.text !== '') {
      scanned += chunk.text;
      if (scanned.length > 200_000) scanned = scanned.slice(-100_000);
      for (const match of scanned.matchAll(HUB_LISTEN_LINE_PATTERN)) {
        const candidateUrl = match[1]!;
        const parsed = /^https?:\/\/\[?([^\]]+)\]?:([0-9]+)$/.exec(candidateUrl);
        if (parsed !== null && Number(parsed[2]) === options.expectedPort) return candidateUrl;
      }
    }
    if (Date.now() >= deadline) {
      const tail = await readLogTailBounded(logFile, LOG_TAIL_LINES);
      throw new Error(
        `hub readiness timed out after ${options.timeoutMs}ms: no "Helmx Hub: " listen line in ${logFile}${tail !== '' ? `\n--- last ${LOG_TAIL_LINES} lines ---\n${tail}` : ''}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
}

export interface SpawnDetachedHubOptions {
  root: string;
  entryPath: string;
  config: EffectiveLaunchConfig;
  env: NodeJS.ProcessEnv;
  launchId?: string;
  timeoutMs?: number;
  pollMs?: number;
  isAlive?: (pid: number) => boolean;
  onSpawn?: (child: ChildProcess) => void;
}

export interface SpawnedDetachedHub {
  pid: number;
  launchId: string;
  listenUrl: string;
  logPath: string;
  logStartOffset: number;
  startTime: number | null;
}

/**
 * Spawn a payload Hub release (`node <entryPath> start`) detached with output redirected to
 * `<root>/logs/hub.log`, wait for its `Helmx Hub: <url>` readiness banner, and verify the
 * listen URL against `config`. Kills the spawned process tree on any readiness failure so no
 * untracked half-started Hub is ever left behind.
 */
export async function spawnDetachedHubRelease(options: SpawnDetachedHubOptions): Promise<SpawnedDetachedHub> {
  const logFile = hubLogPath(options.root);
  const isAlive = options.isAlive ?? isProcessAlive;
  const launchId = options.launchId && options.launchId !== '' ? options.launchId : randomUUID();

  await fsp.mkdir(path.dirname(logFile), { recursive: true });
  const logHandle = await fsp.open(logFile, 'a');
  const startOffset = (await logHandle.stat()).size;

  const childEnv: NodeJS.ProcessEnv = { ...options.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('HELMX_HANDOFF_')) delete childEnv[key];
  }
  childEnv.HELMX_PORT = String(options.config.port);
  childEnv.HELMX_HOST = options.config.host;
  childEnv.HELMX_HUB_ACTIVITY_LAUNCH_ID = launchId;
  childEnv.HELMX_HUB_INSTALL_ROOT = options.root;
  if (options.config.dataDir !== undefined) childEnv.HELMX_DATA_DIR = options.config.dataDir;
  if (options.config.model !== undefined) childEnv.HELMX_MODEL = options.config.model;
  if (options.config.webDistDir !== undefined) childEnv.HELMX_WEB_DIST_DIR = options.config.webDistDir;

  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [options.entryPath, 'start'], {
      detached: true,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
      env: childEnv,
    });
  } catch (error) {
    await logHandle.close().catch(() => undefined);
    throw new Error(`failed to spawn hub process: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (child.pid === undefined) {
    await logHandle.close().catch(() => undefined);
    throw new Error('hub process pid unavailable after spawn (internal error)');
  }
  const pid = child.pid;
  let exitDetail: string | null = null;
  child.once('exit', (code, signal) => {
    exitDetail = `(code=${code ?? 'null'} signal=${signal ?? 'null'})`;
  });
  child.unref();
  options.onSpawn?.(child);
  const startTime = await readProcessStartTime(pid);
  await logHandle.close().catch(() => undefined);

  try {
    const listenUrl = await waitForHubListenLine(logFile, startOffset, pid, isAlive, {
      timeoutMs: options.timeoutMs ?? 60_000,
      pollMs: options.pollMs ?? 500,
      expectedPort: options.config.port,
      exitDetail: () => exitDetail,
    });
    assertListenUrlMatches(listenUrl, options.config);
    return { pid, launchId, listenUrl, logPath: logFile, logStartOffset: startOffset, startTime };
  } catch (error) {
    killProcessTree(pid);
    await waitForPidExit(pid, 5_000, isAlive).catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    const tail = await readLogTailBounded(logFile, LOG_TAIL_LINES);
    throw new Error(
      `hub failed to become ready: ${reason}${tail !== '' && !reason.includes('---') ? `\n--- ${logFile} last ${LOG_TAIL_LINES} lines ---\n${tail}` : ''}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Control-channel Hub stop (shared by CLI launcher & payload handoff)
// ---------------------------------------------------------------------------

export interface StopHubViaControlOptions {
  dataDir: string;
  /** Process ID to await after stop acceptance (defaults to the control record's `pid`). */
  pid?: number;
  /** Optional strict binding: refuse when `hub-control.json` does not match this endpoint/instanceId. */
  expectedControl?: { endpoint: string; instanceId: string };
  stopTimeoutMs?: number;
  escalationWaitMs?: number;
  /** When true, escalate to `killProcessTree` if graceful stop times out (CLI mode). */
  escalateOnTimeout?: boolean;
  isAlive?: (pid: number) => boolean;
}

export type StopHubViaControlOutcome =
  | { stopped: true; pid: number; escalated: boolean }
  | { stopped: false; reason: 'no_control_record' | 'control_rejected'; detail: string };

/**
 * Attempt a verified graceful Hub stop over `<dataDir>/hub-control.json`.
 * Returns `{ stopped: false }` when the channel is absent or rejects the request (callers decide
 * whether to fail closed or fall back to `/proc` start-time proof); throws when the Hub accepted
 * stop yet failed to exit within the configured budget.
 */
export async function stopHubViaControlChannel(
  options: StopHubViaControlOptions,
): Promise<StopHubViaControlOutcome> {
  if (options.dataDir === '') {
    return { stopped: false, reason: 'no_control_record', detail: 'no data directory provided' };
  }
  const control = await readHubControlRecord(options.dataDir).catch(() => null);
  if (control === null) {
    return {
      stopped: false,
      reason: 'no_control_record',
      detail: `no hub control record in data directory "${options.dataDir}"`,
    };
  }
  if (
    options.expectedControl !== undefined &&
    (control.instanceId !== options.expectedControl.instanceId || control.endpoint !== options.expectedControl.endpoint)
  ) {
    return {
      stopped: false,
      reason: 'no_control_record',
      detail: `hub control record in "${options.dataDir}" does not match the expected instance`,
    };
  }
  const stopTimeoutMs = options.stopTimeoutMs ?? CONTROL_STOP_TIMEOUT_MS;
  const reply = await controlRequest(
    control.endpoint,
    { type: 'stop', instanceId: control.instanceId },
    Math.max(stopTimeoutMs, CONTROL_STOP_TIMEOUT_MS),
    { instanceId: control.instanceId },
  );
  if (reply === null || reply.ok !== true) {
    return {
      stopped: false,
      reason: 'control_rejected',
      detail: reply === null ? 'no reply' : `error: ${reply.error ?? 'unknown'}`,
    };
  }
  const targetPid = options.pid ?? control.pid;
  const isAlive = options.isAlive ?? isProcessAlive;
  const exited = await waitForPidExit(targetPid, stopTimeoutMs, isAlive);
  let escalated = false;
  if (!exited) {
    if (options.escalateOnTimeout !== true) {
      throw new Error(`hub pid ${targetPid} accepted the stop but did not exit within ${stopTimeoutMs}ms`);
    }
    killProcessTree(targetPid);
    const escalationWaitMs = options.escalationWaitMs ?? 10_000;
    if (!(await waitForPidExit(targetPid, escalationWaitMs, isAlive))) {
      throw new Error(
        `hub pid ${targetPid} accepted the control-channel stop but did not exit within ${stopTimeoutMs}ms graceful budget plus ${escalationWaitMs}ms after escalation`,
      );
    }
    escalated = true;
  }
  return { stopped: true, pid: targetPid, escalated };
}

// ---------------------------------------------------------------------------
// Shared commit -> start -> rollback -> blocked transaction
// ---------------------------------------------------------------------------

export interface CommitHubSwitchOptions<TStarted> {
  root: string;
  targetVersion: string;
  targetEntryPath: string;
  previousRecord: CurrentReleaseRecord | null;
  shouldStart: boolean;
  restartPreviousOnRollback: boolean;
  startRelease: (release: { version: string; entryPath: string; record: CurrentReleaseRecord }) => Promise<TStarted>;
  /**
   * Optional classification hook invoked when starting the target fails. Returning `'keep_committed'`
   * or a replacement `Error` clears blocked state and propagates without rolling back `current.json`
   * (used by CLI when another Hub started concurrently during the switch).
   */
  onStartError?: (
    error: unknown,
  ) => Promise<'rollback' | 'keep_committed' | Error> | 'rollback' | 'keep_committed' | Error;
  /** Format a successfully restarted previous release for rollback diagnostics. */
  formatRestored?: (started: TStarted, previous: CurrentReleaseRecord) => string;
  blockedReasonPrefix?: string;
  logPathHint?: string;
  onLog?: (message: string) => void;
}

/**
 * Commit `current.json` to `targetVersion`, optionally start it, and on any startup failure
 * roll `current.json` back first, optionally restart the previous release, record
 * `update-blocked.json`, and throw the full diagnostic chain.
 */
export async function commitAndSwitchHubRelease<TStarted>(
  options: CommitHubSwitchOptions<TStarted>,
): Promise<{ started: TStarted | undefined }> {
  const { root, targetVersion, targetEntryPath, previousRecord } = options;
  const nextRecord: CurrentReleaseRecord = {
    version: targetVersion,
    updatedAt: new Date().toISOString(),
    entries: { entryPath: targetEntryPath },
  };
  await writeCurrentRelease(root, nextRecord);
  options.onLog?.(`committed current.json -> ${targetVersion}`);

  if (!options.shouldStart) {
    await clearBlockedRelease(root);
    return { started: undefined };
  }

  try {
    const started = await options.startRelease({
      version: targetVersion,
      entryPath: targetEntryPath,
      record: nextRecord,
    });
    await clearBlockedRelease(root);
    return { started };
  } catch (startError) {
    if (options.onStartError !== undefined) {
      const action = await options.onStartError(startError);
      if (action !== 'rollback') {
        await clearBlockedRelease(root);
        throw action === 'keep_committed' ? startError : action;
      }
    }
    const reason = startError instanceof Error ? startError.message : String(startError);
    options.onLog?.(`target ${targetVersion} failed to become ready: ${reason}`);
    const rollbackNotes: string[] = [`candidate ${targetVersion} failed to become ready: ${reason}`];

    // Restore `current.json` BEFORE attempting to restart the previous release so the on-disk
    // pointer is always consistent even if the rollback start itself fails or crashes.
    if (previousRecord !== null) await writeCurrentRelease(root, previousRecord);
    else await deleteCurrentRelease(root);

    if (options.restartPreviousOnRollback && previousRecord !== null) {
      try {
        const previousEntry = requireReleaseEntry(previousRecord, 'entryPath');
        const restored = await options.startRelease({
          version: previousRecord.version,
          entryPath: previousEntry,
          record: previousRecord,
        });
        const note = options.formatRestored
          ? options.formatRestored(restored, previousRecord)
          : `rolled back to ${previousRecord.version}`;
        rollbackNotes.push(note);
        options.onLog?.(note);
      } catch (rollbackError) {
        const logHint = options.logPathHint ?? hubLogPath(root);
        const note =
          `ROLLBACK INCOMPLETE: previous release ${previousRecord.version} failed to restart: ${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          } (current.json restored to ${previousRecord.version}; start it manually after investigating ${logHint})`;
        rollbackNotes.push(note);
        options.onLog?.(note);
      }
    }

    const prefix = options.blockedReasonPrefix ?? 'candidate readiness failed';
    await writeBlockedRelease(root, {
      version: targetVersion,
      reason: `${prefix}: ${reason.slice(0, 500)}`,
      at: new Date().toISOString(),
    });
    throw new Error(rollbackNotes.join('\n'));
  }
}
