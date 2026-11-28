/**
 * Omnibox domain route: `GET /api/omnibox/search?q=<query>&limit=<n>&locale=<loc>&conversationId=<id>`.
 *
 * Driven by `@helmx/protocol` `OMNIBOX_CORE_OPERATIONS` via `createCoreOperationRouter`;
 * composes `ConversationService.search` and active `helmx.search` plugin capability providers
 * without coupling `ConversationService` to `PluginHost`.
 */
import {
  HelmxError,
  OMNIBOX_CORE_OPERATIONS,
  type HelmxLocale,
} from '@helmx/protocol'
import type { PluginHost } from '../plugins/index.js'
import type { ConversationService } from '../runtime/conversation-service.js'
import { parseSearchTerms } from '../runtime/fts-search.js'
import { runOmniboxSearch } from '../runtime/omnibox-search.js'
import type { SecretStash } from '../services/index.js'
import { createCoreOperationRouter } from './core-operation-router.js'
import { errorResponse, type JsonRedactor } from './http-utils.js'
import type { RouteContext } from './route-context.js'

export interface OmniboxRoutesTarget {
  readonly conversations: Pick<ConversationService, 'search'>
  readonly plugins: Partial<Pick<PluginHost, 'consumeCapability'>>
  readonly stash?: Pick<SecretStash, 'redact'>
}

function dispatchOmniboxJsonRoutes(
  kernel: OmniboxRoutesTarget,
): (ctx: RouteContext, redactor: JsonRedactor | undefined) => Promise<Response | undefined> {
  return createCoreOperationRouter(OMNIBOX_CORE_OPERATIONS, {
    'omnibox.search': {
      validate: (input) => {
        const q = input.q as string
        if (parseSearchTerms(q).terms.length === 0) {
          throw new HelmxError('validation_error', 'q cannot be empty', 400)
        }
      },
      handle: (input, { route, redactor }) => {
        const consumeCapability = kernel.plugins.consumeCapability
        if (consumeCapability === undefined) {
          return errorResponse(
            redactor,
            501,
            'not_supported',
            'Current kernel does not support Omnibox capability search',
          )
        }
        return runOmniboxSearch(
          {
            conversations: kernel.conversations,
            plugins: { consumeCapability: consumeCapability.bind(kernel.plugins) },
          },
          {
            q: input.q as string,
            ...(input.limit !== undefined ? { limit: input.limit as number } : {}),
            ...(input.locale !== undefined ? { locale: input.locale as HelmxLocale } : {}),
            ...(input.conversationId !== undefined ? { conversationId: input.conversationId as number } : {}),
          },
          {
            signal: route.request.signal,
            ...(kernel.stash !== undefined ? { redact: (text) => kernel.stash!.redact(text) } : {}),
          },
        )
      },
    },
  })
}

export async function handleOmniboxDomain(
  ctx: RouteContext,
  kernel: OmniboxRoutesTarget,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const matched = await dispatchOmniboxJsonRoutes(kernel)(ctx, redactor)
  if (matched !== undefined) return matched
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}
