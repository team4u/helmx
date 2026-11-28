/**
 * builtin:swarm single-point action & model-tool declarations (11 business tools + 1 query action + 1 UI completer).
 */
import type { ConversationScope, HelmxPluginContext, JsonSchema, MaybePromise, PluginActionContext } from '@helmx/protocol'
import {
  COORDINATOR_SCOPE,
  HISTORY_PARTICIPANT_SCOPE,
  PARTICIPANT_SCOPE,
  type BoardPost,
  type BoardViewDoc,
  type SwarmCoordinator,
} from './contracts.js'
import * as Schemas from './action-schemas.js'
import {
  checkCoordinatorEligibility,
  createGroupHandlers,
  createSwarmDispatchGuard,
  ensureCoordinatorGroup,
  type EnsureCoordinatorGroupInput,
  type ListGroupSummary,
} from './actions-group.js'
import { createWorkerHandlers, type DispatchInput, type InspectWorkerResult } from './actions-worker.js'
import { createBoardHandlers } from './actions-board.js'

export {
  checkCoordinatorEligibility,
  ensureCoordinatorGroup,
  type DispatchInput,
  type EnsureCoordinatorGroupInput,
  type ListGroupSummary,
}

const boundedText = (v: string, max: number): string | undefined => {
  const t = v.trim()
  return t === '' ? undefined : t.length > max ? t.slice(0, max) : t
}
const callKeyOf = (c: PluginActionContext): string | undefined =>
  c.conversationId !== undefined && c.callId?.trim() ? `${c.conversationId}:${c.callId}` : undefined

function formatBoardPostLine(p: BoardPost): string {
  const wt = p.worktreeSnapshot
    ? ` [worktree ${p.worktreeSnapshot.branch ?? p.worktreeSnapshot.worktreeId}: dirty=${p.worktreeSnapshot.dirtyCount}${p.worktreeSnapshot.commitsAhead !== undefined ? `, +${p.worktreeSnapshot.commitsAhead}` : ''}]`
    : ''
  const refs = p.refs.length > 0 ? ` refs=${p.refs.map((r) => `#${r}`).join(',')}` : ''
  return `#${p.seq} [${p.kind}] ${p.from} -> ${p.to.join(', ')}${refs}${wt}: ${p.body}`
}

function formatBoardStatusSummary(view: BoardViewDoc): string {
  const lines = [
    `Group "${view.group.title}" (${view.group.id}, status=${view.group.status}, headSeq=${view.group.headSeq})`,
    `Headline [${view.headline.tone}/${view.headline.kind}]: ${view.headline.text}`,
  ]
  if (view.activeWorkingMembers.length > 0) {
    lines.push(`Active working members: ${view.activeWorkingMembers.map((m) => `@${m}`).join(', ')}`)
  }
  if (view.members.length > 0) {
    lines.push(
      `Members (${view.members.length}): ${view.members
        .map((m) => `@${m.name} (#${m.conversationId}, ${m.lifecycle}, ${m.liveState}${m.model !== undefined ? `, model=${m.model}` : ''}, cursor=${m.readCursorSeq}/${m.pendingWakeupSeq}${m.worktreeId !== undefined ? `, worktree=${m.worktreeId}` : ''})`)
        .join('; ')}`,
    )
  }
  if (view.group.retainedWorktrees?.length) {
    lines.push(
      `Retained worktrees: ${view.group.retainedWorktrees
        .map((w) => `@${w.memberName}:${w.branch} (+${w.commitsAhead}, ${w.nodeId !== 'local' ? `node=${w.nodeId}, ` : ''}${w.path})`)
        .join('; ')}`,
    )
  }
  if (view.posts.length > 0) {
    const recent = view.posts.slice(-5).map(formatBoardPostLine)
    lines.push(`Recent posts (${recent.length}/${view.posts.length}):\n${recent.join('\n')}`)
  }
  return lines.join('\n')
}

function formatInspectWorkerSummary(res: InspectWorkerResult): string {
  const header = `Member @${res.name} (#${res.conversationId}, group=${res.groupId}, profile=${res.profileId}, status=${res.status}${res.worktreeId !== undefined ? `, worktree=${res.worktreeId}` : ''}${res.doing !== null ? `, doing="${res.doing}"` : ''}, artifacts=${res.artifacts.length})`
  if (res.recentEntries.length === 0) return header
  const entries = res.recentEntries.slice(-5).map((e) => `- [${e.kind}] ${e.text}`)
  return `${header}\nRecent timeline (${entries.length}/${res.recentEntries.length}):\n${entries.join('\n')}`
}

const groupMeta = (groupId: string, title: string): Record<string, unknown> => {
  const groupTitle = boundedText(title, 120)
  return { groupId, ...(groupTitle ? { groupTitle } : {}) }
}

export function registerSwarmActions(ctx: HelmxPluginContext, coordinator: SwarmCoordinator): void {
  const guard = createSwarmDispatchGuard()
  const { createGroup, updateGroup, closeGroup, listGroups } = createGroupHandlers(ctx, coordinator, guard)
  const { dispatchWorker, abortWorker, switchWorkerModel, inspectWorker, archiveWorker } = createWorkerHandlers(ctx, coordinator, guard)
  const { boardPost, boardRead, boardStatus, completeBoardMembers } = createBoardHandlers(ctx, coordinator)

  function registerTool<TIn, TOut>(spec: {
    id: string; cli: [string, string]; description: string; toolDescription?: string
    scope?: ConversationScope; idempotent?: boolean; promptSnippet?: string; promptGuidelines?: string[]
    inputSchema: JsonSchema; outputSchema: JsonSchema
    handler: (input: TIn, context: PluginActionContext) => MaybePromise<TOut>
    formatOutput: (input: NoInfer<TIn>, output: NoInfer<TOut>) => string
    projectPresentationMeta: (input: NoInfer<TIn>, output: NoInfer<TOut>) => Record<string, unknown>
  }): void {
    ctx.action({
      id: spec.id, description: spec.description,
      ...(spec.scope ? { scope: spec.scope } : {}), ...(spec.idempotent ? { idempotent: true } : {}),
      ...(spec.promptSnippet ? { promptSnippet: spec.promptSnippet } : {}),
      ...(spec.promptGuidelines ? { promptGuidelines: spec.promptGuidelines } : {}),
      cli: { command: ['swarm', spec.cli[0]], description: spec.cli[1] },
      inputSchema: spec.inputSchema, outputSchema: spec.outputSchema,
      exposeAsTool: { name: `swarm_${spec.id}`, description: spec.toolDescription ?? spec.description, replay: 'safe', formatOutput: spec.formatOutput },
      presentationMetaSchema: Schemas.swarmToolPresentationMetaSchema,
      projectPresentationMeta: spec.projectPresentationMeta,
      handler: spec.handler,
    })
  }

  registerTool({
    id: 'create_group', cli: ['create-group', 'Create an active swarm collaboration group'],
    description: 'Create an active swarm collaboration group on a top-level conversation.',
    toolDescription:
      'Start an active peer swarm collaboration board on the current top-level human conversation, tagging it swarm-coordinator and unlocking squad tools next step. Use for complex tasks needing concurrent role division, live peer handoffs, or writer/verifier review loops; skip for single subtasks or fixed deterministic pipelines.',
    promptSnippet:
      'Start a coordinated multi-agent peer blackboard collaboration (`swarm_create_group`) when dividing non-overlapping work across multiple concurrent peer agents.',
    promptGuidelines: [
      'Use swarm_create_group only in a top-level human conversation when dynamic parallel division, live peer handoffs, or writer/reviewer verification warrants a peer squad.',
      'Do not use swarm_create_group for small sequential tasks, single subtasks, or fixed deterministic pipelines (use subagent / SubagentWorkflow when available).',
      'Once active, call load_skill({ skillId: "swarm" }) when available before dispatching workers via swarm_dispatch_worker.',
    ],
    inputSchema: Schemas.createGroupInputSchema, outputSchema: Schemas.createGroupOutputSchema,
    handler: (input: Parameters<typeof createGroup>[0], c) => createGroup(input, c.conversationId, callKeyOf(c)),
    formatOutput: (_i, r) => `Created swarm group "${r.group.title}" (${r.groupId}).`,
    projectPresentationMeta: (_i, r) => groupMeta(r.groupId, r.group.title),
  })

  registerTool({
    id: 'update_group', cli: ['update-group', 'Update swarm collaboration group metadata'],
    description: 'Update the active swarm collaboration group title or objective.',
    scope: COORDINATOR_SCOPE, inputSchema: Schemas.updateGroupInputSchema, outputSchema: Schemas.updateGroupOutputSchema,
    handler: (input: Parameters<typeof updateGroup>[0], c) => updateGroup(input, c.conversationId),
    formatOutput: (_i, r) => `Updated swarm group "${r.group.title}" (${r.groupId}).`,
    projectPresentationMeta: (_i, r) => groupMeta(r.groupId, r.group.title),
  })

  registerTool({
    id: 'dispatch_worker', cli: ['dispatch-worker', 'Recruit a named swarm peer worker'],
    description: 'Recruit a named peer worker role into an active swarm collaboration group.',
    toolDescription:
      'Recruit a named peer role into the active swarm collaboration group with optional worktree isolation and clean-anchor conversation forking. Starts the worker asynchronously in the background and returns immediately.',
    scope: COORDINATOR_SCOPE, inputSchema: Schemas.dispatchInputSchema, outputSchema: Schemas.dispatchWorkerOutputSchema,
    handler: (input: DispatchInput, c) => dispatchWorker(input, c.conversationId, c.signal, callKeyOf(c)),
    formatOutput: (_i, r) =>
      `Dispatched @${r.name} (#${r.workerConversationId}) in group ${r.groupId}${r.worktreeId ? `, worktree=${r.worktreeId}` : ''}, brief=#${r.postSeq}.`,
    projectPresentationMeta: (_i, r) => ({ groupId: r.groupId, memberName: r.name, workerConversationId: r.workerConversationId, seq: r.postSeq }),
  })

  registerTool({
    id: 'board_post', cli: ['board-post', 'Publish a post to the swarm collaboration board'],
    description: 'Publish a structured post to the swarm collaboration board.',
    toolDescription:
      'Publish a structured message on the swarm collaboration board with deterministic target resolution and orthogonal wake control (handoff and done posts from worktree members automatically attach a worktree snapshot).',
    scope: PARTICIPANT_SCOPE, inputSchema: Schemas.boardPostInputSchema, outputSchema: Schemas.boardPostOutputSchema,
    handler: (input: Parameters<typeof boardPost>[0], c) => boardPost(input, c.conversationId, c.signal, callKeyOf(c)),
    formatOutput: (_i, r) => `Posted #${r.post.seq} [${r.post.kind}] -> ${(r.post.resolvedTargets.length > 0 ? r.post.resolvedTargets : r.post.to).join(', ')} (wake=${r.post.wake}).`,
    projectPresentationMeta: (_i, r) => ({ groupId: r.post.groupId, postKind: r.post.kind, seq: r.post.seq }),
  })

  registerTool({
    id: 'board_read', cli: ['board-read', 'Read posts from the swarm collaboration board'],
    description: 'Read swarm collaboration board posts by sinceSeq or exact seqs.',
    idempotent: true, scope: HISTORY_PARTICIPANT_SCOPE,
    inputSchema: Schemas.boardReadInputSchema, outputSchema: Schemas.boardReadOutputSchema,
    handler: (input: Parameters<typeof boardRead>[0], c) => boardRead(input, c.conversationId),
    formatOutput: (_i, r) =>
      r.posts.length === 0
        ? `No matching board posts in ${r.groupId} (headSeq=${r.headSeq}).`
        : `Board ${r.groupId} (headSeq=${r.headSeq}, returned=${r.posts.length}):\n${r.posts.map(formatBoardPostLine).join('\n')}`,
    projectPresentationMeta: (_i, r) => ({ groupId: r.groupId, seq: r.headSeq, postCount: r.posts.length }),
  })

  registerTool({
    id: 'board_status', cli: ['board-status', 'Inspect swarm collaboration group board status'],
    description: 'Inspect live swarm collaboration group status, member cursors and live states, activeWorkingMembers, and retained worktrees.',
    idempotent: true, scope: HISTORY_PARTICIPANT_SCOPE,
    inputSchema: Schemas.boardStatusInputSchema, outputSchema: Schemas.boardStatusOutputSchema,
    handler: (input: { groupId?: string }, c) => boardStatus(input, c.conversationId),
    formatOutput: (_i, r) => formatBoardStatusSummary(r),
    projectPresentationMeta: (_i, r) => ({ ...groupMeta(r.group.id, r.group.title), seq: r.group.headSeq, postCount: r.posts.length }),
  })

  registerTool({
    id: 'abort_worker', cli: ['abort-worker', 'Abort an in-flight swarm worker turn in place'],
    description: 'Stop an in-flight swarm worker turn in place while preserving its conversation history and managed worktree hold for follow-up correction.',
    scope: COORDINATOR_SCOPE, inputSchema: Schemas.workerIdInputSchema, outputSchema: Schemas.abortWorkerOutputSchema,
    handler: (input: Parameters<typeof abortWorker>[0], c) => abortWorker(input, c.conversationId),
    formatOutput: (_i, r) => (r.aborted ? `Aborted @${r.name} (#${r.workerConversationId}).` : `Member @${r.name} (#${r.workerConversationId}) was not running.`),
    projectPresentationMeta: (_i, r) => ({ workerConversationId: r.workerConversationId, memberName: r.name, aborted: r.aborted }),
  })

  registerTool({
    id: 'switch_worker_model', cli: ['switch-model', 'Switch an idle swarm worker conversation model'],
    description: 'Switch an idle swarm worker conversation to another model (or tier/<id>) and optional thinking effort in place while preserving its conversation history; pass prompt to immediately post a brief and wake the worker on the new model.',
    scope: COORDINATOR_SCOPE, inputSchema: Schemas.switchModelInputSchema, outputSchema: Schemas.switchModelOutputSchema,
    handler: (input: Parameters<typeof switchWorkerModel>[0], c) => switchWorkerModel(input, c.conversationId, callKeyOf(c)),
    formatOutput: (_i, r) =>
      `Switched @${r.name} (#${r.workerConversationId}) model to ${r.model}${r.effort ? ` (effort=${r.effort})` : ''}${r.postSeq !== undefined ? ` and woke with brief #${r.postSeq}` : ''}.`,
    projectPresentationMeta: (_i, r) => {
      const model = boundedText(r.model, 200)
      return { workerConversationId: r.workerConversationId, memberName: r.name, ...(model ? { model } : {}), ...(r.postSeq !== undefined ? { seq: r.postSeq } : {}) }
    },
  })

  registerTool({
    id: 'inspect_worker', cli: ['inspect-worker', 'Inspect a swarm worker'],
    description: "Read a swarm worker's recent timeline summary, artifact list, and bound worktreeId.",
    idempotent: true, scope: PARTICIPANT_SCOPE, inputSchema: Schemas.workerIdInputSchema, outputSchema: Schemas.inspectWorkerOutputSchema,
    handler: (input: Parameters<typeof inspectWorker>[0], c) => inspectWorker(input, c.conversationId),
    formatOutput: (_i, r) => formatInspectWorkerSummary(r),
    projectPresentationMeta: (_i, r) => ({ groupId: r.groupId, workerConversationId: r.conversationId, memberName: r.name }),
  })

  registerTool({
    id: 'archive_worker', cli: ['archive-worker', 'Archive an idle swarm worker'],
    description:
      'Archive an idle swarm worker (verifying worktree merge safety and releasing worktree holds when applicable; pass allowUnverifiedUsage: true on nodes without process-usage scanning if you have verified no process holds the directory).',
    scope: COORDINATOR_SCOPE, inputSchema: Schemas.archiveWorkerInputSchema, outputSchema: Schemas.archiveWorkerOutputSchema,
    handler: (input: Parameters<typeof archiveWorker>[0], c) => archiveWorker(input, c.conversationId, c.signal),
    formatOutput: (_i, r) =>
      r.uncleanedWorktree === undefined
        ? `Archived worker #${r.workerConversationId}.`
        : `Archived worker #${r.workerConversationId} (hold released); directory for @${r.uncleanedWorktree.memberName} (${r.uncleanedWorktree.worktreeId}, branch=${r.uncleanedWorktree.branch}) was kept because the node does not support process occupancy scanning. After verifying no process uses it, run cleanup_worktree({ worktreeId: ${JSON.stringify(r.uncleanedWorktree.worktreeId)}, deleteBranch: true, allowUnverifiedUsage: true }) or "helmx worktrees cleanup --worktree-id ${r.uncleanedWorktree.worktreeId} --delete-branch --allow-unverified-usage".`,
    projectPresentationMeta: (_i, r) => ({ workerConversationId: r.workerConversationId, archived: r.archived }),
  })

  registerTool({
    id: 'close_group', cli: ['close-group', 'Close a swarm collaboration group'],
    description:
      'Close the swarm collaboration group in full-cleanup mode or retain-branches mode (keepWorktree: true releases holds and preserves modified branches in retainedWorktrees; force: true closes past the uncommitted/unmerged guard, discarding unmerged member worktree content; on nodes without process-usage scanning, clean worktrees release holds and remain listed in uncleanedWorktrees unless allowUnverifiedUsage: true is explicitly passed).',
    scope: COORDINATOR_SCOPE, inputSchema: Schemas.closeGroupInputSchema, outputSchema: Schemas.closeGroupOutputSchema,
    handler: (input: Parameters<typeof closeGroup>[0], c) => closeGroup(input, c.conversationId, c.signal),
    formatOutput: (_i, r) => {
      const parts: string[] = []
      if (r.retainedWorktrees.length === 0 && (!r.uncleanedWorktrees || r.uncleanedWorktrees.length === 0)) {
        parts.push(`Closed swarm group ${r.groupId} cleanly.`)
      } else if (r.retainedWorktrees.length > 0) {
        parts.push(
          `Closed swarm group ${r.groupId}; retained ${r.retainedWorktrees.length} worktree(s) for merge: ${r.retainedWorktrees.map((w) => `@${w.memberName}:${w.branch} (+${w.commitsAhead}${w.nodeId !== 'local' ? `, node=${w.nodeId}` : ''})`).join(', ')}.`,
        )
      } else {
        parts.push(`Closed swarm group ${r.groupId} (holds released).`)
      }
      if (r.uncleanedWorktrees?.length) {
        parts.push(
          `Skipped automatic deletion of ${r.uncleanedWorktrees.length} clean worktree(s) because the target node does not support process occupancy scanning: ${r.uncleanedWorktrees.map((w) => `@${w.memberName}:${w.worktreeId} (${w.path})`).join(', ')}. After confirming no process uses them, clean up via cleanup_worktree(..., allowUnverifiedUsage: true) or "helmx worktrees cleanup --worktree-id <id> --delete-branch --allow-unverified-usage".`,
        )
      }
      return parts.join(' ')
    },
    projectPresentationMeta: (_i, r) => ({ groupId: r.groupId, retainedCount: r.retainedWorktrees.length }),
  })

  ctx.action({
    id: 'list_groups',
    description: 'List swarm collaboration groups with bounded metadata summaries (optionally filtered by status or coordinatorConversationId).',
    exposeToPrompt: false,
    idempotent: true,
    cli: { command: ['swarm', 'list-groups'], description: 'List swarm collaboration groups' },
    inputSchema: Schemas.listGroupsInputSchema,
    outputSchema: Schemas.listGroupsOutputSchema,
    handler: (input: Parameters<typeof listGroups>[0]) => listGroups(input),
  })

  ctx.action({
    id: 'complete_board_members', description: 'List mentionable swarm collaboration board roles for composer @ completion.',
    visibility: 'ui', idempotent: true, scope: PARTICIPANT_SCOPE,
    inputSchema: Schemas.completerInputSchema, outputSchema: Schemas.completerOutputSchema,
    handler: (input: { query?: string; conversationId?: number }, c: PluginActionContext) => completeBoardMembers(input, c.conversationId),
  })
}
