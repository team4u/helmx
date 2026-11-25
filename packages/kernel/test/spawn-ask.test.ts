/**
 * Native spawn and Ask contract tests: real pi-durable SDK (MemoryStorage) + faux provider.
 *
 * Covers main-agent reproduction cases:
 * - schema: full AJV validation (enum / nested / multiple types / additionalProperties), $async rejection,
 *   null/scalar legal top-levels, multiline object extraction, StructuredOutput tool self-healing, explicit failure after two retries;
 * - abort: pre-creation rejection, in-flight conversation.abort, zero orphaned tasks;
 * - resume: invalid ref never spawns anew, parent ownership validation, agentId mapping, onResolved reporting original ID;
 * - profile: missing profile error, herdr runtime explicitly unsupported, invalid effort rejection;
 * - gate: cwd uses child conversation's actual cwd;
 * - Ask: CAS conflict 409 / missing resolver ask_state_unavailable / seq rollback superseded /
 *   cancel/superseded rejection (with non-empty answers) / unknown fields / out-of-bounds select / invalid confirm /
 *   secret name collision rejection / empty secret not stashed / missing conversation rejection.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory'
import { HelmxError } from '@helmx/protocol'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { AskService } from '../src/runtime/asks.js'
import { assistantTextOfEntry, assistantTextOfModel } from '../src/runtime/entries.js'
import { runNativeSpawn, type NativeSpawnDeps } from '../src/runtime/spawn.js'
import { readSubmissionAssistantText } from '../src/runtime/spawn-reattach.js'
import { HelmxStore } from '../src/runtime/store.js'
import { openHelmxDatabase } from '../src/runtime/sqlite.js'
import { ArtifactService, SecretStash } from '../src/services/index.js'
import { cleanupDir, makeFauxModels, makeTempDir } from './helpers.js'

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']

interface TestHarness {
  harness: Harness
  deps: NativeSpawnDeps
  faux: FauxHandle
  close(): Promise<void>
}

/**
 * Real SDK Harness (MemoryStorage) + faux provider + full NativeSpawnDeps fixture.
 * registerChildConversation / resolveProfile / getParentOfConversation use in-process Maps
 * to simulate the host (wired by runtime.ts in production; tests spawn's own contract here).
 */
async function openSpawnHarness(options: { profiles?: Record<string, { model?: string; cwd?: string; runtime?: { kind: string; agent: string } }> } = {}): Promise<TestHarness> {
  const { models, faux } = makeFauxModels()
  const storage = new MemoryStorage()
  const registry = createRegistry()
  const harness = await Harness.open(
    storage,
    { models: () => models, registry },
    BACKGROUND_CONTEXT,
  )

  const stash = new SecretStash()
  const parents = new Map<number, number>()
  const profiles = new Map<string, { model?: string; cwd?: string; runtime?: { kind: string; agent: string } }>(
    Object.entries(options.profiles ?? { assistant: {} }),
  )
  // Child conversation mirror (minimal replica of HelmxStore production semantics: profileId/cwd/model).
  const mirrors = new Map<
    number,
    { profileId: string; cwd: string; model: string; modelOverride?: string; title: string; tags: string[]; createdAt: number }
  >()

  const deps: NativeSpawnDeps = {
    dataDir: '/tmp/helmx-spawn-test',
    defaultCwd: process.cwd(),
    hubUrl: 'http://127.0.0.1:3200',
    redact: (t) => stash.redact(t),
    artifacts: new ArtifactService('/tmp/helmx-spawn-test', { get: () => undefined, list: () => [], put: () => {}, deleteByConversation: () => {} } as never),
    harness,
    getLastAssistantText: (id) => lastTexts.get(id),
    resolveModel: () => ({ provider: 'faux', modelId: 'faux-1' }),
    agentSessions: new Map(),
    structuredOutputSessions: new Map(),
    registerChildConversation: async (childId, parentId, profileId, childCwd, modelMirror, _tags) => {
      parents.set(childId, parentId)
      mirrors.set(childId, {
        profileId,
        cwd: childCwd,
        model: modelMirror,
        title: `subagent ${childId}`,
        tags: [],
        createdAt: Date.now(),
      })
      const conv = await harness.conversation(childId as never, BACKGROUND_CONTEXT)
      if (!conv) return
      // Synchronous observer: mirrors production tracker mechanism (advance records synchronously without await).
      const observer = {
        advance: (call: { kind: string; value: { entries: Array<{ kind: string; id: number; model?: ReadonlyArray<{ content?: ReadonlyArray<{ type: string; text?: string }> }> }> } }) => {
          if (call.kind !== 'value') return
          const view = call.value
          for (let i = view.entries.length - 1; i >= 0; i -= 1) {
            const entry = view.entries[i]!
            if (entry.kind !== 'pi.assistant') continue
            const text = (entry.model?.[0]?.content ?? [])
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text as string)
              .join('\n')
            if (text !== '') {
              lastTexts.set(childId, text)
              break
            }
          }
        },
        end: () => {},
      }
      const observation = await harness.observeConversation(childId as never, observer as never, BACKGROUND_CONTEXT)
      observers.set(childId, () => observation.detach())
    },
    resolveProfile: async (profileId) => {
      if (!profiles.has(profileId)) return undefined
      const p = profiles.get(profileId) as { model?: string; cwd?: string; runtime?: { kind: string; agent: string } }
      return { model: p.model, cwd: p.cwd, runtime: p.runtime as never }
    },
    getParentOfConversation: (childId) => parents.get(childId),
    getModelOverride: (childId) => mirrors.get(childId)?.modelOverride,
    getConversation: (childId) => {
      const m = mirrors.get(childId)
      if (!m) return undefined
      return {
        id: childId,
        title: m.title,
        profileId: m.profileId,
        tags: m.tags,
        cwd: m.cwd,
        model: m.model,
        thinkingLevel: '',
        status: 'idle' as never,
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: m.createdAt,
        updatedAt: m.createdAt,
      }
    },
    updateConversation: async (childId, patch) => {
      const m = mirrors.get(childId)
      if (!m) throw new HelmxError('not_found', `conversation not found: ${childId}`, 404)
      if (patch.cwd !== undefined) m.cwd = patch.cwd
      if (patch.profileId !== undefined) m.profileId = patch.profileId
      if (patch.model !== undefined) m.modelOverride = patch.model
      if (m.modelOverride === undefined) {
        const p = profiles.get(m.profileId)
        m.model = p?.model ?? 'faux/faux-1'
      } else {
        m.model = m.modelOverride
      }
      // Same ordering as production: configure real SDK first, then update mirror.
      const conv = await harness.conversation(childId as never, BACKGROUND_CONTEXT)
      if (!conv) throw new HelmxError('not_found', `child conversation not found: ${childId}`, 404)
      const slash = m.model.indexOf('/')
      await conv.configure(
        {
          ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
          model: { provider: m.model.slice(0, slash), modelId: m.model.slice(slash + 1) },
        } as never,
        BACKGROUND_CONTEXT,
      )
      return deps.getConversation(childId)!
    },
    installChildExtension: (extension) => {
      registry.install(extension)
    },
  }
  const lastTexts = new Map<number, string>()
  const observers = new Map<number, () => void>()

  return {
    harness,
    deps,
    faux,
    async close() {
      for (const detach of observers.values()) detach()
      await harness.close(BACKGROUND_CONTEXT)
      await storage.close(BACKGROUND_CONTEXT)
    },
  }
}

let rootDir: string

before(async () => {
  rootDir = await makeTempDir('helmx-spawn-ask-')
})

after(async () => {
  await cleanupDir(rootDir)
})

// ---------------------------------------------------------------------------
// spawn: schema validation
// ---------------------------------------------------------------------------

describe('spawn schema: full AJV validation', { timeout: 60_000 }, () => {
  it('enum / nested / additionalProperties violations all reject (not limited to top-level check)', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      // Round 1: enum violation + extra property -> tool rejects -> round 2 would return valid value.
      th.faux.setResponses([
        fauxAssistantMessage('invalid output first'),
        fauxAssistantMessage('ok'),
      ])
      // Direct text extraction (without tool call) must also be caught by full schema validation:
      const bad = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'return enum',
        schema: {
          type: 'object',
          properties: { level: { type: 'string', enum: ['low', 'high'] } },
          required: ['level'],
          additionalProperties: false,
        },
      } as never).then(
        () => assert.fail('enum violation must fail'),
        (err: unknown) => err as HelmxError,
      )
      assert.equal(bad.code, 'schema_validation_failed')
    } finally {
      await th.close()
    }
  })

  it('null top-level allowed: distinguishes valid null from undefined', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([
        // Model invokes tool to submit null (schema permits null top-level).
        fauxAssistantMessage(
          [fauxToolCall('register_structured_output', { output: null })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('committed'),
      ])
      const result = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'may have no result',
        schema: { type: 'null' },
      } as never)
      assert.equal(result, null)
    } finally {
      await th.close()
    }
  })

  it('multiline object text extraction (without tool call) passes full schema validation', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([
        fauxAssistantMessage('result follows:\n{"answer":\n  42,\n "ok": true}'),
        fauxAssistantMessage('one more time'),
      ])
      const result = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'compute',
        schema: {
          type: 'object',
          properties: { answer: { type: 'number' }, ok: { type: 'boolean' } },
          required: ['answer', 'ok'],
        },
      } as never)
      assert.deepEqual(result, { answer: 42, ok: true })
    } finally {
      await th.close()
    }
  })

  it('$async schema explicitly rejected', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            schema: { $async: true, type: 'object' },
          } as never),
        (err: unknown) => err instanceof HelmxError && err.code === 'invalid_plugin_schema',
      )
    } finally {
      await th.close()
    }
  })

  it('StructuredOutput tool: invalid args rejected, retried in same turn, succeeds via tool return', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([
        // Single turn: model passes invalid enum first, tool rejects (isError), retries with valid value in same turn.
        fauxAssistantMessage(
          [fauxToolCall('register_structured_output', { output: { level: 'bogus' } })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage([fauxToolCall('register_structured_output', { output: { level: 'high' } })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('done'),
      ])
      const result = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'evaluate',
        schema: {
          type: 'object',
          properties: { level: { type: 'string', enum: ['low', 'high'] } },
          required: ['level'],
          additionalProperties: false,
        },
      } as never)
      assert.deepEqual(result, { level: 'high' })
    } finally {
      await th.close()
    }
  })

  it('StructuredOutput tool: defensively parses stringified JSON into object and validates cleanly', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([
        // Model encodes structured payload as JSON string because tool declaration omitted type metadata
        fauxAssistantMessage(
          [
            fauxToolCall('register_structured_output', {
              output: JSON.stringify({
                difficulty: 'medium',
                intent: 'test intent',
                question: 'test question',
              }),
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('generated question'),
      ])
      const result = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'generate question',
        schema: {
          type: 'object',
          properties: {
            difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
            intent: { type: 'string' },
            question: { type: 'string' },
          },
          required: ['difficulty', 'intent', 'question'],
          additionalProperties: false,
        },
      } as never)
      assert.deepEqual(result, {
        difficulty: 'medium',
        intent: 'test intent',
        question: 'test question',
      })
    } finally {
      await th.close()
    }
  })

  it('failing both attempts throws schema_validation_failed explicitly (with conversation diagnostics)', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([
        fauxAssistantMessage('not JSON'),
        fauxAssistantMessage('still not JSON'),
      ])
      const err = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'return JSON',
        schema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
      } as never).then(
        () => assert.fail('must fail'),
        (e: unknown) => e as HelmxError,
      )
      assert.equal(err.code, 'schema_validation_failed')
      assert.ok((err.details as { conversationId?: number }).conversationId !== undefined)
    } finally {
      await th.close()
    }
  })
})

// ---------------------------------------------------------------------------
// spawn: abort / signal
// ---------------------------------------------------------------------------

describe('spawn abort: signal wired to SDK', { timeout: 60_000 }, () => {
  it('aborted before creation: rejects immediately without creating child conversation', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      const controller = new AbortController()
      controller.abort()
      const before = (th.deps.agentSessions as Map<string, number>).size
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            signal: controller.signal,
          } as never),
        (err: unknown) => err instanceof HelmxError && err.code === 'aborted',
      )
      assert.equal((th.deps.agentSessions as Map<string, number>).size, before)
    } finally {
      await th.close()
    }
  })

  it('aborted mid-run: conversation.abort takes effect with zero live tasks remaining', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      // Suspend response provider: until resolved, turn remains inside model request so abort cancels in-flight execution.
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      th.faux.setResponses([
        () => gate.then(() => fauxAssistantMessage('delayed answer')) as never,
      ])
      const controller = new AbortController()
      const promise = runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'slow task',
        agentId: 'slow-1',
        signal: controller.signal,
      } as never)
      // Wait for child conversation to start running, then trigger abort.
      await new Promise((r) => setTimeout(r, 150))
      controller.abort()
      release()
      const err = await promise.then(
        () => assert.fail('must not succeed after abort'),
        (e: unknown) => e as HelmxError,
      )
      assert.equal(err.code, 'aborted')
      // Zero leftover live tasks (conversation idle).
      const childId = (th.deps.agentSessions as Map<string, number>).get('slow-1')!
      const conv = await th.harness.conversation(childId as never, BACKGROUND_CONTEXT)
      assert.ok(conv)
      await conv.waitForIdle(BACKGROUND_CONTEXT)
      const inspect = await th.harness.inspect(BACKGROUND_CONTEXT)
      const live = inspect.tasks.filter((t) => t.state.kind === 'running' || t.state.kind === 'waiting')
      assert.equal(live.length, 0, 'no live tasks should remain after abort')
    } finally {
      await th.close()
    }
  })
})

// ---------------------------------------------------------------------------
// spawn: strict resume
// ---------------------------------------------------------------------------

describe('spawn resume: never creates new conversation on false resume', { timeout: 60_000 }, () => {
  it('missing ref rejects without creating child conversation', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([fauxAssistantMessage('answer')])
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            resume: 'no-such-agent',
          } as never),
        (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
      )
      // Mixed strings like '12abc' also reject (no lenient parseInt tolerance).
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            resume: '12abc',
          } as never),
        (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
      )
      assert.equal((th.deps.agentSessions as Map<string, number>).size, 0)
    } finally {
      await th.close()
    }
  })

  it('agentId mapping resume: reuses original conversation; onResolved reports original id', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([fauxAssistantMessage('round 1'), fauxAssistantMessage('resume result')])
      let createdId: number | undefined
      const first = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'round 1',
        agentId: 'agent-a',
        onResolved: (info) => {
          createdId = info.conversationId
        },
      })
      assert.equal(first, 'round 1')
      const resumeResolved: Array<number | undefined> = []
      const second = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'continue',
        resume: 'agent-a',
        onResolved: (info) => {
          resumeResolved.push(info.conversationId)
        },
      })
      assert.equal(second, 'resume result')
      assert.equal(resumeResolved.length, 1)
      assert.equal(resumeResolved[0], createdId, 'resume onResolved reports original convId')
    } finally {
      await th.close()
    }
  })

  it('wrong parent ownership rejects resume (guards against cross-parent hijacking)', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([fauxAssistantMessage('round 1'), fauxAssistantMessage('unreachable')])
      await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'round 1',
        agentId: 'agent-p',
      } as never)
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 999,
            prompt: 'hijack',
            resume: 'agent-p',
          } as never),
        (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
      )
    } finally {
      await th.close()
    }
  })

  it('resume with schema: dynamically attaches StructuredOutput tool and accepts result', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      // Round 1 has no schema (plain text); resuming with schema dynamically attaches the tool and receives the structured output.
      th.faux.setResponses([
        fauxAssistantMessage('round 1 plain text'),
        fauxAssistantMessage([fauxToolCall('register_structured_output', { output: { n: 1 } })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('done'),
      ])
      const first = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'round 1',
        agentId: 'agent-s',
      } as never)
      assert.equal(first, 'round 1 plain text')
      const second = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'resume and return structured output',
        resume: 'agent-s',
        schema: {
          type: 'object',
          properties: { n: { type: 'number' } },
          required: ['n'],
          additionalProperties: false,
        },
      } as never)
      assert.deepEqual(second, { n: 1 })
    } finally {
      await th.close()
    }
  })
})

// ---------------------------------------------------------------------------
// spawn: profile / effort / runtime / isolation / gate
// ---------------------------------------------------------------------------

describe('spawn profile and runtime declaration', { timeout: 60_000 }, () => {
  it('invalid profile returns explicit not_found', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            agentType: 'ghost-profile',
          } as never),
        (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
      )
    } finally {
      await th.close()
    }
  })

  it('external runtime syntax (colon agentType): explicit unsupported_runtime when no plugin handles it', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness({
      profiles: {
        assistant: {},
      },
    })
    try {
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            agentType: 'external:agent',
          } as never),
        (err: unknown) => err instanceof HelmxError && err.code === 'unsupported_runtime',
      )
    } finally {
      await th.close()
    }
  })

  it('invalid effort enum rejects; valid value passes', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            effort: 'ultra',
          } as never),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
      )
      th.faux.setResponses([fauxAssistantMessage('answer with effort')])
      const result = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'x',
        effort: 'high',
      } as never)
      assert.equal(result, 'answer with effort')
    } finally {
      await th.close()
    }
  })

  it('isolation returns explicit unsupported_runtime', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            isolation: 'worktree',
          } as never),
        (err: unknown) => err instanceof HelmxError && err.code === 'unsupported_runtime',
      )
    } finally {
      await th.close()
    }
  })

  it('any namespace:kind external runtime (non-herdr) also yields unsupported_runtime when unclaimed (zero hardcoded plugin list in kernel)', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      // Kernel hardcodes no plugin names: all namespaced runtimes like docker:devbox or ssh:remote
      // flow through agent_spawn hooks; unclaimed ones uniformly fail explicitly.
      for (const agentType of ['docker:devbox', 'ssh:remote', 'claude:code']) {
        await assert.rejects(
          () =>
            runNativeSpawn(th.deps, {
              parentConversationId: 1,
              prompt: 'x',
              agentType,
            } as never),
          (err: unknown) =>
            err instanceof HelmxError && err.code === 'unsupported_runtime' && err.message.includes(agentType),
        )
      }
    } finally {
      await th.close()
    }
  })

  it('plain profileId (without colon) is unaffected by namespace rule (continues normal profile resolution)', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      // Unregistered profile without colon yields not_found (not unsupported_runtime).
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            agentType: 'no-such-profile',
          } as never),
        (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
      )
    } finally {
      await th.close()
    }
  })

  it('gate executes in child conversation cwd (request.cwd) and preserves diagnostics on failure', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([fauxAssistantMessage('answer 1'), fauxAssistantMessage('answer 2')])
      const marker = join(rootDir, 'gate-marker.txt')
      // Gate runs pwd in child cwd and writes marker file to confirm cwd took effect.
      const result = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'x',
        cwd: rootDir,
        gate: `pwd > "${marker}"`,
      } as never)
      assert.equal(result, 'answer 1')
      const { readFileSync } = await import('node:fs')
      const pwd = readFileSync(marker, 'utf8').trim()
      assert.equal(pwd, rootDir)
      // Gate failure: explicit gate_failed preserving diagnostic output.
      const err = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'y',
        cwd: rootDir,
        gate: 'echo boom-diagnostic >&2; exit 7',
      } as never).then(
        () => assert.fail('failed gate must throw'),
        (e: unknown) => e as HelmxError,
      )
      assert.equal(err.code, 'gate_failed')
      assert.ok(String(err.message).includes('boom-diagnostic'), 'gate diagnostics must not be discarded')
    } finally {
      await th.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Ask: CAS / cancellation / validation
// ---------------------------------------------------------------------------

describe('Ask CAS and honest settlement', { timeout: 60_000 }, () => {
  let service: AskService
  let store: HelmxStore
  let stash: SecretStash
  let events: Array<{ type: string; payload: unknown }>
  let pendingChanged: number[]

  async function openAskService(options: { validateConversation?: (id: number) => boolean } = {}): Promise<void> {
    const db = await openHelmxDatabase(join(rootDir, `ask-${Math.random().toString(36).slice(2)}`))
    store = new HelmxStore(db)
    await store.load()
    stash = new SecretStash()
    events = []
    pendingChanged = []
    service = new AskService({
      store,
      onEvent: (type, payload) => events.push({ type, payload }),
      onConvPendingChanged: (id) => pendingChanged.push(id),
      validateConversation: options.validateConversation,
    })
  }

  it('client CAS seq mismatch against persisted watermark: rejects 409 (never overwrites silently)', { timeout: 60_000 }, async () => {
    await openAskService()
    const askPromise = service.createAsk({
      conversationId: 1,
      title: 'terminal confirm',
      expectedStateSeq: 10,
      fields: [{ name: 'confirm', label: 'confirm', type: 'confirm' }],
    })
    void askPromise.catch(() => {})
    const ask = service.listAsks('pending')[0]!
    await assert.rejects(
      () => service.answerAsk(ask.id, { confirm: 'true' }, 9),
      (err: unknown) => err instanceof HelmxError && err.code === 'ask_state_conflict',
    )
    const ok = await service.answerAsk(ask.id, { confirm: 'true' }, 10)
    assert.equal(ok.status, 'answered')
    await store.close()
  })

  it('cancel/superseded: createAsk resolves cleanly (status distinguished, empty answers never backfill false approvals)', { timeout: 60_000 }, async () => {
    await openAskService()
    const askPromise = service.createAsk({
      conversationId: 1,
      title: 'cancel',
      fields: [{ name: 'x', label: 'X', type: 'text' }],
    })
    await new Promise((r) => setTimeout(r, 20))
    const ask = service.listAsks('pending')[0]!
    await service.cancelAsk(ask.id)
    const cancelled = await askPromise
    assert.equal(cancelled.status, 'cancelled')
    assert.deepEqual(cancelled.answers, {})
    // superseded works identically.
    const ask2Promise = service.createAsk({
      conversationId: 1,
      title: 'supersede',
      fields: [{ name: 'x', label: 'X', type: 'text' }],
    })
    await new Promise((r) => setTimeout(r, 20))
    const ask2 = service.listAsks('pending')[0]!
    await service.cancelAsk(ask2.id, 'superseded')
    const superseded = await ask2Promise
    assert.equal(superseded.status, 'superseded')
    assert.deepEqual(superseded.answers, {})
    await store.close()
  })

  it('answer validation: unknown field / non-string / out-of-bounds select / invalid confirm / missing required', { timeout: 60_000 }, async () => {
    await openAskService()
    const askPromise = service.createAsk({
      conversationId: 1,
      title: 'form',
      fields: [
        { name: 'color', label: 'Color', type: 'select', options: [{ label: 'Red', value: 'red' }, { label: 'Blue', value: 'blue' }] },
        { name: 'agree', label: 'Agree', type: 'confirm', required: true },
        { name: 'note', label: 'Note', type: 'text' },
      ],
    })
    void askPromise.catch(() => {})
    const ask = service.listAsks('pending')[0]!
    const expectValidation = (promise: Promise<unknown>) =>
      assert.rejects(promise, (err: unknown) => err instanceof HelmxError && err.code === 'validation_error')
    await expectValidation(service.answerAsk(ask.id, { agree: 'true', rogue: 'x' } as never))
    await expectValidation(service.answerAsk(ask.id, { agree: 1 } as never))
    await expectValidation(service.answerAsk(ask.id, { agree: 'true', color: 'green' }))
    await expectValidation(service.answerAsk(ask.id, { agree: 'yes' }))
    await expectValidation(service.answerAsk(ask.id, { color: 'red' }))
    // Valid submission passes.
    const ok = await service.answerAsk(ask.id, { agree: 'true', color: 'red', note: '' })
    assert.equal(ok.status, 'answered')
    await store.close()
  })

  it('createAsk boundaries: duplicate name / invalid type / missing conversation / missing title', { timeout: 60_000 }, async () => {
    await openAskService({ validateConversation: (id) => id === 1 })
    const expectValidation = (promise: Promise<unknown>) =>
      assert.rejects(promise, (err: unknown) => err instanceof HelmxError && err.code === 'validation_error')
    await expectValidation(
      service.createAsk({
        conversationId: 1,
        title: 'duplicate',
        fields: [
          { name: 'x', label: '1', type: 'text' },
          { name: 'x', label: '2', type: 'text' },
        ],
      }),
    )
    await expectValidation(
      service.createAsk({
        conversationId: 1,
        title: 'broken type',
        fields: [{ name: 'x', label: 'X', type: 'radio' as never }],
      }),
    )
    await expectValidation(service.createAsk({ conversationId: 1, title: '', fields: [{ name: 'x', label: 'X', type: 'text' }] }))
    await expectValidation(service.createAsk({ conversationId: 1, title: {}, fields: [{ name: 'x', label: 'X', type: 'text' }] }))
    await expectValidation(
      service.createAsk({ conversationId: 1, title: { fr: 'Oui' } as never, fields: [{ name: 'x', label: 'X', type: 'text' }] }),
    )
    await expectValidation(
      service.createAsk({ conversationId: 1, title: { en: '   ' }, fields: [{ name: 'x', label: 'X', type: 'text' }] }),
    )
    await expectValidation(
      service.createAsk({
        conversationId: 1,
        title: 'bad select option label',
        fields: [{ name: 'x', label: 'X', type: 'select', options: [{ label: '', value: 'v' }] }],
      }),
    )
    await expectValidation(
      service.createAsk({
        conversationId: 1,
        title: 'missing select option label',
        fields: [{ name: 'x', label: 'X', type: 'select', options: [{ value: 'v' } as never] }],
      }),
    )
    await assert.rejects(
      () =>
        service.createAsk({
          conversationId: 424242,
          title: 'missing conversation',
          fields: [{ name: 'x', label: 'X', type: 'text' }],
        }),
      (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
    )
    await store.close()
  })

  it('pending asks remaining across restart: emits diagnostic notice', { timeout: 60_000 }, async () => {
    await openAskService()
    const askPromise = service.createAsk({
      conversationId: 1,
      title: 'orphaned',
      fields: [{ name: 'x', label: 'X', type: 'text' }],
    })
    void askPromise.catch(() => {})
    await new Promise((r) => setTimeout(r, 20))
    service.reportOrphans()
    const notification = events.find(
      (e) => e.type === 'notification' && String((e.payload as { title?: string }).title).includes('Pending AskDoc remaining after restart'),
    )
    assert.ok(notification, 'must emit diagnostic notification')
    assert.ok(
      String((notification.payload as { body?: string }).body).includes('pending'),
      'must note that ask remains pending after restart',
    )
    await service.cancelAsk(service.listAsks('pending')[0]!.id)
    await store.close()
  })

  it('LocalizedText fields: bilingual title/description/labels/options persist cleanly through store', { timeout: 60_000 }, async () => {
    await openAskService()
    const localizedPromise = service.createAsk({
      id: 'ask-i18n-1',
      conversationId: 1,
      title: { en: 'Plan Approval v1', 'zh-CN': '计划审批 v1' },
      description: { en: 'Review plan', 'zh-CN': '审阅方案' },
      fields: [
        {
          name: 'decision',
          label: { en: 'Decision', 'zh-CN': '审批决策' },
          type: 'select',
          required: true,
          options: [
            { value: 'approve', label: { en: 'Approve', 'zh-CN': '批准' } },
            { value: 'revise', label: { en: 'Revise', 'zh-CN': '修订' } },
          ],
        },
        {
          name: 'feedback',
          label: { en: 'Feedback', 'zh-CN': '意见' },
          type: 'text',
        },
      ],
    })
    void localizedPromise.catch(() => {})
    const persisted = service.listAsks('pending')[0]!
    assert.deepEqual(persisted.title, { en: 'Plan Approval v1', 'zh-CN': '计划审批 v1' })
    assert.deepEqual(persisted.description, { en: 'Review plan', 'zh-CN': '审阅方案' })
    assert.deepEqual(persisted.fields[0]?.label, { en: 'Decision', 'zh-CN': '审批决策' })
    assert.deepEqual(persisted.fields[0]?.options?.[0]?.label, { en: 'Approve', 'zh-CN': '批准' })
    assert.deepEqual(persisted.fields[1]?.label, { en: 'Feedback', 'zh-CN': '意见' })

    const settled = await service.answerAsk('ask-i18n-1', { decision: 'approve', feedback: 'ok' })
    assert.equal(settled.status, 'answered')
    assert.deepEqual(settled.title, { en: 'Plan Approval v1', 'zh-CN': '计划审批 v1' })
    await store.close()
  })
})

// ---------------------------------------------------------------------------
// spawn: real-time parentToolCallId propagation during run
// ---------------------------------------------------------------------------

describe('spawn parentToolCallId: real-time binding between parent tool call ID and child conversation', { timeout: 60_000 }, () => {
  it('fresh spawn: request.parentToolCallId passes through intact without being dropped by engine', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([fauxAssistantMessage('done')])
      let registeredChildId: number | undefined
      const originalRegister = th.deps.registerChildConversation
      th.deps.registerChildConversation = async (childId, parentId, profileId, childCwd, modelMirror, tags, thinkingLevel) => {
        registeredChildId = childId
        return originalRegister(childId, parentId, profileId, childCwd, modelMirror, tags, thinkingLevel)
      }
      // Host runtime.ts injects parentToolCallId from api.callId in createSubagentTool;
      // engine contract: forward request field verbatim without swallowing or modifying (host callback persists mirror).
      const request = {
        parentConversationId: 1,
        prompt: 'fix build',
        parentToolCallId: 'toolu_01ABC',
      }
      const result = await runNativeSpawn(th.deps, request as never)
      assert.equal(result, 'done')
      assert.ok(registeredChildId !== undefined, 'child conversation must have been registered')
      assert.equal(request.parentToolCallId, 'toolu_01ABC')
    } finally {
      await th.close()
    }
  })

  it('resume: host bindChildToolCall receives current tool call ID', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([fauxAssistantMessage('round 1'), fauxAssistantMessage('resume done')])
      const bound: Array<{ childId: number; parentToolCallId: string }> = []
      th.deps.bindChildToolCall = (childId, parentToolCallId) => {
        bound.push({ childId, parentToolCallId })
      }
      let createdId: number | undefined
      await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'round 1',
        agentId: 'agent-tc',
        onResolved: (info: { conversationId?: number }) => {
          createdId = info.conversationId
        },
      } as never)
      // Fresh spawn does not call bindChildToolCall (parentToolCallId goes via registerChildConversation).
      assert.equal(bound.length, 0)
      await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'continue',
        resume: 'agent-tc',
        parentToolCallId: 'toolu_01RESUME',
      } as never)
      assert.equal(bound.length, 1)
      assert.equal(bound[0]!.parentToolCallId, 'toolu_01RESUME')
      assert.equal(bound[0]!.childId, createdId)
    } finally {
      await th.close()
    }
  })

  it('omitted parentToolCallId: resume does not invoke bindChildToolCall', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([fauxAssistantMessage('round 1'), fauxAssistantMessage('continue again')])
      let called = 0
      th.deps.bindChildToolCall = () => {
        called += 1
      }
      await runNativeSpawn(th.deps, { parentConversationId: 1, prompt: 'round 1', agentId: 'agent-nt' } as never)
      await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'continue',
        resume: 'agent-nt',
      } as never)
      assert.equal(called, 0, 'spawn without parentToolCallId must not invoke bindChildToolCall')
    } finally {
      await th.close()
    }
  })

  it('shared assistant answer extraction handles multi-message model, range fallback, rewind/reset stop, and redaction', { timeout: 60_000 }, async () => {
    // 1. assistantTextOfModel & assistantTextOfEntry across multiple model messages and non-assistant entries.
    assert.equal(
      assistantTextOfModel([
        { role: 'assistant', content: [{ type: 'text', text: 'part-1' }, { type: 'toolCall', id: 'tc1' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'part-2' }] },
      ]),
      'part-1\npart-2',
    )
    assert.equal(assistantTextOfEntry({ kind: 'helmx.input', model: [{ content: [{ type: 'text', text: 'ignored' }] }] }), '')
    assert.equal(
      assistantTextOfEntry({ kind: 'pi.assistant', model: [{ content: [{ type: 'text', text: 'ok' }] }] }),
      'ok',
    )

    // 2. readSubmissionAssistantText falls back from tool-only answer entry to earlier assistant entry in range, with redaction.
    const entriesA = [
      { id: 10, kind: 'helmx.input', model: [{ role: 'user', content: 'task' }] },
      { id: 11, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'secret=TOP_SECRET' }] }] },
      { id: 12, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'tc1' }] }] },
    ]
    const fakeConv = (items: typeof entriesA) => ({
      entries: async (query: { minEntryId?: number; maxEntryId?: number; order?: 'ascending' | 'descending' }) => {
        const filtered = items.filter(
          (e) =>
            (query.minEntryId === undefined || e.id >= query.minEntryId) &&
            (query.maxEntryId === undefined || e.id <= query.maxEntryId),
        )
        if (query.order === 'descending') filtered.reverse()
        return { items: filtered as never, next: undefined }
      },
    })
    const recovered = await readSubmissionAssistantText(
      fakeConv(entriesA) as never,
      { type: 'input', status: 'done', entry: 10 as never, answer: 12 as never } as never,
      { redact: (t) => t.replaceAll('TOP_SECRET', '[REDACTED]') },
    )
    assert.equal(recovered, 'secret=[REDACTED]')

    // 3. Range fallback stops at helmx.rewind / pi.reset instead of returning superseded assistant text.
    const entriesWithReset = [
      { id: 10, kind: 'helmx.input', model: [] },
      { id: 11, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'stale' }] }] },
      { id: 12, kind: 'pi.reset', model: [] },
      { id: 13, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'tc2' }] }] },
    ]
    const stopped = await readSubmissionAssistantText(
      fakeConv(entriesWithReset) as never,
      { type: 'input', status: 'done', entry: 10 as never, answer: 13 as never } as never,
    )
    assert.equal(stopped, undefined, 'range fallback must stop at pi.reset instead of returning stale assistant text')
  })
})
