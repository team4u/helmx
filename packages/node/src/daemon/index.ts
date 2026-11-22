/**
 * Managed node daemon facade: composes identity persistence (`identity.ts`), reverse tunnel client
 * (`tunnel-client.ts`), upgrade RPC state machine (`upgrade-rpc.ts`), and per-generation WS+birpc
 * connection lifecycle (`connection.ts`).
 */

import type {
  NodeConnectInput,
  NodeUpgradeCheckInput,
  NodeUpgradeCheckResult,
  NodeUpgradeCommit,
  NodeUpgradeResult,
  NodeUpgradeRpcInput,
} from '@helmx/protocol';
import type { NodeEnvRpcServerOptions } from './env-rpc-server.js';
import type { PerformNodeUpgradeOptions } from './upgrader.js';
import {
  assertValidHubUrl,
  assertValidIdentity,
  bindIdentityFromJoinToken,
  parseJoinToken,
  readNodeIdentity,
  resolveNodeDataDir,
  resolveRunIdentity,
  writeNodeIdentity,
  type NodeIdentity,
} from './identity.js';
import {
  collectNodeHealth,
  createDaemonConnectionManager,
  type DaemonConnectionManager,
  type HubSideFunctions,
} from './connection.js';
import { createDaemonUpgradeController } from './upgrade-rpc.js';

export {
  bindIdentityFromJoinToken,
  collectNodeHealth,
  parseJoinToken,
  readNodeIdentity,
  resolveNodeDataDir,
  writeNodeIdentity,
  type HubSideFunctions,
  type NodeIdentity,
};

export interface NodeDaemonOptions {
  hubUrl: string;
  identity: NodeIdentity;
  dataDir: string;
  /** Env RPC server options (`defaultCwd` defaults to `dataDir`). */
  envServer?: Omit<NodeEnvRpcServerOptions, 'defaultCwd' | 'onExecOutput'>;
  /** Base reconnect delay in ms (defaults to 500). */
  reconnectBaseDelayMs?: number;
  /**
   * Maximum reconnect delay in ms (defaults to 5_000). Kept low on purpose: a Hub rebuild/restart
   * typically takes tens of seconds, and with a high cap the daemon could sleep deep in a 30s
   * backoff slot exactly when the Hub comes back — delaying reconnection past the Hub's startup
   * node-join grace window and failing restart recovery. 500ms probes every <=5s are cheap.
   */
  reconnectMaxDelayMs?: number;
  /** Log sink (defaults to `console.error`). Never logs secret tokens. */
  log?: (message: string) => void;
  /**
   * Managed-host upgrade hook: launches a candidate daemon from a staged release and returns a
   * `{ pid, commit, abort }` handle. Omitting this causes `nodeUpgrade` to fail with `not_supported`.
   */
  prepareUpgradeReplacement?: PerformNodeUpgradeOptions['prepareReplacement'];
  /** Called with replacement PID after upgrade commit (or unconfirmed commit) so the old host exits. */
  onUpgradeReplaced?: (pid: number) => void;
  /** Upgrade attempt ID sent on registration for candidate reconciliation on the Hub. */
  upgradeAttemptId?: string;
  /** Candidate pending-activation mode: starts draining until `confirmUpgrade` verifies activation. */
  pendingActivation?: boolean;
}

export interface NodeDaemon {
  readonly identity: NodeIdentity;
  readonly hubUrl: string;
  /** Returns true if currently connected and registered with the Hub. */
  isConnected(): boolean;
  /** Last explicit Hub registration rejection reason (cleared on successful registration). */
  lastRejectReason(): string | undefined;
  /**
   * Resolves `true` immediately if already online, or waits for the next registration outcome
   * (`true` on success; `false` on close, disconnect, rejection, or timeout).
   */
  waitUntilRegistered(timeoutMs?: number): Promise<boolean>;
  /** Disconnect, dispose all active generation servers, clear timers, and wait for cleanup. Idempotent. */
  close(): Promise<void>;
  /** Check available upgrades (throws an Error with `.code` on failure). `trustedRegistry=true` is CLI-only. */
  checkUpgrade(input?: NodeUpgradeCheckInput, trustedRegistry?: boolean): Promise<NodeUpgradeCheckResult>;
  /** Trigger self-upgrade (drain -> stage -> replace -> commit/rollback); throws `.code='not_supported'` if unmanaged. */
  upgrade(input?: NodeUpgradeRpcInput, trustedRegistry?: boolean): Promise<NodeUpgradeResult>;
  /** Candidate local activation confirmation; records commit and pushes heartbeat asynchronously. */
  confirmUpgrade(commit: NodeUpgradeCommit): Promise<void>;
  /** True while an upgrade is in flight or committed awaiting host exit. */
  isUpgrading(): boolean;
}

export async function createNodeDaemon(options: NodeDaemonOptions): Promise<NodeDaemon> {
  const {
    hubUrl,
    identity,
    dataDir,
    envServer = {},
    reconnectBaseDelayMs = 500,
    reconnectMaxDelayMs = 5_000,
    log: writeLog = (message) => console.error(`[helmx-node] ${message}`),
  } = options;

  assertValidIdentity(identity, 'invalid node identity');
  const log = (message: string): void => writeLog(message.replaceAll(identity.token, '[REDACTED]'));
  const hub = assertValidHubUrl(hubUrl);

  let connection!: DaemonConnectionManager;
  const upgrader = createDaemonUpgradeController({
    dataDir,
    prepareUpgradeReplacement: options.prepareUpgradeReplacement,
    onUpgradeReplaced: options.onUpgradeReplaced,
    upgradeAttemptId: options.upgradeAttemptId,
    pendingActivation: options.pendingActivation,
    isClosed: () => connection.isClosed(),
    getActiveWorkloadCount: () => connection.getActiveWorkloadCount(),
    applyDraining: (draining) => connection.applyDraining(draining),
    onResumeReconnect: () => connection.connect(),
    onCommitConfirmed: () => connection.pushHeartbeatSoon(true),
  });

  connection = createDaemonConnectionManager({
    hub,
    hubUrl,
    identity,
    dataDir,
    envServer,
    reconnectBaseDelayMs,
    reconnectMaxDelayMs,
    upgradeAttemptId: options.upgradeAttemptId,
    initialDraining: options.pendingActivation === true,
    log,
    onCheckUpgrade: (input) => upgrader.checkUpgradeRpc(input, false),
    onUpgrade: (input) => upgrader.upgradeRpc(input, false),
    isReconnectSuspended: () => upgrader.isReconnectSuspended(),
    getUpgradeCommit: () => upgrader.getUpgradeCommit(),
  });

  connection.connect();

  return {
    identity,
    hubUrl,
    isConnected: () => connection.isConnected(),
    lastRejectReason: () => connection.lastRejectReason(),
    waitUntilRegistered: (timeoutMs?) => connection.waitUntilRegistered(timeoutMs),
    close: () => connection.close(),
    checkUpgrade: (input?, trustedRegistry?) => upgrader.checkUpgrade(input, trustedRegistry),
    upgrade: (input?, trustedRegistry?) => upgrader.upgrade(input, trustedRegistry),
    confirmUpgrade: (commit) => upgrader.confirmUpgrade(commit),
    isUpgrading: () => upgrader.isUpgrading(),
  };
}

/** Handle-returning entrypoint for embedding/testing without capturing process signals. */
export async function runNodeDaemonHandle(
  input: NodeConnectInput,
  options: {
    signal?: AbortSignal;
    dataDir?: string;
    prepareUpgradeReplacement?: NodeDaemonOptions['prepareUpgradeReplacement'];
    onUpgradeReplaced?: NodeDaemonOptions['onUpgradeReplaced'];
    upgradeAttemptId?: string;
    pendingActivation?: boolean;
  } = {},
): Promise<NodeDaemon> {
  const dataDir = resolveNodeDataDir(options.dataDir);
  const identity = await resolveRunIdentity(dataDir, input);
  const daemon = await createNodeDaemon({
    hubUrl: input.hubUrl,
    identity,
    dataDir,
    ...(options.prepareUpgradeReplacement !== undefined ? { prepareUpgradeReplacement: options.prepareUpgradeReplacement } : {}),
    ...(options.onUpgradeReplaced !== undefined ? { onUpgradeReplaced: options.onUpgradeReplaced } : {}),
    ...(options.upgradeAttemptId !== undefined ? { upgradeAttemptId: options.upgradeAttemptId } : {}),
    ...(options.pendingActivation !== undefined ? { pendingActivation: options.pendingActivation } : {}),
  });
  if (options.signal) {
    const signal = options.signal;
    const originalClose = daemon.close.bind(daemon);
    const stop = (): void => { void daemon.close().catch(() => console.error('[helmx-node] failed to close resources on abort signal')); };
    daemon.close = () => {
      signal.removeEventListener('abort', stop);
      return originalClose();
    };
    if (signal.aborted) await daemon.close();
    else signal.addEventListener('abort', stop, { once: true });
  }
  return daemon;
}
