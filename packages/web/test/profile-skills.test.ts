/**
 * Pure-model, SSR & DOM tests for the profile available-skills configuration:
 * - skills tri-state normalization in buildProfileSavePayload (profile-center-model);
 * - SSR coverage for the drawer allowlist list rendering description summaries
 *   (summarizeSingleLine collapse + truncation);
 * - allowlist search: threshold-gated SearchBox (PROFILE_SKILL_SEARCH_THRESHOLD),
 *   filterSkills reuse (name / id hits), empty-state split (no skills vs no matches),
 *   clear button restore, selection preserved across filtering, query reset on
 *   switch back to all-skills and on reopen, and the focus-scoped layered
 *   Escape (IME guard -> clear query -> close) that only works through
 *   DetailDrawer.onEscapeKeyDown because Radix listens on `document`.
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import type { Profile, SkillSummary } from '@helmx/protocol'
import { jsonResponse } from '@helmx/test-kit'
import React, { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { buildProfileSavePayload } from '../src/profiles/profile-center-model.js'
import { summarizeSingleLine } from '../src/lib/format.js'
import { ProfileDetailDrawer } from '../src/profiles/ProfileDetailDrawer.js'
import { ensureHappyDom, typeIntoControl, waitForCondition } from './helpers/dom-harness.js'
import { makeTestStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'

ensureHappyDom()

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u

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

// ---------------------------------------------------------------------------
// Skill allowlist search: fixtures and shared helpers
// ---------------------------------------------------------------------------

/** Six candidate skills with distinct name / id / description / references hit targets. */
const searchSkills: SkillSummary[] = [
  { id: 'alpha', name: '阿尔法', description: 'first skill', references: [] },
  { id: 'beta', name: 'Beta 审查', description: 'second skill', references: [] },
  { id: 'gamma', name: '伽马', description: 'runs database migrations', references: ['references/db.md'] },
  { id: 'delta', name: 'Delta', description: 'fourth skill', references: [] },
  { id: 'epsilon', name: 'Epsilon', description: 'fifth skill', references: [] },
  { id: 'zeta', name: 'Zeta', description: 'sixth skill', references: [] },
]

const allowlistProfile: Profile = { id: 'helper', name: '助手', tags: [], skills: [] }

function renderSkillsDrawerHtml(profile: Profile, skills: SkillSummary[]): string {
  const store = makeTestStore({ profiles: [profile], models: [], skills })
  return renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, { profile, isNew: false, open: true, inline: true, onClose: () => {} }),
    ),
  )
}

function countCheckboxes(html: string): number {
  return html.split('role="checkbox"').length - 1
}

/** Allowlist checkbox rows (button[role="checkbox"]) currently rendered inside the scroll container. */
function listCheckboxes(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>('.profile-skills-scroll [role="checkbox"]'))
}

/** Locate the checkbox row of one skill by the `(id)` mono text in its label (the Checkbox id is a React useId, not the skill id). */
function findCheckbox(host: HTMLElement, skillId: string): HTMLElement {
  for (const wrap of Array.from(host.querySelectorAll<HTMLElement>('.profile-skills-scroll .helmx-checkbox-wrap'))) {
    if (wrap.querySelector('.helmx-checkbox-label')?.textContent?.includes(`(${skillId})`)) {
      const button = wrap.querySelector<HTMLElement>('[role="checkbox"]')
      assert.ok(button !== null, `checkbox button for ${skillId} renders`)
      return button
    }
  }
  assert.fail(`checkbox for ${skillId} is rendered`)
}

interface MountedSkillsDrawer {
  host: HTMLElement
  searchInput: HTMLInputElement
  content: HTMLElement
  /** Re-render the same drawer with another `open` flag (close / reopen cycle). */
  setOpen(open: boolean): Promise<void>
}

/**
 * Mount the drawer (allowlist mode, inline) with the detail fetch stubbed to a
 * JSON response whose name differs from the list snapshot; the title flipping
 * to the detail name proves the detail merge has settled before interactions,
 * so no late fetch can reset the form mid-test. Teardown goes through t.after.
 */
async function mountSkillsDrawer(
  t: Pick<TestContext, 'after'>,
  skills: SkillSummary[],
  onClose: () => void,
): Promise<MountedSkillsDrawer> {
  const detail: Profile = { ...allowlistProfile, name: '助手详情' }
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL) =>
    // The drawer only fetches its own profile detail here; anything else is a 404.
    Promise.resolve(String(input) === '/api/profiles/helper' ? jsonResponse(detail) : jsonResponse({}, 404))) as typeof fetch

  const store = makeTestStore({ profiles: [allowlistProfile], models: [], skills })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const render = (open: boolean) =>
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, { profile: allowlistProfile, isNew: false, open, inline: true, onClose }),
    )
  const setOpen = async (open: boolean) => {
    await act(async () => {
      root.render(render(open))
    })
  }
  await setOpen(true)
  t.after(() => {
    act(() => {
      root.unmount()
    })
    host.remove()
    globalThis.fetch = originalFetch
  }, { timeout: 60_000 })

  await waitForCondition(() => host.querySelector('.primary-drawer-title')?.textContent === detail.name)
  const searchInput = host.querySelector<HTMLInputElement>('.search-box input')
  const content = host.querySelector<HTMLElement>('.primary-drawer-content')
  assert.ok(searchInput !== null, 'the allowlist search input renders above the threshold')
  assert.ok(content !== null, 'the drawer content renders inline')
  return { host, searchInput, content, setOpen }
}

// ---------------------------------------------------------------------------
// Skill allowlist search: SSR (threshold gate, all-skills mode, zero emoji)
// ---------------------------------------------------------------------------

test('ProfileDetailDrawer: 白名单模式候选技能超过阈值时渲染搜索框并保留全部复选框', { timeout: 60_000 }, () => {
  const html = renderSkillsDrawerHtml(allowlistProfile, searchSkills)
  assert.match(html, /aria-label="Search skills"/, '搜索框按 ariaLabel 渲染无障碍名称')
  assert.match(html, /placeholder="Search skills by name, ID or description…"/, '搜索框渲染 placeholder')
  assert.ok(html.includes('search-box'), '搜索框复用 SDK SearchBox 的 .search-box 词汇')
  assert.equal(countCheckboxes(html), 6, '阈值之上 6 个技能全部渲染为复选框')
  // 搜索框在滚动容器外（兄弟节点）：滚动列表时保持可见
  const searchIdx = html.indexOf('class="search-box"')
  const scrollIdx = html.indexOf('profile-skills-scroll')
  assert.ok(searchIdx > 0 && scrollIdx > searchIdx, '搜索框位于 profile-skills-scroll 滚动容器之前')
  assert.doesNotMatch(html, EMOJI_REGEX, '抽屉输出零 Emoji')
  assert.doesNotMatch(html, /No matching skills/, '未过滤时不渲染无匹配空态')
})

test('ProfileDetailDrawer: 候选技能不超过阈值时不渲染搜索框（阈值边界 5 项）', { timeout: 60_000 }, () => {
  const html = renderSkillsDrawerHtml(allowlistProfile, searchSkills.slice(0, 5))
  assert.doesNotMatch(html, /aria-label="Search skills"/, '5 个技能不超过 PROFILE_SKILL_SEARCH_THRESHOLD=5')
  assert.ok(!html.includes('search-box'), '阈值之下不渲染 SearchBox')
  assert.equal(countCheckboxes(html), 5, '5 个技能仍全部渲染')
})

test('ProfileDetailDrawer: 全部可用技能模式不渲染搜索框', { timeout: 60_000 }, () => {
  const html = renderSkillsDrawerHtml({ id: 'helper', name: '助手', tags: [] }, searchSkills)
  assert.doesNotMatch(html, /aria-label="Search skills"/, 'skills: undefined 走全部技能提示，不渲染搜索框')
  assert.ok(!html.includes('profile-skills-scroll'), '全部技能模式不渲染白名单列表')
  assert.equal(countCheckboxes(html), 0, '全部技能模式不渲染复选框')
  assert.match(html, /This profile may use every available skill without restriction\./)
})

// ---------------------------------------------------------------------------
// Skill allowlist search: DOM interaction (filter, empty state, clear, selection)
// ---------------------------------------------------------------------------

test('ProfileDetailDrawer: 技能搜索按名称 / ID / 描述过滤为匹配项，无匹配渲染空态，清除后恢复全量', { timeout: 60_000 }, async (t) => {
  const { host, searchInput } = await mountSkillsDrawer(t, searchSkills, () => {})
  assert.equal(listCheckboxes(host).length, 6, '初始渲染全部 6 个候选技能')
  assert.ok(host.querySelector('.search-box-clear') === null, '关键词为空时不渲染清除按钮')

  // 名称命中（大小写不敏感）：Beta 审查
  await act(async () => {
    typeIntoControl(searchInput, 'beta 审查')
  })
  assert.equal(listCheckboxes(host).length, 1, '按名称过滤只剩 1 项')
  assert.ok(findCheckbox(host, 'beta') !== undefined, '命中的是 beta')
  assert.ok(host.querySelector('.search-box-clear') !== null, '关键词非空时渲染清除按钮')

  // ID 命中：gamma
  await act(async () => {
    typeIntoControl(searchInput, 'GAMMA')
  })
  assert.equal(listCheckboxes(host).length, 1, '按 ID 过滤（大小写不敏感）只剩 1 项')
  findCheckbox(host, 'gamma')

  // 描述命中：migrations
  await act(async () => {
    typeIntoControl(searchInput, 'migrations')
  })
  assert.equal(listCheckboxes(host).length, 1, '按描述过滤只剩 1 项')
  findCheckbox(host, 'gamma')

  // 无匹配：空态文案 + 0 个复选框
  await act(async () => {
    typeIntoControl(searchInput, 'no-such-skill')
  })
  assert.equal(listCheckboxes(host).length, 0, '无匹配时不渲染复选框')
  assert.match(host.querySelector('.profile-skills-scroll')?.textContent ?? '', /No matching skills/, '渲染无匹配空态')
  assert.ok(!host.textContent?.includes('No skills loaded'), '无匹配不误用「暂无技能」空态')

  // 点击清除按钮恢复全量
  const clearBtn = host.querySelector<HTMLButtonElement>('.search-box-clear')
  assert.ok(clearBtn !== null, '清除按钮在关键词非空时渲染')
  assert.equal(clearBtn.getAttribute('aria-label'), 'Clear search')
  await act(async () => {
    clearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.equal(searchInput.value, '', '清除后关键词为空')
  assert.equal(listCheckboxes(host).length, 6, '清除后恢复全量 6 项')
  assert.ok(host.querySelector('.search-box-clear') === null, '清除后按钮消失')
})

test('ProfileDetailDrawer: 过滤态勾选的技能在清空搜索后仍保持选中（选中态不随过滤丢失）', { timeout: 60_000 }, async (t) => {
  const { host, searchInput } = await mountSkillsDrawer(t, searchSkills, () => {})
  // 选取一个初始不在视口的技能：先过滤到 delta，勾选
  await act(async () => {
    typeIntoControl(searchInput, 'delta')
  })
  const delta = findCheckbox(host, 'delta')
  assert.equal(delta.getAttribute('aria-checked'), 'false')
  await act(async () => {
    delta.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.equal(delta.getAttribute('aria-checked'), 'true', '过滤态下勾选生效')

  // 换一个关键词把 delta 过滤掉，再清空：delta 仍为选中
  await act(async () => {
    typeIntoControl(searchInput, 'zeta')
  })
  assert.equal(listCheckboxes(host).length, 1)
  const clearBtn = host.querySelector<HTMLButtonElement>('.search-box-clear')
  assert.ok(clearBtn !== null)
  await act(async () => {
    clearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.equal(listCheckboxes(host).length, 6, '清空后恢复全量')
  assert.equal(findCheckbox(host, 'delta').getAttribute('aria-checked'), 'true', '被过滤隐藏期间选中态保留')
  assert.equal(findCheckbox(host, 'zeta').getAttribute('aria-checked'), 'false', '其他技能未被误选')
  assert.equal(listCheckboxes(host).filter((c) => c.getAttribute('aria-checked') === 'true').length, 1, '仅 delta 选中')
})

// ---------------------------------------------------------------------------
// Skill allowlist search: layered Escape (focus-scoped, via DetailDrawer.onEscapeKeyDown)
// ---------------------------------------------------------------------------

test('ProfileDetailDrawer: 焦点在技能搜索框时 Esc 先清空关键词再关抽屉；IME 组合中不关；焦点在别处直接走关闭链', { timeout: 60_000 }, async (t) => {
  let closeCalls = 0
  const { host, searchInput, content } = await mountSkillsDrawer(t, searchSkills, () => {
    closeCalls += 1
  })
  const pressEscape = async (target: HTMLElement, init: KeyboardEventInit = {}) => {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }))
    })
  }

  await act(async () => {
    searchInput.focus()
  })
  assert.ok(document.activeElement === searchInput, '前置：焦点在搜索框')
  await act(async () => {
    typeIntoControl(searchInput, 'alpha')
  })
  assert.equal(listCheckboxes(host).length, 1)

  // IME 组合中（isComposing / keyCode 229）：Esc 归输入法，不关抽屉也不清关键词
  await pressEscape(searchInput, { isComposing: true })
  assert.equal(searchInput.value, 'alpha', 'IME 组合中 Esc 不清空关键词')
  assert.equal(closeCalls, 0, 'IME 组合中 Esc 不关抽屉')
  await pressEscape(searchInput, { keyCode: 229 })
  assert.equal(searchInput.value, 'alpha', 'keyCode 229 同样视为 IME 组合')
  assert.equal(closeCalls, 0, 'keyCode 229 不关抽屉')

  // 关键词非空：第一次 Esc 只清空关键词
  await pressEscape(searchInput)
  assert.equal(searchInput.value, '', '关键词非空时 Esc 清空关键词')
  assert.equal(closeCalls, 0, '清空关键词不关抽屉')
  assert.equal(listCheckboxes(host).length, 6, '清空后列表恢复全量')

  // 关键词为空：第二次 Esc 沿用原关闭链
  await pressEscape(searchInput)
  assert.equal(closeCalls, 1, '关键词为空时 Esc 关闭抽屉')

  // 焦点限定：关键词非空但焦点在抽屉其他位置时不介入，直接走关闭链且不动关键词
  await act(async () => {
    typeIntoControl(searchInput, 'beta')
  })
  await act(async () => {
    content.focus()
  })
  assert.ok(document.activeElement === content, '前置：焦点移回抽屉内容区')
  await pressEscape(content)
  assert.equal(closeCalls, 2, '焦点不在搜索框时 Esc 直接关闭')
  assert.equal(searchInput.value, 'beta', '焦点不在搜索框时 Esc 不清空关键词')
})

test('ProfileDetailDrawer: 切回「全部可用技能」清空关键词，抽屉重开后关键词重置', { timeout: 60_000 }, async (t) => {
  const { host, searchInput, setOpen } = await mountSkillsDrawer(t, searchSkills, () => {})
  await act(async () => {
    typeIntoControl(searchInput, 'alpha')
  })
  assert.equal(listCheckboxes(host).length, 1)

  // 切回全部技能：搜索框随白名单列表消失，关键词被清空
  const skillSwitch = host.querySelector<HTMLButtonElement>('#profile-form-skills-switch')
  assert.ok(skillSwitch !== null, 'the all-skills switch renders')
  await act(async () => {
    skillSwitch.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.equal(skillSwitch.getAttribute('aria-checked'), 'true', 'switch flipped to all skills')
  assert.ok(host.querySelector('.profile-skills-scroll') === null, 'allowlist list hidden in all-skills mode')

  // 再次关闭白名单：搜索框回来且关键词为空，列表全量（不被旧关键词过滤）
  await act(async () => {
    skillSwitch.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.equal(skillSwitch.getAttribute('aria-checked'), 'false', 'switch flipped back to allowlist')
  const reopenedInput = host.querySelector<HTMLInputElement>('.search-box input')
  assert.ok(reopenedInput !== null, 'search box returns with the allowlist')
  assert.equal(reopenedInput.value, '', 'returning to all skills cleared the stale query')
  assert.equal(listCheckboxes(host).length, 6, 'list is unfiltered after the switch round trip')

  // 抽屉关闭再打开：关键词随表单重置
  await act(async () => {
    typeIntoControl(reopenedInput, 'zeta')
  })
  assert.equal(listCheckboxes(host).length, 1)
  await setOpen(false)
  assert.ok(host.querySelector('.primary-drawer-content') === null, 'closed drawer renders no content')
  await setOpen(true)
  const afterReopen = host.querySelector<HTMLInputElement>('.search-box input')
  assert.ok(afterReopen !== null, 'search box renders after reopen')
  assert.equal(afterReopen.value, '', 'reopen resets the skill query')
  assert.equal(listCheckboxes(host).length, 6, 'reopen restores the unfiltered list')
})
