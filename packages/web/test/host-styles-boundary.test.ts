/**
 * 宿主样式分片归属契约（静态结构断言，非属性值正则）：
 * `.status-dot` 通用状态灯词汇（base / working / blocked / done / error /
 * background + keyframes + prefers-reduced-motion）是宿主公共设计系统资产，
 * 被 @helmx/plugin-client 的 StatusLight 共享，必须完整归属 primitives.css；
 * navigation.css 只允许保留导航专有覆盖（如 .agent-standing-group 的 6px 小点），
 * 避免「共享原语依赖导航私有样式」的架构漂移与级联回归。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STYLES_DIR = join(__dirname, '../src/styles')
const primitives = readFileSync(join(STYLES_DIR, 'primitives.css'), 'utf8')
const navigation = readFileSync(join(STYLES_DIR, 'navigation.css'), 'utf8')

/** Selector-ownership probe: a shard owns a rule when the selector is declared at line start. */
const ownsRule = (css: string, selector: string): boolean =>
  new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`).test(css)

test('样式边界：通用状态灯词汇完整归属 primitives.css（base/色调/空心环/动效/减动效）', { timeout: 60_000 }, () => {
  for (const selector of [
    '.status-dot',
    '.status-dot-working',
    '.status-dot-blocked',
    '.status-dot-done',
    '.status-dot-error',
    '.status-dot-background',
    '.status-dot-aborted',
    '.status-dot-pending',
  ]) {
    assert.ok(ownsRule(primitives, selector), `primitives.css 应定义公共状态灯规则 ${selector}`)
    assert.ok(!ownsRule(navigation, selector), `navigation.css 不得再定义通用状态灯规则 ${selector}`)
  }
  for (const keyframe of ['@keyframes status-dot-pulse', '@keyframes status-dot-background-pulse']) {
    assert.ok(primitives.includes(keyframe), `primitives.css 应携带 ${keyframe}`)
    assert.ok(!navigation.includes(keyframe), `navigation.css 不得携带 ${keyframe}`)
  }
  assert.ok(
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.status-dot-working/.test(primitives),
    'primitives.css 的减动效规则覆盖状态灯呼吸动画',
  )
  assert.ok(!navigation.includes('prefers-reduced-motion'), 'navigation.css 不再携带状态灯减动效规则')
})

test('样式边界：navigation.css 仅保留导航专有状态点覆盖（agent-standing-group 小点）', { timeout: 60_000 }, () => {
  assert.ok(
    ownsRule(navigation, '.agent-standing-group .status-dot'),
    '导航专属 6px 小点覆盖保留在 navigation.css',
  )
  assert.ok(
    !ownsRule(primitives, '.agent-standing-group .status-dot'),
    '导航专属覆盖不得漂移进公共分片',
  )
})

test('样式边界：StatusLight 统一外壳与 sr-only 文本归属 primitives.css（共享原语可用的公共资产）', { timeout: 60_000 }, () => {
  for (const selector of ['.helmx-status-light', '.helmx-status-light .status-dot', '.helmx-sr-only']) {
    assert.ok(ownsRule(primitives, selector), `primitives.css 应定义共享状态灯外壳规则 ${selector}`)
    assert.ok(!ownsRule(navigation, selector), `navigation.css 不得定义 ${selector}`)
  }
})

/**
 * 宿主样式分片不得选择内置插件私有类名（CSS ownership 单向边界）：
 * 插件视图的壳结构必须复用公共设计系统类（.screen-header / .screen-title /
 * .search-box / .helmx-table 等），宿主绝不点名插件私有类做定向补丁——
 * 曾经的 `.screen-host-stage .apps-center-topbar .apps-center-title` 标题抑制
 * 补丁已通过把 apps 中心顶栏迁移到标准壳类消除。
 * 新增内置插件私有类前缀时同步登记此清单；公共词汇（helmx-/screen-/callout/
 * badge/btn/kv/table/stack/cell/loading/primary-/plugin- 等）不属插件私有。
 */
const PLUGIN_PRIVATE_CLASS_PREFIXES = [
  'apps-', 'app-card', 'app-detail', // builtin:apps
  'workflow-', 'subagent-', 'execution-', 'wf-', // builtin:workflow
  'herdr-', 'hd-', // builtin:herdr
  'sa-', // builtin:superagent
  'tg-', // builtin:triggers
  'magpie-', // builtin:magpie
] as const

test('样式边界：宿主分片零插件私有类名选择器（消除宿主点名插件类名的 CSS 补丁）', { timeout: 60_000 }, () => {
  const shards = readdirSync(STYLES_DIR)
    .filter((name) => name.endsWith('.css'))
    .map((name) => ({ name, css: readFileSync(join(STYLES_DIR, name), 'utf8') }))
  assert.ok(shards.length > 0, '应能读取宿主样式分片')
  for (const { name, css } of shards) {
    for (const prefix of PLUGIN_PRIVATE_CLASS_PREFIXES) {
      assert.ok(
        !css.includes(`.${prefix}`),
        `宿主分片 ${name} 不得选择插件私有类名 .${prefix}*（插件壳结构请复用公共设计系统类）`,
      )
    }
  }
})
