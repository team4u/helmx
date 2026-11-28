/**
 * `builtin:duo`: dual-phase Planning/Execution orchestration (`planning` <-> `execution`)
 * configured per-Profile or per-conversation without mutating persistent conversation overrides.
 */
import {
  COMPOSER_MENU_SLOT,
  COMPOSER_TOOLBAR_SLOT,
  PROFILE_DETAIL_SECTION_SLOT,
  type PluginDefinition,
} from '@helmx/protocol'
import { resolvePluginClientAssets } from './asset-paths.js'
import {
  DEFAULT_CHILD_MODEL_CAPABILITY_ID,
  PLAN_APPROVED_EVENT,
  type DefaultChildModelCapability,
} from './contracts.js'
import { readDuoSkillAsset } from './duo/assets.js'
import {
  DUO_CONV_CONFIGS_KV,
  DUO_ELIGIBLE_SCOPE,
  DUO_EXIT_PLAN_MODE_TOOL,
  DUO_HAND_BACK_TOOL,
  DUO_MAX_STEPS_LIMIT,
  DUO_PLUGIN_ID,
  DUO_PROFILES_DOC,
  DUO_PROFILES_KV,
  DUO_PROFILE_CONFIG_SCHEMA,
  DUO_SESSION_DOC,
  DUO_SESSION_VIEW_SCHEMA,
  DUO_STATES_KV,
  DUO_TRANSITION_META_SCHEMA,
  type DuoConversationConfigRecord,
  type DuoProfileConfig,
  type DuoProfilesDocSnapshot,
  type DuoRuntimeRecord,
  type DuoSessionView,
} from './duo/contracts.js'
import {
  createDuoManager,
  type ExitPlanModeToolInput,
  type HandBackToPlannerToolInput,
} from './duo/orchestrator.js'
import {
  asConversationEntryEvent,
  asDeletedConversationId,
  resolveTargetConversationId,
} from './shared-helpers.js'

export {
  DUO_PLUGIN_ID,
  DUO_SKILL_ID,
  DUO_PROFILES_DOC,
  DUO_SESSION_DOC,
  DUO_PROFILES_KV,
  DUO_CONV_CONFIGS_KV,
  DUO_STATES_KV,
  DUO_INPUT_META_KEY,
  DUO_PLAN_SECTION_ID,
  DUO_EXECUTE_SECTION_ID,
  DUO_STEP_LIMIT_SECTION_ID,
  DUO_EXIT_PLAN_MODE_TOOL,
  DUO_HAND_BACK_TOOL,
  DUO_DEFAULT_MAX_STEPS,
  DUO_MAX_STEPS_LIMIT,
  DUO_SESSION_VIEW_SCHEMA,
  DUO_TRANSITION_META_SCHEMA,
  type DuoPhase,
  type DuoProfileConfig,
  type DuoProfilesDocSnapshot,
  type DuoSessionView,
  type DuoTransitionMeta,
} from './duo/contracts.js'

const CONVERSATION_ID_PROP = {
  type: 'integer',
  minimum: 1,
  description: 'Target conversation ID (defaults to current conversation context)',
} as const

export function createDuoPlugin(): PluginDefinition {
  return {
    id: DUO_PLUGIN_ID,
    name: { en: 'Duo Mode', 'zh-CN': '双相协同' },
    description: {
      en: 'Alternates top-level conversations between read-only Planning on your Planner model and Execution on a configured Executor model.',
      'zh-CN': '让顶层会话在规划模型（只读探索与方案制定）与执行模型（工作区落地与验证）之间无感协同切换。',
    },
    icon: 'git-pull-request',
    version: '0.1.0',
    ...resolvePluginClientAssets(DUO_PLUGIN_ID, 'duo', 'duo_plugin_client_missing'),
    definePlugin(ctx) {
      const profilesDoc = ctx.doc<DuoProfilesDocSnapshot>(
        DUO_PROFILES_DOC,
        { profiles: {} },
        { public: true },
      )
      const profilesKv = ctx.kv<DuoProfileConfig>(DUO_PROFILES_KV)
      const convConfigsKv = ctx.kv<DuoConversationConfigRecord>(DUO_CONV_CONFIGS_KV)
      const statesKv = ctx.kv<DuoRuntimeRecord>(DUO_STATES_KV)
      const duoDoc = ctx.sessionDoc<DuoSessionView | null>(DUO_SESSION_DOC, null, {
        public: true,
        durable: false,
      })

      const manager = createDuoManager({
        ctx,
        profilesDoc,
        profilesKv,
        convConfigsKv,
        statesKv,
        duoDoc,
      })

      ctx.provide<DefaultChildModelCapability>(DEFAULT_CHILD_MODEL_CAPABILITY_ID, {
        resolveDefaultChildModel: (parentConversationId) =>
          manager.resolveDefaultChildModel(parentConversationId),
      })

      ctx.service({
        id: 'duo-runtime',
        prepare() {
          manager.setStopping(false)
        },
        async start() {
          manager.setStopping(false)
          await ctx.host.skills.ensureSkill(readDuoSkillAsset())
          manager.hydrate()
        },
        async reconcile() {
          await manager.reconcile()
        },
        async stop() {
          await manager.stop()
        },
        liveTasks: () => manager.liveTaskLabels(),
        inUse: () => manager.inUseItems(),
      })

      ctx.hook.onInput((payload) => manager.handleInput(payload), { priority: -190 })

      // Run after builtin:plan (-50) so /plan retains precedence, and before profile (-100).
      ctx.hook.onBeforeTurn((turn) => manager.handleBeforeTurn(turn), { priority: -60 })

      // Synchronous transform after workflow (300) and worktree (200) so builtin:duo never holds liveTasks open.
      ctx.hook.onAgentSpawn((request) => manager.handleAgentSpawn(request), { priority: 100 })

      ctx.hook.onTurnSettled(async (payload) => {
        await manager.handleTurnSettled(payload.conversation.id)
      })

      ctx.host.onEvent(PLAN_APPROVED_EVENT, async (payload) => {
        await manager.handlePlanApproved(payload)
      })

      ctx.host.onEvent('conversation.upsert', async (payload) => {
        await manager.handleConversationUpsert(payload)
      })

      ctx.host.onEvent('conversation.deleted', async (payload) => {
        const conversationId = asDeletedConversationId(payload)
        if (conversationId !== undefined) {
          await manager.handleConversationDeleted(conversationId)
        }
      })

      ctx.host.onEvent('conversation.entry', async (payload) => {
        const entry = asConversationEntryEvent(payload)
        if (entry !== undefined && entry.kind === 'pi.reset') {
          await manager.handleConversationReset(entry.conversationId)
        }
      })

      ctx.host.onEvent('profile.changed', async (payload) => {
        await manager.handleProfileChanged(payload)
      })

      ctx.tool<ExitPlanModeToolInput>({
        name: DUO_EXIT_PLAN_MODE_TOOL,
        description:
          'Exit the Planning Phase and switch this conversation in place to the Executor model (which sees the conversation so far plus this plan). Call once the plan is ready, alone as the sole tool call of the step.',
        promptGuidelines: [
          'Call exit_plan_mode({ plan }) alone (never in parallel with other tools) for single-stream edits, side-effect actions, or final merge/verification—use 1-2 sentences for trivial settled follow-ups, or a complete plan with verification criteria and a Re-plan if: list for substantive work. Skip it for pure questions, when /plan is active, or when staying in Planning Phase to orchestrate parallel subagents/Swarm.',
        ],
        scope: DUO_ELIGIBLE_SCOPE,
        inputSchema: {
          type: 'object',
          required: ['plan'],
          additionalProperties: false,
          properties: {
            plan: {
              type: 'string',
              minLength: 1,
              description: 'Execution plan for the Executor model (with verification criteria and a Re-plan if list)',
            },
          },
        },
        presentationMetaSchema: DUO_TRANSITION_META_SCHEMA,
        execute: (input, context) => manager.executeExitPlanModeTool(input, context.conversationId),
      })

      ctx.tool<HandBackToPlannerToolInput>({
        name: DUO_HAND_BACK_TOOL,
        description:
          'Return control from the Executor model back to the Planner model inside a Duo conversation for replanning, unresolved decisions, or scheduled step-budget review. Call alone as the sole tool call of the step.',
        promptGuidelines: [
          'Call hand_back_to_planner({ reason, summary }) alone (never in parallel with other tools) when a Re-plan if: condition triggers, a blocking flaw/clarification/scope-changing user steer occurs, or the execution step budget is reached. Do NOT call it on normal verified completion—reply directly to the user instead.',
        ],
        scope: DUO_ELIGIBLE_SCOPE,
        inputSchema: {
          type: 'object',
          required: ['reason', 'summary'],
          additionalProperties: false,
          properties: {
            reason: {
              type: 'string',
              minLength: 1,
              description: 'Short reason for returning control to the Planner (e.g. step_budget_reached, blocked, need_clarification)',
            },
            summary: {
              type: 'string',
              minLength: 1,
              description: 'Concise progress, completed checks, and blocker details for the Planner',
            },
          },
        },
        presentationMetaSchema: DUO_TRANSITION_META_SCHEMA,
        execute: (input, context) => manager.executeHandBackTool(input, context.conversationId),
      })

      ctx.action<{ conversationId?: number }, DuoSessionView | null>({
        id: 'status',
        description: 'Inspect current Duo mode configuration and active phase for a conversation (--conversation-id or --current)',
        idempotent: true,
        exposeToPrompt: false,
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
          enabled: boolean
          executorModel?: string
          executorThinkingLevel?: string
          maxExecutionSteps?: number
        },
        DuoSessionView | null
      >({
        id: 'set_conversation',
        description: 'Configure or disable Duo mode for one top-level human conversation (--conversation-id or --current)',
        exposeToPrompt: false,
        cli: { command: ['duo', 'set-conversation'] },
        inputSchema: {
          type: 'object',
          required: ['enabled'],
          additionalProperties: false,
          properties: {
            conversationId: CONVERSATION_ID_PROP,
            enabled: { type: 'boolean' },
            executorModel: { type: 'string', minLength: 1 },
            executorThinkingLevel: { type: 'string' },
            maxExecutionSteps: { type: 'integer', minimum: 0, maximum: DUO_MAX_STEPS_LIMIT },
          },
        },
        outputSchema: { anyOf: [DUO_SESSION_VIEW_SCHEMA, { type: 'null' }] },
        handler: (input, context) =>
          manager.setConversationConfig({
            conversationId: resolveTargetConversationId(input.conversationId, context),
            enabled: input.enabled,
            ...(input.executorModel !== undefined ? { executorModel: input.executorModel } : {}),
            ...(input.executorThinkingLevel !== undefined
              ? { executorThinkingLevel: input.executorThinkingLevel }
              : {}),
            ...(input.maxExecutionSteps !== undefined ? { maxExecutionSteps: input.maxExecutionSteps } : {}),
          }),
      })

      ctx.action<{ conversationId?: number }, DuoSessionView | null>({
        id: 'clear_conversation',
        description: 'Clear per-conversation Duo override and revert to Profile inheritance (--conversation-id or --current)',
        exposeToPrompt: false,
        cli: { command: ['duo', 'clear-conversation'] },
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { conversationId: CONVERSATION_ID_PROP },
        },
        outputSchema: { anyOf: [DUO_SESSION_VIEW_SCHEMA, { type: 'null' }] },
        handler: (input, context) =>
          manager.clearConversationConfig(resolveTargetConversationId(input.conversationId, context)),
      })

      ctx.action<
        {
          profileId: string
          enabled: boolean
          executorModel?: string
          executorThinkingLevel?: string
          maxExecutionSteps?: number
        },
        DuoProfileConfig
      >({
        id: 'set_profile',
        description: 'Configure Profile-level Duo orchestration defaults',
        exposeToPrompt: false,
        cli: { command: ['duo', 'set-profile'] },
        inputSchema: {
          type: 'object',
          required: ['profileId', 'enabled'],
          additionalProperties: false,
          properties: {
            profileId: { type: 'string', minLength: 1 },
            enabled: { type: 'boolean' },
            executorModel: { type: 'string' },
            executorThinkingLevel: { type: 'string' },
            maxExecutionSteps: { type: 'integer', minimum: 0, maximum: DUO_MAX_STEPS_LIMIT },
          },
        },
        outputSchema: DUO_PROFILE_CONFIG_SCHEMA,
        handler: (input) => manager.setProfileConfig(input),
      })

      ctx.action<{ profileId: string }, { removed: boolean }>({
        id: 'clear_profile',
        description: 'Remove Profile-level Duo orchestration configuration',
        exposeToPrompt: false,
        cli: { command: ['duo', 'clear-profile'] },
        inputSchema: {
          type: 'object',
          required: ['profileId'],
          additionalProperties: false,
          properties: {
            profileId: { type: 'string', minLength: 1 },
          },
        },
        outputSchema: {
          type: 'object',
          required: ['removed'],
          additionalProperties: false,
          properties: { removed: { type: 'boolean' } },
        },
        handler: (input) => manager.clearProfileConfig(input.profileId),
      })

      ctx.ui.slot({
        id: 'duo-profile-section',
        target: PROFILE_DETAIL_SECTION_SLOT,
        order: 25,
        client: { module: 'index.tsx', export: 'DuoProfileSection' },
      })
      ctx.ui.slot({
        id: 'duo-menu-item',
        target: COMPOSER_MENU_SLOT,
        order: 25,
        client: { module: 'index.tsx', export: 'DuoMenuItem' },
      })
      ctx.ui.slot({
        id: 'duo-toolbar-pill',
        target: COMPOSER_TOOLBAR_SLOT,
        order: 10,
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
