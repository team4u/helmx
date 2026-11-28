/**
 * Shared constants and pure contracts for `builtin:tiers` (1 tier = 1 model + preset templates).
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

export const TIER_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type TierThinkingLevel = (typeof TIER_THINKING_LEVELS)[number]

export interface TierTemplate {
  id: string
  name: string
  description?: string
  tiers: Record<string, ModelTierSpec>
  updatedAt: number
}

export interface TiersStateDoc {
  tiers: Record<string, ModelTierSpec>
  templates: Record<string, TierTemplate>
  activeTemplate?: string
}

export interface TiersPluginConfig {
  autoInjectCatalog: boolean
}

export function createEmptyTiersState(): TiersStateDoc {
  return { tiers: {}, templates: {} }
}
