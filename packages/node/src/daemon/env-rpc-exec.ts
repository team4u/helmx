/**
 * Remote command execution manager for `NodeEnvRpcServer`: manages per-exec `AbortController`s,
 * UTF-16 surrogate-safe output chunking, abort/timeout stdio drain grace, and managed env stripping.
 */

import { setEnvEntry } from '@helmx/env-io';
import type { EnvExecInput, EnvExecOk, EnvExecOutputEvent, RpcResult } from '@helmx/protocol';
import { invalidInput, rpcFail } from './env-rpc-shared.js';
import { isManagedHelmxEnvKey, type LocalExecutionEnv } from './local-env.js';

/**
 * Split UTF-16 output chunks on code-point boundaries so surrogate pairs are never torn across
 * JSON frames (which would introduce U+FFFD replacement characters on reassembly).
 */
const safeChunkEnd = (text: string, offset: number, limit: number): number => {
  const desired = Math.min(offset + Math.max(limit, 1), text.length);
  if (desired >= text.length) return text.length;
  const code = text.charCodeAt(desired - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    const backed = desired - 1;
    return backed > offset ? backed : desired + 1;
  }
  return desired;
};

/** Build child env while stripping daemon credentials (`HELMX_TOKEN` / `HELMX_EXECUTION_SCOPE`) unless explicitly supplied in `input.env`. */
const buildExecEnv = (
  input: { env?: Record<string, string>; inheritEnv?: boolean },
  shellEnv: Record<string, string | undefined> | undefined,
): { env: Record<string, string>; inheritEnv: false } => {
  const merged: Record<string, string> = {};
  if (input.inheritEnv !== false) {
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || isManagedHelmxEnvKey(key)) continue;
      setEnvEntry(merged, key, value);
    }
  }
  for (const [key, value] of Object.entries(shellEnv ?? {})) {
    if (value !== undefined) setEnvEntry(merged, key, value);
  }
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (value !== undefined) setEnvEntry(merged, key, value);
  }
  return { env: merged, inheritEnv: false as const };
};

export interface EnvLease {
  env: LocalExecutionEnv;
  release(): void;
}

export interface ExecManagerOptions {
  leaseEnv: (cwd?: string) => EnvLease;
  onExecOutput?: (event: EnvExecOutputEvent) => void;
  shellEnv?: Record<string, string | undefined>;
  maxOutputChunkChars: number;
  abortDrainGraceMs: number;
}

export interface ExecManager {
  execOnce(input: EnvExecInput): Promise<RpcResult<EnvExecOk>>;
  trackExec<T>(promise: Promise<T>): Promise<T>;
  abortExec(execId: string): void;
  abortAll(): void;
  clearRunning(): void;
  getExecWaiters(): Set<Promise<unknown>>;
  getActiveExecCount(): number;
}

/** Create per-connection execution controller and in-flight command tracker. */
export function createExecManager(options: ExecManagerOptions): ExecManager {
  const { leaseEnv, onExecOutput, shellEnv, maxOutputChunkChars, abortDrainGraceMs } = options;
  const running = new Map<string, { controller: AbortController }>();
  const execWaiters = new Set<Promise<unknown>>();

  const trackExec = <T>(promise: Promise<T>): Promise<T> => {
    execWaiters.add(promise);
    void promise.finally(() => execWaiters.delete(promise)).catch(() => undefined);
    return promise;
  };

  const execOnce = async (input: EnvExecInput): Promise<RpcResult<EnvExecOk>> => {
    const { execId, command, cwd, timeout, spill, window } = input;
    if (typeof execId !== 'string' || execId.length === 0 || execId.length > 128) {
      return invalidInput(`Invalid execId: ${JSON.stringify(execId)}`);
    }
    if (running.has(execId)) {
      return invalidInput(`Duplicate execId in flight: ${JSON.stringify(execId)}`);
    }
    const lease = leaseEnv(cwd);
    const controller = new AbortController();
    running.set(execId, { controller });
    const emit = (text: string, stream: 'stdout' | 'stderr', skipped?: EnvExecOutputEvent['skipped']): void => {
      if (!onExecOutput) return;
      for (let offset = 0; offset < text.length;) {
        const end = safeChunkEnd(text, offset, maxOutputChunkChars);
        onExecOutput({ execId, text: text.slice(offset, end), stream, ...(offset === 0 && skipped ? { skipped } : {}) });
        offset = end;
      }
    };
    let forced: { ok: false; error: { code: 'aborted' | 'timeout'; message: string } } | undefined;
    let execSettled = false;
    let settleForce: (() => void) | undefined;
    const drainTimers = new Set<NodeJS.Timeout>();
    const forceSettleNow = (code: 'aborted' | 'timeout', message: string): void => {
      if (execSettled) return;
      execSettled = true;
      forced = { ok: false, error: { code, message } };
      settleForce?.();
    };
    controller.signal.addEventListener('abort', () => {
      if (execSettled) return;
      const timer = setTimeout(
        () => forceSettleNow('aborted', 'Command aborted (stdio drain grace exceeded)'),
        abortDrainGraceMs,
      );
      drainTimers.add(timer);
    }, { once: true });
    if (timeout !== undefined && Number.isFinite(timeout) && timeout > 0) {
      const timer = setTimeout(() => {
        if (execSettled) return;
        controller.abort(new Error('Command timed out'));
        forceSettleNow('timeout', `Command timed out after ${timeout} seconds`);
      }, timeout * 1000 + abortDrainGraceMs);
      drainTimers.add(timer);
    }
    try {
      return await new Promise<RpcResult<EnvExecOk>>((resolve) => {
        settleForce = () => resolve(forced!);
        void lease.env.exec(command, {
          ...(cwd === undefined ? {} : { cwd }),
          ...buildExecEnv(input, shellEnv),
          ...(timeout === undefined ? {} : { timeout }),
          ...(spill === undefined ? {} : { spill }),
          ...(window === undefined ? {} : { window }),
          onOutput: (text, info) => emit(text, info.stream, info.skipped),
        }, controller.signal).then(
          (value) => { if (!execSettled) { execSettled = true; resolve(value.ok ? { ok: true, value: value.value } : rpcFail(value.error)); } },
          (error: unknown) => { if (!execSettled) { execSettled = true; resolve(rpcFail(error)); } },
        );
      });
    } finally {
      running.delete(execId);
      lease.release();
      for (const timer of drainTimers) clearTimeout(timer);
      drainTimers.clear();
    }
  };

  return {
    execOnce,
    trackExec,
    abortExec: (execId: string): void => {
      running.get(execId)?.controller.abort(new Error('aborted by hub'));
    },
    abortAll: (): void => {
      for (const exec of running.values()) exec.controller.abort(new Error('connection closed'));
    },
    clearRunning: (): void => {
      running.clear();
    },
    getExecWaiters: () => execWaiters,
    getActiveExecCount: () => execWaiters.size,
  };
}
