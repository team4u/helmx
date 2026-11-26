/**
 * 角色详情抽屉表单的纯数据模型（无组件导出）：表单初值、详情合并、脏检查。
 */
import type { Profile, StarterDraft } from '../profile-center-model.js'
import { resolveProfileModel, startersToDrafts } from '../profile-center-model.js'

export interface StarterFormItem extends StarterDraft {
  /** Stable client-side React key for mutable starter rows. */
  key: string
}

export interface ProfileFormState {
  id: string
  name: string
  model: string
  thinkingLevel: string
  /** 绑定的默认计算节点 ID；空串 = 未绑定（回退本机 local）。 */
  nodeId: string
  cwd: string
  /** Profile.restrictToCwd 护栏：文件工具与子代理 cwd 限定在会话工作目录内。 */
  restrictToCwd: boolean
  system: string
  systemEdited: boolean
  useAllSkills: boolean
  selectedSkillIds: string[]
  starters: StarterFormItem[]
  /** 保存时非表单字段（tags/managedByPlugin）从最近详情快照透传。 */
  source: Profile | null
}

export function toStarterFormItems(
  starters: Profile['starters'],
  nextKey: () => string,
): StarterFormItem[] {
  return startersToDrafts(starters).map((item) => ({ ...item, key: nextKey() }))
}

export function createInitialForm(
  profile: Profile | null,
  isNew: boolean,
  nextKey: () => string,
): ProfileFormState {
  if (isNew || !profile) {
    return {
      id: '',
      name: '',
      model: '',
      thinkingLevel: '',
      nodeId: '',
      cwd: '',
      restrictToCwd: false,
      system: '',
      systemEdited: false,
      useAllSkills: true,
      selectedSkillIds: [],
      starters: [],
      source: null,
    }
  }

  return {
    id: profile.id,
    name: profile.name ?? '',
    model: resolveProfileModel(profile) ?? '',
    thinkingLevel: profile.thinkingLevel ?? '',
    nodeId: profile.nodeId ?? '',
    cwd: profile.cwd ?? '',
    restrictToCwd: profile.restrictToCwd === true,
    system: profile.system ?? '',
    systemEdited: false,
    useAllSkills: profile.skills === undefined,
    selectedSkillIds: Array.isArray(profile.skills) ? [...profile.skills] : [],
    starters: toStarterFormItems(profile.starters, nextKey),
    source: profile,
  }
}

export function mergeProfileDetailIntoForm(
  base: ProfileFormState,
  detail: Profile,
  nextKey: () => string,
): ProfileFormState {
  return {
    ...base,
    name: detail.name ?? base.name,
    model: resolveProfileModel(detail) ?? base.model,
    thinkingLevel: detail.thinkingLevel ?? '',
    nodeId: detail.nodeId ?? base.nodeId,
    cwd: detail.cwd ?? base.cwd,
    restrictToCwd: detail.restrictToCwd === true,
    system: detail.system ?? base.system,
    systemEdited: false,
    useAllSkills: detail.skills === undefined,
    selectedSkillIds: Array.isArray(detail.skills) ? [...detail.skills] : base.selectedSkillIds,
    starters: toStarterFormItems(detail.starters, nextKey),
    source: detail,
  }
}

function sortedSkillsKey(ids: string[]): string {
  return [...ids].sort().join(',')
}

function sameStartersDraft(a: StarterDraft[], b: StarterDraft[]): boolean {
  return a.length === b.length && a.every((item, idx) => item.label === b[idx]?.label && item.prompt === b[idx]?.prompt)
}

/** 异步详情到达时仅回填用户未改动的字段（与初值逐项比较），保留进行中的编辑。 */
export function mergeHydratedDetailPreservingEdits(
  prev: ProfileFormState,
  initial: ProfileFormState,
  hydrated: ProfileFormState,
): ProfileFormState {
  const prevSkills = sortedSkillsKey(prev.selectedSkillIds)
  const initSkills = sortedSkillsKey(initial.selectedSkillIds)
  return {
    ...prev,
    name: prev.name === initial.name ? hydrated.name : prev.name,
    model: prev.model === initial.model ? hydrated.model : prev.model,
    thinkingLevel: prev.thinkingLevel === initial.thinkingLevel ? hydrated.thinkingLevel : prev.thinkingLevel,
    nodeId: prev.nodeId === initial.nodeId ? hydrated.nodeId : prev.nodeId,
    cwd: prev.cwd === initial.cwd ? hydrated.cwd : prev.cwd,
    restrictToCwd: prev.restrictToCwd === initial.restrictToCwd ? hydrated.restrictToCwd : prev.restrictToCwd,
    system: !prev.systemEdited && prev.system === initial.system ? hydrated.system : prev.system,
    useAllSkills: prev.useAllSkills === initial.useAllSkills ? hydrated.useAllSkills : prev.useAllSkills,
    selectedSkillIds: prevSkills === initSkills ? hydrated.selectedSkillIds : prev.selectedSkillIds,
    starters: sameStartersDraft(prev.starters, initial.starters) ? hydrated.starters : prev.starters,
    source: hydrated.source,
  }
}

/** 脏表单判定：新建模式任一字段非空即脏；编辑模式与最近基线逐项比较。 */
export function isProfileFormDirty(form: ProfileFormState, baseline: ProfileFormState, isNew: boolean): boolean {
  if (isNew) {
    return (
      form.id.trim() !== '' ||
      form.name.trim() !== '' ||
      form.model.trim() !== '' ||
      form.thinkingLevel !== '' ||
      form.nodeId.trim() !== '' ||
      form.cwd.trim() !== '' ||
      form.restrictToCwd ||
      form.system.trim() !== '' ||
      !form.useAllSkills ||
      form.selectedSkillIds.length > 0 ||
      form.starters.length > 0
    )
  }

  if (form.id !== baseline.id) return true
  if (form.name !== baseline.name) return true
  if (form.model !== baseline.model) return true
  if (form.thinkingLevel !== baseline.thinkingLevel) return true
  if (form.nodeId !== baseline.nodeId) return true
  if (form.cwd !== baseline.cwd) return true
  if (form.restrictToCwd !== baseline.restrictToCwd) return true
  if (form.systemEdited || form.system !== baseline.system) return true
  if (form.useAllSkills !== baseline.useAllSkills) return true
  if (!sameStartersDraft(form.starters, baseline.starters)) return true

  return sortedSkillsKey(form.selectedSkillIds) !== sortedSkillsKey(baseline.selectedSkillIds)
}
