/**
 * Scroll-follow, keep-alive Activity wake scroll restoration, IntersectionObserver
 * reading-anchor tracking (outline activation: turn wrapper + in-turn H1~H3 heading granularity),
 * ResizeObserver width/bottom tracking, outline locate (with a jump lock so the clicked node stays the
 * current one until the user scrolls), and SWR scroll-anchor preservation hook for ConversationTimeline.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type * as React from 'react'
import type { ConversationEntry } from '@helmx/protocol/browser'
import { useStableCallback } from '../lib/use-stable-callback.js'
import { sameOutlineAnchor, type OutlineAnchor } from './outline-model.js'
import {
  OUTLINE_ACTIVE_LINE_PX,
  OUTLINE_BOTTOM_ZONE_PX,
  resolveActiveAnchorIndex,
  resolveCharsPerLine,
  resolveOutlineReadingBaseline,
} from './timeline-containment-model.js'
import { captureTimelineScrollAnchor, restoreTimelineScrollAnchor, type TimelineScrollAnchor } from './timeline-scroll-anchor.js'
import {
  calibrateAnchorAfterSmoothScroll,
  calibrateInitialStickToBottom,
  type AnchorAlignment,
} from './timeline-scroll-calibration.js'

/** Same selector as the outline locate effect: H1~H3 inside an assistant turn body, in DOM order (= headingIndex). */
const TURN_HEADING_SELECTOR = '.msg-ai-block .msg-ai-body h1, .msg-ai-block .msg-ai-body h2, .msg-ai-block .msg-ai-body h3'
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

function escapeAttrSelectorValue(value: string): string {
  return value.replace(/["\\]/g, (ch) => `\\${ch}`)
}

export interface TimelineOutlineScrollRequest {
  entryId: string
  headingIndex?: number
  cardId?: string
  tick: number
}

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
  const [localHighlightEntryId, setLocalHighlightEntryId] = useState<string | null>(null)
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const [hasUnreadScrollUpdates, setHasUnreadScrollUpdates] = useState(false)
  const [charsPerLine, setCharsPerLine] = useState<number>(() =>
    resolveCharsPerLine(typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : undefined),
  )

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const innerRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const programmaticBottomScrollRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  const prevFingerprintRef = useRef<{ conversationId: number; value: string } | null>(null)
  const lastHumanRef = useRef<{ conversationId: number; key: string | undefined } | null>(null)
  const lastOutlineTickRef = useRef<number | null>(null)
  const lastActiveAnchorRef = useRef<OutlineAnchor | undefined>(undefined)
  /** Anchor wrappers (`[data-entry-id]`) in document order, refreshed whenever the anchor set changes. */
  const anchorWrappersRef = useRef<HTMLElement[]>([])
  /** IO path: indexes of wrappers currently intersecting the baseline zone (top passed container top + 96px). */
  const passedAnchorsRef = useRef<Set<number>>(new Set())
  /**
   * Outline jump lock: after an explicit outline click the clicked node stays the current one (scroll-derived
   * publications are withheld) until the user takes over the scroll position (wheel / touch / pointer / scroll keys)
   * or another explicit navigation happens. Keeps the smooth-scroll animation and the settled position from
   * flashing a different node (e.g. a near-bottom target whose followers are also on screen).
   */
  const outlineJumpLockRef = useRef(false)
  const activationFrameRef = useRef(0)
  const outlineHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
  const notifyActiveOutlineChange = useStableCallback((anchor: OutlineAnchor | undefined): void => {
    onActiveOutlineChange?.(anchor)
  })
  const anchorTrackingEnabled = onActiveOutlineChange !== undefined
  const outlineOpenRef = useRef(outlineOpen)
  outlineOpenRef.current = outlineOpen
  const anchorDirtyWhileClosedRef = useRef(false)

  /**
   * Resolve the reading anchor from the current scroll position (both IO and no-IO paths share it):
   * 1. active wrapper = the last wrapper whose top passed the reading baseline. Far from the bottom the IO path
   *    answers from the intersecting set (zero rect reads); when the baseline is widened (near the bottom) or IO is
   *    unavailable, walk up from the last wrapper while its top is below the baseline — those rows are the ones on
   *    screen below the baseline, so the walk is bounded by the viewport, never a whole-list scan;
   * 2. inside the active wrapper, the last H1~H3 whose top passed the baseline pinpoints the heading section
   *    (bounded by the turn's own heading count); with none passed the anchor stays at the wrapper (turn node).
   */
  const resolveReadingAnchor = useCallback(
    (forceMeasure: boolean): OutlineAnchor | undefined => {
      const scroller = scrollRef.current
      const wrappers = anchorWrappersRef.current
      if (scroller === null || wrappers.length === 0) return undefined
      const baseline = resolveOutlineReadingBaseline(
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        scroller.clientHeight,
      )
      let activeIndex: number
      let containerTop = 0
      const measureRows = forceMeasure || baseline > OUTLINE_ACTIVE_LINE_PX
      if (measureRows) {
        containerTop = scroller.getBoundingClientRect().top
        let index = wrappers.length - 1
        while (index >= 0 && wrappers[index]!.getBoundingClientRect().top - containerTop > baseline) index -= 1
        activeIndex = index >= 0 ? index : 0
      } else {
        activeIndex = resolveActiveAnchorIndex(passedAnchorsRef.current, wrappers.length)
      }
      if (activeIndex < 0) return undefined
      const wrapper = wrappers[activeIndex]!
      const entryId = wrapper.dataset.entryId
      if (entryId === undefined || entryId === '') return undefined
      const headings = wrapper.querySelectorAll<HTMLElement>(TURN_HEADING_SELECTOR)
      if (headings.length === 0) return { entryId }
      if (!measureRows) containerTop = scroller.getBoundingClientRect().top
      let headingIndex = -1
      for (let i = 0; i < headings.length; i++) {
        if (headings[i]!.getBoundingClientRect().top - containerTop <= baseline) headingIndex = i
      }
      return headingIndex >= 0 ? { entryId, headingIndex } : { entryId }
    },
    [],
  )

  /** Publish a scroll-derived anchor; an active outline jump lock withholds it (the clicked node stays current). */
  const publish = useCallback(
    (next: OutlineAnchor | undefined): void => {
      if (sameOutlineAnchor(next, lastActiveAnchorRef.current)) return
      lastActiveAnchorRef.current = next
      notifyActiveOutlineChange(next)
    },
    [notifyActiveOutlineChange],
  )

  /** rAF-throttled scroll-derived activation (scroll, resize and content changes all funnel through here). */
  const scheduleActivation = useCallback((): void => {
    if (!anchorTrackingEnabled) return
    if (!outlineOpenRef.current) {
      if (!initialBottomRef.current.active) anchorDirtyWhileClosedRef.current = true
      return
    }
    if (activationFrameRef.current !== 0) return
    activationFrameRef.current = requestAnimationFrame(() => {
      activationFrameRef.current = 0
      if (!outlineOpenRef.current || outlineJumpLockRef.current) return
      anchorDirtyWhileClosedRef.current = false
      publish(resolveReadingAnchor(typeof IntersectionObserver === 'undefined'))
    })
  }, [anchorTrackingEnabled, publish, resolveReadingAnchor])

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

  const scrollToBottomAndFollow = useCallback((): void => {
    activeCalibrationRef.current?.cancel()
    activeCalibrationRef.current = null
    initialBottomRef.current.active = false
    initialBottomRef.current.consumed = true
    stickToBottomRef.current = true
    programmaticBottomScrollRef.current = true
    outlineJumpLockRef.current = false
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
  }, [])

  const armScrollCalibration = useCallback(
    (target: HTMLElement, alignment: AnchorAlignment): void => {
      const scroller = target.closest<HTMLElement>('.timeline-scroll')
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

  const highlightScrollRef = useCallback(
    (node: HTMLDivElement | null): void => {
      if (node === null || highlightedEntry?.conversationId !== conversationId) return
      if (node.dataset.entryId !== highlightedEntry.entryId) return
      node.scrollIntoView({ behavior: 'smooth', block: 'center' })
      armScrollCalibration(node, 'center')
    },
    [conversationId, highlightedEntry?.conversationId, highlightedEntry?.entryId, armScrollCalibration],
  )

  useEffect(() => {
    if (conversationInitRef.current !== conversationId) {
      conversationInitRef.current = conversationId
      stickToBottomRef.current = true
      programmaticBottomScrollRef.current = false
      lastScrollTopRef.current = 0
      prevFingerprintRef.current = null
      lastOutlineTickRef.current = null
      lastActiveAnchorRef.current = undefined
      anchorDirtyWhileClosedRef.current = false
      outlineJumpLockRef.current = false
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
      if (outlineHighlightTimerRef.current !== null) {
        clearTimeout(outlineHighlightTimerRef.current)
        outlineHighlightTimerRef.current = null
      }
      if (activationFrameRef.current !== 0) {
        cancelAnimationFrame(activationFrameRef.current)
        activationFrameRef.current = 0
      }
    }
  }, [conversationId, notifySwitch])

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
      outlineJumpLockRef.current = false
      if (event.deltaY < 0) stopFollowingBottom()
    }
    const onUserPointer = (): void => {
      outlineJumpLockRef.current = false
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
        stopFollowingBottom()
      }
      if (JUMP_LOCK_RELEASE_KEYS.has(event.key)) outlineJumpLockRef.current = false
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
  }, [stopFollowingBottom, syncScrollBottomVisibility, scheduleActivation])

  // Anchor tracking: refresh the wrapper list on every anchor-set change, keep the IO intersecting set
  // (baseline zone) up to date, and re-derive the reading anchor on scroll / resize / content changes.
  useEffect(() => {
    if (!anchorTrackingEnabled) return
    const scroller = scrollRef.current
    const inner = innerRef.current
    if (scroller === null || inner === null) return

    anchorWrappersRef.current = Array.from(inner.querySelectorAll<HTMLElement>('[data-entry-id]')).filter(
      (el) => (el.dataset.entryId ?? '') !== '',
    )
    const anchors = anchorWrappersRef.current

    if (typeof IntersectionObserver === 'undefined') {
      // No IO: the shared resolver measures the on-screen rows itself (walk-up from the last wrapper).
      scheduleActivation()
      return () => {
        anchorWrappersRef.current = []
      }
    }

    const passed = passedAnchorsRef.current
    const indexByEl = new Map<HTMLElement, number>()
    anchors.forEach((el, index) => indexByEl.set(el, index))
    const onEntries = (entries: IntersectionObserverEntry[]): void => {
      for (const entry of entries) {
        const idx = indexByEl.get(entry.target as HTMLElement)
        if (idx === undefined) continue
        if (entry.isIntersecting) passed.add(idx)
        else passed.delete(idx)
      }
      if (outlineJumpLockRef.current) return
      anchorDirtyWhileClosedRef.current = false
      publish(resolveReadingAnchor(false))
    }
    let io: IntersectionObserver | null = null
    const buildObserver = (): void => {
      io?.disconnect()
      passed.clear()
      const bottomInset = Math.max(0, scroller.clientHeight - OUTLINE_ACTIVE_LINE_PX)
      io = new IntersectionObserver(onEntries, { root: scroller, rootMargin: `0px 0px -${bottomInset}px 0px` })
      for (const el of anchors) io.observe(el)
    }
    buildObserver()
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        buildObserver()
        scheduleActivation()
      })
      ro.observe(scroller)
    }
    return () => {
      io?.disconnect()
      ro?.disconnect()
      passed.clear()
      anchorWrappersRef.current = []
    }
  }, [anchorTrackingEnabled, anchorSignature, publish, resolveReadingAnchor, scheduleActivation])

  // Compute reading anchor synchronously before paint when the outline popover opens after closed-state scroll/stream changes.
  useLayoutEffect(() => {
    if (!anchorTrackingEnabled || !outlineOpen || outlineJumpLockRef.current) return
    if (!anchorDirtyWhileClosedRef.current && lastActiveAnchorRef.current !== undefined) return
    anchorDirtyWhileClosedRef.current = false
    publish(resolveReadingAnchor(typeof IntersectionObserver === 'undefined'))
  }, [anchorTrackingEnabled, outlineOpen, anchorSignature, publish, resolveReadingAnchor])

  useEffect(() => {
    if (!outlineScrollRequest || outlineScrollRequest.tick === lastOutlineTickRef.current) return
    const container = innerRef.current
    if (container === null) return

    let targetWrapper: HTMLElement | null = null
    for (const el of container.querySelectorAll<HTMLElement>('[data-entry-id]')) {
      if (el.dataset.entryId === outlineScrollRequest.entryId) {
        targetWrapper = el
        break
      }
    }
    if (targetWrapper === null) return
    lastOutlineTickRef.current = outlineScrollRequest.tick
    stickToBottomRef.current = false

    let scrollEl: HTMLElement = targetWrapper
    if (outlineScrollRequest.cardId !== undefined) {
      const cardEl = targetWrapper.querySelector<HTMLElement>(
        `[data-outline-card-id="${escapeAttrSelectorValue(outlineScrollRequest.cardId)}"]`,
      )
      if (cardEl !== null) scrollEl = cardEl
    } else if (outlineScrollRequest.headingIndex !== undefined) {
      // Same selector as the reading-anchor resolver: headingIndex indexes this DOM-ordered list.
      const headings = targetWrapper.querySelectorAll<HTMLElement>(TURN_HEADING_SELECTOR)
      const matchedHeading = headings[outlineScrollRequest.headingIndex]
      if (matchedHeading !== undefined) scrollEl = matchedHeading
    }
    scrollEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
    armScrollCalibration(scrollEl, 'start')
    setLocalHighlightEntryId(outlineScrollRequest.entryId)
    if (anchorTrackingEnabled) {
      // The clicked node is the current one from now on; the lock withholds scroll-derived publication
      // during the smooth animation and at the settled position until the user takes over the scroll.
      outlineJumpLockRef.current = true
      publish({
        entryId: outlineScrollRequest.entryId,
        ...(outlineScrollRequest.headingIndex !== undefined ? { headingIndex: outlineScrollRequest.headingIndex } : {}),
        ...(outlineScrollRequest.cardId !== undefined ? { cardId: outlineScrollRequest.cardId } : {}),
      })
    }
    if (outlineHighlightTimerRef.current !== null) clearTimeout(outlineHighlightTimerRef.current)
    outlineHighlightTimerRef.current = setTimeout(() => {
      outlineHighlightTimerRef.current = null
      setLocalHighlightEntryId((current) => (current === outlineScrollRequest.entryId ? null : current))
    }, 2400)
  }, [outlineScrollRequest, anchorTrackingEnabled, publish, anchorSignature, armScrollCalibration])

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
    const { anchor } = pending
    const anchorEntryId = anchor.element.dataset.entryId
    const resolvedAnchor =
      anchor.element.isConnected && scroller.contains(anchor.element)
        ? anchor
        : anchorEntryId !== undefined
          ? (() => {
              const matched = Array.from(scroller.querySelectorAll<HTMLElement>('[data-entry-id]'))
                .find((el) => el.dataset.entryId === anchorEntryId)
              return matched !== undefined ? { element: matched, top: anchor.top } : undefined
            })()
          : undefined
    restoreTimelineScrollAnchor(scroller, resolvedAnchor)
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
      const previous = lastHumanRef.current
      if (previous?.conversationId === conversationId && lastHumanKey !== undefined && lastHumanKey !== previous.key) {
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
    outlineJumpLockRef.current = false
    const scroller = scrollRef.current
    if (scroller === null) return
    const anchor = captureTimelineScrollAnchor(scroller)
    setLoadingOlder(true)
    void fetchEarlierEntries(conversationId).finally(() => {
      setLoadingOlder(false)
      requestAnimationFrame(() => restoreTimelineScrollAnchor(scroller, anchor))
    })
  }, [stopFollowingBottom, fetchEarlierEntries, conversationId])

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
