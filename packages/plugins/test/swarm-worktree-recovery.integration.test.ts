/**
 * `builtin:swarm` Worktree SIGKILL 恢复与动态远端节点集成测试（Integration 档）：
 * 1) 真实子进程 SIGKILL 中断 worktree 成员生成 -> 重启无缝续跑、保留 worktree 并正常关组回收；
 * 2) 真实远端节点 (`createNodeDaemon` + `startHub`) 上动态 allocation/handoff/archive/close_group 与清理。
 */
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'

import { startHub } from '@helmx/kernel'
import { createNodeDaemon, type NodeDaemon } from '../../node/src/index.js'
import {
  createGitTemplate,
  makeFauxProvider,
  useTempDir,
  waitFor,
} from './helpers/plugin-test-env.js'
import {
  PI_AI_FAUX_URL,
  WORKTREE_ID,
  buildSwarmSeederOpenSnippet,
  isSettledStatus,
  openSwarmEnv,
  openSwarmRuntime,
  setSwarmRoleResponses,
  spawnSigkillSeeder,
} from './helpers/swarm-integration-env.js'
import {
  ARCHIVED_COORDINATOR_TAG,
  ARCHIVED_WORKER_TAG,
  COORDINATOR_TAG,
  SWARM_PLUGIN_ID,
  WORKER_TAG,
  type BoardPost,
  type BoardViewDoc,
  type CollabGroupRecord,
} from '../src/swarm.js'

describe('builtin:swarm worktree SIGKILL recovery & remote node worktrees', { concurrency: 2, timeout: 60_000 }, () => {
  const gitTemplate = createGitTemplate()
  after(() => gitTemplate.cleanup(), { timeout: 60_000 })

  test('swarm-int7: real SIGKILL mid-turn resumes streaming worktree worker with zero duplicate input, keeps worktree active, and cleans up on close_group', { timeout: 60_000 }, async (t) => {
    const root = useTempDir(t, 'helmx-swarm-sigkill-worker-')
    const dataDir = join(root, 'data')
    const repoDir = join(root, 'repo')
    gitTemplate.cloneTo(repoDir)

    const seederScript = `
      import { writeSync } from 'node:fs'
      import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(PI_AI_FAUX_URL)}
      ${buildSwarmSeederOpenSnippet()}

      const faux = fauxProvider({
        models: [{ id: 'faux-1' }],
        tokensPerSecond: 2,
        tokenSize: { min: 1, max: 1 },
      })
      faux.setResponses([
        fauxAssistantMessage('这是一段Swarm成员在隔离worktree中慢速流式执行任务确保被真实SIGKILL中断的输出内容'),
      ])
      const app = await openSwarmApp({
        dataDir: ${JSON.stringify(dataDir)},
        cwd: ${JSON.stringify(repoDir)},
        model: 'faux/faux-1',
        providers: [faux.provider],
      })
      const coord = await app.kernel.conversations.createConversation({
        title: 'Kill Worker Coord',
        profileId: 'assistant',
        cwd: ${JSON.stringify(repoDir)},
      })
      const { groupId } = await app.kernel.plugins.invokeAction(
        'builtin:swarm',
        'create_group',
        { title: 'Kill Recovery Squad', conversationId: coord.id },
      )
      const worker = await app.kernel.plugins.invokeAction(
        'builtin:swarm',
        'dispatch_worker',
        { prompt: 'Execute task inside isolated worktree and post done.', name: 'coder', isolation: 'worktree' },
        { conversationId: coord.id },
      )

      for (let i = 0; i < 1000; i += 1) {
        await new Promise((r) => setTimeout(r, 2))
        if (
          faux.state.callCount >= 1 &&
          app.kernel.conversations.getConversation(worker.workerConversationId).status === 'working'
        ) {
          break
        }
      }
      if (faux.state.callCount < 1) {
        process.stderr.write('seeder did not reach worker faux call\\n')
        process.exit(3)
      }
      writeSync(1, 'SEED_RESULT=' + JSON.stringify({ coordId: coord.id, groupId, workerId: worker.workerConversationId }) + '\\n')
      process.kill(process.pid, 'SIGKILL')
    `
    const { stdout } = await spawnSigkillSeeder(t, root, 'seed-worker-kill.mjs', seederScript)
    const seedLine = stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith('SEED_RESULT='))
    assert.ok(seedLine !== undefined, `missing SEED_RESULT line in stdout: ${stdout}`)
    const seeded = JSON.parse(seedLine.slice('SEED_RESULT='.length)) as {
      coordId: number
      groupId: string
      workerId: number
    }

    const metaPath = join(dataDir, 'plugins', 'builtin%3Aswarm', 'groups', seeded.groupId, 'meta.json')
    const preMeta = JSON.parse(readFileSync(metaPath, 'utf8')) as CollabGroupRecord
    const preCoder = preMeta.members.find((m) => m.name === 'coder')
    assert.ok(preCoder?.worktreeId !== undefined, 'pre-restart worker must hold worktreeId')

    const faux = makeFauxProvider({ models: [{ id: 'faux-1' }] })
    setSwarmRoleResponses(faux, {
      coder: [
        fauxAssistantMessage(
          [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Recovered from SIGKILL and finished worktree task.' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Worker finished after SIGKILL recovery.'),
      ],
      coordinator: [fauxAssistantMessage('Coordinator received recovery done report.')],
    })

    const app = await openSwarmRuntime({
      dataDir,
      cwd: repoDir,
      faux,
    })
    try {
      try {
        await waitFor(
          () =>
            isSettledStatus(app.kernel.conversations.getConversation(seeded.workerId).status) &&
            isSettledStatus(app.kernel.conversations.getConversation(seeded.coordId).status) &&
            app.kernel.conversations.getConversation(seeded.workerId).completionSeq >= 1 &&
            app.kernel.conversations.getConversation(seeded.coordId).completionSeq >= 1 &&
            app.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0,
          { timeoutMs: 8_000 },
        )
      } catch (err) {
        const wSummary = app.kernel.conversations.getConversation(seeded.workerId)
        const cSummary = app.kernel.conversations.getConversation(seeded.coordId)
        const wDetail = await app.kernel.conversations.getConversationDetail(seeded.workerId, { limit: 20 })
        const cDetail = await app.kernel.conversations.getConversationDetail(seeded.coordId, { limit: 20 })
        throw new Error(
          `${(err as Error).message}\nworker=${JSON.stringify(wSummary)}\ncoord=${JSON.stringify(cSummary)}\nwEntries=${JSON.stringify(wDetail.entries)}\ncEntries=${JSON.stringify(cDetail.entries)}`,
        )
      }
      await app.kernel.conversations.waitForIdle(seeded.workerId)
      await app.kernel.conversations.waitForIdle(seeded.coordId)

      // Worktree stayed alive during recovery and cleanup runs cleanly on close_group.
      const inspectedBeforeClose = (await app.kernel.plugins.invokeAction('builtin:worktree', 'inspect_worktree', {
        worktreeId: preCoder.worktreeId,
        diff: false,
      })) as { exists: boolean }
      assert.equal(inspectedBeforeClose.exists, true)

      const workerDetail = await app.kernel.conversations.getConversationDetail(seeded.workerId, { limit: 50 })
      const workerInputs = workerDetail.entries.filter((e) => e.kind === 'helmx.input')
      assert.equal(workerInputs.length, 1, `expected 1 deduplicated wakeup input, got ${workerInputs.length}`)

      const read = (await app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId: seeded.groupId })) as {
        posts: BoardPost[]
      }
      assert.equal(read.posts.filter((p) => p.from === 'system').length, 0)
      assert.equal(read.posts.filter((p) => p.kind === 'done' && p.from === 'coder').length, 1)

      const coordDetail = await app.kernel.conversations.getConversationDetail(seeded.coordId, { limit: 50 })
      const reports = coordDetail.entries.filter(
        (e) => e.kind === 'helmx.input' && JSON.stringify(e.data ?? '').includes('swarm_board_report'),
      )
      assert.equal(reports.length, 1)
      assert.match(JSON.stringify(reports[0]!.data ?? ''), /\[done\] @coder/)

      await app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId: seeded.groupId })
      const inspectedAfterClose = (await app.kernel.plugins.invokeAction('builtin:worktree', 'inspect_worktree', {
        worktreeId: preCoder.worktreeId,
        diff: false,
      })) as { exists: boolean }
      assert.equal(inspectedAfterClose.exists, false)
      assert.equal(app.kernel.conversations.getConversation(seeded.coordId).tags.includes(ARCHIVED_COORDINATOR_TAG), true)
      assert.equal(app.kernel.conversations.getConversation(seeded.coordId).tags.includes(COORDINATOR_TAG), false)
      assert.equal(app.kernel.conversations.getConversation(seeded.workerId).tags.includes(ARCHIVED_WORKER_TAG), true)
      assert.equal(app.kernel.conversations.getConversation(seeded.workerId).tags.includes(WORKER_TAG), false)
    } finally {
      await app.close()
    }
  })

  test('swarm-int18: Swarm + Worktree remote dynamic nodeId allocates real worktrees via acquire_worktree, records member.nodeId & worktreeId, and preserves remote nodeId in retainedWorktrees on archive_worker & close_group', { timeout: 60_000 }, async (t) => {
    const root = useTempDir(t, 'helmx-swarm-remote-wt-')
    const env = await openSwarmEnv(root, gitTemplate)
    const remoteRepoDir = join(root, 'remote-repo')
    gitTemplate.cloneTo(remoteRepoDir)
    const nodeDataDir = join(root, 'node-data')
    mkdirSync(nodeDataDir, { recursive: true })

    let hub: Awaited<ReturnType<typeof startHub>> | undefined
    let daemon: NodeDaemon | undefined
    try {
      const { kernel } = env.app
      hub = await startHub({ kernel: kernel as never, port: 0 })
      const issued = await kernel.nodes.issueNodeToken('remote-wt-node')
      daemon = await createNodeDaemon({
        hubUrl: hub.url,
        identity: { nodeId: 'remote-wt-node', token: issued.token },
        dataDir: nodeDataDir,
        envServer: { shellEnv: { HELMX_NODE_TEST_ORIGIN: 'remote-wt-exec' } },
        reconnectBaseDelayMs: 50,
        log: () => undefined,
      })
      assert.equal(await daemon.waitUntilRegistered(5_000), true)
      assert.equal(kernel.envFabric.isOnline('remote-wt-node'), true)

      const coord = await kernel.conversations.createConversation({
        title: 'Local Coord Dispatching Remote Worktrees',
        profileId: 'assistant',
        cwd: env.repoDir,
      })
      assert.equal(coord.nodeId, 'local')

      const { groupId } = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'create_group',
        { title: 'Remote Worktree Squad', objective: 'Allocate isolated worktrees on remote-wt-node', conversationId: coord.id },
      )) as { groupId: string }

      setSwarmRoleResponses(env.faux, {
        remote_a: [
          fauxAssistantMessage(
            [
              fauxToolCall('bash', {
                command:
                  'test "$HELMX_NODE_TEST_ORIGIN" = remote-wt-exec && printf "a:%s\\n" "$HELMX_NODE_TEST_ORIGIN" > remote-a.txt && git add remote-a.txt && git commit -m "feat: remote-a"',
              }),
            ],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage(
            [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Committed remote-a.txt on remote-wt-node.' })],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('remote_a settled.'),
        ],
        remote_b: [
          fauxAssistantMessage(
            [
              fauxToolCall('bash', {
                command:
                  'test "$HELMX_NODE_TEST_ORIGIN" = remote-wt-exec && printf "b:%s\\n" "$HELMX_NODE_TEST_ORIGIN" > remote-b.txt && git add remote-b.txt && git commit -m "feat: remote-b"',
              }),
            ],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage(
            [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Committed remote-b.txt on remote-wt-node.' })],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('remote_b settled.'),
        ],
        coordinator: [
          fauxAssistantMessage('Coordinator received remote_a completion.'),
          fauxAssistantMessage('Coordinator received remote_b completion.'),
        ],
      })

      const workerA = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        {
          groupId,
          name: 'remote_a',
          prompt: 'Commit remote-a.txt in an isolated remote worktree.',
          nodeId: 'remote-wt-node',
          cwd: remoteRepoDir,
          isolation: 'worktree',
        },
        { conversationId: coord.id },
      )) as { workerConversationId: number; worktreeId: string }

      await kernel.conversations.waitForIdle(workerA.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

      const workerB = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        {
          groupId,
          name: 'remote_b',
          prompt: 'Commit remote-b.txt in an isolated remote worktree.',
          nodeId: 'remote-wt-node',
          cwd: remoteRepoDir,
          isolation: 'worktree',
        },
        { conversationId: coord.id },
      )) as { workerConversationId: number; worktreeId: string }

      await kernel.conversations.waitForIdle(workerB.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

      assert.ok(workerA.worktreeId.startsWith('remote-wt-node:'), `workerA worktreeId should target remote-wt-node: ${workerA.worktreeId}`)
      assert.ok(workerB.worktreeId.startsWith('remote-wt-node:'), `workerB worktreeId should target remote-wt-node: ${workerB.worktreeId}`)
      const wtPathA = workerA.worktreeId.slice('remote-wt-node:'.length)
      const wtPathB = workerB.worktreeId.slice('remote-wt-node:'.length)

      const convA = kernel.conversations.getConversation(workerA.workerConversationId)
      const convB = kernel.conversations.getConversation(workerB.workerConversationId)
      assert.equal(convA.nodeId, 'remote-wt-node')
      assert.equal(convA.cwd, wtPathA)
      assert.equal(convB.nodeId, 'remote-wt-node')
      assert.equal(convB.cwd, wtPathB)
      assert.equal(readFileSync(join(wtPathA, 'remote-a.txt'), 'utf8').trim(), 'a:remote-wt-exec')
      assert.equal(readFileSync(join(wtPathB, 'remote-b.txt'), 'utf8').trim(), 'b:remote-wt-exec')

      // board_status records real member.nodeId & member.worktreeId
      const liveStatus = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'board_status',
        { groupId },
        { conversationId: coord.id },
      )) as BoardViewDoc
      const memberA = liveStatus.members.find((m) => m.name === 'remote_a')
      const memberB = liveStatus.members.find((m) => m.name === 'remote_b')
      assert.equal(memberA?.nodeId, 'remote-wt-node')
      assert.equal(memberA?.worktreeId, workerA.worktreeId)
      assert.equal(memberB?.nodeId, 'remote-wt-node')
      assert.equal(memberB?.worktreeId, workerB.worktreeId)

      // inspect_worktree on builtin:worktree confirms remote allocation & 1 unmerged commit
      const inspectedA = (await kernel.plugins.invokeAction(WORKTREE_ID, 'inspect_worktree', {
        worktreeId: workerA.worktreeId,
        diff: false,
      })) as { exists: boolean; commitsAhead?: number; record?: { nodeId: string } }
      assert.equal(inspectedA.exists, true)
      assert.equal(inspectedA.commitsAhead, 1)
      assert.equal(inspectedA.record?.nodeId, 'remote-wt-node')

      // archive_worker({ keepWorktree: true }) preserves remote_a with nodeId: 'remote-wt-node'
      await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'archive_worker',
        { groupId, name: 'remote_a', keepWorktree: true },
        { conversationId: coord.id },
      )
      const afterArchive = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'board_status',
        { groupId },
        { conversationId: coord.id },
      )) as BoardViewDoc
      assert.equal(afterArchive.group.retainedWorktrees?.length, 1)
      assert.equal(afterArchive.group.retainedWorktrees?.[0]?.memberName, 'remote_a')
      assert.equal(afterArchive.group.retainedWorktrees?.[0]?.nodeId, 'remote-wt-node')
      assert.equal(afterArchive.group.retainedWorktrees?.[0]?.worktreeId, workerA.worktreeId)
      assert.equal(afterArchive.group.retainedWorktrees?.[0]?.commitsAhead, 1)

      // close_group({ keepWorktree: true }) preserves BOTH remote_a and remote_b with nodeId: 'remote-wt-node'
      const closed = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'close_group',
        { groupId, keepWorktree: true, summary: 'Retain both remote worktrees' },
        { conversationId: coord.id },
      )) as {
        closed: boolean
        retainedWorktrees: Array<{ memberName: string; nodeId: string; worktreeId: string; branch: string; path: string; commitsAhead: number }>
      }
      assert.equal(closed.closed, true)
      assert.equal(closed.retainedWorktrees.length, 2)
      const byMember = new Map(closed.retainedWorktrees.map((w) => [w.memberName, w]))
      assert.equal(byMember.get('remote_a')?.nodeId, 'remote-wt-node')
      assert.equal(byMember.get('remote_a')?.worktreeId, workerA.worktreeId)
      assert.equal(byMember.get('remote_a')?.commitsAhead, 1)
      assert.equal(byMember.get('remote_b')?.nodeId, 'remote-wt-node')
      assert.equal(byMember.get('remote_b')?.worktreeId, workerB.worktreeId)
      assert.equal(byMember.get('remote_b')?.commitsAhead, 1)

      // Clean up both retained remote worktrees cleanly via builtin:worktree
      for (const wtId of [workerA.worktreeId, workerB.worktreeId]) {
        const cleaned = (await kernel.plugins.invokeAction(WORKTREE_ID, 'cleanup_worktree', {
          worktreeId: wtId,
          force: true,
          deleteBranch: true,
        })) as { removed: boolean; nodeId: string; branchDeleted: boolean }
        assert.equal(cleaned.removed, true)
        assert.equal(cleaned.nodeId, 'remote-wt-node')
        assert.equal(cleaned.branchDeleted, true)
      }
      assert.equal(existsSync(wtPathA), false)
      assert.equal(existsSync(wtPathB), false)
    } finally {
      await daemon?.close()
      await hub?.close()
      await env.close()
    }
  })
})
