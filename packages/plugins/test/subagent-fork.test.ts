/**
 * builtin:workflow（subagent fork + Git Worktree）与 builtin:herdr（assertNoFork）端到端测试：
 * - 真实 Git 仓库 + createHelmx + WorktreeAllocator：
 *   1. subagent({ fork: true, isolation: 'worktree', gate }) 省略 agentType 时继承非默认
 *      Profile 与父已完成上下文，在隔离工作树修改文件并通过 gate（源仓库无污染），
 *      随后可用返回 footer 中的 conversationId 经 subagent({ resume }) 在同一工作树续接；
 *   2. subagent({ fork: true, resume }) 显式返回错误信封（不派发、不建工作树）；
 *   3. herdr:* 与 Profile.runtime + fork: true + isolation: 'worktree' 显式拒绝
 *      unsupported_runtime，且 Worktree 列表与 git worktree list 零孤儿残留；
 * - HerdrExecutor.handle 对 herdr:* 与 Profile.runtime 携带 fork: true 防御性拒绝
 *   400 unsupported_runtime（零 transport 副作用），普通原生 fork 透传 continue。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai/providers/faux'
import { HelmxError, type AgentGateResult, type Profile } from '@helmx/protocol'
import { createProfilePlugin } from '../src/profile.js'
import { createWorkflowPlugin } from '../src/workflow.js'
import { createWorktreePlugin } from '../src/worktree.js'
import {
  assertRejectsCode,
  createGitTemplate,
  openMinimalRuntime,
  waitFor,
  type GitTemplate,
} from './helpers/plugin-test-env.js'

let savedHelmxModel: string | undefined
let rootDir: string
let gitTemplate: GitTemplate
let sharedEnv: Awaited<ReturnType<typeof openMinimalRuntime>>

before(async () => {
  savedHelmxModel = process.env['HELMX_MODEL']
  delete process.env['HELMX_MODEL']
  rootDir = mkdtempSync(join(tmpdir(), 'helmx-plugin-subagent-fork-'))
  gitTemplate = createGitTemplate('helmx-plugin-subagent-fork-git-')
  sharedEnv = await openMinimalRuntime(
    [createProfilePlugin(), createWorkflowPlugin(), createWorktreePlugin()],
    {
      dataDir: join(rootDir, 'shared-data'),
      cwd: rootDir,
      model: 'faux/faux-1',
      fauxOptions: {
        models: [
          { id: 'faux-1', reasoning: true },
          { id: 'faux-2', reasoning: true },
        ],
      },
    },
  )
}, { timeout: 60_000 })

after(async () => {
  await sharedEnv?.close().catch(() => {})
  if (savedHelmxModel === undefined) delete process.env['HELMX_MODEL']
  else process.env['HELMX_MODEL'] = savedHelmxModel
  gitTemplate.cleanup()
  rmSync(rootDir, { recursive: true, force: true })
}, { timeout: 60_000 })

function makeGitRepo(repoDir: string): string {
  return gitTemplate.cloneTo(repoDir)
}

function userMessageTexts(
  messages: ReadonlyArray<{ role?: string; content?: unknown }>,
): string[] {
  const texts: string[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    if (typeof message.content === 'string') {
      texts.push(message.content)
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
          texts.push((block as { text: string }).text)
        }
      }
    }
  }
  return texts
}

function findToolResultByCallId(
  detail: { entries: Array<{ model?: unknown[] }> },
  toolCallId: string,
): { text: string; isError: boolean; details?: Record<string, unknown> } {
  for (const entry of detail.entries) {
    for (const msg of entry.model ?? []) {
      const m = msg as {
        role?: string
        toolCallId?: string
        isError?: boolean
        details?: Record<string, unknown>
        content?: Array<{ type?: string; text?: string }>
      }
      if (m.role === 'toolResult' && m.toolCallId === toolCallId) {
        const text = (m.content ?? [])
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text!)
          .join('')
        return { text, isError: m.isError === true, ...(m.details !== undefined ? { details: m.details } : {}) }
      }
    }
  }
  throw new Error(`未找到 toolCallId=${toolCallId} 的工具结果`)
}

describe('subagent fork 与 Git Worktree 集成（最小 3-plugin 内核端到端）', { timeout: 60_000 }, () => {
  it('fork + isolation: worktree + gate 继承非默认 Profile 上下文，可用 conversationId 续接；fork+resume 报错', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'wt-fork-resume')
    const repo = makeGitRepo(join(dir, 'repo'))
    const { kernel, faux } = sharedEnv

    let childIdForResume: number | undefined
    const step: FauxResponseFactory = (context) => {
      const msgs = context.messages as Array<{ role?: string; content?: unknown; toolName?: string }>
      const users = userMessageTexts(msgs)
      const lastUser = users.at(-1) ?? ''
      const lastMsg = [...msgs].reverse().find((m) => m.role !== 'system')

      if (lastMsg?.role === 'user' && lastUser.includes('记住线索 TOKEN_WT_77')) {
        return fauxAssistantMessage('已记住 TOKEN_WT_77')
      }
      if (lastMsg?.role === 'user' && lastUser.includes('分叉写入工作树标记')) {
        return fauxAssistantMessage(
          [
            fauxToolCall(
              'subagent',
              {
                prompt: '写入标记文件并汇报',
                fork: true,
                isolation: 'worktree',
                gate: 'test -f .forked-marker && grep -q from-fork .forked-marker',
                background: false,
              },
              { id: 'call-wt-fork-1' },
            ),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'user' && lastUser.includes('写入标记文件并汇报')) {
        assert.ok(users.some((t) => t.includes('TOKEN_WT_77')), 'worktree fork 子代理必须继承父历史线索')
        return fauxAssistantMessage(
          [fauxToolCall('write', { path: '.forked-marker', content: 'from-fork\n' }, { id: 'call-write-1' })],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'toolResult' && lastMsg.toolName === 'write' && lastUser.includes('写入标记文件并汇报')) {
        return fauxAssistantMessage('已写入标记文件')
      }
      if (lastMsg?.role === 'user' && lastUser.includes('续接同一个分叉子代理')) {
        assert.ok(childIdForResume !== undefined)
        return fauxAssistantMessage(
          [
            fauxToolCall(
              'subagent',
              {
                resume: String(childIdForResume),
                prompt: '追加续接标记',
                background: false,
              },
              { id: 'call-wt-resume-1' },
            ),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'user' && lastUser.includes('追加续接标记')) {
        return fauxAssistantMessage(
          [
            fauxToolCall(
              'write',
              { path: '.forked-marker', content: 'from-fork\nresumed-ok\n' },
              { id: 'call-write-2' },
            ),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'toolResult' && lastMsg.toolName === 'write' && lastUser.includes('追加续接标记')) {
        return fauxAssistantMessage('续接追加完成')
      }
      if (lastMsg?.role === 'user' && lastUser.includes('触发 fork 与 resume 互斥报错')) {
        assert.ok(childIdForResume !== undefined)
        return fauxAssistantMessage(
          [
            fauxToolCall(
              'subagent',
              {
                fork: true,
                resume: String(childIdForResume),
                prompt: '不应执行',
                background: false,
              },
              { id: 'call-wt-conflict-1' },
            ),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'toolResult' && lastMsg.toolName === 'subagent') {
        return fauxAssistantMessage('父回合结束')
      }
      throw new Error(`未预期的 faux 请求: lastRole=${lastMsg?.role}, lastUser=${lastUser}`)
    }
    faux.setResponses(Array.from({ length: 24 }, () => step))

    const coderStaticCwd = makeGitRepo(join(dir, 'coder-static-cwd'))
    await kernel.services.profiles.save({
      id: 'coder',
      name: '编码代理',
      model: 'faux/faux-2',
      thinkingLevel: 'low',
      cwd: coderStaticCwd,
    })
    const parent = await kernel.conversations.createConversation({
      profileId: 'coder',
      cwd: repo,
    })

    await kernel.conversations.submitInput(parent.id, '记住线索 TOKEN_WT_77')
    await kernel.conversations.waitForIdle(parent.id)

    await kernel.conversations.submitInput(parent.id, '分叉写入工作树标记')
    await kernel.conversations.waitForIdle(parent.id)

    const children = kernel.conversations.listConversations({ parentConversationId: parent.id })
    assert.equal(children.length, 1)
    const child = children[0]!
    assert.equal(child.profileId, 'coder', '省略 agentType 的同 Profile fork 应继承非默认 Profile')
    assert.equal(child.model, 'faux/faux-2')
    assert.equal(child.thinkingLevel, 'low')
    assert.notEqual(child.cwd, repo, 'isolation: worktree 应分配独立工作树目录')
    assert.notEqual(child.cwd, coderStaticCwd, '同角色 fork 不得误用 Profile.cwd 替代 parent.cwd')
    const repoWorktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    assert.ok(repoWorktrees.includes(child.cwd), `worktree 必须从 parent.cwd(${repo}) 派生：\n${repoWorktrees}`)
    const staticRepoWorktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: coderStaticCwd, encoding: 'utf8' })
    assert.equal(
      staticRepoWorktrees.split('\n').filter((line) => line.startsWith('worktree ')).length,
      1,
      `Profile.cwd 仓库不得被派生工作树：\n${staticRepoWorktrees}`,
    )
    assert.ok(existsSync(join(child.cwd, '.forked-marker')), '标记文件应落在隔离工作树中')
    assert.ok(!existsSync(join(repo, '.forked-marker')), '源 Git 仓库绝不被污染')

    const detailTurn2 = await kernel.conversations.getConversationDetail(parent.id, { limit: 50 })
    const forkResult = findToolResultByCallId(detailTurn2, 'call-wt-fork-1')
    assert.equal(forkResult.isError, false)
    assert.equal(forkResult.text.includes('[subagent '), false, `不应含旧 footer：${forkResult.text}`)
    assert.equal((forkResult.details?.['execution'] as Record<string, unknown> | undefined)?.['conversationId'], child.id)
    assert.ok(forkResult.text.includes('已写入标记文件'))

    const wtAfterFork = (await kernel.plugins.invokeAction('builtin:worktree', 'list_worktrees', {})) as {
      worktrees: Array<{ conversationId: number; path: string }>
    }
    assert.equal(wtAfterFork.worktrees.length, 1)
    assert.equal(wtAfterFork.worktrees[0]!.conversationId, child.id)
    assert.equal(wtAfterFork.worktrees[0]!.path, child.cwd)

    // 续接同一个 forked 子会话（沿用同一 worktree）
    childIdForResume = child.id
    await kernel.conversations.submitInput(parent.id, '续接同一个分叉子代理')
    await kernel.conversations.waitForIdle(parent.id)

    const detailTurn3 = await kernel.conversations.getConversationDetail(parent.id, { limit: 50 })
    const resumeResult = findToolResultByCallId(detailTurn3, 'call-wt-resume-1')
    assert.equal(resumeResult.isError, false)
    assert.ok(resumeResult.text.includes('续接追加完成'))
    assert.equal(
      readFileSync(join(child.cwd, '.forked-marker'), 'utf8'),
      'from-fork\nresumed-ok\n',
      'resume 应在同一工作树继续修改',
    )

    // fork + resume 互斥返回错误信封且不新建子会话
    await kernel.conversations.submitInput(parent.id, '触发 fork 与 resume 互斥报错')
    await kernel.conversations.waitForIdle(parent.id)

    const detailTurn4 = await kernel.conversations.getConversationDetail(parent.id, { limit: 50 })
    const conflictResult = findToolResultByCallId(detailTurn4, 'call-wt-conflict-1')
    assert.equal(conflictResult.isError, true)
    assert.ok(
      conflictResult.text.includes('subagent_failed') && conflictResult.text.includes('fork') && conflictResult.text.includes('resume'),
      `fork+resume 应返回显式错误文本：${conflictResult.text}`,
    )
    assert.equal(kernel.conversations.listConversations({ parentConversationId: parent.id }).length, 1)
  })

  it('人类会话默认后台（省略 background）subagent({ fork: true })：立即返回后台句柄，结算后 steer 汇报并可 resume', { timeout: 60_000 }, async () => {
    const { kernel, faux } = sharedEnv
    const bgParent = await kernel.conversations.createConversation({ title: 'bg-default-fork', cwd: rootDir })
    const cid = bgParent.id

    let bgChildIdForResume: number | undefined
    const step: FauxResponseFactory = (context) => {
      const msgs = context.messages as Array<{ role?: string; content?: unknown; toolName?: string }>
      const users = userMessageTexts(msgs)
      const lastUser = users.at(-1) ?? ''
      const lastMsg = [...msgs].reverse().find((m) => m.role !== 'system')

      if (lastMsg?.role === 'user' && lastUser.includes('记住后台线索 BG_CLUE_99')) {
        return fauxAssistantMessage('已记住 BG_CLUE_99')
      }
      if (lastMsg?.role === 'user' && lastUser.includes('默认后台派发分叉子代理')) {
        return fauxAssistantMessage(
          [
            fauxToolCall(
              'subagent',
              { prompt: '后台分叉子任务', fork: true },
              { id: 'call-bg-fork-1' },
            ),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'user' && lastUser.includes('后台分叉子任务')) {
        assert.ok(users.some((t) => t.includes('BG_CLUE_99')), '后台 fork 子代理必须继承父已完成上下文')
        return fauxAssistantMessage('后台分叉子任务完成')
      }
      if (lastMsg?.role === 'toolResult' && lastMsg.toolName === 'subagent') {
        return fauxAssistantMessage(lastUser.includes('续接后台分叉') ? '后台续接汇总完成' : '已交由后台执行')
      }
      if (lastMsg?.role === 'user' && lastUser.includes('续接后台分叉')) {
        assert.ok(bgChildIdForResume !== undefined)
        return fauxAssistantMessage(
          [
            fauxToolCall(
              'subagent',
              { resume: String(bgChildIdForResume), prompt: '后台续接核验', background: false },
              { id: 'call-bg-resume-1' },
            ),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'user' && lastUser.includes('后台续接核验')) {
        assert.ok(users.some((t) => t.includes('后台分叉子任务')), 'resume 后应保留原后台分叉上下文')
        return fauxAssistantMessage('后台续接成功')
      }
      // steer 后台结算汇报到达父会话触发的新回合
      return fauxAssistantMessage('收到后台分叉汇报')
    }
    faux.setResponses(Array.from({ length: 20 }, () => step))

    await kernel.conversations.submitInput(cid, '记住后台线索 BG_CLUE_99')
    await kernel.conversations.waitForIdle(cid)

    await kernel.conversations.submitInput(cid, '默认后台派发分叉子代理')
    await kernel.conversations.waitForIdle(cid)

    const detailTurn2 = await kernel.conversations.getConversationDetail(cid, { limit: 50 })
    const bgToolRes = findToolResultByCallId(detailTurn2, 'call-bg-fork-1')
    assert.equal(bgToolRes.isError, false)
    const bgPayload = JSON.parse(bgToolRes.text.split('\n')[0]!) as {
      ok?: boolean
      background?: boolean
      runId?: string
      execution?: { conversationId?: number }
    }
    assert.equal(bgPayload.ok, true)
    assert.equal(bgPayload.background, true)
    assert.equal(typeof bgPayload.runId, 'string')
    assert.equal(typeof bgPayload.execution?.conversationId, 'number')
    const runId = bgPayload.runId!
    const bgChildId = bgPayload.execution!.conversationId!

    await waitFor(
      async () => {
        const { runs } = (await kernel.plugins.invokeAction('builtin:workflow', 'runs', { conversationId: cid })) as {
          runs: Array<{ id: string; status: string }>
        }
        const matched = runs.find((r) => r.id === runId)
        return matched !== undefined && matched.status !== 'running'
      },
      { timeoutMs: 20_000, intervalMs: 20, message: '等待超时: 后台 fork run 到达终态' },
    )

    let reportInput: { id?: unknown; origin?: unknown; meta?: { kind?: unknown; backgroundRunId?: unknown } } | undefined
    await waitFor(
      async () => {
        const d = await kernel.conversations.getConversationDetail(cid, { limit: 200 })
        for (const e of d.entries) {
          if (e.kind !== 'helmx.input') continue
          const data = e.data as { id?: unknown; origin?: unknown; meta?: { kind?: unknown; backgroundRunId?: unknown } } | undefined
          if (data?.meta?.backgroundRunId === runId) {
            reportInput = data
            return true
          }
        }
        return false
      },
      { timeoutMs: 20_000, intervalMs: 20, message: '等待超时: 后台 fork steer 汇报到达父会话' },
    )
    assert.equal(reportInput?.id, `helmx:subagent-report:${runId}`)
    assert.equal(reportInput?.origin, 'agent')
    assert.equal(reportInput?.meta?.kind, 'subagent_report')

    await kernel.conversations.waitForIdle(cid)

    bgChildIdForResume = bgChildId
    await kernel.conversations.submitInput(cid, '续接后台分叉')
    await kernel.conversations.waitForIdle(cid)

    const detailResume = await kernel.conversations.getConversationDetail(cid, { limit: 50 })
    const resumeRes = findToolResultByCallId(detailResume, 'call-bg-resume-1')
    assert.equal(resumeRes.isError, false)
    assert.ok(resumeRes.text.includes('后台续接成功'))
  })
})
