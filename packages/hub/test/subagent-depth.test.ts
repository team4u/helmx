/**
 * Subagent, workflow & swarm nesting depth contract:
 * By default, delegated children (`subagent`, `SubagentWorkflow`, and `builtin:swarm` workers)
 * are level-1 orchestration leaves (`DEFAULT_MAX_SUBAGENT_DEPTH = 1`) and cannot spawn nested
 * subagents, workflows, or swarms unless plugin config or explicit `maxSubagentDepth` (2..5)
 * grants deeper nesting.
 *
 * Source of truth (persisted across restarts):
 * - `builtin:workflow`: private KV namespace `depth` registers child conversations spawned
 *   through the `agent_spawn` pipeline (`onResolved` returns `conversationId`), recording
 *   `depth` / `parentConversationId` / `maxSubagentDepth` / optional `forked`.
 * - `builtin:swarm`: exposes worker topological facts (`{ depth: 1, leaf?: true }`) via
 *   the `'helmx.conversation-depth'` capability contract so `builtin:workflow` applies its
 *   single `maxSubagentDepth` configuration uniformly.
 * - Human `conversations fork` and direct `createConversation` stay outside the depth registry (depth 0).
 *
 * Three enforcement layers:
 * 1. `before_turn`: strips `subagent`, `SubagentWorkflow`, and all active `helmx.dispatch-tools`
 *    declarations on leaf turns at the subtree ceiling (naturally suppressing `profile.catalog`);
 * 2. Tool/action boundaries: `subagent` tool, `SubagentWorkflow` tool, and `run` action reject
 *    before creating any run record (`HelmxError('subagent_depth_exceeded')`, status 403);
 * 3. `agent_spawn` fallback: `builtin:workflow` (priority 300, ahead of `builtin:worktree`
 *    priority 200) rejects direct `kernel.spawnAgent` calls with zero worktree or registry side effects.
 */

import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai/providers/faux'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import { HelmxError } from '@helmx/protocol'
import { KernelRuntime } from '@helmx/kernel'
import { createProfilePlugin } from '@helmx/plugins/profile'
import { createWorkflowPlugin } from '@helmx/plugins/workflow'
import { withWorkflowSpawnMeta } from '@helmx/plugins/contracts'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHelmx } from '../src/app.js'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { makeFauxProvider, type FauxProviderHandle } from './helpers/hub-test-env.js'

let rootDir: string

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helmx-subagent-depth-test-'))
}, { timeout: 60_000 })

after(() => {
  rmSync(rootDir, { recursive: true, force: true })
}, { timeout: 60_000 })

/** Reads the persisted private depth KV namespace directly from `state.sqlite` after flushing. */
function readRegistryRaw(dataDir: string): Record<string, unknown> {
  const db = new DatabaseSync(join(dataDir, 'state.sqlite'), { readOnly: true })
  try {
    const rows = db
      .prepare("SELECT key, value_json FROM helmx_plugin_kv WHERE plugin_id = 'builtin:workflow' AND namespace = 'depth'")
      .all() as Array<{ key: string; value_json: string }>
    const out: Record<string, unknown> = {}
    for (const row of rows) {
      out[row.key] = JSON.parse(row.value_json)
    }
    return out
  } finally {
    db.close()
  }
}

/** Writes plugin private depth KV entry directly (for testing corrupt records after closing app). */
function writeDepthKvRaw(dataDir: string, key: string, value: unknown): void {
  const db = new DatabaseSync(join(dataDir, 'state.sqlite'))
  try {
    db.prepare(
      `INSERT INTO helmx_plugin_kv (plugin_id, namespace, key, value_json, updated_at) VALUES ('builtin:workflow', 'depth', ?, ?, ?)
       ON CONFLICT(plugin_id, namespace, key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
    ).run(key, JSON.stringify(value), Date.now())
  } finally {
    db.close()
  }
}

/** Helper to read and assert a registry entry (`depth` / `parentConversationId` / `maxSubagentDepth`). */
function registryEntry(dataDir: string, conversationId: number): Record<string, unknown> {
  const raw = readRegistryRaw(dataDir)[String(conversationId)]
  assert.ok(raw !== undefined && typeof raw === 'object', `conversation ${conversationId} should be registered in depth KV`)
  return raw as Record<string, unknown>
}

function captureModelRequest(messages: readonly unknown[]): {
  toolNames: string[]
  sectionsById: Record<string, string>
  userTexts: string[]
  lastNonSystemRole?: string
  lastToolName?: string
} {
  const tools = getCurrentTools(messages as never)
  const sectionsById: Record<string, string> = {}
  const userTexts: string[] = []
  let lastNonSystemRole: string | undefined
  let lastToolName: string | undefined
  for (const raw of messages) {
    if (raw === null || typeof raw !== 'object') continue
    const m = raw as Record<string, unknown>
    if (m['role'] === 'system' && m['sections'] !== null && typeof m['sections'] === 'object') {
      for (const [k, v] of Object.entries(m['sections'] as Record<string, unknown>)) {
        if (typeof v === 'string') sectionsById[k] = v
      }
      continue
    }
    if (typeof m['role'] === 'string') {
      lastNonSystemRole = m['role']
      lastToolName = typeof m['toolName'] === 'string' ? m['toolName'] : undefined
    }
    if (m['role'] === 'user') {
      if (typeof m['content'] === 'string') {
        userTexts.push(m['content'])
      } else if (Array.isArray(m['content'])) {
        for (const block of m['content']) {
          if (block !== null && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
            userTexts.push((block as { text: string }).text)
          }
        }
      }
    }
  }
  return {
    toolNames: tools.map((t) => t.name),
    sectionsById,
    userTexts,
    ...(lastNonSystemRole !== undefined ? { lastNonSystemRole } : {}),
    ...(lastToolName !== undefined ? { lastToolName } : {}),
  }
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${label}`)
    }
    await new Promise((r) => setTimeout(r, 15))
  }
}

/** Opens minimal 2-plugin runtime (`profile` + `workflow`) for corrupt-KV persistence tests. */
async function openMinimalDepthRuntime(dataDir: string, provider: ReturnType<typeof makeFauxProvider>['provider']): Promise<KernelRuntime> {
  const runtime = await KernelRuntime.open({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    providers: [provider],
    autoResume: false,
  })
  try {
    await runtime.plugins.register(createProfilePlugin())
    await runtime.plugins.register(createWorkflowPlugin())
    await runtime.start()
    return runtime
  } catch (err) {
    await runtime.close().catch(() => {})
    throw err
  }
}

/**
 * Spawns a real child conversation chain (matching production `onResolved` + registry behavior):
 * each entry in `parents` acts as parent for the next spawned child; returns created child IDs.
 */
async function spawnChain(
  app: Awaited<ReturnType<typeof createHelmx>>,
  faux: FauxProviderHandle,
  parents: number[],
  firstMeta?: Record<string, Record<string, unknown>>,
): Promise<number[]> {
  const created: number[] = []
  for (let i = 0; i < parents.length; i += 1) {
    const parent = parents[i]!
    let childId: number | undefined
    faux.setResponses([fauxAssistantMessage(`subagent ${parent} answer`)])
    await app.kernel.agentSpawn.spawnAgent({
      parentConversationId: parent,
      prompt: `from ${parent} derive`,
      ...(i === 0 && firstMeta !== undefined ? { meta: firstMeta as never } : {}),
      onResolved: (info) => {
        if (info.conversationId !== undefined) childId = info.conversationId
      },
    })
    assert.ok(childId !== undefined, `should spawn child from ${parent} and return conversationId`)
    created.push(childId)
  }
  return created
}

describe('workflow & swarm subagent depth contract (default ceiling 1)', { timeout: 60_000 }, () => {
  const sharedDir = join(tmpdir(), `helmx-subagent-depth-shared-${process.pid}-${Date.now()}`)
  let sharedFaux: FauxProviderHandle
  let sharedApp: Awaited<ReturnType<typeof createHelmx>>
  const observedToolsByConvId = new Map<number, string[]>()
  const observedSectionsByConvId = new Map<number, Record<string, string>>()

  before(async () => {
    sharedFaux = makeFauxProvider()
    sharedApp = await createHelmx({
      buildProvider: createPluginBuildProvider(),
      dataDir: sharedDir,
      cwd: sharedDir,
      model: 'faux/faux-1',
      providers: [sharedFaux.provider],
    })
    if (sharedApp.kernel.plugins.get('builtin:title')?.enabled) {
      await sharedApp.kernel.plugins.setConfig('builtin:title', { autoTitle: false })
    }
    await sharedApp.kernel.services.profiles.save({ id: 'reviewer', name: '评审专家' })
    await sharedApp.kernel.plugins.register({
      id: 'test:depth-observer',
      name: 'deep observer',
      definePlugin(ctx) {
        ctx.hook.onBeforeTurn((turn) => {
          const payload = turn as unknown as {
            conversation: { id: number }
            tools: Array<{ name: string }>
            sections: Array<{ id: string; text: string }>
          }
          observedToolsByConvId.set(payload.conversation.id, payload.tools.map((t) => t.name))
          const secMap: Record<string, string> = {}
          for (const s of payload.sections) secMap[s.id] = s.text
          observedSectionsByConvId.set(payload.conversation.id, secMap)
        }, { priority: -200 })
      },
    })
  }, { timeout: 60_000 })

  after(async () => {
    await sharedApp?.close().catch(() => {})
    rmSync(sharedDir, { recursive: true, force: true })
  }, { timeout: 60_000 })

  async function createSharedRoot(title: string): Promise<number> {
    const conv = await sharedApp.kernel.conversations.createConversation({
      title,
      profileId: 'assistant',
      cwd: sharedDir,
    })
    return conv.id
  }

  // -------------------------------------------------------------------------
  // 1. Default leaf at depth 1: strips dispatch tools & catalog, rejects nested spawns/runs
  // -------------------------------------------------------------------------

  test('top-level spawn depth=1 defaults to leaf (ceiling=1): strips dispatch tools & catalog, rejects spawnAgent/run with 403', { timeout: 60_000 }, async () => {
    const rootId = await createSharedRoot('depth1-default-leaf')
    sharedFaux.setResponses([
      fauxAssistantMessage([fauxToolCall('subagent', { prompt: 'sub-task', background: false })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('subagent answer'),
      fauxAssistantMessage('main turn complete'),
    ])
    await sharedApp.kernel.conversations.submitInput(rootId, 'derive default depth-1 subagent')
    await sharedApp.kernel.conversations.waitForIdle(rootId)

    const rootTools = observedToolsByConvId.get(rootId)
    assert.ok(rootTools?.includes('subagent') && rootTools.includes('SubagentWorkflow'), 'root keeps dispatch tools')
    assert.ok(typeof observedSectionsByConvId.get(rootId)?.['profile.catalog'] === 'string', 'root gets profile.catalog')

    const child = sharedApp.kernel.conversations.listConversations().find((c) => c.parentConversationId === rootId)
    assert.ok(child, 'top-level spawn should create a real child conversation')

    // Registry persists depth=1 and ceiling=1.
    await sharedApp.kernel.kvStore.flush()
    const entry = registryEntry(sharedDir, child.id)
    assert.equal(entry['depth'], 1, 'direct child of top-level conversation has depth=1')
    assert.equal(entry['parentConversationId'], rootId)
    assert.equal(entry['maxSubagentDepth'], 1, 'default subtree ceiling is 1')

    // Depth-1 `before_turn`: dispatch tools and profile.catalog are stripped at default ceiling 1.
    sharedFaux.setResponses([fauxAssistantMessage('depth-1 leaf directly answers')])
    await sharedApp.kernel.conversations.submitInput(child.id, 'direct turn on depth-1 leaf')
    await sharedApp.kernel.conversations.waitForIdle(child.id)
    const childTools = observedToolsByConvId.get(child.id)
    assert.ok(childTools, 'should observe tool list on subagent turn')
    assert.equal(childTools.includes('subagent'), false, 'default depth-1 subagent strips subagent')
    assert.equal(childTools.includes('SubagentWorkflow'), false, 'default depth-1 subagent strips SubagentWorkflow')
    assert.equal(childTools.includes('bash'), true, 'non-dispatch tools stay intact (bash present)')
    assert.equal(
      observedSectionsByConvId.get(child.id)?.['profile.catalog'],
      undefined,
      'default depth-1 subagent suppresses profile.catalog',
    )

    const beforeRunIds = new Set(
      ((await sharedApp.kernel.plugins.invokeAction('builtin:workflow', 'runs', {})) as { runs: Array<{ id: string }> }).runs.map((r) => r.id),
    )

    // Direct `spawnAgent` (with `isolation: 'worktree'`) rejects prior to worktree allocation.
    await assert.rejects(
      () =>
        sharedApp.kernel.agentSpawn.spawnAgent({
          parentConversationId: child.id,
          prompt: 'attempt depth-2 spawn',
          isolation: 'worktree',
        }),
      (err: unknown) => {
        assert.ok(err instanceof HelmxError, `expected HelmxError (got ${String(err)})`)
        assert.equal(err.code, 'subagent_depth_exceeded')
        assert.equal(err.status, 403)
        const details = err.details as { depth?: number; maxSubagentDepth?: number } | undefined
        assert.equal(details?.depth, 1)
        assert.equal(details?.maxSubagentDepth, 1)
        return true
      },
    )

    // `run` action targeting depth-1 conversation rejects with 403 and creates zero runs.
    await assert.rejects(
      () =>
        sharedApp.kernel.plugins.invokeAction('builtin:workflow', 'run', {
          script: 'export const meta = { name: "blocked", description: "d" }\nreturn 1',
          conversationId: child.id,
        }),
      (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded' && err.status === 403,
    )

    const runs = (await sharedApp.kernel.plugins.invokeAction('builtin:workflow', 'runs', {})) as {
      runs: Array<{ id: string }>
    }
    assert.equal(
      runs.runs.filter((r) => !beforeRunIds.has(r.id)).length,
      0,
      'rejected path must not create run records',
    )
  })

  // -------------------------------------------------------------------------
  // 2. Workflow run from top-level spawns engine node at depth=1 (default leaf ceiling=1)
  // -------------------------------------------------------------------------

  test('workflow run from top-level spawns engine node at depth=1 (default ceiling=1) and rejects nested spawns/runs', { timeout: 60_000 }, async () => {
    const rootId = await createSharedRoot('depth1-workflow-node')
    sharedFaux.setResponses([fauxAssistantMessage('engine node subagent answer')])
    const run = (await sharedApp.kernel.plugins.invokeAction('builtin:workflow', 'run', {
      script:
        'export const meta = { name: "root-node", description: "d" }\nconst t = await agent("node task")\nreturn t',
      conversationId: rootId,
      wait: true,
    })) as { run: { status: string; result: unknown; nodes?: Array<{ conversationId?: number }> } }
    assert.equal(run.run.status, 'completed', JSON.stringify(run.run))
    const nodeConv = run.run.nodes?.find((n) => n.conversationId !== undefined)?.conversationId
    assert.ok(nodeConv, 'engine node should spawn a real child conversation')
    await sharedApp.kernel.kvStore.flush()
    const entry = registryEntry(sharedDir, nodeConv)
    assert.equal(entry['depth'], 1)
    assert.equal(entry['parentConversationId'], rootId)
    assert.equal(entry['maxSubagentDepth'], 1)

    await assert.rejects(
      () => sharedApp.kernel.agentSpawn.spawnAgent({ parentConversationId: nodeConv, prompt: 'nested attempt' }),
      (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded' && err.status === 403,
    )
    await assert.rejects(
      () =>
        sharedApp.kernel.plugins.invokeAction('builtin:workflow', 'run', {
          script: 'export const meta = { name: "nested-wf", description: "d" }\nreturn 1',
          conversationId: nodeConv,
        }),
      (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded' && err.status === 403,
    )
  })

  // -------------------------------------------------------------------------
  // 3. Explicit maxSubagentDepth=2 from root permits depth-1 -> depth-2; depth-2 becomes leaf
  // -------------------------------------------------------------------------

  test('explicit maxSubagentDepth=2 permits depth-1 -> depth-2 via subagent tool and workflow run; depth-2 strips dispatch tools', { timeout: 60_000 }, async () => {
    const rootId = await createSharedRoot('depth2-explicit')
    sharedFaux.setResponses([
      fauxAssistantMessage([fauxToolCall('subagent', { prompt: 'one layer task', maxSubagentDepth: 2, background: false })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('subagent', { prompt: 'two layer task', background: false })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('two layer subagent answer'),
      fauxAssistantMessage('one layer subagent complete'),
      fauxAssistantMessage('main turn complete'),
    ])
    await sharedApp.kernel.conversations.submitInput(rootId, 'derive one layer with ceiling 2, let it dispatch two layer')
    await sharedApp.kernel.conversations.waitForIdle(rootId)

    const child1 = sharedApp.kernel.conversations.listConversations().find((c) => c.parentConversationId === rootId)
    assert.ok(child1, 'should spawn depth-1 child conversation')
    await sharedApp.kernel.conversations.waitForIdle(child1.id)
    const child2 = sharedApp.kernel.conversations.listConversations().find((c) => c.parentConversationId === child1.id)
    assert.ok(child2, 'depth-1 subagent with ceiling=2 should spawn depth-2 child conversation via tool')

    const c1Tools = observedToolsByConvId.get(child1.id)
    assert.ok(c1Tools?.includes('subagent') && c1Tools.includes('SubagentWorkflow'), 'depth-1 with ceiling=2 retains dispatch tools')
    assert.ok(typeof observedSectionsByConvId.get(child1.id)?.['profile.catalog'] === 'string', 'depth-1 with ceiling=2 retains profile.catalog')

    await sharedApp.kernel.kvStore.flush()
    const e1 = registryEntry(sharedDir, child1.id)
    assert.equal(e1['depth'], 1)
    assert.equal(e1['maxSubagentDepth'], 2)
    const e2 = registryEntry(sharedDir, child2.id)
    assert.equal(e2['depth'], 2)
    assert.equal(e2['parentConversationId'], child1.id)
    assert.equal(e2['maxSubagentDepth'], 2, 'subtree ceiling inherits parent effective ceiling')

    // Depth-2 `before_turn`: dispatch tools & catalog are stripped at the ceiling (leaf).
    sharedFaux.setResponses([fauxAssistantMessage('two layer leaf directly answers')])
    await sharedApp.kernel.conversations.submitInput(child2.id, 'leaf turn question')
    await sharedApp.kernel.conversations.waitForIdle(child2.id)
    const leafTools = observedToolsByConvId.get(child2.id)
    assert.ok(leafTools, 'should observe tool list on depth-2 turn')
    assert.equal(leafTools.includes('subagent'), false)
    assert.equal(leafTools.includes('SubagentWorkflow'), false)
    assert.equal(leafTools.includes('bash'), true)
    assert.equal(observedSectionsByConvId.get(child2.id)?.['profile.catalog'], undefined)

    await assert.rejects(
      () => sharedApp.kernel.agentSpawn.spawnAgent({ parentConversationId: child2.id, prompt: 'depth3 attempt' }),
      (err: unknown) => {
        assert.ok(err instanceof HelmxError)
        assert.equal(err.code, 'subagent_depth_exceeded')
        assert.equal(err.status, 403)
        const details = err.details as { depth?: number; maxSubagentDepth?: number } | undefined
        assert.equal(details?.depth, 2)
        assert.equal(details?.maxSubagentDepth, 2)
        return true
      },
    )

    // Depth-1 with ceiling=2 can also run a workflow whose engine node registers at depth=2.
    sharedFaux.setResponses([fauxAssistantMessage('engine node depth-2 answer')])
    const run = (await sharedApp.kernel.plugins.invokeAction('builtin:workflow', 'run', {
      script: 'export const meta = { name: "depth2-wf", description: "d" }\nreturn await agent("node task")',
      conversationId: child1.id,
      wait: true,
    })) as { run: { status: string; nodes?: Array<{ conversationId?: number }> } }
    assert.equal(run.run.status, 'completed')
    const nodeConv = run.run.nodes?.find((n) => n.conversationId !== undefined)?.conversationId
    assert.ok(nodeConv)
    await sharedApp.kernel.kvStore.flush()
    assert.equal(registryEntry(sharedDir, nodeConv)['depth'], 2)
    assert.equal(registryEntry(sharedDir, nodeConv)['maxSubagentDepth'], 2)
    await assert.rejects(
      () => sharedApp.kernel.agentSpawn.spawnAgent({ parentConversationId: nodeConv, prompt: 'depth3 from wf node' }),
      (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded',
    )
  })

  // -------------------------------------------------------------------------
  // 4. Human `conversations fork` and direct `createConversation` remain unaffected (depth 0)
  // -------------------------------------------------------------------------

  test('forked conversations and direct createConversation children remain depth 0: spawn and run actions succeed', { timeout: 60_000 }, async () => {
    const rootId = await createSharedRoot('depth-non-managed')
    sharedFaux.setResponses([fauxAssistantMessage('top-level answer')])
    await sharedApp.kernel.conversations.submitInput(rootId, 'hello')
    await sharedApp.kernel.conversations.waitForIdle(rootId)
    const detail = await sharedApp.kernel.conversations.getConversationDetail(rootId, { limit: 10 })
    const numericEntry = detail.entries.find((e) => Number.isInteger(Number(e.id)) && Number(e.id) > 0)
    assert.ok(numericEntry, 'should have a forkable entry')

    const forked = await sharedApp.kernel.conversations.forkConversation(rootId, { entryId: Number(numericEntry!.id) })
    assert.equal(forked.parentConversationId, rootId)

    sharedFaux.setResponses([fauxAssistantMessage('fork subagent answer')])
    const spawnedFromFork = await sharedApp.kernel.agentSpawn.spawnAgent({
      parentConversationId: forked.id,
      prompt: 'fork conversation normal derive',
    })
    assert.ok(spawnedFromFork !== undefined)
    const run = (await sharedApp.kernel.plugins.invokeAction('builtin:workflow', 'run', {
      script: 'export const meta = { name: "fork-ok", description: "d" }\nreturn 7',
      conversationId: forked.id,
      wait: true,
    })) as { run: { status: string; result: unknown } }
    assert.equal(run.run.status, 'completed')
    assert.equal(run.run.result, 7)

    const directChild = await sharedApp.kernel.conversations.createConversation({
      title: 'direct child',
      profileId: 'assistant',
      parentConversationId: rootId,
    })
    assert.equal(directChild.parentConversationId, rootId)
    sharedFaux.setResponses([fauxAssistantMessage('direct child spawn answer')])
    const spawnedFromDirect = await sharedApp.kernel.agentSpawn.spawnAgent({
      parentConversationId: directChild.id,
      prompt: 'direct child normal derive',
    })
    assert.ok(spawnedFromDirect !== undefined)
  })

  // -------------------------------------------------------------------------
  // 6. Restart restoration: default depth-1 leaf & explicit depth-2 subtree persist
  // -------------------------------------------------------------------------

  test('restart restoration: depth facts persist across restarts for default depth-1 leaf and explicit depth-2 subtree', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth-restart')
    let defaultChildId = 0
    let grantedChild1Id = 0
    let grantedChild2Id = 0
    {
      const faux = makeFauxProvider()
      const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
      try {
        defaultChildId = (await spawnChain(app, faux, [1]))[0]!
        ;[grantedChild1Id, grantedChild2Id] = await spawnChain(
          app,
          faux,
          [1, 0],
          withWorkflowSpawnMeta(undefined, { maxSubagentDepth: 2 }),
        ).catch(async () => {
          const c1 = (await spawnChain(app, faux, [1], withWorkflowSpawnMeta(undefined, { maxSubagentDepth: 2 })))[0]!
          const c2 = (await spawnChain(app, faux, [c1]))[0]!
          return [c1, c2]
        })
      } finally {
        await app.close()
      }
    }
    {
      const faux = makeFauxProvider()
      const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
      try {
        await assert.rejects(
          () => app.kernel.agentSpawn.spawnAgent({ parentConversationId: defaultChildId, prompt: 'after restart default leaf' }),
          (err: unknown) => {
            assert.ok(err instanceof HelmxError && err.code === 'subagent_depth_exceeded')
            const details = err.details as { depth?: number; maxSubagentDepth?: number } | undefined
            assert.equal(details?.depth, 1)
            assert.equal(details?.maxSubagentDepth, 1)
            return true
          },
        )
        await assert.rejects(
          () => app.kernel.agentSpawn.spawnAgent({ parentConversationId: grantedChild2Id, prompt: 'after restart depth-2 leaf' }),
          (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded',
        )
        const newChild2 = (await spawnChain(app, faux, [grantedChild1Id]))[0]!
        assert.ok(newChild2 > 0)
        await app.kernel.kvStore.flush()
        assert.equal(registryEntry(dir, newChild2)['depth'], 2)
        assert.equal(registryEntry(dir, newChild2)['maxSubagentDepth'], 2)
      } finally {
        await app.close()
      }
    }
  })

  // -------------------------------------------------------------------------
  // 7. Corrupt registry entries fail explicitly without guessing (minimal 2-plugin KernelRuntime)
  // -------------------------------------------------------------------------

  test('corrupt registry entries missing depth facts or non-boolean forked fail explicitly (subagent_record_invalid)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth-corrupt')
    let childId = 0
    {
      const faux = makeFauxProvider()
      const kernel = await openMinimalDepthRuntime(dir, faux.provider)
      try {
        let spawnedId: number | undefined
        faux.setResponses([fauxAssistantMessage('subagent answer')])
        await kernel.agentSpawn.spawnAgent({
          parentConversationId: 1,
          prompt: 'seed depth record',
          onResolved: (info) => {
            if (info.conversationId !== undefined) spawnedId = info.conversationId
          },
        })
        assert.ok(spawnedId !== undefined)
        childId = spawnedId
        await kernel.kvStore.flush()
      } finally {
        await kernel.close()
      }
    }
    const existing = registryEntry(dir, childId)
    writeDepthKvRaw(dir, String(childId), { ...existing, forked: 'yes' })
    await assert.rejects(
      () => openMinimalDepthRuntime(dir, makeFauxProvider().provider),
      (err: unknown) => err instanceof HelmxError && err.code === 'subagent_record_invalid',
    )

    writeDepthKvRaw(dir, String(childId), {
      ...(typeof existing['agentType'] === 'string' ? { agentType: existing['agentType'] } : {}),
      createdAt: existing['createdAt'] ?? Date.now(),
    })
    await assert.rejects(
      () => openMinimalDepthRuntime(dir, makeFauxProvider().provider),
      /深度登记无效/,
    )
  })

  // -------------------------------------------------------------------------
  // 8. Explicit ceiling grant: `maxSubagentDepth=3` allows depth 3; invalid values reject
  // -------------------------------------------------------------------------

  test('explicit depth grant: maxSubagentDepth=3 permits depth 3 as leaf; descendants inherit ceiling', { timeout: 60_000 }, async () => {
    const rootId = await createSharedRoot('depth3-explicit')
    await sharedApp.kernel.kvStore.flush()
    const beforeKeys = new Set(Object.keys(readRegistryRaw(sharedDir)))

    const child1 = (await spawnChain(sharedApp, sharedFaux, [rootId], withWorkflowSpawnMeta(undefined, { maxSubagentDepth: 3 })))[0]!
    await sharedApp.kernel.kvStore.flush()
    assert.equal(registryEntry(sharedDir, child1)['maxSubagentDepth'], 3, 'registry should snapshot granted ceiling')
    assert.equal(registryEntry(sharedDir, child1)['depth'], 1)

    const child2 = (await spawnChain(sharedApp, sharedFaux, [child1]))[0]!
    const child3 = (await spawnChain(sharedApp, sharedFaux, [child2]))[0]!
    await sharedApp.kernel.kvStore.flush()
    assert.equal(registryEntry(sharedDir, child2)['maxSubagentDepth'], 3, 'descendant inherits subtree ceiling')
    assert.equal(registryEntry(sharedDir, child3)['depth'], 3)
    await assert.rejects(
      () => sharedApp.kernel.agentSpawn.spawnAgent({ parentConversationId: child3, prompt: 'four layer attempt' }),
      (err: unknown) => {
        assert.ok(err instanceof HelmxError)
        assert.equal(err.code, 'subagent_depth_exceeded')
        const details = err.details as { depth?: number; maxSubagentDepth?: number } | undefined
        assert.equal(details?.depth, 3)
        assert.equal(details?.maxSubagentDepth, 3)
        return true
      },
    )

    for (const invalid of [0, 6, 2.5]) {
      await assert.rejects(
        () =>
          sharedApp.kernel.agentSpawn.spawnAgent({
            parentConversationId: rootId,
            prompt: 'invalid grant',
            meta: withWorkflowSpawnMeta(undefined, { maxSubagentDepth: invalid as number }),
          }),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
      )
    }
    for (const ceiling of [4, 1]) {
      await assert.rejects(
        () =>
          sharedApp.kernel.agentSpawn.spawnAgent({
            parentConversationId: child1,
            prompt: 'out of bounds authorization',
            meta: withWorkflowSpawnMeta(undefined, { maxSubagentDepth: ceiling }),
          }),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
      )
    }
    await sharedApp.kernel.kvStore.flush()
    const registry = readRegistryRaw(sharedDir)
    assert.equal(
      Object.keys(registry).filter((k) => !beforeKeys.has(k)).length,
      3,
      'only the 3 valid chain entries should be registered',
    )
  })

  // -------------------------------------------------------------------------
  // 9. Global config `builtin:workflow.maxSubagentDepth` defaults to 1, persists across restarts
  // -------------------------------------------------------------------------

  test('plugin config builtin:workflow.maxSubagentDepth defaults to 1, persists across restarts, and rejects invalid values', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth-wf-config')
    {
      const faux = makeFauxProvider()
      const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
      try {
        assert.equal(app.kernel.plugins.getConfig('builtin:workflow').maxSubagentDepth, 1)
        for (const invalid of [0, 99, 2.5, Number.NaN]) {
          await assert.rejects(
            () => app.kernel.plugins.setConfig('builtin:workflow', { maxSubagentDepth: invalid }),
            /maxSubagentDepth|field maxSubagentDepth/,
            `invalid config value ${String(invalid)} should be rejected at persistence boundary`,
          )
        }
        assert.equal(app.kernel.plugins.getConfig('builtin:workflow').maxSubagentDepth, 1, 'invalid config must not corrupt valid config')
        await app.kernel.plugins.setConfig('builtin:workflow', { maxSubagentDepth: 2 })
        const child1 = (await spawnChain(app, faux, [1]))[0]!
        const child2 = (await spawnChain(app, faux, [child1]))[0]!
        await assert.rejects(
          () => app.kernel.agentSpawn.spawnAgent({ parentConversationId: child2, prompt: 'exceeds global two layer' }),
          (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded',
        )
      } finally {
        await app.close()
      }
    }
    const faux = makeFauxProvider()
    const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      assert.equal(app.kernel.plugins.getConfig('builtin:workflow').maxSubagentDepth, 2)
      const child1 = (await spawnChain(app, faux, [1]))[0]!
      const child2 = (await spawnChain(app, faux, [child1]))[0]!
      await assert.rejects(
        () => app.kernel.agentSpawn.spawnAgent({ parentConversationId: child2, prompt: 'after restart still over limit' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded',
      )
      await app.kernel.plugins.setConfig('builtin:workflow', { maxSubagentDepth: null })
      assert.equal(app.kernel.plugins.getConfig('builtin:workflow').maxSubagentDepth, 1)
      const defaultChild = (await spawnChain(app, faux, [1]))[0]!
      await assert.rejects(
        () => app.kernel.agentSpawn.spawnAgent({ parentConversationId: defaultChild, prompt: 'reset back to 1' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded',
      )
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 10. Fork default leaf ceiling (even under global maxSubagentDepth=2) + explicit opt-in
  // -------------------------------------------------------------------------

  test('fork: true defaults to leaf (ceiling=1) even when global config is 2; explicit maxSubagentDepth=2 opts in', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'fork-leaf-default')
    let childIdForResume: number | undefined
    let topLevelMeta: ReturnType<typeof captureModelRequest> | undefined
    let childMeta: ReturnType<typeof captureModelRequest> | undefined
    let resumedChildMeta: ReturnType<typeof captureModelRequest> | undefined
    let afterRestartMeta: ReturnType<typeof captureModelRequest> | undefined

    const step: FauxResponseFactory = (context) => {
      const req = captureModelRequest(context.messages)
      const lastUser = req.userTexts.at(-1) ?? ''
      if (req.lastNonSystemRole === 'user' && lastUser.includes('FORK_FACT_42')) {
        topLevelMeta = req
        return fauxAssistantMessage('recorded FORK_FACT_42')
      }
      if (req.lastNonSystemRole === 'user' && lastUser.includes('delegate forked leaf')) {
        return fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: 'execute forked leaf work', fork: true, background: false }, { id: 'call-fork-leaf' })],
          { stopReason: 'toolUse' },
        )
      }
      if (req.lastNonSystemRole === 'user' && lastUser.includes('execute forked leaf work')) {
        childMeta = req
        return fauxAssistantMessage('forked leaf finished')
      }
      if (req.lastNonSystemRole === 'toolResult' && req.lastToolName === 'subagent' && lastUser.includes('delegate forked leaf')) {
        return fauxAssistantMessage('parent received forked leaf')
      }
      if (req.lastNonSystemRole === 'user' && lastUser.includes('resume forked leaf caller')) {
        assert.ok(childIdForResume !== undefined)
        return fauxAssistantMessage(
          [fauxToolCall('subagent', { resume: String(childIdForResume), prompt: 'resume forked leaf work', background: false }, { id: 'call-fork-resume' })],
          { stopReason: 'toolUse' },
        )
      }
      if (req.lastNonSystemRole === 'user' && lastUser.includes('resume forked leaf work')) {
        resumedChildMeta = req
        return fauxAssistantMessage('resumed forked leaf finished')
      }
      if (req.lastNonSystemRole === 'toolResult' && req.lastToolName === 'subagent' && lastUser.includes('resume forked leaf caller')) {
        return fauxAssistantMessage('parent received resumed forked leaf')
      }
      if (req.lastNonSystemRole === 'user' && lastUser.includes('post-restart forked check')) {
        afterRestartMeta = req
        return fauxAssistantMessage('post-restart forked ok')
      }
      throw new Error(`unexpected faux request: role=${req.lastNonSystemRole}, lastUser=${lastUser}`)
    }

    let persistedChildId = 0
    {
      const faux = makeFauxProvider()
      faux.setResponses(Array.from({ length: 16 }, () => step))
      const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
      try {
        if (app.kernel.plugins.get('builtin:title')?.enabled) {
          await app.kernel.plugins.setConfig('builtin:title', { autoTitle: false })
        }
        await app.kernel.plugins.setConfig('builtin:workflow', { maxSubagentDepth: 2 })
        await app.kernel.services.profiles.save({ id: 'coder', name: '编码专家' })

        await app.kernel.conversations.submitInput(1, 'remember FORK_FACT_42')
        await app.kernel.conversations.waitForIdle(1)
        assert.ok(typeof topLevelMeta?.sectionsById['profile.catalog'] === 'string')

        await app.kernel.conversations.submitInput(1, 'delegate forked leaf')
        await app.kernel.conversations.waitForIdle(1)

        const child = app.kernel.conversations.listConversations().find((c) => c.parentConversationId === 1)
        assert.ok(child, 'fork: true should spawn a child conversation')
        persistedChildId = child.id
        childIdForResume = child.id

        await app.kernel.kvStore.flush()
        const entry = registryEntry(dir, child.id)
        assert.equal(entry['depth'], 1)
        assert.equal(entry['maxSubagentDepth'], 1, 'fork: true still defaults to leaf even when global maxSubagentDepth=2')
        assert.equal(entry['forked'], true)

        assert.ok(childMeta)
        assert.equal(childMeta.toolNames.includes('subagent'), false)
        assert.equal(childMeta.toolNames.includes('SubagentWorkflow'), false)
        assert.equal(childMeta.toolNames.includes('bash'), true)
        assert.equal(childMeta.sectionsById['profile.catalog'], undefined)
        const forkSection = childMeta.sectionsById['workflow.forked_context'] ?? ''
        assert.ok(forkSection.includes('<forked_subagent_context>'))
        assert.ok(forkSection.includes('ALREADY been fulfilled'))

        await assert.rejects(
          () => app.kernel.agentSpawn.spawnAgent({ parentConversationId: child.id, prompt: 'forbidden nested spawn' }),
          (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded' && err.status === 403,
        )
        await assert.rejects(
          () =>
            app.kernel.plugins.invokeAction('builtin:workflow', 'run', {
              script: 'export const meta = { name: "blocked", description: "d" }\nreturn 1',
              conversationId: child.id,
            }),
          (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded' && err.status === 403,
        )

        await app.kernel.conversations.submitInput(1, 'resume forked leaf caller')
        await app.kernel.conversations.waitForIdle(1)
        assert.ok(resumedChildMeta)
        assert.equal(resumedChildMeta.toolNames.includes('subagent'), false)
        assert.equal(resumedChildMeta.toolNames.includes('SubagentWorkflow'), false)
        assert.equal(resumedChildMeta.sectionsById['profile.catalog'], undefined)
        assert.ok((resumedChildMeta.sectionsById['workflow.forked_context'] ?? '').includes('<forked_subagent_context>'))

        await app.kernel.kvStore.flush()
        const afterResumeEntry = registryEntry(dir, child.id)
        assert.equal(afterResumeEntry['maxSubagentDepth'], 1)
        assert.equal(afterResumeEntry['forked'], true)
      } finally {
        await app.close()
      }
    }

    // Real Hub restart on same dataDir preserves leaf ceiling and forked fact.
    {
      const faux = makeFauxProvider()
      faux.setResponses(Array.from({ length: 8 }, () => step))
      const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
      try {
        const entry = registryEntry(dir, persistedChildId)
        assert.equal(entry['depth'], 1)
        assert.equal(entry['maxSubagentDepth'], 1)
        assert.equal(entry['forked'], true)
        await assert.rejects(
          () => app.kernel.agentSpawn.spawnAgent({ parentConversationId: persistedChildId, prompt: 'post-restart nested spawn' }),
          (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded' && err.status === 403,
        )
        await app.kernel.conversations.submitInput(persistedChildId, 'post-restart forked check')
        await app.kernel.conversations.waitForIdle(persistedChildId)
        assert.ok(afterRestartMeta)
        assert.equal(afterRestartMeta.toolNames.includes('subagent'), false)
        assert.equal(afterRestartMeta.toolNames.includes('SubagentWorkflow'), false)
        assert.equal(afterRestartMeta.sectionsById['profile.catalog'], undefined)
        assert.ok((afterRestartMeta.sectionsById['workflow.forked_context'] ?? '').includes('<forked_subagent_context>'))
      } finally {
        await app.close()
      }
    }

    // Explicit maxSubagentDepth=2 opt-in on fork: true on sharedApp (whose global default is 1).
    const rootId = await createSharedRoot('fork-explicit-depth2')
    let depth1Meta: ReturnType<typeof captureModelRequest> | undefined
    let depth2Meta: ReturnType<typeof captureModelRequest> | undefined

    const optInStep: FauxResponseFactory = (context) => {
      const req = captureModelRequest(context.messages)
      const lastUser = req.userTexts.at(-1) ?? ''
      if (req.lastNonSystemRole === 'user' && lastUser.includes('OPT_IN_DEPTH2')) {
        return fauxAssistantMessage('recorded OPT_IN_DEPTH2')
      }
      if (req.lastNonSystemRole === 'user' && lastUser.includes('delegate opt-in fork')) {
        return fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: 'depth1 forked task', fork: true, maxSubagentDepth: 2, background: false }, { id: 'call-optin-d1' })],
          { stopReason: 'toolUse' },
        )
      }
      if (req.lastNonSystemRole === 'user' && lastUser.includes('depth1 forked task')) {
        depth1Meta = req
        return fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: 'depth2 leaf task', background: false }, { id: 'call-optin-d2' })],
          { stopReason: 'toolUse' },
        )
      }
      if (req.lastNonSystemRole === 'user' && lastUser.includes('depth2 leaf task')) {
        depth2Meta = req
        return fauxAssistantMessage('depth2 leaf finished')
      }
      if (req.lastNonSystemRole === 'toolResult' && req.lastToolName === 'subagent' && lastUser.includes('depth1 forked task')) {
        return fauxAssistantMessage('depth1 forked finished')
      }
      if (req.lastNonSystemRole === 'toolResult' && req.lastToolName === 'subagent' && lastUser.includes('delegate opt-in fork')) {
        return fauxAssistantMessage('parent opt-in finished')
      }
      throw new Error(`unexpected optInStep faux request: role=${req.lastNonSystemRole}, lastUser=${lastUser}`)
    }

    sharedFaux.setResponses(Array.from({ length: 16 }, () => optInStep))
    await sharedApp.kernel.conversations.submitInput(rootId, 'seed OPT_IN_DEPTH2')
    await sharedApp.kernel.conversations.waitForIdle(rootId)
    await sharedApp.kernel.conversations.submitInput(rootId, 'delegate opt-in fork')
    await sharedApp.kernel.conversations.waitForIdle(rootId)

    const child1 = sharedApp.kernel.conversations.listConversations().find((c) => c.parentConversationId === rootId)
    assert.ok(child1, 'depth-1 forked child should exist')
    await sharedApp.kernel.conversations.waitForIdle(child1.id)
    const child2 = sharedApp.kernel.conversations.listConversations().find((c) => c.parentConversationId === child1.id)
    assert.ok(child2, 'depth-1 forked child with explicit maxSubagentDepth=2 should spawn depth-2 child')

    assert.ok(depth1Meta)
    assert.ok(depth1Meta.toolNames.includes('subagent') && depth1Meta.toolNames.includes('SubagentWorkflow'))
    assert.ok(typeof depth1Meta.sectionsById['profile.catalog'] === 'string')
    assert.ok((depth1Meta.sectionsById['workflow.forked_context'] ?? '').includes('<forked_subagent_context>'))

    assert.ok(depth2Meta)
    assert.equal(depth2Meta.toolNames.includes('subagent'), false)
    assert.equal(depth2Meta.toolNames.includes('SubagentWorkflow'), false)
    assert.equal(depth2Meta.sectionsById['profile.catalog'], undefined)
    assert.equal(depth2Meta.sectionsById['workflow.forked_context'], undefined)

    await sharedApp.kernel.kvStore.flush()
    const e1 = registryEntry(sharedDir, child1.id)
    assert.equal(e1['depth'], 1)
    assert.equal(e1['maxSubagentDepth'], 2)
    assert.equal(e1['forked'], true)
    const e2 = registryEntry(sharedDir, child2.id)
    assert.equal(e2['depth'], 2)
    assert.equal(e2['maxSubagentDepth'], 2)
    assert.equal(e2['forked'], undefined)

    await assert.rejects(
      () => sharedApp.kernel.agentSpawn.spawnAgent({ parentConversationId: child2.id, prompt: 'depth3 forbidden' }),
      (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded' && err.status === 403,
    )
  })
})
