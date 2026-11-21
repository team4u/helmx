/**
 * DetailDrawer (right-side detail drawer shell) SDK tests:
 * - real React renderToString SSR: the frame renders full markup without a
 *   DOM (no empty string), reusing only the host common .primary-drawer-*
 *   vocabulary and .modal-backdrop — no new CSS theme is introduced;
 * - composable slots: icon / titleExtra badges / meta line render into the
 *   documented header structure; body children pass through; footer is
 *   opt-in (absent when not passed);
 * - DOM interaction contract: the header close button and the Radix Escape
 *   chain both funnel into onClose (single close channel, no double fire);
 * - open=false renders nothing;
 * - bidirectional manifest locking is covered by sdk-contract.test.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Ordering constraint: happy-dom must be registered before react-dom is
// loaded, otherwise react-dom 19 caches native addEventListener refs and the
// synthetic event delegation misses dispatched events.
GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import('react')
const { renderToString } = await import('react-dom/server')
const { createRoot } = await import('react-dom/client')
const { DetailDrawer } = await import('../src/ui/DetailDrawer.js')
const { HelmxIcon } = await import('../src/icons.js')

const e = React.createElement

test('DetailDrawer SSR: renders the full .primary-drawer-* frame with composable slots (renderToString, no DOM)', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(
      DetailDrawer,
      {
        open: true,
        inline: true,
        onClose: () => {},
        title: 'node-7f3a',
        titleExtra: e('span', { className: 'badge badge-ok' }, 'online'),
        icon: e(HelmxIcon, { name: 'monitor', size: 22 }),
        meta: 'node-7f3a@example',
        'aria-label': 'Node detail: node-7f3a',
        footer: e('button', { type: 'button', className: 'btn btn-primary btn-sm' }, 'Save'),
        children: e('div', { className: 'kv-grid' }, 'body content'),
      },
    ),
  )

  assert.ok(html.length > 0, 'SSR must render real markup, never an empty string')
  assert.ok(html.includes('primary-drawer-backdrop'), 'frame binds the shared backdrop class')
  assert.ok(html.includes('primary-drawer-content'), 'frame binds the shared content class')
  assert.ok(html.includes('primary-drawer-header'), 'header structure uses the shared class')
  assert.ok(html.includes('primary-drawer-icon-wrap'), 'optional icon renders into the icon wrap')
  assert.ok(html.includes('primary-drawer-title-row'), 'title row uses the shared class')
  assert.ok(html.includes('primary-drawer-title'), 'title binds the shared class')
  assert.ok(html.includes('badge badge-ok'), 'titleExtra badges render inline in the title row')
  assert.ok(html.includes('primary-drawer-id'), 'meta renders as the secondary mono line')
  assert.ok(html.includes('node-7f3a@example'), 'meta content passes through')
  assert.ok(html.includes('primary-drawer-body'), 'body uses the shared scrollable class')
  assert.ok(html.includes('body content'), 'body children pass through untouched')
  assert.ok(html.includes('primary-drawer-footer'), 'footer renders when provided')
  assert.ok(html.includes('Node detail: node-7f3a'), 'aria-label lands on the dialog content')
})

test('DetailDrawer SSR: no icon / meta / footer slots render nothing extra; className extensions are appended', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(
      DetailDrawer,
      {
        open: true,
        inline: true,
        onClose: () => {},
        title: 'Plain',
        className: 'workflow-lib-drawer',
        bodyClassName: 'compact-body',
        closeButtonClassName: 'btn btn-ghost btn-sm',
        children: 'minimal body',
      },
    ),
  )
  assert.ok(!html.includes('primary-drawer-icon-wrap'), 'icon wrap is opt-in')
  assert.ok(!html.includes('primary-drawer-id'), 'meta line is opt-in')
  assert.ok(!html.includes('primary-drawer-footer'), 'footer is opt-in')
  assert.ok(html.includes('primary-drawer-content workflow-lib-drawer'), 'content class extension is appended')
  assert.ok(html.includes('primary-drawer-body compact-body'), 'body class extension is appended')
  assert.ok(html.includes('btn btn-ghost btn-sm'), 'close button class is overridable')
})

test('DetailDrawer SSR: migration slots (titleClassName/metaClassName/belowTitle/overlayClassName/aux/closeIcon) compose verbatim', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(
      DetailDrawer,
      {
        open: true,
        inline: true,
        onClose: () => {},
        title: 'Drawer title',
        titleClassName: 'break-word',
        meta: 'node-1',
        metaClassName: 'text-subtle break-word',
        belowTitle: e('div', { className: 'text-subtle' }, 'machine shared'),
        overlayClassName: 'skill-drawer-backdrop',
        className: 'skill-drawer-content',
        closeButtonClassName: 'btn btn-ghost btn-sm',
        closeIcon: e('span', { 'aria-hidden': 'true' }, 'X'),
        aux: e('div', { className: 'nested-confirm' }, 'aux content'),
        children: 'body',
      },
    ),
  )
  assert.ok(html.includes('primary-drawer-title break-word'), 'title extension classes append')
  assert.ok(html.includes('primary-drawer-id mono text-subtle break-word'), 'meta keeps base + extensions')
  assert.ok(html.includes('>machine shared<'), 'belowTitle renders consumer lines verbatim')
  assert.ok(html.includes('skill-drawer-backdrop') && html.includes('primary-drawer-backdrop'), 'backdrop extension appends')
  assert.ok(html.includes('primary-drawer-content skill-drawer-content'), 'content extension appends')
  assert.ok(html.includes('>X<'), 'closeIcon override renders')
  assert.ok(html.includes('nested-confirm'), 'aux renders inside the dialog root (after the portal)')
})

test('DetailDrawer SSR: open=false renders nothing', { timeout: 60_000 }, () => {
  const html = renderToString(e(DetailDrawer, { open: false, onClose: () => {}, title: 'Hidden', children: 'body' }))
  assert.ok(html === '', 'closed drawer renders no markup')
})

test('DetailDrawer DOM interaction: header close button funnels into onClose exactly once', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  let closeCalls = 0
  function TestApp() {
    return e(
      DetailDrawer,
      { open: true, inline: true, onClose: () => { closeCalls += 1 }, title: 'Interactive', closeLabel: 'Close drawer', children: e('div', null, 'interactive body') },
    )
  }

  await act(async () => {
    root.render(e(TestApp))
  })

  const closeButton = container.querySelector<HTMLButtonElement>('button[aria-label="Close drawer"]')
  assert.ok(closeButton !== null, 'the header close button renders with the accessible name')
  await act(async () => {
    closeButton.click()
  })
  assert.ok(closeCalls === 1, `one close request through the single close channel (got ${closeCalls})`)

  await act(async () => {
    root.unmount()
  })
  container.remove()
})

test('DetailDrawer DOM interaction: Escape on the dialog content funnels into onClose (Radix chain)', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  let closeCalls = 0
  function TestApp() {
    return e(
      DetailDrawer,
      { open: true, inline: true, onClose: () => { closeCalls += 1 }, title: 'Escape me', children: 'body' },
    )
  }

  await act(async () => {
    root.render(e(TestApp))
  })

  const content = container.querySelector<HTMLElement>('.primary-drawer-content')
  assert.ok(content !== null, 'dialog content renders inline for interaction testing')
  await act(async () => {
    content.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
  })
  assert.ok(closeCalls === 1, `Escape triggers exactly one close request (got ${closeCalls})`)

  await act(async () => {
    root.unmount()
  })
  container.remove()
})
