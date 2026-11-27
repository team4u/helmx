/**
 * useScreenDrawer (URL-hash-backed DetailDrawer navigation hook) SDK tests.
 */
import './helpers/register-happy-dom.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { PLUGIN_CLIENT_SHARED_EXPORTS } = await import('@helmx/protocol')
const { DetailDrawer } = await import('@helmx/ui')
const { ScreenParamsContext, useScreenDrawer } = await import('../src/index.js')

const e = React.createElement

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
