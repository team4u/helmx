/**
 * Fixed HTTP boundary protocol:
 * - Success: the entity or array is returned directly (no unified data wrapper).
 * - Failure: `{ error: { code, message, details? } }`.
 * Request/Response use the base lib's DOM types, with no dependency on node builtins.
 */

import type { ConversationOwnership, ConversationSummary } from './conversation.js'
import type { HelmxErrorDetail } from './error.js'

export interface ApiErrorBody {
  error: HelmxErrorDetail
}

/** `GET /api/auth/status`. */
export interface AuthStatus {
  configured: boolean
  authenticated: boolean
}

/** Success response of `POST /api/auth/setup` / `POST /api/auth/login`. */
export interface AuthToken {
  token: string
}

/** `GET /api/credentials` list item; the secret itself never leaves the server. */
export interface CredentialSummary {
  id: string
  configured: boolean
}

/** `POST /api/conversations/:id/fork` request body. */
export interface ConversationForkRequest {
  /** Fork anchor entry ID (a positive integer ordinal corresponding to ConversationEntry.id); defaults to the latest clean anchor when omitted. */
  entryId?: number
  title?: string
}

/** `POST /api/conversations/:id/compact` response. */
export interface ConversationCompactResponse {
  taskId: number
  conversation: ConversationSummary
}

/** `POST /api/conversations/:id/withdraw` request body. */
export interface ConversationWithdrawRequest {
  /** Queued submission ID to withdraw (positive integer). */
  submissionId: number
}

/** `POST /api/conversations/:id/withdraw` response. */
export interface ConversationWithdrawResponse {
  status: 'withdrawn' | 'already_placed' | 'settled'
  /** If the submission just entered execution or has settled and been assigned an entry ID, the corresponding entryId is returned. */
  entryId?: number
}

/** `POST /api/conversations/bulk-delete` request body. */
export interface ConversationBulkDeleteRequest {
  /**
   * Conversation ids to delete (positive safe integers, 1..1000 entries; deduplicated in first-seen order by the server).
   * Deleting a conversation cascades its derived child conversations (parentConversationId subtree, leaves first).
   */
  ids: number[]
}

/** Per-item failure entry of `POST /api/conversations/bulk-delete`. */
export interface ConversationBulkDeleteFailure {
  id: number
  /** Stable error code (e.g. `not_found`, `conversation_managed_by_plugin`). */
  code: string
  message: string
}

/**
 * `POST /api/conversations/bulk-delete` response: partial-success aggregation
 * (HTTP 200 whenever the request body is schema-valid; per-item outcomes live in `failures`).
 * An id already deleted earlier in the same batch (e.g. cascaded with its parent) counts as deleted.
 */
export interface ConversationBulkDeleteResponse {
  deleted: number[]
  failures: ConversationBulkDeleteFailure[]
}

/** Half-open UTF-16 highlight span `[start, end)` within `SearchHit.snippet`. */
export interface SearchHighlightRange {
  /** Inclusive UTF-16 start offset. */
  start: number
  /** Exclusive UTF-16 end offset (`end > start`). */
  end: number
}

/** Filter and pagination options for `GET /api/search` and `ctx.host.searchConversations`. */
export interface ConversationSearchOptions {
  /** Restrict hits to conversations bound to this Profile ID. */
  profileId?: string
  /** Restrict hits by conversation ownership (`'human' | 'helmx'`). */
  ownedBy?: ConversationOwnership
  /** When true, restrict hits to top-level conversations (`parentConversationId` is unset). */
  topLevelOnly?: boolean
  /** Maximum total hits returned (positive integer; HTTP boundary enforces `1..100`, default 20). */
  limit?: number
  /** Maximum hits returned from any single conversation (positive integer; default 2). */
  maxPerConversation?: number
}

/** Hit entry of `GET /api/search?q=...`. */
export interface SearchHit {
  conversationId: number
  /**
   * Locatable message entry reference (`entry:<id>` or `input:<requestId>`) when the query matched the entry body.
   * Omitted for title-only matches so clients perform conversation-level navigation instead of jumping to an unrelated message.
   */
  entryId?: string
  snippet: string
  title?: string
  /**
   * Sorted, non-overlapping UTF-16 `[start, end)` highlight spans inside `snippet` (plain text, zero HTML).
   * Always populated by the kernel search engine (`[]` when only `title` matched so clients do not fabricate snippet highlights);
   * may be omitted by minimal stubs.
   */
  highlights?: SearchHighlightRange[]
}

/** Single source of truth for static core CLI command paths (bidirectionally locked with @helmx/cli coreCommands() and the built-in skill SKILL.md). */
export const CORE_CLI_COMMAND_PATHS = [
  'setup',
  'login',
  'status',
  'doctor',
  'start',
  'stop',
  'restart',
  'service',
  'update',
  'events watch',
  'conversations list',
  'conversations get',
  'conversations entry',
  'conversations file',
  'conversations create',
  'conversations update',
  'conversations delete',
  'conversations reset',
  'conversations compact',
  'conversations fork',
  'conversations watch',
  'ask',
  'send',
  'conversations withdraw',
  'abort',
  'asks list',
  'asks answer',
  'asks cancel',
  'profiles list',
  'profiles get',
  'profiles create',
  'profiles update',
  'profiles delete',
  'providers list',
  'providers set',
  'credentials list',
  'credentials set',
  'credentials delete',
  'nodes list',
  'nodes issue',
  'nodes remove',
  'nodes upgrade',
  'nodes forward',
  'nodes forwards',
  'nodes forward-inspect',
  'nodes forward-stop',
  'env exec',
  'plugins list',
  'plugins manifest',
  'plugins enable',
  'plugins disable',
  'plugins config',
  'plugins doc',
  'plugins client',
  'plugins doctor',
  'plugins reload',
  'plugins rescan',
  'plugins init',
  'plugins types',
  'plugins build',
  'plugins install',
  'plugins update',
  'plugins remove',
  'actions list',
  'artifacts list',
  'artifacts put',
  'artifacts get',
  'skills list',
  'skills read',
  'models list',
  'models default',
  'models providers',
  'models refresh',
  'models filter',
  'search',
  'api',
] as const

export type CoreCliCommandPath = (typeof CORE_CLI_COMMAND_PATHS)[number]
