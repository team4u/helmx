/**
 * Pure-model & SSR tests for the profile available-skills configuration:
 * skills tri-state normalization in buildProfileSavePayload
 * (profile-center-model), plus SSR coverage for the drawer allowlist list
 * rendering description summaries (summarizeSingleLine collapse + truncation).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Profile, SkillSummary } from '@helmx/protocol'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildProfileSavePayload } from '../src/profiles/profile-center-model.js'
import { summarizeSingleLine } from '../src/lib/format.js'
import { ProfileDetailDrawer } from '../src/profiles/ProfileDetailDrawer.js'
import { makeTestStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

// ---------------------------------------------------------------------------
// Pure model: skills tri-state normalization (profile-center-model)
// ---------------------------------------------------------------------------

test('buildProfileSavePayload: the skills tri-state is preserved in full; [] and undefined never normalize into each other', { timeout: 60_000 }, () => {
  // undefined: the key is absent (follow all)
  const all = buildProfileSavePayload({
    id: 'p',
    skills: undefined,
    source: { id: 'p', tags: [] },
    isNew: false,
  })
  assert.equal('skills' in all, false)

  // []: explicitly disable all — an empty array is an explicit user choice and must not normalize to undefined
  const none = buildProfileSavePayload({
    id: 'p',
    skills: [],
    source: { id: 'p', tags: [], skills: [] },
    isNew: false,
  })
  assert.deepEqual(none.skills, [])

  // Allowlist: kept verbatim (stale entries included, never silently deleted)
  const allow = buildProfileSavePayload({
    id: 'p',
    skills: ['review', 'ghost-skill'],
    source: { id: 'p', tags: [], skills: ['review', 'ghost-skill'] },
    isNew: false,
  })
  assert.deepEqual(allow.skills, ['review', 'ghost-skill'])

  // Not edited (only other fields changed): nothing is lost either
  const edited = buildProfileSavePayload({
    id: 'p',
    name: '改名',
    skills: [],
    source: { id: 'p', tags: [], skills: [] },
    isNew: false,
  })
  assert.deepEqual(edited.skills, [])

  // Allowlist + other field edits: preserved in full (stale entries included)
  const editedAllow = buildProfileSavePayload({
    id: 'p',
    name: '改名',
    skills: ['review', 'ghost-skill'],
    source: { id: 'p', tags: [], skills: ['review', 'ghost-skill'] },
    isNew: false,
  })
  assert.deepEqual(editedAllow.skills, ['review', 'ghost-skill'])
})

// ---------------------------------------------------------------------------
// Skill description summaries (summarizeSingleLine + drawer SSR)
// ---------------------------------------------------------------------------

test('summarizeSingleLine: 空白折叠为单行、边界与截断省略号', { timeout: 60_000 }, () => {
  assert.equal(summarizeSingleLine(undefined), '')
  assert.equal(summarizeSingleLine('   \n\t  '), '')
  assert.equal(summarizeSingleLine('审查当前改动。'), '审查当前改动。')
  // 换行与连续空白折叠为单个空格（SKILL.md 块标量描述跨行）
  assert.equal(summarizeSingleLine('第一行\n  第二行\t\t第三行'), '第一行 第二行 第三行')
  // 恰好等于上限：原样返回；超限：截断到 maxChars-1 并补省略号
  const exact = 'a'.repeat(120)
  assert.equal(summarizeSingleLine(exact), exact)
  assert.equal(summarizeSingleLine(`${exact}x`), `${'a'.repeat(119)}…`)
  // 截断在代理对（emoji）边界上不切割半个字符
  const emoji = '😀'.repeat(130)
  const cut = summarizeSingleLine(emoji)
  assert.ok(Array.from(cut).every((ch) => ch === '😀' || ch === '…'))
  assert.equal(Array.from(cut).length, 120)
})

test('ProfileDetailDrawer: 技能白名单列表渲染名称行与描述摘要（无描述技能不渲染摘要行）', { timeout: 60_000 }, () => {
  const longDesc = `开头 ${'很'.repeat(200)} 结尾`
  const profile: Profile = { id: 'helper', name: '助手', tags: [], skills: [] }
  const skills: SkillSummary[] = [
    { id: 'review', name: '代码审查', description: '审查当前改动。\n第二步核对一致性。', references: [] },
    { id: 'tally', name: '记账', references: [] },
    { id: 'long', name: '长描述', description: longDesc, references: [] },
  ]
  const store = makeTestStore({ profiles: [profile], models: [], skills })
  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, { profile, isNew: false, open: true, inline: true, onClose: () => {} }),
    ),
  )
  // 名称行始终渲染；描述摘要换行折叠为空格后出现
  assert.match(html, /代码审查/)
  assert.match(html, /审查当前改动。 第二步核对一致性。/)
  // 无描述技能：只有名称行，不产生空的摘要节点（按 tally 名称行计数校验）
  assert.match(html, /记账/)
  const tallyDescNodes = html.split(/<span class="profile-skill-desc"/).length - 1
  assert.equal(tallyDescNodes, 2, '仅带描述的两个技能渲染摘要节点')
  // 超长描述按 summarizeSingleLine 截断（与展示层同源计算）
  const expected = summarizeSingleLine(longDesc)
  assert.ok(expected.endsWith('…'))
  assert.ok(html.includes(`>${expected}</span>`), '摘要节点内容与 summarizeSingleLine 一致')
  // title 悬浮保留完整原文（含被截断的结尾）
  assert.ok(html.includes(`title="${longDesc}"`), 'title 保留完整描述供悬浮查看')
})
