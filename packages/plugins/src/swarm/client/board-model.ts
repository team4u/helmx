/**
 * Pure domain models and strict boundary parsers for builtin:swarm client surfaces (Fast Refresh compliant).
 */
import type { TimelineRendererProps } from '@helmx/protocol/browser'
import type {
  BoardPost, BoardPostKind, BoardReceiptPost, BoardViewDoc, BoardViewHeadline, BoardViewMember,
  CollabGroupStatus, CollabGroupSummary, GroupMemberState, MemberLiveState, RetainedWorktreeInfo,
  WorkerAccess, WorkerIsolation, WorktreeHandoffSnapshot,
} from '../contracts-types.js'
import type { SwarmIndexDoc } from './models.ts'

export type {
  BoardPost, BoardPostKind, BoardReceiptPost, BoardViewDoc, CollabGroupStatus, CollabGroupSummary, GroupMemberState,
  MemberLiveState, RetainedWorktreeInfo, WorkerAccess, WorkerIsolation, WorktreeHandoffSnapshot,
}
export type BoardMemberView = BoardViewMember
export type BoardHeadline = BoardViewHeadline
export type BoardGroupView = BoardViewDoc['group']
export interface BoardReportReceiptMeta {
  renderer?: string
  groupId?: string
  fromSeq?: number
  toSeq?: number
  postCount?: number
  posts: BoardReceiptPost[]
  truncatedPostsCount?: number
  activeWorkingMembers: string[]
  idleCatchup?: boolean
  createdAt?: number
}
export interface BoardWakeupReceiptMeta {
  renderer?: string
  groupId?: string
  workerName?: string
  fromSeq?: number
  toSeq?: number
  postCount?: number
  posts: BoardReceiptPost[]
  truncatedPostsCount?: number
  createdAt?: number
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v !== ''
const isFinNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isNonEmptyStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isNonEmptyStr)
const optNonNegFin = (v: unknown): number | undefined => (isFinNum(v) && v >= 0 ? v : undefined)
const optNonNegInt = (v: unknown): number | undefined => (isNonNegInt(v) ? v : undefined)

const POST_KINDS = new Set(['brief', 'handoff', 'review', 'comment', 'blocker', 'done', 'stall'])
const LIVE_STATES = new Set(['idle', 'working', 'blocked', 'done', 'error', 'missing'])
const HEADLINE_TONES = new Set(['info', 'ok', 'warn', 'err'])
const HEADLINE_KINDS = new Set(['normal', 'stall', 'blocker', 'unmerged', 'closed'])

export function parseGroups(doc: SwarmIndexDoc | undefined): CollabGroupSummary[] {
  if (!Array.isArray(doc?.groups)) return []
  const valid: CollabGroupSummary[] = []
  for (const r of doc.groups) {
    if (!isPlainObject(r) || !isNonEmptyStr(r.id) || typeof r.title !== 'string' || !isPosInt(r.coordinatorConversationId)) continue
    if (r.status !== 'active' && r.status !== 'closed') continue
    valid.push({
      id: r.id, title: r.title, coordinatorConversationId: r.coordinatorConversationId, status: r.status,
      ...(r.coordinatorDetached === true ? { coordinatorDetached: true } : {}),
      activeWorkerCount: isNonNegInt(r.activeWorkerCount) ? r.activeWorkerCount : 0,
      headSeq: isNonNegInt(r.headSeq) ? r.headSeq : 0,
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
      ...(typeof r.closedAt === 'number' ? { closedAt: r.closedAt } : {}),
    })
  }
  return valid.sort((a, b) => (a.status !== b.status ? (a.status === 'active' ? -1 : 1) : b.updatedAt - a.updatedAt))
}

function parseWorktreeSnapshot(s: unknown): WorktreeHandoffSnapshot | undefined | 'invalid' {
  if (s === undefined) return undefined
  if (
    !isPlainObject(s) || !isNonEmptyStr(s.worktreeId) || (s.branch !== undefined && typeof s.branch !== 'string') ||
    (s.commitsAhead !== undefined && !isNonNegInt(s.commitsAhead)) || !isNonNegInt(s.dirtyCount) ||
    (s.additions !== undefined && !isNonNegInt(s.additions)) ||
    (s.deletions !== undefined && !isNonNegInt(s.deletions)) ||
    !Array.isArray(s.changedFilesPreview) || !s.changedFilesPreview.every((f) => typeof f === 'string')
  ) return 'invalid'
  return {
    worktreeId: s.worktreeId, ...(s.branch !== undefined ? { branch: s.branch } : {}),
    ...(s.commitsAhead !== undefined ? { commitsAhead: s.commitsAhead } : {}),
    dirtyCount: s.dirtyCount,
    ...(s.additions !== undefined ? { additions: s.additions } : {}),
    ...(s.deletions !== undefined ? { deletions: s.deletions } : {}),
    changedFilesPreview: s.changedFilesPreview,
  }
}

function parseCommonPostFields(r: Record<string, unknown>): {
  seq: number; from: string; to: string[]; kind: BoardPostKind; wake: boolean
  refs: number[]; body: string; worktreeSnapshot?: WorktreeHandoffSnapshot; createdAt: number
} | undefined {
  if (
    !isPosInt(r.seq) || !isNonEmptyStr(r.from) || !isNonEmptyStrArr(r.to) ||
    typeof r.kind !== 'string' || !POST_KINDS.has(r.kind) || typeof r.wake !== 'boolean' ||
    !Array.isArray(r.refs) || !r.refs.every(isPosInt) || typeof r.body !== 'string' ||
    !isFinNum(r.createdAt) || r.createdAt < 0
  ) return undefined
  const wt = parseWorktreeSnapshot(r.worktreeSnapshot)
  if (wt === 'invalid') return undefined
  return {
    seq: r.seq, from: r.from, to: r.to, kind: r.kind as BoardPostKind, wake: r.wake,
    refs: r.refs, body: r.body, ...(wt !== undefined ? { worktreeSnapshot: wt } : {}), createdAt: r.createdAt,
  }
}

export function parseBoardPost(r: unknown): BoardPost | undefined {
  if (!isPlainObject(r) || !isNonEmptyStr(r.groupId) || !isNonEmptyStrArr(r.resolvedTargets)) return undefined
  const base = parseCommonPostFields(r)
  if (base === undefined) return undefined
  return { ...base, groupId: r.groupId, resolvedTargets: r.resolvedTargets }
}

export function parseBoardReceiptPost(raw: unknown): BoardReceiptPost | undefined {
  if (!isPlainObject(raw) || (raw.bodyTruncated !== undefined && typeof raw.bodyTruncated !== 'boolean')) return undefined
  const base = parseCommonPostFields(raw)
  if (base === undefined) return undefined
  return { ...base, ...(raw.bodyTruncated === true ? { bodyTruncated: true } : {}) }
}

function parseMemberViewStrict(m: unknown): BoardMemberView | undefined {
  if (
    !isPlainObject(m) || !isNonEmptyStr(m.name) || !isPosInt(m.conversationId) || !isNonEmptyStr(m.profileId) ||
    (m.access !== 'readwrite' && m.access !== 'readonly') || (m.isolation !== 'worktree' && m.isolation !== 'inherit') ||
    !isNonEmptyStr(m.nodeId) || typeof m.cwd !== 'string' || (m.worktreeId !== undefined && typeof m.worktreeId !== 'string') ||
    (m.lifecycle !== 'active' && m.lifecycle !== 'archived') || typeof m.liveState !== 'string' || !LIVE_STATES.has(m.liveState) ||
    !isNonNegInt(m.readCursorSeq) || !isNonNegInt(m.pendingWakeupSeq) ||
    (m.lastPostSeq !== undefined && !isPosInt(m.lastPostSeq)) ||
    (m.lastWakeTaskSeq !== undefined && !isPosInt(m.lastWakeTaskSeq)) ||
    (m.silentExitNudgeSeq !== undefined && !isPosInt(m.silentExitNudgeSeq)) ||
    !isFinNum(m.createdAt) || (m.archivedAt !== undefined && !isFinNum(m.archivedAt)) ||
    (m.model !== undefined && typeof m.model !== 'string')
  ) return undefined
  let lastOutboundEdge: GroupMemberState['lastOutboundEdge']
  if (m.lastOutboundEdge !== undefined) {
    const e = m.lastOutboundEdge
    if (!isPlainObject(e) || !isPosInt(e.seq) || !isNonEmptyStrArr(e.to) || typeof e.kind !== 'string' || !POST_KINDS.has(e.kind)) return undefined
    lastOutboundEdge = { seq: e.seq, to: e.to, kind: e.kind as BoardPostKind }
  }
  const runDurationMs = optNonNegFin(m.runDurationMs)
  const runStartedAt = optNonNegFin(m.runStartedAt)
  const pendingAskSince = optNonNegFin(m.pendingAskSince)
  const turnCount = optNonNegInt(m.turnCount)
  return {
    name: m.name, conversationId: m.conversationId, profileId: m.profileId, access: m.access, isolation: m.isolation,
    nodeId: m.nodeId, cwd: m.cwd, lifecycle: m.lifecycle, readCursorSeq: m.readCursorSeq, pendingWakeupSeq: m.pendingWakeupSeq,
    createdAt: m.createdAt, liveState: m.liveState as MemberLiveState,
    ...(isNonEmptyStr(m.worktreeId) ? { worktreeId: m.worktreeId } : {}),
    ...(m.lastPostSeq !== undefined ? { lastPostSeq: m.lastPostSeq } : {}),
    ...(m.lastWakeTaskSeq !== undefined ? { lastWakeTaskSeq: m.lastWakeTaskSeq } : {}),
    ...(m.silentExitNudgeSeq !== undefined ? { silentExitNudgeSeq: m.silentExitNudgeSeq } : {}),
    ...(lastOutboundEdge ? { lastOutboundEdge } : {}),
    ...(runDurationMs !== undefined ? { runDurationMs } : {}),
    ...(runStartedAt !== undefined ? { runStartedAt } : {}),
    ...(pendingAskSince !== undefined ? { pendingAskSince } : {}),
    ...(turnCount !== undefined ? { turnCount } : {}),
    ...(m.archivedAt !== undefined ? { archivedAt: m.archivedAt } : {}),
    ...(isNonEmptyStr(m.model) ? { model: m.model } : {}),
  }
}

export function parseBoardView(raw: unknown): BoardViewDoc | undefined {
  if (!isPlainObject(raw) || !isPlainObject(raw.group) || !isPlainObject(raw.headline)) return undefined
  const g = raw.group
  const h = raw.headline
  if (
    !isNonEmptyStr(g.id) || typeof g.title !== 'string' || !isPosInt(g.coordinatorConversationId) ||
    (g.status !== 'active' && g.status !== 'closed') || !isNonNegInt(g.activeWorkerCount) || !isNonNegInt(g.headSeq) ||
    !isFinNum(g.createdAt) || !isFinNum(g.updatedAt) ||
    (g.objective !== undefined && typeof g.objective !== 'string') ||
    (g.coordinatorDetached !== undefined && typeof g.coordinatorDetached !== 'boolean') ||
    (g.closeSummary !== undefined && typeof g.closeSummary !== 'string') ||
    (g.closedAt !== undefined && !isFinNum(g.closedAt)) ||
    typeof h.text !== 'string' || typeof h.tone !== 'string' || !HEADLINE_TONES.has(h.tone) ||
    typeof h.kind !== 'string' || !HEADLINE_KINDS.has(h.kind) ||
    (h.targetMember !== undefined && typeof h.targetMember !== 'string') ||
    (h.refSeq !== undefined && !isPosInt(h.refSeq)) ||
    !Array.isArray(raw.members) || !Array.isArray(raw.posts) || !isNonEmptyStrArr(raw.activeWorkingMembers)
  ) return undefined

  let retainedWorktrees: RetainedWorktreeInfo[] | undefined
  if (g.retainedWorktrees !== undefined) {
    if (!Array.isArray(g.retainedWorktrees)) return undefined
    retainedWorktrees = []
    for (const w of g.retainedWorktrees) {
      if (!isPlainObject(w) || !isNonEmptyStr(w.memberName) || !isNonEmptyStr(w.nodeId) || !isNonEmptyStr(w.worktreeId) || !isNonEmptyStr(w.branch) || !isNonEmptyStr(w.path) || !isNonNegInt(w.commitsAhead)) return undefined
      retainedWorktrees.push({ memberName: w.memberName, nodeId: w.nodeId, worktreeId: w.worktreeId, branch: w.branch, path: w.path, commitsAhead: w.commitsAhead })
    }
  }
  const members: BoardMemberView[] = []
  for (const m of raw.members) {
    const parsed = parseMemberViewStrict(m)
    if (!parsed) return undefined
    members.push(parsed)
  }
  const posts: BoardPost[] = []
  for (const p of raw.posts) {
    const parsed = parseBoardPost(p)
    if (!parsed) return undefined
    posts.push(parsed)
  }
  posts.sort((a, b) => a.seq - b.seq)

  return {
    group: {
      id: g.id, title: g.title, coordinatorConversationId: g.coordinatorConversationId, status: g.status,
      activeWorkerCount: g.activeWorkerCount, headSeq: g.headSeq, createdAt: g.createdAt, updatedAt: g.updatedAt,
      ...(isNonEmptyStr(g.objective) ? { objective: g.objective } : {}),
      ...(g.coordinatorDetached === true ? { coordinatorDetached: true } : {}),
      ...(retainedWorktrees ? { retainedWorktrees } : {}),
      ...(isNonEmptyStr(g.closeSummary) ? { closeSummary: g.closeSummary } : {}),
      ...(g.closedAt !== undefined ? { closedAt: g.closedAt } : {}),
    },
    headline: {
      text: h.text, tone: h.tone as BoardHeadline['tone'], kind: h.kind as BoardHeadline['kind'],
      ...(isNonEmptyStr(h.targetMember) ? { targetMember: h.targetMember } : {}),
      ...(h.refSeq !== undefined ? { refSeq: h.refSeq } : {}),
    },
    members,
    posts,
    activeWorkingMembers: raw.activeWorkingMembers,
  }
}

export function parseBoardReadPosts(raw: unknown): BoardPost[] | undefined {
  if (!isPlainObject(raw) || !Array.isArray(raw.posts)) return undefined
  const out: BoardPost[] = []
  for (const item of raw.posts) {
    const parsed = parseBoardPost(item)
    if (!parsed) return undefined
    out.push(parsed)
  }
  return out.sort((a, b) => a.seq - b.seq)
}

export function mergeBoardViewWithRead(view: BoardViewDoc, readPosts: ReadonlyArray<BoardPost>): BoardViewDoc {
  if (readPosts.length === 0) return view
  const bySeq = new Map<number, BoardPost>(view.posts.map((p) => [p.seq, p]))
  for (const p of readPosts) bySeq.set(p.seq, p)
  return { ...view, posts: [...bySeq.values()].sort((a, b) => a.seq - b.seq) }
}

function parseReceiptBaseMeta(props: TimelineRendererProps): {
  meta: Record<string, unknown> | undefined
  renderer?: string
  groupId?: string
  fromSeq?: number
  toSeq?: number
  postCount?: number
  posts: BoardReceiptPost[]
  truncatedPostsCount?: number
  createdAt?: number
} {
  const data = isPlainObject(props.entry.data) ? props.entry.data : undefined
  const meta = data && isPlainObject(data['meta']) ? data['meta'] : undefined
  const rawCreatedAt = data?.['createdAt']
  const createdAt =
    isFinNum(rawCreatedAt) && rawCreatedAt > 0
      ? rawCreatedAt
      : isFinNum(props.entry.createdAt) && props.entry.createdAt > 0
        ? props.entry.createdAt
        : undefined
  const posts: BoardReceiptPost[] = []
  if (Array.isArray(meta?.['posts'])) {
    for (const item of meta['posts']) {
      const parsed = parseBoardReceiptPost(item)
      if (parsed !== undefined) posts.push(parsed)
    }
  }
  const renderer = isNonEmptyStr(meta?.['renderer']) ? meta['renderer'] : undefined
  const groupId = isNonEmptyStr(meta?.['groupId']) ? meta['groupId'] : undefined
  const fromSeq = isPosInt(meta?.['fromSeq']) ? meta['fromSeq'] : undefined
  const toSeq = isPosInt(meta?.['toSeq']) ? meta['toSeq'] : undefined
  const postCount = isNonNegInt(meta?.['postCount']) ? meta['postCount'] : undefined
  const truncatedPostsCount = isPosInt(meta?.['truncatedPostsCount']) ? meta['truncatedPostsCount'] : undefined
  return {
    meta,
    ...(renderer !== undefined ? { renderer } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
    ...(fromSeq !== undefined ? { fromSeq } : {}),
    ...(toSeq !== undefined ? { toSeq } : {}),
    ...(postCount !== undefined ? { postCount } : {}),
    posts,
    ...(truncatedPostsCount !== undefined ? { truncatedPostsCount } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

export function parseBoardReportMeta(props: TimelineRendererProps): BoardReportReceiptMeta {
  const { meta, ...base } = parseReceiptBaseMeta(props)
  const activeWorkingMembers = Array.isArray(meta?.['activeWorkingMembers'])
    ? meta['activeWorkingMembers'].filter(isNonEmptyStr)
    : []
  const idleCatchup = meta?.['idleCatchup'] === true ? true : undefined
  return {
    ...base,
    activeWorkingMembers,
    ...(idleCatchup ? { idleCatchup } : {}),
  }
}

export function parseBoardWakeupMeta(props: TimelineRendererProps): BoardWakeupReceiptMeta {
  const { meta, ...base } = parseReceiptBaseMeta(props)
  const workerName = isNonEmptyStr(meta?.['workerName']) ? meta['workerName'] : undefined
  return {
    ...base,
    ...(workerName !== undefined ? { workerName } : {}),
  }
}

export function selectReceiptLeadPost(
  posts: readonly BoardReceiptPost[],
  role: 'coordinator' | 'worker',
): BoardReceiptPost | undefined {
  if (posts.length === 0) return undefined
  if (role === 'coordinator') {
    for (let i = posts.length - 1; i >= 0; i -= 1) {
      const p = posts[i]!
      if (p.kind === 'blocker' || p.kind === 'stall') return p
    }
    for (let i = posts.length - 1; i >= 0; i -= 1) {
      const p = posts[i]!
      if (p.wake === true && p.to.includes('coordinator')) return p
    }
    return posts[posts.length - 1]
  }
  for (let i = posts.length - 1; i >= 0; i -= 1) {
    const p = posts[i]!
    if (p.wake === true) return p
  }
  return posts[posts.length - 1]
}

export const isReceiptDefaultOpen = (posts: readonly BoardReceiptPost[]): boolean =>
  posts.some((p) => p.kind === 'blocker' || p.kind === 'stall')

export function resolveNonDefaultWakeBadge(post: Pick<BoardPost, 'kind' | 'wake'>): 'silent' | 'woke' | undefined {
  if (post.kind === 'comment' && post.wake === true) return 'woke'
  if (post.kind !== 'comment' && post.kind !== 'stall' && post.wake === false) return 'silent'
  return undefined
}

export function formatReceiptSeqRange(fromSeq?: number, toSeq?: number): string | undefined {
  const from = isPosInt(fromSeq) ? fromSeq : undefined
  const to = isPosInt(toSeq) ? toSeq : undefined
  if (from !== undefined && to !== undefined && from !== to) return `#${from}..#${to}`
  const focus = to ?? from
  return focus !== undefined ? `#${focus}` : undefined
}

export interface ConversationBoardLink {
  groupId: string; coordinatorConversationId: number; workerName?: string
  count: number; tone: 'accent' | 'warn' | 'neutral'; footerText?: string
}

export function resolveConversationBoardLink(conversationId: number | undefined, index: SwarmIndexDoc | undefined): ConversationBoardLink | undefined {
  if (conversationId === undefined) return undefined
  const worker = Array.isArray(index?.workers) ? index.workers.find((w) => w.conversationId === conversationId && isNonEmptyStr(w.groupId)) : undefined
  const groups = parseGroups(index)
  if (worker) {
    const g = groups.find((i) => i.id === worker.groupId)
    return {
      groupId: worker.groupId,
      coordinatorConversationId: g?.coordinatorConversationId ?? (isPosInt(worker.coordinatorConversationId) ? worker.coordinatorConversationId : conversationId),
      ...(isNonEmptyStr(worker.name) ? { workerName: worker.name } : {}),
      count: g?.activeWorkerCount ?? 0,
      tone: 'neutral',
    }
  }
  const cg = groups.find((g) => g.coordinatorConversationId === conversationId)
  return cg ? { groupId: cg.id, coordinatorConversationId: cg.coordinatorConversationId, count: cg.activeWorkerCount, tone: cg.status === 'active' ? 'accent' : 'neutral' } : undefined
}

export const isMemberInFlight = (m: BoardMemberView): boolean =>
  m.lifecycle === 'active' && (m.liveState === 'working' || m.liveState === 'blocked')

export function sortBoardMembersForDisplay<T extends BoardMemberView>(members: readonly T[]): T[] {
  const rank = (m: T): number =>
    m.lifecycle !== 'active' ? 4 : m.liveState === 'blocked' ? 0 : m.liveState === 'working' ? 1 : m.liveState === 'error' ? 2 : 3
  return [...members].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

export function isMemberDelivered(m: BoardMemberView): boolean {
  if (m.lifecycle !== 'active' || m.pendingWakeupSeq > m.readCursorSeq || (m.lastPostSeq ?? 0) < (m.lastWakeTaskSeq ?? 0)) return false
  return m.liveState === 'done' || (m.liveState === 'idle' && (m.lastOutboundEdge?.kind === 'done' || m.lastOutboundEdge?.kind === 'handoff'))
}

export function boardProgressOf(members: ReadonlyArray<BoardMemberView>): { done: number; total: number } {
  const active = members.filter((m) => m.lifecycle === 'active')
  return { done: active.filter(isMemberDelivered).length, total: active.length }
}

export interface MemberActivity { post: BoardPost; direction: 'authored' | 'received' }

export function resolveMemberActivity(posts: ReadonlyArray<BoardPost>, memberName: string): MemberActivity | undefined {
  let authored: BoardPost | undefined
  let received: BoardPost | undefined
  for (const post of posts) {
    if (post.from === memberName && (!authored || post.seq > authored.seq)) authored = post
    if ((post.resolvedTargets.includes(memberName) || post.to.includes(memberName)) && (!received || post.seq > received.seq)) received = post
  }
  return authored ? { post: authored, direction: 'authored' } : received ? { post: received, direction: 'received' } : undefined
}

export function resolveMemberWorktree(posts: ReadonlyArray<BoardPost>, member: Pick<BoardMemberView, 'name'>): WorktreeHandoffSnapshot | undefined {
  let best: WorktreeHandoffSnapshot | undefined
  let bestSeq = -1
  for (const p of posts) {
    if (p.from === member.name && p.worktreeSnapshot && p.seq > bestSeq) { bestSeq = p.seq; best = p.worktreeSnapshot }
  }
  return best
}

export function extractPostRefs(post: BoardPost): number[] {
  const seen = new Set<number>()
  for (const r of post.refs) if (isPosInt(r) && r !== post.seq) seen.add(r)
  for (const m of post.body.matchAll(/(?:^|[\s(\[（【，。：；、·])#(\d+)\b/g)) {
    const num = Number(m[1])
    if (isPosInt(num) && num !== post.seq) seen.add(num)
  }
  return [...seen].sort((a, b) => a - b)
}

export function shouldCollapsePostBody(body: string): boolean {
  if (body.length > 360) return true
  let lines = 1
  for (let i = 0; i < body.length; i++) if (body[i] === '\n' && ++lines > 8) return true
  return false
}

export function previewPostBody(body: string): string {
  const sliced = body.split('\n').slice(0, 6).join('\n')
  return `${sliced.length > 320 ? sliced.slice(0, 320) : sliced}…`
}

export function postDigestLine(body: string, maxChars = 120): string {
  const first = body.split(/\r?\n/).map((l) => l.replaceAll(/\s+/g, ' ').trim()).find(Boolean) ?? ''
  return first.length <= maxChars ? first : `${first.slice(0, maxChars - 1)}…`
}

export const postKindBadgeTone = (k: BoardPostKind): 'ok' | 'err' | 'warn' | 'accent' | 'neutral' =>
  k === 'done' ? 'ok' : k === 'blocker' ? 'err' : k === 'stall' || k === 'review' ? 'warn' : k === 'brief' || k === 'handoff' ? 'accent' : 'neutral'
