/**
 * Plugin dependency contract and lifecycle tests:
 * - dependency declaration boundary (shape/dedupe/self-dependency) and summary projection (PluginSummary.dependencies);
 * - dependency satisfaction check on enable / eager-enabled register (missing -> plugin_dependency_missing,
 *   disabled -> plugin_dependency_not_enabled; registered-but-disabled dependency never satisfies);
 * - explicit cycle rejection in dependency graph (plugin_dependency_cycle) instead of hanging;
 * - global service startup barrier runs prepare/start in topological dependency order and stop in reverse
 *   topological order, preserving registration order within each layer;
 * - dependency protection: non-forced disable/unregister is blocked by plugin_in_use (including transitive
 *   dependents); forced disable explicitly flags dependents (status=failed + plugin.changed) rather than
 *   silently leaving corrupted state;
 * - concurrent register/enable operations serialize without deadlocks (all promises settle).
 *
 * Runner: tsx --test; every test specifies timeout: 60_000 against deadlocks.
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HelmxError, type PluginDefinition, type PluginSummary, type PluginUiContribution } from '@helmx/protocol'
import {
  PluginHost,
  type PluginHostBackend,
} from '../src/plugins/index.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { MemoryDocStore, assertRejectsCode, cleanupDir, makeTempDir } from './helpers.js'

// ---------------------------------------------------------------------------
// Test fixture setup
// ---------------------------------------------------------------------------

let dataDir: string
let docs: MemoryDocStore
let events: Array<{ type: string; payload: unknown }>

function makeBackend(): PluginHostBackend {
  return {
    ...createPluginHostBackendFixture(),
    emitEvent: (type, payload) => {
      events.push({ type, payload })
    },
  }
}

function makeHost(options: { deferServices?: boolean } = {}): PluginHost {
  return new PluginHost({ buildProvider: createPluginBuildProvider(),
    dataDir,
    host: makeBackend(),
    docs,
    ...(options.deferServices !== undefined ? { deferServices: options.deferServices } : {}),
  })
}

function def(id: string, dependencies?: string[], define?: PluginDefinition['definePlugin']): PluginDefinition {
  return {
    id,
    ...(dependencies !== undefined && dependencies.length > 0 ? { dependencies } : {}),
    definePlugin: define ?? (() => {}),
  }
}

beforeEach(async () => {
  dataDir = await makeTempDir('helmx-plugin-deps-')
  docs = new MemoryDocStore()
  events = []
})

afterEach(async () => {
  await cleanupDir(dataDir)
})

// ---------------------------------------------------------------------------
// Declaration boundary and summary projection
// ---------------------------------------------------------------------------

test('dependency declaration: rejects invalid shapes, deduplicates entries, and exposes dependencies in summary', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await assertRejectsCode(() => host.register(def('bad', ['ok-id', 'bad@^1.0'])), 'invalid_plugin_definition', 400)
  await assertRejectsCode(() => host.register(def('bad2', ['x', 42 as unknown as string])), 'invalid_plugin_definition', 400)
  await assertRejectsCode(() => host.register(def('bad3', 'nope' as unknown as string[])), 'invalid_plugin_definition', 400)

  await host.register(def('dep-base'))
  await host.register(def('user', ['dep-base', 'dep-base']))
  const summary = host.get('user')
  assert.ok(summary)
  assert.deepEqual(summary.dependencies, ['dep-base'])

  const plain = host.get('dep-base')
  assert.ok(plain)
  assert.equal(plain.dependencies, undefined, 'summary omits empty array when no dependencies are declared')
})

test('self-dependency and two-plugin cycle reject explicitly at registration with plugin_dependency_cycle', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await assertRejectsCode(() => host.register(def('self', ['self'])), 'plugin_dependency_cycle', 409)

  // Register b first (depends on unregistered a -- allowed while disabled; checked on enable), then register a -> b creating cycle.
  await host.register(def('b', ['a']), { enabled: false })
  const err = (await assertRejectsCode(() => host.register(def('a', ['b'])), 'plugin_dependency_cycle', 409)) as HelmxError
  assert.deepEqual((err.details as { cycle: string[] }).cycle, ['a', 'b', 'a'])
  assert.equal(host.list().some((s) => s.id === 'a'), false, 'cyclic plugin never enters registry')
})

// ---------------------------------------------------------------------------
// Enable dependency checks
// ---------------------------------------------------------------------------

test('enable dependency validation: missing / registered-only disabled / succeeds once dependency enabled', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(def('user', ['missing-dep']), { enabled: false })
  await host.register(def('user2', ['disabled-dep']), { enabled: false })
  await host.register(def('user3', ['enabled-dep']), { enabled: false })

  const missingErr = (await assertRejectsCode(() => host.enable('user'), 'plugin_dependency_missing', 409)) as HelmxError
  assert.equal((missingErr.details as { dependency: string }).dependency, 'missing-dep')

  await host.register(def('disabled-dep'), { enabled: false })
  const notEnabledErr = (await assertRejectsCode(() => host.enable('user2'), 'plugin_dependency_not_enabled', 409)) as HelmxError
  assert.equal((notEnabledErr.details as { dependency: string }).dependency, 'disabled-dep')
  assert.equal(host.get('user2')?.enabled, false, 'failed enable leaves plugin disabled')

  await host.register(def('enabled-dep'), { enabled: true })
  await host.enable('user3')
  assert.equal(host.get('user3')?.enabled, true)
  assert.equal(host.get('user3')?.status, 'active')
})

test('eager-enabled register also validates dependencies; recovers once dependency is registered', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await assertRejectsCode(() => host.register(def('eager', ['not-there']), { enabled: true }), 'plugin_dependency_missing', 409)
  assert.equal(host.list().some((s) => s.id === 'eager'), false)

  const host2 = makeHost()
  await host2.register(def('late-dep'), { enabled: true })
  await host2.register(def('eager', ['late-dep']), { enabled: true })
  assert.equal(host2.get('eager')?.enabled, true)
  await host2.dispose()
})

// ---------------------------------------------------------------------------
// Topological startup / shutdown
// ---------------------------------------------------------------------------

test('global startup barrier prepares/starts in dependency order and stops in reverse order, keeping registration order within layers', { timeout: 60_000 }, async () => {
  const order: string[] = []
  const svc = (label: string) => ({
    id: `svc-${label}`,
    async prepare() {
      order.push(`prepare:${label}`)
    },
    async start() {
      order.push(`start:${label}`)
    },
    async stop() {
      order.push(`stop:${label}`)
    },
  })
  const host = makeHost({ deferServices: true })
  // Registration order: first, mid, last (last -> mid -> first dependency chain)
  await host.register({
    id: 'first',
    definePlugin: (ctx) => {
      ctx.service(svc('first'))
    },
  })
  await host.register({
    id: 'mid',
    dependencies: ['first'],
    definePlugin: (ctx) => {
      ctx.service(svc('mid'))
    },
  })
  await host.register({
    id: 'independent-a',
    definePlugin: (ctx) => {
      ctx.service(svc('ia'))
    },
  })
  await host.register({
    id: 'independent-b',
    definePlugin: (ctx) => {
      ctx.service(svc('ib'))
    },
  })
  await host.register({
    id: 'last',
    dependencies: ['mid'],
    definePlugin: (ctx) => {
      ctx.service(svc('last'))
    },
  })
  await host.start()

  const prepareIdx = (label: string) => order.indexOf(`prepare:${label}`)
  const startIdx = (label: string) => order.indexOf(`start:${label}`)
  // Barrier semantics preserved: all prepare() calls precede all start() calls.
  assert.ok(order.slice(0, 5).every((e) => e.startsWith('prepare:')))
  // Dependency topology: dependencies prepare/start before dependents.
  assert.ok(prepareIdx('first') < prepareIdx('mid') && prepareIdx('mid') < prepareIdx('last'))
  assert.ok(startIdx('first') < startIdx('mid') && startIdx('mid') < startIdx('last'))
  // Within the same layer (no dependency relation), preserve registration order.
  assert.ok(prepareIdx('ia') < prepareIdx('ib'))

  await host.stop()
  const stops = order.filter((e) => e.startsWith('stop:')).map((e) => e.slice(5))
  // Reverse of topological order [first, ia, ib, mid, last]: dependents stop first.
  assert.deepEqual(stops, ['last', 'mid', 'ib', 'ia', 'first'])
  await host.dispose()
})

test('hot enable: enabling directly while dependencies are already active runs prepare+start immediately', { timeout: 60_000 }, async () => {
  const order: string[] = []
  const host = makeHost()
  await host.register({
    id: 'base',
    definePlugin: (ctx) => {
      ctx.service({ id: 's', async start() { order.push('base-start') }, async stop() {} })
    },
  })
  await host.register({
    id: 'top',
    dependencies: ['base'],
    definePlugin: (ctx) => {
      ctx.service({ id: 's', async start() { order.push('top-start') }, async stop() {} })
    },
  })
  await host.enable('top')
  assert.deepEqual(order, ['base-start', 'top-start'])
  await host.dispose()
})

// ---------------------------------------------------------------------------
// Dependency protection
// ---------------------------------------------------------------------------

test('non-forced disable while depended upon is blocked by plugin_in_use (including transitive dependents)', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(def('base'), { enabled: true })
  await host.register(def('mid', ['base']), { enabled: true })
  await host.register(def('top', ['mid']), { enabled: true })

  const err = (await assertRejectsCode(() => host.disable('base'), 'plugin_in_use', 409)) as HelmxError
  const usages = (err.details as { usages: Array<{ kind: string; id: string }> }).usages
  assert.deepEqual(
    usages.map((u) => u.id).sort(),
    ['mid', 'top'],
    'both direct and transitive dependents appear in usages list',
  )
  assert.ok(usages.every((u) => u.kind === 'plugin_dependency'))
  assert.equal(host.get('base')?.enabled, true)
  await host.dispose()
})

test('forced disable succeeds and explicitly marks dependents (status=failed + plugin.changed) without silent errors', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(def('base'), { enabled: true })
  await host.register(def('user', ['base']), { enabled: true })
  events.length = 0
  await host.disable('base', { force: true })

  assert.equal(host.get('base')?.enabled, false)
  const user = host.get('user')
  assert.ok(user)
  assert.equal(user.enabled, true, 'force applies only to target plugin rather than auto-disabling dependents')
  assert.equal(user.status, 'failed', 'unsatisfied dependency becomes explicitly visible')
  assert.equal(user.error?.code, 'plugin_dependency_not_enabled')
  assert.ok(
    events.some(
      (e) =>
        e.type === 'plugin.changed' &&
        (e.payload as { plugin?: { id: string } }).plugin?.id === 'user',
    ),
    'dependent state transition is broadcast',
  )

  // Recovery path: disable dependent -> enable base -> re-enable dependent succeeds and clears error.
  await host.disable('user')
  await host.enable('base')
  await host.enable('user')
  const recovered = host.get('user')
  assert.ok(recovered)
  assert.equal(recovered.status, 'active')
  assert.equal(recovered.error, undefined)

  // Dependents left in failed state after forced disable still block unregistering base until disabled.
  await host.disable('base', { force: true })
  await assertRejectsCode(() => host.unregister('base'), 'plugin_in_use', 409)
  await host.disable('user')
  await host.unregister('base')
  await host.dispose()
})

test('failed-while-enabled dependent clears clientHashes, ui, capabilities, and public docs until recovered', { timeout: 60_000 }, async () => {
  const clientRoot = join(dataDir, 'dep-client')
  mkdirSync(clientRoot, { recursive: true })
  writeFileSync(join(clientRoot, 'index.tsx'), 'export function DepScreen() { return "dep-ok"; }\n')

  const configs = new Map<string, Record<string, unknown>>()
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    host: makeBackend(),
    docs,
    config: {
      get: (pluginId) => ({ ...(configs.get(pluginId) ?? {}) }),
      set: (pluginId, value) => {
        configs.set(pluginId, { ...value })
      },
    },
  })

  await host.register(def('base'), { enabled: true })
  await host.register({
    id: 'user',
    dependencies: ['base'],
    clientRoot,
    definePlugin: (ctx) => {
      ctx.configSchema({ refreshMs: { type: 'number', default: 1_000 } })
      ctx.doc('state', { ok: true }, { public: true })
      ctx.ui.screen({ id: 'main', label: 'Dep Main', client: { module: 'index.tsx', export: 'DepScreen' } })
      ctx.action({
        id: 'ping',
        description: 'ping dep',
        inputSchema: { type: 'object', additionalProperties: false },
        outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
        handler: () => ({ ok: true }),
      })
      ctx.tool({
        name: 'dep_tool',
        description: 'dep tool',
        inputSchema: { type: 'object', additionalProperties: false },
        execute: () => ({ content: [{ type: 'text', text: 'ok' }] }),
      })
      ctx.route({ method: 'GET', path: '/health', handler: () => new Response('ok') })
      ctx.hook.onInput(() => ({ action: 'continue' }))
    },
  }, { enabled: true })

  // Pre-check: active dependent exposes clientHashes, ui, tools, actions, hooks, routes, public docs, and client bundle.
  const activeSummary = host.get('user')!
  assert.equal(activeSummary.status, 'active')
  assert.ok(activeSummary.clientHashes?.['index.tsx'])
  assert.deepEqual(activeSummary.hooks, ['input'])
  assert.deepEqual(activeSummary.actions, ['ping'])
  assert.deepEqual(activeSummary.tools, ['dep_tool'])
  assert.equal(host.listUi().filter((u) => u.pluginId === 'user').length, 1)
  assert.equal(host.listTools().filter((t) => t.sourcePluginId === 'user').length, 1)
  assert.equal(host.listActions().filter((a) => a.pluginId === 'user').length, 1)
  assert.equal(host.listRoutes().filter((r) => r.pluginId === 'user').length, 1)
  assert.equal(host.listPublicDocs().filter((d) => d.pluginId === 'user').length, 1)
  assert.deepEqual(host.getPublicDoc('user', 'state').value, { ok: true })
  assert.ok((await host.getClientModule('user', 'index.tsx')).contentHash)

  // Force-disable base -> dependent stays enabled=true but status=failed (must never expose clientHashes or executable UI/capabilities).
  events.length = 0
  await host.disable('base', { force: true })

  const failedGet = host.get('user')!
  const failedList = host.list().find((p) => p.id === 'user')!
  const failedChanged = events
    .filter((e) => e.type === 'plugin.changed')
    .map((e) => e.payload as { plugin: PluginSummary; ui: PluginUiContribution[] })
    .find((e) => e.plugin.id === 'user')!
  assert.ok(failedChanged, 'markDependentsBroken must emit plugin.changed for dependent')

  for (const summary of [failedGet, failedList, failedChanged.plugin]) {
    assert.equal(summary.enabled, true)
    assert.equal(summary.status, 'failed')
    assert.equal(summary.error?.code, 'plugin_dependency_not_enabled')
    assert.equal(summary.clientHashes, undefined, 'failed plugin summary must not carry clientHashes')
    assert.deepEqual(summary.hooks, [])
    assert.deepEqual(summary.actions, [])
    assert.deepEqual(summary.tools, [])
    assert.deepEqual(summary.publicConfig, { refreshMs: 1_000 })
  }
  assert.deepEqual(failedChanged.ui, [], 'plugin.changed for failed plugin must emit ui: []')
  assert.deepEqual(host.listUi().filter((u) => u.pluginId === 'user'), [])
  assert.deepEqual(host.listTools().filter((t) => t.sourcePluginId === 'user'), [])
  assert.deepEqual(host.listActions().filter((a) => a.pluginId === 'user'), [])
  assert.deepEqual(host.listRoutes().filter((r) => r.pluginId === 'user'), [])
  assert.deepEqual(host.listPublicDocs().filter((d) => d.pluginId === 'user'), [])
  await assertRejectsCode(() => Promise.resolve().then(() => host.getPublicDoc('user', 'state')), 'plugin_doc_not_found', 404)
  await assertRejectsCode(() => host.getClientModule('user', 'index.tsx'), 'plugin_client_unavailable', 409)
  await assertRejectsCode(() => host.invokeAction('user', 'ping', {}), 'plugin_disabled', 409)
  await assertRejectsCode(() => Promise.resolve().then(() => host.prepareAction('user', 'ping', {})), 'plugin_disabled', 409)
  await assertRejectsCode(() => host.executeTool('dep_tool', {}, { conversationId: 1 }), 'plugin_disabled', 409)

  // Manifest projection obeys the same active predicate: enabled=true, status=failed exposes zero runtime capabilities/hashes.
  const failedManifest = host.getManifest('user')
  assert.equal(failedManifest.enabled, true)
  assert.equal(failedManifest.status, 'failed')
  assert.equal(failedManifest.error?.code, 'plugin_dependency_not_enabled')
  assert.deepEqual(failedManifest.dependencies, ['base'])
  assert.deepEqual(failedManifest.hooks, [])
  assert.deepEqual(failedManifest.actions, [])
  assert.deepEqual(failedManifest.tools, [])
  assert.deepEqual(failedManifest.ui, [])
  assert.deepEqual(failedManifest.routes, [])
  assert.deepEqual(failedManifest.docs, [])
  assert.deepEqual(failedManifest.providers, [])
  assert.deepEqual(failedManifest.services, [])
  assert.deepEqual(failedManifest.clientModules, [])
  assert.deepEqual(failedManifest.configFields.map((f) => f.key), ['refreshMs'])

  // Updating config while failed still emits failed summary without clientHashes or ui.
  events.length = 0
  await host.setConfig('user', { refreshMs: 2_500 })
  const cfgChanged = events
    .filter((e) => e.type === 'plugin.changed')
    .map((e) => e.payload as { plugin: PluginSummary; ui: PluginUiContribution[] })
    .at(-1)!
  assert.equal(cfgChanged.plugin.id, 'user')
  assert.equal(cfgChanged.plugin.status, 'failed')
  assert.equal(cfgChanged.plugin.clientHashes, undefined)
  assert.deepEqual(cfgChanged.plugin.publicConfig, { refreshMs: 2_500 })
  assert.deepEqual(cfgChanged.ui, [])

  // Recovery: disable dependent -> enable base -> re-enable dependent restores active capabilities and clientHashes.
  await host.disable('user')
  await host.enable('base')
  await host.enable('user')
  const recovered = host.get('user')!
  assert.equal(recovered.status, 'active')
  assert.equal(recovered.error, undefined)
  assert.ok(recovered.clientHashes?.['index.tsx'])
  assert.deepEqual(recovered.hooks, ['input'])
  assert.deepEqual(recovered.actions, ['ping'])
  assert.deepEqual(recovered.tools, ['dep_tool'])
  assert.equal(host.listUi().filter((u) => u.pluginId === 'user').length, 1)
  assert.equal(host.listPublicDocs().filter((d) => d.pluginId === 'user').length, 1)
  assert.ok((await host.getClientModule('user', 'index.tsx')).contentHash)

  await host.dispose()
})

test('unregister while depended upon rejects when dependent is enabled; succeeds once dependent is disabled', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register(def('base'), { enabled: true })
  await host.register(def('user', ['base']), { enabled: true })
  await assertRejectsCode(() => host.unregister('base'), 'plugin_in_use', 409)

  await host.disable('user')
  await host.unregister('base')
  assert.equal(host.get('base'), undefined)
  // After base is removed, enabling user fails explicitly due to missing dependency.
  await assertRejectsCode(() => host.enable('user'), 'plugin_dependency_missing', 409)
  await host.dispose()
})

// ---------------------------------------------------------------------------
// Concurrency without deadlock
// ---------------------------------------------------------------------------

test('concurrent mixed register/enable/disable operations settle cleanly without deadlocks', { timeout: 60_000 }, async () => {
  const host = makeHost()
  const ops: Array<Promise<unknown>> = []
  for (let i = 0; i < 6; i++) {
    ops.push(host.register(def(`p${i}`, [`p${(i + 1) % 6}`]), { enabled: false }))
  }
  // 6 plugins connected head-to-tail in a cycle: whichever completes the cycle rejects rather than hanging.
  const results = await Promise.allSettled(ops)
  const rejected = results.filter((r) => r.status === 'rejected').length
  assert.ok(rejected >= 1, 'cyclic registration must reject explicitly')
  assert.equal(results.length, 6)

  const host2 = makeHost()
  await host2.register(def('a0'), { enabled: false })
  await host2.register(def('b0', ['a0']), { enabled: false })
  await host2.register(def('c0', ['b0']), { enabled: false })
  // Concurrent enable chain racing with disable: partial failures allowed (unready dependency / in-use), all must settle.
  const settled = await Promise.allSettled([
    host2.enable('a0'),
    host2.enable('b0'),
    host2.enable('c0'),
    host2.disable('a0'),
  ])
  assert.equal(settled.length, 4)
  await host.dispose()
  await host2.dispose()
})

// ---------------------------------------------------------------------------
// Explicit reconcile lifecycle phase & topological ordering (hard + soft edges)
// ---------------------------------------------------------------------------

test('reconcile phase runs in topological order (hard dependencies + soft reconcileAfter) independent of registration order', { timeout: 60_000 }, async () => {
  const order: string[] = []
  const host = makeHost({ deferServices: true })

  // Register consumer ('worktree-like') BEFORE peer ('workflow-like') — soft reconcileAfter must still order peer first.
  await host.register({
    id: 'peer:consumer',
    definePlugin: (ctx) => {
      ctx.service({
        id: 'consumer-svc',
        prepare() { order.push('prepare:consumer') },
        start() { order.push('start:consumer') },
        reconcileAfter: ['peer:provider', 'peer:absent', 'peer:disabled'],
        async reconcile() {
          order.push('reconcile:consumer')
        },
        stop() { order.push('stop:consumer') },
      })
    },
  })
  await host.register({
    id: 'peer:disabled',
    definePlugin: (ctx) => {
      ctx.configSchema({
        mode: { type: 'string', enum: ['a', 'b'], default: 'a' },
      })
      ctx.service({
        id: 'disabled-svc',
        start() { order.push('start:disabled') },
        reconcile() { order.push('reconcile:disabled') },
        stop() {},
      })
    },
  }, { enabled: false })
  await host.register({
    id: 'peer:provider',
    definePlugin: (ctx) => {
      ctx.service({
        id: 'provider-svc',
        prepare() { order.push('prepare:provider') },
        start() { order.push('start:provider') },
        async reconcile() {
          order.push('reconcile:provider')
        },
        stop() { order.push('stop:provider') },
      })
    },
  })
  await host.register({
    id: 'peer:dependent',
    dependencies: ['peer:consumer'],
    definePlugin: (ctx) => {
      ctx.service({
        id: 'dependent-svc',
        prepare() { order.push('prepare:dependent') },
        start() { order.push('start:dependent') },
        reconcile() { order.push('reconcile:dependent') },
        stop() { order.push('stop:dependent') },
      })
    },
  })

  // Calling reconcile before start must fail explicitly.
  await assertRejectsCode(() => host.reconcile(), 'plugin_host_not_started', 409)

  await host.start()
  await host.reconcile()
  // Second reconcile call is an idempotent no-op.
  await host.reconcile()

  assert.deepEqual(order, [
    'prepare:consumer',
    'prepare:provider',
    'prepare:dependent',
    'start:consumer',
    'start:provider',
    'start:dependent',
    'reconcile:provider',
    'reconcile:consumer',
    'reconcile:dependent',
  ])

  // Disabled plugin retains its configSchema and manifest configFields projection across reconcile.
  assert.deepEqual(host.getConfigSchema('peer:disabled'), {
    mode: { type: 'string', enum: ['a', 'b'], default: 'a' },
  })
  assert.deepEqual(host.getManifest('peer:disabled').configFields, [
    { key: 'mode', type: 'string', secret: false, required: false, enum: ['a', 'b'], default: 'a' },
  ])

  // Soft reconcileAfter creates ZERO hard coupling: disabling peer:provider is NOT blocked by peer:consumer.
  await host.disable('peer:provider')
  assert.equal(host.get('peer:provider')?.enabled, false)
  assert.equal(host.get('peer:consumer')?.enabled, true)
  assert.equal(host.get('peer:consumer')?.status, 'active')

  // Stop -> start -> reconcile resets reconciled state and runs again cleanly.
  order.length = 0
  await host.stop()
  await host.start()
  await host.reconcile()
  assert.deepEqual(order, [
    'stop:dependent',
    'stop:consumer',
    'start:consumer',
    'start:dependent',
    'reconcile:consumer',
    'reconcile:dependent',
  ])

  // Hot-enabling after reconcile runs prepare -> start -> reconcile immediately.
  order.length = 0
  await host.enable('peer:disabled')
  assert.deepEqual(order, ['start:disabled', 'reconcile:disabled'])

  await host.dispose()
})

test('reconcile validates service specs, rejects cycles explicitly, and isolates external reconcile failures', { timeout: 60_000 }, async () => {
  const host = makeHost({ deferServices: true })

  // Invalid reconcile / reconcileAfter declarations fail at registration boundary.
  await assertRejectsCode(
    () =>
      host.register({
        id: 'bad:reconcile-fn',
        definePlugin: (ctx) => {
          ctx.service({ id: 's', start() {}, stop() {}, reconcile: 'nope' as unknown as () => void })
        },
      }),
    'invalid_service_spec',
    400,
  )
  await assertRejectsCode(
    () =>
      host.register({
        id: 'bad:reconcile-after',
        definePlugin: (ctx) => {
          ctx.service({ id: 's', start() {}, stop() {}, reconcileAfter: ['bad@^1'] })
        },
      }),
    'invalid_service_spec',
    400,
  )
  await assertRejectsCode(
    () =>
      host.register({
        id: 'bad:self-reconcile',
        definePlugin: (ctx) => {
          ctx.service({ id: 's', start() {}, stop() {}, reconcileAfter: ['bad:self-reconcile'] })
        },
      }),
    'plugin_dependency_cycle',
    409,
  )

  // Cross-plugin reconcileAfter cycle fails explicitly at reconcile time with plugin_dependency_cycle.
  const cycHost = makeHost({ deferServices: true })
  await cycHost.register({
    id: 'cyc:a',
    definePlugin: (ctx) => {
      ctx.service({ id: 's', start() {}, stop() {}, reconcileAfter: ['cyc:b'], reconcile() {} })
    },
  })
  await cycHost.register({
    id: 'cyc:b',
    definePlugin: (ctx) => {
      ctx.service({ id: 's', start() {}, stop() {}, reconcileAfter: ['cyc:a'], reconcile() {} })
    },
  })
  await cycHost.start()
  await assertRejectsCode(() => cycHost.reconcile(), 'plugin_dependency_cycle', 409)
  await cycHost.dispose()

  // External isolated plugin failing during reconcile transitions to failed without blocking built-in reconcile.
  const ran: string[] = []
  await host.register(
    {
      id: 'ext:bad-reconcile',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'ext-svc',
          start() {},
          stop() {},
          reconcile() {
            throw new Error('external reconcile boom')
          },
        })
      },
    },
    { isolateFailure: true },
  )
  await host.register({
    id: 'builtin:good-reconcile',
    definePlugin: (ctx) => {
      ctx.service({
        id: 'good-svc',
        start() {},
        stop() {},
        reconcile() {
          ran.push('good')
        },
      })
    },
  })
  await host.start()
  await host.reconcile()
  assert.deepEqual(ran, ['good'])
  const failedExt = host.get('ext:bad-reconcile')
  assert.equal(failedExt?.status, 'failed')
  assert.equal(failedExt?.error?.code, 'plugin_service_reconcile_failed')

  await host.dispose()
})
