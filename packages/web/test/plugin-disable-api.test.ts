/**
 * 插件治理 API 客户端契约测试：
 * 1. pluginsApi.disable 默认不传 body（兼容既有 POST 无请求体语义）；
 * 2. opts.force === true 时向 /disable 传入 { force: true } 请求体；
 * 3. PluginConfigResponse 类型通道（sources 可选透传，运行时仅校验请求路径）。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'


const { ApiClientError, artifactsApi, conversationsApi, pluginsApi } = await import('../src/lib/api.js')

interface CapturedRequest {
  path: string
  method: string
  body?: string
}

function installFetchCapture(): { requests: CapturedRequest[]; restore: () => void } {
  const requests: CapturedRequest[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push({
      path: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return {
    requests,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

test('pluginsApi.disable：未传 opts 时不携带请求体', { timeout: 60_000 }, async () => {
  const { requests, restore } = installFetchCapture()
  try {
    await pluginsApi.disable('builtin:workflow')
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.path, '/api/plugins/builtin%3Aworkflow/disable')
    assert.equal(requests[0]?.method, 'POST')
    assert.equal(requests[0]?.body, undefined, '默认停用不传 body')
  } finally {
    restore()
  }
})

test('pluginsApi.disable：force === true 时携带 { force: true } 请求体', { timeout: 60_000 }, async () => {
  const { requests, restore } = installFetchCapture()
  try {
    await pluginsApi.disable('builtin:herdr', { force: true })
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.path, '/api/plugins/builtin%3Aherdr/disable')
    assert.equal(requests[0]?.method, 'POST')
    assert.equal(requests[0]?.body, JSON.stringify({ force: true }))
  } finally {
    restore()
  }
})

test('pluginsApi.disable：显式 force === false 时不携带请求体', { timeout: 60_000 }, async () => {
  const { requests, restore } = installFetchCapture()
  try {
    await pluginsApi.disable('builtin:triggers', { force: false })
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.body, undefined, 'force: false 等价于未传')
  } finally {
    restore()
  }
})

test('独立 Bearer 二进制 fetch（uploadArtifact / fetchWorkspaceFileBlob / artifactsApi.fetchBlob）401 统一派发 helmx:unauthorized', { timeout: 60_000 }, async () => {
  const originalFetch = globalThis.fetch
  const events: string[] = []
  const onUnauthorized = (ev: Event): void => {
    events.push(ev.type)
  }
  window.addEventListener('helmx:unauthorized', onUnauthorized)
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'token expired' } }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
  try {
    const file = new File([new Uint8Array([1, 2, 3])], 'demo.bin', { type: 'application/octet-stream' })
    await assert.rejects(
      () => conversationsApi.uploadArtifact(7, file),
      (err: unknown) => err instanceof ApiClientError && err.status === 401,
    )
    await assert.rejects(
      () => conversationsApi.fetchWorkspaceFileBlob(7, 'README.md'),
      (err: unknown) => err instanceof ApiClientError && err.status === 401,
    )
    await assert.rejects(
      () => artifactsApi.fetchBlob('art-1'),
      (err: unknown) => err instanceof ApiClientError && err.status === 401,
    )
    assert.deepEqual(
      events,
      ['helmx:unauthorized', 'helmx:unauthorized', 'helmx:unauthorized'],
      '三条独立二进制 Bearer 通道收到 401 均须触发统一 helmx:unauthorized 事件',
    )
  } finally {
    window.removeEventListener('helmx:unauthorized', onUnauthorized)
    globalThis.fetch = originalFetch
  }
})
