/**
 * Conversation pane: top bar (title / actions), timeline + outline, Composer (with AskDock),
 * and the destructive confirmations. Data normalization lives in the `conversation-pane/`
 * hooks; the top-bar pieces and dialogs are the sibling components under the same directory.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationAttachmentRef } from '@helmx/protocol/browser'
import { isConversationArchived } from './archive-model.js'
import { collectEnabledPluginIds, isHumanSelectableProfile } from '../shell/conversation-status-model.js'
import { isConversationArchivable } from '../shell/sidebar-model.js'
import {
  useConversationArtifacts,
  useConversationDetail,
  useConversationSummary,
  useLoadError,
  usePlugins,
  useProfilesSlice,
  useStoreActions,
  useWorkbenchState,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useStableCallback } from '../lib/use-stable-callback.js'
import { usePaneSplitToggle } from '../ui/use-pane-split-toggle.js'
import { Composer } from './Composer.js'
import { openStandbyWithFocus } from './standby-focus.js'
import { sendingPendingVisible } from './composer-model.js'
import { ConversationTimeline } from './ConversationTimeline.js'
import { resolveActiveWorkbenchTab, summarizeWorkbenchBadge } from './workbench-model.js'
import { useWorkbenchTabs } from './workbench-hooks.js'
import type { EditRequestTarget } from './timeline-model.js'
import { ConversationPaneActions } from './conversation-pane/ConversationPaneActions.js'
import {
  ConversationConfirmDialogs,
  type ConversationConfirmAction,
} from './conversation-pane/ConversationConfirmDialogs.js'
import { ConversationDrawerEnvBar } from './conversation-pane/ConversationDrawerEnvBar.js'
import {
  ConversationPaneError,
  ConversationPaneLoading,
} from './conversation-pane/ConversationPaneStates.js'
import { ConversationTitleGroup } from './conversation-pane/ConversationTitleGroup.js'
import { useConversationPaneActions } from './conversation-pane/use-conversation-pane-actions.js'
import { useConversationPaneOutline } from './conversation-pane/use-conversation-pane-outline.js'
import { useConversationPaneTimeline } from './conversation-pane/use-conversation-pane-timeline.js'

/** Prefill request handed to the Composer (edit-and-resend / starter). */
interface PanePrefill {
  text: string
  entryId?: number
  attachments?: ConversationAttachmentRef[]
  tick: number
  onlyIfEmpty?: boolean
}

export interface ConversationPaneProps {
  conversationId: number
  isSplit?: boolean
  onCloseSplit?: () => void
  isDrawer?: boolean
  onCloseDrawer?: () => void
  /**
   * Keep-alive staging flag (window pool): false while the pane lives inside a hidden
   * <Activity>. Hidden panes close ephemeral overlays (menus, confirm dialogs, rename input)
   * so waking never resurrects stale chrome; default true for split/drawer panes.
   */
  staged?: boolean
}

/** 会话顶栏 + 时间线 + AskDock(Composer 内) + Composer 微操舱。 */
export function ConversationPane({ conversationId, isSplit, onCloseSplit, isDrawer, onCloseDrawer, staged = true }: ConversationPaneProps) {
  const detail = useConversationDetail(conversationId)
  const summary = useConversationSummary(conversationId)
  const parentConversationId = summary?.parentConversationId ?? detail?.parentConversationId
  const parentSummary = useConversationSummary(parentConversationId)
  const convArtifacts = useConversationArtifacts(conversationId)
  const detailError = useLoadError(`conversation:${conversationId}`)
  const { profiles } = useProfilesSlice()
  const plugins = usePlugins()
  const { workbenchOpen, workbenchTab } = useWorkbenchState()
  const { loadConversationDetail, openTarget, openWorkbenchDrawer } = useStoreActions()
  const { t } = useWebLocale()
  const conversation = summary ?? detail
  const isWorking = conversation?.status === 'working'
  const isCompacting = conversation?.contextUsage?.compacting === true
  const { detailEntries, hasEarlierHistory, timelineItems, live } = useConversationPaneTimeline(
    conversationId,
    detail,
    staged,
    isWorking,
    isCompacting,
  )
  const outline = useConversationPaneOutline(conversationId, timelineItems, hasEarlierHistory, conversation?.status)
  const actions = useConversationPaneActions(conversationId, conversation)
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const [prefill, setPrefill] = useState<PanePrefill | null>(null)
  const [sendingInFlight, setSendingInFlight] = useState(false)
  const [confirmAction, setConfirmAction] = useState<ConversationConfirmAction | null>(null)
  const prefillTickRef = useRef(0)
  const prevConversationIdRef = useRef(conversationId)
  const { isSplitActive, toggleSplit } = usePaneSplitToggle({
    isSplit,
    onCloseSplit,
    getSplitTarget: () => ({ kind: 'conversation', conversationId }),
  })

  useEffect(() => {
    if (detail === undefined) {
      void loadConversationDetail(conversationId, true)
    }
  }, [conversationId, detail, loadConversationDetail])

  // 切换会话时关闭更多菜单、重置大纲滚动状态与清空未消费的 prefill（组件复用时也保持确定语义）
  useEffect(() => {
    if (prevConversationIdRef.current === conversationId) return
    prevConversationIdRef.current = conversationId
    setMoreOpen(false)
    outline.close()
    setPrefill(null)
  }, [conversationId])

  // 失去舞台（窗口被 <Activity> 隐藏）：关闭瞬态浮层（更多菜单、确认弹窗、重命名），
  // 避免唤醒时复活过期 chrome；锚定 Popover/Dropdown 由 Radix 的 dismiss 层自行关闭。
  useEffect(() => {
    if (staged) return
    setMoreOpen(false)
    outline.onOpenChange(false)
    setConfirmAction(null)
    setRenaming(false)
  }, [staged])

  const requestEdit = useCallback((target: EditRequestTarget): void => {
    // prefill 绑定会话 id：即使未来 Pane 复用不重挂载，旧会话的编辑目标也不会注入新会话 Composer
    if (target.text.trim() === '' && target.entryId === undefined) {
      setPrefill(null)
      return
    }
    prefillTickRef.current += 1
    setPrefill({ ...target, tick: prefillTickRef.current })
  }, [])

  // 空白会话引导词：仅回填草稿（onlyIfEmpty 交 Composer 原子保护，非空草稿不覆盖）
  const requestStarter = useCallback((text: string): void => {
    prefillTickRef.current += 1
    setPrefill({ text, tick: prefillTickRef.current, onlyIfEmpty: true })
  }, [])

  // 新话题：进入该智能体待命页并继承当前会话环境（远端节点/目录不回落本机）；
  // 首次发送才创建会话，不再预建空会话。
  const startNewThread = useStableCallback((opts?: { flush?: boolean }): void => {
    if (conversation === undefined) return
    const targetNodeId = conversation.nodeId || 'local'
    openStandbyWithFocus(
      { panel: isSplit ? 'split' : 'primary', profileId: conversation.profileId },
      () =>
        openTarget(
          {
            kind: 'agent',
            profileId: conversation.profileId,
            ...(targetNodeId !== 'local' ? { nodeId: targetNodeId } : {}),
            ...(conversation.cwd !== '' ? { cwd: conversation.cwd } : {}),
          },
          isSplit ? { split: true } : undefined,
        ),
      opts,
    )
  })

  // 工作台汇总角标：内置产物计数 + 各插件面板 badge（从 public doc 动态提取）。
  const workbenchTabs = useWorkbenchTabs(conversationId, conversation)
  const workbenchBadge = summarizeWorkbenchBadge(workbenchTabs)
  const hasWorkbenchPanel = workbenchTabs.some((tab) => tab.id !== 'artifacts')
  const hasAnyArtifacts = Array.isArray(convArtifacts) && convArtifacts.length > 0

  if (detailError) {
    return (
      <ConversationPaneError
        conversationId={conversationId}
        detailError={detailError}
        isSplit={isSplit}
        onCloseSplit={onCloseSplit}
        isDrawer={isDrawer}
        onCloseDrawer={onCloseDrawer}
        onRetry={() => void loadConversationDetail(conversationId, true)}
      />
    )
  }

  if (conversation === undefined) {
    return (
      <ConversationPaneLoading
        conversationId={conversationId}
        isSplit={isSplit}
        onCloseSplit={onCloseSplit}
        isDrawer={isDrawer}
        onCloseDrawer={onCloseDrawer}
      />
    )
  }

  const compactPending = actions.actionPending === 'compact' || isCompacting
  const currentNodeId = conversation.nodeId || 'local'
  const parentTitle = parentSummary?.title.trim() || t('conv.pane.titleFallback', { id: parentConversationId ?? 0 })
  const openParentConversation = (): void => {
    if (parentConversationId === undefined) return
    openTarget(
      { kind: 'conversation', conversationId: parentConversationId },
      isSplit ? { split: true } : undefined,
    )
  }
  const profile = profiles.find((p) => p.id === conversation.profileId)
  const profileStarters = profile !== undefined && profile.starters !== undefined && profile.starters.length > 0 ? profile.starters : undefined
  const enabledPluginIds = collectEnabledPluginIds(plugins)
  const canCreateThread = profile !== undefined &&
    isHumanSelectableProfile(profile, enabledPluginIds) &&
    (conversation.ownedBy ?? 'human') === 'human'
  const archived = isConversationArchived(conversation)
  const canManageArchive = isConversationArchivable(conversation)
  const commitTitle = (): void => {
    setRenaming(false)
    void actions.saveTitle(titleDraft)
  }
  const openWorkbench = (): void => {
    // 打开首个可用页签；已打开时保持当前有效页签，并显式绑定当前会话。
    const target = resolveActiveWorkbenchTab(
      workbenchOpen && !isDrawer ? workbenchTab : undefined,
      workbenchTabs,
    )
    openWorkbenchDrawer({ tab: target, conversationId })
  }
  const openFullscreen = (): void => {
    onCloseDrawer?.()
    openTarget({ kind: 'conversation', conversationId })
  }

  return (
    <div className="helmx-pane">
      <header className="pane-topbar conversation-topbar">
        <ConversationTitleGroup
          conversation={conversation}
          currentNodeId={currentNodeId}
          renaming={renaming}
          titleDraft={titleDraft}
          onTitleDraftChange={setTitleDraft}
          onRenameCommit={commitTitle}
          onRenameCancel={() => setRenaming(false)}
          parentConversationId={parentConversationId}
          parentTitle={parentTitle}
          onOpenParent={openParentConversation}
        />
        <ConversationPaneActions
          conversation={conversation}
          isSplit={isSplit}
          isDrawer={isDrawer}
          isCompacting={isCompacting}
          compactPending={compactPending}
          actionPending={actions.actionPending}
          canCreateThread={canCreateThread}
          archived={archived}
          canManageArchive={canManageArchive}
          outline={outline}
          timelineHasItems={timelineItems.length > 0}
          workbench={{
            tabs: workbenchTabs,
            badge: workbenchBadge,
            hasPanel: hasWorkbenchPanel,
            active: workbenchOpen && !isDrawer,
            hasAnyArtifacts,
          }}
          split={{ isSplitActive, toggleSplit }}
          moreOpen={moreOpen}
          onMoreOpenChange={setMoreOpen}
          runAction={actions.runAction}
          onRename={() => {
            setTitleDraft(conversation.title)
            setRenaming(true)
          }}
          onNewThread={() => startNewThread()}
          onOpenWorkbench={openWorkbench}
          onOpenFullscreen={openFullscreen}
          onRequestReset={() => setConfirmAction('reset')}
          onRequestDelete={() => setConfirmAction('delete')}
          onCloseSplit={onCloseSplit}
          onCloseDrawer={onCloseDrawer}
        />
      </header>
      {isDrawer ? <ConversationDrawerEnvBar conversation={conversation} currentNodeId={currentNodeId} /> : null}

      <ConversationTimeline
        conversation={conversation}
        detailEntries={detailEntries}
        timelineItems={timelineItems}
        sendingPending={sendingPendingVisible(sendingInFlight, conversation.status)}
        outlineOpen={outline.open}
        outlineScrollRequest={outline.scrollRequest}
        onActiveOutlineChange={outline.onActiveAnchorChange}
        {...(live !== undefined ? { live } : {})}
        starters={profileStarters}
        onRequestEdit={requestEdit}
        onRequestStarter={requestStarter}
      />

      <Composer key={`composer-${conversation.id}`} conversation={conversation} prefill={prefill} onSendingChange={setSendingInFlight} onNewThread={startNewThread} isSplit={isSplit} staged={staged} isDrawer={isDrawer} />

      <ConversationConfirmDialogs
        conversationId={conversationId}
        confirmAction={confirmAction}
        onConfirmActionChange={setConfirmAction}
        onConfirmReset={() => void actions.resetContext()}
        onConfirmDelete={() => void actions.deleteConversation()}
      />
    </div>
  )
}
