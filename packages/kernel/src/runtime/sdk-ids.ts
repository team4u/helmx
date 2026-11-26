/**
 * Typed adapter boundary for `@earendil-works/pi-durable` branded IDs, cursors, views, and queries.
 *
 * The durable SDK distinguishes primary keys via nominal branded types (`ConversationId`, `EntryId`,
 * `SubmissionId`, `TaskId`) and represents pagination cursors via `Cursor`; external protocol and
 * store layers pass plain primitives. Concentrating narrowing and validation here eliminates
 * scattered `as never` / `as unknown as` casts across runtime modules.
 */
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type {
  Conversation,
  ConversationId,
  ConversationRecord,
  ConversationView,
  Cursor,
  EntryId,
  EntryRecord,
  Harness,
  Observation,
  Observer,
  Page,
  Storage,
  Submission,
  SubmissionId,
  SubmissionRecord,
  TaskId,
} from '@earendil-works/pi-durable'
import { HelmxError, MODEL_THINKING_LEVELS, isPlainObject } from '@helmx/protocol'

const THINKING_LEVEL_SET: ReadonlySet<string> = new Set(MODEL_THINKING_LEVELS)

export function asConversationId(id: number): ConversationId {
  return id as ConversationId
}

export function asEntryId(id: number): EntryId {
  return id as EntryId
}

export function asSubmissionId(id: number): SubmissionId {
  return id as SubmissionId
}

export function asTaskId<R = unknown>(id: number): TaskId<R> {
  return id as TaskId<R>
}

export function asSdkCursor(cursor: unknown): Cursor | undefined {
  if (cursor === undefined) return undefined
  if (!isPlainObject(cursor)) {
    throw new HelmxError('validation_error', 'pagination cursor must be a plain object', 400)
  }
  return cursor as Cursor
}

export function isSdkThinkingLevel(level: string): level is ModelThinkingLevel {
  return THINKING_LEVEL_SET.has(level)
}

export function asSdkThinkingLevel(level: string | undefined): ModelThinkingLevel | undefined {
  if (level === undefined || level === '') return undefined
  if (!isSdkThinkingLevel(level)) {
    throw new HelmxError(
      'validation_error',
      `invalid thinkingLevel '${level}'; valid values: ${MODEL_THINKING_LEVELS.join(' | ')}`,
      400,
    )
  }
  return level
}

export function getSdkConversation(
  harness: Pick<Harness, 'conversation'>,
  id: number,
  context: Context = BACKGROUND_CONTEXT,
): Promise<Conversation | undefined> {
  return harness.conversation(asConversationId(id), context)
}

export function getSdkSubmission(
  harness: Pick<Harness, 'submission'>,
  id: number,
  context: Context = BACKGROUND_CONTEXT,
): Promise<Submission | undefined> {
  return harness.submission(asSubmissionId(id), context)
}

export function getSdkTask<R = unknown>(
  harness: Pick<Harness, 'getTask'>,
  id: number,
  context: Context = BACKGROUND_CONTEXT,
) {
  return harness.getTask(asTaskId<R>(id), context)
}

export function abortSdkSubmission(
  harness: Pick<Harness, 'abortSubmission'>,
  submissionId: number,
  context: Context = BACKGROUND_CONTEXT,
  conversationId?: number,
) {
  return harness.abortSubmission(
    asSubmissionId(submissionId),
    context,
    conversationId !== undefined ? asConversationId(conversationId) : undefined,
  )
}

export function observeSdkConversation(
  harness: Pick<Harness, 'observeConversation'>,
  id: number,
  observer: Observer<ConversationView>,
  context: Context = BACKGROUND_CONTEXT,
): Promise<Observation<ConversationView>> {
  return harness.observeConversation(asConversationId(id), observer, context)
}

export function readSdkEntryPage(
  conversation: Pick<Conversation, 'entries'>,
  entryId: number,
  context: Context = BACKGROUND_CONTEXT,
): Promise<Page<EntryRecord, Cursor>> {
  const target = asEntryId(entryId)
  return conversation.entries(
    { minEntryId: target, maxEntryId: target, order: 'ascending' },
    1,
    undefined,
    context,
  )
}

export function scanSdkEntries(
  conversation: Pick<Conversation, 'entries'>,
  order: 'ascending' | 'descending',
  limit: number,
  cursor: unknown,
  context: Context = BACKGROUND_CONTEXT,
): Promise<Page<EntryRecord, Cursor>> {
  return conversation.entries({ order }, limit, asSdkCursor(cursor), context)
}

export function scanSdkConversations(
  storage: Pick<Storage, 'scanConversations'>,
  limit: number,
  cursor: unknown,
  context: Context = BACKGROUND_CONTEXT,
): Promise<Page<ConversationRecord, Cursor>> {
  return storage.scanConversations({}, limit, asSdkCursor(cursor), context)
}

export function isSdkInputSubmissionFor(
  record: SubmissionRecord,
  conversationId: number,
  submissionId: number,
): record is Extract<SubmissionRecord, { type: 'input' }> {
  return (
    record.type === 'input' &&
    String(record.conversationId) === String(conversationId) &&
    String(record.id) === String(submissionId)
  )
}
