/**
 * builtin:tiers shared contracts (pure data shapes & constants, browser-safe).
 */
import {
  isJsonObject,
  type ConversationScope,
  type ConversationSummary,
  type JsonSchema,
  type ModelTierSpec,
} from '@helmx/protocol'
import { isTopLevelHumanConversation } from '../shared-helpers.js'

export const TIERS_PLUGIN_ID = 'builtin:tiers' as const
export const TIERS_STATE_DOC = 'state' as const
export const TIERS_SCREEN_ID = 'main' as const
export const MODEL_TIERS_SKILL_ID = 'model-tiers' as const

export const TIERS_BORROW_KV = 'borrows' as const
export const TIERS_BORROW_SESSION_DOC = 'borrow' as const
export const TIERS_SWITCH_MODEL_TOOL = 'switch_model' as const
export const TIERS_INPUT_META_KEY = TIERS_PLUGIN_ID
export const TIERS_BORROW_ELIGIBLE_SCOPE = {
  topLevelOnly: true,
  ownedBy: 'human',
} as const satisfies ConversationScope

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

export type TierBorrowPhase = 'armed' | 'active'
export type TierBorrowSource = 'ui' | 'tool' | 'meta'

/** Durable per-conversation borrow record persisted in `ctx.kv('borrows')`. */
export interface TierBorrowRecord {
  conversationId: number
  phase: TierBorrowPhase
  /** Raw target reference requested by user/tool (e.g. 'tier/architect', 'architect', 'faux/flagship', 'flagship'). */
  requestedRef: string
  /** Canonical reference passed to kernel updateConversation ('tier/<id>' or 'provider/modelId'). */
  targetModel: string
  /** Concrete 'provider/modelId' applied onto conversation.modelOverride when active (CAS restore snapshot). */
  appliedModelOverride?: string
  /** Resolved concrete 'provider/modelId'. */
  targetConcreteModel: string
  /** Compact display label ('tier/<id>' for tiers, short model name for concrete models). */
  targetLabel: string
  /** Present when the borrow targeted a semantic tier. */
  targetTierId?: string
  /** Optional explicit effort requested for this borrow. */
  appliedEffort?: TierThinkingLevel
  /** Thinking level override applied by kernel when active (CAS restore snapshot). */
  appliedThinkingLevelOverride?: string
  /** Original conversation modelOverride before borrow activation (undefined = inherited Profile/global default). */
  previousModelOverride?: string
  /** Original conversation thinkingLevelOverride before borrow activation (undefined = inherited default). */
  previousThinkingLevelOverride?: string
  /** Whether borrow activation modified conversation.thinkingLevelOverride relative to baseline. */
  effortChanged: boolean
  /** Whether to auto-restore the baseline model after the turn settles. */
  restoreAfterTurn: boolean
  source: TierBorrowSource
  createdAt: number
  updatedAt: number
}

/** Public session-scoped borrow view projected to `ctx.sessionDoc('borrow', null, { public: true, durable: false })`. */
export interface TierBorrowSessionView {
  phase: TierBorrowPhase
  requestedRef: string
  targetModel: string
  targetConcreteModel: string
  targetLabel: string
  targetTierId?: string
  effort?: TierThinkingLevel
  restoreAfterTurn: boolean
  previousModelOverride?: string
  updatedAt: number
}

export const TIER_BORROW_SESSION_VIEW_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    phase: { type: 'string', enum: ['armed', 'active'] },
    requestedRef: { type: 'string', minLength: 1 },
    targetModel: { type: 'string', minLength: 1 },
    targetConcreteModel: { type: 'string', minLength: 1 },
    targetLabel: { type: 'string', minLength: 1 },
    targetTierId: { type: 'string', minLength: 1 },
    effort: { type: 'string', enum: [...TIER_THINKING_LEVELS] },
    restoreAfterTurn: { type: 'boolean' },
    previousModelOverride: { type: 'string' },
    updatedAt: { type: 'number' },
  },
  required: [
    'phase',
    'requestedRef',
    'targetModel',
    'targetConcreteModel',
    'targetLabel',
    'restoreAfterTurn',
    'updatedAt',
  ],
  additionalProperties: false,
}

/** Bounded UI presentation metadata persisted on `switch_model` tool results. */
export type SwitchModelPresentationMeta = {
  fromModel: string
  toModel: string
  toLabel: string
  tierId?: string
  effort?: TierThinkingLevel
  restoreAfterTurn: boolean
  changed: boolean
}

export const SWITCH_MODEL_META_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    fromModel: { type: 'string' },
    toModel: { type: 'string', minLength: 1 },
    toLabel: { type: 'string', minLength: 1 },
    tierId: { type: 'string', minLength: 1 },
    effort: { type: 'string', enum: [...TIER_THINKING_LEVELS] },
    restoreAfterTurn: { type: 'boolean' },
    changed: { type: 'boolean' },
  },
  required: ['fromModel', 'toModel', 'toLabel', 'restoreAfterTurn', 'changed'],
  additionalProperties: false,
}

export type ParsedTiersBorrowInputMeta =
  | { present: false }
  | { present: true; valid: true; borrowModel: string; effort?: string }
  | { present: true; valid: false; reason: string }

/** One-turn model borrow & `switch_model` are restricted to top-level human-owned conversations. */
export function isTiersBorrowEligible(
  conv: Pick<ConversationSummary, 'parentConversationId' | 'ownedBy'>,
): boolean {
  return isTopLevelHumanConversation(conv)
}

/** Parse optional `input.meta['builtin:tiers']` standby borrow metadata with strict validation. */
export function parseTiersBorrowInputMeta(meta: unknown): ParsedTiersBorrowInputMeta {
  if (!isJsonObject(meta) || !Object.hasOwn(meta, TIERS_INPUT_META_KEY)) {
    return { present: false }
  }
  const entry = meta[TIERS_INPUT_META_KEY]
  if (entry === undefined) return { present: false }
  if (!isJsonObject(entry)) {
    return { present: true, valid: false, reason: 'Invalid builtin:tiers input metadata: expected an object' }
  }
  const rawModel = entry['borrowModel']
  if (typeof rawModel !== 'string' || rawModel.trim() === '') {
    return {
      present: true,
      valid: false,
      reason: 'Invalid builtin:tiers input metadata: borrowModel must be a non-empty string',
    }
  }
  const rawEffort = entry['effort']
  if (rawEffort !== undefined && typeof rawEffort !== 'string') {
    return {
      present: true,
      valid: false,
      reason: 'Invalid builtin:tiers input metadata: effort must be a string',
    }
  }
  const trimmedEffort = typeof rawEffort === 'string' && rawEffort.trim() !== '' ? rawEffort.trim() : undefined
  return {
    present: true,
    valid: true,
    borrowModel: rawModel.trim(),
    ...(trimmedEffort !== undefined ? { effort: trimmedEffort } : {}),
  }
}

export function createEmptyTiersState(): TiersStateDoc {
  return { tiers: {}, templates: {} }
}
