/**
 * Omnibox keyboard & pointer selection state:
 * - Pins `selectedId` across asynchronous lower-zone arrivals so Enter never races
 * - Suppresses stationary pointer hover after query / scope / keyboard changes until the pointer actually moves
 * - Scrolls the active option into view smoothly (`block: 'nearest'`)
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { resolveSelectedIndex } from './ranker.js'
import type { OmniboxItem } from './types.js'

export interface OmniboxSelection {
  selectedId: string | null
  selectedIdx: number
  rowIndexById: Map<string, number>
  listRef: RefObject<HTMLDivElement | null>
  resetSelection: () => void
  moveSelection: (delta: 1 | -1) => void
  handleRowPointerHover: (rowId: string, clientX: number, clientY: number, isMove: boolean) => void
}

export function useOmniboxSelection(rows: ReadonlyArray<OmniboxItem>): OmniboxSelection {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const ignoreHoverRef = useRef(false)
  const lastPointerPosRef = useRef<{ x: number; y: number } | null>(null)

  const selectedIdx = useMemo(() => resolveSelectedIndex(rows, selectedId), [rows, selectedId])

  const rowIndexById = useMemo(() => {
    const map = new Map<string, number>()
    rows.forEach((row, idx) => map.set(row.id, idx))
    return map
  }, [rows])

  useEffect(() => {
    if (selectedIdx < 0) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  const resetSelection = useCallback(() => {
    setSelectedId(null)
    ignoreHoverRef.current = true
  }, [])

  const moveSelection = useCallback(
    (delta: 1 | -1) => {
      ignoreHoverRef.current = true
      if (rows.length === 0) return
      const nextIdx =
        delta === 1
          ? selectedIdx < 0
            ? 0
            : (selectedIdx + 1) % rows.length
          : selectedIdx < 0
            ? rows.length - 1
            : (selectedIdx - 1 + rows.length) % rows.length
      const nextRow = rows[nextIdx]
      if (nextRow !== undefined) setSelectedId(nextRow.id)
    },
    [rows, selectedIdx],
  )

  const handleRowPointerHover = useCallback((rowId: string, clientX: number, clientY: number, isMove: boolean) => {
    const prev = lastPointerPosRef.current
    if (isMove) {
      if (prev === null || clientX !== prev.x || clientY !== prev.y) {
        lastPointerPosRef.current = { x: clientX, y: clientY }
        ignoreHoverRef.current = false
        setSelectedId(rowId)
      }
      return
    }
    if (!ignoreHoverRef.current) setSelectedId(rowId)
  }, [])

  return {
    selectedId,
    selectedIdx,
    rowIndexById,
    listRef,
    resetSelection,
    moveSelection,
    handleRowPointerHover,
  }
}
