/**
 * Scroll-follow, keep-alive Activity wake scroll restoration,
 * ResizeObserver width/bottom tracking, and SWR scroll-anchor preservation hook for ConversationTimeline.
 * Outline reading-anchor tracking and jump-lock logic live in use-timeline-outline-tracking.ts.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type * as React from 'react'
import type { ConversationEntry } from '@helmx/protocol/browser'
import { useStableCallback } from '../lib/use-stable-callback.js'
import type { OutlineAnchor } from './outline-model.js'
import { OUTLINE_BOTTOM_ZONE_PX, resolveCharsPerLine } from './timeline-containment-model.js'
import { captureTimelineScrollAnchor, restoreTimelineScrollAnchor, type TimelineScrollAnchor } from './timeline-scroll-anchor.js'
import {
  calibrateAnchorAfterSmoothScroll,
  calibrateInitialStickToBottom,
  type AnchorAlignment,
} from './timeline-scroll-calibration.js'
import { useTimelineOutlineTracking, type TimelineOutlineScrollRequest } from './use-timeline-outline-tracking.js'

export type { TimelineOutlineScrollRequest }

/** Keys that count as the user taking over the scroll position (releases the outline jump lock). */
const JUMP_LOCK_RELEASE_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
])

export interface UseTimelineScrollOptions {
  conversationId: number
  detailEntries: ReadonlyArray<ConversationEntry>
  detailsReady: boolean
  isWorking: boolean
  hasLiveTurn: boolean
  contentFingerprint: string
  lastHumanKey: string | undefined
  anchorSignature: string
  highlightedEntry: { conversationId: number; entryId: string } | null
  outlineScrollRequest?: TimelineOutlineScrollRequest | null
  /** Whether the outline popover is currently open; skips `getBoundingClientRect()` anchor scans while closed. */
  outlineOpen?: boolean
  /**
   * Reading-position outline activation: the last anchor past the reading baseline, refined to the exact H1~H3
   * heading inside the active assistant turn (headingIndex) — or to the clicked card right after an outline jump.
   * `undefined` while the timeline has no anchors.
   */
  onActiveOutlineChange?: (anchor: OutlineAnchor | undefined) => void
  onConversationSwitch: () => void
  fetchEarlierEntries: (conversationId: number) => Promise<void>
}

export interface UseTimelineScrollResult {
  scrollRef: React.RefObject<HTMLDivElement | null>
  innerRef: React.RefObject<HTMLDivElement | null>
  bottomRef: React.RefObject<HTMLDivElement | null>
  charsPerLine: number
  loadingOlder: boolean
  localHighlightEntryId: string | null
  showScrollBottom: boolean
  hasUnreadScrollUpdates: boolean
  highlightScrollRef: (node: HTMLDivElement | null) => void
  scrollToBottomAndFollow: () => void
  loadEarlierEntries: () => void
  captureBeforeEntriesCommit: (nextConversationId: number, nextEntries: ReadonlyArray<ConversationEntry>) => void
}

export function useTimelineScroll({
  conversationId,
  detailEntries,
  detailsReady,
  isWorking,
  hasLiveTurn,
  contentFingerprint,
  lastHumanKey,
  anchorSignature,
  highlightedEntry,
  outlineScrollRequest,
  outlineOpen = true,
  onActiveOutlineChange,
  onConversationSwitch,
  fetchEarlierEntries,
}: UseTimelineScrollOptions): UseTimelineScrollResult {
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const [hasUnreadScrollUpdates, setHasUnreadScrollUpdates] = useState(false)
  const [charsPerLine, setCharsPerLine] = useState<number>(() =>
    resolveCharsPerLine(typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : undefined),
  )

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const innerRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useRef(true)
  const stickToBottomRef = useRef(true)
  const programmaticBottomScrollRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  const prevFingerprintRef = useRef<{ conversationId: number; value: string } | null>(null)
  const lastHumanRef = useRef<{ conversationId: number; key: string | undefined } | null>(null)
  const prevEntrySpanRef = useRef<{ conversationId: number; headId: string | undefined; tailId: string | undefined } | null>(null)
  const loadEarlierRafRef = useRef(0)
  const loadEarlierGenRef = useRef(0)
  const activeCalibrationRef = useRef<{
    conversationId: number
    kind: 'anchor' | 'initial-bottom'
    cancel: () => void
  } | null>(null)
  const prevConvIdRef = useRef(conversationId)
  const prevDetailEntriesRef = useRef(detailEntries)
  const swrAnchorRef = useRef<{ entries: ReadonlyArray<ConversationEntry>; anchor: TimelineScrollAnchor } | null>(null)
  const initialBottomRef = useRef<{ active: boolean; consumed: boolean }>({ active: false, consumed: false })
  const conversationInitRef = useRef<number | null>(null)
  const wakeScrollTopRef = useRef<number | null>(null)

  const notifySwitch = useStableCallback(onConversationSwitch)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (loadEarlierRafRef.current !== 0) {
        cancelAnimationFrame(loadEarlierRafRef.current)
        loadEarlierRafRef.current = 0
      }
    }
  }, [])

  const syncScrollBottomVisibility = useCallback((el: HTMLElement): void => {
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom <= OUTLINE_BOTTOM_ZONE_PX) {
      programmaticBottomScrollRef.current = false
    }
    if (distanceFromBottom <= 32) {
      setHasUnreadScrollUpdates(false)
    }
    const visible =
      !initialBottomRef.current.active &&
      !programmaticBottomScrollRef.current &&
      distanceFromBottom > OUTLINE_BOTTOM_ZONE_PX
    setShowScrollBottom((prev) => (prev === visible ? prev : visible))
  }, [])

  const stopFollowingBottom = useCallback((): void => {
    stickToBottomRef.current = false
    programmaticBottomScrollRef.current = false
    initialBottomRef.current.consumed = true
    if (activeCalibrationRef.current?.kind === 'initial-bottom') activeCalibrationRef.current.cancel()
  }, [])

  const armScrollCalibration = useCallback(
    (target: HTMLElement, alignment: AnchorAlignment): void => {
      const scroller = scrollRef.current ?? target.closest<HTMLElement>('.timeline-scroll')
      if (scroller === null) return
      stopFollowingBottom()
      activeCalibrationRef.current?.cancel()
      activeCalibrationRef.current = {
        conversationId,
        kind: 'anchor',
        cancel: calibrateAnchorAfterSmoothScroll({ scroller, target, alignment }),
      }
    },
    [conversationId, stopFollowingBottom],
  )

  // Reset conversation-level scroll state BEFORE outline tracking / locate effects run
  // so initial deep-link or same-render outline jumps are never clobbered by conversation init.
  useEffect(() => {
    if (conversationInitRef.current !== conversationId) {
      conversationInitRef.current = conversationId
      loadEarlierGenRef.current += 1
      if (loadEarlierRafRef.current !== 0) {
        cancelAnimationFrame(loadEarlierRafRef.current)
        loadEarlierRafRef.current = 0
      }
      setLoadingOlder(false)
      stickToBottomRef.current = true
      programmaticBottomScrollRef.current = false
      lastScrollTopRef.current = 0
      prevFingerprintRef.current = null
      initialBottomRef.current.active = false
      initialBottomRef.current.consumed = false
      notifySwitch()
      setShowScrollBottom(false)
      setHasUnreadScrollUpdates(false)
    }
    const ownedConversationId = conversationId
    return () => {
      const active = activeCalibrationRef.current
      if (active !== null && active.conversationId === ownedConversationId) {
        active.cancel()
        activeCalibrationRef.current = null
      }
      if (loadEarlierRafRef.current !== 0) {
        cancelAnimationFrame(loadEarlierRafRef.current)
        loadEarlierRafRef.current = 0
      }
    }
  }, [conversationId, notifySwitch])

  const {
    localHighlightEntryId,
    scheduleActivation,
    releaseOutlineJumpLock,
  } = useTimelineOutlineTracking({
    conversationId,
    scrollRef,
    innerRef,
    anchorSignature,
    outlineScrollRequest,
    outlineOpen,
    initialBottomActiveRef: initialBottomRef,
    stickToBottomRef,
    onActiveOutlineChange,
    armScrollCalibration,
  })

  const scrollToBottomAndFollow = useCallback((): void => {
    activeCalibrationRef.current?.cancel()
    activeCalibrationRef.current = null
    initialBottomRef.current.active = false
    initialBottomRef.current.consumed = true
    stickToBottomRef.current = true
    programmaticBottomScrollRef.current = true
    releaseOutlineJumpLock()
    setShowScrollBottom(false)
    setHasUnreadScrollUpdates(false)
    const el = scrollRef.current
    if (el === null) return
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    } else {
      el.scrollTop = el.scrollHeight
    }
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= OUTLINE_BOTTOM_ZONE_PX) {
      programmaticBottomScrollRef.current = false
    }
    lastScrollTopRef.current = el.scrollTop
  }, [releaseOutlineJumpLock])

  const highlightScrollRef = useCallback(
    (node: HTMLDivElement | null): void => {
      if (node === null || highlightedEntry?.conversationId !== conversationId) return
      if (node.dataset.entryId !== highlightedEntry.entryId) return
      node.scrollIntoView({ behavior: 'smooth', block: 'center' })
      armScrollCalibration(node, 'center')
    },
    [conversationId, highlightedEntry?.conversationId, highlightedEntry?.entryId, armScrollCalibration],
  )

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    if (wakeScrollTopRef.current !== null) {
      el.scrollTop = wakeScrollTopRef.current
      lastScrollTopRef.current = el.scrollTop
      syncScrollBottomVisibility(el)
    }
    return () => {
      wakeScrollTopRef.current = el.scrollTop || lastScrollTopRef.current || wakeScrollTopRef.current || 0
    }
  }, [syncScrollBottomVisibility])

  const beginInitialBottomCalibration = useCallback((): void => {
    const state = initialBottomRef.current
    if (state.consumed || state.active) return
    if (!stickToBottomRef.current) return
    const scroller = scrollRef.current
    if (scroller === null) return
    activeCalibrationRef.current?.cancel()
    state.active = true
    const cancel = calibrateInitialStickToBottom({
      scroller,
      onEnd: (reason) => {
        state.active = false
        if (reason !== 'cancelled') state.consumed = true
        if (reason === 'user-input') stickToBottomRef.current = false
        const active = activeCalibrationRef.current
        if (active !== null && active.cancel === cancel) activeCalibrationRef.current = null
      },
    })
    activeCalibrationRef.current = { conversationId, kind: 'initial-bottom', cancel }
  }, [conversationId])

  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const onScroll = (): void => {
      const top = el.scrollTop
      wakeScrollTopRef.current = top
      // Every scroll frame (rAF-throttled) re-derives the reading anchor; the initial bottom-stick
      // window keeps its synchronous bottom-stick bookkeeping and simply skips the visibility sync.
      scheduleActivation()
      if (initialBottomRef.current.active) {
        lastScrollTopRef.current = top
        setShowScrollBottom(false)
        return
      }
      const distanceFromBottom = el.scrollHeight - top - el.clientHeight
      if (top < lastScrollTopRef.current) {
        if (distanceFromBottom > 1) {
          stickToBottomRef.current = false
          programmaticBottomScrollRef.current = false
        }
      } else if (distanceFromBottom <= 32 && (top > lastScrollTopRef.current || distanceFromBottom <= 8)) {
        stickToBottomRef.current = true
      }
      lastScrollTopRef.current = top
      syncScrollBottomVisibility(el)
    }
    // Wheel / pointer / touch / scroll keys are user takeovers of the scroll position: the outline jump lock
    // is released so scroll-derived activation resumes (an upward wheel additionally drops bottom-follow).
    const onWheel = (event: WheelEvent): void => {
      releaseOutlineJumpLock()
      if (event.deltaY < 0) stopFollowingBottom()
    }
    const onUserPointer = (): void => {
      releaseOutlineJumpLock()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
        stopFollowingBottom()
      }
      if (JUMP_LOCK_RELEASE_KEYS.has(event.key)) releaseOutlineJumpLock()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('pointerdown', onUserPointer, { passive: true })
    el.addEventListener('touchstart', onUserPointer, { passive: true })
    el.addEventListener('keydown', onKeyDown, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onUserPointer)
      el.removeEventListener('touchstart', onUserPointer)
      el.removeEventListener('keydown', onKeyDown)
    }
  }, [stopFollowingBottom, syncScrollBottomVisibility, scheduleActivation, releaseOutlineJumpLock])

  useEffect(() => {
    const inner = innerRef.current
    const scroller = scrollRef.current
    if (inner === null || scroller === null) return
    const syncContainerWidth = (): void => {
      const width = scroller.clientWidth
      if (width > 0) {
        const next = resolveCharsPerLine(width)
        setCharsPerLine((prev) => (prev === next ? prev : next))
      }
    }
    syncContainerWidth()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      syncContainerWidth()
      const el = scrollRef.current
      if (el === null) return
      if (stickToBottomRef.current && (isWorking || hasLiveTurn)) {
        el.scrollTop = el.scrollHeight
        lastScrollTopRef.current = el.scrollTop
      }
      syncScrollBottomVisibility(el)
    })
    ro.observe(inner)
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [isWorking, hasLiveTurn, syncScrollBottomVisibility])

  useEffect(() => {
    if (highlightedEntry?.conversationId === conversationId) stopFollowingBottom()
  }, [highlightedEntry, conversationId, stopFollowingBottom])

  // Pre-commit SWR silent-replace protection (invoked from `getSnapshotBeforeUpdate`, never during render):
  // captures the visible anchor right before DOM mutations commit when scrolled up.
  const captureBeforeEntriesCommit = useStableCallback(
    (nextConversationId: number, nextEntries: ReadonlyArray<ConversationEntry>): void => {
      if (
        prevConvIdRef.current === nextConversationId &&
        prevDetailEntriesRef.current !== nextEntries &&
        detailsReady &&
        !loadingOlder &&
        !stickToBottomRef.current &&
        scrollRef.current !== null &&
        typeof document !== 'undefined' &&
        typeof document.elementFromPoint === 'function'
      ) {
        const anchor = captureTimelineScrollAnchor(scrollRef.current)
        swrAnchorRef.current = anchor !== undefined ? { entries: nextEntries, anchor } : null
      } else if (prevConvIdRef.current !== nextConversationId || stickToBottomRef.current) {
        swrAnchorRef.current = null
      }
    },
  )

  useLayoutEffect(() => {
    prevConvIdRef.current = conversationId
    prevDetailEntriesRef.current = detailEntries
    const pending = swrAnchorRef.current
    if (pending === null || pending.entries !== detailEntries) return
    swrAnchorRef.current = null
    if (stickToBottomRef.current) return
    const scroller = scrollRef.current
    if (scroller === null) return
    restoreTimelineScrollAnchor(scroller, pending.anchor)
    lastScrollTopRef.current = scroller.scrollTop
    syncScrollBottomVisibility(scroller)
  }, [conversationId, detailEntries, syncScrollBottomVisibility])

  useEffect(() => {
    if (detailsReady) {
      const previousFingerprint = prevFingerprintRef.current
      if (
        previousFingerprint !== null &&
        previousFingerprint.conversationId === conversationId &&
        previousFingerprint.value !== contentFingerprint &&
        !stickToBottomRef.current
      ) {
        setHasUnreadScrollUpdates(true)
      }
      prevFingerprintRef.current = { conversationId, value: contentFingerprint }
      const prevSpan = prevEntrySpanRef.current
      const newHeadId = detailEntries[0]?.id
      const newTailId = detailEntries.at(-1)?.id
      const prependedOnly =
        prevSpan !== null &&
        prevSpan.conversationId === conversationId &&
        prevSpan.headId !== undefined &&
        newHeadId !== undefined &&
        newHeadId !== prevSpan.headId &&
        newTailId === prevSpan.tailId &&
        detailEntries.some((entry) => entry.id === prevSpan.headId)
      prevEntrySpanRef.current = { conversationId, headId: newHeadId, tailId: newTailId }
      const previous = lastHumanRef.current
      if (
        previous?.conversationId === conversationId &&
        lastHumanKey !== undefined &&
        lastHumanKey !== previous.key &&
        !(previous.key === undefined && prependedOnly)
      ) {
        stickToBottomRef.current = true
        programmaticBottomScrollRef.current = false
        setHasUnreadScrollUpdates(false)
      }
      lastHumanRef.current = { conversationId, key: lastHumanKey }
    }
    const el = scrollRef.current
    if (el !== null && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
      lastScrollTopRef.current = el.scrollTop
    }
    if (el !== null) syncScrollBottomVisibility(el)
    if (detailsReady) beginInitialBottomCalibration()
    // Content changes (streamed headings, settled turns, SWR replacement) move rows without a scroll event:
    // re-derive the reading anchor once the new layout is committed.
    scheduleActivation()
  }, [contentFingerprint, detailEntries, lastHumanKey, detailsReady, conversationId, beginInitialBottomCalibration, syncScrollBottomVisibility, scheduleActivation])

  const loadEarlierEntries = useCallback((): void => {
    stopFollowingBottom()
    releaseOutlineJumpLock()
    const scroller = scrollRef.current
    if (scroller === null) return
    const targetConversationId = conversationId
    const gen = ++loadEarlierGenRef.current
    const anchor = captureTimelineScrollAnchor(scroller)
    setLoadingOlder(true)
    void fetchEarlierEntries(targetConversationId).finally(() => {
      if (!mountedRef.current || conversationInitRef.current !== targetConversationId || gen !== loadEarlierGenRef.current) return
      setLoadingOlder(false)
      if (loadEarlierRafRef.current !== 0) cancelAnimationFrame(loadEarlierRafRef.current)
      loadEarlierRafRef.current = requestAnimationFrame(() => {
        loadEarlierRafRef.current = 0
        if (!mountedRef.current || conversationInitRef.current !== targetConversationId || gen !== loadEarlierGenRef.current) return
        restoreTimelineScrollAnchor(scroller, anchor)
      })
    })
  }, [stopFollowingBottom, releaseOutlineJumpLock, fetchEarlierEntries, conversationId])

  return {
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
  }
}
