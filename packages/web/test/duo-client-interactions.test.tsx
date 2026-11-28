/**
 * builtin:duo Dual-Phase Recipe UI interactive DOM tests (compiled TSX via @helmx/plugin-build):
 * - Modular Fast Refresh exports (`index.tsx`, `manager.tsx`, `settings.tsx`), zero Emoji, CSS hygiene;
 * - Unified ModelPicker: Dual-phase recipes grouped under "Dual-phase recipes", filtered out
 *   of "Next turn only" (`singleTurnEligible: false`) and when `allowPreserveRefTiers={false}`;
 * - `DuoManagerScreen` + `DuoDetailDrawer`: empty starter preset cards, create drawer + `set`,
 *   search filter, edit drawer, `remove` + `409` force-delete double-confirm;
 * - `DuoSettingsPanel`: recipe summary + `openScreen` trigger;
 * - `DuoToolbarPill` (active & standby): phase pill + step counter, popover Planner/Executor,
 *   interactive Executor `ModelPickerControl` calling `override_executor`, `Reset override` calling
 *   `clear_override`, coordinator posture, ineligible sub-conversation guard, live disable cleanup;
 * - `DuoTransitionToolRow`: `exit_plan_mode`, `hand_back_to_planner`, running & raw error fallback.
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { afterEach, before, describe, test } from 'node:test'
import type {
  ConversationSummary,
  HookName,
  ModelTierCatalogEntry,
  PluginClientContext as PluginClientContextType,
  PluginSummary,
} from '@helmx/protocol'
import { COMPOSER_TOOLBAR_SLOT } from '@helmx/protocol'
import type {
  PluginClientHostPort,
  PluginSessionDocKey,
  PluginSessionDocState,
} from '@helmx/plugin-client'

const { ensureHappyDom, resetHappyDom } = await import('./helpers/dom-harness.js')
ensureHappyDom()

const React = await import('react')
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { resolveLocalizedText } = await import('@helmx/ui')
const {
  PluginClientContext,
  PluginClientHostContext,
} = await import('@helmx/plugin-client')
const {
  DUO_DEFAULT_MAX_STEPS,
  DUO_EXIT_PLAN_MODE_TOOL,
  DUO_HAND_BACK_TOOL,
  DUO_PLUGIN_ID,
  DUO_SCREEN_ID,
  DUO_SESSION_DOC,
  DUO_STATE_DOC,
  createEmptyDuoDraft,
  getStarterDuoPresets,
  parseDuoSessionDoc,
  parseDuoStateDoc,
  validateDuoDraft,
} = await import('../../plugins/src/duo/client/models.ts')
const { Composer } = await import('../src/conversation/Composer.js')
const { AgentStandbyPane } = await import('../src/conversation/AgentStandbyPane.js')
const { ModelPicker } = await import('../src/conversation/ModelPicker.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const {
  importBuiltinClientModule,
  mountSharedPluginNamespaces,
  setBuiltinClientStub,
} = await import('./helpers/builtin-clients.js')
const { makeTestStore } = await import('./helpers/store.js')
const {
  resetPluginClientCache,
  seedPluginClientModule,
} = await import('../src/lib/plugin-client.js')

const e = React.createElement
const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u

let rawIndexModule: Record<string, unknown>
let rawManagerModule: Record<string, unknown>
let rawSettingsModule: Record<string, unknown>
let DuoToolbarPill: (props: Record<string, unknown>) => React.ReactElement | null
let DuoTransitionToolRow: (props: Record<string, unknown>) => React.ReactElement
let DuoManagerScreen: (props: Record<string, unknown>) => React.ReactElement
let DuoSettingsPanel: () => React.ReactElement

describe('duo-client-interactions', () => {
  before(async () => {
    mountSharedPluginNamespaces()
    rawIndexModule = await importBuiltinClientModule(DUO_PLUGIN_ID, 'index.tsx')
    rawManagerModule = await importBuiltinClientModule(DUO_PLUGIN_ID, 'manager.tsx')
    rawSettingsModule = await importBuiltinClientModule(DUO_PLUGIN_ID, 'settings.tsx')
    DuoToolbarPill = rawIndexModule['DuoToolbarPill'] as (props: Record<string, unknown>) => React.ReactElement | null
    DuoTransitionToolRow = rawIndexModule['DuoTransitionToolRow'] as (props: Record<string, unknown>) => React.ReactElement
    DuoManagerScreen = rawManagerModule['DuoManagerScreen'] as (props: Record<string, unknown>) => React.ReactElement
    DuoSettingsPanel = rawSettingsModule['DuoSettingsPanel'] as () => React.ReactElement
  }, { timeout: 60_000 })

  afterEach(() => {
    setBuiltinClientStub()
    mountSharedPluginNamespaces({ realHooks: false })
    resetPluginClientCache()
    resetHappyDom()
  }, { timeout: 60_000 })

  const TEST_MODELS = [
    { id: 'faux/flagship', provider: 'faux', modelId: 'flagship', available: true, thinkingLevels: ['off', 'high', 'xhigh'] },
    { id: 'faux/workhorse', provider: 'faux', modelId: 'workhorse', available: true, thinkingLevels: ['off', 'medium', 'high'] },
    { id: 'faux/fast', provider: 'faux', modelId: 'fast', available: true, thinkingLevels: ['off', 'low'] },
  ]

  const TEST_TIERS: ModelTierCatalogEntry[] = [
    {
      id: 'architect',
      model: 'faux/flagship',
      thinkingLevel: 'xhigh',
      description: 'System planning',
      available: true,
      thinkingLevels: ['off', 'high', 'xhigh'],
    },
    {
      id: 'coder',
      model: 'faux/workhorse',
      thinkingLevel: 'high',
      description: 'Implementation workhorse',
      available: true,
      thinkingLevels: ['off', 'medium', 'high'],
    },
    {
      id: 'arch_coder',
      model: 'faux/flagship',
      thinkingLevel: 'xhigh',
      description: 'Architect paired with Coder',
      available: true,
      thinkingLevels: ['off', 'high', 'xhigh'],
      displayGroup: 'duo',
      displayLabel: 'Architect -> Coder',
      displayDetail: 'flagship → workhorse',
      preserveRef: true,
      singleTurnEligible: false,
    },
  ]

  interface SpyCtx extends PluginClientContextType {
    actionCalls: Array<{ actionId: string; input: unknown }>
    openedScreens: string[]
    notifications: Array<{ message: string; tone: string }>
  }

  function makeSpyCtx(options: {
    locale?: 'en' | 'zh-CN'
    onAction?: (actionId: string, input: unknown) => Promise<unknown>
  } = {}): SpyCtx {
    const locale = options.locale ?? 'en'
    const actionCalls: Array<{ actionId: string; input: unknown }> = []
    const openedScreens: string[] = []
    const notifications: Array<{ message: string; tone: string }> = []
    const base: PluginClientContextType = {
      pluginId: DUO_PLUGIN_ID,
      callAction: async (actionId, input) => {
        actionCalls.push({ actionId, input })
        if (options.onAction) return options.onAction(actionId, input)
        return {}
      },
      fetchRoute: async () => new Response('{}'),
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

  function createDocAndSessionHarness(initialStateDoc: unknown = { recipes: {} }) {
    const listeners = new Set<() => void>()
    const states = new Map<string, PluginSessionDocState>()
    const stateDocKey = `${DUO_PLUGIN_ID}/${DUO_STATE_DOC}`
    const EMPTY: PluginSessionDocState = { hasValue: false, deleted: false, connected: true }
    let stateDocVal = initialStateDoc

    const keyStr = (k: PluginSessionDocKey): string => `${k.pluginId}/${k.docName}/${k.conversationId}`

    return {
      subscribedKeys: new Set<string>(),
      setStateDoc(next: unknown) {
        stateDocVal = next
        for (const fn of [...listeners]) fn()
      },
      setDuoDoc(conversationId: number, value: unknown) {
        const key = `${DUO_PLUGIN_ID}/${DUO_SESSION_DOC}/${conversationId}`
        states.set(
          key,
          value === null
            ? { value: undefined, hasValue: false, deleted: true, connected: true }
            : { value, hasValue: true, deleted: false, connected: true },
        )
        for (const fn of [...listeners]) fn()
      },
      getPluginDocValue: (docKey: string) => (docKey === stateDocKey ? stateDocVal : undefined),
      hasPluginDoc: (docKey: string) => docKey === stateDocKey,
      subscribePluginDoc: (_docKey: string, listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      subscribeSessionDoc(key: PluginSessionDocKey, listener: () => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      getSessionDocState: (key: PluginSessionDocKey): PluginSessionDocState =>
        states.get(keyStr(key)) ?? EMPTY,
      retrySessionDoc: () => {},
    }
  }

  function WithHostOverrides({
    harness,
    onInvokeAction,
    onOpenTarget,
    children,
  }: {
    harness: ReturnType<typeof createDocAndSessionHarness>
    onInvokeAction?: (pluginId: string, actionId: string, input: unknown) => Promise<unknown>
    onOpenTarget?: (target: string) => void
    children?: React.ReactNode
  }): React.ReactElement {
    const basePort = React.useContext(PluginClientHostContext)
    assert.ok(basePort !== null, 'expected PluginClientHostContext from HostStoreProviders')
    const port = React.useMemo<PluginClientHostPort>(
      () => ({
        ...basePort,
        getPluginDocValue: harness.getPluginDocValue,
        hasPluginDoc: harness.hasPluginDoc,
        subscribePluginDoc: harness.subscribePluginDoc,
        subscribeSessionDoc: (key, listener) => {
          harness.subscribedKeys.add(`${key.pluginId}/${key.docName}/${key.conversationId}`)
          return harness.subscribeSessionDoc(key, listener)
        },
        getSessionDocState: harness.getSessionDocState,
        retrySessionDoc: harness.retrySessionDoc,
        ...(onInvokeAction ? { invokePluginAction: onInvokeAction } : {}),
        ...(onOpenTarget ? { openTarget: onOpenTarget } : {}),
      }),
      [basePort, harness, onInvokeAction, onOpenTarget],
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

  function makeConversation(overrides: Partial<ConversationSummary> & { id: number }): ConversationSummary {
    return {
      title: `Conversation #${overrides.id}`,
      profileId: 'assistant',
      tags: [],
      nodeId: 'local',
      cwd: '/repo',
      model: 'faux/flagship',
      thinkingLevel: '',
      status: 'idle',
      ownedBy: 'human',
      stateChangeSeq: 0,
      completionSeq: 0,
      unread: false,
      pinned: false,
      pendingAskCount: 0,
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    }
  }

  function makeDuoPluginSummary(): PluginSummary {
    const hooks: HookName[] = ['input', 'before_turn', 'agent_spawn', 'turn_settled']
    return {
      id: DUO_PLUGIN_ID,
      name: 'Dual-Phase Orchestration',
      version: '0.2.0',
      locked: false,
      enabled: true,
      status: 'active',
      hooks,
      actions: [],
      tools: [DUO_EXIT_PLAN_MODE_TOOL, DUO_HAND_BACK_TOOL],
      clientHashes: {
        'index.tsx': 'seeded',
        'manager.tsx': 'seeded',
        'settings.tsx': 'seeded',
      },
    }
  }

  function makeDuoUiContributions() {
    return [
      {
        pluginId: DUO_PLUGIN_ID,
        surface: 'plugin.slot' as const,
        spec: {
          id: 'duo-toolbar-pill',
          target: COMPOSER_TOOLBAR_SLOT,
          order: 40,
          client: { module: 'index.tsx', export: 'DuoToolbarPill' },
        },
      },
    ]
  }

  test('modular Fast Refresh exports, duo CSS hygiene, pure helpers, and zero Emoji', { timeout: 60_000 }, () => {
    assert.equal(DUO_PLUGIN_ID, 'builtin:duo')
    assert.equal(DUO_STATE_DOC, 'state')
    assert.equal(DUO_SESSION_DOC, 'duo')
    assert.equal(DUO_DEFAULT_MAX_STEPS, 30)

    const indexExports = Object.keys(rawIndexModule).filter((k) => k !== '__helmxClientCss').sort()
    assert.deepEqual(indexExports, ['DuoToolbarPill', 'DuoTransitionToolRow'])

    const managerExports = Object.keys(rawManagerModule).filter((k) => k !== '__helmxClientCss').sort()
    assert.deepEqual(managerExports, ['DuoManagerScreen'])

    const settingsExports = Object.keys(rawSettingsModule).filter((k) => k !== '__helmxClientCss').sort()
    assert.deepEqual(settingsExports, ['DuoSettingsPanel'])

    const cssText = String(rawIndexModule['__helmxClientCss'] ?? '')
    assert.match(cssText, /\.duo-pill/)
    assert.match(cssText, /@media\s*\(hover:\s*hover\)/)

    const parsed = parseDuoStateDoc({
      recipes: {
        arch_coder: {
          id: 'arch_coder',
          name: 'Architect -> Coder',
          plannerModel: 'tier/architect',
          executorModel: 'tier/coder',
          maxExecutionSteps: 30,
          updatedAt: 1,
        },
      },
    })
    assert.ok(parsed.recipes['arch_coder'])
    assert.equal(parseDuoSessionDoc({ enabled: false }), null)
    const empty = createEmptyDuoDraft()
    assert.equal(
      validateDuoDraft(
        { ...empty, id: 'coder', name: 'Bad', plannerModel: 'faux/flagship', executorModel: 'faux/fast' },
        { mode: 'create', existingRecipeIds: new Set(), externalTierIds: new Set(['coder']) },
      ),
      'id_conflict',
    )
    const starters = getStarterDuoPresets('en', {
      models: TEST_MODELS,
      modelTiers: TEST_TIERS,
      modelThinkingLevels: {},
    })
    assert.equal(starters[0]!.plannerModel, 'tier/architect')
    assert.equal(starters[0]!.executorModel, 'tier/coder')
    assert.equal(EMOJI_RE.test(JSON.stringify(starters)), false)
  })

  test('Unified ModelPicker renders Duo recipes under Dual-phase recipes, hides on Next-turn tab and allowPreserveRefTiers=false', { timeout: 60_000 }, async () => {
    const pickerMount = await mountWithHost(
      e(ModelPicker, {
        conversation: makeConversation({
          id: 1,
          model: 'faux/flagship',
          modelOverride: 'tier/arch_coder',
          effectiveModelRef: 'tier/arch_coder',
        }),
        nextTurnMode: { onChange: () => {} },
      }),
    )
    try {
      const trigger = pickerMount.host.querySelector<HTMLButtonElement>('button.composer-model-button')
      assert.ok(trigger !== null)
      await act(async () => {
        trigger.click()
      })
      const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
      assert.ok(popover !== null)
      assert.match(popover.textContent ?? '', /Dual-phase recipes/)
      assert.match(popover.textContent ?? '', /Architect -> Coder/)
      assert.match(popover.textContent ?? '', /flagship → workhorse/)

      // Switching to "Next turn only" hides singleTurnEligible=false Duo recipes
      const nextTurnTab = findButton(popover, 'Next turn only')
      await act(async () => {
        nextTurnTab.click()
      })
      assert.equal((popover.textContent ?? '').includes('Architect -> Coder'), false)
    } finally {
      await pickerMount.unmount()
    }
  })

  test('DuoManagerScreen + DuoDetailDrawer: starter preset creation, card list/search, edit save, and 409 force-delete', { timeout: 60_000 }, async () => {
    const ctx = makeSpyCtx()

    // 1. Empty state -> starter cards -> click "Use template" opens drawer prefilled -> Create invokes 'set'
    setBuiltinClientStub({ docs: { state: { recipes: {} } } })
    const emptyMount = await mountWithHost(
      e(
        PluginClientContext.Provider,
        { value: ctx },
        e(DuoManagerScreen, { inlineDrawer: true }),
      ),
    )
    try {
      const text = emptyMount.host.textContent ?? ''
      assert.match(text, /No Duo recipes yet/)
      assert.match(text, /Starter recipes/)
      assert.match(text, /Architect -> Coder/)

      await act(async () => {
        findButton(emptyMount.host, 'Use template').click()
      })
      const idInput = emptyMount.host.querySelector<HTMLInputElement>('#duo-recipe-id')
      assert.ok(idInput !== null)
      assert.equal(idInput.value, 'duo_architect')

      await act(async () => {
        findButton(emptyMount.host, 'Create recipe').click()
      })
      const setCall = ctx.actionCalls.find((c) => c.actionId === 'set')
      assert.ok(setCall !== undefined)
      assert.deepEqual(setCall.input, {
        id: 'duo_architect',
        name: 'Architect -> Coder',
        plannerModel: 'tier/architect',
        executorModel: 'tier/coder',
        maxExecutionSteps: 30,
        plannerThinkingLevel: '',
        executorThinkingLevel: '',
        description: 'Explore read-only with a flagship planner, then hand execution edits and checks to your coder.',
      })
    } finally {
      await emptyMount.unmount()
    }

    // 2. Populated state: pairing cards, search, edit drawer save, delete -> 409 -> Force delete
    setBuiltinClientStub({
      docs: {
        state: {
          recipes: {
            arch_coder: {
              id: 'arch_coder',
              name: 'Architect -> Coder',
              description: 'Main dual-phase pairing',
              plannerModel: 'tier/architect',
              executorModel: 'tier/coder',
              maxExecutionSteps: 25,
              updatedAt: 10,
            },
            broken_pair: {
              id: 'broken_pair',
              name: 'Broken Pair',
              plannerModel: 'tier/missing_ext',
              executorModel: 'faux/fast',
              maxExecutionSteps: 10,
              updatedAt: 9,
            },
          },
        },
      },
    })
    const populatedCtx = makeSpyCtx({
      onAction: async (actionId, input) => {
        if (actionId === 'remove' && !(input as { force?: boolean }).force) {
          throw Object.assign(new Error('Recipe tier/arch_coder is in use by Profile assistant'), {
            status: 409,
            code: 'model_tier_in_use',
          })
        }
        return {}
      },
    })
    const fullMount = await mountWithHost(
      e(
        PluginClientContext.Provider,
        { value: populatedCtx },
        e(DuoManagerScreen, { inlineDrawer: true }),
      ),
    )
    try {
      const fullText = fullMount.host.textContent ?? ''
      assert.match(fullText, /Architect -> Coder/)
      assert.match(fullText, /tier\/arch_coder/)
      assert.match(fullText, /tier\/missing_ext/)

      // Filter via SearchBox
      const searchInput = fullMount.host.querySelector<HTMLInputElement>('input[aria-label="Search Duo recipes"]')
      assert.ok(searchInput !== null)
      await act(async () => {
        setInputValue(searchInput, 'Broken')
      })
      assert.equal(fullMount.host.querySelectorAll('[data-duo-recipe-id]').length, 1)
      await act(async () => {
        setInputValue(searchInput, '')
      })
      assert.equal(fullMount.host.querySelectorAll('[data-duo-recipe-id]').length, 2)

      // Open edit drawer on arch_coder card -> change name -> Save changes
      const cardTrigger = fullMount.host.querySelector<HTMLButtonElement>(
        '[data-duo-recipe-id="arch_coder"] button.helmx-select-card-trigger',
      )
      assert.ok(cardTrigger !== null)
      await act(async () => {
        cardTrigger.click()
      })
      const nameInput = fullMount.host.querySelector<HTMLInputElement>('#duo-recipe-name')
      const idField = fullMount.host.querySelector<HTMLInputElement>('#duo-recipe-id')
      assert.ok(nameInput !== null && idField !== null)
      assert.equal(idField.disabled, true, 'recipe id is locked during edit')
      await act(async () => {
        setInputValue(nameInput, 'Arch -> Coder v2')
      })
      await act(async () => {
        findButton(fullMount.host, 'Save changes').click()
      })
      const updateCall = populatedCtx.actionCalls.find((c) => c.actionId === 'set')
      assert.equal((updateCall?.input as { name?: string })?.name, 'Arch -> Coder v2')

      // Delete triggers 409 -> Force delete confirm dialog
      const deleteBtn = fullMount.host.querySelector<HTMLButtonElement>(
        '[data-duo-recipe-id="arch_coder"] .duo-card-footer-actions button:last-child',
      )
      assert.ok(deleteBtn !== null)
      await act(async () => {
        deleteBtn.click()
      })
      const firstAlert = document.body.querySelector('[role="alertdialog"]')
      assert.ok(firstAlert !== null, 'first ConfirmDialog should open')
      await act(async () => {
        findButton(firstAlert, 'Delete').click()
      })
      const secondAlert = document.body.querySelector('[role="alertdialog"]')
      assert.ok(secondAlert !== null, 'second force-delete ConfirmDialog should open after 409')
      await act(async () => {
        findButton(secondAlert, 'Force delete').click()
      })
      const removeCalls = populatedCtx.actionCalls.filter((c) => c.actionId === 'remove')
      assert.equal(removeCalls.length, 2)
      assert.deepEqual(removeCalls[1]!.input, { id: 'arch_coder', force: true })
    } finally {
      await fullMount.unmount()
    }
  })

  test('DuoSettingsPanel: shows recipe KPIs and opens Duo Recipes screen', { timeout: 60_000 }, async () => {
    const ctx = makeSpyCtx()
    setBuiltinClientStub({
      docs: {
        state: {
          recipes: {
            arch_coder: {
              id: 'arch_coder',
              name: 'Architect -> Coder',
              plannerModel: 'tier/architect',
              executorModel: 'tier/coder',
              maxExecutionSteps: 30,
              updatedAt: 1,
            },
          },
        },
      },
    })
    const mounted = await mountWithHost(
      e(PluginClientContext.Provider, { value: ctx }, e(DuoSettingsPanel)),
      { plugins: [makeDuoPluginSummary()] },
    )
    try {
      const text = mounted.host.textContent ?? ''
      assert.match(text, /Architect -> Coder/)
      assert.match(text, /tier\/arch_coder/)
      await act(async () => {
        findButton(mounted.host, 'Manage Duo Recipes').click()
      })
      assert.deepEqual(ctx.openedScreens, [`screen:${DUO_PLUGIN_ID}/${DUO_SCREEN_ID}`])
    } finally {
      await mounted.unmount()
    }
  })

  test('Composer + AgentStandbyPane + DuoToolbarPill: standby pill, active overrides, reset & live disable cleanup', { timeout: 60_000 }, async () => {
    mountSharedPluginNamespaces({ realHooks: true })
    resetPluginClientCache()
    seedPluginClientModule(DUO_PLUGIN_ID, 'index.tsx', rawIndexModule)

    const harness = createDocAndSessionHarness({
      recipes: {
        arch_coder: {
          id: 'arch_coder',
          name: 'Architect -> Coder',
          plannerModel: 'tier/architect',
          executorModel: 'tier/coder',
          maxExecutionSteps: 12,
          updatedAt: 100,
        },
      },
    })

    const actionCalls: Array<{ pluginId: string; actionId: string; input: unknown }> = []
    const openedTargets: string[] = []
    const onInvokeAction = async (pluginId: string, actionId: string, input: unknown) => {
      actionCalls.push({ pluginId, actionId, input })
      if (pluginId === DUO_PLUGIN_ID && actionId === 'override_executor') {
        const inp = input as { conversationId: number; executorModel: string }
        harness.setDuoDoc(inp.conversationId, {
          enabled: true,
          recipeId: 'arch_coder',
          recipeName: 'Architect -> Coder',
          phase: 'planning',
          plannerModel: 'faux/flagship',
          executorModel: inp.executorModel === 'tier/coder' ? 'faux/workhorse' : inp.executorModel,
          maxExecutionSteps: 12,
          executionStepCount: 0,
          stepLimitPaused: false,
          hasExecutorOverride: true,
        })
      }
      if (pluginId === DUO_PLUGIN_ID && actionId === 'clear_override') {
        const inp = input as { conversationId: number }
        harness.setDuoDoc(inp.conversationId, {
          enabled: true,
          recipeId: 'arch_coder',
          recipeName: 'Architect -> Coder',
          phase: 'planning',
          plannerModel: 'faux/flagship',
          executorModel: 'faux/workhorse',
          maxExecutionSteps: 12,
          executionStepCount: 0,
          stepLimitPaused: false,
          hasExecutorOverride: false,
        })
      }
      return {}
    }

    // 1. Standby pill when standby draft selects tier/arch_coder (zero dirty draft state)
    const standbyMount = await mountWithHost(
      e(
        WithHostOverrides,
        {
          harness,
          onInvokeAction,
          onOpenTarget: (target) => openedTargets.push(target),
        },
        e(AgentStandbyPane, { profileId: 'assistant' }),
      ),
      {
        plugins: [makeDuoPluginSummary()],
        uiContributions: makeDuoUiContributions(),
        profiles: [{ id: 'assistant', name: 'Assistant', model: 'tier/arch_coder' }],
      },
    )
    try {
      const pill = standbyMount.host.querySelector<HTMLButtonElement>('.composer-toolbar-left button.duo-pill')
      assert.ok(pill !== null, 'standby DuoToolbarPill renders for Duo recipe')
      assert.match(pill.textContent ?? '', /Planning → workhorse/)
      await act(async () => {
        pill.click()
      })
      const popover = document.body.querySelector<HTMLElement>('.duo-popover')
      assert.ok(popover !== null)
      assert.match(popover.textContent ?? '', /Architect -> Coder/)
      assert.match(popover.textContent ?? '', /tier\/arch_coder/)
      assert.match(popover.textContent ?? '', /Send a message to start the session/)
      await act(async () => {
        findButton(popover, 'Edit recipe').click()
      })
      assert.equal(openedTargets.at(-1), `screen:${DUO_PLUGIN_ID}/${DUO_SCREEN_ID}?edit=arch_coder`)
    } finally {
      await standbyMount.unmount()
    }

    // 2. Ineligible sub-conversation never renders DuoToolbarPill or subscribes
    const childConv = makeConversation({
      id: 41,
      title: 'Child worker',
      model: 'faux/workhorse',
      ownedBy: 'helmx',
      parentConversationId: 40,
    })
    const childMount = await mountWithHost(
      e(
        WithHostOverrides,
        { harness, onInvokeAction },
        e(Composer, { conversation: childConv, prefill: null }),
      ),
      {
        conversations: [childConv],
        plugins: [makeDuoPluginSummary()],
        uiContributions: makeDuoUiContributions(),
      },
    )
    try {
      assert.ok(childMount.host.querySelector('button.duo-pill') === null)
      assert.equal(harness.subscribedKeys.has(`${DUO_PLUGIN_ID}/${DUO_SESSION_DOC}/41`), false)
    } finally {
      await childMount.unmount()
    }

    // 3. Active top-level conversation: planning -> execution counter -> override_executor -> clear_override -> disable cleanup
    const parentConv = makeConversation({
      id: 40,
      title: 'Duo Active',
      model: 'faux/flagship',
      modelOverride: 'tier/arch_coder',
      effectiveModelRef: 'tier/arch_coder',
    })
    harness.setDuoDoc(40, {
      enabled: true,
      recipeId: 'arch_coder',
      recipeName: 'Architect -> Coder',
      phase: 'execution',
      plannerModel: 'faux/flagship',
      executorModel: 'faux/workhorse',
      maxExecutionSteps: 12,
      executionStepCount: 3,
      stepLimitPaused: false,
      hasExecutorOverride: false,
    })

    const activeMount = await mountWithHost(
      e(
        WithHostOverrides,
        { harness, onInvokeAction },
        e(Composer, { conversation: parentConv, prefill: null }),
      ),
      {
        conversations: [parentConv],
        plugins: [makeDuoPluginSummary()],
        uiContributions: makeDuoUiContributions(),
      },
    )
    try {
      const pill = activeMount.host.querySelector<HTMLButtonElement>('.composer-toolbar-left button.duo-pill')
      assert.ok(pill !== null)
      assert.match(pill.textContent ?? '', /Executing → workhorse/)
      assert.match(pill.textContent ?? '', /3\/12/)

      await act(async () => {
        pill.click()
      })
      const popover = document.body.querySelector<HTMLElement>('.duo-popover')
      assert.ok(popover !== null)

      // Open Executor ModelPickerControl inside popover: Duo recipes (arch_coder) must NOT appear (allowPreserveRefTiers=false)
      const pickerTrigger = popover.querySelector<HTMLButtonElement>('button.composer-model-button')
      assert.ok(pickerTrigger !== null)
      await act(async () => {
        pickerTrigger.click()
      })
      const modelMenu = document.body.querySelector<HTMLElement>('.composer-model-popover')
      assert.ok(modelMenu !== null)
      assert.equal((modelMenu.textContent ?? '').includes('Dual-phase recipes'), false)
      await act(async () => {
        findButton(modelMenu, 'fast').click()
      })
      const overrideCall = actionCalls.find((c) => c.actionId === 'override_executor')
      assert.ok(overrideCall !== undefined)
      assert.equal((overrideCall.input as { executorModel?: string }).executorModel, 'faux/fast')
      assert.match(popover.textContent ?? '', /Override/)

      await act(async () => {
        findButton(popover, 'Reset override').click()
      })
      assert.ok(actionCalls.some((c) => c.actionId === 'clear_override'))

      // Live disable removes DuoToolbarPill
      await act(async () => {
        activeMount.store.updateLive((s) => ({
          ...s,
          plugins: [{ ...makeDuoPluginSummary(), enabled: false, status: 'disabled' }],
          uiContributions: [],
        }))
      })
      assert.ok(activeMount.host.querySelector('button.duo-pill') === null)
    } finally {
      await activeMount.unmount()
    }
  })

  test('DuoTransitionToolRow: renders exit_plan_mode, hand_back_to_planner, running and error states cleanly', { timeout: 60_000 }, async () => {
    const ctx = makeSpyCtx()
    const mountRow = async (props: Record<string, unknown>) =>
      mountWithHost(e(PluginClientContext.Provider, { value: ctx }, e(DuoTransitionToolRow, props)))

    const exitMount = await mountRow({
      conversationId: 10,
      callId: 'c1',
      toolName: DUO_EXIT_PLAN_MODE_TOOL,
      status: 'done',
      result: 'Entered execution phase on faux/workhorse.',
      presentationMeta: {
        tool: DUO_EXIT_PLAN_MODE_TOOL,
        fromModel: 'faux/flagship',
        toModel: 'faux/workhorse',
        fromPhase: 'planning',
        toPhase: 'execution',
      },
    })
    try {
      assert.match(exitMount.host.textContent ?? '', /Plan ready -> workhorse/)
      assert.equal(EMOJI_RE.test(exitMount.host.textContent ?? ''), false)
    } finally {
      await exitMount.unmount()
    }

    const handBackMount = await mountRow({
      conversationId: 10,
      callId: 'c2',
      toolName: DUO_HAND_BACK_TOOL,
      status: 'done',
      result: 'Returned to planner.',
      presentationMeta: {
        tool: DUO_HAND_BACK_TOOL,
        fromModel: 'faux/workhorse',
        toModel: 'faux/flagship',
        fromPhase: 'execution',
        toPhase: 'planning',
        reason: 'step_budget_reached',
      },
    })
    try {
      assert.match(handBackMount.host.textContent ?? '', /Handed back workhorse -> flagship/)
      assert.match(handBackMount.host.textContent ?? '', /step_budget_reached/)
    } finally {
      await handBackMount.unmount()
    }

    const runningMount = await mountRow({
      conversationId: 10,
      callId: 'c3',
      toolName: DUO_HAND_BACK_TOOL,
      status: 'running',
      input: { reason: 'replan_needed' },
    })
    try {
      assert.match(runningMount.host.textContent ?? '', /Returned to Planner · replan_needed/)
    } finally {
      await runningMount.unmount()
    }

    const errorMount = await mountRow({
      conversationId: 10,
      callId: 'c4',
      toolName: DUO_EXIT_PLAN_MODE_TOOL,
      status: 'error',
      isError: true,
      result: 'Failed to switch to executor\nSecond line detail',
    })
    try {
      assert.match(errorMount.host.textContent ?? '', /Failed to switch to executor/)
    } finally {
      await errorMount.unmount()
    }
  })
})
