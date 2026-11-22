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
import { createHelmx } from '../../hub/src/app.js'
import {
  createGitTemplate,
  makeFauxProvider,
  useTempDir,
  waitFor,
} from './helpers/plugin-test-env.js'
import {
  HUB_APP_URL,
  PI_AI_FAUX_URL,
  PLUGIN_BUILD_URL,
  isSettledStatus,
  openSwarmEnv,
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

describe('builtin:swarm crash replay & boot reconciliation', () => {
  const gitTemplate = createGitTemplate()
  after(() => gitTemplate.cleanup())

  // ---------------------------------------------------------------------------
  // int8: replay:'safe' 工具在 tool_result 强杀窗口下的端到端去重重放（dispatch_worker 与 board_post）
  // ---------------------------------------------------------------------------

  test('swarm-int8: SIGKILL before toolResult commit replays swarm_dispatch_worker and swarm_board_post idempotently with replay=safe', { timeout: 60_000 }, async (t) => {
    const rootA = useTempDir(t, 'helmx-swarm-replay-dispatch-')
    const rootB = useTempDir(t, 'helmx-swarm-replay-post-')

    // Phase A (dispatch_worker) and Phase B (board_post) use fully independent temp dirs, repos, and apps;
    // running both phases concurrently cuts real SIGKILL seeder wall time in half with identical assertions.
    const runPhaseA = async (): Promise<void> => {
      const dataDirA = join(rootA, 'data')
      const repoDirA = join(rootA, 'repo')
      gitTemplate.cloneTo(repoDirA)

      const seedDispatchScript = `
        import { writeSync } from 'node:fs'
        import { createPluginBuildProvider } from ${JSON.stringify(PLUGIN_BUILD_URL)}
        import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(PI_AI_FAUX_URL)}
        import { createHelmx } from ${JSON.stringify(HUB_APP_URL)}

        const faux = fauxProvider({ models: [{ id: 'faux-1' }], tokensPerSecond: 500 })
        let coordId = 0
        faux.setResponses([
          (ctx) => {
            // Hold worker turn if scheduled before coordinator tool_result trap fires.
            const isWorker = ctx.messages.some(
              (m) => m['role'] === 'system' && JSON.stringify(m['sections'] ?? '').includes('role="worker"'),
            )
            if (isWorker) {
              return new Promise(() => {})
            }
            return fauxAssistantMessage(
              [
                fauxToolCall('swarm_dispatch_worker', {
                  name: 'coder',
                  isolation: 'worktree',
                  prompt: 'Complete task once after dispatch replay.',
                }),
              ],
              { stopReason: 'toolUse' },
            )
          },
          () => new Promise(() => {}),
        ])

        const app = await createHelmx({
          buildProvider: createPluginBuildProvider(),
          dataDir: ${JSON.stringify(dataDirA)},
          cwd: ${JSON.stringify(repoDirA)},
          model: 'faux/faux-1',
          providers: [faux.provider],
        })
        await app.kernel.plugins.register({
          id: 'test:sigkill-dispatch-trap',
          name: 'sigkill dispatch trap',
          definePlugin(ctx) {
            ctx.hook.onToolResult((ev) => {
              if (ev.toolName === 'swarm_dispatch_worker') {
                writeSync(1, 'TRAPPED_DISPATCH=' + JSON.stringify({ callId: ev.callId }) + '\\n')
                process.kill(process.pid, 'SIGKILL')
              }
              return { action: 'continue' }
            })
          },
        })
        const coord = await app.kernel.createConversation({
          title: 'Replay Dispatch Coord',
          profileId: 'assistant',
          cwd: ${JSON.stringify(repoDirA)},
        })
        coordId = coord.id
        const { groupId } = (await app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID_LITERAL, 'create_group', {
          title: 'Replay Dispatch Squad',
          conversationId: coord.id,
        })) as { groupId: string }
        writeSync(1, 'GROUP_INFO=' + JSON.stringify({ coordId: coord.id, groupId }) + '\\n')
        await app.kernel.submitInput(coord.id, 'Dispatch coder worker.')
        await new Promise(() => {})
      `.replace('SWARM_PLUGIN_ID_LITERAL', JSON.stringify(SWARM_PLUGIN_ID))

      const resA = await spawnSigkillSeeder(t, rootA, 'seed-dispatch-kill.mts', seedDispatchScript)
      const groupLineA = resA.stdout.split(/\r?\n/).find((l) => l.startsWith('GROUP_INFO='))
      assert.ok(groupLineA !== undefined && resA.stdout.includes('TRAPPED_DISPATCH='), `unexpected stdout: ${resA.stdout}`)
      const infoA = JSON.parse(groupLineA.slice('GROUP_INFO='.length)) as { coordId: number; groupId: string }

      const fauxA = makeFauxProvider({ models: [{ id: 'faux-1' }] })
      setSwarmRoleResponses(fauxA, {
        coordinator: [
          fauxAssistantMessage('Coordinator observed idempotent dispatch replay result.'),
          fauxAssistantMessage('Coordinator acknowledged coder done report.'),
        ],
        coder: [
          fauxAssistantMessage(
            [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Finished after dispatch replay.' })],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('Coder finished cleanly.'),
        ],
      })

      const appA = await createHelmx({
        buildProvider: createPluginBuildProvider(),
        dataDir: dataDirA,
        cwd: repoDirA,
        model: 'faux/faux-1',
        providers: [fauxA.provider],
      })
      try {
        try {
          await waitFor(
            () =>
              isSettledStatus(appA.kernel.getConversation(infoA.coordId).status) &&
              appA.kernel.getConversation(infoA.coordId).completionSeq >= 2 &&
              appA.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0,
            { timeoutMs: 8_000 },
          )
        } catch (err) {
          const cSummary = appA.kernel.getConversation(infoA.coordId)
          const cDetail = await appA.kernel.getConversationDetail(infoA.coordId, { limit: 20 })
          const convs = appA.kernel.listConversations()
          throw new Error(
            `${(err as Error).message}\ncoord=${JSON.stringify(cSummary)}\nconvs=${JSON.stringify(convs)}\ncEntries=${JSON.stringify(cDetail.entries)}`,
          )
        }
        const metaA = JSON.parse(
          readFileSync(join(dataDirA, 'plugins', 'builtin%3Aswarm', 'groups', infoA.groupId, 'meta.json'), 'utf8'),
        ) as CollabGroupRecord
        assert.equal(metaA.members.length, 1, 'replaying swarm_dispatch_worker must not duplicate members')
        const coderA = metaA.members[0]!
        await appA.kernel.waitForIdle(coderA.conversationId)
        await waitFor(() => appA.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
        await appA.kernel.waitForIdle(infoA.coordId)

        const wtList = (await appA.kernel.plugins.invokeAction('builtin:worktree', 'list_worktrees', {})) as {
          worktrees: Array<{ status: string }>
        }
        assert.equal(
          wtList.worktrees.filter((w) => w.status === 'active').length,
          1,
          'replaying swarm_dispatch_worker must reuse the single acquired worktree',
        )
        const coordDetailA = await appA.kernel.getConversationDetail(infoA.coordId, { limit: 50 })
        const dispatchErrors = coordDetailA.entries.filter(
          (e) =>
            e.kind === 'pi.toolResult' &&
            JSON.stringify(e.data ?? '').includes('swarm_dispatch_worker') &&
            (e.data as { isError?: boolean } | undefined)?.isError === true,
        )
        assert.equal(dispatchErrors.length, 0, 'replay of swarm_dispatch_worker must not raise 409 conflict')
        const workerDetailA = await appA.kernel.getConversationDetail(coderA.conversationId, { limit: 50 })
        assert.equal(workerDetailA.entries.filter((e) => e.kind === 'helmx.input').length, 1)
      } finally {
        await appA.close()
      }
    }

    const runPhaseB = async (): Promise<void> => {
      const dataDirB = join(rootB, 'data')
      const repoDirB = join(rootB, 'repo')
      gitTemplate.cloneTo(repoDirB)

      const seedPostScript = `
        import { writeSync } from 'node:fs'
        import { createPluginBuildProvider } from ${JSON.stringify(PLUGIN_BUILD_URL)}
        import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(PI_AI_FAUX_URL)}
        import { createHelmx } from ${JSON.stringify(HUB_APP_URL)}

        const faux = fauxProvider({ models: [{ id: 'faux-1' }], tokensPerSecond: 500 })
        faux.setResponses([
          fauxAssistantMessage(
            [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Single idempotent done post.' })],
            { stopReason: 'toolUse' },
          ),
          () => new Promise(() => {}),
        ])
        const app = await createHelmx({
          buildProvider: createPluginBuildProvider(),
          dataDir: ${JSON.stringify(dataDirB)},
          cwd: ${JSON.stringify(repoDirB)},
          model: 'faux/faux-1',
          providers: [faux.provider],
        })
        await app.kernel.plugins.register({
          id: 'test:sigkill-post-trap',
          name: 'sigkill post trap',
          definePlugin(ctx) {
            ctx.hook.onToolResult((ev) => {
              if (ev.toolName === 'swarm_board_post') {
                writeSync(1, 'TRAPPED_POST=1\\n')
                process.kill(process.pid, 'SIGKILL')
              }
              return { action: 'continue' }
            })
          },
        })
        const coord = await app.kernel.createConversation({
          title: 'Post Replay Coord',
          profileId: 'assistant',
          cwd: ${JSON.stringify(repoDirB)},
        })
        const { groupId } = (await app.kernel.plugins.invokeAction('builtin:swarm', 'create_group', {
          title: 'Post Replay Squad',
          conversationId: coord.id,
        })) as { groupId: string }
        const worker = (await app.kernel.plugins.invokeAction(
          'builtin:swarm',
          'dispatch_worker',
          { prompt: 'Post done once.', name: 'coder' },
          { conversationId: coord.id },
        )) as { workerConversationId: number }
        writeSync(1, 'POST_INFO=' + JSON.stringify({ coordId: coord.id, groupId, workerId: worker.workerConversationId }) + '\\n')
        await new Promise(() => {})
      `
      const resB = await spawnSigkillSeeder(t, rootB, 'seed-post-kill.mts', seedPostScript)
      const postLineB = resB.stdout.split(/\r?\n/).find((l) => l.startsWith('POST_INFO='))
      assert.ok(postLineB !== undefined && resB.stdout.includes('TRAPPED_POST=1'), `unexpected stdout: ${resB.stdout}`)
      const infoB = JSON.parse(postLineB.slice('POST_INFO='.length)) as {
        coordId: number
        groupId: string
        workerId: number
      }

      const fauxB = makeFauxProvider({ models: [{ id: 'faux-1' }] })
      setSwarmRoleResponses(fauxB, {
        coder: [fauxAssistantMessage('Coder completed after board_post replay.')],
        coordinator: [fauxAssistantMessage('Coordinator acknowledged single done report.')],
      })
      const appB = await createHelmx({
        buildProvider: createPluginBuildProvider(),
        dataDir: dataDirB,
        cwd: repoDirB,
        model: 'faux/faux-1',
        providers: [fauxB.provider],
      })
      try {
        await waitFor(
          () =>
            isSettledStatus(appB.kernel.getConversation(infoB.workerId).status) &&
            isSettledStatus(appB.kernel.getConversation(infoB.coordId).status) &&
            appB.kernel.getConversation(infoB.workerId).completionSeq >= 1 &&
            appB.kernel.getConversation(infoB.coordId).completionSeq >= 1 &&
            appB.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0,
          { timeoutMs: 8_000 },
        )
        const readB = (await appB.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId: infoB.groupId })) as {
          posts: BoardPost[]
        }
        const donePosts = readB.posts.filter((p) => p.kind === 'done' && p.from === 'coder')
        assert.equal(donePosts.length, 1, `replaying swarm_board_post must keep exactly 1 done post, got ${donePosts.length}`)
        const coordDetailB = await appB.kernel.getConversationDetail(infoB.coordId, { limit: 50 })
        const reportsB = coordDetailB.entries.filter(
          (e) => e.kind === 'helmx.input' && JSON.stringify(e.data ?? '').includes('swarm_board_report'),
        )
        assert.equal(reportsB.length, 1)
      } finally {
        await appB.close()
      }
    }

    await Promise.all([runPhaseA(), runPhaseB()])
  })

  // ---------------------------------------------------------------------------
  // int9: 启动单真源收敛 — WAL 尾行截断回滚 + 孤儿/错配标签收敛 + 孤儿 Swarm Worktree 清理（不越权）
  // ---------------------------------------------------------------------------

  test('swarm-int9: boot reconciliation rolls back uncommitted WAL tail, converges orphan/stale tags, and cleans orphan swarm worktree holds without touching workflow holds', { timeout: 60_000 }, async (t) => {
    const root = useTempDir(t, 'helmx-swarm-orphans-')
    const env1 = await openSwarmEnv(root, gitTemplate)
    let groupId = ''
    let group2Id = ''
    let coordId = 0
    let coderId = 0
    let orphanCoordId = 0
    let orphanWorkerId = 0
    let swarmOrphanWtId = ''
    let workflowWtId = ''
    let committedHeadSeq = 0

    try {
      const coord = await env1.app.kernel.createConversation({ title: 'Clean Coord', profileId: 'assistant', cwd: env1.repoDir })
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

      await env1.app.kernel.waitForIdle(coderId)
      await waitFor(() => env1.app.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await env1.app.kernel.waitForIdle(coordId)

      // Archive coder, then re-apply stale WORKER_TAG to simulate crash between meta.json commit and tag swap.
      await env1.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'archive_worker', {
        groupId,
        name: 'coder',
      })
      await env1.app.kernel.updateConversation(coderId, { tags: [WORKER_TAG] })

      // Orphan coordinator clone & orphan worker carrying stale live tags outside meta.json.
      const orphanCoord = await env1.app.kernel.createConversation({
        title: 'Forked Orphan Coord',
        profileId: 'assistant',
        cwd: env1.repoDir,
        tags: [COORDINATOR_TAG],
      })
      orphanCoordId = orphanCoord.id

      const orphanWorker = await env1.app.kernel.createConversation({
        title: 'Orphan Worker',
        profileId: 'assistant',
        cwd: env1.repoDir,
        tags: [WORKER_TAG],
      })
      orphanWorkerId = orphanWorker.id

      // Orphan builtin:swarm worktree hold + foreign builtin:workflow worktree hold.
      const wtSwarmConv = await env1.app.kernel.createConversation({
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

      const wtWorkflowConv = await env1.app.kernel.createConversation({
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
          await env1.app.kernel.createConversation({ title: 'Partial Tail Coord', profileId: 'assistant', cwd: env1.repoDir })
        ).id,
      })) as { groupId: string }
      group2Id = created2.groupId
    } finally {
      await env1.close()
    }

    // Inject uncommitted complete WAL tail post on group1 and partial truncated JSON tail on group2.
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
      channel: 'main',
      from: 'coordinator',
      to: ['all'],
      resolvedTargets: [],
      wake: false,
      kind: 'comment',
      refs: [],
      body: 'Uncommitted crash post that must be rolled back',
      createdAt: Date.now(),
    }
    writeFileSync(
      boardPath,
      `${existingBoard}${JSON.stringify(dirtyPost)}\n`,
      'utf8',
    )

    const faux2 = makeFauxProvider({ models: [{ id: 'faux-1' }] })
    const app2 = await createHelmx({
      buildProvider: createPluginBuildProvider(),
      dataDir: env1.dataDir,
      cwd: env1.repoDir,
      model: 'faux/faux-1',
      providers: [faux2.provider],
    })
    try {
      await waitFor(() => app2.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)

      // 1) WAL rolled back cleanly to committed headSeq.
      const read = (await app2.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as { posts: BoardPost[] }
      assert.equal(read.posts.every((p) => p.seq <= committedHeadSeq), true)
      assert.equal(read.posts.some((p) => p.body.includes('Uncommitted crash post')), false)
      const repairedLines = readFileSync(boardPath, 'utf8').trim().split('\n').filter(Boolean)
      assert.equal(repairedLines.length, committedHeadSeq)

      const read2 = (await app2.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId: group2Id })) as { posts: BoardPost[] }
      assert.equal(read2.posts.length, 0)
      assert.equal(readFileSync(boardPath2, 'utf8'), '')

      // 2) Tags converged strictly against meta.json.
      assert.equal(app2.kernel.getConversation(coordId).tags.includes(COORDINATOR_TAG), true)
      assert.equal(app2.kernel.getConversation(orphanCoordId).tags.includes(COORDINATOR_TAG), false)
      assert.equal(app2.kernel.getConversation(coderId).tags.includes(WORKER_TAG), false)
      assert.equal(app2.kernel.getConversation(coderId).tags.includes(ARCHIVED_WORKER_TAG), true)
      assert.equal(app2.kernel.getConversation(orphanWorkerId).tags.includes(WORKER_TAG), false)

      // 3) Orphaned builtin:swarm worktree hold was released and removed; builtin:workflow hold remained intact.
      const swarmWtInspect = (await app2.kernel.plugins.invokeAction('builtin:worktree', 'inspect_worktree', {
        worktreeId: swarmOrphanWtId,
        diff: false,
      })) as { exists: boolean }
      assert.equal(swarmWtInspect.exists, false)
      const workflowWtInspect = (await app2.kernel.plugins.invokeAction('builtin:worktree', 'inspect_worktree', {
        worktreeId: workflowWtId,
        diff: false,
      })) as { exists: boolean }
      assert.equal(workflowWtInspect.exists, true)
    } finally {
      await app2.close()
    }
  })

  // ---------------------------------------------------------------------------
  // int10: runtime.started 对账 — inflightWakeup 未提交死锁恢复、漏收 turn_settled 哑巴续催与异常自动 blocker
  // ---------------------------------------------------------------------------

  test('swarm-int10: runtime.started reconciliation wakes uncommitted inflightWakeup, nudges silent-exit member, and posts blocker for errored member', { timeout: 60_000 }, async (t) => {
    const root = useTempDir(t, 'helmx-swarm-reconcile-')
    const env1 = await openSwarmEnv(root, gitTemplate)
    let groupId = ''
    let coordId = 0
    let workerAId = 0
    let workerBId = 0
    let workerCId = 0

    try {
      const coord = await env1.app.kernel.createConversation({ title: 'Reconcile Coord', profileId: 'assistant', cwd: env1.repoDir })
      coordId = coord.id
      const created = (await env1.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Missed Settlement Squad',
        conversationId: coord.id,
      })) as { groupId: string }
      groupId = created.groupId

      const convA = await env1.app.kernel.createConversation({
        title: 'Worker A',
        profileId: 'assistant',
        cwd: env1.repoDir,
        tags: [WORKER_TAG],
      })
      workerAId = convA.id

      const convB = await env1.app.kernel.createConversation({
        title: 'Worker B',
        profileId: 'assistant',
        cwd: env1.repoDir,
        tags: [WORKER_TAG],
      })
      workerBId = convB.id

      const convC = await env1.app.kernel.createConversation({
        title: 'Worker C',
        profileId: 'assistant',
        cwd: env1.repoDir,
        tags: [WORKER_TAG],
      })
      workerCId = convC.id

      // Seed real pre-restart turns for workerB (silent idle completion) and workerC (error stopReason)
      // before registering them into meta.json so pre-crash turn_settled didn't run on them yet.
      env1.faux.setResponses([
        fauxAssistantMessage('Silent exit response without calling swarm_board_post.'),
        fauxAssistantMessage('Partial failure output.', { stopReason: 'error', errorMessage: 'simulated model crash' }),
      ])
      await env1.app.kernel.submitInput(workerBId, '[swarm_worker_brief] Finish task B.', {
        origin: 'agent',
        requestId: `swarm-wakeup:${groupId}:workerB:1-2`,
      })
      await env1.app.kernel.waitForIdle(workerBId)

      await env1.app.kernel.submitInput(workerCId, '[swarm_worker_brief] Finish task C.', {
        origin: 'agent',
        requestId: `swarm-wakeup:${groupId}:workerC:1-3`,
      })
      await waitFor(() => env1.app.kernel.getConversation(workerCId).status !== 'working')
    } finally {
      await env1.close()
    }

    // Persist post-crash disk state: 3 briefs in board.jsonl + inflightWakeup / missed settlements in meta.json.
    const groupDir = join(env1.dataDir, 'plugins', 'builtin%3Aswarm', 'groups', groupId)
    const metaPath = join(groupDir, 'meta.json')
    const boardPath = join(groupDir, 'board.jsonl')
    const now = Date.now()
    const posts: BoardPost[] = [
      {
        groupId,
        seq: 1,
        channel: 'main',
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
        groupId,
        seq: 2,
        channel: 'main',
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
        groupId,
        seq: 3,
        channel: 'main',
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
    writeFileSync(boardPath, `${posts.map((p) => JSON.stringify(p)).join('\n')}\n`, 'utf8')

    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as CollabGroupRecord
    meta.headSeq = 3
    meta.members = [
      {
        name: 'workerA',
        conversationId: workerAId,
        profileId: 'assistant',
        access: 'readwrite',
        isolation: 'inherit',
        nodeId: 'local',
        cwd: env1.repoDir,
        channels: ['main'],
        lifecycle: 'active',
        readCursorSeq: 0,
        pendingWakeupSeq: 1,
        lastWakeTaskSeq: 1,
        inflightWakeup: {
          requestId: `swarm-wakeup:${groupId}:workerA:1-1`,
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
        channels: ['main'],
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
        channels: ['main'],
        lifecycle: 'active',
        readCursorSeq: 3,
        pendingWakeupSeq: 3,
        lastWakeTaskSeq: 3,
        lastWakeCompletionSeq: 0,
        createdAt: now - 10,
      },
    ]
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

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

    const app2 = await createHelmx({
      buildProvider: createPluginBuildProvider(),
      dataDir: env1.dataDir,
      cwd: env1.repoDir,
      model: 'faux/faux-1',
      providers: [faux2.provider],
    })
    try {
      try {
        await waitFor(
          () =>
            isSettledStatus(app2.kernel.getConversation(workerAId).status) &&
            app2.kernel.getConversation(workerAId).completionSeq >= 1 &&
            isSettledStatus(app2.kernel.getConversation(workerBId).status) &&
            app2.kernel.getConversation(workerBId).completionSeq >= 2 &&
            isSettledStatus(app2.kernel.getConversation(coordId).status) &&
            app2.kernel.getConversation(coordId).completionSeq >= 1 &&
            app2.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0,
          { timeoutMs: 8_000 },
        )
      } catch (err) {
        const a = app2.kernel.getConversation(workerAId)
        const b = app2.kernel.getConversation(workerBId)
        const c = app2.kernel.getConversation(workerCId)
        const cr = app2.kernel.getConversation(coordId)
        const dB = await app2.kernel.getConversationDetail(workerBId, { limit: 20 })
        const dCoord = await app2.kernel.getConversationDetail(coordId, { limit: 20 })
        throw new Error(
          `${(err as Error).message}\nworkerA=${JSON.stringify(a)}\nworkerB=${JSON.stringify(b)}\nworkerC=${JSON.stringify(c)}\ncoord=${JSON.stringify(cr)}\nbEntries=${JSON.stringify(dB.entries)}\ncoordEntries=${JSON.stringify(dCoord.entries)}`,
        )
      }
      await app2.kernel.waitForIdle(workerAId)
      await app2.kernel.waitForIdle(workerBId)
      await app2.kernel.waitForIdle(coordId)

      const read = (await app2.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as {
        posts: BoardPost[]
      }
      assert.equal(read.posts.filter((p) => p.kind === 'done' && p.from === 'workerA').length, 1)
      assert.equal(read.posts.filter((p) => p.kind === 'done' && p.from === 'workerB').length, 1)
      const blockerC = read.posts.find((p) => p.kind === 'blocker' && p.from === 'system' && p.to.includes('coordinator'))
      assert.ok(blockerC !== undefined, `expected auto system blocker for errored workerC, got ${JSON.stringify(read.posts)}`)
      assert.match(blockerC.body, /workerC/)

      const detailB = await app2.kernel.getConversationDetail(workerBId, { limit: 50 })
      const nudgesB = detailB.entries.filter(
        (e) => e.kind === 'helmx.input' && JSON.stringify(e.data ?? '').includes('swarm_silent_exit_nudge'),
      )
      assert.equal(nudgesB.length, 1, `expected 1 silent-exit nudge for workerB, got ${nudgesB.length}`)

      const detailC = await app2.kernel.getConversationDetail(workerCId, { limit: 50 })
      assert.equal(
        detailC.entries.some((e) => JSON.stringify(e.data ?? '').includes('swarm_silent_exit_nudge')),
        false,
        'errored workerC must receive auto blocker rather than silent-exit nudge',
      )

      const coordDetail = await app2.kernel.getConversationDetail(coordId, { limit: 50 })
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
})
