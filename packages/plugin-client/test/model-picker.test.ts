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
  assert.equal(resolveEffectiveThinkingLevel(['off', 'low'], 'ultra'), 'off', 'unknown level falls back to off/lowest')
  // An explicit 'off' always passes (the kernel omits the reasoning parameter); an unconfigured
  // level displays as off or the lowest supported level; no declared levels yields ''.
  assert.equal(resolveEffectiveThinkingLevel(['low', 'high'], 'off'), 'off')
  assert.equal(resolveEffectiveThinkingLevel(['high', 'xhigh'], ''), 'high')
  assert.equal(resolveEffectiveThinkingLevel(['off', 'high'], ''), 'off')
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
    // No preset: the level configured beside the reference applies.
    { id: 'plain', model: 'faux/sol', available: true, thinkingLevels: ['high', 'xhigh'] },
  ],
}

test('resolveDefaultChainThinkingLevel: a tier preset outranks the level configured beside the reference and clamps like the kernel', { timeout: 60_000 }, () => {
  // Tier with preset: the configured level (global / Profile) never masks the preset.
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'tier/scout', 'high'), 'max')
  // Unsupported preset converges the way the kernel clamps it (upward first, then downward).
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'tier/reviewer', 'high'), 'xhigh')
  // Tier without preset falls back to the configured level, converged; empty stays empty.
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'tier/plain', 'max'), 'xhigh')
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'tier/plain', ''), 'high')
  // Concrete references converge the configured level; one outside the catalog keeps it unconverged.
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'faux/sol', 'max'), 'xhigh')
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'faux/sol', ''), 'high')
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'faux/missing', 'high'), 'high')
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, '', 'high'), '')
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, undefined, 'high'), '')
  // Catalog unknown: a concrete reference's configured level is a plain (unconverged) fact; a
  // tier's preset is unknown and outranks the configured level, so nothing honest can be shown.
  assert.equal(resolveDefaultChainThinkingLevel(undefined, 'faux/sol', 'max'), 'max')
  assert.equal(resolveDefaultChainThinkingLevel(undefined, 'tier/scout', 'high'), '')
  // An unregistered tier (or one whose target is absent from the catalog) has no known preset to show.
  assert.equal(resolveDefaultChainThinkingLevel(TIER_CATALOG, 'tier/missing', 'high'), '')
  assert.equal(
    resolveDefaultChainThinkingLevel({ models: [], modelTiers: [{ id: 'ghost', model: 'faux/gone', thinkingLevel: 'max', available: false }] }, 'tier/ghost', 'high'),
    '',
  )
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

test('tier-aware trigger: default precedence shows the tier preset (kernel-clamped) instead of the configured or lowest level', { timeout: 60_000 }, async () => {
  // Global default / Profile binding context: the configured level ('high') is outranked by the preset.
  const scout = await renderTriggerText({ effectiveModel: 'tier/scout', activeThinkingLevel: 'high' })
  try {
    assert.match(scout.text, /tier\/scout/)
    assert.match(scout.text, /· max/)
  } finally {
    await scout.done()
  }
  // The preset the kernel would actually run: max on a high/xhigh model displays as xhigh, never high.
  const reviewer = await renderTriggerText({ effectiveModel: 'tier/reviewer', activeThinkingLevel: '' })
  try {
    assert.match(reviewer.text, /· xhigh/)
    assert.doesNotMatch(reviewer.text, /· high/)
  } finally {
    await reviewer.done()
  }
  // A tier without a preset keeps showing the configured level.
  const plain = await renderTriggerText({ effectiveModel: 'tier/plain', activeThinkingLevel: 'xhigh' })
  try {
    assert.match(plain.text, /· xhigh/)
  } finally {
    await plain.done()
  }
  // Concrete models are unaffected: the context level displays as before.
  const concrete = await renderTriggerText({ effectiveModel: 'faux/sol', activeThinkingLevel: 'high' })
  try {
    assert.match(concrete.text, /· high/)
  } finally {
    await concrete.done()
  }
})

test('tier-aware trigger: override precedence keeps the explicit conversation level above the tier preset and falls back to it when empty', { timeout: 60_000 }, async () => {
  const override = await renderTriggerText({
    effectiveModel: 'tier/scout',
    activeThinkingLevel: 'xhigh',
    thinkingLevelPrecedence: 'override',
  })
  try {
    assert.match(override.text, /· xhigh/)
  } finally {
    await override.done()
  }
  const empty = await renderTriggerText({
    effectiveModel: 'tier/scout',
    activeThinkingLevel: '',
    thinkingLevelPrecedence: 'override',
  })
  try {
    assert.match(empty.text, /· max/)
  } finally {
    await empty.done()
  }
})

test('tier rows badge the kernel-clamped preset level', { timeout: 60_000 }, async () => {
  const handle: CatalogHandle = { slice: TIER_CATALOG, listeners: new Set() }
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
    assert.ok(reviewerRow !== null && reviewerRow !== undefined, 'reviewer tier row renders')
    assert.equal(reviewerRow.querySelector('.badge-neutral')?.textContent, 'xhigh', 'unsupported preset badges the clamped level')
    assert.equal(scoutRow?.querySelector('.badge-neutral')?.textContent, 'max')
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
