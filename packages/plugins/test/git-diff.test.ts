/**
 * Pure unit tests for `git-diff-parser.ts` (`-z` parsers, validators, unified diff hunk parser)
 * and `builtin:changes` client `diff-model.ts` helpers (`computeWordDiffSegments`, target builders).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { HelmxError } from '@helmx/protocol'
import {
  mergeDiffFileEntries,
  parseGitLogZ,
  parseNameStatusZ,
  parseNumstatZ,
  parsePorcelainV2Z,
  parseUnifiedDiffHunks,
  validateGitCommitSha,
  validateRelativeGitPath,
} from '../src/git-diff/git-diff-parser.js'
import {
  buildChangesScreenTarget,
  computeWordDiffSegments,
  decorateHunksWithWordDiff,
  formatInspectGitCommand,
} from '../src/changes/client/diff-model.js'

describe('git-diff validators and -z parsers', { timeout: 60_000 }, () => {
  it('validateRelativeGitPath accepts clean POSIX repo paths and rejects traversal/absolute/backslash/control chars', {
    timeout: 60_000,
  }, () => {
    assert.equal(validateRelativeGitPath('src/index.ts'), 'src/index.ts')
    assert.equal(validateRelativeGitPath('a/.hidden/file.txt'), 'a/.hidden/file.txt')

    for (const bad of ['', '/etc/passwd', 'a\\b.txt', '../secret', 'a/../b', 'a/./b', 'a//b', 'bad\u0000path', 'bad\npath']) {
      assert.throws(
        () => validateRelativeGitPath(bad),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
        `expected rejection for ${JSON.stringify(bad)}`,
      )
    }
  })

  it('validateGitCommitSha accepts 7..64 hex SHAs and rejects flag/ref injection', { timeout: 60_000 }, () => {
    assert.equal(validateGitCommitSha(' 1a2b3c4 '), '1a2b3c4')
    assert.equal(validateGitCommitSha('a'.repeat(40)), 'a'.repeat(40))
    for (const bad of ['', '123456', '--exec=rm', 'HEAD~1', 'main', `${'a'.repeat(65)}`]) {
      assert.throws(
        () => validateGitCommitSha(bad),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
        `expected rejection for ${JSON.stringify(bad)}`,
      )
    }
  })

  it('parsePorcelainV2Z skips rename second NUL token without inflating dirtyFileCount and parses branch/ab headers', {
    timeout: 60_000,
  }, () => {
    const tokens = [
      '# branch.oid 1234567890abcdef1234567890abcdef12345678',
      '# branch.head feat/demo',
      '# branch.upstream origin/feat/demo',
      '# branch.ab +3 -1',
      '1 .M N... 100644 100644 100644 aaa bbb src/a.ts',
      '2 R. N... 100644 100644 100644 ccc ddd R100 src/new.ts',
      'src/old.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts',
      '? src/untracked.ts',
      '',
    ]
    const parsed = parsePorcelainV2Z(tokens.join('\0'))
    assert.equal(parsed.oid, '1234567890abcdef1234567890abcdef12345678')
    assert.equal(parsed.branch, 'feat/demo')
    assert.equal(parsed.upstream, 'origin/feat/demo')
    assert.equal(parsed.ahead, 3)
    assert.equal(parsed.behind, 1)
    assert.equal(parsed.dirtyFileCount, 4, 'rename 2nd token must not count as an extra dirty file')
    assert.deepEqual(parsed.untrackedPaths, ['src/untracked.ts'])
  })

  it('parseNumstatZ / parseNameStatusZ / mergeDiffFileEntries handle binaries, renames, T/U normalization, and 500-file cap', {
    timeout: 60_000,
  }, () => {
    const numstat = [
      '10\t2\tsrc/app.ts',
      '-\t-\tassets/logo.png',
      '5\t0\t',
      'old name.ts',
      'new name.ts',
      '',
    ].join('\0')
    const nameStatus = [
      'M', 'src/app.ts',
      'M', 'assets/logo.png',
      'R095', 'old name.ts', 'new name.ts',
      'T', 'symlink-or-mode.ts',
      'U', 'unmerged.ts',
      '',
    ].join('\0')

    const stats = parseNumstatZ(numstat)
    assert.equal(stats.length, 3)
    assert.equal(stats[1]!.binary, true)
    assert.equal(stats[2]!.oldPath, 'old name.ts')
    assert.equal(stats[2]!.path, 'new name.ts')

    const statuses = parseNameStatusZ(nameStatus)
    assert.equal(statuses.find((s) => s.path === 'new name.ts')?.status, 'R')
    assert.equal(statuses.find((s) => s.path === 'new name.ts')?.oldPath, 'old name.ts')
    assert.equal(statuses.find((s) => s.path === 'symlink-or-mode.ts')?.status, 'M')
    assert.equal(statuses.find((s) => s.path === 'unmerged.ts')?.status, 'M')

    const extraUntracked = Array.from({ length: 10 }, (_, i) => `z-${String(i).padStart(2, '0')}.txt`)
    const merged = mergeDiffFileEntries(stats, statuses, extraUntracked, 12, 6)
    assert.equal(merged.filesTruncated, true)
    assert.equal(merged.files.length, 6)
    assert.equal(merged.summary.totalFiles, 15)
    assert.equal(merged.summary.additions, 15)
    assert.equal(merged.summary.deletions, 2)
    assert.equal(merged.summary.untrackedCount, 10)
    assert.equal(merged.summary.dirtyFileCount, 12)
  })

  it('parseGitLogZ marks unpushed commits and detects maxCommits truncation', { timeout: 60_000 }, () => {
    const raw = [
      ['aaa'.repeat(13) + 'a', 'aaaaaaa', 'feat: third', 'Alice', '1700000300'].join('\x1f'),
      ['bbb'.repeat(13) + 'b', 'bbbbbbb', 'fix: second', 'Bob', '1700000200'].join('\x1f'),
      ['ccc'.repeat(13) + 'c', 'ccccccc', 'chore: first', 'Carol', '1700000100'].join('\x1f'),
      '',
    ].join('\0')
    const unpushed = new Set(['aaa'.repeat(13) + 'a'])
    const parsed = parseGitLogZ(raw, 2, unpushed)
    assert.equal(parsed.commitsTruncated, true)
    assert.equal(parsed.commits.length, 2)
    assert.equal(parsed.commits[0]!.unpushed, true)
    assert.equal(parsed.commits[0]!.committedAt, 1_700_000_300_000)
    assert.equal(parsed.commits[1]!.unpushed, undefined)
  })

  it('parseUnifiedDiffHunks parses add/remove/context line numbers accurately and skips no-newline markers', {
    timeout: 60_000,
  }, () => {
    const patch = [
      'diff --git a/foo.ts b/foo.ts',
      'index 111..222 100644',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -10,4 +10,5 @@ export function demo() {',
      ' const keep = 1',
      '-const oldVal = "alpha"',
      '+const newVal = "beta"',
      '+const extra = true',
      ' return keep',
      '\\ No newline at end of file',
      '',
    ].join('\n')
    const hunks = parseUnifiedDiffHunks(patch)
    assert.equal(hunks.length, 1)
    assert.equal(hunks[0]!.rows.length, 5)
    assert.deepEqual(hunks[0]!.rows[0], { kind: 'context', oldLine: 10, newLine: 10, text: 'const keep = 1' })
    assert.deepEqual(hunks[0]!.rows[1], { kind: 'remove', oldLine: 11, text: 'const oldVal = "alpha"' })
    assert.deepEqual(hunks[0]!.rows[2], { kind: 'add', newLine: 11, text: 'const newVal = "beta"' })
    assert.deepEqual(hunks[0]!.rows[3], { kind: 'add', newLine: 12, text: 'const extra = true' })
    assert.deepEqual(hunks[0]!.rows[4], { kind: 'context', oldLine: 12, newLine: 13, text: 'return keep' })
  })

  it('computeWordDiffSegments reconstructs lines verbatim and returns undefined above char budget', {
    timeout: 60_000,
  }, () => {
    const oldText = 'const answer = oldValue + 1'
    const newText = 'const answer = newValue + 2'
    const res = computeWordDiffSegments(oldText, newText)
    assert.ok(res !== undefined)
    assert.equal(res.oldSegments.map((s) => s.text).join(''), oldText)
    assert.equal(res.newSegments.map((s) => s.text).join(''), newText)
    assert.ok(res.oldSegments.some((s) => s.changed && s.text.includes('oldValue')))
    assert.ok(res.newSegments.some((s) => s.changed && s.text.includes('newValue')))

    const decorated = decorateHunksWithWordDiff([
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        header: '@@ -1 +1 @@',
        rows: [
          { kind: 'remove', oldLine: 1, text: oldText },
          { kind: 'add', newLine: 1, text: newText },
        ],
      },
    ])
    assert.ok(decorated[0]!.rows[0]!.word !== undefined)
    assert.ok(decorated[0]!.rows[1]!.word !== undefined)

    assert.equal(computeWordDiffSegments('a'.repeat(3000), 'b'.repeat(3000)), undefined)
  })

  it('buildChangesScreenTarget & formatInspectGitCommand omit empty params cleanly', { timeout: 60_000 }, () => {
    assert.equal(buildChangesScreenTarget({}), 'screen:builtin:changes/inspector')
    assert.equal(
      buildChangesScreenTarget({ conv: 5, scope: 'since', base: 'abc1234', file: 'src/a.ts' }),
      'screen:builtin:changes/inspector?conv=5&scope=since&base=abc1234&file=src%2Fa.ts',
    )
    assert.equal(
      formatInspectGitCommand({ filePath: 'src/a.ts', diffBase: 'upstream' }),
      'git diff @{upstream}..HEAD -- "src/a.ts"',
    )
    assert.equal(
      formatInspectGitCommand({ filePath: 'src/a.ts', diffBase: 'commit', selectedCommit: 'deadbeef' }),
      'git show deadbeef -- "src/a.ts"',
    )
  })
})
