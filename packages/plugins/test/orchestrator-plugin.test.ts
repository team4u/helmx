/**
 * Unit tests for `builtin:orchestrator`:
 * - Pure contract validation (`assertOrchestratorId`, `normalizeOrchestratorName`, `normalizeOrchestratorModelRef`,
 *   `resolveOrchestratorModelThroughExternalTiers`, etc.);
 * - `PluginHost` unit coverage: item CRUD, conflict rejection (`409 model_tier_conflict`),
 *   Orchestrator->Orchestrator recursion rejection, missing external tier omission from `getTiers()`, dynamic
 *   non-cyclic external tier `onChanged` updates, `inUse()` & `remove()` reference guards,
 *   `override_executor` / `clear_override`, `plan.approved` + `pi.reset` handoff preservation,
 *   grandchild `DEFAULT_CHILD_MODEL_CAPABILITY_ID`, planning tools, `reconcile` & `stop`;
 * - Client `models.ts` + `copy.ts` helper sanity & zero-Emoji validation (interactive Happy-DOM
 *   rendering of all Orchestrator client modules runs in `packages/web/test/orchestrator-client-interactions.test.tsx`).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COMPOSER_STATUS_SLOT,
  HelmxError,
  type BeforeTurnHookPayload,
  type ConversationSummary,
  type HostModelsSlice,
  type ModelTiersCapability,
  type ModelTierSpec,
  type PluginToolSpec,
  type Profile,
} from '@helmx/protocol'
import { PluginHost, type PluginHostBackend } from '@helmx/kernel'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import {
  DEFAULT_CHILD_MODEL_CAPABILITY_ID,
  PLAN_APPROVED_EVENT,
  PLAN_MODE_ACTIVE_CAPABILITY_ID,
  PLANNING_ORCHESTRATION_TOOLS_CAPABILITY_ID,
  type DefaultChildModelCapability,
} from '../src/contracts.js'
import {
  ORCHESTRATOR_DEFAULT_MAX_STEPS,
  ORCHESTRATOR_EXIT_PLAN_MODE_TOOL,
  ORCHESTRATOR_HAND_BACK_TOOL,
  ORCHESTRATOR_PLAN_SECTION_ID,
  ORCHESTRATOR_PLUGIN_ID,
  ORCHESTRATOR_SESSION_DOC,
  createOrchestratorPlugin,
  type OrchestratorSessionView,
} from '../src/orchestrator.js'
import {
  assertOrchestratorId,
  collectExternalTierMap,
  normalizeMaxExecutionSteps,
  normalizeOrchestratorModelRef,
  normalizeOrchestratorName,
  normalizeOrchestratorThinkingLevel,
  resolveOrchestratorModelThroughExternalTiers,
} from '../src/orchestrator/contracts.js'
import { ORCHESTRATOR_COPY } from '../src/orchestrator/client/copy.ts'
import {
  createEmptyOrchestratorDraft,
  filterOrchestratorItems,
  getStarterOrchestratorPresets,
  matchOrchestratorItemFromModelRef,
  parseOrchestratorSessionDoc,
  parseOrchestratorStateDoc,
  parseOrchestratorTransitionMeta,
  synthesizeOrchestratorItems,
  validateOrchestratorDraft,
} from '../src/orchestrator/client/models.ts'
import { createPluginHostBackendFixture } from '../../kernel/test/helpers/plugin-host-backend.js'
import {
  MemoryConfigStore,
  MemoryDocStore,
  MemoryKvStore,
  cleanupDir,
  makeConversationSummary,
  makeTempDir,
} from './helpers/plugin-test-env.js'

const TIMEOUT = { timeout: 60_000 } as const
const EMOJI_RE = /\p{Extended_Pictographic}/u

function makeToolSpec(name: string): PluginToolSpec {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ output: 'ok' }),
  }
}

function openOrchestratorUnitHost(options: {
  conversations?: ConversationSummary[]
  profiles?: Profile[]
  defaultModel?: string
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
  let defaultModel = options.defaultModel

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
        { provider: 'faux', modelId: 'fast', available: true },
        { provider: 'faux', modelId: 'disabled', available: true, disabled: true },
      ],
      thinkingLevels: { 'faux/coder': ['low', 'medium', 'high'] },
      ...(defaultModel ? { defaultModel } : {}),
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
    onEvent: ((type: string, listener: (payload: unknown) => Promise<void> | void) => {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(listener)
      return () => {
        set?.delete(listener)
      }
    }) as NonNullable<PluginHostBackend['onEvent']>,
    emitEvent: () => {},
  }

  return makeTempDir('helmx-orch-unit-').then(async (dataDir) => {
    const host = new PluginHost({
      dataDir,
      host: backend,
      docs: docStore,
      kv: kvStore,
      config: new MemoryConfigStore({}),
      buildProvider: createPluginBuildProvider(),
      deferServices: options.deferServices ?? false,
    })
    await host.register(createOrchestratorPlugin())
    return {
      host,
      conversations,
      profiles,
      runtimeCalls,
      kvStore,
      docStore,
      setDefaultModel(next: string | undefined) {
        defaultModel = next
      },
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

test('pure contracts, client orchestrator helpers, and bilingual zero-Emoji copy validate strictly', TIMEOUT, () => {
  const serializedCopy = JSON.stringify(ORCHESTRATOR_COPY)
  assert.equal(EMOJI_RE.test(serializedCopy), false, 'ORCHESTRATOR_COPY must contain zero Emoji')
  assert.equal(serializedCopy.includes('配方'), false, 'ORCHESTRATOR_COPY must align to Orchestrator / 编排器')
  assert.equal(ORCHESTRATOR_COPY.screenTitle.en, 'Orchestrator')
  assert.equal(ORCHESTRATOR_COPY.screenTitle['zh-CN'], '编排器')

  assert.equal(assertOrchestratorId('architect_coder'), 'architect_coder')
  assert.throws(() => assertOrchestratorId('BadId'), HelmxError)
  assert.throws(() => assertOrchestratorId('tier/x'), HelmxError)

  assert.equal(normalizeOrchestratorName('  Arch -> Code  '), 'Arch -> Code')
  assert.throws(() => normalizeOrchestratorName('   '), HelmxError)
  assert.throws(() => normalizeOrchestratorName('x'.repeat(81)), HelmxError)

  assert.equal(normalizeOrchestratorModelRef('anthropic/claude-opus'), 'anthropic/claude-opus')
  assert.equal(normalizeOrchestratorModelRef('tier/coder'), 'tier/coder')
  assert.throws(() => normalizeOrchestratorModelRef('tier/BadUpper'), HelmxError)
  assert.throws(() => normalizeOrchestratorModelRef('no-slash'), HelmxError)
  assert.throws(() => normalizeOrchestratorThinkingLevel('bogus'), HelmxError)
  assert.equal(normalizeMaxExecutionSteps(undefined), ORCHESTRATOR_DEFAULT_MAX_STEPS)
  assert.throws(() => normalizeMaxExecutionSteps(101), HelmxError)

  const externalMap = collectExternalTierMap([
    {
      pluginId: 'builtin:tiers',
      impl: { getTiers: () => ({ coder: { model: 'faux/coder', thinkingLevel: 'low' } }) },
    },
    {
      pluginId: ORCHESTRATOR_PLUGIN_ID,
      impl: { getTiers: () => ({ ignored_self: { model: 'faux/flagship' } }) },
    },
  ])
  assert.deepEqual(Object.keys(externalMap), ['coder'])
  assert.deepEqual(
    resolveOrchestratorModelThroughExternalTiers('tier/coder', undefined, externalMap),
    { model: 'faux/coder', thinkingLevel: 'low' },
  )
  assert.equal(resolveOrchestratorModelThroughExternalTiers('tier/missing', undefined, externalMap), undefined)

  const parsedState = parseOrchestratorStateDoc({
    items: {
      r1: {
        id: 'r1',
        name: 'Arch -> Code',
        plannerModel: 'faux/flagship',
        executorModel: 'tier/coder',
        maxExecutionSteps: 12,
        updatedAt: 1,
      },
      bad: { id: 'bad' },
    },
  })
  assert.equal(Object.keys(parsedState.items).length, 1)
  assert.ok(matchOrchestratorItemFromModelRef('tier/r1', parsedState.items))
  assert.equal(matchOrchestratorItemFromModelRef('faux/flagship', parsedState.items), undefined)

  const hostModels: HostModelsSlice = {
    models: [
      { id: 'faux/flagship', provider: 'faux', modelId: 'flagship', label: 'Flagship', available: true, thinkingLevels: [] },
      { id: 'faux/coder', provider: 'faux', modelId: 'coder', label: 'Coder', available: true, thinkingLevels: ['low', 'medium', 'high'] },
    ],
    modelThinkingLevels: {},
    modelTiers: [],
  }
  const items = synthesizeOrchestratorItems(parsedState.items, hostModels)
  assert.equal(filterOrchestratorItems(items, 'arch').length, 1)
  assert.equal(filterOrchestratorItems(items, 'nomatch').length, 0)
  assert.ok(getStarterOrchestratorPresets('en', hostModels).length >= 2)

  const draft = createEmptyOrchestratorDraft()
  assert.equal(
    validateOrchestratorDraft(
      { ...draft, id: 'coder', name: 'Conflict', plannerModel: 'faux/flagship', executorModel: 'faux/coder' },
      { mode: 'create', existingItemIds: new Set(['r1']), externalTierIds: new Set(['coder']) },
    ),
    'id_conflict',
  )
  assert.equal(
    validateOrchestratorDraft(
      { ...draft, id: 'r2', name: 'Nested', plannerModel: 'tier/r1', executorModel: 'faux/coder' },
      { mode: 'create', existingItemIds: new Set(['r1']), externalTierIds: new Set(['coder']) },
    ),
    'planner_orchestrator_ref',
  )
  assert.equal(
    validateOrchestratorDraft(
      { ...draft, id: 'r2', name: 'Self', plannerModel: 'faux/flagship', executorModel: 'tier/r2' },
      { mode: 'create', existingItemIds: new Set(['r1']), externalTierIds: new Set(['coder']) },
    ),
    'executor_orchestrator_ref',
  )

  const parsedSession = parseOrchestratorSessionDoc({
    enabled: true,
    orchestratorId: 'r1',
    orchestratorName: 'Arch -> Code',
    phase: 'planning',
    plannerModel: 'faux/flagship',
    executorModel: 'faux/coder',
    maxExecutionSteps: 10,
    executionStepCount: 0,
    stepLimitPaused: false,
    hasExecutorOverride: true,
  })
  assert.equal(parsedSession?.orchestratorId, 'r1')
  assert.equal(parsedSession?.hasExecutorOverride, true)

  const meta = parseOrchestratorTransitionMeta({
    tool: ORCHESTRATOR_EXIT_PLAN_MODE_TOOL,
    fromModel: 'faux/flagship',
    toModel: 'faux/coder',
    fromPhase: 'planning',
    toPhase: 'execution',
  })
  assert.equal(meta?.toModel, 'faux/coder')
})

test('PluginHost unit: orchestrator capability mounting, external tier delta cascade without loops, override & crash recovery', TIMEOUT, async () => {
  const env = await openOrchestratorUnitHost()
  try {
    const statusSlot = env.host
      .listUi()
      .find(
        (u) =>
          u.pluginId === ORCHESTRATOR_PLUGIN_ID &&
          u.surface === 'plugin.slot' &&
          (u.spec as { id?: string }).id === 'orchestrator-status-pill',
      )
    assert.ok(statusSlot, 'orchestrator-status-pill must be registered on PluginHost')
    const statusSpec = statusSlot.spec as { target?: string; order?: number }
    assert.equal(statusSpec.target, COMPOSER_STATUS_SLOT)
    assert.equal(statusSpec.order, 15, 'orchestrator-status-pill must register with order 15 (> token-speed 10, < magpie 20)')

    let externalTiers: Record<string, ModelTierSpec> = {
      coder: { model: 'faux/coder', thinkingLevel: 'low' },
    }
    const externalListeners = new Set<() => void>()
    const externalProviderPlugin = {
      id: 'test:tiers',
      name: 'Test Tiers',
      definePlugin(ctx: { provide<T>(id: string, impl: T): () => void }) {
        ctx.provide<ModelTiersCapability>('helmx.model-tiers', {
          getTiers: () => externalTiers,
          onChanged: (listener) => {
            externalListeners.add(listener)
            return () => externalListeners.delete(listener)
          },
        })
      },
    }
    await env.host.register(externalProviderPlugin)

    await assert.rejects(
      () =>
        env.host.invokeAction(ORCHESTRATOR_PLUGIN_ID, 'set', {
          id: 'coder',
          name: 'Conflict',
          plannerModel: 'faux/flagship',
          executorModel: 'faux/fast',
        }),
      (err: unknown) => err instanceof HelmxError && err.code === 'model_tier_conflict' && err.status === 409,
    )

    await env.host.invokeAction(ORCHESTRATOR_PLUGIN_ID, 'set', {
      id: 'arch_code',
      name: 'Architect & Coder',
      description: 'Plan deeply then execute swiftly',
      plannerModel: 'faux/flagship',
      executorModel: 'tier/coder',
      maxExecutionSteps: 5,
    })

    await assert.rejects(
      () =>
        env.host.invokeAction(ORCHESTRATOR_PLUGIN_ID, 'set', {
          id: 'nested',
          name: 'Nested',
          plannerModel: 'tier/arch_code',
          executorModel: 'faux/fast',
        }),
      (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
    )

    const orchCap = env.host
      .consumeCapability<ModelTiersCapability>('helmx.model-tiers')
      .find((c) => c.pluginId === ORCHESTRATOR_PLUGIN_ID)?.impl
    assert.ok(orchCap)
    let orchChangeCount = 0
    const unsubOrch = orchCap.onChanged!(() => {
      orchChangeCount += 1
    })

    const mounted = orchCap.getTiers()
    assert.ok(mounted['arch_code'])
    assert.equal(mounted['arch_code']!.model, 'faux/flagship')
    assert.equal(mounted['arch_code']!.displayGroup, 'orchestrator')
    assert.equal(mounted['arch_code']!.displayLabel, 'Architect & Coder')
    assert.equal(mounted['arch_code']!.displayDetail, 'flagship → coder')
    assert.equal(mounted['arch_code']!.preserveRef, true)
    assert.equal(mounted['arch_code']!.singleTurnEligible, false)

    await env.host.invokeAction(ORCHESTRATOR_PLUGIN_ID, 'set', {
      id: 'ext_planner',
      name: 'External Planner',
      plannerModel: 'tier/future_arch',
      executorModel: 'tier/coder',
    })
    assert.equal(orchCap.getTiers()['ext_planner'], undefined, 'unresolved external Planner must be omitted from getTiers()')

    const beforeCascadeCount = orchChangeCount
    for (const fn of externalListeners) fn()
    assert.equal(orchChangeCount, beforeCascadeCount)

    externalTiers = {
      ...externalTiers,
      future_arch: { model: 'faux/flagship', thinkingLevel: 'high' },
    }
    for (const fn of externalListeners) fn()
    assert.equal(orchChangeCount, beforeCascadeCount + 1)
    assert.equal(orchCap.getTiers()['ext_planner']?.model, 'faux/flagship')
    assert.equal(orchCap.getTiers()['ext_planner']?.thinkingLevel, 'high')
    if (typeof unsubOrch === 'function') unsubOrch()

    const conv1 = makeConversationSummary({
      id: 1,
      model: 'faux/flagship',
      modelOverride: 'tier/arch_code',
      effectiveModelRef: 'tier/arch_code',
    })
    env.conversations.set(1, conv1)
    await env.dispatchEvent('conversation.upsert', { type: 'conversation.upsert', conversation: conv1 })

    const status1 = (await env.host.invokeAction(ORCHESTRATOR_PLUGIN_ID, 'status', {
      conversationId: 1,
    })) as OrchestratorSessionView
    assert.equal(status1.orchestratorId, 'arch_code')
    assert.equal(status1.executorModel, 'faux/coder')
    assert.equal(status1.hasExecutorOverride, false)

    const overridden = (await env.host.invokeAction(ORCHESTRATOR_PLUGIN_ID, 'override_executor', {
      conversationId: 1,
      executorModel: 'faux/fast',
      executorThinkingLevel: 'medium',
      maxExecutionSteps: 8,
    })) as OrchestratorSessionView
    assert.equal(overridden.executorModel, 'faux/fast')
    assert.equal(overridden.hasExecutorOverride, true)

    await env.dispatchEvent(PLAN_APPROVED_EVENT, {
      conversationId: 1,
      modelSwitched: false,
      filePath: '/repo/plan.md',
    })
    assert.equal(env.runtimeCalls.at(-1)?.target?.model, 'faux/fast')
    assert.equal(
      (env.host.getPublicSessionDoc(ORCHESTRATOR_PLUGIN_ID, ORCHESTRATOR_SESSION_DOC, 1).value as OrchestratorSessionView | null)?.phase,
      'execution',
    )

    await env.dispatchEvent('pi.reset', { type: 'pi.reset', conversationId: 1 })
    assert.equal(
      (env.host.getPublicSessionDoc(ORCHESTRATOR_PLUGIN_ID, ORCHESTRATOR_SESSION_DOC, 1).value as OrchestratorSessionView | null)?.phase,
      'execution',
    )
    await env.dispatchEvent('pi.reset', { type: 'pi.reset', conversationId: 1 })
    assert.equal(
      (env.host.getPublicSessionDoc(ORCHESTRATOR_PLUGIN_ID, ORCHESTRATOR_SESSION_DOC, 1).value as OrchestratorSessionView | null)?.phase,
      'planning',
    )

    await assert.rejects(
      () => env.host.invokeAction(ORCHESTRATOR_PLUGIN_ID, 'remove', { id: 'arch_code' }),
      (err: unknown) => err instanceof HelmxError && err.code === 'model_tier_in_use' && err.status === 409,
    )
    const clearedConv = makeConversationSummary({ id: 1, model: 'faux/flagship' })
    env.conversations.set(1, clearedConv)
    await env.dispatchEvent('conversation.upsert', { type: 'conversation.upsert', conversation: clearedConv })
    assert.equal(env.host.getPublicSessionDoc(ORCHESTRATOR_PLUGIN_ID, ORCHESTRATOR_SESSION_DOC, 1).value, null)
    const afterSwitchStatus = await env.host.invokeAction(ORCHESTRATOR_PLUGIN_ID, 'status', { conversationId: 1 })
    assert.equal(afterSwitchStatus, null)

    env.setDefaultModel('tier/arch_code')
    await assert.rejects(
      () => env.host.invokeAction(ORCHESTRATOR_PLUGIN_ID, 'remove', { id: 'arch_code' }),
      (err: unknown) => err instanceof HelmxError && err.status === 409,
    )
    env.setDefaultModel(undefined)
    const removed = (await env.host.invokeAction(ORCHESTRATOR_PLUGIN_ID, 'remove', { id: 'arch_code' })) as { removed: boolean }
    assert.equal(removed.removed, true)

    await env.host.invokeAction(ORCHESTRATOR_PLUGIN_ID, 'set', {
      id: 'tree_pair',
      name: 'Tree Pair',
      plannerModel: 'faux/flagship',
      executorModel: 'faux/coder',
    })
    env.conversations.set(10, makeConversationSummary({ id: 10, model: 'faux/flagship', effectiveModelRef: 'tier/tree_pair' }))
    env.conversations.set(11, makeConversationSummary({ id: 11, parentConversationId: 10, ownedBy: 'helmx', model: 'faux/coder' }))
    env.conversations.set(12, makeConversationSummary({ id: 12, parentConversationId: 11, ownedBy: 'helmx', model: 'faux/coder' }))

    const childCap = env.host.consumeCapability<DefaultChildModelCapability>(DEFAULT_CHILD_MODEL_CAPABILITY_ID)[0]?.impl
    assert.deepEqual(childCap?.resolveDefaultChildModel(12), { model: 'faux/coder' })

    await env.host.register({
      id: 'test:orch',
      name: 'Test Orch',
      definePlugin(ctx) {
        ctx.provide(PLANNING_ORCHESTRATION_TOOLS_CAPABILITY_ID, {
          toolNames: ['subagent', 'SubagentWorkflow'],
        })
      },
    })
    const turn = await env.host.runHook('before_turn', {
      conversation: env.conversations.get(10)!,
      inputs: [],
      tools: [
        makeToolSpec('read'),
        makeToolSpec('edit'),
        makeToolSpec('subagent'),
        makeToolSpec('SubagentWorkflow'),
        makeToolSpec(ORCHESTRATOR_EXIT_PLAN_MODE_TOOL),
        makeToolSpec(ORCHESTRATOR_HAND_BACK_TOOL),
      ],
      sections: [],
      messages: [],
    } satisfies BeforeTurnHookPayload)
    assert.equal(turn.action, 'transform')
    if (turn.action === 'transform') {
      const names = turn.value.tools.map((t) => t.name)
      assert.ok(names.includes('subagent') && names.includes('SubagentWorkflow'))
      assert.ok(names.includes(ORCHESTRATOR_EXIT_PLAN_MODE_TOOL))
      assert.equal(names.includes('edit'), false)
      assert.ok(turn.value.sections.some((s) => s.id === ORCHESTRATOR_PLAN_SECTION_ID))
    }
    await env.host.disable('test:orch', { force: true })
    void PLAN_MODE_ACTIVE_CAPABILITY_ID
  } finally {
    await env.close()
  }
})

test('PluginHost crash recovery: reconcile clears stranded runtime override from previous run', TIMEOUT, async () => {
  const kvStore = new MemoryKvStore()
  kvStore.put(
    ORCHESTRATOR_PLUGIN_ID,
    'items',
    'r1',
    JSON.stringify({
      id: 'r1',
      name: 'Recovery Pair',
      plannerModel: 'faux/flagship',
      executorModel: 'faux/coder',
      maxExecutionSteps: 5,
      updatedAt: 1,
    }),
  )
  kvStore.put(
    ORCHESTRATOR_PLUGIN_ID,
    'states',
    '1',
    JSON.stringify({
      conversationId: 1,
      orchestratorId: 'r1',
      phase: 'execution',
      executorModel: 'faux/coder',
      maxExecutionSteps: 5,
      executionStepCount: 2,
      activeRuntimeOverride: true,
      updatedAt: 1,
    }),
  )

  const env = await openOrchestratorUnitHost({
    kvStore,
    conversations: [
      makeConversationSummary({
        id: 1,
        status: 'idle',
        model: 'faux/coder',
        modelOverride: 'tier/r1',
        effectiveModelRef: 'tier/r1',
        runtimeModelOverride: true,
      }),
    ],
    deferServices: true,
  })
  try {
    await env.host.start()
    await env.host.reconcile()
    assert.equal(env.runtimeCalls.at(-1)?.target, null)
    assert.equal(
      (env.host.getPublicSessionDoc(ORCHESTRATOR_PLUGIN_ID, ORCHESTRATOR_SESSION_DOC, 1).value as OrchestratorSessionView | null)?.phase,
      'planning',
    )
    await env.host.dispose()
    assert.equal(env.kvStore.get(ORCHESTRATOR_PLUGIN_ID, 'states', '1'), undefined)
  } finally {
    await env.close()
  }
})
