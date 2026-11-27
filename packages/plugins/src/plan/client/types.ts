/**
 * Client-local constants & contract types for builtin:plan.
 * 类型以 `../contracts.js` 为唯一事实来源（仅 `import type`，编译期擦除，不会把服务端运行时代码拉进浏览器 bundle）；
 * 常量是运行时值，受 clientRoot 包含性约束必须留在 client 目录内（禁止从 client 外做运行时导入）。
 */
import type {
  PlanApprovedInfo,
  PlanBadgeEntry,
  PlanBadgesDoc,
  PlanDraftSummary,
  PlanMode,
  PlanProposeOutcome,
  PlanSessionView,
  PlanToolPresentationMeta,
} from '../contracts.js'

export type {
  PlanApprovedInfo,
  PlanBadgeEntry,
  PlanBadgesDoc,
  PlanDraftSummary,
  PlanMode,
  PlanProposeOutcome,
  PlanSessionView,
  PlanToolPresentationMeta,
}

export const PLAN_PLUGIN_ID = 'builtin:plan' as const
export const PLAN_SESSION_DOC = 'plan' as const
export const PLAN_BADGES_DOC = 'plan-badges' as const
export const PLAN_PANEL_ID = 'plan' as const
export const PLAN_COMMAND_ID = 'toggle-plan' as const
export const PLAN_COMMAND_SLASH = 'plan' as const
export const PLAN_TOOL_SAVE = 'plan_save' as const
export const PLAN_TOOL_PROPOSE = 'plan_propose' as const
