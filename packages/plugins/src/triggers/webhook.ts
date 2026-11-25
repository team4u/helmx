/**
 * triggers/webhook.ts: the inbound webhook connector.
 *
 * Contract:
 * - Public route POST /webhook/:id (host full path /api/plugins/builtin%3Atriggers/
 *   routes/webhook/:id; public:true skips token auth -- the plugin verifies signatures itself);
 * - HMAC-SHA256: header x-helmx-signature: sha256=<hex>, covering raw body bytes; timingSafeEqual;
 *   missing/wrong signature 401, unknown id 404, success 202 {accepted:true};
 * - The secret lands only in credentials.json pluginSecrets['builtin:triggers']['webhook:<id>']
 *   (0600, via ctx.host.secrets) plus global secrets.addRedaction; the doc stores metadata only;
 * - webhook_create rejects conversation contexts (403 webhook_secret_context_forbidden);
 * - Delivery defaults to isolated automated (`ownedBy: 'helmx'`) runs with retention cap `keepLast`,
 *   or supports `mode: 'dedicated'` (one persistent `helmx` conversation) or explicit `targetConversationId`.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { HelmxError } from '@helmx/protocol'
import type { HelmxPluginContext, PluginActionContext } from '@helmx/protocol'
import { BodyError, readBody } from '@helmx/protocol'
import {
  DEFAULT_TRIGGER_KEEP_LAST,
  MAX_DESCRIPTION,
  MAX_TRIGGER_KEEP_LAST,
  TRIGGERS_PLUGIN_ID,
  assertDescription,
  assertTriggerId,
  assertTriggerTargetPatchSyntax,
  assertWebhookSecret,
  assertWebhooksDoc,
  mergeTriggerTargetPatch,
  normalizeTriggerTargetInput,
  webhookPublicMeta,
  webhookSecretKey,
  type TriggerSessionMode,
  type WebhookMeta,
  type WebhooksDoc,
} from './contracts.js'
import type { DispatchTriggerHelper, TriggerDeliveryTarget } from './delivery.js'

/** Public webhook request body cap (raw bytes; exceeding gives an explicit 413). */
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024

/** Bounded wait on in-flight public-route requests during disable. */
export const STOP_REQUEST_WAIT_MS = 10_000

const SIGNATURE_HEADER = 'x-helmx-signature'
const SIGNATURE_PREFIX = 'sha256='

function webhookError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

const acceptedResponse = (): Response =>
  new Response(JSON.stringify({ accepted: true }), {
    status: 202,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })

function verifySignature(secret: string, body: Uint8Array, header: string): boolean {
  if (!header.startsWith(SIGNATURE_PREFIX)) return false
  const hex = header.slice(SIGNATURE_PREFIX.length)
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false
  const expectedHex = createHmac('sha256', secret).update(body).digest('hex')
  const provided = Buffer.from(hex.toLowerCase(), 'utf8')
  const expected = Buffer.from(expectedHex, 'utf8')
  return timingSafeEqual(provided, expected)
}

export interface RegisterWebhookResult {
  createWebhook(input: CreateWebhookInput, context: PluginActionContext): Promise<{ webhook: WebhookMeta }>
  updateWebhook(input: UpdateWebhookInput): Promise<{ webhook: WebhookMeta }>
  listWebhooks(): { webhooks: WebhookMeta[] }
  deleteWebhook(input: { id: string }): Promise<{ deleted: true }>
  getWebhook(id: string): WebhookMeta | undefined
}

interface CreateWebhookInput {
  id: string
  description?: string
  secret: string
  targetConversationId?: number
  mode?: TriggerSessionMode
  profileId?: string
  keepLast?: number
}

interface UpdateWebhookInput {
  id: string
  description?: string
  targetConversationId?: number
  mode?: TriggerSessionMode
  profileId?: string
  keepLast?: number
}

export function registerWebhook(
  ctx: HelmxPluginContext,
  shared: { dispatch: DispatchTriggerHelper },
): RegisterWebhookResult {
  const host = ctx.host
  const doc = ctx.doc<WebhooksDoc>('webhooks', { webhooks: [] }, { public: true })

  const readDoc = (): WebhooksDoc => assertWebhooksDoc(doc.get())
  const writeDoc = (next: WebhooksDoc): void => {
    doc.set(assertWebhooksDoc(next))
  }

  const secretRedactions = new Map<string, () => void>()
  let active = false
  const activeRequests = new Set<Promise<unknown>>()
  const idleWaiters: Array<() => void> = []

  const setSecretRedaction = (id: string, secret: string): void => {
    secretRedactions.get(id)?.()
    secretRedactions.set(id, host.secrets.addRedaction(secret))
  }

  const releaseSecretRedaction = (id: string): void => {
    const release = secretRedactions.get(id)
    if (release !== undefined) {
      secretRedactions.delete(id)
      release()
    }
  }

  const trackRequest = <T>(run: () => Promise<T>): Promise<T> => {
    let tracked!: Promise<T>
    tracked = (async () => {
      try {
        return await run()
      } finally {
        activeRequests.delete(tracked)
        if (!active && activeRequests.size === 0) {
          for (const notify of idleWaiters.splice(0)) notify()
        }
      }
    })()
    activeRequests.add(tracked)
    return tracked
  }

  const assertActive = (): void => {
    if (!active) {
      throw new HelmxError(
        'plugin_disabled',
        'the builtin:triggers webhook service is disabled; refusing to handle the request',
        409,
        { pluginId: TRIGGERS_PLUGIN_ID },
      )
    }
  }

  async function start(): Promise<void> {
    readDoc()
    const metas = readDoc().webhooks
    for (const meta of metas) {
      const secret = await host.secrets.get(webhookSecretKey(meta.id))
      if (secret !== undefined) setSecretRedaction(meta.id, secret)
    }
    active = true
  }

  async function stop(): Promise<void> {
    active = false
    if (activeRequests.size > 0) {
      let giveUpTimer: NodeJS.Timeout | undefined
      const idle = new Promise<void>((resolve) => {
        idleWaiters.push(resolve)
      })
      const deadline = new Promise<void>((resolve) => {
        giveUpTimer = setTimeout(resolve, STOP_REQUEST_WAIT_MS)
        giveUpTimer.unref?.()
      })
      await Promise.race([idle, deadline])
      if (giveUpTimer !== undefined) clearTimeout(giveUpTimer)
      if (activeRequests.size > 0) {
        console.error(
          `[triggers] webhook stop exceeded ${STOP_REQUEST_WAIT_MS}ms waiting for in-flight requests; ${activeRequests.size} unconverged (slow clients may still be reading the body); continuing disable`,
        )
      }
    }
    for (const release of secretRedactions.values()) release()
    secretRedactions.clear()
  }

  function liveTasks(): string[] {
    if (!active) return []
    const count = activeRequests.size
    return count > 0 ? [`webhook:inflight:${count}`] : []
  }

  let mutationChain: Promise<unknown> = Promise.resolve()
  const enqueueMutation = <T>(run: () => Promise<T>): Promise<T> => {
    const task = mutationChain.then(run, run)
    mutationChain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  const persistDedicatedConversationId = async (
    id: string,
    rev: string,
    conversationId: number,
  ): Promise<void> => {
    await enqueueMutation(async () => {
      const current = readDoc()
      const idx = current.webhooks.findIndex((w) => w.id === id && w.rev === rev && w.mode === 'dedicated')
      if (idx < 0 || current.webhooks[idx]!.dedicatedConversationId === conversationId) return
      const webhooks = [...current.webhooks]
      webhooks[idx] = { ...webhooks[idx]!, dedicatedConversationId: conversationId }
      writeDoc({ webhooks })
      await doc.flush()
    })
  }

  async function createWebhook(
    input: CreateWebhookInput,
    context: PluginActionContext,
  ): Promise<{ webhook: WebhookMeta }> {
    if (context.conversationId !== undefined) {
      throw new HelmxError(
        'webhook_secret_context_forbidden',
        'webhook_create carries a plaintext secret; calling from a conversation context (run_action/workflow) is forbidden; configure it via manual HTTP/CLI (helmx webhook create)',
        403,
        { pluginId: TRIGGERS_PLUGIN_ID, conversationId: context.conversationId },
      )
    }
    const id = assertTriggerId('webhook', input.id)
    const secret = assertWebhookSecret(input.secret)
    const description = input.description === undefined ? undefined : assertDescription(input.description)
    const target = normalizeTriggerTargetInput({
      targetConversationId: input.targetConversationId,
      mode: input.mode,
      profileId: input.profileId,
      keepLast: input.keepLast,
    })
    if (target.profileId !== undefined) {
      if ((await host.profiles.get(target.profileId)) === undefined) {
        throw new HelmxError(
          'validation_error',
          `profileId does not exist: ${target.profileId} (refusing to point at the wrong role)`,
          400,
          { profileId: target.profileId },
        )
      }
    }
    const meta: WebhookMeta = {
      id,
      rev: randomUUID(),
      hasSecret: true,
      ...(description !== undefined ? { description } : {}),
      ...(target.targetConversationId !== undefined ? { targetConversationId: target.targetConversationId } : {}),
      ...(target.mode !== undefined ? { mode: target.mode } : {}),
      ...(target.profileId !== undefined ? { profileId: target.profileId } : {}),
      ...(target.keepLast !== undefined ? { keepLast: target.keepLast } : {}),
      createdAt: Date.now(),
    }
    return enqueueMutation(async () => {
      if (readDoc().webhooks.some((w) => w.id === id)) {
        throw new HelmxError('webhook_exists', `webhook '${id}' already exists`, 409, { id })
      }
      try {
        writeDoc({ webhooks: [...readDoc().webhooks, meta] })
        await doc.flush()
        await host.secrets.set(webhookSecretKey(id), secret)
      } catch (secretError) {
        try {
          writeDoc({ webhooks: readDoc().webhooks.filter((w) => w.id !== id) })
          await doc.flush()
        } catch (rollbackError) {
          throw new HelmxError(
            'webhook_create_rollback_failed',
            `webhook '${id}' secret write failed and the doc rollback also failed (a doc entry without a secret remains; the next request will explicitly report the inconsistency -- please verify manually): ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            500,
            {
              id,
              secretError: secretError instanceof Error ? secretError.message : String(secretError),
            },
          )
        }
        throw secretError
      }
      setSecretRedaction(id, secret)
      return { webhook: webhookPublicMeta(meta) }
    })
  }

  async function updateWebhook(input: UpdateWebhookInput): Promise<{ webhook: WebhookMeta }> {
    assertActive()
    const id = assertTriggerId('webhook', input.id)
    const hasPatchField =
      input.description !== undefined ||
      input.mode !== undefined ||
      input.profileId !== undefined ||
      input.keepLast !== undefined ||
      input.targetConversationId !== undefined
    if (!hasPatchField) {
      throw new HelmxError(
        'validation_error',
        'webhook_update requires at least one updatable field besides id',
        400,
        { field: 'id' },
      )
    }
    const description = input.description === undefined ? undefined : assertDescription(input.description)
    assertTriggerTargetPatchSyntax({
      targetConversationId: input.targetConversationId,
      mode: input.mode,
      profileId: input.profileId,
      keepLast: input.keepLast,
    })
    if (!readDoc().webhooks.some((w) => w.id === id)) {
      throw new HelmxError('not_found', `webhook '${id}' does not exist`, 404, { id })
    }
    if (input.profileId !== undefined) {
      if ((await host.profiles.get(input.profileId)) === undefined) {
        throw new HelmxError(
          'validation_error',
          `profileId does not exist: ${input.profileId} (refusing to point at the wrong role)`,
          400,
          { profileId: input.profileId },
        )
      }
    }
    return enqueueMutation(async () => {
      assertActive()
      const current = readDoc()
      const index = current.webhooks.findIndex((w) => w.id === id)
      if (index < 0) {
        throw new HelmxError('not_found', `webhook '${id}' does not exist`, 404, { id })
      }
      const prev = current.webhooks[index]!
      const nextTarget = mergeTriggerTargetPatch(prev, {
        targetConversationId: input.targetConversationId,
        mode: input.mode,
        profileId: input.profileId,
        keepLast: input.keepLast,
      })
      const nextDescription =
        description === undefined ? prev.description : description === '' ? undefined : description
      const updated: WebhookMeta = {
        id: prev.id,
        rev: randomUUID(),
        hasSecret: prev.hasSecret,
        ...(nextDescription !== undefined ? { description: nextDescription } : {}),
        ...(nextTarget.targetConversationId !== undefined ? { targetConversationId: nextTarget.targetConversationId } : {}),
        ...(nextTarget.mode !== undefined ? { mode: nextTarget.mode } : {}),
        ...(nextTarget.profileId !== undefined ? { profileId: nextTarget.profileId } : {}),
        ...(nextTarget.keepLast !== undefined ? { keepLast: nextTarget.keepLast } : {}),
        ...(nextTarget.dedicatedConversationId !== undefined
          ? { dedicatedConversationId: nextTarget.dedicatedConversationId }
          : {}),
        createdAt: prev.createdAt,
      }
      const webhooks = [...current.webhooks]
      webhooks[index] = updated
      writeDoc({ webhooks })
      try {
        await doc.flush()
      } catch (err) {
        writeDoc(current)
        throw err
      }
      return { webhook: webhookPublicMeta(updated) }
    })
  }

  function listWebhooks(): { webhooks: WebhookMeta[] } {
    return { webhooks: readDoc().webhooks.map((w) => webhookPublicMeta(w)) }
  }

  async function deleteWebhook(input: { id: string }): Promise<{ deleted: true }> {
    const id = assertTriggerId('webhook', input.id)
    return enqueueMutation(async () => {
      const current = readDoc()
      const existing = current.webhooks.find((w) => w.id === id)
      if (existing === undefined) {
        throw new HelmxError('not_found', `webhook '${id}' does not exist`, 404, { id })
      }
      writeDoc({ webhooks: current.webhooks.filter((w) => w.id !== id) })
      try {
        await doc.flush()
        await host.secrets.delete(webhookSecretKey(id))
      } catch (err) {
        throw new HelmxError(
          'webhook_delete_secret_failed',
          `webhook '${id}' metadata deleted, but secret cleanup failed (left in credentials.json, unusable without an entry -- please verify manually): ${err instanceof Error ? err.message : String(err)}`,
          500,
          { id },
        )
      }
      releaseSecretRedaction(id)
      return { deleted: true }
    })
  }

  const buildTargetForWebhook = (meta: WebhookMeta): TriggerDeliveryTarget => {
    if (meta.targetConversationId !== undefined) {
      return { kind: 'conversation', conversationId: meta.targetConversationId }
    }
    if (meta.mode === 'dedicated') {
      return {
        kind: 'dedicated',
        triggerKind: 'webhook',
        triggerId: meta.id,
        label: meta.description,
        profileId: meta.profileId,
        dedicatedConversationId: meta.dedicatedConversationId,
        onDedicatedConversationId: (conversationId) =>
          persistDedicatedConversationId(meta.id, meta.rev, conversationId),
      }
    }
    return {
      kind: 'isolated',
      triggerKind: 'webhook',
      triggerId: meta.id,
      label: meta.description,
      profileId: meta.profileId,
      keepLast: meta.keepLast ?? DEFAULT_TRIGGER_KEEP_LAST,
    }
  }

  // ---- Public route: HMAC verification + delivery ----
  ctx.route({
    method: 'POST',
    path: '/webhook/:id',
    public: true,
    handler(request) {
      return trackRequest(async () => handleWebhookRequest(request)).catch((err: unknown) => {
        if (err instanceof HelmxError) {
          if (err.code === 'triggers_doc_corrupt') {
            return webhookError(500, err.code, err.message)
          }
          if (err.code === 'plugin_disabled') {
            return webhookError(409, err.code, err.message)
          }
        }
        return webhookError(500, 'webhook_internal_error', `webhook handling failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    },
  })

  async function handleWebhookRequest(request: Request): Promise<Response> {
    assertActive()
    if (request.method !== 'POST') {
      return webhookError(404, 'not_found', `the webhook route supports POST only (got ${request.method})`)
    }
    const rawId = request.url.split('?')[0]!.split('/').filter(Boolean).pop()
    let id: string
    try {
      id = rawId === undefined ? '' : decodeURIComponent(rawId)
    } catch {
      return webhookError(400, 'invalid_path_encoding', 'the webhook id path segment has invalid encoding')
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      return webhookError(404, 'not_found', `webhook does not exist: ${id || '(empty)'}`)
    }
    const meta = readDoc().webhooks.find((w) => w.id === id)
    if (meta === undefined) {
      return webhookError(404, 'not_found', `webhook does not exist: ${id}`)
    }
    const secret = await host.secrets.get(webhookSecretKey(id))
    if (secret === undefined || secret === '') {
      return webhookError(500, 'webhook_secret_missing', `webhook '${id}' is missing its secret (credentials.json and the doc are inconsistent -- please verify manually)`)
    }
    const signature = request.headers.get(SIGNATURE_HEADER)
    if (signature === null) {
      return webhookError(401, 'unauthorized', `missing the ${SIGNATURE_HEADER} header`)
    }
    let body: Uint8Array
    try {
      body = await readBody(request, MAX_WEBHOOK_BODY_BYTES)
    } catch (err) {
      if (err instanceof BodyError && err.code === 'body_too_large') {
        return webhookError(413, 'payload_too_large', `webhook body over the cap (${MAX_WEBHOOK_BODY_BYTES} bytes)`)
      }
      return webhookError(400, 'invalid_body', `webhook body read failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!verifySignature(secret, body, signature)) {
      return webhookError(401, 'unauthorized', 'signature verification failed (expected x-helmx-signature: sha256=<hex>, the signature covering the raw body bytes)')
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    } catch {
      return webhookError(400, 'invalid_body', 'the webhook body is not valid UTF-8')
    }
    const secretAtDispatch = await host.secrets.get(webhookSecretKey(id))
    if (!active) {
      return webhookError(409, 'plugin_disabled', 'the builtin:triggers webhook service is disabled; refusing delivery')
    }
    const metaAtDispatch = readDoc().webhooks.find((w) => w.id === id)
    if (metaAtDispatch === undefined) {
      return webhookError(404, 'not_found', `webhook does not exist: ${id}`)
    }
    if (secretAtDispatch !== secret || metaAtDispatch.rev !== meta.rev || metaAtDispatch.createdAt !== meta.createdAt) {
      return webhookError(409, 'webhook_changed', 'the webhook configuration changed; please resend with the current secret')
    }
    try {
      await shared.dispatch(
        {
          id: `webhook:${id}:${randomUUID()}`,
          source: `webhook:${id}`,
          text,
          whenBusy: 'followUp',
          ...(metaAtDispatch.targetConversationId !== undefined ? { targetConversationId: metaAtDispatch.targetConversationId } : {}),
          createdAt: Date.now(),
        },
        buildTargetForWebhook(metaAtDispatch),
      )
    } catch (err) {
      if (err instanceof HelmxError && (err.code === 'runtime_closing' || err.code === 'not_found')) {
        return webhookError(err.status, err.code, err.message)
      }
      return webhookError(500, 'webhook_dispatch_failed', `trigger delivery failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return acceptedResponse()
  }

  // ---- Lifecycle actions ----
  ctx.action({
    id: 'webhook_create',
    description:
      'Create a webhook inbound endpoint (HMAC-SHA256 verified); defaults to isolated automated sessions with keepLast=10, or dedicated / explicit targetConversationId; secret is CLI/HTTP-only',
    exposeToPrompt: false,
    scope: { conversationIds: [] },
    cli: { command: ['webhook', 'create'] },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
        description: { type: 'string', maxLength: MAX_DESCRIPTION },
        secret: { type: 'string', minLength: 1, maxLength: 512 },
        mode: { type: 'string', enum: ['isolated', 'dedicated'] },
        profileId: { type: 'string', minLength: 1, maxLength: 64 },
        keepLast: { type: 'integer', minimum: 1, maximum: MAX_TRIGGER_KEEP_LAST },
        targetConversationId: { type: 'integer', minimum: 1 },
      },
      required: ['id', 'secret'],
      additionalProperties: false,
    } as never,
    outputSchema: {
      type: 'object',
      properties: {
        webhook: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            rev: { type: 'string' },
            hasSecret: { type: 'boolean' },
            createdAt: { type: 'number' },
          },
          required: ['id', 'rev', 'hasSecret', 'createdAt'],
        },
      },
      required: ['webhook'],
      additionalProperties: false,
    } as never,
    handler: (input, context) => createWebhook(input as CreateWebhookInput, context),
  })

  ctx.action({
    id: 'webhook_update',
    description:
      'Update webhook endpoint metadata or delivery target (description, mode, profileId, keepLast, targetConversationId); secret is untouched and cannot be passed here',
    exposeToPrompt: false,
    cli: { command: ['webhook', 'update'] },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
        description: { type: 'string', maxLength: MAX_DESCRIPTION },
        mode: { type: 'string', enum: ['isolated', 'dedicated'] },
        profileId: { type: 'string', minLength: 1, maxLength: 64 },
        keepLast: { type: 'integer', minimum: 1, maximum: MAX_TRIGGER_KEEP_LAST },
        targetConversationId: { type: 'integer', minimum: 1 },
      },
      required: ['id'],
      additionalProperties: false,
    } as never,
    outputSchema: {
      type: 'object',
      properties: {
        webhook: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            rev: { type: 'string' },
            hasSecret: { type: 'boolean' },
            createdAt: { type: 'number' },
          },
          required: ['id', 'rev', 'hasSecret', 'createdAt'],
        },
      },
      required: ['webhook'],
      additionalProperties: false,
    } as never,
    handler: (input) => updateWebhook(input as UpdateWebhookInput),
  })

  ctx.action({
    id: 'webhook_list',
    description: 'List all webhook endpoint metadata (no secrets)',
    exposeToPrompt: false,
    idempotent: true,
    cli: { command: ['webhook', 'list'] },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } as never,
    outputSchema: {
      type: 'object',
      properties: { webhooks: { type: 'array' } },
      required: ['webhooks'],
      additionalProperties: false,
    } as never,
    handler: () => listWebhooks(),
  })

  ctx.action({
    id: 'webhook_delete',
    description: 'Delete a webhook endpoint (incl. secret cleanup)',
    exposeToPrompt: false,
    cli: { command: ['webhook', 'delete'] },
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } },
      required: ['id'],
      additionalProperties: false,
    } as never,
    outputSchema: {
      type: 'object',
      properties: { deleted: { type: 'boolean' } },
      required: ['deleted'],
      additionalProperties: false,
    } as never,
    handler: (input) => deleteWebhook(input as { id: string }),
  })

  ctx.service({
    id: 'triggers-webhooks',
    start,
    stop,
    liveTasks,
    inUse() {
      return readDoc().webhooks.map((w) => ({
        kind: 'webhook_endpoint',
        id: w.id,
        label: `Webhook endpoint "${w.id}"`,
      }))
    },
  })

  return {
    createWebhook,
    updateWebhook,
    listWebhooks,
    deleteWebhook,
    getWebhook(id: string) {
      return readDoc().webhooks.find((w) => w.id === id)
    },
  }
}
