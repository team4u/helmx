/**
 * builtin:swarm 动作与模型工具单点声明入口（按群组 / 成员 / 黑板子模块解耦实现）：
 * - 12 个业务动作全部通过 `exposeAsTool: { name: 'swarm_*', description, replay: 'safe', formatOutput }`
 *   与 `presentationMetaSchema` / `projectPresentationMeta` 单点声明（消除 12 对 `ctx.tool` + `ctx.action`
 *   重复注册，五端返回裸业务对象且模型读取精简文本摘要、UI 持久详情仅收有界轻量 presentationMeta）；
 * - 2 个 UI 补全动作声明 `visibility: 'ui'`，允许 Web 补全调用而拒绝 `run_action` / Workflow DSL / CLI。
 */
import type { HelmxPluginContext, PluginActionContext } from '@helmx/protocol'
import {
  COORDINATOR_SCOPE,
  HISTORY_PARTICIPANT_SCOPE,
  PARTICIPANT_SCOPE,
  type BoardPost,
  type BoardViewDoc,
  type SwarmCoordinator,
} from './contracts.js'
import {
  abortWorkerOutputSchema,
  archiveWorkerInputSchema,
  archiveWorkerOutputSchema,
  boardPostInputSchema,
  boardPostOutputSchema,
  boardReadInputSchema,
  boardReadOutputSchema,
  boardStatusInputSchema,
  boardStatusOutputSchema,
  closeGroupInputSchema,
  closeGroupOutputSchema,
  completerInputSchema,
  completerOutputSchema,
  createGroupInputSchema,
  createGroupOutputSchema,
  dispatchInputSchema,
  dispatchWorkerOutputSchema,
  inspectWorkerOutputSchema,
  manageChannelInputSchema,
  manageChannelOutputSchema,
  swarmToolPresentationMetaSchema,
  switchModelInputSchema,
  switchModelOutputSchema,
  updateGroupInputSchema,
  updateGroupOutputSchema,
  workerIdInputSchema,
} from './action-schemas.js'
import {
  checkCoordinatorEligibility,
  createGroupHandlers,
  createSwarmDispatchGuard,
  ensureCoordinatorGroup,
  type EnsureCoordinatorGroupInput,
} from './actions-group.js'
import {
  createWorkerHandlers,
  type DispatchInput,
  type InspectWorkerResult,
} from './actions-worker.js'
import { createBoardHandlers } from './actions-board.js'
import {
  assertWorkerConversationId,
  assertWorkerCwd,
} from '../entry-text.js'

export {
  assertWorkerConversationId,
  assertWorkerCwd,
  checkCoordinatorEligibility,
  ensureCoordinatorGroup,
  type DispatchInput,
  type EnsureCoordinatorGroupInput,
}

function boundedMetaText(value: string, maxChars: number): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed
}

function formatBoardPostLine(p: BoardPost): string {
  const wt =
    p.worktreeSnapshot !== undefined
      ? ` [worktree ${p.worktreeSnapshot.branch ?? p.worktreeSnapshot.worktreeId}: dirty=${p.worktreeSnapshot.dirtyCount}${p.worktreeSnapshot.commitsAhead !== undefined ? `, +${p.worktreeSnapshot.commitsAhead}` : ''}]`
      : ''
  const refs = p.refs.length > 0 ? ` refs=${p.refs.map((r) => `#${r}`).join(',')}` : ''
  return `#${p.seq} [${p.channel}/${p.kind}] ${p.from} -> ${p.to.join(', ')}${refs}${wt}: ${p.body}`
}

function formatBoardStatusSummary(view: BoardViewDoc): string {
  const lines: string[] = [
    `Group "${view.group.title}" (${view.group.id}, status=${view.group.status}, headSeq=${view.group.headSeq})`,
    `Headline [${view.headline.tone}/${view.headline.kind}]: ${view.headline.text}`,
  ]
  if (view.activeWorkingMembers.length > 0) {
    lines.push(`Active working members: ${view.activeWorkingMembers.map((m) => `@${m}`).join(', ')}`)
  }
  if (view.members.length > 0) {
    lines.push(
      `Members (${view.members.length}): ${view.members
        .map(
          (m) =>
            `@${m.name} (#${m.conversationId}, ${m.lifecycle}, ${m.liveState}${m.model !== undefined ? `, model=${m.model}` : ''}, cursor=${m.readCursorSeq}/${m.pendingWakeupSeq}${m.worktreeId !== undefined ? `, worktree=${m.worktreeId}` : ''})`,
        )
        .join('; ')}`,
    )
  }
  if (view.group.retainedWorktrees !== undefined && view.group.retainedWorktrees.length > 0) {
    lines.push(
      `Retained worktrees: ${view.group.retainedWorktrees
        .map((w) => `@${w.memberName}:${w.branch} (+${w.commitsAhead}, ${w.nodeId !== 'local' ? `node=${w.nodeId}, ` : ''}${w.path})`)
        .join('; ')}`,
    )
  }
  if (view.posts.length > 0) {
    const recent = view.posts.slice(-5).map((p) => formatBoardPostLine(p))
    lines.push(`Recent posts (${recent.length}/${view.posts.length}):\n${recent.join('\n')}`)
  }
  return lines.join('\n')
}

function makeToolCallKey(
  conversationId: number | undefined,
  callId: string | undefined,
): string | undefined {
  if (conversationId === undefined || callId === undefined || callId.trim() === '') return undefined
  return `${conversationId}:${callId}`
}

function formatInspectWorkerSummary(res: InspectWorkerResult): string {
  const header = `Member @${res.name} (#${res.conversationId}, group=${res.groupId}, profile=${res.profileId}, status=${res.status}${res.worktreeId !== undefined ? `, worktree=${res.worktreeId}` : ''}${res.doing !== null ? `, doing="${res.doing}"` : ''}, artifacts=${res.artifacts.length})`
  if (res.recentEntries.length === 0) return header
  const entries = res.recentEntries.slice(-5).map((e) => `- [${e.kind}] ${e.text}`)
  return `${header}\nRecent timeline (${entries.length}/${res.recentEntries.length}):\n${entries.join('\n')}`
}

export function registerSwarmActions(
  ctx: HelmxPluginContext,
  coordinator: SwarmCoordinator,
): void {
  const dispatchGuard = createSwarmDispatchGuard()
  const { createGroup, updateGroup, manageChannel, closeGroup } = createGroupHandlers(ctx, coordinator, dispatchGuard)
  const { dispatchWorker, abortWorker, switchWorkerModel, inspectWorker, archiveWorker } =
    createWorkerHandlers(ctx, coordinator, dispatchGuard)
  const { boardPost, boardRead, boardStatus, completeBoardMembers, completeBoardChannels } =
    createBoardHandlers(ctx, coordinator)

  // ------------------------------------------------------------------
  // 12 个业务动作：单点声明（HTTP / CLI / Workflow / Web + exposeAsTool 直投 swarm_* 模型工具）
  // ------------------------------------------------------------------
  ctx.action({
    id: 'create_group',
    description: 'Create an active swarm collaboration group on a top-level conversation.',
    promptSnippet:
      'Start a coordinated multi-agent peer blackboard collaboration (`swarm_create_group`) when dividing non-overlapping work across multiple concurrent peer agents.',
    promptGuidelines: [
      'Use swarm_create_group only in a top-level human conversation when dynamic parallel division, live peer handoffs, or writer/reviewer verification warrants a peer squad.',
      'Do not use swarm_create_group for small sequential tasks, single subtasks, or fixed deterministic pipelines (use subagent / SubagentWorkflow when available).',
      'Once active, call load_skill({ skillId: "swarm" }) when available before dispatching workers via swarm_dispatch_worker.',
    ],
    cli: { command: ['swarm', 'create-group'], description: 'Create an active swarm collaboration group' },
    inputSchema: createGroupInputSchema,
    outputSchema: createGroupOutputSchema,
    exposeAsTool: {
      name: 'swarm_create_group',
      description:
        'Start an active peer swarm collaboration board on the current top-level human conversation, tagging it swarm-coordinator and unlocking squad tools next step. Use for complex tasks needing concurrent role division, live peer handoffs, or writer/verifier review loops; skip for single subtasks or fixed deterministic pipelines.',
      replay: 'safe',
      formatOutput: (_input, res) => `Created swarm group "${res.group.title}" (${res.groupId}).`,
    },
    presentationMetaSchema: swarmToolPresentationMetaSchema,
    projectPresentationMeta: (_input, res) => {
      const groupTitle = boundedMetaText(res.group.title, 120)
      return { groupId: res.groupId, ...(groupTitle !== undefined ? { groupTitle } : {}) }
    },
    handler: (input: Parameters<typeof createGroup>[0], context: PluginActionContext) =>
      createGroup(input, context.conversationId, makeToolCallKey(context.conversationId, context.callId)),
  })

  ctx.action({
    id: 'update_group',
    description: 'Update swarm collaboration group metadata.',
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'update-group'], description: 'Update swarm collaboration group metadata' },
    inputSchema: updateGroupInputSchema,
    outputSchema: updateGroupOutputSchema,
    exposeAsTool: {
      name: 'swarm_update_group',
      description: 'Update the active swarm collaboration group title or objective.',
      replay: 'safe',
      formatOutput: (_input, res) => `Updated swarm group "${res.group.title}" (${res.groupId}).`,
    },
    presentationMetaSchema: swarmToolPresentationMetaSchema,
    projectPresentationMeta: (_input, res) => {
      const groupTitle = boundedMetaText(res.group.title, 120)
      return { groupId: res.groupId, ...(groupTitle !== undefined ? { groupTitle } : {}) }
    },
    handler: (input: Parameters<typeof updateGroup>[0], context: PluginActionContext) => updateGroup(input, context.conversationId),
  })

  ctx.action({
    id: 'manage_channel',
    description: 'Create, subscribe, unsubscribe, or archive swarm collaboration group subchannels.',
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'channel'], description: 'Manage swarm collaboration group subchannels' },
    inputSchema: manageChannelInputSchema,
    outputSchema: manageChannelOutputSchema,
    exposeAsTool: {
      name: 'swarm_manage_channel',
      description:
        'Create, subscribe, unsubscribe, or archive subchannels in the active swarm collaboration group (main cannot be unsubscribed or archived).',
      replay: 'safe',
      formatOutput: (input, res) => {
        const memberPart = input.member !== undefined && input.member.trim() !== '' ? ` for @${input.member.trim()}` : ''
        return `Channel #${input.channel.trim()} (${input.op}${memberPart}) updated in group ${res.groupId}.`
      },
    },
    presentationMetaSchema: swarmToolPresentationMetaSchema,
    projectPresentationMeta: (_input, res) => ({ groupId: res.groupId }),
    handler: (input: Parameters<typeof manageChannel>[0], context: PluginActionContext) => manageChannel(input, context.conversationId),
  })

  ctx.action({
    id: 'dispatch_worker',
    description: 'Recruit a named peer worker role into an active swarm collaboration group.',
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'dispatch-worker'], description: 'Recruit a named swarm peer worker' },
    inputSchema: dispatchInputSchema,
    outputSchema: dispatchWorkerOutputSchema,
    exposeAsTool: {
      name: 'swarm_dispatch_worker',
      description:
        'Recruit a named peer role into the active swarm collaboration group with optional worktree isolation and clean-anchor conversation forking. Starts the worker asynchronously in the background and returns immediately.',
      replay: 'safe',
      formatOutput: (_input, res) =>
        `Dispatched @${res.name} (#${res.workerConversationId}) in group ${res.groupId}${res.worktreeId !== undefined ? `, worktree=${res.worktreeId}` : ''}, brief=#${res.postSeq}.`,
    },
    presentationMetaSchema: swarmToolPresentationMetaSchema,
    projectPresentationMeta: (_input, res) => ({
      groupId: res.groupId,
      memberName: res.name,
      workerConversationId: res.workerConversationId,
      seq: res.postSeq,
    }),
    handler: (input: DispatchInput, context: PluginActionContext) =>
      dispatchWorker(
        input,
        context.conversationId,
        context.signal,
        makeToolCallKey(context.conversationId, context.callId),
      ),
  })

  ctx.action({
    id: 'board_post',
    description: 'Publish a structured post to the swarm collaboration board.',
    scope: PARTICIPANT_SCOPE,
    cli: { command: ['swarm', 'board-post'], description: 'Publish a post to the swarm collaboration board' },
    inputSchema: boardPostInputSchema,
    outputSchema: boardPostOutputSchema,
    exposeAsTool: {
      name: 'swarm_board_post',
      description:
        'Publish a structured message on the swarm collaboration board with deterministic target resolution and orthogonal wake control (handoff and done posts from worktree members automatically attach a worktree snapshot).',
      replay: 'safe',
      formatOutput: (_input, res) => {
        const targets = res.post.resolvedTargets.length > 0 ? res.post.resolvedTargets : res.post.to
        return `Posted #${res.post.seq} [${res.post.kind}] in #${res.post.channel} -> ${targets.join(', ')} (wake=${res.post.wake}).`
      },
    },
    presentationMetaSchema: swarmToolPresentationMetaSchema,
    projectPresentationMeta: (_input, res) => ({
      groupId: res.post.groupId,
      postKind: res.post.kind,
      seq: res.post.seq,
    }),
    handler: (input: Parameters<typeof boardPost>[0], context: PluginActionContext) =>
      boardPost(
        input,
        context.conversationId,
        context.signal,
        makeToolCallKey(context.conversationId, context.callId),
      ),
  })

  ctx.action({
    id: 'board_read',
    description: 'Read posts from the swarm collaboration board.',
    idempotent: true,
    scope: HISTORY_PARTICIPANT_SCOPE,
    cli: { command: ['swarm', 'board-read'], description: 'Read posts from the swarm collaboration board' },
    inputSchema: boardReadInputSchema,
    outputSchema: boardReadOutputSchema,
    exposeAsTool: {
      name: 'swarm_board_read',
      description: 'Read swarm collaboration board posts by channel, sinceSeq, or exact seqs.',
      replay: 'safe',
      formatOutput: (_input, res) =>
        res.posts.length === 0
          ? `No matching board posts in ${res.groupId} (headSeq=${res.headSeq}).`
          : `Board ${res.groupId} (headSeq=${res.headSeq}, returned=${res.posts.length}):\n${res.posts.map(formatBoardPostLine).join('\n')}`,
    },
    presentationMetaSchema: swarmToolPresentationMetaSchema,
    projectPresentationMeta: (_input, res) => ({
      groupId: res.groupId,
      seq: res.headSeq,
      postCount: res.posts.length,
    }),
    handler: (input: Parameters<typeof boardRead>[0], context: PluginActionContext) => boardRead(input, context.conversationId),
  })

  ctx.action({
    id: 'board_status',
    description: 'Inspect swarm collaboration group board status, members, and retained worktrees.',
    idempotent: true,
    scope: HISTORY_PARTICIPANT_SCOPE,
    cli: { command: ['swarm', 'board-status'], description: 'Inspect swarm collaboration group board status' },
    inputSchema: boardStatusInputSchema,
    outputSchema: boardStatusOutputSchema,
    exposeAsTool: {
      name: 'swarm_board_status',
      description:
        'Inspect live swarm collaboration group status, member cursors and live states, activeWorkingMembers, and retained worktrees.',
      replay: 'safe',
      formatOutput: (_input, res) => formatBoardStatusSummary(res),
    },
    presentationMetaSchema: swarmToolPresentationMetaSchema,
    projectPresentationMeta: (_input, res) => {
      const groupTitle = boundedMetaText(res.group.title, 120)
      return {
        groupId: res.group.id,
        ...(groupTitle !== undefined ? { groupTitle } : {}),
        seq: res.group.headSeq,
        postCount: res.posts.length,
      }
    },
    handler: (input: { groupId?: string }, context: PluginActionContext) => boardStatus(input, context.conversationId),
  })

  ctx.action({
    id: 'abort_worker',
    description: 'Abort an in-flight swarm worker turn in place while preserving conversation history and worktree hold.',
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'abort-worker'], description: 'Abort an in-flight swarm worker turn in place' },
    inputSchema: workerIdInputSchema,
    outputSchema: abortWorkerOutputSchema,
    exposeAsTool: {
      name: 'swarm_abort_worker',
      description:
        'Stop an in-flight swarm worker turn in place while preserving its conversation history and managed worktree hold for follow-up correction.',
      replay: 'safe',
      formatOutput: (_input, res) =>
        res.aborted
          ? `Aborted @${res.name} (#${res.workerConversationId}).`
          : `Member @${res.name} (#${res.workerConversationId}) was not running.`,
    },
    presentationMetaSchema: swarmToolPresentationMetaSchema,
    projectPresentationMeta: (_input, res) => ({
      workerConversationId: res.workerConversationId,
      memberName: res.name,
      aborted: res.aborted,
    }),
    handler: (input: Parameters<typeof abortWorker>[0], context: PluginActionContext) => abortWorker(input, context.conversationId),
  })

  ctx.action({
    id: 'switch_worker_model',
    description: 'Switch an idle swarm worker conversation to another model in place.',
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'switch-model'], description: 'Switch an idle swarm worker conversation model' },
    inputSchema: switchModelInputSchema,
    outputSchema: switchModelOutputSchema,
    exposeAsTool: {
      name: 'swarm_switch_worker_model',
      description:
        'Switch an idle swarm worker conversation to another model (or tier/<id>) and optional thinking effort in place while preserving its conversation history; pass prompt to immediately post a brief and wake the worker on the new model.',
      replay: 'safe',
      formatOutput: (_input, res) => {
        const effortPart = res.effort !== undefined && res.effort !== '' ? ` (effort=${res.effort})` : ''
        const resumePart = res.postSeq !== undefined ? ` and woke with brief #${res.postSeq}` : ''
        return `Switched @${res.name} (#${res.workerConversationId}) model to ${res.model}${effortPart}${resumePart}.`
      },
    },
    presentationMetaSchema: swarmToolPresentationMetaSchema,
    projectPresentationMeta: (_input, res) => {
      const model = boundedMetaText(res.model, 200)
      return {
        workerConversationId: res.workerConversationId,
        memberName: res.name,
        ...(model !== undefined ? { model } : {}),
        ...(res.postSeq !== undefined ? { seq: res.postSeq } : {}),
      }
    },
    handler: (input: Parameters<typeof switchWorkerModel>[0], context: PluginActionContext) =>
      switchWorkerModel(
        input,
        context.conversationId,
        makeToolCallKey(context.conversationId, context.callId),
      ),
  })

  ctx.action({
    id: 'inspect_worker',
    description: "Read a swarm worker's recent timeline summary, artifact list, and bound worktreeId.",
    idempotent: true,
    scope: PARTICIPANT_SCOPE,
    cli: { command: ['swarm', 'inspect-worker'], description: 'Inspect a swarm worker' },
    inputSchema: workerIdInputSchema,
    outputSchema: inspectWorkerOutputSchema,
    exposeAsTool: {
      name: 'swarm_inspect_worker',
      description: "Read a swarm worker's recent timeline summary, artifact list, and bound worktreeId.",
      replay: 'safe',
      formatOutput: (_input, res) => formatInspectWorkerSummary(res),
    },
    presentationMetaSchema: swarmToolPresentationMetaSchema,
    projectPresentationMeta: (_input, res) => ({
      groupId: res.groupId,
      workerConversationId: res.conversationId,
      memberName: res.name,
    }),
    handler: (input: Parameters<typeof inspectWorker>[0], context: PluginActionContext) => inspectWorker(input, context.conversationId),
  })

  ctx.action({
    id: 'archive_worker',
    description: 'Archive an idle swarm worker: releases worktree holds and swaps swarm-worker tag for swarm-worker-archived.',
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'archive-worker'], description: 'Archive an idle swarm worker' },
    inputSchema: archiveWorkerInputSchema,
    outputSchema: archiveWorkerOutputSchema,
    exposeAsTool: {
      name: 'swarm_archive_worker',
      description: 'Archive an idle swarm worker (verifying worktree merge safety and releasing worktree holds when applicable).',
      replay: 'safe',
      formatOutput: (_input, res) => `Archived worker #${res.workerConversationId}.`,
    },
    presentationMetaSchema: swarmToolPresentationMetaSchema,
    projectPresentationMeta: (_input, res) => ({
      workerConversationId: res.workerConversationId,
      archived: res.archived,
    }),
    handler: (input: Parameters<typeof archiveWorker>[0], context: PluginActionContext) =>
      archiveWorker(input, context.conversationId, context.signal),
  })

  ctx.action({
    id: 'close_group',
    description:
      'Close a swarm collaboration group in full-cleanup mode, retain-branches mode (keepWorktree: true), or force mode (force: true bypasses only the uncommitted/unmerged worktree guard).',
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'close-group'], description: 'Close a swarm collaboration group' },
    inputSchema: closeGroupInputSchema,
    outputSchema: closeGroupOutputSchema,
    exposeAsTool: {
      name: 'swarm_close_group',
      description:
        'Close the swarm collaboration group in full-cleanup mode or retain-branches mode (keepWorktree: true releases holds and preserves modified branches in retainedWorktrees; force: true closes past the uncommitted/unmerged guard, discarding unmerged member worktree content).',
      replay: 'safe',
      formatOutput: (_input, res) =>
        res.retainedWorktrees.length === 0
          ? `Closed swarm group ${res.groupId} cleanly.`
          : `Closed swarm group ${res.groupId}; retained ${res.retainedWorktrees.length} worktree(s) for merge: ${res.retainedWorktrees.map((w) => `@${w.memberName}:${w.branch} (+${w.commitsAhead}${w.nodeId !== 'local' ? `, node=${w.nodeId}` : ''})`).join(', ')}.`,
    },
    presentationMetaSchema: swarmToolPresentationMetaSchema,
    projectPresentationMeta: (_input, res) => ({
      groupId: res.groupId,
      retainedCount: res.retainedWorktrees.length,
    }),
    handler: (input: Parameters<typeof closeGroup>[0], context: PluginActionContext) =>
      closeGroup(input, context.conversationId, context.signal),
  })

  // ------------------------------------------------------------------
  // 2 个 UI 补全动作：visibility: 'ui'（允许 Web 补全调用，拒绝 run_action / Workflow DSL / CLI）
  // ------------------------------------------------------------------
  ctx.action({
    id: 'complete_board_members',
    description: 'List mentionable swarm collaboration board roles for composer @ completion.',
    visibility: 'ui',
    idempotent: true,
    scope: PARTICIPANT_SCOPE,
    inputSchema: completerInputSchema,
    outputSchema: completerOutputSchema,
    handler: (input: { query?: string; conversationId?: number }, context: PluginActionContext) =>
      completeBoardMembers(input, context.conversationId),
  })

  ctx.action({
    id: 'complete_board_channels',
    description: 'List active swarm collaboration board subchannels for composer # completion.',
    visibility: 'ui',
    idempotent: true,
    scope: PARTICIPANT_SCOPE,
    inputSchema: completerInputSchema,
    outputSchema: completerOutputSchema,
    handler: (input: { query?: string; conversationId?: number }, context: PluginActionContext) =>
      completeBoardChannels(input, context.conversationId),
  })
}
