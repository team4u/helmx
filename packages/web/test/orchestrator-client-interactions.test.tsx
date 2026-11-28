/**
 * builtin:orchestrator Orchestrator UI interactive DOM tests (compiled TSX via @helmx/plugin-build):
 * - Modular Fast Refresh exports (`index.tsx`, `manager.tsx`, `settings.tsx`), zero Emoji, CSS hygiene;
 * - Unified ModelPicker: Orchestrators grouped under "Orchestrator", trigger shows custom displayLabel
 *   only (no concrete model, no thinking level, no Temp override badge during execution), filtered out
 *   of "Next turn only" (`singleTurnEligible: false`) and when `allowPreserveRefTiers={false}`;
 * - `OrchestratorManagerScreen` + `OrchestratorDetailDrawer`: loading state, empty starter `<List>`/`<ListRow>`,
 *   status pills filter + `SearchBox`, `.orch-fields` + `<MonoId>` + `Cmd/Ctrl+Enter` save,
 *   `remove` + `409` force-delete double-confirm;
 * - `OrchestratorSettingsPanel`: loading state, KPIs + `<List density="compact">` + `openScreen` triggers;
 * - `OrchestratorStatusPill` in `COMPOSER_STATUS_SLOT`: standby returns `null` (zero sessionDoc subscription),
 *   minimal `Plan · <planner>` / `Exec · <executor>` / `Coord · <planner>` status pill, popover with
 *   `<MonoId>`, Planner/Executor thinking levels, interactive Executor `ModelPickerControl` calling
 *   `override_executor`, `Reset override` calling `clear_override`, step counter, edit pencil,
 *   ineligible sub-conversation guard, and live disable cleanup;
 * - `OrchestratorTransitionToolRow`: `trace-row` for `exit_plan_mode`, `hand_back_to_planner`, running & error.
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
import { COMPOSER_STATUS_SLOT } from '@helmx/protocol'
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
  ORCHESTRATOR_DEFAULT_MAX_STEPS,
  ORCHESTRATOR_EXIT_PLAN_MODE_TOOL,
  ORCHESTRATOR_HAND_BACK_TOOL,
  ORCHESTRATOR_PLUGIN_ID,
  ORCHESTRATOR_SCREEN_ID,
  ORCHESTRATOR_SESSION_DOC,
  ORCHESTRATOR_STATE_DOC,
  createEmptyOrchestratorDraft,
  getStarterOrchestratorPresets,
  parseOrchestratorSessionDoc,
  parseOrchestratorStateDoc,
  validateOrchestratorDraft,
} = await import('../../plugins/src/orchestrator/client/models.ts')
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
let OrchestratorStatusPill: (props: Record<string, unknown>) => React.ReactElement | null
let OrchestratorTransitionToolRow: (props: Record<string, unknown>) => React.ReactElement
let OrchestratorManagerScreen: (props: Record<string, unknown>) => React.ReactElement
let OrchestratorSettingsPanel: () => React.ReactElement

describe('orchestrator-client-interactions', () => {
  before(async () => {
    mountSharedPluginNamespaces()
    rawIndexModule = await importBuiltinClientModule(ORCHESTRATOR_PLUGIN_ID, 'index.tsx')
    rawManagerModule = await importBuiltinClientModule(ORCHESTRATOR_PLUGIN_ID, 'manager.tsx')
    rawSettingsModule = await importBuiltinClientModule(ORCHESTRATOR_PLUGIN_ID, 'settings.tsx')
    OrchestratorStatusPill = rawIndexModule['OrchestratorStatusPill'] as (
      props: Record<string, unknown>,
    ) => React.ReactElement | null
    OrchestratorTransitionToolRow = rawIndexModule['OrchestratorTransitionToolRow'] as (
      props: Record<string, unknown>,
    ) => React.ReactElement
    OrchestratorManagerScreen = rawManagerModule['OrchestratorManagerScreen'] as (
      props: Record<string, unknown>,
    ) => React.ReactElement
    OrchestratorSettingsPanel = rawSettingsModule['OrchestratorSettingsPanel'] as () => React.ReactElement
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
      displayGroup: 'orchestrator',
      displayLabel: 'Orchestrator (Flagship)',
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
      pluginId: ORCHESTRATOR_PLUGIN_ID,
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

  function createDocAndSessionHarness(initialStateDoc: unknown = { items: {} }) {
    const listeners = new Set<() => void>()
    const states = new Map<string, PluginSessionDocState>()
    const stateDocKey = `${ORCHESTRATOR_PLUGIN_ID}/${ORCHESTRATOR_STATE_DOC}`
    const EMPTY: PluginSessionDocState = { hasValue: false, deleted: false, connected: true }
    let stateDocVal = initialStateDoc

    const keyStr = (k: PluginSessionDocKey): string => `${k.pluginId}/${k.docName}/${k.conversationId}`

    return {
      subscribedKeys: new Set<string>(),
      setStateDoc(next: unknown) {
        stateDocVal = next
        for (const fn of [...listeners]) fn()
      },
      setOrchestratorDoc(conversationId: number, value: unknown) {
        const key = `${ORCHESTRATOR_PLUGIN_ID}/${ORCHESTRATOR_SESSION_DOC}/${conversationId}`
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

  function makeOrchestratorPluginSummary(): PluginSummary {
    const hooks: HookName[] = ['input', 'before_turn', 'agent_spawn', 'turn_settled']
    return {
      id: ORCHESTRATOR_PLUGIN_ID,
      name: { en: 'Orchestrator', 'zh-CN': '编排器' },
      version: '0.2.0',
      enabled: true,
      status: 'active',
      hooks,
      actions: [],
      tools: [ORCHESTRATOR_EXIT_PLAN_MODE_TOOL, ORCHESTRATOR_HAND_BACK_TOOL],
      clientHashes: {
        'index.tsx': 'seeded',
        'manager.tsx': 'seeded',
        'settings.tsx': 'seeded',
      },
    }
  }

  function makeOrchestratorUiContributions() {
    return [
      {
        pluginId: ORCHESTRATOR_PLUGIN_ID,
        surface: 'plugin.slot' as const,
        spec: {
          id: 'orchestrator-status-pill',
          target: COMPOSER_STATUS_SLOT,
          order: 15,
          client: { module: 'index.tsx', export: 'OrchestratorStatusPill' },
        },
      },
    ]
  }

  test('modular Fast Refresh exports, orchestrator CSS hygiene, pure helpers, and zero Emoji', { timeout: 60_000 }, () => {
    assert.equal(ORCHESTRATOR_PLUGIN_ID, 'builtin:orchestrator')
    assert.equal(ORCHESTRATOR_STATE_DOC, 'state')
    assert.equal(ORCHESTRATOR_SESSION_DOC, 'orchestrator')
    assert.equal(ORCHESTRATOR_DEFAULT_MAX_STEPS, 30)
    void OrchestratorStatusPill

    const indexExports = Object.keys(rawIndexModule).filter((k) => k !== '__helmxClientCss').sort()
    assert.deepEqual(indexExports, ['OrchestratorStatusPill', 'OrchestratorTransitionToolRow'])

    const managerExports = Object.keys(rawManagerModule).filter((k) => k !== '__helmxClientCss').sort()
    assert.deepEqual(managerExports, ['OrchestratorManagerScreen'])

    const settingsExports = Object.keys(rawSettingsModule).filter((k) => k !== '__helmxClientCss').sort()
    assert.deepEqual(settingsExports, ['OrchestratorSettingsPanel'])

    const cssText = String(rawIndexModule['__helmxClientCss'] ?? '')
    assert.match(cssText, /\.orch-status-trigger/)
    assert.match(cssText, /\.orch-fields/)
    assert.match(cssText, /\.orch-trace-row/)
    assert.match(cssText, /@media\s*\(hover:\s*hover\)/)

    const parsed = parseOrchestratorStateDoc({
      items: {
        arch_coder: {
          id: 'arch_coder',
          name: 'Orchestrator (Flagship)',
          plannerModel: 'tier/architect',
          executorModel: 'tier/coder',
          maxExecutionSteps: 30,
          updatedAt: 1,
        },
      },
    })
    assert.ok(parsed.items['arch_coder'])
    assert.equal(parseOrchestratorSessionDoc({ enabled: false }), null)
    const empty = createEmptyOrchestratorDraft()
    assert.equal(
      validateOrchestratorDraft(
        { ...empty, id: 'coder', name: 'Bad', plannerModel: 'faux/flagship', executorModel: 'faux/fast' },
        { mode: 'create', existingItemIds: new Set(), externalTierIds: new Set(['coder']) },
      ),
      'id_conflict',
    )
    const starters = getStarterOrchestratorPresets('en', {
      models: TEST_MODELS,
      modelTiers: TEST_TIERS,
      modelThinkingLevels: {},
    })
    assert.equal(starters[0]!.name, 'Orchestrator (flagship)')
    assert.equal(starters[0]!.plannerModel, 'tier/architect')
    assert.equal(starters[0]!.executorModel, 'tier/coder')
    assert.equal(EMOJI_RE.test(JSON.stringify(starters)), false)
    const zhStarters = getStarterOrchestratorPresets('zh-CN', {
      models: TEST_MODELS,
      modelTiers: TEST_TIERS,
      modelThinkingLevels: {},
    })
    assert.equal(zhStarters[0]!.name, '编排器（flagship）')
    assert.equal(JSON.stringify(zhStarters).includes('配方'), false)
  })

  test('Unified ModelPicker renders Orchestrator group, keeps trigger minimal without level/override badge, and hides on Next-turn tab', { timeout: 60_000 }, async () => {
    const pickerMount = await mountWithHost(
      e(ModelPicker, {
        conversation: makeConversation({
          id: 1,
          model: 'faux/workhorse',
          thinkingLevel: 'high',
          modelOverride: 'tier/arch_coder',
          effectiveModelRef: 'tier/arch_coder',
          runtimeModelOverride: true,
        }),
        nextTurnMode: { onChange: () => {} },
      }),
    )
    try {
      const trigger = pickerMount.host.querySelector<HTMLButtonElement>('button.composer-model-button')
      assert.ok(trigger !== null)
      assert.equal(trigger.querySelector('.composer-model-label')?.textContent?.trim(), 'Orchestrator (Flagship)')
      assert.ok(trigger.querySelector('.composer-model-level') === null, 'Orchestrator trigger omits thinking level')
      assert.ok(pickerMount.host.querySelector('.composer-model-runtime-wrap') === null, 'Orchestrator execution omits Temp override badge')

      await act(async () => {
        trigger.click()
      })
      const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
      assert.ok(popover !== null)
      assert.match(popover.textContent ?? '', /Orchestrator/)
      assert.match(popover.textContent ?? '', /Orchestrator \(Flagship\)/)
      assert.match(popover.textContent ?? '', /flagship → workhorse/)

      // Switching to "Next turn only" hides singleTurnEligible=false Orchestrators
      const nextTurnTab = findButton(popover, 'Next turn only')
      await act(async () => {
        nextTurnTab.click()
      })
      assert.equal((popover.textContent ?? '').includes('Orchestrator (Flagship)'), false)
    } finally {
      await pickerMount.unmount()
    }
  })

  test('OrchestratorManagerScreen + OrchestratorDetailDrawer: loading, starter ListRow creation, filter/search List, Cmd+Enter edit save, and 409 force-delete', { timeout: 60_000 }, async () => {
    const ctx = makeSpyCtx()

    // 0. Loading state when doc is undefined
    setBuiltinClientStub({ docs: {} })
    const loadingMount = await mountWithHost(
      e(PluginClientContext.Provider, { value: ctx }, e(OrchestratorManagerScreen, { inlineDrawer: true })),
    )
    try {
      assert.match(loadingMount.host.textContent ?? '', /Loading orchestrators/)
    } finally {
      await loadingMount.unmount()
    }

    // 1. Empty state -> starter ListRow -> click "Bind" opens create drawer (no MonoId/Badge) -> Create invokes 'set'
    setBuiltinClientStub({ docs: { state: { items: {} } } })
    const emptyMount = await mountWithHost(
      e(
        PluginClientContext.Provider,
        { value: ctx },
        e(OrchestratorManagerScreen, { inlineDrawer: true }),
      ),
    )
    try {
      const text = emptyMount.host.textContent ?? ''
      assert.match(text, /No orchestrators yet/)
      assert.match(text, /Starter orchestrators/)
      assert.match(text, /Orchestrator \(flagship\)/)
      assert.ok(emptyMount.host.querySelector('[data-starter-orchestrator="orch_architect"]') !== null)

      await act(async () => {
        findButton(emptyMount.host, 'Bind').click()
      })
      assert.ok(emptyMount.host.querySelector('.helmx-mono-id') === null, 'Create drawer omits MonoId meta')
      assert.ok(emptyMount.host.querySelector('.orch-fields') !== null, 'Grouped orchestrator fields render')
      const idInput = emptyMount.host.querySelector<HTMLInputElement>('#orch-id')
      assert.ok(idInput !== null)
      assert.equal(idInput.value, 'orch_architect')

      await act(async () => {
        findButton(emptyMount.host, 'Create').click()
      })
      const setCall = ctx.actionCalls.find((c) => c.actionId === 'set')
      assert.ok(setCall !== undefined)
      assert.deepEqual(setCall.input, {
        id: 'orch_architect',
        name: 'Orchestrator (flagship)',
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

    // 2. Populated state: List + ListRow, status pills + search, edit drawer MonoId + Cmd+Enter save, delete -> 409 -> Force delete
    setBuiltinClientStub({
      docs: {
        state: {
          items: {
            arch_coder: {
              id: 'arch_coder',
              name: 'Orchestrator (Flagship)',
              description: 'Main dual-phase pairing',
              plannerModel: 'tier/architect',
              executorModel: 'tier/coder',
              maxExecutionSteps: 25,
              updatedAt: 10,
            },
            broken_pair: {
              id: 'broken_pair',
              name: 'Broken Orchestrator',
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
          throw Object.assign(new Error("Orchestrator 'tier/arch_coder' is in use by Profile assistant"), {
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
        e(OrchestratorManagerScreen, { inlineDrawer: true }),
      ),
    )
    try {
      const fullText = fullMount.host.textContent ?? ''
      assert.match(fullText, /Orchestrator \(Flagship\)/)
      assert.match(fullText, /tier\/arch_coder/)
      assert.match(fullText, /tier\/missing_ext/)

      // Status pill filter (Attention -> 1 item, Available -> 1 item, All -> 2 items)
      const attentionTab = Array.from(fullMount.host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        .find((el) => (el.textContent ?? '').includes('Attention'))
      assert.ok(attentionTab !== undefined)
      await act(async () => {
        attentionTab.click()
      })
      assert.equal(fullMount.host.querySelectorAll('[data-orchestrator-id]').length, 1)
      const availableTab = Array.from(fullMount.host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        .find((el) => (el.textContent ?? '').includes('Available'))
      assert.ok(availableTab !== undefined)
      await act(async () => {
        availableTab.click()
      })
      assert.equal(fullMount.host.querySelectorAll('[data-orchestrator-id]').length, 1)
      assert.ok(fullMount.host.querySelector('[data-orchestrator-id="arch_coder"] [aria-label="Available"]') !== null)
      const allTab = Array.from(fullMount.host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        .find((el) => (el.textContent ?? '').includes('All'))!
      await act(async () => {
        allTab.click()
      })
      assert.equal(fullMount.host.querySelectorAll('[data-orchestrator-id]').length, 2)

      // Filter via SearchBox + Reset filters
      const searchInput = fullMount.host.querySelector<HTMLInputElement>('input[aria-label="Search orchestrators"]')
      assert.ok(searchInput !== null)
      await act(async () => {
        setInputValue(searchInput, 'no_such_item')
      })
      assert.match(fullMount.host.textContent ?? '', /No matching orchestrators/)
      await act(async () => {
        findButton(fullMount.host, 'Reset filters').click()
      })
      assert.equal(fullMount.host.querySelectorAll('[data-orchestrator-id]').length, 2)

      // Open edit drawer on arch_coder ListRow -> verify MonoId + change name -> Cmd+Enter submits
      const rowTrigger = fullMount.host.querySelector<HTMLButtonElement>(
        '[data-orchestrator-id="arch_coder"] button.helmx-list-row-trigger',
      )
      assert.ok(rowTrigger !== null)
      await act(async () => {
        rowTrigger.click()
      })
      assert.equal(
        fullMount.host.querySelector('.primary-drawer-id .helmx-mono-id-code')?.textContent?.trim(),
        'tier/arch_coder',
      )
      const nameInput = fullMount.host.querySelector<HTMLInputElement>('#orch-name')
      const idField = fullMount.host.querySelector<HTMLInputElement>('#orch-id')
      assert.ok(nameInput !== null && idField !== null)
      assert.equal(idField.disabled, true, 'orchestrator id is locked during edit')
      await act(async () => {
        setInputValue(nameInput, 'Orchestrator (Opus v2)')
      })
      await act(async () => {
        nameInput.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }),
        )
      })
      const updateCall = populatedCtx.actionCalls.find((c) => c.actionId === 'set')
      assert.equal((updateCall?.input as { name?: string })?.name, 'Orchestrator (Opus v2)')

      // Delete triggers 409 -> Force delete confirm dialog
      const deleteBtn = fullMount.host.querySelector<HTMLButtonElement>(
        '[data-orchestrator-id="arch_coder"] button.orch-row-delete-btn',
      )
      assert.ok(deleteBtn !== null)
      await act(async () => {
        deleteBtn.click()
      })
      const firstAlert = fullMount.host.querySelector('[role="alertdialog"]') ?? document.body.querySelector('[role="alertdialog"]')
      assert.ok(firstAlert !== null, 'first ConfirmDialog should open')
      await act(async () => {
        findButton(firstAlert, 'Delete').click()
      })
      const secondAlert = fullMount.host.querySelector('[role="alertdialog"]') ?? document.body.querySelector('[role="alertdialog"]')
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

  test('OrchestratorSettingsPanel: shows orchestrator KPIs, compact ListRow, and opens Orchestrator screen', { timeout: 60_000 }, async () => {
    const ctx = makeSpyCtx()
    setBuiltinClientStub({
      docs: {
        state: {
          items: {
            arch_coder: {
              id: 'arch_coder',
              name: 'Orchestrator (Flagship)',
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
      e(PluginClientContext.Provider, { value: ctx }, e(OrchestratorSettingsPanel)),
      { plugins: [makeOrchestratorPluginSummary()] },
    )
    try {
      const text = mounted.host.textContent ?? ''
      assert.match(text, /Orchestrator \(Flagship\)/)
      assert.match(text, /tier\/arch_coder/)
      assert.match(text, /Available/)
      assert.ok(mounted.host.querySelector('.helmx-list-compact') !== null)
      const rowBtn = mounted.host.querySelector<HTMLButtonElement>('button.helmx-list-row-trigger')
      assert.ok(rowBtn !== null)
      await act(async () => {
        rowBtn.click()
      })
      await act(async () => {
        findButton(mounted.host, 'Open Orchestrator').click()
      })
      assert.deepEqual(ctx.openedScreens, [
        `screen:${ORCHESTRATOR_PLUGIN_ID}/${ORCHESTRATOR_SCREEN_ID}?edit=arch_coder`,
        `screen:${ORCHESTRATOR_PLUGIN_ID}/${ORCHESTRATOR_SCREEN_ID}`,
      ])
    } finally {
      await mounted.unmount()
    }
  })

  test('Composer + AgentStandbyPane + OrchestratorStatusPill (COMPOSER_STATUS_SLOT): standby returns null, active status pill, overrides, coordinator & live disable', { timeout: 60_000 }, async () => {
    mountSharedPluginNamespaces({ realHooks: true })
    resetPluginClientCache()
    seedPluginClientModule(ORCHESTRATOR_PLUGIN_ID, 'index.tsx', rawIndexModule)

    const harness = createDocAndSessionHarness({
      items: {
        arch_coder: {
          id: 'arch_coder',
          name: 'Orchestrator (Flagship)',
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
      if (pluginId === ORCHESTRATOR_PLUGIN_ID && actionId === 'override_executor') {
        const inp = input as { conversationId: number; executorModel: string }
        harness.setOrchestratorDoc(inp.conversationId, {
          enabled: true,
          orchestratorId: 'arch_coder',
          orchestratorName: 'Orchestrator (Flagship)',
          phase: 'planning',
          plannerModel: 'faux/flagship',
          plannerThinkingLevel: 'xhigh',
          executorModel: inp.executorModel === 'tier/coder' ? 'faux/workhorse' : inp.executorModel,
          maxExecutionSteps: 12,
          executionStepCount: 0,
          stepLimitPaused: false,
          hasExecutorOverride: true,
        })
      }
      if (pluginId === ORCHESTRATOR_PLUGIN_ID && actionId === 'clear_override') {
        const inp = input as { conversationId: number }
        harness.setOrchestratorDoc(inp.conversationId, {
          enabled: true,
          orchestratorId: 'arch_coder',
          orchestratorName: 'Orchestrator (Flagship)',
          phase: 'planning',
          plannerModel: 'faux/flagship',
          plannerThinkingLevel: 'xhigh',
          executorModel: 'faux/workhorse',
          executorThinkingLevel: 'high',
          maxExecutionSteps: 12,
          executionStepCount: 0,
          stepLimitPaused: false,
          hasExecutorOverride: false,
        })
      }
      return {}
    }

    // 1. Standby draft selects tier/arch_coder -> status slot returns null (zero duplication, zero sessionDoc sub)
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
        plugins: [makeOrchestratorPluginSummary()],
        uiContributions: makeOrchestratorUiContributions(),
        profiles: [{ id: 'assistant', name: 'Assistant', model: 'tier/arch_coder' }],
      },
    )
    try {
      assert.ok(standbyMount.host.querySelector('button.orch-status-trigger') === null)
      assert.equal(harness.subscribedKeys.size, 0)
    } finally {
      await standbyMount.unmount()
    }

    // 2. Ineligible sub-conversation never renders OrchestratorStatusPill or subscribes
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
        plugins: [makeOrchestratorPluginSummary()],
        uiContributions: makeOrchestratorUiContributions(),
      },
    )
    try {
      assert.ok(childMount.host.querySelector('button.orch-status-trigger') === null)
      assert.equal(harness.subscribedKeys.has(`${ORCHESTRATOR_PLUGIN_ID}/${ORCHESTRATOR_SESSION_DOC}/41`), false)
    } finally {
      await childMount.unmount()
    }

    // 3. Active top-level conversation in execution: status row shows minimal "Exec · workhorse",
    //    main ModelPicker stays on "Orchestrator (Flagship)" without Temp override badge
    const parentConv = makeConversation({
      id: 40,
      title: 'Orchestrator Active',
      model: 'faux/workhorse',
      thinkingLevel: 'high',
      modelOverride: 'tier/arch_coder',
      effectiveModelRef: 'tier/arch_coder',
      runtimeModelOverride: true,
    })
    harness.setOrchestratorDoc(40, {
      enabled: true,
      orchestratorId: 'arch_coder',
      orchestratorName: 'Orchestrator (Flagship)',
      phase: 'execution',
      plannerModel: 'faux/flagship',
      plannerThinkingLevel: 'xhigh',
      executorModel: 'faux/workhorse',
      executorThinkingLevel: 'high',
      maxExecutionSteps: 12,
      executionStepCount: 3,
      stepLimitPaused: false,
      hasExecutorOverride: false,
    })

    const activeMount = await mountWithHost(
      e(
        WithHostOverrides,
        {
          harness,
          onInvokeAction,
          onOpenTarget: (target) => openedTargets.push(target),
        },
        e(Composer, { conversation: parentConv, prefill: null }),
      ),
      {
        conversations: [parentConv],
        plugins: [makeOrchestratorPluginSummary()],
        uiContributions: makeOrchestratorUiContributions(),
      },
    )
    try {
      // Main ModelPicker stays stable on Orchestrator displayLabel without Temp override badge
      assert.equal(
        activeMount.host.querySelector('.composer-toolbar-left .composer-model-label')?.textContent?.trim(),
        'Orchestrator (Flagship)',
      )
      assert.ok(activeMount.host.querySelector('.composer-model-runtime-badge') === null)

      // Status-row pill renders inside .composer-status-row with minimal "Exec · workhorse"
      const pill = activeMount.host.querySelector<HTMLButtonElement>('.composer-status-row button.orch-status-trigger')
      assert.ok(pill !== null)
      assert.equal(pill.textContent?.replace(/\s+/g, ' ').trim(), 'Exec·workhorse')
      assert.ok(pill.title.includes('3/12'))

      await act(async () => {
        pill.click()
      })
      const popover = document.body.querySelector<HTMLElement>('.orch-popover')
      assert.ok(popover !== null)
      assert.match(popover.textContent ?? '', /Orchestrator \(Flagship\)/)
      assert.match(popover.textContent ?? '', /tier\/arch_coder/)
      assert.match(popover.textContent ?? '', /3 \/ 12/)
      assert.match(popover.textContent ?? '', /xhigh/)

      // Edit pencil opens manager drawer
      const editBtn = popover.querySelector<HTMLButtonElement>('button[aria-label="Edit orchestrator"]')
      assert.ok(editBtn !== null)
      await act(async () => {
        editBtn.click()
      })
      assert.equal(openedTargets.at(-1), `screen:${ORCHESTRATOR_PLUGIN_ID}/${ORCHESTRATOR_SCREEN_ID}?edit=arch_coder`)

      // Re-open popover and test interactive Executor ModelPickerControl (excludes Orchestrator group)
      await act(async () => {
        pill.click()
      })
      const reopenedPopover = document.body.querySelector<HTMLElement>('.orch-popover')!
      const pickerTrigger = reopenedPopover.querySelector<HTMLButtonElement>('button.composer-model-button')
      assert.ok(pickerTrigger !== null)
      await act(async () => {
        pickerTrigger.click()
      })
      const modelMenu = document.body.querySelector<HTMLElement>('.composer-model-popover')
      assert.ok(modelMenu !== null)
      assert.equal((modelMenu.textContent ?? '').includes('Orchestrator (Flagship)'), false)
      await act(async () => {
        findButton(modelMenu, 'fast').click()
      })
      const overrideCall = actionCalls.find((c) => c.actionId === 'override_executor')
      assert.ok(overrideCall !== undefined)
      assert.equal((overrideCall.input as { executorModel?: string }).executorModel, 'faux/fast')
      assert.equal(pill.textContent?.replace(/\s+/g, ' ').trim(), 'Plan·flagship')
      assert.match(reopenedPopover.textContent ?? '', /Override/)

      await act(async () => {
        findButton(reopenedPopover, 'Reset override').click()
      })
      assert.ok(actionCalls.some((c) => c.actionId === 'clear_override'))

      // Coordinator suppression + stepLimitPaused warn tone
      await act(async () => {
        harness.setOrchestratorDoc(40, {
          enabled: true,
          orchestratorId: 'arch_coder',
          orchestratorName: 'Orchestrator (Flagship)',
          phase: 'planning',
          plannerModel: 'faux/flagship',
          executorModel: 'faux/workhorse',
          maxExecutionSteps: 12,
          executionStepCount: 0,
          stepLimitPaused: false,
          suppressedByCoordinator: true,
          hasExecutorOverride: false,
        })
      })
      assert.equal(pill.textContent?.replace(/\s+/g, ' ').trim(), 'Coord·flagship')

      // Live disable removes OrchestratorStatusPill
      await act(async () => {
        activeMount.store.updateLive((s) => ({
          ...s,
          plugins: [{ ...makeOrchestratorPluginSummary(), enabled: false, status: 'disabled' }],
          uiContributions: [],
        }))
      })
      assert.ok(activeMount.host.querySelector('button.orch-status-trigger') === null)
    } finally {
      await activeMount.unmount()
    }
  })

  test('OrchestratorTransitionToolRow: renders 26px trace-row for exit_plan_mode, hand_back_to_planner, running and error states', { timeout: 60_000 }, async () => {
    const ctx = makeSpyCtx()
    const mountRow = async (props: Record<string, unknown>) =>
      mountWithHost(e(PluginClientContext.Provider, { value: ctx }, e(OrchestratorTransitionToolRow, props)))

    const exitMount = await mountRow({
      conversationId: 10,
      callId: 'c1',
      toolName: ORCHESTRATOR_EXIT_PLAN_MODE_TOOL,
      status: 'done',
      durationMs: 420,
      result: 'Entered execution phase on faux/workhorse.',
      presentationMeta: {
        tool: ORCHESTRATOR_EXIT_PLAN_MODE_TOOL,
        fromModel: 'faux/flagship',
        toModel: 'faux/workhorse',
        fromPhase: 'planning',
        toPhase: 'execution',
      },
    })
    try {
      assert.ok(exitMount.host.querySelector('.trace-entry > .trace-row.orch-trace-row') !== null)
      assert.match(exitMount.host.textContent ?? '', /Enter execution phase/)
      assert.match(exitMount.host.textContent ?? '', /Switched to executor workhorse/)
      assert.match(exitMount.host.textContent ?? '', /Executor/)
      assert.equal(EMOJI_RE.test(exitMount.host.textContent ?? ''), false)
    } finally {
      await exitMount.unmount()
    }

    const handBackMount = await mountRow({
      conversationId: 10,
      callId: 'c2',
      toolName: ORCHESTRATOR_HAND_BACK_TOOL,
      status: 'done',
      result: 'Returned to planner.',
      presentationMeta: {
        tool: ORCHESTRATOR_HAND_BACK_TOOL,
        fromModel: 'faux/workhorse',
        toModel: 'faux/flagship',
        fromPhase: 'execution',
        toPhase: 'planning',
        reason: 'step_budget_reached',
      },
    })
    try {
      assert.match(handBackMount.host.textContent ?? '', /Hand back to planner/)
      assert.match(handBackMount.host.textContent ?? '', /Returned to planner flagship · step_budget_reached/)
      assert.match(handBackMount.host.textContent ?? '', /Planner/)
    } finally {
      await handBackMount.unmount()
    }

    const runningMount = await mountRow({
      conversationId: 10,
      callId: 'c3',
      toolName: ORCHESTRATOR_HAND_BACK_TOOL,
      status: 'running',
      input: { reason: 'replan_needed' },
    })
    try {
      assert.match(runningMount.host.textContent ?? '', /Hand back to planner/)
      assert.match(runningMount.host.textContent ?? '', /replan_needed/)
    } finally {
      await runningMount.unmount()
    }

    const errorMount = await mountRow({
      conversationId: 10,
      callId: 'c4',
      toolName: ORCHESTRATOR_EXIT_PLAN_MODE_TOOL,
      status: 'error',
      isError: true,
      result: 'Failed to switch to executor\nSecond line detail',
    })
    try {
      assert.ok(errorMount.host.querySelector('.trace-row-error') !== null)
      assert.match(errorMount.host.textContent ?? '', /Failed to switch to executor/)
    } finally {
      await errorMount.unmount()
    }
  })
})
