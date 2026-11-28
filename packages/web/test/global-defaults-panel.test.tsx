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
import { deferred, waitFor } from '@helmx/test-kit'
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
  requestedPaths: string[]
  store: ReturnType<typeof makeTestStore>
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
    modelTiers?: Array<{
      id: string
      model: string
      thinkingLevel?: string
      description?: string
      displayGroup?: string
      displayLabel?: string
      displayDetail?: string
      preserveRef?: boolean
      singleTurnEligible?: boolean
      available: boolean
      thinkingLevels?: string[]
    }>
  }
  /** Optional interceptor for fetch requests (returning a Response overrides the default mock; returning undefined falls through). */
  onRequest?: (path: string, init?: RequestInit) => Promise<Response | undefined> | Response | undefined
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
  const requestedPaths: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : (input as URL).toString()
    requestedPaths.push(path)
    if (options.onRequest) {
      const custom = await options.onRequest(path, init)
      if (custom !== undefined) return custom
    }
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
    requestedPaths,
    store,
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
    assert.equal(saveBtn.disabled, false, 'validation early return must clear saving state')
    assert.notEqual(saveBtn.getAttribute('aria-busy'), 'true')
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

test('GlobalDefaultsPanel: save recovers clickable state after refreshAssets updates defaultModelInfo mid-save and supports a second save', { timeout: 60_000 }, async () => {
  // Hold the first refreshAssets `/api/profiles` call after `/api/models` resolves so React
  // flushes the updated `defaultModelInfo` effect before `handleSave` enters `finally`.
  const firstProfilesGate = deferred<Response>()
  let profilesCalls = 0
  const panel = await mountDefaultsPanel({}, {
    modelDefaults: {
      defaultModel: 'anthropic/claude-3-7-sonnet',
      defaultThinkingLevel: 'low',
    },
    onRequest: async (path) => {
      if (path === '/api/profiles') {
        profilesCalls += 1
        if (profilesCalls === 1) return firstProfilesGate.promise
      }
      return undefined
    },
  })
  try {
    const findSaveBtn = () =>
      Array.from(panel.container.querySelectorAll('button')).find(
        (btn) => (btn.textContent ?? '').includes('Save global defaults') || (btn.textContent ?? '').includes('Saving'),
      ) as HTMLButtonElement

    // Pick another model before saving so `defaultModelInfo` changes after save.
    const defaultBtn = panel.container.querySelector('#model-defaults-model') as HTMLButtonElement
    await click(defaultBtn)
    const popover = document.body.querySelector('.composer-model-popover')
    assert.ok(popover)
    const gptRow = Array.from(popover.querySelectorAll('button.composer-model-row-main')).find(
      (btn) => btn.textContent?.includes('gpt-4o-mini'),
    )
    assert.ok(gptRow)
    await click(gptRow!)

    const saveBtn = findSaveBtn()
    assert.equal(saveBtn.disabled, false)

    // Trigger save; `/api/models` resolves and updates `defaultModelInfo` while `/api/profiles` is still pending.
    await click(saveBtn)
    assert.equal(panel.putBodies.length, 1)
    assert.equal(panel.putBodies[0]?.model, 'openai/gpt-4o-mini')
    assert.equal(saveBtn.disabled, true, 'save button stays pending while refreshAssets awaits /api/profiles')
    assert.equal(saveBtn.getAttribute('aria-busy'), 'true')

    // Complete `/api/profiles` so `handleSave` finishes after `useEffect([defaultModelInfo])` already ran.
    await act(async () => {
      firstProfilesGate.resolve(new Response(JSON.stringify([]), { status: 200 }))
    })

    const recoveredBtn = findSaveBtn()
    assert.equal(recoveredBtn.disabled, false, 'save button must recover clickable state after defaultModelInfo syncs')
    assert.notEqual(recoveredBtn.getAttribute('aria-busy'), 'true')
    assert.match(recoveredBtn.textContent ?? '', /Save global defaults/)
    assert.ok(panel.container.querySelector('[role="status"]') === null, 'save success must not render inline status text')
    assert.doesNotMatch(panel.container.textContent ?? '', /Configuration saved/)
    assert.equal(
      panel.store.getSnapshot().notices.some((n) => n.level === 'info' && n.title === 'Global default model updated'),
      true,
      'save success must push unified info toast',
    )

    // Switch back to claude-3-7-sonnet and save a second time to verify interactivity is restored.
    await click(defaultBtn)
    const secondPopover = document.body.querySelector('.composer-model-popover')
    assert.ok(secondPopover)
    const claudeRow = Array.from(secondPopover.querySelectorAll('button.composer-model-row-main')).find(
      (btn) => btn.textContent?.includes('claude-3-7-sonnet'),
    )
    assert.ok(claudeRow)
    await click(claudeRow!)

    await click(recoveredBtn)
    assert.equal(panel.putBodies.length, 2)
    assert.equal(panel.putBodies[1]?.model, 'anthropic/claude-3-7-sonnet')
    assert.equal(findSaveBtn().disabled, false)
  } finally {
    firstProfilesGate.resolve(new Response(JSON.stringify([]), { status: 200 }))
    await panel.unmount()
  }
})

test('GlobalDefaultsPanel: external defaultModelInfo sync during in-flight PUT skips stale onSaved/notice but clears saving for retry', { timeout: 60_000 }, async () => {
  const firstPutGate = deferred<Response>()
  let putCalls = 0
  let externalDefaultModel = 'anthropic/claude-3-7-sonnet'
  const panel = await mountDefaultsPanel({}, {
    modelDefaults: {
      defaultModel: 'anthropic/claude-3-7-sonnet',
      defaultThinkingLevel: 'low',
    },
    onRequest: (path, init) => {
      if (path === '/api/models/default' && init?.method === 'PUT') {
        putCalls += 1
        if (putCalls === 1) return firstPutGate.promise
      }
      if (path === '/api/models' && putCalls === 1) {
        return new Response(
          JSON.stringify({
            models: CATALOG_MODELS.map((m) => ({
              provider: m.provider,
              modelId: m.modelId,
              available: m.available,
            })),
            thinkingLevels: Object.fromEntries(CATALOG_MODELS.map((m) => [m.id, m.thinkingLevels])),
            defaultModel: externalDefaultModel,
            defaultThinkingLevel: 'high',
            modelThinkingLevels: {},
            defaultCompactionModel: '',
            defaultCompactionThinkingLevel: '',
          }),
          { status: 200 },
        )
      }
      return undefined
    },
  })
  try {
    const findSaveBtn = () =>
      Array.from(panel.container.querySelectorAll('button')).find(
        (btn) => (btn.textContent ?? '').includes('Save global defaults') || (btn.textContent ?? '').includes('Saving'),
      ) as HTMLButtonElement

    await click(findSaveBtn())
    assert.equal(findSaveBtn().disabled, true)

    // Trigger an external store refresh while the PUT is still pending.
    externalDefaultModel = 'openai/gpt-4o-mini'
    await act(async () => {
      await panel.store.actions.refreshAssets()
    })
    assert.equal(findSaveBtn().disabled, true, 'button remains pending until the active PUT finishes')
    assert.match(panel.container.querySelector('.model-defaults-status')?.textContent ?? '', /openai\/gpt-4o-mini/)
    const pathsBeforeStaleResolve = panel.requestedPaths.length

    await act(async () => {
      firstPutGate.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            defaultModel: 'anthropic/claude-3-7-sonnet',
            defaultThinkingLevel: 'low',
            modelThinkingLevels: {},
            defaultCompactionModel: '',
            defaultCompactionThinkingLevel: '',
          }),
          { status: 200 },
        ),
      )
    })

    // Stale PUT must not overwrite external state via onSaved/refreshAssets or emit success notice/status.
    assert.equal(panel.requestedPaths.length, pathsBeforeStaleResolve, 'stale PUT response must skip refreshAssets')
    assert.match(
      panel.container.querySelector('.model-defaults-status')?.textContent ?? '',
      /openai\/gpt-4o-mini/,
      'stale PUT response must not overwrite externally synced defaultModelInfo via onSaved',
    )
    assert.ok(panel.container.querySelector('[role="status"]') === null, 'stale PUT must not show success status')
    assert.equal(panel.store.getSnapshot().notices.length, 0, 'stale PUT must not push success notice')

    // Button still recovers clickable state and subsequent normal save succeeds.
    const recoveredBtn = findSaveBtn()
    assert.equal(recoveredBtn.disabled, false)
    assert.notEqual(recoveredBtn.getAttribute('aria-busy'), 'true')

    await click(recoveredBtn)
    assert.equal(putCalls, 2)
    assert.equal(findSaveBtn().disabled, false)
    assert.ok(panel.container.querySelector('[role="status"]') === null, 'save success must not render inline status text')
    assert.equal(panel.store.getSnapshot().notices.length, 1)
    assert.equal(panel.store.getSnapshot().notices[0]?.level, 'info')
    assert.equal(panel.store.getSnapshot().notices[0]?.title, 'Global default model updated')
  } finally {
    firstPutGate.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          defaultModel: 'anthropic/claude-3-7-sonnet',
          defaultThinkingLevel: 'low',
          modelThinkingLevels: {},
          defaultCompactionModel: '',
          defaultCompactionThinkingLevel: '',
        }),
        { status: 200 },
      ),
    )
    await panel.unmount()
  }
})

test('GlobalDefaultsPanel: save failure clears saving state and allows retrying', { timeout: 60_000 }, async () => {
  let shouldFail = true
  const panel = await mountDefaultsPanel({}, {
    modelDefaults: {
      defaultModel: 'anthropic/claude-3-7-sonnet',
      defaultThinkingLevel: 'high',
    },
    onRequest: (path, init) => {
      if (path === '/api/models/default' && init?.method === 'PUT' && shouldFail) {
        return new Response(JSON.stringify({ error: 'Save failed on server' }), { status: 500 })
      }
      return undefined
    },
  })
  try {
    const findSaveBtn = () =>
      Array.from(panel.container.querySelectorAll('button')).find(
        (btn) => (btn.textContent ?? '').includes('Save global defaults') || (btn.textContent ?? '').includes('Saving'),
      ) as HTMLButtonElement

    await click(findSaveBtn())
    assert.equal(findSaveBtn().disabled, false, 'failed save must reset pending state')
    assert.notEqual(findSaveBtn().getAttribute('aria-busy'), 'true')
    assert.ok(panel.container.querySelector('[role="alert"]'), 'failed save must surface an error callout')

    shouldFail = false
    await click(findSaveBtn())
    assert.equal(panel.putBodies.length, 1)
    assert.equal(findSaveBtn().disabled, false)
    assert.ok(panel.container.querySelector('[role="alert"]') === null)
    assert.ok(panel.container.querySelector('[role="status"]') === null, 'save success must not render inline status text')
    assert.doesNotMatch(panel.container.textContent ?? '', /Configuration saved/)
    assert.equal(
      panel.store.getSnapshot().notices.some((n) => n.level === 'info' && n.title === 'Global default model updated'),
      true,
      'save success must push unified info toast',
    )
  } finally {
    await panel.unmount()
  }
})

test('GlobalDefaultsPanel: unmounting while save is in flight suppresses post-unmount refresh and state updates', { timeout: 60_000 }, async () => {
  const putGate = deferred<Response>()
  const panel = await mountDefaultsPanel({}, {
    modelDefaults: {
      defaultModel: 'anthropic/claude-3-7-sonnet',
      defaultThinkingLevel: 'high',
    },
    onRequest: (path, init) => {
      if (path === '/api/models/default' && init?.method === 'PUT') {
        return putGate.promise
      }
      return undefined
    },
  })

  const mockedFetch = globalThis.fetch

  const saveBtn = Array.from(panel.container.querySelectorAll('button')).find(
    (btn) => (btn.textContent ?? '').includes('Save global defaults'),
  ) as HTMLButtonElement
  await click(saveBtn)
  assert.equal(saveBtn.disabled, true)
  const pathsBeforeUnmount = panel.requestedPaths.length

  await panel.unmount()
  const restoredFetch = globalThis.fetch
  globalThis.fetch = mockedFetch
  try {
    // Resolve the in-flight PUT after unmount; no refreshAssets or state updates should follow.
    await act(async () => {
      putGate.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            defaultModel: 'anthropic/claude-3-7-sonnet',
            defaultThinkingLevel: 'high',
            modelThinkingLevels: {},
            defaultCompactionModel: '',
            defaultCompactionThinkingLevel: '',
          }),
          { status: 200 },
        ),
      )
      await Promise.resolve()
    })
    assert.equal(panel.requestedPaths.length, pathsBeforeUnmount)
  } finally {
    globalThis.fetch = restoredFetch
  }
})

test('GlobalDefaultsPanel: defaultModel includes preserveRef tiers while compactionModel excludes them', { timeout: 60_000 }, async () => {
  const panel = await mountDefaultsPanel({}, {
    modelDefaults: {
      defaultModel: 'tier/claude-duo',
      defaultThinkingLevel: 'high',
      modelTiers: [
        {
          id: 'fast',
          model: 'openai/gpt-4o-mini',
          available: true,
          thinkingLevels: ['off', 'low', 'medium'],
        },
        {
          id: 'claude-duo',
          model: 'anthropic/claude-3-7-sonnet',
          displayGroup: 'duo',
          displayLabel: 'Claude Duo',
          displayDetail: 'sonnet -> mini',
          preserveRef: true,
          singleTurnEligible: false,
          available: true,
          thinkingLevels: ['off', 'low', 'high'],
        },
      ],
    },
  })
  try {
    const defaultTrigger = panel.container.querySelector('#model-defaults-model') as HTMLButtonElement
    assert.ok(defaultTrigger, 'default model trigger must exist')
    assert.equal(defaultTrigger.querySelector('.composer-model-label')?.textContent?.trim(), 'Claude Duo')
    assert.ok(defaultTrigger.querySelector('.composer-model-level') === null)
    await click(defaultTrigger)
    const defaultPop = document.body.querySelector<HTMLElement>('.composer-model-popover')!
    assert.match(defaultPop.textContent ?? '', /Orchestrator/)
    assert.match(defaultPop.textContent ?? '', /Claude Duo/)
    assert.match(defaultPop.textContent ?? '', /tier\/fast/)

    // Select tier/fast row to commit & close default popover cleanly, wait for in-flight save to settle, then open compaction picker -> preserveRef tier hidden
    const fastRow = Array.from(defaultPop.querySelectorAll<HTMLButtonElement>('.composer-model-row-main'))
      .find((btn) => (btn.textContent ?? '').includes('tier/fast'))!
    await click(fastRow)
    assert.ok(document.body.querySelector('.composer-model-popover') === null)
    const compactionTrigger = panel.container.querySelector('#model-defaults-compaction-model') as HTMLButtonElement
    assert.ok(compactionTrigger, 'compaction model trigger must exist')
    await waitFor(() => !compactionTrigger.disabled)
    await click(compactionTrigger)
    const compactionPop = document.body.querySelector<HTMLElement>('.composer-model-popover')
    assert.ok(compactionPop !== null, 'compaction picker popover must open')
    assert.doesNotMatch(compactionPop.textContent ?? '', /Claude Duo/)
    assert.match(compactionPop.textContent ?? '', /tier\/fast/)
  } finally {
    await panel.unmount()
  }
})
