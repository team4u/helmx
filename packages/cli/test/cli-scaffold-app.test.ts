/**
 * Tests for `plugins init --template app` scaffolding (unit tier, no real Hub).
 *
 * Covers:
 * - template name validation: accepts `app`, rejects invalid names while listing valid templates;
 * - generated artifacts: `plugin.json` (clientRoot/app naming), backend (public doc + dual-schema actions +
 *   ctx.ui.screen + sidebar shortcut), frontend (@helmx/plugin-client host primitives), zero Emoji;
 * - end-to-end (honesty rule: real code, zero mock doctor): runs real `doctorPluginDir` 4-stage check
 *   and verifies `app` template reports `screens: ['main']` while `full` template reports `screens: []`.
 *
 * Cross-package imports: matches web tests importing kernel source (tsx source-level resolution in tests only),
 * adding no runtime dependency from `@helmx/cli` to `@helmx/kernel`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { PLUGIN_CLIENT_SHARED_EXPORTS } from '@helmx/protocol'
import { doctorPluginDir } from '../../kernel/src/plugins/plugin-doctor.js'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { SCAFFOLD_CLIENT_APP_TSX, SCAFFOLD_CLIENT_INDEX_TSX } from '../src/commands/scaffold-templates.js'
import {
  makeCliEnv,
  runCliCaptured,
  useTempDir,
} from './helpers/cli-harness.js'

function collectPluginClientImports(sourceText: string): { rootValues: string[]; disallowedSubpaths: string[] } {
  const sf = ts.createSourceFile('client.tsx', sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const rootValues: string[] = []
  const disallowedSubpaths: string[] = []
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const spec = stmt.moduleSpecifier.text
    if (spec.startsWith('@helmx/plugin-client/')) {
      disallowedSubpaths.push(spec)
      continue
    }
    if (spec !== '@helmx/plugin-client' || stmt.importClause?.isTypeOnly) continue
    const bindings = stmt.importClause?.namedBindings
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if (!el.isTypeOnly) rootValues.push((el.propertyName ?? el.name).text)
      }
    }
  }
  return { rootValues, disallowedSubpaths }
}

/** Emoji pattern (common emoticon and symbol ranges; generated text must contain zero Emoji). */
const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u

/** Relative paths of all generated text files for Emoji scanning. */
async function scaffoldFiles(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(path.join(dir, 'client'))
  return ['plugin.json', 'index.ts', 'README.md', ...entries.map((e) => `client/${e}`)]
}

test('plugins init --template app: template validation and output file list', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-app-')
  const env = makeCliEnv('http://127.0.0.1:1', dataDir)
  const r = await runCliCaptured(['plugins', 'init', 'desk-app', '--template', 'app', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const body = JSON.parse(r.out) as { pluginId: string; dir: string; template: string; files: string[]; nextSteps: string[] }
  assert.equal(body.pluginId, 'desk-app')
  assert.equal(body.template, 'app')
  for (const f of ['plugin.json', 'index.ts', 'tsconfig.json', 'client/index.tsx', 'README.md']) {
    assert.ok(body.files.includes(f), `output should include ${f}: ${JSON.stringify(body.files)}`)
  }
  assert.ok(!body.files.includes('client/styles.css'), 'app template must not ship a private stylesheet by default')
  // app template next steps point directly to standard plugin doctor + install workflow
  assert.ok(body.nextSteps.some((s) => s.startsWith('helmx plugins doctor ')), JSON.stringify(body.nextSteps))
  assert.ok(body.nextSteps.some((s) => s.startsWith('helmx plugins install ') && s.includes('--enable')), JSON.stringify(body.nextSteps))

  // Invalid template rejected while listing all valid templates
  const bad = await runCliCaptured(['plugins', 'init', 'bad-tpl-app', '--template', 'webapp', '--json'], env)
  assert.notEqual(bad.code, 0)
  assert.ok(bad.err.includes('minimal') && bad.err.includes('full') && bad.err.includes('app'))
})

test('plugins init --template app: backend and frontend content contracts', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-app-')
  const r = await runCliCaptured(['plugins', 'init', 'desk-app', '--template', 'app', '--json'], makeCliEnv('http://127.0.0.1:1', dataDir))
  assert.equal(r.code, 0, r.err)
  const { dir } = JSON.parse(r.out) as { dir: string }

  const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'plugin.json'), 'utf8')) as {
    id: string
    name: string
    main: string
    clientRoot: string
  }
  assert.equal(manifest.id, 'desk-app')
  assert.equal(manifest.name, 'desk-app App')
  assert.equal(manifest.main, 'index.ts')
  assert.equal(manifest.clientRoot, './client')

  const index = await fsp.readFile(path.join(dir, 'index.ts'), 'utf8')
  // ctx.doc public persistent document (for frontend subscription) + flush after write
  assert.ok(index.includes('ctx.doc<'), 'should declare typed public doc')
  assert.ok(index.includes('{ public: true }'), 'doc should be public')
  assert.ok(index.includes('.flush()'), 'write handlers should flush')
  // Dual-schema actions (omitting input/output fails at doctor register)
  assert.ok(index.includes("id: 'add_item'") && index.includes("id: 'set_done'"))
  assert.ok(index.includes('inputSchema') && index.includes('outputSchema'))
  assert.ok(index.includes('exposeAsTool: true'))
  // Full-stack app requirement: main screen + sidebar shortcut
  assert.ok(index.includes('ctx.ui.screen('))
  assert.ok(index.includes("client: { module: 'index.tsx', export: 'MainScreen' }"))
  assert.ok(index.includes('ctx.ui.sidebarItem('))
  assert.ok(index.includes("target: 'screen:desk-app/main'"), 'sidebar entry should target this plugin screen')

  const client = await fsp.readFile(path.join(dir, 'client', 'index.tsx'), 'utf8')
  for (const primitive of ['Screen', 'ScreenSection', 'DataTable', 'KvGrid', 'Checkbox', 'Button', 'Field', 'Input', 'usePluginDoc', 'usePluginContext']) {
    assert.ok(client.includes(primitive), `frontend should use host primitive/hook ${primitive}`)
  }
  assert.ok(client.includes('export function MainScreen'), 'frontend should export MainScreen matching screen declaration')
  assert.ok(!/\b(font-medium|text-subtle|text-xs)\b/.test(client), 'must not contain pseudo-Tailwind class names')
  assert.ok(client.includes("'items'"), 'frontend subscribes to matching public doc')

  // Zero private CSS by default: no stylesheet artifact, host SDK primitives only
  await assert.rejects(fsp.access(path.join(dir, 'client', 'styles.css')), 'app template must not generate client/styles.css')
  assert.ok(!client.includes("import './styles.css'"), 'frontend must not import a private stylesheet')
  assert.ok(!/\bapp-(form|input|done|col-check)\b/.test(client), 'frontend must not use private app-* layout classes')

  // Every runtime symbol imported from @helmx/plugin-client in scaffold templates must stay in PLUGIN_CLIENT_SHARED_EXPORTS
  const allowedExports = new Set<string>(PLUGIN_CLIENT_SHARED_EXPORTS)
  for (const [label, src] of [
    ['SCAFFOLD_CLIENT_INDEX_TSX', SCAFFOLD_CLIENT_INDEX_TSX],
    ['SCAFFOLD_CLIENT_APP_TSX', SCAFFOLD_CLIENT_APP_TSX],
  ] as const) {
    const { rootValues, disallowedSubpaths } = collectPluginClientImports(src)
    assert.deepEqual(disallowedSubpaths, [], `${label} must not import internal @helmx/plugin-client/* subpaths`)
    assert.ok(rootValues.length > 0, `${label} should import shared primitives from @helmx/plugin-client`)
    for (const sym of rootValues) {
      assert.ok(allowedExports.has(sym), `${label} imports ${sym} which is missing from PLUGIN_CLIENT_SHARED_EXPORTS`)
    }
  }

  // Zero-Emoji invariant across all generated files
  for (const f of await scaffoldFiles(dir)) {
    const text = await fsp.readFile(path.join(dir, f), 'utf8')
    assert.ok(!EMOJI_PATTERN.test(text), `generated file ${f} must not contain Emoji`)
  }
})

test('plugins init --template app end-to-end: real 4-stage doctor passes with main screen', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-app-')
  const r = await runCliCaptured(['plugins', 'init', 'eval-app', '--template', 'app', '--json'], makeCliEnv('http://127.0.0.1:1', dataDir))
  assert.equal(r.code, 0, r.err)
  const { dir } = JSON.parse(r.out) as { dir: string }

  // Real doctor: manifest/backend/register/client 4 stages + screen capture
  const report = await doctorPluginDir(dir, { buildProvider: createPluginBuildProvider() })
  assert.ok(report.ok, `doctor should pass: ${JSON.stringify(report.checks)}`)
  assert.deepEqual(
    report.checks.map((c) => c.id),
    ['manifest', 'backend', 'register', 'client'],
  )
  assert.deepEqual(report.screens, ['main'])
})

test('comparison: full template passes doctor with empty screens list', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-app-')
  const r = await runCliCaptured(['plugins', 'init', 'panel-only', '--template', 'full', '--json'], makeCliEnv('http://127.0.0.1:1', dataDir))
  assert.equal(r.code, 0, r.err)
  const { dir } = JSON.parse(r.out) as { dir: string }

  const report = await doctorPluginDir(dir, { buildProvider: createPluginBuildProvider() })
  assert.ok(report.ok)
  assert.deepEqual(report.screens, [], 'full template registers workbenchPanel only and declares no screen')
})
