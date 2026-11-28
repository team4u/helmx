import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseListKeyboardNavKeyEvent {
  key: string
  keyCode?: number
  isComposing?: boolean
  nativeEvent?: { isComposing?: boolean }
  preventDefault(): void
}

export interface UseListKeyboardNavOptions {
  /** Total item count in the list. */
  count: number
  /** Starting/reset index when entering or disabling navigation (default -1). */
  initialIndex?: number
  /** Whether ArrowDown/ArrowUp wrap at list boundaries (default true). */
  loop?: boolean
  /** Controlled highlighted index. */
  activeIndex?: number
  /** Callback fired when highlighted index changes. */
  onActiveIndexChange?: (index: number) => void
  /** Callback fired on Enter when an item in [0, count) is highlighted. */
  onSelect?: (index: number) => void
  /** Whether keyboard navigation is currently active (default true). */
  enabled?: boolean
}

export interface UseListKeyboardNavResult {
  activeIndex: number
  setActiveIndex: (index: number) => void
  onKeyDown: (event: UseListKeyboardNavKeyEvent) => void
  getItemRef: (index: number) => (node: HTMLElement | null) => void
}

function clampNavIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0 || index < 0) return -1
  const truncated = Math.trunc(index)
  return truncated >= count ? count - 1 : truncated
}

/**
 * Shared keyboard highlight navigation hook for interactive popover/command lists.
 * Handles ArrowDown/ArrowUp (with optional looping), Home/End, Enter selection,
 * IME composition guards, boundary clamping, disabled reset, and scrollIntoView.
 */
export function useListKeyboardNav(options: UseListKeyboardNavOptions): UseListKeyboardNavResult {
  const {
    count,
    initialIndex = -1,
    loop = true,
    activeIndex: controlledActiveIndex,
    onActiveIndexChange,
    onSelect,
    enabled = true,
  } = options

  const isControlled = controlledActiveIndex !== undefined
  const resolvedInitial = clampNavIndex(initialIndex, count)
  const [internalIndex, setInternalIndex] = useState<number>(() => resolvedInitial)

  const effectiveActiveIndex = enabled
    ? clampNavIndex(isControlled ? controlledActiveIndex : internalIndex, count)
    : resolvedInitial

  const itemRefs = useRef<Array<HTMLElement | null>>([])
  const refCallbacks = useRef<Map<number, (node: HTMLElement | null) => void>>(new Map())

  const onActiveIndexChangeRef = useRef(onActiveIndexChange)
  onActiveIndexChangeRef.current = onActiveIndexChange
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  const prevEnabledRef = useRef(enabled)
  const prevCountRef = useRef(count)

  const stateRef = useRef({
    enabled,
    count,
    loop,
    isControlled,
    activeIndex: effectiveActiveIndex,
  })
  stateRef.current = {
    enabled,
    count,
    loop,
    isControlled,
    activeIndex: effectiveActiveIndex,
  }

  useEffect(() => {
    const prevEnabled = prevEnabledRef.current
    const prevCount = prevCountRef.current
    prevEnabledRef.current = enabled
    prevCountRef.current = count

    if (!isControlled) {
      const target = enabled ? clampNavIndex(internalIndex, count) : resolvedInitial
      if (internalIndex !== target) {
        setInternalIndex(target)
      }
      return
    }

    const clampedControlled = clampNavIndex(controlledActiveIndex, count)
    if (!enabled) {
      if ((prevEnabled || prevCount !== count) && controlledActiveIndex !== resolvedInitial) {
        onActiveIndexChangeRef.current?.(resolvedInitial)
      }
      return
    }
    if (controlledActiveIndex !== clampedControlled) {
      onActiveIndexChangeRef.current?.(clampedControlled)
    }
  }, [enabled, count, resolvedInitial, isControlled, internalIndex, controlledActiveIndex])

  useEffect(() => {
    if (!enabled || effectiveActiveIndex < 0) return
    itemRefs.current[effectiveActiveIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [enabled, effectiveActiveIndex])

  const setActiveIndex = useCallback((nextIndex: number) => {
    const { count: currentCount, isControlled: controlled, activeIndex: currentActive } = stateRef.current
    const clamped = clampNavIndex(nextIndex, currentCount)
    if (!controlled) {
      setInternalIndex(clamped)
    }
    if (clamped !== currentActive) {
      onActiveIndexChangeRef.current?.(clamped)
    }
  }, [])

  const onKeyDown = useCallback((event: UseListKeyboardNavKeyEvent) => {
    if (event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) {
      return
    }
    const { enabled: isEnabled, count: currentCount, loop: shouldLoop, activeIndex: current } = stateRef.current
    if (!isEnabled || currentCount <= 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      const next = current < 0
        ? 0
        : current + 1 < currentCount
          ? current + 1
          : shouldLoop
            ? 0
            : currentCount - 1
      setActiveIndex(next)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      const next = current < 0
        ? currentCount - 1
        : current - 1 >= 0
          ? current - 1
          : shouldLoop
            ? currentCount - 1
            : 0
      setActiveIndex(next)
      return
    }

    if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
      return
    }

    if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(currentCount - 1)
      return
    }

    if (event.key === 'Enter' && onSelectRef.current && current >= 0 && current < currentCount) {
      event.preventDefault()
      onSelectRef.current(current)
    }
  }, [setActiveIndex])

  const getItemRef = useCallback((index: number) => {
    const existing = refCallbacks.current.get(index)
    if (existing) return existing
    const callback = (node: HTMLElement | null) => {
      if (index >= 0) {
        itemRefs.current[index] = node
      }
    }
    refCallbacks.current.set(index, callback)
    return callback
  }, [])

  return {
    activeIndex: effectiveActiveIndex,
    setActiveIndex,
    onKeyDown,
    getItemRef,
  }
}
