/**
 * WorktreeIsolation 运行租约、ManagedWorktreeHold 内部动作、并发窗口保护、KV 持久化与受管技能测试。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { HelmxError, type AgentExecutionInfo, type AgentSpawnRequest } from '@helmx/protocol'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PluginHost, SecretStash } from '@helmx/kernel'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { type ManagedWorktreeRecord } from '../src/worktree/worktree.js'
import {
  AGENT_BINDINGS_KV_NAMESPACE,
  LEASES_KV_NAMESPACE,
  WORKTREES_KV_NAMESPACE,
  WorktreeStore,
  worktreeKvKey,
  type ManagedWorktreeHold,
  type WorktreeAgentBinding,
  type WorktreeLeaseRecord,
} from '../src/worktree/worktree-store.js'
import { extractWorktreeExecutionMeta } from '../src/contracts.js'
import { WorktreeIsolation } from '../src/worktree/isolation.js'
import { WORKTREE_SKILL_ID } from '../src/worktree.js'
import {
  resolveWorktreeContextSection,
  WORKTREE_CONTEXT_SECTION_ID,
  worktreeContextPrompt,
} from '../src/worktree/worktree-context.js'
import {
  createGitTemplate,
  createMemoryWorktreeKv,
  makeConversationSummary,
  makeFauxProvider,
  MemoryDocStore,
  MemoryKvStore,
  type GitTemplate,
} from './helpers/plugin-test-env.js'
import {
  bareFabricOf,
  childPromptText,
  createWorktreeHostBackendFixture,
  executeCleanupTool,
  leaseCount,
  leasesOf,
  makeFakeIsolation,
  openSpawnHarness,
  openWorkflowPluginHost,
  PROCESS_SCAN_ON,
  rawRecords,
} from './helpers/native-worktree-harness.js'

let rootDir: string
let gitTemplate: GitTemplate

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helmx-native-worktree-iso-'))
  gitTemplate = createGitTemplate('helmx-native-wt-iso-tpl-')
}, { timeout: 60_000 })

after(() => {
  gitTemplate.cleanup()
  rmSync(rootDir, { recursive: true, force: true })
}, { timeout: 60_000 })

function makeGitRepo(dir: string): string {
  return gitTemplate.cloneTo(dir)
}

describe('运行租约释放（原生子会话失败路径）', { timeout: 60_000 }, () => {
  it('next 抛错且原生子会话确认停止：释放运行租约，保留 Worktree 记录与 agentId 绑定，cleanup 不再被 unknown 阻塞', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't21')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      th.mirrors.set(5, { profileId: 'assistant', cwd: repo, model: 'faux/faux-1', title: '子代理 5', tags: [], createdAt: Date.now() })
      await assert.rejects(
        () =>
          th.isolation.aroundSpawn(
            { parentConversationId: 1, prompt: '任务', isolation: 'worktree', agentId: 'agent-rel-1' } as never,
            async (final) => {
              final.onResolved?.({ conversationId: 5, nodeId: 'local', effectiveCwd: final.cwd } as never)
              throw new HelmxError('gate_failed', '模拟门禁失败', 500)
            },
          ),
        (err: unknown) => err instanceof HelmxError && err.code === 'gate_failed',
      )
      assert.equal(Object.keys(leasesOf(th.kvStore)).length, 0, '确认停止的原生子会话租约应释放')
      const record = th.allocator.getForConversation(5)
      assert.ok(record, 'Worktree 记录保留（供下一轮 resume / cleanup）')
      assert.equal(record!.conversationId, 5)
      assert.deepEqual(
        th.kvStore.getParsed<WorktreeAgentBinding>('builtin:worktree', AGENT_BINDINGS_KV_NAMESPACE, 'agent-rel-1'),
        { childId: 5, parentConversationId: 1 },
        'agentId -> { childId, parentConversationId } 绑定保留（供 resume ref 解析）',
      )
      // 释放后 cleanup 不再报 worktree_execution_unknown（租约门已过；Linux 上
      // 通常全量成功，但沙箱 /proc 可能含不可读 fd 的外部进程——快照不完整
      // 时 fail-closed 的 worktree_process_check_failed 或非 Linux 的 worktree_usage_unverifiable 是环境事实，也证明已越过租约检查）。
      try {
        const done = await th.isolation.cleanup({ conversationId: 5, deleteBranch: true })
        assert.equal(done.removed, true)
      } catch (error) {
        assert.ok(
          error instanceof HelmxError &&
            (error.code === 'worktree_process_check_failed' || error.code === 'worktree_usage_unverifiable'),
          `租约释放后 cleanup 只允许进程扫描环境限制，实得：${error instanceof HelmxError ? error.code : String(error)}`,
        )
      }
    } finally {
      await th.close()
    }
  })

  it('onResolved 未触发或会话仍在运行：保留租约 fail-closed，cleanup 报 worktree_execution_unknown', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't21b')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      // a) next 抛错且 onResolved 未触发：不能证明执行未启动 -> 保留。
      await assert.rejects(
        () =>
          th.isolation.aroundSpawn(
            { parentConversationId: 1, prompt: 'p', isolation: 'worktree' } as never,
            async () => {
              throw new HelmxError('gate_failed', 'x', 500)
            },
          ),
        (err: unknown) => err instanceof HelmxError && err.code === 'gate_failed',
      )
      let leases = leasesOf(th.kvStore)
      assert.equal(Object.keys(leases).length, 1, '不确定状态租约必须保留')
      const pendingId = Object.values(leases)[0]!.worktreeId
      await assert.rejects(
        () => th.isolation.cleanup({ worktreeId: pendingId }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_execution_unknown', '保留租约应阻塞 cleanup')
          return true
        },
      )
      // b) 会话仍在运行（working）：即使 onResolved 已回传也不释放。
      th.mirrors.set(7, { profileId: 'assistant', cwd: repo, model: 'faux/faux-1', title: '子代理 7', tags: [], createdAt: Date.now() })
      th.markWorking(7)
      await assert.rejects(
        () =>
          th.isolation.aroundSpawn(
            { parentConversationId: 1, prompt: 'p', isolation: 'worktree', agentId: 'a7' } as never,
            async (final) => {
              final.onResolved?.({ conversationId: 7, nodeId: 'local' } as never)
              throw new HelmxError('gate_failed', 'x', 500)
            },
          ),
        (err: unknown) => err instanceof HelmxError && err.code === 'gate_failed',
      )
      leases = leasesOf(th.kvStore)
      assert.equal(Object.keys(leases).length, 2, '会话仍运行时租约必须保留')
    } finally {
      await th.close()
    }
  })

  it('resume 成功：清除该 worktree 下残留旧租约（不再阻塞后续 cleanup）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't21c')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let childId = 0
      th.faux.setResponses([fauxAssistantMessage('第一轮')])
      await th.spawnIsolated({
        parentConversationId: 1,
        prompt: '第一轮',
        isolation: 'worktree',
        onResolved: (info: AgentExecutionInfo) => {
          childId = info.conversationId ?? 0
        },
      } as never)
      const record = th.allocator.getForConversation(childId)
      assert.ok(record)
      // 注入残留旧租约（模拟此前失败/中断轮次未收敛）。
      th.kvStore.setParsed('builtin:worktree', LEASES_KV_NAMESPACE, 'stale-token', {
        phase: 'running',
        info: { nodeId: 'local' },
        worktreeId: record!.id,
        createdAt: 1,
      })
      await assert.rejects(
        () => th.isolation.cleanup({ conversationId: childId }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_execution_unknown', '残留租约应阻塞 cleanup')
          return true
        },
      )
      // resume 成功 -> 本次租约与残留旧租约一并清除。
      th.faux.setResponses([fauxAssistantMessage('续接完成')])
      await th.spawnIsolated({
        parentConversationId: 1,
        prompt: '续接',
        resume: String(childId),
      } as never)
      assert.equal(Object.keys(leasesOf(th.kvStore)).length, 0, 'resume 成功后残留旧租约与本次租约均应清除')
    } finally {
      await th.close()
    }
  })

  it('reconcileStoppedNativeLeases：仅回收无 executionId 的 pending 与已停止/不存在原生会话 running 租约；working 与外部 executionId 仍 fail-closed', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't21d')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      // 1) 创建 pending 原生租约（无 executionId）与 stopped(idle) / deleted(not_found) / working / external 租约
      th.faux.setResponses([
        fauxAssistantMessage('idle-conv'),
        fauxAssistantMessage('notfound-conv'),
        fauxAssistantMessage('working-conv'),
        fauxAssistantMessage('ext-conv'),
      ])
      let idleId = 0
      let notFoundId = 0
      let workingId = 0
      let extId = 0
      await th.spawnIsolated({
        parentConversationId: 1,
        prompt: 'idle',
        isolation: 'worktree',
        agentId: 'agent-idle',
        onResolved: (i: AgentExecutionInfo) => { idleId = i.conversationId ?? 0 },
      } as never)
      await th.spawnIsolated({
        parentConversationId: 1,
        prompt: 'notfound',
        isolation: 'worktree',
        onResolved: (i: AgentExecutionInfo) => { notFoundId = i.conversationId ?? 0 },
      } as never)
      await th.spawnIsolated({
        parentConversationId: 1,
        prompt: 'working',
        isolation: 'worktree',
        onResolved: (i: AgentExecutionInfo) => { workingId = i.conversationId ?? 0 },
      } as never)
      await th.spawnIsolated({
        parentConversationId: 1,
        prompt: 'ext',
        isolation: 'worktree',
        onResolved: (i: AgentExecutionInfo) => { extId = i.conversationId ?? 0 },
      } as never)

      const idleRec = th.allocator.getForConversation(idleId)!
      const notFoundRec = th.allocator.getForConversation(notFoundId)!
      const workingRec = th.allocator.getForConversation(workingId)!
      const extRec = th.allocator.getForConversation(extId)!

      th.markIdle(idleId)
      th.mirrors.delete(notFoundId)
      th.markWorking(workingId)

      th.kvStore.clearNamespace('builtin:worktree', LEASES_KV_NAMESPACE)
      const seededLeases: Record<string, WorktreeLeaseRecord> = {
        'tok-pending-native': { phase: 'pending', info: { nodeId: 'local' }, worktreeId: idleRec.id, createdAt: 1 },
        'tok-idle-native': { phase: 'running', info: { nodeId: 'local', conversationId: idleId }, worktreeId: idleRec.id, createdAt: 2 },
        'tok-notfound-native': { phase: 'running', info: { nodeId: 'local', conversationId: notFoundId }, worktreeId: notFoundRec.id, createdAt: 3 },
        'tok-working-native': { phase: 'running', info: { nodeId: 'local', conversationId: workingId }, worktreeId: workingRec.id, createdAt: 4 },
        'tok-ext-pending': { phase: 'pending', info: { nodeId: 'local', executionId: 'herdr-pane-9' }, worktreeId: extRec.id, createdAt: 5 },
        'tok-ext-running': { phase: 'running', info: { nodeId: 'local', conversationId: extId, executionId: 'herdr-pane-10' }, worktreeId: extRec.id, createdAt: 6 },
      }
      for (const [token, lease] of Object.entries(seededLeases)) {
        th.kvStore.setParsed('builtin:worktree', LEASES_KV_NAMESPACE, token, lease)
      }

      await th.isolation.reconcileStoppedNativeLeases()

      const remaining = leasesOf(th.kvStore)
      assert.deepEqual(
        Object.keys(remaining).sort(),
        ['tok-ext-pending', 'tok-ext-running', 'tok-working-native'],
        '仅保留 working 原生租约与带 executionId 的外部租约',
      )
      assert.ok(th.allocator.getForConversation(idleId), '租约收敛不得删除 Worktree 记录本身')
      assert.ok(th.allocator.getForConversation(notFoundId), 'not_found 租约收敛不得删除 Worktree 记录')

      // 确认 ext 仍阻塞 cleanup
      await assert.rejects(
        () => th.isolation.cleanup({ conversationId: extId }),
        (err: unknown) => err instanceof HelmxError && err.code === 'worktree_execution_unknown',
      )
      // 确认 idleId 租约已解除（允许 cleanup）
      try {
        const done = await th.isolation.cleanup({ conversationId: idleId, deleteBranch: true })
        assert.equal(done.removed, true)
      } catch (error) {
        assert.ok(
          error instanceof HelmxError &&
            (error.code === 'worktree_process_check_failed' || error.code === 'worktree_usage_unverifiable'),
          `租约释放后只允许环境 /proc 限制，实得：${error instanceof HelmxError ? error.code : String(error)}`,
        )
      }
    } finally {
      await th.close()
    }
  })
})

describe('ManagedWorktreeHold 与隐藏内部动作 acquire_worktree / release_worktree_hold', { timeout: 60_000 }, () => {
  it('动作元数据与边界校验：visibility=internal、exposeAsTool=false、HTTP/run_action 403，非法入参显式 400 validation_error', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't22-meta')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const { host, close } = await openWorkflowPluginHost({ repoDir: repo, dataDir: join(dir, 'data'), docs })
    try {
      const actions = host.listActions().filter((a) => a.pluginId === 'builtin:worktree')
      const acquireManifest = actions.find((a) => a.id === 'acquire_worktree')
      const releaseManifest = actions.find((a) => a.id === 'release_worktree_hold')
      assert.ok(acquireManifest, '应注册 acquire_worktree 动作')
      assert.ok(releaseManifest, '应注册 release_worktree_hold 动作')
      assert.equal(acquireManifest!.visibility, 'internal', 'acquire_worktree 必须声明 visibility: internal')
      assert.equal(releaseManifest!.visibility, 'internal', 'release_worktree_hold 必须声明 visibility: internal')
      assert.ok(!acquireManifest!.exposeAsTool, 'acquire_worktree 不得暴露为独立模型工具')
      assert.ok(!releaseManifest!.exposeAsTool, 'release_worktree_hold 不得暴露为独立模型工具')
      // 公开动作保持 visibility: 'public'；cleanup_worktree 通过 exposeAsTool 单点暴露工具，
      // list_worktrees / inspect_worktree 经 Skill-First 隐藏出 <available_actions>（exposeToPrompt: false，仍可经 run_action/CLI 调用）。
      const publicActions = host.listActions().filter((a) => a.pluginId === 'builtin:worktree')
      for (const id of ['cleanup_worktree', 'list_worktrees', 'inspect_worktree']) {
        const manifest = publicActions.find((a) => a.id === id)
        assert.ok(manifest !== undefined, `应注册 ${id} 动作`)
        assert.equal(manifest!.visibility, 'public', `${id} 是公开动作`)
      }
      for (const id of ['list_worktrees', 'inspect_worktree']) {
        const manifest = publicActions.find((a) => a.id === id)
        assert.equal(manifest!.exposeToPrompt, false, `${id} 经 Skill-First 不常驻 <available_actions>`)
      }
      const cleanupManifest = publicActions.find((a) => a.id === 'cleanup_worktree')
      assert.equal(cleanupManifest?.exposeAsTool, true)
      assert.equal(cleanupManifest?.toolName, 'cleanup_worktree')

      const toolNames = host.listTools().map((t) => t.name)
      assert.ok(toolNames.includes('cleanup_worktree'))
      assert.ok(!toolNames.includes('acquire_worktree'))
      assert.ok(!toolNames.includes('release_worktree_hold'))

      // 可见性硬门禁：HTTP（默认）与 run_action（含企图在 context 伪造 callerPluginId）一律 403 action_visibility_forbidden。
      for (const surface of ['http', 'run_action'] as const) {
        await assert.rejects(
          () =>
            host.invokeAction(
              'builtin:worktree',
              'acquire_worktree',
              { conversationId: 2, parentConversationId: 1, hold: { holdId: 'h', label: 'l' } },
              { callerPluginId: 'builtin:swarm' } as never,
              { surface },
            ),
          (err: unknown) => err instanceof HelmxError && err.code === 'action_visibility_forbidden' && err.status === 403,
        )
        await assert.rejects(
          () =>
            host.invokeAction(
              'builtin:worktree',
              'release_worktree_hold',
              { worktreeId: 'local:/wt', holdId: 'h' },
              { callerPluginId: 'builtin:swarm' } as never,
              { surface },
            ),
          (err: unknown) => err instanceof HelmxError && err.code === 'action_visibility_forbidden' && err.status === 403,
        )
      }

      const pluginCaller = { surface: 'plugin' as const, callerPluginId: 'builtin:superagent' }
      // Schema 强校验：缺失必填、未知字段（含旧自报 pluginId）、空白字符串、非正整数会话 ID 均返 400 validation_error。
      for (const badAcquire of [
        {},
        { conversationId: 0, parentConversationId: 1, hold: { holdId: 'h', label: 'l' } },
        { conversationId: 2, parentConversationId: 1, hold: { holdId: '   ', label: 'l' } },
        { conversationId: 2, parentConversationId: 1, hold: { pluginId: 'spoof', holdId: 'h', label: 'l' } },
        { conversationId: 2, parentConversationId: 1, hold: { holdId: 'h', label: 'l', extra: 1 } },
        { conversationId: 2, parentConversationId: 1, bogus: true, hold: { holdId: 'h', label: 'l' } },
        { conversationId: 2, parentConversationId: 1, requestNodeId: '', hold: { holdId: 'h', label: 'l' } },
        { conversationId: 2, parentConversationId: 1, requestNodeId: 'bad node', hold: { holdId: 'h', label: 'l' } },
        { conversationId: 2, parentConversationId: 1, requestNodeId: '../escape', hold: { holdId: 'h', label: 'l' } },
        { conversationId: 2, parentConversationId: 1, requestNodeId: 'a'.repeat(129), hold: { holdId: 'h', label: 'l' } },
      ]) {
        await assert.rejects(
          () => host.invokeAction('builtin:worktree', 'acquire_worktree', badAcquire, {}, pluginCaller),
          (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
        )
      }
      for (const badRelease of [
        {},
        { worktreeId: 'local:/wt' },
        { worktreeId: '   ', holdId: 'h' },
        { worktreeId: 'local:/wt', pluginId: 'spoof', holdId: 'h' },
        { worktreeId: 'local:/wt', holdId: 'h', extra: true },
      ]) {
        await assert.rejects(
          () => host.invokeAction('builtin:worktree', 'release_worktree_hold', badRelease, {}, pluginCaller),
          (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
        )
      }
    } finally {
      await close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('全闭环：acquire_worktree 绑定会话与持久锁 -> isPathInUse / cleanup(force:true) / disable(plugin_in_use) 硬拦截 -> release_worktree_hold 幂等与 mismatch 校验 -> 释放后恢复清理与停用', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't22-lifecycle')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const resolvedTargets: Array<Record<string, unknown>> = []
    let flushes = 0
    const { host, close } = await openWorkflowPluginHost({
      repoDir: repo,
      dataDir: join(dir, 'data'),
      docs,
      onResolveSpawnTarget: (input) => {
        resolvedTargets.push({ ...input })
      },
      onFlush: () => {
        flushes += 1
      },
    })
    try {
      const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
      const superagentCaller = { surface: 'plugin' as const, callerPluginId: 'builtin:superagent' }
      const acquired = (await host.invokeAction(
        'builtin:worktree',
        'acquire_worktree',
        {
          conversationId: 12,
          parentConversationId: 1,
          profileId: 'coder',
          fork: true,
          hold: {
            holdId: 'grp-alpha:author',
            label: 'collab group "Alpha" worker @author',
          },
        },
        {},
        superagentCaller,
      )) as {
        worktreeId: string
        path: string
        branch: string
        baseCommit: string
        nodeId: string
      }

      assert.deepEqual(resolvedTargets, [{ parentConversationId: 1, profileId: 'coder', fork: true }])
      assert.equal(acquired.nodeId, 'local')
      assert.equal(acquired.baseCommit, headCommit)
      assert.ok(acquired.branch.startsWith('helmx/spawn-'))
      assert.equal(acquired.worktreeId, `local:${acquired.path}`)
      assert.ok(existsSync(acquired.path), '真实 Git worktree 目录应创建')
      assert.ok(flushes >= 2, 'openPendingLease 与最终释放落盘均应 flush')

      // 临时 pending 租约已释放，持久化记录携带 conversationId 与 hold。
      assert.equal(Object.keys(leasesOf(docs)).length, 0, '临时 pending 租约必须在 acquire 返回前清除')
      const persisted = rawRecords(docs).find((r) => r.id === acquired.worktreeId)
      assert.ok(persisted)
      assert.equal(persisted!.conversationId, 12)
      const hold: ManagedWorktreeHold | undefined = persisted!.hold
      assert.ok(hold, '持久化记录应携带 hold')
      assert.equal(hold!.pluginId, 'builtin:superagent')
      assert.equal(hold!.holdId, 'grp-alpha:author')
      assert.equal(hold!.label, 'collab group "Alpha" worker @author')
      assert.ok(Number.isFinite(hold!.acquiredAt) && hold!.acquiredAt > 0)

      // 写入脏文件，验证即便传 force: true / deleteBranch: true，cleanup 动作与模型工具均以 409 worktree_in_use 拦截并透出 hold.label。
      writeFileSync(join(acquired.path, 'draft.ts'), 'export const x = 1\n')
      for (const selector of [
        { worktreeId: acquired.worktreeId, force: true, deleteBranch: true },
        { conversationId: 12, force: true, deleteBranch: true },
        { path: acquired.path, force: true },
      ]) {
        await assert.rejects(
          () => host.invokeAction('builtin:worktree', 'cleanup_worktree', selector),
          (err: unknown) => {
            assert.ok(err instanceof HelmxError)
            assert.equal(err.code, 'worktree_in_use')
            assert.equal(err.status, 409)
            assert.ok(
              err.message.includes('collab group "Alpha" worker @author'),
              `错误信息必须透出 hold.label（实得：${err.message}）`,
            )
            const details = err.details as { hold?: ManagedWorktreeHold }
            assert.equal(details?.hold?.label, 'collab group "Alpha" worker @author')
            return true
          },
        )
      }
      await assert.rejects(
        () => executeCleanupTool(docs, { worktreeId: acquired.worktreeId, force: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_in_use')
          assert.ok(
            err.message.includes('collab group "Alpha" worker @author'),
            'cleanup_worktree 工具错误输出同样应透出 hold.label',
          )
          return true
        },
      )
      assert.ok(existsSync(acquired.path), '持锁期间目录绝不可被移除')

      // builtin:worktree 的 inUse() 上报持锁活跃工作树，非 force 停用显式返 409 plugin_in_use；
      // 持锁不阻塞 builtin:workflow 停用（两个插件零静态依赖）。
      await assert.doesNotReject(() => host.disable('builtin:workflow').then(() => host.enable('builtin:workflow')))
      await assert.rejects(
        () => host.disable('builtin:worktree'),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'plugin_in_use')
          assert.equal(err.status, 409)
          const usages = (err.details as { usages?: Array<{ kind: string; id: string; label: string }> })?.usages ?? []
          const hit = usages.find((u) => u.kind === 'worktree_hold' && u.id === acquired.worktreeId)
          assert.ok(hit, `plugin_in_use.details.usages 应包含持锁 worktreeId（实得：${JSON.stringify(usages)}）`)
          assert.ok(hit!.label.includes('collab group "Alpha" worker @author'), 'plugin_in_use 应透出 hold.label')
          return true
        },
      )

      // release_worktree_hold：未知 worktreeId 幂等返 { released: false }。
      const missingRelease = (await host.invokeAction(
        'builtin:worktree',
        'release_worktree_hold',
        {
          worktreeId: 'local:/nonexistent-wt',
          holdId: 'grp-alpha:author',
        },
        {},
        superagentCaller,
      )) as { released: boolean }
      assert.deepEqual(missingRelease, { released: false })

      // release_worktree_hold：调用方插件 ID 或 holdId 不一致显式抛 409 worktree_hold_mismatch，锁不丢失。
      for (const mismatch of [
        {
          input: { worktreeId: acquired.worktreeId, holdId: 'grp-alpha:author' },
          caller: { surface: 'plugin' as const, callerPluginId: 'other:plugin' },
        },
        {
          input: { worktreeId: acquired.worktreeId, holdId: 'grp-alpha:verifier' },
          caller: superagentCaller,
        },
      ]) {
        await assert.rejects(
          () => host.invokeAction('builtin:worktree', 'release_worktree_hold', mismatch.input, {}, mismatch.caller),
          (err: unknown) =>
            err instanceof HelmxError && err.code === 'worktree_hold_mismatch' && err.status === 409,
        )
      }
      assert.ok(rawRecords(docs).find((r) => r.id === acquired.worktreeId)?.hold, 'mismatch 拒绝后 hold 必须保留')

      // release_worktree_hold：精确匹配清除 hold 并 flush；重复调用幂等返 { released: false }。
      const flushesBeforeRelease = flushes
      const released = (await host.invokeAction(
        'builtin:worktree',
        'release_worktree_hold',
        {
          worktreeId: acquired.worktreeId,
          holdId: 'grp-alpha:author',
        },
        {},
        superagentCaller,
      )) as { released: boolean }
      assert.deepEqual(released, { released: true })
      assert.ok(flushes > flushesBeforeRelease, '释放 hold 必须触发 docStore.flush')
      assert.equal(rawRecords(docs).find((r) => r.id === acquired.worktreeId)?.hold, undefined)

      const releasedAgain = (await host.invokeAction(
        'builtin:worktree',
        'release_worktree_hold',
        {
          worktreeId: acquired.worktreeId,
          holdId: 'grp-alpha:author',
        },
        {},
        superagentCaller,
      )) as { released: boolean }
      assert.deepEqual(releasedAgain, { released: false })

      // 释放后：非 force 仍受脏文件保护（worktree_dirty），传 force: true 可正常清理（Linux）且插件可正常停用。
      if (PROCESS_SCAN_ON) {
        await assert.rejects(
          () => host.invokeAction('builtin:worktree', 'cleanup_worktree', { worktreeId: acquired.worktreeId }),
          (err: unknown) => err instanceof HelmxError && err.code === 'worktree_dirty' && err.status === 409,
        )
        try {
          const cleaned = (await host.invokeAction('builtin:worktree', 'cleanup_worktree', {
            worktreeId: acquired.worktreeId,
            force: true,
            deleteBranch: true,
          })) as { removed: boolean; branchDeleted: boolean }
          assert.equal(cleaned.removed, true)
          assert.equal(cleaned.branchDeleted, true)
          assert.equal(existsSync(acquired.path), false)
        } catch (error) {
          assert.ok(
            error instanceof HelmxError &&
              (error.code === 'worktree_process_check_failed' || error.code === 'worktree_usage_unverifiable'),
            `释放锁后只允许环境 /proc 限制，实得：${error instanceof HelmxError ? error.code : String(error)}`,
          )
        }
      }
      await host.disable('builtin:worktree')
      const summary = host.list().find((p) => p.id === 'builtin:worktree')
      assert.equal(summary?.enabled, false, '锁释放后无 force 停用 builtin:worktree 应放行')
    } finally {
      await close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('独立注册：只挂 builtin:worktree（不注册 builtin:workflow）时动作、acquire/release 与停用门禁同样正常', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't22-standalone')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const { host, close } = await openWorkflowPluginHost({
      repoDir: repo,
      dataDir: join(dir, 'data'),
      docs,
      plugins: 'worktree-only',
    })
    try {
      // 零静态依赖：worktree 独立注册即可用（workflow 未注册不影响动作面）。
      const ids = host.listActions().filter((a) => a.pluginId === 'builtin:worktree').map((a) => a.id).sort()
      assert.deepEqual(ids, ['acquire_worktree', 'cleanup_worktree', 'inspect_worktree', 'list_worktrees', 'release_worktree_hold'])
      assert.ok(host.listTools().some((t) => t.name === 'cleanup_worktree'), '独立注册即提供 cleanup_worktree 工具')

      const soloCaller = { surface: 'plugin' as const, callerPluginId: 'builtin:superagent' }
      const acquired = (await host.invokeAction(
        'builtin:worktree',
        'acquire_worktree',
        {
          conversationId: 30,
          parentConversationId: 1,
          requestCwd: repo,
          hold: { holdId: 'solo:worker', label: 'standalone hold' },
        },
        {},
        soloCaller,
      )) as { worktreeId: string; path: string }
      await assert.rejects(
        () => host.disable('builtin:worktree'),
        (err: unknown) => err instanceof HelmxError && err.code === 'plugin_in_use' && err.status === 409,
      )
      const released = (await host.invokeAction(
        'builtin:worktree',
        'release_worktree_hold',
        {
          worktreeId: acquired.worktreeId,
          holdId: 'solo:worker',
        },
        {},
        soloCaller,
      )) as { released: boolean }
      assert.equal(released.released, true)
      try {
        const cleaned = (await host.invokeAction('builtin:worktree', 'cleanup_worktree', {
          worktreeId: acquired.worktreeId,
          force: true,
          deleteBranch: true,
        })) as { removed: boolean; branchDeleted: boolean }
        assert.equal(cleaned.removed, true)
        assert.equal(cleaned.branchDeleted, true)
      } catch (error) {
        assert.ok(
          error instanceof HelmxError &&
            (error.code === 'worktree_process_check_failed' || error.code === 'worktree_usage_unverifiable'),
          `独立注册清理只允许环境 /proc 限制，实得：${error instanceof HelmxError ? error.code : String(error)}`,
        )
      }
      await host.disable('builtin:worktree')
      assert.equal(host.list().find((p) => p.id === 'builtin:worktree')?.enabled, false, '独立注册下锁释放后停用放行')
    } finally {
      await close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('WorktreeStore.isPathInUse 纳入活跃 hold 记录；释放或置 removed 后解除占用', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't22-inuse')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      const acquired = await th.isolation.acquireWorktree({
        conversationId: 20,
        parentConversationId: 1,
        hold: {
          pluginId: 'builtin:superagent',
          holdId: 'grp-2:worker-1',
          label: 'worker-1 hold',
        },
      })
      assert.equal(th.isolation.isPathInUse('local', acquired.path), true, '持锁活跃工作树必须计入 isPathInUse')
      assert.equal(
        th.isolation.isPathInUse('local', join(acquired.path, 'sub')),
        true,
        '持锁工作树子路径同样视为占用',
      )
      assert.equal(th.isolation.isPathInUse('other-node', acquired.path), false, '不同节点同路径不误伤')

      const rel = await th.isolation.releaseWorktreeHold({
        worktreeId: acquired.worktreeId,
        pluginId: 'builtin:superagent',
        holdId: 'grp-2:worker-1',
      })
      assert.equal(rel.released, true)
      assert.equal(th.isolation.isPathInUse('local', acquired.path), false, '释放锁后不再占用')

      // 若记录已为 removed 状态，即使残留 hold 也不再视为活跃占用。
      const stored = th.kvStore.getParsed<ManagedWorktreeRecord>('builtin:worktree', WORKTREES_KV_NAMESPACE, acquired.worktreeId)!
      th.kvStore.setParsed('builtin:worktree', WORKTREES_KV_NAMESPACE, acquired.worktreeId, {
        ...stored,
        status: 'removed',
        hold: { pluginId: 'builtin:superagent', holdId: 'grp-2:worker-1', label: 'stale', acquiredAt: 1 },
      })
      th.isolation.invalidateCache()
      assert.equal(th.isolation.isPathInUse('local', acquired.path), false, 'removed 记录不得计入占用')
    } finally {
      await th.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('机密与损坏防护：hold.label 自动脱敏落库；pluginId/holdId 含已登记机密前置拒绝不建孤儿树；损坏 hold 文档显式 worktree_doc_corrupted', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't22-secrets')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const stash = new SecretStash()
    const secretVal = 'sk-super-secret-hold-token-999'
    const placeholder = '[REDACTED]'
    stash.addRedaction(secretVal)
    const { host, close } = await openWorkflowPluginHost({
      repoDir: repo,
      dataDir: join(dir, 'data'),
      docs,
      stash,
    })
    try {
      // 1) callerPluginId 或 holdId 含机密：在 git worktree add 之前显式抛 400 worktree_metadata_secret，不产生任何目录或记录。
      for (const badCase of [
        { callerPluginId: `plugin-${secretVal}`, hold: { holdId: 'h1', label: 'clean' } },
        { callerPluginId: 'builtin:superagent', hold: { holdId: `grp:${secretVal}`, label: 'clean' } },
      ]) {
        await assert.rejects(
          () =>
            host.invokeAction(
              'builtin:worktree',
              'acquire_worktree',
              {
                conversationId: 30,
                parentConversationId: 1,
                hold: badCase.hold,
              },
              {},
              { surface: 'plugin', callerPluginId: badCase.callerPluginId },
            ),
          (err: unknown) => {
            assert.ok(err instanceof HelmxError)
            assert.equal(err.code, 'worktree_metadata_secret')
            assert.equal(err.status, 400)
            assert.ok(!err.message.includes(secretVal), '错误诊断绝不可含明文机密')
            return true
          },
        )
      }
      assert.equal(rawRecords(docs).length, 0, '机密前置拦截不得产生任何登记记录')
      assert.equal(existsSync(join(dir, '.helmx-worktrees')), false, '机密前置拦截不得创建孤儿 worktree 目录')

      // 2) hold.label 含机密：写入前经 redact 脱敏，落盘原始 JSON 零明文泄漏。
      const acquired = (await host.invokeAction(
        'builtin:worktree',
        'acquire_worktree',
        {
          conversationId: 31,
          parentConversationId: 1,
          hold: {
            holdId: 'grp-sec:author',
            label: `group ${secretVal} author`,
          },
        },
        {},
        { surface: 'plugin', callerPluginId: 'builtin:superagent' },
      )) as { worktreeId: string; path: string }
      const rawJson = JSON.stringify(docs.rawJsonEntries('builtin:worktree', WORKTREES_KV_NAMESPACE))
      assert.ok(!rawJson.includes(secretVal), 'worktree KV 原始落库 JSON 不得含明文机密')
      const storedRecord = rawRecords(docs).find((r) => r.id === acquired.worktreeId)!
      assert.equal(storedRecord.hold?.label, `group ${placeholder} author`)

      // 3) 持久化 KV 中 hold 结构损坏：重启水合后读取/停用检查显式报错（worktree_doc_corrupted -> plugin_in_use_check_failed），绝不静默放行。
      const corruptedRecord = structuredClone(storedRecord) as unknown as Record<string, unknown>
      corruptedRecord['hold'] = { pluginId: '', holdId: 'x', label: 'y', acquiredAt: -1 }
      docs.setParsed('builtin:worktree', WORKTREES_KV_NAMESPACE, acquired.worktreeId, corruptedRecord)

      await close()
      const reopened = await openWorkflowPluginHost({
        repoDir: repo,
        dataDir: join(dir, 'data'),
        docs,
        stash,
      })
      try {
        await assert.rejects(
          () => reopened.host.invokeAction('builtin:worktree', 'list_worktrees', {}),
          (err: unknown) => err instanceof HelmxError && err.code === 'worktree_doc_corrupted' && err.status === 500,
        )
        await assert.rejects(
          () => reopened.host.disable('builtin:worktree'),
          (err: unknown) => err instanceof HelmxError && err.code === 'plugin_in_use_check_failed' && err.status === 500,
        )
      } finally {
        await reopened.close()
      }
    } finally {
      await close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('真实 PluginHost before_turn：Swarm hold 注入上下文，释放后撤销上下文', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't22-context-hook')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const { host, close } = await openWorkflowPluginHost({ repoDir: repo, dataDir: join(dir, 'data'), docs })
    const caller = { surface: 'plugin' as const, callerPluginId: 'builtin:swarm' }
    const baseTurn = {
      conversation: makeConversationSummary({ id: 31, cwd: repo, model: '', createdAt: 1, updatedAt: 1 }),
      inputs: [],
      tools: [{ name: 'cleanup_worktree', description: 'cleanup', inputSchema: {}, execute: async () => undefined }],
      sections: [],
      messages: [],
    }
    try {
      const ordinary = await host.runHook('before_turn', {
        ...baseTurn,
        conversation: { ...baseTurn.conversation, id: 32 },
      })
      assert.equal(ordinary.action, 'transform')
      if (ordinary.action !== 'transform') throw new Error('无记录的 before_turn 应仅剥离无效 cleanup 工具')
      assert.ok(!ordinary.value.sections.some((section) => section.id === WORKTREE_CONTEXT_SECTION_ID), '普通会话不得收到 worktree 上下文')
      assert.ok(!ordinary.value.tools.some((tool) => tool.name === 'cleanup_worktree'), '无受管工作树时 cleanup 工具应被剥离')

      const acquired = (await host.invokeAction(
        'builtin:worktree',
        'acquire_worktree',
        {
          conversationId: 31,
          parentConversationId: 1,
          requestCwd: repo,
          hold: { holdId: 'group:author', label: 'swarm author' },
        },
        {},
        caller,
      )) as { worktreeId: string }

      const injected = await host.runHook('before_turn', baseTurn)
      assert.equal(injected.action, 'transform')
      if (injected.action !== 'transform') throw new Error('before_turn 应返回 transform')
      const context = injected.value.sections.find((section) => section.id === WORKTREE_CONTEXT_SECTION_ID)
      assert.ok(context, '真实 before_turn 应注入 worktree_context')
      assert.ok(context!.text.includes(acquired.worktreeId), '注入段落应包含真实 worktreeId')
      assert.ok(injected.value.tools.some((tool) => tool.name === 'cleanup_worktree'), '活跃 hold 不应剥离 cleanup 工具')

      await host.invokeAction(
        'builtin:worktree',
        'release_worktree_hold',
        { worktreeId: acquired.worktreeId, holdId: 'group:author' },
        {},
        caller,
      )
      const afterRelease = await host.runHook('before_turn', {
        ...baseTurn,
        sections: injected.value.sections,
      })
      assert.equal(afterRelease.action, 'transform')
      if (afterRelease.action !== 'transform') throw new Error('释放后 before_turn 应返回 transform 以撤销旧段落')
      assert.ok(!afterRelease.value.sections.some((section) => section.id === WORKTREE_CONTEXT_SECTION_ID), '释放 hold 后不得保留旧上下文')
      assert.ok(afterRelease.value.tools.some((tool) => tool.name === 'cleanup_worktree'), '解除 hold 不会移除仍 active 的工作树')
    } finally {
      await close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('before_turn 上下文段落：hold 记录注入、spawn 记录（无 hold）与 removed 记录不注入', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't22-context-section')
    const repo = makeGitRepo(join(dir, 'repo'))
    // 源工作区留未提交改动，验证 dirtySource 诚实提示进入段落。
    writeFileSync(join(repo, 'uncommitted.txt'), 'dirty\n')
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      // 1) Swarm 式长占用：acquire_worktree 带 hold → 会话每回合应拿到 worktree 上下文段落。
      const held = await th.isolation.acquireWorktree({
        conversationId: 31,
        parentConversationId: 1,
        hold: { pluginId: 'builtin:swarm', holdId: 'grp-9:author', label: 'swarm author' },
      })
      // 与生产 worktree.ts 同一 store 读写（harness 的 allocator 与 isolation 各持独立缓存实例）。
      const heldRecord = th.isolation.getForConversation(31)
      assert.ok(heldRecord, 'acquireWorktree 应绑定会话 31')
      const section = resolveWorktreeContextSection(heldRecord)
      assert.ok(section, '带 hold 的活跃记录应产出上下文段落')
      assert.equal(section.id, WORKTREE_CONTEXT_SECTION_ID)
      const text = section.text
      assert.ok(text.startsWith('<worktree_context>\n') && text.endsWith('\n</worktree_context>'), '段落用 worktree_context 包裹')
      assert.ok(text.includes(`- branch: ${held.branch}`), '段落须含受管分支名')
      assert.ok(text.includes(`- path: ${held.path}`), '段落须含工作树路径')
      assert.ok(text.includes(`- baseCommit: ${held.baseCommit.slice(0, 12)}`), 'baseCommit 截断到 12 位')
      assert.ok(text.includes('不包含源工作区未提交的改动'), 'dirty 源须给出诚实提示')
      assert.ok(text.includes('git add') && text.includes('git commit'), '段落须提醒结束回合前提交改动')

      // 2) 与 agent_spawn 提示词尾注同源：两者共享同一组事实行，不产生分歧。
      const prompt = worktreeContextPrompt(heldRecord)
      assert.ok(
        prompt.includes(text.slice('<worktree_context>\n'.length, -'\n</worktree_context>'.length)),
        '段落正文应与提示词尾注正文完全一致（单一事实源）',
      )

      // 3) 释放 hold 后（记录仍 active）→ 不再注入：上下文回归仅提示词尾注路径。
      await th.isolation.releaseWorktreeHold({
        worktreeId: held.worktreeId,
        pluginId: 'builtin:swarm',
        holdId: 'grp-9:author',
      })
      const releasedRecord = th.isolation.getForConversation(31)
      assert.ok(releasedRecord && releasedRecord.status === 'active', '释放 hold 不改变 active 状态')
      assert.equal(resolveWorktreeContextSection(releasedRecord), undefined, '无 hold 的活跃记录不注入段落')

      // 4) 无记录 / removed 记录 → 不注入。
      assert.equal(resolveWorktreeContextSection(undefined), undefined, '无记录不注入')
      assert.equal(
        resolveWorktreeContextSection({ ...heldRecord, status: 'removed' }),
        undefined,
        'removed 记录不注入',
      )
    } finally {
      await th.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('spawn 路径记录无 hold：不产生 before_turn 段落（上下文已由提示词尾注提供，不重复）', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't22-context-spawn-no-section')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let childId = 0
      th.faux.setResponses([fauxAssistantMessage('完成')])
      await th.spawnIsolated({
        parentConversationId: 1,
        prompt: 'spawn 任务',
        isolation: 'worktree',
        onResolved: (info: AgentExecutionInfo) => {
          childId = info.conversationId ?? 0
        },
      } as never)
      assert.ok(childId > 0)
      const spawnRecord = th.isolation.getForConversation(childId)
      assert.ok(spawnRecord, 'spawn 路径应绑定子会话')
      assert.equal(spawnRecord.hold, undefined, 'spawn 路径记录不带 hold')
      assert.equal(
        resolveWorktreeContextSection(spawnRecord),
        undefined,
        'spawn 记录不注入 before_turn 段落（避免与提示词尾注重复）',
      )
      // 提示词尾注仍然存在（既有契约不变）。
      const prompt = await childPromptText(th.harness, childId)
      assert.ok(prompt.includes('<worktree_context>'), 'spawn 提示词尾注契约保持不变')
    } finally {
      await th.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('WorktreeIsolation：租约与并发窗口保护', { timeout: 60_000 }, () => {
  it('resumeWithWorktree 租约前置：远端验证窗口内并发 cleanup 被租约 fail-closed 拒绝；resume 正常续接', { timeout: 60_000 }, async () => {
    const wtPath = '/wt/resume-race'
    const worktreeId = `local:${wtPath}`
    const handle = makeFakeIsolation({ gatedExistsPath: wtPath })
    handle.kvStore.setParsed('builtin:worktree', WORKTREES_KV_NAMESPACE, worktreeId, {
      id: worktreeId,
      nodeId: 'local',
      path: wtPath,
      branch: 'helmx/spawn-resume1',
      repoRoot: '/repo',
      baseCommit: 'abc',
      parentConversationId: 1,
      conversationId: 42,
      createdAt: 1,
      status: 'active',
      origin: 'native',
    })

    const nextCwds: Array<string | undefined> = []
    const resumePromise = handle.isolation.aroundSpawn(
      { parentConversationId: 1, prompt: '续接', resume: '42', onResolved: () => {} } as never,
      async (final) => {
        nextCwds.push((final as AgentSpawnRequest).cwd)
        return 'resumed'
      },
    )
    await handle.probeEntered

    await assert.rejects(
      () => handle.isolation.cleanup({ worktreeId }),
      (err: unknown) => {
        assert.ok(err instanceof HelmxError)
        assert.ok(
          err.code === 'worktree_execution_unknown' || err.code === 'worktree_in_use',
          `cleanup 应被租约拒绝（实际 ${err.code}）`,
        )
        return true
      },
    )

    handle.releaseProbe()
    assert.equal(await resumePromise, 'resumed')
    assert.deepEqual(nextCwds, [wtPath], 'resume 必须沿用原 worktree cwd')
    assert.equal(leaseCount(handle.kvStore), 0, '结算后租约释放，不留永久占位')
    assert.equal(handle.isolation.allocator.findActive({ worktreeId })?.path, wtPath)
  })

  it('resumeWithWorktree 租约前置：验证失败（目录已消失）释放占位租约，不留永久占位', { timeout: 60_000 }, async () => {
    const handle = makeFakeIsolation({ existsValue: false })
    handle.kvStore.setParsed('builtin:worktree', WORKTREES_KV_NAMESPACE, 'local:/wt/resume-race', {
      id: 'local:/wt/resume-race',
      nodeId: 'local',
      path: '/wt/resume-race',
      branch: 'helmx/spawn-resume1',
      repoRoot: '/repo',
      baseCommit: 'abc',
      parentConversationId: 1,
      conversationId: 42,
      createdAt: 1,
      status: 'active',
      origin: 'native',
    })

    await assert.rejects(
      () =>
        handle.isolation.aroundSpawn(
          { parentConversationId: 1, prompt: '续接', resume: '42', onResolved: () => {} } as never,
          async () => 'unreachable',
        ),
      (err: unknown) => {
        assert.ok(err instanceof HelmxError)
        assert.equal(err.code, 'worktree_missing')
        return true
      },
    )
    assert.equal(leaseCount(handle.kvStore), 0, 'neverStarted 路径必须释放占位租约')
  })

  it('动态 nodeId：spawnWithWorktree / acquire_worktree 透传 requestNodeId、非法 nodeId 与 resume+nodeId 显式 400 validation_error', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't24-dyn-node')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const resolvedTargets: Array<Record<string, unknown>> = []
    const { host, close } = await openWorkflowPluginHost({
      repoDir: repo,
      dataDir: join(dir, 'data'),
      docs,
      onResolveSpawnTarget: (input) => {
        resolvedTargets.push({ ...input })
      },
    })
    try {
      // 1) acquire_worktree 透传有效 requestNodeId 到 resolveSpawnTarget 并落库对应 nodeId。
      const caller = { surface: 'plugin' as const, callerPluginId: 'builtin:swarm' }
      const acquired = (await host.invokeAction(
        'builtin:worktree',
        'acquire_worktree',
        {
          conversationId: 88,
          parentConversationId: 1,
          profileId: 'coder',
          requestNodeId: 'gpu-box',
          requestCwd: repo,
          hold: { holdId: 'grp-dyn:worker', label: 'dynamic node worker' },
        },
        {},
        caller,
      )) as { worktreeId: string; path: string; nodeId: string }
      assert.equal(acquired.nodeId, 'gpu-box')
      assert.equal(acquired.worktreeId, `gpu-box:${acquired.path}`)
      assert.deepEqual(resolvedTargets, [
        {
          parentConversationId: 1,
          profileId: 'coder',
          requestNodeId: 'gpu-box',
          requestCwd: repo,
        },
      ])

      // 2) 直接调用 isolation.acquireWorktree 校验非法 requestNodeId（在 resolveSpawnTarget 与 git 前 400）。
      const directResolved: Array<Record<string, unknown>> = []
      const directKvStore = new MemoryKvStore()
      const directIsolation = new WorktreeIsolation({
        host: {
          resolveSpawnTarget: async (input) => {
            directResolved.push({ ...input })
            return {
              nodeId: input.requestNodeId ?? 'local',
              sourceCwd: input.requestCwd ?? repo,
              parentCwd: repo,
            }
          },
          execEnv: async (req) => {
            const env = new NodeExecutionEnv({ cwd: req.cwd ?? repo })
            let output = ''
            const r = await env.exec(
              req.command as string | readonly string[],
              {
                ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
                onOutput: (t: string) => {
                  output += t
                },
              },
              BACKGROUND_CONTEXT,
            )
            if (!r.ok) return { ok: false, exitCode: null, output, timedOut: r.error.code === 'timeout' }
            return { ok: r.value.exitCode === 0, exitCode: r.value.exitCode, output, timedOut: false }
          },
          executionEnv: (_nodeId, cwd) => new NodeExecutionEnv({ cwd }),
          inspectNodePathUsage: (input) => bareFabricOf().inspectPathUsage(input.nodeId, input.path, input.signal),
          listActiveSpawnExecutions: () => [],
          redact: (text) => text,
          getConversation: () => ({ cwd: repo, nodeId: 'local', status: 'idle', profileId: 'assistant' }),
        },
        kv: createMemoryWorktreeKv(directKvStore),
      })
      for (const badNodeId of ['', 'bad node', '../escape']) {
        await assert.rejects(
          () =>
            directIsolation.acquireWorktree({
              conversationId: 90,
              parentConversationId: 1,
              requestNodeId: badNodeId,
              hold: { pluginId: 'builtin:swarm', holdId: 'h', label: 'l' },
            }),
          (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
        )
      }
      assert.equal(directResolved.length, 0, '非法 requestNodeId 不得触发 resolveSpawnTarget')

      // 3) spawnWithWorktree 透传动态 request.nodeId（不传时不注入 requestNodeId 键），并拒绝非法 request.nodeId。
      await assert.rejects(
        () =>
          directIsolation.aroundSpawn(
            {
              parentConversationId: 1,
              prompt: '非法节点',
              isolation: 'worktree',
              nodeId: 'bad node',
            } as never,
            async () => 'unreachable',
          ),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
      )
      assert.equal(directResolved.length, 0)

      let seenFinalRequest: AgentSpawnRequest | undefined
      let resolvedInfo: AgentExecutionInfo | undefined
      const spawnRes = await directIsolation.aroundSpawn(
        {
          parentConversationId: 1,
          prompt: '远端动态节点任务',
          isolation: 'worktree',
          nodeId: 'build-node',
          cwd: repo,
          onResolved: (info: AgentExecutionInfo) => {
            resolvedInfo = info
          },
        } as never,
        async (final) => {
          seenFinalRequest = final as AgentSpawnRequest
          seenFinalRequest.onResolved?.({ conversationId: 55, nodeId: 'build-node' })
          return 'spawn-ok'
        },
      )
      assert.equal(spawnRes, 'spawn-ok')
      assert.deepEqual(directResolved, [
        {
          parentConversationId: 1,
          profileId: 'assistant',
          requestNodeId: 'build-node',
          requestCwd: repo,
        },
      ])
      assert.equal(seenFinalRequest?.nodeId, 'build-node')
      assert.equal(resolvedInfo?.nodeId, 'build-node')
      assert.ok(extractWorktreeExecutionMeta(resolvedInfo!).worktree?.id?.startsWith('build-node:'))

      // 未传 request.nodeId 时，resolveSpawnTarget 入参不含 requestNodeId 键。
      directResolved.length = 0
      await directIsolation.aroundSpawn(
        {
          parentConversationId: 1,
          prompt: '省略 nodeId 任务',
          isolation: 'worktree',
          cwd: repo,
        } as never,
        async (final) => {
          ;(final as AgentSpawnRequest).onResolved?.({ conversationId: 56, nodeId: 'local' })
          return 'omitted-ok'
        },
      )
      assert.deepEqual(directResolved, [
        {
          parentConversationId: 1,
          profileId: 'assistant',
          requestCwd: repo,
        },
      ])
      assert.equal('requestNodeId' in directResolved[0]!, false)

      // 4) resumeWithWorktree 携带 request.nodeId 显式 400 validation_error（零租约残留、零 next 调用）。
      let nextCalled = false
      for (const nodeId of ['local', 'build-node', 'other-node']) {
        await assert.rejects(
          () =>
            directIsolation.aroundSpawn(
              {
                parentConversationId: 1,
                prompt: '续接并切换节点',
                resume: '55',
                nodeId,
                onResolved: () => {},
              } as never,
              async () => {
                nextCalled = true
                return 'unreachable'
              },
            ),
          (err: unknown) =>
            err instanceof HelmxError &&
            err.code === 'validation_error' &&
            err.status === 400 &&
            err.message.includes('nodeId and resume are mutually exclusive'),
        )
      }
      assert.equal(nextCalled, false)
      assert.equal(
        leaseCount(directKvStore),
        0,
        'resume+nodeId 拒绝不得残留租约',
      )
    } finally {
      await close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('WorktreeStore KV 持久化契约（单条隔离 / >1000 分页遍历 / 超长与特殊键 / service.stop flush）', { timeout: 60_000 }, () => {
  it('按单条 KV 独立落库（零 worktree-state 文档写入）并在 service.stop 时经 stopWindow flush KV', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't25-kv-stop')
    const repo = makeGitRepo(join(dir, 'repo'))
    const kvStore = new MemoryKvStore()
    let flushes = 0
    const { host, globalDocs, close } = await openWorkflowPluginHost({
      repoDir: repo,
      dataDir: join(dir, 'data'),
      docs: kvStore,
      plugins: 'worktree-only',
      onFlush: () => {
        flushes += 1
      },
    })
    try {
      const caller = { surface: 'plugin' as const, callerPluginId: 'builtin:swarm' }
      const acquired = (await host.invokeAction(
        'builtin:worktree',
        'acquire_worktree',
        {
          conversationId: 77,
          parentConversationId: 1,
          requestCwd: repo,
          hold: { holdId: 'kv:stop-test', label: 'kv stop flush test' },
        },
        {},
        caller,
      )) as { worktreeId: string; path: string }
      assert.equal(globalDocs.has('builtin:worktree:worktree-state'), false, '不再写入旧 worktree-state 全局文档')
      assert.equal(
        kvStore.getParsed<ManagedWorktreeRecord>('builtin:worktree', WORKTREES_KV_NAMESPACE, acquired.worktreeId)?.id,
        acquired.worktreeId,
        '受管 worktree 应按单条 KV 独立存于 worktrees 命名空间',
      )

      // 释放 hold 后 disable('builtin:worktree') 触发 service.stop()，验证 stopWindow 内 flush KV 被调用。
      await host.invokeAction(
        'builtin:worktree',
        'release_worktree_hold',
        { worktreeId: acquired.worktreeId, holdId: 'kv:stop-test' },
        {},
        caller,
      )
      const flushesBeforeStop = flushes
      await host.disable('builtin:worktree')
      assert.ok(flushes > flushesBeforeStop, 'service.stop() 必须在 stopWindow 内 flush KV')
    } finally {
      await close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('WorktreeStore 分页遍历突破单页 1000 条上限（records / listLeases / pruneConversation 全量可见）', { timeout: 60_000 }, async () => {
    const kvStore = new MemoryKvStore()
    const store = new WorktreeStore({
      kv: createMemoryWorktreeKv(kvStore),
      redact: (text) => text,
    })
    const total = 1005
    for (let i = 0; i < total; i += 1) {
      const id = `local:/wt/item-${String(i).padStart(4, '0')}`
      store.append({
        id,
        nodeId: 'local',
        repoRoot: '/repo',
        path: `/wt/item-${String(i).padStart(4, '0')}`,
        branch: `helmx/spawn-${String(i).padStart(4, '0')}`,
        baseCommit: 'a'.repeat(40),
        dirtySource: false,
        parentConversationId: i === 1004 ? 999 : 1,
        conversationId: 2000 + i,
        origin: 'native',
        status: i === 1004 ? 'removed' : 'active',
        createdAt: i + 1,
        ...(i === 1004 ? { removedAt: i + 2 } : {}),
      })
      store.recordAgentBinding(`ag-${String(i).padStart(4, '0')}`, 2000 + i, i === 1004 ? 999 : 1)
    }

    assert.equal(store.records().length, total, 'records() 必须跨 cursor 分页取回全部 1005 条记录')
    assert.equal(store.list()[0]!.id, 'local:/wt/item-1004', 'list() 按 createdAt 倒序包含第 2 页条目')
    assert.equal(
      store.resolveResumeChildId({ parentConversationId: 1, prompt: 'p', resume: 'ag-1004' } as never),
      3004,
      '单键 O(1) 读取位于第 2 页的 agent 绑定',
    )

    // pruneConversation 跨页裁剪位于第 2 页的 removed 记录与 agent 绑定
    store.pruneConversation(999)
    assert.equal(store.records().length, total - 1, 'pruneConversation 必须跨页删除第 2 页的 removed 记录')
    assert.equal(store.findById('local:/wt/item-1004'), undefined)
    assert.equal(
      store.resolveResumeChildId({ parentConversationId: 1, prompt: 'p', resume: 'ag-1004' } as never),
      undefined,
      'pruneConversation 必须跨页删除第 2 页的 agent 绑定',
    )
  })

  it('超长 worktreeId（>256 字符）、sha256: 前缀与含控制字符的 agentId 经单射键编码安全落库且可精确读写/裁剪', { timeout: 60_000 }, async () => {
    const kvStore = new MemoryKvStore()
    const host = new PluginHost({
      buildProvider: createPluginBuildProvider(),
      dataDir: join(rootDir, 't25-long-key'),
      host: { ...createWorktreeHostBackendFixture(), emitEvent: () => {} },
      docs: new MemoryDocStore(),
      kv: kvStore,
    })
    try {
      let store!: WorktreeStore
      await host.register({
        id: 'test:wt-kv-keys',
        definePlugin(ctx) {
          store = new WorktreeStore({
            kv: {
              worktrees: ctx.kv<ManagedWorktreeRecord>(WORKTREES_KV_NAMESPACE),
              leases: ctx.kv<WorktreeLeaseRecord>(LEASES_KV_NAMESPACE),
              agentBindings: ctx.kv<WorktreeAgentBinding>(AGENT_BINDINGS_KV_NAMESPACE),
            },
            redact: (t) => t,
          })
        },
      })

      const longPath = `/repo/${'nested-dir-segment/'.repeat(18)}wt`
      const longId = `local:${longPath}`
      assert.ok(longId.length > 256, '测试前提：worktreeId 超过 ctx.kv 256 字符键长上限')
      assert.ok(worktreeKvKey(longId).length <= 256 && worktreeKvKey(longId).startsWith('sha256:'))

      const prefixId = 'sha256:/repo/wt'
      assert.notEqual(worktreeKvKey(prefixId), prefixId, 'sha256: 前缀原键须哈希防碰撞')

      for (const id of [longId, prefixId]) {
        store.append({
          id,
          nodeId: id.split(':')[0]!,
          repoRoot: '/repo',
          path: id.slice(id.indexOf(':') + 1),
          branch: 'helmx/spawn-long',
          baseCommit: 'b'.repeat(40),
          dirtySource: false,
          parentConversationId: 1,
          conversationId: 801,
          origin: 'native',
          status: 'active',
          createdAt: 100,
        })
        assert.equal(store.findById(id)?.id, id, '经真实 PluginKvRegistry 写入后可按原 id 精确找回')
        store.updateRecord(id, (r) => ({ ...r, status: 'removed', removedAt: 200 }))
        assert.equal(store.findById(id)?.status, 'removed')
      }

      const trickyAgentId = `agent\twith\nctrl-${'x'.repeat(260)}`
      store.recordAgentBinding(trickyAgentId, 801, 1)
      assert.equal(
        store.resolveResumeChildId({ parentConversationId: 1, prompt: 'p', resume: trickyAgentId } as never),
        801,
      )

      store.pruneConversation(801)
      assert.equal(store.findById(longId), undefined)
      assert.equal(store.findById(prefixId), undefined)
      assert.equal(
        store.resolveResumeChildId({ parentConversationId: 1, prompt: 'p', resume: trickyAgentId } as never),
        undefined,
      )
    } finally {
      await host.dispose()
    }
  })

  it('reattachWithWorktree 预校验先行（验证失败零泄漏 running 租约）且 WorktreeStore 内存缓存使高频读取/hasActiveRecords 零重复 KV 扫描', { timeout: 60_000 }, async () => {
    // 1) reattachWithWorktree（cwd 命中受管 worktree 且无 resume）：verifyForResume 失败时绝不残留 running 租约
    const reattachHandle = makeFakeIsolation({ existsValue: false })
    reattachHandle.kvStore.setParsed('builtin:worktree', WORKTREES_KV_NAMESPACE, 'local:/wt/reattach-missing', {
      id: 'local:/wt/reattach-missing',
      nodeId: 'local',
      path: '/wt/reattach-missing',
      branch: 'helmx/spawn-reattach1',
      repoRoot: '/repo',
      baseCommit: 'abc',
      parentConversationId: 1,
      conversationId: 77,
      createdAt: 1,
      status: 'active',
      origin: 'native',
    })
    await assert.rejects(
      () =>
        reattachHandle.isolation.aroundSpawn(
          { parentConversationId: 1, prompt: 'reattach', reattach: { conversationId: 77 }, onResolved: () => {} } as never,
          async () => 'unreachable',
        ),
      (err: unknown) => err instanceof HelmxError && err.code === 'worktree_missing',
    )
    assert.equal(leaseCount(reattachHandle.kvStore), 0, 'reattach 验证失败不得残留任何 running 租约')

    // 2) WorktreeStore O(1) 缓存：首次水合后连续调用 hasActiveRecords / findById / list 零底层 KV list/get 扫描
    const kvStore = new MemoryKvStore()
    const baseHandles = createMemoryWorktreeKv(kvStore)
    let worktreeListCalls = 0
    let worktreeGetCalls = 0
    const trackedStore = new WorktreeStore({
      kv: {
        ...baseHandles,
        worktrees: {
          ...baseHandles.worktrees,
          list: (opts) => {
            worktreeListCalls += 1
            return baseHandles.worktrees.list(opts)
          },
          get: (key) => {
            worktreeGetCalls += 1
            return baseHandles.worktrees.get(key)
          },
        },
      },
      redact: (t) => t,
    })
    assert.equal(trackedStore.hasActiveRecords(), false)
    assert.equal(worktreeListCalls, 1, '首次水合仅扫描一次 KV')

    trackedStore.append({
      id: 'local:/wt/cached-1',
      nodeId: 'local',
      repoRoot: '/repo',
      path: '/wt/cached-1',
      branch: 'helmx/spawn-c1',
      baseCommit: 'a'.repeat(40),
      dirtySource: false,
      parentConversationId: 1,
      conversationId: 10,
      origin: 'native',
      status: 'active',
      createdAt: 10,
    })
    for (let i = 0; i < 20; i += 1) {
      assert.equal(trackedStore.hasActiveRecords(), true)
      assert.equal(trackedStore.findById('local:/wt/cached-1')?.status, 'active')
      assert.equal(trackedStore.list().length, 1)
    }
    assert.equal(worktreeListCalls, 1, '高频 before_turn / list 查询零额外 KV 扫描')
    assert.equal(worktreeGetCalls, 0, 'findById 直接命中内存索引零 KV get')

    trackedStore.updateRecord('local:/wt/cached-1', (r) => ({ ...r, status: 'removed', removedAt: 20 }))
    assert.equal(trackedStore.hasActiveRecords(), false, '置为 removed 后 activeCount 即时归零')
    assert.equal(trackedStore.findById('local:/wt/cached-1')?.status, 'removed', 'removed 记录保留审计历史不按 TTL 静默删除')
  })

  it('受管技能 worktree：启动自举、停用即时消失无幻影提示，且 workflow 技能不硬编码 builtin:worktree 动作', { timeout: 60_000 }, async () => {
    const { createHelmx } = await import('../../hub/src/app.js')
    const dataDir = mkdtempSync(join(tmpdir(), 'helmx-worktree-skill-'))
    const faux = makeFauxProvider()
    const app = await createHelmx({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: dataDir,
      model: 'faux/faux-1',
      providers: [faux.provider],
    })
    try {
      const { kernel } = app
      const skills = await kernel.skills.list()
      const wtSkill = skills.find((s) => s.id === WORKTREE_SKILL_ID)
      assert.ok(wtSkill, 'builtin:worktree 启动应自举受管技能 worktree')
      assert.equal(wtSkill.managedByPlugin, 'builtin:worktree')

      const wtSkillMd = await kernel.skills.readFile(WORKTREE_SKILL_ID)
      assert.ok(wtSkillMd.includes('managedByPlugin: builtin:worktree'))
      assert.ok(wtSkillMd.includes('builtin:worktree.list_worktrees'))
      assert.ok(wtSkillMd.includes('builtin:worktree.inspect_worktree'))
      assert.ok(wtSkillMd.includes('cleanup_worktree'))
      assert.ok(wtSkillMd.includes('rm -rf'))

      // workflow 主技能不再硬编码 builtin:worktree.* 动作，改为条件引用 worktree 技能
      const wfSkillMd = await kernel.skills.readFile('workflow')
      assert.equal(wfSkillMd.includes('builtin:worktree.list_worktrees'), false, 'workflow/SKILL.md 不得硬编码 builtin:worktree.list_worktrees')
      assert.equal(wfSkillMd.includes('builtin:worktree.inspect_worktree'), false, 'workflow/SKILL.md 不得硬编码 builtin:worktree.inspect_worktree')
      assert.equal(wfSkillMd.includes('builtin:worktree.cleanup_worktree'), false, 'workflow/SKILL.md 不得硬编码 builtin:worktree.cleanup_worktree')
      assert.ok(wfSkillMd.includes('load_skill'), 'workflow/SKILL.md 应引导按需加载 worktree 技能')

      const readSkillsSection = async () => {
        const res = await kernel.plugins.runHook('before_turn', {
          conversation: kernel.conversations.getConversation(1),
          inputs: [],
          sections: [],
          tools: [],
          messages: [],
        })
        assert.equal(res.action, 'transform')
        return res.value.sections.find((s) => s.id === 'profile.skills')?.text ?? ''
      }

      assert.ok((await readSkillsSection()).includes('id="worktree"'), '启用时 <available_skills> 应包含 worktree')
      const loaded = (await kernel.plugins.executeTool(
        'load_skill',
        { skillId: WORKTREE_SKILL_ID },
        { conversationId: 1 },
      )) as { text: string }
      assert.ok(loaded.text.includes('# Managed Git Worktrees'))

      // 停用 builtin:worktree 后 worktree 技能即时消失且 load_skill 显式拒绝
      await kernel.plugins.disable('builtin:worktree')
      const sectionAfterDisable = await readSkillsSection()
      assert.equal(sectionAfterDisable.includes('id="worktree"'), false, '停用后 <available_skills> 不得残留 worktree 技能')
      assert.ok(sectionAfterDisable.includes('id="workflow"'), '停用 worktree 不影响 workflow 技能')
      await assert.rejects(
        () => kernel.plugins.executeTool('load_skill', { skillId: WORKTREE_SKILL_ID }, { conversationId: 1 }),
        (err: unknown) => err instanceof HelmxError && err.code === 'skill_not_available' && err.status === 403,
      )

      // 重新启用后恢复
      await kernel.plugins.enable('builtin:worktree')
      assert.ok((await readSkillsSection()).includes('id="worktree"'), '重新启用后 worktree 技能应恢复')
    } finally {
      await app.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
