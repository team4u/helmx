/**
 * 角色详情抽屉表单纯模型契约测试（拆分自 ProfileDetailDrawer）：
 * - isProfileFormDirty：新建模式任一字段非空即脏；编辑模式逐项对比基线（技能顺序无关、starters 按 label/prompt）；
 * - mergeHydratedDetailPreservingEdits：异步详情只回填用户未触碰的字段，保留进行中的编辑。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Profile } from '@helmx/protocol'
import {
  createInitialForm,
  isProfileFormDirty,
  mergeHydratedDetailPreservingEdits,
  mergeProfileDetailIntoForm,
  toStarterFormItems,
  type ProfileFormState,
} from '../src/profiles/profile-detail/profile-form-model.js'

function keyFactory(): () => string {
  let seq = 0
  return () => `k${++seq}`
}

function makeProfile(partial: Partial<Profile> = {}): Profile {
  return {
    id: 'coder',
    name: 'Coder',
    defaultModel: 'openai/gpt',
    nodeId: 'local',
    cwd: '/w',
    system: 'be terse',
    skills: ['git-commit', 'memory'],
    starters: [{ label: 'Run', prompt: 'run it' }],
    ...partial,
  } as Profile
}

test('isProfileFormDirty：新建模式空表单不脏，任一字段非空 / 开关开启即脏', { timeout: 60_000 }, () => {
  const empty = createInitialForm(null, true, keyFactory())
  assert.equal(isProfileFormDirty(empty, empty, true), false)
  assert.equal(isProfileFormDirty({ ...empty, id: '  ' }, empty, true), false)
  assert.equal(isProfileFormDirty({ ...empty, id: 'a' }, empty, true), true)
  assert.equal(isProfileFormDirty({ ...empty, restrictToCwd: true }, empty, true), true)
  assert.equal(isProfileFormDirty({ ...empty, useAllSkills: false }, empty, true), true)
  assert.equal(isProfileFormDirty({ ...empty, starters: toStarterFormItems(makeProfile().starters, keyFactory()) }, empty, true), true)
})

test('isProfileFormDirty：编辑模式逐项对比基线，技能白名单比较与顺序无关，starters 比较 label / prompt', { timeout: 60_000 }, () => {
  const profile = makeProfile()
  const baseline = createInitialForm(profile, false, keyFactory())
  assert.equal(isProfileFormDirty(baseline, baseline, false), false)

  const reorderedSkills: ProfileFormState = { ...baseline, selectedSkillIds: [...baseline.selectedSkillIds].reverse() }
  assert.equal(isProfileFormDirty(reorderedSkills, baseline, false), false)
  assert.equal(isProfileFormDirty({ ...baseline, selectedSkillIds: ['git-commit'] }, baseline, false), true)
  assert.equal(isProfileFormDirty({ ...baseline, systemEdited: true }, baseline, false), true)
  assert.equal(isProfileFormDirty({ ...baseline, name: 'Other' }, baseline, false), true)

  // starters 的 key 为客户端临时序号，重排 / 重建不影响脏判定，仅 label / prompt 变化才算脏
  const rebuiltStarters: ProfileFormState = {
    ...baseline,
    starters: toStarterFormItems(profile.starters, keyFactory()),
  }
  assert.equal(isProfileFormDirty(rebuiltStarters, baseline, false), false)
  assert.equal(
    isProfileFormDirty(
      { ...baseline, starters: [{ key: 'x', label: 'Run', prompt: 'changed' }] },
      baseline,
      false,
    ),
    true,
  )
})

test('mergeProfileDetailIntoForm / mergeHydratedDetailPreservingEdits：仅回填未编辑字段并刷新 source', { timeout: 60_000 }, () => {
  const profile = makeProfile()
  const initial = createInitialForm(profile, false, keyFactory())
  const detail = makeProfile({ name: 'Coder v2', system: 'be verbose', skills: ['git-commit', 'memory', 'plan'] })
  const hydrated = mergeProfileDetailIntoForm(initial, detail, keyFactory())
  assert.equal(hydrated.name, 'Coder v2')
  assert.equal(hydrated.system, 'be verbose')
  assert.equal(hydrated.source, detail)

  // 用户已改名（与初值不同）：保留用户输入；未动的 system 回填详情；已编辑的 system 保留编辑
  const editedName: ProfileFormState = { ...initial, name: 'Mine' }
  const merged = mergeHydratedDetailPreservingEdits(editedName, initial, hydrated)
  assert.equal(merged.name, 'Mine')
  assert.equal(merged.system, 'be verbose')
  assert.equal(merged.source, detail)

  const editedSystem: ProfileFormState = { ...initial, system: 'custom', systemEdited: true }
  assert.equal(mergeHydratedDetailPreservingEdits(editedSystem, initial, hydrated).system, 'custom')
})
