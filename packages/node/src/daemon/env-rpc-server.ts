/**
 * Node-side remote execution RPC server implementing `NodeEnvRpcFunctions`.
 *
 * File and shell operations are handled by `LocalExecutionEnv` (our thin adapter over
 * `@earendil-works/pi-durable/env/node`'s `NodeExecutionEnv`, see `./local-env.ts`), scoped
 * per `cwd`, with `readerId` handles (`./env-rpc-readers.ts`), per-exec `AbortController`s
 * (`./env-rpc-exec.ts`), file/path-usage RPCs (`./env-rpc-files.ts`), and TCP passthrough
 * tunneling (`./env-rpc-tunnel.ts`) guarded by centralized admission/draining policies.
 *
 * Error semantics: requests rejected due to upgrade draining return `node_draining`, while
 * user/host cancellation, generation retirement, and disposal return `aborted`.
 */

import type { Duplex } from 'node:stream';
import type {
  EnvExecOutputEvent,
  NodeEnvRpcFunctions,
  NodeTunnelOpenInput,
  RpcResult,
} from '@helmx/protocol';
import { createExecManager } from './env-rpc-exec.js';
import { createFileRpcMethods } from './env-rpc-files.js';
import { createReaderRegistry } from './env-rpc-readers.js';
import { drainingRejection, invalidInput, rpcFail } from './env-rpc-shared.js';
import { createTunnelHandler } from './env-rpc-tunnel.js';
import { LocalExecutionEnv } from './local-env.js';

export interface NodeEnvRpcServerOptions {
  /** Base directory for relative paths (daemon data directory). */
  defaultCwd: string;
  /** Callback forwarding shell stdout/stderr chunks back to the Hub (`onEnvExecOutput`). */
  onExecOutput?: (event: EnvExecOutputEvent) => void;
  /** Daemon-injected base env vars for shell commands (e.g. `HELMX_HUB_URL`). */
  shellEnv?: Record<string, string | undefined>;
  /** Maximum characters per streamed output chunk (>= 1; defaults to 256 KiB chars). */
  maxOutputChunkChars?: number;
  /** Test/managed-host overrides for `envPathUsage` scanning. */
  pathUsage?: {
    procRoot?: string;
    platform?: () => string;
  };
  /**
   * Hard grace window (ms, default 500) for stdio to drain after abort/timeout so detached
   * descendants holding stdout/stderr open cannot hang `envExec` or `dispose()` indefinitely.
   */
  abortDrainGraceMs?: number;
  /** Daemon-injected duplex stream opener for `/ws/node-tunnel` (keeps credentials out of this layer). */
  openTunnelStream?: (tunnelId: string, signal?: AbortSignal) => Promise<Duplex>;
  /** Maximum cached `LocalExecutionEnv` instances per connection (LRU, defaults to 64). */
  maxCachedEnvs?: number;
  /** Maximum concurrently open reader handles per connection (defaults to 256). */
  maxOpenReaders?: number;
  /** Idle TTL (ms) before an unused reader handle is closed automatically (defaults to 5 minutes). */
  readerIdleTtlMs?: number;
}

const DEFAULT_MAX_CACHED_ENVS = 64;
const DEFAULT_MAX_OPEN_READERS = 256;
const DEFAULT_READER_IDLE_TTL_MS = 5 * 60 * 1000;

/** `NodeEnvRpcFunctions` extended with lifecycle control (`dispose`, `setDraining`) and introspection. */
export interface NodeEnvRpcServer extends NodeEnvRpcFunctions {
  nodeTunnelOpen(input: NodeTunnelOpenInput): Promise<RpcResult<null>>;
  nodeTunnelAbort(tunnelId: string): Promise<void>;
  /** Close all open readers, abort active commands, and tear down tunnel sockets. Idempotent. */
  dispose(): Promise<void>;
  /** Enable/disable drain mode (rejects new exec/tunnel calls with `node_draining`; existing work continues). */
  setDraining(value: boolean): void;
  getActiveExecCount(): number;
  getOpenReaderCount(): number;
  getActiveTunnelCount(): number;
}

export function createNodeEnvRpcServer(options: NodeEnvRpcServerOptions): NodeEnvRpcServer {
  const { defaultCwd, onExecOutput, shellEnv } = options;
  const rawChunkLimit = options.maxOutputChunkChars;
  const maxOutputChunkChars = typeof rawChunkLimit === 'number' && Number.isFinite(rawChunkLimit) && rawChunkLimit >= 1
    ? Math.floor(rawChunkLimit)
    : 256 * 1024;
  const abortDrainGraceMs = typeof options.abortDrainGraceMs === 'number' &&
    Number.isFinite(options.abortDrainGraceMs) && options.abortDrainGraceMs >= 0
    ? options.abortDrainGraceMs
    : 500;
  const maxCachedEnvs = typeof options.maxCachedEnvs === 'number' &&
    Number.isFinite(options.maxCachedEnvs) && options.maxCachedEnvs >= 1
    ? Math.floor(options.maxCachedEnvs)
    : DEFAULT_MAX_CACHED_ENVS;
  const maxOpenReaders = typeof options.maxOpenReaders === 'number' &&
    Number.isFinite(options.maxOpenReaders) && options.maxOpenReaders >= 1
    ? Math.floor(options.maxOpenReaders)
    : DEFAULT_MAX_OPEN_READERS;
  const readerIdleTtlMs = typeof options.readerIdleTtlMs === 'number' &&
    Number.isFinite(options.readerIdleTtlMs) && options.readerIdleTtlMs > 0
    ? options.readerIdleTtlMs
    : DEFAULT_READER_IDLE_TTL_MS;

  const envs = new Map<string, LocalExecutionEnv>();
  const activeEnvLeases = new Map<LocalExecutionEnv, number>();
  let disposed = false;
  let draining = false;

  const isEnvBusy = (env: LocalExecutionEnv): boolean =>
    env.hasActiveRunners() || (activeEnvLeases.get(env) ?? 0) > 0;

  const evictOneIdleEnv = (): boolean => {
    for (const [key, candidate] of envs.entries()) {
      if (isEnvBusy(candidate)) continue;
      envs.delete(key);
      return true;
    }
    return false;
  };

  const pruneIdleEnvs = (): void => {
    while (envs.size > maxCachedEnvs) {
      if (!evictOneIdleEnv()) break;
    }
  };

  const envFor = (cwd?: string): LocalExecutionEnv => {
    if (disposed) {
      throw Object.assign(new Error('server disposed'), { code: 'aborted' });
    }
    const base = cwd ?? defaultCwd;
    let env = envs.get(base);
    if (env !== undefined) {
      // Refresh LRU position on hit.
      envs.delete(base);
      envs.set(base, env);
      return env;
    }
    if (envs.size >= maxCachedEnvs) {
      evictOneIdleEnv();
    }
    env = new LocalExecutionEnv({ cwd: base, ...(shellEnv ? { shellEnv: shellEnv as NodeJS.ProcessEnv } : {}) });
    envs.set(base, env);
    return env;
  };

  const leaseEnv = (cwd?: string) => {
    const env = envFor(cwd);
    activeEnvLeases.set(env, (activeEnvLeases.get(env) ?? 0) + 1);
    return {
      env,
      release: (): void => {
        const count = activeEnvLeases.get(env) ?? 0;
        if (count <= 1) activeEnvLeases.delete(env);
        else activeEnvLeases.set(env, count - 1);
        pruneIdleEnvs();
      },
    };
  };

  const readers = createReaderRegistry({
    maxOpenReaders,
    readerIdleTtlMs,
    isDisposed: () => disposed,
  });

  const execs = createExecManager({
    leaseEnv,
    onExecOutput,
    shellEnv,
    maxOutputChunkChars,
    abortDrainGraceMs,
  });

  const tunnels = createTunnelHandler({
    openTunnelStream: options.openTunnelStream,
    isDisposed: () => disposed,
    isDraining: () => draining,
  });

  const files = createFileRpcMethods({
    envFor,
    readers,
    pathUsage: options.pathUsage,
  });

  const pendingOperations = new Set<Promise<unknown>>();

  const guardRpc = <TInput, TOutput>(
    original: (input: TInput) => Promise<RpcResult<TOutput>>,
    admit: { drainingWhat?: string; tracker?: <T>(promise: Promise<T>) => Promise<T> } = {},
  ): ((input: TInput) => Promise<RpcResult<TOutput>>) =>
    async (input: TInput): Promise<RpcResult<TOutput>> => {
      if (disposed) return { ok: false, error: { code: 'aborted', message: 'server disposed' } };
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return invalidInput('RPC input must be an object');
      }
      if (admit.drainingWhat !== undefined && draining) {
        return { ok: false, error: drainingRejection(admit.drainingWhat) };
      }
      const recheckDisposedInFlight = admit.drainingWhat === undefined;
      const operation = Promise.resolve().then(() =>
        recheckDisposedInFlight && disposed
          ? { ok: false as const, error: { code: 'aborted' as const, message: 'server disposed' } }
          : original(input),
      );
      const tracked = admit.tracker !== undefined ? admit.tracker(operation) : operation;
      pendingOperations.add(tracked);
      try {
        return await tracked;
      } catch (error) {
        return rpcFail(error);
      } finally {
        pendingOperations.delete(tracked);
      }
    };

  const rpcFunctions: NodeEnvRpcFunctions & {
    nodeTunnelOpen(input: NodeTunnelOpenInput): Promise<RpcResult<null>>;
    nodeTunnelAbort(tunnelId: string): Promise<void>;
  } = {
    envAbsolutePath: guardRpc(files.envAbsolutePath),
    envJoinPath: guardRpc(files.envJoinPath),
    envReadTextFile: guardRpc(files.envReadTextFile),
    envReadTextLines: guardRpc(files.envReadTextLines),
    envReadBinaryFile: guardRpc(files.envReadBinaryFile),
    envWriteFile: guardRpc(files.envWriteFile),
    envAppendFile: guardRpc(files.envAppendFile),
    envFlushFile: guardRpc(files.envFlushFile),
    envTruncateFile: guardRpc(files.envTruncateFile),
    envRenameFile: guardRpc(files.envRenameFile),
    envFileInfo: guardRpc(files.envFileInfo),
    envListDir: guardRpc(files.envListDir),
    envListFiles: guardRpc(files.envListFiles),
    envCanonicalPath: guardRpc(files.envCanonicalPath),
    envExists: guardRpc(files.envExists),
    envPathUsage: guardRpc(files.envPathUsage),
    envCreateDir: guardRpc(files.envCreateDir),
    envRemove: guardRpc(files.envRemove),
    envCreateTempDir: guardRpc(files.envCreateTempDir),
    envCreateTempFile: guardRpc(files.envCreateTempFile),
    envOpenTextLineReader: guardRpc(files.envOpenTextLineReader),
    envTextReaderRead: guardRpc(files.envTextReaderRead),
    envTextReaderClose: guardRpc(files.envTextReaderClose),
    envOpenBinaryReader: guardRpc(files.envOpenBinaryReader),
    envBinaryReaderInfo: guardRpc(files.envBinaryReaderInfo),
    envBinaryReaderRead: guardRpc(files.envBinaryReaderRead),
    envBinaryReaderScanLines: guardRpc(files.envBinaryReaderScanLines),
    envBinaryReaderClose: guardRpc(files.envBinaryReaderClose),
    envOpenDirReader: guardRpc(files.envOpenDirReader),
    envDirReaderNext: guardRpc(files.envDirReaderNext),
    envDirReaderClose: guardRpc(files.envDirReaderClose),
    envExec: guardRpc(execs.execOnce, { drainingWhat: 'commands', tracker: execs.trackExec }),
    envAbortExec: async (execId: string): Promise<void> => {
      execs.abortExec(execId);
    },
    /** Kill all running commands for `cwd` (or all cwds); rejected while draining or disposed. */
    envCleanup: async (cwd?: string): Promise<void> => {
      if (disposed) {
        throw Object.assign(new Error('server disposed, rejecting envCleanup'), { code: 'aborted' });
      }
      if (draining) {
        throw Object.assign(
          new Error('daemon is draining (upgrade in progress), rejecting envCleanup (would kill in-flight commands of all sessions sharing the cwd)'),
          { code: 'node_draining' },
        );
      }
      await Promise.all(
        [...envs.values()].map(async (env) => {
          if (cwd !== undefined && env.cwd !== cwd) return;
          await env.cleanup().catch(() => undefined);
        }),
      );
    },
    nodeTunnelOpen: guardRpc(
      (input: NodeTunnelOpenInput) => tunnels.nodeTunnelOpen(input),
      { drainingWhat: 'tunnels' },
    ),
    nodeTunnelAbort: tunnels.nodeTunnelAbort,
  };

  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposed = true;
    disposal = (async () => {
      readers.stopSweeper();
      execs.abortAll();
      tunnels.destroyAllTunnels();
      await Promise.allSettled([...pendingOperations, ...execs.getExecWaiters(), ...tunnels.getTunnelWaiters()]);
      const readerSettled = await readers.closeAll();
      execs.clearRunning();
      const envList = [...envs.values()];
      envs.clear();
      activeEnvLeases.clear();
      const envSettled = await Promise.allSettled(envList.map((env) => env.cleanup()));
      const failures = [...readerSettled, ...envSettled]
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => r.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'failed to dispose node env RPC server');
    })();
    return disposal;
  };

  return Object.assign(rpcFunctions, {
    dispose,
    setDraining: (value: boolean): void => {
      draining = value === true;
    },
    getActiveExecCount: () => execs.getActiveExecCount(),
    getOpenReaderCount: () => readers.getOpenReaderCount(),
    getActiveTunnelCount: () => tunnels.getActiveTunnelCount(),
  });
}
