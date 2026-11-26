/**
 * Model catalog registry: manages `Models` instances, runtime providers, dynamic catalog refreshes,
 * and global default model / reasoning effort configuration.
 *
 * Serialization guarantee: reload / register / unregister / refresh all queue onto `modelsChain`
 * so stale concurrent rebuilds cannot overwrite newer sets; when `Models` is externally injected
 * (tests/embedded), ownership stays with the caller and mutating paths no-op.
 */
import type { Models, Provider } from '@earendil-works/pi-ai/models'
import type { ModelsStore } from '@earendil-works/pi-ai'
import type {
  ModelCatalog,
  ModelProvidersRefreshResult,
  ModelTierSpec,
} from '@helmx/protocol'
import { HelmxError, MODEL_TIER_PREFIX } from '@helmx/protocol'
import type { ConfigService, CredentialService, ProviderService, SecretStash } from '../services/index.js'
import { createDiagnosticEmitter, type KernelDiagnosticEmitter } from './diagnostics.js'
import {
  assertConfigThinkingLevel,
  assertInputThinkingLevel,
  assertModelsStoreHealthy,
  buildModelTierCatalogEntries,
  parseDisabledModelsConfig,
  parseModelRefOrThrow,
  parseModelThinkingLevelsConfig,
  validateModelThinkingLevels,
  validateModelThinkingUpdate,
  getModelDefaults,
  modelDefaultsFromCatalog,
  normalizeModelRefreshInput,
  updateModelDefaults,
  type ModelDefaultsPatch,
  type ModelDefaultsPort,
  type ModelDefaultsSnapshot,
} from './model-config-helpers.js'
import { ModelTiersCoordinator, type ModelTiersCapabilityHost } from './model-tiers-coordinator.js'
import { RuntimeProviderTracker } from './model-runtime-providers.js'
import { buildModels, listModelCatalog, listModelProviders, type ResolvedModelRef } from './models.js'

export type {
  ModelDefaultsPatch,
  ModelDefaultsPort,
  ModelDefaultsSnapshot,
  ResolvedModelRef,
}
export {
  getModelDefaults,
  modelDefaultsFromCatalog,
  normalizeModelRefreshInput,
  updateModelDefaults,
}

export interface ModelRegistryOptions {
  readonly dataDir: string
  readonly providersSvc: ProviderService
  readonly credentialsSvc: CredentialService
  readonly configSvc: ConfigService
  readonly stash: SecretStash
  readonly modelsStore: ModelsStore
  /** Hot-swap slot (`Harness` `models` getter reads the latest instance through this). */
  readonly setModels: (m: Models) => void
  /** Externally injected `Models` (tests): all mutating registry paths become no-ops or reject. */
  readonly externalModels: boolean
  readonly events: { publish(type: 'models.changed', payload: { providers: string[] }): void }
  /** Lazily injected `PluginHost` (used for `assertProviderAvailable` preflight). */
  readonly pluginHost: () => { assertProviderAvailable(pluginId: string): void } | undefined
  /** Align effective models across all conversations after default model changes (host implementation). */
  readonly alignAllConversations: () => Promise<void>
  /** Shutdown check (optional in standalone tests; defaults to open). */
  readonly isClosed?: () => boolean
  /** Writability guard (optional in standalone tests; throws on fatal storage error or closed runtime). */
  readonly assertWritable?: () => void
  /** Diagnostic emitter for async tier/alignment warnings (optional; defaults to redacted console emitter). */
  readonly emitDiagnostic?: KernelDiagnosticEmitter
}

export class ModelRegistry {
  private readonly providersSvc: ProviderService
  private readonly credentialsSvc: CredentialService
  private readonly configSvc: ConfigService
  private readonly stash: SecretStash
  private readonly modelsStore: ModelRegistryOptions['modelsStore']
  private readonly setModels: (m: Models) => void
  private readonly externalModels: boolean
  private readonly events: ModelRegistryOptions['events']
  private readonly alignAllConversations: ModelRegistryOptions['alignAllConversations']
  private readonly isClosed: () => boolean
  private readonly assertWritable: () => void
  private readonly runtimeTracker: RuntimeProviderTracker
  private readonly tiersCoordinator: ModelTiersCoordinator
  private modelsChain: Promise<unknown> = Promise.resolve()
  private modelsRefreshAbort: AbortController | undefined
  private modelsGeneration = 0
  private alignmentEpochValue = 0
  /** Synchronously readable API key cache (warmed on startup, refreshed on reload, consumed by `buildModels` closure). */
  readonly apiKeyCache: Record<string, string> = {}
  private modelsCurrent: Models
  defaultModel: string | undefined
  defaultThinkingLevel: string | undefined
  /** Per-model thinking defaults keyed by full `'provider/modelId'` reference (`config.json.modelThinkingLevels`). */
  modelThinkingLevels: Record<string, string> = {}
  defaultCompactionModel: string | undefined
  defaultCompactionThinkingLevel: string | undefined
  /** Placeholder used in hook payloads when no model is configured (submissions still reject via `requireModelRef`). */
  modelPlaceholder = 'unconfigured'
  /** Explicitly disabled models (`providerId -> modelId[]`; from `config.json.disabledModels`). */
  private disabledModels: Record<string, string[]> = {}

  constructor(
    options: ModelRegistryOptions,
    initialModels: Models,
    defaults: { model?: string; thinkingLevel?: string; compactionModel?: string; compactionThinkingLevel?: string },
  ) {
    this.providersSvc = options.providersSvc
    this.credentialsSvc = options.credentialsSvc
    this.configSvc = options.configSvc
    this.stash = options.stash
    this.modelsStore = options.modelsStore
    this.setModels = options.externalModels ? () => { /* external inject: hot reload must not replace caller model set */ } : options.setModels
    this.externalModels = options.externalModels
    this.events = options.events
    this.alignAllConversations = options.alignAllConversations
    this.isClosed = options.isClosed ?? (() => false)
    this.assertWritable = options.assertWritable ?? (() => {})
    const emitDiagnostic = options.emitDiagnostic ?? createDiagnosticEmitter({ redact: (t) => options.stash.redact(t) })
    this.runtimeTracker = new RuntimeProviderTracker({
      providersSvc: options.providersSvc,
      assertOwnerAvailable: (ownerId) => options.pluginHost()?.assertProviderAvailable(ownerId),
    })
    this.tiersCoordinator = new ModelTiersCoordinator({
      onChanged: () => {
        this.alignmentEpochValue += 1
        this.events.publish('models.changed', { providers: [] })
      },
      alignAllConversations: this.alignAllConversations,
      isClosed: this.isClosed,
      emitDiagnostic,
    })
    this.modelsCurrent = initialModels
    this.defaultModel = defaults.model
    this.defaultThinkingLevel = defaults.thinkingLevel
    this.defaultCompactionModel = defaults.compactionModel
    this.defaultCompactionThinkingLevel = defaults.compactionThinkingLevel
  }

  get models(): Models {
    return this.modelsCurrent
  }

  get alignmentEpoch(): number {
    return this.alignmentEpochValue
  }

  get refreshAbortController(): AbortController | undefined {
    return this.modelsRefreshAbort
  }

  /** Enqueue work onto `modelsChain` (errors propagate to caller without blocking subsequent queued work). */
  private enqueueModelsChange<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.modelsChain.then(fn, fn)
    this.modelsChain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Attach `PluginHost` capability lookup so `ModelRegistry` consumes `'helmx.model-tiers'` automatically. */
  bindPluginHost(host: ModelTiersCapabilityHost): void {
    this.tiersCoordinator.bind(host)
  }

  /** Wait for all in-flight model changes to settle and detach capability listeners before shutdown. */
  async dispose(): Promise<void> {
    this.tiersCoordinator.unbind()
    await this.modelsChain
  }

  /** Re-align all conversations with current defaults, mounted runtime providers, and model tiers. */
  async alignConversations(): Promise<void> {
    await this.alignAllConversations()
  }

  async listModels(): Promise<ModelCatalog> {
    const catalog = await listModelCatalog(this.modelsCurrent, {
      model: this.defaultModel,
      thinkingLevel: this.defaultThinkingLevel,
      modelThinkingLevels: this.modelThinkingLevels,
      compactionModel: this.defaultCompactionModel,
      compactionThinkingLevel: this.defaultCompactionThinkingLevel,
      disabledModels: this.disabledModels,
    })
    const tiers = this.getRegisteredTiers()
    if (Object.keys(tiers).length > 0) {
      catalog.modelTiers = buildModelTierCatalogEntries(catalog, tiers, (p, m) => this.isModelDisabled(p, m))
    }
    return catalog
  }

  /** Collect active runtime model tiers from all mounted `'helmx.model-tiers'` capability providers. */
  getRegisteredTiers(): Record<string, ModelTierSpec> {
    return this.tiersCoordinator.getRegisteredTiers()
  }

  resolveModelRef(ref: string): ResolvedModelRef {
    return this.tiersCoordinator.resolveModelRef(ref)
  }

  listModelProviders() {
    return listModelProviders(this.modelsCurrent, this.runtimeTracker.ownerByProvider)
  }

  /** Read global default model and reasoning effort from `config.json` at startup (throws on invalid format). */
  async loadDefaultsFromConfig(): Promise<void> {
    const raw: Record<string, unknown> = (await this.configSvc.get()) as Record<string, unknown>
    if (this.defaultModel === undefined) {
      const configured = raw['model']
      if (configured !== undefined && configured !== '') {
        if (typeof configured !== 'string' || !/^[^/\s]+\/[^\s]+$/.test(configured)) {
          throw new HelmxError('config_corrupt', 'config.json.model must be a string in provider/model format', 500)
        }
        this.defaultModel = configured
      }
    }
    if (this.defaultThinkingLevel === undefined) {
      const configuredLevel = raw['thinkingLevel'] as string | undefined | null
      if (configuredLevel !== undefined && configuredLevel !== '') {
        assertConfigThinkingLevel(configuredLevel as string, 'config.json.thinkingLevel')
        this.defaultThinkingLevel = configuredLevel as string
      }
    }
    if (this.defaultCompactionModel === undefined) {
      const configuredCompaction = raw['compactionModel']
      if (configuredCompaction !== undefined && configuredCompaction !== '') {
        if (typeof configuredCompaction !== 'string' || !/^[^/\s]+\/[^\s]+$/.test(configuredCompaction)) {
          throw new HelmxError('config_corrupt', 'config.json.compactionModel must be a string in provider/model format', 500)
        }
        this.defaultCompactionModel = configuredCompaction
      }
    }
    if (this.defaultCompactionThinkingLevel === undefined) {
      const configuredCompactionLevel = raw['compactionThinkingLevel'] as string | undefined | null
      if (configuredCompactionLevel !== undefined && configuredCompactionLevel !== '') {
        assertConfigThinkingLevel(configuredCompactionLevel as string, 'config.json.compactionThinkingLevel')
        this.defaultCompactionThinkingLevel = configuredCompactionLevel as string
      }
    }
    this.modelThinkingLevels = parseModelThinkingLevelsConfig(raw['modelThinkingLevels'])
    for (const [ref, level] of Object.entries(this.modelThinkingLevels)) {
      assertConfigThinkingLevel(level, `config.json.modelThinkingLevels['${ref}']`)
    }
    this.disabledModels = parseDisabledModelsConfig(raw['disabledModels'])
    this.modelPlaceholder = this.defaultModel ?? 'unconfigured'
    this.alignmentEpochValue += 1
  }

  /** Set global default model, reasoning effort, compaction model, and compaction reasoning effort (`config.json`). */
  async setDefaultModel(
    model?: string,
    thinkingLevel?: string,
    compactionModel?: string,
    compactionThinkingLevel?: string,
    modelThinkingLevels?: Record<string, string>,
    modelThinkingUpdate?: { model: string; level: string },
  ): Promise<void> {
    this.assertWritable()
    const checkEnabled = (providerId: string, modelId: string): void => this.assertModelEnabled(providerId, modelId)
    const trimmed = model?.trim()
    if (trimmed !== undefined && trimmed !== '') {
      const ref = this.resolveModelRef(trimmed)
      checkEnabled(ref.provider, ref.modelId)
    }
    const trimmedCompaction = compactionModel?.trim()
    if (trimmedCompaction !== undefined && trimmedCompaction !== '') {
      const ref = this.resolveModelRef(trimmedCompaction)
      checkEnabled(ref.provider, ref.modelId)
    }
    const normalizeLevel = (rawLevel: string | undefined): string | undefined => {
      if (rawLevel === undefined) return undefined
      const level = rawLevel.trim()
      if (level !== '') assertInputThinkingLevel(level, 'thinkingLevel')
      return level === '' ? undefined : level
    }
    const nextLevel = normalizeLevel(thinkingLevel)
    const nextCompactionLevel = normalizeLevel(compactionThinkingLevel)
    const nextModelThinkingLevels = modelThinkingLevels === undefined
      ? undefined
      : validateModelThinkingLevels(modelThinkingLevels, checkEnabled)
    const nextModelThinkingUpdate = modelThinkingUpdate === undefined
      ? undefined
      : validateModelThinkingUpdate(modelThinkingUpdate, checkEnabled)
    const updatedModelThinkingLevels = nextModelThinkingLevels !== undefined || nextModelThinkingUpdate !== undefined
    let nextResolvedModelThinkingLevels: Record<string, string> | undefined
    await this.configSvc.updateBy((current) => {
      const next = { ...current }
      if (trimmed === '') delete next.model
      else if (trimmed !== undefined) next.model = trimmed
      if (thinkingLevel !== undefined) {
        if (nextLevel === undefined) delete next.thinkingLevel
        else next.thinkingLevel = nextLevel
      }
      if (trimmedCompaction === '') delete next.compactionModel
      else if (trimmedCompaction !== undefined) next.compactionModel = trimmedCompaction
      if (compactionThinkingLevel !== undefined) {
        if (nextCompactionLevel === undefined) delete next.compactionThinkingLevel
        else next.compactionThinkingLevel = nextCompactionLevel
      }
      if (updatedModelThinkingLevels) {
        const resolved = nextModelThinkingLevels !== undefined
          ? { ...nextModelThinkingLevels }
          : parseModelThinkingLevelsConfig(next['modelThinkingLevels'])
        if (nextModelThinkingUpdate !== undefined) {
          if (nextModelThinkingUpdate.level === '') delete resolved[nextModelThinkingUpdate.model]
          else resolved[nextModelThinkingUpdate.model] = nextModelThinkingUpdate.level
        }
        nextResolvedModelThinkingLevels = resolved
        if (Object.keys(resolved).length === 0) delete next.modelThinkingLevels
        else next.modelThinkingLevels = resolved
      }
      return next
    })
    if (trimmed !== undefined) this.defaultModel = trimmed === '' ? undefined : trimmed
    if (thinkingLevel !== undefined) this.defaultThinkingLevel = nextLevel
    if (trimmedCompaction !== undefined) {
      this.defaultCompactionModel = trimmedCompaction === '' ? undefined : trimmedCompaction
    }
    if (compactionThinkingLevel !== undefined) {
      this.defaultCompactionThinkingLevel = nextCompactionLevel
    }
    if (nextResolvedModelThinkingLevels !== undefined) this.modelThinkingLevels = nextResolvedModelThinkingLevels
    this.modelPlaceholder = this.defaultModel ?? 'unconfigured'
    this.alignmentEpochValue += 1
    // Independent override fields: conversations with a model override still inherit the global reasoning effort.
    if (trimmed !== undefined || thinkingLevel !== undefined || updatedModelThinkingLevels) {
      await this.alignAllConversations()
    }
  }

  /** Validate `'provider/model'` reference (shared by create/update). */
  parseModelRefOrThrow(ref: string): { provider: string; modelId: string } {
    return parseModelRefOrThrow(ref)
  }

  /** Look up the per-model thinking default for a resolved reference (keyed by the full `'provider/modelId'` string). */
  modelThinkingLevelOf(ref: { provider: string; modelId: string }): string | undefined {
    return this.modelThinkingLevels[`${ref.provider}/${ref.modelId}`]
  }

  /**
   * Set or clear one per-model thinking default (`config.json.modelThinkingLevels`): empty `level` clears the
   * single entry (allowed even when the target model is disabled), and the field itself is removed once empty.
   */
  async setModelThinkingDefault(
    model: string,
    level: string,
  ): Promise<void> {
    this.assertWritable()
    const trimmedModel = model.trim()
    if (trimmedModel === '') {
      throw new HelmxError('validation_error', 'Per-model thinking default requires a model reference', 400)
    }
    const ref = parseModelRefOrThrow(trimmedModel)
    if (ref.provider === MODEL_TIER_PREFIX) {
      throw new HelmxError(
        'validation_error',
        `Per-model thinking defaults apply to concrete models only (configure thinkingLevel directly on tier '${trimmedModel}')`,
        400,
      )
    }
    const trimmedLevel = level.trim()
    if (trimmedLevel !== '') {
      assertInputThinkingLevel(trimmedLevel, 'thinking level')
      this.assertModelEnabled(ref.provider, ref.modelId)
    }
    const next = await this.configSvc.updateBy((current) => {
      const merged: Record<string, unknown> = { ...current }
      const existing = parseModelThinkingLevelsConfig(merged['modelThinkingLevels'])
      if (trimmedLevel === '') delete existing[trimmedModel]
      else existing[trimmedModel] = trimmedLevel
      if (Object.keys(existing).length === 0) delete merged['modelThinkingLevels']
      else merged['modelThinkingLevels'] = existing
      return merged
    })
    this.modelThinkingLevels = parseModelThinkingLevelsConfig(next['modelThinkingLevels'])
    this.alignmentEpochValue += 1
    await this.alignAllConversations()
  }

  /** Synchronously check whether a model is explicitly disabled by the user (used for conversation resolution filtering). */
  isModelDisabled(providerId: string, modelId: string): boolean {
    return this.disabledModels[providerId]?.includes(modelId) === true
  }

  /** Reject explicitly when a model is disabled (`409 model_disabled`), reused across explicit selection paths. */
  assertModelEnabled(providerId: string, modelId: string): void {
    let targetProvider = providerId
    let targetModelId = modelId
    if (providerId === MODEL_TIER_PREFIX) {
      const resolved = this.resolveModelRef(`${MODEL_TIER_PREFIX}/${modelId}`)
      targetProvider = resolved.provider
      targetModelId = resolved.modelId
    }
    if (this.isModelDisabled(targetProvider, targetModelId)) {
      throw new HelmxError(
        'model_disabled',
        `Model ${targetProvider}/${targetModelId} is disabled; re-enable it in Settings -> Models or via 'helmx models filter' before selecting it`,
        409,
        { provider: targetProvider, modelId: targetModelId },
      )
    }
  }

  /** Set disabled model list (`PUT /api/models/filter`) and return updated catalog. */
  async setDisabledModels(provider: string | undefined, modelIds: string[]): Promise<ModelCatalog> {
    this.assertWritable()
    if (provider === MODEL_TIER_PREFIX) {
      throw new HelmxError(
        'validation_error',
        `Provider '${MODEL_TIER_PREFIX}' is reserved for model tiers and cannot be filtered via disabledModels (disable the underlying concrete model or edit the tier)`,
        400,
      )
    }
    if (provider === undefined || provider === '') {
      if (modelIds.length > 0) {
        throw new HelmxError('validation_error', 'Clearing disabled models without specifying a provider requires an empty disabledModels array', 400)
      }
    }
    const unique: string[] = []
    for (const id of modelIds) {
      if (typeof id !== 'string' || id === '') {
        throw new HelmxError('validation_error', `Model ID must be a non-empty string: ${String(id)}`, 400)
      }
      if (!unique.includes(id)) unique.push(id)
    }
    const next = await this.configSvc.updateBy((current) => {
      const merged: Record<string, unknown> = { ...current }
      if (provider === undefined || provider === '') {
        delete merged['disabledModels']
      } else {
        const existing = parseDisabledModelsConfig(merged['disabledModels'])
        if (unique.length === 0) delete existing[provider]
        else existing[provider] = unique
        if (Object.keys(existing).length === 0) delete merged['disabledModels']
        else merged['disabledModels'] = existing
      }
      return merged
    })
    this.disabledModels = parseDisabledModelsConfig(next['disabledModels'])
    this.events.publish('models.changed', { providers: provider ? [provider] : [] })
    return this.listModels()
  }

  /** Rebuild and publish the active model collection under `modelsChain` (no-ops for external models). */
  async reloadModels(): Promise<void> {
    this.assertWritable()
    await this.enqueueModelsChange(() => this.rebuildModelsLocked())
  }

  private async rebuildModelsLocked(): Promise<void> {
    if (this.externalModels) return
    const providerConfigs = await this.providersSvc.list()
    const nextKeys = await this.credentialsSvc.listAll()
    const collision = providerConfigs.find((config) => this.runtimeTracker.has(config.id))
    if (collision) {
      throw new HelmxError('runtime_provider_conflict', `Gateway '${collision.id}' conflicts with a plugin-registered provider`, 409)
    }
    const models = buildModels({
      providers: providerConfigs,
      apiKeys: () => nextKeys,
      modelsStore: this.modelsStore,
      extraProviders: this.runtimeTracker.values(),
    })
    assertModelsStoreHealthy(await models.refresh({ allowNetwork: false }))
    for (const id of Object.keys(this.apiKeyCache)) delete this.apiKeyCache[id]
    Object.assign(this.apiKeyCache, nextKeys)
    this.modelsGeneration += 1
    this.alignmentEpochValue += 1
    this.modelsCurrent = models
    this.setModels(this.modelsCurrent)
    this.events.publish('models.changed', { providers: [] })
  }

  /** Register a dynamic runtime provider (rejected on conflict or externally owned `Models`). */
  async registerRuntimeProvider(provider: Provider, pluginId?: string): Promise<() => Promise<void>> {
    this.assertWritable()
    if (this.externalModels) {
      throw new HelmxError(
        'runtime_provider_unsupported',
        'Runtime provider registration is unsupported when Models is externally injected (caller owns model set)',
        400,
      )
    }
    if (typeof provider?.id !== 'string' || provider.id === '') {
      throw new HelmxError('validation_error', `Runtime provider ID must be a non-empty string: ${String(provider?.id)}`, 400)
    }
    const registered = await this.enqueueModelsChange(async () => {
      const conflict = await this.runtimeTracker.findConflict(provider.id)
      if (conflict !== undefined) {
        throw new HelmxError('runtime_provider_conflict', conflict, 409)
      }
      const wrapped = this.runtimeTracker.addWrapped(provider, pluginId)
      try {
        await this.rebuildModelsLocked()
      } catch (error) {
        this.runtimeTracker.remove(provider.id)
        throw error
      }
      return wrapped
    })
    let disposed = false
    let disposing: Promise<void> | undefined
    return () => {
      if (disposed) return Promise.resolve()
      if (disposing) return disposing
      disposing = this.unregisterRuntimeProvider(registered)
        .then(() => { disposed = true })
        .finally(() => { disposing = undefined })
      return disposing
    }
  }

  private async unregisterRuntimeProvider(provider: Provider): Promise<void> {
    if (this.externalModels) return
    await this.enqueueModelsChange(async () => {
      if (this.runtimeTracker.get(provider.id) !== provider) return
      const owner = this.runtimeTracker.beginRetire(provider.id)
      try {
        await this.rebuildModelsLocked()
      } catch (error) {
        this.runtimeTracker.rollbackRetire(provider, owner)
        throw error
      } finally {
        this.runtimeTracker.endRetire(provider.id)
      }
    })
  }

  /** Refresh dynamic model catalogs (`POST /api/models/refresh`). */
  async refreshModels(options?: {
    providers?: string[]
    allowNetwork?: boolean
    force?: boolean
  }): Promise<ModelProvidersRefreshResult> {
    if (this.isClosed()) throw new HelmxError('runtime_closing', 'Kernel is closing; cannot refresh model catalog', 409)
    this.assertWritable()
    return this.enqueueModelsChange(() => this.refreshModelsLocked(options))
  }

  private async refreshModelsLocked(options?: {
    providers?: string[]
    allowNetwork?: boolean
    force?: boolean
  }): Promise<ModelProvidersRefreshResult> {
    if (this.isClosed()) throw new HelmxError('runtime_closing', 'Kernel is closing; cannot refresh model catalog', 409)
    this.assertWritable()
    if (this.externalModels) {
      throw new HelmxError(
        'runtime_provider_unsupported',
        'Dynamic catalog refresh is unsupported when Models is externally injected (caller owns model set)',
        400,
      )
    }
    const instanceAtStart = this.modelsCurrent
    const generationAtStart = this.modelsGeneration
    const targets =
      options?.providers && options.providers.length > 0
        ? options.providers.filter((id) => this.runtimeTracker.has(id))
        : this.runtimeTracker.keys()
    const release = this.runtimeTracker.acquire(targets)
    const controller = new AbortController()
    this.modelsRefreshAbort = controller
    let result: { aborted: boolean; errors: ReadonlyMap<string, Error> }
    try {
      for (const id of options?.providers ?? []) {
        const provider = instanceAtStart.getProvider(id)
        if (!provider) throw new HelmxError('model_provider_not_found', `Provider '${id}' is not registered`, 404)
        if (!provider.refreshModels) throw new HelmxError('model_provider_static', `Provider '${id}' uses a static model catalog and does not support dynamic refresh`, 400)
      }
      result = await instanceAtStart.refresh({
        signal: controller.signal,
        allowNetwork: options?.allowNetwork ?? true,
        force: options?.force ?? true,
        ...(options?.providers && options.providers.length > 0 ? { providers: options.providers } : {}),
      })
    } finally {
      if (this.modelsRefreshAbort === controller) this.modelsRefreshAbort = undefined
      release()
    }
    assertModelsStoreHealthy(result)
    const errors: Record<string, string> = {}
    for (const [providerId, err] of result.errors) {
      errors[providerId] = this.stash.redact(err instanceof Error ? err.message : String(err))
    }
    const snapshotStale =
      instanceAtStart !== this.modelsCurrent || generationAtStart !== this.modelsGeneration
    if (!snapshotStale) {
      this.alignmentEpochValue += 1
      this.events.publish('models.changed', { providers: options?.providers ? [...options.providers] : [] })
    }
    return {
      providers: options?.providers ? [...options.providers] : [],
      aborted: result.aborted || snapshotStale,
      errors,
      models: (await this.listModels()).models,
      providerCatalog: this.listModelProviders(),
    }
  }

  /** Abort in-flight refreshes on shutdown. */
  abortRefresh(reason: Error): void {
    this.modelsRefreshAbort?.abort(reason)
  }

  /** Teardown preflight: throws `409 plugin_has_live_tasks` while any runtime provider owned by `pluginId` is active. */
  assertRuntimeProvidersIdle(pluginId: string): void {
    this.runtimeTracker.assertIdle(pluginId)
  }

  /** Read the current global/per-model defaults snapshot (single source for HTTP and `core:models.default`). */
  async getDefaults(): Promise<ModelDefaultsSnapshot> {
    return getModelDefaults(this)
  }

  /** Validate, apply, and echo back updated global/per-model defaults (single source for HTTP and `core:models.default`). */
  async updateDefaults(input: ModelDefaultsPatch): Promise<ModelDefaultsSnapshot> {
    return updateModelDefaults(this, input)
  }
}
