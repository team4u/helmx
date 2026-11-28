/**
 * Unit & Happy-DOM UI tests for `builtin:duo`:
 * - Pure contracts & client helper parsing/validation;
 * - PluginHost lifecycle (`plan.approved`, `helmx.plan-mode-active`, `helmx.planning-orchestration-tools`,
 *   `helmx.default-child-model`, grandchild chain walking, `pi.reset` + handoff exception,
 *   `reconcile()` crash recovery, `stop()` restore, standby `input.meta` block/accept);
 * - Real esbuild-compiled Happy-DOM rendering of `DuoProfileSection`, `DuoMenuItem`,
 *   `DuoToolbarPill`, and `DuoTransitionToolRow` (Radix primitives, zero Emoji, `presentationMeta` rendering).
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensureHappyDom, resetHappyDom } from '../../plugin-client/test/helpers/dom-harness.js'
import {
  HelmxError,
  type BeforeTurnHookPayload,
  type ConversationSummary,
  type PluginClientContext as PluginClientContextType,
  type PluginToolSpec,
  type Profile,
} from '@helmx/protocol'
import type { PluginClientHostPort, PluginSessionDocKey } from '@helmx/plugin-client'
import { PluginHost, type PluginHostBackend } from '@helmx/kernel'
import { CLIENT_SHARED_GLOBALS, compilePluginClientModule, createPluginBuildProvider } from '@helmx/plugin-build'
import { createPluginHostBackendFixture } from '../../kernel/test/helpers/plugin-host-backend.js'
import {
  DEFAULT_CHILD_MODEL_CAPABILITY_ID,
  PLAN_APPROVED_EVENT,
  PLAN_MODE_ACTIVE_CAPABILITY_ID,
  PLANNING_ORCHESTRATION_TOOLS_CAPABILITY_ID,
  type DefaultChildModelCapability,
} from '../src/contracts.js'
import {
  DUO_DEFAULT_MAX_STEPS,
  DUO_EXIT_PLAN_MODE_TOOL,
  DUO_HAND_BACK_TOOL,
  DUO_INPUT_META_KEY,
  DUO_PLAN_SECTION_ID,
  DUO_PLUGIN_ID,
  DUO_PROFILES_DOC,
  DUO_SESSION_DOC,
  DUO_STATES_KV,
  createDuoPlugin,
  type DuoSessionView,
} from '../src/duo.js'
import {
  normalizeDuoModelRef,
  normalizeDuoThinkingLevel,
  normalizeMaxExecutionSteps,
  parseDuoInputMeta,
  resolveDuoModelThroughTiers,
  type DuoRuntimeRecord,
} from '../src/duo/contracts.js'
import {
  extractFallbackTransitionInfo,
  extractFirstErrorLine,
  isDuoEligibleConversation,
  parseDuoProfilesDoc,
  parseDuoSessionDoc,
  parseDuoStandbyMeta,
  parseDuoTransitionPresentationMeta,
  validateMaxStepsInput,
} from '../src/duo/client/models.js'
import {
  MemoryConfigStore,
  MemoryDocStore,
  MemoryKvStore,
  cleanupDir,
  makeConversationSummary,
  makeTempDir,
} from './helpers/plugin-test-env.js'

const TIMEOUT = { timeout: 60_000 } as const
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u

function makeToolSpec(name: string): PluginToolSpec {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    execute: () => 'ok',
  }
}

function openDuoUnitHost(options: {
  conversations?: ConversationSummary[]
  profiles?: Profile[]
  kvStore?: MemoryKvStore
  deferServices?: boolean
} = {}) {
  const conversations = new Map<number, ConversationSummary>()
  for (const c of options.conversations ?? [makeConversationSummary({ id: 1, model: 'faux/flagship' })]) {
    conversations.set(c.id, c)
  }
  const profiles = new Map<string, Profile>()
  for (const p of options.profiles ?? [{ id: 'assistant', name: 'Assistant' }]) {
    profiles.set(p.id, p)
  }
  const runtimeCalls: Array<{
    id: number
    target: { model: string; thinkingLevel?: string; resetOnRunEnd?: boolean } | null
  }> = []
  const listeners = new Map<string, Set<(payload: unknown) => Promise<void> | void>>()
  const kvStore = options.kvStore ?? new MemoryKvStore()
  const docStore = new MemoryDocStore()
  const base = createPluginHostBackendFixture()

  const backend: PluginHostBackend = {
    ...base,
    profiles: {
      ...base.profiles,
      list: async () => [...profiles.values()],
      get: async (id: string) => profiles.get(id),
    },
    skills: {
      ...base.skills,
      ensureSkill: async () => {},
    },
    listModels: async () => ({
      models: [
        { provider: 'faux', modelId: 'flagship', available: true },
        { provider: 'faux', modelId: 'coder', available: true },
        { provider: 'faux', modelId: 'disabled', available: true, disabled: true },
      ],
      thinkingLevels: { 'faux/coder': ['low', 'medium', 'high'] },
    }),
    listConversations(filter) {
      let items = [...conversations.values()].map((c) => structuredClone(c))
      if (filter?.ownedBy !== undefined) items = items.filter((c) => (c.ownedBy ?? 'human') === filter.ownedBy)
      if (filter?.topLevelOnly) items = items.filter((c) => c.parentConversationId === undefined)
      return items
    },
    getConversation(id) {
      const found = conversations.get(id)
      if (!found) throw new HelmxError('not_found', `Conversation ${id} not found`, 404)
      return structuredClone(found)
    },
    async setConversationRuntimeModel(id, target) {
      runtimeCalls.push({ id, target: structuredClone(target) })
      const found = conversations.get(id)
      if (!found) throw new HelmxError('not_found', `Conversation ${id} not found`, 404)
      const next: ConversationSummary =
        target === null
          ? { ...found, model: found.modelOverride || 'faux/flagship', runtimeModelOverride: false }
          : {
              ...found,
              model: target.model,
              ...(target.thinkingLevel !== undefined ? { thinkingLevel: target.thinkingLevel } : {}),
              runtimeModelOverride: true,
            }
      conversations.set(id, next)
      return structuredClone(next)
    },
    onEvent(type, listener) {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(listener)
      return () => {
        set?.delete(listener)
      }
    },
    emitEvent: () => {},
  }

  return makeTempDir('helmx-duo-unit-').then(async (dataDir) => {
    const host = new PluginHost({
      dataDir,
      host: backend,
      docs: docStore,
      kv: kvStore,
      config: new MemoryConfigStore({}),
      buildProvider: createPluginBuildProvider(),
      deferServices: options.deferServices ?? false,
    })
    await host.register(createDuoPlugin())
    return {
      host,
      conversations,
      profiles,
      runtimeCalls,
      kvStore,
      docStore,
      async dispatchEvent(type: string, payload: unknown) {
        for (const fn of [...(listeners.get(type) ?? [])]) {
          await fn(payload)
        }
      },
      async close() {
        await host.dispose().catch(() => {})
        await cleanupDir(dataDir)
      },
    }
  })
}

test('pure contracts and client model helpers validate inputs strictly', TIMEOUT, () => {
  assert.equal(normalizeDuoModelRef(' faux/coder '), 'faux/coder')
  assert.equal(normalizeDuoModelRef('tier/coder'), 'tier/coder')
  assert.throws(() => normalizeDuoModelRef(''), /validation_error|provider\/model/i)
  assert.throws(() => normalizeDuoModelRef('tier/BadUpper'), /Invalid tier reference/i)

  assert.equal(normalizeDuoThinkingLevel(' high '), 'high')
  assert.equal(normalizeDuoThinkingLevel('  '), undefined)
  assert.throws(() => normalizeDuoThinkingLevel('turbo'), /Invalid executorThinkingLevel/i)

  assert.equal(normalizeMaxExecutionSteps(undefined), DUO_DEFAULT_MAX_STEPS)
  assert.equal(normalizeMaxExecutionSteps(0), 0)
  assert.equal(normalizeMaxExecutionSteps(100), 100)
  assert.throws(() => normalizeMaxExecutionSteps(-1), /between 0 and 100/)
  assert.throws(() => normalizeMaxExecutionSteps(101), /between 0 and 100/)

  assert.deepEqual(
    parseDuoInputMeta({ [DUO_INPUT_META_KEY]: { enabled: true, executorModel: ' tier/coder ', maxExecutionSteps: 12 } }),
    { present: true, valid: true, enabled: true, executorModel: 'tier/coder', maxExecutionSteps: 12 },
  )
  assert.equal(parseDuoInputMeta({ [DUO_INPUT_META_KEY]: { enabled: 'yes' } }).valid, false)

  assert.deepEqual(
    resolveDuoModelThroughTiers('tier/coder', undefined, {
      getTiers: () => ({ coder: { model: 'faux/coder', thinkingLevel: 'medium' } }),
      onChanged: () => () => {},
    }),
    { model: 'faux/coder', thinkingLevel: 'medium' },
  )

  // Client helpers
  assert.equal(isDuoEligibleConversation(makeConversationSummary({ id: 1 })), true)
  assert.equal(isDuoEligibleConversation(makeConversationSummary({ id: 2, parentConversationId: 1 })), false)
  assert.equal(isDuoEligibleConversation(makeConversationSummary({ id: 3, ownedBy: 'helmx' })), false)

  const parsedProfiles = parseDuoProfilesDoc({
    profiles: { p1: { enabled: true, executorModel: 'faux/coder', maxExecutionSteps: 15, updatedAt: 1 } },
  })
  assert.equal(parsedProfiles['p1']?.executorModel, 'faux/coder')
  assert.equal(parseDuoSessionDoc({ enabled: false, plannerModel: 'a' }), null)
  assert.equal(parseDuoSessionDoc({ enabled: true, phase: 'execution', plannerModel: 'faux/a', executorModel: 'faux/b' })?.phase, 'execution')
  assert.deepEqual(parseDuoStandbyMeta({ [DUO_PLUGIN_ID]: { enabled: true, executorModel: 'faux/b' } }), {
    enabled: true,
    executorModel: 'faux/b',
  })
  assert.equal(parseDuoTransitionPresentationMeta({ tool: 'other' }), undefined)
  assert.equal(extractFallbackTransitionInfo({ plan: 'First line\nSecond line' }), 'First line')
  assert.equal(extractFirstErrorLine('\n  Boom happened  \nmore'), 'Boom happened')
  assert.equal(validateMaxStepsInput(''), DUO_DEFAULT_MAX_STEPS)
  assert.equal(validateMaxStepsInput('150'), null)
})

test('PluginHost unit: plan.approved, pi.reset handoff preservation, grandchild default-child-model, planning tools, reconcile & stop', TIMEOUT, async () => {
  const kvStore = new MemoryKvStore()
  // Seed stranded execution record for crash recovery in reconcile() + deleted conv 999 cleanup
  kvStore.put(
    DUO_PLUGIN_ID,
    DUO_STATES_KV,
    '1',
    JSON.stringify({
      conversationId: 1,
      phase: 'execution',
      executorModel: 'faux/coder',
      maxExecutionSteps: 30,
      executionStepCount: 4,
      activeRuntimeOverride: true,
      updatedAt: Date.now(),
    } satisfies DuoRuntimeRecord),
  )
  kvStore.put(
    DUO_PLUGIN_ID,
    DUO_STATES_KV,
    '999',
    JSON.stringify({
      conversationId: 999,
      phase: 'execution',
      executorModel: 'faux/coder',
      maxExecutionSteps: 30,
      executionStepCount: 1,
      activeRuntimeOverride: true,
      updatedAt: Date.now(),
    } satisfies DuoRuntimeRecord),
  )

  const h = await openDuoUnitHost({
    kvStore,
    deferServices: true,
    conversations: [
      makeConversationSummary({ id: 1, model: 'faux/coder', status: 'idle', runtimeModelOverride: true }),
      makeConversationSummary({ id: 2, parentConversationId: 1, ownedBy: 'helmx', model: 'faux/coder' }),
      makeConversationSummary({ id: 3, parentConversationId: 2, ownedBy: 'helmx', model: 'faux/coder' }),
    ],
  })

  try {
    await h.host.start()
    await h.host.reconcile()
    // 1. reconcile() recovered stranded #1 back to planning via setConversationRuntimeModel(1, null) & dropped #999
    assert.equal(h.runtimeCalls.some((c) => c.id === 1 && c.target === null), true)
    assert.equal(kvStore.getParsed(DUO_PLUGIN_ID, DUO_STATES_KV, '999'), undefined)

    // 2. Register stub capability providers: helmx.plan-mode-active & helmx.planning-orchestration-tools
    let planningFlag = false
    await h.host.register({
      id: 'ext:test-caps',
      name: { en: 'Test Caps' },
      version: '0.1.0',
      definePlugin(ctx) {
        ctx.provide(PLAN_MODE_ACTIVE_CAPABILITY_ID, {
          isPlanning: (id: number) => id === 1 && planningFlag,
        })
        ctx.provide(PLANNING_ORCHESTRATION_TOOLS_CAPABILITY_ID, {
          toolNames: ['swarm_list_groups'],
        })
      },
    })

    // Disabled model rejected honestly in set_conversation
    await assert.rejects(
      () =>
        h.host.invokeAction(DUO_PLUGIN_ID, 'set_conversation', {
          conversationId: 1,
          enabled: true,
          executorModel: 'faux/disabled',
        }),
      (err: unknown) => err instanceof HelmxError && err.code === 'model_disabled' && err.status === 409,
    )

    // Enable Duo on #1
    await h.host.invokeAction(DUO_PLUGIN_ID, 'set_conversation', {
      conversationId: 1,
      enabled: true,
      executorModel: 'faux/coder',
      executorThinkingLevel: 'high',
    })

    // 3. Grandchild #3 walks parent chain #3 -> #2 -> #1 and resolves default child model!
    const childCap = h.host.consumeCapability<DefaultChildModelCapability>(DEFAULT_CHILD_MODEL_CAPABILITY_ID)[0]!.impl
    assert.deepEqual(childCap.resolveDefaultChildModel(3), {
      model: 'faux/coder',
      thinkingLevel: 'high',
    })

    // 4. Invalid input.meta blocks honestly
    const blocked = await h.host.runHook('input', {
      conversationId: 1,
      input: { id: 'i1', text: 'hi', origin: 'human', createdAt: 1, meta: { [DUO_INPUT_META_KEY]: { enabled: 42 } } },
    })
    assert.equal(blocked.action, 'block')

    // 5. Planning phase retains PLANNING_ORCHESTRATION_TOOLS_CAPABILITY_ID tool (`swarm_list_groups`) and strips `write`
    const tools = [makeToolSpec('read'), makeToolSpec('write'), makeToolSpec('swarm_list_groups'), makeToolSpec(DUO_EXIT_PLAN_MODE_TOOL), makeToolSpec(DUO_HAND_BACK_TOOL)]
    const planTurn = await h.host.runHook('before_turn', {
      conversation: h.conversations.get(1)!,
      inputs: [],
      tools,
      sections: [],
      messages: [],
    } satisfies BeforeTurnHookPayload)
    assert.equal(planTurn.action, 'transform')
    if (planTurn.action === 'transform') {
      assert.deepEqual(planTurn.value.tools.map((t) => t.name), ['read', 'swarm_list_groups', DUO_EXIT_PLAN_MODE_TOOL])
      assert.ok(planTurn.value.sections.some((s) => s.id === DUO_PLAN_SECTION_ID))
    }

    // 6. `/plan` active yields completely in before_turn (preserves caller tools & sections untouched)
    planningFlag = true
    const yielded = await h.host.runHook('before_turn', {
      conversation: h.conversations.get(1)!,
      inputs: [],
      tools,
      sections: [{ id: 'plan.mode', text: '<plan_mode>' }],
      messages: [],
    } satisfies BeforeTurnHookPayload)
    if (yielded.action === 'transform') {
      assert.deepEqual(
        yielded.value.tools.map((t) => t.name),
        tools.map((t) => t.name),
      )
      assert.deepEqual(yielded.value.sections, [{ id: 'plan.mode', text: '<plan_mode>' }])
    } else {
      assert.equal(yielded.action, 'continue')
    }
    planningFlag = false

    // 7. `plan.approved` with modelSwitched: false transitions to execution AND skips immediate `pi.reset` handoff!
    await h.dispatchEvent(PLAN_APPROVED_EVENT, { conversationId: 1, modelSwitched: false, filePath: 'plan-v1.md' })
    const afterPlanApprove = (await h.host.invokeAction(DUO_PLUGIN_ID, 'status', { conversationId: 1 })) as DuoSessionView
    assert.equal(afterPlanApprove.phase, 'execution')
    assert.equal(h.conversations.get(1)?.model, 'faux/coder')

    // Simulated immediate `pi.reset` from `approve_handoff` does NOT undo execution phase
    await h.dispatchEvent('conversation.entry', { type: 'conversation.entry', conversationId: 1, entry: { kind: 'pi.reset' } })
    const afterHandoffReset = (await h.host.invokeAction(DUO_PLUGIN_ID, 'status', { conversationId: 1 })) as DuoSessionView
    assert.equal(afterHandoffReset.phase, 'execution')

    // A second unrelated `pi.reset` (/clear) DOES restore back to planning
    await h.dispatchEvent('conversation.entry', { type: 'conversation.entry', conversationId: 1, entry: { kind: 'pi.reset' } })
    const afterManualReset = (await h.host.invokeAction(DUO_PLUGIN_ID, 'status', { conversationId: 1 })) as DuoSessionView
    assert.equal(afterManualReset.phase, 'planning')
    assert.equal(h.conversations.get(1)?.model, 'faux/flagship')

    // 8. Re-enter execution: active execution blocks even --force disable (liveTasks); settling restores Planner cleanly and lets dispose/disable succeed
    await h.dispatchEvent(PLAN_APPROVED_EVENT, { conversationId: 1, modelSwitched: false })
    assert.equal(h.conversations.get(1)?.model, 'faux/coder')
    await assert.rejects(
      () => h.host.disable(DUO_PLUGIN_ID, { force: true }),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_has_live_tasks' && err.status === 409,
    )
    const runtimeCallsBeforeSettle = h.runtimeCalls.length
    await h.host.runHook('turn_settled', {
      conversation: h.conversations.get(1)!,
      inputs: [],
      outcome: 'completed',
      settledAt: Date.now(),
    })
    assert.equal(h.runtimeCalls.slice(runtimeCallsBeforeSettle).some((c) => c.id === 1 && c.target === null), true)
    assert.equal(h.conversations.get(1)?.model, 'faux/flagship')
    await h.host.disable(DUO_PLUGIN_ID, { force: true })
  } finally {
    await h.close()
  }
})

test('Happy-DOM client components: DuoProfileSection, DuoMenuItem, DuoToolbarPill, and DuoTransitionToolRow render cleanly with zero Emoji', TIMEOUT, async (t) => {
  ensureHappyDom()
  const req = createRequire(new URL('../../plugin-client/package.json', import.meta.url))
  const React = req('react') as typeof import('react')
  const ReactJsxRuntime = req('react/jsx-runtime') as unknown
  const ReactDOMClient = req('react-dom/client') as {
    createRoot: (container: Element) => { render(node: import('react').ReactNode): void; unmount(): void }
  }
  const LucideReact = req('lucide-react') as unknown
  const HelmxUi = await import('@helmx/ui')
  const HelmxPluginClient = await import('@helmx/plugin-client')
  const { PluginClientContext, PluginClientHostContext } = HelmxPluginClient

  const g = globalThis as Record<string, unknown>
  g[CLIENT_SHARED_GLOBALS['react']!] = React
  g[CLIENT_SHARED_GLOBALS['react/jsx-runtime']!] = ReactJsxRuntime
  g[CLIENT_SHARED_GLOBALS['@helmx/ui']!] = HelmxUi
  g[CLIENT_SHARED_GLOBALS['@helmx/plugin-client']!] = HelmxPluginClient
  g[CLIENT_SHARED_GLOBALS['lucide-react']!] = LucideReact
  g['IS_REACT_ACT_ENVIRONMENT'] = true

  const cacheDir = await makeTempDir('helmx-duo-dom-')
  t.after(async () => {
    resetHappyDom()
    await cleanupDir(cacheDir)
  }, TIMEOUT)

  const here = dirname(fileURLToPath(import.meta.url))
  const compiled = await compilePluginClientModule(
    DUO_PLUGIN_ID,
    resolve(here, '../src/duo/client'),
    'index.tsx',
    cacheDir,
  )
  const modPath = join(cacheDir, 'duo-client.mjs')
  writeFileSync(modPath, compiled.code, 'utf8')
  const clientMod = (await import(pathToFileURL(modPath).href)) as {
    DuoProfileSection: React.ComponentType<{ profileId: string; isNew: boolean; disabled: boolean }>
    DuoMenuItem: React.ComponentType<Record<string, unknown>>
    DuoToolbarPill: React.ComponentType<Record<string, unknown>>
    DuoTransitionToolRow: React.ComponentType<Record<string, unknown>>
  }

  const conv1 = makeConversationSummary({ id: 1, model: 'faux/flagship', profileId: 'eng' })
  const convChild = makeConversationSummary({ id: 2, parentConversationId: 1, model: 'faux/coder' })
  const profilesDoc = {
    profiles: {
      eng: { enabled: true, executorModel: 'faux/coder', executorThinkingLevel: 'high', maxExecutionSteps: 30, updatedAt: 1 },
    },
  }
  const sessionView: DuoSessionView = {
    enabled: true,
    source: 'profile',
    phase: 'execution',
    plannerModel: 'faux/flagship',
    executorModel: 'faux/coder',
    executorThinkingLevel: 'high',
    maxExecutionSteps: 30,
    executionStepCount: 3,
    stepLimitPaused: false,
    hasConversationOverride: false,
    profileId: 'eng',
  }

  const modelsSlice = {
    models: [
      { id: 'faux/flagship', provider: 'faux', name: 'Flagship', available: true },
      { id: 'faux/coder', provider: 'faux', name: 'Coder', available: true },
    ],
    thinkingLevels: { 'faux/coder': ['low', 'medium', 'high'] },
    modelThinkingLevels: {},
  }
  const sessionStateConv1 = {
    value: sessionView,
    hasValue: true as const,
    deleted: false as const,
    connected: true as const,
  }
  const emptySessionState = { hasValue: false as const, deleted: false as const, connected: false as const }

  const noop = () => () => {}
  const hostPort = {
    getAuthenticated: () => false,
    subscribeAuthenticated: noop,
    getTheme: () => 'light',
    subscribePrefs: noop,
    getConversations: () => [conv1, convChild],
    subscribeConversations: noop,
    getConversationSummary: (id: number) => (id === 1 ? conv1 : convChild),
    subscribeConversationSummary: noop,
    getConversationDetail: () => undefined,
    subscribeConversationDetail: noop,
    getConversationLive: () => undefined,
    subscribeConversationLive: noop,
    getConversationPendingAsks: () => [],
    subscribeConversationPendingAsks: noop,
    getLoadError: () => undefined,
    subscribeLoadError: noop,
    getModelsSlice: () => modelsSlice,
    subscribeModels: noop,
    getPluginDocValue: (k: string) => (k === `${DUO_PLUGIN_ID}/${DUO_PROFILES_DOC}` ? profilesDoc : undefined),
    subscribePluginDoc: noop,
    ensurePluginDoc: async () => undefined,
    subscribeSessionDoc: noop,
    getSessionDocState: (key: PluginSessionDocKey) =>
      key.pluginId === DUO_PLUGIN_ID && key.docName === DUO_SESSION_DOC && key.conversationId === 1
        ? sessionStateConv1
        : emptySessionState,
    loadConversationDetail: async () => undefined,
    markdown: { view: () => null, codeBlock: () => null },
  } as unknown as PluginClientHostPort

  const ctx: PluginClientContextType = {
    pluginId: DUO_PLUGIN_ID,
    callAction: async () => ({}),
    fetchRoute: async () => new Response(null, { status: 404 }),
    submitInput: async () => {},
    openScreen: () => {},
    openSplitScreen: () => {},
    openConversationDrawer: () => {},
    openArtifact: () => {},
    openWorkbench: () => {},
    closeWorkbench: () => {},
    notify: () => {},
    getPluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    conversationId: 1,
    theme: 'light',
    locale: 'en',
    translate: (text) => (typeof text === 'string' ? text : text.en ?? ''),
  }

  const wrap = (node: import('react').ReactNode) =>
    React.createElement(
      HelmxUi.UiLocaleProvider,
      { locale: 'en' },
      React.createElement(
        PluginClientHostContext.Provider,
        { value: hostPort },
        React.createElement(PluginClientContext.Provider, { value: ctx }, node),
      ),
    )

  const mountNode = document.createElement('div')
  document.body.appendChild(mountNode)
  const root = ReactDOMClient.createRoot(mountNode)

  try {
    await React.act(async () => {
      root.render(
        wrap(
          React.createElement(
            React.Fragment,
            null,
            React.createElement(clientMod.DuoProfileSection, { profileId: 'eng', isNew: false, disabled: false }),
            React.createElement(clientMod.DuoToolbarPill, { conversation: conv1 }),
            React.createElement(clientMod.DuoToolbarPill, { conversation: convChild }),
            React.createElement(clientMod.DuoTransitionToolRow, {
              toolName: DUO_EXIT_PLAN_MODE_TOOL,
              callId: 'c1',
              status: 'done',
              durationMs: 120,
              presentationMeta: {
                tool: DUO_EXIT_PLAN_MODE_TOOL,
                fromModel: 'faux/flagship',
                toModel: 'faux/coder',
                fromPhase: 'planning',
                toPhase: 'execution',
              },
            }),
            React.createElement(clientMod.DuoTransitionToolRow, {
              toolName: DUO_HAND_BACK_TOOL,
              callId: 'c2',
              status: 'done',
              presentationMeta: {
                tool: DUO_HAND_BACK_TOOL,
                fromModel: 'faux/coder',
                toModel: 'faux/flagship',
                fromPhase: 'execution',
                toPhase: 'planning',
                reason: 'step_budget_reached',
              },
            }),
          ),
        ),
      )
    })

    const text = mountNode.textContent ?? ''
    assert.equal(EMOJI_RE.test(text), false, `UI text must contain zero Emoji: ${text}`)
    assert.match(text, /Duo Mode/)
    assert.match(text, /Exec 3\/30/)
    assert.match(text, /flagship → coder/)
    assert.match(text, /Switched to executor coder/)
    assert.match(text, /Returned to planner flagship/)

    const pills = mountNode.querySelectorAll('.duo-pill-trigger')
    assert.equal(pills.length, 1, 'child conversation must NOT render DuoToolbarPill')
    assert.ok(mountNode.querySelectorAll('.duo-trace-row').length === 2)
  } finally {
    await React.act(async () => {
      root.unmount()
    })
  }
})
