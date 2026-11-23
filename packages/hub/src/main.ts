#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHelmx } from './app.js';
import { hubActivityFilePath, startActivityHeartbeat, startHub } from '@helmx/kernel';
import { resolveWebDistOption } from './web-dist.js';
import { hubPackageVersion, startHubControlServer, type HubControlHandle } from './control.js';
import { startHubUpdater } from './updater.js';
import { createHubUpdateRoutes } from './updater-routes.js';
import { loadHubChangelog } from './changelog.js';
import { recordRunVersion } from './run-version.js';

const launchId = process.env.HELMX_HUB_ACTIVITY_LAUNCH_ID;
delete process.env.HELMX_HUB_ACTIVITY_LAUNCH_ID;

const port = Number(process.env.HELMX_PORT ?? '3202');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HELMX_PORT must be an integer between 1 and 65535');
// Listen address: loopback only by default (remote helmx-node requires explicit HELMX_HOST=0.0.0.0 or a reverse proxy).
const hostname = process.env.HELMX_HOST ?? '127.0.0.1';
// Static web hosting directory (product policy): explicit HELMX_WEB_DIST_DIR takes precedence; 'false'/'0'/'' disables it.
// By default, probe ../../web/dist relative to this hub entrypoint (see web-dist.ts); the kernel performs no default probing
// and does not guess paths from where @helmx/kernel is installed inside node_modules.
const { webDistDir } = resolveWebDistOption(process.env.HELMX_WEB_DIST_DIR, dirname(fileURLToPath(import.meta.url)));
const app = await createHelmx({
  dataDir: process.env.HELMX_DATA_DIR,
  cwd: process.env.HELMX_CWD ?? process.cwd(),
  model: process.env.HELMX_MODEL,
  // Two-phase boot: assemble + recover only. The HTTP listener (incl. `/ws/node`) opens below
  // BEFORE `kernel.start()` so remote nodes reconnect while the kernel is still pre-start; the
  // kernel's bounded node-join grace then waits for recovery-dependent registered nodes before
  // driving plugin recovery and the scheduler (restart recovery no longer races node reconnection).
  autoStart: false,
});
let hub: Awaited<ReturnType<typeof startHub>> | undefined;
let heartbeat: ReturnType<typeof startActivityHeartbeat> | undefined;
let updater: ReturnType<typeof startHubUpdater> | undefined;
try {
  // Background updater + product update routes (`/api/hub-update/*`): silent check/stage only —
  // switching is always an explicit act (`helmx update` or the Web UI apply). Inactive unless the
  // launcher marked this Hub as payload-managed via `HELMX_HUB_INSTALL_ROOT` (docker/dev hubs
  // report `active: false` and apply explains how to update them instead).
  // Installed-version changelog (shipped CHANGELOG.md, offline) + last-run version tracking:
  // the Web "what changed" notice reads `upgradedFrom` from the status route below.
  const hubVersion = hubPackageVersion();
  const changelog = await loadHubChangelog(process.env, dirname(fileURLToPath(import.meta.url)));
  const { upgradedFrom } = await recordRunVersion(app.kernel.dataDir, hubVersion);
  updater = startHubUpdater({
    root: process.env.HELMX_HUB_INSTALL_ROOT && process.env.HELMX_HUB_INSTALL_ROOT !== '' ? process.env.HELMX_HUB_INSTALL_ROOT : undefined,
    pkgName: process.env.HELMX_PAYLOAD_PACKAGE ?? '@helmx/hub',
    env: process.env,
    dataDir: app.kernel.dataDir,
  });
  hub = await startHub({
    kernel: app.kernel,
    port,
    hostname,
    ...(webDistDir !== undefined ? { webDistDir } : {}),
    productRoutes: createHubUpdateRoutes({
      updater,
      changelog: { ...changelog, version: hubVersion },
      upgrade: { upgradedFrom },
      kernel: { activitySnapshot: () => app.kernel.activitySnapshot(), dataDir: app.kernel.dataDir },
      root: updater !== null ? process.env.HELMX_HUB_INSTALL_ROOT! : null,
    }),
  });
  // Recovery + scheduler resume happen only after the socket is listening (`503 hub_starting` gate
  // covers API requests arriving in between; the readiness banner below still prints only when the
  // Hub is fully started and its control channel is listening, preserving the launcher's listen-line
  // readiness contract with zero post-start stop/apply race).
  await app.kernel.start();
  // Activity heartbeat (process-private update busy-gate signal; see activity-heartbeat.ts). Started
  // only after the server is listening so the recorded port is the real bound one; stopped first on
  // shutdown so no stale record outlives this instance.
  heartbeat = startActivityHeartbeat({
    file: hubActivityFilePath(app.kernel.dataDir),
    port,
    ...(launchId !== undefined ? { launchId } : {}),
    snapshot: () => app.kernel.activitySnapshot(),
    subscribeBusyEntered: (listener) => app.kernel.onActivityBusyEntered(listener),
    onWriteError: (error) => {
      process.stderr.write(`[hub] activity heartbeat write failed: ${error instanceof Error ? error.message : String(error)}\n`);
    },
  });
  const listeningHub = hub;
  const activeHeartbeat = heartbeat;
  let stopping = false;
  let control: HubControlHandle | undefined;
  // Graceful shutdown order: heartbeat -> HTTP listener -> kernel -> control channel. The control
  // channel's own `stop` handler runs this function and then removes its record itself, so that
  // path must never reach the `control.close()` tail (it would await its own in-flight stop chain).
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const heldControl = control;
    try {
      try {
        try {
          try {
            await activeHeartbeat.stop();
          } finally {
            await listeningHub.close();
          }
        } finally {
          await app.close();
        }
      } finally {
        try {
          await updater?.stop();
        } finally {
          await heldControl?.close();
        }
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  };
  // Control channel (cross-platform verified stop/restart; record lives under the data directory).
  // Started BEFORE printing the readiness banner so `helmx stop` / `helmx update` arriving immediately
  // after `start -d` never races `hub-control.json`. Failure to listen is fatal honesty: without it
  // `helmx stop` cannot address this Hub, so we refuse to serve as an unstoppable process.
  control = await startHubControlServer({
    dataDir: app.kernel.dataDir,
    version: hubVersion,
    port: listeningHub.url !== null ? Number(new URL(listeningHub.url).port) : port,
    requestStop: stop,
  });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdout.write(`Helmx Hub: ${hub.url}\nData directory: ${app.kernel.dataDir}\n`);
} catch (error) {
  // The listener / heartbeat / updater may already be active when a later step (kernel.start / control)
  // failed: close them cleanly before the kernel so no half-started listener or stale record outlives the process.
  if (heartbeat !== undefined) await heartbeat.stop().catch(() => undefined);
  if (hub !== undefined) await hub.close().catch(() => undefined);
  try {
    await app.close();
  } finally {
    await updater?.stop().catch(() => undefined);
  }
  throw error;
}
