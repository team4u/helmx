/**
 * RuntimeOwnershipManager: conversation ownership and plugin management locks (extracted from KernelRuntime).
 *
 * Responsibilities:
 * - Resolve and persistently record conversation ownership directly via the `helmx_conversations.owned_by`
 *   column (O(1) read/write, zero global JSON map parsing);
 * - Acquire and release plugin conversation management locks (manage, release);
 * - Emit conversation.upsert events when ownership changes.
 */

import type { ConversationOwnership, ConversationSummary } from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import type { EventHub } from './events.js'
import type { HelmxStore } from './store.js'

export type { ConversationOwnership }

interface RuntimeOwnershipDeps {
  readonly store: HelmxStore
  readonly events: EventHub
  readonly conversations: { summaryWithOwnership(id: number): ConversationSummary }
}

export class RuntimeOwnershipManager {
  /** Plugin management locks per conversation: conversationId -> holding pluginIds (protects against deletion). */
  readonly managedConversations = new Map<number, Set<string>>()

  constructor(private readonly deps: RuntimeOwnershipDeps) {}

  /**
   * Look up current conversation ownership in O(1) (single authoritative source for Watchdog invariants):
   * - Missing or tombstoned conversations throw not_found;
   * - Unset or unrecognized marks default to 'human' (fail-safe: better to skip automation than act on human conversations).
   */
  getOwnership(conversationId: number): ConversationOwnership {
    const meta = this.deps.store.getConv(conversationId)
    if (meta === undefined || this.deps.store.isDeleted(conversationId)) {
      throw new HelmxError('not_found', `conversation not found: ${conversationId}`, 404, { conversationId })
    }
    return meta.ownedBy === 'helmx' ? 'helmx' : 'human'
  }

  /**
   * Record conversation ownership on `helmx_conversations.owned_by` (single authoritative source for Watchdog invariants):
   * - Independent of user-editable tags/parent derivation; unmarked defaults to 'human';
   * - Persisted directly on the conversation row across restarts.
   */
  markOwnership(conversationId: number, owner: ConversationOwnership): void {
    const normalized: ConversationOwnership = owner === 'helmx' ? 'helmx' : 'human'
    if (!this.deps.store.setConvOwnership(conversationId, normalized)) return
    this.deps.events.publish('conversation.upsert', this.deps.conversations.summaryWithOwnership(conversationId))
  }

  /**
   * Acquire a plugin management lock on a conversation (protects against deletion): only enabled plugins should hold
   * one; returns a release callback.
   */
  manage(conversationId: number, pluginId: string): () => void {
    let owners = this.managedConversations.get(conversationId)
    if (owners === undefined) {
      owners = new Set()
      this.managedConversations.set(conversationId, owners)
    }
    owners.add(pluginId)
    let released = false
    return () => {
      if (released) return
      released = true
      this.release(conversationId, pluginId)
    }
  }

  release(conversationId: number, pluginId: string): void {
    const owners = this.managedConversations.get(conversationId)
    if (!owners) return
    owners.delete(pluginId)
    if (owners.size === 0) this.managedConversations.delete(conversationId)
  }
}
