/**
 * Unit tests for scripts/check-changed.mjs and scripts/check-test-hygiene.mjs (including scripts/lib/*).
 *
 * Covers changeset collection (multi-commit + dirty worktree + untracked + deletions + renames +
 * paths with spaces + baseline resolution precedence and missing-baseline rejection), affected package
 * reverse closure and full-tier triggers, hygiene AST analysis (default/named/aliased/namespace imports,
 * multiline options, shared const options, describe timeout inheritance, skip reasons, todo exemption,
 * HELMX_TEST_SUITE_TIMEOUT_MS assignment), CLI exit code propagation (including missing executables),
 * child process-tree signal forwarding without orphan processes, PACKAGE_TIERS / test-suites.mjs
 * SUITES mirror synchronization, and the CSS :hover media gate scanner (scripts/lib/css-hygiene.mjs).
 *
 * Runner: node:test; every test sets an explicit timeout: 60_000.
 */
import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as ts from 'typescript'
import {
  GitChangeError,
  collectChangedFiles,
  parseNameStatusZ,
  resolveBaseline,
} from '../../../scripts/lib/git-changes.mjs'
import {
  PACKAGE_TIERS,
  classifyChange,
  computeAffectedPackages,
  loadWorkspacePackages,
  planCheckCommands,
  testFilesOfPackage,
} from '../../../scripts/lib/workspace-meta.mjs'
import {
  analyzeTestSource,
  isCrossPackageTestHelperImport,
  parseTestSourceFile,
  resolveInRepoRelativePath,
} from '../../../scripts/lib/test-hygiene.mjs'
import { resolvePackageManagerInvoke, runManagedCommand } from '../../../scripts/lib/spawn-checked.mjs'
import { collectSourceCssFiles, findUngatedHoverRules } from '../../../scripts/lib/css-hygiene.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const scriptsDir = path.join(repoRoot, 'scripts')

// ---------------------------------------------------------------- git fixture

function git(dir: string, ...args: string[]): void {
  const res = spawnSync('git', ['-c', 'user.email=dev@example.com', '-c', 'user.name=dev', ...args], {
    cwd: dir,
    encoding: 'utf8',
  })
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`)
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

let cachedTemplateRepo: string | undefined

function getTemplateRepo(): string {
  if (cachedTemplateRepo) return cachedTemplateRepo
  const dir = mkdtempSync(path.join(tmpdir(), 'helmx-check-changed-tpl-'))
  git(dir, 'init', '-b', 'main')
  write(dir, 'base.txt', 'v1')
  write(dir, 'space dir/f.txt', 'v1')
  write(dir, 'src/one.ts', 'export const one = 1')
  write(dir, 'old.txt', 'bye')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'c0')
  write(dir, 'base.txt', 'v2')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'c1')
  git(dir, 'mv', 'src/one.ts', 'src/two renamed.ts')
  git(dir, 'rm', '-q', 'old.txt')
  git(dir, 'commit', '-m', 'c2: rename + delete')
  // Worktree: unstaged edit + staged add + untracked, all with spaces in paths.
  write(dir, 'space dir/f.txt', 'v2')
  write(dir, 'staged file.ts', 's')
  git(dir, 'add', 'staged file.ts')
  write(dir, 'untracked file.ts', 'u')
  cachedTemplateRepo = dir
  return dir
}

after(() => {
  if (cachedTemplateRepo) {
    rmSync(cachedTemplateRepo, { recursive: true, force: true })
    cachedTemplateRepo = undefined
  }
})

/** Complete fixture combining multi-commit + dirty worktree + untracked + deletions + renames + space paths (cloned from cached template repo). */
function makeFixtureRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'helmx-check-changed-'))
  cpSync(getTemplateRepo(), dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------- changeset collection

test('changeset: committed U worktree U untracked, recording both sides of renames + deletions + paths with spaces', { timeout: 60_000 }, () => {
  const dir = makeFixtureRepo()
  try {
    const { baseline, files } = collectChangedFiles({ base: 'HEAD~2', cwd: dir })
    assert.equal(baseline.kind, 'explicit')
    assert.equal(baseline.ref, 'HEAD~2')
    const byPath = new Map(files.map((f) => [f.path, f]))
    // Committed (cumulative across two commits): edits, both old and new paths of renames, deletions.
    assert.equal(byPath.get('base.txt')?.origin, 'committed')
    assert.ok(byPath.has('src/one.ts'), 'old path of rename must be included')
    assert.ok(byPath.has('src/two renamed.ts'), 'new path of rename (with spaces) must be included')
    assert.ok(byPath.get('src/two renamed.ts')?.status.startsWith('R'), 'rename status starts with R')
    assert.equal(byPath.get('old.txt')?.origin, 'committed')
    assert.equal(byPath.get('old.txt')?.status, 'D')
    // Worktree: both staged and unstaged changes carry origin "worktree".
    assert.equal(byPath.get('space dir/f.txt')?.origin, 'worktree')
    assert.equal(byPath.get('staged file.ts')?.origin, 'worktree')
    // Untracked.
    assert.equal(byPath.get('untracked file.ts')?.origin, 'untracked')
    assert.equal(files.filter((f) => f.origin === 'committed').length, 4)
    assert.equal(files.filter((f) => f.origin === 'untracked').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('baseline resolution: upstream takes precedence over origin/HEAD; errors explicitly when none exists instead of falling back to HEAD~1', { timeout: 60_000 }, () => {
  const dir = makeFixtureRepo()
  try {
    // Initial repo without remotes: no default baseline -> resolveBaseline returns none and collect errors mentioning --base.
    assert.deepEqual(resolveBaseline({ cwd: dir }), { kind: 'none', ref: null, mergeBase: null })
    assert.throws(() => collectChangedFiles({ cwd: dir }), (e: unknown) => {
      assert.ok(e instanceof GitChangeError)
      assert.ok(e.message.includes('--base'), 'error message must mention --base')
      return true
    })

    // Once upstream points to c1: merge-base = c1, so c1..HEAD includes c2 changes and excludes c1 itself.
    const c1 = spawnSync('git', ['rev-parse', 'HEAD~1'], { cwd: dir, encoding: 'utf8' })
    git(dir, 'update-ref', 'refs/remotes/origin/main', (c1.stdout ?? '').trim())
    git(dir, 'config', 'remote.origin.url', 'https://example.com/probe.git')
    git(dir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
    git(dir, 'config', 'branch.main.remote', 'origin')
    git(dir, 'config', 'branch.main.merge', 'refs/heads/main')
    const { baseline, files } = collectChangedFiles({ cwd: dir })
    assert.equal(baseline.kind, 'upstream')
    assert.equal(baseline.ref, 'refs/remotes/origin/main')
    assert.equal(baseline.mergeBase, (c1.stdout ?? '').trim())
    const paths = files.map((f) => f.path)
    assert.ok(!paths.includes('base.txt'), 'commits before merge-base must be excluded')
    assert.ok(paths.includes('old.txt'), 'deletions after merge-base must be included')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseNameStatusZ: splits -z stream by NUL and expands both sides of renames/copies', { timeout: 60_000 }, () => {
  const raw = ['M\0a.txt\0', 'R100\0new dir/two.ts\0old dir/one.ts\0', 'D\0gone.ts\0'].join('')
  assert.deepEqual(parseNameStatusZ(raw), [
    { path: 'a.txt', status: 'M' },
    { path: 'new dir/two.ts', status: 'R100' },
    { path: 'old dir/one.ts', status: 'R100' },
    { path: 'gone.ts', status: 'D' },
  ])
})

// ---------------------------------------------------------------- affected package selection

/** Synthetic workspace graph mirroring the real repo topology (including transitive chains). */
const SYNTH_PKGS = [
  { name: '@helmx/protocol', dir: 'protocol', workspaceDeps: [] },
  { name: '@helmx/kernel', dir: 'kernel', workspaceDeps: ['@helmx/protocol', '@helmx/node'] },
  { name: '@helmx/plugins', dir: 'plugins', workspaceDeps: ['@helmx/protocol', '@helmx/kernel'] },
  { name: '@helmx/hub', dir: 'hub', workspaceDeps: ['@helmx/protocol', '@helmx/kernel', '@helmx/plugins'] },
  { name: '@helmx/node', dir: 'node', workspaceDeps: ['@helmx/protocol'] },
  { name: '@helmx/cli', dir: 'cli', workspaceDeps: ['@helmx/protocol'] },
  { name: '@helmx/web', dir: 'web', workspaceDeps: ['@helmx/protocol'] },
  { name: '@helmx/payload', dir: 'payload', workspaceDeps: ['@helmx/cli', '@helmx/kernel', '@helmx/plugins', '@helmx/hub', '@helmx/web'] },
]

test('dependency closure: protocol changes fan out to all consumers; node changes propagate through kernel to hub/payload', { timeout: 60_000 }, () => {
  const r1 = computeAffectedPackages(['packages/protocol/src/index.ts'], SYNTH_PKGS)
  assert.deepEqual([...r1.affected].sort(), ['cli', 'hub', 'kernel', 'node', 'payload', 'plugins', 'protocol', 'web'])

  const r2 = computeAffectedPackages(['packages/node/src/cli.ts'], SYNTH_PKGS)
  assert.deepEqual([...r2.affected].sort(), ['hub', 'kernel', 'node', 'payload', 'plugins'])
})

test('test-only changes select only that package; non-test package files (including test helpers) trigger closure; root configs trigger full tier', { timeout: 60_000 }, () => {
  const t1 = computeAffectedPackages(['packages/kernel/test/foo.test.ts'], SYNTH_PKGS)
  assert.deepEqual([...t1.affected], ['kernel'])
  assert.equal(t1.fullTier, false)

  // Non-*.test.ts helper files under test/ are treated as source changes (preserving closure: kernel -> plugins/hub -> payload).
  const t2 = computeAffectedPackages(['packages/kernel/test/helpers.ts'], SYNTH_PKGS)
  assert.deepEqual([...t2.affected].sort(), ['hub', 'kernel', 'payload', 'plugins'])

  const t3 = computeAffectedPackages(['pnpm-lock.yaml'], SYNTH_PKGS)
  assert.equal(t3.fullTier, true)
  assert.equal(t3.affected.size, 8)

  // Modifying the gate implementation itself (scripts source) also triggers full tier instead of skipping checks.
  const t5 = computeAffectedPackages(['scripts/lib/spawn-checked.mjs'], SYNTH_PKGS)
  assert.equal(t5.fullTier, true)
  assert.equal(t5.affected.size, 8)

  const t4 = computeAffectedPackages(['docs/foo.md', 'AGENTS.md'], SYNTH_PKGS)
  assert.equal(t4.affected.size, 0)
  assert.deepEqual(t4.outside, ['AGENTS.md', 'docs/foo.md'])
})

test('classifyChange: file classification and boundaries (scripts source triggers full tier, docs-only does not trigger)', { timeout: 60_000 }, () => {
  assert.deepEqual(classifyChange('packages/kernel/src/a.ts'), { pkg: 'kernel', kind: 'source' })
  assert.deepEqual(classifyChange('packages/kernel/test/a.test.ts'), { pkg: 'kernel', kind: 'test' })
  assert.deepEqual(classifyChange('packages/web/test/a.test.tsx'), { pkg: 'web', kind: 'test' })
  assert.deepEqual(classifyChange('packages/kernel/tsconfig.json'), { pkg: 'kernel', kind: 'source' })
  assert.deepEqual(classifyChange('docs/x.md'), { pkg: null, kind: 'outside' })
  assert.deepEqual(classifyChange('scripts/run-tests.mjs'), { pkg: null, kind: 'root-trigger' })
  assert.deepEqual(classifyChange('scripts/check-changed.mjs'), { pkg: null, kind: 'root-trigger' })
  assert.deepEqual(classifyChange('scripts/lib/git-changes.mjs'), { pkg: null, kind: 'root-trigger' })
  assert.deepEqual(classifyChange('scripts/README-herdr-smoke.md'), { pkg: null, kind: 'outside' })
  assert.deepEqual(classifyChange('tsconfig.build.json'), { pkg: null, kind: 'root-trigger' })
  assert.deepEqual(classifyChange('tsconfig.check.json'), { pkg: null, kind: 'root-trigger' })
  assert.deepEqual(classifyChange('tsconfig.dev.json'), { pkg: null, kind: 'root-trigger' })
  assert.deepEqual(classifyChange('.oxlintrc.json'), { pkg: null, kind: 'root-trigger' })
  assert.deepEqual(classifyChange('tsconfig.json'), { pkg: null, kind: 'outside' })
})

test('PACKAGE_TIERS mirrors test-suites.mjs SUITES; all workspace packages have a tier', { timeout: 60_000 }, () => {
  const src = readFileSync(path.join(scriptsDir, 'test-suites.mjs'), 'utf8')
  const unitMatch = /unit:\s*\[([^\]]*)\]/.exec(src)
  const integrationMatch = /integration:\s*\[([^\]]*)\]/.exec(src)
  assert.ok(unitMatch && integrationMatch, 'test-suites.mjs SUITES structure changed; update parser')
  const names = (s: string) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '')
  const expected: Record<string, string> = {}
  for (const n of names(unitMatch?.[1] ?? '')) expected[n] = 'unit'
  for (const n of names(integrationMatch?.[1] ?? '')) expected[n] = 'integration'
  assert.deepEqual(PACKAGE_TIERS, expected, 'changing test-suites.mjs tiers must keep workspace-meta.mjs PACKAGE_TIERS in sync')

  for (const p of loadWorkspacePackages(repoRoot)) {
    assert.ok(PACKAGE_TIERS[p.dir], `new package ${p.dir} missing tier; update PACKAGE_TIERS and SUITES`)
  }
  assert.ok(testFilesOfPackage(repoRoot, 'cli').some((f) => f.endsWith('.test.ts')))
})

test('planCheckCommands: pre-runs check-hygiene, routes tests through test-suites --files, and builds cli/web when needed', { timeout: 60_000 }, () => {
  const pm = { cmd: 'node', args: ['/pnpm/bin/pnpm.cjs'] }
  const withTests = planCheckCommands({
    affectedDirs: ['kernel'],
    testFiles: ['packages/kernel/test/http.test.ts'],
    pm,
    execPath: '/node',
    repoRoot: '/repo',
  })
  assert.equal(withTests.length, 3)
  assert.equal(withTests[0]?.cmd, '/node')
  assert.deepEqual(withTests[0]?.args, [
    path.join('/repo', 'scripts', 'check-test-hygiene.mjs'),
    '--files',
    'packages/kernel/test/http.test.ts',
  ])
  assert.deepEqual(withTests[1]?.args, ['/pnpm/bin/pnpm.cjs', 'typecheck'])
  assert.deepEqual(withTests[2]?.args, [
    path.join('/repo', 'scripts', 'test-suites.mjs'),
    '--files',
    'packages/kernel/test/http.test.ts',
  ])

  const withCliAndWeb = planCheckCommands({
    affectedDirs: ['cli', 'payload'],
    testFiles: ['packages/cli/test/cli.test.ts', 'packages/payload/test/payload.test.ts'],
    pm,
    execPath: '/node',
    repoRoot: '/repo',
  })
  assert.equal(withCliAndWeb.length, 4)
  assert.deepEqual(withCliAndWeb[2]?.args, [
    '/pnpm/bin/pnpm.cjs',
    '--filter',
    '@helmx/cli',
    '--filter',
    '@helmx/web',
    'run',
    'build',
  ])
  assert.deepEqual(withCliAndWeb[3]?.args, [
    path.join('/repo', 'scripts', 'test-suites.mjs'),
    '--files',
    'packages/cli/test/cli.test.ts',
    'packages/payload/test/payload.test.ts',
  ])

  const none = planCheckCommands({ affectedDirs: [], testFiles: [], pm, execPath: '/node', repoRoot: '/repo' })
  assert.equal(none.length, 0)
})

// ---------------------------------------------------------------- hygiene AST

function rulesOf(source: string): string[] {
  return analyzeTestSource(ts, 'sample.test.ts', source).violations.map((v) => v.rule)
}

test('hygiene: timeout checks for named/default/aliased/namespace imports and multiline options', { timeout: 60_000 }, () => {
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('a', { timeout: 60_000 }, () => {})
test('b', () => {})`), ['timeout-missing'])

  assert.deepEqual(rulesOf(`import { it } from 'node:test'
it('a', () => {})`), ['timeout-missing'])

  // as alias: still recognizes managed calls when original export name is test/it.
  assert.deepEqual(rulesOf(`import { test as it, describe as d } from 'node:test'
it('ok', { timeout: 60_000 }, () => {})
it('bad', () => {})`), ['timeout-missing'])

  // Namespace import.
  assert.deepEqual(rulesOf(`import * as nt from 'node:test'
nt.test('ok', { timeout: 60_000 }, () => {})
nt.it('bad', () => {})`), ['timeout-missing'])

  // Multiline options: AST handles formatting reliably unlike single-line regexes.
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('multi', {
  timeout: 60_000,
}, async () => {})`), [])

  // Shared const options object (including `as const` assertion).
  assert.deepEqual(rulesOf(`import test from 'node:test'
const opts = { timeout: 60_000 } as const
test('shared', opts, () => {})`), [])

  // 2-arg call with callback identifier must NOT treat callback identifier at args[1] as options
  const twoArgFnSrc = `import test from 'node:test'\nconst fn = () => {}\ntest('bad-ident-cb', fn)\n`
  const sharedSf = parseTestSourceFile(ts, 'sample.test.ts', twoArgFnSrc)
  assert.deepEqual(analyzeTestSource(ts, 'sample.test.ts', twoArgFnSrc, sharedSf).violations.map((v) => v.rule), ['timeout-missing'])

  // 3-arg call with imported/unresolved options identifier at args[1] still counts as options
  assert.deepEqual(rulesOf(`import test from 'node:test'
import { externalOpts } from './opts.js'
const fn = () => {}
test('ok-3arg', externalOpts, fn)`), [])
})

test('hygiene: describe timeout propagates to child tests per node:test semantics', { timeout: 60_000 }, () => {
  assert.deepEqual(rulesOf(`import { describe, it } from 'node:test'
describe('d', { timeout: 60_000 }, () => {
  it('inherits', () => {})
})`), [])
  assert.deepEqual(rulesOf(`import { describe, it } from 'node:test'
describe('d', () => {
  it('no-timeout', () => {})
})`), ['timeout-missing'])
})

test('hygiene: skip requires a reason; unconditional skip exempts timeout; conditional skip still requires timeout', { timeout: 60_000 }, () => {
  // { skip: true }: missing reason; unconditional skip does not also trigger timeout-missing.
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('s', { timeout: 60_000, skip: true }, () => {})`), ['skip-without-reason'])
  // Conditional skip (can evaluate to false): still runs -> missing timeout triggers violation.
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('c', { skip: process.platform === 'win32' ? 'unsupported on Windows' : false }, () => {})`), [
    'timeout-missing',
  ])
  // Conditional skip with timeout: clean.
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('c2', { timeout: 60_000, skip: process.env.X !== '1' ? 'requires X=1' : false }, () => {})`), [])
  // Unconditional skip with reason: never executes, no timeout needed.
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('s2', { skip: 'environment not provisioned' }, () => {})`), [])
  // test.skip shorthand without reason.
  assert.deepEqual(rulesOf(`import test from 'node:test'
test.skip('s3', () => {})`), ['skip-without-reason'])
  assert.deepEqual(rulesOf(`import test from 'node:test'
test.skip('s4', { skip: 'reason' }, () => {})`), [])
  // Non-static skip expression cannot be verified -> flagged as violation.
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('s5', { timeout: 60_000, skip: someFlag }, () => {})`), ['skip-without-reason'])
})

test('hygiene: todo exempts timeout; t.test counts subtests separately; suite timeout env assignment flagged', { timeout: 60_000 }, () => {
  const report = analyzeTestSource(
    ts,
    'sample.test.ts',
    `import test from 'node:test'
test.todo('t')
test('outer', { timeout: 60_000 }, async (t) => {
  await t.test('sub', () => {})
})
process.env.HELMX_TEST_SUITE_TIMEOUT_MS = '999'`,
  )
  assert.deepEqual(report.violations.map((v) => v.rule), ['suite-timeout-env'])
  assert.equal(report.stats.todoCalls, 1)
  assert.equal(report.stats.subtestCalls, 1)
  assert.equal(report.stats.testCalls, 1)
})

test('hygiene: teardown hooks must declare their own timeout because test timeouts do not cover hooks', { timeout: 60_000 }, () => {
  // TestContext form inside a test callback: awaiting close()/dispose() without a hook timeout is flagged;
  // the hook timeout option or a shared const options object clears it.
  const ctxSrc = (hookCall: string) => `import test from 'node:test'
const hookOpts = { timeout: 60_000 } as const
test('outer', { timeout: 60_000 }, async (t) => {
  ${hookCall}
})`
  assert.deepEqual(rulesOf(ctxSrc(`await t.after(async () => { await kernel.close() })`)), ['hook-timeout-missing'])
  assert.deepEqual(rulesOf(ctxSrc(`t.after(async () => { await kernel.close() }, { timeout: 60_000 })`)), [])
  assert.deepEqual(rulesOf(ctxSrc(`t.after(async () => { await kernel.close() }, hookOpts)`)), [])
  // Nested arrows and non-await call positions still count as teardown; a sync no-teardown hook does not.
  assert.deepEqual(rulesOf(ctxSrc(`t.after(() => Promise.all(kernels.map(async (k) => { await k.dispose() })))`)), ['hook-timeout-missing'])
  assert.deepEqual(rulesOf(ctxSrc(`t.after(() => { resetHappyDom() })`)), [])
  // TestContext alias is resolved structurally from the callback parameter, not by guessing `t`.
  assert.deepEqual(
    rulesOf(`import { it } from 'node:test'
it('outer', { timeout: 60_000 }, async (ctx) => {
  ctx.after(async () => { env.stop() })
})`),
    ['hook-timeout-missing'],
  )
  // A hook callback passed by identifier is statically opaque: not flagged (no false positive).
  assert.deepEqual(rulesOf(ctxSrc(`t.after(cleanup)`)), [])
  // Unrelated `.after(...)` on an arbitrary object is not a node:test hook.
  assert.deepEqual(
    rulesOf(`import test from 'node:test'
test('outer', { timeout: 60_000 }, () => {
  router.after(async () => { pool.close() })
})`),
    [],
  )

  // Named imports (after/afterEach/beforeEach/before), namespace import and default-import `test.after`.
  const named = `import { after, afterEach, beforeEach } from 'node:test'
const opts = { timeout: 60_000 } as const
after(async () => { await app.close() })
afterEach(() => servers.map((s) => s.disconnect()))
beforeEach('seed', opts, async () => { await seed.stop() })
before(async () => { await pool.terminate() })`
  const namedReport = analyzeTestSource(ts, 'sample.test.ts', `import { before } from 'node:test'\n${named}`)
  assert.deepEqual(namedReport.violations.map((v) => v.rule), ['hook-timeout-missing', 'hook-timeout-missing', 'hook-timeout-missing'])
  assert.equal(namedReport.stats.hookCalls, 4)
  assert.deepEqual(
    rulesOf(`import * as nt from 'node:test'
nt.after(async () => { await app.close() }, { timeout: 60_000 })
nt.afterEach(async () => { await app.close() })`),
    ['hook-timeout-missing'],
  )
  assert.deepEqual(
    rulesOf(`import test from 'node:test'
test.after(async () => { await app.close() }, { timeout: 60_000 })
test.before(async () => { await app.close() })`),
    ['hook-timeout-missing'],
  )
  // Name-first signature: options sit in the second slot.
  assert.deepEqual(rulesOf(`import { after } from 'node:test'
after('cleanup', { timeout: 60_000 }, async () => { await app.close() })
after('cleanup', async () => { await app.close() })`), ['hook-timeout-missing'])
  // Unresolvable options identifier is not silently accepted as a timeout.
  assert.deepEqual(rulesOf(`import { after } from 'node:test'
import { externalOpts } from './opts.js'
after(async () => { await app.close() }, externalOpts)`), ['hook-timeout-missing'])
})

test('hygiene: Windows backslash paths normalize to POSIX repo-relative paths and still detect cross-package helpers', { timeout: 60_000 }, () => {
  const winRepo = 'D:\\a\\helmx\\helmx'
  assert.equal(
    resolveInRepoRelativePath(winRepo, 'D:\\a\\helmx\\helmx\\packages\\web\\test\\.helmx-hygiene-gate-fixture\\new.test.ts', winRepo, path.win32),
    'packages/web/test/.helmx-hygiene-gate-fixture/new.test.ts',
  )
  assert.equal(
    resolveInRepoRelativePath(winRepo, 'd:\\a\\helmx\\helmx\\packages\\cli\\test\\foo.test.ts', winRepo, path.win32),
    'packages/cli/test/foo.test.ts',
  )
  assert.equal(
    resolveInRepoRelativePath(winRepo, 'packages\\web\\test\\new.test.ts', winRepo, path.win32),
    'packages/web/test/new.test.ts',
  )
  assert.equal(
    resolveInRepoRelativePath(winRepo, 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\outside.test.ts', winRepo, path.win32),
    null,
  )
  assert.equal(
    resolveInRepoRelativePath(winRepo, '..\\other-repo\\x.test.ts', winRepo, path.win32),
    null,
  )
  assert.equal(resolveInRepoRelativePath(winRepo, '.', winRepo, path.win32), null)

  assert.equal(
    isCrossPackageTestHelperImport(
      'packages\\web\\test\\.helmx-hygiene-gate-fixture\\new.test.ts',
      '../../../kernel/test/helpers/fixture.js',
    ),
    true,
  )
  assert.equal(
    isCrossPackageTestHelperImport(
      'packages\\web\\test\\foo.test.ts',
      './helpers/store.js',
    ),
    false,
  )
})

// ---------------------------------------------------------------- CLI exit code

function runScript(script: string, args: string[], opts: { cwd?: string } = {}) {
  return spawnSync(process.execPath, [path.join(scriptsDir, script), ...args], {
    cwd: opts.cwd ?? repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
  })
}

test('check-test-hygiene CLI: exits 1 on violations, 0 on clean files, and 2 on unknown arguments', { timeout: 60_000 }, () => {
  // Fixture must live inside the repo (--files rejects outside paths); node_modules is gitignored so worktree stays clean.
  const dir = path.join(repoRoot, 'node_modules', '.helmx-hygiene-cli-fixtures')
  mkdirSync(dir, { recursive: true })
  try {
    const bad = path.join(dir, 'bad.test.ts')
    writeFileSync(bad, "import test from 'node:test'\ntest('x', () => {})\n")
    const good = path.join(dir, 'good.test.ts')
    writeFileSync(good, "import test from 'node:test'\ntest('x', { timeout: 60_000 }, () => {})\n")

    const r1 = runScript('check-test-hygiene.mjs', ['--files', bad])
    assert.equal(r1.status, 1, `stderr: ${r1.stderr}`)
    assert.ok(r1.stderr.includes('[timeout-missing]'), 'violation details must print rule and location')

    const r2 = runScript('check-test-hygiene.mjs', ['--files', good])
    assert.equal(r2.status, 0, `stderr: ${r2.stderr}`)

    const r3 = runScript('check-test-hygiene.mjs', ['--wat'])
    assert.equal(r3.status, 2)
    assert.ok(r3.stderr.includes('Unknown argument'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check-changed CLI: exits 2 on missing --base ref; --list prints selection without running commands', { timeout: 60_000 }, () => {
  const r1 = runScript('check-changed.mjs', ['--base', 'no-such-ref', '--list'])
  assert.equal(r1.status, 2, `stderr: ${r1.stderr}`)
  assert.ok(r1.stderr.includes('--base'))

  const r2 = runScript('check-changed.mjs', ['--list', '--base', 'HEAD'])
  assert.equal(r2.status, 0, `stderr: ${r2.stderr}`)
  assert.ok(r2.stderr.includes('[check-changed] baseline:'), 'must explicitly report the chosen baseline')
  assert.ok(r2.stderr.includes('Commands to run'), 'must print the commands to run for re-checking')
  assert.ok(r2.stderr.includes('[check-changed] --list mode: printed the selection only; no commands executed'), '--list mode must never execute commands')

  const r3 = runScript('check-changed.mjs', ['--bogus'])
  assert.equal(r3.status, 2)
})

test('check-test-hygiene CLI: exits 2 for out-of-repo paths and empty --files rather than falling back silently', { timeout: 60_000 }, () => {
  const outside = path.join(tmpdir(), 'helmx-outside-' + Date.now(), 'x.test.ts')
  const r1 = runScript('check-test-hygiene.mjs', ['--files', outside])
  assert.equal(r1.status, 2, `stderr: ${r1.stderr}`)
  assert.ok(r1.stderr.includes('[check-hygiene] Rejected path outside repository:'), 'must explicitly reject instead of silently inspecting another repository')

  const r2 = runScript('check-test-hygiene.mjs', ['--files'])
  assert.equal(r2.status, 2, `stderr: ${r2.stderr}`)
  assert.ok(r2.stderr.includes('[check-hygiene] --files requires at least one in-repository test path (refusing to scan the whole repository)'), 'empty --files must report a usage error instead of falling back to a whole-repo scan')

  // Leading -- separator (pnpm passthrough style) is equivalent to passing explicit in-repo paths,
  // and populates the static hygiene disk cache with matching stats on warm re-runs.
  const r3 = runScript('check-test-hygiene.mjs', ['--', '--files', 'packages/cli/test/cli.test.ts'])
  assert.equal(r3.status, 0, `stderr: ${r3.stderr}`)
  const hygieneCachePath = path.join(repoRoot, 'node_modules', '.cache', 'helmx-test-hygiene-cache.json')
  assert.ok(existsSync(hygieneCachePath), 'hygiene disk cache must be persisted after analyzing repo files')
  const r4 = runScript('check-test-hygiene.mjs', ['--files', 'packages/cli/test/cli.test.ts'])
  assert.equal(r4.status, 0, `warm hygiene stderr: ${r4.stderr}`)
  const statsLine = (stderr: string) => stderr.split('\n').find((l) => l.includes('[check-hygiene] stats:'))
  assert.equal(statsLine(r4.stderr), statsLine(r3.stderr), 'warm cache stats must match cold AST analysis exactly')
})

test('pnpm real invocation: pnpm check:changed -- --base HEAD --list strips leading -- separator', { timeout: 60_000 }, () => {
  const pm = resolvePackageManagerInvoke(process.env)
  const res = spawnSync(
    pm.cmd,
    [...pm.args, 'check:changed', '--', '--base', 'HEAD', '--list'],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
  )
  assert.equal(res.status, 0, `stderr: ${res.stderr}`)
  assert.ok(res.stderr.includes('[check-changed] baseline:'), `must report the baseline: ${res.stderr.slice(0, 400)}`)
  assert.ok(res.stderr.includes('[check-changed] --list mode: printed the selection only; no commands executed'), '--list never executes commands')
})

test('resolvePackageManagerInvoke: executes via Node after validating npm_execpath suffix; falls back to PATH pnpm otherwise', { timeout: 60_000 }, () => {
  // Note: real Windows .cmd behavior cannot be tested directly on Linux; this locks the platform-independent argv builder,
  // while Windows execution is covered by the live pnpm invocation smoke path above (the npm_execpath branch).
  assert.deepEqual(resolvePackageManagerInvoke({}), { cmd: 'pnpm', args: [] })
  assert.deepEqual(resolvePackageManagerInvoke({ npm_execpath: '/x/pnpm/bin/pnpm.cjs' }), {
    cmd: process.execPath,
    args: ['/x/pnpm/bin/pnpm.cjs'],
  })
  assert.deepEqual(resolvePackageManagerInvoke({ npm_execpath: '/x/pnpm/bin/pnpm.mjs' }).args, [
    '/x/pnpm/bin/pnpm.mjs',
  ])
  assert.deepEqual(resolvePackageManagerInvoke({ npm_execpath: '/x/pnpm/bin/pnpm.js' }).args, [
    '/x/pnpm/bin/pnpm.js',
  ])
  // Official standalone pnpm install (Windows): npm_execpath points to pnpm.exe and can be spawned directly.
  // .exe is a real binary (not a .cmd batch script), requiring no shell and avoiding command-injection vectors,
  // whereas bare 'pnpm' on Windows resolves to pnpm.cmd and fails spawn with EINVAL.
  assert.deepEqual(resolvePackageManagerInvoke({ npm_execpath: 'C:\\Tools\\pnpm.exe' }), {
    cmd: 'C:\\Tools\\pnpm.exe',
    args: [],
  })
  // Non-script suffixes (shims or suspicious paths) are not trusted blindly and fall back; .cmd requires a shell so is never spawned directly.
  assert.deepEqual(resolvePackageManagerInvoke({ npm_execpath: '/x/pnpm.cmd' }), { cmd: 'pnpm', args: [] })
  assert.deepEqual(resolvePackageManagerInvoke({ npm_execpath: '/x/evil.sh' }), { cmd: 'pnpm', args: [] })
  assert.deepEqual(resolvePackageManagerInvoke({ npm_execpath: '' }), { cmd: 'pnpm', args: [] })
})

test('runManagedCommand: passes through failure exit codes and returns 127 when command is missing', { timeout: 60_000 }, async () => {
  const code = await runManagedCommand(
    { cmd: process.execPath, args: ['-e', 'process.exit(3)'], label: 't-exit-3' },
    { cwd: repoRoot },
  )
  assert.equal(code, 3)
  const missing = await runManagedCommand(
    { cmd: 'helmx-no-such-cmd-xyz', args: [], label: 't-missing' },
    { cwd: repoRoot },
  )
  assert.equal(missing, 127)
})

/** Liveness check: ESRCH means gone; on Linux, zombie (Z state) is treated as exited so it is not counted as a live orphan. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const state = /\) (\w)/.exec(stat)?.[1]
      if (state === 'Z') return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * Spawns a grandchild that installs no-op SIGTERM/SIGINT handlers and writes a PID marker file, then verifies:
 * after the leader exits, wrapper continues polling the owned group -> escalates to SIGKILL after grace ->
 * terminates the entire group, exits with the signal code, and handles duplicate signals idempotently.
 * Uses short injected timings so escalation occurs in hundreds of milliseconds.
 */
async function runSignalTreeTest(signal: 'SIGTERM' | 'SIGINT', expectedCode: number): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'helmx-orphan-'))
  const marker = path.join(dir, 'grandchild.pid')
  const childScript = path.join(dir, 'child.mjs')
  const grandchildCode =
    `process.on('SIGTERM', () => {}); process.on('SIGINT', () => {});` +
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));` +
    `setInterval(() => {}, 1000);`
  writeFileSync(
    childScript,
    `import { spawn } from 'node:child_process'
const g = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], { stdio: 'ignore' })
if (g.pid == null) process.exit(9)
setInterval(() => {}, 1000)
`,
  )
  const wrapperCode = `
const m = await import(${JSON.stringify(pathToFileURL(path.join(scriptsDir, 'lib', 'spawn-checked.mjs')).href)})
const code = await m.runManagedCommand(
  { cmd: process.execPath, args: [${JSON.stringify(childScript)}], label: 't-tree' },
  { cwd: ${JSON.stringify(dir)}, timings: { pollMs: 50, cleanupGraceMs: 800, lastResortMs: 8000 } },
)
process.exit(code)
`
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e', wrapperCode], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  wrapper.stderr?.on('data', (d) => {
    stderr += String(d)
  })

  const deadline = Date.now() + 15_000
  while (!existsSync(marker) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(existsSync(marker), 'grandchild PID marker did not appear')
  const grandchildPid = Number(readFileSync(marker, 'utf8'))
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0)

  wrapper.kill(signal)
  wrapper.kill(signal) // Duplicate signal: idempotent, must not create duplicate timers or logs
  const wrapperExit = await new Promise<number | null>((resolve) => {
    wrapper.on('exit', (c, s) => resolve(c ?? (s === signal ? expectedCode : -1)))
  })
  assert.equal(wrapperExit, expectedCode, `terminating with ${signal} must exit with 128+signal; stderr: ${stderr}`)
  const signalLogs = stderr.split(`received ${signal}, terminating the child process tree`).length - 1
  assert.equal(signalLogs, 1, `duplicate signal must emit only one termination log; stderr: ${stderr}`)

  // Grandchildren ignoring the signal must still be reaped via SIGKILL escalation, leaving no orphans.
  const gone = await new Promise<boolean>((resolve) => {
    const start = Date.now()
    const poll = () => {
      if (!pidAlive(grandchildPid)) resolve(true)
      else if (Date.now() - start > 12_000) resolve(false)
      else setTimeout(poll, 100)
    }
    poll()
  })
  assert.ok(gone, `grandchild ignoring ${signal} must be reaped with the process group`)
  rmSync(dir, { recursive: true, force: true })
}

describe('process discipline and concurrent watchdog teardown', { concurrency: true }, () => {
  test('process discipline: kills entire group (exit 143) when grandchild ignores SIGTERM; duplicate signal is idempotent', { timeout: 60_000, skip: process.platform === 'win32' ? 'POSIX process group signal semantics (128+n / kill(-pid)); Windows uses taskkill' : false }, async () => {
    await runSignalTreeTest('SIGTERM', 143)
  })

  test('process discipline: kills entire group (exit 130) when grandchild ignores SIGINT', { timeout: 60_000, skip: process.platform === 'win32' ? 'POSIX process group signal semantics (128+n / kill(-pid)); Windows uses taskkill' : false }, async () => {
    await runSignalTreeTest('SIGINT', 130)
  })

  test('regression: runManagedCommand -> run-tests.mjs -> SIGTERM-ignoring grandchild leaves no orphans in live topology', { timeout: 60_000, skip: process.platform === 'win32' ? 'POSIX process group signal semantics (128+n / kill(-pid)); Windows uses taskkill' : false }, async () => {
    // Full real chain: outer managed command = node scripts/run-tests.mjs --kill-grace-ms=400 <holder>;
    // holder is a never-ending *.test.ts that spawns a SIGTERM-ignoring grandchild (writing PID marker).
    // On outer cancel: run-tests (G1 leader) gets SIGTERM -> forwards to owned G2 -> tsx leader exits while
    // G2 grandchild remains alive -> run-tests must wait until G2 drains (400ms SIGKILL escalation)
    // before exiting 143 -> outer G1 drains and exits 143.
    const invalidGrace = spawnSync(
      process.execPath,
      [path.join(scriptsDir, 'run-tests.mjs'), '--kill-grace-ms=0'],
      { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 },
    )
    assert.equal(invalidGrace.status, 2, `invalid --kill-grace-ms must exit 2; stderr: ${invalidGrace.stderr}`)
    const dir = path.join(repoRoot, 'node_modules', '.helmx-runtests-regression')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const marker = path.join(dir, 'grandchild.pid')
    const holder = path.join(dir, 'hold.test.ts')
    const grandchildCode =
      `process.on('SIGTERM', () => {});` +
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));` +
      `setInterval(() => {}, 1000);`
    writeFileSync(
      holder,
      `import test from 'node:test'
import { spawn } from 'node:child_process'
test('hold', { timeout: 60_000 }, () => {
  const g = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], { stdio: 'ignore' })
  if (g.pid == null) throw new Error('grandchild spawn failed')
  return new Promise(() => {})
})
`,
    )

    const wrapperCode = `
const m = await import(${JSON.stringify(pathToFileURL(path.join(scriptsDir, 'lib', 'spawn-checked.mjs')).href)})
// Strip outer node:test recursive context to mirror a real developer shell invocation.
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
const code = await m.runManagedCommand(
  {
    cmd: process.execPath,
    args: [${JSON.stringify(path.join(scriptsDir, 'run-tests.mjs'))}, '--kill-grace-ms=400', ${JSON.stringify(holder)}],
    label: 't-runtests',
  },
  { cwd: ${JSON.stringify(repoRoot)}, env },
)
process.exit(code)
`
    const wrapper = spawn(process.execPath, ['--input-type=module', '-e', wrapperCode], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    wrapper.stderr?.on('data', (d) => {
      stderr += String(d)
    })

    try {
      const up = Date.now() + 30_000
      while (!existsSync(marker) && Date.now() < up) {
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.ok(existsSync(marker), `grandchild marker did not appear; stderr: ${stderr}`)
      const grandchildPid = Number(readFileSync(marker, 'utf8'))
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0)

      wrapper.kill('SIGTERM')
      const wrapperExit = await new Promise<number | null>((resolve) => {
        wrapper.on('exit', (c, s) => resolve(c ?? (s === 'SIGTERM' ? 143 : -1)))
      })
      assert.equal(
        wrapperExit,
        143,
        `outer wrapper must wait for G1 (including run-tests draining G2) before exiting 143; stderr: ${stderr}`,
      )
      assert.ok(stderr.includes('owned test process group drained'), `run-tests must wait for its G2 to drain; stderr: ${stderr}`)

      // SIGTERM-ignoring grandchild must eventually be reaped via run-tests SIGKILL escalation (Linux Z state treated as exited).
      const gone = await new Promise<boolean>((resolve) => {
        const start = Date.now()
        const poll = () => {
          if (!pidAlive(grandchildPid)) resolve(true)
          else if (Date.now() - start > 15_000) resolve(false)
          else setTimeout(poll, 100)
        }
        poll()
      })
      assert.ok(gone, `SIGTERM-ignoring grandchild must be reaped with its process group in live topology`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('process discipline: parent-death watchdog kills detached test process group when run-tests.mjs is killed with SIGKILL', { timeout: 60_000, skip: process.platform === 'win32' ? 'POSIX parent-death watchdog and process group signal semantics; Windows unsupported' : false }, async () => {
    const dir = path.join(repoRoot, 'node_modules', '.helmx-runtests-sigkill')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const marker = path.join(dir, 'grandchild.pid')
    const holder = path.join(dir, 'hold.test.ts')
    const grandchildCode =
      `process.on('SIGTERM', () => {}); process.on('SIGINT', () => {});` +
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));` +
      `setInterval(() => {}, 1000);`
    writeFileSync(
      holder,
      `import test from 'node:test'
import { spawn } from 'node:child_process'
test('hold-sigkill', { timeout: 60_000 }, () => {
  const g = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], { stdio: 'ignore' })
  if (g.pid == null) throw new Error('grandchild spawn failed')
  return new Promise(() => {})
})
`,
    )

    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const runner = spawn(process.execPath, [path.join(scriptsDir, 'run-tests.mjs'), holder], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    runner.stderr?.on('data', (d) => {
      stderr += String(d)
    })

    try {
      const up = Date.now() + 30_000
      while (!existsSync(marker) && Date.now() < up) {
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.ok(existsSync(marker), `grandchild PID marker did not appear; stderr: ${stderr}`)
      const grandchildPid = Number(readFileSync(marker, 'utf8'))
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0)
      assert.ok(pidAlive(grandchildPid), 'grandchild must still be alive before killing run-tests')

      runner.kill('SIGKILL')
      const exitSignal = await new Promise<string | null>((resolve) => {
        runner.on('exit', (_c, s) => resolve(s))
      })
      assert.equal(exitSignal, 'SIGKILL')

      // After parent is killed, the detached watchdog should terminate the whole detached test process group within 1s SIGKILL escalation.
      const gone = await new Promise<boolean>((resolve) => {
        const start = Date.now()
        const poll = () => {
          if (!pidAlive(grandchildPid)) resolve(true)
          else if (Date.now() - start > 10_000) resolve(false)
          else setTimeout(poll, 100)
        }
        poll()
      })
      assert.ok(gone, 'after run-tests.mjs receives SIGKILL, parent-death watchdog must terminate its detached test process group')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------- CSS :hover media gate (scripts/lib/css-hygiene.mjs)

test('css-hygiene: findUngatedHoverRules reports every ungated :hover rule with exact line numbers, mixed selector lists counted once, comma-OR media lists and `not` branches never gate', { timeout: 60_000 }, () => {
  const violations = findUngatedHoverRules(`/* 1: a comment mentioning :hover is not a rule */
.a:hover {
  color: red;
}
@media (max-width: 680px) {
  .m:hover { color: blue; }
}
@container card (min-width: 100px) {
  .c:hover { color: green; }
}
@supports (display: grid) {
  .s:hover { color: teal; }
}
@media (any-hover: hover) {
  .any:hover { color: pink; }
}
.outer:has(.inner:hover) {
  color: orange;
}
.b:hover,
.c:focus-visible {
  color: purple;
}
/* 24: 逗号 OR 列表里任一分支不要求 hover 特征就不算门禁；not 前缀分支永不门禁 */
@media (max-width: 680px), (hover: none) and (pointer: coarse) {
  .a:hover { color: red; }
}
@media (max-width: 680px), (hover: hover) {
  .b:hover { color: red; }
}
@media not all and (hover: hover) {
  .c:hover { color: red; }
}
@media (hover: hover), (hover: none) {
  .e:hover { color: red; }
}
`)
  assert.deepEqual(violations, [
    { line: 2, selector: '.a:hover' },
    { line: 6, selector: '.m:hover' },
    { line: 9, selector: '.c:hover' },
    { line: 12, selector: '.s:hover' },
    { line: 15, selector: '.any:hover' },
    { line: 17, selector: '.outer:has(.inner:hover)' },
    { line: 20, selector: '.b:hover, .c:focus-visible' },
    { line: 26, selector: '.a:hover' },
    { line: 29, selector: '.b:hover' },
    { line: 32, selector: '.c:hover' },
    { line: 35, selector: '.e:hover' },
  ])
})

test('css-hygiene: rules gated by (hover: hover)/(hover: none) in every OR branch, :not(:hover), comments, string literals and @keyframes frames are not reported', { timeout: 60_000 }, () => {
  const violations = findUngatedHoverRules(`/* 1 */
@media (hover: hover) {
  .g1:hover { color: red; }
}
@media (max-width: 680px) and (hover: hover) {
  .g2:hover { color: blue; }
}
@media (hover: hover) and (pointer: fine), (hover: hover) and (min-width: 1200px) {
  .g5:hover { color: navy; }
}
@media screen and (hover: none), (hover: none) and (pointer: coarse) {
  .g6:hover { background: transparent; }
}
@layer base {
  @media ( hover : hover ) {
    .g4:hover { color: green; }
  }
}
@media (hover: none) {
  .g3:hover { background: transparent; }
}
.x:not(:hover) { color: gray; }
/* .commented:hover { color: black; } */
.y::after { content: ':hover'; }
.z[data-x="a:hover"] { color: olive; }
@keyframes pulse {
  0% { opacity: 0.4; }
  .k:hover { color: red; }
}
`)
  assert.deepEqual(violations, [])
})

test('css-hygiene: collectSourceCssFiles returns only packages/<pkg>/src/**/*.css, sorted, and tolerates a missing root', { timeout: 60_000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'helmx-css-hygiene-'))
  try {
    write(root, 'packages/web/src/a.css', '')
    write(root, 'packages/web/src/deep/b.css', '')
    write(root, 'packages/web/dist/x.css', '')
    write(root, 'packages/web/test/fixtures/x.css', '')
    write(root, 'packages/plugins/src/client/styles.css', '')
    write(root, 'packages/kernel/package.json', '{}')
    write(root, 'packages/not-a-dir.css', '')
    write(root, 'docs/x.css', '')
    assert.deepEqual(collectSourceCssFiles(root), [
      'packages/plugins/src/client/styles.css',
      'packages/web/src/a.css',
      'packages/web/src/deep/b.css',
    ])
    assert.deepEqual(collectSourceCssFiles(path.join(root, 'missing')), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- unsafe-dom-assert / safe-test-assert / SIGKILL watchdog

test('hygiene: unsafe-dom-assert catches DOM node assertions while allowing text/ordinary body/ok/notEqual null', { timeout: 60_000 }, () => {
  // Positive cases (violations): querySelector / getElementById / local variable / both sides of document.activeElement / document.body / named import
  assert.deepEqual(
    rulesOf(`import test from 'node:test'
import assert from 'node:assert/strict'
import { strictEqual } from 'node:assert'
test('bad dom', { timeout: 60_000 }, () => {
  assert.equal(document.querySelector('.a'), null)
  strictEqual(document.getElementById('x'), null)
  const el = document.querySelector('.b')
  assert.equal(el, null)
  assert.notStrictEqual(document.activeElement, el)
  assert.deepEqual(document.body, null)
})`),
    [
      'unsafe-dom-assert',
      'unsafe-dom-assert',
      'unsafe-dom-assert',
      'unsafe-dom-assert',
      'unsafe-dom-assert',
    ],
  )

  // Negative cases (clean): textContent / innerHTML / getAttribute / length / req.body / hit.body / assert.ok / assert.notEqual(el, null)
  assert.deepEqual(
    rulesOf(`import test from 'node:test'
import assert from 'node:assert/strict'
test('clean dom', { timeout: 60_000 }, () => {
  const el = document.querySelector('.a')
  assert.equal(el?.textContent, 'ok')
  assert.equal(el?.innerHTML, '<span>ok</span>')
  assert.equal(el?.getAttribute('role'), 'dialog')
  assert.equal(document.querySelectorAll('.item').length, 2)
  assert.equal(hit.body, 'payload')
  assert.equal(req.body, 'raw')
  assert.equal(draft.body, 'draft')
  assert.ok(el === null)
  assert.notEqual(el, null)
  assert.notStrictEqual(document.activeElement, null)
})`),
    [],
  )
})

test('safe-test-assert: throws summary AssertionError in <50ms for assert.equal(el, null) and assert.deepEqual([el], []) on cyclic __reactFiber$ DOM nodes', { timeout: 60_000 }, async () => {
  const preloadUrl = pathToFileURL(path.join(scriptsDir, 'lib', 'safe-test-assert.mjs')).href
  await import(preloadUrl)
  const { equal, deepEqual } = await import('node:assert/strict')

  // Construct simulated DOM element with deeply cyclic React Fiber references
  const fiber: Record<string, unknown> = { memoizedProps: {}, return: null, stateNode: null }
  fiber.child = fiber
  fiber.return = fiber
  const bigArr = Array.from({ length: 5000 }, (_, i) => ({ i, parent: fiber }))
  fiber.memoizedProps = { items: bigArr }
  const el: Record<string, unknown> = {
    nodeType: 1,
    nodeName: 'DIV',
    id: 'card',
    className: 'box active',
    __reactFiber$xyz: fiber,
    ownerDocument: null,
  }
  fiber.stateNode = el
  el.ownerDocument = { nodeType: 9, nodeName: '#document', body: el }

  const t0 = performance.now()
  assert.throws(
    () => assert.equal(el, null),
    (err: unknown) => {
      assert.ok(err instanceof assert.AssertionError)
      assert.ok(err.message.includes('[DOM <div#card.box.active>]'), `missing compact summary: ${err.message}`)
      return true
    },
  )
  assert.throws(
    () => equal(el, null),
    (err: unknown) => err instanceof assert.AssertionError && err.message.includes('[DOM <div#card.box.active>]'),
  )
  assert.throws(
    () => assert.deepEqual([el], []),
    (err: unknown) => {
      assert.ok(err instanceof assert.AssertionError)
      assert.deepEqual(err.actual, ['[DOM <div#card.box.active>]'])
      assert.ok(err.message.includes('[DOM <div#card.box.active>]'), `array element missing compact summary: ${err.message}`)
      return true
    },
  )
  assert.throws(
    () => deepEqual([el], []),
    (err: unknown) =>
      err instanceof assert.AssertionError &&
      err.message.includes('[DOM <div#card.box.active>]'),
  )
  const elapsedMs = performance.now() - t0
  assert.ok(elapsedMs < 50, `unsafe DOM assertion took ${elapsedMs.toFixed(1)}ms, exceeding 50ms threshold`)

  // Normal objects still generate standard diffs without mis-summarization
  assert.throws(
    () => assert.deepEqual({ alpha: 1 }, { alpha: 2 }),
    (err: unknown) => err instanceof assert.AssertionError && err.message.includes('alpha'),
  )
})
