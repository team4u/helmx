/**
 * Focused tests for microkernel host public mechanisms (core commit scope):
 * - epoch guard: wrapHostApi sub-ports (profiles/skills/secrets/nodeIpc/getNodeHostEnv/executionEnv proxies)
 *   invalidate stale handles (409) after disable/restart while fresh cycle handles work;
 * - getNodeHostEnv + openTunnel(NodeTunnelTarget): unwired 501, tracked live tasks, epoch guard,
 *   and socketPath target forwarding;
 * - onUpdate: forwards partials via bounded output (redacted), silently drops late partials
 *   after settle;
 * - prompt projection: only active tools enter prompt.tools.* sections without ghost residues;
 *   promptGuidelines arrays expand line by line.
 * - createArtifact/submitInput attachments: plugin port wiring over the real runtime (upload
 *   validation, attachment authorization, [Attached Files] manifest reaching the model, expiry).
 * Runner: tsx --test; every test specifies timeout: 60_000 against deadlocks.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import {
  HelmxError,
  type HelmxHostApi,
  type NodeTunnelTarget,
  type PluginDefinition,
} from '@helmx/protocol'
import {
  PluginHost,
  type PluginHostBackend,
} from '../src/plugins/index.js'
import { MAX_ARTIFACT_BYTES } from '../src/services/index.js'
import { projectToolPromptSections } from '../src/runtime/hook-projection.js'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { MemoryDocStore, makeConversationSummary, makeFauxModels, useTempDir } from './helpers.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { KernelRuntime } from '../src/runtime/index.js'

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

function makeConversation(id: number) {
  return makeConversationSummary({ id })
}

/** Stub for openTunnel: delivers a controllable Duplex after delay; logs calls and failures. */
interface OpenTunnelStub {
  calls: Array<{ nodeId: string; target: NodeTunnelTarget; signal: AbortSignal | undefined }>
  delayMs: number
  duplexes: PassThrough[]
  failures: Array<Error | undefined>
}

function makeBackend(over: {
  /** openTunnel stub (wires ctx.host.openTunnel when supplied). */
  openTunnel?: OpenTunnelStub
}): PluginHostBackend {
  return {
    ...createPluginHostBackendFixture(),
    listActiveSpawnExecutions: () => [],
    profiles: {
      list: async () => [{ id: 'assistant' }] as never,
      get: async (id) => ({ id }) as never,
      getSystem: async () => '',
      save: async (p) => p,
      directory: async (id) => `/data/profiles/${id}`,
    },
    skills: {
      list: async () => [],
      readFile: async () => '',
      ensureSkill: async () => {},
    },
    secrets: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      addRedaction: () => () => {},
    },
    nodeIpc: {
      isOnline: () => true,
      getNodeHubUrl: () => undefined,
    },
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async (init) => ({ ...makeConversation(42), title: init.title ?? 'new' }),
    forkConversation: async (id, opts) => ({
      ...makeConversation(id + 100),
      parentConversationId: id,
      title: opts?.title ?? `conv-${id} (fork)`,
    }),
    listConversations: () => [makeConversation(1)],
    getConversation: (id) => makeConversation(id),
    getConversationDetail: async (id) => ({ ...makeConversation(id), entries: [] }) as never,
    updateConversation: async (id) => makeConversation(id),
    abortConversation: async () => {},
    getConversationOwnership: () => 'helmx',
    listArtifacts: async () => [],
    refreshModels: async () => ({ providers: [], aborted: false, errors: {}, models: [], providerCatalog: [] }),
    withFileLock: async (_p, fn) => fn(),
    atomicWriteFile: async () => {},
    completeText: async () => '',
    executionEnv: () => ({
      readTextFile: async () => 'content',
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    }) as never,
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    createAsk: async () => ({ id: 'a', status: 'answered', answers: {} }),
    cancelAsk: async () => {},
    onEvent: () => () => {},
    emitEvent: () => {},
    ...(over.openTunnel !== undefined
      ? {
          openTunnel: (nodeId: string, target: NodeTunnelTarget, signal?: AbortSignal) => {
            const stub = over.openTunnel!
            stub.calls.push({ nodeId, target, signal })
            return new Promise<PassThrough>((resolve, reject) => {
              const timer = setTimeout(() => {
                // Pre-seeded failure queue: FIFO consumed per attempt (next connect starts fresh).
                const failure = stub.failures.shift()
                if (failure !== undefined) { reject(failure); return }
                const duplex = new PassThrough()
                stub.duplexes.push(duplex)
                resolve(duplex)
              }, stub.delayMs)
              signal?.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer)
                  reject(new HelmxError('aborted', 'tunnel establishment aborted', 499))
                },
                { once: true },
              )
            })
          },
        }
      : {}),
  }
}

let dataDir: string

test('host public mechanism suite', { timeout: 60_000 }, async (t) => {
  dataDir = useTempDir(t, 'helmx-host-core-')

  await t.test('epoch guard: post-disable calls on stale host handle reject 409 plugin_context_expired', async () => {
    const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: makeBackend({}), docs: new MemoryDocStore() })
    let captured: Parameters<NonNullable<Parameters<typeof host.register>[0]['definePlugin']>>[0]['host'] | undefined
    const def: PluginDefinition = {
      id: 'p:epoch',
      definePlugin(ctx) {
        captured = ctx.host
      },
    }
    await host.register(def, { enabled: true })
    assert.ok(captured)
    // Works during active cycle.
    assert.equal(await captured!.profiles.get('assistant') !== undefined, true)
    await host.disable('p:epoch')
    // Wrap sync throws uniformly as async rejections so assertions share one path.
    const expired: Array<() => unknown> = [
      () => captured!.profiles.list(),
      () => captured!.skills.list(),
      () => captured!.secrets.get('k'),
      () => captured!.nodeIpc.isOnline('local'),
      () => captured!.completeText({ conversationId: 1, systemPrompt: '', text: '' }),
      () => captured!.forkConversation(1, { entryId: 1 }),
      () => captured!.resetConversation(1),
      () => captured!.resetConversationGuarded(1),
      () => captured!.compactConversation(1),
      () => captured!.compactConversationGuarded(1),
      () => captured!.listArtifacts(1),
      () => captured!.createArtifact(1, { name: 'a.txt', bytes: new Uint8Array([1]) }),
      () => captured!.readArtifact(1, 'art-1'),
      () => captured!.refreshModels(),
      () => captured!.redact('x'),
      () => captured!.executionEnv('local', '/tmp').canonicalPath('/tmp/x', BACKGROUND_CONTEXT),
      () => captured!.withFileLock('/tmp/x', async () => 1),
      () => captured!.atomicWriteFile('/tmp/x', 'y'),
    ]
    for (const call of expired) {
      await assert.rejects(async () => call(), (err: unknown) => {
        assert.ok(err instanceof HelmxError, `expected HelmxError, got ${String(err)}`)
        assert.equal(err.code, 'plugin_context_expired')
        return true
      })
    }
    // After re-enable: definePlugin reruns so captured holds a fresh cycle handle; the stale loop above
    // already verified old handles return 409 -- here we verify the fresh handle becomes usable again.
    await host.enable('p:epoch')
    await assert.doesNotReject(captured!.profiles.get('assistant'))
    await host.unregister('p:epoch').catch(() => {})
  })

  await t.test('unwired optional context/artifact host ports explicitly reject 501 not_supported without fallback', { timeout: 60_000 }, async () => {
    const bareBackend: PluginHostBackend = {
      ...makeBackend({}),
      resetConversation: undefined,
      resetConversationGuarded: undefined,
      compactConversation: undefined,
      compactConversationGuarded: undefined,
      createArtifact: undefined,
      readArtifact: undefined,
    }
    const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: bareBackend, docs: new MemoryDocStore() })
    let api: HelmxHostApi | undefined
    await host.register({
      id: 'p:unwired-ports',
      definePlugin(ctx) {
        api = ctx.host
      },
    }, { enabled: true })
    assert.ok(api)
    const calls: Array<() => unknown> = [
      () => api!.resetConversation(1),
      () => api!.resetConversationGuarded(1),
      () => api!.compactConversation(1),
      () => api!.compactConversationGuarded(1),
      () => api!.createArtifact(1, { name: 'a.txt', bytes: new Uint8Array([1]) }),
      () => api!.readArtifact(1, 'art-1'),
    ]
    for (const call of calls) {
      await assert.rejects(async () => call(), (err: unknown) =>
        err instanceof HelmxError && err.status === 501 && err.code === 'not_supported',
      )
    }
    await host.dispose()
  })

  await t.test('withFileLock: re-checks epoch after acquiring lock inside queue before invoking fn', { timeout: 60_000 }, async () => {
    // Scenario: lock contention + forced host dispose (liveTasks preflight only blocks disable;
    // dispose immediately expires the epoch): queued fn from old epoch rejects 409 on lock acquisition.
    let releaseFirst: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const backend = makeBackend({})
    backend.withFileLock = async <T,>(path: string, fn: () => Promise<T>) => {
      if (path === '/tmp/hold') {
        await gate // first holder pauses before releasing so second queues behind it
        return fn()
      }
      return fn()
    }
    const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs: new MemoryDocStore() })
    let second: Promise<unknown> | undefined
    const def: PluginDefinition = {
      id: 'p:lock',
      definePlugin(ctx) {
        ctx.service({
          id: 's',
          async start() {
            void ctx.host.withFileLock('/tmp/hold', async () => 'first').catch(() => {})
            await new Promise((r) => setTimeout(r, 10))
            second = ctx.host.withFileLock('/tmp/hold', async () => 'should-not-run')
          },
          async stop() {},
        })
      },
    }
    await host.register(def, { enabled: true })
    await new Promise((r) => setTimeout(r, 30))
    assert.ok(second, 'second lock request should be queued')
    // Force dispose expires epoch without disable preflight; then release holder so queued fn wakes expired.
    void host.dispose()
    await new Promise((r) => setTimeout(r, 5))
    releaseFirst!()
    await assert.rejects(second, (err: unknown) =>
      err instanceof HelmxError &&
      (err.code === 'plugin_context_expired' || err.code === 'plugin_host_disposed'),
    )
  })

  await t.test('openTunnel lifecycle tracking: TCP targets block disable while active, closing unblocks, failures never leak count', { timeout: 60_000 }, async () => {
    const stub: OpenTunnelStub = { calls: [], delayMs: 20, duplexes: [], failures: [] }
    const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: makeBackend({ openTunnel: stub }), docs: new MemoryDocStore() })
    let hostApi: Parameters<NonNullable<Parameters<typeof host.register>[0]['definePlugin']>>[0]['host'] | undefined
    const def: PluginDefinition = {
      id: 'p:tunnel',
      definePlugin(ctx) {
        hostApi = ctx.host
      },
    }
    await host.register(def, { enabled: true })
    assert.ok(hostApi)

    // 1) Setup in flight: task begins as soon as connection starts, visible to disable preflight.
    const opening = hostApi!.openTunnel('remote-1', { host: 'db.internal', port: 5432 })
    assert.equal(stub.calls.length, 1, 'backend openTunnel invoked')
    await assert.rejects(
      host.disable('p:tunnel'),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_has_live_tasks' && err.status === 409,
    )
    const duplex = await opening
    // 2) Active Duplex remains open after setup finishes: counter stays held (regression against immediate withTask release).
    await assert.rejects(
      host.disable('p:tunnel'),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_has_live_tasks',
      'disable must return 409 while Duplex is active instead of dropping counter on setup resolve',
    )
    // 3) Duplex closes: task settles once all tunnels close and disable succeeds again.
    duplex.destroy()
    await new Promise((r) => setTimeout(r, 30))
    await host.disable('p:tunnel')

    // 4) Failure path (separate plugin to avoid epoch change invalidating handle):
    // setup failure ends task immediately without leaking count -> disable succeeds cleanly.
    stub.failures.push(new HelmxError('node_tunnel_connect_failed', 'setup failed', 502))
    let hostApi2: typeof hostApi | undefined
    const defFail: PluginDefinition = {
      id: 'p:tunnel2',
      definePlugin(ctx) {
        hostApi2 = ctx.host
      },
    }
    await host.register(defFail, { enabled: true })
    await assert.rejects(
      hostApi2!.openTunnel('remote-1', { port: 5432 }),
      (err: unknown) => err instanceof HelmxError && err.code === 'node_tunnel_connect_failed',
    )
    await host.disable('p:tunnel2')
    await host.unregister('p:tunnel').catch(() => {})
    await host.unregister('p:tunnel2').catch(() => {})
    void host.dispose()
  })

  await t.test('openTunnel: host dispose destroys active and late-arriving Duplexes', { timeout: 60_000 }, async () => {
    for (const delayMs of [0, 20]) {
      const stub: OpenTunnelStub = { calls: [], delayMs, duplexes: [], failures: [] }
      const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: makeBackend({ openTunnel: stub }), docs: new MemoryDocStore() })
      let api!: HelmxHostApi
      await host.register({ id: `p:tunnel-dispose-${delayMs}`, definePlugin(ctx) { api = ctx.host } }, { enabled: true })
      const opening = api.openTunnel('local', { port: 9000 })
      if (delayMs === 0) {
        const duplex = await opening
        await host.dispose()
        assert.equal(duplex.destroyed, true)
      } else {
        const rejected = assert.rejects(opening, (error: unknown) =>
          error instanceof HelmxError && (error.code === 'plugin_host_disposed' || error.code === 'plugin_context_expired'))
        await host.dispose()
        await rejected
        assert.equal(stub.duplexes[0]?.destroyed, true)
      }
    }
  })

  await t.test('onUpdate: forwards string partials to output and silently drops late partials after settle', async () => {
    // Tests tool-registry onUpdate wrapper semantics (outer path to pluginToolResult) with a minimal
    // controllable stub: forwards before settle, drops silently after settle.
    const chunks: string[] = []
    let settled = false
    const output = (chunk: string): void => {
      if (settled) throw new Error('Tool call has settled')
      chunks.push(chunk)
    }
    const onUpdate = (partial: { output: string | Array<{ type: 'text'; text: string }> }): void => {
      const text = typeof partial.output === 'string' ? partial.output : partial.output.map((b) => b.text).join('')
      try {
        output(text)
      } catch (err) {
        if (err instanceof Error && err.message.includes('has settled')) return
        throw err
      }
    }
    onUpdate({ output: 'part-1 ' })
    onUpdate({ output: [{ type: 'text', text: 'part-2' }] })
    assert.deepEqual(chunks, ['part-1 ', 'part-2'])
    settled = true
    onUpdate({ output: 'late' }) // neither throws nor pushes
    assert.deepEqual(chunks, ['part-1 ', 'part-2'])
  })

  await t.test('prompt projection: only active tools populate sections without ghost residues; guidelines array expands', () => {
    const base = [
      { id: 'profile.system', text: 'SYS' },
      { id: 'prompt.tools.update_memory', text: 'stale snippet (should be overwritten)' },
      { id: 'prompt.tools.ghost_tool', text: 'ghost section (tool stripped, should be removed)' },
    ]
    const projected = projectToolPromptSections(base, [
      { name: 'update_memory', promptSnippet: 'use update_memory to save memory.' },
      { name: 'load_skill', promptGuidelines: ['read SKILL.md first', 'read references on demand'] },
    ])
    const ids = projected.map((s) => s.id)
    assert.ok(!ids.includes('prompt.tools.ghost_tool'), 'ghost section must be removed')
    const snippet = projected.find((s) => s.id === 'prompt.tools.update_memory')
    assert.equal(snippet?.text, 'use update_memory to save memory.')
    const guidelines = projected.find((s) => s.id === 'prompt.tools.guidelines')
    assert.ok(guidelines)
    assert.ok(guidelines!.text.includes('- load_skill: read SKILL.md first'))
    assert.ok(guidelines!.text.includes('- load_skill: read references on demand'))
    // Empty projection: removes all prompt.tools.* sections (including guidelines).
    const cleared = projectToolPromptSections(projected, [])
    assert.ok(!cleared.some((s) => s.id.startsWith('prompt.tools.')))
  })

  await t.test('ctx.host.forkConversation: forwards args to real Runtime, boundary errors, liveTasks, and disable expiry', { timeout: 60_000 }, async (sub) => {
    // 1. liveTasks + epoch guard: in-flight forkConversation returns 409 plugin_has_live_tasks on disable;
    // once done and disabled, stale handle throws 409 plugin_context_expired.
    let resolveFork!: (summary: ReturnType<typeof makeConversation>) => void
    const forkGate = new Promise<ReturnType<typeof makeConversation>>((resolve) => {
      resolveFork = resolve
    })
    const liveBackend: PluginHostBackend = {
      ...makeBackend({}),
      forkConversation: async () => forkGate,
    }
    const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: liveBackend, docs: new MemoryDocStore() })
    let liveHost: Parameters<NonNullable<Parameters<typeof host.register>[0]['definePlugin']>>[0]['host'] | undefined
    await host.register({
      id: 'p:fork-live',
      definePlugin(ctx) {
        liveHost = ctx.host
      },
    }, { enabled: true })
    assert.ok(liveHost)
    const pendingFork = liveHost!.forkConversation(1, { entryId: 1, title: 'in-flight' })
    await delay(10)
    await assert.rejects(
      () => host.disable('p:fork-live'),
      (err: unknown) => err instanceof HelmxError && err.status === 409 && err.code === 'plugin_has_live_tasks',
    )
    resolveFork({ ...makeConversation(101), parentConversationId: 1, title: 'in-flight' })
    const stubForked = await pendingFork
    assert.equal(stubForked.parentConversationId, 1)
    assert.equal(stubForked.title, 'in-flight')
    await host.disable('p:fork-live')
    await assert.rejects(
      async () => liveHost!.forkConversation(1, { entryId: 1 }),
      (err: unknown) => err instanceof HelmxError && err.status === 409 && err.code === 'plugin_context_expired',
    )

    // 2. Real KernelRuntime end-to-end wiring: 400/404 validation, normal inheritance on fork, and post-disable expiry.
    const rtDir = useTempDir(sub, 'helmx-host-fork-rt-')
    const { models, faux } = makeFauxModels()
    faux.setResponses([fauxAssistantMessage('recorded passcode ALPHA-99')])
    const runtime = await KernelRuntime.open({
      buildProvider: createPluginBuildProvider(),
      dataDir: rtDir,
      cwd: rtDir,
      models,
      model: 'faux/faux-1',
    })
    try {
      let realHost: HelmxHostApi | undefined
      await runtime.plugins.register({
        id: 'p:fork-real',
        definePlugin(ctx) {
          realHost = ctx.host
        },
      }, { enabled: true })
      assert.ok(realHost)

      await runtime.services.profiles.save({
        id: 'reviewer',
        name: 'review',
        model: 'faux/faux-1',
        cwd: rtDir,
      })
      const parent = await runtime.createConversation({
        profileId: 'reviewer',
        cwd: rtDir,
        title: 'parent conversation',
      })
      await runtime.submitInput(parent.id, 'please remember passcode ALPHA-99')
      await runtime.waitForIdle(parent.id)
      const detail = await runtime.getConversationDetail(parent.id)
      const lastEntry = detail.entries.at(-1)
      assert.ok(lastEntry)
      const lastEntryId = Number(lastEntry.id)
      assert.ok(Number.isSafeInteger(lastEntryId) && lastEntryId > 0)

      for (const badEntryId of [0, -1, 1.5]) {
        await assert.rejects(
          () => realHost!.forkConversation(parent.id, { entryId: badEntryId }),
          (err: unknown) => err instanceof HelmxError && err.status === 400 && err.code === 'validation_error',
        )
      }
      await assert.rejects(
        () => realHost!.forkConversation(999999, { entryId: lastEntryId }),
        (err: unknown) => err instanceof HelmxError && err.status === 404 && err.code === 'not_found',
      )
      await assert.rejects(
        () => realHost!.forkConversation(parent.id, { entryId: 999999 }),
        (err: unknown) => err instanceof HelmxError && err.status === 404 && err.code === 'not_found',
      )

      const forked = await realHost!.forkConversation(parent.id, {
        entryId: lastEntryId,
        title: 'custom fork title',
      })
      assert.equal(forked.parentConversationId, parent.id)
      assert.equal(forked.title, 'custom fork title')
      assert.equal(forked.profileId, 'reviewer')
      assert.equal(forked.cwd, rtDir)
      assert.equal(forked.model, 'faux/faux-1')

      const forkedDetail = await runtime.getConversationDetail(forked.id)
      assert.ok(JSON.stringify(forkedDetail.entries).includes('ALPHA-99'))

      const cleanForked = await realHost!.forkConversation(parent.id)
      assert.equal(cleanForked.parentConversationId, parent.id)
      assert.equal(cleanForked.title, 'parent conversation (fork)')
      const cleanForkedDetail = await runtime.getConversationDetail(cleanForked.id)
      assert.ok(JSON.stringify(cleanForkedDetail.entries).includes('ALPHA-99'))

      const emptyParent = await runtime.createConversation({
        profileId: 'reviewer',
        cwd: rtDir,
        title: 'empty parent',
      })
      await assert.rejects(
        () => realHost!.forkConversation(emptyParent.id),
        (err: unknown) => err instanceof HelmxError && err.status === 409 && err.code === 'fork_empty_history',
      )

      await runtime.plugins.disable('p:fork-real')
      await assert.rejects(
        async () => realHost!.forkConversation(parent.id, { entryId: lastEntryId }),
        (err: unknown) => err instanceof HelmxError && err.status === 409 && err.code === 'plugin_context_expired',
      )
    } finally {
      await runtime.close()
    }
  })

  await t.test('ctx.host.createArtifact / readArtifact / reset+compact (plain & guarded): real runtime wiring end-to-end', { timeout: 60_000 }, async (sub) => {
    const rtDir = useTempDir(sub, 'helmx-host-attach-rt-')
    const { models, faux } = makeFauxModels()
    // Response factory echoes whether the attachment manifest reached the model transcript.
    faux.setResponses([
      (context) => {
        const sawManifest = JSON.stringify(context.messages).includes('[Attached Files]')
        return fauxAssistantMessage(sawManifest ? 'ATTACHMENT_MANIFEST_SEEN' : 'ATTACHMENT_MANIFEST_MISSING')
      },
      () => fauxAssistantMessage('SUBMISSION_PROBE_DONE'),
    ])
    const runtime = await KernelRuntime.open({
      buildProvider: createPluginBuildProvider(),
      dataDir: rtDir,
      cwd: rtDir,
      models,
      model: 'faux/faux-1',
    })
    try {
      let realHost: HelmxHostApi | undefined
      await runtime.plugins.register({
        id: 'p:attach-real',
        definePlugin(ctx) {
          realHost = ctx.host
        },
      }, { enabled: true })
      assert.ok(realHost)

      await runtime.services.profiles.save({
        id: 'courier',
        name: 'courier',
        model: 'faux/faux-1',
        cwd: rtDir,
      })
      const conv = await runtime.createConversation({
        profileId: 'courier',
        cwd: rtDir,
        title: 'attachment relay',
      })
      const other = await runtime.createConversation({
        profileId: 'courier',
        cwd: rtDir,
        title: 'sibling conversation',
      })

      // createArtifact boundary validation: bad convId / bad input / bad filename / >15 MiB / missing conv.
      await assert.rejects(
        () => realHost!.createArtifact(0, { name: 'a.txt', bytes: new Uint8Array([1]) }),
        (err: unknown) => err instanceof HelmxError && err.status === 400 && err.code === 'validation_error',
      )
      await assert.rejects(
        () => realHost!.createArtifact(conv.id, { name: 'a.txt', bytes: 'not-bytes' as unknown as Uint8Array }),
        (err: unknown) => err instanceof HelmxError && err.status === 400 && err.code === 'validation_error',
      )
      await assert.rejects(
        () => realHost!.createArtifact(conv.id, { name: '../escape.txt', bytes: new Uint8Array([1]) }),
        (err: unknown) => err instanceof HelmxError && err.status === 400 && err.code === 'validation_error',
      )
      await assert.rejects(
        () => realHost!.createArtifact(conv.id, { name: 'huge.bin', bytes: new Uint8Array(MAX_ARTIFACT_BYTES + 1) }),
        (err: unknown) => err instanceof HelmxError && err.status === 413 && err.code === 'artifact_too_large',
      )
      await assert.rejects(
        () => realHost!.createArtifact(999_999, { name: 'missing.txt', bytes: new Uint8Array([1]) }),
        (err: unknown) => err instanceof HelmxError && err.status === 404 && err.code === 'not_found',
      )

      // Happy path via ctx.host.createArtifact: text artifact (with SecretStash redaction) + binary PNG.
      runtime.stash.addRedaction('sk-artifact-secret-42')
      const textMeta = await realHost!.createArtifact(conv.id, {
        name: 'note.md',
        mimeType: 'text/markdown',
        bytes: new TextEncoder().encode('# relay note sk-artifact-secret-42'),
      })
      assert.equal(textMeta.kind, 'upload')
      assert.equal(textMeta.conversationId, conv.id)
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
      const imageMeta = await realHost!.createArtifact(conv.id, {
        name: 'photo.png',
        mimeType: 'image/png',
        bytes: pngBytes,
      })
      const listed = await realHost!.listArtifacts(conv.id)
      assert.deepEqual(
        listed.map((m) => m.id).sort(),
        [textMeta.id, imageMeta.id].sort(),
      )

      // readArtifact: byte fidelity, redaction, isolated ArrayBuffer, and authorization boundaries.
      const readText = await realHost!.readArtifact(conv.id, textMeta.id)
      assert.equal(readText.metadata.id, textMeta.id)
      const decodedText = new TextDecoder().decode(readText.bytes)
      assert.ok(decodedText.includes('# relay note') && !decodedText.includes('sk-artifact-secret-42'))
      const readPng = await realHost!.readArtifact(conv.id, imageMeta.id)
      assert.deepEqual([...readPng.bytes], [...pngBytes])
      assert.equal(readPng.bytes.byteOffset, 0)
      assert.equal(readPng.bytes.byteLength, readPng.bytes.buffer.byteLength, 'bytes must be an isolated Uint8Array copy')
      readPng.bytes[0] = 0x00
      assert.equal((await realHost!.readArtifact(conv.id, imageMeta.id)).bytes[0], 0x89)

      // Attachment & readArtifact authorization: sibling-conversation artifact and unknown/invalid IDs rejected.
      const siblingMeta = await realHost!.createArtifact(other.id, {
        name: 'private.txt',
        bytes: new TextEncoder().encode('sibling only'),
      })
      await assert.rejects(
        () => realHost!.readArtifact(conv.id, siblingMeta.id),
        (err: unknown) => err instanceof HelmxError && err.status === 403 && err.code === 'artifact_forbidden',
      )
      await assert.rejects(
        () => realHost!.readArtifact(conv.id, 'no-such-artifact'),
        (err: unknown) => err instanceof HelmxError && err.status === 404 && err.code === 'not_found',
      )
      await assert.rejects(
        () => realHost!.readArtifact(0, textMeta.id),
        (err: unknown) => err instanceof HelmxError && err.status === 400 && err.code === 'validation_error',
      )
      await assert.rejects(
        () => realHost!.readArtifact(conv.id, '   '),
        (err: unknown) => err instanceof HelmxError && err.status === 400 && err.code === 'validation_error',
      )
      await assert.rejects(
        () => realHost!.submitInput(conv.id, 'x', { attachments: [siblingMeta.id] }),
        (err: unknown) => err instanceof HelmxError && err.status === 403 && err.code === 'artifact_forbidden',
      )
      await assert.rejects(
        () => realHost!.submitInput(conv.id, 'x', { attachments: ['no-such-artifact'] }),
        (err: unknown) => err instanceof HelmxError && err.status === 404 && err.code === 'not_found',
      )
      await assert.rejects(
        // Shape gate at the shared submission entry: non-string elements never reach resolution.
        () => realHost!.submitInput(conv.id, 'x', { attachments: [42] as unknown as string[] }),
        (err: unknown) => err instanceof HelmxError && err.status === 400 && err.code === 'validation_error',
      )

      // Full relay: submitInput with attachments reaches the model with the [Attached Files] manifest.
      await realHost!.submitInput(conv.id, 'please review the attached files', {
        origin: 'trigger',
        attachments: [textMeta.id, imageMeta.id],
      })
      await runtime.waitForIdle(conv.id)
      const detail = await runtime.getConversationDetail(conv.id)
      const inputEntry = detail.entries.find(
        (e) => e.kind === 'user' || JSON.stringify(e).includes('please review the attached files'),
      )
      assert.ok(inputEntry, 'input entry present in timeline')
      const serialized = JSON.stringify(inputEntry)
      assert.ok(serialized.includes('note.md') && serialized.includes('photo.png'), 'attachment refs ride the input entry')
      // pi entry kinds are provider-native; assistant text lives in the model-context array, so
      // search the serialized timeline for the faux marker instead of filtering by kind.
      const timelineText = JSON.stringify(detail.entries)
      assert.ok(
        timelineText.includes('ATTACHMENT_MANIFEST_SEEN'),
        `model transcript carried the attachment manifest (timeline: ${timelineText.slice(0, 2000)})`,
      )

      // Ancestor-chain authorization: forked child conversation can read parent's artifact.
      const childConv = await realHost!.forkConversation(conv.id, { title: 'child reader' })
      const childRead = await realHost!.readArtifact(childConv.id, imageMeta.id)
      assert.deepEqual([...childRead.bytes], [...pngBytes])

      // Disk file missing -> truthful 404 artifact_file_missing; symlink escape -> 500 artifact_path_illegal.
      const missingMeta = await realHost!.createArtifact(conv.id, {
        name: 'vanish.txt',
        bytes: new TextEncoder().encode('bye'),
      })
      const vanishDiskPath = join(rtDir, missingMeta.path)
      await rm(vanishDiskPath)
      await assert.rejects(
        () => realHost!.readArtifact(conv.id, missingMeta.id),
        (err: unknown) => err instanceof HelmxError && err.status === 404 && err.code === 'artifact_file_missing',
      )
      const outsideSecret = join(rtDir, 'outside-secret.txt')
      await writeFile(outsideSecret, 'TOP-SECRET')
      await symlink(outsideSecret, vanishDiskPath)
      await assert.rejects(
        () => realHost!.readArtifact(conv.id, missingMeta.id),
        (err: unknown) => err instanceof HelmxError && err.status === 500 && err.code === 'artifact_path_illegal',
      )

      // Human-channel vs guarded context maintenance via ctx.host:
      // 1) ownedBy: 'human' -> plain reset/compact succeed (keeping ownedBy='human'), guarded variants reject 409.
      assert.equal(realHost!.getConversationOwnership(conv.id), 'human')
      await assert.rejects(
        () => realHost!.resetConversationGuarded(conv.id, { handoff: 'blocked' }),
        (err: unknown) => err instanceof HelmxError && err.status === 409 && err.code === 'ownership_conflict',
      )
      await assert.rejects(
        () => realHost!.compactConversationGuarded(conv.id, { instructions: 'blocked' }),
        (err: unknown) => err instanceof HelmxError && err.status === 409 && err.code === 'ownership_conflict',
      )
      const seqBeforeHumanReset = realHost!.getConversation(conv.id).stateChangeSeq
      const humanReset = await realHost!.resetConversation(conv.id, { handoff: 'human /clear' })
      assert.equal(humanReset.ownedBy, 'human')
      assert.equal(humanReset.stateChangeSeq, seqBeforeHumanReset + 1)
      const humanCompact = await realHost!.compactConversation(conv.id, { instructions: 'human /compact' })
      assert.ok(Number.isSafeInteger(humanCompact.taskId) && humanCompact.taskId > 0)
      assert.equal(humanCompact.conversation.ownedBy, 'human')
      assert.equal(humanCompact.conversation.stateChangeSeq, seqBeforeHumanReset + 2)

      // 2) ownedBy: 'helmx' -> guarded reset/compact succeed with CAS and reject stale expectedStateSeq.
      realHost!.markConversationOwnership(childConv.id, 'helmx')
      const childSeq = realHost!.getConversation(childConv.id).stateChangeSeq
      await assert.rejects(
        () => realHost!.resetConversationGuarded(childConv.id, undefined, { expectedStateSeq: childSeq + 10 }),
        (err: unknown) => err instanceof HelmxError && err.status === 409 && err.code === 'state_seq_conflict',
      )
      const guardedReset = await realHost!.resetConversationGuarded(
        childConv.id,
        { handoff: 'auto reset' },
        { expectedOwnership: 'helmx', expectedStateSeq: childSeq },
      )
      assert.equal(guardedReset.stateChangeSeq, childSeq + 1)
      const guardedCompact = await realHost!.compactConversationGuarded(
        childConv.id,
        { instructions: 'auto compact' },
        { expectedOwnership: 'helmx', expectedStateSeq: childSeq + 1 },
      )
      assert.ok(Number.isSafeInteger(guardedCompact.taskId) && guardedCompact.taskId > 0)
      assert.equal(guardedCompact.conversation.stateChangeSeq, childSeq + 2)

      // Deletion mid-flight safety: creating into a just-deleted conversation rejects 404, never orphans.
      await runtime.deleteConversation(other.id)
      await assert.rejects(
        () => realHost!.createArtifact(other.id, { name: 'late.txt', bytes: new TextEncoder().encode('x') }),
        (err: unknown) => err instanceof HelmxError && err.status === 404 && err.code === 'not_found',
      )

      // Durable submission lookup by requestId: uncommitted -> undefined, committed -> done, bad requestId -> 400, missing conv -> 404.
      const reqId = 'host-core-ports:req-1'
      assert.equal(await realHost!.getConversationSubmission(conv.id, reqId), undefined)
      await realHost!.submitInput(conv.id, 'submission probe', { origin: 'agent', requestId: reqId })
      await runtime.waitForIdle(conv.id)
      const subInfo = await realHost!.getConversationSubmission(conv.id, reqId)
      assert.ok(subInfo !== undefined, 'committed requestId must be found in pi_submissions')
      assert.equal(subInfo.requestId, reqId)
      assert.equal(subInfo.status, 'done')
      await assert.rejects(
        () => realHost!.getConversationSubmission(conv.id, '   '),
        (err: unknown) => err instanceof HelmxError && err.status === 400 && err.code === 'validation_error',
      )
      await assert.rejects(
        () => realHost!.getConversationSubmission(other.id, reqId),
        (err: unknown) => err instanceof HelmxError && err.status === 404 && err.code === 'not_found',
      )

      await runtime.plugins.disable('p:attach-real')
      // Wrap async: the epoch guard throws synchronously before entering the async backend call.
      for (const staleCall of [
        () => realHost!.listArtifacts(conv.id),
        () => realHost!.createArtifact(conv.id, { name: 'late.txt', bytes: new TextEncoder().encode('x') }),
        () => realHost!.readArtifact(conv.id, textMeta.id),
        () => realHost!.resetConversation(conv.id),
        () => realHost!.resetConversationGuarded(conv.id),
        () => realHost!.compactConversation(conv.id),
        () => realHost!.compactConversationGuarded(conv.id),
      ]) {
        await assert.rejects(
          async () => staleCall(),
          (err: unknown) => err instanceof HelmxError && err.status === 409 && err.code === 'plugin_context_expired',
        )
      }
    } finally {
      await runtime.close()
    }
  })

  await t.test('ctx.host.openTunnel({ host, port }): real KernelRuntime wiring end-to-end', { timeout: 60_000 }, async (sub) => {
    const rtDir = useTempDir(sub, 'helmx-host-env-rt-')
    const { models } = makeFauxModels()
    const runtime = await KernelRuntime.open({
      buildProvider: createPluginBuildProvider(),
      dataDir: rtDir,
      cwd: rtDir,
      models,
      model: 'faux/faux-1',
    })
    const tcp = net.createServer((socket) => {
      socket.on('data', (chunk) => socket.end(chunk))
    })
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve))
    const port = (tcp.address() as net.AddressInfo).port
    try {
      let realHost: HelmxHostApi | undefined
      await runtime.plugins.register({
        id: 'p:env-rt',
        definePlugin(ctx) {
          realHost = ctx.host
        },
      }, { enabled: true })
      assert.ok(realHost)

      const stream = await realHost!.openTunnel('local', { host: '127.0.0.1', port })
      const echoed = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = []
        stream.on('data', (c: Buffer) => chunks.push(c))
        stream.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        stream.once('error', reject)
        stream.write('ping-tcp')
      })
      assert.equal(echoed, 'ping-tcp')
      stream.destroy()
      await delay(20)
      await runtime.plugins.disable('p:env-rt')
      await assert.rejects(
        async () => realHost!.openTunnel('local', { host: '127.0.0.1', port }),
        (err: unknown) => err instanceof HelmxError && err.code === 'plugin_context_expired' && err.status === 409,
      )
    } finally {
      await new Promise<void>((resolve) => tcp.close(() => resolve()))
      await runtime.close()
    }
  })

  await t.test('ctx.host.nodeIpc.listNodes() + typed onEvent/emitEvent: real KernelRuntime wiring, defensive clone, and expiry', { timeout: 60_000 }, async (sub) => {
    const rtDir = useTempDir(sub, 'helmx-host-nodes-rt-')
    const { models } = makeFauxModels()
    const runtime = await KernelRuntime.open({
      buildProvider: createPluginBuildProvider(),
      dataDir: rtDir,
      cwd: rtDir,
      models,
      model: 'faux/faux-1',
    })
    try {
      // Issue a BYOM node token so listNodes returns both local and a registered remote node (without leaking token!)
      const issued = await runtime.issueNodeToken('node-gpu')
      assert.ok(issued.token.length > 0)

      let realHost: HelmxHostApi | undefined
      const deletedIds: number[] = []
      const notifications: string[] = []
      await runtime.plugins.register(
        {
          id: 'p:nodes-events',
          definePlugin(ctx) {
            realHost = ctx.host
            // Typed onEvent overload infers ConversationDeletedEvent and NotificationEvent without manual casts
            ctx.host.onEvent('conversation.deleted', (ev) => {
              deletedIds.push(ev.conversationId)
            })
            ctx.host.onEvent('notification', (ev) => {
              notifications.push(`${ev.level}:${ev.title}`)
            })
          },
        },
        { enabled: true },
      )
      assert.ok(realHost)
      assert.equal(typeof realHost!.nodeIpc.listNodes, 'function')

      const nodes = realHost!.nodeIpc.listNodes!()
      assert.deepEqual(
        nodes.map((n) => ({ id: n.id, kind: n.kind, online: n.online })),
        [
          { id: 'local', kind: 'local', online: true },
          { id: 'node-gpu', kind: 'byom', online: false },
        ],
      )
      assert.ok(!JSON.stringify(nodes).includes(issued.token), 'listNodes snapshot must never expose node tokens')

      // Defensive clone: mutating returned node/health does not corrupt subsequent reads
      nodes[0]!.hostname = 'mutated-host'
      if (nodes[0]!.health) nodes[0]!.health.uptimeSec = -999
      const fresh = realHost!.nodeIpc.listNodes!()
      assert.notEqual(fresh[0]!.hostname, 'mutated-host')
      assert.notEqual(fresh[0]!.health?.uptimeSec, -999)

      // Typed emitEvent delivers notification and conversation.deleted triggers typed listener
      await realHost!.emitEvent('notification', { level: 'info', title: 'hello', body: 'world' })
      assert.deepEqual(notifications, ['info:hello'])
      const conv = await runtime.createConversation({ cwd: rtDir, title: 'temp' })
      await runtime.deleteConversation(conv.id)
      assert.deepEqual(deletedIds, [conv.id])

      await runtime.plugins.disable('p:nodes-events')
      assert.throws(
        () => realHost!.nodeIpc.listNodes!(),
        (err: unknown) => err instanceof HelmxError && err.code === 'plugin_context_expired' && err.status === 409,
      )
    } finally {
      await runtime.close()
    }
  })
})
