/**
 * builtin:profile 跨 Profile 协作目录（纯函数，无 IO / 无宿主依赖）。
 *
 * 目录用途：让当前会话「知道还有哪些角色可点名」（@id 协作约定）与
 * subagent / SubagentWorkflow 的 agentType 候选。它只是一份认知目录：
 * - 不是权限沙箱：不做任何访问控制承诺；
 * - 实时重读：Profile 增删改与插件启停在下次请求 / 回合生效。
 *
 * 排除规则（缺省不鼓励嵌套协作，不是硬深度限制）：
 * - 排除当前会话自身 Profile（自己不能点名自己）；
 * - 排除 managedByPlugin 指向未启用插件的 Profile（托管插件停用即隐藏）。
 */

import { escapeXml, type Profile } from '@helmx/protocol'

/** 补全摘要上限：100 Unicode 码点（与 PROFILE_STARTER 同口径的展示直觉）。 */
export const PROFILE_SUMMARY_MAX_CODEPOINTS = 100

/** 协作目录条目（纯数据；XML 渲染与补全条目由消费方派生）。 */
export interface ProfileCatalogEntry {
  id: string
  name: string
  /** 候选 SYSTEM.md 首个非标题自然段摘要；缺失为 undefined（不伪造）。 */
  summary?: string
  /** 展示用执行位置（Profile 显式配置；undefined = 继承调用方上下文）。 */
  nodeId?: string
  /** 展示用工作目录（undefined = 继承）。 */
  cwd?: string
}

/** 单个 Profile 是否可进入协作目录（排除规则见模块头注释）。 */
export function isCollaborationCandidate(
  profile: Profile,
  currentProfileId: string,
  enabledPluginIds: ReadonlySet<string>,
): boolean {
  if (profile.id === currentProfileId) return false
  if (profile.managedByPlugin !== undefined && !enabledPluginIds.has(profile.managedByPlugin)) return false
  return true
}

/** 目录条目构造（纯投影：不做摘要提取，summary 由调用方按需补充）。 */
export function toCatalogEntry(profile: Profile): ProfileCatalogEntry {
  return {
    id: profile.id,
    name: profile.name ?? profile.id,
    summary: undefined,
    nodeId: profile.nodeId,
    cwd: profile.cwd,
  }
}

// ---------------------------------------------------------------------------
// SYSTEM.md 摘要提取
// ---------------------------------------------------------------------------

/**
 * 逐行跳过 YAML frontmatter（--- 围栏）、围栏代码块（``` / ~~~）与标题行
 * （# 开头），返回首个非空自然段（多行段折叠为单行；列表项 / 引用块 /
 * HTML 标签行跳过，避免取出伪标题或标签内 metadata）。
 * 无合法自然段时返回 undefined（调用方不伪造简介）。
 */
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
      // 围栏代码块内：只认闭合围栏。
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
    // 段落已开始：空行结束本段。
    if (paragraph.length > 0 && line.trim() === '') break
    const candidate = line.trim()
    if (candidate === '') continue
    // 标题 / 列表 / 引用 / HTML 标签 / 表格行都不是自然段正文。
    if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|<[A-Za-z/!]|\\?<!--|\|)/.test(candidate)) continue
    paragraph.push(candidate)
    started = true
    if (paragraph.length >= 12) break // 防御性上限：超长畸形段落不再继续吞行
  }
  if (paragraph.length === 0) return undefined
  return truncateCodePoints(paragraph.join(' '), PROFILE_SUMMARY_MAX_CODEPOINTS)
}

/** 按码点截断（代理对计 1）；超长加省略号标记（省略号计入上限）。 */
export function truncateCodePoints(text: string, maxCodePoints: number): string {
  const chars = [...text]
  if (chars.length <= maxCodePoints) return text
  return `${chars.slice(0, Math.max(0, maxCodePoints - 1)).join('')}…`
}

/**
 * 渲染 profile.catalog 注入段（<available_profiles>）：每条候选一行紧凑
 * XML 条目，全部动态字段经转义。
 */
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

/** 位置展示串：node 与目录至少其一显式配置时返回，否则 undefined（继承）。 */
export function describePosition(entry: Pick<ProfileCatalogEntry, 'nodeId' | 'cwd'>): string | undefined {
  if (entry.nodeId === undefined && entry.cwd === undefined) return undefined
  return [entry.nodeId ?? '继承当前会话节点', entry.cwd ?? '继承当前会话目录'].join(' · ')
}

/** 补全 hint：位置 + 摘要（均可能缺省）。 */
export function describeHint(entry: ProfileCatalogEntry): string {
  const parts: string[] = []
  const position = describePosition(entry)
  if (position !== undefined) parts.push(position)
  else parts.push('继承当前会话节点与目录')
  if (entry.summary !== undefined) parts.push(entry.summary)
  return parts.join(' · ')
}
