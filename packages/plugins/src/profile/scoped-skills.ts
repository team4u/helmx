/**
 * builtin:profile 节点/工作区合并技能目录：以物理坐标 (nodeId, cwd?) 为输入
 * 的 Hub + 节点合并发现函数（会话 before_turn 注入与 skill_catalog action 的
 * 单一事实来源；机制在插件层组装，内核零改动）。
 *
 * 合并契约（显式、不依赖任何 listDir 顺序）：
 * 1. Hub dataDir（含受管技能，永远最高）
 * 2. Hub 机器级共享根 ~/.agents/skills
 * 3. 远端节点机器级根目录 ~/.helmx/skills > ~/.agents/skills（nodeId !== 'local'）
 * 4. 工作区项目级目录 <cwd>/.helmx/skills（提供 cwd 时叠加）
 * - 节点层技能均标 source: 'node'，只能补充、不能覆盖 Hub 版本；同名节点技能
 *   不进合并目录（Hub 版本永远生效），其 id 显式记录进 shadowedNodeSkillIds；
 * - 节点扫描失败（离线 / IO 故障 / 超上限）显式返回 nodeUnavailable 诊断，
 *   绝不静默当作「无节点技能」（诚实性红线）。
 */
import type { JsonSchema, SkillSummary } from '@helmx/protocol'
import { scanNodeSkills, type NodeSkillScanOptions, type NodeSkillsHostPort } from './node-skills.js'

/** Hub 技能目录读取端口（真实 ctx.host.skills 天然满足；测试可注入受控实现）。 */
export interface HubSkillsPort {
  list(): Promise<SkillSummary[]>
}

/** 坐标作用域合并目录：nodeId 为生效坐标（已归一 'local'），cwd 仅在提供工作区路径时回显，nodeUnavailable 仅在节点侧故障时出现。 */
export interface ScopedSkillCatalog {
  nodeId: string
  cwd?: string
  /** 合并生效目录（Hub data > Hub agents > node 机器级 > workspace 补充；同名只保留 Hub 版本），按 id 排序。 */
  skills: SkillSummary[]
  /** 被任一 Hub 根同名遮蔽的节点技能 id（按 id 排序；节点版本不可达）。 */
  shadowedNodeSkillIds: string[]
  /** 节点侧扫描失败的显式脱敏诊断；正常时缺省。 */
  nodeUnavailable?: string
}

/** SkillSummary 的 JSON Schema 描述（action 输出边界校验用，与 protocol 字段一一对应）。 */
export const SKILL_SUMMARY_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    references: { type: 'array', items: { type: 'string' } },
    managedByPlugin: { type: 'string' },
    source: { type: 'string', enum: ['data', 'agents', 'node'] },
  },
  required: ['id', 'name', 'references'],
  additionalProperties: false,
}

/**
 * 发现物理坐标 (nodeIdInput ?? 'local', cwd?) 处的合并技能目录。
 * cwd 缺省/空串时不扫描工作区目录（远端节点仍扫描节点自身机器级根目录）。
 */
export async function listScopedSkills(
  skills: HubSkillsPort,
  host: NodeSkillsHostPort,
  nodeIdInput: string | undefined,
  cwd = '',
  options?: NodeSkillScanOptions,
): Promise<ScopedSkillCatalog> {
  const hub = await skills.list()
  const byId = new Map(hub.map((skill) => [skill.id, skill]))
  const shadowedNodeSkillIds: string[] = []
  const scan = await scanNodeSkills(host, nodeIdInput, cwd, options)
  const nodeSkills = scan.kind === 'ok' ? scan.skills : (scan.skills ?? [])
  for (const skill of nodeSkills) {
    if (byId.has(skill.id)) shadowedNodeSkillIds.push(skill.id) // same-name: the Hub version always wins
    else byId.set(skill.id, skill)
  }
  const merged = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  return {
    nodeId: nodeIdInput ?? 'local',
    ...(cwd !== '' ? { cwd } : {}),
    skills: merged,
    shadowedNodeSkillIds, // scanNodeSkills returns id-sorted entries, so shadowed ids stay sorted
    ...(scan.kind === 'unavailable' ? { nodeUnavailable: scan.reason } : {}),
  }
}
