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
import { ASK_USER_OWNER_ID, ASK_USER_PROMPT_SNIPPET, ASK_USER_TOOL_NAME } from '../src/runtime/tools.js'
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
      assert.match(resumedMessages, /do not treat this as confirmation/i)
      assert.match(resumedMessages, /Skip the options and use SQLite/)
      assert.match(ASK_USER_PROMPT_SNIPPET, /superseded/i)
      assert.match(ASK_USER_PROMPT_SNIPPET, /never treat `superseded` or `cancelled`/i)
    } finally {
      await runtime.close()
    }
  })

  it('whenPendingAsk=reject atomically rejects with 409 ask_pending across fast check, hook race, and history rewind without side effects', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'when-pending-ask-reject')
    const { models, faux } = makeFauxModels()
    const runtime = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models,
    })

    try {
      // 1. Succeeds when no AskDoc is pending (and does not leak whenPendingAsk into entry when omitted).
      faux.setResponses([
        () => fauxAssistantMessage('First turn done.'),
        () =>
          fauxAssistantMessage(
            [fauxToolCall(ASK_USER_TOOL_NAME, { questions: [{ id: 'q1', question: 'Proceed?', type: 'confirm' }] })],
            { stopReason: 'toolUse' },
          ),
        () => fauxAssistantMessage('Second turn finished.'),
      ])
      await runtime.conversations.submitInput(1, 'Initial message', { whenPendingAsk: 'reject' })
      await runtime.conversations.waitForIdle(1)

      // 2. Fast pre-check when AskDoc is already pending on conversation 1: rejects 409 ask_pending and leaves ask pending.
      await runtime.conversations.submitInput(1, 'Trigger ask')
      await waitFor(() => runtime.asks.listAsks('pending').length === 1)
      const activeAskId = runtime.asks.listAsks('pending')[0]!.id

      let rejectedErr: unknown
      await assert.rejects(
        () => runtime.conversations.submitInput(1, 'Blocked while pending', { origin: 'human', whenPendingAsk: 'reject' }),
        (err: unknown) => {
          rejectedErr = err
          return err instanceof HelmxError && err.status === 409 && err.code === 'ask_pending'
        },
      )
      assert.deepEqual((rejectedErr as HelmxError).details, {
        conversationId: 1,
        pendingAskIds: [activeAskId],
      })
      assert.equal(runtime.asks.getAsk(activeAskId)?.status, 'pending')

      // 3. Rewind (replaceFromEntryId) with whenPendingAsk=reject also fails 409 ask_pending without aborting or superseding.
      const detailBeforeRewind = await runtime.conversations.getConversationDetail(1, { limit: 20 })
      const firstInputEntry = detailBeforeRewind.entries.find((e) => e.kind === 'helmx.input')!
      await assert.rejects(
        () =>
          runtime.conversations.submitInput(1, 'Edited message', {
            origin: 'human',
            whenPendingAsk: 'reject',
            replaceFromEntryId: Number(firstInputEntry.id),
          }),
        (err: unknown) => err instanceof HelmxError && err.status === 409 && err.code === 'ask_pending',
      )
      assert.equal(runtime.asks.getAsk(activeAskId)?.status, 'pending')

      await runtime.asks.answerAsk(activeAskId, { q1: 'true' })
      await runtime.conversations.waitForIdle(1)

      // 4. Commit-point TOCTOU race: untitled conversation #2 has zero pending asks at fast pre-check,
      // then an AskDoc is created while an async onInput hook is suspended -> commit-point re-check rejects
      // 409 ask_pending with zero entry persistence, zero title mutation, and zero stateChangeSeq bump.
      const raceConv = await runtime.conversations.createConversation({ title: '' })
      let enteredHook!: () => void
      const hookEntered = new Promise<void>((resolve) => {
        enteredHook = resolve
      })
      let releaseHook!: () => void
      const hookGate = new Promise<void>((resolve) => {
        releaseHook = resolve
      })
      await runtime.plugins.register({
        id: 'test:ask-pending-race',
        definePlugin: (ctx) => {
          ctx.hook.onInput(async (payload) => {
            if (payload.conversationId === raceConv.id) {
              enteredHook()
              await hookGate
            }
          })
        },
      })

      const seqBeforeRace = runtime.conversations.getConversation(raceConv.id).stateChangeSeq
      const raceInputP = runtime.conversations.submitInput(raceConv.id, 'Concurrent IM message', {
        origin: 'human',
        whenPendingAsk: 'reject',
      })
      await hookEntered
      const raceAskP = runtime.asks.createAsk({
        id: 'race-ask-1',
        conversationId: raceConv.id,
        title: 'Concurrent Ask',
        fields: [{ name: 'ok', label: 'OK?', type: 'confirm' }],
      })
      void raceAskP.catch(() => {})
      await waitFor(() => runtime.asks.listPendingByConversation(raceConv.id).length === 1)
      const seqAfterAskCreated = runtime.conversations.getConversation(raceConv.id).stateChangeSeq
      releaseHook()

      await assert.rejects(
        () => raceInputP,
        (err: unknown) => err instanceof HelmxError && err.status === 409 && err.code === 'ask_pending',
      )
      assert.equal(runtime.asks.getAsk('race-ask-1')?.status, 'pending')
      assert.equal(runtime.conversations.getConversation(raceConv.id).title, '')
      assert.equal(runtime.conversations.getConversation(raceConv.id).stateChangeSeq, seqAfterAskCreated)
      assert.ok(seqAfterAskCreated > seqBeforeRace)
      const raceDetail = await runtime.conversations.getConversationDetail(raceConv.id)
      assert.equal(raceDetail.entries.some((e) => e.kind === 'helmx.input'), false)
      await runtime.asks.cancelAsk('race-ask-1')
    } finally {
      await runtime.close()
    }
  })

  it('read/pin PATCH (unread/pinned) and sibling tool doing updates during blocked do not supersede pending AskDoc', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'cas-false-supersede')
    const { models, faux } = makeFauxModels()
    const runtime = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models,
    })

    try {
      // 1. Seed unread=true on a completed turn (also verify done->idle unread clear still bumps stateChangeSeq when no ask is pending).
      faux.setResponses([
        () => fauxAssistantMessage('First done.'),
        () =>
          fauxAssistantMessage(
            [
              fauxToolCall('read', { path: 'missing-or-noop' }),
              fauxToolCall(ASK_USER_TOOL_NAME, { questions: [{ id: 'choice', question: 'Continue?', type: 'confirm' }] }),
            ],
            { stopReason: 'toolUse' },
          ),
        () => fauxAssistantMessage('All good after answer.'),
      ])
      await runtime.conversations.submitInput(1, 'Warm up')
      await runtime.conversations.waitForIdle(1)
      assert.equal(runtime.conversations.getConversation(1).unread, true)
      const seqDone = runtime.conversations.getConversation(1).stateChangeSeq
      await runtime.conversations.updateConversation(1, { unread: false })
      assert.ok(
        runtime.conversations.getConversation(1).stateChangeSeq > seqDone,
        'unread=false when pendingAskCount===0 must still advance stateChangeSeq',
      )

      // 2. Leave unread=true by simulating a new round on an unread conversation where parallel `read` + `ask_user` run.
      await runtime.conversations.updateConversation(1, { unread: true })
      await runtime.conversations.submitInput(1, 'Ask alongside read')
      await waitFor(() => runtime.asks.listAsks('pending').length === 1)
      // Give the parallel `read` tool and tracker observer a brief moment to complete and emit `doing` updates.
      await new Promise((r) => setTimeout(r, 150))

      const ask = runtime.asks.listAsks('pending')[0]!
      const seqWhileBlocked = runtime.conversations.getConversation(1).stateChangeSeq
      // Simulate Web foreground focus clearing unread=false + pinning while AskDoc is pending.
      await runtime.conversations.updateConversation(1, {
        unread: false,
        pinned: true,
      })
      assert.equal(
        runtime.conversations.getConversation(1).stateChangeSeq,
        seqWhileBlocked,
        'read/pin PATCH while AskDoc is pending must not advance stateChangeSeq',
      )
      assert.equal(runtime.conversations.getConversation(1).unread, false)
      assert.equal(runtime.conversations.getConversation(1).pinned, true)

      const settled = await runtime.asks.answerAsk(ask.id, { choice: 'true' }, ask.expectedStateSeq)
      assert.equal(settled.status, 'answered')
      await runtime.conversations.waitForIdle(1)

      // 3. Also verify mid-run doing transition (bash running -> done) while an AskDoc with expectedStateSeq is
      // pending emits refreshed doing summary WITHOUT advancing stateChangeSeq or falsely superseding answerAsk.
      let releaseSecondTurn!: () => void
      const secondTurnGate = new Promise<void>((resolve) => {
        releaseSecondTurn = resolve
      })
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 0.1 && echo ok' })], { stopReason: 'toolUse' }),
        async () => {
          await secondTurnGate
          return fauxAssistantMessage('Bash round completed.')
        },
      ])
      const blockedUpserts: Array<{ status: string; doing?: string; stateChangeSeq: number }> = []
      const unsubBlocked = runtime.events.subscribe((frame) => {
        if (frame.event.type !== 'conversation.upsert') return
        const conv = (frame.event as { conversation?: { id?: number; status?: string; doing?: string; stateChangeSeq?: number } }).conversation
        if (conv?.id === 1 && conv.status === 'blocked') {
          blockedUpserts.push({
            status: conv.status,
            doing: conv.doing,
            stateChangeSeq: conv.stateChangeSeq ?? -1,
          })
        }
      })
      try {
        await runtime.conversations.submitInput(1, 'Run bash while ask pending')
        await waitFor(() => runtime.conversations.getConversation(1).doing?.startsWith('bash:') === true)
        const convBeforeAsk = runtime.conversations.getConversation(1)
        const liveAskP = runtime.asks.createAsk({
          id: 'live-doing-ask',
          conversationId: 1,
          title: 'Live doing ask',
          expectedStateSeq: convBeforeAsk.stateChangeSeq,
          fields: [{ name: 'ok', label: 'OK?', type: 'confirm' }],
        })
        await waitFor(() => runtime.conversations.getConversation(1).status === 'blocked')
        const seqAfterAskCreated = runtime.conversations.getConversation(1).stateChangeSeq
        // Wait for bash tool call to finish and emit a refreshed doing frame while blocked.
        await waitFor(() =>
          blockedUpserts.some((u) => u.doing !== undefined && u.doing !== 'bash: running'),
        )
        assert.equal(
          runtime.conversations.getConversation(1).stateChangeSeq,
          seqAfterAskCreated,
          'doing transition during blocked must not advance stateChangeSeq',
        )
        const liveSettled = await runtime.asks.answerAsk('live-doing-ask', { ok: 'true' }, convBeforeAsk.stateChangeSeq)
        assert.equal(liveSettled.status, 'answered')
        assert.equal((await liveAskP).status, 'answered')
      } finally {
        unsubBlocked()
        releaseSecondTurn()
        await runtime.conversations.waitForIdle(1)
      }
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
