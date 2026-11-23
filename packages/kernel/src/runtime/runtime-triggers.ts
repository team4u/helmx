/**
 * RuntimeTriggerDispatcher: orchestrates external trigger routing and defanged message envelope handling (extracted from KernelRuntime).
 *
 * Responsibilities:
 * - Defang external message envelopes via XML escaping (prevents `</external_event>` tag injection);
 * - Busy policy: trigger deliveries submit with `whenBusy = 'steer'` (`followUp` remains available to explicit callers);
 * - Resolve the default delivery target when no explicit target is specified (deduplicating concurrent resolution via `resolveDefaultTriggerTarget`).
 */

import { HelmxError, escapeXml } from '@helmx/protocol'
import type { ConversationInit, ConversationOwnership, ConversationSummary, ExternalTriggerEnvelope } from '@helmx/protocol'
import type { HelmxStore } from './store.js'

interface RuntimeTriggerDispatcherDeps {
  readonly store: HelmxStore
  getConversation(id: number): ConversationSummary
  getConversationOwnership(id: number): ConversationOwnership
  createConversation(init: ConversationInit): Promise<ConversationSummary>
  submitInput(
    id: number,
    text: string,
    opts?: { origin?: 'human' | 'agent' | 'trigger'; whenBusy?: 'steer' | 'followUp' | 'reject' },
  ): Promise<unknown>
}

export class RuntimeTriggerDispatcher {
  /** Coalesced in-flight Promise for creating the default trigger target conversation on demand. */
  private defaultTriggerTargetCreation: Promise<number> | undefined

  constructor(private readonly deps: RuntimeTriggerDispatcherDeps) {}

  /** Defang an external message envelope: XML-escape all dynamic fields to prevent `</external_event>` injection. */
  defang(envelope: ExternalTriggerEnvelope): string {
    const id = escapeXml(envelope.id)
    const source = escapeXml(envelope.source)
    const body = escapeXml(envelope.text)
    return `<external_event id="${id}" source="${source}" untrusted="true">\n${body}\n</external_event>`
  }

  /**
   * Resolve the default delivery target for a trigger without an explicit target:
   * - Selects the newest non-child human-owned conversation under the assistant Profile;
   * - Creates a normal assistant conversation on demand if none matches, coalescing concurrent in-process creations;
   *   the Promise is cleared immediately upon settlement so deletable IDs are not cached and failures can retry.
   */
  async resolveDefaultTriggerTarget(): Promise<number> {
    const candidates = this.deps.store
      .listConvs()
      .filter((c) =>
        c.profileId === 'assistant' &&
        c.parentConversationId === undefined &&
        this.deps.getConversationOwnership(c.id) === 'human',
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id)
    if (candidates[0] !== undefined) return candidates[0].id

    if (this.defaultTriggerTargetCreation !== undefined) return this.defaultTriggerTargetCreation
    const creation = this.deps
      .createConversation({
        title: 'person assist',
        profileId: 'assistant',
        tags: ['assistant'],
      })
      .then((created) => created.id)
    this.defaultTriggerTargetCreation = creation
    try {
      return await creation
    } finally {
      if (this.defaultTriggerTargetCreation === creation) this.defaultTriggerTargetCreation = undefined
    }
  }

  /** External trigger delivery: validate any explicit target, defang once, and deliver. */
  async dispatchTrigger(envelope: ExternalTriggerEnvelope): Promise<void> {
    const whenBusy = envelope.whenBusy ?? 'steer'
    if (whenBusy !== 'steer' && whenBusy !== 'followUp' && whenBusy !== 'reject') {
      throw new HelmxError(
        'validation_error',
        `invalid trigger whenBusy policy: expected steer|followUp|reject, got ${String(whenBusy)}`,
        400,
        { whenBusy },
      )
    }
    const text = this.defang(envelope)
    if (envelope.targetConversationId !== undefined) {
      // Explicit target: deleted/invalid targets fail loudly with not_found (never masked by default re-routing).
      this.deps.getConversation(envelope.targetConversationId)
      await this.deps.submitInput(envelope.targetConversationId, text, { origin: 'trigger', whenBusy })
      return
    }
    const target = await this.resolveDefaultTriggerTarget()
    try {
      await this.deps.submitInput(target, text, { origin: 'trigger', whenBusy })
    } catch (err) {
      if (!(err instanceof HelmxError && err.code === 'not_found')) throw err
      const resolved = await this.resolveDefaultTriggerTarget()
      await this.deps.submitInput(resolved, text, { origin: 'trigger', whenBusy })
    }
  }
}
