/**
 * Pure data models & boundary parsers for builtin:tiers orchestrator toolbar pill and tool row.
 * Browser-safe, zero React component exports (Fast Refresh compliant).
 */
import type { ConversationSummary } from '@helmx/protocol/browser'
import { formatModelShortName } from '@helmx/plugin-client'

export const TIERS_ORCHESTRATOR_SESSION_DOC = 'orchestrator' as const
export const TIERS_EXIT_PLAN_MODE_TOOL = 'exit_plan_mode' as const
export const TIERS_HAND_BACK_TOOL = 'hand_back_to_planner' as const

export type TierOrchestratorPhase = 'planning' | 'execution'

export interface TierOrchestratorSessionView {
  tierId: string
  phase: TierOrchestratorPhase
  activeModel: string
  plannerModel: string
  executorModel: string
  executionStepCount: number
  maxExecutionSteps: number
  updatedAt: number
}

export interface OrchestratorTransitionMeta {
  tool: 'exit_plan_mode' | 'hand_back_to_planner'
  fromPhase: TierOrchestratorPhase
  toPhase: TierOrchestratorPhase
  fromModel: string
  toModel: string
  tierId: string
  reason?: string
  executionSteps?: number
  stepLimitReached?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function hasOrchestratorTierBound(
  conv: Pick<ConversationSummary, 'modelTier'> | undefined,
): boolean {
  return conv !== undefined && typeof conv.modelTier === 'string' && conv.modelTier !== ''
}

export function parseTierOrchestratorSessionView(raw: unknown): TierOrchestratorSessionView | null {
  if (!isRecord(raw)) return null
  const phase = raw['phase']
  if (phase !== 'planning' && phase !== 'execution') return null
  const tierId = raw['tierId']
  const activeModel = raw['activeModel']
  const plannerModel = raw['plannerModel']
  const executorModel = raw['executorModel']
  const executionStepCount = raw['executionStepCount']
  const maxExecutionSteps = raw['maxExecutionSteps']
  const updatedAt = raw['updatedAt']
  if (
    typeof tierId !== 'string' ||
    tierId === '' ||
    typeof activeModel !== 'string' ||
    activeModel === '' ||
    typeof plannerModel !== 'string' ||
    plannerModel === '' ||
    typeof executorModel !== 'string' ||
    executorModel === '' ||
    typeof executionStepCount !== 'number' ||
    !Number.isInteger(executionStepCount) ||
    executionStepCount < 0 ||
    typeof maxExecutionSteps !== 'number' ||
    !Number.isInteger(maxExecutionSteps) ||
    maxExecutionSteps < 0 ||
    typeof updatedAt !== 'number' ||
    !Number.isFinite(updatedAt)
  ) {
    return null
  }
  return {
    tierId,
    phase,
    activeModel,
    plannerModel,
    executorModel,
    executionStepCount,
    maxExecutionSteps,
    updatedAt,
  }
}

export function parseOrchestratorTransitionMeta(raw: unknown): OrchestratorTransitionMeta | undefined {
  if (!isRecord(raw)) return undefined
  const tool = raw['tool']
  const fromPhase = raw['fromPhase']
  const toPhase = raw['toPhase']
  const fromModel = raw['fromModel']
  const toModel = raw['toModel']
  const tierId = raw['tierId']
  if (
    (tool !== TIERS_EXIT_PLAN_MODE_TOOL && tool !== TIERS_HAND_BACK_TOOL) ||
    (fromPhase !== 'planning' && fromPhase !== 'execution') ||
    (toPhase !== 'planning' && toPhase !== 'execution') ||
    typeof fromModel !== 'string' ||
    fromModel === '' ||
    typeof toModel !== 'string' ||
    toModel === '' ||
    typeof tierId !== 'string' ||
    tierId === ''
  ) {
    return undefined
  }
  const reason = typeof raw['reason'] === 'string' && raw['reason'] !== '' ? raw['reason'] : undefined
  const executionSteps =
    typeof raw['executionSteps'] === 'number' && Number.isInteger(raw['executionSteps'])
      ? raw['executionSteps']
      : undefined
  const stepLimitReached = typeof raw['stepLimitReached'] === 'boolean' ? raw['stepLimitReached'] : undefined
  return {
    tool,
    fromPhase,
    toPhase,
    fromModel,
    toModel,
    tierId,
    ...(reason !== undefined ? { reason } : {}),
    ...(executionSteps !== undefined ? { executionSteps } : {}),
    ...(stepLimitReached !== undefined ? { stepLimitReached } : {}),
  }
}

export function formatOrchestratorPillModelLabel(
  activeModel: string,
  phase: TierOrchestratorPhase,
  executionStepCount: number,
  maxExecutionSteps: number,
): string {
  const short = formatModelShortName(activeModel) || activeModel.trim()
  if (phase === 'execution') {
    return maxExecutionSteps > 0
      ? `${short} (${executionStepCount}/${maxExecutionSteps})`
      : `${short} (${executionStepCount})`
  }
  return short
}
