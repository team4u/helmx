/**
 * Unit tests for scripts/lib/prune-dist.mjs, scripts/lib/test-sharding.mjs,
 * scripts/lib/test-timings.mjs, scripts/lib/test-concurrency.mjs, and scripts/lib/shard-worker.mjs.
 *
 * Covers incremental pruneDist (preserving valid artifacts, trimming stale files and
 * empty directories, mirroring/trimming plugin client assets), full cleanup on --force /
 * HELMX_CLEAN_DIST=1 with tsbuildinfo removal, 4-pool AST classification (pure / dom-shared /
 * node-shared / isolated, pragma opt-out, scoped unhandledRejection, process.kill(pid, 0) probe,
 * regex .exec exemption), mtime/size + helper-fingerprint AST disk cache, auto-recorded timing
 * EMA store and unified-ms LPT weighting, concurrent 4-pool scheduling with zero serial pure
 * barrier, and persistent shard-worker per-file hook isolation.
 *
 * Runner: node:test; every test sets an explicit timeout: 60_000.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { pruneDist, resolveTsBuildInfoFile, runCleanDistCli } from '../../../scripts/lib/prune-dist.mjs'
import {
  analyzeTestFilePurity,
  analyzeTestSourcePurity,
  classifyTestFilePool,
  loadPurityCache,
  partitionFilesForSharding,
  planFourPoolSchedule,
  requiresNativeProcessIsolation,
  savePurityCache,
  shouldDisableSharding,
} from '../../../scripts/lib/test-sharding.mjs'
import {
  createTestWeightFn,
  emptyTestTimingsStore,
  estimateFallbackDurationMs,
  loadTestTimings,
  mergeTestTimings,
  pruneStaleTestTimings,
  saveTestTimings,
} from '../../../scripts/lib/test-timings.mjs'
import {
  explicitTestConcurrency,
  resolveTestConcurrency,
  withDefaultTestConcurrency,
} from '../../../scripts/lib/test-concurrency.mjs'
import {
  BuildArgError,
  buildUsageText,
  parseBuildArgs,
  planBuildStages,
} from '../../../scripts/build.mjs'
import { TYPECHECK_TARGETS } from '../../../scripts/typecheck.mjs'
import {
  VerifyArgError,
  parseVerifyArgs,
  planVerifyStages,
  verifyUsageText,
} from '../../../scripts/verify.mjs'
import { pruneTsxCacheIfBloated } from '../../../scripts/lib/tsx-cache-hygiene.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function touch(root: string, rel: string, content = ''): string {
  const abs = path.join(root, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

test('pruneDist: preserves valid artifacts and prunes orphaned artifacts, stale files, and empty directories', { timeout: 60_000 }, () => {
  const pkgRoot = mkdtempSync(path.join(tmpdir(), 'helmx-prune-dist-'))
  try {
    touch(pkgRoot, 'tsconfig.json', JSON.stringify({
      compilerOptions: { outDir: 'dist', tsBuildInfoFile: './cache/pkg.tsbuildinfo' },
    }))
    const buildInfo = resolveTsBuildInfoFile(pkgRoot)
    assert.ok(buildInfo?.endsWith(path.join('cache', 'pkg.tsbuildinfo')))
    touch(pkgRoot, 'cache/pkg.tsbuildinfo', '{}')

    // Valid sources and full artifact sets (including .tsx / .mts / .cts)
    touch(pkgRoot, 'src/index.ts', 'export const a = 1')
    touch(pkgRoot, 'src/ui.tsx', 'export const UI = () => null')
    touch(pkgRoot, 'src/mod.mts', 'export const m = 1')
    touch(pkgRoot, 'src/cjs.cts', 'export const c = 1')

    for (const rel of [
      'dist/index.js',
      'dist/index.js.map',
      'dist/index.d.ts',
      'dist/index.d.ts.map',
      'dist/ui.js',
      'dist/ui.d.ts',
      'dist/mod.mjs',
      'dist/mod.d.mts',
      'dist/mod.mjs.map',
      'dist/mod.d.mts.map',
      'dist/cjs.cjs',
      'dist/cjs.d.cts',
    ]) {
      touch(pkgRoot, rel, 'valid')
    }

    // Leftover artifacts from deleted sources + old split-package layout (e.g., kernel/dist/main.js, app.js, builtin-plugins/*) + unknown artifacts
    for (const stale of [
      'dist/stale-dummy.js',
      'dist/main.js',
      'dist/main.d.ts',
      'dist/main.js.map',
      'dist/main.d.ts.map',
      'dist/app.js',
      'dist/builtin-plugins/old.js',
      'dist/builtin-plugins/nested/ghost.d.ts',
      'dist/random-notes.txt',
    ]) {
      touch(pkgRoot, stale, 'stale')
    }

    const res = pruneDist({ pkgRoot, env: {} })
    assert.equal(res.mode, 'pruned')
    assert.equal(res.removedFiles.length, 9)

    for (const kept of [
      'dist/index.js',
      'dist/index.d.ts',
      'dist/index.js.map',
      'dist/index.d.ts.map',
      'dist/ui.js',
      'dist/mod.mjs',
      'dist/mod.d.mts',
      'dist/cjs.cjs',
      'dist/cjs.d.cts',
    ]) {
      assert.ok(existsSync(path.join(pkgRoot, kept)), `valid artifact must not be deleted: ${kept}`)
    }
    for (const gone of [
      'dist/stale-dummy.js',
      'dist/main.js',
      'dist/app.js',
      'dist/builtin-plugins',
      'dist/random-notes.txt',
    ]) {
      assert.ok(!existsSync(path.join(pkgRoot, gone)), `stale artifact or empty directory must be deleted: ${gone}`)
    }
    assert.ok(existsSync(buildInfo!), 'must retain tsbuildinfo to preserve incremental builds when not forced and valid artifacts remain')
  } finally {
    rmSync(pkgRoot, { recursive: true, force: true })
  }
})

test('pruneDist(preserveClients): mirrors src/<name>/client/** assets and deletes removed or mistakenly compiled client files', { timeout: 60_000 }, () => {
  const pkgRoot = mkdtempSync(path.join(tmpdir(), 'helmx-prune-clients-'))
  try {
    touch(pkgRoot, 'src/index.ts', 'export {}')
    touch(pkgRoot, 'src/apps/client/index.tsx', 'export default function App() {}')
    touch(pkgRoot, 'src/apps/client/styles.css', '.a {}')

    touch(pkgRoot, 'dist/index.js', '')
    touch(pkgRoot, 'dist/apps/client/index.tsx', 'valid')
    touch(pkgRoot, 'dist/apps/client/styles.css', 'valid')
    touch(pkgRoot, 'dist/apps/client/removed.tsx', 'stale client file')
    touch(pkgRoot, 'dist/apps/client/index.js', 'stray compiled file inside client')
    touch(pkgRoot, 'dist/ghost-plugin/client/index.tsx', 'removed plugin client')

    const res = pruneDist({ pkgRoot, preserveClients: true, env: {} })
    assert.equal(res.mode, 'pruned')
    assert.deepEqual(res.removedFiles.sort(), [
      'apps/client/index.js',
      'apps/client/removed.tsx',
      'ghost-plugin/client/index.tsx',
    ])
    assert.ok(existsSync(path.join(pkgRoot, 'dist/apps/client/index.tsx')))
    assert.ok(existsSync(path.join(pkgRoot, 'dist/apps/client/styles.css')))
    assert.ok(!existsSync(path.join(pkgRoot, 'dist/ghost-plugin')))
  } finally {
    rmSync(pkgRoot, { recursive: true, force: true })
  }
})

test('pruneDist: --force / HELMX_CLEAN_DIST=1 and empty dist always clear tsbuildinfo to prevent tsc incremental skips', { timeout: 60_000 }, () => {
  const pkgRoot = mkdtempSync(path.join(tmpdir(), 'helmx-prune-force-'))
  try {
    touch(pkgRoot, 'tsconfig.json', JSON.stringify({
      compilerOptions: { outDir: 'dist', tsBuildInfoFile: './cache/pkg.tsbuildinfo' },
    }))
    const buildInfo = resolveTsBuildInfoFile(pkgRoot)!

    // 1. Full wipe via HELMX_CLEAN_DIST=1
    touch(pkgRoot, 'src/a.ts', 'export const a = 1')
    touch(pkgRoot, 'dist/a.js', 'compiled')
    touch(pkgRoot, 'cache/pkg.tsbuildinfo', '{}')
    const rEnv = pruneDist({ pkgRoot, env: { HELMX_CLEAN_DIST: '1' } })
    assert.equal(rEnv.mode, 'wiped')
    assert.ok(!existsSync(path.join(pkgRoot, 'dist')))
    assert.ok(!existsSync(buildInfo), 'forced wipe must remove tsbuildinfo')

    // 2. Full wipe via --force CLI flag
    touch(pkgRoot, 'dist/a.js', 'compiled')
    touch(pkgRoot, 'cache/pkg.tsbuildinfo', '{}')
    const rCli = runCleanDistCli(pkgRoot, ['--force'])
    assert.equal(rCli.mode, 'wiped')
    assert.ok(!existsSync(path.join(pkgRoot, 'dist')))
    assert.ok(!existsSync(buildInfo))

    // 3. Automatically clears tsbuildinfo when dist ends up empty (only stale files remained)
    touch(pkgRoot, 'dist/stale.js', 'only stale')
    touch(pkgRoot, 'cache/pkg.tsbuildinfo', '{}')
    const rEmpty = pruneDist({ pkgRoot, env: {} })
    assert.equal(rEmpty.mode, 'pruned')
    assert.ok(!existsSync(buildInfo), 'must clear tsbuildinfo when no valid JS artifacts remain after pruning')
  } finally {
    rmSync(pkgRoot, { recursive: true, force: true })
  }
})

test('test-sharding: AST purity check allows in-memory unit tests and isolates DOM/env/child-process/file-write/timer/mutation patterns', { timeout: 60_000 }, () => {
  const pure = analyzeTestSourcePurity(
    ts,
    'pure.test.ts',
    `import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Window } from 'happy-dom'
import type { KernelRuntime } from '@helmx/kernel'
const PATH_VAL = process.env['PATH']
test('ok', { timeout: 60_000 }, () => {
  const obj = { window: 1, document: 'text' }
  assert.equal(obj.window, 1)
  void readFileSync
  void PATH_VAL
})`,
  )
  assert.equal(pure.pure, true, `expected pure test to pass, actual reasons: ${pure.reasons.join(', ')}`)

  const cases: Array<[string, string]> = [
    ['happy-dom import', `import { GlobalRegistrator } from '@happy-dom/global-registrator'\nGlobalRegistrator.register()`],
    ['react-dom/client', `import { createRoot } from 'react-dom/client'\nvoid createRoot`],
    ['parenthesized globalThis assertion', `import * as React from 'react'\n;(globalThis as Record<string, unknown>).React = React`],
    ['document/window access', `const el = document.createElement('div')\nwindow.history.back()\nvoid el`],
    ['process.env[] write and delete', `process.env['FOO'] = '1'\ndelete process.env['FOO']`],
    ['process.env assignment', `process.env = {} as NodeJS.ProcessEnv`],
    ['process.stdin/chdir', `process.chdir('/tmp')\nprocess.stdin.resume()`],
    ['spawn / child_process', `import { spawn } from 'node:child_process'\nspawn('echo', ['hi'])`],
    ['aliased fs write import', `import { writeFileSync as wf } from 'node:fs'\nwf('a', 'b')`],
    ['http createServer / listen', `import http from 'node:http'\nhttp.createServer().listen(0)`],
    ['KernelRuntime / createHelmx / DatabaseSync', `import { DatabaseSync } from 'node:sqlite'\nnew DatabaseSync(':memory:')`],
    ['timer overrides and t.mock.timers', `test('x', { timeout: 60_000 }, (t) => { t.mock.timers.enable({ apis: ['setTimeout'] }) })`],
    ['Object.assign mutating an imported object', `import { cfg } from '../src/cfg.js'\nObject.assign(cfg, { a: 1 })`],
  ]

  for (const [label, code] of cases) {
    const r = analyzeTestSourcePurity(ts, 'bad.test.ts', code)
    assert.equal(r.pure, false, `${label} must be classified as impure`)
    assert.ok(r.reasons.length > 0, `${label} must report a non-empty reason`)
  }
})

test('test concurrency: defaults to fourteen workers, honors explicit overrides, and rejects invalid values', { timeout: 60_000 }, () => {
  assert.equal(resolveTestConcurrency(undefined, 16), 14)
  assert.equal(resolveTestConcurrency(undefined, 2), 2)
  assert.equal(resolveTestConcurrency('7', 16), 7)
  assert.equal(explicitTestConcurrency([]), undefined)
  assert.equal(explicitTestConcurrency(['--test-concurrency=9']), 9)
  assert.equal(explicitTestConcurrency(['--test-concurrency', '6']), 6)
  assert.deepEqual(withDefaultTestConcurrency(['foo.test.ts'], 4), ['--test-concurrency=4', 'foo.test.ts'])
  assert.deepEqual(withDefaultTestConcurrency(['--test-concurrency=6', 'foo.test.ts'], 4), ['--test-concurrency=6', 'foo.test.ts'])
  assert.throws(() => resolveTestConcurrency('0', 16), /positive integer/)
  assert.throws(() => explicitTestConcurrency(['--test-concurrency=bad']), /positive integer/)
})

test('test-sharding: recursive helper tracing (with cycle guard), flag fallback conditions, and balanced LPT sharding', { timeout: 60_000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'helmx-shard-disk-'))
  try {
    const pureTest = touch(root, 'packages/a/test/pure.test.ts', `import test from 'node:test'\nimport { helper } from './helpers/pure-helper.js'\ntest('p', { timeout: 60_000 }, () => { void helper })`)
    touch(root, 'packages/a/test/helpers/pure-helper.ts', `import { other } from './cycle.js'\nexport const helper = () => other`)
    touch(root, 'packages/a/test/helpers/cycle.ts', `import { helper } from './pure-helper.js'\nexport const other = () => helper`)

    const impureViaHelper = touch(root, 'packages/a/test/via-helper.test.ts', `import test from 'node:test'\nimport { mount } from './helpers/dom-helper.js'\ntest('d', { timeout: 60_000 }, () => { mount() })`)
    touch(root, 'packages/a/test/helpers/dom-helper.ts', `export const mount = () => { (globalThis as Record<string, unknown>).x = 1 }`)

    assert.equal(analyzeTestFilePurity(ts, pureTest).pure, true)
    const impureRes = analyzeTestFilePurity(ts, impureViaHelper)
    assert.equal(impureRes.pure, false)
    assert.ok(impureRes.reasons.some((r) => r.includes('globalThis')))

    // shouldDisableSharding
    assert.equal(shouldDisableSharding([]), false)
    assert.equal(shouldDisableSharding(['--test-only']), true)
    assert.equal(shouldDisableSharding(['--test-isolation=none']), true)
    assert.equal(shouldDisableSharding(['--test-reporter=tap']), true)
    assert.equal(shouldDisableSharding(['--test-name-pattern=foo']), true)
    assert.equal(shouldDisableSharding(['--test-skip-pattern=foo']), true)
    assert.equal(shouldDisableSharding(['--test-timeout=5000']), true)
    assert.equal(shouldDisableSharding(['--experimental-test-coverage']), true)
    assert.equal(shouldDisableSharding(['-t', 'foo']), true)

    // partitionFilesForSharding distributes files evenly with LPT without duplicates or omissions
    const files = Array.from({ length: 18 }, (_, i) => {
      const rel = `packages/a/test/p${i}.test.ts`
      touch(root, rel, `import test from 'node:test'\ntest('${i}', { timeout: 60_000 }, () => {})`)
      return rel
    })
    files.push(path.relative(root, impureViaHelper))
    const weights = new Map(files.map((f, i) => [f, (i + 1) * 100]))
    const part = partitionFilesForSharding({
      ts,
      repoRoot: root,
      files,
      cpus: 4,
      filesPerShard: 6,
      weightFn: (rel) => weights.get(rel) ?? 0,
    })
    assert.equal(part.pureFiles.length, 18)
    assert.equal(part.isolatedFiles.length, 1)
    assert.equal(part.shards.length, 3)
    const flattened = part.shards.flat()
    assert.equal(flattened.length, 18)
    assert.equal(new Set(flattened).size, 18)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('test-sharding: 4-pool classifier separates pure, dom-shared, node-shared, and isolated accurately', { timeout: 60_000 }, () => {
  // pure: read-only fs, env reads, RegExp variable .exec(), domain .fork()/.open(), read-only globalThis.fetch
  const pureRes = analyzeTestSourcePurity(
    ts,
    'pure.test.ts',
    `import test from 'node:test'
import { readFileSync } from 'node:fs'
const tagRe = /foo/g
const api = { fork: () => 1, open: () => 2 }
const f = globalThis.fetch
test('ok', { timeout: 60_000 }, () => {
  void tagRe.exec('foo')
  void api.fork()
  void api.open()
  void readFileSync
  void f
})`,
  )
  assert.equal(pureRes.pool, 'pure', `expected pure, got ${pureRes.pool} (${pureRes.reasons.join(', ')})`)
  assert.equal(pureRes.pure, true)

  // dom-shared: happy-dom, React DOM, Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT }), client compile, scoped unhandledRejection, restored console overrides
  const domCases: Array<[string, string]> = [
    ['happy-dom register + document', `import { GlobalRegistrator } from '@happy-dom/global-registrator'\nGlobalRegistrator.register()\ndocument.createElement('div')`],
    ['React SSR globalThis.React', `import * as React from 'react'\nObject.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })`],
    ['dom + plugin-build client compile + scoped unhandledRejection', `import { GlobalRegistrator } from '@happy-dom/global-registrator'\nimport { compilePluginClientModule } from '@helmx/plugin-build'\nimport { mkdirSync } from 'node:fs'\nGlobalRegistrator.register()\nmkdirSync('/tmp/x')\nconst fn = () => {}\nprocess.on('unhandledRejection', fn)\nprocess.off('unhandledRejection', fn)\nvoid compilePluginClientModule`],
    ['dom + console.error override', `import { GlobalRegistrator } from '@happy-dom/global-registrator'\nGlobalRegistrator.register()\nconsole.error = () => {}`],
  ]
  for (const [label, code] of domCases) {
    const r = analyzeTestSourcePurity(ts, 'dom.test.tsx', code)
    assert.equal(r.pool, 'dom-shared', `${label}: expected dom-shared, got ${r.pool} (${r.reasons.join(', ')})`)
    assert.equal(r.pure, false)
  }

  // node-shared: temp dirs, SQLite, HTTP/net, subprocess, createHelmx, KernelRuntime, env.exec(),
  // process.kill(pid, 0) / child-PID process.kill(child.pid, sig), per-key process.env, mock.method,
  // console.error/warn/log override, globalThis.fetch override, scoped unhandledRejection
  const nodeCases: Array<[string, string]> = [
    ['fs temp dir writes', `import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'\nconst d = mkdtempSync('x')\nwriteFileSync(d, '1')\nrmSync(d)`],
    ['SQLite + HTTP + createHelmx', `import { DatabaseSync } from 'node:sqlite'\nimport http from 'node:http'\nnew DatabaseSync(':memory:')\nhttp.createServer().listen(0)\ncreateHelmx({})`],
    ['env.exec + read-only liveness probe', `async function run(env: { exec: (c: string) => void }, pid: number) { env.exec('echo hi'); process.kill(pid, 0) }`],
    ['scoped unhandledRejection cleanup + fs', `import { mkdirSync } from 'node:fs'\nmkdirSync('x')\nconst onU = () => {}\nprocess.on('unhandledRejection', onU)\ntry {} finally { process.off('unhandledRejection', onU) }`],
    ['per-key process.env assign and delete', `process.env.FOO = 'bar'\ndelete process.env.FOO`],
    ['mock.method', `import { mock } from 'node:test'\nmock.method(console, 'log', () => {})`],
    ['console.error override', `console.error = () => {}`],
    ['globalThis.fetch override', `globalThis.fetch = (async () => new Response('ok')) as typeof fetch`],
    ['positive child-PID process.kill', `function stop(child: { pid?: number }) { process.kill(child.pid!, 'SIGTERM') }`],
  ]
  for (const [label, code] of nodeCases) {
    const r = analyzeTestSourcePurity(ts, 'node.test.ts', code)
    assert.equal(r.pool, 'node-shared', `${label}: expected node-shared, got ${r.pool} (${r.reasons.join(', ')})`)
    assert.equal(r.pure, false)
  }

  // isolated: pragma override, whole process.env replacement, chdir/stdin/stderr, self/PGID process.kill,
  // unpaired process.on, unregister, mock.timers, worker_threads, DOM+backend mix, non-DOM globalThis write
  const isoCases: Array<[string, string]> = [
    ['pragma opt-out', `// @test-isolation: process\nimport test from 'node:test'\ntest('x', { timeout: 60_000 }, () => {})`],
    ['block-comment pragma opt-out', `/*\n * @test-isolation: process\n */\nimport test from 'node:test'\ntest('x', { timeout: 60_000 }, () => {})`],
    ['whole process.env replacement', `process.env = {} as NodeJS.ProcessEnv`],
    ['self process.kill(process.pid)', `process.kill(process.pid, 'SIGTERM')`],
    ['negative PGID process.kill(-child.pid)', `function killGroup(child: { pid: number }) { process.kill(-child.pid, 'SIGKILL') }`],
    ['aliased negative PGID process.kill', `function killGroup(child: { pid: number }) { const pgid = -child.pid; process.kill(pgid, 'SIGKILL') }`],
    ['zero PGID process.kill(0)', `process.kill(0, 'SIGTERM')`],
    ['unpaired process.on', `process.on('SIGTERM', () => {})`],
    ['unpaired process.on unhandledRejection', `process.on('unhandledRejection', () => {})`],
    ['GlobalRegistrator.unregister', `import { GlobalRegistrator } from '@happy-dom/global-registrator'\nGlobalRegistrator.register()\nGlobalRegistrator.unregister()`],
    ['mock.timers', `test('x', { timeout: 60_000 }, (t) => { t.mock.timers.enable() })`],
    ['worker_threads', `import { Worker } from 'node:worker_threads'\nnew Worker('')`],
    ['DOM mixed with createHelmx', `import { GlobalRegistrator } from '@happy-dom/global-registrator'\nGlobalRegistrator.register()\ncreateHelmx({})`],
    ['delete globalThis.window', `delete (globalThis as Record<string, unknown>).window`],
    ['non-DOM globalThis write', `(globalThis as Record<string, unknown>).myGlobal = 42`],
    ['imported binding mutation', `import { timings } from '../src/t.js'\nObject.assign(timings, { ms: 1 })`],
  ]
  for (const [label, code] of isoCases) {
    const r = analyzeTestSourcePurity(ts, 'iso.test.ts', code)
    assert.equal(r.pool, 'isolated', `${label}: expected isolated, got ${r.pool} (${r.reasons.join(', ')})`)
    assert.equal(r.pure, false)
  }

  // requiresNativeProcessIsolation keeps --test-isolation=process for pragma/self-signal files only
  assert.equal(requiresNativeProcessIsolation(['pragma:test-isolation:process']), true)
  assert.equal(requiresNativeProcessIsolation(['process.kill:self']), true)
  assert.equal(requiresNativeProcessIsolation(['process.on']), true)
  assert.equal(requiresNativeProcessIsolation(['process.kill']), false)
  assert.equal(requiresNativeProcessIsolation(['mock.timers']), false)
  assert.ok(
    analyzeTestSourcePurity(ts, 'self-kill.test.ts', `process.kill(process.pid, 'SIGTERM')`).reasons.includes('process.kill:self'),
    'self-signaling process.kill(process.pid) must tag process.kill:self',
  )

  // Pragma text embedded inside string literals after imports must NOT force isolation (rescuing build-runner.test.ts itself)
  const selfClassification = analyzeTestFilePurity(ts, fileURLToPath(import.meta.url))
  assert.equal(
    selfClassification.pool,
    'node-shared',
    `build-runner.test.ts must classify as node-shared rather than isolated (${selfClassification.reasons.join(', ')})`,
  )
})

test('test-sharding: AST cache skips TypeScript on warm hit and invalidates when test file or helper changes', { timeout: 60_000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'helmx-ast-cache-'))
  try {
    const helperPath = touch(root, 'packages/a/test/helpers/h.ts', `export const noop = () => 1\n`)
    const testPath = touch(
      root,
      'packages/a/test/sample.test.ts',
      `import test from 'node:test'\nimport { noop } from './helpers/h.js'\ntest('ok', { timeout: 60_000 }, () => { void noop })\n`,
    )
    const cachePath = path.join(root, 'node_modules', '.cache', 'purity.json')

    // 1. Cold miss populates cache
    const cache1 = loadPurityCache(cachePath)
    let tsLoads = 0
    const getTs = () => {
      tsLoads += 1
      return ts
    }
    const r1 = classifyTestFilePool(null, testPath, { repoRoot: root, cache: cache1, getTs })
    assert.equal(r1.pool, 'pure')
    assert.equal(r1.cacheHit, false)
    assert.equal(tsLoads, 1)
    assert.equal(savePurityCache(cachePath, cache1), true)

    // 2. Warm hit never invokes getTs
    const cache2 = loadPurityCache(cachePath)
    const r2 = classifyTestFilePool(null, testPath, {
      repoRoot: root,
      cache: cache2,
      getTs: () => {
        throw new Error('getTs must not be invoked on warm AST cache hit')
      },
    })
    assert.equal(r2.pool, 'pure')
    assert.equal(r2.cacheHit, true)

    // 3. Modifying the relative helper invalidates cache even when test file mtime/size is unchanged
    writeFileSync(helperPath, `import { mkdtempSync } from 'node:fs'\nexport const noop = () => mkdtempSync('x')\n`)
    const bump = new Date(Date.now() + 5000)
    utimesSync(helperPath, bump, bump)
    const r3 = classifyTestFilePool(null, testPath, { repoRoot: root, cache: cache2, getTs })
    assert.equal(r3.cacheHit, false, 'helper edit must invalidate cached classification')
    assert.equal(r3.pool, 'node-shared')

    // 4. Adding pragma to test file invalidates cache and moves it to isolated
    writeFileSync(
      testPath,
      `// @test-isolation: process\nimport test from 'node:test'\nimport { noop } from './helpers/h.js'\ntest('ok', { timeout: 60_000 }, () => { void noop })\n`,
    )
    const bump2 = new Date(Date.now() + 10_000)
    utimesSync(testPath, bump2, bump2)
    const r4 = classifyTestFilePool(null, testPath, { repoRoot: root, cache: cache2, getTs })
    assert.equal(r4.cacheHit, false)
    assert.equal(r4.pool, 'isolated')

    // 5. Corrupt or wrong-schema cache falls back safely
    writeFileSync(cachePath, '{not-json')
    assert.deepEqual(loadPurityCache(cachePath).entries, {})
    writeFileSync(cachePath, JSON.stringify({ schemaVersion: 999, entries: { a: {} } }))
    assert.deepEqual(loadPurityCache(cachePath).entries, {})
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('test-timings: loads, merges EMA durations, persists atomically, and shares unified ms scale with fallback', { timeout: 60_000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'helmx-timings-'))
  try {
    const cachePath = path.join(root, 'node_modules', '.cache', 'timings.json')
    assert.deepEqual(loadTestTimings(cachePath), emptyTestTimingsStore())

    const s1 = mergeTestTimings(
      emptyTestTimingsStore(),
      {
        'packages/a/test/fast.test.ts': 40,
        'packages/a/test/slow.test.ts': 10_000,
        'packages/a/test/bad.test.ts': -5,
        'packages/a/test/nan.test.ts': Number.NaN,
      },
      { now: 1000 },
    )
    assert.equal(s1.files['packages/a/test/fast.test.ts']?.durationMs, 40)
    assert.equal(s1.files['packages/a/test/slow.test.ts']?.durationMs, 10_000)
    assert.equal(s1.files['packages/a/test/bad.test.ts'], undefined)
    assert.equal(s1.files['packages/a/test/nan.test.ts'], undefined)

    // Second observation blends via EMA (alpha = 0.65 -> round(10000*0.35 + 20000*0.65) = 16500)
    const s2 = mergeTestTimings(s1, { 'packages/a/test/slow.test.ts': 20_000 }, { alpha: 0.65, now: 2000 })
    assert.equal(s2.files['packages/a/test/slow.test.ts']?.durationMs, 16_500)
    assert.equal(s2.files['packages/a/test/slow.test.ts']?.runs, 2)

    assert.equal(saveTestTimings(cachePath, s2), true)
    const loaded = loadTestTimings(cachePath)
    assert.equal(loaded.files['packages/a/test/slow.test.ts']?.durationMs, 16_500)

    const swarmFile = touch(root, 'packages/plugins/test/swarm.integration.test.ts', 'x'.repeat(4000))
    const smallFile = touch(root, 'packages/protocol/test/tiny.test.ts', 'x'.repeat(400))
    const { weightFn, recordedCount } = createTestWeightFn({ repoRoot: root, timings: loaded })
    assert.equal(weightFn('packages/a/test/slow.test.ts'), 16_500)
    assert.ok(
      estimateFallbackDurationMs(root, path.relative(root, swarmFile)) >
        estimateFallbackDurationMs(root, path.relative(root, smallFile)),
      'fallback ms heuristic must rank swarm above tiny files on the same ms scale',
    )
    assert.equal(recordedCount(['packages/a/test/slow.test.ts', path.relative(root, smallFile)]), 1)

    // pruneStaleTestTimings drops deleted files while preserving existing files across suites
    touch(root, 'packages/a/test/slow.test.ts', 'export {}')
    const pruned = pruneStaleTestTimings(loaded, root)
    assert.equal(pruned.files['packages/a/test/slow.test.ts']?.durationMs, 16_500)
    assert.equal(pruned.files['packages/a/test/fast.test.ts'], undefined, 'non-existent test file timing must be pruned')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('planFourPoolSchedule: creates concurrent permits=1 shards across all 4 pools with zero serial pure barrier', { timeout: 60_000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'helmx-4pool-plan-'))
  try {
    const files: string[] = []
    const weights = new Map<string, number>()

    for (let i = 0; i < 10; i += 1) {
      const rel = `packages/protocol/test/p${i}.test.ts`
      touch(root, rel, `import test from 'node:test'\ntest('p${i}', { timeout: 60_000 }, () => {})`)
      files.push(rel)
      weights.set(rel, 100)
    }
    for (let i = 0; i < 6; i += 1) {
      const rel = `packages/web/test/d${i}.test.tsx`
      touch(root, rel, `import { GlobalRegistrator } from '@happy-dom/global-registrator'\nGlobalRegistrator.register()\ndocument.createElement('div')`)
      files.push(rel)
      weights.set(rel, i === 0 ? 11_000 : 800)
    }
    for (let i = 0; i < 6; i += 1) {
      const rel = `packages/kernel/test/n${i}.test.ts`
      touch(root, rel, `import { mkdtempSync } from 'node:fs'\nmkdtempSync('k')`)
      files.push(rel)
      weights.set(rel, i === 0 ? 18_000 : 1_200)
    }
    for (let i = 0; i < 3; i += 1) {
      const rel = `packages/kernel/test/i${i}.test.ts`
      touch(root, rel, `// @test-isolation: process\nimport test from 'node:test'\ntest('i${i}', { timeout: 60_000 }, () => {})`)
      files.push(rel)
      weights.set(rel, i === 0 ? 25_000 : 2_000)
    }

    const cachePath = path.join(root, 'node_modules', '.cache', 'purity.json')
    const schedule = planFourPoolSchedule({
      ts,
      repoRoot: root,
      files,
      workerBudget: 8,
      weightFn: (rel) => weights.get(rel) ?? 100,
      cachePath,
      useCache: true,
    })

    assert.equal(schedule.pools.pure.length, 10)
    assert.equal(schedule.pools['dom-shared'].length, 6)
    assert.equal(schedule.pools['node-shared'].length, 6)
    assert.equal(schedule.pools.isolated.length, 3)
    assert.equal(schedule.processIsolatedFiles.length, 3)

    // Every file appears exactly once across all plans
    const allPlanned = schedule.plans.flatMap((p) => p.files)
    assert.equal(allPlanned.length, files.length)
    assert.equal(new Set(allPlanned).size, files.length)

    // Zero serial pure barrier: every plan has permits=1 and heaviest shard runs first at index 0
    assert.ok(schedule.plans.every((p) => p.permits === 1), 'every shard must cost 1 permit for concurrent multi-pool execution')
    assert.equal(schedule.plans[0]?.files[0], 'packages/kernel/test/i0.test.ts')
    assert.ok(schedule.plans.some((p) => p.pool === 'pure' && p.mode === 'shard-worker'))
    assert.ok(schedule.plans.some((p) => p.pool === 'dom-shared' && p.mode === 'shard-worker'))
    assert.ok(schedule.plans.some((p) => p.pool === 'node-shared' && p.mode === 'shard-worker'))
    assert.ok(schedule.plans.some((p) => p.pool === 'isolated' && p.mode === 'isolated'))

    // Second call hits AST cache 100% without touching TypeScript
    const warm = planFourPoolSchedule({
      getTs: () => {
        throw new Error('must not load TypeScript on warm AST cache hit')
      },
      repoRoot: root,
      files,
      workerBudget: 8,
      weightFn: (rel) => weights.get(rel) ?? 100,
      cachePath,
      useCache: true,
    })
    assert.equal(warm.cacheStats.hits, files.length)
    assert.equal(warm.cacheStats.misses, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function runChildAsync(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => { stdout += String(d) })
    child.stderr?.on('data', (d) => { stderr += String(d) })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`child timed out: ${command} ${args.join(' ')}\n${stderr}\n${stdout}`))
    }, 55_000)
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

test('shard-worker: isolates bare top-level before/after/afterEach per file and records per-file timings', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'helmx-shard-worker-'))
  try {
    writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
    const orderFile = path.join(dir, 'order.log')
    const fileA = path.join(dir, 'a.test.ts')
    const fileB = path.join(dir, 'b.test.ts')
    const filePass = path.join(dir, 'pass.test.ts')
    const fileFail = path.join(dir, 'fail.test.ts')
    const fileSlow = path.join(dir, 'slow.test.ts')
    const manifestPath = path.join(dir, 'manifest.json')
    const timingPath = path.join(dir, 'timings.json')
    const failManifest = path.join(dir, 'manifest-fail.json')
    const failTiming = path.join(dir, 'timings-fail.json')
    const slowManifest = path.join(dir, 'manifest-slow.json')

    writeFileSync(
      fileA,
      `import test, { before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
const log = (s: string) => appendFileSync(${JSON.stringify(orderFile)}, s + '\\n')
before(() => log('A:before'))
afterEach(() => log('A:afterEach'))
after(() => log('A:after'))
test('A1', { timeout: 60_000 }, () => { log('A:test1'); assert.ok(true) })
`,
    )
    writeFileSync(
      fileB,
      `import test, { before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
const log = (s: string) => appendFileSync(${JSON.stringify(orderFile)}, s + '\\n')
before(() => log('B:before'))
afterEach(() => log('B:afterEach'))
after(() => log('B:after'))
test('B1', { timeout: 60_000 }, () => { log('B:test1'); assert.ok(true) })
`,
    )
    writeFileSync(
      filePass,
      `import test from 'node:test'
import assert from 'node:assert/strict'
test('P1', { timeout: 60_000 }, () => { assert.ok(true) })
`,
    )
    writeFileSync(
      fileFail,
      `import test from 'node:test'
import assert from 'node:assert/strict'
test('F1', { timeout: 60_000 }, () => { assert.equal(1, 2) })
`,
    )
    writeFileSync(
      fileSlow,
      `import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
test('S1', { timeout: 60_000 }, async () => { await delay(450) })
`,
    )
    writeFileSync(
      manifestPath,
      JSON.stringify({
        pool: 'node-shared',
        repoRoot: dir,
        files: ['a.test.ts', 'b.test.ts'],
        timingOutputPath: timingPath,
        testTimeoutMs: 20_000,
      }),
    )
    writeFileSync(
      failManifest,
      JSON.stringify({
        pool: 'pure',
        repoRoot: dir,
        files: ['fail.test.ts', 'pass.test.ts'],
        timingOutputPath: failTiming,
        testTimeoutMs: 20_000,
      }),
    )
    writeFileSync(
      slowManifest,
      JSON.stringify({ pool: 'pure', repoRoot: dir, files: ['slow.test.ts'], stallWarnMs: 150 }),
    )

    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const runTestsScript = path.join(repoRoot, 'scripts', 'run-tests.mjs')
    const [res, failRes, slowRes] = await Promise.all([
      runChildAsync(process.execPath, [runTestsScript, '--shard-worker', manifestPath], { cwd: repoRoot, env }),
      runChildAsync(process.execPath, [runTestsScript, '--shard-worker', failManifest], { cwd: repoRoot, env }),
      runChildAsync(process.execPath, [runTestsScript, '--shard-worker', slowManifest], { cwd: repoRoot, env }),
    ])

    assert.equal(res.status, 0, `shard-worker failed: stderr=${res.stderr}\nstdout=${res.stdout}`)

    // Progress diagnostics land on stderr: a boot line, then one line per file in execution order,
    // and no stall warnings on a healthy run. In CI the last "[shard-worker] file i/N" line is
    // what names the file a silently hung shard was running when run-tests.mjs killed it.
    assert.match(res.stderr, /\[shard-worker\] boot pool=node-shared files=2 pid=\d+/)
    const firstFileLine = res.stderr.indexOf('[shard-worker] file 1/2 a.test.ts')
    const secondFileLine = res.stderr.indexOf('[shard-worker] file 2/2 b.test.ts')
    assert.ok(firstFileLine > 0 && secondFileLine > firstFileLine, `progress lines missing or out of order:\n${res.stderr}`)
    assert.doesNotMatch(res.stderr, /\[shard-worker\] stall:/, 'a healthy shard must not emit stall warnings')

    const order = readFileSync(orderFile, 'utf8').trim().split('\n')
    assert.deepEqual(order, [
      'A:before',
      'A:test1',
      'A:afterEach',
      'A:after',
      'B:before',
      'B:test1',
      'B:afterEach',
      'B:after',
    ])

    const recorded = JSON.parse(readFileSync(timingPath, 'utf8')) as {
      counts: { tests: number; passed: number; failed: number }
      files: Record<string, number>
      success: boolean
    }
    assert.equal(recorded.success, true)
    assert.equal(recorded.counts.tests, 2)
    assert.equal(recorded.counts.passed, 2)
    assert.equal(recorded.counts.failed, 0)
    assert.ok((recorded.files['a.test.ts'] ?? 0) >= 1)
    assert.ok((recorded.files['b.test.ts'] ?? 0) >= 1)

    // Verify failure propagation: a failing first file exits 1 while still executing the second file
    assert.equal(failRes.status, 1, 'shard-worker must exit 1 when any file fails')
    const failRecorded = JSON.parse(readFileSync(failTiming, 'utf8')) as {
      counts: { tests: number; passed: number; failed: number }
      files: Record<string, number>
      success: boolean
    }
    assert.equal(failRecorded.success, false)
    assert.equal(failRecorded.counts.tests, 2)
    assert.equal(failRecorded.counts.passed, 1)
    assert.equal(failRecorded.counts.failed, 1)
    assert.equal(failRecorded.files['fail.test.ts'], undefined, 'failed file durations must not pollute timing cache')
    assert.ok((failRecorded.files['pass.test.ts'] ?? 0) >= 1, 'subsequent passing files still execute and record timings')

    // Stall watchdog: manifest `stallWarnMs` overrides the 120s default; a test that stays silent
    // past the window is named in a warning (repeated while stuck), and the watchdog never keeps
    // the process alive after the file completes.
    assert.equal(slowRes.status, 0, `slow shard-worker failed: stderr=${slowRes.stderr}\nstdout=${slowRes.stdout}`)
    assert.match(
      slowRes.stderr,
      /\[shard-worker\] stall: no test event for \d+ms while running file 1\/1 slow\.test\.ts \(last event: [a-z:]+\)/,
      `stall warning must name the silent file:\n${slowRes.stderr}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shard-worker: restores process.env, mock.method, console.error/warn/log, and globalThis.fetch between sequential files', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'helmx-shard-restore-'))
  try {
    writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
    const manifestPath = path.join(dir, 'manifest.json')
    writeFileSync(
      path.join(dir, 'mutator.test.ts'),
      `import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
test('mutates env, mock, console, fetch without restoring', { timeout: 60_000 }, () => {
  process.env.SHARD_RESTORE_LEAKED_KEY = 'leaked'
  process.env.SHARD_RESTORE_ORIG_KEY = 'mutated'
  delete process.env.SHARD_RESTORE_DELETED_KEY
  mock.method(Date, 'now', () => 12345)
  console.error = () => { throw new Error('leaked console.error') }
  console.warn = () => { throw new Error('leaked console.warn') }
  globalThis.fetch = (async () => new Response('leaked')) as typeof fetch
  assert.equal(Date.now(), 12345)
})
`,
    )
    writeFileSync(
      path.join(dir, 'verifier.test.ts'),
      `import test from 'node:test'
import assert from 'node:assert/strict'
test('observes clean env, Date.now, console, and fetch after prior file', { timeout: 60_000 }, () => {
  assert.equal(process.env.SHARD_RESTORE_LEAKED_KEY, undefined)
  assert.equal(process.env.SHARD_RESTORE_ORIG_KEY, 'original')
  assert.equal(process.env.SHARD_RESTORE_DELETED_KEY, 'keepme')
  assert.ok(Date.now() > 1_000_000_000_000, 'mock.restoreAll must restore Date.now')
  assert.doesNotThrow(() => console.error('ok'))
  assert.doesNotThrow(() => console.warn('ok'))
  assert.equal(globalThis.fetch.name, 'fetch')
})
`,
    )
    writeFileSync(
      manifestPath,
      JSON.stringify({
        pool: 'node-shared',
        repoRoot: dir,
        files: ['mutator.test.ts', 'verifier.test.ts'],
        testTimeoutMs: 20_000,
      }),
    )

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SHARD_RESTORE_ORIG_KEY: 'original',
      SHARD_RESTORE_DELETED_KEY: 'keepme',
    }
    delete env.NODE_TEST_CONTEXT
    const res = await runChildAsync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'run-tests.mjs'), '--skip-cache-hygiene', '--shard-worker', manifestPath],
      { cwd: repoRoot, env },
    )
    assert.equal(res.status, 0, `shard-worker restore test failed:\n${res.stderr}\n${res.stdout}`)

    // Also verify dom-shard-preload restores console.error/warn and globalThis.Notification (descriptor-preserving)
    const domManifestPath = path.join(dir, 'dom-manifest.json')
    writeFileSync(
      path.join(dir, 'dom-mutator.test.ts'),
      `import test from 'node:test'
import assert from 'node:assert/strict'
test('mutates Notification, console.error/warn, and DOM without restoring', { timeout: 60_000 }, () => {
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    writable: true,
    enumerable: true,
    value: class FakeNotification {},
  })
  console.error = () => { throw new Error('leaked dom console.error') }
  console.warn = () => { throw new Error('leaked dom console.warn') }
  document.body.innerHTML = '<div id="leaked">dirty</div>'
  assert.ok('Notification' in globalThis)
})
`,
    )
    writeFileSync(
      path.join(dir, 'dom-verifier.test.ts'),
      `import test from 'node:test'
import assert from 'node:assert/strict'
test('observes clean Notification descriptor, console, and DOM after prior file', { timeout: 60_000 }, () => {
  assert.equal(Object.getOwnPropertyDescriptor(globalThis, 'Notification'), undefined)
  assert.equal(document.body.innerHTML, '')
  assert.doesNotThrow(() => console.error('ok'))
  assert.doesNotThrow(() => console.warn('ok'))
})
`,
    )
    writeFileSync(
      domManifestPath,
      JSON.stringify({
        pool: 'dom-shared',
        repoRoot: dir,
        files: ['dom-mutator.test.ts', 'dom-verifier.test.ts'],
        testTimeoutMs: 20_000,
      }),
    )
    const domRes = await runChildAsync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'run-tests.mjs'), '--skip-cache-hygiene', '--dom-preload', '--shard-worker', domManifestPath],
      { cwd: repoRoot, env },
    )
    assert.equal(domRes.status, 0, `dom-shard-preload restore test failed:\n${domRes.stderr}\n${domRes.stdout}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tsx-cache-hygiene: prunes bloated hash cache entries above threshold while preserving .pipe sockets', { timeout: 60_000 }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'helmx-tsx-hygiene-'))
  try {
    const hashNames = ['100-aaaa1111', '200-bbbb2222', '300-cccc3333', '400-dddd4444', '500-eeee5555']
    for (const name of hashNames) {
      writeFileSync(path.join(dir, name), name)
    }
    writeFileSync(path.join(dir, '99999.pipe'), 'sock')
    writeFileSync(path.join(dir, 'keep-note.txt'), 'keep')

    // Missing directory: returns zeroes without throwing
    const missing = pruneTsxCacheIfBloated({ cacheDir: path.join(dir, 'nonexistent'), maxEntries: 5 })
    assert.equal(missing.total, 0)
    assert.equal(missing.pruned, 0)

    // At or below threshold: no-op
    const noop = pruneTsxCacheIfBloated({ cacheDir: dir, maxEntries: 5 })
    assert.equal(noop.total, 5)
    assert.equal(noop.pruned, 0)
    for (const name of hashNames) {
      assert.equal(existsSync(path.join(dir, name)), true)
    }

    // Above threshold: unlinks matching hash entries, preserves .pipe sockets and non-hash files
    const pruned = pruneTsxCacheIfBloated({ cacheDir: dir, maxEntries: 3 })
    assert.equal(pruned.total, 5)
    assert.equal(pruned.pruned, 5)
    for (const name of hashNames) {
      assert.equal(existsSync(path.join(dir, name)), false)
    }
    assert.equal(existsSync(path.join(dir, '99999.pipe')), true)
    assert.equal(existsSync(path.join(dir, 'keep-note.txt')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shard-worker: ipcQueue mode pulls files dynamically over IPC and records per-file timings', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'helmx-shard-ipc-'))
  try {
    writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
    const orderFile = path.join(dir, 'ipc-order.log')
    const manifestPath = path.join(dir, 'manifest-ipc.json')
    const timingPath = path.join(dir, 'timings-ipc.json')
    writeFileSync(
      path.join(dir, 'q1.test.ts'),
      `import test from 'node:test'
import { appendFileSync } from 'node:fs'
test('Q1', { timeout: 60_000 }, () => { appendFileSync(${JSON.stringify(orderFile)}, 'q1\\n') })
`,
    )
    writeFileSync(
      path.join(dir, 'q2.test.ts'),
      `import test from 'node:test'
import { appendFileSync } from 'node:fs'
test('Q2', { timeout: 60_000 }, () => { appendFileSync(${JSON.stringify(orderFile)}, 'q2\\n') })
`,
    )
    writeFileSync(
      manifestPath,
      JSON.stringify({
        pool: 'node-shared',
        repoRoot: dir,
        ipcQueue: true,
        timingOutputPath: timingPath,
        testTimeoutMs: 20_000,
      }),
    )

    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const runTestsScript = path.join(repoRoot, 'scripts', 'run-tests.mjs')
    const queue = ['q1.test.ts', 'q2.test.ts']
    let cursor = 0
    const res = await new Promise<{ status: number | null; stderr: string; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [runTestsScript, '--skip-cache-hygiene', '--shard-worker', manifestPath], {
        cwd: repoRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d) => { stdout += String(d) })
      child.stderr?.on('data', (d) => { stderr += String(d) })
      child.on('message', (msg: unknown) => {
        if (!msg || typeof msg !== 'object' || (msg as { type?: string }).type !== 'next' || !child.connected) return
        if (cursor < queue.length) {
          const file = queue[cursor++]!
          child.send({ type: 'run', file, index: cursor, total: queue.length })
        } else {
          child.send({ type: 'done' })
        }
      })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`ipcQueue shard-worker timed out\n${stderr}\n${stdout}`))
      }, 55_000)
      child.once('error', (err) => { clearTimeout(timer); reject(err) })
      child.once('close', (status) => { clearTimeout(timer); resolve({ status, stderr, stdout }) })
    })

    assert.equal(res.status, 0, `ipcQueue shard-worker failed:\n${res.stderr}\n${res.stdout}`)
    assert.match(res.stderr, /\[shard-worker\] boot pool=node-shared mode=ipc pid=\d+/)
    assert.deepEqual(readFileSync(orderFile, 'utf8').trim().split('\n'), ['q1', 'q2'])
    const recorded = JSON.parse(readFileSync(timingPath, 'utf8')) as {
      counts: { tests: number; passed: number; failed: number }
      files: Record<string, number>
      success: boolean
    }
    assert.equal(recorded.success, true)
    assert.equal(recorded.counts.tests, 2)
    assert.equal(recorded.counts.passed, 2)
    assert.equal(recorded.counts.failed, 0)
    assert.ok((recorded.files['q1.test.ts'] ?? 0) >= 1)
    assert.ok((recorded.files['q2.test.ts'] ?? 0) >= 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('test-suites: any pass-through extraArgs falls back to native tsx --test instead of silently dropping flags in shard-worker', { timeout: 60_000 }, () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const res = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'test-suites.mjs'), 'unit', '--bogus-unknown-runner-flag'],
    { cwd: repoRoot, env, encoding: 'utf8', timeout: 60_000 },
  )
  assert.notEqual(res.status, 0, 'invalid pass-through CLI flag must fail instead of being dropped')
  assert.ok(
    !res.stderr.includes('concurrent shards'),
    `expected native single-runner fallback when extraArgs is non-empty; stderr=${res.stderr}`,
  )
})

test('scripts/build.mjs: parseBuildArgs & planBuildStages cover full, --skip-payload, --for-typecheck, --unit-deps, --force, and CLI exit 2', { timeout: 60_000 }, () => {
  assert.deepEqual(parseBuildArgs([], {}), { mode: 'full', force: false, quiet: false })
  assert.deepEqual(parseBuildArgs(['--', '--skip-payload', '-f', '-q'], {}), {
    mode: 'skip-payload',
    force: true,
    quiet: true,
  })
  assert.deepEqual(parseBuildArgs([], { HELMX_CLEAN_DIST: '1' }), { mode: 'full', force: true, quiet: false })
  assert.throws(() => parseBuildArgs(['--skip-payload', '--unit-deps'], {}), BuildArgError)
  assert.throws(() => parseBuildArgs(['--bogus'], {}), BuildArgError)

  const fullPlan = planBuildStages({ repoRoot, execPath: '/node', tscBin: '/tsc.js', mode: 'full', force: true })
  assert.deepEqual(fullPlan.cleanPackages, ['protocol', 'env-io', 'node', 'plugin-build', 'kernel', 'plugins', 'hub', 'cli'])
  assert.deepEqual(fullPlan.tscCommand.args, ['/tsc.js', '-b', 'tsconfig.build.json', '--force'])
  assert.ok(fullPlan.webCommand && fullPlan.webCommand.args.includes('--force'))
  assert.deepEqual(fullPlan.postTscCommands.map((c) => c.label), ['copy-plugin-clients', 'generate-sdk-types'])
  assert.ok(fullPlan.payloadCommand && fullPlan.payloadCommand.args.includes('--force'))

  const skipPayloadPlan = planBuildStages({ repoRoot, execPath: '/node', tscBin: '/tsc.js', mode: 'skip-payload' })
  assert.equal(skipPayloadPlan.payloadCommand, null)
  assert.ok(skipPayloadPlan.webCommand)
  assert.deepEqual(skipPayloadPlan.postTscCommands.map((c) => c.label), ['copy-plugin-clients', 'generate-sdk-types'])

  const typecheckPlan = planBuildStages({ repoRoot, execPath: '/node', tscBin: '/tsc.js', mode: 'for-typecheck' })
  assert.deepEqual(typecheckPlan.cleanPackages, ['protocol', 'env-io', 'node', 'plugin-build', 'kernel', 'plugins', 'hub'])
  assert.equal(typecheckPlan.cleanPackages.includes('cli'), false, 'for-typecheck must not touch cli/dist/sdk-types-snapshot.js')
  assert.deepEqual(typecheckPlan.tscCommand.args, ['/tsc.js', '-b', 'packages/hub', 'packages/node'])
  assert.equal(typecheckPlan.webCommand, null)
  assert.equal(typecheckPlan.postTscCommands.length, 1)
  assert.equal(typecheckPlan.payloadCommand, null)

  const unitPlan = planBuildStages({ repoRoot, execPath: '/node', tscBin: '/tsc.js', mode: 'unit-deps' })
  assert.deepEqual(unitPlan.cleanPackages, ['protocol', 'env-io', 'plugin-build', 'kernel'])
  assert.deepEqual(unitPlan.tscCommand.args, ['/tsc.js', '-b', 'packages/plugin-build', 'packages/kernel'])
  assert.equal(unitPlan.webCommand, null)
  assert.equal(unitPlan.postTscCommands.length, 0)
  assert.equal(unitPlan.payloadCommand, null)

  const cliErr = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build.mjs'), '--unknown-flag'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.equal(cliErr.status, 2)
  assert.ok(cliErr.stderr.includes('Unknown argument'))
  assert.ok(buildUsageText().includes('--for-typecheck'))
})

test('scripts/typecheck.mjs & scripts/verify.mjs: TYPECHECK_TARGETS, parseVerifyArgs, planVerifyStages, and CLI exit 2', { timeout: 60_000 }, () => {
  assert.deepEqual(
    TYPECHECK_TARGETS.map((t) => t.project),
    [
      'tsconfig.check.json',
      'packages/plugin-client/tsconfig.json',
      'packages/plugins/tsconfig.client.json',
      'packages/web/tsconfig.json',
      'packages/web/tsconfig.test.json',
    ],
  )

  assert.deepEqual(parseVerifyArgs([], {}), { force: false, skipTests: false, quiet: false })
  assert.deepEqual(parseVerifyArgs(['--', '-f', '--skip-tests', '-q'], {}), {
    force: true,
    skipTests: true,
    quiet: true,
  })
  assert.deepEqual(parseVerifyArgs([], { HELMX_CLEAN_DIST: '1' }), { force: true, skipTests: false, quiet: false })
  assert.throws(() => parseVerifyArgs(['--bogus'], {}), VerifyArgError)

  const fullVerify = planVerifyStages({ repoRoot, execPath: '/node', tscBin: '/tsc.js', oxlintBin: '/oxlint', force: true })
  assert.equal(fullVerify.buildPlan.mode, 'full')
  assert.equal(fullVerify.buildPlan.force, true)
  assert.deepEqual(fullVerify.lintCommand.args, ['/oxlint'])
  assert.deepEqual(fullVerify.hygieneCommand.args, [path.join(repoRoot, 'scripts', 'check-test-hygiene.mjs')])
  assert.deepEqual(fullVerify.testsCommand?.args, [path.join(repoRoot, 'scripts', 'test-suites.mjs'), 'all'])

  const skipVerify = planVerifyStages({ repoRoot, execPath: '/node', tscBin: '/tsc.js', oxlintBin: '/oxlint', skipTests: true })
  assert.equal(skipVerify.testsCommand, null)

  const cliErr = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'verify.mjs'), '--unknown-flag'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.equal(cliErr.status, 2)
  assert.ok(cliErr.stderr.includes('Unknown argument'))
  assert.ok(verifyUsageText().includes('--skip-tests'))
})
