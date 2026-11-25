/**
 * Validation and entry scanning helpers for in-place cross-restart reattach of native subagents.
 *
 * Responsibilities:
 * - `assertSpawnRequestModes`: shared shape and mutual-exclusion validation for `mode`/`requestId`/`reattach`
 *   at both entry and post-hook convergence (`reattach` is mutually exclusive with `resume` and `fork`;
 *   `reattach.conversationId` requires `requestId`);
 * - `recoverAcceptedStructuredOutput`: scans persisted non-error `register_structured_output` calls starting
 *   from `submission.entry` to backfill `structured.accepted` across restarts;
 * - `readSubmissionAssistantText`: reads assistant text from a settled `submission.answer` (and the submission
 *   range), addressing missing in-memory `lastAssistant` caches when a crash happens right as a turn completes.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Conversation, EntryId, EntryRecord, SettledSubmissionRecord } from '@earendil-works/pi-durable'
import { HelmxError, isAbsoluteAgentPath, isValidNodeId, NODE_ID_PATTERN, type AgentSpawnRequest } from '@helmx/protocol'
import { assistantTextOfEntry, readEntryById } from './entries.js'
import { assertSpawnForkFields } from './spawn-fork.js'
import { extractAcceptedStructuredOutputFromEntries } from './structured-output.js'

const ENTRY_SCAN_PAGE_SIZE = 256

/**
 * Validate shapes and mutual-exclusion constraints for `nodeId`, `requestId`, `reattach`, `resume`, and `fork`:
 * - `nodeId`, when provided, must satisfy `NODE_ID_PATTERN` and is mutually exclusive with `resume` (`400 validation_error`);
 * - `reattach` is mutually exclusive with `resume` and `fork` (`400 validation_error`);
 * - `reattach` must be a plain object containing `conversationId` or `executionId`;
 * - `reattach.conversationId` must be a positive safe integer paired with a non-empty `requestId` (for submission deduplication).
 */
export function assertSpawnRequestModes(
  request: Pick<AgentSpawnRequest, 'fork' | 'resume' | 'reattach' | 'requestId' | 'nodeId' | 'gateTimeoutMs'>,
): void {
  assertSpawnForkFields(request)
  if (request.gateTimeoutMs !== undefined) {
    if (
      typeof request.gateTimeoutMs !== 'number' ||
      !Number.isSafeInteger(request.gateTimeoutMs) ||
      request.gateTimeoutMs <= 0 ||
      request.gateTimeoutMs > 600_000
    ) {
      throw new HelmxError(
        'validation_error',
        `gateTimeoutMs must be a positive safe integer <= 600000 (received ${String(request.gateTimeoutMs)})`,
        400,
        { gateTimeoutMs: request.gateTimeoutMs },
      )
    }
  }
  if (request.nodeId !== undefined) {
    if (!isValidNodeId(request.nodeId)) {
      throw new HelmxError(
        'validation_error',
        `nodeId must match ${NODE_ID_PATTERN} (received ${String(request.nodeId)})`,
        400,
        { nodeId: request.nodeId },
      )
    }
    if (request.resume !== undefined) {
      throw new HelmxError(
        'validation_error',
        'nodeId and resume are mutually exclusive: cannot switch compute node when resuming an existing subagent',
        400,
        { nodeId: request.nodeId, resume: request.resume },
      )
    }
  }
  if (request.requestId !== undefined) {
    if (typeof request.requestId !== 'string' || request.requestId.trim() === '') {
      throw new HelmxError(
        'validation_error',
        `requestId must be a non-empty string (received ${String(request.requestId)})`,
        400,
        { requestId: request.requestId },
      )
    }
  }
  if (request.reattach === undefined) return
  const raw = request.reattach
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HelmxError('validation_error', 'reattach must be a plain object', 400)
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'conversationId' && key !== 'effectiveCwd') {
      throw new HelmxError('validation_error', `reattach contains unknown field "${key}"`, 400, { field: key })
    }
  }
  if (request.resume !== undefined) {
    throw new HelmxError(
      'validation_error',
      'reattach and resume are mutually exclusive: cannot reattach in-place while resuming an existing subagent',
      400,
      { resume: request.resume },
    )
  }
  if (request.fork === true) {
    throw new HelmxError(
      'validation_error',
      'reattach and fork are mutually exclusive: cannot reattach in-place while forking from parent conversation',
      400,
    )
  }
  if (typeof raw.conversationId !== 'number' || !Number.isSafeInteger(raw.conversationId) || raw.conversationId <= 0) {
    throw new HelmxError(
      'validation_error',
      `reattach.conversationId must be a positive safe integer (received ${String(raw.conversationId)})`,
      400,
      { conversationId: raw.conversationId },
    )
  }
  if (raw.effectiveCwd !== undefined) {
    if (typeof raw.effectiveCwd !== 'string' || !isAbsoluteAgentPath(raw.effectiveCwd)) {
      throw new HelmxError(
        'validation_error',
        `reattach.effectiveCwd must be an absolute path (received ${String(raw.effectiveCwd)})`,
        400,
        { effectiveCwd: raw.effectiveCwd },
      )
    }
  }
}

async function scanEntryRange(
  conversation: Pick<Conversation, 'entries'>,
  minEntryId: EntryId,
  maxEntryId: EntryId | undefined,
  order: 'ascending' | 'descending',
): Promise<EntryRecord[]> {
  const out: EntryRecord[] = []
  let cursor = undefined
  for (;;) {
    const page = await conversation.entries(
      {
        minEntryId,
        ...(maxEntryId !== undefined ? { maxEntryId } : {}),
        order,
      },
      ENTRY_SCAN_PAGE_SIZE,
      cursor,
      BACKGROUND_CONTEXT,
    )
    out.push(...page.items)
    if (page.next === undefined) break
    cursor = page.next
  }
  return out
}

/**
 * Scan persisted non-error `register_structured_output` tool calls in the child conversation starting from
 * `submission.entry`; returns the structured artifact to backfill `accepted` if Schema validation passed before crash.
 */
export async function recoverAcceptedStructuredOutput(
  conversation: Pick<Conversation, 'entries'>,
  schema: Record<string, unknown>,
  entryId: EntryId,
  answerId?: EntryId,
): Promise<{ found: true; value: unknown } | { found: false }> {
  if (typeof conversation.entries !== 'function') return { found: false }
  const entries = await scanEntryRange(conversation, entryId, answerId, 'ascending')
  return extractAcceptedStructuredOutputFromEntries(entries, schema)
}

/**
 * Read assistant text for a given submission: prefers `settled.answer` directly (via shared `readEntryById`
 * + `assistantTextOfEntry`), falling back to searching `[settled.entry, settled.answer]` in reverse order for
 * the latest non-empty `pi.assistant` text (stopping at `pi.reset` or `helmx.rewind`).
 */
export async function readSubmissionAssistantText(
  conversation: Pick<Conversation, 'entries'>,
  settled: SettledSubmissionRecord,
  options: { redact?: (text: string) => string } = {},
): Promise<string | undefined> {
  if (settled.type !== 'input' || settled.status !== 'done' || settled.answer === undefined) {
    return undefined
  }
  if (typeof conversation.entries !== 'function') return undefined
  const applyRedact = (text: string): string => (options.redact !== undefined ? options.redact(text) : text)
  const directEntry = await readEntryById(conversation, settled.answer, BACKGROUND_CONTEXT)
  const directText = assistantTextOfEntry(directEntry)
  if (directText !== '') return applyRedact(directText)
  if (settled.entry === undefined) return undefined
  let cursor = undefined
  for (;;) {
    const page = await conversation.entries(
      { minEntryId: settled.entry, maxEntryId: settled.answer, order: 'descending' },
      ENTRY_SCAN_PAGE_SIZE,
      cursor,
      BACKGROUND_CONTEXT,
    )
    for (const entry of page.items) {
      if (entry.kind === 'pi.reset' || entry.kind === 'helmx.rewind') return undefined
      const text = assistantTextOfEntry(entry)
      if (text !== '') return applyRedact(text)
    }
    if (page.next === undefined) break
    cursor = page.next
  }
  return undefined
}
