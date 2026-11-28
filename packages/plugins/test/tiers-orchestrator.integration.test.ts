/**
 * Dual-phase orchestrator tier integration tests against real `createHelmx` + `faux` provider:
 * - Multiple orchestrator tier pairs (`tier/pair-a`, `tier/pair-b`) & template round-trips;
 * - Strict machine invisibility (`<available_model_tiers>`, `400 orchestrator_tier_human_only`,
 *   `400 orchestrator_tier_not_borrowable`, `409 orchestrator_tier_active`);
 * - Profile inheritance unwrapping (`human_conversation` -> Planner + `modelTier`,
 *   `subagent_inherit` -> concrete `executorModel` without `modelTier`);
 * - Full Planning (native `bash` + read-only `run_action` + `exit_plan_mode`) -> Execution (step budget,
 *   static Prompt Cache sections, `hand_back_to_planner`) -> Planner review loop;
 * - `followUp` boundary reset via `afterResponse` (including `plannerModel === executorModel`)
 *   while preserving mid-turn `steer` execution phase;
 * - Model switch cleanup & `/plan` strict precedence.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import type { Model, SimpleStreamOptions, ToolCall, TranscriptContext } from '@earendil-works/pi-ai'
import { wrapModelsForCompaction } from '@helmx/kernel/testing'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { createHelmx } from '../../hub/src/app.js'
import {
  TIERS_BORROW_SESSION_DOC,
  TIERS_EXIT_PLAN_MODE_TOOL,
  TIERS_HAND_BACK_TOOL,
  TIERS_ORCHESTRATOR_SESSION_DOC,
  TIERS_PLUGIN_ID,
  TIERS_SWITCH_MODEL_TOOL,
  type TierOrchestratorSessionView,
} from '../src/tiers.js'
import { SWARM_PLUGIN_ID, SWARM_TOOL_NAMES } from '../src/swarm.js'
import { WORKFLOW_PLUGIN_ID } from '../src/workflow.js'
import { ORCHESTRATOR_PLAN_TOOL_WHITELIST } from '../src/tiers/contracts.js'
import {
  ORCHESTRATOR_EXECUTE_SECTION,
  ORCHESTRATOR_PLAN_SECTION,
  ORCHESTRATOR_STEP_LIMIT_SECTION,
} from '../src/tiers/orchestrator.js'
import { normalizeTierSpec } from '../src/tiers/validation.js'
import {
  assertRejectsCode,
  cleanupDir,
  deferred,
  makeFauxProvider,
  makeTempDir,
  waitFor,
} from './helpers/plugin-test-env.js'

interface ObservedCall {
  modelId: string
  reasoning: unknown
  systemPrompt: string
  toolNames: string[]
}

async function openOrchestratorEnv(options: { defaultModel?: string } = {}) {
  const dataDir = await makeTempDir('helmx-tiers-orch-')
  const faux = makeFauxProvider({
    models: [
      { id: 'fast', name: 'Fast', reasoning: true },
      { id: 'workhorse', name: 'Workhorse', reasoning: true },
      { id: 'flagship', name: 'Flagship', reasoning: true },
    ],
  })
  const app = await createHelmx({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    cwd: dataDir,
    model: options.defaultModel ?? 'faux/workhorse',
    providers: [faux.provider],
  })
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

function extractSystemSections(messages: TranscriptContext['messages']): Record<string, string> {
  const sections = new Map<string, string>()
  for (const msg of messages as ReadonlyArray<{ role?: string; sections?: Record<string, unknown> }>) {
    if (msg.role !== 'system' || !msg.sections || typeof msg.sections !== 'object') continue
    for (const [k, v] of Object.entries(msg.sections)) {
      if (v === null) sections.delete(k)
      else if (typeof v === 'string') sections.set(k, v)
    }
  }
  return Object.fromEntries(sections)
}

function captureStep(
  log: ObservedCall[],
  convId: number,
  buildReply: (observed: ObservedCall) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>,
) {
  return async (
    context: TranscriptContext,
    options: SimpleStreamOptions | undefined,
    _state: unknown,
    model: Model<string>,
  ) => {
    void convId
    const sections = extractSystemSections(context.messages)
    const entry: ObservedCall = {
      modelId: `${model.provider}/${model.id}`,
      reasoning: options?.reasoning,
      systemPrompt: Object.values(sections).join('\n'),
      toolNames: getCurrentTools(context.messages).map((t) => t.name),
    }
    log.push(entry)
    return buildReply(entry)
  }
}

test('orchestrator validation, multi-pair coexistence, templates, and disabled-model check', { timeout: 60_000 }, async () => {
  await assertRejectsCode(
    async () => normalizeTierSpec({ kind: 'single', model: 'faux/fast', executorModel: 'faux/workhorse' }),
    'validation_error',
  )
  await assertRejectsCode(
    async () => normalizeTierSpec({ kind: 'orchestrator', model: 'faux/flagship' }),
    'validation_error',
  )
  await assertRejectsCode(
    async () => normalizeTierSpec({ kind: 'orchestrator', model: 'faux/flagship', executorModel: 'faux/workhorse', maxExecutionSteps: 101 }),
    'validation_error',
  )
  await assertRejectsCode(
    async () => normalizeTierSpec({ kind: 'orchestrator', model: 'faux/flagship', executorModel: 'faux/workhorse', maxExecutionSteps: -1 }),
    'validation_error',
  )
  const defaultStepsSpec = normalizeTierSpec({ kind: 'orchestrator', model: 'faux/flagship', executorModel: 'faux/workhorse' })
  assert.equal(defaultStepsSpec.maxExecutionSteps, 30)
  const unlimitedSpec = normalizeTierSpec({ kind: 'orchestrator', model: 'faux/flagship', executorModel: 'faux/workhorse', maxExecutionSteps: 0 })
  assert.equal(unlimitedSpec.maxExecutionSteps, 0)

  const env = await openOrchestratorEnv()
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'coder',
      model: 'faux/workhorse',
      thinkingLevel: 'medium',
      description: 'Single coder',
    })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'pair-a',
      kind: 'orchestrator',
      model: 'faux/flagship',
      thinkingLevel: 'high',
      executorModel: 'faux/workhorse',
      executorThinkingLevel: 'low',
      description: 'Flagship planner + workhorse executor',
    })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'pair-b',
      kind: 'orchestrator',
      model: 'faux/workhorse',
      executorModel: 'faux/fast',
      maxExecutionSteps: 0,
      description: 'Lighter planner + fast executor (unlimited)',
    })

    const catalog = await kernel.models.listModels()
    const pairA = catalog.modelTiers?.find((t) => t.id === 'pair-a')
    const pairB = catalog.modelTiers?.find((t) => t.id === 'pair-b')
    assert.equal(pairA?.kind, 'orchestrator')
    assert.equal(pairA?.executorModel, 'faux/workhorse')
    assert.equal(pairA?.maxExecutionSteps, 30)
    assert.equal(pairA?.available, true)
    assert.equal(pairB?.kind, 'orchestrator')
    assert.equal(pairB?.executorModel, 'faux/fast')
    assert.equal(pairB?.maxExecutionSteps, 0)
    assert.equal(pairB?.available, true)

    // Save template containing both single and dual-phase orchestrator pairs, wipe, then restore via apply_template
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'save_template', {
      id: 'dual-roster',
      name: 'Dual Roster',
    })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'replace', { tiers: {} })
    const afterWipe = await kernel.models.listModels()
    assert.equal(afterWipe.modelTiers, undefined)

    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'apply_template', { id: 'dual-roster' })
    const afterRestore = await kernel.models.listModels()
    assert.equal(afterRestore.modelTiers?.find((t) => t.id === 'pair-a')?.executorModel, 'faux/workhorse')
    assert.equal(afterRestore.modelTiers?.find((t) => t.id === 'pair-b')?.executorModel, 'faux/fast')
    assert.equal(afterRestore.modelTiers?.find((t) => t.id === 'coder')?.kind, undefined)

    // Disabling EITHER planner OR executor marks orchestrator tier disabled and blocks creation/set
    await kernel.models.setDisabledModels('faux', ['fast'])
    const catExecDisabled = await kernel.models.listModels()
    const pairBDisabled = catExecDisabled.modelTiers?.find((t) => t.id === 'pair-b')
    assert.equal(pairBDisabled?.disabled, true)
    assert.equal(pairBDisabled?.available, false)
    await assertRejectsCode(
      () => kernel.conversations.createConversation({ title: 'blocked-exec', model: 'tier/pair-b' }),
      'model_disabled',
    )
    await assertRejectsCode(
      () =>
        kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
          id: 'pair-c',
          kind: 'orchestrator',
          model: 'faux/workhorse',
          executorModel: 'faux/fast',
        }),
      'model_disabled',
    )
    await kernel.models.setDisabledModels('faux', [])
  } finally {
    await env.close()
  }
})

test('machine invisibility: orchestrator tiers stay invisible in catalog, rejected on machine callers, and unwrap cleanly for inherited subagents', { timeout: 60_000 }, async () => {
  const env = await openOrchestratorEnv()
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'coder',
      model: 'faux/workhorse',
      description: 'Single tier visible to agents',
    })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'claude-auto',
      kind: 'orchestrator',
      model: 'faux/flagship',
      thinkingLevel: 'xhigh',
      executorModel: 'faux/fast',
      executorThinkingLevel: 'low',
      maxExecutionSteps: 6,
      description: 'Human-only orchestrator',
    })

    // 1. `<available_model_tiers>` appears on plain conversations (showing single `tier/coder`,
    //    excluding `tier/claude-auto`), and is suppressed inside orchestrator conversations
    const conv = await kernel.conversations.createConversation({ title: 'human-orch', model: 'tier/claude-auto' })
    assert.equal(conv.model, 'faux/flagship')
    assert.equal(conv.modelTier, 'tier/claude-auto')
    assert.equal(conv.modelOverride, 'tier/claude-auto')
    assert.equal(conv.thinkingLevelOverride, undefined, 'orchestrator tier must not freeze thinkingLevelOverride')

    const plainConv = await kernel.conversations.createConversation({ title: 'plain-conv', model: 'faux/workhorse' })
    const plainHook = await kernel.plugins.runHook('before_turn', {
      conversation: kernel.conversations.getConversation(plainConv.id),
      inputs: [],
      messages: [],
      sections: [],
      tools: [],
    } as never)
    const injectedCatalog =
      plainHook.action === 'transform'
        ? (plainHook.value as { sections: Array<{ id: string; text: string }> }).sections.find(
            (s) => s.id === 'tiers.catalog',
          )?.text
        : undefined
    assert.ok(injectedCatalog !== undefined)
    assert.match(injectedCatalog, /tier\/coder/)
    assert.doesNotMatch(injectedCatalog, /tier\/claude-auto/)

    const orchHook = await kernel.plugins.runHook('before_turn', {
      conversation: kernel.conversations.getConversation(conv.id),
      inputs: [],
      messages: [],
      sections: [],
      tools: [],
    } as never)
    const orchCatalog =
      orchHook.action === 'transform'
        ? (orchHook.value as { sections: Array<{ id: string; text: string }> }).sections.find(
            (s) => s.id === 'tiers.catalog',
          )?.text
        : undefined
    assert.equal(orchCatalog, undefined, 'orchestrator conversation must omit <available_model_tiers>')

    // Auxiliary completeConversationText without explicit `model` unwraps to executorModel (`faux/fast`) rather than Planner
    const observedTextModels: string[] = []
    env.faux.setResponses([
      (_ctx, _opts, _state, model) => {
        observedTextModels.push(`${model.provider}/${model.id}`)
        return fauxAssistantMessage('Short title')
      },
    ])
    const generatedTitle = await kernel.conversations.completeConversationText({
      conversationId: conv.id,
      systemPrompt: 'Generate title',
      text: 'User asked to refactor tiers',
    })
    assert.equal(generatedTitle, 'Short title')
    assert.deepEqual(observedTextModels, ['faux/fast'])

    // 2. Explicit automation callers fail loudly with 400 orchestrator_tier_human_only / orchestrator_tier_not_borrowable
    await assertRejectsCode(
      () =>
        kernel.agentSpawn.spawnAgent({
          parentConversationId: conv.id,
          prompt: 'cannot use orchestrator directly',
          model: 'tier/claude-auto',
        }),
      'orchestrator_tier_human_only',
    )
    await assertRejectsCode(
      () =>
        kernel.conversations.createConversation({
          title: 'helmx-owned-reject',
          ownedBy: 'helmx',
          model: 'tier/claude-auto',
        }),
      'orchestrator_tier_human_only',
    )
    await assertRejectsCode(
      () => kernel.models.setDefaultModel('faux/workhorse', undefined, 'tier/claude-auto'),
      'orchestrator_tier_human_only',
    )
    await assertRejectsCode(
      () =>
        kernel.conversations.completeConversationText({
          conversationId: conv.id,
          model: 'tier/claude-auto',
          systemPrompt: 'sys',
          text: 'hello',
        }),
      'orchestrator_tier_human_only',
    )
    assert.throws(
      () => kernel.models.resolveModelRef('tier/claude-auto'),
      (err: unknown) => (err as { code?: unknown })?.code === 'orchestrator_tier_human_only',
    )
    const wrapped = wrapModelsForCompaction(kernel.models.models, () => ({
      model: 'tier/claude-auto',
      resolveModelRef: (ref, opts) => kernel.models.resolveModelRef(ref, opts),
      isDisabled: (p, m) => kernel.models.isModelDisabled(p, m),
    }))
    const compactionMsg = await wrapped.completeSimple(
      kernel.models.models.getModel('faux', 'flagship')!,
      {
        messages: [
          { role: 'system', content: 'You are a context summarization assistant.' },
          { role: 'user', content: 'summarize' },
        ],
      } as never,
      { cacheRetention: 'none' } as never,
    )
    assert.equal(compactionMsg.stopReason, 'error')
    assert.match(compactionMsg.errorMessage ?? '', /orchestrator tier restricted/i)

    // Borrow guards: targeting an orchestrator tier rejects cleanly, and in-turn `switch_model` tool remains blocked while active
    await assertRejectsCode(
      () =>
        kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set_borrow', {
          conversationId: plainConv.id,
          model: 'tier/claude-auto',
        }),
      'orchestrator_tier_not_borrowable',
    )
    const switchToolBlocked = (await kernel.plugins.executeTool(
      TIERS_SWITCH_MODEL_TOOL,
      { model: 'faux/fast' },
      { conversationId: conv.id },
    )) as { isError?: boolean; output?: string }
    assert.equal(switchToolBlocked.isError, true)
    assert.match(switchToolBlocked.output ?? '', /orchestrator tier/i)

    // 3. `subagent_inherit`: Profile bound to orchestrator tier gives human conv planner+modelTier,
    //    while child subagent inherits concrete executorModel cleanly without `modelTier`
    const existingAssistant = await kernel.profiles.get('assistant')
    assert.ok(existingAssistant !== undefined)
    await kernel.profiles.save({ ...existingAssistant, model: 'tier/claude-auto' })
    const inheritedHuman = await kernel.conversations.createConversation({ title: 'inherited-human' })
    assert.equal(inheritedHuman.model, 'faux/flagship')
    assert.equal(inheritedHuman.modelTier, 'tier/claude-auto')
    assert.equal(inheritedHuman.modelOverride, undefined)

    env.faux.setResponses([fauxAssistantMessage('child-executor-done')])
    let childConvId: number | undefined
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: inheritedHuman.id,
      prompt: 'execute inherited profile task',
      onResolved: (info) => {
        childConvId = info.conversationId
      },
    })
    assert.ok(childConvId !== undefined)
    const childSnap = kernel.conversations.getConversation(childConvId!)
    assert.equal(childSnap.model, 'faux/fast', 'child subagent inheriting orchestrator Profile must unwrap to executorModel')
    assert.equal(childSnap.thinkingLevel, 'low')
    assert.equal(childSnap.modelTier, undefined)

    // Forking a human orchestrator conversation drops symbolic modelTier and freezes concrete executorModel + executorThinkingLevel
    env.faux.setResponses([fauxAssistantMessage('seed')])
    await kernel.conversations.submitInput(conv.id, 'seed forkable turn')
    await kernel.conversations.waitForIdle(conv.id)
    const forked = await kernel.conversations.forkConversation(conv.id)
    assert.equal(forked.modelTier, undefined)
    assert.equal(forked.model, 'faux/fast')
    assert.equal(forked.modelOverride, 'faux/fast')
    assert.equal(forked.thinkingLevel, 'low')
    assert.equal(forked.thinkingLevelOverride, 'low')

    // Restore Profile cleanly
    await kernel.profiles.save({ ...existingAssistant, model: undefined })
  } finally {
    await env.close()
  }
})

test('full planner -> native bash & read-only run_action -> exit_plan_mode -> execution (step limit) -> hand_back_to_planner loop and static Prompt Cache', { timeout: 60_000 }, async () => {
  const env = await openOrchestratorEnv()
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'auto-main',
      kind: 'orchestrator',
      model: 'faux/flagship',
      thinkingLevel: 'high',
      executorModel: 'faux/workhorse',
      executorThinkingLevel: 'low',
      maxExecutionSteps: 1,
    })

    const conv = await kernel.conversations.createConversation({ title: 'dual-phase-loop', model: 'tier/auto-main' })
    const observed: ObservedCall[] = []
    const stepSnapshots: Array<{
      live: ReturnType<typeof kernel.conversations.getConversation>
      sdoc: TierOrchestratorSessionView | null
    }> = []

    const execCall1: ToolCall = fauxToolCall(
      'read',
      { path: 'missing-or-check.txt' },
      { id: 'call-exec-read' },
    )
    const planBashRead = fauxToolCall(
      'bash',
      { command: 'pwd' },
      { id: 'call-plan-pwd' },
    )
    const planActionRead = fauxToolCall(
      'run_action',
      { actionId: 'builtin:tiers.list', input: {} },
      { id: 'call-plan-tiers-list' },
    )
    const exitPlanCall = fauxToolCall(
      TIERS_EXIT_PLAN_MODE_TOOL,
      { plan: 'Step 1: check files\nStep 2: verify cleanly' },
      { id: 'call-exit-plan' },
    )
    const handBackCall = fauxToolCall(
      TIERS_HAND_BACK_TOOL,
      { reason: 'Step budget reached', summary: 'Checked files and awaiting planner decision.' },
      { id: 'call-hand-back' },
    )

    const snapshotNow = () => ({
      live: kernel.conversations.getConversation(conv.id),
      sdoc: kernel.plugins.getPublicSessionDoc(TIERS_PLUGIN_ID, TIERS_ORCHESTRATOR_SESSION_DOC, conv.id)
        .value as TierOrchestratorSessionView | null,
    })

    env.faux.setResponses([
      // 1. Planner step 1: inspect tools, run native read-only bash and read-only run_action
      captureStep(observed, conv.id, () => {
        stepSnapshots.push(snapshotNow())
        return fauxAssistantMessage([planBashRead, planActionRead], { stopReason: 'toolUse' })
      }),
      // 2. Planner step 2: call exit_plan_mode
      captureStep(observed, conv.id, () => {
        stepSnapshots.push(snapshotNow())
        return fauxAssistantMessage([exitPlanCall], { stopReason: 'toolUse' })
      }),
      // 3. Executor step 1 (1/1): runtime switched without mutating modelOverride/modelTier
      captureStep(observed, conv.id, () => {
        stepSnapshots.push(snapshotNow())
        return fauxAssistantMessage([execCall1], { stopReason: 'toolUse' })
      }),
      // 4. Executor step 2 (budget exceeded > 1): restricted to ONLY hand_back_to_planner, count clamped to 1
      captureStep(observed, conv.id, () => {
        stepSnapshots.push(snapshotNow())
        return fauxAssistantMessage([handBackCall], { stopReason: 'toolUse' })
      }),
      // 5. Planner step 3: hand_back_to_planner restored Planner; deliver final answer
      captureStep(observed, conv.id, () => {
        stepSnapshots.push(snapshotNow())
        return fauxAssistantMessage('Planning review complete.')
      }),
    ])

    const compBefore = kernel.conversations.getConversation(conv.id).completionSeq
    await kernel.conversations.submitInput(conv.id, 'Investigate and apply the fix')
    await kernel.conversations.waitForIdle(conv.id)
    const settled = kernel.conversations.getConversation(conv.id)
    assert.equal(settled.lastError, undefined)
    assert.ok(settled.completionSeq > compBefore)
    assert.equal(observed.length, 5)
    assert.equal(stepSnapshots.length, 5)

    // Verify Step 1 (Planner initial: pure 7-tool whitelist + active helmx.dispatch-tools orchestration tools; write/edit/update_steps stripped)
    assert.equal(observed[0]?.modelId, 'faux/flagship')
    assert.equal(observed[0]?.reasoning, 'high')
    assert.equal(ORCHESTRATOR_PLAN_TOOL_WHITELIST.size, 7)
    const allowedInPlanning = new Set<string>([
      ...ORCHESTRATOR_PLAN_TOOL_WHITELIST,
      'subagent',
      'SubagentWorkflow',
      'workflow_steer',
      ...SWARM_TOOL_NAMES,
    ])
    assert.ok(observed[0]?.toolNames.every((name) => allowedInPlanning.has(name)))
    assert.ok(observed[0]?.toolNames.includes('bash'))
    assert.ok(observed[0]?.toolNames.includes('run_action'))
    assert.ok(observed[0]?.toolNames.includes('ask_user'))
    assert.ok(observed[0]?.toolNames.includes(TIERS_EXIT_PLAN_MODE_TOOL))
    assert.ok(observed[0]?.toolNames.includes('subagent'))
    assert.ok(observed[0]?.toolNames.includes('SubagentWorkflow'))
    assert.ok(observed[0]?.toolNames.includes('swarm_create_group'))
    assert.ok(!observed[0]?.toolNames.includes('update_steps'))
    assert.ok(!observed[0]?.toolNames.includes('write'))
    assert.ok(!observed[0]?.toolNames.includes('edit'))
    assert.ok(!observed[0]?.toolNames.includes('register_artifact'))
    assert.ok(!observed[0]?.toolNames.includes(TIERS_HAND_BACK_TOOL))
    assert.ok(!observed[0]?.toolNames.includes(TIERS_SWITCH_MODEL_TOOL))
    assert.ok(observed[0]?.systemPrompt.includes(ORCHESTRATOR_PLAN_SECTION))

    // Verify Step 2 (Planner static cache before exit_plan_mode)
    assert.equal(observed[1]?.modelId, 'faux/flagship')
    assert.equal(observed[1]?.systemPrompt, observed[0]?.systemPrompt, 'planning prompt cache section must remain identical')

    // Verify Step 3 (Executor 1/1: switched model without mutating modelOverride/modelTier; update_steps & workspace tools available)
    assert.equal(observed[2]?.modelId, 'faux/workhorse')
    assert.equal(observed[2]?.reasoning, 'low')
    assert.ok(observed[2]?.toolNames.includes('write'))
    assert.ok(observed[2]?.toolNames.includes('bash'))
    assert.ok(observed[2]?.toolNames.includes('run_action'))
    assert.ok(observed[2]?.toolNames.includes('update_steps'))
    assert.ok(observed[2]?.toolNames.includes(TIERS_HAND_BACK_TOOL))
    assert.ok(!observed[2]?.toolNames.includes('ask_user'), 'execution phase must strip ask_user so clarifications route back to planner')
    assert.ok(!observed[2]?.systemPrompt.includes('<ask_user>'), 'execution phase must not inject <ask_user> prompt snippet')
    assert.ok(!observed[2]?.toolNames.includes(TIERS_EXIT_PLAN_MODE_TOOL))
    assert.ok(!observed[2]?.toolNames.includes(TIERS_SWITCH_MODEL_TOOL))
    assert.ok(observed[2]?.systemPrompt.includes(ORCHESTRATOR_EXECUTE_SECTION))
    assert.equal(stepSnapshots[2]?.live.modelTier, 'tier/auto-main')
    assert.equal(stepSnapshots[2]?.live.modelOverride, 'tier/auto-main')
    assert.equal(stepSnapshots[2]?.sdoc?.phase, 'execution')
    assert.equal(stepSnapshots[2]?.sdoc?.executionStepCount, 1)
    assert.equal(stepSnapshots[2]?.sdoc?.maxExecutionSteps, 1)

    // Verify Step 4 (Step budget exceeded: restricted to ONLY hand_back_to_planner, count clamped to 1)
    assert.equal(observed[3]?.modelId, 'faux/workhorse')
    assert.deepEqual(observed[3]?.toolNames, [TIERS_HAND_BACK_TOOL])
    assert.ok(observed[3]?.systemPrompt.includes(ORCHESTRATOR_STEP_LIMIT_SECTION))
    assert.ok(observed[3]?.systemPrompt.includes(ORCHESTRATOR_EXECUTE_SECTION))
    assert.equal(stepSnapshots[3]?.sdoc?.executionStepCount, 1)
    assert.equal(stepSnapshots[3]?.sdoc?.phase, 'execution')

    // Verify Step 5 (Returned to Planner: runtime switched back, static cache preserved)
    assert.equal(observed[4]?.modelId, 'faux/flagship')
    assert.equal(observed[4]?.reasoning, 'high')
    assert.ok(observed[4]?.toolNames.includes(TIERS_EXIT_PLAN_MODE_TOOL))
    assert.ok(observed[4]?.systemPrompt.includes(ORCHESTRATOR_PLAN_SECTION))
    assert.equal(observed[4]?.systemPrompt, observed[0]?.systemPrompt, 'returned planner prompt must remain static for KV cache reuse')

    // Verify native bash, read-only run_action, and transition presentationMeta persisted cleanly
    const detail = await kernel.conversations.getConversationDetail(conv.id)
    const toolResults = detail.entries
      .filter((e) => e.kind === 'pi.tool-result')
      .flatMap((e) => (Array.isArray(e.model) ? e.model : [])) as Array<{
      role?: string
      toolName?: string
      isError?: boolean
      content?: Array<{ type?: string; text?: string }>
      details?: Record<string, unknown>
    }>
    const pwdResult = toolResults.find((m) => m.toolName === 'bash' && m.isError === false)
    assert.ok(pwdResult !== undefined, 'native bash pwd must succeed in orchestrator planning phase')
    assert.ok((pwdResult.content?.[0]?.text ?? '').includes(env.dataDir))
    const tiersListResult = toolResults.find((m) => m.toolName === 'run_action' && m.isError === false)
    assert.ok(tiersListResult !== undefined, 'read-only run_action builtin:tiers.list must succeed in orchestrator planning phase')
    assert.ok((tiersListResult.content?.[0]?.text ?? '').includes('auto-main'))

    const exitResult = toolResults.find((m) => m.toolName === TIERS_EXIT_PLAN_MODE_TOOL)
    const exitText = exitResult?.content?.[0]?.text ?? ''
    assert.ok(exitText.includes('faux/workhorse'))
    assert.ok(!exitText.includes('Step 1: check files'), 'exit_plan_mode toolResult must not duplicate full plan body')
    const exitMeta = exitResult?.details
    assert.equal(exitMeta?.['tool'], TIERS_EXIT_PLAN_MODE_TOOL)
    assert.equal(exitMeta?.['fromPhase'], 'planning')
    assert.equal(exitMeta?.['toPhase'], 'execution')
    assert.equal(exitMeta?.['fromModel'], 'faux/flagship')
    assert.equal(exitMeta?.['toModel'], 'faux/workhorse')

    const handBackResult = toolResults.find((m) => m.toolName === TIERS_HAND_BACK_TOOL)
    const handBackText = handBackResult?.content?.[0]?.text ?? ''
    assert.ok(handBackText.startsWith('[plan review]'))
    assert.ok(handBackText.includes('scheduled step-budget review after 1 steps'))
    assert.ok(handBackText.includes('Step budget reached'))
    assert.ok(handBackText.includes('Checked files and awaiting planner decision.'))
    const handBackMeta = handBackResult?.details
    assert.equal(handBackMeta?.['tool'], TIERS_HAND_BACK_TOOL)
    assert.equal(handBackMeta?.['fromPhase'], 'execution')
    assert.equal(handBackMeta?.['toPhase'], 'planning')
    assert.equal(handBackMeta?.['executionSteps'], 1)
    assert.equal(handBackMeta?.['stepLimitReached'], true)

    assert.equal(settled.model, 'faux/flagship')
    assert.equal(settled.modelTier, 'tier/auto-main')

    // Directly verify `setConversationRuntimeModel` does not advance `stateChangeSeq` or alter `modelOverride`/`modelTier`
    const seqBeforeDirect = settled.stateChangeSeq
    const directSwitched = await kernel.conversations.setConversationRuntimeModel(conv.id, {
      model: 'faux/workhorse',
      thinkingLevel: 'low',
    })
    assert.equal(directSwitched.model, 'faux/workhorse')
    assert.equal(directSwitched.thinkingLevel, 'low')
    assert.equal(directSwitched.modelTier, 'tier/auto-main')
    assert.equal(directSwitched.modelOverride, 'tier/auto-main')
    assert.equal(directSwitched.stateChangeSeq, seqBeforeDirect)
  } finally {
    await env.close()
  }
})

test('queued followUp resets to planner before next run starts (even when plannerModel === executorModel) while mid-turn steer stays in execution', { timeout: 60_000 }, async () => {
  const env = await openOrchestratorEnv()
  try {
    const { kernel } = env.app
    // Same underlying model ID with distinct planner vs executor reasoning levels
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'same-model-auto',
      kind: 'orchestrator',
      model: 'faux/flagship',
      thinkingLevel: 'high',
      executorModel: 'faux/flagship',
      executorThinkingLevel: 'low',
      maxExecutionSteps: 8,
    })

    const conv = await kernel.conversations.createConversation({ title: 'steer-vs-followup', model: 'tier/same-model-auto' })
    const observed: ObservedCall[] = []
    const execPaused = deferred<void>()
    const inExecGate = deferred<void>()

    env.faux.setResponses([
      // Run 1 Step 1 (Planner -> exit_plan_mode)
      captureStep(observed, conv.id, () =>
        fauxAssistantMessage(
          [fauxToolCall(TIERS_EXIT_PLAN_MODE_TOOL, { plan: 'Run step' }, { id: 'exit-1' })],
          { stopReason: 'toolUse' },
        ),
      ),
      // Run 1 Step 2 (Executor pauses while test sends steer & followUp, then finishes with tool call to inspect steer)
      captureStep(observed, conv.id, async () => {
        inExecGate.resolve()
        await execPaused.promise
        return fauxAssistantMessage(
          [fauxToolCall('read', { path: 'missing.txt' }, { id: 'exec-read-1' })],
          { stopReason: 'toolUse' },
        )
      }),
      // Run 1 Step 3 (after steer: still stays in Execution with executor thinkingLevel 'low'!)
      captureStep(observed, conv.id, () => fauxAssistantMessage('Run 1 answered on executor.')),
      // Run 2 Step 1 (queued followUp: afterResponse MUST have reset back to Planner 'xhigh' BEFORE GenerationTask.prepare!)
      captureStep(observed, conv.id, () => fauxAssistantMessage('Run 2 handled in planning phase.')),
    ])

    await kernel.conversations.submitInput(conv.id, 'Start first task')
    await inExecGate.promise

    // While Run 1 is mid-execution, inject a steer AND a queued followUp
    await kernel.conversations.submitInput(conv.id, 'Mid-turn steering hint', { whenBusy: 'steer' })
    await kernel.conversations.submitInput(conv.id, 'Queued next question', { whenBusy: 'followUp' })
    execPaused.resolve()

    await kernel.conversations.waitForIdle(conv.id)
    await waitFor(async () => observed.length === 4, { timeoutMs: 10_000 })

    assert.equal(observed[0]?.reasoning, 'high', 'Run 1 Step 1 runs Planner high')
    assert.ok(observed[0]?.toolNames.includes(TIERS_EXIT_PLAN_MODE_TOOL))

    assert.equal(observed[1]?.reasoning, 'low', 'Run 1 Step 2 switches to Executor low')
    assert.ok(observed[1]?.toolNames.includes(TIERS_HAND_BACK_TOOL))

    assert.equal(observed[2]?.reasoning, 'low', 'Mid-turn steer preserves Execution phase & Executor low')
    assert.ok(observed[2]?.toolNames.includes(TIERS_HAND_BACK_TOOL))

    assert.equal(observed[3]?.reasoning, 'high', 'Queued followUp must reset to Planner high before Turn 2 starts')
    assert.ok(observed[3]?.toolNames.includes(TIERS_EXIT_PLAN_MODE_TOOL))
    assert.ok(!observed[3]?.toolNames.includes('write'))
  } finally {
    await env.close()
  }
})

test('switching off orchestrator tier cleans state and /plan takes strict precedence over orchestrator mode', { timeout: 60_000 }, async () => {
  const env = await openOrchestratorEnv()
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'auto-clean',
      kind: 'orchestrator',
      model: 'faux/flagship',
      executorModel: 'faux/workhorse',
    })

    const conv = await kernel.conversations.createConversation({ title: 'switch-and-plan', model: 'tier/auto-clean' })

    // 1. `/plan` takes strict precedence in before_turn over orchestrator section/tools
    const observedPlan: ObservedCall[] = []
    env.faux.setResponses([
      captureStep(observedPlan, conv.id, () => fauxAssistantMessage('Plan mode answered.')),
    ])
    await kernel.conversations.submitInput(conv.id, '/plan inspect repository safely')
    await kernel.conversations.waitForIdle(conv.id)
    assert.equal(observedPlan.length, 1)
    assert.ok(observedPlan[0]!.systemPrompt.includes('<plan_mode>'))
    assert.ok(!observedPlan[0]!.systemPrompt.includes('<orchestrator_planning_mode>'))
    assert.ok(observedPlan[0]!.toolNames.includes('bash'))
    assert.ok(observedPlan[0]!.toolNames.includes('run_action'))
    assert.ok(observedPlan[0]!.toolNames.includes('plan_save'))
    assert.ok(observedPlan[0]!.toolNames.includes('plan_propose'))
    assert.ok(!observedPlan[0]!.toolNames.includes('update_steps'))
    assert.ok(!observedPlan[0]!.toolNames.includes(TIERS_EXIT_PLAN_MODE_TOOL))
    assert.ok(!observedPlan[0]!.toolNames.includes(TIERS_HAND_BACK_TOOL))

    // 2. Exit /plan cleanly via pi.reset or switch model to plain concrete model -> clears modelTier & sessionDoc
    env.faux.setResponses([fauxAssistantMessage('Plain orchestrator turn.')])
    await kernel.conversations.resetConversation(conv.id)
    await kernel.conversations.submitInput(conv.id, 'Regular orchestrator question')
    await kernel.conversations.waitForIdle(conv.id)
    await waitFor(
      async () =>
        kernel.plugins.getPublicSessionDoc(TIERS_PLUGIN_ID, TIERS_ORCHESTRATOR_SESSION_DOC, conv.id).value !== null,
      { timeoutMs: 5_000 },
    )

    const updated = await kernel.conversations.updateConversation(conv.id, { model: 'faux/fast' })
    assert.equal(updated.model, 'faux/fast')
    assert.equal(updated.modelTier, undefined)
    await waitFor(
      async () =>
        kernel.plugins.getPublicSessionDoc(TIERS_PLUGIN_ID, TIERS_ORCHESTRATOR_SESSION_DOC, conv.id).value === null,
      { timeoutMs: 5_000 },
    )
  } finally {
    await env.close()
  }
})

test('maxExecutionSteps = 0 disables forced step-limit cutoff across multi-step execution', { timeout: 60_000 }, async () => {
  const env = await openOrchestratorEnv()
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'auto-unlimited',
      kind: 'orchestrator',
      model: 'faux/flagship',
      executorModel: 'faux/workhorse',
      maxExecutionSteps: 0,
    })

    const conv = await kernel.conversations.createConversation({ title: 'unlimited-steps', model: 'tier/auto-unlimited' })
    const observed: ObservedCall[] = []
    const sdocSnapshots: Array<TierOrchestratorSessionView | null> = []

    const snapDoc = () =>
      kernel.plugins.getPublicSessionDoc(TIERS_PLUGIN_ID, TIERS_ORCHESTRATOR_SESSION_DOC, conv.id)
        .value as TierOrchestratorSessionView | null

    env.faux.setResponses([
      // Planner: enter execution
      captureStep(observed, conv.id, () => {
        sdocSnapshots.push(snapDoc())
        return fauxAssistantMessage(
          [fauxToolCall(TIERS_EXIT_PLAN_MODE_TOOL, { plan: 'Execute 3 consecutive steps' }, { id: 'exit-unlim' })],
          { stopReason: 'toolUse' },
        )
      }),
      // Executor step 1
      captureStep(observed, conv.id, () => {
        sdocSnapshots.push(snapDoc())
        return fauxAssistantMessage([fauxToolCall('read', { path: 'a.txt' }, { id: 'read-1' })], { stopReason: 'toolUse' })
      }),
      // Executor step 2
      captureStep(observed, conv.id, () => {
        sdocSnapshots.push(snapDoc())
        return fauxAssistantMessage([fauxToolCall('read', { path: 'b.txt' }, { id: 'read-2' })], { stopReason: 'toolUse' })
      }),
      // Executor step 3 (still has full workspace tools & no step-limit banner, then finishes)
      captureStep(observed, conv.id, () => {
        sdocSnapshots.push(snapDoc())
        return fauxAssistantMessage('Completed all 3 execution steps without cutoff.')
      }),
    ])

    await kernel.conversations.submitInput(conv.id, 'Run multiple execution steps')
    await kernel.conversations.waitForIdle(conv.id)
    assert.equal(kernel.conversations.getConversation(conv.id).lastError, undefined)
    assert.equal(observed.length, 4)

    for (const idx of [1, 2, 3]) {
      assert.equal(observed[idx]?.modelId, 'faux/workhorse')
      assert.ok(observed[idx]?.toolNames.includes('write'), `execution step ${idx} must retain write tool`)
      assert.ok(observed[idx]?.toolNames.includes(TIERS_HAND_BACK_TOOL))
      assert.ok(!observed[idx]?.systemPrompt.includes(ORCHESTRATOR_STEP_LIMIT_SECTION))
    }

    assert.equal(sdocSnapshots[1]?.executionStepCount, 1)
    assert.equal(sdocSnapshots[2]?.executionStepCount, 2)
    assert.equal(sdocSnapshots[3]?.executionStepCount, 3)
    assert.equal(sdocSnapshots[3]?.maxExecutionSteps, 0)
  } finally {
    await env.close()
  }
})

test('agent_spawn hook defaults omitted model to executorModel across tree, honors explicit concrete/single-tier overrides and resume model, and rejects orchestrator tiers', { timeout: 60_000 }, async () => {
  const env = await openOrchestratorEnv({ defaultModel: 'faux/workhorse' })
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'coder',
      model: 'faux/workhorse',
      thinkingLevel: 'medium',
      description: 'Single coder tier',
    })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'auto-exec',
      kind: 'orchestrator',
      model: 'faux/flagship',
      thinkingLevel: 'high',
      executorModel: 'faux/fast',
      executorThinkingLevel: 'low',
    })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'auto-no-effort',
      kind: 'orchestrator',
      model: 'faux/flagship',
      executorModel: 'faux/fast',
    })

    const assistantProfile = await kernel.profiles.get('assistant')
    assert.ok(assistantProfile !== undefined)
    await kernel.profiles.save({
      ...assistantProfile,
      id: 'specialist',
      name: 'Specialist',
      model: 'faux/flagship',
      thinkingLevel: 'high',
    })

    const rootConv = await kernel.conversations.createConversation({ title: 'orch-tree-root', model: 'tier/auto-exec' })
    const rootNoEffort = await kernel.conversations.createConversation({
      title: 'orch-tree-no-effort',
      model: 'tier/auto-no-effort',
    })

    const spawnObserved: Array<{ modelId: string; reasoning: unknown; hasCatalog: boolean }> = []
    const recordFaux = (replyText: string) =>
      (context: TranscriptContext, options: SimpleStreamOptions | undefined, _state: unknown, model: Model<string>) => {
        const sections = extractSystemSections(context.messages)
        spawnObserved.push({
          modelId: `${model.provider}/${model.id}`,
          reasoning: options?.reasoning,
          hasCatalog: Object.hasOwn(sections, 'tiers.catalog'),
        })
        return fauxAssistantMessage(replyText)
      }

    // Seed 1 planner turn on rootConv so fork:true also has a forkable anchor
    env.faux.setResponses([
      fauxAssistantMessage('seed root reply'),
      recordFaux('plain-child'),
      recordFaux('specialist-child'),
      recordFaux('override-child'),
      recordFaux('resumed-elevated-child'),
      recordFaux('tier-override-child'),
      recordFaux('grandchild-default'),
      recordFaux('grandchild-override'),
      recordFaux('forked-default-child'),
      recordFaux('forked-override-child'),
      recordFaux('no-effort-default-child'),
      recordFaux('no-effort-explicit-effort-child'),
    ])
    await kernel.conversations.submitInput(rootConv.id, 'seed turn')
    await kernel.conversations.waitForIdle(rootConv.id)

    let plainChildId: number | undefined
    let noEffortChildId: number | undefined

    // a) Plain subagent (no model, allowing depth 2 so nested grandchild tests can spawn under it) -> executorModel + executorThinkingLevel
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: rootConv.id,
      prompt: 'plain child task',
      meta: { 'builtin:workflow': { maxSubagentDepth: 2 } },
      onResolved: (info) => {
        plainChildId = info.conversationId
      },
    })
    assert.ok(plainChildId !== undefined)

    // Verify before_turn hook directly on child omits tiers.catalog too
    const childHook = await kernel.plugins.runHook('before_turn', {
      conversation: kernel.conversations.getConversation(plainChildId!),
      inputs: [],
      messages: [],
      sections: [],
      tools: [],
    } as never)
    const childCatalog =
      childHook.action === 'transform'
        ? (childHook.value as { sections: Array<{ id: string; text: string }> }).sections.find(
            (s) => s.id === 'tiers.catalog',
          )?.text
        : undefined
    assert.equal(childCatalog, undefined, 'child under orchestrator tree must suppress <available_model_tiers>')

    // b) Specialist Profile bound to flagship (omitted model) -> defaults to executorModel + executorThinkingLevel
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: rootConv.id,
      agentType: 'specialist',
      prompt: 'specialist child task',
    })

    // c) Explicit concrete model + high effort -> HONORED, and resuming without model preserves the elevated model!
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: rootConv.id,
      agentId: 'child-elevated',
      model: 'faux/flagship',
      effort: 'high',
      prompt: 'explicit elevation task',
    })
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: rootConv.id,
      resume: 'child-elevated',
      prompt: 'resumed elevated task without model override',
    })

    // d) Explicit single tier model -> HONORED (faux/workhorse + medium preset)
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: rootConv.id,
      model: 'tier/coder',
      prompt: 'tier coder override task',
    })

    // e) Nested grandchild without model -> defaults to executorModel; with explicit model -> HONORED
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: plainChildId!,
      prompt: 'nested grandchild default task',
    })
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: plainChildId!,
      model: 'faux/flagship',
      effort: 'high',
      prompt: 'nested grandchild elevated task',
    })

    // f) Forked subagent without model -> defaults to executorModel; with explicit model -> HONORED
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: rootConv.id,
      fork: true,
      prompt: 'forked default child task',
    })
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: rootConv.id,
      fork: true,
      model: 'faux/flagship',
      effort: 'high',
      prompt: 'forked elevated child task',
    })

    assert.equal(spawnObserved.length, 9)
    // Default spawns: plain (0), specialist (1), grandchild-default (5), forked-default (7)
    for (const idx of [0, 1, 5, 7]) {
      assert.equal(spawnObserved[idx]?.modelId, 'faux/fast', `default spawn #${idx} must run on executorModel faux/fast`)
      assert.equal(spawnObserved[idx]?.reasoning, 'low', `default spawn #${idx} must run on executorThinkingLevel low`)
      assert.equal(spawnObserved[idx]?.hasCatalog, false, `spawn #${idx} must suppress tiers.catalog`)
    }
    // Explicit flagship elevations: override (2), resumed-elevated (3), grandchild-override (6), forked-override (8)
    for (const idx of [2, 3, 6, 8]) {
      assert.equal(spawnObserved[idx]?.modelId, 'faux/flagship', `elevated spawn #${idx} must honor explicit faux/flagship`)
      assert.equal(spawnObserved[idx]?.reasoning, 'high', `elevated spawn #${idx} must honor explicit high effort`)
      assert.equal(spawnObserved[idx]?.hasCatalog, false, `spawn #${idx} must suppress tiers.catalog`)
    }
    // Explicit single tier/coder (4)
    assert.equal(spawnObserved[4]?.modelId, 'faux/workhorse')
    assert.equal(spawnObserved[4]?.reasoning, 'medium')
    assert.equal(spawnObserved[4]?.hasCatalog, false)

    // g) Malformed ref & explicit orchestrator tier still fail honestly rather than being silently rewritten
    await assertRejectsCode(
      () =>
        kernel.agentSpawn.spawnAgent({
          parentConversationId: rootConv.id,
          model: 'badref',
          prompt: 'malformed model',
        }),
      'validation_error',
    )
    await assertRejectsCode(
      () =>
        kernel.agentSpawn.spawnAgent({
          parentConversationId: rootConv.id,
          model: 'tier/auto-exec',
          prompt: 'orchestrator model not allowed',
        }),
      'orchestrator_tier_human_only',
    )
    await assertRejectsCode(
      () =>
        kernel.agentSpawn.spawnAgent({
          parentConversationId: rootConv.id,
          resume: 'child-elevated',
          model: 'tier/auto-exec',
          prompt: 'orchestrator model not allowed on resume',
        }),
      'orchestrator_tier_human_only',
    )

    // h) Orchestrator without executorThinkingLevel leaves thinkingLevelOverride unset when effort omitted,
    //    and honors explicit effort on executorModel when model is omitted
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: rootNoEffort.id,
      prompt: 'default without effort',
      onResolved: (info) => {
        noEffortChildId = info.conversationId
      },
    })
    assert.ok(noEffortChildId !== undefined)
    const noEffortChildSnap = kernel.conversations.getConversation(noEffortChildId!)
    assert.equal(noEffortChildSnap.model, 'faux/fast')
    assert.equal(noEffortChildSnap.thinkingLevelOverride, undefined)
    assert.equal(spawnObserved[9]?.modelId, 'faux/fast')
    assert.notEqual(spawnObserved[9]?.reasoning, 'high')

    await kernel.agentSpawn.spawnAgent({
      parentConversationId: rootNoEffort.id,
      effort: 'medium',
      prompt: 'default model with explicit effort',
    })
    assert.equal(spawnObserved[10]?.modelId, 'faux/fast')
    assert.equal(spawnObserved[10]?.reasoning, 'medium')
  } finally {
    await env.close()
  }
})

test('one-turn borrow works on orchestrator conversations (explicit override & inherited Profile) and auto-restores orchestrator planning mode after settle', { timeout: 60_000 }, async () => {
  const env = await openOrchestratorEnv()
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'coder',
      model: 'faux/workhorse',
      description: 'Single coder',
    })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'claude-auto',
      kind: 'orchestrator',
      model: 'faux/flagship',
      thinkingLevel: 'high',
      executorModel: 'faux/fast',
      executorThinkingLevel: 'low',
    })

    // 1. Explicit orchestrator conversation: arm one-turn borrow -> single-model turn -> auto-restore to Planner
    const conv = await kernel.conversations.createConversation({ title: 'orch-borrow', model: 'tier/claude-auto' })
    const armed = (await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set_borrow', {
      conversationId: conv.id,
      model: 'faux/workhorse',
      effort: 'medium',
    })) as { phase: string }
    assert.equal(armed.phase, 'armed')

    const observedExplicit: ObservedCall[] = []
    env.faux.setResponses([
      captureStep(observedExplicit, conv.id, () => fauxAssistantMessage('Borrowed single turn done.')),
      captureStep(observedExplicit, conv.id, () => fauxAssistantMessage('Back in orchestrator planning phase.')),
    ])

    await kernel.conversations.submitInput(conv.id, 'Run a quick one-turn single-model check')
    await kernel.conversations.waitForIdle(conv.id)
    await waitFor(
      async () =>
        kernel.conversations.getConversation(conv.id).modelTier === 'tier/claude-auto' &&
        kernel.plugins.getPublicSessionDoc(TIERS_PLUGIN_ID, TIERS_BORROW_SESSION_DOC, conv.id).value === null &&
        (
          kernel.plugins.getPublicSessionDoc(TIERS_PLUGIN_ID, TIERS_ORCHESTRATOR_SESSION_DOC, conv.id)
            .value as TierOrchestratorSessionView | null
        )?.phase === 'planning',
      { timeoutMs: 5_000 },
    )

    assert.equal(observedExplicit.length, 1)
    assert.equal(observedExplicit[0]?.modelId, 'faux/workhorse')
    assert.equal(observedExplicit[0]?.reasoning, 'medium')
    assert.ok(observedExplicit[0]?.toolNames.includes('write'), 'borrowed single turn must expose normal write tool')
    assert.ok(!observedExplicit[0]?.toolNames.includes(TIERS_EXIT_PLAN_MODE_TOOL))
    assert.ok(!observedExplicit[0]?.systemPrompt.includes(ORCHESTRATOR_PLAN_SECTION))
    assert.ok(observedExplicit[0]?.systemPrompt.includes('tier/coder'), 'borrowed single turn should inject normal catalog')

    const restoredConv = kernel.conversations.getConversation(conv.id)
    assert.equal(restoredConv.model, 'faux/flagship')
    assert.equal(restoredConv.modelTier, 'tier/claude-auto')
    assert.equal(restoredConv.modelOverride, 'tier/claude-auto')
    assert.equal(restoredConv.thinkingLevelOverride, undefined)

    await kernel.conversations.submitInput(conv.id, 'Discuss next architecture step')
    await kernel.conversations.waitForIdle(conv.id)
    assert.equal(observedExplicit.length, 2)
    assert.equal(observedExplicit[1]?.modelId, 'faux/flagship')
    assert.equal(observedExplicit[1]?.reasoning, 'high')
    assert.ok(observedExplicit[1]?.toolNames.includes(TIERS_EXIT_PLAN_MODE_TOOL))
    assert.ok(!observedExplicit[1]?.toolNames.includes('write'))
    assert.ok(observedExplicit[1]?.systemPrompt.includes(ORCHESTRATOR_PLAN_SECTION))

    // 2. Standby first-message `meta['builtin:tiers']` borrow on Profile-inherited orchestrator conversation
    const existingAssistant = await kernel.profiles.get('assistant')
    assert.ok(existingAssistant !== undefined)
    try {
      await kernel.profiles.save({ ...existingAssistant, model: 'tier/claude-auto' })
      const standbyConv = await kernel.conversations.createConversation({ title: 'standby-orch-borrow' })
      assert.equal(standbyConv.modelTier, 'tier/claude-auto')
      assert.equal(standbyConv.modelOverride, undefined)

      const observedStandby: ObservedCall[] = []
      env.faux.setResponses([
        captureStep(observedStandby, standbyConv.id, () => fauxAssistantMessage('Standby borrowed turn done.')),
      ])

      await kernel.conversations.submitInput(standbyConv.id, 'Run standby borrowed turn', {
        meta: { 'builtin:tiers': { borrowModel: 'faux/workhorse' } },
      } as never)
      await kernel.conversations.waitForIdle(standbyConv.id)
      await waitFor(
        async () =>
          kernel.conversations.getConversation(standbyConv.id).modelTier === 'tier/claude-auto' &&
          kernel.plugins.getPublicSessionDoc(TIERS_PLUGIN_ID, TIERS_BORROW_SESSION_DOC, standbyConv.id).value === null &&
          (
            kernel.plugins.getPublicSessionDoc(TIERS_PLUGIN_ID, TIERS_ORCHESTRATOR_SESSION_DOC, standbyConv.id)
              .value as TierOrchestratorSessionView | null
          )?.phase === 'planning',
        { timeoutMs: 5_000 },
      )

      assert.equal(observedStandby.length, 1)
      assert.equal(observedStandby[0]?.modelId, 'faux/workhorse')
      assert.ok(observedStandby[0]?.toolNames.includes('write'))
      assert.ok(!observedStandby[0]?.systemPrompt.includes(ORCHESTRATOR_PLAN_SECTION))

      const restoredStandby = kernel.conversations.getConversation(standbyConv.id)
      assert.equal(restoredStandby.modelOverride, undefined)
      assert.equal(restoredStandby.modelTier, 'tier/claude-auto')
      assert.equal(restoredStandby.model, 'faux/flagship')
    } finally {
      await kernel.profiles.save({ ...existingAssistant, model: undefined })
    }
  } finally {
    await env.close()
  }
})

test('planning phase dynamically exposes helmx.dispatch-tools (workflow + all 11 swarm tools), unlocks <available_profiles>, removes tools on plugin disable, and preserves strict /plan precedence', { timeout: 60_000 }, async () => {
  const env = await openOrchestratorEnv()
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'orch-plan-tools',
      kind: 'orchestrator',
      model: 'faux/flagship',
      thinkingLevel: 'high',
      executorModel: 'faux/fast',
      executorThinkingLevel: 'low',
    })
    const assistant = await kernel.profiles.get('assistant')
    assert.ok(assistant !== undefined)
    await kernel.profiles.save({
      ...assistant,
      id: 'reviewer',
      name: 'Reviewer',
      system: 'Code review specialist.',
    })

    const conv = await kernel.conversations.createConversation({ title: 'planner-orch-tools', model: 'tier/orch-plan-tools' })
    const observed: ObservedCall[] = []

    // 1. Initial Planning Phase: workflow + swarm_create_group exposed, <available_profiles> unlocked, direct mutation tools stripped
    env.faux.setResponses([
      captureStep(observed, conv.id, () => fauxAssistantMessage('Planning ready.')),
    ])
    await kernel.conversations.submitInput(conv.id, 'Plan parallel work')
    await kernel.conversations.waitForIdle(conv.id)
    assert.equal(observed.length, 1)
    assert.ok(observed[0]!.toolNames.includes('subagent'))
    assert.ok(observed[0]!.toolNames.includes('SubagentWorkflow'))
    assert.ok(observed[0]!.toolNames.includes('swarm_create_group'))
    assert.ok(observed[0]!.toolNames.includes(TIERS_EXIT_PLAN_MODE_TOOL))
    assert.ok(!observed[0]!.toolNames.includes('write'))
    assert.ok(!observed[0]!.toolNames.includes('edit'))
    assert.ok(!observed[0]!.toolNames.includes('register_artifact'))
    assert.ok(!observed[0]!.toolNames.includes('update_steps'))
    assert.ok(!observed[0]!.toolNames.includes(TIERS_SWITCH_MODEL_TOOL))
    assert.ok(!observed[0]!.toolNames.includes('cleanup_worktree'))
    assert.ok(observed[0]!.systemPrompt.includes('<available_profiles>'), 'Planning Phase must unlock <available_profiles>')
    assert.ok(observed[0]!.systemPrompt.includes('reviewer'))

    // 2. Activate a Swarm group on the orchestrator conversation: all coordinator Swarm tools are exposed in Planning Phase
    const createdGroup = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'create_group',
      { title: 'Planner Squad' },
      { conversationId: conv.id },
    )) as { groupId: string }
    const coordSwarmTools = SWARM_TOOL_NAMES.filter((name) => name !== 'swarm_create_group')

    env.faux.setResponses([
      captureStep(observed, conv.id, () => fauxAssistantMessage('Swarm coordinator planning ready.')),
    ])
    await kernel.conversations.submitInput(conv.id, 'Coordinate swarm workers')
    await kernel.conversations.waitForIdle(conv.id)
    assert.equal(observed.length, 2)
    for (const toolName of coordSwarmTools) {
      assert.ok(
        observed[1]!.toolNames.includes(toolName),
        `active Swarm coordinator in Planning Phase must expose ${toolName}`,
      )
    }
    assert.ok(!observed[1]!.toolNames.includes('swarm_create_group'), 'active coordinator hides swarm_create_group')
    assert.ok(!observed[1]!.toolNames.includes('write'))
    assert.ok(!observed[1]!.toolNames.includes('edit'))
    assert.ok(observed[1]!.systemPrompt.includes('<available_profiles>'))

    // 3. Strict /plan precedence: strips ALL dispatch & orchestration tools (workflow + swarm) and suppresses <available_profiles>
    env.faux.setResponses([
      captureStep(observed, conv.id, () => fauxAssistantMessage('Strict read-only plan reply.')),
    ])
    await kernel.conversations.submitInput(conv.id, '/plan draft a read-only architecture plan')
    await kernel.conversations.waitForIdle(conv.id)
    assert.equal(observed.length, 3)
    assert.ok(observed[2]!.systemPrompt.includes('<plan_mode>'))
    assert.ok(!observed[2]!.systemPrompt.includes('<orchestrator_planning_mode>'))
    assert.ok(!observed[2]!.systemPrompt.includes('<available_profiles>'), '/plan must suppress <available_profiles>')
    for (const forbidden of ['subagent', 'SubagentWorkflow', ...SWARM_TOOL_NAMES, TIERS_EXIT_PLAN_MODE_TOOL, 'write', 'edit']) {
      assert.ok(!observed[2]!.toolNames.includes(forbidden), `/plan must strip ${forbidden}`)
    }

    // Close group & exit /plan via reset so we can test disabling workflow & swarm plugins cleanly
    await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId: createdGroup.groupId }, { conversationId: conv.id })
    await kernel.conversations.resetConversation(conv.id)

    // 4. Disabling builtin:workflow immediately removes subagent/SubagentWorkflow from Planning Phase (no phantom tools)
    await kernel.plugins.disable(WORKFLOW_PLUGIN_ID)
    env.faux.setResponses([
      captureStep(observed, conv.id, () => fauxAssistantMessage('Workflow disabled planning.')),
    ])
    await kernel.conversations.submitInput(conv.id, 'Plan without workflow plugin')
    await kernel.conversations.waitForIdle(conv.id)
    assert.equal(observed.length, 4)
    assert.ok(!observed[3]!.toolNames.includes('subagent'))
    assert.ok(!observed[3]!.toolNames.includes('SubagentWorkflow'))
    assert.ok(observed[3]!.toolNames.includes('swarm_create_group'))

    // 5. Disabling builtin:swarm immediately removes all swarm_* tools from Planning Phase too
    await kernel.plugins.disable(SWARM_PLUGIN_ID)
    env.faux.setResponses([
      captureStep(observed, conv.id, () => fauxAssistantMessage('Swarm disabled planning.')),
    ])
    await kernel.conversations.submitInput(conv.id, 'Plan without swarm plugin')
    await kernel.conversations.waitForIdle(conv.id)
    assert.equal(observed.length, 5)
    for (const swarmTool of SWARM_TOOL_NAMES) {
      assert.ok(!observed[4]!.toolNames.includes(swarmTool))
    }
    assert.ok(!observed[4]!.systemPrompt.includes('<available_profiles>'))
    assert.ok(observed[4]!.toolNames.includes(TIERS_EXIT_PLAN_MODE_TOOL))
  } finally {
    await env.close()
  }
})

test('swarm_dispatch_worker (create & forkFrom coordinator) inherits executorModel, honors explicit elevation, rejects orchestrator tiers, keeps depth-1 board tools, and wakes coordinator on Planner', { timeout: 60_000 }, async () => {
  const env = await openOrchestratorEnv({ defaultModel: 'faux/workhorse' })
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'strong',
      model: 'faux/workhorse',
      thinkingLevel: 'medium',
      description: 'Single strong tier',
    })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'auto-swarm',
      kind: 'orchestrator',
      model: 'faux/flagship',
      thinkingLevel: 'high',
      executorModel: 'faux/fast',
      executorThinkingLevel: 'low',
    })

    const assistant = await kernel.profiles.get('assistant')
    assert.ok(assistant !== undefined)
    await kernel.profiles.save({
      ...assistant,
      id: 'specialist',
      name: 'Specialist',
      model: 'faux/flagship',
      thinkingLevel: 'high',
    })

    const coordConv = await kernel.conversations.createConversation({
      title: 'swarm-orch-coord',
      model: 'tier/auto-swarm',
    })
    assert.equal(coordConv.model, 'faux/flagship')
    assert.equal(coordConv.modelTier, 'tier/auto-swarm')

    // Seed 1 planner turn on coordinator so forkFrom: 'coordinator' has a clean anchor
    env.faux.setResponses([fauxAssistantMessage('Coordinator context seeded.')])
    await kernel.conversations.submitInput(coordConv.id, 'Seed coordinator planning context')
    await kernel.conversations.waitForIdle(coordConv.id)

    const { groupId } = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'create_group',
      { title: 'Executor Inheritance Squad' },
      { conversationId: coordConv.id },
    )) as { groupId: string }

    const callsByActor = new Map<string, ObservedCall[]>()
    const setActorResponses = (
      queues: Record<string, Array<() => ReturnType<typeof fauxAssistantMessage>>>,
    ) => {
      const cursors = new Map<string, number>()
      const dispatch = (
        context: TranscriptContext,
        options: SimpleStreamOptions | undefined,
        _state: unknown,
        model: Model<string>,
      ) => {
        const sections = extractSystemSections(context.messages)
        const systemPrompt = Object.values(sections).join('\n')
        const entry: ObservedCall = {
          modelId: `${model.provider}/${model.id}`,
          reasoning: options?.reasoning,
          systemPrompt,
          toolNames: getCurrentTools(context.messages).map((t) => t.name),
        }
        // Identify caller by role/name in <active_swarm_group> (known immediately, no race with dispatch_worker return)
        const workerMatch = /<active_swarm_group[^>]*role="worker" name="([^"]+)"/.exec(systemPrompt)
        const actor = workerMatch ? workerMatch[1]! : 'coordinator'
        const list = callsByActor.get(actor) ?? []
        list.push(entry)
        callsByActor.set(actor, list)
        const queue = queues[actor]
        const idx = cursors.get(actor) ?? 0
        cursors.set(actor, idx + 1)
        const step = queue?.[idx]
        return step ? step() : fauxAssistantMessage(`${actor} fallback`)
      }
      env.faux.setResponses(Array.from({ length: 16 }, () => dispatch))
    }

    const isSettled = (convId: number): boolean => {
      const s = kernel.conversations.getConversation(convId).status
      return s === 'idle' || s === 'done'
    }

    // 1. Fresh worker (`createConversation` path) with specialist Profile (bound to flagship/high) and omitted model:
    //    must inherit coordinator's executorModel (`faux/fast`) + executorThinkingLevel (`low`) AND keep board tools!
    setActorResponses({
      'worker-create': [
        () =>
          fauxAssistantMessage(
            [
              fauxToolCall(
                'swarm_board_post',
                { to: ['coordinator'], wake: true, kind: 'done', body: 'Create worker done on executor.' },
                { id: 'w-create-post' },
              ),
            ],
            { stopReason: 'toolUse' },
          ),
        () => fauxAssistantMessage('Create worker settled.'),
      ],
      coordinator: [() => fauxAssistantMessage('Coordinator Planner received report.')],
    })
    const wCreate = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'dispatch_worker',
      {
        groupId,
        name: 'worker-create',
        profileId: 'specialist',
        prompt: 'Implement slice A',
      },
      { conversationId: coordConv.id },
    )) as { workerConversationId: number }

    // Verify immediate conversation snapshot + wait for worker & coordinator wakeup to settle
    const createSnap = kernel.conversations.getConversation(wCreate.workerConversationId)
    assert.equal(createSnap.model, 'faux/fast', 'createConversation worker must inherit executorModel over specialist Profile')
    assert.equal(createSnap.modelOverride, 'faux/fast')
    assert.equal(createSnap.thinkingLevel, 'low')
    assert.equal(createSnap.modelTier, undefined)

    await waitFor(
      async () =>
        (callsByActor.get('worker-create')?.length ?? 0) >= 2 &&
        (callsByActor.get('coordinator')?.length ?? 0) >= 1 &&
        kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0 &&
        isSettled(wCreate.workerConversationId) &&
        isSettled(coordConv.id),
      { timeoutMs: 15_000 },
    )
    const createWorkerCall = callsByActor.get('worker-create')![0]!
    assert.equal(createWorkerCall.modelId, 'faux/fast')
    assert.equal(createWorkerCall.reasoning, 'low')
    // Depth-1 Swarm worker keeps board communication tools while having dispatch entry tools stripped
    for (const keepTool of ['swarm_board_post', 'swarm_board_read', 'swarm_board_status', 'swarm_inspect_worker']) {
      assert.ok(createWorkerCall.toolNames.includes(keepTool), `depth-1 Swarm worker must keep ${keepTool}`)
    }
    for (const stripTool of ['swarm_dispatch_worker', 'subagent', 'SubagentWorkflow']) {
      assert.ok(!createWorkerCall.toolNames.includes(stripTool), `depth-1 Swarm worker must strip ${stripTool}`)
    }
    // Coordinator wakeup from Swarm report must land back on Planner (faux/flagship, high) in Planning Phase!
    const coordWakeupCall = callsByActor.get('coordinator')![0]!
    assert.equal(coordWakeupCall.modelId, 'faux/flagship')
    assert.equal(coordWakeupCall.reasoning, 'high')
    assert.ok(coordWakeupCall.systemPrompt.includes(ORCHESTRATOR_PLAN_SECTION))
    assert.ok(coordWakeupCall.toolNames.includes('swarm_dispatch_worker'))
    assert.ok(!coordWakeupCall.toolNames.includes('write'))

    // 2. Forked worker (`forkFrom: 'coordinator'` path) with specialist Profile and omitted model:
    //    must unwrap coordinator's orchestrator tier to executorModel (`faux/fast`) + `low` (NOT planner or specialist flagship!)
    setActorResponses({
      'worker-fork': [
        () =>
          fauxAssistantMessage(
            [
              fauxToolCall(
                'swarm_board_post',
                { to: ['coordinator'], wake: false, kind: 'done', body: 'Fork worker done.' },
                { id: 'w-fork-post' },
              ),
            ],
            { stopReason: 'toolUse' },
          ),
        () => fauxAssistantMessage('Fork worker settled.'),
      ],
    })
    const wFork = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'dispatch_worker',
      {
        groupId,
        name: 'worker-fork',
        forkFrom: 'coordinator',
        profileId: 'specialist',
        prompt: 'Implement slice B from forked context',
      },
      { conversationId: coordConv.id },
    )) as { workerConversationId: number }

    const forkSnap = kernel.conversations.getConversation(wFork.workerConversationId)
    assert.equal(forkSnap.model, 'faux/fast', 'forkFrom coordinator worker must inherit executorModel even with specialist Profile')
    assert.equal(forkSnap.modelOverride, 'faux/fast')
    assert.equal(forkSnap.thinkingLevel, 'low')
    assert.equal(forkSnap.modelTier, undefined)

    await waitFor(
      async () =>
        (callsByActor.get('worker-fork')?.length ?? 0) >= 2 &&
        kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0 &&
        isSettled(wFork.workerConversationId),
      { timeoutMs: 15_000 },
    )
    const forkWorkerCall = callsByActor.get('worker-fork')![0]!
    assert.equal(forkWorkerCall.modelId, 'faux/fast')
    assert.equal(forkWorkerCall.reasoning, 'low')
    for (const keepTool of ['swarm_board_post', 'swarm_board_read', 'swarm_board_status', 'swarm_inspect_worker']) {
      assert.ok(forkWorkerCall.toolNames.includes(keepTool), `forked depth-1 Swarm worker must keep ${keepTool}`)
    }
    for (const stripTool of ['swarm_dispatch_worker', 'subagent', 'SubagentWorkflow']) {
      assert.ok(!forkWorkerCall.toolNames.includes(stripTool), `forked depth-1 Swarm worker must strip ${stripTool}`)
    }

    // 3. Explicit concrete model elevation on create path -> honored (`faux/flagship`, `high`)
    setActorResponses({
      'worker-elevated': [
        () =>
          fauxAssistantMessage(
            [
              fauxToolCall(
                'swarm_board_post',
                { to: ['coordinator'], wake: false, kind: 'done', body: 'Elevated audit done.' },
                { id: 'w-elev-post' },
              ),
            ],
            { stopReason: 'toolUse' },
          ),
        () => fauxAssistantMessage('Elevated worker settled.'),
      ],
    })
    const wElev = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'dispatch_worker',
      {
        groupId,
        name: 'worker-elevated',
        model: 'faux/flagship',
        effort: 'high',
        prompt: 'High-difficulty security audit',
      },
      { conversationId: coordConv.id },
    )) as { workerConversationId: number }
    const elevSnap = kernel.conversations.getConversation(wElev.workerConversationId)
    assert.equal(elevSnap.model, 'faux/flagship')
    assert.equal(elevSnap.thinkingLevel, 'high')
    await waitFor(
      async () =>
        (callsByActor.get('worker-elevated')?.length ?? 0) >= 2 &&
        kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0 &&
        isSettled(wElev.workerConversationId),
      { timeoutMs: 15_000 },
    )
    assert.equal(callsByActor.get('worker-elevated')![0]!.modelId, 'faux/flagship')
    assert.equal(callsByActor.get('worker-elevated')![0]!.reasoning, 'high')

    // 4. Explicit single tier on forkFrom coordinator path -> honored (`faux/workhorse`, `medium`)
    setActorResponses({
      'worker-tier': [
        () =>
          fauxAssistantMessage(
            [
              fauxToolCall(
                'swarm_board_post',
                { to: ['coordinator'], wake: false, kind: 'done', body: 'Tier worker done.' },
                { id: 'w-tier-post' },
              ),
            ],
            { stopReason: 'toolUse' },
          ),
        () => fauxAssistantMessage('Tier worker settled.'),
      ],
    })
    const wTier = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'dispatch_worker',
      {
        groupId,
        name: 'worker-tier',
        forkFrom: 'coordinator',
        model: 'tier/strong',
        prompt: 'Single-tier workhorse task',
      },
      { conversationId: coordConv.id },
    )) as { workerConversationId: number }
    const tierSnap = kernel.conversations.getConversation(wTier.workerConversationId)
    assert.equal(tierSnap.model, 'faux/workhorse')
    assert.equal(tierSnap.thinkingLevel, 'medium')
    await waitFor(
      async () =>
        (callsByActor.get('worker-tier')?.length ?? 0) >= 2 &&
        kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0 &&
        isSettled(wTier.workerConversationId),
      { timeoutMs: 15_000 },
    )
    assert.equal(callsByActor.get('worker-tier')![0]!.modelId, 'faux/workhorse')
    assert.equal(callsByActor.get('worker-tier')![0]!.reasoning, 'medium')

    // 5. Reject explicit orchestrator tier on both create and forkFrom paths with 400 orchestrator_tier_human_only
    await assertRejectsCode(
      () =>
        kernel.plugins.invokeAction(
          SWARM_PLUGIN_ID,
          'dispatch_worker',
          {
            groupId,
            name: 'worker-bad-create',
            model: 'tier/auto-swarm',
            prompt: 'must fail',
          },
          { conversationId: coordConv.id },
        ),
      'orchestrator_tier_human_only',
    )
    await assertRejectsCode(
      () =>
        kernel.plugins.invokeAction(
          SWARM_PLUGIN_ID,
          'dispatch_worker',
          {
            groupId,
            name: 'worker-bad-fork',
            forkFrom: 'coordinator',
            model: 'tier/auto-swarm',
            prompt: 'must fail',
          },
          { conversationId: coordConv.id },
        ),
      'orchestrator_tier_human_only',
    )

    await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId }, { conversationId: coordConv.id })
  } finally {
    await env.close()
  }
})

test('non-human agent wakeups (idle & queued followUp during execution) and runChangedDuringExec restore planning phase and plannerModel', { timeout: 60_000 }, async () => {
  const env = await openOrchestratorEnv()
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'auto-wakeup',
      kind: 'orchestrator',
      model: 'faux/flagship',
      thinkingLevel: 'high',
      executorModel: 'faux/fast',
      executorThinkingLevel: 'low',
      maxExecutionSteps: 8,
    })

    const conv = await kernel.conversations.createConversation({ title: 'agent-wakeup-orch', model: 'tier/auto-wakeup' })

    // 1. Idle orchestrator conversation whose runtime model drifted to executorModel:
    //    waking with origin: 'agent' (e.g. Swarm board report) must normalize to planning + plannerModel BEFORE turn starts!
    await kernel.conversations.setConversationRuntimeModel(conv.id, {
      model: 'faux/fast',
      thinkingLevel: 'low',
    })
    assert.equal(kernel.conversations.getConversation(conv.id).model, 'faux/fast')

    const observedIdleWake: ObservedCall[] = []
    env.faux.setResponses([
      captureStep(observedIdleWake, conv.id, () => fauxAssistantMessage('Planner handled idle agent wakeup.')),
    ])
    await kernel.conversations.submitInput(conv.id, '<swarm_board_report>slice done</swarm_board_report>', {
      origin: 'agent',
    })
    await kernel.conversations.waitForIdle(conv.id)
    assert.equal(observedIdleWake.length, 1)
    assert.equal(observedIdleWake[0]?.modelId, 'faux/flagship')
    assert.equal(observedIdleWake[0]?.reasoning, 'high')
    assert.ok(observedIdleWake[0]?.toolNames.includes(TIERS_EXIT_PLAN_MODE_TOOL))
    assert.ok(!observedIdleWake[0]?.toolNames.includes('write'))
    assert.ok(observedIdleWake[0]?.systemPrompt.includes(ORCHESTRATOR_PLAN_SECTION))

    // 2. Queued non-human followUp (`origin: 'agent', whenBusy: 'followUp'`) arriving while coordinator is in Execution Phase:
    //    must reset phase to planning AND restore plannerModel before the followUp run starts!
    const observedQueued: ObservedCall[] = []
    const inExecGate = deferred<void>()
    const releaseExec = deferred<void>()
    env.faux.setResponses([
      captureStep(observedQueued, conv.id, () =>
        fauxAssistantMessage(
          [fauxToolCall(TIERS_EXIT_PLAN_MODE_TOOL, { plan: 'Run executor step' }, { id: 'exit-wake-1' })],
          { stopReason: 'toolUse' },
        ),
      ),
      captureStep(observedQueued, conv.id, async () => {
        inExecGate.resolve()
        await releaseExec.promise
        return fauxAssistantMessage('Executor finished Run 1.')
      }),
      captureStep(observedQueued, conv.id, () => fauxAssistantMessage('Planner handled queued agent followUp.')),
    ])

    await kernel.conversations.submitInput(conv.id, 'Execute single-stream change')
    await inExecGate.promise
    await kernel.conversations.submitInput(conv.id, '<swarm_board_report>peer finished</swarm_board_report>', {
      origin: 'agent',
      whenBusy: 'followUp',
    })
    releaseExec.resolve()

    await kernel.conversations.waitForIdle(conv.id)
    await waitFor(async () => observedQueued.length === 3, { timeoutMs: 10_000 })

    assert.equal(observedQueued[0]?.modelId, 'faux/flagship')
    assert.equal(observedQueued[0]?.reasoning, 'high')
    assert.equal(observedQueued[1]?.modelId, 'faux/fast')
    assert.equal(observedQueued[1]?.reasoning, 'low')
    assert.equal(observedQueued[2]?.modelId, 'faux/flagship', 'queued agent followUp must restore Planner model')
    assert.equal(observedQueued[2]?.reasoning, 'high', 'queued agent followUp must restore Planner thinkingLevel')
    assert.ok(observedQueued[2]?.toolNames.includes(TIERS_EXIT_PLAN_MODE_TOOL))
    assert.ok(!observedQueued[2]?.toolNames.includes('write'))
    assert.ok(observedQueued[2]?.systemPrompt.includes(ORCHESTRATOR_PLAN_SECTION))

    // 3. Direct defense-in-depth verification: `runChangedDuringExec` in `before_turn` restores runtime plannerModel
    //    even if `afterResponse` was bypassed and runtime model is still stuck on executorModel
    const convDirect = await kernel.conversations.createConversation({
      title: 'direct-run-changed',
      model: 'tier/auto-wakeup',
    })
    // Seed planning record with activeRunKey = 'run-1'
    await kernel.plugins.runHook('before_turn', {
      conversation: kernel.conversations.getConversation(convDirect.id),
      inputs: [{ id: 'run-1', text: 'start', origin: 'human', createdAt: Date.now() }],
      messages: [],
      sections: [],
      tools: [{ name: TIERS_EXIT_PLAN_MODE_TOOL, description: 'exit', inputSchema: {} }],
    } as never)
    // Transition record to execution phase (switches runtime model to faux/fast + low)
    const exitResult = (await kernel.plugins.executeTool(
      TIERS_EXIT_PLAN_MODE_TOOL,
      { plan: 'Direct transition to execution' },
      { conversationId: convDirect.id },
    )) as { isError?: boolean }
    assert.notEqual(exitResult.isError, true)
    assert.equal(kernel.conversations.getConversation(convDirect.id).model, 'faux/fast')
    assert.equal(
      (
        kernel.plugins.getPublicSessionDoc(TIERS_PLUGIN_ID, TIERS_ORCHESTRATOR_SESSION_DOC, convDirect.id)
          .value as TierOrchestratorSessionView | null
      )?.phase,
      'execution',
    )
    // Simulate next queued run (`run-2`, origin: 'agent') hitting before_turn directly while runtime model is still faux/fast
    const hookRes = await kernel.plugins.runHook('before_turn', {
      conversation: kernel.conversations.getConversation(convDirect.id),
      inputs: [{ id: 'run-2', text: 'swarm wakeup', origin: 'agent', createdAt: Date.now() }],
      messages: [],
      sections: [],
      tools: [
        { name: 'read', description: 'read', inputSchema: {} },
        { name: 'write', description: 'write', inputSchema: {} },
        { name: TIERS_EXIT_PLAN_MODE_TOOL, description: 'exit', inputSchema: {} },
      ],
    } as never)
    assert.equal(hookRes.action, 'transform')
    const afterDirect = kernel.conversations.getConversation(convDirect.id)
    assert.equal(afterDirect.model, 'faux/flagship', 'runChangedDuringExec must restore runtime plannerModel')
    assert.equal(afterDirect.thinkingLevel, 'high', 'runChangedDuringExec must restore plannerThinkingLevel')
    assert.equal(
      (
        kernel.plugins.getPublicSessionDoc(TIERS_PLUGIN_ID, TIERS_ORCHESTRATOR_SESSION_DOC, convDirect.id)
          .value as TierOrchestratorSessionView | null
      )?.phase,
      'planning',
    )
  } finally {
    await env.close()
  }
})
