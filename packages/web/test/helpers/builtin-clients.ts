/**
 * 测试当前 worktree 内置插件（changes / swarm / triggers / magpie / tiers / orchestrator / plan / steps / port-forward）的真实 client
 * 编译产物（tsx 执行 kernel 编译器源码；浏览器 ESM 经 data: URL 导入，共享宿主
 * React/SDK）。默认只替换数据 hooks 以构造状态；上下文始终读取真实 Provider。
 */
import { useContext, useSyncExternalStore } from 'react'
import { fileURLToPath } from 'node:url'
import * as HelmxPluginClient from '@helmx/plugin-client'
import type { ConversationSummary, HostModelsSlice, HostNodesSlice } from '@helmx/protocol/browser'
import { importCompiledPluginClient, mountPluginNamespaceGlobals } from './plugin-namespace.js'

export interface BuiltinClientStubOptions {
  /** docName → doc 值（usePluginDoc 按 docName 路由返回）。 */
  docs?: Record<string, unknown>
  /** 非敏感插件配置投影（usePluginConfig 返回值，缺省在无真实宿主时回落空对象）。 */
  config?: Record<string, unknown>
  /** 宿主模型目录切片（显式提供时覆盖；缺省优先读真实 PluginClientHostContext）。 */
  hostModels?: HostModelsSlice
  /** 宿主计算节点切片（显式提供时覆盖；未显式覆盖且无真实宿主时返回 undefined）。 */
  hostNodes?: HostNodesSlice
  /** 会话摘要列表（useConversations 返回值，显式提供时覆盖宿主上下文）。 */
  conversations?: ReadonlyArray<ConversationSummary>
}

let stub: BuiltinClientStubOptions = {}
let realHooks = false

const NOOP_SUBSCRIBE = (): (() => void) => () => {}
const UNDEFINED_SNAPSHOT = (): undefined => undefined
const EMPTY_CONVERSATIONS: ConversationSummary[] = []
const EMPTY_CONVERSATIONS_SNAPSHOT = (): ConversationSummary[] => EMPTY_CONVERSATIONS
const EMPTY_CONFIG: Record<string, unknown> = Object.freeze({})

export function setBuiltinClientStub(options: BuiltinClientStubOptions = {}): void {
  stub = options
}

const NOOP_RETRY = (): void => {}

const sharedPluginClientNamespace = {
  ...HelmxPluginClient,
  usePluginDoc: (name: string) => (realHooks ? HelmxPluginClient.usePluginDoc(name) : stub.docs?.[name]),
  usePluginDocState: (name: string, pluginId?: string) =>
    realHooks
      ? HelmxPluginClient.usePluginDocState(name, pluginId)
      : { data: stub.docs?.[name], status: 'ready' as const, retry: NOOP_RETRY },
  usePluginSessionDoc: (name: string, options?: { conversationId?: number; pluginId?: string }) =>
    realHooks ? HelmxPluginClient.usePluginSessionDoc(name, options) : undefined,
  usePluginSessionDocState: (name: string, options?: HelmxPluginClient.PluginSessionDocOptions) =>
    realHooks
      ? HelmxPluginClient.usePluginSessionDocState(name, options)
      : { data: undefined, status: 'ready' as const, retry: NOOP_RETRY },
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
  useHostNodes: () => {
    const host = useContext(HelmxPluginClient.PluginClientHostContext)
    const live = useSyncExternalStore(
      host?.subscribeNodes ?? NOOP_SUBSCRIBE,
      host?.getNodes ?? UNDEFINED_SNAPSHOT,
      UNDEFINED_SNAPSHOT,
    )
    if (realHooks) return live
    return 'hostNodes' in stub ? stub.hostNodes : live
  },
  useConversations: () => {
    const host = useContext(HelmxPluginClient.PluginClientHostContext)
    const live = useSyncExternalStore(
      host?.subscribeConversations ?? NOOP_SUBSCRIBE,
      host?.getConversations ?? EMPTY_CONVERSATIONS_SNAPSHOT,
      EMPTY_CONVERSATIONS_SNAPSHOT,
    )
    if (realHooks) return live
    return stub.conversations !== undefined ? stub.conversations : live
  },
}

export function mountSharedPluginNamespaces(options: { realHooks?: boolean } = {}): void {
  realHooks = options.realHooks === true
  mountPluginNamespaceGlobals({ ...sharedPluginClientNamespace })
}

const CLIENT_ROOTS: Record<string, string> = {
  'builtin:changes': fileURLToPath(new URL('../../../plugins/src/changes/client', import.meta.url)),
  'builtin:swarm': fileURLToPath(new URL('../../../plugins/src/swarm/client', import.meta.url)),
  'builtin:triggers': fileURLToPath(new URL('../../../plugins/src/triggers/client', import.meta.url)),
  'builtin:magpie': fileURLToPath(new URL('../../../plugins/src/magpie/client', import.meta.url)),
  'builtin:tiers': fileURLToPath(new URL('../../../plugins/src/tiers/client', import.meta.url)),
  'builtin:orchestrator': fileURLToPath(new URL('../../../plugins/src/orchestrator/client', import.meta.url)),
  'builtin:plan': fileURLToPath(new URL('../../../plugins/src/plan/client', import.meta.url)),
  'builtin:steps': fileURLToPath(new URL('../../../plugins/src/steps/client', import.meta.url)),
  'builtin:port-forward': fileURLToPath(new URL('../../../plugins/src/port-forward/client', import.meta.url)),
}

export async function importBuiltinClientModule(
  pluginId: keyof typeof CLIENT_ROOTS | string,
  moduleRef = 'index.tsx',
): Promise<Record<string, unknown>> {
  const root = CLIENT_ROOTS[pluginId]
  if (root === undefined) throw new Error(`未知内置插件 clientRoot：${pluginId}`)
  return importCompiledPluginClient(pluginId, root, moduleRef)
}
