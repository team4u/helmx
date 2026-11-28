/**
 * Single-delivery regression tests for host events (real KernelRuntime + faux provider).
 *
 * Fixed bug: before EventHub's internal host delivery (single publish path) was introduced,
 * emitHostEvent's broadcast path called dispatchInternalEvent manually after events.publish,
 * and subscription during build also ran SSE fanout, causing active plugin/host emissions of
 * core conversation events to invoke internal listeners twice (and with mismatched payload shapes:
 * full envelope vs raw payload).
 *
 * Current contract:
 * 1. Public broadcast emitHostEvent('conversation.entry', etc.): internal listeners fire once,
 *    receiving the validated + redacted HelmxEvent envelope; returned Promise settles only after
 *    all registered async internal listeners finish (awaitable emitEvent contract); SSE emits 1 frame.
 * 2. Kernel-generated events (real commit -> tracker publishes conversation.entry): internal
 *    listeners and SSE frames correspond 1-to-1, once each with zero duplicates.
 * 3. broadcast:false: skips SSE (seq does not advance), internal listeners fire once.
 * 4. Kernel auto-event publish sites are non-blocking with respect to internal listeners
 *    (fire-and-forget; listener errors are isolated inside delivery with zero unhandledRejection).
 *
 * Runner: tsx --test; every test specifies explicit timeout against deadlocks.
 */
import { strict as assert } from 'node:assert'
import { withTimeout } from '@helmx/test-kit'
import { after, before, describe, it } from 'node:test'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationEntry, HelmxEventFrame, MaybePromise } from '@helmx/protocol'
import { KernelRuntime } from '../src/runtime/index.js'
import { EventHub } from '../src/runtime/events.js'
import { cleanupDir, deferred, makeFauxModels, makeTempDir, waitFor } from './helpers.js'

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']

let root: string

before(async () => {
  root = await makeTempDir('helmx-host-event-delivery-')
})

after(async () => {
  await cleanupDir(root)
})

async function openRuntime(dir: string): Promise<KernelRuntime & { __faux: FauxHandle }> {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models,
    autoResume: false,
  })
  return Object.assign(runtime, { __faux: faux })
}

/** Registers an internal listener via plugin (real ctx.host.onEvent path, including host-api wrappers). */
async function registerEntryListener(
  kernel: KernelRuntime,
  onCall: (entryId: string) => MaybePromise<void>,
): Promise<void> {
  await kernel.plugins.register({
    id: 'test:entry-listener',
    definePlugin(ctx) {
      ctx.host.onEvent('conversation.entry', (raw) => {
        const entry = (raw as { entry?: { id?: string } }).entry
        if (entry?.id === undefined) throw new Error('internal listener must receive HelmxEvent envelope (missing entry field)')
        return onCall(entry.id)
      })
    },
  })
}

describe('host event single-delivery contract', { timeout: 60_000 }, () => {
  it('public broadcast emitHostEvent(conversation.entry): fires internal once with envelope, Promise waits for async listeners, SSE emits once', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'public-emit-once'))
    try {
      const gate = deferred()
      let entered = 0
      let completed = 0
      await registerEntryListener(kernel, async () => {
        entered += 1
        await gate.promise
        completed += 1
      })
      const frames: HelmxEventFrame[] = []
      kernel.events.subscribe((frame) => {
        if (frame.event.type === 'conversation.entry') frames.push(frame)
      })

      const settled = deferred()
      const emit = kernel.emitHostEvent('conversation.entry', {
        conversationId: 1,
        entry: { id: 'manual-e1', kind: 'helmx.note', createdAt: 1, data: { n: 1 } },
      })
      assert.ok(emit instanceof Promise, 'emitEvent broadcast path returns an awaitable delivery Promise')
      void Promise.resolve(emit).then(() => settled.resolve(), () => settled.resolve())

      // Listener entered but not finished: emit Promise must not settle early (awaitable contract).
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      assert.equal(entered, 1, 'internal listener invoked once')
      assert.equal(completed, 0)
      let settledEarly = false
      void settled.promise.then(() => {
        settledEarly = true
      })
      await new Promise((r) => setImmediate(r))
      assert.equal(settledEarly, false, 'emit Promise must not settle before async listener completes')

      gate.resolve()
      await emit
      assert.equal(completed, 1, 'listener completes after gate opens')
      assert.equal(entered, 1, 'invoked exactly once overall (never double-delivered)')
      // SSE broadcast emits one matching frame.
      const matched = frames.filter((f) => {
        const event = f.event as { conversationId?: number; entry?: { id?: string } }
        return event.conversationId === 1 && event.entry?.id === 'manual-e1'
      })
      assert.equal(matched.length, 1, 'exactly one SSE frame emitted')
    } finally {
      await kernel.close()
    }
  })

  it('plugin.changed special publish path also waits for async internal listeners', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'plugin-event-await'))
    const gate = deferred()
    const entered = deferred()
    let calls = 0
    let settled = false
    let release: (() => void) | undefined
    try {
      await kernel.plugins.register({ id: 'test:lifecycle-event', definePlugin() {} })
      const plugin = kernel.plugins.list().find((item) => item.id === 'test:lifecycle-event')!
      release = kernel.onEvent('plugin.changed', async () => {
        calls++
        entered.resolve()
        await gate.promise
      })
      const published = kernel.emitHostEvent('plugin.changed', { plugin, ui: [] })
      assert.ok(published instanceof Promise)
      void published.then(() => { settled = true })
      await entered.promise
      await new Promise((done) => setImmediate(done))
      assert.equal(settled, false)
      assert.equal(calls, 1)
      gate.resolve()
      await published
      assert.equal(settled, true)
    } finally {
      gate.resolve()
      release?.()
      await kernel.close()
    }
  })

  it('plugin.changed emits even if refreshPluginTools throws', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'plugin-changed-refresh-throw'))
    try {
      ;(kernel as unknown as { refreshPluginTools: () => void }).refreshPluginTools = () => {
        throw new Error('tool hot-reload failed')
      }
      const seen: string[] = []
      kernel.events.subscribe((frame) => {
        const event = frame.event as { type: string }
        if (event.type === 'plugin.changed') seen.push(event.type)
      })
      kernel.emitHostEvent('plugin.changed', { plugin: { id: 'test:hot', version: '1.0.0', enabled: true } })
      assert.equal(seen.length, 1, 'plugin.changed must still emit on hot-reload failure so clients never miss state transitions')
    } finally {
      await kernel.close()
    }
  })

  it('EventHub.close detaches host dispatcher rather than retaining runtime callback', { timeout: 60_000 }, () => {
    const events = new EventHub({
      initialSeq: 0,
      snapshot: () => ({ seq: 0, conversations: [], pendingAsks: [], plugins: [], ui: [], pluginDocs: [] }),
      persistSeq: () => {},
    })
    let delivered = 0
    events.setHostDispatcher(() => { delivered++ })
    events.publish('test:before-close', {})
    assert.equal(delivered, 1)
    events.close()
    events.publish('test:after-close', {})
    assert.equal(delivered, 1)
  })

  it('kernel-generated events (real commit): internal listener and SSE frames align 1-to-1, once each', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'auto-events-once'))
    try {
      const internalEntries: Array<{ id: string; kind: string }> = []
      const sseEntries: Array<{ id: string; kind: string }> = []
      const releaseInternal = kernel.onEvent('conversation.entry', (raw) => {
        const entry = (raw as { entry?: ConversationEntry }).entry
        if (entry?.id !== undefined) internalEntries.push({ id: entry.id, kind: entry.kind })
      })
      kernel.events.subscribe((frame) => {
        if (frame.event.type !== 'conversation.entry') return
        const entry = (frame.event as { entry?: ConversationEntry }).entry
        if (entry?.id !== undefined) sseEntries.push({ id: entry.id, kind: entry.kind })
      })

      kernel.__faux.setResponses([fauxAssistantMessage('answer one'), fauxAssistantMessage('answer two')])
      await kernel.conversations.submitInput(1, 'first question')
      await kernel.conversations.waitForIdle(1)
      await kernel.conversations.submitInput(1, 'second question')
      await kernel.conversations.waitForIdle(1)
      await waitFor(() => internalEntries.filter((e) => e.kind === 'pi.assistant').length >= 2)
      releaseInternal()

      assert.ok(internalEntries.length >= 2, 'kernel conversation.entry events delivered to internal listener')
      assert.equal(
        sseEntries.some((e) => e.kind === 'pi.system'),
        false,
        'SSE conversation.entry must exclude internal pi.system entries',
      )
      const internalVisibleIds = internalEntries.filter((e) => e.kind !== 'pi.system').map((e) => e.id)
      const sseIds = sseEntries.map((e) => e.id)
      assert.deepEqual(
        [...internalVisibleIds].sort(),
        [...sseIds].sort(),
        'internal non-system entries and SSE frames match 1-to-1 (delivered once, never duplicated)',
      )
      assert.equal(new Set(internalEntries.map((e) => e.id)).size, internalEntries.length, 'no entry delivered twice')
      if (internalEntries.some((e) => e.kind === 'pi.system')) {
        assert.ok(
          internalEntries.length > sseEntries.length,
          'internal listeners still observe pi.system entries omitted from SSE',
        )
      }
    } finally {
      await kernel.close()
    }
  })

  it('SSE conversation.entry projects signatures & oversized toolResult while internal listeners receive raw entries', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'sse-entry-projection'))
    try {
      const internalEntries: ConversationEntry[] = []
      const sseEntries: ConversationEntry[] = []
      const releaseInternal = kernel.onEvent('conversation.entry', (raw) => {
        const entry = (raw as { entry?: ConversationEntry }).entry
        if (entry !== undefined) internalEntries.push(entry)
      })
      kernel.events.subscribe((frame) => {
        if (frame.event.type !== 'conversation.entry') return
        const entry = (frame.event as { entry?: ConversationEntry }).entry
        if (entry !== undefined) sseEntries.push(entry)
      })

      const markerOutput = 'X'.repeat(2200)
      kernel.__faux.setResponses([
        fauxAssistantMessage(
          [
            { type: 'thinking', thinking: 'planning', thinkingSignature: 'sig-thinking-1' } as never,
            { type: 'text', text: 'running tool', textSignature: 'sig-text-1' } as never,
            {
              ...fauxToolCall('bash', {
                command: `node -e "process.stdout.write('${markerOutput}')"`,
              }),
              thoughtSignature: 'sig-thought-1',
            } as never,
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('done'),
      ])
      await kernel.conversations.submitInput(1, 'run projection test')
      await kernel.conversations.waitForIdle(1)
      await waitFor(
        () =>
          internalEntries.some((e) => e.kind === 'pi.tool-result') &&
          sseEntries.some((e) => e.kind === 'pi.tool-result') &&
          sseEntries.filter((e) => e.kind === 'pi.assistant').length >= 2,
      )
      releaseInternal()

      assert.equal(sseEntries.some((e) => e.kind === 'pi.system'), false, 'SSE must omit pi.system')

      const internalAssistant = internalEntries.find(
        (e) => e.kind === 'pi.assistant' && Array.isArray((e.model?.[0] as { content?: unknown[] } | undefined)?.content) &&
          ((e.model![0] as { content: Array<{ type?: string }> }).content.some((b) => b.type === 'thinking')),
      )
      assert.ok(internalAssistant, 'internal listener must receive assistant entry with thinking block')
      const sseAssistant = sseEntries.find((e) => e.id === internalAssistant.id)
      assert.ok(sseAssistant, 'SSE must receive matching assistant entry')

      const internalBlocks = (internalAssistant.model![0] as { content: Array<Record<string, unknown>> }).content
      const sseBlocks = (sseAssistant.model![0] as { content: Array<Record<string, unknown>> }).content
      assert.equal(internalBlocks[0]?.['thinkingSignature'], 'sig-thinking-1')
      assert.equal(internalBlocks[1]?.['textSignature'], 'sig-text-1')
      assert.equal(internalBlocks[2]?.['thoughtSignature'], 'sig-thought-1')
      assert.equal('thinkingSignature' in (sseBlocks[0] ?? {}), false, 'SSE must strip thinkingSignature')
      assert.equal('textSignature' in (sseBlocks[1] ?? {}), false, 'SSE must strip textSignature')
      assert.equal('thoughtSignature' in (sseBlocks[2] ?? {}), false, 'SSE must strip thoughtSignature')

      const internalToolResult = internalEntries.find((e) => e.kind === 'pi.tool-result')
      const sseToolResult = sseEntries.find((e) => e.id === internalToolResult?.id)
      assert.ok(internalToolResult && sseToolResult, 'both internal and SSE must observe pi.tool-result')

      const internalMsg = internalToolResult.model![0] as { content: Array<{ text?: string }>; truncated?: boolean }
      const sseMsg = sseToolResult.model![0] as {
        content: Array<{ text?: string }>
        truncated?: boolean
        totalChars?: number
        totalLines?: number
      }
      const internalText = internalMsg.content.map((c) => c.text ?? '').join('')
      const sseText = sseMsg.content.map((c) => c.text ?? '').join('')
      assert.equal(internalMsg.truncated, undefined, 'internal listener keeps untruncated toolResult')
      assert.ok(internalText.includes(markerOutput), 'internal listener keeps full tool output')
      assert.equal(sseMsg.truncated, true, 'SSE toolResult must be projected with truncated: true')
      assert.ok((sseMsg.totalChars ?? 0) >= 2200)
      assert.ok((sseMsg.totalLines ?? 0) >= 1)
      assert.ok(sseText.length < internalText.length, 'SSE toolResult text must be shorter than raw output')
    } finally {
      await kernel.close()
    }
  })

  it('broadcast:false skips SSE (without advancing seq) and invokes internal listener once', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'private-emit-once'))
    try {
      const received: unknown[] = []
      await kernel.plugins.register({
        id: 'test:private-listener',
        definePlugin(ctx) {
          ctx.host.onEvent('conversation.upsert', (raw) => {
            received.push(raw)
          })
        },
      })
      const frames: HelmxEventFrame[] = []
      kernel.events.subscribe((frame) => frames.push(frame))
      const seqBefore = kernel.events.seq

      const summary = {
        id: 1,
        title: 't',
        profileId: 'assistant',
        tags: [],
        cwd: '/tmp',
        model: '',
        thinkingLevel: '',
        status: 'idle',
        stateChangeSeq: 99,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      const emit = kernel.emitHostEvent('conversation.upsert', summary, { broadcast: false })
      await emit

      assert.equal(received.length, 1, 'internal listener invoked once')
      // broadcast:false preserves existing semantics: skips buildEvent and delivers payload directly.
      assert.equal((received[0] as { id?: number }).id, 1)
      assert.equal(kernel.events.seq, seqBefore, 'broadcast:false must not advance SSE seq')
      const upsertFrames = frames.filter((f) => f.event.type === 'conversation.upsert')
      assert.equal(upsertFrames.length, 0, 'broadcast:false must not broadcast')
    } finally {
      await kernel.close()
    }
  })

  it('kernel auto-event path is non-blocking: slow listeners do not stall publish, errors produce no unhandledRejection', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'auto-nonblocking'))
    try {
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason)
      }
      process.on('unhandledRejection', onUnhandled)
      const gate = deferred()
      let slowEntered = 0
      // Register two listeners for the same type: a gated slow listener + a throwing listener, verifying neither blocks.
      await kernel.plugins.register({
        id: 'test:slow-listener',
        definePlugin(ctx) {
          ctx.host.onEvent('conversation.entry', async () => {
            slowEntered += 1
            await gate.promise
          })
          ctx.host.onEvent('conversation.entry', async () => {
            throw new Error('listener exploded')
          })
        },
      })

      kernel.__faux.setResponses([fauxAssistantMessage('answer')])
      // submitInput pipeline (including tracker observer publishing conversation.entry) completes normally while slow
      // listener stays suspended -- auto-event publish sites never await internal delivery.
      const submitted = kernel.conversations.submitInput(1, 'prompt under slow listener')
      const deadline = Date.now() + 5_000
      while (slowEntered < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10))
      }
      assert.ok(slowEntered >= 1, 'slow listener was invoked and suspended')
      await withTimeout(kernel.conversations.waitForIdle(1), 5_000, 'slow listener must not block turn progression')
      await submitted

      gate.resolve()
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(unhandled.length, 0, 'listener errors are isolated inside delivery without unhandledRejection')
      process.off('unhandledRejection', onUnhandled)
    } finally {
      await kernel.close()
    }
  })

  it('dispatchInternalEvent isolates listener throws: subsequent listeners run and no unhandledRejection occurs', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'internal-listener-isolation'))
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      let secondRan = false
      kernel.onEvent('test:probe', async () => { throw new Error('a listener failed') })
      kernel.onEvent('test:probe', async () => { secondRan = true })
      // Fire-and-forget invocation (without await/catch), matching plugin-host emitEvent call posture.
      void kernel.emitHostEvent('test:probe', { a: 1 })
      await new Promise((resolve) => setImmediate(resolve))
      await kernel.emitHostEvent('test:probe', { a: 2 })
      assert.equal(secondRan, true, 'first listener throwing must not block subsequent listeners')
      assert.equal(unhandled.length, 0, 'promise returned by dispatchInternalEvent must not reject')
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await kernel.close()
    }
  })
})
