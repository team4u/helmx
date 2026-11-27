/**
 * Client-local constants & contract types for builtin:steps.
 * Uses type-only imports from `../contracts.js` to stay strictly contained inside `clientRoot`.
 */
import type {
  StepItem,
  StepStatus,
  StepsSessionView,
  StepsSettledOutcome,
  StepsToolPresentationMeta,
} from '../contracts.js'

export type {
  StepItem,
  StepStatus,
  StepsSessionView,
  StepsSettledOutcome,
  StepsToolPresentationMeta,
}

export const STEPS_PLUGIN_ID = 'builtin:steps' as const
export const STEPS_SESSION_DOC = 'steps' as const
export const STEPS_TOOL_UPDATE = 'update_steps' as const
export const STEPS_MAX_ITEMS = 12 as const
export const STEPS_TITLE_MAX_CHARS = 120 as const
