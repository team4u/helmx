/**
 * Async asset, plugin-sync, conversation detail/artifact, and plugin-doc
 * request actions for HelmxExternalStore.
 */
import type {
  ArtifactMetadata,
  ConversationDetail,
  ConversationEntry,
  ConversationSummary,
  LocalizedText,
  NodeInfo,
  PluginSummary,
} from '@helmx/protocol/browser'
import { assetsApi, conversationsApi, nodesApi, pluginsApi } from '../api.js'
import { errorText } from '../error-text.js'
import {
  applyConversationEntry,
  isPluginSummaryActive,
  mergeConversationDetail,
  omitPluginDocLoadErrors,
  reconcilePluginsState,
  sortNodes,
  type LiveState,
} from '../live-state.js'
import { reconcilePluginClientCache } from '../plugin-client.js'
import { isAbortError, type StoreRequestManager } from '../request-manager.js'
import { evictSessionDocSubscriptions, restoreSessionDocSubscriptions } from '../session-docs.js'
import { defaultConversationDetailTurns, type ToastNotice } from '../types.js'
import { isConversationStatusActive } from '../use-unread-sync.js'
import { ASSET_LOAD_FAILURE_TITLES, emptyPlan, reconcileArtifactList } from './helpers.js'
import type { CatalogSlice, NotifyPlan, StoreUpdater } from './types.js'

const TURN_BOUNDARY_KINDS: ReadonlySet<string> = new Set([
  'helmx.input',
  'pi.user',
  'pi.reset',
  'pi.compaction',
])

function hasTurnBoundaryEntry(entries: ReadonlyArray<ConversationEntry>): boolean {
  return entries.some((entry) => TURN_BOUNDARY_KINDS.has(entry.kind))
}

function hasAssistantTextBlock(entry: ConversationEntry): boolean {
  if (!Array.isArray(entry.model)) return false
  for (const msg of entry.model) {
    if (msg === null || typeof msg !== 'object') continue
    const content = (msg as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        block !== null &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string' &&
        (block as { text: string }).text.trim() !== ''
      ) {
        return true
      }
    }
  }
  return false
}

function hasMeaningfulTimelineEntry(entries: ReadonlyArray<ConversationEntry>): boolean {
  for (const entry of entries) {
    if (TURN_BOUNDARY_KINDS.has(entry.kind)) return true
    if (entry.kind === 'pi.assistant') {
      if (hasAssistantTextBlock(entry)) return true
      continue
    }
    if (
      entry.kind === 'pi.tool-result' ||
      entry.kind === 'pi.system' ||
      entry.kind === 'helmx.rewind'
    ) {
      continue
    }
    return true
  }
  return false
}

export interface StoreRequestsHost {
  readonly requests: StoreRequestManager
  getLiveState(): LiveState
  getConversationSummary(id: number): ConversationSummary | undefined
  getConversationArtifactsMap(): Record<number, ArtifactMetadata[]>
  getLoadErrorsMap(): Record<string, string>
  translate(text: LocalizedText): string
  emit(plan: NotifyPlan): void
  patchCatalog(patch: Partial<CatalogSlice>, plan?: NotifyPlan, deferEmit?: boolean): void
  updateLive(update: (state: LiveState) => LiveState, plan?: NotifyPlan, deferEmit?: boolean): void
  setConversationArtifacts(
    update: StoreUpdater<Record<number, ArtifactMetadata[]>>,
    plan?: NotifyPlan,
    deferEmit?: boolean,
  ): void
  setLoadErrors(
    update: StoreUpdater<Record<string, string>>,
    plan?: NotifyPlan,
    deferEmit?: boolean,
  ): void
  reportLoad(key: string, error?: unknown): void
  pushNotice(notice: Omit<ToastNotice, 'id' | 'createdAt'>): void
}

export interface StoreRequestActions {
  refreshAssets: () => Promise<void>
  syncPlugins: (next: PluginSummary[]) => void
  refreshNodes: () => Promise<NodeInfo[] | undefined>
  loadConversationDetail: (
    id: number,
    force?: boolean,
    opts?: { silent?: boolean; limit?: number; turns?: number },
  ) => Promise<ConversationDetail | undefined>
  loadEarlierEntries: (id: number, opts?: { quiet?: boolean }) => Promise<void>
  backfillConversationEntry: (conversationId: number, entry: ConversationEntry) => void
  loadConversationArtifacts: (
    id: number,
    opts?: { silent?: boolean },
  ) => Promise<ArtifactMetadata[] | undefined>
  ensurePluginDoc: (
    pluginId: string,
    name: string,
    options?: { force?: boolean },
  ) => Promise<unknown>
  retryPluginDoc: (pluginId: string, name: string) => Promise<unknown>
  getPluginSessionDoc: (pluginId: string, docName: string, conversationId: number) => Promise<unknown>
  invokePluginAction: (pluginId: string, actionId: string, input: unknown, conversationId?: number) => Promise<unknown>
}

export function createStoreRequestActions(host: StoreRequestsHost): StoreRequestActions {
  const refreshAssets = async (): Promise<void> => {
    const { generation, controller } = host.requests.beginAssetRefresh()
    const signal = controller.signal
    const isStale = (): boolean => generation !== host.requests.assetGeneration || signal.aborted

    const profilesTask = assetsApi.listProfiles({ signal }).then(
      (list) => {
        if (isStale()) return
        const plan = emptyPlan()
        host.patchCatalog({ profiles: list, profilesLoaded: true }, plan, true)
        const loadErrors = host.getLoadErrorsMap()
        if (Object.hasOwn(loadErrors, 'assets:profiles')) {
          const nextErrors = { ...loadErrors }
          delete nextErrors['assets:profiles']
          host.setLoadErrors(nextErrors, plan, true)
        }
        host.emit(plan)
      },
      (reason: unknown) => {
        if (isAbortError(reason) || isStale()) return
        const plan = emptyPlan()
        host.patchCatalog({ profilesLoaded: true }, plan, true)
        const nextMessage = errorText(reason)
        const loadErrors = host.getLoadErrorsMap()
        if (loadErrors['assets:profiles'] !== nextMessage) {
          host.setLoadErrors({ ...loadErrors, 'assets:profiles': nextMessage }, plan, true)
        }
        host.emit(plan)
        host.pushNotice({
          type: 'notification',
          level: 'error',
          title: host.translate(ASSET_LOAD_FAILURE_TITLES[0]!),
          body: nextMessage,
        })
      },
    )

    const otherTasks = Promise.allSettled([
      assetsApi.listModels({ signal }),
      assetsApi.listProviders({ signal }),
      assetsApi.listCredentials({ signal }),
      assetsApi.listSkills({ signal }),
      pluginsApi.listActions({ signal }),
    ]).then((results) => {
      if (isStale()) return
      const plan = emptyPlan()
      const patch: Partial<CatalogSlice> = {}
      const loadErrors = host.getLoadErrorsMap()
      let nextErrors: Record<string, string> | undefined
      if (results[0].status === 'fulfilled') {
        const catalog = results[0].value
        const { models, ...modelDefaults } = catalog
        patch.models = models
        patch.modelDefaults = modelDefaults
        if (Object.hasOwn(loadErrors, 'assets:models')) {
          nextErrors = { ...loadErrors }
          delete nextErrors['assets:models']
        }
      } else if (!isAbortError(results[0].reason)) {
        const nextMessage = errorText(results[0].reason)
        if (loadErrors['assets:models'] !== nextMessage) {
          nextErrors = { ...loadErrors, 'assets:models': nextMessage }
        }
      }
      if (results[1].status === 'fulfilled') patch.providers = results[1].value
      if (results[2].status === 'fulfilled') patch.credentials = results[2].value
      if (results[3].status === 'fulfilled') patch.skills = results[3].value
      if (results[4].status === 'fulfilled') patch.actions = results[4].value
      host.patchCatalog(patch, plan, true)
      if (nextErrors !== undefined) host.setLoadErrors(nextErrors, plan, true)
      host.emit(plan)
      results.forEach((result, index) => {
        if (result.status === 'rejected' && !isAbortError(result.reason)) {
          host.pushNotice({
            type: 'notification',
            level: 'error',
            title: host.translate(ASSET_LOAD_FAILURE_TITLES[index + 1]!),
            body: errorText(result.reason),
          })
        }
      })
    })

    await Promise.all([profilesTask, otherTasks])
    if (isStale()) return
    host.requests.finishAssetRefresh(controller)
    host.patchCatalog({ assetsLoaded: true })
  }

  /**
   * HTTP 全量插件摘要校准（如 PluginCenter 安装/更新/卸载后的 GET /api/plugins）。
   */
  const syncPlugins = (next: PluginSummary[]): void => {
    if (!Array.isArray(next)) return
    const plan = emptyPlan()
    const liveState = host.getLiveState()
    const reconciled = reconcilePluginsState(liveState, next)

    if (reconciled.state !== liveState) {
      host.updateLive(() => reconciled.state, plan, true)
    }

    if (reconciled.invalidatedDocPluginIds.size > 0) {
      for (const pluginId of reconciled.invalidatedDocPluginIds) {
        host.requests.invalidatePluginDocRequests(pluginId)
      }
      host.setLoadErrors(
        (prev) => omitPluginDocLoadErrors(prev, reconciled.invalidatedDocPluginIds),
        plan,
        true,
      )
    }

    reconcilePluginClientCache(reconciled.state.plugins)
    for (const pluginId of reconciled.inactivePluginIds) {
      evictSessionDocSubscriptions(pluginId)
    }
    for (const plugin of reconciled.state.plugins) {
      if (isPluginSummaryActive(plugin)) {
        restoreSessionDocSubscriptions(plugin.id, {
          includePermanentErrors: reconciled.invalidatedDocPluginIds.has(plugin.id),
        })
      }
    }

    host.emit(plan)
  }

  const refreshNodes = async (): Promise<NodeInfo[] | undefined> => {
    const epoch = host.requests.sessionEpoch
    const nodesBeforeRequest = host.getLiveState().nodes
    try {
      const list = await nodesApi.list()
      if (epoch !== host.requests.sessionEpoch) return undefined
      const sorted = sortNodes(list)
      host.updateLive((state) =>
        state.nodes === nodesBeforeRequest || !state.nodesLoaded
          ? { ...state, nodes: sorted, nodesLoaded: true }
          : state,
      )
      return host.getLiveState().nodes
    } catch (error) {
      if (epoch === host.requests.sessionEpoch) {
        host.pushNotice({
          type: 'notification',
          level: 'error',
          title: host.translate({ en: 'Compute nodes failed to load', 'zh-CN': '计算节点加载失败' }),
          body: errorText(error),
        })
      }
      return undefined
    }
  }

  const loadConversationDetail = async (
    id: number,
    force = false,
    opts?: { silent?: boolean; limit?: number; turns?: number },
  ): Promise<ConversationDetail | undefined> => {
    const key = `conversation:${id}`
    const existing = host.requests.inFlight.get(key)
    if (existing) return existing as Promise<ConversationDetail | undefined>
    const cachedDetail = host.getLiveState().conversationDetails[id]
    if (!force && cachedDetail) return cachedDetail

    const silent = opts?.silent === true
    const hasCached = cachedDetail !== undefined
    const detailQuery =
      opts?.limit !== undefined
        ? { limit: opts.limit }
        : { turns: opts?.turns ?? defaultConversationDetailTurns() }

    return host.requests.runControlled({
      key,
      onStart: () => {
        if (!silent || !hasCached) host.reportLoad(key)
      },
      onError: (error) => {
        if (!silent || host.getLiveState().conversationDetails[id] === undefined) {
          host.reportLoad(key, error)
        }
      },
      exec: async ({ signal, isStale, release }) => {
        const detail = await conversationsApi.getDetail(id, { ...detailQuery, signal })
        if (isStale()) return undefined
        release()
        const plan = emptyPlan()
        const loadErrors = host.getLoadErrorsMap()
        if (Object.hasOwn(loadErrors, key)) {
          const nextErrors = { ...loadErrors }
          delete nextErrors[key]
          host.setLoadErrors(nextErrors, plan, true)
        }
        host.updateLive((state) => mergeConversationDetail(state, detail), plan, true)
        host.emit(plan)
        return detail
      },
    })
  }

  const loadEarlierEntries = async (id: number, opts?: { quiet?: boolean }): Promise<void> => {
    const detail = host.getLiveState().conversationDetails[id]
    if (!detail?.nextCursor) return
    const key = `history:${id}`
    if (host.requests.inFlight.has(key)) return
    const turns = defaultConversationDetailTurns()
    const cursor = detail.nextCursor

    await host.requests.runControlled<void>({
      key,
      onStart: () => {
        host.reportLoad(key)
      },
      onError: (error) => {
        host.reportLoad(key, error)
      },
      exec: async ({ signal, isStale, release }) => {
        const page1 = await conversationsApi.getDetail(id, { turns, cursor, signal })
        if (isStale()) return undefined
        let pages: ConversationDetail[] = [page1]
        if (!hasTurnBoundaryEntry(page1.entries) && Boolean(page1.nextCursor)) {
          let page2: ConversationDetail
          try {
            page2 = await conversationsApi.getDetail(id, {
              turns,
              cursor: page1.nextCursor,
              signal,
            })
          } catch (error) {
            if (!isAbortError(error) && !isStale()) {
              host.updateLive((state) => mergeConversationDetail(state, page1, true))
            }
            throw error
          }
          if (isStale()) return undefined
          pages = [page1, page2]
        }
        release()
        host.updateLive((state) =>
          pages.reduce((acc, page) => mergeConversationDetail(acc, page, true), state),
        )
        const latestPage = pages[pages.length - 1]!
        const loadedEntries = pages.flatMap((page) => page.entries)
        if (
          opts?.quiet !== true &&
          Boolean(latestPage.nextCursor) &&
          !hasMeaningfulTimelineEntry(loadedEntries)
        ) {
          host.pushNotice({
            type: 'notification',
            level: 'info',
            conversationId: id,
            title: host.translate({
              en: 'Loaded earlier steps of current turn',
              'zh-CN': '已加载当前长回合的更早过程步骤',
            }),
            body: host.translate({
              en: 'Earlier tool and process steps for this turn were added above. Click Load earlier again to reach the previous turn.',
              'zh-CN': '已将本回合更早的工具与过程步骤加载到上方；再次点击“加载更早”可继续加载上一回合。',
            }),
          })
        }
        return undefined
      },
    })
  }

  const backfillConversationEntry = (conversationId: number, entry: ConversationEntry): void => {
    host.updateLive((state) => applyConversationEntry(state, conversationId, entry))
  }

  const loadConversationArtifacts = async (
    id: number,
    opts?: { silent?: boolean },
  ): Promise<ArtifactMetadata[] | undefined> => {
    const key = `artifacts:${id}`
    const existing = host.requests.inFlight.get(key)
    if (existing) {
      const latest = host.getConversationSummary(id) ?? host.getLiveState().conversationDetails[id]
      const inFlight = host.requests.artifactsInFlight.get(id)
      const latestActive = latest !== undefined && isConversationStatusActive(latest.status)
      if (
        latest !== undefined &&
        !latestActive &&
        (inFlight === undefined ||
          inFlight.active ||
          inFlight.watermark === undefined ||
          inFlight.watermark.stateChangeSeq !== latest.stateChangeSeq ||
          inFlight.watermark.lastEntryId !== latest.lastEntryId)
      ) {
        host.requests.dirtyArtifacts.add(id)
      }
      return existing as Promise<ArtifactMetadata[] | undefined>
    }

    const silent = opts?.silent === true
    const hasCached = host.getConversationArtifactsMap()[id] !== undefined
    const sampledSummary = host.getConversationSummary(id)
    const sampledActive = sampledSummary !== undefined && isConversationStatusActive(sampledSummary.status)
    const sampledWatermark =
      sampledSummary !== undefined && !sampledActive
        ? { stateChangeSeq: sampledSummary.stateChangeSeq, lastEntryId: sampledSummary.lastEntryId }
        : undefined
    const sessionEpoch = host.requests.sessionEpoch
    const reqEpochBefore = host.requests.requestEpochs.get(key) ?? 0
    host.requests.artifactsInFlight.set(id, { active: sampledActive, watermark: sampledWatermark })
    host.requests.dirtyArtifacts.delete(id)

    const result = await host.requests.runControlled({
      key,
      onStart: () => {
        if (!silent || !hasCached) host.reportLoad(key)
      },
      onError: (error) => {
        if (!silent || host.getConversationArtifactsMap()[id] === undefined) {
          host.reportLoad(key, error)
          host.pushNotice({
            type: 'notification',
            level: 'error',
            title: host.translate({ en: 'Conversation artifacts failed to load', 'zh-CN': '会话产物加载失败' }),
            body: errorText(error),
            conversationId: id,
          })
        }
      },
      exec: async ({ signal, isStale }) => {
        const list = await conversationsApi.listArtifacts(id, { signal })
        if (isStale()) return undefined
        const plan = emptyPlan()
        const loadErrors = host.getLoadErrorsMap()
        if (Object.hasOwn(loadErrors, key)) {
          const nextErrors = { ...loadErrors }
          delete nextErrors[key]
          host.setLoadErrors(nextErrors, plan, true)
        }
        const reconciled = reconcileArtifactList(host.getConversationArtifactsMap()[id], list)
        host.setConversationArtifacts(
          (prev) => (prev[id] === reconciled ? prev : { ...prev, [id]: reconciled }),
          plan,
          true,
        )
        host.emit(plan)
        const latestSummary = host.getConversationSummary(id) ?? host.getLiveState().conversationDetails[id]
        const latestActive = latestSummary !== undefined && isConversationStatusActive(latestSummary.status)
        if (!sampledActive && !latestActive && !host.requests.dirtyArtifacts.has(id)) {
          const resolvedWatermark =
            sampledWatermark ??
            (latestSummary !== undefined
              ? { stateChangeSeq: latestSummary.stateChangeSeq, lastEntryId: latestSummary.lastEntryId }
              : undefined)
          if (resolvedWatermark !== undefined) host.requests.artifactsWatermarks.set(id, resolvedWatermark)
          else host.requests.artifactsWatermarks.delete(id)
        } else {
          host.requests.artifactsWatermarks.delete(id)
        }
        return reconciled
      },
    })

    if (sessionEpoch === host.requests.sessionEpoch && (host.requests.requestEpochs.get(key) ?? 0) === reqEpochBefore + 1) {
      host.requests.artifactsInFlight.delete(id)
      if (host.requests.dirtyArtifacts.delete(id)) {
        return await loadConversationArtifacts(id, { silent: true })
      }
    }
    return result
  }

  const ensurePluginDoc = async (
    pluginId: string,
    name: string,
    options?: { force?: boolean },
  ): Promise<unknown> => {
    const docKey = `${pluginId}/${name}`
    const key = `doc:${docKey}`
    const force = options?.force === true
    if (!force && Object.hasOwn(host.getLiveState().pluginDocs, docKey)) {
      return host.getLiveState().pluginDocs[docKey]
    }
    if (force) {
      host.requests.clearDocFailure(key)
      host.reportLoad(key)
    } else if (host.requests.isDocFailureSuppressed(key)) {
      return undefined
    }
    const existing = host.requests.inFlight.get(key)
    if (existing) return existing

    const epoch = host.requests.sessionEpoch
    const pluginVersion = host.requests.pluginEpoch.get(pluginId)
    const task = pluginsApi
      .getPublicDoc(pluginId, name)
      .then((doc) => {
        if (epoch !== host.requests.sessionEpoch || pluginVersion !== host.requests.pluginEpoch.get(pluginId)) {
          return undefined
        }
        if (host.getLiveState().plugins.some((p) => p.id === pluginId && isPluginSummaryActive(p))) {
          const plan = emptyPlan()
          host.requests.clearDocFailure(key)
          if (force || !Object.hasOwn(host.getLiveState().pluginDocs, docKey)) {
            host.updateLive(
              (state) =>
                (!force && Object.hasOwn(state.pluginDocs, docKey)) ||
                !state.plugins.some((p) => p.id === pluginId && isPluginSummaryActive(p))
                  ? state
                  : { ...state, pluginDocs: { ...state.pluginDocs, [docKey]: doc.value } },
              plan,
              true,
            )
          }
          const loadErrors = host.getLoadErrorsMap()
          if (Object.hasOwn(loadErrors, key)) {
            const nextErrors = { ...loadErrors }
            delete nextErrors[key]
            host.setLoadErrors(nextErrors, plan, true)
          }
          host.emit(plan)
        }
        return doc.value
      })
      .catch((error: unknown) => {
        if (epoch === host.requests.sessionEpoch && pluginVersion === host.requests.pluginEpoch.get(pluginId)) {
          host.requests.markDocFailed(key)
          host.reportLoad(key, error)
          host.pushNotice({
            type: 'notification',
            level: 'error',
            title: host.translate({ en: 'Plugin state failed to load', 'zh-CN': '插件状态读取失败' }),
            body: host.translate({
              en: `${pluginId}/${name}: ${errorText(error)}`,
              'zh-CN': `${pluginId}/${name}：${errorText(error)}`,
            }),
          })
        }
        return undefined
      })
      .finally(() => {
        if (host.requests.inFlight.get(key) === task) host.requests.inFlight.delete(key)
      })
    host.requests.inFlight.set(key, task)
    return task
  }

  const retryPluginDoc = (pluginId: string, name: string): Promise<unknown> =>
    ensurePluginDoc(pluginId, name, { force: true })

  const getPluginSessionDoc = async (pluginId: string, docName: string, conversationId: number): Promise<unknown> => {
    const doc = await pluginsApi.getPublicSessionDoc(pluginId, docName, conversationId)
    return doc.value
  }

  const invokePluginAction = async (pluginId: string, actionId: string, input: unknown, conversationId?: number) =>
    pluginsApi.invokeAction(pluginId, actionId, input, conversationId)

  return {
    refreshAssets,
    syncPlugins,
    refreshNodes,
    loadConversationDetail,
    loadEarlierEntries,
    backfillConversationEntry,
    loadConversationArtifacts,
    ensurePluginDoc,
    retryPluginDoc,
    getPluginSessionDoc,
    invokePluginAction,
  }
}
