/**
 * Scroll-follow, keep-alive Activity wake scroll restoration, IntersectionObserver
 * reading-anchor tracking, ResizeObserver width/bottom tracking, outline locate,
 * and SWR scroll-anchor preservation hook for ConversationTimeline.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type * as React from 'react'
import type { ConversationEntry } from '@helmx/protocol/browser'
import { useStableCallback } from '../lib/use-stable-callback.js'
import { resolveActiveOutlineEntryId } from './outline-model.js'
import {
  OUTLINE_ACTIVE_LINE_PX,
  resolveActiveAnchorIndex,
  resolveCharsPerLine,
} from './timeline-containment-model.js'
import { captureTimelineScrollAnchor, restoreTimelineScrollAnchor, type TimelineScrollAnchor } from './timeline-scroll-anchor.js'
import {
  calibrateAnchorAfterSmoothScroll,
  calibrateInitialStickToBottom,
  type AnchorAlignment,
} from './timeline-scroll-calibration.js'

const SCROLL_TO_BOTTOM_THRESHOLD_PX = 240

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
  onActiveEntryChange?: (entryId: string | undefined) => void
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
  onActiveEntryChange,
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
  const lastActiveEntryRef = useRef<string | undefined>(undefined)
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
  const notifyActiveEntryChange = useStableCallback((entryId: string | undefined): void => {
    onActiveEntryChange?.(entryId)
  })
  const anchorTrackingEnabled = onActiveEntryChange !== undefined

  const syncScrollBottomVisibility = useCallback((el: HTMLElement): void => {
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom <= SCROLL_TO_BOTTOM_THRESHOLD_PX) {
      programmaticBottomScrollRef.current = false
    }
    if (distanceFromBottom <= 32) {
      setHasUnreadScrollUpdates(false)
    }
    const visible =
      !initialBottomRef.current.active &&
      !programmaticBottomScrollRef.current &&
      distanceFromBottom > SCROLL_TO_BOTTOM_THRESHOLD_PX
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
    setShowScrollBottom(false)
    setHasUnreadScrollUpdates(false)
    const el = scrollRef.current
    if (el === null) return
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    } else {
      el.scrollTop = el.scrollHeight
    }
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_TO_BOTTOM_THRESHOLD_PX) {
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
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0) stopFollowingBottom()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
        stopFollowingBottom()
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('keydown', onKeyDown, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('keydown', onKeyDown)
    }
  }, [stopFollowingBottom, syncScrollBottomVisibility])

  useEffect(() => {
    if (!anchorTrackingEnabled) return
    const scroller = scrollRef.current
    const inner = innerRef.current
    if (scroller === null || inner === null) return

    const anchors = Array.from(inner.querySelectorAll<HTMLElement>('[data-entry-id]')).filter(
      (el) => (el.dataset.entryId ?? '') !== '',
    )
    const entryIds = anchors.map((el) => el.dataset.entryId!)
    const publish = (nextActive: string | undefined): void => {
      if (nextActive === lastActiveEntryRef.current) return
      lastActiveEntryRef.current = nextActive
      notifyActiveEntryChange(nextActive)
    }

    if (typeof IntersectionObserver === 'undefined') {
      let frame = 0
      const measure = (): void => {
        frame = 0
        const containerTop = scroller.getBoundingClientRect().top
        const offsets: Array<{ entryId: string; top: number }> = []
        for (const node of anchors) {
          offsets.push({ entryId: node.dataset.entryId!, top: node.getBoundingClientRect().top - containerTop })
        }
        publish(resolveActiveOutlineEntryId(offsets, OUTLINE_ACTIVE_LINE_PX))
      }
      const schedule = (): void => {
        if (frame === 0) frame = requestAnimationFrame(measure)
      }
      schedule()
      scroller.addEventListener('scroll', schedule, { passive: true })
      return () => {
        scroller.removeEventListener('scroll', schedule)
        if (frame !== 0) cancelAnimationFrame(frame)
      }
    }

    const intersecting = new Set<number>()
    const indexByEl = new Map<HTMLElement, number>()
    anchors.forEach((el, index) => indexByEl.set(el, index))
    const onEntries = (entries: IntersectionObserverEntry[]): void => {
      for (const entry of entries) {
        const idx = indexByEl.get(entry.target as HTMLElement)
        if (idx === undefined) continue
        if (entry.isIntersecting) intersecting.add(idx)
        else intersecting.delete(idx)
      }
      const next = resolveActiveAnchorIndex(intersecting, entryIds.length)
      publish(next === -1 ? undefined : entryIds[next])
    }
    let io: IntersectionObserver | null = null
    const buildObserver = (): void => {
      io?.disconnect()
      intersecting.clear()
      const bottomInset = Math.max(0, scroller.clientHeight - OUTLINE_ACTIVE_LINE_PX)
      io = new IntersectionObserver(onEntries, { root: scroller, rootMargin: `0px 0px -${bottomInset}px 0px` })
      for (const el of anchors) io.observe(el)
    }
    buildObserver()
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => buildObserver())
      ro.observe(scroller)
    }
    return () => {
      io?.disconnect()
      ro?.disconnect()
    }
  }, [anchorTrackingEnabled, anchorSignature, notifyActiveEntryChange])

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
      const headings = targetWrapper.querySelectorAll<HTMLElement>('.msg-ai-body h1, .msg-ai-body h2, .msg-ai-body h3')
      const matchedHeading = headings[outlineScrollRequest.headingIndex]
      if (matchedHeading !== undefined) scrollEl = matchedHeading
    }
    scrollEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
    armScrollCalibration(scrollEl, 'start')
    setLocalHighlightEntryId(outlineScrollRequest.entryId)
    if (anchorTrackingEnabled) {
      lastActiveEntryRef.current = outlineScrollRequest.entryId
      notifyActiveEntryChange(outlineScrollRequest.entryId)
    }
    if (outlineHighlightTimerRef.current !== null) clearTimeout(outlineHighlightTimerRef.current)
    outlineHighlightTimerRef.current = setTimeout(() => {
      outlineHighlightTimerRef.current = null
      setLocalHighlightEntryId((current) => (current === outlineScrollRequest.entryId ? null : current))
    }, 2400)
  }, [outlineScrollRequest, anchorTrackingEnabled, notifyActiveEntryChange, anchorSignature, armScrollCalibration])

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

  // SWR silent-replace protection: capture visible anchor before commit when scrolled up.
  if (
    prevConvIdRef.current === conversationId &&
    prevDetailEntriesRef.current !== detailEntries &&
    detailsReady &&
    !loadingOlder &&
    !stickToBottomRef.current &&
    scrollRef.current !== null &&
    typeof document !== 'undefined' &&
    typeof document.elementFromPoint === 'function'
  ) {
    const anchor = captureTimelineScrollAnchor(scrollRef.current)
    swrAnchorRef.current = anchor !== undefined ? { entries: detailEntries, anchor } : null
  } else if (prevConvIdRef.current !== conversationId || stickToBottomRef.current) {
    swrAnchorRef.current = null
  }

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
  }, [contentFingerprint, detailEntries, lastHumanKey, detailsReady, conversationId, beginInitialBottomCalibration, syncScrollBottomVisibility])

  const loadEarlierEntries = useCallback((): void => {
    stopFollowingBottom()
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
  }
}
