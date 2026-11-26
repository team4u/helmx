/**
 * Conversation domain routes: /api/conversations (list/create/detail/update/delete/input/
 * withdraw/abort/reset/compact/fork/entries/:entryId/artifacts/bulk-delete), /api/asks
 * (approval queue), and /api/search (full-text index search).
 */
import type {
  AskStatus,
  ConversationListFilter,
  ConversationOwnership,
  ConversationSearchOptions,
} from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import type { ArtifactService } from '../services/index.js'
import type { AskService } from '../runtime/asks.js'
import type { ConversationService } from '../runtime/conversation-service.js'
import {
  normalizeConversationListFilter,
  normalizeConversationSearchInput,
} from '../runtime/guards/conversation-guards.js'
import { buildContentDisposition, errorResponse, jsonOk, readJsonBody, type JsonRedactor } from './http-utils.js'
import {
  parseAskAnswerBody,
  parseConversationBulkDeleteBody,
  parseConversationCompactBody,
  parseConversationForkBody,
  parseConversationInit,
  parseConversationPatch,
  parseConversationResetBody,
  parseConversationWithdrawBody,
  parseDetailPagination,
  parseIdParam,
  parseInputBody,
  requireIdParam,
  ValidationError,
} from './validate.js'
import { methodNotAllowed, parseOptionalBooleanFlag, parseOptionalJsonObjectBody, type RouteContext } from './route-context.js'
import { postConversationArtifact } from './asset-routes.js'
import { MAX_SEARCH_LIMIT, MAX_SEARCH_PER_CONVERSATION } from '../runtime/fts-search.js'

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

export async function handleConversationsDomain(
  ctx: RouteContext,
  kernel: Pick<ConversationRoutesTarget, 'conversations' | 'artifacts'>,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
  const fourth = segments[3]

  if (second === undefined) {
    if (method === 'GET') {
      return jsonOk(redactor, kernel.conversations.listConversations(parseConversationFilter(ctx.url)))
    }
    if (method === 'POST') {
      const body = await readJsonBody(ctx.request)
      return jsonOk(redactor, await kernel.conversations.createConversation(parseConversationInit(body)), { status: 201 })
    }
    return methodNotAllowed(redactor, method)
  }
  // ---- Bulk delete: POST /api/conversations/bulk-delete (matched before :id parsing; the literal is not a positive integer) ----
  if (second === 'bulk-delete') {
    if (third !== undefined) return errorResponse(redactor, 404, 'not_found', 'route not found')
    if (method !== 'POST') return methodNotAllowed(redactor, method)
    const body = await readJsonBody(ctx.request)
    const { ids } = parseConversationBulkDeleteBody(body)
    return jsonOk(redactor, await kernel.conversations.deleteConversations(ids))
  }
  const id = parseIdParam(second)
  if (third === undefined) {
    if (method === 'GET') {
      return jsonOk(redactor, await kernel.conversations.getConversationDetail(id, parseDetailPagination(ctx.url)))
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(ctx.request)
      return jsonOk(redactor, await kernel.conversations.updateConversation(id, parseConversationPatch(body)))
    }
    if (method === 'DELETE') {
      await kernel.conversations.deleteConversation(id)
      return jsonOk(redactor, { ok: true })
    }
    return methodNotAllowed(redactor, method)
  }
  if (third === 'entries' && method === 'GET' && fourth !== undefined && ctx.segments[4] === undefined) {
    if (kernel.conversations.getConversationEntry === undefined) {
      throw new HelmxError('not_implemented', 'current runtime does not support reading a single entry', 501)
    }
    return jsonOk(redactor, await kernel.conversations.getConversationEntry(id, parseIdParam(fourth, 'entryId')))
  }
  if (third === 'input' && method === 'POST' && fourth === undefined) {
    const body = await readJsonBody(ctx.request)
    const { text, whenBusy, whenPendingAsk, origin, meta, attachments, replaceFromEntryId } = parseInputBody(body)
    const wait = parseWaitFlag(ctx.url)
    const { submissionId } = await kernel.conversations.submitInput(id, text, {
      ...(origin !== undefined ? { origin } : {}),
      ...(whenBusy !== undefined ? { whenBusy } : {}),
      ...(whenPendingAsk !== undefined ? { whenPendingAsk } : {}),
      ...(meta !== undefined ? { meta } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
      ...(replaceFromEntryId !== undefined ? { replaceFromEntryId } : {}),
    })
    if (!wait) return jsonOk(redactor, { submissionId }, { status: 202 })
    return jsonOk(redactor, await kernel.conversations.waitForInput(id, submissionId, ctx.request.signal))
  }
  if (third === 'withdraw' && method === 'POST' && fourth === undefined) {
    if (kernel.conversations.withdrawQueuedInput === undefined) {
      throw new HelmxError('not_implemented', 'current runtime does not support withdrawing queued input', 501)
    }
    const body = await readJsonBody(ctx.request)
    const parsed = parseConversationWithdrawBody(body)
    return jsonOk(redactor, await kernel.conversations.withdrawQueuedInput(id, parsed))
  }
  if (third === 'abort' && method === 'POST' && fourth === undefined) {
    await kernel.conversations.abortConversation(id)
    return jsonOk(redactor, { ok: true })
  }
  if (third === 'reset' && method === 'POST' && fourth === undefined) {
    const opts = await parseOptionalJsonObjectBody(ctx.request, parseConversationResetBody)
    return jsonOk(redactor, await kernel.conversations.resetConversation(id, opts))
  }
  if (third === 'compact' && method === 'POST' && fourth === undefined) {
    const opts = await parseOptionalJsonObjectBody(ctx.request, parseConversationCompactBody)
    return jsonOk(redactor, await kernel.conversations.compactConversation(id, opts), { status: 202 })
  }
  if (third === 'fork' && method === 'POST' && fourth === undefined) {
    const opts = await parseOptionalJsonObjectBody(ctx.request, parseConversationForkBody)
    return jsonOk(redactor, await kernel.conversations.forkConversation(id, opts), { status: 201 })
  }
  if (third === 'artifacts' && method === 'GET' && fourth === undefined) {
    return jsonOk(redactor, await kernel.artifacts.list(id))
  }
  if (third === 'artifacts' && method === 'POST' && fourth === undefined) {
    return postConversationArtifact(ctx, kernel, id, redactor)
  }
  if (third === 'files' && fourth === 'content' && ctx.segments[4] === undefined) {
    if (method !== 'GET') return methodNotAllowed(redactor, method)
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
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

// ---------------------------------------------------------------------------
// /api/asks (approval queue, belongs to conversation domain alongside conversations)
// ---------------------------------------------------------------------------

const VALID_ASK_STATUSES = new Set<string>(['pending', 'answered', 'cancelled', 'superseded'])

export async function handleAsksDomain(
  ctx: RouteContext,
  kernel: Pick<ConversationRoutesTarget, 'asks'>,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
  const fourth = segments[3]
  if (second === undefined && method === 'GET') {
    const conversationId = parseOptionalStrictQueryInt(
      ctx.url,
      'conversationId',
      'conversationId must be a positive integer',
    )
    if (conversationId !== undefined && (!Number.isSafeInteger(conversationId) || conversationId < 1)) {
      throw new ValidationError('conversationId must be a positive integer')
    }
    const statusRaw = ctx.url.searchParams.get('status')
    if (statusRaw !== null && !VALID_ASK_STATUSES.has(statusRaw)) {
      throw new ValidationError('status must be pending|answered|cancelled|superseded')
    }
    const status = statusRaw === null ? undefined : (statusRaw as AskStatus)
    if (conversationId === undefined && status === undefined) {
      return jsonOk(redactor, kernel.asks.listAsks())
    }
    return jsonOk(
      redactor,
      kernel.asks.listAsks({
        ...(conversationId !== undefined ? { conversationId } : {}),
        ...(status !== undefined ? { status } : {}),
      }),
    )
  }
  const askId = requireIdParam(second ?? '', 'askId')
  if (third === 'answer' && method === 'POST' && fourth === undefined) {
    const body = await readJsonBody(ctx.request)
    const { answers, expectedStateSeq } = parseAskAnswerBody(body)
    await kernel.asks.answerAsk(askId, answers, expectedStateSeq)
    return jsonOk(redactor, { ok: true })
  }
  if (third === 'cancel' && method === 'POST' && fourth === undefined) {
    await kernel.asks.cancelAsk(askId)
    return jsonOk(redactor, { ok: true })
  }
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

// ---------------------------------------------------------------------------
// /api/search
// ---------------------------------------------------------------------------

export async function handleSearchDomain(
  ctx: RouteContext,
  kernel: { readonly conversations: Pick<ConversationService, 'search'> },
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  if (ctx.method !== 'GET' || ctx.segments[1] !== undefined) {
    return errorResponse(redactor, 404, 'not_found', 'route not found')
  }
  const q = ctx.url.searchParams.get('q') ?? ''
  const rawOptions = parseSearchQueryOptions(ctx.url)
  const { query, options } = normalizeConversationSearchInput(q, rawOptions)
  return jsonOk(
    redactor,
    options !== undefined
      ? await kernel.conversations.search(query, options)
      : await kernel.conversations.search(query),
  )
}

function parseOptionalStrictQueryInt(url: URL, name: string, rangeMessage: string): number | undefined {
  const raw = url.searchParams.get(name)
  if (raw === null) return undefined
  if (!/^\d+$/.test(raw)) {
    throw new ValidationError(rangeMessage)
  }
  return Number(raw)
}

function parseSearchQueryOptions(url: URL): ConversationSearchOptions | undefined {
  const profileId = url.searchParams.get('profileId') ?? undefined
  const ownedBy = (url.searchParams.get('ownedBy') ?? undefined) as ConversationOwnership | undefined
  const topLevelOnly = parseOptionalBooleanFlag(url, 'topLevelOnly')
  const limit = parseOptionalStrictQueryInt(
    url,
    'limit',
    `limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}`,
  )
  const maxPerConversation = parseOptionalStrictQueryInt(
    url,
    'maxPerConversation',
    `maxPerConversation must be an integer between 1 and ${MAX_SEARCH_PER_CONVERSATION}`,
  )
  if (
    profileId === undefined &&
    ownedBy === undefined &&
    topLevelOnly === undefined &&
    limit === undefined &&
    maxPerConversation === undefined
  ) {
    return undefined
  }
  return {
    ...(profileId !== undefined ? { profileId } : {}),
    ...(ownedBy !== undefined ? { ownedBy } : {}),
    ...(topLevelOnly !== undefined ? { topLevelOnly } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(maxPerConversation !== undefined ? { maxPerConversation } : {}),
  }
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

function parseConversationFilter(url: URL): ConversationListFilter {
  const profileId = url.searchParams.get('profileId') ?? undefined
  const tag = url.searchParams.get('tag') ?? undefined
  const status = url.searchParams.get('status') ?? undefined
  const ownedBy = url.searchParams.get('ownedBy') ?? undefined
  const all = parseOptionalBooleanFlag(url, 'all')
  const parentConversationId = parseOptionalStrictQueryInt(
    url,
    'parent',
    'parent must be a positive integer conversation ID',
  )
  return normalizeConversationListFilter({
    ...(profileId !== undefined ? { profileId } : {}),
    ...(tag !== undefined ? { tag } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(ownedBy !== undefined ? { ownedBy } : {}),
    ...(parentConversationId !== undefined ? { parentConversationId } : {}),
    ...(all !== undefined ? { all } : {}),
  })
}

/** ?wait=1 query parameter: only accepts '1' (or 'true'); any other value fails with 400. */
function parseWaitFlag(url: URL): boolean {
  const raw = url.searchParams.get('wait')
  if (raw === null) return false
  if (raw === '1' || raw === 'true') return true
  throw new ValidationError('wait must be 1 (e.g. ?wait=1)')
}
