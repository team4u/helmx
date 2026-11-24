/**
 * `helmx-node` self-upgrade policy over the shared update engine in `@helmx/env-io`.
 *
 * Node-specific policy kept here:
 * - the `@helmx/node` package release layout (overridable via `HELMX_NPM_PACKAGE`);
 * - the daemon's own version resolution (`getNodeVersion` reads this package's `package.json`;
 *   `HELMX_VERSION_OVERRIDE` overrides for dev).
 *
 * All generic mechanism — registry access, SHA-512 SRI verified staging, immutable `.complete`
 * candidates, unified `current.json` (`CurrentReleaseRecord`), `update-blocked.json`,
 * `upgrade.lock`, drain gate, strict commit-at-replacement ordering, and rollback plus cooldown —
 * lives in `@helmx/env-io`. Error classes are re-exported from that single module copy so
 * `instanceof` identity holds across package boundaries.
 */
import rawFs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isStrictSemver, type NodeInstallMode, type NodeUpgradeCheckResult, type NodeUpgradeResult } from '@helmx/protocol';
import { detectNodeInstallMode } from '../service-entry.js';
import {
  UpgradeCommitUnconfirmedError,
  UpgradeRejectedError,
  checkForUpdate,
  clearBlockedRelease,
  compareSemver,
  deleteCurrentRelease,
  filterRpcRegistryUrl,
  normalizeTargetVersion,
  performUpdate,
  readBlockedRelease,
  readCurrentRelease,
  runNpm,
  stageRelease,
  writeBlockedRelease,
  writeCurrentRelease,
  type BlockedReleaseRecord,
  type CheckForUpdateOptions,
  type CurrentReleaseRecord,
  type PerformUpdateOptions,
  type PreparedReplacement,
  type ReleaseLayout,
  type StageReleaseOptions,
  type StagedRelease,
  type UpdateSpec,
} from '@helmx/env-io';

export {
  UpgradeRejectedError,
  UpgradeCommitUnconfirmedError,
  compareSemver,
  normalizeTargetVersion,
  filterRpcRegistryUrl,
  runNpm,
  readCurrentRelease,
  writeCurrentRelease,
  deleteCurrentRelease,
  readBlockedRelease,
  writeBlockedRelease,
  clearBlockedRelease,
};
export type {
  BlockedReleaseRecord,
  CheckForUpdateOptions,
  CurrentReleaseRecord,
  PreparedReplacement,
  StageReleaseOptions,
};

export type StagedNodeRelease = StagedRelease;
export type PreparedNodeReplacement = PreparedReplacement;
export type PerformNodeUpgradeOptions = PerformUpdateOptions;
export type CheckNodeUpgradeOptions = CheckForUpdateOptions & { installMode?: NodeInstallMode };

let cachedPackageVersion: string | undefined;

/** Read the node package's own `package.json` version (`HELMX_VERSION_OVERRIDE` overrides for dev). */
export function getNodeVersion(): string {
  const override = process.env.HELMX_VERSION_OVERRIDE?.trim();
  if (override) return override;
  if (!cachedPackageVersion) {
    const selfDir = path.dirname(fileURLToPath(import.meta.url));
    // Published single-file bundle layout (<pkg>/dist/cli.js) keeps package.json one level up;
    // the workspace source layout (dist/daemon/upgrader.js) keeps it two levels up.
    const pkgCandidates = [path.resolve(selfDir, '../package.json'), path.resolve(selfDir, '../../package.json')];
    let pkgPath: string | undefined;
    for (const candidate of pkgCandidates) {
      if (rawFs.existsSync(candidate)) {
        pkgPath = candidate;
        break;
      }
    }
    if (pkgPath === undefined) {
      throw new Error(`failed to locate node package.json (tried ${pkgCandidates.join(', ')})`);
    }
    try {
      const parsed = JSON.parse(rawFs.readFileSync(pkgPath, 'utf8')) as { version?: unknown };
      if (typeof parsed.version !== 'string' || !isStrictSemver(parsed.version)) {
        throw new Error(`version field missing or invalid: ${JSON.stringify(parsed.version)}`);
      }
      cachedPackageVersion = parsed.version;
    } catch (error) {
      throw new Error(`failed to read node package version (${pkgPath}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return cachedPackageVersion;
}

/**
 * Resolve effective node version for offline CLI status and update checks:
 * - In `source` mode: always return this source package's `package.json` version (ignore stale `current.json`);
 * - In `release` mode: `current.json` takes precedence over own package version.
 */
export async function resolveEffectiveNodeVersion(
  dataDir: string,
  installMode: NodeInstallMode = detectNodeInstallMode(),
): Promise<string> {
  if (installMode === 'source') return getNodeVersion();
  const current = await readCurrentRelease(dataDir);
  return current?.version ?? getNodeVersion();
}

const nodePackageName = (): string => process.env.HELMX_NPM_PACKAGE || '@helmx/node';

function makeNodeReleaseLayout(): ReleaseLayout {
  const nodePkg = nodePackageName();
  return {
    packages: [{ name: nodePkg, requiredFiles: ['dist/cli.js'] }],
    resolveEntries: () => ({
      entryPath: path.join('node_modules', ...nodePkg.split('/'), 'dist', 'cli.js'),
    }),
  };
}

function makeNodeUpdateSpec(): UpdateSpec {
  return {
    packageName: nodePackageName(),
    getFallbackVersion: getNodeVersion,
    layout: makeNodeReleaseLayout(),
  };
}

export async function checkNodeUpgrade(
  dataDir: string,
  options?: CheckNodeUpgradeOptions,
): Promise<NodeUpgradeCheckResult> {
  const { installMode, ...rest } = options ?? {};
  const currentVersion =
    rest.currentVersion ?? (await resolveEffectiveNodeVersion(dataDir, installMode));
  return checkForUpdate(dataDir, makeNodeUpdateSpec(), { ...rest, currentVersion });
}

export async function stageReleaseFromNpm(
  dataDir: string,
  targetVersion: string,
  options?: StageReleaseOptions,
): Promise<StagedNodeRelease> {
  return stageRelease(dataDir, targetVersion, makeNodeReleaseLayout(), options);
}

export async function performNodeUpgrade(
  dataDir: string,
  options?: PerformNodeUpgradeOptions,
): Promise<NodeUpgradeResult> {
  return performUpdate(dataDir, makeNodeUpdateSpec(), options);
}
