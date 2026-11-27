/**
 * Dual-phase orchestrator tier integration tests against real `createHelmx` + `faux` provider:
 * - Multiple orchestrator tier pairs (`tier/pair-a`, `tier/pair-b`) & template round-trips;
 * - Strict machine invisibility (`<available_model_tiers>`, `400 orchestrator_tier_human_only`,
 *   `400 orchestrator_tier_not_borrowable`, `409 orchestrator_tier_active`);
 * - Profile inheritance unwrapping (`human_conversation` -> Planner + `modelTier`,
 *   `subagent_inherit` -> concrete `executorModel` without `modelTier`);
 * - Full Planning (`orch_bash` read-only + `exit_plan_mode`) -> Execution (step budget,
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
  TIERS_EXIT_PLAN_MODE_TOOL,
  TIERS_HAND_BACK_TOOL,
  TIERS_ORCHESTRATOR_SESSION_DOC,
  TIERS_ORCH_BASH_TOOL,
  TIERS_PLUGIN_ID,
  TIERS_SWITCH_MODEL_TOOL,
  type TierOrchestratorSessionView,
} from '../src/tiers.js'
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
    async () => normalizeTierSpec({ kind: 'orchestrator', model: 'faux/flagship', executorModel: 'faux/workhorse', maxExecutionSteps: 51 }),
    'validation_error',
  )

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
      maxExecutionSteps: 4,
      description: 'Flagship planner + workhorse executor',
    })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'pair-b',
      kind: 'orchestrator',
      model: 'faux/workhorse',
      executorModel: 'faux/fast',
      maxExecutionSteps: 8,
      description: 'Lighter planner + fast executor',
    })

    const catalog = await kernel.models.listModels()
    const pairA = catalog.modelTiers?.find((t) => t.id === 'pair-a')
    const pairB = catalog.modelTiers?.find((t) => t.id === 'pair-b')
    assert.equal(pairA?.kind, 'orchestrator')
    assert.equal(pairA?.executorModel, 'faux/workhorse')
    assert.equal(pairA?.maxExecutionSteps, 4)
    assert.equal(pairA?.available, true)
    assert.equal(pairB?.kind, 'orchestrator')
    assert.equal(pairB?.executorModel, 'faux/fast')
    assert.equal(pairB?.maxExecutionSteps, 8)
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

    // 1. `<available_model_tiers>` shows single `tier/coder` and excludes `tier/claude-auto`
    const conv = await kernel.conversations.createConversation({ title: 'human-orch', model: 'tier/claude-auto' })
    assert.equal(conv.model, 'faux/flagship')
    assert.equal(conv.modelTier, 'tier/claude-auto')
    assert.equal(conv.modelOverride, 'tier/claude-auto')
    assert.equal(conv.thinkingLevelOverride, undefined, 'orchestrator tier must not freeze thinkingLevelOverride')

    const hookResult = await kernel.plugins.runHook('before_turn', {
      conversation: kernel.conversations.getConversation(conv.id),
      inputs: [],
      messages: [],
      sections: [],
      tools: [],
    } as never)
    const injectedCatalog =
      hookResult.action === 'transform'
        ? (hookResult.value as { sections: Array<{ id: string; text: string }> }).sections.find(
            (s) => s.id === 'tiers.catalog',
          )?.text
        : undefined
    assert.ok(injectedCatalog !== undefined)
    assert.match(injectedCatalog, /tier\/coder/)
    assert.doesNotMatch(injectedCatalog, /tier\/claude-auto/)

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

    // Borrow guards
    const plainConv = await kernel.conversations.createConversation({ title: 'plain-conv', model: 'faux/workhorse' })
    await assertRejectsCode(
      () =>
        kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set_borrow', {
          conversationId: plainConv.id,
          model: 'tier/claude-auto',
        }),
      'orchestrator_tier_not_borrowable',
    )
    await assertRejectsCode(
      () =>
        kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set_borrow', {
          conversationId: conv.id,
          model: 'faux/fast',
        }),
      'orchestrator_tier_active',
    )

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

test('full planner -> orch_bash -> exit_plan_mode -> execution (step limit) -> hand_back_to_planner loop and static Prompt Cache', { timeout: 60_000 }, async () => {
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
    const orchBashAllowed = fauxToolCall(
      TIERS_ORCH_BASH_TOOL,
      { command: 'pwd' },
      { id: 'call-orch-pwd' },
    )
    const orchBashBlocked = fauxToolCall(
      TIERS_ORCH_BASH_TOOL,
      { command: 'echo pwn > evil.txt' },
      { id: 'call-orch-redir' },
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
      // 1. Planner step 1: inspect tools, run allowed + blocked orch_bash
      captureStep(observed, conv.id, () => {
        stepSnapshots.push(snapshotNow())
        return fauxAssistantMessage([orchBashAllowed, orchBashBlocked], { stopReason: 'toolUse' })
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

    // Verify Step 1 (Planner initial)
    assert.equal(observed[0]?.modelId, 'faux/flagship')
    assert.equal(observed[0]?.reasoning, 'high')
    assert.ok(observed[0]?.toolNames.includes(TIERS_ORCH_BASH_TOOL))
    assert.ok(observed[0]?.toolNames.includes(TIERS_EXIT_PLAN_MODE_TOOL))
    assert.ok(!observed[0]?.toolNames.includes('write'))
    assert.ok(!observed[0]?.toolNames.includes('edit'))
    assert.ok(!observed[0]?.toolNames.includes('bash'))
    assert.ok(!observed[0]?.toolNames.includes(TIERS_HAND_BACK_TOOL))
    assert.ok(!observed[0]?.toolNames.includes(TIERS_SWITCH_MODEL_TOOL))

    // Verify Step 2 (Planner static cache before exit_plan_mode)
    assert.equal(observed[1]?.modelId, 'faux/flagship')
    assert.equal(observed[1]?.systemPrompt, observed[0]?.systemPrompt, 'planning prompt cache section must remain identical')

    // Verify Step 3 (Executor 1/1: switched model without mutating modelOverride/modelTier)
    assert.equal(observed[2]?.modelId, 'faux/workhorse')
    assert.equal(observed[2]?.reasoning, 'low')
    assert.ok(observed[2]?.toolNames.includes('write'))
    assert.ok(observed[2]?.toolNames.includes(TIERS_HAND_BACK_TOOL))
    assert.ok(!observed[2]?.toolNames.includes(TIERS_ORCH_BASH_TOOL))
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

    // Verify orch_bash read-only & redirect results and transition presentationMeta persisted cleanly
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
    const pwdResult = toolResults.find((m) => m.toolName === TIERS_ORCH_BASH_TOOL && m.isError === false)
    assert.ok(pwdResult !== undefined, 'read-only orch_bash pwd must succeed')
    const redirResult = toolResults.find((m) => m.toolName === TIERS_ORCH_BASH_TOOL && m.isError === true)
    assert.ok(redirResult !== undefined, 'mutating redirection orch_bash must be blocked')
    assert.match(redirResult.content?.[0]?.text ?? '', /read-only/i)

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
    assert.ok(observedPlan[0]!.toolNames.includes('plan_bash'))
    assert.ok(!observedPlan[0]!.toolNames.includes(TIERS_ORCH_BASH_TOOL))
    assert.ok(!observedPlan[0]!.toolNames.includes(TIERS_EXIT_PLAN_MODE_TOOL))

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
