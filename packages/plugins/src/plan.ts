/**
 * builtin:plan: read-only planning mode, structured plan drafting/approval via AskDoc,
 * artifact archival, and optional fresh-context/model handoff.
 */
import {
  COMPOSER_DOCK_SLOT,
  COMPOSER_MENU_SLOT,
  COMPOSER_TOOLBAR_SLOT,
  HelmxError,
  type PluginActionContext,
  type PluginDefinition,
} from '@helmx/protocol'
import { resolvePluginClientAssets } from './asset-paths.js'
import {
  PLAN_BADGES_DOC,
  PLAN_COMMAND_ID,
  PLAN_COMMAND_SLASH,
  PLAN_KV_NAMESPACE,
  PLAN_MARKDOWN_MAX_BYTES,
  PLAN_PANEL_ID,
  PLAN_PLUGIN_ID,
  PLAN_SESSION_DOC,
  PLAN_SESSION_VIEW_SCHEMA,
  PLAN_TITLE_MAX_CHARS,
  PLAN_TOOL_ASK,
  PLAN_TOOL_PROPOSE,
  PLAN_TOOL_SAVE,
  type PlanBadgesDoc,
  type PlanConversationRecord,
  type PlanMode,
  type PlanPluginConfig,
  type PlanPluginOptions,
  type PlanSessionView,
} from './plan/contracts.js'
import { registerPlanHooks } from './plan/hooks.js'
import { createEmptyPlanSessionView, createPlanStateManager } from './plan/state.js'
import { registerPlanTools } from './plan/tools.js'

export {
  PLAN_PLUGIN_ID,
  PLAN_SESSION_DOC,
  PLAN_BADGES_DOC,
  PLAN_PANEL_ID,
  PLAN_COMMAND_ID,
  PLAN_COMMAND_SLASH,
  PLAN_TOOL_SAVE,
  PLAN_TOOL_PROPOSE,
  PLAN_TOOL_ASK,
  PLAN_TOOL_BASH,
  PLAN_KV_NAMESPACE,
  PLAN_MODE_SECTION_ID,
  PLAN_INPUT_META_KEY,
  PLAN_TITLE_MAX_CHARS,
  PLAN_MARKDOWN_MAX_BYTES,
  PLAN_SUMMARY_MAX_CHARS,
  PLAN_HANDOFF_MAX_BYTES,
  PLAN_MODE_TOOL_WHITELIST,
  PLAN_SAVE_META_SCHEMA,
  PLAN_PROPOSE_META_SCHEMA,
  PLAN_ASK_META_SCHEMA,
  PLAN_TOOL_META_SCHEMA,
  PLAN_SESSION_VIEW_SCHEMA,
  isPlanConversationEligible,
  asPlanDeletedConversationId,
  asConversationEntryEvent,
  parsePlanSlashInput,
  hasPlanModeInputMeta,
  type PlanMode,
  type PlanAskKind,
  type PlanDraftSummary,
  type PlanApprovedInfo,
  type PlanSessionView,
  type PlanBadgeEntry,
  type PlanBadgesDoc,
  type PlanToolPresentationMeta,
  type PlanPluginConfig,
  type PlanPluginOptions,
  type PlanConversationRecord,
} from './plan/contracts.js'
export { validateReadOnlyShellCommand, type ReadOnlyShellValidationResult } from './plan/read-only-shell.js'

function resolveTargetConversationId(
  inputConversationId: number | undefined,
  context: PluginActionContext,
): number {
  if (
    inputConversationId !== undefined &&
    context.conversationId !== undefined &&
    inputConversationId !== context.conversationId
  ) {
    throw new HelmxError(
      'validation_error',
      `Conflicting conversationId: input ${inputConversationId} does not match context ${context.conversationId}`,
      400,
      {
        inputConversationId,
        contextConversationId: context.conversationId,
      },
    )
  }
  const targetId = inputConversationId ?? context.conversationId
  if (targetId === undefined) {
    throw new HelmxError(
      'validation_error',
      'Missing conversation target: provide conversationId or run inside a conversation (--current)',
      400,
    )
  }
  return targetId
}

export function createPlanPlugin(options: PlanPluginOptions = {}): PluginDefinition {
  const clientAssets =
    options.clientAssets !== undefined
      ? options.clientAssets
      : resolvePluginClientAssets(PLAN_PLUGIN_ID, 'plan', 'plan_client_missing')
  const hasClientAssets =
    clientAssets.clientRoot !== undefined || clientAssets.prebuiltClientDir !== undefined

  return {
    id: PLAN_PLUGIN_ID,
    name: { en: 'Plan Mode', 'zh-CN': '计划模式' },
    description: {
      en: 'Read-only exploration and structured plan drafting with clarifying questions, AskDoc approval, artifact archival, and optional context/model handoff.',
      'zh-CN': '只读探索与结构化计划草拟：支持结构化澄清、只读 Shell 检查、AskDoc 审批、产物归档以及可选的全新上下文/模型交接执行。',
    },
    icon: 'list-tree',
    version: '0.1.0',
    locked: false,
    ...clientAssets,
    definePlugin(ctx) {
      ctx.configSchema({
        executionModel: {
          type: 'string',
          format: 'model',
          default: '',
          label: { en: 'Execution model', 'zh-CN': '执行模型' },
          description: {
            en: 'Optional default model or tier (e.g. tier/strong) preselected for execution when approving a plan.',
            'zh-CN': '审批通过计划后默认预选的交接执行模型或档位（如 tier/strong）；审批时可按需调整，留空则默认沿用会话当前模型。',
          },
        },
      })

      const kv = ctx.kv<PlanConversationRecord>(PLAN_KV_NAMESPACE)
      const planDoc = ctx.sessionDoc<PlanSessionView>(
        PLAN_SESSION_DOC,
        createEmptyPlanSessionView(),
        { public: true, durable: false },
      )
      const badgesDoc = ctx.doc<PlanBadgesDoc>(
        PLAN_BADGES_DOC,
        { byConversation: {} },
        { public: true, durable: false },
      )

      const getExecutionModel = (): string | undefined => {
        const raw = (ctx.getConfig() as PlanPluginConfig).executionModel
        return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
      }

      const state = createPlanStateManager({ ctx, kv, planDoc, badgesDoc })

      ctx.service({
        id: 'plan-runtime',
        prepare() {
          state.setStopping(false)
        },
        start() {
          state.setStopping(false)
          state.hydrateProjections()
        },
        async reconcile() {
          await state.reconcileOrphanedAsks()
        },
        liveTasks: () => state.liveTaskLabels(),
        inUse: () => state.inUseItems(),
        stop: () => state.stopAll(),
      })

      registerPlanHooks(ctx, state)
      registerPlanTools(ctx, state, getExecutionModel)

      const conversationIdProp = {
        type: 'integer',
        minimum: 1,
        description: 'Target conversation ID (defaults to current conversation context)',
      } as const

      ctx.action<{ conversationId?: number }, PlanSessionView>({
        id: 'toggle',
        description: 'Toggle planning mode for a top-level human conversation (--conversation-id or --current)',
        visibility: 'public',
        exposeToPrompt: false,
        inputSchema: {
          type: 'object',
          properties: { conversationId: conversationIdProp },
          additionalProperties: false,
        },
        outputSchema: PLAN_SESSION_VIEW_SCHEMA,
        handler(input, context) {
          const targetId = resolveTargetConversationId(input.conversationId, context)
          return state.toggleMode(targetId)
        },
      })

      ctx.action<{ conversationId?: number; mode: PlanMode }, PlanSessionView>({
        id: 'set_mode',
        description: 'Set planning mode (normal or planning) for a top-level human conversation (--conversation-id or --current)',
        visibility: 'public',
        exposeToPrompt: false,
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: conversationIdProp,
            mode: {
              type: 'string',
              enum: ['normal', 'planning'],
              description: 'Target plan mode (normal or planning)',
            },
          },
          required: ['mode'],
          additionalProperties: false,
        },
        outputSchema: PLAN_SESSION_VIEW_SCHEMA,
        handler(input, context) {
          const targetId = resolveTargetConversationId(input.conversationId, context)
          return state.setMode(targetId, input.mode)
        },
      })

      ctx.action<{ conversationId?: number }, PlanSessionView>({
        id: 'get',
        description: 'Read current plan mode state, draft, and latest approved plan info for a conversation (--conversation-id or --current)',
        visibility: 'public',
        exposeToPrompt: false,
        idempotent: true,
        inputSchema: {
          type: 'object',
          properties: { conversationId: conversationIdProp },
          additionalProperties: false,
        },
        outputSchema: PLAN_SESSION_VIEW_SCHEMA,
        handler(input, context) {
          const targetId = resolveTargetConversationId(input.conversationId, context)
          return state.getView(targetId)
        },
      })

      ctx.action<
        { conversationId?: number; title: string; markdown: string; expectedVersion?: number },
        PlanSessionView
      >({
        id: 'update_draft',
        description:
          'Update the plan draft title and markdown for a top-level human conversation (--conversation-id or --current)',
        visibility: 'public',
        exposeToPrompt: false,
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: conversationIdProp,
            title: {
              type: 'string',
              minLength: 1,
              maxLength: PLAN_TITLE_MAX_CHARS,
              description: `Plan draft title (1-${PLAN_TITLE_MAX_CHARS} characters)`,
            },
            markdown: {
              type: 'string',
              minLength: 1,
              description: `Plan draft markdown body (1-${PLAN_MARKDOWN_MAX_BYTES} UTF-8 bytes)`,
            },
            expectedVersion: {
              type: 'integer',
              minimum: 0,
              description: 'Optional optimistic concurrency draft version check',
            },
          },
          required: ['title', 'markdown'],
          additionalProperties: false,
        },
        outputSchema: PLAN_SESSION_VIEW_SCHEMA,
        handler(input, context) {
          const targetId = resolveTargetConversationId(input.conversationId, context)
          return state.updateDraft(targetId, {
            title: input.title,
            markdown: input.markdown,
            ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
          })
        },
      })

      ctx.ui.command({
        id: PLAN_COMMAND_ID,
        title: { en: 'Toggle Plan mode', 'zh-CN': '切换计划模式' },
        description: {
          en: 'Toggle read-only plan mode for the current conversation',
          'zh-CN': '为当前会话开启或退出只读计划模式',
        },
        icon: 'list-tree',
        slash: PLAN_COMMAND_SLASH,
        shortcut: 'Ctrl+.',
        actionId: 'toggle',
        input: {},
        scope: {},
        keywords: ['plan', 'planning', 'spec', 'design', '计划', '规划', '方案'],
      })

      if (hasClientAssets) {
        ctx.ui.slot({
          id: 'plan-menu-item',
          target: COMPOSER_MENU_SLOT,
          order: 20,
          client: { module: 'index.tsx', export: 'PlanMenuItem' },
        })
        ctx.ui.slot({
          id: 'plan-toolbar',
          target: COMPOSER_TOOLBAR_SLOT,
          order: 20,
          client: { module: 'index.tsx', export: 'PlanToolbarButton' },
        })
        ctx.ui.slot({
          id: 'plan-active-tray',
          target: COMPOSER_DOCK_SLOT,
          order: 20,
          client: { module: 'index.tsx', export: 'PlanActiveTray' },
        })
        ctx.ui.workbenchPanel({
          id: PLAN_PANEL_ID,
          label: { en: 'Plan', 'zh-CN': '计划' },
          icon: 'list-tree',
          order: 15,
          badge: { doc: PLAN_BADGES_DOC, byConversationField: 'byConversation' },
          client: { module: 'index.tsx', export: 'PlanWorkbenchPanel' },
        })
        ctx.ui.toolView({
          id: 'plan-tool-row',
          toolNames: [PLAN_TOOL_SAVE, PLAN_TOOL_PROPOSE, PLAN_TOOL_ASK],
          replaceRow: true,
          client: { module: 'index.tsx', export: 'PlanToolRow' },
        })
      }
    },
  }
}
