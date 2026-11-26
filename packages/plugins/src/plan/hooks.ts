/**
 * builtin:plan lifecycle hooks (`input`, `before_turn`) and `conversation.deleted` listener.
 */
import type { HelmxPluginContext } from '@helmx/protocol'
import {
  asConversationEntryEvent,
  asDeletedConversationId,
  getConversationOrUndefined,
} from '../shared-helpers.js'
import {
  PLAN_MODE_SECTION_ID,
  PLAN_MODE_TOOL_WHITELIST,
  PLAN_TOOL_BASH,
  PLAN_TOOL_PROPOSE,
  PLAN_TOOL_SAVE,
  hasPlanModeInputMeta,
  isPlanConversationEligible,
  parsePlanSlashInput,
} from './contracts.js'
import type { PlanStateManager } from './state.js'

export const PLAN_MODE_SYSTEM_SECTION = [
  '<plan_mode>',
  'You are currently in READ-ONLY Plan Mode.',
  '1. Research only: use `read`, `read_artifact`, `load_skill`, and `plan_bash` strictly for read-only inspection (`plan_bash` rejects mutating shell commands and file output redirections). Never edit files, run side-effecting installs/builds, create commits, or mutate external state.',
  '2. Clarify ambiguity cleanly: when requirements, scope, or architecture tradeoffs have genuine ambiguity, call `ask_user` with 1–4 concise structured questions instead of asking long walls of open-ended questions. For minor details, ask concisely in your text reply.',
  '3. Draft a self-contained plan via `plan_save({ title, markdown })`: if the user approves with a fresh-context handoff, ALL prior exploration messages and file reads will be cleared and the executor will ONLY see this Markdown. Therefore include exact file paths, key symbol/API names, concrete step-by-step changes, discovered edge cases/constraints, and exact verification commands so an executor with zero prior context can implement immediately without re-researching the repository.',
  '4. Propose via `plan_propose({ summary })`: when ready, call `plan_propose` with a concise plain-text summary (1–300 chars, no fenced code blocks). Workspace mutation tools remain disabled until the user approves the proposal.',
  '</plan_mode>',
].join('\n')

const PLAN_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  PLAN_TOOL_SAVE,
  PLAN_TOOL_PROPOSE,
  PLAN_TOOL_BASH,
])

export function registerPlanHooks(ctx: HelmxPluginContext, state: PlanStateManager): void {
  ctx.hook.onInput(
    async (payload) => {
      if (state.isStopping()) return { action: 'continue' }
      if (payload.input.origin !== 'human') return { action: 'continue' }

      const parsed = parsePlanSlashInput(payload.input.text)
      const metaRequested = hasPlanModeInputMeta(payload.input.meta)
      const existing = state.getRecord(payload.conversationId)
      const hasPending =
        existing?.pendingAskId !== undefined || state.hasInFlightAsk(payload.conversationId)
      if (!parsed.matched && !metaRequested && !hasPending) return { action: 'continue' }

      const conv = getConversationOrUndefined(
        (id) => ctx.host.getConversation(id),
        payload.conversationId,
      )
      if (conv === undefined || !isPlanConversationEligible(conv)) {
        return { action: 'continue' }
      }

      if (!parsed.matched) {
        if (metaRequested) {
          await state.enterPlanningMode(conv.id)
          return { action: 'continue' }
        }
        await state.supersedePendingAsk(conv.id)
        return { action: 'continue' }
      }

      await state.enterPlanningMode(conv.id)
      if (parsed.remainder === '') {
        return { action: 'handled' }
      }
      return {
        action: 'transform',
        value: {
          ...payload,
          input: {
            ...payload.input,
            text: parsed.remainder,
          },
        },
      }
    },
    { priority: -50 },
  )

  // Run after default-priority (0) hooks and before profile's catalog hook (-100) so stripped
  // dispatch tools suppress `<available_profiles>` cleanly without leaking collaboration prompts.
  ctx.hook.onBeforeTurn(
    (turn) => {
      const eligible = isPlanConversationEligible(turn.conversation)
      const record = eligible ? state.getRecord(turn.conversation.id) : undefined
      const inPlanningMode = eligible && record?.mode === 'planning'

      if (!inPlanningMode) {
        const tools = turn.tools.filter((tool) => !PLAN_ONLY_TOOL_NAMES.has(tool.name))
        const sections = turn.sections.filter((section) => section.id !== PLAN_MODE_SECTION_ID)
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

      const tools = turn.tools.filter((tool) => PLAN_MODE_TOOL_WHITELIST.has(tool.name))
      const sections = [
        ...turn.sections.filter((section) => section.id !== PLAN_MODE_SECTION_ID),
        { id: PLAN_MODE_SECTION_ID, text: PLAN_MODE_SYSTEM_SECTION },
      ]
      return {
        action: 'transform',
        value: {
          ...turn,
          tools,
          sections,
        },
      }
    },
    { priority: -50 },
  )

  ctx.host.onEvent('conversation.deleted', async (payload) => {
    const conversationId = asDeletedConversationId(payload)
    if (conversationId === undefined) return
    await state.cleanupDeletedConversation(conversationId)
  })

  ctx.host.onEvent('conversation.entry', async (payload) => {
    if (state.isStopping()) return
    const entry = asConversationEntryEvent(payload)
    if (entry === undefined) return
    if (entry.kind === 'pi.reset') {
      if (state.consumeExpectedHandoffReset(entry.conversationId)) {
        return
      }
      await state.resetConversationState(entry.conversationId)
      return
    }
    if (entry.kind === 'helmx.rewind') {
      // Preserve planning mode and draft on rewind so editing a prior prompt never boots the user out of plan mode,
      // while superseding any pending ask from the rewound turn.
      await state.supersedePendingAsk(entry.conversationId)
    }
  })

  ctx.hook.onTurnSettled((payload) => {
    state.clearExpectedHandoffReset(payload.conversation.id)
  })
}
