import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureTimelineScrollAnchor, restoreTimelineScrollAnchor } from '../src/conversation/timeline-scroll-anchor.js'


test('captureTimelineScrollAnchor selects the first row intersecting the viewport and captures bottom/entryId/turnTailId', { timeout: 60_000 }, () => {
  const scroller = document.createElement('div')
  const visible = document.createElement('div')
  visible.dataset.entryId = 'visible'
  visible.dataset.turnTailId = 'tail-9'
  scroller.append(visible)
  document.body.append(scroller)
  scroller.getBoundingClientRect = () => ({ top: 100, bottom: 300, left: 0, width: 200, height: 200 } as DOMRect)
  visible.getBoundingClientRect = () => ({ top: 120, bottom: 160 } as DOMRect)
  const originalElementFromPoint = document.elementFromPoint
  document.elementFromPoint = () => visible

  try {
    const anchor = captureTimelineScrollAnchor(scroller)
    assert.ok(anchor?.element === visible)
    assert.equal(anchor?.top, 120)
    assert.equal(anchor?.bottom, 160)
    assert.equal(anchor?.entryId, 'visible')
    assert.equal(anchor?.turnTailId, 'tail-9')
  } finally {
    document.elementFromPoint = originalElementFromPoint
  }
})

test('restoreTimelineScrollAnchor corrects only residual movement', { timeout: 60_000 }, () => {
  const scroller = document.createElement('div')
  const visible = document.createElement('div')
  visible.dataset.entryId = 'visible'
  scroller.append(visible)
  document.body.append(scroller)
  let top = 0
  const writes: number[] = []
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => { top = value; writes.push(value) },
  })
  let anchorTop = 100
  visible.getBoundingClientRect = () => ({ top: anchorTop, bottom: anchorTop + 40 } as DOMRect)

  const anchor = { element: visible, top: 100 }
  restoreTimelineScrollAnchor(scroller, anchor)
  assert.deepEqual(writes, [], 'native scroll anchoring already preserved the row')

  anchorTop = 145
  restoreTimelineScrollAnchor(scroller, anchor)
  assert.deepEqual(writes, [45], 'only the remaining 45px shift is corrected')
})

test('restoreTimelineScrollAnchor recovers remounted assistant turn via data-turn-tail-id + bottom and ignores truly detached anchors', { timeout: 60_000 }, () => {
  const scroller = document.createElement('div')
  const detached = document.createElement('div')
  let top = 200
  const writes: number[] = []
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => { top = value; writes.push(value) },
  })
  detached.getBoundingClientRect = () => ({ top: 200, bottom: 240 } as DOMRect)

  restoreTimelineScrollAnchor(scroller, { element: detached, top: 100 })
  assert.equal(writes.length, 0)

  // Remounted turn wrapper (turn:root -> turn:human:...) shares data-turn-tail-id while growing upward
  const remounted = document.createElement('div')
  remounted.dataset.entryId = '10'
  remounted.dataset.turnTailId = '25'
  remounted.getBoundingClientRect = () => ({ top: 90, bottom: 380 } as DOMRect)
  scroller.append(remounted)

  restoreTimelineScrollAnchor(scroller, {
    element: detached,
    top: 150,
    bottom: 260,
    entryId: '20',
    turnTailId: '25',
  })
  assert.deepEqual(writes, [320], 'compensates rect.bottom - anchor.bottom (380 - 260 = +120px)')
})

test('restoreTimelineScrollAnchor does not shift downward on connected SSE turn tail growth, but anchors bottom on connected headless mega-turn prepend', { timeout: 60_000 }, () => {
  const scroller = document.createElement('div')
  const turn = document.createElement('div')
  turn.dataset.entryId = '20'
  turn.dataset.turnTailId = '21'
  scroller.append(turn)
  document.body.append(scroller)

  let top = 300
  const writes: number[] = []
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => { top = value; writes.push(value) },
  })

  // 1. Connected SSE turn growth at tail: top stays 120, bottom grows 260 -> 420, entryId stays '20', turnTailId advances '21' -> '22'
  let rect = { top: 120, bottom: 420 }
  turn.getBoundingClientRect = () => rect as DOMRect
  turn.dataset.turnTailId = '22'
  restoreTimelineScrollAnchor(scroller, {
    element: turn,
    top: 120,
    bottom: 260,
    entryId: '20',
    turnTailId: '21',
  })
  // Also verify when turnTailId stays identical ('21' -> '21') while bottom grows from appended text
  turn.dataset.turnTailId = '21'
  restoreTimelineScrollAnchor(scroller, {
    element: turn,
    top: 120,
    bottom: 260,
    entryId: '20',
    turnTailId: '21',
  })
  assert.deepEqual(writes, [], 'connected SSE tail growth must not push scrollTop downward')

  // 2. Connected headless mega-turn (turn:root -> turn:root): earlier entries prepend at head -> entryId shifts '20' -> '11', turnTailId stays '21'
  turn.dataset.entryId = '11'
  turn.dataset.turnTailId = '21'
  rect = { top: 150, bottom: 380 }
  restoreTimelineScrollAnchor(scroller, {
    element: turn,
    top: 120,
    bottom: 260,
    entryId: '20',
    turnTailId: '21',
  })
  assert.deepEqual(writes, [420], 'connected mega-turn head-prepend compensates rect.bottom - anchor.bottom (380 - 260 = +120px)')
})
