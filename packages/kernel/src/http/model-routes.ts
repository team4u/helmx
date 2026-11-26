/**
 * Model catalog domain routes: /api/models (default/filter/refresh/providers/list),
 * /api/providers (PUT `{ providers }` body), /api/credentials
 * (only id/configured key, never plaintext). Hot-reloads the model catalog after
 * providers/credentials changes (persisting without reloading leaves hot config stale).
 */
import { HelmxError, REQUEST_SCHEMAS } from '@helmx/protocol'
import type { CredentialService, ProviderService } from '../services/index.js'
import {
  getModelDefaults,
  normalizeModelRefreshInput,
  updateModelDefaults,
  type ModelDefaultsPatch,
  type ModelRegistry,
} from '../runtime/model-registry.js'
import { errorResponse, jsonOk, readJsonBody, type JsonRedactor } from './http-utils.js'
import { assertBodySchema, parseCredentialBody, parseProvidersBody, requireIdParam } from './validate.js'
import { methodNotAllowed, readOptionalJsonBody, type RouteContext } from './route-context.js'

export interface ModelRoutesTarget {
  readonly models: Pick<ModelRegistry, 'listModels' | 'listModelProviders'> &
    Partial<Pick<ModelRegistry, 'setDefaultModel' | 'setModelThinkingDefault' | 'setDisabledModels' | 'refreshModels' | 'reloadModels'>>
  readonly providers: Pick<ProviderService, 'list' | 'save'>
  readonly credentials: Pick<CredentialService, 'list' | 'set' | 'delete'>
}

// ---------------------------------------------------------------------------
// /api/models
// ---------------------------------------------------------------------------

export async function handleModelsDomain(
  ctx: RouteContext,
  kernel: Pick<ModelRoutesTarget, 'models'>,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
  if (second === 'default' && third === undefined && method === 'GET') {
    return jsonOk(redactor, await getModelDefaults(kernel.models))
  }
  if (second === 'default' && third === undefined && method === 'PUT') {
    const raw = await readOptionalJsonBody(ctx.request)
    assertBodySchema(REQUEST_SCHEMAS.modelsDefaultPut, raw ?? {}, 'models default body')
    const defaults = await updateModelDefaults(kernel.models, (raw ?? {}) as ModelDefaultsPatch)
    return jsonOk(redactor, { ok: true, ...defaults })
  }
  if (second === 'filter' && third === undefined && method === 'PUT') {
    if (kernel.models.setDisabledModels === undefined) {
      throw new HelmxError('not_implemented', 'current runtime does not support configuring disabled models', 501)
    }
    // Both empty body and {} validate against `{ provider?: string; disabledModels: string[] }`.
    const raw = await readOptionalJsonBody(ctx.request)
    assertBodySchema(REQUEST_SCHEMAS.modelsFilterPut, raw ?? {}, 'models filter body')
    const body = (raw ?? {}) as Record<string, unknown>
    const catalog = await kernel.models.setDisabledModels(
      body.provider as string | undefined,
      body.disabledModels as string[],
    )
    return jsonOk(redactor, { ok: true, catalog })
  }
  if (second === 'refresh' && third === undefined && method === 'POST') {
    // Empty body and {} are valid (refresh all); provider (single), providers (list), and force are optional.
    const raw = await readOptionalJsonBody(ctx.request)
    assertBodySchema(REQUEST_SCHEMAS.modelsRefresh, raw ?? {}, 'models refresh body')
    const options = normalizeModelRefreshInput(
      (raw ?? {}) as { provider?: string; providers?: string[]; force?: boolean },
    )
    if (kernel.models.refreshModels === undefined) {
      throw new HelmxError('not_implemented', 'current runtime does not support refreshing dynamic model catalogs', 501)
    }
    const result = await kernel.models.refreshModels(options)
    return jsonOk(redactor, result)
  }
  if (second === 'providers' && third === undefined && method === 'GET') {
    return jsonOk(redactor, kernel.models.listModelProviders())
  }
  if (second === undefined && method === 'GET') {
    return jsonOk(redactor, await kernel.models.listModels())
  }
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

// ---------------------------------------------------------------------------
// /api/providers
// ---------------------------------------------------------------------------

export async function handleProvidersDomain(
  ctx: RouteContext,
  kernel: Pick<ModelRoutesTarget, 'models' | 'providers'>,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  if (segments[1] !== undefined) {
    return errorResponse(redactor, 404, 'not_found', 'route not found')
  }
  if (method === 'GET') return jsonOk(redactor, await kernel.providers.list())
  if (method === 'PUT') {
    const body = await readJsonBody(ctx.request)
    const providers = parseProvidersBody(body)
    const saved = await kernel.providers.save(providers)
    await reloadModels(kernel)
    return jsonOk(redactor, saved)
  }
  return methodNotAllowed(redactor, method)
}

// ---------------------------------------------------------------------------
// /api/credentials
// ---------------------------------------------------------------------------

export async function handleCredentialsDomain(
  ctx: RouteContext,
  kernel: Pick<ModelRoutesTarget, 'models' | 'credentials'>,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
  if (second === undefined && method === 'GET') {
    const ids = await kernel.credentials.list()
    return jsonOk(redactor, ids.map((id) => ({ id, configured: true })))
  }
  const credId = requireIdParam(second ?? '', 'credentialId')
  if (third === undefined && method === 'PUT') {
    const body = await readJsonBody(ctx.request)
    await kernel.credentials.set(credId, parseCredentialBody(body))
    await reloadModels(kernel)
    return jsonOk(redactor, { ok: true })
  }
  if (third === undefined && method === 'DELETE') {
    await kernel.credentials.delete(credId)
    await reloadModels(kernel)
    return jsonOk(redactor, { ok: true })
  }
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Hot-reload model catalog after providers/credentials change; skipped if runtime omits the port. */
async function reloadModels(kernel: Pick<ModelRoutesTarget, 'models'>): Promise<void> {
  await kernel.models.reloadModels?.()
}
