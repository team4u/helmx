/**
 * Shared `<Activity>` keep-alive frame lifecycle hook used by ConversationWindowStage
 * and DrawerStackShell:
 * - mirrors the hidden child's dirty-draft snapshot into the external dirty registry;
 * - silently refreshes the conversation detail once a hidden keep-alive frame wakes up.
 */
import { useEffect, useRef } from 'react'
import { clearComposerDirty, isComposerDirtySnapshot, setComposerDirty } from './composer-dirty.js'
import type { ConversationDirtySink } from './conversation-window-model.js'

export function useActivityFrameLifecycle({
  frameDirtyKey,
  conversationId,
  visible,
  loadConversationDetail,
}: {
  frameDirtyKey: string
  conversationId: number
  visible: boolean
  loadConversationDetail: (
    conversationId: number,
    force?: boolean,
    opts?: { silent?: boolean; limit?: number; turns?: number },
  ) => Promise<unknown>
}): ConversationDirtySink {
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const dirtySinkRef = useRef<ConversationDirtySink | null>(null)
  if (dirtySinkRef.current === null) {
    dirtySinkRef.current = { current: null }
  }
  const dirtySink = dirtySinkRef.current
  dirtySink.publish = (snapshot) => {
    if (!mountedRef.current || visibleRef.current) return
    if (isComposerDirtySnapshot(snapshot)) setComposerDirty(frameDirtyKey, snapshot, conversationId)
    else clearComposerDirty(frameDirtyKey)
  }

  const wasVisibleRef = useRef(visible)

  useEffect(() => {
    if (visible) {
      clearComposerDirty(frameDirtyKey)
      return
    }
    const snapshot = dirtySink.current
    if (snapshot !== null && isComposerDirtySnapshot(snapshot)) {
      setComposerDirty(frameDirtyKey, snapshot, conversationId)
    } else {
      clearComposerDirty(frameDirtyKey)
    }
    return () => clearComposerDirty(frameDirtyKey)
  }, [visible, frameDirtyKey, conversationId, dirtySink])

  useEffect(() => {
    const wasVisible = wasVisibleRef.current
    wasVisibleRef.current = visible
    if (!visible || wasVisible) return
    void loadConversationDetail(conversationId, true, { silent: true })
  }, [visible, conversationId, loadConversationDetail])

  return dirtySink
}
