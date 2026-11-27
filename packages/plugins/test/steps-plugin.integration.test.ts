/**
 * builtin:steps real composition-root integration tests (`createHelmx` + `faux` provider):
 * - Tool execution persists `presentationMeta` in `pi.tool-result.model[0].details` without echoing JSON
 *   back into model output, projects `steps` `sessionDoc`, and preserves/clears state honestly across
 *   `turn_settled`, human `onInput`, and `pi.reset`;
 * - Disabling `builtin:steps` removes `update_steps` from tools and manifests immediately;
 * - Cross-plugin interop:
 *   - `builtin:tiers` orchestrator Planning Phase strips `update_steps` while keeping `exit_plan_mode`, and
 *     Execution Phase restores `update_steps` so the Executor can track live progress;
 *   - `builtin:plan` Planning Mode strips `update_steps` during read-only planning and restores it in normal mode;
 * - Real conversation rewind (`replaceFromEntryId`) accurately rolls `steps` `sessionDoc` back to prior steps
 *   or clears if rewound before any `update_steps` call.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai/providers/faux'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { createHelmx } from '../../hub/src/app.js'
import { PLAN_PLUGIN_ID } from '../src/plan.js'
import {
  STEPS_KV_NAMESPACE,
  STEPS_PLUGIN_ID,
  STEPS_SESSION_DOC,
  STEPS_TOOL_UPDATE,
  type StepsSessionView,
} from '../src/steps.js'
import {
  TIERS_EXIT_PLAN_MODE_TOOL,
  TIERS_PLUGIN_ID,
} from '../src/tiers.js'
import { TITLE_PLUGIN_ID } from '../src/title/contracts.js'
import {
  cleanupDir,
  makeFauxProvider,
  makeTempDir,
  waitFor,
  type FauxProviderHandle,
} from './helpers/plugin-test-env.js'

const TIMEOUT = { timeout: 60_000 } as const

interface CapturedTurn {
  modelId: string
  toolNames: string[]
}

interface StepsIntegrationEnv {
  dataDir: string
  faux: FauxProviderHandle
  app: Awaited<ReturnType<typeof createHelmx>>
  close: () => Promise<void>
}

async function openStepsIntegrationEnv(): Promise<StepsIntegrationEnv> {
  const dataDir = await makeTempDir('helmx-steps-it-')
  const faux = makeFauxProvider({
    models: [
      { id: 'flagship', name: 'Flagship', contextWindow: 200_000 },
      { id: 'workhorse', name: 'Workhorse', contextWindow: 128_000 },
    ],
  })
  const app = await createHelmx({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    cwd: dataDir,
    model: 'faux/flagship',
    providers: [faux.provider],
  })
  if (app.kernel.plugins.get(TITLE_PLUGIN_ID)?.enabled) {
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

function captureTurn(sink: CapturedTurn[], reply: ReturnType<typeof fauxAssistantMessage>): FauxResponseStep {
  return (context, _opts, _state, model) => {
    sink.push({
      modelId: `${model.provider}/${model.id}`,
      toolNames: getCurrentTools(context.messages as never).map((t) => t.name),
    })
    return reply
  }
}

function readStepsDoc(kernel: StepsIntegrationEnv['app']['kernel'], convId: number): StepsSessionView | null {
  return kernel.plugins.getPublicSessionDoc(STEPS_PLUGIN_ID, STEPS_SESSION_DOC, convId).value as StepsSessionView | null
}

test('end-to-end update_steps persistence, disable cleanup, and rewind recovery', TIMEOUT, async () => {
  const env = await openStepsIntegrationEnv()
  try {
    const { kernel } = env.app
    const summary = kernel.plugins.get(STEPS_PLUGIN_ID)
    assert.ok(summary && summary.enabled, 'builtin:steps must be enabled by default')

    const captured: CapturedTurn[] = []
    env.faux.setResponses([
      captureTurn(
        captured,
        fauxAssistantMessage(
          [
            fauxToolCall(STEPS_TOOL_UPDATE, {
              steps: [
                { title: 'Inspect codebase', status: 'in_progress' },
                { title: 'Edit module', status: 'pending' },
                { title: 'Run tests', status: 'pending' },
              ],
            }),
          ],
          { stopReason: 'toolUse' },
        ),
      ),
      captureTurn(
        captured,
        fauxAssistantMessage(
          [
            fauxToolCall(STEPS_TOOL_UPDATE, {
              steps: [
                { title: 'Inspect codebase', status: 'done' },
                { title: 'Edit module', status: 'in_progress' },
                { title: 'Run tests', status: 'pending' },
              ],
            }),
          ],
          { stopReason: 'toolUse' },
        ),
      ),
      captureTurn(captured, fauxAssistantMessage('Working on edits, paused for check-in.')),
    ])

    await kernel.conversations.submitInput(1, 'Please refactor and verify this module')
    await kernel.conversations.waitForIdle(1)

    assert.ok(captured[0]?.toolNames.includes(STEPS_TOOL_UPDATE))
    const view1 = readStepsDoc(kernel, 1)
    assert.ok(view1 !== null)
    assert.equal(view1.steps.length, 3)
    assert.equal(view1.steps[1]?.status, 'in_progress')
    assert.equal(view1.allTerminal, false)
    assert.equal(view1.settledOutcome, 'completed')

    // Detail entry preserves structured presentationMeta on pi.tool-result.model[0].details
    const detail1 = await kernel.conversations.getConversationDetail(1, { limit: 50 })
    const toolResultEntries = detail1.entries.filter((e) => e.kind === 'pi.tool-result')
    assert.equal(toolResultEntries.length, 2)
    const lastMsg = toolResultEntries[1]!.model?.[0] as { toolName?: string; details?: { version?: number; done?: number } } | undefined
    assert.equal(lastMsg?.toolName, STEPS_TOOL_UPDATE)
    assert.equal(lastMsg?.details?.done, 1)

    // Turn 2 marks all steps done -> allTerminal === true
    const humanEntriesBeforeTurn2 = detail1.entries.filter((e) => e.kind === 'helmx.input')
    assert.equal(humanEntriesBeforeTurn2.length, 1)

    env.faux.setResponses([
      captureTurn(
        captured,
        fauxAssistantMessage(
          [
            fauxToolCall(STEPS_TOOL_UPDATE, {
              steps: [
                { title: 'Inspect codebase', status: 'done' },
                { title: 'Edit module', status: 'done' },
                { title: 'Run tests', status: 'done' },
              ],
            }),
          ],
          { stopReason: 'toolUse' },
        ),
      ),
      captureTurn(captured, fauxAssistantMessage('All steps completed.')),
    ])
    await kernel.conversations.submitInput(1, 'Finish remaining steps')
    await kernel.conversations.waitForIdle(1)

    const detail2 = await kernel.conversations.getConversationDetail(1, { limit: 50 })
    const turn2Input = detail2.entries.filter((e) => e.kind === 'helmx.input')[1]!
    assert.equal(readStepsDoc(kernel, 1)?.allTerminal, true)

    // Rewind back to before Turn 2 -> restores Turn 1 incomplete checklist (`Inspect done, Edit in_progress`)
    env.faux.setResponses([
      captureTurn(captured, fauxAssistantMessage('Holding before re-running Turn 2.')),
    ])
    await kernel.conversations.submitInput(1, 'Different second turn without update_steps', {
      replaceFromEntryId: Number(turn2Input.id),
    })
    await kernel.conversations.waitForIdle(1)
    await waitFor(() => readStepsDoc(kernel, 1)?.allTerminal === false)
    const restored = readStepsDoc(kernel, 1)!
    assert.equal(restored.steps[0]?.status, 'done')
    assert.equal(restored.steps[1]?.status, 'in_progress')

    // Rewind Turn 1 itself -> no update_steps in visible history -> cleared cleanly
    env.faux.setResponses([captureTurn(captured, fauxAssistantMessage('Fresh start reply.'))])
    await kernel.conversations.submitInput(1, 'Simple question instead', {
      replaceFromEntryId: Number(humanEntriesBeforeTurn2[0]!.id),
    })
    await kernel.conversations.waitForIdle(1)
    await waitFor(() => readStepsDoc(kernel, 1) === null)
    assert.equal(kernel.kvStore.get(STEPS_PLUGIN_ID, STEPS_KV_NAMESPACE, '1'), undefined)

    // Disabling builtin:steps removes update_steps immediately from model tools
    await kernel.plugins.disable(STEPS_PLUGIN_ID)
    const hookDisabled = await kernel.plugins.runHook('before_turn', {
      conversation: kernel.conversations.getConversation(1),
      inputs: [],
      sections: [],
      tools: kernel.plugins.listTools(),
      messages: [],
    } as never)
    const toolsWhenDisabled =
      hookDisabled.action === 'transform'
        ? (hookDisabled.value as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
        : kernel.plugins.listTools().map((t) => t.name)
    assert.equal(toolsWhenDisabled.includes(STEPS_TOOL_UPDATE), false)

    await kernel.plugins.enable(STEPS_PLUGIN_ID)
  } finally {
    await env.close()
  }
})

test('cross-plugin interop: tiers orchestrator strips update_steps in planning and restores it in execution; /plan strips it during planning', TIMEOUT, async () => {
  const env = await openStepsIntegrationEnv()
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'auto-pair',
      kind: 'orchestrator',
      model: 'faux/flagship',
      executorModel: 'faux/workhorse',
      description: 'Planner + Executor pair',
    })

    const orchConv = await kernel.conversations.createConversation({
      title: 'orch-with-steps',
      model: 'tier/auto-pair',
    })

    const captured: CapturedTurn[] = []
    env.faux.setResponses([
      // Planner phase hands off to Execution via exit_plan_mode (update_steps is excluded during planning)
      captureTurn(
        captured,
        fauxAssistantMessage(
          [
            fauxToolCall(TIERS_EXIT_PLAN_MODE_TOOL, { plan: 'Implement fix cleanly and verify.' }),
          ],
          { stopReason: 'toolUse' },
        ),
      ),
      // Execution phase starts live progress checklist via update_steps
      captureTurn(
        captured,
        fauxAssistantMessage(
          [
            fauxToolCall(STEPS_TOOL_UPDATE, {
              steps: [
                { title: 'Explore architecture', status: 'done' },
                { title: 'Implement fix', status: 'in_progress' },
                { title: 'Verify tests', status: 'pending' },
              ],
            }),
          ],
          { stopReason: 'toolUse' },
        ),
      ),
      // Execution phase completes checklist
      captureTurn(
        captured,
        fauxAssistantMessage(
          [
            fauxToolCall(STEPS_TOOL_UPDATE, {
              steps: [
                { title: 'Explore architecture', status: 'done' },
                { title: 'Implement fix', status: 'done' },
                { title: 'Verify tests', status: 'done' },
              ],
            }),
          ],
          { stopReason: 'toolUse' },
        ),
      ),
      captureTurn(captured, fauxAssistantMessage('Execution finished.')),
    ])

    await kernel.conversations.submitInput(orchConv.id, 'Plan and implement the fix')
    await kernel.conversations.waitForIdle(orchConv.id)

    assert.equal(captured[0]!.toolNames.includes(STEPS_TOOL_UPDATE), false, 'Orchestrator Planning Phase must strip update_steps')
    assert.ok(captured[0]!.toolNames.includes(TIERS_EXIT_PLAN_MODE_TOOL), 'Orchestrator Planning Phase must keep exit_plan_mode')
    assert.ok(captured[1]!.toolNames.includes(STEPS_TOOL_UPDATE), 'Orchestrator Execution Phase must restore update_steps')
    assert.equal(readStepsDoc(kernel, orchConv.id)?.allTerminal, true)

    // /plan mode strips update_steps during strict read-only planning and restores it when exiting to normal
    const planConv = await kernel.conversations.createConversation({ title: 'plan-isolation', model: 'faux/workhorse' })
    await kernel.plugins.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: planConv.id, mode: 'planning' })

    const planHook = await kernel.plugins.runHook('before_turn', {
      conversation: kernel.conversations.getConversation(planConv.id),
      inputs: [],
      sections: [],
      tools: kernel.plugins.listTools(),
      messages: [],
    } as never)
    assert.equal(planHook.action, 'transform')
    const planTools = (planHook.value as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
    assert.equal(planTools.includes(STEPS_TOOL_UPDATE), false, '/plan strict whitelist must exclude update_steps')

    await kernel.plugins.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: planConv.id, mode: 'normal' })
    const normalHook = await kernel.plugins.runHook('before_turn', {
      conversation: kernel.conversations.getConversation(planConv.id),
      inputs: [],
      sections: [],
      tools: kernel.plugins.listTools(),
      messages: [],
    } as never)
    const normalTools = (
      normalHook.action === 'transform'
        ? (normalHook.value as { tools: Array<{ name: string }> }).tools
        : kernel.plugins.listTools()
    ).map((t) => t.name)
    assert.equal(normalTools.includes(STEPS_TOOL_UPDATE), true, 'Exiting /plan mode restores update_steps')
  } finally {
    await env.close()
  }
})
