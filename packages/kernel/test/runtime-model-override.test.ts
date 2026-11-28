/**
 * Integration tests for symmetric transient runtime model overrides (`setConversationRuntimeModel`)
 * and native one-turn `submitInput` (`POST /api/conversations/:id/input` & `core:conversations.send`)
 * overrides across real `KernelRuntime`, SQLite, `pi-durable`, `HookBridge`, and `faux` providers.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it, type TestContext } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationSummary, ModelTiersCapability } from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import { handleApi } from '../src/http/routes.js'
import { KernelRuntime } from '../src/runtime/index.js'
import { getSdkConversation } from '../src/runtime/sdk-ids.js'
import { cleanupDir, makeTempDir, waitFor } from './helpers.js'

let savedModel: string | undefined
before(() => {
  savedModel = process.env['HELMX_MODEL']
  delete process.env['HELMX_MODEL']
})
after(() => {
  if (savedModel === undefined) delete process.env['HELMX_MODEL']
  else process.env['HELMX_MODEL'] = savedModel
})

function buildFauxCatalog() {
  const core = createFauxCore({
    provider: 'faux',
    models: [
      { id: 'base', name: 'Base Model' },
      { id: 'alt', name: 'Alt Model' },
      { id: 'disabled-one', name: 'Disabled Model' },
    ],
  })
  const fullMap = {
    off: null,
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
  }
  const enriched = core.models.map((m) => ({
    ...m,
    reasoning: true,
    thinkingLevelMap: m.id === 'base' ? { ...fullMap, xhigh: null, max: null } : fullMap,
  }))
  const provider = createProvider({
    id: core.provider,
    auth: { apiKey: { name: 'Faux', resolve: async () => ({ auth: {} }) } },
    models: enriched,
    api: {
      stream: core.stream as never,
      streamSimple: core.streamSimple as never,
      fetchDeferred: core.fetchDeferred as never,
      cancelDeferred: core.cancelDeferred as never,
    },
  })
  const models = createModels()
  models.setProvider(provider)
  return { models, core, provider }
}

async function apiCall(
  kernel: KernelRuntime,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; code?: string; body: any }> {
  try {
    const response = await handleApi(
      new Request(`http://hub${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      }),
      kernel as never,
    )
    const json = (await response.json().catch(() => undefined)) as any
    return { status: response.status, code: json?.error?.code, body: json }
  } catch (err) {
    if (err instanceof HelmxError) {
      return { status: err.status, code: err.code, body: { error: { code: err.code, message: err.message } } }
    }
    throw err
  }
}

async function sdkAgent(kernel: KernelRuntime, id: number) {
  const harness = (kernel as unknown as { harness: Parameters<typeof getSdkConversation>[0] }).harness
  const conv = await getSdkConversation(harness, id, BACKGROUND_CONTEXT)
  assert.ok(conv)
  return conv.agent(BACKGROUND_CONTEXT)
}

async function openFixture(t: TestContext, dir?: string) {
  const ownDir = dir === undefined
  const dataDir = dir ?? (await makeTempDir('helmx-runtime-override-'))
  const { models, core } = buildFauxCatalog()
  const kernel = await KernelRuntime.open({
    dataDir,
    cwd: dataDir,
    model: 'faux/base',
    models: models as never,
  })
  t.after(async () => {
    await kernel.close()
    if (ownDir) await cleanupDir(dataDir)
  }, { timeout: 60_000 })

  await kernel.models.setDefaultModel('faux/base', 'low')
  await kernel.models.setDisabledModels('faux', ['disabled-one'])
  await kernel.plugins.register({
    id: 'test:tiers',
    definePlugin(ctx) {
      ctx.provide<ModelTiersCapability>('helmx.model-tiers', {
        getTiers: () => ({
          deep: { model: 'faux/alt', thinkingLevel: 'max', description: 'Deep alt model' },
          disabled: { model: 'faux/disabled-one', thinkingLevel: 'high' },
        }),
      })
    },
  })

  return { kernel, core, dataDir }
}

describe('transient setConversationRuntimeModel & one-turn submitInput overrides', { timeout: 60_000 }, () => {
  it('setConversationRuntimeModel switches concrete & tier targets symmetrically without mutating overrides or stateChangeSeq', { timeout: 60_000 }, async (t) => {
    const { kernel } = await openFixture(t)
    const conv = await kernel.conversations.createConversation({
      title: 'runtime-switch',
      model: 'faux/base',
    })
    await kernel.conversations.updateConversation(conv.id, { thinkingLevel: 'low' })
    const baseline = kernel.conversations.getConversation(conv.id) as ConversationSummary & {
      thinkingLevelOverride?: string
    }
    assert.equal(baseline.model, 'faux/base')
    assert.equal(baseline.modelOverride, 'faux/base')
    assert.equal(baseline.thinkingLevel, 'low')
    assert.equal(baseline.thinkingLevelOverride, 'low')
    assert.equal(baseline.runtimeModelOverride, undefined)
    const seqBefore = baseline.stateChangeSeq

    // 1. Switch to tier/<id> (applies tier's preset thinkingLevel, preserves overrides & stateChangeSeq)
    const switchedTier = await kernel.conversations.setConversationRuntimeModel(conv.id, {
      model: 'tier/deep',
    }) as ConversationSummary & { thinkingLevelOverride?: string }
    assert.equal(switchedTier.model, 'faux/alt')
    assert.equal(switchedTier.thinkingLevel, 'max')
    assert.equal(switchedTier.modelOverride, 'faux/base')
    assert.equal(switchedTier.thinkingLevelOverride, 'low')
    assert.equal(switchedTier.runtimeModelOverride, true)
    assert.equal(switchedTier.stateChangeSeq, seqBefore)
    const agentAfterTier = await sdkAgent(kernel, conv.id)
    assert.equal(`${agentAfterTier.model?.provider}/${agentAfterTier.model?.modelId}`, 'faux/alt')
    assert.equal(agentAfterTier.thinkingLevel, 'max')

    // 2. Switch concrete target with explicit thinkingLevel
    const switchedConcrete = await kernel.conversations.setConversationRuntimeModel(conv.id, {
      model: 'faux/alt',
      thinkingLevel: 'medium',
    })
    assert.equal(switchedConcrete.model, 'faux/alt')
    assert.equal(switchedConcrete.thinkingLevel, 'medium')
    assert.equal(switchedConcrete.runtimeModelOverride, true)
    assert.equal(switchedConcrete.stateChangeSeq, seqBefore)

    // 3. Rejects unknown / disabled targets honestly without mutating active state
    await assert.rejects(
      () => kernel.conversations.setConversationRuntimeModel(conv.id, { model: 'tier/missing' }),
      (err: unknown) => err instanceof HelmxError && err.code === 'model_tier_not_found' && err.status === 404,
    )
    await assert.rejects(
      () => kernel.conversations.setConversationRuntimeModel(conv.id, { model: 'faux/missing' }),
      (err: unknown) => err instanceof HelmxError && err.code === 'model_not_found' && err.status === 404,
    )
    await assert.rejects(
      () => kernel.conversations.setConversationRuntimeModel(conv.id, { model: 'tier/disabled' }),
      (err: unknown) => err instanceof HelmxError && err.code === 'model_disabled' && err.status === 409,
    )

    // 4. Null restores baseline cleanly without bumping stateChangeSeq
    const restored = await kernel.conversations.setConversationRuntimeModel(conv.id, null) as ConversationSummary & {
      thinkingLevelOverride?: string
    }
    assert.equal(restored.model, 'faux/base')
    assert.equal(restored.thinkingLevel, 'low')
    assert.equal(restored.modelOverride, 'faux/base')
    assert.equal(restored.thinkingLevelOverride, 'low')
    assert.equal(restored.runtimeModelOverride, undefined)
    assert.equal(restored.stateChangeSeq, seqBefore)
    const agentRestored = await sdkAgent(kernel, conv.id)
    assert.equal(`${agentRestored.model?.provider}/${agentRestored.model?.modelId}`, 'faux/base')
    assert.equal(agentRestored.thinkingLevel, 'low')

    // 5. updateConversation & resetConversation clear active runtimeModelOverride and restore baseline SDK state
    await kernel.conversations.setConversationRuntimeModel(conv.id, { model: 'faux/alt', thinkingLevel: 'high' })
    assert.equal(kernel.conversations.getConversation(conv.id).runtimeModelOverride, true)
    const patched = await kernel.conversations.updateConversation(conv.id, { thinkingLevel: 'medium' })
    assert.equal(patched.runtimeModelOverride, undefined)
    assert.equal(patched.model, 'faux/base')
    assert.equal(patched.thinkingLevel, 'medium')

    await kernel.conversations.setConversationRuntimeModel(conv.id, { model: 'faux/alt', thinkingLevel: 'max' })
    assert.equal(kernel.conversations.getConversation(conv.id).runtimeModelOverride, true)
    const afterReset = await kernel.conversations.resetConversation(conv.id)
    assert.equal(afterReset.runtimeModelOverride, undefined)
    assert.equal(afterReset.model, 'faux/base')
    assert.equal(afterReset.thinkingLevel, 'medium')
    const agentAfterReset = await sdkAgent(kernel, conv.id)
    assert.equal(`${agentAfterReset.model?.provider}/${agentAfterReset.model?.modelId}`, 'faux/base')
    assert.equal(agentAfterReset.thinkingLevel, 'medium')
  })

  it('POST /api/conversations/:id/input one-turn tier override survives tool rounds and resets before queued followUp turn starts', { timeout: 60_000 }, async (t) => {
    const { kernel, core } = await openFixture(t)
    const conv = await kernel.conversations.createConversation({ title: 'one-turn-tool-round' })
    const seqBefore = kernel.conversations.getConversation(conv.id).stateChangeSeq

    const observedTurns: Array<{ model: string; thinking: string; runtimeOverride?: boolean }> = []
    await kernel.plugins.register({
      id: 'test:observer',
      definePlugin(ctx) {
        ctx.hook.onBeforeTurn((payload) => {
          observedTurns.push({
            model: payload.conversation.model,
            thinking: payload.conversation.thinkingLevel,
            runtimeOverride: payload.conversation.runtimeModelOverride,
          })
          return { action: 'continue' }
        })
      },
    })

    // Turn 1 uses tool call + final answer (two requests inside one run), then Turn 2 (queued followUp) answers on baseline
    let toolStartedResolve!: () => void
    const toolStarted = new Promise<void>((resolve) => {
      toolStartedResolve = resolve
    })
    let releaseToolResolve!: () => void
    const releaseTool = new Promise<void>((resolve) => {
      releaseToolResolve = resolve
    })
    await kernel.plugins.register({
      id: 'test:slow-tool',
      definePlugin(ctx) {
        ctx.tool({
          name: 'slow_probe',
          description: 'Waits for test gate',
          inputSchema: { type: 'object', additionalProperties: false },
          async execute() {
            toolStartedResolve()
            await releaseTool
            return { content: [{ type: 'text', text: 'probe-ok' }] }
          },
        })
      },
    })

    core.setResponses([
      fauxAssistantMessage([fauxToolCall('slow_probe', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('turn-1-answer'),
      fauxAssistantMessage('turn-2-baseline-answer'),
    ])

    const httpRes = await apiCall(kernel, 'POST', `/api/conversations/${conv.id}/input`, {
      text: 'run with deep tier once',
      model: 'tier/deep',
    })
    assert.equal(httpRes.status, 202)
    await toolStarted

    // During Turn 1 tool execution, transient runtimeModelOverride stays true on faux/alt
    const midRun = kernel.conversations.getConversation(conv.id)
    assert.equal(midRun.model, 'faux/alt')
    assert.equal(midRun.thinkingLevel, 'max')
    assert.equal(midRun.runtimeModelOverride, true)

    // Queue followUp without model/thinking while Turn 1 is still active
    await kernel.conversations.submitInput(conv.id, 'follow up on baseline', { whenBusy: 'followUp' })
    releaseToolResolve()

    await kernel.conversations.waitForIdle(conv.id)
    await waitFor(
      () =>
        kernel.conversations.getConversation(conv.id).status === 'done' &&
        kernel.conversations.getConversation(conv.id).runtimeModelOverride === undefined,
    )

    // Both tool-round requests inside Turn 1 ran on faux/alt + max; queued Turn 2 ran on baseline faux/base + low!
    assert.equal(observedTurns.length, 3)
    assert.deepEqual(observedTurns[0], { model: 'faux/alt', thinking: 'max', runtimeOverride: true })
    assert.deepEqual(observedTurns[1], { model: 'faux/alt', thinking: 'max', runtimeOverride: true })
    assert.deepEqual(observedTurns[2], { model: 'faux/base', thinking: 'low', runtimeOverride: undefined })

    const finalSummary = kernel.conversations.getConversation(conv.id)
    assert.equal(finalSummary.model, 'faux/base')
    assert.equal(finalSummary.thinkingLevel, 'low')
    assert.equal(finalSummary.runtimeModelOverride, undefined)
    assert.equal(finalSummary.modelOverride, undefined)
    // Persisted overrides stayed untouched; only run settlement/summary updates changed seq
    assert.ok(finalSummary.stateChangeSeq >= seqBefore)
    const agent = await sdkAgent(kernel, conv.id)
    assert.equal(`${agent.model?.provider}/${agent.model?.modelId}`, 'faux/base')
    assert.equal(agent.thinkingLevel, 'low')
  })

  it('supports thinkingLevel-only one-turn override, pre-hook busy/validation guards, hook block safety, rollback, and abort/failure reset', { timeout: 60_000 }, async (t) => {
    const { kernel, core } = await openFixture(t)
    const conv = await kernel.conversations.createConversation({ title: 'one-turn-guards' })

    let inputHookCount = 0
    let blockNextInput = false
    const observedThinking: string[] = []
    await kernel.plugins.register({
      id: 'test:guard-hooks',
      definePlugin(ctx) {
        ctx.hook.onInput(() => {
          inputHookCount += 1
          if (blockNextInput) {
            return { action: 'block', reason: 'blocked by policy' }
          }
          return { action: 'continue' }
        })
        ctx.hook.onBeforeTurn((payload) => {
          observedThinking.push(`${payload.conversation.model}@${payload.conversation.thinkingLevel}`)
          return { action: 'continue' }
        })
      },
    })

    // 1. Pre-hook validation rejects disabled model BEFORE running input hooks
    await assert.rejects(
      () => kernel.conversations.submitInput(conv.id, 'bad model', { model: 'faux/disabled-one' }),
      (err: unknown) => err instanceof HelmxError && err.code === 'model_disabled' && err.status === 409,
    )
    assert.equal(inputHookCount, 0)
    assert.equal(kernel.conversations.getConversation(conv.id).runtimeModelOverride, undefined)

    // 2. input hook block leaves zero dirty runtimeModelOverride
    blockNextInput = true
    await assert.rejects(
      () => kernel.conversations.submitInput(conv.id, 'blocked', { model: 'faux/alt', thinkingLevel: 'high' }),
      (err: unknown) => err instanceof HelmxError && err.code === 'input_blocked',
    )
    blockNextInput = false
    assert.equal(inputHookCount, 1)
    assert.equal(kernel.conversations.getConversation(conv.id).runtimeModelOverride, undefined)
    assert.equal(kernel.conversations.getConversation(conv.id).model, 'faux/base')

    // 3. thinkingLevel-only override applies on top of baseline model and resets on run end
    core.setResponses([fauxAssistantMessage('thoughtful reply')])
    await kernel.conversations.submitInput(conv.id, 'think high once', { thinkingLevel: 'high' })
    await kernel.conversations.waitForIdle(conv.id)
    assert.deepEqual(observedThinking, ['faux/base@high'])
    assert.equal(kernel.conversations.getConversation(conv.id).model, 'faux/base')
    assert.equal(kernel.conversations.getConversation(conv.id).thinkingLevel, 'low')
    assert.equal(kernel.conversations.getConversation(conv.id).runtimeModelOverride, undefined)

    // 4. Busy guard rejects 409 conversation_busy BEFORE running input hooks when working or ask pending
    const pendingAskPromise = kernel.asks.createAsk({
      id: 'ask-busy-1',
      conversationId: conv.id,
      ownerPluginId: 'test:guard-hooks',
      title: 'Need confirmation',
      fields: [{ name: 'ok', label: 'OK', type: 'confirm' }],
      expectedStateSeq: kernel.conversations.getConversation(conv.id).stateChangeSeq,
    })
    await waitFor(() => kernel.conversations.getConversation(conv.id).status === 'blocked')
    const hooksBeforeAskBusy = inputHookCount
    await assert.rejects(
      () => kernel.conversations.submitInput(conv.id, 'while ask pending', { model: 'faux/alt' }),
      (err: unknown) => err instanceof HelmxError && err.code === 'conversation_busy' && err.status === 409,
    )
    assert.equal(inputHookCount, hooksBeforeAskBusy)
    await kernel.asks.cancelAsk('ask-busy-1', 'cancelled')
    await pendingAskPromise

    // 4b. Core action `core:conversations.send` forwards one-turn model + thinkingLevel on helmx-owned conversation
    const helmxConv = await kernel.conversations.createConversation({ title: 'action-send', ownedBy: 'helmx' })
    core.setResponses([fauxAssistantMessage('action-one-turn-ok')])
    const actionRes = await apiCall(kernel, 'POST', '/api/actions/core%3Aconversations/send', {
      input: {
        conversationId: helmxConv.id,
        text: 'via core action',
        model: 'tier/deep',
        thinkingLevel: 'high',
        wait: true,
      },
    })
    assert.equal(actionRes.status, 200)
    assert.equal(observedThinking.at(-1), 'faux/alt@high')
    await kernel.conversations.waitForIdle(helmxConv.id)
    assert.equal(kernel.conversations.getConversation(helmxConv.id).runtimeModelOverride, undefined)
    assert.equal(kernel.conversations.getConversation(helmxConv.id).model, 'faux/base')

    // 5. Failed turn (provider error) resets runtimeModelOverride cleanly back to baseline
    core.setResponses([fauxAssistantMessage('err', { errorMessage: 'upstream down', stopReason: 'error' })])
    await kernel.conversations.submitInput(conv.id, 'failing one-turn', { model: 'faux/alt', thinkingLevel: 'max' })
    await kernel.conversations.waitForIdle(conv.id).catch(() => {})
    await waitFor(
      () =>
        kernel.conversations.getConversation(conv.id).status === 'error' &&
        kernel.conversations.getConversation(conv.id).runtimeModelOverride === undefined,
    )
    assert.equal(kernel.conversations.getConversation(conv.id).model, 'faux/base')
    assert.equal(kernel.conversations.getConversation(conv.id).thinkingLevel, 'low')

    // 6. Mid-turn abort resets runtimeModelOverride cleanly back to baseline
    let slowToolEntered!: () => void
    const slowToolEnteredPromise = new Promise<void>((r) => {
      slowToolEntered = r
    })
    await kernel.plugins.register({
      id: 'test:abort-tool',
      definePlugin(ctx) {
        ctx.tool({
          name: 'hang_until_abort',
          description: 'Waits for abort signal',
          inputSchema: { type: 'object', additionalProperties: false },
          async execute(_args, toolCtx) {
            slowToolEntered()
            await new Promise<void>((resolve) => {
              toolCtx.signal?.addEventListener('abort', () => resolve(), { once: true })
            })
            return { content: [{ type: 'text', text: 'aborted' }] }
          },
        })
      },
    })
    core.setResponses([fauxAssistantMessage([fauxToolCall('hang_until_abort', {})], { stopReason: 'toolUse' })])
    await kernel.conversations.submitInput(conv.id, 'abortable turn', { model: 'faux/alt', thinkingLevel: 'high' })
    await slowToolEnteredPromise
    assert.equal(kernel.conversations.getConversation(conv.id).runtimeModelOverride, true)

    // Working busy guard rejects 409 conversation_busy BEFORE running input hooks
    const hooksBeforeWorkingBusy = inputHookCount
    await assert.rejects(
      () => kernel.conversations.submitInput(conv.id, 'while working', { model: 'faux/alt' }),
      (err: unknown) => err instanceof HelmxError && err.code === 'conversation_busy' && err.status === 409,
    )
    assert.equal(inputHookCount, hooksBeforeWorkingBusy)

    await kernel.conversations.abortConversation(conv.id)
    await kernel.conversations.waitForIdle(conv.id).catch(() => {})
    assert.equal(kernel.conversations.getConversation(conv.id).runtimeModelOverride, undefined)
    assert.equal(kernel.conversations.getConversation(conv.id).model, 'faux/base')
    assert.equal(kernel.conversations.getConversation(conv.id).thinkingLevel, 'low')
    const agent = await sdkAgent(kernel, conv.id)
    assert.equal(`${agent.model?.provider}/${agent.model?.modelId}`, 'faux/base')
    assert.equal(agent.thinkingLevel, 'low')

    // 7. Dispatch error (invalid replaceFromEntryId) rolls back cleanly
    await assert.rejects(
      () =>
        kernel.conversations.submitInput(conv.id, 'bad rewind', {
          model: 'faux/alt',
          replaceFromEntryId: 999999,
        }),
      (err: unknown) => err instanceof HelmxError,
    )
    assert.equal(kernel.conversations.getConversation(conv.id).runtimeModelOverride, undefined)
    assert.equal(kernel.conversations.getConversation(conv.id).model, 'faux/base')
  })

  it('cold restart re-aligns idle conversations whose transient SDK runtime override was not persisted', { timeout: 60_000 }, async (t) => {
    const dir = await makeTempDir('helmx-runtime-restart-')
    t.after(async () => {
      await cleanupDir(dir)
    }, { timeout: 60_000 })
    const first = buildFauxCatalog()
    const kernel1 = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/base',
      models: first.models as never,
    })
    await kernel1.models.setDefaultModel('faux/base', 'low')
    const conv = await kernel1.conversations.createConversation({ title: 'restart-align' })
    // Apply sticky transient runtime override (no resetOnRunEnd) then restart Hub
    const switched = await kernel1.conversations.setConversationRuntimeModel(conv.id, {
      model: 'faux/alt',
      thinkingLevel: 'max',
    })
    assert.equal(switched.runtimeModelOverride, true)
    assert.equal(switched.model, 'faux/alt')
    await kernel1.close()

    const second = buildFauxCatalog()
    const kernel2 = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/base',
      models: second.models as never,
    })
    t.after(async () => {
      await kernel2.close()
    }, { timeout: 60_000 })

    const recovered = kernel2.conversations.getConversation(conv.id)
    assert.equal(recovered.runtimeModelOverride, undefined)
    assert.equal(recovered.model, 'faux/base')
    assert.equal(recovered.thinkingLevel, 'low')
    const agent = await sdkAgent(kernel2, conv.id)
    assert.equal(`${agent.model?.provider}/${agent.model?.modelId}`, 'faux/base')
    assert.equal(agent.thinkingLevel, 'low')
  })
})

describe('symbolic effectiveModelRef, preserveRef tiers & ModelTierSpec metadata', { timeout: 60_000 }, () => {
  it('sanitizes and forwards displayGroup/displayLabel/displayDetail/preserveRef/singleTurnEligible into /api/models', { timeout: 60_000 }, async (t) => {
    const dir = await makeTempDir('helmx-tier-meta-')
    const { models } = buildFauxCatalog()
    const kernel = await KernelRuntime.open({ dataDir: dir, cwd: dir, model: 'faux/base', models: models as never })
    t.after(async () => {
      await kernel.close()
      await cleanupDir(dir)
    }, { timeout: 60_000 })

    await kernel.plugins.register({
      id: 'test:rich-tiers',
      definePlugin(ctx) {
        ctx.provide<ModelTiersCapability>('helmx.model-tiers', {
          getTiers: () => ({
            duo: {
              model: 'faux/base',
              thinkingLevel: 'medium',
              description: 'Plan then verify',
              displayGroup: '  duo  ',
              displayLabel: '  Faux Duo  ',
              displayDetail: '  base -> alt  ',
              preserveRef: true,
              singleTurnEligible: false,
            },
            oversized: {
              model: 'faux/alt',
              displayGroup: 'g'.repeat(33),
              displayLabel: 'l'.repeat(81),
              displayDetail: 'd'.repeat(121),
              preserveRef: false,
              singleTurnEligible: true,
            },
          }),
        })
      },
    })

    const res = await apiCall(kernel, 'GET', '/api/models')
    assert.equal(res.status, 200)
    const tiers = res.body.modelTiers as Array<Record<string, unknown>>
    const duo = tiers.find((entry) => entry.id === 'duo')
    assert.deepEqual(duo, {
      id: 'duo',
      model: 'faux/base',
      thinkingLevel: 'medium',
      description: 'Plan then verify',
      displayGroup: 'duo',
      displayLabel: 'Faux Duo',
      displayDetail: 'base -> alt',
      preserveRef: true,
      singleTurnEligible: false,
      available: true,
      thinkingLevels: ['minimal', 'low', 'medium', 'high'],
    })
    const oversized = tiers.find((entry) => entry.id === 'oversized')
    assert.deepEqual(oversized, {
      id: 'oversized',
      model: 'faux/alt',
      available: true,
      thinkingLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    })
  })

  it('preserves symbolic ref for top-level human conversations while freezing children, helmx-owned, forks & propagating Profile effectiveModelRef', { timeout: 60_000 }, async (t) => {
    const dir = await makeTempDir('helmx-preserve-ref-')
    const { models, core } = buildFauxCatalog()
    const kernel = await KernelRuntime.open({ dataDir: dir, cwd: dir, model: 'faux/base', models: models as never })
    t.after(async () => {
      await kernel.close()
      await cleanupDir(dir)
    }, { timeout: 60_000 })

    let duoThinking = 'medium'
    await kernel.plugins.register({
      id: 'test:duo-tier',
      definePlugin(ctx) {
        ctx.provide<ModelTiersCapability>('helmx.model-tiers', {
          getTiers: () => ({
            duo: {
              model: 'faux/base',
              thinkingLevel: duoThinking,
              displayGroup: 'duo',
              displayLabel: 'Faux Duo',
              preserveRef: true,
              singleTurnEligible: false,
            },
            plain: {
              model: 'faux/alt',
              thinkingLevel: 'high',
            },
          }),
        })
      },
    })

    // 1. Top-level human create keeps symbolic ref without freezing thinkingLevelOverride
    const humanTop = await kernel.conversations.createConversation({
      title: 'human-duo',
      model: 'tier/duo',
    }) as ConversationSummary & { thinkingLevelOverride?: string }
    assert.equal(humanTop.model, 'faux/base')
    assert.equal(humanTop.modelOverride, 'tier/duo')
    assert.equal(humanTop.effectiveModelRef, 'tier/duo')
    assert.equal(humanTop.thinkingLevel, 'medium')
    assert.equal(humanTop.thinkingLevelOverride, undefined)

    // Tier thinking update remains live for preserveRef top-level human conversation
    duoThinking = 'high'
    await kernel.conversations.alignAllConversations()
    assert.equal(kernel.conversations.getConversation(humanTop.id).thinkingLevel, 'high')

    // Non-preserve tier still freezes to concrete canonicalRef
    const nonPreserve = await kernel.conversations.createConversation({
      title: 'human-plain',
      model: 'tier/plain',
    }) as ConversationSummary & { thinkingLevelOverride?: string }
    assert.equal(nonPreserve.model, 'faux/alt')
    assert.equal(nonPreserve.modelOverride, 'faux/alt')
    assert.equal(nonPreserve.effectiveModelRef, undefined)
    assert.equal(nonPreserve.thinkingLevelOverride, 'high')

    // 2. Switching between concrete 'faux/base' (thinking=low) and 'tier/duo' (target 'faux/base', thinking=high)
    const patchedToConcrete = await kernel.conversations.updateConversation(humanTop.id, {
      model: 'faux/base',
      thinkingLevel: 'low',
    }) as ConversationSummary & { thinkingLevelOverride?: string }
    assert.equal(patchedToConcrete.model, 'faux/base')
    assert.equal(patchedToConcrete.modelOverride, 'faux/base')
    assert.equal(patchedToConcrete.effectiveModelRef, undefined)
    assert.equal(patchedToConcrete.thinkingLevel, 'low')
    assert.equal(patchedToConcrete.thinkingLevelOverride, 'low')

    const patchedBackToDuo = await kernel.conversations.updateConversation(humanTop.id, {
      model: 'tier/duo',
    }) as ConversationSummary & { thinkingLevelOverride?: string }
    assert.equal(patchedBackToDuo.model, 'faux/base')
    assert.equal(patchedBackToDuo.modelOverride, 'tier/duo')
    assert.equal(patchedBackToDuo.effectiveModelRef, 'tier/duo')
    assert.equal(patchedBackToDuo.thinkingLevel, 'high')
    assert.equal(patchedBackToDuo.thinkingLevelOverride, undefined)

    // 3. Child conversation, helmx-owned conversation, and fork ALL freeze symbolic 'tier/duo' -> concrete 'faux/base'
    const child = await kernel.conversations.createConversation({
      title: 'child',
      parentConversationId: humanTop.id,
      model: 'tier/duo',
    })
    assert.equal(child.modelOverride, 'faux/base')
    assert.equal(child.effectiveModelRef, undefined)

    const helmxTop = await kernel.conversations.createConversation({
      title: 'helmx-top',
      ownedBy: 'helmx',
      model: 'tier/duo',
    })
    assert.equal(helmxTop.modelOverride, 'faux/base')
    assert.equal(helmxTop.effectiveModelRef, undefined)

    core.setResponses([fauxAssistantMessage('seed reply')])
    await kernel.conversations.submitInput(humanTop.id, 'seed turn')
    await kernel.conversations.waitForIdle(humanTop.id)
    const forked = await kernel.conversations.forkConversation(humanTop.id)
    assert.equal(forked.model, 'faux/base')
    assert.equal(forked.modelOverride, 'faux/base')
    assert.equal(forked.effectiveModelRef, undefined)

    core.setResponses([fauxAssistantMessage('child reply')])
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: humanTop.id,
      prompt: 'subtask',
      fork: true,
    })
    const spawnedSummary = kernel.conversations
      .listConversations()
      .find((c) => c.parentConversationId === humanTop.id && c.ownedBy === 'helmx')
    assert.ok(spawnedSummary !== undefined, 'spawned forked child must exist')
    assert.equal(spawnedSummary.model, 'faux/base')
    assert.equal(spawnedSummary.modelOverride, 'faux/base')
    assert.equal(spawnedSummary.effectiveModelRef, undefined)

    // 4. Profile model switches between 'faux/base' and 'tier/duo' (same target) propagate effectiveModelRef & emit upsert
    await kernel.services.profiles.save({ id: 'duo-prof', name: 'Duo Profile', model: 'faux/base' })
    const inherited = await kernel.conversations.createConversation({ title: 'inherited', profileId: 'duo-prof' })
    assert.equal(inherited.effectiveModelRef, undefined)

    const upserts: ConversationSummary[] = []
    const unsub = kernel.events.subscribe((frame) => {
      if (frame.event.type === 'conversation.upsert' && 'conversation' in frame.event && frame.event.conversation.id === inherited.id) {
        upserts.push(frame.event.conversation)
      }
    })
    t.after(unsub, { timeout: 60_000 })

    await kernel.services.profiles.save({ id: 'duo-prof', name: 'Duo Profile', model: 'tier/duo' })
    await kernel.conversations.alignProfileConversations('duo-prof')
    const afterProfileTier = kernel.conversations.getConversation(inherited.id)
    assert.equal(afterProfileTier.modelOverride, undefined)
    assert.equal(afterProfileTier.model, 'faux/base')
    assert.equal(afterProfileTier.effectiveModelRef, 'tier/duo')
    assert.equal(upserts.at(-1)?.effectiveModelRef, 'tier/duo')

    await kernel.services.profiles.save({ id: 'duo-prof', name: 'Duo Profile', model: 'faux/base' })
    await kernel.conversations.alignProfileConversations('duo-prof')
    const afterProfileConcrete = kernel.conversations.getConversation(inherited.id)
    assert.equal(afterProfileConcrete.effectiveModelRef, undefined)
    assert.equal(upserts.at(-1)?.effectiveModelRef, undefined)
  })

  it('repopulates effectiveModelRef on cold restart without bumping stateChangeSeq when model matches SDK', { timeout: 60_000 }, async (t) => {
    const dir = await makeTempDir('helmx-effective-ref-boot-')
    t.after(async () => {
      await cleanupDir(dir)
    }, { timeout: 60_000 })

    const registerTiers = async (kernel: KernelRuntime) => {
      await kernel.plugins.register({
        id: 'test:boot-tiers',
        definePlugin(ctx) {
          ctx.provide<ModelTiersCapability>('helmx.model-tiers', {
            getTiers: () => ({
              duo: { model: 'faux/base', preserveRef: true },
            }),
          })
        },
      })
    }

    const first = buildFauxCatalog()
    const kernel1 = await KernelRuntime.open({ dataDir: dir, cwd: dir, model: 'faux/base', models: first.models as never })
    await registerTiers(kernel1)
    await kernel1.services.profiles.save({ id: 'boot-prof', name: 'Boot Profile', model: 'tier/duo' })
    const direct = await kernel1.conversations.createConversation({ title: 'direct-duo', model: 'tier/duo' })
    const fromProfile = await kernel1.conversations.createConversation({ title: 'profile-duo', profileId: 'boot-prof' })
    const directSeq = direct.stateChangeSeq
    const profileSeq = fromProfile.stateChangeSeq
    await kernel1.close()

    const second = buildFauxCatalog()
    const kernel2 = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/base',
      models: second.models as never,
      autoResume: false,
    })
    t.after(async () => {
      await kernel2.close()
    }, { timeout: 60_000 })
    await registerTiers(kernel2)
    await kernel2.start()

    const recoveredDirect = kernel2.conversations.getConversation(direct.id)
    const recoveredProfile = kernel2.conversations.getConversation(fromProfile.id)
    assert.equal(recoveredDirect.modelOverride, 'tier/duo')
    assert.equal(recoveredDirect.effectiveModelRef, 'tier/duo')
    assert.equal(recoveredDirect.stateChangeSeq, directSeq)
    assert.equal(recoveredProfile.effectiveModelRef, 'tier/duo')
    assert.equal(recoveredProfile.stateChangeSeq, profileSeq)
  })
})
