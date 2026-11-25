/**
 * builtin:swarm action & model-tool shared JSON Schemas (English machine descriptions only).
 */
import { NODE_ID_PATTERN } from '@helmx/protocol'
import {
  BOARD_POST_KINDS,
  GROUP_ID_PATTERN,
  MAX_BOARD_POST_BODY_CHARS,
  MEMBER_LIVE_STATES,
  MEMBER_NAME_PATTERN,
  PROFILE_ID_PATTERN,
  S,
  boardPostSchema,
  memberStateBaseProps,
  memberStateRequired,
  retainedWorktreeSchema,
  uncleanedWorktreeSchema,
} from './contracts.js'

const groupIdSchema = S.str({ minLength: 1, maxLength: 64, pattern: GROUP_ID_PATTERN })
const memberNameSchema = S.str({ minLength: 1, maxLength: 32, pattern: MEMBER_NAME_PATTERN })
export const workerIdSchema = S.int(1)
const workerRefProps = { workerConversationId: workerIdSchema, groupId: groupIdSchema, name: memberNameSchema }

export const workerIdInputSchema = S.obj(workerRefProps)

export const dispatchInputSchema = S.obj(
  {
    prompt: S.str({ minLength: 1, description: 'Initial brief task assignment for this peer role' }),
    groupId: groupIdSchema,
    name: { ...memberNameSchema, description: 'Unique lowercase role name (e.g. author, verifier)' },
    profileId: S.str({ minLength: 1, maxLength: 64, pattern: PROFILE_ID_PATTERN }),
    access: S.enm(['readwrite', 'readonly']),
    isolation: S.enm(['inherit', 'worktree']),
    forkFrom: S.str({ minLength: 1, maxLength: 32, description: "Optional fork source: 'coordinator' or an existing member name" }),
    forkEntryId: S.int(1),
    model: S.str({ minLength: 1, maxLength: 200 }),
    effort: S.str({ minLength: 1, maxLength: 32 }),
    title: S.str({ minLength: 1, maxLength: 80 }),
    nodeId: S.str({
      minLength: 1,
      maxLength: 128,
      pattern: NODE_ID_PATTERN,
      description:
        'Optional target compute node ID (overrides Profile/coordinator node; explicit "local" switches back to the Hub host; requires cwd or a compatible Profile cwd on remote nodes)',
    }),
    cwd: S.str({ minLength: 1 }),
  },
  ['prompt', 'name'],
)

export const createGroupInputSchema = S.obj(
  {
    title: S.str({ minLength: 1, maxLength: 120, description: 'Swarm collaboration group title' }),
    objective: S.str({ maxLength: 4000, description: 'Shared objective anchor for the squad' }),
    conversationId: { ...S.int(1), description: 'Target top-level coordinator conversation ID' },
  },
  ['title'],
)

export const updateGroupInputSchema = S.obj({
  groupId: groupIdSchema,
  title: S.str({ minLength: 1, maxLength: 120 }),
  objective: S.str({ maxLength: 4000 }),
})

export const boardPostInputSchema = S.obj(
  {
    groupId: groupIdSchema,
    to: S.arr(S.str({ minLength: 1, maxLength: 64 }), {
      minItems: 1,
      description: "Targets: 'coordinator', 'all' (coordinator/human only), or '<memberName>'",
    }),
    kind: S.enm(
      ['brief', 'handoff', 'review', 'comment', 'blocker', 'done'],
      "Message intent: 'brief' (task assignment), 'handoff' (peer delivery), 'review' (verification feedback), 'comment' (passive note, wake defaults false), 'blocker' (escalates to coordinator immediately), 'done' (final completion to coordinator)",
    ),
    body: S.str({ minLength: 1, maxLength: MAX_BOARD_POST_BODY_CHARS }),
    wake: S.bool(
      'Trigger a follow-up turn for target sessions (defaults to false for comment, true otherwise; busy peers receive coalesced wakeups on settle, and done posts to coordinator batch until all active workers are idle)',
    ),
    refs: S.arr(S.int(1)),
  },
  ['to', 'kind', 'body'],
)

export const boardReadInputSchema = S.obj({
  groupId: groupIdSchema,
  sinceSeq: S.int(0),
  seqs: S.arr(S.int(1)),
  limit: S.int(1, 200),
})

export const boardStatusInputSchema = S.obj({ groupId: groupIdSchema })

export const switchModelInputSchema = S.obj(
  {
    ...workerRefProps,
    model: S.str({ minLength: 1, maxLength: 200 }),
    effort: S.str({ minLength: 1, maxLength: 32, description: 'Optional thinking/reasoning level override applied alongside the model switch' }),
    prompt: S.str({ minLength: 1, description: 'Optional resume instruction posted to the board as a coordinator brief to wake the member immediately after switching model' }),
  },
  ['model'],
)

export const archiveWorkerInputSchema = S.obj({
  ...workerRefProps,
  keepWorktree: S.bool(),
  force: S.bool(),
  allowUnverifiedUsage: S.bool(
    'Explicitly clean up the member worktree without a process-occupancy check when the target node does not support process usage scanning',
  ),
})

export const closeGroupInputSchema = S.obj({
  groupId: groupIdSchema,
  keepWorktree: S.bool('Release holds and archive members while preserving modified worktree branches in retainedWorktrees for merging'),
  abortRunning: S.bool('Abort any running group members before closing'),
  force: S.bool('Force member worktree cleanup past the uncommitted/unmerged guard (occupancy by holds/running conversations/process scans, ownership and locked checks still refuse; never bypasses swarm_worker_busy)'),
  allowUnverifiedUsage: S.bool(
    'Explicitly clean up eligible member worktrees without a process-occupancy check when the target node does not support process usage scanning',
  ),
  summary: S.str({ maxLength: 2000 }),
})

export const completerInputSchema = S.obj({ query: S.str(), conversationId: S.int(1) })

const groupViewInfoSchema = S.obj(
  {
    id: S.str(), title: S.str(), objective: S.str(), coordinatorConversationId: S.num(),
    status: S.enm(['active', 'closed']), coordinatorDetached: S.bool(), activeWorkerCount: S.num(),
    headSeq: S.num(), retainedWorktrees: S.arr(retainedWorktreeSchema), closeSummary: S.str(),
    createdAt: S.num(), updatedAt: S.num(), closedAt: S.num(),
  },
  ['id', 'title', 'coordinatorConversationId', 'status', 'activeWorkerCount', 'headSeq', 'createdAt', 'updatedAt'],
)

const boardMemberViewSchema = S.obj(
  { ...memberStateBaseProps, liveState: S.enm(MEMBER_LIVE_STATES), model: S.str(), runStartedAt: S.num(0), pendingAskSince: S.num(0) },
  [...memberStateRequired, 'liveState'],
)

export const createGroupOutputSchema = S.obj({ groupId: S.str(), group: groupViewInfoSchema }, ['groupId', 'group'])
export const updateGroupOutputSchema = createGroupOutputSchema
export const dispatchWorkerOutputSchema = S.obj(
  { workerConversationId: S.num(), groupId: S.str(), name: S.str(), worktreeId: S.str(), postSeq: S.num() },
  ['workerConversationId', 'groupId', 'name', 'postSeq'],
)
export const boardPostOutputSchema = S.obj({ post: boardPostSchema }, ['post'])
export const boardReadOutputSchema = S.obj({ groupId: S.str(), headSeq: S.num(), posts: S.arr(boardPostSchema) }, ['groupId', 'headSeq', 'posts'])
export const boardStatusOutputSchema = S.obj(
  {
    group: groupViewInfoSchema,
    headline: S.obj(
      { kind: S.enm(['normal', 'stall', 'blocker', 'unmerged', 'closed']), tone: S.enm(['info', 'ok', 'warn', 'err']), text: S.str(), targetMember: S.str(), refSeq: S.num() },
      ['kind', 'tone', 'text'],
    ),
    members: S.arr(boardMemberViewSchema),
    posts: S.arr(boardPostSchema),
    activeWorkingMembers: S.arr(S.str()),
  },
  ['group', 'headline', 'members', 'posts', 'activeWorkingMembers'],
)
export const abortWorkerOutputSchema = S.obj({ aborted: S.bool(), workerConversationId: S.num(), name: S.str() }, ['aborted', 'workerConversationId', 'name'])
export const switchModelOutputSchema = S.obj(
  { workerConversationId: S.num(), model: S.str(), effort: S.str(), name: S.str(), postSeq: S.num() },
  ['workerConversationId', 'model', 'name'],
)
export const inspectWorkerOutputSchema = S.obj(
  {
    conversationId: S.num(), groupId: S.str(), name: S.str(), worktreeId: S.str(), title: S.str(),
    profileId: S.str(), status: S.str(), doing: { anyOf: [{ type: 'string' }, { type: 'null' }] }, completionSeq: S.num(),
    artifacts: S.arr(S.obj({ id: S.str(), name: S.str(), size: S.num() }, ['id', 'name', 'size'])),
    recentEntries: S.arr(S.obj({ id: S.str(), kind: S.str(), text: S.str() }, ['id', 'kind', 'text'])),
  },
  ['conversationId', 'groupId', 'name', 'title', 'profileId', 'status', 'doing', 'completionSeq', 'artifacts', 'recentEntries'],
)
export const archiveWorkerOutputSchema = S.obj(
  { archived: S.bool(), workerConversationId: S.num(), uncleanedWorktree: uncleanedWorktreeSchema },
  ['archived', 'workerConversationId'],
)
export const closeGroupOutputSchema = S.obj(
  { closed: S.bool(), groupId: S.str(), retainedWorktrees: S.arr(retainedWorktreeSchema), uncleanedWorktrees: S.arr(uncleanedWorktreeSchema) },
  ['closed', 'groupId', 'retainedWorktrees'],
)
export const completerOutputSchema = S.obj(
  { items: S.arr(S.obj({ id: S.str(), label: S.str(), insertText: S.str(), hint: S.str(), icon: S.str() }, ['id', 'label', 'insertText'])) },
  ['items'],
)
export const swarmToolPresentationMetaSchema = S.obj({
  groupId: S.str({ minLength: 1, maxLength: 64 }),
  groupTitle: S.str({ minLength: 1, maxLength: 120 }),
  memberName: S.str({ minLength: 1, maxLength: 32 }),
  workerConversationId: S.int(1),
  postKind: S.enm(BOARD_POST_KINDS),
  seq: S.int(0),
  postCount: S.int(0),
  aborted: S.bool(),
  model: S.str({ minLength: 1, maxLength: 200 }),
  archived: S.bool(),
  retainedCount: S.int(0),
})
