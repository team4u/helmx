/**
 * Shared constants, JSON schemas, and pure helpers for `builtin:duo` (dual-phase planning/execution orchestration).
 */
import {
  HelmxError,
  MODEL_TIER_PREFIX,
  isJsonObject,
  isValidModelTierId,
  parseModelTierRef,
  type ConversationScope,
  type ConversationSummary,
  type JsonSchema,
  type ModelTiersCapability,
} from '@helmx/protocol'
import { isTopLevelHumanConversation } from '../shared-helpers.js'
import { READ_ONLY_PLANNING_BASE_TOOLS } from '../shared-planning.js'

export const DUO_PLUGIN_ID = 'builtin:duo' as const
export const DUO_SKILL_ID = 'duo' as const

export const DUO_PROFILES_DOC = 'profiles' as const
export const DUO_SESSION_DOC = 'duo' as const
export const DUO_PROFILES_KV = 'profile_configs' as const
export const DUO_CONV_CONFIGS_KV = 'conv_configs' as const
export const DUO_STATES_KV = 'states' as const
export const DUO_INPUT_META_KEY = DUO_PLUGIN_ID

export const DUO_ELIGIBLE_SCOPE: ConversationScope = {
  topLevelOnly: true,
  ownedBy: 'human',
}

export const DUO_EXIT_PLAN_MODE_TOOL = 'exit_plan_mode' as const
export const DUO_HAND_BACK_TOOL = 'hand_back_to_planner' as const
export const DUO_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  DUO_EXIT_PLAN_MODE_TOOL,
  DUO_HAND_BACK_TOOL,
])

export const DUO_PLAN_SECTION_ID = 'duo.plan' as const
export const DUO_EXECUTE_SECTION_ID = 'duo.execute' as const
export const DUO_STEP_LIMIT_SECTION_ID = 'duo.step_limit' as const

export const DUO_DEFAULT_MAX_STEPS = 30
export const DUO_MAX_STEPS_LIMIT = 100
export const DUO_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type DuoThinkingLevel = (typeof DUO_THINKING_LEVELS)[number]
const VALID_THINKING_SET: ReadonlySet<string> = new Set(DUO_THINKING_LEVELS)

export const DUO_PLAN_BASE_TOOL_WHITELIST: ReadonlySet<string> = new Set([
  ...READ_ONLY_PLANNING_BASE_TOOLS,
  DUO_EXIT_PLAN_MODE_TOOL,
])

export const COORDINATOR_SUPPRESS_TAG = 'swarm-coordinator' as const

export type DuoPhase = 'planning' | 'execution'
export type DuoTransitionTool = typeof DUO_EXIT_PLAN_MODE_TOOL | typeof DUO_HAND_BACK_TOOL
export type DuoConfigSource = 'conversation' | 'profile'

export interface DuoProfileConfig {
  enabled: boolean
  executorModel: string
  executorThinkingLevel?: string
  maxExecutionSteps: number
  updatedAt: number
}

export interface DuoProfilesDocSnapshot {
  profiles: Record<string, DuoProfileConfig>
}

export interface DuoConversationConfigRecord {
  conversationId: number
  enabled: boolean
  executorModel?: string
  executorThinkingLevel?: string
  maxExecutionSteps?: number
  updatedAt: number
}

export interface DuoResolvedConfig {
  source: DuoConfigSource
  executorModel: string
  executorThinkingLevel?: string
  maxExecutionSteps: number
  profileId?: string
  hasConversationOverride: boolean
}

export interface DuoRuntimeRecord {
  conversationId: number
  phase: DuoPhase
  executorModel: string
  executorThinkingLevel?: string
  maxExecutionSteps: number
  executionStepCount: number
  stepLimitPaused?: boolean
  planText?: string
  planFilePath?: string
  turnHadSteer?: boolean
  /** True when `builtin:duo` itself applied a runtime model override that must be cleared on hand-back / settle / reset / stop. */
  activeRuntimeOverride: boolean
  /** True when `plan.approved` transitioned to execution with a human-chosen model (`modelSwitched: true`). */
  planChosenModelActive?: boolean
  updatedAt: number
}

export interface DuoSessionView {
  enabled: boolean
  source?: DuoConfigSource
  phase: DuoPhase
  plannerModel: string
  plannerThinkingLevel?: string
  executorModel?: string
  executorThinkingLevel?: string
  maxExecutionSteps: number
  executionStepCount: number
  stepLimitPaused: boolean
  suppressedByCoordinator?: boolean
  hasConversationOverride: boolean
  profileId?: string
}

export type DuoTransitionMeta = {
  tool: DuoTransitionTool
  fromModel: string
  toModel: string
  fromPhase: DuoPhase
  toPhase: DuoPhase
  reason?: string
}

export const DUO_PROFILE_CONFIG_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['enabled', 'executorModel', 'maxExecutionSteps', 'updatedAt'],
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    executorModel: { type: 'string' },
    executorThinkingLevel: { type: 'string' },
    maxExecutionSteps: { type: 'integer', minimum: 0, maximum: DUO_MAX_STEPS_LIMIT },
    updatedAt: { type: 'number' },
  },
}

export const DUO_SESSION_VIEW_SCHEMA: JsonSchema = {
  type: 'object',
  required: [
    'enabled',
    'phase',
    'plannerModel',
    'maxExecutionSteps',
    'executionStepCount',
    'stepLimitPaused',
    'hasConversationOverride',
  ],
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    source: { type: 'string', enum: ['conversation', 'profile'] },
    phase: { type: 'string', enum: ['planning', 'execution'] },
    plannerModel: { type: 'string' },
    plannerThinkingLevel: { type: 'string' },
    executorModel: { type: 'string' },
    executorThinkingLevel: { type: 'string' },
    maxExecutionSteps: { type: 'integer', minimum: 0, maximum: DUO_MAX_STEPS_LIMIT },
    executionStepCount: { type: 'integer', minimum: 0 },
    stepLimitPaused: { type: 'boolean' },
    suppressedByCoordinator: { type: 'boolean' },
    hasConversationOverride: { type: 'boolean' },
    profileId: { type: 'string' },
  },
}

export const DUO_TRANSITION_META_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['tool', 'fromModel', 'toModel', 'fromPhase', 'toPhase'],
  additionalProperties: false,
  properties: {
    tool: { type: 'string', enum: [DUO_EXIT_PLAN_MODE_TOOL, DUO_HAND_BACK_TOOL] },
    fromModel: { type: 'string', minLength: 1 },
    toModel: { type: 'string', minLength: 1 },
    fromPhase: { type: 'string', enum: ['planning', 'execution'] },
    toPhase: { type: 'string', enum: ['planning', 'execution'] },
    reason: { type: 'string' },
  },
}

export function isDuoConversationEligible(conv: Pick<ConversationSummary, 'parentConversationId' | 'ownedBy'>): boolean {
  return isTopLevelHumanConversation(conv)
}

export function isCoordinatorSuppressed(conv: Pick<ConversationSummary, 'tags'>): boolean {
  return Array.isArray(conv.tags) && conv.tags.includes(COORDINATOR_SUPPRESS_TAG)
}

export function normalizeDuoModelRef(raw: unknown, field = 'executorModel'): string {
  if (typeof raw !== 'string') {
    throw new HelmxError('validation_error', `${field} must be a non-empty 'provider/model' or 'tier/<id>' string`, 400)
  }
  const model = raw.trim()
  const slash = model.indexOf('/')
  if (slash <= 0 || slash >= model.length - 1 || /\s/.test(model)) {
    throw new HelmxError(
      'validation_error',
      `${field} must be in 'provider/model' or 'tier/<id>' format: ${raw}`,
      400,
      { model: raw },
    )
  }
  if (model.slice(0, slash) === MODEL_TIER_PREFIX) {
    const tierId = model.slice(slash + 1)
    if (!isValidModelTierId(tierId)) {
      throw new HelmxError('validation_error', `Invalid tier reference '${model}'`, 400, { model })
    }
  }
  return model
}

export function normalizeDuoThinkingLevel(raw: unknown, field = 'executorThinkingLevel'): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new HelmxError('validation_error', `${field} must be a string`, 400)
  }
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (!VALID_THINKING_SET.has(trimmed)) {
    throw new HelmxError(
      'validation_error',
      `Invalid ${field} '${trimmed}'; valid values: ${DUO_THINKING_LEVELS.join(' | ')}`,
      400,
      { thinkingLevel: trimmed },
    )
  }
  return trimmed
}

export function normalizeMaxExecutionSteps(raw: unknown, fallback = DUO_DEFAULT_MAX_STEPS): number {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > DUO_MAX_STEPS_LIMIT) {
    throw new HelmxError(
      'validation_error',
      `maxExecutionSteps must be an integer between 0 and ${DUO_MAX_STEPS_LIMIT} (0 = unlimited)`,
      400,
      { maxExecutionSteps: raw },
    )
  }
  return raw
}

export function resolveDuoModelThroughTiers(
  modelRef: string,
  thinkingLevel: string | undefined,
  tiersCap: ModelTiersCapability | undefined,
): { model: string; thinkingLevel?: string } {
  const tierId = parseModelTierRef(modelRef)
  if (tierId === undefined || tiersCap === undefined) {
    return {
      model: modelRef,
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    }
  }
  const spec = tiersCap.getTiers()[tierId]
  if (spec === undefined) {
    return {
      model: modelRef,
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    }
  }
  const effectiveThinking = thinkingLevel ?? spec.thinkingLevel
  return {
    model: spec.model,
    ...(effectiveThinking !== undefined && effectiveThinking !== '' ? { thinkingLevel: effectiveThinking } : {}),
  }
}

export type ParsedDuoInputMeta =
  | { present: false }
  | {
      present: true
      valid: true
      enabled: boolean
      executorModel?: string
      executorThinkingLevel?: string
      maxExecutionSteps?: number
    }
  | { present: true; valid: false; reason: string }

export function parseDuoInputMeta(meta: unknown): ParsedDuoInputMeta {
  if (!isJsonObject(meta) || !Object.hasOwn(meta, DUO_INPUT_META_KEY)) {
    return { present: false }
  }
  const entry = meta[DUO_INPUT_META_KEY]
  if (!isJsonObject(entry)) {
    return { present: true, valid: false, reason: `input.meta['${DUO_INPUT_META_KEY}'] must be an object` }
  }
  if (typeof entry['enabled'] !== 'boolean') {
    return { present: true, valid: false, reason: `input.meta['${DUO_INPUT_META_KEY}'].enabled must be a boolean` }
  }
  const enabled = entry['enabled']
  if (!enabled) {
    return { present: true, valid: true, enabled: false }
  }
  let executorModel: string | undefined
  if (entry['executorModel'] !== undefined) {
    try {
      executorModel = normalizeDuoModelRef(entry['executorModel'], 'input.meta.executorModel')
    } catch (err) {
      return { present: true, valid: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }
  let executorThinkingLevel: string | undefined
  if (entry['executorThinkingLevel'] !== undefined) {
    try {
      executorThinkingLevel = normalizeDuoThinkingLevel(
        entry['executorThinkingLevel'],
        'input.meta.executorThinkingLevel',
      )
    } catch (err) {
      return { present: true, valid: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }
  let maxExecutionSteps: number | undefined
  if (entry['maxExecutionSteps'] !== undefined) {
    try {
      maxExecutionSteps = normalizeMaxExecutionSteps(entry['maxExecutionSteps'])
    } catch (err) {
      return { present: true, valid: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }
  return {
    present: true,
    valid: true,
    enabled: true,
    ...(executorModel !== undefined ? { executorModel } : {}),
    ...(executorThinkingLevel !== undefined ? { executorThinkingLevel } : {}),
    ...(maxExecutionSteps !== undefined ? { maxExecutionSteps } : {}),
  }
}
