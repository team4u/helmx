/**
 * npm registry access primitives: URL resolution/allowlisting, metadata fetch with
 * timeouts, verified tarball download, and SRI computation.
 *
 * Every network result is validated at this boundary (exact package name/version,
 * `sha512-` integrity shape, `http(s)` tarball URL); nothing malformed flows into
 * staging. Timeouts abort explicitly and surface as errors, never as empty results.
 */
import fs from 'node:fs/promises';
import rawFs from 'node:fs';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { UpgradeRejectedError } from './errors.js';
import { assertDistTag } from './semver.js';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** Metadata request timeout (latest/exact-version documents). */
export const METADATA_TIMEOUT_MS = 30_000;
/** Tarball download timeout (default; override per call). */
export const TARBALL_TIMEOUT_MS = 180_000;

const normalizeRegistry = (url: string | undefined): string => (url ?? '').trim().replace(/\/+$/, '');

/**
 * RPC registry allowlist: permits only the official npm registry or `HELMX_NPM_REGISTRY`.
 * Rejects any other explicit URL with `UpgradeRejectedError`.
 */
export function filterRpcRegistryUrl(registryUrl?: string): string | undefined {
  const requested = normalizeRegistry(registryUrl);
  if (!requested) return undefined;
  if (requested === DEFAULT_REGISTRY) return requested;
  const envRegistry = normalizeRegistry(process.env.HELMX_NPM_REGISTRY);
  if (envRegistry && requested === envRegistry) return requested;
  throw new UpgradeRejectedError(
    `untrusted npm registry rejected: ${requested} (only ${DEFAULT_REGISTRY} or HELMX_NPM_REGISTRY is permitted)`,
  );
}

/** Resolve the effective registry URL: explicit argument, then `HELMX_NPM_REGISTRY`, then npmjs. */
export function resolveRegistryUrl(explicit?: string): string {
  return normalizeRegistry(explicit || process.env.HELMX_NPM_REGISTRY || DEFAULT_REGISTRY);
}

async function fetchJsonWithTimeout(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`request timed out (${timeoutMs}ms)`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Exact-version registry document subset the engine depends on. */
export interface RegistryManifest {
  integrity: string;
  tarball: string;
}

/** Fetch and validate the exact-version manifest of `pkgName@version`. */
export async function fetchExactManifest(
  registryUrl: string,
  pkgName: string,
  version: string,
  fetchImpl: typeof fetch,
): Promise<RegistryManifest> {
  const url = `${registryUrl}/${pkgName}/${version}`;
  let data: { name?: unknown; version?: unknown; dist?: { integrity?: unknown; tarball?: unknown } };
  try {
    data = (await fetchJsonWithTimeout(url, fetchImpl, METADATA_TIMEOUT_MS)) as typeof data;
  } catch (error) {
    throw new Error(
      `failed to fetch ${pkgName}@${version} metadata (${url}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (data.name !== pkgName) {
    throw new Error(`registry metadata package name mismatch: expected ${pkgName}, got ${JSON.stringify(data.name)}`);
  }
  if (data.version !== version) {
    throw new Error(`registry metadata version mismatch: expected ${version}, got ${JSON.stringify(data.version)}`);
  }
  const integrity = data.dist?.integrity;
  const tarball = data.dist?.tarball;
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    throw new Error(`${pkgName}@${version} metadata missing valid sha512 dist.integrity`);
  }
  if (typeof tarball !== 'string' || !/^https?:\/\//.test(tarball)) {
    throw new Error(`${pkgName}@${version} metadata missing valid dist.tarball`);
  }
  return { integrity, tarball };
}

/** Query the version a dist-tag points at (`latest` by default; e.g. `beta` for pre-release channels). */
export async function fetchLatestVersion(
  registryUrl: string,
  pkgName: string,
  fetchImpl: typeof fetch,
  tag: string = 'latest',
): Promise<string> {
  assertDistTag(tag);
  const url = `${registryUrl}/${pkgName}/${tag}`;
  let latestVersion: string;
  try {
    const data = (await fetchJsonWithTimeout(url, fetchImpl, METADATA_TIMEOUT_MS)) as { version?: unknown };
    if (typeof data.version !== 'string') {
      throw new Error(`response missing version field: ${JSON.stringify(data).slice(0, 200)}`);
    }
    latestVersion = data.version;
  } catch (error) {
    throw new Error(
      `failed to query latest version for dist-tag ${tag} at ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return latestVersion;
}

export interface DownloadTarballOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

async function downloadTarballWithSri(
  url: string,
  destPath: string,
  options?: DownloadTarballOptions,
): Promise<string> {
  const fetchImpl = options?.fetchFn ?? fetch;
  const timeoutMs = options?.timeoutMs ?? TARBALL_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const hash = createHash('sha512');
  let handle: fs.FileHandle | undefined;
  let succeeded = false;
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    handle = await fs.open(destPath, 'w', 0o600);
    if (process.platform !== 'win32') await handle.chmod(0o600);
    if (res.body !== null) {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.byteLength > 0) {
            hash.update(value);
            let written = 0;
            while (written < value.byteLength) {
              const { bytesWritten } = await handle.write(value, written, value.byteLength - written);
              written += bytesWritten;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    await handle.close();
    handle = undefined;
    succeeded = true;
    return `sha512-${hash.digest('base64')}`;
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    if (!succeeded) await fs.rm(destPath, { force: true }).catch(() => undefined);
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`download timed out (${timeoutMs}ms)`);
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

/** Download a tarball to `destPath` (mode `0600`) with a hard timeout; integrity is verified by the caller. */
export async function downloadTarball(url: string, destPath: string, options?: DownloadTarballOptions): Promise<void> {
  await downloadTarballWithSri(url, destPath, options);
}

/** Compute the SRI string (`sha512-<base64>`) of a file, streamed so large tarballs stay off the heap. */
export function computeSri(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    const stream = rawFs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(`sha512-${hash.digest('base64')}`));
  });
}

/**
 * Fetch the exact-version manifest, stream its tarball to `destPath` while computing its SHA-512
 * SRI in a single pass, and verify against the registry-declared integrity — the single
 * verified-download seam shared by release staging and consumer installers (Hub payload extraction).
 * Diagnostics preserve the original helmx-node wording so consumers' error contracts
 * stay byte-stable.
 */
export async function downloadVerifiedTarball(
  registryUrl: string,
  pkgName: string,
  version: string,
  destPath: string,
  fetchFn?: typeof fetch,
): Promise<void> {
  const manifest = await fetchExactManifest(registryUrl, pkgName, version, fetchFn ?? fetch);
  let actual: string;
  try {
    actual = await downloadTarballWithSri(manifest.tarball, destPath, { fetchFn });
  } catch (error) {
    throw new Error(
      `failed to download ${pkgName}@${version} tarball (${manifest.tarball}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (actual !== manifest.integrity) {
    await fs.rm(destPath, { force: true }).catch(() => undefined);
    throw new Error(
      `${pkgName}@${version} tarball sha512 integrity check failed: expected ${manifest.integrity}, got ${actual}`,
    );
  }
}
