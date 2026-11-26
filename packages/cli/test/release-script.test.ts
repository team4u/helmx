/**
 * End-to-end tests for `scripts/release.mjs` in isolated temporary Git repositories:
 * - Strict SemVer 2.0.0 validation (aligned with `@helmx/protocol` `isStrictSemver`, forbidding `+build` metadata);
 * - Existing tag guard executes before modifying workspace `package.json`, `CHANGELOG.md`, or creating a commit;
 * - `--allow-dirty` commits only release files via `git commit --only -- <paths>`, leaving user staged changes intact;
 * - the release commit subject survives intact (`shell: false`): cmd.exe used to split
 *   `-m "chore(release): v0.1.2"` on spaces/parens and git treated `v0.1.2)` as a pathspec.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isStrictSemver } from '@helmx/protocol'
import { sanitizedHostEnv, useTempDir } from './helpers/cli-harness.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const releaseScriptSrc = path.join(repoRoot, 'scripts', 'release.mjs')
const releaseNotesSrc = path.join(repoRoot, 'scripts', 'lib', 'release-notes.mjs')
// Windows 上绝对路径必须经 file:// URL 才能被 ESM loader 接受
const { assertPnpmArgsShellSafe } = await import(pathToFileURL(releaseScriptSrc).href)
const { assembleReleaseNotes } = await import(pathToFileURL(releaseNotesSrc).href)

function gitIn(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env })
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${res.status}):\n${res.stderr}\n${res.stdout}`)
  }
  return res.stdout
}

function makeFixtureRepo(dir: string, initialVersion = '0.1.1', opts: { withChangelog?: boolean } = {}) {
  const env: NodeJS.ProcessEnv = {
    ...sanitizedHostEnv(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(dir, '.empty-gitconfig'),
  }
  writeFileSync(path.join(dir, '.empty-gitconfig'), '')
  mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true })
  mkdirSync(path.join(dir, 'packages', 'payload'), { recursive: true })
  mkdirSync(path.join(dir, 'packages', 'cli'), { recursive: true })
  copyFileSync(releaseScriptSrc, path.join(dir, 'scripts', 'release.mjs'))
  copyFileSync(releaseNotesSrc, path.join(dir, 'scripts', 'lib', 'release-notes.mjs'))
  writeFileSync(
    path.join(dir, 'packages', 'payload', 'package.json'),
    `${JSON.stringify({ name: '@helmx/payload', private: true, version: initialVersion }, null, 2)}\n`,
  )
  writeFileSync(
    path.join(dir, 'packages', 'cli', 'package.json'),
    `${JSON.stringify({ name: '@helmx/cli', private: true, version: initialVersion }, null, 2)}\n`,
  )
  writeFileSync(path.join(dir, 'notes.txt'), 'initial\n')
  if (opts.withChangelog) {
    writeFileSync(path.join(dir, 'CHANGELOG.md'), `# Changelog\n\n## v${initialVersion} (2026-01-01)\n\n- init\n`)
  }
  gitIn(dir, ['init', '-b', 'main'], env)
  gitIn(dir, ['config', 'user.email', 'release-test@example.com'], env)
  gitIn(dir, ['config', 'user.name', 'Release Test'], env)
  gitIn(dir, ['config', 'commit.gpgsign', 'false'], env)
  gitIn(dir, ['config', 'tag.gpgsign', 'false'], env)
  gitIn(dir, ['add', '.'], env)
  gitIn(dir, ['commit', '-m', 'feat(core): initial commit'], env)
  return {
    dir,
    env,
    git: (args: readonly string[]) => gitIn(dir, args, env),
    runRelease: (args: readonly string[]) =>
      spawnSync(process.execPath, [path.join(dir, 'scripts', 'release.mjs'), ...args], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 30_000,
        env,
      }),
  }
}

test('release.mjs: enforces strict SemVer 2.0.0 without build metadata', { timeout: 60_000 }, (t) => {
  const fixture = makeFixtureRepo(useTempDir(t, 'helmx-release-script-'), '0.1.1')

  const invalidVersions = [
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-',
    '1.2.3-.',
    '1.2.3-.1',
    '1.2.3-beta.',
    '1.2.3-beta..1',
    '1.2.3-01',
    '1.2.3-beta.01',
    '1.2.3+build.1',
    '1.2.3-beta.1+build.1',
    '1.2.3-beta_1',
  ]
  for (const bad of invalidVersions) {
    const res = fixture.runRelease([bad, '--dry-run', '--skip-verify'])
    assert.notEqual(res.status, 0, `expected invalid version "${bad}" to fail`)
    assert.match(res.stderr, /严格 SemVer/, `unexpected stderr for "${bad}": ${res.stderr}`)
  }

  // Invalid --prerelease preId also fails strict validation
  const badPreId = fixture.runRelease(['--prerelease', '01', '--dry-run', '--skip-verify'])
  assert.notEqual(badPreId.status, 0, 'leading-zero numeric preId must be rejected')
  assert.match(badPreId.stderr, /严格 SemVer/)

  // Valid strict SemVer versions pass dry-run and match @helmx/protocol isStrictSemver
  const validVersions = ['0.1.2', '1.2.3-beta.1', '1.2.3-0', '1.2.3-0alpha', '1.2.3-rc-1.0']
  for (const ok of validVersions) {
    assert.equal(isStrictSemver(ok), true, `sanity: ${ok} must be valid strict SemVer`)
    const res = fixture.runRelease([ok, '--dry-run', '--skip-verify'])
    assert.equal(res.status, 0, `expected valid version "${ok}" to succeed:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`)
  }

  const validPreId = fixture.runRelease(['--prerelease', 'rc', '--dry-run', '--skip-verify'])
  assert.equal(validPreId.status, 0, `expected --prerelease rc to succeed:\n${validPreId.stderr}`)
  assert.match(validPreId.stdout, /目标版本: 0\.1\.2-rc\.1/)
})

test('release.mjs: checks existing tag before modifying version files, CHANGELOG.md, or committing', { timeout: 60_000 }, (t) => {
  const fixture = makeFixtureRepo(useTempDir(t, 'helmx-release-script-'), '0.1.1')
  fixture.git(['tag', 'v0.1.2'])
  const headBefore = fixture.git(['rev-parse', 'HEAD']).trim()
  const payloadBefore = readFileSync(path.join(fixture.dir, 'packages', 'payload', 'package.json'), 'utf8')
  const cliBefore = readFileSync(path.join(fixture.dir, 'packages', 'cli', 'package.json'), 'utf8')

  // Fails fast in --dry-run too
  const dry = fixture.runRelease(['0.1.2', '--dry-run', '--skip-verify'])
  assert.notEqual(dry.status, 0)
  assert.match(dry.stderr, /tag v0\.1\.2 已存在/)

  // Fails before mutating files or creating any commit in real run
  const real = fixture.runRelease(['0.1.2', '--skip-verify'])
  assert.notEqual(real.status, 0)
  assert.match(real.stderr, /tag v0\.1\.2 已存在/)
  assert.equal(fixture.git(['rev-parse', 'HEAD']).trim(), headBefore, 'HEAD commit must remain untouched')
  assert.equal(readFileSync(path.join(fixture.dir, 'packages', 'payload', 'package.json'), 'utf8'), payloadBefore)
  assert.equal(readFileSync(path.join(fixture.dir, 'packages', 'cli', 'package.json'), 'utf8'), cliBefore)
  assert.equal(existsSync(path.join(fixture.dir, 'CHANGELOG.md')), false, 'CHANGELOG.md must not be created')
  assert.equal(fixture.git(['status', '--porcelain']).trim(), '', 'working tree must remain clean')
})

test('release.mjs --allow-dirty: commits only release files via --only and preserves user staged changes', { timeout: 60_000 }, (t) => {
  // Case 1: brand-new untracked CHANGELOG.md + user staged modified file + user staged new file + unstaged dirty file
  const fresh = makeFixtureRepo(useTempDir(t, 'helmx-release-script-'), '0.1.1', { withChangelog: false })
  writeFileSync(path.join(fresh.dir, 'notes.txt'), 'staged-edit\n')
  writeFileSync(path.join(fresh.dir, 'user-staged-new.txt'), 'keep-staged\n')
  fresh.git(['add', 'notes.txt', 'user-staged-new.txt'])
  writeFileSync(path.join(fresh.dir, 'user-unstaged.txt'), 'leave-untracked\n')

  const res1 = fresh.runRelease(['0.1.2', '--allow-dirty', '--skip-verify'])
  assert.equal(res1.status, 0, `release --allow-dirty failed:\nstdout: ${res1.stdout}\nstderr: ${res1.stderr}`)

  const commitFiles1 = fresh.git(['show', '--name-only', '--pretty=format:', 'HEAD']).trim().split('\n').sort()
  assert.deepEqual(commitFiles1, ['CHANGELOG.md', 'packages/cli/package.json', 'packages/payload/package.json'])
  // 提交信息必须完整：shell:true 下 cmd.exe 会按空格/括号拆分 `-m "chore(release): v0.1.2"`，
  // 使 git 把 `v0.1.2)` 当作 pathspec 而失败（Windows CI 回归）。
  assert.equal(fresh.git(['log', '-1', '--pretty=format:%B']).trim(), 'chore(release): v0.1.2')
  assert.equal(fresh.git(['rev-parse', 'v0.1.2']).trim(), fresh.git(['rev-parse', 'HEAD']).trim())

  const stagedAfter1 = fresh.git(['diff', '--cached', '--name-only']).trim().split('\n').sort()
  assert.deepEqual(stagedAfter1, ['notes.txt', 'user-staged-new.txt'], 'user staged files must stay staged and excluded from release commit')
  assert.match(fresh.git(['status', '--porcelain']), /\?\? user-unstaged\.txt/)

  // Case 2: already-tracked CHANGELOG.md + prior tag + user staged edits remain preserved
  const tracked = makeFixtureRepo(useTempDir(t, 'helmx-release-script-'), '0.1.1', { withChangelog: true })
  tracked.git(['tag', 'v0.1.1'])
  writeFileSync(path.join(tracked.dir, 'notes.txt'), 'v2-feature\n')
  tracked.git(['add', 'notes.txt'])
  tracked.git(['commit', '-m', 'feat(cli): add feature'])

  writeFileSync(path.join(tracked.dir, 'notes.txt'), 'wip-staged\n')
  tracked.git(['add', 'notes.txt'])

  const res2 = tracked.runRelease(['--patch', '--allow-dirty', '--skip-verify'])
  assert.equal(res2.status, 0, `release --patch --allow-dirty failed:\nstdout: ${res2.stdout}\nstderr: ${res2.stderr}`)

  const commitFiles2 = tracked.git(['show', '--name-only', '--pretty=format:', 'HEAD']).trim().split('\n').sort()
  assert.deepEqual(commitFiles2, ['CHANGELOG.md', 'packages/cli/package.json', 'packages/payload/package.json'])
  assert.equal(tracked.git(['log', '-1', '--pretty=format:%B']).trim(), 'chore(release): v0.1.2')
  assert.deepEqual(tracked.git(['diff', '--cached', '--name-only']).trim().split('\n'), ['notes.txt'])
  assert.match(readFileSync(path.join(tracked.dir, 'CHANGELOG.md'), 'utf8'), /## v0\.1\.2 \(\d{4}-\d{2}-\d{2}\)\n\n- feat\(cli\): add feature/)
})

test('release.mjs: reuses pre-written CHANGELOG.md section and supports --notes-file cleanly', { timeout: 60_000 }, (t) => {
  // Case 1: pre-written CHANGELOG.md section already committed on main
  const curated = makeFixtureRepo(useTempDir(t, 'helmx-release-curated-'), '0.1.1', { withChangelog: true })
  curated.git(['tag', 'v0.1.1'])
  const curatedBody = '### 工作台\n\n- **会话总览**：主舞台支持筛选与批量管理。'
  writeFileSync(
    path.join(curated.dir, 'CHANGELOG.md'),
    `# Changelog\n\n## v0.2.0 (2026-11-24)\n\n${curatedBody}\n\n## v0.1.1 (2026-01-01)\n\n- init\n`,
  )
  curated.git(['add', 'CHANGELOG.md'])
  curated.git(['commit', '-m', 'docs: add v0.2.0 curated changelog'])

  const dry = curated.runRelease(['--minor', '--dry-run', '--skip-verify'])
  assert.equal(dry.status, 0, `dry-run failed:\n${dry.stderr}`)
  assert.match(dry.stdout, /CHANGELOG\.md 已有 v0\.2\.0 \(2026-11-24\) 小节（直接沿用）/)
  assert.match(dry.stdout, /会话总览/)

  // Passing --notes-file when target section already exists fails explicitly
  const conflictNotes = path.join(curated.dir, 'notes.md')
  writeFileSync(conflictNotes, '- override attempt\n')
  const conflict = curated.runRelease(['0.2.0', '--notes-file', 'notes.md', '--allow-dirty', '--skip-verify'])
  assert.notEqual(conflict.status, 0)
  assert.match(conflict.stderr, /冲突/)

  // Clean repo (remove untracked scratch file): reusing already-committed CHANGELOG.md works without --allow-dirty
  curated.git(['clean', '-fd'])
  const res1 = curated.runRelease(['0.2.0', '--skip-verify'])
  assert.equal(res1.status, 0, `release with pre-written CHANGELOG failed:\nstdout: ${res1.stdout}\nstderr: ${res1.stderr}`)
  const changelogAfter = readFileSync(path.join(curated.dir, 'CHANGELOG.md'), 'utf8')
  assert.equal(changelogAfter.match(/^## v0\.2\.0 \(/gm)?.length, 1, 'must not duplicate v0.2.0 section')
  assert.match(changelogAfter, /主舞台支持筛选与批量管理/)

  // release-notes.mjs reuses the curated section verbatim in GitHub Release notes
  const assembled = assembleReleaseNotes({
    tag: 'v0.2.0',
    prevTag: 'v0.1.1',
    payloadStatus: 'published @helmx/hub@0.2.0',
    cliStatus: 'published @helmx/cli@0.2.0',
    nodeStatus: 'published @helmx/node@0.2.0',
    changelogPath: path.join(curated.dir, 'CHANGELOG.md'),
  })
  assert.match(assembled, /## 变更明细（v0\.1\.1\.\.v0\.2\.0）/)
  assert.match(assembled, /主舞台支持筛选与批量管理/)
  assert.doesNotMatch(assembled, /docs: add v0\.2\.0 curated changelog/)

  // Case 2: --notes-file on a clean repo writes curated notes (stripping matching heading if present)
  const fromFile = makeFixtureRepo(useTempDir(t, 'helmx-release-notes-file-'), '0.1.1', { withChangelog: true })
  fromFile.git(['tag', 'v0.1.1'])
  writeFileSync(path.join(fromFile.dir, 'notes.txt'), 'internal change\n')
  fromFile.git(['add', 'notes.txt'])
  fromFile.git(['commit', '-m', 'refactor: internal plumbing'])

  const extNotesDir = useTempDir(t, 'helmx-release-notes-src-')
  const mismatchedFile = path.join(extNotesDir, 'mismatch.md')
  writeFileSync(mismatchedFile, '## v0.9.9 (2026-11-24)\n\n- wrong version\n')
  const mismatch = fromFile.runRelease(['0.2.0', '--notes-file', mismatchedFile, '--skip-verify'])
  assert.notEqual(mismatch.status, 0)
  assert.match(mismatch.stderr, /不一致/)

  const emptyFile = path.join(extNotesDir, 'empty.md')
  writeFileSync(emptyFile, '   \n')
  const emptyRes = fromFile.runRelease(['0.2.0', '--notes-file', emptyFile, '--skip-verify'])
  assert.notEqual(emptyRes.status, 0)
  assert.match(emptyRes.stderr, /为空/)

  const validFile = path.join(extNotesDir, 'v0.2.0.md')
  writeFileSync(validFile, '## v0.2.0 (2026-11-24)\n\n### 新特性\n\n- 用户可感知亮点。\n')
  const res2 = fromFile.runRelease(['0.2.0', '--notes-file', validFile, '--skip-verify'])
  assert.equal(res2.status, 0, `release --notes-file failed:\nstdout: ${res2.stdout}\nstderr: ${res2.stderr}`)
  const written = readFileSync(path.join(fromFile.dir, 'CHANGELOG.md'), 'utf8')
  assert.equal(written.match(/^## v0\.2\.0 \(/gm)?.length, 1)
  assert.match(written, /### 新特性\n\n- 用户可感知亮点。/)
  assert.doesNotMatch(written, /internal plumbing/)
})

test('release.mjs auto-summary: merge commits are excluded structurally, whatever their subject', { timeout: 60_000 }, (t) => {
  const fixture = makeFixtureRepo(useTempDir(t, 'helmx-release-merges-'), '0.1.1', { withChangelog: true })
  fixture.git(['tag', 'v0.1.1'])
  const commit = (message: string) => {
    writeFileSync(path.join(fixture.dir, 'notes.txt'), `${message}\n`)
    fixture.git(['add', 'notes.txt'])
    fixture.git(['commit', '-m', message])
  }
  const mergeTopic = (branch: string, message: string | null) => {
    fixture.git(['checkout', '-b', branch])
    commit(`feat(${branch}): work on branch`)
    fixture.git(['checkout', 'main'])
    fixture.git(['merge', '--no-ff', '--no-edit', ...(message === null ? [] : ['-m', message]), branch])
  }
  commit('feat(cli): real change')
  // 三类 merge 提交在仓库历史里都真实存在：git 默认英文标题 / 中文 merge(x): 约定 / 普通标题的真 merge
  mergeTopic('topic-default', null)
  mergeTopic('topic-zh', 'merge(main): 同步集成分支')
  mergeTopic('topic-plain', 'fix: 看起来像普通提交的 merge')
  commit('chore(release): v0.1.2')

  const dry = fixture.runRelease(['0.2.0', '--dry-run', '--skip-verify'])
  assert.equal(dry.status, 0, `dry-run failed:\n${dry.stderr}`)
  const summary = (dry.stdout.split('将写入/复用的变更明细:')[1] ?? '').split('\n\n')[0] ?? ''
  assert.match(summary, /- feat\(cli\): real change/)
  assert.match(summary, /- feat\(topic-zh\): work on branch/)
  assert.doesNotMatch(summary, /Merge branch|merge\(main\)|看起来像普通提交的 merge|chore\(release\)/)

  // notes 作业在 CHANGELOG 无目标小节时回退到同一函数：以 fixture 为 cwd 直接跑 CLI 入口（函数用 process.cwd()）
  const out = path.join(fixture.dir, 'notes-out.md')
  const notes = spawnSync(process.execPath, [releaseNotesSrc, '--tag', 'v0.2.0', '--out', 'notes-out.md'], {
    cwd: fixture.dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...fixture.env,
      HELMX_RELEASE_PAYLOAD_STATUS: 'published @helmx/hub@0.2.0',
      HELMX_RELEASE_CLI_STATUS: 'published @helmx/cli@0.2.0',
      HELMX_RELEASE_NODE_STATUS: 'published @helmx/node@0.2.0',
    },
  })
  assert.equal(notes.status, 0, `release-notes failed:\n${notes.stderr}`)
  const body = readFileSync(out, 'utf8')
  assert.match(body, /## 变更明细（v0\.1\.1\.\.v0\.2\.0）/)
  assert.match(body, /- feat\(cli\): real change/)
  assert.doesNotMatch(body, /Merge branch|merge\(main\)|看起来像普通提交的 merge|chore\(release\)/)
})

test('release.mjs --dry-run: previews without running the local gate even when --skip-verify is absent', { timeout: 60_000 }, (t) => {
  const fixture = makeFixtureRepo(useTempDir(t, 'helmx-release-dry-run-'), '0.1.1', { withChangelog: true })
  const payloadBefore = readFileSync(path.join(fixture.dir, 'packages', 'payload', 'package.json'), 'utf8')
  // 不带 --skip-verify：fixture 没有 build 脚本，门禁一旦被触发 pnpm build 必然失败
  const res = fixture.runRelease(['--minor', '--dry-run'])
  assert.equal(res.status, 0, `dry-run must not run the gate:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`)
  assert.match(res.stdout, /\[模拟运行\] 未修改任何文件，也未运行本地门禁/)
  assert.match(res.stdout, /正式运行计划: 本地门禁（build \/ typecheck \/ lint \/ check:hygiene \/ test:all）/)
  assert.doesNotMatch(res.stdout, /^- build\.\.\.$/m)
  assert.equal(readFileSync(path.join(fixture.dir, 'packages', 'payload', 'package.json'), 'utf8'), payloadBefore)
  assert.doesNotMatch(readFileSync(path.join(fixture.dir, 'CHANGELOG.md'), 'utf8'), /## v0\.2\.0/)
  assert.equal(fixture.git(['status', '--porcelain']).trim(), '')

  const skipped = fixture.runRelease(['--minor', '--dry-run', '--skip-verify'])
  assert.equal(skipped.status, 0, `dry-run --skip-verify failed:\n${skipped.stderr}`)
  assert.match(skipped.stdout, /正式运行计划: 跳过本地门禁（--skip-verify）/)
})

test('assertPnpmArgsShellSafe: pnpm gate arguments stay shell-inert (the .cmd shim must go through cmd.exe)', { timeout: 60_000 }, () => {
  // 门禁实际使用的全部命令名（build / typecheck:only / lint / check:hygiene / test:all:run）必须放行
  assert.doesNotThrow(() => assertPnpmArgsShellSafe(['build']));
  assert.doesNotThrow(() => assertPnpmArgsShellSafe(['typecheck:only']));
  assert.doesNotThrow(() => assertPnpmArgsShellSafe(['check:hygiene']));
  assert.doesNotThrow(() => assertPnpmArgsShellSafe(['test:all:run']));
  // 任何含 cmd.exe 元字符 / 空格的参数显式拒绝，绝不静默经 shell 执行
  for (const bad of ['--foo bar', 'a&b', 'a|b', 'a>b', 'a(b)', 'a;b', 'x\ny', '', '--run=echo hi']) {
    assert.throws(() => assertPnpmArgsShellSafe([bad]), /pnpm 参数含 shell 元字符/, `must reject ${JSON.stringify(bad)}`);
  }
})
