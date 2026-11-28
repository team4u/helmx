/**
 * 宿主与 @helmx/ui 样式分片归属契约（静态结构断言，非属性值正则）：
 * - 通用设计系统令牌与原语样式（tokens / base / Button / SearchBox / Screen / Tabs /
 *   StatusLight 等）统一归属独立包 `@helmx/ui`（`packages/ui/src/`）；
 * - 宿主样式分片（`packages/web/src/styles/`）只保留宿主业务与宿主耦合控件（如
 *   `ModelPickerControl` / `ToolCallDetails` / `.batch-bar`），绝不点名内置插件私有类；
 * - `@helmx/plugin-client` 渲染的全部字面 className 词元必须被 `@helmx/ui` ∪ 宿主 CSS
 *   覆盖；`{ui, web, plugin-client, plugins}` 全量 `var(--token)` 必须闭合；
 * - Round 2 已退场的 7 组旧样式族严禁回流 `web/src/styles/` 或 `ui/src/`。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STYLES_DIR = join(__dirname, '../src/styles')
const UI_SRC_DIR = join(__dirname, '../../ui/src')
const UI_PRIMITIVES_DIR = join(UI_SRC_DIR, 'primitives')
const SDK_SRC_DIR = join(__dirname, '../../plugin-client/src')
const primitives = readFileSync(join(STYLES_DIR, 'primitives.css'), 'utf8')

/** Selector-ownership probe: a shard owns a rule when the selector is declared at line start. */
const ownsRule = (css: string, selector: string): boolean =>
  new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`).test(css)

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
}

function listCssFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listCssFiles(full))
    else if (entry.name.endsWith('.css')) out.push(full)
  }
  return out.sort()
}

/**
 * 宿主与 @helmx/ui 样式分片不得选择内置插件私有类名（CSS ownership 单向边界）：
 * 插件视图的壳结构必须复用公共设计系统类（.screen-header / .screen-title /
 * .search-box / .helmx-table 等），宿主与设计系统绝不点名插件私有类做定向补丁。
 * 新增内置插件私有类前缀时同步登记此清单；公共词汇（helmx-/screen-/callout/
 * badge/btn/kv/table/stack/cell/loading/primary-/plugin- 等）不属插件私有。
 */
const PLUGIN_PRIVATE_CLASS_PREFIXES = [
  'workflow-', 'subagent-', 'execution-', 'wf-', // builtin:workflow
  'tg-', // builtin:triggers
  'magpie-', // builtin:magpie
  'tiers-', // builtin:tiers
  'plan-', // builtin:plan
] as const

test('样式边界：宿主与 @helmx/ui 分片零插件私有类名选择器（消除点名插件类名的 CSS 补丁）', { timeout: 60_000 }, () => {
  const repoPackagesDir = join(__dirname, '../..')
  const shards = [...listCssFiles(UI_SRC_DIR), ...listCssFiles(STYLES_DIR)].map((file) => ({
    name: file.slice(repoPackagesDir.length + 1),
    css: readFileSync(file, 'utf8'),
  }))
  assert.ok(shards.length > 0, '应能读取宿主与 @helmx/ui 样式分片')
  for (const { name, css } of shards) {
    for (const prefix of PLUGIN_PRIVATE_CLASS_PREFIXES) {
      assert.ok(
        !css.includes(`.${prefix}`),
        `样式分片 ${name} 不得选择插件私有类名 .${prefix}*（插件壳结构请复用公共设计系统类）`,
      )
    }
  }
})

/**
 * R3②（SDK → 设计系统 + 宿主 CSS 单向词汇边界）：@helmx/plugin-client 组件（ModelPicker /
 * ToolCallDetails / Markdown 等）渲染的全部字面 className 词元必须
 * ⊆ (@helmx/ui CSS ∪ 宿主样式分片类名集) ∪ SDK_SEMANTIC_CLASS_ALLOWLIST。
 *
 * 提取用 TypeScript AST 只收「类名句法位置」的字面量（className/class JSX
 * 属性、joinClass/clsx/cn 实参、同作用域局部类名变量初始化器、模块级常量映射表
 * `MAP[key]` 对象字面量值、?? / || / && 与三元操作数、数组 .filter/.join、
 * 模板字面量静态段、*ClassName 形参默认值与对象属性），图标名 / 文案等非类名
 * 字符串不会误入；动态拼接的运行时外部 className 不属 SDK 词汇，不在静态面内。
 *
 * 「DOM 在用但 CSS 故意不定义」的语义类是合法形态，但必须在此显式登记并
 * 写明缘由，防止孤儿词汇静默扩散；一旦 CSS 补齐真实定义，双向门禁强制移出。
 */
const SDK_SEMANTIC_CLASS_ALLOWLIST: Readonly<Record<string, string>> = {
  // ModelPicker 刷新按钮 / 档位 chip 的语义锚点，视觉由 btn / segmented-control-btn 家族承担。
  'composer-model-refresh-btn': 'ModelPicker refresh button semantic anchor; visuals carried by btn family',
  'composer-model-level-chip': 'ModelPicker level chip semantic anchor; visuals carried by segmented-control-btn',
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
    if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(token) && !token.endsWith('-')) {
      collector.tokens.add(token)
      const origins = collector.origins.get(token) ?? new Set<string>()
      origins.add(collector.file)
      collector.origins.set(token, origins)
    }
  }
}

function unwrapTypeExpression(expr: ts.Expression): ts.Expression {
  let cur = expr
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression
  }
  return cur
}

function bindingDeclaresName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name
  for (const element of binding.elements) {
    if (ts.isOmittedExpression(element)) continue
    if (bindingDeclaresName(element.name, name)) return true
  }
  return false
}

/**
 * 沿词法作用域链查找同文件内的局部变量或模块级常量初始化器：
 * - 遇到函数形参同名绑定即停止向上，避免误撞外层模块常量；
 * - 块级声明仅匹配出现在引用之前的声明，模块顶层常量允许前后声明。
 */
function findLocalInitializer(name: string, fromNode: ts.Node, sourceFile: ts.SourceFile): ts.Expression | undefined {
  const refPos = fromNode.getStart(sourceFile)
  let cur: ts.Node | undefined = fromNode
  while (cur !== undefined) {
    if (ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isModuleBlock(cur)) {
      const isTopLevel = ts.isSourceFile(cur) || ts.isModuleBlock(cur)
      for (const stmt of cur.statements) {
        if (!ts.isVariableStatement(stmt)) continue
        for (const decl of stmt.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) &&
            decl.name.text === name &&
            decl.initializer !== undefined &&
            (isTopLevel || decl.getStart(sourceFile) < refPos)
          ) {
            return decl.initializer
          }
        }
      }
    }
    if (ts.isFunctionLike(cur)) {
      for (const param of cur.parameters) {
        if (bindingDeclaresName(param.name, name)) return undefined
      }
    }
    cur = cur.parent
  }
  return undefined
}

/** 只在「类名句法位置」递归收集字符串字面量（追踪局部变量与常量映射表）。 */
function collectInClassPosition(
  expr: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
  collector: TokenCollector,
  seen: Set<ts.Node>,
): void {
  if (expr === undefined || seen.has(expr)) return
  seen.add(expr)

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    pushTokens(collector, expr.text)
    return
  }
  if (ts.isJsxExpression(expr)) {
    collectInClassPosition(expr.expression, sourceFile, collector, seen)
    return
  }
  if (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    collectInClassPosition(expr.expression, sourceFile, collector, seen)
    return
  }
  if (ts.isTemplateExpression(expr)) {
    pushTokens(collector, expr.head.text)
    let prev = expr.head.text
    for (const span of expr.templateSpans) {
      if (!prev.endsWith('-')) collectInClassPosition(span.expression, sourceFile, collector, seen)
      const lit = span.literal.text
      const cleaned = lit.startsWith('-') ? lit.replace(/^-[a-zA-Z0-9_-]*/, '') : lit
      pushTokens(collector, cleaned)
      prev = lit
    }
    return
  }
  if (ts.isConditionalExpression(expr)) {
    collectInClassPosition(expr.whenTrue, sourceFile, collector, seen)
    collectInClassPosition(expr.whenFalse, sourceFile, collector, seen)
    return
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      collectInClassPosition(expr.left, sourceFile, collector, seen)
      collectInClassPosition(expr.right, sourceFile, collector, seen)
    } else if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      collectInClassPosition(expr.right, sourceFile, collector, seen)
    }
    return
  }
  if (ts.isArrayLiteralExpression(expr)) {
    for (const el of expr.elements) {
      if (!ts.isSpreadElement(el)) collectInClassPosition(el, sourceFile, collector, seen)
    }
    return
  }
  if (ts.isIdentifier(expr)) {
    const init = findLocalInitializer(expr.text, expr, sourceFile)
    if (init !== undefined) collectInClassPosition(init, sourceFile, collector, seen)
    return
  }
  if (ts.isElementAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const init = findLocalInitializer(expr.expression.text, expr.expression, sourceFile)
    if (init !== undefined) {
      const target = unwrapTypeExpression(init)
      if (ts.isObjectLiteralExpression(target)) {
        for (const prop of target.properties) {
          if (ts.isPropertyAssignment(prop)) {
            collectInClassPosition(prop.initializer, sourceFile, collector, seen)
          }
        }
      }
    }
    return
  }
  if (ts.isCallExpression(expr)) {
    // 仅类名拼接助手（joinClass/clsx/cn）与数组/字符串尾调用（.filter/.join/.trim）
    // 属类名位置；其它函数调用内部字符串（文案、图标名）绝不误收。
    const callee = expr.expression
    if (ts.isIdentifier(callee) && /^(joinClass|clsx|cn)$/.test(callee.text)) {
      for (const arg of expr.arguments) collectInClassPosition(arg as ts.Expression, sourceFile, collector, seen)
    } else if (ts.isPropertyAccessExpression(callee) && /^(trim|join|filter)$/.test(callee.name.text)) {
      collectInClassPosition(callee.expression, sourceFile, collector, seen)
    }
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
        collectInClassPosition(node.initializer as ts.Expression | undefined, sourceFile, collector, new Set())
      } else if (ts.isPropertyAssignment(node) && isClassNameIdentifier(node.name.getText(sourceFile))) {
        collectInClassPosition(node.initializer, sourceFile, collector, new Set())
      } else if (ts.isBindingElement(node) && node.initializer !== undefined) {
        const name = (node.propertyName ?? node.name).getText(sourceFile)
        if (isClassNameIdentifier(name)) {
          collectInClassPosition(node.initializer, sourceFile, collector, new Set())
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return collector
}

test('样式边界：@helmx/plugin-client 字面 className 词元 ⊆ (@helmx/ui ∪ 宿主 CSS 类名集) ∪ 显式语义类登记（R3②）', { timeout: 60_000 }, () => {
  const definedClasses = new Set<string>()
  for (const file of [...listCssFiles(UI_SRC_DIR), ...listCssFiles(STYLES_DIR)]) {
    const css = readFileSync(file, 'utf8')
    for (const match of stripCssComments(css).matchAll(/\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g)) {
      definedClasses.add(match[1]!)
    }
  }
  assert.ok(definedClasses.size > 500, '应能从 @helmx/ui 与宿主样式分片解析出类名集')

  const { tokens, origins } = collectSdkClassTokens()
  assert.ok(tokens.size >= 40, `SDK 词元提取异常（仅 ${tokens.size} 个，应覆盖 ModelPicker / ToolCallDetails / 局部变量）`)
  // 守卫 AST 收集能力：局部变量、条件拼接与宿主耦合组件词元必须纳入覆盖
  for (const expected of [
    'composer-model-popover',
    'helmx-model-picker-field',
    'helmx-model-picker-trigger',
    'helmx-model-picker-sm',
    'popover-item-active',
    'segmented-control-btn',
    'tool-call-details',
    'trace-expanded-body',
  ]) {
    assert.ok(tokens.has(expected), `AST 收集器应覆盖 @helmx/plugin-client 词元 .${expected}`)
  }

  const violations: string[] = []
  for (const token of [...tokens].sort()) {
    if (definedClasses.has(token)) continue
    if (token in SDK_SEMANTIC_CLASS_ALLOWLIST) continue
    violations.push(`.${token} <- ${[...(origins.get(token) ?? [])].join(', ')}`)
  }
  assert.ok(
    violations.length === 0,
    `@helmx/plugin-client 引用了未定义且未登记的类名（需在 @helmx/ui 或宿主 CSS 补定义，或在 SDK_SEMANTIC_CLASS_ALLOWLIST 显式登记并写明缘由）：\n${violations.join('\n')}`,
  )

  // 登记表双向纪律：每个登记项必须仍被 SDK 引用，且 CSS 中尚未定义（防僵尸豁免项滞留）。
  for (const [name, reason] of Object.entries(SDK_SEMANTIC_CLASS_ALLOWLIST)) {
    assert.ok(reason.trim().length > 0, `语义类 .${name} 登记必须写明缘由`)
    assert.ok(tokens.has(name), `语义类 .${name} 已不被 @helmx/plugin-client 引用，应移出登记表`)
    assert.ok(!definedClasses.has(name), `语义类 .${name} 已在 CSS 中拥有真实定义，应移出语义类豁免登记表`)
  }
})

test('样式边界：.btn-inline 归属 @helmx/ui Button.css，宿主不重定义，旧 .callout--* 与 .trace-inline-btn 彻底清零', { timeout: 60_000 }, () => {
  const buttonCss = readFileSync(join(UI_PRIMITIVES_DIR, 'Button.css'), 'utf8')
  const webShards = listCssFiles(STYLES_DIR).map((file) => ({
    name: file.slice(STYLES_DIR.length + 1),
    css: readFileSync(file, 'utf8'),
  }))
  const uiShards = listCssFiles(UI_SRC_DIR).map((file) => ({
    name: `ui/${file.slice(UI_SRC_DIR.length + 1)}`,
    css: readFileSync(file, 'utf8'),
  }))
  assert.ok(webShards.length > 0, '应能读取宿主样式分片')

  assert.ok(ownsRule(buttonCss, '.btn-inline'), '@helmx/ui Button.css 应定义行内轻量按钮原语 .btn-inline')
  for (const selector of ['.btn-ghost.is-active', '.btn-icon.is-active', '.btn-icon-sm.is-active', '.btn-icon-xs.is-active']) {
    assert.ok(buttonCss.includes(selector), `@helmx/ui Button.css 应定义按钮激活态 ${selector}`)
  }
  for (const { name, css } of webShards) {
    assert.ok(!ownsRule(css, '.btn-inline'), `宿主分片 ${name} 不得重复定义 .btn-inline`)
  }
  for (const { name, css } of [...uiShards, ...webShards]) {
    for (const legacyCallout of ['.callout--warning', '.callout--error', '.callout--success']) {
      assert.ok(!css.includes(legacyCallout), `分片 ${name} 不得保留历史兼容类 ${legacyCallout}`)
    }
    assert.ok(!css.includes('.trace-inline-btn'), `分片 ${name} 不得保留已收口的旧类 .trace-inline-btn`)
  }
})

test('样式边界：主舞台 .screen-host-body / SearchBox / EmptyState 与 Tabs pills 归属 @helmx/ui 公共分片，无 :has() 补丁与旧类残留', { timeout: 60_000 }, () => {
  const screenCss = readFileSync(join(UI_PRIMITIVES_DIR, 'Screen.css'), 'utf8')
  const searchBoxCss = readFileSync(join(UI_PRIMITIVES_DIR, 'SearchBox.css'), 'utf8')
  const feedbackCss = readFileSync(join(UI_PRIMITIVES_DIR, 'Feedback.css'), 'utf8')
  const tabsCss = readFileSync(join(UI_PRIMITIVES_DIR, 'Tabs.css'), 'utf8')
  const centers = stripCssComments(readFileSync(join(STYLES_DIR, 'centers.css'), 'utf8'))
  const modelCenter = stripCssComments(readFileSync(join(STYLES_DIR, 'model-center.css'), 'utf8'))
  const strippedScreen = stripCssComments(screenCss)
  const strippedSearchBox = stripCssComments(searchBoxCss)
  const strippedPrimitives = stripCssComments(primitives)

  assert.ok(ownsRule(screenCss, '.screen-host-body'), '@helmx/ui Screen.css 应定义公共原语规则 .screen-host-body')
  for (const selector of ['.search-box-toolbar', '.search-box-clear']) {
    assert.ok(ownsRule(searchBoxCss, selector), `@helmx/ui SearchBox.css 应定义公共原语规则 ${selector}`)
  }
  for (const selector of ['.empty-state-prominent', '.empty-state-action']) {
    assert.ok(ownsRule(feedbackCss, selector), `@helmx/ui Feedback.css 应定义公共原语规则 ${selector}`)
  }
  // .search-box-toolbar 位于 inline-flex(.screen-toolbar-actions) 内时，flex-basis 必须与 width 一致（auto 或 <= width），
  // 否则 Chromium 按 width 算容器固有宽度、按更大的 flex-basis 排版会强制把同行兄弟按钮折到第二行。
  const toolbarSearchBlock = strippedSearchBox.match(/(?:^|\n)\.search-box-toolbar\s*\{([^}]*)\}/)?.[1] ?? ''
  const toolbarWidthPx = toolbarSearchBlock.match(/(?:^|[;\s])width:\s*(\d+(?:\.\d+)?)px\s*;/)?.[1]
  const toolbarFlexBasis = toolbarSearchBlock.match(/(?:^|[;\s])flex:\s*\S+\s+\S+\s+([^;\s]+)\s*;/)?.[1]
  assert.ok(toolbarWidthPx !== undefined && toolbarFlexBasis !== undefined, '.search-box-toolbar 应声明 width 与 flex')
  if (toolbarFlexBasis !== 'auto') {
    const basisPx = toolbarFlexBasis.match(/^(\d+(?:\.\d+)?)px$/)?.[1]
    assert.ok(
      basisPx !== undefined && Number(basisPx) <= Number(toolbarWidthPx),
      `.search-box-toolbar 的 flex-basis (${toolbarFlexBasis}) 不得大于 width (${toolbarWidthPx}px)，避免 .screen-toolbar-actions 同行按钮误折行`,
    )
  }
  assert.ok(!strippedScreen.includes('.screen-host-stage'), 'Screen.css 不得再包含 .screen-host-stage')
  assert.ok(!strippedScreen.includes(':has('), 'Screen.css 不得再包含 :has() 舞台补丁')
  assert.ok(!strippedPrimitives.includes('.screen-host-stage'), 'primitives.css 不得再包含 .screen-host-stage')
  assert.ok(!strippedPrimitives.includes(':has('), 'primitives.css 不得再包含 :has() 舞台补丁')

  for (const selector of ['.helmx-tabs-pills', '.tabs-pills', '.tabs-pill']) {
    assert.ok(ownsRule(tabsCss, selector), `@helmx/ui Tabs.css 应定义 Tabs pills 规则 ${selector}`)
  }

  for (const stale of ['.primary-category-pill', '.primary-center-empty', '.primary-search-box']) {
    assert.ok(!centers.includes(stale), `centers.css 不得再残留旧类 ${stale}`)
  }

  // Wave 2 五大中心迁至 @helmx/ui Screen / CardGrid / SelectCard / Tabs 后，锁定已退场旧类不得回流任何样式分片
  // （保留 .primary-drawer-* 供 DetailDrawer 复用）。
  const allCss = [
    ...listCssFiles(UI_SRC_DIR).map((file) => ({
      name: `ui/${file.slice(UI_SRC_DIR.length + 1)}`,
      css: stripCssComments(readFileSync(file, 'utf8')),
    })),
    ...listCssFiles(STYLES_DIR).map((file) => ({
      name: file.slice(STYLES_DIR.length + 1),
      css: stripCssComments(readFileSync(file, 'utf8')),
    })),
    { name: 'responsive.css', css: stripCssComments(readFileSync(join(__dirname, '../src/responsive.css'), 'utf8')) },
  ]
  for (const { name, css } of allCss) {
    for (const stale of [
      '.primary-center',
      '.primary-card-',
      '.model-center-tabs',
      '.model-center-tab-btn',
      '.model-center-main-tabs',
      '.model-toolbar-inline',
    ]) {
      assert.ok(!css.includes(stale), `样式分片 ${name} 不得回流已收口旧类 ${stale}`)
    }
  }
  assert.ok(
    !modelCenter.includes('.model-defaults-panel .composer-model-button'),
    'model-center.css 不得再残留已收口旧选择器 .model-defaults-panel .composer-model-button',
  )
})

test('样式边界：统一批量操作栏 .batch-bar 族归属 web primitives.css，.btn-danger-sm 归属 @helmx/ui Button.css（sidebar/overview 仅留布局微调）', { timeout: 60_000 }, () => {
  const buttonCss = readFileSync(join(UI_PRIMITIVES_DIR, 'Button.css'), 'utf8')
  const shards = readdirSync(STYLES_DIR)
    .filter((name) => name.endsWith('.css') && name !== 'primitives.css')
    .map((name) => ({ name, css: readFileSync(join(STYLES_DIR, name), 'utf8') }))
  for (const selector of ['.batch-bar', '.batch-bar-header', '.batch-bar-count', '.batch-bar-actions']) {
    assert.ok(ownsRule(primitives, selector), `primitives.css 应定义公共批量栏规则 ${selector}`)
    for (const { name, css } of shards) {
      assert.ok(!ownsRule(css, selector), `分片 ${name} 不得重新定义公共批量栏壳 ${selector}`)
    }
  }
  assert.ok(ownsRule(buttonCss, '.btn-danger-sm'), '@helmx/ui Button.css 应定义 .btn-danger-sm')
  for (const { name, css } of [{ name: 'primitives.css', css: primitives }, ...shards]) {
    assert.ok(!ownsRule(css, '.btn-danger-sm'), `宿主分片 ${name} 不得重复定义 .btn-danger-sm`)
  }
  const overview = readFileSync(join(STYLES_DIR, 'overview.css'), 'utf8')
  const responsive = readFileSync(join(__dirname, '../src/responsive.css'), 'utf8')
  const outline = readFileSync(join(STYLES_DIR, 'outline.css'), 'utf8')
  const modals = readFileSync(join(STYLES_DIR, 'modals.css'), 'utf8')
  assert.ok(ownsRule(overview, '.overview-batch-bar-wrap'), 'overview.css 应定义总览批量栏吸顶容器规则 .overview-batch-bar-wrap')
  for (const retiredOverview of ['.overview-scroll', '.overview-search-clear', '.overview-automated-banner-wrap']) {
    assert.ok(!overview.includes(retiredOverview), `overview.css 不得保留已收口旧类 ${retiredOverview}`)
  }
  assert.ok(!responsive.includes('.primary-center-topbar'), 'responsive.css 不得保留已收口旧类 .primary-center-topbar')
  assert.ok(!outline.includes('.conversation-outline-mode .segmented-control-btn'), 'outline.css 不得保留手写 segmented-control-btn 高度覆写')
  assert.ok(!modals.includes('.skill-reader-mode .segmented-control-btn'), 'modals.css 不得保留手写 segmented-control-btn 高度覆写')
  assert.ok(!modals.includes('.skill-file-select .helmx-select-trigger'), 'modals.css 不得保留手写 skill-file-select 28px 高度覆写')
  // 旧词汇不得回流（sidebar/overview 私有 header/actions/count/spacer 已收口）
  for (const { name, css } of shards) {
    for (const stale of ['.sidebar-batch-bar-header', '.sidebar-batch-bar-actions', '.overview-batch-bar-count', '.overview-batch-bar-spacer', '.overview-batch-bar-actions']) {
      assert.ok(!css.includes(stale), `分片 ${name} 不得回流出已收口的旧批量栏类 ${stale}`)
    }
  }
})

/** 运行时由 JS / Radix 动态注入的 CSS 自定义属性白名单（带明确来源说明，防僵尸登记）。 */
const RUNTIME_CSS_VAR_ALLOWLIST: Readonly<Record<string, string>> = {
  '--palette-vvh': 'OmniboxModal.tsx sets --palette-vvh dynamically from visualViewport.height',
  '--dialog-layer-z': '@helmx/ui Dialog/AlertDialog sets --dialog-layer-z inline for nested overlays',
  '--helmx-split-ratio': 'App.tsx sets --helmx-split-ratio inline for desktop resizable split panes',
  '--radix-popper-transform-origin': 'Radix Popper runtime CSS custom property for popover/dropdown/tooltip/select enter origin',
  '--radix-select-trigger-width': 'Radix Select runtime CSS custom property',
  '--radix-select-content-available-width': 'Radix Select runtime CSS custom property',
  '--radix-select-content-available-height': 'Radix Select runtime CSS custom property',
}

function extractCssVarRefs(text: string): Array<{ name: string; line: number }> {
  const refs: Array<{ name: string; line: number }> = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    let idx = 0
    while ((idx = line.indexOf('var(', idx)) !== -1) {
      let depth = 1
      let j = idx + 4
      while (j < line.length && depth > 0) {
        if (line[j] === '(') depth++
        else if (line[j] === ')') depth--
        j++
      }
      const inside = line.slice(idx + 4, j - 1).trim()
      const comma = inside.indexOf(',')
      const name = (comma === -1 ? inside : inside.slice(0, comma)).trim()
      if (name.startsWith('--')) refs.push({ name, line: i + 1 })
      idx += 4
    }
  }
  return refs
}

test('样式边界：@helmx/ui、Web 宿主、SDK 与内置插件客户端内全部 var(--token) 必须已定义或登记为运行时注入属性', { timeout: 60_000 }, () => {
  const repoPackagesDir = join(__dirname, '../..')
  const webSrcDir = join(__dirname, '../src')
  const pluginsSrcDir = join(__dirname, '../../plugins/src')
  const uiCssFiles = listCssFiles(UI_SRC_DIR)
  const webCssFiles = listCssFiles(webSrcDir)
  const pluginCssFiles = listCssFiles(pluginsSrcDir).filter((file) => file.includes('/client/'))
  const allCssFiles = [...uiCssFiles, ...webCssFiles, ...pluginCssFiles]
  assert.ok(uiCssFiles.length > 0 && webCssFiles.length > 0, '应能枚举 @helmx/ui 与宿主 CSS 文件')

  const definedTokens = new Set<string>()
  const strippedCssByFile = new Map<string, string>()
  for (const file of allCssFiles) {
    const stripped = stripCssComments(readFileSync(file, 'utf8'))
    strippedCssByFile.set(file, stripped)
    for (const match of stripped.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) {
      definedTokens.add(match[1]!)
    }
  }
  assert.ok(definedTokens.size > 50, 'tokens.css 应定义设计系统 CSS token 集')

  const referencedTokens = new Set<string>()
  const violations: string[] = []
  for (const [file, stripped] of strippedCssByFile.entries()) {
    const rel = file.slice(repoPackagesDir.length + 1)
    for (const ref of extractCssVarRefs(stripped)) {
      referencedTokens.add(ref.name)
      if (definedTokens.has(ref.name)) continue
      if (ref.name in RUNTIME_CSS_VAR_ALLOWLIST) continue
      violations.push(`${rel}:${ref.line}: undefined CSS variable ${ref.name}`)
    }
  }

  const tsFiles = [
    ...listSourceFiles(UI_SRC_DIR),
    ...listSourceFiles(webSrcDir),
    ...listSourceFiles(SDK_SRC_DIR),
    ...listSourceFiles(pluginsSrcDir).filter((file) => file.includes('/client/')),
  ]
  for (const file of tsFiles) {
    const rel = file.slice(repoPackagesDir.length + 1)
    const content = readFileSync(file, 'utf8')
    for (const ref of extractCssVarRefs(content)) {
      referencedTokens.add(ref.name)
      if (definedTokens.has(ref.name)) continue
      if (ref.name in RUNTIME_CSS_VAR_ALLOWLIST) continue
      violations.push(`${rel}:${ref.line}: undefined CSS variable ${ref.name}`)
    }
  }

  assert.deepEqual(
    violations,
    [],
    `发现未定义的 CSS 变量（如 --danger / --border-subtle 等失效 token）：\n${violations.join('\n')}`,
  )

  for (const [name, reason] of Object.entries(RUNTIME_CSS_VAR_ALLOWLIST)) {
    assert.ok(reason.trim().length > 0, `运行时 CSS 属性 ${name} 登记必须写明缘由`)
    assert.ok(referencedTokens.has(name), `运行时 CSS 属性 ${name} 已不再被引用，应移出白名单`)
  }
})

test('样式边界：@helmx/ui tokens.css 明暗主题覆盖对称（dark 主题不漏定义 light 色彩/阴影 token）', { timeout: 60_000 }, () => {
  const tokensCss = stripCssComments(readFileSync(join(UI_SRC_DIR, 'tokens.css'), 'utf8'))
  const lightBlock = tokensCss.match(/:root,\s*:root\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  const darkBlock = tokensCss.match(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  assert.ok(lightBlock !== '' && darkBlock !== '', 'tokens.css 必须同时声明 light 与 dark 主题块')

  const extractDefs = (block: string) =>
    new Set([...block.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[1]!))
  const light = extractDefs(lightBlock)
  const dark = extractDefs(darkBlock)

  // :root 自身匹配任意 data-theme，因此主题无关的基础圆角与字体变量无需在 dark 块重复声明。
  const themeInvariantTokens = new Set([
    '--radius-xs',
    '--radius-sm',
    '--radius-md',
    '--radius-lg',
    '--radius-pill',
    '--font-sans',
    '--font-mono',
    '--font',
    '--code',
  ])

  const missingInDark = [...light].filter((t) => !dark.has(t) && !themeInvariantTokens.has(t))
  const extraInDark = [...dark].filter((t) => !light.has(t))
  assert.deepEqual(missingInDark, [], `dark 主题缺少 light 主题变量：${missingInDark.join(', ')}`)
  assert.deepEqual(extraInDark, [], `dark 主题多出未在 light 声明的变量：${extraInDark.join(', ')}`)
})

test('样式边界：流内停靠工作台固定窄列与子会话 50/50 等分 flex 契约（零跨 Portal 变量依赖）', { timeout: 60_000 }, () => {
  const tokensCss = stripCssComments(readFileSync(join(UI_SRC_DIR, 'tokens.css'), 'utf8'))
  const rootBlock = tokensCss.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  assert.ok(rootBlock.includes('--helmx-drawer-narrow-width:'), 'tokens.css :root 必须定义 --helmx-drawer-narrow-width')

  const shellCss = stripCssComments(readFileSync(join(STYLES_DIR, 'shell.css'), 'utf8'))
  assert.ok(!shellCss.includes('--helmx-drawer-width'), 'shell.css 不再使用跨 Portal 的 --helmx-drawer-width')
  const mainStageBlock = shellCss.match(/\.helmx-main-stage\s*\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(/flex:\s*1 1 0%;/.test(mainStageBlock), '.helmx-main-stage 必须声明 flex: 1 1 0% 以与子会话等分')
  const dockedBlock = shellCss.match(/\.drawer-stack-dialog\.is-docked\s*\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(/position:\s*relative;/.test(dockedBlock), '.drawer-stack-dialog.is-docked 必须为流内 position: relative')
  const wideDockedBlock = shellCss.match(/\.drawer-stack-dialog-wide\.is-docked\s*\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(/flex:\s*1 1 0%;/.test(wideDockedBlock), '.drawer-stack-dialog-wide.is-docked 必须声明 flex: 1 1 0% 实现 50/50 等分')
})

/** Checks whether comment-stripped CSS declares or targets an exact class token (avoiding false matches like .helmx-card or .kv-list-foo). */
const hasExactClassSelector = (strippedCss: string, className: string): boolean => {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![a-zA-Z0-9_-])\\.${escaped}(?![a-zA-Z0-9_-])`).test(strippedCss)
}

test('样式边界：Round 2 已退场的 7 组旧容器/表单/浮层样式族不得回流宿主或 @helmx/ui 样式表，modals.css 不再滞留已迁出块', { timeout: 60_000 }, () => {
  const allCss = [
    ...listCssFiles(UI_SRC_DIR).map((file) => ({
      name: `ui/${file.slice(UI_SRC_DIR.length + 1)}`,
      css: stripCssComments(readFileSync(file, 'utf8')),
    })),
    ...listCssFiles(STYLES_DIR).map((file) => ({
      name: file.slice(STYLES_DIR.length + 1),
      css: stripCssComments(readFileSync(file, 'utf8')),
    })),
    { name: 'responsive.css', css: stripCssComments(readFileSync(join(__dirname, '../src/responsive.css'), 'utf8')) },
  ]
  assert.ok(allCss.length > 0, '应能读取宿主与 @helmx/ui 样式表')

  const retiredLegacyClasses = [
    'list',
    'row',
    'card',
    'section-flat',
    'section-flat-header',
    'section-flat-title',
    'form-grid',
    'form-grid-align-start',
    'form-grid-label',
    'form-grid-value',
    'kv-list',
    'dropdown-panel',
  ] as const

  for (const { name, css } of allCss) {
    for (const className of retiredLegacyClasses) {
      assert.ok(
        !ownsRule(css, `.${className}`) && !hasExactClassSelector(css, className),
        `样式表 ${name} 不得回流已退场的旧类选择器 .${className}（请使用 @helmx/ui 对应原语）`,
      )
    }
  }

  // modals.css 中已归位 centers.css 的技能阅读器 / 角色编辑器规则及死类不得回流
  const modalsCss = stripCssComments(readFileSync(join(STYLES_DIR, 'modals.css'), 'utf8'))
  for (const movedOrDead of [
    'skill-drawer-content',
    'skill-reader',
    'skill-scope-picker',
    'profile-editor-textarea',
    'profile-editor-meta',
    'profile-editor-hint',
    'plugin-card-header',
    'modal-body-flush',
  ]) {
    assert.ok(
      !hasExactClassSelector(modalsCss, movedOrDead),
      `modals.css 不得保留已归位 centers.css 或已清除的旧类 .${movedOrDead}`,
    )
  }
})
