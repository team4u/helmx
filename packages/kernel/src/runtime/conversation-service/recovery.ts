/**
 * Startup recovery of all persisted conversations (ConversationService.recover).
 *
 * Scans the durable store page by page: tombstoned conversations are skipped, conversations without a Helmx mirror
 * are reported to the host (onMissingMirror seeds parent chains), the effective model is aligned per conversation
 * (tier references that cannot be resolved yet are deferred, not fatal), and the tracker observes the conversation
 * so mirrors, queued inputs and active runs are restored before the scheduler resumes.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Storage } from '@earendil-works/pi-durable'
import type { Profile } from '../../services/index.js'
import { HelmxError } from '@helmx/protocol'
import type { ConversationTracker } from '../conversations.js'
import type { HelmxStore } from '../store.js'
import { scanSdkConversations } from '../sdk-ids.js'

export interface ConversationRecoveryHost {
  readonly storage: Pick<Storage, 'scanConversations'>
  readonly store: HelmxStore
  readonly alignConversationModel: (
    id: number,
    emitEvent: boolean,
    profileCache?: Map<string, Promise<Profile | undefined>>,
  ) => Promise<void>
  readonly tracker: Pick<ConversationTracker, 'observe'>
}

export async function recoverConversations(
  host: ConversationRecoveryHost,
  onMissingMirror: (id: number, parentConversationId: number | undefined) => Promise<void>,
): Promise<{ deferredTierAlignment: boolean }> {
  const batchProfiles = new Map<string, Promise<Profile | undefined>>()
  let deferredTierAlignment = false
  let cursor: unknown = undefined
  for (;;) {
    const page = await scanSdkConversations(host.storage, 500, cursor, BACKGROUND_CONTEXT)
    for (const record of page.items) {
      const id = Number(record.id)
      if (host.store.isDeleted(id)) continue
      if (!host.store.getConv(id)) {
        await onMissingMirror(id, record.parent?.conversationId)
      }
      try {
        await host.alignConversationModel(id, false, batchProfiles)
      } catch (err) {
        if (!(err instanceof HelmxError && err.code === 'model_tier_not_found')) throw err
        deferredTierAlignment = true
      }
      await host.tracker.observe(id)
    }
    if (!page.next) break
    cursor = page.next
  }
  return { deferredTierAlignment }
}
