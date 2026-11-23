/**
 * 全局并发态势 Hook：把 attention-model 纯函数接进 store 现场。
 *
 * 单一职责：从 store 各切片（会话 / 插件 / Profile / workbench 面板 / 插件
 * doc / 当前导航目标）推导后台在途索引与态势微标，并自洽发现、按需加载
 * workbench badge doc——不依赖侧栏抽屉是否展开（移动端合着抽屉时后台
 * 任务也不失明；ensurePluginDoc 幂等，多处挂载不重复请求）。
 * 侧栏总览入口、移动端快捷总览按钮与会话总览页共用本 Hook 的同源输出。
 */
import { useEffect, useMemo } from 'react'
import {
  useActiveModal,
  useAuthConnection,
  useConversationBackgroundSlice,
  useConversations,
  useDrawerStack,
  useLocationTargets,
  usePlugins,
  useProfilesSlice,
  useStoreActions,
} from '../lib/store-context.js'
import type { ConversationBackgroundIndex } from './background-activity-model.js'
import {
  buildAttentionModel,
  collectViewedConversationIds,
  type GlobalAttentionIndicator,
} from './attention-model.js'

export interface GlobalAttentionValue {
  /** 全局态势微标（与 `#/overview` 三活跃桶 1:1 同源，仅 `unread_done` 做乐观已读）。 */
  indicator: GlobalAttentionIndicator
  /** 当前可见的主屏/分屏/顶层抽屉/关联弹窗目标，用于 `unread_done` 乐观已读与卡片绿点即时消除。 */
  viewedConversationIds: ReadonlySet<number>
  /** 后台在途索引（与会话行单灯位、插件 SDK 快照共享同一事实源）。 */
  background: ConversationBackgroundIndex
}

export function useGlobalAttention(): GlobalAttentionValue {
  const { authenticated } = useAuthConnection()
  const { primaryTarget, splitTarget } = useLocationTargets()
  const drawerStack = useDrawerStack()
  const activeModal = useActiveModal()
  const { badgeDocs, pendingBadgeDocs, snapshot: backgroundSnapshot } = useConversationBackgroundSlice()
  const conversations = useConversations()
  const plugins = usePlugins()
  const { profiles } = useProfilesSlice()
  const { ensurePluginDoc } = useStoreActions()

  const background = backgroundSnapshot.byConversation
  useEffect(() => {
    if (!authenticated) return
    for (const ref of badgeDocs) {
      if (pendingBadgeDocs.has(`${ref.pluginId}/${ref.doc}`)) {
        void ensurePluginDoc(ref.pluginId, ref.doc)
      }
    }
  }, [badgeDocs, pendingBadgeDocs, authenticated, ensurePluginDoc])

  const viewedConversationIds = useMemo(
    () => collectViewedConversationIds({ primaryTarget, splitTarget, drawerStack, activeModal }),
    [primaryTarget, splitTarget, drawerStack, activeModal],
  )
  const indicator = useMemo(
    () => buildAttentionModel({ conversations, background, profiles, plugins, viewedConversationIds }),
    [conversations, background, profiles, plugins, viewedConversationIds],
  )
  return { indicator, background, viewedConversationIds }
}
