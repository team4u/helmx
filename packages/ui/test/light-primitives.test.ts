/**
 * Shared interactive UI primitive tests (SearchBox / EmptyState / Tabs /
 * DockTray / ConfirmDialog / LoadingState / Tooltip / DropdownMenu /
 * MultiSelect / Button / SelectCard / Field / Switch / Checkbox / Screen / ListRow).
 */
import './helpers/register-happy-dom.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'

const { act } = await import('react')
const { renderToString } = await import('react-dom/server')
const { createRoot } = await import('react-dom/client')
const { SearchBox } = await import('../src/primitives/SearchBox.js')
const { ScreenToolbar } = await import('../src/primitives.js')
const { LoadingState } = await import('../src/primitives/LoadingState.js')
const { Tooltip, TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent } = await import('../src/primitives/Tooltip.js')
const { Popover, PopoverTrigger, PopoverContent } = await import('../src/primitives/Popover.js')
const { Dialog, DialogContent, DialogTitle, DialogClose } = await import('../src/primitives/Dialog.js')
const { Button, IconButton } = await import('../src/primitives/Button.js')
const { SelectCard } = await import('../src/primitives/Card.js')
const { Switch } = await import('../src/primitives/Switch.js')
const { Checkbox } = await import('../src/primitives/Checkbox.js')
const { MonoId } = await import('../src/primitives/MonoId.js')
const { Field } = await import('../src/primitives/Field.js')
const { Input } = await import('../src/primitives/Input.js')
const {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} = await import('../src/primitives/DropdownMenu.js')
const { UiScope } = await import('../src/UiScope.js')
const { EmptyState } = await import('../src/primitives/EmptyState.js')
const { Tabs, TabsList, TabsTrigger } = await import('../src/primitives/Tabs.js')
const { DockTray, DockTrayRow } = await import('../src/primitives/DockTray.js')
const { ConfirmDialog } = await import('../src/primitives/AlertDialog.js')

const e = React.createElement

test('SearchBox SSR: compact default container, type="text", no clear button when empty', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(SearchBox, { value: '', onChange: () => {}, placeholder: 'Search models', ariaLabel: 'Search models' }),
  )
  assert.ok(html.includes('class="search-box"'))
  assert.ok(html.includes('type="text"'))
  assert.ok(html.includes('placeholder="Search models"'))
  assert.ok(html.includes('aria-label="Search models"'))
  assert.ok(!html.includes('<button'))
})

test('SearchBox SSR: toolbar variant renders search-box-toolbar and standard search-box-clear', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(SearchBox, { variant: 'toolbar', value: 'magpie', onChange: () => {}, clearLabel: 'Clear search' }),
  )
  assert.ok(html.includes('class="search-box search-box-toolbar"'))
  assert.ok(html.includes('class="btn btn-ghost btn-sm search-box-clear"'))
  assert.ok(html.includes('aria-label="Clear search"'))
  assert.ok(html.includes('value="magpie"'))

  const extended = renderToString(
    e(SearchBox, { variant: 'toolbar', className: 'search-box extra-filter-box', value: '', onChange: () => {} }),
  )
  assert.ok(extended.includes('class="search-box search-box-toolbar extra-filter-box"'))

  const custom = renderToString(
    e(SearchBox, {
      value: 'magpie',
      onChange: () => {},
      className: 'sidebar-search',
      inputClassName: 'sidebar-search-input',
      clearButtonClassName: 'btn btn-ghost btn-icon-xs sidebar-search-clear',
    }),
  )
  assert.ok(custom.includes('class="sidebar-search"'))
  assert.ok(custom.includes('sidebar-search-input'))
  assert.ok(custom.includes('sidebar-search-clear'))

  const compactToolbar = renderToString(
    e(SearchBox, { variant: 'toolbar', size: 'sm', value: '', onChange: () => {}, placeholder: 'Filter...' }),
  )
  assert.ok(compactToolbar.includes('class="search-box search-box-toolbar search-box-sm"'))
  assert.ok(compactToolbar.includes('width="13"'))
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
  assert.ok(input !== null)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    const tracker = (input as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
    const prev = tracker?.getValue() ?? ''
    setter.call(input, 'abc')
    tracker?.setValue(prev)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  assert.ok(emitted.includes('abc'))

  const clear = container.querySelector<HTMLButtonElement>('button[aria-label]')
  assert.ok(clear !== null)
  await act(async () => {
    clear.click()
  })
  assert.ok(emitted[emitted.length - 1] === '')

  await act(async () => {
    root.unmount()
  })
  container.remove()
})

test('SearchBox SSR: clearable=false hides the clear button; style lands on the container', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(SearchBox, { value: 'query', onChange: () => {}, clearable: false, style: { flex: '1 1 0%' } }),
  )
  assert.ok(!html.includes('<button'))
  assert.ok(/style="[^"]*flex[^"]*"/.test(html))

  const cleared = renderToString(e(SearchBox, { value: 'x', onChange: () => {}, onCleared: () => {} }))
  assert.ok(cleared.includes('<button'))

  const optInEscape = renderToString(
    e(SearchBox, { value: 'hello', onChange: () => {}, clearOnEscape: true, className: 'search-box overview-search-box' }),
  )
  assert.ok(optInEscape.includes('class="search-box overview-search-box"'))

  const screenToolbarSsr = renderToString(
    e(ScreenToolbar, { label: 'Library toolbar' }, e(SearchBox, { value: 'hello', onChange: () => {} })),
  )
  assert.ok(screenToolbarSsr.includes('screen-toolbar') && screenToolbarSsr.includes('search-box'))
})

test('SearchBox DOM: toolbar, ScreenToolbar, and opt-in clearOnEscape clear non-empty query then blur on Escape while forwarding inputRef', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const emitted: string[] = []
  let clearedCalls = 0
  let windowEscapes = 0
  const forwardedRef: { current: HTMLInputElement | null } = { current: null }
  const callbackRef: { current: HTMLInputElement | null } = { current: null }
  const onWindowKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') windowEscapes += 1
  }
  window.addEventListener('keydown', onWindowKeyDown)

  try {
    function ControlledToolbar({ initial, blockInCaller = false }: { initial: string; blockInCaller?: boolean }) {
      const [val, setVal] = React.useState(initial)
      return e(SearchBox, {
        variant: 'toolbar',
        value: val,
        ariaLabel: 'Controlled toolbar search',
        inputRef: forwardedRef,
        onChange: (next) => {
          emitted.push(next)
          setVal(next)
        },
        onCleared: () => {
          clearedCalls += 1
        },
        ...(blockInCaller
          ? {
              onKeyDown: (ev) => {
                if (ev.key === 'Escape') ev.preventDefault()
              },
            }
          : {}),
      })
    }

    await act(async () => {
      root.render(e(ControlledToolbar, { initial: 'hello' }))
    })
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Controlled toolbar search"]')!
    assert.ok(forwardedRef.current === input)
    input.focus()
    assert.ok(document.activeElement === input)

    const imeEsc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true })
    await act(async () => {
      input.dispatchEvent(imeEsc)
    })
    assert.equal(input.value, 'hello')
    assert.equal(windowEscapes, 1)
    windowEscapes = 0

    const firstEsc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => {
      input.dispatchEvent(firstEsc)
    })
    assert.equal(firstEsc.defaultPrevented, true)
    assert.equal(input.value, '')
    assert.deepEqual(emitted, [''])
    assert.equal(clearedCalls, 1)
    assert.ok(document.activeElement === input)

    const secondEsc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => {
      input.dispatchEvent(secondEsc)
    })
    assert.equal(secondEsc.defaultPrevented, true)
    assert.ok(document.activeElement !== input)
    assert.equal(windowEscapes, 0)

    emitted.length = 0
    clearedCalls = 0
    await act(async () => {
      root.render(e(ControlledToolbar, { key: 'caller-handled', initial: 'keep', blockInCaller: true }))
    })
    const callerInput = container.querySelector<HTMLInputElement>('input[aria-label="Controlled toolbar search"]')!
    callerInput.focus()
    await act(async () => {
      callerInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.equal(callerInput.value, 'keep')
    assert.equal(clearedCalls, 0)

    let defaultCleared = false
    await act(async () => {
      root.render(
        e(SearchBox, {
          value: 'compact',
          ariaLabel: 'Compact default search',
          inputRef: (node) => {
            callbackRef.current = node
          },
          onChange: () => {
            defaultCleared = true
          },
        }),
      )
    })
    const compactInput = container.querySelector<HTMLInputElement>('input[aria-label="Compact default search"]')!
    assert.ok(callbackRef.current === compactInput)
    compactInput.focus()
    const compactEsc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => {
      compactInput.dispatchEvent(compactEsc)
    })
    assert.equal(defaultCleared, false)
    assert.equal(compactEsc.defaultPrevented, false)
    assert.ok(document.activeElement === compactInput)

    let optInValue = 'alpha'
    let screenValue = 'flow'
    await act(async () => {
      root.render(
        e(
          'div',
          null,
          e(SearchBox, {
            className: 'search-box overview-search-box',
            value: optInValue,
            onChange: (next) => {
              optInValue = next
            },
            ariaLabel: 'Opt-in clear search',
            clearOnEscape: true,
          }),
          e(
            ScreenToolbar,
            { label: 'Workflow search' },
            e(SearchBox, {
              value: screenValue,
              onChange: (next) => {
                screenValue = next
              },
              ariaLabel: 'Screen toolbar search',
            }),
          ),
        ),
      )
    })
    const optInInput = container.querySelector<HTMLInputElement>('input[aria-label="Opt-in clear search"]')!
    const screenInput = container.querySelector<HTMLInputElement>('input[aria-label="Screen toolbar search"]')!
    assert.ok(optInInput !== null && screenInput !== null)
    optInInput.focus()
    await act(async () => {
      optInInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.equal(optInValue, '')
    screenInput.focus()
    await act(async () => {
      screenInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.equal(screenValue, '')
  } finally {
    window.removeEventListener('keydown', onWindowKeyDown)
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

test('EmptyState SSR: host vocabulary with optional icon/title/hint and compact density', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(
      EmptyState,
      { title: 'No workflows yet', hint: 'Save one from a conversation to see it here', compact: true },
      'extra body',
    ),
  )
  assert.ok(html.includes('empty-state empty-state-compact'))
  assert.ok(html.includes('empty-state-title'))
  assert.ok(html.includes('empty-state-hint'))
  assert.ok(html.includes('No workflows yet'))
  assert.ok(html.includes('extra body'))

  const plain = renderToString(e(EmptyState, null, 'nothing selected'))
  assert.ok(plain.includes('class="empty-state"'))
  assert.ok(!plain.includes('empty-state-icon'))
  assert.ok(plain.includes('nothing selected'))
})

test('EmptyState SSR: string icon renders HelmxIcon, prominent stage density, hintSubtle, and action slot', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(EmptyState, {
      prominent: true,
      icon: 'search',
      iconSize: 22,
      title: 'No matching models',
      hint: 'Try adjusting your query',
      hintSubtle: true,
      action: e(Button, { size: 'sm', onClick: () => {} }, 'Reset filters'),
    }),
  )
  assert.ok(html.includes('class="empty-state empty-state-prominent"'))
  assert.ok(html.includes('class="empty-state-icon"'))
  assert.ok(html.includes('<svg'))
  assert.ok(html.includes('width="22"'))
  assert.ok(!html.includes('>search<'))
  assert.ok(html.includes('class="empty-state-hint text-subtle"'))
  assert.ok(html.includes('class="empty-state-action"'))
  assert.ok(html.includes('Reset filters'))

  const defaultProminentIcon = renderToString(e(EmptyState, { prominent: true, icon: 'layers', title: 'No tiers' }))
  assert.ok(defaultProminentIcon.includes('width="28"'))
  assert.ok(!defaultProminentIcon.includes('empty-state-action'))
})

test('Tabs SSR: variant="pills" renders helmx-tabs-pills, tabs-pills, tabs-pill, and active ARIA state', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(
      Tabs,
      { value: 'enabled', variant: 'pills' },
      e(
        TabsList,
        { 'aria-label': 'Filter by status' },
        e(TabsTrigger, { value: 'all' }, 'All'),
        e(TabsTrigger, { value: 'enabled' }, 'Enabled'),
      ),
    ),
  )
  assert.ok(html.includes('helmx-tabs helmx-tabs-pills'))
  assert.ok(html.includes('class="tabs-pills"'))
  assert.ok(html.includes('role="tablist"'))
  assert.ok(html.includes('aria-label="Filter by status"'))
  assert.ok(html.includes('class="tabs-pill"'))
  assert.ok(html.includes('class="tabs-pill is-active"'))
  assert.ok(html.includes('data-state="active"'))
  assert.ok(html.includes('aria-selected="true"'))
  assert.ok(html.includes('data-state="inactive"'))
  assert.ok(html.includes('aria-selected="false"'))
})

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
        live: e('span', { className: 'dock-tray-row-live' }, 'running tests'),
        elapsed: '12s',
        onOpen: () => {},
        openAriaLabel: 'Open deploy',
      }),
    ),
  )
  assert.ok(html.includes('dock-tray workflow-active-tray'))
  assert.ok(html.includes('dock-tray-row workflow-active-tray-row'))
  assert.ok(html.includes('deploy') && html.includes('#12'))
  assert.ok(html.includes('12s') && html.indexOf('running tests') < html.indexOf('12s'))
  assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u)

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
        live: e('span', { className: 'dock-tray-row-live' }, 'checking diff'),
        elapsed: e('span', { className: 'dock-tray-elapsed custom-elapsed' }, '45s'),
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
  const rowChildren = [...rowBtn.children]
  const liveIdx = rowChildren.findIndex((el) => el.classList.contains('dock-tray-row-live'))
  const elapsedIdx = rowChildren.findIndex((el) => el.classList.contains('custom-elapsed'))
  assert.ok(liveIdx >= 0 && elapsedIdx > liveIdx)
  await act(async () => {
    rowBtn.click()
  })
  assert.equal(clicked, 1)
  await act(async () => {
    toggleBtn.click()
  })
  assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false')
  assert.ok(container.querySelector('.dock-tray-list') === null)
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

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
  assert.ok(html.includes('role="alertdialog"'))
  assert.ok(html.includes('modal-backdrop') && html.includes('modal-header') && html.includes('modal-footer'))
  assert.ok(html.includes('Delete workflow?'))
  assert.ok(html.includes('btn-danger'))
  assert.ok(html.includes('btn-primary') === false)
  assert.ok(html.includes('>Delete<'))
  assert.ok(html.includes('>Cancel<'))
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
  assert.ok(html.includes('btn-primary'))
  assert.ok(!html.includes('modal-body') || html.includes('Archive profile?'))

  const closed = renderToString(
    e(ConfirmDialog, { open: false, onOpenChange: () => {}, title: 'Hidden', onConfirm: () => {} }),
  )
  assert.ok(closed === '')
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
  assert.ok(buttons.length === 2)
  await act(async () => {
    buttons[0]!.click()
  })
  await act(async () => {
    buttons[1]!.click()
  })
  assert.ok(events.includes('cancel'))
  assert.ok(events.includes('confirm'))
  assert.ok(events.includes('open:false'))

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
  assert.equal(disabledMatches.length, 2)
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

test('Tooltip SSR: renders trigger directly when disabled/empty and stamps data-plugin-id only inside UiScope', { timeout: 60_000 }, () => {
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
  assert.doesNotMatch(hostHtml, /data-plugin-id/)

  const scopedHtml = renderToString(
    e(
      UiScope,
      { scopeId: 'builtin:demo' },
      e(Tooltip, { content: 'Plugin tip', open: true, inline: true }, e('button', { type: 'button' }, 'Run')),
    ),
  )
  assert.match(scopedHtml, /data-plugin-id="builtin:demo"/)
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

    await act(async () => {
      probeBtn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
    })
    assert.ok(!container.textContent?.includes('Probe tip'))
    assert.ok(scheduledDelays.includes(12_345))

    await act(async () => {
      probeBtn.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: firstBtn }))
    })

    await act(async () => {
      firstBtn.focus()
    })
    assert.ok(container.textContent?.includes('First tip'))

    await act(async () => {
      firstBtn.blur()
    })
    assert.ok(!container.textContent?.includes('First tip'))

    const delaysBeforeSiblingHover = scheduledDelays.length
    await act(async () => {
      secondBtn.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
    })
    assert.ok(container.textContent?.includes('Second tip'))
    assert.equal(scheduledDelays.slice(delaysBeforeSiblingHover).filter((d) => d === 12_345).length, 0)
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

test('Tooltip DOM: strips native title when active to prevent double tooltips and preserves title when disabled', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        e(
          React.Fragment,
          null,
          e(
            Tooltip,
            { content: 'Rich tooltip', inline: true },
            e('button', { type: 'button', 'data-btn': 'active', title: 'Native duplicate' }, 'Active'),
          ),
          e(
            Tooltip,
            { content: 'Rich tooltip', disabled: true, inline: true },
            e('button', { type: 'button', 'data-btn': 'disabled', title: 'Native fallback' }, 'Disabled'),
          ),
        ),
      )
    })
    const activeBtn = container.querySelector<HTMLButtonElement>('button[data-btn="active"]')
    const disabledBtn = container.querySelector<HTMLButtonElement>('button[data-btn="disabled"]')
    assert.ok(activeBtn !== null && disabledBtn !== null)
    assert.equal(activeBtn.getAttribute('title'), null)
    assert.equal(disabledBtn.getAttribute('title'), 'Native fallback')
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

test('DropdownMenu SSR: renders host overlay classes and stamps data-plugin-id inside UiScope', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(
      UiScope,
      { scopeId: 'builtin:menu-demo' },
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

test('MultiSelect DOM: exposes aria-activedescendant, aria-controls, and stable option IDs during keyboard navigation', { timeout: 60_000 }, async () => {
  const { MultiSelect } = await import('../src/primitives/Select.js')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const options = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta', disabled: true },
    { value: 'c', label: 'Charlie' },
    { value: 'd', label: 'Delta' },
    { value: 'e', label: 'Echo' },
  ]

  try {
    await act(async () => {
      root.render(
        e(MultiSelect, { open: true, inline: true, value: [], options, 'aria-label': 'Pick items' }),
      )
    })

    const trigger = container.querySelector<HTMLButtonElement>('.helmx-select-trigger')
    const combobox = container.querySelector<HTMLInputElement>('.helmx-select-search input[role="combobox"]')
    const listbox = container.querySelector<HTMLElement>('[role="listbox"]')
    const viewport = container.querySelector<HTMLElement>('.helmx-select-viewport')
    assert.ok(trigger !== null && combobox !== null && listbox !== null && viewport !== null)
    assert.ok(listbox.id.length > 0)
    assert.equal(trigger.getAttribute('aria-controls'), listbox.id)
    assert.equal(combobox.getAttribute('aria-controls'), listbox.id)
    assert.equal(listbox.getAttribute('aria-activedescendant'), null)
    assert.equal(combobox.getAttribute('aria-activedescendant'), null)

    await act(async () => {
      viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    const firstOpt = container.querySelector<HTMLElement>('[role="option"][data-highlighted]')
    assert.ok(firstOpt !== null && firstOpt.textContent?.includes('Alpha'))
    assert.equal(listbox.getAttribute('aria-activedescendant'), firstOpt.id)
    assert.equal(combobox.getAttribute('aria-activedescendant'), firstOpt.id)
    assert.ok(document.getElementById(firstOpt.id) === firstOpt)

    await act(async () => {
      viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    const charlieOpt = container.querySelector<HTMLElement>('[role="option"][data-highlighted]')
    assert.ok(charlieOpt !== null && charlieOpt.textContent?.includes('Charlie'))
    assert.equal(listbox.getAttribute('aria-activedescendant'), charlieOpt.id)
    assert.equal(combobox.getAttribute('aria-activedescendant'), charlieOpt.id)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

test('Button and IconButton: forwardRef and event merging work inside Radix PopoverTrigger, DialogClose, and TooltipTrigger asChild', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let popOpen = false
  let dialogOpen = true
  let closeClicked = 0
  const tooltipBtnRef = React.createRef<HTMLButtonElement>()

  try {
    const render = async () => {
      await act(async () => {
        root.render(
          e(
            TooltipProvider,
            {
              delayDuration: 0,
              children: e(
                'div',
                null,
                e(
                  Popover,
                  { open: popOpen, onOpenChange: (next) => { popOpen = next } },
                  e(PopoverTrigger, { asChild: true }, e(Button, { variant: 'secondary', size: 'sm' }, 'Open menu')),
                  e(PopoverContent, { portalled: false }, e('div', { 'data-testid': 'pop-body' }, 'Menu body')),
                ),
                e(
                  Dialog,
                  { open: dialogOpen, onOpenChange: (next) => { dialogOpen = next }, inline: true },
                  e(
                    DialogContent,
                    null,
                    e(DialogTitle, null, 'Confirm'),
                    e(
                      DialogClose,
                      { asChild: true },
                      e(IconButton, {
                        icon: 'x',
                        label: 'Close modal',
                        onClick: () => { closeClicked++ },
                      }),
                    ),
                  ),
                ),
                e(
                  TooltipRoot,
                  { open: true },
                  e(
                    TooltipTrigger,
                    { asChild: true },
                    e(Button, { ref: tooltipBtnRef, variant: 'ghost', size: 'xs' }, 'Hint target'),
                  ),
                  e(TooltipContent, null, 'Helpful tip'),
                ),
              ),
            },
          ),
        )
      })
    }

    await render()
    assert.ok(tooltipBtnRef.current instanceof HTMLButtonElement)

    const popTrigger = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Open menu'))
    assert.ok(popTrigger !== undefined)
    await act(async () => {
      popTrigger.click()
    })
    assert.equal(popOpen, true)

    const closeBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Close modal"]')
    assert.ok(closeBtn !== null)
    await act(async () => {
      closeBtn.click()
    })
    assert.equal(closeClicked, 1)
    assert.equal(dialogOpen, false)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

test('Button variant="inline" and IconButton active: inline compact icon sizing and aria-pressed / is-active contract', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        e(
          'div',
          null,
          e(Button, { variant: 'inline', icon: 'chevron-down', id: 'inline-default' }, 'Expand'),
          e(Button, { variant: 'inline', icon: 'download', pending: true, id: 'inline-pending' }, 'Loading'),
          e(Button, { variant: 'inline', size: 'sm', icon: 'chevron-up', id: 'inline-sm' }, 'Collapse'),
          e(IconButton, { icon: 'list-filter', label: 'Action only', id: 'icon-plain' }),
          e(IconButton, { icon: 'list-filter', label: 'Filter off', active: false, id: 'icon-off' }),
          e(IconButton, { icon: 'list-filter', label: 'Filter on', size: 'xs', active: true, id: 'icon-on' }),
          e(IconButton, { icon: 'check-square', label: 'Mixed toggle', active: true, 'aria-pressed': 'mixed', id: 'icon-mixed' }),
          e(IconButton, { icon: 'bell', label: 'Explicit false', active: true, 'aria-pressed': false, id: 'icon-explicit-false' }),
        ),
      )
    })

    const inlineDefault = container.querySelector<HTMLButtonElement>('#inline-default')!
    assert.equal(inlineDefault.className, 'btn btn-inline')
    assert.equal(inlineDefault.querySelector('svg')?.getAttribute('width'), '11')
    assert.equal(inlineDefault.textContent, 'Expand')

    const inlinePending = container.querySelector<HTMLButtonElement>('#inline-pending')!
    assert.equal(inlinePending.className, 'btn btn-inline')
    assert.equal(inlinePending.disabled, true)
    assert.equal(inlinePending.getAttribute('aria-busy'), 'true')
    assert.equal(inlinePending.querySelector('svg')?.getAttribute('width'), '11')
    assert.ok(inlinePending.querySelector('svg')?.getAttribute('class')?.includes('spin-slow'))

    const inlineSm = container.querySelector<HTMLButtonElement>('#inline-sm')!
    assert.equal(inlineSm.className, 'btn btn-inline btn-sm')
    assert.equal(inlineSm.querySelector('svg')?.getAttribute('width'), '13')

    const iconPlain = container.querySelector<HTMLButtonElement>('#icon-plain')!
    assert.equal(iconPlain.hasAttribute('aria-pressed'), false)
    assert.equal(iconPlain.classList.contains('is-active'), false)

    const iconOff = container.querySelector<HTMLButtonElement>('#icon-off')!
    assert.equal(iconOff.getAttribute('aria-pressed'), 'false')
    assert.equal(iconOff.classList.contains('is-active'), false)

    const iconOn = container.querySelector<HTMLButtonElement>('#icon-on')!
    assert.equal(iconOn.getAttribute('aria-pressed'), 'true')
    assert.equal(iconOn.classList.contains('is-active'), true)
    assert.equal(iconOn.className, 'btn btn-ghost btn-icon-xs is-active')

    const iconMixed = container.querySelector<HTMLButtonElement>('#icon-mixed')!
    assert.equal(iconMixed.getAttribute('aria-pressed'), 'mixed')
    assert.equal(iconMixed.classList.contains('is-active'), true)

    const iconExplicitFalse = container.querySelector<HTMLButtonElement>('#icon-explicit-false')!
    assert.equal(iconExplicitFalse.getAttribute('aria-pressed'), 'false')
    assert.equal(iconExplicitFalse.classList.contains('is-active'), true)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

test('SelectCard: card body and trigger fire onSelect once while sibling actions, interactive children, and disabled state remain isolated', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let selects = 0
  let toggled = 0
  let checkboxToggled = 0

  try {
    await act(async () => {
      root.render(
        e(
          'div',
          null,
          e('p', { className: 'outside-note' }, 'External selected note'),
          e(
            SelectCard,
            {
              title: 'Connector A',
              subtitle: 'Online',
              selected: false,
              onSelect: () => { selects++ },
              actions: e(Switch, {
                checked: true,
                onChange: () => { toggled++ },
                label: 'Active',
                'aria-label': 'Toggle Connector A',
              }),
              footer: e('span', { className: 'footer-meta' }, 'Updated just now'),
            },
            e('div', { className: 'body-text' }, 'Card summary'),
            e(Checkbox, {
              checked: false,
              onChange: () => { checkboxToggled++ },
              label: 'Enable sync',
            }),
            e(MonoId, { value: 'conn_abc123' }),
          ),
          e(SelectCard, {
            title: 'Disabled Card',
            disabled: true,
            onSelect: () => { selects += 100 },
          }),
        ),
      )
    })

    const articles = container.querySelectorAll<HTMLElement>('article.helmx-select-card')
    assert.equal(articles.length, 2)
    const activeCard = articles[0]!
    const disabledCard = articles[1]!

    const trigger = activeCard.querySelector<HTMLButtonElement>('button.helmx-select-card-trigger')
    assert.ok(trigger !== null)
    await act(async () => {
      trigger.click()
    })
    assert.equal(selects, 1)

    const bodyText = activeCard.querySelector<HTMLElement>('.body-text')
    const footerMeta = activeCard.querySelector<HTMLElement>('.footer-meta')
    assert.ok(bodyText !== null && footerMeta !== null)
    await act(async () => {
      bodyText.click()
      footerMeta.click()
    })
    assert.equal(selects, 3)

    const switchBtn = activeCard.querySelector<HTMLButtonElement>('[role="switch"]')
    const switchLabel = activeCard.querySelector<HTMLLabelElement>('label.helmx-switch-label')
    assert.ok(switchBtn !== null && switchLabel !== null)
    assert.ok(!switchLabel.contains(switchBtn))
    assert.equal(switchLabel.getAttribute('for'), switchBtn.id)
    await act(async () => {
      switchBtn.click()
      switchLabel.click()
    })
    assert.equal(toggled, 2)
    assert.equal(selects, 3)

    const copyBtn = activeCard.querySelector<HTMLButtonElement>('.helmx-mono-id-copy')
    assert.ok(copyBtn !== null)
    await act(async () => {
      copyBtn.click()
    })
    assert.equal(selects, 3)

    const checkboxLabel = activeCard.querySelector<HTMLLabelElement>('label.helmx-checkbox-label')
    const checkboxBtn = activeCard.querySelector<HTMLButtonElement>('[role="checkbox"]')
    assert.ok(checkboxLabel !== null && checkboxBtn !== null)
    assert.ok(!checkboxLabel.contains(checkboxBtn))
    assert.equal(checkboxLabel.getAttribute('for'), checkboxBtn.id)
    await act(async () => {
      checkboxLabel.click()
    })
    assert.equal(checkboxToggled, 1)
    assert.equal(selects, 3)

    const outsideNote = container.querySelector<HTMLElement>('.outside-note')
    assert.ok(outsideNote !== null && outsideNote.firstChild !== null && bodyText.firstChild !== null)
    const selection = window.getSelection()
    assert.ok(selection !== null)
    const outsideRange = document.createRange()
    outsideRange.selectNodeContents(outsideNote.firstChild)
    selection.removeAllRanges()
    selection.addRange(outsideRange)
    await act(async () => {
      bodyText.click()
    })
    assert.equal(selects, 4)

    const insideRange = document.createRange()
    insideRange.selectNodeContents(bodyText.firstChild)
    selection.removeAllRanges()
    selection.addRange(insideRange)
    await act(async () => {
      bodyText.click()
    })
    assert.equal(selects, 4)
    selection.removeAllRanges()

    const disabledTrigger = disabledCard.querySelector<HTMLButtonElement>('button.helmx-select-card-trigger')
    assert.ok(disabledTrigger !== null && disabledTrigger.disabled === true)
    await act(async () => {
      disabledCard.click()
      disabledTrigger.click()
    })
    assert.equal(selects, 4)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

test('Field: label htmlFor resolves to the exact nested Input DOM element', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        e(
          Field,
          { label: 'Webhook URL', hint: 'HTTPS endpoint' },
          e(Input, { placeholder: 'https://example.com/hook' }),
        ),
      )
    })
    const label = container.querySelector<HTMLLabelElement>('label.helmx-field-label')
    const input = container.querySelector<HTMLInputElement>('input.input')
    assert.ok(label !== null && input !== null)
    assert.ok(document.getElementById(label.htmlFor) === input)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

test('Switch / Checkbox: Space and Enter toggle once with preventDefault, other keys pass through, disabled blocks click and keys, and a string label backs aria-label', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const switchChanges: boolean[] = []
  const checkboxChanges: boolean[] = []
  const disabledChanges: boolean[] = []

  try {
    await act(async () => {
      root.render(
        e(
          'div',
          null,
          e(Switch, { checked: false, onChange: (v: boolean) => { switchChanges.push(v) }, label: 'Active' }),
          e(Checkbox, { checked: true, onChange: (v: boolean) => { checkboxChanges.push(v) }, 'aria-label': 'Pick' }),
          e(Switch, { checked: false, disabled: true, onChange: (v: boolean) => { disabledChanges.push(v) } }),
          e(Checkbox, { checked: false, disabled: true, onChange: (v: boolean) => { disabledChanges.push(v) } }),
        ),
      )
    })

    const [switchBtn, checkboxBtn, disabledSwitchBtn, disabledCheckboxBtn] = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="switch"], [role="checkbox"]'),
    ]
    assert.ok(switchBtn !== undefined && checkboxBtn !== undefined)
    assert.ok(disabledSwitchBtn !== undefined && disabledCheckboxBtn !== undefined)
    assert.equal(switchBtn.getAttribute('aria-label'), 'Active')
    assert.equal(checkboxBtn.getAttribute('aria-label'), 'Pick')

    const press = async (target: HTMLElement, key: string): Promise<boolean> => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      await act(async () => {
        target.dispatchEvent(event)
      })
      return event.defaultPrevented
    }

    assert.equal(await press(switchBtn, ' '), true)
    assert.equal(await press(switchBtn, 'Enter'), true)
    assert.equal(await press(switchBtn, 'a'), false)
    assert.equal(await press(checkboxBtn, 'Enter'), true)
    assert.deepEqual(switchChanges, [true, true])
    assert.deepEqual(checkboxChanges, [false])

    await act(async () => {
      switchBtn.click()
      checkboxBtn.click()
      disabledSwitchBtn.click()
      disabledCheckboxBtn.click()
    })
    await press(disabledSwitchBtn, ' ')
    await press(disabledCheckboxBtn, 'Enter')
    assert.deepEqual(switchChanges, [true, true, true])
    assert.deepEqual(checkboxChanges, [false, false])
    assert.deepEqual(disabledChanges, [])
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

test('Screen DOM: hosted with a header actions slot portals actions into the slot (zero inline duplicate); without a slot actions stay inline', { timeout: 60_000 }, async () => {
  const { Screen } = await import('../src/primitives.js')
  const { ScreenHostContext } = await import('../src/screen-host.js')
  const slot = document.createElement('div')
  document.body.appendChild(slot)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const clicks: string[] = []
  const actions = e('button', { type: 'button', onClick: () => clicks.push('refresh') }, 'Refresh')
  try {
    await act(async () => {
      root.render(
        e(ScreenHostContext.Provider, { value: { hosted: true, headerActionsSlot: slot } },
          e(Screen, { title: 'Board', actions }, e('div', { 'data-testid': 'body' }, 'body'))),
      )
    })
    const slotted = slot.querySelector<HTMLButtonElement>('.stack-row > button')
    assert.ok(slotted !== null)
    assert.equal(slot.querySelectorAll('button').length, 1)
    assert.ok(container.querySelector('.screen-header') === null)
    assert.ok(container.querySelector('button') === null)
    assert.ok(container.querySelector('.screen-title') === null)
    assert.equal(container.querySelector('[data-testid="body"]')?.textContent, 'body')
    await act(async () => {
      slotted!.click()
    })
    assert.deepEqual(clicks, ['refresh'])

    await act(async () => {
      root.render(
        e(ScreenHostContext.Provider, { value: { hosted: true } },
          e(Screen, { title: 'Board', actions }, e('div', null, 'body'))),
      )
    })
    assert.equal(slot.querySelectorAll('button').length, 0)
    const inline = container.querySelector<HTMLButtonElement>('.screen-header > .stack-row > button')
    assert.ok(inline !== null)

    await act(async () => {
      root.render(
        e(ScreenHostContext.Provider, { value: { hosted: true, headerActionsSlot: slot } },
          e(Screen, { title: 'Board', actions }, e('div', null, 'body'))),
      )
    })
    assert.equal(slot.querySelectorAll('button').length, 1)
    await act(async () => {
      root.render(null)
    })
    assert.equal(slot.querySelectorAll('button').length, 0)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    slot.remove()
  }
})

test('Screen DOM: hosted toolbarSlot portals sticky hairline toolbar bar above scroll body; unhosted renders inline sticky bar', { timeout: 60_000 }, async () => {
  const { Screen } = await import('../src/primitives.js')
  const { ScreenHostContext } = await import('../src/screen-host.js')
  const toolbarSlot = document.createElement('div')
  document.body.appendChild(toolbarSlot)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const toolbar = e(
    ScreenToolbar,
    {
      label: 'Rules filter',
      actions: e(SearchBox, { variant: 'toolbar', size: 'sm', value: 'abc', onChange: () => {}, ariaLabel: 'Filter rules' }),
    },
    e('span', null, 'Segments'),
  )
  try {
    await act(async () => {
      root.render(
        e(ScreenHostContext.Provider, { value: { hosted: true, toolbarSlot } },
          e(Screen, { title: 'Rules', toolbar }, e('div', null, 'Body'))),
      )
    })
    assert.ok(toolbarSlot.querySelector('.screen-toolbar-bar > .screen-toolbar') !== null)
    assert.ok(toolbarSlot.querySelector('.screen-toolbar-bar-inline') === null)
    assert.ok(container.querySelector('.screen-toolbar-bar') === null)

    await act(async () => {
      root.render(
        e(ScreenHostContext.Provider, { value: { hosted: true } },
          e(Screen, { title: 'Rules', toolbar }, e('div', null, 'Body'))),
      )
    })
    assert.equal(toolbarSlot.children.length, 0)
    assert.ok(container.querySelector('.screen-toolbar-bar.screen-toolbar-bar-inline > .screen-toolbar') !== null)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    toolbarSlot.remove()
  }
})

test('ListRow DOM: surface and trigger clicks invoke onSelect once; sibling trailing/actions clicks and disabled rows never invoke onSelect', { timeout: 60_000 }, async () => {
  const { List, ListRow } = await import('../src/primitives/List.js')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const events: string[] = []
  try {
    await act(async () => {
      root.render(
        e(
          List,
          { label: 'Rules' },
          e(ListRow, {
            title: 'rule-1',
            description: 'Enabled rule',
            trailing: e(Switch, {
              checked: true,
              onChange: () => events.push('toggle'),
              'aria-label': 'Toggle rule-1',
            }),
            actions: e(IconButton, {
              icon: 'trash-2',
              size: 'xs',
              label: 'Delete rule-1',
              onClick: () => events.push('delete'),
            }),
            onSelect: () => events.push('select-1'),
          }),
          e(ListRow, {
            title: 'rule-2',
            disabled: true,
            onSelect: () => events.push('select-2'),
          }),
        ),
      )
    })
    const rows = [...container.querySelectorAll<HTMLElement>('.helmx-list-row')]
    assert.equal(rows.length, 2)
    const row1 = rows[0]!
    const trigger1 = row1.querySelector<HTMLButtonElement>('button.helmx-list-row-trigger')!
    const switch1 = row1.querySelector<HTMLButtonElement>('[role="switch"]')!
    const delete1 = row1.querySelector<HTMLButtonElement>('.helmx-list-row-actions button')!
    const row2 = rows[1]!

    await act(async () => {
      trigger1.click()
    })
    assert.deepEqual(events, ['select-1'])

    await act(async () => {
      row1.click()
    })
    assert.deepEqual(events, ['select-1', 'select-1'])

    await act(async () => {
      switch1.click()
      delete1.click()
      row2.click()
    })
    assert.deepEqual(events, ['select-1', 'select-1', 'toggle', 'delete'])
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})
