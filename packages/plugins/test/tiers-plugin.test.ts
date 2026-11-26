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
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { HelmxError, type ModelCatalog, type Profile } from '@helmx/protocol'
import { KernelRuntime } from '@helmx/kernel'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { createHelmx } from '../../hub/src/app.js'
import { wrapModelsForCompaction } from '@helmx/kernel/testing'
import {
  MODEL_TIERS_SKILL_ID,
  TIERS_BORROW_KV,
  TIERS_BORROW_SESSION_DOC,
  TIERS_INPUT_META_KEY,
  TIERS_PLUGIN_ID,
  TIERS_STATE_DOC,
  TIERS_SWITCH_MODEL_TOOL,
  createTiersPlugin,
} from '../src/tiers.js'
import {
  parseTiersBorrowInputMeta,
  type TierBorrowRecord,
  type TierBorrowSessionView,
} from '../src/tiers/contracts.js'
import { createTierBorrowManager, resolveBorrowTarget } from '../src/tiers/borrow.js'
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
  deferred,
  makeConversationSummary,
  makeFauxProvider,
  makeTempDir,
  waitFor,
  type FauxProviderHandle,
} from './helpers/plugin-test-env.js'

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
  ])
  assert.ok(xml !== undefined)
  assert.match(xml, /<tier id="tier\/scout" effort="low">Fast search<\/tier>/)
  assert.match(xml, /never agentType or profileId/)
  assert.doesNotMatch(xml, /tier\/broken/)
  assert.doesNotMatch(xml, /tier\/muted/)
  assert.equal(renderModelTiersCatalogSection([{ id: 'x', model: 'faux/fast', available: false }]), undefined)
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

// ---------------------------------------------------------------------------
// One-turn model borrow (`/model`) & in-session model relay (`switch_model`)
// ---------------------------------------------------------------------------

test('borrow resolution: zero-tier direct refs, unique short id, ambiguous multi-provider id, tier resolution, and explicit errors', { timeout: 60_000 }, () => {
  const catalog: ModelCatalog = {
    models: [
      { provider: 'faux', modelId: 'fast', available: true },
      { provider: 'faux', modelId: 'flagship', available: true },
      { provider: 'openrouter', modelId: 'anthropic/claude-opus-4.6', available: true },
      { provider: 'p1', modelId: 'shared', available: true },
      { provider: 'p2', modelId: 'shared', available: true },
      { provider: 'faux', modelId: 'muted', available: true, disabled: true },
      { provider: 'p3', modelId: 'only-disabled', available: true, disabled: true },
      { provider: 'openai', modelId: 'unconfigured', available: false },
      { provider: 'p4', modelId: 'no-creds-short', available: false },
    ],
    thinkingLevels: {},
  }
  const emptyTiers = { tiers: {}, templates: {} }

  // Zero-tier exact provider/modelId (including slashed modelId) & unique short modelId
  assert.deepEqual(resolveBorrowTarget('faux/flagship', catalog, emptyTiers), {
    requestedRef: 'faux/flagship',
    targetModel: 'faux/flagship',
    targetConcreteModel: 'faux/flagship',
    targetLabel: 'flagship',
  })
  assert.deepEqual(resolveBorrowTarget('openrouter/anthropic/claude-opus-4.6', catalog, emptyTiers, 'high'), {
    requestedRef: 'openrouter/anthropic/claude-opus-4.6',
    targetModel: 'openrouter/anthropic/claude-opus-4.6',
    targetConcreteModel: 'openrouter/anthropic/claude-opus-4.6',
    targetLabel: 'claude-opus-4.6',
    effort: 'high',
  })
  assert.deepEqual(resolveBorrowTarget('flagship', catalog, emptyTiers), {
    requestedRef: 'flagship',
    targetModel: 'faux/flagship',
    targetConcreteModel: 'faux/flagship',
    targetLabel: 'flagship',
  })

  // Ambiguous short modelId fails honestly with 409 ambiguous_model_ref listing candidates
  assert.throws(
    () => resolveBorrowTarget('shared', catalog, emptyTiers),
    (err: unknown) =>
      err instanceof HelmxError &&
      err.code === 'ambiguous_model_ref' &&
      err.status === 409 &&
      err.message.includes('p1/shared') &&
      err.message.includes('p2/shared'),
  )

  // Disabled / unavailable / missing / invalid effort errors
  assert.throws(
    () => resolveBorrowTarget('faux/muted', catalog, emptyTiers),
    (err: unknown) => err instanceof HelmxError && err.code === 'model_disabled' && err.status === 409,
  )
  assert.throws(
    () => resolveBorrowTarget('only-disabled', catalog, emptyTiers),
    (err: unknown) => err instanceof HelmxError && err.code === 'model_disabled' && err.status === 409,
  )
  assert.throws(
    () => resolveBorrowTarget('openai/unconfigured', catalog, emptyTiers),
    (err: unknown) =>
      err instanceof HelmxError &&
      err.code === 'model_unavailable' &&
      err.status === 409 &&
      (err.details as { model?: string } | undefined)?.model === 'openai/unconfigured',
  )
  assert.throws(
    () => resolveBorrowTarget('no-creds-short', catalog, emptyTiers),
    (err: unknown) => err instanceof HelmxError && err.code === 'model_unavailable' && err.status === 409,
  )
  assert.throws(
    () => resolveBorrowTarget('faux/does-not-exist', catalog, emptyTiers),
    (err: unknown) => err instanceof HelmxError && err.code === 'model_not_found' && err.status === 404,
  )
  assert.throws(
    () => resolveBorrowTarget('tier/ghost', catalog, emptyTiers),
    (err: unknown) => err instanceof HelmxError && err.code === 'tier_not_found' && err.status === 404,
  )
  assert.throws(
    () => resolveBorrowTarget('faux/flagship', catalog, emptyTiers, 'turbo'),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_effort' && err.status === 400,
  )

  // Configured tier resolution (`tier/<id>` and bare `<id>`) + disabled/unavailable/missing tier targets
  const withTiers = {
    tiers: {
      architect: { model: 'faux/flagship', thinkingLevel: 'high' as const },
      disabled_tier: { model: 'faux/muted' },
      unavailable_tier: { model: 'openai/unconfigured' },
      missing_tier: { model: 'faux/missing' },
    },
    templates: {},
  }
  assert.deepEqual(resolveBorrowTarget('tier/architect', catalog, withTiers), {
    requestedRef: 'tier/architect',
    targetModel: 'tier/architect',
    targetConcreteModel: 'faux/flagship',
    targetLabel: 'tier/architect',
    targetTierId: 'architect',
  })
  assert.deepEqual(resolveBorrowTarget('architect', catalog, withTiers), {
    requestedRef: 'architect',
    targetModel: 'tier/architect',
    targetConcreteModel: 'faux/flagship',
    targetLabel: 'tier/architect',
    targetTierId: 'architect',
  })
  assert.throws(
    () => resolveBorrowTarget('disabled_tier', catalog, withTiers),
    (err: unknown) => err instanceof HelmxError && err.code === 'model_disabled' && err.status === 409,
  )
  assert.throws(
    () => resolveBorrowTarget('tier/unavailable_tier', catalog, withTiers),
    (err: unknown) =>
      err instanceof HelmxError &&
      err.code === 'model_unavailable' &&
      err.status === 409 &&
      (err.details as { tierId?: string; model?: string } | undefined)?.tierId === 'unavailable_tier' &&
      (err.details as { tierId?: string; model?: string } | undefined)?.model === 'openai/unconfigured',
  )
  assert.throws(
    () => resolveBorrowTarget('unavailable_tier', catalog, withTiers),
    (err: unknown) => err instanceof HelmxError && err.code === 'model_unavailable' && err.status === 409,
  )
  assert.throws(
    () => resolveBorrowTarget('missing_tier', catalog, withTiers),
    (err: unknown) => err instanceof HelmxError && err.code === 'model_not_found' && err.status === 404,
  )

  // Input metadata parser
  assert.deepEqual(parseTiersBorrowInputMeta(undefined), { present: false })
  assert.deepEqual(
    parseTiersBorrowInputMeta({ [TIERS_INPUT_META_KEY]: { borrowModel: ' faux/flagship ', effort: 'high' } }),
    { present: true, valid: true, borrowModel: 'faux/flagship', effort: 'high' },
  )
  const badMeta = parseTiersBorrowInputMeta({ [TIERS_INPUT_META_KEY]: { borrowModel: '' } })
  assert.equal(badMeta.present && !badMeta.valid, true)
})

test('integration: builtin:tiers registers no /model command or menu slot, leaves /model text untouched, and set_borrow restores inherited & explicit overrides', { timeout: 60_000 }, async () => {
  const env = await openHelmxEnv({ defaultModel: 'faux/workhorse' })
  try {
    const { kernel } = env.app
    // Confirm zero tiers are configured & no command/menu slot registered
    assert.equal((await kernel.models.listModels()).modelTiers, undefined)
    const tiersUi = kernel.plugins.listUi().filter((u) => u.pluginId === TIERS_PLUGIN_ID)
    assert.equal(tiersUi.some((u) => u.surface === 'commandPalette'), false)
    assert.equal(
      tiersUi.some(
        (u) =>
          u.surface === 'plugin.slot' &&
          (u.spec as { target?: string }).target === 'builtin:composer/menu',
      ),
      false,
    )
    assert.equal(
      tiersUi.some(
        (u) =>
          u.surface === 'plugin.slot' &&
          (u.spec as { target?: string }).target === 'builtin:composer/toolbar',
      ),
      true,
    )
    assert.equal(tiersUi.some((u) => u.surface === 'tool.view'), true)
    const actionIds = kernel.plugins
      .listActions()
      .filter((a) => a.pluginId === TIERS_PLUGIN_ID)
      .map((a) => a.id)
    assert.ok(actionIds.includes('get_borrow') && actionIds.includes('set_borrow') && actionIds.includes('clear_borrow'))

    // 1. Conversation inheriting global default (`modelOverride === undefined`)
    const inherited = await kernel.conversations.createConversation()
    assert.equal(inherited.model, 'faux/workhorse')
    assert.equal(inherited.modelOverride, undefined)
    assert.equal(
      kernel.plugins.listTools(inherited).some((t) => t.name === TIERS_SWITCH_MODEL_TOOL),
      true,
      'switch_model tool remains available on top-level human conversations',
    )

    // `/model ...` text is no longer intercepted or blocked by builtin:tiers
    const slashHook = await kernel.plugins.runHook('input', {
      conversationId: inherited.id,
      input: { id: 'req-slash-ignored', text: '/model faux/flagship hello', origin: 'human', createdAt: Date.now() },
    })
    assert.ok(slashHook.action === 'continue' || slashHook.action === 'transform')
    if (slashHook.action === 'transform') {
      assert.equal(slashHook.value.input.text, '/model faux/flagship hello')
    }
    assert.equal(kernel.conversations.getConversation(inherited.id).model, 'faux/workhorse')
    assert.equal(
      await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'get_borrow', { conversationId: inherited.id }),
      null,
    )

    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set_borrow', {
      conversationId: inherited.id,
      model: 'faux/flagship',
    })
    const observedModels: string[] = []
    env.faux.setResponses([
      () => {
        observedModels.push(kernel.conversations.getConversation(inherited.id).model)
        return fauxAssistantMessage('flagship-answer')
      },
    ])
    const seqBeforeA = kernel.conversations.getConversation(inherited.id).completionSeq
    await kernel.conversations.submitInput(inherited.id, 'analyze this diff')
    await kernel.conversations.waitForIdle(inherited.id)
    assert.ok(kernel.conversations.getConversation(inherited.id).completionSeq > seqBeforeA)

    assert.deepEqual(observedModels, ['faux/flagship'], 'turn must execute on borrowed model')
    const afterA = kernel.conversations.getConversation(inherited.id)
    assert.equal(afterA.model, 'faux/workhorse', 'must restore inherited default model')
    assert.equal(afterA.modelOverride, undefined, 'must clear modelOverride back to inherited default')

    const borrowA = (await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'get_borrow', {
      conversationId: inherited.id,
    })) as TierBorrowSessionView | null
    assert.equal(borrowA, null)

    // 2. Conversation with explicit modelOverride AND thinkingLevelOverride + unique short modelId
    const explicitCreated = await kernel.conversations.createConversation({
      title: 'explicit-conv',
      model: 'faux/fast',
    })
    const explicit = await kernel.conversations.updateConversation(explicitCreated.id, { thinkingLevel: 'low' })
    assert.equal(explicit.modelOverride, 'faux/fast')
    assert.equal(explicit.thinkingLevelOverride, 'low')

    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set_borrow', {
      conversationId: explicit.id,
      model: 'flagship',
    })
    const observedB: string[] = []
    env.faux.setResponses([
      () => {
        observedB.push(kernel.conversations.getConversation(explicit.id).model)
        return fauxAssistantMessage('short-id-answer')
      },
    ])
    const seqBeforeB = kernel.conversations.getConversation(explicit.id).completionSeq
    await kernel.conversations.submitInput(explicit.id, 'check edge cases')
    await kernel.conversations.waitForIdle(explicit.id)
    assert.ok(kernel.conversations.getConversation(explicit.id).completionSeq > seqBeforeB)
    assert.deepEqual(observedB, ['faux/flagship'])
    const afterB = kernel.conversations.getConversation(explicit.id)
    assert.equal(afterB.model, 'faux/fast')
    assert.equal(afterB.modelOverride, 'faux/fast', 'must restore original explicit modelOverride')
    assert.equal(afterB.thinkingLevelOverride, 'low', 'must restore original thinkingLevelOverride')
  } finally {
    await env.close()
  }
})

test('integration: set_borrow arms borrow (sessionDoc), stale disabled armed target blocks honestly, and standby input.meta works', { timeout: 60_000 }, async () => {
  const env = await openHelmxEnv({ defaultModel: 'faux/workhorse' })
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'architect',
      model: 'faux/flagship',
      thinkingLevel: 'high',
      description: 'Architecture',
    })

    const conv = await kernel.conversations.createConversation({ title: 'arm-test' })
    const callsBeforeArm = env.faux.state.callCount

    // 1. set_borrow arms borrow without invoking the model
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set_borrow', {
      conversationId: conv.id,
      model: 'tier/architect',
    })
    assert.equal(env.faux.state.callCount, callsBeforeArm, 'arming via set_borrow must not trigger a model turn')
    const armedRes = (await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'get_borrow', {
      conversationId: conv.id,
    })) as TierBorrowSessionView | null
    assert.equal(armedRes?.phase, 'armed')
    assert.equal(armedRes?.targetModel, 'tier/architect')
    assert.equal(armedRes?.targetConcreteModel, 'faux/flagship')
    const armedDoc = kernel.plugins.getPublicSessionDoc(TIERS_PLUGIN_ID, TIERS_BORROW_SESSION_DOC, conv.id)
    assert.equal((armedDoc.value as TierBorrowSessionView | null)?.phase, 'armed')

    // 2. Next plain message activates the armed borrow and restores after settle
    let seenDuringTurn: { model: string; thinking: string; phase?: string } | undefined
    env.faux.setResponses([
      () => {
        const snap = kernel.conversations.getConversation(conv.id)
        const doc = kernel.plugins.getPublicSessionDoc(TIERS_PLUGIN_ID, TIERS_BORROW_SESSION_DOC, conv.id)
        seenDuringTurn = {
          model: snap.model,
          thinking: snap.thinkingLevel,
          phase: (doc.value as TierBorrowSessionView | null)?.phase,
        }
        return fauxAssistantMessage('armed-turn-done')
      },
    ])
    const seq1 = kernel.conversations.getConversation(conv.id).completionSeq
    await kernel.conversations.submitInput(conv.id, 'review auth architecture')
    await kernel.conversations.waitForIdle(conv.id)
    assert.ok(kernel.conversations.getConversation(conv.id).completionSeq > seq1)
    assert.deepEqual(seenDuringTurn, { model: 'faux/flagship', thinking: 'high', phase: 'active' })
    assert.equal(kernel.conversations.getConversation(conv.id).model, 'faux/workhorse')
    assert.equal(kernel.conversations.getConversation(conv.id).modelOverride, undefined)
    assert.equal(kernel.conversations.getConversation(conv.id).thinkingLevelOverride, undefined)
    assert.equal(kernel.plugins.getPublicSessionDoc(TIERS_PLUGIN_ID, TIERS_BORROW_SESSION_DOC, conv.id).value, null)

    // 3. Stale armed target whose concrete model gets disabled blocks honestly with guidance
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set_borrow', {
      conversationId: conv.id,
      model: 'tier/architect',
    })
    await kernel.models.setDisabledModels('faux', ['flagship'])
    await assertRejectsCode(() => kernel.conversations.submitInput(conv.id, 'should fail'), 'input_blocked')
    const cleared = (await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'clear_borrow', {
      conversationId: conv.id,
    })) as { cleared: boolean; previousPhase?: string }
    assert.deepEqual(cleared, { cleared: true, previousPhase: 'armed' })
    await kernel.models.setDisabledModels('faux', [])

    // 4. Standby first-send via `input.meta['builtin:tiers']`
    const standbyConv = await kernel.conversations.createConversation({ title: 'standby-first-send' })
    let seenStandby: { model: string; thinking: string } | undefined
    env.faux.setResponses([
      () => {
        const snap = kernel.conversations.getConversation(standbyConv.id)
        seenStandby = { model: snap.model, thinking: snap.thinkingLevel }
        return fauxAssistantMessage('standby-done')
      },
    ])
    const seqStandby = kernel.conversations.getConversation(standbyConv.id).completionSeq
    await kernel.conversations.submitInput(standbyConv.id, 'first message from standby', {
      meta: { [TIERS_INPUT_META_KEY]: { borrowModel: 'tier/architect', effort: 'medium' } },
    })
    await kernel.conversations.waitForIdle(standbyConv.id)
    assert.ok(kernel.conversations.getConversation(standbyConv.id).completionSeq > seqStandby)
    assert.deepEqual(seenStandby, { model: 'faux/flagship', thinking: 'medium' })
    assert.equal(kernel.conversations.getConversation(standbyConv.id).model, 'faux/workhorse')
    assert.equal(kernel.conversations.getConversation(standbyConv.id).modelOverride, undefined)

    // Invalid input.meta fails explicitly
    await assertRejectsCode(
      () =>
        kernel.conversations.submitInput(standbyConv.id, 'bad meta', {
          meta: { [TIERS_INPUT_META_KEY]: { borrowModel: '' } },
        }),
      'input_blocked',
    )
  } finally {
    await env.close()
  }
})

test('integration: followUp preserves borrow until idle, CAS guard respects manual changes/clears, busy clear_borrow keeps model, and inUse blocks disable', { timeout: 60_000 }, async () => {
  const env = await openHelmxEnv({ defaultModel: 'faux/workhorse' })
  try {
    const { kernel } = env.app
    let holdEntered = deferred<void>()
    let holdRelease = deferred<void>()
    await kernel.plugins.register({
      id: 'test:borrow-hold',
      definePlugin(ctx) {
        ctx.tool({
          name: 'hold_borrow_turn',
          description: 'Hold turn open for deterministic concurrency testing',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          async execute() {
            holdEntered.resolve()
            await holdRelease.promise
            return 'released'
          },
        })
      },
    })

    // --- Scenario A: queued followUp does NOT restore prematurely; inUse reports active borrow ---
    const convA = await kernel.conversations.createConversation({ title: 'followup-conv' })
    holdEntered = deferred<void>()
    holdRelease = deferred<void>()
    const seenModelsA: string[] = []
    env.faux.setResponses([
      () => {
        seenModelsA.push(kernel.conversations.getConversation(convA.id).model)
        return fauxAssistantMessage([fauxToolCall('hold_borrow_turn', {})], { stopReason: 'toolUse' })
      },
      () => {
        seenModelsA.push(kernel.conversations.getConversation(convA.id).model)
        return fauxAssistantMessage('run-1-done')
      },
      () => {
        seenModelsA.push(kernel.conversations.getConversation(convA.id).model)
        return fauxAssistantMessage('run-2-followup-done')
      },
    ])
    const seqA0 = kernel.conversations.getConversation(convA.id).completionSeq
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set_borrow', {
      conversationId: convA.id,
      model: 'faux/flagship',
    })
    await kernel.conversations.submitInput(convA.id, 'first run')
    await holdEntered.promise

    // While active & busy:
    // - inUse() blocks disabling builtin:tiers
    // - set_borrow fails with 409 conversation_busy
    await assertRejectsCode(() => kernel.plugins.disable(TIERS_PLUGIN_ID), 'plugin_in_use')
    await assertRejectsCode(
      () => kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set_borrow', { conversationId: convA.id, model: 'faux/fast' }),
      'conversation_busy',
    )

    // Queue followUp while Run 1 is held -> release Run 1 -> Run 2 must still run on faux/flagship
    await kernel.conversations.submitInput(convA.id, 'follow up message', { whenBusy: 'followUp' })
    holdRelease.resolve()
    await kernel.conversations.waitForIdle(convA.id)
    assert.ok(kernel.conversations.getConversation(convA.id).completionSeq > seqA0)
    assert.deepEqual(seenModelsA, ['faux/flagship', 'faux/flagship', 'faux/flagship'])
    assert.equal(kernel.conversations.getConversation(convA.id).model, 'faux/workhorse')
    assert.equal(kernel.conversations.getConversation(convA.id).modelOverride, undefined)

    // --- Scenario B: CAS guard when user manually switches model mid-borrow ---
    const convB = await kernel.conversations.createConversation({ title: 'cas-switch-conv' })
    holdEntered = deferred<void>()
    holdRelease = deferred<void>()
    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('hold_borrow_turn', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('done-after-manual-switch'),
    ])
    const seqB0 = kernel.conversations.getConversation(convB.id).completionSeq
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set_borrow', {
      conversationId: convB.id,
      model: 'faux/flagship',
    })
    await kernel.conversations.submitInput(convB.id, 'start')
    await holdEntered.promise
    await kernel.conversations.updateConversation(convB.id, { model: 'faux/fast' })
    holdRelease.resolve()
    await kernel.conversations.waitForIdle(convB.id)
    assert.ok(kernel.conversations.getConversation(convB.id).completionSeq > seqB0)
    assert.equal(kernel.conversations.getConversation(convB.id).model, 'faux/fast', 'CAS must not overwrite manual switch')
    assert.equal(kernel.conversations.getConversation(convB.id).modelOverride, 'faux/fast')
    assert.equal(kernel.plugins.getPublicSessionDoc(TIERS_PLUGIN_ID, TIERS_BORROW_SESSION_DOC, convB.id).value, null)

    // --- Scenario C: CAS guard when user manually clears model override mid-borrow ---
    const convC = await kernel.conversations.createConversation({ title: 'cas-clear-conv', model: 'faux/fast' })
    holdEntered = deferred<void>()
    holdRelease = deferred<void>()
    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('hold_borrow_turn', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('done-after-manual-clear'),
    ])
    const seqC0 = kernel.conversations.getConversation(convC.id).completionSeq
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set_borrow', {
      conversationId: convC.id,
      model: 'faux/flagship',
    })
    await kernel.conversations.submitInput(convC.id, 'start')
    await holdEntered.promise
    await kernel.conversations.updateConversation(convC.id, { model: '' })
    holdRelease.resolve()
    await kernel.conversations.waitForIdle(convC.id)
    assert.ok(kernel.conversations.getConversation(convC.id).completionSeq > seqC0)
    assert.equal(kernel.conversations.getConversation(convC.id).model, 'faux/workhorse')
    assert.equal(kernel.conversations.getConversation(convC.id).modelOverride, undefined, 'CAS must not overwrite manual reset')

    // --- Scenario D: busy clear_borrow on active borrow disables auto-restore & stays on borrowed model ---
    const convD = await kernel.conversations.createConversation({ title: 'busy-clear-conv' })
    holdEntered = deferred<void>()
    holdRelease = deferred<void>()
    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('hold_borrow_turn', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('stay-on-flagship'),
    ])
    const seqD0 = kernel.conversations.getConversation(convD.id).completionSeq
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set_borrow', {
      conversationId: convD.id,
      model: 'faux/flagship',
    })
    await kernel.conversations.submitInput(convD.id, 'start')
    await holdEntered.promise
    const clearActiveRes = (await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'clear_borrow', {
      conversationId: convD.id,
    })) as { cleared: boolean; previousPhase?: string }
    assert.deepEqual(clearActiveRes, { cleared: true, previousPhase: 'active' })
    holdRelease.resolve()
    await kernel.conversations.waitForIdle(convD.id)
    assert.ok(kernel.conversations.getConversation(convD.id).completionSeq > seqD0)
    assert.equal(kernel.conversations.getConversation(convD.id).model, 'faux/flagship', 'clear_borrow on active turn keeps borrowed model')
    assert.equal(kernel.conversations.getConversation(convD.id).modelOverride, 'faux/flagship')
  } finally {
    await env.close()
  }
})

test('integration: switch_model chained relay (A->B->C restores A), permanent switch, presentationMeta, scope guard, reset/delete cleanup', { timeout: 60_000 }, async () => {
  const env = await openHelmxEnv({ defaultModel: 'faux/workhorse' })
  try {
    const { kernel } = env.app
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'replace', {
      tiers: {
        coder: { model: 'faux/workhorse', thinkingLevel: 'medium', description: 'Coder' },
        architect: { model: 'faux/flagship', thinkingLevel: 'high', description: 'Architect' },
      },
    })

    // Start on baseline A: faux/fast · low
    const convCreated = await kernel.conversations.createConversation({
      title: 'relay-conv',
      model: 'faux/fast',
    })
    const conv = await kernel.conversations.updateConversation(convCreated.id, { thinkingLevel: 'low' })

    // 1. Chained switch_model in a single turn: A (fast) -> B (tier/coder) -> C (tier/architect) -> restores A (fast · low)
    const stepModels: string[] = []
    env.faux.setResponses([
      () => {
        stepModels.push(kernel.conversations.getConversation(conv.id).model)
        return fauxAssistantMessage(
          [fauxToolCall(TIERS_SWITCH_MODEL_TOOL, { model: 'tier/coder' }, { id: 'sw-1' })],
          { stopReason: 'toolUse' },
        )
      },
      () => {
        stepModels.push(kernel.conversations.getConversation(conv.id).model)
        return fauxAssistantMessage(
          [fauxToolCall(TIERS_SWITCH_MODEL_TOOL, { model: 'tier/architect', effort: 'high' }, { id: 'sw-2' })],
          { stopReason: 'toolUse' },
        )
      },
      () => {
        stepModels.push(kernel.conversations.getConversation(conv.id).model)
        return fauxAssistantMessage('chained-relay-complete')
      },
    ])
    const seq1 = kernel.conversations.getConversation(conv.id).completionSeq
    await kernel.conversations.submitInput(conv.id, 'escalate twice in one turn')
    await kernel.conversations.waitForIdle(conv.id)
    assert.ok(kernel.conversations.getConversation(conv.id).completionSeq > seq1)

    assert.deepEqual(stepModels, ['faux/fast', 'faux/workhorse', 'faux/flagship'])
    const afterRelay = kernel.conversations.getConversation(conv.id)
    assert.equal(afterRelay.model, 'faux/fast', 'chained switch_model must restore original baseline A, not intermediate B')
    assert.equal(afterRelay.modelOverride, 'faux/fast')
    assert.equal(afterRelay.thinkingLevelOverride, 'low')

    // Verify tool results carry structured presentationMeta (persisted in toolResult.details)
    const detail = await kernel.conversations.getConversationDetail(conv.id)
    const switchToolMsgs = detail.entries
      .filter((entry) => entry.kind === 'pi.tool-result')
      .flatMap((entry) => (Array.isArray(entry.model) ? entry.model : []))
      .filter(
        (msg): msg is { role: string; toolName: string; details?: Record<string, unknown> } =>
          typeof msg === 'object' &&
          msg !== null &&
          (msg as { role?: unknown }).role === 'toolResult' &&
          (msg as { toolName?: unknown }).toolName === TIERS_SWITCH_MODEL_TOOL,
      )
    assert.equal(switchToolMsgs.length, 2)
    const firstMeta = switchToolMsgs[0]?.details
    const secondMeta = switchToolMsgs[1]?.details
    assert.equal(firstMeta?.['fromModel'], 'faux/fast')
    assert.equal(firstMeta?.['toModel'], 'faux/workhorse')
    assert.equal(firstMeta?.['toLabel'], 'tier/coder')
    assert.equal(firstMeta?.['restoreAfterTurn'], true)
    assert.equal(secondMeta?.['fromModel'], 'faux/workhorse')
    assert.equal(secondMeta?.['toModel'], 'faux/flagship')
    assert.equal(secondMeta?.['tierId'], 'architect')
    assert.equal(secondMeta?.['effort'], 'high')
    assert.equal(secondMeta?.['restoreAfterTurn'], true)

    // 2. Permanent switch_model (`restoreAfterTurn: false`) stays on target and clears borrow
    env.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall(TIERS_SWITCH_MODEL_TOOL, { model: 'faux/workhorse', restoreAfterTurn: false }, { id: 'sw-perm' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('permanently-switched'),
    ])
    const seq2 = kernel.conversations.getConversation(conv.id).completionSeq
    await kernel.conversations.submitInput(conv.id, 'switch permanently')
    await kernel.conversations.waitForIdle(conv.id)
    assert.ok(kernel.conversations.getConversation(conv.id).completionSeq > seq2)
    assert.equal(kernel.conversations.getConversation(conv.id).model, 'faux/workhorse')
    assert.equal(kernel.conversations.getConversation(conv.id).modelOverride, 'faux/workhorse')
    assert.equal(kernel.plugins.getPublicSessionDoc(TIERS_PLUGIN_ID, TIERS_BORROW_SESSION_DOC, conv.id).value, null)

    // 3. Scope guard: child & helmx-owned conversations reject actions, ignore input.meta, and omit switch_model tool
    const helmxConv = await kernel.conversations.createConversation({ title: 'helmx-owned', ownedBy: 'helmx' })
    const childConv = await kernel.conversations.createConversation({
      title: 'child-conv',
      parentConversationId: conv.id,
      ownedBy: 'helmx',
    })
    for (const ineligible of [helmxConv, childConv]) {
      await assertRejectsCode(
        () =>
          kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set_borrow', {
            conversationId: ineligible.id,
            model: 'faux/flagship',
          }),
        'tiers_borrow_unsupported_conversation',
      )
      const hookInput = await kernel.plugins.runHook('input', {
        conversationId: ineligible.id,
        input: {
          id: 'req-ineligible',
          text: 'ignored',
          origin: 'human',
          meta: { [TIERS_INPUT_META_KEY]: { borrowModel: 'faux/flagship' } },
          createdAt: Date.now(),
        },
      })
      assert.ok(
        hookInput.action === 'continue' || hookInput.action === 'transform',
        'ineligible conversation must ignore borrow input meta (never handled or blocked)',
      )
      assert.equal(
        kernel.conversations.getConversation(ineligible.id).model,
        'faux/workhorse',
        'must not switch model on ineligible conversations',
      )
      const toolsForConv = kernel.plugins.listTools(ineligible)
      assert.equal(
        toolsForConv.some((t) => t.name === TIERS_SWITCH_MODEL_TOOL),
        false,
        'switch_model must not be exposed to child or helmx-owned conversations',
      )
    }

    // 4. pi.reset (/clear) and conversation.deleted clean up borrow state
    const resetTarget = await kernel.conversations.createConversation({ title: 'reset-clean' })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set_borrow', {
      conversationId: resetTarget.id,
      model: 'faux/flagship',
    })
    await kernel.conversations.resetConversation(resetTarget.id)
    await waitFor(async () => {
      const res = (await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'get_borrow', {
        conversationId: resetTarget.id,
      })) as TierBorrowSessionView | null
      return res === null
    })

    const deleteTarget = await kernel.conversations.createConversation({ title: 'delete-clean' })
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set_borrow', {
      conversationId: deleteTarget.id,
      model: 'faux/flagship',
    })
    await kernel.conversations.deleteConversation(deleteTarget.id)
    assert.throws(
      () => kernel.plugins.getPublicSessionDoc(TIERS_PLUGIN_ID, TIERS_BORROW_SESSION_DOC, deleteTarget.id),
      (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
    )
    await assertRejectsCode(
      () => kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'get_borrow', { conversationId: deleteTarget.id }),
      'not_found',
    )
  } finally {
    await env.close()
  }
})

test('reconcile & events: cold restart restores idle active borrow, respects CAS mismatch, drops deleted conversations, and conversation.deleted cleans KV', { timeout: 60_000 }, async () => {
  const { PluginHost } = await import('@helmx/kernel')
  const { createPluginHostBackendFixture } = await import('../../kernel/test/helpers/plugin-host-backend.js')
  const dataDir = await makeTempDir('helmx-tiers-reconcile-')
  const docs = new MemoryDocStore()
  const kv = new MemoryKvStore()
  const kvHandle = kv.handle<TierBorrowRecord>(TIERS_PLUGIN_ID, TIERS_BORROW_KV)
  const now = Date.now()
  // 10: idle with matching appliedModelOverride -> MUST restore to previousModelOverride '' (inherited)
  kvHandle.set('10', {
    conversationId: 10,
    phase: 'active',
    requestedRef: 'faux/flagship',
    targetModel: 'faux/flagship',
    appliedModelOverride: 'faux/flagship',
    targetConcreteModel: 'faux/flagship',
    targetLabel: 'flagship',
    effortChanged: false,
    restoreAfterTurn: true,
    source: 'ui',
    createdAt: now,
    updatedAt: now,
  })
  // 11: idle but user already manually switched to faux/fast -> CAS must skip overwrite and clear record
  kvHandle.set('11', {
    conversationId: 11,
    phase: 'active',
    requestedRef: 'faux/flagship',
    targetModel: 'faux/flagship',
    appliedModelOverride: 'faux/flagship',
    targetConcreteModel: 'faux/flagship',
    targetLabel: 'flagship',
    previousModelOverride: 'faux/workhorse',
    effortChanged: false,
    restoreAfterTurn: true,
    source: 'ui',
    createdAt: now,
    updatedAt: now,
  })
  // 12: armed conversation that will later emit conversation.deleted
  kvHandle.set('12', {
    conversationId: 12,
    phase: 'armed',
    requestedRef: 'faux/flagship',
    targetModel: 'faux/flagship',
    targetConcreteModel: 'faux/flagship',
    targetLabel: 'flagship',
    effortChanged: false,
    restoreAfterTurn: true,
    source: 'ui',
    createdAt: now,
    updatedAt: now,
  })
  // 99: deleted conversation -> drop stale KV record
  kvHandle.set('99', {
    conversationId: 99,
    phase: 'armed',
    requestedRef: 'faux/flagship',
    targetModel: 'faux/flagship',
    targetConcreteModel: 'faux/flagship',
    targetLabel: 'flagship',
    effortChanged: false,
    restoreAfterTurn: true,
    source: 'ui',
    createdAt: now,
    updatedAt: now,
  })

  const convs = new Map([
    [10, makeConversationSummary({ id: 10, status: 'idle', model: 'faux/flagship', modelOverride: 'faux/flagship' })],
    [11, makeConversationSummary({ id: 11, status: 'idle', model: 'faux/fast', modelOverride: 'faux/fast' })],
    [12, makeConversationSummary({ id: 12, status: 'idle', model: 'faux/workhorse' })],
  ])
  const listeners = new Map<string, Array<(payload: unknown) => void | Promise<void>>>()
  const updates: Array<{ id: number; patch: Record<string, unknown> }> = []
  const baseFixture = createPluginHostBackendFixture()
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    docs,
    kv,
    host: {
      ...baseFixture,
      emitEvent: () => {},
      onEvent: (type: string, handler: (payload: unknown) => void | Promise<void>) => {
        const list = listeners.get(type) ?? []
        list.push(handler)
        listeners.set(type, list)
        return () => {
          const cur = listeners.get(type)
          if (cur) listeners.set(type, cur.filter((h) => h !== handler))
        }
      },
      skills: { ...baseFixture.skills, ensureSkill: async () => {} },
      getConversation: (id) => {
        const found = convs.get(id)
        if (!found) throw new HelmxError('not_found', `conversation not found: ${id}`, 404)
        return found
      },
      listConversations: () => [...convs.values()],
      updateConversation: async (id, patch) => {
        updates.push({ id, patch: patch as Record<string, unknown> })
        const cur = convs.get(id)!
        const next = {
          ...cur,
          model: patch.model === '' ? 'faux/workhorse' : (patch.model ?? cur.model),
          modelOverride: patch.model === '' ? undefined : (patch.model ?? cur.modelOverride),
        }
        convs.set(id, next)
        return next
      },
    },
  })
  try {
    await host.register(createTiersPlugin())
    await host.start()
    await host.reconcile()
    assert.deepEqual(updates, [{ id: 10, patch: { model: '' } }], 'only matching idle active borrow should be restored')
    assert.equal(kvHandle.get('10'), undefined)
    assert.equal(kvHandle.get('11'), undefined)
    assert.equal(kvHandle.get('99'), undefined)
    assert.equal(kvHandle.get('12')?.phase, 'armed')
    assert.equal(convs.get(11)?.modelOverride, 'faux/fast', 'CAS-mismatched conversation must keep its model')

    // Emit conversation.deleted for #12 -> must purge KV entry cleanly
    convs.delete(12)
    for (const handler of listeners.get('conversation.deleted') ?? []) {
      await handler({ type: 'conversation.deleted', conversationId: 12 })
    }
    assert.equal(kvHandle.get('12'), undefined, 'conversation.deleted must remove borrow KV entry')
  } finally {
    await host.dispose().catch(() => {})
    await cleanupDir(dataDir)
  }
})

test('borrow manager: listAllKvEntries infinite-loop guard stops when KV returns repeated nextCursor', { timeout: 60_000 }, async () => {
  const { createPluginHostBackendFixture } = await import('../../kernel/test/helpers/plugin-host-backend.js')
  const baseFixture = createPluginHostBackendFixture()
  const record: TierBorrowRecord = {
    conversationId: 77,
    phase: 'armed',
    requestedRef: 'faux/flagship',
    targetModel: 'faux/flagship',
    targetConcreteModel: 'faux/flagship',
    targetLabel: 'flagship',
    effortChanged: false,
    restoreAfterTurn: true,
    source: 'ui',
    createdAt: 1,
    updatedAt: 1,
  }
  let listCalls = 0
  const loopingKv = {
    get: (key: string) => (key === '77' ? record : undefined),
    set: () => {},
    delete: () => false,
    clear: () => {},
    flush: async () => {},
    list: (opts?: { cursor?: string }) => {
      listCalls += 1
      return {
        items: [{ key: '77', value: record, updatedAt: 1 }],
        nextCursor: opts?.cursor === undefined ? 'loop' : 'loop',
      }
    },
  }
  const synced: Array<{ id: number; value: TierBorrowSessionView | null }> = []
  const manager = createTierBorrowManager({
    ctx: {
      host: {
        ...baseFixture,
        getConversation: (id: number) => makeConversationSummary({ id, status: 'idle' }),
      },
    } as never,
    kv: loopingKv,
    borrowDoc: {
      get: () => null,
      set: (id: number, val: TierBorrowSessionView | null) => synced.push({ id, value: val }),
      delete: () => false,
    } as never,
    readTiersState: () => ({ tiers: {}, templates: {} }),
  })
  manager.hydrate()
  assert.equal(listCalls, 2)
  assert.equal(synced.length, 2)
  await manager.reconcile()
  assert.equal(listCalls, 4)
})
