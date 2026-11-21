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

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'

import { HelmxError } from '@helmx/protocol'
import { waitFor } from '@helmx/test-kit'
import { useTempDir } from '@helmx/test-kit/node'
import { createGitTemplate } from '@helmx/test-kit/git'
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
  type BoardViewDoc,
  type SwarmIndexDoc,
} from '../src/swarm.js'

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

      // 2) Coexistence with builtin:superagent AND idle workflow-disable freedom:
      //    - Enabling builtin:superagent alongside default-enabled builtin:swarm passes listTools() with zero duplicate_tool_name!
      await kernel.plugins.enable('builtin:superagent')
      const coexistingToolNames = kernel.plugins.listTools().map((tool) => tool.name)
      assert.ok(coexistingToolNames.includes('dispatch_worker'), 'superagent dispatch_worker coexists cleanly')
      assert.ok(coexistingToolNames.includes('swarm_dispatch_worker'), 'swarm_dispatch_worker coexists cleanly')
      assert.ok(coexistingToolNames.includes('swarm_board_post'), 'swarm_board_post coexists cleanly')
      await kernel.plugins.disable('builtin:superagent')

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
      for (const expected of ['swarm_dispatch_worker', 'swarm_board_post', 'swarm_board_read', 'swarm_close_group', 'bash', 'edit', 'write', 'subagent', 'SubagentWorkflow']) {
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
      // 1) External runtime profile rejected with 400 unsupported_runtime
      await kernel.services.profiles.save({
        id: 'ext-agent',
        name: 'External Agent',
        runtime: { kind: 'herdr', agent: 'codex' },
      })
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
      env.faux.setResponses([
        (ctx) => {
          const meta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
          noSkillCoordSection = meta.sectionsById['swarm.active_group'] ?? ''
          availableActionsInCoordTurn = meta.sectionsById['prompt.actions'] ?? ''
          return fauxAssistantMessage('Noted without skill.')
        },
      ])
      await kernel.submitInput(noSkillCoord.id, 'Check sections')
      await kernel.waitForIdle(noSkillCoord.id)
      assert.equal(noSkillCoordSection.includes('load_skill('), false)
      assert.equal(availableActionsInCoordTurn.includes('complete_board_members'), false, 'exposeToPrompt:false hides UI completer from <available_actions>')
      assert.equal(availableActionsInCoordTurn.includes('list_mentionable'), false, 'exposeToPrompt:false hides profile @ completer')
      assert.match(availableActionsInCoordTurn, /manage_channel/, 'coordinator manages channels via run_action catalog')
      await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId: noSkillGroupId }, { conversationId: noSkillCoord.id })

      // 2) Dispatch validation & flat forkFrom & structuredOutput tool envelope
      const coord = await kernel.createConversation({ title: 'Flat Coord', profileId: 'assistant', cwd: env.repoDir })
      const { groupId } = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: 'Flat Squad',
        conversationId: coord.id,
      })) as { groupId: string }

      await assert.rejects(
        () =>
          kernel.plugins.invokeAction(
            SWARM_PLUGIN_ID,
            'dispatch_worker',
            { groupId, name: 'ext', prompt: 'Should fail', profileId: 'ext-agent' },
            { conversationId: coord.id },
          ),
        (err: unknown) => err instanceof HelmxError && err.code === 'unsupported_runtime' && err.status === 400,
      )
      await assert.rejects(
        () =>
          kernel.plugins.invokeAction(
            SWARM_PLUGIN_ID,
            'dispatch_worker',
            { groupId, name: 'badnode', prompt: 'Should fail', nodeId: 'nonexistent-node' },
            { conversationId: coord.id },
          ),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
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

      // Tool call envelope verification: swarm_board_status exposes concise text + structuredOutput object
      const toolRes = (await kernel.plugins.executeTool(
        'swarm_board_status',
        { groupId },
        { conversationId: coord.id },
      )) as { output: string; structuredOutput: BoardViewDoc }
      assert.ok(typeof toolRes.output === 'string' && toolRes.output.includes('Flat Squad'))
      assert.equal(toolRes.structuredOutput.group.id, groupId)

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
})
