import {
  resolveDefaultChainThinkingLevel,
  type HelmxLocale,
  type HostModelsSlice,
} from '@helmx/plugin-client'

export const DUO_PLUGIN_ID = 'builtin:duo' as const
export const DUO_STATE_DOC = 'state' as const
export const DUO_SESSION_DOC = 'duo' as const
export const DUO_SCREEN_ID = 'main' as const
export const DUO_EXIT_PLAN_MODE_TOOL = 'exit_plan_mode' as const
export const DUO_HAND_BACK_TOOL = 'hand_back_to_planner' as const
export const DUO_DEFAULT_MAX_STEPS = 30
export const DUO_MAX_STEPS_LIMIT = 100
export const DUO_RECIPE_NAME_MAX_LENGTH = 80
export const DUO_DESCRIPTION_MAX_LENGTH = 240
export const DUO_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/

export type DuoPhase = 'planning' | 'execution'
export type DuoRecipeAvailability = 'available' | 'disabled' | 'unavailable'

export interface DuoRecipe {
  id: string
  name: string
  description?: string
  plannerModel: string
  plannerThinkingLevel?: string
  executorModel: string
  executorThinkingLevel?: string
  maxExecutionSteps: number
  updatedAt: number
}

export interface DuoRecipeViewItem {
  recipe: DuoRecipe
  resolvedPlannerModel?: string
  resolvedPlannerThinkingLevel?: string
  resolvedExecutorModel?: string
  resolvedExecutorThinkingLevel?: string
  status: DuoRecipeAvailability
  unavailableReason?: string
}

export interface DuoSessionView {
  enabled: boolean
  recipeId: string
  recipeName: string
  phase: DuoPhase
  plannerModel: string
  plannerThinkingLevel?: string
  executorModel: string
  executorThinkingLevel?: string
  maxExecutionSteps: number
  executionStepCount: number
  stepLimitPaused: boolean
  suppressedByCoordinator?: boolean
  hasExecutorOverride: boolean
}

export interface DuoTransitionMeta {
  tool: typeof DUO_EXIT_PLAN_MODE_TOOL | typeof DUO_HAND_BACK_TOOL
  fromModel: string
  toModel: string
  fromPhase: DuoPhase
  toPhase: DuoPhase
  reason?: string
}

export interface DuoStateDocParsed {
  recipes: Record<string, DuoRecipe>
}

export interface StarterDuoPreset {
  id: string
  name: string
  description: string
  plannerModel: string
  plannerThinkingLevel?: string
  executorModel: string
  executorThinkingLevel?: string
  maxExecutionSteps: number
}

export interface DuoRecipeDraft {
  id: string
  name: string
  description: string
  plannerModel: string
  plannerThinkingLevel: string
  executorModel: string
  executorThinkingLevel: string
  maxExecutionSteps: string
}

export type DuoDraftValidationError =
  | 'id_required'
  | 'id_invalid'
  | 'id_conflict'
  | 'name_required'
  | 'name_too_long'
  | 'planner_required'
  | 'planner_duo_ref'
  | 'executor_required'
  | 'executor_duo_ref'
  | 'steps_invalid'
  | 'description_too_long'

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null
}

function normalizeOptionalString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
}

export function parseTierRefId(ref: string | undefined): string | undefined {
  if (!ref) return undefined
  const trimmed = ref.trim()
  if (!trimmed.startsWith('tier/')) return undefined
  const id = trimmed.slice('tier/'.length)
  return id.length > 0 ? id : undefined
}

export function parseDuoStateDoc(raw: unknown): DuoStateDocParsed {
  const obj = asRecord(raw)
  const rawRecipes = obj !== null ? asRecord(obj['recipes']) : null
  const recipes: Record<string, DuoRecipe> = {}
  if (rawRecipes) {
    for (const [key, val] of Object.entries(rawRecipes)) {
      const rec = asRecord(val)
      if (!rec) continue
      const id = normalizeOptionalString(rec['id']) ?? key
      const name = normalizeOptionalString(rec['name'])
      const plannerModel = normalizeOptionalString(rec['plannerModel'])
      const executorModel = normalizeOptionalString(rec['executorModel'])
      if (!name || !plannerModel || !executorModel) continue
      const description = normalizeOptionalString(rec['description'])
      const plannerThinkingLevel = normalizeOptionalString(rec['plannerThinkingLevel'])
      const executorThinkingLevel = normalizeOptionalString(rec['executorThinkingLevel'])
      const rawSteps = rec['maxExecutionSteps']
      const maxExecutionSteps =
        typeof rawSteps === 'number' && Number.isInteger(rawSteps) && rawSteps >= 0
          ? rawSteps
          : DUO_DEFAULT_MAX_STEPS
      const updatedAt = typeof rec['updatedAt'] === 'number' ? rec['updatedAt'] : 0
      recipes[id] = {
        id,
        name,
        ...(description !== undefined ? { description } : {}),
        plannerModel,
        ...(plannerThinkingLevel !== undefined ? { plannerThinkingLevel } : {}),
        executorModel,
        ...(executorThinkingLevel !== undefined ? { executorThinkingLevel } : {}),
        maxExecutionSteps,
        updatedAt,
      }
    }
  }
  return { recipes }
}

export function parseDuoSessionDoc(raw: unknown): DuoSessionView | null {
  const obj = asRecord(raw)
  if (!obj || obj['enabled'] !== true) return null
  if (typeof obj['plannerModel'] !== 'string' || typeof obj['executorModel'] !== 'string') return null
  const phase: DuoPhase = obj['phase'] === 'execution' ? 'execution' : 'planning'
  const recipeId = typeof obj['recipeId'] === 'string' ? obj['recipeId'] : ''
  const recipeName = typeof obj['recipeName'] === 'string' ? obj['recipeName'] : recipeId
  const maxExecutionSteps =
    typeof obj['maxExecutionSteps'] === 'number' && Number.isInteger(obj['maxExecutionSteps'])
      ? obj['maxExecutionSteps']
      : DUO_DEFAULT_MAX_STEPS
  const executionStepCount =
    typeof obj['executionStepCount'] === 'number' && Number.isInteger(obj['executionStepCount'])
      ? obj['executionStepCount']
      : 0
  return {
    enabled: true,
    recipeId,
    recipeName,
    phase,
    plannerModel: obj['plannerModel'],
    ...(typeof obj['plannerThinkingLevel'] === 'string'
      ? { plannerThinkingLevel: obj['plannerThinkingLevel'] }
      : {}),
    executorModel: obj['executorModel'],
    ...(typeof obj['executorThinkingLevel'] === 'string'
      ? { executorThinkingLevel: obj['executorThinkingLevel'] }
      : {}),
    maxExecutionSteps,
    executionStepCount,
    stepLimitPaused: obj['stepLimitPaused'] === true,
    ...(obj['suppressedByCoordinator'] === true ? { suppressedByCoordinator: true } : {}),
    hasExecutorOverride: obj['hasExecutorOverride'] === true,
  }
}

export function extractFirstLine(raw: unknown): string | undefined {
  let text = ''
  if (typeof raw === 'string') {
    text = raw
  } else if (raw !== null && typeof raw === 'object' && typeof (raw as { output?: unknown }).output === 'string') {
    text = (raw as { output: string }).output
  }
  const line = text
    .split(/\r?\n/u)
    .map((part) => part.trim())
    .find((part) => part.length > 0)
  return line ? (line.length > 160 ? `${line.slice(0, 159)}…` : line) : undefined
}

export function parseDuoTransitionMeta(raw: unknown): DuoTransitionMeta | undefined {
  const obj = asRecord(raw)
  if (!obj) return undefined
  const tool = obj['tool']
  if (tool !== DUO_EXIT_PLAN_MODE_TOOL && tool !== DUO_HAND_BACK_TOOL) return undefined
  const fromModel = typeof obj['fromModel'] === 'string' ? obj['fromModel'] : undefined
  const toModel = typeof obj['toModel'] === 'string' ? obj['toModel'] : undefined
  const fromPhase = obj['fromPhase']
  const toPhase = obj['toPhase']
  if (!fromModel || !toModel) return undefined
  if ((fromPhase !== 'planning' && fromPhase !== 'execution') || (toPhase !== 'planning' && toPhase !== 'execution')) {
    return undefined
  }
  return {
    tool,
    fromModel,
    toModel,
    fromPhase,
    toPhase,
    ...(typeof obj['reason'] === 'string' ? { reason: obj['reason'] } : {}),
  }
}

export function collectExternalTierIds(hostModels: HostModelsSlice | null | undefined): Set<string> {
  const ids = new Set<string>()
  for (const tier of hostModels?.modelTiers ?? []) {
    if (tier.displayGroup !== 'duo') {
      ids.add(tier.id)
    }
  }
  return ids
}

export function resolveEndpointDisplay(
  ref: string,
  explicitThinking: string | undefined,
  hostModels: HostModelsSlice | null | undefined,
): {
  concreteModel?: string
  thinkingLevel?: string
  status: DuoRecipeAvailability
  reason?: string
} {
  const tierId = parseTierRefId(ref)
  let concreteModel: string | undefined = ref
  let inheritedThinking = explicitThinking

  if (tierId !== undefined) {
    const external = hostModels?.modelTiers?.find(
      (t) => t.id === tierId && t.displayGroup !== 'duo',
    )
    if (!external) {
      return {
        concreteModel: undefined,
        thinkingLevel: explicitThinking,
        status: 'unavailable',
        reason: `tier/${tierId}`,
      }
    }
    concreteModel = external.model
    inheritedThinking = explicitThinking ?? external.thinkingLevel
    if (external.disabled === true) {
      return {
        concreteModel,
        thinkingLevel: inheritedThinking,
        status: 'disabled',
        reason: concreteModel,
      }
    }
    if (!external.available) {
      return {
        concreteModel,
        thinkingLevel: inheritedThinking,
        status: 'unavailable',
        reason: concreteModel,
      }
    }
  }

  const catalogEntry = hostModels?.models.find((m) => `${m.provider}/${m.modelId}` === concreteModel)
  if (catalogEntry?.disabled === true) {
    return {
      concreteModel,
      thinkingLevel: inheritedThinking,
      status: 'disabled',
      reason: concreteModel,
    }
  }
  if (hostModels && hostModels.models.length > 0 && (!catalogEntry || !catalogEntry.available)) {
    return {
      concreteModel,
      thinkingLevel: inheritedThinking,
      status: 'unavailable',
      reason: concreteModel,
    }
  }

  return {
    concreteModel,
    thinkingLevel: resolveDefaultChainThinkingLevel(
      hostModels ?? undefined,
      ref,
      explicitThinking,
      'compaction',
    ),
    status: 'available',
  }
}

export function synthesizeDuoRecipeItems(
  recipes: Readonly<Record<string, DuoRecipe>>,
  hostModels: HostModelsSlice | null | undefined,
): DuoRecipeViewItem[] {
  return Object.values(recipes)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((recipe) => {
      const planner = resolveEndpointDisplay(recipe.plannerModel, recipe.plannerThinkingLevel, hostModels)
      const executor = resolveEndpointDisplay(recipe.executorModel, recipe.executorThinkingLevel, hostModels)
      let status: DuoRecipeAvailability = 'available'
      let unavailableReason: string | undefined
      if (planner.status !== 'available') {
        status = planner.status
        unavailableReason = planner.reason
      } else if (executor.status !== 'available') {
        status = executor.status
        unavailableReason = executor.reason
      }
      return {
        recipe,
        ...(planner.concreteModel !== undefined ? { resolvedPlannerModel: planner.concreteModel } : {}),
        ...(planner.thinkingLevel !== undefined ? { resolvedPlannerThinkingLevel: planner.thinkingLevel } : {}),
        ...(executor.concreteModel !== undefined ? { resolvedExecutorModel: executor.concreteModel } : {}),
        ...(executor.thinkingLevel !== undefined ? { resolvedExecutorThinkingLevel: executor.thinkingLevel } : {}),
        status,
        ...(unavailableReason !== undefined ? { unavailableReason } : {}),
      }
    })
}

export function filterDuoRecipeItems(
  items: ReadonlyArray<DuoRecipeViewItem>,
  search: string,
): DuoRecipeViewItem[] {
  const q = search.trim().toLowerCase()
  if (!q) return [...items]
  return items.filter(({ recipe, resolvedPlannerModel, resolvedExecutorModel }) => {
    const fields = [
      recipe.id,
      `tier/${recipe.id}`,
      recipe.name,
      recipe.description ?? '',
      recipe.plannerModel,
      recipe.executorModel,
      resolvedPlannerModel ?? '',
      resolvedExecutorModel ?? '',
    ]
    return fields.some((f) => f.toLowerCase().includes(q))
  })
}

export function matchDuoRecipeFromModelRef(
  modelRef: string | undefined,
  recipes: Readonly<Record<string, DuoRecipe>>,
): DuoRecipe | undefined {
  const tierId = parseTierRefId(modelRef)
  if (!tierId) return undefined
  return Object.hasOwn(recipes, tierId) ? recipes[tierId] : undefined
}

export function getStarterDuoPresets(
  locale: HelmxLocale,
  hostModels: HostModelsSlice | null | undefined,
): StarterDuoPreset[] {
  const externalTiers = (hostModels?.modelTiers ?? []).filter(
    (t) => t.displayGroup !== 'duo' && t.available && t.disabled !== true,
  )
  const hasTier = (id: string) => externalTiers.some((t) => t.id === id)
  const availableModels = (hostModels?.models ?? [])
    .filter((m) => m.available && m.disabled !== true)
    .map((m) => `${m.provider}/${m.modelId}`)

  const fallbackFirst = availableModels[0] ?? ''
  const fallbackSecond = availableModels[1] ?? availableModels[0] ?? ''
  const architectRef = hasTier('architect') ? 'tier/architect' : fallbackFirst
  const coderRef = hasTier('coder') ? 'tier/coder' : hasTier('workhorse') ? 'tier/workhorse' : fallbackSecond
  const fastRef = hasTier('scout') ? 'tier/scout' : hasTier('fast') ? 'tier/fast' : fallbackSecond

  if (locale === 'zh-CN') {
    return [
      {
        id: 'duo_architect',
        name: '架构规划 -> 工程实现',
        description: '高阶推理只读探索并撰写执行方案，交由主力工程模型落地修改与校验。',
        plannerModel: architectRef,
        executorModel: coderRef,
        maxExecutionSteps: DUO_DEFAULT_MAX_STEPS,
      },
      {
        id: 'duo_fast',
        name: '深度规划 -> 轻量快写',
        description: '规划端聚焦约束与方案，高频局部改动由轻量高并发模型快速完成。',
        plannerModel: architectRef,
        executorModel: fastRef,
        maxExecutionSteps: 20,
      },
    ]
  }
  return [
    {
      id: 'duo_architect',
      name: 'Architect -> Coder',
      description: 'Explore read-only with a flagship planner, then hand execution edits and checks to your coder.',
      plannerModel: architectRef,
      executorModel: coderRef,
      maxExecutionSteps: DUO_DEFAULT_MAX_STEPS,
    },
    {
      id: 'duo_fast',
      name: 'Planner -> Fast Worker',
      description: 'Reserve reasoning capacity for design and reviews while a fast executor applies targeted edits.',
      plannerModel: architectRef,
      executorModel: fastRef,
      maxExecutionSteps: 20,
    },
  ]
}

export function createEmptyDuoDraft(preset?: StarterDuoPreset): DuoRecipeDraft {
  return {
    id: preset?.id ?? '',
    name: preset?.name ?? '',
    description: preset?.description ?? '',
    plannerModel: preset?.plannerModel ?? '',
    plannerThinkingLevel: preset?.plannerThinkingLevel ?? '',
    executorModel: preset?.executorModel ?? '',
    executorThinkingLevel: preset?.executorThinkingLevel ?? '',
    maxExecutionSteps: String(preset?.maxExecutionSteps ?? DUO_DEFAULT_MAX_STEPS),
  }
}

export function recipeToDraft(recipe: DuoRecipe): DuoRecipeDraft {
  return {
    id: recipe.id,
    name: recipe.name,
    description: recipe.description ?? '',
    plannerModel: recipe.plannerModel,
    plannerThinkingLevel: recipe.plannerThinkingLevel ?? '',
    executorModel: recipe.executorModel,
    executorThinkingLevel: recipe.executorThinkingLevel ?? '',
    maxExecutionSteps: String(recipe.maxExecutionSteps),
  }
}

export function isDuoDraftDirty(draft: DuoRecipeDraft, baseline: DuoRecipeDraft): boolean {
  return (
    draft.id !== baseline.id ||
    draft.name !== baseline.name ||
    draft.description !== baseline.description ||
    draft.plannerModel !== baseline.plannerModel ||
    draft.plannerThinkingLevel !== baseline.plannerThinkingLevel ||
    draft.executorModel !== baseline.executorModel ||
    draft.executorThinkingLevel !== baseline.executorThinkingLevel ||
    draft.maxExecutionSteps !== baseline.maxExecutionSteps
  )
}

export function validateDuoDraft(
  draft: DuoRecipeDraft,
  options: {
    mode: 'create' | 'edit'
    existingRecipeIds: ReadonlySet<string>
    externalTierIds: ReadonlySet<string>
  },
): DuoDraftValidationError | null {
  const id = draft.id.trim()
  if (!id) return 'id_required'
  if (!DUO_ID_REGEX.test(id)) return 'id_invalid'
  if (options.externalTierIds.has(id)) return 'id_conflict'
  if (options.mode === 'create' && options.existingRecipeIds.has(id)) return 'id_conflict'

  const name = draft.name.trim()
  if (!name) return 'name_required'
  if (name.length > DUO_RECIPE_NAME_MAX_LENGTH) return 'name_too_long'

  const planner = draft.plannerModel.trim()
  if (!planner) return 'planner_required'
  const plannerTier = parseTierRefId(planner)
  if (plannerTier !== undefined && (plannerTier === id || options.existingRecipeIds.has(plannerTier))) {
    return 'planner_duo_ref'
  }

  const executor = draft.executorModel.trim()
  if (!executor) return 'executor_required'
  const executorTier = parseTierRefId(executor)
  if (executorTier !== undefined && (executorTier === id || options.existingRecipeIds.has(executorTier))) {
    return 'executor_duo_ref'
  }

  const parsedSteps = Number(draft.maxExecutionSteps.trim())
  if (!Number.isInteger(parsedSteps) || parsedSteps < 0 || parsedSteps > DUO_MAX_STEPS_LIMIT) {
    return 'steps_invalid'
  }

  if (draft.description.trim().length > DUO_DESCRIPTION_MAX_LENGTH) {
    return 'description_too_long'
  }

  return null
}
