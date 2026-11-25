/** Pure browser-safe DTO types and enum constants shared by builtin:swarm client and server surfaces. */
import type { LocalizedText } from '@helmx/protocol/browser'

export const BOARD_POST_KINDS = ['brief', 'handoff', 'review', 'comment', 'blocker', 'done', 'stall'] as const
export type BoardPostKind = (typeof BOARD_POST_KINDS)[number]
export const MEMBER_LIVE_STATES = ['idle', 'working', 'blocked', 'done', 'error', 'missing'] as const
export type MemberLiveState = (typeof MEMBER_LIVE_STATES)[number]

export type WorkerAccess = 'readwrite' | 'readonly'
export type WorkerIsolation = 'inherit' | 'worktree'
export type CollabGroupStatus = 'active' | 'closed'
export interface SwarmWorkerPointer { conversationId: number; coordinatorConversationId: number; profileId: string; groupId: string; name: string; createdAt: number }
export interface CollabGroupSummary {
  id: string; title: string; coordinatorConversationId: number; status: CollabGroupStatus
  coordinatorDetached?: boolean; activeWorkerCount: number; headSeq: number; createdAt: number; updatedAt: number; closedAt?: number
}
export interface SwarmIndexDoc { workers: SwarmWorkerPointer[]; groups: CollabGroupSummary[] }
export interface InflightWakeupIntent { requestId: string; fromSeq: number; toSeq: number; baseCompletionSeq: number; attempt?: number }
export interface InflightNudgeIntent { requestId: string; taskSeq: number; baseCompletionSeq: number; attempt?: number }
export interface InflightReportIntent { requestId: string; fromSeq: number; toSeq: number; baseCompletionSeq: number; hadActiveWorkers: boolean; attempt?: number }
export interface UnansweredRecoveryState { toSeq: number; nextAttempt: number; exhausted?: boolean }
export interface GroupMemberState {
  name: string; conversationId: number; profileId: string; access: WorkerAccess; isolation: WorkerIsolation
  nodeId: string; cwd: string; worktreeId?: string; lifecycle: 'active' | 'archived'
  readCursorSeq: number; pendingWakeupSeq: number; lastPostSeq?: number; lastWakeTaskSeq?: number
  silentExitNudgeSeq?: number; lastWakeCompletionSeq?: number
  lastOutboundEdge?: { seq: number; to: string[]; kind: BoardPostKind }
  dispatchKey?: string; briefPostSeq?: number; inflightWakeup?: InflightWakeupIntent; inflightNudge?: InflightNudgeIntent
  wakeupRecovery?: UnansweredRecoveryState; nudgeRecovery?: UnansweredRecoveryState
  runDurationMs?: number; turnCount?: number; createdAt: number; archivedAt?: number
}
export interface RetainedWorktreeInfo { memberName: string; nodeId: string; worktreeId: string; branch: string; path: string; commitsAhead: number }
export interface UncleanedWorktreeInfo { memberName: string; nodeId: string; worktreeId: string; branch: string; path: string; reason: 'usage_unverifiable' }
export interface WorktreeHandoffSnapshot { worktreeId: string; branch?: string; commitsAhead?: number; dirtyCount: number; changedFilesPreview: string[] }
export interface BoardPost {
  seq: number; groupId: string; from: string; to: string[]; resolvedTargets: string[]; wake: boolean
  kind: BoardPostKind; refs: number[]; body: string; idempotencyKey?: string; worktreeSnapshot?: WorktreeHandoffSnapshot; createdAt: number
}
export interface BoardBadgeEntry { groupId: string; coordinatorConversationId: number; count: number; tone: 'accent' | 'warn' | 'neutral'; footerText?: LocalizedText }
export interface BoardBadgesDoc { byConversation: Record<string, BoardBadgeEntry> }
export interface BoardViewHeadline { text: string; tone: 'info' | 'warn' | 'err' | 'ok'; kind: 'normal' | 'stall' | 'blocker' | 'unmerged' | 'closed'; targetMember?: string; refSeq?: number }
export interface MemberLiveSnapshot { liveState: MemberLiveState; model?: string; runDurationMs?: number; runStartedAt?: number; pendingAskSince?: number; turnCount?: number }
export type BoardViewMember = GroupMemberState & MemberLiveSnapshot
export interface BoardViewDoc {
  group: CollabGroupSummary & { objective?: string; retainedWorktrees?: RetainedWorktreeInfo[]; closeSummary?: string }
  headline: BoardViewHeadline; members: BoardViewMember[]; posts: BoardPost[]; activeWorkingMembers: string[]
}
