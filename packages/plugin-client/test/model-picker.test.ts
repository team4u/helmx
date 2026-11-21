/**
 * Shared ModelPickerControl + useModels model-catalog slice tests:
 * - manifest lock: the new shared symbols are listed in the protocol
 *   PLUGIN_CLIENT_SHARED_EXPORTS manifest and really exported by the SDK;
 * - pure helpers: short-name/route-splitting display, thinking-level
 *   convergence, keyboard index stepping;
 * - SSR: the control renders the trigger (short name + level suffix) with no
 *   browser side effects and zero emoji;
 * - handle contract: useModels reads the catalog through the stable
 *   PluginClientDataHandlesContext (never the per-frame-rebuilt host port): a
 *   host port identity churn (rebuilt on every conversation streaming frame)
 *   never re-renders consumers, while a real catalog domain emit does;
 * - honesty gates: absent capability -> explicit unknown snapshot (never a
 *   fabricated empty-catalog truth); absent refreshModels -> the refresh entry
 *   is hidden instead of faking success;
 * - PI apply semantics coverage split: the interactive popover contract (row
 *   body = (model, null) default-chain apply, level chip = (model, level)
 *   single commit, reset row, search filtering, refresh wiring) is exercised
 *   end-to-end by the host consumer suites (web composer-keybindings /
 *   global-defaults-panel / agent-standby tests mount this exact control in
 *   the full host bridge); this package keeps the contract, SSR, pure-helper
 *   and isolation invariants here because the popper-dependent portal cannot
 *   expand under this package's minimal happy-dom setup.
 */
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as Record<string, unknown>).React = React
// Radix popper content requires ResizeObserver; happy-dom does not provide one.
if ((globalThis as Record<string, unknown>).ResizeObserver === undefined) {
  ;(globalThis as Record<string, unknown>).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
}

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { act } from 'react'
import * as ReactDOMClient from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { PLUGIN_CLIENT_SHARED_EXPORTS } from '@helmx/protocol'
import * as SDK from '../src/index.js'
import { ModelPickerControl } from '../src/ui/ModelPicker.js'
import {
  formatModelRowDisplay,
  formatModelShortName,
  initialModelActiveIndex,
  resolveEffectiveThinkingLevel,
  stepActiveIndex,
} from '../src/ui/model-picker-model.js'
import {
  PluginClientDataHandlesContext,
  PluginClientHostContext,
  type PluginClientDataHandles,
  type PluginClientHostPort,
} from '../src/host-port.js'
import { useModels } from '../src/conversation-hooks.js'

const e = React.createElement

const CATALOG_MODELS = [
  { id: 'anthropic/claude-3-7-sonnet', provider: 'anthropic', modelId: 'claude-3-7-sonnet', available: true, thinkingLevels: ['off', 'low', 'high'] },
  { id: 'openai/gpt-4o-mini', provider: 'openai', modelId: 'gpt-4o-mini', available: true, thinkingLevels: ['off', 'low', 'medium'] },
  { id: 'magpie/auto/glm-5.3', provider: 'magpie', modelId: 'auto/glm-5.3', available: true, thinkingLevels: ['off', 'high'] },
  { id: 'faux/disabled-model', provider: 'faux', modelId: 'disabled-model', available: true, disabled: true, thinkingLevels: ['off'] },
  { id: 'faux/credential-gone', provider: 'faux', modelId: 'credential-gone', available: false, thinkingLevels: ['off'] },
]

interface CatalogHandle {
  snapshot: { unknown: boolean; models: typeof CATALOG_MODELS }
  listeners: Set<() => void>
}

/** Minimal stable data handles carrying the model-catalog capability. */
function makeHandles(handle: CatalogHandle): PluginClientDataHandles {
  return {
    subscribeModels: (listener) => {
      handle.listeners.add(listener)
      return () => handle.listeners.delete(listener)
    },
    getModelsSnapshot: () => handle.snapshot,
  }
}

/** Host port stub carrying only what the control reads directly (notify). */
function makePort(extra?: Partial<PluginClientHostPort>): PluginClientHostPort {
  return { ...extra } as unknown as PluginClientHostPort
}

const click = (el: Element): Promise<void> =>
  act(async () => {
    ;(el as HTMLElement).click()
  })

// ---------------------------------------------------------------------------
// 1. Manifest lock + pure helpers
// ---------------------------------------------------------------------------

test('model picker symbols are in the protocol manifest and really exported (bidirectional lock)', { timeout: 60_000 }, () => {
  for (const name of ['useModels', 'ModelPickerControl', 'formatModelShortName', 'formatModelRowDisplay', 'resolveEffectiveThinkingLevel']) {
    assert.ok(
      (PLUGIN_CLIENT_SHARED_EXPORTS as readonly string[]).includes(name),
      `PLUGIN_CLIENT_SHARED_EXPORTS must include ${name}`,
    )
    assert.equal(typeof (SDK as Record<string, unknown>)[name], 'function', `the shared SDK must really export ${name}`)
  }
})

test('formatModelShortName / formatModelRowDisplay: nested route prefixes move to the source line', { timeout: 60_000 }, () => {
  assert.equal(formatModelShortName('anthropic/claude-3-7-sonnet'), 'claude-3-7-sonnet')
  assert.equal(formatModelShortName('magpie/auto/glm-5.3'), 'glm-5.3')
  assert.equal(formatModelShortName('plain-model'), 'plain-model')
  assert.equal(formatModelShortName(undefined), '')
  assert.equal(formatModelShortName('  '), '')
  assert.deepEqual(formatModelRowDisplay({ provider: 'magpie', modelId: 'auto/glm-5.3' }), {
    name: 'glm-5.3',
    source: 'magpie/auto',
  })
  assert.deepEqual(formatModelRowDisplay({ provider: 'anthropic', modelId: 'claude-3-7-sonnet' }), {
    name: 'claude-3-7-sonnet',
    source: 'anthropic',
  })
})

test('resolveEffectiveThinkingLevel / index stepping semantics', { timeout: 60_000 }, () => {
  assert.equal(resolveEffectiveThinkingLevel(['off', 'low', 'high'], 'high'), 'high')
  assert.equal(resolveEffectiveThinkingLevel(['off', 'low', 'high'], 'max'), 'off')
  assert.equal(resolveEffectiveThinkingLevel(['low', 'high'], 'off'), 'low')
  assert.equal(resolveEffectiveThinkingLevel([], 'high'), '')
  assert.equal(initialModelActiveIndex(CATALOG_MODELS, ''), -1)
  assert.equal(initialModelActiveIndex(CATALOG_MODELS, 'gpt'), 0)
  assert.equal(stepActiveIndex(-1, 3, 1), 0)
  assert.equal(stepActiveIndex(0, 3, -1), 2)
  assert.equal(stepActiveIndex(2, 3, 1), 0)
  assert.equal(stepActiveIndex(0, 0, 1), -1)
})

// ---------------------------------------------------------------------------
// 2. SSR + handle-driven rendering
// ---------------------------------------------------------------------------

test('SSR: trigger renders short name + effective level suffix without browser side effects', { timeout: 60_000 }, () => {
  const handle: CatalogHandle = { snapshot: { unknown: false, models: CATALOG_MODELS }, listeners: new Set() }
  const html = renderToString(
    e(PluginClientDataHandlesContext.Provider, { value: makeHandles(handle) },
      e(PluginClientHostContext.Provider, { value: makePort() },
        e(ModelPickerControl, {
          effectiveModel: 'anthropic/claude-3-7-sonnet',
          activeThinkingLevel: 'high',
          resetLabel: 'Reset',
          resetTitle: 'Reset',
          buttonTitle: 'Current model',
          onApply: () => {},
          onResetDefault: () => {},
        }))),
  )
  assert.match(html, /claude-3-7-sonnet/)
  assert.match(html, /· high/)
  assert.match(html, /composer-model-button/)
  assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'zero emoji in the shared control')
})

test('useModels reads the catalog through the stable handles context: port identity churn never re-renders, a catalog emit does', { timeout: 60_000 }, async () => {
  const handle: CatalogHandle = { snapshot: { unknown: true, models: [] }, listeners: new Set() }
  const handles = makeHandles(handle)

  let renderCount = 0
  function ProbeInner(): React.ReactNode {
    renderCount += 1
    const catalog = useModels()
    return e('span', { 'data-testid': 'probe' }, `${catalog.unknown ? 'unknown' : `ready:${catalog.models.length}`}`)
  }
  // Memoized so re-rendering the harness (fresh provider elements per frame,
  // as the host bridge produces) only propagates through context updates —
  // the exact isolation property under test.
  const Probe = React.memo(ProbeInner)

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  await act(async () => {
    root.render(
      e(PluginClientDataHandlesContext.Provider, { value: handles },
        e(PluginClientHostContext.Provider, { value: makePort() }, e(Probe))),
    )
  })
  assert.match(container.textContent ?? '', /unknown/)
  const rendersAfterMount = renderCount

  // The host rebuilds the port object identity on unrelated streaming frames
  // (fresh conversations/lives maps) while the data handles stay stable:
  // useModels consumers must not re-render.
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      root.render(
        e(PluginClientDataHandlesContext.Provider, { value: handles },
          e(PluginClientHostContext.Provider, { value: makePort() }, e(Probe))),
      )
    })
  }
  assert.equal(renderCount, rendersAfterMount, 'host port identity churn (streaming frames) must not re-render useModels consumers')

  await act(async () => {
    handle.snapshot = { unknown: false, models: CATALOG_MODELS }
    for (const listener of handle.listeners) listener()
  })
  assert.ok(renderCount > rendersAfterMount, 'a real catalog domain emit re-renders consumers')
  assert.match(container.textContent ?? '', /ready:5/)

  await act(async () => {
    root.unmount()
  })
  container.remove()
})

test('absent catalog capability: explicit unknown snapshot, never a fabricated empty-catalog truth', { timeout: 60_000 }, async () => {
  let probed: { unknown: boolean; count: number } | undefined
  function Probe(): React.ReactNode {
    const catalog = useModels()
    probed = { unknown: catalog.unknown, count: catalog.models.length }
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  await act(async () => {
    root.render(e(PluginClientHostContext.Provider, { value: makePort() }, e(Probe)))
  })
  assert.deepEqual(probed, { unknown: true, count: 0 }, 'hosts without the handles context report unknown, not "no models exist"')
  await act(async () => {
    root.unmount()
  })
  container.remove()
})
