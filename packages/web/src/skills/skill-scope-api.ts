/**
 * builtin:profile 技能目录 / 节点技能读取 action 的 Web 适配层。
 *
 * 契约：
 * - `skill_catalog`：input `{ nodeId, cwd? }` → `{ nodeId, cwd?, skills, shadowedNodeSkillIds,
 *   nodeUnavailable? }`，skills 为 Hub + 节点机器级根目录（及可选工作区）合并目录；
 * - `skill_read`：input `{ nodeId, cwd?, skillId, path? }` → `{ text }`，只用于
 *   节点源技能（Hub 源技能继续走 /api/skills/:id/read）。
 *
 * Web 经 HTTP action 调用（不带 conversationId）；本模块在消费边界对输出做
 * 严格形状校验，非法输出显式抛错，绝不静默降级或编造数据。
 */
import type { SkillSummary } from '@helmx/protocol/browser'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import type { SkillScope } from './skill-scope-model.js'

export const SKILLS_PLUGIN_ID = 'builtin:profile'
export const SKILL_CATALOG_ACTION_ID = 'skill_catalog'
export const SKILL_READ_ACTION_ID = 'skill_read'

/** 宿主 action 调用面（生产为 store 的 invokePluginAction；测试可注入桩）。 */
export type SkillActionInvoker = (
  pluginId: string,
  actionId: string,
  input: unknown,
) => Promise<unknown>

/** 合并技能目录结果（已通过边界校验）。 */
export interface ScopedSkillCatalog {
  skills: SkillSummary[]
  shadowedNodeSkillIds: string[]
  nodeUnavailable?: string
}

const SKILL_SOURCE_VALUES = new Set(['data', 'agents', 'node'])

function catalogError(t: WebMessageTranslator, detail: string): Error {
  return new Error(t('skills.scopeApi.catalogInvalid', { detail }))
}

/** 校验单个技能摘要条目（字段级拒绝，不静默丢弃）。 */
function parseSkillSummaryEntry(raw: unknown, index: number, t: WebMessageTranslator): SkillSummary {
  if (typeof raw !== 'object' || raw === null) {
    throw catalogError(t, t('skills.scopeApi.skillEntryNotObject', { index }))
  }
  const record = raw as Record<string, unknown>
  const { id, name, references, managedByPlugin, source } = record
  if (typeof id !== 'string' || id.trim() === '') {
    throw catalogError(t, t('skills.scopeApi.skillIdRequired', { index }))
  }
  if (typeof name !== 'string') {
    throw catalogError(t, t('skills.scopeApi.skillNameRequired', { index }))
  }
  if (!Array.isArray(references) || references.some((ref) => typeof ref !== 'string')) {
    throw catalogError(t, t('skills.scopeApi.skillRefsInvalid', { index }))
  }
  if (managedByPlugin !== undefined && typeof managedByPlugin !== 'string') {
    throw catalogError(t, t('skills.scopeApi.skillPluginInvalid', { index }))
  }
  if (source !== undefined && (typeof source !== 'string' || !SKILL_SOURCE_VALUES.has(source))) {
    throw catalogError(t, t('skills.scopeApi.skillSourceInvalid', { index }))
  }
  if (record.description !== undefined && typeof record.description !== 'string') {
    throw catalogError(t, t('skills.scopeApi.skillDescInvalid', { index }))
  }
  return {
    id,
    name,
    references: references as string[],
    ...(managedByPlugin !== undefined ? { managedByPlugin } : {}),
    ...(source !== undefined ? { source: source as SkillSummary['source'] } : {}),
    ...(record.description !== undefined ? { description: record.description as string } : {}),
  }
}

/** 边界校验 skill_catalog 输出（外部输入显式拒绝，绝不静默截断）。
 * outputSchema 中的 required echo 字段 nodeId 必须是非空字符串；cwd 可选，
 * 若存在也必须是非空字符串。 */
export function parseSkillCatalogResult(raw: unknown, t: WebMessageTranslator): ScopedSkillCatalog {
  if (typeof raw !== 'object' || raw === null) {
    throw catalogError(t, t('skills.scopeApi.notObject'))
  }
  const record = raw as Record<string, unknown>
  if (typeof record.nodeId !== 'string' || record.nodeId.trim() === '') {
    throw catalogError(t, t('skills.scopeApi.nodeIdRequired'))
  }
  if (record.cwd !== undefined && (typeof record.cwd !== 'string' || record.cwd.trim() === '')) {
    throw catalogError(t, t('skills.scopeApi.cwdInvalid'))
  }
  if (!Array.isArray(record.skills)) {
    throw catalogError(t, t('skills.scopeApi.skillsArrayRequired'))
  }
  const skills = record.skills.map((entry, index) => parseSkillSummaryEntry(entry, index, t))
  if (
    record.shadowedNodeSkillIds !== undefined &&
    (
      !Array.isArray(record.shadowedNodeSkillIds) ||
      record.shadowedNodeSkillIds.some((id) => typeof id !== 'string')
    )
  ) {
    throw catalogError(t, t('skills.scopeApi.shadowedInvalid'))
  }
  if (record.nodeUnavailable !== undefined && typeof record.nodeUnavailable !== 'string') {
    throw catalogError(t, t('skills.scopeApi.nodeUnavailableInvalid'))
  }
  return {
    skills,
    shadowedNodeSkillIds: (record.shadowedNodeSkillIds as string[] | undefined) ?? [],
    ...(record.nodeUnavailable !== undefined
      ? { nodeUnavailable: record.nodeUnavailable as string }
      : {}),
  }
}

/** 边界校验 skill_read 输出。 */
export function parseSkillReadResult(raw: unknown, t: WebMessageTranslator): { text: string } {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(t('skills.scopeApi.readNotObject'))
  }
  const text = (raw as Record<string, unknown>).text
  if (typeof text !== 'string') {
    throw new Error(t('skills.scopeApi.readTextInvalid'))
  }
  return { text }
}

/** 拉取节点（及可选工作区）的合并技能目录。 */
export function fetchScopedSkillCatalog(
  invoke: SkillActionInvoker,
  scope: SkillScope,
  t: WebMessageTranslator,
): Promise<ScopedSkillCatalog> {
  return invoke(SKILLS_PLUGIN_ID, SKILL_CATALOG_ACTION_ID, {
    nodeId: scope.nodeId,
    ...(scope.cwd !== undefined && scope.cwd !== '' ? { cwd: scope.cwd } : {}),
  }).then((raw) => parseSkillCatalogResult(raw, t))
}

/** 读取节点源技能文件（path 缺省读主 SKILL.md，与 Hub 读取约定一致）。 */
export function readScopedSkillFile(
  invoke: SkillActionInvoker,
  scope: SkillScope,
  skillId: string,
  path: string | undefined,
  t: WebMessageTranslator,
): Promise<{ text: string }> {
  return invoke(SKILLS_PLUGIN_ID, SKILL_READ_ACTION_ID, {
    nodeId: scope.nodeId,
    ...(scope.cwd !== undefined && scope.cwd !== '' ? { cwd: scope.cwd } : {}),
    skillId,
    ...(path !== undefined && path !== '' ? { path } : {}),
  }).then((raw) => parseSkillReadResult(raw, t))
}
