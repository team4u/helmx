// @test-isolation: process
/**
 * Integration tests for `builtin:duo` Orchestrator on full Helmx Kernel (`createHelmx`):
 * - Default enabled, managed `duo` skill, modular client bundles, `singleTurnEligible: false` filtering;
 * - Orchestrator CRUD (`set`/`list`/`get`/`remove`) mounted as `tier/<id>` in `ModelCatalog.modelTiers`;
 * - Top-level conversation choosing `tier/<id>` directly or via Profile:
 *   Planning Phase (read-only + `exit_plan_mode`) -> Execution Phase (budget `step 1 of 2` -> pause) ->
 *   `hand_back_to_planner` & `turn_settled` Planner restore;
 * - `builtin:tiers` template lockstep update propagates to active Orchestrators + sessionDocs;
 * - Temporary per-conversation `override_executor` / `clear_override` + cleanup on orchestrator switch;
 * - `/plan` interop & `plan.approved` (`approve_handoff` without & with `executionModel`);
 * - Subagent / Swarm inheritance (`agentType` Profile with Orchestrator + parent tree) & `swarm-coordinator` suppression;
 * - Reference protection (`remove` & `disable` 409 unless `force: true`), runtime cleanup, delete cleanup.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  HelmxError,
  type ModelTiersCapability,
} from '@helmx/protocol'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import { createHelmx } from '../../hub/src/app.js'
import {
  DEFAULT_CHILD_MODEL_CAPABILITY_ID,
  type DefaultChildModelCapability,
} from '../src/contracts.js'
import {
  DUO_EXECUTE_SECTION_ID,
  DUO_EXIT_PLAN_MODE_TOOL,
  DUO_HAND_BACK_TOOL,
  DUO_PLAN_SECTION_ID,
  DUO_PLUGIN_ID,
  DUO_SESSION_DOC,
  DUO_SKILL_ID,
  DUO_STATE_DOC,
  DUO_STEP_LIMIT_SECTION_ID,
  type DuoRecipeView,
  type DuoSessionView,
  type DuoStateDocSnapshot,
} from '../src/duo.js'
import { PLAN_MODE_SECTION_ID, PLAN_TOOL_PROPOSE, PLAN_TOOL_SAVE } from '../src/plan.js'
import { TIERS_PLUGIN_ID } from '../src/tiers.js'
import { renderModelTiersCatalogSection } from '../src/tiers/validation.js'
import { TITLE_PLUGIN_ID } from '../src/title.js'
import {
  cleanupDir,
  makeFauxProvider,
  makeTempDir,
  waitFor,
} from './helpers/plugin-test-env.js'

const TIMEOUT = { timeout: 60_000 } as const

async function openDuoEnv(options: { defaultModel?: string } = {}) {
  const dataDir = await makeTempDir('helmx-duo-it-')
  const faux = makeFauxProvider({
    models: [
      { id: 'fast', name: 'Fast', reasoning: true },
      { id: 'coder', name: 'Coder', reasoning: true },
      { id: 'flagship', name: 'Flagship', reasoning: true },
      { id: 'flagship-v2', name: 'Flagship v2', reasoning: true },
      { id: 'coder-v2', name: 'Coder v2', reasoning: true },
    ],
  })
  const app = await createHelmx({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    cwd: dataDir,
    model: options.defaultModel ?? 'faux/flagship',
    providers: [faux.provider],
  })
  await app.kernel.plugins.setConfig(TITLE_PLUGIN_ID, { autoTitle: false })
  return {
    dataDir,
    faux,
    app,
    async close() {
      await app.close().catch(() => {})
      await cleanupDir(dataDir)
    },
  }
}

interface ObservedStep {
  modelId: string
  toolNames: string[]
  sectionsById: Record<string, string | null>
}

function captureStep(
  sink: ObservedStep[],
  reply: ReturnType<typeof fauxAssistantMessage>,
): FauxResponseStep {
  return (ctx, _opts, _state, model) => {
    const sectionsById: Record<string, string | null> = {}
    for (const msg of ctx.messages as unknown as Array<Record<string, unknown>>) {
      if (msg['role'] !== 'system') continue
      const sections = msg['sections'] as Record<string, string | null> | undefined
      if (sections === undefined) continue
      for (const [k, v] of Object.entries(sections)) {
        sectionsById[k] = v
      }
    }
    const toolNames = getCurrentTools(ctx.messages as never).map((t) => t.name)
    sink.push({
      modelId: `${model.provider}/${model.id}`,
      toolNames,
      sectionsById,
    })
    return reply
  }
}

test('registration, modular client bundles, catalog filtering, and recipe-driven dual-phase loop with budget pause', TIMEOUT, async () => {
  const env = await openDuoEnv()
  try {
    const { kernel } = env.app
    const summary = kernel.plugins.list().find((p) => p.id === DUO_PLUGIN_ID)
    assert.ok(summary && summary.enabled)
    const skills = await kernel.skills.list()
    assert.ok(skills.some((s) => s.id === DUO_SKILL_ID && s.managedByPlugin === DUO_PLUGIN_ID))

    const indexMod = await kernel.plugins.getClientModule(DUO_PLUGIN_ID, 'index.tsx')
    assert.match(indexMod.code, /DuoToolbarPill/)
    assert.match(indexMod.code, /DuoTransitionToolRow/)
    const managerMod = await kernel.plugins.getClientModule(DUO_PLUGIN_ID, 'manager.tsx')
    assert.match(managerMod.code, /DuoManagerScreen/)
    assert.doesNotMatch(managerMod.code, /DuoSettingsPanel/)
    const settingsMod = await kernel.plugins.getClientModule(DUO_PLUGIN_ID, 'settings.tsx')
    assert.match(settingsMod.code, /DuoSettingsPanel/)
    assert.doesNotMatch(settingsMod.code, /DuoManagerScreen/)

    const initialState = kernel.plugins.getPublicDoc(DUO_PLUGIN_ID, DUO_STATE_DOC).value as DuoStateDocSnapshot
    assert.deepEqual(initialState, { recipes: {} })

    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'scout',
      model: 'faux/fast',
      description: 'Quick lookup',
    })
    await kernel.plugins.invokeAction(DUO_PLUGIN_ID, 'set', {
      id: 'arch_coder',
      name: 'Arch -> Coder',
      description: 'Read-only architect paired with coder',
      plannerModel: 'faux/flagship',
      executorModel: 'faux/coder',
      executorThinkingLevel: 'high',
      maxExecutionSteps: 2,
    })

    const catalog = await kernel.models.listModels()
    const duoEntry = catalog.modelTiers?.find((t) => t.id === 'arch_coder')
    assert.ok(duoEntry, 'Orchestrator must be mounted in ModelCatalog.modelTiers')
    assert.equal(duoEntry.displayGroup, 'duo')
    assert.equal(duoEntry.displayLabel, 'Arch -> Coder')
    assert.equal(duoEntry.displayDetail, 'flagship → coder')
    assert.equal(duoEntry.preserveRef, true)
    assert.equal(duoEntry.singleTurnEligible, false)

    const renderedTiers = renderModelTiersCatalogSection(catalog.modelTiers ?? [])
    assert.ok(renderedTiers?.includes('tier/scout'))
    assert.equal(renderedTiers?.includes('tier/arch_coder'), false)

    const conv = await kernel.conversations.createConversation({
      title: 'Recipe Conv',
      model: 'tier/arch_coder',
    })
    assert.equal(conv.effectiveModelRef, 'tier/arch_coder')
    assert.equal(conv.model, 'faux/flagship')

    const observed: ObservedStep[] = []
    env.faux.setResponses([
      captureStep(
        observed,
        fauxAssistantMessage([fauxToolCall(DUO_EXIT_PLAN_MODE_TOOL, { plan: 'Edit readme cleanly.' })], {
          stopReason: 'toolUse',
        }),
      ),
      captureStep(
        observed,
        fauxAssistantMessage([fauxToolCall('read', { path: 'missing.txt' })], { stopReason: 'toolUse' }),
      ),
      captureStep(
        observed,
        fauxAssistantMessage([fauxToolCall('read', { path: 'missing2.txt' })], { stopReason: 'toolUse' }),
      ),
      captureStep(
        observed,
        fauxAssistantMessage(
          [
            fauxToolCall(DUO_HAND_BACK_TOOL, {
              reason: 'step_budget_reached',
              summary: 'Checked files and paused at limit.',
            }),
          ],
          { stopReason: 'toolUse' },
        ),
      ),
      captureStep(observed, fauxAssistantMessage('Back on Planner cleanly.')),
    ])

    await kernel.conversations.submitInput(conv.id, 'Plan and edit')
    await kernel.conversations.waitForIdle(conv.id)

    assert.equal(observed.length, 5)
    assert.equal(observed[0]!.modelId, 'faux/flagship')
    assert.ok(observed[0]!.toolNames.includes(DUO_EXIT_PLAN_MODE_TOOL))
    assert.equal(observed[0]!.toolNames.includes('write'), false)
    assert.ok(typeof observed[0]!.sectionsById[DUO_PLAN_SECTION_ID] === 'string')

    assert.equal(observed[1]!.modelId, 'faux/coder')
    assert.ok(observed[1]!.toolNames.includes('write'))
    assert.ok(observed[1]!.sectionsById[DUO_EXECUTE_SECTION_ID]?.includes('step 1 of 2'))
    assert.equal(observed[2]!.modelId, 'faux/coder')
    assert.ok(observed[2]!.sectionsById[DUO_EXECUTE_SECTION_ID]?.includes('step 2 of 2'))

    assert.equal(observed[3]!.modelId, 'faux/coder')
    assert.deepEqual(observed[3]!.toolNames, [DUO_HAND_BACK_TOOL])
    assert.ok(typeof observed[3]!.sectionsById[DUO_STEP_LIMIT_SECTION_ID] === 'string')

    assert.equal(observed[4]!.modelId, 'faux/flagship')
    assert.ok(observed[4]!.toolNames.includes(DUO_EXIT_PLAN_MODE_TOOL))
    assert.equal(kernel.conversations.getConversation(conv.id).model, 'faux/flagship')

    const status = (await kernel.plugins.invokeAction(DUO_PLUGIN_ID, 'status', {
      conversationId: conv.id,
    })) as DuoSessionView
    assert.equal(status.phase, 'planning')
    assert.equal(status.recipeId, 'arch_coder')
  } finally {
    await env.close()
  }
})

test('Profile binding, builtin:tiers preset cascade, override_executor & stale override cleanup on recipe switch', TIMEOUT, async () => {
  const env = await openDuoEnv()
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'architect',
      model: 'faux/flagship',
      thinkingLevel: 'high',
    })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'coder',
      model: 'faux/coder',
      thinkingLevel: 'medium',
    })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'save_template', {
      id: 'v1',
      name: 'V1',
    })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'replace', {
      tiers: {
        architect: { model: 'faux/flagship-v2', thinkingLevel: 'high' },
        coder: { model: 'faux/coder-v2', thinkingLevel: 'low' },
      },
    })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'save_template', {
      id: 'v2',
      name: 'V2',
    })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'apply_template', { id: 'v1' })

    await kernel.plugins.invokeAction(DUO_PLUGIN_ID, 'set', {
      id: 'team_duo',
      name: 'Team Duo',
      plannerModel: 'tier/architect',
      executorModel: 'tier/coder',
    })
    await kernel.profiles.save({
      id: 'architect-role',
      name: 'Architect Role',
      model: 'tier/team_duo',
      system: 'Plan and implement.',
    })

    const conv = await kernel.conversations.createConversation({
      title: 'Profile Recipe Conv',
      profileId: 'architect-role',
    })
    assert.equal(conv.effectiveModelRef, 'tier/team_duo')
    assert.equal(conv.model, 'faux/flagship')

    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'apply_template', { id: 'v2' })
    await waitFor(
      () => kernel.conversations.getConversation(conv.id).model === 'faux/flagship-v2',
      { message: 'planner upgraded via tiers template' },
    )
    const upgradedView = (await kernel.plugins.invokeAction(DUO_PLUGIN_ID, 'get', {
      id: 'team_duo',
    })) as DuoRecipeView
    assert.equal(upgradedView.resolvedPlannerModel, 'faux/flagship-v2')
    assert.equal(upgradedView.resolvedExecutorModel, 'faux/coder-v2')

    const statusBeforeOverride = kernel.plugins.getPublicSessionDoc(DUO_PLUGIN_ID, DUO_SESSION_DOC, conv.id)
      .value as DuoSessionView
    assert.equal(statusBeforeOverride.executorModel, 'faux/coder-v2')
    assert.equal(statusBeforeOverride.hasExecutorOverride, false)

    const overridden = (await kernel.plugins.invokeAction(DUO_PLUGIN_ID, 'override_executor', {
      conversationId: conv.id,
      executorModel: 'faux/fast',
      maxExecutionSteps: 7,
    })) as DuoSessionView
    assert.equal(overridden.executorModel, 'faux/fast')
    assert.equal(overridden.hasExecutorOverride, true)

    await kernel.conversations.updateConversation(conv.id, { model: 'faux/fast' })
    await waitFor(
      () => kernel.plugins.getPublicSessionDoc(DUO_PLUGIN_ID, DUO_SESSION_DOC, conv.id).value === null,
      { message: 'sessionDoc cleared after leaving Orchestrator' },
    )

    await kernel.conversations.updateConversation(conv.id, { model: '' })
    await waitFor(
      () =>
        (
          kernel.plugins.getPublicSessionDoc(DUO_PLUGIN_ID, DUO_SESSION_DOC, conv.id)
            .value as DuoSessionView | null
        )?.recipeId === 'team_duo',
      { message: 'sessionDoc restored when returning to recipe' },
    )
    const afterReturn = kernel.plugins.getPublicSessionDoc(DUO_PLUGIN_ID, DUO_SESSION_DOC, conv.id)
      .value as DuoSessionView
    assert.equal(afterReturn.hasExecutorOverride, false)
    assert.equal(afterReturn.executorModel, 'faux/coder-v2')
  } finally {
    await env.close()
  }
})

test('/plan interop: /plan yields during planning, plan.approved bridges into Duo execution (modelSwitched false & true)', TIMEOUT, async () => {
  const env = await openDuoEnv()
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(DUO_PLUGIN_ID, 'set', {
      id: 'plan_pair',
      name: 'Plan Pair',
      plannerModel: 'faux/flagship',
      executorModel: 'faux/coder',
    })
    const conv = await kernel.conversations.createConversation({
      title: '/plan + duo',
      model: 'tier/plan_pair',
    })

    const obs: ObservedStep[] = []
    env.faux.setResponses([
      captureStep(
        obs,
        fauxAssistantMessage([fauxToolCall(PLAN_TOOL_SAVE, { title: 'Test Plan', markdown: '# Plan' })], {
          stopReason: 'toolUse',
        }),
      ),
      captureStep(
        obs,
        fauxAssistantMessage([fauxToolCall(PLAN_TOOL_PROPOSE, { summary: 'Propose Test Plan' })], {
          stopReason: 'toolUse',
        }),
      ),
      captureStep(obs, fauxAssistantMessage('Executed approved plan on coder.')),
    ])

    await kernel.conversations.submitInput(conv.id, '/plan design carefully')
    await waitFor(
      () => kernel.asks.listAsks('pending').some((a) => a.conversationId === conv.id),
      { message: 'pending plan approval ask' },
    )
    const askDoc = kernel.asks.listAsks('pending').find((a) => a.conversationId === conv.id)!
    assert.ok(obs[0]!.sectionsById[PLAN_MODE_SECTION_ID] !== undefined)
    assert.equal(obs[0]!.sectionsById[DUO_PLAN_SECTION_ID], undefined)

    await kernel.asks.answerAsk(
      askDoc.id,
      { decision: 'approve_handoff' },
      askDoc.expectedStateSeq,
    )
    await kernel.conversations.waitForIdle(conv.id)
    assert.equal(obs.length, 3)
    assert.equal(obs[2]!.modelId, 'faux/coder')
    assert.ok(obs[2]!.sectionsById[DUO_EXECUTE_SECTION_ID] !== undefined)

    const obs2: ObservedStep[] = []
    env.faux.setResponses([
      captureStep(
        obs2,
        fauxAssistantMessage([fauxToolCall(PLAN_TOOL_SAVE, { title: 'Test Plan 2', markdown: '# Plan 2' })], {
          stopReason: 'toolUse',
        }),
      ),
      captureStep(
        obs2,
        fauxAssistantMessage([fauxToolCall(PLAN_TOOL_PROPOSE, { summary: 'Propose Test Plan 2' })], {
          stopReason: 'toolUse',
        }),
      ),
      captureStep(obs2, fauxAssistantMessage('Executed on user chosen fast model.')),
    ])
    await kernel.conversations.submitInput(conv.id, '/plan design 2')
    await waitFor(
      () => kernel.asks.listAsks('pending').some((a) => a.conversationId === conv.id),
      { message: 'second pending plan ask' },
    )
    const askDoc2 = kernel.asks.listAsks('pending').find((a) => a.conversationId === conv.id)!
    await kernel.asks.answerAsk(
      askDoc2.id,
      { decision: 'approve_handoff', executionModel: 'faux/fast' },
      askDoc2.expectedStateSeq,
    )
    await kernel.conversations.waitForIdle(conv.id)
    assert.equal(obs2.length, 3)
    assert.equal(obs2[2]!.modelId, 'faux/fast')
    assert.ok(obs2[2]!.sectionsById[DUO_EXECUTE_SECTION_ID] !== undefined)
    await waitFor(() => kernel.conversations.getConversation(conv.id).model === 'faux/flagship', {
      message: 'planner restored after turn',
    })
  } finally {
    await env.close()
  }
})

test('subagent/Profile Duo unwrapping and swarm-coordinator posture suppression', TIMEOUT, async () => {
  const env = await openDuoEnv()
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(DUO_PLUGIN_ID, 'set', {
      id: 'sub_pair',
      name: 'Sub Pair',
      plannerModel: 'faux/flagship',
      executorModel: 'faux/coder',
      executorThinkingLevel: 'medium',
    })
    await kernel.profiles.save({
      id: 'duo-coder',
      name: 'Duo Coder Profile',
      model: 'tier/sub_pair',
    })

    const parent = await kernel.conversations.createConversation({
      title: 'Parent Duo',
      model: 'tier/sub_pair',
    })

    const defaultChildCap = kernel.plugins
      .consumeCapability<DefaultChildModelCapability>(DEFAULT_CHILD_MODEL_CAPABILITY_ID)
      .find((c) => c.pluginId === DUO_PLUGIN_ID)?.impl
    assert.deepEqual(defaultChildCap?.resolveDefaultChildModel(parent.id), {
      model: 'faux/coder',
      thinkingLevel: 'medium',
    })

    const plainParent = await kernel.conversations.createConversation({
      title: 'Plain Parent',
      model: 'faux/flagship',
    })
    const obsChild: ObservedStep[] = []
    env.faux.setResponses([
      captureStep(
        obsChild,
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: 'do work', agentType: 'duo-coder' })], {
          stopReason: 'toolUse',
        }),
      ),
      captureStep(obsChild, fauxAssistantMessage('Child done on executor.')),
      captureStep(obsChild, fauxAssistantMessage('Parent done.')),
    ])
    await kernel.conversations.submitInput(plainParent.id, 'delegate')
    await kernel.conversations.waitForIdle(plainParent.id)
    assert.equal(obsChild.length, 3)
    assert.equal(obsChild[1]!.modelId, 'faux/coder')
    assert.equal(obsChild[1]!.sectionsById[DUO_PLAN_SECTION_ID], undefined)

    await kernel.conversations.updateConversation(parent.id, { tags: ['swarm-coordinator'] })
    const obsCoord: ObservedStep[] = []
    env.faux.setResponses([captureStep(obsCoord, fauxAssistantMessage('Coordinating directly.'))])
    await kernel.conversations.submitInput(parent.id, 'coordinate')
    await kernel.conversations.waitForIdle(parent.id)
    assert.equal(obsCoord.length, 1)
    assert.equal(obsCoord[0]!.sectionsById[DUO_PLAN_SECTION_ID], undefined)
    assert.equal(obsCoord[0]!.sectionsById[DUO_EXECUTE_SECTION_ID], undefined)
    assert.equal(obsCoord[0]!.toolNames.includes(DUO_EXIT_PLAN_MODE_TOOL), false)
    const coordView = kernel.plugins.getPublicSessionDoc(DUO_PLUGIN_ID, DUO_SESSION_DOC, parent.id)
      .value as DuoSessionView
    assert.equal(coordView.suppressedByCoordinator, true)
    assert.deepEqual(defaultChildCap?.resolveDefaultChildModel(parent.id), {
      model: 'faux/coder',
      thinkingLevel: 'medium',
    })
  } finally {
    await env.close()
  }
})

test('lifecycle safety: reference protection on remove & disable unless --force, and runtime restore', TIMEOUT, async () => {
  const env = await openDuoEnv()
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(DUO_PLUGIN_ID, 'set', {
      id: 'life_pair',
      name: 'Life Pair',
      plannerModel: 'faux/flagship',
      executorModel: 'faux/coder',
    })
    const conv = await kernel.conversations.createConversation({
      title: 'Lifecycle Duo',
      model: 'tier/life_pair',
    })

    await assert.rejects(
      () => kernel.plugins.invokeAction(DUO_PLUGIN_ID, 'remove', { id: 'life_pair' }),
      (err: unknown) => err instanceof HelmxError && err.code === 'model_tier_in_use' && err.status === 409,
    )

    await assert.rejects(
      () => kernel.plugins.disable(DUO_PLUGIN_ID),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_in_use' && err.status === 409,
    )

    await kernel.plugins.disable(DUO_PLUGIN_ID, { force: true })
    assert.equal(
      kernel.plugins
        .consumeCapability<ModelTiersCapability>('helmx.model-tiers')
        .some((c) => c.pluginId === DUO_PLUGIN_ID),
      false,
    )
    assert.throws(
      () => kernel.plugins.getPublicSessionDoc(DUO_PLUGIN_ID, DUO_SESSION_DOC, conv.id),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_doc_not_found',
    )

    await kernel.plugins.enable(DUO_PLUGIN_ID)
    const forceRemoved = (await kernel.plugins.invokeAction(DUO_PLUGIN_ID, 'remove', {
      id: 'life_pair',
      force: true,
    })) as { removed: boolean }
    assert.equal(forceRemoved.removed, true)
  } finally {
    await env.close()
  }
})
