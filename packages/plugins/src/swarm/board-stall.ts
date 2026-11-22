/**
 * builtin:swarm pure self-healing & 0-token quiescence [stall] guard:
 * - At-most-once silent-exit nudge -> fallback [blocker];
 * - 6-condition group quiescence guard with 3-way root-cause attribution.
 */
import { escapeXml } from '@helmx/protocol'
import type { BoardPost, CollabGroupRecord, GroupMemberState, MemberLiveState } from './contracts.js'

export type SilentExitAction =
  | { kind: 'none' }
  | { kind: 'nudge'; taskSeq: number; prompt: string }
  | { kind: 'fallback_blocker'; taskSeq: number; body: string }

export function evaluateSilentExit(
  group: CollabGroupRecord,
  member: GroupMemberState,
  lastReplySummary: string,
): SilentExitAction {
  const taskSeq = member.lastWakeTaskSeq
  if (
    member.lifecycle !== 'active' ||
    member.pendingWakeupSeq > member.readCursorSeq ||
    taskSeq === undefined ||
    (member.lastPostSeq ?? 0) >= taskSeq
  ) {
    return { kind: 'none' }
  }
  if (member.silentExitNudgeSeq !== taskSeq) {
    return {
      kind: 'nudge',
      taskSeq,
      prompt: [
        `<swarm_silent_exit_nudge group="${escapeXml(group.id)}" worker="${escapeXml(member.name)}" taskSeq="${taskSeq}">`,
        `You finished your turn for board task #${taskSeq} without calling swarm_board_post.`,
        `Peers and the coordinator only see what is posted to the board. Call swarm_board_post now to publish your outcome ('handoff', 'review', 'done', or 'blocker') with refs: [${taskSeq}].`,
        '</swarm_silent_exit_nudge>',
      ].join('\n'),
    }
  }
  const excerpt = lastReplySummary.trim() || '(empty assistant reply)'
  return {
    kind: 'fallback_blocker',
    taskSeq,
    body: `Member @${member.name} exited silently twice without calling swarm_board_post for task #${taskSeq}. Last reply excerpt: ${excerpt}`,
  }
}

export type StallRootCauseKind = 'unwoken_output' | 'unanswered_wakeup' | 'idle_without_done'

export interface StallDiagnosis {
  cause: StallRootCauseKind
  refSeq?: number
  targetMember?: string
  body: string
}

export function diagnoseStallRootCause(group: CollabGroupRecord, posts: readonly BoardPost[]): StallDiagnosis {
  const activeMembers = group.members.filter((m) => m.lifecycle === 'active')
  const activeByName = new Map(activeMembers.map((m) => [m.name, m]))

  const lastWakeSeq = posts.reduce((max, p) => (p.wake && p.kind !== 'stall' ? Math.max(max, p.seq) : max), 0)
  for (let i = posts.length - 1; i >= 0; i -= 1) {
    const post = posts[i]!
    if (post.wake || post.from === 'system') continue
    const unreadTarget = post.resolvedTargets.find((t) => {
      const m = activeByName.get(t)
      return m !== undefined && m.readCursorSeq < post.seq
    })
    if (unreadTarget !== undefined) {
      return {
        cause: 'unwoken_output',
        refSeq: post.seq,
        targetMember: unreadTarget,
        body: `Group stalled: post #${post.seq} from @${post.from} was recorded with wake=false, leaving @${unreadTarget} unwoken.`,
      }
    }
    if (post.seq > lastWakeSeq) {
      const targetHint = post.to.find((t) => t !== 'coordinator')
      return {
        cause: 'unwoken_output',
        refSeq: post.seq,
        ...(targetHint !== undefined ? { targetMember: targetHint.replace(/^@/, '') } : {}),
        body: `Group stalled: passive post #${post.seq} (${post.kind}, wake=false) from @${post.from} did not wake any next actor.`,
      }
    }
  }

  for (const member of activeMembers) {
    const lastPostSeq = member.lastPostSeq ?? 0
    for (let i = posts.length - 1; i >= 0; i -= 1) {
      const post = posts[i]!
      if (!post.wake || post.kind === 'stall' || !post.resolvedTargets.includes(member.name)) continue
      if (post.seq <= member.readCursorSeq && lastPostSeq < post.seq) {
        return {
          cause: 'unanswered_wakeup',
          refSeq: post.seq,
          targetMember: member.name,
          body: `Group stalled: @${member.name} read wakeup #${post.seq} (${post.kind}) without publishing a follow-up swarm_board_post.`,
        }
      }
      break
    }
  }

  const memberList = activeMembers.map((m) => `@${m.name}`).join(', ')
  const headHint = group.headSeq > 0 ? ` (latest #${group.headSeq})` : ''
  return {
    cause: 'idle_without_done',
    ...(group.headSeq > 0 ? { refSeq: group.headSeq } : {}),
    ...(activeMembers[0] !== undefined ? { targetMember: activeMembers[0].name } : {}),
    body: `Group stalled: all active members (${memberList}) and coordinator are idle${headHint}, but no final [done] delivery has been posted.`,
  }
}

export interface MemberRuntimeSnapshot {
  name: string
  liveState: MemberLiveState
  completionSeq: number
  isSettling: boolean
  lastWakeCompletionSeq?: number
}

export interface QuiescenceCheckInput {
  group: CollabGroupRecord
  posts: readonly BoardPost[]
  hasInflightDeliveries: boolean
  coordinatorState: { exists: boolean; liveState: MemberLiveState }
  memberSnapshots: readonly MemberRuntimeSnapshot[]
}

export function computeStallWatermark(
  headSeq: number,
  memberSnapshots: readonly Pick<MemberRuntimeSnapshot, 'name' | 'completionSeq'>[],
): string {
  const digest = [...memberSnapshots]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => `${m.name}:${m.completionSeq}`)
    .join(',')
  return `${headSeq}|${digest}`
}

export function evaluateGroupQuiescence(
  input: QuiescenceCheckInput,
): { shouldEmitStall: false } | { shouldEmitStall: true; diagnosis: StallDiagnosis; nextWatermarkAfterPost: string } {
  const { group, posts, hasInflightDeliveries, coordinatorState, memberSnapshots } = input
  const activeMembers = group.members.filter((m) => m.lifecycle === 'active')

  if (group.status !== 'active' || group.coordinatorDetached === true || activeMembers.length === 0 || group.headSeq === 0) {
    return { shouldEmitStall: false }
  }
  if (hasInflightDeliveries) return { shouldEmitStall: false }

  const snapByName = new Map(memberSnapshots.map((s) => [s.name, s]))
  for (const m of activeMembers) {
    if (m.pendingWakeupSeq > m.readCursorSeq) return { shouldEmitStall: false }
    const snap = snapByName.get(m.name)
    if (
      snap === undefined ||
      snap.isSettling ||
      snap.liveState === 'working' ||
      snap.liveState === 'blocked' ||
      snap.liveState === 'missing' ||
      (snap.lastWakeCompletionSeq !== undefined && snap.completionSeq <= snap.lastWakeCompletionSeq)
    ) {
      return { shouldEmitStall: false }
    }
  }

  if (
    !coordinatorState.exists ||
    coordinatorState.liveState === 'working' ||
    coordinatorState.liveState === 'blocked' ||
    group.coordinatorPendingSeq > group.coordinatorNotifiedSeq
  ) {
    return { shouldEmitStall: false }
  }

  const latestPost = posts[posts.length - 1]
  if (
    latestPost === undefined ||
    latestPost.kind === 'blocker' ||
    latestPost.kind === 'stall' ||
    (latestPost.kind === 'done' && group.coordinatorPendingSeq >= latestPost.seq)
  ) {
    return { shouldEmitStall: false }
  }

  const activeSnaps = activeMembers.map((m) => snapByName.get(m.name)!)
  if (group.lastStallWatermark === computeStallWatermark(group.headSeq, activeSnaps)) {
    return { shouldEmitStall: false }
  }

  return {
    shouldEmitStall: true,
    diagnosis: diagnoseStallRootCause(group, posts),
    nextWatermarkAfterPost: computeStallWatermark(group.headSeq + 1, activeSnaps),
  }
}
