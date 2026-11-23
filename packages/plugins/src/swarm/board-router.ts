/**
 * builtin:swarm pure single-board routing, wakeup/report envelopes, and view synthesis.
 */
import { HelmxError, escapeXml, type LocalizedText } from '@helmx/protocol'
import { truncate } from '../entry-text.js'
import {
  ACTIONABLE_WAKE_KINDS, COORDINATOR_ESCALATION_KINDS, swarmError, toGroupSummary,
  type BoardBadgeEntry, type BoardPost, type BoardPostKind, type BoardViewDoc, type BoardViewHeadline,
  type BoardViewMember, type CollabGroupRecord, type CollabGroupSummary, type GroupMemberState, type MemberLiveSnapshot,
} from './contracts.js'

export const MAX_BOARD_VIEW_POST_BODY_CHARS = 4_000
export const MAX_BOARD_VIEW_DOC_BYTES = 1_536 * 1024

export const ANTI_ECHO_RULE_FOOTER =
  'Anti-echo rule: If this batch is purely informational and requires no concrete action, end your turn immediately without posting pure acknowledgments or thank-yous; never treat partial member completion as full-group completion while activeWorkingMembers is non-empty.'

export interface BoardCallerIdentity { role: 'coordinator' | 'worker' | 'human' | 'system'; from: string }

export const resolveDefaultWake = (kind: BoardPostKind, to: readonly string[]): boolean => to.length > 0 && kind !== 'comment'

export function resolveBoardTargets(
  group: CollabGroupRecord,
  caller: BoardCallerIdentity,
  rawTargets: readonly string[],
  options?: { wake?: boolean },
): { normalizedTo: string[]; resolvedTargets: string[] } {
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
    throw new HelmxError('validation_error', 'board_post.to 必须是非空目标数组', 400, { groupId: group.id })
  }
  const normalizedTo: string[] = []
  const resolved: string[] = []
  const push = (target: string): void => { if (target !== caller.from && !resolved.includes(target)) resolved.push(target) }

  for (const rawItem of rawTargets) {
    if (typeof rawItem !== 'string' || !rawItem.trim()) throw new HelmxError('validation_error', 'board_post.to 含空目标项', 400, { groupId: group.id })
    const token = rawItem.trim()
    if (!normalizedTo.includes(token)) normalizedTo.push(token)

    if (token === 'coordinator') { push('coordinator'); continue }
    if (token === 'all') {
      if (caller.role === 'worker') {
        throw swarmError('swarm_broadcast_forbidden', `成员 @${caller.from} 禁止使用 'all' 全组广播；请定向点名下一跳责任人或 'coordinator'`, 403, { groupId: group.id, from: caller.from })
      }
      for (const m of group.members) if (m.lifecycle === 'active') push(m.name)
      continue
    }
    const cleanName = token.startsWith('@') ? token.slice(1) : token
    const member = group.members.find((m) => m.name === cleanName && m.lifecycle === 'active')
    if (!member) throw swarmError('swarm_unknown_target', `未知或已归档的协同目标 '${token}'`, 404, { groupId: group.id, target: token })
    push(member.name)
  }

  if (options?.wake === true && resolved.length === 0) {
    throw swarmError('swarm_no_active_targets', '收件目标剔除发帖者自身后为空，没有可唤醒的活跃目标（如仅需留档请设 wake: false）', 409, { groupId: group.id, to: normalizedTo })
  }
  return { normalizedTo, resolvedTargets: resolved }
}

function formatSinglePostBlock(post: BoardPost): string {
  const refs = post.refs.length > 0 ? ` refs=[${post.refs.map((r) => `#${r}`).join(', ')}]` : ''
  const header = `#${post.seq} [${post.kind}] @${escapeXml(post.from)} -> ${post.to.map(escapeXml).join(', ')}${refs}${post.wake ? '' : ' (wake=false)'}`
  const lines = [header, escapeXml(post.body)]
  if (post.worktreeSnapshot) {
    const s = post.worktreeSnapshot
    const parts = [
      `worktreeId=${escapeXml(s.worktreeId)}`,
      ...(s.branch !== undefined ? [`branch=${escapeXml(s.branch)}`] : []),
      ...(s.commitsAhead !== undefined ? [`commitsAhead=${s.commitsAhead}`] : []),
      `dirtyCount=${s.dirtyCount}`,
      ...(s.changedFilesPreview.length > 0 ? [`files=[${s.changedFilesPreview.map(escapeXml).join(', ')}]`] : []),
    ]
    lines.push(`  [worktree] ${parts.join(' | ')}`)
  }
  return lines.join('\n')
}

export const selectPostsForMemberWakeup = (member: GroupMemberState, posts: readonly BoardPost[], fromSeq: number, toSeq: number): BoardPost[] =>
  posts.filter((p) => p.seq >= fromSeq && p.seq <= toSeq && p.from !== member.name && p.resolvedTargets.includes(member.name))

export const selectPostsForCoordinatorReport = (posts: readonly BoardPost[], fromSeq: number, toSeq: number): BoardPost[] =>
  posts.filter((p) => p.seq >= fromSeq && p.seq <= toSeq && p.from !== 'coordinator')

function groupHeaderLines(group: CollabGroupRecord): string[] {
  return [`Group: ${escapeXml(group.title)} (${escapeXml(group.id)})`, ...(group.objective?.trim() ? [`Objective: ${escapeXml(group.objective)}`] : [])]
}

export const formatWorkerWakeupEnvelope = (input: { group: CollabGroupRecord; member: GroupMemberState; posts: readonly BoardPost[]; fromSeq: number; toSeq: number }): string =>
  [
    `<swarm_board_wakeup group="${escapeXml(input.group.id)}" worker="${escapeXml(input.member.name)}" seq="${input.fromSeq}..${input.toSeq}">`,
    ...groupHeaderLines(input.group),
    `Your role: @${escapeXml(input.member.name)} (access=${input.member.access}, isolation=${input.member.isolation})`,
    '', ...input.posts.map(formatSinglePostBlock), '',
    `Action rule: Complete the work requested of @${escapeXml(input.member.name)}, then publish your result via swarm_board_post (handoff / review / done / blocker, citing #seq in refs).`,
    ANTI_ECHO_RULE_FOOTER,
    '</swarm_board_wakeup>',
  ].join('\n')

export const formatCoordinatorReportEnvelope = (input: { group: CollabGroupRecord; posts: readonly BoardPost[]; fromSeq: number; toSeq: number; activeWorkingMembers: readonly string[] }): string =>
  [
    `<swarm_board_report group="${escapeXml(input.group.id)}" seq="${input.fromSeq}..${input.toSeq}">`,
    ...groupHeaderLines(input.group),
    `activeWorkingMembers: ${input.activeWorkingMembers.length > 0 ? input.activeWorkingMembers.map((m) => `@${escapeXml(m)}`).join(', ') : '(none)'}`,
    '', ...input.posts.map(formatSinglePostBlock), '',
    ANTI_ECHO_RULE_FOOTER,
    '</swarm_board_report>',
  ].join('\n')

export function shouldFlushCoordinatorReport(input: { group: CollabGroupRecord; posts: readonly BoardPost[]; busyMemberNames: ReadonlySet<string> }): boolean {
  const { group, posts, busyMemberNames } = input
  if (group.status !== 'active' || group.coordinatorDetached === true || group.coordinatorPendingSeq <= group.coordinatorNotifiedSeq) return false
  if (busyMemberNames.size === 0) return true
  const activeNames = new Set(group.members.filter((m) => m.lifecycle === 'active').map((m) => m.name))
  for (const post of selectPostsForCoordinatorReport(posts, group.coordinatorNotifiedSeq + 1, group.coordinatorPendingSeq)) {
    if (COORDINATOR_ESCALATION_KINDS.has(post.kind)) return true
    if (
      post.wake && ACTIONABLE_WAKE_KINDS.has(post.kind) &&
      post.resolvedTargets.includes('coordinator') &&
      !post.resolvedTargets.some((t) => t !== 'coordinator' && activeNames.has(t)) &&
      !busyMemberNames.has(post.from)
    ) return true
  }
  return false
}

export function findIdleCatchupAnchorPost(group: CollabGroupRecord, posts: readonly BoardPost[]): BoardPost | undefined {
  const activeByName = new Map(group.members.filter((m) => m.lifecycle === 'active').map((m) => [m.name, m]))
  for (let i = posts.length - 1; i >= 0; i -= 1) {
    const post = posts[i]!
    if (post.kind === 'comment') {
      if (!post.wake) {
        if (post.resolvedTargets.some((t) => { const m = activeByName.get(t); return m !== undefined && m.readCursorSeq < post.seq })) return undefined
        const sender = activeByName.get(post.from)
        if (sender?.lastWakeTaskSeq !== undefined && !posts.some((p) => p.from === sender.name && p.seq >= sender.lastWakeTaskSeq! && p.kind !== 'comment')) {
          return undefined
        }
      }
      continue
    }
    return post.kind === 'done' && group.coordinatorPendingSeq >= post.seq && group.coordinatorNotifiedSeq >= post.seq ? post : undefined
  }
  return undefined
}

function buildHeadlinePair(
  group: CollabGroupRecord,
  members: readonly BoardViewMember[],
  posts: readonly BoardPost[],
  activeWorkingMembers: readonly string[],
): { headline: BoardViewHeadline; localized: LocalizedText } {
  if (group.status === 'closed') {
    const retained = group.retainedWorktrees ?? []
    if (retained.length > 0) {
      return {
        headline: { kind: 'unmerged', tone: 'warn', text: `Group closed with ${retained.length} retained worktree branch(es) awaiting merge`, targetMember: retained[0]!.memberName },
        localized: { en: `Group closed with ${retained.length} retained worktree branch${retained.length === 1 ? '' : 'es'} awaiting merge`, 'zh-CN': `编组已结单，保留 ${retained.length} 个待合入工作树分支` },
      }
    }
    return {
      headline: { kind: 'closed', tone: 'ok', text: group.closeSummary ?? 'Swarm group closed' },
      localized: group.closeSummary?.trim() ? group.closeSummary : { en: 'Swarm group closed', 'zh-CN': '协同编组已结单' },
    }
  }

  const active = members.filter((m) => m.lifecycle === 'active')
  const errored = active.find((m) => m.liveState === 'error')
  const latest = posts[posts.length - 1]
  const flat = (s: string): string => s.replaceAll(/\s+/g, ' ').trim()

  if (latest?.kind === 'blocker') {
    const targetMember = latest.from !== 'system' && latest.from !== 'coordinator' ? latest.from : errored?.name
    const text = truncate(`#${latest.seq} [blocker] ${flat(latest.body)}`, 140)
    return { headline: { kind: 'blocker', tone: 'err', text, ...(targetMember ? { targetMember } : {}), refSeq: latest.seq }, localized: text }
  }
  if (errored) {
    const en = `Member @${errored.name} stopped in error state`
    return { headline: { kind: 'blocker', tone: 'err', text: en, targetMember: errored.name }, localized: { en, 'zh-CN': `成员 @${errored.name} 因错误停止` } }
  }
  if (latest?.kind === 'stall' && activeWorkingMembers.length === 0) {
    const matchMember = latest.body.match(/@([a-z][a-z0-9_-]{0,31})/)?.[1]
    const text = truncate(`#${latest.seq} [stall] ${flat(latest.body)}`, 140)
    return { headline: { kind: 'stall', tone: 'warn', text, ...(matchMember ? { targetMember: matchMember } : {}), refSeq: latest.seq }, localized: text }
  }
  if (activeWorkingMembers.length > 0) {
    const list = activeWorkingMembers.map((m) => `@${m}`).join(', ')
    return { headline: { kind: 'normal', tone: 'info', text: `Active: ${list}`, targetMember: activeWorkingMembers[0]! }, localized: { en: `Active: ${list}`, 'zh-CN': `执行中：${list}` } }
  }
  for (let i = posts.length - 1; i >= 0; i -= 1) {
    const p = posts[i]!
    if (p.kind !== 'done') continue
    const text = truncate(`#${p.seq} [done] @${p.from}: ${flat(p.body)}`, 140)
    return { headline: { kind: 'normal', tone: 'ok', text, ...(p.from !== 'coordinator' && p.from !== 'system' ? { targetMember: p.from } : {}), refSeq: p.seq }, localized: text }
  }
  if (active.length === 0) {
    const en = 'Group ready — dispatch peer roles to start collaboration'
    return { headline: { kind: 'normal', tone: 'info', text: en }, localized: { en, 'zh-CN': '编组已就绪 — 请派工对等成员开始协同' } }
  }
  return {
    headline: { kind: 'normal', tone: 'info', text: `${active.length} active member(s) idle` },
    localized: { en: `${active.length} active member${active.length === 1 ? '' : 's'} idle`, 'zh-CN': `${active.length} 名活跃成员空闲待命` },
  }
}

export const synthesizeHeadline = (group: CollabGroupRecord, members: readonly BoardViewMember[], posts: readonly BoardPost[], activeWorkingMembers: readonly string[]): BoardViewHeadline =>
  buildHeadlinePair(group, members, posts, activeWorkingMembers).headline

function slimPostForBoardView(post: BoardPost): BoardPost {
  const body = post.body.length > MAX_BOARD_VIEW_POST_BODY_CHARS ? truncate(post.body, MAX_BOARD_VIEW_POST_BODY_CHARS) : post.body
  const snapshot = post.worktreeSnapshot
    ? {
        ...post.worktreeSnapshot,
        changedFilesPreview: post.worktreeSnapshot.changedFilesPreview.slice(0, 20).map((f) => truncate(f, 240)),
      }
    : undefined
  if (body === post.body && snapshot === undefined) return post
  return {
    ...post,
    body,
    ...(snapshot !== undefined ? { worktreeSnapshot: snapshot } : {}),
  }
}

export function buildBoardViewDoc(input: {
  group: CollabGroupRecord
  summary?: CollabGroupSummary
  headline: BoardViewHeadline
  members: BoardViewMember[]
  posts: readonly BoardPost[]
  previewLimit: number
  activeWorkingMembers: string[]
  maxBytes?: number
}): BoardViewDoc {
  const { group, headline, members, posts, previewLimit, activeWorkingMembers } = input
  const summary = input.summary ?? toGroupSummary(group)
  const maxBytes = input.maxBytes ?? MAX_BOARD_VIEW_DOC_BYTES
  const previewPosts = posts.slice(-Math.max(0, previewLimit)).map(slimPostForBoardView)
  const baseGroup: BoardViewDoc['group'] = {
    ...summary,
    ...(group.objective !== undefined ? { objective: truncate(group.objective, MAX_BOARD_VIEW_POST_BODY_CHARS) } : {}),
    ...(group.retainedWorktrees ? { retainedWorktrees: group.retainedWorktrees.map((rw) => ({ ...rw })) } : {}),
    ...(group.closeSummary !== undefined ? { closeSummary: truncate(group.closeSummary, MAX_BOARD_VIEW_POST_BODY_CHARS) } : {}),
  }
  let view: BoardViewDoc = {
    group: baseGroup,
    headline,
    members,
    posts: previewPosts,
    activeWorkingMembers,
  }
  if (Buffer.byteLength(JSON.stringify(view), 'utf8') > maxBytes) {
    const trimmed = [...previewPosts]
    while (trimmed.length > 0 && Buffer.byteLength(JSON.stringify({ ...view, posts: trimmed }), 'utf8') > maxBytes) {
      const dropCount = trimmed.length > 8 ? Math.max(1, Math.floor(trimmed.length / 4)) : 1
      trimmed.splice(0, dropCount)
    }
    view = { ...view, posts: trimmed }
  }
  return view
}

export function synthesizeBoardView(input: {
  group: CollabGroupRecord; posts: readonly BoardPost[]; previewLimit: number; resolveMemberLive: (id: number) => MemberLiveSnapshot
}): { view: BoardViewDoc; digest: string; badge: BoardBadgeEntry; localizedHeadline: LocalizedText } {
  const { group, posts, previewLimit, resolveMemberLive } = input
  const members: BoardViewMember[] = group.members.map((m) => {
    const live = resolveMemberLive(m.conversationId)
    const archived = m.lifecycle === 'archived' || group.status === 'closed'
    const runDurationMs = archived ? (m.runDurationMs ?? live.runDurationMs) : (live.runDurationMs ?? m.runDurationMs)
    const turnCount = archived ? (m.turnCount ?? live.turnCount) : (live.turnCount ?? m.turnCount)
    const liveActive = !archived && live.liveState !== 'missing'
    return {
      ...m,
      ...(m.lastOutboundEdge ? { lastOutboundEdge: { ...m.lastOutboundEdge, to: [...m.lastOutboundEdge.to] } } : {}),
      liveState: live.liveState,
      ...(live.model !== undefined ? { model: live.model } : {}),
      ...(runDurationMs !== undefined ? { runDurationMs } : {}),
      ...(liveActive && live.runStartedAt !== undefined ? { runStartedAt: live.runStartedAt } : {}),
      ...(liveActive && live.pendingAskSince !== undefined ? { pendingAskSince: live.pendingAskSince } : {}),
      ...(turnCount !== undefined ? { turnCount } : {}),
    }
  })
  const activeWorkingMembers = members.filter((m) => m.lifecycle === 'active' && (m.liveState === 'working' || m.liveState === 'blocked')).map((m) => m.name)
  const { headline, localized: localizedHeadline } = buildHeadlinePair(group, members, posts, activeWorkingMembers)
  const summary = toGroupSummary(group)
  const view = buildBoardViewDoc({ group, summary, headline, members, posts, previewLimit, activeWorkingMembers })

  const digest = JSON.stringify({
    headSeq: group.headSeq, status: group.status, title: group.title, objective: group.objective ?? '',
    coordinatorDetached: Boolean(group.coordinatorDetached), retainedWorktrees: group.retainedWorktrees ?? [],
    closeSummary: group.closeSummary ?? '', closedAt: group.closedAt ?? 0, previewLimit,
    members: members.map((m) => [
      m.name, m.lifecycle, m.liveState, m.model ?? '', m.access, m.isolation, m.worktreeId ?? '',
      m.readCursorSeq, m.pendingWakeupSeq, m.lastPostSeq ?? 0, m.lastWakeTaskSeq ?? 0, m.silentExitNudgeSeq ?? 0,
      m.runDurationMs ?? -1, m.runStartedAt ?? -1, m.pendingAskSince ?? -1, m.turnCount ?? -1,
    ]),
  })

  const hasWarn = headline.kind === 'stall' || headline.kind === 'blocker' || members.some((m) => m.lifecycle === 'active' && m.liveState === 'error')
  const tone: BoardBadgeEntry['tone'] = hasWarn ? 'warn' : activeWorkingMembers.length > 0 ? 'accent' : 'neutral'
  const footerText: LocalizedText | undefined = hasWarn
    ? localizedHeadline
    : activeWorkingMembers.length > 0
      ? { en: `${activeWorkingMembers.length} working`, 'zh-CN': `${activeWorkingMembers.length} 项执行中` }
      : undefined

  return { view, digest, badge: { groupId: group.id, coordinatorConversationId: group.coordinatorConversationId, count: summary.activeWorkerCount, tone, ...(footerText ? { footerText } : {}) }, localizedHeadline }
}
