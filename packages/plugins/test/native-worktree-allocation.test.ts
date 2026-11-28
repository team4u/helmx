/**
 * 原生 spawn isolation: worktree 分配、并发互斥、resume、嵌套派生、元信息安全与 inspect 只读检视测试。
 */
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { HelmxError, type AgentExecutionInfo } from '@helmx/protocol'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SecretStash } from '@helmx/kernel'
import { runNativeSpawn } from '@helmx/kernel/testing'
import { WorktreeAllocator, type ManagedWorktreeRecord } from '../src/worktree/worktree.js'
import { WORKTREES_KV_NAMESPACE } from '../src/worktree/worktree-store.js'
import { resolveWorktreeContextSection } from '../src/worktree/worktree-context.js'
import { extractWorktreeExecutionMeta } from '../src/contracts.js'
import {
  createGitTemplate,
  createMemoryWorktreeKv,
  MemoryKvStore,
  type GitTemplate,
} from './helpers/plugin-test-env.js'
import {
  bareAllocator,
  bareFabricOf,
  childPromptText,
  dirnameOf,
  localNodePorts,
  openSpawnHarness,
  rawRecords,
  stubChunkedExec,
} from './helpers/native-worktree-harness.js'

let rootDir: string
let gitTemplate: GitTemplate

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helmx-native-worktree-alloc-'))
  gitTemplate = createGitTemplate('helmx-native-wt-alloc-tpl-')
}, { timeout: 60_000 })

after(() => {
  gitTemplate.cleanup()
  rmSync(rootDir, { recursive: true, force: true })
}, { timeout: 60_000 })

function makeGitRepo(dir: string): string {
  return gitTemplate.cloneTo(dir)
}

describe('原生 isolation: worktree 基础链路', { timeout: 60_000 }, () => {
  it('创建真实 worktree 与 helmx/spawn-* 分支；onResolved 回传 worktree；子会话与 gate 均在 worktree 内执行', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't1')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let resolved: AgentExecutionInfo | undefined
      th.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'pwd && git branch --show-current' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('任务完成'),
      ])
      const result = await th.spawnIsolated({
        parentConversationId: 1,
        prompt: '在 worktree 里执行 pwd',
        isolation: 'worktree',
        gate: 'test -f README.md && git rev-parse --is-inside-work-tree | grep -qx true',
        onResolved: (info: AgentExecutionInfo) => {
          resolved = info
        },
      } as never)
      assert.equal(result, '任务完成')

      // onResolved：worktree 元数据回传（path/branch），path 位于同级 .helmx-worktrees。
      const resolvedWt = resolved !== undefined ? extractWorktreeExecutionMeta(resolved).worktree : undefined
      assert.ok(resolvedWt, 'onResolved 应回传 worktree 元数据')
      const wtPath = resolvedWt!.path
      const wtBranch = resolvedWt!.branch
      assert.ok(wtBranch.startsWith('helmx/spawn-'), `分支名应为 helmx/spawn-*：${wtBranch}`)
      assert.ok(wtPath.includes(join(dir, '.helmx-worktrees')), `worktree 应位于同级 .helmx-worktrees 下：${wtPath}`)
      assert.ok(existsSync(wtPath), 'worktree 目录应真实存在')
      assert.ok(existsSync(join(wtPath, 'README.md')), 'worktree 应检出初始提交内容')
      assert.equal(resolved!.effectiveCwd, wtPath, 'effectiveCwd 应为 worktree 目录')

      // 子会话 cwd 为 worktree 目录（镜像 + SDK 真实 pwd 取证）。
      const childId = resolved!.conversationId!
      assert.ok(childId > 0)
      assert.equal(th.mirrors.get(childId)?.cwd, wtPath, '子会话镜像 cwd 应为 worktree 目录')
      const prompt = await childPromptText(th.harness, childId)
      assert.ok(prompt.includes('在 worktree 里执行 pwd'), 'prompt 应原样提交给子会话')
      // worktree 上下文统一由 before_turn 段落注入，不再拼接进子会话提示词。
      assert.ok(!prompt.includes('<worktree_context>'), `spawn 提示词不应重复拼接 <worktree_context>：${prompt.slice(-400)}`)
      // gate 在 worktree 目录内执行：gate 命令校验 pwd 与 worktree 一致
      //（HELMX_EXPECTED_WT 由下方第二次调用验证；首次用 gate 已通过的事实）。
      const allocatorRecord = th.allocator.findActive({ path: wtPath })
      assert.ok(allocatorRecord, '受管记录应已登记')
      const section = resolveWorktreeContextSection(allocatorRecord)
      assert.ok(section && section.text.includes('<worktree_context>'), 'before_turn 段落应提供 <worktree_context>')
      assert.ok(section!.text.includes('git add') && section!.text.includes('git commit'), '段落应提醒结束回合前提交改动')
      assert.equal(allocatorRecord!.branch, wtBranch)
      assert.equal(allocatorRecord!.origin, 'native')
      assert.equal(allocatorRecord!.dirtySource, false, '干净源仓库 dirtySource 应为 false')
      assert.ok(/^[0-9a-f]{40}$/.test(allocatorRecord!.baseCommit), 'baseCommit 应为完整提交哈希')
    } finally {
      await th.close()
    }
  })

  it('gate 真实在 worktree 目录内执行（pwd 校验 + 文件存在性校验）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't1-gate')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let gateOutput = ''
      th.faux.setResponses([fauxAssistantMessage('gate 取证完成')])
      let wtPath = ''
      await th.spawnIsolated({
        parentConversationId: 1,
        prompt: 'gate 取证',
        isolation: 'worktree',
        gate: 'pwd > .helmx-gate-pwd.txt && test -f README.md',
        onResolved: (info: AgentExecutionInfo) => {
          wtPath = extractWorktreeExecutionMeta(info).worktree?.path ?? ''
        },
      } as never)
      assert.ok(wtPath !== '', '应回传 worktree path')
      // gate 在 worktree 目录内执行：其产物文件落在 worktree 而非源仓库。
      assert.ok(existsSync(join(wtPath, '.helmx-gate-pwd.txt')), 'gate 产物应落在 worktree 目录内（gate cwd = worktree）')
      const { readFileSync } = await import('node:fs')
      gateOutput = readFileSync(join(wtPath, '.helmx-gate-pwd.txt'), 'utf8').trim()
      assert.equal(gateOutput, wtPath, `gate pwd 应为 worktree 目录：${gateOutput}`)
      assert.ok(!existsSync(join(repo, '.helmx-gate-pwd.txt')), '源仓库不得被 gate 污染')
    } finally {
      await th.close()
    }
  })
})

describe('并发 worktree 分配（per-repo mutex）', { timeout: 60_000 }, () => {
  it('Promise.all 同时 4 个 allocate：全部成功创建，无 config.lock 冲突', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't2')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      const records = await Promise.all(
        [1, 2, 3, 4].map((i) =>
          th.allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1, labelHint: `p${i}` }),
        ),
      )
      assert.equal(records.length, 4)
      const paths = new Set(records.map((r) => r.path))
      const branches = new Set(records.map((r) => r.branch))
      assert.equal(paths.size, 4, '4 个 worktree 路径应互不相同')
      assert.equal(branches.size, 4, '4 个分支应互不相同')
      for (const record of records) {
        assert.ok(existsSync(record.path), `worktree 应存在：${record.path}`)
        assert.ok(record.branch.startsWith('helmx/spawn-'))
      }
    } finally {
      await th.close()
    }
  })
})

describe('非 Git 目录显式拒绝', { timeout: 60_000 }, () => {
  it('allocate 在非 Git 目录抛 not_a_git_repo（附真实 git 输出）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't3')
    const notRepo = join(dir, 'plain')
    mkdirSync(notRepo, { recursive: true })
    const th = await openSpawnHarness(notRepo, join(dir, 'data'))
    try {
      await assert.rejects(
        () => th.allocator.allocate({ nodeId: 'local', sourceCwd: notRepo, parentConversationId: 1 }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError, `应抛 HelmxError，实得 ${err}`)
          assert.equal(err.code, 'not_a_git_repo')
          assert.ok(err.message.includes(notRepo), '错误消息应含目录路径')
          return true
        },
      )
    } finally {
      await th.close()
    }
  })

  it('runNativeSpawn 在非 Git 目录传 isolation: worktree 抛 not_a_git_repo，不派生子会话', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't3b')
    const notRepo = join(dir, 'plain')
    mkdirSync(notRepo, { recursive: true })
    const th = await openSpawnHarness(notRepo, join(dir, 'data'))
    try {
      th.faux.setResponses([fauxAssistantMessage('不应到达')])
      await assert.rejects(
        () =>
          th.spawnIsolated({
            parentConversationId: 1,
            prompt: '任务',
            isolation: 'worktree',
          } as never),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'not_a_git_repo')
          return true
        },
      )
      assert.equal(th.mirrors.size, 0, '失败路径不得派生任何子会话')
    } finally {
      await th.close()
    }
  })
})

describe('dirty 源仓库诚实提示', { timeout: 60_000 }, () => {
  it('dirtySource 如实记录；before_turn 段落含 <worktree_context>（dirty 提示 + 提交提醒）且 prompt 不重复注入', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't4')
    const repo = makeGitRepo(join(dir, 'repo'))
    // 源工作区制造未提交修改（不 commit）。
    writeFileSync(join(repo, 'uncommitted.txt'), 'dirty\n')
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let childId = 0
      th.faux.setResponses([fauxAssistantMessage('完成')])
      await th.spawnIsolated({
        parentConversationId: 1,
        prompt: 'dirty 源任务',
        isolation: 'worktree',
        onResolved: (info: AgentExecutionInfo) => {
          childId = info.conversationId ?? 0
        },
      } as never)
      assert.ok(childId > 0)
      const record = th.allocator.getForConversation(childId)
      assert.ok(record, '应能按会话查询受管 worktree')
      assert.equal(record!.dirtySource, true, 'dirty 源仓库应如实记录 dirtySource=true')
      // 隔离工作树不包含源工作区未提交文件。
      assert.ok(!existsSync(join(record!.path, 'uncommitted.txt')), '隔离工作树基于 HEAD，不应包含源未提交文件')
      // prompt 保持干净，不重复拼接 <worktree_context>；由 resolveWorktreeContextSection 统一产出诚实提示。
      const prompt = await childPromptText(th.harness, childId)
      assert.ok(!prompt.includes('<worktree_context>'), `prompt 不应重复注入 <worktree_context>：${prompt.slice(-400)}`)
      const section = resolveWorktreeContextSection(record)
      assert.ok(section && section.text.includes('<worktree_context>'), 'before_turn 段落应含 <worktree_context>')
      assert.ok(section!.text.includes('不包含源工作区未提交的改动'), 'dirty 源段落应说明不含未提交改动')
      assert.ok(section!.text.includes(record!.branch), '段落应含分支名')
    } finally {
      await th.close()
    }
  })
})

describe('resume 续接绑定 worktree 的子会话', { timeout: 60_000 }, () => {
  it('沿用原 worktree 不二次创建；onResolved 回传 worktree 元数据', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't5')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let childId = 0
      let firstWt: { path: string; branch: string } | undefined
      th.faux.setResponses([fauxAssistantMessage('第一轮')])
      await th.spawnIsolated({
        parentConversationId: 1,
        prompt: '第一轮',
        isolation: 'worktree',
        onResolved: (info: AgentExecutionInfo) => {
          childId = info.conversationId ?? 0
          firstWt = extractWorktreeExecutionMeta(info).worktree
        },
      } as never)
      assert.ok(childId > 0 && firstWt)

      // resume：不传 isolation —— 严格沿用原 worktree。
      let resumedWt: { path: string; branch: string } | undefined
      th.faux.setResponses([fauxAssistantMessage('续接完成')])
      const second = await th.spawnIsolated({
        parentConversationId: 1,
        prompt: '续接',
        resume: String(childId),
        onResolved: (info: AgentExecutionInfo) => {
          resumedWt = extractWorktreeExecutionMeta(info).worktree
        },
      } as never)
      assert.equal(second, '续接完成')
      assert.ok(resumedWt, 'resume 的 onResolved 也应回传 worktree 元数据')
      assert.equal(resumedWt!.path, firstWt!.path, 'resume 应沿用原 worktree 路径')
      assert.equal(resumedWt!.branch, firstWt!.branch, 'resume 应沿用原 worktree 分支')
      assert.equal(th.mirrors.size, 1, 'resume 不得新建子会话')
      // resume 也不在 prompt 重复拼接，统一由 before_turn 段落注入。
      const resumedPrompt = await childPromptText(th.harness, childId)
      assert.ok(!resumedPrompt.includes('<worktree_context>'), 'resume prompt 不应重复注入 <worktree_context>')
      // 受管记录仍只有一条 active（未二次创建）。
      const record = th.allocator.getForConversation(childId)
      assert.ok(record)
      assert.equal(record!.path, firstWt!.path)
      const resumedSection = resolveWorktreeContextSection(record)
      assert.ok(resumedSection && resumedSection.text.includes('<worktree_context>'), 'resume 记录的 before_turn 段落仍生效')
    } finally {
      await th.close()
    }
  })

  it('resume 传冲突 cwd 显式抛 resume_cwd_conflict（不静默搬家）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't5b')
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

      await assert.rejects(
        () =>
          th.spawnIsolated({
            parentConversationId: 1,
            prompt: '续接',
            resume: String(childId),
            cwd: '/tmp/conflicting-cwd',
          } as never),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'resume_cwd_conflict')
          assert.ok(err.message.includes(record!.path), '错误消息应含原 worktree 路径')
          return true
        },
      )
    } finally {
      await th.close()
    }
  })

  it('worktree 目录被删后 resume 显式抛 worktree_missing', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't5c')
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
      // 外部强制删除 worktree 目录（模拟人类清理）。
      rmSync(record!.path, { recursive: true, force: true })
      await assert.rejects(
        () =>
          th.spawnIsolated({
            parentConversationId: 1,
            prompt: '续接',
            resume: String(childId),
          } as never),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_missing')
          return true
        },
      )
    } finally {
      await th.close()
    }
  })
})

describe('从已有 worktree 再派生（嵌套隔离）', { timeout: 60_000 }, () => {
  it('sourceCwd 为隔离 worktree 时定位真正主仓：同级分配不嵌套 .helmx-worktrees；baseCommit 取实际源 HEAD', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't12')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      const parent = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      // 父隔离树内提交（子树基准必须包含它，不得回退到主仓 HEAD）。
      writeFileSync(join(parent.path, 'parent-work.txt'), 'x\n')
      execFileSync('git', ['add', '.'], { cwd: parent.path })
      execFileSync('git', ['commit', '-qm', 'parent work'], { cwd: parent.path })
      const parentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: parent.path, encoding: 'utf8' }).trim()

      const child = await allocator.allocate({ nodeId: 'local', sourceCwd: parent.path, parentConversationId: 1 })
      assert.equal(child.repoRoot, repo, 'repoRoot 应为真正主工作树（不把隔离树当主仓）')
      assert.equal(child.baseCommit, parentHead, 'baseCommit 取实际源 HEAD（含父隔离树已提交改动）')
      // 多级派生父子字段：顶级记录源分支 main；子级记录父模块分支与父登记 ID。
      assert.equal(parent.baseBranch, 'main', '顶级派生应记录源目录检出的 main 分支')
      assert.equal(parent.parentWorktreeId, undefined, '主工作树不是受管 Worktree，无父登记 ID')
      assert.equal(child.baseBranch, parent.branch, '子级派生应记录父 Worktree 检出的分支')
      assert.equal(child.parentWorktreeId, parent.id, '源目录是受管隔离树时应记录父登记 ID')
      // 同级分配：child.path 与 parent.path 同在 <repo>/../.helmx-worktrees 下。
      assert.equal(
        dirnameOf(child.path),
        dirnameOf(parent.path),
        '嵌套派生不得反复嵌套 .helmx-worktrees',
      )
      assert.ok(existsSync(join(child.path, 'parent-work.txt')), '子树应包含父隔离树已提交内容')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('持久化元数据机密检查', { timeout: 60_000 }, () => {
  it('allocate 目标路径含 secret（redact 差异）拒绝且不落库', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't13b')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const SECRET = 'sk-alloc-secret-9'
    const allocator = bareAllocator(docs, { redact: (t) => t.replaceAll(SECRET, '***') })
    try {
      // 把主仓目录名改成含 secret 的形态（路径进持久化字段）。
      const secretRepoRoot = join(dir, `repo-${SECRET}`)
      execFileSync('git', ['clone', '-q', repo, secretRepoRoot], { cwd: dir })
      await assert.rejects(
        () => allocator.allocate({ nodeId: 'local', sourceCwd: secretRepoRoot, parentConversationId: 1 }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_metadata_secret')
          assert.ok(!err.message.includes(SECRET))
          return true
        },
      )
      assert.equal(rawRecords(docs).length, 0, '拒绝后不得有任何记录落库')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('inspect 只读检视：成功输出脱敏与 diff 驱动隔离（真实 git）', { timeout: 60_000 }, () => {
  it('diff/status 成功输出经 redact 脱敏：已登记秘密替换为 [REDACTED]，绝不原样回显', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't16')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const stash = new SecretStash()
    const secret = 'sk-live-9f2e7c41d8ab54'
    const release = stash.addRedaction(secret)
    const allocator = bareAllocator(docs, { redact: (t) => stash.redact(t) })
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      const git = (args: string[]) => execFileSync('git', args, { cwd: record.path, encoding: 'utf-8' })
      // 已提交改动内容含秘密（进 diff/统计）+ 未跟踪文件名含秘密（进状态清单）。
      writeFileSync(join(record.path, 'creds.txt'), `token=${secret}\n`)
      git(['add', 'creds.txt'])
      git(['commit', '-qm', 'feat: add creds'])
      writeFileSync(join(record.path, `${secret}.txt`), 'untracked\n')

      const result = await allocator.inspect({ worktreeId: record.id })
      assert.equal(result.exists, true)
      assert.ok(result.commits.some((c) => c.subject.includes('add creds')), 'commits 应包含新提交')
      assert.ok(
        result.files.some((f) => f.path.includes('[REDACTED]') && f.untracked),
        `文件名含秘密的文件条目必须脱敏（实得 ${JSON.stringify(result.files)}）`,
      )
      assert.ok(result.files.every((f) => !f.path.includes(secret)), '文件列表不得原样回显秘密')

      const fileDiff = await allocator.inspectFile({ worktreeId: record.id, filePath: 'creds.txt' })
      assert.equal(fileDiff.kind, 'diff')
      if (fileDiff.kind === 'diff') {
        const allText = fileDiff.hunks.flatMap((h) => h.rows.map((r) => r.text)).join('\n')
        assert.ok(allText.includes('[REDACTED]'), '单文件 diff 中秘密值必须脱敏')
        assert.ok(!allText.includes(secret), '单文件 diff 不得含原始秘密')
      }
      release()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('diff 固定 --no-ext-diff --no-textconv：自定义 diff 驱动与 textconv 过滤器均不触发（对照组可触发）', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't17')
    const repo = makeGitRepo(join(dir, 'repo'))
    // 自定义外部 diff 驱动与 textconv 过滤器：被调用即落 marker 文件并输出特征串。
    const driverMarker = join(dir, 'ext-diff-invoked')
    const textconvMarker = join(dir, 'textconv-invoked')
    writeFileSync(join(dir, 'fake-driver.sh'), `#!/bin/sh\ntouch '${driverMarker}'\necho DRIVER-RAN\n`)
    writeFileSync(join(dir, 'fake-textconv.sh'), `#!/bin/sh\ntouch '${textconvMarker}'\necho TEXCONV-RAN\n`)
    chmodSync(join(dir, 'fake-driver.sh'), 0o755)
    chmodSync(join(dir, 'fake-textconv.sh'), 0o755)
    writeFileSync(join(repo, 'note.txt'), 'note-v1\n')
    writeFileSync(join(repo, 'data.bin'), 'BINOLD\n')
    writeFileSync(join(repo, '.gitattributes'), '*.txt diff=helmxtest\n*.bin diff=helmxtext\n')
    const gitRepo = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    gitRepo(['add', '.'])
    gitRepo(['commit', '-qm', 'add bin + attributes'])
    gitRepo(['config', 'diff.helmxtest.command', join(dir, 'fake-driver.sh')])
    gitRepo(['config', 'diff.helmxtext.textconv', join(dir, 'fake-textconv.sh')])
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      writeFileSync(join(record.path, 'note.txt'), 'note-v2\n')
      writeFileSync(join(record.path, 'data.bin'), 'BINNEW-PAYLOAD-XYZ\n')
      const summary = await allocator.inspect({ worktreeId: record.id })
      assert.equal(summary.exists, true)
      assert.ok(summary.files.some((f) => f.path === 'data.bin'))
      const fileDiff = await allocator.inspectFile({ worktreeId: record.id, filePath: 'data.bin' })
      assert.equal(fileDiff.kind, 'diff')
      assert.ok(!existsSync(driverMarker), '外部 diff 驱动不得被触发（--no-ext-diff）')
      assert.ok(!existsSync(textconvMarker), 'textconv 过滤器不得被触发（--no-textconv）')
      if (fileDiff.kind === 'diff') {
        const allText = fileDiff.hunks.flatMap((h) => h.rows.map((r) => r.text)).join('\n')
        assert.ok(!allText.includes('DRIVER-RAN'), 'diff 应为真实内部 diff，而非驱动输出')
        assert.ok(!allText.includes('TEXCONV-RAN'), 'diff 不得经 textconv 过滤')
        assert.ok(allText.includes('BINNEW-PAYLOAD-XYZ'), '应显示真实内容行')
      }
      // 对照组：不带防护参数的裸 git diff 必须触发驱动（证明配置生效、测试非空转）。
      execFileSync('git', ['diff', record.baseCommit], { cwd: record.path, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
      assert.ok(existsSync(driverMarker), '对照组：裸 git diff 应触发外部驱动')
      assert.ok(existsSync(textconvMarker), '对照组：裸 git diff 应触发 textconv')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('已登记基线失效（baseCommit 不可达）显式 worktree_check_failed 并附真实 git 输出，无 fallback', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't18')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      // 篡改登记基线为不存在的提交（模拟 gc / 历史改写后失效）。
      const stored = docs.getParsed<ManagedWorktreeRecord>('builtin:worktree', WORKTREES_KV_NAMESPACE, record.id)!
      docs.setParsed('builtin:worktree', WORKTREES_KV_NAMESPACE, record.id, {
        ...stored,
        baseCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      })
      allocator.invalidateCache()
      await assert.rejects(
        () => allocator.inspect({ worktreeId: record.id }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_check_failed')
          assert.match(err.message, /bad object|unknown revision|fatal/i)
          return true
        },
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('inspect 受限采集与按需单文件预算（受控 exec 分块注入）', { timeout: 60_000 }, () => {
  it('inspect 仅跑 -z 元数据（绝不跑全量 diff），超过 500 文件保留真实总数并显式截断；inspectFile 拦截超大行数并携带防护参数', {
    timeout: 60_000,
  }, async () => {
    const base = 'a1b2c3d4'.repeat(5)
    const head = 'e5f6a7b8'.repeat(5)
    const statusTokens = [
      `# branch.oid ${head}`,
      '# branch.head stub-branch',
      '1 .M N... 100644 100644 100644 aaaaaaaa bbbbbbbb big.ts',
      ...Array.from({ length: 550 }, (_, i) => `? file-${String(i).padStart(3, '0')}.txt`),
    ]
    const patchBig = [
      'diff --git a/big.ts b/big.ts',
      '--- a/big.ts',
      '+++ b/big.ts',
      '@@ -1,1 +1,2 @@',
      ' line1',
      '+line2',
      '',
    ].join('\n')
    const stub = stubChunkedExec((args) => {
      const key = args.join(' ')
      if (key === 'status --porcelain=v2 --branch --untracked-files=all -z') {
        return { output: `${statusTokens.join('\0')}\0` }
      }
      if (key === 'status --porcelain=v2 --branch --untracked-files=all -z -- huge.ts') {
        return { output: `# branch.oid ${head}\0# branch.head stub-branch\0` }
      }
      if (key === 'status --porcelain=v2 --branch --untracked-files=all -z -- big.ts') {
        return { output: [`# branch.oid ${head}`, '# branch.head stub-branch', '1 .M N... 100644 100644 100644 aaaaaaaa bbbbbbbb big.ts', ''].join('\0') }
      }
      if (key === `rev-list --count ${base}..${head}`) return { output: '3\n' }
      if (key === 'rev-parse --path-format=absolute --git-common-dir') return { output: '/repo/.git\n' }
      if (key === 'worktree list --porcelain -z') return { output: `worktree /repo\0HEAD ${base}\0branch refs/heads/main\0\0` }
      if (key === `rev-list --count ${base}..stub-branch`) return { output: '3\n' }
      if (key === `diff --no-ext-diff --no-textconv --find-renames ${base} --numstat -z`) {
        return { output: '2\t1\tbig.ts\0' }
      }
      if (key === `diff --no-ext-diff --no-textconv --find-renames ${base} --name-status -z`) {
        return { output: 'M\0big.ts\0' }
      }
      if (key.startsWith(`log --no-show-signature -z --max-count=51`)) {
        return { output: `${head}\x1f${head.slice(0, 7)}\x1ffeat: stub commit\x1fTester\x1f1700000000\0` }
      }
      if (key === `diff --no-ext-diff --no-textconv --find-renames ${base} --numstat -z -- huge.ts`) {
        return { output: '5000\t10\thuge.ts\0' }
      }
      if (key === `diff --no-ext-diff --no-textconv --find-renames ${base} --name-status -z -- huge.ts`) {
        return { output: 'M\0huge.ts\0' }
      }
      if (key === `diff --no-ext-diff --no-textconv --find-renames ${base} --numstat -z -- big.ts`) {
        return { output: '1\t0\tbig.ts\0' }
      }
      if (key === `diff --no-ext-diff --no-textconv --find-renames ${base} --name-status -z -- big.ts`) {
        return { output: 'M\0big.ts\0' }
      }
      if (key === `diff --no-ext-diff --no-textconv --find-renames ${base} -U3 -- big.ts`) {
        return { output: patchBig }
      }
      return { output: '', exitCode: 1 }
    })
    stub.setChunkSize(7)
    const docs = new MemoryKvStore()
    docs.setParsed('builtin:worktree', WORKTREES_KV_NAMESPACE, 'local:/wt', {
      id: 'local:/wt',
      nodeId: 'local',
      repoRoot: '/repo',
      path: '/wt',
      branch: 'stub-branch',
      baseCommit: base,
      dirtySource: false,
      parentConversationId: 1,
      origin: 'native',
      status: 'active',
      createdAt: Date.now(),
    })
    const allocator = new WorktreeAllocator({
      exec: stub.exec as never,
      nodeExists: async () => ({ ok: true, value: true }) as never,
      nodeCanonicalPath: async () => ({ ok: true, value: '/wt' }) as never,
      inspectPathUsage: async () => {
        throw new HelmxError('unsupported', 'inspect 用例不扫描进程占用', 501)
      },
      kv: createMemoryWorktreeKv(docs),
    })

    const result = await allocator.inspect({ worktreeId: 'local:/wt' })
    assert.equal(result.summary.dirtyFileCount, 551)
    assert.equal(result.summary.untrackedCount, 550)
    assert.equal(result.summary.totalFiles, 551)
    assert.equal(result.files.length, 500)
    assert.equal(result.filesTruncated, true)
    assert.equal(result.files[0]!.path, 'big.ts')
    assert.equal(result.commits.length, 1)
    assert.equal(result.commitsAhead, 3)
    assert.equal(result.unmergedCommits, 3)
    assert.equal(result.branchChanged, undefined)
    // Summary never executes full-repo `git diff` without --numstat/--name-status.
    const fullRepoDiffCalls = stub.seen.filter(
      (a) => a.includes('diff') && !a.includes('--numstat') && !a.includes('--name-status'),
    )
    assert.equal(fullRepoDiffCalls.length, 0)

    const huge = await allocator.inspectFile({ worktreeId: 'local:/wt', filePath: 'huge.ts' })
    assert.equal(huge.kind, 'too_large')
    if (huge.kind === 'too_large') {
      assert.equal(huge.reason, 'line_budget_exceeded')
      assert.equal(huge.additions, 5000)
    }

    const big = await allocator.inspectFile({ worktreeId: 'local:/wt', filePath: 'big.ts' })
    assert.equal(big.kind, 'diff')
    if (big.kind === 'diff') {
      assert.equal(big.hunks.length, 1)
    }

    const diffInvocations = stub.seen.filter((a) => a.includes('diff'))
    assert.ok(diffInvocations.length >= 4)
    for (const argv of diffInvocations) {
      assert.ok(argv.includes('--no-ext-diff') && argv.includes('--no-textconv'), `diff 命令必须含防护参数（实得 ${argv.join(' ')}）`)
    }
  })

  it('git 失败显式 worktree_check_failed：长输出诊断截断（不静默当成功、不整段携带超长输出）', {
    timeout: 60_000,
  }, async () => {
    const base = 'a1b2c3d4'.repeat(5)
    const head = 'e5f6a7b8'.repeat(5)
    const stub = stubChunkedExec((args) => {
      const key = args.join(' ')
      if (key === 'status --porcelain=v2 --branch --untracked-files=all -z') {
        return { output: `# branch.oid ${head}\0# branch.head stub-branch\0` }
      }
      if (key === 'rev-parse --path-format=absolute --git-common-dir') return { output: '/repo/.git\n' }
      if (key === 'worktree list --porcelain -z') return { output: `worktree /repo\0HEAD ${base}\0branch refs/heads/main\0\0` }
      if (key.startsWith('rev-list') || key.startsWith('diff') || key.startsWith('log')) {
        return { output: `fatal: bad object ${base}\n${'x'.repeat(3000)}`, exitCode: 128 }
      }
      return { output: '' }
    })
    const docs = new MemoryKvStore()
    docs.setParsed('builtin:worktree', WORKTREES_KV_NAMESPACE, 'local:/wt', {
      id: 'local:/wt',
      nodeId: 'local',
      repoRoot: '/repo',
      path: '/wt',
      branch: 'stub-branch',
      baseCommit: base,
      dirtySource: false,
      parentConversationId: 1,
      origin: 'native',
      status: 'active',
      createdAt: Date.now(),
    })
    const allocator = new WorktreeAllocator({
      exec: stub.exec as never,
      nodeExists: async () => ({ ok: true, value: true }) as never,
      nodeCanonicalPath: async () => ({ ok: true, value: '/wt' }) as never,
      // inspect 只读面不触发进程扫描；如被误调即显式拒绝（不伪造）。
      inspectPathUsage: async () => {
        throw new HelmxError('unsupported', 'inspect 用例不扫描进程占用', 501)
      },
      kv: createMemoryWorktreeKv(docs),
    })
    await assert.rejects(
      () => allocator.inspect({ worktreeId: 'local:/wt' }),
      (err: unknown) => {
        assert.ok(err instanceof HelmxError)
        assert.equal(err.code, 'worktree_check_failed')
        assert.match(err.message, /bad object/)
        assert.ok(err.message.length < 3000, '错误消息不得整段携带超长输出')
        const details = err.details as { output?: string }
        assert.ok(details !== undefined && details.output !== undefined && details.output.length === 2000)
        return true
      },
    )
  })
})

describe('多级派生 baseBranch 字段', { timeout: 60_000 }, () => {
  it('detached HEAD 源目录：baseBranch 不记录（undefined），worktree 正常创建', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't19')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      execFileSync('git', ['checkout', '-q', '--detach'], { cwd: repo })
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      assert.equal(record.baseBranch, undefined, 'detached HEAD 不得记录 baseBranch')
      assert.ok(existsSync(record.path), 'detached HEAD 仍可正常派生 worktree')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('baseBranch 含已登记 secret：显式 worktree_metadata_secret 拒绝且不落库', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't19b')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new MemoryKvStore()
    const SECRET = '{{SECRET_bbrnch77}}'
    const allocator = bareAllocator(docs, { redact: (t) => t.replaceAll(SECRET, '***') })
    try {
      execFileSync('git', ['checkout', '-q', '-b', `dev-${SECRET}`], { cwd: repo })
      await assert.rejects(
        () => allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'worktree_metadata_secret')
          assert.ok(!err.message.includes(SECRET), 'message 绝不泄漏 secret 原文')
          return true
        },
      )
      assert.equal(rawRecords(docs).length, 0, '拒绝后不得有任何记录落库')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('allocate 批量 Git 预检与非常规布局诚实拒绝', { timeout: 60_000 }, () => {
  it('单次 allocate 全程仅触发 4 条 git 子命令（3 条预检 + 1 条 worktree add），且子目录 sourceCwd 精确定位仓库根', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't23-batch')
    const repo = makeGitRepo(join(dir, 'repo'))
    const subDir = join(repo, 'nested', 'module')
    mkdirSync(subDir, { recursive: true })
    const docs = new MemoryKvStore()
    const basePorts = localNodePorts()
    const gitCalls: string[][] = []
    const allocator = new WorktreeAllocator({
      ...basePorts,
      exec: async (nodeId, cwd, args, options) => {
        gitCalls.push([...args])
        return basePorts.exec(nodeId, cwd, args, options)
      },
      inspectPathUsage: (nodeId, path, signal) => bareFabricOf().inspectPathUsage(nodeId, path, signal),
      kv: createMemoryWorktreeKv(docs),
    })
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: subDir, parentConversationId: 1 })
      assert.equal(record.repoRoot, repo, '子目录 sourceCwd 应精确定位仓库主工作树')
      assert.equal(record.baseBranch, 'main')
      assert.equal(record.dirtySource, false)
      assert.equal(
        gitCalls.length,
        4,
        `allocate 应合并预检为 3 条 git 命令 + 1 条 worktree add（实得 ${gitCalls.length}: ${JSON.stringify(gitCalls)}）`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('裸仓库（bare）、--separate-git-dir 与无初始提交仓库（unborn HEAD）均返回精确错误码', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't23-layouts')
    mkdirSync(dir, { recursive: true })
    const docs = new MemoryKvStore()
    const allocator = bareAllocator(docs)
    try {
      // 1) bare 仓库 -> worktree_unsupported_layout
      const bareDir = join(dir, 'bare.git')
      execFileSync('git', ['init', '-q', '--bare', bareDir])
      await assert.rejects(
        () => allocator.allocate({ nodeId: 'local', sourceCwd: bareDir, parentConversationId: 1 }),
        (err: unknown) => err instanceof HelmxError && err.code === 'worktree_unsupported_layout',
      )

      // 2) --separate-git-dir -> worktree_unsupported_layout
      const sepGit = join(dir, 'sep-git')
      const sepWork = join(dir, 'sep-work')
      execFileSync('git', ['init', '-q', `--separate-git-dir=${sepGit}`, sepWork])
      await assert.rejects(
        () => allocator.allocate({ nodeId: 'local', sourceCwd: sepWork, parentConversationId: 1 }),
        (err: unknown) => err instanceof HelmxError && err.code === 'worktree_unsupported_layout',
      )

      // 3) unborn HEAD（git init 尚无任何 commit）-> worktree_failed
      const unbornDir = join(dir, 'unborn')
      execFileSync('git', ['init', '-q', '-b', 'main', unbornDir])
      await assert.rejects(
        () => allocator.allocate({ nodeId: 'local', sourceCwd: unbornDir, parentConversationId: 1 }),
        (err: unknown) => err instanceof HelmxError && err.code === 'worktree_failed',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
