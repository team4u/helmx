/**
 * Foreground-visibility-gated automatic unread clearing and visible-conversation
 * first-load sync hook.
 */
import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import type { ArtifactMetadata, ConversationSummary } from '@helmx/protocol/browser'
import { createWebTranslator } from '../i18n/catalog.js'
import { conversationsApi } from './api.js'
import { isPageActive } from './browser-notification.js'
import { topDrawerFrame } from './drawer-stack-model.js'
import { errorText } from './error-text.js'
import type { HelmxExternalStore } from './helmx-store.js'
import type { ActiveModal, DrawerFrame, ResolvedTarget } from './types.js'

export interface ArtifactsSyncWatermark {
  stateChangeSeq: number
  lastEntryId: number | undefined
}

/** 是否处于执行中（working 或 blocked 审批阻塞）：活跃期不作为产物稳定水位，也不在事件流中反复全量拉取产物。 */
export function isConversationStatusActive(status: ConversationSummary['status']): boolean {
  return status === 'working' || status === 'blocked'
}

/** 判定当前缓存的产物列表是否已对齐会话最新非活跃水位（stateChangeSeq + lastEntryId）。 */
export function isArtifactsWatermarkCurrent(
  cachedArtifacts: ReadonlyArray<ArtifactMetadata> | undefined,
  summary: Pick<ConversationSummary, 'status' | 'stateChangeSeq' | 'lastEntryId'> | undefined,
  watermark: ArtifactsSyncWatermark | undefined,
): boolean {
  return (
    cachedArtifacts !== undefined &&
    summary !== undefined &&
    !isConversationStatusActive(summary.status) &&
    watermark !== undefined &&
    watermark.stateChangeSeq === summary.stateChangeSeq &&
    watermark.lastEntryId !== undefined &&
    summary.lastEntryId !== undefined &&
    watermark.lastEntryId === summary.lastEntryId
  )
}

export interface UseUnreadSyncOptions {
  store: HelmxExternalStore
  authenticated: boolean
  primaryTarget: ResolvedTarget
  splitTarget: ResolvedTarget | null
  drawerStack: DrawerFrame[]
  activeModal: ActiveModal
}

export interface UseUnreadSyncResult {
  unreadClearInFlight: MutableRefObject<Set<number>>
  unreadClearedSeq: MutableRefObject<Map<number, number>>
  visibleConversationIds: () => number[]
  clearVisibleConversationUnread: (id: number, candidate?: ConversationSummary) => void
  resetUnreadSync: () => void
}

export function useUnreadSync({
  store,
  authenticated,
  primaryTarget,
  splitTarget,
  drawerStack,
  activeModal,
}: UseUnreadSyncOptions): UseUnreadSyncResult {
  const unreadClearInFlight = useRef(new Set<number>())
  const unreadClearedSeq = useRef(new Map<number, number>())

  const visibleConversationIds = useCallback((): number[] => {
    const ids = new Set<number>()
    for (const target of [store.getPrimaryTarget(), store.getSplitTarget()]) {
      if (target?.kind === 'conversation') ids.add(target.conversationId)
    }
    const topDrawer = topDrawerFrame(store.getDrawerStack())
    if (topDrawer?.kind === 'conversation') {
      ids.add(topDrawer.conversationId)
    }
    const modal = store.getActiveModal()
    if (modal?.kind === 'artifact-preview' || modal?.kind === 'workspace-file') {
      if (modal.conversationId !== undefined) ids.add(modal.conversationId)
    }
    return [...ids]
  }, [store])

  const resetUnreadSync = useCallback(() => {
    unreadClearInFlight.current.clear()
    unreadClearedSeq.current.clear()
  }, [])

  /**
   * Foreground-visibility-gated automatic unread clearing (single-flight +
   * stateChangeSeq watermark dedup).
   */
  const clearVisibleConversationUnread = useCallback(
    (id: number, candidate?: ConversationSummary): void => {
      const summary = candidate ?? store.getConversationSummary(id)
      if (summary === undefined) return
      if (!summary.unread) {
        const clearedSeq = unreadClearedSeq.current.get(id)
        if (clearedSeq !== undefined && summary.stateChangeSeq > clearedSeq) unreadClearedSeq.current.delete(id)
        return
      }
      if (!store.getAuthenticated() || !isPageActive()) return
      if (unreadClearInFlight.current.has(id)) return
      const clearedSeq = unreadClearedSeq.current.get(id)
      if (clearedSeq !== undefined && summary.stateChangeSeq <= clearedSeq) return
      const epoch = store.requests.sessionEpoch
      const requestedSeq = summary.stateChangeSeq
      unreadClearInFlight.current.add(id)
      void conversationsApi
        .patch(id, { unread: false })
        .then((updated) => {
          if (epoch !== store.requests.sessionEpoch) return
          unreadClearInFlight.current.delete(id)
          const updatedSeq =
            typeof updated?.stateChangeSeq === 'number' && updated.unread === false
              ? updated.stateChangeSeq
              : requestedSeq
          const ackSeq = Math.max(requestedSeq, updatedSeq)
          unreadClearedSeq.current.set(id, ackSeq)
          if (updated?.unread === false) {
            store.updateLive((state) => {
              const current = state.conversations.find((conv) => conv.id === id)
              if (current === undefined) return state
              if (typeof updated.stateChangeSeq === 'number' && current.stateChangeSeq > updated.stateChangeSeq) return state
              return {
                ...state,
                conversations: state.conversations.map((conv) =>
                  conv.id === id ? { ...conv, ...updated } : conv,
                ),
              }
            })
          }
          const latest = store.getConversationSummary(id)
          if (latest !== undefined && !latest.unread) return
          if (
            latest !== undefined &&
            latest.unread &&
            latest.stateChangeSeq > ackSeq &&
            visibleConversationIds().includes(id)
          ) {
            unreadClearedSeq.current.set(id, ackSeq)
            clearVisibleConversationUnread(id, latest)
          }
        })
        .catch((error: unknown) => {
          if (epoch === store.requests.sessionEpoch) {
            unreadClearInFlight.current.delete(id)
            const tt = createWebTranslator(store.getLocale())
            store.pushNotice({
              type: 'notification',
              level: 'error',
              title: tt('shell.unread.markFailed'),
              body: errorText(error),
            })
          }
        })
    },
    [store, visibleConversationIds],
  )

  useEffect(() => {
    if (!authenticated) return
    for (const id of visibleConversationIds()) {
      void store.loadConversationDetail(id)
      const cachedArtifacts = store.getConversationArtifactsMap()[id]
      const summary = store.getConversationSummary(id)
      const wm = store.requests.artifactsWatermarks.get(id)
      if (!isArtifactsWatermarkCurrent(cachedArtifacts, summary, wm)) {
        void store.loadConversationArtifacts(id)
      }
      clearVisibleConversationUnread(id)
    }
  }, [
    authenticated,
    primaryTarget,
    splitTarget,
    drawerStack,
    activeModal,
    store,
    visibleConversationIds,
    clearVisibleConversationUnread,
  ])

  useEffect(() => {
    if (!authenticated || typeof document === 'undefined' || typeof window === 'undefined') return
    const onPageActive = () => {
      if (!isPageActive()) return
      for (const id of visibleConversationIds()) {
        clearVisibleConversationUnread(id)
      }
    }
    document.addEventListener('visibilitychange', onPageActive)
    window.addEventListener('focus', onPageActive)
    return () => {
      document.removeEventListener('visibilitychange', onPageActive)
      window.removeEventListener('focus', onPageActive)
    }
  }, [authenticated, visibleConversationIds, clearVisibleConversationUnread])

  return {
    unreadClearInFlight,
    unreadClearedSeq,
    visibleConversationIds,
    clearVisibleConversationUnread,
    resetUnreadSync,
  }
}
