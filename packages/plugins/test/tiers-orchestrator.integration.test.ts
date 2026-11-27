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

    // Forking a human orchestrator conversation drops symbolic orchestrator modelTier / override
    env.faux.setResponses([fauxAssistantMessage('seed')])
    await kernel.conversations.submitInput(conv.id, 'seed forkable turn')
    await kernel.conversations.waitForIdle(conv.id)
    const forked = await kernel.conversations.forkConversation(conv.id)
    assert.equal(forked.modelTier, undefined)
    assert.equal(forked.modelOverride, undefined)

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

    // Verify Step 1 (Planner initial: 7-tool whitelist with bash, run_action, exit_plan_mode; update_steps & write/dispatch stripped)
    assert.equal(observed[0]?.modelId, 'faux/flagship')
    assert.equal(observed[0]?.reasoning, 'high')
    assert.equal(ORCHESTRATOR_PLAN_TOOL_WHITELIST.size, 7)
    assert.ok(observed[0]?.toolNames.every((name) => ORCHESTRATOR_PLAN_TOOL_WHITELIST.has(name)))
    assert.ok(observed[0]?.toolNames.includes('bash'))
    assert.ok(observed[0]?.toolNames.includes('run_action'))
    assert.ok(observed[0]?.toolNames.includes(TIERS_EXIT_PLAN_MODE_TOOL))
    assert.ok(!observed[0]?.toolNames.includes('update_steps'))
    assert.ok(!observed[0]?.toolNames.includes('write'))
    assert.ok(!observed[0]?.toolNames.includes('edit'))
    assert.ok(!observed[0]?.toolNames.includes('register_artifact'))
    assert.ok(!observed[0]?.toolNames.includes('subagent'))
    assert.ok(!observed[0]?.toolNames.includes('SubagentWorkflow'))
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

    const exitMeta = toolResults.find((m) => m.toolName === TIERS_EXIT_PLAN_MODE_TOOL)?.details
    assert.equal(exitMeta?.['tool'], TIERS_EXIT_PLAN_MODE_TOOL)
    assert.equal(exitMeta?.['fromPhase'], 'planning')
    assert.equal(exitMeta?.['toPhase'], 'execution')
    assert.equal(exitMeta?.['fromModel'], 'faux/flagship')
    assert.equal(exitMeta?.['toModel'], 'faux/workhorse')

    const handBackMeta = toolResults.find((m) => m.toolName === TIERS_HAND_BACK_TOOL)?.details
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

test('agent_spawn hook locks subagents, specialist Profiles, explicit overrides, resume, fork, and nested grandchildren to executorModel while suppressing tiers.catalog', { timeout: 60_000 }, async () => {
  const env = await openOrchestratorEnv({ defaultModel: 'faux/workhorse' })
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'coder',
      model: 'faux/workhorse',
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
      recordFaux('resumed-child'),
      recordFaux('tier-override-child'),
      recordFaux('grandchild'),
      recordFaux('forked-child'),
      recordFaux('no-effort-child'),
    ])
    await kernel.conversations.submitInput(rootConv.id, 'seed turn')
    await kernel.conversations.waitForIdle(rootConv.id)

    let plainChildId: number | undefined
    let noEffortChildId: number | undefined

    // a) Plain subagent (no model, allowing depth 2 so nested grandchild test can spawn under it) -> executorModel + executorThinkingLevel
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

    // b) Specialist Profile bound to flagship -> still locked to executorModel + executorThinkingLevel
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: rootConv.id,
      agentType: 'specialist',
      prompt: 'specialist child task',
    })

    // c) Explicit flagship model + high effort AND resume -> locked to executorModel + executorThinkingLevel
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: rootConv.id,
      agentId: 'child-a',
      model: 'faux/flagship',
      effort: 'high',
      prompt: 'explicit override attempt',
    })
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: rootConv.id,
      resume: 'child-a',
      model: 'faux/flagship',
      effort: 'high',
      prompt: 'resumed override attempt',
    })

    // d) Explicit single tier model -> locked to executorModel + executorThinkingLevel
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: rootConv.id,
      model: 'tier/coder',
      prompt: 'tier coder override attempt',
    })

    // e) Nested grandchild spawned from child -> walks child -> rootConv -> still locked to executorModel
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: plainChildId!,
      model: 'faux/flagship',
      effort: 'high',
      prompt: 'nested grandchild task',
    })

    // f) Forked subagent under orchestrator root -> locked to executorModel + executorThinkingLevel
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: rootConv.id,
      fork: true,
      model: 'faux/flagship',
      effort: 'high',
      prompt: 'forked child task',
    })

    assert.equal(spawnObserved.length, 7)
    for (const [idx, call] of spawnObserved.entries()) {
      assert.equal(call.modelId, 'faux/fast', `spawn call #${idx} must run on executorModel faux/fast`)
      assert.equal(call.reasoning, 'low', `spawn call #${idx} must run on executorThinkingLevel low`)
      assert.equal(call.hasCatalog, false, `spawn call #${idx} must suppress tiers.catalog`)
    }

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

    // h) Orchestrator without executorThinkingLevel clears caller effort rather than leaking `high`
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: rootNoEffort.id,
      model: 'faux/flagship',
      effort: 'high',
      prompt: 'clear caller effort',
      onResolved: (info) => {
        noEffortChildId = info.conversationId
      },
    })
    assert.ok(noEffortChildId !== undefined)
    const noEffortChildSnap = kernel.conversations.getConversation(noEffortChildId!)
    assert.equal(noEffortChildSnap.model, 'faux/fast')
    assert.equal(noEffortChildSnap.thinkingLevelOverride, undefined)
    assert.equal(spawnObserved.length, 8)
    assert.equal(spawnObserved[7]?.modelId, 'faux/fast')
    assert.notEqual(spawnObserved[7]?.reasoning, 'high')
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
