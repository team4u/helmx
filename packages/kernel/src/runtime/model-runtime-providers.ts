/**
 * RuntimeProviderTracker: manages dynamically plugin-registered providers, conflict checks,
 * in-flight usage reference counting, retiring markers, and stream/refresh wrappers
 * (extracted from `model-registry.ts`).
 */
import type { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { Provider } from '@earendil-works/pi-ai/models'
import { HelmxError, MODEL_TIER_PREFIX } from '@helmx/protocol'
import type { ProviderService } from '../services/index.js'

const builtinProviderIds = new Set(builtinProviders().map((p) => p.id))

export class RuntimeProviderTracker {
  private readonly providers = new Map<string, Provider>()
  private readonly owners = new Map<string, string>()
  private readonly usage = new Map<string, number>()
  private readonly retiring = new Set<string>()

  constructor(
    private readonly deps: {
      readonly providersSvc: ProviderService
      readonly assertOwnerAvailable: (ownerId: string) => void
    },
  ) {}

  get ownerByProvider(): ReadonlyMap<string, string> {
    return this.owners
  }

  has(id: string): boolean {
    return this.providers.has(id)
  }

  get(id: string): Provider | undefined {
    return this.providers.get(id)
  }

  keys(): string[] {
    return [...this.providers.keys()]
  }

  values(): Provider[] {
    return [...this.providers.values()]
  }

  ownerOf(id: string): string | undefined {
    return this.owners.get(id)
  }

  /** Teardown preflight: rejects `409 plugin_has_live_tasks` while any owned runtime provider is in flight. */
  assertIdle(pluginId: string): void {
    const busy: string[] = []
    for (const [id, owner] of this.owners) {
      if (owner === pluginId && (this.usage.get(id) ?? 0) > 0) busy.push(id)
    }
    if (busy.length > 0) {
      throw new HelmxError(
        'plugin_has_live_tasks',
        `Plugin '${pluginId}' still has in-flight model requests on runtime providers: ${busy.join(', ')}`,
        409,
        { providers: busy },
      )
    }
  }

  async findConflict(providerId: string): Promise<string | undefined> {
    if (providerId === MODEL_TIER_PREFIX) {
      return `Provider ID '${MODEL_TIER_PREFIX}' is reserved for model tiers; cannot register a provider with this ID`
    }
    const existing = this.providers.get(providerId)
    if (existing !== undefined) {
      const owner = this.owners.get(providerId)
      return `Provider ID '${providerId}' is already registered at runtime${owner !== undefined ? ` (plugin ${owner})` : ''}; cannot override`
    }
    const config = await this.deps.providersSvc.get(providerId)
    if (config !== undefined) {
      return `Provider ID '${providerId}' conflicts with a custom gateway in providers.json (enabled: ${String(config.enabled)})`
    }
    if (builtinProviderIds.has(providerId)) {
      return `Provider ID '${providerId}' conflicts with a built-in PI provider; cannot override`
    }
    return undefined
  }

  addWrapped(provider: Provider, pluginId?: string): Provider {
    const wrapped = this.wrap(provider)
    this.providers.set(provider.id, wrapped)
    if (pluginId !== undefined) this.owners.set(provider.id, pluginId)
    return wrapped
  }

  remove(providerId: string): void {
    this.providers.delete(providerId)
    this.owners.delete(providerId)
  }

  beginRetire(providerId: string): string | undefined {
    const owner = this.owners.get(providerId)
    if ((this.usage.get(providerId) ?? 0) > 0) {
      throw new HelmxError('plugin_has_live_tasks', `Provider '${providerId}' still has requests in flight`, 409, { providers: [providerId] })
    }
    // No `await` between usage check and retiring mark: ensures new stream attempts during `rebuild` fail deterministically.
    this.retiring.add(providerId)
    this.providers.delete(providerId)
    this.owners.delete(providerId)
    return owner
  }

  rollbackRetire(provider: Provider, owner: string | undefined): void {
    this.providers.set(provider.id, provider)
    if (owner !== undefined) this.owners.set(provider.id, owner)
  }

  endRetire(providerId: string): void {
    this.retiring.delete(providerId)
  }

  acquire(ids: readonly string[]): () => void {
    for (const id of ids) {
      if (this.retiring.has(id)) {
        throw new HelmxError(
          'runtime_provider_retiring',
          `Provider '${id}' is currently retiring (plugin disabling); rejecting new model request`,
          409,
          { providers: [id] },
        )
      }
    }
    for (const id of ids) {
      const owner = this.owners.get(id)
      if (owner !== undefined) this.deps.assertOwnerAvailable(owner)
    }
    for (const id of ids) {
      this.usage.set(id, (this.usage.get(id) ?? 0) + 1)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      for (const id of ids) {
        const remaining = (this.usage.get(id) ?? 0) - 1
        if (remaining <= 0) this.usage.delete(id)
        else this.usage.set(id, remaining)
      }
    }
  }

  private wrap(provider: Provider): Provider {
    const acquire = () => this.acquire([provider.id])
    const counted = (open: () => AssistantMessageEventStream): AssistantMessageEventStream => {
      const release = acquire()
      let stream: AssistantMessageEventStream
      try {
        stream = open()
      } catch (err) {
        release()
        throw err
      }
      void stream.result().then(release, release)
      return stream
    }
    const wrapped: Provider = {
      ...provider,
      get baseUrl() { return provider.baseUrl },
      stream: (model, context, options) => counted(() => provider.stream(model, context, options)),
      streamSimple: (model, context, options) => counted(() => provider.streamSimple(model, context, options)),
    }
    if (typeof provider.refreshModels === 'function') {
      const base = provider.refreshModels.bind(provider)
      wrapped.refreshModels = async (context) => {
        const release = acquire()
        try {
          return await base(context)
        } finally {
          release()
        }
      }
    }
    return wrapped
  }
}
