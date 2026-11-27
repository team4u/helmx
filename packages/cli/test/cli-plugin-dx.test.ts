/**
 * External plugin DX loop CLI tests: `plugins doctor/reload/rescan` (HTTP endpoints)
 * and `plugins init` (local scaffold without contacting Hub).
 * Uses real `runCli` + mock Hub HTTP contract (real fetch boundary);
 * `init` verifies generated files, invalid name rejection, non-empty dir guard, and `--json` output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, realpathSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  makeCliEnv,
  makePluginSummary,
  parseCliError,
  runCliCaptured,
  startMockHub,
  useTempDir,
} from './helpers/cli-harness.js'
import { writeSdkTypesToDir } from '../src/commands/plugins-types.js'

const DOCTOR_REPORT = {
  dir: '/abs/plugin',
  pluginId: 'p1',
  ok: true,
  checks: [{ id: 'manifest', label: 'x' }],
}

test('plugins doctor: POST /api/plugins/doctor accepts --path/positional/id', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const hub = await startMockHub(
    {
      'POST /api/plugins/doctor': (body) => {
        if ((body as { id?: string }).id !== undefined) {
          assert.deepEqual(body, { id: 'my-pl' })
          return { body: { ...DOCTOR_REPORT, requestedId: 'my-pl' } }
        }
        assert.deepEqual(body, { path: '/abs/plugin' })
        return { body: DOCTOR_REPORT }
      },
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dataDir)

  // --path (canonical option name)
  const r2 = await runCliCaptured(['plugins', 'doctor', '--path', '/abs/plugin', '--json'], env)
  assert.equal(r2.code, 0, r2.err)
  assert.deepEqual(JSON.parse(r2.out), DOCTOR_REPORT)

  // Positional absolute path -> path target
  const r3 = await runCliCaptured(['plugins', 'doctor', '/abs/plugin', '--json'], env)
  assert.equal(r3.code, 0, r3.err)
  assert.deepEqual(JSON.parse(r3.out), DOCTOR_REPORT)

  // Positional plugin ID -> id target (doctor [<id>])
  const r4 = await runCliCaptured(['plugins', 'doctor', 'my-pl', '--json'], env)
  assert.equal(r4.code, 0, r4.err)
  assert.deepEqual(JSON.parse(r4.out), { ...DOCTOR_REPORT, requestedId: 'my-pl' })

  // --id explicit flag
  const r5 = await runCliCaptured(['plugins', 'doctor', '--id', 'my-pl', '--json'], env)
  assert.equal(r5.code, 0, r5.err)
  assert.deepEqual(JSON.parse(r5.out), { ...DOCTOR_REPORT, requestedId: 'my-pl' })

  assert.equal(hub.hits.length, 4)
  assert.deepEqual(hub.hits[0]!.body, { path: '/abs/plugin' })
  assert.deepEqual(hub.hits[3]!.body, { id: 'my-pl' })

  // Missing target errors explicitly without contacting Hub
  const r6 = await runCliCaptured(['plugins', 'doctor', '--json'], env)
  assert.notEqual(r6.code, 0)
  assert.equal(hub.hits.length, 4, 'missing argument must not send request')

  // id and path are mutually exclusive
  const r7 = await runCliCaptured(['plugins', 'doctor', 'my-pl', '--path', '/abs/plugin'], env)
  assert.notEqual(r7.code, 0)
  assert.equal(hub.hits.length, 4)
})

test('plugins doctor: human mode prints check results and exits non-zero on failure', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const failing = {
    dir: '/abs/bad',
    pluginId: 'bad',
    ok: false,
    checks: [
      { id: 'manifest', label: 'Manifest and entrypoint resolution' },
      {
        id: 'backend',
        label: 'Backend module generation import',
        error: { code: 'plugin_load_failed', message: 'syntax error' },
      },
    ],
  }
  const hub = await startMockHub({ 'POST /api/plugins/doctor': () => ({ body: failing }) }, { autoRegisterCleanup: t })
  const r = await runCliCaptured(['plugins', 'doctor', '--path', '/abs/bad'], makeCliEnv(hub.url, dataDir))
  assert.notEqual(r.code, 0, 'ok=false should exit non-zero')
  assert.ok(r.out.includes('[ok] manifest'))
  assert.ok(r.out.includes('[!!] backend'))
  assert.ok(r.out.includes('plugin_load_failed'))
  assert.ok(r.out.includes('Result: failed checks found'))
})

test('plugins reload: POST /api/plugins/:id/reload (with URI encoding)', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const hub = await startMockHub(
    {
      'POST /api/plugins/my%3Apl/reload': () => ({
        body: {
          pluginId: 'my:pl',
          wasEnabled: true,
          generation: 2,
          summary: makePluginSummary({ id: 'my:pl', actions: ['a'] }),
        },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['plugins', 'reload', 'my:pl', '--json'], makeCliEnv(hub.url, dataDir))
  assert.equal(r.code, 0, r.err)
  const body = JSON.parse(r.out) as { pluginId: string; generation: number }
  assert.equal(body.pluginId, 'my:pl')
  assert.equal(body.generation, 2)
  assert.equal(hub.hits[0]!.path, '/api/plugins/my%3Apl/reload')
  assert.equal(hub.hits[0]!.method, 'POST')
})

test('plugins rescan:POST /api/plugins/rescan', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const hub = await startMockHub(
    {
      'POST /api/plugins/rescan': () => ({
        body: {
          registered: ['new-one'],
          skipped: 1,
          plugins: [makePluginSummary({ id: 'new-one', name: 'x', enabled: false })],
        },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['plugins', 'rescan', '--json'], makeCliEnv(hub.url, dataDir))
  assert.equal(r.code, 0, r.err)
  const body = JSON.parse(r.out) as { registered: string[]; skipped: number }
  assert.deepEqual(body.registered, ['new-one'])
  assert.equal(hub.hits[0]!.path, '/api/plugins/rescan')
})

test('plugins install: passes source, sets enable in --enable body, checks human output, rejects empty source', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const npmSource = 'npm:helmx-plugin-foo@^1.2.0'
  const installBody = {
    record: {
      id: 'inst-1',
      pluginId: 'helmx-plugin-foo',
      source: { kind: 'npm', raw: npmSource, spec: 'helmx-plugin-foo@^1.2.0' },
      installPath: '/data/plugins/helmx-plugin-foo',
      version: '1.2.0',
      installedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
    summary: makePluginSummary({
      id: 'helmx-plugin-foo',
      enabled: false,
      managed: { installId: 'inst-1', installedVersion: '1.2.0', installedAt: 1_700_000_000_000, source: { kind: 'npm', raw: npmSource, spec: 'helmx-plugin-foo@^1.2.0' } },
    }),
  }
  const hub = await startMockHub(
    {
      'POST /api/plugins/install': (body) => {
        const enable = (body as { enable?: boolean }).enable === true
        return { body: { ...installBody, summary: { ...installBody.summary, enabled: enable } } }
      },
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dataDir)

  // --enable: request body passes enable:true, human output shows enabled
  const r1 = await runCliCaptured(['plugins', 'install', npmSource, '--enable'], env)
  assert.equal(r1.code, 0, r1.err)
  assert.deepEqual(hub.hits[0]!.body, { source: npmSource, enable: true })
  assert.ok(r1.out.includes('helmx-plugin-foo 1.2.0'))
  assert.ok(r1.out.includes('enabled'))

  // Default: request body contains only source, prints disabled status and enable hint
  const r2 = await runCliCaptured(['plugins', 'install', npmSource, '--json'], env)
  assert.equal(r2.code, 0, r2.err)
  assert.deepEqual(hub.hits[1]!.body, { source: npmSource })
  const install = JSON.parse(r2.out) as { record: { id: string }; summary: { managed?: { installId: string } } }
  assert.equal(install.record.id, 'inst-1')
  assert.equal(install.summary.managed?.installId, 'inst-1')

  // Empty source rejected explicitly without contacting Hub
  const empty = await runCliCaptured(['plugins', 'install', '   '], env)
  assert.notEqual(empty.code, 0)
  assert.ok(empty.err.includes('source'))
  assert.equal(hub.hits.length, 2)
})

test('plugins update: POST /api/plugins/:id/update (with URI encoding), --source, and human output', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const hub = await startMockHub(
    {
      'POST /api/plugins/my%3Apl/update': (body) => {
        const src = (body as { source?: string }).source
        return {
          body: {
            record: {
              id: 'inst-1',
              pluginId: 'my:pl',
              source: { kind: 'npm', raw: src ?? 'npm:my-pl@^1.2.0', spec: (src ?? 'npm:my-pl@^1.2.0').slice(4) },
              installPath: '/data/plugins/my:pl',
              version: src ? '2.0.0' : '1.3.0',
              installedAt: 1_700_000_000_000,
              updatedAt: 1_700_000_100_000,
            },
            summary: makePluginSummary({ id: 'my:pl' }),
            changed: true,
            previousVersion: '1.2.0',
          },
        }
      },
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dataDir)
  const r = await runCliCaptured(['plugins', 'update', 'my:pl'], env)
  assert.equal(r.code, 0, r.err)
  assert.equal(hub.hits[0]!.path, '/api/plugins/my%3Apl/update')
  assert.equal(hub.hits[0]!.method, 'POST')
  assert.deepEqual(hub.hits[0]!.body, {})
  assert.ok(r.out.includes('my:pl'))
  assert.ok(r.out.includes('1.2.0 -> 1.3.0'))

  const rSrc = await runCliCaptured(['plugins', 'update', 'my:pl', '--source', 'npm:my-pl@2.0.0', '--json'], env)
  assert.equal(rSrc.code, 0, rSrc.err)
  assert.deepEqual(hub.hits[1]!.body, { source: 'npm:my-pl@2.0.0' })
  assert.equal((JSON.parse(rSrc.out) as { record: { version: string } }).record.version, '2.0.0')

  // Validation guards without contacting Hub
  const missing = await runCliCaptured(['plugins', 'update', '--json'], env)
  assert.notEqual(missing.code, 0)
  assert.equal(parseCliError(missing).code, 'missing_id')
  const conflictId = await runCliCaptured(['plugins', 'update', 'my:pl', '--all', '--json'], env)
  assert.notEqual(conflictId.code, 0)
  assert.equal(parseCliError(conflictId).code, 'conflicting_flags')
  const conflictSrc = await runCliCaptured(['plugins', 'update', '--all', '--source', 'npm:x', '--json'], env)
  assert.notEqual(conflictSrc.code, 0)
  assert.equal(parseCliError(conflictSrc).code, 'conflicting_flags')
  const emptySrc = await runCliCaptured(['plugins', 'update', 'my:pl', '--source', '   ', '--json'], env)
  assert.notEqual(emptySrc.code, 0)
  assert.equal(parseCliError(emptySrc).code, 'invalid_flag_value')
  assert.equal(hub.hits.length, 2, 'validation failures must not hit Hub')
})

test('plugins update --all: updates only managed plugins sequentially, handles mixed results and empty managed list', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const managedMeta = (id: string, version: string) => ({
    installId: `inst-${id}`,
    installedVersion: version,
    installedAt: 1_700_000_000_000,
    source: { kind: 'local' as const, raw: `/src/${id}`, path: `/src/${id}` },
  })
  let pluginsList = [
    makePluginSummary({ id: 'builtin:profile', locked: true }),
    makePluginSummary({ id: 'manual-pl' }),
    makePluginSummary({ id: 'pl-up', version: '1.0.0', managed: managedMeta('pl-up', '1.0.0') }),
    makePluginSummary({ id: 'pl-same', version: '1.0.0', managed: managedMeta('pl-same', '1.0.0') }),
    makePluginSummary({ id: 'pl-fail', version: '1.0.0', managed: managedMeta('pl-fail', '1.0.0') }),
  ]
  const hub = await startMockHub(
    {
      'GET /api/plugins': () => ({ body: pluginsList }),
      'POST /api/plugins/pl-up/update': () => ({
        body: {
          record: { id: 'inst-pl-up', pluginId: 'pl-up', source: managedMeta('pl-up', '1.0.0').source, installPath: '/d/pl-up', version: '2.0.0', installedAt: 1, updatedAt: 2 },
          summary: makePluginSummary({ id: 'pl-up', version: '2.0.0', managed: managedMeta('pl-up', '2.0.0') }),
          changed: true,
          previousVersion: '1.0.0',
        },
      }),
      'POST /api/plugins/pl-same/update': () => ({
        body: {
          record: { id: 'inst-pl-same', pluginId: 'pl-same', source: managedMeta('pl-same', '1.0.0').source, installPath: '/d/pl-same', version: '1.0.0', installedAt: 1, updatedAt: 1 },
          summary: makePluginSummary({ id: 'pl-same', version: '1.0.0', managed: managedMeta('pl-same', '1.0.0') }),
          changed: false,
          previousVersion: '1.0.0',
        },
      }),
      'POST /api/plugins/pl-fail/update': () => ({
        status: 409,
        body: { error: { code: 'plugin_has_live_tasks', message: 'plugin pl-fail has active tasks' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dataDir)

  // Mixed outcome: human mode prints per-plugin progress and exits non-zero
  const mixedHuman = await runCliCaptured(['plugins', 'update', '--all'], env)
  assert.notEqual(mixedHuman.code, 0)
  assert.match(mixedHuman.out, /\[1\/3\] Updated pl-up: 1\.0\.0 -> 2\.0\.0/)
  assert.match(mixedHuman.out, /\[2\/3\] Unchanged pl-same \(1\.0\.0\)/)
  assert.match(mixedHuman.out, /\[3\/3\] Failed pl-fail \(plugin_has_live_tasks\)/)
  assert.match(mixedHuman.out, /Summary: 1 updated, 1 unchanged, 1 failed \(3 total\)/)

  // Mixed outcome: --json prints full structured summary and exits non-zero
  const mixedJson = await runCliCaptured(['plugins', 'update', '--all', '--json'], env)
  assert.notEqual(mixedJson.code, 0)
  const parsed = JSON.parse(mixedJson.out) as { total: number; updated: number; unchanged: number; failed: number; results: Array<{ pluginId: string; status: string }> }
  assert.equal(parsed.total, 3)
  assert.equal(parsed.updated, 1)
  assert.equal(parsed.unchanged, 1)
  assert.equal(parsed.failed, 1)
  assert.deepEqual(parsed.results.map((x) => [x.pluginId, x.status]), [
    ['pl-up', 'updated'],
    ['pl-same', 'unchanged'],
    ['pl-fail', 'failed'],
  ])

  // Success when all managed plugins succeed
  pluginsList = [
    makePluginSummary({ id: 'pl-up', version: '1.0.0', managed: managedMeta('pl-up', '1.0.0') }),
    makePluginSummary({ id: 'pl-same', version: '1.0.0', managed: managedMeta('pl-same', '1.0.0') }),
  ]
  const okAll = await runCliCaptured(['plugins', 'update', '--all', '--json'], env)
  assert.equal(okAll.code, 0, okAll.err)
  assert.equal((JSON.parse(okAll.out) as { failed: number }).failed, 0)

  // Empty managed plugins -> exits 0 cleanly
  pluginsList = [makePluginSummary({ id: 'builtin:profile', locked: true })]
  const emptyHuman = await runCliCaptured(['plugins', 'update', '--all'], env)
  assert.equal(emptyHuman.code, 0, emptyHuman.err)
  assert.match(emptyHuman.out, /No managed external plugins installed/)
  const emptyJson = await runCliCaptured(['plugins', 'update', '--all', '--json'], env)
  assert.equal(emptyJson.code, 0, emptyJson.err)
  assert.deepEqual(JSON.parse(emptyJson.out), { total: 0, updated: 0, unchanged: 0, failed: 0, results: [] })
})

test('plugins remove: --json non-interactive, --yes bypass, and non-interactive without --yes confirmation check', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const hub = await startMockHub(
    {
      'POST /api/plugins/my%3Apl/remove': () => ({
        body: { pluginId: 'my:pl', installPath: '/data/plugins/my:pl', wasEnabled: true, installId: 'inst-2' },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dataDir)

  // --json: machine mode is non-interactive (CLI skips prompt) and sends request directly
  const r1 = await runCliCaptured(['plugins', 'remove', 'my:pl', '--json'], env)
  assert.equal(r1.code, 0, r1.err)
  assert.equal(hub.hits[0]!.path, '/api/plugins/my%3Apl/remove')
  const remove = JSON.parse(r1.out) as { pluginId: string; wasEnabled: boolean }
  assert.equal(remove.pluginId, 'my:pl')
  assert.equal(remove.wasEnabled, true)

  // Human mode with --yes: skips prompt, prints removed message and install directory
  const r2 = await runCliCaptured(['plugins', 'remove', 'my:pl', '--yes'], env)
  assert.equal(r2.code, 0, r2.err)
  assert.equal(hub.hits[1]!.path, '/api/plugins/my%3Apl/remove')
  assert.ok(r2.out.includes('Removed my:pl'))
  assert.ok(r2.out.includes('/data/plugins/my:pl'))

  // Human mode without --yes: ensure non-TTY rejection via injected stdin (avoids global process.stdin mutation)
  const r3 = await runCliCaptured(['plugins', 'remove', 'my:pl'], env, {
    stdin: { isTTY: false, readAll: async () => '', readLine: async () => '' },
  })
  assert.notEqual(r3.code, 0)
  assert.ok(r3.err.includes('--yes'))
  assert.ok(r3.err.includes('confirmation_required') || r3.err.includes('removing'))
  assert.equal(hub.hits.length, 2, 'must not call Hub without confirmation')

  // Missing and extra positional arguments rejected without contacting Hub
  const miss = await runCliCaptured(['plugins', 'remove'], env)
  assert.notEqual(miss.code, 0)
  const extra = await runCliCaptured(['plugins', 'update', 'a', 'b'], env)
  assert.notEqual(extra.code, 0)
  assert.equal(hub.hits.length, 2)
})

test('plugins install/update/remove: forwards all 4 source kinds and Hub error envelopes', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const sources = [
    'npm:helmx-plugin-foo@^1.2.0',
    'git:https://github.com/user/helmx-plugin-foo.git@v1.2.0',
    'https://github.com/user/helmx-plugin-foo.git#v1.2.0',
    '/srv/helmx-plugins/foo',
    './relative-plugin',
  ]
  const seen: string[] = []
  const hub = await startMockHub(
    {
      'POST /api/plugins/install': (body) => {
        seen.push((body as { source: string }).source)
        return { status: 201, body: { ok: true } }
      },
      'POST /api/plugins/bad%3Apl/remove': () => ({
        status: 404,
        body: { error: { code: 'plugin_not_managed', message: 'plugin is not a managed installation' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dataDir)
  for (const source of sources) {
    const r = await runCliCaptured(['plugins', 'install', source, '--json'], env)
    assert.equal(r.code, 0, `source=${source}: ${r.err}`)
  }
  assert.deepEqual(seen, sources)

  // Hub structured error propagated verbatim (preserving code/message)
  const err = await runCliCaptured(['plugins', 'remove', 'bad:pl', '--yes', '--json'], env)
  assert.notEqual(err.code, 0)
  assert.equal(parseCliError(err).code, 'plugin_not_managed')
})

test('plugins init: generates local skeleton (default full template: plugin.json + index.ts + tsconfig.json + client/index.tsx)', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const env = makeCliEnv('http://127.0.0.1:1', dataDir)
  // Runs without Hub (local command): unreachable Hub URL proves no network calls are made
  const r = await runCliCaptured(['plugins', 'init', 'my-plugin', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const body = JSON.parse(r.out) as { pluginId: string; dir: string; files: string[]; template: string }
  assert.equal(body.pluginId, 'my-plugin')
  assert.equal(body.template, 'full', 'default template is full')
  assert.equal(body.dir, path.join(dataDir, 'installed-plugins', 'my-plugin'))
  for (const f of ['plugin.json', 'index.ts', 'tsconfig.json', 'client/index.tsx', 'README.md']) {
    assert.ok(body.files.includes(f), `output should contain ${f}: ${JSON.stringify(body.files)}`)
  }

  const manifest = JSON.parse(await fsp.readFile(path.join(body.dir, 'plugin.json'), 'utf8')) as {
    id: string
    main: string
    clientRoot: string
  }
  assert.equal(manifest.id, 'my-plugin')
  assert.equal(manifest.main, 'index.ts')
  assert.equal(manifest.clientRoot, './client')
  const index = await fsp.readFile(path.join(body.dir, 'index.ts'), 'utf8')
  assert.ok(index.includes(`id: 'my-plugin'`), 'entrypoint id matches directory name')
  assert.ok(index.includes('definePlugin'))
  assert.ok(index.includes("module: 'index.tsx'"), 'UI references client/index.tsx')
  const tsconfig = JSON.parse(await fsp.readFile(path.join(body.dir, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: Record<string, unknown>
  }
  assert.ok(tsconfig.compilerOptions)
  const client = await fsp.readFile(path.join(body.dir, 'client', 'index.tsx'), 'utf8')
  assert.ok(client.includes('export function SamplePanel'))
  assert.ok(client.includes('@helmx/plugin-client'), 'standard template imports host shared frontend package')
  assert.ok(client.includes('usePluginDoc'), 'standard template uses shared hook')
  assert.ok(client.includes('usePluginAction'), 'standard template uses shared action hook')
  // Standard template uses narrow-panel HIG primitives without raw loading-state div, 1-col DataTable, or pseudo-Tailwind classes
  for (const primitive of ['LoadingState', 'Card', 'KvGrid', 'List', 'ListRow', 'Button']) {
    assert.ok(client.includes(primitive), `standard template should use shared layout primitive ${primitive}`)
  }
  assert.ok(client.includes('density="compact"'), 'standard template narrow panel should use compact List')
  assert.ok(!client.includes('className="loading-state"'), 'standard template must not render raw loading-state div')
  assert.ok(!client.includes('DataTable'), 'standard template must not use 1-col DataTable in narrow panel')
  assert.ok(!/\b(font-medium|text-subtle|text-xs)\b/.test(client), 'standard template must not retain pseudo-Tailwind class names')
  assert.ok(await fsp.stat(path.join(body.dir, 'README.md')))

  // Human mode prints next steps
  const r2 = await runCliCaptured(['plugins', 'init', 'another-one'], env)
  assert.equal(r2.code, 0, r2.err)
  assert.ok(r2.out.includes('Next steps'))
  assert.ok(r2.out.includes('helmx plugins enable another-one'))
})

test('plugins init --template minimal: backend ping action only, no client directory', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const env = makeCliEnv('http://127.0.0.1:1', dataDir)
  const r = await runCliCaptured(['plugins', 'init', 'mini-pl', '--template', 'minimal', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const body = JSON.parse(r.out) as { dir: string; files: string[]; template: string }
  assert.equal(body.template, 'minimal')
  for (const f of ['plugin.json', 'index.ts', 'tsconfig.json', 'README.md']) {
    assert.ok(body.files.includes(f))
  }
  assert.ok(!body.files.some((f) => f.startsWith('client/')), 'minimal does not generate frontend files')
  await assert.rejects(fsp.stat(path.join(body.dir, 'client')), { code: 'ENOENT' })
  const manifest = JSON.parse(await fsp.readFile(path.join(body.dir, 'plugin.json'), 'utf8')) as {
    clientRoot?: string
  }
  assert.equal(manifest.clientRoot, undefined, 'minimal does not declare clientRoot')
  const index = await fsp.readFile(path.join(body.dir, 'index.ts'), 'utf8')
  assert.ok(index.includes("id: 'ping'"), 'minimal includes ping action')

  // Rejects invalid template name
  const bad = await runCliCaptured(['plugins', 'init', 'bad-tpl', '--template', 'huge'], env)
  assert.notEqual(bad.code, 0)
})

test('plugins init: rejects invalid names and non-empty directory unless --force is passed', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const env = makeCliEnv('http://127.0.0.1:1', dataDir)
  const bad = await runCliCaptured(['plugins', 'init', 'builtin:x'], env)
  assert.notEqual(bad.code, 0)
  const badCore = await runCliCaptured(['plugins', 'init', 'core:x'], env)
  assert.notEqual(badCore.code, 0)
  const bad2 = await runCliCaptured(['plugins', 'init', 'bad name'], env)
  assert.notEqual(bad2.code, 0)

  // First init succeeds; second init into the same non-empty directory rejects
  await runCliCaptured(['plugins', 'init', 'dup-pl'], env)
  const dup = await runCliCaptured(['plugins', 'init', 'dup-pl'], env)
  assert.notEqual(dup.code, 0)
  assert.ok(dup.err.includes('non-empty') || dup.err.includes('conflict'))
  // --force proceeds by overwriting files
  const forced = await runCliCaptured(['plugins', 'init', 'dup-pl', '--force'], env)
  assert.equal(forced.code, 0, forced.err)

  // --dir custom parent directory
  const parent = path.join(dataDir, 'custom-parent')
  const r3 = await runCliCaptured(['plugins', 'init', 'x-pl', '--dir', parent, '--json'], env)
  assert.equal(r3.code, 0, r3.err)
  const body3 = JSON.parse(r3.out) as { dir: string }
  assert.ok(body3.dir.startsWith(parent))
})

test('plugins build: local prebuilt bundle compilation (--json, --out, --module, clientDependencies, and error guards)', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-build-')
  const env = makeCliEnv('http://127.0.0.1:1', dataDir)

  // 1. Scaffold via `plugins init`, then prebuild locally with `plugins build` (no Hub calls).
  const initRes = await runCliCaptured(['plugins', 'init', 'built-pl', '--json'], env)
  assert.equal(initRes.code, 0, initRes.err)
  const { dir: pluginDir } = JSON.parse(initRes.out) as { dir: string }

  const buildRes = await runCliCaptured(['plugins', 'build', pluginDir, '--json'], env)
  assert.equal(buildRes.code, 0, buildRes.err)
  const buildBody = JSON.parse(buildRes.out) as {
    pluginId: string
    outDir: string
    manifestPath: string
    manifest: { version: number; modules: Record<string, { entryFile: string; contentHash: string; exports: string[] }> }
    totalBytes: number
  }
  assert.equal(buildBody.pluginId, 'built-pl')
  assert.equal(buildBody.outDir, path.join(pluginDir, 'dist-client'))
  assert.equal(buildBody.manifest.version, 1)
  const entry = buildBody.manifest.modules['index.tsx']
  assert.ok(entry && entry.exports.includes('SamplePanel'))
  assert.ok(await fsp.stat(path.join(buildBody.outDir, entry.entryFile)))
  assert.ok(await fsp.stat(path.join(buildBody.outDir, `${entry.entryFile}.gz`)))

  // 2. --out override + --module + clientDependencies + human output
  const depDir = path.join(pluginDir, 'node_modules', 'tiny-cli-dep')
  await fsp.mkdir(depDir, { recursive: true })
  await fsp.writeFile(path.join(depDir, 'package.json'), JSON.stringify({ name: 'tiny-cli-dep', main: 'index.js' }))
  await fsp.writeFile(path.join(depDir, 'index.js'), 'export const tag = "bundled-dep-tag"\n')
  await fsp.writeFile(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify({ id: 'built-pl', main: 'index.ts', clientRoot: './client', clientDependencies: ['tiny-cli-dep'] }),
  )
  await fsp.writeFile(
    path.join(pluginDir, 'client', 'index.tsx'),
    "import { tag } from 'tiny-cli-dep'\nexport function SamplePanel() { return tag }\n",
  )
  const customOut = path.join(dataDir, 'custom-out')
  const build2 = await runCliCaptured(['plugins', 'build', '--dir', pluginDir, '--out', customOut, '--module', 'index.tsx'], env)
  assert.equal(build2.code, 0, build2.err)
  assert.ok(build2.out.includes('Built 1 client module(s) for built-pl'))
  const manifest2 = JSON.parse(await fsp.readFile(path.join(customOut, 'manifest.json'), 'utf8')) as {
    modules: Record<string, { entryFile: string }>
  }
  const compiledCode = await fsp.readFile(path.join(customOut, manifest2.modules['index.tsx']!.entryFile), 'utf8')
  assert.match(compiledCode, /bundled-dep-tag/)

  // 3. Reject missing target directory and escaping clientRoot explicitly
  const missing = await runCliCaptured(['plugins', 'build', path.join(dataDir, 'does-not-exist'), '--json'], env)
  assert.notEqual(missing.code, 0)
  assert.equal(parseCliError(missing).code, 'client_root_invalid')

  const badPlugin = path.join(dataDir, 'escape-pl')
  await fsp.mkdir(badPlugin, { recursive: true })
  await fsp.writeFile(path.join(badPlugin, 'plugin.json'), JSON.stringify({ id: 'escape-pl', clientRoot: '../outside' }))
  const escaping = await runCliCaptured(['plugins', 'build', badPlugin, '--json'], env)
  assert.notEqual(escaping.code, 0)
  assert.equal(parseCliError(escaping).code, 'invalid_plugin_definition')
})

test('plugins build: works when plugin directory traverses a symlinked/alias parent path and still rejects symlink escapes', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-build-alias-')
  const env = makeCliEnv('http://127.0.0.1:1', dataDir)
  const realParent = path.join(dataDir, 'real-parent')
  const aliasParent = path.join(dataDir, 'alias-parent')
  await fsp.mkdir(realParent, { recursive: true })
  // Junction works without admin privileges on Windows and acts as a directory symlink on POSIX,
  // reproducing the dir !== realpath(dir) mismatch (e.g. Windows RUNNER~1 or macOS /var -> /private/var).
  await fsp.symlink(realParent, aliasParent, 'junction')

  const initRes = await runCliCaptured(['plugins', 'init', 'alias-pl', '--dir', aliasParent, '--json'], env)
  assert.equal(initRes.code, 0, initRes.err)
  const { dir: aliasPluginDir } = JSON.parse(initRes.out) as { dir: string }

  const pluginManifestPath = path.join(aliasPluginDir, 'plugin.json')
  await fsp.writeFile(
    pluginManifestPath,
    JSON.stringify({ id: 'alias-pl', main: 'index.ts', clientRoot: './client', clientDist: './custom-dist' }),
  )
  const buildRes = await runCliCaptured(['plugins', 'build', aliasPluginDir, '--json'], env)
  assert.equal(buildRes.code, 0, buildRes.err)
  const buildBody = JSON.parse(buildRes.out) as { outDir: string; manifest: { modules: Record<string, unknown> } }
  assert.equal(buildBody.outDir, path.join(aliasPluginDir, 'custom-dist'))
  assert.ok(buildBody.manifest.modules['index.tsx'])

  // Symlink escape through a non-existent nested subdirectory under clientDist must still be caught.
  const outsideDir = path.join(dataDir, 'outside-target')
  await fsp.mkdir(outsideDir, { recursive: true })
  await fsp.symlink(outsideDir, path.join(aliasPluginDir, 'sym-out'), 'junction')
  await fsp.writeFile(
    pluginManifestPath,
    JSON.stringify({ id: 'alias-pl', main: 'index.ts', clientRoot: './client', clientDist: './sym-out/nested' }),
  )
  const symEscape = await runCliCaptured(['plugins', 'build', aliasPluginDir, '--json'], env)
  assert.notEqual(symEscape.code, 0)
  assert.equal(parseCliError(symEscape).code, 'invalid_plugin_definition')

  // Dangling symlink declared as clientRoot/clientDist must be rejected rather than falling back to parent.
  await fsp.symlink(path.join(dataDir, 'nonexistent-outside'), path.join(aliasPluginDir, 'dangling-client'), 'junction')
  await fsp.writeFile(
    pluginManifestPath,
    JSON.stringify({ id: 'alias-pl', main: 'index.ts', clientRoot: './dangling-client' }),
  )
  const danglingEscape = await runCliCaptured(['plugins', 'build', aliasPluginDir, '--json'], env)
  assert.notEqual(danglingEscape.code, 0)
  assert.equal(parseCliError(danglingEscape).code, 'invalid_plugin_definition')
})

const cliRequire = createRequire(import.meta.url)
const tscCliScript = cliRequire.resolve('typescript/bin/tsc')
const cliTestRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function runTscNoEmitAsync(
  tsconfigPath: string,
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tscCliScript, '--noEmit', '-p', tsconfigPath], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`tsc --noEmit timed out after 50s in ${cwd}\n${stdout}\n${stderr}`))
    }, 50_000)
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.once('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

function assertNoAncestorNodeModules(dir: string): void {
  let cur = path.resolve(dir)
  for (;;) {
    assert.equal(existsSync(path.join(cur, 'node_modules')), false, `expected isolated temp dir without ancestor node_modules at ${cur}`)
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
}

test('plugins types: syncs offline .helmx/types, cleans stale files, preserves user tsconfig.json, and validates guards', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-types-')
  const env = makeCliEnv('http://127.0.0.1:1', dataDir)

  // 1. Target directory with no tsconfig.json (positional <dir>)
  const pluginDir = path.join(dataDir, 'manual-plugin')
  await fsp.mkdir(path.join(pluginDir, '.helmx', 'types', 'stale-dir'), { recursive: true })
  await fsp.writeFile(path.join(pluginDir, '.helmx', 'types', 'stale-dir', 'old.d.ts'), 'export {}\n', 'utf8')

  const r1 = await runCliCaptured(['plugins', 'types', pluginDir, '--json'], env)
  assert.equal(r1.code, 0, r1.err)
  const body1 = JSON.parse(r1.out) as {
    dir: string
    typesDir: string
    sdkVersion: string
    filesWritten: number
    files: string[]
    tsconfigStatus: string
    recommendedCompilerOptions: { baseUrl: string; paths: Record<string, string[]> }
  }
  assert.equal(body1.dir, pluginDir)
  assert.equal(body1.typesDir, path.join(pluginDir, '.helmx', 'types'))
  assert.ok(body1.filesWritten >= 10)
  assert.equal(body1.tsconfigStatus, 'missing')
  assert.ok(body1.recommendedCompilerOptions.paths['@helmx/protocol']?.includes('./.helmx/types/protocol/index.d.ts'))
  assert.ok(body1.recommendedCompilerOptions.paths['@helmx/protocol/browser']?.includes('./.helmx/types/protocol/browser.d.ts'))
  assert.ok(body1.recommendedCompilerOptions.paths['@helmx/plugin-client']?.includes('./.helmx/types/plugin-client/index.d.ts'))
  assert.ok(existsSync(path.join(pluginDir, '.helmx', 'types', 'protocol', 'index.d.ts')))
  assert.ok(existsSync(path.join(pluginDir, '.helmx', 'types', 'protocol', 'browser.d.ts')))
  assert.ok(existsSync(path.join(pluginDir, '.helmx', 'types', 'plugin-client', 'index.d.ts')))
  assert.ok(existsSync(path.join(pluginDir, '.helmx', 'types', 'shims', 'peers.d.ts')))
  assert.ok(existsSync(path.join(pluginDir, '.helmx', 'types', 'shims', 'react.d.ts')))
  assert.ok(existsSync(path.join(pluginDir, '.helmx', 'types', 'shims', 'react-jsx-runtime.d.ts')))
  // Stale files inside .helmx/types are cleaned; missing tsconfig.json is NOT created unexpectedly.
  assert.equal(existsSync(path.join(pluginDir, '.helmx', 'types', 'stale-dir', 'old.d.ts')), false)
  assert.equal(existsSync(path.join(pluginDir, 'tsconfig.json')), false)

  // 2. Existing user tsconfig.json without Helmx paths: never clobbered, reported as needs_paths
  const bareTsconfig = '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n'
  await fsp.writeFile(path.join(pluginDir, 'tsconfig.json'), bareTsconfig, 'utf8')
  const r2 = await runCliCaptured(['plugins', 'types', '--dir', pluginDir], env)
  assert.equal(r2.code, 0, r2.err)
  assert.ok(r2.out.includes('Synced Helmx SDK types'))
  assert.ok(r2.out.includes('tsconfig.json was not modified (status: needs_paths)'))
  assert.ok(r2.out.includes('@helmx/protocol'))
  assert.equal(await fsp.readFile(path.join(pluginDir, 'tsconfig.json'), 'utf8'), bareTsconfig)

  // 3. Existing JSONC tsconfig.json with comments and trailing commas: parses cleanly and remains untouched
  const jsoncTsconfig = '// user comment\n{\n  /* block comment */ "compilerOptions": { "strict": true, }\n}\n'
  await fsp.writeFile(path.join(pluginDir, 'tsconfig.json'), jsoncTsconfig, 'utf8')
  const r3 = await runCliCaptured(['plugins', 'types', '--json'], env, { cwd: pluginDir })
  assert.equal(r3.code, 0, r3.err)
  assert.equal((JSON.parse(r3.out) as { tsconfigStatus: string }).tsconfigStatus, 'needs_paths')
  assert.equal(await fsp.readFile(path.join(pluginDir, 'tsconfig.json'), 'utf8'), jsoncTsconfig)

  // 3b. Valid JSONC with configured Helmx paths -> status configured; invalid syntax -> unreadable
  const jsoncConfigured =
    `// header // path\n{\n  "compilerOptions": {\n    "paths": ${JSON.stringify(body1.recommendedCompilerOptions.paths)},\n  },\n}\n`
  await fsp.writeFile(path.join(pluginDir, 'tsconfig.json'), jsoncConfigured, 'utf8')
  const r3b = await runCliCaptured(['plugins', 'types', '--json'], env, { cwd: pluginDir })
  assert.equal(r3b.code, 0, r3b.err)
  assert.equal((JSON.parse(r3b.out) as { tsconfigStatus: string }).tsconfigStatus, 'configured')

  const invalidTsconfig = '{ not valid jsonc'
  await fsp.writeFile(path.join(pluginDir, 'tsconfig.json'), invalidTsconfig, 'utf8')
  const r3c = await runCliCaptured(['plugins', 'types', '--json'], env, { cwd: pluginDir })
  assert.equal(r3c.code, 0, r3c.err)
  assert.equal((JSON.parse(r3c.out) as { tsconfigStatus: string }).tsconfigStatus, 'unreadable')

  // 4. Existing tsconfig.json already configured with Helmx paths -> status configured
  const configuredTsconfig = JSON.stringify(
    { compilerOptions: body1.recommendedCompilerOptions },
    null,
    2,
  )
  await fsp.writeFile(path.join(pluginDir, 'tsconfig.json'), configuredTsconfig, 'utf8')
  const r4 = await runCliCaptured(['plugins', 'types', pluginDir], env)
  assert.equal(r4.code, 0, r4.err)
  assert.ok(r4.out.includes('tsconfig.json already configures Helmx SDK paths.'))
  assert.equal(await fsp.readFile(path.join(pluginDir, 'tsconfig.json'), 'utf8'), configuredTsconfig)

  // 5. Validation & symlink safety guards
  const missingDir = await runCliCaptured(['plugins', 'types', path.join(dataDir, 'does-not-exist'), '--json'], env)
  assert.notEqual(missingDir.code, 0)
  assert.equal(parseCliError(missingDir).code, 'invalid_target_dir')

  const conflict = await runCliCaptured(['plugins', 'types', pluginDir, '--dir', pluginDir, '--json'], env)
  assert.notEqual(conflict.code, 0)
  assert.equal(parseCliError(conflict).code, 'conflicting_flags')

  const symlinkPlugin = path.join(dataDir, 'symlink-plugin')
  const outsideTarget = path.join(dataDir, 'outside-types')
  await fsp.mkdir(path.join(symlinkPlugin, '.helmx'), { recursive: true })
  await fsp.mkdir(outsideTarget, { recursive: true })
  await fsp.symlink(outsideTarget, path.join(symlinkPlugin, '.helmx', 'types'), 'junction')
  const symRes = await runCliCaptured(['plugins', 'types', symlinkPlugin, '--json'], env)
  assert.notEqual(symRes.code, 0)
  assert.equal(parseCliError(symRes).code, 'invalid_target_dir')
})

test('plugins init: all three templates pass real standalone tsc --noEmit outside the monorepo (with and without @types)', { timeout: 120_000 }, async (t) => {
  const workDir = useTempDir(t, 'helmx-cli-tsc-')
  assertNoAncestorNodeModules(workDir)
  const env = makeCliEnv('http://127.0.0.1:1', path.join(workDir, 'data'))
  const pluginsParent = path.join(workDir, 'plugins')

  // Wave 1: scaffold and typecheck minimal, full, app templates in parallel
  const templates = ['minimal', 'full', 'app'] as const
  const initResults = await Promise.all(
    templates.map(async (template) => {
      const res = await runCliCaptured(
        ['plugins', 'init', `tpl-${template}`, '--template', template, '--dir', pluginsParent, '--json'],
        env,
      )
      assert.equal(res.code, 0, `${template}: ${res.err}`)
      const body = JSON.parse(res.out) as { dir: string; files: string[] }
      assert.ok(body.files.includes('.helmx/types/'), `${template}: init should report .helmx/types/`)
      const tsconfig = JSON.parse(await fsp.readFile(path.join(body.dir, 'tsconfig.json'), 'utf8')) as {
        compilerOptions: { baseUrl?: string; paths?: Record<string, string[]> }
      }
      assert.equal(tsconfig.compilerOptions.baseUrl, '.')
      assert.deepEqual(tsconfig.compilerOptions.paths?.['@helmx/protocol'], ['./.helmx/types/protocol/index.d.ts'])
      assert.deepEqual(tsconfig.compilerOptions.paths?.['@helmx/protocol/browser'], ['./.helmx/types/protocol/browser.d.ts'])
      assert.deepEqual(tsconfig.compilerOptions.paths?.['@helmx/plugin-client'], ['./.helmx/types/plugin-client/index.d.ts'])
      return { template, dir: body.dir }
    }),
  )
  const appDir = initResults.find((r) => r.template === 'app')!.dir
  const minimalDir = initResults.find((r) => r.template === 'minimal')!.dir
  const fullDir = initResults.find((r) => r.template === 'full')!.dir
  const origIndex = await fsp.readFile(path.join(appDir, 'index.ts'), 'utf8')
  const origClient = await fsp.readFile(path.join(appDir, 'client', 'index.tsx'), 'utf8')
  const variantsRoot = path.join(workDir, 'variants')
  await fsp.mkdir(variantsRoot, { recursive: true })
  const cloneAppVariant = (name: string): string => {
    const dir = path.join(variantsRoot, name)
    cpSync(appDir, dir, { recursive: true })
    return dir
  }

  // Clone clean app template before adding extra ARIA/SDK pure-shim probe into appDir,
  // then run all positive + negative + coexistence tsc --noEmit checks in a single parallel wave.
  const badBackendDir = cloneAppVariant('bad-backend')
  await fsp.writeFile(path.join(badBackendDir, 'index.ts'), origIndex.replace("id: 'add_item',", 'id: 42,'), 'utf8')

  const badFrontendDir = cloneAppVariant('bad-frontend')
  assert.ok(origClient.includes('layout="contained"'), 'app template should declare layout="contained" on Screen')
  await fsp.writeFile(path.join(badFrontendDir, 'client', 'index.tsx'), origClient.replace('layout="contained"', 'layout="invalid-layout"'), 'utf8')

  await fsp.writeFile(
    path.join(appDir, 'client', 'shim-aria-probe.tsx'),
    [
      "import type { PointerEvent, ReactNode } from 'react'",
      "import { Badge, Button, Card, CardGrid, Field, IconButton, Input, MonoId, SelectCard, Stack, StatusLight, Textarea } from '@helmx/plugin-client'",
      'export function ShimAriaProbe(): ReactNode {',
      '  const handlePointer = (e: PointerEvent<HTMLDivElement>) => { void e.pointerId; void e.pointerType }',
      '  return (',
      '    <div role="dialog" aria-modal="true" data-probe="ok" onPointerDown={handlePointer} onPointerCancel={handlePointer} onLostPointerCapture={handlePointer}>',
      '      <CardGrid minWidth="sm" gap="md">',
      '        <Card title="Metrics" subtitle="Live" variant="subtle">',
      '          <Stack direction="horizontal" gap="sm" align="center">',
      '            <StatusLight tone="done" label="Connected" />',
      '            <Badge tone="ok" mono>v1</Badge>',
      '            <MonoId value="conn_01" />',
      '            <IconButton icon="x" label="Close" size="xs" />',
      '          </Stack>',
      '          <Field label="Threshold" hint="0-100">',
      '            <Input aria-autocomplete="list" aria-valuemin={0} aria-valuemax={100} aria-valuenow={42} />',
      '          </Field>',
      '          <Textarea rows={2} aria-multiline="true" />',
      '          <Button variant="primary" size="sm">Save</Button>',
      '        </Card>',
      '        <SelectCard title="Node A" onSelect={() => {}} />',
      '      </CardGrid>',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )

  const coexistDir = cloneAppVariant('coexist-real-types')
  const reactTypesReal = realpathSync.native(path.join(cliTestRepoRoot, 'packages/plugin-client/node_modules/@types/react'))
  const nodeTypesReal = realpathSync.native(path.join(cliTestRepoRoot, 'node_modules/@types/node'))
  await fsp.mkdir(path.join(coexistDir, 'node_modules', '@types'), { recursive: true })
  await fsp.symlink(reactTypesReal, path.join(coexistDir, 'node_modules', '@types', 'react'), 'junction')
  await fsp.symlink(nodeTypesReal, path.join(coexistDir, 'node_modules', '@types', 'node'), 'junction')
  await fsp.writeFile(
    path.join(coexistDir, 'client', 'extra.tsx'),
    [
      "import { useEffect, useRef, type ChangeEvent, type ReactNode } from 'react'",
      "import { usePluginContext, Dialog, Tabs, Select, Tooltip } from '@helmx/plugin-client'",
      'export function ExtraView(): ReactNode {',
      '  const ctx = usePluginContext()',
      '  const inputRef = useRef<HTMLInputElement>(null)',
      '  useEffect(() => { void ctx.fetchRoute("/ping"); inputRef.current?.focus() }, [ctx])',
      '  const handleChange = (e: ChangeEvent<HTMLInputElement>) => { void e.target.value }',
      '  return <Dialog open={false}><Tabs><Tooltip content="hi"><input ref={inputRef} onChange={handleChange} /></Tooltip></Tabs><Select value="a" options={[{ value: "a", label: "A" }]} onChange={() => {}} /></Dialog>',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  await fsp.writeFile(
    path.join(coexistDir, 'index.ts'),
    `import { createHash } from 'node:crypto'\n${origIndex}\nexport const digest = createHash('sha256').update('ok').digest('hex')\n`,
    'utf8',
  )

  const [minimalRes, fullRes, appAndShimRes, badBackend, badFrontend, withRealTypes] = await Promise.all([
    runTscNoEmitAsync(path.join(minimalDir, 'tsconfig.json'), minimalDir),
    runTscNoEmitAsync(path.join(fullDir, 'tsconfig.json'), fullDir),
    runTscNoEmitAsync(path.join(appDir, 'tsconfig.json'), appDir),
    runTscNoEmitAsync(path.join(badBackendDir, 'tsconfig.json'), badBackendDir),
    runTscNoEmitAsync(path.join(badFrontendDir, 'tsconfig.json'), badFrontendDir),
    runTscNoEmitAsync(path.join(coexistDir, 'tsconfig.json'), coexistDir),
  ])

  assert.equal(minimalRes.status, 0, `standalone tsc --noEmit failed for template minimal:\n${minimalRes.stdout}\n${minimalRes.stderr}`)
  assert.equal(fullRes.status, 0, `standalone tsc --noEmit failed for template full:\n${fullRes.stdout}\n${fullRes.stderr}`)
  assert.equal(
    appAndShimRes.status,
    0,
    `standalone pure-shim tsc --noEmit failed for template app + React 19 ARIA + SDK primitives:\n${appAndShimRes.stdout}\n${appAndShimRes.stderr}`,
  )
  assert.notEqual(badBackend.status, 0, 'invalid backend PluginActionSpec.id must fail tsc --noEmit')
  assert.notEqual(badFrontend.status, 0, 'invalid Screen layout prop must fail tsc --noEmit')
  assert.equal(
    withRealTypes.status,
    0,
    `tsc --noEmit with real @types/react + @types/node failed:\n${withRealTypes.stdout}\n${withRealTypes.stderr}`,
  )
})

test('plugins install --enable surfaces enableError and exits non-zero; plugins client --output resolves cwd and reports UTF-8 bytes', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const workDir = useTempDir(t, 'helmx-cli-client-cwd-')
  const utf8Code = 'export const msg = "你好，世界";\n'
  const expectedUtf8Bytes = Buffer.byteLength(utf8Code, 'utf8')
  assert.notEqual(expectedUtf8Bytes, utf8Code.length)

  const hub = await startMockHub(
    {
      'POST /api/plugins/install': () => ({
        status: 201,
        body: {
          record: {
            id: 'inst-1',
            pluginId: 'my:pl',
            source: { kind: 'local', raw: '/srv/my-pl', path: '/srv/my-pl' },
            installPath: '/data/plugins/my:pl',
            version: '1.0.0',
            installedAt: 1,
            updatedAt: 1,
          },
          summary: makePluginSummary({ id: 'my:pl', enabled: false, status: 'disabled' }),
          enableError: { code: 'plugin_enable_failed', message: 'missing config key API_KEY' },
        },
      }),
      'POST /api/plugins/my%3Apl/remove': () => ({
        body: { pluginId: 'my:pl', installPath: '/data/plugins/my:pl', wasEnabled: false, installId: 'inst-1' },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dataDir)

  // plugins install --enable with enableError: human mode exits 1 and surfaces enableError
  const rHuman = await runCliCaptured(['plugins', 'install', '/srv/my-pl', '--enable'], env)
  assert.equal(rHuman.code, 1)
  assert.ok(rHuman.out.includes('Installed my:pl'))
  assert.ok(rHuman.err.includes('plugin_enable_failed'))
  assert.ok(rHuman.err.includes('missing config key API_KEY'))

  // --json mode prints full result with enableError and exits 1
  const rJson = await runCliCaptured(['plugins', 'install', '/srv/my-pl', '--enable', '--json'], env)
  assert.equal(rJson.code, 1)
  const installBody = JSON.parse(rJson.out) as { enableError?: { code: string; message: string } }
  assert.equal(installBody.enableError?.code, 'plugin_enable_failed')

  // plugins remove uses ctx.io.stdin TTY readLine without touching global process.stdin
  let sawPrompt = false
  const denied = await runCliCaptured(['plugins', 'remove', 'my:pl'], env, {
    stdin: {
      isTTY: true,
      readAll: async () => 'no',
      readLine: async (prompt) => {
        sawPrompt = prompt.includes('my:pl')
        return 'no'
      },
    },
  })
  assert.equal(sawPrompt, true)
  assert.equal(denied.code, 1)
  assert.ok(denied.err.includes('not_confirmed'))

  const confirmed = await runCliCaptured(['plugins', 'remove', 'my:pl'], env, {
    stdin: { isTTY: true, readAll: async () => '', readLine: async () => 'yes' },
  })
  assert.equal(confirmed.code, 0, confirmed.err)
  assert.ok(confirmed.out.includes('Removed my:pl'))

  // plugins client --output resolves against ctx.cwd and reports UTF-8 byte count
  const clientRes = await runCliCaptured(
    ['plugins', 'client', 'my:pl', '--output', 'out/bundle.mjs', '--json'],
    env,
    {
      cwd: workDir,
      fetch: (async () =>
        new Response(utf8Code, {
          status: 200,
          headers: { 'content-type': 'application/javascript', 'x-helmx-client-hash': 'hash-utf8' },
        })) as unknown as typeof fetch,
    },
  )
  // Expect write failure if parent dir doesn't exist OR ensure directory exists first: test existing dir
  assert.equal(clientRes.code, 1)
  await fsp.mkdir(path.join(workDir, 'out'), { recursive: true })
  const clientOk = await runCliCaptured(
    ['plugins', 'client', 'my:pl', '--output', 'out/bundle.mjs', '--json'],
    env,
    {
      cwd: workDir,
      fetch: (async () =>
        new Response(utf8Code, {
          status: 200,
          headers: { 'content-type': 'application/javascript', 'x-helmx-client-hash': 'hash-utf8' },
        })) as unknown as typeof fetch,
    },
  )
  assert.equal(clientOk.code, 0, clientOk.err)
  const expectedOut = path.join(workDir, 'out', 'bundle.mjs')
  assert.deepEqual(JSON.parse(clientOk.out), {
    pluginId: 'my:pl',
    module: 'client.tsx',
    contentHash: 'hash-utf8',
    bytes: expectedUtf8Bytes,
    outputPath: expectedOut,
  })
  assert.equal(await fsp.readFile(expectedOut, 'utf8'), utf8Code)
})

test('writeSdkTypesToDir backs up existing .helmx/types before atomic swap and restores on failure', { timeout: 60_000 }, async (t) => {
  const pluginDir = useTempDir(t, 'helmx-sdk-rollback-')
  const typesDir = path.join(pluginDir, '.helmx', 'types')
  await fsp.mkdir(typesDir, { recursive: true })
  await fsp.writeFile(path.join(typesDir, 'existing.d.ts'), 'export const keep = true\n', 'utf8')

  let callCount = 0
  await assert.rejects(
    () =>
      writeSdkTypesToDir(pluginDir, {
        async rename(src, dest) {
          callCount += 1
          if (callCount === 2) {
            throw new Error('simulated swap failure')
          }
          await fsp.rename(src, dest)
        },
      }),
    /simulated swap failure/,
  )
  assert.equal(await fsp.readFile(path.join(typesDir, 'existing.d.ts'), 'utf8'), 'export const keep = true\n')
  const leftovers = await fsp.readdir(path.join(pluginDir, '.helmx'))
  assert.deepEqual(leftovers, ['types'])
})
