/**
 * Pure validation, reference checks, state sanitization, and prompt catalog rendering for builtin:tiers.
 */
import {
  HelmxError,
  MODEL_TIER_DESCRIPTION_MAX_LENGTH,
  MODEL_TIER_PREFIX,
  escapeXml,
  isValidModelTierId,
  parseModelTierRef,
  type ModelCatalog,
  type ModelTierCatalogEntry,
  type ModelTierSpec,
  type PluginInUseItem,
  type Profile,
} from '@helmx/protocol'
import {
  MAX_TEMPLATES_COUNT,
  MAX_TIERS_COUNT,
  TIER_TEMPLATE_DESCRIPTION_MAX_LENGTH,
  TIER_TEMPLATE_ID_PATTERN,
  TIER_TEMPLATE_NAME_MAX_LENGTH,
  TIER_THINKING_LEVELS,
  type TierTemplate,
  type TiersStateDoc,
} from './contracts.js'

const VALID_THINKING_SET: ReadonlySet<string> = new Set(TIER_THINKING_LEVELS)

/** Validate a tier ID strictly (lowercase slug, 1..63 chars). */
export function assertTierId(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new HelmxError('validation_error', 'Tier ID must be a string', 400)
  }
  const id = raw.trim()
  if (!isValidModelTierId(id)) {
    throw new HelmxError(
      'validation_error',
      `Invalid tier ID '${raw}': use 1-63 lowercase letters, digits, '-' or '_' starting with a letter or digit`,
      400,
      { id: raw },
    )
  }
  return id
}

/** Validate a template ID strictly (lowercase slug, 1..63 chars). */
export function assertTemplateId(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new HelmxError('validation_error', 'Template ID must be a string', 400)
  }
  const id = raw.trim()
  if (!TIER_TEMPLATE_ID_PATTERN.test(id)) {
    throw new HelmxError(
      'validation_error',
      `Invalid template ID '${raw}': use 1-63 lowercase letters, digits, '-' or '_' starting with a letter or digit`,
      400,
      { id: raw },
    )
  }
  return id
}

/** Validate a concrete model reference (must be `'provider/model'` and must not target `'tier/*'`). */
export function assertConcreteModelRef(raw: unknown, field = 'model'): string {
  if (typeof raw !== 'string') {
    throw new HelmxError('validation_error', `${field} must be a 'provider/model' string`, 400)
  }
  const model = raw.trim()
  const slash = model.indexOf('/')
  if (slash <= 0 || slash >= model.length - 1 || /\s/.test(model)) {
    throw new HelmxError('validation_error', `${field} must be in 'provider/model' format: ${raw}`, 400, { model: raw })
  }
  if (model.slice(0, slash) === MODEL_TIER_PREFIX) {
    throw new HelmxError(
      'validation_error',
      `Tier target cannot reference another tier ('${model}'); choose a concrete 'provider/model'`,
      400,
      { model },
    )
  }
  return model
}

/** Validate and normalize a single `ModelTierSpec`. */
export function normalizeTierSpec(raw: unknown, tierId?: string): ModelTierSpec {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HelmxError('validation_error', `Tier '${tierId ?? ''}' definition must be an object`, 400)
  }
  const obj = raw as Record<string, unknown>
  const model = assertConcreteModelRef(obj['model'], tierId ? `tiers.${tierId}.model` : 'model')

  let thinkingLevel: string | undefined
  if (obj['thinkingLevel'] !== undefined && obj['thinkingLevel'] !== null) {
    if (typeof obj['thinkingLevel'] !== 'string') {
      throw new HelmxError('validation_error', 'thinkingLevel must be a string', 400)
    }
    const trimmed = obj['thinkingLevel'].trim()
    if (trimmed !== '') {
      if (!VALID_THINKING_SET.has(trimmed)) {
        throw new HelmxError(
          'validation_error',
          `Invalid thinkingLevel '${trimmed}'; valid values: ${TIER_THINKING_LEVELS.join(' | ')}`,
          400,
          { thinkingLevel: trimmed },
        )
      }
      thinkingLevel = trimmed
    }
  }

  let description: string | undefined
  if (obj['description'] !== undefined && obj['description'] !== null) {
    if (typeof obj['description'] !== 'string') {
      throw new HelmxError('validation_error', 'description must be a string', 400)
    }
    const trimmed = obj['description'].trim()
    if (trimmed.length > MODEL_TIER_DESCRIPTION_MAX_LENGTH) {
      throw new HelmxError(
        'validation_error',
        `description exceeds maximum length of ${MODEL_TIER_DESCRIPTION_MAX_LENGTH} characters`,
        400,
        { maxLength: MODEL_TIER_DESCRIPTION_MAX_LENGTH },
      )
    }
    if (trimmed !== '') description = trimmed
  }

  return {
    model,
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    ...(description !== undefined ? { description } : {}),
  }
}

/** Validate and normalize an entire tier map (`Record<string, ModelTierSpec>`). */
export function normalizeTiersRecord(raw: unknown): Record<string, ModelTierSpec> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HelmxError('validation_error', 'tiers must be an object mapping tierId -> { model, thinkingLevel?, description? }', 400)
  }
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > MAX_TIERS_COUNT) {
    throw new HelmxError('validation_error', `At most ${MAX_TIERS_COUNT} model tiers are allowed`, 400, {
      maxTiers: MAX_TIERS_COUNT,
    })
  }
  const out: Record<string, ModelTierSpec> = {}
  for (const [rawId, spec] of entries) {
    const id = assertTierId(rawId)
    out[id] = normalizeTierSpec(spec, id)
  }
  return out
}

/** Validate template display name and optional description. */
export function normalizeTemplateMeta(input: {
  name: unknown
  description?: unknown
}): { name: string; description?: string } {
  if (typeof input.name !== 'string') {
    throw new HelmxError('validation_error', 'Template name must be a non-empty string', 400)
  }
  const name = input.name.trim()
  if (name === '') {
    throw new HelmxError('validation_error', 'Template name must not be empty', 400)
  }
  if (name.length > TIER_TEMPLATE_NAME_MAX_LENGTH) {
    throw new HelmxError(
      'validation_error',
      `Template name exceeds maximum length of ${TIER_TEMPLATE_NAME_MAX_LENGTH} characters`,
      400,
    )
  }
  let description: string | undefined
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== 'string') {
      throw new HelmxError('validation_error', 'Template description must be a string', 400)
    }
    const trimmed = input.description.trim()
    if (trimmed.length > TIER_TEMPLATE_DESCRIPTION_MAX_LENGTH) {
      throw new HelmxError(
        'validation_error',
        `Template description exceeds maximum length of ${TIER_TEMPLATE_DESCRIPTION_MAX_LENGTH} characters`,
        400,
      )
    }
    if (trimmed !== '') description = trimmed
  }
  return { name, ...(description !== undefined ? { description } : {}) }
}

/** Safely normalize persisted state document (guards against partial/empty initial state). */
export function sanitizeStateDoc(raw: unknown): TiersStateDoc {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { tiers: {}, templates: {} }
  }
  const obj = raw as Record<string, unknown>
  const tiers: Record<string, ModelTierSpec> = {}
  if (obj['tiers'] !== null && typeof obj['tiers'] === 'object' && !Array.isArray(obj['tiers'])) {
    for (const [id, spec] of Object.entries(obj['tiers'] as Record<string, unknown>)) {
      if (!isValidModelTierId(id)) continue
      try {
        tiers[id] = normalizeTierSpec(spec, id)
      } catch {
        // Ignore corrupted individual entries when reading historical doc snapshots.
      }
    }
  }
  const templates: Record<string, TierTemplate> = {}
  if (obj['templates'] !== null && typeof obj['templates'] === 'object' && !Array.isArray(obj['templates'])) {
    for (const [id, tpl] of Object.entries(obj['templates'] as Record<string, unknown>)) {
      if (!TIER_TEMPLATE_ID_PATTERN.test(id) || tpl === null || typeof tpl !== 'object' || Array.isArray(tpl)) continue
      const item = tpl as Record<string, unknown>
      if (typeof item['name'] !== 'string' || item['name'].trim() === '') continue
      try {
        const tplTiers = normalizeTiersRecord(item['tiers'] ?? {})
        templates[id] = {
          id,
          name: item['name'].trim().slice(0, TIER_TEMPLATE_NAME_MAX_LENGTH),
          ...(typeof item['description'] === 'string' && item['description'].trim() !== ''
            ? { description: item['description'].trim().slice(0, TIER_TEMPLATE_DESCRIPTION_MAX_LENGTH) }
            : {}),
          tiers: tplTiers,
          updatedAt: typeof item['updatedAt'] === 'number' && Number.isFinite(item['updatedAt']) ? item['updatedAt'] : 0,
        }
      } catch {
        // Skip invalid stored template entries.
      }
    }
  }
  const activeTemplate =
    typeof obj['activeTemplate'] === 'string' && Object.prototype.hasOwnProperty.call(templates, obj['activeTemplate'])
      ? obj['activeTemplate']
      : undefined
  return {
    tiers,
    templates,
    ...(activeTemplate !== undefined ? { activeTemplate } : {}),
  }
}

export function assertTemplateCapacity(templates: Readonly<Record<string, TierTemplate>>, incomingId: string): void {
  if (Object.prototype.hasOwnProperty.call(templates, incomingId)) return
  if (Object.keys(templates).length >= MAX_TEMPLATES_COUNT) {
    throw new HelmxError(
      'validation_error',
      `At most ${MAX_TEMPLATES_COUNT} saved templates are allowed`,
      400,
      { maxTemplates: MAX_TEMPLATES_COUNT },
    )
  }
}

/** Verify a concrete target model is not disabled in the current catalog (`409 model_disabled`). */
export function assertTargetModelNotDisabled(catalog: ModelCatalog, modelRef: string): void {
  const slash = modelRef.indexOf('/')
  if (slash <= 0 || slash >= modelRef.length - 1) return
  const provider = modelRef.slice(0, slash)
  const modelId = modelRef.slice(slash + 1)
  const entry = catalog.models.find((m) => m.provider === provider && m.modelId === modelId)
  if (entry?.disabled === true) {
    throw new HelmxError(
      'model_disabled',
      `Target model '${modelRef}' is disabled; re-enable it before binding a tier to it`,
      409,
      { model: modelRef },
    )
  }
}

/** Collect all global default / compaction / Profile references targeting any tier in `tierIds` (or all tiers if omitted). */
export function findTierReferences(
  catalog: Pick<ModelCatalog, 'defaultModel' | 'defaultCompactionModel'>,
  profiles: ReadonlyArray<Pick<Profile, 'id' | 'name' | 'model'>>,
  targetTierIds?: ReadonlySet<string>,
): PluginInUseItem[] {
  const refs: PluginInUseItem[] = []
  const matches = (model: string | undefined): string | undefined => {
    if (model === undefined) return undefined
    const tid = parseModelTierRef(model)
    if (tid === undefined) return undefined
    if (targetTierIds !== undefined && !targetTierIds.has(tid)) return undefined
    return tid
  }
  const defaultTid = matches(catalog.defaultModel)
  if (defaultTid !== undefined) {
    refs.push({
      kind: 'model_default',
      id: `${MODEL_TIER_PREFIX}/${defaultTid}`,
      label: `Global defaultModel references ${MODEL_TIER_PREFIX}/${defaultTid}`,
    })
  }
  const compactionTid = matches(catalog.defaultCompactionModel)
  if (compactionTid !== undefined) {
    refs.push({
      kind: 'compaction_model',
      id: `${MODEL_TIER_PREFIX}/${compactionTid}`,
      label: `Global defaultCompactionModel references ${MODEL_TIER_PREFIX}/${compactionTid}`,
    })
  }
  for (const profile of profiles) {
    const tid = matches(profile.model)
    if (tid !== undefined) {
      refs.push({
        kind: 'profile',
        id: profile.id,
        label: `Profile '${profile.id}' references ${MODEL_TIER_PREFIX}/${tid}`,
      })
    }
  }
  return refs
}

/** Reject removing tiers that are still referenced by defaults or Profiles unless `force: true`. */
export function assertRemovedTiersNotInUse(
  removedTierIds: ReadonlySet<string>,
  catalog: Pick<ModelCatalog, 'defaultModel' | 'defaultCompactionModel'>,
  profiles: ReadonlyArray<Pick<Profile, 'id' | 'name' | 'model'>>,
  force?: boolean,
): void {
  if (force === true || removedTierIds.size === 0) return
  const refs = findTierReferences(catalog, profiles, removedTierIds)
  if (refs.length > 0) {
    throw new HelmxError(
      'model_tier_in_use',
      `Cannot remove model tier(s) still referenced by active settings: ${refs.map((r) => r.label).join('; ')}`,
      409,
      { references: refs },
    )
  }
}

/** Project configured tiers against live `ModelCatalog` facts (O(1) lookup per tier). */
export function projectTierEntries(
  tiers: Readonly<Record<string, ModelTierSpec>>,
  catalog: ModelCatalog,
): ModelTierCatalogEntry[] {
  const modelMap = new Map<string, (typeof catalog.models)[number]>(
    catalog.models.map((m) => [`${m.provider}/${m.modelId}`, m]),
  )
  const out: ModelTierCatalogEntry[] = []
  for (const [id, spec] of Object.entries(tiers)) {
    const entry = modelMap.get(spec.model)
    const disabled = entry?.disabled === true
    const available = entry !== undefined && entry.available === true && !disabled
    const thinkingLevels = catalog.thinkingLevels[spec.model]
    out.push({
      id,
      model: spec.model,
      ...(spec.thinkingLevel !== undefined ? { thinkingLevel: spec.thinkingLevel } : {}),
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      available,
      ...(disabled ? { disabled: true } : {}),
      ...(thinkingLevels !== undefined ? { thinkingLevels } : {}),
    })
  }
  return out
}

/**
 * Render the compact `<available_model_tiers>` prompt section for `before_turn`.
 * Only includes currently available, non-disabled tiers; returns `undefined` when empty (zero injection).
 * Mentions zero plugin/tool names so any native model-accepting tool, action, or CLI works generically.
 */
export function renderModelTiersCatalogSection(entries: ReadonlyArray<ModelTierCatalogEntry>): string | undefined {
  const usable = entries.filter((e) => e.available && e.disabled !== true)
  if (usable.length === 0) return undefined
  const rows = usable.map((tier) => {
    const ref = `${MODEL_TIER_PREFIX}/${tier.id}`
    const effortAttr = tier.thinkingLevel ? ` effort="${escapeXml(tier.thinkingLevel)}"` : ''
    const body = tier.description ? escapeXml(tier.description) : escapeXml(tier.model)
    return `<tier id="${escapeXml(ref)}"${effortAttr}>${body}</tier>`
  })
  return [
    '<available_model_tiers>',
    'Configured semantic model tiers (pass "tier/<id>" wherever a native model parameter is accepted):',
    ...rows,
    'Guidelines:',
    '- Pick model="tier/<id>" according to task complexity, speed, and cost when delegating work or switching worker models; omit effort to inherit the tier\'s preset thinking level.',
    '- Native runtimes only: external CLI runtimes (such as herdr:*) choose their own model—do not pass model.',
    '- Load the "model-tiers" skill on demand for multi-tier collaboration patterns (escalation ladders, cross-model blind review, fork consultation) and template management.',
    '</available_model_tiers>',
  ].join('\n')
}
