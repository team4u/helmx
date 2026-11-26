/**
 * Plugin HTTP routes: `/api/plugins` (management, doctor/rescan/install, config,
 * docs including dedicated sessionDoc SSE, `client.mjs`, and dynamic `routes/` dispatch)
 * and `/api/actions` (action manifest and invocation).
 *
 * Disable double-gate: re-checks plugin enabled status via summary before dispatch (409 if disabled)
 * and tracks handler execution in `liveTasks` (shared with actions/tools for disable blocking).
 */
import { HelmxError, isPluginSummaryActive, REQUEST_SCHEMAS } from '@helmx/protocol'
import { redactJsonValue } from '../redact.js'
import type { PluginHost } from '../plugins/index.js'
import type { SecretStash } from '../services/index.js'
import type { SessionDocEventHub } from '../runtime/events.js'
import { readSanitizedPluginConfig, resolvePluginDoctorTarget } from '../runtime/guards/plugin-guards.js'
import { compressGzip, markStreamingJsonBody } from './gzip.js'
import { errorResponse, jsonOk, readJsonBody, type JsonRedactor } from './http-utils.js'
import { decodeSegment, findPluginRoute } from './route-match.js'
import { snapshotDocOf } from './session-doc-routes.js'
import { concatUint8Arrays, readBoundedChunks, stitchRemainingStream } from './stream-utils.js'
import {
  assertBodySchema,
  parseActionInvokeBody,
  parseDocNameParam,
  parsePluginConfigBody,
  requireIdParam,
  ValidationError,
} from './validate.js'
import { parseOptionalBooleanFlag, parseOptionalJsonObjectBody, type RouteContext } from './route-context.js'
import { methodNotAllowed } from './route-context.js'

export type PluginRoutesHost = Pick<
  PluginHost,
  | 'list'
  | 'enable'
  | 'disable'
  | 'listActions'
  | 'invokeAction'
  | 'getConfig'
  | 'getConfigSchema'
  | 'setConfig'
  | 'listRoutes'
  | 'getPublicDoc'
  | 'getPublicSessionDoc'
  | 'getClientModule'
> &
  Partial<
    Pick<
      PluginHost,
      | 'getConfigSources'
      | 'get'
      | 'getManifest'
      | 'withTask'
      | 'beginTask'
      | 'endTask'
      | 'doctorExternalPlugin'
      | 'reloadExternalPlugin'
      | 'rescanExternalPlugins'
      | 'installPluginPackage'
      | 'updatePluginPackage'
      | 'removePluginPackage'
    >
  >

export type PluginRoutesStash = Pick<SecretStash, 'redact'> &
  Partial<Pick<SecretStash, 'createStreamingRedactor'>>

export interface PluginRoutesTarget {
  readonly plugins: PluginRoutesHost
  readonly sessionDocEvents?: Pick<SessionDocEventHub, 'seq' | 'response'>
  readonly stash?: PluginRoutesStash
}

export async function handlePluginsDomain(
  ctx: RouteContext,
  kernel: PluginRoutesTarget,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
  const fourth = segments[3]
  const fifth = segments[4]

  if (second === undefined && method === 'GET') {
    return jsonOk(redactor, await kernel.plugins.list())
  }
  // External plugin DX loop (top-level routes without plugin ID segment; matched before requireIdParam).
  if (second === 'doctor' && method === 'POST' && third === undefined) {
    if (kernel.plugins.doctorExternalPlugin === undefined) {
      return errorResponse(redactor, 501, 'not_supported', 'Current kernel does not support plugin static doctor checks')
    }
    const body = await readJsonBody(ctx.request)
    assertBodySchema(REQUEST_SCHEMAS.pluginDoctor, body, 'plugins doctor body')
    const target = resolvePluginDoctorTarget(
      body as { path?: string; id?: string },
      { allowTarget: false },
    )
    return jsonOk(redactor, await kernel.plugins.doctorExternalPlugin(target))
  }
  if (second === 'rescan' && method === 'POST' && third === undefined) {
    if (kernel.plugins.rescanExternalPlugins === undefined) {
      return errorResponse(redactor, 501, 'not_supported', 'Current kernel does not support plugin rescan')
    }
    return jsonOk(redactor, await kernel.plugins.rescanExternalPlugins())
  }
  // Managed plugin package installation (POST /api/plugins/install, body { source, enable? }).
  if (second === 'install' && method === 'POST' && third === undefined) {
    if (kernel.plugins.installPluginPackage === undefined) {
      return errorResponse(redactor, 501, 'not_supported', 'Current kernel does not support plugin package installation')
    }
    const body = await readJsonBody(ctx.request)
    assertBodySchema(REQUEST_SCHEMAS.pluginInstall, body, 'plugins install body')
    const source = body.source as string
    return jsonOk(
      redactor,
      await kernel.plugins.installPluginPackage(
        source,
        body.enable !== undefined ? { enable: body.enable as boolean } : {},
      ),
    )
  }
  const pluginId = requireIdParam(second ?? '', 'pluginId')
  // Reserved core management segments in position 3: enable/disable/config; dynamic routes live under routes/.
  if (third === 'enable' && method === 'POST' && fourth === undefined) {
    await kernel.plugins.enable(pluginId)
    return jsonOk(redactor, await kernel.plugins.list())
  }
  if (third === 'disable' && method === 'POST' && fourth === undefined) {
    const opts = await parseOptionalJsonObjectBody(ctx.request, parsePluginDisableBody)
    const queryForce = parseOptionalBooleanFlag(ctx.url, 'force')
    const force = opts.force === true || queryForce === true
    await kernel.plugins.disable(pluginId, force ? { force: true } : undefined)
    return jsonOk(redactor, await kernel.plugins.list())
  }
  // External plugin controlled hot reload (POST /api/plugins/:id/reload): leaves current instance untouched on preflight failure.
  if (third === 'reload' && method === 'POST' && fourth === undefined) {
    if (kernel.plugins.reloadExternalPlugin === undefined) {
      return errorResponse(redactor, 501, 'not_supported', 'Current kernel does not support plugin hot reload')
    }
    return jsonOk(redactor, await kernel.plugins.reloadExternalPlugin(pluginId))
  }
  // Managed plugin package update (POST /api/plugins/:id/update; optional body { source? }).
  if (third === 'update' && method === 'POST' && fourth === undefined) {
    if (kernel.plugins.updatePluginPackage === undefined) {
      return errorResponse(redactor, 501, 'not_supported', 'Current kernel does not support plugin package updates')
    }
    const opts = await parseOptionalJsonObjectBody(ctx.request, parsePluginUpdateBody)
    return jsonOk(redactor, await kernel.plugins.updatePluginPackage(pluginId, opts))
  }
  // Managed plugin package removal (POST /api/plugins/:id/remove).
  if (third === 'remove' && method === 'POST' && fourth === undefined) {
    if (kernel.plugins.removePluginPackage === undefined) {
      return errorResponse(redactor, 501, 'not_supported', 'Current kernel does not support plugin package removal')
    }
    return jsonOk(redactor, await kernel.plugins.removePluginPackage(pluginId))
  }
  if (third === 'config' && fourth === undefined) {
    if (method === 'GET') {
      const snapshot = await readSanitizedPluginConfig(
        kernel.plugins,
        pluginId,
        kernel.stash !== undefined ? (text) => kernel.stash!.redact(text) : undefined,
      )
      return jsonOk(redactor, snapshot)
    }
    if (method === 'PUT') {
      const body = await readJsonBody(ctx.request)
      await kernel.plugins.setConfig(pluginId, parsePluginConfigBody(body))
      return jsonOk(redactor, { ok: true })
    }
    return methodNotAllowed(redactor, method)
  }
  // Read-only plugin extension contract projection: GET /api/plugins/:pluginId/manifest
  if (third === 'manifest' && fourth === undefined) {
    if (method !== 'GET') return methodNotAllowed(redactor, method)
    if (kernel.plugins.getManifest === undefined) {
      return errorResponse(redactor, 501, 'not_supported', 'Current kernel does not support plugin manifest projection')
    }
    return jsonOk(redactor, await kernel.plugins.getManifest(pluginId))
  }
  // Plugin public document: GET /api/plugins/:pluginId/docs/:name (404 if private, disabled, or missing).
  // ?conversationId=N selects sessionDoc snapshot; `/events` opens the dedicated sessionDoc SSE stream.
  if (third === 'docs' && method === 'GET') {
    // Dedicated SSE: GET /api/plugins/:id/docs/:name/events?conversationId=N
    // Total segments = plugins(1) + id(2) + docs(3) + name(4) + events(5).
    if (fourth !== undefined && fifth === 'events' && segments.length === 5) {
      return sessionDocEventsResponse(ctx, kernel, redactor, pluginId, decodeSegment(fourth))
    }
    if (fifth !== undefined) return errorResponse(redactor, 404, 'not_found', 'route not found')
    if (fourth === undefined) throw new ValidationError('missing doc name path segment')
    const name = parseDocNameParam(decodeSegment(fourth))
    const conversationId = parseConversationIdQuery(ctx.url)
    if (conversationId === undefined) {
      return jsonOk(redactor, await kernel.plugins.getPublicDoc(pluginId, name))
    }
    return jsonOk(
      redactor,
      await kernel.plugins.getPublicSessionDoc(pluginId, name, conversationId),
    )
  }
  // Plugin client module: GET/HEAD /api/plugins/:pluginId/client.mjs?module=<relativePath>&chunk=<chunkName>&hash=<contentHash>
  if (third === 'client.mjs' && (method === 'GET' || method === 'HEAD') && fourth === undefined) {
    return serveClientModule(ctx, kernel, pluginId)
  }
  // Plugin dynamic routes: scoped under /api/plugins/:pluginId/routes/... so core management paths cannot be shadowed.
  if (third === 'routes') {
    return dispatchPluginRoute(kernel, redactor, ctx.request, method, segments)
  }
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

// ---------------------------------------------------------------------------
// /api/actions
// ---------------------------------------------------------------------------

export async function handleActionsDomain(
  ctx: RouteContext,
  kernel: Pick<PluginRoutesTarget, 'plugins'>,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
  const fourth = segments[3]
  if (second === undefined && method === 'GET') {
    const actions = await kernel.plugins.listActions()
    return jsonOk(
      redactor,
      actions.filter((action) => action.visibility !== 'internal'),
    )
  }
  const pluginId = requireIdParam(second ?? '', 'pluginId')
  const actionId = requireIdParam(third ?? '', 'actionId')
  if (method === 'POST' && fourth === undefined) {
    const body = await readJsonBody(ctx.request)
    const { input, conversationId } = parseActionInvokeBody(body)
    const result = await kernel.plugins.invokeAction(pluginId, actionId, input, conversationId !== undefined ? { conversationId } : undefined)
    // Null is a valid action output; undefined violates the output contract so reject it explicitly.
    return jsonOk(redactor, result)
  }
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

// ---------------------------------------------------------------------------
// Internal helpers: body validation / doc SSE / client.mjs / dynamic route dispatch
// ---------------------------------------------------------------------------

/** POST /api/plugins/:id/disable body: only force(query ?force=1 same meaning). */
function parsePluginDisableBody(body: Record<string, unknown>): { force?: boolean } {
  assertBodySchema(REQUEST_SCHEMAS.pluginDisable, body, 'plugins disable body')
  return body.force !== undefined ? { force: body.force as boolean } : {}
}

/** POST /api/plugins/:id/update body: optional non-empty `source` string for switching/upgrading pinned sources. */
function parsePluginUpdateBody(body: Record<string, unknown>): { source?: string } {
  assertBodySchema(REQUEST_SCHEMAS.pluginUpdate, body, 'plugins update body')
  return body.source !== undefined ? { source: body.source as string } : {}
}

/** Parses `?conversationId=N` query param as a positive safe integer (400 otherwise). */
function parseConversationIdQuery(url: URL): number | undefined {
  const raw = url.searchParams.get('conversationId')
  if (raw === null) return undefined
  if (!/^\d+$/.test(raw)) {
    throw new ValidationError('conversationId must be a positive integer')
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError('conversationId must be a positive integer')
  }
  return value
}

/**
 * Dedicated sessionDoc SSE: `GET /api/plugins/:id/docs/:name/events?conversationId=N`.
 * - Auth shares hub middleware; returns structured JSON 401 when unauthorized;
 * - Sync snapshot provider runs after registering the buffered subscription to prevent missed frames;
 * - Stream closes cleanly on `plugin.changed` (`enabled=false`) or `conversation.deleted` events;
 * - Returns 501 if `sessionDocEvents` port is unavailable (no polling/in-memory fallback).
 */
async function sessionDocEventsResponse(
  ctx: RouteContext,
  kernel: Pick<PluginRoutesTarget, 'plugins' | 'sessionDocEvents'>,
  redactor: JsonRedactor | undefined,
  pluginId: string,
  rawName: string,
): Promise<Response> {
  const name = parseDocNameParam(rawName)
  const conversationId = parseConversationIdQuery(ctx.url)
  if (conversationId === undefined) {
    throw new ValidationError('sessionDoc subscription requires ?conversationId=<positive integer>')
  }
  const port = kernel.sessionDocEvents
  if (port === undefined) {
    throw new HelmxError(
      'not_implemented',
      'Current runtime does not support sessionDoc event streams (sessionDocEvents port missing)',
      501,
    )
  }
  const target = { pluginId, name, conversationId }
  const snapshot = () => {
    const doc = snapshotDocOf(kernel.plugins, pluginId, name, conversationId)
    return { seq: port.seq, doc }
  }
  return port.response(ctx.request, { snapshot, target })
}

/** GET/HEAD `/api/plugins/:id/client.mjs`: validates module/chunk/hash params and handles ETag/304 + gzip. */
async function serveClientModule(
  ctx: RouteContext,
  kernel: Pick<PluginRoutesTarget, 'plugins'>,
  pluginId: string,
): Promise<Response> {
  const { request, method, url } = ctx
  const moduleRef = url.searchParams.get('module')
  if (moduleRef === null || moduleRef.length === 0) {
    throw new ValidationError('missing module query parameter (relative .ts/.tsx path under clientRoot)')
  }
  if (moduleRef.length > 256 || moduleRef.includes('..') || moduleRef.startsWith('/') || moduleRef.includes('\\')) {
    throw new ValidationError('module must be a relative .ts/.tsx path inside clientRoot (absolute paths and .. are disallowed)')
  }
  const chunk = url.searchParams.get('chunk') ?? undefined
  const hash = url.searchParams.get('hash') ?? undefined
  if (chunk !== undefined) {
    if (!/^[A-Za-z0-9._-]+\.js$/.test(chunk) || chunk.includes('..')) {
      throw new HelmxError('invalid_client_module', 'Invalid chunk name (must match /^[A-Za-z0-9._-]+\\.js$/ without ..)', 400)
    }
  }
  const ifNoneMatch = request.headers.get('if-none-match')
  const probeMetaOnly = method === 'HEAD' || ifNoneMatch !== null
  let compiled = await kernel.plugins.getClientModule(pluginId, moduleRef, {
    ...(chunk !== undefined ? { chunk } : {}),
    ...(hash !== undefined ? { hash } : {}),
    ...(probeMetaOnly ? { metadataOnly: true } : {}),
  })
  if (hash !== undefined && (hash.length === 0 || hash !== compiled.contentHash)) {
    throw new HelmxError(
      chunk !== undefined ? 'client_chunk_stale' : 'client_module_stale',
      `plugin ${pluginId} client module ${moduleRef} hash (${hash}) does not match current artifact hash (${compiled.contentHash})`,
      409,
      {
        pluginId,
        module: moduleRef,
        ...(chunk !== undefined ? { chunk } : {}),
        hash,
        currentHash: compiled.contentHash,
      },
    )
  }
  const etag = chunk !== undefined ? `"${compiled.contentHash}:${chunk}"` : `"${compiled.contentHash}"`
  const isImmutable = hash !== undefined && hash.length > 0 && hash === compiled.contentHash
  const cacheControl = isImmutable ? 'private, max-age=31536000, immutable' : 'private, no-cache'

  const etagMatched = ifNoneMatch === etag || ifNoneMatch === `W/${etag}`
  if (ifNoneMatch && etagMatched) {
    return new Response(null, {
      status: 304,
      headers: {
        etag,
        'x-helmx-client-hash': compiled.contentHash,
        'cache-control': cacheControl,
        vary: 'Accept-Encoding',
      },
    })
  }

  const headers: Record<string, string> = {
    'content-type': 'text/javascript; charset=utf-8',
    'x-helmx-client-hash': compiled.contentHash,
    etag,
    'cache-control': cacheControl,
    vary: 'Accept-Encoding',
  }

  if (method === 'HEAD') {
    return new Response(null, { status: 200, headers })
  }

  if (probeMetaOnly && compiled.code === '') {
    compiled = await kernel.plugins.getClientModule(pluginId, moduleRef, {
      ...(chunk !== undefined ? { chunk } : {}),
      ...(hash !== undefined ? { hash } : {}),
    })
  }

  const acceptEncoding = request.headers.get('accept-encoding') ?? ''
  if (/\bgzip\b/i.test(acceptEncoding)) {
    headers['content-encoding'] = 'gzip'
    let gzBuffer = compiled.gzipped
    if (gzBuffer === undefined) {
      gzBuffer = await compressGzip(Buffer.from(compiled.code, 'utf8'))
      compiled.gzipped = gzBuffer
    }
    return new Response(gzBuffer as unknown as BodyInit, {
      status: 200,
      headers,
    })
  }

  return new Response(compiled.code, {
    status: 200,
    headers,
  })
}

/** Maximum byte budget for buffering `application/json` / `*+json` plugin route bodies before falling back to streaming redaction. */
export const PLUGIN_ROUTE_JSON_REDACT_MAX_BYTES = 4 * 1024 * 1024

interface RouteTaskHandle {
  readonly tracked: boolean
  end(): void
  waitIfEnded(): Promise<void>
}

function acquireRouteTask(
  plugins: PluginRoutesHost,
  pluginId: string,
  label: string,
): RouteTaskHandle {
  if (plugins.beginTask !== undefined && plugins.endTask !== undefined) {
    plugins.beginTask(pluginId, label)
    let ended = false
    return {
      tracked: true,
      end() {
        if (ended) return
        ended = true
        plugins.endTask!(pluginId, label)
      },
      waitIfEnded: async () => {},
    }
  }
  if (plugins.withTask !== undefined) {
    let release!: () => void
    const done = new Promise<void>((resolve) => {
      release = resolve
    })
    let ended = false
    const taskPromise = plugins.withTask(pluginId, label, () => done).catch(() => {})
    return {
      tracked: true,
      end() {
        if (ended) return
        ended = true
        release()
      },
      async waitIfEnded() {
        if (ended) await taskPromise
      },
    }
  }
  return {
    tracked: false,
    end() {},
    waitIfEnded: async () => {},
  }
}

/**
 * Wraps a plugin route's outbound `ReadableStream` so `liveTasks` stays active until the stream
 * completes, errors, is cancelled, or the request signal aborts. Runs a non-blocking microtask
 * probe so already-buffered single-chunk responses (`Response.json`, `new Response('text')`, etc.)
 * settle and release their task immediately without hanging `liveTasks` if unread.
 */
async function trackReadableStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  onEnd: () => void,
): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader()
  const buffered: Uint8Array[] = []
  let inFlight: Promise<void> | null = null
  let streamClosed = false
  let streamErrored = false
  let streamError: unknown
  let finished = false

  const finish = (): void => {
    if (finished) return
    finished = true
    signal?.removeEventListener('abort', onAbort)
    onEnd()
  }

  const onAbort = (): void => {
    buffered.length = 0
    streamClosed = true
    finish()
    void reader.cancel(signal?.reason).catch(() => {})
  }

  if (signal !== undefined) {
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  const startRead = (): Promise<void> => {
    if (inFlight !== null) return inFlight
    if (streamClosed || streamErrored) return Promise.resolve()
    inFlight = reader.read().then(
      (res) => {
        inFlight = null
        if (streamClosed) return
        if (res.done) {
          streamClosed = true
          finish()
        } else if (res.value !== undefined) {
          buffered.push(res.value)
        }
      },
      (err) => {
        inFlight = null
        if (streamClosed) return
        streamErrored = true
        streamError = err
        finish()
      },
    )
    return inFlight
  }

  if (!finished) {
    void startRead()
    await Promise.resolve()
    await Promise.resolve()
    if (inFlight === null && !streamClosed && !streamErrored && buffered.length === 1) {
      void startRead()
      await Promise.resolve()
      await Promise.resolve()
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        if (buffered.length > 0) {
          controller.enqueue(buffered.shift()!)
          if (buffered.length === 0 && streamClosed) {
            controller.close()
            finish()
          }
          return
        }
        if (streamErrored) {
          finish()
          controller.error(streamError)
          return
        }
        if (streamClosed) {
          finish()
          controller.close()
          return
        }
        await startRead()
      }
    },
    async cancel(reason) {
      buffered.length = 0
      streamClosed = true
      finish()
      await reader.cancel(reason).catch(() => {})
    },
  })
}

/**
 * Dispatches dynamic plugin routes (`/api/plugins/<id>/routes/...`) using `findPluginRoute`.
 * Re-checks plugin enabled state via summary (409 if disabled) and tracks both handler execution
 * and open outbound response streams in `liveTasks` until completion, error, cancellation, or abort.
 */
async function dispatchPluginRoute(
  kernel: Pick<PluginRoutesTarget, 'plugins' | 'stash'>,
  redactor: JsonRedactor | undefined,
  request: Request,
  method: string,
  segments: string[],
): Promise<Response> {
  const routes = kernel.plugins.listRoutes()
  const found = findPluginRoute(routes, method, ['api', ...segments])
  if (found === undefined) {
    const rest = segments.slice(4).join('/')
    return errorResponse(redactor, 404, 'route_not_found', `Plugin route not found: ${method} /${rest}`)
  }
  const summary = kernel.plugins.get?.(found.pluginId)
  if (summary !== undefined && !isPluginSummaryActive(summary)) {
    throw new HelmxError('plugin_disabled', `Plugin ${found.pluginId} is disabled; route unavailable`, 409, {
      pluginId: found.pluginId,
    })
  }
  const taskLabel = `route:${found.route.method} ${found.route.path}`
  const task = acquireRouteTask(kernel.plugins, found.pluginId, taskLabel)
  try {
    const response = await Promise.resolve(found.route.handler(request, { params: found.params }))
    if (!(response instanceof Response)) {
      throw new HelmxError('invalid_route_handler_output', 'Plugin route handler must return a Response', 500)
    }
    let trackedResponse = response
    if (response.body === null) {
      task.end()
    } else if (task.tracked) {
      const trackedBody = await trackReadableStream(response.body, request.signal, () => task.end())
      trackedResponse = new Response(trackedBody, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      })
    }
    const finalResponse = await redactPluginRouteResponse(trackedResponse, kernel.stash)
    await task.waitIfEnded()
    return finalResponse
  } catch (err) {
    task.end()
    await task.waitIfEnded()
    throw err
  }
}

function classifyPluginRouteMediaType(contentType: string | null): 'json' | 'stream-text' | 'other' {
  if (contentType === null) return 'other'
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) return 'json'
  if (mediaType === 'application/x-ndjson' || mediaType === 'application/ndjson' || mediaType.startsWith('text/')) {
    return 'stream-text'
  }
  return 'other'
}

function createRedactingTextStream(
  source: ReadableStream<Uint8Array>,
  stash: PluginRoutesStash,
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const streamRedactor = stash.createStreamingRedactor?.()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            reader.releaseLock()
            const tail = decoder.decode()
            const out = streamRedactor
              ? (tail.length > 0 ? streamRedactor.push(tail) : '') + streamRedactor.flush()
              : tail.length > 0
                ? stash.redact(tail)
                : ''
            if (out.length > 0) controller.enqueue(encoder.encode(out))
            controller.close()
            return
          }
          if (value === undefined || value.byteLength === 0) continue
          const text = decoder.decode(value, { stream: true })
          const out = streamRedactor ? streamRedactor.push(text) : stash.redact(text)
          if (out.length > 0) {
            controller.enqueue(encoder.encode(out))
            return
          }
        }
      } catch (err) {
        reader.releaseLock()
        controller.error(err)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {})
    },
  })
}

/**
 * Automatically redacts text/JSON plugin route responses through `SecretStash` while preserving status
 * and headers:
 * - `text/*` (including `text/event-stream`) and `application/x-ndjson` stream chunk-by-chunk via
 *   `TransformStream` with zero full-body buffering;
 * - `application/json` / `*+json` preserve exact JSON-aware redaction (`redactJsonValue`) up to
 *   `maxJsonBytes` (default 4 MiB), seamlessly falling back to streaming `TransformStream` redaction
 *   for oversized payloads without unbounded memory growth or truncation;
 * - Binary/non-text and encoded responses pass through untouched without buffering.
 */
async function redactPluginRouteResponse(
  response: Response,
  stash: PluginRoutesStash | undefined,
  maxJsonBytes = PLUGIN_ROUTE_JSON_REDACT_MAX_BYTES,
): Promise<Response> {
  if (stash === undefined || response.body === null) return response
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase()
  if (encoding !== undefined && encoding !== '' && encoding !== 'identity') return response

  const kind = classifyPluginRouteMediaType(response.headers.get('content-type'))
  if (kind === 'other') return response

  const headers = new Headers(response.headers)
  headers.delete('content-length')

  if (kind === 'stream-text') {
    return new Response(createRedactingTextStream(response.body, stash), {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

  const reader = response.body.getReader()
  const { chunks, totalBytes, exceeded } = await readBoundedChunks(reader, maxJsonBytes)

  if (!exceeded) {
    reader.releaseLock()
    const rawText = new TextDecoder().decode(concatUint8Arrays(chunks, totalBytes))
    let redactedText: string
    try {
      const parsed: unknown = JSON.parse(rawText)
      redactedText = JSON.stringify(redactJsonValue(parsed, (text) => stash.redact(text)))
    } catch {
      redactedText = stash.redact(rawText)
    }
    return new Response(redactedText, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

  return new Response(markStreamingJsonBody(createRedactingTextStream(stitchRemainingStream(chunks, reader), stash)), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
