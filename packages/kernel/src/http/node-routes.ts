/**
 * Node domain routes: /api/nodes (list/issue/remove/upgrade/port-forwarding) and
 * POST /api/env/exec (cross-node command execution, NDJSON streaming or single JSON response).
 */
import { HelmxError, NODE_CORE_OPERATIONS, isStrictSemver, isValidNodeId, REQUEST_SCHEMAS, stripSemverVPrefix, type EnvExecStreamFrame, type NodeIssuedToken } from '@helmx/protocol'
import type { SecretStash } from '../services/index.js'
import type { NodeManager } from '../runtime/node-manager.js'
import type { NodeForwardService } from '../env/forward.js'
import { redactJsonValue } from '../redact.js'
import { isAbsoluteTargetPath } from '@helmx/protocol'
import { jsonOk, errorResponse, readJsonBody, type JsonRedactor } from './http-utils.js'
import { createCoreOperationRouter } from './core-operation-router.js'
import { decodeSegment } from './route-match.js'
import { assertBodySchema, requireHttpUrl, requireUtf16LengthAtMost, ValidationError } from './validate.js'
import type { RouteContext } from './route-context.js'
import { parseOptionalJsonObjectBody } from './route-context.js'

export interface NodeRoutesTarget {
  readonly nodes: Pick<NodeManager, 'listNodes' | 'removeNode' | 'execEnv'> & {
    issueNodeToken(nodeId: string, opts?: { hubUrl?: string }): Promise<NodeIssuedToken>
  } & Partial<Pick<NodeManager, 'getHubAccess' | 'checkNodeUpgrade' | 'upgradeNode'>>
  readonly nodeForward?: Partial<
    Pick<NodeForwardService, 'start' | 'stop' | 'get' | 'list' | 'onEvent' | 'onStopped' | 'acquireLease'>
  >
  readonly stash?: Pick<SecretStash, 'redact'> & Partial<Pick<SecretStash, 'createStreamingRedactor'>>
}

function dispatchNodeJsonRoutes(
  kernel: Pick<NodeRoutesTarget, 'nodes' | 'nodeForward'>,
): (ctx: RouteContext, redactor: JsonRedactor | undefined) => Promise<Response | undefined> {
  return createCoreOperationRouter(NODE_CORE_OPERATIONS, {
    'nodes.list': () => kernel.nodes.listNodes(),

    'nodes.endpoints': () => {
      if (kernel.nodes.getHubAccess === undefined) {
        throw new HelmxError('not_implemented', 'current runtime does not support hub access endpoint listing', 501)
      }
      return kernel.nodes.getHubAccess()
    },

    'nodes.issue': {
      validate: (input) => {
        if (input.hubUrl !== undefined) {
          requireHttpUrl(input.hubUrl, 'hubUrl')
        }
      },
      handle: async (input) => {
        const opts = input.hubUrl !== undefined ? { hubUrl: input.hubUrl as string } : undefined
        const issued = await kernel.nodes.issueNodeToken(input.nodeId as string, opts)
        return {
          nodeId: issued.nodeId,
          token: issued.token,
          createdAt: issued.createdAt,
          ...(issued.hubAccess !== undefined ? { hubAccess: issued.hubAccess } : {}),
          ...(issued.connectGuide !== undefined ? { connectGuide: issued.connectGuide } : {}),
        }
      },
    },

    'nodes.remove': async (input) => {
      await kernel.nodes.removeNode(input.id as string)
      return { ok: true }
    },

    'nodes.upgrade_check': {
      validate: (input) => ({
        id: input.id,
        ...(input.registryUrl !== undefined
          ? { registryUrl: requireHttpUrl(input.registryUrl, 'registryUrl') }
          : {}),
      }),
      handle: (input) => {
        if (kernel.nodes.checkNodeUpgrade === undefined) {
          throw new HelmxError('not_implemented', 'current runtime does not support node upgrade check', 501)
        }
        const query = input.registryUrl !== undefined ? { registryUrl: input.registryUrl as string } : {}
        return kernel.nodes.checkNodeUpgrade(input.id as string, query)
      },
    },

    'nodes.upgrade': {
      validate: (input) => {
        const out: { id: string; targetVersion?: string; registryUrl?: string; force?: boolean } = {
          id: input.id as string,
        }
        if (input.targetVersion !== undefined) {
          const target = input.targetVersion as string
          if (target.trim() === '') {
            throw new ValidationError('targetVersion must be a non-empty version (omit to upgrade to latest)')
          }
          out.targetVersion = requireVersionField(target)
        }
        if (input.registryUrl !== undefined) {
          out.registryUrl = requireHttpUrl(input.registryUrl, 'registryUrl')
        }
        if (input.force !== undefined) {
          out.force = input.force as boolean
        }
        return out
      },
      handle: (input) => {
        if (kernel.nodes.upgradeNode === undefined) {
          throw new HelmxError('not_implemented', 'current runtime does not support node upgrade', 501)
        }
        const opts: { targetVersion?: string; registryUrl?: string; force?: boolean } = {}
        if (input.targetVersion !== undefined) opts.targetVersion = input.targetVersion as string
        if (input.registryUrl !== undefined) opts.registryUrl = input.registryUrl as string
        if (input.force !== undefined) opts.force = input.force as boolean
        return kernel.nodes.upgradeNode(input.id as string, opts)
      },
    },

    'nodes.forwards': () => {
      if (kernel.nodeForward?.list === undefined) {
        throw new HelmxError('not_implemented', 'current runtime does not support node port forwarding', 501)
      }
      return kernel.nodeForward.list()
    },

    'nodes.forward_inspect': (input, { redactor }) => {
      if (kernel.nodeForward?.get === undefined) {
        throw new HelmxError('not_implemented', 'current runtime does not support node port forwarding', 501)
      }
      const session = kernel.nodeForward.get(input.id as string)
      if (session === undefined) {
        return errorResponse(redactor, 404, 'not_found', 'forwarding session not found or already stopped')
      }
      return session
    },

    'nodes.forward_stop': async (input, { redactor }) => {
      if (kernel.nodeForward?.stop === undefined) {
        throw new HelmxError('not_implemented', 'current runtime does not support node port forwarding', 501)
      }
      const forwardId = input.id as string
      // Idempotency expressed via 404: stopping an absent forward returns 404 (prevents duplicate exit errors).
      if (kernel.nodeForward.get !== undefined && kernel.nodeForward.get(forwardId) === undefined) {
        return errorResponse(redactor, 404, 'not_found', 'forwarding session not found or already stopped')
      }
      await kernel.nodeForward.stop(forwardId)
      return { ok: true }
    },
  })
}

export async function handleNodeDomain(
  ctx: RouteContext,
  kernel: Pick<NodeRoutesTarget, 'nodes' | 'nodeForward'>,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
  const fourth = segments[3]
  const fifth = segments[4]

  // Foreground port forwarding: POST /:id/forward and NDJSON event stream GET /forward/:id/events
  if (second !== undefined && third === 'forward' && fourth === undefined && method === 'POST') {
    if (kernel.nodeForward?.start === undefined) {
      throw new HelmxError('not_implemented', 'current runtime does not support node port forwarding', 501)
    }
    const nodeId = requireNodeSegment(second)
    const body = await parseOptionalJsonObjectBody(ctx.request, parseNodeForwardBody)
    return jsonOk(redactor, await kernel.nodeForward.start(nodeId, body), { status: 201 })
  }
  if (second === 'forward' && third !== undefined && fourth === 'events' && fifth === undefined && method === 'GET') {
    return getNodeForwardEvents(ctx, kernel, requireForwardSegment(third))
  }

  const matched = await dispatchNodeJsonRoutes(kernel)(ctx, redactor)
  if (matched !== undefined) return matched

  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

// ---------------------------------------------------------------------------
// /api/env/exec
// ---------------------------------------------------------------------------

/** Node ID path segment: starts with ASCII alphanumeric, may contain . _ - (matches issue validation). */
function requireNodeSegment(raw: string): string {
  const decoded = decodeSegment(raw)
  if (!isValidNodeId(decoded)) {
    throw new ValidationError('nodeId must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ (starts with an alphanumeric character, may contain . _ -)')
  }
  return decoded
}

/** Boundary validation for targetVersion: optional single v/V prefix after trim, remainder must be strict SemVer (single implementation in @helmx/protocol/semver). */
function requireVersionField(raw: string): string {
  const bare = stripSemverVPrefix(raw)
  if (!isStrictSemver(bare)) {
    throw new ValidationError('targetVersion must be strict SemVer (optional single v prefix, e.g. 1.2.3 or v1.2.3)')
  }
  return raw
}

/**
 * POST /api/nodes/:id/forward body: listenHost/listenPort/targetPort required,
 * targetHost optional; shape (hostname without whitespace/control chars) is enforced by schema,
 * and UTF-16 length cap (<= 255 code units) is kept hand-written to match existing rules.
 */
function parseNodeForwardBody(
  body: Record<string, unknown>,
): { listenHost: string; listenPort: number; targetHost?: string; targetPort: number } {
  assertBodySchema(REQUEST_SCHEMAS.nodeForward, body, 'node forward body')
  requireUtf16LengthAtMost('listenHost', body.listenHost as string, 255)
  if (body.targetHost !== undefined) requireUtf16LengthAtMost('targetHost', body.targetHost as string, 255)
  return {
    listenHost: body.listenHost as string,
    listenPort: body.listenPort as number,
    ...(body.targetHost !== undefined ? { targetHost: body.targetHost as string } : {}),
    targetPort: body.targetPort as number,
  }
}

/**
 * POST /api/env/exec:
 * - stream=true: application/x-ndjson stream; each line is `{"type":"output","stream":...,"text":...}`
 *   (text redacted across chunks via StreamingRedactor), followed by `{"type":"exit",...}`;
 * - otherwise returns JSON EnvExecResponse once (all text redacted after aggregation).
 */
export async function handleEnvExecDomain(
  ctx: RouteContext,
  kernel: Pick<NodeRoutesTarget, 'nodes' | 'stash'>,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  if (ctx.segments[1] !== 'exec' || ctx.method !== 'POST' || ctx.segments[2] !== undefined) {
    return errorResponse(redactor, 404, 'not_found', 'route not found')
  }
  const body = await readJsonBody(ctx.request)
  assertBodySchema(REQUEST_SCHEMAS.envExec, body, 'env exec body')
  // Cross-platform cwd absoluteness: POSIX / and Windows drive-absolute/UNC are valid;
  // drive-relative (e.g. C:relative) and relative paths are rejected (matches CLI string cwd rules).
  if (body.cwd !== undefined && !isAbsoluteTargetPath(body.cwd as string)) {
    throw new ValidationError(
      'cwd must be an absolute path (POSIX /..., Windows drive, or UNC; drive-relative and relative paths are rejected)',
    )
  }
  const request = {
    command: body.command as string | string[],
    ...(body.nodeId !== undefined ? { nodeId: body.nodeId as string } : {}),
    ...(body.cwd !== undefined ? { cwd: body.cwd as string } : {}),
    ...(body.conversationId !== undefined ? { conversationId: body.conversationId as number } : {}),
    ...(body.env !== undefined ? { env: { ...(body.env as Record<string, string>) } } : {}),
    ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs as number } : {}),
    ...(body.stream !== undefined ? { stream: body.stream as boolean } : {}),
  }
  const redactText = (text: string): string =>
    kernel.stash !== undefined ? kernel.stash.redact(text) : text

  if (body.stream === true) {
    // Streaming: StreamingRedactor retains tail buffer to prevent secrets split across chunk boundaries from leaking; flushed on finish.
    // Frame protocol aligns with @helmx/protocol EnvExecStreamFrame:
    // - per chunk `{ type: 'output', stream, text }` (redacted across chunks);
    // - final frame on completion `{ type: 'exit', ok, exitCode, timedOut }` (must follow tail flush);
    // - mid-stream error `{ type: 'error', error: { code, message, details? } }` (never fabricate exit).
    const encoder = new TextEncoder()
    const makeStreamRedactor = () => {
      let buffered = ''
      return kernel.stash?.createStreamingRedactor?.() ?? {
        push(text: string) { buffered += text; return '' },
        flush() { const safe = redactText(buffered); buffered = ''; return safe },
      }
    }
    const stdoutRedactor = makeStreamRedactor()
    const stderrRedactor = makeStreamRedactor()
    const streamAbort = new AbortController()
    const executionSignal = AbortSignal.any([ctx.request.signal, streamAbort.signal])
    // Named `readableStream` to avoid shadowing the outer `stream` boolean flag in request body.
    const readableStream = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
        const write = (payload: EnvExecStreamFrame): void => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`))
          } catch {
            streamAbort.abort()
          }
        }
        try {
          const result = await kernel.nodes.execEnv(request, (chunk) => {
            const activeRedactor = chunk.stream === 'stderr' ? stderrRedactor : stdoutRedactor
            const safe = activeRedactor.push(chunk.text)
            if (safe !== '') write({ type: 'output', stream: chunk.stream, text: safe })
          }, executionSignal)
          // Final frame must come after flushing both per-stream tail buffers so interleaved stdout/stderr never corrupt partial secret matches.
          const stdoutTail = stdoutRedactor.flush()
          if (stdoutTail !== '') {
            write({ type: 'output', stream: 'stdout' as const, text: stdoutTail })
          }
          const stderrTail = stderrRedactor.flush()
          if (stderrTail !== '') {
            write({ type: 'output', stream: 'stderr' as const, text: stderrTail })
          }
          write({
            type: 'exit',
            ok: result.ok,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
          })
        } catch (error) {
          // Mid-stream exception: emit redacted error frame without fabricating an exit frame.
          if (error instanceof HelmxError) {
            write({
              type: 'error',
              error: {
                code: error.code,
                message: redactText(error.message),
                ...(error.details !== undefined ? { details: redactJsonValue(error.details, redactText) } : {}),
              },
            })
          } else {
            const message = error instanceof Error ? error.message : String(error)
            write({ type: 'error', error: { code: 'internal_error', message: redactText(message) } })
          }
        } finally {
          try {
            controller.close()
          } catch {
            /* already closed */
          }
        }
        })()
      },
      cancel() { streamAbort.abort() },
    })
    return new Response(readableStream, {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-cache',
      },
    })
  }
  return jsonOk(redactor, await kernel.nodes.execEnv(request, undefined, ctx.request.signal))
}

// ---------------------------------------------------------------------------
// Node foreground port-forwarding event stream
// ---------------------------------------------------------------------------

/** forwardId path segment: `fwd-<uuid>`. */
function requireForwardSegment(raw: string): string {
  const decoded = decodeSegment(raw)
  if (!/^fwd-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(decoded)) {
    throw new ValidationError('forwardId must be in fwd-<uuid> format')
  }
  return decoded
}

/**
 * GET /api/nodes/forward/:id/events: NDJSON event stream, which itself holds a foreground lease:
 * acquired on start, released on abort/cancel—so forwarding stops when the last holder leaves (Hub
 * leaves no orphaned listeners). Emits a terminal `stopped` frame then closes cleanly (no hanging monitors);
 * if already stopped at subscribe time, emits `stopped` and closes immediately.
 */
async function getNodeForwardEvents(
  ctx: RouteContext,
  kernel: Pick<NodeRoutesTarget, 'nodeForward'>,
  forwardId: string,
): Promise<Response> {
  // Abort preflight (mirrors SSE streams in events.ts): the client may have disconnected while awaiting
  // auth (verifyToken)—adding an abort listener to an already-aborted signal never fires, so `finish`
  // would never run and the lease would leak. This body has no awaits, so there is no interleaving window
  // between this preflight and ReadableStream construction (`start` runs synchronously); no resources are
  // acquired yet, so returning immediately requires no cleanup.
  if (ctx.request.signal.aborted) {
    return errorResponse(undefined, 409, 'client_disconnected', 'client disconnected; refusing to open forwarding monitor stream')
  }
  const nodeForward = kernel.nodeForward
  if (nodeForward?.get === undefined || nodeForward.onEvent === undefined) {
    throw new HelmxError('not_implemented', 'current runtime does not support node port forwarding', 501)
  }
  const getForward = nodeForward.get
  const onEvent = nodeForward.onEvent
  const session = getForward(forwardId)
  if (session === undefined) {
    return errorResponse(undefined, 404, 'not_found', 'forwarding session not found or already stopped')
  }
  const encoder = new TextEncoder()
  // Shared teardown bridge between start and cancel (cancel cannot see variables closed over inside start;
  // each stream instance is independent so there is no concurrency interference).
  const teardown = { run: (): void => undefined }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Single idempotent `finished` terminal flag: failed sends must NOT merely set a flag
      // (which would make `finish` short-circuit and leak the lease/subscriptions/stop hooks);
      // failures must always run the full `finish` cleanup path.
      let finished = false
      let releaseLease: (() => void) | undefined
      let offEvents: (() => void) | undefined
      const offStops: (() => void)[] = []
      const send = (event: unknown): void => {
        if (finished) return
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        } catch {
          // Enqueue failed (downstream closed/errored): equivalent to disconnect, run full cleanup.
          finish()
        }
      }
      const finish = (): void => {
        if (finished) return
        finished = true
        releaseLease?.()
        releaseLease = undefined
        offEvents?.()
        offEvents = undefined
        for (const stop of offStops.splice(0)) stop()
        try { controller.close() } catch { /* already closed */ }
      }
      teardown.run = finish
      // Register stop listener first (handles already-stopped race via immediate microtask callback), then
      // bind lease / emit initial frame / subscribe—guarantees either the `stopped` frame or stop callback
      // closes the stream on race, and both paths release the lease.
      if (nodeForward.onStopped !== undefined) {
        offStops.push(nodeForward.onStopped(forwardId, () => finish()))
      }
      if (nodeForward.acquireLease !== undefined) {
        releaseLease = nodeForward.acquireLease(forwardId)
      }
      offEvents = onEvent(forwardId, send)
      send({ type: 'started', listenHost: session.listenHost, listenPort: session.listenPort })
      ctx.request.signal.addEventListener('abort', finish, { once: true })
    },
    cancel() {
      // Client cancelled stream (`body.cancel()`): release lease too (stops forwarding once last holder leaves).
      teardown.run()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  })
}
