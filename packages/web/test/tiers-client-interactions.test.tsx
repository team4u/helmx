/**
 * builtin:tiers client module (compiled TSX via @helmx/plugin-build) and ModelPickerControl
 * tier-group interactive DOM tests:
 * - TiersManagerScreen: loading state, starter 5-tier draft fill, client-side validation blocking
 *   incomplete rows, live status badges (available / unavailable), and save/apply/delete template actions;
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
  ComposerToolbarSlotProps,
  ConversationSummary,
  PluginClientContext as PluginClientContextType,
  ToolViewProps,
} from '@helmx/protocol'
import { COMPOSER_TOOLBAR_SLOT } from '@helmx/protocol'
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
let SwitchModelToolRow: (props: ToolViewProps) => React.ReactElement
describe("tiers-client-interactions", () => {


  before(async () => {
    mountSharedPluginNamespaces()
    const mod = await importBuiltinClientModule('builtin:tiers')
    rawTiersModule = mod
    TiersManagerScreen = mod['TiersManagerScreen'] as (props: Record<string, unknown>) => React.ReactElement
    TiersSettingsPanel = mod['TiersSettingsPanel'] as () => React.ReactElement
    BorrowToolbarPill = mod['BorrowToolbarPill'] as (props: ComposerToolbarSlotProps) => React.ReactElement | null
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

  function makeSpyCtx(): SpyCtx {
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
      locale: 'en',
      translate: (text) => resolveLocalizedText(text, 'en'),
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
      assert.ok(fullMount.host.querySelector('.callout-ok') === null, 'must not render inline callout-ok on apply_template')
      assert.deepEqual(ctx.notifications[0], { message: 'Applied template "Budget Mode".', tone: 'info' })
      const afterApplyIds = Array.from(fullMount.host.querySelectorAll('.tiers-id-wrap input')).map(
        (el) => (el as HTMLInputElement).value,
      )
      assert.deepEqual(afterApplyIds, ['coder'], 'applying a template must sync draft rows even when local edits were dirty')

      // Delete first row's template (`budget`) requires ConfirmDialog confirmation
      await act(async () => {
        findButton(fullMount.host, 'Delete').click()
      })
      assert.equal(ctx.actionCalls.length, 1, 'clicking Delete must wait for ConfirmDialog confirmation')
      let confirmDialog = document.body.querySelector('[role="alertdialog"]')
      assert.ok(confirmDialog !== null, 'template Delete opens AlertDialog confirmation')
      await act(async () => {
        findButton(confirmDialog!, 'Cancel').click()
      })
      assert.equal(ctx.actionCalls.length, 1, 'cancelling confirmation dialog must not call delete_template')

      await act(async () => {
        findButton(fullMount.host, 'Delete').click()
      })
      confirmDialog = document.body.querySelector('[role="alertdialog"]')
      assert.ok(confirmDialog !== null)
      const confirmDeleteBtn = Array.from(confirmDialog.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        b.className.includes('btn-danger'),
      )
      assert.ok(confirmDeleteBtn !== undefined)
      await act(async () => {
        confirmDeleteBtn.click()
      })
      assert.deepEqual(ctx.actionCalls[1], { actionId: 'delete_template', input: { id: 'budget' } })
      assert.ok(fullMount.host.querySelector('.callout-ok') === null, 'must not render inline callout-ok on delete_template')
      assert.deepEqual(ctx.notifications[1], { message: 'Deleted template "Budget Mode".', tone: 'info' })

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
      assert.ok(fullMount.host.querySelector('.callout-ok') === null, 'must not render inline callout-ok on save_template')
      assert.deepEqual(ctx.notifications[2], { message: 'Saved template "Custom Roster".', tone: 'info' })

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
      assert.ok(fullMount.host.querySelector('.callout-ok') === null, 'must not render inline callout-ok on Save tiers')
      assert.deepEqual(ctx.notifications[3], { message: 'Model tiers saved and synced to kernel.', tone: 'info' })

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
      const pickerBtn = mounted.host.querySelector<HTMLButtonElement>('button.composer-model-button')
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

  test('TiersManagerScreen: dual-phase orchestrator toggle, validation, and save payload', { timeout: 60_000 }, async () => {
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
      const executorPicker = mounted.host.querySelector<HTMLButtonElement>(
        'button[aria-label*="Executor model"][aria-label*="tier/claude-auto"]',
      )
      assert.ok(executorPicker !== null, 'hydrated orchestrator tier shows Executor picker')
      const stepsInput = mounted.host.querySelector<HTMLInputElement>('input[type="number"][min="1"][max="50"]')
      assert.ok(stepsInput !== null && stepsInput.value === '12')

      // Switch row back to single mode, then back to orchestrator and set maxExecutionSteps invalid (0) -> validation blocks save
      const segTabs = Array.from(mounted.host.querySelectorAll<HTMLButtonElement>('.tiers-kind-row [role="tab"]'))
      assert.equal(segTabs.length, 2)
      await act(async () => {
        setInputValue(stepsInput, '0')
      })
      await act(async () => {
        findButton(mounted.host, 'Save tiers').click()
      })
      assert.match(mounted.host.textContent ?? '', /between 1 and 50/i)
      assert.equal(ctx.actionCalls.length, 0)

      // Restore valid steps 15 and save -> calls replace with kind:'orchestrator', executorModel, and maxExecutionSteps:15
      await act(async () => {
        setInputValue(stepsInput, '15')
      })
      await act(async () => {
        findButton(mounted.host, 'Save tiers').click()
      })
      assert.equal(ctx.actionCalls.length, 1)
      assert.equal(ctx.actionCalls[0]?.actionId, 'replace')
      const savedTiers = (ctx.actionCalls[0]?.input as { tiers: Record<string, Record<string, unknown>> }).tiers
      assert.deepEqual(savedTiers['claude-auto'], {
        kind: 'orchestrator',
        model: 'faux/flagship',
        thinkingLevel: 'xhigh',
        executorModel: 'faux/workhorse',
        executorThinkingLevel: 'medium',
        maxExecutionSteps: 15,
        description: 'Planner -> Executor pair',
      })
    } finally {
      await mounted.unmount()
    }
  })

  test('BorrowToolbarPill + OrchestratorToolRow: shows read-only phase pill, suppresses borrow mode on orchestrator conv, and renders transition trace rows', { timeout: 60_000 }, async () => {
    const {
      parseTierOrchestratorSessionView,
      parseOrchestratorTransitionMeta,
    } = await import('../../plugins/src/tiers/client/orchestrator-models.ts')
    assert.equal(parseTierOrchestratorSessionView(null), null)
    assert.equal(parseOrchestratorTransitionMeta({ tool: 'bogus' }), undefined)

    mountSharedPluginNamespaces({ realHooks: true })
    resetPluginClientCache()
    const OrchestratorToolRow = rawTiersModule['OrchestratorToolRow'] as (props: ToolViewProps) => React.ReactElement
    const modeRegistry = createComposerModelPickerModeRegistry()
    const orchConv = makeConv(77, { model: 'faux/workhorse', modelTier: 'tier/claude-auto', modelOverride: 'tier/claude-auto' })
    const sessionHarness = createSessionDocHarness({
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
    const ctx = makeSpyCtx()
    try {
      const pillMount = await mountWithHost(
        e(
          WithSessionDocOverride,
          { harness: sessionHarness },
          e(
            ComposerModelPickerModeContext.Provider,
            { value: modeRegistry },
            e(
              PluginClientContext.Provider,
              { value: ctx },
              e(BorrowToolbarPill, { conversation: orchConv }),
            ),
          ),
        ),
      )
      try {
        const pill = pillMount.host.querySelector<HTMLElement>('.tiers-orchestrator-pill')
        assert.ok(pill !== null, 'orchestrator tier conversation renders read-only phase pill')
        assert.equal(pill.getAttribute('data-tiers-orchestrator-phase'), 'execution')
        assert.match(pill.textContent ?? '', /Executing:.*workhorse.*3\/10/)
        assert.equal(modeRegistry.getModes().length, 0, 'tiers:one-turn borrow mode must be suppressed on orchestrator conversations')
        assert.equal(EMOJI_RE.test(pill.textContent ?? ''), false)
      } finally {
        await pillMount.unmount()
      }

      const rowMount = await mountWithHost(
        e(
          PluginClientContext.Provider,
          { value: ctx },
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
})
