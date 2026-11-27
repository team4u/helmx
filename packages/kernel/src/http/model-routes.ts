/**
 * Model catalog domain routes driven by `MODEL_CORE_OPERATIONS`, `PROVIDER_CORE_OPERATIONS`,
 * and `CREDENTIAL_CORE_OPERATIONS` via `createCoreOperationRouter`:
 * /api/models (default/filter/refresh/providers/list), /api/providers, and /api/credentials
 * (only id/configured key, never plaintext). Hot-reloads the model catalog after
 * providers/credentials changes (persisting without reloading leaves hot config stale).
 */
import {
  CREDENTIAL_CORE_OPERATIONS,
  HelmxError,
  MODEL_CORE_OPERATIONS,
  PROVIDER_CORE_OPERATIONS,
  type ProviderConfig,
} from '@helmx/protocol'
import type { CredentialService, ProviderService } from '../services/index.js'
import {
  getModelDefaults,
  normalizeModelRefreshInput,
  updateModelDefaults,
  type ModelDefaultsPatch,
  type ModelRegistry,
} from '../runtime/model-registry.js'
import { createCoreOperationRouter } from './core-operation-router.js'
import { errorResponse, type JsonRedactor } from './http-utils.js'
import type { RouteContext } from './route-context.js'
import { parseCredentialBody, parseProvidersBody } from './validate.js'

export interface ModelRoutesTarget {
  readonly models: Pick<ModelRegistry, 'listModels' | 'listModelProviders'> &
    Partial<
      Pick<
        ModelRegistry,
        'setDefaultModel' | 'setModelThinkingDefault' | 'setDisabledModels' | 'refreshModels' | 'reloadModels'
      >
    >
  readonly providers: Pick<ProviderService, 'list' | 'save'>
  readonly credentials: Pick<CredentialService, 'list' | 'set' | 'delete'>
}

// ---------------------------------------------------------------------------
// /api/models
// ---------------------------------------------------------------------------

function dispatchModelsRoutes(
  kernel: Pick<ModelRoutesTarget, 'models'>,
): (ctx: RouteContext, redactor: JsonRedactor | undefined) => Promise<Response | undefined> {
  return createCoreOperationRouter(MODEL_CORE_OPERATIONS, {
    'models.list': () => kernel.models.listModels(),

    'models.providers': () => kernel.models.listModelProviders(),

    'models.refresh': (input) => {
      if (kernel.models.refreshModels === undefined) {
        throw new HelmxError(
          'not_implemented',
          'current runtime does not support refreshing dynamic model catalogs',
          501,
        )
      }
      const options = normalizeModelRefreshInput(
        input as { provider?: string; providers?: string[]; force?: boolean },
      )
      return kernel.models.refreshModels(options)
    },

    'models.default_get': () => getModelDefaults(kernel.models),

    'models.default': async (input) => {
      const defaults = await updateModelDefaults(kernel.models, input as ModelDefaultsPatch)
      return { ok: true, ...defaults }
    },

    'models.filter': async (input) => {
      if (kernel.models.setDisabledModels === undefined) {
        throw new HelmxError(
          'not_implemented',
          'current runtime does not support configuring disabled models',
          501,
        )
      }
      const catalog = await kernel.models.setDisabledModels(
        input.provider as string | undefined,
        input.disabledModels as string[],
      )
      return { ok: true, catalog }
    },
  })
}

export async function handleModelsDomain(
  ctx: RouteContext,
  kernel: Pick<ModelRoutesTarget, 'models'>,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const matched = await dispatchModelsRoutes(kernel)(ctx, redactor)
  if (matched !== undefined) return matched
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

// ---------------------------------------------------------------------------
// /api/providers
// ---------------------------------------------------------------------------

function dispatchProvidersRoutes(
  kernel: Pick<ModelRoutesTarget, 'models' | 'providers'>,
): (ctx: RouteContext, redactor: JsonRedactor | undefined) => Promise<Response | undefined> {
  return createCoreOperationRouter(PROVIDER_CORE_OPERATIONS, {
    'providers.list': () => kernel.providers.list(),

    'providers.set': {
      validate: (input) => ({ providers: parseProvidersBody(input) }),
      handle: async (input) => {
        const saved = await kernel.providers.save(input.providers as ProviderConfig[])
        await reloadModels(kernel)
        return saved
      },
    },
  })
}

export async function handleProvidersDomain(
  ctx: RouteContext,
  kernel: Pick<ModelRoutesTarget, 'models' | 'providers'>,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const matched = await dispatchProvidersRoutes(kernel)(ctx, redactor)
  if (matched !== undefined) return matched
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

// ---------------------------------------------------------------------------
// /api/credentials
// ---------------------------------------------------------------------------

function dispatchCredentialsRoutes(
  kernel: Pick<ModelRoutesTarget, 'models' | 'credentials'>,
): (ctx: RouteContext, redactor: JsonRedactor | undefined) => Promise<Response | undefined> {
  return createCoreOperationRouter(CREDENTIAL_CORE_OPERATIONS, {
    'credentials.list': async () => {
      const ids = await kernel.credentials.list()
      return ids.map((id) => ({ id, configured: true }))
    },

    'credentials.set': {
      validate: (_input, ctx) => ({
        id: ctx.path.id as string,
        value: parseCredentialBody(ctx.body),
      }),
      handle: async (input) => {
        await kernel.credentials.set(input.id as string, input.value as string)
        await reloadModels(kernel)
        return { ok: true }
      },
    },

    'credentials.delete': async (input) => {
      await kernel.credentials.delete(input.id as string)
      await reloadModels(kernel)
      return { ok: true }
    },
  })
}

export async function handleCredentialsDomain(
  ctx: RouteContext,
  kernel: Pick<ModelRoutesTarget, 'models' | 'credentials'>,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const matched = await dispatchCredentialsRoutes(kernel)(ctx, redactor)
  if (matched !== undefined) return matched
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Hot-reload model catalog after providers/credentials change; skipped if runtime omits the port. */
async function reloadModels(kernel: Pick<ModelRoutesTarget, 'models'>): Promise<void> {
  await kernel.models.reloadModels?.()
}
