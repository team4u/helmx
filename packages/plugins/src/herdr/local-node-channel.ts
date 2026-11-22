/**
 * Minimal production helper for local node connections (`nodeId === 'local'`):
 * - Windows Named Pipe conversion per herdr / interprocess 2.4.2 rules (see source-evidence notes below);
 * - Local `NodeHostEnv` collection (pure/injectable for cross-platform unit tests);
 * - Local `openTunnel` implementation opening a connected Duplex to a controlled Unix socket / Named Pipe
 *   (or TCP host:port) strictly for `nodeId === 'local'` (every remote nodeId is rejected explicitly);
 * - Local `envFor`: `NodeExecutionEnv` satisfies `HerdrNodeEnv`.
 *
 * Windows pipe name rules (verified against interprocess 2.4.2 source, not guessed):
 * - `src/os/windows/path_conversion.rs` `pathcvt` (L126-137): a namespaced name is
 *   `\\` + `.` (local host) + `\\pipe\\` + the raw name joined segment by segment, **without replacing
 *   colons/slashes** (after herdr's marker path `C:\\Users\\...\\herdr.sock` enters the pipe name, the colon
 *   stays as-is -- NPFS does not forbid `:` in names apart from NUL and path-separator semantics);
 * - `src/os/windows/local_socket/name_type.rs` `map_generic_namespaced_osstr`:
 *   a full pipe path already in `\\HOST\\pipe\\NAME` form passes through unchanged (`is_pipefs`).
 * Derived from source; not verified on a physical Windows machine (tests state this honestly).
 */

import { connect } from 'node:net'
import os from 'node:os'
import type { Duplex } from 'node:stream'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import {
  classifyControlledSocketPath,
  HelmxError,
  validateNodeHostEnvQuery,
  WINDOWS_LOCAL_PIPE_PREFIX,
  type NodeHostDirs,
  type NodeHostEnv,
  type NodeHostEnvQuery,
  type NodeTunnelTarget,
} from '@helmx/protocol'
import type { HerdrNodeChannel, HerdrNodeEnv } from './contracts.js'
import { isWindowsShapedPath } from './transport-output.js'

/**
 * Windows marker file path -> named pipe connection name.
 * Rule = `\\.\pipe\` + the raw path (only normalize forward slashes to backslashes; colons/other characters as-is).
 * A full pipe path (`\\.\pipe\...` or `\\HOST\pipe\...`) is returned unchanged.
 */
export function windowsPipeNameOf(markerPath: string): string {
  const normalized = markerPath.replaceAll('/', '\\')
  if (isPipePath(normalized)) return normalized
  return WINDOWS_LOCAL_PIPE_PREFIX + normalized
}

/** Same rule as interprocess `is_pipefs`: `\\HOST\\pipe\\...` (non-empty host segment) is a full pipe path. */
export function isPipePath(path: string): boolean {
  if (!path.startsWith('\\\\')) return false
  const hostEnd = path.indexOf('\\', 2)
  if (hostEnd <= 2) return false
  return path.startsWith('\\pipe\\', hostEnd)
}

/**
 * Endpoint form detection: a full pipe path or a Windows path shape (drive letter/UNC) means named pipe;
 * anything else (POSIX paths, incl. explicit relative/absolute UDS paths) is a Unix socket. Pure path-shape detection
 * independent of the Hub process platform (a Windows endpoint explicitly configured on a Linux Hub still connects as a pipe).
 */
export function endpointKindOf(endpoint: string): 'unix-socket' | 'named-pipe' {
  return isWindowsShapedPath(endpoint) || isPipePath(endpoint.replaceAll('/', '\\')) ? 'named-pipe' : 'unix-socket'
}

/** Establish a socket connection to the local Herdr IPC endpoint (Unix UDS / Windows Named Pipe). */
export function connectHerdrEndpoint(endpoint: string, kind: 'unix-socket' | 'named-pipe') {
  if (kind === 'named-pipe') {
    return connect(windowsPipeNameOf(endpoint))
  }
  return connect(endpoint)
}

/** Injectable overrides for pure/cross-platform local `NodeHostEnv` collection. */
export interface LocalHostEnvOverrides {
  platform?: string
  homeDir?: string
  tempDir?: string
  getEnv?: (name: string) => string | undefined
}

/** Collect `NodeHostEnv` facts from the local host (or injected test overrides). */
export function collectLocalNodeHostEnv(
  envKeys: readonly string[] = [],
  overrides: LocalHostEnvOverrides = {},
): NodeHostEnv {
  const getEnv = overrides.getEnv ?? ((name: string) => process.env[name])
  const readNonEmpty = (name: string): string | undefined => {
    const val = getEnv(name)
    return typeof val === 'string' && val.length > 0 ? val : undefined
  }
  const dirs: NodeHostDirs = {}
  const setDir = (field: keyof NodeHostDirs, envName: string): void => {
    const val = readNonEmpty(envName)
    if (val !== undefined) dirs[field] = val
  }
  setDir('xdgConfigHome', 'XDG_CONFIG_HOME')
  setDir('xdgStateHome', 'XDG_STATE_HOME')
  setDir('xdgRuntimeDir', 'XDG_RUNTIME_DIR')
  setDir('appData', 'APPDATA')
  setDir('localAppData', 'LOCALAPPDATA')
  setDir('userProfile', 'USERPROFILE')
  setDir('home', 'HOME')

  const env: Record<string, string> = {}
  for (const key of envKeys) {
    const val = readNonEmpty(key)
    if (val !== undefined) env[key] = val
  }
  return {
    platform: overrides.platform ?? process.platform,
    homeDir: overrides.homeDir ?? os.homedir(),
    tempDir: overrides.tempDir ?? os.tmpdir(),
    dirs,
    env,
  }
}

/**
 * Local node channel (`nodeId === 'local'`; every other node is rejected explicitly — when EnvFabric is not injected,
 * transport explicitly reports `herdr_node_unavailable` / `herdr_node_offline` for remote targets; never falls back to local).
 */
export class LocalNodeChannel implements HerdrNodeChannel {
  private readonly envCache = new Map<string, HerdrNodeEnv>()

  constructor(private readonly hostEnvOverrides: LocalHostEnvOverrides = {}) {}

  isOnline(nodeId: string): boolean {
    return nodeId === 'local'
  }

  getNodeHubUrl(): string | undefined {
    return undefined
  }

  /** The local node is the Hub host itself: the platform is process.platform (for cwd normalization). */
  nodePlatform(nodeId: string): string | undefined {
    return nodeId === 'local' ? (this.hostEnvOverrides.platform ?? process.platform) : undefined
  }

  async getNodeHostEnv(nodeId: string, query?: NodeHostEnvQuery, signal?: AbortSignal): Promise<NodeHostEnv> {
    if (nodeId !== 'local') {
      throw new HelmxError(
        'node_offline',
        `LocalNodeChannel only carries the 'local' node (got '${nodeId}')`,
        409,
        { nodeId },
      )
    }
    const checked = validateNodeHostEnvQuery(query)
    if (!checked.ok) {
      throw new HelmxError('validation_error', checked.message, 400, { nodeId })
    }
    if (signal?.aborted) {
      throw new HelmxError('aborted', 'node host env query cancelled', 499, { nodeId })
    }
    return collectLocalNodeHostEnv(checked.envKeys, this.hostEnvOverrides)
  }

  async openTunnel(nodeId: string, target: NodeTunnelTarget, signal?: AbortSignal): Promise<Duplex> {
    if (nodeId !== 'local') {
      throw new HelmxError(
        'node_offline',
        `LocalNodeChannel only carries the 'local' node (got '${nodeId}')`,
        409,
        { nodeId },
      )
    }
    if (signal?.aborted) {
      throw new HelmxError('aborted', 'tunnel establishment cancelled', 499, { nodeId })
    }
    const raw = target as unknown as Record<string, unknown>
    const hasSocketPath = raw['socketPath'] !== undefined
    const hasTcpField = raw['port'] !== undefined || raw['host'] !== undefined
    if (hasSocketPath && hasTcpField) {
      throw new HelmxError('validation_error', 'tunnel target cannot mix socketPath with host/port', 400, { nodeId })
    }
    let dial: () => ReturnType<typeof connect>
    let label: string
    if (hasSocketPath) {
      const checked = classifyControlledSocketPath(raw['socketPath'])
      if (!checked.ok) {
        throw new HelmxError('validation_error', checked.message, 400, { nodeId, socketPath: raw['socketPath'] })
      }
      label = checked.socketPath
      dial = () => connect({ path: checked.socketPath })
    } else {
      const port = raw['port']
      const host = typeof raw['host'] === 'string' && raw['host'].length > 0 ? raw['host'] : '127.0.0.1'
      if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new HelmxError('validation_error', 'tunnel target port must be an integer between 1 and 65535', 400, { nodeId, port })
      }
      label = `${host}:${port}`
      dial = () => connect({ host, port })
    }
    return await new Promise<Duplex>((resolve, reject) => {
      const socket = dial()
      let settled = false
      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        if (settled) return
        settled = true
        cleanup()
        socket.destroy()
        reject(new HelmxError('aborted', 'tunnel establishment cancelled', 499, { nodeId }))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      socket.once('connect', () => {
        if (settled) return
        if (signal?.aborted) { onAbort(); return }
        settled = true
        cleanup()
        resolve(socket)
      })
      socket.once('error', (err: Error) => {
        if (settled) return
        settled = true
        cleanup()
        socket.destroy()
        reject(new HelmxError('node_tunnel_connect_failed', `connect ${label} failed: ${err.message}`, 502, { nodeId }))
      })
    })
  }

  envFor(nodeId: string, cwd: string): HerdrNodeEnv {
    if (nodeId !== 'local') {
      throw new Error(`LocalNodeChannel only carries the file environment of the 'local' node (got '${nodeId}')`)
    }
    const cached = this.envCache.get(cwd)
    if (cached !== undefined) return cached
    const env: HerdrNodeEnv = new NodeExecutionEnv({ cwd })
    this.envCache.set(cwd, env)
    return env
  }
}
