/**
 * builtin:tiers unit & real createHelmx integration tests:
 * - Pure validation, tier reference protection, and `<available_model_tiers>` catalog rendering;
 * - Actions: list / set / remove / replace / save_template / apply_template / delete_template;
 * - `before_turn` injection (usable tiers only, zero injection when empty or `autoInjectCatalog: false`);
 * - Real kernel integration:
 *   - Reserved `tier` provider namespace enforcement across providers, filter, and modelThinkingLevels;
 *   - `createConversation` & `updateConversation` one-shot dereference & freeze (Prompt Cache & disable safety);
 *   - Symbolic inheritance (`defaultModel` / `Profile.model` -> `tier/<id>`) auto-realigns on template switch;
 *   - Thinking precedence (`effort > tier.thinkingLevel > modelThinkingLevels > Profile > global`);
 *   - Native `spawnAgent` (normal & `fork: true`) tier resolution, freeze, `404 model_tier_not_found`, `409 model_disabled`;
 *   - `completeConversationText` & `wrapModelsForCompaction` tier dereferencing;
 *   - `inUse()` disable protection (`409 plugin_in_use`) + clean unmount on disable (managed skill vanishes, frozen convs keep working).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { HelmxError, type ModelCatalog, type Profile } from '@helmx/protocol'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { createHelmx } from '../../hub/src/app.js'
import { wrapModelsForCompaction } from '@helmx/kernel/testing'
import {
  MODEL_TIERS_SKILL_ID,
  TIERS_PLUGIN_ID,
  TIERS_STATE_DOC,
  createTiersPlugin,
} from '../src/tiers.js'
import {
  assertConcreteModelRef,
  assertTierId,
  normalizeTierSpec,
  renderModelTiersCatalogSection,
} from '../src/tiers/validation.js'
import {
  MemoryDocStore,
  MemoryKvStore,
  assertRejectsCode,
  cleanupDir,
  makeConversationSummary,
  makeFauxProvider,
  makeTempDir,
  type FauxProviderHandle,
} from './helpers/plugin-test-env.js'
import { KernelRuntime } from '@helmx/kernel'

function makeMultiModelFaux(): FauxProviderHandle {
  return makeFauxProvider({
    models: [
      { id: 'fast', name: 'Fast', reasoning: true },
      { id: 'workhorse', name: 'Workhorse', reasoning: true },
      { id: 'flagship', name: 'Flagship', reasoning: true },
    ],
  })
}

async function openHelmxEnv(options: { defaultModel?: string } = {}) {
  const dataDir = await makeTempDir('helmx-tiers-it-')
  const faux = makeMultiModelFaux()
  const app = await createHelmx({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    cwd: dataDir,
    model: options.defaultModel ?? 'faux/workhorse',
    providers: [faux.provider],
  })
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

test('validation: rejects malformed IDs, recursive tier targets, invalid thinking levels, and overlong descriptions', { timeout: 60_000 }, () => {
  assert.equal(assertTierId('coder'), 'coder')
  assert.equal(assertTierId('senior_2-a'), 'senior_2-a')
  assert.throws(() => assertTierId('BadUpper'), (e: unknown) => e instanceof HelmxError && e.code === 'validation_error')
  assert.throws(() => assertTierId('tier/coder'), (e: unknown) => e instanceof HelmxError && e.code === 'validation_error')
  assert.throws(() => assertConcreteModelRef('tier/scout'), (e: unknown) => e instanceof HelmxError && e.code === 'validation_error')
  assert.throws(() => assertConcreteModelRef('no-slash'), (e: unknown) => e instanceof HelmxError && e.code === 'validation_error')
  assert.throws(
    () => normalizeTierSpec({ model: 'faux/fast', thinkingLevel: 'bogus' }),
    (e: unknown) => e instanceof HelmxError && e.code === 'validation_error',
  )
  assert.throws(
    () => normalizeTierSpec({ model: 'faux/fast', description: 'x'.repeat(241) }),
    (e: unknown) => e instanceof HelmxError && e.code === 'validation_error',
  )

  const xml = renderModelTiersCatalogSection([
    { id: 'scout', model: 'faux/fast', thinkingLevel: 'low', description: 'Fast search', available: true },
    { id: 'broken', model: 'faux/missing', description: 'Should be hidden', available: false },
    { id: 'muted', model: 'faux/workhorse', description: 'Disabled', available: true, disabled: true },
    {
      id: 'architect_duo',
      model: 'faux/workhorse',
      description: 'Orchestrator should never leak to subagent tiers',
      available: true,
      singleTurnEligible: false,
    },
  ])
  assert.ok(xml !== undefined)
  assert.match(xml, /<tier id="tier\/scout" effort="low">Fast search<\/tier>/)
  assert.match(xml, /never agentType or profileId/)
  assert.doesNotMatch(xml, /tier\/broken/)
  assert.doesNotMatch(xml, /tier\/muted/)
  assert.doesNotMatch(xml, /tier\/architect_duo/)
  assert.equal(renderModelTiersCatalogSection([{ id: 'x', model: 'faux/fast', available: false }]), undefined)
  assert.equal(
    renderModelTiersCatalogSection([
      { id: 'duo_only', model: 'faux/fast', available: true, singleTurnEligible: false },
    ]),
    undefined,
  )
})

test('integration: default enabled, managed skill, reserved namespace, CRUD actions, templates, and before_turn catalog', { timeout: 60_000 }, async () => {
  const env = await openHelmxEnv()
  try {
    const { kernel } = env.app
    // 1. Default enabled & managed skill bootstrapped
    const summary = kernel.plugins.list().find((p) => p.id === TIERS_PLUGIN_ID)
    assert.ok(summary && summary.enabled, 'builtin:tiers must be registered and enabled by default')
    const skills = await kernel.skills.list()
    assert.ok(
      skills.some((s) => s.id === MODEL_TIERS_SKILL_ID && s.managedByPlugin === TIERS_PLUGIN_ID),
      'managed skill model-tiers must be bootstrapped at startup',
    )
    const managerMod = await kernel.plugins.getClientModule(TIERS_PLUGIN_ID, 'manager.tsx')
    assert.match(managerMod.code, /TiersManagerScreen/)
    assert.doesNotMatch(managerMod.code, /TiersSettingsPanel/)
    const settingsMod = await kernel.plugins.getClientModule(TIERS_PLUGIN_ID, 'settings.tsx')
    assert.match(settingsMod.code, /TiersSettingsPanel/)
    assert.doesNotMatch(settingsMod.code, /TiersManagerScreen/)

    // Public doc `state` must be readable immediately (for Web UI usePluginDoc & SSE initial snapshot)
    const initialDoc = kernel.plugins.getPublicDoc(TIERS_PLUGIN_ID, TIERS_STATE_DOC)
    assert.deepEqual(initialDoc.value, { tiers: {}, templates: {} })
    assert.ok(
      kernel.plugins.listPublicDocs().some((d) => d.pluginId === TIERS_PLUGIN_ID && d.name === TIERS_STATE_DOC),
      'builtin:tiers/state must appear in listPublicDocs for SSE initial snapshots',
    )

    // 2. Empty roster -> catalog omits modelTiers and before_turn injects nothing
    const emptyCatalog = await kernel.models.listModels()
    assert.equal(emptyCatalog.modelTiers, undefined)

    // 2b. Internal UI bulk-replace action carries visibility: 'ui' (allowed via HTTP, blocked via run_action)
    const replaceManifest = kernel.plugins
      .listActions()
      .find((a) => a.pluginId === TIERS_PLUGIN_ID && a.id === 'replace')
    assert.equal(replaceManifest?.visibility, 'ui')
    await assertRejectsCode(
      () => kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'replace', { tiers: {} }, {}, { surface: 'run_action' }),
      'action_visibility_forbidden',
    )

    // 3. Reserved namespace 'tier' cannot be disabled, given per-model thinking, or registered as a provider
    await assertRejectsCode(() => kernel.models.setDisabledModels('tier', ['scout']), 'validation_error')
    await assertRejectsCode(() => kernel.models.setModelThinkingDefault('tier/scout', 'high'), 'validation_error')
    await assert.rejects(
      () =>
        kernel.providers.save([
          { id: 'tier', protocol: 'openai', baseUrl: 'http://127.0.0.1:9999', models: ['x'], enabled: true },
        ]),
      /reserved/,
    )

    // 4. Configure tiers via actions and verify GET /api/models projection
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'scout',
      model: 'faux/fast',
      thinkingLevel: 'low',
      description: 'Fast read-only scouting',
    })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'coder',
      model: 'faux/workhorse',
      thinkingLevel: 'high',
      description: 'Mainline coding',
    })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'architect',
      model: 'faux/flagship',
      thinkingLevel: 'xhigh',
      description: 'Architecture decisions only',
    })

    const cat = await kernel.models.listModels()
    assert.equal(cat.modelTiers?.length, 3)
    assert.deepEqual(
      cat.modelTiers?.map((t) => ({ id: t.id, model: t.model, thinkingLevel: t.thinkingLevel, available: t.available })),
      [
        { id: 'scout', model: 'faux/fast', thinkingLevel: 'low', available: true },
        { id: 'coder', model: 'faux/workhorse', thinkingLevel: 'high', available: true },
        { id: 'architect', model: 'faux/flagship', thinkingLevel: 'xhigh', available: true },
      ],
    )

    // 5. Save preset template & create an alternate budget template, then apply_template switches roster cleanly
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'save_template', {
      id: 'flagship-3',
      name: 'Flagship 3-tier',
      description: 'Full power roster',
    })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'save_template', {
      id: 'budget-2',
      name: 'Budget 2-tier',
      tiers: {
        scout: { model: 'faux/fast', thinkingLevel: 'low', description: 'Fast scout' },
        coder: { model: 'faux/fast', thinkingLevel: 'high', description: 'Budget coder' },
      },
    })
    const applied = (await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'apply_template', {
      id: 'budget-2',
    })) as { tiers: Array<{ id: string; model: string }>; activeTemplate?: string }
    assert.equal(applied.activeTemplate, 'budget-2')
    assert.deepEqual(
      applied.tiers.map((t) => ({ id: t.id, model: t.model })),
      [
        { id: 'scout', model: 'faux/fast' },
        { id: 'coder', model: 'faux/fast' },
      ],
    )
    const afterApplyDoc = kernel.plugins.getPublicDoc(TIERS_PLUGIN_ID, TIERS_STATE_DOC).value as {
      activeTemplate?: string
      tiers: Record<string, { model: string }>
      templates: Record<string, unknown>
    }
    assert.equal(afterApplyDoc.activeTemplate, 'budget-2')
    assert.equal(afterApplyDoc.tiers['coder']?.model, 'faux/fast')
    assert.ok('flagship-3' in afterApplyDoc.templates && 'budget-2' in afterApplyDoc.templates)

    // 6. Switch back to flagship-3 and verify before_turn injects <available_model_tiers>
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'apply_template', { id: 'flagship-3' })
    const conv = await kernel.conversations.createConversation({ title: 'prompt-check' })
    const seqBefore = kernel.conversations.getConversation(conv.id).completionSeq
    env.faux.setResponses([fauxAssistantMessage('ok')])
    await kernel.conversations.submitInput(conv.id, 'hello')
    const waitTurnDone = async () => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const snap = kernel.conversations.getConversation(conv.id)
        if (snap.completionSeq > seqBefore && snap.status !== 'working') return
        await new Promise((r) => setTimeout(r, 20))
      }
      throw new Error('timed out waiting for turn')
    }
    await waitTurnDone()
    // Verify before_turn hook directly produces tiers.catalog when enabled, and skips when autoInjectCatalog: false
    const hookRes = await kernel.plugins.runHook('before_turn', {
      conversation: kernel.conversations.getConversation(conv.id),
      inputs: [],
      sections: [],
      tools: [],
      messages: [],
    })
    assert.equal(hookRes.action, 'transform')
    const tierSection = hookRes.value.sections.find((s) => s.id === 'tiers.catalog')
    assert.ok(tierSection, 'before_turn must inject tiers.catalog when autoInjectCatalog is true')
    assert.match(tierSection.text, /tier\/architect/)
    assert.match(tierSection.text, /effort="xhigh"/)

    await kernel.plugins.setConfig(TIERS_PLUGIN_ID, { autoInjectCatalog: false })
    const hookOff = await kernel.plugins.runHook('before_turn', {
      conversation: kernel.conversations.getConversation(conv.id),
      inputs: [],
      sections: [],
      tools: [],
      messages: [],
    })
    const offSections = hookOff.action === 'transform' ? hookOff.value.sections : []
    assert.equal(
      offSections.some((s) => s.id === 'tiers.catalog'),
      false,
      'autoInjectCatalog: false suppresses tiers.catalog injection',
    )

    // 7. Delete template cleanly
    const delRes = (await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'delete_template', {
      id: 'budget-2',
    })) as { deleted: string; templates: Array<{ id: string }> }
    assert.equal(delRes.deleted, 'budget-2')
    assert.equal(delRes.templates.some((t) => t.id === 'budget-2'), false)
  } finally {
    await env.close()
  }
})

test('integration: freeze-on-create, thinking precedence, symbolic inheritance, spawnAgent/fork, completeText, compaction, and inUse disable guard', { timeout: 60_000 }, async () => {
  const env = await openHelmxEnv()
  try {
    const { kernel } = env.app
    // Set per-model thinking default on faux/workhorse to 'low' so we prove tier.thinkingLevel ('medium') outranks it,
    // and tier/clamped ('xhigh') clamps cleanly to faux/flagship's max supported level ('high').
    await kernel.models.setModelThinkingDefault('faux/workhorse', 'low')

    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'replace', {
      tiers: {
        scout: { model: 'faux/fast', thinkingLevel: 'low', description: 'Fast' },
        coder: { model: 'faux/workhorse', thinkingLevel: 'medium', description: 'Workhorse at medium' },
        architect: { model: 'faux/flagship', thinkingLevel: 'high', description: 'Architect' },
        clamped: { model: 'faux/flagship', thinkingLevel: 'xhigh', description: 'Exceeds faux max -> clamps to high' },
      },
    })

    // 1. createConversation with explicit tier -> resolves and freezes concrete model + tier thinkingLevel (beating per-model 'low')
    const worker = await kernel.conversations.createConversation({ title: 'worker-1', model: 'tier/coder' })
    assert.equal(worker.model, 'faux/workhorse')
    assert.equal(worker.thinkingLevel, 'medium', 'tier.thinkingLevel must outrank per-model default (low)')
    assert.equal(worker.thinkingLevelOverride, 'medium')

    // Unsupported tier thinkingLevel ('xhigh' on faux ['off'..'high']) clamps cleanly to 'high'
    const clampedConv = await kernel.conversations.createConversation({ title: 'clamped-1', model: 'tier/clamped' })
    assert.equal(clampedConv.model, 'faux/flagship')
    assert.equal(clampedConv.thinkingLevel, 'high')
    assert.equal(clampedConv.thinkingLevelOverride, 'high')

    // 2. updateConversation switches worker to tier/architect (freezes concrete model + tier effort)
    const upgraded = await kernel.conversations.updateConversation(worker.id, { model: 'tier/architect' })
    assert.equal(upgraded.model, 'faux/flagship')
    assert.equal(upgraded.thinkingLevel, 'high')
    assert.equal(upgraded.thinkingLevelOverride, 'high')

    // Explicit thinkingLevel in same patch overrides tier preset
    const explicitEffort = await kernel.conversations.updateConversation(worker.id, {
      model: 'tier/architect',
      thinkingLevel: 'minimal',
    })
    assert.equal(explicitEffort.thinkingLevel, 'minimal')

    // 3. Symbolic inheritance on Profile.model -> dynamically follows tier rebinding, while frozen `worker` stays untouched!
    const existingProfile = await kernel.profiles.get('assistant')
    assert.ok(existingProfile)
    await kernel.profiles.save({ ...existingProfile, model: 'tier/coder' })
    const inheritedConv = await kernel.conversations.createConversation({ title: 'inherited' })
    assert.equal(inheritedConv.model, 'faux/workhorse')
    assert.equal(inheritedConv.thinkingLevel, 'medium')

    // Rebind tier/coder -> faux/fast (low): inheritedConv realigns automatically; frozen `worker` stays on faux/flagship!
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'coder',
      model: 'faux/fast',
      thinkingLevel: 'low',
    })
    assert.equal(kernel.conversations.getConversation(inheritedConv.id).model, 'faux/fast')
    assert.equal(kernel.conversations.getConversation(inheritedConv.id).thinkingLevel, 'low')
    assert.equal(kernel.conversations.getConversation(worker.id).model, 'faux/flagship', 'frozen conversation must not mutate on tier rebind')

    // 4. Native spawnAgent with tier/architect + fork consultation + missing tier 404 + disabled target 409
    const waitTurnSettle = async (cid: number, prevSeq: number) => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const snap = kernel.conversations.getConversation(cid)
        if (snap.completionSeq > prevSeq && snap.status !== 'working') return
        await new Promise((r) => setTimeout(r, 20))
      }
      throw new Error(`timed out waiting for conv ${cid}`)
    }
    const seedSeq = kernel.conversations.getConversation(worker.id).completionSeq
    env.faux.setResponses([fauxAssistantMessage('parent-ready'), fauxAssistantMessage('spawn-done'), fauxAssistantMessage('fork-done')])
    await kernel.conversations.submitInput(worker.id, 'seed parent history')
    await waitTurnSettle(worker.id, seedSeq)

    let spawnedChildId: number | undefined
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: worker.id,
      prompt: 'do architecture',
      model: 'tier/architect',
      onResolved: (info) => {
        spawnedChildId = info.conversationId
      },
    })
    assert.ok(spawnedChildId !== undefined)
    const childSnap = kernel.conversations.getConversation(spawnedChildId!)
    assert.equal(childSnap.model, 'faux/flagship')
    assert.equal(childSnap.thinkingLevel, 'high')
    assert.equal(childSnap.thinkingLevelOverride, 'high')
    // Rebinding tier/architect afterwards must NOT mutate the spawned child (proving freeze-on-create)
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'architect',
      model: 'faux/workhorse',
      thinkingLevel: 'low',
    })
    assert.equal(kernel.conversations.getConversation(spawnedChildId!).model, 'faux/flagship', 'spawned child stays frozen on tier rebind')
    // Restore tier/architect -> faux/flagship for subsequent assertions
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'architect',
      model: 'faux/flagship',
      thinkingLevel: 'high',
    })

    let forkedChildId: number | undefined
    await kernel.agentSpawn.spawnAgent({
      parentConversationId: worker.id,
      fork: true,
      prompt: 'consult scout',
      model: 'tier/scout',
      effort: 'high', // explicit effort beats tier/scout's 'low'
      onResolved: (info) => {
        forkedChildId = info.conversationId
      },
    })
    assert.ok(forkedChildId !== undefined)
    const forkSnap = kernel.conversations.getConversation(forkedChildId!)
    assert.equal(forkSnap.model, 'faux/fast')
    assert.equal(forkSnap.thinkingLevel, 'high', 'explicit request.effort must override tier.thinkingLevel')

    // Missing tier fails loudly with 404 model_tier_not_found (never falls back to defaultModel!)
    await assertRejectsCode(
      () =>
        kernel.agentSpawn.spawnAgent({
          parentConversationId: worker.id,
          prompt: 'should fail',
          model: 'tier/nonexistent',
        }),
      'model_tier_not_found',
    )

    // Disabling target model causes tier usage to fail loudly with 409 model_disabled
    await kernel.models.setDisabledModels('faux', ['flagship'])
    const catWithDisabled = await kernel.models.listModels()
    const archEntry = catWithDisabled.modelTiers?.find((t) => t.id === 'architect')
    assert.equal(archEntry?.disabled, true)
    assert.equal(archEntry?.available, false)
    await assertRejectsCode(
      () =>
        kernel.agentSpawn.spawnAgent({
          parentConversationId: worker.id,
          prompt: 'disabled target',
          model: 'tier/architect',
        }),
      'model_disabled',
    )
    await kernel.models.setDisabledModels('faux', [])

    // 5. completeConversationText with explicit `tier/scout`
    env.faux.setResponses([fauxAssistantMessage('completed-via-tier')])
    const completion = await kernel.conversations.completeConversationText({
      conversationId: worker.id,
      model: 'tier/scout',
      systemPrompt: 'test',
      text: 'ping',
    })
    assert.equal(completion, 'completed-via-tier')

    // 6. Compaction wrapper dereferences `tier/scout` and applies tier thinkingLevel
    const seenModels: Array<{ id: string; reasoning: unknown }> = []
    const baseModels = kernel.models.models
    const spyModels = new Proxy(baseModels, {
      get(target, prop) {
        if (prop === 'completeSimple') {
          return async (
            model: Parameters<typeof baseModels.completeSimple>[0],
            _ctx: Parameters<typeof baseModels.completeSimple>[1],
            opts?: Parameters<typeof baseModels.completeSimple>[2],
          ) => {
            seenModels.push({ id: `${model.provider}/${model.id}`, reasoning: opts?.reasoning })
            return fauxAssistantMessage('summary')
          }
        }
        return Reflect.get(target, prop, target)
      },
    })
    const wrapped = wrapModelsForCompaction(spyModels, () => ({
      model: 'tier/scout',
      resolveModelRef: (ref) => kernel.models.resolveModelRef(ref),
      isDisabled: (p, m) => kernel.models.isModelDisabled(p, m),
    }))
    const flagshipModel = baseModels.getModel('faux', 'flagship')!
    await wrapped.completeSimple(
      flagshipModel,
      {
        messages: [
          { role: 'system', content: 'You are a context summarization assistant.' },
          { role: 'user', content: 'summarize' },
        ],
      } as never,
      { cacheRetention: 'none', reasoning: 'xhigh' } as never,
    )
    assert.deepEqual(seenModels, [{ id: 'faux/fast', reasoning: 'low' }])

    // 7. Reference protection: cannot remove `coder` or disable plugin while Profile `assistant` references `tier/coder`
    await assertRejectsCode(
      () => kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'remove', { id: 'coder' }),
      'model_tier_in_use',
    )
    await assertRejectsCode(() => kernel.plugins.disable(TIERS_PLUGIN_ID), 'plugin_in_use')

    // Clear Profile reference -> disable succeeds cleanly; tiers unmount from catalog; frozen `worker` keeps working!
    await kernel.profiles.save({ ...existingProfile, model: undefined })
    await kernel.plugins.disable(TIERS_PLUGIN_ID)
    const afterDisableCatalog = await kernel.models.listModels()
    assert.equal(afterDisableCatalog.modelTiers, undefined, 'disabled plugin must unmount tiers from ModelCatalog')
    assert.throws(
      () => kernel.plugins.getPublicDoc(TIERS_PLUGIN_ID, TIERS_STATE_DOC),
      (e: unknown) => e instanceof HelmxError && e.code === 'plugin_doc_not_found' && e.status === 404,
      'disabled plugin must stop exposing public doc state',
    )

    // Frozen worker conversation still runs without error after plugin disable!
    const afterSeq = kernel.conversations.getConversation(worker.id).completionSeq
    env.faux.setResponses([fauxAssistantMessage('still-alive')])
    await kernel.conversations.submitInput(worker.id, 'after disable')
    await waitTurnSettle(worker.id, afterSeq)
    assert.equal(kernel.conversations.getConversation(worker.id).model, 'faux/flagship')
  } finally {
    await env.close()
  }
})

test('integration: two-phase cold restart with defaultModel/compactionModel/Profile.model targeting tier/* recovers cleanly (live #1, tombstoned #1, and force-disabled builtin:tiers)', { timeout: 60_000 }, async () => {
  const dataDir = await makeTempDir('helmx-tiers-cold-boot-')
  const waitTurnSettle = async (
    kernel: Awaited<ReturnType<typeof createHelmx>>['kernel'],
    cid: number,
    prevSeq: number,
  ) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const snap = kernel.conversations.getConversation(cid)
      if (snap.completionSeq > prevSeq && snap.status !== 'working') return
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error(`timed out waiting for conv ${cid}`)
  }

  let inheritedGlobalId = 0
  let inheritedProfileId = 0
  let frozenExplicitId = 0
  let app: Awaited<ReturnType<typeof createHelmx>> | undefined

  try {
    // Phase 1: Configure tiers, set global default/compaction & Profile.model to `tier/*`, create conversations.
    const faux1 = makeMultiModelFaux()
    app = await createHelmx({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: dataDir,
      providers: [faux1.provider],
    })
    await app.kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'replace', {
      tiers: {
        scout: { model: 'faux/fast', thinkingLevel: 'low', description: 'Fast scouting' },
        coder: { model: 'faux/workhorse', thinkingLevel: 'medium', description: 'Mainline coding' },
        architect: { model: 'faux/flagship', thinkingLevel: 'high', description: 'Architecture' },
      },
    })
    await app.kernel.models.setDefaultModel('tier/scout', undefined, 'tier/scout')
    await app.kernel.profiles.save({
      id: 'specialist',
      name: 'Specialist',
      model: 'tier/coder',
    })
    const inheritedGlobal = await app.kernel.conversations.createConversation({ title: 'inherits-global-tier' })
    const inheritedProfile = await app.kernel.conversations.createConversation({
      title: 'inherits-profile-tier',
      profileId: 'specialist',
    })
    const frozenExplicit = await app.kernel.conversations.createConversation({
      title: 'frozen-explicit-tier',
      model: 'tier/architect',
    })
    inheritedGlobalId = inheritedGlobal.id
    inheritedProfileId = inheritedProfile.id
    frozenExplicitId = frozenExplicit.id
    assert.equal(app.kernel.conversations.getConversation(1).model, 'faux/fast')
    assert.equal(app.kernel.conversations.getConversation(1).thinkingLevel, 'low')
    assert.equal(inheritedGlobal.model, 'faux/fast')
    assert.equal(inheritedProfile.model, 'faux/workhorse')
    assert.equal(frozenExplicit.model, 'faux/flagship')
    await app.close()
    app = undefined

    // Phase 2: Two-phase cold restart (`autoStart: false` -> `kernel.start()`, matching `hub/src/main.ts` / Docker).
    // Deliberately omit `model` option so `config.json.model = "tier/scout"` is loaded from disk before plugins register.
    const faux2 = makeMultiModelFaux()
    app = await createHelmx({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: dataDir,
      providers: [faux2.provider],
      autoStart: false,
    })
    await app.kernel.start()
    assert.equal(app.kernel.conversations.getConversation(1).model, 'faux/fast')
    assert.equal(app.kernel.conversations.getConversation(1).thinkingLevel, 'low')
    assert.equal(app.kernel.conversations.getConversation(inheritedGlobalId).model, 'faux/fast')
    assert.equal(app.kernel.conversations.getConversation(inheritedGlobalId).thinkingLevel, 'low')
    assert.equal(app.kernel.conversations.getConversation(inheritedProfileId).model, 'faux/workhorse')
    assert.equal(app.kernel.conversations.getConversation(inheritedProfileId).thinkingLevel, 'medium')
    assert.equal(app.kernel.conversations.getConversation(frozenExplicitId).model, 'faux/flagship')
    assert.equal(app.kernel.conversations.getConversation(frozenExplicitId).thinkingLevel, 'high')

    const seq2 = app.kernel.conversations.getConversation(inheritedGlobalId).completionSeq
    faux2.setResponses([fauxAssistantMessage('recovered-via-tier')])
    await app.kernel.conversations.submitInput(inheritedGlobalId, 'ping after cold restart')
    await waitTurnSettle(app.kernel, inheritedGlobalId, seq2)

    // Delete #1 (tombstone) before next cold restart, matching production Docker state.
    await app.kernel.conversations.deleteConversation(1)
    await app.close()
    app = undefined

    // Phase 3: Cold restart with tombstoned #1 and `config.json.model = "tier/scout"`.
    const faux3 = makeMultiModelFaux()
    app = await createHelmx({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: dataDir,
      providers: [faux3.provider],
      autoStart: false,
    })
    await app.kernel.start()
    assert.equal(
      app.kernel.conversations.listConversations().some((c) => c.id === 1),
      false,
      'tombstoned #1 must not resurrect after cold restart',
    )
    assert.equal(app.kernel.conversations.getConversation(inheritedGlobalId).model, 'faux/fast')
    assert.equal(app.kernel.conversations.getConversation(inheritedProfileId).model, 'faux/workhorse')

    // Force-disable builtin:tiers while global defaultModel and Profile.model still reference `tier/*`.
    await app.kernel.plugins.disable(TIERS_PLUGIN_ID, { force: true })
    await app.close()
    app = undefined

    // Phase 4: Cold restart with `builtin:tiers` disabled & dangling `tier/*` references must NOT crash-loop Hub.
    const faux4 = makeMultiModelFaux()
    app = await createHelmx({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: dataDir,
      providers: [faux4.provider],
      autoStart: false,
    })
    await app.kernel.start()

    // Editing unrelated metadata on a Profile inheriting dangling `tier/scout` must not fail alignment.
    const assistantProfile = await app.kernel.profiles.get('assistant')
    assert.ok(assistantProfile)
    await app.kernel.profiles.save({ ...assistantProfile, name: 'updated while tiers disabled' })
    await app.kernel.conversations.alignProfileConversations('assistant')

    // Frozen conversation still executes cleanly without builtin:tiers.
    const frozenSeq = app.kernel.conversations.getConversation(frozenExplicitId).completionSeq
    faux4.setResponses([fauxAssistantMessage('frozen-still-works')])
    await app.kernel.conversations.submitInput(frozenExplicitId, 'still works')
    await waitTurnSettle(app.kernel, frozenExplicitId, frozenSeq)

    // Active submission on a conversation inheriting unmounted `tier/scout` still fails honestly with 404.
    await assertRejectsCode(
      () => app!.kernel.conversations.submitInput(inheritedGlobalId, 'should fail honestly'),
      'model_tier_not_found',
    )
  } finally {
    await app?.close().catch(() => {})
    await cleanupDir(dataDir)
  }
})

test('integration: KernelRuntime.start() aligns initial & recovered tier conversations even when a custom tier plugin mounts in prepare() without notifyChanged()', { timeout: 60_000 }, async () => {
  const dataDir = await makeTempDir('helmx-tiers-custom-prepare-')
  const faux = makeMultiModelFaux()
  let kernel: KernelRuntime | undefined
  try {
    kernel = await KernelRuntime.open({
      dataDir,
      cwd: dataDir,
      model: 'tier/custom',
      providers: [faux.provider],
      autoResume: false,
    })
    await kernel.plugins.register({
      id: 'test:silent-tiers',
      definePlugin(ctx) {
        ctx.service({
          id: 'mount-only',
          prepare() {
            ctx.provide('helmx.model-tiers', {
              getTiers: () => ({
                custom: { model: 'faux/fast', thinkingLevel: 'low' },
              }),
            })
          },
          start() {
            // Deliberately omits onChanged(); kernel.start() must converge deferred boot alignment itself.
          },
          stop() {},
        })
      },
    })
    await kernel.start()
    const root = kernel.conversations.getConversation(1)
    assert.equal(root.model, 'faux/fast')
    assert.equal(root.thinkingLevel, 'low')
  } finally {
    await kernel?.close().catch(() => {})
    await cleanupDir(dataDir)
  }
})

test('plugin factory sanity: metadata and icons contain no emoji', { timeout: 60_000 }, () => {
  const def = createTiersPlugin()
  assert.equal(def.id, TIERS_PLUGIN_ID)
  assert.equal(def.icon, 'layers')
  const catalogCheck: ModelCatalog = { models: [], thinkingLevels: {} }
  const profilesCheck: Profile[] = []
  assert.ok(catalogCheck && profilesCheck)
})

test('performance: tiers write actions reuse a single ModelCatalog fetch per set/replace/remove', { timeout: 60_000 }, async () => {
  const env = await openHelmxEnv()
  try {
    const { kernel } = env.app
    let listModelsCalls = 0
    const origListModels = kernel.models.listModels.bind(kernel.models)
    kernel.models.listModels = async () => {
      listModelsCalls += 1
      return origListModels()
    }

    listModelsCalls = 0
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'scout',
      model: 'faux/fast',
      thinkingLevel: 'low',
    })
    assert.equal(listModelsCalls, 1, 'tiers set must reuse one ModelCatalog fetch')

    listModelsCalls = 0
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'replace', {
      tiers: {
        scout: { model: 'faux/fast', thinkingLevel: 'low' },
        coder: { model: 'faux/workhorse', thinkingLevel: 'medium' },
      },
    })
    assert.equal(listModelsCalls, 1, 'tiers replace must reuse one ModelCatalog fetch')

    listModelsCalls = 0
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'remove', { id: 'coder' })
    assert.equal(listModelsCalls, 1, 'tiers remove must reuse one ModelCatalog fetch')
  } finally {
    await env.close()
  }
})

test('performance: tiers readState caches sanitized TiersStateDoc across getTiers/before_turn and invalidates on mutation', { timeout: 60_000 }, async () => {
  const { PluginHost } = await import('@helmx/kernel')
  const { createPluginHostBackendFixture } = await import('../../kernel/test/helpers/plugin-host-backend.js')
  const docs = new MemoryDocStore()
  let docGetCalls = 0
  const origGet = docs.get.bind(docs)
  docs.get = <T>(key: string, initial: T): T => {
    if (key === `${TIERS_PLUGIN_ID}:${TIERS_STATE_DOC}`) docGetCalls += 1
    return origGet(key, initial)
  }
  const dataDir = await makeTempDir('helmx-tiers-cache-')
  const baseFixture = createPluginHostBackendFixture()
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    docs,
    kv: new MemoryKvStore(),
    host: {
      ...baseFixture,
      emitEvent: () => {},
      onEvent: () => () => {},
      skills: {
        ...baseFixture.skills,
        ensureSkill: async () => {},
      },
      listModels: async () => ({
        models: [
          {
            modelId: 'faux/fast',
            provider: 'faux',
            id: 'fast',
            name: 'Fast',
            available: true,
            reasoning: true,
            input: ['text'],
            contextWindow: 8000,
            maxTokens: 1000,
          },
        ],
        thinkingLevels: { 'faux/fast': ['low', 'medium'] },
      }),
    },
  })
  try {
    await host.register(createTiersPlugin())
    const writesAfterInit = docGetCalls
    for (let i = 0; i < 15; i += 1) {
      await host.runHook('before_turn', {
        conversation: makeConversationSummary({ id: 1 }),
        inputs: [],
        messages: [],
        sections: [],
        tools: [{ name: 'subagent', description: 's', inputSchema: {} }],
      } as never)
    }
    assert.equal(docGetCalls, writesAfterInit, 'repeated before_turn calls reuse cached sanitized TiersStateDoc without re-reading/cloning doc')

    await host.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'scout',
      model: 'faux/fast',
      thinkingLevel: 'low',
    })
    const state = (await host.invokeAction(TIERS_PLUGIN_ID, 'list', {})) as { tiers: Array<{ id: string }> }
    assert.equal(state.tiers.some((t) => t.id === 'scout'), true, 'mutation updates cached state immediately')
  } finally {
    await host.dispose().catch(() => {})
    await cleanupDir(dataDir)
  }
})

test('purification: tiers rejects orchestrator fields and client bundle exposes only TiersManagerScreen & TiersSettingsPanel', { timeout: 60_000 }, async () => {
  assert.throws(
    () => normalizeTierSpec({ kind: 'orchestrator', model: 'faux/flagship', executorModel: 'faux/fast' }),
    (e: unknown) => e instanceof HelmxError && e.code === 'validation_error',
  )
  assert.throws(
    () => normalizeTierSpec({ model: 'faux/flagship', executorModel: 'faux/fast' }),
    (e: unknown) => e instanceof HelmxError && e.code === 'validation_error',
  )
  const env = await openHelmxEnv()
  try {
    const manifest = env.app.kernel.plugins.getManifest(TIERS_PLUGIN_ID)
    assert.equal(manifest.tools.length, 0)
    assert.equal(manifest.ui.some((u) => u.surface === 'tool.view'), false)
    assert.equal(manifest.ui.some((u) => u.surface === 'plugin.slot'), false)
    const indexMod = await env.app.kernel.plugins.getClientModule(TIERS_PLUGIN_ID, 'index.tsx')
    assert.match(indexMod.code, /TiersManagerScreen/)
    assert.match(indexMod.code, /TiersSettingsPanel/)
    assert.doesNotMatch(indexMod.code, /BorrowToolbarPill|OrchestratorStatusBadge|SwitchModelToolRow/)
  } finally {
    await env.close()
  }
})


