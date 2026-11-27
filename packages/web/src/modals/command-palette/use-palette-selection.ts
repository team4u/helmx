/**
 * 命令面板选中态：键盘上下移动、指针悬停选中（查询变化后忽略悬停直到指针真正移动）、
 * 选中项滚动到可见区域。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { resolveSelectedIndex, type PaletteRow } from '../command-palette-model.js'

export interface PaletteSelection {
  selectedId: string | null
  selectedIdx: number
  rowIndexById: Map<string, number>
  listRef: RefObject<HTMLDivElement | null>
  resetSelection: () => void
  /** 键盘方向键移动：忽略悬停选中，空列表不动。 */
  moveSelection: (delta: 1 | -1) => void
  handleRowPointerHover: (rowId: string, clientX: number, clientY: number, isMove: boolean) => void
}

export function usePaletteSelection(rows: PaletteRow[]): PaletteSelection {
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
          ? (selectedIdx < 0 ? 0 : (selectedIdx + 1) % rows.length)
          : (selectedIdx < 0 ? rows.length - 1 : (selectedIdx - 1 + rows.length) % rows.length)
      const nextRow = rows[nextIdx]
      if (nextRow) setSelectedId(nextRow.id)
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

  return { selectedId, selectedIdx, rowIndexById, listRef, resetSelection, moveSelection, handleRowPointerHover }
}
