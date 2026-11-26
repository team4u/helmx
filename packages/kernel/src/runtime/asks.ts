/**
 * AskService: AskDoc lifecycle + atomic CAS check against persisted watermark and live conversation stateChangeSeq.
 *
 * Key semantics (honesty first):
 * - createAsk performs full validation first (field types / unique names / pre-allocated ID shape &
 *   uniqueness / conversation existence via validateConversation port), rejecting invalid input before writing to store;
 * - createAsk returns AskResult: all three terminal states (answered/cancelled/superseded) resolve
 *   (answers is {} on cancel/superseded, so cancellation never masquerades as user approval); only validation/IO/host failures reject;
 * - waiters register BEFORE any visible side effects (putAsk/publish): if an ask.upsert subscriber synchronously calls
 *   cancel/answer inside its callback, the promise still settles;
 * - true persistence boundary sits at the end of the store chain: create and settle await store.flushPublic() before resolving or
 *   publishing terminal events; if SQL fails, createAsk rejects explicitly with store_flush_failed;
 * - answer validation rejects unknown fields, non-strings, out-of-range select options, and invalid confirm values;
 * - CAS validates client-supplied expectedStateSeq against persisted spec.expectedStateSeq (mismatched seq -> 409)
 *   and atomically checks the conversation's live stateChangeSeq (if advanced past watermark -> auto-settles as superseded;
 *   if no ask watermark is set and client seq disagrees with live stateChangeSeq -> 409);
 * - after restart, pending asks remain and emit diagnostic notifications.
 */

import type { AskAnswers, AskAnswerValue, AskCreateSpec, AskFieldSpec, AskListFilter, AskResult, AskSpec } from '@helmx/protocol'
import { HelmxError, isPlainObject, parseLocalizedText, parseNonEmptyLocalizedText } from '@helmx/protocol'
import { randomUUID } from 'node:crypto'

import type { HelmxStore } from './store.js'

interface AskSettled {
  askId: string
  status: 'answered' | 'cancelled' | 'superseded'
  answers?: AskAnswers
}

/** Waiter settlement outcome: normal terminal state or host-side failure (IO/persistence), causing createAsk to reject. */
type WaiterOutcome = AskSettled | { failure: unknown }

function redactAnswerValue(value: AskAnswerValue, redact: (text: string) => string): AskAnswerValue {
  return Array.isArray(value) ? value.map((item) => redact(item)) : redact(value)
}

export class AskService {
  private readonly store: HelmxStore
  private readonly waiters = new Map<string, Array<(outcome: WaiterOutcome) => void>>()
  /**
   * Transient synchronous re-entrancy guard active ONLY while `onConvPendingChanged` runs inside `createAsk`:
   * bridges the single-tick window between `onConvPendingChanged` advancing `stateChangeSeq` and the immediate
   * `putAsk` that persists the effective CAS ceiling into `helmx_asks.expected_state_seq`.
   */
  private readonly creatingPendingSeq = new Map<string, number>()
  private readonly onEvent: (type: string, payload: unknown) => void
  private readonly onConvPendingChanged: (conversationId: number) => void
  /** Conversation existence validation port (injected by host; omitted in standalone AskService unit tests). */
  private readonly validateConversation?: (conversationId: number) => boolean | Promise<boolean>
  private readonly assertWritable: () => void
  private readonly redact: (text: string) => string

  constructor(options: {
    store: HelmxStore
    onEvent: (type: string, payload: unknown) => void
    onConvPendingChanged: (conversationId: number) => void
    validateConversation?: (conversationId: number) => boolean | Promise<boolean>
    assertWritable?: () => void
    redact?: (text: string) => string
  }) {
    this.store = options.store
    this.onEvent = options.onEvent
    this.onConvPendingChanged = options.onConvPendingChanged
    this.validateConversation = options.validateConversation
    this.assertWritable = options.assertWritable ?? (() => {})
    this.redact = options.redact ?? ((text) => text)
  }

  listAsks(filter?: string | AskListFilter): AskSpec[] {
    if (filter === undefined) {
      return this.store.listAsks().map((row) => parseAskSpecRow(row))
    }
    if (typeof filter === 'string') {
      return this.store.listAsks(filter).map((row) => parseAskSpecRow(row))
    }
    if (filter.conversationId !== undefined) {
      return this.store
        .listAsksByConversation(filter.conversationId, filter.status)
        .map((row) => parseAskSpecRow(row))
    }
    return this.store.listAsks(filter.status).map((row) => parseAskSpecRow(row))
  }

  listPendingByConversation(conversationId: number): AskSpec[] {
    return this.store
      .listAsksByConversation(conversationId, 'pending')
      .map((row) => parseAskSpecRow(row))
  }

  pendingCount(conversationId: number): AskSpec[]['length'] {
    return this.store.countAsksByConversation(conversationId, 'pending')
  }

  getAsk(id: string): AskSpec | undefined {
    const row = this.store.getAsk(id)
    return row ? parseAskSpecRow(row) : undefined
  }

  /**
   * Create an AskDoc and wait for its terminal state. All three states resolve to AskResult (for cancelled/superseded,
   * answers is {} so callers distinguish via status and cancellations never impersonate approval). Rejects only on
   * validation/IO/host failures.
   *
   * spec.id may be pre-allocated (for correlation and deduplication) and never overwrites an existing ID (including settled approvals).
   */
  async createAsk(spec: AskCreateSpec): Promise<AskResult> {
    this.assertWritable()
    validateAskSpec(spec)
    if (this.validateConversation) {
      const ok = await this.validateConversation(spec.conversationId)
      if (!ok) {
        throw new HelmxError('not_found', `conversation not found: ${spec.conversationId}`, 404)
      }
    }
    const id = spec.id ?? randomUUID()
    // A pre-allocated ID must never overwrite any existing AskDoc (whether pending or already settled).
    if (this.store.getAsk(id) !== undefined) {
      const existing = this.store.getAsk(id)!
      throw new HelmxError(
        'ask_id_conflict',
        `AskDoc ID '${id}' already exists (status ${existing.status}); cannot overwrite existing approval`,
        409,
        { askId: id, existingStatus: existing.status },
      )
    }
    const createdAt = Date.now()
    const full: AskSpec = {
      ...spec,
      id,
      status: 'pending',
      createdAt,
      expectedStateSeq: spec.expectedStateSeq,
    }

    // Waiters must register before any visible side effects: an ask.upsert subscriber might synchronously cancel/answer
    // inside its event callback (settle notifies synchronously), so late registration would hang the promise forever.
    let push!: (outcome: WaiterOutcome) => void
    const settled = new Promise<AskResult>((resolve, reject) => {
      let done = false
      push = (outcome: WaiterOutcome) => {
        if (done) return
        done = true
        const current = this.waiters.get(id)
        if (current) {
          const index = current.indexOf(push)
          if (index >= 0) current.splice(index, 1)
          if (current.length === 0) this.waiters.delete(id)
        }
        if ('failure' in outcome) {
          reject(outcome.failure)
          return
        }
        resolve({
          id,
          status: outcome.status,
          answers: outcome.status === 'answered' ? (outcome.answers ?? {}) : {},
        })
      }
      const list = this.waiters.get(id) ?? []
      list.push(push)
      this.waiters.set(id, list)
    })

    // Propagate async initialization failure so the createAsk promise rejects (no hangs, no fake success).
    void (async () => {
      try {
        this.store.putAsk({
          id,
          conversationId: spec.conversationId,
          ownerPluginId: spec.ownerPluginId,
          specJson: JSON.stringify(full),
          status: 'pending',
          expectedStateSeq: spec.expectedStateSeq,
          createdAt,
        })
        // True persistence boundary: putAsk only updates the mirror and queues SQL; if flushPublic fails,
        // data is not guaranteed intact, so fail explicitly without publishing ask.upsert or faking success.
        await this.store.flushPublic()
        const seqBeforePending = this.store.getConv(spec.conversationId)?.stateChangeSeq
        if (spec.expectedStateSeq !== undefined && seqBeforePending === spec.expectedStateSeq) {
          this.creatingPendingSeq.set(id, spec.expectedStateSeq)
        }
        try {
          this.onConvPendingChanged(spec.conversationId)
        } finally {
          this.creatingPendingSeq.delete(id)
        }
        const seqAfterPending = this.store.getConv(spec.conversationId)?.stateChangeSeq
        if (
          spec.expectedStateSeq !== undefined &&
          seqBeforePending !== undefined &&
          seqAfterPending !== undefined &&
          spec.expectedStateSeq === seqBeforePending &&
          seqAfterPending > seqBeforePending
        ) {
          const currentRow = this.store.getAsk(id)
          if (currentRow !== undefined && currentRow.status === 'pending') {
            // Persist the creation-time self-bump as the effective live CAS ceiling in `helmx_asks.expected_state_seq`
            // while preserving `spec.expectedStateSeq` unchanged as the client-facing watermark, so restarts never
            // lose the self-bump and falsely supersede the first approval.
            this.store.putAsk({
              ...currentRow,
              expectedStateSeq: seqAfterPending,
            })
            await this.store.flushPublic()
          }
        }
        this.onEvent('ask.upsert', full)
      } catch (error) {
        this.creatingPendingSeq.delete(id)
        push({ failure: error })
      }
    })()
    return settled
  }

  /**
   * Submit answers: atomic CAS check (client seq vs declared spec watermark + live conversation stateChangeSeq
   * vs persisted effective CAS ceiling) -> value validation -> settle. Zero awaits between state reads and the
   * mirror transition in `settle`.
   */
  async answerAsk(
    id: string,
    answers: AskAnswers,
    expectedStateSeq?: number,
  ): Promise<AskSpec> {
    this.assertWritable()
    if (expectedStateSeq !== undefined && (!Number.isSafeInteger(expectedStateSeq) || expectedStateSeq < 0)) {
      throw new HelmxError('validation_error', 'expectedStateSeq must be a non-negative safe integer', 400)
    }
    const row = this.store.getAsk(id)
    if (!row) throw new HelmxError('not_found', `AskDoc not found: ${id}`, 404)
    if (row.status !== 'pending') {
      throw new HelmxError('ask_already_settled', `AskDoc is already in ${row.status} state`, 409)
    }
    const spec = parseAskSpecRow(row)
    const declaredWatermark = spec.expectedStateSeq

    // Client-supplied seq differs from declared AskDoc watermark -> 409 stale view (never silently overwrite).
    if (expectedStateSeq !== undefined && declaredWatermark !== undefined && expectedStateSeq !== declaredWatermark) {
      throw new HelmxError(
        'ask_state_conflict',
        `expectedStateSeq=${expectedStateSeq} does not match persisted AskDoc watermark ${declaredWatermark} (stale client view)`,
        409,
        { askId: id, clientSeq: expectedStateSeq, storedSeq: declaredWatermark },
      )
    }

    // Authoritative live conversation stateChangeSeq check (synchronous, zero awaits before mirror settle):
    // - If the AskDoc declared expectedStateSeq, compare live stateChangeSeq against the persisted effective CAS ceiling
    //   (`row.expectedStateSeq`, including any creation-time `onConvPendingChanged` self-bump); if advanced -> supersede.
    // - If the AskDoc declared no watermark but the client supplied expectedStateSeq and live seq disagrees -> 409.
    const conv = this.store.getConv(row.conversationId)
    if (declaredWatermark !== undefined && conv !== undefined) {
      const inSelfPendingBump = this.creatingPendingSeq.get(id) === declaredWatermark
      const effectiveCeiling = inSelfPendingBump
        ? Math.max(row.expectedStateSeq ?? declaredWatermark, conv.stateChangeSeq)
        : (row.expectedStateSeq ?? declaredWatermark)
      if (conv.stateChangeSeq > effectiveCeiling) {
        return this.settle(id, 'superseded')
      }
    } else if (expectedStateSeq !== undefined && conv !== undefined && conv.stateChangeSeq !== expectedStateSeq) {
      throw new HelmxError(
        'ask_state_conflict',
        `expectedStateSeq=${expectedStateSeq} does not match current conversation stateChangeSeq ${conv.stateChangeSeq} (stale client view)`,
        409,
        { askId: id, clientSeq: expectedStateSeq, currentSeq: conv.stateChangeSeq },
      )
    }

    validateAnswersAgainstFields(spec, answers)

    const stored: AskAnswers = {}
    for (const field of spec.fields) {
      const raw = answers[field.name]
      if (field.type === 'choice' && field.multiple === true) {
        stored[field.name] = Array.isArray(raw) ? raw.map((item) => this.redact(item)) : []
      } else {
        stored[field.name] = this.redact(typeof raw === 'string' ? raw : '')
      }
      if (field.type === 'model' && typeof field.thinkingLevelField === 'string' && field.thinkingLevelField !== '') {
        const thinkingRaw = answers[field.thinkingLevelField]
        if (typeof thinkingRaw === 'string') {
          stored[field.thinkingLevelField] = this.redact(thinkingRaw)
        }
      }
    }
    return this.settle(id, 'answered', { answers: stored })
  }

  cancelAsk(id: string, reason: 'cancelled' | 'superseded' = 'cancelled'): Promise<AskSpec> {
    this.assertWritable()
    const row = this.store.getAsk(id)
    if (!row) throw new HelmxError('not_found', `AskDoc not found: ${id}`, 404)
    if (row.status !== 'pending') {
      throw new HelmxError('ask_already_settled', `AskDoc is already in ${row.status} state`, 409)
    }
    return this.settle(id, reason)
  }

  /** Settle all pending asks owned by `ownerPluginId` as `'superseded'` (e.g. startup recovery of orphaned asks). */
  async supersedeOrphanedByOwner(ownerPluginId: string): Promise<number> {
    this.assertWritable()
    const orphaned = this.listAsks('pending').filter((ask) => ask.ownerPluginId === ownerPluginId)
    for (const ask of orphaned) {
      await this.settle(ask.id, 'superseded')
    }
    return orphaned.length
  }

  /** Startup diagnostics: emit notifications for leftover pending asks (never silently swallow). */
  reportOrphans(): void {
    const pending = this.listAsks('pending')
    for (const ask of pending) {
      this.onEvent('notification', {
        level: 'warning',
        title: 'Pending AskDoc remaining after restart',
        body: `AskDoc ${ask.id} (conversation ${ask.conversationId}) did not settle before process restart and remains pending for manual action`,
        conversationId: ask.conversationId,
      })
    }
  }

  /**
   * Cancel all pending asks for a conversation (cascading conversation deletion): attempts to cancel every ask,
   * rejecting honestly if any fails (never swallows IO errors); failed asks have already settled their waiters with failure.
   */
  async cancelByConversation(conversationId: number, reason: 'cancelled' | 'superseded' = 'cancelled'): Promise<void> {
    this.assertWritable()
    const pending = this.listPendingByConversation(conversationId)
    await Promise.all(pending.map((ask) => this.settle(ask.id, reason)))
  }

  private async settle(
    id: string,
    status: 'answered' | 'cancelled' | 'superseded',
    options: { answers?: AskAnswers } = {},
  ): Promise<AskSpec> {
    const row = this.store.getAsk(id)
    if (!row) throw new HelmxError('not_found', `AskDoc not found: ${id}`, 404)
    if (row.status !== 'pending') {
      throw new HelmxError('ask_already_settled', `AskDoc is already in ${row.status} state`, 409)
    }
    try {
      const spec = parseAskSpecRow(row)
      const settledSpec: AskSpec = { ...spec, status }
      // Never write fake answers on cancelled/superseded (result is populated only for answered).
      const answers =
        status === 'answered'
          ? Object.fromEntries(
              Object.entries(options.answers ?? {}).map(([k, v]) => [k, redactAnswerValue(v, this.redact)]),
            )
          : undefined
      this.store.putAsk({
        ...row,
        status,
        specJson: JSON.stringify(settledSpec),
        resultJson: answers !== undefined ? JSON.stringify(answers) : undefined,
        settledAt: Date.now(),
      })
      // Terminal state must persist to disk before emitting events or notifying waiters; SQL failure must never fake a terminal state.
      await this.store.flushPublic()
      this.onConvPendingChanged(spec.conversationId)
      this.onEvent(
        'ask.resolved',
        answers !== undefined ? { askId: id, status, answers } : { askId: id, status },
      )
      const waiters = this.waiters.get(id) ?? []
      this.waiters.delete(id)
      for (const waiter of waiters) waiter({ askId: id, status, answers })
      return settledSpec
    } catch (error) {
      // Any failure in putAsk (incl. sync mirror rejection), flush, callback, or event publish: drain waiters and settle
      // each with failure (no hangs, no fake terminal states), then rethrow honestly.
      const waiters = this.waiters.get(id) ?? []
      this.waiters.delete(id)
      for (const waiter of waiters) waiter({ failure: error })
      throw error
    }
  }
}

function isValidAskFieldRow(f: unknown): boolean {
  if (
    !isPlainObject(f) ||
    typeof f.name !== 'string' ||
    f.name.length === 0 ||
    parseLocalizedText(f.label) === undefined
  ) {
    return false
  }
  if (f.type !== 'text' && f.type !== 'select' && f.type !== 'confirm' && f.type !== 'choice' && f.type !== 'model') {
    return false
  }
  if (f.required !== undefined && typeof f.required !== 'boolean') return false
  if (f.multiple !== undefined && (f.type !== 'choice' || typeof f.multiple !== 'boolean')) return false
  if (f.allowCustom !== undefined && (f.type !== 'choice' || typeof f.allowCustom !== 'boolean')) return false
  if (f.multiline !== undefined && (f.type !== 'text' || typeof f.multiline !== 'boolean')) return false
  if (f.placeholder !== undefined) {
    if (f.type !== 'text' && !(f.type === 'choice' && f.allowCustom === true)) return false
    if (parseLocalizedText(f.placeholder) === undefined) return false
  }
  if (f.confirmLabel !== undefined && (f.type !== 'confirm' || parseNonEmptyLocalizedText(f.confirmLabel) === undefined)) {
    return false
  }
  if (f.rejectLabel !== undefined && (f.type !== 'confirm' || parseNonEmptyLocalizedText(f.rejectLabel) === undefined)) {
    return false
  }
  if (f.defaultValue !== undefined) {
    if (f.type === 'choice' && f.multiple === true) {
      if (
        !Array.isArray(f.defaultValue) ||
        f.defaultValue.some((item) => typeof item !== 'string' || item.trim() === '')
      ) {
        return false
      }
    } else if (typeof f.defaultValue !== 'string') {
      return false
    }
  }
  if (
    f.thinkingLevelField !== undefined &&
    (f.type !== 'model' || typeof f.thinkingLevelField !== 'string' || f.thinkingLevelField.trim() === '')
  ) {
    return false
  }
  if (f.type === 'select' || f.type === 'choice') {
    if (
      !Array.isArray(f.options) ||
      f.options.some(
        (o) =>
          !isPlainObject(o) ||
          typeof o.value !== 'string' ||
          o.value.length === 0 ||
          (o.label !== undefined && parseLocalizedText(o.label) === undefined) ||
          (o.description !== undefined && parseLocalizedText(o.description) === undefined) ||
          (o.recommended !== undefined && typeof o.recommended !== 'boolean'),
      )
    ) {
      return false
    }
  }
  return true
}

/** Parse and structurally validate a persisted AskRow specJson (fails loudly with store_data_corrupted instead of raw SyntaxError/TypeError). */
function parseAskSpecRow(row: { id: string; specJson: string }): AskSpec {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.specJson)
  } catch (cause) {
    throw new HelmxError(
      'store_data_corrupted',
      `Persisted AskDoc spec corrupted (ask ${row.id}): JSON parse failed: ${String(cause)}`,
      500,
      { askId: row.id, cause: String(cause) },
    )
  }
  if (
    !isPlainObject(parsed) ||
    typeof parsed.id !== 'string' ||
    parsed.id.length === 0 ||
    !Number.isInteger(parsed.conversationId) ||
    (parsed.conversationId as number) <= 0 ||
    (parsed.kind !== undefined && parsed.kind !== 'question' && parsed.kind !== 'approval') ||
    parseLocalizedText(parsed.title) === undefined ||
    (parsed.description !== undefined && parseLocalizedText(parsed.description) === undefined) ||
    (parsed.hint !== undefined && parseLocalizedText(parsed.hint) === undefined) ||
    (parsed.status !== 'pending' &&
      parsed.status !== 'answered' &&
      parsed.status !== 'cancelled' &&
      parsed.status !== 'superseded') ||
    typeof parsed.createdAt !== 'number' ||
    !Number.isFinite(parsed.createdAt) ||
    !Array.isArray(parsed.fields) ||
    parsed.fields.some((f) => !isValidAskFieldRow(f))
  ) {
    throw new HelmxError(
      'store_data_corrupted',
      `Persisted AskDoc spec corrupted (ask ${row.id}): invalid AskSpec structure`,
      500,
      { askId: row.id },
    )
  }
  return parsed as unknown as AskSpec
}

/** Full boundary validation for AskCreateSpec (rejects every invalid shape before persisting). */
function validateAskSpec(spec: AskCreateSpec): void {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new HelmxError('validation_error', 'AskDoc spec must be an object')
  }
  // Caller-supplied ID must be a non-empty string without silent normalization.
  if (spec.id !== undefined) {
    if (typeof spec.id !== 'string' || spec.id === '' || spec.id.trim() === '') {
      throw new HelmxError('validation_error', 'AskDoc id must be a non-empty string')
    }
  }
  if (!Number.isInteger(spec.conversationId) || (spec.conversationId ?? 0) <= 0) {
    throw new HelmxError('validation_error', 'AskDoc requires conversationId (positive integer)')
  }
  if (spec.kind !== undefined && spec.kind !== 'question' && spec.kind !== 'approval') {
    throw new HelmxError('validation_error', `AskDoc kind must be 'question' | 'approval' (got '${String(spec.kind)}')`)
  }
  if (parseNonEmptyLocalizedText(spec.title) === undefined) {
    throw new HelmxError('validation_error', 'AskDoc requires title (non-empty string or LocalizedText map)')
  }
  if (spec.description !== undefined && parseLocalizedText(spec.description) === undefined) {
    throw new HelmxError('validation_error', 'AskDoc description must be a string or valid LocalizedText map')
  }
  if (spec.hint !== undefined && parseLocalizedText(spec.hint) === undefined) {
    throw new HelmxError('validation_error', 'AskDoc hint must be a string or valid LocalizedText map')
  }
  if (spec.ownerPluginId !== undefined && typeof spec.ownerPluginId !== 'string') {
    throw new HelmxError('validation_error', 'AskDoc ownerPluginId must be a string')
  }
  if (spec.expectedStateSeq !== undefined) {
    if (!Number.isSafeInteger(spec.expectedStateSeq) || (spec.expectedStateSeq as number) < 0) {
      throw new HelmxError('validation_error', 'expectedStateSeq must be a non-negative integer')
    }
  }
  if (!Array.isArray(spec.fields) || spec.fields.length === 0) {
    throw new HelmxError('validation_error', 'AskDoc requires at least one field')
  }
  const names = new Set<string>()
  const thinkingLevelFields = new Set<string>()
  for (const field of spec.fields) {
    if (field === null || typeof field !== 'object') {
      throw new HelmxError('validation_error', 'field must be an object')
    }
    if (typeof field.name !== 'string' || field.name.trim() === '') {
      throw new HelmxError('validation_error', 'field.name must be a non-empty string')
    }
    if (names.has(field.name)) {
      throw new HelmxError('validation_error', `duplicate field.name: ${field.name}`)
    }
    names.add(field.name)
    if (parseNonEmptyLocalizedText(field.label) === undefined) {
      throw new HelmxError(
        'validation_error',
        `field '${field.name}' label must be a non-empty string or LocalizedText map`,
      )
    }
    if (
      field.type !== 'text' &&
      field.type !== 'select' &&
      field.type !== 'confirm' &&
      field.type !== 'choice' &&
      field.type !== 'model'
    ) {
      throw new HelmxError(
        'validation_error',
        `invalid type for field '${field.name}': ${String(field.type)} (only text | select | confirm | choice | model)`,
      )
    }
    if (field.multiple !== undefined) {
      if (field.type !== 'choice') {
        throw new HelmxError('validation_error', `field '${field.name}' multiple is only allowed on choice fields`)
      }
      if (typeof field.multiple !== 'boolean') {
        throw new HelmxError('validation_error', `field '${field.name}' multiple must be a boolean`)
      }
    }
    if (field.allowCustom !== undefined) {
      if (field.type !== 'choice') {
        throw new HelmxError('validation_error', `field '${field.name}' allowCustom is only allowed on choice fields`)
      }
      if (typeof field.allowCustom !== 'boolean') {
        throw new HelmxError('validation_error', `field '${field.name}' allowCustom must be a boolean`)
      }
    }
    if (field.multiline !== undefined) {
      if (field.type !== 'text') {
        throw new HelmxError('validation_error', `field '${field.name}' multiline is only allowed on text fields`)
      }
      if (typeof field.multiline !== 'boolean') {
        throw new HelmxError('validation_error', `field '${field.name}' multiline must be a boolean`)
      }
    }
    if (field.placeholder !== undefined) {
      if (field.type !== 'text' && !(field.type === 'choice' && field.allowCustom === true)) {
        throw new HelmxError(
          'validation_error',
          `field '${field.name}' placeholder is only allowed on text or allowCustom choice fields`,
        )
      }
      if (parseLocalizedText(field.placeholder) === undefined) {
        throw new HelmxError(
          'validation_error',
          `field '${field.name}' placeholder must be a string or valid LocalizedText map`,
        )
      }
    }
    if (field.confirmLabel !== undefined) {
      if (field.type !== 'confirm') {
        throw new HelmxError('validation_error', `field '${field.name}' confirmLabel is only allowed on confirm fields`)
      }
      if (parseNonEmptyLocalizedText(field.confirmLabel) === undefined) {
        throw new HelmxError(
          'validation_error',
          `field '${field.name}' confirmLabel must be a non-empty string or LocalizedText map`,
        )
      }
    }
    if (field.rejectLabel !== undefined) {
      if (field.type !== 'confirm') {
        throw new HelmxError('validation_error', `field '${field.name}' rejectLabel is only allowed on confirm fields`)
      }
      if (parseNonEmptyLocalizedText(field.rejectLabel) === undefined) {
        throw new HelmxError(
          'validation_error',
          `field '${field.name}' rejectLabel must be a non-empty string or LocalizedText map`,
        )
      }
    }
    if (field.thinkingLevelField !== undefined) {
      if (field.type !== 'model') {
        throw new HelmxError(
          'validation_error',
          `field '${field.name}' thinkingLevelField is only allowed on model fields`,
        )
      }
      if (typeof field.thinkingLevelField !== 'string' || field.thinkingLevelField.trim() === '') {
        throw new HelmxError(
          'validation_error',
          `field '${field.name}' thinkingLevelField must be a non-empty string`,
        )
      }
      if (thinkingLevelFields.has(field.thinkingLevelField)) {
        throw new HelmxError(
          'validation_error',
          `duplicate thinkingLevelField: ${field.thinkingLevelField}`,
        )
      }
      thinkingLevelFields.add(field.thinkingLevelField)
    }
    if (field.type === 'select' || field.type === 'choice') {
      if (
        !Array.isArray(field.options) ||
        field.options.length === 0 ||
        field.options.some(
          (o) =>
            o === null ||
            typeof o !== 'object' ||
            typeof o.value !== 'string' ||
            o.value === '' ||
            parseNonEmptyLocalizedText(o.label) === undefined ||
            (o.description !== undefined && parseLocalizedText(o.description) === undefined) ||
            (o.recommended !== undefined && typeof o.recommended !== 'boolean'),
        )
      ) {
        throw new HelmxError(
          'validation_error',
          `${field.type} field '${field.name}' requires non-empty options (each with a non-empty value, LocalizedText label, and optional LocalizedText description)`,
        )
      }
    }
    if (field.defaultValue !== undefined) {
      if (field.type === 'choice' && field.multiple === true) {
        if (!Array.isArray(field.defaultValue)) {
          throw new HelmxError(
            'validation_error',
            `field '${field.name}' defaultValue must be a string array when multiple is true`,
          )
        }
        const seen = new Set<string>()
        for (const item of field.defaultValue) {
          if (typeof item !== 'string' || item.trim() === '') {
            throw new HelmxError(
              'validation_error',
              `field '${field.name}' defaultValue items must be non-empty strings`,
            )
          }
          if (seen.has(item)) {
            throw new HelmxError(
              'validation_error',
              `field '${field.name}' defaultValue contains duplicate value '${item}'`,
            )
          }
          seen.add(item)
          if (field.allowCustom !== true && !(field.options ?? []).some((o) => o.value === item)) {
            throw new HelmxError(
              'validation_error',
              `defaultValue '${item}' for choice field '${field.name}' must match an option value`,
            )
          }
        }
      } else {
        if (typeof field.defaultValue !== 'string') {
          throw new HelmxError('validation_error', `field '${field.name}' defaultValue must be a string`)
        }
        if (
          field.defaultValue !== '' &&
          (field.type === 'select' || (field.type === 'choice' && field.allowCustom !== true)) &&
          !(field.options ?? []).some((o) => o.value === field.defaultValue)
        ) {
          throw new HelmxError(
            'validation_error',
            `defaultValue '${field.defaultValue}' for ${field.type} field '${field.name}' must match an option value`,
          )
        }
        if (
          field.type === 'confirm' &&
          field.defaultValue !== '' &&
          field.defaultValue !== 'true' &&
          field.defaultValue !== 'false'
        ) {
          throw new HelmxError(
            'validation_error',
            `defaultValue for confirm field '${field.name}' must be 'true' | 'false'`,
          )
        }
      }
    }
  }
  for (const key of thinkingLevelFields) {
    if (names.has(key)) {
      throw new HelmxError(
        'validation_error',
        `thinkingLevelField '${key}' collides with field.name`,
      )
    }
  }
}

function isMultiChoiceField(field: AskFieldSpec): boolean {
  return field.type === 'choice' && field.multiple === true
}

/** Answer boundary validation: unknown fields / type mismatch / out-of-range options / invalid confirm values. */
function validateAnswersAgainstFields(spec: AskSpec, answers: AskAnswers): void {
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new HelmxError('validation_error', 'answers must be an object')
  }
  const byName = new Map(spec.fields.map((f) => [f.name, f]))
  const thinkingLevelKeys = new Set<string>()
  for (const f of spec.fields) {
    if (f.type === 'model' && typeof f.thinkingLevelField === 'string' && f.thinkingLevelField !== '') {
      thinkingLevelKeys.add(f.thinkingLevelField)
    }
  }
  for (const key of Object.keys(answers)) {
    const value = answers[key]
    if (!byName.has(key) && !thinkingLevelKeys.has(key)) {
      throw new HelmxError('validation_error', `unknown answer field: ${key} (not declared on AskDoc)`)
    }
    const field = byName.get(key)
    if (field !== undefined && isMultiChoiceField(field)) {
      if (!Array.isArray(value)) {
        throw new HelmxError(
          'validation_error',
          `answer field '${key}' must be an array of strings`,
        )
      }
    } else if (typeof value !== 'string') {
      throw new HelmxError('validation_error', `answer field '${key}' must be a string (got ${typeof value})`)
    }
  }
  for (const field of spec.fields) {
    const value = answers[field.name]
    if (isMultiChoiceField(field)) {
      if (value === undefined) {
        if (field.required) {
          throw new HelmxError('validation_error', `missing required field: ${field.name}`)
        }
        continue
      }
      if (!Array.isArray(value)) {
        throw new HelmxError('validation_error', `answer field '${field.name}' must be an array of strings`)
      }
      if (value.length > 32) {
        throw new HelmxError('validation_error', `answer field '${field.name}' exceeds 32 selections`)
      }
      if (field.required && value.length === 0) {
        throw new HelmxError('validation_error', `missing required field: ${field.name}`)
      }
      const seen = new Set<string>()
      for (const item of value) {
        if (typeof item !== 'string' || item.trim() === '') {
          throw new HelmxError(
            'validation_error',
            `answer items for multi-choice field '${field.name}' must be non-empty strings`,
          )
        }
        if (seen.has(item)) {
          throw new HelmxError(
            'validation_error',
            `duplicate selection '${item}' for multi-choice field '${field.name}'`,
          )
        }
        seen.add(item)
        if (field.allowCustom !== true) {
          const valid = (field.options ?? []).some((o) => o.value === item)
          if (!valid) {
            throw new HelmxError(
              'validation_error',
              `answer '${item}' for choice field '${field.name}' is not among the allowed options`,
            )
          }
        }
      }
      continue
    }

    const strValue = typeof value === 'string' ? value : undefined
    if (field.required && (strValue === undefined || strValue.trim() === '')) {
      throw new HelmxError('validation_error', `missing required field: ${field.name}`)
    }
    if (strValue === undefined || strValue === '') continue
    if (field.type === 'select' || (field.type === 'choice' && field.allowCustom !== true)) {
      const valid = (field.options ?? []).some((o) => o.value === strValue)
      if (!valid) {
        throw new HelmxError(
          'validation_error',
          `answer '${strValue}' for ${field.type} field '${field.name}' is not among the allowed options`,
        )
      }
    }
    if (field.type === 'confirm' && strValue !== 'true' && strValue !== 'false') {
      throw new HelmxError(
        'validation_error',
        `answer for confirm field '${field.name}' must be 'true' | 'false' (got '${strValue}')`,
      )
    }
  }
}
