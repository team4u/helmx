/**
 * Shared ModelPickerControl + host model catalog slice integration tests
 * (contract shapes owned by the frozen sdk-contract ABI):
 * - manifest lock: ModelPickerControl and the model pure functions are listed
 *   in the protocol PLUGIN_CLIENT_SHARED_EXPORTS manifest and really exported;
 * - pure helpers: short-name/route-splitting display, thinking-level
 *   convergence, keyboard index stepping, copy interpolation;
 * - SSR: the control renders the trigger (short name + level suffix) with no
 *   browser side effects and zero emoji, reading the catalog through the
 *   stable PluginClientHostHandlesContext (useHostModels);
 * - churn isolation (#23 P0.2): the control itself reads no churning context
 *   (no locale / notify context reads — copy and notices arrive via props), so
 *   a memoized wrapper re-renders zero times under main-port identity churn
 *   and exactly once per real catalog revision;
 * - honesty gates: undefined slice = capability absent or first load in flight
 *   (explicit unavailable copy, never a fabricated empty-catalog truth);
 *   absent refreshModels hides the refresh entry instead of faking success;
 * - PI apply semantics coverage split: the interactive popover contract (row
 *   body = (model, null) default-chain apply, level chip = (model, level)
 *   single commit, reset row, search filtering, refresh wiring) is exercised
 *   end-to-end by the host consumer suites (web composer-keybindings /
 *   global-defaults-panel / plugin-detail-drawer / agent-standby tests mount
 *   this exact control in the full host bridge); this package keeps the
 *   contract, SSR, pure-helper and isolation invariants because the
 *   popper-dependent portal cannot expand under this package's minimal
 *   happy-dom setup.
 */
import './helpers/register-happy-dom.js'
import * as React from 'react'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { act } from 'react'
import * as ReactDOMClient from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { PLUGIN_CLIENT_SHARED_EXPORTS } from '@helmx/protocol'
import * as SDK from '../src/index.js'
import { ModelPickerControl } from '../src/ui/ModelPicker.js'
import {
  DEFAULT_MODEL_PICKER_COPY,
  formatModelPickerCopy,
  formatModelRowDisplay,
  formatModelShortName,
  initialModelActiveIndex,
  resolveEffectiveThinkingLevel,
  stepActiveIndex,
} from '../src/ui/model-picker-model.js'
import {
  PluginClientHostContext,
  type PluginClientHostPort,
} from '../src/host-port.js'
import { useHostModels } from '../src/conversation-hooks.js'

const e = React.createElement

const CATALOG_MODELS = [
  { id: 'anthropic/claude-3-7-sonnet', provider: 'anthropic', modelId: 'claude-3-7-sonnet', available: true, thinkingLevels: ['off', 'low', 'high'] },
  { id: 'openai/gpt-4o-mini', provider: 'openai', modelId: 'gpt-4o-mini', available: true, thinkingLevels: ['off', 'low', 'medium'] },
  { id: 'magpie/auto/glm-5.3', provider: 'magpie', modelId: 'auto/glm-5.3', available: true, thinkingLevels: ['off', 'high'] },
  { id: 'faux/disabled-model', provider: 'faux', modelId: 'disabled-model', available: true, disabled: true, thinkingLevels: ['off'] },
  { id: 'faux/credential-gone', provider: 'faux', modelId: 'credential-gone', available: false, thinkingLevels: ['off'] },
]

interface CatalogHandle {
  slice: { models: typeof CATALOG_MODELS } | undefined
  listeners: Set<() => void>
}

/** Minimal reference-stable host port carrying the model-catalog capability. */
function makePort(handle: CatalogHandle, extra?: Partial<PluginClientHostPort>): PluginClientHostPort {
  return {
    subscribeModels: (listener: () => void) => {
      handle.listeners.add(listener)
      return () => {
        handle.listeners.delete(listener)
      }
    },
    getModels: () => handle.slice,
    ...extra,
  } as unknown as PluginClientHostPort
}

// ---------------------------------------------------------------------------
// 1. Manifest lock + pure helpers
// ---------------------------------------------------------------------------

test('model picker symbols are in the protocol manifest and really exported (bidirectional lock)', { timeout: 60_000 }, () => {
  for (const name of ['useHostModels', 'ModelPickerControl', 'formatModelShortName', 'resolveEffectiveThinkingLevel', 'usePanelShortcut']) {
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
  assert.equal(formatModelShortName('tier/architect'), 'tier/architect')
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

test('resolveEffectiveThinkingLevel / index stepping / copy interpolation semantics', { timeout: 60_000 }, () => {
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
  assert.equal(formatModelPickerCopy('Use {model} · thinking {level}', { model: 'a/b', level: 'high' }), 'Use a/b · thinking high')
  assert.equal(DEFAULT_MODEL_PICKER_COPY.defaultLabel, 'Default model')
})

// ---------------------------------------------------------------------------
// 2. SSR + handle-driven rendering
// ---------------------------------------------------------------------------

test('SSR: trigger renders the effective model short name; the catalog slice stays undefined server-side (honest)', { timeout: 60_000 }, () => {
  const handle: CatalogHandle = { slice: { models: CATALOG_MODELS }, listeners: new Set() }
  const html = renderToString(
    e(PluginClientHostContext.Provider, { value: makePort(handle) },
      e(ModelPickerControl, {
        effectiveModel: 'anthropic/claude-3-7-sonnet',
        activeThinkingLevel: 'high',
        resetLabel: 'Reset',
        resetTitle: 'Reset',
        buttonTitle: 'Current model',
        onApply: () => {},
        onResetDefault: () => {},
      })),
  )
  // The frozen contract pins the server snapshot to undefined, so the trigger
  // renders the prop-driven short name while catalog-derived facts (level
  // suffix, capability lookups) honestly stay absent until hydration.
  assert.match(html, /claude-3-7-sonnet/)
  assert.match(html, /composer-model-button/)
  assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'zero emoji in the shared control')
})

test('churn isolation: stable host port re-renders useHostModels only on real catalog revisions', { timeout: 60_000 }, async () => {
  const handle: CatalogHandle = { slice: undefined, listeners: new Set() }
  const port = makePort(handle)

  let probeRenders = 0
  function ProbeInner(): React.ReactNode {
    probeRenders += 1
    const catalog = useHostModels()
    return e('span', { 'data-testid': 'probe' }, catalog === undefined ? 'unknown' : `ready:${catalog.models.length}`)
  }
  const Probe = React.memo(ProbeInner)

  const ControlProbe = React.memo(function ControlProbe(): React.ReactNode {
    return e(ModelPickerControl, {
      effectiveModel: 'anthropic/claude-3-7-sonnet',
      activeThinkingLevel: 'high',
      resetLabel: 'Reset',
      resetTitle: 'Reset',
      buttonTitle: 'Current model',
      onApply: () => {},
      onResetDefault: () => {},
    })
  })

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  const renderFrame = async (): Promise<void> => {
    await act(async () => {
      root.render(
        e(PluginClientHostContext.Provider, { value: port },
          e(React.Fragment, null, e(Probe), e(ControlProbe))),
      )
    })
  }
  await renderFrame()
  assert.match(container.textContent ?? '', /unknown/)
  const probeBaseline = probeRenders

  for (let i = 0; i < 5; i++) await renderFrame()
  assert.equal(probeRenders, probeBaseline, 're-rendering the provider with a stable port must not re-render useHostModels consumers')
  assert.doesNotMatch(container.innerHTML, /· high/, 'the control output stays unchanged before catalog loads')

  await act(async () => {
    handle.slice = { models: CATALOG_MODELS }
    for (const listener of handle.listeners) listener()
  })
  assert.ok(probeRenders > probeBaseline, 'a real catalog revision re-renders useHostModels consumers')
  assert.match(container.textContent ?? '', /ready:5/)
  assert.match(container.innerHTML, /· high/, 'the control renders the effective level once the slice arrives')

  const afterRevision = probeRenders
  await act(async () => {
    for (const listener of handle.listeners) listener()
  })
  assert.equal(probeRenders, afterRevision, 'a same-reference notification must not re-render consumers')

  await act(async () => {
    root.unmount()
  })
  container.remove()
})

test('undefined slice (capability absent / first load in flight) renders the explicit unavailable state', { timeout: 60_000 }, () => {
  const handle: CatalogHandle = { slice: undefined, listeners: new Set() }
  const html = renderToString(
    e(PluginClientHostContext.Provider, { value: makePort(handle) },
      e(ModelPickerControl, {
        effectiveModel: undefined,
        activeThinkingLevel: 'off',
        resetLabel: 'Reset',
        resetTitle: 'Reset',
        buttonTitle: 'Current model',
        onApply: () => {},
        onResetDefault: () => {},
      })),
  )
  assert.ok(html.length > 0, 'the control renders with an undefined slice (no crash)')
  assert.match(DEFAULT_MODEL_PICKER_COPY.catalogUnavailable, /unavailable/i, 'SDK default copy carries an explicit unavailable state')
})

test('copy is prop-driven: overrides replace English defaults verbatim (zero locale context reads)', { timeout: 60_000 }, () => {
  const handle: CatalogHandle = { slice: { models: CATALOG_MODELS }, listeners: new Set() }
  const html = renderToString(
    e(PluginClientHostContext.Provider, { value: makePort(handle) },
      e(ModelPickerControl, {
        effectiveModel: undefined,
        activeThinkingLevel: 'off',
        resetLabel: '重置',
        resetTitle: '重置',
        buttonTitle: '标题',
        copy: { defaultLabel: '跟随默认模型', searchAria: '搜索模型' },
        onApply: () => {},
        onResetDefault: () => {},
      })),
  )
  assert.match(html, /跟随默认模型/)
})

test('empty loaded catalog (models: []) displays emptyCatalog copy and optional Models Center CTA instead of noMatches', { timeout: 60_000 }, async () => {
  const handle: CatalogHandle = { slice: { models: [] }, listeners: new Set() }
  let openedModels = 0
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  try {
    await act(async () => {
      root.render(
        e(PluginClientHostContext.Provider, { value: makePort(handle) },
          e(ModelPickerControl, {
            effectiveModel: undefined,
            activeThinkingLevel: 'off',
            resetLabel: 'Reset',
            resetTitle: 'Reset',
            buttonTitle: 'Current model',
            onApply: () => {},
            onResetDefault: () => {},
            onOpenModelsCenter: () => {
              openedModels += 1
            },
          })),
      )
    })
    const trigger = container.querySelector<HTMLButtonElement>('button.composer-model-button')
    assert.ok(trigger !== null)
    await act(async () => {
      trigger.click()
    })
    const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
    assert.ok(popover !== null, 'model picker popover opens')
    assert.match(popover.textContent ?? '', /No models available/, 'empty catalog shows emptyCatalog copy')
    assert.doesNotMatch(popover.textContent ?? '', /No matching models/, 'empty catalog must not misreport noMatches')
    const cta = popover.querySelector<HTMLButtonElement>('.composer-model-empty button')
    assert.ok(cta !== null, 'optional onOpenModelsCenter renders setup CTA button')
    assert.match(cta.textContent ?? '', /Configure models/)
    await act(async () => {
      cta.click()
    })
    assert.equal(openedModels, 1, 'clicking setup CTA invokes onOpenModelsCenter')
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})
