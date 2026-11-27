/**
 * Round 2 UI foundation primitives tests (SSR + happy-dom):
 * - ModalDialog: open/close, size tiers (sm/md/lg/fullscreen), flushBody,
 *   icon/titleExtra/description/headerActions/footer, aria-describedby wiring,
 *   default container focus vs custom onOpenAutoFocus, closeDisabled gating
 *   (button + Escape), and UI_SHARED_EXPORTS registration;
 * - Kbd: default/sm/desktopOnly classes, ref forwarding, and manifest locking;
 * - TabsList scrollable: ResizeObserver + scroll listener syncing
 *   data-overflow-left / data-overflow-right;
 * - DropdownMenuItem structured slots: icon (string & ReactNode), description,
 *   shortcut, trailing, checked (true/false), danger, and plain-children
 *   compatibility;
 * - SearchBox surface ('default' | 'subtle' | 'frameless') & MultiSelect
 *   internal subtle SearchBox;
 * - DataTable empty state rendering `<EmptyState compact title={emptyLabel} />`.
 */
import './helpers/register-happy-dom.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'

const { act } = await import('react')
const { renderToString } = await import('react-dom/server')
const { createRoot } = await import('react-dom/client')
const { UI_SHARED_EXPORTS } = await import('@helmx/protocol')
const {
  DataTable,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  Kbd,
  ModalDialog,
  MultiSelect,
  SearchBox,
  Tabs,
  TabsList,
  TabsTrigger,
} = await import('../src/index.js')

const e = React.createElement

// ---------------------------------------------------------------------------
// 1. ModalDialog
// ---------------------------------------------------------------------------

test('ModalDialog SSR: open=false renders empty; open=true renders all composable slots and size tiers', { timeout: 60_000 }, () => {
  assert.ok(
    (UI_SHARED_EXPORTS as readonly string[]).includes('ModalDialog'),
    'UI_SHARED_EXPORTS must include ModalDialog',
  )

  const closedHtml = renderToString(
    e(ModalDialog, { open: false, onClose: () => {}, title: 'Hidden', children: 'Body' }),
  )
  assert.equal(closedHtml, '', 'closed ModalDialog renders no markup')

  const fullHtml = renderToString(
    e(ModalDialog, {
      open: true,
      inline: true,
      onClose: () => {},
      title: 'Keyboard Shortcuts',
      icon: 'terminal',
      titleExtra: e('span', { className: 'badge badge-neutral' }, 'v2'),
      description: 'Global and panel shortcuts.',
      size: 'lg',
      flushBody: true,
      headerActions: e('button', { type: 'button', className: 'btn btn-ghost btn-sm' }, 'Copy'),
      footer: e('button', { type: 'button', className: 'btn btn-primary btn-sm' }, 'Done'),
      className: 'custom-modal',
      overlayClassName: 'custom-backdrop',
      bodyClassName: 'custom-body',
      children: e('div', null, 'Shortcut table'),
    }),
  )
  assert.ok(fullHtml.includes('helmx-modal-backdrop custom-backdrop'))
  assert.ok(fullHtml.includes('helmx-modal helmx-modal-lg custom-modal'))
  assert.ok(fullHtml.includes('helmx-modal-icon'))
  assert.ok(fullHtml.includes('helmx-modal-title'))
  assert.ok(fullHtml.includes('badge badge-neutral'))
  assert.ok(fullHtml.includes('helmx-modal-desc'))
  assert.ok(fullHtml.includes('Global and panel shortcuts.'))
  assert.ok(fullHtml.includes('helmx-modal-header-actions'))
  assert.ok(fullHtml.includes('helmx-modal-body helmx-modal-body-flush custom-body'))
  assert.ok(fullHtml.includes('helmx-modal-footer'))

  const fullscreenHtml = renderToString(
    e(ModalDialog, {
      open: true,
      inline: true,
      onClose: () => {},
      title: 'Preview',
      size: 'fullscreen',
      children: 'Canvas',
    }),
  )
  assert.ok(fullscreenHtml.includes('helmx-modal-backdrop helmx-modal-backdrop-fullscreen'))
  assert.ok(fullscreenHtml.includes('helmx-modal helmx-modal-fullscreen'))
  assert.ok(!fullscreenHtml.includes('helmx-modal-desc'))
  assert.ok(!fullscreenHtml.includes('helmx-modal-footer'))
  assert.ok(!fullscreenHtml.includes('aria-describedby='), 'omitted description should not emit aria-describedby')
})

test('ModalDialog DOM: focuses container by default, funnels close button & Escape once, respects closeDisabled and custom onOpenAutoFocus', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  let closeCount = 0
  const getCloseCount = () => closeCount

  try {
    await act(async () => {
      root.render(
        e(ModalDialog, {
          open: true,
          inline: true,
          onClose: () => { closeCount += 1 },
          title: 'Save preset',
          description: 'Store current tier mapping for reuse.',
          closeLabel: 'Close modal',
          children: e('input', { type: 'text', id: 'preset-name' }),
        }),
      )
    })

    const content = container.querySelector<HTMLElement>('.helmx-modal')
    const closeBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Close modal"]')
    const descEl = container.querySelector<HTMLElement>('.helmx-modal-desc')
    assert.ok(content !== null && closeBtn !== null && descEl !== null)
    assert.equal(content.getAttribute('aria-describedby'), descEl.id, 'mounted ModalDialog with description links aria-describedby')
    assert.ok(document.activeElement === content, 'default open focus targets modal container, not close button')

    await act(async () => {
      closeBtn.click()
    })
    assert.equal(getCloseCount(), 1, 'close button fires onClose once')

    await act(async () => {
      content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.equal(getCloseCount(), 2, 'Escape fires onClose once')

    await act(async () => {
      root.render(
        e(ModalDialog, {
          open: true,
          inline: true,
          closeDisabled: true,
          onClose: () => { closeCount += 1 },
          title: 'Saving preset',
          closeLabel: 'Close modal',
          children: e('div', null, 'Saving...'),
        }),
      )
    })
    const disabledCloseBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Close modal"]')
    const lockedContent = container.querySelector<HTMLElement>('.helmx-modal')
    assert.ok(disabledCloseBtn !== null && lockedContent !== null)
    assert.equal(lockedContent.getAttribute('aria-describedby'), null, 'ModalDialog without description omits aria-describedby')
    assert.equal(disabledCloseBtn.disabled, true, 'close button is disabled when closeDisabled=true')
    await act(async () => {
      disabledCloseBtn.click()
      lockedContent.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.equal(getCloseCount(), 2, 'closeDisabled prevents close button and Escape from firing onClose')

    await act(async () => {
      root.render(e('div'))
    })
    const inputRef = React.createRef<HTMLInputElement>()
    await act(async () => {
      root.render(
        e(ModalDialog, {
          open: true,
          inline: true,
          onClose: () => {},
          title: 'Rename',
          onOpenAutoFocus: (event) => {
            event.preventDefault()
            inputRef.current?.focus()
          },
          children: e('input', { ref: inputRef, type: 'text' }),
        }),
      )
    })
    assert.ok(document.activeElement === inputRef.current, 'custom onOpenAutoFocus moves focus to target input')
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// 2. Kbd
// ---------------------------------------------------------------------------

test('Kbd SSR + DOM: renders unified .helmx-kbd badge with size/desktopOnly modifiers and forwards ref', { timeout: 60_000 }, async () => {
  assert.ok(
    (UI_SHARED_EXPORTS as readonly string[]).includes('Kbd'),
    'UI_SHARED_EXPORTS must include Kbd',
  )

  const defaultHtml = renderToString(e(Kbd, null, '⌘K'))
  assert.equal(defaultHtml, '<kbd class="helmx-kbd">⌘K</kbd>')

  const compactDesktopHtml = renderToString(
    e(Kbd, { size: 'sm', desktopOnly: true, className: 'extra-kbd' }, 'Esc'),
  )
  assert.equal(
    compactDesktopHtml,
    '<kbd class="helmx-kbd helmx-kbd-sm helmx-kbd-desktop-only extra-kbd">Esc</kbd>',
  )

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const kbdRef = React.createRef<HTMLElement>()
  try {
    await act(async () => {
      root.render(e(Kbd, { ref: kbdRef, title: 'Shortcut' }, 'Enter'))
    })
    assert.ok(kbdRef.current !== null && kbdRef.current.tagName === 'KBD')
    assert.equal(kbdRef.current.textContent, 'Enter')
    assert.equal(kbdRef.current.getAttribute('title'), 'Shortcut')
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// 3. TabsList scrollable overflow masks
// ---------------------------------------------------------------------------

test('TabsList scrollable DOM: updates data-overflow-left and data-overflow-right on mount, scroll, and ResizeObserver', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  let resizeCallback: ResizeObserverCallback | null = null
  const OriginalResizeObserver = globalThis.ResizeObserver
  class MockResizeObserver {
    constructor(cb: ResizeObserverCallback) {
      resizeCallback = cb
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver

  try {
    await act(async () => {
      root.render(
        e(
          Tabs,
          { value: 't1', variant: 'underline', size: 'sm' },
          e(
            TabsList,
            { scrollable: true, 'aria-label': 'Workbench tabs' },
            e(TabsTrigger, { value: 't1' }, 'Artifacts'),
            e(TabsTrigger, { value: 't2' }, 'Changes'),
            e(TabsTrigger, { value: 't3' }, 'Plan'),
          ),
        ),
      )
    })

    const listEl = container.querySelector<HTMLElement>('.tabs-bar.helmx-tabs-scrollable')
    assert.ok(listEl !== null, 'TabsList scrollable renders .tabs-bar.helmx-tabs-scrollable')

    let mockScrollLeft = 0
    let mockClientWidth = 120
    let mockScrollWidth = 300
    Object.defineProperty(listEl, 'scrollLeft', { configurable: true, get: () => mockScrollLeft })
    Object.defineProperty(listEl, 'clientWidth', { configurable: true, get: () => mockClientWidth })
    Object.defineProperty(listEl, 'scrollWidth', { configurable: true, get: () => mockScrollWidth })

    await act(async () => {
      resizeCallback?.([], {} as ResizeObserver)
    })
    assert.equal(listEl.getAttribute('data-overflow-left'), null)
    assert.equal(listEl.getAttribute('data-overflow-right'), 'true')

    mockScrollLeft = 60
    await act(async () => {
      listEl.dispatchEvent(new Event('scroll'))
    })
    assert.equal(listEl.getAttribute('data-overflow-left'), 'true')
    assert.equal(listEl.getAttribute('data-overflow-right'), 'true')

    mockScrollLeft = 180
    await act(async () => {
      listEl.dispatchEvent(new Event('scroll'))
    })
    assert.equal(listEl.getAttribute('data-overflow-left'), 'true')
    assert.equal(listEl.getAttribute('data-overflow-right'), null)

    mockScrollLeft = 0
    mockClientWidth = 320
    await act(async () => {
      resizeCallback?.([], {} as ResizeObserver)
    })
    assert.equal(listEl.getAttribute('data-overflow-left'), null)
    assert.equal(listEl.getAttribute('data-overflow-right'), null)
  } finally {
    globalThis.ResizeObserver = OriginalResizeObserver
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// 4. DropdownMenuItem structured slots
// ---------------------------------------------------------------------------

test('DropdownMenuItem SSR: supports structured slots (icon/description/shortcut/trailing/checked/danger) and preserves plain children', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(
      DropdownMenu,
      { open: true },
      e(
        DropdownMenuContent,
        null,
        e(DropdownMenuItem, null, 'Plain item'),
        e(
          DropdownMenuItem,
          {
            icon: 'list-tree',
            description: 'Read-only planning before edits',
            shortcut: e(Kbd, { size: 'sm' }, 'Ctrl+.'),
            trailing: e('span', { className: 'badge badge-accent' }, 'ON'),
            checked: true,
          },
          'Plan mode',
        ),
        e(
          DropdownMenuItem,
          {
            icon: e('span', { className: 'custom-icon' }, '*'),
            checked: false,
            danger: true,
          },
          'Delete thread',
        ),
      ),
    ),
  )

  assert.ok(html.includes('>Plain item<'), 'plain children stay unwrapped')
  assert.ok(html.includes('helmx-dropdown-item-has-desc'))
  assert.ok(html.includes('helmx-dropdown-item-icon'))
  assert.ok(html.includes('helmx-dropdown-item-body'))
  assert.ok(html.includes('helmx-dropdown-item-label">Plan mode<'))
  assert.ok(html.includes('helmx-dropdown-item-desc">Read-only planning before edits<'))
  assert.ok(html.includes('helmx-dropdown-item-trailing'))
  assert.ok(html.includes('helmx-dropdown-item-shortcut'))
  assert.ok(html.includes('helmx-kbd helmx-kbd-sm'))
  assert.ok(html.includes('helmx-dropdown-item-check'))
  assert.ok(html.includes('data-checked="true"'))
  assert.ok(html.includes('data-checked="false"'))
  assert.ok(html.includes('custom-icon'))
  assert.ok(html.includes('helmx-dropdown-item-danger'))
})

// ---------------------------------------------------------------------------
// 5. SearchBox surface + MultiSelect subtle SearchBox
// ---------------------------------------------------------------------------

test('SearchBox SSR: surface="default|subtle|frameless" maps cleanly and composes with size="sm" and className', { timeout: 60_000 }, () => {
  const defHtml = renderToString(
    e(SearchBox, { value: '', onChange: () => {}, surface: 'default', className: 'extra' }),
  )
  assert.ok(defHtml.includes('class="search-box extra"'))
  assert.ok(!defHtml.includes('search-box-subtle') && !defHtml.includes('search-box-frameless'))

  const subtleHtml = renderToString(
    e(SearchBox, { value: '', onChange: () => {}, size: 'sm', surface: 'subtle' }),
  )
  assert.ok(subtleHtml.includes('class="search-box search-box-subtle search-box-sm"'))

  const framelessHtml = renderToString(
    e(SearchBox, { value: '', onChange: () => {}, surface: 'frameless', className: 'palette-search-box' }),
  )
  assert.ok(framelessHtml.includes('class="search-box search-box-frameless palette-search-box"'))
})

test('MultiSelect DOM: internal search uses SearchBox(size="sm", surface="subtle") and filters + clears options', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const options = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
    { value: 'c', label: 'Charlie' },
    { value: 'd', label: 'Delta' },
    { value: 'e', label: 'Echo' },
  ]
  try {
    await act(async () => {
      root.render(
        e(MultiSelect, {
          open: true,
          inline: true,
          value: [],
          options,
          'aria-label': 'Pick items',
        }),
      )
    })

    const searchBox = container.querySelector<HTMLElement>('.helmx-select-search .search-box.search-box-subtle.search-box-sm')
    assert.ok(searchBox !== null, 'MultiSelect search should render <SearchBox size="sm" surface="subtle" />')
    const input = searchBox.querySelector<HTMLInputElement>('input[type="text"][role="combobox"]')
    assert.ok(input !== null, 'SearchBox inner input preserves type="text" and role="combobox"')

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      const tracker = (input as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
      const prev = tracker?.getValue() ?? ''
      setter.call(input, 'char')
      tracker?.setValue(prev)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    assert.equal(container.querySelectorAll('[role="option"]').length, 1)

    const clearBtn = searchBox.querySelector<HTMLButtonElement>('.search-box-clear')
    assert.ok(clearBtn !== null, 'SearchBox renders single clear button when query is non-empty')
    await act(async () => {
      clearBtn.click()
    })
    assert.equal(container.querySelectorAll('[role="option"]').length, 5)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// 6. DataTable EmptyState compact
// ---------------------------------------------------------------------------

test('DataTable DOM: empty row renders <EmptyState compact title={emptyLabel} /> inside td.table-empty', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        e(DataTable, {
          empty: true,
          columns: 3,
          emptyLabel: 'Nothing matched',
          children: null,
        }),
      )
    })
    const td = container.querySelector<HTMLTableCellElement>('td.table-empty')
    assert.ok(td !== null)
    assert.equal(td.colSpan, 3)
    const emptyState = td.querySelector<HTMLElement>('.empty-state.empty-state-compact')
    assert.ok(emptyState !== null, 'DataTable empty cell must render <EmptyState compact>')
    assert.equal(emptyState.querySelector('.empty-state-title')?.textContent, 'Nothing matched')
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})
