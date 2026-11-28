/**
 * Runtime state machine, Profile/conversation configuration store, `/plan` bridge,
 * coordinator suppression, and child default model resolution for `builtin:duo`.
 */
import {
  HelmxError,
  type AgentSpawnRequest,
  type BeforeTurnHookPayload,
  type ConversationSummary,
  type DispatchToolsCapability,
  type HelmxPluginContext,
  type HookResult,
  type InputHookPayload,
  type ModelTiersCapability,
  type PluginDocHandle,
  type PluginInUseItem,
  type PluginKvHandle,
  type PluginSessionDocHandle,
  type PluginToolResultEnvelope,
} from '@helmx/protocol'
import {
  PLAN_MODE_ACTIVE_CAPABILITY_ID,
  PLANNING_ORCHESTRATION_TOOLS_CAPABILITY_ID,
  type PlanApprovedEventPayload,
  type PlanModeActiveCapability,
  type PlanningOrchestrationToolsCapability,
} from '../contracts.js'
import {
  createKeyedQueue,
  errorMessageOf,
  getConversationOrUndefined,
  ignoreConversationNotFound,
  listAllKvEntries,
} from '../shared-helpers.js'
import { READ_ONLY_PLANNING_INSPECTION_RULE } from '../shared-planning.js'
import {
  DUO_DEFAULT_MAX_STEPS,
  DUO_EXECUTE_SECTION_ID,
  DUO_EXIT_PLAN_MODE_TOOL,
  DUO_HAND_BACK_TOOL,
  DUO_INPUT_META_KEY,
  DUO_ONLY_TOOL_NAMES,
  DUO_PLAN_BASE_TOOL_WHITELIST,
  DUO_PLAN_SECTION_ID,
  DUO_STEP_LIMIT_SECTION_ID,
  isCoordinatorSuppressed,
  isDuoConversationEligible,
  normalizeDuoModelRef,
  normalizeDuoThinkingLevel,
  normalizeMaxExecutionSteps,
  parseDuoInputMeta,
  resolveDuoModelThroughTiers,
  type DuoConversationConfigRecord,
  type DuoProfileConfig,
  type DuoProfilesDocSnapshot,
  type DuoResolvedConfig,
  type DuoRuntimeRecord,
  type DuoSessionView,
  type DuoTransitionMeta,
} from './contracts.js'

export interface ExitPlanModeToolInput {
  plan: string
}

export interface HandBackToPlannerToolInput {
  reason: string
  summary: string
}

export interface SetDuoConversationInput {
  conversationId: number
  enabled: boolean
  executorModel?: string
  executorThinkingLevel?: string
  maxExecutionSteps?: number
}

export interface SetDuoProfileInput {
  profileId: string
  enabled: boolean
  executorModel?: string
  executorThinkingLevel?: string
  maxExecutionSteps?: number
}

export interface DuoManagerDeps {
  ctx: HelmxPluginContext
  profilesDoc: PluginDocHandle<DuoProfilesDocSnapshot>
  profilesKv: PluginKvHandle<DuoProfileConfig>
  convConfigsKv: PluginKvHandle<DuoConversationConfigRecord>
  statesKv: PluginKvHandle<DuoRuntimeRecord>
  duoDoc: PluginSessionDocHandle<DuoSessionView | null>
}

export interface DuoManager {
  setStopping(next: boolean): void
  hydrate(): void
  reconcile(): Promise<void>
  stop(): Promise<void>
  liveTaskLabels(): string[]
  inUseItems(): PluginInUseItem[]
  getStatus(conversationId: number): DuoSessionView | null
  setConversationConfig(input: SetDuoConversationInput): Promise<DuoSessionView | null>
  clearConversationConfig(conversationId: number): Promise<DuoSessionView | null>
  setProfileConfig(input: SetDuoProfileInput): Promise<DuoProfileConfig>
  clearProfileConfig(profileId: string): Promise<{ removed: boolean }>
  resolveDefaultChildModel(parentConversationId: number): { model: string; thinkingLevel?: string } | undefined
  handleInput(payload: InputHookPayload): Promise<HookResult<InputHookPayload>>
  handleBeforeTurn(turn: BeforeTurnHookPayload): Promise<HookResult<BeforeTurnHookPayload>>
  handleAgentSpawn(request: AgentSpawnRequest): HookResult<AgentSpawnRequest>
  handleTurnSettled(conversationId: number): Promise<void>
  handlePlanApproved(rawPayload: unknown): Promise<void>
  handleConversationUpsert(payload: unknown): Promise<void>
  handleConversationDeleted(conversationId: number): Promise<void>
  handleConversationReset(conversationId: number): Promise<void>
  handleProfileChanged(payload: unknown): Promise<void>
  executeExitPlanModeTool(input: ExitPlanModeToolInput, conversationId: number): Promise<PluginToolResultEnvelope>
  executeHandBackTool(input: HandBackToPlannerToolInput, conversationId: number): Promise<PluginToolResultEnvelope>
}

const PLAN_WORKSPACE_KEEP_TOOLS = new Set<string>([DUO_HAND_BACK_TOOL])

function toolError(message: string, meta?: DuoTransitionMeta): PluginToolResultEnvelope {
  return {
    output: message,
    isError: true,
    ...(meta !== undefined ? { presentationMeta: meta } : {}),
  }
}

function buildDuoPlanningSection(resolved: DuoResolvedConfig): string {
  const executorLine = resolved.executorThinkingLevel
    ? `\`${resolved.executorModel}\` (thinking: \`${resolved.executorThinkingLevel}\`)`
    : `\`${resolved.executorModel}\``
  return [
    '<duo_planning_mode>',
    `You are currently in the READ-ONLY **Planning Phase** of Dual-Phase Orchestration (\`builtin:duo\`). Your Executor counterpart (${executorLine}) is standing by.`,
    READ_ONLY_PLANNING_INSPECTION_RULE,
    `2. Decide whether to handle in place or delegate: if active delegation tools (\`subagent\`, \`SubagentWorkflow\`, \`swarm_dispatch_worker\`, etc.) are present and the task benefits from parallel/isolated execution or verification, stay in Planning Phase and delegate directly. If the task is ready for single-stream file edits, builds/fixes, or final integration in this workspace, call \`${DUO_EXIT_PLAN_MODE_TOOL}({ plan })\` ALONE (never in parallel with other tools) to hand execution to ${executorLine}.`,
    '3. Keep plans actionable and compact: include exact target files, concrete step-by-step edits, verification criteria, and a concise `Re-plan if:` list so the Executor knows when to call `hand_back_to_planner`. Do not invoke `exit_plan_mode` for pure Q&A turns.',
    '</duo_planning_mode>',
  ].join('\n')
}

function buildDuoExecutionSection(record: DuoRuntimeRecord): string {
  const budgetNote =
    record.maxExecutionSteps > 0
      ? `Step budget: step ${record.executionStepCount} of ${record.maxExecutionSteps}.`
      : 'Step budget: unlimited.'
  return [
    '<duo_execution_mode>',
    `You are currently in the **Execution Phase** of Dual-Phase Orchestration (\`builtin:duo\`). ${budgetNote}`,
    '- Execute the approved plan cleanly in the workspace using the full toolset and verify your edits.',
    `- Call \`${DUO_HAND_BACK_TOOL}({ reason, summary })\` ALONE (never in parallel with other tools) if a \`Re-plan if:\` condition triggers, a blocking flaw or missing user clarification prevents safe progress, or you run out of step budget. For normal verified completion, summarize clearly for the user without calling \`${DUO_HAND_BACK_TOOL}\`.`,
    '</duo_execution_mode>',
  ].join('\n')
}

function buildStepLimitSection(record: DuoRuntimeRecord): string {
  return [
    '<duo_execution_step_limit>',
    `Execution step budget reached (${record.executionStepCount}/${record.maxExecutionSteps}). Workspace tools have been paused.`,
    `Call \`${DUO_HAND_BACK_TOOL}({ reason: "step_budget_reached", summary })\` immediately with concise progress, completed edits/checks, and what remains so the Planner can decide the next steps.`,
    '</duo_execution_step_limit>',
  ].join('\n')
}

function parsePlanApprovedEventPayload(raw: unknown): PlanApprovedEventPayload | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  if (typeof obj['conversationId'] !== 'number' || !Number.isSafeInteger(obj['conversationId'])) return undefined
  if (typeof obj['modelSwitched'] !== 'boolean') return undefined
  return {
    conversationId: obj['conversationId'],
    modelSwitched: obj['modelSwitched'],
    ...(typeof obj['model'] === 'string' ? { model: obj['model'] } : {}),
    ...(typeof obj['thinkingLevel'] === 'string' ? { thinkingLevel: obj['thinkingLevel'] } : {}),
    ...(typeof obj['filePath'] === 'string' ? { filePath: obj['filePath'] } : {}),
  }
}

export function createDuoManager(deps: DuoManagerDeps): DuoManager {
  const { ctx, profilesDoc, profilesKv, convConfigsKv, statesKv, duoDoc } = deps
  const queue = createKeyedQueue<number>()

  let stopping = false
  let profileCache = new Map<string, DuoProfileConfig>()
  let convConfigCache = new Map<number, DuoConversationConfigRecord>()
  let runtimeCache = new Map<number, DuoRuntimeRecord>()
  const pendingPlanHandoffResets = new Set<number>()

  const getTiersCapability = (): ModelTiersCapability | undefined =>
    ctx.consume<ModelTiersCapability>('helmx.model-tiers')[0]?.impl

  const isPlanModeActive = (conversationId: number): boolean =>
    ctx.consume<PlanModeActiveCapability>(PLAN_MODE_ACTIVE_CAPABILITY_ID)[0]?.impl.isPlanning(conversationId) === true

  const collectExtraPlanningTools = (): ReadonlySet<string> => {
    const out = new Set<string>()
    for (const { impl } of ctx.consume<DispatchToolsCapability>('helmx.dispatch-tools')) {
      for (const name of impl.toolNames) out.add(name)
    }
    for (const { impl } of ctx.consume<PlanningOrchestrationToolsCapability>(
      PLANNING_ORCHESTRATION_TOOLS_CAPABILITY_ID,
    )) {
      for (const name of impl.toolNames) out.add(name)
    }
    return out
  }

  const syncProfilesDoc = async (): Promise<void> => {
    const snapshot: Record<string, DuoProfileConfig> = {}
    for (const [id, cfg] of profileCache.entries()) {
      snapshot[id] = cfg
    }
    profilesDoc.set({ profiles: snapshot })
    await profilesDoc.flush()
  }

  const resolveConfigForConversation = (
    conv: Pick<ConversationSummary, 'id' | 'parentConversationId' | 'ownedBy' | 'profileId'>,
  ): DuoResolvedConfig | undefined => {
    if (!isDuoConversationEligible(conv)) return undefined
    const convCfg = convConfigCache.get(conv.id)
    const profileCfg = conv.profileId !== undefined ? profileCache.get(conv.profileId) : undefined

    if (convCfg !== undefined) {
      if (!convCfg.enabled) return undefined
      const executorModel = convCfg.executorModel ?? profileCfg?.executorModel
      if (executorModel === undefined || executorModel === '') return undefined
      const executorThinkingLevel =
        convCfg.executorModel !== undefined
          ? convCfg.executorThinkingLevel
          : (convCfg.executorThinkingLevel ?? profileCfg?.executorThinkingLevel)
      const maxExecutionSteps =
        convCfg.maxExecutionSteps ?? profileCfg?.maxExecutionSteps ?? DUO_DEFAULT_MAX_STEPS
      return {
        source: 'conversation',
        executorModel,
        ...(executorThinkingLevel !== undefined ? { executorThinkingLevel } : {}),
        maxExecutionSteps,
        ...(conv.profileId !== undefined ? { profileId: conv.profileId } : {}),
        hasConversationOverride: true,
      }
    }

    if (profileCfg !== undefined && profileCfg.enabled) {
      return {
        source: 'profile',
        executorModel: profileCfg.executorModel,
        ...(profileCfg.executorThinkingLevel !== undefined
          ? { executorThinkingLevel: profileCfg.executorThinkingLevel }
          : {}),
        maxExecutionSteps: profileCfg.maxExecutionSteps,
        ...(conv.profileId !== undefined ? { profileId: conv.profileId } : {}),
        hasConversationOverride: false,
      }
    }

    return undefined
  }

  const buildSessionView = (
    conv: ConversationSummary,
    resolved: DuoResolvedConfig | undefined,
    runtime: DuoRuntimeRecord | undefined,
  ): DuoSessionView | null => {
    if (!isDuoConversationEligible(conv) || resolved === undefined) {
      return null
    }
    const suppressed = isCoordinatorSuppressed(conv)
    const activePhase = !suppressed && runtime?.phase === 'execution' ? 'execution' : 'planning'
    return {
      enabled: true,
      source: resolved.source,
      phase: activePhase,
      plannerModel: conv.modelOverride || conv.model || '',
      ...(conv.thinkingLevelOverride
        ? { plannerThinkingLevel: conv.thinkingLevelOverride }
        : conv.thinkingLevel
          ? { plannerThinkingLevel: conv.thinkingLevel }
          : {}),
      executorModel: resolved.executorModel,
      ...(resolved.executorThinkingLevel !== undefined
        ? { executorThinkingLevel: resolved.executorThinkingLevel }
        : {}),
      maxExecutionSteps: resolved.maxExecutionSteps,
      executionStepCount: activePhase === 'execution' ? (runtime?.executionStepCount ?? 0) : 0,
      stepLimitPaused: activePhase === 'execution' && runtime?.stepLimitPaused === true,
      ...(suppressed ? { suppressedByCoordinator: true } : {}),
      hasConversationOverride: resolved.hasConversationOverride,
      ...(conv.profileId !== undefined ? { profileId: conv.profileId } : {}),
    }
  }

  const syncSessionDocForConversation = (conv: ConversationSummary): void => {
    const resolved = resolveConfigForConversation(conv)
    const view = buildSessionView(conv, resolved, runtimeCache.get(conv.id))
    duoDoc.set(conv.id, view)
  }

  const clearRuntimeRecord = async (conversationId: number): Promise<void> => {
    runtimeCache.delete(conversationId)
    statesKv.delete(String(conversationId))
    await statesKv.flush()
    pendingPlanHandoffResets.delete(conversationId)
  }

  const restoreToPlanning = async (
    conversationId: number,
    syncDoc = true,
  ): Promise<ConversationSummary | undefined> => {
    const runtime = runtimeCache.get(conversationId)
    const shouldRestoreModel =
      runtime?.activeRuntimeOverride === true || runtime?.planChosenModelActive === true
    let restoredConv: ConversationSummary | undefined
    if (shouldRestoreModel) {
      restoredConv = await ignoreConversationNotFound(() =>
        ctx.host.setConversationRuntimeModel(conversationId, null),
      )
    }
    await clearRuntimeRecord(conversationId)
    const latestConv = restoredConv ?? getConversationOrUndefined(ctx.host, conversationId)
    if (syncDoc && latestConv !== undefined) {
      syncSessionDocForConversation(latestConv)
    } else if (syncDoc && latestConv === undefined) {
      duoDoc.set(conversationId, null)
    }
    return latestConv
  }

  const assertModelNotDisabled = async (modelRef: string): Promise<void> => {
    const catalog = await ctx.host.listModels()
    const resolved = resolveDuoModelThroughTiers(modelRef, undefined, getTiersCapability())
    const slash = resolved.model.indexOf('/')
    if (slash <= 0 || slash >= resolved.model.length - 1) return
    const provider = resolved.model.slice(0, slash)
    const modelId = resolved.model.slice(slash + 1)
    const entry = catalog.models.find((m) => m.provider === provider && m.modelId === modelId)
    if (entry?.disabled === true) {
      throw new HelmxError(
        'model_disabled',
        `Executor model '${resolved.model}' is disabled; re-enable it before binding Duo to it`,
        409,
        { model: modelRef },
      )
    }
  }

  const resolveExecutorFromParentOrProfile = (
    parentConversationId: number | undefined,
  ): { model: string; thinkingLevel?: string } | undefined => {
    let cursor = parentConversationId
    const visited = new Set<number>()
    while (cursor !== undefined && !visited.has(cursor) && visited.size < 32) {
      visited.add(cursor)
      const conv = getConversationOrUndefined(ctx.host, cursor)
      if (conv === undefined) break
      const resolved = resolveConfigForConversation(conv)
      if (resolved !== undefined) {
        return resolveDuoModelThroughTiers(
          resolved.executorModel,
          resolved.executorThinkingLevel,
          getTiersCapability(),
        )
      }
      cursor = conv.parentConversationId
    }
    return undefined
  }

  const syncAllConversationDocs = (): void => {
    const convIds = new Set<number>([...convConfigCache.keys(), ...runtimeCache.keys()])
    for (const id of convIds) {
      const conv = getConversationOrUndefined(ctx.host, id)
      if (conv !== undefined) {
        syncSessionDocForConversation(conv)
      }
    }
    try {
      const list = ctx.host.listConversations({ topLevelOnly: true, ownedBy: 'human' })
      for (const conv of list) {
        if (
          isDuoConversationEligible(conv) &&
          (profileCache.has(conv.profileId ?? '') || duoDoc.get(conv.id) !== null)
        ) {
          syncSessionDocForConversation(conv)
        }
      }
    } catch {
      // Minimal unit harnesses may omit host.listConversations.
    }
  }

  return {
    setStopping(next) {
      stopping = next
    },

    hydrate() {
      profileCache = new Map()
      for (const { key, value } of listAllKvEntries<DuoProfileConfig>(profilesKv)) {
        if (value && typeof value.enabled === 'boolean' && typeof value.executorModel === 'string') {
          profileCache.set(key, value)
        }
      }
      convConfigCache = new Map()
      for (const { key, value } of listAllKvEntries<DuoConversationConfigRecord>(convConfigsKv)) {
        const id = Number(key)
        if (Number.isSafeInteger(id) && id >= 1 && value && typeof value.enabled === 'boolean') {
          convConfigCache.set(id, { ...value, conversationId: id })
        }
      }
      runtimeCache = new Map()
      for (const { key, value } of listAllKvEntries<DuoRuntimeRecord>(statesKv)) {
        const id = Number(key)
        if (Number.isSafeInteger(id) && id >= 1 && value && (value.phase === 'planning' || value.phase === 'execution')) {
          runtimeCache.set(id, { ...value, conversationId: id })
        }
      }
      const docMap: Record<string, DuoProfileConfig> = {}
      for (const [id, cfg] of profileCache.entries()) {
        docMap[id] = cfg
      }
      profilesDoc.set({ profiles: docMap })
    },

    async reconcile() {
      const profiles = await ctx.host.profiles.list()
      const liveProfileIds = new Set(profiles.map((p) => p.id))
      let profileRemoved = false
      for (const profileId of [...profileCache.keys()]) {
        if (!liveProfileIds.has(profileId)) {
          profileCache.delete(profileId)
          profilesKv.delete(profileId)
          profileRemoved = true
        }
      }
      if (profileRemoved) {
        await profilesKv.flush()
        await syncProfilesDoc()
      }

      let convConfigRemoved = false
      for (const convId of [...convConfigCache.keys()]) {
        if (getConversationOrUndefined(ctx.host, convId) === undefined) {
          convConfigCache.delete(convId)
          convConfigsKv.delete(String(convId))
          convConfigRemoved = true
        }
      }
      if (convConfigRemoved) {
        await convConfigsKv.flush()
      }

      for (const [convId, rec] of [...runtimeCache.entries()]) {
        await queue.enqueue(convId, async () => {
          const conv = getConversationOrUndefined(ctx.host, convId)
          if (conv === undefined) {
            runtimeCache.delete(convId)
            statesKv.delete(String(convId))
            await statesKv.flush()
            return
          }
          if (conv.status !== 'working' && conv.status !== 'blocked' && rec.phase === 'execution') {
            await restoreToPlanning(convId, true)
          }
        })
      }

      syncAllConversationDocs()
    },

    async stop() {
      stopping = true
      await queue.drain()
      for (const [convId] of [...runtimeCache.entries()]) {
        await queue.enqueue(convId, async () => {
          const runtime = runtimeCache.get(convId)
          let keepStateForReconcile = false
          if (runtime?.activeRuntimeOverride === true || runtime?.planChosenModelActive === true) {
            try {
              await ignoreConversationNotFound(() => ctx.host.setConversationRuntimeModel(convId, null))
            } catch (err) {
              // Kernel `STOP_WINDOW_HOST_CALLS` does not permit `host.setConversationRuntimeModel` during `stopWindow`:
              // retain the KV marker so next boot `reconcile()` clears any runtime model override once idle.
              if (err instanceof HelmxError && err.code === 'plugin_context_closed') {
                keepStateForReconcile = true
              } else {
                throw err
              }
            }
          }
          runtimeCache.delete(convId)
          if (!keepStateForReconcile) {
            statesKv.delete(String(convId))
            await statesKv.flush()
          }
          duoDoc.set(convId, null)
        })
      }
      pendingPlanHandoffResets.clear()
    },

    liveTaskLabels() {
      const labels: string[] = []
      for (const [convId, rec] of runtimeCache.entries()) {
        if (rec.phase === 'execution') {
          labels.push(`Duo execution active on conversation ${convId}`)
        }
      }
      return labels
    },

    inUseItems() {
      const items: PluginInUseItem[] = []
      for (const [profileId, cfg] of profileCache.entries()) {
        if (cfg.enabled) {
          items.push({
            kind: 'profile',
            id: profileId,
            label: `Profile '${profileId}' enables builtin:duo (executor: ${cfg.executorModel})`,
          })
        }
      }
      for (const [convId, cfg] of convConfigCache.entries()) {
        if (cfg.enabled) {
          items.push({
            kind: 'conversation',
            id: String(convId),
            label: `Conversation #${convId} enables builtin:duo`,
          })
        }
      }
      return items
    },

    getStatus(conversationId) {
      const conv = getConversationOrUndefined(ctx.host, conversationId)
      if (conv === undefined) {
        throw new HelmxError('not_found', `Conversation not found: ${conversationId}`, 404, { conversationId })
      }
      const view = buildSessionView(conv, resolveConfigForConversation(conv), runtimeCache.get(conversationId))
      if (view !== null) return view
      const convCfg = convConfigCache.get(conversationId)
      return {
        enabled: false,
        phase: 'planning',
        plannerModel: conv.modelOverride || conv.model || '',
        maxExecutionSteps: DUO_DEFAULT_MAX_STEPS,
        executionStepCount: 0,
        stepLimitPaused: false,
        hasConversationOverride: convCfg !== undefined,
        ...(conv.profileId !== undefined ? { profileId: conv.profileId } : {}),
      }
    },

    async setConversationConfig(input) {
      const conv = getConversationOrUndefined(ctx.host, input.conversationId)
      if (conv === undefined) {
        throw new HelmxError('not_found', `Conversation not found: ${input.conversationId}`, 404, {
          conversationId: input.conversationId,
        })
      }
      if (!isDuoConversationEligible(conv)) {
        throw new HelmxError(
          'duo_unsupported_conversation',
          'Duo orchestration is only supported in top-level human-owned conversations',
          400,
          { conversationId: conv.id },
        )
      }
      return queue.enqueue(conv.id, async () => {
        if (!input.enabled) {
          const rec: DuoConversationConfigRecord = {
            conversationId: conv.id,
            enabled: false,
            updatedAt: Date.now(),
          }
          convConfigCache.set(conv.id, rec)
          convConfigsKv.set(String(conv.id), rec)
          await convConfigsKv.flush()
          const latest = await restoreToPlanning(conv.id, true)
          return buildSessionView(latest ?? conv, undefined, undefined)
        }

        const profileCfg = conv.profileId !== undefined ? profileCache.get(conv.profileId) : undefined
        const existingConv = convConfigCache.get(conv.id)
        const rawModel = input.executorModel ?? existingConv?.executorModel ?? profileCfg?.executorModel
        if (rawModel === undefined || rawModel.trim() === '') {
          throw new HelmxError(
            'validation_error',
            'executorModel is required when enabling Duo on a conversation without a Duo-configured Profile',
            400,
          )
        }
        const executorModel = normalizeDuoModelRef(rawModel, 'executorModel')
        await assertModelNotDisabled(executorModel)

        const rawThinking =
          input.executorThinkingLevel !== undefined
            ? input.executorThinkingLevel
            : input.executorModel !== undefined
              ? undefined
              : (existingConv?.executorThinkingLevel ?? profileCfg?.executorThinkingLevel)
        const executorThinkingLevel = normalizeDuoThinkingLevel(rawThinking, 'executorThinkingLevel')
        const maxExecutionSteps = normalizeMaxExecutionSteps(
          input.maxExecutionSteps ?? existingConv?.maxExecutionSteps ?? profileCfg?.maxExecutionSteps,
        )

        const rec: DuoConversationConfigRecord = {
          conversationId: conv.id,
          enabled: true,
          executorModel,
          ...(executorThinkingLevel !== undefined ? { executorThinkingLevel } : {}),
          maxExecutionSteps,
          updatedAt: Date.now(),
        }
        convConfigCache.set(conv.id, rec)
        convConfigsKv.set(String(conv.id), rec)
        await convConfigsKv.flush()
        const latestConv = getConversationOrUndefined(ctx.host, conv.id) ?? conv
        syncSessionDocForConversation(latestConv)
        return buildSessionView(latestConv, resolveConfigForConversation(latestConv), runtimeCache.get(conv.id))
      })
    },

    async clearConversationConfig(conversationId) {
      const conv = getConversationOrUndefined(ctx.host, conversationId)
      if (conv === undefined) {
        throw new HelmxError('not_found', `Conversation not found: ${conversationId}`, 404, { conversationId })
      }
      if (!isDuoConversationEligible(conv)) {
        throw new HelmxError(
          'duo_unsupported_conversation',
          'Duo orchestration is only supported in top-level human-owned conversations',
          400,
          { conversationId: conv.id },
        )
      }
      return queue.enqueue(conv.id, async () => {
        convConfigCache.delete(conv.id)
        convConfigsKv.delete(String(conv.id))
        await convConfigsKv.flush()
        const latest = await restoreToPlanning(conv.id, true)
        const target = latest ?? conv
        return buildSessionView(target, resolveConfigForConversation(target), undefined)
      })
    },

    async setProfileConfig(input) {
      const profileId = input.profileId.trim()
      if (!profileId) {
        throw new HelmxError('validation_error', 'profileId must be a non-empty string', 400)
      }
      const profile = await ctx.host.profiles.get(profileId)
      if (!profile) {
        throw new HelmxError('profile_not_found', `Profile '${profileId}' does not exist`, 404, { profileId })
      }
      const existing = profileCache.get(profileId)
      if (!input.enabled) {
        const next: DuoProfileConfig = {
          enabled: false,
          executorModel:
            input.executorModel !== undefined && input.executorModel.trim() !== ''
              ? normalizeDuoModelRef(input.executorModel, 'executorModel')
              : (existing?.executorModel ?? ''),
          ...(existing?.executorThinkingLevel !== undefined
            ? { executorThinkingLevel: existing.executorThinkingLevel }
            : {}),
          maxExecutionSteps: normalizeMaxExecutionSteps(
            input.maxExecutionSteps ?? existing?.maxExecutionSteps,
          ),
          updatedAt: Date.now(),
        }
        profileCache.set(profileId, next)
        profilesKv.set(profileId, next)
        await profilesKv.flush()
        await syncProfilesDoc()
        syncAllConversationDocs()
        return next
      }

      const rawModel = input.executorModel ?? existing?.executorModel
      if (rawModel === undefined || rawModel.trim() === '') {
        throw new HelmxError('validation_error', 'executorModel is required when enabling Duo on a Profile', 400)
      }
      const executorModel = normalizeDuoModelRef(rawModel, 'executorModel')
      await assertModelNotDisabled(executorModel)
      const rawThinking =
        input.executorThinkingLevel !== undefined
          ? input.executorThinkingLevel
          : input.executorModel !== undefined
            ? undefined
            : existing?.executorThinkingLevel
      const executorThinkingLevel = normalizeDuoThinkingLevel(rawThinking, 'executorThinkingLevel')
      const maxExecutionSteps = normalizeMaxExecutionSteps(
        input.maxExecutionSteps ?? existing?.maxExecutionSteps,
      )
      const next: DuoProfileConfig = {
        enabled: true,
        executorModel,
        ...(executorThinkingLevel !== undefined ? { executorThinkingLevel } : {}),
        maxExecutionSteps,
        updatedAt: Date.now(),
      }
      profileCache.set(profileId, next)
      profilesKv.set(profileId, next)
      await profilesKv.flush()
      await syncProfilesDoc()
      syncAllConversationDocs()
      return next
    },

    async clearProfileConfig(profileId) {
      const id = profileId.trim()
      if (!id) {
        throw new HelmxError('validation_error', 'profileId must be a non-empty string', 400)
      }
      const existed = profileCache.delete(id)
      if (existed) {
        profilesKv.delete(id)
        await profilesKv.flush()
        await syncProfilesDoc()
        syncAllConversationDocs()
      }
      return { removed: existed }
    },

    resolveDefaultChildModel(parentConversationId) {
      return resolveExecutorFromParentOrProfile(parentConversationId)
    },

    async handleInput(payload) {
      if (stopping) return { action: 'continue' }
      const parsedMeta = parseDuoInputMeta(payload.input.meta)
      if (parsedMeta.present && !parsedMeta.valid) {
        return { action: 'block', reason: parsedMeta.reason }
      }
      const conv = getConversationOrUndefined(ctx.host, payload.conversationId)
      if (conv === undefined || !isDuoConversationEligible(conv)) {
        return { action: 'continue' }
      }

      return queue.enqueue(conv.id, async () => {
        if (parsedMeta.present && parsedMeta.valid) {
          if (!parsedMeta.enabled) {
            const rec: DuoConversationConfigRecord = {
              conversationId: conv.id,
              enabled: false,
              updatedAt: Date.now(),
            }
            convConfigCache.set(conv.id, rec)
            convConfigsKv.set(String(conv.id), rec)
            await convConfigsKv.flush()
            await restoreToPlanning(conv.id, true)
            return { action: 'continue' }
          }
          const profileCfg = conv.profileId !== undefined ? profileCache.get(conv.profileId) : undefined
          const executorModel = parsedMeta.executorModel ?? profileCfg?.executorModel
          if (executorModel === undefined) {
            return {
              action: 'block',
              reason: `input.meta['${DUO_INPUT_META_KEY}'].executorModel is required when Profile has no Duo config`,
            }
          }
          const rec: DuoConversationConfigRecord = {
            conversationId: conv.id,
            enabled: true,
            executorModel,
            ...(parsedMeta.executorThinkingLevel !== undefined
              ? { executorThinkingLevel: parsedMeta.executorThinkingLevel }
              : profileCfg?.executorThinkingLevel !== undefined && parsedMeta.executorModel === undefined
                ? { executorThinkingLevel: profileCfg.executorThinkingLevel }
                : {}),
            maxExecutionSteps:
              parsedMeta.maxExecutionSteps ?? profileCfg?.maxExecutionSteps ?? DUO_DEFAULT_MAX_STEPS,
            updatedAt: Date.now(),
          }
          convConfigCache.set(conv.id, rec)
          convConfigsKv.set(String(conv.id), rec)
          await convConfigsKv.flush()
        }

        const latestConv = getConversationOrUndefined(ctx.host, conv.id) ?? conv
        const runtime = runtimeCache.get(conv.id)
        if (runtime !== undefined) {
          const isBusy = latestConv.status === 'working' || latestConv.status === 'blocked'
          const isSteer = isBusy && (payload.input.whenBusy ?? 'steer') === 'steer'
          if (isSteer && runtime.phase === 'execution') {
            const next: DuoRuntimeRecord = { ...runtime, turnHadSteer: true, updatedAt: Date.now() }
            runtimeCache.set(conv.id, next)
            statesKv.set(String(conv.id), next)
            await statesKv.flush()
          } else if (!isBusy) {
            await restoreToPlanning(conv.id, true)
            return { action: 'continue' }
          }
        }
        syncSessionDocForConversation(latestConv)
        return { action: 'continue' }
      })
    },

    async handleBeforeTurn(turn) {
      const stripDuoArtifacts = (): HookResult<BeforeTurnHookPayload> => {
        const tools = turn.tools.filter((t) => !DUO_ONLY_TOOL_NAMES.has(t.name))
        const sections = turn.sections.filter(
          (s) => s.id !== DUO_PLAN_SECTION_ID && s.id !== DUO_EXECUTE_SECTION_ID && s.id !== DUO_STEP_LIMIT_SECTION_ID,
        )
        if (tools.length === turn.tools.length && sections.length === turn.sections.length) {
          return { action: 'continue' }
        }
        return { action: 'transform', value: { ...turn, tools, sections } }
      }

      const conv = turn.conversation
      if (stopping || !isDuoConversationEligible(conv)) {
        return stripDuoArtifacts()
      }

      if (isPlanModeActive(conv.id)) {
        return { action: 'continue' }
      }

      const resolved = resolveConfigForConversation(conv)
      if (resolved === undefined) {
        if (runtimeCache.has(conv.id)) {
          await queue.enqueue(conv.id, () => restoreToPlanning(conv.id, true))
        }
        return stripDuoArtifacts()
      }

      if (isCoordinatorSuppressed(conv)) {
        if (runtimeCache.has(conv.id)) {
          await queue.enqueue(conv.id, () => restoreToPlanning(conv.id, true))
        } else {
          syncSessionDocForConversation(conv)
        }
        return stripDuoArtifacts()
      }

      const runtime = runtimeCache.get(conv.id)
      const phase = runtime?.phase === 'execution' ? 'execution' : 'planning'

      if (phase === 'planning') {
        const extraAllowed = collectExtraPlanningTools()
        const tools = turn.tools.filter(
          (t) =>
            t.name !== DUO_HAND_BACK_TOOL &&
            (DUO_PLAN_BASE_TOOL_WHITELIST.has(t.name) || extraAllowed.has(t.name)),
        )
        const sections = [
          ...turn.sections.filter(
            (s) => s.id !== DUO_PLAN_SECTION_ID && s.id !== DUO_EXECUTE_SECTION_ID && s.id !== DUO_STEP_LIMIT_SECTION_ID,
          ),
          { id: DUO_PLAN_SECTION_ID, text: buildDuoPlanningSection(resolved) },
        ]
        syncSessionDocForConversation(conv)
        return { action: 'transform', value: { ...turn, tools, sections } }
      }

      const activeRuntime = runtime!
      const maxSteps = activeRuntime.maxExecutionSteps
      const currentSteps = activeRuntime.executionStepCount
      if (maxSteps > 0 && currentSteps >= maxSteps) {
        const pausedRecord: DuoRuntimeRecord = {
          ...activeRuntime,
          stepLimitPaused: true,
          updatedAt: Date.now(),
        }
        runtimeCache.set(conv.id, pausedRecord)
        statesKv.set(String(conv.id), pausedRecord)
        await statesKv.flush()
        syncSessionDocForConversation(conv)

        const tools = turn.tools.filter((t) => PLAN_WORKSPACE_KEEP_TOOLS.has(t.name))
        const sections = [
          ...turn.sections.filter(
            (s) => s.id !== DUO_PLAN_SECTION_ID && s.id !== DUO_EXECUTE_SECTION_ID && s.id !== DUO_STEP_LIMIT_SECTION_ID,
          ),
          { id: DUO_STEP_LIMIT_SECTION_ID, text: buildStepLimitSection(pausedRecord) },
        ]
        return { action: 'transform', value: { ...turn, tools, sections } }
      }

      const nextRecord: DuoRuntimeRecord = {
        ...activeRuntime,
        executionStepCount: currentSteps + 1,
        stepLimitPaused: false,
        updatedAt: Date.now(),
      }
      runtimeCache.set(conv.id, nextRecord)
      statesKv.set(String(conv.id), nextRecord)
      await statesKv.flush()
      syncSessionDocForConversation(conv)

      const tools = turn.tools.filter((t) => t.name !== DUO_EXIT_PLAN_MODE_TOOL)
      const sections = [
        ...turn.sections.filter(
          (s) => s.id !== DUO_PLAN_SECTION_ID && s.id !== DUO_EXECUTE_SECTION_ID && s.id !== DUO_STEP_LIMIT_SECTION_ID,
        ),
        { id: DUO_EXECUTE_SECTION_ID, text: buildDuoExecutionSection(nextRecord) },
      ]
      return { action: 'transform', value: { ...turn, tools, sections } }
    },

    handleAgentSpawn(request) {
      if (stopping) return { action: 'continue' }
      if (request.resume !== undefined || request.reattach !== undefined) return { action: 'continue' }
      if (request.model !== undefined && request.model.trim() !== '') return { action: 'continue' }
      if (request.agentType !== undefined && request.agentType.includes(':')) return { action: 'continue' }

      let resolvedTarget: { model: string; thinkingLevel?: string } | undefined
      if (request.agentType !== undefined && request.agentType.trim() !== '') {
        const profileCfg = profileCache.get(request.agentType.trim())
        if (profileCfg !== undefined && profileCfg.enabled) {
          resolvedTarget = resolveDuoModelThroughTiers(
            profileCfg.executorModel,
            profileCfg.executorThinkingLevel,
            getTiersCapability(),
          )
        }
      }
      if (resolvedTarget === undefined) {
        resolvedTarget = resolveExecutorFromParentOrProfile(request.parentConversationId)
      }
      if (resolvedTarget === undefined) return { action: 'continue' }

      return {
        action: 'transform',
        value: {
          ...request,
          model: resolvedTarget.model,
          ...(request.effort === undefined && resolvedTarget.thinkingLevel !== undefined
            ? { effort: resolvedTarget.thinkingLevel }
            : {}),
        },
      }
    },

    async handleTurnSettled(conversationId) {
      pendingPlanHandoffResets.delete(conversationId)
      if (!runtimeCache.has(conversationId)) return
      await queue.enqueue(conversationId, async () => {
        pendingPlanHandoffResets.delete(conversationId)
        if (!runtimeCache.has(conversationId)) return
        await restoreToPlanning(conversationId, true)
      })
    },

    async handlePlanApproved(rawPayload) {
      if (stopping) return
      const payload = parsePlanApprovedEventPayload(rawPayload)
      if (payload === undefined) return
      await queue.enqueue(payload.conversationId, async () => {
        const conv = getConversationOrUndefined(ctx.host, payload.conversationId)
        if (conv === undefined || !isDuoConversationEligible(conv) || isCoordinatorSuppressed(conv)) {
          return
        }
        const resolved = resolveConfigForConversation(conv)
        if (resolved === undefined) return

        let activeRuntimeOverride = false
        let planChosenModelActive = false
        if (!payload.modelSwitched) {
          try {
            await ctx.host.setConversationRuntimeModel(conv.id, {
              model: resolved.executorModel,
              ...(resolved.executorThinkingLevel !== undefined
                ? { thinkingLevel: resolved.executorThinkingLevel }
                : {}),
              resetOnRunEnd: false,
            })
            activeRuntimeOverride = true
          } catch {
            return
          }
        } else {
          planChosenModelActive = true
        }

        const nextRecord: DuoRuntimeRecord = {
          conversationId: conv.id,
          phase: 'execution',
          executorModel: resolved.executorModel,
          ...(resolved.executorThinkingLevel !== undefined
            ? { executorThinkingLevel: resolved.executorThinkingLevel }
            : {}),
          maxExecutionSteps: resolved.maxExecutionSteps,
          executionStepCount: 0,
          stepLimitPaused: false,
          ...(payload.filePath !== undefined ? { planFilePath: payload.filePath } : {}),
          activeRuntimeOverride,
          planChosenModelActive,
          updatedAt: Date.now(),
        }
        runtimeCache.set(conv.id, nextRecord)
        statesKv.set(String(conv.id), nextRecord)
        await statesKv.flush()
        pendingPlanHandoffResets.add(conv.id)
        syncSessionDocForConversation(getConversationOrUndefined(ctx.host, conv.id) ?? conv)
      })
    },

    async handleConversationUpsert(payload) {
      const event = payload as { type?: unknown; conversation?: ConversationSummary } | undefined
      const conv = event?.type === 'conversation.upsert' ? event.conversation : undefined
      if (!conv || typeof conv.id !== 'number') return
      if (isCoordinatorSuppressed(conv) && runtimeCache.has(conv.id)) {
        await queue.enqueue(conv.id, () => restoreToPlanning(conv.id, true))
        return
      }
      if (
        convConfigCache.has(conv.id) ||
        (conv.profileId !== undefined && profileCache.has(conv.profileId)) ||
        duoDoc.get(conv.id) !== null
      ) {
        syncSessionDocForConversation(conv)
      }
    },

    async handleConversationDeleted(conversationId) {
      if (stopping) return
      if (!convConfigCache.has(conversationId) && !runtimeCache.has(conversationId)) return
      await queue.enqueue(conversationId, async () => {
        if (stopping) return
        convConfigCache.delete(conversationId)
        convConfigsKv.delete(String(conversationId))
        await convConfigsKv.flush()
        runtimeCache.delete(conversationId)
        statesKv.delete(String(conversationId))
        await statesKv.flush()
        pendingPlanHandoffResets.delete(conversationId)
      })
    },

    async handleConversationReset(conversationId) {
      if (pendingPlanHandoffResets.delete(conversationId)) {
        return
      }
      if (!runtimeCache.has(conversationId)) return
      await queue.enqueue(conversationId, async () => {
        if (!runtimeCache.has(conversationId)) return
        await restoreToPlanning(conversationId, true)
      })
    },

    async handleProfileChanged(payload) {
      const event = payload as { profile?: { id?: unknown }; removed?: boolean } | undefined
      const profileId = typeof event?.profile?.id === 'string' ? event.profile.id : undefined
      if (!profileId) return
      if (event?.removed === true) {
        const existed = profileCache.delete(profileId)
        if (existed) {
          profilesKv.delete(profileId)
          await profilesKv.flush()
          await syncProfilesDoc()
        }
      }
      syncAllConversationDocs()
    },

    async executeExitPlanModeTool(input, conversationId) {
      const planText = typeof input?.plan === 'string' ? ctx.host.redact(input.plan).trim() : ''
      if (!planText) {
        return toolError('exit_plan_mode requires a non-empty plan string.')
      }

      return queue.enqueue(conversationId, async () => {
        const conv = getConversationOrUndefined(ctx.host, conversationId)
        if (conv === undefined) {
          return toolError(`Conversation ${conversationId} not found.`)
        }
        if (!isDuoConversationEligible(conv)) {
          return toolError('exit_plan_mode is only available in top-level human-owned conversations.')
        }
        if (isPlanModeActive(conv.id)) {
          return toolError('exit_plan_mode is unavailable while read-only /plan mode is active.')
        }
        if (isCoordinatorSuppressed(conv)) {
          return toolError('exit_plan_mode is disabled while coordinating an active Swarm group.')
        }
        const resolved = resolveConfigForConversation(conv)
        if (resolved === undefined) {
          return toolError('exit_plan_mode requires builtin:duo to be enabled on this conversation or Profile.')
        }
        const current = runtimeCache.get(conv.id)
        if (current?.phase === 'execution') {
          return toolError('Conversation is already in execution phase.')
        }

        const fromModel = conv.model || conv.modelOverride || resolved.executorModel
        let nextSummary: ConversationSummary
        try {
          nextSummary = await ctx.host.setConversationRuntimeModel(conv.id, {
            model: resolved.executorModel,
            ...(resolved.executorThinkingLevel !== undefined
              ? { thinkingLevel: resolved.executorThinkingLevel }
              : {}),
            resetOnRunEnd: false,
          })
        } catch (err) {
          return toolError(
            `Failed to switch to executor model "${resolved.executorModel}": ${ctx.host.redact(errorMessageOf(err))}. Staying in planning phase.`,
          )
        }

        const nextRecord: DuoRuntimeRecord = {
          conversationId: conv.id,
          phase: 'execution',
          executorModel: resolved.executorModel,
          ...(resolved.executorThinkingLevel !== undefined
            ? { executorThinkingLevel: resolved.executorThinkingLevel }
            : {}),
          maxExecutionSteps: resolved.maxExecutionSteps,
          executionStepCount: 0,
          stepLimitPaused: false,
          planText,
          activeRuntimeOverride: true,
          updatedAt: Date.now(),
        }
        runtimeCache.set(conv.id, nextRecord)
        statesKv.set(String(conv.id), nextRecord)
        await statesKv.flush()
        syncSessionDocForConversation(nextSummary)

        const toModel = nextSummary.model || resolved.executorModel
        const meta: DuoTransitionMeta = {
          tool: DUO_EXIT_PLAN_MODE_TOOL,
          fromModel,
          toModel,
          fromPhase: 'planning',
          toPhase: 'execution',
        }
        return {
          output: `Entered execution phase on ${toModel}. Execute the plan carefully and verify changes before responding.`,
          presentationMeta: meta,
        }
      })
    },

    async executeHandBackTool(input, conversationId) {
      const reason = typeof input?.reason === 'string' ? ctx.host.redact(input.reason).trim() : ''
      const summary = typeof input?.summary === 'string' ? ctx.host.redact(input.summary).trim() : ''
      if (!reason || !summary) {
        return toolError('hand_back_to_planner requires non-empty reason and summary strings.')
      }

      return queue.enqueue(conversationId, async () => {
        const conv = getConversationOrUndefined(ctx.host, conversationId)
        if (conv === undefined) {
          return toolError(`Conversation ${conversationId} not found.`)
        }
        if (!isDuoConversationEligible(conv)) {
          return toolError('hand_back_to_planner is only available in top-level human-owned conversations.')
        }
        if (isCoordinatorSuppressed(conv)) {
          return toolError('hand_back_to_planner is disabled while coordinating an active Swarm group.')
        }
        const current = runtimeCache.get(conv.id)
        if (current === undefined || current.phase !== 'execution') {
          return toolError('hand_back_to_planner can only be called while in execution phase.')
        }

        const fromModel = conv.model || current.executorModel
        const restored = await restoreToPlanning(conv.id, true)
        const toModel = restored?.model || restored?.modelOverride || conv.modelOverride || ''
        const meta: DuoTransitionMeta = {
          tool: DUO_HAND_BACK_TOOL,
          fromModel,
          toModel: toModel || fromModel,
          fromPhase: 'execution',
          toPhase: 'planning',
          reason,
        }
        return {
          output: `Returned control to planner${toModel ? ` (${toModel})` : ''}. Reason: ${reason}\nSummary: ${summary}`,
          presentationMeta: meta,
        }
      })
    },
  }
}
