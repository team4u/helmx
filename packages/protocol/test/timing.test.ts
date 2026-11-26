import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConversationTiming } from '@helmx/protocol'
import { resolveConversationTiming as resolveBrowserConversationTiming } from '@helmx/protocol/browser'

test('resolveConversationTiming computes settled, live running, total, and ask waiting durations honestly', { timeout: 60_000 }, () => {
  assert.equal(resolveConversationTiming, resolveBrowserConversationTiming)

  // Idle / done state without live run
  assert.deepEqual(resolveConversationTiming({ status: 'idle', runDurationMs: 1250 }, 5000), {
    settledRunMs: 1250,
    totalRunMs: 1250,
    isRunning: false,
    isBlocked: false,
  })

  // Idle without any prior settled duration omits totalRunMs
  assert.deepEqual(resolveConversationTiming({ status: 'idle', runDurationMs: 0, runStartedAt: 1000 }, 5000), {
    settledRunMs: 0,
    isRunning: false,
    isBlocked: false,
  })

  // Working state with wall clock and prior settled time
  assert.deepEqual(
    resolveConversationTiming({ status: 'working', runDurationMs: 2000, runStartedAt: 3000 }, 5500),
    {
      settledRunMs: 2000,
      currentRunMs: 2500,
      totalRunMs: 4500,
      isRunning: true,
      isBlocked: false,
    },
  )

  // Blocked with pendingAskSince and running parent turn
  assert.deepEqual(
    resolveConversationTiming(
      { status: 'blocked', runDurationMs: 1000, runStartedAt: 2000, pendingAskSince: 3500, pendingAskCount: 1 },
      6000,
    ),
    {
      settledRunMs: 1000,
      currentRunMs: 4000,
      totalRunMs: 5000,
      waitingMs: 2500,
      isRunning: true,
      isBlocked: true,
    },
  )

  // Missing nowMs never fabricates live elapsed clocks
  assert.deepEqual(
    resolveConversationTiming({ status: 'working', runDurationMs: 500, runStartedAt: 2000 }),
    {
      settledRunMs: 500,
      totalRunMs: 500,
      isRunning: true,
      isBlocked: false,
    },
  )
})
