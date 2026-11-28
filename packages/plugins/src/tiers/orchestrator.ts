/**
 * Dual-phase orchestrator lifecycle (`planning` <-> `execution`) for orchestrator model tiers (`kind: 'orchestrator'`).
 *
 * Design invariants:
 * - Static prompt sections only (`ORCHESTRATOR_PLAN_SECTION`, `ORCHESTRATOR_EXECUTE_SECTION`, `ORCHESTRATOR_STEP_LIMIT_SECTION`)
 *   so prefix KV Prompt Cache stays reusable across steps within a turn and across turns.
 * - Strict `/plan` precedence: when `plan.mode` is present in `before_turn`, `/plan` owns the prompt & tool whitelist
 *   and orchestrator tools/sections are stripped cleanly.
 * - Concurrency safety: `execution` mode allows mid-turn `steer` and queued `followUp` to proceed without disruption;
 *   queued `followUp` transitions reset cleanly via kernel `afterResponse` (and `runKey` detection in `before_turn`).
 */
import {
  HelmxError,
  ORCHESTRATOR_TIER_DEFAULT_MAX_STEPS,
  isJsonObject,
  isOrchestratorTier,
  parseModelTierRef,
  type ConversationSummary,
  type DispatchToolsCapability,
  type HelmxPluginContext,
  type HookPayloadMap,
  type HookResult,
  type ModelTierSpec,
  type PluginInUseItem,
  type PluginKvHandle,
  type PluginSessionDocHandle,
  type PluginToolContext,
  type PluginToolResultEnvelope,
} from '@helmx/protocol'
import {
  createKeyedQueue,
  errorMessageOf,
  getConversationOrUndefined,
  ignoreConversationNotFound,
  listAllKvEntries,
} from '../shared-helpers.js'
import {
  ORCHESTRATOR_EXECUTE_SECTION_ID,
  ORCHESTRATOR_ONLY_TOOL_NAMES,
  ORCHESTRATOR_PLAN_SECTION_ID,
  ORCHESTRATOR_PLAN_TOOL_WHITELIST,
  ORCHESTRATOR_STEP_LIMIT_SECTION_ID,
  TIERS_EXIT_PLAN_MODE_TOOL,
  TIERS_HAND_BACK_TOOL,
  TIERS_SWITCH_MODEL_TOOL,
  isTiersBorrowEligible,
  toTierOrchestratorSessionView,
  type OrchestratorTransitionMeta,
  type TierOrchestratorRecord,
  type TierOrchestratorSessionView,
  type TiersStateDoc,
} from './contracts.js'

const PLAN_MODE_SECTION_ID = 'plan.mode'
const SECTION_PREFIX = 'tiers.orchestrator.'

export const ORCHESTRATOR_PLAN_SECTION = [
  '<orchestrator_planning_mode>',
  'This conversation runs in two phases: you are currently in the Planning Phase as the higher-reasoning Planner, and `exit_plan_mode` switches this same conversation in place to the faster, lower-cost Executor (which sees the conversation so far plus your plan). Every new user message and every asynchronous agent/Swarm wakeup starts in the Planning Phase; so does any Executor hand-back (`hand_back_to_planner`). Where this section conflicts with earlier investigate-then-edit instructions, this section wins; it never overrides safety rules or explicit user rules.',
  'Direct workspace mutation and progress tools (`write`, `edit`, `register_artifact`, `update_steps`) are disabled in this phase. When enabled, orchestration and delegation tools (`subagent`, `SubagentWorkflow`, `swarm_*`, etc.) remain available in this phase so you can coordinate multi-agent work directly.',
  '',
  'Match the depth of planning to the request:',
  '- Small follow-ups whose steps are already settled (apply a change already proposed, fix a typo, rerun a command, send/post drafted content): do NOT re-investigate—call `exit_plan_mode` immediately with a 1-2 sentence plan. The Executor can work out standard tool/command usage on its own.',
  '- Substantive tasks with open decisions: investigate only what you need to make every decision.',
  '',
  'Choose the right path (stay in Planning vs exit to Execution):',
  '- Pure questions, reviews, explanations, or read-only research requiring no edits: answer directly without calling `exit_plan_mode`.',
  '- Single-stream edits, small fixes, write/mutating `run_action` / external effects, or final single-branch merge & verification: MUST call `exit_plan_mode` to switch this conversation in place to the Executor (reuses the hot Prompt Cache with zero cold-start spawn overhead—NEVER spawn a subagent or Swarm just for a trivial single-stream edit).',
  '- Multi-stream parallel work, Swarm collaboration, or isolated context-heavy research: stay in the Planning Phase and orchestrate directly as the high-reasoning coordinator (`subagent`, `SubagentWorkflow`, or `swarm_*`). Spawned workers and subagents default automatically to the Executor model; reserve explicit `model` overrides strictly for genuinely high-difficulty subtasks or critical audits.',
  '- If the user explicitly asked to see or approve the plan first, present the plan in text and stop without calling `exit_plan_mode`; otherwise act or hand off at once.',
  '',
  'Planning rules:',
  '1. Keep your own inspection strictly read-only: use `read`, `read_artifact`, and `load_skill` to inspect files and artifacts, `bash` strictly for read-only observation (code search, builds, typecheck, tests, `git status`/`log`/`diff`), and `run_action` strictly for read-only queries (`list`, `describe`, and read-only inspection actions). Never edit files, redirect output into workspace files, create commits, or mutate external/host state directly in this phase.',
  '2. Make every engineering decision you can settle from the codebase and conventions (interpretation, design, APIs, order of work, verification). Use `ask_user` only for genuine requirement ambiguity or high-impact user choices—never leave unresolved design decisions for the Executor or workers.',
  '3. When handing off via `exit_plan_mode`, write the plan for a competent engineer who is less capable than you and cannot ask follow-up questions: name exact file paths, symbols, concrete changes, pitfalls noticed, and exact verification commands with what their output must show. Nothing you know that is not written in the plan or conversation survives the switch. For non-trivial plans, end with a short `Re-plan if:` list naming task-specific signs that the plan is wrong and the Executor must hand back rather than improvise.',
  '4. Call `exit_plan_mode({ plan })` alone as the sole tool call of that step—never call it in parallel with `read`, `bash`, `run_action`, `ask_user`, or orchestration tools.',
  '',
  'Planner review (when `hand_back_to_planner` returns a `[plan review]` result):',
  "- You are reviewing, not executing. Compare what the Executor did against the plan (and any mid-execution user message), verify read-only what you need to, then either call `exit_plan_mode` with only the remaining steps (if on track), call `exit_plan_mode` with a corrected plan (if off track or requirements changed), or report completion and stop if the task is already complete and verified. Do not do the Executor's work yourself.",
  '</orchestrator_planning_mode>',
].join('\n')

export const ORCHESTRATOR_EXECUTE_SECTION = [
  '<orchestrator_execution_mode>',
  "You are in the Execution Phase of a dual-phase orchestrator session. Carry out the plan from the Planner's `exit_plan_mode` call carefully and verify all changes against its verification criteria.",
  '1. Implement the plan directly using available workspace tools. Any subagents, workflows, or workers you spawn default to your Executor model unless explicitly overridden.',
  '2. Call `hand_back_to_planner({ reason, summary })` instead of improvising when: (a) any `Re-plan if:` condition in the plan triggers, (b) you discover a blocking flaw in the plan or hit repeated verification failures requiring redesign, (c) you need user clarification or an architectural/design decision not settled by the plan, or (d) a mid-execution user message (`steer`) changes requirements, scope, or design (pause further edits and report what you have changed so far; only handle trivial in-scope nudges directly).',
  '3. Call `hand_back_to_planner` alone as the sole tool call of that step—never in parallel with file edits, commands, or subagents. Include concrete completed edits, exact verification outputs, and open blockers or remaining steps in `summary`.',
  '4. Once all planned steps are implemented and verified, reply directly to the user to finish—do NOT call `hand_back_to_planner` just to report normal completion.',
  '</orchestrator_execution_mode>',
].join('\n')

export const ORCHESTRATOR_STEP_LIMIT_SECTION = [
  '<orchestrator_execution_step_limit>',
  'Scheduled planner review: the execution step budget for this phase has been reached and workspace tools are paused.',
  'Call `hand_back_to_planner({ reason, summary })` now with a clear status report covering completed edits, verification outputs run so far, any blockers or surprises, and exact remaining steps (or note if all work is already complete and verified).',
  '</orchestrator_execution_step_limit>',
].join('\n')

export interface ActiveOrchestratorTier {
  tierId: string
  spec: ModelTierSpec
  executorModel: string
}

export interface ExitPlanModeToolInput {
  plan: string
}

export interface HandBackToPlannerToolInput {
  reason: string
  summary: string
}

export interface TierOrchestratorManager {
  setStopping(value: boolean): void
  hydrate(): void
  reconcile(): Promise<void>
  inUseItems(): PluginInUseItem[]
  stop(): Promise<void>
  isUnderOrchestratorTree(
    conversation: Pick<ConversationSummary, 'parentConversationId' | 'ownedBy' | 'modelTier'>,
  ): boolean
  handleAgentSpawn(request: HookPayloadMap['agent_spawn']): HookResult<HookPayloadMap['agent_spawn']>
  handleInput(payload: HookPayloadMap['input']): HookResult<HookPayloadMap['input']> | Promise<HookResult<HookPayloadMap['input']>>
  handleBeforeTurn(payload: HookPayloadMap['before_turn']): HookResult<HookPayloadMap['before_turn']> | Promise<HookResult<HookPayloadMap['before_turn']>>
  handleTurnSettled(conversationId: number): Promise<void>
  handleConversationUpsert(payload: unknown): Promise<void>
  handleConversationDeleted(conversationId: number): Promise<void>
  handleConversationReset(conversationId: number): Promise<void>
  executeExitPlanModeTool(input: ExitPlanModeToolInput, context: PluginToolContext): Promise<PluginToolResultEnvelope>
  executeHandBackTool(input: HandBackToPlannerToolInput, context: PluginToolContext): Promise<PluginToolResultEnvelope>
}

interface OrchestratorStore {
  get(conversationId: number): TierOrchestratorRecord | undefined
  listAllRecords(): TierOrchestratorRecord[]
  syncSessionDoc(conversationId: number, record: TierOrchestratorRecord | undefined): void
  saveRecord(conversationId: number, record: TierOrchestratorRecord | undefined): Promise<void>
}

function createOrchestratorStore(
  kv: PluginKvHandle<TierOrchestratorRecord>,
  doc: PluginSessionDocHandle<TierOrchestratorSessionView | null>,
): OrchestratorStore {
  const kvKey = (conversationId: number): string => String(conversationId)

  const syncSessionDoc = (conversationId: number, record: TierOrchestratorRecord | undefined): void => {
    ignoreConversationNotFound(() => {
      if (record === undefined) {
        doc.delete(conversationId)
      } else {
        doc.set(conversationId, toTierOrchestratorSessionView(record))
      }
    })
  }

  return {
    get: (conversationId) => kv.get(kvKey(conversationId)),
    listAllRecords: () => listAllKvEntries(kv).map((entry) => entry.value),
    syncSessionDoc,
    async saveRecord(conversationId, record) {
      const key = kvKey(conversationId)
      const prev = kv.get(key)
      if (record === undefined) {
        kv.delete(key)
      } else {
        kv.set(key, record)
      }
      try {
        await kv.flush()
      } catch (err) {
        if (prev !== undefined) kv.set(key, prev)
        else kv.delete(key)
        throw err
      }
      syncSessionDoc(conversationId, record)
    },
  }
}

function resolveActiveOrchestrator(
  conv: Pick<ConversationSummary, 'parentConversationId' | 'ownedBy' | 'modelTier'>,
  tiersState: TiersStateDoc,
): ActiveOrchestratorTier | undefined {
  if (!isTiersBorrowEligible(conv) || conv.modelTier === undefined || conv.modelTier === '') {
    return undefined
  }
  const tierId = parseModelTierRef(conv.modelTier)
  if (tierId === undefined) return undefined
  const spec = tiersState.tiers[tierId]
  if (!isOrchestratorTier(spec) || typeof spec?.executorModel !== 'string' || spec.executorModel === '') {
    return undefined
  }
  return {
    tierId,
    spec,
    executorModel: spec.executorModel,
  }
}

function resolveTreeOrchestrator(
  host: HelmxPluginContext['host'],
  conversationId: number,
  tiersState: TiersStateDoc,
): ActiveOrchestratorTier | undefined {
  if (!Object.values(tiersState.tiers).some((spec) => isOrchestratorTier(spec))) {
    return undefined
  }
  const visited = new Set<number>()
  let cur: number | undefined = conversationId
  while (cur !== undefined && !visited.has(cur)) {
    visited.add(cur)
    const conv = getConversationOrUndefined(host, cur)
    if (conv === undefined) return undefined
    const active = resolveActiveOrchestrator(conv, tiersState)
    if (active !== undefined) return active
    cur = conv.parentConversationId
  }
  return undefined
}

function isConversationBusy(
  conv: Pick<ConversationSummary, 'status' | 'pendingAskCount' | 'contextUsage'>,
): boolean {
  return (
    conv.status === 'working' ||
    conv.status === 'blocked' ||
    conv.pendingAskCount > 0 ||
    conv.contextUsage?.compacting === true
  )
}

function buildPlanningRecord(params: {
  conversationId: number
  active: ActiveOrchestratorTier
  existing?: TierOrchestratorRecord
  activeRunKey?: string
}): TierOrchestratorRecord {
  const { conversationId, active, existing, activeRunKey } = params
  return {
    conversationId,
    tierId: active.tierId,
    phase: 'planning',
    plannerModel: active.spec.model,
    ...(active.spec.thinkingLevel ? { plannerThinkingLevel: active.spec.thinkingLevel } : {}),
    executorModel: active.executorModel,
    ...(active.spec.executorThinkingLevel ? { executorThinkingLevel: active.spec.executorThinkingLevel } : {}),
    maxExecutionSteps: active.spec.maxExecutionSteps ?? ORCHESTRATOR_TIER_DEFAULT_MAX_STEPS,
    executionStepCount: 0,
    stepLimitTriggered: false,
    handoffCount: existing?.tierId === active.tierId ? existing.handoffCount : 0,
    ...(activeRunKey !== undefined && activeRunKey !== '' ? { activeRunKey } : {}),
    updatedAt: Date.now(),
  }
}

function needsRuntimeModelSync(
  conv: Pick<ConversationSummary, 'model' | 'thinkingLevel'>,
  targetModel: string,
  targetThinkingLevel: string | undefined,
  forceThinkingSync = false,
): boolean {
  if (conv.model !== targetModel) return true
  if (targetThinkingLevel !== undefined && targetThinkingLevel !== '') {
    return conv.thinkingLevel !== targetThinkingLevel
  }
  return forceThinkingSync
}

async function restorePlannerRuntimeModelIfNeeded(
  ctx: HelmxPluginContext,
  conv: ConversationSummary,
  active: ActiveOrchestratorTier,
  forceThinkingSync = false,
): Promise<void> {
  if (!needsRuntimeModelSync(conv, active.spec.model, active.spec.thinkingLevel, forceThinkingSync)) {
    return
  }
  if (ctx.host.setConversationRuntimeModel === undefined) return
  try {
    await ctx.host.setConversationRuntimeModel(conv.id, {
      model: active.spec.model,
      ...(active.spec.thinkingLevel !== undefined ? { thinkingLevel: active.spec.thinkingLevel } : {}),
    })
  } catch (err) {
    if (err instanceof HelmxError && (err.status === 404 || err.code === 'not_found' || err.code === 'ask_pending')) {
      return
    }
    throw err
  }
}

function stripOrchestratorSections(sections: Array<{ id: string; text: string }>): Array<{ id: string; text: string }> {
  return sections.filter((section) => !section.id.startsWith(SECTION_PREFIX))
}

function stripOrchestratorToolsFromTurn(turn: HookPayloadMap['before_turn']): HookResult<HookPayloadMap['before_turn']> {
  const tools = turn.tools.filter((tool) => !ORCHESTRATOR_ONLY_TOOL_NAMES.has(tool.name))
  const sections = stripOrchestratorSections(turn.sections)
  if (tools.length === turn.tools.length && sections.length === turn.sections.length) {
    return { action: 'continue' }
  }
  return {
    action: 'transform',
    value: {
      ...turn,
      tools,
      sections,
    },
  }
}

function collectPlanningOrchestrationTools(ctx: HelmxPluginContext): Set<string> {
  const allowed = new Set<string>()
  for (const entry of ctx.consume<DispatchToolsCapability>('helmx.dispatch-tools')) {
    const impl = entry.impl
    if (impl === null || typeof impl !== 'object') continue
    if (Array.isArray(impl.toolNames)) {
      for (const name of impl.toolNames) {
        if (typeof name === 'string' && name.length > 0) allowed.add(name)
      }
    }
    if (Array.isArray(impl.orchestrationTools)) {
      for (const name of impl.orchestrationTools) {
        if (typeof name === 'string' && name.length > 0) allowed.add(name)
      }
    }
  }
  return allowed
}

function toolError(message: string): PluginToolResultEnvelope {
  return { output: message, isError: true }
}

export function createTierOrchestratorManager(deps: {
  ctx: HelmxPluginContext
  kv: PluginKvHandle<TierOrchestratorRecord>
  orchestratorDoc: PluginSessionDocHandle<TierOrchestratorSessionView | null>
  readTiersState: () => TiersStateDoc
}): TierOrchestratorManager {
  const { ctx, kv, orchestratorDoc, readTiersState } = deps

  let stopping = false
  const convQueue = createKeyedQueue<number>()
  const store = createOrchestratorStore(kv, orchestratorDoc)

  return {
    setStopping(value: boolean): void {
      stopping = value
    },

    hydrate(): void {
      for (const record of store.listAllRecords()) {
        store.syncSessionDoc(record.conversationId, record)
      }
    },

    isUnderOrchestratorTree(
      conversation: Pick<ConversationSummary, 'parentConversationId' | 'ownedBy' | 'modelTier'>,
    ): boolean {
      const tiersState = readTiersState()
      if (resolveActiveOrchestrator(conversation, tiersState) !== undefined) return true
      if (conversation.parentConversationId === undefined) return false
      return resolveTreeOrchestrator(ctx.host, conversation.parentConversationId, tiersState) !== undefined
    },

    handleAgentSpawn(request: HookPayloadMap['agent_spawn']): HookResult<HookPayloadMap['agent_spawn']> {
      if (stopping || request.reattach !== undefined || (request.agentType ?? '').includes(':')) {
        return { action: 'continue' }
      }
      const tiersState = readTiersState()
      const active = resolveTreeOrchestrator(ctx.host, request.parentConversationId, tiersState)
      if (active === undefined) {
        return { action: 'continue' }
      }
      const rawModel = typeof request.model === 'string' ? request.model.trim() : ''
      if (rawModel !== '') {
        if (!rawModel.includes('/')) {
          return { action: 'continue' }
        }
        const explicitTierId = parseModelTierRef(rawModel)
        if (explicitTierId !== undefined && isOrchestratorTier(tiersState.tiers[explicitTierId])) {
          throw new HelmxError(
            'orchestrator_tier_human_only',
            `Orchestrator model tier '${rawModel}' is restricted to top-level human conversations`,
            400,
            { model: rawModel, tierId: explicitTierId },
          )
        }
        return { action: 'continue' }
      }
      if (request.resume !== undefined) {
        return { action: 'continue' }
      }
      const nextRequest: HookPayloadMap['agent_spawn'] = {
        ...request,
        model: active.executorModel,
      }
      if (request.effort === undefined) {
        const execEffort = active.spec.executorThinkingLevel?.trim() ?? ''
        if (execEffort !== '') {
          nextRequest.effort = execEffort
        }
      }
      return {
        action: 'transform',
        value: nextRequest,
      }
    },

    async reconcile(): Promise<void> {
      for (const record of store.listAllRecords()) {
        await convQueue.enqueue(record.conversationId, async () => {
          if (stopping) return
          const latest = store.get(record.conversationId)
          if (latest === undefined) return
          const conv = getConversationOrUndefined(ctx.host, record.conversationId)
          const active = conv !== undefined ? resolveActiveOrchestrator(conv, readTiersState()) : undefined
          if (conv === undefined || active === undefined) {
            await store.saveRecord(record.conversationId, undefined)
            return
          }
          if (!isConversationBusy(conv)) {
            const next = buildPlanningRecord({ conversationId: conv.id, active, existing: latest })
            await store.saveRecord(conv.id, next)
            await restorePlannerRuntimeModelIfNeeded(ctx, conv, active, latest.phase === 'execution')
            return
          }
          store.syncSessionDoc(conv.id, latest)
        })
      }
    },

    inUseItems(): PluginInUseItem[] {
      return store
        .listAllRecords()
        .filter((record) => record.phase === 'execution')
        .map((record) => ({
          kind: 'orchestrator_active',
          id: String(record.conversationId),
          label: `Conversation #${record.conversationId} is executing under orchestrator tier/${record.tierId}`,
        }))
    },

    async stop(): Promise<void> {
      stopping = true
      await convQueue.drain()
      await kv.flush()
    },

    handleInput(payload: HookPayloadMap['input']): HookResult<HookPayloadMap['input']> | Promise<HookResult<HookPayloadMap['input']>> {
      if (stopping) return { action: 'continue' }
      const existingFast = store.get(payload.conversationId)
      const convFast = getConversationOrUndefined(ctx.host, payload.conversationId)
      const activeFast = convFast !== undefined ? resolveActiveOrchestrator(convFast, readTiersState()) : undefined
      if (existingFast === undefined && activeFast === undefined) {
        return { action: 'continue' }
      }

      return convQueue.enqueue(payload.conversationId, async () => {
        if (stopping) return { action: 'continue' }
        const conv = getConversationOrUndefined(ctx.host, payload.conversationId)
        const existing = store.get(payload.conversationId)
        const active = conv !== undefined ? resolveActiveOrchestrator(conv, readTiersState()) : undefined
        if (conv === undefined || active === undefined) {
          if (existing !== undefined) {
            await store.saveRecord(payload.conversationId, undefined)
          }
          return { action: 'continue' }
        }
        if (isConversationBusy(conv)) {
          return { action: 'continue' }
        }
        const next = buildPlanningRecord({ conversationId: conv.id, active, existing })
        await store.saveRecord(conv.id, next)
        await restorePlannerRuntimeModelIfNeeded(ctx, conv, active, existing?.phase === 'execution')
        return { action: 'continue' }
      })
    },

    handleBeforeTurn(turn: HookPayloadMap['before_turn']): HookResult<HookPayloadMap['before_turn']> | Promise<HookResult<HookPayloadMap['before_turn']>> {
      const convId = turn.conversation.id
      const existingFast = store.get(convId)
      const activeFast = resolveActiveOrchestrator(turn.conversation, readTiersState())
      const inPlanMode = turn.sections.some((section) => section.id === PLAN_MODE_SECTION_ID)

      if (inPlanMode || (existingFast === undefined && activeFast === undefined)) {
        return stripOrchestratorToolsFromTurn(turn)
      }

      return convQueue.enqueue(convId, async () => {
        if (turn.sections.some((section) => section.id === PLAN_MODE_SECTION_ID)) {
          return stripOrchestratorToolsFromTurn(turn)
        }
        const active = resolveActiveOrchestrator(turn.conversation, readTiersState())
        const existing = store.get(convId)
        if (active === undefined) {
          if (existing !== undefined) {
            await store.saveRecord(convId, undefined)
          }
          return stripOrchestratorToolsFromTurn(turn)
        }

        const rawRunKey = turn.inputs[0]?.id
        const runKey = typeof rawRunKey === 'string' && rawRunKey !== '' ? rawRunKey : undefined

        let record = existing
        const runChangedDuringExec =
          record !== undefined &&
          record.phase === 'execution' &&
          runKey !== undefined &&
          record.activeRunKey !== undefined &&
          record.activeRunKey !== runKey

        if (record === undefined || record.tierId !== active.tierId || runChangedDuringExec) {
          record = buildPlanningRecord({
            conversationId: convId,
            active,
            existing: record,
            activeRunKey: runKey,
          })
          await store.saveRecord(convId, record)
          if (runChangedDuringExec) {
            await restorePlannerRuntimeModelIfNeeded(
              ctx,
              getConversationOrUndefined(ctx.host, convId) ?? turn.conversation,
              active,
              true,
            )
          }
        } else if (record.phase === 'planning') {
          const nextMaxSteps = active.spec.maxExecutionSteps ?? ORCHESTRATOR_TIER_DEFAULT_MAX_STEPS
          const needsRefresh =
            (record.activeRunKey === undefined && runKey !== undefined) ||
            record.plannerModel !== active.spec.model ||
            record.plannerThinkingLevel !== active.spec.thinkingLevel ||
            record.executorModel !== active.executorModel ||
            record.executorThinkingLevel !== active.spec.executorThinkingLevel ||
            record.maxExecutionSteps !== nextMaxSteps
          if (needsRefresh) {
            record = buildPlanningRecord({
              conversationId: convId,
              active,
              existing: record,
              activeRunKey: runKey ?? record.activeRunKey,
            })
            await store.saveRecord(convId, record)
          }
        }

        if (record.phase === 'planning') {
          const orchestrationTools = collectPlanningOrchestrationTools(ctx)
          const tools = turn.tools.filter(
            (tool) => ORCHESTRATOR_PLAN_TOOL_WHITELIST.has(tool.name) || orchestrationTools.has(tool.name),
          )
          const sections = [
            ...stripOrchestratorSections(turn.sections),
            { id: ORCHESTRATOR_PLAN_SECTION_ID, text: ORCHESTRATOR_PLAN_SECTION },
          ]
          return {
            action: 'transform',
            value: {
              ...turn,
              tools,
              sections,
            },
          }
        }

        const nextStep = record.executionStepCount + 1
        const stepLimitReached = record.maxExecutionSteps > 0 && nextStep > record.maxExecutionSteps
        const updatedRecord: TierOrchestratorRecord = {
          ...record,
          executionStepCount: stepLimitReached ? record.maxExecutionSteps : nextStep,
          stepLimitTriggered: stepLimitReached,
          updatedAt: Date.now(),
        }
        await store.saveRecord(convId, updatedRecord)

        if (stepLimitReached) {
          const tools = turn.tools.filter((tool) => tool.name === TIERS_HAND_BACK_TOOL)
          const sections = [
            ...stripOrchestratorSections(turn.sections),
            { id: ORCHESTRATOR_EXECUTE_SECTION_ID, text: ORCHESTRATOR_EXECUTE_SECTION },
            { id: ORCHESTRATOR_STEP_LIMIT_SECTION_ID, text: ORCHESTRATOR_STEP_LIMIT_SECTION },
          ]
          return {
            action: 'transform',
            value: {
              ...turn,
              tools,
              sections,
            },
          }
        }

        // Strip `ask_user` in execution so clarifications route back to Planner via `hand_back_to_planner`
        // without injecting conflicting `<ask_user>` guidance.
        const tools = turn.tools.filter(
          (tool) =>
            tool.name !== TIERS_EXIT_PLAN_MODE_TOOL &&
            tool.name !== TIERS_SWITCH_MODEL_TOOL &&
            tool.name !== 'ask_user',
        )
        const sections = [
          ...stripOrchestratorSections(turn.sections),
          { id: ORCHESTRATOR_EXECUTE_SECTION_ID, text: ORCHESTRATOR_EXECUTE_SECTION },
        ]
        return {
          action: 'transform',
          value: {
            ...turn,
            tools,
            sections,
          },
        }
      })
    },

    handleTurnSettled(conversationId: number): Promise<void> {
      const existingFast = store.get(conversationId)
      const convFast = getConversationOrUndefined(ctx.host, conversationId)
      const activeFast = convFast !== undefined ? resolveActiveOrchestrator(convFast, readTiersState()) : undefined
      if (existingFast === undefined && activeFast === undefined) {
        return Promise.resolve()
      }
      return convQueue.enqueue(conversationId, async () => {
        if (stopping) return
        const conv = getConversationOrUndefined(ctx.host, conversationId)
        const existing = store.get(conversationId)
        const active = conv !== undefined ? resolveActiveOrchestrator(conv, readTiersState()) : undefined
        if (conv === undefined || active === undefined) {
          if (existing !== undefined) {
            await store.saveRecord(conversationId, undefined)
          }
          return
        }
        if (isConversationBusy(conv)) {
          return
        }
        const next = buildPlanningRecord({ conversationId: conv.id, active, existing })
        await store.saveRecord(conv.id, next)
        await restorePlannerRuntimeModelIfNeeded(ctx, conv, active, existing?.phase === 'execution')
      })
    },

    handleConversationUpsert(payload: unknown): Promise<void> {
      if (!isJsonObject(payload) || payload['type'] !== 'conversation.upsert') return Promise.resolve()
      const conv = payload['conversation']
      if (!isJsonObject(conv) || typeof conv['id'] !== 'number' || !Number.isSafeInteger(conv['id'])) {
        return Promise.resolve()
      }
      const conversationId = conv['id']
      const existing = store.get(conversationId)
      if (existing === undefined) return Promise.resolve()
      const nextModelTier = typeof conv['modelTier'] === 'string' ? conv['modelTier'] : undefined
      if (nextModelTier === `tier/${existing.tierId}`) return Promise.resolve()

      return convQueue.enqueue(conversationId, async () => {
        if (stopping) return
        const latest = store.get(conversationId)
        if (latest === undefined) return
        const currentConv = getConversationOrUndefined(ctx.host, conversationId)
        const active = currentConv !== undefined ? resolveActiveOrchestrator(currentConv, readTiersState()) : undefined
        if (active === undefined || active.tierId !== latest.tierId) {
          await store.saveRecord(conversationId, undefined)
        }
      })
    },

    handleConversationDeleted(conversationId: number): Promise<void> {
      return convQueue.enqueue(conversationId, async () => {
        if (store.get(conversationId) === undefined) {
          store.syncSessionDoc(conversationId, undefined)
          return
        }
        await store.saveRecord(conversationId, undefined)
      })
    },

    handleConversationReset(conversationId: number): Promise<void> {
      return convQueue.enqueue(conversationId, async () => {
        if (stopping) return
        const existing = store.get(conversationId)
        const conv = getConversationOrUndefined(ctx.host, conversationId)
        const active = conv !== undefined ? resolveActiveOrchestrator(conv, readTiersState()) : undefined
        if (conv === undefined || active === undefined) {
          if (existing !== undefined) await store.saveRecord(conversationId, undefined)
          return
        }
        if (isConversationBusy(conv)) return
        const next = buildPlanningRecord({ conversationId, active })
        await store.saveRecord(conversationId, next)
        await restorePlannerRuntimeModelIfNeeded(ctx, conv, active, existing?.phase === 'execution')
      })
    },

    executeExitPlanModeTool(
      input: ExitPlanModeToolInput,
      context: PluginToolContext,
    ): Promise<PluginToolResultEnvelope> {
      const conversationId = context.conversationId
      return convQueue.enqueue(conversationId, async (): Promise<PluginToolResultEnvelope> => {
        if (stopping) return toolError('builtin:tiers is stopping; cannot transition to execution phase.')
        const plan = typeof input?.plan === 'string' ? input.plan.trim() : ''
        if (plan === '') {
          return toolError('exit_plan_mode requires a non-empty plan string.')
        }
        let conv: ConversationSummary
        try {
          conv = ctx.host.getConversation(conversationId)
        } catch (err) {
          return toolError(ctx.host.redact(errorMessageOf(err)))
        }
        const active = resolveActiveOrchestrator(conv, readTiersState())
        if (active === undefined) {
          return toolError('exit_plan_mode is only allowed in top-level human conversations with an active orchestrator tier.')
        }
        const existing = store.get(conversationId)
        if (existing !== undefined && existing.phase !== 'planning') {
          return toolError('Conversation is already in the orchestrator execution phase.')
        }
        if (ctx.host.setConversationRuntimeModel === undefined) {
          return toolError('Current host does not support runtime model switching (host.setConversationRuntimeModel).')
        }

        const fromModel = conv.model || active.spec.model
        let updatedConv: ConversationSummary
        try {
          updatedConv = await ctx.host.setConversationRuntimeModel(conversationId, {
            model: active.executorModel,
            ...(active.spec.executorThinkingLevel !== undefined
              ? { thinkingLevel: active.spec.executorThinkingLevel }
              : {}),
          })
        } catch (err) {
          return toolError(ctx.host.redact(errorMessageOf(err)))
        }

        const nextRecord: TierOrchestratorRecord = {
          conversationId,
          tierId: active.tierId,
          phase: 'execution',
          plannerModel: active.spec.model,
          ...(active.spec.thinkingLevel ? { plannerThinkingLevel: active.spec.thinkingLevel } : {}),
          executorModel: active.executorModel,
          ...(active.spec.executorThinkingLevel ? { executorThinkingLevel: active.spec.executorThinkingLevel } : {}),
          maxExecutionSteps: active.spec.maxExecutionSteps ?? ORCHESTRATOR_TIER_DEFAULT_MAX_STEPS,
          executionStepCount: 0,
          stepLimitTriggered: false,
          handoffCount: (existing?.tierId === active.tierId ? existing.handoffCount : 0) + 1,
          ...(existing?.activeRunKey !== undefined ? { activeRunKey: existing.activeRunKey } : {}),
          updatedAt: Date.now(),
        }
        await store.saveRecord(conversationId, nextRecord)

        const toModel = updatedConv.model || active.executorModel
        const presentationMeta: OrchestratorTransitionMeta = {
          tool: TIERS_EXIT_PLAN_MODE_TOOL,
          fromPhase: 'planning',
          toPhase: 'execution',
          fromModel,
          toModel,
          tierId: active.tierId,
        }
        return {
          output: `Switched to Execution Phase on executor model ${toModel}. Execute the plan from your exit_plan_mode call above, verify all changes, and call hand_back_to_planner if a Re-plan condition or blocker occurs.`,
          presentationMeta,
        }
      })
    },

    executeHandBackTool(
      input: HandBackToPlannerToolInput,
      context: PluginToolContext,
    ): Promise<PluginToolResultEnvelope> {
      const conversationId = context.conversationId
      return convQueue.enqueue(conversationId, async (): Promise<PluginToolResultEnvelope> => {
        if (stopping) return toolError('builtin:tiers is stopping; cannot hand back to planner.')
        const reason = typeof input?.reason === 'string' ? input.reason.trim() : ''
        const summary = typeof input?.summary === 'string' ? input.summary.trim() : ''
        if (reason === '' || summary === '') {
          return toolError('hand_back_to_planner requires non-empty reason and summary strings.')
        }
        let conv: ConversationSummary
        try {
          conv = ctx.host.getConversation(conversationId)
        } catch (err) {
          return toolError(ctx.host.redact(errorMessageOf(err)))
        }
        const active = resolveActiveOrchestrator(conv, readTiersState())
        if (active === undefined) {
          return toolError('hand_back_to_planner is only allowed in top-level human conversations with an active orchestrator tier.')
        }
        const existing = store.get(conversationId)
        if (existing?.phase !== 'execution') {
          return toolError('hand_back_to_planner can only be called while in the orchestrator execution phase.')
        }
        if (ctx.host.setConversationRuntimeModel === undefined) {
          return toolError('Current host does not support runtime model switching (host.setConversationRuntimeModel).')
        }

        const fromModel = conv.model || active.executorModel
        let updatedConv: ConversationSummary
        try {
          updatedConv = await ctx.host.setConversationRuntimeModel(conversationId, {
            model: active.spec.model,
            ...(active.spec.thinkingLevel !== undefined ? { thinkingLevel: active.spec.thinkingLevel } : {}),
          })
        } catch (err) {
          return toolError(ctx.host.redact(errorMessageOf(err)))
        }

        const executionSteps = existing.executionStepCount
        const stepLimitReached = existing.stepLimitTriggered
        const nextRecord = buildPlanningRecord({
          conversationId,
          active,
          existing,
          activeRunKey: existing.activeRunKey,
        })
        await store.saveRecord(conversationId, nextRecord)

        const toModel = updatedConv.model || active.spec.model
        const redactedReason = ctx.host.redact(reason)
        const redactedSummary = ctx.host.redact(summary)
        const presentationMeta: OrchestratorTransitionMeta = {
          tool: TIERS_HAND_BACK_TOOL,
          fromPhase: 'execution',
          toPhase: 'planning',
          fromModel,
          toModel,
          tierId: active.tierId,
          reason: redactedReason.slice(0, 120),
          executionSteps,
          stepLimitReached,
        }
        const reviewTrigger = stepLimitReached
          ? `scheduled step-budget review after ${executionSteps} steps`
          : `executor hand-back after ${executionSteps} steps`
        return {
          output: `[plan review] Returned to Planning Phase on planner model ${toModel} (${reviewTrigger}).\nReason: ${redactedReason}\nSummary: ${redactedSummary}`,
          presentationMeta,
        }
      })
    },
  }
}
