/**
 * Daemon upgrade RPC input validation and state machine:
 * - Boundary validation for `nodeCheckUpgrade`, `nodeUpgrade`, and `confirmUpgrade`.
 * - Serializes upgrade execution, draining transitions, reconnect suspension, and candidate activation.
 */

import process from 'node:process';
import type {
  NodeInstallMode,
  NodeUpgradeCheckInput,
  NodeUpgradeCheckResult,
  NodeUpgradeCommit,
  NodeUpgradeResult,
  NodeUpgradeRpcInput,
  RpcEnvError,
  RpcResult,
} from '@helmx/protocol';
import { SOURCE_MODE_UPGRADE_MESSAGE } from '../service-entry.js';
import {
  UpgradeCommitUnconfirmedError,
  UpgradeRejectedError,
  checkNodeUpgrade,
  filterRpcRegistryUrl,
  getNodeVersion,
  performNodeUpgrade,
  type PerformNodeUpgradeOptions,
} from './upgrader.js';

function invalidError(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid' });
}

function assertKnownObjectFields(
  input: unknown,
  label: string,
  knownFields: readonly string[],
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalidError(`${label} must be an object`);
  }
  const record = input as Record<string, unknown>;
  const known = new Set(knownFields);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) throw invalidError(`unknown field: ${key}`);
  }
  return record;
}

function parseUpgradeAttemptId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > 128) {
    throw invalidError(`invalid upgradeAttemptId: ${JSON.stringify(value)}`);
  }
  return value;
}

export function assertUpgradeCheckInput(input: unknown): NodeUpgradeCheckInput | undefined {
  if (input === undefined || input === null) return undefined;
  const record = assertKnownObjectFields(input, 'input', ['registryUrl']);
  if (record['registryUrl'] !== undefined && typeof record['registryUrl'] !== 'string') {
    throw invalidError('registryUrl must be a string');
  }
  return record as NodeUpgradeCheckInput;
}

export function assertUpgradeRpcInput(input: unknown): NodeUpgradeRpcInput | undefined {
  if (input === undefined || input === null) return undefined;
  const record = assertKnownObjectFields(input, 'input', ['targetVersion', 'registryUrl', 'force', 'attemptId']);
  if (record['targetVersion'] !== undefined && typeof record['targetVersion'] !== 'string') {
    throw invalidError('targetVersion must be a string');
  }
  if (record['registryUrl'] !== undefined && typeof record['registryUrl'] !== 'string') {
    throw invalidError('registryUrl must be a string');
  }
  if (record['force'] !== undefined && typeof record['force'] !== 'boolean') {
    throw invalidError('force must be a boolean');
  }
  if (record['attemptId'] !== undefined) parseUpgradeAttemptId(record['attemptId']);
  return record as NodeUpgradeRpcInput;
}

export function assertUpgradeCommit(input: unknown): NodeUpgradeCommit {
  const record = assertKnownObjectFields(input, 'commit', ['attemptId', 'version', 'previousVersion', 'pid']);
  const attemptId = parseUpgradeAttemptId(record['attemptId']);
  if (attemptId === undefined) throw invalidError('attemptId is missing or invalid');
  for (const key of ['version', 'previousVersion'] as const) {
    const value = record[key];
    if (typeof value !== 'string' || value === '' || value.length > 128) {
      throw invalidError(`${key} must be a non-empty string`);
    }
  }
  if (typeof record['pid'] !== 'number' || !Number.isSafeInteger(record['pid']) || record['pid'] <= 0) {
    throw invalidError('pid must be a positive integer');
  }
  return {
    attemptId,
    version: record['version'] as string,
    previousVersion: record['previousVersion'] as string,
    pid: record['pid'],
  };
}

function rpcErrorOf(error: unknown): RpcEnvError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UpgradeRejectedError) return { code: 'invalid', message };
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === 'invalid' || code === 'not_supported' || code === 'source_mode' || code === 'aborted') {
    return { code, message };
  }
  return { code: 'unknown', message };
}

function isCommitUnconfirmed(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof UpgradeCommitUnconfirmedError) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function resolveUpgradeRegistry(registryUrl: string | undefined, trustedRegistry: boolean): string | undefined {
  return trustedRegistry === true
    ? (registryUrl === undefined || registryUrl === '' ? undefined : registryUrl)
    : filterRpcRegistryUrl(registryUrl);
}

async function unwrapRpc<T>(result: Promise<RpcResult<T>>): Promise<T> {
  const settled = await result;
  if (!settled.ok) {
    throw Object.assign(new Error(settled.error.message), { code: settled.error.code });
  }
  return settled.value;
}

export interface DaemonUpgradeControllerDeps {
  dataDir: string;
  installMode: NodeInstallMode;
  prepareUpgradeReplacement?: PerformNodeUpgradeOptions['prepareReplacement'];
  onUpgradeReplaced?: (pid: number) => void;
  upgradeAttemptId?: string;
  pendingActivation?: boolean;
  isClosed(): boolean;
  getActiveWorkloadCount(): number;
  applyDraining(draining: boolean): void;
  onResumeReconnect(): void;
  onCommitConfirmed(): void;
}

export interface DaemonUpgradeController {
  checkUpgradeRpc(input: NodeUpgradeCheckInput | undefined, trustedRegistry: boolean): Promise<RpcResult<NodeUpgradeCheckResult>>;
  upgradeRpc(input: NodeUpgradeRpcInput | undefined, trustedRegistry: boolean): Promise<RpcResult<NodeUpgradeResult>>;
  checkUpgrade(input?: NodeUpgradeCheckInput, trustedRegistry?: boolean): Promise<NodeUpgradeCheckResult>;
  upgrade(input?: NodeUpgradeRpcInput, trustedRegistry?: boolean): Promise<NodeUpgradeResult>;
  confirmUpgrade(commit: NodeUpgradeCommit): Promise<void>;
  isUpgrading(): boolean;
  isReconnectSuspended(): boolean;
  getUpgradeCommit(): NodeUpgradeCommit | undefined;
}

export function createDaemonUpgradeController(deps: DaemonUpgradeControllerDeps): DaemonUpgradeController {
  let upgradeInFlight: Promise<RpcResult<NodeUpgradeResult>> | undefined;
  let upgradeActive = false;
  let upgradeCommit: NodeUpgradeCommit | undefined;
  let suspendReconnect = false;

  const checkUpgradeRpc = async (
    input: NodeUpgradeCheckInput | undefined,
    trustedRegistry: boolean,
  ): Promise<RpcResult<NodeUpgradeCheckResult>> => {
    try {
      const parsed = assertUpgradeCheckInput(input);
      const registryUrl = resolveUpgradeRegistry(parsed?.registryUrl, trustedRegistry);
      const value = await checkNodeUpgrade(deps.dataDir, {
        ...(registryUrl !== undefined ? { registryUrl } : {}),
        currentVersion: getNodeVersion(),
      });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: rpcErrorOf(error) };
    }
  };

  const upgradeRpc = (
    input: NodeUpgradeRpcInput | undefined,
    trustedRegistry: boolean,
  ): Promise<RpcResult<NodeUpgradeResult>> => {
    if (deps.isClosed()) {
      return Promise.resolve({ ok: false, error: { code: 'invalid', message: 'daemon is closed; rejecting upgrade request' } });
    }
    if (deps.installMode === 'source') {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'source_mode',
          message: SOURCE_MODE_UPGRADE_MESSAGE,
        },
      });
    }
    if (upgradeActive || upgradeInFlight !== undefined) {
      return Promise.resolve({
        ok: false,
        error: { code: 'invalid', message: 'upgrade is already in progress or committed awaiting exit; rejecting concurrent request' },
      });
    }
    if (deps.prepareUpgradeReplacement === undefined) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'not_supported',
          message: 'daemon has no upgrade replacement host configured (prepareUpgradeReplacement missing); rejecting upgrade',
        },
      });
    }
    const prepareReplacement = deps.prepareUpgradeReplacement;
    const run = (async (): Promise<RpcResult<NodeUpgradeResult>> => {
      await Promise.resolve();
      upgradeActive = true;
      suspendReconnect = true;
      try {
        const parsed = assertUpgradeRpcInput(input);
        const registryUrl = resolveUpgradeRegistry(parsed?.registryUrl, trustedRegistry);
        const value = await performNodeUpgrade(deps.dataDir, {
          ...(parsed?.targetVersion !== undefined ? { targetVersion: parsed.targetVersion } : {}),
          ...(registryUrl !== undefined ? { registryUrl } : {}),
          ...(parsed?.force === true ? { force: true } : {}),
          ...(parsed?.attemptId !== undefined ? { attemptId: parsed.attemptId } : {}),
          currentVersion: getNodeVersion(),
          prepareReplacement,
          getActiveExecCount: deps.getActiveWorkloadCount,
          setDraining: deps.applyDraining,
          onScheduleShutdown: deps.onUpgradeReplaced,
        });
        if (value.upgraded) return { ok: true, value };
        upgradeActive = false;
        suspendReconnect = false;
        deps.applyDraining(false);
        deps.onResumeReconnect();
        return { ok: true, value };
      } catch (error) {
        if (!isCommitUnconfirmed(error)) {
          upgradeActive = false;
          suspendReconnect = false;
          deps.applyDraining(false);
          deps.onResumeReconnect();
        }
        return { ok: false, error: rpcErrorOf(error) };
      } finally {
        upgradeInFlight = undefined;
      }
    })();
    upgradeInFlight = run;
    return run;
  };

  return {
    checkUpgradeRpc,
    upgradeRpc,
    checkUpgrade: (input?, trustedRegistry?) => unwrapRpc(checkUpgradeRpc(input, trustedRegistry === true)),
    upgrade: (input?, trustedRegistry?) => unwrapRpc(upgradeRpc(input, trustedRegistry === true)),
    confirmUpgrade: async (commit: NodeUpgradeCommit): Promise<void> => {
      const validated = assertUpgradeCommit(commit);
      if (deps.pendingActivation === true) {
        const expectedAttempt = deps.upgradeAttemptId;
        if (
          (expectedAttempt !== undefined && validated.attemptId !== expectedAttempt) ||
          validated.version !== getNodeVersion() ||
          validated.pid !== process.pid
        ) {
          throw invalidError(
            `confirmUpgrade does not match this candidate daemon, rejecting activation (attemptId=${validated.attemptId}, version=${validated.version}, pid=${validated.pid}; expected attemptId=${expectedAttempt ?? '(unspecified)'}, version=${getNodeVersion()}, pid=${process.pid})`,
          );
        }
      }
      upgradeCommit = validated;
      deps.applyDraining(false);
      deps.onCommitConfirmed();
    },
    isUpgrading: () => upgradeActive,
    isReconnectSuspended: () => suspendReconnect,
    getUpgradeCommit: () => upgradeCommit,
  };
}
