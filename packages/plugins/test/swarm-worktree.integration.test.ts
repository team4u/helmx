/**
 * `builtin:swarm` Worktree 隔离、交接快照、持有锁与收尾恢复组合层集成测试（Integration 档）：
 * 1) Author(worktree) + Verifier(readonly) 真实 Git Worktree 交接快照、空闲期 ManagedWorktreeHold
 *    防删与阻塞 worktree 停用、两态 close_group(409 vs keepWorktree 保留合入、历史 tag 切换) 与 closed/detached 读取；
 * 2) builtin:workflow 停用 + builtin:worktree 启用时的零静态依赖隔离派工与清理；
 * 3) close_group force 出口（ignored 构建产物默认可收尾、真实脏成员默认拒绝、force: true 强制清理）；
 * 4) 真实子进程 SIGKILL 中断 worktree 成员生成 -> 重启无缝续跑、保留 worktree 并正常关组回收。
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'

import { HelmxError } from '@helmx/protocol'
import {
  createGitTemplate,
  useTempDir,
  waitFor,
} from './helpers/plugin-test-env.js'
import {
  WORKFLOW_ID,
  WORKTREE_ID,
  captureRequestMeta,
  openSwarmEnv,
  setSwarmRoleResponses,
  type SwarmTestEnv,
} from './helpers/swarm-integration-env.js'
import {
  ARCHIVED_COORDINATOR_TAG,
  COORDINATOR_TAG,
  SWARM_PLUGIN_ID,
  type BoardBadgesDoc,
  type BoardPost,
  type BoardViewDoc,
} from '../src/swarm.js'

describe('builtin:swarm worktree isolation, handoff & close_group recovery', { concurrency: 2, timeout: 60_000 }, () => {
  const gitTemplate = createGitTemplate()
  after(() => gitTemplate.cleanup(), { timeout: 60_000 })

  describe('shared worktree runtime', { concurrency: false, timeout: 60_000 }, () => {
    let sharedRoot = ''
    let sharedEnv: SwarmTestEnv | undefined

    before(async () => {
      sharedRoot = mkdtempSync(join(tmpdir(), 'helmx-swarm-wt-shared-'))
      sharedEnv = await openSwarmEnv(sharedRoot, gitTemplate)
    }, { timeout: 60_000 })

    after(async () => {
      await sharedEnv?.close().catch(() => {})
      if (sharedRoot) rmSync(sharedRoot, { recursive: true, force: true })
    }, { timeout: 60_000 })

  test('swarm-int2: Author(worktree) + Verifier(readonly) handoff, hold blocks workflow disable & cleanup_worktree, two-mode close_group retain & merge, and closed/detached board_status', { timeout: 60_000 }, async (t) => {
    const env = sharedEnv!
    const repoDir = gitTemplate.cloneTo(join(useTempDir(t, 'helmx-swarm-int2-repo-'), 'repo'))
    try {
      const { kernel } = env.app
      const coord = await kernel.conversations.createConversation({ title: 'Release Coordinator', profileId: 'assistant', cwd: repoDir })

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
      await kernel.conversations.waitForIdle(verifier.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

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
      await kernel.conversations.waitForIdle(author.workerConversationId)
      await kernel.conversations.waitForIdle(verifier.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

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
      const coordDetail = await kernel.conversations.getConversationDetail(coord.id, { limit: 20 })
      assert.match(JSON.stringify(coordDetail.entries), /swarm:board-report/)
      const verifierDetail = await kernel.conversations.getConversationDetail(verifier.workerConversationId, { limit: 20 })
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
      assert.equal(kernel.conversations.getConversation(coord.id).tags.includes(COORDINATOR_TAG), false, 'coordinator must drop swarm-coordinator tag')
      assert.equal(
        kernel.conversations.getConversation(coord.id).tags.includes(ARCHIVED_COORDINATOR_TAG),
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
      await kernel.conversations.submitInput(coord.id, 'Merge retained branch and clean up')
      await kernel.conversations.waitForIdle(coord.id)

      // Trigger the post-close probe turn to capture the coordinator tool list after group close.
      await kernel.conversations.submitInput(coord.id, 'Post-close tool probe')
      await kernel.conversations.waitForIdle(coord.id)

      assert.equal(readFileSync(join(repoDir, 'feature.txt'), 'utf8').trim(), 'verified-payload')
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
      const coordTagsAfterRecreate = kernel.conversations.getConversation(coord.id).tags
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
        if (keptStep === 2) {
          return fauxAssistantMessage(
            [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Committed kept.txt.' })],
            { stopReason: 'toolUse' },
          )
        }
        return fauxAssistantMessage('Kept worker finished.')
      }))
      const keptWorker = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId: recreated.groupId, name: 'kept', prompt: 'Commit kept.txt', isolation: 'worktree' },
        { conversationId: coord.id },
      )) as { workerConversationId: number; worktreeId: string }
      await kernel.conversations.waitForIdle(keptWorker.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)
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
      assert.equal(kernel.conversations.getConversation(coord.id).tags.includes(ARCHIVED_COORDINATOR_TAG), true, 'closing again re-swaps to the history tag')

      // Closed group and coordinatorDetached fallback: delete coordinator #C, board_status & board_read still work!
      await kernel.conversations.deleteConversation(coord.id)
      await waitFor(async () => {
        const view = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_status', { groupId })) as BoardViewDoc
        return view.group.coordinatorDetached === true && view.group.status === 'closed'
      })
      const finalPosts = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as { posts: BoardPost[] }
      assert.ok(finalPosts.posts.length >= 4)
    } finally {
      env.faux.setResponses([])
    }
  })

  test('swarm-int13: builtin:workflow 停用 + builtin:worktree 启用 —— swarm 隔离派工、交接快照与释放清理完全正常（零静态依赖）', { timeout: 60_000 }, async (t) => {
    const env = sharedEnv!
    const repoDir = gitTemplate.cloneTo(join(useTempDir(t, 'helmx-swarm-no-workflow-repo-'), 'repo'))
    try {
      const { kernel } = env.app
      // 前置：builtin:workflow 停用（swarm 与其零静态依赖），builtin:worktree 保持启用。
      await kernel.plugins.disable(WORKFLOW_ID)
      assert.equal(kernel.plugins.list().find((p) => p.id === WORKFLOW_ID)?.enabled, false)

      const coord = await kernel.conversations.createConversation({ title: 'No-Workflow Coord', profileId: 'assistant', cwd: repoDir })
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
        if (coderStep === 2) {
          return fauxAssistantMessage(
            [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Committed feature.txt in isolated worktree.' })],
            { stopReason: 'toolUse' },
          )
        }
        return fauxAssistantMessage('Coder finished.')
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
      await kernel.conversations.waitForIdle(coder.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

      // 交接快照事实来自 builtin:worktree 的权威 inspect（commitsAhead 为真实值）。
      const read = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as { posts: BoardPost[] }
      const donePost = read.posts.find((p) => p.from === 'coder' && p.kind === 'done')
      assert.ok(donePost !== undefined, 'worker done 帖应存在')
      const inspected = (await kernel.plugins.invokeAction(WORKTREE_ID, 'inspect_worktree', {
        worktreeId: coder.worktreeId,
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
      })) as { exists: boolean }
      assert.equal(afterInspect.exists, false)
    } finally {
      await env.app.kernel.plugins.enable(WORKFLOW_ID).catch(() => {})
      env.faux.setResponses([])
    }
  })

  test('swarm-int14: close_group force 出口 —— ignored 产物成员默认即可收尾；真实脏成员默认拒绝、force: true 放弃内容直接收尾', { timeout: 60_000 }, async (t) => {
    const env = sharedEnv!
    const repoDir = gitTemplate.cloneTo(join(useTempDir(t, 'helmx-swarm-int14-repo-'), 'repo'))
    try {
      const { kernel } = env.app
      // 基线先含 .gitignore（忽略 dist/），worktree 派生自该基线。
      writeFileSync(join(repoDir, '.gitignore'), 'dist/\n')
      execFileSync('git', ['add', '.gitignore'], { cwd: repoDir })
      execFileSync('git', ['commit', '-qm', 'chore: ignore dist'], { cwd: repoDir })

      const coord = await kernel.conversations.createConversation({ title: 'Close Force Coordinator', profileId: 'assistant', cwd: repoDir })

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
      await kernel.conversations.waitForIdle(builder.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

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
      await kernel.conversations.waitForIdle(author.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

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
      env.faux.setResponses([])
    }
  })

  test('swarm-int20: archive_worker & close_group never leak ManagedWorktreeHold when cleanup_worktree fails (e.g. worktree_locked)', { timeout: 60_000 }, async (t) => {
    const env = sharedEnv!
    const repoDir = gitTemplate.cloneTo(join(useTempDir(t, 'helmx-swarm-hold-atomicity-repo-'), 'repo'))
    try {
      const { kernel } = env.app
      const coord = await kernel.conversations.createConversation({ title: 'Hold Atomicity Coord', profileId: 'assistant', cwd: repoDir })
      const g = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Hold Atomicity Squad',
        conversationId: coord.id,
      })) as { groupId: string }

      setSwarmRoleResponses(env.faux, {
        locked_w: [fauxAssistantMessage('Done.')],
        coordinator: [fauxAssistantMessage('Noted.')],
      })
      const worker = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId: g.groupId, name: 'locked_w', prompt: 'Finish.', access: 'readwrite', isolation: 'worktree' },
        { conversationId: coord.id },
      )) as { workerConversationId: number; worktreeId: string }
      await kernel.conversations.waitForIdle(worker.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

      const wtPath = worker.worktreeId.slice('local:'.length)
      execFileSync('git', ['worktree', 'lock', '--reason', 'manual hold test', wtPath], { cwd: repoDir })

      await assert.rejects(
        () => kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'archive_worker', { groupId: g.groupId, name: 'locked_w' }, { conversationId: coord.id }),
        (err: unknown) => err instanceof HelmxError && err.code === 'worktree_locked',
      )
      await assert.rejects(
        () => kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId: g.groupId }, { conversationId: coord.id }),
        (err: unknown) => err instanceof HelmxError && err.code === 'worktree_locked',
      )

      const listed = (await kernel.plugins.invokeAction(WORKTREE_ID, 'list_worktrees', {})) as {
        worktrees: Array<{ id: string; status: string; hold?: { pluginId: string } }>
      }
      assert.equal(listed.worktrees.find((w) => w.id === worker.worktreeId)?.hold?.pluginId, SWARM_PLUGIN_ID, 'hold must stay intact after failed cleanup')

      await assert.rejects(
        () => kernel.plugins.invokeAction(WORKTREE_ID, 'cleanup_worktree', { worktreeId: worker.worktreeId, force: true }),
        (err: unknown) => err instanceof HelmxError && err.code === 'worktree_in_use',
        'external cleanup must still see the intact hold',
      )

      execFileSync('git', ['worktree', 'unlock', wtPath], { cwd: repoDir })
      const closed = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId: g.groupId }, { conversationId: coord.id })) as {
        closed: boolean
        uncleanedWorktrees?: Array<{ worktreeId: string }>
      }
      assert.equal(closed.closed, true)
      if (closed.uncleanedWorktrees?.length) {
        await kernel.plugins.invokeAction(WORKTREE_ID, 'cleanup_worktree', {
          worktreeId: worker.worktreeId,
          deleteBranch: true,
          allowUnverifiedUsage: true,
        })
      }
    } finally {
      env.faux.setResponses([])
    }
  })
  })

  test('swarm-int19: simulated non-Linux hubPlatform=darwin close_group & archive_worker settle holds and report uncleanedWorktrees without false unmerged entries, while allowUnverifiedUsage cleans immediately', { timeout: 60_000 }, async (t) => {
    const env = await openSwarmEnv(useTempDir(t, 'helmx-swarm-nonlinux-'), gitTemplate, {
      hubPlatform: () => 'darwin',
    })
    try {
      const { kernel } = env.app
      const coord = await kernel.conversations.createConversation({ title: 'Win32 Close Coord', profileId: 'assistant', cwd: env.repoDir })

      // 1) Clean member + default close_group(): closes cleanly, releases hold, leaves retainedWorktrees empty, populates uncleanedWorktrees
      const g1 = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Win32 Clean Close',
        conversationId: coord.id,
      })) as { groupId: string }
      setSwarmRoleResponses(env.faux, {
        worker_a: [fauxAssistantMessage('Done without local edits.')],
        coordinator: [fauxAssistantMessage('Noted.')],
      })
      const w1 = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId: g1.groupId, name: 'worker_a', prompt: 'Inspect code.', access: 'readwrite', isolation: 'worktree' },
        { conversationId: coord.id },
      )) as { workerConversationId: number; worktreeId: string }
      await kernel.conversations.waitForIdle(w1.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

      const closed1 = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'close_group',
        { groupId: g1.groupId },
        { conversationId: coord.id },
      )) as {
        closed: boolean
        retainedWorktrees: unknown[]
        uncleanedWorktrees?: Array<{ memberName: string; worktreeId: string; reason: string; path: string }>
      }
      assert.equal(closed1.closed, true)
      assert.deepEqual(closed1.retainedWorktrees, [], 'clean uncleaned worktree must NOT pollute retainedWorktrees')
      assert.equal(closed1.uncleanedWorktrees?.length, 1)
      assert.equal(closed1.uncleanedWorktrees?.[0]?.worktreeId, w1.worktreeId)
      assert.equal(closed1.uncleanedWorktrees?.[0]?.reason, 'usage_unverifiable')
      assert.equal(existsSync(closed1.uncleanedWorktrees![0]!.path), true)

      const listAfterClose1 = (await kernel.plugins.invokeAction(WORKTREE_ID, 'list_worktrees', {})) as {
        worktrees: Array<{ id: string; status: string; hold?: unknown }>
      }
      assert.equal(listAfterClose1.worktrees.find((w) => w.id === w1.worktreeId)?.hold, undefined, 'hold must be released')

      await assert.rejects(
        () => kernel.plugins.invokeAction(WORKTREE_ID, 'cleanup_worktree', { worktreeId: w1.worktreeId, deleteBranch: true }),
        (err: unknown) => err instanceof HelmxError && err.code === 'worktree_usage_unverifiable' && err.status === 501,
      )
      const manualCleaned = (await kernel.plugins.invokeAction(WORKTREE_ID, 'cleanup_worktree', {
        worktreeId: w1.worktreeId,
        deleteBranch: true,
        allowUnverifiedUsage: true,
      })) as { removed: boolean; branchDeleted: boolean; processUsage?: string }
      assert.equal(manualCleaned.removed, true)
      assert.equal(manualCleaned.branchDeleted, true)
      assert.equal(manualCleaned.processUsage, 'unverified')

      // 2) Mixed group (1 unmerged + 1 clean) + close_group({ keepWorktree: true })
      const g2 = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Win32 Mixed Keep',
        conversationId: coord.id,
      })) as { groupId: string }
      setSwarmRoleResponses(env.faux, {
        dirty_w: [fauxAssistantMessage('Made unmerged commit.')],
        clean_w: [fauxAssistantMessage('Read-only check.')],
        coordinator: [fauxAssistantMessage('Noted.')],
      })
      const dirtyW = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId: g2.groupId, name: 'dirty_w', prompt: 'Commit work.', access: 'readwrite', isolation: 'worktree' },
        { conversationId: coord.id },
      )) as { workerConversationId: number; worktreeId: string }
      const cleanW = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId: g2.groupId, name: 'clean_w', prompt: 'Check only.', access: 'readwrite', isolation: 'worktree' },
        { conversationId: coord.id },
      )) as { workerConversationId: number; worktreeId: string }
      await kernel.conversations.waitForIdle(dirtyW.workerConversationId)
      await kernel.conversations.waitForIdle(cleanW.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

      const dirtyPath = dirtyW.worktreeId.slice('local:'.length)
      writeFileSync(join(dirtyPath, 'feature-win32.txt'), 'change\n')
      execFileSync('git', ['add', 'feature-win32.txt'], { cwd: dirtyPath })
      execFileSync('git', ['commit', '-qm', 'feat: win32 unmerged'], { cwd: dirtyPath })

      const closed2 = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'close_group',
        { groupId: g2.groupId, keepWorktree: true },
        { conversationId: coord.id },
      )) as {
        closed: boolean
        retainedWorktrees: Array<{ memberName: string; worktreeId: string; commitsAhead: number }>
        uncleanedWorktrees?: Array<{ memberName: string; worktreeId: string; reason: string }>
      }
      assert.equal(closed2.closed, true)
      assert.equal(closed2.retainedWorktrees.length, 1)
      assert.equal(closed2.retainedWorktrees[0]?.memberName, 'dirty_w')
      assert.equal(closed2.uncleanedWorktrees?.length, 1)
      assert.equal(closed2.uncleanedWorktrees?.[0]?.memberName, 'clean_w')

      // 3) close_group({ allowUnverifiedUsage: true }) cleans immediately
      const g3 = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Win32 Explicit Clean Close',
        conversationId: coord.id,
      })) as { groupId: string }
      setSwarmRoleResponses(env.faux, {
        explicit_w: [fauxAssistantMessage('Done.')],
        coordinator: [fauxAssistantMessage('Noted.')],
      })
      const explicitW = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId: g3.groupId, name: 'explicit_w', prompt: 'Check.', access: 'readwrite', isolation: 'worktree' },
        { conversationId: coord.id },
      )) as { workerConversationId: number; worktreeId: string }
      await kernel.conversations.waitForIdle(explicitW.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

      const closed3 = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'close_group',
        { groupId: g3.groupId, allowUnverifiedUsage: true },
        { conversationId: coord.id },
      )) as { closed: boolean; retainedWorktrees: unknown[]; uncleanedWorktrees?: unknown[] }
      assert.equal(closed3.closed, true)
      assert.deepEqual(closed3.retainedWorktrees, [])
      assert.equal(closed3.uncleanedWorktrees, undefined)
      assert.equal(existsSync(explicitW.worktreeId.slice('local:'.length)), false)

      // 4) archive_worker without keepWorktree returns uncleanedWorktree & releases hold; allowUnverifiedUsage cleans immediately
      const g4 = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Win32 Archive Worker',
        conversationId: coord.id,
      })) as { groupId: string }
      setSwarmRoleResponses(env.faux, {
        arch_a: [fauxAssistantMessage('Done A.')],
        arch_b: [fauxAssistantMessage('Done B.')],
        coordinator: [fauxAssistantMessage('Noted.')],
      })
      const archA = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId: g4.groupId, name: 'arch_a', prompt: 'Check A.', access: 'readwrite', isolation: 'worktree' },
        { conversationId: coord.id },
      )) as { workerConversationId: number; worktreeId: string }
      const archB = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId: g4.groupId, name: 'arch_b', prompt: 'Check B.', access: 'readwrite', isolation: 'worktree' },
        { conversationId: coord.id },
      )) as { workerConversationId: number; worktreeId: string }
      await kernel.conversations.waitForIdle(archA.workerConversationId)
      await kernel.conversations.waitForIdle(archB.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

      const resArchA = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'archive_worker',
        { groupId: g4.groupId, name: 'arch_a' },
        { conversationId: coord.id },
      )) as { archived: boolean; uncleanedWorktree?: { worktreeId: string; reason: string } }
      assert.equal(resArchA.archived, true)
      assert.equal(resArchA.uncleanedWorktree?.worktreeId, archA.worktreeId)
      assert.equal(resArchA.uncleanedWorktree?.reason, 'usage_unverifiable')
      assert.equal(existsSync(archA.worktreeId.slice('local:'.length)), true)

      const resArchB = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'archive_worker',
        { groupId: g4.groupId, name: 'arch_b', allowUnverifiedUsage: true },
        { conversationId: coord.id },
      )) as { archived: boolean; uncleanedWorktree?: unknown }
      assert.equal(resArchB.archived, true)
      assert.equal(resArchB.uncleanedWorktree, undefined)
      assert.equal(existsSync(archB.worktreeId.slice('local:'.length)), false)

      // Clean up leftover win32 test worktrees
      for (const wtId of [dirtyW.worktreeId, cleanW.worktreeId, archA.worktreeId]) {
        await kernel.plugins.invokeAction(WORKTREE_ID, 'cleanup_worktree', {
          worktreeId: wtId,
          force: true,
          deleteBranch: true,
          allowUnverifiedUsage: true,
        })
      }
    } finally {
      await env.close()
    }
  })
})
