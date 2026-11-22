/**
 * Pure derivation for the builtin:swarm right workbench panel (single board, Fast Refresh compliant).
 */
import type { ConversationSummary } from '@helmx/protocol'
import {
  boardProgressOf,
  resolveMemberActivity,
  resolveMemberWorktree,
  sortBoardMembersForDisplay,
  type BoardMemberView,
  type BoardPost,
  type BoardViewDoc,
  type MemberActivity,
  type WorktreeHandoffSnapshot,
} from './board-model.ts'
import { extractMemberTimingFields } from './model-timing.ts'

export type SwarmPanelStatus = 'running' | 'attention' | 'completed'

export interface SwarmPanelMemberRow {
  name: string
  conversationId: number
  profileId: string
  access: BoardMemberView['access']
  liveState: BoardMemberView['liveState']
  lifecycle: BoardMemberView['lifecycle']
  model?: string
  worktreeId?: string
  latestActivity: MemberActivity | undefined
  worktree: WorktreeHandoffSnapshot | undefined
  doing?: string
  createdAt: number
  archivedAt?: number
  runDurationMs?: number
  runStartedAt?: number
  pendingAskSince?: number
  pendingAskCount?: number
  turnCount?: number
}

export interface SwarmPanelModel {
  status: SwarmPanelStatus
  headlineText: string
  headlineTone: BoardViewDoc['headline']['tone']
  objective: string | undefined
  rows: SwarmPanelMemberRow[]
  recentPosts: BoardPost[]
  progress: { done: number; total: number }
  retainedWorktrees: BoardViewDoc['group']['retainedWorktrees']
}

export function resolveSwarmPanelStatus(view: BoardViewDoc): SwarmPanelStatus {
  if (view.group.status === 'closed') return 'completed'
  const attention =
    view.headline.kind === 'blocker' ||
    view.headline.kind === 'stall' ||
    view.headline.kind === 'unmerged' ||
    view.members.some((m) => m.lifecycle === 'active' && (m.liveState === 'blocked' || m.liveState === 'error'))
  return attention ? 'attention' : 'running'
}

export function buildSwarmPanelModel(
  view: BoardViewDoc,
  conversations: ReadonlyArray<ConversationSummary>,
  options: { recentLimit?: number | null } = {},
): SwarmPanelModel {
  const recentLimit = options.recentLimit === undefined ? 6 : options.recentLimit
  const summaryById = new Map(conversations.map((c) => [c.id, c]))

  const rows: SwarmPanelMemberRow[] = sortBoardMembersForDisplay(view.members).map((member) => {
    const summary = summaryById.get(member.conversationId)
    const doing = summary?.doing?.trim() || undefined
    return {
      name: member.name,
      conversationId: member.conversationId,
      profileId: member.profileId,
      access: member.access,
      liveState: member.liveState,
      lifecycle: member.lifecycle,
      ...(member.model !== undefined ? { model: member.model } : {}),
      ...(member.worktreeId !== undefined ? { worktreeId: member.worktreeId } : {}),
      latestActivity: resolveMemberActivity(view.posts, member.name),
      worktree: member.worktreeId !== undefined ? resolveMemberWorktree(view.posts, member) : undefined,
      ...(doing !== undefined ? { doing } : {}),
      createdAt: member.createdAt,
      ...(member.archivedAt !== undefined ? { archivedAt: member.archivedAt } : {}),
      ...extractMemberTimingFields(member, summary, view.group.status),
    }
  })

  const sortedDesc = [...view.posts].sort((a, b) => b.seq - a.seq)
  const recentPosts = (recentLimit !== null ? sortedDesc.slice(0, recentLimit) : sortedDesc).reverse()

  return {
    status: resolveSwarmPanelStatus(view),
    headlineText: view.headline.text,
    headlineTone: view.headline.tone,
    objective: view.group.objective,
    rows,
    recentPosts,
    progress: boardProgressOf(view.members),
    retainedWorktrees: view.group.retainedWorktrees,
  }
}
