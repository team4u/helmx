/**
 * 宿主端口适配器：把真实 HelmxExternalStore 适配为 @helmx/plugin-client 的
 * 稳定句柄 PluginClientHostPort（SDK 唯一宿主注入面；SDK 不反向依赖任何 web 实现）。
 *
 * - 每个 store 实例构造一次稳定句柄，永不随流式帧或业务状态更新重建；
 * - 所有数据读取均以按域/按 key 的 `get* + subscribe*` 订阅对暴露给 SDK 的
 *   `useSyncExternalStore` hooks，`conversationLives` token 帧仅唤醒订阅该
 *   精确会话 live 流的组件，彻底阻断无关插件与 SDK 控件的级联重渲染；
 * - 模型目录（assetsLoaded 三态）、URL Hash 屏位置（screenLocation）、
 *   宿主标准后台在途快照（conversationBackground）全部绑定真实 store 派生切片；
 * - submitConversationInput 走真实 conversationsApi.submitInput（origin: agent）；
 * - slots：匹配/排序复用 plugin-slot-model（宿主逻辑），单项渲染委托 PluginUiView；
 * - markdown：注入宿主标准 MarkdownView / CodeBlockView（产物链接、代码块扩展、
 *   流式分块），SDK 侧 MarkdownView/CodeBlockView 仅做端口转发。
 */
import { createElement } from 'react'
import { createLocaleTranslator, type HelmxLocale, type LocaleTranslator } from '@helmx/protocol/browser'
import type { PluginClientHostPort, PluginSlotPortItem } from '@helmx/plugin-client'
import { assetsApi, conversationsApi } from './api.js'
import type { HelmxExternalStore } from './helmx-store.js'
import { MarkdownView, CodeBlockView } from '../conversation/MarkdownView.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { collectSlotItems } from '../ui/plugin-slot-model.js'
import { matchesUiScope } from './types.js'

/** 从真实 HelmxExternalStore 构造引用稳定的宿主端口句柄（单 store 生命周期内构造一次即可）。 */
export function createPluginClientHostPort(store: HelmxExternalStore): PluginClientHostPort {
  let cachedLocale: HelmxLocale | undefined
  let cachedTranslator: LocaleTranslator | undefined
  const getTranslate = (): LocaleTranslator => {
    const locale = store.getLocale()
    if (cachedTranslator === undefined || cachedLocale !== locale) {
      cachedLocale = locale
      cachedTranslator = createLocaleTranslator(locale)
    }
    return cachedTranslator
  }

  return {
    // ---- Auth & UI preferences ----
    getAuthenticated: store.getAuthenticated,
    subscribeAuthenticated: (listener) => store.subscribeDomain('authenticated', listener),
    getTheme: store.getTheme,
    getLocale: store.getLocale,
    getTranslate,
    subscribePrefs: (listener) => {
      const offTheme = store.subscribeDomain('theme', listener)
      const offLocale = store.subscribeDomain('locale', listener)
      return () => {
        offTheme()
        offLocale()
      }
    },

    // ---- Conversations & keyed per-conversation slices ----
    getConversations: store.getConversations,
    subscribeConversations: (listener) => store.subscribeDomain('conversations', listener),
    getConversationSummary: store.getConversationSummary,
    subscribeConversationSummary: store.subscribeConversationSummary,
    getConversationDetail: store.getConversationDetail,
    subscribeConversationDetail: store.subscribeConversationDetail,
    getConversationLive: store.getConversationLive,
    subscribeConversationLive: store.subscribeConversationLive,
    getConversationPendingAsks: store.getConversationPendingAsks,
    subscribeConversationPendingAsks: store.subscribeConversationPendingAsks,
    getLoadError: store.getLoadError,
    subscribeLoadError: store.subscribeLoadError,

    // ---- Plugin registry & Screen contributions ----
    getPluginsSnapshot: store.getPluginsSnapshot,
    subscribePlugins: (listener) => store.subscribeDomain('pluginsUi', listener),

    // ---- Model catalog (three-state assetsLoaded gate) ----
    getModels: store.getHostModelsSlice,
    subscribeModels: (listener) => store.subscribeDomain('hostModels', listener),
    refreshModels: async (): Promise<{ errors?: Record<string, string> }> => {
      const res = await assetsApi.refreshModels()
      await store.actions.refreshAssets()
      return { errors: res.errors ?? {} }
    },

    // ---- Plugin docs ----
    getPluginDocValue: store.getPluginDoc,
    subscribePluginDoc: store.subscribePluginDoc,
    ensurePluginDoc: store.actions.ensurePluginDoc,
    getPluginSessionDoc: store.actions.getPluginSessionDoc,
    subscribeSessionDoc: store.actions.subscribeSessionDoc,
    getSessionDocState: store.actions.getSessionDocState,

    // ---- Actions & input ----
    invokePluginAction: store.actions.invokePluginAction,
    submitConversationInput: async (conversationId, input) => {
      await conversationsApi.submitInput(conversationId, {
        text: input.text,
        origin: input.origin,
        ...(input.whenBusy !== undefined ? { whenBusy: input.whenBusy } : {}),
      })
    },
    // ---- Navigation & notifications ----
    openTarget: (target, options) =>
      store.actions.openTarget(target, options?.split === true ? { split: true } : undefined),
    openConversationDrawer: (conversationId) => store.actions.openConversationDrawer(conversationId),
    openArtifactPreview: (artifactId, conversationId) =>
      store.actions.setActiveModal({
        kind: 'artifact-preview',
        artifactId,
        ...(conversationId !== undefined ? { conversationId } : {}),
      }),
    setWorkbenchOpen: (open) => store.actions.setWorkbenchOpen(open),
    setWorkbenchTab: (tab) => store.actions.setWorkbenchTab(tab),
    notify: (message, tone, conversationId) =>
      store.actions.pushNotice({
        type: 'notification',
        level: tone === 'warning' ? 'warning' : tone === 'error' ? 'error' : 'info',
        title: message,
        ...(conversationId !== undefined ? { conversationId } : {}),
      }),

    // ---- Detail loading ----
    loadConversationDetail: store.actions.loadConversationDetail,

    // ---- Sub-slots ----
    slots: {
      collectItems: (qualifiedName, conversationId) => {
        const conversation =
          conversationId !== undefined
            ? (store.getConversationSummary(conversationId) ?? store.getConversationDetail(conversationId))
            : undefined
        return collectSlotItems(
          store.getGroupedUi().pluginSlots,
          qualifiedName,
          (scope) => matchesUiScope(conversation, scope),
        ).map((item): PluginSlotPortItem => ({ pluginId: item.pluginId, contributionId: item.spec.id, spec: item.spec }))
      },
      renderItem: (item, options) =>
        createElement(PluginUiView, {
          pluginId: item.pluginId,
          spec: item.spec,
          slotProps: options.slotProps,
          conversationId: options.conversationId,
          composer: options.composer,
          label: options.label,
        }),
    },

    // ---- Markdown rendering ----
    markdown: {
      view: MarkdownView,
      codeBlock: CodeBlockView,
    },
  }
}
