/**
 * builtin:tiers shared contracts (pure data shapes & constants, browser-safe).
 */
import type { ModelTierSpec } from '@helmx/protocol'

export const TIERS_PLUGIN_ID = 'builtin:tiers' as const
export const TIERS_STATE_DOC = 'state' as const
export const TIERS_SCREEN_ID = 'main' as const
export const MODEL_TIERS_SKILL_ID = 'model-tiers' as const

export const TIER_TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/
export const TIER_TEMPLATE_NAME_MAX_LENGTH = 80
export const TIER_TEMPLATE_DESCRIPTION_MAX_LENGTH = 240
export const MAX_TIERS_COUNT = 32
export const MAX_TEMPLATES_COUNT = 32

/** Valid thinking levels matching kernel THINKING_LEVELS. */
export const TIER_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type TierThinkingLevel = (typeof TIER_THINKING_LEVELS)[number]

/** User-defined reusable tier preset template. */
export interface TierTemplate {
  id: string
  name: string
  description?: string
  tiers: Record<string, ModelTierSpec>
  updatedAt: number
}

/** Durable global state document (`ctx.doc('state', ...)`). */
export interface TiersStateDoc {
  /** Active tier bindings mounted into kernel ModelRegistry (`tier/<id>`). */
  tiers: Record<string, ModelTierSpec>
  /** Saved user-defined preset templates for one-click roster switching. */
  templates: Record<string, TierTemplate>
  /** Advisory ID of the last applied template (cleared when active tiers are individually edited). */
  activeTemplate?: string
}

export interface TiersPluginConfig {
  /** Inject concise `<available_model_tiers>` directory into each turn when available tiers exist (default true). */
  autoInjectCatalog?: boolean
}

export function createEmptyTiersState(): TiersStateDoc {
  return { tiers: {}, templates: {} }
}
