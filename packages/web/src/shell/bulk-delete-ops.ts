/**
 * Human-initiated bulk conversation delete (pure logic + the single
 * `POST /api/conversations/bulk-delete` channel, zero React):
 *
 * - One request for the whole selection: the server deduplicates, cascades
 *   derived child conversations, and reports per-item failures
 *   (`conversation_managed_by_plugin` etc.) in `failures` — partial failures
 *   never mask successes and are never silently swallowed;
 * - The list/UI updates purely via the existing per-conversation
 *   `conversation.deleted` SSE events (single source of truth; the Provider
 *   conditionally falls back by current targets), so this helper performs no
 *   navigation;
 * - Callers pass the id snapshot taken at confirmation time; an id deleted by
 *   another surface in between simply reports `not_found` in `failures`.
 */
import type { ConversationBulkDeleteResponse } from '@helmx/protocol/browser'
import { conversationsApi } from '../lib/api.js'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'

/** Bulk delete outcome: per-item counts + the first error summary (for notice copy). */
export interface BulkDeleteOutcome {
  attempted: number
  deleted: number
  failed: number
  firstError?: string
}

/** Bulk delete via the single bulk endpoint; transport-level failures propagate for the caller to notice. */
export async function bulkDeleteConversations(ids: readonly number[]): Promise<BulkDeleteOutcome> {
  const response: ConversationBulkDeleteResponse = await conversationsApi.bulkRemove(ids)
  const first = response.failures[0]
  return {
    attempted: ids.length,
    deleted: response.deleted.length,
    failed: response.failures.length,
    firstError: first !== undefined ? `${first.code}: ${first.message}` : undefined,
  }
}

export type BulkDeleteNotice = {
  type: 'notification'
  level: 'info' | 'warning' | 'error'
  title: string
  body: string
}

/** Bulk delete outcome → notice (success / partial / total failure, with the first error summary). */
export function bulkDeleteNotice(
  outcome: BulkDeleteOutcome,
  t: WebMessageTranslator = englishWebTranslator,
): BulkDeleteNotice {
  if (outcome.failed === 0) {
    return {
      type: 'notification',
      level: 'info',
      title: t('shell.batch.bulkDeleteCompleted'),
      body: t('shell.batch.bulkDeleteCompletedBody', { count: outcome.deleted }),
    }
  }
  const suffix = outcome.firstError !== undefined ? ` (${outcome.firstError})` : ''
  if (outcome.deleted === 0) {
    return {
      type: 'notification',
      level: 'error',
      title: t('shell.batch.bulkDeleteFailed'),
      body: t('shell.batch.bulkDeleteFailedBody', { count: outcome.failed }) + suffix,
    }
  }
  return {
    type: 'notification',
    level: 'warning',
    title: t('shell.batch.bulkDeletePartial'),
    body: t('shell.batch.bulkDeletePartialBody', { fulfilled: outcome.deleted, rejected: outcome.failed }) + suffix,
  }
}
