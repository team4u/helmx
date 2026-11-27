/**
 * Node identity & Hub URL persistence (`<dataDir>/node.json`):
 * - Strict JOIN token parsing (`nodeId:secret`, excluding reserved `local`) and `http(s)` Hub URL validation.
 * - Atomic `0600` persistence serialized by an in-process queue + cross-process `node.json.lock`.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import type { NodeConnectInput } from '@helmx/protocol';
import { DEFAULT_NODE_ID } from '@helmx/protocol';
import { atomicWriteJson, withCrossProcessFileLock } from '@helmx/env-io';

export interface NodeIdentity {
  nodeId: string;
  token: string;
  /** Hub URL recorded at bind time (informational hint; callers may override via `hubUrl`). */
  hubUrl?: string;
}

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const JOIN_SECRET_PATTERN = /^[^\s\x00-\x1f\x7f]+$/;

/** Resolve node data directory: explicit > `HELMX_DATA_DIR` > `~/.helmx`. */
export function resolveNodeDataDir(explicit?: string): string {
  if (explicit !== undefined && explicit !== '') return explicit;
  const fromEnv = process.env['HELMX_DATA_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return path.join(os.homedir(), '.helmx');
}

/**
 * Parse a JOIN token (`nodeId:secret`); `nodeId` excludes colons and the reserved `'local'` ID,
 * while `secret` may contain colons (split on the first colon).
 */
export function parseJoinToken(token: string): { nodeId: string; secret: string } | null {
  if (typeof token !== 'string') return null;
  if (token !== token.trim()) return null;
  const index = token.indexOf(':');
  if (index <= 0 || index === token.length - 1) return null;
  const nodeId = token.slice(0, index);
  const secret = token.slice(index + 1);
  if (!NODE_ID_PATTERN.test(nodeId) || nodeId === DEFAULT_NODE_ID) return null;
  if (!JOIN_SECRET_PATTERN.test(secret)) return null;
  return { nodeId, secret };
}

/** Validate an `http(s)` Hub URL without userinfo, fragment, or query parameters. */
export function assertValidHubUrl(hubUrl: string): URL {
  if (typeof hubUrl !== 'string' || hubUrl === '' || hubUrl !== hubUrl.trim()) throw new Error('Hub URL must be a non-empty URL');
  let parsed: URL;
  try {
    parsed = new URL(hubUrl);
  } catch {
    throw new Error('Hub URL is malformed');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Hub URL protocol must be http or https: ${parsed.protocol}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('Hub URL must not contain userinfo (user:pass@)');
  }
  if (parsed.hash !== '' || parsed.search !== '') {
    throw new Error('Hub URL must not contain a fragment or query string');
  }
  return parsed;
}

/** Strictly validate a `NodeIdentity` object. */
export function assertValidIdentity(identity: unknown, context: string): asserts identity is NodeIdentity {
  const invalid = (detail: string): Error =>
    new Error(`${context}: ${detail} (expected { nodeId, token[, hubUrl] } with nodeId matching ${NODE_ID_PATTERN})`);
  if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) {
    throw invalid('value is not an object');
  }
  const record = identity as Record<string, unknown>;
  if (typeof record['nodeId'] !== 'string' || !NODE_ID_PATTERN.test(record['nodeId']) || record['nodeId'] === DEFAULT_NODE_ID) {
    throw invalid('nodeId is missing or invalid');
  }
  if (typeof record['token'] !== 'string' || parseJoinToken(record['token'])?.nodeId !== record['nodeId']) {
    throw invalid('token is invalid or does not match nodeId');
  }
  if (record['hubUrl'] !== undefined) {
    if (typeof record['hubUrl'] !== 'string') throw invalid('hubUrl must be a string');
    try {
      assertValidHubUrl(record['hubUrl']);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error));
    }
  }
}

/** Read `<dataDir>/node.json`: returns `null` only on `ENOENT`; throws explicitly on corruption or I/O errors. */
export async function readNodeIdentity(dataDir: string): Promise<NodeIdentity | null> {
  const file = path.join(dataDir, 'node.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`node identity file is corrupt (${file}): invalid JSON`);
  }
  try {
    assertValidIdentity(parsed, `node identity file has invalid schema (${file})`);
  } catch (error) {
    throw new Error(`node identity file has invalid schema (${file}): ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
}

/** Atomically persist `<dataDir>/node.json` with `0600` permissions via the shared `@helmx/env-io` primitive. */
export async function writeNodeIdentity(dataDir: string, identity: NodeIdentity): Promise<void> {
  assertValidIdentity(identity, 'invalid node identity');
  await atomicWriteJson(path.join(dataDir, 'node.json'), identity, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Identity binding lock (in-process queue + cross-process lock file)
// ---------------------------------------------------------------------------

const bindLocks = new Map<string, Promise<unknown>>();

/** Serialize identity binding per `dataDir` via an in-process queue and cross-process `node.json.lock` (with dead-PID stale recovery). */
async function withIdentityLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = bindLocks.get(dataDir);
  let releaseInner: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseInner = resolve;
  });
  bindLocks.set(dataDir, gate);
  try {
    if (previous !== undefined) await previous;
  } catch {
    // Prior failure does not block subsequent bind attempts.
  }
  const lockPath = path.join(dataDir, 'node.json.lock');
  const busyError = (file: string, ownerPid?: number): Error =>
    new Error(
      `concurrent identity bind conflict: ${file} already exists${ownerPid !== undefined ? ` (held by pid ${ownerPid})` : ''} (another helmx-node connect is writing, or a previous bind crashed); confirm no bind is active and remove the lock file before retrying`,
    );
  // Recovery in progress leaves a break marker rather than a lock file, so `busyError`'s advice would be wrong here.
  const recoveringError = (_file: string, markers: string[]): Error =>
    new Error(
      `stale identity lock is being recovered (${markers.join(', ')}): another bind is clearing a dead owner's lock; retry shortly; if no bind is active, remove the stale marker file(s)`,
    );
  try {
    return await withCrossProcessFileLock(lockPath, fn, {
      waitMs: 0,
      onBusy: busyError,
      onCorrupt: (file) => busyError(file),
      onRecovering: recoveringError,
    });
  } finally {
    releaseInner();
    if (bindLocks.get(dataDir) === gate) bindLocks.delete(dataDir);
  }
}

/** Redacted token shape description for error messages (never leaks prefix or secret bytes). */
function describeToken(token: string): string {
  const kind = typeof token !== 'string' ? `type ${typeof token}` : `length ${token.length}`;
  return `token (${kind}) does not match expected format`;
}

/**
 * Persist JOIN identity binding: saves new identity, rotates token for the same `nodeId`, or
 * rejects a different `nodeId` explicitly (requires manual cleanup of `node.json`).
 */
export async function bindIdentityFromJoinToken(
  dataDir: string,
  token: string,
  hubUrl: string,
): Promise<NodeIdentity> {
  const parsed = parseJoinToken(token);
  if (parsed === null) {
    throw new Error(`invalid JOIN token format (expected nodeId:secret, nodeId without colons and not 'local'): ${describeToken(token)}`);
  }
  try {
    assertValidHubUrl(hubUrl);
  } catch (error) {
    throw new Error(`JOIN bind failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const resolvedDataDir = path.resolve(dataDir);
  return await withIdentityLock(resolvedDataDir, async () => {
    const existing = await readNodeIdentity(resolvedDataDir);
    if (existing !== null && existing.nodeId !== parsed.nodeId) {
      throw new Error(
        `dataDir is already bound to node ${existing.nodeId}, refusing to rebind to ${parsed.nodeId}; remove ${path.join(dataDir, 'node.json')} first if changing nodes`,
      );
    }
    const identity: NodeIdentity = { nodeId: parsed.nodeId, token, hubUrl };
    await writeNodeIdentity(resolvedDataDir, identity);
    return identity;
  });
}

/** Parse and bind runtime identity from JOIN token input (never falls back to stale stored identity on bad token). */
export async function resolveRunIdentity(dataDir: string, input: NodeConnectInput): Promise<NodeIdentity> {
  if (parseJoinToken(input.token) === null) {
    throw new Error(
      `invalid token, refusing to start (must be a Hub-issued JOIN token nodeId:secret without colons in nodeId, not 'local'): ${describeToken(input.token)}`,
    );
  }
  return bindIdentityFromJoinToken(dataDir, input.token, input.hubUrl);
}
