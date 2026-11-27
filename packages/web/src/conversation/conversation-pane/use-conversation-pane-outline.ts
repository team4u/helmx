/**
 * Outline popover state of the conversation pane: open flag, scroll requests (each jump
 * carries a fresh tick so repeating the same target re-scrolls), the reading anchor, and the
 * lazily built node list (constructed only while the popover is open).
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import { useStoreActions } from '../../lib/store-context.js'
import { useStableCallback } from '../../lib/use-stable-callback.js'
import type { OutlineJumpTarget } from '../ConversationOutlinePopover.js'
import type { OutlineScrollRequest } from '../ConversationTimeline.js'
import {
  buildConversationOutline,
  countTimelineHumanTurns,
  resolveOutlineNodeKey,
  type OutlineAnchor,
  type OutlineNode,
} from '../outline-model.js'
import type { TimelineItem } from '../timeline-model.js'

const EMPTY_OUTLINE_NODES: ReadonlyArray<OutlineNode> = []

export interface ConversationPaneOutline {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly nodes: ReadonlyArray<OutlineNode>
  readonly activeNodeKey: string | undefined
  readonly badgeCount: number
  readonly scrollRequest: OutlineScrollRequest | null
  readonly onActiveAnchorChange: (anchor: OutlineAnchor | undefined) => void
  /** Earlier history pages still exist on the server (outline "load earlier"). */
  readonly hasEarlierHistory: boolean
  readonly loadingEarlierHistory: boolean
  readonly loadEarlierHistory: () => void
  readonly onSelectTarget: (target: OutlineJumpTarget) => void
  /** Closes the popover and forgets scroll / anchor state (conversation switch, lost stage). */
  readonly close: () => void
}

export function useConversationPaneOutline(
  conversationId: number,
  timelineItems: ReadonlyArray<TimelineItem>,
  hasEarlierHistory: boolean,
  conversationStatus: string | undefined,
): ConversationPaneOutline {
  const { loadEarlierEntries } = useStoreActions()
  const { t } = useWebLocale()
  const [open, setOpen] = useState(false)
  const [scrollReq, setScrollReq] = useState<OutlineScrollRequest | null>(null)
  const [activeAnchor, setActiveAnchor] = useState<OutlineAnchor | undefined>(undefined)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const tickRef = useRef(0)
  const badgeCount = useMemo(() => countTimelineHumanTurns(timelineItems), [timelineItems])
  const nodes = useMemo(
    () =>
      open
        ? buildConversationOutline(timelineItems, { latestAssistantTurnFailed: conversationStatus === 'error' }, t)
        : EMPTY_OUTLINE_NODES,
    [open, timelineItems, conversationStatus, t],
  )
  // 大纲当前项唯一通路：阅读锚点（entryId + 回合内 headingIndex / cardId）映射为单个节点 key，
  // 同一助手回合的多个标题节点不会一起高亮。
  const activeNodeKey = useMemo(
    () =>
      !open || activeAnchor === undefined
        ? undefined
        : resolveOutlineNodeKey(nodes, activeAnchor),
    [open, nodes, activeAnchor],
  )

  const onSelectTarget = useCallback((target: OutlineJumpTarget): void => {
    tickRef.current += 1
    setScrollReq({
      entryId: target.entryId,
      ...(target.headingIndex !== undefined ? { headingIndex: target.headingIndex } : {}),
      ...(target.cardId !== undefined ? { cardId: target.cardId } : {}),
      tick: tickRef.current,
    })
  }, [])

  const loadEarlierHistory = useStableCallback((): void => {
    if (loadingEarlier || !hasEarlierHistory) return
    setLoadingEarlier(true)
    void loadEarlierEntries(conversationId).finally(() => setLoadingEarlier(false))
  })

  const close = useStableCallback((): void => {
    setOpen(false)
    setScrollReq(null)
    setActiveAnchor(undefined)
  })

  return {
    open,
    onOpenChange: setOpen,
    nodes,
    activeNodeKey,
    badgeCount,
    scrollRequest: scrollReq,
    onActiveAnchorChange: setActiveAnchor,
    hasEarlierHistory,
    loadingEarlierHistory: loadingEarlier,
    loadEarlierHistory,
    onSelectTarget,
    close,
  }
}
