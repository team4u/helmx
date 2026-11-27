/** Pure validation, reference checks, state sanitization, and prompt catalog rendering for builtin:tiers. */
import {
  HelmxError,
  MODEL_TIER_DESCRIPTION_MAX_LENGTH,
  MODEL_TIER_PREFIX,
  ORCHESTRATOR_TIER_DEFAULT_MAX_STEPS,
  ORCHESTRATOR_TIER_MAX_STEPS_LIMIT,
  escapeXml,
  isOrchestratorTier,
  isValidModelTierId,
  parseModelTierRef,
  type ModelCatalog,
  type ModelTierCatalogEntry,
  type ModelTierKind,
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

function assertSlugId(raw: unknown, label: string, test: (id: string) => boolean): string {
  if (typeof raw !== 'string') throw new HelmxError('validation_error', `${label} ID must be a string`, 400)
  const id = raw.trim()
  if (!test(id)) {
    throw new HelmxError('validation_error', `Invalid ${label.toLowerCase()} ID '${raw}': use 1-63 lowercase letters, digits, '-' or '_'`, 400, { id: raw })
  }
  return id
}

function normalizeOptionalText(raw: unknown, field: string, maxLength: number): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw new HelmxError('validation_error', `${field} must be a string`, 400)
  const trimmed = raw.trim()
  if (trimmed.length > maxLength) {
    throw new HelmxError('validation_error', `${field} exceeds maximum length of ${maxLength} characters`, 400, { maxLength })
  }
  return trimmed === '' ? undefined : trimmed
}

export const assertTierId = (raw: unknown): string => assertSlugId(raw, 'Tier', isValidModelTierId)
export const assertTemplateId = (raw: unknown): string => assertSlugId(raw, 'Template', (id) => TIER_TEMPLATE_ID_PATTERN.test(id))

export function assertConcreteModelRef(raw: unknown, field = 'model'): string {
  if (typeof raw !== 'string') throw new HelmxError('validation_error', `${field} must be a 'provider/model' string`, 400)
  const model = raw.trim()
  const slash = model.indexOf('/')
  if (slash <= 0 || slash >= model.length - 1 || /\s/.test(model)) {
    throw new HelmxError('validation_error', `${field} must be in 'provider/model' format: ${raw}`, 400, { model: raw })
  }
  if (model.slice(0, slash) === MODEL_TIER_PREFIX) {
    throw new HelmxError('validation_error', `Tier target cannot reference another tier ('${model}'); choose a concrete 'provider/model'`, 400, { model })
  }
  return model
}

export function normalizeTierSpec(raw: unknown, tierId?: string): ModelTierSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HelmxError('validation_error', `Tier '${tierId ?? ''}' definition must be an object`, 400)
  }
  const obj = raw as Record<string, unknown>
  if (obj.kind !== undefined && obj.kind !== 'single' && obj.kind !== 'orchestrator') {
    throw new HelmxError(
      'validation_error',
      `Invalid tier kind '${String(obj.kind)}'; valid values: single | orchestrator`,
      400,
      { kind: obj.kind },
    )
  }
  const kind: ModelTierKind = obj.kind === 'orchestrator' ? 'orchestrator' : 'single'
  const model = assertConcreteModelRef(obj.model, tierId ? `tiers.${tierId}.model` : 'model')
  const thinkingLevel = normalizeOptionalText(obj.thinkingLevel, 'thinkingLevel', 32)
  if (thinkingLevel !== undefined && !VALID_THINKING_SET.has(thinkingLevel)) {
    throw new HelmxError('validation_error', `Invalid thinkingLevel '${thinkingLevel}'; valid values: ${TIER_THINKING_LEVELS.join(' | ')}`, 400, { thinkingLevel })
  }
  const description = normalizeOptionalText(obj.description, 'description', MODEL_TIER_DESCRIPTION_MAX_LENGTH)

  if (kind === 'single') {
    if (obj.executorModel !== undefined && obj.executorModel !== null && String(obj.executorModel).trim() !== '') {
      throw new HelmxError('validation_error', "executorModel is only allowed when kind === 'orchestrator'", 400)
    }
    if (
      obj.executorThinkingLevel !== undefined &&
      obj.executorThinkingLevel !== null &&
      String(obj.executorThinkingLevel).trim() !== ''
    ) {
      throw new HelmxError('validation_error', "executorThinkingLevel is only allowed when kind === 'orchestrator'", 400)
    }
    if (obj.maxExecutionSteps !== undefined && obj.maxExecutionSteps !== null) {
      throw new HelmxError('validation_error', "maxExecutionSteps is only allowed when kind === 'orchestrator'", 400)
    }
    return { model, ...(thinkingLevel ? { thinkingLevel } : {}), ...(description ? { description } : {}) }
  }

  const executorModel = assertConcreteModelRef(
    obj.executorModel,
    tierId ? `tiers.${tierId}.executorModel` : 'executorModel',
  )
  const executorThinkingLevel = normalizeOptionalText(obj.executorThinkingLevel, 'executorThinkingLevel', 32)
  if (executorThinkingLevel !== undefined && !VALID_THINKING_SET.has(executorThinkingLevel)) {
    throw new HelmxError(
      'validation_error',
      `Invalid executorThinkingLevel '${executorThinkingLevel}'; valid values: ${TIER_THINKING_LEVELS.join(' | ')}`,
      400,
      { executorThinkingLevel },
    )
  }
  let maxExecutionSteps: number = ORCHESTRATOR_TIER_DEFAULT_MAX_STEPS
  if (obj.maxExecutionSteps !== undefined && obj.maxExecutionSteps !== null) {
    if (
      typeof obj.maxExecutionSteps !== 'number' ||
      !Number.isInteger(obj.maxExecutionSteps) ||
      obj.maxExecutionSteps < 0 ||
      obj.maxExecutionSteps > ORCHESTRATOR_TIER_MAX_STEPS_LIMIT
    ) {
      throw new HelmxError(
        'validation_error',
        `maxExecutionSteps must be an integer between 0 and ${ORCHESTRATOR_TIER_MAX_STEPS_LIMIT} (0 = unlimited)`,
        400,
        { maxExecutionSteps: obj.maxExecutionSteps },
      )
    }
    maxExecutionSteps = obj.maxExecutionSteps
  }
  return {
    kind: 'orchestrator',
    model,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    executorModel,
    ...(executorThinkingLevel ? { executorThinkingLevel } : {}),
    maxExecutionSteps,
    ...(description ? { description } : {}),
  }
}

export function normalizeTiersRecord(raw: unknown): Record<string, ModelTierSpec> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HelmxError('validation_error', 'tiers must be an object mapping tierId -> { model, thinkingLevel?, description? }', 400)
  }
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > MAX_TIERS_COUNT) {
    throw new HelmxError('validation_error', `At most ${MAX_TIERS_COUNT} model tiers are allowed`, 400, { maxTiers: MAX_TIERS_COUNT })
  }
  const out: Record<string, ModelTierSpec> = {}
  for (const [rawId, spec] of entries) {
    const id = assertTierId(rawId)
    out[id] = normalizeTierSpec(spec, id)
  }
  return out
}

export function normalizeTemplateMeta(input: { name: unknown; description?: unknown }): { name: string; description?: string } {
  const name = normalizeOptionalText(input.name, 'Template name', TIER_TEMPLATE_NAME_MAX_LENGTH)
  if (!name) throw new HelmxError('validation_error', 'Template name must be a non-empty string', 400)
  const description = normalizeOptionalText(input.description, 'Template description', TIER_TEMPLATE_DESCRIPTION_MAX_LENGTH)
  return { name, ...(description ? { description } : {}) }
}

export function sanitizeStateDoc(raw: unknown): TiersStateDoc {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { tiers: {}, templates: {} }
  const obj = raw as Record<string, unknown>
  const tiers: Record<string, ModelTierSpec> = {}
  if (obj.tiers && typeof obj.tiers === 'object' && !Array.isArray(obj.tiers)) {
    for (const [id, spec] of Object.entries(obj.tiers as Record<string, unknown>)) {
      if (!isValidModelTierId(id)) continue
      try {
        tiers[id] = normalizeTierSpec(spec, id)
      } catch {
        // Ignore corrupted individual entries when reading persisted snapshots.
      }
    }
  }
  const templates: Record<string, TierTemplate> = {}
  if (obj.templates && typeof obj.templates === 'object' && !Array.isArray(obj.templates)) {
    for (const [id, tpl] of Object.entries(obj.templates as Record<string, unknown>)) {
      if (!TIER_TEMPLATE_ID_PATTERN.test(id) || !tpl || typeof tpl !== 'object' || Array.isArray(tpl)) continue
      const item = tpl as Record<string, unknown>
      if (typeof item.name !== 'string' || item.name.trim() === '') continue
      try {
        templates[id] = {
          id,
          name: item.name.trim().slice(0, TIER_TEMPLATE_NAME_MAX_LENGTH),
          ...(typeof item.description === 'string' && item.description.trim()
            ? { description: item.description.trim().slice(0, TIER_TEMPLATE_DESCRIPTION_MAX_LENGTH) }
            : {}),
          tiers: normalizeTiersRecord(item.tiers ?? {}),
          updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
        }
      } catch {
        // Skip invalid stored template entries.
      }
    }
  }
  const activeTemplate = typeof obj.activeTemplate === 'string' && Object.hasOwn(templates, obj.activeTemplate) ? obj.activeTemplate : undefined
  return { tiers, templates, ...(activeTemplate ? { activeTemplate } : {}) }
}

export function assertTemplateCapacity(templates: Readonly<Record<string, TierTemplate>>, incomingId: string): void {
  if (!Object.hasOwn(templates, incomingId) && Object.keys(templates).length >= MAX_TEMPLATES_COUNT) {
    throw new HelmxError('validation_error', `At most ${MAX_TEMPLATES_COUNT} saved templates are allowed`, 400, { maxTemplates: MAX_TEMPLATES_COUNT })
  }
}

export function assertTargetModelNotDisabled(catalog: ModelCatalog, modelRef: string): void {
  const slash = modelRef.indexOf('/')
  if (slash <= 0 || slash >= modelRef.length - 1) return
  const entry = catalog.models.find((m) => m.provider === modelRef.slice(0, slash) && m.modelId === modelRef.slice(slash + 1))
  if (entry?.disabled === true) {
    throw new HelmxError('model_disabled', `Target model '${modelRef}' is disabled; re-enable it before binding a tier to it`, 409, { model: modelRef })
  }
}

export function assertTierSpecModelsNotDisabled(catalog: ModelCatalog, spec: ModelTierSpec): void {
  assertTargetModelNotDisabled(catalog, spec.model)
  if (isOrchestratorTier(spec) && spec.executorModel !== undefined && spec.executorModel !== '') {
    assertTargetModelNotDisabled(catalog, spec.executorModel)
  }
}

export function findTierReferences(
  catalog: Pick<ModelCatalog, 'defaultModel' | 'defaultCompactionModel'>,
  profiles: ReadonlyArray<Pick<Profile, 'id' | 'name' | 'model'>>,
  targetTierIds?: ReadonlySet<string>,
): PluginInUseItem[] {
  const refs: PluginInUseItem[] = []
  const check = (model: string | undefined, kind: string, idOf: (tid: string) => string, labelOf: (tid: string) => string): void => {
    const tid = model !== undefined ? parseModelTierRef(model) : undefined
    if (tid !== undefined && (targetTierIds === undefined || targetTierIds.has(tid))) {
      refs.push({ kind, id: idOf(tid), label: labelOf(tid) })
    }
  }
  check(catalog.defaultModel, 'model_default', (t) => `${MODEL_TIER_PREFIX}/${t}`, (t) => `Global defaultModel references ${MODEL_TIER_PREFIX}/${t}`)
  check(catalog.defaultCompactionModel, 'compaction_model', (t) => `${MODEL_TIER_PREFIX}/${t}`, (t) => `Global defaultCompactionModel references ${MODEL_TIER_PREFIX}/${t}`)
  for (const p of profiles) {
    check(p.model, 'profile', () => p.id, (t) => `Profile '${p.id}' references ${MODEL_TIER_PREFIX}/${t}`)
  }
  return refs
}

export function assertRemovedTiersNotInUse(
  removedTierIds: ReadonlySet<string>,
  catalog: Pick<ModelCatalog, 'defaultModel' | 'defaultCompactionModel'>,
  profiles: ReadonlyArray<Pick<Profile, 'id' | 'name' | 'model'>>,
  force?: boolean,
): void {
  if (force === true || removedTierIds.size === 0) return
  const refs = findTierReferences(catalog, profiles, removedTierIds)
  if (refs.length > 0) {
    throw new HelmxError('model_tier_in_use', `Cannot remove model tier(s) still referenced by active settings: ${refs.map((r) => r.label).join('; ')}`, 409, { references: refs })
  }
}

export function projectTierEntries(tiers: Readonly<Record<string, ModelTierSpec>>, catalog: ModelCatalog): ModelTierCatalogEntry[] {
  const modelMap = new Map(catalog.models.map((m) => [`${m.provider}/${m.modelId}`, m]))
  return Object.entries(tiers).map(([id, spec]) => {
    const entry = modelMap.get(spec.model)
    const thinkingLevels = catalog.thinkingLevels[spec.model]
    if (isOrchestratorTier(spec)) {
      const execRef = spec.executorModel ?? ''
      const execEntry = modelMap.get(execRef)
      const executorThinkingLevels = catalog.thinkingLevels[execRef]
      const disabled = entry?.disabled === true || execEntry?.disabled === true
      const available =
        entry !== undefined &&
        entry.available === true &&
        execEntry !== undefined &&
        execEntry.available === true &&
        !disabled
      return {
        id,
        kind: 'orchestrator',
        model: spec.model,
        ...(spec.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {}),
        executorModel: execRef,
        ...(spec.executorThinkingLevel ? { executorThinkingLevel: spec.executorThinkingLevel } : {}),
        ...(spec.maxExecutionSteps !== undefined ? { maxExecutionSteps: spec.maxExecutionSteps } : {}),
        ...(spec.description ? { description: spec.description } : {}),
        available,
        ...(disabled ? { disabled: true } : {}),
        ...(thinkingLevels ? { thinkingLevels } : {}),
        ...(executorThinkingLevels ? { executorThinkingLevels } : {}),
      }
    }
    const disabled = entry?.disabled === true
    return {
      id,
      model: spec.model,
      ...(spec.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {}),
      ...(spec.description ? { description: spec.description } : {}),
      available: entry !== undefined && entry.available === true && !disabled,
      ...(disabled ? { disabled: true } : {}),
      ...(thinkingLevels ? { thinkingLevels } : {}),
    }
  })
}

export function renderModelTiersCatalogSection(entries: ReadonlyArray<ModelTierCatalogEntry>): string | undefined {
  // Dual-phase orchestrator tiers are restricted to human-owned sessions and must stay invisible to agents.
  const usable = entries.filter((e) => !isOrchestratorTier(e) && e.available && e.disabled !== true)
  if (usable.length === 0) return undefined
  const rows = usable.map((t) => {
    const effort = t.thinkingLevel ? ` effort="${escapeXml(t.thinkingLevel)}"` : ''
    return `<tier id="${escapeXml(`${MODEL_TIER_PREFIX}/${t.id}`)}"${effort}>${escapeXml(t.description || t.model)}</tier>`
  })
  return [
    '<available_model_tiers>',
    'Configured semantic model tiers (pass "tier/<id>" wherever a native model parameter is accepted):',
    ...rows,
    'Guidelines:',
    "- Pick model=\"tier/<id>\" (never agentType or profileId) according to task complexity, speed, and cost when delegating work or switching worker models; omit effort to inherit the tier's preset thinking level.",
    '- In a top-level conversation, call `switch_model({ model: "tier/<id>" })` (or a concrete `provider/modelId`) to temporarily relay the current turn to another model; the original model restores automatically after the turn.',
    '- Load the "model-tiers" skill on demand for multi-tier collaboration patterns and template management.',
    '</available_model_tiers>',
  ].join('\n')
}
