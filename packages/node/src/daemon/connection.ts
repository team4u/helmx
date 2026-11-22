/**
 * Per-generation Hub WebSocket + birpc connection lifecycle, registration, heartbeat, and reconnect loop.
 *
 * - Each WS attempt owns an isolated generation (`EnvRpcServer` + `birpc`); failures retire that
 *   generation idempotently without disturbing newer generations.
 * - Heartbeat budget = `clamp(interval * 3 / 4, 1s, 30s)`, non-overlapping; 2 consecutive timeouts
 *   or an explicit `false` reply retire the generation and schedule reconnect.
 * - Reconnect uses bounded exponential backoff (default 500ms..5s) cancelled cleanly on `close()`.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import process from 'node:process';
import { WebSocket } from 'ws';
import { createBirpc, type BirpcReturn } from 'birpc';
import type {
  EnvExecOutputEvent,
  NodeEnvRpcFunctions,
  NodeHealthSnapshot,
  NodeHeartbeatInput,
  NodeRegisterInput,
  NodeRegisterResult,
  NodeUpgradeCheckInput,
  NodeUpgradeCheckResult,
  NodeUpgradeCommit,
  NodeUpgradeResult,
  NodeUpgradeRpcInput,
  RpcResult,
} from '@helmx/protocol';
import { createNodeEnvRpcServer, type NodeEnvRpcServer, type NodeEnvRpcServerOptions } from './env-rpc-server.js';
import { createSocketBirpcEvents } from './birpc-events.js';
import type { NodeIdentity } from './identity.js';
import { openNodeTunnelStream } from './tunnel-client.js';
import { getNodeVersion } from './upgrader.js';

/** Hub-side RPC functions invoked by the node daemon (`register`, `heartbeat`, event streams). */
export interface HubSideFunctions {
  register(input: NodeRegisterInput): Promise<NodeRegisterResult>;
  heartbeat(nodeId: string, input?: NodeHeartbeatInput): Promise<boolean>;
  onEnvExecOutput(event: EnvExecOutputEvent): Promise<void> | void;
}

const CONNECT_TIMEOUT_MS = 10_000;
const REGISTER_TIMEOUT_MS = 15_000;
const HEARTBEAT_BUDGET_MIN_MS = 1_000;
const HEARTBEAT_BUDGET_MAX_MS = 30_000;
const CLOSE_SETTLE_TIMEOUT_MS = 10_000;

type RegisterOutcome = { kind: 'ack'; result: NodeRegisterResult } | { kind: 'timeout' } | { kind: 'error' };
type HeartbeatOutcome = { kind: 'ack'; alive: boolean } | { kind: 'timeout' };

interface ConnectionGeneration {
  server: NodeEnvRpcServer;
  hubRpc: BirpcReturn<HubSideFunctions, NodeEnvRpcFunctions>;
  socket: WebSocket;
  heartbeatTimer: NodeJS.Timeout | undefined;
  connectTimeout?: NodeJS.Timeout;
  registered: boolean;
  disposePromise?: Promise<void>;
}

/**
 * Collect read-only host health metrics (`uptime`, `loadavg`, memory, and disk via `fs.statfs`,
 * falling back to `homedir` if `targetDir` does not exist yet and omitting disk fields if unavailable).
 */
export async function collectNodeHealth(targetDir?: string): Promise<NodeHealthSnapshot> {
  const load = os.loadavg();
  const snapshot: NodeHealthSnapshot = {
    collectedAt: Date.now(),
    uptimeSec: os.uptime(),
    loadAvg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    memFreeBytes: os.freemem(),
    memTotalBytes: os.totalmem(),
  };
  try {
    const dir = targetDir ?? os.homedir();
    let stats: { bavail: number | bigint; bsize: number | bigint; blocks: number | bigint };
    try {
      stats = await fs.statfs(dir);
    } catch {
      stats = await fs.statfs(os.homedir());
    }
    snapshot.diskFreeBytes = Number(stats.bavail) * Number(stats.bsize);
    snapshot.diskTotalBytes = Number(stats.blocks) * Number(stats.bsize);
  } catch {
    // `statfs` unavailable on this platform/path; omit disk fields rather than interrupting heartbeats.
  }
  return snapshot;
}

async function withinBudget<T>(operation: Promise<T>, timeoutMs: number, expired: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(expired), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface DaemonConnectionManagerDeps {
  hub: URL;
  hubUrl: string;
  identity: NodeIdentity;
  dataDir: string;
  envServer: Omit<NodeEnvRpcServerOptions, 'defaultCwd' | 'onExecOutput'>;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  upgradeAttemptId?: string;
  initialDraining: boolean;
  log: (message: string) => void;
  onCheckUpgrade: (input: NodeUpgradeCheckInput) => Promise<RpcResult<NodeUpgradeCheckResult>>;
  onUpgrade: (input: NodeUpgradeRpcInput) => Promise<RpcResult<NodeUpgradeResult>>;
  isReconnectSuspended: () => boolean;
  getUpgradeCommit: () => NodeUpgradeCommit | undefined;
}

export interface DaemonConnectionManager {
  connect(): void;
  isClosed(): boolean;
  isConnected(): boolean;
  lastRejectReason(): string | undefined;
  waitUntilRegistered(timeoutMs?: number): Promise<boolean>;
  applyDraining(value: boolean): void;
  getActiveWorkloadCount(): number;
  pushHeartbeatSoon(withCommit: boolean): void;
  close(): Promise<void>;
}

export function createDaemonConnectionManager(deps: DaemonConnectionManagerDeps): DaemonConnectionManager {
  const {
    hub,
    hubUrl,
    identity,
    dataDir,
    envServer,
    reconnectBaseDelayMs,
    reconnectMaxDelayMs,
    log,
  } = deps;

  const wsBase = `${hub.protocol === 'https:' ? 'wss' : 'ws'}://${hub.host}${hub.pathname.replace(/\/+$/, '')}`;
  const tunnelWsUrl = `${wsBase}/ws/node-tunnel`;
  const nodeWsUrl = `${wsBase}/ws/node?nodeId=${encodeURIComponent(identity.nodeId)}`;
  const baseShellEnv: Record<string, string | undefined> = {
    HELMX_HUB_URL: hubUrl,
    HELMX_DATA_DIR: dataDir,
    ...(envServer.shellEnv ?? {}),
  };

  let closed = false;
  let generation: ConnectionGeneration | undefined;
  let connectTimer: NodeJS.Timeout | undefined;
  let reconnectDelay = reconnectBaseDelayMs;
  const settlingDisposes = new Set<Promise<void>>();
  const cleanupErrors: unknown[] = [];
  let lastRejectReason: string | undefined;
  let drainingGlobally = deps.initialDraining;
  let closePromise: Promise<void> | undefined;
  const registerWaiters = new Set<(ok: boolean) => void>();

  const resolveRegisterWaiters = (ok: boolean): void => {
    if (registerWaiters.size === 0) return;
    const waiters = [...registerWaiters];
    registerWaiters.clear();
    for (const waiter of waiters) waiter(ok);
  };

  const scheduleReconnect = (): void => {
    if (closed || connectTimer !== undefined) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectMaxDelayMs, reconnectDelay * 2);
    connectTimer = setTimeout(() => {
      connectTimer = undefined;
      connect();
    }, delay);
  };

  /** Retire a single connection generation idempotently without disturbing newer generations. */
  const retireGeneration = (gen: ConnectionGeneration): Promise<void> => {
    if (gen.disposePromise) return gen.disposePromise;
    if (gen.heartbeatTimer !== undefined) {
      clearInterval(gen.heartbeatTimer);
      gen.heartbeatTimer = undefined;
    }
    clearTimeout(gen.connectTimeout);
    gen.registered = false;
    try {
      gen.hubRpc.$close();
    } catch {
      // Already closed.
    }
    if (gen.socket.readyState === WebSocket.OPEN || gen.socket.readyState === WebSocket.CONNECTING) {
      try {
        gen.socket.terminate();
      } catch {
        // Ignore.
      }
    }
    const dispose = gen.server
      .dispose()
      .catch((error: unknown) => {
        cleanupErrors.push(error);
        log('failed to clean up node connection resources');
      })
      .finally(() => {
        settlingDisposes.delete(dispose);
      });
    gen.disposePromise = dispose;
    settlingDisposes.add(dispose);
    if (generation === gen) {
      generation = undefined;
      resolveRegisterWaiters(false);
    }
    return dispose;
  };

  const startHeartbeatLoop = (
    gen: ConnectionGeneration,
    intervalMs: number,
    onGone: (reason: string) => void,
  ): void => {
    let commitPending = deps.getUpgradeCommit() !== undefined;
    let commitAcked = false;
    const interval = typeof intervalMs === 'number' && intervalMs > 0 ? intervalMs : 15_000;
    const budget = Math.min(Math.max(Math.floor((interval * 3) / 4), HEARTBEAT_BUDGET_MIN_MS), HEARTBEAT_BUDGET_MAX_MS);
    let inFlight = false;
    let misses = 0;

    gen.heartbeatTimer = setInterval(() => {
      if (closed || generation !== gen || inFlight) return;
      inFlight = true;
      if (deps.getUpgradeCommit() !== undefined && !commitAcked) commitPending = true;
      const outcome = withinBudget<HeartbeatOutcome>(
        (async () => {
          const beat = await collectNodeHealth(dataDir).catch(() => undefined);
          const commit = deps.getUpgradeCommit();
          const alive = await gen.hubRpc.heartbeat(identity.nodeId, {
            ...(beat !== undefined ? { health: beat } : {}),
            ...(commitPending && commit !== undefined ? { upgradeCommit: commit } : {}),
          });
          return { kind: 'ack', alive: alive === true };
        })(),
        budget,
        { kind: 'timeout' },
      )
        .catch((): HeartbeatOutcome => ({ kind: 'ack', alive: false }))
        .finally(() => {
          inFlight = false;
        });

      void outcome.then((r) => {
        if (closed || generation !== gen) return;
        if (r.kind === 'timeout') {
          misses += 1;
          if (misses >= 2) {
            log('consecutive heartbeat timeouts; reconnecting');
            onGone('heartbeat timeout');
          }
          return;
        }
        if (r.alive) {
          misses = 0;
          if (commitPending && deps.getUpgradeCommit() !== undefined) {
            commitPending = false;
            commitAcked = true;
          }
          return;
        }
        log('heartbeat rejected (registration expired); reconnecting');
        onGone('heartbeat rejected');
      });
    }, interval);
  };

  const startConnect = (): void => {
    const socket = new WebSocket(nodeWsUrl);
    const genHandle: { current?: ConnectionGeneration } = {};
    const server = createNodeEnvRpcServer({
      defaultCwd: dataDir,
      ...envServer,
      shellEnv: baseShellEnv,
      onExecOutput: (event) => pushEvent('onEnvExecOutput', event),
      openTunnelStream: (tunnelId: string, signal?: AbortSignal) =>
        openNodeTunnelStream({
          tunnelWsUrl,
          nodeId: identity.nodeId,
          token: identity.token,
          tunnelId,
          signal,
          isGenerationActive: () => {
            const gen = genHandle.current;
            return !closed && gen !== undefined && generation === gen && gen.registered === true;
          },
        }),
    });
    if (drainingGlobally) server.setDraining(true);

    const hubRpc = createBirpc<HubSideFunctions, NodeEnvRpcFunctions>(
      // Mount upgrade RPCs outside env server's `pendingOperations` guard to prevent self-deadlock on dispose.
      Object.assign(Object.create(null), server, {
        nodeCheckUpgrade: deps.onCheckUpgrade,
        nodeUpgrade: deps.onUpgrade,
      }),
      {
        post: (data) => {
          if (socket.readyState !== WebSocket.OPEN) {
            throw new Error(`[birpc] cannot send on non-OPEN WS (readyState=${socket.readyState})`);
          }
          socket.send(JSON.stringify(data));
        },
        onGeneralError: (error, functionName) => {
          log(`RPC send failed (${functionName ?? 'unknown'}): ${error instanceof Error ? error.message : String(error)}`);
          onGone('RPC transport failed');
          return true;
        },
        ...createSocketBirpcEvents(socket, (message) => {
          log(`${message}; terminating connection`);
          onGone('invalid frame');
        }),
        serialize: (data) => data,
        deserialize: (data) => data as never,
        timeout: 30 * 60 * 1000,
      },
    );

    const gen: ConnectionGeneration = {
      server,
      hubRpc,
      socket,
      heartbeatTimer: undefined,
      registered: false,
    };
    generation = gen;
    genHandle.current = gen;
    let gone = false;

    const onGone = (reason: string): void => {
      if (gone || generation !== gen) return;
      gone = true;
      clearTimeout(connectTimeout);
      retireGeneration(gen);
      log(`connection closed (${reason}), ${closed ? 'stopped' : 'reconnecting'}`);
      scheduleReconnect();
    };

    function pushEvent(method: 'onEnvExecOutput', event: EnvExecOutputEvent): void {
      if (generation !== gen) return;
      const fn = gen.hubRpc[method];
      if (!fn) {
        onGone('stream callback unavailable');
        throw new Error('Hub does not support node streaming callback');
      }
      try {
        void Promise.resolve(fn.asEvent(event as never)).catch(() => onGone('stream send failed'));
      } catch (error) {
        onGone('stream send failed');
        throw error;
      }
    }

    const connectTimeout = setTimeout(() => {
      if (generation === gen && !gone) onGone('connect timeout');
    }, CONNECT_TIMEOUT_MS);
    gen.connectTimeout = connectTimeout;

    socket.on('open', () => {
      if (closed || generation !== gen) return;
      clearTimeout(connectTimeout);
      void (async () => {
        const health = await collectNodeHealth(dataDir).catch(() => undefined);
        const ack = await withinBudget<RegisterOutcome>(
          hubRpc
            .register({
              nodeId: identity.nodeId,
              token: identity.token,
              hostname: os.hostname(),
              platform: process.platform,
              hubUrl,
              version: getNodeVersion(),
              ...(deps.upgradeAttemptId !== undefined ? { upgradeAttemptId: deps.upgradeAttemptId } : {}),
              ...(health !== undefined ? { health } : {}),
            })
            .then((result) => ({ kind: 'ack', result })),
          REGISTER_TIMEOUT_MS,
          { kind: 'timeout' },
        ).catch((): RegisterOutcome => ({ kind: 'error' }));
        if (closed || generation !== gen) return;
        if (ack.kind !== 'ack') {
          log(ack.kind === 'timeout' ? 'registration timed out' : 'registration failed (connection interrupted)');
          onGone(ack.kind === 'timeout' ? 'register timeout' : 'register failed');
          return;
        }
        const result = ack.result;
        if (result?.ok !== true || !Number.isFinite(result.heartbeatMs) || result.heartbeatMs <= 0 || result.heartbeatMs > 300_000) {
          const detail =
            result?.ok !== true
              ? (typeof result?.reason === 'string' && result.reason.trim() !== '' ? result.reason.trim() : 'rejected by Hub')
              : `invalid heartbeatMs (${String(result.heartbeatMs)})`;
          lastRejectReason = detail;
          log(`registration rejected: ${detail}`);
          resolveRegisterWaiters(false);
          onGone(`register rejected (${detail})`);
          return;
        }
        lastRejectReason = undefined;
        gen.registered = true;
        reconnectDelay = reconnectBaseDelayMs;
        resolveRegisterWaiters(true);
        startHeartbeatLoop(gen, result.heartbeatMs, onGone);
      })().catch((error: unknown) => {
        if (closed || generation !== gen) return;
        log(`registration error: ${error instanceof Error ? error.message : String(error)}`);
        onGone('register error');
      });
    });

    socket.on('close', () => onGone('closed'));
    socket.on('error', (err) => {
      log(`WS error: ${err instanceof Error ? err.message : String(err)}`);
      onGone('error');
    });
    socket.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 'unknown';
      lastRejectReason = `HTTP ${status}`;
      log(`WS rejected: HTTP ${status}`);
      if (res.statusCode === 401 || res.statusCode === 403) {
        resolveRegisterWaiters(false);
      }
      try {
        res.resume();
      } catch {
        // Ignore.
      }
      onGone(`rejected (HTTP ${status})`);
    });
  };

  const connect = (): void => {
    if (closed || deps.isReconnectSuspended() || generation !== undefined) return;
    startConnect();
  };

  return {
    connect,
    isClosed: () => closed,
    isConnected: () => generation?.registered === true && generation.socket.readyState === WebSocket.OPEN,
    lastRejectReason: () => lastRejectReason,
    waitUntilRegistered(timeoutMs = 10_000): Promise<boolean> {
      if (closed) return Promise.resolve(false);
      if (generation?.registered === true && generation.socket.readyState === WebSocket.OPEN) {
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        const waiter = (ok: boolean): void => {
          clearTimeout(timer);
          registerWaiters.delete(waiter);
          resolve(ok);
        };
        const timer = setTimeout(() => {
          registerWaiters.delete(waiter);
          resolve(false);
        }, timeoutMs);
        registerWaiters.add(waiter);
      });
    },
    applyDraining(value: boolean): void {
      drainingGlobally = value;
      generation?.server.setDraining(value);
    },
    getActiveWorkloadCount(): number {
      return (
        (generation?.server.getActiveExecCount() ?? 0) +
        (generation?.server.getActiveTunnelCount() ?? 0)
      );
    },
    pushHeartbeatSoon(withCommit: boolean): void {
      const gen = generation;
      if (gen === undefined || !gen.registered || gen.heartbeatTimer === undefined) return;
      const beat = (async () => {
        const health = await collectNodeHealth(dataDir).catch(() => undefined);
        const commit = deps.getUpgradeCommit();
        const input: NodeHeartbeatInput = {
          ...(health !== undefined ? { health } : {}),
          ...(withCommit && commit !== undefined ? { upgradeCommit: commit } : {}),
        };
        await gen.hubRpc.heartbeat(identity.nodeId, input).catch(() => false);
      })();
      void beat.catch(() => undefined);
    },
    close(): Promise<void> {
      if (closePromise === undefined) {
        closed = true;
        closePromise = (async () => {
          if (connectTimer !== undefined) {
            clearTimeout(connectTimer);
            connectTimer = undefined;
          }
          const gen = generation;
          if (gen) retireGeneration(gen);
          resolveRegisterWaiters(false);
          const drained = await withinBudget(Promise.all([...settlingDisposes]).then(() => true), CLOSE_SETTLE_TIMEOUT_MS, false);
          if (!drained) throw new Error('timed out cleaning up node connection resources; in-flight resources remain open');
          if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'failed to clean up node connection resources');
        })();
      }
      return closePromise;
    },
  };
}
