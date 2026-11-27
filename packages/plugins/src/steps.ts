/**
 * builtin:steps: live task step checklist driven by `update_steps`, rendered as a
 * collapsible dock tray above the composer and compact timeline trace rows.
 */
import { COMPOSER_DOCK_SLOT, type PluginDefinition } from '@helmx/protocol'
import { resolvePluginClientAssets } from './asset-paths.js'
import {
  asConversationEntryEvent,
  asDeletedConversationId,
  resolveTargetConversationId,
} from './shared-helpers.js'
import {
  STEPS_ELIGIBLE_SCOPE,
  STEPS_KV_NAMESPACE,
  STEPS_MAX_ITEMS,
  STEPS_PLUGIN_ID,
  STEPS_PRESENTATION_META_SCHEMA,
  STEPS_SESSION_DOC,
  STEPS_SESSION_VIEW_SCHEMA,
  STEPS_TOOL_UPDATE,
  UPDATE_STEPS_INPUT_SCHEMA,
  formatStepsToolOutput,
  type StepsConversationRecord,
  type StepsPluginOptions,
  type StepsSessionView,
  type UpdateStepsInput,
} from './steps/contracts.js'
import { createStepsStateManager } from './steps/state.js'

export {
  STEPS_PLUGIN_ID,
  STEPS_KV_NAMESPACE,
  STEPS_SESSION_DOC,
  STEPS_TOOL_UPDATE,
  STEPS_MAX_ITEMS,
  STEPS_TITLE_MAX_CHARS,
  STEP_STATUSES,
  STEPS_ELIGIBLE_SCOPE,
  STEP_ITEM_SCHEMA,
  UPDATE_STEPS_INPUT_SCHEMA,
  STEPS_PRESENTATION_META_SCHEMA,
  STEPS_SESSION_VIEW_SCHEMA,
  isStepsConversationEligible,
  isStepTerminalStatus,
  isStepsAllTerminal,
  createEmptyStepsSessionView,
  toStepsSessionView,
  toStepsActionView,
  normalizeStepItems,
  buildStepsPresentationMeta,
  formatStepsToolOutput,
  parseStepsConversationRecord,
  parseStepsToolPresentationMeta,
  type StepStatus,
  type StepsSettledOutcome,
  type StepItem,
  type StepsConversationRecord,
  type StepsSessionView,
  type StepsToolPresentationMeta,
  type UpdateStepsInput,
  type StepsPluginClientAssets,
  type StepsPluginOptions,
} from './steps/contracts.js'

export const STEPS_PROMPT_GUIDELINES: string[] = [
  `Call ${STEPS_TOOL_UPDATE} once committed to an ordered list of 3-${STEPS_MAX_ITEMS} distinct steps; skip for 1-2 step edits, pure questions, or early exploration where steps are not known yet.`,
  'Always send the full ordered list (each call replaces the previous state); pass steps: [] to clear. Mark active step(s) in_progress and remaining steps pending, done, skipped, or failed.',
  `Batch ${STEPS_TOOL_UPDATE} in parallel with the first tool call of each step so it adds zero extra turns; when the final step completes, call ${STEPS_TOOL_UPDATE} once more with all steps terminal before writing your final reply.`,
  'Keep titles short and imperative (2-6 words, matching the user language) without leading step numbers or IDs.',
]

export function createStepsPlugin(options: StepsPluginOptions = {}): PluginDefinition {
  const clientAssets =
    options.clientAssets !== undefined
      ? options.clientAssets
      : resolvePluginClientAssets(STEPS_PLUGIN_ID, 'steps', 'steps_plugin_client_missing')
  const hasClientAssets =
    clientAssets.clientRoot !== undefined || clientAssets.prebuiltClientDir !== undefined
  const now = options.now ?? Date.now

  return {
    id: STEPS_PLUGIN_ID,
    name: { en: 'Live Steps', 'zh-CN': '实时步骤清单' },
    description: {
      en: 'Live task step checklist above the composer and compact timeline trace updates driven by the update_steps tool.',
      'zh-CN': '由 update_steps 工具驱动的实时步骤清单：在输入框上方展示可折叠进度条，并将时间线更新收敛为紧凑单行轨迹。',
    },
    icon: 'check-square',
    version: '0.1.0',
    locked: false,
    ...clientAssets,
    definePlugin(ctx) {
      const kv = ctx.kv<StepsConversationRecord>(STEPS_KV_NAMESPACE)
      const stepsDoc = ctx.sessionDoc<StepsSessionView | null>(
        STEPS_SESSION_DOC,
        null,
        { public: true, durable: false },
      )
      const state = createStepsStateManager({ ctx, kv, stepsDoc, now })

      ctx.service({
        id: 'steps-runtime',
        prepare() {
          state.setStopping(false)
        },
        start() {
          state.setStopping(false)
          state.hydrate()
        },
        stop() {
          return state.stop()
        },
      })

      ctx.tool<UpdateStepsInput>({
        name: STEPS_TOOL_UPDATE,
        description:
          'Show a live step checklist for multi-step work (full-list replacement semantics; up to 12 short steps).',
        promptSnippet:
          'Publish and update the live multi-step task checklist shown above the composer (full list, batched with work tools).',
        promptGuidelines: STEPS_PROMPT_GUIDELINES,
        inputSchema: UPDATE_STEPS_INPUT_SCHEMA,
        presentationMetaSchema: STEPS_PRESENTATION_META_SCHEMA,
        scope: STEPS_ELIGIBLE_SCOPE,
        replay: 'safe',
        async execute(input, toolCtx) {
          const { meta } = await state.updateSteps(toolCtx.conversationId, input.steps)
          return {
            output: formatStepsToolOutput(meta),
            presentationMeta: meta,
          }
        },
      })

      ctx.hook.onInput(
        async (payload) => {
          if (state.isStopping()) return { action: 'continue' }
          if (payload.input.origin !== 'human') return { action: 'continue' }
          if (payload.input.whenBusy === 'reject' || payload.input.whenPendingAsk === 'reject') {
            return { action: 'continue' }
          }
          await state.handleHumanInput(payload.conversationId)
          return { action: 'continue' }
        },
        { priority: -40 },
      )

      ctx.hook.onTurnSettled(async (payload) => {
        if (state.isStopping()) return
        await state.handleTurnSettled(payload.conversation.id, payload.outcome)
      })

      ctx.host.onEvent('conversation.deleted', async (payload) => {
        const conversationId = asDeletedConversationId(payload)
        if (conversationId === undefined) return
        await state.handleConversationDeleted(conversationId)
      })

      ctx.host.onEvent('conversation.entry', async (payload) => {
        if (state.isStopping()) return
        const entry = asConversationEntryEvent(payload)
        if (entry === undefined) return
        if (entry.kind === 'pi.reset') {
          await state.handleReset(entry.conversationId)
          return
        }
        if (entry.kind === 'helmx.rewind') {
          await state.handleRewind(entry.conversationId)
        }
      })

      const conversationIdProp = {
        type: 'integer',
        minimum: 1,
        description: 'Target conversation ID (defaults to current conversation context)',
      } as const

      ctx.action<{ conversationId?: number }, StepsSessionView>({
        id: 'get',
        description: 'Read current live checklist steps for a conversation (--conversation-id or --current)',
        visibility: 'public',
        exposeToPrompt: false,
        idempotent: true,
        inputSchema: {
          type: 'object',
          properties: { conversationId: conversationIdProp },
          additionalProperties: false,
        },
        outputSchema: STEPS_SESSION_VIEW_SCHEMA,
        handler(input, context) {
          const targetId = resolveTargetConversationId(input.conversationId, context)
          return state.getView(targetId)
        },
      })

      ctx.action<{ conversationId?: number }, StepsSessionView>({
        id: 'clear',
        description: 'Clear live checklist steps for a top-level human conversation (--conversation-id or --current)',
        visibility: 'public',
        exposeToPrompt: false,
        inputSchema: {
          type: 'object',
          properties: { conversationId: conversationIdProp },
          additionalProperties: false,
        },
        outputSchema: STEPS_SESSION_VIEW_SCHEMA,
        handler(input, context) {
          const targetId = resolveTargetConversationId(input.conversationId, context)
          return state.clear(targetId)
        },
      })

      ctx.action<{ conversationId?: number }, StepsSessionView>({
        id: 'dismiss',
        description: 'Dismiss the live checklist tray for the current checklist revision',
        visibility: 'ui',
        exposeToPrompt: false,
        inputSchema: {
          type: 'object',
          properties: { conversationId: conversationIdProp },
          additionalProperties: false,
        },
        outputSchema: STEPS_SESSION_VIEW_SCHEMA,
        handler(input, context) {
          const targetId = resolveTargetConversationId(input.conversationId, context)
          return state.dismiss(targetId)
        },
      })

      if (hasClientAssets) {
        ctx.ui.slot({
          id: 'steps-active-tray',
          target: COMPOSER_DOCK_SLOT,
          order: 15,
          scope: STEPS_ELIGIBLE_SCOPE,
          client: { module: 'index.tsx', export: 'StepsActiveTray' },
        })
        ctx.ui.toolView({
          id: 'steps-tool-row',
          toolNames: [STEPS_TOOL_UPDATE],
          replaceRow: true,
          client: { module: 'index.tsx', export: 'StepsToolRow' },
        })
      }
    },
  }
}
