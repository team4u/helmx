/**
 * `AskRepo`: table-scoped mirror, per-conversation secondary index, and structural validators
 * (`parseStoredAskSpec`, `parseStoredAskResult`) for `helmx_asks`.
 */

import { HelmxError, isPlainObject, parseLocalizedText } from '@helmx/protocol'
import type { SqliteExecutor } from '@earendil-works/chord/sqlite'
import { addConvIndex, parseStoredJson, removeConvIndex } from './shared.js'
import type { SqliteMirrorQueue } from './write-queue.js'

export interface AskRow {
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

export class AskRepo {
  private readonly asks = new Map<string, AskRow>()
  private readonly asksByConv = new Map<number, Set<string>>()

  constructor(private readonly queue: SqliteMirrorQueue) {}

  async load(): Promise<void> {
    for (const row of await this.queue.db.all<{
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
      addConvIndex(this.asksByConv, row.conversation_id, row.id)
    }
  }

  list(status?: string): AskRow[] {
    return [...this.asks.values()]
      .filter((a) => (status ? a.status === status : true))
      .map((a) => ({ ...a }))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  listByConversation(conversationId: number, status?: string): AskRow[] {
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

  countByConversation(conversationId: number, status?: string): number {
    const ids = this.asksByConv.get(conversationId)
    if (ids === undefined || ids.size === 0) return 0
    if (status === undefined) return ids.size
    let count = 0
    for (const id of ids) {
      if (this.asks.get(id)?.status === status) count += 1
    }
    return count
  }

  get(id: string): AskRow | undefined {
    const row = this.asks.get(id)
    return row ? { ...row } : undefined
  }

  /**
   * Earliest `createdAt` (epoch ms) among currently pending AskDocs for `conversationId`,
   * derived directly from the per-conversation `asksByConv` index (O(k), zero dual-write).
   */
  earliestPendingCreatedAt(conversationId: number): number | undefined {
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
  put(row: AskRow): void {
    this.queue.assertWritable()
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
      removeConvIndex(this.asksByConv, prev.conversationId, row.id)
    }
    this.asks.set(row.id, { ...row })
    addConvIndex(this.asksByConv, row.conversationId, row.id)
    this.queue.enqueue(() =>
      this.queue.db.run(
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

  deleteByConversationInMemory(conversationId: number): void {
    const askIds = this.asksByConv.get(conversationId)
    if (askIds === undefined) return
    for (const askId of askIds) this.asks.delete(askId)
    this.asksByConv.delete(conversationId)
  }

  deleteByConversationInTx(tx: SqliteExecutor, conversationId: number): Promise<void> {
    return tx.run('DELETE FROM helmx_asks WHERE conversation_id = ?', conversationId)
  }
}

export function isValidAskStatus(value: unknown): value is AskRow['status'] {
  return value === 'pending' || value === 'answered' || value === 'cancelled' || value === 'superseded'
}

export function parseStoredAskSpec(
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
  if (parseLocalizedText(parsed.title) === undefined) throw corrupted('missing or invalid spec.title')
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
  if (expected.expectedStateSeq !== undefined) {
    if (
      typeof expected.expectedStateSeq !== 'number' ||
      !Number.isSafeInteger(expected.expectedStateSeq) ||
      expected.expectedStateSeq < 0
    ) {
      throw corrupted('invalid row expectedStateSeq')
    }
    if (parsed.expectedStateSeq === undefined) {
      throw corrupted(`row expectedStateSeq ${expected.expectedStateSeq} present without spec.expectedStateSeq`)
    }
  }
  if (parsed.expectedStateSeq !== undefined) {
    if (
      typeof parsed.expectedStateSeq !== 'number' ||
      !Number.isSafeInteger(parsed.expectedStateSeq) ||
      parsed.expectedStateSeq < 0
    ) {
      throw corrupted('invalid spec.expectedStateSeq')
    }
    if (expected.expectedStateSeq === undefined) {
      throw corrupted(`spec.expectedStateSeq ${parsed.expectedStateSeq} missing from row expectedStateSeq`)
    }
    // `expected_state_seq` persists the effective live CAS ceiling (spec.expectedStateSeq plus any creation-time
    // `onConvPendingChanged` self-bump), so it must always be >= spec.expectedStateSeq.
    if (expected.expectedStateSeq < parsed.expectedStateSeq) {
      throw corrupted(`row expectedStateSeq ${expected.expectedStateSeq} is below spec.expectedStateSeq ${parsed.expectedStateSeq}`)
    }
  }
  if (parsed.description !== undefined && parseLocalizedText(parsed.description) === undefined) {
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
      parseLocalizedText(field.label) === undefined ||
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
            (o.label !== undefined && parseLocalizedText(o.label) === undefined),
        )
      ) {
        throw corrupted(`select field '${field.name}' has invalid options`)
      }
    }
  }
  return parsed
}

export function parseStoredAskResult(what: string, raw: string): Record<string, string> {
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
