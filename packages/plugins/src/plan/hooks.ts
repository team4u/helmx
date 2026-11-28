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
  PLAN_TOOL_PROPOSE,
  PLAN_TOOL_SAVE,
  hasPlanModeInputMeta,
  isPlanConversationEligible,
  parsePlanSlashInput,
} from './contracts.js'
import type { PlanStateManager } from './state.js'

export const PLAN_MODE_SYSTEM_SECTION = [
  '<plan_mode>',
  'You are currently in READ-ONLY Plan Mode. File-editing and delegation tools (`write`, `edit`, `register_artifact`, `subagent`, `SubagentWorkflow`, `swarm_*`, etc.) are disabled until the user approves your plan.',
  '1. Research only: use `read`, `read_artifact`, and `load_skill` to inspect files and artifacts. Use `bash` strictly for read-only observation (code search, builds, typecheck, tests, `git status`/`log`/`diff`) and `run_action` strictly for read-only queries (`list`, `describe`, and read-only status/inspection actions). Never edit files, redirect output into workspace files, create commits, or mutate external/host state.',
  '2. Resolve blocking ambiguity before proposing: when requirements, scope, or architecture tradeoffs have genuine ambiguity, call `ask_user` with 1–4 concise structured questions instead of leaving unresolved open questions inside the plan. For minor details, state your recommended default clearly under `User Review Required`.',
  '3. Draft a self-contained, review-friendly plan via `plan_save({ title, markdown })`: if the user approves with a fresh-context handoff, ALL prior exploration messages and file reads will be cleared and the executor will ONLY see this Markdown. Include exact file paths, key symbol/API names, concrete step-by-step changes, edge cases/constraints, and exact verification commands. Structure the Markdown clearly, omitting irrelevant sections for small tasks:',
  '   - `## Goal`: concise problem statement, context, and expected outcome.',
  '   - `## User Review Required`: place breaking changes, high-risk tradeoffs, or default assumptions up front using GitHub alerts (`> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`).',
  '   - `## Proposed Changes`: group by package/component in dependency order and tag files with `[MODIFY]`, `[NEW]`, or `[DELETE]`. For existing `[MODIFY]`/`[DELETE]` files, link them as `[basename](repo/relative/path#L10-L20)` (full repo-relative path in the href so both human preview and zero-context handoff work); for `[NEW]` files that do not exist yet, use inline code with the full repo-relative path (never a file link). Add concise signature/`diff` snippets or a `mermaid` diagram when it clarifies complex flows.',
  '   - `## Verification Plan`: split into `### Automated Tests` (exact commands and expected outcomes) and `### Manual Verification` (when applicable).',
  '4. Propose via `plan_propose({ summary })` without duplicating the plan in chat: call `plan_propose` with a concise plain-text summary (1–300 chars, no fenced code blocks). Because the saved draft is already visible in the Plan workbench panel and composer tray, DO NOT paste or re-summarize the plan body in your chat reply—only highlight key tradeoffs or decisions needing the user\'s attention. Workspace mutation tools remain disabled until the user approves the proposal.',
  '</plan_mode>',
].join('\n')

const PLAN_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  PLAN_TOOL_SAVE,
  PLAN_TOOL_PROPOSE,
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

      const rejectMode =
        payload.input.whenBusy === 'reject' || payload.input.whenPendingAsk === 'reject'

      if (!parsed.matched) {
        if (rejectMode && hasPending) {
          return { action: 'continue' }
        }
        if (metaRequested) {
          await state.enterPlanningMode(conv.id)
          return { action: 'continue' }
        }
        await state.supersedePendingAsk(conv.id)
        return { action: 'continue' }
      }

      if (rejectMode && hasPending) {
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
