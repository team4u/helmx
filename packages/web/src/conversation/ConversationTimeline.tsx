import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
  ProfileStarterPrompt,
} from '@helmx/protocol/browser'
import {
  Button,
  createTimelineToolCallsStore,
  HelmxIcon,
  LoadingState,
  TimelineToolCallsContext,
} from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  useConversationDetail,
  useGroupedUi,
  useHighlightedEntryForConversation,
  useLoadError,
  useResolvedAsks,
  useStoreActions,
  type ResolvedAskEntry,
} from '../lib/store-context.js'
import { AssistantModelBoundary, AssistantTurnView } from './AssistantTurn.js'
import { ProcessInspectorDrawer } from './ProcessInspectorDrawer.js'
import { ProcessInspectorContext, type ProcessInspectorController } from './process-inspector-context.js'
import {
  findLatestProcessTarget,
  resolveProcessInspection,
  stepKeyOf,
  type ProcessInspectMode,
  type ProcessInspectTarget,
  type ResolvedProcessInspection,
} from './process-inspector-model.js'
import {
  ContextDivider,
  PluginCard,
  ResolvedAskRow,
  TimelineLiveWaitingRow,
  TurnErrorNotice,
} from './TimelineAuxRows.js'
import { TimelineHumanMessage } from './TimelineHumanMessage.js'
import { useTimelineEntryActions } from './timeline-actions.js'
import {
  resolveContainmentClass,
  supportsTimelineContainment,
  timelineAnchorId,
  type ContainmentExclusions,
} from './timeline-containment-model.js'
import type { OutlineAnchor } from './outline-model.js'
import {
  buildActiveEntryIndex,
  buildAssistantModelBoundaries,
  buildLiveTimelineTail,
  buildSettledTimelinePrefix,
  collectToolCallsByName,
  findLatestProcessTurnKey,
  lastEditableHumanInput,
  resolveAssistantAnchorEntry,
  type EditRequestTarget,
  type FoldableStep,
  type TimelineItem,
} from './timeline-model.js'
import { useTimelineScroll, type TimelineOutlineScrollRequest } from './use-timeline-scroll.js'

const EMPTY_RESOLVED_ASKS: ResolvedAskEntry[] = []
const EMPTY_STEPS: ReadonlyArray<FoldableStep> = []
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

interface TimelineBeforeCommitSnapshotProps {
  conversationId: number
  detailEntries: ReadonlyArray<ConversationEntry>
  onBeforeEntriesCommit: (nextConversationId: number, nextEntries: ReadonlyArray<ConversationEntry>) => void
}

/** Pre-mutation lifecycle bridge: captures SWR scroll anchor in `getSnapshotBeforeUpdate` rather than during render. */
class TimelineBeforeCommitSnapshot extends Component<TimelineBeforeCommitSnapshotProps> {
  override getSnapshotBeforeUpdate(prevProps: TimelineBeforeCommitSnapshotProps): null {
    if (
      prevProps.conversationId !== this.props.conversationId ||
      prevProps.detailEntries !== this.props.detailEntries
    ) {
      this.props.onBeforeEntriesCommit(this.props.conversationId, this.props.detailEntries)
    }
    return null
  }

  override componentDidUpdate(): void {}

  override render(): ReactNode {
    return null
  }
}

export type OutlineScrollRequest = TimelineOutlineScrollRequest

export interface ConversationTimelineProps {
  conversation: ConversationSummary
  detailEntries: ReadonlyArray<ConversationEntry>
  live?: ConversationLive
  timelineItems?: ReadonlyArray<TimelineItem>
  sendingPending?: boolean
  staged?: boolean
  outlineOpen?: boolean
  outlineScrollRequest?: OutlineScrollRequest | null
  /** 当前阅读位置对应的大纲激活锚点（entryId + 回合内 headingIndex / 卡片 cardId）。 */
  onActiveOutlineChange?: (anchor: OutlineAnchor | undefined) => void
  onRequestEdit: (target: EditRequestTarget) => void
  onRequestStarter?: (text: string) => void
  starters?: ProfileStarterPrompt[]
}

export function ConversationTimeline({
  conversation,
  detailEntries,
  live,
  timelineItems,
  sendingPending = false,
  staged = true,
  outlineOpen = true,
  outlineScrollRequest,
  onActiveOutlineChange,
  onRequestEdit,
  onRequestStarter,
  starters,
}: ConversationTimelineProps) {
  const groupedUi = useGroupedUi()
  const resolvedAsks = useResolvedAsks(conversation.id) ?? EMPTY_RESOLVED_ASKS
  const highlightedEntry = useHighlightedEntryForConversation(conversation.id)
  const conversationDetail = useConversationDetail(conversation.id)
  const historyError = useLoadError(`history:${conversation.id}`)
  const { loadEarlierEntries: fetchEarlierEntries } = useStoreActions()
  const { t } = useWebLocale()
  const entryActions = useTimelineEntryActions(conversation, onRequestEdit)
  const [inspectTarget, setInspectTarget] = useState<ProcessInspectTarget | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const itemsRef = useRef<ReadonlyArray<TimelineItem>>([])
  const resolvedInspectionRef = useRef<ResolvedProcessInspection | null>(null)

  const isWorking = conversation.status === 'working'
  const isCompacting = conversation.contextUsage?.compacting === true
  const fallbackSettledPrefix = useMemo(
    () =>
      timelineItems !== undefined
        ? null
        : buildSettledTimelinePrefix(detailEntries, {
            timelineRenderers: groupedUi.timelineRenderers,
            toolViews: groupedUi.toolViews,
          }),
    [timelineItems, detailEntries, groupedUi.timelineRenderers, groupedUi.toolViews],
  )
  const items = useMemo(() => {
    if (timelineItems !== undefined) return timelineItems
    const prefix = fallbackSettledPrefix!
    const tail = buildLiveTimelineTail(prefix, {
      ...(live !== undefined ? { live } : {}),
      working: isWorking,
      compacting: isCompacting,
      toolViews: groupedUi.toolViews,
    })
    return tail.length === 0 ? prefix.items : [...prefix.items, ...tail]
  }, [timelineItems, fallbackSettledPrefix, live, isWorking, isCompacting, groupedUi.toolViews])

  const activeEntriesById = useMemo(() => buildActiveEntryIndex(detailEntries), [detailEntries])
  const hasLiveTurn = items.some((item) => item.kind === 'assistant' && item.live)

  const [toolCallsStore] = useState(() => createTimelineToolCallsStore(collectToolCallsByName(items)))
  useIsomorphicLayoutEffect(() => {
    toolCallsStore.update(collectToolCallsByName(items))
  }, [toolCallsStore, items])

  const modelBoundaries = useMemo(() => buildAssistantModelBoundaries(items), [items])

  const lastAssistantKey = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.kind === 'assistant') return items[i]!.key
    }
    return undefined
  }, [items])

  const trailingAssistantKey = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!
      if (item.kind === 'human' && item.queuedMode !== undefined) continue
      return item.kind === 'assistant' ? item.key : undefined
    }
    return undefined
  }, [items])

  const latestProcessTurnKey = useMemo(() => findLatestProcessTurnKey(items), [items])
  itemsRef.current = items

  const resolvedInspection = useMemo(
    () => resolveProcessInspection(items, inspectTarget),
    [items, inspectTarget],
  )
  resolvedInspectionRef.current = resolvedInspection

  const lastHumanKey = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!
      if (item.kind === 'human' && item.origin === 'human') return item.key
    }
    return undefined
  }, [items])

  const lastTurnSummary = useMemo(() => {
    const last = items[items.length - 1]
    if (last?.kind !== 'assistant') return ''
    return last.segments
      .map((s) => (s.kind === 'step-group' ? `g:${s.stepCount}:${s.active ? 1 : 0}` : s.kind === 'tool' ? `t:${s.tool.key}:${s.tool.status}` : `x:${s.text.length}`))
      .join(',')
  }, [items])

  const contentFingerprint = `${items.length}:${detailEntries.length}:${conversation.status}:${conversation.contextUsage?.compacting === true ? 1 : 0}:${lastTurnSummary}:${live?.updatedAt ?? 0}:${live?.thinking?.length ?? 0}:${live?.text.length ?? 0}:${live?.queuedInputs?.map((q) => `${q.id}:${q.mode}`).join(',') ?? ''}:${resolvedAsks.length}`
  const detailsReady = conversationDetail !== undefined
  const anchorSignature = useMemo(() => items.map((item) => timelineAnchorId(item)).join('\n'), [items])
  const closeInspector = useCallback(() => setInspectTarget(null), [])

  const openStepGroup = useCallback(
    (
      turnKey: string,
      segmentKey: string,
      opts?: { stepKey?: string; stepIndex?: number; followLive?: boolean },
    ): void => {
      setInspectTarget({
        kind: 'step-group',
        turnKey,
        segmentKey,
        ...(opts?.stepKey !== undefined ? { selectedStepKey: opts.stepKey } : {}),
        ...(opts?.stepIndex !== undefined ? { selectedStepIndex: opts.stepIndex } : {}),
        ...(opts?.followLive !== undefined ? { followLive: opts.followLive } : {}),
      })
    },
    [],
  )

  const openStandaloneTool = useCallback(
    (turnKey: string, toolKey: string, mode: ProcessInspectMode): void => {
      setInspectTarget({ kind: 'standalone-tool', turnKey, toolKey, mode })
    },
    [],
  )

  const inspectorController = useMemo<ProcessInspectorController>(
    () => ({
      activeTarget: inspectTarget,
      openStepGroup,
      openStandaloneTool,
      close: closeInspector,
    }),
    [inspectTarget, openStepGroup, openStandaloneTool, closeInspector],
  )

  useEffect(() => {
    if (!staged) {
      setInspectTarget(null)
    }
  }, [staged])

  useEffect(() => {
    if (inspectTarget !== null && resolvedInspection === null) {
      setInspectTarget(null)
    }
  }, [inspectTarget, resolvedInspection])

  // Preserve the step being followed when a live step-group transitions to settled.
  useEffect(() => {
    if (
      resolvedInspection === null ||
      inspectTarget === null ||
      inspectTarget.kind !== 'step-group' ||
      inspectTarget.followLive !== true ||
      !resolvedInspection.active
    ) {
      return
    }
    const nextKey = stepKeyOf(resolvedInspection.selectedStep, resolvedInspection.selectedIndex)
    const nextIndex = resolvedInspection.selectedIndex
    setInspectTarget((prev) => {
      if (
        prev === null ||
        prev.kind !== 'step-group' ||
        prev.followLive !== true ||
        (prev.selectedStepKey === nextKey && prev.selectedStepIndex === nextIndex)
      ) {
        return prev
      }
      return { ...prev, selectedStepKey: nextKey, selectedStepIndex: nextIndex }
    })
  }, [inspectTarget, resolvedInspection])

  const {
    scrollRef,
    innerRef,
    bottomRef,
    charsPerLine,
    loadingOlder,
    localHighlightEntryId,
    showScrollBottom,
    hasUnreadScrollUpdates,
    highlightScrollRef,
    scrollToBottomAndFollow,
    loadEarlierEntries,
    captureBeforeEntriesCommit,
  } = useTimelineScroll({
    conversationId: conversation.id,
    detailEntries,
    detailsReady,
    isWorking,
    hasLiveTurn,
    contentFingerprint,
    lastHumanKey,
    anchorSignature,
    highlightedEntry,
    outlineScrollRequest,
    outlineOpen,
    onActiveOutlineChange,
    onConversationSwitch: closeInspector,
    fetchEarlierEntries,
  })

  // Ctrl+O global shortcut dispatch: opens or closes the latest process-group inspector drawer per pane.
  useEffect(() => {
    const onShortcut = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return
      const detail = event.detail as unknown
      if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return
      const { action, panel } = detail as { action?: unknown; panel?: unknown }
      if (action !== 'toggle-process-groups' || (panel !== 'primary' && panel !== 'split')) return
      const root = rootRef.current
      if (root === null) return
      if (root.closest('.conversation-drawer') !== null) return
      const myPanel = root.closest('[data-helmx-panel]')?.getAttribute('data-helmx-panel') ?? 'primary'
      if (panel !== myPanel) return
      if (resolvedInspectionRef.current !== null) {
        setInspectTarget(null)
        return
      }
      const nextTarget = findLatestProcessTarget(itemsRef.current)
      if (nextTarget !== null) {
        setInspectTarget(nextTarget)
      }
    }
    window.addEventListener('helmx:shortcut', onShortcut)
    return () => window.removeEventListener('helmx:shortcut', onShortcut)
  }, [])

  const highlightClass = (entryId: string): string => {
    const matchedStore = highlightedEntry !== null && highlightedEntry.conversationId === conversation.id && highlightedEntry.entryId === entryId
    const matchedLocal = localHighlightEntryId === entryId
    return matchedStore || matchedLocal ? ' entry-highlighted' : ''
  }

  const containmentEnabled = useMemo(() => supportsTimelineContainment(), [])
  const releasedEntryIds = useMemo(() => {
    const ids = new Set<string>()
    if (highlightedEntry !== null && highlightedEntry.conversationId === conversation.id && highlightedEntry.entryId !== '') {
      ids.add(highlightedEntry.entryId)
    }
    if (localHighlightEntryId !== null && localHighlightEntryId !== '') ids.add(localHighlightEntryId)
    const requested = outlineScrollRequest?.entryId
    if (requested !== undefined && requested !== '') ids.add(requested)
    return ids
  }, [highlightedEntry, conversation.id, localHighlightEntryId, outlineScrollRequest])

  const cvExclusions = useMemo<ContainmentExclusions>(
    () => ({ releasedEntryIds, latestAssistantKey: lastAssistantKey, charsPerLine }),
    [releasedEntryIds, lastAssistantKey, charsPerLine],
  )

  const latestRetryTarget = useMemo(() => lastEditableHumanInput(detailEntries), [detailEntries])
  const regenerateLatestTurn = useCallback(
    () => (latestRetryTarget !== undefined ? entryActions.retryTurn(latestRetryTarget) : Promise.resolve()),
    [entryActions.retryTurn, latestRetryTarget],
  )
  const loading = !detailsReady
  const hasOlderCursor = Boolean(conversationDetail?.nextCursor)
  const showEmptyState =
    !loading && !sendingPending && !isWorking && items.length === 0 && resolvedAsks.length === 0
  const startersVisible =
    starters !== undefined &&
    starters.length > 0 &&
    onRequestStarter !== undefined &&
    !loading &&
    conversationDetail?.nextCursor === undefined &&
    !isWorking &&
    conversation.status !== 'blocked' &&
    !sendingPending &&
    (live?.queuedInputs?.length ?? 0) === 0 &&
    items.length === 0 &&
    resolvedAsks.length === 0
  const hasLeadingCenterSlot =
    hasOlderCursor || Boolean(historyError) || loading || showEmptyState || startersVisible

  return (
    <div ref={rootRef} className="timeline-container">
      <TimelineBeforeCommitSnapshot
        conversationId={conversation.id}
        detailEntries={detailEntries}
        onBeforeEntriesCommit={captureBeforeEntriesCommit}
      />
      <div ref={scrollRef} className="timeline-scroll">
        {hasLeadingCenterSlot ? (
          <div className="timeline-center-slot">
            {hasOlderCursor ? (
              <Button variant="ghost" size="sm" pending={loadingOlder} className="timeline-load-older-btn" onClick={loadEarlierEntries}>
                {loadingOlder ? t('conv.timeline.loadingHistory') : t('conv.timeline.loadEarlier')}
              </Button>
            ) : null}
            {historyError ? <p className="callout callout-error" role="alert">{historyError}</p> : null}
            {loading ? (
              <LoadingState label={t('conv.timeline.loadingConversation')} iconSize={14} className="timeline-loading-state" />
            ) : null}
            {showEmptyState ? (
              <div className="timeline-empty-state">
                <HelmxIcon name="message-square" size={22} />
                <span>{t('conv.timeline.empty')}</span>
              </div>
            ) : null}
            {startersVisible ? (
              <div className="timeline-starters">
                {starters.map((starter, index) => (
                  <button
                    key={`starter-${index}-${starter.label}`}
                    type="button"
                    className="timeline-starter-btn"
                    title={starter.prompt}
                    onClick={() => onRequestStarter?.(starter.prompt)}
                  >
                    <HelmxIcon name="corner-down-right" size={11} />
                    <span className="timeline-starter-label">{starter.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <ProcessInspectorContext.Provider value={inspectorController}>
          <TimelineToolCallsContext.Provider value={toolCallsStore}>
            <div ref={innerRef} className="timeline-inner">
              {items.map((item) => {
                const cvClass = resolveContainmentClass(item, cvExclusions, containmentEnabled)
                if (item.kind === 'human') {
                  return (
                    <div
                      key={item.key}
                      className={`timeline-human-wrap ${highlightClass(item.entryId)}${cvClass !== '' ? ` ${cvClass}` : ''}`}
                      ref={highlightScrollRef}
                      data-entry-id={item.entryId}
                    >
                      <TimelineHumanMessage
                        item={item}
                        conversation={conversation}
                        onRequestEdit={onRequestEdit}
                        onForkFromHere={entryActions.forkFromHere}
                        onWithdrawQueuedEdit={entryActions.withdrawQueuedForEdit}
                      />
                    </div>
                  )
                }
                if (item.kind === 'divider') {
                  return (
                    <div
                      key={item.key}
                      className={`${highlightClass(item.entryId)}${cvClass !== '' ? ` ${cvClass}` : ''}`.trim()}
                      ref={highlightScrollRef}
                      data-entry-id={item.entryId}
                    >
                      <ContextDivider item={item} />
                    </div>
                  )
                }
                if (item.kind === 'plugin-card') {
                  return (
                    <div
                      key={item.key}
                      className={`${highlightClass(item.entryId)}${cvClass !== '' ? ` ${cvClass}` : ''}`.trim()}
                      ref={highlightScrollRef}
                      data-entry-id={item.entryId}
                    >
                      <PluginCard item={item} conversationId={conversation.id} />
                    </div>
                  )
                }
                const anchorId = timelineAnchorId(item)
                const modelBoundary = modelBoundaries.get(item.key)
                return (
                  <div
                    key={item.key}
                    className={`${highlightClass(anchorId)}${cvClass !== '' ? ` ${cvClass}` : ''}`.trim()}
                    ref={highlightScrollRef}
                    data-entry-id={anchorId}
                    data-latest-process-turn={item.key === latestProcessTurnKey ? 'true' : undefined}
                  >
                    {modelBoundary !== undefined ? <AssistantModelBoundary model={modelBoundary} /> : null}
                    <AssistantTurnView
                      turn={item}
                      conversation={conversation}
                      anchorEntry={resolveAssistantAnchorEntry(item.entryIds, activeEntriesById)}
                      isLatestTurn={item.key === lastAssistantKey}
                      isTrailingTurn={item.key === trailingAssistantKey}
                      onForkFromHere={entryActions.forkFromHere}
                      onRegenerate={
                        item.key === lastAssistantKey && !isWorking && !sendingPending && latestRetryTarget !== undefined
                          ? regenerateLatestTurn
                          : undefined
                      }
                    />
                  </div>
                )
              })}
              {(isWorking && !hasLiveTurn) || (sendingPending && !isWorking) ? (
                <TimelineLiveWaitingRow conversation={conversation} isWorking={isWorking} />
              ) : null}
              {resolvedAsks.map(({ ask, status }) => (
                <ResolvedAskRow key={`ask:${ask.id}`} ask={ask} status={status} />
              ))}
              {conversation.status === 'error' ? (
                <TurnErrorNotice
                  conversation={conversation}
                  editTarget={latestRetryTarget}
                  onRequestEdit={onRequestEdit}
                  onRetryTurn={entryActions.retryTurn}
                />
              ) : null}
            </div>
          </TimelineToolCallsContext.Provider>
        </ProcessInspectorContext.Provider>
        <div ref={bottomRef} className="timeline-scroll-anchor" />
      </div>
      {showScrollBottom ? (
        <button
          type="button"
          className={`timeline-scroll-bottom-btn${hasUnreadScrollUpdates ? ' has-unread' : ''}`}
          aria-label={t('conv.timeline.backToBottom')}
          title={t('conv.timeline.backToBottom')}
          onClick={scrollToBottomAndFollow}
        >
          <HelmxIcon name="arrow-down" size={16} />
          {isWorking || hasLiveTurn || sendingPending || hasUnreadScrollUpdates ? (
            <span className="timeline-scroll-bottom-dot" aria-hidden="true" />
          ) : null}
        </button>
      ) : null}
      <ProcessInspectorDrawer
        open={resolvedInspection !== null}
        conversationId={conversation.id}
        steps={resolvedInspection?.steps ?? EMPTY_STEPS}
        active={resolvedInspection?.active ?? false}
        selectedIndex={resolvedInspection?.selectedIndex ?? 0}
        mode={resolvedInspection?.mode ?? 'default'}
        followLive={inspectTarget?.kind === 'step-group' ? inspectTarget.followLive : undefined}
        onSelectStep={(index, stepKey) => {
          setInspectTarget((prev) => {
            if (prev === null || prev.kind !== 'step-group') return prev
            return {
              ...prev,
              selectedStepKey: stepKey,
              selectedStepIndex: index,
              followLive: false,
            }
          })
        }}
        onFollowLive={() => {
          setInspectTarget((prev) => {
            if (prev === null || prev.kind !== 'step-group') return prev
            return {
              kind: 'step-group',
              turnKey: prev.turnKey,
              segmentKey: prev.segmentKey,
              followLive: true,
            }
          })
        }}
        onClose={closeInspector}
      />
    </div>
  )
}
