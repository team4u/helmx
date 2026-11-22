/**
 * Single unified `state.sqlite`: pi-durable generated tables (`pi_` prefix) + helmx-owned tables + FTS5 derived index.
 * All SQL goes through the same `NodeSqliteDatabase` adapter serialized queue (during transactions the adapter
 * queues other operations; raw calls bypassing this facade can conflict with pi transactions or roll back each
 * other) — never open a second connection.
 * Persistence PRAGMAs are configured explicitly when opening via the adapter: `journal_mode=WAL`,
 * `synchronous=NORMAL`, `busy_timeout=5000ms`, `wal_autocheckpoint=1000` pages.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite'
import type { SqliteStorage as SqliteStorageT } from '@earendil-works/pi-durable/storage/sqlite'
import type { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { join } from 'node:path'

export interface HelmxDatabase {
  storage: SqliteStorageT
  /** Read/write access for helmx-owned tables, serialized on the same database connection. */
  db: NodeSqliteDatabase
  /** Idempotent close: repeated calls (e.g. after `harness.close` closes storage) will not throw. */
  close(): Promise<void>
}

const HELMX_SCHEMA = `
CREATE TABLE IF NOT EXISTS helmx_conversations (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  profile_id TEXT NOT NULL DEFAULT 'default',
  tags TEXT NOT NULL DEFAULT '[]',
  parent_conversation_id INTEGER,
  parent_tool_call_id TEXT,
  node_id TEXT NOT NULL DEFAULT 'local',
  cwd TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  model_override TEXT,
  thinking_level TEXT NOT NULL DEFAULT '',
  thinking_level_override TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  state_change_seq INTEGER NOT NULL DEFAULT 1,
  completion_seq INTEGER NOT NULL DEFAULT 0,
  run_duration_ms INTEGER NOT NULL DEFAULT 0,
  run_started_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS helmx_asks (
  id TEXT PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  owner_plugin_id TEXT,
  spec TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  expected_state_seq INTEGER,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE TABLE IF NOT EXISTS helmx_artifacts (
  id TEXT PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS helmx_artifacts_conv ON helmx_artifacts (conversation_id);
CREATE TABLE IF NOT EXISTS helmx_plugin_docs (
  plugin_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, name)
);
CREATE TABLE IF NOT EXISTS helmx_plugin_session_docs (
  plugin_id TEXT NOT NULL,
  name TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, name, conversation_id)
);
CREATE INDEX IF NOT EXISTS helmx_plugin_session_docs_conv
  ON helmx_plugin_session_docs (conversation_id);
CREATE TABLE IF NOT EXISTS helmx_seq (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS helmx_tombstones (
  id INTEGER PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);
`

/**
 * Derived FTS5 schema version persisted under `helmx_seq.key = 'fts_schema_version'`.
 * Bump whenever the FTS5 tokenizer or indexed column shape changes so startup detects
 * the mismatch (and recovers from mid-rebuild crashes) and rebuilds the derived index once.
 */
export const FTS_SCHEMA_VERSION = 2
export const FTS_SCHEMA_VERSION_KEY = 'fts_schema_version'

/**
 * Separate FTS5 table creation: `trigram` enables CJK/substring full-text indexing across `title` and `body`.
 * The `body` column stores redacted plain text (secret values are never persisted).
 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS helmx_conversation_fts USING fts5(
  conversation_id UNINDEXED,
  entry_id UNINDEXED,
  title,
  body,
  tokenize='trigram'
);
`

/**
 * Ensure `helmx_conversation_fts` exists inside one atomic transaction:
 * - Already exists: fast path, skip both write transactions and `pi_` history probes.
 * - Brand-new empty DB (both `helmx_conversations` and authoritative `pi_` history are empty):
 *   creates the trigram table and marks `fts_schema_version = FTS_SCHEMA_VERSION` (no rebuild needed).
 * - Missing derived FTS table when `helmx_conversations` or `pi_` history already has conversations:
 *   creates the trigram table and persists `fts_schema_version = 0` so startup rebuilds (even across crashes).
 */
async function ensureFtsSchema(
  db: NodeSqliteDatabase,
  hasPiHistory: () => Promise<boolean>,
): Promise<void> {
  const existing = await db.get<{ sql: string | null }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'helmx_conversation_fts'",
  )
  if (existing !== undefined) return

  const piHistoryPresent = await hasPiHistory()
  await db.transaction(async (tx) => {
    const current = await tx.get<{ sql: string | null }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'helmx_conversation_fts'",
    )
    if (current !== undefined) return
    await tx.exec(FTS_SCHEMA)
    const hasConvs = await tx.get<{ present: number }>('SELECT 1 AS present FROM helmx_conversations LIMIT 1')
    const initialVersion = !piHistoryPresent && hasConvs === undefined ? FTS_SCHEMA_VERSION : 0
    await tx.run(
      'INSERT INTO helmx_seq (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      FTS_SCHEMA_VERSION_KEY,
      initialVersion,
    )
  })
}

/**
 * Open (or create) the single `state.sqlite`; pi tables and helmx tables share one connection and transaction queue.
 * The adapter is built by `openNodeSqliteDatabase` (single connection, WAL, `synchronous=NORMAL`,
 * `busy_timeout=5s`; do not touch raw `node:sqlite` handles directly).
 */
export async function openHelmxDatabase(dataDir: string): Promise<HelmxDatabase> {
  const statePath = join(dataDir, 'state.sqlite')
  const db = await openNodeSqliteDatabase(statePath)
  // Proxy view: pi-durable `SqliteStorage` and `HelmxStore` share the underlying connection and serialized
  // transaction queue, so `harness.close() -> storage.close()` must not disconnect the underlying `db` prematurely
  // (closed solely by `teardownKernelRuntime` via trailing `database.close()`).
  const storageDb: SqliteDatabase = {
    exec: (sql) => db.exec(sql),
    run: (sql, ...params) => db.run(sql, ...params),
    runCounted: (sql, ...params) => db.runCounted(sql, ...params),
    get: (sql, ...params) => db.get(sql, ...params),
    all: (sql, ...params) => db.all(sql, ...params),
    transaction: (callback) => db.transaction(callback),
    close: async () => {},
  }
  let storage: SqliteStorageT
  try {
    storage = await SqliteStorage.open(storageDb, { prefix: 'pi_' })
    // Run helmx table DDL through the adapter queue as well to avoid racing pi initialization. Use latest schema directly during dev.
    await db.exec(HELMX_SCHEMA)
    // Lazy read-only probe via official SqliteStorage API (only invoked when helmx_conversation_fts is absent;
    // steady-state restarts never touch pi history): if pi history exists, leave fts_schema_version = 0 for rebuild.
    await ensureFtsSchema(db, async () => {
      const piProbe = await storage.scanConversations({} as never, 1, undefined, BACKGROUND_CONTEXT)
      return piProbe.items.length > 0
    })
  } catch (error) {
    await db.close().catch(() => {})
    throw error
  }
  let closed = false
  return {
    storage,
    db,
    async close() {
      // Idempotent: `harness.close()` may already close `storage` (`storageDb.close` is a no-op;
      // the underlying `db` is closed only here). Keep `storage.close()` fallback for test paths opening `HelmxDatabase` standalone.
      if (closed) return
      closed = true
      await storage.close(BACKGROUND_CONTEXT)
      await db.close()
    },
  }
}
