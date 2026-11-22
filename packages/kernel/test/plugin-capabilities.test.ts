/**
 * Typed plugin capability registry (`ctx.provide` / `ctx.consume` + `PluginHost.consumeCapability`)
 * and kernel `ModelRegistry` `'helmx.model-tiers'` capability consumption tests.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { HelmxError, type ModelTiersCapability, type ModelTierSpec } from '@helmx/protocol'
import { PluginHost } from '../src/plugins/index.js'
import { KernelRuntime } from '../src/runtime/runtime.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { MemoryDocStore, cleanupDir, makeTempDir } from './helpers.js'

function makeHost(dataDir: string): PluginHost {
  return new PluginHost({
    dataDir,
    host: {
      ...createPluginHostBackendFixture(),
      emitEvent: () => {},
    },
    docs: new MemoryDocStore(),
  })
}

test('ctx.provide / ctx.consume: typed sharing across plugins, validation, manual release, and auto-release on disable/rollback', { timeout: 60_000 }, async () => {
  const dataDir = await makeTempDir('helmx-cap-basic-')
  const host = makeHost(dataDir)
  try {
    interface Greeter {
      greet(name: string): string
    }

    const changeNotifications: number[] = []
    const unsub = host.onCapabilityChanged('demo.greeter', () => {
      changeNotifications.push(host.consumeCapability<Greeter>('demo.greeter').length)
    })

    let releaseA!: () => void
    await host.register({
      id: 'p:alpha',
      definePlugin(ctx) {
        releaseA = ctx.provide<Greeter>('demo.greeter', { greet: (n) => `hi ${n}` })
      },
    })
    assert.deepEqual(changeNotifications, [1], 'enabling provider notifies capability listeners once')

    await host.register({
      id: 'p:beta',
      definePlugin(ctx) {
        ctx.provide<Greeter>('demo.greeter', { greet: (n) => `hello ${n}` })
      },
    })
    assert.deepEqual(changeNotifications, [1, 2])

    // Consumer plugin observes both active providers in registration order
    let observedFromConsumer: string[] = []
    await host.register({
      id: 'p:consumer',
      definePlugin(ctx) {
        ctx.action({
          id: 'run',
          description: 'run greeters',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          outputSchema: { type: 'object', properties: { out: { type: 'array', items: { type: 'string' } } }, required: ['out'] },
          handler() {
            const items = ctx.consume<Greeter>('demo.greeter')
            observedFromConsumer = items.map((entry) => `${entry.pluginId}:${entry.impl.greet('world')}`)
            return { out: observedFromConsumer }
          },
        })
      },
    })

    const res = (await host.invokeAction('p:consumer', 'run', {})) as { out: string[] }
    assert.deepEqual(res.out, ['p:alpha:hi world', 'p:beta:hello world'])

    // Manual release is idempotent and notifies once
    releaseA()
    releaseA()
    assert.deepEqual(changeNotifications, [1, 2, 1])
    assert.deepEqual(
      host.consumeCapability<Greeter>('demo.greeter').map((e) => e.pluginId),
      ['p:beta'],
    )

    // Disable auto-releases remaining provided capabilities
    await host.disable('p:beta')
    assert.deepEqual(changeNotifications, [1, 2, 1, 0])
    assert.deepEqual(host.consumeCapability<Greeter>('demo.greeter'), [])

    // Re-enable restores capabilities and notifies once
    await host.enable('p:beta')
    assert.deepEqual(changeNotifications, [1, 2, 1, 0, 1])
    assert.deepEqual(
      host.consumeCapability<Greeter>('demo.greeter').map((e) => e.pluginId),
      ['p:beta'],
    )

    // Register with enabled: false leaks zero capabilities and emits zero spurious notifications
    const beforeDisabled = changeNotifications.length
    await host.register(
      {
        id: 'p:disabled',
        definePlugin(ctx) {
          ctx.provide<Greeter>('demo.greeter', { greet: () => 'ghost' })
        },
      },
      { enabled: false },
    )
    assert.equal(changeNotifications.length, beforeDisabled, 'disabled registration must not fire capability changes')
    assert.deepEqual(
      host.consumeCapability<Greeter>('demo.greeter').map((e) => e.pluginId),
      ['p:beta'],
    )

    // Rollback on definePlugin throw leaks zero capabilities and emits zero spurious notifications
    await assert.rejects(
      () =>
        host.register({
          id: 'p:crash',
          definePlugin(ctx) {
            ctx.provide<Greeter>('demo.greeter', { greet: () => 'crash' })
            throw new Error('define boom')
          },
        }),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_registration_failed',
    )
    assert.equal(changeNotifications.length, beforeDisabled)
    assert.deepEqual(
      host.consumeCapability<Greeter>('demo.greeter').map((e) => e.pluginId),
      ['p:beta'],
    )

    unsub()
  } finally {
    await host.dispose().catch(() => {})
    await cleanupDir(dataDir)
  }
})

test('ctx.provide / ctx.consume: strict capabilityId validation, epoch guards, and force-disable dependent hiding', { timeout: 60_000 }, async () => {
  const dataDir = await makeTempDir('helmx-cap-guards-')
  const host = makeHost(dataDir)
  try {
    // Invalid capability IDs rejected on both provide and consume
    const badIds = ['', 'Upper.case', '.leading-dot', '-leading-dash', 'bad:colon', 'bad/slash', 'a'.repeat(65)]
    for (const badId of badIds) {
      assert.throws(
        () => host.consumeCapability(badId),
        (err: unknown) => err instanceof HelmxError && err.code === 'invalid_capability_id' && err.status === 400,
        `consumeCapability must reject ${JSON.stringify(badId)}`,
      )
      await assert.rejects(
        () =>
          host.register({
            id: `p:bad-${badIds.indexOf(badId)}`,
            definePlugin(ctx) {
              ctx.provide(badId, { ok: true })
            },
          }),
        (err: unknown) => err instanceof HelmxError && err.code === 'invalid_capability_id' && err.status === 400,
      )
    }

    // Null/undefined impl rejected explicitly
    await assert.rejects(
      () =>
        host.register({
          id: 'p:null-impl',
          definePlugin(ctx) {
            ctx.provide('demo.valid', null)
          },
        }),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_capability_impl' && err.status === 400,
    )

    // Epoch guard rejects stale provide/consume after disable
    let staleProvide!: <T>(id: string, impl: T) => () => void
    let staleConsume!: <T>(id: string) => ReadonlyArray<{ pluginId: string; impl: T }>
    await host.register({
      id: 'p:epoch',
      definePlugin(ctx) {
        staleProvide = ctx.provide
        staleConsume = ctx.consume
      },
    })
    await host.disable('p:epoch')
    assert.throws(
      () => staleProvide('demo.after-disable', { ok: true }),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_context_expired' && err.status === 409,
    )
    assert.throws(
      () => staleConsume('demo.after-disable'),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_context_expired' && err.status === 409,
    )

    // Force-disabling a dependency transitions dependent to failed and immediately hides its capabilities
    let depEvents = 0
    host.onCapabilityChanged('demo.dep-cap', () => {
      depEvents += 1
    })
    await host.register({ id: 'p:base', definePlugin() {} })
    await host.register({
      id: 'p:dependent',
      dependencies: ['p:base'],
      definePlugin(ctx) {
        ctx.provide('demo.dep-cap', { ok: true })
      },
    })
    assert.equal(host.consumeCapability('demo.dep-cap').length, 1)
    const beforeForce = depEvents
    await host.disable('p:base', { force: true })
    assert.equal(host.consumeCapability('demo.dep-cap').length, 0, 'failed dependent capabilities must vanish immediately')
    assert.ok(depEvents > beforeForce, 'marking dependent broken must notify capability listeners')
  } finally {
    await host.dispose().catch(() => {})
    await cleanupDir(dataDir)
  }
})

test('KernelRuntime ModelRegistry consumes helmx.model-tiers via capability registry (mount, onChanged realign, conflict 409, disable unmount)', { timeout: 60_000 }, async () => {
  const dataDir = await makeTempDir('helmx-cap-tiers-')
  const faux = fauxProvider({
    provider: 'faux-cap',
    models: [
      { id: 'fast', name: 'Fast', reasoning: true },
      { id: 'smart', name: 'Smart', reasoning: true },
    ],
  })
  const kernel = await KernelRuntime.open({
    dataDir,
    cwd: dataDir,
    model: 'faux-cap/fast',
    providers: [faux.provider],
  })
  try {
    let currentTiers: Record<string, ModelTierSpec> = {
      worker: { model: 'faux-cap/fast', thinkingLevel: 'low', description: 'Fast worker' },
    }
    const listeners = new Set<() => Promise<void> | void>()
    const notify = async () => {
      for (const listener of [...listeners]) await listener()
    }

    await kernel.plugins.register({
      id: 'test:tiers-provider',
      definePlugin(ctx) {
        ctx.provide<ModelTiersCapability>('helmx.model-tiers', {
          getTiers: () => currentTiers,
          onChanged: (listener) => {
            listeners.add(listener)
            return () => {
              listeners.delete(listener)
            }
          },
        })
      },
    })

    // 1. ModelCatalog reflects provided tier and Profile inheritance resolves it
    const catalog = await kernel.listModels()
    assert.deepEqual(
      catalog.modelTiers?.map((t) => ({ id: t.id, model: t.model, thinkingLevel: t.thinkingLevel })),
      [{ id: 'worker', model: 'faux-cap/fast', thinkingLevel: 'low' }],
    )
    const profile = await kernel.profiles.get('assistant')
    assert.ok(profile)
    await kernel.profiles.save({ ...profile, model: 'tier/worker' })
    const inherited = await kernel.createConversation({ title: 'inherits-tier' })
    assert.equal(inherited.model, 'faux-cap/fast')
    assert.equal(inherited.thinkingLevel, 'low')

    // 2. Mutating tiers + invoking onChanged re-aligns inheriting conversation automatically
    currentTiers = {
      worker: { model: 'faux-cap/smart', thinkingLevel: 'high', description: 'Upgraded worker' },
    }
    await notify()
    assert.equal(kernel.getConversation(inherited.id).model, 'faux-cap/smart')
    assert.equal(kernel.getConversation(inherited.id).thinkingLevel, 'high')

    // 3. Conflicting tier ID from a second active plugin raises 409 model_tier_conflict
    await kernel.plugins.register({
      id: 'test:tiers-conflict',
      definePlugin(ctx) {
        ctx.provide<ModelTiersCapability>('helmx.model-tiers', {
          getTiers: () => ({
            worker: { model: 'faux-cap/fast' },
          }),
        })
      },
    })
    await assert.rejects(
      () => kernel.listModels(),
      (err: unknown) => err instanceof HelmxError && err.code === 'model_tier_conflict' && err.status === 409,
    )
    await kernel.plugins.disable('test:tiers-conflict')

    // 4. Disabling provider unmounts tiers cleanly and detaches onChanged subscription
    await kernel.plugins.disable('test:tiers-provider')
    assert.equal(listeners.size, 0, 'ModelRegistry must unsubscribe onChanged when provider disables')
    const afterDisable = await kernel.listModels()
    assert.equal(afterDisable.modelTiers, undefined)
  } finally {
    await kernel.close().catch(() => {})
    await cleanupDir(dataDir)
  }
})
