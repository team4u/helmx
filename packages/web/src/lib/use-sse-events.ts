/**
 * SSE 实时订阅、短断线续传（bootId + seq 水位与失败回退全量 snapshot）、
 * 空闲看门狗及指数退避重连状态机 hook。
 */
import { useEffect } from 'react'
import type {
  ArtifactMetadata,
  ConversationSummary,
  HelmxEvent,
  HelmxEventFrame,
  HelmxResumedFrame,
  HelmxSnapshot,
  HelmxTransientLiveDeltaFrame,
  HelmxTransientLiveFrame,
} from '@helmx/protocol/browser'
import { isConversationArchived } from '../conversation/archive-model.js'
import { getStoredToken } from './api.js'
import { errorText } from './error-text.js'
import type { HelmxExternalStore } from './helmx-store.js'
import {
  applyEventFrame,
  applyResumedFrame,
  applySnapshot,
  applyTransientLiveDeltaFrame,
  applyTransientLiveFrame,
  extractDocErrorPluginId,
  isConfigOnlyPluginChange,
  isPluginSummaryActive,
  omitPluginDocLoadErrors,
  readSseChunkWithDeadline,
  sameClientHashes,
  SseParser,
  sseClientTimings,
  type SseCursor,
} from './live-state.js'
import { evictPluginClientCache, reconcilePluginClientCache } from './plugin-client.js'
import { observeServerEpoch } from './server-clock.js'
import {
  evictSessionDocsOfConversation,
  evictSessionDocSubscriptions,
  restoreSessionDocSubscriptions,
} from './session-docs.js'
import { standbyFallbackTarget } from './space-navigation.js'
import { isArtifactsWatermarkCurrent, isConversationStatusActive } from './sync-watermarks.js'
import type { UseUnreadSyncResult } from './use-unread-sync.js'

export interface UseSseEventsOptions {
  store: HelmxExternalStore
  authenticated: boolean
  logout: () => void
  unreadSync: Pick<
    UseUnreadSyncResult,
    'unreadClearInFlight' | 'unreadClearedSeq' | 'visibleConversationIds' | 'clearVisibleConversationUnread'
  >
}

interface StreamSessionState {
  mode: 'fresh' | 'resumed' | null
  resumedHeadSeq: number
  liveAnnounced: boolean
}

interface FrameHandlerContext {
  store: HelmxExternalStore
  unreadSync: UseSseEventsOptions['unreadSync']
  streamState: StreamSessionState
  announceLive: () => void
  resetRetry: () => void
}

function buildSseEventsUrl(cursor: SseCursor | null): string {
  return cursor !== null
    ? `/api/events?afterSeq=${cursor.seq}&bootId=${encodeURIComponent(cursor.bootId)}`
    : '/api/events'
}

function computeReconnectBackoffMs(retry: number): number {
  return (
    Math.min(sseClientTimings.reconnectBaseMs * 2 ** retry, sseClientTimings.reconnectCapMs) +
    Math.random() * sseClientTimings.reconnectJitterMs
  )
}

function syncDeletedConversationNav(
  store: HelmxExternalStore,
  deletedConversationId: number,
  deletedSummary: ConversationSummary | undefined,
): void {
  const fallback = standbyFallbackTarget(deletedSummary)
  const primaryTarget = store.getPrimaryTarget()
  const splitTarget = store.getSplitTarget()
  const activeModal = store.getActiveModal()
  const primaryHit =
    primaryTarget.kind === 'conversation' && primaryTarget.conversationId === deletedConversationId
  const splitHit =
    splitTarget?.kind === 'conversation' && splitTarget.conversationId === deletedConversationId
  const drawerHit = store.getDrawerStack().some((frame) => frame.conversationId === deletedConversationId)
  const modalHit =
    (activeModal?.kind === 'artifact-preview' || activeModal?.kind === 'workspace-file') &&
    activeModal.conversationId === deletedConversationId
  if (primaryHit || splitHit || drawerHit || modalHit) store.pendingHistoryMode = 'replace'
  if (primaryHit) store.navActions.applyPrimaryTarget(fallback)
  if (splitHit) store.navActions.setSplitTarget(null)
  store.navActions.pruneConversationFromDrawerStack(deletedConversationId)
  if (modalHit) store.actions.setActiveModal(null)
}

function handleSnapshotFrame(payload: unknown, ctx: FrameHandlerContext): void {
  if (ctx.streamState.mode !== null) throw new Error('Live connection received a duplicate snapshot control frame')
  const snap = payload as HelmxSnapshot
  if (snap === null || typeof snap !== 'object' || typeof snap.bootId !== 'string' || snap.bootId === '') {
    throw new Error('Invalid kernel live snapshot format (no valid bootId)')
  }
  const { store, unreadSync } = ctx
  const prevLive = store.getLiveState()
  const prevPlugins = prevLive.plugins
  const prevDetails = prevLive.conversationDetails
  const prevConversationById = new Map<number, ConversationSummary>(prevLive.conversations.map((c) => [c.id, c]))
  const nextConversationIds = new Set(snap.conversations.map((c) => c.id))
  const deletedConversations = new Map<number, ConversationSummary>()
  for (const [prevId, prevSummary] of prevConversationById) {
    if (!nextConversationIds.has(prevId)) {
      deletedConversations.set(prevId, prevSummary)
    }
  }

  ctx.streamState.mode = 'fresh'
  store.requests.resetOnSnapshot()
  unreadSync.unreadClearInFlight.current.clear()
  unreadSync.unreadClearedSeq.current.clear()

  // 断线期间增量对账插件客户端缓存：保留启用且 hash 未变的模块与样式，仅逐出变更/停用项。
  reconcilePluginClientCache(snap.plugins)

  const prevPluginById = new Map(prevPlugins.map((p) => [p.id, p]))
  const nextPluginById = new Map(snap.plugins.map((p) => [p.id, p]))
  const stalePluginIds = new Set<string>()
  for (const prevPlugin of prevPlugins) {
    const nextPlugin = nextPluginById.get(prevPlugin.id)
    if (
      nextPlugin === undefined ||
      !isPluginSummaryActive(nextPlugin) ||
      !sameClientHashes(prevPlugin.clientHashes, nextPlugin.clientHashes) ||
      (!isPluginSummaryActive(prevPlugin) && isPluginSummaryActive(nextPlugin))
    ) {
      stalePluginIds.add(prevPlugin.id)
    }
    if (nextPlugin === undefined || !isPluginSummaryActive(nextPlugin)) {
      evictSessionDocSubscriptions(prevPlugin.id)
    }
  }
  for (const nextPlugin of snap.plugins) {
    if (!isPluginSummaryActive(nextPlugin)) {
      stalePluginIds.add(nextPlugin.id)
      evictSessionDocSubscriptions(nextPlugin.id)
    }
  }
  for (const deletedId of deletedConversations.keys()) {
    evictSessionDocsOfConversation(deletedId)
    store.requests.artifactsWatermarks.delete(deletedId)
    store.requests.prevVisibleConversationIds.delete(deletedId)
  }
  // 插件恢复 active：在已删除会话完成 evict 后再恢复，确保已删会话绝不被复活。
  for (const nextPlugin of snap.plugins) {
    if (!isPluginSummaryActive(nextPlugin)) continue
    const prevPlugin = prevPluginById.get(nextPlugin.id)
    const becameOrReloadedActive =
      prevPlugin === undefined ||
      !isPluginSummaryActive(prevPlugin) ||
      !sameClientHashes(prevPlugin.clientHashes, nextPlugin.clientHashes)
    restoreSessionDocSubscriptions(nextPlugin.id, { includePermanentErrors: becameOrReloadedActive })
  }

  // loadErrors 仅清理已被停用/移除/hash 变更插件的旧 doc 错误以及已删除会话的错误。
  store.setLoadErrors((prev) => {
    let changed = false
    const next: Record<string, string> = {}
    for (const [key, value] of Object.entries(prev)) {
      const docPluginId = extractDocErrorPluginId(key)
      if (docPluginId !== undefined) {
        if (stalePluginIds.has(docPluginId)) {
          changed = true
          continue
        }
      } else if (
        key.startsWith('conversation:') ||
        key.startsWith('history:') ||
        key.startsWith('artifacts:')
      ) {
        const convId = Number(key.slice(key.indexOf(':') + 1))
        if (Number.isInteger(convId) && !nextConversationIds.has(convId)) {
          changed = true
          continue
        }
      }
      next[key] = value
    }
    return changed ? next : prev
  })

  store.updateLive((state) => applySnapshot(state, snap))
  if (typeof snap.serverTime === 'number' && Number.isFinite(snap.serverTime) && snap.serverTime > 0) {
    observeServerEpoch(snap.serverTime)
  }
  observeLiveFrameClocks(snap.conversationLives)
  store.sseCursor = { bootId: snap.bootId, seq: snap.seq }
  store.setKernelBootId(snap.bootId)

  // SWR 保活：保留仍存在会话的产物缓存，仅清理已删除会话。
  store.setConversationArtifacts((prev) => {
    let changed = false
    const next: Record<number, ArtifactMetadata[]> = {}
    for (const [k, list] of Object.entries(prev)) {
      const numId = Number(k)
      if (nextConversationIds.has(numId)) next[numId] = list
      else changed = true
    }
    return changed ? next : prev
  })

  // 断线期间已被删除的可见会话：先同步导航、分屏、抽屉与弹窗，避免后续可见集合刷新向已删会话发 404 请求。
  for (const [deletedId, deletedSummary] of deletedConversations) {
    syncDeletedConversationNav(store, deletedId, deletedSummary)
  }

  ctx.resetRetry()
  ctx.announceLive()
  const artifactsMap = store.getConversationArtifactsMap()
  for (const id of unreadSync.visibleConversationIds()) {
    const prevDetail = prevDetails[id]
    const nextSummary = snap.conversations.find((c) => c.id === id)
    const unchanged =
      prevDetail !== undefined &&
      nextSummary !== undefined &&
      !isConversationStatusActive(nextSummary.status) &&
      prevDetail.stateChangeSeq === nextSummary.stateChangeSeq &&
      prevDetail.lastEntryId !== undefined &&
      nextSummary.lastEntryId !== undefined &&
      prevDetail.lastEntryId === nextSummary.lastEntryId
    if (!unchanged) {
      const silent = prevDetail !== undefined
      void store.actions.loadConversationDetail(id, true, silent ? { silent: true } : undefined)
      void store.actions.loadConversationArtifacts(id, silent ? { silent: true } : undefined)
    } else if (artifactsMap[id] === undefined) {
      void store.actions.loadConversationArtifacts(id, { silent: true })
    } else if (!store.requests.artifactsWatermarks.has(id)) {
      store.requests.artifactsWatermarks.set(id, {
        stateChangeSeq: nextSummary.stateChangeSeq,
        lastEntryId: nextSummary.lastEntryId,
      })
    }
    unreadSync.clearVisibleConversationUnread(id)
  }
}

function handleResumedFrame(payload: unknown, ctx: FrameHandlerContext): void {
  if (ctx.streamState.mode !== null) throw new Error('Live connection received a duplicate resumed control frame')
  const { store } = ctx
  const resumed = payload as HelmxResumedFrame
  const current = store.sseCursor
  if (
    current === null ||
    resumed === null ||
    typeof resumed !== 'object' ||
    typeof resumed.bootId !== 'string' ||
    resumed.bootId !== current.bootId ||
    resumed.seq !== current.seq ||
    !Number.isSafeInteger(resumed.headSeq) ||
    resumed.headSeq < current.seq
  ) {
    throw new Error('Live connection resume handshake mismatch; full re-sync in progress')
  }
  ctx.streamState.mode = 'resumed'
  ctx.streamState.resumedHeadSeq = resumed.headSeq
  store.updateLive((state) => applyResumedFrame(state, resumed))
  if (typeof resumed.serverTime === 'number' && Number.isFinite(resumed.serverTime) && resumed.serverTime > 0) {
    observeServerEpoch(resumed.serverTime)
  }
  observeLiveFrameClocks(resumed.conversationLives)
  ctx.resetRetry()
  if (store.getLiveState().seq >= ctx.streamState.resumedHeadSeq) ctx.announceLive()
}

function handleTransientLiveFrame(payload: unknown, ctx: FrameHandlerContext): void {
  if (ctx.streamState.mode === null) throw new Error('Live connection missing the initial snapshot')
  ctx.store.updateLive((state) => applyTransientLiveFrame(state, payload as HelmxTransientLiveFrame))
  observeLiveFrameClocks([(payload as HelmxTransientLiveFrame).live])
}

function handleTransientLiveDeltaFrame(payload: unknown, ctx: FrameHandlerContext): void {
  if (ctx.streamState.mode === null) throw new Error('Live connection missing the initial snapshot')
  const frame = payload as HelmxTransientLiveDeltaFrame
  ctx.store.updateLive((state) => applyTransientLiveDeltaFrame(state, frame))
  observeLiveFrameClocks([frame?.delta])
}

/**
 * 帧内 ConversationLive 的 updatedAt 喂给时钟偏差估计（server-clock）。
 */
function observeLiveFrameClocks(lives: ReadonlyArray<{ updatedAt?: unknown }> | undefined): void {
  if (!Array.isArray(lives)) return
  for (const live of lives) {
    if (typeof live?.updatedAt === 'number') observeServerEpoch(live.updatedAt)
  }
}

function dispatchFrameSideEffects(
  event: HelmxEvent,
  deletedConversationId: number | undefined,
  deletedSummary: ConversationSummary | undefined,
  archivedSummary: ConversationSummary | undefined,
  configOnlyPluginChange: boolean,
  ctx: FrameHandlerContext,
): void {
  const { store, unreadSync } = ctx
  if (event.type === 'notification' && 'title' in event) {
    const { conversationId, ...rest } = event
    store.pushNotice({
      ...rest,
      ...(conversationId !== undefined ? { target: { kind: 'conversation', conversationId } } : {}),
    })
  }
  if (event.type === 'plugin.changed' && 'plugin' in event) {
    if (!configOnlyPluginChange) {
      store.requests.invalidatePluginDocRequests(event.plugin.id)
      store.setLoadErrors((prev) => omitPluginDocLoadErrors(prev, new Set([event.plugin.id])))
      evictPluginClientCache(event.plugin.id)
      if (!isPluginSummaryActive(event.plugin)) {
        evictSessionDocSubscriptions(event.plugin.id)
      } else {
        restoreSessionDocSubscriptions(event.plugin.id)
      }
      void store.actions.refreshAssets()
    }
  }
  if (event.type === 'plugin.doc.updated' && 'doc' in event) {
    if (store.getLiveState().plugins.some((p) => p.id === event.doc.pluginId && isPluginSummaryActive(p))) {
      const key = `doc:${event.doc.pluginId}/${event.doc.name}`
      store.requests.clearDocFailure(key)
      store.setLoadErrors((prev) => {
        if (!Object.hasOwn(prev, key)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      })
    }
  }
  if (event.type === 'models.changed') void store.actions.refreshAssets()
  if (event.type === 'profile.changed') void store.actions.refreshAssets()
  if (event.type === 'conversation.upsert' && 'conversation' in event) {
    const conv = event.conversation
    const clearedSeq = unreadSync.unreadClearedSeq.current.get(conv.id)
    if (!conv.unread && clearedSeq !== undefined && conv.stateChangeSeq > clearedSeq) {
      unreadSync.unreadClearedSeq.current.delete(conv.id)
    }
    const visible = unreadSync.visibleConversationIds().includes(conv.id)
    if (visible && !isConversationStatusActive(conv.status)) {
      const cachedArtifacts = store.getConversationArtifactsMap()[conv.id]
      const wm = store.requests.artifactsWatermarks.get(conv.id)
      if (!isArtifactsWatermarkCurrent(cachedArtifacts, conv, wm)) {
        void store.actions.loadConversationArtifacts(conv.id)
      }
    }
    if (visible && conv.unread) unreadSync.clearVisibleConversationUnread(conv.id, conv)
  }
  if (archivedSummary !== undefined) {
    const fallback = standbyFallbackTarget(archivedSummary)
    const primaryTarget = store.getPrimaryTarget()
    const splitTarget = store.getSplitTarget()
    const primaryHit =
      primaryTarget.kind === 'conversation' && primaryTarget.conversationId === archivedSummary.id
    const splitHit =
      splitTarget?.kind === 'conversation' && splitTarget.conversationId === archivedSummary.id
    if (primaryHit || splitHit) store.pendingHistoryMode = 'replace'
    if (primaryHit) store.navActions.applyPrimaryTarget(fallback)
    if (splitHit) store.navActions.setSplitTarget(fallback)
  }
  if (deletedConversationId !== undefined) {
    unreadSync.unreadClearInFlight.current.delete(deletedConversationId)
    unreadSync.unreadClearedSeq.current.delete(deletedConversationId)
    store.requests.abortRequestKey(`conversation:${deletedConversationId}`)
    store.requests.abortRequestKey(`history:${deletedConversationId}`)
    store.requests.abortRequestKey(`artifacts:${deletedConversationId}`)
    store.requests.artifactsWatermarks.delete(deletedConversationId)
    store.requests.prevVisibleConversationIds.delete(deletedConversationId)
    syncDeletedConversationNav(store, deletedConversationId, deletedSummary)
    store.setLoadErrors((prev) => {
      const kConv = `conversation:${deletedConversationId}`
      const kHist = `history:${deletedConversationId}`
      const kArt = `artifacts:${deletedConversationId}`
      if (!Object.hasOwn(prev, kConv) && !Object.hasOwn(prev, kHist) && !Object.hasOwn(prev, kArt)) return prev
      const next = { ...prev }
      delete next[kConv]
      delete next[kHist]
      delete next[kArt]
      return next
    })
    store.setConversationArtifacts((prev) => {
      if (!Object.hasOwn(prev, deletedConversationId)) return prev
      const next = { ...prev }
      delete next[deletedConversationId]
      return next
    })
    evictSessionDocsOfConversation(deletedConversationId)
  }
}

function handleEventFrame(payload: unknown, ctx: FrameHandlerContext): void {
  if (ctx.streamState.mode === null) throw new Error('Live connection missing the initial snapshot')
  const frame = payload as HelmxEventFrame
  if (frame === null || typeof frame !== 'object' || frame.event === null || typeof frame.event !== 'object' || typeof frame.event.type !== 'string') {
    throw new Error('Invalid live event frame format (missing event)')
  }
  const { store } = ctx
  const prevLive = store.getLiveState()
  const oldSeq = prevLive.seq
  const deletedEvent = frame.event.type === 'conversation.deleted' && 'conversationId' in frame.event ? frame.event : undefined
  const deletedSummary = deletedEvent !== undefined
    ? prevLive.conversations.find((c) => c.id === deletedEvent.conversationId)
    : undefined
  const upsertEvent = frame.event.type === 'conversation.upsert' && 'conversation' in frame.event ? frame.event : undefined
  const prevUpsertedSummary = upsertEvent !== undefined
    ? prevLive.conversations.find((c) => c.id === upsertEvent.conversation.id)
    : undefined
  const archivedSummary = upsertEvent !== undefined &&
      prevUpsertedSummary !== undefined &&
      !isConversationArchived(prevUpsertedSummary) &&
      isConversationArchived(upsertEvent.conversation)
    ? upsertEvent.conversation
    : undefined
  const pluginChangedEvent = frame.event.type === 'plugin.changed' && 'plugin' in frame.event ? frame.event : undefined
  const configOnlyPluginChange =
    pluginChangedEvent !== undefined &&
    Array.isArray(pluginChangedEvent.ui) &&
    isConfigOnlyPluginChange(
      prevLive.plugins.find((p) => p.id === pluginChangedEvent.plugin.id),
      prevLive.uiContributions.filter((item) => item.pluginId === pluginChangedEvent.plugin.id),
      pluginChangedEvent.plugin,
      pluginChangedEvent.ui,
    )
  store.updateLive((state) => applyEventFrame(state, frame))
  const nextSeq = store.getLiveState().seq
  const applied = store.sseCursor
  if (applied !== null && nextSeq > applied.seq) {
    store.sseCursor = { bootId: applied.bootId, seq: nextSeq }
  }
  if (ctx.streamState.mode === 'resumed' && nextSeq >= ctx.streamState.resumedHeadSeq) {
    ctx.announceLive()
  }
  if (frame.seq <= oldSeq) return
  dispatchFrameSideEffects(
    frame.event,
    deletedEvent?.conversationId,
    deletedSummary,
    archivedSummary,
    configOnlyPluginChange,
    ctx,
  )
}

export function useSseEvents({ store, authenticated, logout, unreadSync }: UseSseEventsOptions): void {
  const {
    unreadClearInFlight,
    unreadClearedSeq,
    visibleConversationIds,
    clearVisibleConversationUnread,
  } = unreadSync

  useEffect(() => {
    if (!authenticated) return
    let active = true
    let retry = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    let connecting = false
    let immediateReconnect = false
    let lastDataAt = 0

    const syncFacade = {
      unreadClearInFlight,
      unreadClearedSeq,
      visibleConversationIds,
      clearVisibleConversationUnread,
    }

    const connect = async (): Promise<void> => {
      connecting = true
      lastDataAt = Date.now()
      controller = new AbortController()
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        const token = getStoredToken()
        const cursor = store.sseCursor
        const eventsUrl = buildSseEventsUrl(cursor)
        const response = await fetch(eventsUrl, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        })
        if (response.status === 401) {
          logout()
          return
        }
        if (cursor !== null && response.status === 400) {
          store.sseCursor = null
          throw new Error('Live resume request rejected by the kernel (HTTP 400); falling back to full re-sync')
        }
        if (!response.ok || !response.body) throw new Error(`Live connection failed (HTTP ${response.status})`)

        const streamState: StreamSessionState = { mode: null, resumedHeadSeq: 0, liveAnnounced: false }
        const announceLive = (): void => {
          if (streamState.liveAnnounced) return
          streamState.liveAnnounced = true
          store.setSseConnected(true)
          store.setConnectionError(null)
        }
        const ctx: FrameHandlerContext = {
          store,
          unreadSync: syncFacade,
          streamState,
          announceLive,
          resetRetry: () => { retry = 0 },
        }

        const parser = new SseParser((message) => {
          try {
            const payload: unknown = JSON.parse(message.data)
            if (message.event === 'snapshot') handleSnapshotFrame(payload, ctx)
            else if (message.event === 'resumed') handleResumedFrame(payload, ctx)
            else if (message.event === 'conversation.live') handleTransientLiveFrame(payload, ctx)
            else if (message.event === 'conversation.live.delta') handleTransientLiveDeltaFrame(payload, ctx)
            else handleEventFrame(payload, ctx)
          } catch (error) {
            store.sseCursor = null
            throw error
          }
        })

        lastDataAt = Date.now()
        reader = response.body.getReader()
        const decoder = new TextDecoder()
        while (active) {
          const read = await readSseChunkWithDeadline(reader, sseClientTimings.idleTimeoutMs, controller.signal)
          if (read.kind === 'idle') {
            throw new Error('Live connection idle timeout; reconnecting')
          }
          if (read.chunk.done) break
          lastDataAt = Date.now()
          if (!active) return
          const decoded = decoder.decode(read.chunk.value, { stream: true })
          store.runInBatch(() => {
            parser.push(decoded)
          })
        }
        if (active) throw new Error('Live connection lost; re-syncing')
      } catch (error) {
        if (active && !controller.signal.aborted) store.setConnectionError(errorText(error))
        controller.abort()
      } finally {
        if (reader) {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
        connecting = false
        controller = undefined
        if (active) {
          store.setSseConnected(false)
          if (immediateReconnect) {
            immediateReconnect = false
            retry = 0
            void connect()
          } else {
            const backoff = computeReconnectBackoffMs(retry)
            retry += 1
            timer = setTimeout(() => {
              timer = undefined
              void connect()
            }, backoff)
          }
        }
      }
    }

    const wakeup = (): void => {
      if (!active || immediateReconnect) return
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
        retry = 0
        void connect()
        return
      }
      if (connecting && controller !== undefined) {
        if (Date.now() - lastDataAt >= sseClientTimings.staleWakeupMs) {
          immediateReconnect = true
          controller.abort()
        }
        return
      }
      retry = 0
      void connect()
    }

    const onOnline = (): void => {
      wakeup()
    }
    const onVisibilityChange = (): void => {
      if (typeof document === 'undefined' || !document.hidden) wakeup()
    }

    if (typeof window !== 'undefined') window.addEventListener('online', onOnline)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange)

    void connect()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange)
      controller?.abort()
    }
  }, [
    authenticated,
    store,
    logout,
    unreadClearInFlight,
    unreadClearedSeq,
    visibleConversationIds,
    clearVisibleConversationUnread,
  ])
}
