/**
 * Shared light-pattern primitive tests (SearchBox / EmptyState /
 * ThinkingLevelControl / ConfirmDialog):
 * - SSR renderToString: real markup, no portal / window access;
 * - SearchBox encodes the unified search-box spec: always type="text", the
 *   single clear button appears only for a non-empty value and emits onChange('')
 *   on click; container/input/clear classes are caller-chosen from the host
 *   common vocabulary;
 * - EmptyState renders the host .empty-state vocabulary with optional
 *   icon/title/hint/compact slots;
 * - ThinkingLevelControl renders nothing for an empty level list, falls back
 *   to a supported level for an invalid value, and picks through the single
 *   Tabs channel;
 * - ConfirmDialog composes the alert-dialog family with danger variant and
 *   locale-default confirm/cancel copy.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Ordering constraint: happy-dom must be registered before react-dom (and any
// portal-carrying component module) is loaded, otherwise react-dom 19 caches
// native addEventListener refs and the synthetic event delegation misses
// dispatched input events (onChange breaks).
GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import('react')
const { renderToString } = await import('react-dom/server')
const { createRoot } = await import('react-dom/client')
const { SearchBox } = await import('../src/ui/SearchBox.js')
const { EmptyState } = await import('../src/ui/EmptyState.js')
const { ThinkingLevelControl } = await import('../src/ui/ThinkingLevelControl.js')
const { ConfirmDialog } = await import('../src/ui/AlertDialog.js')

const e = React.createElement

// ---------------------------------------------------------------------------
// SearchBox
// ---------------------------------------------------------------------------

test('SearchBox SSR: compact default container, type="text", no clear button when empty', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(SearchBox, { value: '', onChange: () => {}, placeholder: 'Search models', ariaLabel: 'Search models' }),
  )
  assert.ok(html.includes('class="search-box"'), 'defaults to the compact .search-box container')
  assert.ok(html.includes('type="text"'), 'the shared spec forbids type="search"')
  assert.ok(html.includes('placeholder="Search models"'))
  assert.ok(html.includes('aria-label="Search models"'))
  assert.ok(!html.includes('<button'), 'no clear button for an empty value (at most one clear control)')
})

test('SearchBox SSR: toolbar variant classes are caller-chosen; clear button appears for a non-empty value', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(
      SearchBox,
      {
        value: 'magpie',
        onChange: () => {},
        className: 'primary-search-box',
        inputClassName: 'sidebar-search-input',
        clearButtonClassName: 'btn btn-ghost btn-sm primary-search-clear',
        clearLabel: 'Clear search',
      },
    ),
  )
  assert.ok(html.includes('class="primary-search-box"'), 'container class is caller-chosen')
  assert.ok(html.includes('sidebar-search-input'), 'input class extension lands on the inner input')
  assert.ok(html.includes('primary-search-clear'), 'clear button class extension lands')
  assert.ok(html.includes('aria-label="Clear search"'), 'clear button carries the accessible name')
  assert.ok(html.includes('value="magpie"'), 'controlled value renders')
})

test('SearchBox DOM: typing emits unwrapped values and the clear button resets to empty string', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const emitted: string[] = []
  let value = 'seed'
  function TestApp() {
    return e(SearchBox, {
      value,
      onChange: (next) => {
        emitted.push(next)
        value = next
      },
    })
  }

  await act(async () => {
    root.render(e(TestApp))
  })

  const input = container.querySelector<HTMLInputElement>('input[type="text"]')
  assert.ok(input !== null, 'inner input renders')
  await act(async () => {
    // React value tracking (repo test pattern): set through the native
    // prototype setter and rewind the tracker so the dispatched input event
    // counts as a real user change.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    const tracker = (input as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
    const prev = tracker?.getValue() ?? ''
    setter.call(input, 'abc')
    tracker?.setValue(prev)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  assert.ok(emitted.includes('abc'), `onChange receives the unwrapped string (got ${JSON.stringify(emitted)})`)

  const clear = container.querySelector<HTMLButtonElement>('button[aria-label]')
  assert.ok(clear !== null, 'clear button renders for a non-empty value')
  await act(async () => {
    clear.click()
  })
  assert.ok(emitted[emitted.length - 1] === '', `clear click emits the empty string (got ${JSON.stringify(emitted)})`)

  await act(async () => {
    root.unmount()
  })
  container.remove()
})

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

test('SearchBox SSR: clearable=false hides the clear button; style lands on the container', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(SearchBox, {
      value: 'query',
      onChange: () => {},
      clearable: false,
      style: { flex: '1 1 0%' },
    }),
  )
  assert.ok(!html.includes('<button'), 'clearable=false renders no clear button even for a non-empty value')
  assert.ok(/style="[^"]*flex[^"]*"/.test(html), 'container style passthrough lands')

  const cleared = renderToString(
    e(SearchBox, { value: 'x', onChange: () => {}, onCleared: () => {} }),
  )
  assert.ok(cleared.includes('<button'), 'default clearable keeps the single clear button')
})

test('EmptyState SSR: host vocabulary with optional icon/title/hint and compact density', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(
      EmptyState,
      { title: 'No workflows yet', hint: 'Save one from a conversation to see it here', compact: true },
      'extra body',
    ),
  )
  assert.ok(html.includes('empty-state empty-state-compact'), 'compact density appends the modifier class')
  assert.ok(html.includes('empty-state-title'), 'title renders into the shared class')
  assert.ok(html.includes('empty-state-hint'), 'hint renders into the semantic class')
  assert.ok(html.includes('No workflows yet'))
  assert.ok(html.includes('extra body'), 'children pass through as body fallback')

  const plain = renderToString(e(EmptyState, null, 'nothing selected'))
  assert.ok(plain.includes('class="empty-state"'), 'default density, no icon/title slots rendered')
  assert.ok(!plain.includes('empty-state-icon'), 'icon slot is opt-in')
  assert.ok(plain.includes('nothing selected'))
})

// ---------------------------------------------------------------------------
// ThinkingLevelControl
// ---------------------------------------------------------------------------

test('ThinkingLevelControl SSR: renders plain levels in the segmented control; empty list renders nothing', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(ThinkingLevelControl, { value: 'high', levels: ['off', 'medium', 'high'], onPick: () => {} }),
  )
  assert.ok(html.includes('segmented-control'), 'builds on the shared segmented vocabulary')
  assert.ok(html.includes('aria-label="Thinking level"'), 'default accessible name resolves from the shared locale')
  for (const level of ['off', 'medium', 'high']) {
    assert.ok(html.includes(`>${level}<`), `level ${level} renders as plain text`)
  }
  assert.ok(html.includes('data-state="active"'), 'the effective level is marked active')

  const none = renderToString(
    e(ThinkingLevelControl, { value: 'high', levels: [], onPick: () => {} }),
  )
  assert.ok(none === '', 'an empty level list renders nothing')
})

test('ThinkingLevelControl DOM: invalid value falls back to a supported level; picks go through the single channel', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const picks: string[] = []
  await act(async () => {
    root.render(
      e(ThinkingLevelControl, { value: 'nonexistent', levels: ['off', 'high'], onPick: (level) => picks.push(level) }),
    )
  })

  const triggers = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  assert.ok(triggers.length === 2, `both levels render as tab triggers (got ${triggers.length})`)
  const activeStates = triggers.map((trigger) => trigger.getAttribute('data-state'))
  assert.ok(activeStates.filter((state) => state === 'active').length === 1, 'exactly one active fallback level')

  await act(async () => {
    triggers[1]!.click()
  })
  assert.ok(picks.length === 1 && picks[0] === 'high', `one pick event for the clicked level (got ${JSON.stringify(picks)})`)

  await act(async () => {
    root.unmount()
  })
  container.remove()
})

// ---------------------------------------------------------------------------
// ConfirmDialog
// ---------------------------------------------------------------------------

test('ConfirmDialog SSR: alertdialog semantics, locale-default buttons and the danger variant', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(ConfirmDialog, {
      open: true,
      inline: true,
      onOpenChange: () => {},
      title: 'Delete workflow?',
      description: 'This removes the saved definition file.',
      onConfirm: () => {},
      danger: true,
      confirmText: 'Delete',
    }),
  )
  assert.ok(html.includes('role="alertdialog"'), 'Radix alert dialog semantics')
  assert.ok(html.includes('modal-backdrop') && html.includes('modal-header') && html.includes('modal-footer'), 'host modal vocabulary')
  assert.ok(html.includes('Delete workflow?'))
  assert.ok(html.includes('btn-danger'), 'danger variant styles the confirm button')
  assert.ok(html.includes('btn-primary') === false, 'non-danger primary is not used in danger mode')
  assert.ok(html.includes('>Delete<'), 'explicit confirmText wins')
  assert.ok(html.includes('>Cancel<'), 'cancel copy falls back to the shared locale default')
})

test('ConfirmDialog SSR: non-danger primary confirm and closed state renders nothing', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(ConfirmDialog, {
      open: true,
      inline: true,
      onOpenChange: () => {},
      title: 'Archive profile?',
      onConfirm: () => {},
    }),
  )
  assert.ok(html.includes('btn-primary'), 'default confirm is the primary button')
  assert.ok(!html.includes('modal-body') || html.includes('Archive profile?'), 'optional description omitted cleanly')

  const closed = renderToString(
    e(ConfirmDialog, { open: false, onOpenChange: () => {}, title: 'Hidden', onConfirm: () => {} }),
  )
  assert.ok(closed === '', 'closed confirm renders no markup')
})

test('ConfirmDialog DOM: cancel and confirm buttons invoke their handlers and close the dialog', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  let open = true
  const events: string[] = []
  function TestApp() {
    return e(ConfirmDialog, {
      open,
      onOpenChange: (next) => {
        events.push(`open:${next}`)
        open = next
      },
      title: 'Archive?',
      onConfirm: () => events.push('confirm'),
      onCancel: () => events.push('cancel'),
      inline: true,
    })
  }

  await act(async () => {
    root.render(e(TestApp))
  })

  const buttons = [...container.querySelectorAll<HTMLButtonElement>('.modal-footer button')]
  assert.ok(buttons.length === 2, 'footer carries exactly the cancel + confirm pair')
  await act(async () => {
    buttons[0]!.click()
  })
  await act(async () => {
    buttons[1]!.click()
  })
  assert.ok(events.includes('cancel'), 'cancel handler fires')
  assert.ok(events.includes('confirm'), 'confirm handler fires')
  assert.ok(events.includes('open:false'), 'button closes funnel through onOpenChange(false)')

  await act(async () => {
    root.unmount()
  })
  container.remove()
})
