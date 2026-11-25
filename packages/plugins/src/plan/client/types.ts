/**
 * Client-local contract mirror types & constants for builtin:plan.
 * Kept strictly inside clientRoot (never imports from ../contracts.js).
 */

export const PLAN_PLUGIN_ID = 'builtin:plan' as const
export const PLAN_SESSION_DOC = 'plan' as const
export const PLAN_BADGES_DOC = 'plan-badges' as const
export const PLAN_PANEL_ID = 'plan' as const
export const PLAN_COMMAND_ID = 'toggle-plan' as const
export const PLAN_COMMAND_SLASH = 'plan' as const
export const PLAN_TOOL_SAVE = 'plan_save' as const
export const PLAN_TOOL_PROPOSE = 'plan_propose' as const
export const PLAN_TOOL_ASK = 'plan_ask' as const

export type PlanMode = 'normal' | 'planning'

export interface PlanDraftSummary {
  title: string
  markdown: string
  version: number
  updatedAt: number
}

export interface PlanApprovedInfo {
  title: string
  version: number
  artifactId: string
  artifactName: string
  approvedAt: number
  handoffUsed: boolean
  executionModel?: string
}

export interface PlanSessionView {
  mode: PlanMode
  awaitingApproval: boolean
  awaitingClarification?: boolean
  draft?: PlanDraftSummary
  approved?: PlanApprovedInfo
}

export interface PlanBadgeEntry {
  count: number
  tone: 'accent' | 'warn' | 'neutral'
  footerText?: { en: string; 'zh-CN': string }
}

export interface PlanBadgesDoc {
  byConversation: Record<string, PlanBadgeEntry>
}

export type PlanProposeOutcome =
  | 'approved'
  | 'approved_handoff'
  | 'revised'
  | 'cancelled'
  | 'superseded'
  | 'error'

export type PlanAskOutcome = 'answered' | 'cancelled' | 'superseded' | 'error'

export type PlanToolPresentationMeta =
  | {
      kind: 'save'
      title: string
      version: number
      lineCount: number
      charCount: number
    }
  | {
      kind: 'propose'
      title: string
      version: number
      outcome: PlanProposeOutcome
      artifactId?: string
      artifactName?: string
      executionModel?: string
    }
  | {
      kind: 'ask'
      title: string
      questionCount: number
      outcome: PlanAskOutcome
    }
