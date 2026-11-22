/**
 * Node-side read-only host environment discovery (`nodeHostEnv` RPC): reports the target node's
 * actual `platform`, `homeDir`, `tempDir`, standard platform directory env vars, and explicitly
 * requested non-secret env keys so Hub/plugins can derive target-node-local IPC endpoints
 * (Unix Domain Sockets / Windows Named Pipes) without using Hub's host environment or embedding
 * plugin-specific wire handshakes in the generic node daemon.
 */

import os from 'node:os';
import {
  validateNodeHostEnvQuery,
  type NodeHostDirs,
  type NodeHostEnv,
  type RpcResult,
} from '@helmx/protocol';
import { invalidInput } from './env-rpc-shared.js';

/** Injectable host facts for pure, cross-platform tests (Linux/macOS/Windows shapes). */
export interface NodeHostEnvContext {
  platform?: string;
  homeDir?: string;
  tempDir?: string;
  getEnv?(name: string): string | undefined;
}

const nonEmptyEnv = (getEnv: (name: string) => string | undefined, name: string): string | undefined => {
  const value = getEnv(name);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

/**
 * Collect read-only host path & non-secret environment facts on this node.
 * Caller must already have validated `envKeys` via `validateNodeHostEnvQuery`.
 */
export function collectNodeHostEnv(
  envKeys: readonly string[] = [],
  context: NodeHostEnvContext = {},
): NodeHostEnv {
  const platform = context.platform ?? process.platform;
  const homeDir = context.homeDir ?? os.homedir();
  const tempDir = context.tempDir ?? os.tmpdir();
  const getEnv = context.getEnv ?? ((name: string) => process.env[name]);

  const dirs: NodeHostDirs = {};
  const setDir = (field: keyof NodeHostDirs, envName: string): void => {
    const val = nonEmptyEnv(getEnv, envName);
    if (val !== undefined) dirs[field] = val;
  };
  setDir('xdgConfigHome', 'XDG_CONFIG_HOME');
  setDir('xdgStateHome', 'XDG_STATE_HOME');
  setDir('xdgRuntimeDir', 'XDG_RUNTIME_DIR');
  setDir('appData', 'APPDATA');
  setDir('localAppData', 'LOCALAPPDATA');
  setDir('userProfile', 'USERPROFILE');
  setDir('home', 'HOME');

  const env: Record<string, string> = {};
  for (const key of envKeys) {
    const val = nonEmptyEnv(getEnv, key);
    if (val !== undefined) env[key] = val;
  }

  return {
    platform,
    homeDir,
    tempDir,
    dirs,
    env,
  };
}

export interface HostEnvHandlerOptions {
  context?: NodeHostEnvContext;
  isDisposed(): boolean;
}

export interface HostEnvHandler {
  nodeHostEnv(raw?: unknown): Promise<RpcResult<NodeHostEnv>>;
}

/** Create the per-connection `nodeHostEnv` discovery RPC handler. */
export function createHostEnvHandler(options: HostEnvHandlerOptions): HostEnvHandler {
  const { context, isDisposed } = options;

  const nodeHostEnv = async (raw?: unknown): Promise<RpcResult<NodeHostEnv>> => {
    if (isDisposed()) return { ok: false, error: { code: 'aborted', message: 'server disposed' } };
    const validated = validateNodeHostEnvQuery(raw);
    if (!validated.ok) return invalidInput(validated.message);
    return { ok: true, value: collectNodeHostEnv(validated.envKeys, context) };
  };

  return { nodeHostEnv };
}
