/**
 * SDK 宿主端口桥：把真实 HelmxExternalStore 适配为 @helmx/plugin-client 稳定宿主句柄。
 *
 * - 零 store 顶层订阅：本组件仅按 `[store]` 构造一次引用恒定的 `PluginClientHostPort`
 *   并同时注入 `PluginClientHostContext` 与 `PluginClientHostHandlesContext`；
 * - 流式 `conversationLives` token 帧及其他域更新绝不触发桥本身重渲染，所有响应式
 *   读取由 SDK hooks 通过按域/按 key 的 `useSyncExternalStore` 订阅精确收敛；
 * - 独立成模块以保持「无 react-dom 依赖」的静态导入图——测试 helper
 *   （helpers/host-store.tsx）静态引入本模块不会在 happy-dom 注册前加载
 *   react-dom/client；生产 HelmxStoreProvider 与测试共用同一实现。
 */
import { useMemo } from 'react'
import type { PluginClientHostPort } from '@helmx/plugin-client'
import { PluginClientHostContext, PluginClientHostHandlesContext } from '@helmx/plugin-client'
import type { HelmxExternalStore } from './helmx-store.js'
import { createPluginClientHostPort } from './plugin-client-host.js'

export function PluginClientHostBridge({ store, children }: { store: HelmxExternalStore; children: React.ReactNode }) {
  const port = useMemo<PluginClientHostPort>(() => createPluginClientHostPort(store), [store])
  return (
    <PluginClientHostHandlesContext.Provider value={port}>
      <PluginClientHostContext.Provider value={port}>{children}</PluginClientHostContext.Provider>
    </PluginClientHostHandlesContext.Provider>
  )
}
