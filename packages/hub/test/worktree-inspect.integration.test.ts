/**
 * Integration tests for `builtin:worktree` two-step read-only managed worktree inspection
 * (`list_worktrees` / `inspect_worktree` / `inspect_worktree_file`).
 *
 * Covers (via real `createHelmx` + faux model + temp real Git repo + public plugin actions):
 * 1. Real `spawnAgent` with `isolation: 'worktree'` returns registered metadata in `list_worktrees`;
 * 2. `inspect_worktree` (exact `worktreeId`) returns structured `summary`, `files`, `commits`, `commitsAhead`, `unmergedCommits` across `all` / `committed` / `uncommitted` scopes;
 * 3. `inspect_worktree_file` returns parsed hunks for modified/added files and bounded untracked previews;
 * 4. Honest boundaries: unregistered path 404, mutually exclusive/empty selectors 400, cleaned-up record returns `unavailableReason = 'removed'` and `inspect_worktree_file` returns 409;
 * 5. `conversationId` selector resolves the same record;
 * 6. Scale & `output_limit_exceeded` immunity: a worktree containing a > 1.2 MiB tracked diff NEVER aborts `inspect_worktree`, still loads normal files via `inspect_worktree_file`, and returns `{ kind: 'too_large' }` for the huge file; > 500 untracked files cap list at 500 with `filesTruncated = true` and true `dirtyFileCount`.
 */
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { AgentExecutionInfo, AgentSpawnRequest } from '@helmx/protocol'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HelmxError } from '@helmx/protocol'
import { extractWorktreeExecutionMeta, type GitDiffFileResult, type WorktreeInspectResult } from '@helmx/plugins/contracts'
import {
  createGitTemplate,
  createHubTestApp,
  type FauxProviderHandle,
  type GitTemplate,
  type HubTestApp,
} from './helpers/hub-test-env.js'

function worktreeOf(info: AgentExecutionInfo | undefined) {
  return info === undefined ? undefined : extractWorktreeExecutionMeta(info).worktree
}

const PROCESS_SCAN_ON = process.platform === 'linux'

let rootDir: string
let gitTemplate: GitTemplate

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helmx-worktree-inspect-'))
  gitTemplate = createGitTemplate('helmx-worktree-inspect-tpl-')
}, { timeout: 60_000 })

after(() => {
  gitTemplate?.cleanup()
  rmSync(rootDir, { recursive: true, force: true })
}, { timeout: 60_000 })

interface RuntimeEnv {
  app: HubTestApp
  kernel: HubTestApp['kernel']
  faux: FauxProviderHandle
  invoke: {
    listWorktrees(): Promise<Array<Record<string, unknown>>>
    inspectWorktree(input: Record<string, unknown>): Promise<WorktreeInspectResult>
    inspectWorktreeFile(input: Record<string, unknown>): Promise<GitDiffFileResult>
    cleanupWorktree(input: Record<string, unknown>): Promise<Record<string, unknown>>
  }
  close(): Promise<void>
}

async function openRuntime(dataDir: string, cwd: string): Promise<RuntimeEnv> {
  const { app, kernel, faux } = await createHubTestApp({
    dataDir,
    cwd,
  })
  return {
    app,
    kernel,
    faux,
    invoke: {
      listWorktrees: async (): Promise<Array<Record<string, unknown>>> => {
        const result = (await kernel.plugins.invokeAction('builtin:worktree', 'list_worktrees', {})) as {
          worktrees: Array<Record<string, unknown>>
        }
        return result.worktrees
      },
      inspectWorktree: (input) =>
        kernel.plugins.invokeAction('builtin:worktree', 'inspect_worktree', input) as Promise<WorktreeInspectResult>,
      inspectWorktreeFile: (input) =>
        kernel.plugins.invokeAction('builtin:worktree', 'inspect_worktree_file', input) as Promise<GitDiffFileResult>,
      cleanupWorktree: (input) =>
        kernel.plugins.invokeAction('builtin:worktree', 'cleanup_worktree', input) as never,
    },
    async close() {
      await app.close().catch(() => {})
    },
  }
}

async function spawnCleanWorktree(env: RuntimeEnv): Promise<{ worktreeId: string; path: string; branch: string }> {
  let resolved: AgentExecutionInfo | undefined
  env.faux.setResponses([fauxAssistantMessage('directly complete, without tool invoke')])
  await env.kernel.agentSpawn.spawnAgent({
    parentConversationId: 1,
    prompt: 'in isolated worktree execute task',
    isolation: 'worktree',
    onResolved: (info) => {
      resolved = info
    },
  } as AgentSpawnRequest)
  const worktree = worktreeOf(resolved)
  assert.ok(worktree?.id, 'should return managed worktree id')
  return {
    worktreeId: worktree!.id!,
    path: worktree!.path,
    branch: worktree!.branch,
  }
}

describe('builtin:worktree managed worktree read-only inspection actions', { timeout: 60_000 }, () => {
  it('lists real metadata after spawn and inspects real structured summary, commits, scopes, and file diffs', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't1')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      let resolved: AgentExecutionInfo | undefined
      env.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'pwd > .helmx-child-pwd.txt' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('task complete'),
      ])
      await env.kernel.agentSpawn.spawnAgent({
        parentConversationId: 1,
        prompt: 'in isolated worktree execute task',
        isolation: 'worktree',
        onResolved: (info) => {
          resolved = info
        },
      } as AgentSpawnRequest)
      assert.ok(worktreeOf(resolved)?.id, 'should return managed worktree id')
      const worktreeId = worktreeOf(resolved)!.id!
      const path = worktreeOf(resolved)!.path
      const branch = worktreeOf(resolved)!.branch
      const childId = resolved!.conversationId!

      const list = await env.invoke.listWorktrees()
      assert.ok(Array.isArray(list) && list.length === 1)
      const record = list[0]!
      assert.equal(record['id'], worktreeId)
      assert.equal(record['conversationId'], childId)

      writeFileSync(join(path, 'draft.txt'), 'uncommitted draft\n')
      const git = (args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf-8' })
      writeFileSync(join(path, 'feature.txt'), 'committed change\nsecond line\n')
      git(['add', 'feature.txt'])
      git(['commit', '-qm', 'feat: one commit'])

      const inspect = await env.invoke.inspectWorktree({ worktreeId })
      assert.equal(inspect.exists, true)
      assert.equal(inspect.unavailableReason, undefined)
      assert.equal(inspect.currentBranch, branch)
      assert.equal(inspect.branchChanged, undefined)
      assert.equal(inspect.diffBase, 'baseCommit')
      assert.equal(inspect.scope, 'all')
      assert.equal(inspect.commitsAhead, 1)
      assert.equal(inspect.unmergedCommits, 1)
      assert.equal(inspect.commits.length, 1)
      assert.equal(inspect.commits[0]!.subject, 'feat: one commit')
      assert.equal(inspect.summary.dirtyFileCount, 2)
      assert.equal(inspect.summary.untrackedCount, 2)
      assert.equal(inspect.summary.totalFiles, 3)
      assert.equal(inspect.summary.additions, 2)

      assert.ok(inspect.files.some((f) => f.path === 'feature.txt' && f.status === 'A' && f.additions === 2))
      assert.ok(inspect.files.some((f) => f.path === 'draft.txt' && f.status === 'U' && f.untracked))
      assert.ok(inspect.files.some((f) => f.path === '.helmx-child-pwd.txt' && f.status === 'U' && f.untracked))

      // Single-file diff for committed tracked file
      const trackedFile = await env.invoke.inspectWorktreeFile({ worktreeId, filePath: 'feature.txt' })
      assert.equal(trackedFile.kind, 'diff')
      if (trackedFile.kind === 'diff') {
        assert.equal(trackedFile.status, 'A')
        assert.ok(trackedFile.hunks.some((h) => h.rows.some((r) => r.kind === 'add' && r.text === 'committed change')))
      }

      // Single-file preview for untracked file
      const untrackedFile = await env.invoke.inspectWorktreeFile({ worktreeId, filePath: 'draft.txt' })
      assert.equal(untrackedFile.kind, 'untracked')
      if (untrackedFile.kind === 'untracked') {
        assert.equal(untrackedFile.status, 'U')
        assert.equal(untrackedFile.additions, 1)
        assert.equal(untrackedFile.hunks[0]!.rows[0]!.text, 'uncommitted draft')
      }

      // Scope filtering: committed excludes untracked; uncommitted excludes feature.txt
      const committedScope = await env.invoke.inspectWorktree({ worktreeId, scope: 'committed' })
      assert.equal(committedScope.files.length, 1)
      assert.equal(committedScope.files[0]!.path, 'feature.txt')
      const uncommittedScope = await env.invoke.inspectWorktree({ worktreeId, scope: 'uncommitted' })
      assert.ok(!uncommittedScope.files.some((f) => f.path === 'feature.txt'))
      assert.ok(uncommittedScope.files.some((f) => f.path === 'draft.txt'))

      // conversationId selector resolves the same record
      const byConversation = await env.invoke.inspectWorktree({ conversationId: childId })
      assert.equal(byConversation.record.id, worktreeId)

      // Read-only invariant
      assert.equal(existsSync(join(path, 'draft.txt')), true)
      assert.equal(existsSync(join(path, 'feature.txt')), true)

      // Merge branch into main repo -> unmergedCommits drops to 0 while commitsAhead stays 1
      execFileSync('git', ['merge', '--no-ff', branch, '-m', 'merge worker branch'], { cwd: repo, encoding: 'utf-8' })
      const afterMerge = await env.invoke.inspectWorktree({ worktreeId })
      assert.equal(afterMerge.commitsAhead, 1)
      assert.equal(afterMerge.unmergedCommits, 0)
    } finally {
      await env.close()
    }
  })

  it('honest boundaries: unregistered path 404, mutually exclusive/empty selectors 400, cleaned-up record returns metadata only', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't2')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      const { worktreeId, path } = await spawnCleanWorktree(env)

      await assert.rejects(
        () => env.invoke.inspectWorktree({ path: repo }),
        (err: unknown) => err instanceof Error && /\bnot_found\b|未找到路径/.test(err.message),
      )
      await assert.rejects(
        () => env.invoke.inspectWorktree({}),
        (err: unknown) => err instanceof Error && /需提供|validation_error/.test(err.message),
      )
      await assert.rejects(
        () => env.invoke.inspectWorktree({ worktreeId, path }),
        (err: unknown) => err instanceof Error && /互斥|validation_error/.test(err.message),
      )
      await assert.rejects(
        () => env.invoke.inspectWorktree({ nodeId: 'local' }),
        (err: unknown) => err instanceof Error && /需提供|仅与 path 搭配|validation_error/.test(err.message),
      )
      await assert.rejects(
        () => env.invoke.inspectWorktreeFile({ worktreeId, filePath: '../outside.txt' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
      )

      if (PROCESS_SCAN_ON) {
        await env.invoke.cleanupWorktree({ worktreeId, force: true })
      } else {
        await assert.rejects(
          () => env.invoke.cleanupWorktree({ worktreeId, force: true }),
          (err: unknown) => {
            assert.ok(err instanceof HelmxError)
            assert.equal(err.code, 'worktree_usage_unverifiable')
            assert.equal(err.status, 501)
            return true
          },
        )
        await env.close()
        return
      }
      const after = await env.invoke.inspectWorktree({ worktreeId })
      assert.equal(after.exists, false)
      assert.equal(after.unavailableReason, 'removed')
      assert.equal(after.record.status, 'removed')
      assert.deepEqual(after.files, [])

      await assert.rejects(
        () => env.invoke.inspectWorktreeFile({ worktreeId, filePath: 'README.md' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'worktree_missing',
      )
    } finally {
      await env.close()
    }
  })

  it('tracks staged, unstaged, renamed, and untracked-only files cleanly via -z summary', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't3')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      const { worktreeId, path } = await spawnCleanWorktree(env)
      const git = (args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf-8' })

      writeFileSync(join(path, 'feature.txt'), 'v1\n')
      git(['add', 'feature.txt'])
      git(['commit', '-qm', 'feat: tracked file'])
      writeFileSync(join(path, 'feature.txt'), 'v2 unstaged body\n')
      writeFileSync(join(path, 'staged.txt'), 'staged new body\n')
      git(['add', 'staged.txt'])
      writeFileSync(join(path, 'README.md'), '# repo modified\n')
      git(['add', 'README.md'])
      writeFileSync(join(path, 'untracked.txt'), 'only untracked body\n')

      const inspect = await env.invoke.inspectWorktree({ worktreeId })
      assert.equal(inspect.summary.dirtyFileCount, 4)
      assert.equal(inspect.summary.untrackedCount, 1)
      assert.equal(inspect.filesTruncated, false)
      assert.ok(inspect.files.some((f) => f.path === 'feature.txt' && f.status === 'A'))
      assert.ok(inspect.files.some((f) => f.path === 'staged.txt' && f.status === 'A'))
      assert.ok(inspect.files.some((f) => f.path === 'README.md' && f.status === 'M'))
      assert.ok(inspect.files.some((f) => f.path === 'untracked.txt' && f.status === 'U' && f.untracked))

      const fDiff = await env.invoke.inspectWorktreeFile({ worktreeId, filePath: 'feature.txt' })
      assert.equal(fDiff.kind, 'diff')
      if (fDiff.kind === 'diff') {
        assert.ok(fDiff.hunks.some((h) => h.rows.some((r) => r.kind === 'add' && r.text === 'v2 unstaged body')))
      }
    } finally {
      await env.close()
    }
  })

  it('survives >1.2 MiB repo diff without output_limit_exceeded, loads small files, rejects huge file with too_large, and preserves true dirtyFileCount over 500 files', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't5')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      const { worktreeId, path } = await spawnCleanWorktree(env)
      const git = (args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf-8' })

      // Create >1.2 MiB tracked addition (~5,200 lines * ~260 bytes = ~1.35 MiB > 1 MiB runShell limit).
      const bigBody = Array.from({ length: 5_200 }, (_, i) => `line-${String(i).padStart(4, '0')}-${'x'.repeat(250)}`).join('\n')
      writeFileSync(join(path, 'huge-generated.txt'), `${bigBody}\n`)
      writeFileSync(join(path, 'small-ok.txt'), 'hello small change\n')
      git(['add', 'huge-generated.txt', 'small-ok.txt'])
      git(['commit', '-qm', 'feat: large bundle plus small fix'])

      // Also create 505 untracked files (> MAX_SUMMARY_FILES=500).
      for (let i = 0; i < 505; i++) {
        writeFileSync(join(path, `u-${String(i).padStart(3, '0')}.txt`), 'x\n')
      }

      // 1) Summary succeeds without output_limit_exceeded!
      const inspect = await env.invoke.inspectWorktree({ worktreeId })
      assert.equal(inspect.exists, true)
      assert.equal(inspect.filesTruncated, true)
      assert.equal(inspect.files.length, 500)
      assert.equal(inspect.summary.dirtyFileCount, 505)
      assert.equal(inspect.summary.totalFiles, 507)
      assert.ok(inspect.files.some((f) => f.path === 'huge-generated.txt' && f.additions === 5_200))
      assert.ok(inspect.files.some((f) => f.path === 'small-ok.txt' && f.additions === 1))

      // 2) Normal small file loads cleanly despite >1.2 MiB sibling file in same worktree
      const smallDiff = await env.invoke.inspectWorktreeFile({ worktreeId, filePath: 'small-ok.txt' })
      assert.equal(smallDiff.kind, 'diff')
      if (smallDiff.kind === 'diff') {
        assert.equal(smallDiff.hunks[0]!.rows[0]!.text, 'hello small change')
      }

      // 3) Huge file returns honest too_large outcome instead of crashing
      const hugeDiff = await env.invoke.inspectWorktreeFile({ worktreeId, filePath: 'huge-generated.txt' })
      assert.equal(hugeDiff.kind, 'too_large')
      if (hugeDiff.kind === 'too_large') {
        assert.equal(hugeDiff.reason, 'line_budget_exceeded')
        assert.equal(hugeDiff.additions, 5_200)
      }
    } finally {
      await env.close()
    }
  })
})
