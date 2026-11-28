/**
 * `builtin:swarm` 崩溃重放与启动单真源对账组合层集成测试（Integration 档）：
 * 1) replay:'safe' 工具在 tool_result 强杀窗口下的端到端去重重放（dispatch_worker 与 board_post）；
 * 2) 启动单真源收敛：WAL 尾行截断回滚、孤儿/错配标签收敛、孤儿 Swarm Worktree 清理（不越权）；
 * 3) runtime.started 对账：inflightWakeup 未提交死锁恢复、漏收 turn_settled 哑巴续催与异常自动 blocker。
 */
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'

import { createPluginBuildProvider } from '@helmx/plugin-build'
import { KernelRuntime } from '@helmx/kernel'
import { createSwarmPlugin } from '../src/swarm.js'
import { createWorkflowPlugin } from '../src/workflow.js'
import { createWorktreePlugin } from '../src/worktree.js'
import {
  createGitTemplate,
  deferred,
  makeFauxProvider,
  useTempDir,
  waitFor,
} from './helpers/plugin-test-env.js'
import {
  PI_AI_FAUX_URL,
  buildSwarmSeederOpenSnippet,
  isSettledStatus,
  openSwarmEnv,
  openSwarmRuntime,
  setSwarmRoleResponses,
  spawnSigkillSeeder,
} from './helpers/swarm-integration-env.js'
import {
  ARCHIVED_WORKER_TAG,
  COORDINATOR_TAG,
  SWARM_PLUGIN_ID,
  WORKER_TAG,
  type BoardPost,
  type CollabGroupRecord,
} from '../src/swarm.js'

describe('builtin:swarm crash replay & boot reconciliation', { concurrency: 2, timeout: 60_000 }, () => {
  const gitTemplate = createGitTemplate()
  after(() => gitTemplate.cleanup(), { timeout: 60_000 })

  // ---------------------------------------------------------------------------
  // int8: replay:'safe' 工具在 tool_result 强杀窗口下的端到端去重重放（dispatch_worker 与 board_post）
  // ---------------------------------------------------------------------------

  test('swarm-int8: SIGKILL before toolResult commit replays swarm_dispatch_worker and swarm_board_post idempotently with replay=safe', { timeout: 60_000 }, async (t) => {
    const root = useTempDir(t, 'helmx-swarm-replay-both-')
    const dataDir = join(root, 'data')
    const repoDir = join(root, 'repo')
    gitTemplate.cloneTo(repoDir)

    const seedBothScript = `
      import { writeSync } from 'node:fs'
      import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(PI_AI_FAUX_URL)}
      ${buildSwarmSeederOpenSnippet()}

      const faux = fauxProvider({ models: [{ id: 'faux-1' }], tokensPerSecond: 500 })
      const sectionOf = (ctx) => {
        for (const m of ctx.messages) {
          if (m.role === 'system' && m.sections && typeof m.sections['swarm.active_group'] === 'string') {
            return m.sections['swarm.active_group']
          }
        }
        return ''
      }
      let coordADispatched = false
      let coderBPosted = false
      faux.setResponses(Array.from({ length: 16 }, () => (ctx) => {
        const sec = sectionOf(ctx)
        if (sec.includes('role="worker"') && sec.includes('name="coder-a"')) {
          return new Promise(() => {})
        }
        if (sec.includes('role="worker"') && sec.includes('name="coder-b"')) {
          if (!coderBPosted) {
            coderBPosted = true
            return fauxAssistantMessage(
              [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Single idempotent done post.' })],
              { stopReason: 'toolUse' },
            )
          }
          return new Promise(() => {})
        }
        if (sec.includes('role="coordinator"')) {
          if (!coordADispatched) {
            coordADispatched = true
            return fauxAssistantMessage(
              [
                fauxToolCall('swarm_dispatch_worker', {
                  name: 'coder-a',
                  isolation: 'worktree',
                  prompt: 'Complete task once after dispatch replay.',
                }),
              ],
              { stopReason: 'toolUse' },
            )
          }
          return new Promise(() => {})
        }
        return new Promise(() => {})
      }))

      const app = await openSwarmApp({
        dataDir: ${JSON.stringify(dataDir)},
        cwd: ${JSON.stringify(repoDir)},
        model: 'faux/faux-1',
        providers: [faux.provider],
      })

      let trappedDispatchInfo
      let trappedPost = false
      const killIfReady = () => {
        if (trappedDispatchInfo !== undefined && trappedPost) {
          writeSync(1, 'TRAPPED_DISPATCH=' + JSON.stringify(trappedDispatchInfo) + '\\n')
          writeSync(1, 'TRAPPED_POST=1\\n')
          process.kill(process.pid, 'SIGKILL')
        }
      }
      const origExecTool = app.kernel.plugins.executeTool.bind(app.kernel.plugins)
      app.kernel.plugins.executeTool = async (name, input, ctx) => {
        const result = await origExecTool(name, input, ctx)
        if (name === 'swarm_dispatch_worker') {
          trappedDispatchInfo = { callId: ctx?.callId }
          killIfReady()
          await new Promise(() => {})
        }
        if (name === 'swarm_board_post') {
          trappedPost = true
          killIfReady()
          await new Promise(() => {})
        }
        return result
      }

      const coordA = await app.kernel.conversations.createConversation({
        title: 'Replay Dispatch Coord',
        profileId: 'assistant',
        cwd: ${JSON.stringify(repoDir)},
      })
      const { groupId: groupIdA } = await app.kernel.plugins.invokeAction(${JSON.stringify(SWARM_PLUGIN_ID)}, 'create_group', {
        title: 'Replay Dispatch Squad',
        conversationId: coordA.id,
      })
      writeSync(1, 'GROUP_INFO=' + JSON.stringify({ coordId: coordA.id, groupId: groupIdA }) + '\\n')

      const coordB = await app.kernel.conversations.createConversation({
        title: 'Post Replay Coord',
        profileId: 'assistant',
        cwd: ${JSON.stringify(repoDir)},
      })
      const { groupId: groupIdB } = await app.kernel.plugins.invokeAction(${JSON.stringify(SWARM_PLUGIN_ID)}, 'create_group', {
        title: 'Post Replay Squad',
        conversationId: coordB.id,
      })
      const workerB = await app.kernel.plugins.invokeAction(
        ${JSON.stringify(SWARM_PLUGIN_ID)},
        'dispatch_worker',
        { prompt: 'Post done once.', name: 'coder-b' },
        { conversationId: coordB.id },
      )
      writeSync(1, 'POST_INFO=' + JSON.stringify({ coordId: coordB.id, groupId: groupIdB, workerId: workerB.workerConversationId }) + '\\n')

      void app.kernel.conversations.submitInput(coordA.id, 'Dispatch coderA worker.')
      await new Promise(() => {})
    `

    const res = await spawnSigkillSeeder(t, root, 'seed-replay-both-kill.mjs', seedBothScript)
    const groupLineA = res.stdout.split(/\r?\n/).find((l) => l.startsWith('GROUP_INFO='))
    const postLineB = res.stdout.split(/\r?\n/).find((l) => l.startsWith('POST_INFO='))
    assert.ok(
      groupLineA !== undefined &&
        postLineB !== undefined &&
        res.stdout.includes('TRAPPED_DISPATCH=') &&
        res.stdout.includes('TRAPPED_POST=1'),
      `unexpected stdout: ${res.stdout}`,
    )
    const infoA = JSON.parse(groupLineA.slice('GROUP_INFO='.length)) as { coordId: number; groupId: string }
    const infoB = JSON.parse(postLineB.slice('POST_INFO='.length)) as {
      coordId: number
      groupId: string
      workerId: number
    }

    const faux = makeFauxProvider({ models: [{ id: 'faux-1' }] })
    const coordAQueue = [
      fauxAssistantMessage('Coordinator observed idempotent dispatch replay result.'),
      fauxAssistantMessage('Coordinator acknowledged coder done report.'),
    ]
    const coordBQueue = [fauxAssistantMessage('Coordinator acknowledged single done report.')]
    const coderAQueue = [
      fauxAssistantMessage(
        [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Finished after dispatch replay.' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Coder finished cleanly.'),
    ]
    const coderBQueue = [fauxAssistantMessage('Coder completed after board_post replay.')]
    faux.setResponses(
      Array.from({ length: 32 }, () => (ctx) => {
        let sec = ''
        for (const m of ctx.messages as unknown as Array<{ role?: string; sections?: Record<string, string> }>) {
          if (m.role === 'system' && typeof m.sections?.['swarm.active_group'] === 'string') {
            sec = m.sections['swarm.active_group']
          }
        }
        if (sec.includes('role="worker"') && sec.includes('name="coder-a"')) return coderAQueue.shift() ?? fauxAssistantMessage('CoderA idle.')
        if (sec.includes('role="worker"') && sec.includes('name="coder-b"')) return coderBQueue.shift() ?? fauxAssistantMessage('CoderB idle.')
        if (sec.includes(infoA.groupId)) return coordAQueue.shift() ?? fauxAssistantMessage('CoordA idle.')
        if (sec.includes(infoB.groupId)) return coordBQueue.shift() ?? fauxAssistantMessage('CoordB idle.')
        throw new Error(`Unexpected faux request for section: ${sec}`)
      }),
    )

    const app = await openSwarmRuntime({ dataDir, cwd: repoDir, faux })
    try {
      await waitFor(
        () =>
          isSettledStatus(app.kernel.conversations.getConversation(infoA.coordId).status) &&
          app.kernel.conversations.getConversation(infoA.coordId).completionSeq >= 2 &&
          isSettledStatus(app.kernel.conversations.getConversation(infoB.workerId).status) &&
          isSettledStatus(app.kernel.conversations.getConversation(infoB.coordId).status) &&
          app.kernel.conversations.getConversation(infoB.workerId).completionSeq >= 1 &&
          app.kernel.conversations.getConversation(infoB.coordId).completionSeq >= 1 &&
          app.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0,
        { timeoutMs: 8_000 },
      )

      const metaA = JSON.parse(
        readFileSync(join(dataDir, 'plugins', 'builtin%3Aswarm', 'groups', infoA.groupId, 'meta.json'), 'utf8'),
      ) as CollabGroupRecord
      assert.equal(metaA.members.length, 1, 'replaying swarm_dispatch_worker must not duplicate members')
      const coderA = metaA.members[0]!
      await app.kernel.conversations.waitForIdle(coderA.conversationId)
      await waitFor(() => app.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await app.kernel.conversations.waitForIdle(infoA.coordId)

      const wtList = (await app.kernel.plugins.invokeAction('builtin:worktree', 'list_worktrees', {})) as {
        worktrees: Array<{ status: string }>
      }
      assert.equal(
        wtList.worktrees.filter((w) => w.status === 'active').length,
        1,
        'replaying swarm_dispatch_worker must reuse the single acquired worktree',
      )
      const coordDetailA = await app.kernel.conversations.getConversationDetail(infoA.coordId, { limit: 50 })
      const dispatchErrors = coordDetailA.entries.filter(
        (e) =>
          e.kind === 'pi.toolResult' &&
          JSON.stringify(e.data ?? '').includes('swarm_dispatch_worker') &&
          (e.data as { isError?: boolean } | undefined)?.isError === true,
      )
      assert.equal(dispatchErrors.length, 0, 'replay of swarm_dispatch_worker must not raise 409 conflict')
      const workerDetailA = await app.kernel.conversations.getConversationDetail(coderA.conversationId, { limit: 50 })
      assert.equal(workerDetailA.entries.filter((e) => e.kind === 'helmx.input').length, 1)

      const readB = (await app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId: infoB.groupId })) as {
        posts: BoardPost[]
      }
      const donePosts = readB.posts.filter((p) => p.kind === 'done' && p.from === 'coder-b')
      assert.equal(donePosts.length, 1, `replaying swarm_board_post must keep exactly 1 done post, got ${donePosts.length}`)
      const coordDetailB = await app.kernel.conversations.getConversationDetail(infoB.coordId, { limit: 50 })
      const reportsB = coordDetailB.entries.filter(
        (e) => e.kind === 'helmx.input' && JSON.stringify(e.data ?? '').includes('swarm_board_report'),
      )
      assert.equal(reportsB.length, 1)
    } finally {
      await app.close()
    }
  })

  // ---------------------------------------------------------------------------
  // int9 + int10: 启动单真源收敛 + runtime.started 对账（合用单次重启闭环）
  // ---------------------------------------------------------------------------

  test('swarm-int9+10: boot reconciliation rolls back WAL, converges tags/orphan worktree holds, wakes uncommitted inflightWakeup, nudges silent-exit, and posts blocker for errored member', { timeout: 60_000 }, async (t) => {
    const root = useTempDir(t, 'helmx-swarm-boot-reconcile-')
    const env1 = await openSwarmEnv(root, gitTemplate)
    // int9 state
    let groupId = ''
    let group2Id = ''
    let coordId = 0
    let coderId = 0
    let orphanCoordId = 0
    let orphanWorkerId = 0
    let swarmOrphanWtId = ''
    let workflowWtId = ''
    let committedHeadSeq = 0
    // int10 state
    let group10Id = ''
    let coord10Id = 0
    let workerAId = 0
    let workerBId = 0
    let workerCId = 0

    try {
      // --- Seed int9 ---
      const coord = await env1.app.kernel.conversations.createConversation({ title: 'Clean Coord', profileId: 'assistant', cwd: env1.repoDir })
      coordId = coord.id
      const created = (await env1.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'WAL & Orphan Squad',
        conversationId: coord.id,
      })) as { groupId: string }
      groupId = created.groupId

      setSwarmRoleResponses(env1.faux, {
        coder: [
          fauxAssistantMessage(
            [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Initial committed work.' })],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('Coder finished cleanly.'),
        ],
        coordinator: [fauxAssistantMessage('Coordinator noted initial done.')],
      })
      const dispatched = (await env1.app.kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { prompt: 'Post initial done.', name: 'coder' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }
      coderId = dispatched.workerConversationId

      await env1.app.kernel.conversations.waitForIdle(coderId)
      await waitFor(() => env1.app.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await env1.app.kernel.conversations.waitForIdle(coordId)

      await env1.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'archive_worker', {
        groupId,
        name: 'coder',
      })
      await env1.app.kernel.conversations.updateConversation(coderId, { tags: [WORKER_TAG] })

      const orphanCoord = await env1.app.kernel.conversations.createConversation({
        title: 'Forked Orphan Coord',
        profileId: 'assistant',
        cwd: env1.repoDir,
        tags: [COORDINATOR_TAG],
      })
      orphanCoordId = orphanCoord.id

      const orphanWorker = await env1.app.kernel.conversations.createConversation({
        title: 'Orphan Worker',
        profileId: 'assistant',
        cwd: env1.repoDir,
        tags: [WORKER_TAG],
      })
      orphanWorkerId = orphanWorker.id

      const wtSwarmConv = await env1.app.kernel.conversations.createConversation({
        title: 'Swarm Orphan WT Holder',
        profileId: 'assistant',
        cwd: env1.repoDir,
      })
      const swarmWt = (await env1.app.kernel.plugins.invokeAction(
        'builtin:worktree',
        'acquire_worktree',
        {
          conversationId: wtSwarmConv.id,
          parentConversationId: coord.id,
          requestCwd: env1.repoDir,
          hold: { holdId: 'orphan-crash-hold', label: 'Orphaned swarm hold' },
        },
        {},
        { surface: 'plugin', callerPluginId: SWARM_PLUGIN_ID },
      )) as { worktreeId: string }
      swarmOrphanWtId = swarmWt.worktreeId

      const wtWorkflowConv = await env1.app.kernel.conversations.createConversation({
        title: 'Foreign Workflow WT Holder',
        profileId: 'assistant',
        cwd: env1.repoDir,
      })
      const workflowWt = (await env1.app.kernel.plugins.invokeAction(
        'builtin:worktree',
        'acquire_worktree',
        {
          conversationId: wtWorkflowConv.id,
          parentConversationId: coord.id,
          requestCwd: env1.repoDir,
          hold: { holdId: 'foreign-hold', label: 'Foreign workflow hold' },
        },
        {},
        { surface: 'plugin', callerPluginId: 'builtin:workflow' },
      )) as { worktreeId: string }
      workflowWtId = workflowWt.worktreeId
      const created2 = (await env1.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Partial Tail Squad',
        conversationId: (
          await env1.app.kernel.conversations.createConversation({ title: 'Partial Tail Coord', profileId: 'assistant', cwd: env1.repoDir })
        ).id,
      })) as { groupId: string }
      group2Id = created2.groupId

      // --- Seed int10 ---
      const coord10 = await env1.app.kernel.conversations.createConversation({ title: 'Reconcile Coord', profileId: 'assistant', cwd: env1.repoDir })
      coord10Id = coord10.id
      const created10 = (await env1.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Missed Settlement Squad',
        conversationId: coord10.id,
      })) as { groupId: string }
      group10Id = created10.groupId

      workerAId = (
        await env1.app.kernel.conversations.createConversation({
          title: 'Worker A',
          profileId: 'assistant',
          cwd: env1.repoDir,
          tags: [WORKER_TAG],
        })
      ).id
      workerBId = (
        await env1.app.kernel.conversations.createConversation({
          title: 'Worker B',
          profileId: 'assistant',
          cwd: env1.repoDir,
          tags: [WORKER_TAG],
        })
      ).id
      workerCId = (
        await env1.app.kernel.conversations.createConversation({
          title: 'Worker C',
          profileId: 'assistant',
          cwd: env1.repoDir,
          tags: [WORKER_TAG],
        })
      ).id

      env1.faux.setResponses([
        fauxAssistantMessage('Silent exit response without calling swarm_board_post.'),
        fauxAssistantMessage('Partial failure output.', { stopReason: 'error', errorMessage: 'simulated model crash' }),
      ])
      await env1.app.kernel.conversations.submitInput(workerBId, '[swarm_worker_brief] Finish task B.', {
        origin: 'agent',
        requestId: `swarm-wakeup:${group10Id}:workerB:1-2`,
      })
      await env1.app.kernel.conversations.waitForIdle(workerBId)

      await env1.app.kernel.conversations.submitInput(workerCId, '[swarm_worker_brief] Finish task C.', {
        origin: 'agent',
        requestId: `swarm-wakeup:${group10Id}:workerC:1-3`,
      })
      await waitFor(() => env1.app.kernel.conversations.getConversation(workerCId).status !== 'working')
    } finally {
      await env1.close()
    }

    // Mutate int9 WAL files
    const groupDir2 = join(env1.dataDir, 'plugins', 'builtin%3Aswarm', 'groups', group2Id)
    const boardPath2 = join(groupDir2, 'board.jsonl')
    writeFileSync(boardPath2, `{"seq":1,"groupId":"${group2Id}"`, 'utf8')
    const groupDir = join(env1.dataDir, 'plugins', 'builtin%3Aswarm', 'groups', groupId)
    const metaBeforeRestart = JSON.parse(readFileSync(join(groupDir, 'meta.json'), 'utf8')) as CollabGroupRecord
    committedHeadSeq = metaBeforeRestart.headSeq
    const boardPath = join(groupDir, 'board.jsonl')
    const existingBoard = readFileSync(boardPath, 'utf8')
    const dirtyPost: BoardPost = {
      groupId,
      seq: committedHeadSeq + 1,
      from: 'coordinator',
      to: ['all'],
      resolvedTargets: [],
      wake: false,
      kind: 'comment',
      refs: [],
      body: 'Uncommitted crash post that must be rolled back',
      createdAt: Date.now(),
    }
    writeFileSync(boardPath, `${existingBoard}${JSON.stringify(dirtyPost)}\n`, 'utf8')

    // Mutate int10 post-crash board.jsonl + meta.json
    const groupDir10 = join(env1.dataDir, 'plugins', 'builtin%3Aswarm', 'groups', group10Id)
    const metaPath10 = join(groupDir10, 'meta.json')
    const boardPath10 = join(groupDir10, 'board.jsonl')
    const now = Date.now()
    const posts10: BoardPost[] = [
      {
        groupId: group10Id,
        seq: 1,
        from: 'coordinator',
        to: ['workerA'],
        resolvedTargets: ['workerA'],
        wake: true,
        kind: 'brief',
        refs: [],
        body: 'Task A brief pending uncommitted inflightWakeup.',
        createdAt: now - 30,
      },
      {
        groupId: group10Id,
        seq: 2,
        from: 'coordinator',
        to: ['workerB'],
        resolvedTargets: ['workerB'],
        wake: true,
        kind: 'brief',
        refs: [],
        body: 'Task B brief ended silently before onMemberTurnSettled.',
        createdAt: now - 20,
      },
      {
        groupId: group10Id,
        seq: 3,
        from: 'coordinator',
        to: ['workerC'],
        resolvedTargets: ['workerC'],
        wake: true,
        kind: 'brief',
        refs: [],
        body: 'Task C brief crashed with model error before onMemberTurnSettled.',
        createdAt: now - 10,
      },
    ]
    writeFileSync(boardPath10, `${posts10.map((p) => JSON.stringify(p)).join('\n')}\n`, 'utf8')

    const meta10 = JSON.parse(readFileSync(metaPath10, 'utf8')) as CollabGroupRecord
    meta10.headSeq = 3
    meta10.members = [
      {
        name: 'workerA',
        conversationId: workerAId,
        profileId: 'assistant',
        access: 'readwrite',
        isolation: 'inherit',
        nodeId: 'local',
        cwd: env1.repoDir,
        lifecycle: 'active',
        readCursorSeq: 0,
        pendingWakeupSeq: 1,
        lastWakeTaskSeq: 1,
        inflightWakeup: {
          requestId: `swarm-wakeup:${group10Id}:workerA:1-1`,
          fromSeq: 1,
          toSeq: 1,
          baseCompletionSeq: 0,
        },
        createdAt: now - 30,
      },
      {
        name: 'workerB',
        conversationId: workerBId,
        profileId: 'assistant',
        access: 'readwrite',
        isolation: 'inherit',
        nodeId: 'local',
        cwd: env1.repoDir,
        lifecycle: 'active',
        readCursorSeq: 2,
        pendingWakeupSeq: 2,
        lastWakeTaskSeq: 2,
        lastWakeCompletionSeq: 0,
        createdAt: now - 20,
      },
      {
        name: 'workerC',
        conversationId: workerCId,
        profileId: 'assistant',
        access: 'readwrite',
        isolation: 'inherit',
        nodeId: 'local',
        cwd: env1.repoDir,
        lifecycle: 'active',
        readCursorSeq: 3,
        pendingWakeupSeq: 3,
        lastWakeTaskSeq: 3,
        lastWakeCompletionSeq: 0,
        createdAt: now - 10,
      },
    ]
    writeFileSync(metaPath10, `${JSON.stringify(meta10, null, 2)}\n`, 'utf8')

    const faux2 = makeFauxProvider({ models: [{ id: 'faux-1' }] })
    setSwarmRoleResponses(faux2, {
      workerA: [
        fauxAssistantMessage(
          [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Worker A completed after inflightWakeup recovery.' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Worker A done.'),
      ],
      workerB: [
        fauxAssistantMessage(
          [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Worker B completed after recovery nudge.' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Worker B done.'),
      ],
      coordinator: [
        fauxAssistantMessage('Coordinator acknowledged recovery update 1.'),
        fauxAssistantMessage('Coordinator acknowledged recovery update 2.'),
        fauxAssistantMessage('Coordinator acknowledged recovery update 3.'),
      ],
    })

    const app2 = await openSwarmRuntime({
      dataDir: env1.dataDir,
      cwd: env1.repoDir,
      faux: faux2,
    })
    try {
      await waitFor(
        () =>
          isSettledStatus(app2.kernel.conversations.getConversation(workerAId).status) &&
          app2.kernel.conversations.getConversation(workerAId).completionSeq >= 1 &&
          isSettledStatus(app2.kernel.conversations.getConversation(workerBId).status) &&
          app2.kernel.conversations.getConversation(workerBId).completionSeq >= 2 &&
          isSettledStatus(app2.kernel.conversations.getConversation(coord10Id).status) &&
          app2.kernel.conversations.getConversation(coord10Id).completionSeq >= 1 &&
          app2.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0,
        { timeoutMs: 8_000 },
      )
      await app2.kernel.conversations.waitForIdle(workerAId)
      await app2.kernel.conversations.waitForIdle(workerBId)
      await app2.kernel.conversations.waitForIdle(coord10Id)

      // int9 assertions
      const read = (await app2.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as { posts: BoardPost[] }
      assert.equal(read.posts.every((p) => p.seq <= committedHeadSeq), true)
      assert.equal(read.posts.some((p) => p.body.includes('Uncommitted crash post')), false)
      const repairedLines = readFileSync(boardPath, 'utf8').trim().split('\n').filter(Boolean)
      assert.equal(repairedLines.length, committedHeadSeq)

      const read2 = (await app2.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId: group2Id })) as { posts: BoardPost[] }
      assert.equal(read2.posts.length, 0)
      assert.equal(readFileSync(boardPath2, 'utf8'), '')

      assert.equal(app2.kernel.conversations.getConversation(coordId).tags.includes(COORDINATOR_TAG), true)
      assert.equal(app2.kernel.conversations.getConversation(orphanCoordId).tags.includes(COORDINATOR_TAG), false)
      assert.equal(app2.kernel.conversations.getConversation(coderId).tags.includes(WORKER_TAG), false)
      assert.equal(app2.kernel.conversations.getConversation(coderId).tags.includes(ARCHIVED_WORKER_TAG), true)
      assert.equal(app2.kernel.conversations.getConversation(orphanWorkerId).tags.includes(WORKER_TAG), false)

      const swarmWtInspect = (await app2.kernel.plugins.invokeAction('builtin:worktree', 'inspect_worktree', {
        worktreeId: swarmOrphanWtId,
      })) as { exists: boolean }
      assert.equal(swarmWtInspect.exists, false)
      const workflowWtInspect = (await app2.kernel.plugins.invokeAction('builtin:worktree', 'inspect_worktree', {
        worktreeId: workflowWtId,
      })) as { exists: boolean }
      assert.equal(workflowWtInspect.exists, true)

      // int10 assertions
      const read10 = (await app2.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId: group10Id })) as {
        posts: BoardPost[]
      }
      assert.equal(read10.posts.filter((p) => p.kind === 'done' && p.from === 'workerA').length, 1)
      assert.equal(read10.posts.filter((p) => p.kind === 'done' && p.from === 'workerB').length, 1)
      const blockerC = read10.posts.find((p) => p.kind === 'blocker' && p.from === 'system' && p.to.includes('coordinator'))
      assert.ok(blockerC !== undefined, `expected auto system blocker for errored workerC, got ${JSON.stringify(read10.posts)}`)
      assert.match(blockerC.body, /workerC/)

      const detailB = await app2.kernel.conversations.getConversationDetail(workerBId, { limit: 50 })
      const nudgesB = detailB.entries.filter(
        (e) => e.kind === 'helmx.input' && JSON.stringify(e.data ?? '').includes('swarm_silent_exit_nudge'),
      )
      assert.equal(nudgesB.length, 1, `expected 1 silent-exit nudge for workerB, got ${nudgesB.length}`)

      const detailC = await app2.kernel.conversations.getConversationDetail(workerCId, { limit: 50 })
      assert.equal(
        detailC.entries.some((e) => JSON.stringify(e.data ?? '').includes('swarm_silent_exit_nudge')),
        false,
        'errored workerC must receive auto blocker rather than silent-exit nudge',
      )

      const coordDetail = await app2.kernel.conversations.getConversationDetail(coord10Id, { limit: 50 })
      const coordReportText = JSON.stringify(
        coordDetail.entries.filter((e) => e.kind === 'helmx.input' && JSON.stringify(e.data ?? '').includes('swarm_board_report')),
      )
      assert.match(coordReportText, /@workerA/)
      assert.match(coordReportText, /@workerB/)
      assert.match(coordReportText, /@workerC/)
    } finally {
      await app2.close()
    }
  })

  // ---------------------------------------------------------------------------
  // int11: pi_submissions status='unanswered' 恢复 — 不误标 notified/read、:r1 绕开去重真正重投、耗尽可见失败且零死循环
  // ---------------------------------------------------------------------------

  test('swarm-int11: unanswered pi_submissions do not mark seq notified/read, retry with distinct :r1 requestId, and stop with visible blocker/notification on exhaustion without hot-looping', { timeout: 60_000 }, async (t) => {
    const root = useTempDir(t, 'helmx-swarm-unanswered-int-')
    const env1 = await openSwarmEnv(root, gitTemplate)
    let groupId = ''
    let coordId = 0
    let workerAId = 0
    let workerBId = 0
    let soloRetryGroupId = ''
    let soloRetryCoordId = 0
    let soloExhaustGroupId = ''
    let soloExhaustCoordId = 0
    let coordCompletionBefore = 0
    let workerACompletionBefore = 0
    let workerBCompletionBefore = 0
    let soloRetryCompletionBefore = 0
    let soloExhaustCompletionBefore = 0

    const seedUnansweredSubmission = async (
      convId: number,
      requestId: string,
      promptText: string,
    ): Promise<void> => {
      const started = deferred<void>()
      env1.faux.setResponses([
        (_ctx: unknown, _opts: unknown, signal?: AbortSignal) => {
          started.resolve()
          return new Promise<never>((_resolve, reject) => {
            const onAbort = () => reject(new Error('aborted'))
            if (signal?.aborted) { onAbort(); return }
            signal?.addEventListener('abort', onAbort, { once: true })
          })
        },
      ] as never)
      await env1.app.kernel.conversations.submitInput(convId, promptText, { origin: 'agent', requestId })
      await started.promise
      await env1.app.kernel.conversations.abortConversation(convId)
      await env1.app.kernel.conversations.waitForIdle(convId)
      const sub = await env1.app.kernel.conversations.getConversationSubmission(convId, requestId)
      assert.equal(sub?.status, 'unanswered', `expected real SQLite pi_submissions status='unanswered' for ${requestId}`)
    }

    try {
      const coord = await env1.app.kernel.conversations.createConversation({ title: 'Unanswered Coord', profileId: 'assistant', cwd: env1.repoDir })
      coordId = coord.id
      const created = (await env1.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Unanswered Recovery Squad',
        conversationId: coord.id,
      })) as { groupId: string }
      groupId = created.groupId

      const convA = await env1.app.kernel.conversations.createConversation({
        title: 'Worker A',
        profileId: 'assistant',
        cwd: env1.repoDir,
        tags: [WORKER_TAG],
      })
      workerAId = convA.id
      const convB = await env1.app.kernel.conversations.createConversation({
        title: 'Worker B',
        profileId: 'assistant',
        cwd: env1.repoDir,
        tags: [WORKER_TAG],
      })
      workerBId = convB.id

      const soloRetryCoord = await env1.app.kernel.conversations.createConversation({ title: 'Solo Retry Coord', profileId: 'assistant', cwd: env1.repoDir })
      soloRetryCoordId = soloRetryCoord.id
      soloRetryGroupId = (
        (await env1.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
          title: 'Solo Report Retry',
          conversationId: soloRetryCoord.id,
        })) as { groupId: string }
      ).groupId

      const soloExhaustCoord = await env1.app.kernel.conversations.createConversation({ title: 'Solo Exhaust Coord', profileId: 'assistant', cwd: env1.repoDir })
      soloExhaustCoordId = soloExhaustCoord.id
      soloExhaustGroupId = (
        (await env1.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
          title: 'Solo Report Exhaust',
          conversationId: soloExhaustCoord.id,
        })) as { groupId: string }
      ).groupId

      // Seed real status='unanswered' rows in pi_submissions before simulating crash state in meta.json:
      // 1) coordinator report attempt 0 (swarm-report:<gid>:1-1)
      // 2) workerA wakeup attempt 0 (swarm-wakeup:<gid>:workerA:2-2)
      // 3) workerB wakeup attempt 1 (swarm-wakeup:<gid>:workerB:3-3:r1) -> already exhausted!
      // 4) soloRetryCoord report attempt 0 (same seq 1-1, no newer posts -> must emit exact :r1!)
      // 5) soloExhaustCoord report attempt 1 (swarm-report:<gid>:1-1:r1) -> exhausted, visible error notification, no loop!
      await seedUnansweredSubmission(coordId, `swarm-report:${groupId}:1-1`, 'Aborted coordinator report #1')
      await seedUnansweredSubmission(workerAId, `swarm-wakeup:${groupId}:workerA:2-2`, 'Aborted workerA wakeup #2')
      await seedUnansweredSubmission(workerBId, `swarm-wakeup:${groupId}:workerB:3-3:r1`, 'Aborted workerB retry wakeup #3')
      await seedUnansweredSubmission(soloRetryCoordId, `swarm-report:${soloRetryGroupId}:1-1`, 'Aborted solo report #1')
      await seedUnansweredSubmission(soloExhaustCoordId, `swarm-report:${soloExhaustGroupId}:1-1:r1`, 'Aborted solo retry report #1')
      coordCompletionBefore = env1.app.kernel.conversations.getConversation(coordId).completionSeq
      workerACompletionBefore = env1.app.kernel.conversations.getConversation(workerAId).completionSeq
      workerBCompletionBefore = env1.app.kernel.conversations.getConversation(workerBId).completionSeq
      soloRetryCompletionBefore = env1.app.kernel.conversations.getConversation(soloRetryCoordId).completionSeq
      soloExhaustCompletionBefore = env1.app.kernel.conversations.getConversation(soloExhaustCoordId).completionSeq
    } finally {
      await env1.close()
    }

    const groupDir = join(env1.dataDir, 'plugins', 'builtin%3Aswarm', 'groups', groupId)
    const metaPath = join(groupDir, 'meta.json')
    const boardPath = join(groupDir, 'board.jsonl')
    const now = Date.now()
    const posts: BoardPost[] = [
      {
        groupId,
        seq: 1,
        from: 'workerA',
        to: ['coordinator'],
        resolvedTargets: ['coordinator'],
        wake: true,
        kind: 'review',
        refs: [],
        body: 'Critical review finding #1 that must survive unanswered report recovery.',
        createdAt: now - 30,
      },
      {
        groupId,
        seq: 2,
        from: 'coordinator',
        to: ['workerA'],
        resolvedTargets: ['workerA'],
        wake: true,
        kind: 'brief',
        refs: [],
        body: 'Task #2 for workerA after unanswered wakeup.',
        createdAt: now - 20,
      },
      {
        groupId,
        seq: 3,
        from: 'coordinator',
        to: ['workerB'],
        resolvedTargets: ['workerB'],
        wake: true,
        kind: 'brief',
        refs: [],
        body: 'Task #3 for workerB whose retry already went unanswered.',
        createdAt: now - 10,
      },
    ]
    writeFileSync(boardPath, `${posts.map((p) => JSON.stringify(p)).join('\n')}\n`, 'utf8')

    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as CollabGroupRecord
    meta.headSeq = 3
    meta.coordinatorNotifiedSeq = 0
    meta.coordinatorPendingSeq = 1
    meta.inflightReport = {
      requestId: `swarm-report:${groupId}:1-1`,
      fromSeq: 1,
      toSeq: 1,
      baseCompletionSeq: 0,
      hadActiveWorkers: false,
    }
    meta.members = [
      {
        name: 'workerA',
        conversationId: workerAId,
        profileId: 'assistant',
        access: 'readwrite',
        isolation: 'inherit',
        nodeId: 'local',
        cwd: env1.repoDir,
        lifecycle: 'active',
        readCursorSeq: 1,
        pendingWakeupSeq: 2,
        lastWakeTaskSeq: 2,
        inflightWakeup: {
          requestId: `swarm-wakeup:${groupId}:workerA:2-2`,
          fromSeq: 2,
          toSeq: 2,
          baseCompletionSeq: 0,
        },
        createdAt: now - 20,
      },
      {
        name: 'workerB',
        conversationId: workerBId,
        profileId: 'assistant',
        access: 'readwrite',
        isolation: 'inherit',
        nodeId: 'local',
        cwd: env1.repoDir,
        lifecycle: 'active',
        readCursorSeq: 0,
        pendingWakeupSeq: 3,
        lastWakeTaskSeq: 3,
        inflightWakeup: {
          requestId: `swarm-wakeup:${groupId}:workerB:3-3:r1`,
          fromSeq: 3,
          toSeq: 3,
          baseCompletionSeq: 0,
          attempt: 1,
        },
        createdAt: now - 10,
      },
    ]
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

    const writeSoloReportFixture = (gid: string, reqId: string, attempt?: number) => {
      const dir = join(env1.dataDir, 'plugins', 'builtin%3Aswarm', 'groups', gid)
      const mPath = join(dir, 'meta.json')
      const bPath = join(dir, 'board.jsonl')
      const soloPost: BoardPost = {
        groupId: gid,
        seq: 1,
        from: 'solo',
        to: ['coordinator'],
        resolvedTargets: ['coordinator'],
        wake: true,
        kind: 'done',
        refs: [],
        body: `Solo report payload for ${gid}.`,
        createdAt: now - 5,
      }
      writeFileSync(bPath, `${JSON.stringify(soloPost)}\n`, 'utf8')
      const m = JSON.parse(readFileSync(mPath, 'utf8')) as CollabGroupRecord
      m.headSeq = 1
      m.coordinatorNotifiedSeq = 0
      m.coordinatorPendingSeq = 1
      m.inflightReport = {
        requestId: reqId,
        fromSeq: 1,
        toSeq: 1,
        baseCompletionSeq: 0,
        hadActiveWorkers: false,
        ...(attempt !== undefined ? { attempt } : {}),
      }
      writeFileSync(mPath, `${JSON.stringify(m, null, 2)}\n`, 'utf8')
      return mPath
    }
    const soloRetryMetaPath = writeSoloReportFixture(soloRetryGroupId, `swarm-report:${soloRetryGroupId}:1-1`)
    const soloExhaustMetaPath = writeSoloReportFixture(soloExhaustGroupId, `swarm-report:${soloExhaustGroupId}:1-1:r1`, 1)

    // Restart 1: workerA receives :r1 wakeup; soloRetryCoord receives exact :r1 report bypassing SQLite dedup;
    // soloExhaustCoord keeps coordinatorNotifiedSeq=0 + exhausted=true + emits error notification;
    // workerB keeps readCursorSeq=0 + exhausted=true + visible system [blocker].
    const faux2 = makeFauxProvider({ models: [{ id: 'faux-1' }] })
    setSwarmRoleResponses(faux2, {
      workerA: [
        fauxAssistantMessage(
          [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Worker A delivered after :r1 recovery.' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Worker A done.'),
      ],
      coordinator: [
        fauxAssistantMessage('Coordinator processed recovered report 1.'),
        fauxAssistantMessage('Coordinator processed recovered report 2.'),
        fauxAssistantMessage('Coordinator processed recovered report 3.'),
      ],
    })

    const app2 = await openSwarmRuntime({
      dataDir: env1.dataDir,
      cwd: env1.repoDir,
      faux: faux2,
      autoStart: false,
    })
    const errorNotifications: Array<{ title?: string; body?: string; level?: string }> = []
    let unsubNotif: (() => void) | undefined
    let blockerCountAfterBoot1 = 0
    try {
      unsubNotif = app2.kernel.events.subscribe((frame) => {
        if (frame.event.type === 'notification') {
          const payload = frame.event as { title?: string; body?: string; level?: string }
          if (payload.level === 'error') errorNotifications.push(payload)
        }
      })
      await app2.kernel.start()
      await waitFor(
        () =>
          isSettledStatus(app2.kernel.conversations.getConversation(workerAId).status) &&
          app2.kernel.conversations.getConversation(workerAId).completionSeq > workerACompletionBefore &&
          isSettledStatus(app2.kernel.conversations.getConversation(coordId).status) &&
          app2.kernel.conversations.getConversation(coordId).completionSeq > coordCompletionBefore &&
          isSettledStatus(app2.kernel.conversations.getConversation(soloRetryCoordId).status) &&
          app2.kernel.conversations.getConversation(soloRetryCoordId).completionSeq > soloRetryCompletionBefore &&
          app2.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0,
        { timeoutMs: 10_000 },
      )
      await app2.kernel.conversations.waitForIdle(workerAId)
      await app2.kernel.conversations.waitForIdle(coordId)
      await app2.kernel.conversations.waitForIdle(soloRetryCoordId)

      const workerADetail = await app2.kernel.conversations.getConversationDetail(workerAId, { limit: 30 })
      const retryWakeEntry = workerADetail.entries.find(
        (e) => e.kind === 'helmx.input' && (e.data as { id?: string } | undefined)?.id === `swarm-wakeup:${groupId}:workerA:2-2:r1`,
      )
      assert.ok(retryWakeEntry !== undefined, 'workerA must receive distinct :r1 wakeup bypassing unanswered requestId dedup')

      const soloRetryDetail = await app2.kernel.conversations.getConversationDetail(soloRetryCoordId, { limit: 30 })
      const soloRetryEntry = soloRetryDetail.entries.find(
        (e) => e.kind === 'helmx.input' && (e.data as { id?: string } | undefined)?.id === `swarm-report:${soloRetryGroupId}:1-1:r1`,
      )
      assert.ok(soloRetryEntry !== undefined, 'soloRetryCoord must receive exact :r1 report bypassing SQLite unanswered dedup')
      const soloRetryMetaAfter = JSON.parse(readFileSync(soloRetryMetaPath, 'utf8')) as CollabGroupRecord
      assert.equal(soloRetryMetaAfter.coordinatorNotifiedSeq, 1)
      assert.equal(soloRetryMetaAfter.reportRecovery, undefined)

      const soloExhaustMetaAfter = JSON.parse(readFileSync(soloExhaustMetaPath, 'utf8')) as CollabGroupRecord
      assert.equal(soloExhaustMetaAfter.coordinatorNotifiedSeq, 0, 'exhausted unanswered coordinator report must NOT mark seq notified')
      assert.equal(soloExhaustMetaAfter.reportRecovery?.exhausted, true)
      assert.equal(app2.kernel.conversations.getConversation(soloExhaustCoordId).completionSeq, soloExhaustCompletionBefore)
      assert.ok(
        errorNotifications.some((n) => (n.title ?? '').includes(soloExhaustGroupId) || (n.body ?? '').includes('unanswered')),
        `exhausted coordinator report must emit visible error notification, got ${JSON.stringify(errorNotifications)}`,
      )

      const coordDetail = await app2.kernel.conversations.getConversationDetail(coordId, { limit: 30 })
      const coordReportEntries = coordDetail.entries.filter(
        (e) => e.kind === 'helmx.input' && JSON.stringify(e.data ?? '').includes('swarm_board_report'),
      )
      assert.ok(coordReportEntries.length >= 1, 'coordinator must receive recovered board report')
      assert.match(JSON.stringify(coordReportEntries), /Critical review finding #1 that must survive unanswered report recovery\./)

      const read = (await app2.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as { posts: BoardPost[] }
      assert.equal(read.posts.filter((p) => p.kind === 'done' && p.from === 'workerA').length, 1)
      const blockersB = read.posts.filter((p) => p.kind === 'blocker' && p.from === 'system' && p.body.includes('@workerB'))
      assert.equal(blockersB.length, 1, 'exhausted unanswered workerB wakeup must escalate exactly 1 visible system blocker')
      blockerCountAfterBoot1 = blockersB.length

      const metaAfterBoot1 = JSON.parse(readFileSync(metaPath, 'utf8')) as CollabGroupRecord
      const memberB = metaAfterBoot1.members.find((m) => m.name === 'workerB')!
      assert.equal(memberB.readCursorSeq, 0, 'exhausted unanswered workerB must NOT falsely mark readCursorSeq as read')
      assert.equal(memberB.wakeupRecovery?.exhausted, true)
      assert.equal(app2.kernel.conversations.getConversation(workerBId).completionSeq, workerBCompletionBefore, 'exhausted workerB must not be woken again')
      const workerBDetail = await app2.kernel.conversations.getConversationDetail(workerBId, { limit: 30 })
      assert.equal(
        workerBDetail.entries.filter((e) => e.kind === 'helmx.input').length,
        1,
        'exhausted workerB must have only the pre-restart aborted input and zero redelivered wakeups',
      )
    } finally {
      unsubNotif?.()
      await app2.close()
    }

    // Restart 2: verify zero infinite loop (no new wakeup to workerB, no new report to soloExhaustCoord, no duplicate blocker)
    const faux3 = makeFauxProvider({ models: [{ id: 'faux-1' }] })
    faux3.setResponses([])
    const app3 = await openSwarmRuntime({
      dataDir: env1.dataDir,
      cwd: env1.repoDir,
      faux: faux3,
    })
    try {
      await waitFor(() => app3.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      const read2 = (await app3.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as { posts: BoardPost[] }
      assert.equal(
        read2.posts.filter((p) => p.kind === 'blocker' && p.from === 'system' && p.body.includes('@workerB')).length,
        blockerCountAfterBoot1,
        'second restart must not emit duplicate blockers or hot-loop',
      )
      assert.equal(app3.kernel.conversations.getConversation(workerBId).completionSeq, workerBCompletionBefore)
      assert.equal(app3.kernel.conversations.getConversation(soloExhaustCoordId).completionSeq, soloExhaustCompletionBefore)
    } finally {
      await app3.close()
    }
  })

  // ---------------------------------------------------------------------------
  // int12: 启动恢复拓扑顺序 — 即使 builtin:swarm 先于 workflow/worktree 注册，reconcileAfter 仍保证严格顺序且 start 期不提前触发 worktree/submitInput
  // ---------------------------------------------------------------------------

  test('swarm-int12: swarm-core reconcileAfter orders reconciliation strictly after workflow and worktree regardless of plugin registration order', { timeout: 60_000 }, async (t) => {
    const root = useTempDir(t, 'helmx-swarm-reconcile-order-')
    const env1 = await openSwarmEnv(root, gitTemplate)
    let orphanWtId = ''
    try {
      const coord = await env1.app.kernel.conversations.createConversation({ title: 'Order Coord', profileId: 'assistant', cwd: env1.repoDir })
      const orphanConv = await env1.app.kernel.conversations.createConversation({ title: 'Orphan WT Conv', profileId: 'assistant', cwd: env1.repoDir })
      const acquired = (await env1.app.kernel.plugins.invokeAction(
        'builtin:worktree',
        'acquire_worktree',
        {
          conversationId: orphanConv.id,
          parentConversationId: coord.id,
          requestCwd: env1.repoDir,
          hold: { holdId: 'grp_rev_order:orphan', label: 'Orphan hold for registration-order test' },
        },
        {},
        { surface: 'plugin', callerPluginId: SWARM_PLUGIN_ID },
      )) as { worktreeId: string }
      orphanWtId = acquired.worktreeId
    } finally {
      await env1.close()
    }

    // Reopen KernelRuntime with REVERSED plugin registration order: swarm BEFORE workflow and worktree!
    const faux2 = makeFauxProvider({ models: [{ id: 'faux-1' }] })
    faux2.setResponses([])
    const kernel = await KernelRuntime.open({
      buildProvider: createPluginBuildProvider(),
      dataDir: env1.dataDir,
      cwd: env1.repoDir,
      model: 'faux/faux-1',
      providers: [faux2.provider],
      autoResume: false,
    })
    try {
      const reconcileOrder: string[] = []
      const wrapReconcile = (pluginDef: ReturnType<typeof createSwarmPlugin>) => ({
        ...pluginDef,
        definePlugin(ctx: Parameters<typeof pluginDef.definePlugin>[0]) {
          const origService = ctx.service.bind(ctx)
          const wrappedCtx = {
            ...ctx,
            service(spec: Parameters<typeof ctx.service>[0]) {
              const origReconcile = spec.reconcile
              return origService({
                ...spec,
                ...(origReconcile
                  ? {
                      async reconcile() {
                        reconcileOrder.push(`${pluginDef.id}:begin`)
                        await origReconcile()
                        reconcileOrder.push(`${pluginDef.id}:end`)
                      },
                    }
                  : {}),
              })
            },
          }
          return pluginDef.definePlugin(wrappedCtx)
        },
      })

      // Deliberately register swarm BEFORE workflow and worktree!
      await kernel.plugins.register(wrapReconcile(createSwarmPlugin()))
      await kernel.plugins.register(wrapReconcile(createWorkflowPlugin()))
      await kernel.plugins.register(wrapReconcile(createWorktreePlugin()))

      await kernel.start()
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)

      assert.deepEqual(
        reconcileOrder,
        [
          'builtin:workflow:begin',
          'builtin:workflow:end',
          'builtin:worktree:begin',
          'builtin:worktree:end',
          'builtin:swarm:begin',
          'builtin:swarm:end',
        ],
        `reconcile must run workflow -> worktree -> swarm even when swarm is registered first, got ${JSON.stringify(reconcileOrder)}`,
      )

      const inspect = (await kernel.plugins.invokeAction('builtin:worktree', 'inspect_worktree', {
        worktreeId: orphanWtId,
      })) as { exists: boolean }
      assert.equal(inspect.exists, false, 'orphan swarm worktree hold must be reclaimed during swarm.reconcile() after worktree.reconcile()')
    } finally {
      await kernel.close()
    }
  })
})
