/**
 * builtin:swarm — on-demand single-board multi-agent peer collaboration plugin.
 */
import { HelmxError, type ConversationSummary, type DispatchToolsCapability, type MaybePromise, type PluginDefinition } from '@helmx/protocol'
import { loadManagedSkillAsset, resolvePluginClientAssets } from './asset-paths.js'
import {
  asDeletedConversationId,
  createKeyedQueue,
  getConversationOrUndefined,
  reportPluginError,
} from './shared-helpers.js'
import {
  CONVERSATION_DEPTH_CAPABILITY_ID,
  WORKFLOW_PLUGIN_ID,
  WORKTREE_PLUGIN_ID,
  type ConversationDepthCapability,
} from './contracts.js'
import {
  BOARD_BADGES_DOC_NAME,
  BOARD_VIEW_DOC_NAME,
  INDEX_DOC_NAME,
  SWARM_PLUGIN_ID,
  SWARM_SKILL_ID,
  asConversationUpsertEvent,
  assertIndexDoc,
  resolveSwarmConfig,
  type BoardBadgesDoc,
  type BoardViewDoc,
  type SwarmConfig,
  type SwarmCoordinator,
  type SwarmDocs,
  type SwarmIndexDoc,
} from './swarm/contracts.js'
import { createCollabGroupRuntime } from './swarm/group-store.js'
import { registerSwarmActions } from './swarm/actions.js'
import { registerSwarmHooks } from './swarm/hooks.js'
import { registerSwarmUi } from './swarm/ui.js'

export function createSwarmPlugin(): PluginDefinition {
  return {
    id: SWARM_PLUGIN_ID,
    name: { en: 'Swarm Peer Collaboration', 'zh-CN': 'Swarm 对等协同' },
    description: {
      en: 'On-demand multi-agent peer collaboration inside a conversation: dynamic author/verifier squads, worktree-isolated handoffs, event-driven stall recovery, and a per-conversation orchestration panel.',
      'zh-CN': '会话内按需多智能体对等协同：动态拆分执行与审阅小队、工作树隔离交接、事件驱动防掉棒自愈与按会话的编排面板。',
    },
    icon: 'network',
    version: '0.1.0',
    ...resolvePluginClientAssets(SWARM_PLUGIN_ID, 'swarm', 'swarm_plugin_client_missing'),
    definePlugin(ctx) {
      let active = false
      let shutdown = false
      const dispatchQueue = createKeyedQueue()
      const liveTasks = new Map<string, number>()
      const settlingWorkers = new Map<number, number>()
      let upsertUnsub: (() => void) | undefined
      let deletedUnsub: (() => void) | undefined
      let reconcilePromise: Promise<void> | undefined

      async function track<T>(label: string, task: () => MaybePromise<T>): Promise<T> {
        if (shutdown) {
          throw new HelmxError('plugin_disabled', `${SWARM_PLUGIN_ID} 已停用，拒绝后台任务 ${label}`, 409, { pluginId: SWARM_PLUGIN_ID })
        }
        liveTasks.set(label, (liveTasks.get(label) ?? 0) + 1)
        try {
          return await task()
        } finally {
          const next = (liveTasks.get(label) ?? 1) - 1
          if (next > 0) liveTasks.set(label, next)
          else liveTasks.delete(label)
        }
      }

      const reportError = (title: string, detail: unknown): void => {
        reportPluginError(ctx.host, { logTag: 'swarm', title, detail, log: false })
      }

      const getConfig = (): SwarmConfig => resolveSwarmConfig(ctx.getConfig() as Record<string, unknown>)
      const docs: SwarmDocs = {
        index: ctx.doc<SwarmIndexDoc>(INDEX_DOC_NAME, { workers: [], groups: [] }, { public: true, durable: false }),
        boardBadges: ctx.doc<BoardBadgesDoc>(BOARD_BADGES_DOC_NAME, { byConversation: {} }, { public: true, durable: false }),
        boardView: ctx.sessionDoc<BoardViewDoc | null>(BOARD_VIEW_DOC_NAME, null, { public: true, durable: false }),
      }
      const readIndex = (): SwarmIndexDoc => assertIndexDoc(docs.index.get())
      const writeIndex = (next: SwarmIndexDoc): SwarmIndexDoc => {
        assertIndexDoc(next)
        docs.index.set(next)
        return next
      }
      const readConversationOrUndefined = (id: number | undefined): ConversationSummary | undefined =>
        id === undefined ? undefined : getConversationOrUndefined(ctx.host, id)

      let coordinatorRef!: SwarmCoordinator
      const groupsRuntime = createCollabGroupRuntime(ctx, () => coordinatorRef)
      const coordinator: SwarmCoordinator = {
        isActive: () => active,
        isShutdown: () => shutdown,
        getConfig,
        getDocs: () => docs,
        readIndex,
        writeIndex,
        readConversationOrUndefined,
        reportError,
        enqueueDispatch: dispatchQueue.enqueue,
        track,
        groups: groupsRuntime,
        settlingWorkers,
      }
      coordinatorRef = coordinator

      registerSwarmActions(ctx, coordinator)
      ctx.provide<DispatchToolsCapability>('helmx.dispatch-tools', {
        toolNames: ['swarm_dispatch_worker'],
      })
      ctx.provide<ConversationDepthCapability>(CONVERSATION_DEPTH_CAPABILITY_ID, {
        depthOf(conversationId) {
          if (!active) return undefined
          const found = groupsRuntime.findWorkerMember(conversationId)
          if (found === undefined) return undefined
          return {
            depth: 1,
            ...(found.member.forked === true ? { leaf: true } : {}),
          }
        },
      })
      registerSwarmHooks(ctx, coordinator)
      registerSwarmUi(ctx)

      ctx.configSchema({
        maxWorkersPerGroup: {
          type: 'number',
          label: { en: 'Max workers per group', 'zh-CN': '单组最大成员数' },
          description: { en: 'Maximum active peer members allowed in a single collaboration group (integer 2..32)', 'zh-CN': '单个协作组同时处于活跃生命周期的对等成员上限（整数 2..32）' },
          default: 12,
        },
        boardPreviewLimit: {
          type: 'number',
          label: { en: 'Board preview limit', 'zh-CN': '看板预览消息上限' },
          description: { en: 'Maximum recent board posts retained in the board-view session document (integer 20..200)', 'zh-CN': '看板实时会话文档保留的最近流转消息条数上限（整数 20..200）' },
          default: 80,
        },
        maxPeerHopsWithoutCoordinator: {
          type: 'number',
          label: { en: 'Max peer hops without coordinator', 'zh-CN': '主控未介入最大互唤跳数' },
          description: { en: 'Maximum consecutive peer-to-peer wakeups allowed before tripping a blocker circuit breaker to the coordinator (integer 2..100)', 'zh-CN': '自上次主控介入起允许的连续对等成员互唤上限，超限自动熔断并向主控上报受阻（整数 2..100）' },
          default: 16,
        },
      })

      ctx.service({
        id: 'swarm-core',
        reconcileAfter: [WORKFLOW_PLUGIN_ID, WORKTREE_PLUGIN_ID],
        liveTasks() {
          const labels = [...liveTasks.keys(), ...groupsRuntime.liveTaskLabels()]
          if (!active) return labels
          for (const id of new Set(readIndex().workers.map((w) => w.conversationId))) {
            const s = readConversationOrUndefined(id)
            if (s?.status === 'working' || s?.status === 'blocked') labels.push(`worker-run:${id}`)
          }
          for (const [id, count] of settlingWorkers) {
            if (count > 0) labels.push(`worker-settle:${id}`)
          }
          return labels
        },
        inUse: () => (active ? groupsRuntime.inUseItems() : []),
        async start() {
          shutdown = false
          getConfig()
          readIndex()
          await ctx.host.skills.ensureSkill(
            loadManagedSkillAsset({
              pluginId: SWARM_PLUGIN_ID,
              skillId: SWARM_SKILL_ID,
              relativeDir: `swarm/assets/${SWARM_SKILL_ID}`,
              missingErrorCode: 'swarm_asset_missing',
            }),
          )
          upsertUnsub = ctx.host.onEvent('conversation.upsert', (p) => {
            if (!active || shutdown) return
            const ev = asConversationUpsertEvent(p)
            if (ev) groupsRuntime.onConversationUpsert(ev.id)
          })
          deletedUnsub = ctx.host.onEvent('conversation.deleted', async (p) => {
            if (!active || shutdown) return
            const id = asDeletedConversationId(p)
            if (id !== undefined) await groupsRuntime.onConversationDeleted(id)
          })
          active = true
          await groupsRuntime.loadAllFromDisk()
          await groupsRuntime.reconcileOrphansOnBoot()
        },
        async reconcile() {
          if (!active || shutdown) return
          const task = track('reconcile-recovered-groups', () => groupsRuntime.reconcileRecoveredGroups()).catch((err) => {
            if (!shutdown) reportError('Swarm 启动恢复对账失败', err)
          })
          reconcilePromise = task
          try {
            await task
          } finally {
            if (reconcilePromise === task) reconcilePromise = undefined
          }
        },
        async stop() {
          shutdown = true
          active = false
          upsertUnsub?.()
          upsertUnsub = undefined
          deletedUnsub?.()
          deletedUnsub = undefined
          await groupsRuntime.stopAndClear()
          if (reconcilePromise) {
            await Promise.allSettled([reconcilePromise])
            reconcilePromise = undefined
          }
          settlingWorkers.clear()
        },
      })
    },
  }
}

export {
  SWARM_PLUGIN_ID, SWARM_SKILL_ID, COORDINATOR_TAG, WORKER_TAG, ARCHIVED_COORDINATOR_TAG, ARCHIVED_WORKER_TAG,
  COORDINATOR_SCOPE, PARTICIPANT_SCOPE, BOARD_REPORT_RENDERER, BOARD_WAKEUP_RENDERER,
  INDEX_DOC_NAME, BOARD_BADGES_DOC_NAME, BOARD_VIEW_DOC_NAME,
  resolveSwarmConfig, assertIndexDoc, assertCollabGroupRecord, assertBoardPost, assertMemberName, assertGroupId,
  type SwarmConfig, type WorkerAccess, type WorkerIsolation, type CollabGroupStatus, type BoardPostKind,
  type SwarmWorkerPointer, type SwarmIndexDoc, type CollabGroupSummary, type GroupMemberState,
  type RetainedWorktreeInfo, type CollabGroupRecord, type WorktreeHandoffSnapshot, type BoardPost,
  type BoardBadgeEntry, type BoardBadgesDoc, type BoardViewHeadline, type MemberLiveState, type BoardViewMember, type BoardViewDoc,
} from './swarm/contracts.js'

export {
  resolveDefaultWake, resolveBoardTargets, shouldFlushCoordinatorReport,
  findIdleCatchupAnchorPost, synthesizeHeadline, synthesizeBoardView,
} from './swarm/board-router.js'
export { evaluateSilentExit, diagnoseStallRootCause, computeStallWatermark, evaluateGroupQuiescence } from './swarm/board-stall.js'
export { activeSwarmGroupCoordinatorSection, activeSwarmGroupWorkerSection } from './swarm/hooks.js'
export { registerSwarmUi } from './swarm/ui.js'
