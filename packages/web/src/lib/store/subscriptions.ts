/**
 * Keyed and domain-sliced subscription bus for HelmxExternalStore.
 * Deduplicates listeners across all notified buckets within a single commit.
 */
import type { NotifyPlan, StoreDomainKey, StoreListener } from './types.js'

function addListener<K>(map: Map<K, Set<StoreListener>>, key: K, listener: StoreListener): () => void {
  let set = map.get(key)
  if (set === undefined) {
    set = new Set()
    map.set(key, set)
  }
  set.add(listener)
  return () => {
    const current = map.get(key)
    if (current === undefined) return
    current.delete(listener)
    if (current.size === 0) map.delete(key)
  }
}

function collectListeners<K>(map: Map<K, Set<StoreListener>>, keys: ReadonlySet<K>, out: Set<StoreListener>): void {
  for (const key of keys) {
    const set = map.get(key)
    if (set !== undefined) {
      for (const fn of set) out.add(fn)
    }
  }
}

export class StoreSubscriptionBus {
  private readonly domainListeners = new Map<StoreDomainKey, Set<StoreListener>>()
  private readonly liveListeners = new Map<number, Set<StoreListener>>()
  private readonly detailListeners = new Map<number, Set<StoreListener>>()
  private readonly summaryListeners = new Map<number, Set<StoreListener>>()
  private readonly artifactsListeners = new Map<number, Set<StoreListener>>()
  private readonly pendingAskListeners = new Map<number, Set<StoreListener>>()
  private readonly highlightListeners = new Map<number, Set<StoreListener>>()
  private readonly loadErrorListeners = new Map<string, Set<StoreListener>>()
  private readonly pluginDocListeners = new Map<string, Set<StoreListener>>()
  private readonly pluginListeners = new Map<string, Set<StoreListener>>()

  subscribeDomain = (key: StoreDomainKey, listener: StoreListener): (() => void) =>
    addListener(this.domainListeners, key, listener)

  subscribeConversationLive = (conversationId: number, listener: StoreListener): (() => void) =>
    addListener(this.liveListeners, conversationId, listener)

  subscribeConversationDetail = (conversationId: number, listener: StoreListener): (() => void) =>
    addListener(this.detailListeners, conversationId, listener)

  subscribeConversationSummary = (conversationId: number, listener: StoreListener): (() => void) =>
    addListener(this.summaryListeners, conversationId, listener)

  subscribeConversationArtifacts = (conversationId: number, listener: StoreListener): (() => void) =>
    addListener(this.artifactsListeners, conversationId, listener)

  subscribeConversationPendingAsks = (conversationId: number, listener: StoreListener): (() => void) =>
    addListener(this.pendingAskListeners, conversationId, listener)

  subscribeHighlightForConversation = (conversationId: number, listener: StoreListener): (() => void) =>
    addListener(this.highlightListeners, conversationId, listener)

  subscribeLoadError = (key: string, listener: StoreListener): (() => void) =>
    addListener(this.loadErrorListeners, key, listener)

  subscribePluginDoc = (docKey: string, listener: StoreListener): (() => void) =>
    addListener(this.pluginDocListeners, docKey, listener)

  subscribePlugin = (pluginId: string, listener: StoreListener): (() => void) =>
    addListener(this.pluginListeners, pluginId, listener)

  dispatch(plan: NotifyPlan): void {
    const listeners = new Set<StoreListener>()
    collectListeners(this.domainListeners, plan.domains, listeners)
    collectListeners(this.liveListeners, plan.liveIds, listeners)
    collectListeners(this.detailListeners, plan.detailIds, listeners)
    collectListeners(this.summaryListeners, plan.summaryIds, listeners)
    collectListeners(this.artifactsListeners, plan.artifactIds, listeners)
    collectListeners(this.pendingAskListeners, plan.pendingAskIds, listeners)
    collectListeners(this.highlightListeners, plan.highlightIds, listeners)
    collectListeners(this.loadErrorListeners, plan.loadErrorKeys, listeners)
    collectListeners(this.pluginDocListeners, plan.pluginDocKeys, listeners)
    collectListeners(this.pluginListeners, plan.pluginIds, listeners)
    for (const fn of listeners) fn()
  }
}
