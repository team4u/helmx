/**
 * Derived live-state indexes, plugin UI slices, and conversation background-activity
 * aggregation for HelmxExternalStore.
 */
import type {
  ArtifactMetadata,
  AskSpec,
  ConversationDetail,
  ConversationLive,
  ConversationSummary,
  HelmxLocale,
  HostNodesSlice,
  NodeInfo,
  PluginSummary,
  UsePluginsResult,
} from '@helmx/protocol/browser'
import {
  buildSameTreeWorkspacesMap,
  type WorkspaceConversationNode,
} from '../../conversation/workspace-file-url.js'
import { emptyLiveState, type LiveState } from '../live-state.js'
import { groupUiContributions, type GroupedUiSpecs } from '../types.js'
import { recomputeConversationBackgroundSlice } from './background-slice.js'
import {
  addChangedRecordKeys,
  addChangedStringKeys,
  EMPTY_BACKGROUND_INDEX,
  EMPTY_BADGE_DOCS,
  EMPTY_PENDING_ASKS,
  EMPTY_PENDING_BADGE_DOCS,
  emptyPlan,
  isSameAskArray,
} from './helpers.js'
import type {
  ConversationBackgroundSlice,
  NotifyPlan,
  PluginsUiSlice,
} from './types.js'

const EMPTY_TREE_WORKSPACES: ReadonlyArray<WorkspaceConversationNode> = Object.freeze([])

function isSameWorkspaceNodeList(
  prev: ReadonlyArray<WorkspaceConversationNode>,
  next: ReadonlyArray<WorkspaceConversationNode>,
): boolean {
  if (prev === next) return true
  if (prev.length !== next.length) return false
  for (let i = 0; i < prev.length; i += 1) {
    const a = prev[i]!
    const b = next[i]!
    if (a.id !== b.id || a.nodeId !== b.nodeId || a.cwd !== b.cwd) return false
  }
  return true
}

export class StoreLiveController {
  private liveState: LiveState = emptyLiveState()
  private groupedUi: GroupedUiSpecs = groupUiContributions([])
  private pluginsUiSlice: PluginsUiSlice
  private pluginsSnapshot: UsePluginsResult
  private hostNodesSlice: HostNodesSlice | undefined = undefined
  private summaryById = new Map<number, ConversationSummary>()
  private workspaceNodesById = new Map<number, WorkspaceConversationNode>()
  private treeWorkspacesByConv = new Map<number, ReadonlyArray<WorkspaceConversationNode>>()
  private pluginById = new Map<string, PluginSummary>()
  private pendingAsksByConv = new Map<number, AskSpec[]>()
  private backgroundBadgeDocKeys = new Set<string>()
  private conversationBackgroundSlice: ConversationBackgroundSlice = {
    badgeDocs: EMPTY_BADGE_DOCS,
    pendingBadgeDocs: EMPTY_PENDING_BADGE_DOCS,
    snapshot: { unknown: false, byConversation: EMPTY_BACKGROUND_INDEX },
  }
  private readonly emit: (plan: NotifyPlan) => void
  private readonly getLocale: () => HelmxLocale

  constructor(options: { onEmit: (plan: NotifyPlan) => void; getLocale: () => HelmxLocale }) {
    this.emit = options.onEmit
    this.getLocale = options.getLocale
    this.pluginsUiSlice = {
      plugins: this.liveState.plugins,
      uiContributions: this.liveState.uiContributions,
      groupedUi: this.groupedUi,
    }
    this.pluginsSnapshot = {
      plugins: this.liveState.plugins,
      screens: this.groupedUi.screens,
    }
  }

  getLiveState = (): LiveState => this.liveState
  getConversations = (): ConversationSummary[] => this.liveState.conversations
  getConversationDetailsMap = (): Record<number, ConversationDetail> => this.liveState.conversationDetails
  getConversationLivesMap = (): Record<number, ConversationLive> => this.liveState.conversationLives
  getPendingAsks = (): AskSpec[] => this.liveState.pendingAsks
  getPlugins = (): PluginSummary[] => this.liveState.plugins
  getPluginSummary = (pluginId: string): PluginSummary | undefined => this.pluginById.get(pluginId)
  getGroupedUi = (): GroupedUiSpecs => this.groupedUi
  getPluginsUiSlice = (): PluginsUiSlice => this.pluginsUiSlice
  getPluginsSnapshot = (): UsePluginsResult => this.pluginsSnapshot
  getHostNodesSlice = (): HostNodesSlice | undefined => this.hostNodesSlice
  getPluginDocsMap = (): Record<string, unknown> => this.liveState.pluginDocs
  getNodes = (): NodeInfo[] => this.liveState.nodes
  getConversationLive = (id: number): ConversationLive | undefined => this.liveState.conversationLives[id]
  getConversationDetail = (id: number): ConversationDetail | undefined => this.liveState.conversationDetails[id]
  getConversationSummary = (id: number): ConversationSummary | undefined => this.summaryById.get(id)
  getConversationTreeWorkspaces = (id: number): ReadonlyArray<WorkspaceConversationNode> =>
    this.treeWorkspacesByConv.get(id) ?? EMPTY_TREE_WORKSPACES
  getConversationPendingAsks = (id: number): AskSpec[] => this.pendingAsksByConv.get(id) ?? EMPTY_PENDING_ASKS
  hasPluginDoc = (docKey: string): boolean => Object.hasOwn(this.liveState.pluginDocs, docKey)
  getPluginDoc = (docKey: string): unknown =>
    Object.hasOwn(this.liveState.pluginDocs, docKey) ? this.liveState.pluginDocs[docKey] : undefined
  getConversationBackgroundSlice = (): ConversationBackgroundSlice => this.conversationBackgroundSlice

  recomputeBackground(
    plan: NotifyPlan,
    triggers: { panelsOrConversations: boolean; locale: boolean; changedDocKeys?: ReadonlySet<string> },
  ): void {
    const result = recomputeConversationBackgroundSlice({
      prevSlice: this.conversationBackgroundSlice,
      prevBadgeDocKeys: this.backgroundBadgeDocKeys,
      workbenchPanels: this.groupedUi.workbenchPanels,
      conversations: this.liveState.conversations,
      pluginDocs: this.liveState.pluginDocs,
      locale: this.getLocale(),
      triggers,
    })
    this.backgroundBadgeDocKeys = result.badgeDocKeys
    if (!result.changed) return
    this.conversationBackgroundSlice = result.slice
    plan.domains.add('conversationBackground')
  }

  private reconcileConversationSummariesAndTree(next: LiveState, plan: NotifyPlan): void {
    const nextMap = new Map<number, ConversationSummary>()
    for (const conv of next.conversations) nextMap.set(conv.id, conv)
    for (const [id, prevConv] of this.summaryById) {
      if (nextMap.get(id) !== prevConv) plan.summaryIds.add(id)
    }
    for (const [id, nextConv] of nextMap) {
      if (this.summaryById.get(id) !== nextConv) plan.summaryIds.add(id)
    }
    this.summaryById = nextMap
    plan.domains.add('conversations')
    plan.domains.add('all')

    let topologyChanged = next.conversations.length !== this.workspaceNodesById.size
    if (!topologyChanged) {
      for (const conv of next.conversations) {
        const prevNode = this.workspaceNodesById.get(conv.id)
        const nextNodeId = conv.nodeId ?? 'local'
        const nextCwd = typeof conv.cwd === 'string' ? conv.cwd : ''
        if (
          prevNode === undefined ||
          prevNode.nodeId !== nextNodeId ||
          prevNode.cwd !== nextCwd ||
          prevNode.parentConversationId !== conv.parentConversationId
        ) {
          topologyChanged = true
          break
        }
      }
    }
    if (!topologyChanged) return

    const nextNodesById = new Map<number, WorkspaceConversationNode>()
    const nextNodes: WorkspaceConversationNode[] = []
    for (const conv of next.conversations) {
      const node: WorkspaceConversationNode = {
        id: conv.id,
        nodeId: conv.nodeId ?? 'local',
        cwd: typeof conv.cwd === 'string' ? conv.cwd : '',
        ...(conv.parentConversationId !== undefined
          ? { parentConversationId: conv.parentConversationId }
          : {}),
      }
      nextNodesById.set(conv.id, node)
      nextNodes.push(node)
    }
    const nextTreeMap = buildSameTreeWorkspacesMap(nextNodes)
    const groupCache = new Map<
      ReadonlyArray<WorkspaceConversationNode>,
      ReadonlyArray<WorkspaceConversationNode>
    >()
    for (const [id, nextList] of nextTreeMap) {
      if (nextList.length === 0) {
        if (nextList !== EMPTY_TREE_WORKSPACES) {
          nextTreeMap.set(id, EMPTY_TREE_WORKSPACES)
        }
        continue
      }
      let stable = groupCache.get(nextList)
      if (stable === undefined) {
        const prevList = this.treeWorkspacesByConv.get(id)
        stable = prevList !== undefined && isSameWorkspaceNodeList(prevList, nextList) ? prevList : nextList
        groupCache.set(nextList, stable)
      }
      if (stable !== nextList) {
        nextTreeMap.set(id, stable)
      }
    }
    this.workspaceNodesById = nextNodesById
    this.treeWorkspacesByConv = nextTreeMap
    plan.domains.add('workspaceTopology')
  }

  private reconcilePendingAsks(nextAsks: AskSpec[], plan: NotifyPlan): void {
    const nextByConv = new Map<number, AskSpec[]>()
    for (const ask of nextAsks) {
      const list = nextByConv.get(ask.conversationId)
      if (list === undefined) nextByConv.set(ask.conversationId, [ask])
      else list.push(ask)
    }
    for (const [convId, prevList] of this.pendingAsksByConv) {
      const nextList = nextByConv.get(convId)
      if (nextList === undefined) {
        plan.pendingAskIds.add(convId)
      } else if (isSameAskArray(prevList, nextList)) {
        nextByConv.set(convId, prevList)
      } else {
        plan.pendingAskIds.add(convId)
      }
    }
    for (const convId of nextByConv.keys()) {
      if (!this.pendingAsksByConv.has(convId)) plan.pendingAskIds.add(convId)
    }
    this.pendingAsksByConv = nextByConv
    plan.domains.add('pendingAsks')
    plan.domains.add('asks')
    plan.domains.add('all')
  }

  private reconcilePlugins(nextPlugins: PluginSummary[], plan: NotifyPlan): void {
    const nextPluginMap = new Map<string, PluginSummary>()
    for (const plugin of nextPlugins) nextPluginMap.set(plugin.id, plugin)
    for (const [id, prevPlugin] of this.pluginById) {
      if (nextPluginMap.get(id) !== prevPlugin) plan.pluginIds.add(id)
    }
    for (const [id, nextPlugin] of nextPluginMap) {
      if (this.pluginById.get(id) !== nextPlugin) plan.pluginIds.add(id)
    }
    this.pluginById = nextPluginMap
    plan.domains.add('plugins')
    plan.domains.add('pluginsUi')
    plan.domains.add('all')
  }

  updateLive = (update: (state: LiveState) => LiveState, plan = emptyPlan(), deferEmit = false): void => {
    const prev = this.liveState
    const next = update(prev)
    if (next === prev) return
    this.liveState = next

    if (next.conversationLives !== prev.conversationLives) {
      addChangedRecordKeys(prev.conversationLives, next.conversationLives, plan.liveIds)
      if (plan.liveIds.size > 0) {
        plan.domains.add('conversationLivesMap')
        plan.domains.add('all')
      }
    }
    if (next.conversationDetails !== prev.conversationDetails) {
      addChangedRecordKeys(prev.conversationDetails, next.conversationDetails, plan.detailIds)
      if (plan.detailIds.size > 0) {
        plan.domains.add('conversationDetailsMap')
        plan.domains.add('all')
      }
    }
    const conversationsChanged = next.conversations !== prev.conversations
    if (conversationsChanged) {
      this.reconcileConversationSummariesAndTree(next, plan)
    }
    if (next.pendingAsks !== prev.pendingAsks) {
      this.reconcilePendingAsks(next.pendingAsks, plan)
    }
    if (next.plugins !== prev.plugins) {
      this.reconcilePlugins(next.plugins, plan)
    }
    const uiChanged = next.uiContributions !== prev.uiContributions
    if (uiChanged) {
      this.groupedUi = groupUiContributions(next.uiContributions)
      plan.domains.add('groupedUi')
      plan.domains.add('pluginsUi')
      plan.domains.add('all')
    }
    if (next.plugins !== prev.plugins || uiChanged) {
      this.pluginsUiSlice = {
        plugins: next.plugins,
        uiContributions: next.uiContributions,
        groupedUi: this.groupedUi,
      }
      this.pluginsSnapshot = {
        plugins: next.plugins,
        screens: this.groupedUi.screens,
      }
    }
    if (next.pluginDocs !== prev.pluginDocs) {
      addChangedStringKeys(prev.pluginDocs, next.pluginDocs, plan.pluginDocKeys)
      if (plan.pluginDocKeys.size > 0) {
        plan.domains.add('pluginDocsMap')
        plan.domains.add('all')
      }
    }
    if (conversationsChanged || uiChanged || plan.pluginDocKeys.size > 0) {
      this.recomputeBackground(plan, {
        panelsOrConversations: conversationsChanged || uiChanged,
        locale: false,
        changedDocKeys: plan.pluginDocKeys,
      })
    }
    if (next.nodes !== prev.nodes) {
      plan.domains.add('nodes')
      plan.domains.add('all')
    }
    if (
      next.nodesLoaded !== prev.nodesLoaded ||
      (next.nodesLoaded && next.nodes !== prev.nodes)
    ) {
      this.hostNodesSlice = next.nodesLoaded ? next.nodes : undefined
      plan.domains.add('hostNodes')
      plan.domains.add('all')
    }
    if (!deferEmit) this.emit(plan)
  }

  getLiveSnapshotFields(): {
    conversations: ConversationSummary[]
    conversationDetails: Record<number, ConversationDetail>
    conversationLives: Record<number, ConversationLive>
    pendingAsks: AskSpec[]
    plugins: PluginSummary[]
    uiContributions: LiveState['uiContributions']
    groupedUi: GroupedUiSpecs
    pluginDocs: Record<string, unknown>
    nodes: NodeInfo[]
    nodesLoaded: boolean
  } {
    return {
      conversations: this.liveState.conversations,
      conversationDetails: this.liveState.conversationDetails,
      conversationLives: this.liveState.conversationLives,
      pendingAsks: this.liveState.pendingAsks,
      plugins: this.liveState.plugins,
      uiContributions: this.liveState.uiContributions,
      groupedUi: this.groupedUi,
      pluginDocs: this.liveState.pluginDocs,
      nodes: this.liveState.nodes,
      nodesLoaded: this.liveState.nodesLoaded,
    }
  }
}

export type { ArtifactMetadata }
