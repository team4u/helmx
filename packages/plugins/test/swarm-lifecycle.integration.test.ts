/**
 * `builtin:swarm` 生命周期、激活与索引治理组合层集成测试（Integration 档）：
 * 1) 默认启用、启动零常驻会话、空闲态不阻塞 disable('builtin:workflow' / 'builtin:worktree')、
 *    受管技能 swarm 随启停显隐、create_group 同回合下一拍解锁团队工具且不剥离常规工具、
 *    扩缩容期间 <active_swarm_group> 100% 字节恒定、inUse 保护；
 * 2) /skill:swarm 激活闭环（自动建组与同回合解锁、幂等复用、成员/子会话拦截、非匹配直通）；
 * 3) 外部 runtime 与非法 nodeId 拒绝、扁平 forkFrom、skills 白名单门禁、有界索引懒加载与工具结构化信封。
 */
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'

import {
  HelmxError,
  validateOrThrow,
  type ConversationSummary,
  type PluginClientContext as PluginClientContextType,
  type ToolViewProps,
} from '@helmx/protocol'
import {
  CLIENT_SHARED_GLOBALS,
  compilePluginClientModule,
} from '@helmx/plugin-build'
import { waitFor } from '@helmx/test-kit'
import { useTempDir } from '@helmx/test-kit/node'
import { createGitTemplate } from '@helmx/test-kit/git'
import { actionToolResult } from '../../kernel/src/runtime/runtime-helpers.js'
import {
  WORKFLOW_ID,
  WORKTREE_ID,
  captureRequestMeta,
  openSwarmEnv,
  setSwarmRoleResponses,
} from './helpers/swarm-integration-env.js'
import {
  COORDINATOR_TAG,
  SWARM_PLUGIN_ID,
  SWARM_SKILL_ID,
  WORKER_TAG,
  type BoardPost,
  type BoardViewDoc,
  type SwarmIndexDoc,
} from '../src/swarm.js'
import { swarmToolPresentationMetaSchema } from '../src/swarm/action-schemas.js'

describe('builtin:swarm lifecycle, activation & index governance', () => {
  const gitTemplate = createGitTemplate()
  after(() => gitTemplate.cleanup())

  test('swarm-int1: default-enabled zero-resident boot, idle workflow-disable freedom, swarm skill lifecycle, same-turn tool unlock, byte-constant <active_swarm_group>, and inUse guard', { timeout: 60_000 }, async (t) => {
    const env = await openSwarmEnv(useTempDir(t, 'helmx-swarm-int-'), gitTemplate)
    try {
      const { kernel } = env.app

      // 1) Default-enabled in createHelmx, zero background resident conversations created on boot!
      const swarmSummary = kernel.plugins.list().find((p) => p.id === SWARM_PLUGIN_ID)
      assert.ok(swarmSummary, 'createHelmx must register builtin:swarm')
      assert.equal(swarmSummary!.enabled, true, 'builtin:swarm must be default-enabled')
      const bootConvs = kernel.listConversations()
      assert.equal(
        bootConvs.some((c) => c.ownedBy === 'helmx' || c.tags.includes(COORDINATOR_TAG) || c.tags.includes(WORKER_TAG)),
        false,
        'builtin:swarm must NOT create any global resident conversations on boot',
      )

      // 2) Idle workflow/worktree disable freedom:
      //    - Idle builtin:swarm has NO static dependency on builtin:workflow / builtin:worktree -> disabling & re-enabling both succeeds!
      await kernel.plugins.disable(WORKFLOW_ID)
      assert.equal(kernel.plugins.list().find((p) => p.id === WORKFLOW_ID)?.enabled, false)
      await kernel.plugins.enable(WORKFLOW_ID)
      assert.equal(kernel.plugins.list().find((p) => p.id === WORKFLOW_ID)?.enabled, true)
      await kernel.plugins.disable(WORKTREE_ID)
      assert.equal(kernel.plugins.list().find((p) => p.id === WORKTREE_ID)?.enabled, false)
      await kernel.plugins.enable(WORKTREE_ID)
      assert.equal(kernel.plugins.list().find((p) => p.id === WORKTREE_ID)?.enabled, true)

      const coord = await kernel.createConversation({ title: 'Feature Chat', profileId: 'assistant', cwd: env.repoDir })

      // 3) swarm managed skill is available while builtin:swarm is enabled, with no duplicate ui.command
      assert.equal(SWARM_SKILL_ID, 'swarm')
      assert.equal(
        kernel.plugins.listUi().filter((u) => u.pluginId === SWARM_PLUGIN_ID && u.surface === 'commandPalette').length,
        0,
        'builtin:swarm must not register duplicate ui.command',
      )
      const loadedSkill = (await kernel.plugins.executeTool(
        'load_skill',
        { skillId: SWARM_SKILL_ID },
        { conversationId: coord.id },
      )) as { text: string }
      assert.match(loadedSkill.text, /Coordinator Rule: Do Not Do the Work/)
      for (const toolName of [
        'swarm_create_group',
        'swarm_update_group',
        'swarm_dispatch_worker',
        'swarm_board_post',
        'swarm_board_read',
        'swarm_board_status',
        'swarm_inspect_worker',
        'swarm_abort_worker',
        'swarm_switch_worker_model',
        'swarm_archive_worker',
        'swarm_close_group',
      ]) {
        assert.ok(loadedSkill.text.includes(toolName), `swarm SKILL.md should document ${toolName}`)
      }
      assert.match(loadedSkill.text, /helmx swarm/)

      // 4) Before swarm_create_group: #C sees swarm_create_group + subagent/bash/edit/write, NOT swarm_dispatch_worker/swarm_board_*
      const preCapture: Array<{ toolNames: string[]; sectionsById: Record<string, string> }> = []
      env.faux.setResponses([
        (ctx) => {
          preCapture.push(captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[]))
          return fauxAssistantMessage([fauxToolCall('swarm_create_group', { title: 'API Squad', objective: 'Ship v2 API' })], {
            stopReason: 'toolUse',
          })
        },
        (ctx) => {
          // Same turn, very next LLM request after swarm_create_group!
          preCapture.push(captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[]))
          return fauxAssistantMessage('Group created and squad tools unlocked.')
        },
      ])

      await kernel.submitInput(coord.id, 'Start a squad')
      await kernel.waitForIdle(coord.id)
      assert.equal(preCapture.length, 2)

      const beforeTools = preCapture[0]!.toolNames
      assert.ok(beforeTools.includes('swarm_create_group'))
      assert.ok(beforeTools.includes('subagent'))
      assert.ok(beforeTools.includes('bash'))
      assert.equal(beforeTools.includes('swarm_dispatch_worker'), false)
      assert.equal(beforeTools.includes('swarm_board_post'), false)
      assert.equal(preCapture[0]!.sectionsById['swarm.active_group'], undefined)

      // Next beat inside the SAME turn: squad tools unlocked, swarm_create_group hidden, general tools preserved!
      const afterTools = preCapture[1]!.toolNames
      for (const expected of [
        'swarm_update_group',
        'swarm_dispatch_worker',
        'swarm_board_post',
        'swarm_board_read',
        'swarm_board_status',
        'swarm_abort_worker',
        'swarm_switch_worker_model',
        'swarm_inspect_worker',
        'swarm_archive_worker',
        'swarm_close_group',
        'subagent',
        'SubagentWorkflow',
        'bash',
        'edit',
        'write',
      ]) {
        assert.ok(afterTools.includes(expected), `expected ${expected} available after swarm_create_group (actual: ${afterTools.join(',')})`)
      }
      assert.equal(afterTools.includes('swarm_create_group'), false, 'expected swarm_create_group hidden on active coordinator')
      const sectionInitial = preCapture[1]!.sectionsById['swarm.active_group']
      assert.ok(typeof sectionInitial === 'string' && sectionInitial.includes('<active_swarm_group'))

      // Duplicate create_group on the same coordinator returns 409 swarm_group_already_active
      await assert.rejects(
        () => kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', { title: 'Second', conversationId: coord.id }),
        (err: unknown) => err instanceof HelmxError && err.code === 'swarm_group_already_active' && err.status === 409,
      )

      // Active group blocks non-force disable of builtin:swarm via inUse()
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await assert.rejects(
        () => kernel.plugins.disable(SWARM_PLUGIN_ID),
        (err: unknown) => err instanceof HelmxError && err.code === 'plugin_in_use' && err.status === 409,
      )

      // 5) Recruit 2 members, mutate group title/objective, archive 1 member -> coordinator <active_swarm_group> stays 100% byte-identical!
      setSwarmRoleResponses(env.faux, {
        alpha: [
          fauxAssistantMessage([fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'comment', body: 'w1 booted' })], { stopReason: 'toolUse' }),
          fauxAssistantMessage('w1 idle'),
        ],
        beta: [
          fauxAssistantMessage([fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'comment', body: 'w2 booted' })], { stopReason: 'toolUse' }),
          fauxAssistantMessage('w2 idle'),
        ],
        coordinator: [fauxAssistantMessage('Coordinator noted idle boot comments.')],
      })
      const w1 = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { prompt: 'Role 1', name: 'alpha' },
        { conversationId: coord.id },
      )) as { workerConversationId: number; groupId: string }
      const w2 = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { prompt: 'Role 2', name: 'beta' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }
      await kernel.waitForIdle(w1.workerConversationId)
      await kernel.waitForIdle(w2.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.waitForIdle(coord.id)

      const indexDoc = kernel.plugins.getPublicDoc(SWARM_PLUGIN_ID, 'index').value as SwarmIndexDoc
      assert.equal(indexDoc.workers.length, 2)
      assert.equal(indexDoc.workers[0]!.coordinatorConversationId, coord.id)

      await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'update_group',
        { groupId: w1.groupId, title: 'Renamed API Squad', objective: 'Updated objective text' },
        { conversationId: coord.id },
      )
      await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'archive_worker',
        { groupId: w1.groupId, name: 'beta' },
        { conversationId: coord.id },
      )

      let sectionAfterScaling: string | undefined
      setSwarmRoleResponses(env.faux, {
        coordinator: [
          (ctx) => {
            sectionAfterScaling = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[]).sectionsById['swarm.active_group']
            return fauxAssistantMessage([fauxToolCall('bash', { command: 'echo quick-lookup-ok' })], { stopReason: 'toolUse' })
          },
          fauxAssistantMessage('Quick lookup finished.'),
        ],
      })
      await kernel.submitInput(coord.id, 'Check prompt cache stability')
      await kernel.waitForIdle(coord.id)

      assert.equal(sectionAfterScaling, sectionInitial, 'active_swarm_group section must stay 100% byte-constant across member scaling and metadata edits')
      const detail = await kernel.getConversationDetail(coord.id, { limit: 10 })
      assert.match(JSON.stringify(detail.entries), /quick-lookup-ok/, 'coordinator retains bash for lightweight lookups')

      // Close group -> skill disappears once plugin is disabled
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId: w1.groupId }, { conversationId: coord.id })
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.plugins.disable(SWARM_PLUGIN_ID)
      await assert.rejects(
        () => kernel.plugins.executeTool('load_skill', { skillId: SWARM_SKILL_ID }, { conversationId: coord.id }),
        (err: unknown) => err instanceof HelmxError && err.code === 'skill_not_available',
      )
    } finally {
      await env.close()
    }
  })

  test('swarm-int5: /skill:swarm activation loop (task auto-create + same-turn tools, empty/idempotent reuse, worker/child block, non-matching passthrough)', { timeout: 60_000 }, async (t) => {
    const env = await openSwarmEnv(useTempDir(t, 'helmx-swarm-slash-'), gitTemplate)
    try {
      const { kernel } = env.app

      // 1) Non-/skill:swarm inputs (including plain /swarm) pass through untouched without creating any group
      const plainConv = await kernel.createConversation({ title: 'Normal Chat', profileId: 'assistant', cwd: env.repoDir })
      let plainSawText = ''
      env.faux.setResponses([
        (ctx) => {
          plainSawText = JSON.stringify(ctx.messages)
          return fauxAssistantMessage('Normal reply.')
        },
        (ctx) => {
          plainSawText = JSON.stringify(ctx.messages)
          return fauxAssistantMessage('Second normal reply.')
        },
        (ctx) => {
          plainSawText = JSON.stringify(ctx.messages)
          return fauxAssistantMessage('Third normal reply.')
        },
      ])
      await kernel.submitInput(plainConv.id, '/skill:swarming check')
      await kernel.waitForIdle(plainConv.id)
      assert.match(plainSawText, /\/skill:swarming check/)
      assert.equal(kernel.getConversation(plainConv.id).tags.includes(COORDINATOR_TAG), false)

      await kernel.submitInput(plainConv.id, 'please explain /skill:swarm syntax')
      await kernel.waitForIdle(plainConv.id)
      assert.match(plainSawText, /please explain \/skill:swarm syntax/)
      assert.equal(kernel.getConversation(plainConv.id).tags.includes(COORDINATOR_TAG), false)

      await kernel.submitInput(plainConv.id, '/swarm legacy prefix should not trigger')
      await kernel.waitForIdle(plainConv.id)
      assert.match(plainSawText, /\/swarm legacy prefix should not trigger/)
      assert.equal(kernel.getConversation(plainConv.id).tags.includes(COORDINATOR_TAG), false)

      // 2) Sending `/skill:swarm <task>` on a blank top-level human conversation auto-creates group, tags coordinator, keeps clean user bubble/title, and injects system guide
      const coord = await kernel.createConversation({ title: '', profileId: 'assistant', cwd: env.repoDir })
      let turnMeta: { toolNames: string[]; sectionsById: Record<string, string>; userText: string } | undefined
      let workerDispatched = false
      setSwarmRoleResponses(env.faux, {
        coordinator: [
          (ctx) => {
            const meta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
            turnMeta = {
              ...meta,
              userText: JSON.stringify(ctx.messages),
            }
            return fauxAssistantMessage(
              [
                fauxToolCall('swarm_dispatch_worker', {
                  prompt: 'Implement token helper and report done.',
                  name: 'author',
                  access: 'readwrite',
                  isolation: 'worktree',
                }),
              ],
              { stopReason: 'toolUse' },
            )
          },
          fauxAssistantMessage('Coordinator dispatched @author.'),
          fauxAssistantMessage('Coordinator received @author done.'),
        ],
        author: [
          () => {
            workerDispatched = true
            return fauxAssistantMessage(
              [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Implemented cleanly.' })],
              { stopReason: 'toolUse' },
            )
          },
          fauxAssistantMessage('Author finished.'),
        ],
      })

      await kernel.submitInput(coord.id, '/skill:swarm 重构鉴权模块并交叉验收')
      await kernel.waitForIdle(coord.id)
      await waitFor(() => workerDispatched)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.waitForIdle(coord.id)

      assert.ok(turnMeta !== undefined)
      const coordSummary = kernel.getConversation(coord.id)
      assert.equal(coordSummary.tags.includes(COORDINATOR_TAG), true)
      assert.equal(coordSummary.title, '/skill:swarm 重构鉴权模块并交叉验收', 'auto-title must derive from clean user input')
      const coordDetail = await kernel.getConversationDetail(coord.id, { limit: 20 })
      const firstHumanInput = coordDetail.entries.find((e) => e.kind === 'helmx.input')
      assert.equal(
        (firstHumanInput?.data as { text?: string } | undefined)?.text,
        '/skill:swarm 重构鉴权模块并交叉验收',
        'helmx.input must preserve original /skill:swarm text verbatim without system-prompt wall',
      )
      for (const expected of ['swarm_update_group', 'swarm_dispatch_worker', 'swarm_board_post', 'swarm_board_read', 'swarm_close_group', 'bash', 'edit', 'write', 'subagent', 'SubagentWorkflow']) {
        assert.ok(turnMeta.toolNames.includes(expected), `expected ${expected} exposed on turn 1 after /skill:swarm`)
      }
      assert.equal(turnMeta.toolNames.includes('swarm_create_group'), false, 'expected swarm_create_group hidden on turn 1 after /skill:swarm')
      const coordSection = turnMeta.sectionsById['swarm.active_group'] ?? ''
      assert.match(coordSection, /^<active_swarm_group id="[^"]+" role="coordinator">/)
      assert.match(coordSection, /load_skill\(\{ skillId: "swarm" \}\)/)
      assert.match(coordSection, /never follow fixed role-name templates/)
      assert.match(coordSection, /swarm_dispatch_worker/)
      assert.match(turnMeta.userText, /\/skill:swarm 重构鉴权模块并交叉验收/)

      const indexDoc = kernel.plugins.getPublicDoc(SWARM_PLUGIN_ID, 'index').value as SwarmIndexDoc
      const coordGroup = indexDoc.groups.find((g) => g.coordinatorConversationId === coord.id && g.status === 'active')
      assert.ok(coordGroup !== undefined, 'active group created for /skill:swarm coordinator')
      assert.equal(coordGroup.title, '重构鉴权模块并交叉验收')

      // 3) Sending `/skill:swarm <followup>` again in the same active coordinator reuses the existing group idempotently and keeps user text verbatim
      let secondPromptText = ''
      setSwarmRoleResponses(env.faux, {
        coordinator: [
          (ctx) => {
            secondPromptText = JSON.stringify(ctx.messages.slice(-2))
            return fauxAssistantMessage('Reused active group cleanly.')
          },
        ],
      })
      await kernel.submitInput(coord.id, '/skill:swarm 补充单测覆盖')
      await kernel.waitForIdle(coord.id)
      assert.match(secondPromptText, /\/skill:swarm 补充单测覆盖/)
      const indexAfterSecond = kernel.plugins.getPublicDoc(SWARM_PLUGIN_ID, 'index').value as SwarmIndexDoc
      assert.equal(
        indexAfterSecond.groups.filter((g) => g.coordinatorConversationId === coord.id && g.status === 'active').length,
        1,
        'must reuse existing active group without creating duplicate',
      )

      // 4) Sending `/skill:swarm` on a worker or child sub-conversation is explicitly blocked by onInput
      const workerId = indexAfterSecond.workers.find((w) => w.groupId === coordGroup.id)!.conversationId
      await assert.rejects(
        () => kernel.submitInput(workerId, '/skill:swarm nested attempt'),
        (err: unknown) =>
          err instanceof HelmxError &&
          err.code === 'input_blocked' &&
          err.message.includes('不能在子成员或后台会话中使用 /skill:swarm 发起协同'),
      )
      const childConv = await kernel.createConversation({
        title: 'Child Chat',
        profileId: 'assistant',
        cwd: env.repoDir,
        parentConversationId: plainConv.id,
      })
      await assert.rejects(
        () => kernel.submitInput(childConv.id, '/skill:swarm child attempt'),
        (err: unknown) =>
          err instanceof HelmxError &&
          err.code === 'input_blocked' &&
          err.message.includes('不能在子成员或后台会话中使用 /skill:swarm 发起协同'),
      )

      // 5) Plain `/skill:swarm` (no arguments) on a top-level human conversation activates group, keeps '/skill:swarm' verbatim, and injects ask-for-task system guidance
      const emptyArgCoord = await kernel.createConversation({ title: 'Standby Swarm Topic', profileId: 'assistant', cwd: env.repoDir })
      let emptyArgSection = ''
      let emptyArgMessages = ''
      env.faux.setResponses([
        (ctx) => {
          emptyArgSection =
            captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[]).sectionsById['swarm.active_group'] ?? ''
          emptyArgMessages = JSON.stringify(ctx.messages)
          return fauxAssistantMessage('请告诉我本次协同目标任务。')
        },
      ])
      await kernel.submitInput(emptyArgCoord.id, '/skill:swarm')
      await kernel.waitForIdle(emptyArgCoord.id)
      assert.equal(kernel.getConversation(emptyArgCoord.id).tags.includes(COORDINATOR_TAG), true)
      assert.match(emptyArgSection, /load_skill\(\{ skillId: "swarm" \}\)/)
      assert.match(emptyArgSection, /briefly ask what task to coordinate/)
      assert.match(emptyArgMessages, /"\/skill:swarm"/)
      const emptyArgDetail = await kernel.getConversationDetail(emptyArgCoord.id, { limit: 10 })
      const emptyArgInput = emptyArgDetail.entries.find((e) => e.kind === 'helmx.input')
      assert.equal((emptyArgInput?.data as { text?: string } | undefined)?.text, '/skill:swarm')
      const emptyArgIndex = kernel.plugins.getPublicDoc(SWARM_PLUGIN_ID, 'index').value as SwarmIndexDoc
      const emptyArgGroup = emptyArgIndex.groups.find((g) => g.coordinatorConversationId === emptyArgCoord.id && g.status === 'active')
      assert.ok(emptyArgGroup !== undefined)
      assert.equal(emptyArgGroup.title, 'Standby Swarm Topic')
    } finally {
      await env.close()
    }
  })

  test('swarm-int12: external runtime & nodeId rejection, flat forkFrom, skill whitelist gating, bounded index lazy load & prompt metadata', { timeout: 60_000 }, async (t) => {
    const env = await openSwarmEnv(useTempDir(t, 'helmx-swarm-int8-'), gitTemplate)
    try {
      const { kernel } = env.app
      // Restricted profile without swarm skill
      await kernel.services.profiles.save({
        id: 'no-swarm-skill',
        name: 'No Swarm Skill',
        skills: [],
      })

      const noSkillCoord = await kernel.createConversation({
        title: 'Restricted Coord',
        profileId: 'no-swarm-skill',
        cwd: env.repoDir,
      })
      await assert.rejects(
        () => kernel.submitInput(noSkillCoord.id, '/skill:swarm try orchestrating'),
        (err: unknown) => err instanceof HelmxError && err.code === 'input_blocked',
        'Profile with skills=[] must block /skill:swarm trigger',
      )

      // Even if create_group is called directly, active section omits phantom load_skill instruction
      const { groupId: noSkillGroupId } = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Direct Group No Skill',
        conversationId: noSkillCoord.id,
      })) as { groupId: string }
      let noSkillCoordSection = ''
      let availableActionsInCoordTurn = ''
      let coordToolsInTurn: string[] = []
      env.faux.setResponses([
        (ctx) => {
          const meta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
          noSkillCoordSection = meta.sectionsById['swarm.active_group'] ?? ''
          availableActionsInCoordTurn = meta.sectionsById['prompt.actions'] ?? ''
          coordToolsInTurn = meta.toolNames
          return fauxAssistantMessage('Noted without skill.')
        },
      ])
      await kernel.submitInput(noSkillCoord.id, 'Check sections')
      await kernel.waitForIdle(noSkillCoord.id)
      assert.equal(noSkillCoordSection.includes('load_skill('), false)
      assert.equal(availableActionsInCoordTurn.includes('complete_board_members'), false, 'visibility:ui hides UI completer from <available_actions>')
      assert.equal(availableActionsInCoordTurn.includes('list_mentionable'), false, 'exposeToPrompt:false hides profile @ completer')
      assert.ok(coordToolsInTurn.includes('swarm_update_group'), 'coordinator updates group directly via exposeAsTool derived tool')
      assert.equal(availableActionsInCoordTurn.includes('builtin:swarm.update_group'), false, 'exposeAsTool action is not duplicated in <available_actions>')
      await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId: noSkillGroupId }, { conversationId: noSkillCoord.id })

      // 2) Dispatch validation & flat forkFrom & structuredOutput tool envelope
      const coord = await kernel.createConversation({ title: 'Flat Coord', profileId: 'assistant', cwd: env.repoDir })
      const { groupId } = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Flat Squad',
        conversationId: coord.id,
      })) as { groupId: string }

      // Invalid nodeId format rejects 400 validation_error; remote nodeId without cwd rejects 400 validation_error; offline remote nodeId with cwd rejects 409 node_offline
      await assert.rejects(
        () =>
          kernel.plugins.invokeAction(
            SWARM_PLUGIN_ID,
            'dispatch_worker',
            { groupId, name: 'badnode', prompt: 'Should fail', nodeId: '../bad-node' },
            { conversationId: coord.id },
          ),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
      )
      await assert.rejects(
        () =>
          kernel.plugins.invokeAction(
            SWARM_PLUGIN_ID,
            'dispatch_worker',
            { groupId, name: 'nocwdnode', prompt: 'Should fail', nodeId: 'nonexistent-node' },
            { conversationId: coord.id },
          ),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
      )
      await assert.rejects(
        () =>
          kernel.plugins.invokeAction(
            SWARM_PLUGIN_ID,
            'dispatch_worker',
            { groupId, name: 'offlinenode', prompt: 'Should fail', nodeId: 'nonexistent-node', cwd: '/remote/work' },
            { conversationId: coord.id },
          ),
        (err: unknown) => err instanceof HelmxError && err.code === 'node_offline' && err.status === 409,
      )

      env.faux.setResponses([
        fauxAssistantMessage('Alpha settled reply'),
        fauxAssistantMessage('Beta forked settled reply'),
        fauxAssistantMessage('Coordinator noted stalls'),
        fauxAssistantMessage('Coordinator noted stalls'),
      ])
      const alpha = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId, name: 'alpha', prompt: 'Seed alpha conversation' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }
      await kernel.waitForIdle(alpha.workerConversationId)

      const beta = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId, name: 'beta', prompt: 'Fork from peer alpha', forkFrom: 'alpha' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }
      await kernel.waitForIdle(beta.workerConversationId)
      assert.equal(
        kernel.getConversation(beta.workerConversationId).parentConversationId,
        coord.id,
        'forkFrom peer must keep flat parentConversationId pointing to coordinator',
      )

      // Derived action tool envelope verification: swarm_board_status formats concise text + validated structuredOutput
      const statusSpec = kernel.plugins.listTools().find((t) => t.name === 'swarm_board_status')
      assert.ok(statusSpec && statusSpec.sourceKind === 'action')
      const rawStatus = await kernel.plugins.executeTool(
        'swarm_board_status',
        { groupId },
        { conversationId: coord.id },
      )
      const toolRes = actionToolResult(rawStatus, { groupId }, (text) => text, {
        structuredOutputSchema: statusSpec.structuredOutputSchema,
        presentationMetaSchema: statusSpec.presentationMetaSchema,
        projectPresentationMeta: statusSpec.projectPresentationMeta,
        formatOutput: statusSpec.formatOutput,
        toolName: statusSpec.name,
      })
      assert.ok(toolRes.output[0]!.text.includes('Flat Squad'))
      assert.equal((toolRes.structuredOutput as BoardViewDoc).group.id, groupId)

      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId }, { conversationId: coord.id })

      // 3) Bounded index (MAX_INDEX_CLOSED_GROUPS = 50) + lazy closed group loading for evicted archived coordinator/worker
      const evictedCoord = await kernel.createConversation({ title: 'Evicted Hist Coord', profileId: 'assistant', cwd: env.repoDir })
      const evictedGroup = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Evicted Historic Group',
        conversationId: evictedCoord.id,
      })) as { groupId: string }
      let evictedStep = 0
      env.faux.setResponses([
        () => {
          evictedStep += 1
          if (evictedStep === 1) {
            return fauxAssistantMessage(
              [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Evicted worker done' })],
              { stopReason: 'toolUse' },
            )
          }
          return fauxAssistantMessage('Evicted worker settled')
        },
        fauxAssistantMessage('Evicted worker settled'),
        fauxAssistantMessage('Coord ack'),
      ])
      const evictedWorker = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId: evictedGroup.groupId, name: 'evictedw', prompt: 'Worker in evicted group' },
        { conversationId: evictedCoord.id },
      )) as { workerConversationId: number }
      await kernel.waitForIdle(evictedWorker.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.waitForIdle(evictedCoord.id)
      await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'close_group',
        { groupId: evictedGroup.groupId },
        { conversationId: evictedCoord.id },
      )

      // Create and close 51 more groups so total closed groups = 53 > 50 (with updatedAt strictly newer)
      for (let i = 0; i < 51; i += 1) {
        const c = await kernel.createConversation({ title: `Hist ${i}`, profileId: 'assistant', cwd: env.repoDir })
        const g = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
          title: `Hist Group ${i}`,
          conversationId: c.id,
        })) as { groupId: string }
        await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId: g.groupId }, { conversationId: c.id })
      }

      // Disable + re-enable swarm plugin to exercise startup lazy-load & bounded index sync
      await kernel.plugins.disable(SWARM_PLUGIN_ID, { force: true })
      await kernel.plugins.enable(SWARM_PLUGIN_ID)
      const idxAfterReload = kernel.plugins.getPublicDoc(SWARM_PLUGIN_ID, 'index').value as SwarmIndexDoc
      assert.ok(idxAfterReload.groups.length <= 50, `closed groups in index must be bounded to <= 50 (got ${idxAfterReload.groups.length})`)
      assert.equal(idxAfterReload.groups.some((g) => g.id === evictedGroup.groupId), false, 'oldest evicted group is absent from bounded index')

      // Neither evicted coordinator nor evicted worker fails when viewing panel via archived scope!
      const byArchivedCoord = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'board_status',
        {},
        { conversationId: evictedCoord.id },
      )) as BoardViewDoc
      assert.equal(byArchivedCoord.group.id, evictedGroup.groupId)
      assert.ok(byArchivedCoord.posts.length >= 1, 'lazy-loaded board.jsonl restores posts for archived coordinator')

      const byArchivedWorker = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'board_status',
        {},
        { conversationId: evictedWorker.workerConversationId },
      )) as BoardViewDoc
      assert.equal(byArchivedWorker.group.id, evictedGroup.groupId)
    } finally {
      await env.close()
    }
  })

  test('swarm-int13: concurrent dispatch_worker in one group enforces name uniqueness & maxWorkersPerGroup without global serialization', { timeout: 60_000 }, async (t) => {
    const env = await openSwarmEnv(useTempDir(t, 'helmx-swarm-concurrent-'), gitTemplate)
    try {
      const { kernel } = env.app
      await kernel.plugins.setConfig(SWARM_PLUGIN_ID, { maxWorkersPerGroup: 2 })
      const coord = await kernel.createConversation({ title: 'Parallel Dispatch Coord', profileId: 'assistant', cwd: env.repoDir })
      const { groupId } = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Concurrent Squad',
        conversationId: coord.id,
      })) as { groupId: string }

      setSwarmRoleResponses(env.faux, {
        alpha: [
          fauxAssistantMessage([fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'alpha done' })], { stopReason: 'toolUse' }),
          fauxAssistantMessage('alpha settled'),
        ],
        beta: [
          fauxAssistantMessage([fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'beta done' })], { stopReason: 'toolUse' }),
          fauxAssistantMessage('beta settled'),
        ],
        coordinator: [fauxAssistantMessage('Coordinator noted both done.')],
      })

      // Fire 4 concurrent dispatches at once: alpha, duplicate alpha, beta, and over-limit gamma
      const settled = await Promise.allSettled([
        kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'dispatch_worker', { groupId, name: 'alpha', prompt: 'Slice A' }, { conversationId: coord.id }),
        kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'dispatch_worker', { groupId, name: 'alpha', prompt: 'Dup Slice A' }, { conversationId: coord.id }),
        kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'dispatch_worker', { groupId, name: 'beta', prompt: 'Slice B' }, { conversationId: coord.id }),
        kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'dispatch_worker', { groupId, name: 'gamma', prompt: 'Over-limit C' }, { conversationId: coord.id }),
      ])

      const fulfilled = settled.filter((r) => r.status === 'fulfilled')
      const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      assert.equal(fulfilled.length, 2, 'exactly 2 distinct workers admitted within maxWorkersPerGroup=2')
      assert.equal(rejected.length, 2, 'duplicate name and over-capacity dispatch must reject')
      const errCodes = rejected.map((r) => (r.reason instanceof HelmxError ? r.reason.code : 'other')).sort()
      assert.deepEqual(errCodes, ['swarm_group_member_limit', 'swarm_member_conflict'])

      const workers = fulfilled.map((r) => (r as PromiseFulfilledResult<{ workerConversationId: number }>).value)
      for (const w of workers) await kernel.waitForIdle(w.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.waitForIdle(coord.id)
      await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId }, { conversationId: coord.id })
    } finally {
      await env.close()
    }
  })

  test('swarm-int16: all 11 swarm_* tools emit bounded presentationMeta alongside full structuredOutput, and compiled SwarmToolView reads presentationMeta directly', { timeout: 60_000 }, async (t) => {
    const root = useTempDir(t, 'helmx-swarm-int16-')
    const env = await openSwarmEnv(root, gitTemplate)
    try {
      const kernel = env.app.kernel
      const coord = await kernel.createConversation({ title: 'Meta Coord', profileId: 'assistant', cwd: env.repoDir })

      const execSwarmDerived = async <TOut>(
        toolName: string,
        input: Record<string, unknown>,
        ctx: { conversationId: number; callId?: string },
      ): Promise<{ output: string; structuredOutput: TOut; presentationMeta: Record<string, unknown> }> => {
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
          presentationMeta: normalized.details ?? {},
        }
      }

      const created = await execSwarmDerived<{ groupId: string; group: { title: string } }>(
        'swarm_create_group',
        { title: 'Presentation Squad', objective: 'Separate structuredOutput from UI meta' },
        { conversationId: coord.id },
      )
      const groupId = created.structuredOutput.groupId
      assert.equal(created.structuredOutput.group.title, 'Presentation Squad')
      validateOrThrow(swarmToolPresentationMetaSchema, created.presentationMeta, 'swarm_create_group meta')
      assert.deepEqual(created.presentationMeta, { groupId, groupTitle: 'Presentation Squad' })

      const updated = await execSwarmDerived<{ group: { title: string } }>(
        'swarm_update_group',
        { groupId, title: 'Presentation Squad v2' },
        { conversationId: coord.id },
      )
      assert.equal(updated.structuredOutput.group.title, 'Presentation Squad v2')
      validateOrThrow(swarmToolPresentationMetaSchema, updated.presentationMeta, 'swarm_update_group meta')
      assert.deepEqual(updated.presentationMeta, { groupId, groupTitle: 'Presentation Squad v2' })

      env.faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Alpha completed task' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Worker alpha settled'),
        fauxAssistantMessage('Coordinator noted'),
      ])
      const dispatched = await execSwarmDerived<{
        workerConversationId: number
        groupId: string
        name: string
        postSeq: number
      }>(
        'swarm_dispatch_worker',
        { groupId, name: 'alpha', prompt: 'Inspect meta separation', isolation: 'inherit' },
        { conversationId: coord.id },
      )
      const workerId = dispatched.structuredOutput.workerConversationId
      assert.equal(dispatched.structuredOutput.name, 'alpha')
      validateOrThrow(swarmToolPresentationMetaSchema, dispatched.presentationMeta, 'swarm_dispatch_worker meta')
      assert.deepEqual(dispatched.presentationMeta, {
        groupId,
        memberName: 'alpha',
        workerConversationId: workerId,
        seq: dispatched.structuredOutput.postSeq,
      })

      await kernel.waitForIdle(workerId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.waitForIdle(coord.id)

      const longBody = `Detailed handoff payload ${'x'.repeat(2048)}`
      const posted = await execSwarmDerived<{ post: BoardPost }>(
        'swarm_board_post',
        { groupId, to: ['alpha'], kind: 'handoff', wake: false, body: longBody },
        { conversationId: coord.id },
      )
      assert.equal(posted.structuredOutput.post.body, longBody, 'programmatic structuredOutput preserves full post body')
      validateOrThrow(swarmToolPresentationMetaSchema, posted.presentationMeta, 'swarm_board_post meta')
      assert.deepEqual(posted.presentationMeta, {
        groupId,
        postKind: 'handoff',
        seq: posted.structuredOutput.post.seq,
      })

      const readRes = await execSwarmDerived<{ posts: BoardPost[]; headSeq: number }>(
        'swarm_board_read',
        { groupId, limit: 20 },
        { conversationId: coord.id },
      )
      assert.ok(readRes.structuredOutput.posts.length >= 2)
      validateOrThrow(swarmToolPresentationMetaSchema, readRes.presentationMeta, 'swarm_board_read meta')
      assert.deepEqual(readRes.presentationMeta, {
        groupId,
        seq: readRes.structuredOutput.headSeq,
        postCount: readRes.structuredOutput.posts.length,
      })

      const statusRes = await execSwarmDerived<BoardViewDoc>(
        'swarm_board_status',
        { groupId },
        { conversationId: coord.id },
      )
      assert.ok(Array.isArray(statusRes.structuredOutput.members) && statusRes.structuredOutput.members.length === 1)
      assert.ok(Array.isArray(statusRes.structuredOutput.posts))
      validateOrThrow(swarmToolPresentationMetaSchema, statusRes.presentationMeta, 'swarm_board_status meta')
      assert.deepEqual(statusRes.presentationMeta, {
        groupId,
        groupTitle: 'Presentation Squad v2',
        seq: statusRes.structuredOutput.group.headSeq,
        postCount: statusRes.structuredOutput.posts.length,
      })

      await kernel.waitForIdle(workerId)

      const aborted = await execSwarmDerived<{ aborted: boolean; workerConversationId: number; name: string }>(
        'swarm_abort_worker',
        { workerConversationId: workerId },
        { conversationId: coord.id },
      )
      assert.equal(aborted.structuredOutput.aborted, false)
      validateOrThrow(swarmToolPresentationMetaSchema, aborted.presentationMeta, 'swarm_abort_worker meta')
      assert.deepEqual(aborted.presentationMeta, {
        workerConversationId: workerId,
        memberName: 'alpha',
        aborted: false,
      })

      const switched = await execSwarmDerived<{ workerConversationId: number; model: string; name: string }>(
        'swarm_switch_worker_model',
        { workerConversationId: workerId, model: 'faux/faux-2' },
        { conversationId: coord.id },
      )
      assert.equal(switched.structuredOutput.model, 'faux/faux-2')
      validateOrThrow(swarmToolPresentationMetaSchema, switched.presentationMeta, 'swarm_switch_worker_model meta')
      assert.deepEqual(switched.presentationMeta, {
        workerConversationId: workerId,
        memberName: 'alpha',
        model: 'faux/faux-2',
      })

      const inspected = await execSwarmDerived<{ conversationId: number; recentEntries: unknown[]; artifacts: unknown[] }>(
        'swarm_inspect_worker',
        { workerConversationId: workerId },
        { conversationId: coord.id },
      )
      assert.ok(Array.isArray(inspected.structuredOutput.recentEntries))
      validateOrThrow(swarmToolPresentationMetaSchema, inspected.presentationMeta, 'swarm_inspect_worker meta')
      assert.deepEqual(inspected.presentationMeta, {
        groupId,
        workerConversationId: workerId,
        memberName: 'alpha',
      })

      const archived = await execSwarmDerived<{ archived: boolean; workerConversationId: number }>(
        'swarm_archive_worker',
        { workerConversationId: workerId },
        { conversationId: coord.id },
      )
      assert.equal(archived.structuredOutput.archived, true)
      validateOrThrow(swarmToolPresentationMetaSchema, archived.presentationMeta, 'swarm_archive_worker meta')
      assert.deepEqual(archived.presentationMeta, {
        workerConversationId: workerId,
        archived: true,
      })

      const closed = await execSwarmDerived<{ closed: boolean; groupId: string; retainedWorktrees: unknown[] }>(
        'swarm_close_group',
        { groupId },
        { conversationId: coord.id },
      )
      assert.equal(closed.structuredOutput.closed, true)
      validateOrThrow(swarmToolPresentationMetaSchema, closed.presentationMeta, 'swarm_close_group meta')
      assert.deepEqual(closed.presentationMeta, {
        groupId,
        retainedCount: 0,
      })

      // Programmatic action still returns the raw BoardViewDoc directly
      const actionStatus = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'board_status',
        { groupId },
        { conversationId: coord.id },
      )) as BoardViewDoc
      assert.equal(actionStatus.group.id, groupId)
      assert.equal(actionStatus.group.status, 'closed')
    } finally {
      await env.close()
    }

    // Compiled SwarmToolView DOM verification with presentationMeta (and without JSON.parse(props.result))
    const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
    if (typeof globalThis.document === 'undefined') GlobalRegistrator.register()
    const req = createRequire(new URL('../../plugin-client/package.json', import.meta.url))
    const React = req('react') as typeof import('react')
    const ReactDOM = req('react-dom') as unknown
    const ReactDOMClient = req('react-dom/client') as {
      createRoot: (container: Element) => { render(node: React.ReactNode): void; unmount(): void }
    }
    const ReactJsxRuntime = req('react/jsx-runtime') as Record<string, unknown>
    const LucideReact = req('lucide-react') as Record<string, unknown>
    const SDK = await import('@helmx/plugin-client')

    const g = globalThis as Record<string, unknown>
    const sharedKeys = [
      'React',
      'IS_REACT_ACT_ENVIRONMENT',
      CLIENT_SHARED_GLOBALS['react']!,
      CLIENT_SHARED_GLOBALS['react-dom']!,
      CLIENT_SHARED_GLOBALS['react-dom/client']!,
      CLIENT_SHARED_GLOBALS['react/jsx-runtime']!,
      CLIENT_SHARED_GLOBALS['lucide-react']!,
      CLIENT_SHARED_GLOBALS['@helmx/plugin-client']!,
    ]
    const prevGlobals = new Map(sharedKeys.map((k) => [k, g[k]]))
    const buildDir = useTempDir(t, 'helmx-swarm-client-render-')
    t.after(() => {
      for (const key of sharedKeys) {
        const prev = prevGlobals.get(key)
        if (prev === undefined) delete g[key]
        else g[key] = prev
      }
    })

    g.React = React
    g.IS_REACT_ACT_ENVIRONMENT = true
    g[CLIENT_SHARED_GLOBALS['react']!] = React
    g[CLIENT_SHARED_GLOBALS['react-dom']!] = ReactDOM
    g[CLIENT_SHARED_GLOBALS['react-dom/client']!] = ReactDOMClient
    g[CLIENT_SHARED_GLOBALS['react/jsx-runtime']!] = ReactJsxRuntime
    g[CLIENT_SHARED_GLOBALS['lucide-react']!] = LucideReact
    g[CLIENT_SHARED_GLOBALS['@helmx/plugin-client']!] = SDK

    const swarmClientDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/swarm/client')
    const bundle = await compilePluginClientModule(SWARM_PLUGIN_ID, swarmClientDir, 'tool-view.tsx', buildDir)
    const mod = (await import(`data:text/javascript;base64,${Buffer.from(bundle.code, 'utf8').toString('base64')}#swarm-lifecycle-int16`)) as {
      SwarmToolView: React.ComponentType<ToolViewProps>
    }

    const drawerCalls: number[] = []
    const workbenchCalls: Array<string | undefined> = []
    const noopUnsub = () => {}
    const emptyConversations: ConversationSummary[] = []
    const emptyAsks: never[] = []
    const pluginsSnapshot = { plugins: [], screens: [] }
    const pluginDocs: Record<string, unknown> = { [`${SWARM_PLUGIN_ID}/index`]: { workers: [], groups: [] } }
    const port: import('@helmx/plugin-client').PluginClientHostPort = {
      getAuthenticated: () => true,
      subscribeAuthenticated: () => noopUnsub,
      getTheme: () => 'dark',
      getLocale: () => 'en',
      subscribePrefs: () => noopUnsub,
      getConversations: () => emptyConversations,
      subscribeConversations: () => noopUnsub,
      getConversationSummary: () => undefined,
      subscribeConversationSummary: () => noopUnsub,
      getConversationDetail: () => undefined,
      subscribeConversationDetail: () => noopUnsub,
      getConversationLive: () => undefined,
      subscribeConversationLive: () => noopUnsub,
      getConversationPendingAsks: () => emptyAsks,
      subscribeConversationPendingAsks: () => noopUnsub,
      getLoadError: () => undefined,
      subscribeLoadError: () => noopUnsub,
      getPluginsSnapshot: () => pluginsSnapshot,
      subscribePlugins: () => noopUnsub,
      getPluginDocValue: (docKey) => (Object.hasOwn(pluginDocs, docKey) ? pluginDocs[docKey] : undefined),
      subscribePluginDoc: () => noopUnsub,
      ensurePluginDoc: async () => undefined,
      getPluginSessionDoc: async () => undefined,
      subscribeSessionDoc: () => () => {},
      getSessionDocState: () => ({ hasValue: false, deleted: false, connected: false, value: undefined }),
      invokePluginAction: async () => ({}),
      submitConversationInput: async () => undefined,
      openTarget: () => undefined,
      openConversationDrawer: (id) => { drawerCalls.push(id) },
      openArtifactPreview: () => undefined,
      setWorkbenchOpen: () => undefined,
      setWorkbenchTab: (tab) => { workbenchCalls.push(tab) },
      notify: () => undefined,
      loadConversationDetail: () => undefined,
      slots: { collectItems: () => [], renderItem: () => null },
      markdown: { view: ({ text }) => React.createElement('div', null, text), codeBlock: ({ code }) => React.createElement('pre', null, code) },
    }
    const ctx: PluginClientContextType = SDK.createPluginClientContext(port, SWARM_PLUGIN_ID, 50)
    ctx.openWorkbench = (panelId?: string) => { workbenchCalls.push(panelId) }

    const mountView = async (props: ToolViewProps) => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = ReactDOMClient.createRoot(container)
      await React.act(async () => {
        root.render(
          React.createElement(
            SDK.PluginClientHostContext.Provider,
            { value: port },
            React.createElement(
              SDK.PluginClientContext.Provider,
              { value: ctx },
              React.createElement(mod.SwarmToolView, props),
            ),
          ),
        )
      })
      return {
        container,
        unmount: () => {
          React.act(() => root.unmount())
          container.remove()
        },
      }
    }

    // A) presentationMeta drives dispatch drawer jump & #seq badge
    const dispatchView = await mountView({
      callId: 'c-disp',
      toolName: 'swarm_dispatch_worker',
      status: 'done',
      conversationId: 50,
      input: { name: 'author', prompt: 'Implement auth' },
      presentationMeta: { groupId: 'grp-meta', memberName: 'author', workerConversationId: 51, seq: 3 },
    })
    try {
      assert.match(dispatchView.container.textContent ?? '', /@author/)
      assert.match(dispatchView.container.textContent ?? '', /#3/)
      await React.act(async () => {
        dispatchView.container.querySelector<HTMLButtonElement>('.sw-trace-row-btn')!.click()
      })
      assert.deepEqual(drawerCalls, [51])
    } finally {
      dispatchView.unmount()
    }

    // B) props.result JSON string is NEVER parsed when presentationMeta is absent
    const resultOnlyView = await mountView({
      callId: 'c-json-only',
      toolName: 'swarm_dispatch_worker',
      status: 'done',
      conversationId: 50,
      input: { name: 'author', prompt: 'Implement auth' },
      result: JSON.stringify({ workerConversationId: 99, groupId: 'grp-json', name: 'author', postSeq: 8 }),
    })
    try {
      assert.doesNotMatch(resultOnlyView.container.textContent ?? '', /#8/)
      const btn = resultOnlyView.container.querySelector<HTMLButtonElement>('.sw-trace-row-btn')!
      assert.equal(btn.getAttribute('aria-expanded'), 'false', 'without presentationMeta, row expands raw details instead of fabricating drawer jump')
      await React.act(async () => {
        btn.click()
      })
      assert.deepEqual(drawerCalls, [51], 'must not jump to #99 parsed from props.result')
    } finally {
      resultOnlyView.unmount()
    }

    // C) 0-count / boolean / retainedCount from presentationMeta
    const readZeroView = await mountView({
      callId: 'c-read0',
      toolName: 'swarm_board_read',
      status: 'done',
      conversationId: 50,
      presentationMeta: { groupId: 'grp-meta', seq: 0, postCount: 0 },
    })
    try {
      assert.match(readZeroView.container.textContent ?? '', /0 posts/)
    } finally {
      readZeroView.unmount()
    }

    const abortNoopView = await mountView({
      callId: 'c-abort-noop',
      toolName: 'swarm_abort_worker',
      status: 'done',
      conversationId: 50,
      presentationMeta: { workerConversationId: 51, memberName: 'author', aborted: false },
    })
    try {
      assert.match(abortNoopView.container.textContent ?? '', /not running/)
    } finally {
      abortNoopView.unmount()
    }

    const closeRetainedView = await mountView({
      callId: 'c-close',
      toolName: 'swarm_close_group',
      status: 'done',
      conversationId: 50,
      presentationMeta: { groupId: 'grp-meta', retainedCount: 2 },
    })
    try {
      assert.match(closeRetainedView.container.textContent ?? '', /2 branches kept for merge/)
    } finally {
      closeRetainedView.unmount()
    }
  })

  test('swarm-int17: dynamic nodeId dispatch on online remote node (inherit), peer forkFrom, explicit local override, offline 409, missing cwd 400, and restrictToCwd 403', { timeout: 60_000 }, async (t) => {
    const root = useTempDir(t, 'helmx-swarm-dyn-node-')
    const env = await openSwarmEnv(root, gitTemplate)
    const remoteWorkDir = join(root, 'remote-workspace')
    const remoteHomeDir = join(root, 'remote-home')
    const remoteTmpDir = join(root, 'remote-tmp')
    mkdirSync(remoteWorkDir, { recursive: true })
    mkdirSync(remoteHomeDir, { recursive: true })
    mkdirSync(remoteTmpDir, { recursive: true })

    let closedSocket = false
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const fakeSocket = {
      OPEN: 1,
      CLOSED: 3,
      get readyState() {
        return closedSocket ? 3 : 1
      },
      once(event: string, fn: (...args: unknown[]) => void) {
        const arr = listeners.get(event) ?? []
        arr.push(fn)
        listeners.set(event, arr)
        return this
      },
      close() {
        if (closedSocket) return
        closedSocket = true
        for (const fn of listeners.get('close') ?? []) fn()
        listeners.clear()
      },
    }

    try {
      const { kernel } = env.app
      const issued = await kernel.issueNodeToken('remote-box')
      const notFoundRpc = async () => ({ ok: false as const, error: { code: 'not_found' as const, message: 'ENOENT' } })
      const reg = await kernel.envFabric.registry.register(
        fakeSocket as never,
        {
          nodeId: 'remote-box',
          token: issued.token,
          hostname: 'remote-box.test',
          platform: 'linux',
        },
        () =>
          ({
            nodeHostEnv: async () => ({
              ok: true,
              value: {
                platform: 'linux',
                homeDir: remoteHomeDir,
                tempDir: remoteTmpDir,
                env: {},
              },
            }),
            envCanonicalPath: notFoundRpc,
            envFileInfo: notFoundRpc,
            envListDir: notFoundRpc,
            envOpenDirReader: notFoundRpc,
            envOpenBinaryReader: notFoundRpc,
            envOpenTextLineReader: notFoundRpc,
            envExists: async () => ({ ok: true, value: false }),
            $close: () => {},
          }) as never,
      )
      assert.equal(reg.accepted, true)
      assert.equal(kernel.envFabric.isOnline('remote-box'), true)

      const coord = await kernel.createConversation({ title: 'Multi-Node Coord', profileId: 'assistant', cwd: env.repoDir })
      const { groupId } = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Multi-Node Squad',
        conversationId: coord.id,
      })) as { groupId: string }

      // 1) Remote nodeId without cwd rejects 400 validation_error with zero conversations created
      const convCountBeforeErrors = kernel.listConversations().length
      await assert.rejects(
        () =>
          kernel.plugins.invokeAction(
            SWARM_PLUGIN_ID,
            'dispatch_worker',
            { groupId, name: 'nocwd', prompt: 'Missing remote cwd', nodeId: 'remote-box', isolation: 'inherit' },
            { conversationId: coord.id },
          ),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
      )
      assert.equal(kernel.listConversations().length, convCountBeforeErrors)

      // 2) Offline remote nodeId rejects 409 node_offline BEFORE creating any conversation
      await assert.rejects(
        () =>
          kernel.plugins.invokeAction(
            SWARM_PLUGIN_ID,
            'dispatch_worker',
            { groupId, name: 'offlinew', prompt: 'Offline node', nodeId: 'offline-box', cwd: '/srv/offline', isolation: 'inherit' },
            { conversationId: coord.id },
          ),
        (err: unknown) => err instanceof HelmxError && err.code === 'node_offline' && err.status === 409,
      )
      assert.equal(kernel.listConversations().length, convCountBeforeErrors, 'offline preflight must leave zero orphan conversations')

      // 3) Online remote node dispatch succeeds with isolation: 'inherit'
      setSwarmRoleResponses(env.faux, {
        remoter: [
          fauxAssistantMessage([fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Remote task complete' })], { stopReason: 'toolUse' }),
          fauxAssistantMessage('Remote worker settled.'),
        ],
        remote_fork: [
          fauxAssistantMessage([fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Remote fork complete' })], { stopReason: 'toolUse' }),
          fauxAssistantMessage('Remote fork settled.'),
        ],
        local_switch: [
          fauxAssistantMessage([fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Switched back to local' })], { stopReason: 'toolUse' }),
          fauxAssistantMessage('Local switch settled.'),
        ],
        coordinator: [
          fauxAssistantMessage('Coordinator noted remote completion.'),
          fauxAssistantMessage('Coordinator noted remote fork.'),
          fauxAssistantMessage('Coordinator noted local switch.'),
        ],
      })

      const remoter = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId, name: 'remoter', prompt: 'Run on remote-box', nodeId: 'remote-box', cwd: remoteWorkDir, isolation: 'inherit' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }
      await kernel.waitForIdle(remoter.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.waitForIdle(coord.id)

      const remoterConv = kernel.getConversation(remoter.workerConversationId)
      assert.equal(remoterConv.nodeId, 'remote-box')
      assert.equal(remoterConv.cwd, remoteWorkDir)

      // 4) forkFrom: '<remotePeer>' inherits peer's (nodeId, cwd) while keeping flat parentConversationId -> coordinator
      const remoteFork = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId, name: 'remote_fork', prompt: 'Continue on same remote node', forkFrom: 'remoter', isolation: 'inherit' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }
      await kernel.waitForIdle(remoteFork.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.waitForIdle(coord.id)

      const remoteForkConv = kernel.getConversation(remoteFork.workerConversationId)
      assert.equal(remoteForkConv.parentConversationId, coord.id, 'forkFrom peer keeps flat coordinator parent')
      assert.equal(remoteForkConv.nodeId, 'remote-box', 'forkFrom peer inherits peer nodeId')
      assert.equal(remoteForkConv.cwd, remoteWorkDir, 'forkFrom peer inherits peer cwd')

      // 5) forkFrom: '<remotePeer>' with explicit nodeId: 'local' switches back to Hub host without leaking remote cwd
      const localSwitch = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId, name: 'local_switch', prompt: 'Switch back to Hub local', forkFrom: 'remoter', nodeId: 'local', isolation: 'inherit' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }
      await kernel.waitForIdle(localSwitch.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.waitForIdle(coord.id)

      const localSwitchConv = kernel.getConversation(localSwitch.workerConversationId)
      assert.equal(localSwitchConv.nodeId, 'local')
      assert.equal(localSwitchConv.cwd, env.repoDir, 'explicit local nodeId must not leak remote peer cwd')

      // Verify board_status reflects real member nodeIds
      const status = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_status', { groupId }, { conversationId: coord.id })) as BoardViewDoc
      assert.equal(status.members.find((m) => m.name === 'remoter')?.nodeId, 'remote-box')
      assert.equal(status.members.find((m) => m.name === 'remote_fork')?.nodeId, 'remote-box')
      assert.equal(status.members.find((m) => m.name === 'local_switch')?.nodeId, 'local')

      await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId }, { conversationId: coord.id })

      // 6) Profile.restrictToCwd coordinator blocks cross-node dispatch directly AND via unrestricted peer forkFrom (403 path_outside_workspace)
      await kernel.services.profiles.save({
        id: 'restricted-coord',
        name: 'Restricted Coordinator',
        restrictToCwd: true,
      })
      const restrictedCoord = await kernel.createConversation({
        title: 'Restricted Coord',
        profileId: 'restricted-coord',
        cwd: env.repoDir,
      })
      const { groupId: restrictedGroupId } = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Restricted Squad',
        conversationId: restrictedCoord.id,
      })) as { groupId: string }

      const convCountBeforeRestricted = kernel.listConversations().length
      await assert.rejects(
        () =>
          kernel.plugins.invokeAction(
            SWARM_PLUGIN_ID,
            'dispatch_worker',
            { groupId: restrictedGroupId, name: 'escape_direct', prompt: 'Direct cross-node', nodeId: 'remote-box', cwd: remoteWorkDir, isolation: 'inherit' },
            { conversationId: restrictedCoord.id },
          ),
        (err: unknown) => err instanceof HelmxError && err.code === 'path_outside_workspace' && err.status === 403,
      )
      assert.equal(kernel.listConversations().length, convCountBeforeRestricted)

      // Seed a local unrestricted peer inside the restricted coordinator's workspace, then try escaping via forkFrom
      setSwarmRoleResponses(env.faux, {
        local_peer: [
          fauxAssistantMessage([fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Local peer done' })], { stopReason: 'toolUse' }),
          fauxAssistantMessage('Local peer settled.'),
        ],
        coordinator: [fauxAssistantMessage('Restricted coord noted peer.')],
      })
      const localPeer = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId: restrictedGroupId, name: 'local_peer', prompt: 'Work locally', profileId: 'assistant', isolation: 'inherit' },
        { conversationId: restrictedCoord.id },
      )) as { workerConversationId: number }
      await kernel.waitForIdle(localPeer.workerConversationId)
      await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
      await kernel.waitForIdle(restrictedCoord.id)

      const countBeforePeerEscape = kernel.listConversations().length
      await assert.rejects(
        () =>
          kernel.plugins.invokeAction(
            SWARM_PLUGIN_ID,
            'dispatch_worker',
            { groupId: restrictedGroupId, name: 'escape_peer_node', prompt: 'Escape node via peer', forkFrom: 'local_peer', nodeId: 'remote-box', cwd: remoteWorkDir, isolation: 'inherit' },
            { conversationId: restrictedCoord.id },
          ),
        (err: unknown) => err instanceof HelmxError && err.code === 'path_outside_workspace' && err.status === 403,
      )
      await assert.rejects(
        () =>
          kernel.plugins.invokeAction(
            SWARM_PLUGIN_ID,
            'dispatch_worker',
            { groupId: restrictedGroupId, name: 'escape_peer_cwd', prompt: 'Escape cwd via peer', forkFrom: 'local_peer', cwd: remoteWorkDir, isolation: 'inherit' },
            { conversationId: restrictedCoord.id },
          ),
        (err: unknown) => err instanceof HelmxError && err.code === 'path_outside_workspace' && err.status === 403,
      )
      assert.equal(kernel.listConversations().length, countBeforePeerEscape)

      await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId: restrictedGroupId }, { conversationId: restrictedCoord.id })
    } finally {
      fakeSocket.close()
      await env.close()
    }
  })

  test('swarm-int6: archive_worker and close_group solidify member runDurationMs and turnCount into meta.json and preserve history after conversation deletion', { timeout: 60_000 }, async (t) => {
    const dir = useTempDir(t, 'helmx-swarm-timing-')
    const env = await openSwarmEnv(dir, gitTemplate)
    try {
      const { kernel } = env.app
      const coord = await kernel.createConversation({ title: 'Timing Coord', profileId: 'assistant', cwd: env.repoDir })

      const created = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'create_group',
        { title: 'Timing Squad', objective: 'Verify timing solidification' },
        { conversationId: coord.id },
      )) as { groupId: string }

      setSwarmRoleResponses(env.faux, {
        coordinator: [() => fauxAssistantMessage('Coordinator noted both deliveries.')],
        alpha: [
          () => fauxAssistantMessage([
            fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'alpha finished work' }),
          ], { stopReason: 'toolUse' }),
          () => fauxAssistantMessage('alpha done'),
        ],
        beta: [
          () => fauxAssistantMessage([
            fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'beta finished work' }),
          ], { stopReason: 'toolUse' }),
          () => fauxAssistantMessage('beta done'),
        ],
      })

      const dispAlpha = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId: created.groupId, name: 'alpha', prompt: 'Do alpha work' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }
      const dispBeta = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'dispatch_worker',
        { groupId: created.groupId, name: 'beta', prompt: 'Do beta work' },
        { conversationId: coord.id },
      )) as { workerConversationId: number }

      await kernel.waitForIdle(dispAlpha.workerConversationId)
      await kernel.waitForIdle(dispBeta.workerConversationId)
      await kernel.waitForIdle(coord.id)

      // Live board-view / board_status exposes timing fields and passes strict output schema
      const liveStatus = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'board_status',
        { groupId: created.groupId },
        { conversationId: coord.id },
      )) as BoardViewDoc
      const liveAlpha = liveStatus.members.find((m) => m.name === 'alpha')!
      const liveBeta = liveStatus.members.find((m) => m.name === 'beta')!
      assert.equal(typeof liveAlpha.runDurationMs, 'number')
      assert.ok((liveAlpha.runDurationMs ?? -1) >= 0)
      assert.ok((liveAlpha.turnCount ?? 0) >= 1)
      assert.equal(typeof liveBeta.runDurationMs, 'number')
      assert.ok((liveBeta.turnCount ?? 0) >= 1)

      const alphaRunBeforeArchive = liveAlpha.runDurationMs!
      const alphaTurnsBeforeArchive = liveAlpha.turnCount!
      const betaRunBeforeClose = liveBeta.runDurationMs!
      const betaTurnsBeforeClose = liveBeta.turnCount!

      // Archive alpha -> solidified into meta.json
      await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'archive_worker',
        { groupId: created.groupId, name: 'alpha' },
        { conversationId: coord.id },
      )

      const metaPath = join(env.dataDir, 'plugins', 'builtin%3Aswarm', 'groups', created.groupId, 'meta.json')
      const metaAfterArchive = JSON.parse(await readFile(metaPath, 'utf8')) as {
        members: Array<{ name: string; lifecycle: string; runDurationMs?: number; turnCount?: number }>
      }
      const metaAlpha = metaAfterArchive.members.find((m) => m.name === 'alpha')!
      assert.equal(metaAlpha.lifecycle, 'archived')
      assert.equal(metaAlpha.runDurationMs, alphaRunBeforeArchive)
      assert.equal(metaAlpha.turnCount, alphaTurnsBeforeArchive)

      // Close group -> beta also solidified into meta.json and closedAt recorded
      await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'close_group',
        { groupId: created.groupId, summary: 'all timing solidified' },
        { conversationId: coord.id },
      )
      const metaAfterClose = JSON.parse(await readFile(metaPath, 'utf8')) as {
        status: string
        closedAt?: number
        members: Array<{ name: string; lifecycle: string; runDurationMs?: number; turnCount?: number }>
      }
      assert.equal(metaAfterClose.status, 'closed')
      assert.equal(typeof metaAfterClose.closedAt, 'number')
      const metaBeta = metaAfterClose.members.find((m) => m.name === 'beta')!
      assert.equal(metaBeta.lifecycle, 'archived')
      assert.equal(metaBeta.runDurationMs, betaRunBeforeClose)
      assert.equal(metaBeta.turnCount, betaTurnsBeforeClose)

      // Delete both worker conversations -> historical board_status still serves solidified timing!
      await kernel.deleteConversation(dispAlpha.workerConversationId)
      await kernel.deleteConversation(dispBeta.workerConversationId)
      const historicalStatus = (await kernel.plugins.invokeAction(
        SWARM_PLUGIN_ID,
        'board_status',
        { groupId: created.groupId },
        { conversationId: coord.id },
      )) as BoardViewDoc
      assert.equal(historicalStatus.group.status, 'closed')
      assert.equal(typeof historicalStatus.group.closedAt, 'number')
      const histAlpha = historicalStatus.members.find((m) => m.name === 'alpha')!
      const histBeta = historicalStatus.members.find((m) => m.name === 'beta')!
      assert.equal(histAlpha.liveState, 'missing')
      assert.equal(histAlpha.runDurationMs, alphaRunBeforeArchive)
      assert.equal(histAlpha.turnCount, alphaTurnsBeforeArchive)
      assert.equal(histBeta.liveState, 'missing')
      assert.equal(histBeta.runDurationMs, betaRunBeforeClose)
      assert.equal(histBeta.turnCount, betaTurnsBeforeClose)
    } finally {
      await env.close()
    }
  })
})
