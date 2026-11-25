/**
 * Conversation unread governance integration tests: turn-settled unread policy distinguishes human vs background spawned sub-conversations.
 *
 * Contract (emitSettled):
 * - Top-level human direct conversation completed -> unread=true / status=done (existing semantics unchanged);
 * - Background spawned sub-conversation (ownedBy=helmx/bot and parentConversationId present, such as managed
 *   subagent / SuperAgent Worker) completed -> unread=false / status=idle,
 *   never fabricating human unread noise; completion state stays consistent with turn_settled event semantics;
 * - Human fork (has parent chain, human ownership) completed -> unread=true (not treated uniformly as background);
 * - failed -> unread=false / status=error; aborted -> unread=false / status=idle
 *   (failure/abort contract locked).
 *
 * Full real execution: real pi-durable SDK + SQLite + faux provider + real native spawn pipeline.
 */

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationSummary, TurnSettledPayload } from '@helmx/protocol'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KernelRuntime } from '../src/runtime/index.js'
import { cleanupDir, makeFauxModels, makeTempDir } from './helpers.js'

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']

async function openRuntime(dir: string): Promise<KernelRuntime & { __faux: FauxHandle }> {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models })
  return Object.assign(runtime, { __faux: faux })
}

/** Registers a turn_settled collector plugin and returns the payload array ordered by settlement. */
async function collectSettled(kernel: KernelRuntime): Promise<TurnSettledPayload[]> {
  const settled: TurnSettledPayload[] = []
  await kernel.plugins.register({
    id: 'test:settled-collector',
    definePlugin(ctx) {
      ctx.hook.onTurnSettled((payload) => {
        settled.push(payload)
      })
    },
  })
  return settled
}

let root: string

before(async () => {
  root = await makeTempDir('helmx-unread-governance-')
})

after(async () => {
  await cleanupDir(root)
})

describe('turn settlement unread governance', { timeout: 60_000 }, () => {
  it('top-level human conversation completed: unread=true / done (existing semantics unchanged)', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't1'))
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('top-level answer')])
      await kernel.conversations.submitInput(1, 'top-level question')
      await kernel.conversations.waitForIdle(1)
      const conv = kernel.conversations.getConversation(1)
      assert.equal(conv.unread, true)
      assert.equal(conv.status, 'done')
      assert.equal(conv.completionSeq, 1)
    } finally {
      await kernel.close()
    }
  })

  it('autonomous subagent completed: unread=false / idle, state consistent with events; list filters take effect', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't2'))
    try {
      const settled = await collectSettled(kernel)
      kernel.__faux.setResponses([fauxAssistantMessage('subagent answer')])
      const result = await kernel.agentSpawn.spawnAgent({ parentConversationId: 1, prompt: 'subtask' })
      assert.ok(result !== undefined)
      const child = kernel
        .conversations.listConversations()
        .find((c) => c.parentConversationId === 1)
      assert.ok(child, 'native spawn should create child conversation')
      await kernel.conversations.waitForIdle(child.id)

      const fresh = kernel.conversations.getConversation(child.id) as ConversationSummary & { ownedBy?: string }
      assert.equal(fresh.ownedBy, 'helmx', 'native subagent is owned by helmx')
      assert.equal(fresh.parentConversationId, 1)
      assert.equal(fresh.unread, false, 'background subagent completion must not fabricate human unread state')
      assert.equal(fresh.status, 'idle', 'completion status when unread=false should be idle (matching unread semantics)')
      assert.equal(fresh.completionSeq, 1, 'completion sequence increments as normal')

      // Event semantics stay consistent: turn_settled payload terminal state matches the query interface.
      const childSettled = settled.find((p) => p.conversation.id === child.id)
      assert.ok(childSettled, 'subagent turn should settle once')
      assert.equal(childSettled.outcome, 'completed')
      assert.equal(childSettled.conversation.unread, false)
      assert.equal(childSettled.conversation.status, 'idle')

      // Parent conversation is unaffected (no turn executed): remains unread=false.
      const parent = kernel.conversations.getConversation(1)
      assert.equal(parent.unread, false)

      // In-process list filtering dimensions (backend implementation for HTTP noise reduction):
      assert.ok(kernel.conversations.listConversations().some((c) => c.id === child.id), 'in-process list without filter returns all conversations')
      assert.ok(
        kernel.conversations.listConversations({ topLevelOnly: true }).every((c) => c.parentConversationId === undefined),
        'topLevelOnly should exclude child conversations',
      )
      assert.deepEqual(
        kernel.conversations.listConversations({ parentConversationId: 1 }).map((c) => c.id),
        [child.id],
        'parentConversationId should match direct child conversations exactly',
      )
    } finally {
      await kernel.close()
    }
  })

  it('human fork (has parent chain, human ownership) completed: unread=true (not uniformly suppressed)', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't3'))
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage('original conversation answer'),
        fauxAssistantMessage('post-fork answer'),
      ])
      await kernel.conversations.submitInput(1, 'original conversation question')
      await kernel.conversations.waitForIdle(1)
      const detail = await kernel.conversations.getConversationDetail(1)
      const entryId = Number(detail.entries[0]!.id)
      const forked = await kernel.conversations.forkConversation(1, { entryId })
      assert.equal(forked.parentConversationId, 1, 'fork has parent chain')

      await kernel.conversations.submitInput(forked.id, 'post-fork question')
      await kernel.conversations.waitForIdle(forked.id)
      const fresh = kernel.conversations.getConversation(forked.id) as ConversationSummary & { ownedBy?: string }
      assert.notEqual(fresh.ownedBy, 'helmx')
      assert.notEqual(fresh.ownedBy, 'bot')
      assert.equal(fresh.unread, true, 'human fork completion still marks conversation unread')
      assert.equal(fresh.status, 'done')
    } finally {
      await kernel.close()
    }
  })

  it('failure contract: failed -> unread=false / error', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't4'))
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage('x', { errorMessage: 'boom', stopReason: 'error' }),
      ])
      await kernel.conversations.submitInput(1, 'trigger failure')
      await kernel.conversations.waitForIdle(1).catch(() => {})
      const conv = kernel.conversations.getConversation(1)
      assert.equal(conv.status, 'error')
      assert.equal(conv.unread, false, 'failed turn does not mark unread')
    } finally {
      await kernel.close()
    }
  })

  it('abort contract: aborted -> unread=false / idle', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't5'))
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('unneeded second answer'),
      ])
      void kernel.conversations.submitInput(1, 'question to be aborted').catch(() => {})
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(kernel.conversations.getConversation(1).status, 'working')
      await kernel.conversations.abortConversation(1)
      await kernel.conversations.waitForIdle(1).catch(() => {})
      const conv = kernel.conversations.getConversation(1)
      assert.equal(conv.status, 'idle')
      assert.equal(conv.unread, false, 'aborted turn does not mark unread')
    } finally {
      await kernel.close()
    }
  })

  it('native spawn persists helmx.input (origin=agent) with tracker turn_settled inputs, bypasses input hooks, supports image attachments, structured output, and redaction', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 't6-spawn-shared-primitives'))
    try {
      const settled = await collectSettled(kernel)
      const inputHookCalls: Array<{ conversationId: number; text: string }> = []
      await kernel.plugins.register({
        id: 'test:input-hook-sentinel',
        definePlugin(ctx) {
          ctx.hook.onInput((payload) => {
            inputHookCalls.push({ conversationId: payload.conversationId, text: payload.input.text })
            return { action: 'block', reason: 'top-level input hook must never intercept subagent spawns' }
          })
        },
      })

      // Register a secret in redactor + upload a PNG image attachment on parent conversation.
      const secretVal = 'sk-spawn-secret-value-42'
      kernel.stash.addRedaction(secretVal)
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const pngMeta = await kernel.artifacts.writeUploaded(1, {
        name: 'diagram.png',
        mimeType: 'image/png',
        bytes: pngBytes,
      })

      const seenContents: unknown[] = []
      kernel.__faux.setResponses([
        // First turn (schema spawn): returns plain text without tool call to also exercise :schema-heal
        (ctx) => {
          const userMsg = ctx.messages.filter((m) => m.role === 'user').at(-1) as { content?: unknown } | undefined
          seenContents.push(userMsg?.content)
          return fauxAssistantMessage(`not json yet ${secretVal}`)
        },
        // Heal turn: returns valid JSON via text fallback (also containing secret to verify answer redaction? no, JSON value)
        (ctx) => {
          const userMsg = ctx.messages.filter((m) => m.role === 'user').at(-1) as { content?: unknown } | undefined
          seenContents.push(userMsg?.content)
          return fauxAssistantMessage(JSON.stringify({ ok: true, note: `done ${secretVal}` }))
        },
      ])

      let childId = 0
      const structuredResult = await kernel.agentSpawn.spawnAgent({
        parentConversationId: 1,
        prompt: `inspect image with ${secretVal}`,
        attachments: [pngMeta.id],
        requestId: 'req-spawn-img-schema',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
          required: ['ok', 'note'],
          additionalProperties: false,
        },
        onResolved: (info) => { childId = info.conversationId ?? 0 },
      })

      assert.ok(childId > 0)
      await kernel.conversations.waitForIdle(childId)

      // 1. Top-level input hook was NEVER invoked for subagent prompt or schema-heal prompt.
      assert.deepEqual(inputHookCalls, [], 'native spawn must never route through top-level input hooks')

      // 2. Multimodal image attachment + [Attached Files] + <structured_output_contract> reached model, with secret redacted.
      const firstContent = seenContents[0] as Array<{ type: string; text?: string; data?: string; mimeType?: string }>
      assert.ok(Array.isArray(firstContent), 'image attachment must produce multimodal content blocks in native spawn')
      const textBlock = firstContent.find((b) => b.type === 'text')
      assert.ok(textBlock?.text?.includes('[Attached Files]'), 'multimodal text block must include [Attached Files]')
      assert.ok(textBlock?.text?.includes('<structured_output_contract>'), 'structured output contract must remain attached')
      assert.ok(
        textBlock!.text!.indexOf('[Attached Files]') < textBlock!.text!.indexOf('<structured_output_contract>'),
        '[Attached Files] must precede <structured_output_contract>',
      )
      assert.ok(!textBlock!.text!.includes(secretVal), 'spawn prompt sent to model must redact registered secrets')
      const imgBlock = firstContent.find((b) => b.type === 'image')
      assert.equal(imgBlock?.mimeType, 'image/png')
      assert.equal(imgBlock?.data, Buffer.from(pngBytes).toString('base64'))

      // 3. Structured output succeeded (with secret redacted in answer extraction).
      const parsed = structuredResult as { ok: boolean; note: string }
      assert.equal(parsed.ok, true)
      assert.ok(!parsed.note.includes(secretVal), 'extracted answer text must redact secrets')

      // 4. Child timeline persisted helmx.input entries (zero bare pi.user), carrying origin='agent', redacted text, and lightweight attachment refs.
      const detail = await kernel.conversations.getConversationDetail(childId, { limit: 100 })
      const piUsers = detail.entries.filter((e) => e.kind === 'pi.user')
      const helmxInputs = detail.entries.filter((e) => e.kind === 'helmx.input')
      assert.equal(piUsers.length, 0, 'spawn must persist helmx.input rather than bare pi.user')
      assert.equal(helmxInputs.length, 2, 'initial turn + schema-heal turn must both persist as helmx.input')
      const firstData = helmxInputs[0]!.data as {
        id?: string
        text?: string
        origin?: string
        attachments?: Array<Record<string, unknown>>
      }
      assert.equal(firstData.id, 'req-spawn-img-schema')
      assert.equal(firstData.origin, 'agent')
      assert.ok(firstData.text && !firstData.text.includes(secretVal), 'helmx.input.data.text must be redacted')
      assert.deepEqual(
        firstData.attachments?.map((a) => ({ id: a['id'], name: a['name'], mimeType: a['mimeType'], size: a['size'] })),
        [{ id: pngMeta.id, name: 'diagram.png', mimeType: 'image/png', size: pngBytes.byteLength }],
      )
      const healData = helmxInputs[1]!.data as { id?: string; origin?: string }
      assert.equal(healData.id, 'req-spawn-img-schema:schema-heal')
      assert.equal(healData.origin, 'agent')

      // 5. turn_settled emitted cleanly with exact tracked inputs (origin='agent', unread=false, status='idle').
      const childSettled = settled.filter((p) => p.conversation.id === childId)
      assert.equal(childSettled.length, 2, 'initial turn and schema-heal turn each settle once')
      assert.equal(childSettled[0]!.outcome, 'completed')
      assert.equal(childSettled[0]!.conversation.unread, false)
      assert.equal(childSettled[0]!.conversation.status, 'idle')
      assert.deepEqual(
        childSettled[0]!.inputs.map((i) => ({ id: i.id, origin: i.origin })),
        [{ id: 'req-spawn-img-schema', origin: 'agent' }],
      )
      assert.ok(!childSettled[0]!.inputs[0]!.text.includes(secretVal), 'turn_settled inputs text must be redacted')
      assert.deepEqual(
        childSettled[1]!.inputs.map((i) => ({ id: i.id, origin: i.origin })),
        [{ id: 'req-spawn-img-schema:schema-heal', origin: 'agent' }],
      )
    } finally {
      await kernel.close()
    }
  })
})
