/**
 * Pure derivation for the builtin:swarm right workbench panel (zero React/DOM
 * dependencies, Fast Refresh compliant).
 *
 * Maps a live or fallback `BoardViewDoc` into the natural orchestration-card
 * model: one status in { running, attention, completed }, member rows with one
 * honest sentence of latest progress plus optional worktree branch facts, the
 * recent handoff timeline, and retained branches after close.
 */
import type { ConversationSummary } from '@helmx/protocol'
import {
  boardProgressOf,
  resolveMemberActivity,
  resolveMemberWorktree,
  sortBoardMembersForDisplay,
  type BoardChannelInfo,
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
  /** Live host fact from the conversation summary (never fabricated). */
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
  channels: BoardChannelInfo[]
  rows: SwarmPanelMemberRow[]
  recentPosts: BoardPost[]
  progress: { done: number; total: number }
  retainedWorktrees: BoardViewDoc['group']['retainedWorktrees']
}

/** Map board facts to the natural panel status (never fabricates "running"). */
export function resolveSwarmPanelStatus(view: BoardViewDoc): SwarmPanelStatus {
  if (view.group.status === 'closed') return 'completed'
  const hasAttention =
    view.headline.kind === 'blocker' ||
    view.headline.kind === 'stall' ||
    view.headline.kind === 'unmerged' ||
    view.members.some((m) => m.lifecycle === 'active' && (m.liveState === 'blocked' || m.liveState === 'error'))
  return hasAttention ? 'attention' : 'running'
}

export function buildSwarmPanelModel(
  view: BoardViewDoc,
  conversations: ReadonlyArray<ConversationSummary>,
  options: { recentLimit?: number | null; channel?: string } = {},
): SwarmPanelModel {
  const recentLimit = options.recentLimit === undefined ? 6 : options.recentLimit
  const selectedChannel = options.channel
  const summaryById = new Map<number, ConversationSummary>()
  for (const conv of conversations) summaryById.set(conv.id, conv)

  const ordered = sortBoardMembersForDisplay(view.members)
  const rows: SwarmPanelMemberRow[] = ordered.map((member) => {
    const summary = summaryById.get(member.conversationId)
    const doing = summary?.doing !== undefined && summary.doing.trim() !== '' ? summary.doing.trim() : undefined
    const timing = extractMemberTimingFields(member, summary, view.group.status)
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
      ...timing,
    }
  })

  const filteredPosts =
    selectedChannel !== undefined && selectedChannel !== '' && selectedChannel !== 'all'
      ? view.posts.filter((p) => p.channel === selectedChannel)
      : view.posts
  const sortedDesc = [...filteredPosts].sort((a, b) => b.seq - a.seq)
  const recentPosts = (recentLimit !== null ? sortedDesc.slice(0, recentLimit) : sortedDesc).reverse()
  const channels = view.group.channels.filter((c) => c.archived !== true)

  return {
    status: resolveSwarmPanelStatus(view),
    headlineText: view.headline.text,
    headlineTone: view.headline.tone,
    objective: view.group.objective,
    channels,
    rows,
    recentPosts,
    progress: boardProgressOf(view.members),
    retainedWorktrees: view.group.retainedWorktrees,
  }
}
