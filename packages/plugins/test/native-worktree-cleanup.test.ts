/**
 * cleanup_worktree、目录缺失恢复、归属防挪用加固、mergedInto 参考提交优先级与 pruneConversation 裁剪测试。
 */
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { HelmxError, validateOrThrow, type AgentExecutionInfo } from '@helmx/protocol'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { type ManagedWorktreeRecord } from '../src/worktree/worktree.js'
import {
  AGENT_BINDINGS_KV_NAMESPACE,
  LEASES_KV_NAMESPACE,
  WORKTREES_KV_NAMESPACE,
} from '../src/worktree/worktree-store.js'
import { cleanupPresentationMetaSchema } from '../src/worktree/actions.js'
import {
  createGitTemplate,
  MemoryKvStore,
  type GitTemplate,
} from './helpers/plugin-test-env.js'
import {
  assertCleanupPlatformRejected,
  bareAllocator,
  executeCleanupTool,
  leasesOf,
  openSpawnHarness,
  PROCESS_SCAN_ON,
  rawRecords,
} from './helpers/native-worktree-harness.js'

let rootDir: string
let gitTemplate: GitTemplate

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helmx-native-worktree-cleanup-'))
  gitTemplate = createGitTemplate('helmx-native-wt-cleanup-tpl-')
}, { timeout: 60_000 })

after(() => {
  gitTemplate.cleanup()
  rmSync(rootDir, { recursive: true, force: true })
}, { timeout: 60_000 })

function makeGitRepo(dir: string): string {
  return gitTemplate.cloneTo(dir)
}

describe('cleanup_worktree 安全与清理全链路', { concurrency: 4, timeout: 60_000 }, () => {
describe('cleanup_worktree', { concurrency: 4, timeout: 60_000 }, () => {
  it('脏工作区（未提交文件）force=false 显式拒绝 worktree_dirty', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't6a')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let childId = 0
      th.faux.setResponses([fauxAssistantMessage('完成')])
      await th.spawnIsolated({
        parentConversationId: 1,
        prompt: '任务',
        isolation: 'worktree',
        onResolved: (info: AgentExecutionInfo) => {
          childId = info.conversationId ?? 0
        },
      } as never)
      const record = th.allocator.getForConversation(childId)
      assert.ok(record)
      // worktree 内制造未提交修改。
      writeFileSync(join(record!.path, 'wip.txt'), 'uncommitted\n')
      th.markIdle(childId)

      await assert.rejects(
        () => th.allocator.cleanup({ conversationId: childId }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_dirty')
          const details = err.details as { dirtyFiles?: string[] }
          assert.ok(details?.dirtyFiles?.some((f) => f.includes('wip.txt')), 'details 应列出脏文件')
          return true
        },
      )
      // 目录仍在（拒绝即不动）。
      assert.ok(existsSync(record!.path), '拒绝清理时 worktree 不得被移除')
    } finally {
      await th.close()
    }
  })

  it('未合入提交（分支领先主仓 HEAD）force=false 显式拒绝 worktree_dirty', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't6b')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let childId = 0
      th.faux.setResponses([fauxAssistantMessage('完成')])
      await th.spawnIsolated({
        parentConversationId: 1,
        prompt: '任务',
        isolation: 'worktree',
        onResolved: (info: AgentExecutionInfo) => {
          childId = info.conversationId ?? 0
        },
      } as never)
      const record = th.allocator.getForConversation(childId)
      assert.ok(record)
      // worktree 内提交一个 commit（分支领先，未合入主仓）。
      writeFileSync(join(record!.path, 'feature.txt'), 'x\n')
      execFileSync('git', ['add', '.'], { cwd: record!.path })
      execFileSync('git', ['commit', '-qm', 'feature'], { cwd: record!.path })
      th.markIdle(childId)

      await assert.rejects(
        () => th.allocator.cleanup({ conversationId: childId, deleteBranch: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_dirty')
          const details = err.details as { unmergedCommits?: number }
          assert.ok((details?.unmergedCommits ?? 0) >= 1, 'details 应报告未合入提交数')
          return true
        },
      )
    } finally {
      await th.close()
    }
  })

  it('force: true + deleteBranch: true 成功移除 worktree 与分支；记录置 removed；二次清理幂等', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't6c')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let childId = 0
      th.faux.setResponses([fauxAssistantMessage('完成')])
      await th.spawnIsolated({
        parentConversationId: 1,
        prompt: '任务',
        isolation: 'worktree',
        onResolved: (info: AgentExecutionInfo) => {
          childId = info.conversationId ?? 0
        },
      } as never)
      const record = th.allocator.getForConversation(childId)
      assert.ok(record)
      // 制造脏内容后 force 清理。
      writeFileSync(join(record!.path, 'wip.txt'), 'dirty\n')
      th.markIdle(childId)

      if (PROCESS_SCAN_ON) {
        const result = await th.allocator.cleanup({ conversationId: childId, deleteBranch: true, force: true })
        assert.equal(result.removed, true)
        assert.equal(result.branchDeleted, true)
        assert.equal(result.path, record!.path)
        assert.ok(!existsSync(record!.path), 'worktree 目录应被移除')
        // 分支已删除（git branch --list 无输出）。
        const branchList = execFileSync('git', ['branch', '--list', record!.branch], { cwd: repo, encoding: 'utf8' })
        assert.equal(branchList.trim(), '', `分支 ${record!.branch} 应已删除`)
        // 记录状态置 removed。
        const after = th.allocator.getForConversation(childId)
        assert.ok(after)
        assert.equal(after!.status, 'removed')
        assert.ok(after!.removedAt !== undefined)
        // 幂等：二次清理返回 removed: false。
        const again = await th.allocator.cleanup({ conversationId: childId })
        assert.equal(again.removed, false)
      } else {
        // 非 Linux：进程占用扫描不支持 → cleanup 显式拒绝（fail-closed，不伪造 0 占用）。
        await assertCleanupPlatformRejected(() => th.allocator.cleanup({ conversationId: childId, deleteBranch: true, force: true }))
        assert.ok(existsSync(record!.path), '拒绝清理时目录不得被移除')
      }
    } finally {
      await th.close()
    }
  })

  it('未登记路径显式 not_found（绝不误删外部目录）；缺参数 validation_error', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't6d')
    mkdirSync(dir, { recursive: true })
    const allocator = bareAllocator(new MemoryKvStore())
    try {
      // 人类自建目录（未登记）。
      const humanDir = join(dir, 'human-stuff')
      mkdirSync(humanDir, { recursive: true })
      await assert.rejects(
        () => allocator.cleanup({ path: humanDir }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'not_found')
          return true
        },
      )
      assert.ok(existsSync(humanDir), '未登记目录绝不被删除')

      // 缺参数。
      await assert.rejects(
        () => allocator.cleanup({}),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'validation_error')
          return true
        },
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('createCleanupWorktreeTool：脏工作区返回 isError + 清晰指引；成功返回 ok 摘要', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't6e')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let childId = 0
      th.faux.setResponses([fauxAssistantMessage('完成')])
      await th.spawnIsolated({
        parentConversationId: 1,
        prompt: '任务',
        isolation: 'worktree',
        onResolved: (info: AgentExecutionInfo) => {
          childId = info.conversationId ?? 0
        },
      } as never)
      const record = th.allocator.getForConversation(childId)
      assert.ok(record)
      writeFileSync(join(record!.path, 'wip.txt'), 'dirty\n')
      th.markIdle(childId)

      await assert.rejects(
        () => executeCleanupTool(th.kvStore, { conversationId: childId }),
        (err: unknown) =>
          err instanceof HelmxError &&
          err.code === 'worktree_dirty' &&
          (err.message.includes('worktree_dirty') || err.message.includes('未提交修改')),
      )

      const ok = await executeCleanupTool(th.kvStore, {
        conversationId: childId,
        deleteBranch: true,
        force: true,
      })
      assert.equal(ok.structuredOutput?.['removed'], true)
      assert.ok(ok.output[0]!.text.includes('已移除受管 worktree'))
      validateOrThrow(cleanupPresentationMetaSchema, ok.presentationMeta, 'cleanup success presentationMeta')
      assert.deepEqual(ok.presentationMeta, {
        removed: true,
        worktreeId: record!.id,
        path: record!.path,
        branch: record!.branch,
        nodeId: record!.nodeId,
        branchDeleted: true,
        processUsage: 'verified',
      })
    } finally {
      await th.close()
    }
  })

  it('cleanup_worktree 目录缺失 force 恢复路径：structuredOutput 保留 prune.output，presentationMeta 仅保留有界 pruneRan/pruneOk 索引', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't6f-meta')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let childId = 0
      th.faux.setResponses([fauxAssistantMessage('完成')])
      await th.spawnIsolated({
        parentConversationId: 1,
        prompt: '任务',
        isolation: 'worktree',
        onResolved: (info: AgentExecutionInfo) => {
          childId = info.conversationId ?? 0
        },
      } as never)
      const record = th.allocator.getForConversation(childId)
      assert.ok(record)
      th.markIdle(childId)
      rmSync(record!.path, { recursive: true, force: true })

      const res = await executeCleanupTool(th.kvStore, {
        worktreeId: record!.id,
        deleteBranch: true,
        force: true,
      })
      assert.equal(res.structuredOutput?.['removed'], true)
      assert.equal(res.structuredOutput?.['removedReason'], 'directory_missing_forced')
      assert.ok(typeof res.structuredOutput?.['prune'] === 'object', 'programmatic structuredOutput keeps prune object')
      assert.ok(res.output[0]!.text.includes('目录缺失恢复路径'))

      validateOrThrow(cleanupPresentationMetaSchema, res.presentationMeta, 'cleanup prune meta')
      assert.equal(res.presentationMeta?.['prune'], undefined, 'presentationMeta must NOT carry raw prune object/output')
      assert.deepEqual(res.presentationMeta, {
        removed: true,
        worktreeId: record!.id,
        path: record!.path,
        branch: record!.branch,
        nodeId: record!.nodeId,
        branchDeleted: true,
        removedReason: 'directory_missing_forced',
        pruneRan: true,
        pruneOk: true,
      })
      assert.throws(() =>
        validateOrThrow(
          cleanupPresentationMetaSchema,
          { ...res.presentationMeta, prune: { ran: true, ok: true, output: 'noisy' } },
          'reject raw prune field',
        ),
      )
    } finally {
      await th.close()
    }
  })
})

describe('同路径跨节点歧义', { timeout: 60_000 }, () => {
  it('多节点同名路径：未指定 nodeId 显式 validation_error；指定 nodeId 或 worktreeId 精确清理', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't8')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      const sharedPath = join(dir, 'shared-wt')
      execFileSync('git', ['worktree', 'add', sharedPath, '-b', 'helmx/spawn-m001'], { cwd: repo })
      const a: ManagedWorktreeRecord = {
        id: `local:${sharedPath}`,
        nodeId: 'local',
        path: sharedPath,
        branch: 'helmx/spawn-m001',
        repoRoot: repo,
        baseCommit: '',
        parentConversationId: 1,
        createdAt: 1,
        status: 'active',
        origin: 'native',
        dirtySource: false,
      }
      const b: ManagedWorktreeRecord = {
        ...a,
        id: `node-b:${sharedPath}`,
        nodeId: 'node-b',
      }
      docs.setParsed('builtin:worktree', WORKTREES_KV_NAMESPACE, a.id, a)
      docs.setParsed('builtin:worktree', WORKTREES_KV_NAMESPACE, b.id, b)

      await assert.rejects(
        () => allocator.cleanup({ path: sharedPath }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'validation_error')
          assert.ok(err.message.includes('local') && err.message.includes('node-b'), '错误应列出歧义节点')
          return true
        },
      )
      // findActive 同样拒绝歧义查询。
      assert.throws(() => allocator.findActive({ path: sharedPath }), (err: unknown) => {
        assert.ok(err instanceof HelmxError)
        assert.equal((err as HelmxError).code, 'validation_error')
        return true
      })
      // 指定 nodeId 精确清理 local 登记（local env 真实执行 git）。
      // 注：node-b 登记指向同一物理目录，local 清理成功后目录即消失，
      // node-b 记录保留 active（目录缺失场景另行显式报告，见 t10d）。
      if (PROCESS_SCAN_ON) {
        const result = await allocator.cleanup({ path: sharedPath, nodeId: 'local', deleteBranch: true })
        assert.equal(result.removed, true)
        assert.equal(rawRecords(docs).find((r) => r.id === a.id)!.status, 'removed')
        assert.equal(rawRecords(docs).find((r) => r.id === b.id)!.status, 'active', '其他节点登记不受影响')
      } else {
        await assertCleanupPlatformRejected(() => allocator.cleanup({ path: sharedPath, nodeId: 'local', deleteBranch: true }))
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('选择器互斥：worktreeId 与 conversationId/path 互斥；nodeId 仅搭 path；缺选择器 validation_error', { timeout: 60_000 }, async () => {
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    const cases: Array<Record<string, unknown>> = [
      { worktreeId: 'local:/x', conversationId: 1 },
      { worktreeId: 'local:/x', path: '/x' },
      { nodeId: 'local' },
      { conversationId: 1, path: '/x' },
      {},
    ]
    for (const input of cases) {
      await assert.rejects(
        () => allocator.cleanup(input as never),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'validation_error', `input=${JSON.stringify(input)}`)
          return true
        },
      )
    }
  })
})

describe('状态命令失败 fail closed', { timeout: 60_000 }, () => {
  it('git status 失败（索引损坏）不删除、不当作干净、不当作目录缺失', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't9')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      // 损坏该 worktree 的索引文件：git status 必失败但目录仍在。
      // 链接 worktree 的 --git-dir 即 <主仓>/.git/worktrees/<name>，index 在其下。
      const wtGitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: record.path, encoding: 'utf8' }).trim()
      writeFileSync(join(wtGitDir, 'index'), 'garbage-not-an-index')

      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_check_failed', 'status 失败必须显式报错，绝不静默当干净')
          return true
        },
      )
      assert.ok(existsSync(record.path), 'fail closed 时目录不得被删除')
      assert.equal(rawRecords(docs).find((r) => r.id === record.id)!.status, 'active', '记录保持 active')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('登记路径被替换/挪用：归属校验拒绝', { timeout: 60_000 }, () => {
  it('分支被改签（worktree 改 checkout 其他分支）拒绝 worktree_owner_mismatch，force 也不可越过', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't10a')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      // 用户在登记路径上改签其他分支。
      execFileSync('git', ['checkout', '-q', '-b', 'human/other'], { cwd: record.path })
      for (const force of [false, true]) {
        await assert.rejects(
          () => allocator.cleanup({ worktreeId: record.id, ...(force ? { force: true } : {}) }),
          (err: unknown) => {
            assert.ok(err instanceof HelmxError)
            assert.equal(err.code, 'worktree_owner_mismatch', `force=${force} 也不可越过归属校验`)
            const details = err.details as { reason?: string }
            assert.equal(details?.reason, 'branch_changed')
            return true
          },
        )
      }
      assert.ok(existsSync(record.path), '拒绝时目录不得被移除')
      assert.equal(rawRecords(docs).find((r) => r.id === record.id)!.status, 'active')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('登记路径指向主工作树（repoRoot 被改写为主仓自身）显式拒绝 main_worktree', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't10b')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      // 恶意/误操作把记录的 path 改写为主工作树本身（清空后手工塞入记录，
      // 模拟记录被外部篡改）。
      docs.clearNamespace('builtin:worktree', WORKTREES_KV_NAMESPACE)
      docs.setParsed('builtin:worktree', WORKTREES_KV_NAMESPACE, 'local:' + repo, {
        ...record,
        id: 'local:' + repo,
        path: repo,
        branch: 'helmx/spawn-fake1',
      })
      allocator.invalidateCache()
      // 主仓手工建同名分支，使权威登记 branch 匹配后进入 main-worktree 检查。
      execFileSync('git', ['branch', 'helmx/spawn-fake1'], { cwd: repo })
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: 'local:' + repo }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_owner_mismatch')
          const details = err.details as { reason?: string }
          assert.equal(details?.reason, 'main_worktree')
          return true
        },
      )
      assert.ok(existsSync(repo), '主工作树绝不被清除')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('git worktree lock 后拒绝清理（worktree_locked；force 不可越过）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't10c')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      execFileSync('git', ['worktree', 'lock', record.path], { cwd: repo })
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id, force: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_locked', 'locked 检查不可被 force 越过')
          return true
        },
      )
      assert.ok(existsSync(record.path))
      execFileSync('git', ['worktree', 'unlock', record.path], { cwd: repo })
      if (PROCESS_SCAN_ON) {
        const ok = await allocator.cleanup({ worktreeId: record.id })
        assert.equal(ok.removed, true, '解锁后可正常清理')
      } else {
        await assertCleanupPlatformRejected(() => allocator.cleanup({ worktreeId: record.id }))
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('目录缺失：节点真实 fs 探测证实后显式 worktree_missing 且登记保留（不 prune 全仓）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't10d')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      // 外部强删目录（模拟人类清理）。
      rmSync(record.path, { recursive: true, force: true })
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id, deleteBranch: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_missing')
          return true
        },
      )
      const after = rawRecords(docs).find((r) => r.id === record.id)!
      assert.equal(after.status, 'active', '缺目录记录保留登记（显式 worktree_missing，不自动 prune）')
      // 分支也未被误删。
      const branchList = execFileSync('git', ['branch', '--list', record.branch], { cwd: repo, encoding: 'utf8' })
      assert.notEqual(branchList.trim(), '', '登记分支不得被顺手删除')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('软链替换：登记路径经真实路径解析指向主工作树，拒绝 symlink_redirect/main_worktree', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't10e')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      // 把登记目录替换为指向主工作树的软链（同名分支已在 allocate 时创建，
      // 权威登记 branch 匹配 → canonical 校验发现跳树）。
      const realPath = record.path
      rmSync(realPath, { recursive: true, force: true })
      const { symlinkSync } = await import('node:fs')
      symlinkSync(repo, realPath)
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_owner_mismatch', '软链跳树必须拒绝')
          return true
        },
      )
      assert.ok(existsSync(repo), '主工作树绝不被清除')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('分支删除部分失败', { timeout: 60_000 }, () => {
  it('worktree 已移除但分支删除失败：记录先置 removed（branchDeleted:false + 诊断），可重试成功', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't11')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      // 制造分支 ref 锁：git branch -D 必失败（worktree remove 仍成功）。
      // 锁文件为完整 ref 路径 + .lock（.git/refs/heads/helmx/spawn-<id>.lock）。
      const refsDir = join(repo, '.git', 'refs', 'heads', 'helmx')
      mkdirSync(refsDir, { recursive: true })
      const lockPath = join(refsDir, `spawn-${record.branch.slice('helmx/spawn-'.length)}.lock`)
      writeFileSync(lockPath, '')
      if (PROCESS_SCAN_ON) {
        await assert.rejects(
          () => allocator.cleanup({ worktreeId: record.id, deleteBranch: true }),
          (err: unknown) => {
            assert.ok(err instanceof HelmxError)
            assert.equal(err.code, 'branch_delete_failed')
            return true
          },
        )
        const after = rawRecords(docs).find((r) => r.id === record.id)!
        assert.equal(after.status, 'removed', 'worktree 已 removed 的事实必须先固化（不可永远 active）')
        assert.equal(after.branchDeleted, false)
        assert.ok((after.branchDeleteError ?? '').length > 0, '失败诊断应保留在记录上')
        assert.ok(!existsSync(record.path), 'worktree 目录已被移除')

        // 解除 ref 锁后重试 deleteBranch（幂等路径）。
        rmSync(lockPath, { force: true })
        const retry = await allocator.cleanup({ worktreeId: record.id, deleteBranch: true })
        assert.equal(retry.removed, false, '重试时 worktree 已移除（removed:false）')
        assert.equal(retry.branchDeleted, true, '重试删除分支成功')
        const final = rawRecords(docs).find((r) => r.id === record.id)!
        assert.equal(final.branchDeleted, true)
        assert.equal(final.branchDeleteError, undefined)
      } else {
        // 非 Linux：到不了真实 remove（进程检查先拒绝），分支删除部分失败路径不可达。
        await assertCleanupPlatformRejected(() => allocator.cleanup({ worktreeId: record.id, deleteBranch: true }))
        assert.ok(existsSync(record.path), '非 Linux 拒绝清理时目录不得被移除')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('cleanup_worktree 工具 schema 扩展', { timeout: 60_000 }, () => {
  it('工具支持 worktreeId/nodeId 参数透传且幂等返回 removed:false', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't14')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      const ok = await executeCleanupTool(docs, { worktreeId: record.id, deleteBranch: true })
      const so = ok.structuredOutput as { removed: boolean; worktreeId: string; branchDeleted: boolean }
      assert.equal(so.removed, true)
      assert.equal(so.worktreeId, record.id)
      assert.equal(so.branchDeleted, true)
      // 幂等重放（按 id）。
      const again = await executeCleanupTool(docs, { worktreeId: record.id })
      assert.equal((again.structuredOutput as { removed: boolean }).removed, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('ignored 内容不阻断 cleanup（脏检查口径与 git worktree remove 对齐）', { timeout: 60_000 }, () => {
  it('仅含 gitignored 产物（dist/ 与 .env）的 worktree 无 force 可正常清理；分支保留', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't15')
    const repo = makeGitRepo(join(dir, 'repo'))
    // 主仓先提交 .gitignore（忽略 dist/ 与 .env）。
    writeFileSync(join(repo, '.gitignore'), '.env\ndist/\n')
    execFileSync('git', ['add', '.gitignore'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'ignore build artifacts'], { cwd: repo })
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      // 模拟 worker 跑过构建：ignored 产物 dist/ 与本地 .env。
      mkdirSync(join(record.path, 'dist'), { recursive: true })
      writeFileSync(join(record.path, 'dist', 'bundle.js'), 'console.log(1)\n')
      writeFileSync(join(record.path, '.env'), 'SECRET=1\n')
      // 旧口径（--ignored=matching 计入阻断）会让任何跑过构建的 worktree 永远「脏」；
      // 新口径必须放行（进程占用检查照常执行，不因放行脏检查而跳过）。
      if (PROCESS_SCAN_ON) {
        const result = await allocator.cleanup({ worktreeId: record.id })
        assert.equal(result.removed, true)
        assert.equal(result.branchDeleted, false, '未传 deleteBranch 时分支保留')
        assert.equal(result.removedReason, undefined, '常规移除不设置 removedReason')
        assert.ok(!existsSync(record.path), 'worktree 目录应被真实移除')
        const persisted = rawRecords(docs).find((r) => r.id === record.id)
        assert.equal(persisted?.status, 'removed')
        // 分支仍在（可后续合入或手工删除）。
        execFileSync('git', ['rev-parse', '--verify', `refs/heads/${record.branch}`], { cwd: repo })
      } else {
        // 非 Linux：脏检查放行后停在进程占用扫描（绝不回退 worktree_dirty）。
        await assertCleanupPlatformRejected(() => allocator.cleanup({ worktreeId: record.id }))
        assert.ok(existsSync(record.path), '平台拒绝清理时目录不得被移除')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('含未跟踪非 ignored 文件仍拒绝 worktree_dirty（保护面只放开 ignored，不缩到零）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't15b')
    const repo = makeGitRepo(join(dir, 'repo'))
    writeFileSync(join(repo, '.gitignore'), 'dist/\n')
    execFileSync('git', ['add', '.gitignore'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'ignore dist'], { cwd: repo })
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      writeFileSync(join(record.path, 'draft.txt'), 'uncommitted draft\n')
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_dirty', '未跟踪非 ignored 文件必须继续阻断（错误文案不得再提「被忽略」）')
          assert.ok(!err.message.includes('被忽略'), `文案应删除被忽略字样：${err.message}`)
          const details = err.details as { dirtyFiles?: string[] }
          assert.ok(details?.dirtyFiles?.some((f) => f.includes('draft.txt')), 'details 应列出未跟踪文件')
          return true
        },
      )
      assert.ok(existsSync(join(record.path, 'draft.txt')), '拒绝时未跟踪文件不得被删')
      const persisted = rawRecords(docs).find((r) => r.id === record.id)
      assert.equal(persisted?.status, 'active', '拒绝时登记保持 active')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('目录缺失态恢复（force 登记清除）', { timeout: 60_000 }, () => {
  it('外部删除目录：默认 worktree_missing 诚实拒绝并提示 force 出口；force 二次复核后清登记、prune git 残留、保留分支', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't15c')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      // 外部删除实体目录（git 侧登记残留）。
      rmSync(record.path, { recursive: true, force: true })
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_missing', '默认保持诚实拒绝（fail-closed）')
          assert.ok(err.message.includes('force: true'), '错误文案应提示 force 登记清除出口')
          return true
        },
      )
      assert.equal(rawRecords(docs).find((r) => r.id === record.id)?.status, 'active', '拒绝时登记保留')
      // force：登记清除（进程扫描检查不适用于不存在的目录路径——forceClear 路径不执行删除动作）。
      const result = await allocator.cleanup({ worktreeId: record.id, force: true })
      assert.equal(result.removed, true)
      assert.equal(result.removedReason, 'directory_missing_forced')
      assert.equal(result.branchDeleted, false, '默认保留分支只清登记')
      assert.ok(result.prune !== undefined && result.prune.ran === true && result.prune.ok === true, 'prune 已执行且成功')
      const persisted = rawRecords(docs).find((r) => r.id === record.id)
      assert.equal(persisted?.status, 'removed')
      assert.equal(persisted?.removedReason, 'directory_missing_forced')
      // 分支保留：spawn 分支仍可解析。
      execFileSync('git', ['rev-parse', '--verify', `refs/heads/${record.branch}`], { cwd: repo })
      // git 侧残留登记被 prune 收敛（worktree list 不再包含该路径，admin 目录消失）。
      const listed = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf-8' })
      assert.ok(!listed.includes(record.path), 'prune 后权威登记不得再包含缺失路径')
      assert.ok(!existsSync(join(repo, '.git', 'worktrees', basename(record.path))), 'git worktree admin 目录应被 prune 移除')
      // 幂等重放：已 removed 的记录再次 force cleanup 返回 removed:false。
      const again = await allocator.cleanup({ worktreeId: record.id, force: true })
      assert.equal(again.removed, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('force + deleteBranch：未合入提交的分支按 force 语义删除；登记清除留 removedReason', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't15d')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      // 未合入提交 + 外部删除目录。
      writeFileSync(join(record.path, 'feature.txt'), 'content\n')
      execFileSync('git', ['add', 'feature.txt'], { cwd: record.path })
      execFileSync('git', ['commit', '-qm', 'feat: unmerged'], { cwd: record.path })
      rmSync(record.path, { recursive: true, force: true })
      const result = await allocator.cleanup({ worktreeId: record.id, force: true, deleteBranch: true })
      assert.equal(result.removed, true)
      assert.equal(result.removedReason, 'directory_missing_forced')
      assert.equal(result.branchDeleted, true, 'force 语义下未合入分支也删除（-D）')
      assert.ok(result.prune?.ran === true && result.prune.ok === true)
      // 分支已不可解析（show-ref 静默校验退出码非零 → rev-parse 抛错）。
      assert.throws(() => execFileSync('git', ['rev-parse', '--verify', `refs/heads/${record.branch}`], { cwd: repo }))
      const persisted = rawRecords(docs).find((r) => r.id === record.id)
      assert.equal(persisted?.status, 'removed')
      assert.equal(persisted?.branchDeleted, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('cleanup mergedInto 与参考提交优先级', { timeout: 60_000 }, () => {
  it('mergedInto 严格形状校验：空白/范围操作符/前置 - 均 validation_error 且不清理', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't20')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      for (const bad of ['a b', 'a..b', 'HEAD~1', 'a^', 'a:b', '-x', '']) {
        await assert.rejects(
          () => allocator.cleanup({ worktreeId: record.id, mergedInto: bad }),
          (err: unknown) => {
            assert.ok(err instanceof HelmxError, `mergedInto=${JSON.stringify(bad)} 应抛 HelmxError`)
            assert.equal(err.code, 'validation_error')
            assert.ok(err.message.includes('mergedInto'), '错误消息应指向 mergedInto')
            return true
          },
        )
      }
      assert.ok(existsSync(record.path), '形状校验拒绝时目录不得被移除')
      assert.equal(rawRecords(docs).find((r) => r.id === record.id)!.status, 'active')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('mergedInto 指向不存在的分支/提交：显式拒绝且不回退（记录保留）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't20b')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id, mergedInto: 'no-such-ref' }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'validation_error', '显式目标不存在必须显式拒绝，绝不回退主工作树')
          assert.ok(err.message.includes('不存在'))
          return true
        },
      )
      assert.ok(existsSync(record.path), '拒绝时目录不得被移除')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('显式 mergedInto 优先于 baseBranch；缺省走 baseBranch 已合入即允许删除（branch -D）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't20c')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      // 主工作树留在 main；父隔离树改签 dev；子树从父树派生（baseBranch=dev）。
      const parent = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      execFileSync('git', ['checkout', '-q', '-b', 'dev'], { cwd: parent.path })
      const child = await allocator.allocate({ nodeId: 'local', sourceCwd: parent.path, parentConversationId: 1 })
      assert.equal(child.baseBranch, 'dev')
      assert.equal(child.parentWorktreeId, parent.id)
      // 子树提交 feature，并合入 dev（主工作树 main 不含 feature）。
      writeFileSync(join(child.path, 'feature.txt'), 'x\n')
      execFileSync('git', ['add', '.'], { cwd: child.path })
      execFileSync('git', ['commit', '-qm', 'feature'], { cwd: child.path })
      execFileSync('git', ['merge', '-q', child.branch], { cwd: parent.path })

      // 显式 mergedInto=main 优先：即使已合入 baseBranch dev，仍按 main 报未合入。
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: child.id, mergedInto: 'main' }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_dirty')
          const details = err.details as { unmergedCommits?: number; referenceHead?: string }
          assert.ok((details?.unmergedCommits ?? 0) >= 1, '相对 main 应报告未合入提交（显式目标优先）')
          return true
        },
      )

      if (PROCESS_SCAN_ON) {
        // 缺省 mergedInto：走 baseBranch dev 参考，已合入即允许删除；
        // 分支删除用 -D（相对 main 未合入，git branch -d 会拒绝）。
        const first = await allocator.cleanup({ worktreeId: child.id, deleteBranch: true })
        assert.equal(first.removed, true, '已合入 baseBranch（dev）即允许无 force 删除')
        assert.equal(first.branchDeleted, true, '确认合入参考后应统一用 -D 删除分支')
        assert.ok(!existsSync(child.path), 'worktree 目录应被移除')
        assert.equal(
          execFileSync('git', ['branch', '--list', child.branch], { cwd: repo, encoding: 'utf8' }).trim(),
          '',
          '受管分支应被删除',
        )
        assert.notEqual(
          execFileSync('git', ['branch', '--list', 'dev'], { cwd: repo, encoding: 'utf8' }).trim(),
          '',
          'dev 是人类/父模块分支，不得误删',
        )
        assert.equal(rawRecords(docs).find((r) => r.id === child.id)!.status, 'removed')
      } else {
        await assertCleanupPlatformRejected(() => allocator.cleanup({ worktreeId: child.id, deleteBranch: true }))
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removed 记录重试删除分支同样按参考确认后用 -D（mergedInto 优先 baseBranch）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't20d')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      const parent = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      execFileSync('git', ['checkout', '-q', '-b', 'dev'], { cwd: parent.path })
      const child = await allocator.allocate({ nodeId: 'local', sourceCwd: parent.path, parentConversationId: 1 })
      writeFileSync(join(child.path, 'feature.txt'), 'x\n')
      execFileSync('git', ['add', '.'], { cwd: child.path })
      execFileSync('git', ['commit', '-qm', 'feature'], { cwd: child.path })
      execFileSync('git', ['merge', '-q', child.branch], { cwd: parent.path })
      if (!PROCESS_SCAN_ON) {
        await assertCleanupPlatformRejected(() => allocator.cleanup({ worktreeId: child.id, mergedInto: 'dev' }))
        return
      }
      // 先移除树但保留分支（deleteBranch 未传）。
      const removedKeepBranch = await allocator.cleanup({ worktreeId: child.id, mergedInto: 'dev' })
      assert.equal(removedKeepBranch.removed, true)
      assert.equal(removedKeepBranch.branchDeleted, false)
      assert.notEqual(
        execFileSync('git', ['branch', '--list', child.branch], { cwd: repo, encoding: 'utf8' }).trim(),
        '',
        '分支应保留（本次未要求删除）',
      )
      // 重试删除：removed 记录路径同样按 mergedInto 参考确认已合入后 -D。
      const retry = await allocator.cleanup({ worktreeId: child.id, mergedInto: 'dev', deleteBranch: true })
      assert.equal(retry.removed, false, '树已移除，幂等 removed:false')
      assert.equal(retry.branchDeleted, true, '重试删除分支成功（-D，相对 main 未合入 -d 会拒绝）')
      assert.equal(
        execFileSync('git', ['branch', '--list', child.branch], { cwd: repo, encoding: 'utf8' }).trim(),
        '',
        '受管分支应被删除',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('pruneConversation：裁剪绑定与已 removed 记录，绝不删 active 记录与租约', { timeout: 60_000 }, () => {
  it('按子会话或父会话裁剪绑定与 removed 记录，严格保留 active 记录与活跃/fail-closed 租约', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't22-prune')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      th.faux.setResponses([
        fauxAssistantMessage('c1'),
        fauxAssistantMessage('c2'),
        fauxAssistantMessage('c3'),
      ])
      let c1 = 0
      let c2 = 0
      let c3 = 0
      await th.spawnIsolated({
        parentConversationId: 10,
        prompt: 'task-1',
        isolation: 'worktree',
        agentId: 'ag-c1',
        onResolved: (i: AgentExecutionInfo) => { c1 = i.conversationId ?? 0 },
      } as never)
      await th.spawnIsolated({
        parentConversationId: 10,
        prompt: 'task-2',
        isolation: 'worktree',
        agentId: 'ag-c2',
        onResolved: (i: AgentExecutionInfo) => { c2 = i.conversationId ?? 0 },
      } as never)
      await th.spawnIsolated({
        parentConversationId: 20,
        prompt: 'task-3',
        isolation: 'worktree',
        agentId: 'ag-c3',
        onResolved: (i: AgentExecutionInfo) => { c3 = i.conversationId ?? 0 },
      } as never)

      const rec1 = th.isolation.getForConversation(c1)!
      const rec2 = th.isolation.getForConversation(c2)!
      const rec3 = th.isolation.getForConversation(c3)!

      // 把 rec1 与一条被 fail-closed 租约引用的记录标为 removed；rec2 与 rec3 保持 active。
      th.kvStore.setParsed('builtin:worktree', WORKTREES_KV_NAMESPACE, rec1.id, {
        ...rec1,
        status: 'removed',
        removedAt: Date.now(),
      })
      const leasedRemovedId = 'local:/tmp/leased-removed-wt'
      th.kvStore.setParsed('builtin:worktree', WORKTREES_KV_NAMESPACE, leasedRemovedId, {
        ...rec1,
        id: leasedRemovedId,
        path: '/tmp/leased-removed-wt',
        conversationId: c1,
        parentConversationId: 10,
        status: 'removed',
        removedAt: Date.now(),
      })
      th.isolation.invalidateCache()
      th.kvStore.setParsed('builtin:worktree', LEASES_KV_NAMESPACE, 'fail-closed-lease', {
        phase: 'running',
        nodeId: 'local',
        path: rec2.path,
        info: { nodeId: 'local', executionId: 'ext-keep' },
        worktreeId: rec2.id,
        createdAt: 1,
      })
      th.kvStore.setParsed('builtin:worktree', LEASES_KV_NAMESPACE, 'leased-removed-token', {
        phase: 'pending',
        nodeId: 'local',
        path: '/tmp/leased-removed-wt',
        info: { nodeId: 'local', executionId: 'ext-leased-removed' },
        worktreeId: leasedRemovedId,
        createdAt: 2,
      })

      // 1) 无关会话裁剪：完全无副作用
      th.isolation.pruneConversation(99999)
      assert.equal(rawRecords(th.kvStore).length, 4)

      // 2) 按子会话 c1 裁剪：ag-c1 绑定删除、rec1（removed）删除；leasedRemoved 因仍有租约保留；c2/c3 不变
      th.isolation.pruneConversation(c1)
      assert.equal(th.kvStore.getParsed('builtin:worktree', AGENT_BINDINGS_KV_NAMESPACE, 'ag-c1'), undefined, '子会话匹配时应清理 agentId 绑定')
      assert.ok(th.kvStore.getParsed('builtin:worktree', AGENT_BINDINGS_KV_NAMESPACE, 'ag-c2') !== undefined, '同父其他子会话绑定此时保留')
      assert.ok(th.kvStore.getParsed('builtin:worktree', AGENT_BINDINGS_KV_NAMESPACE, 'ag-c3') !== undefined, '其他父会话绑定保留')
      assert.equal(rawRecords(th.kvStore).some((r) => r.id === rec1.id), false, '已 removed 的关联记录应被裁剪')
      assert.equal(rawRecords(th.kvStore).some((r) => r.id === leasedRemovedId), true, '仍被租约引用的记录绝不删除')
      assert.equal(rawRecords(th.kvStore).some((r) => r.id === rec2.id), true, 'active 记录绝不删除')
      assert.equal(Object.keys(leasesOf(th.kvStore)).length, 2, '任何活跃/fail-closed 租约绝不删除')

      // 3) 按父会话 10 裁剪：ag-c2 绑定因父会话匹配被清理，但 active 的 rec2 与全部租约严格保留
      th.isolation.pruneConversation(10)
      assert.equal(th.kvStore.getParsed('builtin:worktree', AGENT_BINDINGS_KV_NAMESPACE, 'ag-c2'), undefined, '父会话匹配时应清理其名下 agentId 绑定')
      assert.ok(th.kvStore.getParsed('builtin:worktree', AGENT_BINDINGS_KV_NAMESPACE, 'ag-c3') !== undefined, '无关父会话 20 的绑定保留')
      assert.equal(rawRecords(th.kvStore).find((r) => r.id === rec2.id)?.status, 'active', '父会话裁剪绝不删除 active worktree')
      assert.equal(rawRecords(th.kvStore).find((r) => r.id === rec3.id)?.status, 'active')
      assert.equal(Object.keys(leasesOf(th.kvStore)).length, 2, '父会话裁剪绝不删除租约')
    } finally {
      await th.close()
    }
  })
})
})
