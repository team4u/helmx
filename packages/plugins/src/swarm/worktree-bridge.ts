/**
 * Cross-plugin bridge between builtin:swarm and builtin:worktree.
 */
import { HelmxError, type HelmxPluginContext } from '@helmx/protocol'
import { WORKTREE_PLUGIN_ID, type WorktreeInspectResult } from '../contracts.js'
import type { GroupMemberState, RetainedWorktreeInfo, UncleanedWorktreeInfo, WorktreeHandoffSnapshot } from './contracts.js'

export { WORKTREE_PLUGIN_ID }

export interface CheckedMemberWorktree {
  member: GroupMemberState
  worktreeId: string
  inspected: WorktreeInspectResult
  unmergedCommits: number
  isDirty: boolean
}

export const isIgnorableWorktreeError = (err: unknown): boolean =>
  err instanceof HelmxError && (err.code === 'not_found' || err.code === 'plugin_disabled' || err.code === 'unknown_action')

export const isUsageUnverifiableWorktreeError = (err: unknown): boolean =>
  err instanceof HelmxError && err.code === 'worktree_usage_unverifiable'

export function extractChangedFilesPreview(inspected: WorktreeInspectResult, maxItems = 20): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (file: string): void => {
    const clean = file.trim()
    if (clean && !seen.has(clean)) {
      seen.add(clean)
      if (out.length < maxItems) out.push(clean)
    }
  }
  for (const rawLine of inspected.dirtyFiles) push(rawLine.length > 3 ? rawLine.slice(3) : rawLine)
  if (typeof inspected.diffStat === 'string') {
    for (const line of inspected.diffStat.split('\n')) {
      const pipeIdx = line.indexOf(' | ')
      if (pipeIdx > 0) push(line.slice(0, pipeIdx))
    }
  }
  return out
}

export async function inspectManagedWorktree(
  ctx: HelmxPluginContext,
  worktreeId: string,
  signal?: AbortSignal,
): Promise<WorktreeInspectResult> {
  return (await ctx.host.invokeAction(
    WORKTREE_PLUGIN_ID,
    'inspect_worktree',
    { worktreeId, diff: false },
    signal ? { signal } : undefined,
  )) as WorktreeInspectResult
}

export const toWorktreeHandoffSnapshot = (worktreeId: string, inspected: WorktreeInspectResult): WorktreeHandoffSnapshot => ({
  worktreeId,
  ...(inspected.currentBranch !== undefined ? { branch: inspected.currentBranch } : {}),
  ...(inspected.commitsAhead !== undefined ? { commitsAhead: inspected.commitsAhead } : {}),
  dirtyCount: inspected.dirtyFileCount,
  changedFilesPreview: extractChangedFilesPreview(inspected),
})

export const toRetainedWorktreeInfo = (
  memberName: string,
  nodeId: string,
  worktreeId: string,
  inspected: WorktreeInspectResult,
  unmergedCommits: number,
): RetainedWorktreeInfo => ({
  memberName,
  nodeId,
  worktreeId,
  branch: inspected.currentBranch ?? inspected.record.branch,
  path: inspected.record.path,
  commitsAhead: unmergedCommits,
})

export async function checkMemberWorktree(
  ctx: HelmxPluginContext,
  member: GroupMemberState,
  signal?: AbortSignal,
): Promise<CheckedMemberWorktree | undefined> {
  if (member.worktreeId === undefined) return undefined
  const inspected = await inspectManagedWorktree(ctx, member.worktreeId, signal)
  const unmergedCommits = inspected.exists ? (inspected.unmergedCommits ?? inspected.commitsAhead ?? 0) : 0
  return { member, worktreeId: member.worktreeId, inspected, unmergedCommits, isDirty: inspected.exists && inspected.dirtyFileCount > 0 }
}

export async function releaseWorktreeHoldById(
  ctx: HelmxPluginContext,
  holdId: string,
  worktreeId: string,
  signal?: AbortSignal,
): Promise<void> {
  await ctx.host.invokeAction(WORKTREE_PLUGIN_ID, 'release_worktree_hold', { worktreeId, holdId }, signal ? { signal } : undefined)
}

export const releaseWorktreeHold = (
  ctx: HelmxPluginContext,
  groupId: string,
  memberName: string,
  worktreeId: string,
  signal?: AbortSignal,
): Promise<void> => releaseWorktreeHoldById(ctx, `${groupId}:${memberName}`, worktreeId, signal)

export async function cleanupManagedWorktree(
  ctx: HelmxPluginContext,
  worktreeId: string,
  opts: { force?: boolean; allowUnverifiedUsage?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  await ctx.host.invokeAction(
    WORKTREE_PLUGIN_ID,
    'cleanup_worktree',
    {
      worktreeId,
      deleteBranch: true,
      ...(opts.force === true ? { force: true } : {}),
      ...(opts.allowUnverifiedUsage === true ? { allowUnverifiedUsage: true } : {}),
    },
    opts.signal ? { signal: opts.signal } : undefined,
  )
}

/** Settle member worktree: cleanup first (without pre-releasing hold so failures never leak holds), or release hold when retaining/falling back on usage_unverifiable. */
export async function settleMemberWorktree(
  ctx: HelmxPluginContext,
  groupId: string,
  item: CheckedMemberWorktree,
  opts: {
    keepWorktree: boolean
    force: boolean
    allowUnverifiedUsage?: boolean
    cleanupCleanWhenKeeping?: boolean
    signal?: AbortSignal
  },
): Promise<{ retained?: RetainedWorktreeInfo; uncleaned?: UncleanedWorktreeInfo }> {
  if (!item.inspected.exists) {
    await releaseWorktreeHold(ctx, groupId, item.member.name, item.worktreeId, opts.signal)
    return {}
  }
  if (opts.keepWorktree && (item.isDirty || item.unmergedCommits > 0)) {
    await releaseWorktreeHold(ctx, groupId, item.member.name, item.worktreeId, opts.signal)
    return {
      retained: toRetainedWorktreeInfo(item.member.name, item.member.nodeId, item.worktreeId, item.inspected, item.unmergedCommits),
    }
  }
  if (!opts.keepWorktree || opts.cleanupCleanWhenKeeping === true) {
    try {
      await cleanupManagedWorktree(ctx, item.worktreeId, {
        force: opts.force,
        allowUnverifiedUsage: opts.allowUnverifiedUsage,
        signal: opts.signal,
      })
      return {}
    } catch (err) {
      if (isUsageUnverifiableWorktreeError(err)) {
        await releaseWorktreeHold(ctx, groupId, item.member.name, item.worktreeId, opts.signal)
        return {
          uncleaned: {
            memberName: item.member.name,
            nodeId: item.member.nodeId,
            worktreeId: item.worktreeId,
            branch: item.inspected.currentBranch ?? item.inspected.record.branch,
            path: item.inspected.record.path,
            reason: 'usage_unverifiable',
          },
        }
      }
      throw err
    }
  }
  await releaseWorktreeHold(ctx, groupId, item.member.name, item.worktreeId, opts.signal)
  return {}
}
