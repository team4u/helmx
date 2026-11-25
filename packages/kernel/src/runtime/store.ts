/**
 * `HelmxStore`: thin composition facade over table-scoped repositories sharing a single `SqliteMirrorQueue`.
 *
 * All SQL runs through the single `NodeSqliteDatabase` adapter (sharing a transaction queue with `pi_` tables);
 * never open a second connection. In-memory mirrors support synchronous reads (`listConvs`, etc.); writes
 * update mirrors synchronously and enqueue SQLite persistence onto the shared FIFO queue (`write-queue.ts`).
 */

import type { ConversationOwnership, SearchHit } from '@helmx/protocol'
import type { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { KernelDiagnosticSink } from './diagnostics.js'
import type { SearchOptions } from './fts-search.js'
import type { HelmxDatabase } from './sqlite.js'
import { AskRepo, type AskRow } from './store/ask-repo.js'
import { ArtifactRepo, type ArtifactRow } from './store/artifact-repo.js'
import {
  ConversationRepo,
  convStatusOf,
  summaryOf,
  type ConvMeta,
} from './store/conversation-repo.js'
import { FtsRepo } from './store/fts-repo.js'
import { PluginDocRepo } from './store/plugin-doc-repo.js'
import { PluginKvRepo } from './store/plugin-kv-repo.js'
import { PluginSessionDocRepo } from './store/plugin-session-doc-repo.js'
import { SeqRepo } from './store/seq-repo.js'
import { TombstoneRepo } from './store/tombstone-repo.js'
import { SqliteMirrorQueue } from './store/write-queue.js'

export { convStatusOf, summaryOf, type ConvMeta }

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
  private readonly queue: SqliteMirrorQueue
  private readonly convRepo: ConversationRepo
  private readonly askRepo: AskRepo
  private readonly artifactRepo: ArtifactRepo
  private readonly docRepo: PluginDocRepo
  private readonly sessionDocRepo: PluginSessionDocRepo
  private readonly kvRepo: PluginKvRepo
  private readonly seqRepo: SeqRepo
  private readonly tombstoneRepo: TombstoneRepo
  private readonly ftsRepo: FtsRepo
  /** Text redaction hook for FTS indexing (runtime injects `stash.redact`). */
  ftsRedact: (text: string) => string = (t) => t

  constructor(database: HelmxDatabase, options: HelmxStoreOptions = {}) {
    this.db = database.db
    this.queue = new SqliteMirrorQueue(this.db, {
      onError: options.onError,
      onDiagnostic: options.onDiagnostic,
      redact: options.redact,
      fallbackRedact: () => this.ftsRedact,
    })
    this.convRepo = new ConversationRepo(this.queue)
    this.askRepo = new AskRepo(this.queue)
    this.artifactRepo = new ArtifactRepo(this.queue)
    this.docRepo = new PluginDocRepo(this.queue)
    this.sessionDocRepo = new PluginSessionDocRepo(this.queue)
    this.kvRepo = new PluginKvRepo(this.queue)
    this.seqRepo = new SeqRepo(this.queue)
    this.tombstoneRepo = new TombstoneRepo(this.queue)
    this.ftsRepo = new FtsRepo(this.queue, {
      redact: (text) => this.ftsRedact(text),
      isDeleted: (id) => this.tombstoneRepo.isDeleted(id),
      getLiveTitle: (id) => this.convRepo.getLiveTitle(id),
      markFtsRebuiltInTx: (tx) => this.seqRepo.markFtsRebuiltInTx(tx),
      onFtsRebuilt: () => this.seqRepo.markFtsSchemaCurrent(),
    })
  }

  /** First persistence failure error (read-only; `undefined` when healthy). */
  get error(): unknown {
    return this.queue.error
  }

  /** Load all mirrors from SQLite at startup; throws explicitly on corrupted persisted JSON (never fabricates empty values). */
  async load(): Promise<void> {
    await this.convRepo.load()
    await this.askRepo.load()
    await this.artifactRepo.load()
    await this.docRepo.load()
    await this.sessionDocRepo.load()
    await this.kvRepo.load()
    await this.seqRepo.load()
    await this.tombstoneRepo.load()
  }

  /** True when the derived FTS5 table was newly migrated/recreated or a prior rebuild did not finish committing. */
  get needsFtsRebuild(): boolean {
    return this.seqRepo.needsFtsRebuild
  }

  isDeleted(id: number): boolean {
    return this.tombstoneRepo.isDeleted(id)
  }

  get eventSeqNow(): number {
    return this.seqRepo.eventSeqNow
  }

  setEventSeq(seq: number): void {
    this.seqRepo.setEventSeq(seq)
  }

  // ---------------- conversations ----------------

  listConvs(): ConvMeta[] {
    return this.convRepo.list()
  }

  getConv(id: number): ConvMeta | undefined {
    return this.convRepo.get(id)
  }

  setLastEntryId(id: number, lastEntryId: number): void {
    this.convRepo.setLastEntryId(id, lastEntryId)
  }

  setConvOwnership(id: number, owner: ConversationOwnership): boolean {
    return this.convRepo.setOwnership(id, owner, (convId) => this.tombstoneRepo.isDeleted(convId))
  }

  upsertConv(meta: ConvMeta): void {
    this.convRepo.upsert(meta, {
      redactTitle: (title) => this.ftsRedact(title),
      recordTitleChangeOverlay: (convId, redactedTitle) =>
        this.ftsRepo.recordTitleChangeOverlay(convId, redactedTitle),
      updateTitleInTx: (tx, convId, redactedTitle) =>
        this.ftsRepo.updateTitleInTx(tx, convId, redactedTitle),
    })
  }

  /**
   * Delete conversation: tombstone + row cleanup execute atomically in **the same transaction** (prevents crash windows
   * where rows are deleted without a tombstone, causing resurrection on restart). Synchronously cleans up in-memory
   * asks/artifacts/session-docs mirrors; settled Ask history is purged alongside the conversation so mirrors stay consistent.
   */
  deleteConv(id: number): void {
    this.queue.assertWritable()
    this.convRepo.deleteInMemory(id)
    this.tombstoneRepo.markDeletedInMemory(id)
    this.ftsRepo.recordDeleteConvOverlay(id)
    this.askRepo.deleteByConversationInMemory(id)
    this.artifactRepo.deleteByConversationInMemory(id)
    this.sessionDocRepo.deleteByConversationInMemory(id)
    this.queue.enqueue(() =>
      this.db.transaction(async (tx) => {
        await this.tombstoneRepo.insertInTx(tx, id, Date.now())
        await this.convRepo.deleteInTx(tx, id)
        await this.askRepo.deleteByConversationInTx(tx, id)
        await this.artifactRepo.deleteByConversationInTx(tx, id)
        await this.ftsRepo.deleteByConversationInTx(tx, id)
        await this.sessionDocRepo.deleteByConversationInTx(tx, id)
      }),
    )
  }

  // ---------------- asks ----------------

  listAsks(status?: string): AskRow[] {
    return this.askRepo.list(status)
  }

  listAsksByConversation(conversationId: number, status?: string): AskRow[] {
    return this.askRepo.listByConversation(conversationId, status)
  }

  countAsksByConversation(conversationId: number, status?: string): number {
    return this.askRepo.countByConversation(conversationId, status)
  }

  getAsk(id: string): AskRow | undefined {
    return this.askRepo.get(id)
  }

  earliestPendingAskCreatedAt(conversationId: number): number | undefined {
    return this.askRepo.earliestPendingCreatedAt(conversationId)
  }

  putAsk(row: AskRow): void {
    this.askRepo.put(row)
  }

  // ---------------- artifacts ----------------

  listArtifacts(conversationId?: number): ArtifactRow[] {
    return this.artifactRepo.list(conversationId)
  }

  getArtifact(id: string): ArtifactRow | undefined {
    return this.artifactRepo.get(id)
  }

  putArtifact(row: ArtifactRow): void {
    this.artifactRepo.put(row)
  }

  deleteArtifactsByConversation(conversationId: number): string[] {
    return this.artifactRepo.deleteByConversation(conversationId)
  }

  // ---------------- plugin docs ----------------

  getPluginDoc(pluginId: string, name: string): string | undefined {
    return this.docRepo.get(pluginId, name)
  }

  putPluginDoc(pluginId: string, name: string, valueJson: string, options?: { prevalidated?: boolean }): void {
    this.docRepo.put(pluginId, name, valueJson, options)
  }

  deleteGlobalPluginDocs(pluginId: string): void {
    this.docRepo.deleteGlobalPluginDocs(pluginId)
  }

  // ---------------- plugin session docs ----------------

  getPluginSessionDoc(pluginId: string, name: string, conversationId: number): string | undefined {
    return this.sessionDocRepo.get(pluginId, name, conversationId)
  }

  putPluginSessionDoc(
    pluginId: string,
    name: string,
    conversationId: number,
    valueJson: string,
    options?: { prevalidated?: boolean },
  ): void {
    this.sessionDocRepo.put(pluginId, name, conversationId, valueJson, options)
  }

  deletePluginSessionDoc(pluginId: string, name: string, conversationId: number): void {
    this.sessionDocRepo.delete(pluginId, name, conversationId)
  }

  deletePluginSessionDocs(pluginId: string): void {
    this.sessionDocRepo.deleteByPlugin(pluginId)
  }

  listPluginSessionDocConversations(pluginId: string, name: string): number[] {
    return this.sessionDocRepo.listConversations(pluginId, name)
  }

  // ---------------- plugin kv ----------------

  getPluginKv(pluginId: string, namespace: string, key: string): { valueJson: string; updatedAt: number } | undefined {
    return this.kvRepo.get(pluginId, namespace, key)
  }

  putPluginKv(
    pluginId: string,
    namespace: string,
    key: string,
    valueJson: string,
    options?: { prevalidated?: boolean; updatedAt?: number },
  ): number {
    return this.kvRepo.put(pluginId, namespace, key, valueJson, options)
  }

  deletePluginKvKey(pluginId: string, namespace: string, key: string): boolean {
    return this.kvRepo.deleteKey(pluginId, namespace, key)
  }

  listPluginKv(
    pluginId: string,
    namespace: string,
    opts?: { prefix?: string; limit?: number; cursor?: string },
  ): { items: Array<{ key: string; valueJson: string; updatedAt: number }>; nextCursor?: string } {
    return this.kvRepo.list(pluginId, namespace, opts)
  }

  clearPluginKvNamespace(pluginId: string, namespace: string): void {
    this.kvRepo.clearNamespace(pluginId, namespace)
  }

  deletePluginKv(pluginId: string): void {
    this.kvRepo.deletePlugin(pluginId)
  }

  // ---------------- FTS ----------------

  indexFts(conversationId: number, entryId: string, title: string, body: string): void {
    this.ftsRepo.index(conversationId, entryId, title, body)
  }

  search(query: string, options?: SearchOptions): Promise<SearchHit[]> {
    return this.ftsRepo.search(query, options)
  }

  removeFtsEntries(conversationId: number, entryIds: ReadonlyArray<string>): void {
    this.ftsRepo.removeEntries(conversationId, entryIds)
  }

  rebuildFts(
    replay: (
      index: (conversationId: number, entryId: string, title: string, body: string) => void,
    ) => Promise<void>,
  ): Promise<void> {
    return this.ftsRepo.rebuild(replay)
  }

  // ---------------- flush / close ----------------

  flushPublic(): Promise<void> {
    return this.queue.flushPublic()
  }

  /** Await full completion of in-flight FTS rebuilds and queued writes before exit; returns the first persistence error (honest reporting, never swallowed). */
  async close(): Promise<unknown> {
    await this.ftsRepo.waitForRebuild()
    return this.queue.close()
  }
}
