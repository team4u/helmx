/**
 * RuntimeHostBackend: host adapter factory for `PluginHost` (extracted from `KernelRuntime`).
 *
 * Responsibilities:
 * - Wrap `KernelRuntime` capabilities (`profiles`, `skills`, `secrets`, `nodeIpc`, `conversations`,
 *   `asks`, `actions`, etc.) into the strongly-typed `PluginHostBackend` interface required by `PluginHost`;
 * - Construct the `PluginDocStore` and `PluginSessionDocStore` durable persistence layers (single-pass JSON writes);
 * - Normalize boundary errors consistently (e.g., `normalizeProfileBoundaryError`, `FileNotFoundError -> 404 not_found`).
 */

import { HelmxError, isValidProfileId } from '@helmx/protocol'
import { FileNotFoundError, atomicWriteFile, withFileLock } from '../services/index.js'
import type { PluginHostBackend, PluginSessionDocStore } from '../plugins/index.js'
import type { HelmxStore } from './store.js'
import type { KernelRuntime } from './runtime.js'

/** Boundary normalization for `profiles.get/directory`: invalid id -> `400 validation_error`; rethrows all other errors as-is. */
function normalizeProfileBoundaryError(id: string, err: unknown): unknown {
  if (isValidProfileId(id)) return err
  return new HelmxError('validation_error', `Invalid Profile ID: ${String(id)}`, 400, { profileId: id })
}

/**
 * Construct the host backend interface required by `PluginHost` (`PluginHostBackend`).
 */
export function createPluginHostBackend(runtime: KernelRuntime): PluginHostBackend {
  return {
    isClosing: () => runtime.isClosing,
    profiles: {
      list: () => runtime.profiles.list(),
      get: (id) =>
        runtime.profiles.get(id).catch((err: unknown) => {
          throw normalizeProfileBoundaryError(id, err)
        }),
      getSystem: async (id) => {
        try {
          return await runtime.profiles.getSystem(id)
        } catch (err) {
          if (err instanceof FileNotFoundError) {
            throw new HelmxError('not_found', `SYSTEM.md not found for Profile '${id}'`, 404, { profileId: id })
          }
          throw err
        }
      },
      save: (profile) => runtime.profiles.save(profile),
      directory: (id) => runtime.profileDirectory(id),
    },
    skills: {
      list: () => runtime.skills.list(),
      readFile: (skillId, path) => runtime.skills.readFile(skillId, path),
      ensureSkill: (asset, pluginId) => runtime.ensurePluginSkill(asset, pluginId),
    },
    secrets: {
      get: (pluginId, key) => runtime.credentials.getPluginSecret(pluginId, key),
      set: (pluginId, key, value) => runtime.credentials.setPluginSecret(pluginId, key, value),
      delete: (pluginId, key) => runtime.credentials.deletePluginSecret(pluginId, key),
      addRedaction: (value) => runtime.stash.addRedaction(value),
    },
    nodeIpc: {
      isOnline: (nodeId) => runtime.envFabric.isOnline(nodeId),
      getNodeHubUrl: (nodeId) => runtime.envFabric.getNodeHubUrl(nodeId),
      nodePlatform: (nodeId) => runtime.envFabric.nodePlatformOf(nodeId),
    },
    openTunnel: (nodeId, target, signal) => runtime.envFabric.openTunnel(nodeId, target, signal),
    dispatchTrigger: (event) => runtime.dispatchTrigger(event),
    submitInput: async (id, text, opts) => {
      await runtime.submitInput(id, text, opts)
    },
    createConversation: (init) => runtime.createConversation(init),
    forkConversation: (id, opts) => runtime.forkConversation(id, opts),
    listConversations: (filter) => runtime.listConversations(filter),
    getConversation: (id) => runtime.getConversation(id),
    getConversationDetail: (id, options) => runtime.getConversationDetail(id, options),
    getConversationSubmission: (id, requestId) => runtime.getConversationSubmission(id, requestId),
    updateConversation: (id, patch) => runtime.updateConversation(id, patch),
    abortConversation: (id) => runtime.abortConversation(id),
    abortConversationGuarded: (id, guard) => runtime.abortConversationGuarded(id, guard),
    submitInputGuarded: async (id, text, opts, guard) => {
      await runtime.submitInputGuarded(id, text, opts, guard)
    },
    getConversationOwnership: (id) => runtime.getConversationOwnership(id),
    listArtifacts: (conversationId) => Promise.resolve(runtime.artifacts.list(conversationId)),
    redact: (text) => runtime.stash.redact(text),
    refreshModels: (options) => runtime.refreshModels(options),
    listModels: () => runtime.listModels(),
    registerModelTiers: (pluginId, getTiers) => runtime.registerModelTiers(pluginId, getTiers),
    withFileLock: <T>(path: string, fn: () => Promise<T>, opts?: { signal?: AbortSignal }) =>
      withFileLock(path, async () => {
        opts?.signal?.throwIfAborted()
        return fn()
      }),
    atomicWriteFile: (path, content) => atomicWriteFile(path, content),
    completeText: (input) => runtime.completeConversationText(input),
    executionEnv: (nodeId, cwd) => runtime.envFabric.envFor(nodeId, cwd),
    spawnAgent: (request) => runtime.agentSpawn.spawnAgent(request),
    runGate: (command, options) => runtime.agentSpawn.runGate(command, options),
    resolveSpawnTarget: (input) => runtime.agentSpawn.resolveSpawnTarget(input),
    listActiveSpawnExecutions: () => runtime.agentSpawn.listActiveSpawnExecutions(),
    inspectNodePathUsage: (input) => runtime.agentSpawn.inspectNodePathUsage(input),
    manageConversation: (id, pluginId) => runtime.manageConversation(id, pluginId),
    markConversationOwnership: (id, owner) => runtime.markConversationOwnership(id, owner),
    createAsk: (spec) => runtime.createAsk(spec),
    cancelAsk: (askId, reason) => runtime.cancelAsk(askId, reason),
    execEnv: async (req, opts) => {
      const res = await runtime.execEnv(req, undefined, opts?.signal)
      return {
        ...res,
        output: runtime.stash.redact(res.output),
      }
    },
    onEvent: (type, listener) => runtime.onEvent(type, listener),
    emitEvent: (type, payload, options) => runtime.emitHostEvent(type, payload, options),
  }
}

/**
 * Construct the global durable document store port (shared by `PluginHost` docs).
 */
export function createGlobalDocumentStore(store: HelmxStore): {
  get<T>(key: string, initial: T): T
  set<T>(key: string, value: T): void
  setJson(key: string, valueJson: string): void
  deletePlugin(pluginId: string): void
  flush(): Promise<void>
} {
  return {
    get: <T>(key: string, initial: T): T => {
      const raw = store.getPluginDoc('__global', key)
      if (raw === undefined) return initial
      return JSON.parse(raw) as T
    },
    set: <T>(key: string, value: T): void => {
      store.putPluginDoc('__global', key, JSON.stringify(value), { prevalidated: true })
    },
    setJson: (key: string, valueJson: string): void => {
      store.putPluginDoc('__global', key, valueJson, { prevalidated: true })
    },
    deletePlugin: (pluginId: string): void => {
      store.deleteGlobalPluginDocs(pluginId)
    },
    flush: () => store.flushPublic(),
  }
}

/**
 * Construct the per-conversation durable storage layer required by `PluginHost` (`PluginSessionDocStore`).
 */
export function createPluginSessionDocStore(store: HelmxStore): PluginSessionDocStore {
  return {
    get: (pluginId, name, conversationId) =>
      store.getPluginSessionDoc(pluginId, name, conversationId),
    put: (pluginId, name, conversationId, valueJson) =>
      store.putPluginSessionDoc(pluginId, name, conversationId, valueJson, { prevalidated: true }),
    delete: (pluginId, name, conversationId) =>
      store.deletePluginSessionDoc(pluginId, name, conversationId),
    deletePlugin: (pluginId) => store.deletePluginSessionDocs(pluginId),
    listConversationIds: (pluginId, name) =>
      store.listPluginSessionDocConversations(pluginId, name),
    flush: () => store.flushPublic(),
  }
}
