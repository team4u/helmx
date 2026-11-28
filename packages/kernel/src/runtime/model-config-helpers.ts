/**
 * Model configuration parsing, validation, and single-source defaults normalization helpers
 * (extracted from `model-registry.ts`).
 */
import type { ModelCatalog, ModelTierCatalogEntry, ModelTierSpec } from '@helmx/protocol'
import { HelmxError, MODEL_TIER_PREFIX } from '@helmx/protocol'
import { THINKING_LEVELS } from './models.js'

/**
 * File-level corruption detection for `models-store.json`: SDK refresh packages store I/O errors into
 * `result.errors` (without rejecting so one failing provider doesn't abort others), but file corruption is a
 * global failure — silently falling back to an empty catalog would drop all cached dynamic catalogs. Rethrows explicitly.
 */
export function assertModelsStoreHealthy(result: { errors: ReadonlyMap<string, Error> }): void {
  for (const [providerId, err] of result.errors) {
    if (err instanceof HelmxError && err.code === 'models_store_corrupted') {
      throw new HelmxError(
        'models_store_corrupted',
        `models-store.json is corrupted (discovered while reading ${providerId}): ${err.message}`,
        500,
      )
    }
  }
}

/**
 * Parse `config.json.disabledModels` (`providerId -> modelId[]`); defaults to `{}` and throws
 * `config_corrupt` explicitly on malformed structure (never silently discarded).
 */
export function parseDisabledModelsConfig(raw: unknown): Record<string, string[]> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HelmxError('config_corrupt', 'config.json.disabledModels must be an object (providerId -> modelId[])', 500)
  }
  const result: Record<string, string[]> = {}
  for (const [providerId, ids] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof providerId !== 'string' || providerId === '') {
      throw new HelmxError('config_corrupt', `config.json.disabledModels key must be a non-empty provider ID: ${String(providerId)}`, 500)
    }
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id !== '')) {
      throw new HelmxError('config_corrupt', `config.json.disabledModels['${providerId}'] must be an array of non-empty strings`, 500)
    }
    result[providerId] = [...(ids as string[])]
  }
  return result
}

/**
 * Parse `config.json.modelThinkingLevels` (`'provider/modelId' -> thinking level`); defaults to `{}` and throws
 * `config_corrupt` explicitly on malformed structure (never silently discarded). Keys keep the full reference
 * verbatim (model IDs may themselves contain `/`, e.g. aggregate gateways), so lookups rebuild the key from
 * `provider + '/' + modelId` instead of re-parsing.
 */
export function parseModelThinkingLevelsConfig(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HelmxError('config_corrupt', 'config.json.modelThinkingLevels must be an object (model reference -> thinking level)', 500)
  }
  const result: Record<string, string> = {}
  for (const [ref, level] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof ref !== 'string' || !/^[^/\s]+\/[^\s]+$/.test(ref)) {
      throw new HelmxError('config_corrupt', `config.json.modelThinkingLevels key must be a 'provider/model' reference: ${ref}`, 500)
    }
    if (typeof level !== 'string' || level.trim() === '') {
      throw new HelmxError('config_corrupt', `config.json.modelThinkingLevels['${ref}'] must be a non-empty thinking level`, 500)
    }
    result[ref] = level
  }
  return result
}

export function assertConfigThinkingLevel(level: string, field: string): void {
  if (!THINKING_LEVELS.has(level)) {
    throw new HelmxError(
      'config_corrupt',
      `Invalid ${field} (valid values: ${[...THINKING_LEVELS].join(' | ')})`,
      500,
    )
  }
}

export function assertInputThinkingLevel(level: string, label: string): void {
  if (!THINKING_LEVELS.has(level)) {
    throw new HelmxError(
      'validation_error',
      `Invalid ${label} '${level}'; valid values: ${[...THINKING_LEVELS].join(' | ')}`,
      400,
    )
  }
}

/** Validate `'provider/model'` reference (shared by create/update). */
export function parseModelRefOrThrow(ref: string): { provider: string; modelId: string } {
  const slash = ref.indexOf('/')
  if (slash <= 0 || slash >= ref.length - 1) {
    throw new HelmxError('validation_error', `Model reference must be in 'provider/model' format: ${ref}`)
  }
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) }
}

export function validateModelThinkingLevels(
  levels: Record<string, string>,
  assertModelEnabled: (providerId: string, modelId: string) => void,
): Record<string, string> {
  if (levels === null || typeof levels !== 'object' || Array.isArray(levels)) {
    throw new HelmxError('validation_error', 'modelThinkingLevels must be an object mapping model references to thinking levels', 400)
  }
  const validated: Record<string, string> = {}
  for (const [model, rawLevel] of Object.entries(levels)) {
    if (!/^[^/\s]+\/[^\s]+$/.test(model)) {
      throw new HelmxError('validation_error', `modelThinkingLevels key must be a 'provider/model' reference: ${model}`, 400)
    }
    const parsed = parseModelRefOrThrow(model)
    if (parsed.provider === MODEL_TIER_PREFIX) {
      throw new HelmxError('validation_error', `modelThinkingLevels applies to concrete models only (configure thinkingLevel directly on tier '${model}')`, 400)
    }
    if (typeof rawLevel !== 'string' || rawLevel.trim() === '') {
      throw new HelmxError('validation_error', `modelThinkingLevels['${model}'] must be a non-empty thinking level`, 400)
    }
    const level = rawLevel.trim()
    assertInputThinkingLevel(level, 'thinkingLevel')
    assertModelEnabled(parsed.provider, parsed.modelId)
    validated[model] = level
  }
  return validated
}

export function validateModelThinkingUpdate(
  update: { model: string; level: string },
  assertModelEnabled: (providerId: string, modelId: string) => void,
): { model: string; level: string } {
  if (!/^[^/\s]+\/[^\s]+$/.test(update.model)) {
    throw new HelmxError('validation_error', `modelThinking key must be a 'provider/model' reference: ${update.model}`, 400)
  }
  const parsed = parseModelRefOrThrow(update.model)
  if (parsed.provider === MODEL_TIER_PREFIX) {
    throw new HelmxError('validation_error', `modelThinking applies to concrete models only (configure thinkingLevel directly on tier '${update.model}')`, 400)
  }
  const level = update.level.trim()
  if (level !== '') {
    assertInputThinkingLevel(level, 'thinkingLevel')
    assertModelEnabled(parsed.provider, parsed.modelId)
  }
  return { model: update.model, level }
}

function parseConcreteTarget(ref: string | undefined): { provider: string; modelId: string } | undefined {
  if (ref === undefined || ref === '') return undefined
  const slash = ref.indexOf('/')
  if (slash <= 0 || slash === ref.length - 1) return undefined
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) }
}

/** Merge tier entries into an assembled `ModelCatalog`. */
export function buildModelTierCatalogEntries(
  catalog: ModelCatalog,
  tiers: Record<string, ModelTierSpec>,
  isModelDisabled: (providerId: string, modelId: string) => boolean,
): ModelTierCatalogEntry[] {
  const modelMap = new Map<string, (typeof catalog.models)[number]>(
    catalog.models.map((m) => [`${m.provider}/${m.modelId}`, m]),
  )
  const modelTiers: ModelTierCatalogEntry[] = []
  for (const [id, spec] of Object.entries(tiers)) {
    const primaryTarget = parseConcreteTarget(spec.model)
    const primaryDisabled = primaryTarget !== undefined && isModelDisabled(primaryTarget.provider, primaryTarget.modelId)
    const primaryEntry = modelMap.get(spec.model)
    const thinkingLevels = catalog.thinkingLevels[spec.model]
    const available = primaryEntry !== undefined && primaryEntry.available === true && !primaryDisabled
    modelTiers.push({
      id,
      model: spec.model,
      ...(spec.thinkingLevel !== undefined && spec.thinkingLevel !== '' ? { thinkingLevel: spec.thinkingLevel } : {}),
      ...(spec.description !== undefined && spec.description !== '' ? { description: spec.description } : {}),
      available,
      ...(primaryDisabled ? { disabled: true } : {}),
      ...(thinkingLevels !== undefined ? { thinkingLevels } : {}),
    })
  }
  return modelTiers
}

// ---------------------------------------------------------------------------
// Single-source model defaults & refresh normalization (shared by HTTP routes & core:models.*)
// ---------------------------------------------------------------------------

export interface ModelDefaultsSnapshot {
  readonly defaultModel: string
  readonly defaultThinkingLevel: string
  readonly modelThinkingLevels: Record<string, string>
  readonly defaultCompactionModel: string
  readonly defaultCompactionThinkingLevel: string
}

export interface ModelDefaultsPatch {
  readonly model?: string
  readonly thinkingLevel?: string
  readonly compactionModel?: string
  readonly compactionThinkingLevel?: string
  readonly modelThinking?: string
  readonly modelThinkingLevel?: string
  readonly modelThinkingLevels?: Record<string, string>
}

export interface ModelDefaultsPort {
  listModels(): Promise<ModelCatalog>
  setDefaultModel?(
    modelRef?: string,
    thinkingLevel?: string,
    compactionModelRef?: string,
    compactionThinkingLevel?: string,
    modelThinkingLevels?: Record<string, string>,
    modelThinkingUpdate?: { model: string; level: string },
  ): Promise<void>
  setModelThinkingDefault?(modelRef: string, level: string): Promise<void>
}

/** Project canonical defaults snapshot fields from a `ModelCatalog`. */
export function modelDefaultsFromCatalog(
  catalog: Pick<
    ModelCatalog,
    | 'defaultModel'
    | 'defaultThinkingLevel'
    | 'modelThinkingLevels'
    | 'defaultCompactionModel'
    | 'defaultCompactionThinkingLevel'
  >,
): ModelDefaultsSnapshot {
  return {
    defaultModel: catalog.defaultModel ?? '',
    defaultThinkingLevel: catalog.defaultThinkingLevel ?? '',
    modelThinkingLevels: catalog.modelThinkingLevels ?? {},
    defaultCompactionModel: catalog.defaultCompactionModel ?? '',
    defaultCompactionThinkingLevel: catalog.defaultCompactionThinkingLevel ?? '',
  }
}

/** Read current model defaults snapshot from any `ModelDefaultsPort`. */
export async function getModelDefaults(
  models: Pick<ModelDefaultsPort, 'listModels'>,
): Promise<ModelDefaultsSnapshot> {
  return modelDefaultsFromCatalog(await models.listModels())
}

/**
 * Single-source model defaults mutation shared by `PUT /api/models/default` and `core:models.default`:
 * - Enforces cross-field pairing (`modelThinking` + `modelThinkingLevel` must arrive together);
 * - Rejects combining bulk `modelThinkingLevels` with a single `modelThinking` pair;
 * - Rejects empty patches (at least one updatable field required);
 * - Persists via `setDefaultModel` (or `setModelThinkingDefault` fallback on partial ports) and returns the updated snapshot.
 */
export async function updateModelDefaults(
  models: ModelDefaultsPort,
  input: ModelDefaultsPatch,
): Promise<ModelDefaultsSnapshot> {
  const hasModelThinking = input.modelThinking !== undefined || input.modelThinkingLevel !== undefined
  if (hasModelThinking && (input.modelThinking === undefined || input.modelThinkingLevel === undefined)) {
    throw new HelmxError(
      'validation_error',
      'models default body: modelThinking and modelThinkingLevel must be set together',
      400,
    )
  }
  const hasRegularFields =
    input.model !== undefined ||
    input.thinkingLevel !== undefined ||
    input.compactionModel !== undefined ||
    input.compactionThinkingLevel !== undefined
  const hasModelThinkingLevels = input.modelThinkingLevels !== undefined
  if (hasModelThinkingLevels && hasModelThinking) {
    throw new HelmxError(
      'validation_error',
      'models default body: modelThinkingLevels cannot be combined with a modelThinking pair',
      400,
    )
  }
  if (!hasRegularFields && !hasModelThinkingLevels && !hasModelThinking) {
    throw new HelmxError(
      'validation_error',
      'models default body requires at least one updatable field',
      400,
    )
  }
  if (models.setDefaultModel === undefined && (hasRegularFields || hasModelThinkingLevels)) {
    throw new HelmxError(
      'not_implemented',
      'current runtime does not support setting the default model',
      501,
    )
  }
  const modelThinkingUpdate = hasModelThinking
    ? { model: input.modelThinking!, level: input.modelThinkingLevel! }
    : undefined
  if (models.setDefaultModel !== undefined) {
    await models.setDefaultModel(
      input.model,
      input.thinkingLevel,
      input.compactionModel,
      input.compactionThinkingLevel,
      input.modelThinkingLevels,
      modelThinkingUpdate,
    )
  } else if (modelThinkingUpdate !== undefined && models.setModelThinkingDefault !== undefined) {
    await models.setModelThinkingDefault(modelThinkingUpdate.model, modelThinkingUpdate.level)
  } else {
    throw new HelmxError(
      'not_implemented',
      'current runtime does not support setting model defaults',
      501,
    )
  }
  return getModelDefaults(models)
}

/** Merge single `provider` and list `providers` into one target list for `refreshModels`. */
export function normalizeModelRefreshInput(input: {
  readonly provider?: string
  readonly providers?: readonly string[]
  readonly force?: boolean
}): { providers?: string[]; force?: boolean } {
  let providers: string[] | undefined
  if (input.provider !== undefined) providers = [input.provider]
  if (input.providers !== undefined) {
    providers = providers !== undefined ? [...providers, ...input.providers] : [...input.providers]
  }
  return {
    ...(providers !== undefined ? { providers } : {}),
    ...(input.force !== undefined ? { force: input.force } : {}),
  }
}
