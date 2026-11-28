/**
 * Built-in `builtin:duo` plugin — Dual-Phase Orchestrator mounted as first-class model tiers (`tier/<id>`).
 */
import {
  COMPOSER_STATUS_SLOT,
  HELMX_SEARCH_CAPABILITY_ID,
  HelmxError,
  MODEL_TIER_DESCRIPTION_MAX_LENGTH,
  type ModelTiersCapability,
  type PluginDefinition,
  type PluginSearchProvider,
} from '@helmx/protocol'
import { resolvePluginClientAssets } from './asset-paths.js'
import {
  DEFAULT_CHILD_MODEL_CAPABILITY_ID,
  PLAN_APPROVED_EVENT,
  type DefaultChildModelCapability,
} from './contracts.js'
import { readDuoSkillAsset } from './duo/assets.js'
import {
  DUO_CONV_OVERRIDES_KV,
  DUO_ELIGIBLE_SCOPE,
  DUO_EXIT_PLAN_MODE_TOOL,
  DUO_HAND_BACK_TOOL,
  DUO_MAX_STEPS_LIMIT,
  DUO_PLUGIN_ID,
  DUO_RECIPES_KV,
  DUO_RECIPE_NAME_MAX_LENGTH,
  DUO_RECIPE_VIEW_SCHEMA,
  DUO_SCREEN_ID,
  DUO_SESSION_DOC,
  DUO_SESSION_VIEW_SCHEMA,
  DUO_STATES_KV,
  DUO_STATE_DOC,
  DUO_TRANSITION_META_SCHEMA,
  type DuoConversationOverrideRecord,
  type DuoRecipe,
  type DuoRecipeView,
  type DuoRuntimeRecord,
  type DuoSessionView,
  type DuoStateDocSnapshot,
} from './duo/contracts.js'
import {
  createDuoManager,
  type OverrideDuoExecutorInput,
  type RemoveDuoRecipeInput,
  type SetDuoRecipeInput,
} from './duo/orchestrator.js'
import { errorMessageOf, resolveTargetConversationId } from './shared-helpers.js'

export {
  DUO_PLUGIN_ID,
  DUO_SKILL_ID,
  DUO_STATE_DOC,
  DUO_SESSION_DOC,
  DUO_SCREEN_ID,
  DUO_RECIPES_KV,
  DUO_CONV_OVERRIDES_KV,
  DUO_STATES_KV,
  DUO_EXIT_PLAN_MODE_TOOL,
  DUO_HAND_BACK_TOOL,
  DUO_PLAN_SECTION_ID,
  DUO_EXECUTE_SECTION_ID,
  DUO_STEP_LIMIT_SECTION_ID,
  DUO_DEFAULT_MAX_STEPS,
  DUO_MAX_STEPS_LIMIT,
  DUO_THINKING_LEVELS,
  DUO_RECIPE_SCHEMA,
  DUO_RECIPE_VIEW_SCHEMA,
  DUO_SESSION_VIEW_SCHEMA,
  DUO_TRANSITION_META_SCHEMA,
  type DuoPhase,
  type DuoRecipe,
  type DuoRecipeView,
  type DuoStateDocSnapshot,
  type DuoConversationOverrideRecord,
  type DuoSessionView,
  type DuoTransitionMeta,
  type DuoThinkingLevel,
} from './duo/contracts.js'

const CONVERSATION_ID_PROP = { type: 'integer', minimum: 1 } as const

export function createDuoPlugin(): PluginDefinition {
  return {
    id: DUO_PLUGIN_ID,
    name: { en: 'Orchestrator', 'zh-CN': '编排器' },
    description: {
      en: 'Pair Planner and Executor models into Orchestrator tiers (tier/<id>) that alternate top-level conversations seamlessly between read-only Planning and Execution.',
      'zh-CN': '将规划模型与执行模型配对为编排器档位（tier/<id>），让顶层会话在只读规划与工作区执行间自动切换。',
    },
    icon: 'git-pull-request',
    version: '0.2.0',
    ...resolvePluginClientAssets(DUO_PLUGIN_ID, 'duo', 'duo_plugin_client_missing'),
    definePlugin(ctx) {
      const stateDoc = ctx.doc<DuoStateDocSnapshot>(
        DUO_STATE_DOC,
        { recipes: {} },
        { public: true },
      )
      const recipesKv = ctx.kv<DuoRecipe>(DUO_RECIPES_KV)
      const convOverridesKv = ctx.kv<DuoConversationOverrideRecord>(DUO_CONV_OVERRIDES_KV)
      const statesKv = ctx.kv<DuoRuntimeRecord>(DUO_STATES_KV)
      const duoDoc = ctx.sessionDoc<DuoSessionView | null>(DUO_SESSION_DOC, null, {
        public: true,
        durable: false,
      })

      const manager = createDuoManager({
        ctx,
        stateDoc,
        recipesKv,
        convOverridesKv,
        statesKv,
        duoDoc,
      })

      ctx.service({
        id: 'duo-runtime',
        reconcileAfter: ['builtin:tiers'],
        async start() {
          await ctx.host.skills.ensureSkill(readDuoSkillAsset())
          await manager.start()
        },
        async reconcile() {
          await manager.reconcile()
        },
        async stop() {
          await manager.stop()
        },
        inUse() {
          return manager.inUseItems()
        },
      })

      ctx.provide<ModelTiersCapability>('helmx.model-tiers', manager.modelTiersCapability)

      ctx.provide<DefaultChildModelCapability>(DEFAULT_CHILD_MODEL_CAPABILITY_ID, {
        resolveDefaultChildModel(parentConversationId) {
          return manager.resolveDefaultChildModel(parentConversationId)
        },
      })

      ctx.provide<PluginSearchProvider>(HELMX_SEARCH_CAPABILITY_ID, {
        search(input, signal) {
          return manager.searchRecipes(input, signal)
        },
      })

      ctx.hook.onInput(async (payload) => manager.handleInput(payload), { priority: 100 })
      ctx.hook.onBeforeTurn(async (turn) => manager.handleBeforeTurn(turn), { priority: -60 })
      // Synchronous transform after workflow (300) and worktree (200) so builtin:duo never holds liveTasks open.
      ctx.hook.onAgentSpawn((request) => manager.handleAgentSpawn(request), { priority: 100 })
      ctx.hook.onTurnSettled(async ({ conversation }) => {
        await manager.handleTurnSettled(conversation.id)
      })

      ctx.host.onEvent(PLAN_APPROVED_EVENT, async (payload) => {
        await manager.handlePlanApproved(payload)
      })
      ctx.host.onEvent('conversation.upsert', async (payload) => {
        await manager.handleConversationUpsert(payload)
      })
      ctx.host.onEvent('conversation.deleted', async (payload) => {
        const event = payload as { type?: unknown; conversationId?: unknown } | undefined
        if (event?.type === 'conversation.deleted' && typeof event.conversationId === 'number') {
          await manager.handleConversationDeleted(event.conversationId)
        }
      })
      ctx.host.onEvent('pi.reset', async (payload) => {
        const event = payload as { type?: unknown; conversationId?: unknown } | undefined
        if (event?.type === 'pi.reset' && typeof event.conversationId === 'number') {
          await manager.handleConversationReset(event.conversationId)
        }
      })
      ctx.host.onEvent('profile.changed', (payload) => {
        manager.handleProfileChanged(payload)
      })

      ctx.tool<{ plan: string }>({
        name: DUO_EXIT_PLAN_MODE_TOOL,
        scope: DUO_ELIGIBLE_SCOPE,
        description:
          'Finalize your read-only Planning Phase plan and transition the conversation in place to the configured Duo Executor model to execute the plan.',
        inputSchema: {
          type: 'object',
          required: ['plan'],
          additionalProperties: false,
          properties: {
            plan: {
              type: 'string',
              minLength: 1,
              description:
                'Actionable execution plan including target files, concrete changes, verification commands, and concise Re-plan if triggers.',
            },
          },
        },
        presentationMetaSchema: DUO_TRANSITION_META_SCHEMA,
        execute: async (input, toolCtx) => manager.executeExitPlanModeTool(input, toolCtx.conversationId),
      })

      ctx.tool<{ reason: string; summary: string }>({
        name: DUO_HAND_BACK_TOOL,
        scope: DUO_ELIGIBLE_SCOPE,
        description:
          'Return control immediately from the Execution Phase to the Planner model when blocked by a flawed plan, missing user clarification, or reaching step budget.',
        inputSchema: {
          type: 'object',
          required: ['reason', 'summary'],
          additionalProperties: false,
          properties: {
            reason: {
              type: 'string',
              minLength: 1,
              description:
                'Short reason code or phrase (e.g. "flawed_plan", "missing_user_clarification", "step_budget_reached").',
            },
            summary: {
              type: 'string',
              minLength: 1,
              description:
                'Concise handoff summary: completed edits/checks, the exact blocker or Re-plan trigger hit, and open questions/next steps.',
            },
          },
        },
        presentationMetaSchema: DUO_TRANSITION_META_SCHEMA,
        execute: async (input, toolCtx) => manager.executeHandBackTool(input, toolCtx.conversationId),
      })

      ctx.action<Record<string, never>, { recipes: DuoRecipeView[] }>({
        id: 'list',
        description: 'List all configured Orchestrators and their resolved Planner/Executor availability',
        exposeToPrompt: false,
        idempotent: true,
        cli: { command: ['duo', 'list'] },
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        outputSchema: {
          type: 'object',
          required: ['recipes'],
          additionalProperties: false,
          properties: { recipes: { type: 'array', items: DUO_RECIPE_VIEW_SCHEMA } },
        },
        handler: async () => ({ recipes: await manager.listRecipes() }),
      })

      ctx.action<{ id: string }, DuoRecipeView>({
        id: 'get',
        description: 'Inspect one Orchestrator by id with resolved concrete Planner/Executor status',
        exposeToPrompt: false,
        idempotent: true,
        cli: { command: ['duo', 'get'] },
        inputSchema: {
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: { id: { type: 'string', minLength: 1 } },
        },
        outputSchema: DUO_RECIPE_VIEW_SCHEMA,
        handler: (input) => manager.getRecipe(input.id),
      })

      ctx.action<SetDuoRecipeInput, DuoRecipeView>({
        id: 'set',
        description:
          'Create or update an Orchestrator (mounted as tier/<id> with Planner and Executor models or external tier/<id> refs)',
        exposeToPrompt: false,
        cli: { command: ['duo', 'set'] },
        inputSchema: {
          type: 'object',
          required: ['id', 'name', 'plannerModel', 'executorModel'],
          additionalProperties: false,
          properties: {
            id: { type: 'string', minLength: 1 },
            name: { type: 'string', minLength: 1, maxLength: DUO_RECIPE_NAME_MAX_LENGTH },
            description: { type: 'string', maxLength: MODEL_TIER_DESCRIPTION_MAX_LENGTH },
            plannerModel: { type: 'string', minLength: 1 },
            plannerThinkingLevel: { type: 'string' },
            executorModel: { type: 'string', minLength: 1 },
            executorThinkingLevel: { type: 'string' },
            maxExecutionSteps: { type: 'integer', minimum: 0, maximum: DUO_MAX_STEPS_LIMIT },
          },
        },
        outputSchema: DUO_RECIPE_VIEW_SCHEMA,
        handler: (input) => manager.setRecipe(input),
      })

      ctx.action<RemoveDuoRecipeInput, { removed: boolean }>({
        id: 'remove',
        description:
          'Remove an Orchestrator by id (rejects with 409 model_tier_in_use if referenced unless force: true)',
        exposeToPrompt: false,
        cli: { command: ['duo', 'remove'] },
        inputSchema: {
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: {
            id: { type: 'string', minLength: 1 },
            force: { type: 'boolean' },
          },
        },
        outputSchema: {
          type: 'object',
          required: ['removed'],
          additionalProperties: false,
          properties: { removed: { type: 'boolean' } },
        },
        handler: (input) => manager.removeRecipe(input),
      })

      ctx.action<{ conversationId?: number }, DuoSessionView | null>({
        id: 'status',
        description: 'Inspect current Orchestrator state for a conversation',
        exposeToPrompt: false,
        idempotent: true,
        cli: { command: ['duo', 'status'] },
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { conversationId: CONVERSATION_ID_PROP },
        },
        outputSchema: { anyOf: [DUO_SESSION_VIEW_SCHEMA, { type: 'null' }] },
        handler: (input, context) => manager.getStatus(resolveTargetConversationId(input.conversationId, context)),
      })

      ctx.action<
        {
          conversationId?: number
          executorModel: string
          executorThinkingLevel?: string
          maxExecutionSteps?: number
        },
        DuoSessionView
      >({
        id: 'override_executor',
        description:
          'Temporarily override Executor model/thinking/maxSteps for an active Orchestrator conversation without mutating its configuration',
        exposeToPrompt: false,
        cli: { command: ['duo', 'override-executor'] },
        inputSchema: {
          type: 'object',
          required: ['executorModel'],
          additionalProperties: false,
          properties: {
            conversationId: CONVERSATION_ID_PROP,
            executorModel: { type: 'string', minLength: 1 },
            executorThinkingLevel: { type: 'string' },
            maxExecutionSteps: { type: 'integer', minimum: 0, maximum: DUO_MAX_STEPS_LIMIT },
          },
        },
        outputSchema: DUO_SESSION_VIEW_SCHEMA,
        handler: (input, context) => {
          const conversationId = resolveTargetConversationId(input.conversationId, context)
          return manager.overrideExecutor({
            conversationId,
            executorModel: input.executorModel,
            ...(input.executorThinkingLevel !== undefined
              ? { executorThinkingLevel: input.executorThinkingLevel }
              : {}),
            ...(input.maxExecutionSteps !== undefined ? { maxExecutionSteps: input.maxExecutionSteps } : {}),
          } satisfies OverrideDuoExecutorInput)
        },
      })

      ctx.action<{ conversationId?: number }, DuoSessionView | null>({
        id: 'clear_override',
        description: 'Clear temporary Executor override on a conversation so it uses the Orchestrator default again',
        exposeToPrompt: false,
        cli: { command: ['duo', 'clear-override'] },
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { conversationId: CONVERSATION_ID_PROP },
        },
        outputSchema: { anyOf: [DUO_SESSION_VIEW_SCHEMA, { type: 'null' }] },
        handler: (input, context) =>
          manager.clearOverride(resolveTargetConversationId(input.conversationId, context)),
      })

      ctx.route({
        method: 'GET',
        path: '/status/:conversationId',
        handler(_req, routeCtx) {
          const rawId = Number(routeCtx.params['conversationId'])
          if (!Number.isSafeInteger(rawId) || rawId <= 0) {
            return Response.json({ error: 'invalid_conversation_id' }, { status: 400 })
          }
          try {
            return Response.json(manager.getStatus(rawId), { status: 200 })
          } catch (err) {
            const status = err instanceof HelmxError ? err.status : 500
            const code = err instanceof HelmxError ? err.code : 'internal_error'
            return Response.json(
              { error: code, message: ctx.host.redact(errorMessageOf(err)) },
              { status },
            )
          }
        },
      })

      const label = { en: 'Orchestrator', 'zh-CN': '编排器' }
      ctx.ui.sidebarItem({
        id: 'duo-manager',
        label,
        icon: 'git-pull-request',
        target: `screen:${DUO_PLUGIN_ID}/${DUO_SCREEN_ID}`,
        order: 17,
      })
      ctx.ui.screen({
        id: DUO_SCREEN_ID,
        label,
        description: {
          en: 'Pair Planner and Executor models into selectable Orchestrator tiers (tier/<id>).',
          'zh-CN': '将规划模型与执行模型配对为可直接选用的编排器档位（tier/<id>）。',
        },
        keywords: ['orchestrator', '编排器', 'duo', 'planner', 'executor', 'dual-phase', 'pair', '双相', '协同', '规划执行'],
        icon: 'git-pull-request',
        client: { module: 'manager.tsx', export: 'DuoManagerScreen' },
      })
      ctx.ui.settingsPanel({
        id: 'duo-settings',
        label,
        description: {
          en: 'Overview of configured Planner-Executor orchestrators with quick access to Orchestrator.',
          'zh-CN': '查看当前编排器概览，并快速进入编排器管理页。',
        },
        keywords: ['orchestrator', '编排器', 'duo', 'planner', 'executor', '双相', '协同'],
        order: 27,
        client: { module: 'settings.tsx', export: 'DuoSettingsPanel' },
      })
      ctx.ui.command({
        id: 'duo-create',
        title: { en: 'New Orchestrator', 'zh-CN': '新建编排器' },
        description: {
          en: 'Open the drawer to pair a Planner model with an Executor model into an Orchestrator.',
          'zh-CN': '打开抽屉新建规划与执行模型编排器。',
        },
        icon: 'git-pull-request',
        target: `screen:${DUO_PLUGIN_ID}/${DUO_SCREEN_ID}?create=1`,
        keywords: ['orchestrator', '编排器', 'duo', 'create', 'new', 'pair', 'planner', 'executor', '双相', '新建'],
      })
      ctx.ui.slot({
        id: 'duo-toolbar-pill',
        target: COMPOSER_STATUS_SLOT,
        order: 40,
        client: { module: 'index.tsx', export: 'DuoToolbarPill' },
      })
      ctx.ui.toolView({
        id: 'duo-transition-row',
        toolNames: [DUO_EXIT_PLAN_MODE_TOOL, DUO_HAND_BACK_TOOL],
        replaceRow: true,
        client: { module: 'index.tsx', export: 'DuoTransitionToolRow' },
      })
    },
  }
}
