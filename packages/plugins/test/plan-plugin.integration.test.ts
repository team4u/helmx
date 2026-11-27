/**
 * builtin:plan real composition-root integration tests (`createHelmx` + `faux` provider):
 * - T3: `/plan <task>` first turn (`onInput` transform, fallback title without `/plan `,
 *       `before_turn` strict 8-tool whitelist + `plan.mode` section, `<available_profiles>` suppression);
 * - T4: normal mode hides `plan_save`/`plan_propose` with zero prompt section; subagent & `helmx`-owned
 *       conversations reject `toggle`/`set_mode` with `400 plan_unsupported_conversation` and ignore `/plan`;
 * - T5: `plan_propose` without draft fails; `revise`, `cancelled`, and Composer new message (`superseded`)
 *       keep `planning` with no Artifact; `approve` creates `plan-v1.md` + restores tools; `approve_handoff`
 *       & `approve_handoff_model` (`tier/coder`) reset context in-place and continue immediately;
 * - T6: `approve_handoff_model` with disabled model (`409 model_disabled`) or missing tier (`404 model_tier_not_found`)
 *       stays `planning`, returns `{ isError: true }`, creates no Artifact, performs no handoff/fallback;
 * - T7: pending ask + human abort -> `cancelAsk` releases `blocked`; `set_mode('normal')`/`toggle` -> releases `blocked`;
 *       disable while pending -> `409 plugin_has_live_tasks`; simulated Hub restart `reconcile()` clears orphaned
 *       `pendingAskId` & `AskDoc`; idle planning disable -> `409 plugin_in_use`; `--force` restores tools; re-enable works;
 * - T8: spawned `subagent` reads approved `plan-v1.md` via `read_artifact`; deleting parent cleans KV/sessionDoc/badges.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai/providers/faux'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import { HelmxError } from '@helmx/protocol'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { createHelmx } from '../../hub/src/app.js'
import { TIERS_PLUGIN_ID } from '../src/tiers/contracts.js'
import { TITLE_PLUGIN_ID } from '../src/title/contracts.js'
import {
  PLAN_BADGES_DOC,
  PLAN_COMMAND_SLASH,
  PLAN_INPUT_META_KEY,
  PLAN_KV_NAMESPACE,
  PLAN_MODE_SECTION_ID,
  PLAN_MODE_TOOL_WHITELIST,
  PLAN_PANEL_ID,
  PLAN_PLUGIN_ID,
  PLAN_SESSION_DOC,
  PLAN_SKILL_ID,
  PLAN_TOOL_PROPOSE,
  PLAN_TOOL_SAVE,
  type PlanBadgesDoc,
  type PlanConversationRecord,
  type PlanSessionView,
} from '../src/plan.js'
import {
  assertRejectsCode,
  cleanupDir,
  makeFauxProvider,
  makeTempDir,
  waitFor,
  type FauxProviderHandle,
} from './helpers/plugin-test-env.js'

const TIMEOUT = { timeout: 60_000 } as const

interface CapturedTurnRequest {
  modelId: string
  toolNames: string[]
  sectionsById: Record<string, string | null>
  messages: Array<{ role?: string; content?: unknown }>
}

interface PlanIntegrationEnv {
  dataDir: string
  faux: FauxProviderHandle
  app: Awaited<ReturnType<typeof createHelmx>>
  close: () => Promise<void>
}

async function openPlanIntegrationEnv(options: {
  models?: Array<{ id: string; name?: string; contextWindow?: number }>
  defaultModel?: string
  disableAutoTitle?: boolean
} = {}): Promise<PlanIntegrationEnv> {
  const dataDir = await makeTempDir('helmx-plan-it-')
  const faux = makeFauxProvider({
    models: options.models ?? [
      { id: 'faux-1', name: 'Primary', contextWindow: 100_000 },
      { id: 'coder', name: 'Coder', contextWindow: 200_000 },
    ],
  })
  const app = await createHelmx({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    cwd: dataDir,
    model: options.defaultModel ?? 'faux/faux-1',
    providers: [faux.provider],
  })
  if (options.disableAutoTitle !== false && app.kernel.plugins.get(TITLE_PLUGIN_ID)?.enabled) {
    await app.kernel.plugins.setConfig(TITLE_PLUGIN_ID, { autoTitle: false })
  }
  return {
    dataDir,
    faux,
    app,
    async close() {
      await app.close().catch(() => {})
      await cleanupDir(dataDir)
    },
  }
}

function captureRequest(
  sink: CapturedTurnRequest[],
  reply: string | ReturnType<typeof fauxAssistantMessage> = 'acknowledged',
): FauxResponseStep {
  return (context, _opts, _state, model) => {
    const sectionsById: Record<string, string | null> = {}
    for (const msg of context.messages as unknown as Array<Record<string, unknown>>) {
      if (msg['role'] !== 'system') continue
      const sections = msg['sections'] as Record<string, string | null> | undefined
      if (sections === undefined) continue
      for (const [k, v] of Object.entries(sections)) {
        sectionsById[k] = v
      }
    }
    sink.push({
      modelId: `${model.provider}/${model.id}`,
      toolNames: getCurrentTools(context.messages as never).map((t) => t.name),
      sectionsById,
      messages: context.messages.map((m) => ({
        role: m.role,
        content: 'content' in m ? m.content : undefined,
      })),
    })
    return typeof reply === 'string' ? fauxAssistantMessage(reply) : reply
  }
}

function readPlanSession(kernel: PlanIntegrationEnv['app']['kernel'], convId: number): PlanSessionView {
  return kernel.plugins.getPublicSessionDoc(PLAN_PLUGIN_ID, PLAN_SESSION_DOC, convId).value as PlanSessionView
}

function readPlanBadges(kernel: PlanIntegrationEnv['app']['kernel']): PlanBadgesDoc {
  return kernel.plugins.getPublicDoc(PLAN_PLUGIN_ID, PLAN_BADGES_DOC).value as PlanBadgesDoc
}

// ---------------------------------------------------------------------------
// T3 & T4: /plan <task> first turn, strict tool whitelist, normal mode & scope guards
// ---------------------------------------------------------------------------

test('T3 & T4: /plan <task> first turn transforms input, derives clean title, enforces strict whitelist; normal mode & non-eligible conversations stay isolated', TIMEOUT, async () => {
  const env = await openPlanIntegrationEnv()
  try {
    const { kernel } = env.app

    // Registered & enabled by default with command, workbench panel, and compiled client bundle
    const summary = kernel.plugins.get(PLAN_PLUGIN_ID)
    assert.ok(summary && summary.enabled, 'builtin:plan must be registered and enabled by default')
    const uiList = kernel.plugins.listUi()
    const cmd = uiList.find((u) => u.pluginId === PLAN_PLUGIN_ID && u.surface === 'commandPalette')
    assert.ok(cmd)
    assert.equal((cmd.spec as { slash?: unknown }).slash, PLAN_COMMAND_SLASH)
    assert.deepEqual((cmd.spec as { scope?: unknown }).scope, { topLevelOnly: true, ownedBy: 'human' })
    const panel = uiList.find((u) => u.pluginId === PLAN_PLUGIN_ID && u.surface === 'workbench.panel')
    assert.ok(panel)
    assert.equal((panel.spec as { id?: unknown }).id, PLAN_PANEL_ID)
    assert.deepEqual((panel.spec as { scope?: unknown }).scope, { topLevelOnly: true, ownedBy: 'human' })
    const clientMod = await kernel.plugins.getClientModule(PLAN_PLUGIN_ID, 'index.tsx')
    assert.match(clientMod.code, /PlanMenuItem/)
    assert.match(clientMod.code, /PlanToolbarButton/)
    assert.match(clientMod.code, /useComposerCommand/)
    assert.match(clientMod.code, /PlanActiveTray/)
    assert.match(clientMod.code, /PlanWorkbenchPanel/)
    assert.match(clientMod.code, /PlanToolRow/)

    // Create a second profile so profile.catalog would normally appear when dispatch tools are active
    await kernel.profiles.save({
      id: 'reviewer',
      name: 'Reviewer',
      system: 'Code reviewer profile.',
    })

    // T4 (normal mode): hides plan_save/plan_propose and injects zero plan.mode section
    const convNormal = await kernel.conversations.createConversation({ title: 'Normal check' })
    const normalRequests: CapturedTurnRequest[] = []
    env.faux.setResponses([captureRequest(normalRequests, 'normal reply')])
    await kernel.conversations.submitInput(convNormal.id, 'inspect repo normally')
    await kernel.conversations.waitForIdle(convNormal.id)

    assert.equal(normalRequests.length, 1)
    const normalReq = normalRequests[0]!
    assert.equal(normalReq.toolNames.includes(PLAN_TOOL_SAVE), false)
    assert.equal(normalReq.toolNames.includes(PLAN_TOOL_PROPOSE), false)
    for (const expectedNormalTool of ['read', 'write', 'edit', 'register_artifact', 'run_action', 'subagent']) {
      assert.equal(
        normalReq.toolNames.includes(expectedNormalTool),
        true,
        `normal mode must retain ${expectedNormalTool}`,
      )
    }
    assert.equal(normalReq.sectionsById[PLAN_MODE_SECTION_ID], undefined)
    assert.ok(
      typeof normalReq.sectionsById['profile.catalog'] === 'string',
      'normal mode with subagent active should still allow profile.catalog',
    )

    // T4 (scope guards): subagent & helmx-owned conversations reject toggle/set_mode with 400 plan_unsupported_conversation
    const helmxConv = await kernel.conversations.createConversation({
      title: 'Background job',
      ownedBy: 'helmx',
    })
    const childConv = await kernel.conversations.createConversation({
      title: 'Child worker',
      parentConversationId: convNormal.id,
      ownedBy: 'human',
    })
    for (const unsupportedId of [helmxConv.id, childConv.id]) {
      await assertRejectsCode(
        () => kernel.plugins.invokeAction(PLAN_PLUGIN_ID, 'toggle', { conversationId: unsupportedId }),
        'plan_unsupported_conversation',
        400,
      )
      await assertRejectsCode(
        () =>
          kernel.plugins.invokeAction(PLAN_PLUGIN_ID, 'set_mode', {
            conversationId: unsupportedId,
            mode: 'planning',
          }),
        'plan_unsupported_conversation',
        400,
      )
    }

    // `/plan` submitted to helmx-owned conversation is ignored by onInput (does not enter planning mode)
    const helmxReqs: CapturedTurnRequest[] = []
    env.faux.setResponses([captureRequest(helmxReqs, 'helmx normal')])
    await kernel.conversations.submitInput(helmxConv.id, '/plan ignore me', { origin: 'human' })
    await kernel.conversations.waitForIdle(helmxConv.id)
    assert.equal(
      (await kernel.plugins.invokeAction(PLAN_PLUGIN_ID, 'get', { conversationId: helmxConv.id }) as PlanSessionView).mode,
      'normal',
    )
    assert.equal(helmxReqs[0]!.sectionsById[PLAN_MODE_SECTION_ID], undefined)

    // T3: `/plan <task>` on untitled first turn
    const convPlan = await kernel.conversations.createConversation({ profileId: 'assistant' })
    assert.equal(convPlan.title, '')
    const planRequests: CapturedTurnRequest[] = []
    env.faux.setResponses([captureRequest(planRequests, 'planning response')])

    await kernel.conversations.submitInput(convPlan.id, '/plan Audit auth flow and propose rollout')
    await kernel.conversations.waitForIdle(convPlan.id)

    const updatedConvPlan = kernel.conversations.getConversation(convPlan.id)
    assert.equal(updatedConvPlan.title, 'Audit auth flow and propose rollout')
    assert.equal(updatedConvPlan.title.startsWith('/plan'), false)

    assert.deepEqual(readPlanSession(kernel, convPlan.id), {
      mode: 'planning',
      awaitingApproval: false,
    })
    assert.equal(readPlanBadges(kernel).byConversation[String(convPlan.id)]?.tone, 'accent')

    assert.equal(planRequests.length, 1)
    const planReq = planRequests[0]!
    for (const forbiddenTool of [
      'write',
      'edit',
      'register_artifact',
      'update_steps',
      'subagent',
      'SubagentWorkflow',
      'cleanup_worktree',
      'update_memory',
      'swarm_dispatch_worker',
      'switch_model',
    ]) {
      assert.equal(
        planReq.toolNames.includes(forbiddenTool),
        false,
        `planning mode must strip ${forbiddenTool}`,
      )
    }
    assert.equal(PLAN_MODE_TOOL_WHITELIST.size, 8)
    for (const allowedTool of [...PLAN_MODE_TOOL_WHITELIST]) {
      assert.equal(
        planReq.toolNames.includes(allowedTool),
        true,
        `planning mode must allow ${allowedTool}`,
      )
    }
    assert.equal(
      planReq.toolNames.every((name) => PLAN_MODE_TOOL_WHITELIST.has(name)),
      true,
      `unexpected tool leaked into planning mode: ${planReq.toolNames.join(', ')}`,
    )
    assert.equal(
      planReq.sectionsById['profile.catalog'] ?? null,
      null,
      'stripping dispatch tools before -100 must suppress <available_profiles>',
    )
    const planModeSection = planReq.sectionsById[PLAN_MODE_SECTION_ID]
    assert.ok(typeof planModeSection === 'string' && /READ-ONLY Plan Mode/i.test(planModeSection))
    assert.ok(
      planModeSection.includes('`bash`') &&
        planModeSection.includes('`run_action`') &&
        planModeSection.includes('ask_user') &&
        planModeSection.includes('plan_save') &&
        planModeSection.includes('plan_propose'),
    )
    assert.equal(planReq.toolNames.includes('bash'), true)
    assert.equal(planReq.toolNames.includes('run_action'), true)
    assert.equal(planReq.toolNames.includes('ask_user'), true)
    assert.equal(planReq.toolNames.includes('update_steps'), false)

    // Bare `/plan` enters planning mode without hitting model
    const bareConv = await kernel.conversations.createConversation({ title: 'Bare slash' })
    const callsBeforeBare = env.faux.state.callCount
    const bareSub = await kernel.conversations.submitInput(bareConv.id, '  /plan  ')
    assert.ok(bareSub.submissionId.startsWith('handled:'))
    assert.equal(env.faux.state.callCount, callsBeforeBare)
    assert.equal(readPlanSession(kernel, bareConv.id).mode, 'planning')

    // Standby pre-armed first turn (`meta['builtin:plan'] = { mode: 'planning' }`) enters planning preserving text & title
    const standbyMetaConv = await kernel.conversations.createConversation({ profileId: 'assistant' })
    const metaRequests: CapturedTurnRequest[] = []
    env.faux.setResponses([captureRequest(metaRequests, 'standby meta planning response')])
    await kernel.conversations.submitInput(
      standbyMetaConv.id,
      'Review cache invalidation plan',
      { meta: { [PLAN_INPUT_META_KEY]: { mode: 'planning' } } },
    )
    await kernel.conversations.waitForIdle(standbyMetaConv.id)

    assert.equal(
      kernel.conversations.getConversation(standbyMetaConv.id).title,
      'Review cache invalidation plan',
    )
    assert.deepEqual(readPlanSession(kernel, standbyMetaConv.id), {
      mode: 'planning',
      awaitingApproval: false,
    })
    assert.equal(metaRequests.length, 1)
    assert.equal(
      metaRequests[0]!.toolNames.every((name) => PLAN_MODE_TOOL_WHITELIST.has(name)),
      true,
      'standby inputMeta must apply strict planning whitelist on Turn 1',
    )
    assert.ok(typeof metaRequests[0]!.sectionsById[PLAN_MODE_SECTION_ID] === 'string')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// T5: plan_propose no-draft, revise/cancelled/superseded, approve/handoff/model matrix
// ---------------------------------------------------------------------------

test('T5: plan_propose outcome matrix (no-draft, revise, cancelled, Composer superseded, approve, approve_handoff, approve_handoff_model)', TIMEOUT, async () => {
  const env = await openPlanIntegrationEnv()
  const disposeSecret = env.app.kernel.stash.addRedaction('TOP_SECRET_PLAN_KEY')
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'coder',
      model: 'faux/coder',
      description: 'Execution coder tier',
    })
    await kernel.plugins.setConfig(PLAN_PLUGIN_ID, { executionModel: 'tier/coder' })

    const conv = await kernel.conversations.createConversation({ title: 'Plan matrix' })
    const cid = conv.id
    await kernel.plugins.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: cid, mode: 'planning' })

    // 1) plan_propose without draft fails explicitly
    let noDraftResultSeen = ''
    env.faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall(PLAN_TOOL_PROPOSE, { summary: 'No draft yet' })], { stopReason: 'toolUse' }),
      (context) => {
        noDraftResultSeen = JSON.stringify(context.messages)
        return fauxAssistantMessage('Need to save draft first.')
      },
    ])
    await kernel.conversations.submitInput(cid, 'propose without draft')
    await kernel.conversations.waitForIdle(cid)
    assert.match(noDraftResultSeen, /No plan draft exists yet/i)
    assert.equal(kernel.asks.listAsks().length, 0)
    assert.equal(readPlanSession(kernel, cid).mode, 'planning')

    // 2) plan_save v1 -> plan_propose -> revise (stays planning, no artifact)
    env.faux.setResponses([
      () =>
        fauxAssistantMessage(
          [
            fauxToolCall(PLAN_TOOL_SAVE, {
              title: 'Cache Rollout',
              markdown: '# Cache Plan\n1. Add key TOP_SECRET_PLAN_KEY\n2. Verify',
            }),
          ],
          { stopReason: 'toolUse' },
        ),
      () =>
        fauxAssistantMessage(
          [fauxToolCall(PLAN_TOOL_PROPOSE, { summary: 'Add cache rollout with verification' })],
          { stopReason: 'toolUse' },
        ),
      () => fauxAssistantMessage('Revising based on feedback.'),
    ])
    const reviseTurn = kernel.conversations.submitInput(cid, 'draft and propose v1')
    await waitFor(() => kernel.asks.listAsks('pending').length === 1 && kernel.conversations.getConversation(cid).status === 'blocked')

    const askRevise = kernel.asks.listAsks('pending')[0]!
    const decisionField = askRevise.fields.find((f) => f.name === 'decision')
    assert.equal(decisionField?.type, 'choice')
    assert.equal(decisionField?.defaultValue, 'approve_handoff')
    assert.deepEqual(
      decisionField?.options?.map((o) => o.value),
      ['approve_handoff', 'approve', 'revise'],
    )
    const executionModelField = askRevise.fields.find((f) => f.name === 'executionModel')
    assert.equal(executionModelField?.type, 'model')
    assert.equal(executionModelField?.defaultValue, 'tier/coder')
    assert.ok(askRevise.hint !== undefined)
    assert.equal(readPlanSession(kernel, cid).awaitingApproval, true)
    assert.equal(readPlanBadges(kernel).byConversation[String(cid)]?.tone, 'warn')

    await kernel.asks.answerAsk(
      askRevise.id,
      { decision: 'revise', feedback: 'Include metrics' },
      askRevise.expectedStateSeq,
    )
    await reviseTurn
    await kernel.conversations.waitForIdle(cid)

    assert.equal(readPlanSession(kernel, cid).mode, 'planning')
    assert.equal(readPlanSession(kernel, cid).awaitingApproval, false)
    assert.equal(readPlanSession(kernel, cid).draft?.markdown.includes('TOP_SECRET_PLAN_KEY'), false)
    assert.match(readPlanSession(kernel, cid).draft?.markdown ?? '', /\[REDACTED\]/)
    assert.equal((await kernel.artifacts.list(cid)).length, 0)

    // 3) plan_propose -> cancelled (stays planning, no artifact)
    env.faux.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall(PLAN_TOOL_PROPOSE, { summary: 'Propose v1 again' })],
          { stopReason: 'toolUse' },
        ),
      () => fauxAssistantMessage('Cancelled cleanly.'),
    ])
    await kernel.conversations.submitInput(cid, 'propose again for cancel')
    await waitFor(() => kernel.asks.listAsks('pending').length === 1)
    const askCancel = kernel.asks.listAsks('pending')[0]!
    await kernel.asks.cancelAsk(askCancel.id, 'cancelled')
    await kernel.conversations.waitForIdle(cid)
    assert.equal(readPlanSession(kernel, cid).mode, 'planning')
    assert.equal((await kernel.artifacts.list(cid)).length, 0)

    // 4) plan_propose -> Composer new human message supersedes pending ask (stays planning, no artifact)
    env.faux.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall(PLAN_TOOL_PROPOSE, { summary: 'Propose v1 before composer steer' })],
          { stopReason: 'toolUse' },
        ),
      (context) => {
        const serialized = JSON.stringify(context.messages)
        assert.match(serialized, /superseded/i)
        assert.match(serialized, /Also add circuit breaker/)
        return fauxAssistantMessage('Incorporated composer steer in planning mode.')
      },
    ])
    await kernel.conversations.submitInput(cid, 'propose before composer message')
    await waitFor(() => kernel.asks.listAsks('pending').length === 1)
    const askSupersedeId = kernel.asks.listAsks('pending')[0]!.id
    await kernel.conversations.submitInput(cid, 'Also add circuit breaker', { origin: 'human' })
    await kernel.conversations.waitForIdle(cid)

    assert.equal(kernel.asks.listAsks('superseded').some((a) => a.id === askSupersedeId), true)
    assert.equal(readPlanSession(kernel, cid).mode, 'planning')
    assert.equal(readPlanSession(kernel, cid).awaitingApproval, false)
    assert.equal((await kernel.artifacts.list(cid)).length, 0)
    const detailAfterSuper = await kernel.conversations.getConversationDetail(cid, { limit: 50 })
    const superToolResult = detailAfterSuper.entries
      .filter((e) => e.kind === 'pi.tool-result')
      .map((e) => (e.model?.[0] as { details?: { outcome?: string } } | undefined)?.details?.outcome)
      .filter(Boolean)
    assert.ok(superToolResult.includes('superseded'))

    // 5) plan_propose -> approve (switches to normal, creates plan-v1.md, restores full tools next turn)
    env.faux.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall(PLAN_TOOL_PROPOSE, { summary: 'Ready for plain approval' })],
          { stopReason: 'toolUse' },
        ),
      () => fauxAssistantMessage('Approved without handoff.'),
    ])
    await kernel.conversations.submitInput(cid, 'propose for plain approve')
    await waitFor(() => kernel.asks.listAsks('pending').length === 1)
    const askApprove = kernel.asks.listAsks('pending')[0]!
    await kernel.asks.answerAsk(askApprove.id, { decision: 'approve' }, askApprove.expectedStateSeq)
    await kernel.conversations.waitForIdle(cid)

    const sessionAfterApprove = readPlanSession(kernel, cid)
    assert.equal(sessionAfterApprove.mode, 'normal')
    assert.equal(sessionAfterApprove.approved?.artifactName, 'plan-v1.md')
    assert.equal(sessionAfterApprove.approved?.handoffUsed, false)
    const artifactsV1 = await kernel.artifacts.list(cid)
    assert.equal(artifactsV1.length, 1)
    assert.equal(artifactsV1[0]!.name, 'plan-v1.md')
    const v1Bytes = Buffer.from(await kernel.artifacts.readBuffer(artifactsV1[0]!.id))
    assert.equal(v1Bytes.toString('utf8'), '# Cache Plan\n1. Add key [REDACTED]\n2. Verify')

    // Next turn has full tools restored
    const restoredReqs: CapturedTurnRequest[] = []
    env.faux.setResponses([captureRequest(restoredReqs, 'tools restored')])
    await kernel.conversations.submitInput(cid, 'verify tools restored')
    await kernel.conversations.waitForIdle(cid)
    assert.equal(restoredReqs[0]!.toolNames.includes('write'), true)
    assert.equal(restoredReqs[0]!.toolNames.includes('edit'), true)
    assert.equal(restoredReqs[0]!.toolNames.includes('subagent'), true)
    assert.equal(restoredReqs[0]!.toolNames.includes(PLAN_TOOL_SAVE), false)
    assert.equal(restoredReqs[0]!.sectionsById[PLAN_MODE_SECTION_ID], undefined)

    // 6) approve_handoff -> in-place pi.reset + immediate continuation on current model
    await kernel.plugins.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: cid, mode: 'planning' })
    const seqBeforeHandoff = kernel.conversations.getConversation(cid).completionSeq
    const handoffReqs: CapturedTurnRequest[] = []
    env.faux.setResponses([
      () =>
        fauxAssistantMessage(
          [
            fauxToolCall(PLAN_TOOL_SAVE, {
              title: 'Cache Rollout v2',
              markdown: '# v2\nExecute cache rollout cleanly.',
            }),
          ],
          { stopReason: 'toolUse' },
        ),
      () =>
        fauxAssistantMessage(
          [fauxToolCall(PLAN_TOOL_PROPOSE, { summary: 'Propose v2 for handoff' })],
          { stopReason: 'toolUse' },
        ),
      captureRequest(handoffReqs, 'Executed on fresh handoff context.'),
    ])
    await kernel.conversations.submitInput(cid, 'save v2 and propose handoff')
    await waitFor(() => kernel.asks.listAsks('pending').length === 1)
    const askHandoff = kernel.asks.listAsks('pending')[0]!
    await kernel.asks.answerAsk(
      askHandoff.id,
      { decision: 'approve_handoff', feedback: 'Focus on step 1 first' },
      askHandoff.expectedStateSeq,
    )
    await kernel.conversations.waitForIdle(cid)

    assert.equal(kernel.conversations.getConversation(cid).completionSeq, seqBeforeHandoff + 1)
    assert.equal(await kernel.conversations.getLastAssistantText(cid), 'Executed on fresh handoff context.')
    assert.equal(handoffReqs.length, 1)
    assert.equal(handoffReqs[0]!.modelId, 'faux/faux-1')
    const handoffNonSys = handoffReqs[0]!.messages.filter((m) => m.role !== 'system')
    assert.equal(handoffNonSys.length, 1)
    assert.equal(handoffNonSys[0]!.role, 'user')
    assert.match(String(handoffNonSys[0]!.content), /Approved Plan v2: Cache Rollout v2/)
    assert.match(String(handoffNonSys[0]!.content), /Focus on step 1 first/)
    assert.equal(readPlanSession(kernel, cid).mode, 'normal')
    assert.equal(readPlanSession(kernel, cid).approved?.handoffUsed, true)
    assert.equal(readPlanSession(kernel, cid).approved?.artifactName, 'plan-v2.md')

    // 7) decision: 'approve_handoff' + executionModel: 'tier/coder' -> switches to tier/coder (faux/coder) & runs immediate handoff on coder
    await kernel.plugins.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: cid, mode: 'planning' })
    const modelHandoffReqs: CapturedTurnRequest[] = []
    env.faux.setResponses([
      () =>
        fauxAssistantMessage(
          [
            fauxToolCall(PLAN_TOOL_SAVE, {
              title: 'Coder Implementation Plan',
              markdown: '# v3\nImplement with tier/coder.',
            }),
          ],
          { stopReason: 'toolUse' },
        ),
      () =>
        fauxAssistantMessage(
          [fauxToolCall(PLAN_TOOL_PROPOSE, { summary: 'Propose v3 for coder tier handoff' })],
          { stopReason: 'toolUse' },
        ),
      captureRequest(modelHandoffReqs, 'Executed on coder model.'),
    ])
    await kernel.conversations.submitInput(cid, 'save v3 and handoff to coder')
    await waitFor(() => kernel.asks.listAsks('pending').length === 1)
    const askModelHandoff = kernel.asks.listAsks('pending')[0]!
    assert.equal(askModelHandoff.fields.find((f) => f.name === 'executionModel')?.defaultValue, 'tier/coder')
    await kernel.asks.answerAsk(
      askModelHandoff.id,
      { decision: 'approve_handoff', executionModel: 'tier/coder', feedback: 'Proceed with coder tier' },
      askModelHandoff.expectedStateSeq,
    )
    await kernel.conversations.waitForIdle(cid)

    assert.equal(modelHandoffReqs.length, 1)
    assert.equal(modelHandoffReqs[0]!.modelId, 'faux/coder')
    assert.equal(kernel.conversations.getConversation(cid).model, 'faux/coder')
    assert.equal(await kernel.conversations.getLastAssistantText(cid), 'Executed on coder model.')
    assert.equal(readPlanSession(kernel, cid).mode, 'normal')
    assert.equal(readPlanSession(kernel, cid).approved?.executionModel, 'tier/coder')
    assert.equal(readPlanSession(kernel, cid).approved?.artifactName, 'plan-v3.md')
    const detailV3 = await kernel.conversations.getConversationDetail(cid, { limit: 60 })
    const lastReset = [...detailV3.entries].reverse().find((e) => e.kind === 'pi.reset')
    assert.ok(lastReset !== undefined)
    assert.match(JSON.stringify(lastReset.model), /Execution Model: tier\/coder/)
  } finally {
    disposeSecret()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// T6: Disabled model (409 model_disabled) & missing tier (404 model_tier_not_found)
// ---------------------------------------------------------------------------

test('T6: approve_handoff with disabled model or missing tier fails honestly, stays planning, and creates no artifact', TIMEOUT, async () => {
  const env = await openPlanIntegrationEnv({
    models: [
      { id: 'faux-1', contextWindow: 100_000 },
      { id: 'disabled-target', contextWindow: 100_000 },
    ],
  })
  try {
    const { kernel } = env.app
    await kernel.models.setDisabledModels('faux', ['disabled-target'])
    await kernel.plugins.setConfig(PLAN_PLUGIN_ID, { executionModel: 'faux/disabled-target' })

    const conv = await kernel.conversations.createConversation({ title: 'Model error safety' })
    const cid = conv.id
    await kernel.plugins.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: cid, mode: 'planning' })

    let sawDisabledError = ''
    env.faux.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall(PLAN_TOOL_SAVE, { title: 'Disabled Check', markdown: '# Plan\n1. Test' })],
          { stopReason: 'toolUse' },
        ),
      () =>
        fauxAssistantMessage(
          [fauxToolCall(PLAN_TOOL_PROPOSE, { summary: 'Propose with disabled model' })],
          { stopReason: 'toolUse' },
        ),
      (context) => {
        sawDisabledError = JSON.stringify(context.messages)
        return fauxAssistantMessage('Saw disabled model error, staying in planning.')
      },
    ])
    await kernel.conversations.submitInput(cid, 'propose disabled model')
    await waitFor(() => kernel.asks.listAsks('pending').length === 1)
    const ask1 = kernel.asks.listAsks('pending')[0]!
    assert.equal(ask1.fields.find((f) => f.name === 'executionModel')?.defaultValue, 'faux/disabled-target')
    await kernel.asks.answerAsk(
      ask1.id,
      { decision: 'approve_handoff', executionModel: 'faux/disabled-target' },
      ask1.expectedStateSeq,
    )
    await kernel.conversations.waitForIdle(cid)

    assert.match(sawDisabledError, /disabled/i)
    assert.equal(readPlanSession(kernel, cid).mode, 'planning')
    assert.equal(kernel.conversations.getConversation(cid).model, 'faux/faux-1')
    assert.equal((await kernel.artifacts.list(cid)).length, 0)
    const detail1 = await kernel.conversations.getConversationDetail(cid, { limit: 40 })
    assert.equal(detail1.entries.some((e) => e.kind === 'pi.reset'), false)

    // Missing tier: tier/missing -> stays planning, returns isError, no artifact, no fallback
    await kernel.plugins.setConfig(PLAN_PLUGIN_ID, { executionModel: 'tier/missing' })
    let sawMissingTierError = ''
    env.faux.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall(PLAN_TOOL_PROPOSE, { summary: 'Propose with missing tier' })],
          { stopReason: 'toolUse' },
        ),
      (context) => {
        sawMissingTierError = JSON.stringify(context.messages)
        return fauxAssistantMessage('Saw missing tier error, staying in planning.')
      },
    ])
    await kernel.conversations.submitInput(cid, 'propose missing tier')
    await waitFor(() => kernel.asks.listAsks('pending').length === 1)
    const ask2 = kernel.asks.listAsks('pending')[0]!
    await kernel.asks.answerAsk(
      ask2.id,
      { decision: 'approve_handoff', executionModel: 'tier/missing' },
      ask2.expectedStateSeq,
    )
    await kernel.conversations.waitForIdle(cid)

    assert.match(sawMissingTierError, /tier|not found/i)
    assert.equal(readPlanSession(kernel, cid).mode, 'planning')
    assert.equal(kernel.conversations.getConversation(cid).model, 'faux/faux-1')
    assert.equal((await kernel.artifacts.list(cid)).length, 0)
    const detail2 = await kernel.conversations.getConversationDetail(cid, { limit: 50 })
    assert.equal(detail2.entries.some((e) => e.kind === 'pi.reset'), false)
    const proposeMetas = detail2.entries
      .filter((e) => e.kind === 'pi.tool-result')
      .map((e) => e.model?.[0] as { isError?: boolean; details?: { kind?: string; outcome?: string } } | undefined)
      .filter((m) => m?.details?.kind === 'propose')
    assert.equal(proposeMetas.length, 2)
    assert.ok(proposeMetas.every((m) => m?.isError === true && m?.details?.outcome === 'error'))
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// T7: Abort, set_mode/toggle cancelAsk, liveTasks 409, restart reconcile(), inUse 409 & --force disable/re-enable
// ---------------------------------------------------------------------------

test('T7: pending ask abort, set_mode/toggle cancellation, disable 409 gates, restart reconcile(), force-disable & re-enable', TIMEOUT, async () => {
  const dataDir = await makeTempDir('helmx-plan-t7-')
  let activeEnv: PlanIntegrationEnv | undefined
  try {
    const faux1 = makeFauxProvider({ models: [{ id: 'faux-1' }] })
    const app1 = await createHelmx({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: dataDir,
      model: 'faux/faux-1',
      providers: [faux1.provider],
    })
    await app1.kernel.plugins.setConfig(TITLE_PLUGIN_ID, { autoTitle: false })
    activeEnv = {
      dataDir,
      faux: faux1,
      app: app1,
      close: async () => {
        await app1.close().catch(() => {})
      },
    }

    const k1 = app1.kernel
    const conv = await k1.conversations.createConversation({ title: 'Lifecycle test' })
    const cid = conv.id
    await k1.plugins.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: cid, mode: 'planning' })

    // (a) Human abort while approval is pending -> cancelAsk releases blocked
    faux1.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall(PLAN_TOOL_SAVE, { title: 'Abortable Plan', markdown: '# Step 1\nCheck abort' })],
          { stopReason: 'toolUse' },
        ),
      () =>
        fauxAssistantMessage(
          [fauxToolCall(PLAN_TOOL_PROPOSE, { summary: 'Pending ask for abort' })],
          { stopReason: 'toolUse' },
        ),
      () => fauxAssistantMessage('After abort'),
    ])
    await k1.conversations.submitInput(cid, 'propose then abort')
    await waitFor(() => k1.asks.listAsks('pending').length === 1 && k1.conversations.getConversation(cid).status === 'blocked')
    const abortAskId = k1.asks.listAsks('pending')[0]!.id

    await k1.conversations.abortConversation(cid)
    await k1.conversations.waitForIdle(cid)
    assert.equal(k1.conversations.getConversation(cid).pendingAskCount, 0)
    assert.notEqual(k1.conversations.getConversation(cid).status, 'blocked')
    assert.equal(k1.asks.listAsks('cancelled').some((a) => a.id === abortAskId), true)
    assert.equal(readPlanSession(k1, cid).mode, 'planning')
    assert.equal(readPlanSession(k1, cid).awaitingApproval, false)

    // (b) & (c) Pending ask -> disable returns 409 plugin_has_live_tasks (even with force); set_mode('normal') cancels ask & releases blocked
    faux1.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall(PLAN_TOOL_PROPOSE, { summary: 'Pending ask for disable & set_mode' })],
          { stopReason: 'toolUse' },
        ),
      () => fauxAssistantMessage('Exited planning during ask.'),
    ])
    await k1.conversations.submitInput(cid, 'propose for set_mode and disable check')
    await waitFor(() => k1.asks.listAsks('pending').length === 1 && k1.conversations.getConversation(cid).status === 'blocked')
    const modeAskId = k1.asks.listAsks('pending')[0]!.id

    // (c) Disable blocked by liveTasks (even with force: true)
    await assertRejectsCode(() => k1.plugins.disable(PLAN_PLUGIN_ID), 'plugin_has_live_tasks', 409)
    await assertRejectsCode(() => k1.plugins.disable(PLAN_PLUGIN_ID, { force: true }), 'plugin_has_live_tasks', 409)

    // (b) set_mode('normal') cancels pending AskDoc and releases blocked
    const setNormalView = (await k1.plugins.invokeAction(PLAN_PLUGIN_ID, 'set_mode', {
      conversationId: cid,
      mode: 'normal',
    })) as PlanSessionView
    assert.equal(setNormalView.mode, 'normal')
    assert.equal(setNormalView.awaitingApproval, false)
    await k1.conversations.waitForIdle(cid)
    assert.equal(k1.conversations.getConversation(cid).pendingAskCount, 0)
    assert.notEqual(k1.conversations.getConversation(cid).status, 'blocked')
    assert.equal(k1.asks.listAsks('cancelled').some((a) => a.id === modeAskId), true)

    // Verify `toggle` also cancels an active pending ask when toggling off
    await k1.plugins.invokeAction(PLAN_PLUGIN_ID, 'toggle', { conversationId: cid })
    faux1.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall(PLAN_TOOL_PROPOSE, { summary: 'Pending ask for toggle off' })],
          { stopReason: 'toolUse' },
        ),
      () => fauxAssistantMessage('Toggled off during ask.'),
    ])
    await k1.conversations.submitInput(cid, 'propose for toggle off')
    await waitFor(() => k1.asks.listAsks('pending').length === 1 && k1.conversations.getConversation(cid).status === 'blocked')
    const toggleAskId = k1.asks.listAsks('pending')[0]!.id
    const toggledOff = (await k1.plugins.invokeAction(PLAN_PLUGIN_ID, 'toggle', {
      conversationId: cid,
    })) as PlanSessionView
    assert.equal(toggledOff.mode, 'normal')
    assert.equal(toggledOff.awaitingApproval, false)
    await k1.conversations.waitForIdle(cid)
    assert.equal(k1.asks.listAsks('cancelled').some((a) => a.id === toggleAskId), true)

    // (d) Seed orphaned pendingAskId in KV + pending AskDoc in SQLite before closing, then restart Hub
    await k1.plugins.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: cid, mode: 'planning' })
    const orphanAskId = 'orphan-plan-ask-restart'
    const orphanWaiter = k1.asks.createAsk({
      id: orphanAskId,
      conversationId: cid,
      ownerPluginId: PLAN_PLUGIN_ID,
      title: 'Orphaned Plan Approval',
      expectedStateSeq: k1.conversations.getConversation(cid).stateChangeSeq,
      fields: [
        {
          name: 'decision',
          label: 'Decision',
          type: 'select',
          required: true,
          options: [{ label: 'Approve', value: 'approve' }],
        },
      ],
    })
    void orphanWaiter.catch(() => {})
    await waitFor(() => k1.asks.listAsks('pending').length === 1 && k1.conversations.getConversation(cid).status === 'blocked')
    const existingRecord = JSON.parse(
      k1.kvStore.get(PLAN_PLUGIN_ID, PLAN_KV_NAMESPACE, String(cid))!.valueJson,
    ) as PlanConversationRecord
    k1.kvStore.put(
      PLAN_PLUGIN_ID,
      PLAN_KV_NAMESPACE,
      String(cid),
      JSON.stringify({ ...existingRecord, pendingAskId: orphanAskId }),
    )
    await k1.kvStore.flush()

    await app1.close()
    activeEnv = undefined

    // Simulated Hub restart: reconcile() must supersede orphaned AskDoc & clear pendingAskId
    const faux2 = makeFauxProvider({ models: [{ id: 'faux-1' }] })
    const app2 = await createHelmx({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: dataDir,
      model: 'faux/faux-1',
      providers: [faux2.provider],
    })
    await app2.kernel.plugins.setConfig(TITLE_PLUGIN_ID, { autoTitle: false })
    activeEnv = {
      dataDir,
      faux: faux2,
      app: app2,
      close: async () => {
        await app2.close().catch(() => {})
      },
    }
    const k2 = app2.kernel
    assert.equal(k2.asks.listAsks('pending').length, 0)
    assert.equal(k2.asks.listAsks('superseded').some((a) => a.id === orphanAskId), true)
    assert.equal(k2.conversations.getConversation(cid).pendingAskCount, 0)
    assert.notEqual(k2.conversations.getConversation(cid).status, 'blocked')
    assert.deepEqual(readPlanSession(k2, cid).awaitingApproval, false)
    assert.equal(readPlanSession(k2, cid).mode, 'planning')
    assert.equal(readPlanBadges(k2).byConversation[String(cid)]?.tone, 'accent')

    // Idle planning session blocks disable with 409 plugin_in_use; --force disables & restores tools immediately
    await assertRejectsCode(() => k2.plugins.disable(PLAN_PLUGIN_ID), 'plugin_in_use', 409)
    await k2.plugins.disable(PLAN_PLUGIN_ID, { force: true })
    assert.equal(k2.plugins.listUi().some((u) => u.pluginId === PLAN_PLUGIN_ID), false)

    const disabledReqs: CapturedTurnRequest[] = []
    faux2.setResponses([captureRequest(disabledReqs, 'tools restored after force disable')])
    await k2.conversations.submitInput(cid, 'turn while plugin disabled')
    await k2.conversations.waitForIdle(cid)
    assert.equal(disabledReqs[0]!.toolNames.includes('write'), true)
    assert.equal(disabledReqs[0]!.toolNames.includes('edit'), true)
    assert.equal(disabledReqs[0]!.toolNames.includes('subagent'), true)
    assert.equal(disabledReqs[0]!.toolNames.includes(PLAN_TOOL_SAVE), false)
    assert.equal(disabledReqs[0]!.toolNames.includes(PLAN_TOOL_PROPOSE), false)
    assert.equal(disabledReqs[0]!.toolNames.includes('ask_user'), true)
    assert.equal(disabledReqs[0]!.sectionsById[PLAN_MODE_SECTION_ID], undefined)

    // Re-enabling restores planning mode & restricted whitelist
    await k2.plugins.enable(PLAN_PLUGIN_ID)
    assert.equal(
      k2.plugins.listUi().some((u) => u.pluginId === PLAN_PLUGIN_ID && u.surface === 'commandPalette'),
      true,
    )
    const reenabledReqs: CapturedTurnRequest[] = []
    faux2.setResponses([captureRequest(reenabledReqs, 'planning mode restored')])
    await k2.conversations.submitInput(cid, 'turn after re-enable')
    await k2.conversations.waitForIdle(cid)
    assert.equal(reenabledReqs[0]!.toolNames.includes(PLAN_TOOL_SAVE), true)
    assert.equal(reenabledReqs[0]!.toolNames.includes(PLAN_TOOL_PROPOSE), true)
    assert.equal(reenabledReqs[0]!.toolNames.includes('ask_user'), true)
    assert.equal(reenabledReqs[0]!.toolNames.includes('bash'), true)
    assert.equal(reenabledReqs[0]!.toolNames.includes('run_action'), true)
    assert.equal(reenabledReqs[0]!.toolNames.includes('write'), false)
    assert.equal(reenabledReqs[0]!.toolNames.includes('edit'), false)
    assert.equal(reenabledReqs[0]!.toolNames.includes('update_steps'), false)
    assert.ok(typeof reenabledReqs[0]!.sectionsById[PLAN_MODE_SECTION_ID] === 'string')
  } finally {
    await activeEnv?.close()
    await cleanupDir(dataDir)
  }
})

// ---------------------------------------------------------------------------
// T8: Subagent reads approved plan artifact via read_artifact; parent deletion cleans KV/sessionDoc/badges
// ---------------------------------------------------------------------------

test('T8: spawned subagent reads approved plan artifact via read_artifact and deleting parent cleans KV, sessionDoc, and badges', TIMEOUT, async () => {
  const env = await openPlanIntegrationEnv()
  try {
    const { kernel } = env.app
    const parent = await kernel.conversations.createConversation({ title: 'Parent with plan artifact' })
    const pid = parent.id

    await kernel.plugins.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: pid, mode: 'planning' })
    const planMarkdown = '# Execution Spec\n1. Update module A\n2. Run verification'
    env.faux.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall(PLAN_TOOL_SAVE, { title: 'Execution Spec', markdown: planMarkdown })],
          { stopReason: 'toolUse' },
        ),
      () =>
        fauxAssistantMessage(
          [fauxToolCall(PLAN_TOOL_PROPOSE, { summary: 'Approve execution spec' })],
          { stopReason: 'toolUse' },
        ),
      () => fauxAssistantMessage('Plan approved.'),
    ])
    await kernel.conversations.submitInput(pid, 'save and approve plan')
    await waitFor(() => kernel.asks.listAsks('pending').length === 1)
    const ask = kernel.asks.listAsks('pending')[0]!
    await kernel.asks.answerAsk(ask.id, { decision: 'approve' }, ask.expectedStateSeq)
    await kernel.conversations.waitForIdle(pid)

    const approved = readPlanSession(kernel, pid).approved
    assert.ok(approved?.artifactId)
    const artifactId = approved.artifactId

    // Parent spawns subagent which reads artifactId via read_artifact
    let childReadText = ''
    env.faux.setResponses([
      () =>
        fauxAssistantMessage(
          [
            fauxToolCall('subagent', {
              label: 'read-plan',
              prompt: `Read the approved plan artifact ${artifactId} using read_artifact.`,
              background: false,
            }),
          ],
          { stopReason: 'toolUse' },
        ),
      () =>
        fauxAssistantMessage(
          [fauxToolCall('read_artifact', { id: artifactId })],
          { stopReason: 'toolUse' },
        ),
      (context) => {
        childReadText = JSON.stringify(context.messages)
        return fauxAssistantMessage('Read approved plan artifact successfully.')
      },
      () => fauxAssistantMessage('Subagent finished reading the plan.'),
    ])

    await kernel.conversations.submitInput(pid, 'delegate reading approved plan to subagent')
    await kernel.conversations.waitForIdle(pid)

    assert.match(childReadText, /Execution Spec/)
    assert.match(childReadText, /Run verification/)
    assert.equal(await kernel.conversations.getLastAssistantText(pid), 'Subagent finished reading the plan.')
    assert.ok(readPlanBadges(kernel).byConversation[String(pid)] !== undefined)
    assert.ok(kernel.kvStore.get(PLAN_PLUGIN_ID, PLAN_KV_NAMESPACE, String(pid)) !== undefined)

    // Deleting parent cleans KV, sessionDoc, and badges
    await kernel.conversations.deleteConversation(pid)
    await waitFor(
      () =>
        kernel.kvStore.get(PLAN_PLUGIN_ID, PLAN_KV_NAMESPACE, String(pid)) === undefined &&
        readPlanBadges(kernel).byConversation[String(pid)] === undefined,
    )
    assert.throws(
      () => kernel.plugins.getPublicSessionDoc(PLAN_PLUGIN_ID, PLAN_SESSION_DOC, pid),
      (err: unknown) => err instanceof HelmxError && err.status === 404,
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// T9: native bash & read-only run_action, kernel ask_user in plan mode, update_draft before approval, and manual /clear resetConversation
// ---------------------------------------------------------------------------

test('T9: native bash & read-only run_action work in plan mode, ask_user clarifies without setting awaitingApproval, update_draft edits before approval, and resetConversation clears plan state', TIMEOUT, async () => {
  const env = await openPlanIntegrationEnv()
  try {
    const { kernel } = env.app
    const conv = await kernel.conversations.createConversation({ title: 'T9 Plan Enhancements' })
    const cid = conv.id
    await kernel.plugins.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: cid, mode: 'planning' })

    // 1) Native bash (`pwd`) and read-only `run_action` (`list` & `builtin:plan.get`) execute cleanly during planning mode
    let sawReadOnlyResults = ''
    env.faux.setResponses([
      () =>
        fauxAssistantMessage(
          [
            fauxToolCall('bash', { command: 'pwd' }),
            fauxToolCall('run_action', { list: true, pluginId: PLAN_PLUGIN_ID }),
            fauxToolCall('run_action', { actionId: 'builtin:plan.get', input: {} }),
          ],
          { stopReason: 'toolUse' },
        ),
      (context) => {
        sawReadOnlyResults = JSON.stringify(context.messages)
        return fauxAssistantMessage('Inspected workspace via native bash and read-only run_action.')
      },
    ])
    await kernel.conversations.submitInput(cid, 'run read-only bash and run_action queries')
    await kernel.conversations.waitForIdle(cid)

    assert.equal(sawReadOnlyResults.includes(env.dataDir), true)
    assert.equal(sawReadOnlyResults.includes('builtin:plan.get'), true)
    assert.equal(sawReadOnlyResults.includes('"mode": "planning"') || sawReadOnlyResults.includes('\\"mode\\":\\"planning\\"'), true)
    const detailReadOnly = await kernel.conversations.getConversationDetail(cid, { limit: 30 })
    const toolResults = detailReadOnly.entries
      .filter((e) => e.kind === 'pi.tool-result')
      .map((e) => e.model?.[0] as { toolName?: string; isError?: boolean } | undefined)
    const bashResults = toolResults.filter((m) => m?.toolName === 'bash')
    const actionResults = toolResults.filter((m) => m?.toolName === 'run_action')
    assert.equal(bashResults.length, 1)
    assert.equal(bashResults[0]?.isError, false)
    assert.equal(actionResults.length, 2)
    assert.equal(actionResults[0]?.isError, false)
    assert.equal(actionResults[1]?.isError, false)

    // 2) kernel ask_user inside planning mode: creates question AskDoc with allowCustom without triggering awaitingApproval
    let sawClarificationAnswer = ''
    env.faux.setResponses([
      () =>
        fauxAssistantMessage(
          [
            fauxToolCall('ask_user', {
              title: 'Storage Strategy',
              questions: [
                {
                  id: 'store',
                  question: 'Which persistence layer should the module use?',
                  options: [
                    { value: 'sqlite', label: 'SQLite', description: 'Zero-config embedded DB', recommended: true },
                    { value: 'kv', label: 'Plugin KV', description: 'JSON document namespace' },
                  ],
                },
                {
                  id: 'notes',
                  question: 'Any constraints?',
                  type: 'text',
                  required: false,
                },
              ],
            }),
          ],
          { stopReason: 'toolUse' },
        ),
      (context) => {
        sawClarificationAnswer = JSON.stringify(context.messages)
        return fauxAssistantMessage('Understood, targeting SQLite.')
      },
    ])
    await kernel.conversations.submitInput(cid, 'ask storage strategy')
    await waitFor(() => kernel.asks.listAsks('pending').length === 1)

    const clarifyAsk = kernel.asks.listAsks('pending')[0]!
    assert.equal(clarifyAsk.kind, 'question')
    assert.equal(clarifyAsk.fields[0]?.type, 'choice')
    assert.equal(clarifyAsk.fields[0]?.allowCustom, true)
    assert.equal(clarifyAsk.fields[0]?.options?.[0]?.recommended, true)
    assert.equal(clarifyAsk.fields[1]?.name, 'notes')
    assert.equal(clarifyAsk.hint, undefined)
    const clarifySession = readPlanSession(kernel, cid)
    assert.equal(clarifySession.mode, 'planning')
    assert.equal(clarifySession.awaitingApproval, false)

    await kernel.asks.answerAsk(
      clarifyAsk.id,
      { store: 'sqlite', notes: 'Use WAL mode' },
      clarifyAsk.expectedStateSeq,
    )
    await kernel.conversations.waitForIdle(cid)
    assert.equal(readPlanSession(kernel, cid).awaitingApproval, false)
    assert.match(sawClarificationAnswer, /sqlite \(SQLite\)/)
    assert.match(sawClarificationAnswer, /Use WAL mode/)

    // 3) plan_save v1 -> human update_draft -> v2 (with CAS 409 check) -> plan_propose archives edited v2
    env.faux.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall(PLAN_TOOL_SAVE, { title: 'Initial Plan', markdown: '# v1\nInitial steps' })],
          { stopReason: 'toolUse' },
        ),
      () => fauxAssistantMessage('Saved v1 draft.'),
    ])
    await kernel.conversations.submitInput(cid, 'save v1 draft')
    await kernel.conversations.waitForIdle(cid)
    assert.equal(readPlanSession(kernel, cid).draft?.version, 1)

    await assertRejectsCode(
      () =>
        kernel.plugins.invokeAction(PLAN_PLUGIN_ID, 'update_draft', {
          conversationId: cid,
          title: 'Stale',
          markdown: '# Stale',
          expectedVersion: 0,
        }),
      'plan_draft_conflict',
    )

    const editedView = (await kernel.plugins.invokeAction(PLAN_PLUGIN_ID, 'update_draft', {
      conversationId: cid,
      title: 'Human Edited Plan',
      markdown: '# Human Edited v2\nExecute carefully',
      expectedVersion: 1,
    })) as PlanSessionView
    assert.equal(editedView.draft?.version, 2)

    env.faux.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall(PLAN_TOOL_PROPOSE, { summary: 'Approve human-edited v2' })],
          { stopReason: 'toolUse' },
        ),
      () => fauxAssistantMessage('Approved edited v2.'),
    ])
    await kernel.conversations.submitInput(cid, 'propose edited v2')
    await waitFor(() => kernel.asks.listAsks('pending').length === 1)
    const proposeEditedAsk = kernel.asks.listAsks('pending')[0]!
    await kernel.asks.answerAsk(
      proposeEditedAsk.id,
      { decision: 'approve', feedback: '' },
      proposeEditedAsk.expectedStateSeq,
    )
    await kernel.conversations.waitForIdle(cid)

    const approvedV2 = readPlanSession(kernel, cid).approved
    assert.equal(approvedV2?.version, 2)
    assert.equal(approvedV2?.artifactName, 'plan-v2.md')
    const artifactBytes = Buffer.from(await kernel.artifacts.readBuffer(approvedV2!.artifactId))
    assert.equal(artifactBytes.toString('utf8'), '# Human Edited v2\nExecute carefully')

    // 4) Manual /clear (resetConversation) emits pi.reset and resets plan state, KV, sessionDoc, and badge
    await kernel.conversations.resetConversation(cid)
    await waitFor(
      () =>
        kernel.kvStore.get(PLAN_PLUGIN_ID, PLAN_KV_NAMESPACE, String(cid)) === undefined &&
        readPlanBadges(kernel).byConversation[String(cid)] === undefined,
    )
    assert.deepEqual(readPlanSession(kernel, cid), { mode: 'normal', awaitingApproval: false })
    const resetView = (await kernel.plugins.invokeAction(PLAN_PLUGIN_ID, 'get', {
      conversationId: cid,
    })) as PlanSessionView
    assert.equal(resetView.mode, 'normal')
    assert.equal(resetView.draft, undefined)
    assert.equal(resetView.approved, undefined)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// T9: Managed skill `plan` bootstrap, disable cleanup (zero phantom prompts), and re-enable
// ---------------------------------------------------------------------------

test('T9: builtin:plan bootstraps managed skill plan and removes it cleanly from <available_skills> and load_skill on disable', TIMEOUT, async () => {
  const env = await openPlanIntegrationEnv()
  try {
    const { kernel } = env.app
    const skills = await kernel.skills.list()
    const planSkill = skills.find((s) => s.id === PLAN_SKILL_ID)
    assert.ok(planSkill, 'builtin:plan must bootstrap managed skill plan on startup')
    assert.equal(planSkill.managedByPlugin, PLAN_PLUGIN_ID)

    const skillMd = await kernel.skills.readFile(PLAN_SKILL_ID)
    assert.ok(skillMd.includes('managedByPlugin: builtin:plan'))
    for (const token of [
      'bash',
      'run_action',
      'ask_user',
      PLAN_TOOL_SAVE,
      PLAN_TOOL_PROPOSE,
      'builtin:plan.get',
      'builtin:plan.toggle',
      'builtin:plan.set_mode',
      'builtin:plan.update_draft',
    ]) {
      assert.ok(skillMd.includes(token), `plan SKILL.md must document ${token}`)
    }

    const readSkillsSection = async () => {
      const res = await kernel.plugins.runHook('before_turn', {
        conversation: kernel.conversations.getConversation(1),
        inputs: [],
        sections: [],
        tools: [],
        messages: [],
      })
      assert.equal(res.action, 'transform')
      return res.value.sections.find((s) => s.id === 'profile.skills')?.text ?? ''
    }

    assert.ok((await readSkillsSection()).includes('id="plan"'), 'enabled builtin:plan must expose plan in <available_skills>')
    const loaded = (await kernel.plugins.executeTool(
      'load_skill',
      { skillId: PLAN_SKILL_ID },
      { conversationId: 1 },
    )) as { text: string }
    assert.ok(loaded.text.includes('# Plan Mode'))

    await kernel.plugins.disable(PLAN_PLUGIN_ID)
    assert.equal((await readSkillsSection()).includes('id="plan"'), false, 'disabled builtin:plan must leave zero phantom plan skill in <available_skills>')
    await assert.rejects(
      () => kernel.plugins.executeTool('load_skill', { skillId: PLAN_SKILL_ID }, { conversationId: 1 }),
      (err: unknown) => err instanceof HelmxError && err.code === 'skill_not_available' && err.status === 403,
    )

    await kernel.plugins.enable(PLAN_PLUGIN_ID)
    assert.ok((await readSkillsSection()).includes('id="plan"'), 're-enabled builtin:plan must restore plan in <available_skills>')
  } finally {
    await env.close()
  }
})
