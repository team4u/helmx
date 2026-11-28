/**
 * `builtin:swarm` 黑板路由、正交唤醒、回合结算与自愈守卫组合层集成测试（Integration 档）：
 * 1) forkFrom 干净锚点热分叉、直接成员寻址、被动留言(wake: false)与合并唤醒、
 *    abort_worker 原地刹车、switch_worker_model 原地切模、inspect_worker 与 @ 幂等补全；
 * 2) 回合 failed 自动上板 [blocker]、防哑巴退场单次续催 -> 二次命中代发 [blocker]、
 *    6 条件 0-Token 根因 [stall] 守卫与 Hub 重启补发未送达信封；
 * 3) 多工具轮成员回合的精确结算（回归 handOver 误判）；
 * 4) done 非竞态补报、失败回合排队唤醒送达、活跃成员删锁与停用期对账；
 * 5) 主控分层唤醒（review 越过长跑成员、无唤醒 done 触发 stall、inflightReport 权威恢复、跨重启补报）；
 * 6) 唤醒投递游标推进与回合结算竞态：回合先结算时已结算的 inflight 唤醒先归并，静默退场续催与兜底 [blocker] 不被吞掉。
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai/providers/faux'

import { HelmxError } from '@helmx/protocol'
import { KernelRuntime } from '@helmx/kernel'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { actionToolResult } from '@helmx/kernel/testing'
import {
  PLANNING_ORCHESTRATION_TOOLS_CAPABILITY_ID,
  type PlanningOrchestrationToolsCapability,
} from '../src/contracts.js'
import {
  createGitTemplate,
  deferred,
  makeFauxProvider,
  useTempDir,
  waitFor,
  type FauxProviderHandle,
} from './helpers/plugin-test-env.js'
import {
  WORKFLOW_ID,
  WORKTREE_ID,
  captureRequestMeta,
  openSwarmEnv,
  openSwarmRuntime,
  setSwarmRoleResponses,
  type SwarmTestEnv,
} from './helpers/swarm-integration-env.js'
import { createCollabGroupRuntime } from '../src/swarm/group-store.js'
import type { CollabGroupRuntime } from '../src/swarm/contracts.js'
import { FORKED_CHILD_CONTEXT_GUIDANCE } from '../src/shared-helpers.js'
import {
  ORCHESTRATOR_EXECUTE_SECTION_ID,
  ORCHESTRATOR_PLAN_SECTION_ID,
  ORCHESTRATOR_PLUGIN_ID,
  createOrchestratorPlugin,
} from '../src/orchestrator.js'
import { createProfilePlugin } from '../src/profile.js'
import { TIERS_PLUGIN_ID, createTiersPlugin } from '../src/tiers.js'
import { createWorkflowPlugin } from '../src/workflow.js'
import { createWorktreePlugin } from '../src/worktree.js'
import {
  SWARM_PLUGIN_ID,
  SWARM_TOOL_NAMES,
  WORKER_TAG,
  createSwarmPlugin,
  resolveSwarmConfig,
  type BoardPost,
  type BoardViewDoc,
  type CollabGroupRecord,
} from '../src/swarm.js'

// 跨多个真实模型回合的链式等待（dispatch → 回合 → 续催/主控唤醒）：CI 在 4 vCPU 上并发 ~28 分片，
// 链路可超过 waitFor 默认 5s；与 workflow/subagent 测试的链式等待惯例一致。
const CHAIN_WAIT_MS = 20_000

describe('builtin:swarm board routing, settlement & self-healing', { concurrency: 2, timeout: 60_000 }, () => {
  const gitTemplate = createGitTemplate()
  after(() => gitTemplate.cleanup(), { timeout: 60_000 })

  describe('shared routing runtime', { concurrency: false, timeout: 60_000 }, () => {
    let sharedRoot = ''
    let sharedEnv: SwarmTestEnv | undefined

    before(async () => {
      sharedRoot = mkdtempSync(join(tmpdir(), 'helmx-swarm-routing-shared-'))
      sharedEnv = await openSwarmEnv(sharedRoot, gitTemplate)
    }, { timeout: 60_000 })

    after(async () => {
      await sharedEnv?.close().catch(() => {})
      if (sharedRoot) rmSync(sharedRoot, { recursive: true, force: true })
    }, { timeout: 60_000 })

  test('swarm-int3: forkFrom clean anchor, direct targeting & passive wake=false coalescing, abort_worker brake, switch_worker_model, inspect_worker, and @ completions', { timeout: 60_000 }, async () => {
    const env = sharedEnv!
    try {
      const { kernel } = env.app
      const coord = await kernel.conversations.createConversation({ title: 'Context Coordinator', profileId: 'assistant', cwd: env.repoDir })

      // Seed real history on coordinator before forking
      env.faux.setResponses([fauxAssistantMessage('Architecture context: token format is v3-hmac.')])
      await kernel.conversations.submitInput(coord.id, 'Remember architecture token format v3-hmac')
      await kernel.conversations.waitForIdle(coord.id)

      const { groupId } = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Fork & Routing Squad',
        conversationId: coord.id,
      })) as { groupId: string }

      // Dispatch forked worker (forkFrom: 'coordinator' without explicit entryId)
      let forkedSawHistory = false
      setSwarmRoleResponses(env.faux, {
        coder: [
          (ctx) => {
            forkedSawHistory = JSON.stringify(ctx.messages).includes('v3-hmac')
            return fauxAssistantMessage([fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'comment', body: 'forked ready' })], {
              stopReason: 'toolUse',
            })
          },
          fauxAssistantMessage('Forked worker parked.'),
        ],
        coordinator: [fauxAssistantMessage('Coordinator noted forked worker stall.')],
      })
      const coder = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { prompt: 'Stand by with forked context.', name: 'coder', forkFrom: 'coordinator' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }
      await kernel.conversations.waitForIdle(coder.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)
      assert.equal(forkedSawHistory, true, 'forkFrom="coordinator" must inherit clean parent conversation history')
      assert.deepEqual(kernel.conversations.getConversation(coder.workerConversationId).tags, [WORKER_TAG], 'forked worker must have swarm-worker tag only')

      // Verify inspect_worker & @ completion action
      const inspected = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'inspect_worker',
        { groupId, name: 'coder' },
        { conversationId: coord.id },
      )) as { conversationId: number; name: string; groupId: string }
      assert.equal(inspected.conversationId, coder.workerConversationId)
      assert.equal(inspected.name, 'coder')
      assert.equal(inspected.groupId, groupId)

      const atItems = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'complete_board_members',
        { query: 'cod', conversationId: coord.id },
        { conversationId: coord.id },
      )) as { items: Array<{ id: string }> }
      assert.deepEqual(atItems.items.map((i) => i.id), ['coder'])

      // Passive comment (wake: false default) MUST NOT wake idle coder
      const beforeCompletionSeq = kernel.conversations.getConversation(coder.workerConversationId).completionSeq
      const statusBeforePassive = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_status', { groupId })) as BoardViewDoc
      const coderBefore = statusBeforePassive.members.find((m) => m.name === 'coder')!
      const commentRes = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_post', {
        groupId,
        to: ['coder'],
        kind: 'comment',
        body: 'Passive heads-up note #A',
      })) as { post: BoardPost }
      assert.equal(commentRes.post.wake, false)
      await Promise.resolve()
      assert.equal(kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID), 0, 'passive comment must not schedule any wakeup task')
      const statusAfterPassive = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_status', { groupId })) as BoardViewDoc
      const coderAfter = statusAfterPassive.members.find((m) => m.name === 'coder')!
      assert.equal(coderAfter.pendingWakeupSeq, coderBefore.pendingWakeupSeq, 'passive comment must not advance pendingWakeupSeq')
      assert.equal(coderAfter.liveState, 'idle')
      await kernel.conversations.waitForIdle(coder.workerConversationId)
      assert.equal(
        kernel.conversations.getConversation(coder.workerConversationId).completionSeq,
        beforeCompletionSeq,
        'comment(wake=false) must not wake an idle member',
      )

      // Subsequent wake=true handoff sweeps BOTH the passive comment AND the handoff into one wakeup!
      let sweptPrompt = ''
      const slowGate = deferred<void>()
      setSwarmRoleResponses(env.faux, {
        coder: [
          async (ctx) => {
            sweptPrompt = JSON.stringify(ctx.messages.slice(-2))
            await slowGate.promise
            return fauxAssistantMessage('Should be aborted before finishing')
          },
        ],
      })
      await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_post', {
        groupId,
        to: ['coder'],
        kind: 'handoff',
        body: 'Active QA handoff #B',
      })
      await waitFor(() => sweptPrompt !== '', { timeoutMs: CHAIN_WAIT_MS })
      assert.match(sweptPrompt, /Passive heads-up note #A/, 'wakeup envelope must sweep prior wake=false comment')
      assert.match(sweptPrompt, /Active QA handoff #B/)

      // While coder is working: switch_worker_model rejects with 409 swarm_worker_busy; abort_worker stops in place!
      await assert.rejects(
        () =>
          kernel.plugins.invokeAction(
            SWARM_PLUGIN_ID,
            'switch_worker_model',
            { groupId, name: 'coder', model: 'faux/faux-2' },
            { conversationId: coord.id },
          ),
        (err: unknown) => err instanceof HelmxError && err.code === 'swarm_worker_busy' && err.status === 409,
      )

      const abortPromise = kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'abort_worker',
        { groupId, name: 'coder' },
        { conversationId: coord.id },
      ) as Promise<{ aborted: boolean }>
      slowGate.resolve()
      const abortRes = await abortPromise
      assert.equal(abortRes.aborted, true)
      await kernel.conversations.waitForIdle(coder.workerConversationId)

      // Once idle: switch_worker_model switches model to faux/faux-2 in place!
      const switched = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'switch_worker_model',
        { groupId, name: 'coder', model: 'faux/faux-2' },
        { conversationId: coord.id },
      )) as { model: string }
      assert.equal(switched.model, 'faux/faux-2')
      assert.equal(kernel.conversations.getConversation(coder.workerConversationId).model, 'faux/faux-2')

      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId }, { conversationId: coord.id })
    } finally {
      env.faux.setResponses([])
    }
  })

  test('swarm-int6: multi-tool-round worker turn settles once — no mid-turn silent-exit nudge, no false system blocker, single post-done coordinator report', { timeout: 60_000 }, async () => {
    const env = sharedEnv!
    const { app, faux, repoDir } = env
    let groupId = ''
    let coordId = 0
    try {
      const coord = await app.kernel.conversations.createConversation({ title: 'Handover Coord', profileId: 'assistant', cwd: repoDir })
      coordId = coord.id
      const created = (await app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Handover Squad',
        conversationId: coord.id,
      })) as { groupId: string }
      groupId = created.groupId

      // Worker turn: two plain bash rounds (each ends in a pi-durable run handOver to a new generation task),
      // then the done post, then the final answer text. Pre-fix every handOver emitted a spurious turn_settled:
      // the first fired a silent-exit nudge mid-turn and the second auto-posted a false system [blocker].
      setSwarmRoleResponses(faux, {
        coder: [
          fauxAssistantMessage([fauxToolCall('bash', { command: 'echo step one' })], { stopReason: 'toolUse' }),
          fauxAssistantMessage([fauxToolCall('bash', { command: 'echo step two' })], { stopReason: 'toolUse' }),
          fauxAssistantMessage(
            [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Shipped after two tool rounds.' })],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('Final summary after the done post.'),
        ],
        coordinator: [fauxAssistantMessage('Coordinator received the final done report.')],
      })

      const worker = (await app.kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { prompt: 'Run two tool steps, then post done.', name: 'coder' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }

      await app.kernel.conversations.waitForIdle(worker.workerConversationId)
      await waitFor(() => app.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await app.kernel.conversations.waitForIdle(coord.id)

      // 1) Board carries only the coordinator brief and the worker done — no system blocker, no stall, no echo posts.
      const read = (await app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as { posts: BoardPost[] }
      assert.equal(
        read.posts.filter((p) => p.from === 'system').length,
        0,
        `system posts must stay empty, got ${JSON.stringify(read.posts.filter((p) => p.from === 'system'))}`,
      )
      assert.equal(read.posts.filter((p) => p.kind === 'done' && p.from === 'coder').length, 1)

      // 2) The worker conversation never received a silent-exit nudge (mid-turn settlement misfire).
      const workerDetail = await app.kernel.conversations.getConversationDetail(worker.workerConversationId, { limit: 50 })
      assert.equal(
        workerDetail.entries.some((e) => JSON.stringify(e.data ?? '').includes('swarm_silent_exit_nudge')),
        false,
        'no silent-exit nudge may be queued while the worker is mid-turn',
      )

      // 3) The coordinator received exactly one board report, covering the done post.
      const coordDetail = await app.kernel.conversations.getConversationDetail(coord.id, { limit: 50 })
      const reportInputs = coordDetail.entries.filter(
        (e) => e.kind === 'helmx.input' && JSON.stringify(e.data ?? '').includes('swarm_board_report'),
      )
      assert.equal(reportInputs.length, 1, `expected exactly one coordinator report, got ${reportInputs.length}`)
      assert.match(JSON.stringify(reportInputs[0]!.data ?? ''), /\[done\] @coder/)
    } finally {
      if (groupId && coordId) {
        await app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId }, { conversationId: coordId }).catch(() => {})
      }
      faux.setResponses([])
    }
  })

  test('swarm-int16: switch_worker_model effort+prompt one-shot resume, board_status model summary, and 0-token peer hop circuit breaker', { timeout: 60_000 }, async () => {
    const env = sharedEnv!
    try {
      const { kernel } = env.app
      await kernel.plugins.setConfig(SWARM_PLUGIN_ID, { maxPeerHopsWithoutCoordinator: 2 })
      const coord = await kernel.conversations.createConversation({ title: 'Swarm Polish Coord', profileId: 'assistant', cwd: env.repoDir })
      const { groupId } = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Polish Squad',
        conversationId: coord.id,
      })) as { groupId: string }

      const execSwarmDerived = async <TOut>(
        toolName: string,
        input: Record<string, unknown>,
        ctx: { conversationId: number; callId?: string },
      ): Promise<{ output: string; structuredOutput: TOut }> => {
        const spec = kernel.plugins.listTools().find((t) => t.name === toolName)
        assert.ok(spec && spec.sourceKind === 'action', `expected derived action tool ${toolName}`)
        const raw = await kernel.plugins.executeTool(toolName, input, ctx)
        const normalized = actionToolResult(raw, input, (text) => text, {
          structuredOutputSchema: spec.structuredOutputSchema,
          presentationMetaSchema: spec.presentationMetaSchema,
          projectPresentationMeta: spec.projectPresentationMeta,
          formatOutput: spec.formatOutput,
          toolName: spec.name,
        })
        return {
          output: normalized.output.map((b) => b.text).join(''),
          structuredOutput: normalized.structuredOutput as TOut,
        }
      }

      // 1) switch_worker_model with effort + prompt switches model & thinkingLevel and wakes worker in one step (idempotent replay)
      let resumedOnNewModel = false
      setSwarmRoleResponses(env.faux, {
        alpha: [
          fauxAssistantMessage([fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'comment', body: 'alpha parked' })], { stopReason: 'toolUse' }),
          fauxAssistantMessage('alpha parked'),
          () => {
            resumedOnNewModel = true
            return fauxAssistantMessage(
              [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'alpha resumed on faux-2' })],
              { stopReason: 'toolUse' },
            )
          },
          fauxAssistantMessage('alpha resumed done'),
        ],
        coordinator: [
          fauxAssistantMessage('Coordinator noted stall.'),
          fauxAssistantMessage('Coordinator noted resumed alpha done.'),
        ],
      })

      const alpha = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId, name: 'alpha', prompt: 'Initial turn on faux-1' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }
      await kernel.conversations.waitForIdle(alpha.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

      const switchToolRes = await execSwarmDerived<{ model: string; effort?: string; postSeq?: number }>(
        'swarm_switch_worker_model',
        { groupId, name: 'alpha', model: 'faux/faux-2', effort: 'high', prompt: 'Continue task on stronger model.' },
        { conversationId: coord.id, callId: 'call-switch-resume-1' },
      )
      assert.equal(switchToolRes.structuredOutput.model, 'faux/faux-2')
      assert.equal(switchToolRes.structuredOutput.effort, 'high')
      assert.ok(typeof switchToolRes.structuredOutput.postSeq === 'number')
      assert.match(switchToolRes.output, /effort=high/)
      assert.match(switchToolRes.output, /brief #/)
      assert.equal(kernel.conversations.getConversation(alpha.workerConversationId).thinkingLevel, 'high')

      // Replay with same callId must deduplicate and return the same postSeq without waking twice
      const replayRes = await execSwarmDerived<{ postSeq?: number }>(
        'swarm_switch_worker_model',
        { groupId, name: 'alpha', model: 'faux/faux-2', effort: 'high', prompt: 'Continue task on stronger model.' },
        { conversationId: coord.id, callId: 'call-switch-resume-1' },
      )
      assert.equal(replayRes.structuredOutput.postSeq, switchToolRes.structuredOutput.postSeq)

      await waitFor(() => resumedOnNewModel, { timeoutMs: CHAIN_WAIT_MS })
      await kernel.conversations.waitForIdle(alpha.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

      // board_status text summary surfaces member model=
      const statusTool = await execSwarmDerived<{ members: Array<{ name: string }> }>(
        'swarm_board_status',
        { groupId },
        { conversationId: coord.id },
      )
      assert.match(statusTool.output, /model=faux\/faux-2/)

      // 2) 0-Token peer-to-peer hop circuit breaker (maxPeerHopsWithoutCoordinator = 2):
      //    p1 -> p2 (hop 1) -> p1 (hop 2) -> p2 (hop 3 > 2 => trips breaker, pauses p2 wake, escalates system [blocker] to coordinator!)
      let p1Turns = 0
      let p2Turns = 0
      setSwarmRoleResponses(env.faux, {
        p1: [
          () => {
            p1Turns += 1
            return fauxAssistantMessage(
              [fauxToolCall('swarm_board_post', { to: ['p2'], kind: 'handoff', body: 'Ping #1 to p2' })],
              { stopReason: 'toolUse' },
            )
          },
          fauxAssistantMessage('p1 sent ping 1'),
          () => {
            p1Turns += 1
            return fauxAssistantMessage(
              [fauxToolCall('swarm_board_post', { to: ['p2'], kind: 'handoff', body: 'Ping #2 to p2 (should trip breaker)' })],
              { stopReason: 'toolUse' },
            )
          },
          fauxAssistantMessage('p1 sent ping 2'),
        ],
        p2: [
          fauxAssistantMessage([fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'comment', body: 'p2 ready' })], { stopReason: 'toolUse' }),
          fauxAssistantMessage('p2 ready'),
          () => {
            p2Turns += 1
            return fauxAssistantMessage(
              [fauxToolCall('swarm_board_post', { to: ['p1'], kind: 'review', body: 'Pong #1 back to p1' })],
              { stopReason: 'toolUse' },
            )
          },
          fauxAssistantMessage('p2 sent pong 1'),
          () => {
            p2Turns += 1
            return fauxAssistantMessage('p2 should NOT be woken on tripped hop 3')
          },
        ],
        coordinator: [
          fauxAssistantMessage('Coordinator noted p2 ready stall.'),
          fauxAssistantMessage('Coordinator received circuit breaker blocker.'),
        ],
      })

      const p2 = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId, name: 'p2', prompt: 'Stand by as reviewer' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }
      await kernel.conversations.waitForIdle(p2.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

      const p1 = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId, name: 'p1', prompt: 'Start ping-pong loop with p2' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }

      await waitFor(async () => {
        const read = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as { posts: BoardPost[] }
        return read.posts.some((p) => p.from === 'system' && p.kind === 'blocker' && p.body.includes('circuit breaker tripped'))
      }, { timeoutMs: CHAIN_WAIT_MS })
      await kernel.conversations.waitForIdle(p1.workerConversationId)
      await kernel.conversations.waitForIdle(p2.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

      assert.equal(p1Turns, 2, 'p1 ran initial brief + 1 review pong')
      assert.equal(p2Turns, 1, 'p2 must NOT be woken on the 3rd consecutive peer hop after breaker tripped')

      await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId }, { conversationId: coord.id })
    } finally {
      await env.app.kernel.plugins.setConfig(SWARM_PLUGIN_ID, { maxPeerHopsWithoutCoordinator: 16 }).catch(() => {})
      env.faux.setResponses([])
    }
  })

  test('swarm-int18: forkFrom worker persists forked=true & context boundary, non-forked worker follows builtin:workflow.maxSubagentDepth (default 1, opt-in 2)', { timeout: 60_000 }, async () => {
    const env = sharedEnv!
    try {
      const { kernel } = env.app
      await kernel.services.profiles.save({ id: 'reviewer', name: 'Reviewer', skills: [] })

      const coord = await kernel.conversations.createConversation({ title: 'Fork Guard Coord', profileId: 'assistant', cwd: env.repoDir })
      env.faux.setResponses([fauxAssistantMessage('Stored parent context FK-88.')])
      await kernel.conversations.submitInput(coord.id, 'Remember context FK-88 and do not re-delegate it.')
      await kernel.conversations.waitForIdle(coord.id)

      const { groupId } = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Fork Guard Squad',
        conversationId: coord.id,
      })) as { groupId: string }

      let forkedRwMeta: ReturnType<typeof captureRequestMeta> | undefined
      let forkedRwSawHistory = false
      let forkedRoMeta: ReturnType<typeof captureRequestMeta> | undefined
      let plainRwMeta: ReturnType<typeof captureRequestMeta> | undefined
      let delegatingRwMeta: ReturnType<typeof captureRequestMeta> | undefined

      setSwarmRoleResponses(env.faux, {
        forked_rw: [
          (ctx) => {
            forkedRwMeta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
            forkedRwSawHistory = JSON.stringify(ctx.messages).includes('FK-88')
            return fauxAssistantMessage(
              [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'forked_rw done' })],
              { stopReason: 'toolUse' },
            )
          },
          fauxAssistantMessage('forked_rw settled'),
        ],
        forked_ro: [
          (ctx) => {
            forkedRoMeta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
            return fauxAssistantMessage(
              [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'forked_ro done' })],
              { stopReason: 'toolUse' },
            )
          },
          fauxAssistantMessage('forked_ro settled'),
        ],
        plain_rw: [
          (ctx) => {
            plainRwMeta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
            return fauxAssistantMessage(
              [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'plain_rw done' })],
              { stopReason: 'toolUse' },
            )
          },
          fauxAssistantMessage('plain_rw settled'),
        ],
        delegating_rw: [
          (ctx) => {
            delegatingRwMeta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
            return fauxAssistantMessage(
              [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'delegating_rw done' })],
              { stopReason: 'toolUse' },
            )
          },
          fauxAssistantMessage('delegating_rw settled'),
        ],
        coordinator: [
          fauxAssistantMessage('Coordinator noted forked_rw done.'),
          fauxAssistantMessage('Coordinator noted forked_ro done.'),
          fauxAssistantMessage('Coordinator noted plain_rw done.'),
          fauxAssistantMessage('Coordinator noted delegating_rw done.'),
        ],
      })

      const forkedRw = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId, name: 'forked_rw', prompt: 'Execute forked readwrite task directly.', forkFrom: 'coordinator' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }
      await kernel.conversations.waitForIdle(forkedRw.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

      const forkedRo = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId, name: 'forked_ro', prompt: 'Verify readonly forked slice.', forkFrom: 'coordinator', access: 'readonly' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }
      await kernel.conversations.waitForIdle(forkedRo.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

      const plainRw = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId, name: 'plain_rw', prompt: 'Run standard non-forked worker.' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }
      await kernel.conversations.waitForIdle(plainRw.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

      // 1) Forked readwrite worker: inherits context, gets rule 4 boundary, strips dispatch tools & profile.catalog, keeps work tools
      assert.equal(forkedRwSawHistory, true, 'forked_rw must inherit fork source history')
      assert.ok(forkedRwMeta, 'must capture forked_rw request metadata')
      const rwSec = forkedRwMeta.sectionsById['swarm.active_group'] ?? ''
      assert.match(rwSec, /^<active_swarm_group[\s\S]*4\. Context boundary:/, 'forked readwrite worker must receive rule 4 context boundary')
      assert.ok(rwSec.includes(FORKED_CHILD_CONTEXT_GUIDANCE))
      for (const stripped of ['subagent', 'SubagentWorkflow', 'swarm_create_group', 'swarm_dispatch_worker']) {
        assert.equal(forkedRwMeta.toolNames.includes(stripped), false, `forked_rw must strip ${stripped}`)
      }
      for (const kept of ['swarm_board_post', 'bash', 'read', 'write']) {
        assert.equal(forkedRwMeta.toolNames.includes(kept), true, `forked_rw must retain ${kept}`)
      }
      assert.equal(forkedRwMeta.sectionsById['profile.catalog'], undefined, 'forked_rw must suppress profile.catalog')

      // 2) Forked readonly worker: keeps rule 4 readonly + rule 5 boundary, strips dispatch tools & profile.catalog
      assert.ok(forkedRoMeta, 'must capture forked_ro request metadata')
      const roSec = forkedRoMeta.sectionsById['swarm.active_group'] ?? ''
      assert.ok(roSec.includes('4. Your access is readonly:'), 'forked readonly worker must keep rule 4 readonly')
      assert.ok(roSec.includes('5. Context boundary:'), 'forked readonly worker must append rule 5 context boundary')
      assert.equal(forkedRoMeta.toolNames.includes('subagent'), false)
      assert.equal(forkedRoMeta.toolNames.includes('SubagentWorkflow'), false)
      assert.equal(forkedRoMeta.sectionsById['profile.catalog'], undefined)

      // 3) Default non-forked worker: NO context boundary clause, defaults to depth-1 leaf (strips dispatch tools & profile.catalog, rejects workflow.run)
      assert.ok(plainRwMeta, 'must capture plain_rw request metadata')
      const plainSec = plainRwMeta.sectionsById['swarm.active_group'] ?? ''
      assert.equal(plainSec.includes('Context boundary:'), false, 'non-forked worker must not get forked context boundary')
      assert.equal(plainSec.includes('ALREADY fulfilled'), false)
      for (const stripped of ['subagent', 'SubagentWorkflow', 'swarm_create_group', 'swarm_dispatch_worker']) {
        assert.equal(plainRwMeta.toolNames.includes(stripped), false, `default non-forked worker strips ${stripped}`)
      }
      for (const kept of ['swarm_board_post', 'bash', 'read', 'write']) {
        assert.equal(plainRwMeta.toolNames.includes(kept), true, `default non-forked worker retains ${kept}`)
      }
      assert.equal(plainRwMeta.sectionsById['profile.catalog'], undefined, 'default non-forked worker suppresses profile.catalog')
      await assert.rejects(
        () =>
          kernel.plugins.invokeAction(WORKFLOW_ID, 'run', {
            script: 'export const meta = { name: "blocked", description: "d" }\nreturn 1',
            conversationId: plainRw.workerConversationId,
          }),
        (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded' && err.status === 403,
      )

      // 4) Raising single-source config `builtin:workflow.maxSubagentDepth` to 2 unlocks non-forked worker dispatch tools & catalog
      await kernel.plugins.setConfig(WORKFLOW_ID, { maxSubagentDepth: 2 })
      await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId, name: 'delegating_rw', prompt: 'Run non-forked worker under global depth-2 ceiling.' },
        { conversationId: coord.id },
      )
      await waitFor(() => delegatingRwMeta !== undefined && kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0, { timeoutMs: CHAIN_WAIT_MS })
      await kernel.conversations.waitForIdle(coord.id)

      assert.ok(delegatingRwMeta, 'must capture delegating_rw request metadata')
      const delegSec = delegatingRwMeta.sectionsById['swarm.active_group'] ?? ''
      assert.equal(delegSec.includes('Context boundary:'), false, 'non-forked delegating worker must not get forked context boundary')
      assert.equal(delegatingRwMeta.toolNames.includes('subagent'), true, 'non-forked worker retains subagent under ceiling 2')
      assert.equal(delegatingRwMeta.toolNames.includes('SubagentWorkflow'), true, 'non-forked worker retains SubagentWorkflow under ceiling 2')
      assert.equal(delegatingRwMeta.toolNames.includes('swarm_board_post'), true)
      assert.ok(typeof delegatingRwMeta.sectionsById['profile.catalog'] === 'string', 'non-forked worker retains profile.catalog under ceiling 2')
      assert.ok(delegatingRwMeta.sectionsById['profile.catalog'].includes('id="reviewer"'))

      // 5) Persisted forked=true in board_status and meta.json (no extra maxSubagentDepth field)
      const status = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_status', { groupId }, { conversationId: coord.id })) as BoardViewDoc
      assert.equal(status.members.find((m) => m.name === 'forked_rw')?.forked, true)
      assert.equal(status.members.find((m) => m.name === 'forked_ro')?.forked, true)
      assert.equal(status.members.find((m) => m.name === 'plain_rw')?.forked, undefined)
      assert.equal(status.members.find((m) => m.name === 'delegating_rw')?.forked, undefined)

      const metaPath = join(env.dataDir, 'plugins', 'builtin%3Aswarm', 'groups', groupId, 'meta.json')
      const persistedMeta = JSON.parse(readFileSync(metaPath, 'utf8')) as CollabGroupRecord
      assert.equal(persistedMeta.members.find((m) => m.name === 'forked_rw')?.forked, true)
      assert.equal(persistedMeta.members.find((m) => m.name === 'forked_ro')?.forked, true)
      assert.equal(persistedMeta.members.find((m) => m.name === 'plain_rw')?.forked, undefined)
      assert.equal(persistedMeta.members.find((m) => m.name === 'delegating_rw')?.forked, undefined)

      await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId }, { conversationId: coord.id })
    } finally {
      await env.app.kernel.plugins.setConfig(WORKFLOW_ID, { maxSubagentDepth: 1 }).catch(() => {})
      env.faux.setResponses([])
    }
  })
  })

  test('swarm-int4: failed turn auto [blocker], At-Most-Once Silent-Exit Nudge -> fallback [blocker], 0-Token [stall], and Hub restart recovery', { timeout: 60_000 }, async (t) => {
    const root = useTempDir(t, 'helmx-swarm-selfheal-')
    const dataDir = join(root, 'data')
    const repoDir = join(root, 'repo')
    gitTemplate.cloneTo(repoDir)

    const makeInstance = async (configureFaux?: (faux: FauxProviderHandle) => void) => {
      const faux = makeFauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] })
      if (configureFaux !== undefined) {
        configureFaux(faux)
      } else {
        faux.setResponses([])
      }
      const app = await openSwarmRuntime({
        dataDir,
        cwd: repoDir,
        faux,
      })
      return { faux, app }
    }

    let inst = await makeInstance()
    try {
      const coord = await inst.app.kernel.conversations.createConversation({ title: 'Resilience Coord', profileId: 'assistant', cwd: repoDir })
      const { groupId } = (await inst.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Self-Heal Squad',
        conversationId: coord.id,
      })) as { groupId: string }

      // 1) At-Most-Once Silent-Exit Nudge -> 2nd silent exit emits fallback [blocker] (no infinite loop!)
      let silentTurns = 0
      setSwarmRoleResponses(inst.faux, {
        mute: [
          () => {
            silentTurns += 1
            return fauxAssistantMessage('First turn: forgot to call board_post.')
          },
          () => {
            silentTurns += 1
            return fauxAssistantMessage('Second turn after nudge: still forgot to call board_post.')
          },
        ],
        coordinator: [fauxAssistantMessage('Coordinator noted silent-exit blocker.')],
      })

      const muteWorker = (await inst.app.kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { prompt: 'Implement task and report.', name: 'mute' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }

      await waitFor(async () => {
        const read = (await inst.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as {
          posts: BoardPost[]
        }
        return read.posts.some((p) => p.from === 'system' && p.kind === 'blocker' && p.body.includes('@mute'))
      }, { timeoutMs: CHAIN_WAIT_MS })
      await inst.app.kernel.conversations.waitForIdle(muteWorker.workerConversationId)
      await waitFor(() => inst.app.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await inst.app.kernel.conversations.waitForIdle(coord.id)
      assert.equal(silentTurns, 2, 'must nudge at most once (initial turn + 1 nudge turn = 2 turns total)')

      // 2) Turn outcome === 'failed' -> auto-posts system [blocker] with model name & redacted error
      setSwarmRoleResponses(inst.faux, {
        flaky: [
          () => {
            throw new Error('upstream 429 quota_exhausted')
          },
        ],
        coordinator: [fauxAssistantMessage('Coordinator received failure blocker.')],
      })
      const flakyWorker = (await inst.app.kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { prompt: 'Run against flaky model.', name: 'flaky' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }

      await waitFor(async () => {
        const read = (await inst.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as {
          posts: BoardPost[]
        }
        return read.posts.some(
          (p) => p.from === 'system' && p.kind === 'blocker' && p.body.includes('@flaky') && p.body.includes('faux/faux-1'),
        )
      }, { timeoutMs: CHAIN_WAIT_MS })
      await inst.app.kernel.conversations.waitForIdle(flakyWorker.workerConversationId)
      await waitFor(() => inst.app.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await inst.app.kernel.conversations.waitForIdle(coord.id)

      // 3) 6-condition 0-Token Quiescence Guard: mute posts comment(wake=false) to flaky -> all idle -> auto [stall] citing #seq!
      setSwarmRoleResponses(inst.faux, {
        mute: [
          fauxAssistantMessage(
            [fauxToolCall('swarm_board_post', { to: ['flaky'], kind: 'comment', wake: false, body: 'Dangling passive output' })],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('Finished turn after passive comment.'),
        ],
        coordinator: [fauxAssistantMessage('Coordinator received stall diagnosis.')],
      })
      await inst.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_post', {
        groupId,
        to: ['mute'],
        kind: 'handoff',
        wake: true,
        body: 'Produce passive note.',
      })
      await waitFor(async () => {
        const read = (await inst.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as {
          posts: BoardPost[]
        }
        return read.posts.some((p) => p.from === 'system' && p.kind === 'stall' && p.body.includes('wake=false'))
      }, { timeoutMs: CHAIN_WAIT_MS })
      await inst.app.kernel.conversations.waitForIdle(muteWorker.workerConversationId)
      await waitFor(() => inst.app.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await inst.app.kernel.conversations.waitForIdle(coord.id)

      // 4) Restart recovery of unsent wakeup envelope: persist pendingWakeupSeq > readCursorSeq on disk, restart Hub, verify wakeup delivered!
      await inst.app.close()
      const actualMetaPath = join(dataDir, 'plugins', 'builtin%3Aswarm', 'groups', groupId, 'meta.json')
      const persistedMeta = JSON.parse(readFileSync(actualMetaPath, 'utf8')) as {
        headSeq: number
        members: Array<{ name: string; readCursorSeq: number; pendingWakeupSeq: number }>
      }
      const muteRec = persistedMeta.members.find((m) => m.name === 'mute')!
      muteRec.readCursorSeq = 0
      muteRec.pendingWakeupSeq = persistedMeta.headSeq
      writeFileSync(actualMetaPath, `${JSON.stringify(persistedMeta, null, 2)}\n`)

      let recoveredWakeupDelivered = false
      inst = await makeInstance((faux) => {
        setSwarmRoleResponses(faux, {
          mute: [
            () => {
              recoveredWakeupDelivered = true
              return fauxAssistantMessage(
                [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Recovered after restart!' })],
                { stopReason: 'toolUse' },
              )
            },
            fauxAssistantMessage('Recovered worker settled.'),
          ],
          coordinator: [fauxAssistantMessage('Coordinator received recovered done.')],
        })
      })
      await waitFor(() => recoveredWakeupDelivered, { timeoutMs: CHAIN_WAIT_MS })
      await inst.app.kernel.conversations.waitForIdle(muteWorker.workerConversationId)
      await waitFor(() => inst.app.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await inst.app.kernel.conversations.waitForIdle(coord.id)
    } finally {
      await inst.app.close()
    }
  })

  test('swarm-int21: worker turn settling before the wakeup cursor write still merges the settled wakeup, nudges silent exit once, and lands the fallback [blocker]', { timeout: 60_000 }, async (t) => {
    // 回归：dispatch_worker 的唤醒投递在 submitInputGuarded 接纳后才推进 readCursorSeq（dispatcher 第 3 步）；
    // 工人回合若先结算，onMemberTurnSettled 曾把仍挂在 inflightWakeup 的这轮误判为"仍有待投递"而吞掉静默退场续催。
    // 这里用 createCollabGroupRuntime 的宿主端口 + deferred 门控确定性地复现"回合先结算、游标后落地"的顺序（无固定 sleep）。
    const dataDir = useTempDir(t, 'helmx-swarm-settle-race-')
    const groupId = 'grp_settle_race'
    const workerConvId = 11
    const locks = new Map<string, Promise<unknown>>()
    const errors: Array<{ title: string; detail: unknown }> = []
    const submitted: Array<{ conversationId: number; requestId: string; text: string }> = []
    const submissions = new Map<string, { status: 'queued' | 'placed' | 'done' | 'unanswered' }>()
    const convs = new Map<number, { status: 'idle' | 'working' | 'error'; completionSeq: number }>([
      [10, { status: 'idle', completionSeq: 1 }],
      [workerConvId, { status: 'idle', completionSeq: 0 }],
    ])
    const settlingWorkers = new Map<number, number>()
    const cursorGate = deferred<void>()
    let runtime: CollabGroupRuntime | undefined

    // 模拟 hooks.ts 的 turn_settled 入口（含 settlingWorkers 计数），直接驱动 onMemberTurnSettled。
    const fireWorkerTurnSettled = (completionSeq: number, lastReplySummary: string): Promise<void> => {
      settlingWorkers.set(workerConvId, (settlingWorkers.get(workerConvId) ?? 0) + 1)
      return runtime!.onMemberTurnSettled({
        groupId, memberName: 'mute', conversationId: workerConvId, completionSeq, outcome: 'completed', lastReplySummary,
      }).finally(() => {
        const remaining = (settlingWorkers.get(workerConvId) ?? 1) - 1
        if (remaining === 0) settlingWorkers.delete(workerConvId)
        else settlingWorkers.set(workerConvId, remaining)
      })
    }

    const docState = new Map<string, unknown>()
    const sessionState = new Map<number, unknown>()
    const docs = {
      boardBadges: { get: () => ({ byConversation: {} }), set: () => {}, update: () => {}, flush: async () => {} },
      boardView: {
        get: (cid: number) => sessionState.get(cid) ?? null,
        set: (cid: number, val: unknown) => { sessionState.set(cid, val) },
        update: () => {},
        delete: (cid: number) => { sessionState.delete(cid) },
        listConversationIds: () => [...sessionState.keys()],
        flush: async () => {},
      },
    }
    const fakeCtx = {
      pluginId: SWARM_PLUGIN_ID,
      dataDir,
      doc: <T>(name: string, initial: T) => ({
        get: () => (docState.get(name) as T) ?? initial,
        set: (val: T) => { docState.set(name, val) },
        update: (fn: (cur: T) => T) => { docState.set(name, fn((docState.get(name) as T) ?? initial)) },
        flush: async () => {},
      }),
      sessionDoc: <T>(_name: string, initial: T) => ({
        get: (cid: number) => (sessionState.get(cid) as T) ?? initial,
        set: (cid: number, val: T) => { sessionState.set(cid, val) },
        update: () => {},
        delete: (cid: number) => { sessionState.delete(cid) },
        listConversationIds: () => [...sessionState.keys()],
        flush: async () => {},
      }),
      host: {
        isClosing: false,
        redact: (txt: string) => txt,
        manageConversation: () => () => {},
        listConversations: () => [],
        withFileLock: async <T>(lockPath: string, fn: () => Promise<T>): Promise<T> => {
          const prev = locks.get(lockPath) ?? Promise.resolve()
          const run = prev.then(fn, fn)
          locks.set(lockPath, run.then(() => undefined, () => undefined))
          return run
        },
        atomicWriteFile: async (filePath: string, content: string) => {
          mkdirSync(dirname(filePath), { recursive: true })
          writeFileSync(filePath, content, 'utf8')
        },
        submitInput: async (id: number, text: string, opts?: { requestId?: string }) => {
          submitted.push({ conversationId: id, requestId: opts?.requestId ?? '', text })
        },
        submitInputGuarded: async (id: number, text: string, opts?: { requestId?: string }) => {
          const requestId = opts?.requestId ?? ''
          submitted.push({ conversationId: id, requestId, text })
          submissions.set(`${id}:${requestId}`, { status: 'done' })
          if (requestId.startsWith('swarm-wakeup:')) {
            // 内核语义：submitInputGuarded 接纳后即返回、回合异步结算；这里让回合先结算，再放行 dispatcher 的游标写入。
            convs.set(id, { status: 'idle', completionSeq: 1 })
            void fireWorkerTurnSettled(1, 'First turn: forgot to call board_post.')
            await cursorGate.promise
          }
        },
        getConversationSubmission: async (id: number, requestId: string) => submissions.get(`${id}:${requestId}`),
        getConversationDetail: async () => ({ entries: [] }),
      },
    } as never
    const fakeCoordinator = {
      isActive: () => true,
      isShutdown: () => false,
      getConfig: () => resolveSwarmConfig({}),
      getDocs: () => docs,
      writeIndex: () => {},
      settlingWorkers,
      reportError: (title: string, detail: unknown) => { errors.push({ title, detail }) },
      enqueueDispatch: async <T>(_key: string, fn: () => Promise<T>) => fn(),
      track: async <T>(_label: string, fn: () => Promise<T>) => fn(),
      readConversationOrUndefined: (id: number) => {
        const entry = convs.get(id)
        if (!entry) return undefined
        return {
          id, title: `conv-${id}`, profileId: 'assistant', nodeId: 'local', cwd: dataDir, model: 'faux/faux-1',
          thinkingLevel: 'off' as const, unread: false, pinned: false, pendingAskCount: 0,
          status: entry.status, tags: [], createdAt: 1, updatedAt: 1, stateChangeSeq: 1, completionSeq: entry.completionSeq,
        }
      },
    } as never

    const fixture: CollabGroupRecord = {
      id: groupId, title: 'Settle Race Squad', coordinatorConversationId: 10, status: 'active',
      members: [{
        name: 'mute', conversationId: workerConvId, profileId: 'assistant', access: 'readwrite', isolation: 'inherit',
        nodeId: 'local', cwd: dataDir, lifecycle: 'active', readCursorSeq: 0, pendingWakeupSeq: 0, createdAt: 1,
      }],
      headSeq: 0, coordinatorNotifiedSeq: 0, coordinatorPendingSeq: 0, createdAt: 1, updatedAt: 1,
    }
    const groupDir = join(dataDir, 'groups', groupId)
    mkdirSync(groupDir, { recursive: true })
    writeFileSync(join(groupDir, 'meta.json'), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')

    runtime = createCollabGroupRuntime(fakeCtx, () => fakeCoordinator)
    t.after(async () => {
      cursorGate.resolve()
      await runtime?.stopAndClear()
    }, { timeout: 60_000 })
    const memberNow = () => runtime!.getGroup(groupId)!.members.find((m) => m.name === 'mute')!
    const wakeupSubmits = () => submitted.filter((s) => s.requestId.startsWith('swarm-wakeup:'))

    await runtime.loadAllFromDisk()
    await runtime.appendPost(groupId, {
      from: 'coordinator', to: ['mute'], resolvedTargets: ['mute'], wake: true, kind: 'brief', refs: [], body: 'Implement task and report.',
    })

    // 1) 回合已结算、dispatcher 的游标写入仍被门控挂起：已结算的 inflight 唤醒必须先被归并（游标推进到 #1、inflight 清除）
    await waitFor(() => memberNow().readCursorSeq === 1 && memberNow().inflightWakeup === undefined, {
      message: 'settled inflight wakeup must be merged even though the dispatcher cursor write has not landed yet',
    })
    assert.equal(wakeupSubmits().length, 1, 'the brief wakeup is delivered exactly once')

    // 2) 放行晚到的游标写入后仍续催一次（静默退场不再被吞），且晚到写入不破坏续催状态
    cursorGate.resolve()
    await waitFor(() => submitted.some((s) => s.requestId === `swarm-nudge:${groupId}:mute:1`) && memberNow().inflightNudge === undefined)
    const nudged = memberNow()
    assert.equal(nudged.readCursorSeq, 1)
    assert.equal(nudged.lastWakeTaskSeq, 1)
    assert.equal(nudged.silentExitNudgeSeq, 1)
    assert.equal(nudged.inflightWakeup, undefined)
    assert.equal(wakeupSubmits().length, 1, 'late cursor write must not re-deliver the wakeup')

    // 3) 续催回合再次哑巴退场 -> 兜底 system [blocker]（与 swarm-int4 的完整链路一致）
    convs.set(workerConvId, { status: 'idle', completionSeq: 2 })
    await fireWorkerTurnSettled(2, 'Second turn after nudge: still forgot to call board_post.')
    const blocker = runtime.getPosts(groupId).find((p) => p.from === 'system' && p.kind === 'blocker')
    assert.ok(blocker !== undefined, 'fallback system blocker must be posted after the second silent exit')
    assert.ok(blocker.body.includes('@mute') && blocker.body.includes('task #1'))
    assert.equal(memberNow().silentExitNudgeSeq, undefined)
    assert.equal(memberNow().lastWakeTaskSeq, undefined)
    assert.deepEqual(errors, [])
  })

  test('swarm-int11: done non-race catch-up, failed-turn queued wakeup delivery, active worker delete lock + disabled-period reconcile', { timeout: 60_000 }, async (t) => {
    const env = await openSwarmEnv(useTempDir(t, 'helmx-swarm-int7-'), gitTemplate)
    try {
      const { kernel } = env.app
      const coord = await kernel.conversations.createConversation({ title: 'Catchup Coord', profileId: 'assistant', cwd: env.repoDir })
      const { groupId } = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Catchup Squad',
        conversationId: coord.id,
      })) as { groupId: string }

      // 1) Eliminating the 50ms done race deadlock + multi-worker blocker idle catch-up:
      //    beta posts kind:'done' in round 1, then lingers > 80ms (> 50ms batch window) before trailing text settles.
      //    Coordinator must NOT receive activeWorkingMembers:@beta prematurely, and must receive the post-settlement report once idle.
      let betaRound = 0
      const betaSecondRoundEntered = deferred<void>()
      const betaRelease = deferred<void>()
      env.faux.setResponses([
        async (ctx) => {
          const sec = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[]).sectionsById['swarm.active_group'] ?? ''
          if (sec.includes('name="beta"')) {
            betaRound += 1
            if (betaRound === 1) {
              return fauxAssistantMessage(
                [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Beta finished!' })],
                { stopReason: 'toolUse' },
              )
            }
            betaSecondRoundEntered.resolve()
            await betaRelease.promise
            return fauxAssistantMessage('Beta completed trailing summary text.')
          }
          return fauxAssistantMessage('Coordinator processed report.')
        },
        ...Array.from({ length: 8 }, () => async (ctx: { messages: unknown[] }) => {
          const sec = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[]).sectionsById['swarm.active_group'] ?? ''
          if (sec.includes('name="beta"')) {
            betaRound += 1
            if (betaRound === 2) {
              betaSecondRoundEntered.resolve()
              await betaRelease.promise
            }
            return fauxAssistantMessage('Beta completed trailing summary text.')
          }
          return fauxAssistantMessage('Coordinator noted idle completion.')
        }),
      ])

      const beta = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { prompt: 'Handle beta task with done + slow trailing text.', name: 'beta' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }

      await betaSecondRoundEntered.promise
      // Hold longer than COORDINATOR_BATCH_WINDOW_MS (50ms) while beta is still mid-turn!
      await new Promise((r) => setTimeout(r, 60))
      const midTurnReports = (await kernel.conversations.getConversationDetail(coord.id, { limit: 20 })).entries.filter(
        (e) => e.kind === 'helmx.input' && JSON.stringify(e.data ?? '').includes('swarm_board_report'),
      )
      assert.equal(midTurnReports.length, 0, 'done post must NOT trigger 50ms race report while worker is still settling trailing text')

      betaRelease.resolve()
      await kernel.conversations.waitForIdle(beta.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

      // Coordinator must have received final report after beta settled with empty activeWorkingMembers!
      const coordDetail = await kernel.conversations.getConversationDetail(coord.id, { limit: 50 })
      const reports = coordDetail.entries
        .filter((e) => e.kind === 'helmx.input' && JSON.stringify(e.data ?? '').includes('swarm_board_report'))
        .map((e) => JSON.stringify(e.data ?? ''))
      assert.equal(reports.length, 1, 'coordinator must receive report once worker settles idle')
      assert.match(reports[0]!, /\[done\] @beta/)
      assert.match(reports[0]!, /activeWorkingMembers: \(none\)/)

      // 2) Active worker conversation lock blocks deletion while active, releases after close or archive
      await assert.rejects(
        () => kernel.conversations.deleteConversation(beta.workerConversationId),
        (err: unknown) => err instanceof HelmxError && err.code === 'conversation_managed_by_plugin' && err.status === 409,
      )
      await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'archive_worker', { groupId, name: 'beta' }, { conversationId: coord.id })
      await kernel.conversations.deleteConversation(beta.workerConversationId)

      // 3) failed-turn catchup: if worker settles with outcome=failed after a new wakeup was queued mid-turn, queued wakeup delivers
      let gammaFailDone = false
      let gammaRecoveredDelivered = false
      env.faux.setResponses([fauxAssistantMessage('Gamma ready')])
      const failingWorker = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { prompt: 'Fail initial turn cleanly.', name: 'gamma' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }
      await kernel.conversations.waitForIdle(failingWorker.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

      // Fail gamma's next turn AFTER deterministically awaiting an inbound brief queued mid-turn
      env.faux.setResponses([
        async () => {
          if (!gammaFailDone) {
            gammaFailDone = true
            await kernel.plugins.invokeAction(
              SWARM_PLUGIN_ID,
              'board_post',
              { groupId, to: ['gamma'], kind: 'brief', body: 'Retry queued after fail' },
              { conversationId: coord.id },
            )
            throw new Error('simulated worker crash')
          }
          gammaRecoveredDelivered = true
          return fauxAssistantMessage(
            [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Gamma recovered queued wakeup' })],
            { stopReason: 'toolUse' },
          )
        },
        () => {
          gammaRecoveredDelivered = true
          return fauxAssistantMessage(
            [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Gamma recovered queued wakeup' })],
            { stopReason: 'toolUse' },
          )
        },
        fauxAssistantMessage('Gamma done'),
        fauxAssistantMessage('Coordinator noted failure & recovery'),
        fauxAssistantMessage('Coordinator noted done'),
      ] as never)
      await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'board_post',
        { groupId, to: ['gamma'], kind: 'brief', body: 'Run failing turn' },
        { conversationId: coord.id },
      )
      await waitFor(() => gammaRecoveredDelivered === true, { timeoutMs: CHAIN_WAIT_MS })
      await kernel.conversations.waitForIdle(failingWorker.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)
      assert.equal(gammaRecoveredDelivered, true)

      // 4) Worker with worktree deleted while plugin disabled: startup reconciles hold, archives member, and posts [blocker]
      let deltaStep = 0
      env.faux.setResponses([
        () => {
          deltaStep += 1
          if (deltaStep === 1) {
            return fauxAssistantMessage(
              [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Delta done before delete.' })],
              { stopReason: 'toolUse' },
            )
          }
          return fauxAssistantMessage('Temp ready')
        },
        fauxAssistantMessage('Temp ready'),
        fauxAssistantMessage('Coordinator ack'),
        fauxAssistantMessage('Coordinator noted deleted delta'),
      ])
      const wtWorker = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { prompt: 'Hold worktree then get deleted while disabled.', name: 'delta', isolation: 'worktree' },
        { conversationId: coord.id },
      )) as { workerConversationId: number; worktreeId: string }
      await kernel.conversations.waitForIdle(wtWorker.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)
      await waitFor(() => {
        const s = kernel.conversations.getConversation(wtWorker.workerConversationId).status
        return s !== 'working' && s !== 'blocked' && kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0
      })

      await kernel.plugins.disable(SWARM_PLUGIN_ID, { force: true })
      await kernel.conversations.deleteConversation(wtWorker.workerConversationId)
      await kernel.plugins.enable(SWARM_PLUGIN_ID)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord.id)

      const statusAfterReconcile = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_status', { groupId })) as BoardViewDoc
      const deltaMember = statusAfterReconcile.members.find((m) => m.name === 'delta')!
      assert.equal(deltaMember.lifecycle, 'archived')
      assert.ok(
        statusAfterReconcile.posts.some((p) => p.from === 'system' && p.kind === 'blocker' && p.body.includes('@delta')),
        'must emit system [blocker] when worker conversation was deleted while plugin disabled',
      )
      // Released hold means worktree cleanup succeeds without hold lock error!
      await kernel.plugins.invokeAction(WORKTREE_ID, 'cleanup_worktree', { worktreeId: wtWorker.worktreeId, force: true })
    } finally {
      await env.close()
    }
  })

  test('swarm-int15: per-slice done wakes coordinator past slow worker, mid-flight review wakes while sender keeps working, unwoken done triggers stall, authoritative inflightReport recovery, and persisted idle catch-up across restart', { timeout: 60_000 }, async (t) => {
    const root = useTempDir(t, 'helmx-swarm-int15-')

    // ---- Part 1 & 2: Long-running worker + per-slice done wake + mid-flight review immediate wake while sender works + unwoken done stall ----
    const env1 = await openSwarmEnv(root, gitTemplate)
    let groupId = ''
    let coordId = 0
    let slowId = 0
    let fastId = 0
    try {
      const { kernel } = env1.app
      const coord = await kernel.conversations.createConversation({ title: 'Tiered Wake Coord', profileId: 'assistant', cwd: env1.repoDir })
      coordId = coord.id
      const created = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Tiered Wake Squad',
        conversationId: coord.id,
      })) as { groupId: string }
      groupId = created.groupId

      const slowEntered = deferred<void>()
      const slowRelease = deferred<void>()
      const reviewerContinuedEntered = deferred<void>()
      const reviewerRelease = deferred<void>()
      const fastDoneCoordSeen = deferred<string>()
      const reviewCoordSeen = deferred<string>()
      let slowRound = 0
      let fastRound = 0
      let reviewerRound = 0
      try {
        env1.faux.setResponses(
          Array.from({ length: 32 }, () => async (ctx: { messages: unknown[] }) => {
            const meta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
            const sec = meta.sectionsById['swarm.active_group'] ?? ''
            if (sec.includes('name="slow"')) {
              slowRound += 1
              if (slowRound === 1) {
                slowEntered.resolve()
                await slowRelease.promise
                return fauxAssistantMessage(
                  [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'comment', wake: false, body: 'Slow cleanup note.' })],
                  { stopReason: 'toolUse' },
                )
              }
              return fauxAssistantMessage('Slow finished after long run.')
            }
            if (sec.includes('name="fast"')) {
              fastRound += 1
              if (fastRound === 1) {
                return fauxAssistantMessage(
                  [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Fast slice done.' })],
                  { stopReason: 'toolUse' },
                )
              }
              return fauxAssistantMessage('Fast settled.')
            }
            if (sec.includes('name="reviewer"')) {
              reviewerRound += 1
              if (reviewerRound === 1) {
                return fauxAssistantMessage(
                  [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'review', body: 'Need coordinator decision now.' })],
                  { stopReason: 'toolUse' },
                )
              }
              reviewerContinuedEntered.resolve()
              await reviewerRelease.promise
              return fauxAssistantMessage('Reviewer settled.')
            }
            const userTexts = (ctx.messages as Array<{ role?: string; content?: unknown }>)
              .filter((m) => m.role === 'user')
              .map((m) =>
                typeof m.content === 'string'
                  ? m.content
                  : Array.isArray(m.content)
                    ? m.content
                        .map((b) => (typeof b === 'object' && b !== null && 'text' in b ? String((b as { text: unknown }).text) : ''))
                        .join('\n')
                    : '',
              )
              .join('\n')
            if (userTexts.includes('Fast slice done.')) {
              fastDoneCoordSeen.resolve(userTexts)
            }
            if (userTexts.includes('Need coordinator decision now.')) {
              reviewCoordSeen.resolve(userTexts)
            }
            return fauxAssistantMessage('Coordinator handled board report.')
          }),
        )

        const slow = (await kernel.plugins.invokeAction(
          SWARM_PLUGIN_ID,
          'dispatch_worker',
          { prompt: 'Run long background work.', name: 'slow' },
          { conversationId: coord.id },
        )) as { workerConversationId: number }
        slowId = slow.workerConversationId
        await slowEntered.promise

        // 1) Dispatch fast -> posts done while slow is still working -> wakes coordinator immediately once fast settles (past slow!)
        const fast = (await kernel.plugins.invokeAction(
          SWARM_PLUGIN_ID,
          'dispatch_worker',
          { prompt: 'Finish fast slice.', name: 'fast' },
          { conversationId: coord.id },
        )) as { workerConversationId: number }
        fastId = fast.workerConversationId
        await kernel.conversations.waitForIdle(fast.workerConversationId)
        const fastCoordText = await fastDoneCoordSeen.promise
        await kernel.conversations.waitForIdle(coord.id)
        assert.match(fastCoordText, /Fast slice done\./)
        assert.match(fastCoordText, /activeWorkingMembers: @slow\n/)

        const coordEntriesAfterFast = (await kernel.conversations.getConversationDetail(coord.id, { limit: 30 })).entries
        const fastReportEntry = coordEntriesAfterFast.find((e) => {
          if (e.kind !== 'helmx.input' || typeof e.data !== 'object' || e.data === null) return false
          const meta = (e.data as { meta?: Record<string, unknown> }).meta
          return (
            meta?.['renderer'] === 'swarm:board-report' &&
            Array.isArray(meta['posts']) &&
            (meta['posts'] as Array<{ body?: string }>).some((p) => p.body === 'Fast slice done.')
          )
        })
        assert.ok(fastReportEntry !== undefined, 'coordinator must receive structured board-report entry for fast done')
        const fastReportMeta = (fastReportEntry!.data as { meta: Record<string, unknown> }).meta
        assert.equal('headline' in fastReportMeta, false, 'board-report meta must not carry legacy headline')
        assert.deepEqual(fastReportMeta['activeWorkingMembers'], ['slow'])
        assert.equal(fastReportMeta['idleCatchup'], undefined)
        const fastReportPosts = fastReportMeta['posts'] as Array<{ from: string; kind: string; body: string }>
        assert.ok(fastReportPosts.some((p) => p.from === 'fast' && p.kind === 'done' && p.body === 'Fast slice done.'))

        const fastEntries = (await kernel.conversations.getConversationDetail(fast.workerConversationId, { limit: 20 })).entries
        const fastWakeupEntry = fastEntries.find((e) => {
          if (e.kind !== 'helmx.input' || typeof e.data !== 'object' || e.data === null) return false
          const meta = (e.data as { meta?: Record<string, unknown> }).meta
          return meta?.['renderer'] === 'swarm:board-wakeup'
        })
        assert.ok(fastWakeupEntry !== undefined, 'worker must receive structured board-wakeup entry')
        const fastWakeupMeta = (fastWakeupEntry!.data as { meta: Record<string, unknown> }).meta
        assert.ok(Array.isArray(fastWakeupMeta['posts']) && (fastWakeupMeta['posts'] as unknown[]).length >= 1)

        const metaPath = join(env1.dataDir, 'plugins', 'builtin%3Aswarm', 'groups', groupId, 'meta.json')
        const afterFastMeta = JSON.parse(readFileSync(metaPath, 'utf8')) as CollabGroupRecord
        assert.equal(afterFastMeta.lastReportHadActiveWorkers, true, 'lastReportHadActiveWorkers must be persisted to meta.json after fast done report')

        // 2) Dispatch reviewer -> posts review(wake=true) and keeps working in round 2 -> wakes coordinator immediately while both slow & reviewer are working!
        const reviewer = (await kernel.plugins.invokeAction(
          SWARM_PLUGIN_ID,
          'dispatch_worker',
          { prompt: 'Review and ask coordinator while continuing work.', name: 'reviewer' },
          { conversationId: coord.id },
        )) as { workerConversationId: number }
        await reviewerContinuedEntered.promise
        const coordReportText = await reviewCoordSeen.promise
        await kernel.conversations.waitForIdle(coord.id)
        assert.match(coordReportText, /Need coordinator decision now\./)
        assert.match(coordReportText, /activeWorkingMembers:[^\n]*@slow/)
        assert.match(coordReportText, /activeWorkingMembers:[^\n]*@reviewer/)

        const midMeta = JSON.parse(readFileSync(metaPath, 'utf8')) as CollabGroupRecord
        assert.equal(midMeta.lastReportHadActiveWorkers, true, 'lastReportHadActiveWorkers must remain persisted to meta.json')

        // Release reviewer to settle normally while slow still runs, then release slow
        reviewerRelease.resolve()
        await kernel.conversations.waitForIdle(reviewer.workerConversationId)

        // Release slow -> finishes with passive comment -> all workers idle -> stall emits since latest non-comment is review (not done)
        slowRelease.resolve()
        await kernel.conversations.waitForIdle(slow.workerConversationId)
        await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
        await kernel.conversations.waitForIdle(coord.id)
      } finally {
        reviewerRelease.resolve()
        slowRelease.resolve()
      }

      // Un-woken done (wake: false) in a second group must trigger 0-Token [stall] instead of silent deadlock
      const coord2 = await kernel.conversations.createConversation({ title: 'Unwoken Done Coord', profileId: 'assistant', cwd: env1.repoDir })
      const g2 = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Unwoken Done Squad',
        conversationId: coord2.id,
      })) as { groupId: string }
      setSwarmRoleResponses(env1.faux, {
        solo: [
          fauxAssistantMessage(
            [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', wake: false, body: 'Passive done forgotten.' })],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('Solo settled.'),
        ],
        coordinator: [fauxAssistantMessage('Coordinator noted stall from unwoken done.')],
      })
      const solo = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { prompt: 'Finish with passive done.', name: 'solo' },
        { conversationId: coord2.id },
      )) as { workerConversationId: number }
      await waitFor(async () => {
        const read = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId: g2.groupId })) as {
          posts: BoardPost[]
        }
        return read.posts.some((p) => p.from === 'system' && p.kind === 'stall' && p.body.includes('wake=false'))
      }, { timeoutMs: CHAIN_WAIT_MS })
      await kernel.conversations.waitForIdle(solo.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord2.id)

      // Final active worker posts done and settles; coordinator replies to user WITHOUT calling close_group -> exactly 1 report, zero swarm-report-idle
      const coord3 = await kernel.conversations.createConversation({ title: 'No-Close Coord', profileId: 'assistant', cwd: env1.repoDir })
      const g3 = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'No-Close Squad',
        conversationId: coord3.id,
      })) as { groupId: string }
      setSwarmRoleResponses(env1.faux, {
        finisher: [
          fauxAssistantMessage(
            [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'All slices finished, awaiting human merge confirm.' })],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('Finisher settled.'),
        ],
        coordinator: [fauxAssistantMessage('Reported final slice to user without closing group.')],
      })
      const finisher = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId: g3.groupId, prompt: 'Deliver final slice.', name: 'finisher' },
        { conversationId: coord3.id },
      )) as { workerConversationId: number }
      await kernel.conversations.waitForIdle(finisher.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.conversations.waitForIdle(coord3.id)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)

      const coord3Reports = (await kernel.conversations.getConversationDetail(coord3.id, { limit: 30 })).entries.filter(
        (e) => e.kind === 'helmx.input' && JSON.stringify(e.data ?? '').includes('swarm_board_report'),
      )
      assert.equal(coord3Reports.length, 1, 'final worker done without close_group must trigger exactly 1 coordinator report')
      assert.equal(
        coord3Reports.some((e) => (e.data as { id?: string } | undefined)?.id?.startsWith('swarm-report-idle:') === true),
        false,
        'must not emit duplicate swarm-report-idle after final done report',
      )
      const g3MetaPath = join(env1.dataDir, 'plugins', 'builtin%3Aswarm', 'groups', g3.groupId, 'meta.json')
      const g3Meta = JSON.parse(readFileSync(g3MetaPath, 'utf8')) as CollabGroupRecord
      assert.equal(g3Meta.lastReportHadActiveWorkers, undefined, 'lastReportHadActiveWorkers must stay undefined when final report had no active workers')

      // Seed an unrelated turn on coord1 so its completionSeq advances past the pre-crash inflightReport baseCompletionSeq
      env1.faux.setResponses([fauxAssistantMessage('Unrelated human reply.')])
      await kernel.conversations.submitInput(coordId, 'Unrelated user question before restart', { origin: 'human' })
      await kernel.conversations.waitForIdle(coordId)
    } finally {
      await env1.close()
    }

    // ---- Part 3: Authoritative inflightReport recovery (uncommitted despite advanced completionSeq) ----
    const metaPath = join(env1.dataDir, 'plugins', 'builtin%3Aswarm', 'groups', groupId, 'meta.json')
    const boardPath = join(env1.dataDir, 'plugins', 'builtin%3Aswarm', 'groups', groupId, 'board.jsonl')
    const preRestartMeta = JSON.parse(readFileSync(metaPath, 'utf8')) as CollabGroupRecord
    const preRestartPosts = readFileSync(boardPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as BoardPost)
    const doneSeq = preRestartMeta.headSeq + 1
    const newDonePost: BoardPost = {
      seq: doneSeq,
      groupId,
      from: 'fast',
      to: ['coordinator'],
      resolvedTargets: ['coordinator'],
      wake: true,
      kind: 'done',
      refs: [],
      body: 'Uncommitted report must survive unrelated completionSeq bump.',
      createdAt: Date.now(),
    }
    preRestartPosts.push(newDonePost)
    writeFileSync(boardPath, `${preRestartPosts.map((p) => JSON.stringify(p)).join('\n')}\n`, 'utf8')
    preRestartMeta.headSeq = doneSeq
    preRestartMeta.coordinatorPendingSeq = doneSeq
    preRestartMeta.coordinatorNotifiedSeq = doneSeq - 1
    // Simulate crash after writing inflightReport (baseCompletionSeq=0, while coord already completed unrelated turns!)
    preRestartMeta.inflightReport = {
      requestId: `swarm-report:${groupId}:${doneSeq}-${doneSeq}`,
      fromSeq: doneSeq,
      toSeq: doneSeq,
      baseCompletionSeq: 0,
      hadActiveWorkers: false,
    }
    delete preRestartMeta.lastReportHadActiveWorkers
    writeFileSync(metaPath, `${JSON.stringify(preRestartMeta, null, 2)}\n`, 'utf8')

    const recoveredReportSeen = deferred<string>()
    const faux2 = makeFauxProvider({ models: [{ id: 'faux-1' }] })
    faux2.setResponses([
      (ctx) => {
        recoveredReportSeen.resolve(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('Coordinator processed recovered uncommitted report.')
      },
    ])
    const app2 = await openSwarmRuntime({
      dataDir: env1.dataDir,
      cwd: env1.repoDir,
      faux: faux2,
    })
    try {
      const recoveredText = await recoveredReportSeen.promise
      assert.match(recoveredText, /Uncommitted report must survive unrelated completionSeq bump\./)
      await waitFor(() => app2.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await app2.kernel.conversations.waitForIdle(coordId)
    } finally {
      await app2.close()
    }

    // ---- Part 4: Persisted lastReportHadActiveWorkers idle catch-up across restart even with trailing passive comment ----
    const metaAfterPart3 = JSON.parse(readFileSync(metaPath, 'utf8')) as CollabGroupRecord
    const postsAfterPart3 = readFileSync(boardPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as BoardPost)
    const commentSeq = metaAfterPart3.headSeq + 1
    postsAfterPart3.push({
      seq: commentSeq,
      groupId,
      from: 'slow',
      to: ['coordinator'],
      resolvedTargets: ['coordinator'],
      wake: false,
      kind: 'comment',
      refs: [doneSeq],
      body: 'Trailing passive comment after done.',
      createdAt: Date.now(),
    })
    writeFileSync(boardPath, `${postsAfterPart3.map((p) => JSON.stringify(p)).join('\n')}\n`, 'utf8')
    metaAfterPart3.headSeq = commentSeq
    metaAfterPart3.coordinatorPendingSeq = doneSeq
    metaAfterPart3.coordinatorNotifiedSeq = doneSeq
    metaAfterPart3.lastReportHadActiveWorkers = true
    for (const m of metaAfterPart3.members) {
      if (m.conversationId === slowId || m.conversationId === fastId) {
        m.readCursorSeq = commentSeq
        m.pendingWakeupSeq = commentSeq
        m.lastPostSeq = commentSeq
        if (m.conversationId === slowId) delete m.lastWakeTaskSeq
      }
    }
    writeFileSync(metaPath, `${JSON.stringify(metaAfterPart3, null, 2)}\n`, 'utf8')

    const catchupSeen = deferred<string>()
    const faux3 = makeFauxProvider({ models: [{ id: 'faux-1' }] })
    faux3.setResponses([
      (ctx) => {
        catchupSeen.resolve(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('Coordinator received restarted idle catch-up.')
      },
    ])
    const app3 = await openSwarmRuntime({
      dataDir: env1.dataDir,
      cwd: env1.repoDir,
      faux: faux3,
    })
    try {
      const catchupText = await catchupSeen.promise
      assert.match(catchupText, /Uncommitted report must survive unrelated completionSeq bump\./)
      assert.match(catchupText, /Trailing passive comment after done\./)
      assert.match(catchupText, /activeWorkingMembers: \(none\)/)
      await waitFor(() => app3.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await app3.kernel.conversations.waitForIdle(coordId)

      const finalMeta = JSON.parse(readFileSync(metaPath, 'utf8')) as CollabGroupRecord
      assert.equal(finalMeta.lastReportHadActiveWorkers, undefined, 'lastReportHadActiveWorkers must clear after idle catch-up')

      const app3CoordEntries = (await app3.kernel.conversations.getConversationDetail(coordId, { limit: 30 })).entries
      const idleCatchupEntry = app3CoordEntries.find((e) => {
        if (e.kind !== 'helmx.input' || typeof e.data !== 'object' || e.data === null) return false
        const data = e.data as { id?: string; meta?: Record<string, unknown> }
        return data.id?.startsWith('swarm-report-idle:') === true && data.meta?.['renderer'] === 'swarm:board-report'
      })
      assert.ok(idleCatchupEntry !== undefined, 'idle catch-up must persist swarm:board-report entry')
      const idleCatchupMeta = (idleCatchupEntry!.data as { meta: Record<string, unknown> }).meta
      assert.equal('headline' in idleCatchupMeta, false, 'idle catch-up meta must not carry legacy headline')
      assert.equal(idleCatchupMeta['idleCatchup'], true)
      assert.equal(idleCatchupMeta['activeWorkingMembers'], undefined)
      const catchupPosts = idleCatchupMeta['posts'] as Array<{ kind: string; body: string }>
      assert.ok(catchupPosts.some((p) => p.body.includes('Uncommitted report must survive unrelated completionSeq bump.')))
      assert.ok(catchupPosts.some((p) => p.kind === 'comment' && p.body === 'Trailing passive comment after done.'))
    } finally {
      await app3.close()
    }
  })

  test('swarm-int16: Orchestrator + Swarm integration keeps SWARM_TOOL_NAMES in planning phase, keeps coordinator on Planner, inherits executorModel with atomic ownedBy=helmx, and honors explicit worker model', { timeout: 60_000 }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'helmx-swarm-orch-it-'))
    const repoDir = join(root, 'repo')
    const dataDir = join(root, 'data')
    gitTemplate.cloneTo(repoDir)

    const faux = makeFauxProvider({
      models: [
        { id: 'flagship', name: 'Flagship', reasoning: true },
        { id: 'coder', name: 'Coder', reasoning: true },
        { id: 'fast', name: 'Fast', reasoning: true },
      ],
    })
    const kernel = await KernelRuntime.open({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: repoDir,
      model: 'faux/flagship',
      providers: [faux.provider],
      autoResume: false,
    })
    t.after(async () => {
      await kernel.close().catch(() => {})
      rmSync(root, { recursive: true, force: true })
    }, { timeout: 60_000 })

    await kernel.plugins.register(createProfilePlugin())
    await kernel.plugins.register(createWorkflowPlugin())
    await kernel.plugins.register(createWorktreePlugin())
    await kernel.plugins.register(createTiersPlugin())
    await kernel.plugins.register(createOrchestratorPlugin())
    await kernel.plugins.register(createSwarmPlugin())
    await kernel.start()

    // Verify builtin:swarm exposes all SWARM_TOOL_NAMES via PLANNING_ORCHESTRATION_TOOLS_CAPABILITY_ID
    const planningCaps = kernel.plugins.consumeCapability<PlanningOrchestrationToolsCapability>(
      PLANNING_ORCHESTRATION_TOOLS_CAPABILITY_ID,
    )
    const swarmPlanCap = planningCaps.find((entry) => entry.pluginId === SWARM_PLUGIN_ID)
    assert.ok(swarmPlanCap, 'builtin:swarm must provide PLANNING_ORCHESTRATION_TOOLS_CAPABILITY_ID')
    for (const toolName of SWARM_TOOL_NAMES) {
      assert.ok(swarmPlanCap!.impl.toolNames.includes(toolName), `planning orchestration whitelist must include ${toolName}`)
    }

    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'coder',
      model: 'faux/coder',
      thinkingLevel: 'low',
    })
    await kernel.plugins.invokeAction(ORCHESTRATOR_PLUGIN_ID, 'set', {
      id: 'coord_pair',
      name: 'Coordinator Pair',
      plannerModel: 'faux/flagship',
      executorModel: 'tier/coder',
    })

    const coord = await kernel.conversations.createConversation({
      title: 'Orchestrator Swarm Coordinator',
      profileId: 'assistant',
      model: 'tier/coord_pair',
      cwd: repoDir,
    })

    const observed: Array<{
      who: string
      modelId: string
      toolNames: string[]
      sectionsById: Record<string, string>
    }> = []
    let createdGroup = false
    let dispatchedWorkers = false
    const workerSteps = new Map<string, number>()

    const router: FauxResponseStep = (ctx, _opts, _state, model) => {
      const meta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
      const groupSec = meta.sectionsById['swarm.active_group'] ?? ''
      const workerMatch = /role="worker" name="([^"]+)"/.exec(groupSec)
      const modelId = `${model.provider}/${model.id}`

      if (workerMatch) {
        const workerName = workerMatch[1]!
        const stepIdx = workerSteps.get(workerName) ?? 0
        workerSteps.set(workerName, stepIdx + 1)
        observed.push({ who: workerName, modelId, ...meta })
        if (stepIdx === 0) {
          return fauxAssistantMessage(
            [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: `${workerName} finished.` })],
            { stopReason: 'toolUse' },
          )
        }
        return fauxAssistantMessage(`${workerName} acknowledged.`)
      }

      observed.push({ who: 'coordinator', modelId, ...meta })
      if (!createdGroup) {
        createdGroup = true
        return fauxAssistantMessage(
          [fauxToolCall('swarm_create_group', { title: 'Orchestrator Swarm Squad' })],
          { stopReason: 'toolUse' },
        )
      }
      if (!dispatchedWorkers) {
        dispatchedWorkers = true
        return fauxAssistantMessage(
          [
            fauxToolCall('swarm_dispatch_worker', { name: 'auto_w', prompt: 'Implement inherited slice.' }, { id: 'call_auto' }),
            fauxToolCall('swarm_dispatch_worker', { name: 'fast_w', prompt: 'Implement explicit fast slice.', model: 'faux/fast' }, { id: 'call_fast' }),
          ],
          { stopReason: 'toolUse' },
        )
      }
      return fauxAssistantMessage('Coordinator synthesized squad reports.')
    }
    faux.setResponses(Array.from({ length: 16 }, () => router))

    await kernel.conversations.submitInput(coord.id, 'Plan and orchestrate two workers')
    await kernel.conversations.waitForIdle(coord.id)
    await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0, { timeoutMs: CHAIN_WAIT_MS })
    await kernel.conversations.waitForIdle(coord.id)

    const coordSteps = observed.filter((entry) => entry.who === 'coordinator')
    assert.ok(coordSteps.length >= 2, 'coordinator must execute at least planning + dispatch turns')
    const initialPlanningStep = coordSteps[0]!
    assert.ok(initialPlanningStep.sectionsById[ORCHESTRATOR_PLAN_SECTION_ID] !== undefined, 'step 1 must run in Orchestrator planning phase')
    assert.equal(initialPlanningStep.toolNames.includes('write'), false, 'Orchestrator planning phase must still strip coding tools')
    assert.ok(initialPlanningStep.toolNames.includes('swarm_create_group'), 'Orchestrator planning phase must keep swarm_create_group')
    const postGroupStep = coordSteps[1]!
    for (const toolName of SWARM_TOOL_NAMES.filter((name) => name !== 'swarm_create_group')) {
      assert.ok(postGroupStep.toolNames.includes(toolName), `coordinator step must expose ${toolName}`)
    }
    assert.ok(coordSteps.every((step) => step.modelId === 'faux/flagship'), 'coordinator must always stay on Planner model')

    const childConvs = kernel.conversations.listConversations({ parentConversationId: coord.id })
    const autoConv = childConvs.find((c) => c.title.includes('@auto_w'))
    const fastConv = childConvs.find((c) => c.title.includes('@fast_w'))
    assert.ok(autoConv && fastConv, 'both workers must exist as child conversations')
    await kernel.conversations.waitForIdle(autoConv!.id)
    await kernel.conversations.waitForIdle(fastConv!.id)

    assert.equal(kernel.conversations.getConversation(autoConv!.id).ownedBy, 'helmx', 'auto_w must be atomically owned by helmx')
    assert.equal(kernel.conversations.getConversation(fastConv!.id).ownedBy, 'helmx', 'fast_w must be atomically owned by helmx')
    assert.equal(autoConv!.model, 'faux/coder', 'worker omitting model must inherit Orchestrator executorModel')
    assert.equal(fastConv!.model, 'faux/fast', 'worker with explicit model must override Orchestrator executorModel')

    const autoSteps = observed.filter((entry) => entry.who === 'auto_w')
    const fastSteps = observed.filter((entry) => entry.who === 'fast_w')
    assert.ok(autoSteps.length >= 1 && autoSteps.every((s) => s.modelId === 'faux/coder'), 'auto_w runtime must run on faux/coder')
    assert.ok(fastSteps.length >= 1 && fastSteps.every((s) => s.modelId === 'faux/fast'), 'fast_w runtime must run on faux/fast')

    // Follow-up coordinator turn retains Planner posture & suppresses Orchestrator plan/execute prompts
    const beforeFollowUp = observed.length
    await kernel.conversations.submitInput(coord.id, 'Review worker progress')
    await kernel.conversations.waitForIdle(coord.id)
    const followUpCoord = observed.slice(beforeFollowUp).filter((entry) => entry.who === 'coordinator')
    assert.ok(followUpCoord.length >= 1)
    assert.equal(followUpCoord[0]!.modelId, 'faux/flagship')
    assert.equal(followUpCoord[0]!.sectionsById[ORCHESTRATOR_PLAN_SECTION_ID], undefined)
    assert.equal(followUpCoord[0]!.sectionsById[ORCHESTRATOR_EXECUTE_SECTION_ID], undefined)
  })
})
