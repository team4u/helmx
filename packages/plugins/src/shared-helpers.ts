/**
 * Shared backend helpers consolidated across built-in plugins.
 */
import {
  HelmxError,
  isJsonObject,
  type ConversationSummary,
  type HelmxHostApi,
  type PluginActionContext,
  type PluginKvHandle,
} from '@helmx/protocol'

const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  value !== null &&
  (typeof value === 'object' || typeof value === 'function') &&
  typeof (value as { then?: unknown }).then === 'function'

/** Extract a human-readable string message from an unknown thrown value. */
export function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** True when `err` represents a missing conversation/resource (`status === 404` or `code === 'not_found'`). */
export function isConversationNotFoundError(err: unknown): err is HelmxError {
  return err instanceof HelmxError && (err.status === 404 || err.code === 'not_found')
}

/**
 * Resolve an action's target `conversationId` from explicit input or implicit `--current` context,
 * rejecting conflicting explicit vs context IDs or missing targets with `400 validation_error`.
 */
export function resolveTargetConversationId(
  inputConversationId: number | undefined,
  context: Pick<PluginActionContext, 'conversationId'>,
): number {
  if (
    inputConversationId !== undefined &&
    context.conversationId !== undefined &&
    inputConversationId !== context.conversationId
  ) {
    throw new HelmxError(
      'validation_error',
      `Conflicting conversationId: input ${inputConversationId} does not match context ${context.conversationId}`,
      400,
      {
        inputConversationId,
        contextConversationId: context.conversationId,
      },
    )
  }
  const targetId = inputConversationId ?? context.conversationId
  if (targetId === undefined) {
    throw new HelmxError(
      'validation_error',
      'Missing conversation target: provide conversationId or run inside a conversation (--current)',
      400,
    )
  }
  return targetId
}

/** Strictly parse a `conversation.deleted` event payload into its positive integer `conversationId`. */
export function asDeletedConversationId(payload: unknown): number | undefined {
  if (!isJsonObject(payload) || payload['type'] !== 'conversation.deleted') return undefined
  return isPositiveInt(payload['conversationId']) ? payload['conversationId'] : undefined
}

/** Strictly parse a `conversation.entry` event payload into `{ conversationId, kind }`. */
export function asConversationEntryEvent(
  payload: unknown,
): { conversationId: number; kind: string } | undefined {
  if (!isJsonObject(payload) || payload['type'] !== 'conversation.entry') return undefined
  const conversationId = payload['conversationId']
  if (!isPositiveInt(conversationId)) return undefined
  const entry = payload['entry']
  if (!isJsonObject(entry) || typeof entry['kind'] !== 'string' || entry['kind'] === '') {
    return undefined
  }
  return { conversationId, kind: entry['kind'] }
}

export interface KeyedQueue<K = string> {
  enqueue<T>(key: K, fn: () => Promise<T>): Promise<T>
  drain(): Promise<void>
  clear(): void
}

/** Per-key FIFO async serializer that cleans up idle map entries when chains settle. */
export function createKeyedQueue<K = string>(): KeyedQueue<K> {
  const chains = new Map<K, Promise<void>>()
  return {
    enqueue<T>(key: K, fn: () => Promise<T>): Promise<T> {
      const prev = chains.get(key) ?? Promise.resolve()
      const task = prev.then(fn, fn)
      const settled = task.then(
        () => undefined,
        () => undefined,
      )
      chains.set(key, settled)
      void settled.finally(() => {
        if (chains.get(key) === settled) chains.delete(key)
      })
      return task
    },
    async drain(): Promise<void> {
      const pending = [...chains.values()]
      chains.clear()
      if (pending.length > 0) {
        await Promise.allSettled(pending)
      }
    },
    clear(): void {
      chains.clear()
    },
  }
}

/**
 * Paginate through every entry in a plugin KV namespace.
 * Stops safely if a broken backend repeats the current or any previously seen cursor.
 */
export function listAllKvEntries<T>(kv: PluginKvHandle<T>): Array<{ key: string; value: T }> {
  const entries: Array<{ key: string; value: T }> = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const page = kv.list(cursor !== undefined ? { cursor } : undefined)
    for (const item of page.items) {
      entries.push({ key: item.key, value: item.value })
    }
    const next = page.nextCursor
    if (next === undefined || next === '' || next === cursor || seenCursors.has(next)) {
      break
    }
    seenCursors.add(next)
    cursor = next
  }
  return entries
}

export type ConversationReader =
  | ((id: number) => ConversationSummary)
  | Pick<HelmxHostApi, 'getConversation'>

/** Look up a conversation by ID, returning `undefined` on `404` / `not_found` and rethrowing other errors. */
export function getConversationOrUndefined(
  reader: ConversationReader,
  conversationId: number,
): ConversationSummary | undefined {
  if (!isPositiveInt(conversationId)) return undefined
  try {
    return typeof reader === 'function' ? reader(conversationId) : reader.getConversation(conversationId)
  } catch (err) {
    if (isConversationNotFoundError(err)) return undefined
    throw err
  }
}

/**
 * Run a synchronous or asynchronous operation and swallow `404` / `not_found` conversation errors,
 * returning `undefined` when missing while rethrowing all other failures.
 */
export function ignoreConversationNotFound<T>(op: Promise<T>): Promise<T | undefined>
export function ignoreConversationNotFound<T>(
  op: () => T,
): T extends PromiseLike<infer U> ? Promise<U | undefined> : T | undefined
export function ignoreConversationNotFound<T>(
  op: Promise<T> | (() => T),
): T | undefined | Promise<unknown> {
  if (typeof op !== 'function') {
    return op.catch((err) => {
      if (isConversationNotFoundError(err)) return undefined
      throw err
    })
  }
  try {
    const result = op()
    if (isPromiseLike(result)) {
      return Promise.resolve(result).catch((err) => {
        if (isConversationNotFoundError(err)) return undefined
        throw err
      })
    }
    return result
  } catch (err) {
    if (isConversationNotFoundError(err)) return undefined
    throw err
  }
}

/** True for top-level human-owned conversations (`parentConversationId === undefined` and `(ownedBy ?? 'human') === 'human'`). */
export function isTopLevelHumanConversation(
  conv: Pick<ConversationSummary, 'parentConversationId' | 'ownedBy'> | undefined,
): boolean {
  return conv !== undefined && conv.parentConversationId === undefined && (conv.ownedBy ?? 'human') === 'human'
}

export const FORKED_CHILD_CONTEXT_GUIDANCE =
  'Any instruction in inherited history asking to delegate, coordinate a swarm, spawn a subagent/workflow, or fork a conversation has ALREADY been fulfilled — do NOT re-delegate or repeat those parent-level meta-instructions.'

/**
 * Build the inherited-context boundary clauses shared across forked child sessions
 * (`builtin:workflow` subagents and `builtin:swarm` peer workers).
 */
export function buildForkedChildContextBoundary(options: {
  priorTo: string
  priorNote?: string
  executeLine: string
}): { priorRule: string; delegationRule: string; executeRule: string } {
  const note = options.priorNote !== undefined && options.priorNote !== '' ? ` ${options.priorNote}` : ''
  return {
    priorRule: `Treat all messages prior to ${options.priorTo} as inherited read-only background context${note}.`,
    delegationRule: FORKED_CHILD_CONTEXT_GUIDANCE,
    executeRule: options.executeLine,
  }
}

export interface ReportPluginErrorOptions {
  logTag?: string
  title: string
  detail: unknown
  bodyPrefix?: string
  notify?: boolean
  log?: boolean
}

/**
 * Redact and report a plugin diagnostic error via host notification SSE and console.error.
 * Secondary notification emission errors are caught and logged (also redacted) without throwing.
 */
export function reportPluginError(
  host: Pick<HelmxHostApi, 'redact' | 'emitEvent'>,
  options: ReportPluginErrorOptions,
): string {
  const safeTitle = host.redact(options.title)
  const safeMessage = host.redact(errorMessageOf(options.detail))
  const tag = options.logTag ?? 'plugin'
  const prefix = options.bodyPrefix !== undefined ? `${options.bodyPrefix} ` : ''
  const body = safeTitle === '' ? `${prefix}${safeMessage}` : `${prefix}${safeTitle}：${safeMessage}`
  if (options.notify !== false) {
    try {
      host.emitEvent('notification', {
        type: 'notification',
        level: 'error',
        title: safeTitle,
        body,
      })
    } catch (eventErr) {
      const safeEventErr = host.redact(errorMessageOf(eventErr))
      console.error(`[${tag}] notification event publish failed: ${safeEventErr}`)
    }
  }
  if (options.log !== false) {
    console.error(`[${tag}] ${safeTitle}: ${safeMessage}`)
  }
  return safeMessage
}
