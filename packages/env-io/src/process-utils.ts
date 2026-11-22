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
    await new Promise((resolve) => setTimeout(resolve, pollMs));
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
  } catch {
    return '';
  }
  try {
    const stat = await handle.stat();
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
  } catch {
    return '';
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
  } catch {
    return { text: '', offset };
  }
  try {
    const stat = await handle.stat();
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
  const pollMs = Math.max(5, options.pollMs ?? DEFAULT_LOCK_POLL_MS);
  const settleGraceMs = Math.max(0, options.settleGraceMs ?? DEFAULT_LOCK_SETTLE_GRACE_MS);
  const staleRecovery = options.staleRecovery !== false;
  const isAlive = options.isAlive ?? isProcessAlive;
  const owner = `${process.pid} ${randomUUID()}`;
  const deadline = Date.now() + waitMs;

  await fsp.mkdir(path.dirname(lockPath), { recursive: true });

  const publish = async (): Promise<boolean> => {
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
        try {
          await fsp.writeFile(lockPath, `${owner}\n`, { flag: 'wx', mode: 0o600 });
          return true;
        } catch (fallbackError) {
          if ((fallbackError as NodeJS.ErrnoException).code === 'EEXIST') return false;
          throw fallbackError;
        }
      }
      throw error;
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
    }
  };

  let staleBreaks = 0;
  let acquired = false;

  for (;;) {
    let held = false;
    try {
      held = await publish();
    } catch (error) {
      throw options.onError
        ? options.onError(lockPath, error, 'create')
        : new Error(`failed to create lock file (${lockPath}): ${error instanceof Error ? error.message : String(error)}`);
    }
    if (held) {
      acquired = true;
      break;
    }

    if (!staleRecovery) {
      if (Date.now() >= deadline) {
        throw options.onBusy
          ? options.onBusy(lockPath)
          : new Error(`lock file already exists (${lockPath})`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }

    let raw: string;
    try {
      raw = await fsp.readFile(lockPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw options.onError
        ? options.onError(lockPath, error, 'read')
        : new Error(`failed to read lock file (${lockPath}): ${error instanceof Error ? error.message : String(error)}`);
    }

    const head = raw.trim().split(/\s+/)[0] ?? '';
    if (/^\d+$/.test(head)) {
      const pid = Number(head);
      if (Number.isSafeInteger(pid) && pid > 0 && !isAlive(pid)) {
        staleBreaks += 1;
        if (staleBreaks > MAX_STALE_BREAK_ATTEMPTS) {
          throw options.onError
            ? options.onError(lockPath, new Error(`unable to clear stale lock held by dead pid ${pid}`), 'create')
            : new Error(`unable to clear stale lock file (${lockPath}) held by dead pid ${pid}`);
        }
        // CAS check before unlinking so we do not remove a fresh lock that just replaced the stale one.
        const currentRaw = await fsp.readFile(lockPath, 'utf8').catch(() => null);
        if (currentRaw === raw) {
          await fsp.rm(lockPath, { force: true }).catch(() => undefined);
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw options.onBusy
          ? options.onBusy(lockPath, pid)
          : new Error(`lock file is held by pid ${pid} (${lockPath})`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }

    // Non-numeric / empty lock file: never auto-delete (could be mid-write fallback or corrupt remnant).
    if (waitMs > 0) {
      let stat: Awaited<ReturnType<typeof fsp.stat>>;
      try {
        stat = await fsp.stat(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw options.onError
          ? options.onError(lockPath, error, 'read')
          : new Error(`failed to stat lock file (${lockPath}): ${error instanceof Error ? error.message : String(error)}`);
      }
      if (Date.now() - stat.mtimeMs < settleGraceMs && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollMs * 4));
        continue;
      }
    }
    throw options.onCorrupt
      ? options.onCorrupt(lockPath)
      : (options.onBusy
          ? options.onBusy(lockPath)
          : new Error(`lock file is corrupt or unowned (${lockPath}): cannot determine owner`));
  }

  try {
    return await fn();
  } finally {
    if (acquired) {
      try {
        const current = await fsp.readFile(lockPath, 'utf8');
        if (current.trim() === owner) await fsp.rm(lockPath, { force: true });
      } catch {
        // If release fails, dead-PID stale detection cleans it up after this process exits.
      }
    }
  }
}
