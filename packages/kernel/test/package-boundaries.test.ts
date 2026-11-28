import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const packagesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

interface PackageManifest {
  name: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  exports?: string | Record<string, unknown>
}

function workspacePackages() {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, 'package.json')))
    .map((entry) => {
      const root = join(packagesDir, entry.name)
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageManifest
      return { root, manifest }
    })
}

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'plugin-staging') return []
    const path = join(root, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.(ts|tsx|mts|mjs)$/.test(entry.name) ? [path] : []
  })
}

const textCache = new Map<string, string>()
const astCache = new Map<string, ts.SourceFile>()
const importsCache = new Map<string, Array<{ specifier: string; typeOnly: boolean }>>()

function readCachedText(file: string): string {
  let text = textCache.get(file)
  if (text === undefined) {
    text = readFileSync(file, 'utf8')
    textCache.set(file, text)
  }
  return text
}

function parseNoParentAst(file: string): ts.SourceFile {
  let ast = astCache.get(file)
  if (ast === undefined) {
    ast = ts.createSourceFile(file, readCachedText(file), ts.ScriptTarget.Latest, false)
    astCache.set(file, ast)
  }
  return ast
}

function lineNumberAt(text: string, pos: number): number {
  let line = 1
  let idx = -1
  while ((idx = text.indexOf('\n', idx + 1)) !== -1 && idx < pos) {
    line += 1
  }
  return line
}

function imports(file: string, needTypeOnly = false): Array<{ specifier: string; typeOnly: boolean }> {
  if (!needTypeOnly) {
    const cached = importsCache.get(file)
    if (cached !== undefined) return cached
  }
  const text = readCachedText(file)
  if (!/\b(?:import|export|require)\b/.test(text)) {
    const empty: Array<{ specifier: string; typeOnly: boolean }> = []
    importsCache.set(file, empty)
    return empty
  }
  if (!needTypeOnly && !/\bdeclare\s+module\b/.test(text)) {
    const pre = ts.preProcessFile(text, true, true)
    const result = pre.importedFiles.map((entry) => ({ specifier: entry.fileName, typeOnly: false }))
    importsCache.set(file, result)
    return result
  }
  const source = parseNoParentAst(file)
  const result: Array<{ specifier: string; typeOnly: boolean }> = []
  const add = (node: ts.Node | undefined, typeOnly = false) => {
    if (node && ts.isStringLiteralLike(node)) result.push({ specifier: node.text, typeOnly })
  }
  if (!/\b(?:import\s*\(|require\s*\()/.test(text)) {
    for (const st of source.statements) {
      if (ts.isImportDeclaration(st)) add(st.moduleSpecifier, Boolean(st.importClause?.isTypeOnly))
      else if (ts.isExportDeclaration(st)) add(st.moduleSpecifier, Boolean(st.isTypeOnly))
    }
  } else {
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, Boolean(node.importClause?.isTypeOnly))
      if (ts.isExportDeclaration(node)) add(node.moduleSpecifier, Boolean(node.isTypeOnly))
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal, true)
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) add(node.arguments[0], false)
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  if (!needTypeOnly) importsCache.set(file, result)
  return result
}

const forbidden: Record<string, readonly string[]> = {
  '@helmx/protocol': ['@helmx/kernel', '@helmx/hub', '@helmx/plugins', '@helmx/web', '@helmx/node', '@helmx/ui', '@helmx/plugin-client', '@helmx/plugin-build', '@helmx/env-io'],
  '@helmx/env-io': ['@helmx/kernel', '@helmx/hub', '@helmx/plugins', '@helmx/web', '@helmx/node', '@helmx/ui', '@helmx/plugin-client', '@helmx/plugin-build'],
  '@helmx/kernel': ['@helmx/plugins', '@helmx/hub', '@helmx/web', '@helmx/ui', '@helmx/plugin-client', '@helmx/plugin-build'],
  '@helmx/plugins': ['@helmx/kernel', '@helmx/hub', '@helmx/web'],
  '@helmx/plugin-build': ['@helmx/kernel', '@helmx/hub', '@helmx/web', '@helmx/plugins', '@helmx/ui', '@helmx/plugin-client', '@helmx/node'],
  '@helmx/ui': ['@helmx/kernel', '@helmx/hub', '@helmx/web', '@helmx/plugins', '@helmx/plugin-client', '@helmx/node', '@helmx/plugin-build', '@helmx/cli', '@helmx/env-io'],
  '@helmx/plugin-client': ['@helmx/kernel', '@helmx/hub', '@helmx/web', '@helmx/plugins', '@helmx/node', '@helmx/plugin-build'],
  '@helmx/node': ['@helmx/kernel', '@helmx/hub', '@helmx/plugins', '@helmx/web', '@helmx/ui', '@helmx/plugin-client', '@helmx/plugin-build'],
  '@helmx/web': ['@helmx/kernel', '@helmx/hub', '@helmx/plugins', '@helmx/node', '@helmx/plugin-build'],
  '@helmx/cli': ['@helmx/kernel', '@helmx/hub', '@helmx/plugins', '@helmx/web', '@helmx/node', '@helmx/ui', '@helmx/plugin-client', '@helmx/plugin-build'],
  '@helmx/test-kit': ['@helmx/kernel', '@helmx/hub', '@helmx/plugins', '@helmx/web', '@helmx/node', '@helmx/ui', '@helmx/plugin-client', '@helmx/plugin-build', '@helmx/cli', '@helmx/env-io'],
}

function packageName(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!
}

function hasPublicExport(manifest: PackageManifest, specifier: string): boolean {
  const subpath = specifier === manifest.name ? '.' : `.${specifier.slice(manifest.name.length)}`
  const exports = manifest.exports
  if (exports === undefined || typeof exports === 'string') return subpath === '.'
  const keys = Object.keys(exports)
  if (keys.length === 0) return false
  if (!keys.some((key) => key.startsWith('.'))) return subpath === '.'
  return Object.entries(exports).some(([key, value]) => {
    if (value === null) return false
    const star = key.indexOf('*')
    return star === -1 ? key === subpath : subpath.startsWith(key.slice(0, star)) && subpath.endsWith(key.slice(star + 1))
  })
}

test('production packages maintain one-way dependencies and cross boundaries only via declared public exports', { timeout: 60_000 }, () => {
  const packages = workspacePackages()
  const names = new Set(packages.map(({ manifest }) => manifest.name))
  for (const name of ['@helmx/kernel', '@helmx/plugins', '@helmx/hub', '@helmx/ui', '@helmx/plugin-client', '@helmx/plugin-build', '@helmx/env-io']) {
    assert.ok(names.has(name), `missing standalone package ${name}`)
  }
  const violations: string[] = []
  for (const { root, manifest } of packages) {
    const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies }
    if (manifest.name !== '@helmx/test-kit' && '@helmx/test-kit' in dependencies) {
      violations.push(`${manifest.name}: production dependencies must not include test-kit package @helmx/test-kit`)
    }
    if (manifest.name === '@helmx/plugins' && '@helmx/plugin-client' in dependencies) {
      violations.push('@helmx/plugins: browser SDK @helmx/plugin-client must stay in devDependencies, not production dependencies')
    }
    if (manifest.name === '@helmx/plugins' && '@helmx/ui' in dependencies) {
      violations.push('@helmx/plugins: browser UI package @helmx/ui must stay in devDependencies, not production dependencies')
    }
    for (const name of forbidden[manifest.name] ?? []) {
      if (name in dependencies) violations.push(`${manifest.name}: forbidden dependency ${name}`)
    }
    for (const file of sourceFiles(join(root, 'src'))) {
      const isPluginsBrowserClient =
        manifest.name === '@helmx/plugins' &&
        /\/src\/[^/]+\/client\//.test(file.replaceAll(sep, '/'))
      for (const { specifier, typeOnly } of imports(file, manifest.name === '@helmx/test-kit')) {
        const label = `${relative(packagesDir, file)}: ${specifier}`
        if (isAbsolute(specifier) || specifier.startsWith('file:')) {
          violations.push(`${label} absolute path bypasses package entry`)
          continue
        }
        if (specifier.startsWith('.')) {
          const target = relative(root, resolve(dirname(file), specifier))
          if (isAbsolute(target) || target === '..' || target.startsWith(`..${sep}`)) violations.push(`${label} relative path crosses package boundary`)
          continue
        }
        const target = packageName(specifier)
        if (!target.startsWith('@helmx/')) continue
        if (target === '@helmx/test-kit' && manifest.name !== '@helmx/test-kit') violations.push(`${label} production source must not import test-kit package @helmx/test-kit`)
        if ((forbidden[manifest.name] ?? []).includes(target)) violations.push(`${label} reverse dependency`)
        if (manifest.name === '@helmx/test-kit') {
          if (!typeOnly) violations.push(`${label} @helmx/test-kit only allows import type for cross-package references`)
        } else if (isPluginsBrowserClient && (target === '@helmx/plugin-client' || target === '@helmx/ui')) {
          if (!(target in (manifest.devDependencies ?? {}))) {
            violations.push(`${label} undeclared devDependency ${target}`)
          }
        } else if (target !== manifest.name && !(target in dependencies)) {
          violations.push(`${label} undeclared production dependency`)
        }
        if (target === '@helmx/kernel' && specifier === '@helmx/kernel/testing') {
          violations.push(`${label} production source must not import test-only subpath @helmx/kernel/testing`)
        }
        if (/\/src(?:\/|$)/.test(specifier)) violations.push(`${label} imports private source code`)
        const targetManifest = packages.find(({ manifest: candidate }) => candidate.name === target)?.manifest
        if (targetManifest && !hasPublicExport(targetManifest, specifier)) violations.push(`${label} not imported via public exports`)
      }
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'))
})

test('kernel contains no builtin-plugin sources and no plugin-only dependencies', { timeout: 60_000 }, () => {
  const kernel = workspacePackages().find(({ manifest }) => manifest.name === '@helmx/kernel')!
  assert.ok(!existsSync(join(kernel.root, 'src/builtin-plugins')), 'builtin plugins must belong to a separate package')
  for (const dependency of ['mermaid', 'cron-parser', 'esbuild', 'react', 'react-dom', 'lucide-react']) {
    assert.ok(!(dependency in (kernel.manifest.dependencies ?? {})), `kernel must not depend on ${dependency}`)
  }
})

test('workspace production dependency graph is acyclic', { timeout: 60_000 }, () => {
  const packages = workspacePackages()
  const graph = new Map(packages.map(({ manifest }) => [manifest.name, Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies })]))
  const visited = new Set<string>()
  const visit = (name: string, stack: string[]): void => {
    assert.ok(!stack.includes(name), `dependency cycle: ${[...stack, name].join(' -> ')}`)
    if (visited.has(name)) return
    for (const dependency of graph.get(name) ?? []) {
      if (graph.has(dependency)) visit(dependency, [...stack, name])
    }
    visited.add(name)
  }
  for (const name of graph.keys()) visit(name, [])
})

function resolveRelativeSource(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier)
  const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, '')
  const candidates = [
    base,
    `${stripped}.ts`,
    `${stripped}.tsx`,
    `${stripped}.mts`,
    `${stripped}.mjs`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

function collectTransitiveLocalSources(entryFile: string): Set<string> {
  const visited = new Set<string>()
  const queue = [resolve(entryFile)]
  while (queue.length > 0) {
    const current = queue.pop()!
    if (visited.has(current) || !existsSync(current)) continue
    visited.add(current)
    for (const { specifier } of imports(current)) {
      if (!specifier.startsWith('.')) continue
      const target = resolveRelativeSource(current, specifier)
      if (target && !visited.has(target)) queue.push(target)
    }
  }
  return visited
}

const NODE_BUILTINS = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
])

function isForbiddenBrowserRuntimeImport(specifier: string): string | undefined {
  if (specifier.startsWith('node:')) return `forbidden import of Node builtin module ${specifier}`
  const bare = specifier.split('/')[0]!
  if (NODE_BUILTINS.has(bare)) return `forbidden import of Node builtin module ${specifier}`
  if (specifier.startsWith('@earendil-works/pi-')) return `forbidden import of backend SDK module ${specifier}`
  return undefined
}

test('browser sources and @helmx/protocol/browser transitive closure never import node:* / pi-* / backend entries', { timeout: 60_000 }, () => {
  const violations: string[] = []
  const browserEntry = join(packagesDir, 'protocol/src/browser.ts')
  assert.ok(existsSync(browserEntry), 'missing @helmx/protocol/browser entry file')

  const protocolPluginFile = resolve(packagesDir, 'protocol/src/plugin.ts')
  const protocolUiSchemasFile = resolve(packagesDir, 'protocol/src/ui-schemas.ts')
  const protocolRequestSchemasFile = resolve(packagesDir, 'protocol/src/request-schemas.ts')
  const browserClosure = collectTransitiveLocalSources(browserEntry)
  if (browserClosure.has(protocolPluginFile)) {
    violations.push('protocol/src/browser.ts transitive closure must not reach protocol/src/plugin.ts')
  }
  if (browserClosure.has(protocolUiSchemasFile)) {
    violations.push('protocol/src/browser.ts transitive closure must not reach protocol/src/ui-schemas.ts')
  }
  if (browserClosure.has(protocolRequestSchemasFile)) {
    violations.push('protocol/src/browser.ts transitive closure must not reach protocol/src/request-schemas.ts')
  }
  for (const file of browserClosure) {
    for (const { specifier } of imports(file)) {
      const problem = isForbiddenBrowserRuntimeImport(specifier)
      if (problem) violations.push(`${relative(packagesDir, file)}: ${problem}`)
      if (specifier === 'typebox' || specifier === 'typebox/compile') {
        violations.push(`${relative(packagesDir, file)}: browser entry must not import server-side schema builder/compiler ${specifier}`)
      }
    }
  }

  for (const file of sourceFiles(join(packagesDir, 'ui/src'))) {
    for (const { specifier } of imports(file)) {
      const problem = isForbiddenBrowserRuntimeImport(specifier)
      if (problem) violations.push(`${relative(packagesDir, file)}: ${problem}`)
      if (specifier === '@helmx/protocol') {
        violations.push(`${relative(packagesDir, file)}: must import from @helmx/protocol/browser rather than @helmx/protocol`)
      }
      if (specifier === 'react-markdown' || specifier === 'remark-gfm') {
        violations.push(`${relative(packagesDir, file)}: standalone @helmx/ui must not depend on markdown renderer ${specifier}`)
      }
      if (specifier.endsWith('.css')) {
        violations.push(`${relative(packagesDir, file)}: @helmx/ui TS/TSX must not import CSS directly (keeps tsx --test and SSR loader-free)`)
      }
    }
  }

  for (const file of sourceFiles(join(packagesDir, 'plugin-client/src'))) {
    for (const { specifier } of imports(file)) {
      const problem = isForbiddenBrowserRuntimeImport(specifier)
      if (problem) violations.push(`${relative(packagesDir, file)}: ${problem}`)
      if (specifier === '@helmx/protocol') {
        violations.push(`${relative(packagesDir, file)}: must import from @helmx/protocol/browser rather than @helmx/protocol`)
      }
    }
  }

  const webSrcDir = join(packagesDir, 'web/src')
  for (const file of sourceFiles(webSrcDir)) {
    for (const { specifier } of imports(file)) {
      const problem = isForbiddenBrowserRuntimeImport(specifier)
      if (problem) violations.push(`${relative(packagesDir, file)}: ${problem}`)
      if (specifier === '@helmx/protocol') {
        violations.push(`${relative(packagesDir, file)}: must import from @helmx/protocol/browser rather than @helmx/protocol`)
      }
    }
  }

  assert.deepEqual(violations, [], violations.join('\n'))
})

const REGEX_PREFIX_TOKENS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.Unknown,
  ts.SyntaxKind.OpenParenToken,
  ts.SyntaxKind.OpenBracketToken,
  ts.SyntaxKind.OpenBraceToken,
  ts.SyntaxKind.CommaToken,
  ts.SyntaxKind.ColonToken,
  ts.SyntaxKind.SemicolonToken,
  ts.SyntaxKind.ExclamationToken,
  ts.SyntaxKind.TildeToken,
  ts.SyntaxKind.QuestionToken,
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.EqualsGreaterThanToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.ReturnKeyword,
  ts.SyntaxKind.ThrowKeyword,
  ts.SyntaxKind.CaseKeyword,
  ts.SyntaxKind.ElseKeyword,
  ts.SyntaxKind.DoKeyword,
  ts.SyntaxKind.YieldKeyword,
  ts.SyntaxKind.AwaitKeyword,
  ts.SyntaxKind.TypeOfKeyword,
  ts.SyntaxKind.VoidKeyword,
  ts.SyntaxKind.DeleteKeyword,
])

function scanAnyAndSuppressions(
  file: string,
  text: string,
  suppressionPattern: RegExp,
  violations: string[],
): void {
  const mayHaveSuppression = suppressionPattern.test(text)
  const mayHaveAny = /\bany\b/.test(text)
  if (!mayHaveSuppression && !mayHaveAny) return

  const variant = file.endsWith('.tsx') ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, variant, text)
  const templateBraceDepths: number[] = []
  let prevToken = ts.SyntaxKind.Unknown
  let sawCandidateAny = false

  for (;;) {
    let token = scanner.scan()
    if (token === ts.SyntaxKind.EndOfFileToken) break

    if (token === ts.SyntaxKind.TemplateHead) {
      templateBraceDepths.push(0)
    } else if (token === ts.SyntaxKind.OpenBraceToken) {
      if (templateBraceDepths.length > 0) {
        templateBraceDepths[templateBraceDepths.length - 1]! += 1
      }
    } else if (token === ts.SyntaxKind.CloseBraceToken && templateBraceDepths.length > 0) {
      if (templateBraceDepths[templateBraceDepths.length - 1] === 0) {
        token = scanner.reScanTemplateToken(false)
        if (token === ts.SyntaxKind.TemplateTail) templateBraceDepths.pop()
      } else {
        templateBraceDepths[templateBraceDepths.length - 1]! -= 1
      }
    } else if (
      (token === ts.SyntaxKind.SlashToken || token === ts.SyntaxKind.SlashEqualsToken) &&
      REGEX_PREFIX_TOKENS.has(prevToken)
    ) {
      token = scanner.reScanSlashToken()
    }

    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      if (mayHaveSuppression) {
        const start = scanner.getTokenStart()
        const snippet = text.slice(start, scanner.getTokenEnd())
        const match = suppressionPattern.exec(snippet)
        if (match) {
          violations.push(`${relative(packagesDir, file)}:${lineNumberAt(text, start)}: forbidden use of ${match[0]}`)
        }
      }
      continue
    }

    if (token === ts.SyntaxKind.WhitespaceTrivia || token === ts.SyntaxKind.NewLineTrivia) {
      continue
    }

    if (mayHaveAny && token === ts.SyntaxKind.AnyKeyword && prevToken !== ts.SyntaxKind.DotToken) {
      sawCandidateAny = true
    }

    prevToken = token
  }

  if (sawCandidateAny) {
    // Only files containing a non-property `any` token parse AST to exclude object keys / JSX text.
    const source = parseNoParentAst(file)
    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
        violations.push(`${relative(packagesDir, file)}:${line + 1}: forbidden use of explicit any type (as any / : any / <any>)`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
}

test('all workspace packages/*/src contain zero any types and zero TS suppression directives', { timeout: 60_000 }, () => {
  const violations: string[] = []
  const suppressionPattern = /@(?:ts-ignore|ts-expect-error|ts-nocheck)\b/

  for (const { root } of workspacePackages()) {
    for (const file of sourceFiles(join(root, 'src'))) {
      scanAnyAndSuppressions(file, readCachedText(file), suppressionPattern, violations)
    }
  }

  assert.deepEqual(violations, [], violations.join('\n'))
})

test('sibling package tests never import ../../kernel/src/ across package boundaries', { timeout: 60_000 }, () => {
  const violations: string[] = []
  const kernelSrcRoot = resolve(packagesDir, 'kernel/src')
  for (const pkgName of ['plugins', 'hub', 'cli', 'web', 'ui', 'plugin-client']) {
    const pkgTestDir = join(packagesDir, pkgName, 'test')
    for (const file of sourceFiles(pkgTestDir)) {
      const rawText = readCachedText(file)
      if (!rawText.includes('kernel/src') && !rawText.includes('kernel\\src')) continue
      for (const { specifier } of imports(file)) {
        if (!specifier.startsWith('.')) continue
        const targetPath = resolve(dirname(file), specifier)
        const relToKernelSrc = relative(kernelSrcRoot, targetPath)
        if (!isAbsolute(relToKernelSrc) && relToKernelSrc !== '..' && !relToKernelSrc.startsWith(`..${sep}`)) {
          violations.push(
            `${relative(packagesDir, file)}: forbidden cross-package import into kernel/src (${specifier}); use @helmx/kernel or @helmx/kernel/testing`,
          )
        }
      }
      if (/(?:\.\.[/\\])+kernel[/\\]src\b/.test(rawText)) {
        violations.push(
          `${relative(packagesDir, file)}: forbidden relative reference to kernel/src; use @helmx/kernel or @helmx/kernel/testing`,
        )
      }
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'))
})
