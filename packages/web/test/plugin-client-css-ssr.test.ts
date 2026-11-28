/**
 * 插件 client 模块样式 SSR 无 DOM 契约测试：
 * - 运行在无 document 的纯 Node 环境（node-shared），验证样式跳过注入但缓存与校验照常执行。
 */
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import {
  getCachedClientComponent,
  loadPluginClientModule,
  PluginClientError,
  resetPluginClientCache,
  seedPluginClientModule,
} from '../src/lib/plugin-client.js'

const originalFetch = globalThis.fetch
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

describe('plugin-client-css-ssr', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
    resetPluginClientCache()
  }, { timeout: 60_000 })

  let moduleSeq = 0
  let nextDataUrl: string | undefined
  let nextCode = ''
  let nextHash = ''

  function installDataUrlModuleServing(): void {
    globalThis.fetch = async () => new Response(nextCode, { headers: { 'x-helmx-client-hash': nextHash } })
    URL.createObjectURL = (() => {
      const url = nextDataUrl
      if (url === undefined) throw new Error('测试未预置模块 data URL，出现意外的重复 import')
      nextDataUrl = undefined
      return url
    }) as typeof URL.createObjectURL
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
  }

  function serveModule(code: string, hash: string): void {
    nextHash = hash
    nextCode = code
    nextDataUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(`/*helmx-css-ssr-${++moduleSeq}*/\n${code}`)}`
  }

  test('SSR 无 document：合法跳过样式注入且不报错，缓存照常发布', { timeout: 60_000 }, async () => {
    assert.equal(typeof document, 'undefined', 'SSR 测试必须运行于无 document 的纯 Node 环境')
    installDataUrlModuleServing()
    const PANEL_EXPORT = 'export function Panel() { return "panel" }\n'
    serveModule(`export const __helmxClientCss = ".ssr { color: red }"\n${PANEL_EXPORT}`, 'h1')
    const loaded = await loadPluginClientModule('p', 'index.tsx')
    assert.equal(loaded.module.__helmxClientCss, '.ssr { color: red }')
    assert.equal(getCachedClientComponent('p', 'index.tsx', 'Panel'), loaded.module.Panel, 'SSR 下 resolved 照常发布')
    seedPluginClientModule('q', 'index.tsx', { Panel: () => null, __helmxClientCss: '.q { color: red }' })
    serveModule(`export const __helmxClientCss = 42\n${PANEL_EXPORT}`, 'invalid-ssr')
    await assert.rejects(
      loadPluginClientModule('bad-ssr', 'index.tsx'),
      (error: unknown) => error instanceof PluginClientError && error.code === 'client_module_css_invalid',
      'SSR 只跳过 DOM 写入，不能跳过产物契约校验',
    )
    assert.equal(getCachedClientComponent('bad-ssr', 'index.tsx', 'Panel'), undefined)
    assert.throws(
      () => seedPluginClientModule('bad-seed', 'index.tsx', { Panel: () => null, __helmxClientCss: 42 }),
      (error: unknown) => error instanceof PluginClientError && error.code === 'client_module_css_invalid',
    )
  })
})
