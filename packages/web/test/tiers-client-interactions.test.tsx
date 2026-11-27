/**
 * builtin:tiers client module (compiled TSX via @helmx/plugin-build) and ModelPickerControl
 * tier-group interactive DOM tests:
 * - TiersManagerScreen: loading state, empty starter quick-start cards, DetailDrawer create/edit
 *   validation & atomic set/remove actions, search/kind filtering, template tabs/apply/delete &
 *   SaveTemplateDialog, dual-phase orchestrator editing, and per-model thinking defaults;
 * - TiersSettingsPanel: summary KV projection and openScreen deep-link;
 * - ModelPickerControl: tiers section at top of popover (available tiers only), clicking a tier
 *   commits `tier/<id>`, and `allowTiers={false}` suppresses tiers to prevent recursive tier bindings.
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { describe, before, test } from 'node:test'
import { waitFor } from '@helmx/test-kit'
import * as React from 'react'
import { act } from 'react'
import type {
  ComposerStatusSlotProps,
  ComposerToolbarSlotProps,
  ConversationSummary,
  PluginClientContext as PluginClientContextType,
  ToolViewProps,
} from '@helmx/protocol'
import { COMPOSER_STATUS_SLOT, COMPOSER_TOOLBAR_SLOT } from '@helmx/protocol'
import type { PluginSessionDocKey, PluginSessionDocState } from '@helmx/plugin-client'
import {
  TIERS_BORROW_SESSION_DOC,
  TIERS_INPUT_META_KEY,
  TIERS_SWITCH_MODEL_TOOL,
  isTiersBorrowEligibleConversation,
  parseSwitchModelPresentationMeta,
  parseTierBorrowSessionView,
  readStandbyBorrowDraft,
} from '../../plugins/src/tiers/client/borrow-models.ts'
import { TIERS_COPY } from '../../plugins/src/tiers/client/copy.ts'
import { resetStandbyDrafts, standbyDraftsDirty } from '../src/conversation/standby-model.js'
import { resetPluginClientCache, seedPluginClientModule } from '../src/lib/plugin-client.js'
import { ensureHappyDom } from './helpers/dom-harness.js'
import { makeTestStore } from './helpers/store.js'

ensureHappyDom()
const { createRoot } = await import('react-dom/client')
const {
  ComposerModelPickerModeContext,
  ModelPickerControl,
  PluginClientContext,
  PluginClientHostContext,
  createComposerModelPickerModeRegistry,
  resolveLocalizedText,
  useComposerModelPickerMode,
} = await import('@helmx/plugin-client')
const { Composer } = await import('../src/conversation/Composer.js')
const { AgentStandbyPane } = await import('../src/conversation/AgentStandbyPane.js')
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
let BorrowToolbarPill: (props: ComposerToolbarSlotProps) => React.ReactElement | null
let OrchestratorStatusBadge: (props: ComposerStatusSlotProps) => React.ReactElement | null
let SwitchModelToolRow: (props: ToolViewProps) => React.ReactElement
describe("tiers-client-interactions", () => {


  before(async () => {
    mountSharedPluginNamespaces()
    const mod = await importBuiltinClientModule('builtin:tiers')
    rawTiersModule = mod
    TiersManagerScreen = mod['TiersManagerScreen'] as (props: Record<string, unknown>) => React.ReactElement
    TiersSettingsPanel = mod['TiersSettingsPanel'] as () => React.ReactElement
    BorrowToolbarPill = mod['BorrowToolbarPill'] as (props: ComposerToolbarSlotProps) => React.ReactElement | null
    OrchestratorStatusBadge = mod['OrchestratorStatusBadge'] as (props: ComposerStatusSlotProps) => React.ReactElement | null
    SwitchModelToolRow = mod['SwitchModelToolRow'] as (props: ToolViewProps) => React.ReactElement
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

  test('TiersManagerScreen: loading, starter cards, drawer validation/create/edit/delete, filtering, and template tabs/dialog', { timeout: 60_000 }, async () => {
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
      const starterRows = Array.from(emptyMount.host.querySelectorAll<HTMLElement>('.tiers-starter-row'))
      assert.deepEqual(
        starterRows.map((row) => row.getAttribute('data-starter-tier')),
        ['scout', 'coder', 'senior', 'architect', 'reviewer'],
      )
      const coderStarterTrigger = emptyMount.host.querySelector<HTMLButtonElement>(
        'button.tiers-starter-row[data-starter-tier="coder"]',
      )
      assert.ok(coderStarterTrigger !== null, 'expected coder starter row trigger')
      await act(async () => {
        coderStarterTrigger.click()
      })
      const drawer = document.body.querySelector<HTMLElement>('.tiers-drawer')
      assert.ok(drawer !== null, 'clicking starter row opens DetailDrawer')
      const idInput = drawer.querySelector<HTMLInputElement>('.tiers-id-wrap input')
      assert.ok(idInput !== null)
      assert.equal(idInput.value, 'coder')
      assert.equal(idInput.disabled, false)
      assert.equal(
        drawer.querySelectorAll('.helmx-select-trigger, select').length,
        0,
        'TiersManagerScreen drawer must reuse integrated ModelPickerControl instead of a separate thinking-level Select',
      )
      const drawerPicker = drawer.querySelector<HTMLButtonElement>('button.composer-model-button')
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

    // 3. Hydrated state with saved tiers + templates -> card grid, filter, drawer edit/set, delete, and templates tab/dialog
    setBuiltinClientStub({
      docs: {
        state: {
          tiers: {
            coder: { model: 'faux/workhorse', thinkingLevel: 'high', description: 'Mainline' },
            stale: { model: 'faux/removed', description: 'Missing model' },
            'orch-1': {
              kind: 'orchestrator',
              model: 'faux/flagship',
              thinkingLevel: 'xhigh',
              executorModel: 'faux/workhorse',
              maxExecutionSteps: 30,
              description: 'Dual pair',
            },
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
      assert.match(text, /tier\/orch-1/)
      assert.match(text, /Dual · 30 steps/)
      assert.equal(EMOJI_RE.test(text), false)

      // Kind filter pills + search box filter rows accurately
      const dualFilterTab = Array.from(fullMount.host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
        (tab) => (tab.textContent ?? '').includes('Dual-phase'),
      )
      assert.ok(dualFilterTab !== undefined)
      await act(async () => {
        dualFilterTab.click()
      })
      assert.equal(fullMount.host.querySelectorAll('.tiers-row').length, 1)
      assert.ok(fullMount.host.querySelector('[data-tier-id="orch-1"]') !== null)

      const allFilterTab = Array.from(fullMount.host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
        (tab) => (tab.textContent ?? '').includes('All'),
      )
      assert.ok(allFilterTab !== undefined)
      await act(async () => {
        allFilterTab.click()
      })
      assert.equal(fullMount.host.querySelectorAll('.tiers-row').length, 3)

      const searchInput = fullMount.host.querySelector<HTMLInputElement>('input[aria-label*="Search tiers"]')
      assert.ok(searchInput !== null)
      await act(async () => {
        setInputValue(searchInput, 'stale')
      })
      assert.equal(fullMount.host.querySelectorAll('.tiers-row').length, 1)
      assert.ok(fullMount.host.querySelector('[data-tier-id="stale"]') !== null)
      await act(async () => {
        setInputValue(searchInput, '')
      })
      assert.equal(fullMount.host.querySelectorAll('.tiers-row').length, 3)

      // Click `tier/coder` row -> opens edit DetailDrawer with ID in header & ModelPickerControl -> edit & save calls `set`
      const coderRowTrigger = fullMount.host.querySelector<HTMLButtonElement>(
        '[data-tier-id="coder"] .tiers-row-trigger',
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
        drawer.querySelector('.tiers-id-wrap input') === null,
        'edit mode must omit redundant disabled ID field when tier/<id> is already in header',
      )
      const saveChangesBtn = findButton(drawerShell, 'Save')
      assert.equal(saveChangesBtn.disabled, true, 'Save stays disabled until draft is dirty')

      const pickerBtn = drawer.querySelector<HTMLButtonElement>('button.composer-model-button')
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
          kind: 'single',
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
        tplDialog.closest('.modal-backdrop') !== null,
        'SaveTemplateDialog content must be nested inside .modal-backdrop so it centers visibly on desktop and mobile',
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

  // -------------------------------------------------------------------------
  // One-turn model borrow UI & SwitchModelToolRow
  // -------------------------------------------------------------------------

  function makeConv(id: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
    return {
      id,
      title: `Conversation #${id}`,
      profileId: 'assistant',
      tags: [],
      cwd: '/repo',
      model: 'faux/workhorse',
      thinkingLevel: '',
      status: 'idle',
      stateChangeSeq: 1,
      completionSeq: 0,
      unread: false,
      pinned: false,
      pendingAskCount: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      ...overrides,
    }
  }

  function createSessionDocHarness(initial: Record<string, PluginSessionDocState> = {}) {
    const states = new Map<string, PluginSessionDocState>(Object.entries(initial))
    const listeners = new Map<string, Set<() => void>>()
    const subscribedKeys: PluginSessionDocKey[] = []
    const EMPTY: PluginSessionDocState = { hasValue: false, deleted: false, connected: false }
    const keyStr = (key: PluginSessionDocKey): string => `${key.pluginId}/${key.docName}/${key.conversationId}`

    const emit = (k: string): void => {
      const set = listeners.get(k)
      if (!set) return
      for (const listener of [...set]) listener()
    }

    const setBorrowDoc = (conversationId: number, value: unknown): void => {
      const k = `builtin:tiers/${TIERS_BORROW_SESSION_DOC}/${conversationId}`
      states.set(k, { value, hasValue: true, deleted: false, connected: true })
      emit(k)
    }

    const subscribeSessionDoc = (key: PluginSessionDocKey, listener: () => void): (() => void) => {
      subscribedKeys.push(key)
      const k = keyStr(key)
      let set = listeners.get(k)
      if (!set) {
        set = new Set()
        listeners.set(k, set)
      }
      set.add(listener)
      return () => {
        set?.delete(listener)
      }
    }

    const getSessionDocState = (key: PluginSessionDocKey): PluginSessionDocState =>
      states.get(keyStr(key)) ?? EMPTY

    const retrySessionDoc = (): void => {}

    return { subscribedKeys, setBorrowDoc, subscribeSessionDoc, getSessionDocState, retrySessionDoc }
  }

  function WithSessionDocOverride({
    harness,
    onInvokeAction,
    children,
  }: {
    harness: ReturnType<typeof createSessionDocHarness>
    onInvokeAction?: (pluginId: string, actionId: string, input: unknown) => Promise<unknown>
    children?: React.ReactNode
  }): React.ReactElement {
    const basePort = React.useContext(PluginClientHostContext)
    assert.ok(basePort !== null, 'expected PluginClientHostContext from HostStoreProviders')
    const port = React.useMemo(
      () => ({
        ...basePort,
        subscribeSessionDoc: harness.subscribeSessionDoc,
        getSessionDocState: harness.getSessionDocState,
        retrySessionDoc: harness.retrySessionDoc,
        ...(onInvokeAction ? { invokePluginAction: onInvokeAction } : {}),
      }),
      [basePort, harness, onInvokeAction],
    )
    return e(PluginClientHostContext.Provider, { value: port }, children ?? null)
  }

  test('tiers client module: Fast Refresh exports, borrow CSS classes, pure parsers, and zero Emoji copy', { timeout: 60_000 }, () => {
    assert.equal(TIERS_BORROW_SESSION_DOC, 'borrow')
    assert.equal(TIERS_SWITCH_MODEL_TOOL, 'switch_model')
    assert.equal(TIERS_INPUT_META_KEY, 'builtin:tiers')

    const exportNames = Object.keys(rawTiersModule).filter((k) => k !== '__helmxClientCss').sort()
    assert.deepEqual(exportNames, [
      'BorrowToolbarPill',
      'OrchestratorStatusBadge',
      'OrchestratorToolRow',
      'SwitchModelToolRow',
      'TiersManagerScreen',
      'TiersSettingsPanel',
    ])
    for (const name of exportNames) {
      assert.match(name, /^[A-Z]/)
      assert.equal(typeof rawTiersModule[name], 'function')
    }
    const cssText = rawTiersModule['__helmxClientCss']
    assert.equal(typeof cssText, 'string')
    assert.match(cssText as string, /\.tiers-borrow-pill/)
    assert.match(cssText as string, /\.tiers-orch-status-trigger/)
    assert.match(cssText as string, /\.tiers-orch-popover/)
    assert.match(cssText as string, /\.tiers-trace-row/)

    for (const [key, entry] of Object.entries(TIERS_COPY)) {
      assert.equal(EMOJI_RE.test(entry.en), false, `TIERS_COPY.${key}.en must contain zero Emoji`)
      assert.equal(EMOJI_RE.test(entry['zh-CN']), false, `TIERS_COPY.${key}['zh-CN'] must contain zero Emoji`)
    }

    assert.equal(isTiersBorrowEligibleConversation(undefined), false)
    assert.equal(isTiersBorrowEligibleConversation(makeConv(1)), true)
    assert.equal(isTiersBorrowEligibleConversation(makeConv(2, { ownedBy: 'helmx' })), false)
    assert.equal(isTiersBorrowEligibleConversation(makeConv(3, { parentConversationId: 1 })), false)

    assert.equal(parseTierBorrowSessionView(null), null)
    assert.equal(parseTierBorrowSessionView({ phase: 'bogus' }), null)
    assert.deepEqual(
      readStandbyBorrowDraft({ [TIERS_INPUT_META_KEY]: { borrowModel: 'faux/flagship', effort: 'high' } }),
      { borrowModel: 'faux/flagship', effort: 'high' },
    )
    assert.equal(parseSwitchModelPresentationMeta(undefined), undefined)
    assert.deepEqual(
      parseSwitchModelPresentationMeta({
        fromModel: 'faux/fast',
        toModel: 'faux/flagship',
        toLabel: 'tier/architect',
        tierId: 'architect',
        effort: 'high',
        restoreAfterTurn: true,
        changed: true,
      }),
      {
        fromModel: 'faux/fast',
        toModel: 'faux/flagship',
        toLabel: 'tier/architect',
        tierId: 'architect',
        effort: 'high',
        restoreAfterTurn: true,
        changed: true,
      },
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

  test('TiersManagerScreen ModelPickerControl keeps enableRegisteredModes=false even inside populated mode registry', { timeout: 60_000 }, async () => {
    setBuiltinClientStub({
      docs: {
        state: {
          tiers: { coder: { model: 'faux/workhorse', thinkingLevel: 'high' } },
          templates: {},
        },
      },
      hostModels: { models: TEST_MODELS, defaultModel: 'faux/workhorse' },
    })
    const registry = createComposerModelPickerModeRegistry()
    function ModeRegistrar(): null {
      useComposerModelPickerMode('tiers:one-turn', {
        id: 'tiers:one-turn',
        label: 'Next turn',
        hint: 'Should not leak into manager',
        onApply: () => {},
      })
      return null
    }
    const mounted = await mountWithHost(
      e(
        ComposerModelPickerModeContext.Provider,
        { value: registry },
        e(ModeRegistrar),
        e(PluginClientContext.Provider, { value: makeSpyCtx() }, e(TiersManagerScreen, { screenId: 'main' })),
      ),
    )
    try {
      const coderRowTrigger = mounted.host.querySelector<HTMLButtonElement>(
        '[data-tier-id="coder"] .tiers-row-trigger',
      )
      assert.ok(coderRowTrigger !== null)
      await act(async () => {
        coderRowTrigger.click()
      })
      const pickerBtn = document.body.querySelector<HTMLButtonElement>('.tiers-drawer button.composer-model-button')
      assert.ok(pickerBtn !== null)
      await act(async () => {
        pickerBtn.click()
      })
      const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
      assert.ok(popover !== null)
      assert.ok(popover.querySelector('.composer-model-mode-bar') === null, 'TiersManagerScreen ModelPicker must NOT show composer mode bar')
    } finally {
      await mounted.unmount()
    }
  })

  test('Composer + BorrowToolbarPill + ModelPicker: idle zero DOM, unified mode switcher, misfire guard, armed/active pills, busy clear, plugin disable cleanup, and no /model', { timeout: 60_000 }, async () => {
    mountSharedPluginNamespaces({ realHooks: true })
    resetPluginClientCache()
    seedPluginClientModule('builtin:tiers', 'BorrowToolbarPill.tsx', rawTiersModule)

    const tiersPluginSummary = {
      id: 'builtin:tiers',
      name: 'tiers',
      version: '1.0.0',
      locked: false,
      enabled: true,
      status: 'active' as const,
      hooks: [],
      actions: [],
      tools: [],
      clientHashes: { 'BorrowToolbarPill.tsx': 'seeded' },
    }
    const tiersToolbarContribution = {
      pluginId: 'builtin:tiers',
      surface: 'plugin.slot' as const,
      spec: {
        id: 'tiers-borrow-toolbar-pill',
        target: COMPOSER_TOOLBAR_SLOT,
        order: 15,
        client: { module: 'BorrowToolbarPill.tsx', export: 'BorrowToolbarPill' },
      },
    }

    const origFetch = globalThis.fetch
    const fetchUrls: Array<{ url: string; method: string }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      fetchUrls.push({ url, method })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch

    try {
      // --- 1. Ineligible conversations register zero modes and render null with ZERO sessionDoc subscriptions ---
      const ineligibleHarness = createSessionDocHarness()
      const ctxIneligible = makeSpyCtx()
      const subMount = await mountWithHost(
        e(
          WithSessionDocOverride,
          { harness: ineligibleHarness },
          e(
            PluginClientContext.Provider,
            { value: ctxIneligible },
            e(
              React.Fragment,
              null,
              e(BorrowToolbarPill, { conversation: makeConv(20, { parentConversationId: 1 }) }),
              e(BorrowToolbarPill, { conversation: makeConv(21, { ownedBy: 'helmx' }) }),
            ),
          ),
        ),
      )
      try {
        assert.equal(subMount.host.textContent, '')
        assert.equal(ineligibleHarness.subscribedKeys.length, 0, 'ineligible conversations must open zero sessionDoc subscriptions')
      } finally {
        await subMount.unmount()
      }

      // --- 2. Full Composer + BorrowToolbarPill + ModelPicker persisted flow ---
      const harness = createSessionDocHarness()
      const actionCalls: Array<{ pluginId: string; actionId: string; input: unknown }> = []
      const conv = makeConv(30)
      const store = makeTestStore({
        conversations: [conv],
        models: TEST_MODELS,
        modelDefaults: { modelTiers: TEST_TIERS },
        plugins: [tiersPluginSummary],
        uiContributions: [tiersToolbarContribution],
      })

      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      const renderComposer = async (currentStore = store, targetConv = conv) => {
        await act(async () => {
          root.render(
            e(
              HostStoreProviders,
              { value: currentStore },
              e(
                WithSessionDocOverride,
                {
                  harness,
                  onInvokeAction: async (pluginId, actionId, input) => {
                    actionCalls.push({ pluginId, actionId, input })
                    if (actionId === 'set_borrow') {
                      const inp = input as { model: string; effort?: string }
                      harness.setBorrowDoc(targetConv.id, {
                        phase: 'armed',
                        requestedRef: inp.model,
                        targetModel: inp.model,
                        targetConcreteModel: inp.model === 'tier/architect' ? 'faux/flagship' : inp.model,
                        targetLabel: inp.model,
                        ...(inp.model.startsWith('tier/') ? { targetTierId: inp.model.slice(5) } : {}),
                        ...(inp.effort ? { effort: inp.effort } : {}),
                        restoreAfterTurn: true,
                        updatedAt: 1_700_000_000_000,
                      })
                    } else if (actionId === 'clear_borrow') {
                      harness.setBorrowDoc(targetConv.id, null)
                    }
                    return { ok: true }
                  },
                },
                e(Composer, { conversation: targetConv, prefill: null }),
              ),
            ),
          )
        })
      }

      try {
        const flushUi = async () => {
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 15))
          })
        }
        await renderComposer()

        // Idle eligible conversation: BorrowToolbarPill produces zero DOM inside .composer-toolbar-slot
        const toolbarSlot = host.querySelector('.composer-toolbar-slot')
        assert.ok(toolbarSlot !== null)
        assert.ok(toolbarSlot.querySelector('.tiers-borrow-pill') === null, 'idle BorrowToolbarPill must render zero DOM')
        assert.equal(toolbarSlot.querySelectorAll('button').length, 0)
        assert.ok(host.querySelector('.tiers-borrow-menu-item') === null)

        // Open `+` menu: verify NO BorrowMenuItem exists
        const plusBtn = host.querySelector<HTMLButtonElement>('button.composer-plus-trigger')
        assert.ok(plusBtn !== null)
        await act(async () => {
          plusBtn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
          plusBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        })
        await flushUi()
        assert.ok(document.body.querySelector('.tiers-borrow-menu-item') === null, '+ menu must not contain BorrowMenuItem')
        await act(async () => {
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        })
        await flushUi()

        // Open ModelPicker via trigger button -> starts on default "Switch model" tab
        const modelBtn = host.querySelector<HTMLButtonElement>('button.composer-model-button')
        assert.ok(modelBtn !== null)
        assert.match(modelBtn.textContent ?? '', /workhorse/)
        await act(async () => {
          modelBtn.click()
        })
        let popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
        assert.ok(popover !== null)
        assert.equal(popover.getAttribute('data-mode'), 'default')
        const header = popover.querySelector<HTMLElement>('.composer-model-header')
        assert.ok(header !== null, 'ModelPicker must render single-row .composer-model-header')
        assert.ok(header.querySelector('.composer-model-search-bar') !== null, '.composer-model-header houses .composer-model-search-bar')
        const modeBar = header.querySelector<HTMLElement>('.composer-model-mode-bar')
        assert.ok(modeBar !== null, 'ModelPicker must show .composer-model-mode-bar inside .composer-model-header when Next turn mode is registered')
        assert.ok(header.querySelector('.composer-model-mode-hint') === null, 'mode hint lives in footer instead of header')
        const defaultFooter = popover.querySelector<HTMLElement>('.composer-model-footer')
        assert.ok(defaultFooter !== null, 'ModelPicker must render .composer-model-footer')
        assert.equal(defaultFooter.getAttribute('data-mode-active'), null, 'default mode footer omits data-mode-active')
        assert.ok(defaultFooter.querySelector('.composer-model-reset') !== null, 'default mode shows .composer-model-reset in footer')
        assert.ok(defaultFooter.querySelector('.popover-kbd-hint') !== null, 'footer houses navHint')
        assert.ok(popover.querySelector('.composer-model-scroll .popover-header .popover-kbd-hint') === null, 'group headers omit navHint')
        const tabs = Array.from(modeBar.querySelectorAll<HTMLElement>('[role="tab"]'))
        assert.equal(tabs.length, 2)
        assert.equal(tabs[0]?.textContent?.trim(), 'Switch model')
        assert.equal(tabs[1]?.textContent?.trim(), 'Next turn')
        assert.equal(tabs[0]?.getAttribute('aria-selected'), 'true')
        assert.ok(popover.querySelector('.composer-model-mode-hint') === null)

        // Switch to "Next turn" tab -> popover remains open, footer activates + shows hint, reset disappears
        await act(async () => {
          tabs[1]?.click()
        })
        popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
        assert.ok(popover !== null, 'switching mode tab must keep popover open')
        assert.equal(popover.getAttribute('data-mode'), 'registered')
        assert.equal(tabs[1]?.getAttribute('aria-selected'), 'true')
        const activeFooter = popover.querySelector<HTMLElement>('.composer-model-footer[data-mode-active="true"]')
        assert.ok(activeFooter !== null, 'Next turn mode marks .composer-model-footer[data-mode-active="true"]')
        const hintEl = activeFooter.querySelector('.composer-model-mode-hint')
        assert.ok(hintEl !== null)
        assert.match(hintEl.textContent ?? '', /Applies only to your next message, then restores automatically/)
        assert.ok(popover.querySelector('.composer-model-reset') === null, 'hideResetDefault hides reset row in Next turn mode')

        // Select faux/flagship xhigh chip in Next turn mode -> calls set_borrow, NOT conversation PATCH, restores textarea focus
        const flagshipRow = Array.from(popover.querySelectorAll<HTMLElement>('.composer-model-row')).find(
          (row) =>
            !(row.textContent ?? '').includes('tier/') &&
            (row.querySelector('.composer-model-row-main') as HTMLButtonElement | null)?.title.includes('faux/flagship'),
        )
        assert.ok(flagshipRow !== undefined)
        const xhighChip = Array.from(flagshipRow.querySelectorAll<HTMLButtonElement>('.composer-model-level-chip')).find(
          (b) => b.textContent?.trim() === 'xhigh',
        )
        assert.ok(xhighChip !== undefined)
        const textarea = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')
        assert.ok(textarea !== null)

        const fetchCountBefore = fetchUrls.filter((f) => f.method === 'PATCH').length
        await act(async () => {
          xhighChip.click()
        })
        await flushUi()
        assert.equal(
          fetchUrls.filter((f) => f.method === 'PATCH').length,
          fetchCountBefore,
          'Next turn selection must NOT dispatch persistent conversation PATCH',
        )
        assert.deepEqual(actionCalls[0], {
          pluginId: 'builtin:tiers',
          actionId: 'set_borrow',
          input: { conversationId: 30, model: 'faux/flagship', effort: 'xhigh' },
        })
        await waitFor(() => document.activeElement === textarea, { timeoutMs: 2_000, intervalMs: 10 })
        assert.ok(document.activeElement === textarea)
        assert.ok(document.body.querySelector('.composer-model-popover') === null, 'applying Next turn closes popover')
        assert.match(modelBtn.textContent ?? '', /workhorse/, 'persistent ModelPicker trigger remains unchanged')

        // Armed pill appears cleanly with zero nested <button>
        assert.match(host.textContent ?? '', /Next turn:/)
        assert.match(host.textContent ?? '', /flagship · xhigh/)
        assert.ok(host.querySelector('.tiers-borrow-pill button button') === null, 'must never render nested <button>')

        // Misfire protection 1: clicking ModelPicker trigger button ALWAYS opens on "Switch model" default tab
        await act(async () => {
          modelBtn.click()
        })
        popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
        assert.ok(popover !== null)
        let reopenedTabs = Array.from(popover.querySelectorAll<HTMLElement>('.composer-model-mode-bar [role="tab"]'))
        assert.equal(reopenedTabs[0]?.getAttribute('aria-selected'), 'true', 'trigger click must reset to Switch model')
        // Switch to Next turn, then press Esc -> closes and resets
        await act(async () => {
          reopenedTabs[1]?.click()
        })
        assert.equal(reopenedTabs[1]?.getAttribute('aria-selected'), 'true')
        await act(async () => {
          popover!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        })
        await flushUi()
        assert.ok(document.body.querySelector('.composer-model-popover') === null)

        // Misfire protection 2: Ctrl+L ALWAYS opens on "Switch model" default tab, second Ctrl+L closes
        await act(async () => {
          window.dispatchEvent(new CustomEvent('helmx:shortcut', { detail: { action: 'toggle-model-picker', panel: 'primary' } }))
        })
        popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
        assert.ok(popover !== null)
        reopenedTabs = Array.from(popover.querySelectorAll<HTMLElement>('.composer-model-mode-bar [role="tab"]'))
        assert.equal(reopenedTabs[0]?.getAttribute('aria-selected'), 'true', 'Ctrl+L must open on Switch model default tab')
        await act(async () => {
          window.dispatchEvent(new CustomEvent('helmx:shortcut', { detail: { action: 'toggle-model-picker', panel: 'primary' } }))
        })
        await flushUi()
        assert.ok(document.body.querySelector('.composer-model-popover') === null)

        // Armed pill main button -> jumps DIRECTLY into "Next turn" mode with current armed selection highlighted
        const pillMain = host.querySelector<HTMLButtonElement>('.tiers-borrow-pill-main')
        assert.ok(pillMain !== null)
        assert.equal(pillMain.disabled, false, 'armed pillMain must be enabled before click')
        await act(async () => {
          pillMain.click()
        })
        popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
        assert.ok(popover !== null, 'clicking armed pill opens ModelPicker popover')
        const pillOpenedTabs = Array.from(popover.querySelectorAll<HTMLElement>('.composer-model-mode-bar [role="tab"]'))
        assert.equal(pillOpenedTabs[1]?.getAttribute('aria-selected'), 'true', 'armed pill openMode must preselect Next turn tab')
        const activeTargetBtn = popover.querySelector<HTMLButtonElement>('.composer-model-row-main[aria-current="true"]')
        assert.ok(activeTargetBtn !== null)
        assert.match(activeTargetBtn.title, /faux\/flagship/)
        const activeChip = popover.querySelector<HTMLButtonElement>('.composer-model-level-chip[aria-pressed="true"]')
        assert.ok(activeChip !== null && activeChip.textContent?.trim() === 'xhigh')

        // Close popover cleanly, then click sibling × -> clears borrow WITHOUT opening popover
        await act(async () => {
          popover!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        })
        await flushUi()
        const clearBtn = host.querySelector<HTMLButtonElement>('.tiers-borrow-pill-clear')
        assert.ok(clearBtn !== null)
        await act(async () => {
          clearBtn.click()
        })
        await flushUi()
        assert.deepEqual(actionCalls[1], {
          pluginId: 'builtin:tiers',
          actionId: 'clear_borrow',
          input: { conversationId: 30 },
        })
        assert.ok(document.body.querySelector('.composer-model-popover') === null, 'clicking × must not open popover')
        assert.ok(host.querySelector('.tiers-borrow-pill') === null)

        // Busy conversation with active borrow: pill renders "This turn", main disabled, Next turn mode absent, × enabled
        const busyConv = makeConv(30, { status: 'working' })
        harness.setBorrowDoc(30, {
          phase: 'active',
          requestedRef: 'tier/architect',
          targetModel: 'tier/architect',
          targetConcreteModel: 'faux/flagship',
          targetLabel: 'tier/architect',
          targetTierId: 'architect',
          effort: 'high',
          restoreAfterTurn: true,
          updatedAt: 1_700_000_000_001,
        })
        await renderComposer(
          makeTestStore({
            conversations: [busyConv],
            models: TEST_MODELS,
            modelDefaults: { modelTiers: TEST_TIERS },
            plugins: [tiersPluginSummary],
            uiContributions: [tiersToolbarContribution],
          }),
          busyConv,
        )
        assert.match(host.textContent ?? '', /This turn:/)
        assert.match(host.textContent ?? '', /tier\/architect/)
        const busyMain = host.querySelector<HTMLButtonElement>('.tiers-borrow-pill-main')
        const busyClear = host.querySelector<HTMLButtonElement>('.tiers-borrow-pill-clear')
        assert.ok(busyMain !== null && busyClear !== null)
        assert.equal(busyMain.disabled, true, 'main pill trigger disabled while active borrow is working')
        assert.equal(busyClear.disabled, false, 'sibling × stays enabled while active borrow is working')

        await act(async () => {
          modelBtn.click()
        })
        popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
        assert.ok(popover !== null)
        assert.ok(popover.querySelector('.composer-model-mode-bar') === null, 'Next turn tab disappears while active/busy')
        await act(async () => {
          popover!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        })
        await flushUi()

        // Clicking sibling × clears active borrow cleanly
        await act(async () => {
          busyClear.click()
        })
        await flushUi()
        assert.deepEqual(actionCalls[2], {
          pluginId: 'builtin:tiers',
          actionId: 'clear_borrow',
          input: { conversationId: 30 },
        })
        assert.ok(document.body.querySelector('.composer-model-popover') === null)

        // Disabling builtin:tiers removes pill and mode bar cleanly without phantom prompt/mode
        await renderComposer(
          makeTestStore({
            conversations: [conv],
            models: TEST_MODELS,
            modelDefaults: { modelTiers: TEST_TIERS },
            plugins: [{ ...tiersPluginSummary, enabled: false, status: 'disabled' }],
            uiContributions: [],
          }),
          conv,
        )
        assert.ok(host.querySelector('.tiers-borrow-pill') === null)
        await act(async () => {
          modelBtn.click()
        })
        popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
        assert.ok(popover !== null)
        assert.ok(popover.querySelector('.composer-model-mode-bar') === null, 'disabling builtin:tiers must remove Next turn tab')
      } finally {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      }

      // --- 3. Standby (#/a/<profileId>): unified ModelPicker Next turn tab, draftMeta without dirtying drafts, armed pill ---
      resetStandbyDrafts()
      const standbyHarness = createSessionDocHarness()
      const standbyActions: Array<{ pluginId: string; actionId: string }> = []
      const standbyStore = makeTestStore({
        profiles: [
          {
            id: 'assistant',
            name: 'Assistant',
            model: 'faux/workhorse',
            thinkingLevel: 'high',
            cwd: '/repo',
            nodeId: 'local',
          },
        ],
        models: TEST_MODELS,
        modelDefaults: { modelTiers: TEST_TIERS },
        plugins: [tiersPluginSummary],
        uiContributions: [tiersToolbarContribution],
      })
      const standbyHost = document.createElement('div')
      document.body.appendChild(standbyHost)
      const standbyRoot = createRoot(standbyHost)
      try {
        await act(async () => {
          standbyRoot.render(
            e(
              HostStoreProviders,
              { value: standbyStore },
              e(
                WithSessionDocOverride,
                {
                  harness: standbyHarness,
                  onInvokeAction: async (pluginId, actionId) => {
                    standbyActions.push({ pluginId, actionId })
                    return {}
                  },
                },
                e(AgentStandbyPane, { profileId: 'assistant' }),
              ),
            ),
          )
        })

        // Idle standby: zero pill buttons and zero sessionDoc subscriptions
        assert.ok(standbyHost.querySelector('.tiers-borrow-pill') === null)
        assert.equal(standbyHarness.subscribedKeys.length, 0)
        const standbyTextarea = standbyHost.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')
        assert.ok(standbyTextarea !== null)

        const standbyModelBtn = standbyHost.querySelector<HTMLButtonElement>('button.composer-model-button')
        assert.ok(standbyModelBtn !== null)
        await act(async () => {
          standbyModelBtn.click()
        })
        let standbyPopover = document.body.querySelector<HTMLElement>('.composer-model-popover')
        assert.ok(standbyPopover !== null)
        const standbyTabs = Array.from(standbyPopover.querySelectorAll<HTMLElement>('.composer-model-mode-bar [role="tab"]'))
        assert.equal(standbyTabs.length, 2)
        assert.equal(standbyTabs[0]?.getAttribute('aria-selected'), 'true')
        await act(async () => {
          standbyTabs[1]?.click()
        })
        assert.equal(standbyTabs[1]?.getAttribute('aria-selected'), 'true')
        assert.ok(standbyPopover.querySelector('.composer-model-reset') === null)

        // Pick tier/architect -> updates draftMeta locally (ZERO RPC & standbyDraftsDirty stays false)
        const archBtn = Array.from(standbyPopover.querySelectorAll<HTMLButtonElement>('.composer-model-row-main')).find(
          (b) => (b.textContent ?? '').includes('tier/architect'),
        )
        assert.ok(archBtn !== undefined)
        const flushStandby = async () => {
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 15))
          })
        }
        await act(async () => {
          archBtn.click()
        })
        await flushStandby()
        assert.equal(standbyActions.length, 0, 'standby Next turn selection must NOT call backend RPC')
        assert.equal(standbyDraftsDirty(), false, 'standby Next turn draftMeta must not mark text drafts dirty')
        await waitFor(() => document.activeElement === standbyTextarea, { timeoutMs: 2_000, intervalMs: 10 })
        assert.ok(document.activeElement === standbyTextarea)
        assert.match(standbyHost.textContent ?? '', /Next turn:/)
        assert.match(standbyHost.textContent ?? '', /tier\/architect/)

        // Clicking ModelPicker trigger resets to Switch model; clicking armed pill jumps directly to Next turn
        await act(async () => {
          standbyModelBtn.click()
        })
        standbyPopover = document.body.querySelector<HTMLElement>('.composer-model-popover')
        assert.ok(standbyPopover !== null)
        assert.equal(
          standbyPopover.querySelector('.composer-model-mode-bar [role="tab"]')?.getAttribute('aria-selected'),
          'true',
          'standby trigger click must reset to Switch model',
        )
        await act(async () => {
          standbyPopover!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        })
        await flushStandby()

        const standbyPillMain = standbyHost.querySelector<HTMLButtonElement>('.tiers-borrow-pill-main')
        assert.ok(standbyPillMain !== null)
        await act(async () => {
          standbyPillMain.click()
        })
        standbyPopover = document.body.querySelector<HTMLElement>('.composer-model-popover')
        assert.ok(standbyPopover !== null)
        const standbyPillTabs = Array.from(standbyPopover.querySelectorAll<HTMLElement>('.composer-model-mode-bar [role="tab"]'))
        assert.equal(standbyPillTabs[1]?.getAttribute('aria-selected'), 'true', 'standby armed pill jumps straight to Next turn')
        await act(async () => {
          standbyPopover!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        })
        await flushStandby()

        // Click sibling × clears draftMeta without reopening Popover
        const clearBtn = standbyHost.querySelector<HTMLButtonElement>('.tiers-borrow-pill-clear')
        assert.ok(clearBtn !== null)
        await act(async () => {
          clearBtn.click()
        })
        assert.ok(document.body.querySelector('.composer-model-popover') === null)
        assert.ok(standbyHost.querySelector('.tiers-borrow-pill') === null)
      } finally {
        await act(async () => {
          standbyRoot.unmount()
        })
        standbyHost.remove()
      }
    } finally {
      globalThis.fetch = origFetch
      resetStandbyDrafts()
      resetPluginClientCache()
      mountSharedPluginNamespaces({ realHooks: false })
    }
  })

  test('SwitchModelToolRow: renders one-turn and persistent presentationMeta, running fallback, and error state without parsing result JSON', { timeout: 60_000 }, async () => {
    const ctx = makeSpyCtx()

    // 1. One-turn switch (auto-restores) — ignores bogus non-JSON result string
    const oneTurnMount = await mountWithHost(
      e(
        PluginClientContext.Provider,
        { value: ctx },
        e(SwitchModelToolRow, {
          callId: 'call-1',
          conversationId: 1,
          toolName: TIERS_SWITCH_MODEL_TOOL,
          input: { model: 'tier/architect' },
          status: 'done',
          result: 'not json at all',
          durationMs: 42,
          presentationMeta: {
            fromModel: 'faux/workhorse',
            toModel: 'faux/flagship',
            toLabel: 'tier/architect',
            tierId: 'architect',
            effort: 'high',
            restoreAfterTurn: true,
            changed: true,
          },
        }),
      ),
    )
    try {
      const text = oneTurnMount.host.textContent ?? ''
      assert.match(text, /Switch model/)
      assert.match(text, /tier\/architect · high/)
      assert.match(text, /auto-restores after turn/)
      assert.match(text, /One-turn/)
      assert.match(text, /42ms/)
      assert.equal(
        oneTurnMount.host.querySelector('.tiers-trace-row')?.getAttribute('data-tiers-switch-restore'),
        'true',
      )
    } finally {
      await oneTurnMount.unmount()
    }

    // 2. Persistent switch (`restoreAfterTurn: false`)
    const permMount = await mountWithHost(
      e(
        PluginClientContext.Provider,
        { value: ctx },
        e(SwitchModelToolRow, {
          callId: 'call-2',
          conversationId: 1,
          toolName: TIERS_SWITCH_MODEL_TOOL,
          input: { model: 'faux/flagship', restoreAfterTurn: false },
          status: 'done',
          presentationMeta: {
            fromModel: 'faux/workhorse',
            toModel: 'faux/flagship',
            toLabel: 'flagship',
            restoreAfterTurn: false,
            changed: true,
          },
        }),
      ),
    )
    try {
      const text = permMount.host.textContent ?? ''
      assert.match(text, /Permanently switched to flagship/)
      assert.match(text, /Persistent/)
      assert.equal(
        permMount.host.querySelector('.tiers-trace-row')?.getAttribute('data-tiers-switch-restore'),
        'false',
      )
    } finally {
      await permMount.unmount()
    }

    // 3. Running & error fallback
    const errorMount = await mountWithHost(
      e(
        PluginClientContext.Provider,
        { value: ctx },
        e(
          React.Fragment,
          null,
          e(SwitchModelToolRow, {
            callId: 'call-3',
            conversationId: 1,
            toolName: TIERS_SWITCH_MODEL_TOOL,
            input: { model: 'tier/architect' },
            status: 'running',
          }),
          e(SwitchModelToolRow, {
            callId: 'call-4',
            conversationId: 1,
            toolName: TIERS_SWITCH_MODEL_TOOL,
            input: { model: 'faux/disabled' },
            status: 'error',
            isError: true,
            result: 'Model faux/disabled is disabled\nsecond line ignored',
          }),
        ),
      ),
    )
    try {
      const text = errorMount.host.textContent ?? ''
      assert.match(text, /tier\/architect/)
      assert.match(text, /Model faux\/disabled is disabled/)
      assert.equal(errorMount.host.querySelector('.trace-row-error') !== null, true)
    } finally {
      await errorMount.unmount()
    }
  })

  test('ModelPickerControl coarse touch vs desktop auto-focus when opening registered mode directly via openMode()', { timeout: 60_000 }, async () => {
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

    const runScenario = async (coarse: boolean): Promise<void> => {
      stubCoarse(coarse)
      const registry = createComposerModelPickerModeRegistry()
      let openOneTurn: (() => boolean) | null = null

      function ModeHarness() {
        const mode = useComposerModelPickerMode('tiers:one-turn', {
          id: 'tiers:one-turn',
          label: 'Next turn',
          hint: 'One-turn test mode',
          onApply: () => {},
        })
        openOneTurn = mode.openMode
        return e(ModelPickerControl, {
          effectiveModel: 'faux/workhorse',
          activeThinkingLevel: '',
          enableRegisteredModes: true,
          onApply: () => {},
        })
      }

      const mounted = await mountWithHost(
        e(ComposerModelPickerModeContext.Provider, { value: registry }, e(ModeHarness)),
      )
      try {
        await act(async () => {
          assert.equal(openOneTurn?.(), true)
        })
        await act(async () => {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve())
          })
          await new Promise((resolve) => setTimeout(resolve, 20))
        })
        const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
        assert.ok(popover !== null, `Popover must remain open after rAF (coarse=${coarse})`)
        if (coarse) {
          assert.ok(document.activeElement === popover, 'coarse touch keeps focus on .composer-model-popover')
        } else {
          const searchInput = popover.querySelector<HTMLInputElement>('input')
          assert.ok(searchInput !== null && document.activeElement === searchInput, 'desktop keeps focus on search input')
        }
      } finally {
        await mounted.unmount()
      }
    }

    try {
      await runScenario(false)
      await runScenario(true)
    } finally {
      window.matchMedia = originalMatchMedia
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

  test('TiersManagerScreen: dual-phase orchestrator drawer editing, validation, and set payload', { timeout: 60_000 }, async () => {
    const ctx = makeSpyCtx()
    setBuiltinClientStub({
      docs: {
        state: {
          tiers: {
            'claude-auto': {
              kind: 'orchestrator',
              model: 'faux/flagship',
              thinkingLevel: 'xhigh',
              executorModel: 'faux/workhorse',
              executorThinkingLevel: 'medium',
              maxExecutionSteps: 12,
              description: 'Planner -> Executor pair',
            },
          },
          templates: {},
        },
      },
    })
    const mounted = await mountWithHost(
      e(PluginClientContext.Provider, { value: ctx }, e(TiersManagerScreen, { screenId: 'main' })),
    )
    try {
      const rowTrigger = mounted.host.querySelector<HTMLButtonElement>(
        '[data-tier-id="claude-auto"] .tiers-row-trigger',
      )
      assert.ok(rowTrigger !== null, 'expected orchestrator tier row trigger')
      await act(async () => {
        rowTrigger.click()
      })
      const drawer = document.body.querySelector<HTMLElement>('.tiers-drawer')
      assert.ok(drawer !== null)
      const executorPicker = drawer.querySelector<HTMLButtonElement>(
        'button[aria-label*="Executor model"][aria-label*="tier/claude-auto"]',
      )
      assert.ok(executorPicker !== null, 'hydrated orchestrator tier shows Executor picker in drawer')
      const stepsInput = drawer.querySelector<HTMLInputElement>('input[type="number"][min="0"][max="100"]')
      assert.ok(stepsInput !== null && stepsInput.value === '12')

      // Set maxExecutionSteps > 100 -> validation blocks save
      const segTabs = Array.from(drawer.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      assert.equal(segTabs.length, 2)
      await act(async () => {
        setInputValue(stepsInput, '101')
      })
      await act(async () => {
        findButton(document.body.querySelector('.tiers-drawer-shell')!, 'Save').click()
      })
      assert.match(drawer.textContent ?? '', /between 0 and 100/i)
      assert.equal(ctx.actionCalls.length, 0)

      // Set maxExecutionSteps = 0 (unlimited) -> saves cleanly with maxExecutionSteps: 0 and closes drawer
      await act(async () => {
        setInputValue(stepsInput, '0')
      })
      await act(async () => {
        findButton(document.body.querySelector('.tiers-drawer-shell')!, 'Save').click()
      })
      assert.equal(ctx.actionCalls.length, 1)
      assert.equal(ctx.actionCalls[0]?.actionId, 'set')
      assert.equal((ctx.actionCalls[0]?.input as { maxExecutionSteps?: number }).maxExecutionSteps, 0)
      assert.ok(document.body.querySelector('.tiers-drawer') === null)

      // Reopen drawer -> set steps = 15 -> calls set with full orchestrator payload
      await act(async () => {
        rowTrigger.click()
      })
      const reopenedSteps = document.body.querySelector<HTMLInputElement>('.tiers-drawer input[type="number"][min="0"][max="100"]')
      assert.ok(reopenedSteps !== null)
      await act(async () => {
        setInputValue(reopenedSteps, '15')
      })
      await act(async () => {
        findButton(document.body.querySelector('.tiers-drawer-shell')!, 'Save').click()
      })
      assert.equal(ctx.actionCalls.length, 2)
      assert.deepEqual(ctx.actionCalls[1], {
        actionId: 'set',
        input: {
          id: 'claude-auto',
          kind: 'orchestrator',
          model: 'faux/flagship',
          thinkingLevel: 'xhigh',
          executorModel: 'faux/workhorse',
          executorThinkingLevel: 'medium',
          maxExecutionSteps: 15,
          description: 'Planner -> Executor pair',
        },
      })

      // Reopen drawer -> switch from orchestrator to single -> omits executor fields strictly
      await act(async () => {
        rowTrigger.click()
      })
      const singleTab = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.tiers-drawer [role="tab"]')).find(
        (btn) => (btn.textContent ?? '').includes('Single'),
      )
      assert.ok(singleTab !== undefined)
      await act(async () => {
        singleTab.click()
      })
      await act(async () => {
        findButton(document.body.querySelector('.tiers-drawer-shell')!, 'Save').click()
      })
      assert.deepEqual(ctx.actionCalls[2], {
        actionId: 'set',
        input: {
          id: 'claude-auto',
          kind: 'single',
          model: 'faux/flagship',
          thinkingLevel: 'xhigh',
          description: 'Planner -> Executor pair',
        },
      })
    } finally {
      await mounted.unmount()
    }
  })

  test('OrchestratorStatusBadge + BorrowToolbarPill + OrchestratorToolRow: renders compact status-row indicator with detail popover, keeps toolbar free, suppresses on borrow/ineligible, and renders trace rows', { timeout: 60_000 }, async () => {
    const {
      parseTierOrchestratorSessionView,
      parseOrchestratorTransitionMeta,
      formatOrchestratorStepLabel,
      formatOrchestratorActiveModelShort,
    } = await import('../../plugins/src/tiers/client/orchestrator-models.ts')
    assert.equal(parseTierOrchestratorSessionView(null), null)
    assert.equal(parseOrchestratorTransitionMeta({ tool: 'bogus' }), undefined)
    assert.equal(
      parseTierOrchestratorSessionView({
        tierId: 'claude-auto',
        phase: 'execution',
        activeModel: 'faux/workhorse',
        plannerModel: 'faux/flagship',
        executorModel: 'faux/workhorse',
        executionStepCount: 3,
        maxExecutionSteps: 0,
        updatedAt: 1000,
      })?.maxExecutionSteps,
      0,
    )
    assert.equal(formatOrchestratorStepLabel('planning', 3, 10), '')
    assert.equal(formatOrchestratorStepLabel('execution', 3, 10), '3/10')
    assert.equal(formatOrchestratorStepLabel('execution', 3, 0), '3')
    assert.equal(formatOrchestratorActiveModelShort('faux/workhorse'), 'workhorse')
    assert.equal(formatOrchestratorActiveModelShort('tier/claude-auto'), 'tier/claude-auto')

    mountSharedPluginNamespaces({ realHooks: true })
    resetPluginClientCache()
    seedPluginClientModule('builtin:tiers', 'BorrowToolbarPill.tsx', rawTiersModule)
    seedPluginClientModule('builtin:tiers', 'OrchestratorStatusBadge.tsx', rawTiersModule)

    const OrchestratorToolRow = rawTiersModule['OrchestratorToolRow'] as (props: ToolViewProps) => React.ReactElement
    const ctxEn = makeSpyCtx('en')
    const ctxZh = makeSpyCtx('zh-CN')
    const orchTiers = [
      ...TEST_TIERS,
      {
        id: 'claude-auto',
        kind: 'orchestrator' as const,
        model: 'faux/flagship',
        executorModel: 'faux/workhorse',
        maxExecutionSteps: 10,
        description: 'Dual-phase orchestrator',
        available: true,
        thinkingLevels: ['off', 'high', 'xhigh'],
      },
    ]

    const tiersPluginSummary = {
      id: 'builtin:tiers',
      name: 'tiers',
      version: '1.0.0',
      locked: false,
      enabled: true,
      status: 'active' as const,
      hooks: [],
      actions: [],
      tools: [],
      clientHashes: {
        'BorrowToolbarPill.tsx': 'seeded',
        'OrchestratorStatusBadge.tsx': 'seeded',
      },
    }
    const tiersSlotContributions = [
      {
        pluginId: 'builtin:tiers',
        surface: 'plugin.slot' as const,
        spec: {
          id: 'tiers-orchestrator-status',
          target: COMPOSER_STATUS_SLOT,
          order: 5,
          client: { module: 'OrchestratorStatusBadge.tsx', export: 'OrchestratorStatusBadge' },
        },
      },
      {
        pluginId: 'builtin:tiers',
        surface: 'plugin.slot' as const,
        spec: {
          id: 'tiers-borrow-toolbar-pill',
          target: COMPOSER_TOOLBAR_SLOT,
          order: 15,
          client: { module: 'BorrowToolbarPill.tsx', export: 'BorrowToolbarPill' },
        },
      },
    ]

    try {
      // 1) Ineligible / non-orchestrator / standby mounts open ZERO sessionDoc subscriptions and render null
      const ineligibleHarness = createSessionDocHarness()
      const ineligibleMount = await mountWithHost(
        e(
          WithSessionDocOverride,
          { harness: ineligibleHarness },
          e(
            PluginClientContext.Provider,
            { value: ctxEn },
            e(
              React.Fragment,
              null,
              e(OrchestratorStatusBadge, { conversation: makeConv(201, { model: 'faux/workhorse' }) }),
              e(OrchestratorStatusBadge, {
                conversation: makeConv(202, { parentConversationId: 1, modelTier: 'tier/claude-auto' }),
              }),
              e(OrchestratorStatusBadge, {
                conversation: makeConv(203, { ownedBy: 'helmx', modelTier: 'tier/claude-auto' }),
              }),
              e(OrchestratorStatusBadge, { effectiveModel: 'tier/claude-auto', profileId: 'assistant' }),
            ),
          ),
        ),
        { modelDefaults: { modelTiers: orchTiers } },
      )
      try {
        assert.equal(ineligibleMount.host.textContent, '')
        assert.equal(
          ineligibleHarness.subscribedKeys.length,
          0,
          'non-orchestrator, subagent, helmx-owned, and standby mounts must open zero sessionDoc subscriptions',
        )
      } finally {
        await ineligibleMount.unmount()
      }

      // 2) Full Composer integration: toolbar stays free of orchestrator pill while status row renders trigger + popover
      const orchIdleConv = makeConv(77, {
        status: 'idle',
        model: 'faux/workhorse',
        modelTier: 'tier/claude-auto',
        modelOverride: 'tier/claude-auto',
      })
      const execHarness = createSessionDocHarness({
        'builtin:tiers/orchestrator/77': {
          value: {
            tierId: 'claude-auto',
            phase: 'execution',
            activeModel: 'faux/workhorse',
            plannerModel: 'faux/flagship',
            executorModel: 'faux/workhorse',
            executionStepCount: 3,
            maxExecutionSteps: 10,
            updatedAt: 1000,
          },
          hasValue: true,
          deleted: false,
          connected: true,
        },
      })
      const composerHost = document.createElement('div')
      document.body.appendChild(composerHost)
      const composerRoot = createRoot(composerHost)
      const renderComposer = async (convToRender: ConversationSummary, harness = execHarness) => {
        const storeForRender = makeTestStore({
          conversations: [convToRender],
          models: TEST_MODELS,
          modelDefaults: { modelTiers: orchTiers },
          plugins: [tiersPluginSummary],
          uiContributions: tiersSlotContributions,
        })
        await act(async () => {
          composerRoot.render(
            e(
              HostStoreProviders,
              { value: storeForRender },
              e(
                WithSessionDocOverride,
                { harness },
                e(Composer, { conversation: convToRender, prefill: null }),
              ),
            ),
          )
        })
      }
      try {
        await renderComposer(orchIdleConv, execHarness)
        const toolbarSlot = composerHost.querySelector('.composer-toolbar-slot')
        assert.ok(toolbarSlot !== null)
        assert.ok(toolbarSlot.querySelector('.tiers-borrow-pill') === null, 'idle orchestrator without borrow leaves toolbar empty')
        assert.ok(toolbarSlot.querySelector('.tiers-orchestrator-pill') === null, 'orchestrator pill must no longer render in toolbar')
        assert.equal(toolbarSlot.querySelectorAll('button').length, 0)

        const trigger = composerHost.querySelector<HTMLButtonElement>('.composer-status-row .tiers-orch-status-trigger')
        assert.ok(trigger !== null, 'status row renders OrchestratorStatusBadge trigger')
        assert.equal(trigger.getAttribute('data-tiers-orchestrator-phase'), 'execution')
        assert.equal(trigger.getAttribute('data-tiers-orchestrator-tier'), 'claude-auto')
        assert.match(trigger.textContent ?? '', /Exec.*3\/10.*workhorse/)
        assert.equal(EMOJI_RE.test(trigger.textContent ?? ''), false)

        // Idle orchestrator conversation still exposes tiers:one-turn mode inside ModelPicker
        const modelBtn = composerHost.querySelector<HTMLButtonElement>('button.composer-model-button')
        assert.ok(modelBtn !== null)
        await act(async () => {
          modelBtn.click()
        })
        assert.ok(document.body.querySelector('.composer-model-mode-bar') !== null, 'idle orchestrator still exposes tiers:one-turn mode tab')
        await act(async () => {
          modelBtn.click()
        })

        // Click trigger -> opens Radix Popover with full tier & Planner/Executor details
        await act(async () => {
          trigger.click()
        })
        const popover = document.body.querySelector<HTMLElement>('.tiers-orch-popover')
        assert.ok(popover !== null, 'clicking status badge opens detail popover')
        const popText = popover.textContent ?? ''
        assert.match(popText, /tier\/claude-auto/)
        assert.match(popText, /Execution/)
        assert.match(popText, /faux\/flagship/)
        assert.match(popText, /faux\/workhorse/)
        assert.match(popText, /3 \/ 10/)
        const activeRow = popover.querySelector<HTMLElement>('.tiers-orch-popover-row[data-active="true"]')
        assert.ok(activeRow !== null && (activeRow.textContent ?? '').includes('faux/workhorse'))
        assert.equal(EMOJI_RE.test(popText), false)

        const closeBtn = popover.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
        assert.ok(closeBtn !== null)
        await act(async () => {
          closeBtn.click()
        })
        assert.ok(document.body.querySelector('.tiers-orch-popover') === null)

        // Busy orchestrator conversation: suppresses tiers:one-turn mode while keeping status badge visible
        const busyOrchConv = makeConv(77, {
          status: 'working',
          model: 'faux/workhorse',
          modelTier: 'tier/claude-auto',
          modelOverride: 'tier/claude-auto',
        })
        await renderComposer(busyOrchConv, execHarness)
        await act(async () => {
          composerHost.querySelector<HTMLButtonElement>('button.composer-model-button')?.click()
        })
        assert.ok(document.body.querySelector('.composer-model-mode-bar') === null, 'busy orchestrator suppresses tiers:one-turn mode')
        await act(async () => {
          composerHost.querySelector<HTMLButtonElement>('button.composer-model-button')?.click()
        })
        assert.ok(
          composerHost.querySelector('.composer-status-row .tiers-orch-status-trigger') !== null,
          'status row badge stays visible while working',
        )

        // Armed one-turn borrow suppresses OrchestratorStatusBadge and renders BorrowToolbarPill in toolbar
        const armedHarness = createSessionDocHarness({
          'builtin:tiers/orchestrator/77': execHarness.getSessionDocState({
            pluginId: 'builtin:tiers',
            docName: 'orchestrator',
            conversationId: 77,
          }),
          'builtin:tiers/borrow/77': {
            value: {
              phase: 'armed',
              requestedRef: 'faux/fast',
              targetModel: 'faux/fast',
              targetConcreteModel: 'faux/fast',
              targetLabel: 'fast',
              restoreAfterTurn: true,
              updatedAt: 1001,
            },
            hasValue: true,
            deleted: false,
            connected: true,
          },
        })
        await renderComposer(orchIdleConv, armedHarness)
        assert.ok(
          composerHost.querySelector('.composer-toolbar-slot .tiers-borrow-pill[data-tiers-borrow-phase="armed"]') !== null,
          'armed borrow pill renders in toolbar slot',
        )
        assert.ok(
          composerHost.querySelector('.composer-status-row .tiers-orch-status-trigger') === null,
          'armed borrow suppresses orchestrator status badge',
        )
      } finally {
        await act(async () => {
          composerRoot.unmount()
        })
        composerHost.remove()
      }

      // 3) Planning phase, zh-CN locale, unlimited steps, and missing-doc fallback via hostModels
      const planUnlimitedHarness = createSessionDocHarness({
        'builtin:tiers/orchestrator/77': {
          value: {
            tierId: 'claude-auto',
            phase: 'planning',
            activeModel: 'faux/flagship',
            plannerModel: 'faux/flagship',
            executorModel: 'faux/workhorse',
            executionStepCount: 0,
            maxExecutionSteps: 0,
            updatedAt: 1000,
          },
          hasValue: true,
          deleted: false,
          connected: true,
        },
      })
      const zhMount = await mountWithHost(
        e(
          WithSessionDocOverride,
          { harness: planUnlimitedHarness },
          e(
            PluginClientContext.Provider,
            { value: ctxZh },
            e(OrchestratorStatusBadge, {
              conversation: makeConv(77, {
                model: 'faux/flagship',
                modelTier: 'tier/claude-auto',
                modelOverride: 'tier/claude-auto',
              }),
            }),
          ),
        ),
        { modelDefaults: { modelTiers: orchTiers } },
      )
      try {
        const trigger = zhMount.host.querySelector<HTMLButtonElement>('.tiers-orch-status-trigger')
        assert.ok(trigger !== null)
        assert.equal(trigger.getAttribute('data-tiers-orchestrator-phase'), 'planning')
        assert.match(trigger.textContent ?? '', /^规划·flagship$/)
        assert.equal(EMOJI_RE.test(trigger.textContent ?? ''), false)

        await act(async () => {
          trigger.click()
        })
        const popover = document.body.querySelector<HTMLElement>('.tiers-orch-popover')
        assert.ok(popover !== null)
        const popText = popover.textContent ?? ''
        assert.match(popText, /规划阶段/)
        assert.match(popText, /规划模型/)
        assert.match(popText, /执行模型/)
        assert.match(popText, /0（不限）/)
        assert.match(popText, /当前/)
        await act(async () => {
          popover.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')?.click()
        })
      } finally {
        await zhMount.unmount()
      }

      // Unlimited steps during execution (zh-CN + en)
      const execUnlimitedHarness = createSessionDocHarness({
        'builtin:tiers/orchestrator/78': {
          value: {
            tierId: 'claude-auto',
            phase: 'execution',
            activeModel: 'faux/workhorse',
            plannerModel: 'faux/flagship',
            executorModel: 'faux/workhorse',
            executionStepCount: 4,
            maxExecutionSteps: 0,
            updatedAt: 1000,
          },
          hasValue: true,
          deleted: false,
          connected: true,
        },
      })
      const zhExecMount = await mountWithHost(
        e(
          WithSessionDocOverride,
          { harness: execUnlimitedHarness },
          e(
            PluginClientContext.Provider,
            { value: ctxZh },
            e(OrchestratorStatusBadge, {
              conversation: makeConv(78, {
                model: 'faux/workhorse',
                modelTier: 'tier/claude-auto',
                modelOverride: 'tier/claude-auto',
              }),
            }),
          ),
        ),
        { modelDefaults: { modelTiers: orchTiers } },
      )
      try {
        const trigger = zhExecMount.host.querySelector<HTMLButtonElement>('.tiers-orch-status-trigger')
        assert.ok(trigger !== null)
        assert.match(trigger.textContent ?? '', /执行4·workhorse/)
        await act(async () => {
          trigger.click()
        })
        const popover = document.body.querySelector<HTMLElement>('.tiers-orch-popover')
        assert.ok(popover !== null)
        assert.match(popover.textContent ?? '', /4（不限）/)
        await act(async () => {
          popover.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')?.click()
        })
      } finally {
        await zhExecMount.unmount()
      }

      // Missing orchestrator sessionDoc falls back to hostModels.modelTiers for planner & executor
      const emptyOrchHarness = createSessionDocHarness()
      const fallbackMount = await mountWithHost(
        e(
          WithSessionDocOverride,
          { harness: emptyOrchHarness },
          e(
            PluginClientContext.Provider,
            { value: ctxEn },
            e(OrchestratorStatusBadge, {
              conversation: makeConv(79, {
                model: 'faux/flagship',
                modelTier: 'tier/claude-auto',
                modelOverride: 'tier/claude-auto',
              }),
            }),
          ),
        ),
        { modelDefaults: { modelTiers: orchTiers } },
      )
      try {
        const trigger = fallbackMount.host.querySelector<HTMLButtonElement>('.tiers-orch-status-trigger')
        assert.ok(trigger !== null)
        assert.match(trigger.textContent ?? '', /Plan·flagship/)
        await act(async () => {
          trigger.click()
        })
        const popover = document.body.querySelector<HTMLElement>('.tiers-orch-popover')
        assert.ok(popover !== null)
        assert.match(popover.textContent ?? '', /faux\/flagship/)
        assert.match(popover.textContent ?? '', /faux\/workhorse/)
        assert.match(popover.textContent ?? '', /0 \/ 10/)
        await act(async () => {
          popover.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click()
        })
      } finally {
        await fallbackMount.unmount()
      }

      // 4) OrchestratorToolRow timeline rows
      const rowMount = await mountWithHost(
        e(
          PluginClientContext.Provider,
          { value: ctxEn },
          e(
            React.Fragment,
            null,
            e(OrchestratorToolRow, {
              callId: 'c-exit',
              conversationId: 77,
              toolName: 'exit_plan_mode',
              input: { plan: 'do it' },
              status: 'done',
              durationMs: 18,
              presentationMeta: {
                tool: 'exit_plan_mode',
                fromPhase: 'planning',
                toPhase: 'execution',
                fromModel: 'faux/flagship',
                toModel: 'faux/workhorse',
                tierId: 'claude-auto',
              },
            }),
            e(OrchestratorToolRow, {
              callId: 'c-hand',
              conversationId: 77,
              toolName: 'hand_back_to_planner',
              input: { reason: 'done milestone', summary: 'tests pass' },
              status: 'done',
              durationMs: 24,
              presentationMeta: {
                tool: 'hand_back_to_planner',
                fromPhase: 'execution',
                toPhase: 'planning',
                fromModel: 'faux/workhorse',
                toModel: 'faux/flagship',
                tierId: 'claude-auto',
                reason: 'done milestone',
                executionSteps: 3,
                stepLimitReached: false,
              },
            }),
          ),
        ),
      )
      try {
        const text = rowMount.host.textContent ?? ''
        assert.match(text, /Enter execution phase/)
        assert.match(text, /Switched to executor workhorse/)
        assert.match(text, /Hand back to planner/)
        assert.match(text, /Returned to planner flagship/)
        assert.equal(EMOJI_RE.test(text), false)
      } finally {
        await rowMount.unmount()
      }
    } finally {
      resetPluginClientCache()
      mountSharedPluginNamespaces({ realHooks: false })
    }
  })

  test('TiersManagerScreen: model row click displays per-model thinking default while saving dynamic inheritance (single & orchestrator)', { timeout: 60_000 }, async () => {
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
        const idInput = drawer.querySelector<HTMLInputElement>('.tiers-id-wrap input')
        assert.ok(idInput !== null)
        await act(async () => {
          setInputValue(idInput, id)
        })
        const primaryBtn = drawer.querySelector<HTMLButtonElement>('button.composer-model-button')
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
        input: { id: 'coder', kind: 'single', model: 'faux/workhorse' },
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
        input: { id: 'coder', kind: 'single', model: 'faux/workhorse', thinkingLevel: 'high' },
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
        input: { id: 'coder', kind: 'single', model: 'faux/workhorse', thinkingLevel: 'off' },
      })

      // 4) Switch to `faux/fast` (no per-model default) by row body -> shows only `fast` without `·`, then switch to orchestrator and pick Executor `faux/flagship` row body -> displays `high` and omits executorThinkingLevel
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

      const orchTab = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.tiers-drawer [role="tab"]')).find(
        (btn) => (btn.textContent ?? '').includes('Dual-phase'),
      )
      assert.ok(orchTab !== undefined, 'expected Dual-phase segmented tab inside drawer')
      await act(async () => {
        orchTab.click()
      })
      const execPickerBtn = document.body.querySelector<HTMLButtonElement>(
        '.tiers-drawer button[aria-label*="Executor model"]',
      )
      assert.ok(execPickerBtn !== null, 'expected Executor ModelPickerControl button inside drawer')
      await act(async () => {
        execPickerBtn.click()
      })
      const flagshipMain = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.composer-model-row-main')).find(
        (btn) => btn.title.includes('faux/flagship'),
      )
      assert.ok(flagshipMain !== undefined)
      await act(async () => {
        flagshipMain.click()
      })
      assert.match(execPickerBtn.textContent ?? '', /flagship/)
      assert.match(execPickerBtn.textContent ?? '', /high/)
      assert.equal(execPickerBtn.title, 'faux/flagship · high')
      await act(async () => {
        findButton(document.body.querySelector('.tiers-drawer-shell')!, 'Create').click()
      })
      assert.deepEqual(ctx.actionCalls[3], {
        actionId: 'set',
        input: {
          id: 'coder',
          kind: 'orchestrator',
          model: 'faux/fast',
          executorModel: 'faux/flagship',
          maxExecutionSteps: 30,
        },
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
            coder: { kind: 'single', model: 'faux/workhorse', description: 'Daily coding workhorse' },
            architect: { kind: 'single', model: 'faux/flagship', description: 'Architecture and reviews' },
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
      const coderTrigger = host.querySelector<HTMLButtonElement>('[data-tier-id="coder"] .tiers-row-trigger')
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
      const architectTrigger = host.querySelector<HTMLButtonElement>('[data-tier-id="architect"] .tiers-row-trigger')
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
