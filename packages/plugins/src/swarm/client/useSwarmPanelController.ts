/**
 * State, subscriptions, and guarded action controller for `SwarmWorkbenchPanel`.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { WorkbenchPanelProps } from '@helmx/protocol/browser'
import {
  useConversations,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginSessionDoc,
} from '@helmx/plugin-client'
import type { SwarmIndexDoc } from './models.ts'
import {
  mergeBoardViewWithRead, parseBoardView, resolveConversationBoardLink, type BoardViewDoc,
} from './board-model.ts'
import { buildSwarmPanelModel } from './model-panel.ts'
import { resolveGroupTimingView } from './model-timing.ts'
import { useElapsedNowMs, useSwarmBoardPeekPost, useSwarmBoardReadOnce, useSwarmBoardStatusFallback } from './hooks.ts'
import * as C from './copy.ts'
import {
  currentPeekSeq, openPostPeek, popJumpBack, popPostPeek, pushJumpBack, pushPostPeek, type PostPeekState,
} from './model-post-nav.ts'

export const SWARM_RECENT_LIMIT_COLLAPSED = 6

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function useSwarmPanelController(props?: Partial<WorkbenchPanelProps>) {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const conversationId = props?.conversation?.id ?? ctx.conversationId
  const conversations = useConversations()
  const index = usePluginDoc<SwarmIndexDoc>('index')

  const panelRef = useRef<HTMLDivElement | null>(null)
  const peekAnchorRef = useRef<HTMLElement | null>(null)
  const appliedParamsRef = useRef<unknown>(undefined)
  const mountedRef = useRef(true)
  const activeConvRef = useRef<number | undefined>(conversationId)
  const sessionEpochRef = useRef(0)

  const requestedPostSeq =
    typeof props?.params?.['postSeq'] === 'number' &&
    Number.isSafeInteger(props.params['postSeq']) &&
    props.params['postSeq'] > 0
      ? props.params['postSeq']
      : undefined

  const [historyExpanded, setHistoryExpanded] = useState(false)
  const [highlightedSeq, setHighlightedSeq] = useState<number | undefined>(requestedPostSeq)
  const [peekState, setPeekState] = useState<PostPeekState | undefined>(undefined)
  const [jumpBackStack, setJumpBackStack] = useState<number[]>([])
  const [busyAction, setBusyAction] = useState<string | undefined>(undefined)
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [closeKeepWorktree, setCloseKeepWorktree] = useState(false)
  const [closeAbortRunning, setCloseAbortRunning] = useState(false)
  const [closeError, setCloseError] = useState<string | undefined>(undefined)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    activeConvRef.current = conversationId
    sessionEpochRef.current += 1
    appliedParamsRef.current = undefined
    setHistoryExpanded(false)
    setHighlightedSeq(undefined)
    setPeekState(undefined)
    setJumpBackStack([])
    setBusyAction(undefined)
    setCloseDialogOpen(false)
    setCloseError(undefined)
  }, [conversationId])

  const link = useMemo(() => resolveConversationBoardLink(conversationId, index), [conversationId, index])
  const currentConv = props?.conversation ?? conversations.find((c) => c.id === conversationId)
  const hasArchivedTag =
    currentConv?.tags.includes('swarm-coordinator-archived') === true ||
    currentConv?.tags.includes('swarm-worker-archived') === true

  const rawBoard = usePluginSessionDoc<BoardViewDoc | null>(
    'board-view',
    link ? { conversationId: link.coordinatorConversationId } : undefined,
  )
  const liveBoard = useMemo(() => {
    const parsed = rawBoard !== undefined ? parseBoardView(rawBoard) : undefined
    return parsed && (!link || parsed.group.id === link.groupId) ? parsed : undefined
  }, [rawBoard, link])

  const needsFallback = (link !== undefined || hasArchivedTag) && liveBoard === undefined
  const fallback = useSwarmBoardStatusFallback(link?.groupId, {
    conversationId,
    enabled: needsFallback,
    allowConversationLookup: hasArchivedTag,
  })

  const board = liveBoard ?? fallback.view
  const loading = needsFallback && fallback.loading && !board
  const loadError = liveBoard ? undefined : fallback.error
  const isFallbackData = !liveBoard && Boolean(board)
  const resolvedGroupId = link?.groupId ?? board?.group.id

  const needsFullRead =
    historyExpanded && (isFallbackData || (board !== undefined && board.posts.length < board.group.headSeq))
  const readState = useSwarmBoardReadOnce(resolvedGroupId, needsFullRead, {
    conversationId,
    headSeq: board?.group.headSeq,
    initialOldestSeq: board?.posts[0]?.seq,
  })
  const boardWithHistory = useMemo(
    () => (board && readState.posts.length > 0 ? mergeBoardViewWithRead(board, readState.posts) : board),
    [board, readState.posts],
  )

  const peekTargetSeq = peekState ? currentPeekSeq(peekState) : undefined
  const peekNeedsExact =
    peekTargetSeq !== undefined &&
    boardWithHistory !== undefined &&
    peekTargetSeq <= boardWithHistory.group.headSeq &&
    !boardWithHistory.posts.some((p) => p.seq === peekTargetSeq)
  const peekReadState = useSwarmBoardPeekPost(resolvedGroupId, peekTargetSeq, { conversationId, enabled: peekNeedsExact })
  const effectiveBoard = useMemo(
    () => (boardWithHistory && peekReadState.posts.length > 0 ? mergeBoardViewWithRead(boardWithHistory, peekReadState.posts) : boardWithHistory),
    [boardWithHistory, peekReadState.posts],
  )

  const model = useMemo(
    () =>
      effectiveBoard
        ? buildSwarmPanelModel(effectiveBoard, conversations, {
            recentLimit: historyExpanded ? null : SWARM_RECENT_LIMIT_COLLAPSED,
          })
        : undefined,
    [effectiveBoard, conversations, historyExpanded],
  )

  useEffect(() => {
    if (requestedPostSeq === undefined || props?.params === appliedParamsRef.current) return
    setHighlightedSeq(requestedPostSeq)
    if (effectiveBoard === undefined) return
    appliedParamsRef.current = props?.params
    if (!effectiveBoard.posts.slice(-SWARM_RECENT_LIMIT_COLLAPSED).some((p) => p.seq === requestedPostSeq)) {
      setHistoryExpanded(true)
    }
  }, [conversationId, props?.params, requestedPostSeq, effectiveBoard])

  useEffect(() => {
    if (highlightedSeq !== undefined) {
      panelRef.current?.querySelector<HTMLElement>(`[data-post-seq="${highlightedSeq}"]`)?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [highlightedSeq, model?.recentPosts])

  const timerActive =
    effectiveBoard !== undefined &&
    effectiveBoard.group.status === 'active' &&
    (effectiveBoard.group.createdAt > 0 ||
      effectiveBoard.members.some((m) => m.lifecycle === 'active' && (m.liveState === 'working' || m.liveState === 'blocked')))
  const nowMs = useElapsedNowMs(timerActive)
  const groupTiming = effectiveBoard ? resolveGroupTimingView(effectiveBoard, conversations, nowMs, locale) : undefined
  const memberConvByName = useMemo(() => {
    const map = new Map<string, number>()
    if (effectiveBoard !== undefined) {
      for (const m of effectiveBoard.members) map.set(m.name, m.conversationId)
    }
    return map
  }, [effectiveBoard])

  const isGuardValid = (targetConvId: number, epoch: number): boolean =>
    mountedRef.current && activeConvRef.current === targetConvId && sessionEpochRef.current === epoch

  const runAbortMember = (memberName: string): void => {
    if (busyAction || !effectiveBoard || conversationId === undefined) return
    const targetConvId = conversationId
    const epoch = sessionEpochRef.current
    setBusyAction(`abort:${memberName}`)
    void ctx
      .callAction('abort_worker', { groupId: effectiveBoard.group.id, name: memberName }, { conversationId: targetConvId })
      .catch((err: unknown) => {
        if (!isGuardValid(targetConvId, epoch)) return
        ctx.notify(C.trayAbortFailed(errorText(err), locale), 'error')
      })
      .finally(() => {
        if (isGuardValid(targetConvId, epoch)) setBusyAction(undefined)
      })
  }

  const openCloseDialog = (): void => {
    if (!effectiveBoard) return
    setCloseKeepWorktree(effectiveBoard.members.some((m) => m.lifecycle === 'active' && m.worktreeId !== undefined))
    setCloseAbortRunning(effectiveBoard.activeWorkingMembers.length > 0)
    setCloseError(undefined)
    setCloseDialogOpen(true)
  }

  const dismissCloseDialog = (): void => {
    if (busyAction === 'close_group') return
    setCloseDialogOpen(false)
    setCloseError(undefined)
  }

  const confirmCloseGroup = (): void => {
    if (busyAction || !effectiveBoard || conversationId === undefined) return
    const targetConvId = conversationId
    const epoch = sessionEpochRef.current
    setBusyAction('close_group')
    setCloseError(undefined)
    void ctx
      .callAction(
        'close_group',
        {
          groupId: effectiveBoard.group.id,
          ...(closeKeepWorktree ? { keepWorktree: true } : {}),
          ...(closeAbortRunning ? { abortRunning: true } : {}),
        },
        { conversationId: targetConvId },
      )
      .then((res) => {
        if (!isGuardValid(targetConvId, epoch)) return
        setCloseDialogOpen(false)
        const uncleaned =
          res !== null && typeof res === 'object' && Array.isArray((res as { uncleanedWorktrees?: unknown }).uncleanedWorktrees)
            ? (res as { uncleanedWorktrees: unknown[] }).uncleanedWorktrees
            : []
        if (uncleaned.length > 0) {
          ctx.notify(C.panelCloseUncleanedNotice(uncleaned.length, locale), 'warning')
        }
      })
      .catch((err: unknown) => {
        if (!isGuardValid(targetConvId, epoch)) return
        const msg = errorText(err)
        setCloseError(msg)
        ctx.notify(C.panelCloseFailed(msg, locale), 'error')
      })
      .finally(() => {
        if (isGuardValid(targetConvId, epoch)) setBusyAction(undefined)
      })
  }

  const visibleSeqs = new Set(model?.recentPosts.map((p) => p.seq) ?? [])
  const scrollAndHighlightPost = (seq: number): void => {
    if (
      effectiveBoard &&
      !visibleSeqs.has(seq) &&
      !effectiveBoard.posts.slice(-SWARM_RECENT_LIMIT_COLLAPSED).some((p) => p.seq === seq)
    ) {
      setHistoryExpanded(true)
    }
    setHighlightedSeq(seq)
  }

  const handleOpenPeek = (originSeq: number, targetSeq: number, anchorEl: HTMLElement): void => {
    peekAnchorRef.current = anchorEl
    setPeekState(openPostPeek(originSeq, targetSeq))
  }

  const handleLocateFromPeek = (targetSeq: number): void => {
    if (peekState) setJumpBackStack((prev) => pushJumpBack(prev, peekState.originSeq, targetSeq))
    setPeekState(undefined)
    scrollAndHighlightPost(targetSeq)
  }

  const handleJumpBack = (): void => {
    const { targetSeq, nextStack } = popJumpBack(jumpBackStack)
    setJumpBackStack(nextStack)
    if (targetSeq !== undefined) scrollAndHighlightPost(targetSeq)
  }

  const peekPost = peekTargetSeq !== undefined ? effectiveBoard?.posts.find((p) => p.seq === peekTargetSeq) : undefined

  return {
    ctx,
    locale,
    conversationId,
    panelRef,
    peekAnchorRef,
    link,
    hasArchivedTag,
    loading,
    loadError,
    isFallbackData,
    fallback,
    readState,
    peekReadState,
    effectiveBoard,
    model,
    nowMs,
    groupTiming,
    memberConvByName,
    historyExpanded,
    setHistoryExpanded,
    highlightedSeq,
    peekState,
    setPeekState,
    peekPost,
    jumpBackStack,
    setJumpBackStack,
    busyAction,
    closeDialogOpen,
    closeKeepWorktree,
    setCloseKeepWorktree,
    closeAbortRunning,
    setCloseAbortRunning,
    closeError,
    runAbortMember,
    openCloseDialog,
    dismissCloseDialog,
    confirmCloseGroup,
    handleOpenPeek,
    handleLocateFromPeek,
    handleJumpBack,
    pushPeekRef: (seq: number) => setPeekState((prev) => (prev ? pushPostPeek(prev, seq) : prev)),
    popPeekRef: () => setPeekState((prev) => (prev ? popPostPeek(prev) : undefined)),
  }
}
