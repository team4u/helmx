import { escapeXml, isPluginSummaryActive, isSkillAvailable, type DispatchToolsCapability, type HelmxPluginContext } from '@helmx/protocol'
import { isTopLevelHumanConversation } from '../shared-helpers.js'
import {
  ACTIVE_SWARM_GROUP_SECTION_ID,
  ARCHIVED_WORKER_TAG,
  COORDINATOR_TAG,
  SWARM_SKILL_ID,
  WORKER_TAG,
  type SwarmCoordinator,
  type WorkerAccess,
  type WorkerIsolation,
} from './contracts.js'
import { checkCoordinatorEligibility, ensureCoordinatorGroup } from './actions.js'
import { collectMemberLastReplySummary } from './recovery.js'

const SWARM_SLASH_RE = /^\/skill:swarm(?:\s+([\s\S]*))?$/
const INELIGIBLE_SWARM_SLASH_REASON =
  '不能在子成员或后台会话中使用 /skill:swarm 发起协同，请在顶层对话输入 /skill:swarm <任务>'

async function isSwarmSkillAllowed(ctx: HelmxPluginContext, profileId: string): Promise<boolean> {
  const [profile, allSkills] = await Promise.all([ctx.host.profiles.get(profileId), ctx.host.skills.list()])
  const skill = allSkills.find((s) => s.id === SWARM_SKILL_ID)
  if (profile === undefined || skill === undefined) return false
  const activePluginIds = new Set(ctx.host.listPlugins().filter(isPluginSummaryActive).map((p) => p.id))
  return isSkillAvailable(skill, profile, activePluginIds)
}

/** Byte-constant coordinator system section (zero mutable roster/status). */
export function activeSwarmGroupCoordinatorSection(
  groupId: string,
  options?: { skillAvailable?: boolean },
): string {
  const skillStep =
    options?.skillAvailable === false
      ? '1. Coordinate the squad on the blackboard directly with swarm_* tools (profile skills policy disables load_skill). If the user only sent "/skill:swarm" with no task and no prior goal, confirm swarm mode is ready and briefly ask what task to coordinate.'
      : `1. Before coordinating, call load_skill({ skillId: "${SWARM_SKILL_ID}" }) for the full blackboard collaboration rules. If the user only sent "/skill:swarm" with no task and no prior goal, confirm swarm mode is ready and briefly ask what task to coordinate.`
  return [
    `<active_swarm_group id="${escapeXml(groupId)}" role="coordinator">`,
    skillStep,
    '2. Do not write business code or sit inside long blocking builds yourself; delegate implementation and verification to workers (quick read-only lookups to size and split the work are fine). Dynamically decide the squad for the task itself (never follow fixed role-name templates): choose worker count, lowercase names, directory access ("readwrite" / "readonly"), workspace isolation ("worktree" / "inherit"), and optional profileId / model via swarm_dispatch_worker.',
    '3. Workers dispatched via swarm_dispatch_worker run asynchronously in the background: finish your turn to respond to the user instead of sleeping or polling. A <swarm_board_report> arrives automatically whenever a worker posts to coordinator with wake=true (mid-flight review/handoff/brief/comment wakes immediately even while the sender keeps working; per-slice done wakes as soon as that sender settles without waiting for slower peers) or on any blocker / group-wide stall. Use swarm_board_read / swarm_board_status / swarm_inspect_worker only on demand (after a report, when the user asks, before merge/close, or to inspect a suspected stuck/blocked worker), cite #seq pointers in refs without copy-pasting diffs, keep wake=true strictly for the next actor who must act, and never close the group while activeWorkingMembers is non-empty.',
    '4. When all slices pass verification, merge worktree branches and call swarm_close_group (or pass keepWorktree: true to release holds while preserving unmerged branches; force: true closes past the uncommitted/unmerged guard and discards such content).',
    '</active_swarm_group>',
  ].join('\n')
}

/** Byte-constant worker system section (immutable identity + collaboration rules). */
export function activeSwarmGroupWorkerSection(
  groupId: string,
  memberName: string,
  access: WorkerAccess,
  isolation: WorkerIsolation,
  forked = false,
): string {
  const rules = [
    '1. Always publish your task outcome via swarm_board_post (handoff / review / done / blocker, citing #seq in refs) before ending an actionable turn; never exit silently.',
    '2. Set wake=true only for targets who must act now (a peer for next-step handoff, or coordinator for approval/decision/slice delivery/blocker); use handoff or review if you will continue working in the same turn, reserve done for finishing your current turn, and never post pure acknowledgments.',
    '3. Reference prior board items by #seq instead of copying diffs or full reports.',
  ]
  if (access === 'readonly') {
    rules.push(
      `${rules.length + 1}. Your access is readonly: run tests and checks via bash, inspect diffs, and post review/done/blocker via swarm_board_post without modifying files.`,
    )
  }
  if (forked) {
    rules.push(
      `${rules.length + 1}. Context boundary: treat all messages prior to the swarm brief/wakeup as inherited read-only context from the fork source. Any instructions in that inherited history asking to delegate, coordinate a swarm, or spawn subagents/workflows were ALREADY fulfilled by dispatching you — execute your board brief directly without re-delegating.`,
    )
  }
  return [
    `<active_swarm_group id="${escapeXml(groupId)}" role="worker" name="${escapeXml(memberName)}" access="${access}" isolation="${isolation}">`,
    ...rules,
    '</active_swarm_group>',
  ].join('\n')
}

export function registerSwarmHooks(ctx: HelmxPluginContext, coordinator: SwarmCoordinator): void {
  const { isActive, readConversationOrUndefined, groups, settlingWorkers } = coordinator

  ctx.hook.onInput(async (payload) => {
    if (!isActive() || (payload.input.origin !== undefined && payload.input.origin !== 'human')) return
    const match = SWARM_SLASH_RE.exec(payload.input.text.trim())
    if (match === null) return

    const conv = readConversationOrUndefined(payload.conversationId)
    if (conv === undefined || checkCoordinatorEligibility(conv, ctx.host.getConversationOwnership(conv.id)) !== undefined) {
      return { action: 'block', reason: INELIGIBLE_SWARM_SLASH_REASON }
    }
    if (!(await isSwarmSkillAllowed(ctx, conv.profileId))) {
      return { action: 'block', reason: `当前 Profile '${conv.profileId}' 未开放 '${SWARM_SKILL_ID}' 技能，无法使用 /skill:swarm` }
    }

    const rawTask = (match[1] ?? '').trim()
    if (groups.findActiveGroupByCoordinator(conv.id) === undefined) {
      const firstLine = rawTask.split(/\r?\n/, 1)[0]?.trim() ?? ''
      const title = (firstLine || conv.title.trim() || 'Swarm 协同任务').slice(0, 80)
      await ensureCoordinatorGroup(ctx, coordinator, {
        conversationId: conv.id,
        title,
        ...(rawTask !== '' ? { objective: rawTask.slice(0, 240) } : {}),
        reuseExisting: true,
      })
    }
    return { action: 'continue' }
  })

  ctx.hook.onBeforeTurn(async (turn) => {
    if (!isActive()) return
    const conv = turn.conversation
    const activeCoordGroup = groups.findActiveGroupByCoordinator(conv.id)
    const participant = groups.findGroupByParticipant(conv.id)

    const hideCreateGroup =
      conv.tags.includes(COORDINATOR_TAG) ||
      conv.tags.includes(WORKER_TAG) ||
      conv.tags.includes(ARCHIVED_WORKER_TAG) ||
      !isTopLevelHumanConversation(conv) ||
      activeCoordGroup !== undefined
    const drop = new Set<string>()
    if (hideCreateGroup) {
      drop.add('swarm_create_group')
    }
    if (participant?.role === 'worker' && participant.member.forked === true) {
      for (const entry of ctx.consume<DispatchToolsCapability>('helmx.dispatch-tools')) {
        const toolNames = entry.impl?.toolNames
        if (!Array.isArray(toolNames)) continue
        for (const name of toolNames) {
          if (typeof name === 'string' && name.length > 0) drop.add(name)
        }
      }
    }
    const nextTools = drop.size > 0 ? turn.tools.filter((t) => !drop.has(t.name)) : turn.tools
    const toolsChanged = nextTools.length !== turn.tools.length

    let sectionText: string | undefined
    if (activeCoordGroup !== undefined) {
      sectionText = activeSwarmGroupCoordinatorSection(activeCoordGroup.id, {
        skillAvailable: await isSwarmSkillAllowed(ctx, conv.profileId),
      })
    } else if (participant?.role === 'worker') {
      sectionText = activeSwarmGroupWorkerSection(
        participant.group.id,
        participant.member.name,
        participant.member.access,
        participant.member.isolation,
        participant.member.forked === true,
      )
    }

    if (!toolsChanged && sectionText === undefined) return
    return {
      action: 'transform',
      value: {
        ...turn,
        ...(toolsChanged ? { tools: nextTools } : {}),
        ...(sectionText !== undefined ? { sections: [...turn.sections, { id: ACTIVE_SWARM_GROUP_SECTION_ID, text: sectionText }] } : {}),
      },
    }
  })

  ctx.hook.onTurnSettled(async (payload) => {
    if (!isActive()) return
    const conv = payload.conversation
    if (groups.findActiveGroupByCoordinator(conv.id) !== undefined) {
      await groups.onCoordinatorTurnSettled(conv.id)
    }

    const participant = groups.findGroupByParticipant(conv.id)
    if (participant?.role !== 'worker') return
    if (!readConversationOrUndefined(conv.id)?.tags.includes(WORKER_TAG)) return

    const { group, member } = participant
    settlingWorkers.set(conv.id, (settlingWorkers.get(conv.id) ?? 0) + 1)
    try {
      const lastReplySummary = await collectMemberLastReplySummary(ctx.host, conv.id)
      const still = groups.findGroupByParticipant(conv.id)
      if (
        still?.role !== 'worker' ||
        still.group.id !== group.id ||
        still.member.name !== member.name ||
        !readConversationOrUndefined(conv.id)?.tags.includes(WORKER_TAG)
      ) {
        return
      }
      await groups.onMemberTurnSettled({
        groupId: group.id,
        memberName: member.name,
        conversationId: conv.id,
        completionSeq: conv.completionSeq,
        outcome: payload.outcome,
        ...(payload.error !== undefined ? { error: payload.error } : {}),
        lastReplySummary,
      })
    } finally {
      const remaining = (settlingWorkers.get(conv.id) ?? 1) - 1
      if (remaining === 0) settlingWorkers.delete(conv.id)
      else settlingWorkers.set(conv.id, remaining)
    }
  })
}
