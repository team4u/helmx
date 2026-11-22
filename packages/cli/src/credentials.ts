/**
 * CLI login state: `<dataDir>/cli-token` (0600 JSON `{ hubUrl, token }`), dedicated solely to the CLI.
 * `credentials.json` holds only model and plugin secrets (managed by `@helmx/kernel` CredentialService),
 * and the CLI never reads or writes it. Writes take an exclusive lock (`cli-token.lock`: written to a
 * temp file then published atomically via `fs.link`, with PID as the first token, broken as stale only
 * after the holder PID is confirmed dead; filesystems without hard links fall back to O_EXCL + a
 * reader-side settle grace window) + atomic temp write. Setting `HELMX_TOKEN` short-circuits disk reads.
 * Origin binding: stored tokens are attached only when the target baseUrl matches the recorded hubUrl
 * (see hub-client).
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { CliError } from './errors.js'
import { atomicWriteFile, withCrossProcessFileLock } from '@helmx/env-io'

export interface CliCredential {
  hubUrl?: string
  token?: string
}

const LOCK_WAIT_MS = 10_000
const LOCK_POLL_MS = 25
/** Grace window for empty or half-written lock files: allows a concurrent holder to finish writing before declaring the lock corrupt. */
const LOCK_SETTLE_GRACE_MS = 2_000

export function dataDirFor(env: NodeJS.ProcessEnv): string {
  const v = env['HELMX_DATA_DIR']
  if (v && v.trim()) return v.trim()
  return path.join(os.homedir(), '.helmx')
}

/** Path to the CLI login state file (`0600` JSON `{ hubUrl, token }`). */
export function credentialsPath(dataDir: string): string {
  return path.join(dataDir, 'cli-token')
}

/** Validate `cli-token` JSON structure; fail explicitly on invalid/corrupt files rather than treating them as unauthenticated. */
function parseCliTokenFile(text: string, file: string): CliCredential {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new CliError(
      `CLI credentials file is corrupt (${file}): ${err instanceof Error ? err.message : String(err)}`,
      'credentials_unreadable',
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(`Invalid CLI credentials file format (${file}): top-level value must be an object`, 'credentials_unreadable')
  }
  const record = parsed as Record<string, unknown>
  if (record['hubUrl'] !== undefined && typeof record['hubUrl'] !== 'string') {
    throw new CliError('Invalid CLI credentials hubUrl: must be a string', 'credentials_unreadable')
  }
  if (record['token'] !== undefined && typeof record['token'] !== 'string') {
    throw new CliError('Invalid CLI credentials token: must be a string', 'credentials_unreadable')
  }
  return { hubUrl: record['hubUrl'] as string | undefined, token: record['token'] as string | undefined }
}

/**
 * Atomic write delegated to the shared `@helmx/env-io` primitive (hidden temp + 0600 + fsync + bounded
 * transient-lock retry on all platforms); wraps failures into the CLI error envelope.
 */
async function atomicWrite0600(file: string, text: string): Promise<void> {
  try {
    await atomicWriteFile(file, text)
  } catch (err) {
    throw new CliError(
      `failed to write CLI credentials file (${file}): ${err instanceof Error ? err.message : String(err)}`,
      'credentials_write_failed',
    )
  }
}

/**
 * Tighten permissions on existing files back to 0600 if widened externally, failing explicitly on error.
 * Windows lacks POSIX modes (NTFS uses ACLs and stat.mode does not express 0600), so skip on win32.
 */
async function ensureMode0600(file: string): Promise<void> {
  if (process.platform === 'win32') return
  const st = await fsp.stat(file)
  if ((st.mode & 0o777) !== 0o600) {
    await fsp.chmod(file, 0o600).catch((err) => {
      throw new CliError(
        `failed to fix CLI credentials file permissions (expected 0600) on ${file}: ${err instanceof Error ? err.message : String(err)}`,
        'credentials_write_failed',
      )
    })
  }
}

/**
 * Load CLI login state; returns empty credentials when the file is missing (not logged in).
 * Callers should check HELMX_TOKEN first to short-circuit disk reads when overridden by env.
 */
export async function loadCliCredential(dataDir: string): Promise<CliCredential> {
  const file = credentialsPath(dataDir)
  let raw: string
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {} as CliCredential
    }
    throw new CliError(
      `failed to read CLI credentials file (${file}): ${err instanceof Error ? err.message : String(err)}`,
      'credentials_unreadable',
    )
  }
  return parseCliTokenFile(raw, file)
}

/** Write CLI login state under an exclusive lock with atomic 0600 writes (shared by setup and login). */
export async function updateCliCredentials(dataDir: string, cli: CliCredential): Promise<void> {
  // Create dataDir before acquiring the lock so both lock and token files have a parent directory (ENOENT on first run)
  await fsp.mkdir(dataDir, { recursive: true })
  const file = credentialsPath(dataDir)
  await withCrossProcessFileLock(
    `${file}.lock`,
    async () => {
      await atomicWrite0600(file, `${JSON.stringify(cli, null, 2)}\n`)
      await ensureMode0600(file)
    },
    {
      waitMs: LOCK_WAIT_MS,
      pollMs: LOCK_POLL_MS,
      settleGraceMs: LOCK_SETTLE_GRACE_MS,
      onBusy: (lockFile) => new CliError(`timed out waiting for CLI credentials lock (${lockFile})`, 'credentials_lock_timeout'),
      onCorrupt: (lockFile) =>
        new CliError(`CLI credentials lock file is corrupt (${lockFile}): cannot determine owner`, 'credentials_lock_broken'),
      onError: (lockFile, err, phase) =>
        new CliError(
          `cannot ${phase === 'create' ? 'create' : 'read'} CLI credentials lock file (${lockFile}): ${err instanceof Error ? err.message : String(err)}`,
          'credentials_lock_failed',
        ),
    },
  )
}
