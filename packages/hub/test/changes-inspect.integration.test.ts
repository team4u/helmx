/**
 * Integration tests for `builtin:changes` (`inspect_workspace` / `inspect_workspace_file`).
 *
 * Exercises real Git repositories via `createHubTestApp`:
 * - `working`: staged + unstaged + untracked summary & per-file diff/untracked previews;
 * - `unpushed`: local bare remote tracking, `commitsAheadOfUpstream`, unpushed files & `unpushed` commit badge;
 * - `commit`: inspecting both a regular commit and the root commit (`EMPTY_TREE_SHA` fallback);
 * - `since`: diffing from a chosen baseline commit to working tree, plus 400 validation when `baseCommit` is omitted;
 * - Non-Git workspace reporting `{ isGitRepo: false, nonGitReason: 'not_a_git_repo' }`;
 * - Edge file outcomes: `binary`, `too_large` (> 1.2 MiB file without aborting summary or sibling small file),
 *   and `special_file` (`symlink_outside_repo` for external symlinks);
 * - Independence: disabling `builtin:worktree` leaves `builtin:changes` working normally.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HelmxError } from '@helmx/protocol'
import type { GitDiffFileResult, WorkspaceInspectResult } from '@helmx/plugins/contracts'
import {
  createGitTemplate,
  createHubTestApp,
  useTempDir,
  type GitTemplate,
} from './helpers/hub-test-env.js'

let gitTemplate: GitTemplate

before(() => {
  gitTemplate = createGitTemplate('helmx-changes-inspect-tpl-')
}, { timeout: 60_000 })

after(() => {
  gitTemplate?.cleanup()
}, { timeout: 60_000 })

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

describe('builtin:changes read-only workspace inspection actions', { timeout: 60_000 }, () => {
  it('supports working / unpushed / commit (including root commit) / since scopes via real bare remote', {
    timeout: 60_000,
  }, async (t) => {
    const root = useTempDir(t, 'helmx-changes-scopes-')
    const repo = gitTemplate.cloneTo(join(root, 'repo'))
    const bare = join(root, 'origin.git')
    git(root, ['init', '--bare', bare])
    git(repo, ['remote', 'add', 'origin', bare])
    const baseBranch = git(repo, ['branch', '--show-current']).trim()
    git(repo, ['push', '-u', 'origin', baseBranch])
    const rootCommit = git(repo, ['rev-parse', 'HEAD']).trim()

    // Commit 1 (pushed)
    writeFileSync(join(repo, 'a.txt'), 'a1\n')
    git(repo, ['add', 'a.txt'])
    git(repo, ['commit', '-qm', 'feat: pushed commit'])
    const pushedSha = git(repo, ['rev-parse', 'HEAD']).trim()
    git(repo, ['push'])

    // Commit 2 (unpushed local commit)
    writeFileSync(join(repo, 'a.txt'), 'a2\n')
    writeFileSync(join(repo, 'b.txt'), 'b1\n')
    git(repo, ['add', 'a.txt', 'b.txt'])
    git(repo, ['commit', '-qm', 'feat: unpushed commit'])
    const unpushedSha = git(repo, ['rev-parse', 'HEAD']).trim()

    // Working changes (staged + unstaged + untracked)
    writeFileSync(join(repo, 'a.txt'), 'a3-working\n')
    writeFileSync(join(repo, 'staged.txt'), 'staged content\n')
    git(repo, ['add', 'staged.txt'])
    writeFileSync(join(repo, 'notes.md'), 'untracked note\n')

    const { app, kernel } = await createHubTestApp({ dataDir: join(root, 'data'), cwd: repo })
    try {
      // 1) working scope
      const working = (await kernel.plugins.invokeAction('builtin:changes', 'inspect_workspace', {
        conversationId: 1,
        scope: 'working',
      })) as WorkspaceInspectResult
      assert.equal(working.isGitRepo, true)
      if (!working.isGitRepo) return
      assert.equal(working.currentBranch, baseBranch)
      assert.equal(working.commitsAheadOfUpstream, 1)
      assert.equal(working.summary.dirtyFileCount, 3)
      assert.equal(working.summary.untrackedCount, 1)
      assert.ok(working.files.some((f) => f.path === 'a.txt' && f.status === 'M'))
      assert.ok(working.files.some((f) => f.path === 'staged.txt' && f.status === 'A'))
      assert.ok(working.files.some((f) => f.path === 'notes.md' && f.status === 'U' && f.untracked))
      assert.equal(working.commits[0]!.oid, unpushedSha)
      assert.equal(working.commits[0]!.unpushed, true)
      assert.equal(working.commits[1]!.unpushed, undefined)

      const untrackedPreview = (await kernel.plugins.invokeAction('builtin:changes', 'inspect_workspace_file', {
        conversationId: 1,
        filePath: 'notes.md',
        scope: 'working',
      })) as GitDiffFileResult
      assert.equal(untrackedPreview.kind, 'untracked')
      if (untrackedPreview.kind === 'untracked') {
        assert.equal(untrackedPreview.hunks[0]!.rows[0]!.text, 'untracked note')
      }

      // 2) unpushed scope
      const unpushed = (await kernel.plugins.invokeAction('builtin:changes', 'inspect_workspace', {
        conversationId: 1,
        scope: 'unpushed',
      })) as WorkspaceInspectResult
      assert.equal(unpushed.isGitRepo, true)
      if (!unpushed.isGitRepo) return
      assert.equal(unpushed.diffBase, 'upstream')
      assert.ok(unpushed.files.some((f) => f.path === 'b.txt' && f.status === 'A'))
      assert.ok(!unpushed.files.some((f) => f.path === 'notes.md'))

      const unpushedFile = (await kernel.plugins.invokeAction('builtin:changes', 'inspect_workspace_file', {
        conversationId: 1,
        filePath: 'b.txt',
        scope: 'unpushed',
      })) as GitDiffFileResult
      assert.equal(unpushedFile.kind, 'diff')

      // 3) commit scope (regular commit + root commit via EMPTY_TREE_SHA)
      const commitSummary = (await kernel.plugins.invokeAction('builtin:changes', 'inspect_workspace', {
        conversationId: 1,
        scope: 'commit',
        commit: pushedSha,
      })) as WorkspaceInspectResult
      assert.equal(commitSummary.isGitRepo, true)
      if (commitSummary.isGitRepo) {
        assert.equal(commitSummary.selectedCommit, pushedSha)
        assert.ok(commitSummary.files.some((f) => f.path === 'a.txt' && f.status === 'A'))
      }

      const rootFile = (await kernel.plugins.invokeAction('builtin:changes', 'inspect_workspace_file', {
        conversationId: 1,
        filePath: 'README.md',
        scope: 'commit',
        commit: rootCommit,
      })) as GitDiffFileResult
      assert.equal(rootFile.kind, 'diff', 'root commit without parent should diff against EMPTY_TREE_SHA')

      // 4) since scope
      const since = (await kernel.plugins.invokeAction('builtin:changes', 'inspect_workspace', {
        conversationId: 1,
        scope: 'since',
        baseCommit: pushedSha,
      })) as WorkspaceInspectResult
      assert.equal(since.isGitRepo, true)
      if (since.isGitRepo) {
        assert.equal(since.diffBase, 'baseCommit')
        assert.equal(since.baseCommit, pushedSha)
        assert.ok(since.files.some((f) => f.path === 'b.txt'))
        assert.ok(since.files.some((f) => f.path === 'notes.md' && f.untracked))
      }

      // Missing baseCommit on since -> 400 validation_error
      await assert.rejects(
        () =>
          kernel.plugins.invokeAction('builtin:changes', 'inspect_workspace', {
            conversationId: 1,
            scope: 'since',
          }),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
      )
    } finally {
      await app.close()
    }
  })

  it('handles non-Git dirs, binary files, >1.2 MiB diffs, external symlinks, and stays working when builtin:worktree is disabled', {
    timeout: 60_000,
  }, async (t) => {
    const root = useTempDir(t, 'helmx-changes-edges-')
    const repo = gitTemplate.cloneTo(join(root, 'repo'))
    const nonGitDir = join(root, 'plain-dir')
    const outsideFile = join(root, 'outside-secret.txt')
    mkdirSync(nonGitDir, { recursive: true })
    writeFileSync(outsideFile, 'outside content\n')

    // Binary + >1.2 MiB tracked file + normal small file + external untracked symlink
    writeFileSync(join(repo, 'image.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]))
    const hugeLines = Array.from({ length: 5_200 }, (_, i) => `l-${String(i).padStart(4, '0')}-${'y'.repeat(250)}`).join('\n')
    writeFileSync(join(repo, 'bundle.js'), `${hugeLines}\n`)
    writeFileSync(join(repo, 'clean-edit.ts'), 'export const ok = true\n')
    git(repo, ['add', 'image.bin', 'bundle.js', 'clean-edit.ts'])
    symlinkSync(outsideFile, join(repo, 'escape-link.txt'))

    const { app, kernel } = await createHubTestApp({ dataDir: join(root, 'data'), cwd: repo })
    try {
      const nonGitConv = await kernel.conversations.createConversation({ title: 'plain', cwd: nonGitDir })
      const nonGitRes = (await kernel.plugins.invokeAction('builtin:changes', 'inspect_workspace', {
        conversationId: nonGitConv.id,
      })) as WorkspaceInspectResult
      assert.equal(nonGitRes.isGitRepo, false)
      if (!nonGitRes.isGitRepo) {
        assert.equal(nonGitRes.nonGitReason, 'not_a_git_repo')
      }

      // Summary succeeds with >1.2 MiB staged diff
      const summary = (await kernel.plugins.invokeAction('builtin:changes', 'inspect_workspace', {
        conversationId: 1,
        scope: 'working',
      })) as WorkspaceInspectResult
      assert.equal(summary.isGitRepo, true)
      if (!summary.isGitRepo) return
      assert.ok(summary.files.some((f) => f.path === 'bundle.js' && f.additions === 5_200))
      assert.ok(summary.files.some((f) => f.path === 'image.bin' && f.binary))
      assert.ok(summary.files.some((f) => f.path === 'clean-edit.ts' && f.additions === 1))

      // Normal file works, binary returns binary, huge returns too_large, outside symlink returns special_file
      const smallRes = (await kernel.plugins.invokeAction('builtin:changes', 'inspect_workspace_file', {
        conversationId: 1,
        filePath: 'clean-edit.ts',
      })) as GitDiffFileResult
      assert.equal(smallRes.kind, 'diff')

      const binRes = (await kernel.plugins.invokeAction('builtin:changes', 'inspect_workspace_file', {
        conversationId: 1,
        filePath: 'image.bin',
      })) as GitDiffFileResult
      assert.equal(binRes.kind, 'binary')

      const hugeRes = (await kernel.plugins.invokeAction('builtin:changes', 'inspect_workspace_file', {
        conversationId: 1,
        filePath: 'bundle.js',
      })) as GitDiffFileResult
      assert.equal(hugeRes.kind, 'too_large')
      if (hugeRes.kind === 'too_large') {
        assert.equal(hugeRes.reason, 'line_budget_exceeded')
      }

      const symlinkRes = (await kernel.plugins.invokeAction('builtin:changes', 'inspect_workspace_file', {
        conversationId: 1,
        filePath: 'escape-link.txt',
      })) as GitDiffFileResult
      assert.equal(symlinkRes.kind, 'special_file')
      if (symlinkRes.kind === 'special_file') {
        assert.equal(symlinkRes.fileKind, 'symlink_outside_repo')
      }

      // Disable builtin:worktree -> builtin:changes remains active and functional
      await kernel.plugins.disable('builtin:worktree', { force: true })
      const afterDisable = (await kernel.plugins.invokeAction('builtin:changes', 'inspect_workspace', {
        conversationId: 1,
        scope: 'working',
      })) as WorkspaceInspectResult
      assert.equal(afterDisable.isGitRepo, true)
    } finally {
      await app.close()
    }
  })
})
