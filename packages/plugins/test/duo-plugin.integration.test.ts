/**
 * Integration tests for `builtin:duo` against real `createHelmx` + `faux` provider:
 * - Default enabled registration, managed skill, client bundle exports, `profiles` doc & `duo` sessionDoc;
 * - Dual-phase `planning` <-> `execution` state machine (`exit_plan_mode`, `hand_back_to_planner`,
 *   `maxExecutionSteps` budget pause, `turn_settled` Planner restore, zero persistent `modelOverride` mutation);
 * - Profile-level Duo defaults + `builtin:tiers` preset template lockstep upgrade + per-conv override & standby meta;
 * - Cross-plugin interop with `builtin:plan` (`helmx.plan-mode-active` precedence + `plan.approved` with/without model switch);
 * - Child model unwrapping (`helmx.default-child-model` + `agent_spawn` + `subagent`);
 * - `swarm-coordinator` posture suppression (keeps Planner + preserves child default model);
 * - Lifecycle safety (`inUse`, `--force` disable restore, `pi.reset`, `conversation.deleted`, `profile.changed`).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai/providers/faux'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import { HelmxError, type BeforeTurnHookPayload } from '@helmx/protocol'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { createHelmx } from '../../hub/src/app.js'
import {
  DEFAULT_CHILD_MODEL_CAPABILITY_ID,
  PLAN_MODE_ACTIVE_CAPABILITY_ID,
  type DefaultChildModelCapability,
  type PlanModeActiveCapability,
} from '../src/contracts.js'
import {
  DUO_EXIT_PLAN_MODE_TOOL,
  DUO_EXECUTE_SECTION_ID,
  DUO_HAND_BACK_TOOL,
  DUO_INPUT_META_KEY,
  DUO_PLAN_SECTION_ID,
  DUO_PLUGIN_ID,
  DUO_PROFILES_DOC,
  DUO_SESSION_DOC,
  DUO_SKILL_ID,
  DUO_STEP_LIMIT_SECTION_ID,
  type DuoProfilesDocSnapshot,
  type DuoSessionView,
} from '../src/duo.js'
import { PLAN_MODE_SECTION_ID, PLAN_PLUGIN_ID, PLAN_TOOL_PROPOSE, PLAN_TOOL_SAVE } from '../src/plan.js'
import { TIERS_PLUGIN_ID } from '../src/tiers.js'
import { TITLE_PLUGIN_ID } from '../src/title.js'
import {
  assertRejectsCode,
  cleanupDir,
  deferred,
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
  reply: string | (() => ReturnType<typeof fauxAssistantMessage>) = 'acknowledged',
): FauxResponseStep {
  return (context, _opts, _state, model) => {
    const sectionsById: Record<string, string | null> = {}
    for (const msg of context.messages as unknown as Array<Record<string, unknown>>) {
      if (msg['role'] !== 'system') continue
      const sections = msg['sections'] as Record<string, string | null> | undefined
      if (sections === undefined) continue
      for (const [k, v] of Object.entries(sections)) {
        if (v === null) delete sectionsById[k]
        else sectionsById[k] = v
      }
    }
    sink.push({
      modelId: `${model.provider}/${model.id}`,
      toolNames: getCurrentTools(context.messages as never).map((t) => t.name),
      sectionsById,
    })
    return typeof reply === 'function' ? reply() : fauxAssistantMessage(reply)
  }
}

test('registration, managed skill, client bundle exports, and per-conversation dual-phase loop with budget & turn_settled restore', TIMEOUT, async () => {
  const env = await openDuoEnv({ defaultModel: 'faux/flagship' })
  try {
    const { kernel } = env.app
    const summary = kernel.plugins.list().find((p) => p.id === DUO_PLUGIN_ID)
    assert.ok(summary && summary.enabled, 'builtin:duo must be enabled by default')

    const skills = await kernel.skills.list()
    assert.ok(skills.some((s) => s.id === DUO_SKILL_ID && s.managedByPlugin === DUO_PLUGIN_ID))

    const indexMod = await kernel.plugins.getClientModule(DUO_PLUGIN_ID, 'index.tsx')
    assert.match(indexMod.code, /DuoProfileSection/)
    assert.match(indexMod.code, /DuoMenuItem/)
    assert.match(indexMod.code, /DuoToolbarPill/)
    assert.match(indexMod.code, /DuoTransitionToolRow/)

    const profilesDoc = kernel.plugins.getPublicDoc(DUO_PLUGIN_ID, DUO_PROFILES_DOC).value as DuoProfilesDocSnapshot
    assert.deepEqual(profilesDoc, { profiles: {} })

    const conv = await kernel.conversations.createConversation({ title: 'Duo loop test' })
    const observed: ObservedStep[] = []

    // Enable Duo per-conversation with step budget 2
    const status = (await kernel.plugins.invokeAction(DUO_PLUGIN_ID, 'set_conversation', {
      conversationId: conv.id,
      enabled: true,
      executorModel: 'faux/coder',
      executorThinkingLevel: 'medium',
      maxExecutionSteps: 2,
    })) as DuoSessionView
    assert.equal(status.enabled, true)
    assert.equal(status.phase, 'planning')
    assert.equal(status.executorModel, 'faux/coder')
    assert.equal(status.maxExecutionSteps, 2)

    env.faux.setResponses([
      captureStep(observed, () =>
        fauxAssistantMessage([fauxToolCall(DUO_EXIT_PLAN_MODE_TOOL, { plan: 'Edit index and verify' })], { stopReason: 'toolUse' }),
      ),
      captureStep(observed, () =>
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo step1' })], { stopReason: 'toolUse' }),
      ),
      captureStep(observed, () =>
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo step2' })], { stopReason: 'toolUse' }),
      ),
      captureStep(observed, () =>
        fauxAssistantMessage(
          [fauxToolCall(DUO_HAND_BACK_TOOL, { reason: 'step_budget_reached', summary: 'Ran 2 checks; returning' })],
          { stopReason: 'toolUse' },
        ),
      ),
      captureStep(observed, 'Planning review complete.'),
    ])

    await kernel.conversations.submitInput(conv.id, 'Run a bounded dual-phase workflow')
    await kernel.conversations.waitForIdle(conv.id)

    assert.equal(observed.length, 5)
    // Step 1: Planning on flagship, read-only whitelist + exit_plan_mode (no write/hand_back_to_planner)
    assert.equal(observed[0]!.modelId, 'faux/flagship')
    assert.ok(observed[0]!.toolNames.includes(DUO_EXIT_PLAN_MODE_TOOL))
    assert.ok(observed[0]!.toolNames.includes('bash'))
    assert.equal(observed[0]!.toolNames.includes('write'), false)
    assert.equal(observed[0]!.toolNames.includes(DUO_HAND_BACK_TOOL), false)
    assert.ok(typeof observed[0]!.sectionsById[DUO_PLAN_SECTION_ID] === 'string')

    // Steps 2 & 3: Execution on coder with write + hand_back_to_planner
    assert.equal(observed[1]!.modelId, 'faux/coder')
    assert.ok(observed[1]!.toolNames.includes('write'))
    assert.ok(observed[1]!.toolNames.includes(DUO_HAND_BACK_TOOL))
    assert.equal(observed[1]!.toolNames.includes(DUO_EXIT_PLAN_MODE_TOOL), false)
    assert.ok(observed[1]!.sectionsById[DUO_EXECUTE_SECTION_ID]?.includes('step 1 of 2'))
    assert.equal(observed[2]!.modelId, 'faux/coder')
    assert.ok(observed[2]!.sectionsById[DUO_EXECUTE_SECTION_ID]?.includes('step 2 of 2'))

    // Step 4: Budget exhausted -> pauses workspace tools down to [hand_back_to_planner]
    assert.equal(observed[3]!.modelId, 'faux/coder')
    assert.deepEqual(observed[3]!.toolNames, [DUO_HAND_BACK_TOOL])
    assert.ok(typeof observed[3]!.sectionsById[DUO_STEP_LIMIT_SECTION_ID] === 'string')

    // Step 5: Back on Planner flagship in planning phase
    assert.equal(observed[4]!.modelId, 'faux/flagship')
    assert.ok(observed[4]!.toolNames.includes(DUO_EXIT_PLAN_MODE_TOOL))
    assert.equal(observed[4]!.toolNames.includes('write'), false)

    // Turn settled cleanly on Planner without mutating modelOverride
    const settled = kernel.conversations.getConversation(conv.id)
    assert.equal(settled.model, 'faux/flagship')
    assert.equal(settled.modelOverride, undefined)
    assert.equal(settled.runtimeModelOverride, undefined)

    // Verify presentationMeta on both transition tool results
    const detail = await kernel.conversations.getConversationDetail(conv.id, { limit: 40 })
    const toolResults = detail.entries
      .filter((e) => e.kind === 'pi.tool-result')
      .map((e) => e.model?.[0] as { details?: Record<string, unknown> } | undefined)
    const exitMeta = toolResults.find((m) => m?.details?.['tool'] === DUO_EXIT_PLAN_MODE_TOOL)
    assert.equal(exitMeta?.details?.['tool'], DUO_EXIT_PLAN_MODE_TOOL)
    assert.equal(exitMeta?.details?.['toModel'], 'faux/coder')
    const backMeta = toolResults.find((m) => m?.details?.['tool'] === DUO_HAND_BACK_TOOL)
    assert.equal(backMeta?.details?.['tool'], DUO_HAND_BACK_TOOL)
    assert.equal(backMeta?.details?.['reason'], 'step_budget_reached')

    // Next turn with turn_settled mid-execution restores Planner automatically
    observed.length = 0
    env.faux.setResponses([
      captureStep(observed, () =>
        fauxAssistantMessage([fauxToolCall(DUO_EXIT_PLAN_MODE_TOOL, { plan: 'Direct answer after edit' })], { stopReason: 'toolUse' }),
      ),
      captureStep(observed, 'Execution finished directly without explicit hand_back.'),
    ])
    await kernel.conversations.submitInput(conv.id, 'Complete directly in execution')
    await kernel.conversations.waitForIdle(conv.id)
    assert.equal(observed.length, 2)
    assert.equal(observed[1]!.modelId, 'faux/coder')
    assert.equal(kernel.conversations.getConversation(conv.id).model, 'faux/flagship')
    const docAfter = kernel.plugins.getPublicSessionDoc(DUO_PLUGIN_ID, DUO_SESSION_DOC, conv.id).value as DuoSessionView
    assert.equal(docAfter.phase, 'planning')
    assert.equal(docAfter.executionStepCount, 0)
  } finally {
    await env.close()
  }
})

test('Profile-level Duo, builtin:tiers preset lockstep upgrade, per-conv disable/override, and standby input.meta', TIMEOUT, async () => {
  const env = await openDuoEnv()
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'replace', {
      tiers: {
        architect: { model: 'faux/flagship', thinkingLevel: 'high' },
        coder: { model: 'faux/coder', thinkingLevel: 'medium' },
      },
    })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'save_template', { id: 'v1', name: 'V1 Stack' })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'save_template', {
      id: 'v2',
      name: 'V2 Stack',
      tiers: {
        architect: { model: 'faux/flagship-v2', thinkingLevel: 'high' },
        coder: { model: 'faux/coder-v2', thinkingLevel: 'low' },
      },
    })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'apply_template', { id: 'v1' })

    await kernel.profiles.save({ id: 'eng-duo', name: 'Engineering Duo', model: 'tier/architect' })
    await kernel.plugins.invokeAction(DUO_PLUGIN_ID, 'set_profile', {
      profileId: 'eng-duo',
      enabled: true,
      executorModel: 'tier/coder',
    })

    const profilesDoc = kernel.plugins.getPublicDoc(DUO_PLUGIN_ID, DUO_PROFILES_DOC).value as DuoProfilesDocSnapshot
    assert.equal(profilesDoc.profiles['eng-duo']?.executorModel, 'tier/coder')

    const conv = await kernel.conversations.createConversation({ title: 'Lockstep', profileId: 'eng-duo' })
    const obs: ObservedStep[] = []

    // Turn under v1 tiers
    env.faux.setResponses([
      captureStep(obs, () =>
        fauxAssistantMessage([fauxToolCall(DUO_EXIT_PLAN_MODE_TOOL, { plan: 'Step' })], { stopReason: 'toolUse' }),
      ),
      captureStep(obs, 'Done v1.'),
    ])
    await kernel.conversations.submitInput(conv.id, 'Run v1')
    await kernel.conversations.waitForIdle(conv.id)
    assert.deepEqual(obs.map((s) => s.modelId), ['faux/flagship', 'faux/coder'])

    // Switch tier template v1 -> v2: Planner & Executor both upgrade in lockstep!
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'apply_template', { id: 'v2' })
    obs.length = 0
    env.faux.setResponses([
      captureStep(obs, () =>
        fauxAssistantMessage([fauxToolCall(DUO_EXIT_PLAN_MODE_TOOL, { plan: 'Step v2' })], { stopReason: 'toolUse' }),
      ),
      captureStep(obs, 'Done v2.'),
    ])
    await kernel.conversations.submitInput(conv.id, 'Run v2')
    await kernel.conversations.waitForIdle(conv.id)
    assert.deepEqual(obs.map((s) => s.modelId), ['faux/flagship-v2', 'faux/coder-v2'])

    // Per-conv explicit disable opts out of Profile Duo
    await kernel.plugins.invokeAction(DUO_PLUGIN_ID, 'set_conversation', {
      conversationId: conv.id,
      enabled: false,
    })
    obs.length = 0
    env.faux.setResponses([captureStep(obs, 'Plain single turn without Duo.')])
    await kernel.conversations.submitInput(conv.id, 'No duo please')
    await kernel.conversations.waitForIdle(conv.id)
    assert.equal(obs[0]!.modelId, 'faux/flagship-v2')
    assert.equal(obs[0]!.toolNames.includes(DUO_EXIT_PLAN_MODE_TOOL), false)
    assert.equal(obs[0]!.sectionsById[DUO_PLAN_SECTION_ID], undefined)
    assert.ok(obs[0]!.toolNames.includes('write'))

    // clear_conversation reverts to Profile Duo
    await kernel.plugins.invokeAction(DUO_PLUGIN_ID, 'clear_conversation', { conversationId: conv.id })
    const restoredDoc = kernel.plugins.getPublicSessionDoc(DUO_PLUGIN_ID, DUO_SESSION_DOC, conv.id).value as DuoSessionView
    assert.equal(restoredDoc.enabled, true)
    assert.equal(restoredDoc.source, 'profile')

    // Standby input.meta enables Duo on a non-Duo Profile conversation cleanly
    const standbyConv = await kernel.conversations.createConversation({ title: 'Standby Duo' })
    env.faux.setResponses([captureStep(obs, 'Standby ready.')])
    await kernel.conversations.submitInput(standbyConv.id, 'Enable via standby meta', {
      meta: { [DUO_INPUT_META_KEY]: { enabled: true, executorModel: 'faux/fast', maxExecutionSteps: 5 } },
    })
    await kernel.conversations.waitForIdle(standbyConv.id)
    const standbyView = (await kernel.plugins.invokeAction(DUO_PLUGIN_ID, 'status', {
      conversationId: standbyConv.id,
    })) as DuoSessionView
    assert.equal(standbyView.enabled, true)
    assert.equal(standbyView.source, 'conversation')
    assert.equal(standbyView.executorModel, 'faux/fast')
    assert.equal(standbyView.maxExecutionSteps, 5)
  } finally {
    await env.close()
  }
})

test('/plan interop: /plan yields during planning, plan.approved bridges directly into Duo execution (modelSwitched false & true)', TIMEOUT, async () => {
  const env = await openDuoEnv({ defaultModel: 'faux/flagship' })
  try {
    const { kernel } = env.app
    const conv = await kernel.conversations.createConversation({ title: 'Plan + Duo Bridge' })
    await kernel.plugins.invokeAction(DUO_PLUGIN_ID, 'set_conversation', {
      conversationId: conv.id,
      enabled: true,
      executorModel: 'faux/coder',
    })
    const planCap = kernel.plugins.consumeCapability<PlanModeActiveCapability>(PLAN_MODE_ACTIVE_CAPABILITY_ID)[0]!.impl
    const obs: ObservedStep[] = []

    // Scenario A: `/plan` active during planning -> Duo yields completely; approve_handoff WITHOUT explicit model -> switches straight to Duo executorModel!
    await kernel.plugins.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: conv.id, mode: 'planning' })
    assert.equal(planCap.isPlanning(conv.id), true)

    env.faux.setResponses([
      captureStep(obs, () =>
        fauxAssistantMessage([fauxToolCall(PLAN_TOOL_SAVE, { title: 'Bridge Plan', markdown: '# Step 1\nDo work' })], { stopReason: 'toolUse' }),
      ),
      captureStep(obs, () =>
        fauxAssistantMessage([fauxToolCall(PLAN_TOOL_PROPOSE, { summary: 'Approve into Duo executor' })], { stopReason: 'toolUse' }),
      ),
      captureStep(obs, 'Executed handed-off plan on Duo executor.'),
    ])

    await kernel.conversations.submitInput(conv.id, 'Explore and propose plan')
    await waitFor(() => kernel.asks.listAsks('pending').length === 1)
    const askA = kernel.asks.listAsks('pending')[0]!
    await kernel.asks.answerAsk(askA.id, { decision: 'approve_handoff', executionModel: '' }, askA.expectedStateSeq)
    await kernel.conversations.waitForIdle(conv.id)

    // During /plan steps (obs[0], obs[1]): /plan section only, NO <duo_*>, NO exit_plan_mode
    assert.ok(obs[0]!.sectionsById[PLAN_MODE_SECTION_ID] !== undefined)
    assert.equal(obs[0]!.sectionsById[DUO_PLAN_SECTION_ID], undefined)
    assert.equal(obs[0]!.toolNames.includes(DUO_EXIT_PLAN_MODE_TOOL), false)

    // Handed-off execution step (obs[2]) ran directly on Duo's executorModel (`faux/coder`) in execution phase despite `pi.reset`!
    assert.equal(obs[2]!.modelId, 'faux/coder')
    assert.ok(obs[2]!.toolNames.includes('write'))
    assert.ok(obs[2]!.toolNames.includes(DUO_HAND_BACK_TOOL))
    assert.ok(obs[2]!.sectionsById[DUO_EXECUTE_SECTION_ID] !== undefined)

    // After run settles -> back to Planner
    assert.equal(kernel.conversations.getConversation(conv.id).model, 'faux/flagship')
    assert.equal(planCap.isPlanning(conv.id), false)

    // Scenario B: approve_handoff WITH explicit human executionModel (`faux/fast`) -> respects `faux/fast` instead of Duo's `faux/coder`
    obs.length = 0
    await kernel.plugins.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: conv.id, mode: 'planning' })
    env.faux.setResponses([
      captureStep(obs, () =>
        fauxAssistantMessage([fauxToolCall(PLAN_TOOL_SAVE, { title: 'Custom Model Plan', markdown: '# Step 1\nUse fast' })], { stopReason: 'toolUse' }),
      ),
      captureStep(obs, () =>
        fauxAssistantMessage([fauxToolCall(PLAN_TOOL_PROPOSE, { summary: 'Approve on explicit model' })], { stopReason: 'toolUse' }),
      ),
      captureStep(obs, 'Executed on human-selected fast model.'),
    ])
    await kernel.conversations.submitInput(conv.id, 'Propose custom model')
    await waitFor(() => kernel.asks.listAsks('pending').length === 1)
    const askB = kernel.asks.listAsks('pending')[0]!
    await kernel.asks.answerAsk(
      askB.id,
      { decision: 'approve_handoff', executionModel: 'faux/fast' },
      askB.expectedStateSeq,
    )
    await kernel.conversations.waitForIdle(conv.id)

    assert.equal(obs[2]!.modelId, 'faux/fast')
    assert.ok(obs[2]!.sectionsById[DUO_EXECUTE_SECTION_ID] !== undefined)
    assert.equal(kernel.conversations.getConversation(conv.id).model, 'faux/flagship')
  } finally {
    await env.close()
  }
})

test('child inheritance (DEFAULT_CHILD_MODEL_CAPABILITY_ID + subagent) and swarm-coordinator posture suppression', TIMEOUT, async () => {
  const env = await openDuoEnv({ defaultModel: 'faux/flagship' })
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'coder',
      model: 'faux/coder',
      thinkingLevel: 'low',
    })
    const conv = await kernel.conversations.createConversation({ title: 'Duo Parent + Coordinator' })
    await kernel.plugins.invokeAction(DUO_PLUGIN_ID, 'set_conversation', {
      conversationId: conv.id,
      enabled: true,
      executorModel: 'tier/coder',
    })

    const childCap = kernel.plugins.consumeCapability<DefaultChildModelCapability>(DEFAULT_CHILD_MODEL_CAPABILITY_ID)[0]!.impl
    assert.deepEqual(childCap.resolveDefaultChildModel(conv.id), {
      model: 'faux/coder',
      thinkingLevel: 'low',
    })

    // 1. Subagent spawned in Planning phase (model omitted) unwraps to concrete `faux/coder`, honors explicit `faux/fast`, and hides Duo tools
    const obsAll: ObservedStep[] = []
    env.faux.setResponses([
      captureStep(obsAll, () =>
        fauxAssistantMessage(
          [
            fauxToolCall('subagent', { prompt: 'Inherited worker task', background: false }, { id: 'sub-inherit' }),
            fauxToolCall('subagent', { prompt: 'Explicit fast task', model: 'faux/fast', background: false }, { id: 'sub-explicit' }),
          ],
          { stopReason: 'toolUse' },
        ),
      ),
      captureStep(obsAll, 'Child reply A.'),
      captureStep(obsAll, 'Child reply B.'),
      captureStep(obsAll, 'Parent synthesized subagent work.'),
    ])

    await kernel.conversations.submitInput(conv.id, 'Delegate two child tasks')
    await kernel.conversations.waitForIdle(conv.id)

    const children = kernel.conversations.listConversations({ parentConversationId: conv.id })
    assert.equal(children.length, 2)
    assert.deepEqual(children.map((c) => c.model).sort(), ['faux/coder', 'faux/fast'])
    for (const childStep of obsAll.filter((s) => s.modelId !== 'faux/flagship')) {
      assert.equal(childStep.toolNames.includes(DUO_EXIT_PLAN_MODE_TOOL), false)
      assert.equal(childStep.toolNames.includes(DUO_HAND_BACK_TOOL), false)
      assert.equal(childStep.sectionsById[DUO_PLAN_SECTION_ID], undefined)
    }

    // 2. swarm-coordinator tag suppresses Duo self-coding prompts/tools while KEEPING Planner + helmx.default-child-model!
    await kernel.conversations.updateConversation(conv.id, { tags: ['swarm-coordinator'] })
    assert.deepEqual(childCap.resolveDefaultChildModel(conv.id), {
      model: 'faux/coder',
      thinkingLevel: 'low',
    })

    obsAll.length = 0
    env.faux.setResponses([captureStep(obsAll, 'Coordinator stayed on Planner.')])
    await kernel.conversations.submitInput(conv.id, 'Coordinate swarm workers')
    await kernel.conversations.waitForIdle(conv.id)

    assert.equal(obsAll[0]!.modelId, 'faux/flagship')
    assert.equal(obsAll[0]!.sectionsById[DUO_PLAN_SECTION_ID], undefined)
    assert.equal(obsAll[0]!.sectionsById[DUO_EXECUTE_SECTION_ID], undefined)
    assert.equal(obsAll[0]!.toolNames.includes(DUO_EXIT_PLAN_MODE_TOOL), false)
    assert.equal(obsAll[0]!.toolNames.includes(DUO_HAND_BACK_TOOL), false)
  } finally {
    await env.close()
  }
})

test('lifecycle: inUse gates disable unless --force, force-disable restores runtime model, and delete/profile cleanup stay clean', TIMEOUT, async () => {
  const env = await openDuoEnv({ defaultModel: 'faux/flagship' })
  try {
    const { kernel } = env.app
    await kernel.profiles.save({ id: 'duo-prof', name: 'Duo Prof', model: 'faux/flagship' })
    await kernel.plugins.invokeAction(DUO_PLUGIN_ID, 'set_profile', {
      profileId: 'duo-prof',
      enabled: true,
      executorModel: 'faux/coder',
    })
    const conv = await kernel.conversations.createConversation({ title: 'Lifecycle', profileId: 'duo-prof' })

    // 1. Active profile/conv Duo blocks non-forced disable with 409 plugin_in_use
    // (wait out transient fire-and-forget `event:conversation.upsert` task completion first).
    let disableErr: unknown
    await waitFor(async () => {
      try {
        await kernel.plugins.disable(DUO_PLUGIN_ID)
        return false
      } catch (err) {
        if (err instanceof HelmxError && err.code === 'plugin_has_live_tasks') {
          return false
        }
        disableErr = err
        return true
      }
    })
    assert.ok(disableErr instanceof HelmxError && disableErr.code === 'plugin_in_use' && disableErr.status === 409)

    // 2. Deleting profile cleans up profiles doc (async internal host event delivery)
    await kernel.profiles.delete('duo-prof')
    await waitFor(() => {
      const snap = kernel.plugins.getPublicDoc(DUO_PLUGIN_ID, DUO_PROFILES_DOC).value as DuoProfilesDocSnapshot
      return snap.profiles['duo-prof'] === undefined
    })

    // 3. Rebind conversation to default profile, configure conv override, enter execution mid-turn via a test hook gate, verify liveTasks 409
    await kernel.conversations.updateConversation(conv.id, { profileId: 'assistant' })
    await kernel.plugins.invokeAction(DUO_PLUGIN_ID, 'set_conversation', {
      conversationId: conv.id,
      enabled: true,
      executorModel: 'faux/coder',
    })
    const gate = deferred<void>()
    await kernel.plugins.register({
      id: 'test:duo-hold-exec',
      name: { en: 'Duo Hold Exec' },
      version: '0.1.0',
      definePlugin(ctx) {
        ctx.hook.onBeforeTurn(async (payload: BeforeTurnHookPayload) => {
          if (payload.conversation.id === conv.id && payload.conversation.model === 'faux/coder') {
            await gate.promise
          }
          return { action: 'continue' }
        }, { priority: -110 })
      },
    })

    env.faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall(DUO_EXIT_PLAN_MODE_TOOL, { plan: 'Hold mid-execution' })], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('Post hold.'),
    ])
    await kernel.conversations.submitInput(conv.id, 'Enter exec and pause')
    await waitFor(() => kernel.conversations.getConversation(conv.id).model === 'faux/coder')

    // Active execution blocks even --force disable with 409 plugin_has_live_tasks!
    await assertRejectsCode(() => kernel.plugins.disable(DUO_PLUGIN_ID, { force: true }), 'plugin_has_live_tasks')
    gate.resolve()
    await kernel.conversations.waitForIdle(conv.id)
    assert.equal(kernel.conversations.getConversation(conv.id).model, 'faux/flagship')

    // After idle, force-disable succeeds and strips managed skill from <available_skills> & load_skill
    await kernel.plugins.disable(DUO_PLUGIN_ID, { force: true })
    const disabledHook = await kernel.plugins.runHook('before_turn', {
      conversation: kernel.conversations.getConversation(conv.id),
      inputs: [],
      sections: [],
      tools: [],
      messages: [],
    })
    const disabledSkillsText =
      disabledHook.action === 'transform'
        ? (disabledHook.value.sections.find((s) => s.id === 'profile.skills')?.text ?? '')
        : ''
    assert.equal(disabledSkillsText.includes(`id="${DUO_SKILL_ID}"`), false)
    await assertRejectsCode(
      () => kernel.plugins.executeTool('load_skill', { skillId: DUO_SKILL_ID }, { conversationId: conv.id }),
      'skill_not_available',
      403,
    )
    await kernel.plugins.enable(DUO_PLUGIN_ID)

    // Deleting conversation cleans up safely without errors
    await kernel.conversations.deleteConversation(conv.id)
  } finally {
    await env.close()
  }
})
