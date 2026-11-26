/**
 * Hub-side control channel: every real Hub process listens on a per-boot UDS / Windows named
 * pipe endpoint and answers verified `status` / `stop` requests (`@helmx/env-io` transport).
 *
 * This is what makes `helmx stop` / `restart` / browser-triggered restarts work identically on
 * Linux, macOS, and Windows: instead of guessing at PIDs, the CLI (or the update handoff
 * helper) reads `<dataDir>/hub-control.json` and speaks to the live process, which proves its
 * identity (`instanceId`) before any shutdown path runs. The record contract (schema + reader)
 * lives in `@helmx/env-io` so the CLI and the Hub never drift apart.
 *
 * Termination flow: the control channel's `runStopAndClose` in `@helmx/env-io` replies to the peer
 * and closes the control listener itself after `onStop` resolves. Therefore `main.ts` runs
 * `shutdown('control')` (which omits `control.close()`) inside `requestStop`, and calls
 * `shutdown('signal')` (which includes `control.close()`) on `SIGINT`/`SIGTERM`.
 */
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson, controlEndpoint, createControlServer, hubControlRecordPath, HUB_CONTROL_PRODUCT, type ControlServer, type HubControlRecord } from '@helmx/env-io';

export { hubControlRecordPath, readHubControlRecord, HUB_CONTROL_PRODUCT, type HubControlRecord } from '@helmx/env-io';

/** Serving state reported over the control channel (`stopping` is appended by the transport). */
export type HubControlState = 'serving';

export interface HubControlHandle {
  endpoint: string;
  instanceId: string;
  server: ControlServer;
  /** Signal-path shutdown: closes the listener and removes the record. */
  close(): Promise<void>;
}

/** The Hub's own package version (payload builds keep this in lockstep with `current.json`). */
export function hubPackageVersion(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const version: unknown = require(pkgPath)?.version;
  if (typeof version !== 'string' || version === '') {
    throw new Error(`cannot resolve @helmx/hub package version (${pkgPath})`);
  }
  return version;
}

/**
 * Start the control listener and persist the discovery record. `requestStop` performs the
 * graceful shutdown (heartbeat -> HTTP -> kernel -> updater); the control listener itself is closed
 * by `runStopAndClose` after `onStop` resolves.
 */
export async function startHubControlServer(options: {
  dataDir: string;
  version: string;
  port: number;
  requestStop: () => Promise<void>;
}): Promise<HubControlHandle> {
  const instanceId = randomBytes(16).toString('hex');
  const endpoint = controlEndpoint(options.dataDir, instanceId, HUB_CONTROL_PRODUCT);
  const recordPath = hubControlRecordPath(options.dataDir);
  const removeRecord = async (): Promise<void> => {
    const fsp = await import('node:fs/promises');
    await fsp.rm(recordPath, { force: true }).catch(() => undefined);
  };
  const server = createControlServer({
    endpoint,
    instanceId,
    onStatus: () => ({ pid: process.pid, state: 'serving' satisfies HubControlState, version: options.version }),
    onStop: async (): Promise<void> => {
      await options.requestStop();
      await removeRecord();
    },
  });
  try {
    await server.listening;
  } catch (error) {
    await removeRecord();
    throw new Error(
      `cannot listen on the Hub control endpoint ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const record: HubControlRecord = {
    instanceId,
    endpoint,
    pid: process.pid,
    version: options.version,
    port: options.port,
    startedAt: new Date().toISOString(),
  };
  await atomicWriteJson(recordPath, record, { mode: 0o600 });
  return {
    endpoint,
    instanceId,
    server,
    close: async (): Promise<void> => {
      await server.close();
      await removeRecord();
    },
  };
}
