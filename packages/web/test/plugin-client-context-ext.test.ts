/**
 * PluginClientContext 扩展契约测试（P1/P4）：
 * - usePluginDoc(docName, pluginId?) 跨插件订阅；
 * - usePluginSessionDoc：ctx 插件/会话继承、显式覆写、无会话返回 undefined 不开流；
 * - createPluginClientContext：callAction 第三参跨插件寻址、submitInput 无会话
 *   显式 reject 与真实 conversationsApi 载荷（origin: agent）、getPluginDoc
 *   第二参、getPluginSessionDoc 路径与参数、composer 仅显式提供时存在。
 * 真实 React DOM 渲染路径（createRoot + act），store 为行为真实的最小替身。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ComposerController } from '@helmx/protocol'
import { getSessionDocState, resetSessionDocSubscriptions, subscribeSessionDoc, type SessionDocKey } from '../src/lib/session-docs.js'
import { createPluginClientHostPort } from '../src/lib/plugin-client-host.js'
import {
  createPluginClientContext,
  PluginClientContext,
  usePluginDoc,
  usePluginDocState,
  usePluginSessionDoc,
  type PluginDocState,
} from '@helmx/plugin-client'
import { pluginsApi, setStoredToken } from '../src/lib/api.js'
import { makeTestStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'
import type { HelmxExternalStore, HelmxStoreActions } from '../src/lib/helmx-store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/** 在 actions 包上替换具名动作（快照/端口构建前替换；调用契约断言需捕获入参）。 */
function spyAction<K extends keyof HelmxStoreActions>(store: HelmxExternalStore, key: K, impl: HelmxStoreActions[K]): void {
  ;(store.actions as unknown as Record<K, HelmxStoreActions[K]>)[key] = impl
}

/** 在双 Provider 内挂载探针并回传 hooks 结果。 */
function mountProbe<T>(store: HelmxExternalStore, ctxValue: ReturnType<typeof createPluginClientContext>, use: () => T): { result: () => T | undefined; unmount: () => void } {
  let captured: T | undefined
  function Probe(): React.ReactNode {
    captured = use()
    return e('div', null, String(JSON.stringify(captured)?.slice(0, 80) ?? ''))
  }
  const host = document.createElement('div')
  let root: Root | undefined
  act(() => {
    root = createRoot(host)
    root.render(e(HostStoreProviders, { value: store }, e(PluginClientContext.Provider, { value: ctxValue }, e(Probe))))
  })
  return {
    result: () => captured,
    unmount: () => { act(() => root?.unmount()) },
  }
}

test('usePluginDoc：省略 pluginId 用 ctx 插件，显式 pluginId 跨插件订阅', { timeout: 60_000 }, () => {
  const ensured: Array<[string, string]> = []
  const store = makeTestStore({
    pluginDocs: { 'test:plugin/status': { ok: 1 }, 'other:plugin/status': { ok: 2 } },
  })
  spyAction(store, 'ensurePluginDoc', async (pluginId, docName) => { ensured.push([pluginId, docName]); return undefined })
  const ctx = createPluginClientContext(createPluginClientHostPort(store), 'test:plugin', 1)
  const p1 = mountProbe(store, ctx, () => usePluginDoc('status'))
  assert.deepEqual(p1.result(), { ok: 1 }, '省略 pluginId 读当前插件文档')
  const p2 = mountProbe(store, ctx, () => usePluginDoc('status', 'other:plugin'))
  assert.deepEqual(p2.result(), { ok: 2 }, '显式 pluginId 跨插件读取')
  const p3 = mountProbe(store, ctx, () => usePluginDoc('missing'))
  assert.equal(p3.result(), undefined)
  assert.deepEqual(ensured, [['test:plugin', 'missing']], '缺失文档自动 ensure 一次')
  p1.unmount(); p2.unmount(); p3.unmount()
})

test('usePluginSessionDoc：继承 ctx 插件与会话；显式覆写；无会话不开流', { timeout: 60_000 }, async () => {
  resetSessionDocSubscriptions()
  const opened: SessionDocKey[] = []
  const store = makeTestStore({})
  spyAction(store, 'subscribeSessionDoc', (key, listener) => {
    opened.push(key)
    return subscribeSessionDoc(key, listener)
  })
  const ctx = createPluginClientContext(createPluginClientHostPort(store), 'test:plugin', 7)
  // 显式覆写 conversationId（无 SSE 环境：订阅会尝试连接，值保持 undefined，不 mock）
  const p1 = mountProbe(store, ctx, () => usePluginSessionDoc('runs', { conversationId: 9 }))
  assert.equal(p1.result(), undefined, '未收到首帧前 undefined')
  assert.deepEqual(opened, [{ pluginId: 'test:plugin', docName: 'runs', conversationId: 9 }], '显式会话覆写生效')
  p1.unmount()

  // 无会话上下文：不开流
  const ctxNoConv = createPluginClientContext(createPluginClientHostPort(store), 'test:plugin', undefined)
  const p2 = mountProbe(store, ctxNoConv, () => usePluginSessionDoc('runs'))
  assert.equal(p2.result(), undefined)
  assert.equal(opened.length, 1, '无会话不开订阅流')
  p2.unmount()
})

test('callAction 第三参：跨插件寻址与显式会话', { timeout: 60_000 }, async () => {
  const calls: Array<{ pluginId: string; actionId: string; input: unknown; conversationId?: number }> = []
  const store = makeTestStore({})
  spyAction(store, 'invokePluginAction', async (pluginId, actionId, input, conversationId) => {
    calls.push({ pluginId, actionId, input, conversationId })
    return { pong: true }
  })
  const ctx = createPluginClientContext(createPluginClientHostPort(store), 'test:plugin', 5)
  const r1 = await ctx.callAction('ping', { a: 1 })
  assert.deepEqual(r1, { pong: true })
  assert.deepEqual(calls[0], { pluginId: 'test:plugin', actionId: 'ping', input: { a: 1 }, conversationId: 5 }, '默认本插件 + 继承会话')
  await ctx.callAction('ping', {}, { pluginId: 'other:plugin', conversationId: 12 })
  assert.deepEqual(calls[1], { pluginId: 'other:plugin', actionId: 'ping', input: {}, conversationId: 12 }, '显式跨插件 + 会话覆写')
  // 非法会话 ID 显式抛错（同步校验 reject）
  await assert.rejects(async () => ctx.callAction('ping', {}, { conversationId: -3 }), /must be a positive integer/)
})

test('submitInput：真实 conversationsApi（origin agent）；无会话显式 reject', { timeout: 60_000 }, async (t) => {
  const captured: Array<{ path: string; body: unknown }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ path: String(input), body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify({ submissionId: 's1' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = originalFetch })

  const store = makeTestStore()
  const ctx = createPluginClientContext(createPluginClientHostPort(store), 'test:plugin', 42)
  await ctx.submitInput('hello', { whenBusy: 'followUp' })
  assert.equal(captured.length, 1)
  assert.equal(captured[0]!.path, '/api/conversations/42/input')
  assert.deepEqual(captured[0]!.body, { text: 'hello', origin: 'agent', whenBusy: 'followUp' }, '真实 API 载荷：agent 来源 + whenBusy')

  // 显式会话覆写
  await ctx.submitInput('hi', { conversationId: 7 })
  assert.equal(captured[1]!.path, '/api/conversations/7/input')

  // 无会话上下文且未显式指定：显式 reject（不静默降级）
  const ctxNone = createPluginClientContext(createPluginClientHostPort(store), 'test:plugin', undefined)
  await assert.rejects(() => ctxNone.submitInput('x'), /submitInput has no target conversation/)
})

test('getPluginDoc/getPluginSessionDoc：第二参与会话路径（真实 pluginsApi fetch）', { timeout: 60_000 }, async (t) => {
  const paths: Array<{ path: string; qs: string | undefined }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = String(input)
    const qAt = raw.indexOf('?')
    paths.push({ path: qAt < 0 ? raw : raw.slice(0, qAt), qs: qAt < 0 ? undefined : raw.slice(qAt + 1) })
    return new Response(JSON.stringify({ pluginId: 'p', name: 'd', conversationId: 9, value: { v: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = originalFetch })

  // 真实 store 动作本身就绑真实 pluginsApi（fetch 拦截观察请求）
  const realStore = makeTestStore()
  const ctx = createPluginClientContext(createPluginClientHostPort(realStore), 'test:plugin', 9)
  const v = await ctx.getPluginDoc('status', 'other:plugin')
  assert.equal(paths[0]!.path, '/api/plugins/other%3Aplugin/docs/status')
  assert.deepEqual(v, { v: 1 }, '返回文档 value')

  const sv = await ctx.getPluginSessionDoc('runs')
  assert.equal(paths[1]!.path, '/api/plugins/test%3Aplugin/docs/runs')
  assert.equal(paths[1]!.qs, 'conversationId=9', '会话文档走同一路径 + conversationId 查询参数')
  assert.deepEqual(sv, { v: 1 })

  const ctxNone = createPluginClientContext(createPluginClientHostPort(realStore), 'test:plugin', undefined)
  await assert.rejects(() => ctxNone.getPluginSessionDoc('runs'), /getPluginSessionDoc has no target conversation/)
})

test('composer：仅显式提供时存在于 ctx；透传同一实例', { timeout: 60_000 }, () => {
  const store = makeTestStore()
  const controller: ComposerController = {
    draft: '',
    attachments: [],
    sending: false,
    setDraft: () => {},
    insertText: () => {},
    submit: async () => {},
  }
  const withComposer = createPluginClientContext(createPluginClientHostPort(store), 'test:plugin', 1, controller)
  assert.equal(withComposer.composer, controller, '显式提供时透传同一实例')
  const without = createPluginClientContext(createPluginClientHostPort(store), 'test:plugin', 1)
  assert.equal(without.composer, undefined, '未提供时省略键（非 undefined 赋值）')
})

test('locale/translate：宿主端口按 store locale 注入并可解析显示文案', { timeout: 60_000 }, () => {
  const storeEn = makeTestStore({ locale: 'en' })
  const ctxEn = createPluginClientContext(createPluginClientHostPort(storeEn), 'test:plugin', 1)
  assert.equal(ctxEn.locale, 'en')
  assert.equal(ctxEn.translate('plain'), 'plain')
  assert.equal(ctxEn.translate({ en: 'Hi', 'zh-CN': '你好' }), 'Hi')
  assert.equal(ctxEn.translate({ 'zh-CN': '你好' }), '你好', '仅声明项时按声明序回退')

  const storeZh = makeTestStore({ locale: 'zh-CN' })
  const ctxZh = createPluginClientContext(createPluginClientHostPort(storeZh), 'test:plugin', 1)
  assert.equal(ctxZh.locale, 'zh-CN')
  assert.equal(ctxZh.translate({ en: 'Hi', 'zh-CN': '你好' }), '你好')
})

test('usePluginDocState：真实 store 驱动 loading -> error -> retry() -> ready 全链路', { timeout: 60_000 }, async (t) => {
  let attempt = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    attempt += 1
    if (attempt === 1) {
      return new Response(JSON.stringify({ error: { message: 'doc load boom' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ pluginId: 'test:plugin', name: 'status', value: { count: 7 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = originalFetch })

  const store = makeTestStore({
    plugins: [{ id: 'test:plugin', name: 'Test', version: '1.0.0', enabled: true, hooks: [], actions: [], tools: [] }],
  })
  const ctx = createPluginClientContext(createPluginClientHostPort(store), 'test:plugin', 1)
  const probe = mountProbe<PluginDocState<{ count: number }>>(store, ctx, () => usePluginDocState<{ count: number }>('status'))
  try {
    for (let i = 0; i < 20 && probe.result()?.status !== 'error'; i++) await act(async () => {})
    assert.equal(probe.result()?.status, 'error', '首次拉取失败必须进入 error 态')
    assert.match(probe.result()?.error ?? '', /doc load boom/)
    assert.equal(probe.result()?.data, undefined)

    act(() => {
      probe.result()!.retry()
    })
    for (let i = 0; i < 20 && probe.result()?.status !== 'ready'; i++) await act(async () => {})
    assert.equal(probe.result()?.status, 'ready', '手动 retry 绕过冷却并恢复 ready')
    assert.deepEqual(probe.result()?.data, { count: 7 })
    assert.equal(probe.result()?.error, undefined)
    assert.equal(attempt, 2)
  } finally {
    probe.unmount()
  }
})

test('ctx.openWorkbench(panelId, params)：自动补全短面板 ID、写入 workbenchParams 并在切页/关闭时清空', { timeout: 60_000 }, () => {
  const store = makeTestStore({})
  const ctx = createPluginClientContext(createPluginClientHostPort(store), 'builtin:workflow', 1)

  ctx.openWorkbench('tasks', { runId: 'wf_99', nodeId: 'step1' })
  assert.equal(store.getWorkbenchSlice().workbenchOpen, true)
  assert.equal(store.getWorkbenchSlice().workbenchTab, 'plugin:builtin:workflow/tasks')
  assert.deepEqual(store.getWorkbenchSlice().workbenchParams, {
    tab: 'plugin:builtin:workflow/tasks',
    conversationId: 1,
    params: { runId: 'wf_99', nodeId: 'step1' },
  })

  // 同 run 再次触发：生成新 params 对象引用以允许面板再次聚焦
  const prevParamsRef = store.getWorkbenchSlice().workbenchParams?.params
  ctx.openWorkbench('tasks', { runId: 'wf_99' })
  assert.notEqual(store.getWorkbenchSlice().workbenchParams?.params, prevParamsRef)

  // 手动切换页签或关闭工作台自动清理过期 workbenchParams
  store.actions.setWorkbenchTab('artifacts')
  assert.equal(store.getWorkbenchSlice().workbenchParams, null)

  ctx.openWorkbench('tasks', { runId: 'wf_100' })
  assert.deepEqual(store.getWorkbenchSlice().workbenchParams?.params, { runId: 'wf_100' })
  ctx.closeWorkbench()
  assert.equal(store.getWorkbenchSlice().workbenchOpen, false)
  assert.equal(store.getWorkbenchSlice().workbenchParams, null)
})

test('ctx.fetchRoute：宿主命名空间拼装、权威 Bearer 注入与覆写、二进制/流透传及路径越界拒绝', { timeout: 60_000 }, async (t) => {
  const captured: Array<{ url: string; method?: string; headers: Headers; body: BodyInit | null | undefined }> = []
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
    setStoredToken(null)
  })

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    captured.push({ url, method: init?.method, headers, body: init?.body })
    if (url.endsWith('/binary')) {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Bin': 'yes' },
      })
    }
    if (url.endsWith('/stream')) {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: chunk-1\n\n'))
          controller.enqueue(encoder.encode('data: chunk-2\n\n'))
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }
    if (url.endsWith('/missing')) {
      return new Response(JSON.stringify({ error: { code: 'not_found' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  const store = makeTestStore()
  const ctx = createPluginClientContext(createPluginClientHostPort(store), '@scope/my:plugin', 1)

  // 1. Authenticated GET with query string + authoritative Bearer injection overriding caller header without mutating caller Headers
  setStoredToken('host-secret-token')
  const callerHeaders = new Headers({
    Authorization: 'Bearer spoofed-by-plugin',
    'X-Custom': 'keep-me',
  })
  const okRes = await ctx.fetchRoute('/items/42?page=2&sort=desc', { headers: callerHeaders })
  assert.equal(okRes.status, 200)
  assert.deepEqual(await okRes.json(), { ok: true })
  assert.equal(captured.length, 1)
  assert.equal(captured[0]!.url, '/api/plugins/%40scope%2Fmy%3Aplugin/routes/items/42?page=2&sort=desc')
  assert.equal(captured[0]!.headers.get('Authorization'), 'Bearer host-secret-token', 'host token overwrites caller Authorization')
  assert.equal(captured[0]!.headers.get('X-Custom'), 'keep-me', 'caller non-auth headers are preserved')
  assert.equal(callerHeaders.get('Authorization'), 'Bearer spoofed-by-plugin', 'caller Headers instance must not be mutated')

  // 2. When no host token is stored, spoofed caller Authorization is stripped rather than forwarded
  setStoredToken(null)
  await ctx.fetchRoute('/public/ping', { headers: { authorization: 'Bearer spoofed' } })
  assert.equal(captured.length, 2)
  assert.equal(captured[1]!.headers.get('Authorization'), null, 'caller Authorization stripped when host has no token')

  // 3. FormData upload preserves body and does not inject a bogus Content-Type
  setStoredToken('host-secret-token')
  const form = new FormData()
  form.append('name', 'demo.bin')
  await ctx.fetchRoute('/upload', { method: 'POST', body: form })
  assert.equal(captured.length, 3)
  assert.equal(captured[2]!.method, 'POST')
  assert.ok(captured[2]!.body === form)
  assert.equal(captured[2]!.headers.get('Content-Type'), null, 'FormData upload keeps Content-Type unset for multipart boundary')
  assert.equal(captured[2]!.headers.get('Authorization'), 'Bearer host-secret-token')

  // 4. Raw binary, SSE ReadableStream, and non-2xx responses pass through untouched
  const binRes = await ctx.fetchRoute('/binary')
  assert.equal(binRes.headers.get('X-Bin'), 'yes')
  assert.deepEqual(new Uint8Array(await binRes.arrayBuffer()), new Uint8Array([1, 2, 3, 4]))

  const sseRes = await ctx.fetchRoute('/stream')
  assert.equal(sseRes.headers.get('Content-Type'), 'text/event-stream')
  assert.ok(sseRes.body !== null, 'SSE response preserves ReadableStream body')
  const reader = sseRes.body.getReader()
  const decoder = new TextDecoder()
  let collected = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    collected += decoder.decode(chunk.value, { stream: true })
  }
  assert.equal(collected, 'data: chunk-1\n\ndata: chunk-2\n\n')

  const notFoundRes = await ctx.fetchRoute('/missing')
  assert.equal(notFoundRes.status, 404, 'non-2xx Response is returned untouched (not auto-thrown)')

  // 5. Invalid / traversal paths reject before calling fetch
  const beforeInvalid = captured.length
  for (const badPath of ['../auth/status', '/a/../b', '//evil.test/x', 'relative', '/', '/items#frag', '/items\\a', '/a/%2e%2e/b']) {
    await assert.rejects(() => ctx.fetchRoute(badPath), /fetchRoute path/)
  }
  assert.equal(captured.length, beforeInvalid, 'rejected paths must never issue a fetch request')
})

test('ctx.fetchRoute：401 派发统一 helmx:unauthorized（不重复通知、保留原始响应且隔离过期/未登录态）', { timeout: 60_000 }, async (t) => {
  const originalFetch = globalThis.fetch
  let unauthorizedCount = 0
  let autoLogoutOnEvent = true

  const store = makeTestStore({ authenticated: true })
  const onUnauthorized = () => {
    unauthorizedCount += 1
    if (autoLogoutOnEvent) {
      store.actions.logout()
    }
  }
  window.addEventListener('helmx:unauthorized', onUnauthorized)

  t.after(() => {
    window.removeEventListener('helmx:unauthorized', onUnauthorized)
    globalThis.fetch = originalFetch
    setStoredToken(null)
  })

  let pendingFirst: ((res: Response) => void) | undefined
  let pendingSecond: ((res: Response) => void) | undefined
  let pendingStale: ((res: Response) => void) | undefined

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/concurrent-1')) {
      return await new Promise<Response>((resolve) => { pendingFirst = resolve })
    }
    if (url.endsWith('/concurrent-2')) {
      return await new Promise<Response>((resolve) => { pendingSecond = resolve })
    }
    if (url.endsWith('/stale-inflight')) {
      return await new Promise<Response>((resolve) => { pendingStale = resolve })
    }
    if (url.endsWith('/forbidden')) {
      return new Response(JSON.stringify({ error: { code: 'forbidden' } }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.endsWith('/ok')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'expired' } }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'X-Auth-Probe': 'raw-401' },
    })
  }) as typeof fetch

  const ctx = createPluginClientContext(createPluginClientHostPort(store), 'test:plugin', 1)

  // 1. Non-401 responses never dispatch helmx:unauthorized
  setStoredToken('tok-1')
  assert.equal((await ctx.fetchRoute('/ok')).status, 200)
  assert.equal((await ctx.fetchRoute('/forbidden')).status, 403)
  assert.equal(unauthorizedCount, 0)
  assert.equal(store.getAuthenticated(), true)

  // 2. Single 401 dispatches helmx:unauthorized once and returns the raw 401 Response untouched
  const res401 = await ctx.fetchRoute('/protected')
  assert.equal(unauthorizedCount, 1, '401 dispatches helmx:unauthorized once')
  assert.equal(store.getAuthenticated(), false, 'logout resets authenticated state')
  assert.equal(res401.status, 401)
  assert.equal(res401.headers.get('X-Auth-Probe'), 'raw-401')
  assert.deepEqual(await res401.json(), { error: { code: 'unauthorized', message: 'expired' } })

  // 3. Already unauthenticated 401 does not emit duplicate helmx:unauthorized
  const unauthRes = await ctx.fetchRoute('/public-check')
  assert.equal(unauthRes.status, 401)
  assert.equal(unauthorizedCount, 1, 'unauthenticated 401 must not re-dispatch helmx:unauthorized')

  // 4. Concurrent in-flight 401s after re-auth notify only once
  await store.onAuthenticated('tok-2')
  assert.equal(store.getAuthenticated(), true)
  const p1 = ctx.fetchRoute('/concurrent-1')
  const p2 = ctx.fetchRoute('/concurrent-2')
  while (pendingFirst === undefined || pendingSecond === undefined) {
    await Promise.resolve()
  }
  pendingFirst(new Response('expired-1', { status: 401 }))
  const r1 = await p1
  pendingSecond(new Response('expired-2', { status: 401 }))
  const r2 = await p2
  assert.equal(r1.status, 401)
  assert.equal(r2.status, 401)
  assert.equal(unauthorizedCount, 2, 'concurrent 401s coalesce into a single helmx:unauthorized')
  assert.equal(store.getAuthenticated(), false)

  // 5. Stale in-flight request from an earlier token must not log out a newer authenticated session
  await store.onAuthenticated('tok-old')
  const stalePromise = ctx.fetchRoute('/stale-inflight')
  while (pendingStale === undefined) {
    await Promise.resolve()
  }
  store.actions.logout()
  await store.onAuthenticated('tok-new')
  pendingStale(new Response('stale-expired', { status: 401 }))
  const staleRes = await stalePromise
  assert.equal(staleRes.status, 401)
  assert.equal(unauthorizedCount, 2, 'stale 401 from superseded token must not dispatch helmx:unauthorized')
  assert.equal(store.getAuthenticated(), true, 'new session remains authenticated')

  // 6. Fresh request with the new token still dispatches helmx:unauthorized on 401
  autoLogoutOnEvent = false
  const fresh401 = await ctx.fetchRoute('/protected')
  assert.equal(fresh401.status, 401)
  assert.equal(unauthorizedCount, 3, '401 under current token dispatches helmx:unauthorized')
})
