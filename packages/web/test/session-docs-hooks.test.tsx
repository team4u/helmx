/**
 * usePluginSessionDoc / usePluginSessionDocDiagnostics / usePluginSessionDocState
 * 真实 React 消费路径测试（createRoot + act，happy-dom 宿主，不 mock hooks）：
 * - StrictMode 双挂载-卸载-重挂载后订阅恢复（refcount 正确重建流）；
 * - 多文档订阅合并为单条 `/api/session-docs/events?sub=...` 多路复用流；
 * - store 对象引用频繁更换（模拟全局 SSE 引发 Provider 重渲染）不退订重开流；
 * - delete 帧 value=initial（reset 语义）：单值 hook 一致暴露初值；
 * - 401 时请求携带 Bearer（鉴权修复回归）。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { describe, after, before, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  bindSessionDocRuntime,
  patchSessionDocTimings,
  resetSessionDocSubscriptions,
  resetSessionDocTimings,
  subscribeSessionDoc,
} from '../src/lib/session-docs.js'
import { usePluginSessionDocValue, usePluginSessionDocDiagnostics, usePluginSessionDocState, type PluginDocState } from '@helmx/plugin-client'
import { createPluginClientHostPort } from '../src/lib/plugin-client-host.js'
import { makeTestStore } from './helpers/store.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'
import { TestStoreProvider } from './helpers/host-store.js'
import type { HelmxStoreValue } from '../src/lib/types.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

describe("session-docs-hooks", () => {

  before(() => {
    patchSessionDocTimings({ subscribeDebounceMs: 0 })
  })
  after(() => {
    resetSessionDocTimings()
  }, { timeout: 60_000 })

  const multiplexFrame = (
    action: 'snapshot' | 'updated' | 'deleted',
    seq: number,
    doc: Record<string, unknown>,
    target?: Partial<{ pluginId: string; name: string; conversationId: number }>,
  ): string => {
    const pluginId = target?.pluginId ?? String(doc['pluginId'])
    const name = target?.name ?? String(doc['name'])
    const conversationId = target?.conversationId ?? Number(doc['conversationId'])
    return `event: ${action}\ndata: ${JSON.stringify({ action, pluginId, name, conversationId, seq, doc })}\n\n`
  }

  type ProbeResult = { value: unknown; diagnostics: { error?: string; connected: boolean; deleted: boolean; hasValue: boolean } }

  interface Harness {
    rerenderStore: (store: HelmxExternalStore) => void
    unmount: () => void
  }

  /** 真实 store 的 actions 即携带 session-docs 具名函数（与生产一致）。 */
  const stableSessionDocStore = (overrides: Partial<HelmxStoreValue> = {}): HelmxExternalStore =>
    makeTestStore({
      ...overrides,
    })

  /** 挂载多探针组件（单值 hook + 诊断 hook + 伴随订阅），收集最新结果。 */
  function mountProbes(
    initialStore: HelmxExternalStore,
    opts: { strict?: boolean; extraDocName?: string } = {},
  ): { reads: () => ProbeResult; harness: Harness } {
    const reads: ProbeResult[] = []
    function Probes(): React.ReactNode {
      reads.push({
        value: usePluginSessionDocValue('runs', { pluginId: 'builtin:workflow', conversationId: 42 }),
        diagnostics: usePluginSessionDocDiagnostics('runs', { pluginId: 'builtin:workflow', conversationId: 42 }),
      })
      const extraValue = usePluginSessionDocValue(opts.extraDocName ?? 'stats', {
        pluginId: 'builtin:workflow',
        conversationId: 42,
      })
      void extraValue
      return e('div', null, 'probe')
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    let currentStore = initialStore
    const renderTree = (): React.ReactElement =>
      e(TestStoreProvider, { value: currentStore }, e(Probes))
    let root: Root | undefined
    const harness: Harness = {
      rerenderStore: (store: HelmxExternalStore) => {
        currentStore = store
        act(() => { root!.render(renderTree()) })
      },
      unmount: () => {
        act(() => { root!.unmount() })
      },
    }
    act(() => {
      root = createRoot(host)
      const tree = opts.strict ? e(React.StrictMode, undefined, renderTree()) : renderTree()
      root.render(tree)
    })
    return {
      reads: () => reads[reads.length - 1]!,
      harness,
    }
  }

  test('宿主端口在 store 变更后保留订阅与加载函数身份', { timeout: 60_000 }, () => {
    const store = stableSessionDocStore()
    const initial = createPluginClientHostPort(store)
    store.updateLive((prev) => ({ ...prev, conversations: [] }))
    const updated = createPluginClientHostPort(store)
    for (const key of ['subscribeSessionDoc', 'getSessionDocState', 'ensurePluginDoc', 'getPluginSessionDoc', 'loadConversationDetail', 'invokePluginAction'] as const) {
      assert.equal(updated[key], initial[key], key)
    }
  })

  test('StrictMode 挂载-卸载-重挂载：订阅恢复且引用稳定（不无限重渲染）', { timeout: 60_000 }, async () => {
    resetSessionDocSubscriptions()
    const restore = bindSessionDocRuntime(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode(
              multiplexFrame('snapshot', 1, { pluginId: 'builtin:workflow', name: 'runs', conversationId: 42, value: { n: 1 } }),
            ))
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    })
    const { reads, harness } = mountProbes(makeTestStore(), { strict: true, extraDocName: 'runs' })
    for (let i = 0; i < 30 && reads().value === undefined; i++) await act(async () => {})
    assert.deepEqual(reads().value, { n: 1 }, 'StrictMode 重挂载后订阅恢复')
    harness.unmount()
    restore()
  })

  test('store 引用更换（全局 SSE 重渲染）不退订重开流，且多文档合并为单条请求', { timeout: 60_000 }, async () => {
    resetSessionDocSubscriptions()
    let streamOpens = 0
    let capturedUrl = ''
    const restore = bindSessionDocRuntime(async (input: RequestInfo | URL) => {
      streamOpens++
      capturedUrl = String(input)
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode(
              multiplexFrame('snapshot', 1, { pluginId: 'builtin:workflow', name: 'runs', conversationId: 42, value: 1 }),
            ))
            controller.enqueue(encoder.encode(
              multiplexFrame('snapshot', 1, { pluginId: 'builtin:workflow', name: 'stats', conversationId: 42, value: 2 }),
            ))
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    })
    const { reads, harness } = mountProbes(stableSessionDocStore())
    for (let i = 0; i < 30 && reads().value === undefined; i++) await act(async () => {})
    assert.equal(reads().value, 1)
    assert.equal(streamOpens, 1, '同组件多个 sessionDoc hook 合并为单条多路复用流')
    const subs = new URL(capturedUrl, 'http://localhost').searchParams.getAll('sub').sort()
    assert.deepEqual(subs, ['builtin:workflow/runs/42', 'builtin:workflow/stats/42'])
    const before = streamOpens
    // 模拟全局 SSE 状态更新：Provider value 换新对象引用（具名函数保持稳定）
    harness.rerenderStore(stableSessionDocStore({ conversations: [] }))
    harness.rerenderStore(stableSessionDocStore({ sseConnected: false }))
    await act(async () => {})
    assert.equal(streamOpens, before, 'store 换引用未退订重开流')
    assert.equal(reads().value, 1, '值保持')
    harness.unmount()
    restore()
  })

  test('delete 帧初值契约：单值 hook 一致暴露 initial', { timeout: 60_000 }, async () => {
    resetSessionDocSubscriptions()
    const restore = bindSessionDocRuntime(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode(multiplexFrame('snapshot', 1, { pluginId: 'builtin:workflow', name: 'runs', conversationId: 42, value: { n: 5 } })))
            controller.enqueue(encoder.encode(multiplexFrame('deleted', 2, { pluginId: 'builtin:workflow', name: 'runs', conversationId: 42, value: { n: 0 }, deleted: true })))
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    })
    const { reads, harness } = mountProbes(makeTestStore(), { extraDocName: 'runs' })
    for (let i = 0; i < 30 && !reads().diagnostics.deleted; i++) await act(async () => {})
    assert.equal(reads().diagnostics.deleted, true, 'deleted 标记到达')
    assert.deepEqual(reads().value, { n: 0 }, '单值 hook 返回 delete 帧初值而非 undefined')
    harness.unmount()
    restore()
  })

  test('订阅请求携带 Bearer（鉴权回归）', { timeout: 60_000 }, async () => {
    resetSessionDocSubscriptions()
    let capturedAuth: string | undefined
    const restore = bindSessionDocRuntime(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode(
              multiplexFrame('snapshot', 1, { pluginId: 'builtin:workflow', name: 'runs', conversationId: 42, value: 1 }),
            ))
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    }, () => 'probe-token')
    const { reads, harness } = mountProbes(makeTestStore())
    for (let i = 0; i < 30 && reads().value === undefined; i++) await act(async () => {})
    assert.equal(reads().value, 1)
    assert.equal(capturedAuth, 'Bearer probe-token', 'hook 首次挂载即带 token（浏览器 401 退出回归）')
    harness.unmount()
    restore()
  })

  test('usePluginSessionDocState：三态 loading -> error -> retry() -> ready 端到端链路', { timeout: 60_000 }, async () => {
    resetSessionDocSubscriptions()
    let attempt = 0
    const restore = bindSessionDocRuntime(async () => {
      attempt += 1
      if (attempt === 1) {
        return new Response(JSON.stringify({ error: { message: 'session doc unavailable' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode(
              multiplexFrame('snapshot', 1, { pluginId: 'builtin:workflow', name: 'runs', conversationId: 42, value: { ok: true } }),
            ))
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    }, () => 'probe-token')
    let latest: PluginDocState<{ ok: boolean }> | undefined
    const readLatest = (): PluginDocState<{ ok: boolean }> | undefined => latest
    function StateProbe(): React.ReactNode {
      latest = usePluginSessionDocState<{ ok: boolean }>('runs', 42)
      return e('div', null, latest.status)
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    let root: Root | undefined
    act(() => {
      root = createRoot(host)
      root.render(e(TestStoreProvider, { value: makeTestStore() }, e(StateProbe)))
    })
    try {
      assert.equal(readLatest()?.status, 'loading', '首帧未到达前为 loading')
      for (let i = 0; i < 30 && readLatest()?.status !== 'error'; i++) await act(async () => {})
      assert.equal(readLatest()?.status, 'error', '4xx 不可用显式进入 error 态')
      assert.match(readLatest()?.error ?? '', /session doc unavailable/)
      act(() => {
        readLatest()!.retry()
      })
      for (let i = 0; i < 30 && readLatest()?.status !== 'ready'; i++) await act(async () => {})
      assert.equal(readLatest()?.status, 'ready', 'retry() 重建多路复用流后恢复 ready')
      assert.deepEqual(readLatest()?.data, { ok: true })
      assert.equal(attempt, 2)
    } finally {
      act(() => { root!.unmount() })
      host.remove()
      restore()
    }
  })
})
