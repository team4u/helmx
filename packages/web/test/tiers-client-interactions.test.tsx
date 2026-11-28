/**
 * builtin:tiers client module (compiled TSX via @helmx/plugin-build) and ModelPickerControl
 * tier-group interactive DOM tests:
 * - TiersManagerScreen: loading state, empty starter quick-start cards, DetailDrawer create/edit
 *   validation & atomic set/remove actions, search filtering, template tabs/apply/delete &
 *   SaveTemplateDialog, per-model thinking defaults, and useScreenDrawer history semantics;
 * - TiersSettingsPanel: summary KV projection and openScreen deep-link;
 * - ModelPickerControl: tiers section at top of popover (available tiers only), clicking a tier
 *   commits `tier/<id>`, `allowTiers={false}` suppresses tiers, controlled/anchor mode, and
 *   desktop vs coarse-touch auto-focus.
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { PluginClientContext as PluginClientContextType } from '@helmx/protocol'
import { TIERS_COPY } from '../../plugins/src/tiers/client/copy.ts'
import {
  TIERS_PLUGIN_ID,
  TIERS_SCREEN_ID,
  TIERS_STATE_DOC,
  filterTierItems,
  parseTiersStateDoc,
  synthesizeTierItems,
  validateTierDraft,
} from '../../plugins/src/tiers/client/models.ts'
import { ensureHappyDom } from './helpers/dom-harness.js'
import { makeTestStore } from './helpers/store.js'

ensureHappyDom()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { resolveLocalizedText } = await import('@helmx/ui')
const {
  ModelPickerControl,
  PluginClientContext,
} = await import('@helmx/plugin-client')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const {
  importBuiltinClientModule,
  mountSharedPluginNamespaces,
  setBuiltinClientStub,
} = await import('./helpers/builtin-clients.js')

const e = React.createElement
const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u

let rawTiersModule: Record<string, unknown>
let TiersManagerScreen: (props: Record<string, unknown>) => React.ReactElement
let TiersSettingsPanel: () => React.ReactElement

describe('tiers-client-interactions', () => {
  before(async () => {
    mountSharedPluginNamespaces()
    const mod = await importBuiltinClientModule('builtin:tiers')
    rawTiersModule = mod
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
    notifications: Array<{ message: string; tone: string }>
  }

  function makeSpyCtx(locale: 'en' | 'zh-CN' = 'en'): SpyCtx {
    const actionCalls: Array<{ actionId: string; input: unknown }> = []
    const openedScreens: string[] = []
    const notifications: Array<{ message: string; tone: string }> = []
    const base: PluginClientContextType = {
      pluginId: 'builtin:tiers',
      callAction: async (actionId, input) => {
        actionCalls.push({ actionId, input })
        return {}
      },
      fetchRoute: async () => { throw new Error('fetchRoute not implemented in test stub') },
      submitInput: async () => {},
      openScreen: (target) => {
        openedScreens.push(target)
      },
      openSplitScreen: () => {},
      openConversationDrawer: () => {},
      openArtifact: () => {},
      openWorkbench: () => {},
      closeWorkbench: () => {},
      notify: (message, tone = 'info') => {
        notifications.push({ message, tone })
      },
      getPluginDoc: async () => undefined,
      getPluginSessionDoc: async () => undefined,
      theme: 'dark',
      locale,
      translate: (text) => resolveLocalizedText(text, locale),
    }
    return Object.assign(base, { actionCalls, openedScreens, notifications })
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

  test('TiersManagerScreen: loading, starter cards, drawer validation/create/edit/delete, search filtering, and template tabs/dialog', { timeout: 60_000 }, async () => {
    const ctx = makeSpyCtx()
    // 1. Loading state
    setBuiltinClientStub({ docs: {} })
    const loadingMount = await mountWithHost(
      e(PluginClientContext.Provider, { value: ctx }, e(TiersManagerScreen, { screenId: 'main' })),
    )
    assert.match(loadingMount.host.textContent ?? '', /Loading model tiers/i)
    await loadingMount.unmount()

    // 2. Empty state -> 5 starter quick-start rows -> click `coder` opens create drawer -> save blocked when model unset
    setBuiltinClientStub({ docs: { state: { tiers: {}, templates: {} } } })
    const emptyMount = await mountWithHost(
      e(PluginClientContext.Provider, { value: ctx }, e(TiersManagerScreen, { screenId: 'main' })),
    )
    try {
      assert.match(emptyMount.host.textContent ?? '', /No model tiers yet/i)
      assert.match(emptyMount.host.textContent ?? '', /Starter tiers/i)
      const starterRows = Array.from(emptyMount.host.querySelectorAll<HTMLElement>('.helmx-list-row[data-starter-tier]'))
      assert.deepEqual(
        starterRows.map((row) => row.getAttribute('data-starter-tier')),
        ['scout', 'coder', 'senior', 'architect', 'reviewer'],
      )
      const coderStarterTrigger = emptyMount.host.querySelector<HTMLButtonElement>(
        '.helmx-list-row[data-starter-tier="coder"] .helmx-list-row-trigger',
      )
      assert.ok(coderStarterTrigger !== null, 'expected coder starter row trigger')
      await act(async () => {
        coderStarterTrigger.click()
      })
      const drawer = document.body.querySelector<HTMLElement>('.tiers-drawer')
      assert.ok(drawer !== null, 'clicking starter row opens DetailDrawer')
      const idInput = drawer.querySelector<HTMLInputElement>('.helmx-input-wrap input')
      assert.ok(idInput !== null)
      assert.equal(idInput.value, 'coder')
      assert.equal(idInput.disabled, false)
      assert.equal(
        drawer.querySelectorAll('.helmx-select-trigger, select').length,
        0,
        'TiersManagerScreen drawer must reuse integrated ModelPickerControl instead of a separate thinking-level Select',
      )
      const drawerPicker = drawer.querySelector<HTMLButtonElement>('button.helmx-model-picker-trigger')
      assert.ok(drawerPicker !== null)
      assert.match(drawerPicker.textContent ?? '', /suggested: high/, 'starter preset hints suggested thinking level')

      await act(async () => {
        findButton(document.body, 'Create').click()
      })
      assert.match(drawer.textContent ?? '', /concrete target model/i)
      assert.equal(ctx.actionCalls.length, 0)
    } finally {
      await emptyMount.unmount()
    }

    // 3. Hydrated state with saved tiers + templates -> list rows, search filter, drawer edit/set, delete, and templates tab/dialog
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
      assert.match(text, /tier\/coder/)
      assert.match(text, /tier\/stale/)
      assert.equal(EMOJI_RE.test(text), false)
      assert.equal(fullMount.host.querySelectorAll('.helmx-list-row[data-tier-id]').length, 2)

      // Search box filters rows accurately
      const searchInput = fullMount.host.querySelector<HTMLInputElement>('input[aria-label*="Search tiers"]')
      assert.ok(searchInput !== null)
      await act(async () => {
        setInputValue(searchInput, 'stale')
      })
      assert.equal(fullMount.host.querySelectorAll('.helmx-list-row[data-tier-id]').length, 1)
      assert.ok(fullMount.host.querySelector('[data-tier-id="stale"]') !== null)
      await act(async () => {
        setInputValue(searchInput, '')
      })
      assert.equal(fullMount.host.querySelectorAll('.helmx-list-row[data-tier-id]').length, 2)

      // Click `tier/coder` row -> opens edit DetailDrawer with ID in header & ModelPickerControl -> edit & save calls `set`
      const coderRowTrigger = fullMount.host.querySelector<HTMLButtonElement>(
        '[data-tier-id="coder"] .helmx-list-row-trigger',
      )
      assert.ok(coderRowTrigger !== null)
      await act(async () => {
        coderRowTrigger.click()
      })
      const drawerShell = document.body.querySelector<HTMLElement>('.tiers-drawer-shell')
      assert.ok(drawerShell !== null, 'clicking tier row opens DetailDrawer')
      const drawer = drawerShell.querySelector<HTMLElement>('.tiers-drawer')
      assert.ok(drawer !== null)
      assert.match(drawerShell.querySelector('.primary-drawer-title')?.textContent ?? '', /^tier\/coder$/)
      assert.ok(
        drawer.querySelector('.helmx-input-wrap input') === null,
        'edit mode must omit redundant disabled ID field when tier/<id> is already in header',
      )
      const saveChangesBtn = findButton(drawerShell, 'Save')
      assert.equal(saveChangesBtn.disabled, true, 'Save stays disabled until draft is dirty')

      const pickerBtn = drawer.querySelector<HTMLButtonElement>('button.helmx-model-picker-trigger')
      assert.ok(pickerBtn !== null, 'expected integrated ModelPickerControl button in drawer')
      assert.match(pickerBtn.textContent ?? '', /workhorse/)
      assert.match(pickerBtn.textContent ?? '', /high/)
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
      assert.equal(saveChangesBtn.disabled, false)
      await act(async () => {
        saveChangesBtn.click()
      })
      assert.deepEqual(ctx.actionCalls[0], {
        actionId: 'set',
        input: {
          id: 'coder',
          model: 'faux/flagship',
          thinkingLevel: 'xhigh',
          description: 'Mainline',
        },
      })
      assert.ok(document.body.querySelector('.tiers-drawer') === null, 'drawer closes after saving tier')
      assert.ok(fullMount.host.querySelector('.callout-ok') === null, 'must not render inline callout-ok on set')
      assert.deepEqual(ctx.notifications[0], { message: 'Saved tier "tier/coder" and synced to kernel.', tone: 'info' })

      // Delete `tier/stale` from row -> ConfirmDialog -> calls `remove`
      const staleDeleteBtn = fullMount.host.querySelector<HTMLButtonElement>(
        '[data-tier-id="stale"] .tiers-row-delete-btn',
      )
      assert.ok(staleDeleteBtn !== null)
      await act(async () => {
        staleDeleteBtn.click()
      })
      assert.equal(ctx.actionCalls.length, 1, 'clicking card delete must wait for ConfirmDialog')
      let confirmDialog = document.body.querySelector('[role="alertdialog"]')
      assert.ok(confirmDialog !== null)
      await act(async () => {
        findButton(confirmDialog!, 'Cancel').click()
      })
      assert.equal(ctx.actionCalls.length, 1)

      await act(async () => {
        staleDeleteBtn.click()
      })
      confirmDialog = document.body.querySelector('[role="alertdialog"]')
      assert.ok(confirmDialog !== null)
      const confirmRemoveBtn = Array.from(confirmDialog.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        b.className.includes('btn-danger'),
      )
      assert.ok(confirmRemoveBtn !== undefined)
      await act(async () => {
        confirmRemoveBtn.click()
      })
      assert.deepEqual(ctx.actionCalls[1], { actionId: 'remove', input: { id: 'stale' } })
      assert.deepEqual(ctx.notifications[1], { message: 'Deleted tier "tier/stale".', tone: 'info' })

      // Switch to `Templates` tab -> verify Apply & Delete
      const templatesTab = Array.from(fullMount.host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
        (tab) => (tab.textContent ?? '').includes('Templates'),
      )
      assert.ok(templatesTab !== undefined)
      await act(async () => {
        templatesTab.click()
      })
      const tplText = fullMount.host.textContent ?? ''
      assert.match(tplText, /Daily Dev/)
      assert.match(tplText, /Budget Mode/)

      await act(async () => {
        findButton(fullMount.host, 'Apply').click()
      })
      assert.deepEqual(ctx.actionCalls[2], { actionId: 'apply_template', input: { id: 'budget' } })
      assert.ok(fullMount.host.querySelector('.callout-ok') === null, 'must not render inline callout-ok on apply_template')
      assert.deepEqual(ctx.notifications[2], { message: 'Applied template "Budget Mode".', tone: 'info' })

      await act(async () => {
        findButton(fullMount.host, 'Delete').click()
      })
      assert.equal(ctx.actionCalls.length, 3, 'clicking template Delete must wait for ConfirmDialog confirmation')
      confirmDialog = document.body.querySelector('[role="alertdialog"]')
      assert.ok(confirmDialog !== null, 'template Delete opens AlertDialog confirmation')
      await act(async () => {
        findButton(confirmDialog!, 'Cancel').click()
      })
      assert.equal(ctx.actionCalls.length, 3)

      await act(async () => {
        findButton(fullMount.host, 'Delete').click()
      })
      confirmDialog = document.body.querySelector('[role="alertdialog"]')
      assert.ok(confirmDialog !== null)
      const confirmDeleteTplBtn = Array.from(confirmDialog.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        b.className.includes('btn-danger'),
      )
      assert.ok(confirmDeleteTplBtn !== undefined)
      await act(async () => {
        confirmDeleteTplBtn.click()
      })
      assert.deepEqual(ctx.actionCalls[3], { actionId: 'delete_template', input: { id: 'budget' } })
      assert.ok(fullMount.host.querySelector('.callout-ok') === null, 'must not render inline callout-ok on delete_template')
      assert.deepEqual(ctx.notifications[3], { message: 'Deleted template "Budget Mode".', tone: 'info' })

      // Click `Save template` -> SaveTemplateDialog -> validate empty/invalid -> submit `save_template`
      await act(async () => {
        findButton(fullMount.host, 'Save template').click()
      })
      const tplDialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
      assert.ok(tplDialog !== null, 'Save as template opens Dialog')
      assert.ok(
        tplDialog.closest('.helmx-modal-backdrop') !== null,
        'SaveTemplateDialog content must be nested inside .helmx-modal-backdrop so it centers visibly on desktop and mobile',
      )
      await act(async () => {
        findButton(tplDialog, 'Save template').click()
      })
      assert.match(tplDialog.textContent ?? '', /both required/i)
      assert.equal(ctx.actionCalls.length, 4)

      const tplInputs = Array.from(tplDialog.querySelectorAll('input')) as HTMLInputElement[]
      assert.equal(tplInputs.length, 2)
      const [tplIdInput, tplNameInput] = tplInputs as [HTMLInputElement, HTMLInputElement]
      await act(async () => {
        setInputValue(tplIdInput, 'custom-1')
        setInputValue(tplNameInput, 'Custom Roster')
      })
      await act(async () => {
        findButton(tplDialog, 'Save template').click()
      })
      assert.deepEqual(ctx.actionCalls[4], {
        actionId: 'save_template',
        input: { id: 'custom-1', name: 'Custom Roster' },
      })
      assert.ok(document.body.querySelector('[role="dialog"]') === null, 'SaveTemplateDialog closes after submit')
      assert.deepEqual(ctx.notifications[4], { message: 'Saved template "Custom Roster".', tone: 'info' })
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
      const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
      assert.ok(popover !== null)
      assert.equal(popover.getAttribute('data-mode'), 'default')
      assert.ok(popover.querySelector('.composer-model-header .composer-model-search-bar') !== null)
      assert.ok(popover.querySelector('.composer-model-scroll .popover-header .popover-kbd-hint') === null)
      assert.ok(popover.querySelector('.composer-model-footer .popover-kbd-hint') !== null)
      assert.ok(popover.querySelector('.composer-model-footer .composer-model-reset') !== null)
      const tierRow = Array.from(popover.querySelectorAll<HTMLElement>('.composer-model-row')).find((r) =>
        (r.textContent ?? '').includes('tier/coder'),
      )
      assert.ok(tierRow !== undefined && tierRow.querySelector('.composer-model-tier-icon') !== null, 'tier rows render layers icon')
      const currentRow = Array.from(popover.querySelectorAll<HTMLElement>('.composer-model-row')).find(
        (r) => r.getAttribute('data-current') === 'true',
      )
      assert.ok(currentRow !== undefined && (currentRow.textContent ?? '').includes('workhorse'))
      assert.equal(currentRow.classList.contains('popover-item-active'), false)
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
      const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
      assert.ok(popover !== null)
      assert.ok(popover.querySelector('.composer-model-tier-icon') === null, 'allowTiers=false renders zero tier icons')
      const popoverText = document.body.textContent ?? ''
      assert.doesNotMatch(popoverText, /Model tiers/)
      assert.doesNotMatch(popoverText, /tier\/architect/)
      assert.match(popoverText, /workhorse/)
    } finally {
      await noTiersMount.unmount()
    }
  })

  test('tiers client module: Fast Refresh exports, purified CSS, pure parsers, and zero Emoji copy', { timeout: 60_000 }, () => {
    assert.equal(TIERS_PLUGIN_ID, 'builtin:tiers')
    assert.equal(TIERS_STATE_DOC, 'state')
    assert.equal(TIERS_SCREEN_ID, 'main')

    const exportNames = Object.keys(rawTiersModule).filter((k) => k !== '__helmxClientCss').sort()
    assert.deepEqual(exportNames, [
      'TiersManagerScreen',
      'TiersSettingsPanel',
    ])
    for (const name of exportNames) {
      assert.match(name, /^[A-Z]/)
      assert.equal(typeof rawTiersModule[name], 'function')
    }
    const cssText = rawTiersModule['__helmxClientCss']
    assert.equal(typeof cssText, 'string')
    assert.match(cssText as string, /\.tiers-drawer/)
    assert.doesNotMatch(cssText as string, /\.tiers-borrow-pill/)
    assert.doesNotMatch(cssText as string, /\.tiers-orch-/)

    for (const [key, entry] of Object.entries(TIERS_COPY)) {
      assert.equal(EMOJI_RE.test(entry.en), false, `TIERS_COPY.${key}.en must contain zero Emoji`)
      assert.equal(EMOJI_RE.test(entry['zh-CN']), false, `TIERS_COPY.${key}['zh-CN'] must contain zero Emoji`)
    }

    const parsed = parseTiersStateDoc({
      tiers: {
        coder: { model: 'faux/workhorse', thinkingLevel: 'high', description: 'Daily' },
        invalid: { model: 42 },
      },
      activeTemplate: 'daily',
      templates: {
        daily: { id: 'daily', name: 'Daily', tiers: { coder: { model: 'faux/workhorse' } }, updatedAt: 10 },
      },
    })
    assert.deepEqual(parsed.tiers, {
      coder: { model: 'faux/workhorse', thinkingLevel: 'high', description: 'Daily' },
    })
    assert.equal(parsed.activeTemplate, 'daily')
    assert.equal(parsed.templates.length, 1)

    const items = synthesizeTierItems(parsed.tiers, TEST_MODELS)
    assert.equal(items.length, 1)
    assert.equal(items[0]?.status, 'available')
    assert.equal(filterTierItems(items, { query: 'workhorse' }).length, 1)
    assert.equal(filterTierItems(items, { query: 'nonexistent' }).length, 0)

    assert.deepEqual(
      validateTierDraft(
        { id: 'coder', model: 'faux/workhorse', thinkingLevel: 'high', suggestedThinkingLevel: '', description: 'Daily' },
        { mode: 'create', existingIds: new Set() },
      ),
      { ok: true, payload: { id: 'coder', model: 'faux/workhorse', thinkingLevel: 'high', description: 'Daily' } },
    )
    assert.deepEqual(
      validateTierDraft(
        { id: 'coder', model: 'faux/workhorse', thinkingLevel: '', suggestedThinkingLevel: '', description: '' },
        { mode: 'create', existingIds: new Set(['coder']) },
      ),
      { ok: false, code: 'duplicate_id' },
    )
    assert.deepEqual(
      validateTierDraft(
        { id: 'coder', model: '', thinkingLevel: '', suggestedThinkingLevel: '', description: '' },
        { mode: 'edit', existingIds: new Set(['coder']) },
      ),
      { ok: false, code: 'model_required' },
    )
  })

  test('ModelPickerControl: controlled open/onOpenChange, showResetDefault=false, renderTrigger=null anchor, and enableShortcut=false', { timeout: 60_000 }, async () => {
    const openChanges: boolean[] = []
    const applied: Array<{ model: string; level: string | null }> = []

    function ControlledHarness({ initialOpen }: { initialOpen: boolean }) {
      const [open, setOpen] = React.useState(initialOpen)
      return e(ModelPickerControl, {
        effectiveModel: 'faux/workhorse',
        activeThinkingLevel: 'high',
        open,
        onOpenChange: (next: boolean) => {
          openChanges.push(next)
          setOpen(next)
        },
        showResetDefault: false,
        enableShortcut: false,
        renderTrigger: () => null,
        onApply: (model: string, level: string | null) => {
          applied.push({ model, level })
        },
      })
    }

    // 1. Closed + renderTrigger() => null renders non-focusable anchor and ZERO <button>
    const closedMount = await mountWithHost(e(ControlledHarness, { initialOpen: false }))
    try {
      assert.equal(closedMount.host.querySelectorAll('button').length, 0, 'null trigger must not render a focusable empty button')
      const anchor = closedMount.host.querySelector('.helmx-model-picker-anchor')
      assert.ok(anchor !== null, 'null trigger must render a Popover.Anchor span')
      assert.equal(anchor.getAttribute('aria-hidden'), 'true')

      // enableShortcut=false must NOT open on Ctrl+L
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true }))
      })
      assert.equal(document.body.querySelector('.composer-model-popover') === null, true)
    } finally {
      await closedMount.unmount()
    }

    // 2. Open + showResetDefault=false omits reset button and still selects a model cleanly
    const openMount = await mountWithHost(e(ControlledHarness, { initialOpen: true }))
    try {
      const popover = document.body.querySelector('.composer-model-popover')
      assert.ok(popover !== null, 'controlled open=true must render Popover')
      assert.equal(popover.querySelector('.composer-model-reset') === null, true, 'showResetDefault=false hides reset item')
      const flagshipMain = Array.from(popover.querySelectorAll<HTMLButtonElement>('.composer-model-row-main')).find(
        (b) => !(b.textContent ?? '').includes('tier/') && b.title.includes('faux/flagship'),
      )
      assert.ok(flagshipMain !== undefined)
      await act(async () => {
        flagshipMain.click()
      })
      assert.deepEqual(applied, [{ model: 'faux/flagship', level: null }])
      assert.equal(openChanges.includes(false), true)
    } finally {
      await openMount.unmount()
    }
  })

  test('ModelPickerControl auto-focus: focuses .composer-model-popover on coarse touch (avoiding soft keyboard) and search input on desktop', { timeout: 60_000 }, async () => {
    const originalMatchMedia = window.matchMedia
    const stubCoarse = (coarse: boolean): void => {
      window.matchMedia = ((query: string) => ({
        matches: coarse && query === '(hover: none) and (pointer: coarse)',
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })) as typeof window.matchMedia
    }

    try {
      // 1. Coarse touch viewport -> focuses popover container, NOT search <input>
      stubCoarse(true)
      const touchMount = await mountWithHost(
        e(ModelPickerControl, {
          effectiveModel: 'faux/workhorse',
          activeThinkingLevel: 'high',
          resetLabel: 'Reset',
          resetTitle: 'Reset',
          buttonTitle: 'Model',
          onApply: () => {},
          onResetDefault: () => {},
        }),
      )
      try {
        const trigger = touchMount.host.querySelector<HTMLButtonElement>('button.composer-model-button')
        assert.ok(trigger !== null)
        await act(async () => {
          trigger.click()
        })
        const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
        assert.ok(popover !== null, 'ModelPickerControl opens on coarse touch')
        const searchInput = popover.querySelector<HTMLInputElement>('input')
        assert.ok(searchInput !== null)
        assert.ok(document.activeElement === popover, 'coarse touch must focus .composer-model-popover container')
        assert.ok(document.activeElement !== searchInput, 'coarse touch must not auto-focus search <input>')
      } finally {
        await touchMount.unmount()
      }

      // 2. Desktop viewport -> focuses search <input>
      stubCoarse(false)
      const desktopMount = await mountWithHost(
        e(ModelPickerControl, {
          effectiveModel: 'faux/workhorse',
          activeThinkingLevel: 'high',
          resetLabel: 'Reset',
          resetTitle: 'Reset',
          buttonTitle: 'Model',
          onApply: () => {},
          onResetDefault: () => {},
        }),
      )
      try {
        const trigger = desktopMount.host.querySelector<HTMLButtonElement>('button.composer-model-button')
        assert.ok(trigger !== null)
        await act(async () => {
          trigger.click()
        })
        const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
        assert.ok(popover !== null, 'ModelPickerControl opens on desktop')
        const searchInput = popover.querySelector<HTMLInputElement>('input')
        assert.ok(searchInput !== null)
        assert.ok(document.activeElement === searchInput, 'desktop must focus search <input>')
      } finally {
        await desktopMount.unmount()
      }
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })

  test('TiersManagerScreen: model row click displays per-model thinking default while saving dynamic inheritance', { timeout: 60_000 }, async () => {
    const ctx = makeSpyCtx()
    setBuiltinClientStub({
      docs: { state: { tiers: {}, templates: {} } },
    })
    const mounted = await mountWithHost(
      e(PluginClientContext.Provider, { value: ctx }, e(TiersManagerScreen, { screenId: 'main' })),
      {
        modelDefaults: {
          modelTiers: TEST_TIERS,
          modelThinkingLevels: { 'faux/workhorse': 'medium', 'faux/flagship': 'high' },
        },
      },
    )
    try {
      const openCreateAndFillId = async (id: string): Promise<HTMLButtonElement> => {
        await act(async () => {
          findButton(mounted.host, 'Add tier').click()
        })
        const drawer = document.body.querySelector<HTMLElement>('.tiers-drawer')
        assert.ok(drawer !== null, 'expected Create DetailDrawer')
        const idInput = drawer.querySelector<HTMLInputElement>('.helmx-input-wrap input')
        assert.ok(idInput !== null)
        await act(async () => {
          setInputValue(idInput, id)
        })
        const primaryBtn = drawer.querySelector<HTMLButtonElement>('button.helmx-model-picker-trigger')
        assert.ok(primaryBtn !== null, 'expected primary ModelPickerControl button inside drawer')
        return primaryBtn
      }

      // 1) Click model row body (`faux/workhorse`): shows per-model default `medium` in trigger, title, and popover chip while saving without thinkingLevel
      let primaryBtn = await openCreateAndFillId('coder')
      await act(async () => {
        primaryBtn.click()
      })
      const workhorseMain = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.composer-model-row-main')).find(
        (btn) => btn.title.includes('faux/workhorse'),
      )
      assert.ok(workhorseMain !== undefined, 'expected faux/workhorse row body button')
      await act(async () => {
        workhorseMain.click()
      })
      assert.match(primaryBtn.textContent ?? '', /workhorse/)
      assert.match(primaryBtn.textContent ?? '', /medium/)
      assert.equal(primaryBtn.title, 'faux/workhorse · medium')

      // Reopen popover -> `medium` chip is pressed on the current row
      await act(async () => {
        primaryBtn.click()
      })
      const workhorseRow = Array.from(document.body.querySelectorAll<HTMLElement>('.composer-model-row')).find((row) =>
        (row.querySelector('.composer-model-row-main') as HTMLButtonElement | null)?.title.includes('faux/workhorse'),
      )
      assert.ok(workhorseRow !== undefined)
      const mediumChip = Array.from(workhorseRow.querySelectorAll<HTMLButtonElement>('.composer-model-level-chip')).find(
        (btn) => btn.textContent?.trim() === 'medium',
      )
      assert.ok(mediumChip !== undefined)
      assert.equal(mediumChip.getAttribute('aria-pressed'), 'true')
      await act(async () => {
        primaryBtn.click()
      })
      await act(async () => {
        findButton(document.body.querySelector('.tiers-drawer-shell')!, 'Create').click()
      })
      assert.deepEqual(ctx.actionCalls[0], {
        actionId: 'set',
        input: { id: 'coder', model: 'faux/workhorse' },
      })

      // 2) Click explicit `high` chip -> overrides per-model default and saves thinkingLevel: 'high'
      primaryBtn = await openCreateAndFillId('coder')
      await act(async () => {
        primaryBtn.click()
      })
      const highChip = Array.from(document.body.querySelectorAll<HTMLElement>('.composer-model-row'))
        .find((row) =>
          (row.querySelector('.composer-model-row-main') as HTMLButtonElement | null)?.title.includes('faux/workhorse'),
        )
        ?.querySelectorAll<HTMLButtonElement>('.composer-model-level-chip')
      const highBtn = Array.from(highChip ?? []).find((btn) => btn.textContent?.trim() === 'high')
      assert.ok(highBtn !== undefined)
      await act(async () => {
        highBtn.click()
      })
      assert.match(primaryBtn.textContent ?? '', /high/)
      assert.equal(primaryBtn.title, 'faux/workhorse · high')
      await act(async () => {
        findButton(document.body.querySelector('.tiers-drawer-shell')!, 'Create').click()
      })
      assert.deepEqual(ctx.actionCalls[1], {
        actionId: 'set',
        input: { id: 'coder', model: 'faux/workhorse', thinkingLevel: 'high' },
      })

      // 3) Click explicit `off` chip -> outranks per-model default `medium`, hides level suffix/title, presses `off` chip, and saves 'off'
      primaryBtn = await openCreateAndFillId('coder')
      await act(async () => {
        primaryBtn.click()
      })
      const offBtn = Array.from(
        Array.from(document.body.querySelectorAll<HTMLElement>('.composer-model-row'))
          .find((row) =>
            (row.querySelector('.composer-model-row-main') as HTMLButtonElement | null)?.title.includes('faux/workhorse'),
          )
          ?.querySelectorAll<HTMLButtonElement>('.composer-model-level-chip') ?? [],
      ).find((btn) => btn.textContent?.trim() === 'off')
      assert.ok(offBtn !== undefined)
      await act(async () => {
        offBtn.click()
      })
      assert.doesNotMatch(primaryBtn.textContent ?? '', /medium/)
      assert.doesNotMatch(primaryBtn.textContent ?? '', /high/)
      assert.equal(primaryBtn.title, 'faux/workhorse')
      await act(async () => {
        primaryBtn.click()
      })
      const reopenedChips = Array.from(
        Array.from(document.body.querySelectorAll<HTMLElement>('.composer-model-row'))
          .find((row) =>
            (row.querySelector('.composer-model-row-main') as HTMLButtonElement | null)?.title.includes('faux/workhorse'),
          )
          ?.querySelectorAll<HTMLButtonElement>('.composer-model-level-chip') ?? [],
      )
      const reopenedOff = reopenedChips.find((btn) => btn.textContent?.trim() === 'off')
      const reopenedMedium = reopenedChips.find((btn) => btn.textContent?.trim() === 'medium')
      assert.equal(reopenedOff?.getAttribute('aria-pressed'), 'true')
      assert.equal(reopenedMedium?.getAttribute('aria-pressed'), null)
      await act(async () => {
        primaryBtn.click()
      })
      await act(async () => {
        findButton(document.body.querySelector('.tiers-drawer-shell')!, 'Create').click()
      })
      assert.deepEqual(ctx.actionCalls[2], {
        actionId: 'set',
        input: { id: 'coder', model: 'faux/workhorse', thinkingLevel: 'off' },
      })

      // 4) Switch to `faux/fast` (no per-model default) by row body -> shows only `fast` without `·` and omits thinkingLevel
      primaryBtn = await openCreateAndFillId('coder')
      await act(async () => {
        primaryBtn.click()
      })
      const fastMain = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.composer-model-row-main')).find(
        (btn) => btn.title.includes('faux/fast'),
      )
      assert.ok(fastMain !== undefined)
      await act(async () => {
        fastMain.click()
      })
      assert.match(primaryBtn.textContent ?? '', /fast/)
      assert.doesNotMatch(primaryBtn.textContent ?? '', /·/)
      assert.equal(primaryBtn.title, 'faux/fast')
      await act(async () => {
        findButton(document.body.querySelector('.tiers-drawer-shell')!, 'Create').click()
      })
      assert.deepEqual(ctx.actionCalls[3], {
        actionId: 'set',
        input: { id: 'coder', model: 'faux/fast' },
      })
    } finally {
      await mounted.unmount()
    }
  })

  test('TiersManagerScreen: useScreenDrawer pushes on closed->open, replaces on card switch or close', { timeout: 60_000 }, async () => {
    const ctx = makeSpyCtx()
    setBuiltinClientStub({
      docs: {
        state: {
          tiers: {
            coder: { model: 'faux/workhorse', description: 'Daily coding workhorse' },
            architect: { model: 'faux/flagship', description: 'Architecture and reviews' },
          },
          templates: {},
        },
      },
    })
    let params: Record<string, string> = {}
    const paramCalls: Array<{ patch: Record<string, string | undefined>; options?: { push?: boolean } }> = []
    const store = makeTestStore({
      models: TEST_MODELS,
      modelDefaults: { modelTiers: TEST_TIERS },
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    const renderHosted = async () => {
      await act(async () => {
        root.render(
          e(
            HostStoreProviders,
            { value: store },
            e(
              PluginClientContext.Provider,
              { value: ctx },
              e(TiersManagerScreen, {
                pluginId: 'builtin:tiers',
                screenId: 'main',
                isSplit: false,
                inlineDrawer: true,
                params,
                setParams: (patch: Record<string, string | undefined>, options?: { push?: boolean }) => {
                  paramCalls.push({ patch, options })
                  const next = { ...params }
                  for (const [k, v] of Object.entries(patch)) {
                    if (v === undefined) delete next[k]
                    else next[k] = v
                  }
                  params = next
                },
              }),
            ),
          ),
        )
      })
    }

    try {
      await renderHosted()
      const coderTrigger = host.querySelector<HTMLButtonElement>('[data-tier-id="coder"] .helmx-list-row-trigger')
      assert.ok(coderTrigger !== null)

      // 1) Closed -> edit coder: must push history
      await act(async () => {
        coderTrigger.click()
      })
      assert.deepEqual(paramCalls.at(-1), {
        patch: { edit: 'coder', create: undefined },
        options: { push: true },
      })
      await renderHosted()
      assert.ok(host.querySelector('.tiers-drawer') !== null)

      // 2) Open -> switch to architect: must replace (no push)
      const architectTrigger = host.querySelector<HTMLButtonElement>('[data-tier-id="architect"] .helmx-list-row-trigger')
      assert.ok(architectTrigger !== null)
      await act(async () => {
        architectTrigger.click()
      })
      assert.deepEqual(paramCalls.at(-1), {
        patch: { edit: 'architect', create: undefined },
        options: undefined,
      })
      await renderHosted()

      // 3) Close drawer via header close button -> omits push
      const closeBtn = document.body.querySelector<HTMLButtonElement>('.primary-drawer-content button[aria-label="Close"]')
      assert.ok(closeBtn !== null)
      await act(async () => {
        closeBtn.click()
      })
      assert.deepEqual(paramCalls.at(-1), {
        patch: { edit: undefined, create: undefined },
        options: undefined,
      })
      await renderHosted()
      assert.ok(host.querySelector('.tiers-drawer') === null)

      // 4) Closed -> Add tier: must push history
      await act(async () => {
        findButton(host, 'Add tier').click()
      })
      assert.deepEqual(paramCalls.at(-1), {
        patch: { edit: undefined, create: '1' },
        options: { push: true },
      })
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
})
