/**
 * 会话总览纯函数入口（根会话树卡片构造 + 子模块导出）：
 * 具体实现按职责拆分至 `overview-types` / `overview-filters` /
 * `overview-timing` / `sidebar-working-set`，本模块保留卡片构造逻辑与统一导出。
 */
import type { ConversationSummary, Profile } from '@helmx/protocol/browser'
import { isConversationArchived } from '../conversation/archive-model.js'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import type { PluginActivityLike } from '../lib/live-state.js'
import {
  collectEnabledPluginIds,
  isProfileVisible,
  type ConversationBackgroundIndex,
} from '../shell/conversation-status-model.js'
import { resolveNotificationRootId } from '../shell/quiet-notify-model.js'
import {
  aggregateAttentionTrees,
  composeHonestTreeSummary,
} from '../shell/attention-model.js'
import {
  OVERVIEW_DESCENDANT_LIMIT,
  type OverviewCard,
  type OverviewCardBucket,
  type OverviewDescendant,
} from './overview-types.js'

export * from './overview-types.js'
export * from './overview-filters.js'
export * from './overview-timing.js'
export * from './sidebar-working-set.js'

const CARD_BUCKET_ORDER: Record<OverviewCardBucket, number> = {
  needs_attention: 0,
  running: 1,
  unread_done: 2,
  quiet: 3,
  archived: 4,
}

/** 判断单条后代会话是否带有活跃或需关注信号（working / blocked / error / 待答 Ask / 后台在途）。 */
export function isOverviewDescendantActive(descendant: OverviewDescendant): boolean {
  const { conv, backgroundActive } = descendant
  return (
    conv.status === 'working' ||
    conv.status === 'blocked' ||
    conv.status === 'error' ||
    backgroundActive ||
    conv.pendingAskCount > 0
  )
}

function sortOverviewDescendants(
  members: ReadonlyArray<ConversationSummary>,
  rootId: number,
  background: ConversationBackgroundIndex,
): OverviewDescendant[] {
  const byId = new Map(members.map((member) => [member.id, member] as const))
  const byParent = new Map<number, ConversationSummary[]>()
  for (const member of members) {
    if (member.parentConversationId === undefined) continue
    const siblings = byParent.get(member.parentConversationId)
    if (siblings === undefined) byParent.set(member.parentConversationId, [member])
    else siblings.push(member)
  }

  const makeEntry = (member: ConversationSummary): OverviewDescendant => ({
    conv: member,
    backgroundActive: background.get(member.id)?.active === true,
  })
  const directChildren = byParent.get(rootId) ?? []
  const directIds = new Set(directChildren.map((child) => child.id))
  const directEntries = directChildren.map((member) => {
    const subtree = new Set<number>()
    const queue = [member.id]
    let subtreeActiveCount = 0
    let subtreeErrorCount = 0
    let subtreeWaitingCount = 0
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]!
      if (subtree.has(current)) continue
      subtree.add(current)
      const candidate = byId.get(current)
      if (candidate !== undefined) {
        if (candidate.status === 'error') subtreeErrorCount += 1
        if (candidate.status === 'blocked' || candidate.pendingAskCount > 0) subtreeWaitingCount += 1
        if (candidate.status === 'working' || candidate.status === 'blocked' || background.get(candidate.id)?.active === true) {
          subtreeActiveCount += 1
        }
      }
      for (const child of byParent.get(current) ?? []) queue.push(child.id)
    }
    return {
      ...makeEntry(member),
      direct: true,
      subtreeActiveCount,
      subtreeErrorCount,
      subtreeWaitingCount,
      subtreeDescendantCount: Math.max(0, subtree.size - 1),
      subtreeConversationIds: [...subtree],
    }
  })
  const deeperEntries = members
    .filter((member) => member.id !== rootId && !directIds.has(member.id))
    .map(makeEntry)
  const allEntries = [...directEntries, ...deeperEntries]
  allEntries.sort((a, b) => {
    const aSignal = isOverviewDescendantActive(a)
    const bSignal = isOverviewDescendantActive(b)
    if (aSignal !== bSignal) return aSignal ? -1 : 1
    return b.conv.createdAt - a.conv.createdAt || b.conv.id - a.conv.id
  })
  return allEntries
}

/** 构建总览卡片（全部未归档根树，含安静树）：排序为桶序 + root.createdAt 倒序。 */
export function buildOverviewCards(input: {
  conversations: ReadonlyArray<ConversationSummary>
  background: ConversationBackgroundIndex
  profiles: ReadonlyArray<Profile>
  plugins: ReadonlyArray<{ id: string } & PluginActivityLike>
  viewedConversationIds?: ReadonlySet<number>
  t: WebMessageTranslator
}): OverviewCard[] {
  const { t } = input
  const profileNames = new Map(input.profiles.map((profile) => [profile.id, profile.name] as const))
  const cards: OverviewCard[] = []
  for (const aggregate of aggregateAttentionTrees(input)) {
    const descendants = sortOverviewDescendants(aggregate.members, aggregate.root.id, input.background)
    const directDescendants = [...descendants.filter((descendant) => descendant.direct === true)].sort((a, b) =>
      ((b.subtreeErrorCount ?? 0) > 0 || (b.subtreeWaitingCount ?? 0) > 0 ? 1 : (b.subtreeActiveCount ?? 0) > 0 ? 0 : -1) -
        ((a.subtreeErrorCount ?? 0) > 0 || (a.subtreeWaitingCount ?? 0) > 0 ? 1 : (a.subtreeActiveCount ?? 0) > 0 ? 0 : -1) ||
      a.conv.createdAt - b.conv.createdAt ||
      a.conv.id - b.conv.id,
    )
    cards.push({
      root: aggregate.root,
      bucket: aggregate.bucket ?? 'quiet',
      hasWaiting: aggregate.hasWaiting,
      hasError: aggregate.hasError,
      representative: aggregate.representative,
      backgroundActive: aggregate.backgroundActive,
      backgroundSummary: aggregate.backgroundSummary,
      activeDescendantCount: aggregate.activeDescendantCount,
      targetConversationId: aggregate.targetConversationId,
      profileLabel: profileNames.get(aggregate.root.profileId) ?? aggregate.root.profileId,
      summaryText: composeHonestTreeSummary({
        representative: aggregate.representative,
        root: aggregate.root,
        backgroundActive: aggregate.backgroundActive,
        backgroundSummary: aggregate.backgroundSummary,
        activeDescendantCount: aggregate.activeDescendantCount,
        t,
      }),
      automated: aggregate.root.ownedBy === 'helmx',
      memberIds: aggregate.members.map((member) => member.id),
      descendants,
      directDescendants,
      hiddenDescendantCount: Math.max(0, descendants.length - OVERVIEW_DESCENDANT_LIMIT),
    })
  }
  return cards.sort(
    (a, b) =>
      CARD_BUCKET_ORDER[a.bucket] - CARD_BUCKET_ORDER[b.bucket] ||
      b.root.createdAt - a.root.createdAt ||
      b.root.id - a.root.id,
  )
}

/** 构建「已归档」总览卡片（仅收人类自有已归档根会话树）。 */
export function buildArchivedOverviewCards(input: {
  conversations: ReadonlyArray<ConversationSummary>
  background: ConversationBackgroundIndex
  profiles: ReadonlyArray<Profile>
  plugins: ReadonlyArray<{ id: string } & PluginActivityLike>
}): OverviewCard[] {
  const byId = new Map<number, ConversationSummary>(
    input.conversations.map((conversation) => [conversation.id, conversation] as const),
  )
  const enabledPluginIds = collectEnabledPluginIds(input.plugins)
  const profileNames = new Map(input.profiles.map((profile) => [profile.id, profile.name] as const))

  const trees = new Map<number, ConversationSummary[]>()
  for (const conversation of input.conversations) {
    const rootId = resolveNotificationRootId(byId, conversation.id)
    const members = trees.get(rootId)
    if (members) members.push(conversation)
    else trees.set(rootId, [conversation])
  }

  const cards: OverviewCard[] = []
  for (const [rootId, members] of trees) {
    const root = byId.get(rootId)
    if (root === undefined) continue
    if (!isConversationArchived(root)) continue
    if (root.parentConversationId !== undefined) continue
    if ((root.ownedBy ?? 'human') !== 'human') continue
    const rootProfile = input.profiles.find((profile) => profile.id === root.profileId)
    if (rootProfile !== undefined && !isProfileVisible(rootProfile, enabledPluginIds)) continue

    const descendants = sortOverviewDescendants(members, root.id, input.background)
    const directDescendants = descendants.filter((descendant) => descendant.direct === true)
    cards.push({
      root,
      bucket: 'archived',
      hasWaiting: false,
      hasError: false,
      representative: root,
      backgroundActive: false,
      backgroundSummary: '',
      activeDescendantCount: 0,
      targetConversationId: root.id,
      profileLabel: profileNames.get(root.profileId) ?? root.profileId,
      summaryText: '',
      automated: false,
      memberIds: members.map((member) => member.id),
      descendants,
      directDescendants,
      hiddenDescendantCount: Math.max(0, descendants.length - OVERVIEW_DESCENDANT_LIMIT),
    })
  }
  return cards.sort((a, b) => b.root.createdAt - a.root.createdAt || b.root.id - a.root.id)
}
