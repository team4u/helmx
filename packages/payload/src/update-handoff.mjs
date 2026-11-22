#!/usr/bin/env node
/**
 * Zero-config update handoff for a payload-managed Hub (spawned detached by the Hub's
 * `/api/hub-update/apply`, or manually for recovery). One shot, release-locked to the target
 * release directory (it imports `@helmx/env-io` from the payload's own node_modules).
 *
 * Delegates all switch mechanics (lifecycle lock, verified control-channel stop, detached spawn
 * with listen-line + `assertListenUrlMatches` readiness gate, atomic `hub.pid` persistence, and
 * rollback-before-restart + blocked-release recording) to `@helmx/env-io` so CLI launcher and
 * payload handoff never drift.
 *
 * Environment inputs (all required unless noted):
 *   HELMX_HANDOFF_ROOT                 install root (releases/, state, logs)
 *   HELMX_HANDOFF_TARGET               strict-SemVer target version
 *   HELMX_HANDOFF_ENTRY                absolute payload entry (start.mjs) of the target
 *   HELMX_HANDOFF_RELEASE_DIR          absolute staged release dir (for record keeping)
 *   HELMX_HANDOFF_DATA_DIR             hub data directory (control record + hub.pid dataDir)
 *   HELMX_HANDOFF_CONTROL_ENDPOINT     control channel endpoint of the running hub
 *   HELMX_HANDOFF_CONTROL_INSTANCE_ID  control channel instanceId
 *   HELMX_HANDOFF_LAUNCH_ID            optional fresh launch id for the new hub process
 *   HELMX_HANDOFF_GRACE_MS             optional grace override (default 2000)
 *   HELMX_HANDOFF_TEST_*               test hooks: fast timeouts
 */
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  commitAndSwitchHubRelease,
  hubLifecycleLockPath,
  hubLogPath,
  isStrictSemver,
  readCurrentRelease,
  readLaunchConfig,
  resolveEffectiveLaunchConfig,
  spawnDetachedHubRelease,
  stopHubViaControlChannel,
  withCrossProcessFileLock,
  writeHubPidRecord,
} from '@helmx/env-io';
import { clearUpdateReady, readUpdateReady } from '@helmx/env-io/hub-payload';

const ROOT = process.env.HELMX_HANDOFF_ROOT ?? '';
const TARGET = process.env.HELMX_HANDOFF_TARGET ?? '';
const ENTRY = process.env.HELMX_HANDOFF_ENTRY ?? '';
const RELEASE_DIR = process.env.HELMX_HANDOFF_RELEASE_DIR ?? '';
const DATA_DIR = process.env.HELMX_HANDOFF_DATA_DIR ?? '';
const CONTROL_ENDPOINT = process.env.HELMX_HANDOFF_CONTROL_ENDPOINT ?? '';
const CONTROL_INSTANCE_ID = process.env.HELMX_HANDOFF_CONTROL_INSTANCE_ID ?? '';
const LAUNCH_ID = process.env.HELMX_HANDOFF_LAUNCH_ID || randomUUID();
const GRACE_MS = Number(process.env.HELMX_HANDOFF_GRACE_MS ?? '2000');
const READY_TIMEOUT_MS = Number(process.env.HELMX_HANDOFF_TEST_READY_TIMEOUT_MS ?? '60000');
const STOP_TIMEOUT_MS = Number(process.env.HELMX_HANDOFF_TEST_STOP_TIMEOUT_MS ?? '15000');
const LOG = path.join(ROOT, 'logs', 'handoff.log');

function log(line) {
  const stamped = `[handoff ${new Date().toISOString()}] ${line}`;
  process.stderr.write(`${stamped}\n`);
  fsp.appendFile(LOG, `${stamped}\n`, 'utf8').catch(() => undefined);
}

const fail = (message) => {
  log(`FAILED: ${message}`);
  process.exit(1);
};

function validateEnv() {
  const required = [
    ['HELMX_HANDOFF_ROOT', ROOT],
    ['HELMX_HANDOFF_TARGET', TARGET],
    ['HELMX_HANDOFF_ENTRY', ENTRY],
    ['HELMX_HANDOFF_RELEASE_DIR', RELEASE_DIR],
    ['HELMX_HANDOFF_CONTROL_ENDPOINT', CONTROL_ENDPOINT],
    ['HELMX_HANDOFF_CONTROL_INSTANCE_ID', CONTROL_INSTANCE_ID],
  ];
  for (const [name, value] of required) {
    if (value === '') fail(`missing required environment variable ${name}`);
  }
  if (!isStrictSemver(TARGET)) fail(`HELMX_HANDOFF_TARGET is not strict SemVer: "${TARGET}"`);
}

async function resolveEntryFile(version, rawEntry) {
  const resolved = path.isAbsolute(rawEntry) ? rawEntry : path.join(ROOT, 'releases', version, rawEntry);
  try {
    await fsp.access(resolved);
  } catch {
    throw new Error(`release entry missing: ${resolved}`);
  }
  return resolved;
}

async function main() {
  validateEnv();
  await fsp.mkdir(path.dirname(LOG), { recursive: true });
  log(`handoff started: target ${TARGET} (root ${ROOT})`);

  const ready = await readUpdateReady(ROOT).catch(() => null);
  if (ready === null || ready.version !== TARGET) {
    fail(`update-ready.json does not describe target ${TARGET} (found: ${ready === null ? 'none' : ready.version}); refusing to switch`);
  }

  const graceMs = Number.isFinite(GRACE_MS) && GRACE_MS >= 0 ? GRACE_MS : 2000;
  if (graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs));

  await withCrossProcessFileLock(
    hubLifecycleLockPath(ROOT),
    async () => {
      const previous = await readCurrentRelease(ROOT);
      if (previous === null) throw new Error('no current release to roll back to; the CLI owns bootstrap installs');

      const stop = await stopHubViaControlChannel({
        dataDir: DATA_DIR,
        expectedControl: { endpoint: CONTROL_ENDPOINT, instanceId: CONTROL_INSTANCE_ID },
        stopTimeoutMs: Number.isFinite(STOP_TIMEOUT_MS) && STOP_TIMEOUT_MS > 0 ? STOP_TIMEOUT_MS : 15_000,
        escalateOnTimeout: false,
      });
      if (!stop.stopped) {
        throw new Error(`control-channel stop was not accepted (${stop.detail}); nothing was committed`);
      }
      log(`stopped hub pid ${stop.pid} over the control channel`);

      const config = resolveEffectiveLaunchConfig({
        env: process.env,
        saved: await readLaunchConfig(ROOT),
        ...(DATA_DIR !== '' ? { flags: { dataDir: DATA_DIR } } : {}),
      });
      const readyTimeoutMs = Number.isFinite(READY_TIMEOUT_MS) && READY_TIMEOUT_MS > 0 ? READY_TIMEOUT_MS : 60_000;
      const targetEntryPath = path.resolve(RELEASE_DIR, ready.entryPath);
      const effectiveTargetEntry = path.resolve(ENTRY);

      const { started } = await commitAndSwitchHubRelease({
        root: ROOT,
        targetVersion: TARGET,
        targetEntryPath,
        previousRecord: previous,
        shouldStart: true,
        restartPreviousOnRollback: true,
        blockedReasonPrefix: 'handoff',
        logPathHint: hubLogPath(ROOT),
        onLog: log,
        formatRestored: (restored, prev) => `rolled back to ${prev.version} (pid ${restored.pid})`,
        startRelease: async ({ version, entryPath }) => {
          const entry = version === TARGET ? effectiveTargetEntry : await resolveEntryFile(version, entryPath);
          const spawned = await spawnDetachedHubRelease({
            root: ROOT,
            entryPath: entry,
            config,
            env: process.env,
            launchId: version === TARGET ? LAUNCH_ID : randomUUID(),
            timeoutMs: readyTimeoutMs,
            pollMs: 250,
          });
          await writeHubPidRecord(ROOT, {
            pid: spawned.pid,
            launchId: spawned.launchId,
            version,
            entryPath: entry,
            port: config.port,
            host: config.host,
            ...(config.dataDir !== undefined ? { dataDir: config.dataDir } : {}),
            startedAt: new Date().toISOString(),
            ...(spawned.startTime !== null ? { startTime: spawned.startTime } : {}),
          });
          return spawned;
        },
      });

      await clearUpdateReady(ROOT);
      log(`switch complete: ${previous.version} -> ${TARGET} (pid ${started.pid}, ${started.listenUrl})`);
    },
    {
      waitMs: 5_000,
      onBusy: (lockPath, ownerPid) =>
        new Error(
          `concurrent lifecycle operation conflict: ${lockPath} is held${ownerPid !== undefined ? ` by pid ${ownerPid}` : ''}; aborting handoff without modifying state`,
        ),
    },
  );
  process.exit(0);
}

main().catch((error) => fail(error instanceof Error ? error.stack ?? error.message : String(error)));
