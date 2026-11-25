/**
 * `SqliteMirrorQueue`: shared single-connection FIFO write queue and fail-closed persistence circuit breaker.
 *
 * All helmx-owned table repositories share this queue so SQL runs serially on one `NodeSqliteDatabase`
 * connection alongside `pi_` tables:
 * - First persistence error is latched and reported explicitly (via `onError` or redacted diagnostic channel);
 * - `flushPublic()` drains the FIFO tail chain and throws `HelmxError('store_flush_failed')` on any unsettled failure;
 * - Subsequent writes fail closed once in failed or closed state (never faking enqueue success);
 * - `close()` awaits full drain of in-flight writes and returns the first persistence error without swallowing it.
 */

import { HelmxError } from '@helmx/protocol'
import type { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { emitDiagnostic, type KernelDiagnosticSink } from '../diagnostics.js'

export type SqliteWriteTask = () => Promise<void>

export interface SqliteMirrorQueueOptions {
  /** Instance-level persistence failure callback (e.g., `KernelRuntime` fatal storage closure hook); falls back to diagnostic channel. */
  readonly onError?: (error: unknown) => void
  /** Diagnostic channel sink (fallback when `onError` is unset; defaults to `console.error`). */
  readonly onDiagnostic?: KernelDiagnosticSink
  /** Diagnostic redaction function. */
  readonly redact?: (text: string) => string
  /** Dynamic fallback redaction resolver when `redact` is omitted (e.g. store `ftsRedact`). */
  readonly fallbackRedact?: () => (text: string) => string
}

export class SqliteMirrorQueue {
  readonly db: NodeSqliteDatabase
  private readonly onError: ((error: unknown) => void) | undefined
  private readonly onDiagnostic: KernelDiagnosticSink | undefined
  private readonly redactFn: ((text: string) => string) | undefined
  private readonly fallbackRedact: (() => (text: string) => string) | undefined
  /**
   * Persistence tail chain: all enqueued writes execute serially in FIFO order.
   * The chain itself never rejects (errors are caught and recorded internally), so `flushPublic`/`close` simply await it.
   */
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  /** First persistence error; once set, the store enters failed state and rejects subsequent writes. */
  private firstError: unknown = undefined

  constructor(db: NodeSqliteDatabase, options: SqliteMirrorQueueOptions = {}) {
    this.db = db
    this.onError = options.onError
    this.onDiagnostic = options.onDiagnostic
    this.redactFn = options.redact
    this.fallbackRedact = options.fallbackRedact
  }

  /** First persistence failure error (read-only; `undefined` when healthy). */
  get error(): unknown {
    return this.firstError
  }

  /** Pre-write check: reject explicitly when closed or failed, never pretending an enqueue succeeded. */
  assertWritable(): void {
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

  enqueue(fn: SqliteWriteTask): void {
    this.assertWritable()
    // Serial tail chain: errors are caught and recorded inside the chain so it stays unbroken and strictly FIFO.
    this.tail = this.tail.then(fn).catch((error: unknown) => {
      const isFirst = this.firstError === undefined
      this.markFailed(error)
      if (isFirst) this.reportError(error)
    })
  }

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

  /** Drain every persistence write queued while an async operation (e.g. FTS replay) runs until quiescent. */
  async drainQuiescent(): Promise<void> {
    for (;;) {
      const snapshotTail = this.tail
      await this.flushPublic()
      if (this.tail === snapshotTail) break
    }
  }

  /** Await full completion of in-flight flushes before exit; returns the first persistence error (honest reporting, never swallowed). */
  async close(): Promise<unknown> {
    await this.tail
    this.closed = true
    return this.firstError
  }

  private markFailed(error: unknown): void {
    if (this.firstError === undefined) this.firstError = error
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
    const redact = this.redactFn ?? this.fallbackRedact?.()
    emitDiagnostic(this.onDiagnostic, redact, {
      level: 'error',
      source: 'store',
      message: 'store persistence error',
      error,
    })
  }
}
