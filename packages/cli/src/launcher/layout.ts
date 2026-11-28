/**
 * Install-root layout and product defaults for the Hub launcher.
 *
 * Program state is strictly separated from user data: releases, current/blocked pointers (via
 * `@helmx/env-io`), the pid record, and logs live under the launcher install root
 * (default `~/.helmx-hub`, env `HELMX_HUB_INSTALL_ROOT`), while the Hub's own `~/.helmx`
 * (`HELMX_DATA_DIR`) data directory and plugin state are never written by the launcher.
 */
import os from 'node:os';
import path from 'node:path';
import {
  assertDistTag,
  DEFAULT_BLOCKED_COOLDOWN_MS,
  hubLaunchConfigPath,
  hubLifecycleLockPath,
  hubLogPath,
  hubPidPath,
  resolveBlockedCooldownMs,
} from '@helmx/env-io';
import { assertInstallIsolation, resolveRegistryUrlForEnv } from '@helmx/env-io/hub-payload';

export { assertDistTag, assertInstallIsolation, resolveBlockedCooldownMs };
export const resolveRegistryUrl = resolveRegistryUrlForEnv;

export const DEFAULT_PAYLOAD_PACKAGE = '@helmx/hub';

/** Timeouts and cooldowns; every one is injectable/overridable so tests never rely on wall-clock luck. */
export const DEFAULTS = {
  /** Overall readiness budget when starting a Hub candidate (stdout listen line + liveness). */
  healthTimeoutMs: 60_000,
  /** Readiness poll interval (log scan + liveness). */
  healthPollMs: 500,
  /** Per-request probe timeout for a single auxiliary `GET /api/auth/status`. */
  healthRequestTimeoutMs: 2_000,
  /** Grace period between SIGTERM and process-tree escalation when stopping the Hub. */
  stopTimeoutMs: 20_000,
  /** Wait after escalation before declaring the process unstoppable. */
  stopEscalationWaitMs: 10_000,
  /** Cooldown before the same blocked version may be retried (env `HELMX_UPGRADE_BLOCK_COOLDOWN_MS`). */
  blockedCooldownMs: DEFAULT_BLOCKED_COOLDOWN_MS,
  /** npm install inside a staged candidate (run through the engine's npm runner). */
  npmInstallTimeoutMs: 300_000,
  /** `node start.mjs check` self-verification budget inside staging. */
  payloadCheckTimeoutMs: 120_000,
  /** Short probe used to verify hub identity before signalling a pid. */
  identityProbeTimeoutMs: 2_000,
  /** Update-check interval default (env `HELMX_HUB_UPDATE_INTERVAL_MS`). */
  updateIntervalMs: 15 * 60 * 1000,
} as const;

export interface LauncherPaths {
  root: string;
  releasesDir: string;
  pidPath: string;
  launchConfigPath: string;
  logDir: string;
  hubLogPath: string;
  /** Serializes process-state mutations (start/stop and the update stop→commit→start window). */
  lifecycleLockPath: string;
}

export function pathsOf(root: string): LauncherPaths {
  return {
    root,
    releasesDir: path.join(root, 'releases'),
    pidPath: hubPidPath(root),
    launchConfigPath: hubLaunchConfigPath(root),
    logDir: path.join(root, 'logs'),
    hubLogPath: hubLogPath(root),
    lifecycleLockPath: hubLifecycleLockPath(root),
  };
}

export function resolveInstallRoot(env: NodeJS.ProcessEnv): string {
  const explicit = env.HELMX_HUB_INSTALL_ROOT;
  if (explicit !== undefined && explicit !== '') return path.resolve(explicit);
  return path.join(os.homedir(), '.helmx-hub');
}

/**
 * The Hub's data directory when no explicit value is configured (mirrors the kernel's
 * `resolveDataDir`: `HELMX_DATA_DIR` when non-empty, else `~/.helmx`).
 */
export function defaultHubDataDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.HELMX_DATA_DIR;
  if (fromEnv !== undefined && fromEnv !== '') return path.resolve(fromEnv);
  return path.join(os.homedir(), '.helmx');
}

/** Published Hub payload package name (`HELMX_PAYLOAD_PACKAGE` overrides; must match the payload build). */
export function resolvePayloadPackageName(env: NodeJS.ProcessEnv): string {
  const value = env.HELMX_PAYLOAD_PACKAGE ?? DEFAULT_PAYLOAD_PACKAGE;
  if (value === '' || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(value)) {
    throw new Error(`invalid payload package name: "${value}"`);
  }
  return value;
}
