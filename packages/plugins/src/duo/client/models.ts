/**
 * Pure UI state parsing, validation helpers, and presentationMeta extractors for `builtin:duo` client.
 */
import type { ConversationSummary, HostModelEntry } from '@helmx/protocol/browser'

export const DUO_PLUGIN_ID = 'builtin:duo' as const
export const DUO_PROFILES_DOC = 'profiles' as const
export const DUO_SESSION_DOC = 'duo' as const
export const DUO_EXIT_PLAN_MODE_TOOL = 'exit_plan_mode' as const
export const DUO_HAND_BACK_TOOL = 'hand_back_to_planner' as const
export const DUO_DEFAULT_MAX_STEPS = 30
export const DUO_MAX_STEPS_LIMIT = 100

export type DuoPhase = 'planning' | 'execution'
export type DuoTransitionTool = typeof DUO_EXIT_PLAN_MODE_TOOL | typeof DUO_HAND_BACK_TOOL

export interface DuoProfileConfigView {
  enabled: boolean
  executorModel: string
  executorThinkingLevel?: string
  maxExecutionSteps: number
  updatedAt: number
}

export interface DuoSessionView {
  enabled: boolean
  source?: 'conversation' | 'profile'
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

export interface DuoStandbyMeta {
  enabled: boolean
  executorModel?: string
  executorThinkingLevel?: string
  maxExecutionSteps?: number
}

export interface DuoTransitionMetaView {
  tool: DuoTransitionTool
  fromModel: string
  toModel: string
  fromPhase: DuoPhase
  toPhase: DuoPhase
  reason?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

export function isDuoEligibleConversation(
  conv: Pick<ConversationSummary, 'parentConversationId' | 'ownedBy'> | undefined,
): boolean {
  if (conv === undefined) return false
  return conv.parentConversationId === undefined && (conv.ownedBy ?? 'human') === 'human'
}

export function parseDuoProfilesDoc(raw: unknown): Record<string, DuoProfileConfigView> {
  if (!isRecord(raw) || !isRecord(raw.profiles)) return {}
  const out: Record<string, DuoProfileConfigView> = {}
  for (const [id, entry] of Object.entries(raw.profiles)) {
    if (!isRecord(entry) || typeof entry.enabled !== 'boolean' || typeof entry.executorModel !== 'string') continue
    out[id] = {
      enabled: entry.enabled,
      executorModel: entry.executorModel,
      ...(typeof entry.executorThinkingLevel === 'string' && entry.executorThinkingLevel
        ? { executorThinkingLevel: entry.executorThinkingLevel }
        : {}),
      maxExecutionSteps:
        typeof entry.maxExecutionSteps === 'number' && Number.isInteger(entry.maxExecutionSteps)
          ? entry.maxExecutionSteps
          : DUO_DEFAULT_MAX_STEPS,
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
    }
  }
  return out
}

export function parseDuoSessionDoc(raw: unknown): DuoSessionView | null {
  if (!isRecord(raw) || raw.enabled !== true || typeof raw.plannerModel !== 'string') return null
  const phase: DuoPhase = raw.phase === 'execution' ? 'execution' : 'planning'
  return {
    enabled: true,
    ...(raw.source === 'conversation' || raw.source === 'profile' ? { source: raw.source } : {}),
    phase,
    plannerModel: raw.plannerModel,
    ...(typeof raw.plannerThinkingLevel === 'string' && raw.plannerThinkingLevel
      ? { plannerThinkingLevel: raw.plannerThinkingLevel }
      : {}),
    ...(typeof raw.executorModel === 'string' && raw.executorModel
      ? { executorModel: raw.executorModel }
      : {}),
    ...(typeof raw.executorThinkingLevel === 'string' && raw.executorThinkingLevel
      ? { executorThinkingLevel: raw.executorThinkingLevel }
      : {}),
    maxExecutionSteps:
      typeof raw.maxExecutionSteps === 'number' && Number.isInteger(raw.maxExecutionSteps)
        ? raw.maxExecutionSteps
        : DUO_DEFAULT_MAX_STEPS,
    executionStepCount:
      typeof raw.executionStepCount === 'number' && Number.isInteger(raw.executionStepCount)
        ? raw.executionStepCount
        : 0,
    stepLimitPaused: raw.stepLimitPaused === true,
    ...(raw.suppressedByCoordinator === true ? { suppressedByCoordinator: true } : {}),
    hasConversationOverride: raw.hasConversationOverride === true,
    ...(typeof raw.profileId === 'string' && raw.profileId ? { profileId: raw.profileId } : {}),
  }
}

export function parseDuoStandbyMeta(draftMeta: Readonly<Record<string, unknown>> | undefined): DuoStandbyMeta | undefined {
  if (draftMeta === undefined) return undefined
  const raw = draftMeta[DUO_PLUGIN_ID]
  if (!isRecord(raw) || typeof raw.enabled !== 'boolean') return undefined
  return {
    enabled: raw.enabled,
    ...(typeof raw.executorModel === 'string' && raw.executorModel
      ? { executorModel: raw.executorModel }
      : {}),
    ...(typeof raw.executorThinkingLevel === 'string' && raw.executorThinkingLevel
      ? { executorThinkingLevel: raw.executorThinkingLevel }
      : {}),
    ...(typeof raw.maxExecutionSteps === 'number' && Number.isInteger(raw.maxExecutionSteps)
      ? { maxExecutionSteps: raw.maxExecutionSteps }
      : {}),
  }
}

export function parseDuoTransitionPresentationMeta(raw: unknown): DuoTransitionMetaView | undefined {
  if (!isRecord(raw)) return undefined
  const tool = raw.tool
  if (tool !== DUO_EXIT_PLAN_MODE_TOOL && tool !== DUO_HAND_BACK_TOOL) return undefined
  if (typeof raw.fromModel !== 'string' || typeof raw.toModel !== 'string') return undefined
  const fromPhase = raw.fromPhase === 'execution' ? 'execution' : 'planning'
  const toPhase = raw.toPhase === 'execution' ? 'execution' : 'planning'
  return {
    tool,
    fromModel: raw.fromModel,
    toModel: raw.toModel,
    fromPhase,
    toPhase,
    ...(typeof raw.reason === 'string' && raw.reason ? { reason: raw.reason } : {}),
  }
}

export function extractFallbackTransitionInfo(rawInput: unknown): string | undefined {
  if (!isRecord(rawInput)) return undefined
  if (typeof rawInput.reason === 'string' && rawInput.reason.trim()) return rawInput.reason.trim()
  if (typeof rawInput.plan === 'string' && rawInput.plan.trim()) {
    const first = rawInput.plan.trim().split(/\r?\n/)[0]?.trim() ?? ''
    return first.length > 72 ? `${first.slice(0, 72)}…` : first
  }
  return undefined
}

export function extractFirstErrorLine(rawResult: string | undefined): string | undefined {
  if (typeof rawResult !== 'string') return undefined
  const line = rawResult
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean)
  if (!line) return undefined
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

export function validateMaxStepsInput(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return DUO_DEFAULT_MAX_STEPS
  if (!/^\d+$/.test(trimmed)) return null
  const parsed = Number.parseInt(trimmed, 10)
  if (parsed < 0 || parsed > DUO_MAX_STEPS_LIMIT) return null
  return parsed
}

export function resolveModelAvailabilityWarning(
  modelRef: string | undefined,
  models: ReadonlyArray<HostModelEntry>,
): 'disabled' | 'unavailable' | undefined {
  if (!modelRef || modelRef.startsWith('tier/')) return undefined
  const entry = models.find((m) => m.id === modelRef)
  if (!entry) return 'unavailable'
  if (entry.disabled === true) return 'disabled'
  return entry.available ? undefined : 'unavailable'
}
