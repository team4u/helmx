/**
 * Core orchestration manager for `builtin:orchestrator` Orchestrator.
 */
import {
  HelmxError,
  parseModelTierRef,
  type AgentSpawnRequest,
  type BeforeTurnHookPayload,
  type ConversationSummary,
  type HelmxPluginContext,
  type HookResult,
  type InputHookPayload,
  type ModelCatalog,
  type ModelTiersCapability,
  type ModelTierSpec,
  type PluginDocHandle,
  type PluginInUseItem,
  type PluginKvHandle,
  type PluginSearchItem,
  type PluginSearchQuery,
  type PluginSessionDocHandle,
  type PluginToolResultEnvelope,
  type Profile,
  type ProvidedCapability,
} from '@helmx/protocol'
import {
  PLAN_MODE_ACTIVE_CAPABILITY_ID,
  PLANNING_ORCHESTRATION_TOOLS_CAPABILITY_ID,
  type PlanApprovedEventPayload,
  type PlanModeActiveCapability,
  type PlanningOrchestrationToolsCapability,
} from '../contracts.js'
import { compactOneLine, rankSearchCandidates } from '../search-utils.js'
import {
  createKeyedQueue,
  errorMessageOf,
  getConversationOrUndefined,
  ignoreConversationNotFound,
  listAllKvEntries,
} from '../shared-helpers.js'
import { READ_ONLY_PLANNING_INSPECTION_RULE } from '../shared-planning.js'
import {
  MAX_ORCHESTRATORS_COUNT,
  ORCHESTRATOR_DEFAULT_MAX_STEPS,
  ORCHESTRATOR_EXECUTE_SECTION_ID,
  ORCHESTRATOR_EXIT_PLAN_MODE_TOOL,
  ORCHESTRATOR_HAND_BACK_TOOL,
  ORCHESTRATOR_ONLY_TOOL_NAMES,
  ORCHESTRATOR_PLAN_BASE_TOOL_WHITELIST,
  ORCHESTRATOR_PLAN_SECTION_ID,
  ORCHESTRATOR_PLUGIN_ID,
  ORCHESTRATOR_SCREEN_ID,
  ORCHESTRATOR_STEP_LIMIT_SECTION_ID,
  assertOrchestratorId,
  collectExternalTierMap,
  formatOrchestratorModelShortName,
  isCoordinatorSuppressed,
  isOrchestratorConversationEligible,
  normalizeMaxExecutionSteps,
  normalizeOrchestratorDescription,
  normalizeOrchestratorModelRef,
  normalizeOrchestratorName,
  normalizeOrchestratorThinkingLevel,
  resolveOrchestratorModelThroughExternalTiers,
  type OrchestratorConversationOverrideRecord,
  type OrchestratorItem,
  type OrchestratorItemView,
  type OrchestratorResolvedConfig,
  type OrchestratorRuntimeRecord,
  type OrchestratorSessionView,
  type OrchestratorStateDocSnapshot,
  type OrchestratorTransitionMeta,
} from './contracts.js'

const DISPATCH_TOOLS_CAPABILITY_ID = 'helmx.dispatch-tools' as const
const MAX_ANCESTOR_HOPS = 32

export interface ExitPlanModeToolInput {
  plan?: string
}

export interface HandBackToPlannerToolInput {
  reason?: string
  summary?: string
}

export interface SetOrchestratorItemInput {
  id: string
  name: string
  description?: string
  plannerModel: string
  plannerThinkingLevel?: string
  executorModel: string
  executorThinkingLevel?: string
  maxExecutionSteps?: number
}

export interface RemoveOrchestratorItemInput {
  id: string
  force?: boolean
}

export interface OverrideOrchestratorExecutorInput {
  conversationId: number
  executorModel: string
  executorThinkingLevel?: string
  maxExecutionSteps?: number
}

export interface OrchestratorManagerDeps {
  ctx: HelmxPluginContext
  stateDoc: PluginDocHandle<OrchestratorStateDocSnapshot>
  itemsKv: PluginKvHandle<OrchestratorItem>
  convOverridesKv: PluginKvHandle<OrchestratorConversationOverrideRecord>
  statesKv: PluginKvHandle<OrchestratorRuntimeRecord>
  orchestratorDoc: PluginSessionDocHandle<OrchestratorSessionView | null>
}

export interface OrchestratorManager {
  readonly modelTiersCapability: ModelTiersCapability
  start(): Promise<void>
  reconcile(): Promise<void>
  stop(): Promise<void>
  inUseItems(): Promise<PluginInUseItem[]>
  listItems(): Promise<OrchestratorItemView[]>
  getItem(id: string): Promise<OrchestratorItemView>
  setItem(input: SetOrchestratorItemInput): Promise<OrchestratorItemView>
  removeItem(input: RemoveOrchestratorItemInput): Promise<{ removed: boolean }>
  getStatus(conversationId: number): OrchestratorSessionView | null
  overrideExecutor(input: OverrideOrchestratorExecutorInput): Promise<OrchestratorSessionView>
  clearOverride(conversationId: number): Promise<OrchestratorSessionView | null>
  searchItems(input: PluginSearchQuery, signal: AbortSignal): PluginSearchItem[]
  resolveDefaultChildModel(parentConversationId: number): { model: string; thinkingLevel?: string } | undefined
  handleInput(payload: InputHookPayload): Promise<HookResult<InputHookPayload>>
  handleBeforeTurn(turn: BeforeTurnHookPayload): Promise<HookResult<BeforeTurnHookPayload>>
  handleAgentSpawn(request: AgentSpawnRequest): HookResult<AgentSpawnRequest>
  handleTurnSettled(conversationId: number): Promise<void>
  handlePlanApproved(rawPayload: unknown): Promise<void>
  handleConversationUpsert(payload: unknown): Promise<void>
  handleConversationDeleted(conversationId: number): Promise<void>
  handleConversationReset(conversationId: number): Promise<void>
  handleProfileChanged(payload: unknown): void
  executeExitPlanModeTool(input: ExitPlanModeToolInput, conversationId: number): Promise<PluginToolResultEnvelope>
  executeHandBackTool(input: HandBackToPlannerToolInput, conversationId: number): Promise<PluginToolResultEnvelope>
}

const PLAN_WORKSPACE_KEEP_TOOLS = new Set<string>([ORCHESTRATOR_HAND_BACK_TOOL])

function toolError(message: string, meta?: OrchestratorTransitionMeta): PluginToolResultEnvelope {
  return {
    output: message,
    isError: true,
    ...(meta !== undefined ? { presentationMeta: meta } : {}),
  }
}

function buildOrchestratorPlanningSection(resolved: OrchestratorResolvedConfig): string {
  const executorLine = resolved.executorThinkingLevel
    ? `\`${resolved.executorModel}\` (thinking: \`${resolved.executorThinkingLevel}\`)`
    : `\`${resolved.executorModel}\``
  return [
    '<orchestrator_planning_mode>',
    `You are currently in the READ-ONLY **Planning Phase** of Orchestrator (\`builtin:orchestrator\`, \`tier/${resolved.orchestratorId}\`). Your Executor counterpart (${executorLine}) is standing by.`,
    READ_ONLY_PLANNING_INSPECTION_RULE,
    `2. Decide whether to handle in place or delegate: if active delegation tools (\`subagent\`, \`SubagentWorkflow\`, \`swarm_dispatch_worker\`, etc.) are present and the task benefits from parallel/isolated execution or verification, stay in Planning Phase and delegate directly. If the task is ready for single-stream file edits, builds/fixes, or final integration in this workspace, call \`${ORCHESTRATOR_EXIT_PLAN_MODE_TOOL}({ plan })\` ALONE (never in parallel with other tools) to hand execution to ${executorLine}.`,
    '3. Keep plans actionable and compact: include exact target files, concrete step-by-step edits, verification criteria, and a concise `Re-plan if:` list so the Executor knows when to call `hand_back_to_planner`. Do not invoke `exit_plan_mode` for pure Q&A turns.',
    '</orchestrator_planning_mode>',
  ].join('\n')
}

function buildOrchestratorExecutionSection(record: OrchestratorRuntimeRecord): string {
  const budgetNote =
    record.maxExecutionSteps > 0
      ? `Step budget: step ${record.executionStepCount} of ${record.maxExecutionSteps}.`
      : 'Step budget: unlimited.'
  return [
    '<orchestrator_execution_mode>',
    `You are currently in the **Execution Phase** of Orchestrator (\`builtin:orchestrator\`). ${budgetNote}`,
    '- Execute the approved plan cleanly in the workspace using the full toolset and verify your edits.',
    `- Call \`${ORCHESTRATOR_HAND_BACK_TOOL}({ reason, summary })\` ALONE (never in parallel with other tools) if a \`Re-plan if:\` condition triggers, a blocking flaw or missing user clarification prevents safe progress, or you run out of step budget. For normal verified completion, summarize clearly for the user without calling \`${ORCHESTRATOR_HAND_BACK_TOOL}\`.`,
    '</orchestrator_execution_mode>',
  ].join('\n')
}

function buildStepLimitSection(record: OrchestratorRuntimeRecord): string {
  return [
    '<orchestrator_execution_step_limit>',
    `Execution step budget reached (${record.executionStepCount}/${record.maxExecutionSteps}). Workspace tools have been paused.`,
    `Call \`${ORCHESTRATOR_HAND_BACK_TOOL}({ reason: "step_budget_reached", summary })\` immediately with concise progress, completed edits/checks, and what remains so the Planner can decide the next steps.`,
    '</orchestrator_execution_step_limit>',
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

function serializeTiersSnapshot(tiers: Readonly<Record<string, ModelTierSpec>>): string {
  const sorted = Object.keys(tiers)
    .sort()
    .map((id) => {
      const s = tiers[id]!
      return [
        id,
        s.model,
        s.thinkingLevel ?? '',
        s.description ?? '',
        s.displayGroup ?? '',
        s.displayLabel ?? '',
        s.displayDetail ?? '',
        s.preserveRef === true ? '1' : '0',
        s.singleTurnEligible === false ? '0' : '1',
      ]
    })
  return JSON.stringify(sorted)
}

function findConcreteCatalogEntry(
  catalog: ModelCatalog,
  modelRef: string,
): ModelCatalog['models'][number] | undefined {
  const slash = modelRef.indexOf('/')
  if (slash <= 0 || slash >= modelRef.length - 1) return undefined
  const provider = modelRef.slice(0, slash)
  const modelId = modelRef.slice(slash + 1)
  return catalog.models.find((m) => m.provider === provider && m.modelId === modelId)
}

export function createOrchestratorManager(deps: OrchestratorManagerDeps): OrchestratorManager {
  const { ctx, stateDoc, itemsKv, convOverridesKv, statesKv, orchestratorDoc } = deps
  const queue = createKeyedQueue<number>()

  let stopping = false
  let itemCache = new Map<string, OrchestratorItem>()
  let convOverrideCache = new Map<number, OrchestratorConversationOverrideRecord>()
  let runtimeCache = new Map<number, OrchestratorRuntimeRecord>()
  let profileModelsCache = new Map<string, string | undefined>()
  const activeItemByConvId = new Map<number, string>()
  const pendingPlanHandoffResets = new Set<number>()

  const orchestratorTierListeners = new Set<() => void>()
  let externalCapabilityUnsub: (() => void) | undefined
  const externalTierUnsubs = new Map<ModelTiersCapability, () => void>()
  let lastExternalSnapshot = ''
  let lastEmittedTiersSnapshot = ''

  const getExternalTierEntries = (): ReadonlyArray<ProvidedCapability<ModelTiersCapability>> =>
    ctx
      .consume<ModelTiersCapability>('helmx.model-tiers')
      .filter((entry: ProvidedCapability<ModelTiersCapability>) => entry.pluginId !== ORCHESTRATOR_PLUGIN_ID)

  const getExternalTiers = (): Record<string, ModelTierSpec> =>
    collectExternalTierMap(ctx.consume<ModelTiersCapability>('helmx.model-tiers'))

  const findExternalTierConflict = (id: string): string | undefined => {
    for (const entry of getExternalTierEntries()) {
      let tiers: Readonly<Record<string, ModelTierSpec>> | undefined
      try {
        tiers = entry.impl.getTiers()
      } catch {
        continue
      }
      if (tiers && Object.hasOwn(tiers, id)) {
        return entry.pluginId
      }
    }
    return undefined
  }

  const buildMountedTiersRecord = (
    externalTiers: Readonly<Record<string, ModelTierSpec>>,
  ): Record<string, ModelTierSpec> => {
    const out: Record<string, ModelTierSpec> = {}
    const sorted = [...itemCache.values()].sort((a, b) => a.id.localeCompare(b.id))
    for (const item of sorted) {
      const planner = resolveOrchestratorModelThroughExternalTiers(
        item.plannerModel,
        item.plannerThinkingLevel,
        externalTiers,
      )
      if (!planner) {
        // Unresolved external Planner tier: omit orchestrator from mounted ModelCatalog tiers until resolved.
        continue
      }
      const executor = resolveOrchestratorModelThroughExternalTiers(
        item.executorModel,
        item.executorThinkingLevel,
        externalTiers,
      )
      const plannerShort = formatOrchestratorModelShortName(planner.model)
      const executorShort = formatOrchestratorModelShortName(executor?.model ?? item.executorModel)
      out[item.id] = {
        model: planner.model,
        ...(planner.thinkingLevel !== undefined ? { thinkingLevel: planner.thinkingLevel } : {}),
        ...(item.description !== undefined ? { description: item.description } : {}),
        displayGroup: 'orchestrator',
        displayLabel: item.name,
        displayDetail: `${plannerShort} → ${executorShort}`,
        preserveRef: true,
        singleTurnEligible: false,
      }
    }
    return out
  }

  const notifyOrchestratorTiersChanged = (): void => {
    for (const listener of [...orchestratorTierListeners]) {
      try {
        listener()
      } catch {
        // Ignore subscriber error during tear-down/update.
      }
    }
  }

  const refreshEmittedSnapshotAndNotify = (forceNotify = false): void => {
    const externalTiers = getExternalTiers()
    const nextExternal = serializeTiersSnapshot(externalTiers)
    const mounted = buildMountedTiersRecord(externalTiers)
    const nextEmitted = serializeTiersSnapshot(mounted)
    const externalChanged = nextExternal !== lastExternalSnapshot
    const emittedChanged = nextEmitted !== lastEmittedTiersSnapshot
    if (externalChanged) lastExternalSnapshot = nextExternal
    if (emittedChanged) lastEmittedTiersSnapshot = nextEmitted
    if (externalChanged || emittedChanged) {
      syncAllConversationDocs()
    }
    if (forceNotify || emittedChanged) {
      notifyOrchestratorTiersChanged()
    }
  }

  const reconcileExternalTierSubscriptions = (): void => {
    const externalEntries = getExternalTierEntries()
    const activeImpls = new Set(externalEntries.map((entry) => entry.impl))
    for (const [impl, unsub] of [...externalTierUnsubs.entries()]) {
      if (!activeImpls.has(impl)) {
        try {
          unsub()
        } catch {
          // Ignore unsub failure.
        }
        externalTierUnsubs.delete(impl)
      }
    }
    for (const entry of externalEntries) {
      if (externalTierUnsubs.has(entry.impl) || typeof entry.impl.onChanged !== 'function') {
        continue
      }
      const unsub = entry.impl.onChanged(() => {
        if (!stopping) {
          refreshEmittedSnapshotAndNotify(false)
        }
      })
      externalTierUnsubs.set(entry.impl, typeof unsub === 'function' ? unsub : () => {})
    }
  }

  const syncStateDoc = async (): Promise<void> => {
    const sorted = Object.fromEntries(
      [...itemCache.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, item]) => [id, item]),
    )
    stateDoc.set({ items: sorted })
    await stateDoc.flush()
  }

  const buildItemView = (
    item: OrchestratorItem,
    catalog: ModelCatalog,
    externalTiers: Readonly<Record<string, ModelTierSpec>>,
  ): OrchestratorItemView => {
    const resolvedPlanner = resolveOrchestratorModelThroughExternalTiers(
      item.plannerModel,
      item.plannerThinkingLevel,
      externalTiers,
    )
    const resolvedExecutor = resolveOrchestratorModelThroughExternalTiers(
      item.executorModel,
      item.executorThinkingLevel,
      externalTiers,
    )

    let available = true
    let unavailableReason: string | undefined

    const checkEndpoint = (
      role: 'Planner' | 'Executor',
      rawRef: string,
      resolved: { model: string; thinkingLevel?: string } | undefined,
    ): void => {
      if (!available) return
      if (!resolved) {
        available = false
        unavailableReason = `${role} tier "${rawRef}" is not available`
        return
      }
      const entry = findConcreteCatalogEntry(catalog, resolved.model)
      if (entry?.disabled === true) {
        available = false
        unavailableReason = `${role} model "${resolved.model}" is disabled`
        return
      }
      if (!entry || entry.available !== true) {
        available = false
        unavailableReason = `${role} model "${resolved.model}" is unavailable`
      }
    }

    checkEndpoint('Planner', item.plannerModel, resolvedPlanner)
    checkEndpoint('Executor', item.executorModel, resolvedExecutor)

    return {
      ...item,
      ...(resolvedPlanner !== undefined
        ? {
            resolvedPlannerModel: resolvedPlanner.model,
            ...(resolvedPlanner.thinkingLevel !== undefined
              ? { resolvedPlannerThinkingLevel: resolvedPlanner.thinkingLevel }
              : {}),
          }
        : {}),
      ...(resolvedExecutor !== undefined
        ? {
            resolvedExecutorModel: resolvedExecutor.model,
            ...(resolvedExecutor.thinkingLevel !== undefined
              ? { resolvedExecutorThinkingLevel: resolvedExecutor.thinkingLevel }
              : {}),
          }
        : {}),
      available,
      ...(unavailableReason !== undefined ? { unavailableReason } : {}),
    }
  }

  const getItemForConversation = (
    conv: Pick<ConversationSummary, 'effectiveModelRef' | 'modelOverride' | 'parentConversationId' | 'ownedBy'>,
  ): OrchestratorItem | undefined => {
    if (!isOrchestratorConversationEligible(conv)) return undefined
    const ref = conv.effectiveModelRef ?? conv.modelOverride
    if (!ref) return undefined
    const tierId = parseModelTierRef(ref)
    if (tierId === undefined) return undefined
    return itemCache.get(tierId)
  }

  const resolveConfigForConversation = (
    conv: Pick<
      ConversationSummary,
      'id' | 'model' | 'thinkingLevel' | 'effectiveModelRef' | 'modelOverride' | 'parentConversationId' | 'ownedBy'
    >,
  ): { resolved?: OrchestratorResolvedConfig; missingExecutorTier?: string } => {
    const item = getItemForConversation(conv)
    if (!item) return {}
    const externalTiers = getExternalTiers()
    const override = convOverrideCache.get(conv.id)
    const runtime = runtimeCache.get(conv.id)

    const plannerFromExternal = resolveOrchestratorModelThroughExternalTiers(
      item.plannerModel,
      item.plannerThinkingLevel,
      externalTiers,
    )
    const plannerModel =
      runtime?.phase !== 'execution' && conv.model
        ? conv.model
        : plannerFromExternal?.model ?? item.plannerModel
    const plannerThinkingLevel =
      runtime?.phase !== 'execution' && conv.model
        ? conv.thinkingLevel ?? plannerFromExternal?.thinkingLevel
        : plannerFromExternal?.thinkingLevel

    const rawExecutorModel = override?.executorModel ?? item.executorModel
    const rawExecutorThinking =
      override !== undefined
        ? override.executorThinkingLevel
        : item.executorThinkingLevel
    const resolvedExecutor = resolveOrchestratorModelThroughExternalTiers(
      rawExecutorModel,
      rawExecutorThinking,
      externalTiers,
    )
    if (!resolvedExecutor) {
      return { missingExecutorTier: rawExecutorModel }
    }

    return {
      resolved: {
        orchestratorId: item.id,
        orchestratorName: item.name,
        plannerModel,
        ...(plannerThinkingLevel !== undefined ? { plannerThinkingLevel } : {}),
        executorModel: resolvedExecutor.model,
        ...(resolvedExecutor.thinkingLevel !== undefined
          ? { executorThinkingLevel: resolvedExecutor.thinkingLevel }
          : {}),
        maxExecutionSteps: override?.maxExecutionSteps ?? item.maxExecutionSteps,
        hasExecutorOverride: override !== undefined,
      },
    }
  }

  const buildSessionView = (conv: ConversationSummary): OrchestratorSessionView | null => {
    const item = getItemForConversation(conv)
    if (!item) return null
    const externalTiers = getExternalTiers()
    const override = convOverrideCache.get(conv.id)
    const runtime = runtimeCache.get(conv.id)
    const suppressed = isCoordinatorSuppressed(conv)
    const activePhase = suppressed
      ? 'planning'
      : runtime?.phase === 'execution'
        ? 'execution'
        : 'planning'

    const resolvedPlanner = resolveOrchestratorModelThroughExternalTiers(
      item.plannerModel,
      item.plannerThinkingLevel,
      externalTiers,
    )
    const rawExecutorModel = override?.executorModel ?? item.executorModel
    const rawExecutorThinking =
      override !== undefined ? override.executorThinkingLevel : item.executorThinkingLevel
    const resolvedExecutor = resolveOrchestratorModelThroughExternalTiers(
      rawExecutorModel,
      rawExecutorThinking,
      externalTiers,
    )

    const plannerModel =
      activePhase === 'planning' && conv.model
        ? conv.model
        : resolvedPlanner?.model ?? item.plannerModel
    const plannerThinkingLevel =
      activePhase === 'planning' && conv.model
        ? conv.thinkingLevel ?? resolvedPlanner?.thinkingLevel
        : resolvedPlanner?.thinkingLevel

    const executorModel = resolvedExecutor?.model ?? rawExecutorModel
    const executorThinkingLevel = resolvedExecutor?.thinkingLevel

    return {
      enabled: true,
      orchestratorId: item.id,
      orchestratorName: item.name,
      phase: activePhase,
      plannerModel,
      ...(plannerThinkingLevel !== undefined ? { plannerThinkingLevel } : {}),
      executorModel,
      ...(executorThinkingLevel !== undefined ? { executorThinkingLevel } : {}),
      maxExecutionSteps: override?.maxExecutionSteps ?? item.maxExecutionSteps,
      executionStepCount: activePhase === 'execution' ? runtime?.executionStepCount ?? 0 : 0,
      stepLimitPaused: activePhase === 'execution' && runtime?.stepLimitPaused === true,
      hasExecutorOverride: override !== undefined,
      ...(suppressed ? { suppressedByCoordinator: true } : {}),
    }
  }

  const syncSessionDocForConversation = (conv: ConversationSummary): void => {
    const item = getItemForConversation(conv)
    if (item !== undefined) {
      activeItemByConvId.set(conv.id, item.id)
    } else {
      activeItemByConvId.delete(conv.id)
    }
    orchestratorDoc.set(conv.id, buildSessionView(conv))
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
      orchestratorDoc.set(conversationId, null)
    }
    return latestConv
  }

  const assertModelRefNotDisabled = (
    catalog: ModelCatalog,
    externalTiers: Readonly<Record<string, ModelTierSpec>>,
    modelRef: string,
    roleLabel: string,
    options?: { requireExternalTierPresent?: boolean },
  ): void => {
    const tierId = parseModelTierRef(modelRef)
    const resolved = resolveOrchestratorModelThroughExternalTiers(modelRef, undefined, externalTiers)
    if (tierId !== undefined && resolved === undefined) {
      if (options?.requireExternalTierPresent) {
        throw new HelmxError(
          'validation_error',
          `${roleLabel} tier "${modelRef}" is not mounted by any model-tiers provider`,
          400,
          { model: modelRef },
        )
      }
      return
    }
    const targetConcrete = resolved?.model ?? modelRef
    const entry = findConcreteCatalogEntry(catalog, targetConcrete)
    if (entry?.disabled === true) {
      throw new HelmxError(
        'model_disabled',
        `${roleLabel} model '${targetConcrete}' is disabled; re-enable it before binding Orchestrator to it`,
        409,
        { model: modelRef, resolvedModel: targetConcrete },
      )
    }
  }

  const resolveExecutorFromConversationTree = (
    startConversationId: number | undefined,
  ): { model: string; thinkingLevel?: string } | undefined => {
    const visited = new Set<number>()
    let cursor = startConversationId
    let hops = 0
    while (cursor !== undefined && !visited.has(cursor) && hops < MAX_ANCESTOR_HOPS) {
      visited.add(cursor)
      hops += 1
      const conv = getConversationOrUndefined(ctx.host, cursor)
      if (!conv) break
      if (isOrchestratorConversationEligible(conv)) {
        const { resolved } = resolveConfigForConversation(conv)
        if (resolved !== undefined) {
          return {
            model: resolved.executorModel,
            ...(resolved.executorThinkingLevel !== undefined
              ? { thinkingLevel: resolved.executorThinkingLevel }
              : {}),
          }
        }
        return undefined
      }
      cursor = conv.parentConversationId
    }
    return undefined
  }

  const syncAllConversationDocs = (): void => {
    const seen = new Set<number>()
    try {
      const list = ctx.host.listConversations({ topLevelOnly: true, ownedBy: 'human' })
      for (const conv of list) {
        seen.add(conv.id)
        const item = getItemForConversation(conv)
        if (
          item !== undefined ||
          convOverrideCache.has(conv.id) ||
          runtimeCache.has(conv.id) ||
          orchestratorDoc.get(conv.id) !== null
        ) {
          syncSessionDocForConversation(conv)
        }
      }
    } catch {
      // Ignore if host conversation listing is unavailable during early startup/shutdown.
    }
    for (const convId of new Set<number>([
      ...activeItemByConvId.keys(),
      ...convOverrideCache.keys(),
      ...runtimeCache.keys(),
    ])) {
      if (seen.has(convId)) continue
      const conv = getConversationOrUndefined(ctx.host, convId)
      if (conv !== undefined) {
        syncSessionDocForConversation(conv)
      } else {
        activeItemByConvId.delete(convId)
        orchestratorDoc.set(convId, null)
      }
    }
  }

  const refreshProfileModelsCache = async (): Promise<void> => {
    try {
      const profiles = await ctx.host.profiles.list()
      const next = new Map<string, string | undefined>()
      for (const p of profiles) {
        next.set(p.id, p.model)
      }
      profileModelsCache = next
    } catch {
      // Non-fatal during partial shutdown.
    }
  }

  const isPlanModeActive = (conversationId: number): boolean => {
    for (const cap of ctx.consume<PlanModeActiveCapability>(PLAN_MODE_ACTIVE_CAPABILITY_ID)) {
      try {
        if (cap.impl.isPlanning(conversationId)) return true
      } catch {
        // Ignore fault in external capability provider.
      }
    }
    return false
  }

  const collectExtraPlanningTools = (): Set<string> => {
    const names = new Set<string>()
    for (const capId of [PLANNING_ORCHESTRATION_TOOLS_CAPABILITY_ID, DISPATCH_TOOLS_CAPABILITY_ID] as const) {
      for (const cap of ctx.consume<PlanningOrchestrationToolsCapability>(capId)) {
        for (const name of cap.impl.toolNames) {
          names.add(name)
        }
      }
    }
    return names
  }

  const findItemReferences = async (
    targetIds?: ReadonlySet<string>,
  ): Promise<PluginInUseItem[]> => {
    const idsToCheck = targetIds ?? new Set(itemCache.keys())
    if (idsToCheck.size === 0) return []
    const [catalog, profiles] = await Promise.all([
      ctx.host.listModels(),
      ctx.host.profiles.list(),
    ])
    const refs: PluginInUseItem[] = []
    const checkGlobal = (modelRef: string | undefined, kind: string, fieldName: string): void => {
      const tid = modelRef !== undefined ? parseModelTierRef(modelRef) : undefined
      if (tid !== undefined && idsToCheck.has(tid)) {
        refs.push({
          kind,
          id: `tier/${tid}`,
          label: `Global ${fieldName} references tier/${tid}`,
        })
      }
    }
    checkGlobal(catalog.defaultModel, 'model_default', 'defaultModel')
    checkGlobal(catalog.defaultCompactionModel, 'compaction_model', 'defaultCompactionModel')
    for (const p of profiles) {
      const tid = p.model !== undefined ? parseModelTierRef(p.model) : undefined
      if (tid !== undefined && idsToCheck.has(tid)) {
        refs.push({
          kind: 'profile',
          id: p.id,
          label: `Profile "${p.name}" (${p.id}) uses tier/${tid}`,
        })
      }
    }
    try {
      const convs = ctx.host.listConversations({ topLevelOnly: true, ownedBy: 'human' })
      for (const conv of convs) {
        const overrideTid = conv.modelOverride ? parseModelTierRef(conv.modelOverride) : undefined
        const effectiveTid = conv.effectiveModelRef ? parseModelTierRef(conv.effectiveModelRef) : undefined
        const tid = overrideTid ?? effectiveTid
        if (tid !== undefined && idsToCheck.has(tid)) {
          refs.push({
            kind: 'conversation',
            id: String(conv.id),
            label: `Conversation #${conv.id} (${conv.title || 'untitled'}) uses tier/${tid}`,
          })
        }
      }
    } catch {
      // Ignore if host conversation index is unavailable.
    }
    return refs
  }

  const clearOverridesAndRuntimeForItem = async (orchestratorId: string): Promise<void> => {
    const affectedConvIds = new Set<number>()
    for (const [convId, trackedId] of activeItemByConvId.entries()) {
      if (trackedId === orchestratorId) affectedConvIds.add(convId)
    }
    for (const convId of convOverrideCache.keys()) {
      const conv = getConversationOrUndefined(ctx.host, convId)
      const ref = conv?.effectiveModelRef ?? conv?.modelOverride
      const tid = ref ? parseModelTierRef(ref) : undefined
      if (tid === orchestratorId || tid === undefined) affectedConvIds.add(convId)
    }
    for (const [convId, rt] of runtimeCache.entries()) {
      if (rt.orchestratorId === orchestratorId) affectedConvIds.add(convId)
    }
    for (const convId of affectedConvIds) {
      await queue.enqueue(convId, async () => {
        if (convOverrideCache.delete(convId)) {
          convOverridesKv.delete(String(convId))
          await convOverridesKv.flush()
        }
        if (runtimeCache.has(convId)) {
          await restoreToPlanning(convId, false)
        }
        activeItemByConvId.delete(convId)
        orchestratorDoc.set(convId, null)
      })
    }
  }

  const modelTiersCapability: ModelTiersCapability = {
    getTiers() {
      return buildMountedTiersRecord(getExternalTiers())
    },
    onChanged(listener) {
      orchestratorTierListeners.add(listener)
      return () => {
        orchestratorTierListeners.delete(listener)
      }
    },
  }

  return {
    modelTiersCapability,

    async start() {
      stopping = false

      const nextItems = new Map<string, OrchestratorItem>()
      for (const entry of listAllKvEntries(itemsKv)) {
        if (entry.value && typeof entry.value.id === 'string') {
          nextItems.set(entry.key, entry.value)
        }
      }
      itemCache = nextItems

      const nextOverrides = new Map<number, OrchestratorConversationOverrideRecord>()
      for (const entry of listAllKvEntries(convOverridesKv)) {
        const convId = Number(entry.key)
        if (Number.isSafeInteger(convId) && convId > 0 && entry.value?.executorModel) {
          nextOverrides.set(convId, entry.value)
        }
      }
      convOverrideCache = nextOverrides

      const nextStates = new Map<number, OrchestratorRuntimeRecord>()
      for (const entry of listAllKvEntries(statesKv)) {
        const convId = Number(entry.key)
        if (Number.isSafeInteger(convId) && convId > 0 && entry.value) {
          nextStates.set(convId, entry.value)
        }
      }
      runtimeCache = nextStates

      await refreshProfileModelsCache()
      await syncStateDoc()

      externalCapabilityUnsub = ctx.onCapabilityChanged('helmx.model-tiers', () => {
        if (stopping) return
        reconcileExternalTierSubscriptions()
        refreshEmittedSnapshotAndNotify(false)
      })
      reconcileExternalTierSubscriptions()
      lastExternalSnapshot = serializeTiersSnapshot(getExternalTiers())
      lastEmittedTiersSnapshot = serializeTiersSnapshot(buildMountedTiersRecord(getExternalTiers()))

      if (itemCache.size > 0) {
        notifyOrchestratorTiersChanged()
      }
      syncAllConversationDocs()
    },

    async reconcile() {
      if (stopping) return
      await refreshProfileModelsCache()
      reconcileExternalTierSubscriptions()
      refreshEmittedSnapshotAndNotify(false)

      for (const [convId] of [...runtimeCache.entries()]) {
        await queue.enqueue(convId, async () => {
          if (stopping) return
          const conv = getConversationOrUndefined(ctx.host, convId)
          if (conv === undefined) {
            await clearRuntimeRecord(convId)
            orchestratorDoc.set(convId, null)
            return
          }
          const isBusy = conv.status === 'working' || conv.status === 'blocked'
          if (!isBusy) {
            await restoreToPlanning(convId, true)
          }
        })
      }

      // Drop orphaned per-conversation overrides whose conversation deleted or left Orchestrator.
      let removedOverride = false
      for (const convId of [...convOverrideCache.keys()]) {
        const conv = getConversationOrUndefined(ctx.host, convId)
        if (conv === undefined || getItemForConversation(conv) === undefined) {
          convOverrideCache.delete(convId)
          convOverridesKv.delete(String(convId))
          removedOverride = true
        }
      }
      if (removedOverride) {
        await convOverridesKv.flush()
      }

      syncAllConversationDocs()
    },

    async stop() {
      stopping = true
      if (externalCapabilityUnsub !== undefined) {
        try {
          externalCapabilityUnsub()
        } catch {
          // Ignore unsub failure.
        }
        externalCapabilityUnsub = undefined
      }
      for (const unsub of externalTierUnsubs.values()) {
        try {
          unsub()
        } catch {
          // Ignore unsub failure.
        }
      }
      externalTierUnsubs.clear()
      await queue.drain()
      for (const [convId] of [...runtimeCache.entries()]) {
        await queue.enqueue(convId, async () => {
          const runtime = runtimeCache.get(convId)
          let keepStateForReconcile = false
          if (runtime?.activeRuntimeOverride === true || runtime?.planChosenModelActive === true) {
            try {
              await ignoreConversationNotFound(() => ctx.host.setConversationRuntimeModel(convId, null))
            } catch (err) {
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
          orchestratorDoc.set(convId, null)
        })
      }
      for (const convId of [...activeItemByConvId.keys()]) {
        orchestratorDoc.set(convId, null)
      }
      activeItemByConvId.clear()
    },

    async inUseItems() {
      return findItemReferences()
    },

    async listItems() {
      const catalog = await ctx.host.listModels()
      const externalTiers = getExternalTiers()
      return [...itemCache.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((item) => buildItemView(item, catalog, externalTiers))
    },

    async getItem(rawId) {
      const id = assertOrchestratorId(rawId)
      const item = itemCache.get(id)
      if (!item) {
        throw new HelmxError('orchestrator_not_found', `Orchestrator '${id}' does not exist`, 404, { id })
      }
      const catalog = await ctx.host.listModels()
      return buildItemView(item, catalog, getExternalTiers())
    },

    async setItem(input) {
      const id = assertOrchestratorId(input.id)
      if (!itemCache.has(id) && itemCache.size >= MAX_ORCHESTRATORS_COUNT) {
        throw new HelmxError(
          'validation_error',
          `Maximum number of Orchestrators (${MAX_ORCHESTRATORS_COUNT}) reached`,
          400,
          { count: itemCache.size },
        )
      }
      const conflictingPlugin = findExternalTierConflict(id)
      if (conflictingPlugin !== undefined) {
        throw new HelmxError(
          'model_tier_conflict',
          `Model tier id '${id}' conflicts with provider ${conflictingPlugin}`,
          409,
          { id, conflictingPluginId: conflictingPlugin },
        )
      }

      const name = normalizeOrchestratorName(input.name)
      const description = normalizeOrchestratorDescription(input.description)
      const plannerModel = normalizeOrchestratorModelRef(input.plannerModel, 'plannerModel')
      const executorModel = normalizeOrchestratorModelRef(input.executorModel, 'executorModel')

      for (const [roleField, ref] of [
        ['plannerModel', plannerModel],
        ['executorModel', executorModel],
      ] as const) {
        const tierId = parseModelTierRef(ref)
        if (tierId !== undefined && (tierId === id || itemCache.has(tierId))) {
          throw new HelmxError(
            'validation_error',
            `${roleField} cannot reference Orchestrator "tier/${tierId}"`,
            400,
            { field: roleField, model: ref },
          )
        }
      }

      const plannerThinkingLevel = normalizeOrchestratorThinkingLevel(
        input.plannerThinkingLevel,
        'plannerThinkingLevel',
      )
      const executorThinkingLevel = normalizeOrchestratorThinkingLevel(
        input.executorThinkingLevel,
        'executorThinkingLevel',
      )
      const maxExecutionSteps = normalizeMaxExecutionSteps(
        input.maxExecutionSteps,
        ORCHESTRATOR_DEFAULT_MAX_STEPS,
      )

      const catalog = await ctx.host.listModels()
      const externalTiers = getExternalTiers()
      assertModelRefNotDisabled(catalog, externalTiers, plannerModel, 'Planner')
      assertModelRefNotDisabled(catalog, externalTiers, executorModel, 'Executor')

      const next: OrchestratorItem = {
        id,
        name,
        ...(description !== undefined ? { description } : {}),
        plannerModel,
        ...(plannerThinkingLevel !== undefined ? { plannerThinkingLevel } : {}),
        executorModel,
        ...(executorThinkingLevel !== undefined ? { executorThinkingLevel } : {}),
        maxExecutionSteps,
        updatedAt: Date.now(),
      }

      itemCache.set(id, next)
      itemsKv.set(id, next)
      await itemsKv.flush()
      await syncStateDoc()
      refreshEmittedSnapshotAndNotify(true)
      syncAllConversationDocs()
      return buildItemView(next, catalog, getExternalTiers())
    },

    async removeItem(input) {
      const id = assertOrchestratorId(input.id)
      if (!itemCache.has(id)) {
        return { removed: false }
      }
      const refs = await findItemReferences(new Set([id]))
      if (refs.length > 0 && input.force !== true) {
        throw new HelmxError(
          'model_tier_in_use',
          `Orchestrator 'tier/${id}' is in use by ${refs.map((r) => r.label).join('; ')} (pass force: true to remove anyway)`,
          409,
          { id, references: refs },
        )
      }

      itemCache.delete(id)
      itemsKv.delete(id)
      await itemsKv.flush()
      await syncStateDoc()
      await clearOverridesAndRuntimeForItem(id)
      refreshEmittedSnapshotAndNotify(true)
      syncAllConversationDocs()
      return { removed: true }
    },

    getStatus(conversationId) {
      const conv = getConversationOrUndefined(ctx.host, conversationId)
      if (conv === undefined) {
        throw new HelmxError('conversation_not_found', `Conversation ${conversationId} not found`, 404)
      }
      return buildSessionView(conv)
    },

    async overrideExecutor(input) {
      const conv = getConversationOrUndefined(ctx.host, input.conversationId)
      if (conv === undefined) {
        throw new HelmxError('conversation_not_found', `Conversation ${input.conversationId} not found`, 404)
      }
      if (!isOrchestratorConversationEligible(conv)) {
        throw new HelmxError(
          'validation_error',
          'Orchestrator executor overrides are only available on top-level human-owned conversations',
          400,
        )
      }
      const item = getItemForConversation(conv)
      if (!item) {
        throw new HelmxError(
          'validation_error',
          'Conversation must select an Orchestrator (tier/<id>) before overriding its Executor',
          400,
        )
      }

      const executorModel = normalizeOrchestratorModelRef(input.executorModel, 'executorModel')
      const tierId = parseModelTierRef(executorModel)
      if (tierId !== undefined && itemCache.has(tierId)) {
        throw new HelmxError(
          'validation_error',
          `executorModel cannot reference Orchestrator "tier/${tierId}"`,
          400,
        )
      }
      const externalTiers = getExternalTiers()
      const catalog = await ctx.host.listModels()
      assertModelRefNotDisabled(catalog, externalTiers, executorModel, 'Executor', {
        requireExternalTierPresent: true,
      })

      const executorThinkingLevel = normalizeOrchestratorThinkingLevel(
        input.executorThinkingLevel,
        'executorThinkingLevel',
      )
      const existing = convOverrideCache.get(conv.id)
      const maxExecutionSteps =
        input.maxExecutionSteps !== undefined
          ? normalizeMaxExecutionSteps(input.maxExecutionSteps)
          : existing?.maxExecutionSteps

      return queue.enqueue(conv.id, async () => {
        const next: OrchestratorConversationOverrideRecord = {
          conversationId: conv.id,
          executorModel,
          ...(executorThinkingLevel !== undefined ? { executorThinkingLevel } : {}),
          ...(maxExecutionSteps !== undefined ? { maxExecutionSteps } : {}),
          updatedAt: Date.now(),
        }
        convOverrideCache.set(conv.id, next)
        convOverridesKv.set(String(conv.id), next)
        await convOverridesKv.flush()
        const latestConv = getConversationOrUndefined(ctx.host, conv.id) ?? conv
        syncSessionDocForConversation(latestConv)
        return buildSessionView(latestConv)!
      })
    },

    async clearOverride(conversationId) {
      const conv = getConversationOrUndefined(ctx.host, conversationId)
      if (conv === undefined) {
        throw new HelmxError('conversation_not_found', `Conversation ${conversationId} not found`, 404)
      }
      return queue.enqueue(conv.id, async () => {
        if (convOverrideCache.delete(conv.id)) {
          convOverridesKv.delete(String(conv.id))
          await convOverridesKv.flush()
        }
        const latestConv = getConversationOrUndefined(ctx.host, conv.id) ?? conv
        syncSessionDocForConversation(latestConv)
        return buildSessionView(latestConv)
      })
    },

    searchItems(input, signal) {
      if (signal.aborted) return []
      const externalTiers = getExternalTiers()
      interface SearchCandidate {
        item: OrchestratorItem
        description?: string
        plannerResolved?: string
        executorResolved?: string
        available: boolean
      }
      const candidates: SearchCandidate[] = []
      for (const item of itemCache.values()) {
        if (signal.aborted) return []
        const description =
          item.description !== undefined ? compactOneLine(ctx.host.redact(item.description)) : undefined
        const resolvedPlanner = resolveOrchestratorModelThroughExternalTiers(
          item.plannerModel,
          item.plannerThinkingLevel,
          externalTiers,
        )
        const resolvedExecutor = resolveOrchestratorModelThroughExternalTiers(
          item.executorModel,
          item.executorThinkingLevel,
          externalTiers,
        )
        candidates.push({
          item,
          description,
          plannerResolved: resolvedPlanner?.model,
          executorResolved: resolvedExecutor?.model,
          available: resolvedPlanner !== undefined && resolvedExecutor !== undefined,
        })
      }

      return rankSearchCandidates<SearchCandidate, PluginSearchItem>({
        query: input.query,
        limit: input.limit,
        signal,
        items: candidates,
        fields: (entry) => ({
          primary: [entry.item.name, `tier/${entry.item.id}`, entry.item.id],
          secondary: [
            entry.description,
            entry.item.plannerModel,
            entry.item.executorModel,
            entry.plannerResolved,
            entry.executorResolved,
          ],
          keywords: ['orchestrator', '编排器', 'planner', 'executor', 'dual-phase', 'pair', '双相', '协同'],
        }),
        tieBreaker: (entry) => entry.item.id,
        toResult: (entry, score) => {
          const plannerShort = formatOrchestratorModelShortName(entry.plannerResolved ?? entry.item.plannerModel)
          const executorShort = formatOrchestratorModelShortName(entry.executorResolved ?? entry.item.executorModel)
          const pairSummary = `tier/${entry.item.id} · ${plannerShort} → ${executorShort}`
          const subtitle =
            entry.description !== undefined
              ? compactOneLine(`${pairSummary} · ${entry.description}`)
              : pairSummary
          return {
            id: `orchestrator:${entry.item.id}`,
            kind: 'resource',
            title: entry.item.name,
            subtitle,
            breadcrumb: [{ en: 'Orchestrator', 'zh-CN': '编排器' }],
            icon: 'git-pull-request',
            ...(!entry.available ? { badge: { en: 'Unavailable', 'zh-CN': '不可用' } } : {}),
            target: `screen:${ORCHESTRATOR_PLUGIN_ID}/${ORCHESTRATOR_SCREEN_ID}?edit=${encodeURIComponent(entry.item.id)}`,
            score,
          }
        },
      })
    },

    resolveDefaultChildModel(parentConversationId) {
      return resolveExecutorFromConversationTree(parentConversationId)
    },

    async handleInput(payload) {
      if (stopping) return { action: 'continue' }
      const conv = getConversationOrUndefined(ctx.host, payload.conversationId)
      if (conv === undefined || !isOrchestratorConversationEligible(conv)) {
        return { action: 'continue' }
      }
      if (!runtimeCache.has(conv.id)) {
        return { action: 'continue' }
      }

      return queue.enqueue(conv.id, async () => {
        const latestConv = getConversationOrUndefined(ctx.host, conv.id) ?? conv
        const runtime = runtimeCache.get(conv.id)
        if (runtime !== undefined) {
          const isBusy = latestConv.status === 'working' || latestConv.status === 'blocked'
          const isSteer = isBusy && (payload.input.whenBusy ?? 'steer') === 'steer'
          if (isSteer && runtime.phase === 'execution') {
            const updated: OrchestratorRuntimeRecord = { ...runtime, turnHadSteer: true, updatedAt: Date.now() }
            runtimeCache.set(conv.id, updated)
            statesKv.set(String(conv.id), updated)
            await statesKv.flush()
          } else if (!isBusy) {
            await restoreToPlanning(conv.id, true)
          }
        }
        return { action: 'continue' }
      })
    },

    async handleBeforeTurn(turn) {
      if (stopping) return { action: 'continue' }
      const conv = getConversationOrUndefined(ctx.host, turn.conversation.id)
      const stripOrchestratorArtifacts = (): HookResult<BeforeTurnHookPayload> => {
        const hasOrchTool = turn.tools.some((t) => ORCHESTRATOR_ONLY_TOOL_NAMES.has(t.name))
        const hasOrchSection = turn.sections.some(
          (s) =>
            s.id === ORCHESTRATOR_PLAN_SECTION_ID ||
            s.id === ORCHESTRATOR_EXECUTE_SECTION_ID ||
            s.id === ORCHESTRATOR_STEP_LIMIT_SECTION_ID,
        )
        if (!hasOrchTool && !hasOrchSection) return { action: 'continue' }
        return {
          action: 'transform',
          value: {
            ...turn,
            tools: turn.tools.filter((t) => !ORCHESTRATOR_ONLY_TOOL_NAMES.has(t.name)),
            sections: turn.sections.filter(
              (s) =>
                s.id !== ORCHESTRATOR_PLAN_SECTION_ID &&
                s.id !== ORCHESTRATOR_EXECUTE_SECTION_ID &&
                s.id !== ORCHESTRATOR_STEP_LIMIT_SECTION_ID,
            ),
          },
        }
      }

      if (conv === undefined || !isOrchestratorConversationEligible(conv)) {
        return stripOrchestratorArtifacts()
      }

      const { resolved } = resolveConfigForConversation(conv)
      if (resolved === undefined) {
        if (runtimeCache.has(conv.id)) {
          await queue.enqueue(conv.id, () => restoreToPlanning(conv.id, true))
        }
        return stripOrchestratorArtifacts()
      }

      if (isPlanModeActive(conv.id)) {
        if (runtimeCache.has(conv.id)) {
          await queue.enqueue(conv.id, () => restoreToPlanning(conv.id, true))
        } else {
          syncSessionDocForConversation(conv)
        }
        return stripOrchestratorArtifacts()
      }

      if (isCoordinatorSuppressed(conv)) {
        if (runtimeCache.has(conv.id)) {
          await queue.enqueue(conv.id, () => restoreToPlanning(conv.id, true))
        } else {
          syncSessionDocForConversation(conv)
        }
        return stripOrchestratorArtifacts()
      }

      const runtime = runtimeCache.get(conv.id)
      const phase = runtime?.phase === 'execution' ? 'execution' : 'planning'

      if (phase === 'planning') {
        const extraAllowed = collectExtraPlanningTools()
        const tools = turn.tools.filter(
          (t) =>
            t.name !== ORCHESTRATOR_HAND_BACK_TOOL &&
            (ORCHESTRATOR_PLAN_BASE_TOOL_WHITELIST.has(t.name) || extraAllowed.has(t.name)),
        )
        const sections = [
          ...turn.sections.filter(
            (s) =>
              s.id !== ORCHESTRATOR_PLAN_SECTION_ID &&
              s.id !== ORCHESTRATOR_EXECUTE_SECTION_ID &&
              s.id !== ORCHESTRATOR_STEP_LIMIT_SECTION_ID,
          ),
          { id: ORCHESTRATOR_PLAN_SECTION_ID, text: buildOrchestratorPlanningSection(resolved) },
        ]
        syncSessionDocForConversation(conv)
        return { action: 'transform', value: { ...turn, tools, sections } }
      }

      const activeRuntime = runtime!
      const maxSteps = activeRuntime.maxExecutionSteps
      const currentSteps = activeRuntime.executionStepCount
      if (maxSteps > 0 && currentSteps >= maxSteps) {
        const pausedRecord: OrchestratorRuntimeRecord = {
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
            (s) =>
              s.id !== ORCHESTRATOR_PLAN_SECTION_ID &&
              s.id !== ORCHESTRATOR_EXECUTE_SECTION_ID &&
              s.id !== ORCHESTRATOR_STEP_LIMIT_SECTION_ID,
          ),
          { id: ORCHESTRATOR_STEP_LIMIT_SECTION_ID, text: buildStepLimitSection(pausedRecord) },
        ]
        return { action: 'transform', value: { ...turn, tools, sections } }
      }

      const nextRecord: OrchestratorRuntimeRecord = {
        ...activeRuntime,
        executionStepCount: currentSteps + 1,
        stepLimitPaused: false,
        updatedAt: Date.now(),
      }
      runtimeCache.set(conv.id, nextRecord)
      statesKv.set(String(conv.id), nextRecord)
      await statesKv.flush()
      syncSessionDocForConversation(conv)

      const tools = turn.tools.filter((t) => t.name !== ORCHESTRATOR_EXIT_PLAN_MODE_TOOL)
      const sections = [
        ...turn.sections.filter(
          (s) =>
            s.id !== ORCHESTRATOR_PLAN_SECTION_ID &&
            s.id !== ORCHESTRATOR_EXECUTE_SECTION_ID &&
            s.id !== ORCHESTRATOR_STEP_LIMIT_SECTION_ID,
        ),
        { id: ORCHESTRATOR_EXECUTE_SECTION_ID, text: buildOrchestratorExecutionSection(nextRecord) },
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
        const profileModel = profileModelsCache.get(request.agentType.trim())
        const profileItemId = profileModel !== undefined ? parseModelTierRef(profileModel) : undefined
        const item = profileItemId !== undefined ? itemCache.get(profileItemId) : undefined
        if (item !== undefined) {
          resolvedTarget = resolveOrchestratorModelThroughExternalTiers(
            item.executorModel,
            item.executorThinkingLevel,
            getExternalTiers(),
          )
        }
      }
      if (resolvedTarget === undefined) {
        resolvedTarget = resolveExecutorFromConversationTree(request.parentConversationId)
      }
      if (resolvedTarget === undefined) return { action: 'continue' }

      const nextThinking =
        request.effort !== undefined && request.effort.trim() !== ''
          ? request.effort
          : resolvedTarget.thinkingLevel

      return {
        action: 'transform',
        value: {
          ...request,
          model: resolvedTarget.model,
          ...(nextThinking !== undefined ? { effort: nextThinking } : {}),
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
        if (conv === undefined || !isOrchestratorConversationEligible(conv) || isCoordinatorSuppressed(conv)) {
          return
        }
        const { resolved } = resolveConfigForConversation(conv)
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

        const nextRecord: OrchestratorRuntimeRecord = {
          conversationId: conv.id,
          orchestratorId: resolved.orchestratorId,
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

      const item = getItemForConversation(conv)
      const prevItemId = activeItemByConvId.get(conv.id)

      // Clean up temporary overrides / execution runtime when switching away from or changing Orchestrator.
      if (
        (item === undefined && (convOverrideCache.has(conv.id) || runtimeCache.has(conv.id))) ||
        (item !== undefined && prevItemId !== undefined && prevItemId !== item.id) ||
        (isCoordinatorSuppressed(conv) && runtimeCache.has(conv.id))
      ) {
        await queue.enqueue(conv.id, async () => {
          const latestConv = getConversationOrUndefined(ctx.host, conv.id) ?? conv
          const latestItem = getItemForConversation(latestConv)
          const switchedAwayOrChanged =
            latestItem === undefined || (prevItemId !== undefined && prevItemId !== latestItem.id)
          if (switchedAwayOrChanged && convOverrideCache.delete(conv.id)) {
            convOverridesKv.delete(String(conv.id))
            await convOverridesKv.flush()
          }
          if (switchedAwayOrChanged || isCoordinatorSuppressed(latestConv)) {
            await restoreToPlanning(conv.id, true)
            return
          }
          syncSessionDocForConversation(latestConv)
        })
        return
      }

      if (
        item !== undefined ||
        prevItemId !== undefined ||
        convOverrideCache.has(conv.id) ||
        runtimeCache.has(conv.id) ||
        orchestratorDoc.get(conv.id) !== null
      ) {
        syncSessionDocForConversation(conv)
      }
    },

    async handleConversationDeleted(conversationId) {
      if (stopping) return
      activeItemByConvId.delete(conversationId)
      if (!convOverrideCache.has(conversationId) && !runtimeCache.has(conversationId)) return
      await queue.enqueue(conversationId, async () => {
        if (stopping) return
        if (convOverrideCache.delete(conversationId)) {
          convOverridesKv.delete(String(conversationId))
          await convOverridesKv.flush()
        }
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

    handleProfileChanged(payload) {
      const event = payload as { profile?: Profile; removed?: boolean } | undefined
      const profile = event?.profile
      if (!profile || typeof profile.id !== 'string' || !profile.id) return
      if (event?.removed === true) {
        profileModelsCache.delete(profile.id)
      } else {
        profileModelsCache.set(profile.id, profile.model)
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
        if (!isOrchestratorConversationEligible(conv)) {
          return toolError('exit_plan_mode is only available in top-level human-owned conversations.')
        }
        if (isPlanModeActive(conv.id)) {
          return toolError('exit_plan_mode is unavailable while read-only /plan mode is active.')
        }
        if (isCoordinatorSuppressed(conv)) {
          return toolError('exit_plan_mode is disabled while coordinating an active Swarm group.')
        }
        const { resolved, missingExecutorTier } = resolveConfigForConversation(conv)
        if (missingExecutorTier !== undefined) {
          return toolError(
            `Failed to switch to executor tier "${missingExecutorTier}": tier is not available. Staying in planning phase.`,
          )
        }
        if (resolved === undefined) {
          return toolError('exit_plan_mode requires an Orchestrator (tier/<id>) on this conversation or Profile.')
        }
        const current = runtimeCache.get(conv.id)
        if (current?.phase === 'execution') {
          return toolError('Conversation is already in execution phase.')
        }

        const fromModel = conv.model || conv.modelOverride || resolved.plannerModel
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

        const nextRecord: OrchestratorRuntimeRecord = {
          conversationId: conv.id,
          orchestratorId: resolved.orchestratorId,
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
        const meta: OrchestratorTransitionMeta = {
          tool: ORCHESTRATOR_EXIT_PLAN_MODE_TOOL,
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
        if (!isOrchestratorConversationEligible(conv)) {
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
        const meta: OrchestratorTransitionMeta = {
          tool: ORCHESTRATOR_HAND_BACK_TOOL,
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
