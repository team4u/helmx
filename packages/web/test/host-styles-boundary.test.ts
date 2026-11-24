/**
 * 宿主样式分片归属契约（静态结构断言，非属性值正则）：
 * `.status-dot` 通用状态灯词汇（base / working / blocked / done / error /
 * background + keyframes + prefers-reduced-motion）是宿主公共设计系统资产，
 * 被 @helmx/plugin-client 的 StatusLight 共享，必须完整归属 primitives.css；
 * navigation.css 只允许保留导航专有覆盖（如 .sidebar-overview-group 的 6px 小点），
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

test('样式边界：navigation.css 仅保留导航专有状态点覆盖（sidebar-overview-group 小点）', { timeout: 60_000 }, () => {
  assert.ok(
    ownsRule(navigation, '.sidebar-overview-group .status-dot'),
    '导航专属 6px 小点覆盖保留在 navigation.css',
  )
  assert.ok(
    !ownsRule(primitives, '.sidebar-overview-group .status-dot'),
    '导航专属覆盖不得漂移进公共分片',
  )
})

test('样式边界：StatusLight 统一外壳与 sr-only 文本归属 primitives.css（共享原语可用的公共资产）', { timeout: 60_000 }, () => {
  for (const selector of ['.helmx-status-light', '.helmx-status-light .status-dot', '.helmx-sr-only']) {
    assert.ok(ownsRule(primitives, selector), `primitives.css 应定义共享状态灯外壳规则 ${selector}`)
    assert.ok(!ownsRule(navigation, selector), `navigation.css 不得定义 ${selector}`)
  }
})

test('样式边界：通用旋转动效归属 primitives.css（不依赖 plugin-center.css 分片）', { timeout: 60_000 }, () => {
  const pluginCenter = readFileSync(join(STYLES_DIR, 'plugin-center.css'), 'utf8')
  assert.ok(primitives.includes('@keyframes convSpin360'), 'primitives.css 应定义 @keyframes convSpin360')
  assert.ok(!pluginCenter.includes('@keyframes convSpin360'), 'plugin-center.css 不得再定义 @keyframes convSpin360')
  assert.ok(ownsRule(primitives, '.spin'), 'primitives.css 应定义 .spin')
  assert.ok(!ownsRule(pluginCenter, '.spin'), 'plugin-center.css 不得再定义 .spin')
  assert.ok(
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.spin-slow/.test(primitives),
    'primitives.css 的减动效规则覆盖 .spin-slow 旋转动效',
  )
})

test('样式边界：通用无内联工具类归属末尾 utilities.css（不藏在 modals.css）且 tokens.css 暴露间距阶梯', { timeout: 60_000 }, () => {
  const utilities = readFileSync(join(STYLES_DIR, 'utilities.css'), 'utf8')
  const modals = readFileSync(join(STYLES_DIR, 'modals.css'), 'utf8')
  const stylesEntry = readFileSync(join(__dirname, '../src/styles.css'), 'utf8')
  const tokens = readFileSync(join(STYLES_DIR, 'tokens.css'), 'utf8')

  for (const selector of ['.flex-row', '.flex-col', '.text-muted', '.text-subtle', '.text-err']) {
    assert.ok(ownsRule(utilities, selector), `utilities.css 应定义公共工具类 ${selector}`)
    assert.ok(!ownsRule(modals, selector), `modals.css 不得再保留公共工具类 ${selector}`)
  }

  const hostComponentImports = [...stylesEntry.matchAll(/@import\s+'\.\/styles\/([^']+)'\s+layer\(host-components\);/g)].map(
    (m) => m[1],
  )
  assert.equal(
    hostComponentImports.at(-1),
    'utilities.css',
    'utilities.css 必须位于 @layer host-components 最末尾，确保修饰类级联顺序可预测',
  )

  for (const token of ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6']) {
    assert.ok(tokens.includes(`${token}:`), `tokens.css 应定义公共间距变量 ${token}`)
  }
})

/**
 * 宿主样式分片不得选择内置插件私有类名（CSS ownership 单向边界）：
 * 插件视图的壳结构必须复用公共设计系统类（.screen-header / .screen-title /
 * .search-box / .helmx-table 等），宿主绝不点名插件私有类做定向补丁。
 * 新增内置插件私有类前缀时同步登记此清单；公共词汇（helmx-/screen-/callout/
 * badge/btn/kv/table/stack/cell/loading/primary-/plugin- 等）不属插件私有。
 */
const PLUGIN_PRIVATE_CLASS_PREFIXES = [
  'workflow-', 'subagent-', 'execution-', 'wf-', // builtin:workflow
  'herdr-', 'hd-', // builtin:herdr
  'tg-', // builtin:triggers
  'magpie-', // builtin:magpie
  'tiers-', // builtin:tiers
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
  // 架构复审裁决（board #67）：detail drawer 元信息行语义标记，在用两处
  // （web SkillDetailDrawer / workflow WorkflowLibraryDrawer），
  // 视觉由并列的 mono / text-subtle 承担；如需专属视觉，定义单独提交并移出本登记。
  'primary-drawer-id': 'detail drawer meta-line semantic marker; visuals carried by sibling mono/text-subtle',
  // 架构复审裁决（board #67）：空态第二行语义标记（swarm workbench 面板与 SDK
  // EmptyState），继承 .empty-state 的色彩排版，无独立样式诉求。
  'empty-state-hint': 'empty-state secondary line semantic marker; inherits .empty-state styling',
  // 门禁首跑发现的同类存量（model-picker 线引入）：ModelPicker 刷新按钮 /
  // 档位 chip 的语义锚点，视觉由 btn / segmented-control-btn 家族承担。
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

test('样式边界：统一批量操作栏 .batch-bar 族与 .btn-danger-sm 完整归属 primitives.css（sidebar/overview 分片仅留布局微调）', { timeout: 60_000 }, () => {
  const shards = readdirSync(STYLES_DIR)
    .filter((name) => name.endsWith('.css') && name !== 'primitives.css')
    .map((name) => ({ name, css: readFileSync(join(STYLES_DIR, name), 'utf8') }))
  for (const selector of ['.batch-bar', '.batch-bar-header', '.batch-bar-count', '.batch-bar-actions', '.btn-danger-sm']) {
    assert.ok(ownsRule(primitives, selector), `primitives.css 应定义公共批量栏规则 ${selector}`)
    for (const { name, css } of shards) {
      assert.ok(!ownsRule(css, selector), `分片 ${name} 不得重新定义公共批量栏壳 ${selector}`)
    }
  }
  const overview = readFileSync(join(STYLES_DIR, 'overview.css'), 'utf8')
  for (const selector of ['.overview-scroll', '.overview-batch-bar-wrap', '.overview-batch-bar-wrap + .overview-grid', '.overview-batch-bar-wrap + .overview-sections']) {
    assert.ok(ownsRule(overview, selector), `overview.css 应定义总览批量栏同域滚动与对齐规则 ${selector}`)
  }
  // 旧词汇不得回流（sidebar/overview 私有 header/actions/count/spacer 已收口）
  for (const { name, css } of shards) {
    for (const stale of ['.sidebar-batch-bar-header', '.sidebar-batch-bar-actions', '.overview-batch-bar-count', '.overview-batch-bar-spacer', '.overview-batch-bar-actions']) {
      assert.ok(!css.includes(stale), `分片 ${name} 不得回流出已收口的旧批量栏类 ${stale}`)
    }
  }
})

/** 运行时由 JS / Radix 动态注入的 CSS 自定义属性白名单（带明确来源说明，防僵尸登记）。 */
const RUNTIME_CSS_VAR_ALLOWLIST: Readonly<Record<string, string>> = {
  '--palette-vvh': 'CommandPaletteModal.tsx sets --palette-vvh dynamically from visualViewport.height',
  '--dialog-layer-z': '@helmx/plugin-client Dialog/AlertDialog sets --dialog-layer-z inline for nested overlays',
  '--helmx-split-ratio': 'App.tsx sets --helmx-split-ratio inline for desktop resizable split panes',
  '--radix-popper-transform-origin': 'Radix Popper runtime CSS custom property for popover/dropdown/tooltip/select enter origin',
  '--radix-select-trigger-width': 'Radix Select runtime CSS custom property',
  '--radix-select-content-available-width': 'Radix Select runtime CSS custom property',
  '--radix-select-content-available-height': 'Radix Select runtime CSS custom property',
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

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
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

test('样式边界：Web 宿主、SDK 与内置插件客户端内全部 var(--token) 必须已定义或登记为运行时注入属性', { timeout: 60_000 }, () => {
  const repoPackagesDir = join(__dirname, '../..')
  const webSrcDir = join(__dirname, '../src')
  const pluginsSrcDir = join(__dirname, '../../plugins/src')
  const webCssFiles = listCssFiles(webSrcDir)
  const pluginCssFiles = listCssFiles(pluginsSrcDir).filter((file) => file.includes('/client/'))
  const allCssFiles = [...webCssFiles, ...pluginCssFiles]
  assert.ok(webCssFiles.length > 0, '应能枚举宿主 CSS 文件')

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

test('样式边界：tokens.css 明暗主题覆盖对称（dark 主题不漏定义 light 色彩/阴影 token）', { timeout: 60_000 }, () => {
  const tokensCss = stripCssComments(readFileSync(join(STYLES_DIR, 'tokens.css'), 'utf8'))
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
