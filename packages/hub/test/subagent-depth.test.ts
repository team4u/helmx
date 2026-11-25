/**
 * Subagent nesting depth contract: `builtin:workflow` managed subagents can nest up to 2 levels by default.
 *
 * Source of truth (persisted across restarts): plugin-private doc `subagent-conversations` registers child
 * conversations spawned through the `agent_spawn` pipeline (`onResolved` returns `conversationId`),
 * recording `depth` / `parentConversationId` / `maxSubagentDepth` (subtree ceiling snapshot).
 * Forked conversations and SuperAgent workers (created via `createConversation`, bypassing `spawn`)
 * stay outside the registry and are not subject to nesting caps. Missing/corrupt entries fail explicitly.
 *
 * Three enforcement layers:
 * 1. `before_turn`: strips `subagent` / `SubagentWorkflow` on leaf turns at the subtree ceiling
 *    (depth-1 subagents keep dispatch tools so they can dispatch depth-2 children);
 * 2. Tool/action boundaries: `subagent` tool, `SubagentWorkflow` tool, and `run` action reject before creating
 *    any run record (`HelmxError('subagent_depth_exceeded')`, carrying facts);
 * 3. `agent_spawn` highest-priority fallback (priority 300, ahead of isolation=200 worktree allocation):
 *    direct `kernel.spawnAgent` calls also reject without recording new entries.
 *
 * Explicit grants: `AgentSpawnRequest.maxSubagentDepth` (and `subagent` tool param) can grant a subtree ceiling
 * (1..5), while managed subagents cannot raise their inherited ceiling; plugin config exposes a global default.
 *
 * Honesty discipline: all real execution (faux model, real child conversations, real doc persistence, real
 * restarts), no mocked engine, no fabricated rejection results.
 */

import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai/providers/faux'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import { HelmxError } from '@helmx/protocol'
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
})

after(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

/** Reads the persisted private depth KV namespace directly from `state.sqlite` after flushing (verifies restart source of truth). */
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

/**
 * Spawns a real child conversation chain (matching production `onResolved` + registry behavior):
 * each entry in `parents` acts as parent for the next spawned child; returns created child IDs.
 */
async function spawnChain(
  app: Awaited<ReturnType<typeof createHelmx>>,
  faux: FauxProviderHandle,
  parents: number[],
): Promise<number[]> {
  const created: number[] = []
  for (const parent of parents) {
    let childId: number | undefined
    faux.setResponses([fauxAssistantMessage(`subagent ${parent} answer`)])
    await app.kernel.agentSpawn.spawnAgent({
      parentConversationId: parent,
      prompt: `from ${parent} derive`,
      onResolved: (info) => {
        if (info.conversationId !== undefined) childId = info.conversationId
      },
    })
    assert.ok(childId !== undefined, `should spawn child from ${parent} and return conversationId`)
    created.push(childId)
  }
  return created
}



// ---------------------------------------------------------------------------
// 1. Depth 1 from top-level: fact registration + depth-1 subagent retains dispatch tools
// ---------------------------------------------------------------------------

describe('workflow subagent depth contract (default ceiling 2)', { timeout: 60_000 }, () => {
  test('top-level spawn depth=1: records depth/parent/ceiling=2; depth-1 subagent keeps subagent/SubagentWorkflow', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth1')
    const faux = makeFauxProvider()
    const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      // Top-level: spawn a subagent (real native spawn, real child conversation, synchronous wait).
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: 'sub- task', background: false })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('subagent answer'),
        fauxAssistantMessage('main turn complete'),
      ])
      await app.kernel.conversations.submitInput(1, 'derive subagent')
      await app.kernel.conversations.waitForIdle(1)

      const child = app.kernel.conversations.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child, 'top-level spawn should create a real child conversation')

      // Registry: private doc persists depth fact (survives restart).
      await app.kernel.kvStore.flush()
      const entry = registryEntry(dir, child.id)
      assert.equal(entry['depth'], 1, 'direct child of top-level conversation has depth=1')
      assert.equal(entry['parentConversationId'], 1)
      assert.equal(entry['maxSubagentDepth'], 2, 'default subtree ceiling is 2')

      // Depth-1 subagent `before_turn`: dispatch tools are preserved (can still dispatch depth-2).
      let childTools: string[] | undefined
      await app.kernel.plugins.register({
        id: 'test:depth-observer',
        name: 'deep observer',
        definePlugin(ctx) {
          ctx.hook.onBeforeTurn((turn) => {
            const payload = turn as unknown as { conversation: { id: number }; tools: Array<{ name: string }> }
            if (payload.conversation.id === child.id) {
              childTools = payload.tools.map((t) => t.name)
            }
          })
        },
      })
      faux.setResponses([fauxAssistantMessage('one layer subagent directly answer')])
      await app.kernel.conversations.submitInput(child.id, 'subagent by mention question')
      await app.kernel.conversations.waitForIdle(child.id)
      assert.ok(childTools, 'should observe tool list on subagent turn')
      assert.ok(
        childTools!.includes('subagent') && childTools!.includes('SubagentWorkflow'),
        `depth-1 subagent turn should retain dispatch tools (actual: ${childTools!.join(',')})`,
      )
      assert.ok(childTools!.includes('bash'), 'non-dispatch tools stay intact (bash present)')
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 2. Depth-1 subagent spawns depth-2 child: depth=2 recorded; depth-2 turn strips dispatch tools
  // -------------------------------------------------------------------------

  test('depth-1 subagent spawns depth-2 via subagent tool: records depth=2; depth-2 strips dispatch tools', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth2')
    const faux = makeFauxProvider()
    const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      // Deterministic FIFO consumption order for synchronous nested spawns:
      // top-level toolUse(subagent) -> depth-1 toolUse(subagent) -> depth-2 text -> depth-1 text -> top-level text.
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: 'one layer task', background: false })], { stopReason: 'toolUse' }),
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: 'two layer task', background: false })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('two layer subagent answer'),
        fauxAssistantMessage('one layer subagent complete'),
        fauxAssistantMessage('main turn complete'),
      ])
      await app.kernel.conversations.submitInput(1, 'derive one layer, let it continue dispatch two layer')
      await app.kernel.conversations.waitForIdle(1)

      const child1 = app.kernel.conversations.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child1, 'should spawn depth-1 child conversation')
      await app.kernel.conversations.waitForIdle(child1.id)
      const child2 = app.kernel.conversations.listConversations().find((c) => c.parentConversationId === child1.id)
      assert.ok(child2, 'depth-1 subagent should spawn depth-2 child conversation via tool')

      await app.kernel.kvStore.flush()
      const e1 = registryEntry(dir, child1.id)
      assert.equal(e1['depth'], 1)
      assert.equal(e1['parentConversationId'], 1)
      const e2 = registryEntry(dir, child2.id)
      assert.equal(e2['depth'], 2, 'depth-2 subagent has depth=2')
      assert.equal(e2['parentConversationId'], child1.id)
      assert.equal(e2['maxSubagentDepth'], 2, 'subtree ceiling inherits parent effective ceiling')

      // Depth-2 `before_turn`: dispatch tools are stripped at the ceiling (leaf).
      let leafTools: string[] | undefined
      await app.kernel.plugins.register({
        id: 'test:depth-observer',
        name: 'deep observer',
        definePlugin(ctx) {
          ctx.hook.onBeforeTurn((turn) => {
            const payload = turn as unknown as { conversation: { id: number }; tools: Array<{ name: string }> }
            if (payload.conversation.id === child2.id) {
              leafTools = payload.tools.map((t) => t.name)
            }
          })
        },
      })
      faux.setResponses([fauxAssistantMessage('two layer leaf only can directly answer')])
      await app.kernel.conversations.submitInput(child2.id, 'leaf by mention question')
      await app.kernel.conversations.waitForIdle(child2.id)
      assert.ok(leafTools, 'should observe tool list on depth-2 turn')
      assert.ok(
        !leafTools!.includes('subagent') && !leafTools!.includes('SubagentWorkflow'),
        `depth-2 subagent turn should strip dispatch tools (actual: ${leafTools!.join(',')})`,
      )
      assert.ok(leafTools!.includes('bash'), 'non-dispatch tools stay intact (bash present)')
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 3. Depth-2 rejection: spawnAgent fallback + run action entry, zero side effects
  // ---------------------------------------------------------------------------

  test('depth-2 rejects further spawns (403 subagent_depth_exceeded) and run actions with no run records; depth-1 still allowed', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth3')
    const faux = makeFauxProvider()
    const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      const child1 = (await spawnChain(app, faux, [1]))[0]!
      const child2 = (await spawnChain(app, faux, [child1]))[0]!

      // Direct call (with `isolation: 'worktree'` — must reject prior to worktree allocation with zero git/lease side effects).
      await assert.rejects(
        () =>
          app.kernel.agentSpawn.spawnAgent({
            parentConversationId: child2,
            prompt: 'attempt dispatch three layer',
            isolation: 'worktree',
          }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError, `expected HelmxError (got ${String(err)})`)
          assert.equal(err.code, 'subagent_depth_exceeded')
          assert.equal(err.status, 403)
          const details = err.details as { depth?: number; maxSubagentDepth?: number } | undefined
          assert.equal(details?.depth, 2, 'error details should report depth=2')
          assert.equal(details?.maxSubagentDepth, 2)
          return true
        },
      )

      // `run` action (HTTP/CLI path) targeting depth-2 conversation rejects.
      await assert.rejects(
        () =>
          app.kernel.plugins.invokeAction('builtin:workflow', 'run', {
            script: 'export const meta = { name: "t", description: "d" }\nreturn 1',
            conversationId: child2,
          }),
        (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded',
      )

      // Zero run records created.
      const runs = (await app.kernel.plugins.invokeAction('builtin:workflow', 'runs', {})) as {
        runs: Array<{ id: string }>
      }
      assert.equal(runs.runs.length, 0, 'rejected path must not create run records')

      // Depth-1 control: direct `spawnAgent` succeeds (depth-1 can spawn depth-2).
      const anotherChild2 = (await spawnChain(app, faux, [child1]))[0]!
      assert.ok(anotherChild2 > 0)
      await app.kernel.kvStore.flush()
      assert.equal(registryEntry(dir, anotherChild2)['depth'], 2)
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 4. Depth-1 subagent can run workflows (`run` action allowed); engine nodes register at depth=2
  // -------------------------------------------------------------------------

  test('depth-1 subagent can run SubagentWorkflow: run action succeeds and engine node registers at depth=2', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth4')
    const faux = makeFauxProvider()
    const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      const child1 = (await spawnChain(app, faux, [1]))[0]!
      faux.setResponses([fauxAssistantMessage('engine node subagent answer')])
      const run = (await app.kernel.plugins.invokeAction('builtin:workflow', 'run', {
        script:
          'export const meta = { name: "nested-one", description: "d" }\nconst t = await agent("node task")\nreturn t',
        conversationId: child1,
        wait: true,
      })) as { run: { status: string; result: unknown; nodes?: Array<{ conversationId?: number }> } }
      assert.equal(run.run.status, 'completed', JSON.stringify(run.run))
      const nodeConv = run.run.nodes?.find((n) => n.conversationId !== undefined)?.conversationId
      assert.ok(nodeConv, 'engine node should spawn a real child conversation')
      await app.kernel.kvStore.flush()
      const entry = registryEntry(dir, nodeConv)
      assert.equal(entry['depth'], 2, 'engine node spawned from depth-1 registers with depth=2')
      assert.equal(entry['parentConversationId'], child1)
      // Depth-2 node is a leaf: direct `spawnAgent` rejects.
      await assert.rejects(
        () => app.kernel.agentSpawn.spawnAgent({ parentConversationId: nodeConv, prompt: 'three layer attempt' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded',
      )
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 5. Background rejection contract: managed subagent (`helmx`-owned) rejects explicit `background: true`
  // -------------------------------------------------------------------------

  test('managed subagent rejects explicit background: true with no spawn/run; sync default continues working', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth5')
    const faux = makeFauxProvider()
    const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      const child1 = (await spawnChain(app, faux, [1]))[0]!
      // Depth-1 subagent is a `helmx`-owned autonomous conversation: explicit `background: true` must fail
      // without silently downgrading to sync, spawning a child, or creating a run (prevents premature parent return).
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: 'by refuse background task', background: true })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('one layer continue answer'),
      ])
      await app.kernel.conversations.submitInput(child1, 'dispatch a background subagent')
      await app.kernel.conversations.waitForIdle(child1)

      const detail = await app.kernel.conversations.getConversationDetail(child1, { limit: 30 })
      const toolText = [...detail.entries]
        .reverse()
        .map((e) => JSON.stringify(e.model ?? ''))
        .find((t) => t.includes('"subagent"')) ?? ''
      assert.ok(
        toolText.includes('subagent_failed') && toolText.includes('background'),
        `rejection message should state that background is disallowed: ${toolText.slice(0, 300)}`,
      )
      const { runs } = (await app.kernel.plugins.invokeAction('builtin:workflow', 'runs', {
        conversationId: child1,
      })) as { runs: Array<{ id: string; kind?: string }> }
      assert.equal(runs.length, 0, 'rejected call must not create any run record')
      assert.equal(
        app.kernel.conversations.listConversations().filter((c) => c.parentConversationId === child1).length,
        0,
        'rejected call must not spawn a child conversation',
      )

      // Default (omitting `background`) on the same managed conversation stays synchronous and waits for the result.
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: 'sync two layer task' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('sync two layer answer'),
        fauxAssistantMessage('one layer sync continue answer'),
      ])
      await app.kernel.conversations.submitInput(child1, 'again dispatch a sync subagent')
      await app.kernel.conversations.waitForIdle(child1)
      const child2 = app.kernel.conversations.listConversations().find((c) => c.parentConversationId === child1)
      assert.ok(child2, 'default sync invocation should spawn depth-2 child conversation')
      await app.kernel.kvStore.flush()
      const entry = registryEntry(dir, child2.id)
      assert.equal(entry['depth'], 2, 'sync depth-2 subagent also registers with depth=2')

      // Depth-2 subagent is a leaf: direct `spawnAgent` rejects.
      await assert.rejects(
        () => app.kernel.agentSpawn.spawnAgent({ parentConversationId: child2.id, prompt: 'three layer attempt' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded',
      )
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 6. Forked conversations are not misclassified
  // -------------------------------------------------------------------------

  test('forked conversations (with parentConversationId) are unaffected: spawn and run actions remain available', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth6')
    const faux = makeFauxProvider()
    const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      // Complete one top-level turn to obtain a forkable entry.
      faux.setResponses([fauxAssistantMessage('top-level answer')])
      await app.kernel.conversations.submitInput(1, '你好')
      await app.kernel.conversations.waitForIdle(1)
      const detail = await app.kernel.conversations.getConversationDetail(1, { limit: 10 })
      const numericEntry = detail.entries.find((e) => Number.isInteger(Number(e.id)) && Number(e.id) > 0)
      assert.ok(numericEntry, 'should have a forkable entry (numeric entryId)')
      const entryId = Number(numericEntry!.id)

      const forked = await app.kernel.conversations.forkConversation(1, { entryId })
      assert.equal(forked.parentConversationId, 1, 'forked conversation carries parentConversationId')

      // Fork is outside the registry: both `spawnAgent` and `run` action succeed.
      faux.setResponses([fauxAssistantMessage('fork subagent answer')])
      const spawned = await app.kernel.agentSpawn.spawnAgent({
        parentConversationId: forked.id,
        prompt: 'fork conversation normal derive',
      })
      assert.ok(spawned !== undefined)
      const run = (await app.kernel.plugins.invokeAction('builtin:workflow', 'run', {
        script: 'export const meta = { name: "fork-ok", description: "d" }\nreturn 7',
        conversationId: forked.id,
        wait: true,
      })) as { run: { status: string; result: unknown } }
      assert.equal(run.run.status, 'completed')
      assert.equal(run.run.result, 7)
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 7. Non-spawn child conversations are not misclassified (have parentConversationId, but bypass spawn)
  // -------------------------------------------------------------------------

  test('non-spawn child conversations are unaffected: direct createConversation children can spawn subagents normally', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth7')
    const faux = makeFauxProvider()
    const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      const worker = await app.kernel.conversations.createConversation({
        title: 'direct child worker',
        profileId: 'assistant',
        parentConversationId: 1,
      })
      assert.equal(worker.parentConversationId !== undefined, true, 'child conversation has parentConversationId')

      // Direct child is outside the managed-subagent registry: `spawnAgent` succeeds.
      faux.setResponses([fauxAssistantMessage('worker derive subagent answer')])
      const spawned = await app.kernel.agentSpawn.spawnAgent({
        parentConversationId: worker.id,
        prompt: 'worker normal derive',
      })
      assert.ok(spawned !== undefined)
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 8. Restart restoration: depth/parent facts persist across restarts
  // -------------------------------------------------------------------------

  test('restart restoration: depth facts persist across restarts (depth-2 still rejects, depth-1 can still spawn)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth8')
    {
      const faux = makeFauxProvider()
      const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
      try {
        const child1 = (await spawnChain(app, faux, [1]))[0]!
        await spawnChain(app, faux, [child1])
      } finally {
        await app.close()
      }
    }
    // Restart on the same `dataDir`: registry facts remain in effect.
    {
      const faux = makeFauxProvider()
      const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
      try {
        const child1 = app.kernel.conversations.listConversations().find((c) => c.parentConversationId === 1)
        assert.ok(child1, 'depth-1 child conversation should restore after restart')
        const child2 = app.kernel.conversations
          .listConversations()
          .find((c) => c.parentConversationId === child1.id)
        assert.ok(child2, 'depth-2 child conversation should restore after restart')

        await assert.rejects(
          () =>
            app.kernel.agentSpawn.spawnAgent({
              parentConversationId: child2.id,
              prompt: 'after restart dispatch three layer',
            }),
          (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded',
        )
        // Depth-1 control still allowed (can spawn a new depth-2 child after restart).
        const newChild2 = (await spawnChain(app, faux, [child1.id]))[0]!
        assert.ok(newChild2 > 0)
        await app.kernel.kvStore.flush()
        assert.equal(registryEntry(dir, newChild2)['depth'], 2)
      } finally {
        await app.close()
      }
    }
  })

  // -------------------------------------------------------------------------
  // 9. No legacy fallback: corrupt entries missing depth/ceiling fail explicitly
  // -------------------------------------------------------------------------

  test('corrupt registry entries missing depth facts fail explicitly without guessing', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth9')
    let legacyChildId = 0
    {
      const faux = makeFauxProvider()
      const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
      try {
        const child1 = (await spawnChain(app, faux, [1]))[0]!
        legacyChildId = child1
        await app.kernel.kvStore.flush()
      } finally {
        await app.close()
      }
    }
    // Simulate legacy record by stripping new fields (`agentType`/`createdAt` only).
    {
      const registry = readRegistryRaw(dir)
      const legacy = registry[String(legacyChildId)] as Record<string, unknown>
      assert.ok(legacy, 'child conversation should have a registry entry')
      writeDepthKvRaw(dir, String(legacyChildId), {
        ...(typeof legacy['agentType'] === 'string' ? { agentType: legacy['agentType'] } : {}),
        createdAt: legacy['createdAt'] ?? Date.now(),
      })
    }
    const faux = makeFauxProvider()
    await assert.rejects(
      () => createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] }),
      /深度登记无效/,
    )
  })

  // -------------------------------------------------------------------------
  // 10. Explicit ceiling grant: `maxSubagentDepth=3` allows depth 3; invalid values reject
  // -------------------------------------------------------------------------

  test('explicit depth grant: maxSubagentDepth=3 permits depth 3 as leaf; descendants inherit ceiling', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth10')
    const faux = makeFauxProvider()
    const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      faux.setResponses([fauxAssistantMessage('one layer answer')])
      let grantedChild = 0
      await app.kernel.agentSpawn.spawnAgent({
        parentConversationId: 1,
        prompt: 'grant three layer sub- tree',
        meta: withWorkflowSpawnMeta(undefined, { maxSubagentDepth: 3 }),
        onResolved: (info) => {
          if (info.conversationId !== undefined) grantedChild = info.conversationId
        },
      })
      assert.ok(grantedChild > 0, 'should spawn child conversation and return conversationId')
      const child1 = grantedChild
      await app.kernel.kvStore.flush()
      assert.equal(registryEntry(dir, child1)['maxSubagentDepth'], 3, 'registry should snapshot granted ceiling')
      assert.equal(registryEntry(dir, child1)['depth'], 1)

      // Full 3-level chain succeeds (1 -> 2 -> 3), with depth 3 as the leaf.
      const child2 = (await spawnChain(app, faux, [child1]))[0]!
      const child3 = (await spawnChain(app, faux, [child2]))[0]!
      await app.kernel.kvStore.flush()
      assert.equal(registryEntry(dir, child2)['maxSubagentDepth'], 3, 'descendant inherits subtree ceiling')
      assert.equal(registryEntry(dir, child3)['depth'], 3)
      await assert.rejects(
        () => app.kernel.agentSpawn.spawnAgent({ parentConversationId: child3, prompt: 'four layer attempt' }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError)
          assert.equal(err.code, 'subagent_depth_exceeded')
          const details = err.details as { depth?: number; maxSubagentDepth?: number } | undefined
          assert.equal(details?.depth, 3)
          assert.equal(details?.maxSubagentDepth, 3)
          return true
        },
      )

      // Out-of-range / non-integer values reject explicitly without silent clamping.
      for (const invalid of [0, 6, 2.5]) {
        await assert.rejects(
          () =>
            app.kernel.agentSpawn.spawnAgent({
              parentConversationId: 1,
              prompt: 'invalid grant',
              meta: withWorkflowSpawnMeta(undefined, { maxSubagentDepth: invalid as number }),
            }),
          (err: unknown) => {
            assert.ok(err instanceof HelmxError, `maxSubagentDepth=${invalid} should throw HelmxError`)
            assert.equal(err.code, 'validation_error')
            return true
          },
        )
      }
      // Subagents cannot raise their inherited ceiling or override below target depth.
      for (const ceiling of [4, 1]) {
        await assert.rejects(
          () =>
            app.kernel.agentSpawn.spawnAgent({
              parentConversationId: child1,
              prompt: 'out of bounds authorization',
              meta: withWorkflowSpawnMeta(undefined, { maxSubagentDepth: ceiling }),
            }),
          (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
        )
      }
      // Rejected paths record no new registry entries.
      await app.kernel.kvStore.flush()
      const registry = readRegistryRaw(dir)
      assert.equal(Object.keys(registry).length, 3, 'only the 3 valid chain entries should be registered')
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 11. Global config updated via host port persists across restarts for new subtrees
  // -------------------------------------------------------------------------

  test('plugin config maxSubagentDepth persists across restarts and rejects invalid values', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth11')
    {
      const faux = makeFauxProvider()
      const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
      try {
        assert.equal(app.kernel.plugins.getConfig('builtin:workflow').maxSubagentDepth, 2)
        for (const invalid of [0, 99, 2.5, Number.NaN]) {
          await assert.rejects(
            () => app.kernel.plugins.setConfig('builtin:workflow', { maxSubagentDepth: invalid }),
            /maxSubagentDepth|field maxSubagentDepth/,
            `invalid config value ${String(invalid)} should be rejected at persistence boundary`,
          )
        }
        assert.equal(app.kernel.plugins.getConfig('builtin:workflow').maxSubagentDepth, 2, 'invalid config must not corrupt valid config')
        await app.kernel.plugins.setConfig('builtin:workflow', { maxSubagentDepth: 1 })
        const child = (await spawnChain(app, faux, [1]))[0]!
        await assert.rejects(
          () => app.kernel.agentSpawn.spawnAgent({ parentConversationId: child, prompt: 'exceeds global one layer' }),
          (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded',
        )
      } finally {
        await app.close()
      }
    }
    const faux = makeFauxProvider()
    const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      assert.equal(app.kernel.plugins.getConfig('builtin:workflow').maxSubagentDepth, 1)
      const child = (await spawnChain(app, faux, [1]))[0]!
      await assert.rejects(
        () => app.kernel.agentSpawn.spawnAgent({ parentConversationId: child, prompt: 'after restart still over limit' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded',
      )
      await app.kernel.plugins.setConfig('builtin:workflow', { maxSubagentDepth: null })
      assert.equal(app.kernel.plugins.getConfig('builtin:workflow').maxSubagentDepth, 2)
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 12. Fork default leaf ceiling + boundary section + resume & restart persistence
  // -------------------------------------------------------------------------

  test('fork: true defaults to leaf (depth=1, ceiling=1, forked=true), strips dispatch tools & catalog, injects forked_context, and persists across resume & restart', { timeout: 60_000 }, async () => {
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
        await app.kernel.services.profiles.save({ id: 'coder', name: '编码专家' })

        await app.kernel.conversations.submitInput(1, 'remember FORK_FACT_42')
        await app.kernel.conversations.waitForIdle(1)
        assert.ok(typeof topLevelMeta?.sectionsById['profile.catalog'] === 'string', 'top-level should inject profile.catalog when another Profile exists')

        await app.kernel.conversations.submitInput(1, 'delegate forked leaf')
        await app.kernel.conversations.waitForIdle(1)

        const child = app.kernel.conversations.listConversations().find((c) => c.parentConversationId === 1)
        assert.ok(child, 'fork: true should spawn a child conversation')
        persistedChildId = child.id
        childIdForResume = child.id

        await app.kernel.kvStore.flush()
        const entry = registryEntry(dir, child.id)
        assert.equal(entry['depth'], 1)
        assert.equal(entry['maxSubagentDepth'], 1, 'fork: true without explicit maxSubagentDepth defaults to leaf at child depth')
        assert.equal(entry['forked'], true, 'depth KV must persist forked: true fact')
        assert.equal(entry['parentConversationId'], 1)

        assert.ok(childMeta, 'should capture forked child model request')
        assert.equal(childMeta.toolNames.includes('subagent'), false, 'forked leaf must strip subagent')
        assert.equal(childMeta.toolNames.includes('SubagentWorkflow'), false, 'forked leaf must strip SubagentWorkflow')
        assert.equal(childMeta.toolNames.includes('bash'), true, 'non-dispatch tools stay intact')
        assert.equal(childMeta.sectionsById['profile.catalog'], undefined, 'profile.catalog must be suppressed when dispatch tools are stripped')
        const forkSection = childMeta.sectionsById['workflow.forked_context'] ?? ''
        assert.ok(forkSection.includes('<forked_subagent_context>'), 'forked child must receive workflow.forked_context section')
        assert.ok(forkSection.includes('ALREADY been fulfilled'), 'boundary section must forbid re-delegation of inherited instructions')

        // Forked leaf child rejects direct spawnAgent and workflow run action with 403 subagent_depth_exceeded
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

        // Resuming the forked child preserves maxSubagentDepth=1, forked=true, tool stripping, and boundary section
        await app.kernel.conversations.submitInput(1, 'resume forked leaf caller')
        await app.kernel.conversations.waitForIdle(1)

        assert.ok(resumedChildMeta, 'should capture resumed forked child request')
        assert.equal(resumedChildMeta.toolNames.includes('subagent'), false)
        assert.equal(resumedChildMeta.toolNames.includes('SubagentWorkflow'), false)
        assert.equal(resumedChildMeta.sectionsById['profile.catalog'], undefined)
        assert.ok((resumedChildMeta.sectionsById['workflow.forked_context'] ?? '').includes('<forked_subagent_context>'))

        await app.kernel.kvStore.flush()
        const afterResumeEntry = registryEntry(dir, child.id)
        assert.equal(afterResumeEntry['maxSubagentDepth'], 1, 'resuming forked child must preserve ceiling=1')
        assert.equal(afterResumeEntry['forked'], true, 'resuming forked child must preserve forked=true')
      } finally {
        await app.close()
      }
    }

    // Real Hub restart on same dataDir: leaf ceiling, forked fact, stripping, and boundary persist
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
        await assert.rejects(
          () =>
            app.kernel.plugins.invokeAction('builtin:workflow', 'run', {
              script: 'export const meta = { name: "blocked-restart", description: "d" }\nreturn 1',
              conversationId: persistedChildId,
            }),
          (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded' && err.status === 403,
        )

        await app.kernel.conversations.submitInput(persistedChildId, 'post-restart forked check')
        await app.kernel.conversations.waitForIdle(persistedChildId)
        assert.ok(afterRestartMeta, 'should capture post-restart forked child request')
        assert.equal(afterRestartMeta.toolNames.includes('subagent'), false)
        assert.equal(afterRestartMeta.toolNames.includes('SubagentWorkflow'), false)
        assert.equal(afterRestartMeta.sectionsById['profile.catalog'], undefined)
        assert.ok((afterRestartMeta.sectionsById['workflow.forked_context'] ?? '').includes('<forked_subagent_context>'))
      } finally {
        await app.close()
      }
    }
  })

  // -------------------------------------------------------------------------
  // 13. Explicit maxSubagentDepth=2 opt-in on fork: true
  // -------------------------------------------------------------------------

  test('fork: true with explicit maxSubagentDepth=2 opts in to depth-2 nesting while keeping workflow.forked_context on depth-1 child', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'fork-explicit-depth2')
    let depth1Meta: ReturnType<typeof captureModelRequest> | undefined
    let depth2Meta: ReturnType<typeof captureModelRequest> | undefined

    const step: FauxResponseFactory = (context) => {
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
      throw new Error(`unexpected faux request: role=${req.lastNonSystemRole}, lastUser=${lastUser}`)
    }

    const faux = makeFauxProvider()
    faux.setResponses(Array.from({ length: 16 }, () => step))
    const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
    try {
      if (app.kernel.plugins.get('builtin:title')?.enabled) {
        await app.kernel.plugins.setConfig('builtin:title', { autoTitle: false })
      }
      await app.kernel.services.profiles.save({ id: 'coder', name: '编码专家' })

      await app.kernel.conversations.submitInput(1, 'seed OPT_IN_DEPTH2')
      await app.kernel.conversations.waitForIdle(1)
      await app.kernel.conversations.submitInput(1, 'delegate opt-in fork')
      await app.kernel.conversations.waitForIdle(1)

      const child1 = app.kernel.conversations.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child1, 'depth-1 forked child should exist')
      await app.kernel.conversations.waitForIdle(child1.id)
      const child2 = app.kernel.conversations.listConversations().find((c) => c.parentConversationId === child1.id)
      assert.ok(child2, 'depth-1 forked child with explicit maxSubagentDepth=2 should spawn depth-2 child')

      assert.ok(depth1Meta, 'should capture depth-1 forked request')
      assert.ok(depth1Meta.toolNames.includes('subagent') && depth1Meta.toolNames.includes('SubagentWorkflow'), 'depth-1 with ceiling=2 retains dispatch tools')
      assert.ok(typeof depth1Meta.sectionsById['profile.catalog'] === 'string', 'depth-1 with dispatch tools retains profile.catalog')
      assert.ok((depth1Meta.sectionsById['workflow.forked_context'] ?? '').includes('<forked_subagent_context>'), 'depth-1 forked child still receives workflow.forked_context')

      assert.ok(depth2Meta, 'should capture depth-2 child request')
      assert.equal(depth2Meta.toolNames.includes('subagent'), false, 'depth-2 child is a leaf and strips subagent')
      assert.equal(depth2Meta.toolNames.includes('SubagentWorkflow'), false, 'depth-2 child is a leaf and strips SubagentWorkflow')
      assert.equal(depth2Meta.sectionsById['profile.catalog'], undefined, 'depth-2 leaf suppresses profile.catalog')
      assert.equal(depth2Meta.sectionsById['workflow.forked_context'], undefined, 'non-forked depth-2 child does not get workflow.forked_context')

      await app.kernel.kvStore.flush()
      const e1 = registryEntry(dir, child1.id)
      assert.equal(e1['depth'], 1)
      assert.equal(e1['maxSubagentDepth'], 2)
      assert.equal(e1['forked'], true)
      const e2 = registryEntry(dir, child2.id)
      assert.equal(e2['depth'], 2)
      assert.equal(e2['maxSubagentDepth'], 2)
      assert.equal(e2['forked'], undefined)

      await assert.rejects(
        () => app.kernel.agentSpawn.spawnAgent({ parentConversationId: child2.id, prompt: 'depth3 forbidden' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'subagent_depth_exceeded' && err.status === 403,
      )
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 14. Corrupt non-boolean forked in depth KV fails startup explicitly
  // -------------------------------------------------------------------------

  test('corrupt non-boolean forked field in depth KV fails startup explicitly (subagent_record_invalid)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'fork-corrupt-kv')
    let childId = 0
    {
      const faux = makeFauxProvider()
      const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] })
      try {
        childId = (await spawnChain(app, faux, [1]))[0]!
        await app.kernel.kvStore.flush()
      } finally {
        await app.close()
      }
    }
    const existing = registryEntry(dir, childId)
    writeDepthKvRaw(dir, String(childId), { ...existing, forked: 'yes' })

    const faux = makeFauxProvider()
    await assert.rejects(
      () => createHelmx({ buildProvider: createPluginBuildProvider(), dataDir: dir, cwd: dir, model: 'faux/faux-1', providers: [faux.provider] }),
      (err: unknown) => err instanceof HelmxError && err.code === 'subagent_record_invalid',
    )
  })
})
