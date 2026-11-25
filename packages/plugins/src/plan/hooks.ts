/**
 * builtin:plan lifecycle hooks (`input`, `before_turn`) and `conversation.deleted` listener.
 */
import { HelmxError, type ConversationSummary, type HelmxPluginContext } from '@helmx/protocol'
import {
  PLAN_MODE_SECTION_ID,
  PLAN_MODE_TOOL_WHITELIST,
  PLAN_TOOL_PROPOSE,
  PLAN_TOOL_SAVE,
  asPlanDeletedConversationId,
  isPlanConversationEligible,
  parsePlanSlashInput,
} from './contracts.js'
import type { PlanStateManager } from './state.js'

export const PLAN_MODE_SYSTEM_SECTION = [
  '<plan_mode>',
  'You are currently in READ-ONLY Planning Mode.',
  '1. Research only: use `read`, `read_artifact`, `load_skill`, and `bash` strictly for read-only inspection (e.g., `rg`, `ls`, `git status`, `git diff`, reading files/logs). Never use `bash` to edit files, run side-effecting installs/builds, create commits, or mutate external state.',
  '2. Clarify ambiguity first: if key requirements, constraints, or tradeoffs remain unclear, ask concise questions directly in your text reply before finalizing.',
  '3. Draft via `plan_save({ title, markdown })`: write a concrete, actionable implementation plan (files, changes, edge cases, verification steps). You may refine and overwrite the draft across turns.',
  '4. Propose via `plan_propose({ summary })`: when ready, call `plan_propose` with a concise plain-text summary (no fenced code blocks). Workspace mutation tools remain disabled until the user approves the proposal.',
  '</plan_mode>',
].join('\n')

function getConversationOrUndefined(
  read: (id: number) => ConversationSummary,
  id: number,
): ConversationSummary | undefined {
  try {
    return read(id)
  } catch (err) {
    if (err instanceof HelmxError && (err.status === 404 || err.code === 'not_found')) {
      return undefined
    }
    throw err
  }
}

export function registerPlanHooks(ctx: HelmxPluginContext, state: PlanStateManager): void {
  ctx.hook.onInput(
    async (payload) => {
      if (state.isStopping()) return { action: 'continue' }
      if (payload.input.origin !== 'human') return { action: 'continue' }

      const parsed = parsePlanSlashInput(payload.input.text)
      const existing = state.getRecord(payload.conversationId)
      const hasPending =
        existing?.pendingAskId !== undefined || state.hasInFlightAsk(payload.conversationId)
      if (!parsed.matched && !hasPending) return { action: 'continue' }

      const conv = getConversationOrUndefined(
        (id) => ctx.host.getConversation(id),
        payload.conversationId,
      )
      if (conv === undefined || !isPlanConversationEligible(conv)) {
        return { action: 'continue' }
      }

      if (!parsed.matched) {
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
        const tools = turn.tools.filter(
          (tool) => tool.name !== PLAN_TOOL_SAVE && tool.name !== PLAN_TOOL_PROPOSE,
        )
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
    const conversationId = asPlanDeletedConversationId(payload)
    if (conversationId === undefined) return
    await state.cleanupDeletedConversation(conversationId)
  })
}
