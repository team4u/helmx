/**
 * Integration tests for kernel built-in `ask_user` tool, scope isolation,
 * direct human-input supersede without hanging, abort cancellation, and restart orphan sweep.
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import {
  ASK_USER_TOOL_META_SCHEMA,
  HelmxError,
  assertBoundedPresentationMeta,
  type HelmxEvent,
} from '@helmx/protocol'
import { KernelRuntime } from '../src/runtime/index.js'
import { systemSectionsOf } from '../src/runtime/hook-projection.js'
import { ASK_USER_OWNER_ID, ASK_USER_TOOL_NAME } from '../src/runtime/tools.js'
import { cleanupDir, makeFauxModels, makeTempDir } from './helpers.js'

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, 15))
  }
}

let rootDir: string

before(async () => {
  rootDir = await makeTempDir('helmx-ask-user-tool-')
}, { timeout: 60_000 })

after(async () => {
  await cleanupDir(rootDir)
}, { timeout: 60_000 })

describe('ask_user kernel tool lifecycle and scoping', { timeout: 60_000 }, () => {
  it('supports single_select, multi_select, text, confirm, SecretStash redaction, presentationMeta, and prompt projection', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'full-flow')
    const { models, faux } = makeFauxModels()
    const runtime = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models,
    })
    const disposeSecret = runtime.stash.addRedaction('MY_SECRET_TOKEN')
    const events: HelmxEvent[] = []
    const unsub = runtime.events.subscribe((frame) => {
      events.push(frame.event)
    })

    try {
      const capturedSections: Array<{ id: string; text: string }> = []
      let secondTurnMessagesText = ''
      faux.setResponses([
        (context) => {
          capturedSections.push(...systemSectionsOf(context.messages))
          const toolNames = getCurrentTools(context.messages).map((t) => t.name)
          assert.ok(toolNames.includes(ASK_USER_TOOL_NAME), 'top-level human conversation receives ask_user tool')
          return fauxAssistantMessage(
            [
              fauxToolCall(ASK_USER_TOOL_NAME, {
                title: 'Project Setup',
                questions: [
                  {
                    id: 'framework',
                    question: 'Which framework?',
                    type: 'single_select',
                    options: [
                      { value: 'react', label: 'React', recommended: true },
                      { value: 'vue', label: 'Vue' },
                    ],
                  },
                  {
                    id: 'features',
                    question: 'Which features?',
                    type: 'multi_select',
                    options: [
                      { value: 'auth', label: 'Auth' },
                      { value: 'db', label: 'Database' },
                    ],
                  },
                  {
                    id: 'notes',
                    question: 'Any extra context?',
                    type: 'text',
                    multiline: true,
                    placeholder: 'Enter notes...',
                  },
                  {
                    id: 'proceed',
                    question: 'Continue now?',
                    type: 'confirm',
                    confirmLabel: 'Start',
                    rejectLabel: 'Hold',
                  },
                ],
              }),
            ],
            { stopReason: 'toolUse' },
          )
        },
        (context) => {
          secondTurnMessagesText = JSON.stringify(context.messages)
          return fauxAssistantMessage('Got all your answers!')
        },
      ])

      await runtime.conversations.submitInput(1, 'Help me set up a new project')
      await waitFor(() => runtime.asks.listAsks('pending').length === 1)

      const ask = runtime.asks.listAsks('pending')[0]!
      assert.equal(ask.kind, 'question')
      assert.equal(ask.ownerPluginId, ASK_USER_OWNER_ID)
      assert.equal(ask.fields.length, 4)
      assert.equal(ask.fields[0]?.type, 'choice')
      assert.equal(ask.fields[0]?.allowCustom, true)
      assert.equal(ask.fields[0]?.options?.[0]?.recommended, true)
      assert.equal(ask.fields[1]?.multiple, true)
      assert.equal(ask.fields[2]?.multiline, true)
      assert.equal(ask.fields[3]?.confirmLabel, 'Start')
      assert.equal(runtime.conversations.getConversation(1).status, 'blocked')

      assert.ok(
        capturedSections.some((s) => s.id === 'prompt.tools.ask_user'),
        'prompt.tools.ask_user must be projected for top-level human conversation',
      )

      await runtime.asks.answerAsk(
        ask.id,
        {
          framework: 'svelte',
          features: ['auth', 'telemetry-MY_SECRET_TOKEN'],
          notes: 'Use token MY_SECRET_TOKEN',
          proceed: 'true',
        },
        ask.expectedStateSeq,
      )
      await runtime.conversations.waitForIdle(1)

      assert.ok(secondTurnMessagesText.includes('svelte (custom)'))
      assert.ok(secondTurnMessagesText.includes('auth (Auth), telemetry-[REDACTED] (custom)'))
      assert.ok(secondTurnMessagesText.includes('Use token [REDACTED]'))
      assert.ok(secondTurnMessagesText.includes('Start'))
      assert.equal(secondTurnMessagesText.includes('MY_SECRET_TOKEN'), false)

      const detail = await runtime.conversations.getConversationDetail(1, { limit: 50 })
      const toolResultEntry = detail.entries.find((e) => e.kind === 'pi.tool-result')
      assert.ok(toolResultEntry, 'tool result persisted')
      const details = (toolResultEntry!.model?.[0] as { details?: unknown } | undefined)?.details
      const meta = assertBoundedPresentationMeta(details, { schema: ASK_USER_TOOL_META_SCHEMA }) as {
        title: string
        questionCount: number
        outcome: string
        items?: Array<{ id: string; question: string; answer: string }>
      }
      assert.equal(meta.title, 'Project Setup')
      assert.equal(meta.questionCount, 4)
      assert.equal(meta.outcome, 'answered')
      assert.equal(meta.items?.length, 4)
      assert.equal(meta.items?.[0]?.answer, 'svelte (custom)')
      assert.equal(meta.items?.[2]?.answer, 'Use token [REDACTED]')

      const resolvedEvent = events.find(
        (ev): ev is Extract<HelmxEvent, { type: 'ask.resolved'; askId: string }> =>
          ev.type === 'ask.resolved' && 'askId' in ev && ev.askId === ask.id,
      )
      assert.ok(resolvedEvent)
      assert.equal(resolvedEvent.status, 'answered')
      assert.deepEqual(resolvedEvent.answers, {
        framework: 'svelte',
        features: ['auth', 'telemetry-[REDACTED]'],
        notes: 'Use token [REDACTED]',
        proceed: 'true',
      })
    } finally {
      unsub()
      disposeSecret()
      await runtime.close()
    }
  })

  it('strips ask_user and its prompt section from subagents and helmx-owned conversations', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'scope-check')
    const { models, faux } = makeFauxModels()
    const runtime = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models,
    })

    try {
      const child = await runtime.conversations.createConversation({
        title: 'child',
        parentConversationId: 1,
      })
      const helmxConv = await runtime.conversations.createConversation({
        title: 'automated',
        ownedBy: 'helmx',
      })

      for (const convId of [child.id, helmxConv.id]) {
        let seenTools: string[] = []
        let seenSections: Array<{ id: string; text: string }> = []
        faux.setResponses([
          (context) => {
            seenTools = getCurrentTools(context.messages).map((t) => t.name)
            seenSections = systemSectionsOf(context.messages)
            return fauxAssistantMessage('done')
          },
        ])
        await runtime.conversations.submitInput(convId, 'check tools', { origin: 'agent' })
        await runtime.conversations.waitForIdle(convId)
        assert.ok(seenTools.includes('read'), `conv #${convId} must still receive baseline tools`)
        assert.equal(seenTools.includes(ASK_USER_TOOL_NAME), false, `conv #${convId} must not see ask_user`)
        assert.equal(
          seenSections.some((s) => s.id === 'prompt.tools.ask_user'),
          false,
          `conv #${convId} must not inject prompt.tools.ask_user`,
        )
      }

      // Direct tool invocation guard inside subagent fails explicitly with isError
      let toolResultStr = ''
      faux.setResponses([
        () =>
          fauxAssistantMessage(
            [
              fauxToolCall(ASK_USER_TOOL_NAME, {
                questions: [{ id: 'q', question: 'Should fail?', type: 'text' }],
              }),
            ],
            { stopReason: 'toolUse' },
          ),
        (context) => {
          toolResultStr = JSON.stringify(context.messages)
          return fauxAssistantMessage('handled rejection')
        },
      ])
      await runtime.conversations.submitInput(child.id, 'force call', { origin: 'agent' })
      await runtime.conversations.waitForIdle(child.id)
      assert.match(toolResultStr, /top-level human conversations/i)
      assert.equal(runtime.asks.listAsks('pending').length, 0)
    } finally {
      await runtime.close()
    }
  })

  it('direct human Composer message supersedes pending ask cleanly without hanging (and whenBusy=reject does not supersede)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'human-supersede')
    const { models, faux } = makeFauxModels()
    const runtime = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models,
    })

    try {
      let resumedMessages = ''
      faux.setResponses([
        () =>
          fauxAssistantMessage(
            [
              fauxToolCall(ASK_USER_TOOL_NAME, {
                questions: [
                  {
                    id: 'cache',
                    question: 'Which cache?',
                    options: [
                      { value: 'redis', label: 'Redis' },
                      { value: 'mem', label: 'Memory' },
                    ],
                  },
                ],
              }),
            ],
            { stopReason: 'toolUse' },
          ),
        (context) => {
          resumedMessages = JSON.stringify(context.messages)
          return fauxAssistantMessage('Understood, using SQLite directly.')
        },
      ])

      await runtime.conversations.submitInput(1, 'Pick cache layer')
      await waitFor(() => runtime.asks.listAsks('pending').length === 1)
      const pendingId = runtime.asks.listAsks('pending')[0]!.id

      // whenBusy: 'reject' must fail 409 without superseding the pending ask
      await assert.rejects(
        () => runtime.conversations.submitInput(1, 'Should reject', { origin: 'human', whenBusy: 'reject' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'conversation_busy',
      )
      assert.equal(runtime.asks.listAsks('pending').length, 1)

      // Direct human steer supersedes pending ask and injects message into the same continuation turn
      await runtime.conversations.submitInput(1, 'Skip the options and use SQLite', { origin: 'human' })
      await runtime.conversations.waitForIdle(1)

      assert.equal(runtime.asks.getAsk(pendingId)?.status, 'superseded')
      assert.equal(runtime.asks.listAsks('pending').length, 0)
      assert.match(resumedMessages, /superseded/i)
      assert.match(resumedMessages, /Skip the options and use SQLite/)
    } finally {
      await runtime.close()
    }
  })

  it('aborting conversation cancels pending ask_user and unblocks conversation; restart sweeps orphaned core:ask_user asks', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'abort-and-restart')
    const { models: m1, faux: f1 } = makeFauxModels()
    const r1 = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models: m1,
    })

    let cancelledId = ''
    try {
      f1.setResponses([
        () =>
          fauxAssistantMessage(
            [fauxToolCall(ASK_USER_TOOL_NAME, { questions: [{ id: 'q', question: 'Confirm?' }] })],
            { stopReason: 'toolUse' },
          ),
      ])
      await r1.conversations.submitInput(1, 'Ask me something')
      await waitFor(() => r1.asks.listAsks('pending').length === 1)
      cancelledId = r1.asks.listAsks('pending')[0]!.id

      await r1.conversations.abortConversation(1)
      await r1.conversations.waitForIdle(1)
      assert.equal(r1.asks.getAsk(cancelledId)?.status, 'cancelled')
      assert.notEqual(r1.conversations.getConversation(1).status, 'blocked')

      // Seed an orphaned core:ask_user AskDoc in SQLite (simulating SIGKILL) and restart
      const orphanWaiter = r1.asks.createAsk({
        id: 'orphan-ask-user-1',
        conversationId: 1,
        ownerPluginId: ASK_USER_OWNER_ID,
        kind: 'question',
        title: 'Orphaned question',
        fields: [{ name: 'q', label: 'Question', type: 'text' }],
      })
      void orphanWaiter.catch(() => {})
      await waitFor(() => r1.asks.listAsks('pending').length === 1)
    } finally {
      await r1.close()
    }

    const { models: m2 } = makeFauxModels()
    const r2 = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models: m2,
    })
    try {
      assert.equal(r2.asks.listAsks('pending').length, 0)
      assert.equal(r2.asks.getAsk('orphan-ask-user-1')?.status, 'superseded')
      assert.equal(r2.conversations.getConversation(1).pendingAskCount, 0)
      assert.notEqual(r2.conversations.getConversation(1).status, 'blocked')
    } finally {
      await r2.close()
    }
  })
})
