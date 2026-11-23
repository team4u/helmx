import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HelmxError,
  applyConversationLiveDelta,
  applyTextPrefix,
  diffConversationLive,
  diffTextPrefix,
  encodeSessionDocSubParam,
  parseSessionDocSubParam,
  sameConversationLiveContent,
  sameQueuedInputs,
  type ConversationDetail,
  type ConversationLive,
  type ConversationLiveDelta,
  type ConversationLiveEvent,
  type ConversationSummary,
  type HelmxEvent,
  type HelmxEventType,
  type HelmxHostApi,
  type HelmxHostNodeIpcPort,
  type HelmxPluginContext,
  type HelmxResumedFrame,
  type HelmxTransientLiveDeltaFrame,
  type HelmxTransientLiveFrame,
  type HostEventEmitPayload,
  type HostEventMap,
  type HostNodesSlice,
  type HostProfilesSlice,
  type MaybePromise,
  type NodeInfo,
  type PluginClientContext,
  type PluginDocOptions,
  type PluginServiceSpec,
  type PluginSummary,
  type Profile,
  type PublicPluginSessionDoc,
  type SessionDocMultiplexAction,
  type SessionDocMultiplexFrame,
  type SessionDocSubscription,
} from '../src/index.js'
import type {
  HostEventMap as BrowserHostEventMap,
  HostNodesSlice as BrowserHostNodesSlice,
  HostProfilesSlice as BrowserHostProfilesSlice,
} from '../src/browser.js'

function assertValidationError(fn: () => unknown, leakedSecrets: readonly string[] = []): void {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof HelmxError, `expected HelmxError, got ${String(caught)}`)
  assert.equal(caught.code, 'validation_error')
  assert.equal(caught.status, 400)
  for (const secret of leakedSecrets) {
    assert.ok(!caught.message.includes(secret), `error message leaked secret "${secret}": ${caught.message}`)
  }
}

test('encodeSessionDocSubParam and parseSessionDocSubParam round-trip valid subscriptions', { timeout: 60_000 }, () => {
  const cases: SessionDocSubscription[] = [
    { pluginId: 'builtin:token-speed', name: 'speed', conversationId: 42 },
    { pluginId: 'acme.plugin_v1-alpha', name: 'doc.state_1-a', conversationId: 1 },
    { pluginId: 'a', name: 'b', conversationId: 1 },
    { pluginId: 'p', name: 'n', conversationId: Number.MAX_SAFE_INTEGER },
    {
      pluginId: 'p'.repeat(128),
      name: 'n'.repeat(128),
      conversationId: Number.MAX_SAFE_INTEGER,
    },
  ]

  for (const sub of cases) {
    const encoded = encodeSessionDocSubParam(sub)
    assert.equal(encoded, `${sub.pluginId}/${sub.name}/${String(sub.conversationId)}`)

    const parsed = parseSessionDocSubParam(encoded)
    assert.deepEqual(parsed, sub)

    // Verify URLSearchParams transport round-trip remains strictly consistent.
    const params = new URLSearchParams([['sub', encoded]])
    const fromQuery = params.get('sub')
    assert.ok(fromQuery !== null)
    assert.deepEqual(parseSessionDocSubParam(fromQuery), sub)
  }
})

test('encodeSessionDocSubParam ignores extra fields and never leaks stray properties', { timeout: 60_000 }, () => {
  const secret = 'tok_super_secret_98765'
  const input = {
    pluginId: 'builtin:workflow',
    name: 'runs',
    conversationId: 7,
    token: secret,
  } as unknown as SessionDocSubscription

  const encoded = encodeSessionDocSubParam(input)
  assert.equal(encoded, 'builtin:workflow/runs/7')
  assert.ok(!encoded.includes(secret))
})

test('parseSessionDocSubParam rejects invalid inputs with HelmxError(400) and no token echo', { timeout: 60_000 }, () => {
  const secret = 'secret_bearer_token_xyz'
  const badRawStrings = [
    '',
    '   ',
    'p/n',
    'p/n/1/extra',
    '/p/n/1',
    'p/n/1/',
    '.p/n/1',
    'p/.n/1',
    '-p/n/1',
    'p/-n/1',
    '../n/1',
    'p..q/n/1',
    'p/n..m/1',
    'builtin:p/name:colon/1',
    'p%20/n/1',
    `p/n/1?token=${secret}`,
    `p/n/1&token=${secret}`,
    `p/n/1#${secret}`,
    `p/n/1\n${secret}`,
    `bad/${secret}?/1`,
    'p/n/0',
    'p/n/01',
    'p/n/-1',
    'p/n/1.5',
    'p/n/+1',
    'p/n/1e2',
    'p/n/9007199254740992',
    'p/n/99999999999999999',
    'p/n/abc',
    `${'a'.repeat(129)}/b/1`,
    `a/${'b'.repeat(129)}/1`,
    `${'a'.repeat(128)}/${'b'.repeat(128)}/10000000000000000`,
  ]

  for (const raw of badRawStrings) {
    assertValidationError(() => parseSessionDocSubParam(raw), [secret])
  }

  for (const nonString of [null, undefined, 123, {}, []]) {
    assertValidationError(() => parseSessionDocSubParam(nonString as unknown as string))
  }
})

test('encodeSessionDocSubParam rejects invalid subscription payloads without echoing tokens', { timeout: 60_000 }, () => {
  const secret = 'secret_payload_token_456'

  for (const nonObject of [null, undefined, 'p/n/1', 42, []]) {
    assertValidationError(() => encodeSessionDocSubParam(nonObject as unknown as SessionDocSubscription))
  }

  const invalidPayloads: unknown[] = [
    { pluginId: '', name: 'n', conversationId: 1 },
    { pluginId: `.${secret}`, name: 'n', conversationId: 1 },
    { pluginId: `a..${secret}`, name: 'n', conversationId: 1 },
    { pluginId: 'a/b', name: 'n', conversationId: 1 },
    { pluginId: 'a'.repeat(129), name: 'n', conversationId: 1 },
    { pluginId: 'p', name: '', conversationId: 1 },
    { pluginId: 'p', name: 'bad:colon', conversationId: 1 },
    { pluginId: 'p', name: `n?token=${secret}`, conversationId: 1 },
    { pluginId: 'p', name: 'n..m', conversationId: 1 },
    { pluginId: 'p', name: 'b'.repeat(129), conversationId: 1 },
    { pluginId: 'p', name: 'n', conversationId: 0 },
    { pluginId: 'p', name: 'n', conversationId: -1 },
    { pluginId: 'p', name: 'n', conversationId: 1.5 },
    { pluginId: 'p', name: 'n', conversationId: Number.NaN },
    { pluginId: 'p', name: 'n', conversationId: Number.POSITIVE_INFINITY },
    { pluginId: 'p', name: 'n', conversationId: Number.MAX_SAFE_INTEGER + 1 },
    { pluginId: 'p', name: 'n', conversationId: '1' },
  ]

  for (const payload of invalidPayloads) {
    assertValidationError(() => encodeSessionDocSubParam(payload as SessionDocSubscription), [secret])
  }
})

test('Stage 0 protocol contracts lock transient live, clientHashes, lastEntryId, and multiplex frames', { timeout: 60_000 }, () => {
  // Compile-time guard: 'conversation.live' must stay excluded from durable HelmxEventType / HelmxEvent.
  type LiveExcludedFromEventType = Extract<HelmxEventType, 'conversation.live'> extends never ? true : false
  type LiveExcludedFromHelmxEvent = Extract<HelmxEvent, { type: 'conversation.live' }> extends never ? true : false
  const liveExcludedType: LiveExcludedFromEventType = true
  const liveExcludedEvent: LiveExcludedFromHelmxEvent = true
  assert.equal(liveExcludedType, true)
  assert.equal(liveExcludedEvent, true)

  const pluginSummary: PluginSummary = {
    id: 'builtin:workflow',
    name: 'Workflow',
    locked: false,
    enabled: true,
    hooks: [],
    actions: [],
    tools: [],
    clientHashes: {
      'index.tsx': 'sha256-abc',
      'client.tsx': 'sha256-def',
    },
  }
  assert.equal(pluginSummary.clientHashes?.['index.tsx'], 'sha256-abc')

  const convSummary: ConversationSummary = {
    id: 1,
    title: 'Test',
    profileId: 'default',
    tags: [],
    cwd: '/tmp/work',
    model: 'openai/gpt-5',
    thinkingLevel: 'medium',
    status: 'idle',
    stateChangeSeq: 3,
    completionSeq: 1,
    lastEntryId: 12,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    runDurationMs: 4500,
    runStartedAt: 1500,
    pendingAskSince: 1600,
    createdAt: 1000,
    updatedAt: 2000,
  }
  const convDetail: ConversationDetail = {
    ...convSummary,
    entries: [],
  }
  assert.equal(convSummary.lastEntryId, 12)
  assert.equal(convDetail.lastEntryId, 12)
  assert.equal(convSummary.runDurationMs, 4500)
  assert.equal(convSummary.runStartedAt, 1500)
  assert.equal(convSummary.pendingAskSince, 1600)

  const live: ConversationLive = {
    conversationId: 1,
    text: 'streaming...',
    tools: [],
    updatedAt: 2500,
  }
  const transientFrame: HelmxTransientLiveFrame = { live }
  const resumedFrame: HelmxResumedFrame = {
    bootId: 'boot-1',
    seq: 10,
    headSeq: 12,
    conversationLives: [live],
    serverTime: 2600,
  }
  assert.equal(transientFrame.live.conversationId, 1)
  assert.equal(resumedFrame.conversationLives?.[0]?.text, 'streaming...')
  assert.equal(resumedFrame.serverTime, 2600)

  const actions: SessionDocMultiplexAction[] = ['snapshot', 'updated', 'deleted']
  const frames: SessionDocMultiplexFrame[] = actions.map((action, idx) => {
    const doc: PublicPluginSessionDoc = {
      pluginId: 'builtin:token-speed',
      name: 'speed',
      conversationId: 1,
      value: action === 'deleted' ? null : { tps: 42 },
      ...(action === 'deleted' ? { deleted: true } : {}),
    }
    return {
      action,
      pluginId: 'builtin:token-speed',
      name: 'speed',
      conversationId: 1,
      seq: idx + 1,
      doc,
    }
  })
  assert.deepEqual(
    frames.map((frame) => frame.action),
    ['snapshot', 'updated', 'deleted'],
  )
  assert.equal(frames[2]?.doc.deleted, true)
})

test('HostEventMap, typed onEvent/emitEvent overloads, and plugin/client contract additions typecheck cleanly', { timeout: 60_000 }, () => {
  // Compile-time lock: HostEventMap covers every durable HelmxEventType plus transient conversation.live,
  // and is exported identically from both root and @helmx/protocol/browser.
  type AllCoreMapped = Exclude<HelmxEventType, keyof HostEventMap> extends never ? true : false
  type LiveMapped = HostEventMap['conversation.live'] extends ConversationLiveEvent ? true : false
  type BrowserMapMatches = BrowserHostEventMap extends HostEventMap ? (HostEventMap extends BrowserHostEventMap ? true : false) : false
  type NodesSliceMatches = BrowserHostNodesSlice extends ReadonlyArray<NodeInfo> ? (HostNodesSlice extends BrowserHostNodesSlice ? true : false) : false
  type ProfilesSliceMatches = BrowserHostProfilesSlice extends ReadonlyArray<Profile> ? (HostProfilesSlice extends BrowserHostProfilesSlice ? true : false) : false
  const locks: [AllCoreMapped, LiveMapped, BrowserMapMatches, NodesSliceMatches, ProfilesSliceMatches] = [
    true,
    true,
    true,
    true,
    true,
  ]
  assert.deepEqual(locks, [true, true, true, true, true])

  // Verify both method-shorthand and explicitly annotated implementations satisfy Pick<HelmxHostApi, 'onEvent' | 'emitEvent'>.
  const dispatched: Array<{ type: string; payload: unknown }> = []
  const listeners = new Map<string, Set<(payload: unknown) => MaybePromise<void>>>()
  const hostEvents: Pick<HelmxHostApi, 'onEvent' | 'emitEvent'> = {
    onEvent(type: string, listener: (payload: unknown) => MaybePromise<void>): () => void {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(listener)
      return () => {
        set!.delete(listener)
      }
    },
    emitEvent(type: string, payload: unknown, _options?: { broadcast?: boolean }): MaybePromise<void> {
      dispatched.push({ type, payload })
      const set = listeners.get(type)
      if (!set) return
      for (const fn of set) void fn(payload)
    },
  }

  let deletedId: number | undefined
  let liveConvId: number | undefined
  let customPayload: unknown
  const unsubDeleted = hostEvents.onEvent('conversation.deleted', (ev) => {
    deletedId = ev.conversationId
  })
  const unsubLive = hostEvents.onEvent('conversation.live', (ev) => {
    liveConvId = ev.live.conversationId
  })
  const unsubCustom = hostEvents.onEvent('acme:custom', (ev) => {
    customPayload = ev
  })

  // Typed emitEvent accepts both full envelopes and raw bodies without `type`, plus arbitrary custom events.
  const rawNotif: HostEventEmitPayload<'notification'> = { level: 'info', title: 'raw' }
  const fullNotif: HostEventEmitPayload<'notification'> = { type: 'notification', level: 'warning', title: 'full' }
  void hostEvents.emitEvent('notification', rawNotif)
  void hostEvents.emitEvent('notification', fullNotif)
  void hostEvents.emitEvent('conversation.deleted', { type: 'conversation.deleted', conversationId: 42 })
  void hostEvents.emitEvent('conversation.live', {
    type: 'conversation.live',
    live: { conversationId: 9, text: 'hi', tools: [], updatedAt: 1000 },
  })
  void hostEvents.emitEvent('acme:custom', { ok: true }, { broadcast: false })

  assert.equal(deletedId, 42)
  assert.equal(liveConvId, 9)
  assert.deepEqual(customPayload, { ok: true })
  assert.equal(dispatched.length, 5)
  unsubDeleted()
  unsubLive()
  unsubCustom()

  // Lock folded PluginServiceSpec fields, PluginDocOptions, HelmxHostNodeIpcPort.listNodes,
  // HelmxPluginContext.onCapabilityChanged, and PluginClientContext.fetchRoute signatures.
  const serviceSpec: PluginServiceSpec = {
    id: 'svc',
    reconcileAfter: ['builtin:workflow'],
    start() {},
    reconcile() {},
    stop() {},
  }
  const docOpts: PluginDocOptions = { public: true, durable: false }
  const nodeIpc: HelmxHostNodeIpcPort = {
    isOnline: () => true,
    listNodes: () => [{ id: 'local', kind: 'local', online: true }],
  }
  type CapChangedSig = HelmxPluginContext['onCapabilityChanged'] extends (
    capabilityId: string,
    listener: () => void,
  ) => () => void
    ? true
    : false
  type FetchRouteSig = PluginClientContext['fetchRoute'] extends (
    path: string,
    init?: RequestInit,
  ) => Promise<Response>
    ? true
    : false
  const contractLocks: [CapChangedSig, FetchRouteSig] = [true, true]
  assert.deepEqual(contractLocks, [true, true])
  assert.equal(serviceSpec.reconcileAfter?.[0], 'builtin:workflow')
  assert.equal(docOpts.durable, false)
  assert.equal(nodeIpc.listNodes?.()[0]?.id, 'local')
})

test('live-delta: diffTextPrefix / applyTextPrefix handle append, cross-chunk redaction rewind, retry reset, and bounds rejection', { timeout: 60_000 }, () => {
  // Pure append fast path
  const appendPatch = diffTextPrefix('hello', 'hello world')
  assert.deepEqual(appendPatch, [5, ' world'])
  assert.equal(applyTextPrefix('hello', appendPatch, 'text'), 'hello world')

  // Cross-chunk redaction step-back: secret suffix replaced with [REDACTED]
  const redactedPatch = diffTextPrefix('token=sk-12', 'token=[REDACTED] done')
  assert.deepEqual(redactedPatch, [6, '[REDACTED] done'])
  assert.equal(applyTextPrefix('token=sk-12', redactedPatch, 'text'), 'token=[REDACTED] done')

  // Full reset (retry)
  const resetPatch = diffTextPrefix('old attempt', 'fresh attempt')
  assert.deepEqual(resetPatch, [0, 'fresh attempt'])
  assert.equal(applyTextPrefix('old attempt', resetPatch, 'text'), 'fresh attempt')

  // Strict bounds and format rejection
  assert.throws(() => applyTextPrefix('abc', [4, 'x'], 'text'), /bounds/)
  assert.throws(() => applyTextPrefix('abc', [-1, 'x'], 'text'), /bounds/)
  assert.throws(() => applyTextPrefix('abc', [1.5, 'x'], 'text'), /bounds/)
  assert.throws(() => applyTextPrefix('abc', [1, 42], 'text'), /bounds/)
  assert.throws(() => applyTextPrefix('abc', 'bad', 'text'), /format/)
})

test('live-delta: diffConversationLive / applyConversationLiveDelta round-trip multi-block generation and reject mismatches', { timeout: 60_000 }, () => {
  const base: ConversationLive = {
    conversationId: 42,
    text: 'Hello',
    thinking: 'Plan step 1',
    tools: [{ callId: 't1', toolName: 'read', status: 'running' }],
    queuedInputs: [{ id: 'q1', submissionId: '1', text: 'next', mode: 'followUp', origin: 'human', createdAt: 100 }],
    generation: {
      taskId: 10,
      attempt: 1,
      message: {
        content: [
          { type: 'thinking', thinking: 'Plan step 1' },
          { type: 'text', text: 'Hello' },
        ],
        usage: { output: 20 },
      },
    },
    updatedAt: 1000,
    rev: 1,
  }
  const next: ConversationLive = {
    conversationId: 42,
    text: 'Hello world',
    thinking: 'Plan step 1\nstep 2',
    tools: [{ callId: 't1', toolName: 'read', status: 'running' }],
    queuedInputs: [{ id: 'q1', submissionId: '1', text: 'next', mode: 'followUp', origin: 'human', createdAt: 100 }],
    generation: {
      taskId: 10,
      attempt: 1,
      message: {
        content: [
          { type: 'thinking', thinking: 'Plan step 1\nstep 2' },
          { type: 'text', text: 'Hello world' },
          { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } },
        ],
        usage: { output: 35 },
      },
    },
    updatedAt: 1100,
    rev: 2,
  }

  assert.equal(sameConversationLiveContent(base, { ...base, updatedAt: 9999, rev: 99 }), true)
  assert.equal(sameConversationLiveContent(base, next), false)
  assert.equal(sameQueuedInputs(undefined, []), true)
  assert.equal(sameQueuedInputs(base.queuedInputs, next.queuedInputs), true)

  const delta: ConversationLiveDelta = diffConversationLive(base, next, 1, 2)
  const frame: HelmxTransientLiveDeltaFrame = { delta }
  assert.equal(frame.delta.tools, undefined, 'unchanged tools omitted from delta')
  assert.equal(frame.delta.queuedInputs, undefined, 'unchanged queuedInputs omitted from delta')
  assert.deepEqual(frame.delta.text, [5, ' world'])
  assert.deepEqual(frame.delta.thinking, [11, '\nstep 2'])
  assert.equal(frame.delta.generation?.mode, 'patch')

  const reconstructed = applyConversationLiveDelta(base, delta)
  assert.deepEqual(reconstructed, next)

  // Clearing optional fields (thinking, queuedInputs, generation)
  const cleared: ConversationLive = {
    conversationId: 42,
    text: '',
    tools: [],
    updatedAt: 1200,
    rev: 3,
  }
  const clearDelta = diffConversationLive(next, cleared, 2, 3)
  assert.equal(clearDelta.thinking, null)
  assert.equal(clearDelta.queuedInputs, null)
  assert.equal(clearDelta.generation, null)
  assert.deepEqual(applyConversationLiveDelta(next, clearDelta), cleared)

  // Strict rejection on missing prev, baseRev mismatch, or non-monotonic rev
  assert.throws(() => applyConversationLiveDelta(undefined, delta), /mismatch/)
  assert.throws(() => applyConversationLiveDelta({ ...base, rev: 9 }, delta), /mismatch/)
  assert.throws(() => applyConversationLiveDelta(base, { ...delta, rev: 1 }), /metadata/)
})
