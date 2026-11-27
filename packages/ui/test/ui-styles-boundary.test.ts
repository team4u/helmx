/**
 * @helmx/ui self-closure & architectural boundary tests:
 * 1. Self-closure CSS AST gate: every literal className token emitted by
 *    `packages/ui/src` (.ts/.tsx) MUST be defined in `packages/ui/src` (.css)
 *    (or explicitly registered in the bi-directionally checked semantic allowlist);
 * 2. `tokens.css` dark/light coverage symmetry + CSS custom property self-closure;
 * 3. `UI_SHARED_EXPORTS` bi-directional parity with `packages/ui/src/index.ts`
 *    and strict disjointness with `PLUGIN_CLIENT_SHARED_EXPORTS`;
 * 4. Standalone decoupling gate: ZERO imports of `@helmx/plugin-client`,
 *    `PluginClientContext`, `PluginClientHostContext`, or `.css` inside
 *    `packages/ui/src` (.ts/.tsx) (keeps tsx --test and SSR loader-free).
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'
import { PLUGIN_CLIENT_SHARED_EXPORTS, UI_SHARED_EXPORTS } from '@helmx/protocol'
import * as HelmxUi from '../src/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UI_SRC_DIR = join(__dirname, '../src')

/** Host/internal-only runtime symbols exported by `@helmx/ui` outside `UI_SHARED_EXPORTS`. */
const UI_HOST_EXPORTS = [
  'UiScopeContext',
  'UiLocaleContext',
  'ScreenHostContext',
  'useScreenHost',
  'FieldContext',
  'useFieldContext',
  'useFieldControlProps',
  'mergeAriaDescribedBy',
] as const

/** Semantic DOM marker classes intentionally unstyled in `@helmx/ui` CSS (visuals carried by sibling classes). */
const UI_SEMANTIC_CLASS_ALLOWLIST: Readonly<Record<string, string>> = {
  'primary-drawer-id': 'DetailDrawer meta-line semantic marker; visuals carried by sibling mono/text-subtle',
  'helmx-select-multi': 'MultiSelect root semantic marker; visuals carried by sibling .helmx-select and .helmx-select-multi-option',
}

/** Runtime CSS custom properties injected dynamically by JS or Radix Popper. */
const UI_RUNTIME_CSS_VAR_ALLOWLIST: Readonly<Record<string, string>> = {
  '--dialog-layer-z': 'Dialog/AlertDialog sets --dialog-layer-z inline for nested overlay stacking',
  '--radix-popper-transform-origin': 'Radix Popper runtime CSS custom property',
  '--radix-select-trigger-width': 'Radix Select runtime CSS custom property',
  '--radix-select-content-available-width': 'Radix Select runtime CSS custom property',
  '--radix-select-content-available-height': 'Radix Select runtime CSS custom property',
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
}

function listFiles(dir: string, pattern: RegExp): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, pattern))
    else if (pattern.test(entry.name)) out.push(full)
  }
  return out.sort()
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
    const callee = expr.expression
    if (ts.isIdentifier(callee) && /^(joinClass|clsx|cn)$/.test(callee.text)) {
      for (const arg of expr.arguments) collectInClassPosition(arg as ts.Expression, sourceFile, collector, seen)
    } else if (ts.isPropertyAccessExpression(callee) && /^(trim|join|filter)$/.test(callee.name.text)) {
      collectInClassPosition(callee.expression, sourceFile, collector, seen)
    }
  }
}

const isClassNameIdentifier = (name: string): boolean => /^(className|class|[a-zA-Z]*ClassName)$/.test(name)

function collectUiClassTokens(): TokenCollector {
  const collector: TokenCollector = { tokens: new Set(), origins: new Map(), file: '' }
  for (const file of listFiles(UI_SRC_DIR, /\.(ts|tsx)$/)) {
    collector.file = file.slice(UI_SRC_DIR.length + 1)
    const source = readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.ES2022,
      true,
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

test('@helmx/ui CSS self-closure: every literal className token in packages/ui/src is defined in packages/ui/src/**/*.css', { timeout: 60_000 }, () => {
  const cssFiles = listFiles(UI_SRC_DIR, /\.css$/)
  assert.ok(cssFiles.length >= 20, `expected colocated CSS files in packages/ui/src, got ${cssFiles.length}`)

  const stylesEntry = readFileSync(join(UI_SRC_DIR, 'styles.css'), 'utf8')
  const primitiveCssFiles = listFiles(join(UI_SRC_DIR, 'primitives'), /\.css$/)
  for (const file of primitiveCssFiles) {
    const base = file.slice(join(UI_SRC_DIR, 'primitives').length + 1)
    assert.ok(
      stylesEntry.includes(`'./primitives/${base}' layer(ui-primitives)`),
      `packages/ui/src/styles.css must import './primitives/${base}' into layer(ui-primitives)`,
    )
  }

  const definedClasses = new Set<string>()
  for (const file of cssFiles) {
    const css = stripCssComments(readFileSync(file, 'utf8'))
    for (const match of css.matchAll(/\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g)) {
      definedClasses.add(match[1]!)
    }
  }
  assert.ok(definedClasses.size > 150, 'expected @helmx/ui CSS class vocabulary')

  const { tokens, origins } = collectUiClassTokens()
  assert.ok(tokens.size >= 140, `expected AST collector to find >= 140 class tokens, got ${tokens.size}`)

  const violations: string[] = []
  for (const token of [...tokens].sort()) {
    if (definedClasses.has(token)) continue
    if (token in UI_SEMANTIC_CLASS_ALLOWLIST) continue
    violations.push(`.${token} <- ${[...(origins.get(token) ?? [])].join(', ')}`)
  }
  assert.deepEqual(
    violations,
    [],
    `@helmx/ui references CSS classes not defined in packages/ui/src/**/*.css:\n${violations.join('\n')}`,
  )

  for (const [name, reason] of Object.entries(UI_SEMANTIC_CLASS_ALLOWLIST)) {
    assert.ok(reason.trim().length > 0, `allowlist entry .${name} must explain why`)
    assert.ok(tokens.has(name), `allowlist entry .${name} is no longer referenced in packages/ui/src`)
    assert.ok(!definedClasses.has(name), `allowlist entry .${name} is now defined in CSS and must be removed`)
  }
})

test('@helmx/ui tokens.css dark/light symmetry and var(--token) self-closure', { timeout: 60_000 }, () => {
  const tokensCss = stripCssComments(readFileSync(join(UI_SRC_DIR, 'tokens.css'), 'utf8'))
  const lightBlock = tokensCss.match(/:root,\s*:root\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  const darkBlock = tokensCss.match(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  assert.ok(lightBlock !== '' && darkBlock !== '', 'tokens.css must declare both light and dark blocks')

  const extractDefs = (block: string) =>
    new Set([...block.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[1]!))
  const light = extractDefs(lightBlock)
  const dark = extractDefs(darkBlock)

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
  assert.deepEqual(missingInDark, [], `dark theme missing light tokens: ${missingInDark.join(', ')}`)
  assert.deepEqual(extraInDark, [], `dark theme has extra tokens not in light: ${extraInDark.join(', ')}`)

  const cssFiles = listFiles(UI_SRC_DIR, /\.css$/)
  const definedTokens = new Set<string>()
  const strippedByFile = new Map<string, string>()
  for (const file of cssFiles) {
    const stripped = stripCssComments(readFileSync(file, 'utf8'))
    strippedByFile.set(file, stripped)
    for (const match of stripped.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) {
      definedTokens.add(match[1]!)
    }
  }

  const referenced = new Set<string>()
  const violations: string[] = []
  for (const [file, stripped] of strippedByFile.entries()) {
    const rel = file.slice(UI_SRC_DIR.length + 1)
    for (const ref of extractCssVarRefs(stripped)) {
      referenced.add(ref.name)
      if (definedTokens.has(ref.name) || ref.name in UI_RUNTIME_CSS_VAR_ALLOWLIST) continue
      violations.push(`${rel}:${ref.line}: undefined CSS variable ${ref.name}`)
    }
  }
  for (const file of listFiles(UI_SRC_DIR, /\.(ts|tsx)$/)) {
    const rel = file.slice(UI_SRC_DIR.length + 1)
    const content = readFileSync(file, 'utf8')
    for (const ref of extractCssVarRefs(content)) {
      referenced.add(ref.name)
      if (definedTokens.has(ref.name) || ref.name in UI_RUNTIME_CSS_VAR_ALLOWLIST) continue
      violations.push(`${rel}:${ref.line}: undefined CSS variable ${ref.name}`)
    }
  }
  assert.deepEqual(violations, [], `undefined CSS vars inside @helmx/ui:\n${violations.join('\n')}`)
  for (const name of Object.keys(UI_RUNTIME_CSS_VAR_ALLOWLIST)) {
    assert.ok(referenced.has(name), `runtime CSS var allowlist entry ${name} is unused`)
  }
})

test('@helmx/ui exports have exact bi-directional parity with UI_SHARED_EXPORTS + UI_HOST_EXPORTS and zero overlap with PLUGIN_CLIENT_SHARED_EXPORTS', { timeout: 60_000 }, () => {
  const actualExports = Object.keys(HelmxUi).sort()
  const expectedExports = [...UI_SHARED_EXPORTS, ...UI_HOST_EXPORTS].sort()
  assert.deepEqual(actualExports, expectedExports)

  for (const name of UI_SHARED_EXPORTS) {
    assert.ok((HelmxUi as Record<string, unknown>)[name] !== undefined, `@helmx/ui export ${name} must not be undefined`)
  }

  const uiSet = new Set<string>(UI_SHARED_EXPORTS)
  const overlap = PLUGIN_CLIENT_SHARED_EXPORTS.filter((name) => uiSet.has(name))
  assert.deepEqual(overlap, [], 'UI_SHARED_EXPORTS and PLUGIN_CLIENT_SHARED_EXPORTS must have zero overlap')
})

test('@helmx/ui decoupling: zero imports of @helmx/plugin-client, plugin runtime contexts, or .css in packages/ui/src', { timeout: 60_000 }, () => {
  const sourceFiles = listFiles(UI_SRC_DIR, /\.(ts|tsx)$/)
  assert.ok(sourceFiles.length > 20)
  for (const file of sourceFiles) {
    const rel = file.slice(UI_SRC_DIR.length + 1)
    const content = readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.ES2022,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    for (const stmt of sourceFile.statements) {
      if (!ts.isImportDeclaration(stmt) && !ts.isExportDeclaration(stmt)) continue
      const spec = stmt.moduleSpecifier
      if (spec === undefined || !ts.isStringLiteral(spec)) continue
      assert.ok(
        !spec.text.startsWith('@helmx/plugin-client'),
        `${rel} must not depend on @helmx/plugin-client (found "${spec.text}")`,
      )
      assert.ok(
        !spec.text.endsWith('.css'),
        `${rel} must not import CSS directly ("${spec.text}") so tsx --test and SSR stay loader-free`,
      )
    }
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        assert.notEqual(node.text, 'PluginClientContext', `${rel} must not reference PluginClientContext`)
        assert.notEqual(node.text, 'PluginClientHostContext', `${rel} must not reference PluginClientHostContext`)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
})
