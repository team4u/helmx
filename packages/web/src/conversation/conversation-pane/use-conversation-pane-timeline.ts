/**
 * Normalized timeline of one conversation pane: the settled prefix is memoized on the
 * persisted entries alone so historical items keep `===` identity across streaming deltas;
 * only the live tail rebuilds on live / working / compacting changes. Also exposes the live
 * stream (timeline stitching) and the detail paging cursor (outline "load earlier").
 */
import { useMemo } from 'react'
import type { ConversationDetail, ConversationEntry, ConversationLive } from '@helmx/protocol/browser'
import { useConversationLive, useGroupedUi } from '../../lib/store-context.js'
import { buildLiveTimelineTail, buildSettledTimelinePrefix, type TimelineItem } from '../timeline-model.js'

const EMPTY_ENTRIES: ReadonlyArray<ConversationEntry> = []

export interface ConversationPaneTimeline {
  readonly detailEntries: ReadonlyArray<ConversationEntry>
  /** Earlier history pages still exist on the server (outline "load earlier"). */
  readonly hasEarlierHistory: boolean
  readonly timelineItems: ReadonlyArray<TimelineItem>
  /** Live stream of the open turn; undefined while idle / not subscribed. */
  readonly live: ConversationLive | undefined
}

export function useConversationPaneTimeline(
  conversationId: number,
  detail: ConversationDetail | undefined,
  staged: boolean,
  isWorking: boolean,
  isCompacting: boolean,
): ConversationPaneTimeline {
  const live = useConversationLive(conversationId, staged)
  const groupedUi = useGroupedUi()
  const detailEntries = detail?.entries ?? EMPTY_ENTRIES
  const settledTimelinePrefix = useMemo(
    () =>
      buildSettledTimelinePrefix(detailEntries, {
        timelineRenderers: groupedUi.timelineRenderers,
        toolViews: groupedUi.toolViews,
      }),
    [detailEntries, groupedUi.timelineRenderers, groupedUi.toolViews],
  )
  const timelineTail = useMemo(
    () =>
      buildLiveTimelineTail(settledTimelinePrefix, {
        ...(live !== undefined ? { live } : {}),
        working: isWorking,
        compacting: isCompacting,
        toolViews: groupedUi.toolViews,
      }),
    [settledTimelinePrefix, live, isWorking, isCompacting, groupedUi.toolViews],
  )
  const timelineItems = useMemo(
    () =>
      timelineTail.length === 0
        ? settledTimelinePrefix.items
        : [...settledTimelinePrefix.items, ...timelineTail],
    [settledTimelinePrefix.items, timelineTail],
  )
  return {
    detailEntries,
    hasEarlierHistory: Boolean(detail?.nextCursor),
    timelineItems,
    live,
  }
}
