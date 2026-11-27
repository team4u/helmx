/**
 * Shared cross-process execution primitives using only Node builtins (zero external dependencies,
 * so `@helmx/node`, `@helmx/cli`, `@helmx/kernel`, and payload scripts share one implementation):
 *
 * - `isProcessAlive` / `waitForPidExit`: process liveness checks and bounded exit polling;
 * - `parseLinuxStartTime` / `readProcessStartTime`: raw `/proc/<pid>/stat` field-22 clock ticks
 *   (single source of truth for Linux PID-reuse identity proofs);
 * - `readLogTailBounded` / `readLogFrom`: UTF-8-safe bounded log tailing and incremental byte-offset reading;
 * - `withCrossProcessFileLock`: atomic cross-process file lock (`temp + fsync + fs.link`, `wx` fallback)
 *   with dead-PID stale recovery, settle grace window, and CAS owner-checked release.
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Return true if `pid` exists (treating `EPERM` as alive so cross-user PIDs are never declared dead). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
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
  /** Max time to wait when another live process holds the lock (`0` fails immediately; default `0`). */
  waitMs?: number;
  /** Poll interval while waiting for a live holder (default `25ms`). */
  pollMs?: number;
  /** Grace window for empty/half-written lock files when `waitMs > 0` (default `2000ms`). */
  settleGraceMs?: number;
  /** Break lock files whose recorded numeric PID is confirmed dead (default `true`). */
  staleRecovery?: boolean;
  /** Process liveness hook (tests; defaults to `isProcessAlive`). */
  isAlive?: (pid: number) => boolean;
  /** Custom error when lock is held by a live process or wait budget expires. */
  onBusy?: (lockPath: string, ownerPid?: number) => Error;
  /** Custom error when lock file has non-numeric/corrupt contents (file is preserved, never deleted). */
  onCorrupt?: (lockPath: string) => Error;
  /** Custom error on unexpected create/read I/O failures (file is preserved). */
  onError?: (lockPath: string, error: unknown, phase: 'create' | 'read') => Error;
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
  /** Wall-clock instant after which waiting for a live holder fails. */
  readonly deadline: number;
  /** Confirmed-dead locks broken so far; bounded so a pathological loop fails loudly. */
  staleBreaks: number;
}

/** What to do after our publish lost to an existing lock file: retry at once (it vanished or was broken) or wait first. */
type LockDecision = { readonly kind: 'retry-now' } | { readonly kind: 'wait'; readonly delayMs: number };

const RETRY_NOW: LockDecision = { kind: 'retry-now' };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** Publish-and-inspect loop: returns once this process owns the lock, throws when it cannot get it. */
async function acquireLock(attempt: LockAttempt): Promise<void> {
  for (;;) {
    if (await tryPublishLock(attempt)) return;
    const decision = await inspectHeldLock(attempt);
    if (decision.kind === 'wait') await sleep(decision.delayMs);
  }
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
  if (Number.isSafeInteger(pid) && pid > 0 && !attempt.isAlive(pid)) return await breakStaleLock(attempt, raw, pid);
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

/**
 * Break a lock whose recorded PID is confirmed dead. The file is quarantined by rename before it is
 * inspected and deleted, so concurrent stale-lock breakers cannot delete a fresh live lock created
 * right after an unlink; a quarantined file that turned out to be newer/live is restored in place.
 */
async function breakStaleLock(attempt: LockAttempt, observedRaw: string, pid: number): Promise<LockDecision> {
  attempt.staleBreaks += 1;
  if (attempt.staleBreaks > MAX_STALE_BREAK_ATTEMPTS) {
    throw lockIoError(
      attempt,
      new Error(`unable to clear stale lock held by dead pid ${pid}`),
      'create',
      `unable to clear stale lock file (${attempt.lockPath}) held by dead pid ${pid}`,
    );
  }
  const quarantine = `${attempt.lockPath}.${process.pid}.${randomUUID()}.stale`;
  try {
    await fsp.rename(attempt.lockPath, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return RETRY_NOW;
    throw lockIoError(attempt, error, 'create', `failed to clear stale lock (${attempt.lockPath}): ${describeError(error)}`);
  }
  try {
    await restoreIfNotStale(attempt, quarantine, observedRaw);
  } finally {
    await fsp.rm(quarantine, { force: true }).catch(() => undefined);
  }
  return RETRY_NOW;
}

/** Put the quarantined lock back when it is no longer the dead-owner content we set out to break. */
async function restoreIfNotStale(attempt: LockAttempt, quarantine: string, observedRaw: string): Promise<void> {
  const movedRaw = await fsp.readFile(quarantine, 'utf8');
  if (movedRaw === observedRaw) return;
  const movedHead = movedRaw.trim().split(/\s+/)[0] ?? '';
  const movedPid = /^\d+$/.test(movedHead) ? Number(movedHead) : NaN;
  const movedIsDead = Number.isSafeInteger(movedPid) && movedPid > 0 && !attempt.isAlive(movedPid);
  if (movedIsDead) return;
  // Restore newer live/unproven lock without overwriting any concurrent replacement.
  try {
    await fsp.link(quarantine, attempt.lockPath);
  } catch {
    await fsp.writeFile(attempt.lockPath, movedRaw, { flag: 'wx', mode: 0o600 }).catch(() => undefined);
  }
}

/** Owner-checked release: remove the lock file only while it still carries our owner token. */
async function releaseLock(attempt: LockAttempt): Promise<void> {
  try {
    const current = await fsp.readFile(attempt.lockPath, 'utf8');
    if (current.trim() === attempt.owner) await fsp.rm(attempt.lockPath, { force: true });
  } catch {
    // If release fails, dead-PID stale detection cleans it up after this process exits.
  }
}

/**
 * Exclusive cross-process file lock with atomic publish (`temp + fsync + fs.link`, falling back to
 * `wx` when hard links are unsupported), confirmed-dead PID stale recovery, and owner-checked CAS release.
 *
 * Honesty invariants:
 * - Never deletes a lock file whose owner PID is still alive;
 * - Never silently deletes an empty/corrupt lock file (preserves it and surfaces `onCorrupt` / `onBusy`);
 * - Never ignores non-`ENOENT` read errors such as `EACCES`.
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
  };

  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  await acquireLock(attempt);
  try {
    return await fn();
  } finally {
    await releaseLock(attempt);
  }
}
