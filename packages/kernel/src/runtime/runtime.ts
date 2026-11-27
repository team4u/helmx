/**
 * Minimal `@helmx/kernel` runtime facade (microkernel base).
 *
 * Responsibilities:
 * - Assemble and wire all kernel mechanisms (`pi-durable` / SQLite / FTS5 / `EnvFabric` / `PluginHost` / `Models`);
 * - Manage unified lifecycle (`open` / `initialize` / `start` / `close`);
 * - Expose cohesive readonly domain sub-facades (`conversations`, `nodes`, `nodeForward`, `models`,
 *   `asks`, `triggers`, `agentSpawn`, `ownership`, etc.) alongside lifecycle coordination;
 * - Delegate complex orchestration and operations to cohesive submodules:
 *   `RuntimeTriggerDispatcher`, `RuntimeAgentSpawn`,
 *   `RuntimeOwnershipManager`, `createPluginHostBackend`, and `RuntimeToolRegistry`.
 */

import {
  HelmxError,
  isPluginSummaryActive,
  parseSkillFrontmatter,
  type ConversationInput,
  type TurnSettledPayload,
  type MaybePromise,
  type PluginSkillAsset,
  type HubActivityCounts,
  type ConversationSummary,
} from '@helmx/protocol'
import type { Harness, Registry, ToolRegistration } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'
import {
  ArtifactService as SvcArtifactService,
  AuthService as SvcAuthService,
  CredentialService,
  ProfileService,
  ProviderService,
  SecretStash,
  SkillService,
} from '../services/index.js'
import { PluginHost } from '../plugins/index.js'
import type { EnvFabric } from '../env/index.js'
import { NodeForwardService } from '../env/forward.js'
import type { AskService } from './asks.js'
import type { EventHub, SessionDocEventHub } from './events.js'
import type { HelmxDatabase } from './sqlite.js'
import { summaryOf, type HelmxStore } from './store.js'
import type { HelmxPluginConfigStore } from './plugin-config-store.js'
import type { ConversationService } from './conversation-service.js'
import type { HubListenInfo } from './hub-access.js'
import type { RuntimeAgentSpawn } from './runtime-agent-spawn.js'
import type { RuntimeOwnershipManager } from './runtime-ownership.js'
import type { RuntimeTriggerDispatcher } from './runtime-triggers.js'
import type { NodeManager } from './node-manager.js'
import type { ModelRegistry } from './model-registry.js'
import {
  createGlobalDocumentStore,
  createPluginHostBackend,
  createPluginKvStore,
  createPluginSessionDocStore,
} from './runtime-host-backend.js'
import { formatDiagnosticError, type KernelDiagnosticInput } from './diagnostics.js'
import {
  bootstrapKernelRuntime,
  ensureInitialConversation,
  recoverExistingConversations,
  resolveNodeJoinGraceMs,
  teardownKernelRuntime,
  type KernelBootOptions,
} from './runtime-bootstrap.js'
import { waitForNodesOnline } from './node-join-grace.js'
import {
  assembleRuntimeServices,
  type AssembledRuntimeServices,
  type RuntimeServicesInit,
} from './runtime-services.js'
import { registerCoreActions } from './core-actions.js'
import { bootstrapCoreSkills } from './core-skills/index.js'
import { clearRegistryToolAbortFallbacks } from './tool-registry.js'
import { ASK_USER_OWNER_ID } from './tools.js'

export type KernelRuntimeOptions = KernelBootOptions

export class KernelRuntime {
  readonly dataDir: string
  private readonly database: HelmxDatabase
  private readonly harness: Harness
  readonly registry: Registry<ToolRegistration<object, JsonValue>>
  private readonly store: HelmxStore
  readonly events: EventHub
  /** Dedicated event surface for conversation session docs (HTTP `sessionDocEvents` port; single instance wired in constructor). */
  readonly sessionDocEvents: SessionDocEventHub
  private readonly stashService = new SecretStash()
  private readonly hostEventListeners = new Map<string, Set<(payload: unknown) => MaybePromise<void>>>()
  private readonly startedListeners = new Set<() => void>()
  private readonly closeListeners = new Set<() => void>()
  readonly envFabric: EnvFabric
  /** Hub-side foreground port forwarding (listeners live only during commands; cleaned up on close). */
  readonly nodeForward: NodeForwardService
  private processTokenHandle: { tokenOf(): string | undefined; dispose(): void } | undefined
  private hubUrlValue: string
  private hubListenInfoValue: HubListenInfo | undefined
  private pluginHost: PluginHost | undefined
  /** Startup lifecycle fact (read-only for service wiring; flipped once `resume` and `reconcile` both complete — see `start()`). */
  #started = false
  private startPromise: Promise<void> | undefined
  private nodeJoinGraceDone = false
  private needsStartupAlignment = true
  private bootAlignModelEpoch = -1
  private bootAlignProfileEpoch = -1
  private closed = false
  #fatalError: HelmxError | undefined
  private fatalStorageNotified = false
  private settledInflight: Promise<void> = Promise.resolve()
  readonly nodes: NodeManager
  readonly conversations: ConversationService
  /** Subagent spawning, target resolution, and occupancy snapshot service. */
  readonly agentSpawn: RuntimeAgentSpawn
  readonly models: ModelRegistry
  readonly asks: AskService
  readonly triggers: RuntimeTriggerDispatcher
  readonly ownership: RuntimeOwnershipManager
  private readonly svc: AssembledRuntimeServices

  readonly documentStore: {
    get<T>(key: string, initial: T): T
    set<T>(key: string, value: T): void
    setJson(key: string, valueJson: string): void
    deletePlugin(pluginId: string): void
    flush(): Promise<void>
  }
  readonly kvStore: ReturnType<typeof createPluginKvStore>

  static async open(options: KernelRuntimeOptions = {}): Promise<KernelRuntime> {
    if (options.models !== undefined && options.providers !== undefined) {
      throw new HelmxError(
        'validation_error',
        'KernelRuntimeOptions.models and KernelRuntimeOptions.providers are mutually exclusive',
        400,
      )
    }
    const boot = await bootstrapKernelRuntime(options)
    const runtime = new KernelRuntime({
      ...boot,
      hubPlatform: options.hubPlatform,
      defaultModel: options.model || process.env['HELMX_MODEL'] || undefined,
      cwd: options.cwd ?? process.cwd(),
      hubUrl: options.hubUrl,
      seedKeyCache: boot.apiKeyCache,
      autoResume: options.autoResume !== false,
      nodeJoinGraceMs: options.nodeJoinGraceMs ?? resolveNodeJoinGraceMs(),
      externalModels: options.models,
      providers: options.providers,
      externalSkillRoots: options.externalSkillRoots,
      buildProvider: options.buildProvider,
      packageManagerProvider: options.packageManagerProvider,
      nodeUpgradeTimeoutMs: options.nodeUpgradeTimeoutMs ?? 120_000,
    })
    try {
      await runtime.initialize()
    } catch (error) {
      await runtime.close().catch(() => {})
      throw error
    }
    return runtime
  }

  private constructor(private readonly init: RuntimeServicesInit) {
    this.dataDir = init.dataDir
    this.database = init.database
    this.harness = init.harness
    this.registry = init.registry
    this.store = init.store
    this.hubUrlValue = init.hubUrl ?? `http://127.0.0.1:${process.env['HELMX_PORT'] ?? '3202'}`
    this.documentStore = createGlobalDocumentStore(this.store)
    this.kvStore = createPluginKvStore(this.store)

    // Assemble and wire all internal kernel services
    this.svc = assembleRuntimeServices(this, init, {
      store: this.store,
      stashService: this.stashService,
      assertWritable: this.assertWritable,
      dispatchTurnSettled: (payload, consumed) => this.dispatchTurnSettled(payload, consumed),
      onSettleInflight: (run) => {
        // Absorb errors per run: teardown awaits `settledInflight()` three times; any unhandled rejection
        // would abort shutdown (skipping store/database closes and leaking handles) and poison subsequent joins.
        // Failures are logged faithfully rather than silently swallowed.
        const absorbed = run.then(
          () => undefined,
          (error) => {
            this.emitDiagnostic({
              level: 'error',
              source: 'runtime.settle',
              message: 'Turn settlement chain failed (absorbed so shutdown is not blocked)',
              error,
            })
            return undefined
          },
        )
        this.settledInflight = this.settledInflight.then(() => absorbed)
      },
      safeSummary: (id) => this.safeSummary(id),
    })

    this.models = this.svc.models
    this.envFabric = this.svc.envFabric
    this.nodeForward = new NodeForwardService(this.svc.envFabric, undefined, {
      assertWritable: this.assertWritable,
    })
    this.nodes = this.svc.nodes
    this.events = this.svc.events
    this.sessionDocEvents = this.svc.sessionDocStreams
    this.conversations = this.svc.conversations
    this.agentSpawn = this.svc.agentSpawn
    this.asks = this.svc.asks
    this.triggers = this.svc.triggers
    this.ownership = this.svc.ownership

    // Single delivery boundary for internal host events: after each SSE broadcast, `EventHub.publish` delivers
    // once to `ctx.host.onEvent` listeners (validated + redacted HelmxEvent envelope). Kernel automatic events
    // (tracker/asks publishing directly via `events.publish`) are fire-and-forget so synchronous observation paths
    // like SDK advance never block; public `emitHostEvent` awaits delivery per contract without double-dispatching.
    this.events.setHostDispatcher((event) => this.dispatchInternalEvent(event.type, event))

    this.nodes.bindEvents()

    // Managed process token
    const managed = this.svc.authSvc.createProcessToken()
    this.processTokenHandle = {
      tokenOf: () => managed.token,
      dispose: () => managed.dispose(),
    }
    this.stashService.addRedaction(managed.token)
    if (process.env['HELMX_TOKEN']) {
      this.stashService.addRedaction(process.env['HELMX_TOKEN'])
    }
    this.init.redactReport((t) => this.stashService.redact(t))
    this.svc.tracker.setDiagnosticSink(this.init.onDiagnostic)
    this.init.setCompactionModelResolver(() => ({
      model: this.models.defaultCompactionModel,
      thinkingLevel: this.models.defaultCompactionThinkingLevel,
      resolveModelRef: (ref) => this.models.resolveModelRef(ref),
      modelThinkingLevel: (providerId, modelId) =>
        this.models.modelThinkingLevelOf({ provider: providerId, modelId }),
      isDisabled: (providerId, modelId) => this.models.isModelDisabled(providerId, modelId),
    }))
    this.init.setFatalStorageHandler(
      (source, error) => this.handleFatalStorageError(source, error),
      () => this.closed,
    )
  }

  private async initialize(): Promise<void> {
    await this.nodes.initialize()
    await this.svc.profilesSvc.ensureDefault()
    await bootstrapCoreSkills(this.svc.skillsSvc)
    await this.models.loadDefaultsFromConfig()
    if (this.init.providers !== undefined && this.init.externalModels === undefined) {
      for (const provider of this.init.providers) {
        await this.models.registerRuntimeProvider(provider)
      }
    }

    this.svc.toolRegistry.installKernelTools()
    this.svc.hookBridge.install()

    await this.svc.pluginConfig.load()
    this.pluginHost = new PluginHost({
      dataDir: this.dataDir,
      cwd: this.init.cwd,
      deferServices: true,
      redactText: (text) => this.stashService.redact(text),
      providers: {
        register: (provider, pluginId) => this.models.registerRuntimeProvider(provider, pluginId),
        assertIdle: (pluginId) => this.models.assertRuntimeProvidersIdle(pluginId),
      },
      host: createPluginHostBackend(this),
      docs: this.documentStore,
      sessionDocs: createPluginSessionDocStore(this.store),
      kv: this.kvStore,
      config: this.svc.pluginConfig,
      packagesConfig: this.svc.configSvc,
      buildProvider: this.init.buildProvider,
      packageManagerProvider: this.init.packageManagerProvider,
    })
    registerCoreActions(this, this.pluginHost)
    this.models.bindPluginHost(this.pluginHost)
    // Warm managed package install records (`config.json` `pluginPackages`; throws on corruption) when wired.
    await this.pluginHost.loadPackageManager()

    const modelEpochBeforeRecover = this.models.alignmentEpoch
    const profileEpochBeforeRecover = this.svc.profilesSvc.mutationEpoch
    const initialDeferred = await ensureInitialConversation({
      harness: this.harness,
      store: this.store,
      tracker: this.svc.tracker,
      conversations: this.conversations,
      cwd: this.init.cwd,
    })
    await this.svc.asks.supersedeOrphanedByOwner(ASK_USER_OWNER_ID)
    this.svc.asks.reportOrphans()
    const recovered = await recoverExistingConversations({
      conversations: this.conversations,
      harness: this.harness,
      store: this.store,
      defaultCwd: this.svc.toolDeps.defaultCwd,
    })
    this.bootAlignModelEpoch = this.models.alignmentEpoch
    this.bootAlignProfileEpoch = this.svc.profilesSvc.mutationEpoch
    this.needsStartupAlignment =
      initialDeferred ||
      recovered.deferredTierAlignment ||
      this.bootAlignModelEpoch !== modelEpochBeforeRecover ||
      this.bootAlignProfileEpoch !== profileEpochBeforeRecover
    if (this.store.needsFtsRebuild || recovered.recoveredCount > 0) {
      await this.conversations.rebuildFts()
    }
    this.svc.assetReloader.start()
    if (this.init.autoResume) await this.start()
  }

  async ensurePluginSkill(asset: PluginSkillAsset, pluginId: string): Promise<void> {
    let managedByPlugin: string | undefined
    try {
      managedByPlugin = parseSkillFrontmatter(asset.skillMd).managedByPlugin
    } catch (error) {
      throw new HelmxError(
        'invalid_plugin_skill',
        `Managed skill '${asset.id}' for plugin '${pluginId}' has invalid SKILL.md frontmatter: ${error instanceof Error ? error.message : String(error)}`,
        400,
        { pluginId, skillId: asset.id },
      )
    }
    if (managedByPlugin !== pluginId) {
      throw new HelmxError(
        'invalid_plugin_skill',
        `Managed skill '${asset.id}' for plugin '${pluginId}' must declare 'managedByPlugin: ${pluginId}' in SKILL.md frontmatter (got: ${managedByPlugin ?? 'missing'})`,
        400,
        { pluginId, skillId: asset.id },
      )
    }
    await this.svc.skillsSvc.ensureSkill(asset)
  }

  private async reconcileActivePluginManagedSkills(): Promise<void> {
    if (this.pluginHost === undefined) return
    // Reconcile only active (enabled + started without error) plugin owners: retired directories of
    // active plugins that now declare fewer or zero skills (e.g. `builtin:profile` after migrating
    // core skills out) are removed, while disabled or failed-to-start plugins retain their on-disk dirs.
    const activePluginIds = this.pluginHost
      .list()
      .filter(isPluginSummaryActive)
      .map((plugin) => plugin.id)
    await this.svc.skillsSvc.reconcileManagedOwners(activePluginIds)
  }

  emitHostEvent(type: string, payload: unknown, options?: { broadcast?: boolean }): MaybePromise<void> {
    if (options?.broadcast === false) {
      if (type === 'plugin.changed' || type === 'plugin.session_doc.updated' || type.trim() === '') {
        throw new HelmxError('invalid_event', 'Host lifecycle events cannot be overridden for private dispatch', 400)
      }
      return this.dispatchInternalEvent(type, payload)
    }
    if (type === 'plugin.changed') {
      try {
        this.refreshPluginTools()
      } catch (error) {
        // Tool hot-install failures must not block publishing `plugin.changed` (clients must still observe plugin state transitions);
        // never leak the exception to the caller either — record diagnostics faithfully.
        this.emitDiagnostic({
          level: 'error',
          source: 'runtime.plugins',
          message: 'Failed to refresh plugin tools after plugin.changed',
          error,
        })
      }
      const envelope = payload as { type?: string; plugin?: unknown; ui?: unknown } | undefined
      return this.events.publish('plugin.changed', {
        type: 'plugin.changed',
        plugin: envelope?.plugin ?? {},
        ui: Array.isArray(envelope?.ui) ? envelope!.ui : [],
      }).internal
    }
    if (type === 'plugin.session_doc.updated') {
      this.svc.sessionDocStreams.dispatch(payload)
      return this.dispatchInternalEvent(type, payload)
    }
    // Broadcast internal listener delivery is handled solely by `EventHub` (single delivery after SSE broadcast
    // using the validated + redacted envelope); return `.internal` so `emitEvent` callers can still await delivery.
    return this.events.publish(type, payload).internal
  }

  onEvent(type: string, listener: (payload: unknown) => MaybePromise<void>): () => void {
    let listeners = this.hostEventListeners.get(type)
    if (listeners === undefined) {
      listeners = new Set()
      this.hostEventListeners.set(type, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners!.delete(listener)
      if (listeners!.size === 0) this.hostEventListeners.delete(type)
    }
  }

  private dispatchInternalEvent(type: string, payload: unknown): MaybePromise<void> {
    const listeners = this.hostEventListeners.get(type)
    if (listeners === undefined || listeners.size === 0) return
    // Isolate listeners: callers (such as `emitEvent` statements in plugin-host) may neither await nor catch,
    // so throwing in one listener must neither block remaining listeners nor cause an unhandledRejection.
    const run = (async () => {
      for (const listener of [...listeners]) {
        try {
          await listener(payload)
        } catch (error) {
          this.emitDiagnostic({
            level: 'error',
            source: 'runtime.events',
            message: `Internal event listener failed (${type})`,
            error,
          })
        }
      }
    })()
    return run
  }

  /** Fatal storage fault state (read-only): set after a Harness Storage fault or `HelmxStore` persistence failure. */
  get fatalError(): HelmxError | undefined {
    return this.#fatalError
  }

  /** Register a callback invoked when `start()` transitions `started` to `true`. */
  onStarted(listener: () => void): () => void {
    this.startedListeners.add(listener)
    return () => {
      this.startedListeners.delete(listener)
    }
  }

  /** Register a callback invoked at the beginning of `close()` teardown. */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  /** Emit a structured diagnostic event through the kernel's redacted diagnostic sink. */
  emitDiagnostic(input: KernelDiagnosticInput): void {
    this.init.emitDiagnostic(input)
  }

  private readonly assertWritable = (): void => {
    if (this.#fatalError !== undefined) {
      throw this.#fatalError
    }
    if (this.closed) {
      throw new HelmxError('runtime_closed', 'kernel is closing; rejecting write operation', 503)
    }
  }

  private handleFatalStorageError(source: 'harness' | 'store', error: unknown): void {
    if (this.closed) return
    const safeDetail = this.stashService.redact(formatDiagnosticError(error))
    const recorded =
      error instanceof HelmxError
        ? new HelmxError(error.code, this.stashService.redact(error.message), error.status, {
            source,
            cause: safeDetail,
          })
        : new HelmxError(
            source === 'store' ? 'store_flush_failed' : 'storage_failed',
            `Fatal storage fault (${source}): ${safeDetail}`,
            500,
            { source },
          )
    if (this.#fatalError === undefined) {
      this.#fatalError = recorded
    }
    this.emitDiagnostic({
      level: 'error',
      source,
      message: source === 'store' ? 'HelmxStore persistence failed; kernel entered fatal fault state' : 'Harness closed due to fatal storage fault',
      error,
    })
    if (!this.fatalStorageNotified) {
      this.fatalStorageNotified = true
      const notification = {
        level: 'error' as const,
        title: source === 'store' ? 'Kernel persistence fault' : 'Kernel storage engine exited unexpectedly',
        body: recorded.message,
      }
      try {
        this.events.publish('notification', notification)
      } catch {
        // When store is already in failed state, `persistSeq` throws `store_flush_failed`;
        // still notify internal host listeners at least once without throwing again.
        void this.dispatchInternalEvent('notification', { type: 'notification', ...notification })
      }
    }
  }

  /** Startup lifecycle fact (read-only): true once `start()` completes (`harness.resume` + `pluginHost.reconcile`). */
  get started(): boolean {
    return this.#started
  }

  async start(): Promise<void> {
    this.assertWritable()
    if (this.#started) return
    if (this.startPromise) return this.startPromise
    const attempt = (async () => {
      // Startup node-join grace (bounded, skip-if-empty): when recovery depends on registered remote
      // nodes that are currently offline, wait for their reconnection before driving plugin recovery
      // and the scheduler — remote-bound turns/workflows then see online nodes (platform facts, AGENTS.md
      // reads, RPC reattach all converge) instead of failing fast on a race the Hub itself created by
      // listening only after recovery. Only meaningful when the composition root already opened the
      // /ws/node gateway (listen-before-start); waiting without a listener is a no-op bounded sleep,
      // so `autoResume` startup (kernel opened and started before any server) skips it entirely.
      const graceMs = this.init.nodeJoinGraceMs ?? 0
      if (graceMs > 0 && !this.init.autoResume && !this.nodeJoinGraceDone) {
        const needed = new Set<string>()
        for (const meta of this.store.listConvs()) {
          if (meta.nodeId === 'local' || meta.nodeId === '') continue
          if (!this.svc.tracker.hasRunnableWork(meta.id)) continue
          if (!this.nodes.hasNode(meta.nodeId)) continue
          if (this.envFabric.isOnline(meta.nodeId)) continue
          needed.add(meta.nodeId)
        }
        await waitForNodesOnline({
          nodeIds: needed,
          timeoutMs: graceMs,
          isOnline: (nodeId) => this.envFabric.isOnline(nodeId),
          onNodeChanged: (listener) => this.envFabric.registry.onNodeChanged(listener),
        })
        this.nodeJoinGraceDone = true
      }
      if (this.pluginHost) {
        await this.pluginHost.start()
        await this.reconcileActivePluginManagedSkills()
      }
      // Converge recovered / initial conversations once all plugins have mounted runtime providers
      // and model tiers (covers cold-boot deferred `tier/*` resolution and provider thinking-level clamps)
      // before resuming the durable scheduler; skip the full scan when neither tiers/providers/defaults
      // nor profiles changed since recovery already aligned every conversation.
      if (
        this.needsStartupAlignment ||
        this.models.alignmentEpoch !== this.bootAlignModelEpoch ||
        this.svc.profilesSvc.mutationEpoch !== this.bootAlignProfileEpoch
      ) {
        await this.models.alignConversations()
        this.needsStartupAlignment = false
        this.bootAlignModelEpoch = this.models.alignmentEpoch
        this.bootAlignProfileEpoch = this.svc.profilesSvc.mutationEpoch
      }
      this.harness.resume()
      if (this.pluginHost) await this.pluginHost.reconcile()
      // Flip only after `harness.resume()` and `pluginHost.reconcile()` both succeed: a failed reconcile
      // leaves `#started === false` so retrying `start()` re-runs reconcile and the HTTP `503 hub_starting`
      // gate continues holding external traffic until startup converges.
      if (!this.closed) {
        this.#started = true
        for (const listener of [...this.startedListeners]) {
          try {
            listener()
          } catch (error) {
            this.emitDiagnostic({
              level: 'error',
              source: 'runtime.start',
              message: 'Kernel startup listener failed',
              error,
            })
          }
        }
      }
    })()
    this.startPromise = attempt
    try {
      await attempt
    } finally {
      // Clear in-flight handle only if it is still this attempt (avoids clobbering concurrent retries).
      if (this.startPromise === attempt) this.startPromise = undefined
    }
  }

  setHubUrl(url: string): void {
    if (typeof url !== 'string' || url === '') {
      throw new HelmxError('validation_error', `Hub URL must be a non-empty string: ${String(url)}`, 400)
    }
    this.hubUrlValue = url
    this.hubListenInfoValue = undefined
  }

  setHubListenInfo(info: HubListenInfo): void {
    this.hubListenInfoValue = info
  }

  // ------------------------------------------------------------------
  // Node management delegation (NodeManager)
  // ------------------------------------------------------------------

  /**
   * Synchronous Hub-side check for active work bound to `nodeId` (gates automatic node upgrades).
   * Returns a human-readable busy reason when active work exists, or `undefined` when idle.
   *
   * Boundary: inspects Hub-tracked conversations bound to `nodeId` (active runs, queued inbox,
   * compactions, settling `turn_settled` hooks), pending/active passthrough tunnels, active
   * foreground port-forwarding sessions, and in-flight Hub-initiated remote execs. External
   * processes outside Hub are not visible here; any narrow race after this check falls through
   * safely to the node daemon's own `setDraining(true)` + active-workload drain loop.
   */
  describeNodeBusy(nodeId: string): string | undefined {
    let busyConvs = 0
    for (const meta of this.store.listConvs()) {
      if (meta.nodeId !== nodeId) continue
      if (this.svc.tracker.isConversationBusy(meta.id)) busyConvs += 1
    }
    if (busyConvs > 0) {
      return `active conversation(s) bound to node (${busyConvs})`
    }
    if (this.envFabric.registry.hasActiveTunnels(nodeId)) {
      return 'active passthrough tunnel(s) on node'
    }
    if (this.nodeForward?.list().some((forward) => forward.nodeId === nodeId)) {
      return 'active port-forwarding session(s) on node'
    }
    if (this.envFabric.registry.hasActiveOutputSinks(nodeId) || this.nodes.activeExecCount(nodeId) > 0) {
      return 'in-flight remote exec(s) on node'
    }
    return undefined
  }

  refreshPluginTools(): void {
    if (this.pluginHost === undefined) return
    this.svc.toolRegistry.installPluginTools(this.pluginHost.listTools())
  }

  get plugins(): PluginHost {
    if (this.pluginHost === undefined) {
      throw new HelmxError('internal_error', 'PluginHost is not attached to KernelRuntime yet (initialize not called)', 500)
    }
    return this.pluginHost
  }

  private async dispatchTurnSettled(payload: TurnSettledPayload, consumed: ConversationInput[]): Promise<void> {
    const convId = payload.conversation.id
    const turnEvent: TurnSettledPayload = { ...payload, inputs: consumed }
    try {
      const outcome = await this.svc.hookBridge.runHookChain('turn_settled', turnEvent)
      if (outcome?.action === 'handled') return
      this.events.publish('turn.settled', outcome?.action === 'transform' ? outcome.value : turnEvent)
    } catch (error) {
      // Collected into `settledInflight` (joined during teardown): plugin hook or event publish throws
      // must never reject (which would block shutdown and poison the aggregate chain); log diagnostics instead.
      this.emitDiagnostic({
        level: 'error',
        source: 'runtime.turn_settled',
        message: 'turn_settled dispatch failed',
        error,
        conversationId: convId,
      })
    }
  }

  /** Read-only activity snapshot for the Hub's process-private heartbeat file (launcher update
   * busy-gate): derived synchronously from the live conversation mirrors — active runs (including
   * approval-blocked runs whose tool call is still in flight), in-flight context compactions,
   * queued inbox input, and in-flight turn settlement all count as busy so the launcher never
   * stops a Hub mid-work without an explicit --force. */
  activitySnapshot(): HubActivityCounts {
    return this.conversations.activitySnapshot()
  }

  /** Register a synchronous idle→busy activity transition listener (activity heartbeat wiring). */
  onActivityBusyEntered(listener: () => void): () => void {
    return this.conversations.onActivityBusyEntered(listener)
  }

  // ------------------------------------------------------------------
  // Service & context Getters
  // ------------------------------------------------------------------

  get hubUrl(): string { return this.hubUrlValue }
  get hubListenInfo(): HubListenInfo | undefined { return this.hubListenInfoValue }
  get processToken(): string | undefined { return this.processTokenHandle?.tokenOf() }
  get pluginConfigStore(): HelmxPluginConfigStore { return this.svc.pluginConfig }
  get profiles(): ProfileService { return this.svc.profilesSvc }
  get skills(): SkillService { return this.svc.skillsSvc }
  get artifacts(): SvcArtifactService { return this.svc.artifactsSvc }
  get auth(): SvcAuthService { return this.svc.authSvc }
  get credentials(): CredentialService { return this.svc.credentialsSvc }
  get providers(): ProviderService { return this.svc.providersSvc }
  get stash(): SecretStash { return this.stashService }
  /** @internal exposed for tests and internal coordinator access */
  private get tracker() { return this.svc.tracker }
  /** @internal exposed for tests to inspect internal `toolDeps` */
  private get toolDeps() { return this.svc.toolDeps }

  get services(): {
    profiles: ProfileService
    skills: SkillService
    artifacts: SvcArtifactService
    auth: SvcAuthService
    credentials: CredentialService
    providers: ProviderService
    stash: SecretStash
  } {
    return {
      profiles: this.svc.profilesSvc,
      skills: this.svc.skillsSvc,
      artifacts: this.svc.artifactsSvc,
      auth: this.svc.authSvc,
      credentials: this.svc.credentialsSvc,
      providers: this.svc.providersSvc,
      stash: this.stashService,
    }
  }

  private safeSummary(id: number): ConversationSummary | undefined {
    const meta = this.store.getConv(id)
    if (!meta) return undefined
    try {
      return this.conversations.withOwnership(this.svc.tracker.summaryOf(id))
    } catch {
      return this.conversations.withOwnership(summaryOf({ meta, status: 'idle', pendingAskCount: 0 }))
    }
  }

  get isClosing(): boolean {
    return this.closed
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const listener of [...this.closeListeners]) {
      try {
        listener()
      } catch (error) {
        this.emitDiagnostic({
          level: 'error',
          source: 'runtime.close',
          message: 'Kernel close listener failed',
          error,
        })
      }
    }
    this.closeListeners.clear()
    this.startedListeners.clear()
    // With autoResume=false, `start()` may still be in flight: wait for it to settle first (ignore failures
    // so shutdown proceeds) to avoid racing teardown against plugin service startup (e.g., disposing mid-start).
    if (this.startPromise !== undefined) await this.startPromise.catch(() => {})
    await teardownKernelRuntime({
      models: this.models,
      assetReloader: this.svc.assetReloader,
      nodes: this.nodes,
      settledInflight: () => this.settledInflight,
      store: this.store,
      harness: this.harness,
      tracker: this.svc.tracker,
      pluginHost: this.pluginHost,
      nodeForward: this.nodeForward,
      envFabric: this.envFabric,
      processTokenHandle: this.processTokenHandle,
      database: this.database,
      events: this.events,
      sessionDocStreams: this.svc.sessionDocStreams,
      sessionDocLifecycleRelease: this.svc.sessionDocLifecycleRelease,
      stashService: this.stashService,
      emitDiagnostic: (input) => this.emitDiagnostic(input),
    })
    clearRegistryToolAbortFallbacks(this.registry)
    this.processTokenHandle = undefined
  }
}
