/**
 * Reading-anchor IntersectionObserver/ResizeObserver tracking and outline-jump locate/lock hook
 * extracted from use-timeline-scroll.ts.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type * as React from 'react'
import { useStableCallback } from '../lib/use-stable-callback.js'
import { sameOutlineAnchor, type OutlineAnchor } from './outline-model.js'
import {
  OUTLINE_ACTIVE_LINE_PX,
  resolveActiveAnchorIndex,
  resolveOutlineReadingBaseline,
} from './timeline-containment-model.js'
import type { AnchorAlignment } from './timeline-scroll-calibration.js'

/** Same selector as the outline locate effect: H1~H3 inside the turn's own Markdown body (never nested trace/plugin cards), in DOM order (= headingIndex). */
const TURN_HEADING_SELECTOR = '.msg-ai-block > .msg-ai-body h1, .msg-ai-block > .msg-ai-body h2, .msg-ai-block > .msg-ai-body h3'

function escapeAttrSelectorValue(value: string): string {
  return value.replace(/["\\]/g, (ch) => `\\${ch}`)
}

export interface TimelineOutlineScrollRequest {
  entryId: string
  headingIndex?: number
  cardId?: string
  tick: number
}

export interface UseTimelineOutlineTrackingOptions {
  conversationId: number
  scrollRef: React.RefObject<HTMLDivElement | null>
  innerRef: React.RefObject<HTMLDivElement | null>
  anchorSignature: string
  outlineScrollRequest?: TimelineOutlineScrollRequest | null
  outlineOpen: boolean
  initialBottomActiveRef: React.RefObject<{ active: boolean; consumed: boolean }>
  stickToBottomRef: React.RefObject<boolean>
  onActiveOutlineChange?: (anchor: OutlineAnchor | undefined) => void
  armScrollCalibration: (target: HTMLElement, alignment: AnchorAlignment) => void
}

export interface UseTimelineOutlineTrackingResult {
  localHighlightEntryId: string | null
  scheduleActivation: () => void
  releaseOutlineJumpLock: () => void
}

export function useTimelineOutlineTracking({
  conversationId,
  scrollRef,
  innerRef,
  anchorSignature,
  outlineScrollRequest,
  outlineOpen,
  initialBottomActiveRef,
  stickToBottomRef,
  onActiveOutlineChange,
  armScrollCalibration,
}: UseTimelineOutlineTrackingOptions): UseTimelineOutlineTrackingResult {
  const [localHighlightEntryId, setLocalHighlightEntryId] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const prevConversationIdRef = useRef<number | null>(null)
  const lastOutlineTickRef = useRef<number | null>(null)
  const lastActiveAnchorRef = useRef<OutlineAnchor | undefined>(undefined)
  /** Anchor wrappers (`[data-entry-id]`) in document order, refreshed whenever the anchor set changes. */
  const anchorWrappersRef = useRef<HTMLElement[]>([])
  /** IO path: indexes of wrappers currently intersecting the baseline zone (top passed container top + 96px). */
  const passedAnchorsRef = useRef<Set<number>>(new Set())
  /**
   * Outline jump lock: after an explicit outline click the clicked node stays the current one (scroll-derived
   * publications are withheld) until the user takes over the scroll position (wheel / touch / pointer / scroll keys)
   * or another explicit navigation happens.
   */
  const outlineJumpLockRef = useRef(false)
  const activationFrameRef = useRef(0)
  const outlineHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const outlineOpenRef = useRef(outlineOpen)
  outlineOpenRef.current = outlineOpen
  const anchorDirtyWhileClosedRef = useRef(false)
  const anchorTrackingEnabled = onActiveOutlineChange !== undefined
  const notifyActiveOutlineChange = useStableCallback((anchor: OutlineAnchor | undefined): void => {
    onActiveOutlineChange?.(anchor)
  })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (outlineHighlightTimerRef.current !== null) {
        clearTimeout(outlineHighlightTimerRef.current)
        outlineHighlightTimerRef.current = null
      }
      if (activationFrameRef.current !== 0) {
        cancelAnimationFrame(activationFrameRef.current)
        activationFrameRef.current = 0
      }
    }
  }, [])

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
    [scrollRef],
  )

  const publish = useCallback(
    (next: OutlineAnchor | undefined): void => {
      if (sameOutlineAnchor(next, lastActiveAnchorRef.current)) return
      lastActiveAnchorRef.current = next
      notifyActiveOutlineChange(next)
    },
    [notifyActiveOutlineChange],
  )

  const scheduleActivation = useCallback((): void => {
    if (!anchorTrackingEnabled) return
    if (!outlineOpenRef.current) {
      if (!initialBottomActiveRef.current.active) anchorDirtyWhileClosedRef.current = true
      return
    }
    if (activationFrameRef.current !== 0) return
    activationFrameRef.current = requestAnimationFrame(() => {
      activationFrameRef.current = 0
      if (!mountedRef.current || !outlineOpenRef.current || outlineJumpLockRef.current) return
      anchorDirtyWhileClosedRef.current = false
      publish(resolveReadingAnchor(typeof IntersectionObserver === 'undefined'))
    })
  }, [anchorTrackingEnabled, initialBottomActiveRef, publish, resolveReadingAnchor])

  const releaseOutlineJumpLock = useCallback((): void => {
    outlineJumpLockRef.current = false
  }, [])

  // Reset outline state on conversation switch BEFORE outlineScrollRequest effect runs,
  // so initial deep-link or same-render outline jumps survive first mount cleanly.
  useEffect(() => {
    if (prevConversationIdRef.current === conversationId) return
    prevConversationIdRef.current = conversationId
    lastOutlineTickRef.current = null
    lastActiveAnchorRef.current = undefined
    anchorDirtyWhileClosedRef.current = false
    outlineJumpLockRef.current = false
    setLocalHighlightEntryId(null)
    if (outlineHighlightTimerRef.current !== null) {
      clearTimeout(outlineHighlightTimerRef.current)
      outlineHighlightTimerRef.current = null
    }
    if (activationFrameRef.current !== 0) {
      cancelAnimationFrame(activationFrameRef.current)
      activationFrameRef.current = 0
    }
  }, [conversationId])

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
  }, [anchorTrackingEnabled, anchorSignature, innerRef, publish, resolveReadingAnchor, scheduleActivation, scrollRef])

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
      const headings = targetWrapper.querySelectorAll<HTMLElement>(TURN_HEADING_SELECTOR)
      const matchedHeading = headings[outlineScrollRequest.headingIndex]
      if (matchedHeading !== undefined) scrollEl = matchedHeading
    }
    scrollEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
    armScrollCalibration(scrollEl, 'start')
    setLocalHighlightEntryId(outlineScrollRequest.entryId)
    if (anchorTrackingEnabled) {
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
      if (!mountedRef.current) return
      setLocalHighlightEntryId((current) => (current === outlineScrollRequest.entryId ? null : current))
    }, 2400)
  }, [outlineScrollRequest, anchorTrackingEnabled, innerRef, publish, anchorSignature, armScrollCalibration, stickToBottomRef])

  return {
    localHighlightEntryId,
    scheduleActivation,
    releaseOutlineJumpLock,
  }
}
