import { posix, win32 } from 'node:path'
import type { Duplex } from 'node:stream'
import { HelmxError, isValidNodeId, type NodeHostEnv } from '@helmx/protocol'
import {
  collectLocalNodeHostEnv,
  isPipePath,
  windowsPipeNameOf,
} from './local-node-channel.js'
import type {
  HerdrCallOptions,
  HerdrEvent,
  HerdrNodeChannel,
  HerdrSubscribeOptions,
  HerdrTarget,
  HerdrTransport,
} from './contracts.js'
import { targetNodeId } from './contracts.js'
import {
  assertSafeOutputName,
  isWindowsShapedPath,
  readLocalOutput,
  readNodeOutput,
  removeLocalOutput,
  removeNodeOutput,
} from './transport-output.js'
import { checkAborted, contextOf, HerdrTransportError } from './transport-shared.js'

// Split re-exports: handoff-file IO and shared error primitives live in sibling submodules;
// consumers importing these symbols from transport.js remain unaffected.
export { isValidNodeId } from '@helmx/protocol'
export { MAX_OUTPUT_BYTES, isAbsoluteAnyPath, isWindowsShapedPath, pathContains } from './transport-output.js'
export { HerdrTransportError } from './transport-shared.js'

/**
 * Unified Duplex NDJSON transport for the official Herdr line-protocol IPC (local & remote).
 *
 * Wire contract (herdr 0.9.5 / protocol 22, verified via `herdr api schema --json` and server source):
 * - one request per connection: write `{"id","method","params"}\n`, read `{"id","result"}` or
 *   `{"id","error":{"code","message"}}\n`, then close the stream;
 * - `events.subscribe`: first replies with `{"id","result":{"type":"subscription_started"}}` ack
 *   (validated exclusively here in `builtin:herdr`, never inside the generic `@helmx/node` daemon),
 *   followed by bare event frames `{"event","data"}` with no `id`.
 *
 * Cross-node endpoint discipline (zero Hub-local guessing):
 * - Explicit `target.socketPath`: classified purely by path shape (POSIX UDS `/...`, Windows marker
 *   `C:\...\herdr.sock` -> verified on target node + converted to `\\.\pipe\...`, or explicit pipe
 *   `\\.\pipe\...`);
 * - Omitted `target.socketPath`: target node's actual `NodeHostEnv` (platform, homeDir, tempDir,
 *   standard dirs, `HERDR_SOCKET_PATH`) is queried via `HerdrNodeChannel.getNodeHostEnv` (or local
 *   host facts when `nodeId === 'local'`), then resolved with `resolveHerdrEndpointFromHostEnv`
 *   matching Herdr's `config/io.rs` precedence. Hub NEVER derives a remote Windows/Linux endpoint
 *   from Hub's local environment, and NEVER silently falls back to local on offline/unsupported nodes.
 * - Both local and remote connections yield a connected `Duplex` and share the single `callOverDuplex`
 *   and `subscribeOverDuplex` NDJSON implementations.
 */

interface HerdrTransportOptions {
  /** Redaction for diagnostics and error messages; defaults to returning as-is. */
  redact?: (text: string) => string
  /** Cross-node channel (injected by EnvFabric or a test fixture). When absent, remote targets fail explicitly; never fall back to local. */
  nodeChannel?: HerdrNodeChannel
  /** Wait deadline for events.subscribe ack; defaults to SUBSCRIBE_ACK_TIMEOUT_MS (shortened in tests). */
  subscribeAckTimeoutMs?: number
}

export const HERDR_CALL_TIMEOUT_MS = 120_000
/** The server-side startup cap for agent.start (>3000 and <=300000 ms) plus transport headroom. */
const HERDR_START_TIMEOUT_CEILING_MS = 300_000
const HERDR_START_TIMEOUT_MARGIN_MS = 15_000
/** No client deadline for agent.prompt(wait)/agent.wait without an explicit timeout; left to signal/server. */
const HERDR_WAIT_METHODS = new Set(['agent.prompt', 'agent.wait', 'pane.wait_for_output', 'events.wait'])
/** Per-frame (single JSON line) size cap; the subscription stream is limited per frame, not cumulatively over the connection lifetime. */
const MAX_FRAME_BYTES = 32 * 1024 * 1024
const SUBSCRIPTION_METHOD = 'events.subscribe'
/** Status event types: the official contract requires per-pane filtering by pane_id at subscribe time; no global subscription. */
const PANE_STATUS_EVENT_TYPE = 'pane.agent_status_changed'
/**
 * Global subscription set (subscribe by official type, payload rides in EventData): covers pane lifecycle
 * and position/focus changes. pane.moved changes the pane ID (official panes.rs:1326 emits only moved,
 * with no companion created/closed) so a snapshot must be re-fetched; agent_status_changed requires pane_id
 * (one filter subscription per pane of interest, rebuilt by the caller as snapshot paneIds change).
 */
const SUBSCRIPTION_TYPES = [
  'pane.created',
  'pane.updated',
  'pane.closed',
  'pane.exited',
  'pane.focused',
  'pane.moved',
  'tab.closed',
  'workspace.closed',
] as const
const WIRE_EVENT_TYPES = new Map<string, HerdrEvent['type']>(
  SUBSCRIPTION_TYPES.map((type) => [type.replace('.', '_'), type] as const),
)
const SUBSCRIBE_ACK_TIMEOUT_MS = 15_000
/** Single request ID used uniformly on every one-shot Duplex connection (local and remote). */
const CALL_REQUEST_ID = '1'
const HERDR_ENV_KEYS = ['HERDR_SOCKET_PATH'] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function describeTarget(target: HerdrTarget): string {
  const nodeId = targetNodeId(target)
  if (nodeId !== undefined) return `herdr@node:${nodeId}`
  if (target.session) return `herdr session ${target.session}`
  if (target.socketPath) return `herdr socket ${target.socketPath}`
  return 'herdr local default session'
}

/** Session name character allowlist matching Herdr's `validate_name`: 1..64 chars, not `.`/`..`, `[A-Za-z0-9._-]`. */
export function isValidSessionName(name: string): boolean {
  if (name.length === 0 || name.length > 64) return false
  if (name === '.' || name === '..') return false
  return /^[A-Za-z0-9._-]+$/.test(name)
}

function assertTarget(target: HerdrTarget): void {
  if (target.nodeId !== undefined && !isValidNodeId(target.nodeId)) {
    throw new HerdrTransportError('herdr_invalid_target', `invalid nodeId: ${target.nodeId}`, describeTarget(target))
  }
  if (target.session !== undefined && !isValidSessionName(target.session)) {
    throw new HerdrTransportError('herdr_invalid_target', `invalid session name: ${target.session}`, describeTarget(target))
  }
}

/** Target-node resolved Herdr IPC endpoint (connectable tunnel path + optional Windows marker file). */
export interface ResolvedHerdrEndpoint {
  /** Connectable tunnel socketPath: POSIX UDS (`/...`) or Windows Named Pipe (`\\.\pipe\...`). */
  connectPath: string
  /**
   * Windows on-disk marker file (`C:\...\herdr.sock`) that must exist on the target node before
   * opening the Named Pipe (`undefined` for POSIX UDS paths and explicit full pipe paths).
   */
  markerPath?: string
  /** Transport endpoint kind inferred from target platform or path shape. */
  kind: 'unix-socket' | 'named-pipe'
}

/**
 * Pure path-shape classification of a raw Herdr endpoint path (explicit `socketPath` or `HERDR_SOCKET_PATH`):
 * - Full pipe path (`\\.\pipe\...` or `\\HOST\pipe\...`): already connectable, no marker file check;
 * - Windows path shape (`C:\...\herdr.sock`, `C:/...`, `\\srv\share\...`): marker file on disk,
 *   real connectable endpoint is `windowsPipeNameOf(rawPath)`;
 * - Anything else (POSIX path): Unix Domain Socket directly.
 */
export function classifyHerdrEndpoint(rawPath: string): ResolvedHerdrEndpoint {
  const winNormalized = rawPath.replaceAll('/', '\\')
  if (isPipePath(winNormalized)) {
    return { connectPath: winNormalized, kind: 'named-pipe' }
  }
  if (isWindowsShapedPath(rawPath)) {
    return { connectPath: windowsPipeNameOf(rawPath), markerPath: rawPath, kind: 'named-pipe' }
  }
  return { connectPath: rawPath, kind: 'unix-socket' }
}

/**
 * Pure target-node Herdr endpoint derivation from the TARGET node's `NodeHostEnv` (matching Herdr's
 * `config/io.rs` + `session.rs` + `interprocess` 2.4.2 pathcvt rules):
 * - Precedence: `target.socketPath` > target `HERDR_SOCKET_PATH` > target config dir + session;
 * - On `win32`: `XDG_CONFIG_HOME` > `APPDATA` > `USERPROFILE\AppData\Roaming` > `HOME\.config` > `tempDir`,
 *   producing a `markerPath` (`...\herdr.sock`) and a Named Pipe `connectPath` (`\\.\pipe\...`);
 * - On POSIX (`linux`/`darwin`/etc.): `XDG_CONFIG_HOME` > `HOME/.config` > `homeDir/.config` > `tempDir`,
 *   producing a Unix socket `connectPath`.
 */
export function resolveHerdrEndpointFromHostEnv(
  target: HerdrTarget,
  hostEnv: NodeHostEnv,
): ResolvedHerdrEndpoint {
  if (target.socketPath !== undefined && target.socketPath !== '') {
    return classifyHerdrEndpoint(target.socketPath)
  }
  const envSocket = hostEnv.env['HERDR_SOCKET_PATH']
  if (envSocket !== undefined && envSocket !== '') {
    return classifyHerdrEndpoint(envSocket)
  }
  const session = target.session !== undefined && target.session !== '' ? target.session : undefined
  if (session !== undefined && !isValidSessionName(session)) {
    throw new HerdrTransportError('herdr_invalid_target', `invalid session name: ${session}`, describeTarget(target))
  }
  const relative = session === undefined
    ? ['herdr', 'herdr.sock']
    : ['herdr', 'sessions', session, 'herdr.sock']

  if (hostEnv.platform === 'win32') {
    const base =
      hostEnv.dirs.xdgConfigHome ??
      hostEnv.dirs.appData ??
      (hostEnv.dirs.userProfile !== undefined ? `${hostEnv.dirs.userProfile}\\AppData\\Roaming` : undefined) ??
      (hostEnv.dirs.home !== undefined ? `${hostEnv.dirs.home}\\.config` : undefined) ??
      hostEnv.tempDir
    const markerPath = [base, ...relative].join('\\')
    return {
      connectPath: windowsPipeNameOf(markerPath),
      markerPath,
      kind: 'named-pipe',
    }
  }

  const base =
    hostEnv.dirs.xdgConfigHome ??
    (hostEnv.dirs.home !== undefined ? posix.join(hostEnv.dirs.home, '.config') : undefined) ??
    (hostEnv.homeDir !== '' ? posix.join(hostEnv.homeDir, '.config') : hostEnv.tempDir)
  return {
    connectPath: posix.join(base, ...relative),
    kind: 'unix-socket',
  }
}

/**
 * Local Herdr IPC endpoint path resolution (local Hub host ONLY; remote nodes always resolve from
 * the target node's `NodeHostEnv` via `resolveHerdrEndpointFromHostEnv`):
 * returns the UDS path on POSIX, or the marker file / explicit pipe path on Windows.
 */
export function resolveSocketPath(target: HerdrTarget): string {
  const resolved = resolveHerdrEndpointFromHostEnv(target, collectLocalNodeHostEnv(HERDR_ENV_KEYS))
  return resolved.markerPath ?? resolved.connectPath
}

/** Long session/wait-style requests: no client deadline without an explicit timeoutMs; terminated by signal or the server's wait timeout. */
function resolveCallTimeoutMs(method: string, params: Record<string, unknown>, options: HerdrCallOptions | undefined): number | undefined {
  if (options?.timeoutMs !== undefined) return options.timeoutMs
  if (HERDR_WAIT_METHODS.has(method)) return undefined
  if (method === 'agent.start') {
    const requested = typeof params['timeout_ms'] === 'number' ? params['timeout_ms'] : 30_000
    return Math.min(Math.max(requested, 1), HERDR_START_TIMEOUT_CEILING_MS) + HERDR_START_TIMEOUT_MARGIN_MS
  }
  return HERDR_CALL_TIMEOUT_MS
}

function timeoutPromise(ms: number, target: string): { promise: Promise<never>; clear: () => void } {
  let handle: NodeJS.Timeout | undefined
  const promise = new Promise<never>((_, reject) => {
    handle = setTimeout(() => {
      reject(new HerdrTransportError('herdr_timeout', `no response within ${ms}ms`, target))
    }, ms)
    handle.unref?.()
  })
  return { promise, clear: () => handle && clearTimeout(handle) }
}

// --------------------------------------------------------------- frame decoding --

/**
 * NDJSON frame decoder: find `\n` boundaries by bytes; an incomplete UTF-8 tail stays in the byte buffer;
 * string decoding uses an incremental TextDecoder; limits are per frame (`limitBytes`), not cumulative.
 */
export class LineAssembler {
  private buffer: Buffer = Buffer.alloc(0)
  private decoder = new TextDecoder('utf-8', { fatal: true })

  /** Feed an arbitrarily split chunk; returns the lines completed this time (without `\n`). Over-limit/invalid UTF-8 throws. */
  push(chunk: Buffer, limitBytes = MAX_FRAME_BYTES): string[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    if (this.buffer.includes(0)) {
      throw new HerdrTransportError('herdr_protocol', 'socket stream contained NUL byte', 'herdr socket')
    }
    const lines: string[] = []
    let index: number
    while ((index = this.buffer.indexOf(0x0a)) >= 0) {
      let frameEnd = index
      if (frameEnd > 0 && this.buffer[frameEnd - 1] === 0x0d) frameEnd -= 1 // strip optional CR
      const frame = this.buffer.subarray(0, frameEnd)
      this.buffer = this.buffer.subarray(index + 1)
      if (frame.length > limitBytes) {
        throw new HerdrTransportError('herdr_frame_too_large', `frame exceeded ${limitBytes} bytes`, 'herdr socket')
      }
      lines.push(this.decode(frame))
    }
    if (this.buffer.length > limitBytes) {
      throw new HerdrTransportError('herdr_frame_too_large', `frame exceeded ${limitBytes} bytes`, 'herdr socket')
    }
    return lines
  }

  /** EOF: leftover bytes are treated as the last frame; incomplete UTF-8 is a protocol error. */
  flush(): string[] {
    if (this.buffer.length === 0) return []
    let rest = this.buffer
    if (rest.length > 0 && rest[rest.length - 1] === 0x0d) rest = rest.subarray(0, rest.length - 1)
    this.buffer = Buffer.alloc(0)
    return [this.decode(rest)]
  }

  private decode(frame: Buffer): string {
    try {
      return this.decoder.decode(frame, { stream: false })
    } catch (cause) {
      throw new HerdrTransportError('herdr_protocol', 'invalid UTF-8 in socket frame', 'herdr socket', { cause })
    }
  }
}

function parseJsonLine(line: string, target: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new HerdrTransportError('herdr_protocol', 'invalid JSON line', target)
  }
  if (!isObject(parsed)) {
    throw new HerdrTransportError('herdr_protocol', 'response line is not a JSON object', target)
  }
  return parsed
}

function checkWireError(envelope: Record<string, unknown>, target: string, redact: (s: string) => string): void {
  if (envelope['error'] !== undefined && envelope['error'] !== null) {
    const body = isObject(envelope['error']) ? envelope['error'] : {}
    const code = typeof body['code'] === 'string' && body['code'] ? body['code'] : 'herdr_error'
    const message = typeof body['message'] === 'string' && body['message']
      ? redact(body['message'])
      : 'herdr returned an error without a message'
    throw new HerdrTransportError(code, `${code}: ${message}`, target)
  }
}

// ------------------------------------------------ endpoint resolution & Duplex open --

/**
 * Remote channel precondition: remote nodes must explicitly have an online `HerdrNodeChannel`.
 * Missing channel or offline node fails loudly with `herdr_node_unavailable` / `herdr_node_offline`,
 * never silently falling back to the local Hub host.
 */
function requireChannel(nodeChannel: HerdrNodeChannel | undefined, nodeId: string, target: string): HerdrNodeChannel {
  if (nodeChannel === undefined) {
    throw new HerdrTransportError(
      'herdr_node_unavailable',
      `remote node '${nodeId}' requires an injected node channel (EnvFabric) and will never fall back to local`,
      target,
    )
  }
  if (!nodeChannel.isOnline(nodeId)) {
    throw new HerdrTransportError('herdr_node_offline', `node '${nodeId}' is offline`, target)
  }
  return nodeChannel
}

/** Map node-channel / tunnel HelmxErrors honestly to HerdrTransportError codes (never silently swallowed). */
function mapChannelError(error: unknown, targetLabel: string, redact: (s: string) => string): HerdrTransportError {
  if (error instanceof HerdrTransportError) return error
  if (error instanceof HelmxError) {
    const message = redact(error.message)
    switch (error.code) {
      case 'node_offline':
        return new HerdrTransportError('herdr_node_offline', message, targetLabel, { cause: error })
      case 'node_draining':
        return new HerdrTransportError('node_draining', message, targetLabel, { cause: error })
      case 'aborted':
        return new HerdrTransportError('herdr_aborted', message, targetLabel, { cause: error })
      case 'node_tunnel_timeout':
      case 'timeout':
        return new HerdrTransportError('herdr_timeout', message, targetLabel, { cause: error })
      case 'node_tunnel_connect_failed':
        return new HerdrTransportError('herdr_socket', message, targetLabel, { cause: error })
      case 'validation_error':
        return new HerdrTransportError('herdr_invalid_target', message, targetLabel, { cause: error })
      default:
        return new HerdrTransportError('herdr_node_error', `${error.code}: ${message}`, targetLabel, { cause: error })
    }
  }
  const message = redact(error instanceof Error ? error.message : String(error))
  return new HerdrTransportError('herdr_node_error', message, targetLabel, { cause: error })
}

/** Confirm the Windows marker file exists on the ACTUAL target node (local fs or remote ExecutionEnv). */
async function verifyWindowsMarker(
  markerPath: string,
  nodeId: string | undefined,
  channel: HerdrNodeChannel | undefined,
  targetLabel: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  checkAborted(signal, targetLabel)
  if (nodeId !== undefined) {
    const env = channel!.envFor(nodeId, win32.dirname(markerPath))
    const info = await env.fileInfo(markerPath, contextOf(signal, targetLabel))
    if (info.ok) return
    const code = info.error.code
    if (code === 'aborted') {
      throw new HerdrTransportError('herdr_aborted', 'operation aborted', targetLabel)
    }
    if (code === 'not_found' || code === 'not_directory' || code === 'permission_denied') {
      throw new HerdrTransportError(
        'herdr_unreachable',
        `herdr marker file does not exist (${code}): ${markerPath}; confirm Windows herdr is running on node '${nodeId}'`,
        targetLabel,
      )
    }
    throw new HerdrTransportError(
      'herdr_io',
      `cannot access remote herdr marker file ${markerPath} (${code}: ${info.error.message})`,
      targetLabel,
    )
  }

  const fs = await import('node:fs/promises')
  try {
    await fs.stat(markerPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
      throw new HerdrTransportError(
        'herdr_unreachable',
        `herdr marker file does not exist (${code ?? 'stat failed'}): ${markerPath}; confirm the local Windows herdr is running`,
        targetLabel,
        { cause: err },
      )
    }
    throw new HerdrTransportError(
      'herdr_io',
      `cannot access the herdr marker file: ${markerPath} (${code ?? String(err)})`,
      targetLabel,
      { cause: err },
    )
  }
  checkAborted(signal, targetLabel)
}

/** Local direct connect returning a connected Duplex (same post-connect invariant as `openTunnel`). */
async function openLocalDuplex(
  connectPath: string,
  targetLabel: string,
  signal: AbortSignal | undefined,
  redact: (s: string) => string,
): Promise<Duplex> {
  checkAborted(signal, targetLabel)
  const net = await import('node:net')
  return await new Promise<Duplex>((resolve, reject) => {
    const socket = net.connect(connectPath)
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      reject(new HerdrTransportError('herdr_aborted', 'operation aborted', targetLabel))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('connect', () => {
      if (settled) return
      if (signal?.aborted) { onAbort(); return }
      settled = true
      signal?.removeEventListener('abort', onAbort)
      socket.setNoDelay(true)
      resolve(socket)
    })
    socket.once('error', (err: Error) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      reject(new HerdrTransportError('herdr_socket', `socket error: ${redact(err.message)}`, targetLabel, { cause: err }))
    })
  })
}

/**
 * Resolve the target-node endpoint and open a connected Duplex stream (uniform entry for local & remote):
 * - Local: derives endpoint from Hub local host env (when `socketPath` omitted), verifies Windows marker
 *   locally if needed, and connects locally via `net.connect`;
 * - Remote: queries target node's `NodeHostEnv` (when `socketPath` omitted — NEVER Hub local env!),
 *   verifies Windows marker on the remote node if needed, and opens a raw Duplex via `openTunnel({ socketPath })`.
 */
async function openHerdrDuplex(
  target: HerdrTarget,
  nodeId: string | undefined,
  nodeChannel: HerdrNodeChannel | undefined,
  targetLabel: string,
  signal: AbortSignal | undefined,
  redact: (s: string) => string,
): Promise<Duplex> {
  checkAborted(signal, targetLabel)
  let channel: HerdrNodeChannel | undefined
  let resolved: ResolvedHerdrEndpoint

  if (nodeId !== undefined) {
    channel = requireChannel(nodeChannel, nodeId, targetLabel)
    if (target.socketPath !== undefined && target.socketPath !== '') {
      resolved = classifyHerdrEndpoint(target.socketPath)
    } else {
      let hostEnv: NodeHostEnv
      try {
        hostEnv = await channel.getNodeHostEnv(nodeId, { envKeys: HERDR_ENV_KEYS }, signal)
      } catch (error) {
        throw mapChannelError(error, targetLabel, redact)
      }
      resolved = resolveHerdrEndpointFromHostEnv(target, hostEnv)
    }
  } else {
    resolved =
      target.socketPath !== undefined && target.socketPath !== ''
        ? classifyHerdrEndpoint(target.socketPath)
        : resolveHerdrEndpointFromHostEnv(target, collectLocalNodeHostEnv(HERDR_ENV_KEYS))
  }

  if (resolved.markerPath !== undefined) {
    await verifyWindowsMarker(resolved.markerPath, nodeId, channel, targetLabel, signal)
  }

  if (nodeId !== undefined) {
    try {
      return await channel!.openTunnel(nodeId, { socketPath: resolved.connectPath }, signal)
    } catch (error) {
      throw mapChannelError(error, targetLabel, redact)
    }
  }
  return await openLocalDuplex(resolved.connectPath, targetLabel, signal, redact)
}

// -------------------------------------------------- unified Duplex NDJSON RPC --

/**
 * Unified one-shot NDJSON RPC over any connected Duplex (local UDS/Named Pipe or remote `openTunnel`):
 * writes `{"id":"1","method","params"}\n`, reads the first complete response line with `LineAssembler`,
 * validates `id` and wire error, and destroys the Duplex immediately on settle/abort/timeout.
 */
async function callOverDuplex(
  duplex: Duplex,
  targetLabel: string,
  method: string,
  params: Record<string, unknown>,
  options: HerdrCallOptions | undefined,
  redact: (s: string) => string,
): Promise<unknown> {
  const signal = options?.signal
  const assembler = new LineAssembler()
  const timeoutMs = resolveCallTimeoutMs(method, params, options)
  const timer = timeoutMs === undefined ? undefined : timeoutPromise(timeoutMs, targetLabel)

  const firstLine = new Promise<string>((resolve, reject) => {
    let settled = false
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }
    duplex.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      let lines: string[]
      try {
        lines = assembler.push(buf)
      } catch (err) {
        done(() => reject(err))
        return
      }
      if (lines.length > 0) {
        done(() => resolve(lines[0]!))
      }
    })
    duplex.once('end', () => {
      let rest: string[]
      try {
        rest = assembler.flush()
      } catch (err) {
        done(() => reject(err))
        return
      }
      if (rest.length > 0) done(() => resolve(rest[0]!))
      else done(() => reject(new HerdrTransportError('herdr_disconnected', 'socket closed before response', targetLabel)))
    })
    duplex.once('error', (err: Error) => {
      done(() => reject(new HerdrTransportError('herdr_socket', `socket error: ${redact(err.message)}`, targetLabel, { cause: err })))
    })
    duplex.once('close', () => {
      done(() => reject(new HerdrTransportError('herdr_disconnected', 'socket closed before response', targetLabel)))
    })
  })
  // Prevent unhandledRejection when timeout/abort races ahead of stream close.
  firstLine.catch(() => undefined)

  let onAbort: (() => void) | undefined
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      duplex.destroy()
      reject(new HerdrTransportError('herdr_aborted', 'call aborted', targetLabel))
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
  abortPromise.catch(() => undefined)

  const request = { id: CALL_REQUEST_ID, method, params }
  if (!signal?.aborted) {
    duplex.write(`${JSON.stringify(request)}\n`)
  }

  let line: string
  try {
    const racers: Promise<string>[] = [firstLine, abortPromise]
    if (timer !== undefined) racers.push(timer.promise)
    line = await Promise.race(racers)
  } finally {
    timer?.clear()
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
    duplex.destroy()
  }

  const envelope = parseJsonLine(line, targetLabel)
  if (!envelope) throw new HerdrTransportError('herdr_protocol', 'empty response line', targetLabel)
  if (envelope['id'] !== CALL_REQUEST_ID) {
    throw new HerdrTransportError('herdr_protocol', 'response id missing or mismatched', targetLabel)
  }
  if (envelope['result'] === undefined && envelope['error'] === undefined) {
    throw new HerdrTransportError('herdr_protocol', 'response has neither result nor error', targetLabel)
  }
  checkWireError(envelope, targetLabel, redact)
  return envelope['result']
}

// --------------------------------------------- unified Duplex NDJSON subscribe --

/**
 * Unified NDJSON event subscription over any connected Duplex (local or remote):
 * validates the `events.subscribe` -> `{"id":"sub","result":{"type":"subscription_started"}}` handshake
 * directly in `builtin:herdr`, then dispatches bare event frames via `onEvent`. Single finalizer
 * guarantees resources are destroyed once and errors reported at most once.
 */
async function subscribeOverDuplex(
  duplex: Duplex,
  targetLabel: string,
  paneIds: string[],
  onEvent: (event: HerdrEvent) => void,
  onError: (error: unknown) => void,
  redact: (s: string) => string,
  signal: AbortSignal | undefined,
  subscribeAckTimeoutMs: number,
): Promise<() => void> {
  const assembler = new LineAssembler()
  let stopped = false
  let terminated = false
  let acked = false
  let terminate: (error: unknown) => void = () => {}

  function failOnce(error: unknown): void {
    if (terminated) return
    terminated = true
    duplex.destroy()
    terminate(error)
  }

  function dispatchEventFrame(frame: Record<string, unknown>): boolean {
    try {
      const wireType = frame['event']
      if (typeof wireType !== 'string') return true
      const type = wireType === PANE_STATUS_EVENT_TYPE ? wireType : WIRE_EVENT_TYPES.get(wireType)
      if (type === undefined) return true
      const data = isObject(frame['data']) ? frame['data'] : {}
      if (type === 'tab.closed' || type === 'workspace.closed') {
        const workspaceId = data['workspace_id']
        const tabId = data['tab_id']
        if (
          typeof workspaceId !== 'string' || workspaceId === '' ||
          (type === 'tab.closed' && (typeof tabId !== 'string' || tabId === ''))
        ) {
          failOnce(new HerdrTransportError('herdr_protocol', `event ${type} missing topology identity`, targetLabel))
          return false
        }
        if (type === 'tab.closed') onEvent({ type, workspaceId, tabId: tabId as string })
        else onEvent({ type, workspaceId })
        return true
      }
      const pane = isObject(data['pane']) ? data['pane'] : undefined
      const paneId =
        typeof data['pane_id'] === 'string' && data['pane_id'] !== ''
          ? data['pane_id']
          : typeof pane?.['pane_id'] === 'string' && pane['pane_id'] !== ''
            ? (pane['pane_id'] as string)
            : undefined
      if (!paneId) {
        failOnce(new HerdrTransportError('herdr_protocol', `event ${String(type)} missing pane identity`, targetLabel))
        return false
      }
      onEvent({ type, paneId })
      return true
    } catch (err) {
      failOnce(err)
      return false
    }
  }

  const ack = new Promise<void>((resolve, reject) => {
    let settled = false
    terminate = (error) => {
      if (settled) onError(error)
      else {
        settled = true
        reject(error)
      }
    }
    const succeed = () => {
      if (settled) return
      settled = true
      acked = true
      resolve()
    }

    const handleLines = (lines: string[]) => {
      for (const line of lines) {
        let envelope: Record<string, unknown> | undefined
        try {
          envelope = parseJsonLine(line, targetLabel)
        } catch (err) {
          failOnce(err)
          return
        }
        if (!envelope) continue
        if (envelope['event'] !== undefined) {
          // Event frames arriving before or after the ACK are dispatched in order, never dropped.
          if (!dispatchEventFrame(envelope)) return
          continue
        }
        if (acked) {
          failOnce(new HerdrTransportError('herdr_protocol', 'unexpected post-ack response frame on subscription stream', targetLabel))
          return
        }
        if (envelope['id'] !== 'sub') {
          failOnce(new HerdrTransportError('herdr_protocol', 'subscription response id missing or mismatched', targetLabel))
          return
        }
        if (envelope['error'] !== undefined && envelope['error'] !== null) {
          const body = isObject(envelope['error']) ? envelope['error'] : {}
          const code = typeof body['code'] === 'string' && body['code'] ? body['code'] : 'herdr_error'
          const message =
            typeof body['message'] === 'string' && body['message'] ? redact(body['message']) : 'herdr returned an error without a message'
          failOnce(new HerdrTransportError(code, `${code}: ${message}`, targetLabel))
          return
        }
        if (envelope['result'] !== undefined) {
          const result = envelope['result']
          const type = isObject(result) ? result['type'] : undefined
          if (type === 'subscription_started') {
            succeed()
            continue
          }
          failOnce(new HerdrTransportError('herdr_protocol', 'unexpected subscription ack result', targetLabel))
          return
        }
        failOnce(new HerdrTransportError('herdr_protocol', 'subscription response has neither result nor error', targetLabel))
        return
      }
    }

    duplex.on('data', (chunk: Buffer | string) => {
      if (terminated || stopped) return
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      let lines: string[]
      try {
        lines = assembler.push(buf)
      } catch (err) {
        failOnce(err)
        return
      }
      handleLines(lines)
    })
    duplex.once('end', () => {
      if (stopped) return
      let rest: string[]
      try {
        rest = assembler.flush()
      } catch (err) {
        failOnce(err)
        return
      }
      if (rest.length > 0) handleLines(rest)
      if (!terminated && !stopped) {
        failOnce(
          new HerdrTransportError(
            'herdr_disconnected',
            acked ? 'subscription socket closed' : 'subscription socket closed before ack',
            targetLabel,
          ),
        )
      }
    })
    duplex.once('error', (err: Error) => {
      failOnce(new HerdrTransportError('herdr_socket', `socket error: ${redact(err.message)}`, targetLabel, { cause: err }))
    })
    duplex.once('close', () => {
      if (stopped) return
      failOnce(
        new HerdrTransportError(
          'herdr_disconnected',
          acked ? 'subscription socket closed' : 'subscription socket closed before ack',
          targetLabel,
        ),
      )
    })
  })

  const subscriptions: Array<Record<string, unknown>> = SUBSCRIPTION_TYPES.map((type) => ({ type }))
  for (const paneId of paneIds) subscriptions.push({ type: PANE_STATUS_EVENT_TYPE, pane_id: paneId })
  const request = { id: 'sub', method: SUBSCRIPTION_METHOD, params: { subscriptions } }
  if (!signal?.aborted) {
    duplex.write(`${JSON.stringify(request)}\n`)
  }

  const onAbort = () => {
    if (terminated) return
    stopped = true
    terminated = true
    duplex.destroy()
    if (!acked) terminate(new HerdrTransportError('herdr_aborted', 'subscription aborted', targetLabel))
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()

  const ackTimer = timeoutPromise(subscribeAckTimeoutMs, targetLabel)
  try {
    await Promise.race([
      ack,
      ackTimer.promise.then(
        (never) => never as never,
        (err) => {
          failOnce(err)
          throw err
        },
      ),
    ])
  } catch (err) {
    signal?.removeEventListener('abort', onAbort)
    throw err
  } finally {
    ackTimer.clear()
  }

  return () => {
    if (stopped) return
    stopped = true
    terminated = true
    signal?.removeEventListener('abort', onAbort)
    duplex.destroy()
  }
}

// ------------------------------------------------------------- factories --

export function createHerdrTransport(factoryOptions?: HerdrTransportOptions): HerdrTransport {
  const redact = factoryOptions?.redact ?? ((text: string) => text)
  const nodeChannel = factoryOptions?.nodeChannel
  const subscribeAckTimeoutMs = factoryOptions?.subscribeAckTimeoutMs ?? SUBSCRIBE_ACK_TIMEOUT_MS

  async function call(
    target: HerdrTarget,
    method: string,
    params: Record<string, unknown>,
    callOptions?: HerdrCallOptions,
  ): Promise<unknown> {
    assertTarget(target)
    const targetLabel = describeTarget(target)
    const nodeId = targetNodeId(target)
    const timeoutMs = resolveCallTimeoutMs(method, params, callOptions)
    let timedOut = false
    let deadlineTimer: NodeJS.Timeout | undefined
    const openController = timeoutMs === undefined ? undefined : new AbortController()
    let onCallerAbort: (() => void) | undefined
    if (openController !== undefined && timeoutMs !== undefined) {
      if (callOptions?.signal !== undefined) {
        onCallerAbort = () => openController.abort()
        if (callOptions.signal.aborted) openController.abort()
        else callOptions.signal.addEventListener('abort', onCallerAbort, { once: true })
      }
      deadlineTimer = setTimeout(() => {
        timedOut = true
        openController.abort()
      }, timeoutMs)
      deadlineTimer.unref?.()
    }
    let duplex: Duplex
    try {
      duplex = await openHerdrDuplex(
        target,
        nodeId,
        nodeChannel,
        targetLabel,
        openController?.signal ?? callOptions?.signal,
        redact,
      )
    } catch (error) {
      if (timedOut && !(callOptions?.signal?.aborted)) {
        throw new HerdrTransportError('herdr_timeout', `no response within ${timeoutMs}ms`, targetLabel, { cause: error })
      }
      throw error
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      if (onCallerAbort !== undefined) callOptions?.signal?.removeEventListener('abort', onCallerAbort)
    }
    return await callOverDuplex(duplex, targetLabel, method, params, callOptions, redact)
  }

  return {
    call,
    async readOutput(target, cwd, fileName, signal) {
      assertTarget(target)
      assertSafeOutputName(fileName, describeTarget(target))
      const nodeId = targetNodeId(target)
      if (nodeId !== undefined) {
        const channel = requireChannel(nodeChannel, nodeId, describeTarget(target))
        return readNodeOutput(channel, nodeId, target, describeTarget(target), cwd, fileName, signal)
      }
      return readLocalOutput(cwd, fileName, signal, describeTarget(target), redact)
    },
    async removeOutput(target, cwd, fileName, signal) {
      assertTarget(target)
      assertSafeOutputName(fileName, describeTarget(target))
      const nodeId = targetNodeId(target)
      if (nodeId !== undefined) {
        const channel = requireChannel(nodeChannel, nodeId, describeTarget(target))
        await removeNodeOutput(channel, nodeId, describeTarget(target), cwd, fileName, signal)
        return
      }
      await removeLocalOutput(cwd, fileName, signal, describeTarget(target), redact)
    },
    async subscribe(target, onEvent, onError, options) {
      assertTarget(target)
      const targetLabel = describeTarget(target)
      const signal = options?.signal
      checkAborted(signal, targetLabel)
      const paneIds = [...new Set(options?.paneIds ?? [])]
      const invalidPaneId = paneIds.find((paneId) => typeof paneId !== 'string' || paneId === '')
      if (invalidPaneId !== undefined) {
        throw new HerdrTransportError('herdr_invalid_subscription', `invalid pane id in subscription options: ${String(invalidPaneId)}`, targetLabel)
      }
      const nodeId = targetNodeId(target)
      const duplex = await openHerdrDuplex(target, nodeId, nodeChannel, targetLabel, signal, redact)
      return await subscribeOverDuplex(
        duplex,
        targetLabel,
        paneIds,
        onEvent,
        onError,
        redact,
        signal,
        subscribeAckTimeoutMs,
      )
    },
  }
}
