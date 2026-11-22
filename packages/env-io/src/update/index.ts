/**
 * The shared self-update engine for long-running Helmx processes (`@helmx/node` daemon,
 * local Hub launcher, in-Hub updater, and payload update handoff), living under
 * `@helmx/env-io`'s `update/` subtree and re-exported from the package root.
 *
 * Mechanisms provided (policy stays with the consumer):
 * - npm registry access: dist-tag/exact metadata fetch with timeouts, SHA-512 SRI verified
 *   tarball download (`downloadVerifiedTarball`), registry allowlisting for RPC-exposed inputs;
 * - strict SemVer & dist-tag validation (`assertStrictSemver`, `assertDistTag`, `compareSemver`,
 *   `normalizeTargetVersion`);
 * - immutable release staging: `releases/<version>/<uuid>/` directories with a `.complete`
 *   marker, cache revalidation, layout declared per product via `ReleaseLayout` or `StageExtractor`;
 * - atomic state: unified `current.json` (`CurrentReleaseRecord`) / `update-blocked.json`
 *   (`isBlockedVersionActive`, `resolveBlockedCooldownMs`) and stale-PID-recovering `upgrade.lock`;
 * - controlled npm runner: shell-free spawn, capped output, process-group kill on timeout;
 * - update & Hub-switch orchestration: `performUpdate` (Node) and `commitAndSwitchHubRelease` /
 *   `spawnDetachedHubRelease` / `stopHubViaControlChannel` / `hub.pid` & `launch.json` (Hub).
 *
 * The engine depends only on `@helmx/protocol` (strict SemVer) and Node builtins (zero `tar`
 * dependency — Hub tarball unpacking stays isolated under the `./hub-payload` subpath).
 */
export {
  UpgradeRejectedError,
  UpgradeCommitUnconfirmedError,
} from './errors.js';
export {
  assertDistTag,
  assertStrictSemver,
  compareSemver,
  compareStrictSemver,
  isStrictSemver,
  normalizeTargetVersion,
} from './semver.js';
export {
  DEFAULT_REGISTRY,
  METADATA_TIMEOUT_MS,
  TARBALL_TIMEOUT_MS,
  filterRpcRegistryUrl,
  resolveRegistryUrl,
  fetchExactManifest,
  fetchLatestVersion,
  downloadTarball,
  downloadVerifiedTarball,
  computeSri,
  type RegistryManifest,
  type DownloadTarballOptions,
} from './registry.js';
export {
  DEFAULT_BLOCKED_COOLDOWN_MS,
  readCurrentRelease,
  writeCurrentRelease,
  deleteCurrentRelease,
  readBlockedRelease,
  writeBlockedRelease,
  clearBlockedRelease,
  readStateJson,
  requireReleaseEntry,
  resolveBlockedCooldownMs,
  isBlockedVersionActive,
  type CurrentReleaseRecord,
  type BlockedReleaseRecord,
} from './state.js';
export { runNpm } from './npm-runner.js';
export {
  DEFAULT_CONTROLLED_OUTPUT_CAP,
  resolveNpmCommand,
  runControlledProcess,
  type ControlledProcessOptions,
  type ControlledProcessResult,
  type ResolveNpmCommandIo,
} from './process-runner.js';
export {
  stageRelease,
  type NpmPackageSpec,
  type ReleaseLayout,
  type StagedRelease,
  type StageExtractor,
  type StageReleaseOptions,
} from './staging.js';
export {
  checkForUpdate,
  performUpdate,
  withUpdateLock,
  type UpdateSource,
  type UpdateSpec,
  type CheckForUpdateOptions,
  type UpdateCheckResult,
  type PerformUpdateOptions,
  type PreparedReplacement,
  type UpdateResult,
} from './upgrade.js';
export {
  HUB_LISTEN_LINE_PATTERN,
  hubPidPath,
  hubLaunchConfigPath,
  hubLogPath,
  hubLifecycleLockPath,
  readHubPidRecord,
  writeHubPidRecord,
  removeHubPidRecordIfMatch,
  readLaunchConfig,
  writeLaunchConfig,
  resolveEffectiveLaunchConfig,
  persistableLaunchConfig,
  assertListenUrlMatches,
  waitForHubListenLine,
  spawnDetachedHubRelease,
  stopHubViaControlChannel,
  commitAndSwitchHubRelease,
  type HubPidRecord,
  type LaunchConfig,
  type EffectiveLaunchConfig,
  type SpawnDetachedHubOptions,
  type SpawnedDetachedHub,
  type StopHubViaControlOptions,
  type StopHubViaControlOutcome,
  type CommitHubSwitchOptions,
} from './hub-switch.js';
