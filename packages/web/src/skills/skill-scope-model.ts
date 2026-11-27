/**
 * 技能作用域纯函数模型：
 * - 技能中心按节点选择（默认 Hub `'local'`，或任意在线计算节点；URL 仅携带 `?node=<nodeId>`）；
 * - 会话与待命页 `/` 斜杠菜单按 `(nodeId, cwd?)` 补入节点机器级技能与工作区 `.helmx/skills`。
 *
 * 遵循 Fast Refresh 约定：纯函数与常量只放本模块，不进组件文件。
 */
import type { SelectOption } from '@helmx/ui'
import type { NodeInfo, SkillSummary } from '@helmx/protocol/browser'
import type { WebMessageTranslator } from '../i18n/catalog.js'

/** 技能目录作用域：节点必有值，cwd 仅会话/待命页补全时附带。 */
export interface SkillScope {
  nodeId: string
  cwd?: string
}

/** Hub 默认节点 ID（同时用作技能中心 Select 的 Hub 选项值）。 */
export const HUB_SKILL_NODE_ID = 'local'

/** nodeId 归一：空白/缺省视为 'local'（与内核会话坐标缺省语义一致）。 */
export function normalizeSkillScopeNodeId(nodeId: string | undefined): string {
  const trimmed = (nodeId ?? '').trim()
  return trimmed === '' ? HUB_SKILL_NODE_ID : trimmed
}

/**
 * 解析技能中心目标的 nodeId：
 * - 未设置时为 Hub 默认（undefined，无需规范化）；
 * - 显式写了 `'local'`、空白或含首尾空格时归一并标记 `shouldNormalize`，由调用方 replace 清理地址栏。
 */
export function parseSkillCenterNodeId(rawNodeId: string | undefined): {
  nodeId: string | undefined
  shouldNormalize: boolean
} {
  if (rawNodeId === undefined) return { nodeId: undefined, shouldNormalize: false }
  const trimmed = rawNodeId.trim()
  if (trimmed === '' || trimmed === HUB_SKILL_NODE_ID) {
    return { nodeId: undefined, shouldNormalize: true }
  }
  return { nodeId: trimmed, shouldNormalize: trimmed !== rawNodeId }
}

/** 技能中心目标构造函数（Hub 默认不写 nodeId；非 Hub 节点写 nodeId；可选保留 skillId）。 */
export function skillCenterTarget(
  nodeId: string | undefined,
  keep?: { skillId?: string },
): { kind: 'skills'; skillId?: string; nodeId?: string } {
  const normalized = nodeId?.trim() ?? ''
  const skillId = keep?.skillId !== undefined && keep.skillId !== '' ? keep.skillId : undefined
  return {
    kind: 'skills',
    ...(skillId !== undefined ? { skillId } : {}),
    ...(normalized !== '' && normalized !== HUB_SKILL_NODE_ID ? { nodeId: normalized } : {}),
  }
}

/** 构建节点副标（主机名/平台/状态，不泄露任何会话或路径信息）。 */
function formatOnlineNodeMeta(node: NodeInfo, statusLabel: string): string {
  const host = node.hostname !== undefined && node.hostname !== '' && node.hostname !== node.id
    ? node.hostname
    : undefined
  const platform = node.platform !== undefined && node.platform !== '' ? node.platform : undefined
  return [host, platform, statusLabel].filter(Boolean).join(' · ')
}

/**
 * 构建技能中心节点下拉选项：
 * - 第一项恒为 Hub（local）；
 * - 后续为所有可用在线节点（`id !== 'local' && online`）；
 * - 若 URL 深链指向了离线或尚未注册的节点，仍如实保留该选中项（绝不静默回退 Hub）。
 */
export function buildSkillNodeOptions(
  nodes: ReadonlyArray<NodeInfo>,
  selectedNodeId: string | undefined,
  t: WebMessageTranslator,
): Array<SelectOption<string>> {
  const options: Array<SelectOption<string>> = [
    {
      value: HUB_SKILL_NODE_ID,
      label: t('skills.scope.hub'),
      icon: 'monitor',
      meta: t('skills.scope.hubMeta'),
    },
  ]
  for (const node of nodes) {
    if (node.id === HUB_SKILL_NODE_ID || !node.online) continue
    options.push({
      value: node.id,
      label: node.id,
      icon: 'network',
      meta: formatOnlineNodeMeta(node, t('common.online')),
    })
  }
  if (
    selectedNodeId !== undefined &&
    selectedNodeId !== HUB_SKILL_NODE_ID &&
    !options.some((option) => option.value === selectedNodeId)
  ) {
    const matched = nodes.find((node) => node.id === selectedNodeId)
    if (matched !== undefined) {
      options.push({
        value: matched.id,
        label: matched.id,
        icon: 'network',
        meta: formatOnlineNodeMeta(matched, t('common.offline')),
      })
    } else {
      options.push({
        value: selectedNodeId,
        label: selectedNodeId,
        icon: 'alert-circle',
        meta: t('skills.scope.nodeUnavailableMeta'),
      })
    }
  }
  return options
}

/**
 * 会话的技能目录作用域：
 * - 有 cwd 时返回 `{ nodeId, cwd }`（叠加该工作区 `.helmx/skills`）；
 * - 远端节点即使无 cwd 也有节点机器级技能（返回 `{ nodeId }`）；
 * - local 且无 cwd 时返回 undefined（Hub 目录本身即全部）。
 */
export function conversationSkillScope(
  conversation: { nodeId?: string; cwd?: string },
): SkillScope | undefined {
  const nodeId = normalizeSkillScopeNodeId(conversation.nodeId)
  const cwd = (conversation.cwd ?? '').trim()
  if (cwd !== '') return { nodeId, cwd }
  if (nodeId !== HUB_SKILL_NODE_ID) return { nodeId }
  return undefined
}

/**
 * 待命草稿的有效环境作用域：显式定制（envCustomized）优先，否则回退角色配置；
 * 有 cwd 时携带 cwd，远端节点无 cwd 时仍拉取节点机器级技能，local 无 cwd 返回 undefined。
 */
export function standbySkillScope(
  draft: { envCustomized: boolean; envNodeId?: string; envCwd?: string },
  profile: { nodeId?: string; cwd?: string } | undefined,
): SkillScope | undefined {
  const rawNodeId = draft.envCustomized ? draft.envNodeId : profile?.nodeId
  const rawCwd = draft.envCustomized ? draft.envCwd : profile?.cwd
  const nodeId = normalizeSkillScopeNodeId(rawNodeId)
  const cwd = (rawCwd ?? '').trim()
  if (cwd !== '') return { nodeId, cwd }
  if (nodeId !== HUB_SKILL_NODE_ID) return { nodeId }
  return undefined
}

/** 合并目录里属于节点来源（节点机器级根目录或工作区 `.helmx/skills`）的技能。 */
export function isNodeSourceSkill(skill: SkillSummary): boolean {
  return skill.source === 'node'
}
