/**
 * Contracts, schemas, and validation helpers for `builtin:orchestrator` Orchestrator.
 */
import {
  HelmxError,
  MODEL_TIER_DESCRIPTION_MAX_LENGTH,
  isValidModelTierId,
  parseModelTierRef,
  type ConversationScope,
  type ConversationSummary,
  type JsonSchema,
  type ModelTiersCapability,
  type ModelTierSpec,
} from '@helmx/protocol'
import { READ_ONLY_PLANNING_BASE_TOOLS } from '../shared-planning.js'

export const ORCHESTRATOR_PLUGIN_ID = 'builtin:orchestrator' as const
export const ORCHESTRATOR_SKILL_ID = 'orchestrator' as const

export const ORCHESTRATOR_STATE_DOC = 'state' as const
export const ORCHESTRATOR_SESSION_DOC = 'orchestrator' as const
export const ORCHESTRATOR_SCREEN_ID = 'main' as const
export const ORCHESTRATOR_ITEMS_KV = 'items' as const
export const ORCHESTRATOR_CONV_OVERRIDES_KV = 'conv_overrides' as const
export const ORCHESTRATOR_STATES_KV = 'states' as const

export const ORCHESTRATOR_ELIGIBLE_SCOPE: ConversationScope = {
  topLevelOnly: true,
  ownedBy: 'human',
}

export const ORCHESTRATOR_EXIT_PLAN_MODE_TOOL = 'exit_plan_mode' as const
export const ORCHESTRATOR_HAND_BACK_TOOL = 'hand_back_to_planner' as const
export const ORCHESTRATOR_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  ORCHESTRATOR_EXIT_PLAN_MODE_TOOL,
  ORCHESTRATOR_HAND_BACK_TOOL,
])

export const ORCHESTRATOR_PLAN_SECTION_ID = 'orchestrator.plan' as const
export const ORCHESTRATOR_EXECUTE_SECTION_ID = 'orchestrator.execute' as const
export const ORCHESTRATOR_STEP_LIMIT_SECTION_ID = 'orchestrator.step_limit' as const

export const ORCHESTRATOR_DEFAULT_MAX_STEPS = 30
export const ORCHESTRATOR_MAX_STEPS_LIMIT = 100
export const ORCHESTRATOR_NAME_MAX_LENGTH = 80
export const MAX_ORCHESTRATORS_COUNT = 32
export const ORCHESTRATOR_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type OrchestratorThinkingLevel = (typeof ORCHESTRATOR_THINKING_LEVELS)[number]

/** Planning baseline tools retained alongside exit_plan_mode and active delegation tools. */
export const ORCHESTRATOR_PLAN_BASE_TOOL_WHITELIST: ReadonlySet<string> = new Set([
  ...READ_ONLY_PLANNING_BASE_TOOLS,
  ORCHESTRATOR_EXIT_PLAN_MODE_TOOL,
])

export const COORDINATOR_SUPPRESS_TAG = 'swarm-coordinator' as const

export type OrchestratorPhase = 'planning' | 'execution'
export type OrchestratorTransitionTool = typeof ORCHESTRATOR_EXIT_PLAN_MODE_TOOL | typeof ORCHESTRATOR_HAND_BACK_TOOL

export interface OrchestratorItem {
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

export interface OrchestratorItemView extends OrchestratorItem {
  resolvedPlannerModel?: string
  resolvedPlannerThinkingLevel?: string
  resolvedExecutorModel?: string
  resolvedExecutorThinkingLevel?: string
  available: boolean
  unavailableReason?: string
}

export interface OrchestratorStateDocSnapshot {
  items: Record<string, OrchestratorItem>
}

export interface OrchestratorConversationOverrideRecord {
  conversationId: number
  executorModel: string
  executorThinkingLevel?: string
  maxExecutionSteps?: number
  updatedAt: number
}

export interface OrchestratorResolvedConfig {
  orchestratorId: string
  orchestratorName: string
  plannerModel: string
  plannerThinkingLevel?: string
  executorModel: string
  executorThinkingLevel?: string
  maxExecutionSteps: number
  hasExecutorOverride: boolean
}

export interface OrchestratorRuntimeRecord {
  conversationId: number
  orchestratorId?: string
  phase: OrchestratorPhase
  executorModel: string
  executorThinkingLevel?: string
  maxExecutionSteps: number
  executionStepCount: number
  stepLimitPaused?: boolean
  planText?: string
  planFilePath?: string
  turnHadSteer?: boolean
  activeRuntimeOverride?: boolean
  planChosenModelActive?: boolean
  updatedAt: number
}

export interface OrchestratorSessionView {
  enabled: boolean
  orchestratorId: string
  orchestratorName: string
  phase: OrchestratorPhase
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

export type OrchestratorTransitionMeta = {
  tool: OrchestratorTransitionTool
  fromModel: string
  toModel: string
  fromPhase: OrchestratorPhase
  toPhase: OrchestratorPhase
  reason?: string
}

export const ORCHESTRATOR_ITEM_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['id', 'name', 'plannerModel', 'executorModel', 'maxExecutionSteps', 'updatedAt'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1, maxLength: ORCHESTRATOR_NAME_MAX_LENGTH },
    description: { type: 'string', maxLength: MODEL_TIER_DESCRIPTION_MAX_LENGTH },
    plannerModel: { type: 'string', minLength: 1 },
    plannerThinkingLevel: { type: 'string', enum: [...ORCHESTRATOR_THINKING_LEVELS] },
    executorModel: { type: 'string', minLength: 1 },
    executorThinkingLevel: { type: 'string', enum: [...ORCHESTRATOR_THINKING_LEVELS] },
    maxExecutionSteps: { type: 'integer', minimum: 0, maximum: ORCHESTRATOR_MAX_STEPS_LIMIT },
    updatedAt: { type: 'number' },
  },
}

export const ORCHESTRATOR_ITEM_VIEW_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['id', 'name', 'plannerModel', 'executorModel', 'maxExecutionSteps', 'updatedAt', 'available'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1, maxLength: ORCHESTRATOR_NAME_MAX_LENGTH },
    description: { type: 'string', maxLength: MODEL_TIER_DESCRIPTION_MAX_LENGTH },
    plannerModel: { type: 'string', minLength: 1 },
    plannerThinkingLevel: { type: 'string', enum: [...ORCHESTRATOR_THINKING_LEVELS] },
    executorModel: { type: 'string', minLength: 1 },
    executorThinkingLevel: { type: 'string', enum: [...ORCHESTRATOR_THINKING_LEVELS] },
    maxExecutionSteps: { type: 'integer', minimum: 0, maximum: ORCHESTRATOR_MAX_STEPS_LIMIT },
    updatedAt: { type: 'number' },
    resolvedPlannerModel: { type: 'string' },
    resolvedPlannerThinkingLevel: { type: 'string' },
    resolvedExecutorModel: { type: 'string' },
    resolvedExecutorThinkingLevel: { type: 'string' },
    available: { type: 'boolean' },
    unavailableReason: { type: 'string' },
  },
}

export const ORCHESTRATOR_SESSION_VIEW_SCHEMA: JsonSchema = {
  type: 'object',
  required: [
    'enabled',
    'orchestratorId',
    'orchestratorName',
    'phase',
    'plannerModel',
    'executorModel',
    'maxExecutionSteps',
    'executionStepCount',
    'stepLimitPaused',
    'hasExecutorOverride',
  ],
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    orchestratorId: { type: 'string' },
    orchestratorName: { type: 'string' },
    phase: { type: 'string', enum: ['planning', 'execution'] },
    plannerModel: { type: 'string' },
    plannerThinkingLevel: { type: 'string' },
    executorModel: { type: 'string' },
    executorThinkingLevel: { type: 'string' },
    maxExecutionSteps: { type: 'integer', minimum: 0, maximum: ORCHESTRATOR_MAX_STEPS_LIMIT },
    executionStepCount: { type: 'integer', minimum: 0 },
    stepLimitPaused: { type: 'boolean' },
    suppressedByCoordinator: { type: 'boolean' },
    hasExecutorOverride: { type: 'boolean' },
  },
}

export const ORCHESTRATOR_TRANSITION_META_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['tool', 'fromModel', 'toModel', 'fromPhase', 'toPhase'],
  additionalProperties: false,
  properties: {
    tool: { type: 'string', enum: [ORCHESTRATOR_EXIT_PLAN_MODE_TOOL, ORCHESTRATOR_HAND_BACK_TOOL] },
    fromModel: { type: 'string' },
    toModel: { type: 'string' },
    fromPhase: { type: 'string', enum: ['planning', 'execution'] },
    toPhase: { type: 'string', enum: ['planning', 'execution'] },
    reason: { type: 'string' },
  },
}

export function isOrchestratorConversationEligible(
  conv: Pick<ConversationSummary, 'parentConversationId' | 'ownedBy'>,
): boolean {
  return conv.parentConversationId === undefined && (conv.ownedBy ?? 'human') === 'human'
}

export function isCoordinatorSuppressed(conv: Pick<ConversationSummary, 'tags'>): boolean {
  return Array.isArray(conv.tags) && conv.tags.includes(COORDINATOR_SUPPRESS_TAG)
}

export function assertOrchestratorId(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new HelmxError('validation_error', 'Orchestrator id must be a string', 400, { id: raw })
  }
  const id = raw.trim()
  if (!isValidModelTierId(id)) {
    throw new HelmxError(
      'validation_error',
      `Orchestrator id '${id}' must match /^[a-z0-9][a-z0-9_-]{0,63}$/`,
      400,
      { id: raw },
    )
  }
  return id
}

export function normalizeOrchestratorName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new HelmxError('validation_error', 'Orchestrator name must be a non-empty string', 400, { name: raw })
  }
  const name = raw.trim()
  if (!name || name.length > ORCHESTRATOR_NAME_MAX_LENGTH) {
    throw new HelmxError(
      'validation_error',
      `Orchestrator name must be 1..${ORCHESTRATOR_NAME_MAX_LENGTH} characters`,
      400,
      { name: raw },
    )
  }
  return name
}

export function normalizeOrchestratorDescription(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new HelmxError('validation_error', 'Orchestrator description must be a string', 400, { description: raw })
  }
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (trimmed.length > MODEL_TIER_DESCRIPTION_MAX_LENGTH) {
    throw new HelmxError(
      'validation_error',
      `Orchestrator description exceeds max length (${MODEL_TIER_DESCRIPTION_MAX_LENGTH})`,
      400,
      { descriptionLength: trimmed.length },
    )
  }
  return trimmed
}

export function normalizeOrchestratorModelRef(raw: unknown, field = 'executorModel'): string {
  if (typeof raw !== 'string') {
    throw new HelmxError('validation_error', `${field} must be a non-empty string`, 400)
  }
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new HelmxError('validation_error', `${field} must be non-empty`, 400)
  }
  if (trimmed.startsWith('tier/')) {
    const tierId = trimmed.slice('tier/'.length)
    if (!isValidModelTierId(tierId)) {
      throw new HelmxError('validation_error', `${field} has invalid tier reference "${trimmed}"`, 400)
    }
    return `tier/${tierId}`
  }
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash >= trimmed.length - 1) {
    throw new HelmxError(
      'validation_error',
      `${field} must be in "provider/modelId" or "tier/<id>" form`,
      400,
    )
  }
  return trimmed
}

export function normalizeOrchestratorThinkingLevel(raw: unknown, field = 'executorThinkingLevel'): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new HelmxError('validation_error', `${field} must be a string`, 400)
  }
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (!(ORCHESTRATOR_THINKING_LEVELS as readonly string[]).includes(trimmed)) {
    throw new HelmxError(
      'validation_error',
      `${field} must be one of: ${ORCHESTRATOR_THINKING_LEVELS.join(', ')}`,
      400,
    )
  }
  return trimmed
}

export function normalizeMaxExecutionSteps(raw: unknown, fallback = ORCHESTRATOR_DEFAULT_MAX_STEPS): number {
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > ORCHESTRATOR_MAX_STEPS_LIMIT) {
    throw new HelmxError(
      'validation_error',
      `maxExecutionSteps must be an integer between 0 and ${ORCHESTRATOR_MAX_STEPS_LIMIT}`,
      400,
    )
  }
  return raw
}

export function formatOrchestratorModelShortName(modelRef: string | undefined): string {
  if (!modelRef) return ''
  const trimmed = modelRef.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('tier/') && trimmed.length > 'tier/'.length) {
    return trimmed
  }
  const slash = trimmed.lastIndexOf('/')
  return slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed
}

/**
 * Collect concrete external `ModelTierSpec` definitions from all non-Orchestrator providers
 * implementing `'helmx.model-tiers'` (e.g. `builtin:tiers`).
 */
export function collectExternalTierMap(
  providers: ReadonlyArray<{ pluginId: string; impl: ModelTiersCapability }>,
): Record<string, ModelTierSpec> {
  const map: Record<string, ModelTierSpec> = {}
  for (const entry of providers) {
    if (entry.pluginId === ORCHESTRATOR_PLUGIN_ID) continue
    let tiers: Readonly<Record<string, ModelTierSpec>> | undefined
    try {
      tiers = entry.impl.getTiers()
    } catch {
      continue
    }
    if (!tiers || typeof tiers !== 'object') continue
    for (const [tierId, spec] of Object.entries(tiers)) {
      if (!spec || typeof spec.model !== 'string' || !spec.model.trim()) continue
      // External tier entries must resolve to concrete provider/model refs (never nested tier/<id>).
      if (parseModelTierRef(spec.model) !== undefined) continue
      map[tierId] = spec
    }
  }
  return map
}

/**
 * Resolve a model ref (`provider/model` or external `tier/<id>`) into a concrete model + thinking level.
 * Returns `undefined` when `modelRef` points to a missing/unmounted external `tier/<id>`.
 */
export function resolveOrchestratorModelThroughExternalTiers(
  modelRef: string,
  explicitThinkingLevel: string | undefined,
  externalTiers: Readonly<Record<string, ModelTierSpec>>,
): { model: string; thinkingLevel?: string } | undefined {
  const tierId = parseModelTierRef(modelRef)
  if (tierId === undefined) {
    return {
      model: modelRef,
      ...(explicitThinkingLevel !== undefined ? { thinkingLevel: explicitThinkingLevel } : {}),
    }
  }
  const entry = Object.hasOwn(externalTiers, tierId) ? externalTiers[tierId] : undefined
  if (!entry) return undefined
  const thinking = explicitThinkingLevel ?? entry.thinkingLevel
  return {
    model: entry.model,
    ...(thinking !== undefined ? { thinkingLevel: thinking } : {}),
  }
}
