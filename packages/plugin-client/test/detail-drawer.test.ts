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
 * - onEscapeKeyDown passthrough: preventDefault inside the hook keeps the
 *   drawer open (layered Escape for inner search boxes), letting it through
 *   closes as before;
 * - open=false renders nothing;
 * - bidirectional manifest locking is covered by sdk-contract.test.ts.
 */
import './helpers/register-happy-dom.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'

// Ordering constraint: happy-dom is registered by the side-effect import above
// before react-dom is loaded, otherwise react-dom 19 caches native
// addEventListener refs and synthetic event delegation misses dispatched events.

const { act } = await import('react')
const { renderToString } = await import('react-dom/server')
const { createRoot } = await import('react-dom/client')
const { PLUGIN_CLIENT_SHARED_EXPORTS } = await import('@helmx/protocol')
const { DetailDrawer, ScreenParamsContext, useScreenDrawer } = await import('../src/index.js')
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

  const content = container.querySelector<HTMLElement>('.primary-drawer-content')
  const closeButton = container.querySelector<HTMLButtonElement>('button[aria-label="Close drawer"]')
  assert.ok(content !== null, 'dialog content renders')
  assert.ok(closeButton !== null, 'the header close button renders with the accessible name')
  assert.ok(document.activeElement === content, 'opening DetailDrawer focuses dialog container, not close button')
  assert.ok(document.activeElement !== closeButton, 'close button is not auto-focused on open')
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

test('DetailDrawer DOM interaction: onEscapeKeyDown is passed through verbatim; preventDefault keeps the drawer open', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  // Counters are read through functions: assert.ok(x === 1) would otherwise narrow the
  // captured `let` counter to the literal 1 and reject the later `=== 2` comparison.
  let closeCount = 0
  let interceptedCount = 0
  const closeCalls = () => closeCount
  const intercepted = () => interceptedCount
  let swallow = true
  function TestApp() {
    return e(
      DetailDrawer,
      {
        open: true,
        inline: true,
        onClose: () => { closeCount += 1 },
        title: 'Layered escape',
        onEscapeKeyDown: (event: KeyboardEvent) => {
          interceptedCount += 1
          // Radix listens on `document` in the capture phase: only preventDefault here can keep the layer open.
          if (swallow) event.preventDefault()
        },
        children: 'body',
      },
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
  assert.ok(intercepted() === 1, `the hook receives the Escape keydown once (got ${intercepted()})`)
  assert.ok(closeCalls() === 0, `preventDefault in onEscapeKeyDown suppresses the close request (got ${closeCalls()})`)

  // Without preventDefault the same hook stays transparent and the Radix chain closes as before.
  swallow = false
  await act(async () => {
    content.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
  })
  assert.ok(intercepted() === 2, `the hook is invoked for every Escape (got ${intercepted()})`)
  assert.ok(closeCalls() === 1, `an unprevented Escape funnels into onClose exactly once (got ${closeCalls()})`)

  await act(async () => {
    root.unmount()
  })
  container.remove()
})

test('useScreenDrawer: manifest locked and syncs closed->open push, open->switch replace, close replace, hasItem stale guard, and local fallback', { timeout: 60_000 }, async () => {
  assert.ok(
    (PLUGIN_CLIENT_SHARED_EXPORTS as readonly string[]).includes('useScreenDrawer'),
    'PLUGIN_CLIENT_SHARED_EXPORTS must include useScreenDrawer',
  )

  const calls: Array<{ patch: Record<string, string | undefined>; options?: { push?: boolean } }> = []
  let currentParams: Record<string, string> = {}
  let latest: ReturnType<typeof useScreenDrawer> | undefined
  const items = new Set(['a', 'b'])

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  function HostedProbe() {
    const drawer = useScreenDrawer({
      createParam: 'create',
      hasItem: (id) => items.has(id),
    })
    latest = drawer
    return e(
      DetailDrawer,
      {
        ...drawer.drawerProps,
        inline: true,
        title: drawer.creating ? 'Create' : (drawer.itemId ?? 'Closed'),
        children: e('div', null, 'drawer body'),
      },
    )
  }

  const renderHosted = async () => {
    await act(async () => {
      root.render(
        e(
          ScreenParamsContext.Provider,
          {
            value: {
              isSplit: false,
              params: currentParams,
              setParams: (patch, options) => {
                calls.push({ patch, options })
                const next = { ...currentParams }
                for (const [k, v] of Object.entries(patch)) {
                  if (v === undefined) delete next[k]
                  else next[k] = v
                }
                currentParams = next
              },
            },
          },
          e(HostedProbe),
        ),
      )
    })
  }

  try {
    // 1) Initial closed state -> empty item ignored
    await renderHosted()
    assert.equal(latest?.open, false)
    assert.equal(latest?.mode, 'closed')
    assert.ok(container.querySelector('.primary-drawer-content') === null)
    latest!.openItem('')
    assert.equal(calls.length, 0)

    // 2) Closed -> open item pushes history
    latest!.openItem('a', { extra: '1' })
    assert.deepEqual(calls.at(-1), {
      patch: { extra: '1', create: undefined, edit: 'a' },
      options: { push: true },
    })
    await renderHosted()
    assert.equal(latest?.open, true)
    assert.equal(latest?.mode, 'edit')
    assert.equal(latest?.itemId, 'a')
    assert.ok(container.querySelector('.primary-drawer-content') !== null)

    // 3) Open -> switch item replaces (no push option)
    latest!.openItem('b')
    assert.deepEqual(calls.at(-1), {
      patch: { create: undefined, edit: 'b' },
      options: undefined,
    })
    await renderHosted()
    assert.equal(latest?.itemId, 'b')

    // 4) Open -> switch to create replaces
    latest!.openCreate({ tab: 'tiers' })
    assert.deepEqual(calls.at(-1), {
      patch: { tab: 'tiers', edit: undefined, create: '1' },
      options: undefined,
    })
    await renderHosted()
    assert.equal(latest?.open, true)
    assert.equal(latest?.creating, true)
    assert.equal(latest?.mode, 'create')
    assert.equal(latest?.itemId, undefined)

    // 5) Clicking close button triggers drawerProps.onClose without leaking DOM click event or pushing
    const closeBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    assert.ok(closeBtn !== null)
    await act(async () => {
      closeBtn.click()
    })
    assert.deepEqual(calls.at(-1), {
      patch: { edit: undefined, create: undefined },
      options: undefined,
    })
    await renderHosted()
    assert.equal(latest?.open, false)

    // 6) Closed -> openCreate pushes
    latest!.openCreate()
    assert.deepEqual(calls.at(-1), {
      patch: { edit: undefined, create: '1' },
      options: { push: true },
    })
    await renderHosted()
    assert.equal(latest?.open, true)

    // 7) Stale/deleted deep-link param causes hasItem=false -> open=false -> selecting real item still pushes
    currentParams = { edit: 'deleted-id' }
    await renderHosted()
    assert.equal(latest?.itemId, 'deleted-id')
    assert.equal(latest?.open, false, 'missing item keeps drawer closed')
    assert.equal(latest?.mode, 'closed')
    latest!.openItem('a')
    assert.deepEqual(calls.at(-1), {
      patch: { create: undefined, edit: 'a' },
      options: { push: true },
    })

    // 8) Explicit scope override without ScreenParamsContext
    const scopeCalls: Array<{ patch: Record<string, string | undefined>; options?: { push?: boolean } }> = []
    let scopeResult: ReturnType<typeof useScreenDrawer> | undefined
    function ScopeProbe() {
      scopeResult = useScreenDrawer({
        param: 'wf',
        scope: {
          params: {},
          setParams: (patch, options) => scopeCalls.push({ patch, options }),
        },
      })
      return e('div')
    }
    await act(async () => {
      root.render(e(ScopeProbe))
    })
    scopeResult!.openItem('release')
    assert.deepEqual(scopeCalls[0], { patch: { wf: 'release' }, options: { push: true } })

    // 9) Unhosted fallback without ScreenParamsContext or setParams uses local React state
    let localResult: ReturnType<typeof useScreenDrawer> | undefined
    function LocalProbe() {
      localResult = useScreenDrawer({ createParam: 'create' })
      return e('div')
    }
    await act(async () => {
      root.render(e(LocalProbe))
    })
    assert.equal(localResult?.open, false)
    await act(async () => {
      localResult!.openItem('local-1')
    })
    assert.equal(localResult?.open, true)
    assert.equal(localResult?.itemId, 'local-1')
    await act(async () => {
      localResult!.openCreate()
    })
    assert.equal(localResult?.creating, true)
    assert.equal(localResult?.itemId, undefined)
    await act(async () => {
      localResult!.close()
    })
    assert.equal(localResult?.open, false)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})
