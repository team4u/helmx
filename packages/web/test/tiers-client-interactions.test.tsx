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
import * as React from 'react'
import { act } from 'react'
import type {
  ComposerMenuSlotProps,
  ComposerToolbarSlotProps,
  ConversationSummary,
  PluginClientContext as PluginClientContextType,
  ToolViewProps,
} from '@helmx/protocol'
import type { PluginSessionDocKey, PluginSessionDocState } from '@helmx/plugin-client'
import {
  TIERS_BORROW_COMMAND_ID,
  TIERS_BORROW_COMMAND_SLASH,
  TIERS_BORROW_SESSION_DOC,
  TIERS_INPUT_META_KEY,
  TIERS_SWITCH_MODEL_TOOL,
  isTiersBorrowEligibleConversation,
  parseSwitchModelPresentationMeta,
  parseTierBorrowSessionView,
  readStandbyBorrowDraft,
} from '../../plugins/src/tiers/client/borrow-models.ts'
import { TIERS_COPY } from '../../plugins/src/tiers/client/copy.ts'
import { ensureHappyDom } from './helpers/dom-harness.js'
import { makeTestStore } from './helpers/store.js'

ensureHappyDom()
const { createRoot } = await import('react-dom/client')
const {
  ComposerCommandContext,
  DropdownMenuContent,
  DropdownMenuRoot,
  ModelPickerControl,
  PluginClientContext,
  PluginClientHostContext,
  createComposerCommandRegistry,
  resolveLocalizedText,
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
let BorrowMenuItem: (props: ComposerMenuSlotProps) => React.ReactElement | null
let BorrowToolbarPill: (props: ComposerToolbarSlotProps) => React.ReactElement | null
let SwitchModelToolRow: (props: ToolViewProps) => React.ReactElement
describe("tiers-client-interactions", () => {


  before(async () => {
    mountSharedPluginNamespaces()
    const mod = await importBuiltinClientModule('builtin:tiers')
    rawTiersModule = mod
    TiersManagerScreen = mod['TiersManagerScreen'] as (props: Record<string, unknown>) => React.ReactElement
    TiersSettingsPanel = mod['TiersSettingsPanel'] as () => React.ReactElement
    BorrowMenuItem = mod['BorrowMenuItem'] as (props: ComposerMenuSlotProps) => React.ReactElement | null
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
    children,
  }: {
    harness: ReturnType<typeof createSessionDocHarness>
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
      }),
      [basePort, harness],
    )
    return e(PluginClientHostContext.Provider, { value: port }, children ?? null)
  }

  test('tiers client module: Fast Refresh exports, borrow CSS classes, pure parsers, and zero Emoji copy', { timeout: 60_000 }, () => {
    assert.equal(TIERS_BORROW_SESSION_DOC, 'borrow')
    assert.equal(TIERS_BORROW_COMMAND_ID, 'borrow-model')
    assert.equal(TIERS_BORROW_COMMAND_SLASH, 'model')
    assert.equal(TIERS_SWITCH_MODEL_TOOL, 'switch_model')
    assert.equal(TIERS_INPUT_META_KEY, 'builtin:tiers')

    const exportNames = Object.keys(rawTiersModule).filter((k) => k !== '__helmxClientCss').sort()
    assert.deepEqual(exportNames, [
      'BorrowMenuItem',
      'BorrowToolbarPill',
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
    assert.match(cssText as string, /\.tiers-borrow-menu-item/)
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

  test('BorrowToolbarPill & BorrowMenuItem: standby draftMeta (zero RPC), /model command, panel-isolated menu open, persisted armed/active pills, busy clear, and zero nested buttons', { timeout: 60_000 }, async () => {
    mountSharedPluginNamespaces({ realHooks: true })
    try {
      // --- 1. Ineligible conversations render null with ZERO sessionDoc subscriptions ---
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
              e(BorrowMenuItem, { conversation: makeConv(20, { parentConversationId: 1 }), onCloseMenu: () => {} }),
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

      // --- 2. Standby (#/a/<profileId>): /model opens picker, picking writes draftMeta locally (zero RPC), pill × clears without opening popover ---
      const standbyHarness = createSessionDocHarness()
      const ctxStandby = makeSpyCtx()
      const registry = createComposerCommandRegistry()
      const draftUpdates: Array<{ key: string; value: unknown }> = []

      function StandbyComposerHarness() {
        const [draftMeta, setDraftMetaState] = React.useState<Record<string, unknown>>({})
        const setDraftMeta = (key: string, value: unknown) => {
          draftUpdates.push({ key, value })
          setDraftMetaState((prev) => {
            const next = { ...prev }
            if (value === undefined) delete next[key]
            else next[key] = value
            return next
          })
        }
        return e(
          ComposerCommandContext.Provider,
          { value: registry },
          e(
            'div',
            { 'data-helmx-panel': 'primary', className: 'composer-box' },
            e('textarea', { 'aria-label': 'standby-composer-input' }),
            e(BorrowToolbarPill, { profileId: 'assistant', draftMeta, setDraftMeta }),
          ),
        )
      }

      const standbyMount = await mountWithHost(
        e(
          WithSessionDocOverride,
          { harness: standbyHarness },
          e(PluginClientContext.Provider, { value: ctxStandby }, e(StandbyComposerHarness)),
        ),
      )
      try {
        // Idle standby: zero visible buttons & zero sessionDoc subscriptions
        assert.equal(standbyMount.host.querySelectorAll('button').length, 0)
        assert.equal(standbyHarness.subscribedKeys.length, 0)
        const standbyTextarea = standbyMount.host.querySelector<HTMLTextAreaElement>('textarea')
        assert.ok(standbyTextarea !== null)

        // Trigger `/model` via ComposerCommandContext -> opens ModelPickerControl popover
        await act(async () => {
          assert.equal(registry.invoke('builtin:tiers', TIERS_BORROW_COMMAND_ID).handled, true)
        })
        const popover = document.body.querySelector('.composer-model-popover')
        assert.ok(popover !== null, '/model command must open borrow picker on standby')
        assert.equal(popover.querySelector('.composer-model-reset') === null, true)

        // Select tier/architect -> writes draftMeta locally with ZERO callAction RPCs and returns focus to textarea
        const archBtn = Array.from(popover.querySelectorAll<HTMLButtonElement>('.composer-model-row-main')).find(
          (b) => (b.textContent ?? '').includes('tier/architect'),
        )
        assert.ok(archBtn !== undefined)
        await act(async () => {
          archBtn.click()
        })
        assert.equal(ctxStandby.actionCalls.length, 0, 'standby borrow selection must NOT call backend RPC')
        assert.deepEqual(draftUpdates[0], {
          key: TIERS_INPUT_META_KEY,
          value: { borrowModel: 'tier/architect' },
        })
        assert.ok(
          document.activeElement === standbyTextarea,
          'selecting a borrow model must return keyboard focus to the owning .composer-box textarea',
        )
        assert.match(standbyMount.host.textContent ?? '', /Next turn:/)
        assert.match(standbyMount.host.textContent ?? '', /tier\/architect/)

        // Assert zero nested <button>
        assert.equal(standbyMount.host.querySelector('button button') === null, true, 'must never render nested <button>')

        // Click × clear button -> clears draftMeta WITHOUT reopening Popover
        const clearBtn = standbyMount.host.querySelector<HTMLButtonElement>('.tiers-borrow-pill-clear')
        assert.ok(clearBtn !== null)
        await act(async () => {
          clearBtn.click()
        })
        assert.deepEqual(draftUpdates[1], { key: TIERS_INPUT_META_KEY, value: undefined })
        assert.equal(document.body.querySelector('.composer-model-popover') === null, true, 'clicking × must not open popover')
        assert.equal(standbyMount.host.querySelectorAll('button').length, 0)
      } finally {
        await standbyMount.unmount()
      }

      // --- 3. Panel-isolated BorrowMenuItem -> BorrowToolbarPill + persisted armed & busy active states ---
      const persistedHarness = createSessionDocHarness()
      const ctxPersisted = makeSpyCtx()
      const convPrimary = makeConv(30)
      const convSplit = makeConv(30)
      let menuClosed = 0

      function SplitAndPrimaryHarness({ conv }: { conv: ConversationSummary }) {
        return e(
          React.Fragment,
          null,
          e(
            'div',
            { 'data-helmx-panel': 'primary' },
            e(BorrowToolbarPill, { conversation: conv }),
          ),
          e(
            'div',
            { 'data-helmx-panel': 'split', className: 'composer-box' },
            e('textarea', { 'aria-label': 'split-composer-input' }),
            e(BorrowToolbarPill, { conversation: convSplit }),
            e(
              DropdownMenuRoot,
              { open: true },
              e(
                DropdownMenuContent,
                { inline: true },
                e(BorrowMenuItem, {
                  conversation: convSplit,
                  onCloseMenu: () => {
                    menuClosed += 1
                  },
                }),
              ),
            ),
          ),
        )
      }

      const persistedMount = await mountWithHost(
        e(
          WithSessionDocOverride,
          { harness: persistedHarness },
          e(PluginClientContext.Provider, { value: ctxPersisted }, e(SplitAndPrimaryHarness, { conv: convPrimary })),
        ),
      )
      try {
        const splitTextarea = persistedMount.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="split-composer-input"]')
        assert.ok(splitTextarea !== null)

        // Click BorrowMenuItem inside split panel -> closes menu & opens ONLY split panel's popover
        const menuItem = persistedMount.host.querySelector<HTMLElement>('.tiers-borrow-menu-item')
        assert.ok(menuItem !== null)
        await act(async () => {
          menuItem.click()
          await Promise.resolve()
          await new Promise((resolve) => setTimeout(resolve, 30))
        })
        assert.equal(menuClosed, 1)
        const popovers = document.body.querySelectorAll('.composer-model-popover')
        assert.equal(popovers.length, 1, 'split BorrowMenuItem must open exactly one panel popover (not primary)')

        // Select faux/flagship with inline xhigh chip -> invokes set_borrow action & returns focus to split textarea
        const flagshipRow = Array.from(document.body.querySelectorAll<HTMLElement>('.composer-model-row')).find(
          (row) =>
            !(row.textContent ?? '').includes('tier/') &&
            (row.querySelector('.composer-model-row-main') as HTMLButtonElement | null)?.title.includes('faux/flagship'),
        )
        assert.ok(flagshipRow !== undefined)
        const xhighChip = Array.from(flagshipRow.querySelectorAll<HTMLButtonElement>('.composer-model-level-chip')).find(
          (b) => b.textContent?.trim() === 'xhigh',
        )
        assert.ok(xhighChip !== undefined)
        await act(async () => {
          xhighChip.click()
        })
        assert.deepEqual(ctxPersisted.actionCalls[0], {
          actionId: 'set_borrow',
          input: { conversationId: 30, model: 'faux/flagship', effort: 'xhigh' },
        })
        assert.ok(
          document.activeElement === splitTextarea,
          'persisted conversation borrow selection must return focus to owning .composer-box textarea',
        )
      } finally {
        await persistedMount.unmount()
      }

      // --- 4. Busy persisted conversation: armed vs active pill & menu behavior ---
      const activeHarness = createSessionDocHarness()
      activeHarness.setBorrowDoc(40, {
        phase: 'active',
        requestedRef: 'tier/architect',
        targetModel: 'tier/architect',
        targetConcreteModel: 'faux/flagship',
        targetLabel: 'tier/architect',
        targetTierId: 'architect',
        effort: 'high',
        restoreAfterTurn: true,
        updatedAt: 1_700_000_000_000,
      })
      const ctxActive = makeSpyCtx()
      const busyConv = makeConv(40, { status: 'working' })
      const idleBusyMenuConv = makeConv(41, { status: 'working' })

      const activeMount = await mountWithHost(
        e(
          WithSessionDocOverride,
          { harness: activeHarness },
          e(
            PluginClientContext.Provider,
            { value: ctxActive },
            e(
              React.Fragment,
              null,
              e(BorrowToolbarPill, { conversation: busyConv }),
              e(
                DropdownMenuRoot,
                { open: true },
                e(
                  DropdownMenuContent,
                  { inline: true },
                  e(BorrowMenuItem, { conversation: idleBusyMenuConv, onCloseMenu: () => {} }),
                ),
              ),
            ),
          ),
        ),
      )
      try {
        assert.match(activeMount.host.textContent ?? '', /This turn:/)
        assert.match(activeMount.host.textContent ?? '', /tier\/architect/)
        assert.equal(activeMount.host.querySelector('button button') === null, true)

        const mainBtn = activeMount.host.querySelector<HTMLButtonElement>('.tiers-borrow-pill-main')
        const clearBtn = activeMount.host.querySelector<HTMLButtonElement>('.tiers-borrow-pill-clear')
        assert.ok(mainBtn !== null && clearBtn !== null)
        assert.equal(mainBtn.disabled, true, 'main pill trigger is disabled while active turn is working')
        assert.equal(clearBtn.disabled, false, 'sibling × button stays enabled while busy in active borrow')

        // Busy menu item without active borrow is disabled
        const busyMenuItem = activeMount.host.querySelector<HTMLElement>('.tiers-borrow-menu-item')
        assert.ok(busyMenuItem !== null)
        assert.equal(busyMenuItem.getAttribute('aria-disabled'), 'true')

        // Click sibling × -> calls clear_borrow without opening Popover
        await act(async () => {
          clearBtn.click()
        })
        assert.deepEqual(ctxActive.actionCalls[0], {
          actionId: 'clear_borrow',
          input: { conversationId: 40 },
        })
        assert.equal(document.body.querySelector('.composer-model-popover') === null, true)
      } finally {
        await activeMount.unmount()
      }
    } finally {
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
})
