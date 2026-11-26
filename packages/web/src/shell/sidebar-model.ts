/**
 * 侧栏「智能体站位」与插件资产可见性纯函数：
 * 从全量 Profile / 会话 / 插件 UI 贡献推导「每个 Agent 一个固定站位 + 下挂各自历史对话」，
 * 并按插件启用状态判定自举 Profile / Skill 的显隐。
 * 纯函数无 React 依赖，供 Sidebar / 各编辑弹窗渲染与单测共同消费。
 */

import type {
  ConversationSummary,
  HelmxLocale,
  LocalizedText,
  Profile,
  ScreenSpec,
  SidebarBadgeTone,
  SidebarItemBadgeSpec,
  SidebarItemSpec,
  SkillSummary,
} from '@helmx/protocol/browser'
import { parseLocalizedText, resolveLocalizedText } from '@helmx/protocol/browser'
import { isPluginSummaryActive, type PluginActivityLike } from '../lib/live-state.js'
import type { HelmxStoreValue, QualifiedUiSpec, ResolvedTarget } from '../lib/types.js'
import { resolveTargetString } from '../lib/types.js'
import { isConversationArchived } from '../conversation/archive-model.js'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import { resolveFocusedPanel } from './shortcuts-model.js'

export interface SidebarPartition {
  /** sidebar.item 的 'conversation:profile:<id>' 已指向的 profileId 集合。 */
  pinnedProfileIds: Set<string>
  /** sidebar.item 的 'conversation:<id>' 已指向的会话 ID 集合。 */
  pinnedConversationIds: Set<number>
}

/** 从 UI 贡献中提取 sidebar.item 的去重规则输入。 */
export function partitionSidebarUi(
  sidebarItems: Array<QualifiedUiSpec<SidebarItemSpec>>,
): SidebarPartition {
  const pinnedProfileIds = new Set<string>()
  const pinnedConversationIds = new Set<number>()

  for (const item of sidebarItems) {
    const target = item.spec.target
    if (!target) continue
    if (target.startsWith('conversation:profile:')) {
      const pid = target.slice('conversation:profile:'.length).trim()
      if (pid) pinnedProfileIds.add(pid)
    } else if (target.startsWith('conversation:')) {
      const rest = target.slice('conversation:'.length).trim()
      if (rest.startsWith('profile:') || rest.startsWith('tag:')) continue
      const idNum = Number(rest)
      if (Number.isInteger(idNum) && idNum > 0) pinnedConversationIds.add(idNum)
    }
  }
  return { pinnedProfileIds, pinnedConversationIds }
}

/** 按标签过滤会话列表。 */
export function filterConversationsByTag(conversations: ConversationSummary[], tag: string): ConversationSummary[] {
  return conversations.filter((c) => c.tags.includes(tag))
}

// ---------------------------------------------------------------------------
// 人工归档（Web 宿主策略）：宿主命名空间 tag + 现有会话 PATCH
// ---------------------------------------------------------------------------

/**
 * 会话是否可被人工归档管理（与删除保护同界）：
 * - 子代理派生会话（有父链）与 helmx 托管会话不参与——归档是人类整理行为。
 * 当前已归档的会话本函数仍可能返回 true（可管理性），菜单按归档态选择动作。
 */
export function isConversationArchivable(
  conv: Pick<ConversationSummary, 'parentConversationId' | 'ownedBy' | 'tags'>,
): boolean {
  if (conv.parentConversationId !== undefined) return false
  if ((conv.ownedBy ?? 'human') !== 'human') return false
  return true
}

/**
 * 批量删除勾选口径（比归档口径宽、比在途自动化会话严）：
 * - 人类自有根会话（即归档口径）全部可批量删除；
 * - 自动化归属（helmx）的历史会话（如已结束协作的 swarm worker）：不在途
 *   （非 working/blocked）时放开批量删除——插件 manageConversation 托管保护
 *   由服务端 bulk-delete 逐项权威判定（409 failures）；
 * - 仅放开批量删除，不放开批量归档（归档仍走 isConversationArchivable 人类口径）。
 */
export function isConversationBulkDeletable(
  conv: Pick<ConversationSummary, 'parentConversationId' | 'ownedBy' | 'tags' | 'status'>,
): boolean {
  if (conv.parentConversationId !== undefined) return false
  if ((conv.ownedBy ?? 'human') === 'human') return true
  return conv.status !== 'working' && conv.status !== 'blocked'
}

/** 批量管理勾选口径：可归档（人类）或可批量删除（含空闲自动化历史会话）的并集。 */
export function isConversationBulkSelectable(conv: ConversationSummary): boolean {
  return isConversationArchivable(conv) || isConversationBulkDeletable(conv)
}

/** 过滤出批量管理可勾选的会话列表（勾选边界，非删除边界）。 */
export function filterBulkSelectableConversations(
  conversations: ConversationSummary[],
): ConversationSummary[] {
  return conversations.filter(isConversationBulkSelectable)
}

// ---------------------------------------------------------------------------
// 智能体站位（Agent Standings，供「新话题」候选角色排序消费）
// ---------------------------------------------------------------------------

/** 左栏一级「智能体站位」：每个 Agent 一个固定站位，下挂其名下有效对话。 */
export interface AgentStanding {
  /** Agent 对应的 Profile ID（如 'assistant' | 自定义 id）。 */
  profileId: string
  /** 左栏展示名（优先 sidebar.item 的 label -> profile.name -> profile.id）。 */
  label: string
  /** 排序权重（根会话/assistant 为 0，sidebar.item 指定 order 次之，其余 Profile 默认 100，孤儿兜底 200）。 */
  order: number
  /** 是否允许人类在该 Agent 下新建多个对话（由 isHumanSelectableProfile 决定；常驻单例为 false）。 */
  canCreateConversation: boolean
  /** 该 Agent 名下的所有有效对话（常驻/根会话置顶，其余按 createdAt 倒序）。 */
  conversations: ConversationSummary[]
  /** 点击该 Agent 站位时的主对话（即 conversations[0] ?? null）。 */
  primaryConversation: ConversationSummary | null
}

/** 左栏独立「视图」分组的导航项（screen: 类型 sidebar.item 分流产物）。 */
export interface SidebarViewItem {
  key: string
  pluginId: string
  label: string
  icon: string
  order: number
  target: ResolvedTarget
  /** 声明型注意力徽标（sidebar.item badge）：宿主按其 doc 声明订阅并渲染通用计数徽标/静默灯点。 */
  badge?: SidebarItemBadgeSpec
}

export interface AgentStandingsInput {
  profiles: Profile[]
  conversations: ConversationSummary[]
  plugins: ReadonlyArray<{ id: string } & PluginActivityLike>
  sidebarItems?: Array<QualifiedUiSpec<SidebarItemSpec>>
  /** 显示名解析 locale（sidebar.item label 属 LocalizedText 显示元数据）。 */
  locale: HelmxLocale
}

/** 左栏展示名的 pin 元信息（按 profileId 归集；label 为未解析的 LocalizedText 显示元数据）。 */
interface SidebarPinMeta {
  label?: LocalizedText
  order?: number
}

/**
 * 构建左栏智能体站位列表：
 * - 可见 Profile 各占一个一级站位；未加载资产的会话按实际 profileId 展示；
 * - 会话指向型 sidebar.item 的 label/order 覆盖对应站位的默认展示；
 * - 人类自由会话按 profileId 归集到各自 Agent 下（Profile 已删时生成孤儿兜底站位）；
 * - 插件停用后其 managedByPlugin 站位与 ownedBy=helmx 遗留会话自动隐藏。
 */
export function buildAgentStandings(input: AgentStandingsInput): AgentStanding[] {
  const { profiles, conversations, plugins, sidebarItems = [], locale } = input
  const enabledPluginIds = collectEnabledPluginIds(plugins)
  const partition = partitionSidebarUi(sidebarItems)

  const visibleProfiles = profiles.filter((p) => isProfileVisible(p, enabledPluginIds))
  const visibleProfileIds = new Set(visibleProfiles.map((p) => p.id))

  // sidebar.item 会话指向项 -> profileId 展示元信息（screen: 视图项在此分流，不进站位）。
  const pinMeta = new Map<string, SidebarPinMeta>()
  const convById = new Map(conversations.map((c) => [c.id, c] as const))
  for (const item of sidebarItems) {
    const target = item.spec.target
    if (!target) continue
    let pid: string | null = null
    if (target.startsWith('conversation:profile:')) {
      pid = target.slice('conversation:profile:'.length).trim() || null
    } else if (target.startsWith('conversation:')) {
      const rest = target.slice('conversation:'.length).trim()
      if (/^\d+$/.test(rest)) {
        const idNum = Number(rest)
        pid = convById.get(idNum)?.profileId ?? null
      }
    }
    if (pid && !pinMeta.has(pid)) {
      pinMeta.set(pid, { label: item.spec.label, order: item.spec.order })
    }
  }

  // 可挂到 Agent 站位下的会话：
  // 1. 排除子代理派生会话（有父链）；
  // 2. 排除已人工归档会话（集中进「已归档」分组，绝不同时出现在活跃列表）；
  // 3. 非 human 会话仅保留可见 Profile 的常驻会话（ownedBy=helmx 或被启用 sidebar.item 指向）。
  const attachable = conversations.filter((c) => {
    if (c.parentConversationId !== undefined) return false
    if (isConversationArchived(c)) return false
    if ((c.ownedBy ?? 'human') === 'human') return true
    return (
      visibleProfileIds.has(c.profileId) &&
      (c.ownedBy === 'helmx' ||
        partition.pinnedConversationIds.has(c.id) ||
        partition.pinnedProfileIds.has(c.profileId))
    )
  })

  const byProfile = new Map<string, ConversationSummary[]>()
  const orphanProfileIds = new Set<string>()
  for (const c of attachable) {
    const list = byProfile.get(c.profileId)
    if (list) list.push(c)
    else byProfile.set(c.profileId, [c])
    // 孤儿 Profile：人类历史对话的 Profile 已被删除（非被停用插件隐藏），兜底生成站位防丢失。
    if (
      (c.ownedBy ?? 'human') === 'human' &&
      !visibleProfileIds.has(c.profileId) &&
      !profiles.some((p) => p.id === c.profileId)
    ) {
      orphanProfileIds.add(c.profileId)
    }
  }

  // 站位内排序：常驻会话置顶，其余按创建时间倒序（同刻按 id 倒序）——
  // 刻意不用 updatedAt：AI 正在输出会持续推进 updatedAt，若作为排序键历史对话会不停跳位。
  const residentTier = (c: ConversationSummary): number => {
    if (c.ownedBy === 'helmx') return 1
    if (partition.pinnedConversationIds.has(c.id)) return 2
    return 3
  }
  const sortAgentConversations = (list: ConversationSummary[]): ConversationSummary[] =>
    [...list].sort((a, b) => {
      const ta = residentTier(a)
      const tb = residentTier(b)
      if (ta !== tb) return ta - tb
      if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt
      return b.id - a.id
    })

  const standings: AgentStanding[] = []
  const emitStanding = (
    profileId: string,
    profile: Profile | undefined,
    meta: SidebarPinMeta | undefined,
    order: number,
    canCreateConversation: boolean,
  ): void => {
    const sorted = sortAgentConversations(byProfile.get(profileId) ?? [])
    standings.push({
      profileId,
      label:
        (meta?.label !== undefined ? resolveLocalizedText(meta.label, locale) : '') ||
        profile?.name ||
        profileId,
      order,
      canCreateConversation,
      conversations: sorted,
      primaryConversation: sorted[0] ?? null,
    })
  }

  for (const profile of visibleProfiles) {
    const meta = pinMeta.get(profile.id)
    const order = meta?.order ?? 100
    emitStanding(profile.id, profile, meta, order, isHumanSelectableProfile(profile, enabledPluginIds))
  }
  for (const pid of orphanProfileIds) {
    const meta = pinMeta.get(pid)
    emitStanding(pid, undefined, meta, meta?.order ?? 200, false)
  }

  standings.sort((a, b) => a.order - b.order || a.profileId.localeCompare(b.profileId))
  return standings
}

/**
 * 提取 sidebar.item 中声明 quickEntry 的全局快捷入口（供 Activity Rail 与
 * 移动抽屉渲染）：仅收 screen: 目标且目标 screen 确实存在于当前启用插件的
 * screen 贡献中（插件停用后贡献即时消失，入口随之消失，无需特判插件 ID）。
 * 排序 order 升序（缺省 100），同序按 key 字典序；点击走标准 store 路由。
 */
export function extractRailQuickEntries(
  sidebarItems: Array<QualifiedUiSpec<SidebarItemSpec>>,
  screens: ReadonlyArray<QualifiedUiSpec<ScreenSpec>>,
  conversations: ConversationSummary[],
  locale: HelmxLocale,
): SidebarViewItem[] {
  const screenKeys = new Set(screens.map((screen) => `${screen.pluginId}/${screen.spec.id}`))
  const entries: SidebarViewItem[] = []
  for (const item of sidebarItems) {
    if (item.spec.quickEntry !== true) continue
    const target = item.spec.target
    if (!target) continue
    const resolved = resolveTargetString(target, conversations)
    if (resolved?.kind !== 'screen') continue
    if (!screenKeys.has(`${resolved.pluginId}/${resolved.screenId}`)) continue
    entries.push({
      key: `${item.pluginId}/${item.spec.id}`,
      pluginId: item.pluginId,
      label: resolveLocalizedText(item.spec.label, locale),
      icon: item.spec.icon ?? 'panel-right',
      order: item.spec.order ?? 100,
      target: resolved,
      badge: item.spec.badge,
    })
  }
  return entries.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
}

/**
 * 提取 sidebar.item 中 target 解析为 screen: 的视图导航项，
 * 供左栏独立「视图」分组渲染（与智能体站位彻底分流）。
 * label 属 LocalizedText 显示元数据，按传入 locale 解析。
 */
export function extractSidebarViews(
  sidebarItems: Array<QualifiedUiSpec<SidebarItemSpec>>,
  conversations: ConversationSummary[],
  locale: HelmxLocale,
): SidebarViewItem[] {
  const views: SidebarViewItem[] = []
  for (const item of sidebarItems) {
    const target = item.spec.target
    if (!target) continue
    const resolved = resolveTargetString(target, conversations)
    if (resolved?.kind !== 'screen') continue
    views.push({
      key: `${item.pluginId}/${item.spec.id}`,
      pluginId: item.pluginId,
      label: resolveLocalizedText(item.spec.label, locale),
      icon: item.spec.icon ?? 'panel-right',
      order: item.spec.order ?? 100,
      target: resolved,
      badge: item.spec.badge,
    })
  }
  return views.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
}

// ---------------------------------------------------------------------------
// 侧栏视图徽标（sidebar.item badge 声明）：纯解析函数，零 React 依赖
// ---------------------------------------------------------------------------

/** 徽标解析结果：count > 0 为计数徽标；dot 为静默灯点（无计数）；两者皆无即 null（零视觉噪音）。 */
export interface ResolvedSidebarBadge {
  count: number
  tone: SidebarBadgeTone
  dot: boolean
  summary: string
}

/** 徽标订阅的插件 doc 引用（去重后由宿主 Hook 经 ensurePluginDoc 按需加载）。 */
export interface SidebarBadgeDocRef {
  pluginId: string
  doc: string
}

const SIDEBAR_BADGE_TONES: ReadonlySet<string> = new Set(['error', 'warn', 'accent', 'ok', 'neutral'])

/** 安全读取 doc 顶层字段（非普通对象一律视为缺省，绝不解析数组/标量）。 */
function readBadgeDocField(docValue: unknown, field: string): unknown {
  if (docValue === null || typeof docValue !== 'object' || Array.isArray(docValue)) return undefined
  return (docValue as Record<string, unknown>)[field]
}

/**
 * 解析单个 sidebar.item 徽标（声明 + 该插件 doc 当前值 -> 渲染事实）：
 * - count > 0：`{ count, tone: 有效 tone ?? 'warn', dot: false, summary }`；
 * - count 为 0/缺省且 dotField 声明且 doc[dotField] === true：静默灯点
 *   `{ count: 0, tone: 有效 tone ?? 'accent', dot: true, summary }`；
 * - 其余一律 null——无信号即无视觉残留（含 doc 未加载/插件停用后贡献消失）。
 * - summary：doc[summaryField] 为 LocalizedText 或非空字符串时按 locale 解析。
 */
export function resolveSidebarItemBadge(
  badge: SidebarItemBadgeSpec,
  docValue: unknown,
  locale: HelmxLocale,
): ResolvedSidebarBadge | null {
  const rawCount = readBadgeDocField(docValue, badge.countField)
  const count = typeof rawCount === 'number' && Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 0
  const rawTone = badge.toneField !== undefined ? readBadgeDocField(docValue, badge.toneField) : undefined
  const tone = typeof rawTone === 'string' && SIDEBAR_BADGE_TONES.has(rawTone) ? (rawTone as SidebarBadgeTone) : undefined
  let summary = ''
  if (badge.summaryField !== undefined) {
    const rawSummary = readBadgeDocField(docValue, badge.summaryField)
    if (typeof rawSummary === 'string' && rawSummary.trim() !== '') {
      summary = rawSummary.trim()
    } else if (parseLocalizedText(rawSummary) !== undefined) {
      summary = resolveLocalizedText(rawSummary as LocalizedText, locale).trim()
    }
  }
  if (count > 0) {
    return { count, tone: tone ?? 'warn', dot: false, summary }
  }
  if (badge.dotField !== undefined && readBadgeDocField(docValue, badge.dotField) === true) {
    return { count: 0, tone: tone ?? 'accent', dot: true, summary }
  }
  return null
}

/**
 * 收集视图项徽标需要订阅的插件 doc 引用（按 `${pluginId}/${doc}` 去重）。
 * 插件停用后其 UI 贡献与 doc 都从 store 消失，徽标随引用自然归零。
 */
export function collectSidebarBadgeDocs(items: ReadonlyArray<SidebarViewItem>): SidebarBadgeDocRef[] {
  const seen = new Set<string>()
  const refs: SidebarBadgeDocRef[] = []
  for (const item of items) {
    const badge = item.badge
    if (badge === undefined) continue
    const key = `${item.pluginId}/${badge.doc}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push({ pluginId: item.pluginId, doc: badge.doc })
  }
  return refs
}

/** 徽标计数上限展示（99+）：超限计数折叠为 99+，事实计数不造假。 */
export function sidebarBadgeCountLabel(count: number): string {
  return count > 99 ? '99+' : String(count)
}

/** 徽标 tone -> 宿主 badge 语义类（badge-err / badge-warn / badge-accent / badge-ok / badge-neutral）。 */
export function sidebarBadgeToneClass(tone: SidebarBadgeTone): string {
  return tone === 'error' ? 'badge-err' : `badge-${tone}`
}

/** 视图项 label 与徽标 summary 的合成 tooltip/aria 文案（summary 为空时原样返回 label）。 */
export function composeSidebarBadgeLabel(label: string, badge: ResolvedSidebarBadge | null | undefined): string {
  return badge !== null && badge !== undefined && badge.summary !== '' ? `${label} · ${badge.summary}` : label
}

// ---------------------------------------------------------------------------
// 插件痕迹清理：ownedBy / parentConversationId 归一 + 插件自举资产可见性
// ---------------------------------------------------------------------------

/** 收集处于活跃运行态的插件 ID 集合（资产可见性与导航判定的统一输入；enabled=true 且 status='failed' 不计入）。 */
export function collectEnabledPluginIds(
  plugins: ReadonlyArray<{ id: string } & PluginActivityLike>,
): Set<string> {
  return new Set(plugins.filter((p) => isPluginSummaryActive(p)).map((p) => p.id))
}

/** 插件自举/托管的 Profile 在对应插件未启用时隐藏（Profile 编辑器列表消费）。 */
export function isProfileVisible(profile: Profile, enabledPluginIds: ReadonlySet<string>): boolean {
  return profile.managedByPlugin === undefined || enabledPluginIds.has(profile.managedByPlugin)
}

/**
 * 人类可在该 Agent 下新建对话的 Profile（仅判定插件托管可见性）。
 */
export function isHumanSelectableProfile(
  profile: Profile,
  enabledPluginIds: ReadonlySet<string>,
): boolean {
  return isProfileVisible(profile, enabledPluginIds)
}

/** 内核（core:*）与插件自举/托管的 Skill：core:* 恒定可见；插件托管技能在对应插件未启用时隐藏（技能库与 / 斜杠菜单消费）。 */
export function isSkillVisible(skill: SkillSummary, enabledPluginIds: ReadonlySet<string>): boolean {
  return (
    skill.managedByPlugin === undefined ||
    skill.managedByPlugin.startsWith('core:') ||
    enabledPluginIds.has(skill.managedByPlugin)
  )
}

/** 按标题或 #id 模糊过滤会话（供命令面板快速跳转）。 */
export function fuzzyMatchConversations(
  conversations: ConversationSummary[],
  query: string,
): ConversationSummary[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const numeric = /^\d+$/.test(q) ? Number(q) : null
  return conversations.filter(
    (c) =>
      c.title.toLowerCase().includes(q) ||
      c.profileId.toLowerCase().includes(q) ||
      (numeric !== null && c.id === numeric),
  )
}

/** 会话五态的展示文案（支持 i18n，缺省回落英文桥接）。 */
export function conversationStatusLabel(
  status: ConversationSummary['status'],
  t: WebMessageTranslator = englishWebTranslator,
): string {
  switch (status) {
    case 'working':
      return t('shell.status.working')
    case 'blocked':
      return t('shell.status.blocked')
    case 'done':
      return t('shell.status.done')
    case 'idle':
      return t('shell.status.idle')
    case 'error':
      return t('shell.status.error')
    default:
      return status
  }
}

/** 会话五态对应的徽章样式类。 */
export function conversationStatusBadgeClass(status: ConversationSummary['status']): string {
  switch (status) {
    case 'working':
      return 'badge badge-accent'
    case 'blocked':
      return 'badge badge-warn'
    case 'done':
      return 'badge badge-ok'
    case 'error':
      return 'badge badge-err'
    default:
      return 'badge badge-neutral'
  }
}

/** 会话状态圆点样式类：idle 状态返回 null（不显示圆点）。 */
export function conversationStatusDotClass(
  status: ConversationSummary['status'],
): string | null {
  if (status === 'idle') return null
  switch (status) {
    case 'working':
      return 'status-dot status-dot-working'
    case 'blocked':
      return 'status-dot status-dot-blocked'
    case 'done':
      return 'status-dot status-dot-done'
    case 'error':
      return 'status-dot status-dot-error'
    default:
      return 'status-dot'
  }
}

/** 会话状态悬浮提示文案；error 附带当前失败诊断摘要（lastError）。 */
export function conversationStatusTooltip(
  status: ConversationSummary['status'],
  doing?: string,
  lastError?: string,
  t: WebMessageTranslator = englishWebTranslator,
): string {
  const base = conversationStatusLabel(status, t)
  if (status === 'working' && doing?.trim()) {
    return `${base}: ${doing.trim()}`
  }
  if (status === 'error' && lastError?.trim()) {
    return `${base}: ${lastError.trim()}`
  }
  return base
}

/** Whether a top-level conversation is an automated session (`ownedBy === 'helmx'` without parent). */
export function isAutomatedRootConversation(
  conv: Pick<ConversationSummary, 'parentConversationId' | 'ownedBy'>,
): boolean {
  return conv.parentConversationId === undefined && conv.ownedBy === 'helmx'
}

/**
 * 判断会话是否允许被人类删除：
 * - 普通人类会话（ownedBy 为 undefined 或 'human'）允许删除（无 id 级豁免）；
 * - 自动化会话（ownedBy === 'helmx'）在非在途状态（非 working / blocked）允许人类手动单条清理
 *   （与批量删除同口径；插件 manageConversation 托管保护由服务端 409 conversation_managed_by_plugin 权威判定）。
 */
export function isConversationDeletable(
  conv: Pick<ConversationSummary, 'id' | 'ownedBy'> & { status?: ConversationSummary['status'] },
): boolean {
  if ((conv.ownedBy ?? 'human') === 'human') return true
  return conv.status !== undefined && conv.status !== 'working' && conv.status !== 'blocked'
}

/** 过滤出允许人类删除的会话列表。 */
export function filterDeletableConversations(conversations: ConversationSummary[]): ConversationSummary[] {
  return conversations.filter(isConversationDeletable)
}

// ---------------------------------------------------------------------------
// 侧栏交互辅助：分屏在场/焦点推导、激活态与待命入口（无 React 依赖，Sidebar 各子组件共用）
// ---------------------------------------------------------------------------

export interface SidebarTargetPresence {
  inPrimary: boolean
  inSplit: boolean
  /** 主高亮：单屏时为 inPrimary；分屏时为当前聚焦面板命中的项 */
  active: boolean
  /** 分屏非聚焦在场高亮：分屏开启时命中的非聚焦面板项 */
  splitSecondary: boolean
  /** 分屏开启且当前命中聚焦面板（驱动左侧 2px accent 焦点指示） */
  focused: boolean
  /** 分屏开启时在行尾显示的面板微标键：'Main' | 'Split' | 'Main·Split' | null（渲染经 sidebarPaneTagLabel 本地化） */
  paneTag: 'Main' | 'Split' | 'Main·Split' | null
}

const PANE_TAG_LABEL_KEYS: Record<
  NonNullable<SidebarTargetPresence['paneTag']>,
  'shell.paneTag.main' | 'shell.paneTag.split' | 'shell.paneTag.both'
> = {
  Main: 'shell.paneTag.main',
  Split: 'shell.paneTag.split',
  'Main·Split': 'shell.paneTag.both',
}

/** 将侧栏分屏微标键映射为当前语言的展示文案（en: Main/Split/Main·Split；zh-CN: 主/分/主·分）。 */
export function sidebarPaneTagLabel(
  paneTag: NonNullable<SidebarTargetPresence['paneTag']>,
  t: WebMessageTranslator = englishWebTranslator,
): string {
  return t(PANE_TAG_LABEL_KEYS[paneTag])
}

/** 按在场/焦点推导侧栏行级状态修饰类名后缀（供各侧栏行组件共用）。 */
export function presenceNavClassSuffix(presence: SidebarTargetPresence): string {
  const stateClass = presence.active
    ? ' nav-item-active'
    : presence.splitSecondary
      ? ' nav-item-split'
      : ''
  return `${stateClass}${presence.focused ? ' nav-item-focused' : ''}`
}

/** 解析侧栏目标在主屏/分屏的在场、焦点与面板微标状态。 */
export function resolveSidebarTargetPresence(
  store: Pick<HelmxStoreValue, 'primaryTarget' | 'splitTarget' | 'focusedPanel'>,
  matches: (target: ResolvedTarget) => boolean,
): SidebarTargetPresence {
  const inPrimary = matches(store.primaryTarget)
  const inSplit = store.splitTarget !== null && matches(store.splitTarget)
  if (store.splitTarget === null) {
    return {
      inPrimary,
      inSplit: false,
      active: inPrimary,
      splitSecondary: false,
      focused: false,
      paneTag: null,
    }
  }
  const focusedPanel = resolveFocusedPanel(store.focusedPanel ?? 'primary', store.splitTarget)
  const focused = (focusedPanel === 'primary' && inPrimary) || (focusedPanel === 'split' && inSplit)
  const active = focused
  const splitSecondary = !focused && (inPrimary || inSplit)
  const paneTag = inPrimary && inSplit ? 'Main·Split' : inPrimary ? 'Main' : inSplit ? 'Split' : null
  return {
    inPrimary,
    inSplit,
    active,
    splitSecondary,
    focused,
    paneTag,
  }
}

/** 推导指定会话行在主屏/分屏中的在场与焦点状态。 */
export function getConversationPresence(
  store: Pick<HelmxStoreValue, 'primaryTarget' | 'splitTarget' | 'focusedPanel'>,
  convId: number,
): SidebarTargetPresence {
  return resolveSidebarTargetPresence(
    store,
    (t) => t.kind === 'conversation' && t.conversationId === convId,
  )
}

/** 收集主屏与分屏中正在查看的会话 ID 集合。 */
export function activeConversationIdsOf(
  store: Pick<HelmxStoreValue, 'primaryTarget' | 'splitTarget'>,
): Set<number> {
  const ids = new Set<number>()
  if (store.primaryTarget.kind === 'conversation') ids.add(store.primaryTarget.conversationId)
  if (store.splitTarget?.kind === 'conversation') ids.add(store.splitTarget.conversationId)
  return ids
}

export type SidebarStoreView = Pick<
  HelmxStoreValue,
  | 'primaryTarget'
  | 'splitTarget'
  | 'focusedPanel'
  | 'conversations'
  | 'profiles'
  | 'plugins'
  | 'groupedUi'
  | 'locale'
  | 'openTarget'
  | 'pushNotice'
>

/** 在指定 Agent 下进入待命页（所有用户新建入口的统一路径；首次发送才创建会话）。 */
export function openAgentStandby(
  store: Pick<HelmxStoreValue, 'openTarget'>,
  profileId: string,
  onNavigate?: () => void,
): void {
  store.openTarget({ kind: 'agent', profileId })
  onNavigate?.()
}

/**
 * Whether a click inside a `.nav-item` row already landed on its primary
 * `.nav-item-main` button or an auxiliary interactive control (row action menu,
 * new-topic "+", split button, batch checkbox). Row-level `onClick` delegates
 * to the row action only when this returns false so row padding, gaps, and
 * non-interactive `.nav-item-meta` badges never drop clicks while interactive
 * controls never double-fire.
 */
export function shouldSkipNavRowClick(
  target: EventTarget | null,
  rowElement: HTMLElement,
): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false
  const interactive = target.closest(
    'button, a, input, select, textarea, [role="button"], [role="menuitem"], [role="checkbox"]',
  )
  return interactive !== null && interactive !== rowElement
}

