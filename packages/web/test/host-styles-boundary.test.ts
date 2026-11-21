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
import ts from 'typescript'

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

/**
 * R3②（SDK → 宿主 CSS 单向词汇边界）：@helmx/plugin-client 组件渲染的全部
 * 字面 className 词元必须 ⊆ 宿主样式分片类名集 ∪ SDK_SEMANTIC_CLASS_ALLOWLIST。
 *
 * 提取用 TypeScript AST 只收「类名句法位置」的字面量（className/class JSX
 * 属性、joinClass 实参、?? 与三元操作数、模板字面量静态段、*ClassName 形参
 * 默认值与对象属性），图标名 / 文案等非类名字符串不会误入；动态拼接的运行时
 * 类名（外部传入的 className 值）不属 SDK 词汇，不在静态面内。
 *
 * 「DOM 在用但 CSS 故意不定义」的语义类是合法形态，但必须在此显式登记并
 * 写明缘由，防止孤儿词汇静默扩散；为登记类补视觉定义时须单独提交并同车移出。
 */
const SDK_SRC_DIR = join(__dirname, '../../plugin-client/src')

/** 显式登记的 SDK 语义类（在 DOM 中使用、宿主 CSS 故意不定义；视觉由并列类承担）。 */
const SDK_SEMANTIC_CLASS_ALLOWLIST: Readonly<Record<string, string>> = {
  // 架构复审裁决（board #67）：detail drawer 元信息行语义标记，在用三处
  // （web SkillDetailDrawer / workflow WorkflowLibraryDrawer / apps client），
  // 视觉由并列的 mono / text-subtle 承担；如需专属视觉，定义单独提交并移出本登记。
  'primary-drawer-id': 'detail drawer meta-line semantic marker; visuals carried by sibling mono/text-subtle',
  // 架构复审裁决（board #67）：空态第二行语义标记（swarm workbench 面板与 SDK
  // EmptyState），继承 .empty-state 的色彩排版，无独立样式诉求。
  'empty-state-hint': 'empty-state secondary line semantic marker; inherits .empty-state styling',
  // 门禁首跑发现的同类存量（model-picker 线引入）：ModelPicker 刷新按钮 /
  // 档位 chip 的语义锚点，视觉由 btn / segmented-control-btn 家族承担。
  'composer-model-refresh-btn': 'ModelPicker refresh button semantic anchor; visuals carried by btn family',
  'composer-model-level-chip': 'ModelPicker level chip semantic anchor; visuals carried by segmented-control-btn',
  // 门禁首跑发现的同类存量（Select 长期存在）：空态提示行字号标记，宿主无
  // .text-* 工具类体系，色彩由 text-subtle 承担。
  'text-xs': 'Select empty-hint size marker; no host .text-* utility system, color via text-subtle',
}

/** 递归收集目录下的 .ts/.tsx 源文件。 */
function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listSourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

interface TokenCollector {
  tokens: Set<string>
  origins: Map<string, Set<string>>
  file: string
}

function pushTokens(collector: TokenCollector, text: string): void {
  for (const token of text.split(/\s+/)) {
    if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(token)) {
      collector.tokens.add(token)
      const origins = collector.origins.get(token) ?? new Set<string>()
      origins.add(collector.file)
      collector.origins.set(token, origins)
    }
  }
}

/** 只在「类名句法位置」递归收集字符串字面量。 */
function collectInClassPosition(expr: ts.Expression | undefined, sourceFile: ts.SourceFile, collector: TokenCollector): void {
  if (expr === undefined) return
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    pushTokens(collector, expr.text)
    return
  }
  if (ts.isJsxExpression(expr)) {
    collectInClassPosition(expr.expression, sourceFile, collector)
    return
  }
  if (ts.isTemplateExpression(expr)) {
    pushTokens(collector, expr.head.text)
    for (const span of expr.templateSpans) pushTokens(collector, span.literal.text)
    return
  }
  if (ts.isConditionalExpression(expr)) {
    collectInClassPosition(expr.whenTrue, sourceFile, collector)
    collectInClassPosition(expr.whenFalse, sourceFile, collector)
    return
  }
  if (
    ts.isBinaryExpression(expr) &&
    (expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || expr.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    collectInClassPosition(expr.left, sourceFile, collector)
    collectInClassPosition(expr.right, sourceFile, collector)
    return
  }
  if (ts.isCallExpression(expr)) {
    // 仅类名拼接助手（joinClass/clsx/cn）的实参属类名位置；其它调用的
    // 内部字符串（文案、图标名）不收。
    const callee = expr.expression.getText(sourceFile)
    if (/^(joinClass|clsx|cn)$/.test(callee)) {
      for (const arg of expr.arguments) collectInClassPosition(arg as ts.Expression, sourceFile, collector)
    }
    return
  }
  if (ts.isParenthesizedExpression(expr)) {
    collectInClassPosition(expr.expression, sourceFile, collector)
  }
}

const isClassNameIdentifier = (name: string): boolean => /^(className|class|[a-zA-Z]*ClassName)$/.test(name)

function collectSdkClassTokens(): TokenCollector {
  const collector: TokenCollector = { tokens: new Set(), origins: new Map(), file: '' }
  for (const file of listSourceFiles(SDK_SRC_DIR)) {
    collector.file = file.slice(SDK_SRC_DIR.length + 1)
    const source = readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.ES2022,
      /* setParentNodes */ true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && isClassNameIdentifier(node.name.getText(sourceFile))) {
        collectInClassPosition(node.initializer as ts.Expression | undefined, sourceFile, collector)
      } else if (ts.isPropertyAssignment(node)) {
        const key = node.name.getText(sourceFile)
        if (isClassNameIdentifier(key) && (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))) {
          pushTokens(collector, node.initializer.text)
        }
      } else if (ts.isBindingElement(node) && node.initializer !== undefined) {
        const name = (node.propertyName ?? node.name).getText(sourceFile)
        if (isClassNameIdentifier(name) && ts.isStringLiteral(node.initializer) && node.name !== undefined) {
          pushTokens(collector, node.initializer.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return collector
}

test('样式边界：SDK 组件字面 className 词元 ⊆ 宿主 CSS 类名集 ∪ 显式语义类登记（R3②）', { timeout: 60_000 }, () => {
  const hostClasses = new Set<string>()
  for (const { css } of readdirSync(STYLES_DIR)
    .filter((name) => name.endsWith('.css'))
    .map((name) => ({ name, css: readFileSync(join(STYLES_DIR, name), 'utf8') }))) {
    for (const match of css.matchAll(/\.([a-zA-Z0-9_-]+)/g)) hostClasses.add(match[1]!)
  }
  assert.ok(hostClasses.size > 500, '应能从宿主样式分片解析出类名集')

  const { tokens, origins } = collectSdkClassTokens()
  assert.ok(tokens.size > 50, `SDK 词元提取异常（仅 ${tokens.size} 个）`)

  const violations: string[] = []
  for (const token of [...tokens].sort()) {
    if (hostClasses.has(token)) continue
    if (token in SDK_SEMANTIC_CLASS_ALLOWLIST) continue
    violations.push(`.${token} <- ${[...(origins.get(token) ?? [])].join(', ')}`)
  }
  assert.ok(
    violations.length === 0,
    `SDK 引用了宿主未定义且未登记的类名（需在宿主 CSS 补定义，或在 SDK_SEMANTIC_CLASS_ALLOWLIST 显式登记并写明缘由）：\n${violations.join('\n')}`,
  )

  // 登记表自身纪律：每个登记项必须仍被 SDK 引用（防僵尸登记），且必须带缘由。
  for (const [name, reason] of Object.entries(SDK_SEMANTIC_CLASS_ALLOWLIST)) {
    assert.ok(reason.trim().length > 0, `语义类 .${name} 登记必须写明缘由`)
    assert.ok(tokens.has(name), `语义类 .${name} 已不被 SDK 引用，应移出登记表`)
  }
})

test('样式边界：统一批量操作栏 .batch-bar 族完整归属 primitives.css（sidebar/overview 分片仅留布局微调）', { timeout: 60_000 }, () => {
  const shards = readdirSync(STYLES_DIR)
    .filter((name) => name.endsWith('.css') && name !== 'primitives.css')
    .map((name) => ({ name, css: readFileSync(join(STYLES_DIR, name), 'utf8') }))
  for (const selector of ['.batch-bar', '.batch-bar-header', '.batch-bar-count', '.batch-bar-actions']) {
    assert.ok(ownsRule(primitives, selector), `primitives.css 应定义公共批量栏规则 ${selector}`)
    for (const { name, css } of shards) {
      assert.ok(!ownsRule(css, selector), `分片 ${name} 不得重新定义公共批量栏壳 ${selector}`)
    }
  }
  // 旧词汇不得回流（sidebar/overview 私有 header/actions/count/spacer 已收口）
  for (const { name, css } of shards) {
    for (const stale of ['.sidebar-batch-bar-header', '.sidebar-batch-bar-actions', '.overview-batch-bar-count', '.overview-batch-bar-spacer', '.overview-batch-bar-actions']) {
      assert.ok(!css.includes(stale), `分片 ${name} 不得回流出已收口的旧批量栏类 ${stale}`)
    }
  }
})
