/**
 * builtin:duo client module (compiled TSX via @helmx/plugin-build) interactive DOM tests:
 * - Fast Refresh exports, `.duo-*` CSS classes, zero Emoji copy, and pure parsers/validators;
 * - DuoProfileSection (`PROFILE_DETAIL_SECTION_SLOT`): new-profile hint, switch toggle, executor
 *   ModelPickerControl (including `tier/<id>`), maxExecutionSteps validation, save & reset;
 * - Composer + DuoMenuItem (`COMPOSER_MENU_SLOT`) + DuoToolbarPill (`COMPOSER_TOOLBAR_SLOT`) +
 *   DuoSetupDialog: ineligible conversation guard (zero sessionDoc subscriptions), setup modal flow,
 *   planning/execution/coordinator pill phases, Popover Executor edits, revert & disable, and
 *   live plugin disable cleanup;
 * - AgentStandbyPane + Duo standby `draftMeta`: setup flow, profile inheritance, and non-dirty state;
 * - DuoTransitionToolRow (`toolView`): `exit_plan_mode` / `hand_back_to_planner` replay via
 *   `presentationMeta`, running spinner, and raw-text error fallback (never `JSON.parse`).
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { afterEach, before, describe, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type {
  ConversationSummary,
  HookName,
  HostModelEntry,
  ModelTierCatalogEntry,
  PluginClientContext as PluginClientContextType,
  PluginSummary,
  ToolViewProps,
} from '@helmx/protocol'
import {
  COMPOSER_MENU_SLOT,
  COMPOSER_TOOLBAR_SLOT,
} from '@helmx/protocol'
import type { PluginSessionDocKey, PluginSessionDocState } from '@helmx/plugin-client'
import { DUO_COPY } from '../../plugins/src/duo/client/copy.ts'
import {
  DUO_DEFAULT_MAX_STEPS,
  DUO_EXIT_PLAN_MODE_TOOL,
  DUO_HAND_BACK_TOOL,
  DUO_PLUGIN_ID,
  DUO_PROFILES_DOC,
  DUO_SESSION_DOC,
  extractFallbackTransitionInfo,
  extractFirstErrorLine,
  isDuoEligibleConversation,
  parseDuoProfilesDoc,
  parseDuoSessionDoc,
  parseDuoStandbyMeta,
  parseDuoTransitionPresentationMeta,
  resolveModelAvailabilityWarning,
  validateMaxStepsInput,
} from '../../plugins/src/duo/client/models.ts'
import { resetStandbyDrafts, standbyDraftsDirty } from '../src/conversation/standby-model.js'
import { resetPluginClientCache, seedPluginClientModule } from '../src/lib/plugin-client.js'
import { ensureHappyDom, resetHappyDom } from './helpers/dom-harness.js'
import { makeTestStore } from './helpers/store.js'

ensureHappyDom()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { resolveLocalizedText } = await import('@helmx/ui')
const {
  PluginClientContext,
  PluginClientHostContext,
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

let rawDuoModule: Record<string, unknown>
let DuoProfileSection: (props: Record<string, unknown>) => React.ReactElement
let DuoTransitionToolRow: (props: ToolViewProps) => React.ReactElement

describe('duo-client-interactions', () => {
  before(async () => {
    mountSharedPluginNamespaces()
    const mod = await importBuiltinClientModule('builtin:duo')
    rawDuoModule = mod
    DuoProfileSection = mod['DuoProfileSection'] as (props: Record<string, unknown>) => React.ReactElement
    DuoTransitionToolRow = mod['DuoTransitionToolRow'] as (props: ToolViewProps) => React.ReactElement
  }, { timeout: 60_000 })

  afterEach(() => {
    resetStandbyDrafts()
    resetHappyDom()
  }, { timeout: 60_000 })

  const TEST_MODELS: HostModelEntry[] = [
    { id: 'faux/fast', provider: 'faux', modelId: 'fast', available: true, thinkingLevels: ['off', 'low', 'high'] },
    { id: 'faux/workhorse', provider: 'faux', modelId: 'workhorse', available: true, thinkingLevels: ['off', 'medium', 'high'] },
    { id: 'faux/flagship', provider: 'faux', modelId: 'flagship', available: true, thinkingLevels: ['off', 'high', 'xhigh'] },
    { id: 'faux/disabled', provider: 'faux', modelId: 'disabled', available: true, disabled: true, thinkingLevels: ['off'] },
  ]

  const TEST_TIERS: ModelTierCatalogEntry[] = [
    {
      id: 'coder',
      model: 'faux/workhorse',
      thinkingLevel: 'high',
      description: 'Daily coding workhorse',
      available: true,
      thinkingLevels: ['off', 'medium', 'high'],
    },
  ]

  interface SpyCtx extends PluginClientContextType {
    actionCalls: Array<{ actionId: string; input: unknown }>
    notifications: Array<{ message: string; tone: string }>
  }

  function makeSpyCtx(locale: 'en' | 'zh-CN' = 'en'): SpyCtx {
    const actionCalls: Array<{ actionId: string; input: unknown }> = []
    const notifications: Array<{ message: string; tone: string }> = []
    const base: PluginClientContextType = {
      pluginId: DUO_PLUGIN_ID,
      callAction: async (actionId, input) => {
        actionCalls.push({ actionId, input })
        return {}
      },
      fetchRoute: async () => { throw new Error('fetchRoute not implemented in test stub') },
      submitInput: async () => {},
      openScreen: () => {},
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
    return Object.assign(base, { actionCalls, notifications })
  }

  function makeConv(id: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
    return {
      id,
      title: `Conversation #${id}`,
      profileId: 'assistant',
      tags: [],
      ownedBy: 'human',
      cwd: '/repo',
      model: 'faux/workhorse',
      thinkingLevel: 'medium',
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

    const setDuoDoc = (conversationId: number, value: unknown): void => {
      const k = `${DUO_PLUGIN_ID}/${DUO_SESSION_DOC}/${conversationId}`
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

    return { subscribedKeys, setDuoDoc, subscribeSessionDoc, getSessionDocState, retrySessionDoc }
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

  async function mountWithHost(
    node: React.ReactNode,
    storeOverrides: Parameters<typeof makeTestStore>[0] = {},
  ): Promise<{ host: HTMLElement; store: ReturnType<typeof makeTestStore>; unmount: () => Promise<void> }> {
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
      store,
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

  function makeDuoPluginSummary(): PluginSummary {
    const hooks: HookName[] = ['before_turn', 'turn_settled']
    return {
      id: DUO_PLUGIN_ID,
      name: 'duo',
      version: '1.0.0',
      locked: false,
      enabled: true,
      status: 'active',
      hooks,
      actions: [],
      tools: [DUO_EXIT_PLAN_MODE_TOOL, DUO_HAND_BACK_TOOL],
      clientHashes: { 'index.tsx': 'seeded' },
    }
  }

  function makeDuoUiContributions() {
    return [
      {
        pluginId: DUO_PLUGIN_ID,
        surface: 'plugin.slot' as const,
        spec: {
          id: 'duo-menu-item',
          target: COMPOSER_MENU_SLOT,
          order: 25,
          client: { module: 'index.tsx', export: 'DuoMenuItem' },
        },
      },
      {
        pluginId: DUO_PLUGIN_ID,
        surface: 'plugin.slot' as const,
        spec: {
          id: 'duo-toolbar-pill',
          target: COMPOSER_TOOLBAR_SLOT,
          order: 10,
          client: { module: 'index.tsx', export: 'DuoToolbarPill' },
        },
      },
    ]
  }

  async function openPlusMenu(container: HTMLElement): Promise<boolean> {
    const trigger = container.querySelector<HTMLButtonElement>('button.composer-plus-trigger')
    if (trigger === null || trigger.disabled) return false
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    return true
  }

  test('duo client module: Fast Refresh exports, duo CSS classes, pure parsers/validators, and zero Emoji copy', { timeout: 60_000 }, () => {
    assert.equal(DUO_PLUGIN_ID, 'builtin:duo')
    assert.equal(DUO_PROFILES_DOC, 'profiles')
    assert.equal(DUO_SESSION_DOC, 'duo')
    assert.equal(DUO_DEFAULT_MAX_STEPS, 30)

    const exportNames = Object.keys(rawDuoModule).filter((k) => k !== '__helmxClientCss').sort()
    assert.deepEqual(exportNames, [
      'DuoMenuItem',
      'DuoProfileSection',
      'DuoToolbarPill',
      'DuoTransitionToolRow',
    ])
    for (const name of exportNames) {
      assert.match(name, /^[A-Z]/)
      assert.equal(typeof rawDuoModule[name], 'function')
    }

    const cssText = rawDuoModule['__helmxClientCss']
    assert.equal(typeof cssText, 'string')
    assert.match(cssText as string, /\.duo-steps-row/)
    assert.match(cssText as string, /\.duo-pill-trigger/)
    assert.match(cssText as string, /\.duo-popover/)
    assert.match(cssText as string, /\.duo-trace-row/)

    for (const [key, entry] of Object.entries(DUO_COPY)) {
      assert.equal(EMOJI_RE.test(entry.en), false, `DUO_COPY.${key}.en must contain zero Emoji`)
      assert.equal(EMOJI_RE.test(entry['zh-CN']), false, `DUO_COPY.${key}['zh-CN'] must contain zero Emoji`)
    }

    assert.equal(isDuoEligibleConversation(undefined), false)
    assert.equal(isDuoEligibleConversation(makeConv(1)), true)
    assert.equal(isDuoEligibleConversation(makeConv(2, { ownedBy: 'helmx' })), false)
    assert.equal(isDuoEligibleConversation(makeConv(3, { parentConversationId: 1 })), false)

    assert.deepEqual(
      parseDuoProfilesDoc({
        profiles: {
          assistant: {
            enabled: true,
            executorModel: 'faux/flagship',
            executorThinkingLevel: 'high',
            maxExecutionSteps: 20,
            updatedAt: 100,
          },
          bad: { enabled: 'yes' },
        },
      }),
      {
        assistant: {
          enabled: true,
          executorModel: 'faux/flagship',
          executorThinkingLevel: 'high',
          maxExecutionSteps: 20,
          updatedAt: 100,
        },
      },
    )

    assert.equal(parseDuoSessionDoc(null), null)
    assert.equal(parseDuoSessionDoc({ enabled: false, plannerModel: 'faux/fast' }), null)
    assert.deepEqual(
      parseDuoSessionDoc({
        enabled: true,
        source: 'profile',
        phase: 'execution',
        plannerModel: 'faux/flagship',
        executorModel: 'faux/workhorse',
        maxExecutionSteps: 15,
        executionStepCount: 4,
        stepLimitPaused: false,
        suppressedByCoordinator: true,
        hasConversationOverride: true,
        profileId: 'assistant',
      }),
      {
        enabled: true,
        source: 'profile',
        phase: 'execution',
        plannerModel: 'faux/flagship',
        executorModel: 'faux/workhorse',
        maxExecutionSteps: 15,
        executionStepCount: 4,
        stepLimitPaused: false,
        suppressedByCoordinator: true,
        hasConversationOverride: true,
        profileId: 'assistant',
      },
    )

    assert.deepEqual(
      parseDuoStandbyMeta({ [DUO_PLUGIN_ID]: { enabled: true, executorModel: 'tier/coder', maxExecutionSteps: 10 } }),
      { enabled: true, executorModel: 'tier/coder', maxExecutionSteps: 10 },
    )
    assert.equal(validateMaxStepsInput(''), 30)
    assert.equal(validateMaxStepsInput('0'), 0)
    assert.equal(validateMaxStepsInput('100'), 100)
    assert.equal(validateMaxStepsInput('101'), null)
    assert.equal(validateMaxStepsInput('abc'), null)

    assert.equal(resolveModelAvailabilityWarning('tier/coder', TEST_MODELS), undefined)
    assert.equal(resolveModelAvailabilityWarning('faux/flagship', TEST_MODELS), undefined)
    assert.equal(resolveModelAvailabilityWarning('faux/disabled', TEST_MODELS), 'disabled')
    assert.equal(resolveModelAvailabilityWarning('faux/missing', TEST_MODELS), 'unavailable')

    assert.deepEqual(
      parseDuoTransitionPresentationMeta({
        tool: DUO_EXIT_PLAN_MODE_TOOL,
        fromModel: 'faux/flagship',
        toModel: 'faux/workhorse',
        fromPhase: 'planning',
        toPhase: 'execution',
        reason: 'Ready',
      }),
      {
        tool: DUO_EXIT_PLAN_MODE_TOOL,
        fromModel: 'faux/flagship',
        toModel: 'faux/workhorse',
        fromPhase: 'planning',
        toPhase: 'execution',
        reason: 'Ready',
      },
    )
    assert.equal(extractFallbackTransitionInfo({ plan: 'First line\nSecond line' }), 'First line')
    assert.equal(extractFirstErrorLine('\nFirst err\nSecond err'), 'First err')
  })

  test('DuoProfileSection: handles isNew hint, switch toggle, validation, tier/model selection, save, and reset', { timeout: 60_000 }, async () => {
    const ctx = makeSpyCtx()

    // 1. isNew=true renders save-first helper and zero switches
    setBuiltinClientStub({ docs: { [DUO_PROFILES_DOC]: { profiles: {} } } })
    const newMount = await mountWithHost(
      e(PluginClientContext.Provider, { value: ctx }, e(DuoProfileSection, { profileId: '', isNew: true, disabled: false })),
    )
    try {
      assert.match(newMount.host.textContent ?? '', /Save this Profile first/)
      assert.equal(newMount.host.querySelectorAll('[role="switch"]').length, 0)
    } finally {
      await newMount.unmount()
    }

    // 2. Existing Profile without saved config -> toggle on -> select executor model -> validate maxExecutionSteps -> Save
    setBuiltinClientStub({ docs: { [DUO_PROFILES_DOC]: { profiles: {} } } })
    const createMount = await mountWithHost(
      e(PluginClientContext.Provider, { value: ctx }, e(DuoProfileSection, { profileId: 'assistant', isNew: false, disabled: false })),
    )
    try {
      assert.match(createMount.host.textContent ?? '', /Off by default/)
      const toggle = createMount.host.querySelector<HTMLButtonElement>('[role="switch"]')
      assert.ok(toggle !== null)
      assert.equal(toggle.getAttribute('aria-checked'), 'false')
      await act(async () => {
        toggle.click()
      })
      assert.equal(toggle.getAttribute('aria-checked'), 'true')
      const saveBtn = findButton(createMount.host, 'Save')
      assert.equal(saveBtn.disabled, true, 'Save stays disabled before selecting an Executor model')

      const pickerBtn = createMount.host.querySelector<HTMLButtonElement>('button[aria-label="Executor model"]')
      assert.ok(pickerBtn !== null)
      await act(async () => {
        pickerBtn.click()
      })
      const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
      assert.ok(popover !== null)
      assert.match(popover.textContent ?? '', /tier\/coder/, 'Duo allows selecting tier/<id> as Executor')

      const flagshipRow = Array.from(popover.querySelectorAll<HTMLElement>('.composer-model-row')).find((row) =>
        (row.querySelector('.composer-model-row-main') as HTMLButtonElement | null)?.title.includes('faux/flagship'),
      )
      assert.ok(flagshipRow !== undefined)
      const highChip = Array.from(flagshipRow.querySelectorAll<HTMLButtonElement>('.composer-model-level-chip')).find(
        (btn) => btn.textContent?.trim() === 'high',
      )
      assert.ok(highChip !== undefined)
      await act(async () => {
        highChip.click()
      })
      assert.equal(saveBtn.disabled, false)

      const stepsInput = createMount.host.querySelector<HTMLInputElement>('input.duo-steps-input')
      assert.ok(stepsInput !== null)
      await act(async () => {
        setInputValue(stepsInput, '150')
      })
      await act(async () => {
        saveBtn.click()
      })
      assert.match(createMount.host.textContent ?? '', /between 0 and 100/)
      assert.equal(ctx.actionCalls.length, 0)

      await act(async () => {
        setInputValue(stepsInput, '45')
      })
      await act(async () => {
        saveBtn.click()
      })
      assert.deepEqual(ctx.actionCalls[0], {
        actionId: 'set_profile',
        input: {
          profileId: 'assistant',
          enabled: true,
          executorModel: 'faux/flagship',
          executorThinkingLevel: 'high',
          maxExecutionSteps: 45,
        },
      })
      assert.deepEqual(ctx.notifications[0], { message: 'Duo defaults saved.', tone: 'info' })
    } finally {
      await createMount.unmount()
    }

    // 3. Saved Profile with unavailable model warning + switch off + Reset clear_profile
    setBuiltinClientStub({
      docs: {
        [DUO_PROFILES_DOC]: {
          profiles: {
            assistant: {
              enabled: true,
              executorModel: 'faux/missing',
              maxExecutionSteps: 20,
              updatedAt: 100,
            },
          },
        },
      },
    })
    const savedMount = await mountWithHost(
      e(PluginClientContext.Provider, { value: ctx }, e(DuoProfileSection, { profileId: 'assistant', isNew: false, disabled: false })),
    )
    try {
      assert.match(savedMount.host.textContent ?? '', /currently unavailable/)
      await act(async () => {
        findButton(savedMount.host, 'Reset').click()
      })
      assert.deepEqual(ctx.actionCalls[1], {
        actionId: 'clear_profile',
        input: { profileId: 'assistant' },
      })
      assert.deepEqual(ctx.notifications[1], { message: 'Duo configuration cleared.', tone: 'info' })

      const toggle = savedMount.host.querySelector<HTMLButtonElement>('[role="switch"]')
      assert.ok(toggle !== null && toggle.getAttribute('aria-checked') === 'true')
      await act(async () => {
        toggle.click()
      })
      assert.deepEqual(ctx.actionCalls[2], {
        actionId: 'set_profile',
        input: {
          profileId: 'assistant',
          enabled: false,
          executorModel: 'faux/missing',
          maxExecutionSteps: 20,
        },
      })
    } finally {
      await savedMount.unmount()
    }
  })

  test('Composer + DuoMenuItem + DuoToolbarPill + DuoSetupDialog: eligibility guard, setup flow, phase pill, popover edits, and disable cleanup', { timeout: 60_000 }, async () => {
    mountSharedPluginNamespaces({ realHooks: true })
    resetPluginClientCache()
    seedPluginClientModule(DUO_PLUGIN_ID, 'index.tsx', rawDuoModule)

    const harness = createSessionDocHarness()
    const actionCalls: Array<{ pluginId: string; actionId: string; input: unknown }> = []
    const onInvokeAction = async (pluginId: string, actionId: string, input: unknown): Promise<unknown> => {
      actionCalls.push({ pluginId, actionId, input })
      return {}
    }

    try {
      // 1. Ineligible conversations (ownedBy: 'helmx' and child conversation) render zero Duo DOM and zero sessionDoc subscriptions
      for (const ineligible of [
        makeConv(1, { ownedBy: 'helmx' }),
        makeConv(2, { parentConversationId: 1 }),
      ]) {
        const ineligibleMount = await mountWithHost(
          e(
            WithSessionDocOverride,
            { harness, onInvokeAction },
            e(Composer, { conversation: ineligible, prefill: null }),
          ),
          {
            conversations: [ineligible],
            plugins: [makeDuoPluginSummary()],
            uiContributions: makeDuoUiContributions(),
            pluginDocs: { [`${DUO_PLUGIN_ID}/${DUO_PROFILES_DOC}`]: { profiles: {} } },
            primaryTarget: { kind: 'conversation', conversationId: ineligible.id },
          },
        )
        try {
          assert.equal(ineligibleMount.host.querySelectorAll('.duo-pill-trigger').length, 0)
          if (await openPlusMenu(ineligibleMount.host)) {
            assert.equal(document.body.querySelectorAll('.duo-menu-item').length, 0)
          }
          assert.equal(harness.subscribedKeys.length, 0, 'ineligible conversation must not subscribe duo sessionDoc')
        } finally {
          await ineligibleMount.unmount()
        }
      }

      // 2. Eligible top-level human conversation: open `+` menu -> DuoSetupDialog -> set_conversation
      const conv = makeConv(10, { profileId: 'assistant', model: 'faux/workhorse', thinkingLevel: 'medium' })
      const store = makeTestStore({
        conversations: [conv],
        models: TEST_MODELS,
        modelDefaults: { modelTiers: TEST_TIERS },
        plugins: [makeDuoPluginSummary()],
        uiContributions: makeDuoUiContributions(),
        pluginDocs: {
          [`${DUO_PLUGIN_ID}/${DUO_PROFILES_DOC}`]: { profiles: {} },
        },
        primaryTarget: { kind: 'conversation', conversationId: conv.id },
      })
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      const renderComposer = async (nextConv = conv): Promise<void> => {
        await act(async () => {
          root.render(
            e(
              HostStoreProviders,
              { value: store },
              e(
                WithSessionDocOverride,
                { harness, onInvokeAction },
                e(Composer, { conversation: nextConv, prefill: null }),
              ),
            ),
          )
        })
      }

      try {
        await renderComposer()
        assert.ok(host.querySelector('.duo-pill-trigger') === null, 'inactive conversation renders no Duo pill')

        await openPlusMenu(host)
        const menuItem = document.body.querySelector<HTMLElement>('.composer-plus-menu .duo-menu-item')
        assert.ok(menuItem !== null, 'expected DuoMenuItem inside + menu')
        assert.equal(menuItem.getAttribute('data-duo-enabled'), 'false')
        await act(async () => {
          menuItem.click()
        })
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
        })

        const setupDialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
        assert.ok(setupDialog !== null, 'clicking DuoMenuItem without preset executor opens DuoSetupDialog')
        assert.match(setupDialog.textContent ?? '', /Enable Duo Mode/)
        const enableBtn = findButton(setupDialog, 'Enable Duo')
        assert.equal(enableBtn.disabled, true)

        const setupPickerBtn = setupDialog.querySelector<HTMLButtonElement>('button[aria-label="Executor model"]')
        assert.ok(setupPickerBtn !== null)
        await act(async () => {
          setupPickerBtn.click()
        })
        const flagshipRow = Array.from(document.body.querySelectorAll<HTMLElement>('.composer-model-row')).find((row) =>
          (row.querySelector('.composer-model-row-main') as HTMLButtonElement | null)?.title.includes('faux/flagship'),
        )
        assert.ok(flagshipRow !== undefined)
        const highChip = Array.from(flagshipRow.querySelectorAll<HTMLButtonElement>('.composer-model-level-chip')).find(
          (btn) => btn.textContent?.trim() === 'high',
        )
        assert.ok(highChip !== undefined)
        await act(async () => {
          highChip.click()
        })
        assert.equal(enableBtn.disabled, false)

        const stepsInput = setupDialog.querySelector<HTMLInputElement>('input.duo-steps-input')
        assert.ok(stepsInput !== null)
        await act(async () => {
          setInputValue(stepsInput, '25')
        })
        await act(async () => {
          enableBtn.click()
        })
        assert.deepEqual(actionCalls[0], {
          pluginId: DUO_PLUGIN_ID,
          actionId: 'set_conversation',
          input: {
            conversationId: 10,
            enabled: true,
            executorModel: 'faux/flagship',
            executorThinkingLevel: 'high',
            maxExecutionSteps: 25,
          },
        })
        assert.ok(document.body.querySelector('[role="dialog"]') === null, 'DuoSetupDialog closes after confirm')

        // 3. Push Planning phase -> Execution phase -> Coordinator suppression via sessionDoc
        await act(async () => {
          harness.setDuoDoc(10, {
            enabled: true,
            source: 'conversation',
            phase: 'planning',
            plannerModel: 'faux/workhorse',
            plannerThinkingLevel: 'medium',
            executorModel: 'faux/flagship',
            executorThinkingLevel: 'high',
            maxExecutionSteps: 25,
            executionStepCount: 0,
            stepLimitPaused: false,
            hasConversationOverride: true,
          })
        })
        const planPill = host.querySelector<HTMLButtonElement>('button.duo-pill-trigger')
        assert.ok(planPill !== null)
        assert.equal(planPill.getAttribute('data-duo-phase'), 'planning')
        assert.equal(planPill.getAttribute('data-duo-suppressed'), 'false')
        assert.match(planPill.textContent ?? '', /Plan/)
        assert.match(planPill.textContent ?? '', /workhorse → flagship/)

        // Update store pluginDocs so profile also has Duo enabled (enabling "Revert to Profile default" button)
        await act(async () => {
          store.updateLive((prev) => ({
            ...prev,
            pluginDocs: {
              ...prev.pluginDocs,
              [`${DUO_PLUGIN_ID}/${DUO_PROFILES_DOC}`]: {
                profiles: {
                  assistant: {
                    enabled: true,
                    executorModel: 'faux/fast',
                    maxExecutionSteps: 25,
                    updatedAt: 1,
                  },
                },
              },
            },
          }))
          harness.setDuoDoc(10, {
            enabled: true,
            source: 'conversation',
            phase: 'execution',
            plannerModel: 'faux/workhorse',
            plannerThinkingLevel: 'medium',
            executorModel: 'faux/flagship',
            executorThinkingLevel: 'high',
            maxExecutionSteps: 25,
            executionStepCount: 3,
            stepLimitPaused: false,
            hasConversationOverride: true,
            profileId: 'assistant',
          })
        })
        const execPill = host.querySelector<HTMLButtonElement>('button.duo-pill-trigger')
        assert.ok(execPill !== null)
        assert.equal(execPill.getAttribute('data-duo-phase'), 'execution')
        assert.equal(execPill.classList.contains('helmx-toolbar-pill--accent'), true)
        assert.match(execPill.textContent ?? '', /Exec 3\/25/)

        // Open Popover -> change Executor to tier/coder -> revert to profile -> disable
        await act(async () => {
          execPill.click()
        })
        const popover = document.body.querySelector<HTMLElement>('.duo-popover')
        assert.ok(popover !== null)
        assert.match(popover.textContent ?? '', /Execution Phase/)
        assert.match(popover.textContent ?? '', /3 \/ 25/)

        const execPickerBtn = popover.querySelector<HTMLButtonElement>('button[aria-label="Executor model"]')
        assert.ok(execPickerBtn !== null)
        await act(async () => {
          execPickerBtn.click()
        })
        const coderTierBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.composer-model-row-main')).find((b) =>
          (b.textContent ?? '').includes('tier/coder'),
        )
        assert.ok(coderTierBtn !== undefined)
        await act(async () => {
          coderTierBtn.click()
        })
        assert.deepEqual(actionCalls[1], {
          pluginId: DUO_PLUGIN_ID,
          actionId: 'set_conversation',
          input: {
            conversationId: 10,
            enabled: true,
            executorModel: 'tier/coder',
            maxExecutionSteps: 25,
          },
        })

        await act(async () => {
          findButton(popover, 'Revert to Profile default').click()
        })
        assert.deepEqual(actionCalls[2], {
          pluginId: DUO_PLUGIN_ID,
          actionId: 'clear_conversation',
          input: { conversationId: 10 },
        })

        await act(async () => {
          execPill.click()
        })
        const popover2 = document.body.querySelector<HTMLElement>('.duo-popover')
        assert.ok(popover2 !== null)
        await act(async () => {
          findButton(popover2, 'Turn off Duo for this chat').click()
        })
        assert.deepEqual(actionCalls[3], {
          pluginId: DUO_PLUGIN_ID,
          actionId: 'set_conversation',
          input: { conversationId: 10, enabled: false },
        })

        // 4. Coordinator suppressed session renders Coordinator badge and pill state
        await act(async () => {
          harness.setDuoDoc(10, {
            enabled: true,
            source: 'profile',
            phase: 'planning',
            plannerModel: 'faux/workhorse',
            executorModel: 'faux/fast',
            maxExecutionSteps: 25,
            executionStepCount: 0,
            stepLimitPaused: false,
            suppressedByCoordinator: true,
            hasConversationOverride: false,
            profileId: 'assistant',
          })
        })
        const coordPill = host.querySelector<HTMLButtonElement>('button.duo-pill-trigger')
        assert.ok(coordPill !== null)
        assert.equal(coordPill.getAttribute('data-duo-suppressed'), 'true')
        assert.match(coordPill.textContent ?? '', /Coordinator/)
        assert.equal(EMOJI_RE.test(coordPill.textContent ?? ''), false)

        // 5. Plugin disable removes toolbar pill immediately
        await act(async () => {
          store.updateLive((prev) => ({
            ...prev,
            plugins: [],
            uiContributions: [],
            pluginDocs: {},
          }))
        })
        assert.ok(host.querySelector('.duo-pill-trigger') === null, 'disabling builtin:duo removes pill')
      } finally {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      }
    } finally {
      resetPluginClientCache()
      mountSharedPluginNamespaces({ realHooks: false })
    }
  })

  test('AgentStandbyPane + Duo standby draftMeta: setup flow, profile inheritance, and non-dirty drafts', { timeout: 60_000 }, async () => {
    mountSharedPluginNamespaces({ realHooks: true })
    resetPluginClientCache()
    seedPluginClientModule(DUO_PLUGIN_ID, 'index.tsx', rawDuoModule)
    resetStandbyDrafts()

    try {
      const store = makeTestStore({
        profiles: [
          {
            id: 'assistant',
            name: 'Assistant',
            model: 'faux/workhorse',
            thinkingLevel: 'medium',
            cwd: '/repo',
            nodeId: 'local',
          },
        ],
        models: TEST_MODELS,
        modelDefaults: { modelTiers: TEST_TIERS },
        plugins: [makeDuoPluginSummary()],
        uiContributions: makeDuoUiContributions(),
        pluginDocs: { [`${DUO_PLUGIN_ID}/${DUO_PROFILES_DOC}`]: { profiles: {} } },
      })
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)

      try {
        await act(async () => {
          root.render(e(HostStoreProviders, { value: store }, e(AgentStandbyPane, { profileId: 'assistant' })))
        })
        assert.ok(host.querySelector('.duo-pill-trigger') === null)
        assert.equal(standbyDraftsDirty(), false)

        // Open `+` menu -> click Duo Mode -> DuoSetupDialog -> updates draftMeta without dirtying draft text
        await openPlusMenu(host)
        const menuItem = document.body.querySelector<HTMLElement>('.composer-plus-menu .duo-menu-item')
        assert.ok(menuItem !== null)
        await act(async () => {
          menuItem.click()
        })
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
        })
        const setupDialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
        assert.ok(setupDialog !== null)
        await act(async () => {
          setupDialog.querySelector<HTMLButtonElement>('button[aria-label="Executor model"]')!.click()
        })
        const flagshipMain = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.composer-model-row-main')).find((b) =>
          b.title.includes('faux/flagship'),
        )
        assert.ok(flagshipMain !== undefined)
        await act(async () => {
          flagshipMain.click()
        })
        await act(async () => {
          findButton(setupDialog, 'Enable Duo').click()
        })

        const pill = host.querySelector<HTMLButtonElement>('.composer-toolbar-left button.duo-pill-trigger')
        assert.ok(pill !== null, 'standby DuoToolbarPill renders in .composer-toolbar-left')
        assert.match(pill.textContent ?? '', /workhorse → flagship/)
        assert.equal(standbyDraftsDirty(), false, 'arming Duo draftMeta must not mark standby text draft dirty')

        // Open standby pill popover -> disable -> pill disappears
        await act(async () => {
          pill.click()
        })
        const popover = document.body.querySelector<HTMLElement>('.duo-popover')
        assert.ok(popover !== null)
        await act(async () => {
          findButton(popover, 'Turn off Duo for this chat').click()
        })
        assert.ok(host.querySelector('.duo-pill-trigger') === null)

        // Enable Profile default -> standby inherits immediately and `+` menu toggles enabled=false override
        await act(async () => {
          store.updateLive((prev) => ({
            ...prev,
            pluginDocs: {
              ...prev.pluginDocs,
              [`${DUO_PLUGIN_ID}/${DUO_PROFILES_DOC}`]: {
                profiles: {
                  assistant: {
                    enabled: true,
                    executorModel: 'tier/coder',
                    maxExecutionSteps: 30,
                    updatedAt: 2,
                  },
                },
              },
            },
          }))
        })
        const inheritedPill = host.querySelector<HTMLButtonElement>('button.duo-pill-trigger')
        assert.ok(inheritedPill !== null)
        assert.match(inheritedPill.textContent ?? '', /workhorse → tier\/coder/)

        await openPlusMenu(host)
        const activeMenuItem = document.body.querySelector<HTMLElement>('.composer-plus-menu .duo-menu-item')
        assert.ok(activeMenuItem !== null && activeMenuItem.getAttribute('data-duo-enabled') === 'true')
        await act(async () => {
          activeMenuItem.click()
        })
        assert.ok(host.querySelector('.duo-pill-trigger') === null, 'standby menu toggle suppresses profile default cleanly')
      } finally {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      }
    } finally {
      resetPluginClientCache()
      mountSharedPluginNamespaces({ realHooks: false })
    }
  })

  test('DuoTransitionToolRow: renders exit_plan_mode, hand_back_to_planner, running state, and plain error fallback', { timeout: 60_000 }, async () => {
    const ctx = makeSpyCtx()

    // 1. exit_plan_mode completed with presentationMeta
    const exitMount = await mountWithHost(
      e(
        PluginClientContext.Provider,
        { value: ctx },
        e(DuoTransitionToolRow, {
          conversationId: 10,
          callId: 'c1',
          toolName: DUO_EXIT_PLAN_MODE_TOOL,
          status: 'done',
          durationMs: 42,
          input: { plan: 'Implement changes' },
          presentationMeta: {
            tool: DUO_EXIT_PLAN_MODE_TOOL,
            fromModel: 'faux/flagship',
            toModel: 'faux/workhorse',
            fromPhase: 'planning',
            toPhase: 'execution',
          },
        }),
      ),
    )
    try {
      const row = exitMount.host.querySelector<HTMLElement>('.duo-trace-row')
      assert.ok(row !== null)
      assert.equal(row.getAttribute('data-duo-transition'), DUO_EXIT_PLAN_MODE_TOOL)
      const text = row.textContent ?? ''
      assert.match(text, /Enter execution phase/)
      assert.match(text, /Switched to executor workhorse/)
      assert.match(text, /Executor/)
      assert.match(text, /Switched/)
      assert.equal(EMOJI_RE.test(text), false)
    } finally {
      await exitMount.unmount()
    }

    // 2. hand_back_to_planner completed with reason
    const handBackMount = await mountWithHost(
      e(
        PluginClientContext.Provider,
        { value: ctx },
        e(DuoTransitionToolRow, {
          conversationId: 10,
          callId: 'c2',
          toolName: DUO_HAND_BACK_TOOL,
          status: 'done',
          input: { reason: 'Needs schema change', summary: 'Blocked on API' },
          presentationMeta: {
            tool: DUO_HAND_BACK_TOOL,
            fromModel: 'faux/workhorse',
            toModel: 'faux/flagship',
            fromPhase: 'execution',
            toPhase: 'planning',
            reason: 'Needs schema change',
          },
        }),
      ),
    )
    try {
      const text = handBackMount.host.textContent ?? ''
      assert.match(text, /Hand back to planner/)
      assert.match(text, /Returned to planner flagship · Needs schema change/)
      assert.match(text, /Planner/)
    } finally {
      await handBackMount.unmount()
    }

    // 3. Running state falls back to input preview without presentationMeta
    const runningMount = await mountWithHost(
      e(
        PluginClientContext.Provider,
        { value: ctx },
        e(DuoTransitionToolRow, {
          conversationId: 10,
          callId: 'c3',
          toolName: DUO_EXIT_PLAN_MODE_TOOL,
          status: 'running',
          input: { plan: 'Step 1: inspect files\nStep 2: edit code' },
        }),
      ),
    )
    try {
      assert.ok(runningMount.host.querySelector('.spin-slow') !== null)
      const text = runningMount.host.textContent ?? ''
      assert.match(text, /Step 1: inspect files/)
      assert.match(text, /Switching/)
    } finally {
      await runningMount.unmount()
    }

    // 4. Error state uses first raw line without invoking JSON.parse
    const errorMount = await mountWithHost(
      e(
        PluginClientContext.Provider,
        { value: ctx },
        e(DuoTransitionToolRow, {
          conversationId: 10,
          callId: 'c4',
          toolName: DUO_EXIT_PLAN_MODE_TOOL,
          status: 'error',
          isError: true,
          input: { plan: 'Fallback plan' },
          result: 'Model faux/disabled is disabled\n{"malformed_json":',
        }),
      ),
    )
    try {
      const row = errorMount.host.querySelector('.duo-trace-row.trace-row-error')
      assert.ok(row !== null)
      assert.ok(row.querySelector('.duo-trace-error') !== null)
      const text = row.textContent ?? ''
      assert.match(text, /Model faux\/disabled is disabled/)
      assert.match(text, /Failed/)
    } finally {
      await errorMount.unmount()
    }
  })
})
