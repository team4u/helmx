/**
 * builtin:mentions cross-Profile collaboration catalog (pure functions, zero IO / zero host deps).
 *
 * Purpose: tells the current turn which roles can be `@`-mentioned or targeted via `agentType` / `profileId`
 * when dispatch tools are active. Cognitive catalog only (not an access control boundary).
 *
 * Exclusion rules:
 * - Excludes the current conversation's own Profile;
 * - Excludes Profiles whose `managedByPlugin` points to an inactive plugin (`core:*` owners are always active).
 */
import { escapeXml, isProfileOwnerActive, type Profile } from '@helmx/protocol'

export const PROFILE_SUMMARY_MAX_CODEPOINTS = 100

export interface ProfileCatalogEntry {
  id: string
  name: string
  /** First non-heading natural paragraph summary from candidate SYSTEM.md; undefined when missing. */
  summary?: string
  nodeId?: string
  cwd?: string
}

export function isCollaborationCandidate(
  profile: Profile,
  currentProfileId: string,
  enabledPluginIds: ReadonlySet<string>,
): boolean {
  if (profile.id === currentProfileId) return false
  if (!isProfileOwnerActive(profile.managedByPlugin, enabledPluginIds)) return false
  return true
}

export function toCatalogEntry(profile: Profile): ProfileCatalogEntry {
  return {
    id: profile.id,
    name: profile.name ?? profile.id,
    summary: undefined,
    nodeId: profile.nodeId,
    cwd: profile.cwd,
  }
}

export function extractSystemSummary(systemMd: string): string | undefined {
  if (typeof systemMd !== 'string') return undefined
  const lines = systemMd.split(/\r?\n/)
  let inFrontmatter = false
  let frontmatterSeen = false
  let fence: string | undefined
  const paragraph: string[] = []
  let started = false

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()

    if (fence !== undefined) {
      if (line.trimStart().startsWith(fence)) fence = undefined
      continue
    }
    if (!started && !frontmatterSeen && line.trim() === '---') {
      inFrontmatter = true
      frontmatterSeen = true
      continue
    }
    if (inFrontmatter) {
      if (line.trim() === '---' || line.trim() === '...') inFrontmatter = false
      continue
    }
    const fenceMatch = /^(\s*)(```|~~~)/.exec(line)
    if (fenceMatch !== null) {
      fence = fenceMatch[2]!
      continue
    }
    if (paragraph.length > 0 && line.trim() === '') break
    const candidate = line.trim()
    if (candidate === '') continue
    if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|<[A-Za-z/!]|\\?<!--|\|)/.test(candidate)) continue
    paragraph.push(candidate)
    started = true
    if (paragraph.length >= 12) break
  }
  if (paragraph.length === 0) return undefined
  return truncateCodePoints(paragraph.join(' '), PROFILE_SUMMARY_MAX_CODEPOINTS)
}

export function truncateCodePoints(text: string, maxCodePoints: number): string {
  const chars = [...text]
  if (chars.length <= maxCodePoints) return text
  return `${chars.slice(0, Math.max(0, maxCodePoints - 1)).join('')}…`
}

export function renderProfileCatalogSection(
  entries: readonly ProfileCatalogEntry[],
  options: { dispatchToolNames: readonly string[] },
): string {
  const lines = entries.map((entry) => {
    const attrs = [`id="${escapeXml(entry.id)}"`, `name="${escapeXml(entry.name)}"`, `mention="@${escapeXml(entry.id)}"`]
    const position = describePosition(entry)
    if (position !== undefined) attrs.push(`at="${escapeXml(position)}"`)
    const inner = entry.summary !== undefined ? escapeXml(entry.summary) : ''
    return `<profile ${attrs.join(' ')}>${inner}</profile>`
  })
  const tools = options.dispatchToolNames.length > 0 ? options.dispatchToolNames.join(' / ') : '（本回合无派工工具）'
  const hasSwarmDispatch = options.dispatchToolNames.includes('swarm_dispatch_worker')
  const hasWorkflowDispatch = options.dispatchToolNames.some((name) => name === 'subagent' || name === 'SubagentWorkflow')
  const profileParamHint =
    hasSwarmDispatch && hasWorkflowDispatch
      ? 'agentType（subagent/SubagentWorkflow）或 profileId（swarm_dispatch_worker）'
      : hasSwarmDispatch
        ? 'profileId'
        : 'agentType'
  return [
    '<available_profiles>',
    '可 @点名 协作的角色目录（@<id> 是纯文本点名约定，不是必然执行的指令；引用或代码中的 @ 不代表派工）：',
    ...lines,
    '协作指引：',
    `- 需要委派任务时用 ${tools} 的 ${profileParamHint} 指定 Profile id；缺省不主动转发用户消息（主持串并联，不劫持输入）。`,
    ...(hasWorkflowDispatch
      ? [`- ${options.dispatchToolNames.filter((n) => n !== 'swarm_dispatch_worker').join(' / ')} 按调用会话归属决定缺省等待方式：human 缺省后台，helmx 缺省同步；目标 Profile 不改变此策略。后台启动后继续响应用户，完成汇报自动到达，不要轮询等待。`]
      : []),
    '- 点名只是让对应角色在需要时参与；不自动读取对方 SYSTEM/MEMORY 全文，不复制本会话全部历史，只在必要时转述任务所需上下文。',
    '- 附件只能传递当前会话有权使用的产物（自己或父链产出）；兄弟/子孙会话的产物不能直接转发。',
    '- node/cwd 不同的会话没有自动文件同步：不能把本机路径当远端文件；执行位置见 at 属性（未标注则继承当前会话）。',
    '- 原生子会话的 resume 沿用父子归属与空闲要求。',
    '</available_profiles>',
  ].join('\n')
}

export function describePosition(entry: Pick<ProfileCatalogEntry, 'nodeId' | 'cwd'>): string | undefined {
  if (entry.nodeId === undefined && entry.cwd === undefined) return undefined
  return [entry.nodeId ?? '继承当前会话节点', entry.cwd ?? '继承当前会话目录'].join(' · ')
}

export function describeHint(entry: ProfileCatalogEntry): string {
  const parts: string[] = []
  const position = describePosition(entry)
  if (position !== undefined) parts.push(position)
  else parts.push('继承当前会话节点与目录')
  if (entry.summary !== undefined) parts.push(entry.summary)
  return parts.join(' · ')
}
