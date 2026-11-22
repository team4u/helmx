/**
 * Launcher-side re-exports of the shared `@helmx/env-io` Hub state records (`hub.pid` and
 * `launch.json`), PID start-time identity proof, and entry-existence verification.
 */
import fsp from 'node:fs/promises';
import {
  isBlockedVersionActive,
  parseLinuxStartTime,
  persistableLaunchConfig,
  readHubPidRecord,
  readLaunchConfig,
  readProcessStartTime,
  removeHubPidRecordIfMatch,
  resolveEffectiveLaunchConfig,
  writeHubPidRecord,
  writeLaunchConfig,
  type EffectiveLaunchConfig,
  type HubPidRecord,
  type LaunchConfig,
} from '@helmx/env-io';
import { resolveInsideRelease } from '@helmx/env-io/hub-payload';

export {
  isBlockedVersionActive,
  parseLinuxStartTime,
  persistableLaunchConfig,
  readHubPidRecord as readPidRecord,
  readLaunchConfig,
  readProcessStartTime,
  removeHubPidRecordIfMatch as removePidFileIfMatch,
  resolveEffectiveLaunchConfig,
  resolveInsideRelease,
  writeHubPidRecord as writePidRecord,
  writeLaunchConfig,
  type EffectiveLaunchConfig,
  type HubPidRecord,
  type LaunchConfig,
};

/** Entry existence check helper (explicit corruption errors instead of silent fallbacks). */
export async function assertEntryExists(entryPath: string, context: string): Promise<void> {
  try {
    await fsp.access(entryPath);
  } catch {
    throw new Error(
      `${context} points to a missing entry (${entryPath}): staged release may be corrupted; fix current.json or re-run the update instead of guessing another entry`,
    );
  }
}
