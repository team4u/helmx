/**
 * 测试当前 worktree 内置插件（swarm / superagent / triggers / magpie / apps）的真实 client
 * 编译产物（tsx 执行 kernel 编译器源码；浏览器 ESM 经 data: URL 导入，共享宿主
 * React/SDK）。默认只替换数据 hooks 以构造状态；上下文始终读取真实 Provider。
 */
import { useContext, useSyncExternalStore } from 'react'
import { fileURLToPath } from 'node:url'
import * as HelmxPluginClient from '@helmx/plugin-client'
import type { HostModelsSlice } from '@helmx/protocol/browser'
import { importCompiledPluginClient, mountPluginNamespaceGlobals } from './plugin-namespace.js'

export interface BuiltinClientStubOptions {
  /** docName → doc 值（usePluginDoc 按 docName 路由返回）。 */
  docs?: Record<string, unknown>
  /** 非敏感插件配置投影（usePluginConfig 返回值，缺省在无真实宿主时回落空对象）。 */
  config?: Record<string, unknown>
  /** 宿主模型目录切片（显式提供时覆盖；缺省优先读真实 PluginClientHostContext）。 */
  hostModels?: HostModelsSlice
}

let stub: BuiltinClientStubOptions = {}
let realHooks = false

const NOOP_SUBSCRIBE = (): (() => void) => () => {}
const UNDEFINED_SNAPSHOT = (): undefined => undefined
const EMPTY_CONFIG: Record<string, unknown> = Object.freeze({})

export function setBuiltinClientStub(options: BuiltinClientStubOptions = {}): void {
  stub = options
}

const sharedPluginClientNamespace = {
  ...HelmxPluginClient,
  usePluginDoc: (name: string) => (realHooks ? HelmxPluginClient.usePluginDoc(name) : stub.docs?.[name]),
  usePluginSessionDoc: (name: string, options?: { conversationId?: number }) =>
    realHooks ? HelmxPluginClient.usePluginSessionDoc(name, options) : undefined,
  usePluginConfig: () => {
    const host = useContext(HelmxPluginClient.PluginClientHostContext)
    const ctx = useContext(HelmxPluginClient.PluginClientContext)
    const live = useSyncExternalStore(
      host?.subscribePlugins ?? NOOP_SUBSCRIBE,
      () => {
        const plugin = host?.getPluginsSnapshot().plugins.find((item) => item.id === ctx?.pluginId)
        return (plugin?.publicConfig ?? EMPTY_CONFIG) as Record<string, unknown>
      },
      () => EMPTY_CONFIG,
    )
    if (realHooks || (stub.config === undefined && host !== null && ctx !== null)) {
      return live
    }
    return stub.config ?? EMPTY_CONFIG
  },
  useHostModels: () => {
    const host = useContext(HelmxPluginClient.PluginClientHostContext)
    const live = useSyncExternalStore(
      host?.subscribeModels ?? NOOP_SUBSCRIBE,
      host?.getModels ?? UNDEFINED_SNAPSHOT,
      UNDEFINED_SNAPSHOT,
    )
    if (realHooks) return live
    return stub.hostModels !== undefined ? stub.hostModels : live
  },
}

export function mountSharedPluginNamespaces(options: { realHooks?: boolean } = {}): void {
  realHooks = options.realHooks === true
  mountPluginNamespaceGlobals({ ...sharedPluginClientNamespace })
}

const CLIENT_ROOTS: Record<string, string> = {
  'builtin:swarm': fileURLToPath(new URL('../../../plugins/src/swarm/client', import.meta.url)),
  'builtin:superagent': fileURLToPath(new URL('../../../plugins/src/superagent/client', import.meta.url)),
  'builtin:triggers': fileURLToPath(new URL('../../../plugins/src/triggers/client', import.meta.url)),
  'builtin:magpie': fileURLToPath(new URL('../../../plugins/src/magpie/client', import.meta.url)),
  'builtin:apps': fileURLToPath(new URL('../../../plugins/src/apps/client', import.meta.url)),
  'builtin:tiers': fileURLToPath(new URL('../../../plugins/src/tiers/client', import.meta.url)),
}

export async function importBuiltinClientModule(
  pluginId: keyof typeof CLIENT_ROOTS | string,
  moduleRef = 'index.tsx',
): Promise<Record<string, unknown>> {
  const root = CLIENT_ROOTS[pluginId]
  if (root === undefined) throw new Error(`未知内置插件 clientRoot：${pluginId}`)
  return importCompiledPluginClient(pluginId, root, moduleRef)
}
