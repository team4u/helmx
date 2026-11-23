/**
 * `HelmxStore`: synchronous read/write mirror for helmx-owned SQLite tables + FTS5 derived index.
 *
 * All SQL runs through the single `NodeSqliteDatabase` adapter (sharing a transaction queue with `pi_` tables);
 * never open a second connection. The in-memory mirror supports synchronous reads (`listConvs`, etc.); writes
 * update the mirror first and enqueue persistence onto a strictly FIFO promise tail chain (zero polling).
 * Persistence honesty contract:
 * - First persistence error is recorded and reported explicitly (never swallowed or faked as success);
 * - `flushPublic` throws `HelmxError` whenever any unsettled persistence error exists (allowing callers to block downstream side effects);
 * - Subsequent writes fail closed once in failed state (no fake enqueuing);
 * - `close()` awaits full drain of in-flight flushes and returns the first persistence error to callers.
 */

import type { ArtifactKind, ConversationOwnership, ConversationStatus, ConversationSummary, SearchHit } from '@helmx/protocol'
import { HelmxError, compareCodeUnit, isArtifactKind, isPlainObject } from '@helmx/protocol'
import type { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { emitDiagnostic, type KernelDiagnosticSink } from './diagnostics.js'
import {
  buildFtsSearchSql,
  buildSearchSnippet,
  parseSearchTerms,
  type SearchOptions,
} from './fts-search.js'
import { FTS_SCHEMA_VERSION, FTS_SCHEMA_VERSION_KEY, type HelmxDatabase } from './sqlite.js'

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
  /** Explicit model override (`'provider/model'`); `undefined` = inherit Profile/global. */
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

interface AskRow {
  id: string
  conversationId: number
  ownerPluginId?: string
  specJson: string
  status: 'pending' | 'answered' | 'cancelled' | 'superseded'
  resultJson?: string
  expectedStateSeq?: number
  createdAt: number
  settledAt?: number
}

interface ArtifactRow {
  id: string
  conversationId: number
  kind: ArtifactKind
  name: string
  path: string
  mimeType: string
  size: number
  createdAt: number
}

type Deferred = () => Promise<void>

type FtsRebuildOverlayOp =
  | { op: 'upsert'; conversationId: number; entryId: string; title: string; body: string }
  | { op: 'removeEntries'; conversationId: number; entryIds: readonly string[] }
  | { op: 'deleteConv'; conversationId: number }
  | { op: 'updateTitle'; conversationId: number; title: string }

interface HelmxStoreOptions {
  /** Instance-level persistence failure callback (e.g., `KernelRuntime` fatal storage closure hook); falls back to diagnostic channel. */
  readonly onError?: (error: unknown) => void
  /** Diagnostic channel sink (fallback when `onError` is unset; defaults to `console.error`). */
  readonly onDiagnostic?: KernelDiagnosticSink
  /** Diagnostic redaction function (defaults to `ftsRedact`). */
  readonly redact?: (text: string) => string
}

export class HelmxStore {
  private readonly db: NodeSqliteDatabase
  private readonly onError: ((error: unknown) => void) | undefined
  private readonly onDiagnostic: KernelDiagnosticSink | undefined
  private readonly redactFn: ((text: string) => string) | undefined
  private readonly convs = new Map<number, ConvMeta>()
  private readonly asks = new Map<string, AskRow>()
  private readonly asksByConv = new Map<number, Set<string>>()
  private readonly artifacts = new Map<string, ArtifactRow>()
  private readonly artifactsByConv = new Map<number, Set<string>>()
  private readonly pluginDocs = new Map<string, string>() // pluginId\0name -> json
  /** Per-conversation plugin document mirror: `pluginId\0name\0conversationId -> json`. */
  private readonly pluginSessionDocs = new Map<string, string>()
  private readonly sessionDocsByConv = new Map<number, Set<string>>()
  /** Per-plugin keyed KV mirror: `pluginId -> namespace -> key -> { valueJson, updatedAt }`. */
  private readonly pluginKv = new Map<string, Map<string, Map<string, { valueJson: string; updatedAt: number }>>>()
  /** Logical deletion tombstones: prevents re-importing SDK-retained history after restarts. */
  private readonly tombstones = new Set<number>()
  /**
   * Persistence tail chain: all enqueued writes execute serially in FIFO order.
   * The chain itself never rejects (errors are caught and recorded internally), so `flushPublic`/`close` simply await it.
   */
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  /** First persistence error; once set, the store enters failed state and rejects subsequent writes. */
  private firstError: unknown = undefined
  private eventSeq = 0
  /** Coalesced target value for in-queue `helmx_seq` flushes (updated in place before the queued task starts). */
  private pendingEventSeq: number | undefined = undefined
  private seqFlushQueued = false
  private ftsSchemaVersion = 0
  /** Serializes concurrent `rebuildFts` invocations so overlays and swaps never interleave. */
  private ftsRebuildChain: Promise<void> = Promise.resolve()
  /** Active write-delta log capturing live FTS/title/delete mutations during async `rebuildFts` replay. */
  private ftsRebuildOverlay: FtsRebuildOverlayOp[] | null = null
  /** Text redaction hook for FTS indexing (runtime injects `stash.redact`). */
  ftsRedact: (text: string) => string = (t) => t

  constructor(database: HelmxDatabase, options: HelmxStoreOptions = {}) {
    this.db = database.db
    this.onError = options.onError
    this.onDiagnostic = options.onDiagnostic
    this.redactFn = options.redact
  }

  private addConvIndex(index: Map<number, Set<string>>, conversationId: number, key: string): void {
    let set = index.get(conversationId)
    if (set === undefined) {
      set = new Set()
      index.set(conversationId, set)
    }
    set.add(key)
  }

  private removeConvIndex(index: Map<number, Set<string>>, conversationId: number, key: string): void {
    const set = index.get(conversationId)
    if (set === undefined) return
    set.delete(key)
    if (set.size === 0) index.delete(conversationId)
  }

  /** First persistence failure error (read-only; `undefined` when healthy). */
  get error(): unknown {
    return this.firstError
  }

  /** Load all mirrors from SQLite at startup; throws explicitly on corrupted persisted JSON (never fabricates empty values). */
  async load(): Promise<void> {
    for (const row of await this.db.all<{
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
    for (const row of await this.db.all<{
      id: string
      conversation_id: number
      owner_plugin_id: string | null
      spec: string
      status: string
      result: string | null
      expected_state_seq: number | null
      created_at: number
      settled_at: number | null
    }>(
      'SELECT id, conversation_id, owner_plugin_id, spec, status, result, expected_state_seq, created_at, settled_at FROM helmx_asks',
    )) {
      if (!isValidAskStatus(row.status)) {
        throw new HelmxError(
          'store_data_corrupted',
          `Persisted data corrupted (helmx_asks#${row.id}.status): invalid ask status '${String(row.status)}'`,
          500,
          { id: row.id, status: row.status },
        )
      }
      parseStoredAskSpec(`helmx_asks#${row.id}.spec`, row.spec, {
        id: row.id,
        conversationId: row.conversation_id,
        status: row.status,
        expectedStateSeq: row.expected_state_seq ?? undefined,
      })
      if (row.result !== null) parseStoredAskResult(`helmx_asks#${row.id}.result`, row.result)
      this.asks.set(row.id, {
        id: row.id,
        conversationId: row.conversation_id,
        ownerPluginId: row.owner_plugin_id ?? undefined,
        specJson: row.spec,
        status: row.status,
        resultJson: row.result ?? undefined,
        expectedStateSeq: row.expected_state_seq ?? undefined,
        createdAt: row.created_at,
        settledAt: row.settled_at ?? undefined,
      })
      this.addConvIndex(this.asksByConv, row.conversation_id, row.id)
    }
    for (const row of await this.db.all<{
      id: string
      conversation_id: number
      kind: string
      name: string
      path: string
      mime_type: string
      size: number
      created_at: number
    }>('SELECT id, conversation_id, kind, name, path, mime_type, size, created_at FROM helmx_artifacts')) {
      if (!isArtifactKind(row.kind)) {
        throw new HelmxError(
          'store_data_corrupted',
          `Persisted data corrupted (helmx_artifacts#${row.id}.kind): invalid artifact kind '${String(row.kind)}'`,
          500,
          { id: row.id, kind: row.kind },
        )
      }
      this.artifacts.set(row.id, {
        id: row.id,
        conversationId: row.conversation_id,
        kind: row.kind,
        name: row.name,
        path: row.path,
        mimeType: row.mime_type,
        size: row.size,
        createdAt: row.created_at,
      })
      this.addConvIndex(this.artifactsByConv, row.conversation_id, row.id)
    }
    for (const row of await this.db.all<{ plugin_id: string; name: string; value: string }>(
      'SELECT plugin_id, name, value FROM helmx_plugin_docs',
    )) {
      parseStoredJson<unknown>(`helmx_plugin_docs#${row.plugin_id}:${row.name}.value`, row.value)
      this.pluginDocs.set(row.plugin_id + '\0' + row.name, row.value)
    }
    for (const row of await this.db.all<{ plugin_id: string; name: string; conversation_id: number; value: string }>(
      'SELECT plugin_id, name, conversation_id, value FROM helmx_plugin_session_docs',
    )) {
      parseStoredJson<unknown>(
        `helmx_plugin_session_docs#${row.plugin_id}:${row.name}#${row.conversation_id}.value`,
        row.value,
      )
      const sessionKey = `${row.plugin_id}\0${row.name}\0${row.conversation_id}`
      this.pluginSessionDocs.set(sessionKey, row.value)
      this.addConvIndex(this.sessionDocsByConv, row.conversation_id, sessionKey)
    }
    for (const row of await this.db.all<{
      plugin_id: string
      namespace: string
      key: string
      value_json: string
      updated_at: number
    }>('SELECT plugin_id, namespace, key, value_json, updated_at FROM helmx_plugin_kv')) {
      parseStoredJson<unknown>(
        `helmx_plugin_kv#${row.plugin_id}:${row.namespace}/${row.key}.value_json`,
        row.value_json,
      )
      this.setPluginKvMirror(row.plugin_id, row.namespace, row.key, row.value_json, row.updated_at)
    }
    const seqRow = await this.db.get<{ value: number }>(
      "SELECT value FROM helmx_seq WHERE key = 'events'",
    )
    this.eventSeq = seqRow?.value ?? 0
    const ftsVerRow = await this.db.get<{ value: number }>(
      'SELECT value FROM helmx_seq WHERE key = ?',
      FTS_SCHEMA_VERSION_KEY,
    )
    this.ftsSchemaVersion = ftsVerRow?.value ?? 0
    for (const row of await this.db.all<{ id: number }>('SELECT id FROM helmx_tombstones')) {
      this.tombstones.add(row.id)
    }
  }

  /** True when the derived FTS5 table was newly migrated/recreated or a prior rebuild did not finish committing. */
  get needsFtsRebuild(): boolean {
    return this.ftsSchemaVersion !== FTS_SCHEMA_VERSION
  }

  isDeleted(id: number): boolean {
    return this.tombstones.has(id)
  }

  get eventSeqNow(): number {
    return this.eventSeq
  }

  /**
   * Persist event sequence: accepts non-negative safe integers only and never regresses monotonically.
   * Coalesces bursts in-queue on the FIFO tail chain (updating `pendingEventSeq` in place if the queued task
   * has not started executing yet, with zero timers and 100% strict `flushPublic()` FIFO semantics).
   */
  setEventSeq(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new HelmxError('invalid_event_seq', `Event sequence must be a non-negative safe integer, received: ${seq}`, 500, {
        seq,
      })
    }
    this.assertWritable()
    if (seq < this.eventSeq) return // Reject regression: keep the higher watermark
    this.eventSeq = seq
    this.pendingEventSeq = seq
    if (this.seqFlushQueued) return
    this.seqFlushQueued = true
    this.enqueue(async () => {
      this.seqFlushQueued = false
      const target = this.pendingEventSeq
      this.pendingEventSeq = undefined
      if (target === undefined) return
      await this.db.run(
        "INSERT INTO helmx_seq (key, value) VALUES ('events', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        target,
      )
    })
  }

  // ---------------- conversations ----------------

  listConvs(): ConvMeta[] {
    return [...this.convs.values()].map(cloneConv).sort((a, b) => b.id - a.id)
  }

  getConv(id: number): ConvMeta | undefined {
    const meta = this.convs.get(id)
    return meta ? cloneConv(meta) : undefined
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
  setConvOwnership(id: number, owner: ConversationOwnership): boolean {
    this.assertWritable()
    const existing = this.convs.get(id)
    if (existing === undefined || this.tombstones.has(id)) return false
    const current: ConversationOwnership = existing.ownedBy === 'helmx' ? 'helmx' : 'human'
    if (current === owner) return false
    existing.ownedBy = owner
    this.enqueue(() =>
      this.db.run('UPDATE helmx_conversations SET owned_by = ? WHERE id = ?', owner, id),
    )
    return true
  }

  upsertConv(meta: ConvMeta): void {
    this.assertWritable()
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
    if (titleChanged && this.ftsRebuildOverlay !== null) {
      this.ftsRebuildOverlay.push({
        op: 'updateTitle',
        conversationId: snap.id,
        title: this.ftsRedact(snap.title),
      })
    }
    this.enqueue(async () => {
      await this.db.run(
        `INSERT INTO helmx_conversations (id, title, profile_id, tags, parent_conversation_id, parent_tool_call_id, owned_by, node_id, cwd, model, model_override, thinking_level, thinking_level_override, unread, pinned, state_change_seq, completion_seq, run_duration_ms, run_started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, profile_id=excluded.profile_id, tags=excluded.tags, parent_conversation_id=excluded.parent_conversation_id, parent_tool_call_id=excluded.parent_tool_call_id, owned_by=excluded.owned_by, node_id=excluded.node_id, cwd=excluded.cwd, model=excluded.model, model_override=excluded.model_override, thinking_level=excluded.thinking_level, thinking_level_override=excluded.thinking_level_override, unread=excluded.unread, pinned=excluded.pinned, state_change_seq=excluded.state_change_seq, completion_seq=excluded.completion_seq, run_duration_ms=excluded.run_duration_ms, run_started_at=excluded.run_started_at, updated_at=excluded.updated_at`,
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
      )
      // Title changes must update the title column across every FTS row for this conversation (routed via helmx_fts_map).
      if (titleChanged) {
        await this.db.run(
          'UPDATE helmx_conversation_fts SET title = ? WHERE rowid IN (SELECT fts_rowid FROM helmx_fts_map WHERE conversation_id = ?)',
          this.ftsRedact(snap.title),
          snap.id,
        )
      }
    })
  }

  /**
   * Delete conversation: tombstone + row cleanup execute atomically in **the same transaction** (prevents crash windows
   * where rows are deleted without a tombstone, causing resurrection on restart). Synchronously cleans up in-memory
   * asks/artifacts mirrors; settled Ask history is purged alongside the conversation so mirrors stay consistent.
   */
  deleteConv(id: number): void {
    this.assertWritable()
    this.convs.delete(id)
    this.tombstones.add(id)
    if (this.ftsRebuildOverlay !== null) {
      this.ftsRebuildOverlay.push({ op: 'deleteConv', conversationId: id })
    }
    const askIds = this.asksByConv.get(id)
    if (askIds !== undefined) {
      for (const askId of askIds) this.asks.delete(askId)
      this.asksByConv.delete(id)
    }
    const artifactIds = this.artifactsByConv.get(id)
    if (artifactIds !== undefined) {
      for (const artifactId of artifactIds) this.artifacts.delete(artifactId)
      this.artifactsByConv.delete(id)
    }
    // Synchronously purge per-conversation document mirror via secondary index (DB rows deleted in the same transaction below).
    const sessionKeys = this.sessionDocsByConv.get(id)
    if (sessionKeys !== undefined) {
      for (const key of sessionKeys) this.pluginSessionDocs.delete(key)
      this.sessionDocsByConv.delete(id)
    }
    this.enqueue(() =>
      this.db.transaction(async (tx) => {
        await tx.run(
          'INSERT OR IGNORE INTO helmx_tombstones (id, deleted_at) VALUES (?, ?)',
          id,
          Date.now(),
        )
        await tx.run('DELETE FROM helmx_conversations WHERE id = ?', id)
        await tx.run('DELETE FROM helmx_asks WHERE conversation_id = ?', id)
        await tx.run('DELETE FROM helmx_artifacts WHERE conversation_id = ?', id)
        await tx.run(
          'DELETE FROM helmx_conversation_fts WHERE rowid IN (SELECT fts_rowid FROM helmx_fts_map WHERE conversation_id = ?)',
          id,
        )
        await tx.run('DELETE FROM helmx_fts_map WHERE conversation_id = ?', id)
        await tx.run('DELETE FROM helmx_plugin_session_docs WHERE conversation_id = ?', id)
      }),
    )
  }

  // ---------------- asks ----------------

  listAsks(status?: string): AskRow[] {
    return [...this.asks.values()]
      .filter((a) => (status ? a.status === status : true))
      .map((a) => ({ ...a }))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  listAsksByConversation(conversationId: number, status?: string): AskRow[] {
    const ids = this.asksByConv.get(conversationId)
    if (ids === undefined || ids.size === 0) return []
    const out: AskRow[] = []
    for (const id of ids) {
      const row = this.asks.get(id)
      if (row === undefined) continue
      if (status !== undefined && row.status !== status) continue
      out.push({ ...row })
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  countAsksByConversation(conversationId: number, status?: string): number {
    const ids = this.asksByConv.get(conversationId)
    if (ids === undefined || ids.size === 0) return 0
    if (status === undefined) return ids.size
    let count = 0
    for (const id of ids) {
      if (this.asks.get(id)?.status === status) count += 1
    }
    return count
  }

  getAsk(id: string): AskRow | undefined {
    const row = this.asks.get(id)
    return row ? { ...row } : undefined
  }

  /**
   * Earliest `createdAt` (epoch ms) among currently pending AskDocs for `conversationId`,
   * derived directly from the per-conversation `asksByConv` index (O(k), zero dual-write).
   */
  earliestPendingAskCreatedAt(conversationId: number): number | undefined {
    const ids = this.asksByConv.get(conversationId)
    if (ids === undefined || ids.size === 0) return undefined
    let earliest: number | undefined
    for (const id of ids) {
      const row = this.asks.get(id)
      if (row === undefined || row.status !== 'pending') continue
      if (earliest === undefined || row.createdAt < earliest) {
        earliest = row.createdAt
      }
    }
    return earliest
  }

  /**
   * UPSERT all columns (including `spec` / `expected_state_seq` / `owner` / `created_at`):
   * settling must write back `specJson` (containing terminal `status`), otherwise `listAsks` restores stale `pending` after restart.
   */
  putAsk(row: AskRow): void {
    this.assertWritable()
    if (!isValidAskStatus(row.status)) {
      throw new HelmxError('validation_error', `Invalid ask status: ${String(row.status)}`, 400, {
        id: row.id,
        status: row.status,
      })
    }
    parseStoredAskSpec(`helmx_asks#${row.id}.spec`, row.specJson, {
      id: row.id,
      conversationId: row.conversationId,
      status: row.status,
      expectedStateSeq: row.expectedStateSeq,
    })
    if (row.resultJson !== undefined) {
      parseStoredAskResult(`helmx_asks#${row.id}.result`, row.resultJson)
    }
    const prev = this.asks.get(row.id)
    if (prev !== undefined && prev.conversationId !== row.conversationId) {
      this.removeConvIndex(this.asksByConv, prev.conversationId, row.id)
    }
    this.asks.set(row.id, { ...row })
    this.addConvIndex(this.asksByConv, row.conversationId, row.id)
    this.enqueue(() =>
      this.db.run(
        `INSERT INTO helmx_asks (id, conversation_id, owner_plugin_id, spec, status, result, expected_state_seq, created_at, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           conversation_id=excluded.conversation_id,
           owner_plugin_id=excluded.owner_plugin_id,
           spec=excluded.spec,
           status=excluded.status,
           result=excluded.result,
           expected_state_seq=excluded.expected_state_seq,
           created_at=excluded.created_at,
           settled_at=excluded.settled_at`,
        row.id,
        row.conversationId,
        row.ownerPluginId ?? null,
        row.specJson,
        row.status,
        row.resultJson ?? null,
        row.expectedStateSeq ?? null,
        row.createdAt,
        row.settledAt ?? null,
      ),
    )
  }

  // ---------------- artifacts ----------------

  listArtifacts(conversationId?: number): ArtifactRow[] {
    if (conversationId !== undefined) {
      const ids = this.artifactsByConv.get(conversationId)
      if (ids === undefined || ids.size === 0) return []
      const out: ArtifactRow[] = []
      for (const id of ids) {
        const row = this.artifacts.get(id)
        if (row !== undefined) out.push({ ...row })
      }
      return out.sort((a, b) => a.createdAt - b.createdAt)
    }
    return [...this.artifacts.values()]
      .map((a) => ({ ...a }))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  getArtifact(id: string): ArtifactRow | undefined {
    const row = this.artifacts.get(id)
    return row ? { ...row } : undefined
  }

  putArtifact(row: ArtifactRow): void {
    this.assertWritable()
    if (!isArtifactKind(row.kind)) {
      throw new HelmxError('validation_error', `Invalid artifact kind: ${String(row.kind)}`, 400, { id: row.id, kind: row.kind })
    }
    const prev = this.artifacts.get(row.id)
    if (prev !== undefined && prev.conversationId !== row.conversationId) {
      this.removeConvIndex(this.artifactsByConv, prev.conversationId, row.id)
    }
    this.artifacts.set(row.id, { ...row })
    this.addConvIndex(this.artifactsByConv, row.conversationId, row.id)
    this.enqueue(() =>
      this.db.run(
        `INSERT INTO helmx_artifacts (id, conversation_id, kind, name, path, mime_type, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, name=excluded.name, path=excluded.path, mime_type=excluded.mime_type, size=excluded.size`,
        row.id,
        row.conversationId,
        row.kind,
        row.name,
        row.path,
        row.mimeType,
        row.size,
        row.createdAt,
      ),
    )
  }

  deleteArtifactsByConversation(conversationId: number): string[] {
    this.assertWritable()
    const ids = this.artifactsByConv.get(conversationId)
    const removed: string[] = ids ? [...ids] : []
    if (ids !== undefined) {
      for (const id of ids) this.artifacts.delete(id)
      this.artifactsByConv.delete(conversationId)
    }
    this.enqueue(() =>
      this.db.run('DELETE FROM helmx_artifacts WHERE conversation_id = ?', conversationId),
    )
    return removed
  }

  // ---------------- plugin docs ----------------

  getPluginDoc(pluginId: string, name: string): string | undefined {
    return this.pluginDocs.get(pluginId + '\0' + name)
  }

  /** `valueJson` must be valid JSON: callers that just serialized via `JSON.stringify` may pass `prevalidated: true`. */
  putPluginDoc(pluginId: string, name: string, valueJson: string, options?: { prevalidated?: boolean }): void {
    this.assertWritable()
    if (options?.prevalidated !== true) {
      parseStoredJson<unknown>(`helmx_plugin_docs#${pluginId}:${name}.value`, valueJson)
    }
    this.pluginDocs.set(pluginId + '\0' + name, valueJson)
    this.enqueue(() =>
      this.db.run(
        `INSERT INTO helmx_plugin_docs (plugin_id, name, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(plugin_id, name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        pluginId,
        name,
        valueJson,
        Date.now(),
      ),
    )
  }

  /**
   * Delete all global documents belonging to a plugin (unload cleanup).
   *
   * Global documents live under `__global` with `name = '${pluginId}:${docName}'`. Since `pluginId` itself may
   * contain colons (e.g. `foo:bar`) while `docName` forbids colons (`assertValidId`), plain prefix matching would
   * delete across plugins (`foo` matching `foo:bar:doc`); precise matching requires `${pluginId}:` prefix AND no colon in remainder.
   */
  deleteGlobalPluginDocs(pluginId: string): void {
    this.assertWritable()
    const prefix = `${pluginId}:`
    const rowPrefix = `__global\0${prefix}`
    for (const key of [...this.pluginDocs.keys()]) {
      if (!key.startsWith(rowPrefix)) continue
      if (key.slice(rowPrefix.length).includes(':')) continue
      this.pluginDocs.delete(key)
    }
    this.enqueue(() =>
      this.db.run(
        `DELETE FROM helmx_plugin_docs
         WHERE plugin_id = '__global' AND substr(name, 1, ?) = ? AND instr(substr(name, ?), ':') = 0`,
        prefix.length,
        prefix,
        prefix.length + 1,
      ),
    )
  }

  // ---------------- plugin session docs ----------------

  /** Read per-conversation document mirror (returns `undefined` if unwritten; caller falls back to initial value). */
  getPluginSessionDoc(pluginId: string, name: string, conversationId: number): string | undefined {
    return this.pluginSessionDocs.get(`${pluginId}\0${name}\0${conversationId}`)
  }

  /** Write per-conversation document (`valueJson` must be valid JSON; pre-serialized callers may pass `prevalidated: true`). */
  putPluginSessionDoc(
    pluginId: string,
    name: string,
    conversationId: number,
    valueJson: string,
    options?: { prevalidated?: boolean },
  ): void {
    this.assertWritable()
    if (options?.prevalidated !== true) {
      parseStoredJson<unknown>(
        `helmx_plugin_session_docs#${pluginId}:${name}#${conversationId}.value`,
        valueJson,
      )
    }
    const sessionKey = `${pluginId}\0${name}\0${conversationId}`
    this.pluginSessionDocs.set(sessionKey, valueJson)
    this.addConvIndex(this.sessionDocsByConv, conversationId, sessionKey)
    this.enqueue(() =>
      this.db.run(
        `INSERT INTO helmx_plugin_session_docs (plugin_id, name, conversation_id, value, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(plugin_id, name, conversation_id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        pluginId,
        name,
        conversationId,
        valueJson,
        Date.now(),
      ),
    )
  }

  deletePluginSessionDoc(pluginId: string, name: string, conversationId: number): void {
    this.assertWritable()
    const sessionKey = `${pluginId}\0${name}\0${conversationId}`
    this.pluginSessionDocs.delete(sessionKey)
    this.removeConvIndex(this.sessionDocsByConv, conversationId, sessionKey)
    this.enqueue(() =>
      this.db.run(
        'DELETE FROM helmx_plugin_session_docs WHERE plugin_id = ? AND name = ? AND conversation_id = ?',
        pluginId,
        name,
        conversationId,
      ),
    )
  }

  /** Delete all per-conversation documents belonging to a plugin (unload cleanup; dedicated `plugin_id` column ensures exact match). */
  deletePluginSessionDocs(pluginId: string): void {
    this.assertWritable()
    const prefix = pluginId + '\0'
    for (const key of [...this.pluginSessionDocs.keys()]) {
      if (!key.startsWith(prefix)) continue
      this.pluginSessionDocs.delete(key)
      const convId = Number(key.split('\0')[2])
      if (Number.isSafeInteger(convId)) {
        this.removeConvIndex(this.sessionDocsByConv, convId, key)
      }
    }
    this.enqueue(() =>
      this.db.run('DELETE FROM helmx_plugin_session_docs WHERE plugin_id = ?', pluginId),
    )
  }

  /** List all conversation IDs (ascending) for which a plugin document has been persisted. */
  listPluginSessionDocConversations(pluginId: string, name: string): number[] {
    const out: number[] = []
    for (const key of this.pluginSessionDocs.keys()) {
      if (!key.startsWith(`${pluginId}\0${name}\0`)) continue
      const convId = Number(key.split('\0')[2])
      if (Number.isSafeInteger(convId) && convId > 0) out.push(convId)
    }
    return out.sort((a, b) => a - b)
  }

  // ---------------- plugin kv ----------------

  private setPluginKvMirror(
    pluginId: string,
    namespace: string,
    key: string,
    valueJson: string,
    updatedAt: number,
  ): void {
    let byNs = this.pluginKv.get(pluginId)
    if (!byNs) {
      byNs = new Map()
      this.pluginKv.set(pluginId, byNs)
    }
    let byKey = byNs.get(namespace)
    if (!byKey) {
      byKey = new Map()
      byNs.set(namespace, byKey)
    }
    byKey.set(key, { valueJson, updatedAt })
  }

  getPluginKv(pluginId: string, namespace: string, key: string): { valueJson: string; updatedAt: number } | undefined {
    const entry = this.pluginKv.get(pluginId)?.get(namespace)?.get(key)
    return entry ? { valueJson: entry.valueJson, updatedAt: entry.updatedAt } : undefined
  }

  putPluginKv(
    pluginId: string,
    namespace: string,
    key: string,
    valueJson: string,
    options?: { prevalidated?: boolean; updatedAt?: number },
  ): number {
    this.assertWritable()
    if (options?.prevalidated !== true) {
      parseStoredJson<unknown>(`helmx_plugin_kv#${pluginId}:${namespace}/${key}.value_json`, valueJson)
    }
    const updatedAt = options?.updatedAt ?? Date.now()
    this.setPluginKvMirror(pluginId, namespace, key, valueJson, updatedAt)
    this.enqueue(() =>
      this.db.run(
        `INSERT INTO helmx_plugin_kv (plugin_id, namespace, key, value_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(plugin_id, namespace, key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
        pluginId,
        namespace,
        key,
        valueJson,
        updatedAt,
      ),
    )
    return updatedAt
  }

  deletePluginKvKey(pluginId: string, namespace: string, key: string): boolean {
    this.assertWritable()
    const byNs = this.pluginKv.get(pluginId)
    const byKey = byNs?.get(namespace)
    if (!byKey || !byKey.delete(key)) return false
    if (byKey.size === 0) byNs!.delete(namespace)
    if (byNs!.size === 0) this.pluginKv.delete(pluginId)
    this.enqueue(() =>
      this.db.run(
        'DELETE FROM helmx_plugin_kv WHERE plugin_id = ? AND namespace = ? AND key = ?',
        pluginId,
        namespace,
        key,
      ),
    )
    return true
  }

  listPluginKv(
    pluginId: string,
    namespace: string,
    opts?: { prefix?: string; limit?: number; cursor?: string },
  ): { items: Array<{ key: string; valueJson: string; updatedAt: number }>; nextCursor?: string } {
    const byKey = this.pluginKv.get(pluginId)?.get(namespace)
    if (!byKey || byKey.size === 0) return { items: [] }
    const prefix = opts?.prefix
    const cursor = opts?.cursor
    const limit = opts?.limit
    const keys: string[] = []
    for (const key of byKey.keys()) {
      if (prefix !== undefined && !key.startsWith(prefix)) continue
      if (cursor !== undefined && compareCodeUnit(key, cursor) <= 0) continue
      keys.push(key)
    }
    keys.sort(compareCodeUnit)
    const hasMore = limit !== undefined && keys.length > limit
    const pageKeys = hasMore ? keys.slice(0, limit) : keys
    const items = pageKeys.map((key) => {
      const entry = byKey.get(key)!
      return { key, valueJson: entry.valueJson, updatedAt: entry.updatedAt }
    })
    return {
      items,
      ...(hasMore && items.length > 0 ? { nextCursor: items[items.length - 1]!.key } : {}),
    }
  }

  clearPluginKvNamespace(pluginId: string, namespace: string): void {
    this.assertWritable()
    const byNs = this.pluginKv.get(pluginId)
    if (byNs) {
      byNs.delete(namespace)
      if (byNs.size === 0) this.pluginKv.delete(pluginId)
    }
    this.enqueue(() =>
      this.db.run(
        'DELETE FROM helmx_plugin_kv WHERE plugin_id = ? AND namespace = ?',
        pluginId,
        namespace,
      ),
    )
  }

  deletePluginKv(pluginId: string): void {
    this.assertWritable()
    this.pluginKv.delete(pluginId)
    this.enqueue(() =>
      this.db.run('DELETE FROM helmx_plugin_kv WHERE plugin_id = ?', pluginId),
    )
  }

  // ---------------- FTS ----------------

  /**
   * Index conversation text (input/answer/tool summary); body is redacted before storing.
   * `(conversation_id, entry_id)` idempotent: repeated indexing of the same entry (e.g., observer replay)
   * deletes then inserts inside one transaction so FTS5 (which lacks unique constraints) never gets duplicate rows.
   */
  indexFts(conversationId: number, entryId: string, title: string, body: string): void {
    this.assertWritable()
    const safeTitle = this.ftsRedact(title)
    const safeBody = this.ftsRedact(body)
    if (this.ftsRebuildOverlay !== null) {
      this.ftsRebuildOverlay.push({
        op: 'upsert',
        conversationId,
        entryId,
        title: safeTitle,
        body: safeBody,
      })
    }
    this.enqueue(() =>
      this.db.transaction(async (tx) => {
        const existing = await tx.get<{ fts_rowid: number }>(
          'SELECT fts_rowid FROM helmx_fts_map WHERE conversation_id = ? AND entry_id = ?',
          conversationId,
          entryId,
        )
        if (existing !== undefined) {
          await tx.run('DELETE FROM helmx_conversation_fts WHERE rowid = ?', existing.fts_rowid)
          await tx.run(
            'DELETE FROM helmx_fts_map WHERE conversation_id = ? AND entry_id = ?',
            conversationId,
            entryId,
          )
        }
        await tx.run(
          'INSERT INTO helmx_conversation_fts (conversation_id, entry_id, title, body) VALUES (?, ?, ?, ?)',
          conversationId,
          entryId,
          safeTitle,
          safeBody,
        )
        const inserted = await tx.get<{ rid: number }>('SELECT last_insert_rowid() AS rid')
        await tx.run(
          'INSERT INTO helmx_fts_map (conversation_id, entry_id, fts_rowid) VALUES (?, ?, ?)',
          conversationId,
          entryId,
          inserted!.rid,
        )
      }),
    )
  }

  /** Full-text search index (rebuildable derived index; never touches `pi_` table semantics). */
  async search(query: string, options?: SearchOptions): Promise<SearchHit[]> {
    // Wait for queued writes to drain completely (throws on errors) so queries observe persisted latest state.
    await this.flushPublic()
    const parsed = parseSearchTerms(query)
    const sqlQuery = buildFtsSearchSql(parsed, options)
    if (sqlQuery === undefined) return []
    const rows = await this.db.all<{
      conversation_id: number
      entry_id: string
      title: string
      body: string
    }>(sqlQuery.sql, ...sqlQuery.params)
    // Defensive deduplication: at most one entry per `(conversation_id, entry_id)`, skip tombstones,
    // and collapse title-only hits (zero body matches) to at most one conversation-level hit without `entryId`.
    const seen = new Set<string>()
    const bodyMatchedConvs = new Set<number>()
    const titleOnlyConvs = new Set<number>()
    const candidates: Array<{ hit: SearchHit; isBodyMatch: boolean }> = []
    for (const r of rows) {
      if (this.tombstones.has(r.conversation_id)) continue
      const key = `${r.conversation_id}\0${r.entry_id}`
      if (seen.has(key)) continue
      seen.add(key)
      const rawTitle = this.convs.get(r.conversation_id)?.title ?? r.title
      const title = this.ftsRedact(rawTitle)
      const safeBody = this.ftsRedact(r.body)
      const { snippet, highlights } = buildSearchSnippet(safeBody, parsed.terms)
      if (highlights.length > 0) {
        bodyMatchedConvs.add(r.conversation_id)
        candidates.push({
          isBodyMatch: true,
          hit: {
            conversationId: r.conversation_id,
            entryId: r.entry_id,
            ...(title !== '' ? { title } : {}),
            snippet,
            highlights,
          },
        })
      } else {
        if (titleOnlyConvs.has(r.conversation_id) || bodyMatchedConvs.has(r.conversation_id)) continue
        titleOnlyConvs.add(r.conversation_id)
        candidates.push({
          isBodyMatch: false,
          hit: {
            conversationId: r.conversation_id,
            ...(title !== '' ? { title } : {}),
            snippet,
            highlights,
          },
        })
      }
    }
    const out: SearchHit[] = []
    for (const candidate of candidates) {
      if (!candidate.isBodyMatch && bodyMatchedConvs.has(candidate.hit.conversationId)) continue
      out.push(candidate.hit)
      if (out.length >= sqlQuery.limit) break
    }
    return out
  }

  /**
   * Delete specific FTS entries in a conversation (cleans truncated entries' derived index on in-place overwrite).
   * Touches only `helmx_conversation_fts` derived table without affecting `pi_` semantics; no-ops on empty list.
   */
  removeFtsEntries(conversationId: number, entryIds: ReadonlyArray<string>): void {
    if (entryIds.length === 0) return
    this.assertWritable()
    const ids = [...entryIds]
    if (this.ftsRebuildOverlay !== null) {
      this.ftsRebuildOverlay.push({ op: 'removeEntries', conversationId, entryIds: ids })
    }
    this.enqueue(() =>
      this.db.transaction(async (tx) => {
        for (const entryId of ids) {
          const existing = await tx.get<{ fts_rowid: number }>(
            'SELECT fts_rowid FROM helmx_fts_map WHERE conversation_id = ? AND entry_id = ?',
            conversationId,
            entryId,
          )
          if (existing !== undefined) {
            await tx.run('DELETE FROM helmx_conversation_fts WHERE rowid = ?', existing.fts_rowid)
            await tx.run(
              'DELETE FROM helmx_fts_map WHERE conversation_id = ? AND entry_id = ?',
              conversationId,
              entryId,
            )
          }
        }
      }),
    )
  }

  /**
   * FTS is a rebuildable derived index: clearing + replaying all conversation text + stamping `fts_schema_version`
   * run inside **the same transaction**, rolling back atomically on failure (preserving the previous index rather
   * than dropping it and faking success). Concurrent rebuilds are serialized and live mutations during async replay
   * are captured in an overlay and folded atomically before swap so no writes are lost and no deleted conversations resurrect.
   */
  async rebuildFts(
    replay: (
      index: (conversationId: number, entryId: string, title: string, body: string) => void,
    ) => Promise<void>,
  ): Promise<void> {
    this.assertWritable()
    const run = this.ftsRebuildChain.then(() => this.runRebuildFts(replay))
    this.ftsRebuildChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async runRebuildFts(
    replay: (
      index: (conversationId: number, entryId: string, title: string, body: string) => void,
    ) => Promise<void>,
  ): Promise<void> {
    this.assertWritable()
    await this.flushPublic()
    const overlay: FtsRebuildOverlayOp[] = []
    this.ftsRebuildOverlay = overlay
    const batch = new Map<string, [number, string, string, string]>()
    try {
      await replay((conversationId, entryId, title, body) => {
        batch.set(`${conversationId}\0${entryId}`, [
          conversationId,
          entryId,
          this.ftsRedact(title),
          this.ftsRedact(body),
        ])
      })
      // Drain every persistence write queued during async replay until the tail chain is completely quiescent.
      for (;;) {
        const snapshotTail = this.tail
        await this.flushPublic()
        if (this.tail === snapshotTail) break
      }
      this.assertWritable()
      for (const op of overlay) {
        if (op.op === 'upsert') {
          batch.set(`${op.conversationId}\0${op.entryId}`, [op.conversationId, op.entryId, op.title, op.body])
        } else if (op.op === 'removeEntries') {
          for (const entryId of op.entryIds) batch.delete(`${op.conversationId}\0${entryId}`)
        } else if (op.op === 'deleteConv') {
          const prefix = `${op.conversationId}\0`
          for (const key of [...batch.keys()]) {
            if (key.startsWith(prefix)) batch.delete(key)
          }
        } else if (op.op === 'updateTitle') {
          const prefix = `${op.conversationId}\0`
          for (const [key, row] of batch) {
            if (key.startsWith(prefix)) row[2] = op.title
          }
        }
      }
      for (const [key, row] of [...batch.entries()]) {
        if (this.tombstones.has(row[0])) {
          batch.delete(key)
          continue
        }
        const liveConv = this.convs.get(row[0])
        if (liveConv !== undefined) row[2] = this.ftsRedact(liveConv.title)
      }
      this.ftsRebuildOverlay = null

      await this.db.transaction(async (tx) => {
        await tx.exec('DELETE FROM helmx_conversation_fts')
        await tx.exec('DELETE FROM helmx_fts_map')
        let nextRowId = 0
        for (const [conversationId, entryId, title, body] of batch.values()) {
          nextRowId += 1
          await tx.run(
            'INSERT INTO helmx_conversation_fts (rowid, conversation_id, entry_id, title, body) VALUES (?, ?, ?, ?, ?)',
            nextRowId,
            conversationId,
            entryId,
            title,
            body,
          )
          await tx.run(
            'INSERT INTO helmx_fts_map (conversation_id, entry_id, fts_rowid) VALUES (?, ?, ?)',
            conversationId,
            entryId,
            nextRowId,
          )
        }
        await tx.run(
          'INSERT INTO helmx_seq (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          FTS_SCHEMA_VERSION_KEY,
          FTS_SCHEMA_VERSION,
        )
      })
      this.ftsSchemaVersion = FTS_SCHEMA_VERSION
    } finally {
      if (this.ftsRebuildOverlay === overlay) {
        this.ftsRebuildOverlay = null
      }
    }
  }

  // ---------------- flush ----------------

  /**
   * External flush port (used by `documentStore.flush`): awaits full drain of the tail chain (real drain,
   * zero polling, no early return); throws `HelmxError` if any persistence error occurred so callers (e.g.
   * Workflow `state.flush`) can halt downstream side effects instead of falsely assuming success.
   */
  async flushPublic(): Promise<void> {
    await this.tail
    if (this.firstError !== undefined) {
      throw new HelmxError(
        'store_flush_failed',
        `Persistence queue contains failed writes; data integrity is not guaranteed: ${String(this.firstError)}`,
        500,
        { error: String(this.firstError) },
      )
    }
  }

  private enqueue(fn: Deferred): void {
    if (this.closed) throw new HelmxError('store_closed', 'HelmxStore is already closed; rejecting new write', 409)
    if (this.firstError !== undefined) {
      throw new HelmxError(
        'store_flush_failed',
        `Persistence already failed; rejecting new write (refusing false success): ${String(this.firstError)}`,
        500,
        { error: String(this.firstError) },
      )
    }
    // Serial tail chain: errors are caught and recorded inside the chain so it stays unbroken and strictly FIFO.
    this.tail = this.tail.then(fn).catch((error: unknown) => {
      const isFirst = this.firstError === undefined
      this.markFailed(error)
      if (isFirst) this.reportError(error)
    })
  }

  private reportError(error: unknown): void {
    if (this.onError !== undefined) {
      try {
        this.onError(error)
      } catch {
        /* reporting itself must not throw */
      }
      return
    }
    emitDiagnostic(this.onDiagnostic, (text) => (this.redactFn ?? this.ftsRedact)(text), {
      level: 'error',
      source: 'store',
      message: 'store persistence error',
      error,
    })
  }

  /** Pre-write check: reject explicitly when closed or failed, never pretending an enqueue succeeded. */
  private assertWritable(): void {
    if (this.closed) throw new HelmxError('store_closed', 'HelmxStore is already closed; rejecting new write', 409)
    if (this.firstError !== undefined) {
      throw new HelmxError(
        'store_flush_failed',
        `Persistence already failed; rejecting new write (refusing false success): ${String(this.firstError)}`,
        500,
        { error: String(this.firstError) },
      )
    }
  }

  private markFailed(error: unknown): void {
    if (this.firstError === undefined) this.firstError = error
  }

  /** Await full completion of in-flight flushes and FTS rebuilds before exit; returns the first persistence error (honest reporting, never swallowed). */
  async close(): Promise<unknown> {
    await this.ftsRebuildChain
    await this.tail
    this.closed = true
    return this.firstError
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

/** Validate persisted JSON: fails explicitly on corruption (with location context) rather than falling back to empty values. */
function parseStoredJson<T>(what: string, raw: string): T {
  if (typeof raw !== 'string') {
    throw new HelmxError(
      'store_data_corrupted',
      `Persisted data corrupted (${what}): expected JSON string, got ${raw === null ? 'null' : typeof raw}`,
      500,
      { what },
    )
  }
  try {
    return JSON.parse(raw) as T
  } catch (cause) {
    throw new HelmxError(
      'store_data_corrupted',
      `Persisted data corrupted (${what}): JSON parse failed: ${String(cause)}`,
      500,
      { what, raw: raw.slice(0, 200), cause: String(cause) },
    )
  }
}

function parseStoredStringArray(what: string, raw: string): string[] {
  const parsed = parseStoredJson<unknown>(what, raw)
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new HelmxError(
      'store_data_corrupted',
      `Persisted data corrupted (${what}): expected JSON array of strings`,
      500,
      { what, raw: raw.slice(0, 200) },
    )
  }
  return parsed
}

function isValidAskStatus(value: unknown): value is AskRow['status'] {
  return value === 'pending' || value === 'answered' || value === 'cancelled' || value === 'superseded'
}

function parseStoredAskSpec(
  what: string,
  raw: string,
  expected: { id: string; conversationId: number; status: AskRow['status']; expectedStateSeq?: number },
): Record<string, unknown> {
  const parsed = parseStoredJson<unknown>(what, raw)
  const corrupted = (reason: string): HelmxError =>
    new HelmxError(
      'store_data_corrupted',
      `Persisted data corrupted (${what}): ${reason}`,
      500,
      { what, raw: raw.slice(0, 200) },
    )
  if (!isPlainObject(parsed)) throw corrupted('expected JSON object for AskSpec')
  if (typeof parsed.id !== 'string' || parsed.id.length === 0) throw corrupted('missing or invalid spec.id')
  if (parsed.id !== expected.id) throw corrupted(`spec.id '${parsed.id}' does not match row id '${expected.id}'`)
  if (typeof parsed.title !== 'string') throw corrupted('missing or invalid spec.title')
  if (!isValidAskStatus(parsed.status)) throw corrupted(`invalid spec.status '${String(parsed.status)}'`)
  if (parsed.status !== expected.status) {
    throw corrupted(`spec.status '${parsed.status}' does not match row status '${expected.status}'`)
  }
  if (parsed.conversationId !== undefined) {
    if (!Number.isInteger(parsed.conversationId) || parsed.conversationId !== expected.conversationId) {
      throw corrupted(`spec.conversationId '${String(parsed.conversationId)}' does not match row conversationId ${expected.conversationId}`)
    }
  }
  if (parsed.createdAt !== undefined && (typeof parsed.createdAt !== 'number' || !Number.isFinite(parsed.createdAt))) {
    throw corrupted('invalid spec.createdAt')
  }
  if (parsed.expectedStateSeq !== undefined) {
    if (
      typeof parsed.expectedStateSeq !== 'number' ||
      !Number.isSafeInteger(parsed.expectedStateSeq) ||
      parsed.expectedStateSeq < 0
    ) {
      throw corrupted('invalid spec.expectedStateSeq')
    }
    if (expected.expectedStateSeq !== undefined && parsed.expectedStateSeq !== expected.expectedStateSeq) {
      throw corrupted(`spec.expectedStateSeq ${parsed.expectedStateSeq} does not match row expectedStateSeq ${expected.expectedStateSeq}`)
    }
  }
  if (parsed.description !== undefined && typeof parsed.description !== 'string') {
    throw corrupted('invalid spec.description')
  }
  if (parsed.ownerPluginId !== undefined && typeof parsed.ownerPluginId !== 'string') {
    throw corrupted('invalid spec.ownerPluginId')
  }
  if (!Array.isArray(parsed.fields)) throw corrupted('spec.fields must be an array')
  for (const field of parsed.fields as unknown[]) {
    if (
      !isPlainObject(field) ||
      typeof field.name !== 'string' ||
      field.name.length === 0 ||
      typeof field.label !== 'string' ||
      (field.type !== 'text' && field.type !== 'select' && field.type !== 'confirm')
    ) {
      throw corrupted('spec.fields contains an invalid field entry')
    }
    if (field.required !== undefined && typeof field.required !== 'boolean') {
      throw corrupted(`field '${field.name}' has invalid required flag`)
    }
    if (field.type === 'select') {
      if (
        !Array.isArray(field.options) ||
        (field.options as unknown[]).some(
          (o) =>
            !isPlainObject(o) ||
            typeof o.value !== 'string' ||
            o.value.length === 0 ||
            (o.label !== undefined && typeof o.label !== 'string'),
        )
      ) {
        throw corrupted(`select field '${field.name}' has invalid options`)
      }
    }
  }
  return parsed
}

function parseStoredAskResult(what: string, raw: string): Record<string, string> {
  const parsed = parseStoredJson<unknown>(what, raw)
  if (!isPlainObject(parsed) || Object.values(parsed).some((v) => typeof v !== 'string')) {
    throw new HelmxError(
      'store_data_corrupted',
      `Persisted data corrupted (${what}): expected JSON object mapping field names to strings`,
      500,
      { what, raw: raw.slice(0, 200) },
    )
  }
  return parsed as Record<string, string>
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

export function summaryOf(
  meta: ConvMeta,
  status: ConversationStatus,
  pendingAskCount: number,
  doing?: string,
  lastError?: string,
  lastEntryId?: number,
  pendingAskSince?: number,
): ConversationSummary {
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
