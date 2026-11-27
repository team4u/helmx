/**
 * Conversation domain routes: /api/conversations (list/create/detail/update/delete/input/
 * withdraw/abort/reset/compact/fork/entries/:entryId/artifacts/bulk-delete), /api/asks
 * (approval queue), and /api/search (full-text index search).
 *
 * JSON endpoints are compiled from `@helmx/protocol` `CONVERSATION_CORE_OPERATIONS` /
 * `ASK_CORE_OPERATIONS` via `createCoreOperationRouter`; binary/streaming workspace file reads
 * (`GET /:id/files/content`) and artifact uploads (`POST /:id/artifacts`) stay outside
 * `CORE_OPERATIONS`.
 */
import {
  ASK_CORE_OPERATIONS,
  CONVERSATION_CORE_OPERATIONS,
  HelmxError,
  type AskStatus,
  type ConversationOwnership,
  type ConversationSearchOptions,
} from '@helmx/protocol'
import type { ArtifactService } from '../services/index.js'
import type { AskService } from '../runtime/asks.js'
import type { ConversationService } from '../runtime/conversation-service.js'
import {
  normalizeConversationListFilter,
  normalizeConversationSearchInput,
} from '../runtime/guards/conversation-guards.js'
import { coreOperationResponse, createCoreOperationRouter } from './core-operation-router.js'
import { buildContentDisposition, errorResponse, type JsonRedactor } from './http-utils.js'
import {
  parseAskAnswerBody,
  parseConversationCompactBody,
  parseConversationForkBody,
  parseConversationInit,
  parseConversationPatch,
  parseConversationResetBody,
  parseConversationWithdrawBody,
  parseIdParam,
  parseInputBody,
  ValidationError,
} from './validate.js'
import { methodNotAllowed, parseOptionalBooleanFlag, type RouteContext } from './route-context.js'
import { postConversationArtifact } from './asset-routes.js'

export interface ConversationRoutesTarget {
  readonly conversations: Pick<
    ConversationService,
    | 'listConversations'
    | 'createConversation'
    | 'deleteConversations'
    | 'getConversationDetail'
    | 'updateConversation'
    | 'deleteConversation'
    | 'submitInput'
    | 'waitForInput'
    | 'abortConversation'
    | 'resetConversation'
    | 'compactConversation'
    | 'forkConversation'
    | 'search'
  > &
    Partial<Pick<ConversationService, 'getConversationEntry' | 'withdrawQueuedInput' | 'readConversationFile'>>
  readonly artifacts: Pick<ArtifactService, 'list' | 'writeUploaded'>
  readonly asks: Pick<AskService, 'listAsks' | 'answerAsk' | 'cancelAsk'>
}

type SearchOperation = Extract<(typeof CONVERSATION_CORE_OPERATIONS)[number], { key: 'conversations.search' }>
type ConversationPathOperation = Exclude<(typeof CONVERSATION_CORE_OPERATIONS)[number], SearchOperation>

const CONVERSATION_PATH_OPERATIONS: readonly ConversationPathOperation[] =
  CONVERSATION_CORE_OPERATIONS.filter((op): op is ConversationPathOperation => op.key !== 'conversations.search')

const SEARCH_OPERATIONS: readonly SearchOperation[] =
  CONVERSATION_CORE_OPERATIONS.filter((op): op is SearchOperation => op.key === 'conversations.search')

function dispatchConversationJsonRoutes(
  kernel: Pick<ConversationRoutesTarget, 'conversations' | 'artifacts'>,
): (ctx: RouteContext, redactor: JsonRedactor | undefined) => Promise<Response | undefined> {
  return createCoreOperationRouter(CONVERSATION_PATH_OPERATIONS, {
    'conversations.list': (input) =>
      kernel.conversations.listConversations(normalizeConversationListFilter(input)),

    'conversations.create': (_input, ctx) =>
      kernel.conversations.createConversation(parseConversationInit(ctx.body)),

    'conversations.bulk_delete': (input) =>
      kernel.conversations.deleteConversations(input.ids as number[]),

    'conversations.get': (input) => {
      const opts: { limit?: number; turns?: number; cursor?: string } = {}
      if (input.limit !== undefined) opts.limit = input.limit as number
      if (input.turns !== undefined) opts.turns = input.turns as number
      if (input.cursor !== undefined) opts.cursor = input.cursor as string
      return kernel.conversations.getConversationDetail(input.conversationId as number, opts)
    },

    'conversations.update': (input, ctx) =>
      kernel.conversations.updateConversation(
        input.conversationId as number,
        parseConversationPatch(ctx.body),
      ),

    'conversations.delete': async (input) => {
      await kernel.conversations.deleteConversation(input.conversationId as number)
      return { ok: true }
    },

    'conversations.entry': (input) => {
      if (kernel.conversations.getConversationEntry === undefined) {
        throw new HelmxError('not_implemented', 'current runtime does not support reading a single entry', 501)
      }
      return kernel.conversations.getConversationEntry(
        input.conversationId as number,
        input.entryId as number,
      )
    },

    'conversations.send': {
      validate: (_input, ctx) => {
        // Strict ?wait=1|true policy: reject '0'/'false'/any other value with 400 (unlike general boolean flags).
        const rawWait = ctx.route.url.searchParams.get('wait')
        if (rawWait !== null && rawWait !== '1' && rawWait !== 'true') {
          throw new ValidationError('wait must be 1 (e.g. ?wait=1)')
        }
      },
      handle: async (input, ctx) => {
        const id = input.conversationId as number
        const wait = input.wait === true
        const { text, whenBusy, whenPendingAsk, origin, meta, attachments, replaceFromEntryId } =
          parseInputBody(ctx.body)
        const { submissionId } = await kernel.conversations.submitInput(id, text, {
          ...(origin !== undefined ? { origin } : {}),
          ...(whenBusy !== undefined ? { whenBusy } : {}),
          ...(whenPendingAsk !== undefined ? { whenPendingAsk } : {}),
          ...(meta !== undefined ? { meta } : {}),
          ...(attachments !== undefined ? { attachments } : {}),
          ...(replaceFromEntryId !== undefined ? { replaceFromEntryId } : {}),
        })
        if (!wait) return coreOperationResponse({ status: 202, body: { submissionId } })
        return coreOperationResponse({
          status: 200,
          body: await kernel.conversations.waitForInput(id, submissionId, ctx.route.request.signal),
        })
      },
    },

    'conversations.withdraw': (input, ctx) => {
      if (kernel.conversations.withdrawQueuedInput === undefined) {
        throw new HelmxError(
          'not_implemented',
          'current runtime does not support withdrawing queued input',
          501,
        )
      }
      return kernel.conversations.withdrawQueuedInput(
        input.conversationId as number,
        parseConversationWithdrawBody(ctx.body),
      )
    },

    'conversations.abort': async (input) => {
      await kernel.conversations.abortConversation(input.conversationId as number)
      return { ok: true }
    },

    'conversations.reset': (input, ctx) =>
      kernel.conversations.resetConversation(
        input.conversationId as number,
        parseConversationResetBody(ctx.body),
      ),

    'conversations.compact': (input, ctx) =>
      kernel.conversations.compactConversation(
        input.conversationId as number,
        parseConversationCompactBody(ctx.body),
      ),

    'conversations.fork': (input, ctx) =>
      kernel.conversations.forkConversation(
        input.conversationId as number,
        parseConversationForkBody(ctx.body),
      ),

    'conversations.artifacts_list': (input) =>
      kernel.artifacts.list(input.conversationId as number),
  })
}

export async function handleConversationsDomain(
  ctx: RouteContext,
  kernel: Pick<ConversationRoutesTarget, 'conversations' | 'artifacts'>,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
  const fourth = segments[3]

  // Binary/streaming routes outside CORE_OPERATIONS:
  if (second !== undefined && third === 'artifacts' && fourth === undefined && method === 'POST') {
    const id = parseIdParam(second)
    return postConversationArtifact(ctx, kernel, id, redactor)
  }
  if (second !== undefined && third === 'files' && fourth === 'content' && ctx.segments[4] === undefined) {
    if (method !== 'GET') return methodNotAllowed(redactor, method)
    const id = parseIdParam(second)
    const rawPath = ctx.url.searchParams.get('path')
    if (rawPath === null || rawPath.trim() === '') {
      throw new ValidationError('path query parameter cannot be empty')
    }
    const inline = parseOptionalBooleanFlag(ctx.url, 'inline') === true
    if (kernel.conversations.readConversationFile === undefined) {
      throw new HelmxError('not_implemented', 'current runtime does not support reading conversation workspace files', 501)
    }
    const result = await kernel.conversations.readConversationFile(id, rawPath, ctx.request.signal)
    const headers: Record<string, string> = {
      'content-type': result.mimeType,
      'content-length': String(result.bytes.byteLength),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-disposition': buildContentDisposition(result.name, inline),
    }
    if (inline && (result.mimeType.startsWith('text/html') || result.mimeType.startsWith('image/svg+xml'))) {
      headers['content-security-policy'] = 'sandbox'
    }
    return new Response(result.bytes as unknown as BodyInit, { headers })
  }

  const matched = await dispatchConversationJsonRoutes(kernel)(ctx, redactor)
  if (matched !== undefined) return matched

  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

// ---------------------------------------------------------------------------
// /api/asks (approval queue, belongs to conversation domain alongside conversations)
// ---------------------------------------------------------------------------

function dispatchAsksJsonRoutes(
  kernel: Pick<ConversationRoutesTarget, 'asks'>,
): (ctx: RouteContext, redactor: JsonRedactor | undefined) => Promise<Response | undefined> {
  return createCoreOperationRouter(ASK_CORE_OPERATIONS, {
    'asks.list': (input) => {
      const conversationId = input.conversationId as number | undefined
      const status = input.status as AskStatus | undefined
      if (conversationId === undefined && status === undefined) {
        return kernel.asks.listAsks()
      }
      return kernel.asks.listAsks({
        ...(conversationId !== undefined ? { conversationId } : {}),
        ...(status !== undefined ? { status } : {}),
      })
    },

    'asks.answer': async (input, ctx) => {
      const { answers, expectedStateSeq } = parseAskAnswerBody(ctx.body)
      await kernel.asks.answerAsk(input.id as string, answers, expectedStateSeq)
      return { ok: true }
    },

    'asks.cancel': async (input) => {
      await kernel.asks.cancelAsk(input.id as string)
      return { ok: true }
    },
  })
}

export async function handleAsksDomain(
  ctx: RouteContext,
  kernel: Pick<ConversationRoutesTarget, 'asks'>,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const matched = await dispatchAsksJsonRoutes(kernel)(ctx, redactor)
  if (matched !== undefined) return matched
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

// ---------------------------------------------------------------------------
// /api/search
// ---------------------------------------------------------------------------

function dispatchSearchJsonRoutes(
  kernel: { readonly conversations: Pick<ConversationService, 'search'> },
): (ctx: RouteContext, redactor: JsonRedactor | undefined) => Promise<Response | undefined> {
  return createCoreOperationRouter(SEARCH_OPERATIONS, {
    'conversations.search': (input) => {
      const rawOptions: ConversationSearchOptions = {
        ...(input.profileId !== undefined ? { profileId: input.profileId as string } : {}),
        ...(input.ownedBy !== undefined ? { ownedBy: input.ownedBy as ConversationOwnership } : {}),
        ...(input.topLevelOnly !== undefined ? { topLevelOnly: input.topLevelOnly as boolean } : {}),
        ...(input.limit !== undefined ? { limit: input.limit as number } : {}),
        ...(input.maxPerConversation !== undefined
          ? { maxPerConversation: input.maxPerConversation as number }
          : {}),
      }
      const { query, options } = normalizeConversationSearchInput(
        input.q,
        Object.keys(rawOptions).length > 0 ? rawOptions : undefined,
      )
      return options !== undefined
        ? kernel.conversations.search(query, options)
        : kernel.conversations.search(query)
    },
  })
}

export async function handleSearchDomain(
  ctx: RouteContext,
  kernel: { readonly conversations: Pick<ConversationService, 'search'> },
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const matched = await dispatchSearchJsonRoutes(kernel)(ctx, redactor)
  if (matched !== undefined) return matched
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}
