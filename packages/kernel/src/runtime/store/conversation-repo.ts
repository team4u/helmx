/**
 * `ConversationRepo`: table-scoped mirror and SQLite persistence for `helmx_conversations`,
 * plus conversation status/summary projection helpers (`convStatusOf`, `summaryOf`).
 */

import type { ConversationOwnership, ConversationStatus, ConversationSummary } from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import type { SqliteExecutor } from '@earendil-works/chord/sqlite'
import { parseStoredStringArray } from './shared.js'
import type { SqliteMirrorQueue } from './write-queue.js'

export interface ConvMeta {
  id: number
  title: string
  profileId: string
  tags: string[]
  parentConversationId?: number
  /** Parent conversation's tool call ID that spawned or most recently resumed this child (live execution correlation). */
  parentToolCallId?: string
  /** Conversation ownership (`'human'` default; `'helmx'` for automation-owned conversations). */
  ownedBy?: ConversationOwnership
  /** Bound compute node ID (defaults to `'local'`). */
  nodeId: string
  cwd: string
  /** Resolved effective model snapshot (empty string when unconfigured; display-only). */
  model: string
  /** Explicit model override (`'provider/model'` or `'tier/<id>'`); `undefined` = inherit Profile/global. */
  modelOverride?: string
  /** Reasoning effort snapshot (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`; empty string = unset). */
  thinkingLevel: string
  /** Explicit reasoning effort override; `undefined` = inherit Profile/global. */
  thinkingLevelOverride?: string
  unread: boolean
  pinned: boolean
  stateChangeSeq: number
  completionSeq: number
  /** Cumulative in-flight duration (ms, non-negative integer) across settled logical turns. */
  runDurationMs: number
  /** Epoch ms start timestamp of the currently active logical turn (`live.run`); cleared on settlement. */
  runStartedAt?: number
  /** Latest visible timeline entry ID (`0` when none; hydrated by tracker.observe/adopt and maintained in memory). */
  lastEntryId?: number
  createdAt: number
  updatedAt: number
}

export interface ConvTitleFtsBridge {
  redactTitle(title: string): string
  recordTitleChangeOverlay(conversationId: number, redactedTitle: string): void
  updateTitleInTx(tx: SqliteExecutor, conversationId: number, redactedTitle: string): Promise<void>
}

export class ConversationRepo {
  private readonly convs = new Map<number, ConvMeta>()

  constructor(private readonly queue: SqliteMirrorQueue) {}

  async load(): Promise<void> {
    for (const row of await this.queue.db.all<{
      id: number
      title: string
      profile_id: string
      tags: string
      parent_conversation_id: number | null
      parent_tool_call_id: string | null
      owned_by: string | null
      node_id: string | null
      cwd: string
      model: string
      model_override: string | null
      thinking_level: string | null
      thinking_level_override: string | null
      unread: number
      pinned: number
      state_change_seq: number
      completion_seq: number
      run_duration_ms: number
      run_started_at: number | null
      created_at: number
      updated_at: number
    }>(
      'SELECT id, title, profile_id, tags, parent_conversation_id, parent_tool_call_id, owned_by, node_id, cwd, model, model_override, thinking_level, thinking_level_override, unread, pinned, state_change_seq, completion_seq, run_duration_ms, run_started_at, created_at, updated_at FROM helmx_conversations',
    )) {
      if (row.owned_by !== null && row.owned_by !== 'human' && row.owned_by !== 'helmx') {
        throw new HelmxError(
          'store_data_corrupted',
          `Persisted data corrupted (helmx_conversations#${row.id}.owned_by): invalid ownership '${String(row.owned_by)}'`,
          500,
          { id: row.id, ownedBy: row.owned_by },
        )
      }
      this.convs.set(row.id, {
        id: row.id,
        title: row.title,
        profileId: row.profile_id,
        tags: parseStoredStringArray(`helmx_conversations#${row.id}.tags`, row.tags),
        parentConversationId: row.parent_conversation_id ?? undefined,
        parentToolCallId: row.parent_tool_call_id || undefined,
        ownedBy: row.owned_by === 'helmx' ? 'helmx' : 'human',
        nodeId: row.node_id || 'local',
        cwd: row.cwd,
        model: row.model,
        modelOverride: row.model_override ?? undefined,
        thinkingLevel: row.thinking_level ?? '',
        thinkingLevelOverride: row.thinking_level_override ?? undefined,
        unread: row.unread === 1,
        pinned: row.pinned === 1,
        stateChangeSeq: row.state_change_seq,
        completionSeq: row.completion_seq,
        runDurationMs: row.run_duration_ms,
        ...(row.run_started_at !== null ? { runStartedAt: row.run_started_at } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })
    }
  }

  list(): ConvMeta[] {
    return [...this.convs.values()].map(cloneConv).sort((a, b) => b.id - a.id)
  }

  get(id: number): ConvMeta | undefined {
    const meta = this.convs.get(id)
    return meta ? cloneConv(meta) : undefined
  }

  /** Read live title without cloning the full `ConvMeta` snapshot (used by FTS search/rebuild). */
  getLiveTitle(id: number): string | undefined {
    return this.convs.get(id)?.title
  }

  /** Update the in-memory `lastEntryId` watermark for a conversation without emitting a SQLite write. */
  setLastEntryId(id: number, lastEntryId: number): void {
    if (!Number.isSafeInteger(lastEntryId) || lastEntryId < 0) {
      throw new HelmxError(
        'validation_error',
        `lastEntryId must be a non-negative safe integer, received: ${String(lastEntryId)}`,
        400,
      )
    }
    const existing = this.convs.get(id)
    if (existing !== undefined) {
      existing.lastEntryId = lastEntryId
    }
  }

  /** Update conversation ownership column in O(1); returns true if ownership changed on an existing conversation. */
  setOwnership(id: number, owner: ConversationOwnership, isDeleted: (id: number) => boolean): boolean {
    this.queue.assertWritable()
    const existing = this.convs.get(id)
    if (existing === undefined || isDeleted(id)) return false
    const current: ConversationOwnership = existing.ownedBy === 'helmx' ? 'helmx' : 'human'
    if (current === owner) return false
    existing.ownedBy = owner
    this.queue.enqueue(() =>
      this.queue.db.run('UPDATE helmx_conversations SET owned_by = ? WHERE id = ?', owner, id),
    )
    return true
  }

  upsert(meta: ConvMeta, fts: ConvTitleFtsBridge): void {
    this.queue.assertWritable()
    if (!Array.isArray(meta.tags) || meta.tags.some((t) => typeof t !== 'string')) {
      throw new HelmxError(
        'validation_error',
        `Invalid conversation tags for conversation ${meta.id}: expected string array`,
        400,
        { id: meta.id },
      )
    }
    const prev = this.convs.get(meta.id)
    const titleChanged = prev?.title !== meta.title
    // Deep-copy snapshot: SQL parameters bind to snapshot values so subsequent caller mutations cannot affect queued writes.
    const snap = cloneConv({ ...meta, ownedBy: meta.ownedBy ?? prev?.ownedBy ?? 'human' })
    if (snap.lastEntryId === undefined && prev?.lastEntryId !== undefined) {
      snap.lastEntryId = prev.lastEntryId
    }
    this.convs.set(snap.id, snap)
    if (titleChanged) {
      fts.recordTitleChangeOverlay(snap.id, fts.redactTitle(snap.title))
    }
    this.queue.enqueue(async () => {
      const upsertSql = `INSERT INTO helmx_conversations (id, title, profile_id, tags, parent_conversation_id, parent_tool_call_id, owned_by, node_id, cwd, model, model_override, thinking_level, thinking_level_override, unread, pinned, state_change_seq, completion_seq, run_duration_ms, run_started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, profile_id=excluded.profile_id, tags=excluded.tags, parent_conversation_id=excluded.parent_conversation_id, parent_tool_call_id=excluded.parent_tool_call_id, owned_by=excluded.owned_by, node_id=excluded.node_id, cwd=excluded.cwd, model=excluded.model, model_override=excluded.model_override, thinking_level=excluded.thinking_level, thinking_level_override=excluded.thinking_level_override, unread=excluded.unread, pinned=excluded.pinned, state_change_seq=excluded.state_change_seq, completion_seq=excluded.completion_seq, run_duration_ms=excluded.run_duration_ms, run_started_at=excluded.run_started_at, updated_at=excluded.updated_at`
      const upsertParams = [
        snap.id,
        snap.title,
        snap.profileId,
        JSON.stringify(snap.tags),
        snap.parentConversationId ?? null,
        snap.parentToolCallId !== undefined && snap.parentToolCallId !== '' ? snap.parentToolCallId : null,
        snap.ownedBy === 'helmx' ? 'helmx' : 'human',
        snap.nodeId || 'local',
        snap.cwd,
        snap.model,
        snap.modelOverride ?? null,
        snap.thinkingLevel || '',
        snap.thinkingLevelOverride ?? null,
        snap.unread ? 1 : 0,
        snap.pinned ? 1 : 0,
        snap.stateChangeSeq,
        snap.completionSeq,
        snap.runDurationMs,
        snap.runStartedAt ?? null,
        snap.createdAt,
        snap.updatedAt,
      ] as const
      if (!titleChanged) {
        await this.queue.db.run(upsertSql, ...upsertParams)
        return
      }
      // Title changes must update helmx_conversations and helmx_conversation_fts atomically in the same transaction
      // so a crash or SQL failure between the two statements never leaves persisted title and FTS rows out of sync.
      const redactedTitle = fts.redactTitle(snap.title)
      await this.queue.db.transaction(async (tx) => {
        await tx.run(upsertSql, ...upsertParams)
        await fts.updateTitleInTx(tx, snap.id, redactedTitle)
      })
    })
  }

  deleteInMemory(id: number): void {
    this.convs.delete(id)
  }

  deleteInTx(tx: SqliteExecutor, id: number): Promise<void> {
    return tx.run('DELETE FROM helmx_conversations WHERE id = ?', id)
  }
}

function cloneConv(meta: ConvMeta): ConvMeta {
  return {
    ...meta,
    ownedBy: meta.ownedBy === 'helmx' ? 'helmx' : 'human',
    tags: [...meta.tags],
    runDurationMs: meta.runDurationMs ?? 0,
  }
}

export function convStatusOf(
  meta: ConvMeta,
  sdkLive: { run?: unknown; runFailure?: unknown },
  pendingAskCount: number,
): ConversationStatus {
  // `blocked` (pending AskDoc) takes precedence over `working`: AskDoc is a human decision point,
  // so awaiting human input must remain visible in the state machine even if the model is still running.
  if (pendingAskCount > 0) return 'blocked'
  if (sdkLive.run) return 'working'
  if (sdkLive.runFailure) return 'error'
  return meta.unread ? 'done' : 'idle'
}

/** Inputs of `summaryOf`: store meta plus the live-derived status fields (optional fields are omitted from the summary when unset or empty). */
export interface ConversationSummaryInput {
  meta: ConvMeta
  status: ConversationStatus
  pendingAskCount: number
  doing?: string
  lastError?: string
  lastEntryId?: number
  pendingAskSince?: number
  effectiveModelRef?: string
  runtimeModelOverride?: boolean
}

export function summaryOf({
  meta,
  status,
  pendingAskCount,
  doing,
  lastError,
  lastEntryId,
  pendingAskSince,
  effectiveModelRef,
  runtimeModelOverride,
}: ConversationSummaryInput): ConversationSummary {
  return {
    id: meta.id,
    title: meta.title,
    profileId: meta.profileId,
    tags: meta.tags,
    parentConversationId: meta.parentConversationId,
    ...(meta.parentToolCallId !== undefined && meta.parentToolCallId !== ''
      ? { parentToolCallId: meta.parentToolCallId }
      : {}),
    ownedBy: meta.ownedBy === 'helmx' ? 'helmx' : 'human',
    nodeId: meta.nodeId || 'local',
    cwd: meta.cwd,
    model: meta.model,
    ...(meta.modelOverride !== undefined && meta.modelOverride !== '' ? { modelOverride: meta.modelOverride } : {}),
    ...(effectiveModelRef !== undefined && effectiveModelRef.startsWith('tier/') ? { effectiveModelRef } : {}),
    ...(runtimeModelOverride === true ? { runtimeModelOverride: true } : {}),
    thinkingLevel: meta.thinkingLevel,
    ...(meta.thinkingLevelOverride !== undefined ? { thinkingLevelOverride: meta.thinkingLevelOverride } : {}),
    status,
    doing,
    ...(lastError !== undefined && lastError !== '' ? { lastError } : {}),
    stateChangeSeq: meta.stateChangeSeq,
    completionSeq: meta.completionSeq,
    lastEntryId: lastEntryId ?? meta.lastEntryId ?? 0,
    unread: meta.unread,
    pinned: meta.pinned,
    pendingAskCount,
    runDurationMs: meta.runDurationMs,
    ...(meta.runStartedAt !== undefined ? { runStartedAt: meta.runStartedAt } : {}),
    ...(pendingAskCount > 0 && pendingAskSince !== undefined ? { pendingAskSince } : {}),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
}
