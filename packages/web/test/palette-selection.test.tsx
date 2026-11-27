/**
 * usePaletteSelection 契约测试（命令面板选中态 Hook，真实 DOM：createRoot + act，happy-dom）：
 * - 空选中时默认高亮首行（selectedIdx=0），方向键在其基础上前进 / 后退并到边界循环；
 * - 查询变化后 resetSelection 忽略悬停选中，直到指针真正移动才恢复；
 * - rowIndexById 与 selectedIdx 与行序一致。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { ensureHappyDom } from './helpers/dom-harness.js'
import type { PaletteRow } from '../src/modals/command-palette-model.js'
import type { PaletteSelection } from '../src/modals/command-palette/use-palette-selection.js'

ensureHappyDom()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { usePaletteSelection } = await import('../src/modals/command-palette/use-palette-selection.js')

function rowsOf(...ids: string[]): PaletteRow[] {
  return ids.map((id) => ({ kind: 'command', id, group: 'commands', title: id }) as unknown as PaletteRow)
}

test('usePaletteSelection：方向键空选中落首 / 尾行并在边界循环；rowIndexById 与行序一致', { timeout: 60_000 }, async () => {
  const rows = rowsOf('r1', 'r2', 'r3')
  const capture: { sel: PaletteSelection | null } = { sel: null }
  function Probe({ rows }: { rows: PaletteRow[] }): null {
    capture.sel = usePaletteSelection(rows)
    return null
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(React.createElement(Probe, { rows }))
    })
    const sel = capture.sel!
    assert.equal(sel.selectedId, null)
    assert.equal(sel.selectedIdx, 0, '空选中默认高亮首行')
    assert.deepEqual([...sel.rowIndexById.entries()], [['r1', 0], ['r2', 1], ['r3', 2]])

    // 默认高亮首行：向下依次 r2、r3，再向下越过末行循环回 r1
    for (const expected of ['r2', 'r3', 'r1']) {
      await act(async () => {
        capture.sel!.moveSelection(1)
      })
      assert.equal(capture.sel!.selectedId, expected)
    }
    assert.equal(capture.sel!.selectedIdx, 0)

    await act(async () => {
      capture.sel!.resetSelection()
      capture.sel!.moveSelection(-1)
    })
    assert.equal(capture.sel!.selectedId, 'r3', '默认高亮首行时向上落到尾行')

    await act(async () => {
      root.render(React.createElement(Probe, { rows: [] }))
    })
    await act(async () => {
      capture.sel!.moveSelection(1)
    })
    assert.equal(capture.sel!.selectedId, 'r3', '空列表不动')
  } finally {
    act(() => { root.unmount() })
    host.remove()
  }
})

test('usePaletteSelection：resetSelection 后忽略悬停，指针真实移动才恢复悬停选中', { timeout: 60_000 }, async () => {
  const rows = rowsOf('r1', 'r2')
  const capture: { sel: PaletteSelection | null } = { sel: null }
  function Probe({ rows }: { rows: PaletteRow[] }): null {
    capture.sel = usePaletteSelection(rows)
    return null
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(React.createElement(Probe, { rows }))
    })
    const sel = capture.sel!
    await act(async () => {
      sel.handleRowPointerHover('r2', 5, 5, false)
    })
    assert.equal(capture.sel!.selectedId, 'r2', '初始允许悬停选中')

    await act(async () => {
      capture.sel!.resetSelection()
      capture.sel!.handleRowPointerHover('r1', 5, 5, false)
    })
    assert.equal(capture.sel!.selectedId, null, '查询变化后的悬停被忽略')

    await act(async () => {
      capture.sel!.handleRowPointerHover('r1', 9, 9, true)
      capture.sel!.handleRowPointerHover('r2', 9, 9, true)
    })
    assert.equal(capture.sel!.selectedId, 'r1', '真实移动恢复悬停；同坐标的 move 事件不重复选中')

    await act(async () => {
      capture.sel!.handleRowPointerHover('r2', 5, 5, false)
    })
    assert.equal(capture.sel!.selectedId, 'r2', '恢复后普通悬停再次生效')
  } finally {
    act(() => { root.unmount() })
    host.remove()
  }
})
