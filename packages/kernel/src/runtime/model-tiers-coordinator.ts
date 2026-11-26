/**
 * ModelTiersCoordinator: consumes `'helmx.model-tiers'` capabilities from `PluginHost`,
 * validates tier ID uniqueness, resolves `tier/<id>` references, and propagates change notifications
 * and conversation alignments with structured diagnostics.
 */
import type { ModelTiersCapability, ModelTierSpec, ProvidedCapability } from '@helmx/protocol'
import { HelmxError, MODEL_TIER_PREFIX, isValidModelTierId } from '@helmx/protocol'
import type { KernelDiagnosticEmitter } from './diagnostics.js'
import type { ResolvedModelRef } from './models.js'
import { parseModelRefOrThrow } from './model-config-helpers.js'

const MODEL_TIERS_CAPABILITY_ID = 'helmx.model-tiers'

export interface ModelTiersCapabilityHost {
  consumeCapability<T>(capabilityId: string): ReadonlyArray<ProvidedCapability<T>>
  onCapabilityChanged(capabilityId: string, listener: () => void): () => void
}

export class ModelTiersCoordinator {
  private boundCapabilityHost: ModelTiersCapabilityHost | undefined
  private readonly tierSubscriptions = new Map<ModelTiersCapability, () => void>()
  private releaseTierCapabilityListener: (() => void) | undefined

  constructor(
    private readonly deps: {
      readonly onChanged: () => void
      readonly alignAllConversations: () => Promise<void>
      readonly isClosed: () => boolean
      readonly emitDiagnostic: KernelDiagnosticEmitter
    },
  ) {}

  bind(host: ModelTiersCapabilityHost): void {
    this.unbind()
    this.boundCapabilityHost = host
    this.releaseTierCapabilityListener = host.onCapabilityChanged(MODEL_TIERS_CAPABILITY_ID, () => {
      this.sync(true)
    })
    this.sync(false)
  }

  unbind(): void {
    const release = this.releaseTierCapabilityListener
    this.releaseTierCapabilityListener = undefined
    release?.()
    for (const unsub of [...this.tierSubscriptions.values()]) {
      try {
        unsub()
      } catch {
        // Ignore cleanup errors from retiring plugin listeners.
      }
    }
    this.tierSubscriptions.clear()
    this.boundCapabilityHost = undefined
  }

  private readProviders(): ReadonlyArray<ProvidedCapability<ModelTiersCapability>> {
    const host = this.boundCapabilityHost
    if (host === undefined) return []
    try {
      return host
        .consumeCapability<ModelTiersCapability>(MODEL_TIERS_CAPABILITY_ID)
        .filter((entry) => entry.impl !== null && typeof entry.impl === 'object' && typeof entry.impl.getTiers === 'function')
    } catch (err) {
      if (err instanceof HelmxError && err.code === 'plugin_host_disposed') return []
      throw err
    }
  }

  private sync(emitOnDelta: boolean): void {
    const providers = this.readProviders()
    const activeImpls = new Set(providers.map((entry) => entry.impl))
    let changed = false

    for (const [impl, unsub] of [...this.tierSubscriptions.entries()]) {
      if (activeImpls.has(impl)) continue
      this.tierSubscriptions.delete(impl)
      changed = true
      try {
        unsub()
      } catch {
        // Ignore cleanup errors when detaching disabled providers.
      }
    }

    for (const { impl } of providers) {
      if (this.tierSubscriptions.has(impl)) continue
      changed = true
      const unsub =
        typeof impl.onChanged === 'function'
          ? impl.onChanged(() =>
              this.handleSourceChanged().catch((error) => {
                if (!this.deps.isClosed()) {
                  this.deps.emitDiagnostic({
                    level: 'warn',
                    source: 'models.tier_changed',
                    message: 'failed to align conversations after model tier source change',
                    error,
                  })
                }
              }),
            )
          : undefined
      this.tierSubscriptions.set(impl, typeof unsub === 'function' ? unsub : () => {})
    }

    if (changed) {
      this.deps.onChanged()
    }

    if (emitOnDelta && changed) {
      void this.deps.alignAllConversations().catch((error) => {
        if (!this.deps.isClosed()) {
          this.deps.emitDiagnostic({
            level: 'warn',
            source: 'models.tier_align',
            message: 'failed to align conversations after tier capability change',
            error,
          })
        }
      })
    }
  }

  private async handleSourceChanged(): Promise<void> {
    this.assertNoConflicts(this.readProviders())
    this.deps.onChanged()
    await this.deps.alignAllConversations()
  }

  private assertNoConflicts(
    providers: ReadonlyArray<ProvidedCapability<ModelTiersCapability>>,
  ): void {
    const ownerByTierId = new Map<string, string>()
    for (const { pluginId, impl } of providers) {
      const map = impl.getTiers()
      if (map === null || typeof map !== 'object') continue
      for (const id of Object.keys(map)) {
        if (!isValidModelTierId(id)) continue
        const existingOwner = ownerByTierId.get(id)
        if (existingOwner !== undefined) {
          throw new HelmxError(
            'model_tier_conflict',
            `Model tier '${MODEL_TIER_PREFIX}/${id}' is already registered by plugin '${existingOwner}'`,
            409,
            { tierId: id, owner: existingOwner },
          )
        }
        ownerByTierId.set(id, pluginId)
      }
    }
  }

  /** Collect active runtime model tiers from all mounted `'helmx.model-tiers'` capability providers. */
  getRegisteredTiers(): Record<string, ModelTierSpec> {
    const providers = this.readProviders()
    this.assertNoConflicts(providers)
    const result: Record<string, ModelTierSpec> = {}
    for (const { impl } of providers) {
      const map = impl.getTiers()
      if (map === null || typeof map !== 'object') continue
      for (const [id, spec] of Object.entries(map)) {
        if (!isValidModelTierId(id) || spec === null || typeof spec !== 'object' || typeof spec.model !== 'string') {
          continue
        }
        result[id] = {
          model: spec.model,
          ...(typeof spec.thinkingLevel === 'string' && spec.thinkingLevel !== ''
            ? { thinkingLevel: spec.thinkingLevel }
            : {}),
          ...(typeof spec.description === 'string' && spec.description !== ''
            ? { description: spec.description }
            : {}),
        }
      }
    }
    return result
  }

  /**
   * Single authoritative model-reference resolver:
   * - Concrete `'provider/modelId'` passes through unchanged;
   * - `'tier/<id>'` resolves against mounted runtime tiers, failing explicitly with `404 model_tier_not_found`
   *   when unconfigured/disabled and rejecting nested `tier -> tier` chains with `400 validation_error`.
   */
  resolveModelRef(ref: string): ResolvedModelRef {
    const parsed = parseModelRefOrThrow(ref)
    if (parsed.provider !== MODEL_TIER_PREFIX) {
      return {
        provider: parsed.provider,
        modelId: parsed.modelId,
        canonicalRef: `${parsed.provider}/${parsed.modelId}`,
      }
    }
    const tier = this.getRegisteredTiers()[parsed.modelId]
    if (tier === undefined) {
      throw new HelmxError(
        'model_tier_not_found',
        `Model tier '${ref}' is not registered`,
        404,
        { tierId: parsed.modelId, ref },
      )
    }
    const target = parseModelRefOrThrow(tier.model)
    if (target.provider === MODEL_TIER_PREFIX) {
      throw new HelmxError(
        'validation_error',
        `Model tier '${ref}' cannot target another model tier '${tier.model}'`,
        400,
        { tierId: parsed.modelId, target: tier.model },
      )
    }
    return {
      provider: target.provider,
      modelId: target.modelId,
      canonicalRef: `${target.provider}/${target.modelId}`,
      tierId: parsed.modelId,
      ...(tier.thinkingLevel !== undefined && tier.thinkingLevel !== ''
        ? { tierThinkingLevel: tier.thinkingLevel }
        : {}),
    }
  }
}
