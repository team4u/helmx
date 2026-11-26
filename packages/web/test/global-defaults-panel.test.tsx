/**
 * GlobalDefaultsPanel per-model thinking defaults (Settings -> Models -> Global default tab):
 * - pure row/validate helpers of `global-defaults-model.ts` (map <-> rows, partial/duplicate
 *   rejection and complete-map conversion for atomic save);
 * - panel behavior with a real happy-dom mount: saved per-model defaults render as ModelPickerControl
 *   rows, remove + save submits one empty map, and a partially filled row blocks saving with a
 *   locale error before any request.
 *
 * Import convention: `ensureHappyDom()` must run before dynamically loading the Radix dependency
 * graph (same as agent-standby / composer tests), otherwise interactive popovers cannot expand.
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { ensureHappyDom } from './helpers/dom-harness.js'
import { makeTestStore } from './helpers/store.js'

ensureHappyDom()
const { createRoot } = await import('react-dom/client')
const { ModelCenter } = await import('../src/models/ModelCenter.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const {
  modelThinkingLevelsFromRows,
  reviewModelThinkingRows,
  rowsFromModelThinkingLevels,
} = await import('../src/models/global-defaults-model.js')

const e = React.createElement

const CATALOG_MODELS = [
  { id: 'anthropic/claude-3-7-sonnet', provider: 'anthropic', modelId: 'claude-3-7-sonnet', available: true, thinkingLevels: ['off', 'low', 'high'] },
  { id: 'openai/gpt-4o-mini', provider: 'openai', modelId: 'gpt-4o-mini', available: true, thinkingLevels: ['off', 'low', 'medium'] },
]

test('global-defaults-model: rows map conversion and validation', { timeout: 60_000 }, () => {
  const rows = rowsFromModelThinkingLevels({
    'openai/gpt-4o': 'high',
    'openrouter/vendor/nested': 'max',
  })
  assert.deepEqual(rows, [
    { model: 'openai/gpt-4o', level: 'high' },
    { model: 'openrouter/vendor/nested', level: 'max' },
  ])
  assert.deepEqual(rowsFromModelThinkingLevels(undefined), [])

  // Validation: empty rows are skipped; partial and duplicate rows are rejected.
  assert.equal(reviewModelThinkingRows([]), null)
  assert.equal(reviewModelThinkingRows([{ model: '', level: '' }]), null)
  assert.deepEqual(reviewModelThinkingRows([{ model: 'p/m1', level: '' }]), { kind: 'missingLevel', model: 'p/m1' })
  assert.deepEqual(
    reviewModelThinkingRows([
      { model: 'p/m1', level: 'high' },
      { model: 'p/m1', level: 'low' },
    ]),
    { kind: 'duplicate', model: 'p/m1' },
  )

  assert.deepEqual(
    modelThinkingLevelsFromRows([
      { model: 'p/m1', level: 'max' },
      { model: 'p/m3', level: 'off' },
    ]),
    { 'p/m1': 'max', 'p/m3': 'off' },
  )
  assert.deepEqual(modelThinkingLevelsFromRows([{ model: '', level: '' }]), {})
})

interface PanelMount {
  container: HTMLElement
  putBodies: Array<Record<string, unknown>>
  unmount: () => Promise<void>
}

interface MountDefaultsOptions {
  /** Catalog models (defaults to CATALOG_MODELS). */
  models?: typeof CATALOG_MODELS
  /** Saved global default chain (defaults to an unset chain carrying only `savedMap`). */
  modelDefaults?: {
    defaultModel?: string
    defaultThinkingLevel?: string
    modelThinkingLevels?: Record<string, string>
    defaultCompactionModel?: string
    defaultCompactionThinkingLevel?: string
    modelTiers?: Array<{ id: string; model: string; thinkingLevel?: string; available: boolean; thinkingLevels?: string[] }>
  }
}

/** Mount ModelCenter on the defaults tab with a fetch mock echoing per-model pair updates. */
async function mountDefaultsPanel(savedMap: Record<string, string>, options: MountDefaultsOptions = {}): Promise<PanelMount> {
  const models = options.models ?? CATALOG_MODELS
  const savedDefaults = {
    defaultModel: '',
    defaultThinkingLevel: '',
    modelThinkingLevels: { ...savedMap },
    defaultCompactionModel: '',
    defaultCompactionThinkingLevel: '',
    ...options.modelDefaults,
  }
  const store = makeTestStore({
    primaryTarget: { kind: 'models', tab: 'defaults' },
    models,
    modelDefaults: savedDefaults,
  })
  const levels: Record<string, string> = { ...savedDefaults.modelThinkingLevels }
  const putBodies: Array<Record<string, unknown>> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : (input as URL).toString()
    if (path === '/api/models/providers') return new Response(JSON.stringify([]), { status: 200 })
    if (path === '/api/models/default' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      putBodies.push(body)
      if (body.modelThinkingLevels !== undefined) {
        for (const key of Object.keys(levels)) delete levels[key]
        Object.assign(levels, body.modelThinkingLevels)
      }
      if (body.modelThinking !== undefined) {
        if (body.modelThinkingLevel === '') delete levels[String(body.modelThinking)]
        else levels[String(body.modelThinking)] = String(body.modelThinkingLevel)
      }
      savedDefaults.defaultModel = typeof body.model === 'string' ? body.model : ''
      savedDefaults.defaultThinkingLevel = typeof body.thinkingLevel === 'string' ? body.thinkingLevel : ''
      return new Response(
        JSON.stringify({
          ok: true,
          defaultModel: savedDefaults.defaultModel,
          defaultThinkingLevel: savedDefaults.defaultThinkingLevel,
          modelThinkingLevels: { ...levels },
          defaultCompactionModel: '',
          defaultCompactionThinkingLevel: '',
        }),
        { status: 200 },
      )
    }
    if (path === '/api/models') {
      return new Response(
        JSON.stringify({
          models: models.map((m) => ({
            provider: m.provider,
            modelId: m.modelId,
            available: m.available,
          })),
          thinkingLevels: Object.fromEntries(models.map((m) => [m.id, m.thinkingLevels])),
          defaultModel: savedDefaults.defaultModel,
          defaultThinkingLevel: savedDefaults.defaultThinkingLevel,
          modelThinkingLevels: { ...levels },
          defaultCompactionModel: savedDefaults.defaultCompactionModel,
          defaultCompactionThinkingLevel: savedDefaults.defaultCompactionThinkingLevel,
          ...(savedDefaults.modelTiers !== undefined ? { modelTiers: savedDefaults.modelTiers } : {}),
        }),
        { status: 200 },
      )
    }
    // 真实 refreshAssets 会重拉资产端点：数组响应保持目录切片形状合法
    if (
      path === '/api/credentials' || path === '/api/skills' || path === '/api/profiles' ||
      path === '/api/providers' || path === '/api/actions'
    ) {
      return new Response(JSON.stringify([]), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as typeof fetch

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(e(HostStoreProviders, { value: store }, e(ModelCenter, { inlineDrawer: true })))
  })
  return {
    container,
    putBodies,
    unmount: async () => {
      globalThis.fetch = originalFetch
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

const click = (el: Element): Promise<void> =>
  act(async () => {
    ;(el as HTMLElement).click()
  })

test('GlobalDefaultsPanel: per-model rows render from saved defaults; remove + save submits an empty map', { timeout: 60_000 }, async () => {
  const panel = await mountDefaultsPanel({ 'anthropic/claude-3-7-sonnet': 'high' })
  try {
    // Saved per-model default renders as one picker row showing model + level.
    const rowBtn = panel.container.querySelector('#model-defaults-permodel-0') as HTMLButtonElement
    assert.ok(rowBtn, 'per-model row must render a ModelPickerControl trigger button')
    assert.match(rowBtn.textContent ?? '', /claude-3-7-sonnet/)
    assert.match(rowBtn.textContent ?? '', /high/)
    assert.match(panel.container.textContent ?? '', /Per-model thinking defaults/)

    // Removing the row and saving submits the complete map in the same request.
    const removeBtn = panel.container.querySelector('.model-defaults-row button[aria-label="Remove this entry"]') as HTMLButtonElement
    assert.ok(removeBtn, 'row remove icon button must render')
    await click(removeBtn)
    assert.ok(panel.container.querySelector('#model-defaults-permodel-0') === null, 'row disappears after removal')

    const saveBtn = Array.from(panel.container.querySelectorAll('button')).find(
      (btn) => (btn.textContent ?? '').includes('Save global defaults'),
    )!
    await click(saveBtn)

    assert.equal(panel.putBodies.length, 1)
    assert.deepEqual(panel.putBodies[0], {
      model: '',
      thinkingLevel: '',
      compactionModel: '',
      compactionThinkingLevel: '',
      modelThinkingLevels: {},
    })
  } finally {
    await panel.unmount()
  }
})

test('GlobalDefaultsPanel: partially filled per-model rows block saving with a locale error and no request', { timeout: 60_000 }, async () => {
  const panel = await mountDefaultsPanel({})
  try {
    const addBtn = Array.from(panel.container.querySelectorAll('button')).find(
      (btn) => (btn.textContent ?? '').includes('Add model default'),
    )!
    await click(addBtn)
    assert.ok(panel.container.querySelector('#model-defaults-permodel-0'), 'added row renders a picker')

    // Open the picker popover (portalled to document.body); clicking a row body
    // commits the model without a level, leaving the row partial (a per-model
    // default row requires an explicit level chip).
    const rowBtn = panel.container.querySelector('#model-defaults-permodel-0') as HTMLButtonElement
    await click(rowBtn)
    const popover = document.body.querySelector('.composer-model-popover')
    assert.ok(popover, 'the model picker popover opens')
    const pickBtn = Array.from(popover.querySelectorAll('button.composer-model-row-main')).find(
      (btn) => btn.textContent?.includes('claude-3-7-sonnet'),
    )
    assert.ok(pickBtn, 'model option must appear in the picker popover')
    await click(pickBtn!)
    assert.match(rowBtn.textContent ?? '', /claude-3-7-sonnet/, 'the row body click commits the model with an empty level')

    const saveBtn = Array.from(panel.container.querySelectorAll('button')).find(
      (btn) => (btn.textContent ?? '').includes('Save global defaults'),
    )!
    await click(saveBtn)
    assert.equal(panel.putBodies.length, 0, 'partial row (model without level) must block any PUT')
    assert.match(panel.container.textContent ?? '', /Set a thinking level for anthropic\/claude-3-7-sonnet/)
  } finally {
    await panel.unmount()
  }
})

test('GlobalDefaultsPanel: configured per-model default outranks the global level on the default model trigger and status row', { timeout: 60_000 }, async () => {
  const panel = await mountDefaultsPanel({}, {
    models: CATALOG_MODELS,
    modelDefaults: {
      defaultModel: 'anthropic/claude-3-7-sonnet',
      defaultThinkingLevel: 'low',
      modelThinkingLevels: { 'anthropic/claude-3-7-sonnet': 'high', 'openai/gpt-4o-mini': 'medium' },
    },
  })
  try {
    const defaultBtn = panel.container.querySelector('#model-defaults-model') as HTMLButtonElement
    assert.ok(defaultBtn)
    assert.match(defaultBtn.textContent ?? '', /claude-3-7-sonnet/)
    assert.match(defaultBtn.textContent ?? '', /· high/)
    assert.doesNotMatch(defaultBtn.textContent ?? '', /· low/)
    assert.match(panel.container.querySelector('.model-defaults-status')?.textContent ?? '', /thinking level: high/)
    assert.doesNotMatch(panel.container.querySelector('.model-defaults-status')?.textContent ?? '', /thinking level: low\)/)

    // Selecting a different level in the shared picker is explicit UI feedback, but the
    // saved global level cannot outrank an existing per-model default.
    await click(defaultBtn)
    const popover = document.body.querySelector('.composer-model-popover')
    assert.ok(popover)
    const lowChip = Array.from(popover.querySelectorAll<HTMLButtonElement>('.composer-model-level-chip')).find(
      (button) => button.textContent === 'low',
    )
    assert.ok(lowChip)
    await click(lowChip!)
    assert.match(defaultBtn.textContent ?? '', /· high/)

    // Switching to a different model immediately resolves that model's own default.
    await click(defaultBtn)
    const modelPopover = document.body.querySelector('.composer-model-popover')
    assert.ok(modelPopover)
    const modelRow = Array.from(modelPopover.querySelectorAll<HTMLButtonElement>('.composer-model-row-main')).find(
      (button) => button.textContent?.includes('gpt-4o-mini'),
    )
    assert.ok(modelRow)
    await click(modelRow!)
    assert.match(defaultBtn.textContent ?? '', /gpt-4o-mini/)
    assert.match(defaultBtn.textContent ?? '', /· medium/)
    assert.doesNotMatch(defaultBtn.textContent ?? '', /· low/)
  } finally {
    await panel.unmount()
  }
})

test('GlobalDefaultsPanel: a selected model tier shows its own preset (kernel-clamped) on the trigger and in the status row', { timeout: 60_000 }, async () => {
  const TIER_MODELS = [
    { id: 'faux/sol', provider: 'faux', modelId: 'sol', available: true, thinkingLevels: ['high', 'xhigh'] },
    { id: 'faux/omni', provider: 'faux', modelId: 'omni', available: true, thinkingLevels: ['off', 'high', 'xhigh', 'max'] },
  ]
  const TIER_TIERS = [
    // Preset the target cannot run: the kernel clamps max -> xhigh (never the lowest level high).
    { id: 'reviewer', model: 'faux/sol', thinkingLevel: 'max', available: true, thinkingLevels: ['high', 'xhigh'] },
    { id: 'scout', model: 'faux/omni', thinkingLevel: 'max', available: true, thinkingLevels: ['off', 'high', 'xhigh', 'max'] },
  ]
  const panel = await mountDefaultsPanel({}, {
    models: TIER_MODELS,
    modelDefaults: {
      defaultModel: 'tier/reviewer',
      defaultThinkingLevel: 'high',
      modelThinkingLevels: {},
      modelTiers: TIER_TIERS,
    },
  })
  try {
    const defaultBtn = panel.container.querySelector('#model-defaults-model') as HTMLButtonElement
    assert.ok(defaultBtn, 'default model row renders a ModelPickerControl trigger')
    // Saved default tier beside a stale global level: the tier preset wins and clamps like the kernel.
    assert.match(defaultBtn.textContent ?? '', /tier\/reviewer/)
    assert.match(defaultBtn.textContent ?? '', /· xhigh/)
    assert.doesNotMatch(defaultBtn.textContent ?? '', /· high/)
    assert.match(panel.container.querySelector('.model-defaults-status')?.textContent ?? '', /thinking level: xhigh/)
    assert.doesNotMatch(panel.container.querySelector('.model-defaults-status')?.textContent ?? '', /thinking level: high\)/)

    // Picking another tier from the popover immediately shows its preset on the trigger.
    await click(defaultBtn)
    const popover = document.body.querySelector('.composer-model-popover')
    assert.ok(popover, 'the model picker popover opens')
    const scoutRow = Array.from(popover.querySelectorAll('button.composer-model-row-main')).find(
      (btn) => btn.textContent?.includes('tier/scout'),
    )
    assert.ok(scoutRow, 'available tier rows list in the popover')
    await click(scoutRow!)
    assert.match(defaultBtn.textContent ?? '', /tier\/scout/)
    assert.match(defaultBtn.textContent ?? '', /· max/)

    // The tier reference persists with an empty level: the preset is intrinsic to the tier.
    const saveBtn = Array.from(panel.container.querySelectorAll('button')).find(
      (btn) => (btn.textContent ?? '').includes('Save global defaults'),
    )!
    await click(saveBtn)
    assert.equal(panel.putBodies.length, 1)
    assert.equal(panel.putBodies[0]?.model, 'tier/scout')
    assert.equal(panel.putBodies[0]?.thinkingLevel, '')
    assert.match(panel.container.querySelector('.model-defaults-status')?.textContent ?? '', /thinking level: max/)
  } finally {
    await panel.unmount()
  }
})
