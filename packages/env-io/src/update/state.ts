/**
 * Atomic release state files under a state directory (kept separate from user data):
 * `current.json` (active release pointer) and `update-blocked.json` (failure cooldown).
 *
 * Honesty rules: corruption and I/O errors throw explicitly; `null` is returned only on `ENOENT`.
 * Writes are atomic (`0600`, temp file + fsync + rename) via the package's atomic-write helper.
 * All products (`@helmx/node` daemon, Hub launcher, Hub updater, payload handoff) share this
 * canonical schema with zero per-product disk adapters.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { atomicWriteJson } from '../atomic-write.js';

/** Default failure cooldown suppressing retries of a blocked version (30 minutes). */
export const DEFAULT_BLOCKED_COOLDOWN_MS = 30 * 60_000;

/** Active release pointer (`current.json`). `entries` holds consumer-defined absolute entry paths. */
export interface CurrentReleaseRecord {
  version: string;
  updatedAt: string;
  /** Consumer-defined entry points into the active release directory (e.g. `entryPath`). */
  entries: Record<string, string>;
}

/** Failure cooldown record (`update-blocked.json`). */
export interface BlockedReleaseRecord {
  version: string;
  reason: string;
  at: string;
}

/**
 * Read and validate a JSON state file: `null` only on `ENOENT`; unreadable/corrupt files
 * throw explicit errors carrying the path and label.
 */
export async function readStateJson<T>(filePath: string, validate: (raw: unknown) => T, label: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new Error(
      `failed to read ${label} (${filePath}): ${code ?? (error instanceof Error ? error.message : String(error))}`,
    );
  }
  try {
    return validate(JSON.parse(raw));
  } catch (error) {
    throw new Error(`${label} is corrupt (${filePath}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`field ${key} is missing or not a non-empty string`);
  }
  return value;
}

function requireEntries(raw: Record<string, unknown>): Record<string, string> {
  const value = raw['entries'];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('field entries is missing or not an object');
  }
  const entries: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' || entry === '') {
      throw new Error(`field entries.${key} is missing or not a non-empty string`);
    }
    entries[key] = entry;
  }
  if (Object.keys(entries).length === 0) {
    throw new Error('field entries must contain at least one entry path');
  }
  return entries;
}

function validateCurrentRecord(raw: unknown): CurrentReleaseRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected JSON object');
  const rec = raw as Record<string, unknown>;
  return {
    version: requireString(rec, 'version'),
    updatedAt: requireString(rec, 'updatedAt'),
    entries: requireEntries(rec),
  };
}

function validateBlockedRecord(raw: unknown): BlockedReleaseRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected JSON object');
  const rec = raw as Record<string, unknown>;
  return {
    version: requireString(rec, 'version'),
    reason: requireString(rec, 'reason'),
    at: requireString(rec, 'at'),
  };
}

/** Extract a required non-empty entry path from a release record, failing explicitly if missing. */
export function requireReleaseEntry(
  record: Pick<CurrentReleaseRecord, 'entries'>,
  key: string,
  context = 'current.json',
): string {
  const value = record.entries[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${context} entries.${key} is missing or invalid (got ${JSON.stringify(record.entries)})`);
  }
  return value;
}

/** Blocked-version cooldown override (`HELMX_UPGRADE_BLOCK_COOLDOWN_MS`, positive integer ms). */
export function resolveBlockedCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HELMX_UPGRADE_BLOCK_COOLDOWN_MS;
  if (raw === undefined || raw === '') return DEFAULT_BLOCKED_COOLDOWN_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid HELMX_UPGRADE_BLOCK_COOLDOWN_MS: "${raw}" (expected a positive integer)`);
  }
  return parsed;
}

/**
 * True while `blocked` still suppresses attempts at `version` within `cooldownMs`.
 * Fail-closed: an unparseable timestamp keeps blocking rather than guessing.
 */
export function isBlockedVersionActive(
  blocked: Pick<BlockedReleaseRecord, 'version' | 'at'> | null,
  version: string,
  now: Date = new Date(),
  cooldownMs: number = DEFAULT_BLOCKED_COOLDOWN_MS,
): boolean {
  if (blocked === null || blocked.version !== version) return false;
  const at = Date.parse(blocked.at);
  if (!Number.isFinite(at)) return true;
  return now.getTime() - at < cooldownMs;
}

const currentReleasePath = (stateDir: string) => path.join(stateDir, 'current.json');
const blockedReleasePath = (stateDir: string) => path.join(stateDir, 'update-blocked.json');

export async function readCurrentRelease(stateDir: string): Promise<CurrentReleaseRecord | null> {
  return readStateJson(currentReleasePath(stateDir), validateCurrentRecord, 'current.json');
}

export async function writeCurrentRelease(stateDir: string, record: CurrentReleaseRecord): Promise<void> {
  validateCurrentRecord(record);
  await atomicWriteJson(currentReleasePath(stateDir), record, { mode: 0o600 });
}

export async function deleteCurrentRelease(stateDir: string): Promise<void> {
  await fs.rm(currentReleasePath(stateDir), { force: true });
}

export async function readBlockedRelease(stateDir: string): Promise<BlockedReleaseRecord | null> {
  return readStateJson(blockedReleasePath(stateDir), validateBlockedRecord, 'update-blocked.json');
}

export async function writeBlockedRelease(stateDir: string, record: BlockedReleaseRecord): Promise<void> {
  validateBlockedRecord(record);
  await atomicWriteJson(blockedReleasePath(stateDir), record, { mode: 0o600 });
}

export async function clearBlockedRelease(stateDir: string): Promise<void> {
  await fs.rm(blockedReleasePath(stateDir), { force: true });
}
