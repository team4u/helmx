/**
 * Shared cross-process execution primitives using only Node builtins (zero external dependencies,
 * so `@helmx/node`, `@helmx/cli`, `@helmx/kernel`, and payload scripts share one implementation):
 *
 * - `isProcessAlive` / `waitForPidExit`: process liveness checks and bounded exit polling;
 * - `parseLinuxStartTime` / `readProcessStartTime`: raw `/proc/<pid>/stat` field-22 clock ticks
 *   (single source of truth for Linux PID-reuse identity proofs);
 * - `readLogTailBounded` / `readLogFrom`: UTF-8-safe bounded log tailing and incremental byte-offset reading;
 * - `withCrossProcessFileLock`: atomic cross-process file lock (`temp + fsync + fs.link`, `wx` fallback)
 *   with marker-guarded dead-PID stale recovery, post-publish ownership confirmation, settle grace
 *   window, and CAS owner-checked release.
 */
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_LOCK_POLL_MS = 25;
const DEFAULT_LOCK_SETTLE_GRACE_MS = 2_000;
const DEFAULT_EXIT_POLL_MS = 100;
const DEFAULT_LOG_TAIL_MAX_BYTES = 64 * 1024;
const DEFAULT_LOG_READ_MAX_BYTES = 1_000_000;
const MAX_STALE_BREAK_ATTEMPTS = 8;
const MAX_OWNERSHIP_RETRIES = 8;
const BREAK_MARKER_SUFFIX = '.stale';
/** Bounded backoff for lock-file deletions hitting transient file locks (same code set as `atomic-write.ts`). */
const REMOVE_BUSY_TOTAL_MS = 500;
const REMOVE_BUSY_INITIAL_POLL_MS = 5;
const REMOVE_BUSY_MAX_POLL_MS = 50;
const RETRYABLE_REMOVE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Return true if `pid` exists. Fail-closed on purpose: only `ESRCH` (no such process) proves death;
 * any other outcome (`EPERM` for cross-user PIDs, `EIO`, unknown codes) counts as alive. Why: a live
 * process wrongly declared dead lets a stale-lock breaker delete that process's lock, so the only
 * acceptable false verdict is "alive".
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Poll until `pid` is no longer alive or `timeoutMs` elapses (returns `true` if exited). */
export async function waitForPidExit(
  pid: number,
  timeoutMs: number,
  isAlive: (pid: number) => boolean = isProcessAlive,
  pollMs: number = DEFAULT_EXIT_POLL_MS,
): Promise<boolean> {
  if (!isAlive(pid)) return true;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (!isAlive(pid)) return true;
  }
  return !isAlive(pid);
}

/**
 * Parse the start-time field (field 22, raw clock ticks since boot) out of `/proc/<pid>/stat`.
 * The `comm` field may contain spaces and parentheses, so fields are counted after the final `)`.
 * Returns `null` when the content does not match a valid stat line (explicit, never guessed).
 */
export function parseLinuxStartTime(statContent: string): number | null {
  const close = statContent.lastIndexOf(')');
  if (close === -1) return null;
  const fields = statContent.slice(close + 2).trim().split(/\s+/);
  // fields[0] is `state` (field 3 overall); start time is field 22 -> index 19.
  const raw = fields[19];
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Current Linux `/proc/<pid>/stat` start time (raw clock ticks), or `null` off Linux or when
 * unreadable. Single source of truth shared by launcher, hub, and payload handoff.
 */
export async function readProcessStartTime(pid: number): Promise<number | null> {
  if (process.platform !== 'linux') return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return parseLinuxStartTime(await fsp.readFile(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

/** Skip up to 3 leading UTF-8 continuation bytes (`10xxxxxx`) when slicing from a mid-file byte offset. */
function skipLeadingUtf8Continuation(buffer: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
  let start = 0;
  while (start < buffer.length && start < 3 && (buffer[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return start > 0 ? buffer.subarray(start) : buffer;
}

/**
 * Trim any incomplete trailing multi-byte UTF-8 sequence from `buffer` (at most 3 bytes)
 * so incremental byte-offset reads never split a character across chunks.
 */
function trimTrailingIncompleteUtf8(buffer: Buffer): number {
  const len = buffer.length;
  if (len === 0) return 0;
  // Walk back over up to 3 trailing continuation bytes (10xxxxxx) to locate the lead byte.
  let cont = 0;
  while (cont < 3 && cont < len && (buffer[len - 1 - cont]! & 0xc0) === 0x80) {
    cont += 1;
  }
  if (cont === len) return len; // All continuation bytes (invalid UTF-8 anyway); do not stall progress.
  const leadIdx = len - 1 - cont;
  const lead = buffer[leadIdx]!;
  let expectedLen = 1;
  if ((lead & 0x80) === 0x00) expectedLen = 1;
  else if ((lead & 0xe0) === 0xc0) expectedLen = 2;
  else if ((lead & 0xf0) === 0xe0) expectedLen = 3;
  else if ((lead & 0xf8) === 0xf0) expectedLen = 4;
  else return len; // Invalid lead byte; do not stall.
  const available = len - leadIdx;
  return available < expectedLen ? leadIdx : len;
}

/**
 * Read at most the last `maxBytes` (default 64 KiB) of `logFile` and return up to `maxLines`
 * non-empty lines. UTF-8 safe at mid-file seek boundaries; returns `''` on missing/unreadable files.
 */
export async function readLogTailBounded(
  logFile: string,
  maxLines: number,
  maxBytes: number = DEFAULT_LOG_TAIL_MAX_BYTES,
): Promise<string> {
  if (maxLines <= 0 || maxBytes <= 0) return '';
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(logFile, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (stat.isDirectory()) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read (${logFile})`), {
        code: 'EISDIR',
        errno: -21,
        syscall: 'read',
        path: logFile,
      });
    }
    if (stat.size <= 0) return '';
    const readBytes = Math.min(stat.size, maxBytes);
    const startOffset = stat.size - readBytes;
    const buffer = Buffer.alloc(readBytes);
    const { bytesRead } = await handle.read(buffer, 0, readBytes, startOffset);
    let slice: Buffer<ArrayBufferLike> = buffer.subarray(0, bytesRead);
    if (startOffset > 0) {
      slice = skipLeadingUtf8Continuation(slice);
    }
    let text = slice.toString('utf8');
    if (startOffset > 0) {
      // Drop partial leading line when we started mid-file and there are complete lines after it.
      const firstNewline = text.indexOf('\n');
      if (firstNewline !== -1) text = text.slice(firstNewline + 1);
    }
    const lines = text.split(/\r?\n/).filter((line) => line !== '');
    return lines.slice(-maxLines).join('\n');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Incrementally read `logFile` starting at byte `offset` (up to `maxBytes`), advancing the byte
 * offset cleanly on UTF-8 character boundaries. Returns `{ text: '', offset }` on ENOENT or EOF.
 */
export async function readLogFrom(
  logFile: string,
  offset: number,
  maxBytes: number = DEFAULT_LOG_READ_MAX_BYTES,
): Promise<{ text: string; offset: number }> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(logFile, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', offset };
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (stat.isDirectory()) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read (${logFile})`), {
        code: 'EISDIR',
        errno: -21,
        syscall: 'read',
        path: logFile,
      });
    }
    if (stat.size <= offset) return { text: '', offset };
    const length = Math.min(stat.size - offset, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead <= 0) return { text: '', offset };
    const rawSlice = buffer.subarray(0, bytesRead);
    const hasMore = offset + bytesRead < stat.size;
    const usableBytes = hasMore ? trimTrailingIncompleteUtf8(rawSlice) : bytesRead;
    const finalBytes = usableBytes > 0 ? usableBytes : bytesRead;
    return {
      text: rawSlice.subarray(0, finalBytes).toString('utf8'),
      offset: offset + finalBytes,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export interface CrossProcessFileLockOptions {
  /**
   * Max time to wait when another live process holds the lock (`0` never waits for a live holder; but
   * after a successful publish an in-flight stale recovery still gets `settleGraceMs` to settle, see
   * `onRecovering`; default `0`).
   */
  waitMs?: number;
  /** Poll interval while waiting for a live holder (default `25ms`). */
  pollMs?: number;
  /**
   * Grace window for empty/half-written lock files when `waitMs > 0` (default `2000ms`); also bounds the
   * post-publish wait for break markers when `waitMs === 0`.
   */
  settleGraceMs?: number;
  /** Break lock files whose recorded numeric PID is confirmed dead (default `true`). */
  staleRecovery?: boolean;
  /** Process liveness hook (tests; defaults to `isProcessAlive`). */
  isAlive?: (pid: number) => boolean;
  /** Custom error when lock is held by a live process or wait budget expires. */
  onBusy?: (lockPath: string, ownerPid?: number) => Error;
  /** Custom error when lock file has non-numeric/corrupt contents (file is preserved, never deleted). */
  onCorrupt?: (lockPath: string) => Error;
  /**
   * Custom error when the wait budget expires while live break markers remain (a recovery may still be
   * in progress, or a crashed one left its marker behind; `markers` are described as
   * `<path> (pid N, 3h old)`). Falls back to `onBusy(lockPath, undefined)`, then to the built-in message.
   */
  onRecovering?: (lockPath: string, markers: string[]) => Error;
  /** Custom error on unexpected create/read I/O failures (file is preserved). */
  onError?: (lockPath: string, error: unknown, phase: 'create' | 'read') => Error;
  /**
   * Tests: awaited while the stale-lock break marker is held, after the dead owner has been
   * re-confirmed and before the lock file is removed; lets a test interleave concurrent acquirers.
   */
  beforeStaleRemoval?: (lockPath: string, stalePid: number) => Promise<void>;
}

/** Normalized options plus the per-acquisition state shared by the lock steps below. */
interface LockAttempt {
  readonly lockPath: string;
  /** `<pid> <uuid>` token written into the lock file; release is owner-checked against it. */
  readonly owner: string;
  readonly waitMs: number;
  readonly pollMs: number;
  readonly settleGraceMs: number;
  readonly staleRecovery: boolean;
  readonly isAlive: (pid: number) => boolean;
  readonly hooks: CrossProcessFileLockOptions;
  /** Wall-clock instant after which waiting for a live holder or for break markers fails (`waitMs > 0` only). */
  readonly deadline: number;
  /** Confirmed-dead lock breaks attempted so far; bounded so a pathological loop fails loudly. */
  staleBreaks: number;
  /** Publishes displaced by a concurrent stale recovery so far; bounded so a pathological loop fails loudly. */
  ownershipRetries: number;
}

/** What to do after our publish lost to an existing lock file: retry at once (it vanished or was broken) or wait first. */
type LockDecision = { readonly kind: 'retry-now' } | { readonly kind: 'wait'; readonly delayMs: number };

const RETRY_NOW: LockDecision = { kind: 'retry-now' };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Append `diagnostic` to `error.message` in place (original object, errno `code` and subclass kept; never throws). */
function annotateError(error: unknown, diagnostic: string): void {
  if (!(error instanceof Error)) return;
  try {
    error.message = `${error.message}${diagnostic}`;
  } catch {
    /* read-only message: keep the original error untouched */
  }
}

/**
 * Remove `file` (a missing file counts as removed), retrying transient lock codes with bounded backoff
 * (5 -> 50ms, ~500ms total). Returns the last error instead of throwing so each caller decides whether a
 * leftover is fatal (break marker) or best-effort (own lock after use).
 */
async function removeFileWithRetry(file: string): Promise<Error | undefined> {
  const startedAt = Date.now();
  for (let retries = 0; ; retries += 1) {
    try {
      await fsp.rm(file, { force: true });
      return undefined;
    } catch (error) {
      if (!(error instanceof Error)) return new Error(describeError(error));
      const { code } = error as NodeJS.ErrnoException;
      if (typeof code !== 'string' || !RETRYABLE_REMOVE_CODES.has(code)) return error;
      if (Date.now() - startedAt >= REMOVE_BUSY_TOTAL_MS) {
        annotateError(error, ` (transiently locked; still failed after ${retries} retries / ${Date.now() - startedAt}ms)`);
        return error;
      }
      await sleep(Math.min(REMOVE_BUSY_MAX_POLL_MS, REMOVE_BUSY_INITIAL_POLL_MS * 2 ** retries));
    }
  }
}

/** Coarse human age for diagnostics: `120ms`, `45s`, `5m`, `3h`, `2d`. */
function describeAge(ageMs: number): string {
  if (ageMs < 1_000) return `${Math.max(0, Math.round(ageMs))}ms`;
  if (ageMs < 60_000) return `${Math.round(ageMs / 1_000)}s`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h`;
  return `${Math.round(ageMs / 86_400_000)}d`;
}

function lockIoError(attempt: LockAttempt, error: unknown, phase: 'create' | 'read', fallbackMessage: string): Error {
  return attempt.hooks.onError ? attempt.hooks.onError(attempt.lockPath, error, phase) : new Error(fallbackMessage);
}

function lockBusyError(attempt: LockAttempt, ownerPid: number | undefined, fallbackMessage: string): Error {
  return attempt.hooks.onBusy ? attempt.hooks.onBusy(attempt.lockPath, ownerPid) : new Error(fallbackMessage);
}

/** Corrupt/unowned lock files are never deleted: surface `onCorrupt`, else `onBusy`, else the default error. */
function lockCorruptError(attempt: LockAttempt): Error {
  const { onCorrupt, onBusy } = attempt.hooks;
  if (onCorrupt) return onCorrupt(attempt.lockPath);
  if (onBusy) return onBusy(attempt.lockPath);
  return new Error(`lock file is corrupt or unowned (${attempt.lockPath}): cannot determine owner`);
}

/**
 * Recovery-still-in-progress verdict: `onRecovering`, else `onBusy(lockPath, undefined)`, else the built-in
 * message. `markers` are operator-facing descriptions (path + pid + age) so the error can be acted upon.
 */
function lockRecoveringError(attempt: LockAttempt, markers: string[]): Error {
  if (attempt.hooks.onRecovering) return attempt.hooks.onRecovering(attempt.lockPath, markers);
  return lockBusyError(attempt, undefined, `stale-lock recovery is in progress (${markers.join(', ')})`);
}

/**
 * Atomically publish `owner` as the lock holder: write + fsync a temp file, then hard-link it onto the
 * lock path (`EEXIST` means someone else holds it). Filesystems that reject hard links fall back to an
 * exclusive `wx` create. The temp file is always removed.
 */
async function publishLockOwner(attempt: LockAttempt): Promise<boolean> {
  const { lockPath, owner } = attempt;
  const tmp = `${lockPath}.${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const handle = await fsp.open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(`${owner}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.link(tmp, lockPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code === 'EXDEV' || code === 'ENOSYS' || code === 'EPERM' || code === 'EINVAL') {
      // Awaited inside the try so the temp file is removed only after the fallback has settled.
      return await createLockExclusively(lockPath, owner);
    }
    throw error;
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** Hard-link fallback: exclusive `wx` create; `false` when the lock already exists. */
async function createLockExclusively(lockPath: string, owner: string): Promise<boolean> {
  try {
    await fsp.writeFile(lockPath, `${owner}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (fallbackError) {
    if ((fallbackError as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw fallbackError;
  }
}

/** One publish attempt; create failures surface through `onError` and the lock file is preserved. */
async function tryPublishLock(attempt: LockAttempt): Promise<boolean> {
  try {
    return await publishLockOwner(attempt);
  } catch (error) {
    throw lockIoError(attempt, error, 'create', `failed to create lock file (${attempt.lockPath}): ${describeError(error)}`);
  }
}

/**
 * Publish-and-confirm loop: returns once this process owns the lock and no in-flight stale recovery can
 * still delete it; throws when it cannot get it. A publish displaced by a concurrent stale recovery
 * re-contends (bounded). Every failure after a successful publish releases the lock first so a lock file
 * carrying this live PID is never orphaned; a release that itself fails is appended to the thrown error.
 */
async function acquireLock(attempt: LockAttempt): Promise<void> {
  for (;;) {
    if (await tryPublishLock(attempt)) {
      try {
        if (await confirmLockOwnership(attempt)) return;
      } catch (error) {
        const releaseFailure = await releaseLock(attempt);
        if (releaseFailure !== undefined) {
          annotateError(
            error,
            `; releasing the published lock also failed (${attempt.lockPath} may still carry pid ${process.pid}: ${describeError(releaseFailure)})`,
          );
        }
        throw error;
      }
      attempt.ownershipRetries += 1;
      if (attempt.ownershipRetries > MAX_OWNERSHIP_RETRIES) {
        throw lockIoError(
          attempt,
          new Error(`lock ownership was displaced ${MAX_OWNERSHIP_RETRIES} times by concurrent stale recovery`),
          'create',
          `unable to confirm lock ownership (${attempt.lockPath}): repeatedly displaced by concurrent stale recovery`,
        );
      }
      await sleep(attempt.pollMs);
      continue;
    }
    const decision = await inspectHeldLock(attempt);
    if (decision.kind === 'wait') await sleep(decision.delayMs);
  }
}

/**
 * Ownership confirmation after a successful publish: once no live break marker remains, the lock path
 * must still carry our owner token. Anything else means a stale recovery removed the file we just
 * published inside its own window, so we must not enter and re-contend instead.
 *
 * Why this is sufficient: a lock file is only ever deleted by (a) its live owner's token-checked
 * release or (b) a breaker between creating and removing its break marker. A holder can publish only
 * after the dead file is gone, i.e. after some marker was created; so every breaker able to delete the
 * holder's file owns a marker created before the holder's marker scan and removed only after its
 * deletion. Hence either the scan sees that marker (holder waits) or the deletion already happened
 * (token re-read fails). Once confirmed, no pending deletion can exist, so the lock path is stable
 * until release and the release CAS race is eliminated by construction.
 */
async function confirmLockOwnership(attempt: LockAttempt): Promise<boolean> {
  await waitForBreakMarkersToClear(attempt);
  const raw = await readLockFile(attempt);
  return raw !== undefined && raw.trim() === attempt.owner;
}

/**
 * Wait until no live break marker for this lock remains. A holder that just published owes an in-flight
 * stale recovery its settle window even without a wait budget (`waitMs === 0`), because that recovery
 * may be about to delete the freshly published file; past the window the holder fails explicitly.
 */
async function waitForBreakMarkersToClear(attempt: LockAttempt): Promise<void> {
  const until = attempt.waitMs > 0 ? attempt.deadline : Date.now() + attempt.settleGraceMs;
  for (;;) {
    const blockers = await listLiveBreakMarkers(attempt);
    if (blockers.length === 0) return;
    if (Date.now() >= until) throw lockRecoveringError(attempt, await describeBreakMarkers(blockers));
    await sleep(attempt.pollMs);
  }
}

/** A break marker whose breaker PID is still alive. */
interface LiveBreakMarker {
  readonly markerPath: string;
  readonly pid: number;
}

/**
 * Operator-facing marker descriptions `<path> (pid N, 3h old)`; the age (marker mtime, only stat'ed here
 * on the error path) tells an in-progress break (milliseconds) from a crashed leftover (hours).
 * A marker that cannot be stat'ed is described by its path alone.
 */
async function describeBreakMarkers(markers: LiveBreakMarker[]): Promise<string[]> {
  return Promise.all(
    markers.map(async ({ markerPath, pid }) => {
      try {
        const { mtimeMs } = await fsp.stat(markerPath);
        return `${markerPath} (pid ${pid}, ${describeAge(Date.now() - mtimeMs)} old)`;
      } catch {
        return markerPath;
      }
    }),
  );
}

/**
 * Break markers (`<lock>.<pid>.<uuid>.stale`) in the lock directory whose breaker PID is still alive.
 * Markers of dead breakers are ignored and never deleted: their owner can no longer act, and removing
 * them would race a live breaker's own marker cleanup. A crashed breaker whose PID later gets reused
 * therefore stays "live" until that PID exits or someone removes the marker by hand: acquirers then
 * fail explicitly naming it (see `onRecovering`) instead of ever entering on a lock that may be deleted.
 */
async function listLiveBreakMarkers(attempt: LockAttempt): Promise<LiveBreakMarker[]> {
  const dir = path.dirname(attempt.lockPath);
  const prefix = `${path.basename(attempt.lockPath)}.`;
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; // Directory gone: nothing to protect; the token re-read that follows is the verdict.
    throw lockIoError(attempt, error, 'read', `failed to list the lock directory (${dir}): ${describeError(error)}`);
  }
  const live: LiveBreakMarker[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(BREAK_MARKER_SUFFIX)) continue;
    const pid = Number(name.slice(prefix.length, -BREAK_MARKER_SUFFIX.length).split('.')[0]);
    if (Number.isSafeInteger(pid) && pid > 0 && attempt.isAlive(pid)) live.push({ markerPath: path.join(dir, name), pid });
  }
  return live;
}

/**
 * Inspect the lock that beat our publish: wait for a live holder (within the budget), break a
 * confirmed-dead one, or wait out a half-written file's settle window. Throws when the holder is
 * live and the budget is spent, the file is corrupt, or I/O fails.
 */
async function inspectHeldLock(attempt: LockAttempt): Promise<LockDecision> {
  if (!attempt.staleRecovery) {
    if (Date.now() >= attempt.deadline) throw lockBusyError(attempt, undefined, `lock file already exists (${attempt.lockPath})`);
    return { kind: 'wait', delayMs: attempt.pollMs };
  }
  const raw = await readLockFile(attempt);
  if (raw === undefined) return RETRY_NOW;
  const head = raw.trim().split(/\s+/)[0] ?? '';
  if (!/^\d+$/.test(head)) return await inspectUnownedLock(attempt);
  const pid = Number(head);
  if (Number.isSafeInteger(pid) && pid > 0 && !attempt.isAlive(pid)) return await breakStaleLock(attempt, pid);
  if (Date.now() >= attempt.deadline) {
    throw lockBusyError(attempt, pid, `lock file is held by pid ${pid} (${attempt.lockPath})`);
  }
  return { kind: 'wait', delayMs: attempt.pollMs };
}

/** Lock file contents, or `undefined` when it vanished between our failed publish and this read. */
async function readLockFile(attempt: LockAttempt): Promise<string | undefined> {
  try {
    return await fsp.readFile(attempt.lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw lockIoError(attempt, error, 'read', `failed to read lock file (${attempt.lockPath}): ${describeError(error)}`);
  }
}

/**
 * Non-numeric / empty lock file: never auto-delete (could be mid-write fallback or corrupt remnant).
 * With a wait budget, give a freshly written file its settle window before declaring it corrupt.
 */
async function inspectUnownedLock(attempt: LockAttempt): Promise<LockDecision> {
  if (attempt.waitMs <= 0) throw lockCorruptError(attempt);
  const mtimeMs = await statLockFile(attempt);
  if (mtimeMs === undefined) return RETRY_NOW;
  if (Date.now() - mtimeMs < attempt.settleGraceMs && Date.now() < attempt.deadline) {
    return { kind: 'wait', delayMs: attempt.pollMs * 4 };
  }
  throw lockCorruptError(attempt);
}

/** Lock file mtime, or `undefined` when it vanished; other stat failures surface through `onError`. */
async function statLockFile(attempt: LockAttempt): Promise<number | undefined> {
  try {
    return (await fsp.stat(attempt.lockPath)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw lockIoError(attempt, error, 'read', `failed to stat lock file (${attempt.lockPath}): ${describeError(error)}`);
  }
}

/** Break marker name for this process: `<lock>.<pid>.<uuid>.stale`, unique per break so concurrent breakers never collide. */
function breakMarkerPath(lockPath: string): string {
  return `${lockPath}.${process.pid}.${randomUUID()}${BREAK_MARKER_SUFFIX}`;
}

/**
 * Break a lock whose recorded PID was observed dead. A read-then-delete can never be atomic, so instead
 * of quarantining by rename (which used to carry away a fresh live lock) the breaker holds a break
 * marker from before the re-examining read until after the deletion: concurrent holders see the marker
 * and refuse to enter on a lock published meanwhile (see `confirmLockOwnership`). Under the marker the
 * file is re-read: gone -> retry now; live or not provably dead -> leave it alone and wait.
 * Marker hygiene is never silent: a create failure cleans up the partial file (or says it could not),
 * and the marker is removed after the body settles whatever its outcome, with a removal failure turned
 * into an explicit error naming the marker (a leftover live-PID marker blocks every acquirer).
 */
async function breakStaleLock(attempt: LockAttempt, pid: number): Promise<LockDecision> {
  attempt.staleBreaks += 1;
  if (attempt.staleBreaks > MAX_STALE_BREAK_ATTEMPTS) {
    throw lockIoError(
      attempt,
      new Error(`unable to clear stale lock held by dead pid ${pid}`),
      'create',
      `unable to clear stale lock file (${attempt.lockPath}) held by dead pid ${pid}`,
    );
  }
  const marker = breakMarkerPath(attempt.lockPath);
  try {
    await fsp.writeFile(marker, `${attempt.owner}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    // `wx` may have created the file before failing (ENOSPC on write, EIO on close). The marker is
    // uniquely ours; a leaked one with our live PID would make every acquirer wait for it and fail.
    const cleanupFailure = await removeFileWithRetry(marker);
    if (cleanupFailure !== undefined) {
      annotateError(
        error,
        `; removing the partially created break marker also failed (${marker}: ${describeError(cleanupFailure)}); acquirers will keep waiting for that marker while pid ${process.pid} is alive, remove it manually`,
      );
    }
    throw lockIoError(
      attempt,
      error,
      'create',
      `failed to create stale-lock break marker (${marker}): ${describeError(error)}${
        cleanupFailure === undefined ? ' (no marker left behind)' : ''
      }`,
    );
  }
  let staleRemoved = false;
  let decision: LockDecision = RETRY_NOW;
  let bodyError: unknown;
  try {
    const raw = await readLockFile(attempt);
    if (raw !== undefined) {
      const head = raw.trim().split(/\s+/)[0] ?? '';
      const currentPid = /^\d+$/.test(head) ? Number(head) : NaN;
      if (!(Number.isSafeInteger(currentPid) && currentPid > 0 && !attempt.isAlive(currentPid))) {
        decision = { kind: 'wait', delayMs: attempt.pollMs };
      } else {
        await attempt.hooks.beforeStaleRemoval?.(attempt.lockPath, currentPid);
        try {
          await fsp.rm(attempt.lockPath, { force: true });
        } catch (error) {
          throw lockIoError(attempt, error, 'create', `failed to clear stale lock (${attempt.lockPath}): ${describeError(error)}`);
        }
        staleRemoved = true;
      }
    }
  } catch (error) {
    bodyError = error;
  }
  // The marker must outlive the deletion above; a leftover is never silent: holders would wait for it.
  const markerFailure = await removeFileWithRetry(marker);
  if (markerFailure !== undefined) {
    const consequence = `acquirers will keep waiting for it while pid ${process.pid} is alive; remove it manually`;
    if (bodyError !== undefined) {
      annotateError(bodyError, `; removing the break marker also failed (${marker}: ${describeError(markerFailure)}); ${consequence}`);
    } else {
      const headline = `${staleRemoved ? 'stale lock removed but the' : 'the'} break marker cannot be deleted`;
      const cause = describeError(markerFailure);
      // `onError` hooks receive the error object rather than the fallback text: carry the same context on it.
      annotateError(markerFailure, `; ${headline} (${marker}); ${consequence}`);
      bodyError = lockIoError(attempt, markerFailure, 'create', `${headline} (${marker}: ${cause}); ${consequence}`);
    }
  }
  if (bodyError !== undefined) throw bodyError;
  return decision;
}

/**
 * Owner-checked release: remove the lock file only while it still carries our owner token. After
 * ownership confirmation no other process can delete or replace it while this PID lives (see
 * `confirmLockOwnership`), so the read/compare/remove sequence has no concurrent deleter. Returns the
 * failure whenever the release could not be proven (unreadable, or undeletable after bounded retries)
 * for callers to surface; never throws.
 */
async function releaseLock(attempt: LockAttempt): Promise<Error | undefined> {
  let current: string;
  try {
    current = await fsp.readFile(attempt.lockPath, 'utf8');
  } catch (error) {
    // Gone (deleted by a breaker inside its window): nothing of ours is left. Any other read failure is
    // returned: the file may still carry our pid, so the caller decides whether to report it.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return error instanceof Error ? error : new Error(describeError(error));
  }
  if (current.trim() !== attempt.owner) return undefined;
  return await removeFileWithRetry(attempt.lockPath);
}

/**
 * Exclusive cross-process file lock with atomic publish (`temp + fsync + fs.link`, falling back to
 * `wx` when hard links are unsupported), marker-guarded confirmed-dead PID stale recovery, post-publish
 * ownership confirmation, and owner-checked release.
 *
 * Honesty invariants:
 * - Never deletes a lock file whose owner PID is still alive (a breaker re-confirms the dead PID under
 *   its break marker right before deleting);
 * - Never enters a critical section while a stale recovery that may still delete the just-published lock
 *   file is in flight (post-publish break-marker scan + owner-token re-read, see `confirmLockOwnership`);
 * - Never leaves a lock file carrying this live PID behind when acquisition fails after publishing;
 * - Never silently deletes an empty/corrupt lock file (preserves it and surfaces `onCorrupt` / `onBusy`);
 * - Never deletes another process's break marker (dead-PID markers are ignored, not removed);
 * - Never leaves a break marker of this process behind silently: a removal failure (after bounded
 *   retries) is reported on the thrown error, because a live-PID marker blocks every acquirer;
 * - Break markers carry only a PID: a breaker that crashes inside its window and whose PID is later
 *   reused keeps a "live" marker until that PID exits or the marker is removed by hand; acquirers then
 *   fail explicitly naming it (`onRecovering`). Deliberate fail-closed, never auto-deleted;
 * - Never ignores non-`ENOENT` read errors such as `EACCES` while acquiring; the release that follows
 *   the critical section is the one exception (its failures are never thrown over the section's own
 *   result, see the `finally` below);
 */
export async function withCrossProcessFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: CrossProcessFileLockOptions = {},
): Promise<T> {
  const waitMs = Math.max(0, options.waitMs ?? 0);
  const attempt: LockAttempt = {
    lockPath,
    owner: `${process.pid} ${randomUUID()}`,
    waitMs,
    pollMs: Math.max(5, options.pollMs ?? DEFAULT_LOCK_POLL_MS),
    settleGraceMs: Math.max(0, options.settleGraceMs ?? DEFAULT_LOCK_SETTLE_GRACE_MS),
    staleRecovery: options.staleRecovery !== false,
    isAlive: options.isAlive ?? isProcessAlive,
    hooks: options,
    deadline: Date.now() + waitMs,
    staleBreaks: 0,
    ownershipRetries: 0,
  };

  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  await acquireLock(attempt);
  try {
    return await fn();
  } finally {
    // Not thrown: a lock file left here still carries this live PID (so nobody enters) and dead-PID
    // stale recovery cleans it up after this process exits; the critical section's own result wins.
    await releaseLock(attempt);
  }
}
