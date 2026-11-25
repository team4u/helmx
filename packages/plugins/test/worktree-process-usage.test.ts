/**
 * worktree 清理进程占用保护集成测试（真实 git + 真实进程 + 真实 EnvFabric）。
 *
 * 覆盖：
 * - 真实子进程以 worktree 为 cwd → cleanup 显式 worktree_process_in_use
 *   （details 含 nodeId/path/PIDs/进程名/引用路径；不记录 cmdline/environ）；
 * - force: true 不可绕过进程占用检查（force 只授权丢弃文件）；
 * - 进程退出后 → cleanup 正常移除（保护不永久阻塞）；
 * - 脏保护先于进程检查：未跟踪文件使非 force 清理仍 worktree_dirty；
 * - 探测失败（节点离线）→ worktree_process_check_failed（fail-closed，绝不
 *   假称 0 占用）；
 * - 快照不完整（complete=false）→ worktree_process_check_failed；
 * - 非 Linux Hub 平台（注入 hubPlatform）→ 显式拒绝（不伪造跨平台结果）；
 * - 本进程打开 worktree 内文件的 fd → fd 占用命中。
 *
 * 平台契约：本文件进程占用链路仅 Linux 实现；非 Linux 平台的既有 cleanup
 * 契约分叉见 native-worktree / worktree-runtime 集成测试（显式拒绝断言，
 * 不伪造 complete=true、不静默跳过）。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmxError } from '@helmx/protocol'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createEnvFabric } from '../../kernel/src/env/fabric.js'
import { WorktreeAllocator } from '../src/worktree/worktree.js'
import { createGitTemplate, type GitTemplate } from '@helmx/test-kit/git'
import { createMemoryWorktreeKv, MemoryKvStore } from './helpers/plugin-test-env.js'

let rootDir: string
let gitTemplate: GitTemplate

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helmx-wt-procusage-'))
  gitTemplate = createGitTemplate('helmx-wt-procusage-template-')
})

after(() => {
  gitTemplate.cleanup()
  rmSync(rootDir, { recursive: true, force: true })
})

/** 真实临时 Git 仓库（由 suite 级 Git 模板克隆）。 */
function makeGitRepo(dir: string): string {
  return gitTemplate.cloneTo(dir)
}

/** 本机真实执行端口（与生产 execEnv + executionEnv 同契约）。 */
function localPorts() {
  const envOf = (cwd: string) => new NodeExecutionEnv({ cwd })
  return {
    exec: async (_nodeId: string, cwd: string, args: readonly string[], options?: { timeoutMs?: number; signal?: AbortSignal }) => {
      let output = ''
      const res = await envOf(cwd).exec(
        [...args],
        {
          cwd,
          ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs / 1000 } : {}),
          onOutput: (chunk: string) => {
            output += chunk
          },
        },
        BACKGROUND_CONTEXT,
      )
      if (!res.ok) {
        return { ok: false, exitCode: null, output, timedOut: res.error.code === 'timeout' }
      }
      return { ok: res.value.exitCode === 0, exitCode: res.value.exitCode, output, timedOut: false }
    },
    nodeExists: (_nodeId: string, path: string) => envOf(path).exists(path, BACKGROUND_CONTEXT),
    nodeCanonicalPath: (_nodeId: string, path: string) => envOf(path).canonicalPath(path, BACKGROUND_CONTEXT),
  }
}

/** local 真实端口（与生产同契约）+ 指定 fabric 的进程占用探测。 */
function makeAllocator(fabric: ReturnType<typeof createEnvFabric>, kvStore: MemoryKvStore): WorktreeAllocator {
  return new WorktreeAllocator({
    ...localPorts(),
    inspectPathUsage: (nodeId, path, signal) => fabric.inspectPathUsage(nodeId, path, signal),
    kv: createMemoryWorktreeKv(kvStore),
  })
}

/** 以 target 为 cwd 的长驻子进程（真实占用方）。 */
function holdProcess(target: string): { pid: number; stop: () => Promise<void> } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { cwd: target, stdio: 'ignore' })
  const pid = child.pid!
  return {
    pid,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.kill('SIGKILL')
      }),
  }
}

/**
 * 平台事实：进程占用扫描仅 Linux /proc。真实 /proc 用例按平台如实分叉：
 * 非 Linux 断言显式拒绝（不伪造 complete=true、不静默 skip）。
 */
const PROCESS_SCAN_ON = process.platform === 'linux'

/**
 * 断言真实探测的 cleanup 结算：Linux + 全可见（root）→ 正常移除；
 * Linux + 可见性不完整（非 root 环境）→ 显式 worktree_process_check_failed
 * 且携带诊断（fail-closed，不假设所有环境 root 全可见）。
 */
async function expectCleanupOkOrFailClosed(fn: () => Promise<{ removed: boolean }>): Promise<void> {
  try {
    const cleaned = await fn()
    assert.equal(cleaned.removed, true)
  } catch (error) {
    assert.ok(error instanceof HelmxError, `应 HelmxError（实得 ${String(error)}）`)
    assert.equal(
      error.code,
      'worktree_process_check_failed',
      `可见性不完整时只能 fail-closed（实得 ${error.code}：${error instanceof HelmxError ? error.message : ''}）`,
    )
    const details = error.details as { diagnostics?: string[] }
    assert.ok((details?.diagnostics?.length ?? 0) > 0, 'fail-closed 必须携带不完整诊断')
  }
}

async function allocateCleanWorktree(name: string): Promise<{ repo: string; record: ReturnType<WorktreeAllocator['list']>[number]; allocator: WorktreeAllocator; fabric: ReturnType<typeof createEnvFabric>; kvStore: MemoryKvStore }> {
  const repo = makeGitRepo(join(rootDir, name, 'repo'))
  const fabric = createEnvFabric({})
  const kvStore = new MemoryKvStore()
  const allocator = makeAllocator(fabric, kvStore)
  const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
  return { repo, record, allocator, fabric, kvStore }
}

describe('worktree 清理进程占用保护（真实进程 + 真实 git）', { timeout: 60_000 }, () => {
  it('子进程 cwd 占用：cleanup 显式 worktree_process_in_use（details 含 pid/进程名/引用路径；force 不可绕过）', { timeout: 60_000 }, async () => {
    const { record, allocator } = await allocateCleanWorktree('t1')
    if (!PROCESS_SCAN_ON) {
      // 非 Linux：扫描显式不支持 → cleanup 拒绝（501 worktree_usage_unverifiable）。
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id, force: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_usage_unverifiable')
          assert.equal(err.status, 501)
          return true
        },
      )
      return
    }
    const holder = holdProcess(record.path)
    try {
      for (const extra of [{}, { force: true }, { force: true, allowUnverifiedUsage: true }] as const) {
        await assert.rejects(
          () => allocator.cleanup({ worktreeId: record.id, ...extra }),
          (err: unknown) => {
            assert.ok(err instanceof HelmxError, `options=${JSON.stringify(extra)} 应抛 HelmxError`)
            assert.equal(err.code, 'worktree_process_in_use', `options=${JSON.stringify(extra)} 均不可绕过（实得 ${err.code}）`)
            const details = err.details as { pids?: number[]; processes?: Array<{ pid: number; name?: string; source: string; path: string }>; nodeId?: string; path?: string }
            assert.ok(details!.pids!.includes(holder.pid), `details.pids 应含占用进程 ${holder.pid}（实得 ${JSON.stringify(details!.pids)}）`)
            const hit = details!.processes!.find((p) => p.pid === holder.pid)
            assert.ok(hit, 'details.processes 应含占用明细')
            assert.equal(hit!.source, 'cwd')
            assert.equal(hit!.path, record.path)
            assert.equal(typeof hit!.name, 'string', '应含进程名（comm；不读 cmdline/environ）')
            assert.equal(details!.nodeId, 'local')
            assert.equal(details!.path, record.path)
            assert.ok(!err.message.includes('cmdline'), '错误消息不得携带命令行')
            return true
          },
        )
      }
      assert.ok(existsSync(record.path), '拒绝清理时目录不得被移除')
    } finally {
      await holder.stop()
    }
    // 进程退出 → 保护解除；全可见环境正常清理，可见性不完整环境 fail-closed。
    await expectCleanupOkOrFailClosed(() => allocator.cleanup({ worktreeId: record.id, deleteBranch: true }))
  })

  it('本进程打开 worktree 内文件的 fd：fd 占用命中；关闭 fd 后可清理', { timeout: 60_000 }, async () => {
    const { record, allocator } = await allocateCleanWorktree('t2')
    if (!PROCESS_SCAN_ON) {
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id, force: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_usage_unverifiable')
          assert.equal(err.status, 501)
          return true
        },
      )
      return
    }
    const held = join(record.path, 'held.log')
    writeFileSync(held, 'x')
    const fd = openSync(held, 'r')
    try {
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id, force: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_process_in_use')
          const details = err.details as { processes?: Array<{ pid: number; source: string }> }
          const hit = details!.processes!.find((p) => p.pid === process.pid && p.source === 'fd')
          assert.ok(hit, `应命中本进程 fd：${JSON.stringify(details!.processes!.filter((p) => p.pid === process.pid))}`)
          return true
        },
      )
    } finally {
      closeSync(fd)
    }
    await expectCleanupOkOrFailClosed(() => allocator.cleanup({ worktreeId: record.id, force: true }))
  })

  it('脏保护先于进程检查：未跟踪文件使非 force 清理仍 worktree_dirty（进程检查不削弱脏保护）', { timeout: 60_000 }, async () => {
    const repo = makeGitRepo(join(rootDir, 't3', 'repo'))
    writeFileSync(join(repo, '.gitignore'), '.env\n')
    execFileSync('git', ['add', '.gitignore'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'ignore env'], { cwd: repo })
    const fabric = createEnvFabric({})
    const kvStore = new MemoryKvStore()
    const allocator = makeAllocator(fabric, kvStore)
    const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
    writeFileSync(join(record.path, 'draft.txt'), 'uncommitted draft\n')
    await assert.rejects(
      () => allocator.cleanup({ worktreeId: record.id }),
      (err: unknown) => {
        assert.ok(err instanceof HelmxError)
        assert.equal(err.code, 'worktree_dirty', '未跟踪文件的脏保护必须先于进程检查（不被进程检查削弱）')
        return true
      },
    )
    assert.ok(existsSync(join(record.path, 'draft.txt')), '拒绝时未跟踪文件不得被删')
    // 无进程占用时 force 越过脏保护、通过进程检查 → 全可见环境正常移除；
    // 可见性不完整环境 fail-closed（expectCleanupOkOrFailClosed）。
    await expectCleanupOkOrFailClosed(() => allocator.cleanup({ worktreeId: record.id, force: true }))
  })

  it('探测端口失败（节点离线）：worktree_process_check_failed（fail-closed，force 也不绕过）', { timeout: 60_000 }, async () => {
    const { record, allocator } = await allocateCleanWorktree('t4')
    // 直接对 allocator 注入离线探测（远程节点离线在 fabric 层即抛 node_offline，
    // allocator 将其映射为 worktree_process_check_failed；此处用假 fabric 同构验证）。
    const brokenFabric = createEnvFabric({})
    const brokenKv = new MemoryKvStore()
    brokenKv.setParsed('builtin:worktree', 'worktrees', record.id, record)
    const broken = new WorktreeAllocator({
      ...localPorts(),
      inspectPathUsage: async () => {
        throw new HelmxError('node_offline', '节点 remote-x 离线，无法建立 IPC 通道', 409)
      },
      kv: createMemoryWorktreeKv(brokenKv),
    })
    void brokenFabric
    for (const extra of [{ force: true }, { force: true, allowUnverifiedUsage: true }] as const) {
      await assert.rejects(
        () => broken.cleanup({ worktreeId: record.id, ...extra }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_process_check_failed', '无法证明 0 占用时必须显式失败（allowUnverifiedUsage 也不绕过）')
          const details = err.details as { cause?: string }
          assert.ok(details!.cause!.includes('node_offline'), `诊断应含真实原因（实得 ${details!.cause}）`)
          return true
        },
      )
    }
    assert.ok(existsSync(record.path), 'fail-closed 时目录不得被移除')
    // 原 allocator（健康探测）仍可清理（全可见）或 fail-closed（可见性不完整）。
    await expectCleanupOkOrFailClosed(() => allocator.cleanup({ worktreeId: record.id }))
  })

  it('快照不完整（complete=false）：worktree_process_check_failed 并携带 diagnostics', { timeout: 60_000 }, async () => {
    const repo = makeGitRepo(join(rootDir, 't5', 'repo'))
    const kvStore = new MemoryKvStore()
    const record = await (async () => {
      const fabric = createEnvFabric({})
      const allocator = makeAllocator(fabric, kvStore)
      return allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
    })()
    const incomplete = new WorktreeAllocator({
      ...localPorts(),
      inspectPathUsage: async (_nodeId, path) => ({
        path,
        processes: [],
        matchedTotal: 0,
        processesTruncated: false,
        complete: false,
        unobservable: 0,
        diagnostics: ['pid 999 (uid 0): 无权读取 cwd（EACCES），该进程占用情况未知'],
      }),
      kv: createMemoryWorktreeKv(kvStore),
    })
    for (const extra of [{ force: true }, { force: true, allowUnverifiedUsage: true }] as const) {
      await assert.rejects(
        () => incomplete.cleanup({ worktreeId: record.id, ...extra }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_process_check_failed', '不完整快照绝不能当 0 占用（allowUnverifiedUsage 也不绕过）')
          const details = err.details as { diagnostics?: string[] }
          assert.ok(details!.diagnostics!.some((d) => d.includes('pid 999')), 'diagnostics 应如实携带')
          return true
        },
      )
    }
    assert.ok(existsSync(record.path))
    // 用真实完整探测的 allocator 清理（全可见正常 / 可见性不完整 fail-closed）。
    const fabric = createEnvFabric({})
    const healthy = makeAllocator(fabric, kvStore)
    await expectCleanupOkOrFailClosed(() => healthy.cleanup({ worktreeId: record.id }))
  })

  it('非 Linux Hub 平台（注入 hubPlatform=win32）：默认 501 worktree_usage_unverifiable；allowUnverifiedUsage: true 放行并留痕', { timeout: 60_000 }, async () => {
    const repo = makeGitRepo(join(rootDir, 't6', 'repo'))
    const fabric = createEnvFabric({ hubPlatform: () => 'win32' })
    const kvStore = new MemoryKvStore()
    const allocator = makeAllocator(fabric, kvStore)
    const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
    await assert.rejects(
      () => fabric.inspectPathUsage('local', record.path),
      (err: unknown) => {
        assert.ok(err instanceof HelmxError)
        assert.equal(err.code, 'path_usage_not_supported')
        assert.ok(err.message.includes('win32'), '错误应明示平台事实')
        return true
      },
    )
    await assert.rejects(
      () => allocator.cleanup({ worktreeId: record.id, force: true }),
      (err: unknown) => {
        assert.ok(err instanceof HelmxError)
        assert.equal(err.code, 'worktree_usage_unverifiable', '非 Linux 平台：默认显式拒绝（501）')
        assert.equal(err.status, 501)
        assert.equal((err.details as { platform?: string } | undefined)?.platform, 'win32')
        assert.ok(err.message.includes('--allow-unverified-usage'), '应给出 CLI 修复出路')
        assert.ok(err.message.includes('allowUnverifiedUsage'), '应给出工具参数修复出路')
        return true
      },
    )
    assert.ok(existsSync(record.path), '拒绝时目录不得被移除')
    await assert.rejects(
      () => fabric.inspectPathUsage('local', 'C:\\workspace\\repo'),
      (err: unknown) => {
        assert.ok(err instanceof HelmxError)
        assert.equal(err.code, 'path_usage_not_supported', '合法 Windows 路径应明确报告平台不支持')
        return true
      },
    )

    // 显式承担风险放行：成功移除目录与分支、回写 processUsage: 'unverified' 与持久化审计标记。
    const cleaned = await allocator.cleanup({
      worktreeId: record.id,
      deleteBranch: true,
      allowUnverifiedUsage: true,
    })
    assert.equal(cleaned.removed, true)
    assert.equal(cleaned.branchDeleted, true)
    assert.equal(cleaned.processUsage, 'unverified')
    assert.ok(typeof cleaned.processUsageNote === 'string' && cleaned.processUsageNote.includes('win32'))
    assert.equal(existsSync(record.path), false)
    const persisted = allocator.list().find((r) => r.id === record.id)
    assert.equal(persisted?.status, 'removed')
    assert.equal(persisted?.unverifiedUsage, true)

    // 幂等重复清理不再设置 processUsage。
    const again = await allocator.cleanup({ worktreeId: record.id })
    assert.equal(again.removed, false)
    assert.equal(again.processUsage, undefined)
  })

  it('aborted (499) 与 validation_error (400) 探测异常原样透传（不被包成 502）', { timeout: 60_000 }, async () => {
    const repo = makeGitRepo(join(rootDir, 't6b', 'repo'))
    for (const [code, status] of [['aborted', 499], ['validation_error', 400]] as const) {
      const kvStore = new MemoryKvStore()
      const seedAllocator = makeAllocator(createEnvFabric({}), kvStore)
      const record = await seedAllocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      const allocator = new WorktreeAllocator({
        ...localPorts(),
        inspectPathUsage: async () => {
          throw new HelmxError(code, `simulated ${code}`, status)
        },
        kv: createMemoryWorktreeKv(kvStore),
      })
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id, force: true, allowUnverifiedUsage: true }),
        (err: unknown) => err instanceof HelmxError && err.code === code && err.status === status,
      )
      assert.equal(existsSync(record.path), true)
    }
  })

  it('注入瞬时拒读：最多复查两次，取得完整零占用快照后才清理', { timeout: 60_000 }, async () => {
    const { record, allocator, fabric } = await allocateCleanWorktree('recheck-cleared')
    let calls = 0
    fabric.inspectPathUsage = async (_nodeId, path) => {
      calls += 1
      return {
        path,
        processes: [],
        matchedTotal: 0,
        processesTruncated: false,
        complete: calls === 3,
        unobservable: 0,
        diagnostics: calls === 3 ? [] : ['pid 42: fd 暂时不可读（EACCES）'],
      }
    }
    const result = await allocator.cleanup({ worktreeId: record.id, force: true })
    assert.equal(calls, 3)
    assert.equal(result.removed, true)
    assert.equal(existsSync(record.path), false)
  })

  it('注入持续权限盲区：复查有上限，force 仍拒绝并保留工作树', { timeout: 60_000 }, async () => {
    const { record, allocator, fabric } = await allocateCleanWorktree('recheck-denied')
    let calls = 0
    fabric.inspectPathUsage = async (_nodeId, path) => {
      calls += 1
      return {
        path,
        processes: [],
        matchedTotal: 0,
        processesTruncated: false,
        complete: false,
        unobservable: 0,
        diagnostics: ['pid 42: fd 仍不可读（EACCES）'],
      }
    }
    await assert.rejects(
      () => allocator.cleanup({ worktreeId: record.id, force: true }),
      (err: unknown) => err instanceof HelmxError && err.code === 'worktree_process_check_failed',
    )
    assert.equal(calls, 3)
    assert.equal(existsSync(record.path), true)
  })

  it('注入占用事实：即使快照不完整也立即拒绝，不用复查掩盖占用', { timeout: 60_000 }, async () => {
    const { record, allocator, fabric } = await allocateCleanWorktree('recheck-occupied')
    let calls = 0
    fabric.inspectPathUsage = async (_nodeId, path) => {
      calls += 1
      return {
        path,
        processes: [{ pid: process.pid, source: 'fd', path }],
        matchedTotal: 1,
        processesTruncated: false,
        complete: false,
        unobservable: 0,
        diagnostics: ['另一 PID 不可读（EACCES）'],
      }
    }
    await assert.rejects(
      () => allocator.cleanup({ worktreeId: record.id, force: true }),
      (err: unknown) => err instanceof HelmxError && err.code === 'worktree_process_in_use',
    )
    assert.equal(calls, 1)
    assert.equal(existsSync(record.path), true)
  })

  it('fabric 入参校验：相对路径 / NUL 拒绝（validation_error）；远程未知节点离线显式 node_offline', { timeout: 60_000 }, async () => {
    const fabric = createEnvFabric({})
    await assert.rejects(
      () => fabric.inspectPathUsage('local', 'relative/x'),
      (err: unknown) => {
        assert.ok(err instanceof HelmxError)
        assert.equal(err.code, 'validation_error')
        return true
      },
    )
    await assert.rejects(
      () => fabric.inspectPathUsage('local', '/a\u0000b'),
      (err: unknown) => {
        assert.ok(err instanceof HelmxError)
        assert.equal(err.code, 'validation_error')
        return true
      },
    )
    await assert.rejects(
      () => fabric.inspectPathUsage('node-nope', '/wt'),
      (err: unknown) => {
        assert.ok(err instanceof HelmxError)
        assert.equal(err.code, 'node_offline', '未知/离线节点显式失败，绝不回退本机')
        return true
      },
    )
  })

  it('ManagedWorktreeHold 优先拦截：持锁活跃工作树即使传 force:true 也先返 409 worktree_in_use（含 hold.label）；释放锁后进程占用保护继续生效', {
    timeout: 60_000,
  }, async () => {
    const { record, allocator, fabric } = await allocateCleanWorktree('hold-then-proc')
    allocator.setHold(record.id, {
      pluginId: 'builtin:swarm',
      holdId: 'grp-proc:verifier',
      label: 'swarm group #7 @verifier',
    })
    let procScans = 0
    const origInspect = fabric.inspectPathUsage.bind(fabric)
    fabric.inspectPathUsage = async (nodeId, path, signal) => {
      procScans += 1
      return origInspect(nodeId, path, signal)
    }

    // 持锁期间 force: true 直接在占用层以 409 worktree_in_use 拒绝并透出 hold.label，无需进入进程扫描。
    await assert.rejects(
      () => allocator.cleanup({ worktreeId: record.id, force: true, deleteBranch: true }),
      (err: unknown) => {
        assert.ok(err instanceof HelmxError)
        assert.equal(err.code, 'worktree_in_use')
        assert.equal(err.status, 409)
        assert.ok(err.message.includes('swarm group #7 @verifier'))
        return true
      },
    )
    assert.equal(procScans, 0, '持锁拦截应先于进程扫描快速失败')
    assert.equal(existsSync(record.path), true)

    // 释放持久锁后，进程 cwd 占用检查继续阻断 force 清理；进程退出后可正常移除。
    assert.equal(allocator.releaseHold(record.id, 'builtin:swarm', 'grp-proc:verifier'), true)
    if (!PROCESS_SCAN_ON) {
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id, force: true }),
        (err: unknown) => err instanceof HelmxError && err.code === 'worktree_usage_unverifiable',
      )
      return
    }
    const holder = holdProcess(record.path)
    try {
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id, force: true }),
        (err: unknown) => err instanceof HelmxError && err.code === 'worktree_process_in_use',
      )
      assert.ok(procScans >= 1, '释放持久锁后应进入真实进程占用扫描')
    } finally {
      await holder.stop()
    }
    await expectCleanupOkOrFailClosed(() => allocator.cleanup({ worktreeId: record.id, force: true, deleteBranch: true }))
  })
})

void BACKGROUND_CONTEXT
