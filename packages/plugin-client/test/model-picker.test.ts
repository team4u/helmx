/**
 * Shared ModelPickerControl + host model catalog slice integration tests
 * (contract shapes owned by the frozen sdk-contract ABI):
 * - manifest lock: ModelPickerControl and the model pure functions are listed
 *   in the protocol PLUGIN_CLIENT_SHARED_EXPORTS manifest and really exported;
 * - pure helpers: short-name/route-splitting display, thinking-level
 *   convergence (kernel clamp parity), default-chain tier presets, keyboard
 *   index stepping, copy interpolation;
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
import { PLUGIN_CLIENT_SHARED_EXPORTS, type HostModelsSlice } from '@helmx/protocol'
import * as SDK from '../src/index.js'
import { ModelPickerControl, type ModelPickerControlProps } from '../src/ui/ModelPicker.js'
import {
  DEFAULT_MODEL_PICKER_COPY,
  formatModelPickerCopy,
  formatModelRowDisplay,
  formatModelShortName,
  initialModelActiveIndex,
  resolveDefaultChainThinkingLevel,
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
  slice: HostModelsSlice | undefined
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
  // Kernel parity (pi-ai clampThinkingLevel): an unsupported level clamps to the nearest supported
  // one, searching upward first then downward, so the display never shows a level that does not run.
  assert.equal(resolveEffectiveThinkingLevel(['off', 'low', 'high'], 'max'), 'high')
  assert.equal(resolveEffectiveThinkingLevel(['off', 'high', 'xhigh'], 'max'), 'xhigh')
  assert.equal(resolveEffectiveThinkingLevel(['off', 'low'], 'xhigh'), 'low')
  // An explicit 'off' always passes (the kernel omits the reasoning parameter); an unconfigured
  // level stays empty (the SDK default runs and is never fabricated); a level outside the
  // canonical order and a model without declared levels yield '' too.
  assert.equal(resolveEffectiveThinkingLevel(['low', 'high'], 'off'), 'off')
  assert.equal(resolveEffectiveThinkingLevel(['high', 'xhigh'], ''), '')
  assert.equal(resolveEffectiveThinkingLevel(['off', 'high'], ''), '')
  assert.equal(resolveEffectiveThinkingLevel(['off', 'low'], 'ultra'), '')
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

const TIER_CATALOG: HostModelsSlice = {
  models: [
    ...CATALOG_MODELS,
    { id: 'faux/sol', provider: 'faux', modelId: 'sol', available: true, thinkingLevels: ['high', 'xhigh'] },
    { id: 'faux/omni', provider: 'faux', modelId: 'omni', available: true, thinkingLevels: ['off', 'high', 'xhigh', 'max'] },
  ],
  modelTiers: [
    // Preset unsupported by the target: the kernel clamps max -> xhigh (never high).
    { id: 'reviewer', model: 'faux/sol', thinkingLevel: 'max', available: true, thinkingLevels: ['high', 'xhigh'] },
    { id: 'scout', model: 'faux/omni', thinkingLevel: 'max', available: true, thinkingLevels: ['off', 'high', 'xhigh', 'max'] },
    // No preset: the per-model default, then the level configured beside the reference, applies.
    { id: 'plain', model: 'faux/sol', available: true, thinkingLevels: ['high', 'xhigh'] },
  ],
  modelThinkingLevels: { 'faux/sol': 'xhigh', 'faux/omni': 'high' },
}

test('resolveDefaultChainThinkingLevel: conversation chain = tier preset > per-model default > configured level, kernel-clamped', { timeout: 60_000 }, () => {
  // Tier with preset: the per-model default and the configured level never mask the preset.
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'tier/scout', 'high'), 'max')
  // Unsupported preset converges the way the kernel clamps it (upward first, then downward).
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'tier/reviewer', 'high'), 'xhigh')
  // Tier without preset: the target's per-model default wins over the configured level.
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'tier/plain', 'high'), 'xhigh')
  // Concrete model: the per-model default wins over the configured level; without one the
  // configured level applies, converged; an empty chain shows nothing (the SDK default runs).
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'faux/sol', 'high'), 'xhigh')
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'faux/omni', ''), 'high')
  assert.equal(resolveDefaultChainThinkingLevel({ ...TIER_CATALOG, modelThinkingLevels: {} }, 'faux/sol', 'max'), 'xhigh')
  assert.equal(resolveDefaultChainThinkingLevel({ ...TIER_CATALOG, modelThinkingLevels: {} }, 'faux/sol', ''), '')
  // Unknown references: nothing for no reference; a concrete reference outside the catalog keeps
  // its chain result unconverged.
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, '', 'high'), '')
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, undefined, 'high'), '')
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'faux/missing', 'high'), 'high')
  // Catalog unknown: a concrete reference's configured level is a plain (unconverged) fact; a
  // tier's preset is unknown and outranks everything else, so nothing honest can be shown.
  assert.equal(resolveDefaultChainThinkingLevel(undefined, 'faux/sol', 'max'), 'max')
  assert.equal(resolveDefaultChainThinkingLevel(undefined, 'tier/scout', 'high'), '')
  // An unregistered tier (or one whose target is absent from the catalog) has no known preset to show.
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'tier/missing', 'high'), '')
  assert.equal(
    resolveDefaultChainThinkingLevel({ models: [], modelTiers: [{ id: 'ghost', model: 'faux/gone', thinkingLevel: 'max', available: false }] }, 'tier/ghost', 'high'),
    '',
  )
})

test('resolveDefaultChainThinkingLevel: compaction chain = configured compaction level > tier preset > per-model default', { timeout: 60_000 }, () => {
  // An explicit compaction level wins over both the tier preset and the per-model default.
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'tier/scout', 'high', 'compaction'), 'high')
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'faux/sol', 'high', 'compaction'), 'high')
  // Without one: the tier preset, then the target's per-model default; an empty chain shows nothing.
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'tier/scout', '', 'compaction'), 'max')
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'tier/plain', '', 'compaction'), 'xhigh')
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'faux/sol', '', 'compaction'), 'xhigh')
  assert.equal(resolveDefaultChainThinkingLevel({ ...TIER_CATALOG, modelThinkingLevels: {} }, 'faux/sol', '', 'compaction'), '')
})

test('resolveDefaultChainThinkingLevel: tier chain = explicit tier preset > per-model default, kernel-clamped', { timeout: 60_000 }, () => {
  // Explicit tier level (including explicit 'off') wins over per-model default.
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'faux/sol', 'high', 'tier'), 'high')
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'faux/omni', 'off', 'tier'), 'off')
  // Empty tier level falls back to per-model default, clamped to target capabilities.
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'faux/sol', '', 'tier'), 'xhigh')
  assert.equal(
    resolveDefaultChainThinkingLevel(
      { ...TIER_CATALOG, modelThinkingLevels: { 'faux/sol': 'max' } },
      'faux/sol',
      '',
      'tier',
    ),
    'xhigh',
  )
  // Both explicit level and per-model default empty -> returns '' (follows SDK default).
  assert.equal(resolveDefaultChainThinkingLevel({ ...TIER_CATALOG, modelThinkingLevels: {} }, 'faux/sol', '', 'tier'), '')
  // Empty model reference (e.g. starter draft with suggested hint) -> returns '' even if configuredLevel is set.
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, '', 'high', 'tier'), '')
  // Catalog unknown -> explicit level passes through unconverged, empty stays ''.
  assert.equal(resolveDefaultChainThinkingLevel(undefined, 'faux/sol', 'high', 'tier'), 'high')
  assert.equal(resolveDefaultChainThinkingLevel(undefined, 'faux/sol', '', 'tier'), '')
})

/** Mount the control over a catalog and return the trigger button text. */
async function renderTriggerText(
  props: Pick<ModelPickerControlProps, 'effectiveModel' | 'activeThinkingLevel'> & Partial<ModelPickerControlProps>,
): Promise<{ text: string; container: HTMLElement; done: () => Promise<void> }> {
  const handle: CatalogHandle = { slice: TIER_CATALOG, listeners: new Set() }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  await act(async () => {
    root.render(
      e(PluginClientHostContext.Provider, { value: makePort(handle) },
        e(ModelPickerControl, {
          resetLabel: 'Reset',
          resetTitle: 'Reset',
          buttonTitle: 'Current model',
          onApply: () => {},
          onResetDefault: () => {},
          ...props,
        })),
    )
  })
  const trigger = container.querySelector<HTMLButtonElement>('button.composer-model-button')
  if (trigger === null) throw new Error('trigger button missing')
  return {
    text: trigger.textContent ?? '',
    container,
    done: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

test('tier-aware trigger: shows the caller-resolved level and falls back to the tier preset when empty, kernel-clamped', { timeout: 60_000 }, async () => {
  // Hosts pass the chain result (here: a draft override outranking the preset).
  const override = await renderTriggerText({ effectiveModel: 'tier/scout', activeThinkingLevel: 'xhigh' })
  try {
    assert.match(override.text, /tier\/scout/)
    assert.match(override.text, /· xhigh/)
  } finally {
    await override.done()
  }
  // Empty level: the tier's own preset shows, converged the way the kernel clamps it
  // (max on a high/xhigh model displays as xhigh, never the lowest level high).
  const scout = await renderTriggerText({ effectiveModel: 'tier/scout', activeThinkingLevel: '' })
  try {
    assert.match(scout.text, /· max/)
  } finally {
    await scout.done()
  }
  const reviewer = await renderTriggerText({ effectiveModel: 'tier/reviewer', activeThinkingLevel: '' })
  try {
    assert.match(reviewer.text, /· xhigh/)
    assert.doesNotMatch(reviewer.text, /· high/)
  } finally {
    await reviewer.done()
  }
  // Concrete models display the given level as before (no chain knowledge in the control).
  const concrete = await renderTriggerText({ effectiveModel: 'faux/sol', activeThinkingLevel: 'high' })
  try {
    assert.match(concrete.text, /· high/)
  } finally {
    await concrete.done()
  }
  const concreteEmpty = await renderTriggerText({ effectiveModel: 'faux/sol', activeThinkingLevel: '' })
  try {
    assert.doesNotMatch(concreteEmpty.text, /·/, 'an empty level on a concrete model shows no level (the chain is the host\'s call)')
  } finally {
    await concreteEmpty.done()
  }
})

test('tier rows badge the kernel-clamped preset level', { timeout: 60_000 }, async () => {
  const slice: HostModelsSlice = {
    ...TIER_CATALOG,
    models: [
      ...TIER_CATALOG.models,
      { id: 'faux/nothink', provider: 'faux', modelId: 'nothink', available: true, thinkingLevels: ['off'] },
    ],
    modelTiers: [
      ...(TIER_CATALOG.modelTiers ?? []),
      { id: 'bare', model: 'faux/fast', available: true, thinkingLevels: ['off', 'low', 'high'] },
      { id: 'staleoff', model: 'faux/nothink', available: true, thinkingLevels: ['off'] },
    ],
    modelThinkingLevels: {
      ...TIER_CATALOG.modelThinkingLevels,
      'faux/nothink': 'high',
    },
  }
  const handle: CatalogHandle = { slice, listeners: new Set() }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  try {
    await act(async () => {
      root.render(
        e(PluginClientHostContext.Provider, { value: makePort(handle) },
          e(ModelPickerControl, {
            effectiveModel: 'faux/omni',
            activeThinkingLevel: 'high',
            resetLabel: 'Reset',
            resetTitle: 'Reset',
            buttonTitle: 'Current model',
            onApply: () => {},
            onResetDefault: () => {},
          })),
      )
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button.composer-model-button')?.click()
    })
    const rows = Array.from(document.body.querySelectorAll<HTMLElement>('.composer-model-row'))
    const reviewerRow = rows.find((row) => row.textContent?.includes('tier/reviewer'))
    const scoutRow = rows.find((row) => row.textContent?.includes('tier/scout'))
    const plainRow = rows.find((row) => row.textContent?.includes('tier/plain'))
    const bareRow = rows.find((row) => row.textContent?.includes('tier/bare'))
    const staleoffRow = rows.find((row) => row.textContent?.includes('tier/staleoff'))
    assert.ok(reviewerRow !== null && reviewerRow !== undefined, 'reviewer tier row renders')
    assert.equal(reviewerRow.querySelector('.badge-neutral')?.textContent, 'xhigh', 'unsupported preset badges the clamped level')
    assert.equal(scoutRow?.querySelector('.badge-neutral')?.textContent, 'max')
    assert.equal(plainRow?.querySelector('.badge-neutral')?.textContent, 'xhigh', 'tier without preset badges per-model default')
    assert.ok(bareRow !== undefined && bareRow.querySelector('.badge-neutral') === null, 'tier without preset or per-model default omits badge')
    assert.ok(staleoffRow !== undefined && staleoffRow.querySelector('.badge-neutral') === null, 'tier targeting non-thinking model omits badge even with stale per-model entry')
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
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
    assert.equal(popover.getAttribute('data-mode'), 'default')
    assert.ok(popover.querySelector('.composer-model-header .composer-model-search-bar') !== null, 'header wraps search bar')
    assert.ok(popover.querySelector('.composer-model-footer .composer-model-reset') !== null, 'reset button renders in footer')
    assert.ok(popover.querySelector('.composer-model-footer .popover-kbd-hint') === null, 'empty catalog omits navHint')
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

test('populated catalog renders single-row header, current-row data attribute, and footer navHint without header kbd-hint', { timeout: 60_000 }, async () => {
  const handle: CatalogHandle = { slice: { models: CATALOG_MODELS }, listeners: new Set() }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  try {
    await act(async () => {
      root.render(
        e(
          PluginClientHostContext.Provider,
          { value: makePort(handle, { refreshModels: async () => ({ errors: {} }) }) },
          e(ModelPickerControl, {
            effectiveModel: 'openai/gpt-4o-mini',
            activeThinkingLevel: 'medium',
            resetLabel: 'Reset',
            resetTitle: 'Reset',
            buttonTitle: 'Current model',
            onApply: () => {},
            onResetDefault: () => {},
          }),
        ),
      )
    })
    const trigger = container.querySelector<HTMLButtonElement>('button.composer-model-button')
    assert.ok(trigger !== null)
    await act(async () => {
      trigger.click()
    })
    const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
    assert.ok(popover !== null)
    assert.ok(popover.querySelector('.composer-model-header .composer-model-search-bar') !== null)
    assert.ok(popover.querySelector('.composer-model-header .composer-model-header-actions .composer-model-refresh-btn') !== null)
    assert.ok(popover.querySelector('.composer-model-scroll .popover-header .popover-kbd-hint') === null)
    assert.ok(popover.querySelector('.composer-model-footer .composer-model-reset') !== null)
    assert.ok(popover.querySelector('.composer-model-footer .popover-kbd-hint') !== null)
    const currentRow = popover.querySelector<HTMLElement>('.composer-model-row[data-current="true"]')
    assert.ok(currentRow !== null)
    assert.match(currentRow.textContent ?? '', /gpt-4o-mini/)
    assert.equal(currentRow.classList.contains('popover-item-active'), false)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

test('refreshCatalog aborts state updates and notices cleanly when unmounted mid-flight', { timeout: 60_000 }, async () => {
  const handle: CatalogHandle = { slice: { models: CATALOG_MODELS }, listeners: new Set() }
  let resolveRefresh: ((value: { errors: Record<string, string> }) => void) | undefined
  const notices: Array<{ message: string; tone: string }> = []
  let refreshedCallbacks = 0

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  try {
    await act(async () => {
      root.render(
        e(
          PluginClientHostContext.Provider,
          {
            value: makePort(handle, {
              refreshModels: () =>
                new Promise((resolve) => {
                  resolveRefresh = resolve
                }),
            }),
          },
          e(ModelPickerControl, {
            effectiveModel: 'openai/gpt-4o-mini',
            activeThinkingLevel: 'medium',
            resetLabel: 'Reset',
            resetTitle: 'Reset',
            buttonTitle: 'Current model',
            onApply: () => {},
            onResetDefault: () => {},
            onCatalogRefreshed: () => {
              refreshedCallbacks += 1
            },
            onNotice: (message, tone) => {
              notices.push({ message, tone })
            },
          }),
        ),
      )
    })
    const trigger = container.querySelector<HTMLButtonElement>('button.composer-model-button')
    assert.ok(trigger !== null)
    await act(async () => {
      trigger.click()
    })
    const refreshBtn = document.body.querySelector<HTMLButtonElement>('.composer-model-refresh-btn')
    assert.ok(refreshBtn !== null)
    await act(async () => {
      refreshBtn.click()
    })
    assert.ok(resolveRefresh !== undefined, 'refreshModels invoked')

    // Unmount before refresh resolves.
    await act(async () => {
      root.unmount()
    })
    await act(async () => {
      resolveRefresh?.({ errors: {} })
      await Promise.resolve()
    })

    assert.equal(refreshedCallbacks, 0, 'unmounted component skips onCatalogRefreshed')
    assert.equal(notices.length, 0, 'unmounted component emits zero notices after unmount')
  } finally {
    container.remove()
  }
})

test('ModelPickerControl nextTurnMode: toggles one-turn tab, stages badge + quick clear, disables on busy, and supports initialMode', { timeout: 60_000 }, async () => {
  const slice: HostModelsSlice = {
    models: CATALOG_MODELS,
    modelTiers: [
      { id: 'coder', model: 'anthropic/claude-3-7-sonnet', thinkingLevel: 'high', available: true },
    ],
  }
  const handle: CatalogHandle = { slice, listeners: new Set() }

  const applied: Array<{ model: string; thinkingLevel: string | null }> = []
  const nextTurnChanges: Array<{ model?: string; thinkingLevel?: string } | null> = []
  const initialChanges: Array<string | null> = []

  const renderPicker = async (props: Partial<ModelPickerControlProps>) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = ReactDOMClient.createRoot(container)
    await act(async () => {
      root.render(
        e(
          PluginClientHostContext.Provider,
          { value: makePort(handle) },
          e(ModelPickerControl, {
            effectiveModel: 'openai/gpt-4o-mini',
            activeThinkingLevel: 'medium',
            resetLabel: 'Reset',
            resetTitle: 'Reset',
            buttonTitle: 'Model',
            onApply: (model, thinkingLevel) => {
              applied.push({ model, thinkingLevel })
            },
            onResetDefault: () => {},
            ...props,
          }),
        ),
      )
    })
    return {
      container,
      cleanup: async () => {
        await act(async () => {
          root.unmount()
        })
        container.remove()
      },
    }
  }

  // 1. Default persistent selection vs Next turn only mode
  const run1 = await renderPicker({
    nextTurnMode: {
      onChange: (override) => {
        nextTurnChanges.push(override)
      },
    },
  })
  try {
    const trigger = run1.container.querySelector<HTMLButtonElement>('button.composer-model-button')
    assert.ok(trigger !== null)
    await act(async () => {
      trigger.click()
    })
    const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
    assert.ok(popover !== null)
    assert.match(popover.textContent ?? '', /tier\/coder/)
    const tabs = Array.from(popover.querySelectorAll<HTMLButtonElement>('.composer-model-mode-bar [role="tab"]'))
    const nextTurnTab = tabs.find((btn) => (btn.textContent ?? '').includes('Next turn only'))
    assert.ok(nextTurnTab !== undefined)
    await act(async () => {
      nextTurnTab.click()
    })
    assert.equal(popover.getAttribute('data-mode'), 'next-turn')
    const tierRow = Array.from(popover.querySelectorAll<HTMLButtonElement>('.composer-model-row-main')).find((btn) =>
      (btn.textContent ?? '').includes('tier/coder'),
    )
    assert.ok(tierRow !== undefined)
    await act(async () => {
      tierRow.click()
    })
    assert.deepEqual([...nextTurnChanges], [{ model: 'tier/coder' }])
    assert.equal(applied.length, 0)
  } finally {
    await run1.cleanup()
  }

  // 2. Staged override displays staged model + accent badge + sibling quick-clear button
  const run2 = await renderPicker({
    nextTurnMode: {
      model: 'anthropic/claude-3-7-sonnet',
      thinkingLevel: 'high',
      onChange: (override) => {
        nextTurnChanges.push(override)
      },
    },
  })
  try {
    const rootEl = run2.container.querySelector<HTMLElement>('.composer-picker-root')
    assert.equal(rootEl?.getAttribute('data-next-turn'), 'true')
    const trigger = run2.container.querySelector<HTMLButtonElement>('button.composer-model-button')
    assert.ok(trigger !== null)
    assert.match(trigger.textContent ?? '', /claude-3-7-sonnet/)
    assert.match(trigger.textContent ?? '', /high/)
    assert.match(trigger.textContent ?? '', /Next turn/)
    const clearBtn = run2.container.querySelector<HTMLButtonElement>('button.composer-model-next-turn-clear')
    assert.ok(clearBtn !== null)
    await act(async () => {
      clearBtn.click()
    })
    assert.deepEqual(nextTurnChanges.at(-1), null)
  } finally {
    await run2.cleanup()
  }

  // 3. Busy state disables Next turn only tab and initialMode invokes fallback/onChange
  const run3 = await renderPicker({
    effectiveModel: undefined,
    initialMode: {
      enabled: true,
      defaultModel: 'openai/gpt-4o-mini',
      onChange: (model) => {
        initialChanges.push(model)
      },
    },
    nextTurnMode: {
      busy: true,
      onChange: (override) => {
        nextTurnChanges.push(override)
      },
    },
  })
  try {
    const trigger = run3.container.querySelector<HTMLButtonElement>('button.composer-model-button')
    assert.ok(trigger !== null)
    assert.match(trigger.textContent ?? '', /gpt-4o-mini/)
    await act(async () => {
      trigger.click()
    })
    const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
    assert.ok(popover !== null)
    const tabs = Array.from(popover.querySelectorAll<HTMLButtonElement>('.composer-model-mode-bar [role="tab"]'))
    const nextTurnTab = tabs.find((btn) => (btn.textContent ?? '').includes('Next turn only'))
    assert.ok(nextTurnTab !== undefined)
    assert.equal(nextTurnTab.disabled, true)
    const modelRow = Array.from(popover.querySelectorAll<HTMLButtonElement>('.composer-model-row-main')).find((btn) => {
      const text = btn.textContent ?? ''
      return !text.includes('tier/') && text.includes('claude-3-7-sonnet')
    })
    assert.ok(modelRow !== undefined)
    await act(async () => {
      modelRow.click()
    })
    assert.deepEqual([...initialChanges], ['anthropic/claude-3-7-sonnet'])
  } finally {
    await run3.cleanup()
  }
})

test('ModelPickerControl SSR: variant="field" renders standard 32px/28px bordered form trigger wired to FieldContext', { timeout: 60_000 }, async () => {
  const { Field } = await import('@helmx/ui')
  const handle: CatalogHandle = {
    slice: { models: CATALOG_MODELS },
    listeners: new Set(),
  }

  const fieldHtml = renderToString(
    e(
      PluginClientHostContext.Provider,
      { value: makePort(handle) },
      e(
        Field,
        { label: 'Planner model', error: 'Model is required' },
        e(ModelPickerControl, {
          variant: 'field',
          size: 'sm',
          effectiveModel: undefined,
          activeThinkingLevel: '',
          placeholderLabel: 'Pick a model',
          onApply: () => {},
        }),
      ),
    ),
  )
  assert.match(fieldHtml, /composer-picker-root helmx-model-picker-field helmx-model-picker-sm/)
  assert.match(fieldHtml, /class="helmx-model-picker-trigger composer-model-button"/)
  assert.doesNotMatch(fieldHtml, /btn-ghost/, 'field variant must not wear ghost button classes')
  assert.match(fieldHtml, /helmx-model-picker-placeholder">Pick a model<\/span>/)
  assert.match(fieldHtml, /helmx-model-picker-chevron/)
  assert.match(fieldHtml, /role="combobox"/, 'field variant exposes combobox role matching Select')
  assert.match(fieldHtml, /aria-invalid="true"/, 'field variant emits aria-invalid="true" when enclosing Field has an error')
  assert.match(fieldHtml, /data-invalid="true"/, 'field variant mirrors data-invalid="true"')
  assert.match(fieldHtml, /aria-describedby="[^"]*-error"/, 'field variant inherits aria-describedby from enclosing Field')

  // Default variant="composer" preserves compact ghost button classes unchanged
  const composerHtml = renderToString(
    e(
      PluginClientHostContext.Provider,
      { value: makePort(handle) },
      e(ModelPickerControl, {
        effectiveModel: 'openai/gpt-4o-mini',
        activeThinkingLevel: 'medium',
        onApply: () => {},
      }),
    ),
  )
  assert.match(composerHtml, /class="btn btn-ghost btn-sm composer-model-button"/)
  assert.doesNotMatch(composerHtml, /helmx-model-picker-field/)
})

test('ModelPickerControl grouped tiers, displayLabel/displayDetail & preserveRef/singleTurnEligible filtering', { timeout: 60_000 }, async () => {
  const slice: HostModelsSlice = {
    models: CATALOG_MODELS,
    modelTiers: [
      {
        id: 'fast',
        model: 'openai/gpt-4o-mini',
        thinkingLevel: 'low',
        available: true,
        description: 'Fast ungrouped tier',
      },
      {
        id: 'claude-orch',
        model: 'anthropic/claude-3-7-sonnet',
        thinkingLevel: 'high',
        description: 'Plan then refine',
        displayGroup: 'orchestrator',
        displayLabel: 'Claude 精修',
        displayDetail: 'opus → sonnet',
        preserveRef: true,
        singleTurnEligible: false,
        available: true,
      },
    ],
  }
  const handle: CatalogHandle = { slice, listeners: new Set() }
  const applied: Array<{ model: string; thinkingLevel: string | null }> = []

  const mountPicker = async (props: Partial<ModelPickerControlProps>) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = ReactDOMClient.createRoot(container)
    await act(async () => {
      root.render(
        e(
          PluginClientHostContext.Provider,
          { value: makePort(handle) },
          e(ModelPickerControl, {
            effectiveModel: 'tier/claude-orch',
            activeThinkingLevel: 'high',
            resetLabel: 'Reset',
            resetTitle: 'Reset',
            buttonTitle: 'Model',
            onApply: (model, thinkingLevel) => {
              applied.push({ model, thinkingLevel })
            },
            ...props,
          }),
        ),
      )
    })
    return {
      container,
      cleanup: async () => {
        await act(async () => {
          root.unmount()
        })
        container.remove()
      },
    }
  }

  // 1. Trigger shows displayLabel + orchestrator icon (without thinking level suffix), popover renders grouped tiers BEFORE ungrouped tiers BEFORE models, and keyboard navigation matches
  const run1 = await mountPicker({ activeThinkingLevel: 'high' })
  try {
    const trigger = run1.container.querySelector<HTMLButtonElement>('button.composer-model-button')
    assert.ok(trigger !== null)
    assert.equal(trigger.querySelector('.composer-model-label')?.textContent?.trim(), 'Claude 精修')
    assert.ok(trigger.querySelector('.composer-model-tier-trigger-icon') !== null)
    assert.ok(trigger.querySelector('.composer-model-level') === null, 'preserveRef Orchestrator tier hides thinking level on trigger')

    await act(async () => {
      trigger.click()
    })
    const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
    assert.ok(popover !== null)
    const headers = Array.from(popover.querySelectorAll('.popover-header')).map((el) => el.textContent?.trim())
    assert.deepEqual(headers, ['Orchestrator', 'Model tiers', 'Model list'])

    const rows = Array.from(popover.querySelectorAll<HTMLButtonElement>('.composer-model-row-main'))
    assert.match(rows[0]!.textContent ?? '', /Claude 精修/)
    assert.match(rows[0]!.textContent ?? '', /opus → sonnet/)
    assert.match(rows[0]!.textContent ?? '', /Plan then refine/)
    assert.equal(rows[0]!.querySelector('.composer-model-row-name')?.classList.contains('mono'), false)
    assert.match(rows[1]!.textContent ?? '', /tier\/fast/)

    // Keyboard navigation picks index 0 -> 'tier/claude-orch'
    const search = popover.querySelector<HTMLInputElement>('input[aria-label="Search models"]')
    assert.ok(search !== null)
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.deepEqual(applied, [{ model: 'tier/claude-orch', thinkingLevel: null }])
  } finally {
    await run1.cleanup()
  }

  // 2. allowPreserveRefTiers={false} excludes preserveRef tiers
  const run2 = await mountPicker({ allowPreserveRefTiers: false, effectiveModel: 'openai/gpt-4o-mini' })
  try {
    const trigger = run2.container.querySelector<HTMLButtonElement>('button.composer-model-button')!
    await act(async () => {
      trigger.click()
    })
    const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')!
    const text = popover.textContent ?? ''
    assert.doesNotMatch(text, /Claude 精修/)
    assert.doesNotMatch(text, /Orchestrator/)
    assert.match(text, /tier\/fast/)
  } finally {
    await run2.cleanup()
  }

  // 3. Next turn only mode hides singleTurnEligible: false tiers
  const run3 = await mountPicker({
    effectiveModel: 'openai/gpt-4o-mini',
    nextTurnMode: { onChange: () => {} },
  })
  try {
    const trigger = run3.container.querySelector<HTMLButtonElement>('button.composer-model-button')!
    await act(async () => {
      trigger.click()
    })
    const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')!
    assert.match(popover.textContent ?? '', /Claude 精修/)
    const nextTurnTab = Array.from(popover.querySelectorAll<HTMLButtonElement>('.composer-model-mode-bar [role="tab"]'))
      .find((btn) => (btn.textContent ?? '').includes('Next turn only'))!
    await act(async () => {
      nextTurnTab.click()
    })
    const nextText = popover.textContent ?? ''
    assert.doesNotMatch(nextText, /Claude 精修/)
    assert.match(nextText, /tier\/fast/)
  } finally {
    await run3.cleanup()
  }
})
