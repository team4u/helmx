/**
 * Client-side regressions for SSE short-disconnect resume (?afterSeq+?bootId /
 * the resumed control frame).
 *
 * Coverage:
 * - Reconnection carries both credentials; after the resumed handshake, replay
 *   frames apply one by one and only actually reaching headSeq announces live
 *   (never "fresh" mid-replay); details/artifacts caches are NOT cleared during
 *   resume (no conversation-detail GETs);
 * - Handshake mismatch (server resumed.bootId differs from local): credentials
 *   invalidated; the next connection goes full (no query params);
 * - Snapshot apply failure: credentials invalidated; the next connection goes
 *   full (never repeatedly carrying a corrupt watermark);
 * - Logout/re-auth clears resume credentials: a new identity on the same Hub
 *   must never reuse the old authorization's client watermark;
 * - plugin.changed (enabled=true hot reload) invalidates the client module
 *   cache on both the live and the resume-replay paths (no stale UI code).
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { describe, after, before, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { isConfigOnlyPluginChange, sseClientTimings } from '../src/lib/live-state.js'
import {
  getCachedClientComponent,
  getPluginClientCacheRevision,
  loadPluginClientModule,
  PluginClientError,
  resetPluginClientCache,
  seedPluginClientModule,
} from '../src/lib/plugin-client.js'
import {
  getSessionDocState,
  resetSessionDocSubscriptions,
  subscribeSessionDoc,
} from '../src/lib/session-docs.js'
import type { HelmxStoreValue } from '../src/lib/types.js'

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const originalSseTimings = { ...sseClientTimings }
describe("sse-resume", () => {


  before(() => {
    Object.assign(sseClientTimings, {
      idleTimeoutMs: 150,
      reconnectBaseMs: 8,
      reconnectCapMs: 30,
      reconnectJitterMs: 0,
    })
  })

  after(() => {
    Object.assign(sseClientTimings, originalSseTimings)
  })

  // ---------------------------------------------------------------------------
  // Stubs: controlled SSE streams + fetch routing
  // ---------------------------------------------------------------------------

  const encoder = new TextEncoder()

  /** Controlled stream: tests send/end imperatively; abort (or consumer cancel) closes immediately and unbinds. */
  function controlledStream(signal?: AbortSignal | null): {
    stream: ReadableStream<Uint8Array>
    send: (text: string) => void
    end: () => void
  } {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let ended = false
    const finish = (): void => {
      if (ended) return
      ended = true
      signal?.removeEventListener('abort', finish)
      try {
        controller?.close()
      } catch {
        /* already closed/cancelled: idempotent */
      }
    }
    signal?.addEventListener('abort', finish, { once: true })
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
        if (signal?.aborted) finish()
      },
      cancel() {
        finish()
      },
    })
    return {
      stream,
      send: (text: string) => {
        if (!ended) controller?.enqueue(encoder.encode(text))
      },
      end: finish,
    }
  }

  const conv = (id: number, title: string) => ({
    id,
    title,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'm',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
  })

  const snapshotFrame = (payload: object): string => `event: snapshot\ndata: ${JSON.stringify(payload)}\n\n`
  const resumedFrame = (payload: object): string => `event: resumed\ndata: ${JSON.stringify(payload)}\n\n`
  const eventFrame = (seq: number, event: object): string =>
    `event: ${String((event as { type: string }).type)}\ndata: ${JSON.stringify({ seq, event })}\n\n`

  const pluginSummary = (id: string) => ({
    id,
    name: id,
    locked: false,
    enabled: true,
    hooks: [],
    actions: [],
    tools: [],
  })

  interface ControlledStream {
    stream: ReadableStream<Uint8Array>
    send: (text: string) => void
    end: () => void
  }

  type StreamFactory = (url: string, signal: AbortSignal | null) => ControlledStream

  interface Observed {
    authenticated: boolean
    sseConnected: boolean
    connectionError: string | null
    conversations: number
  }

  interface Harness {
    observed: Observed
    host: HTMLElement
    eventsUrls: string[]
    fetchedUrls: string[]
    /** Register the SSE stream factory for the next /api/events connection (if the connection arrives first it waits for the registration; deterministic consumption). */
    nextEvents: (factory: StreamFactory) => void
    store: () => HelmxStoreValue
    waitFor: (predicate: (observed: Observed) => boolean, ms?: number) => Promise<void>
    close: () => Promise<void>
  }

  async function mountProvider(options?: {
    hash?: string
    children?: React.ReactNode
    onFetch?: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined
  }): Promise<Harness> {
    window.history.replaceState(null, '', options?.hash ?? '#/')
    const { HelmxStoreProvider } = await import('../src/lib/HelmxStoreProvider.js')
    const { useHelmxStore } = await import('../src/lib/store-context.js')
    const observed: Observed = { authenticated: false, sseConnected: false, connectionError: null, conversations: 0 }
    const eventsUrls: string[] = []
    const fetchedUrls: string[] = []
    // If the connection request arrives before the factory is registered, it waits (the connection starts during mount; registration order is decoupled from arrival order).
    const factories: StreamFactory[] = []
    const waiting: Array<{ url: string; signal: AbortSignal | null; resolve: (r: ControlledStream) => void }> = []
    const takeStream = (url: string, signal: AbortSignal | null): Promise<ControlledStream> => {
      const factory = factories.shift()
      if (factory !== undefined) return Promise.resolve(factory(url, signal))
      return new Promise((resolve) => {
        waiting.push({ url, signal, resolve })
      })
    }
    const nextEvents = (factory: StreamFactory): void => {
      const pending = waiting.shift()
      if (pending !== undefined) {
        pending.resolve(factory(pending.url, pending.signal))
        return
      }
      factories.push(factory)
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      fetchedUrls.push(path)
      if (path === '/api/auth/status') {
        return new Response(JSON.stringify({ configured: true, authenticated: true }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (path === '/api/events' || path.startsWith('/api/events?')) {
        eventsUrls.push(path)
        const { stream } = await takeStream(path, init?.signal ?? null)
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      if (options?.onFetch !== undefined) {
        const custom = await options.onFetch(path, init)
        if (custom !== undefined) return custom
      }
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    let storeRef: HelmxStoreValue | undefined
    const Probe = (): React.ReactNode => {
      const store = useHelmxStore()
      storeRef = store
      observed.authenticated = store.authenticated
      observed.sseConnected = store.sseConnected
      observed.connectionError = store.connectionError
      observed.conversations = store.conversations.length
      return null
    }

    const host = document.createElement('div')
    document.body.appendChild(host)
    let root: Root | undefined
    await act(async () => {
      const r = createRoot(host)
      root = r
      r.render(
        React.createElement(
          HelmxStoreProvider,
          null,
          React.createElement(Probe),
          options?.children ?? null,
        ),
      )
    })
    const waitFor = async (predicate: (observed: Observed) => boolean, ms = 15_000): Promise<void> => {
      const deadline = Date.now() + ms
      while (!predicate(observed)) {
        if (Date.now() > deadline) throw new Error(`waitFor timeout: ${JSON.stringify(observed)} urls=${JSON.stringify(eventsUrls)}`)
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 4))
        })
      }
    }
    return {
      observed,
      host,
      eventsUrls,
      fetchedUrls,
      nextEvents,
      store: () => {
        assert.ok(storeRef !== undefined, 'the Probe has not rendered yet')
        return storeRef
      },
      waitFor,
      close: async () => {
        const r = root
        if (r !== undefined) await act(async () => { r.unmount() })
        host.remove()
        globalThis.fetch = originalFetch
        localStorage.removeItem('helmx:token')
        window.history.replaceState(null, '', '#/')
        resetPluginClientCache()
      },
    }
  }

  /** Register a connection factory that emits the snapshot immediately on establishment. */
  function snapshotConnection(h: Harness, payload: object): { send: (text: string) => void; end: () => void } {
    let handle: ControlledStream | undefined
    h.nextEvents((_url, signal) => {
      const c = controlledStream(signal)
      handle = c
      c.send(snapshotFrame(payload))
      return c
    })
    const demand = (): ControlledStream => {
      assert.ok(handle !== undefined, 'the snapshot connection has not been established')
      return handle
    }
    return { send: (t) => demand().send(t), end: () => demand().end() }
  }

  // ---------------------------------------------------------------------------
  // Cases
  // ---------------------------------------------------------------------------

  test('disconnect resume: dual-credential handshake, replay applied frame by frame, live only after reaching headSeq, no detail GETs', { timeout: 60_000 }, async () => {
    localStorage.setItem('helmx:token', 't1')
    const h = await mountProvider()
    try {
      // First connection: snapshot (bootId b1, seq 3), then held.
      const first = snapshotConnection(h, { bootId: 'b1', seq: 3, conversations: [], pendingAsks: [], plugins: [], ui: [] })
      await h.waitFor((o) => o.sseConnected === true)
      assert.equal(h.eventsUrls[0], '/api/events')

      // Disconnect: the server closes the stream -> the client reconnects with backoff (carrying both credentials).
      let secondUrl = ''
      let second: ControlledStream | undefined
      h.nextEvents((url, signal) => {
        secondUrl = url
        const c = controlledStream(signal)
        second = c
        return c
      })
      first.end()
      await h.waitFor((o) => o.sseConnected === false)
      await h.waitFor(() => h.eventsUrls.length >= 2 && second !== undefined)
      assert.ok(second !== undefined)
      assert.equal(secondUrl, '/api/events?afterSeq=3&bootId=b1', 'the reconnect must carry both afterSeq+bootId credentials')

      // resumed handshake: headSeq=8; replay 3 frames first, then pause — no live claim mid-replay.
      second.send(resumedFrame({ bootId: 'b1', seq: 3, headSeq: 8 }))
      second.send(eventFrame(4, { type: 'conversation.upsert', conversation: conv(4, '补发四') }))
      second.send(eventFrame(5, { type: 'conversation.upsert', conversation: conv(5, '补发五') }))
      second.send(eventFrame(6, { type: 'conversation.upsert', conversation: conv(6, '补发六') }))
      await h.waitFor((o) => o.conversations === 3)
      assert.equal(h.observed.sseConnected, false, 'no live claim before the replay reaches headSeq')

      // Caught up: after frames 7 and 8 apply, it turns live.
      second.send(eventFrame(7, { type: 'conversation.upsert', conversation: conv(7, '补发七') }))
      second.send(eventFrame(8, { type: 'conversation.upsert', conversation: conv(8, '补发八') }))
      await h.waitFor((o) => o.sseConnected === true)
      assert.equal(h.observed.conversations, 5)

      // Live deltas arrive as usual (seq 9).
      second.send(eventFrame(9, { type: 'conversation.upsert', conversation: conv(9, '实时九') }))
      await h.waitFor((o) => o.conversations === 6)

      // Resume must trigger no conversation-detail/artifact GETs at all (the snapshot invalidated no cache).
      assert.ok(!h.fetchedUrls.some((url) => url.includes('/api/conversations/')), `resume must not refetch details, actual GETs: ${JSON.stringify(h.fetchedUrls)}`)
      second.end()
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    } finally {
      await h.close()
    }
  })

  test('handshake mismatch: the server resumed frame differs from local credentials; credentials invalidated, next connection forced full', { timeout: 60_000 }, async () => {
    localStorage.setItem('helmx:token', 't1')
    const h = await mountProvider()
    try {
      const first = snapshotConnection(h, { bootId: 'b1', seq: 2, conversations: [], pendingAsks: [], plugins: [], ui: [] })
      await h.waitFor((o) => o.sseConnected === true)

      let secondUrl = ''
      let second: ControlledStream | undefined
      h.nextEvents((url, signal) => {
        secondUrl = url
        const c = controlledStream(signal)
        second = c
        return c
      })
      let thirdUrl = ''
      let third: ControlledStream | undefined
      h.nextEvents((url, signal) => {
        thirdUrl = url
        const c = controlledStream(signal)
        third = c
        return c
      })
      first.end()
      await h.waitFor(() => h.eventsUrls.length >= 2 && second !== undefined)
      assert.ok(second !== undefined)
      assert.equal(secondUrl, '/api/events?afterSeq=2&bootId=b1')
      // Faulty server: resumed carries a different bootId (and headSeq regressed) — must be judged a handshake failure.
      second.send(resumedFrame({ bootId: 'b2', seq: 2, headSeq: 1 }))
      await h.waitFor(() => h.eventsUrls.length >= 3 && third !== undefined)
      assert.ok(third !== undefined)
      assert.equal(thirdUrl, '/api/events', 'credentials invalidated after the handshake failure: the third connection must go full with no query params')
      third.send(snapshotFrame({ bootId: 'b2', seq: 5, conversations: [conv(1, '全量')], pendingAsks: [], plugins: [], ui: [] }))
      await h.waitFor((o) => o.sseConnected === true && o.conversations === 1)
    } finally {
      await h.close()
    }
  })

  test('snapshot apply failure: credentials invalidated, next connection forced full (never repeatedly carrying a corrupt watermark)', { timeout: 60_000 }, async () => {
    localStorage.setItem('helmx:token', 't1')
    const h = await mountProvider()
    try {
      // Illegal snapshot (conversations not an array): applySnapshot must throw and the credentials must not land.
      const first = snapshotConnection(h, { bootId: 'b1', seq: 4, conversations: 'corrupted', pendingAsks: [], plugins: [], ui: [] })
      let secondUrl = ''
      let second: ControlledStream | undefined
      h.nextEvents((url, signal) => {
        secondUrl = url
        const c = controlledStream(signal)
        second = c
        return c
      })
      await h.waitFor(() => h.eventsUrls.length >= 2 && second !== undefined)
      assert.ok(second !== undefined)
      assert.equal(secondUrl, '/api/events', 'no resume credentials carried after the snapshot failure')
      second.send(snapshotFrame({ bootId: 'b1', seq: 4, conversations: [conv(2, '恢复')], pendingAsks: [], plugins: [], ui: [] }))
      await h.waitFor((o) => o.sseConnected === true && o.conversations === 1)
    } finally {
      await h.close()
    }
  })

  test('logout/re-auth clears resume credentials: a new identity must not reuse the old authorization watermark', { timeout: 60_000 }, async () => {
    localStorage.setItem('helmx:token', 't1')
    const h = await mountProvider()
    try {
      const first = snapshotConnection(h, { bootId: 'b1', seq: 1, conversations: [], pendingAsks: [], plugins: [], ui: [] })
      await h.waitFor((o) => o.sseConnected === true)
      // Advance the watermark to 2 (credentials advance as frames actually apply).
      first.send(eventFrame(2, { type: 'notification', level: 'info', title: '推进' }))
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })

      let secondUrl = ''
      let second: ControlledStream | undefined
      h.nextEvents((url, signal) => {
        secondUrl = url
        const c = controlledStream(signal)
        second = c
        return c
      })
      // Logout via the 401 path: credentials must be cleared together with logout.
      window.dispatchEvent(new Event('helmx:unauthorized'))
      await h.waitFor((o) => o.authenticated === false)
      // After re-auth (new identity), the new connection must not carry the old credentials.
      await act(async () => {
        h.store().onAuthenticated('t2')
      })
      await h.waitFor((o) => o.authenticated === true)
      await h.waitFor(() => h.eventsUrls.length >= 2 && second !== undefined)
      assert.ok(second !== undefined)
      assert.equal(secondUrl, '/api/events', 'after switching identity it must go full with no query params (old authorization watermark cleared)')
      second.send(snapshotFrame({ bootId: 'b1', seq: 2, conversations: [], pendingAsks: [], plugins: [], ui: [] }))
      await h.waitFor((o) => o.sseConnected === true)
    } finally {
      await h.close()
    }
  })

  test('plugin.changed enabled-state hot reload invalidates the client module cache (both the live and resume-replay paths)', { timeout: 60_000 }, async () => {
    localStorage.setItem('helmx:token', 't1')
    const h = await mountProvider()
    try {
      const first = snapshotConnection(h, {
        bootId: 'b1',
        seq: 1,
        conversations: [],
        pendingAsks: [],
        plugins: [pluginSummary('test:p')],
        ui: [],
      })
      await h.waitFor((o) => o.sseConnected === true)
      const revision0 = getPluginClientCacheRevision('test:p')

      // Live path: an enabled=true plugin.changed (hot reload/upgrade) must also invalidate the cache.
      first.send(eventFrame(2, { type: 'plugin.changed', plugin: pluginSummary('test:p'), ui: [] }))
      await h.waitFor(() => getPluginClientCacheRevision('test:p') !== revision0)
      const revision1 = getPluginClientCacheRevision('test:p')
      assert.notEqual(revision1, revision0)

      // Resume-replay path: a hot-reload event from during the disconnect, replayed via resumed, invalidates the cache just the same.
      let secondUrl = ''
      let second: ControlledStream | undefined
      h.nextEvents((url, signal) => {
        secondUrl = url
        const c = controlledStream(signal)
        second = c
        return c
      })
      first.end()
      await h.waitFor(() => h.eventsUrls.length >= 2 && second !== undefined)
      assert.ok(second !== undefined)
      assert.equal(secondUrl, '/api/events?afterSeq=2&bootId=b1')
      second.send(resumedFrame({ bootId: 'b1', seq: 2, headSeq: 3 }))
      second.send(eventFrame(3, { type: 'plugin.changed', plugin: pluginSummary('test:p'), ui: [] }))
      await h.waitFor(() => getPluginClientCacheRevision('test:p') !== revision1)
      await h.waitFor((o) => o.sseConnected === true, 3000)
      second.end()
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    } finally {
      await h.close()
    }
  })

  test('profile.changed triggers a profile catalog refresh: CLI-created roles appear in the sidebar/center without a manual reload', { timeout: 60_000 }, async () => {
    localStorage.setItem('helmx:token', 't1')
    // The catalog endpoint serves a growing list: initially only the default assistant, after the event also 'researcher'.
    const profileLists = [
      [{ id: 'assistant', name: 'person assist' }],
      [
        { id: 'assistant', name: 'person assist' },
        { id: 'researcher', name: 'Researcher', tags: ['team-a'] },
      ],
    ]
    let profileFetches = 0
    const h = await mountProvider({
      onFetch: (path) => {
        if (path === '/api/profiles') {
          const list = profileLists[Math.min(profileFetches, profileLists.length - 1)]
          profileFetches += 1
          return new Response(JSON.stringify(list), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return undefined
      },
    })
    try {
      const conn = snapshotConnection(h, { bootId: 'b1', seq: 1, conversations: [], pendingAsks: [], plugins: [], ui: [] })
      await h.waitFor((o) => o.sseConnected === true)
      // Boot-time asset load fetched the catalog exactly once.
      await h.waitFor(() => h.fetchedUrls.filter((url) => url === '/api/profiles').length >= 1)
      assert.ok(!h.store().profiles.some((p) => p.id === 'researcher'), 'the new role is absent before the event')

      // A CLI `helmx profiles create` lands as a durable profile.changed frame; the client re-reads the catalog.
      conn.send(eventFrame(2, { type: 'profile.changed', profile: { id: 'researcher', name: 'Researcher', tags: ['team-a'] } }))
      await h.waitFor(() => h.fetchedUrls.filter((url) => url === '/api/profiles').length >= 2)
      await h.waitFor(() => h.store().profiles.some((p) => p.id === 'researcher'))
      const fetched = h.store().profiles.find((p) => p.id === 'researcher')
      assert.equal(fetched?.name, 'Researcher')
      assert.deepEqual(fetched?.tags, ['team-a'])

      // Removal events refresh the same way (no stale sidebar entries after `helmx profiles delete`).
      profileLists.push([{ id: 'assistant', name: 'person assist' }])
      conn.send(eventFrame(3, { type: 'profile.changed', profile: { id: 'researcher', name: 'Researcher' }, removed: true }))
      await h.waitFor(() => !h.store().profiles.some((p) => p.id === 'researcher'))
      conn.end()
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    } finally {
      await h.close()
    }
  })

  // ---------------------------------------------------------------------------
  // Protocol-boundary failures: credentials always invalidated, forcing a full next connection (never relying on the server to never send bad data)
  // ---------------------------------------------------------------------------

  /** Assert the next connection is a credential-free full sync, then restore live with a healthy snapshot. */
  async function expectFullResyncAndRecover(h: Harness): Promise<void> {
    let url = ''
    let handle: ControlledStream | undefined
    h.nextEvents((u, signal) => {
      url = u
      const c = controlledStream(signal)
      handle = c
      return c
    })
    await h.waitFor(() => handle !== undefined)
    assert.ok(handle !== undefined)
    assert.equal(url, '/api/events', 'credentials invalidated after the protocol failure: must go full with no query params')
    handle.send(snapshotFrame({ bootId: 'b1', seq: 2, conversations: [conv(1, '恢复')], pendingAsks: [], plugins: [], ui: [] }))
    await h.waitFor((o) => o.sseConnected === true && o.conversations === 1)
  }

  interface ProtocolFailureScenario {
    name: string
    /** Drive until the protocol error occurs (a bad first frame, or a bad frame injected after live). */
    poison: (h: Harness) => Promise<void>
  }

  const goodSnapshot = { bootId: 'b1', seq: 2, conversations: [], pendingAsks: [], plugins: [], ui: [] }

  const scenarios: ProtocolFailureScenario[] = [
    {
      name: 'invalid JSON delta frame',
      async poison(h) {
        const first = snapshotConnection(h, goodSnapshot)
        await h.waitFor((o) => o.sseConnected === true)
        first.send('event: notification\ndata: {"seq":3,"broken\n\n')
      },
    },
    {
      name: 'null-payload snapshot first frame',
      async poison(h) {
        h.nextEvents((_url, signal) => {
          const c = controlledStream(signal)
          c.send('event: snapshot\ndata: null\n\n')
          return c
        })
        await h.waitFor(() => h.eventsUrls.length >= 2)
      },
    },
    {
      name: 'null-payload resumed control frame',
      async poison(h) {
        const first = snapshotConnection(h, goodSnapshot)
        await h.waitFor((o) => o.sseConnected === true)
        let secondUrl = ''
        let second: ControlledStream | undefined
        h.nextEvents((url, signal) => {
          secondUrl = url
          const c = controlledStream(signal)
          second = c
          return c
        })
        first.end()
        await h.waitFor(() => h.eventsUrls.length >= 2 && second !== undefined)
        assert.ok(second !== undefined)
        assert.equal(secondUrl, '/api/events?afterSeq=2&bootId=b1')
        second.send('event: resumed\ndata: null\n\n')
      },
    },
    {
      name: 'delta frame missing the event field',
      async poison(h) {
        const first = snapshotConnection(h, goodSnapshot)
        await h.waitFor((o) => o.sseConnected === true)
        first.send(`event: notification\ndata: ${JSON.stringify({ seq: 3 })}\n\n`)
      },
    },
    {
      name: 'frame sequence gap (missing frames must not be silently skipped)',
      async poison(h) {
        const first = snapshotConnection(h, goodSnapshot)
        await h.waitFor((o) => o.sseConnected === true)
        first.send(eventFrame(4, { type: 'notification', level: 'info', title: '跳过 3' }))
      },
    },
  ]

  for (const scenario of scenarios) {
    test(`protocol-boundary failure invalidates credentials for the next full sync: ${scenario.name}`, { timeout: 60_000 }, async () => {
      localStorage.setItem('helmx:token', 't1')
      const h = await mountProvider()
      try {
        await scenario.poison(h)
        await h.waitFor((o) => o.sseConnected === false)
        await expectFullResyncAndRecover(h)
      } finally {
        await h.close()
      }
    })
  }

  test('瞬态 conversation.live 不消耗 seq/afterSeq，resumed.conversationLives 对账实时视图', { timeout: 60_000 }, async () => {
    localStorage.setItem('helmx:token', 't1')
    const h = await mountProvider()
    try {
      const first = snapshotConnection(h, {
        bootId: 'b1',
        seq: 5,
        conversations: [{ ...conv(1, '流式会话'), status: 'working' }],
        pendingAsks: [],
        plugins: [],
        ui: [],
      })
      await h.waitFor((o) => o.sseConnected === true)

      // 发送瞬态 conversation.live（无 seq）：直接更新 conversationLives，不推进 seq
      first.send(`event: conversation.live\ndata: ${JSON.stringify({ live: { conversationId: 1, text: '瞬态流式', tools: [], updatedAt: 100 } })}\n\n`)
      await h.waitFor(() => h.store().conversationLives[1]?.text === '瞬态流式')
      // 紧接着 seq=6 持久帧无缝衔接（绝不报 sequence gap）
      first.send(eventFrame(6, { type: 'conversation.upsert', conversation: { ...conv(1, '流式会话'), status: 'working', stateChangeSeq: 2 } }))
      await h.waitFor(() => h.store().conversations[0]?.stateChangeSeq === 2)

      let secondUrl = ''
      let second: ControlledStream | undefined
      h.nextEvents((url, signal) => {
        secondUrl = url
        const c = controlledStream(signal)
        second = c
        return c
      })
      first.end()
      await h.waitFor(() => h.eventsUrls.length >= 2 && second !== undefined)
      assert.equal(secondUrl, '/api/events?afterSeq=6&bootId=b1', '瞬态 live 不消耗 durable seq 水位')

      // resumed 携带 conversationLives 对账断线期间更新的实时视图
      second!.send(resumedFrame({
        bootId: 'b1',
        seq: 6,
        headSeq: 6,
        conversationLives: [{ conversationId: 1, text: '断线重连后最新', tools: [], updatedAt: 200 }],
      }))
      await h.waitFor(() => h.store().sseConnected === true && h.store().conversationLives[1]?.text === '断线重连后最新')
      second!.end()
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    } finally {
      await h.close()
    }
  })

  test('snapshot 重连增量对账插件缓存与 loadErrors：保留未变更插件模块和样式，仅清变更/停用插件错误', { timeout: 60_000 }, async () => {
    localStorage.setItem('helmx:token', 't1')
    const KeepPanel = () => null
    const ChangePanel = () => null
    seedPluginClientModule('keep:p', 'index.tsx', { Panel: KeepPanel, __helmxClientCss: '.keep{}' }, 'hash-keep')
    seedPluginClientModule('chg:p', 'index.tsx', { Panel: ChangePanel, __helmxClientCss: '.old{}' }, 'hash-old')
    const keepRev0 = getPluginClientCacheRevision('keep:p')
    const chgRev0 = getPluginClientCacheRevision('chg:p')

    const h = await mountProvider({
      onFetch: (path) => {
        if (path.includes('/docs/info')) {
          return new Response(JSON.stringify({ error: { message: 'doc error' } }), { status: 404, headers: { 'content-type': 'application/json' } })
        }
        return undefined
      },
    })
    try {
      const first = snapshotConnection(h, {
        bootId: 'b1',
        seq: 1,
        conversations: [],
        pendingAsks: [],
        plugins: [
          { ...pluginSummary('keep:p'), status: 'active', clientHashes: { 'index.tsx': 'hash-keep' } },
          { ...pluginSummary('chg:p'), status: 'active', clientHashes: { 'index.tsx': 'hash-old' } },
        ],
        ui: [],
      })
      await h.waitFor((o) => o.sseConnected === true)
      // 触发两个插件的 doc loadErrors
      await act(async () => {
        await h.store().ensurePluginDoc('keep:p', 'info')
        await h.store().ensurePluginDoc('chg:p', 'info')
      })
      assert.ok(h.store().loadErrors['doc:keep:p/info'] !== undefined)
      assert.ok(h.store().loadErrors['doc:chg:p/info'] !== undefined)

      // 断线重连收到新 snapshot：keep:p hash 不变，chg:p hash 变更为 hash-new
      let second: ControlledStream | undefined
      h.nextEvents((_url, signal) => {
        const c = controlledStream(signal)
        second = c
        return c
      })
      // 作废游标以触发全量 snapshot
      first.send('event: notification\ndata: {"seq":99,"event":{"type":"notification","level":"info","title":"gap"}}\n\n')
      await h.waitFor(() => h.eventsUrls.length >= 2 && second !== undefined)
      second!.send(snapshotFrame({
        bootId: 'b2',
        seq: 1,
        conversations: [],
        pendingAsks: [],
        plugins: [
          { ...pluginSummary('keep:p'), status: 'active', clientHashes: { 'index.tsx': 'hash-keep' } },
          { ...pluginSummary('chg:p'), status: 'active', clientHashes: { 'index.tsx': 'hash-new' } },
        ],
        ui: [],
      }))
      await h.waitFor((o) => o.sseConnected === true && h.store().kernelBootId === 'b2')

      assert.equal(getCachedClientComponent('keep:p', 'index.tsx', 'Panel', 'hash-keep'), KeepPanel, '未变更插件缓存必须保留')
      assert.ok(document.querySelector('style[data-helmx-plugin-css="keep:p::index.tsx"]') !== null, '未变更插件样式必须保留')
      assert.equal(getPluginClientCacheRevision('keep:p'), keepRev0, '未变更插件 revision 不变')
      assert.ok(h.store().loadErrors['doc:keep:p/info'] !== undefined, '未变更插件的既有错误不得被清空')

      assert.equal(getCachedClientComponent('chg:p', 'index.tsx', 'Panel'), undefined, 'hash 变更插件缓存必须逐出')
      assert.ok(document.querySelector('style[data-helmx-plugin-css="chg:p::index.tsx"]') === null, 'hash 变更插件样式必须逐出')
      assert.notEqual(getPluginClientCacheRevision('chg:p'), chgRev0, 'hash 变更插件 revision 必须递增')
      assert.equal(h.store().loadErrors['doc:chg:p/info'], undefined, 'hash 变更插件的旧 doc 错误必须被清理')
      second!.end()
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    } finally {
      await h.close()
    }
  })

  test('snapshot 重连 SWR 保活：未变更可见会话跳过详情/产物 GET；变更会话后台静默刷新不清空时间线', { timeout: 60_000 }, async () => {
    localStorage.setItem('helmx:token', 't1')
    let detailCalls = 0
    let artifactCalls = 0
    let failNextDetail = false
    let serverLastEntryId = 10
    let serverStateChangeSeq = 2
    const makeDetail = () => ({
      ...conv(1, 'SWR 会话'),
      stateChangeSeq: serverStateChangeSeq,
      lastEntryId: serverLastEntryId,
      entries: [
        { id: '1', kind: 'helmx.input', data: { text: 'hello' } },
        ...(serverLastEntryId > 10 ? [{ id: String(serverLastEntryId), kind: 'pi.assistant' }] : []),
      ],
    })

    const h = await mountProvider({
      hash: '#/c/1',
      onFetch: (path) => {
        if (/^\/api\/conversations\/1(\?.*)?$/.test(path)) {
          detailCalls++
          if (failNextDetail) {
            return new Response(JSON.stringify({ error: { message: 'transient 500' } }), { status: 500, headers: { 'content-type': 'application/json' } })
          }
          return new Response(JSON.stringify(makeDetail()), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        if (path === '/api/conversations/1/artifacts') {
          artifactCalls++
          return new Response(JSON.stringify([{ id: 'art-1', conversationId: 1, name: 'a.txt', mimeType: 'text/plain', size: 1, createdAt: 1 }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return undefined
      },
    })

    try {
      const first = snapshotConnection(h, {
        bootId: 'b1',
        seq: 1,
        conversations: [{ ...conv(1, 'SWR 会话'), stateChangeSeq: 2, lastEntryId: 10 }],
        pendingAsks: [],
        plugins: [],
        ui: [],
      })
      await h.waitFor(() => h.store().sseConnected === true && h.store().conversationDetails[1]?.entries.length === 1 && (h.store().conversationArtifacts[1]?.length ?? 0) === 1)
      assert.equal(detailCalls, 1)
      assert.equal(artifactCalls, 1)

      // 场景 A：断线重连后 snapshot 中会话 1 状态未变（status!='working'，stateChangeSeq=2，lastEntryId=10）→ 跳过 GET
      let second: ControlledStream | undefined
      h.nextEvents((_url, signal) => {
        const c = controlledStream(signal)
        second = c
        return c
      })
      first.send('event: notification\ndata: {"seq":99,"event":{"type":"notification","level":"info","title":"gap"}}\n\n')
      await h.waitFor(() => h.eventsUrls.length >= 2 && second !== undefined)
      second!.send(snapshotFrame({
        bootId: 'b2',
        seq: 1,
        conversations: [{ ...conv(1, 'SWR 会话'), stateChangeSeq: 2, lastEntryId: 10 }],
        pendingAsks: [],
        plugins: [],
        ui: [],
      }))
      await h.waitFor(() => h.store().sseConnected === true && h.store().kernelBootId === 'b2')
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
      assert.equal(detailCalls, 1, '未变更可见会话重连 snapshot 必须跳过重复 detail GET')
      assert.equal(artifactCalls, 1, '未变更可见会话重连 snapshot 必须跳过重复 artifacts GET')
      assert.equal(h.store().conversationDetails[1]?.entries.length, 1)
      assert.equal(h.store().conversationArtifacts[1]?.length, 1)

      // 场景 B：lastEntryId 变更且后台静默刷新遇到 500 失败 → 仍保留原有时间线，绝不置错白屏
      serverStateChangeSeq = 3
      serverLastEntryId = 11
      failNextDetail = true
      let third: ControlledStream | undefined
      h.nextEvents((_url, signal) => {
        const c = controlledStream(signal)
        third = c
        return c
      })
      second!.send('event: notification\ndata: {"seq":99,"event":{"type":"notification","level":"info","title":"gap"}}\n\n')
      await h.waitFor(() => h.eventsUrls.length >= 3 && third !== undefined)
      third!.send(snapshotFrame({
        bootId: 'b3',
        seq: 1,
        conversations: [{ ...conv(1, 'SWR 会话'), stateChangeSeq: 3, lastEntryId: 11 }],
        pendingAsks: [],
        plugins: [],
        ui: [],
      }))
      await h.waitFor(() => h.store().sseConnected === true && h.store().kernelBootId === 'b3' && detailCalls === 2)
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
      assert.equal(h.store().conversationDetails[1]?.entries.length, 1, 'SWR 静默刷新失败不得清空原有时间线')
      assert.equal(h.store().loadErrors['conversation:1'], undefined, 'silent 后台刷新失败不得触发 error 遮罩')

      // 场景 C：再次 snapshot 且服务端恢复正常 → 静默补齐最新 entry
      failNextDetail = false
      let fourth: ControlledStream | undefined
      h.nextEvents((_url, signal) => {
        const c = controlledStream(signal)
        fourth = c
        return c
      })
      third!.send('event: notification\ndata: {"seq":99,"event":{"type":"notification","level":"info","title":"gap"}}\n\n')
      await h.waitFor(() => h.eventsUrls.length >= 4 && fourth !== undefined)
      fourth!.send(snapshotFrame({
        bootId: 'b4',
        seq: 1,
        conversations: [{ ...conv(1, 'SWR 会话'), stateChangeSeq: 3, lastEntryId: 11 }],
        pendingAsks: [],
        plugins: [],
        ui: [],
      }))
      await h.waitFor(() => h.store().conversationDetails[1]?.entries.length === 2)
      assert.equal(detailCalls, 3)
      assert.equal(h.store().conversationDetails[1]?.entries[1]?.id, '11')
      fourth!.end()
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    } finally {
      await h.close()
    }
  })

  test('isConfigOnlyPluginChange distinguishes publicConfig-only updates from status, hash, UI, and metadata changes', { timeout: 60_000 }, () => {
    const basePlugin = {
      ...pluginSummary('cfg:unit'),
      status: 'active' as const,
      clientHashes: { 'index.tsx': 'h1' },
      publicConfig: { slidingWindowMs: 1_500, nested: { a: 1, b: true } },
    }
    const baseUi = [
      {
        pluginId: 'cfg:unit',
        surface: 'plugin.slot' as const,
        spec: { id: 'badge', target: 'builtin:composer/status', client: { module: 'index.tsx', export: 'Badge' } },
      },
    ]

    // Newly seen plugin is never config-only
    assert.equal(isConfigOnlyPluginChange(undefined, [], basePlugin, baseUi), false)

    // Pure publicConfig update (changed value, added field, cleared config, undefined->'active' status)
    assert.equal(
      isConfigOnlyPluginChange(
        basePlugin,
        baseUi,
        { ...basePlugin, publicConfig: { slidingWindowMs: 2_500, nested: { a: 1, b: true } } },
        baseUi,
      ),
      true,
    )
    assert.equal(
      isConfigOnlyPluginChange(
        { ...pluginSummary('cfg:unit'), clientHashes: { 'index.tsx': 'h1' } },
        baseUi,
        { ...basePlugin, publicConfig: { slidingWindowMs: 1_500 } },
        baseUi,
      ),
      true,
    )
    assert.equal(
      isConfigOnlyPluginChange(
        basePlugin,
        baseUi,
        { ...pluginSummary('cfg:unit'), status: 'active', clientHashes: { 'index.tsx': 'h1' } },
        baseUi,
      ),
      true,
    )
    assert.equal(
      isConfigOnlyPluginChange(
        { ...pluginSummary('cfg:unit'), publicConfig: { slidingWindowMs: 1_500 } },
        [],
        { ...pluginSummary('cfg:unit'), publicConfig: { slidingWindowMs: 2_500 } },
        [],
      ),
      true,
    )

    // Semantically identical publicConfig (including key reordering or both undefined) stays non-config-only
    assert.equal(
      isConfigOnlyPluginChange(
        basePlugin,
        baseUi,
        { ...basePlugin, publicConfig: { nested: { b: true, a: 1 }, slidingWindowMs: 1_500 } },
        baseUi,
      ),
      false,
    )
    assert.equal(
      isConfigOnlyPluginChange(pluginSummary('cfg:unit'), [], pluginSummary('cfg:unit'), []),
      false,
    )

    // Status / lifecycle transitions must invalidate
    assert.equal(
      isConfigOnlyPluginChange(
        basePlugin,
        baseUi,
        { ...basePlugin, enabled: false, status: 'disabled', publicConfig: { slidingWindowMs: 2_500 } },
        [],
      ),
      false,
    )
    assert.equal(
      isConfigOnlyPluginChange(
        basePlugin,
        baseUi,
        { ...basePlugin, status: 'failed', publicConfig: { slidingWindowMs: 2_500 } },
        baseUi,
      ),
      false,
    )
    assert.equal(
      isConfigOnlyPluginChange(
        { ...basePlugin, enabled: false, status: 'disabled' },
        [],
        { ...basePlugin, publicConfig: { slidingWindowMs: 2_500 } },
        baseUi,
      ),
      false,
    )

    // clientHashes, metadata, or UI changes must invalidate
    assert.equal(
      isConfigOnlyPluginChange(
        basePlugin,
        baseUi,
        { ...basePlugin, clientHashes: { 'index.tsx': 'h2' }, publicConfig: { slidingWindowMs: 2_500 } },
        baseUi,
      ),
      false,
    )
    assert.equal(
      isConfigOnlyPluginChange(
        basePlugin,
        baseUi,
        { ...basePlugin, version: '1.0.1', publicConfig: { slidingWindowMs: 2_500 } },
        baseUi,
      ),
      false,
    )
    assert.equal(
      isConfigOnlyPluginChange(
        basePlugin,
        baseUi,
        { ...basePlugin, publicConfig: { slidingWindowMs: 2_500 } },
        [
          {
            pluginId: 'cfg:unit',
            surface: 'plugin.slot',
            spec: { id: 'badge2', target: 'builtin:composer/status', client: { module: 'index.tsx', export: 'Badge' } },
          },
        ],
      ),
      false,
    )
  })

  test('plugin.changed config-only update preserves client module, CSS, pluginDocs, and mounted React component state (live & resume-replay)', { timeout: 60_000 }, async () => {
    localStorage.setItem('helmx:token', 't1')
    const { PluginSlot, usePluginConfig, usePluginDoc } = await import('@helmx/plugin-client')

    let mountCount = 0
    function ConfigPanel(): React.ReactNode {
      const [mountId] = React.useState(() => ++mountCount)
      const [clicks, setClicks] = React.useState(0)
      const cfg = usePluginConfig<{ mode?: string; limit?: number }>()
      const statusDoc = usePluginDoc<{ ready?: boolean }>('status')
      return React.createElement(
        'div',
        { className: 'cfg-live-panel' },
        React.createElement(
          'span',
          { 'data-testid': 'cfg-state' },
          `mount=${mountId};clicks=${clicks};mode=${cfg.mode ?? 'unset'};limit=${cfg.limit ?? 0};doc=${statusDoc?.ready === true ? 'ready' : 'loading'}`,
        ),
        React.createElement(
          'button',
          { type: 'button', onClick: () => setClicks((n) => n + 1) },
          'inc',
        ),
      )
    }

    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    seedPluginClientModule(
      'cfg:p',
      'index.tsx',
      { Panel: ConfigPanel, __helmxClientCss: '.cfg-live-panel { color: rgb(1, 2, 3); }' },
      'hash-1',
    )
    const revision0 = getPluginClientCacheRevision('cfg:p')
    const styleNode0 = document.querySelector('style[data-helmx-plugin-css="cfg:p::index.tsx"]')
    assert.ok(styleNode0 !== null, 'initial plugin style node must be mounted')

    const uiContrib = {
      pluginId: 'cfg:p',
      surface: 'plugin.slot' as const,
      spec: { id: 'panel', target: 'builtin:composer/status', client: { module: 'index.tsx', export: 'Panel' } },
    }
    const activeSummary = (publicConfig: Record<string, unknown>, hash = 'hash-1') => ({
      ...pluginSummary('cfg:p'),
      status: 'active' as const,
      clientHashes: { 'index.tsx': hash },
      publicConfig,
    })
    const v2ModuleCode =
      'export const __helmxClientCss = ".cfg-live-panel { color: rgb(4, 5, 6); }";\n' +
      'export function Panel() { return globalThis.__helmx_shared_react.createElement("div", { className: "cfg-live-panel" }, "reloaded-v2"); }\n'

    const h = await mountProvider({
      children: React.createElement(PluginSlot, {
        ownerPluginId: 'builtin:composer',
        name: 'status',
      }),
      onFetch: (path) => {
        if (path.startsWith('/api/plugins/cfg%3Ap/client.mjs')) {
          if (path.includes('hash=hash-2')) {
            return new Response(v2ModuleCode, { status: 200, headers: { 'x-helmx-client-hash': 'hash-2' } })
          }
          return new Response('unexpected fetch for hash-1', { status: 500 })
        }
        return undefined
      },
    })

    try {
      let urlSeq = 0
      URL.createObjectURL = (() => `data:text/javascript;base64,${Buffer.from(v2ModuleCode).toString('base64')}#cfg-v2-${++urlSeq}`) as typeof URL.createObjectURL
      URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL

      const first = snapshotConnection(h, {
        bootId: 'b1',
        seq: 1,
        conversations: [],
        pendingAsks: [],
        plugins: [activeSummary({ mode: 'initial', limit: 1 })],
        ui: [uiContrib],
        pluginDocs: [{ pluginId: 'cfg:p', name: 'status', value: { ready: true } }],
      })
      await h.waitFor((o) => o.sseConnected === true)
      await h.waitFor(() => h.host.querySelector('[data-testid="cfg-state"]')?.textContent === 'mount=1;clicks=0;mode=initial;limit=1;doc=ready')

      // Mutate local component state before config update to verify zero remount
      await act(async () => {
        h.host.querySelector('button')?.click()
      })
      assert.equal(h.host.querySelector('[data-testid="cfg-state"]')?.textContent, 'mount=1;clicks=1;mode=initial;limit=1;doc=ready')
      const profileFetchesBeforeCfg = h.fetchedUrls.filter((u) => u === '/api/profiles').length
      const clientFetchesBeforeCfg = h.fetchedUrls.filter((u) => u.startsWith('/api/plugins/cfg%3Ap/client.mjs')).length
      assert.equal(clientFetchesBeforeCfg, 0)

      // 1. Live config-only plugin.changed: must update usePluginConfig in-place without evicting module/CSS/pluginDocs or remounting
      first.send(eventFrame(2, {
        type: 'plugin.changed',
        plugin: activeSummary({ mode: 'turbo', limit: 42 }),
        ui: [uiContrib],
      }))
      await h.waitFor(() => h.host.querySelector('[data-testid="cfg-state"]')?.textContent === 'mount=1;clicks=1;mode=turbo;limit=42;doc=ready')
      assert.equal(mountCount, 1, 'config-only update must not remount mounted React component')
      assert.equal(getPluginClientCacheRevision('cfg:p'), revision0, 'config-only update must not bump cache revision')
      assert.equal(getCachedClientComponent('cfg:p', 'index.tsx', 'Panel', 'hash-1'), ConfigPanel)
      assert.ok(document.querySelector('style[data-helmx-plugin-css="cfg:p::index.tsx"]') === styleNode0, 'CSS <style> node must stay intact without flicker')
      assert.deepEqual(h.store().pluginDocs['cfg:p/status'], { ready: true }, 'config-only must not clear pluginDocs')
      assert.equal(h.fetchedUrls.filter((u) => u.startsWith('/api/plugins/cfg%3Ap/docs/')).length, 0, 'config-only must not trigger doc refetch')
      assert.equal(h.fetchedUrls.filter((u) => u.startsWith('/api/plugins/cfg%3Ap/client.mjs')).length, 0)
      assert.equal(h.fetchedUrls.filter((u) => u === '/api/profiles').length, profileFetchesBeforeCfg, 'config-only update must skip refreshAssets')

      // 2. Resume-replay config-only plugin.changed: still updates in-place with zero eviction/remount
      let second: ControlledStream | undefined
      h.nextEvents((_url, signal) => {
        const c = controlledStream(signal)
        second = c
        return c
      })
      first.end()
      await h.waitFor(() => h.eventsUrls.length >= 2 && second !== undefined)
      second!.send(resumedFrame({ bootId: 'b1', seq: 2, headSeq: 3 }))
      second!.send(eventFrame(3, {
        type: 'plugin.changed',
        plugin: activeSummary({ mode: 'resumed', limit: 99 }),
        ui: [uiContrib],
      }))
      await h.waitFor((o) => o.sseConnected === true && h.host.querySelector('[data-testid="cfg-state"]')?.textContent === 'mount=1;clicks=1;mode=resumed;limit=99;doc=ready')
      assert.equal(mountCount, 1)
      assert.equal(getPluginClientCacheRevision('cfg:p'), revision0)
      assert.ok(document.querySelector('style[data-helmx-plugin-css="cfg:p::index.tsx"]') === styleNode0)
      assert.deepEqual(h.store().pluginDocs['cfg:p/status'], { ready: true })
      assert.equal(h.fetchedUrls.filter((u) => u.startsWith('/api/plugins/cfg%3Ap/docs/')).length, 0)
      assert.equal(h.fetchedUrls.filter((u) => u.startsWith('/api/plugins/cfg%3Ap/client.mjs')).length, 0)

      // 3. Full snapshot reconnect with config-only diff: still keeps component mounted, state intact, and zero client.mjs refetch
      let third: ControlledStream | undefined
      h.nextEvents((_url, signal) => {
        const c = controlledStream(signal)
        third = c
        return c
      })
      second!.send('event: notification\ndata: {"seq":99,"event":{"type":"notification","level":"info","title":"gap"}}\n\n')
      await h.waitFor(() => h.eventsUrls.length >= 3 && third !== undefined)
      third!.send(snapshotFrame({
        bootId: 'b2',
        seq: 1,
        conversations: [],
        pendingAsks: [],
        plugins: [activeSummary({ mode: 'snapshot', limit: 77 })],
        ui: [uiContrib],
        pluginDocs: [{ pluginId: 'cfg:p', name: 'status', value: { ready: true } }],
      }))
      await h.waitFor((o) => o.sseConnected === true && h.host.querySelector('[data-testid="cfg-state"]')?.textContent === 'mount=1;clicks=1;mode=snapshot;limit=77;doc=ready')
      assert.equal(mountCount, 1)
      assert.equal(getPluginClientCacheRevision('cfg:p'), revision0)
      assert.ok(document.querySelector('style[data-helmx-plugin-css="cfg:p::index.tsx"]') === styleNode0)
      assert.equal(h.fetchedUrls.filter((u) => u.startsWith('/api/plugins/cfg%3Ap/client.mjs')).length, 0)

      // 4. clientHashes change alongside publicConfig change: must evict old module/CSS and fetch hash-2
      third!.send(eventFrame(2, {
        type: 'plugin.changed',
        plugin: activeSummary({ mode: 'reloaded', limit: 100 }, 'hash-2'),
        ui: [uiContrib],
      }))
      await h.waitFor(() => getPluginClientCacheRevision('cfg:p') !== revision0)
      await h.waitFor(() => h.host.textContent?.includes('reloaded-v2') === true)
      assert.ok(styleNode0.isConnected === false, 'old CSS node must be evicted on clientHashes change')
      assert.equal(
        document.querySelector('style[data-helmx-plugin-css="cfg:p::index.tsx"]')?.getAttribute('data-helmx-plugin-css-hash'),
        'hash-2',
      )
      assert.equal(
        h.fetchedUrls.filter((u) => u.startsWith('/api/plugins/cfg%3Ap/client.mjs?module=index.tsx&hash=hash-2')).length,
        1,
      )
      third!.end()
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    } finally {
      URL.createObjectURL = originalCreateObjectURL
      URL.revokeObjectURL = originalRevokeObjectURL
      await h.close()
    }
  })

  test('plugin.changed invalidates cache and rejects late inflight loads on disable, enable, failed, removed, and clientHashes change', { timeout: 60_000 }, async () => {
    localStorage.setItem('helmx:token', 't1')
    const fetchResolvers = new Map<string, (res: Response) => void>()
    const h = await mountProvider({
      onFetch: (path) => {
        const match = /^\/api\/plugins\/([^/]+)\/client\.mjs/.exec(path)
        if (match) {
          const pluginId = decodeURIComponent(match[1]!)
          if (pluginId === 'race:p' || pluginId === 'fail:p' || pluginId === 'dis:p') {
            return new Promise<Response>((resolve) => {
              fetchResolvers.set(pluginId, resolve)
            })
          }
        }
        return undefined
      },
    })

    try {
      const active = (id: string, extra?: Record<string, unknown>) => ({
        ...pluginSummary(id),
        status: 'active' as const,
        clientHashes: { 'index.tsx': 'h1' },
        publicConfig: { v: 1 },
        ...extra,
      })

      seedPluginClientModule('dis:p', 'index.tsx', { Panel: () => null, __helmxClientCss: '.dis{}' }, 'h1')
      seedPluginClientModule('fail:p', 'index.tsx', { Panel: () => null, __helmxClientCss: '.fail{}' }, 'h1')
      seedPluginClientModule('rem:p', 'index.tsx', { Panel: () => null, __helmxClientCss: '.rem{}' }, 'h1')

      const first = snapshotConnection(h, {
        bootId: 'b1',
        seq: 1,
        conversations: [],
        pendingAsks: [],
        plugins: [active('race:p'), active('dis:p'), active('fail:p'), active('rem:p')],
        ui: [],
      })
      await h.waitFor((o) => o.sseConnected === true)

      // 1. Config-only update while inflight load is pending: inflight load must NOT be invalidated
      const safeInflight = loadPluginClientModule('race:p', 'index.tsx', 'h1')
      await h.waitFor(() => fetchResolvers.has('race:p'))
      const raceRev0 = getPluginClientCacheRevision('race:p')
      first.send(eventFrame(2, { type: 'plugin.changed', plugin: active('race:p', { publicConfig: { v: 2 } }), ui: [] }))
      await h.waitFor(() => (h.store().plugins.find((p) => p.id === 'race:p')?.publicConfig as { v?: number } | undefined)?.v === 2)
      assert.equal(getPluginClientCacheRevision('race:p'), raceRev0)

      const resolveSafe = fetchResolvers.get('race:p')!
      fetchResolvers.delete('race:p')
      resolveSafe(new Response('export const __helmxClientCss = ".race{}"\nexport function Panel() { return null }\n', {
        status: 200,
        headers: { 'x-helmx-client-hash': 'h1' },
      }))
      const loaded = await safeInflight
      assert.equal(loaded.contentHash, 'h1')
      assert.ok(document.querySelector('style[data-helmx-plugin-css="race:p::index.tsx"]') !== null)

      // 2. Late inflight load invalidated when clientHashes changes (even if publicConfig also changes)
      const staleByHash = loadPluginClientModule('race:p', 'index.tsx', 'h2-pending')
      await h.waitFor(() => fetchResolvers.has('race:p'))
      first.send(eventFrame(3, {
        type: 'plugin.changed',
        plugin: active('race:p', { clientHashes: { 'index.tsx': 'h3' }, publicConfig: { v: 3 } }),
        ui: [],
      }))
      await h.waitFor(() => getPluginClientCacheRevision('race:p') !== raceRev0)
      assert.equal(getCachedClientComponent('race:p', 'index.tsx', 'Panel'), undefined)
      assert.ok(document.querySelector('style[data-helmx-plugin-css="race:p::index.tsx"]') === null)
      const resolveStaleHash = fetchResolvers.get('race:p')!
      fetchResolvers.delete('race:p')
      resolveStaleHash(new Response('export const __helmxClientCss = ".stale{}"\nexport function Panel() { return null }\n', {
        status: 200,
        headers: { 'x-helmx-client-hash': 'h2-pending' },
      }))
      await assert.rejects(
        staleByHash,
        (err: unknown) => err instanceof PluginClientError && err.code === 'client_module_invalidated',
      )
      assert.ok(document.querySelector('style[data-helmx-plugin-css="race:p::index.tsx"]') === null, 'late result must not re-inject CSS')

      // 3. Failed (even with enabled: true as in markDependentsBroken) must evict and reject late loads
      const failRev0 = getPluginClientCacheRevision('fail:p')
      const staleByFail = loadPluginClientModule('fail:p', 'index.tsx', 'h2-fail')
      await h.waitFor(() => fetchResolvers.has('fail:p'))
      first.send(eventFrame(4, {
        type: 'plugin.changed',
        plugin: active('fail:p', { enabled: true, status: 'failed', clientHashes: undefined }),
        ui: [],
      }))
      await h.waitFor(() => getPluginClientCacheRevision('fail:p') !== failRev0)
      assert.equal(getCachedClientComponent('fail:p', 'index.tsx', 'Panel'), undefined)
      assert.ok(document.querySelector('style[data-helmx-plugin-css="fail:p::index.tsx"]') === null)
      const resolveStaleFail = fetchResolvers.get('fail:p')!
      fetchResolvers.delete('fail:p')
      resolveStaleFail(new Response('export const __helmxClientCss = ".fail-stale{}"\nexport function Panel() { return null }\n', {
        status: 200,
        headers: { 'x-helmx-client-hash': 'h2-fail' },
      }))
      await assert.rejects(
        staleByFail,
        (err: unknown) => err instanceof PluginClientError && err.code === 'client_module_invalidated',
      )
      assert.ok(document.querySelector('style[data-helmx-plugin-css="fail:p::index.tsx"]') === null)

      // 4. Disable -> Enable cycle: disable evicts and rejects late loads, enable advances revision and refreshes assets
      const disRev0 = getPluginClientCacheRevision('dis:p')
      const staleByDisable = loadPluginClientModule('dis:p', 'index.tsx', 'h2-dis')
      await h.waitFor(() => fetchResolvers.has('dis:p'))
      first.send(eventFrame(5, {
        type: 'plugin.changed',
        plugin: active('dis:p', { enabled: false, status: 'disabled', clientHashes: undefined }),
        ui: [],
      }))
      await h.waitFor(() => getPluginClientCacheRevision('dis:p') !== disRev0)
      const disRev1 = getPluginClientCacheRevision('dis:p')
      assert.equal(getCachedClientComponent('dis:p', 'index.tsx', 'Panel'), undefined)
      assert.ok(document.querySelector('style[data-helmx-plugin-css="dis:p::index.tsx"]') === null)
      const resolveStaleDis = fetchResolvers.get('dis:p')!
      fetchResolvers.delete('dis:p')
      resolveStaleDis(new Response('export const __helmxClientCss = ".dis-stale{}"\nexport function Panel() { return null }\n', {
        status: 200,
        headers: { 'x-helmx-client-hash': 'h2-dis' },
      }))
      await assert.rejects(
        staleByDisable,
        (err: unknown) => err instanceof PluginClientError && err.code === 'client_module_invalidated',
      )
      assert.ok(document.querySelector('style[data-helmx-plugin-css="dis:p::index.tsx"]') === null)

      const profilesBeforeEnable = h.fetchedUrls.filter((u) => u === '/api/profiles').length
      first.send(eventFrame(6, {
        type: 'plugin.changed',
        plugin: active('dis:p'),
        ui: [],
      }))
      await h.waitFor(() => getPluginClientCacheRevision('dis:p') !== disRev1)
      await h.waitFor(() => h.fetchedUrls.filter((u) => u === '/api/profiles').length > profilesBeforeEnable)

      // 5. Removed (unregister emits disabled plugin.changed) must evict module and CSS
      const remRev0 = getPluginClientCacheRevision('rem:p')
      first.send(eventFrame(7, {
        type: 'plugin.changed',
        plugin: { ...pluginSummary('rem:p'), enabled: false, status: 'disabled' },
        ui: [],
      }))
      await h.waitFor(() => getPluginClientCacheRevision('rem:p') !== remRev0)
      assert.equal(getCachedClientComponent('rem:p', 'index.tsx', 'Panel'), undefined)
      assert.ok(document.querySelector('style[data-helmx-plugin-css="rem:p::index.tsx"]') === null)

      first.end()
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    } finally {
      await h.close()
    }
  })

  test('syncPlugins adopts publicConfig/clientHashes/status updates when enabled stays true, and ensurePluginDoc skips failed plugins', { timeout: 60_000 }, async () => {
    localStorage.setItem('helmx:token', 't1')
    let otherDocCalls = 0
    let failDocCalls = 0
    const h = await mountProvider({
      onFetch: (path) => {
        if (path === '/api/plugins/other%3Ap/docs/missing') {
          otherDocCalls++
          return new Response(JSON.stringify({ error: { message: 'missing doc' } }), { status: 404, headers: { 'content-type': 'application/json' } })
        }
        if (path === '/api/plugins/fail%3Ap/docs/info') {
          failDocCalls++
          return new Response(JSON.stringify({ value: { leaked: true } }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return undefined
      },
    })

    try {
      const first = snapshotConnection(h, {
        bootId: 'b1',
        seq: 1,
        conversations: [],
        pendingAsks: [],
        plugins: [
          { ...pluginSummary('cfg:sync'), status: 'active', clientHashes: { 'index.tsx': 'h1' }, publicConfig: { k: 'v1' } },
          { ...pluginSummary('other:p'), status: 'active' },
          { ...pluginSummary('fail:p'), enabled: true, status: 'failed' },
        ],
        ui: [],
      })
      await h.waitFor((o) => o.sseConnected === true)

      // Trigger failedDocs for other:p, then send plugin.changed for cfg:sync: other:p failedDocs must stay intact
      await act(async () => {
        await h.store().ensurePluginDoc('other:p', 'missing')
      })
      assert.equal(otherDocCalls, 1)
      first.send(eventFrame(2, {
        type: 'plugin.changed',
        plugin: { ...pluginSummary('cfg:sync'), status: 'active', clientHashes: { 'index.tsx': 'h1' }, publicConfig: { k: 'v2' } },
        ui: [],
      }))
      await h.waitFor(() => (h.store().plugins.find((p) => p.id === 'cfg:sync')?.publicConfig as { k?: string } | undefined)?.k === 'v2')
      await act(async () => {
        await h.store().ensurePluginDoc('other:p', 'missing')
      })
      assert.equal(otherDocCalls, 1, 'unrelated plugin failedDocs must not be cleared globally on plugin.changed')

      // ensurePluginDoc must not write pluginDocs when plugin is enabled=true, status='failed'
      const docVal = await act(async () => h.store().ensurePluginDoc('fail:p', 'info'))
      assert.equal(failDocCalls, 1)
      assert.deepEqual(docVal, { leaked: true })
      assert.equal(h.store().pluginDocs['fail:p/info'], undefined, 'ensurePluginDoc must not populate docs for status=failed plugins')

      // syncPlugins must adopt incoming publicConfig / clientHashes / status changes even when enabled stays true
      const beforePlugins = h.store().plugins
      await act(async () => {
        h.store().syncPlugins(beforePlugins)
      })
      assert.equal(h.store().plugins, beforePlugins, 'syncPlugins with identical payloads must preserve plugins reference')

      await act(async () => {
        h.store().syncPlugins([
          { ...pluginSummary('cfg:sync'), status: 'active', clientHashes: { 'index.tsx': 'h2' }, publicConfig: { k: 'v3' } },
          { ...pluginSummary('other:p'), status: 'failed' },
          { ...pluginSummary('fail:p'), enabled: true, status: 'failed' },
        ])
      })
      const syncedCfg = h.store().plugins.find((p) => p.id === 'cfg:sync')
      assert.deepEqual(syncedCfg?.publicConfig, { k: 'v3' })
      assert.deepEqual(syncedCfg?.clientHashes, { 'index.tsx': 'h2' })
      assert.equal(h.store().plugins.find((p) => p.id === 'other:p')?.status, 'failed')

      first.end()
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    } finally {
      await h.close()
    }
  })

  test('config-only plugin.changed preserves same-plugin failedDocs, inflight doc requests, and loadErrors without redundant retries', { timeout: 60_000 }, async () => {
    localStorage.setItem('helmx:token', 't1')
    let missingCalls = 0
    let slowCalls = 0
    let resolveSlow: ((res: Response) => void) | undefined
    const h = await mountProvider({
      onFetch: (path) => {
        if (path === '/api/plugins/cfg%3Aerr/docs/missing') {
          missingCalls++
          return new Response(JSON.stringify({ error: { message: 'doc missing' } }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          })
        }
        if (path === '/api/plugins/cfg%3Aerr/docs/slow') {
          slowCalls++
          return new Promise<Response>((resolve) => {
            resolveSlow = resolve
          })
        }
        return undefined
      },
    })

    try {
      const uiContrib = {
        pluginId: 'cfg:err',
        surface: 'plugin.slot' as const,
        spec: { id: 'panel', target: 'builtin:composer/status', client: { module: 'index.tsx', export: 'Panel' } },
      }
      const summary = (v: number) => ({
        ...pluginSummary('cfg:err'),
        status: 'active' as const,
        clientHashes: { 'index.tsx': 'h1' },
        publicConfig: { v },
      })

      const first = snapshotConnection(h, {
        bootId: 'b1',
        seq: 1,
        conversations: [],
        pendingAsks: [],
        plugins: [summary(1)],
        ui: [uiContrib],
      })
      await h.waitFor((o) => o.sseConnected === true)

      // 1. Trigger a failed doc load AND start an inflight doc load on cfg:err
      await act(async () => {
        await h.store().ensurePluginDoc('cfg:err', 'missing')
      })
      assert.equal(missingCalls, 1)
      const missingErrBefore = h.store().loadErrors['doc:cfg:err/missing']
      assert.ok(missingErrBefore !== undefined, 'failed doc must record loadErrors["doc:cfg:err/missing"]')

      const inflightSlow = h.store().ensurePluginDoc('cfg:err', 'slow')
      await h.waitFor(() => resolveSlow !== undefined)
      assert.equal(slowCalls, 1)

      // 2. Deliver a config-only plugin.changed for the SAME plugin cfg:err
      first.send(eventFrame(2, {
        type: 'plugin.changed',
        plugin: summary(2),
        ui: [uiContrib],
      }))
      await h.waitFor(() => (h.store().plugins.find((p) => p.id === 'cfg:err')?.publicConfig as { v?: number } | undefined)?.v === 2)

      // failedDocs + loadErrors must stay intact (calling ensurePluginDoc again must NOT refetch)
      assert.equal(h.store().loadErrors['doc:cfg:err/missing'], missingErrBefore, 'config-only must preserve loadErrors')
      await act(async () => {
        await h.store().ensurePluginDoc('cfg:err', 'missing')
      })
      assert.equal(missingCalls, 1, 'same-plugin config-only update must not clear failedDocs or cause redundant doc retry')

      // Inflight request must stay deduplicated and complete cleanly after config-only update
      const dedupSlow = h.store().ensurePluginDoc('cfg:err', 'slow')
      assert.equal(slowCalls, 1, 'config-only must not drop inflight doc request from requests map')
      await act(async () => {
        resolveSlow!(new Response(JSON.stringify({ value: { loaded: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }))
        const [val1, val2] = await Promise.all([inflightSlow, dedupSlow])
        assert.deepEqual(val1, { loaded: true })
        assert.deepEqual(val2, { loaded: true })
      })
      assert.deepEqual(h.store().pluginDocs['cfg:err/slow'], { loaded: true })

      first.end()
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    } finally {
      await h.close()
    }
  })

  test('non-config-only plugin.changed clears doc:<pluginId>/ in failedDocs and loadErrors across metadata, hash, failed, and disabled transitions without affecting other plugins', { timeout: 60_000 }, async () => {
    localStorage.setItem('helmx:token', 't1')
    let targetCalls = 0
    let otherCalls = 0
    let targetShouldSucceed = false
    const h = await mountProvider({
      onFetch: (path) => {
        if (path === '/api/plugins/target%3Ap/docs/info') {
          targetCalls++
          if (targetShouldSucceed) {
            return new Response(JSON.stringify({ value: { ok: targetCalls } }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          return new Response(JSON.stringify({ error: { message: 'target doc failed' } }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        }
        if (path === '/api/plugins/other%3Ap/docs/info') {
          otherCalls++
          return new Response(JSON.stringify({ error: { message: 'other doc failed' } }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        }
        return undefined
      },
    })

    try {
      const targetSummary = (extra?: Record<string, unknown>) => ({
        ...pluginSummary('target:p'),
        version: '1.0.0',
        status: 'active' as const,
        clientHashes: { 'index.tsx': 'h1' },
        publicConfig: { mode: 'a' },
        ...extra,
      })
      const otherSummary = {
        ...pluginSummary('other:p'),
        status: 'active' as const,
        clientHashes: { 'index.tsx': 'h-other' },
      }

      const first = snapshotConnection(h, {
        bootId: 'b1',
        seq: 1,
        conversations: [],
        pendingAsks: [],
        plugins: [targetSummary(), otherSummary],
        ui: [],
      })
      await h.waitFor((o) => o.sseConnected === true)

      // Seed doc failures on both plugins
      await act(async () => {
        await h.store().ensurePluginDoc('target:p', 'info')
        await h.store().ensurePluginDoc('other:p', 'info')
      })
      assert.equal(targetCalls, 1)
      assert.equal(otherCalls, 1)
      assert.ok(h.store().loadErrors['doc:target:p/info'] !== undefined)
      assert.ok(h.store().loadErrors['doc:other:p/info'] !== undefined)

      // 1. Metadata change (version 1.0.0 -> 1.1.0): clears target:p loadErrors & failedDocs, preserves other:p
      first.send(eventFrame(2, {
        type: 'plugin.changed',
        plugin: targetSummary({ version: '1.1.0' }),
        ui: [],
      }))
      await h.waitFor(() => h.store().plugins.find((p) => p.id === 'target:p')?.version === '1.1.0')
      assert.equal(h.store().loadErrors['doc:target:p/info'], undefined, 'metadata invalidation must clear doc:<id>/ loadErrors')
      assert.ok(h.store().loadErrors['doc:other:p/info'] !== undefined, 'other plugin loadErrors must remain intact')

      await act(async () => {
        await h.store().ensurePluginDoc('other:p', 'info')
        await h.store().ensurePluginDoc('target:p', 'info')
      })
      assert.equal(otherCalls, 1, 'other plugin failedDocs suppression must remain intact')
      assert.equal(targetCalls, 2, 'target plugin failedDocs must be cleared to allow retry')
      assert.ok(h.store().loadErrors['doc:target:p/info'] !== undefined)

      // 2. clientHashes change (h1 -> h2): clears loadErrors & failedDocs and allows successful retry
      targetShouldSucceed = true
      first.send(eventFrame(3, {
        type: 'plugin.changed',
        plugin: targetSummary({ version: '1.1.0', clientHashes: { 'index.tsx': 'h2' } }),
        ui: [],
      }))
      await h.waitFor(() => h.store().plugins.find((p) => p.id === 'target:p')?.clientHashes?.['index.tsx'] === 'h2')
      assert.equal(h.store().loadErrors['doc:target:p/info'], undefined, 'hash change must clear stale loadErrors')
      await act(async () => {
        await h.store().ensurePluginDoc('target:p', 'info')
      })
      assert.equal(targetCalls, 3)
      assert.deepEqual(h.store().pluginDocs['target:p/info'], { ok: 3 })
      assert.equal(h.store().loadErrors['doc:target:p/info'], undefined)

      // 3. Re-fail then transition to enabled=true, status='failed': must clear loadErrors
      targetShouldSucceed = false
      first.send(eventFrame(4, {
        type: 'plugin.changed',
        plugin: targetSummary({ version: '1.2.0', clientHashes: { 'index.tsx': 'h2' } }),
        ui: [],
      }))
      await h.waitFor(() => h.store().plugins.find((p) => p.id === 'target:p')?.version === '1.2.0')
      await act(async () => {
        await h.store().ensurePluginDoc('target:p', 'info')
      })
      assert.ok(h.store().loadErrors['doc:target:p/info'] !== undefined)

      first.send(eventFrame(5, {
        type: 'plugin.changed',
        plugin: targetSummary({ version: '1.2.0', enabled: true, status: 'failed' }),
        ui: [],
      }))
      await h.waitFor(() => h.store().plugins.find((p) => p.id === 'target:p')?.status === 'failed')
      assert.equal(h.store().loadErrors['doc:target:p/info'], undefined, 'failed transition must clear doc:<id>/ loadErrors')
      assert.ok(h.store().loadErrors['doc:other:p/info'] !== undefined)

      // 4. Recover to active, re-fail, then disable: must clear loadErrors
      first.send(eventFrame(6, {
        type: 'plugin.changed',
        plugin: targetSummary({ version: '1.2.0', enabled: true, status: 'active' }),
        ui: [],
      }))
      await h.waitFor(() => h.store().plugins.find((p) => p.id === 'target:p')?.status === 'active')
      await act(async () => {
        await h.store().ensurePluginDoc('target:p', 'info')
      })
      assert.ok(h.store().loadErrors['doc:target:p/info'] !== undefined)

      first.send(eventFrame(7, {
        type: 'plugin.changed',
        plugin: targetSummary({ version: '1.2.0', enabled: false, status: 'disabled' }),
        ui: [],
      }))
      await h.waitFor(() => h.store().plugins.find((p) => p.id === 'target:p')?.enabled === false)
      assert.equal(h.store().loadErrors['doc:target:p/info'], undefined, 'disabled transition must clear doc:<id>/ loadErrors')
      assert.ok(h.store().loadErrors['doc:other:p/info'] !== undefined)

      // 5. plugin.doc.updated for active other:p clears its stale loadErrors & failedDocs
      first.send(eventFrame(8, {
        type: 'plugin.doc.updated',
        doc: { pluginId: 'other:p', name: 'info', value: { pushed: true } },
      }))
      await h.waitFor(() => h.store().pluginDocs['other:p/info'] !== undefined)
      assert.deepEqual(h.store().pluginDocs['other:p/info'], { pushed: true })
      assert.equal(h.store().loadErrors['doc:other:p/info'], undefined, 'plugin.doc.updated must clear stale loadErrors for that doc')

      first.end()
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    } finally {
      await h.close()
    }
  })

  test('syncPlugins reconciles client cache, UI contributions, pluginDocs, loadErrors, and sessionDocs when SSE plugin.changed frames are missing', { timeout: 60_000 }, async () => {
    localStorage.setItem('helmx:token', 't1')
    resetSessionDocSubscriptions()
    const { PluginSlot } = await import('@helmx/plugin-client')

    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const KeepPanel = () => React.createElement('div', { 'data-testid': 'keep-panel' }, 'keep-v1')
    const HashPanelV1 = () => React.createElement('div', { 'data-testid': 'hash-panel' }, 'hash-v1')
    const FailPanel = () => React.createElement('div', { 'data-testid': 'fail-panel' }, 'fail-v1')
    const DisPanel = () => React.createElement('div', { 'data-testid': 'dis-panel' }, 'dis-v1')
    const RemPanel = () => React.createElement('div', { 'data-testid': 'rem-panel' }, 'rem-v1')

    seedPluginClientModule('keep:p', 'index.tsx', { Panel: KeepPanel, __helmxClientCss: '.keep{color:#111}' }, 'h-keep')
    seedPluginClientModule('hash:p', 'index.tsx', { Panel: HashPanelV1, __helmxClientCss: '.hash{color:#222}' }, 'h-old')
    seedPluginClientModule('fail:p', 'index.tsx', { Panel: FailPanel, __helmxClientCss: '.fail{color:#333}' }, 'h-fail')
    seedPluginClientModule('dis:p', 'index.tsx', { Panel: DisPanel, __helmxClientCss: '.dis{color:#444}' }, 'h-dis')
    seedPluginClientModule('rem:p', 'index.tsx', { Panel: RemPanel, __helmxClientCss: '.rem{color:#555}' }, 'h-rem')

    const revKeep0 = getPluginClientCacheRevision('keep:p')
    const revHash0 = getPluginClientCacheRevision('hash:p')
    const revFail0 = getPluginClientCacheRevision('fail:p')
    const revDis0 = getPluginClientCacheRevision('dis:p')
    const revRem0 = getPluginClientCacheRevision('rem:p')

    const hashV2Code =
      'export const __helmxClientCss = ".hash{color:#999}";\n' +
      'export function Panel() { return globalThis.__helmx_shared_react.createElement("div", { "data-testid": "hash-panel" }, "hash-v2"); }\n'

    let hashErrDocCalls = 0
    let keepErrDocCalls = 0
    let hashErrShouldSucceed = false

    const h = await mountProvider({
      children: React.createElement(PluginSlot, {
        ownerPluginId: 'builtin:composer',
        name: 'status',
      }),
      onFetch: (path) => {
        if (path === '/api/plugins/hash%3Ap/client.mjs?module=index.tsx&hash=h-new') {
          return new Response(hashV2Code, { status: 200, headers: { 'x-helmx-client-hash': 'h-new' } })
        }
        if (path === '/api/plugins/hash%3Ap/docs/missing') {
          hashErrDocCalls++
          if (hashErrShouldSucceed) {
            return new Response(JSON.stringify({ value: { recovered: true } }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          return new Response(JSON.stringify({ error: { message: 'hash doc missing' } }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          })
        }
        if (path === '/api/plugins/keep%3Ap/docs/missing') {
          keepErrDocCalls++
          return new Response(JSON.stringify({ error: { message: 'keep doc missing' } }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          })
        }
        if (path === '/api/plugins/fail%3Ap/docs/missing' || path === '/api/plugins/dis%3Ap/docs/missing' || path === '/api/plugins/rem%3Ap/docs/missing') {
          return new Response(JSON.stringify({ error: { message: 'doc missing' } }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          })
        }
        return undefined
      },
    })

    const offKeepSession = subscribeSessionDoc({ pluginId: 'keep:p', docName: 'runs', conversationId: 1 }, () => {})
    const offFailSession = subscribeSessionDoc({ pluginId: 'fail:p', docName: 'runs', conversationId: 1 }, () => {})
    const offDisSession = subscribeSessionDoc({ pluginId: 'dis:p', docName: 'runs', conversationId: 1 }, () => {})
    const offRemSession = subscribeSessionDoc({ pluginId: 'rem:p', docName: 'runs', conversationId: 1 }, () => {})

    try {
      URL.createObjectURL = () => `data:text/javascript;base64,${Buffer.from(hashV2Code).toString('base64')}#sync-v2`
      URL.revokeObjectURL = () => {}

      const makeUi = (id: string) => ({
        pluginId: id,
        surface: 'plugin.slot' as const,
        spec: { id: `${id}-panel`, target: 'builtin:composer/status', client: { module: 'index.tsx', export: 'Panel' } },
      })
      const makeSummary = (id: string, hash: string, extra?: Record<string, unknown>) => ({
        ...pluginSummary(id),
        status: 'active' as const,
        clientHashes: { 'index.tsx': hash },
        publicConfig: { v: 1 },
        ...extra,
      })

      const initialPlugins = [
        makeSummary('keep:p', 'h-keep'),
        makeSummary('hash:p', 'h-old'),
        makeSummary('fail:p', 'h-fail'),
        makeSummary('dis:p', 'h-dis'),
        makeSummary('rem:p', 'h-rem'),
      ]

      const first = snapshotConnection(h, {
        bootId: 'b1',
        seq: 1,
        conversations: [],
        pendingAsks: [],
        plugins: initialPlugins,
        ui: ['keep:p', 'hash:p', 'fail:p', 'dis:p', 'rem:p'].map(makeUi),
        pluginDocs: [
          { pluginId: 'keep:p', name: 'info', value: { v: 'keep' } },
          { pluginId: 'hash:p', name: 'info', value: { v: 'hash-old' } },
          { pluginId: 'fail:p', name: 'info', value: { v: 'fail' } },
          { pluginId: 'dis:p', name: 'info', value: { v: 'dis' } },
          { pluginId: 'rem:p', name: 'info', value: { v: 'rem' } },
        ],
      })
      await h.waitFor((o) => o.sseConnected === true && h.host.querySelector('[data-testid="hash-panel"]')?.textContent === 'hash-v1')

      // Populate failedDocs + loadErrors for all five plugins
      await act(async () => {
        await Promise.all([
          h.store().ensurePluginDoc('keep:p', 'missing'),
          h.store().ensurePluginDoc('hash:p', 'missing'),
          h.store().ensurePluginDoc('fail:p', 'missing'),
          h.store().ensurePluginDoc('dis:p', 'missing'),
          h.store().ensurePluginDoc('rem:p', 'missing'),
        ])
      })
      assert.ok(h.store().loadErrors['doc:keep:p/missing'] !== undefined)
      assert.ok(h.store().loadErrors['doc:hash:p/missing'] !== undefined)
      assert.ok(h.store().loadErrors['doc:fail:p/missing'] !== undefined)
      assert.ok(h.store().loadErrors['doc:dis:p/missing'] !== undefined)
      assert.ok(h.store().loadErrors['doc:rem:p/missing'] !== undefined)

      // 1. Config-only syncPlugins on keep:p: zero eviction, preserves UI/docs/loadErrors/failedDocs
      const uiBeforeCfg = h.store().uiContributions
      const docsBeforeCfg = h.store().pluginDocs
      const keepStyleBefore = document.querySelector('style[data-helmx-plugin-css="keep:p::index.tsx"]')
      await act(async () => {
        h.store().syncPlugins([
          makeSummary('keep:p', 'h-keep', { publicConfig: { v: 2 } }),
          ...initialPlugins.slice(1),
        ])
      })
      assert.equal(h.store().uiContributions, uiBeforeCfg, 'config-only syncPlugins must preserve uiContributions ref')
      assert.equal(h.store().pluginDocs, docsBeforeCfg, 'config-only syncPlugins must preserve pluginDocs ref')
      assert.equal(getPluginClientCacheRevision('keep:p'), revKeep0)
      assert.ok(document.querySelector('style[data-helmx-plugin-css="keep:p::index.tsx"]') === keepStyleBefore)
      assert.ok(h.store().loadErrors['doc:keep:p/missing'] !== undefined)
      await act(async () => {
        await h.store().ensurePluginDoc('keep:p', 'missing')
      })
      assert.equal(keepErrDocCalls, 1, 'config-only syncPlugins must not clear failedDocs')

      // 2. Full HTTP calibration simulating missed SSE frames:
      //    - keep:p unchanged
      //    - hash:p updated to h-new
      //    - fail:p enabled=true, status='failed' (even with residual clientHashes)
      //    - dis:p enabled=false, status='disabled'
      //    - rem:p omitted (removed)
      hashErrShouldSucceed = true
      await act(async () => {
        h.store().syncPlugins([
          makeSummary('keep:p', 'h-keep', { publicConfig: { v: 2 } }),
          makeSummary('hash:p', 'h-new'),
          makeSummary('fail:p', 'h-fail', { enabled: true, status: 'failed' }),
          makeSummary('dis:p', 'h-dis', { enabled: false, status: 'disabled', clientHashes: undefined }),
        ])
      })

      // Wait for mounted PluginUiView for hash:p to automatically reload h-new!
      await h.waitFor(() => h.host.querySelector('[data-testid="hash-panel"]')?.textContent === 'hash-v2')

      // keep:p completely preserved
      assert.equal(getPluginClientCacheRevision('keep:p'), revKeep0)
      assert.equal(getCachedClientComponent('keep:p', 'index.tsx', 'Panel', 'h-keep'), KeepPanel)
      assert.ok(document.querySelector('style[data-helmx-plugin-css="keep:p::index.tsx"]') === keepStyleBefore)
      assert.deepEqual(h.store().pluginDocs['keep:p/info'], { v: 'keep' })
      assert.ok(h.store().loadErrors['doc:keep:p/missing'] !== undefined)
      assert.equal(getSessionDocState({ pluginId: 'keep:p', docName: 'runs', conversationId: 1 }).error, undefined)

      // hash:p cache/CSS reloaded to h-new, stale docs & doc errors cleared, active UI kept
      assert.notEqual(getPluginClientCacheRevision('hash:p'), revHash0)
      assert.equal(
        document.querySelector('style[data-helmx-plugin-css="hash:p::index.tsx"]')?.getAttribute('data-helmx-plugin-css-hash'),
        'h-new',
      )
      assert.equal(h.store().pluginDocs['hash:p/info'], undefined, 'hash change via syncPlugins must clear stale pluginDocs')
      assert.equal(h.store().loadErrors['doc:hash:p/missing'], undefined, 'hash change via syncPlugins must clear stale loadErrors')
      await act(async () => {
        await h.store().ensurePluginDoc('hash:p', 'missing')
      })
      assert.equal(hashErrDocCalls, 2, 'hash change via syncPlugins must clear failedDocs so doc can retry')
      assert.deepEqual(h.store().pluginDocs['hash:p/missing'], { recovered: true })

      // fail:p, dis:p, rem:p: UI, docs, client cache, CSS, loadErrors, and sessionDocs all converged!
      assert.deepEqual(
        h.store().uiContributions.map((u) => u.pluginId),
        ['keep:p', 'hash:p'],
        'disabled/failed/removed plugins must be pruned from uiContributions on syncPlugins',
      )
      assert.ok(h.host.querySelector('[data-testid="fail-panel"]') === null)
      assert.ok(h.host.querySelector('[data-testid="dis-panel"]') === null)
      assert.ok(h.host.querySelector('[data-testid="rem-panel"]') === null)

      for (const [id, rev0] of [
        ['fail:p', revFail0],
        ['dis:p', revDis0],
        ['rem:p', revRem0],
      ] as const) {
        assert.notEqual(getPluginClientCacheRevision(id), rev0, `${id} revision must advance on syncPlugins eviction`)
        assert.equal(getCachedClientComponent(id, 'index.tsx', 'Panel'), undefined, `${id} client cache must be evicted`)
        assert.ok(document.querySelector(`style[data-helmx-plugin-css="${id}::index.tsx"]`) === null, `${id} CSS must be removed`)
        assert.equal(h.store().pluginDocs[`${id}/info`], undefined, `${id} pluginDocs must be cleared`)
        assert.equal(h.store().loadErrors[`doc:${id}/missing`], undefined, `${id} loadErrors must be cleared`)
        assert.ok(
          getSessionDocState({ pluginId: id, docName: 'runs', conversationId: 1 }).error !== undefined,
          `${id} sessionDoc subscription must be terminated`,
        )
      }

      first.end()
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    } finally {
      offKeepSession()
      offFailSession()
      offDisSession()
      offRemSession()
      resetSessionDocSubscriptions()
      URL.createObjectURL = originalCreateObjectURL
      URL.revokeObjectURL = originalRevokeObjectURL
      await h.close()
    }
  })

  test('首帧 snapshot.serverTime 与 resumed.serverTime 立即校准 serverNow()（即使无活跃 conversationLives）', { timeout: 60_000 }, async () => {
    const { resetServerClock, serverNow } = await import('../src/lib/server-clock.js')
    resetServerClock()
    localStorage.setItem('helmx:token', 't1')
    const h = await mountProvider()
    try {
      const localAtSnap = Date.now()
      const skewedServerSnap = localAtSnap - 10_000
      const first = snapshotConnection(h, {
        bootId: 'b1',
        seq: 1,
        serverTime: skewedServerSnap,
        conversations: [],
        pendingAsks: [],
        plugins: [],
        ui: [],
      })
      await h.waitFor((o) => o.sseConnected === true)
      const driftAfterSnap = Math.abs((Date.now() - serverNow()) - 10_000)
      assert.ok(driftAfterSnap < 1500, `snapshot.serverTime should calibrate ~10s offset, got drift=${driftAfterSnap}ms`)

      // 断线续传：resumed.serverTime 进一步提供更低延迟/校正样本
      resetServerClock()
      let second: ControlledStream | undefined
      h.nextEvents((_url, signal) => {
        const c = controlledStream(signal)
        second = c
        return c
      })
      first.end()
      await h.waitFor(() => h.eventsUrls.length >= 2 && second !== undefined)
      const skewedServerResumed = Date.now() + 8_000
      second!.send(resumedFrame({ bootId: 'b1', seq: 1, headSeq: 1, serverTime: skewedServerResumed }))
      await h.waitFor((o) => o.sseConnected === true)
      const driftAfterResumed = Math.abs((serverNow() - Date.now()) - 8_000)
      assert.ok(driftAfterResumed < 1500, `resumed.serverTime should calibrate ~+8s offset, got drift=${driftAfterResumed}ms`)
      second!.end()
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    } finally {
      resetServerClock()
      await h.close()
    }
  })
})
