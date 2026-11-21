/**
 * builtin:tiers client module (compiled TSX via @helmx/plugin-build) and ModelPickerControl
 * tier-group interactive DOM tests:
 * - TiersManagerScreen: loading state, starter 5-tier draft fill, client-side validation blocking
 *   incomplete rows, live status badges (available / unavailable), and save/apply/delete template actions;
 * - TiersSettingsPanel: summary KV projection and openScreen deep-link;
 * - ModelPickerControl: tiers section at top of popover (available tiers only), clicking a tier
 *   commits `tier/<id>`, and `allowTiers={false}` suppresses tiers to prevent recursive tier bindings.
 */
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { PluginClientContext as PluginClientContextType } from '@helmx/protocol'
import { ensureHappyDom } from './helpers/dom-harness.js'
import { makeTestStore } from './helpers/store.js'

ensureHappyDom()
const { createRoot } = await import('react-dom/client')
const { ModelPickerControl, PluginClientContext, resolveLocalizedText } = await import('@helmx/plugin-client')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const {
  importBuiltinClientModule,
  mountSharedPluginNamespaces,
  setBuiltinClientStub,
} = await import('./helpers/builtin-clients.js')

const e = React.createElement

mountSharedPluginNamespaces()

let TiersManagerScreen: (props: Record<string, unknown>) => React.ReactElement
let TiersSettingsPanel: () => React.ReactElement

before(async () => {
  const mod = await importBuiltinClientModule('builtin:tiers')
  TiersManagerScreen = mod['TiersManagerScreen'] as (props: Record<string, unknown>) => React.ReactElement
  TiersSettingsPanel = mod['TiersSettingsPanel'] as () => React.ReactElement
}, { timeout: 60_000 })

const TEST_MODELS = [
  { id: 'faux/fast', provider: 'faux', modelId: 'fast', available: true, thinkingLevels: ['off', 'low', 'high'] },
  { id: 'faux/workhorse', provider: 'faux', modelId: 'workhorse', available: true, thinkingLevels: ['off', 'medium', 'high'] },
  { id: 'faux/flagship', provider: 'faux', modelId: 'flagship', available: true, thinkingLevels: ['off', 'high', 'xhigh'] },
]

const TEST_TIERS = [
  {
    id: 'coder',
    model: 'faux/workhorse',
    thinkingLevel: 'high',
    description: 'Daily coding workhorse',
    available: true,
    thinkingLevels: ['off', 'medium', 'high'],
  },
  {
    id: 'architect',
    model: 'faux/flagship',
    thinkingLevel: 'xhigh',
    description: 'Architecture and reviews',
    available: true,
    thinkingLevels: ['off', 'high', 'xhigh'],
  },
  {
    id: 'broken',
    model: 'faux/missing',
    description: 'Should be filtered out of picker',
    available: false,
  },
  {
    id: 'muted',
    model: 'faux/fast',
    description: 'Disabled target should be filtered out',
    available: true,
    disabled: true,
  },
]

interface SpyCtx extends PluginClientContextType {
  actionCalls: Array<{ actionId: string; input: unknown }>
  openedScreens: string[]
}

function makeSpyCtx(): SpyCtx {
  const actionCalls: Array<{ actionId: string; input: unknown }> = []
  const openedScreens: string[] = []
  const base: PluginClientContextType = {
    pluginId: 'builtin:tiers',
    callAction: async (actionId, input) => {
      actionCalls.push({ actionId, input })
      return {}
    },
    submitInput: async () => {},
    openScreen: (target) => {
      openedScreens.push(target)
    },
    openSplitScreen: () => {},
    openConversationDrawer: () => {},
    openArtifact: () => {},
    openWorkbench: () => {},
    closeWorkbench: () => {},
    notify: () => {},
    getPluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    theme: 'dark',
    locale: 'en',
    translate: (text) => resolveLocalizedText(text, 'en'),
  }
  return Object.assign(base, { actionCalls, openedScreens })
}

async function mountWithHost(
  node: React.ReactNode,
  storeOverrides: Parameters<typeof makeTestStore>[0] = {},
): Promise<{ host: HTMLElement; unmount: () => Promise<void> }> {
  const store = makeTestStore({
    models: TEST_MODELS,
    modelDefaults: { modelTiers: TEST_TIERS },
    ...storeOverrides,
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(e(HostStoreProviders, { value: store }, node))
  })
  return {
    host,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    },
  }
}

function findButton(root: ParentNode, text: string): HTMLButtonElement {
  const match = Array.from(root.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(text))
  assert.ok(match, `expected button containing "${text}"`)
  return match as HTMLButtonElement
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  assert.ok(setter, 'HTMLInputElement.value setter required')
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

test('TiersManagerScreen: starter draft fill, validation guard, template save/apply/delete, and status badges', { timeout: 60_000 }, async () => {
  const ctx = makeSpyCtx()
  // 1. Loading state
  setBuiltinClientStub({ docs: {} })
  const loadingMount = await mountWithHost(
    e(PluginClientContext.Provider, { value: ctx }, e(TiersManagerScreen, { screenId: 'main' })),
  )
  assert.match(loadingMount.host.textContent ?? '', /Loading model tiers/i)
  await loadingMount.unmount()

  // 2. Empty state -> fill starter 5-tier draft -> save blocked when models are unset
  setBuiltinClientStub({ docs: { state: { tiers: {}, templates: {} } } })
  const emptyMount = await mountWithHost(
    e(PluginClientContext.Provider, { value: ctx }, e(TiersManagerScreen, { screenId: 'main' })),
  )
  try {
    assert.match(emptyMount.host.textContent ?? '', /No model tiers configured yet/i)
    await act(async () => {
      findButton(emptyMount.host, 'Fill 5-tier starter').click()
    })
    const idInputs = Array.from(emptyMount.host.querySelectorAll('.tiers-id-wrap input')) as HTMLInputElement[]
    assert.deepEqual(
      idInputs.map((i) => i.value),
      ['scout', 'coder', 'senior', 'architect', 'reviewer'],
    )
    assert.equal(
      emptyMount.host.querySelectorAll('.helmx-select-trigger, select').length,
      0,
      'TiersManagerScreen must reuse integrated ModelPickerControl instead of a separate thinking-level Select',
    )
    const starterPickers = Array.from(
      emptyMount.host.querySelectorAll('button.composer-model-button'),
    ) as HTMLButtonElement[]
    assert.equal(starterPickers.length, 5)
    assert.match(starterPickers[1]?.textContent ?? '', /suggested: high/, 'starter draft should hint suggested thinking level')
    assert.match(starterPickers[2]?.textContent ?? '', /suggested: xhigh/)
    // Attempt save with blank concrete models -> explicit error, zero action calls
    await act(async () => {
      findButton(emptyMount.host, 'Save tiers').click()
    })
    assert.match(emptyMount.host.textContent ?? '', /concrete target model/i)
    assert.equal(ctx.actionCalls.length, 0)
  } finally {
    await emptyMount.unmount()
  }

  // 3. Hydrated state with saved tiers + templates -> badges & template actions
  setBuiltinClientStub({
    docs: {
      state: {
        tiers: {
          coder: { model: 'faux/workhorse', thinkingLevel: 'high', description: 'Mainline' },
          stale: { model: 'faux/removed', description: 'Missing model' },
        },
        activeTemplate: 'daily',
        templates: {
          daily: {
            id: 'daily',
            name: 'Daily Dev',
            tiers: { coder: { model: 'faux/workhorse', thinkingLevel: 'high' } },
            updatedAt: 1_700_000_000_000,
          },
          budget: {
            id: 'budget',
            name: 'Budget Mode',
            tiers: { coder: { model: 'faux/fast', thinkingLevel: 'low' } },
            updatedAt: 1_700_000_000_100,
          },
        },
      },
    },
  })
  const fullMount = await mountWithHost(
    e(PluginClientContext.Provider, { value: ctx }, e(TiersManagerScreen, { screenId: 'main' })),
  )
  try {
    const text = fullMount.host.textContent ?? ''
    assert.match(text, /Available/)
    assert.match(text, /Unavailable/)
    assert.match(text, /Daily Dev/)
    assert.match(text, /Budget Mode/)

    // Mutate local draft so editor is dirty, then apply first row's template (`budget`, sorted newest first):
    // draft must immediately replace unsaved rows with the applied template's tiers (`coder` only).
    await act(async () => {
      findButton(fullMount.host, 'Add tier').click()
    })
    assert.equal(fullMount.host.querySelectorAll('.tiers-id-wrap input').length, 3)
    await act(async () => {
      findButton(fullMount.host, 'Apply').click()
    })
    assert.deepEqual(ctx.actionCalls[0], { actionId: 'apply_template', input: { id: 'budget' } })
    const afterApplyIds = Array.from(fullMount.host.querySelectorAll('.tiers-id-wrap input')).map(
      (el) => (el as HTMLInputElement).value,
    )
    assert.deepEqual(afterApplyIds, ['coder'], 'applying a template must sync draft rows even when local edits were dirty')

    // Delete first row's template (`budget`)
    await act(async () => {
      findButton(fullMount.host, 'Delete').click()
    })
    assert.deepEqual(ctx.actionCalls[1], { actionId: 'delete_template', input: { id: 'budget' } })

    // Save current active tiers as a new template
    const tplInputs = Array.from(fullMount.host.querySelectorAll('.tiers-template-form input')) as HTMLInputElement[]
    assert.ok(tplInputs.length >= 2)
    const [tplIdInput, tplNameInput] = tplInputs as [HTMLInputElement, HTMLInputElement]
    await act(async () => {
      setInputValue(tplIdInput, 'custom-1')
      setInputValue(tplNameInput, 'Custom Roster')
    })
    await act(async () => {
      findButton(fullMount.host, 'Save template').click()
    })
    assert.deepEqual(ctx.actionCalls[2], {
      actionId: 'save_template',
      input: { id: 'custom-1', name: 'Custom Roster' },
    })

    // Earlier we applied `budget` -> draft has `coder: faux/fast · low`. Verify integrated trigger + inline chips!
    const pickerBtn = fullMount.host.querySelector('button.composer-model-button') as HTMLButtonElement | null
    assert.ok(pickerBtn, 'expected integrated ModelPickerControl button')
    assert.match(pickerBtn.textContent ?? '', /fast/)
    assert.match(pickerBtn.textContent ?? '', /low/)

    // 1) Click inline thinking chip (`xhigh` on `faux/flagship`) -> updates model + thinkingLevel together and saves
    await act(async () => {
      pickerBtn.click()
    })
    assert.doesNotMatch(document.body.textContent ?? '', /Model tiers/, 'allowTiers=false must suppress tiers inside tier editor')
    const flagshipRow = Array.from(document.body.querySelectorAll<HTMLElement>('.composer-model-row')).find((row) =>
      (row.querySelector('.composer-model-row-main') as HTMLButtonElement | null)?.title.includes('faux/flagship'),
    )
    assert.ok(flagshipRow, 'expected faux/flagship row in integrated popover')
    const xhighChip = Array.from(flagshipRow.querySelectorAll<HTMLButtonElement>('.composer-model-level-chip')).find(
      (btn) => btn.textContent?.trim() === 'xhigh',
    )
    assert.ok(xhighChip, 'expected inline xhigh chip on flagship row')
    await act(async () => {
      xhighChip.click()
    })
    assert.match(pickerBtn.textContent ?? '', /flagship/)
    assert.match(pickerBtn.textContent ?? '', /xhigh/)
    await act(async () => {
      findButton(fullMount.host, 'Save tiers').click()
    })
    assert.deepEqual(ctx.actionCalls[3], {
      actionId: 'replace',
      input: {
        tiers: {
          coder: { model: 'faux/flagship', thinkingLevel: 'xhigh' },
        },
      },
    })

    // 2) Click model row body (`faux/workhorse`) -> updates model and resets thinkingLevel to follow default chain
    await act(async () => {
      pickerBtn.click()
    })
    const workhorseRowMain = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.composer-model-row-main')).find(
      (btn) => btn.title.includes('faux/workhorse'),
    )
    assert.ok(workhorseRowMain, 'expected faux/workhorse row body button')
    await act(async () => {
      workhorseRowMain.click()
    })
    assert.match(pickerBtn.textContent ?? '', /workhorse/)
    assert.doesNotMatch(pickerBtn.textContent ?? '', /xhigh/)
    await act(async () => {
      findButton(fullMount.host, 'Save tiers').click()
    })
    assert.deepEqual(ctx.actionCalls[4], {
      actionId: 'replace',
      input: {
        tiers: {
          coder: { model: 'faux/workhorse' },
        },
      },
    })

    // 3) Click reset item (`Clear model & level`) -> clears both model and thinkingLevel back to Draft
    await act(async () => {
      pickerBtn.click()
    })
    await act(async () => {
      findButton(document.body, 'Clear model & level').click()
    })
    assert.match(pickerBtn.textContent ?? '', /Select model & thinking level/)
    assert.match(fullMount.host.textContent ?? '', /Draft/)
  } finally {
    await fullMount.unmount()
  }
})

test('TiersSettingsPanel: shows summary KV and opens full screen target', { timeout: 60_000 }, async () => {
  const ctx = makeSpyCtx()
  setBuiltinClientStub({
    docs: {
      state: {
        tiers: {
          scout: { model: 'faux/fast' },
          coder: { model: 'faux/workhorse' },
        },
        activeTemplate: 'daily',
        templates: {
          daily: { id: 'daily', name: 'Daily Dev', tiers: {}, updatedAt: 1 },
        },
      },
    },
  })
  const mounted = await mountWithHost(
    e(PluginClientContext.Provider, { value: ctx }, e(TiersSettingsPanel)),
  )
  try {
    const text = mounted.host.textContent ?? ''
    assert.match(text, /Daily Dev/)
    assert.match(text, /2/)
    await act(async () => {
      findButton(mounted.host, 'Open Model Tiers').click()
    })
    assert.deepEqual(ctx.openedScreens, ['screen:builtin:tiers/main'])
  } finally {
    await mounted.unmount()
  }
})

test('ModelPickerControl: lists available tiers at top, commits tier/<id> on click, and hides tiers when allowTiers=false', { timeout: 60_000 }, async () => {
  const applied: Array<{ model: string; level: string | null }> = []
  const mounted = await mountWithHost(
    e(ModelPickerControl, {
      effectiveModel: 'faux/workhorse',
      activeThinkingLevel: 'high',
      resetLabel: 'Reset',
      resetTitle: 'Reset',
      buttonTitle: 'Model',
      onApply: (model: string, level: string | null) => {
        applied.push({ model, level })
      },
      onResetDefault: () => {},
    }),
  )
  try {
    const trigger = mounted.host.querySelector('button.composer-model-button') as HTMLButtonElement
    assert.ok(trigger)
    await act(async () => {
      trigger.click()
    })
    const popoverText = document.body.textContent ?? ''
    assert.match(popoverText, /Model tiers/)
    assert.match(popoverText, /tier\/coder/)
    assert.match(popoverText, /tier\/architect/)
    assert.doesNotMatch(popoverText, /tier\/broken/, 'unavailable tiers must not appear in picker')
    assert.doesNotMatch(popoverText, /tier\/muted/, 'disabled target tiers must not appear in picker')

    // Click tier/architect row
    const archBtn = Array.from(document.body.querySelectorAll('button.composer-model-row-main')).find((b) =>
      (b.textContent ?? '').includes('tier/architect'),
    ) as HTMLButtonElement | undefined
    assert.ok(archBtn, 'expected tier/architect option in popover')
    await act(async () => {
      archBtn.click()
    })
    assert.deepEqual(applied, [{ model: 'tier/architect', level: null }])
  } finally {
    await mounted.unmount()
  }

  // allowTiers={false} suppresses tiers section completely
  const noTiersMount = await mountWithHost(
    e(ModelPickerControl, {
      effectiveModel: 'faux/workhorse',
      activeThinkingLevel: 'high',
      allowTiers: false,
      resetLabel: 'Reset',
      resetTitle: 'Reset',
      buttonTitle: 'Model',
      onApply: () => {},
      onResetDefault: () => {},
    }),
  )
  try {
    const trigger = noTiersMount.host.querySelector('button.composer-model-button') as HTMLButtonElement
    assert.ok(trigger)
    await act(async () => {
      trigger.click()
    })
    const popoverText = document.body.textContent ?? ''
    assert.doesNotMatch(popoverText, /Model tiers/)
    assert.doesNotMatch(popoverText, /tier\/architect/)
    assert.match(popoverText, /workhorse/)
  } finally {
    await noTiersMount.unmount()
  }
})
