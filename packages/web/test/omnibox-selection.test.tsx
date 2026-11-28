/**
 * Direct hook tests for `useOmniboxSelection`:
 * - Selection ID pinning across async lower-zone arrivals
 * - Keyboard wrap-around (`ArrowDown` / `ArrowUp`)
 * - Stationary pointer hover suppression until real pointer movement
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ensureHappyDom, resetHappyDom } from './helpers/dom-harness.js'
import type { OmniboxItem } from '../src/omnibox/types.js'
import type { OmniboxSelection } from '../src/omnibox/use-omnibox-selection.js'

ensureHappyDom()

const { useOmniboxSelection } = await import('../src/omnibox/use-omnibox-selection.js')

function makeRow(id: string, isAsync = false): OmniboxItem {
  return {
    id,
    kind: isAsync ? 'message' : 'page',
    scope: isAsync ? 'conversations' : 'pages',
    group: isAsync ? 'messages' : 'pages',
    title: id,
    isAsync,
    searchTerms: { primary: [id] },
    intent: { type: 'navigate', target: { kind: 'overview' } },
  }
}

describe('omnibox-selection', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    resetHappyDom()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }, { timeout: 60_000 })

  test('pins selectedId across async arrivals, wraps on arrows, and guards hover until pointer moves', { timeout: 60_000 }, async () => {
    let latest: OmniboxSelection | undefined

    function Harness({ rows }: { rows: OmniboxItem[] }) {
      const sel = useOmniboxSelection(rows)
      latest = sel
      return (
        <div ref={sel.listRef}>
          {rows.map((row, idx) => (
            <div key={row.id} data-idx={idx} data-selected={idx === sel.selectedIdx ? 'true' : 'false'}>
              {row.title}
            </div>
          ))}
        </div>
      )
    }

    const syncRows = [makeRow('page:a'), makeRow('page:b')]
    await act(async () => {
      root.render(<Harness rows={syncRows} />)
    })
    assert.equal(latest?.selectedIdx, 0)

    // Move selection to `page:b`
    await act(async () => {
      latest?.moveSelection(1)
    })
    assert.equal(latest?.selectedId, 'page:b')
    assert.equal(latest?.selectedIdx, 1)

    // Async rows arrive below -> `page:b` stays pinned!
    const withAsync = [...syncRows, makeRow('msg:1', true), makeRow('msg:2', true)]
    await act(async () => {
      root.render(<Harness rows={withAsync} />)
    })
    assert.equal(latest?.selectedId, 'page:b')
    assert.equal(latest?.selectedIdx, 1)

    // Wrap backwards from index 0 to last item
    await act(async () => {
      latest?.resetSelection()
    })
    assert.equal(latest?.selectedIdx, 0)
    await act(async () => {
      latest?.moveSelection(-1)
    })
    assert.equal(latest?.selectedIdx, 3)
    assert.equal(latest?.selectedId, 'msg:2')

    // Stationary hover after keyboard move is ignored until pointer moves
    await act(async () => {
      latest?.handleRowPointerHover('page:a', 100, 100, false)
    })
    assert.equal(latest?.selectedId, 'msg:2')

    await act(async () => {
      latest?.handleRowPointerHover('page:a', 100, 100, true)
    })
    assert.equal(latest?.selectedId, 'page:a')

    // Duplicate mousemove at identical coords does not jump
    await act(async () => {
      latest?.moveSelection(1)
    })
    assert.equal(latest?.selectedId, 'page:b')
    await act(async () => {
      latest?.handleRowPointerHover('page:a', 100, 100, true)
    })
    assert.equal(latest?.selectedId, 'page:b')
  })
})
