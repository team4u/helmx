/**
 * PluginHostCore: foundational lifecycle, registry, hook, capability, action, config,
 * document, and task-tracking engine for `PluginHost` (free of external DX/doctor cycles).
 */
import {
  HelmxError,
  compareCodeUnit,
  isBuiltinNamespace,
  isCoreNamespace,
  isValidCoreOwnerId,
  type ActionManifest,
  type ConversationSummary,
  type HookName,
  type HookPayloadMap,
  type HookResult,
  type LocalizedText,
  type PluginActionContext,
  type PluginActionSpec,
  type PluginBuildProvider,
  type PluginClientBundle,
  type PluginConfigFieldSchema,
  type PluginConfigFieldSource,
  type PluginDefinition,
  type PluginDiagnosticError,
  type PluginManifestProjection,
  type PluginPackageManagerPort,
  type PluginSummary,
  type PluginToolContext,
  type PluginUiContribution,
  type ProvidedCapability,
  type PublicPluginDoc,
  type PublicPluginSessionDoc,
} from '@helmx/protocol';
import { createKeyedMutex } from '../shared/keyed-mutex.js';
import { HOOK_ALLOWED_ACTIONS, HookPipeline } from './hooks.js';
import { buildPluginManifestProjection } from './manifest-projection.js';
import { PluginTaskTracker } from './tracking.js';
import { PluginDocRegistry } from './doc-registry.js';
import { PluginKvRegistry } from './kv-registry.js';
import { CapabilityServiceRegistry } from './capability-service-registry.js';
import {
  CapabilityRegistry,
  type ActionCallerIdentity,
  type DerivedToolSpec,
  type PluginRouteEntry,
  parseQualifiedActionId,
} from './capability-registry.js';
import { UiRegistry } from './ui-registry.js';
import type {
  PluginConfigStore,
  PluginHostOptions,
  PluginState,
} from './types.js';
import { createPluginContext } from './plugin-context.js';
import { assertProviderAvailable } from './provider-coordinator.js';
import {
  assertActive,
  assertContextUsable,
  assertDefinition,
  buildPublicConfig,
  disposePlugins,
  getActiveEnabledPluginIds,
  getIdleActivePluginIds,
  isPluginStateActive,
  resolveEffectiveConfig,
} from './lifecycle-helpers.js';
import { PluginHostGate } from './plugin-host-gate.js';
import { enabledStatesInDependencyOrder, enabledStatesInReconcileOrder } from './plugin-host-deps.js';
import {
  runServiceReconcileBarrier,
  runServiceStartBarrier,
  stopEnabledPluginServices,
} from './plugin-host-barrier.js';
import { dispatchPluginHook, dispatchPluginHookAround } from './plugin-host-hooks.js';
import {
  registerFailedPlaceholder,
  removePluginRegistries,
  requirePlugin,
  rollbackIsolatedPlugin,
  summaryWithManagedPackage,
  teardownPluginState,
  type PluginHostRegistries,
} from './plugin-host-transitions.js';
import {
  runDisableTransaction,
  runEnableTransaction,
  runRegisterTransaction,
  runUnregisterTransaction,
  type PluginLifecycleContext,
} from './plugin-host-lifecycle.js';

export interface PluginRegisterOptions {
  enabled?: boolean;
  isolateFailure?: boolean;
  /** Explicit dry-run manifest projection callback (used by `doctorPluginDir` prior to `enabled: false` teardown). */
  onManifestProjected?: (manifest: PluginManifestProjection) => void;
}

export class PluginHostCore {
  protected plugins = new Map<string, PluginState>();
  /** Reserved `core:*` action owners (kernel-owned; invisible in `list()` / Plugin Center). */
  protected coreOwnerIds = new Set<string>();
  protected pipelines = new Map<HookName, HookPipeline<HookName>>();
  protected tracker = new PluginTaskTracker();
  protected docRegistry: PluginDocRegistry;
  protected kvRegistry: PluginKvRegistry;
  protected capabilityRegistry = new CapabilityRegistry();
  protected capabilityServiceRegistry = new CapabilityServiceRegistry();
  protected uiRegistry: UiRegistry;
  protected configStore?: PluginConfigStore;
  private configWriteMutex = createKeyedMutex<string>();
  protected disposed = false;
  protected registerSeq = 0;
  protected servicesStarted: boolean;
  protected servicesReconciled = false;
  protected startPromise?: Promise<void>;
  protected reconcilePromise?: Promise<void>;
  protected gate = new PluginHostGate();
  protected packageManager?: PluginPackageManagerPort;
  private releaseConversationDeletedListener?: () => void;

  constructor(protected readonly options: PluginHostOptions) {
    this.configStore = options.config;
    this.uiRegistry = new UiRegistry(options.buildProvider, (id) => this.getPluginLifecycle(id));
    this.servicesStarted = options.deferServices !== true;
    for (const name of Object.keys(HOOK_ALLOWED_ACTIONS) as HookName[]) {
      this.pipelines.set(name, new HookPipeline(name));
    }
    this.docRegistry = new PluginDocRegistry(
      options.docs,
      (pluginId, name, val) => this.emitDocUpdated(pluginId, name, val),
      {
        sessionStore: options.sessionDocs,
        assertConversationExists: (conversationId) => options.host.getConversation(conversationId),
        emitSessionDocUpdated: (doc) => {
          options.host.emitEvent('plugin.session_doc.updated', {
            type: 'plugin.session_doc.updated',
            doc,
          });
        },
      },
    );
    this.kvRegistry = new PluginKvRegistry(
      options.kv,
      (text) => this.redactProjectionText(text),
      { maxValueBytes: options.maxKvValueBytes },
    );
  }

  // --- register and lifecycle -------------------------------------------------------

  async register(
    definition: PluginDefinition,
    options: PluginRegisterOptions = {},
  ): Promise<void> {
    this.assertNotDisposed();
    assertDefinition(definition);
    if (isCoreNamespace(definition.id)) {
      throw new HelmxError(
        'invalid_plugin_definition',
        `Plugin id '${definition.id}' cannot use reserved 'core:' namespace`,
        400,
        { pluginId: definition.id },
      );
    }
    const seq = ++this.registerSeq;
    const pluginId = definition.id;
    const isolate = options.isolateFailure === true && !isBuiltinNamespace(pluginId);

    await this.gate.enqueue(pluginId, async () => {
      this.assertNotDisposed();
      await runRegisterTransaction(definition, options, seq, isolate, this.lifecycleContext());
    });
  }

  /** Register a kernel-owned action under the reserved `core:*` namespace. */
  registerCoreAction<TIn, TOut>(ownerId: string, spec: PluginActionSpec<TIn, TOut>): void {
    this.assertNotDisposed();
    if (typeof ownerId !== 'string' || !isValidCoreOwnerId(ownerId)) {
      throw new HelmxError(
        'invalid_core_action_owner',
        `Core action ownerId must start with 'core:' and match /^core:[A-Za-z0-9_-]+$/: ${String(ownerId)}`,
        400,
        { ownerId },
      );
    }
    this.capabilityRegistry.registerAction(ownerId, spec);
    this.coreOwnerIds.add(ownerId);
  }

  registerFailed(spec: {
    id: string;
    name?: LocalizedText;
    description?: LocalizedText;
    version?: string;
    error: PluginDiagnosticError;
  }): void {
    this.assertNotDisposed();
    if (typeof spec.id === 'string' && isCoreNamespace(spec.id)) {
      throw new HelmxError(
        'invalid_plugin_definition',
        `Plugin id '${spec.id}' cannot use reserved 'core:' namespace`,
        400,
        { pluginId: spec.id },
      );
    }
    registerFailedPlaceholder(spec, this.lifecycleContext());
  }

  async unregister(pluginId: string): Promise<void> {
    this.assertNotDisposed();
    await this.gate.enqueue(pluginId, async () => {
      this.assertNotDisposed();
      await runUnregisterTransaction(pluginId, this.lifecycleContext());
    });
  }

  async enable(pluginId: string): Promise<void> {
    this.assertNotDisposed();
    await this.gate.enqueue(pluginId, async () => {
      this.assertNotDisposed();
      await runEnableTransaction(pluginId, this.lifecycleContext());
    });
  }

  async disable(pluginId: string, options: { force?: boolean } = {}): Promise<void> {
    this.assertNotDisposed();
    await this.gate.enqueue(pluginId, async () => {
      this.assertNotDisposed();
      await runDisableTransaction(pluginId, options, this.lifecycleContext());
    });
  }

  async start(): Promise<void> {
    this.assertNotDisposed();
    if (this.servicesStarted) return;
    if (this.startPromise) return this.startPromise;
    const run = this.gate.withWriteLock(async () => {
      if (this.servicesStarted) return;
      await runServiceStartBarrier(
        enabledStatesInDependencyOrder(this.plugins),
        (state, err) => rollbackIsolatedPlugin(state, err, 'enable', this.lifecycleContext()),
      );
      this.servicesStarted = true;
    });
    this.startPromise = run;
    try {
      await run;
    } finally {
      this.startPromise = undefined;
    }
  }

  async reconcile(): Promise<void> {
    this.assertNotDisposed();
    if (this.servicesReconciled) return;
    if (this.reconcilePromise) return this.reconcilePromise;
    const run = this.gate.withWriteLock(async () => {
      if (this.servicesReconciled) return;
      if (!this.servicesStarted) {
        throw new HelmxError(
          'plugin_host_not_started',
          'Cannot run PluginHost.reconcile() before PluginHost.start() has started services',
          409,
        );
      }
      await runServiceReconcileBarrier(
        enabledStatesInReconcileOrder(this.plugins),
        (state, err) => rollbackIsolatedPlugin(state, err, 'enable', this.lifecycleContext()),
      );
      this.servicesReconciled = true;
    });
    this.reconcilePromise = run;
    try {
      await run;
    } finally {
      this.reconcilePromise = undefined;
    }
  }

  async stop(): Promise<void> {
    this.assertNotDisposed();
    await this.gate.withWriteLock(async () => {
      if (!this.servicesStarted) return;
      try {
        await stopEnabledPluginServices(enabledStatesInDependencyOrder(this.plugins));
      } finally {
        this.servicesStarted = false;
        this.servicesReconciled = false;
      }
    });
  }

  // --- query and capability manifest -------------------------------------------------------

  list(): PluginSummary[] {
    this.assertNotDisposed();
    return [...this.plugins.values()].map((s) => this.summaryOf(s));
  }

  get(pluginId: string): PluginSummary | undefined {
    this.assertNotDisposed();
    const s = this.plugins.get(pluginId);
    return s ? this.summaryOf(s) : undefined;
  }

  getManifest(pluginId: string): PluginManifestProjection {
    this.assertNotDisposed();
    const s = requirePlugin(this.plugins, pluginId);
    return this.manifestOf(s);
  }

  listManifests(): PluginManifestProjection[] {
    this.assertNotDisposed();
    return [...this.plugins.values()]
      .map((s) => this.manifestOf(s))
      .sort((a, b) => compareCodeUnit(a.id, b.id));
  }

  assertProviderAvailable(pluginId: string): void {
    assertProviderAvailable(this.plugins.get(pluginId), pluginId);
  }

  listTools(conversation?: ConversationSummary): DerivedToolSpec[] {
    this.assertNotDisposed();
    return this.capabilityRegistry.listTools(getActiveEnabledPluginIds(this.plugins), conversation);
  }

  listRoutes(): PluginRouteEntry[] {
    this.assertNotDisposed();
    return this.capabilityRegistry.listRoutes(getActiveEnabledPluginIds(this.plugins));
  }

  listActions(): ActionManifest[] {
    this.assertNotDisposed();
    const activeIds = getActiveEnabledPluginIds(this.plugins);
    if (this.coreOwnerIds.size === 0) {
      return this.capabilityRegistry.listActions(activeIds);
    }
    return this.capabilityRegistry.listActions([...activeIds, ...this.coreOwnerIds]);
  }

  listUi(): PluginUiContribution[] {
    this.assertNotDisposed();
    return this.uiRegistry.listUi(getActiveEnabledPluginIds(this.plugins));
  }

  consumeCapability<T>(capabilityId: string): ReadonlyArray<ProvidedCapability<T>> {
    this.assertNotDisposed();
    return this.capabilityServiceRegistry.consume<T>(
      capabilityId,
      new Set(getActiveEnabledPluginIds(this.plugins)),
    );
  }

  onCapabilityChanged(capabilityId: string, listener: () => void): () => void {
    this.assertNotDisposed();
    return this.capabilityServiceRegistry.onCapabilityChanged(capabilityId, listener);
  }

  getBuildProvider(): PluginBuildProvider | undefined {
    return this.options.buildProvider;
  }

  notifyPluginChanged(pluginId: string): void {
    if (this.disposed) return;
    const state = this.plugins.get(pluginId);
    if (state !== undefined) this.emitPluginChanged(state);
  }

  // --- client.tsx compile artifact and public document ----------------------------------------

  private getPluginLifecycle = (id: string) => {
    const s = this.plugins.get(id);
    if (!s) return undefined;
    return {
      identity: s,
      enabled: isPluginStateActive(s),
      phase: s.phase,
      epoch: s.epoch,
      clientRoot: s.definition.clientRoot,
      prebuiltClientDir: s.definition.prebuiltClientDir,
      npmDependencies: s.definition.npmDependencies,
    };
  };

  async getClientModule(
    pluginId: string,
    moduleRef: string,
    options?: { chunk?: string; hash?: string; metadataOnly?: boolean },
  ): Promise<PluginClientBundle> {
    this.assertNotDisposed();
    return this.uiRegistry.getClientModule(pluginId, moduleRef, {
      chunk: options?.chunk,
      hash: options?.hash,
      metadataOnly: options?.metadataOnly,
      getPluginLifecycle: this.getPluginLifecycle,
      dataDir: this.options.dataDir,
      isDisposed: () => this.disposed,
    });
  }

  getPublicDoc(pluginId: string, name: string): PublicPluginDoc {
    this.assertNotDisposed();
    const state = this.plugins.get(pluginId);
    return this.docRegistry.getPublicDoc(pluginId, name, state !== undefined && isPluginStateActive(state));
  }

  getPublicSessionDoc(pluginId: string, name: string, conversationId: number): PublicPluginSessionDoc {
    this.assertNotDisposed();
    const state = this.plugins.get(pluginId);
    return this.docRegistry.getPublicSessionDoc(pluginId, name, conversationId, state !== undefined && isPluginStateActive(state));
  }

  listPublicDocs(): PublicPluginDoc[] {
    this.assertNotDisposed();
    return this.docRegistry.listPublicDocs(getIdleActivePluginIds(this.plugins));
  }

  // --- Hook / Action / Tool execute --------------------------------------------

  async runHook<K extends HookName>(name: K, payload: HookPayloadMap[K]): Promise<HookResult<HookPayloadMap[K]>> {
    this.assertNotDisposed();
    return dispatchPluginHook(name, payload, {
      plugins: this.plugins,
      pipelines: this.pipelines,
      tracker: this.tracker,
      host: this.options.host,
      redactText: this.options.redactText,
    });
  }

  async runHookAround(
    name: 'agent_spawn',
    payload: HookPayloadMap['agent_spawn'],
    defaultRun: (finalPayload: HookPayloadMap['agent_spawn']) => Promise<unknown>,
  ): Promise<unknown> {
    this.assertNotDisposed();
    return dispatchPluginHookAround(name, payload, defaultRun, {
      plugins: this.plugins,
      pipelines: this.pipelines,
      tracker: this.tracker,
      host: this.options.host,
      redactText: this.options.redactText,
    });
  }

  static parseQualifiedActionId(qualified: string): { pluginId: string; actionId: string } {
    return parseQualifiedActionId(qualified);
  }

  private getCapabilityExecutionOptions() {
    return {
      assertActive: (pluginId: string) => {
        this.assertNotDisposed();
        if (this.coreOwnerIds.has(pluginId)) return;
        assertActive(requirePlugin(this.plugins, pluginId));
      },
      getConversation: (id: number) => this.options.host.getConversation(id),
      tracker: this.tracker,
      isPluginRegistered: (pluginId: string) => this.plugins.has(pluginId) || this.coreOwnerIds.has(pluginId),
    };
  }

  prepareAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context: PluginActionContext = {},
    caller: ActionCallerIdentity = { surface: 'http' },
  ): { idempotent: boolean } {
    this.assertNotDisposed();
    return this.capabilityRegistry.prepareAction(
      pluginId,
      actionId,
      input,
      context,
      { ...this.getCapabilityExecutionOptions(), caller },
    );
  }

  async invokeAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context: PluginActionContext = {},
    caller: ActionCallerIdentity = { surface: 'http' },
  ): Promise<unknown> {
    this.assertNotDisposed();
    return this.capabilityRegistry.invokeAction(
      pluginId,
      actionId,
      input,
      context,
      { ...this.getCapabilityExecutionOptions(), caller },
    );
  }

  async executeTool(name: string, input: unknown, context: PluginToolContext): Promise<unknown> {
    this.assertNotDisposed();
    return this.capabilityRegistry.executeTool(
      name,
      input,
      context,
      this.getCapabilityExecutionOptions(),
    );
  }

  // --- config ----------------------------------------------------------------

  getConfig(pluginId: string): Record<string, unknown> {
    this.assertNotDisposed();
    const state = this.plugins.get(pluginId);
    const stored = this.configStore ? this.configStore.get(pluginId) : {};
    if (!state) return { ...stored };
    return this.effectiveConfigOf(state, stored);
  }

  getConfigSchema(pluginId: string): Record<string, PluginConfigFieldSchema> {
    this.assertNotDisposed();
    const state = requirePlugin(this.plugins, pluginId);
    return state.configSchema ? { ...state.configSchema } : {};
  }

  /** config field source mapping: configured (disk explicit) / default (schema fallback) / unset. */
  getConfigSources(pluginId: string): Record<string, PluginConfigFieldSource> {
    this.assertNotDisposed();
    const schema = requirePlugin(this.plugins, pluginId).configSchema ?? {};
    const stored = this.configStore ? this.configStore.get(pluginId) : {};
    const sources: Record<string, PluginConfigFieldSource> = {};
    for (const [key, field] of Object.entries(schema)) {
      const has = Object.hasOwn(stored, key) && stored[key] !== undefined;
      const configured =
        field.secret === true
          ? has && typeof stored[key] === 'string' && (stored[key] as string).length > 0
          : has;
      if (configured) sources[key] = 'configured';
      else if (field.default !== undefined) sources[key] = 'default';
      else sources[key] = 'unset';
    }
    return sources;
  }

  async setConfig(pluginId: string, value: Record<string, unknown>): Promise<void> {
    this.assertNotDisposed();
    requirePlugin(this.plugins, pluginId);
    const store = this.configStore;
    if (!store) {
      throw new HelmxError(
        'config_store_unavailable',
        'PluginHost has no persistent PluginConfigStore wired; modifying plugin config is not supported',
        501,
        { pluginId },
      );
    }
    return this.configWriteMutex.run(pluginId, async () => {
      this.assertNotDisposed();
      const state = requirePlugin(this.plugins, pluginId);
      const schema = state.configSchema ?? {};
      await store.set(pluginId, value, schema);
      if (!this.disposed && this.plugins.get(pluginId) === state) {
        this.emitPluginChanged(state);
      }
    });
  }

  // --- disposal and in-flight task tracking ---------------------------------------------------

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const releaseConvDeleted = this.releaseConversationDeletedListener;
    this.releaseConversationDeletedListener = undefined;
    releaseConvDeleted?.();
    await this.gate.drain();
    const statesSnapshot = [...this.plugins.values()];
    try {
      await disposePlugins(
        this.plugins,
        (state) => teardownPluginState(state, { stopServices: true }, this.registries()),
        this.tracker,
        (id) => removePluginRegistries(id, this.registries()),
      );
    } finally {
      for (const coreOwnerId of this.coreOwnerIds) {
        this.tracker.removePlugin(coreOwnerId);
        this.capabilityRegistry.removePlugin(coreOwnerId);
      }
      this.coreOwnerIds.clear();
      for (const state of statesSnapshot) {
        const release = state.releaseTsRoot;
        state.releaseTsRoot = undefined;
        release?.();
      }
    }
  }

  beginSpawnTask(pluginId: string, spawnId: string): void { this.tracker.begin(pluginId, `spawn:${spawnId}`); }
  endSpawnTask(pluginId: string, spawnId: string): void { this.tracker.end(pluginId, `spawn:${spawnId}`); }
  beginTask(pluginId: string, label: string): void { this.tracker.begin(pluginId, label); }
  endTask(pluginId: string, label: string): void { this.tracker.end(pluginId, label); }
  withTask<T>(pluginId: string, label: string, fn: () => Promise<T>): Promise<T> { return this.tracker.withTask(pluginId, label, fn); }
  activeTaskCount(pluginId: string): number { this.assertNotDisposed(); return this.tracker.activeCount(pluginId); }

  // --- protected helpers ----------------------------------------------------------------------

  protected registries(): PluginHostRegistries {
    return {
      pipelines: this.pipelines,
      capabilityRegistry: this.capabilityRegistry,
      capabilityServiceRegistry: this.capabilityServiceRegistry,
      uiRegistry: this.uiRegistry,
      docRegistry: this.docRegistry,
    };
  }

  protected lifecycleContext(): PluginLifecycleContext {
    return {
      ...this.registries(),
      plugins: this.plugins,
      tracker: this.tracker,
      configStore: this.configStore,
      dataDir: this.options.dataDir,
      host: this.options.host,
      providers: this.options.providers,
      buildProvider: this.options.buildProvider,
      servicesStarted: this.servicesStarted,
      servicesReconciled: this.servicesReconciled,
      redactText: (text) => this.redactProjectionText(text),
      emitPluginChanged: (state) => this.emitPluginChanged(state),
      createPluginContext: (state, epoch) => this.createContext(state, epoch),
      getPluginLifecycle: this.getPluginLifecycle,
      ensureTransientSessionDocListener: (pluginId) => this.ensureTransientSessionDocCleanupListener(pluginId),
      isDisposed: () => this.disposed,
    };
  }

  private createContext(state: PluginState, epoch: number) {
    return createPluginContext({
      state,
      epoch,
      pipelines: this.pipelines,
      capabilityRegistry: this.capabilityRegistry,
      capabilityServiceRegistry: this.capabilityServiceRegistry,
      uiRegistry: this.uiRegistry,
      docRegistry: this.docRegistry,
      kvRegistry: this.kvRegistry,
      configStore: this.configStore,
      getActivePluginIds: () => new Set(getActiveEnabledPluginIds(this.plugins)),
      hostDeps: {
        backend: this.options.host,
        tracker: this.tracker,
        options: this.options,
        plugins: this.plugins,
        list: () => this.list(),
        listUi: () => this.listUi(),
        listActions: () => this.listActions(),
        invokeAction: (target, action, input, ctx) =>
          this.invokeAction(target, action, input, ctx, { surface: 'plugin', callerPluginId: state.definition.id }),
        prepareAction: (target, action, input, ctx) =>
          this.prepareAction(target, action, input, ctx, { surface: 'plugin', callerPluginId: state.definition.id }),
        assertContextUsable: (s, ep, what) => this.assertContextUsable(s, ep, what),
      },
      assertNotDisposed: () => this.assertNotDisposed(),
      assertContextUsable: (s, ep, what) => this.assertContextUsable(s, ep, what),
      isRegisteredState: (s) => this.plugins.get(s.definition.id) === s,
    });
  }

  private assertContextUsable(state: PluginState, epoch: number, what: string): void {
    assertContextUsable(state, epoch, what, this.plugins.get(state.definition.id), this.disposed);
  }

  private emitDocUpdated(pluginId: string, name: string, value: unknown): void {
    const doc: PublicPluginDoc = { pluginId, name, value };
    this.options.host.emitEvent('plugin.doc.updated', { type: 'plugin.doc.updated', doc });
  }

  private effectiveConfigOf(
    state: PluginState,
    stored: Record<string, unknown> = this.configStore ? this.configStore.get(state.definition.id) : {},
  ): Record<string, unknown> {
    return resolveEffectiveConfig(state.configSchema, stored);
  }

  private redactProjectionText(text: string): string {
    const redactedByHost = this.options.host.redact(text);
    return this.options.redactText ? this.options.redactText(redactedByHost) : redactedByHost;
  }

  private manifestOf(state: PluginState): PluginManifestProjection {
    return buildPluginManifestProjection({
      state,
      capabilityRegistry: this.capabilityRegistry,
      uiRegistry: this.uiRegistry,
      docRegistry: this.docRegistry,
      redactText: (text) => this.redactProjectionText(text),
    });
  }

  private summaryOf(state: PluginState): PluginSummary {
    const publicConfig = buildPublicConfig(
      state,
      this.effectiveConfigOf(state),
      (text) => this.redactProjectionText(text),
    );
    return summaryWithManagedPackage(
      state,
      this.capabilityRegistry,
      this.uiRegistry,
      this.packageManager,
      publicConfig,
    );
  }

  private ensureTransientSessionDocCleanupListener(pluginId: string): void {
    if (this.disposed || this.releaseConversationDeletedListener !== undefined) return;
    if (!this.docRegistry.hasTransientSessionDocs(pluginId)) return;
    this.releaseConversationDeletedListener = this.options.host.onEvent(
      'conversation.deleted',
      (event) => {
        if (this.disposed) return;
        const conversationId = (event as { conversationId?: unknown } | undefined)?.conversationId;
        if (typeof conversationId === 'number' && Number.isSafeInteger(conversationId)) {
          this.docRegistry.deleteConversation(conversationId);
        }
      },
    );
  }

  protected emitPluginChanged(state: PluginState): void {
    this.options.host.emitEvent('plugin.changed', {
      type: 'plugin.changed',
      plugin: this.summaryOf(state),
      ui: isPluginStateActive(state) ? this.uiRegistry.getUiByPlugin(state.definition.id) : [],
    });
  }

  protected assertNotDisposed(): void {
    if (this.disposed) {
      throw new HelmxError('plugin_host_disposed', 'PluginHost has already been disposed', 409);
    }
  }
}
