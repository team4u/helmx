import {
  HelmxError,
  isJsonObject,
  validateOrThrow,
  type ConversationScope,
  type ConversationSummary,
  type HelmxPluginContext,
  type JsonSchema,
  type LocalizedText,
  type MaybePromise,
  type PluginDocHandle,
  type PluginSessionDocHandle,
  type TurnOutcome,
} from '@helmx/protocol'

export const SWARM_PLUGIN_ID = 'builtin:swarm'
export const SWARM_SKILL_ID = 'swarm'
export const COORDINATOR_TAG = 'swarm-coordinator'
export const WORKER_TAG = 'swarm-worker'
export const ARCHIVED_WORKER_TAG = 'swarm-worker-archived'
export const ARCHIVED_COORDINATOR_TAG = 'swarm-coordinator-archived'
export const BOARD_REPORT_RENDERER = 'swarm:board-report'
export const BOARD_WAKEUP_RENDERER = 'swarm:board-wakeup'
export const INDEX_DOC_NAME = 'index'
export const BOARD_BADGES_DOC_NAME = 'board-badges'
export const BOARD_VIEW_DOC_NAME = 'board-view'
export const ACTIVE_SWARM_GROUP_SECTION_ID = 'swarm.active_group'

export const RESERVED_MEMBER_NAMES = new Set(['coordinator', 'all', 'system'])
export const MEMBER_NAME_PATTERN = '^[a-z][a-z0-9_-]{0,31}$'
export const GROUP_ID_PATTERN = '^[A-Za-z0-9_-]{1,64}$'
export const PROFILE_ID_PATTERN = '^[a-z0-9][a-z0-9-]{0,63}$'
const MEMBER_NAME_RE = new RegExp(MEMBER_NAME_PATTERN)
const GROUP_ID_RE = new RegExp(GROUP_ID_PATTERN)

export const BOARD_POST_KINDS = ['brief', 'handoff', 'review', 'comment', 'blocker', 'done', 'stall'] as const
export type BoardPostKind = (typeof BOARD_POST_KINDS)[number]
export const MEMBER_LIVE_STATES = ['idle', 'working', 'blocked', 'done', 'error', 'missing'] as const
export type MemberLiveState = (typeof MEMBER_LIVE_STATES)[number]
export const ACTIONABLE_WAKE_KINDS: ReadonlySet<BoardPostKind> = new Set(['brief', 'handoff', 'review'])
export const COORDINATOR_ESCALATION_KINDS: ReadonlySet<BoardPostKind> = new Set(['blocker', 'stall'])
export const COORDINATOR_BATCH_WINDOW_MS = 50
export const MAX_INDEX_CLOSED_GROUPS = 50

export const COORDINATOR_SCOPE: ConversationScope = { tags: [COORDINATOR_TAG] }
export const PARTICIPANT_SCOPE: ConversationScope = { tags: [COORDINATOR_TAG, WORKER_TAG] }
export const HISTORY_PARTICIPANT_SCOPE: ConversationScope = {
  tags: [COORDINATOR_TAG, ARCHIVED_COORDINATOR_TAG, WORKER_TAG, ARCHIVED_WORKER_TAG],
}
export const DEFAULT_SWARM_CONFIG: SwarmConfig = {
  maxWorkersPerGroup: 12,
  boardPreviewLimit: 80,
  maxPeerHopsWithoutCoordinator: 16,
}

export type WorkerAccess = 'readwrite' | 'readonly'
export type WorkerIsolation = 'inherit' | 'worktree'
export type CollabGroupStatus = 'active' | 'closed'
export interface SwarmConfig { maxWorkersPerGroup: number; boardPreviewLimit: number; maxPeerHopsWithoutCoordinator: number }
export interface SwarmWorkerPointer { conversationId: number; coordinatorConversationId: number; profileId: string; groupId: string; name: string; createdAt: number }
export interface CollabGroupSummary {
  id: string; title: string; coordinatorConversationId: number; status: CollabGroupStatus
  coordinatorDetached?: boolean; activeWorkerCount: number; headSeq: number; createdAt: number; updatedAt: number; closedAt?: number
}
export interface SwarmIndexDoc { workers: SwarmWorkerPointer[]; groups: CollabGroupSummary[] }
export interface InflightWakeupIntent { requestId: string; fromSeq: number; toSeq: number; baseCompletionSeq: number }
export interface InflightNudgeIntent { requestId: string; taskSeq: number; baseCompletionSeq: number }
export interface InflightReportIntent { requestId: string; fromSeq: number; toSeq: number; baseCompletionSeq: number; hadActiveWorkers: boolean }
export interface GroupMemberState {
  name: string; conversationId: number; profileId: string; access: WorkerAccess; isolation: WorkerIsolation
  nodeId: string; cwd: string; worktreeId?: string; lifecycle: 'active' | 'archived'
  readCursorSeq: number; pendingWakeupSeq: number; lastPostSeq?: number; lastWakeTaskSeq?: number
  silentExitNudgeSeq?: number; lastWakeCompletionSeq?: number
  lastOutboundEdge?: { seq: number; to: string[]; kind: BoardPostKind }
  dispatchKey?: string; briefPostSeq?: number; inflightWakeup?: InflightWakeupIntent; inflightNudge?: InflightNudgeIntent
  runDurationMs?: number; turnCount?: number; createdAt: number; archivedAt?: number
}
export interface RetainedWorktreeInfo { memberName: string; nodeId: string; worktreeId: string; branch: string; path: string; commitsAhead: number }
export interface CollabGroupRecord {
  id: string; title: string; objective?: string; coordinatorConversationId: number; createKey?: string
  status: CollabGroupStatus; members: GroupMemberState[]; headSeq: number
  coordinatorNotifiedSeq: number; coordinatorPendingSeq: number
  inflightReport?: InflightReportIntent; lastReportHadActiveWorkers?: boolean; lastStallWatermark?: string
  peerHopsSinceCoordinator?: number; coordinatorDetached?: boolean; retainedWorktrees?: RetainedWorktreeInfo[]
  createdAt: number; updatedAt: number; closedAt?: number; closeSummary?: string
}
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
export interface SwarmDocs { index: PluginDocHandle<SwarmIndexDoc>; boardBadges: PluginDocHandle<BoardBadgesDoc>; boardView: PluginSessionDocHandle<BoardViewDoc | null> }
export interface AppendPostDraft {
  from: string; to: string[]; resolvedTargets: string[]; wake: boolean; kind: BoardPostKind; refs: number[]; body: string
  idempotencyKey?: string; worktreeSnapshot?: WorktreeHandoffSnapshot; lastStallWatermarkAfterPost?: string
}
export interface MemberTurnSettledInput {
  groupId: string; memberName: string; conversationId: number; completionSeq: number
  outcome: TurnOutcome; error?: string; lastReplySummary: string
}

export interface CollabGroupRuntime {
  loadAllFromDisk(): Promise<void>
  reconcileOrphansOnBoot(): Promise<void>
  reconcileRecoveredGroups(): Promise<void>
  stopAndClear(): Promise<void>
  liveTaskLabels(): string[]
  inUseItems(): Array<{ kind: string; id: string; label: string }>
  listGroups(): CollabGroupRecord[]
  getGroup(groupId: string): CollabGroupRecord | undefined
  findActiveGroupByCoordinator(conversationId: number): CollabGroupRecord | undefined
  findGroupByParticipant(conversationId: number):
    | { group: CollabGroupRecord; role: 'coordinator' }
    | { group: CollabGroupRecord; role: 'worker'; member: GroupMemberState }
    | undefined
  findLatestGroupForConversation(conversationId: number): CollabGroupRecord | undefined
  getPosts(groupId: string): readonly BoardPost[]
  ensurePostsLoaded(groupId: string): Promise<readonly BoardPost[]>
  buildBoardView(groupId: string): BoardViewDoc
  syncProjections(): void
  onConversationUpsert(conversationId: number): void
  onConversationDeleted(conversationId: number): Promise<void>
  createGroup(input: { coordinatorConversationId: number; title: string; objective?: string; createKey?: string }): Promise<CollabGroupRecord>
  updateGroup(groupId: string, patch: { title?: string; objective?: string }): Promise<CollabGroupRecord>
  addMemberWithBrief(
    groupId: string,
    member: Omit<GroupMemberState, 'readCursorSeq' | 'pendingWakeupSeq' | 'lastWakeTaskSeq'>,
    briefPrompt: string,
  ): Promise<{ group: CollabGroupRecord; member: GroupMemberState; post: BoardPost }>
  appendPost(groupId: string, draft: AppendPostDraft): Promise<BoardPost>
  mutateGroup<T>(
    groupId: string,
    fn: (group: CollabGroupRecord, posts: readonly BoardPost[]) => MaybePromise<{ group: CollabGroupRecord; result: T }>,
  ): Promise<T>
  onMemberTurnSettled(input: MemberTurnSettledInput): Promise<void>
  onCoordinatorTurnSettled(conversationId: number): Promise<void>
  hasInflightWakeup(groupId: string, memberName: string): boolean
  afterMemberArchived(groupId: string): Promise<void>
}

export interface SwarmCoordinator {
  isActive(): boolean
  isShutdown(): boolean
  getConfig(): SwarmConfig
  getDocs(): SwarmDocs
  readIndex(): SwarmIndexDoc
  writeIndex(next: SwarmIndexDoc): SwarmIndexDoc
  readConversationOrUndefined(id: number | undefined): ConversationSummary | undefined
  reportError(title: string, detail: unknown): void
  enqueueDispatch<T>(key: string, task: () => Promise<T>): Promise<T>
  track<T>(label: string, task: () => MaybePromise<T>): Promise<T>
  groups: CollabGroupRuntime
  settlingWorkers: Map<number, number>
}

// ---------------------------------------------------------------------------
// Single-Source JSON Schema Primitives & Core Persistence Schemas
// ---------------------------------------------------------------------------

export const S = {
  obj: (properties: Record<string, unknown>, required?: readonly string[]): JsonSchema => ({
    type: 'object',
    properties,
    ...(required?.length ? { required: [...required] } : {}),
    additionalProperties: false,
  }),
  str: (extra?: Record<string, unknown>): JsonSchema => ({ type: 'string', ...extra }),
  nonEmptyStr: (extra?: Record<string, unknown>): JsonSchema => ({ type: 'string', minLength: 1, pattern: '\\S', ...extra }),
  int: (minimum = 0, maximum?: number): JsonSchema => ({ type: 'integer', minimum, ...(maximum !== undefined ? { maximum } : {}) }),
  num: (minimum?: number): JsonSchema => ({ type: 'number', ...(minimum !== undefined ? { minimum } : {}) }),
  bool: (description?: string): JsonSchema => ({ type: 'boolean', ...(description ? { description } : {}) }),
  arr: (items: JsonSchema, extra?: Record<string, unknown>): JsonSchema => ({ type: 'array', items, ...extra }),
  enm: (values: readonly string[], description?: string): JsonSchema => ({
    type: 'string',
    enum: [...values],
    ...(description ? { description } : {}),
  }),
}

export const retainedWorktreeSchema = S.obj(
  { memberName: S.str(), nodeId: S.nonEmptyStr(), worktreeId: S.str(), branch: S.str(), path: S.str(), commitsAhead: S.int(0) },
  ['memberName', 'nodeId', 'worktreeId', 'branch', 'path', 'commitsAhead'],
)

export const worktreeSnapshotSchema = S.obj(
  { worktreeId: S.str({ minLength: 1 }), branch: S.str(), commitsAhead: S.int(0), dirtyCount: S.int(0), changedFilesPreview: S.arr(S.str()) },
  ['worktreeId', 'dirtyCount', 'changedFilesPreview'],
)

export const boardPostSchema = S.obj(
  {
    seq: S.int(1), groupId: S.nonEmptyStr(), from: S.nonEmptyStr(),
    to: S.arr(S.str({ minLength: 1 })), resolvedTargets: S.arr(S.str({ minLength: 1 })),
    wake: S.bool(), kind: S.enm(BOARD_POST_KINDS), refs: S.arr(S.int(1)),
    body: S.str(), idempotencyKey: S.nonEmptyStr(), worktreeSnapshot: worktreeSnapshotSchema, createdAt: S.num(0),
  },
  ['seq', 'groupId', 'from', 'to', 'resolvedTargets', 'wake', 'kind', 'refs', 'body', 'createdAt'],
)

const inflightWakeupSchema = S.obj(
  { requestId: S.nonEmptyStr(), fromSeq: S.int(1), toSeq: S.int(1), baseCompletionSeq: S.int(0) },
  ['requestId', 'fromSeq', 'toSeq', 'baseCompletionSeq'],
)
const inflightNudgeSchema = S.obj(
  { requestId: S.nonEmptyStr(), taskSeq: S.int(1), baseCompletionSeq: S.int(0) },
  ['requestId', 'taskSeq', 'baseCompletionSeq'],
)
const inflightReportSchema = S.obj(
  { requestId: S.nonEmptyStr(), fromSeq: S.int(1), toSeq: S.int(1), baseCompletionSeq: S.int(0), hadActiveWorkers: S.bool() },
  ['requestId', 'fromSeq', 'toSeq', 'baseCompletionSeq', 'hadActiveWorkers'],
)

export const memberStateBaseProps: Record<string, unknown> = {
  name: S.nonEmptyStr(), conversationId: S.int(1), profileId: S.nonEmptyStr(),
  access: S.enm(['readwrite', 'readonly']), isolation: S.enm(['inherit', 'worktree']),
  nodeId: S.nonEmptyStr(), cwd: S.nonEmptyStr(), worktreeId: S.str({ minLength: 1 }),
  lifecycle: S.enm(['active', 'archived']), readCursorSeq: S.int(0), pendingWakeupSeq: S.int(0),
  lastPostSeq: S.int(1), lastWakeTaskSeq: S.int(1), silentExitNudgeSeq: S.int(1), lastWakeCompletionSeq: S.int(0),
  lastOutboundEdge: S.obj({ seq: S.int(1), to: S.arr(S.str()), kind: S.enm(BOARD_POST_KINDS) }, ['seq', 'to', 'kind']),
  dispatchKey: S.nonEmptyStr(), briefPostSeq: S.int(1), inflightWakeup: inflightWakeupSchema, inflightNudge: inflightNudgeSchema,
  runDurationMs: S.num(0), turnCount: S.int(0), createdAt: S.num(0), archivedAt: S.num(0),
}
export const memberStateRequired = [
  'name', 'conversationId', 'profileId', 'access', 'isolation', 'nodeId', 'cwd',
  'lifecycle', 'readCursorSeq', 'pendingWakeupSeq', 'createdAt',
] as const

const collabGroupRecordSchema = S.obj(
  {
    id: S.str({ minLength: 1, maxLength: 64, pattern: GROUP_ID_PATTERN }), title: S.nonEmptyStr(), objective: S.str(),
    coordinatorConversationId: S.int(1), createKey: S.nonEmptyStr(), status: S.enm(['active', 'closed']),
    members: S.arr(S.obj(memberStateBaseProps, memberStateRequired)),
    headSeq: S.int(0), coordinatorNotifiedSeq: S.int(0), coordinatorPendingSeq: S.int(0),
    inflightReport: inflightReportSchema, lastReportHadActiveWorkers: S.bool(), lastStallWatermark: S.str(),
    peerHopsSinceCoordinator: S.int(0), coordinatorDetached: S.bool(), retainedWorktrees: S.arr(retainedWorktreeSchema),
    createdAt: S.num(0), updatedAt: S.num(0), closedAt: S.num(0), closeSummary: S.str(),
  },
  ['id', 'title', 'coordinatorConversationId', 'status', 'members', 'headSeq', 'coordinatorNotifiedSeq', 'coordinatorPendingSeq', 'createdAt', 'updatedAt'],
)

const swarmIndexDocSchema = S.obj(
  {
    workers: S.arr(
      S.obj(
        { conversationId: S.int(1), coordinatorConversationId: S.int(1), profileId: S.nonEmptyStr(), groupId: S.nonEmptyStr(), name: S.nonEmptyStr(), createdAt: S.num(0) },
        ['conversationId', 'coordinatorConversationId', 'profileId', 'groupId', 'name', 'createdAt'],
      ),
    ),
    groups: S.arr(
      S.obj(
        {
          id: S.nonEmptyStr(), title: S.nonEmptyStr(), coordinatorConversationId: S.int(1), status: S.enm(['active', 'closed']),
          coordinatorDetached: S.bool(), activeWorkerCount: S.int(0), headSeq: S.int(0), createdAt: S.num(0), updatedAt: S.num(0), closedAt: S.num(0),
        },
        ['id', 'title', 'coordinatorConversationId', 'status', 'activeWorkerCount', 'headSeq', 'createdAt', 'updatedAt'],
      ),
    ),
  },
  ['workers', 'groups'],
)

// ---------------------------------------------------------------------------
// Guards, Error Factories & Shared Helpers
// ---------------------------------------------------------------------------

export const isPosIntId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0
export const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
export const isFiniteTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
export const isBoardPostKind = (v: unknown): v is BoardPostKind => typeof v === 'string' && (BOARD_POST_KINDS as readonly string[]).includes(v)
export const isEnoent = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
export const isLifecycleTeardownError = (err: unknown): boolean =>
  err instanceof HelmxError && (err.code === 'plugin_disabled' || err.code === 'plugin_context_expired' || err.code === 'plugin_host_disposed')

export const swarmError = (code: string, message: string, status: number, details?: Record<string, unknown>): HelmxError =>
  new HelmxError(code, message, status, { pluginId: SWARM_PLUGIN_ID, ...details })
export const groupNotFoundError = (groupId: string): HelmxError =>
  swarmError('swarm_group_not_found', `协作组 '${groupId}' 不存在`, 404, { groupId })
export const groupClosedError = (groupId: string, detail = '已结单'): HelmxError =>
  swarmError('swarm_group_closed', `协作组 '${groupId}' ${detail}`, 409, { groupId })

export function createKeyedQueue(): { enqueue: <T>(key: string, fn: () => Promise<T>) => Promise<T>; clear: () => void } {
  const chains = new Map<string, Promise<unknown>>()
  return {
    enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const task = (chains.get(key) ?? Promise.resolve()).then(fn, fn)
      const settled = task.then(() => undefined, () => undefined)
      chains.set(key, settled)
      void settled.finally(() => { if (chains.get(key) === settled) chains.delete(key) })
      return task
    },
    clear: () => chains.clear(),
  }
}

export async function setConversationTags(
  ctx: HelmxPluginContext,
  conv: Pick<ConversationSummary, 'id' | 'tags'>,
  addTag: string,
  removeTags: readonly string[],
): Promise<void> {
  await ctx.host.updateConversation(conv.id, { tags: [...conv.tags.filter((t) => t !== addTag && !removeTags.includes(t)), addTag] })
}

export function snapshotMemberTiming(
  summary: Pick<ConversationSummary, 'status' | 'runDurationMs' | 'runStartedAt' | 'completionSeq'> | undefined,
  now: number,
): { runDurationMs?: number; turnCount?: number } {
  if (summary === undefined) return {}
  const settledMs = isFiniteTime(summary.runDurationMs) ? Math.trunc(summary.runDurationMs) : undefined
  const activeDeltaMs =
    (summary.status === 'working' || summary.status === 'blocked') &&
    isFiniteTime(summary.runStartedAt) && isFiniteTime(now) && now >= summary.runStartedAt
      ? Math.trunc(now - summary.runStartedAt)
      : 0
  const runDurationMs = settledMs !== undefined || activeDeltaMs > 0 ? (settledMs ?? 0) + activeDeltaMs : undefined
  const turnCount = isNonNegInt(summary.completionSeq) ? summary.completionSeq : undefined
  return { ...(runDurationMs !== undefined ? { runDurationMs } : {}), ...(turnCount !== undefined ? { turnCount } : {}) }
}

export function resolveSwarmConfig(raw: Record<string, unknown>): SwarmConfig {
  const readBounded = (key: keyof SwarmConfig, min: number, max: number): number => {
    if (!(key in raw) || raw[key] === undefined) return DEFAULT_SWARM_CONFIG[key]
    const v = raw[key]
    if (typeof v !== 'number' || !Number.isInteger(v) || !Number.isFinite(v) || v < min || v > max) {
      throw swarmError('swarm_config_invalid', `${SWARM_PLUGIN_ID} 配置非法：字段 ${key} 必须是 ${min}..${max} 整数（实际：${String(v)}）`, 500)
    }
    return v
  }
  return {
    maxWorkersPerGroup: readBounded('maxWorkersPerGroup', 2, 32),
    boardPreviewLimit: readBounded('boardPreviewLimit', 20, 200),
    maxPeerHopsWithoutCoordinator: readBounded('maxPeerHopsWithoutCoordinator', 2, 100),
  }
}

export function asConversationUpsertEvent(payload: unknown): { id: number; status: string; updatedAt: number } | undefined {
  if (!isJsonObject(payload) || payload['type'] !== 'conversation.upsert') return undefined
  const c = payload['conversation']
  if (!isJsonObject(c) || !isPosIntId(c['id']) || typeof c['status'] !== 'string' || !isFiniteTime(c['updatedAt'])) return undefined
  return { id: c['id'], status: c['status'], updatedAt: c['updatedAt'] }
}

export function asConversationDeletedEvent(payload: unknown): number | undefined {
  if (!isJsonObject(payload) || payload['type'] !== 'conversation.deleted') return undefined
  return isPosIntId(payload['conversationId']) ? payload['conversationId'] : undefined
}

export function assertMemberName(value: unknown): string {
  if (typeof value !== 'string') throw new HelmxError('validation_error', `成员名必须是字符串（收到：${String(value)}）`, 400, {})
  const trimmed = value.trim()
  if (!MEMBER_NAME_RE.test(trimmed)) {
    throw new HelmxError('validation_error', `成员名 '${value}' 非法（需 1..32 位小写字母开头，仅含 [a-z0-9_-]）`, 400, { name: value })
  }
  if (RESERVED_MEMBER_NAMES.has(trimmed)) {
    throw new HelmxError('validation_error', `成员名 '${trimmed}' 是系统保留字（禁止使用 coordinator / all / system）`, 400, { name: trimmed })
  }
  return trimmed
}

export function assertGroupId(value: unknown): string {
  if (typeof value !== 'string') throw new HelmxError('validation_error', `groupId 必须是字符串（收到：${String(value)}）`, 400, {})
  const trimmed = value.trim()
  if (!GROUP_ID_RE.test(trimmed)) {
    throw new HelmxError('validation_error', `groupId '${value}' 非法（需 1..64 位 [A-Za-z0-9_-]）`, 400, { groupId: value })
  }
  return trimmed
}

export function assertBoardPostKind(value: unknown): BoardPostKind {
  if (!isBoardPostKind(value)) {
    throw new HelmxError('validation_error', `kind 非法（期望 ${BOARD_POST_KINDS.join(' | ')}，收到：${String(value)}）`, 400, {})
  }
  return value
}

export function toGroupSummary(r: CollabGroupRecord): CollabGroupSummary {
  return {
    id: r.id, title: r.title, coordinatorConversationId: r.coordinatorConversationId, status: r.status,
    ...(r.coordinatorDetached !== undefined ? { coordinatorDetached: r.coordinatorDetached } : {}),
    activeWorkerCount: r.members.filter((m) => m.lifecycle === 'active').length,
    headSeq: r.headSeq, createdAt: r.createdAt, updatedAt: r.updatedAt,
    ...(r.closedAt !== undefined ? { closedAt: r.closedAt } : {}),
  }
}

function assertUnique<T, K>(items: readonly T[], keyOf: (item: T) => K, errorMessage: (key: K) => string): void {
  const seen = new Set<K>()
  for (const item of items) {
    const key = keyOf(item)
    if (seen.has(key)) throw swarmError('swarm_doc_corrupt', errorMessage(key), 500)
    seen.add(key)
  }
}

export function assertIndexDoc(value: unknown): SwarmIndexDoc {
  validateOrThrow(swarmIndexDocSchema, value, `插件 doc ${INDEX_DOC_NAME} 结构非法`, 'swarm_doc_corrupt', 500, { pluginId: SWARM_PLUGIN_ID })
  const doc = value as SwarmIndexDoc
  assertUnique(doc.workers, (w) => w.conversationId, (id) => `插件 doc ${INDEX_DOC_NAME} workers 重复登记会话 #${id}`)
  assertUnique(doc.groups, (g) => g.id, (id) => `插件 doc ${INDEX_DOC_NAME} groups 重复登记协作组 '${id}'`)
  return doc
}

export function assertCollabGroupRecord(value: unknown): CollabGroupRecord {
  validateOrThrow(collabGroupRecordSchema, value, '协作组 meta.json 损坏或非法', 'swarm_doc_corrupt', 500, { pluginId: SWARM_PLUGIN_ID })
  const rec = value as CollabGroupRecord
  if (rec.inflightReport && rec.inflightReport.fromSeq > rec.inflightReport.toSeq) {
    throw swarmError('swarm_doc_corrupt', '协作组 meta.json 损坏：inflightReport seq 范围非法', 500)
  }
  assertUnique(rec.members, (m) => m.name, (name) => `协作组 meta.json 损坏：重复成员名 '${name}'`)
  for (const m of rec.members) {
    if (m.inflightWakeup && m.inflightWakeup.fromSeq > m.inflightWakeup.toSeq) {
      throw swarmError('swarm_doc_corrupt', `协作组 meta.json 损坏：成员 '${m.name}' inflightWakeup seq 范围非法`, 500)
    }
  }
  return rec
}

export function assertBoardPost(value: unknown): BoardPost {
  validateOrThrow(boardPostSchema, value, '协作组 board.jsonl 记录损坏或非法', 'swarm_doc_corrupt', 500, { pluginId: SWARM_PLUGIN_ID })
  return value as BoardPost
}
