/**
 * In-process file serialization keyed by canonical real path.
 * Why not per-instance queues: AuthService, runtime, and plugins each instantiate separate
 * ConfigService / CredentialService objects, and per-instance queues wouldn't stop concurrent
 * reads of stale files across instances from overwriting each other. Keying a process-wide lock
 * by canonical real path ensures all instances for the same `dataDir` serialize reads/writes.
 * See `withFileLock` for in-process mutex; see `withProcessFileLock` for cross-process mutex.
 * Non-reentrant: `fn` must never acquire the lock for the same path again (deadlock).
 */
import { realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { withCrossProcessFileLock } from '@helmx/env-io'

const locks = new Map<string, Promise<unknown>>()

/** Normalize lock key: prefer realpath (so symlinked `dataDir` aliases share the exact same lock). */
async function lockKey(path: string): Promise<string> {
  const real = await realpath(path).catch(() => undefined)
  if (real !== undefined) return real
  const dirReal = await realpath(dirname(path)).catch(() => undefined)
  if (dirReal !== undefined) return join(dirReal, basename(path))
  return resolve(path)
}

/** Execute `fn` serially under a mutex keyed by `path`; concurrent calls across instances queue in order. */
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = await lockKey(path)
  const prev = locks.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => undefined)
  locks.set(key, tail)
  // Clean up Map entry after tail settles to prevent unbounded growth in long-running processes.
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key)
  })
  return run
}

// ---------------------------------------------------------------------------
// Cross-process file lock: the same file may be read-modify-written by multiple Hub/CLI processes,
// so in-process serialization alone won't prevent cross-process stale-read overwrites.
// Delegates to `@helmx/env-io`'s `withCrossProcessFileLock` so Hub and CLI share one lock protocol
// (`<target>.lock`, dead-PID stale recovery, settle grace window, and CAS owner-checked release).
// Non-reentrant: same process enters `withFileLock` first before acquiring this lock.
// ---------------------------------------------------------------------------

const PROCESS_LOCK_WAIT_MS = 10_000
const PROCESS_LOCK_POLL_MS = 25
/** Grace window right after lock creation before content finishes flushing (empty/partial content treated as in-flight write). */
const FRESH_LOCK_GRACE_MS = 1_500

/**
 * Execute `fn` while holding a cross-process exclusive lock (`${path}.lock`).
 * Protocol-compatible with the CLI lock implementation so both sides queue and mutually exclude cleanly.
 */
export async function withProcessFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  return withCrossProcessFileLock(`${path}.lock`, fn, {
    waitMs: PROCESS_LOCK_WAIT_MS,
    pollMs: PROCESS_LOCK_POLL_MS,
    settleGraceMs: FRESH_LOCK_GRACE_MS,
    onBusy: (lockFile) => new Error(`timed out waiting for concurrent file lock (${lockFile})`),
    onCorrupt: (lockFile) => new Error(`corrupt lock file content (${lockFile})`),
    onError: (lockFile, error, phase) => {
      if (phase === 'read' && error instanceof Error) return error
      return new Error(`failed to create lock file (${lockFile}): ${error instanceof Error ? error.message : String(error)}`)
    },
  })
}
