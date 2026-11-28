/**
 * Leaf pure-function layer for conversation five-state labels/dots/tooltips,
 * background-activity index types, and plugin-hosted asset visibility.
 */
import type { ConversationSummary, Profile, SkillSummary } from '@helmx/protocol/browser'
import { isProfileOwnerActive, isSkillOwnerActive } from '@helmx/protocol/browser'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import { isPluginSummaryActive, type PluginActivityLike } from '../lib/live-state.js'

/** One conversation's background in-flight summary (aggregated from hit panels' per-conversation badges and compaction). */
export interface ConversationBackgroundActivity {
  /** A background task is in flight (a hit panel's per-conversation badge tone = 'accent', or contextUsage.compacting = true). */
  active: boolean
  /** Run summary copy: hit badges' footerText and the compaction copy, deduplicated and joined (may be empty). */
  summary: string
}

/** Per-conversation background in-flight index (key: conversationId; sidebar rows look up by id). */
export type ConversationBackgroundIndex = ReadonlyMap<number, ConversationBackgroundActivity>

/** 收集处于活跃运行态的插件 ID 集合（资产可见性与导航判定的统一输入；enabled=true 且 status='failed' 不计入）。 */
export function collectEnabledPluginIds(
  plugins: ReadonlyArray<{ id: string } & PluginActivityLike>,
): Set<string> {
  return new Set(plugins.filter((p) => isPluginSummaryActive(p)).map((p) => p.id))
}

/** 内核（core:<domain>）与插件自举/托管的 Profile：合法 core:<domain> 恒定可见；插件托管 Profile 在对应插件未启用时隐藏（Profile 编辑器列表消费）。 */
export function isProfileVisible(profile: Profile, enabledPluginIds: ReadonlySet<string>): boolean {
  return isProfileOwnerActive(profile.managedByPlugin, enabledPluginIds)
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

/** 内核（core:<domain>）与插件自举/托管的 Skill：合法 core:<domain> 恒定可见；插件托管技能在对应插件未启用时隐藏（与内核 isSkillAvailable 同源）。 */
export function isSkillVisible(skill: SkillSummary, enabledPluginIds: ReadonlySet<string>): boolean {
  return isSkillOwnerActive(skill.managedByPlugin, enabledPluginIds)
}

/** 会话五态的展示文案。 */
export function conversationStatusLabel(
  status: ConversationSummary['status'],
  t: WebMessageTranslator,
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
  doing: string | undefined,
  lastError: string | undefined,
  t: WebMessageTranslator,
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
