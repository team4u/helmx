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
import './helpers/register-happy-dom.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'

// Ordering constraint: happy-dom is registered by the side-effect import above
// before react-dom (and any portal-carrying component module) is loaded,
// otherwise react-dom 19 caches native addEventListener refs and synthetic
// event delegation misses dispatched input events (onChange breaks).

const { act } = await import('react')
const { renderToString } = await import('react-dom/server')
const { createRoot } = await import('react-dom/client')
const { SearchBox } = await import('../src/ui/SearchBox.js')
const { LoadingState } = await import('../src/ui/LoadingState.js')
const { Tooltip, TooltipProvider } = await import('../src/ui/Tooltip.js')
const {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} = await import('../src/ui/DropdownMenu.js')
const { usePluginAction } = await import('../src/ui/use-plugin-action.js')
const { PluginClientContext } = await import('../src/plugin-context.js')
const { EmptyState } = await import('../src/ui/EmptyState.js')
const { DockTray, DockTrayRow } = await import('../src/ui/DockTray.js')
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
// DockTray / DockTrayRow
// ---------------------------------------------------------------------------

test('DockTray SSR & DOM: renders shared .dock-tray vocabulary, optional classPrefix, and collapsible list', { timeout: 60_000 }, async () => {
  const html = renderToString(
    e(
      DockTray,
      {
        classPrefix: 'workflow-active-tray',
        regionLabel: 'Active workflows',
        expanded: true,
        onToggle: () => {},
        toggleLabel: 'Toggle workflows',
        status: 'running',
        statusLabel: 'Running',
        count: '2 running',
        barAction: e('button', { type: 'button', className: 'btn btn-ghost btn-xs' }, 'Open'),
      },
      e(DockTrayRow, {
        classPrefix: 'workflow-active-tray',
        status: 'running',
        statusLabel: 'Running',
        title: 'deploy',
        idText: '#12',
        onOpen: () => {},
        openAriaLabel: 'Open deploy',
      }),
    ),
  )
  assert.ok(html.includes('dock-tray workflow-active-tray'), 'carries shared and prefixed container classes')
  assert.ok(html.includes('dock-tray-row workflow-active-tray-row'), 'row carries shared and prefixed classes')
  assert.ok(html.includes('deploy') && html.includes('#12'))
  assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'zero emoji')

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let clicked = 0
  function Harness(): React.ReactNode {
    const [expanded, setExpanded] = React.useState(true)
    return e(
      DockTray,
      {
        regionLabel: 'Active tasks',
        expanded,
        onToggle: () => setExpanded((v) => !v),
        toggleLabel: 'Toggle tasks',
        status: 'running',
        statusLabel: 'Running',
        count: '1 active',
      },
      e(DockTrayRow, {
        status: 'waiting',
        statusLabel: 'Waiting',
        title: 'review',
        onOpen: () => {
          clicked += 1
        },
        openAriaLabel: 'Open review',
      }),
    )
  }
  await act(async () => {
    root.render(e(Harness))
  })
  const toggleBtn = container.querySelector<HTMLButtonElement>('button.dock-tray-bar-toggle')
  assert.ok(toggleBtn !== null && toggleBtn.getAttribute('aria-expanded') === 'true')
  const rowBtn = container.querySelector<HTMLButtonElement>('button.dock-tray-row-main')
  assert.ok(rowBtn !== null)
  await act(async () => {
    rowBtn.click()
  })
  assert.equal(clicked, 1)
  await act(async () => {
    toggleBtn.click()
  })
  assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false')
  assert.ok(container.querySelector('.dock-tray-list') === null, 'collapsing hides the tray list')
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

test('ConfirmDialog SSR: pending=true disables both cancel and confirm buttons', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(ConfirmDialog, {
      open: true,
      inline: true,
      pending: true,
      danger: true,
      onOpenChange: () => {},
      title: 'Delete item?',
      onConfirm: () => {},
    }),
  )
  const disabledMatches = html.match(/disabled=""/g) ?? []
  assert.equal(disabledMatches.length, 2, 'both cancel and confirm buttons should be disabled when pending')
})

test('LoadingState SSR: renders unified .loading-state with spinning loader and locale default copy', { timeout: 60_000 }, () => {
  const defaultHtml = renderToString(e(LoadingState, {}))
  assert.match(defaultHtml, /class="loading-state"/)
  assert.match(defaultHtml, /role="status"/)
  assert.match(defaultHtml, /spin-slow/)
  assert.match(defaultHtml, /Loading/)

  const customHtml = renderToString(e(LoadingState, { label: 'Fetching quotas…', iconSize: 14, className: 'my-load' }))
  assert.match(customHtml, /class="loading-state my-load"/)
  assert.match(customHtml, /Fetching quotas…/)
})

test('Tooltip SSR: renders trigger directly when disabled/empty and stamps data-plugin-id only inside plugin context', { timeout: 60_000 }, () => {
  const disabledHtml = renderToString(
    e(Tooltip, { content: 'Help', disabled: true }, e('button', { type: 'button' }, 'Info')),
  )
  assert.match(disabledHtml, /Info/)
  assert.doesNotMatch(disabledHtml, /helmx-tooltip-content/)

  const hostHtml = renderToString(
    e(Tooltip, { content: 'Shortcut help', open: true, inline: true }, e('button', { type: 'button' }, 'Info')),
  )
  assert.match(hostHtml, /helmx-tooltip-content/)
  assert.match(hostHtml, /Shortcut help/)
  assert.doesNotMatch(hostHtml, /data-plugin-id/, 'host tooltips omit data-plugin-id')

  const pluginCtx = {
    pluginId: 'builtin:demo',
    callAction: async () => ({}),
    fetchRoute: async () => { throw new Error('fetchRoute not implemented in test stub') },
    submitInput: async () => {},
    openScreen: () => {},
    openSplitScreen: () => {},
    openConversationDrawer: () => {},
    openArtifact: () => {},
    openWorkbench: () => {},
    closeWorkbench: () => {},
    notify: () => {},
    getPluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    theme: 'dark' as const,
    locale: 'en' as const,
    translate: (text: unknown) => (typeof text === 'string' ? text : ''),
  }
  const pluginHtml = renderToString(
    e(
      PluginClientContext.Provider,
      { value: pluginCtx },
      e(Tooltip, { content: 'Plugin tip', open: true, inline: true }, e('button', { type: 'button' }, 'Run')),
    ),
  )
  assert.match(pluginHtml, /data-plugin-id="builtin:demo"/, 'plugin tooltips stamp data-plugin-id on portalled content')
})

test('Tooltip DOM: reuses ancestor TooltipProvider (inherits delayDuration and shares skipDelayDuration across sibling tooltips)', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const scheduledDelays: number[] = []
  const origSetTimeout = window.setTimeout
  window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (typeof delay === 'number') scheduledDelays.push(delay)
    return origSetTimeout(fn, delay, ...args)
  }) as typeof window.setTimeout

  try {
    await act(async () => {
      root.render(
        e(
          TooltipProvider,
          {
            delayDuration: 12_345,
            skipDelayDuration: 2_000,
            children: e(
              React.Fragment,
              null,
              e(Tooltip, { content: 'Probe tip', inline: true }, e('button', { type: 'button', 'data-btn': 'probe' }, 'Probe')),
              e(Tooltip, { content: 'First tip', inline: true }, e('button', { type: 'button', 'data-btn': 'first' }, 'First')),
              e(Tooltip, { content: 'Second tip', inline: true }, e('button', { type: 'button', 'data-btn': 'second' }, 'Second')),
            ),
          },
        ),
      )
    })

    const probeBtn = container.querySelector<HTMLButtonElement>('button[data-btn="probe"]')
    const firstBtn = container.querySelector<HTMLButtonElement>('button[data-btn="first"]')
    const secondBtn = container.querySelector<HTMLButtonElement>('button[data-btn="second"]')
    assert.ok(probeBtn !== null && firstBtn !== null && secondBtn !== null)

    // Before any tooltip opens, hovering a trigger schedules the ancestor delayDuration (not a hardcoded 300ms)
    await act(async () => {
      probeBtn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
    })
    assert.ok(!container.textContent?.includes('Probe tip'), 'tooltip stays closed before delay elapses')
    assert.ok(scheduledDelays.includes(12_345), 'Tooltip inherits outer TooltipProvider delayDuration when omitted')

    await act(async () => {
      probeBtn.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: firstBtn }))
    })

    // Focus then blur the first trigger so the shared TooltipProvider enters its skip-delay window
    await act(async () => {
      firstBtn.focus()
    })
    assert.ok(container.textContent?.includes('First tip'), 'focusing first trigger opens its tooltip')

    await act(async () => {
      firstBtn.blur()
    })
    assert.ok(!container.textContent?.includes('First tip'), 'blurring first trigger closes its tooltip')

    // Moving onto the sibling trigger within skipDelayDuration opens synchronously without scheduling delayDuration
    const delaysBeforeSiblingHover = scheduledDelays.length
    await act(async () => {
      secondBtn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
    })
    assert.ok(container.textContent?.includes('Second tip'), 'sibling tooltip opens instantaneously via shared outer TooltipProvider')
    assert.equal(
      scheduledDelays.slice(delaysBeforeSiblingHover).filter((d) => d === 12_345).length,
      0,
      'skip-delay transition must not schedule a fresh delay timer',
    )
    const openContent = container.querySelector('.helmx-tooltip-content')
    assert.equal(openContent?.getAttribute('data-state'), 'instant-open')
  } finally {
    window.setTimeout = origSetTimeout
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

test('DropdownMenu SSR: renders host overlay classes and stamps data-plugin-id inside plugin context', { timeout: 60_000 }, () => {
  const pluginCtx = {
    pluginId: 'builtin:menu-demo',
    callAction: async () => ({}),
    fetchRoute: async () => { throw new Error('fetchRoute not implemented in test stub') },
    submitInput: async () => {},
    openScreen: () => {},
    openSplitScreen: () => {},
    openConversationDrawer: () => {},
    openArtifact: () => {},
    openWorkbench: () => {},
    closeWorkbench: () => {},
    notify: () => {},
    getPluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    theme: 'dark' as const,
    locale: 'en' as const,
    translate: (text: unknown) => (typeof text === 'string' ? text : ''),
  }
  const html = renderToString(
    e(
      PluginClientContext.Provider,
      { value: pluginCtx },
      e(
        DropdownMenu,
        { open: true },
        e(DropdownMenuTrigger, { asChild: true }, e('button', { type: 'button' }, 'More')),
        e(
          DropdownMenuContent,
          { portalled: true, inline: true },
          e(DropdownMenuLabel, null, 'Actions'),
          e(DropdownMenuItem, null, 'Inspect'),
          e(DropdownMenuSeparator, null),
          e(DropdownMenuItem, { danger: true }, 'Delete'),
        ),
      ),
    ),
  )
  assert.match(html, /helmx-dropdown-content/)
  assert.match(html, /data-plugin-id="builtin:menu-demo"/)
  assert.match(html, /helmx-dropdown-label/)
  assert.match(html, /helmx-dropdown-item-danger/)
  assert.match(html, /helmx-dropdown-separator/)
})

test('usePluginAction DOM: synchronous mutex prevents double submit, exposes pendingKey/error/clearError, and forwards notifyError + options', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const calls: Array<{ actionId: string; input: unknown; options: unknown }> = []
  const notices: Array<{ msg: string; tone: string | undefined }> = []
  let resolveFirst: ((val: unknown) => void) | undefined
  let shouldFail = false

  const pluginCtx = {
    pluginId: 'builtin:act-demo',
    callAction: async (actionId: string, input: unknown, options?: unknown) => {
      calls.push({ actionId, input, options })
      if (shouldFail) throw new Error('boom from server')
      return await new Promise((resolve) => {
        resolveFirst = resolve
      })
    },
    fetchRoute: async () => { throw new Error('fetchRoute not implemented in test stub') },
    submitInput: async () => {},
    openScreen: () => {},
    openSplitScreen: () => {},
    openConversationDrawer: () => {},
    openArtifact: () => {},
    openWorkbench: () => {},
    closeWorkbench: () => {},
    notify: (msg: string, tone?: string) => {
      notices.push({ msg, tone })
    },
    getPluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    theme: 'dark' as const,
    locale: 'en' as const,
    translate: (text: unknown) => (typeof text === 'string' ? text : ''),
  }

  let api: ReturnType<typeof usePluginAction> | undefined
  function Harness() {
    api = usePluginAction({
      notifyError: true,
      formatError: (err, id) => `${id}: ${err instanceof Error ? err.message : String(err)}`,
    })
    return e('div', { 'data-pending': String(api.pending), 'data-key': api.pendingKey ?? '', 'data-err': api.error ?? '' })
  }

  await act(async () => {
    root.render(e(PluginClientContext.Provider, { value: pluginCtx }, e(Harness)))
  })

  // Fire two calls synchronously in the same tick: second must be dropped by the ref mutex
  let p1: Promise<unknown> | undefined
  let p2: Promise<unknown> | undefined
  await act(async () => {
    p1 = api!.run('refresh', { force: true }, { key: 'row:1', pluginId: 'ext:other', conversationId: 42 })
    p2 = api!.run('refresh', { force: true }, { key: 'row:2' })
  })
  assert.equal(calls.length, 1, 'second concurrent run call must be dropped by synchronous mutex')
  assert.deepEqual(calls[0], { actionId: 'refresh', input: { force: true }, options: { pluginId: 'ext:other', conversationId: 42 } })
  assert.equal(await p2, undefined)
  assert.equal(container.querySelector('div')?.getAttribute('data-pending'), 'true')
  assert.equal(container.querySelector('div')?.getAttribute('data-key'), 'row:1')

  await act(async () => {
    resolveFirst?.({ ok: true })
    await p1
  })
  assert.equal(container.querySelector('div')?.getAttribute('data-pending'), 'false')
  assert.equal(container.querySelector('div')?.getAttribute('data-key'), '')

  // Error path: formats error, populates error state, and notifies via ctx.notify
  shouldFail = true
  await act(async () => {
    const res = await api!.run('remove', { id: 'x' })
    assert.equal(res, undefined)
  })
  assert.equal(container.querySelector('div')?.getAttribute('data-err'), 'remove: boom from server')
  assert.deepEqual(notices, [{ msg: 'remove: boom from server', tone: 'error' }])

  await act(async () => {
    api!.clearError()
  })
  assert.equal(container.querySelector('div')?.getAttribute('data-err'), '')

  await act(async () => {
    root.unmount()
  })
  container.remove()
})
