/**
 * `builtin:swarm` Worktree 隔离、交接快照、持有锁与收尾恢复组合层集成测试（Integration 档）：
 * 1) Author(worktree) + Verifier(readonly) 真实 Git Worktree 交接快照、空闲期 ManagedWorktreeHold
 *    防删与阻塞 worktree 停用、两态 close_group(409 vs keepWorktree 保留合入、历史 tag 切换) 与 closed/detached 读取；
 * 2) builtin:workflow 停用 + builtin:worktree 启用时的零静态依赖隔离派工与清理；
 * 3) close_group force 出口（ignored 构建产物默认可收尾、真实脏成员默认拒绝、force: true 强制清理）；
 * 4) 真实子进程 SIGKILL 中断 worktree 成员生成 -> 重启无缝续跑、保留 worktree 并正常关组回收。
 */
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'

import { HelmxError } from '@helmx/protocol'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { createHelmx } from '../../hub/src/app.js'
import { startHub } from '@helmx/kernel'
import { createNodeDaemon, type NodeDaemon } from '../../node/src/index.js'
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
  WORKFLOW_ID,
  WORKTREE_ID,
  captureRequestMeta,
  isSettledStatus,
  openSwarmEnv,
  setSwarmRoleResponses,
  spawnSigkillSeeder,
} from './helpers/swarm-integration-env.js'
import {
  ARCHIVED_COORDINATOR_TAG,
  ARCHIVED_WORKER_TAG,
  COORDINATOR_TAG,
  SWARM_PLUGIN_ID,
  WORKER_TAG,
  type BoardBadgesDoc,
  type BoardPost,
  type BoardViewDoc,
  type CollabGroupRecord,
} from '../src/swarm.js'

describe('builtin:swarm worktree isolation, handoff & close_group recovery', () => {
  const gitTemplate = createGitTemplate()
  after(() => gitTemplate.cleanup())

  test('swarm-int2: Author(worktree) + Verifier(readonly) handoff, hold blocks workflow disable & cleanup_worktree, two-mode close_group retain & merge, and closed/detached board_status', { timeout: 60_000 }, async (t) => {
    const env = await openSwarmEnv(useTempDir(t, 'helmx-swarm-int-'), gitTemplate)
    try {
      const { kernel } = env.app
      const coord = await kernel.createConversation({ title: 'Release Coordinator', profileId: 'assistant', cwd: env.repoDir })

      const { groupId } = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'create_group',
        { title: 'Feature Delivery', objective: 'Implement and verify feature.txt', conversationId: coord.id },
      )) as { groupId: string }

      // Dispatch verifier (readonly, inherit) first so it is idle when author hands off
      setSwarmRoleResponses(env.faux, {
        verifier: [
          fauxAssistantMessage([fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'comment', body: 'verifier standing by' })], {
            stopReason: 'toolUse',
          }),
          fauxAssistantMessage('Standing by for author handoff.'),
        ],
        coordinator: [fauxAssistantMessage('Coordinator noted verifier boot stall.')],
      })
      const verifier = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { prompt: 'Wait for author handoff and verify.', name: 'verifier', access: 'readonly', isolation: 'inherit' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }
      await kernel.waitForIdle(verifier.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.waitForIdle(coord.id)

      let verifierSectionSeen = ''
      let verifierToolsSeen: string[] = []
      let authorStep = 0
      let verifierStep = 0
      const routeSquadStep = (ctx: { messages: unknown[] }) => {
        const meta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
        const groupSec = meta.sectionsById['swarm.active_group'] ?? ''
        if (groupSec.includes('name="author"')) {
          authorStep += 1
          if (authorStep === 1) {
            return fauxAssistantMessage(
              [
                fauxToolCall('bash', {
                  command: 'printf "verified-payload\\n" > feature.txt && git add feature.txt && git commit -m "feat: add feature.txt"',
                }),
              ],
              { stopReason: 'toolUse' },
            )
          }
          if (authorStep === 2) {
            return fauxAssistantMessage(
              [
                fauxToolCall('swarm_board_post', {
                  to: ['verifier'],
                  kind: 'handoff',
                  refs: [2],
                  body: 'Implemented feature.txt in worktree; ready for verification.',
                }),
              ],
              { stopReason: 'toolUse' },
            )
          }
          return fauxAssistantMessage('Handed off to @verifier.')
        }
        if (groupSec.includes('name="verifier"')) {
          verifierStep += 1
          verifierSectionSeen = groupSec
          verifierToolsSeen = meta.toolNames
          if (verifierStep === 1) {
            return fauxAssistantMessage([fauxToolCall('bash', { command: 'git log -n 1 --oneline' })], { stopReason: 'toolUse' })
          }
          if (verifierStep === 2) {
            return fauxAssistantMessage(
              [
                fauxToolCall('swarm_board_post', {
                  to: ['coordinator'],
                  kind: 'done',
                  refs: [3],
                  body: 'Verified feature.txt commit cleanly (#3).',
                }),
              ],
              { stopReason: 'toolUse' },
            )
          }
          return fauxAssistantMessage('Verification complete.')
        }
        return fauxAssistantMessage('All slices verified; ready to merge.')
      }
      env.faux.setResponses(Array.from({ length: 14 }, () => routeSquadStep))

      const author = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { prompt: 'Create and commit feature.txt, then hand off to verifier.', name: 'author', access: 'readwrite', isolation: 'worktree' },
        { conversationId: coord.id },
      )) as { workerConversationId: number; worktreeId: string }

      assert.ok(typeof author.worktreeId === 'string' && author.worktreeId.length > 0)

      await waitFor(async () => {
        const status = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_status', { groupId })) as BoardViewDoc
        return status.posts.some((p) => p.kind === 'done' && p.from === 'verifier')
      })
      await kernel.waitForIdle(author.workerConversationId)
      await kernel.waitForIdle(verifier.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.waitForIdle(coord.id)

      // Verify readonly worker receives prompt guidance without stripping tools
      assert.match(verifierSectionSeen, /access="readonly"/)
      assert.match(verifierSectionSeen, /without modifying files/)
      assert.ok(verifierToolsSeen.includes('write'), 'readonly worker does not strip tools from tool definitions')
      assert.ok(verifierToolsSeen.includes('bash'), 'readonly worker retains bash')

      // Verify handoff post #3 carries auto-inlined worktreeSnapshot
      const readRes = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as {
        posts: BoardPost[]
      }
      const handoffPost = readRes.posts.find((p) => p.from === 'author' && p.kind === 'handoff')
      assert.ok(handoffPost !== undefined, 'handoff post from author must exist')
      assert.ok(handoffPost!.worktreeSnapshot !== undefined, 'handoff post must inline worktreeSnapshot')
      assert.equal(handoffPost!.worktreeSnapshot!.worktreeId, author.worktreeId)
      assert.equal(handoffPost!.worktreeSnapshot!.commitsAhead, 1)
      assert.ok(handoffPost!.worktreeSnapshot!.changedFilesPreview.includes('feature.txt'))

      // Verify O(1) board-badges populated for coordinator AND both active members
      const badges = kernel.plugins.getPublicDoc(SWARM_PLUGIN_ID, 'board-badges').value as BoardBadgesDoc
      for (const id of [coord.id, author.workerConversationId, verifier.workerConversationId]) {
        assert.equal(badges.byConversation[String(id)]?.groupId, groupId)
        assert.equal(badges.byConversation[String(id)]?.coordinatorConversationId, coord.id)
        assert.equal(badges.byConversation[String(id)]?.count, 2)
      }

      // Verify sessionDoc('board-view') matches board_status
      const sessionView = kernel.plugins.getPublicSessionDoc(SWARM_PLUGIN_ID, 'board-view', coord.id).value as BoardViewDoc
      assert.equal(sessionView.group.id, groupId)
      assert.ok(sessionView.posts.some((p) => p.from === 'author' && p.resolvedTargets.includes('verifier')))

      // Verify coordinator timeline report and worker wakeup carry swarm:board-report & swarm:board-wakeup renderers
      const coordDetail = await kernel.getConversationDetail(coord.id, { limit: 20 })
      assert.match(JSON.stringify(coordDetail.entries), /swarm:board-report/)
      const verifierDetail = await kernel.getConversationDetail(verifier.workerConversationId, { limit: 20 })
      assert.match(JSON.stringify(verifierDetail.entries), /swarm:board-wakeup/)

      // Held worktree enforces 409 plugin_in_use on disable('builtin:worktree') AND 409 worktree_in_use on cleanup_worktree(force: true)!
      // workflow keeps zero static dependency on worktree: disabling builtin:workflow under a live hold stays free.
      await assert.rejects(
        () => kernel.plugins.disable(WORKTREE_ID),
        (err: unknown) => err instanceof HelmxError && err.code === 'plugin_in_use' && err.status === 409,
      )
      await assert.doesNotReject(() => kernel.plugins.disable(WORKFLOW_ID))
      await kernel.plugins.enable(WORKFLOW_ID)
      await assert.rejects(
        () => kernel.plugins.invokeAction(WORKTREE_ID, 'cleanup_worktree', { worktreeId: author.worktreeId, force: true }),
        (err: unknown) =>
          err instanceof HelmxError &&
          err.code === 'worktree_in_use' &&
          err.status === 409 &&
          err.message.includes(groupId),
      )

      // Default close_group({}) without keepWorktree MUST reject unmerged branch with 409 swarm_worktree_unmerged (keeping hold intact!)
      await assert.rejects(
        () => kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId }, { conversationId: coord.id }),
        (err: unknown) => err instanceof HelmxError && err.code === 'swarm_worktree_unmerged' && err.status === 409,
      )
      await assert.rejects(
        () => kernel.plugins.invokeAction(WORKTREE_ID, 'cleanup_worktree', { worktreeId: author.worktreeId, force: true }),
        (err: unknown) => err instanceof HelmxError && err.code === 'worktree_in_use',
      )

      // Unlock-merge mode: close_group({ keepWorktree: true }) releases hold, preserves branch, and strips swarm-coordinator tag to restore bash!
      const closed = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'close_group',
        { groupId, keepWorktree: true, summary: 'Ready for coordinator merge' },
        { conversationId: coord.id },
      )) as {
        closed: boolean
        retainedWorktrees: Array<{ memberName: string; nodeId: string; worktreeId: string; branch: string; path: string; commitsAhead: number }>
      }
      assert.equal(closed.closed, true)
      assert.equal(closed.retainedWorktrees.length, 1)
      const retained = closed.retainedWorktrees[0]!
      assert.equal(retained.memberName, 'author')
      assert.equal(retained.nodeId, 'local')
      assert.equal(retained.commitsAhead, 1)
      assert.ok(existsSync(join(retained.path, 'feature.txt')))
      assert.equal(kernel.getConversation(coord.id).tags.includes(COORDINATOR_TAG), false, 'coordinator must drop swarm-coordinator tag')
      assert.equal(
        kernel.getConversation(coord.id).tags.includes(ARCHIVED_COORDINATOR_TAG),
        true,
        'closed coordinator keeps the history tag so the workbench orchestration panel stays reachable',
      )

      // Coordinator #C now has bash restored and merges the retained branch, then cleans up worktree cleanly!
      let postCloseToolNames: string[] = []
      env.faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('bash', { command: `git merge --no-edit ${retained.branch}` })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage(
          [fauxToolCall('cleanup_worktree', { worktreeId: retained.worktreeId, deleteBranch: true })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Merged and cleaned up worktree.'),
        (ctx) => {
          postCloseToolNames = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[]).toolNames
          return fauxAssistantMessage('Post-close probe done.')
        },
      ])
      await kernel.submitInput(coord.id, 'Merge retained branch and clean up')
      await kernel.waitForIdle(coord.id)

      // Trigger the post-close probe turn to capture the coordinator tool list after group close.
      await kernel.submitInput(coord.id, 'Post-close tool probe')
      await kernel.waitForIdle(coord.id)

      assert.equal(readFileSync(join(env.repoDir, 'feature.txt'), 'utf8').trim(), 'verified-payload')
      assert.equal(existsSync(retained.path), false, 'worktree directory must be removed after merge + cleanup_worktree')

      // History-tag tool semantics: after close the archived tag unlocks swarm_create_group again
      // while granting zero participant/coordinator tools (no active group, tag is UI-history only).
      assert.ok(postCloseToolNames.includes('bash'), 'coordinator bash restored after close')
      assert.ok(postCloseToolNames.includes('swarm_create_group'), 'archived coordinator may start a fresh swarm')
      assert.equal(postCloseToolNames.includes('swarm_dispatch_worker'), false, 'history tag must not resurrect squad tools')
      assert.equal(postCloseToolNames.includes('swarm_board_post'), false, 'history tag must not resurrect board tools')

      // Re-creating a group on the same conversation swaps the history tag back to the active coordinator tag.
      const recreated = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Second run',
        conversationId: coord.id,
      })) as { groupId: string }
      assert.notEqual(recreated.groupId, groupId)
      const coordTagsAfterRecreate = kernel.getConversation(coord.id).tags
      assert.equal(coordTagsAfterRecreate.includes(COORDINATOR_TAG), true, 're-created group restores the active coordinator tag')
      assert.equal(coordTagsAfterRecreate.includes(ARCHIVED_COORDINATOR_TAG), false, 'history tag is stripped on re-activation')

      // archive_worker({ keepWorktree: true }) records unmerged branch into group.retainedWorktrees and close_group preserves it
      let keptStep = 0
      env.faux.setResponses(Array.from({ length: 6 }, () => (ctx: { messages: unknown[] }) => {
        const meta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
        const sec = meta.sectionsById['swarm.active_group'] ?? ''
        if (!sec.includes('name="kept"')) return fauxAssistantMessage('Coordinator noted kept worker.')
        keptStep += 1
        if (keptStep === 1) {
          return fauxAssistantMessage(
            [fauxToolCall('bash', { command: 'printf "kept-branch\n" > kept.txt && git add kept.txt && git commit -m "feat: kept"' })],
            { stopReason: 'toolUse' },
          )
        }
        return fauxAssistantMessage(
          [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Committed kept.txt.' })],
          { stopReason: 'toolUse' },
        )
      }))
      const keptWorker = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId: recreated.groupId, name: 'kept', prompt: 'Commit kept.txt', isolation: 'worktree' },
        { conversationId: coord.id },
      )) as { workerConversationId: number; worktreeId: string }
      await kernel.waitForIdle(keptWorker.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.waitForIdle(coord.id)
      await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'archive_worker',
        { groupId: recreated.groupId, name: 'kept', keepWorktree: true },
        { conversationId: coord.id },
      )
      const statusAfterArchive = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'board_status',
        { groupId: recreated.groupId },
        { conversationId: coord.id },
      )) as BoardViewDoc
      assert.equal(statusAfterArchive.group.retainedWorktrees?.length, 1)
      assert.equal(statusAfterArchive.group.retainedWorktrees?.[0]?.worktreeId, keptWorker.worktreeId)
      assert.equal(statusAfterArchive.group.retainedWorktrees?.[0]?.nodeId, 'local')

      const secondClose = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'close_group',
        { groupId: recreated.groupId },
        { conversationId: coord.id },
      )) as { closed: boolean; retainedWorktrees: Array<{ worktreeId: string; memberName: string; nodeId: string }> }
      assert.equal(secondClose.closed, true)
      assert.equal(secondClose.retainedWorktrees.length, 1, 'close_group must preserve retainedWorktrees recorded by archive_worker({ keepWorktree: true })')
      assert.equal(secondClose.retainedWorktrees[0]?.worktreeId, keptWorker.worktreeId)
      assert.equal(secondClose.retainedWorktrees[0]?.nodeId, 'local')
      await kernel.plugins.invokeAction(WORKTREE_ID, 'cleanup_worktree', { worktreeId: keptWorker.worktreeId, force: true })
      assert.equal(kernel.getConversation(coord.id).tags.includes(ARCHIVED_COORDINATOR_TAG), true, 'closing again re-swaps to the history tag')

      // Closed group and coordinatorDetached fallback: delete coordinator #C, board_status & board_read still work!
      await kernel.deleteConversation(coord.id)
      await waitFor(async () => {
        const view = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_status', { groupId })) as BoardViewDoc
        return view.group.coordinatorDetached === true && view.group.status === 'closed'
      })
      const finalPosts = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as { posts: BoardPost[] }
      assert.ok(finalPosts.posts.length >= 4)
    } finally {
      await env.close()
    }
  })

  test('swarm-int13: builtin:workflow 停用 + builtin:worktree 启用 —— swarm 隔离派工、交接快照与释放清理完全正常（零静态依赖）', { timeout: 60_000 }, async (t) => {
    const env = await openSwarmEnv(useTempDir(t, 'helmx-swarm-no-workflow-'), gitTemplate)
    try {
      const { kernel } = env.app
      // 前置：builtin:workflow 停用（swarm 与其零静态依赖），builtin:worktree 保持启用。
      await kernel.plugins.disable(WORKFLOW_ID)
      assert.equal(kernel.plugins.list().find((p) => p.id === WORKFLOW_ID)?.enabled, false)

      const coord = await kernel.createConversation({ title: 'No-Workflow Coord', profileId: 'assistant', cwd: env.repoDir })
      const { groupId } = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'create_group',
        { title: 'Worktree-Only Squad', conversationId: coord.id },
      )) as { groupId: string }

      // 单 worker：worktree 内提交一个文件并 done（快照来自 builtin:worktree inspect）。
      let coderStep = 0
      env.faux.setResponses(Array.from({ length: 8 }, () => (ctx: { messages: unknown[] }) => {
        const meta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
        const groupSec = meta.sectionsById['swarm.active_group'] ?? ''
        if (!groupSec.includes('name="coder"')) return fauxAssistantMessage('coordinator idle')
        coderStep += 1
        if (coderStep === 1) {
          return fauxAssistantMessage(
            [fauxToolCall('bash', { command: 'printf "no-workflow-payload\n" > feature.txt && git add feature.txt && git commit -m "feat: no-workflow"' })],
            { stopReason: 'toolUse' },
          )
        }
        return fauxAssistantMessage(
          [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Committed feature.txt in isolated worktree.' })],
          { stopReason: 'toolUse' },
        )
      }))

      const coder = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { prompt: 'Commit feature.txt in your isolated worktree, then post done.', name: 'coder', access: 'readwrite', isolation: 'worktree' },
        { conversationId: coord.id },
      )) as { workerConversationId: number; worktreeId: string }
      assert.ok(typeof coder.worktreeId === 'string' && coder.worktreeId.length > 0, 'worktree 停用 workflow 时派工仍应绑定受管 worktree')

      await waitFor(async () => {
        const status = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_status', { groupId })) as BoardViewDoc
        return status.posts.some((p) => p.kind === 'done' && p.from === 'coder')
      })
      await kernel.waitForIdle(coder.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.waitForIdle(coord.id)

      // 交接快照事实来自 builtin:worktree 的权威 inspect（commitsAhead 为真实值）。
      const read = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as { posts: BoardPost[] }
      const donePost = read.posts.find((p) => p.from === 'coder' && p.kind === 'done')
      assert.ok(donePost !== undefined, 'worker done 帖应存在')
      const inspected = (await kernel.plugins.invokeAction(WORKTREE_ID, 'inspect_worktree', {
        worktreeId: coder.worktreeId,
        diff: false,
      })) as { exists: boolean; commitsAhead?: number }
      assert.equal(inspected.exists, true)
      assert.equal(inspected.commitsAhead, 1, 'worktree 内应有 1 个未合入提交')

      // 关组释放持有锁（keepWorktree 保留工作树），随后显式清理（force 覆盖未合入保护）。
      const closed = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'close_group',
        { groupId, keepWorktree: true, summary: 'Merged no-workflow squad' },
        { conversationId: coord.id },
      )) as { closed: boolean; retainedWorktrees: Array<{ worktreeId: string }> }
      assert.equal(closed.closed, true)
      assert.equal(closed.retainedWorktrees.length, 1)
      const cleaned = (await kernel.plugins.invokeAction(WORKTREE_ID, 'cleanup_worktree', {
        worktreeId: coder.worktreeId,
        force: true,
        deleteBranch: true,
      })) as { removed: boolean; branchDeleted: boolean }
      assert.equal(cleaned.removed, true, '锁释放后 cleanup_worktree 必须可清理')
      assert.equal(cleaned.branchDeleted, true)
      const afterInspect = (await kernel.plugins.invokeAction(WORKTREE_ID, 'inspect_worktree', {
        worktreeId: coder.worktreeId,
        diff: false,
      })) as { exists: boolean }
      assert.equal(afterInspect.exists, false)
    } finally {
      await env.app.kernel.plugins.enable(WORKFLOW_ID).catch(() => {})
      await env.close()
    }
  })

  test('swarm-int14: close_group force 出口 —— ignored 产物成员默认即可收尾；真实脏成员默认拒绝、force: true 放弃内容直接收尾', { timeout: 60_000 }, async (t) => {
    const env = await openSwarmEnv(useTempDir(t, 'helmx-swarm-int-'), gitTemplate)
    try {
      const { kernel } = env.app
      const repoDir = env.repoDir
      // 基线先含 .gitignore（忽略 dist/），worktree 派生自该基线。
      writeFileSync(join(repoDir, '.gitignore'), 'dist/\n')
      execFileSync('git', ['add', '.gitignore'], { cwd: repoDir })
      execFileSync('git', ['commit', '-qm', 'chore: ignore dist'], { cwd: repoDir })

      const coord = await kernel.createConversation({ title: 'Close Force Coordinator', profileId: 'assistant', cwd: repoDir })

      // ---- 动作/工具 schema 面：close_group 输入必须暴露 force（五端 CLI 映射随 manifest 派生） ----
      const closeManifest = kernel.plugins
        .listActions()
        .find((a) => a.pluginId === SWARM_PLUGIN_ID && a.id === 'close_group')
      assert.ok(closeManifest, 'close_group action manifest must exist')
      assert.ok(
        (closeManifest.inputSchema.properties as Record<string, unknown>)['force'] !== undefined,
        'close_group inputSchema 必须声明 force',
      )

      const listWorktrees = () =>
        kernel.plugins.invokeAction(WORKTREE_ID, 'list_worktrees', {}) as Promise<{
          worktrees: Array<{ id: string; path: string; status: string; hold?: unknown }>
        }>

      // ---- 场景 1：成员 worktree 只有 ignored 构建产物（模拟 pnpm build 的 dist/）----
      const groupA = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'create_group',
        { title: 'Ignored Artifacts', objective: 'Build-only artifacts', conversationId: coord.id },
      )) as { groupId: string }
      setSwarmRoleResponses(env.faux, {
        builder: [fauxAssistantMessage('Built artifacts and finished.')],
        coordinator: [fauxAssistantMessage('Noted.')],
      })
      const builder = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { prompt: 'Run build then finish.', name: 'builder', access: 'readwrite', isolation: 'worktree' },
        { conversationId: coord.id },
      )) as { workerConversationId: number; worktreeId: string }
      await kernel.waitForIdle(builder.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.waitForIdle(coord.id)

      const builderRecord = (await listWorktrees()).worktrees.find((w) => w.id === builder.worktreeId)
      assert.ok(builderRecord, 'builder worktree record must exist')
      mkdirSync(join(builderRecord.path, 'dist'), { recursive: true })
      writeFileSync(join(builderRecord.path, 'dist', 'bundle.js'), 'console.log(1)\n')

      // 修复后口径：ignored 产物不再阻断——close_group 默认（无 force）即可收尾。
      const closedA = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'close_group',
        { groupId: groupA.groupId },
        { conversationId: coord.id },
      )) as { closed: boolean; retainedWorktrees: unknown[] }
      assert.equal(closedA.closed, true)
      assert.equal(closedA.retainedWorktrees.length, 0)
      assert.equal(existsSync(builderRecord.path), false, 'ignored-only worktree 应随默认结单被清理')
      assert.equal(
        (await listWorktrees()).worktrees.find((w) => w.id === builder.worktreeId)?.status,
        'removed',
      )

      // ---- 场景 2：成员 worktree 含未跟踪非 ignored 文件（真实脏）----
      const groupB = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'create_group',
        { title: 'Dirty Draft', objective: 'Uncommitted draft', conversationId: coord.id },
      )) as { groupId: string }
      setSwarmRoleResponses(env.faux, {
        author: [fauxAssistantMessage('Draft ready.')],
        coordinator: [fauxAssistantMessage('Noted again.')],
      })
      const author = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { prompt: 'Draft then finish.', name: 'author', access: 'readwrite', isolation: 'worktree' },
        { conversationId: coord.id },
      )) as { workerConversationId: number; worktreeId: string }
      await kernel.waitForIdle(author.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.waitForIdle(coord.id)

      const authorRecord = (await listWorktrees()).worktrees.find((w) => w.id === author.worktreeId)
      assert.ok(authorRecord, 'author worktree record must exist')
      writeFileSync(join(authorRecord.path, 'draft.txt'), 'uncommitted draft\n')

      // 默认（force 缺省 false）：真实脏内容仍拒绝（swarm_worktree_unmerged，hold 保持）。
      await assert.rejects(
        () => kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId: groupB.groupId }, { conversationId: coord.id }),
        (err: unknown) => err instanceof HelmxError && err.code === 'swarm_worktree_unmerged' && err.status === 409,
      )
      await assert.rejects(
        () => kernel.plugins.invokeAction(WORKTREE_ID, 'cleanup_worktree', { worktreeId: author.worktreeId, force: true }),
        (err: unknown) => err instanceof HelmxError && err.code === 'worktree_in_use',
        '默认拒绝后 hold 必须保持（force 不可绕过占用）',
      )

      // force: true：只放开脏/未合入守卫，直接收尾并清理成员 worktree。
      const closedB = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'close_group',
        { groupId: groupB.groupId, force: true },
        { conversationId: coord.id },
      )) as { closed: boolean; retainedWorktrees: unknown[] }
      assert.equal(closedB.closed, true)
      assert.equal(closedB.retainedWorktrees.length, 0)
      assert.equal(existsSync(authorRecord.path), false, 'force 结单应清理脏 worktree（git worktree remove --force）')
      assert.equal(
        (await listWorktrees()).worktrees.find((w) => w.id === author.worktreeId)?.status,
        'removed',
      )
    } finally {
      await env.close()
    }
  })

  test('swarm-int7: real SIGKILL mid-turn resumes streaming worktree worker with zero duplicate input, keeps worktree active, and cleans up on close_group', { timeout: 60_000 }, async (t) => {
    const root = useTempDir(t, 'helmx-swarm-sigkill-worker-')
    const dataDir = join(root, 'data')
    const repoDir = join(root, 'repo')
    gitTemplate.cloneTo(repoDir)

    const seederScript = `
      import { writeSync } from 'node:fs'
      import { createPluginBuildProvider } from ${JSON.stringify(PLUGIN_BUILD_URL)}
      import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(PI_AI_FAUX_URL)}
      import { createHelmx } from ${JSON.stringify(HUB_APP_URL)}

      const faux = fauxProvider({
        models: [{ id: 'faux-1' }],
        tokensPerSecond: 2,
        tokenSize: { min: 1, max: 1 },
      })
      faux.setResponses([
        fauxAssistantMessage('这是一段Swarm成员在隔离worktree中慢速流式执行任务确保被真实SIGKILL中断的输出内容'),
      ])
      const app = await createHelmx({
        buildProvider: createPluginBuildProvider(),
        dataDir: ${JSON.stringify(dataDir)},
        cwd: ${JSON.stringify(repoDir)},
        model: 'faux/faux-1',
        providers: [faux.provider],
      })
      const coord = await app.kernel.createConversation({
        title: 'Kill Worker Coord',
        profileId: 'assistant',
        cwd: ${JSON.stringify(repoDir)},
      })
      const { groupId } = await app.kernel.plugins.invokeAction(
        'builtin:swarm',
        'create_group',
        { title: 'Kill Recovery Squad', conversationId: coord.id },
      ) as { groupId: string }
      const worker = await app.kernel.plugins.invokeAction(
        'builtin:swarm',
        'dispatch_worker',
        { prompt: 'Execute task inside isolated worktree and post done.', name: 'coder', isolation: 'worktree' },
        { conversationId: coord.id },
      ) as { workerConversationId: number }

      for (let i = 0; i < 400; i += 1) {
        await new Promise((r) => setTimeout(r, 10))
        if (
          faux.state.callCount >= 1 &&
          app.kernel.getConversation(worker.workerConversationId).status === 'working'
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
    const { stdout } = await spawnSigkillSeeder(t, root, 'seed-worker-kill.mts', seederScript)
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

    const app = await createHelmx({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: repoDir,
      model: 'faux/faux-1',
      providers: [faux.provider],
    })
    try {
      try {
        await waitFor(
          () =>
            isSettledStatus(app.kernel.getConversation(seeded.workerId).status) &&
            isSettledStatus(app.kernel.getConversation(seeded.coordId).status) &&
            app.kernel.getConversation(seeded.workerId).completionSeq >= 1 &&
            app.kernel.getConversation(seeded.coordId).completionSeq >= 1 &&
            app.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0,
          { timeoutMs: 8_000 },
        )
      } catch (err) {
        const wSummary = app.kernel.getConversation(seeded.workerId)
        const cSummary = app.kernel.getConversation(seeded.coordId)
        const wDetail = await app.kernel.getConversationDetail(seeded.workerId, { limit: 20 })
        const cDetail = await app.kernel.getConversationDetail(seeded.coordId, { limit: 20 })
        throw new Error(
          `${(err as Error).message}\nworker=${JSON.stringify(wSummary)}\ncoord=${JSON.stringify(cSummary)}\nwEntries=${JSON.stringify(wDetail.entries)}\ncEntries=${JSON.stringify(cDetail.entries)}`,
        )
      }
      await app.kernel.waitForIdle(seeded.workerId)
      await app.kernel.waitForIdle(seeded.coordId)

      // Worktree stayed alive during recovery and cleanup runs cleanly on close_group.
      const inspectedBeforeClose = (await app.kernel.plugins.invokeAction('builtin:worktree', 'inspect_worktree', {
        worktreeId: preCoder.worktreeId,
        diff: false,
      })) as { exists: boolean }
      assert.equal(inspectedBeforeClose.exists, true)

      const workerDetail = await app.kernel.getConversationDetail(seeded.workerId, { limit: 50 })
      const workerInputs = workerDetail.entries.filter((e) => e.kind === 'helmx.input')
      assert.equal(workerInputs.length, 1, `expected 1 deduplicated wakeup input, got ${workerInputs.length}`)

      const read = (await app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId: seeded.groupId })) as {
        posts: BoardPost[]
      }
      assert.equal(read.posts.filter((p) => p.from === 'system').length, 0)
      assert.equal(read.posts.filter((p) => p.kind === 'done' && p.from === 'coder').length, 1)

      const coordDetail = await app.kernel.getConversationDetail(seeded.coordId, { limit: 50 })
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
      assert.equal(app.kernel.getConversation(seeded.coordId).tags.includes(ARCHIVED_COORDINATOR_TAG), true)
      assert.equal(app.kernel.getConversation(seeded.coordId).tags.includes(COORDINATOR_TAG), false)
      assert.equal(app.kernel.getConversation(seeded.workerId).tags.includes(ARCHIVED_WORKER_TAG), true)
      assert.equal(app.kernel.getConversation(seeded.workerId).tags.includes(WORKER_TAG), false)
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
      const issued = await kernel.issueNodeToken('remote-wt-node')
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

      const coord = await kernel.createConversation({
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

      await kernel.waitForIdle(workerA.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.waitForIdle(coord.id)

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

      await kernel.waitForIdle(workerB.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.waitForIdle(coord.id)

      assert.ok(workerA.worktreeId.startsWith('remote-wt-node:'), `workerA worktreeId should target remote-wt-node: ${workerA.worktreeId}`)
      assert.ok(workerB.worktreeId.startsWith('remote-wt-node:'), `workerB worktreeId should target remote-wt-node: ${workerB.worktreeId}`)
      const wtPathA = workerA.worktreeId.slice('remote-wt-node:'.length)
      const wtPathB = workerB.worktreeId.slice('remote-wt-node:'.length)

      const convA = kernel.getConversation(workerA.workerConversationId)
      const convB = kernel.getConversation(workerB.workerConversationId)
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
