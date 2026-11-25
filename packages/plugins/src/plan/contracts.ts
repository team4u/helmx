/**
 * builtin:plan shared contracts, constants, JSON schemas, and pure boundary guards.
 */
import {
  isJsonObject,
  type ConversationSummary,
  type JsonSchema,
} from '@helmx/protocol'
import type { PluginClientAssets } from '../asset-paths.js'

export const PLAN_PLUGIN_ID = 'builtin:plan' as const
export const PLAN_SESSION_DOC = 'plan' as const
export const PLAN_BADGES_DOC = 'plan-badges' as const
export const PLAN_PANEL_ID = 'plan' as const
export const PLAN_COMMAND_ID = 'toggle-plan' as const
export const PLAN_COMMAND_SLASH = 'plan' as const
export const PLAN_TOOL_SAVE = 'plan_save' as const
export const PLAN_TOOL_PROPOSE = 'plan_propose' as const

export const PLAN_KV_NAMESPACE = 'plans' as const
export const PLAN_MODE_SECTION_ID = 'plan.mode' as const
export const PLAN_INPUT_META_KEY = PLAN_PLUGIN_ID

export const PLAN_TITLE_MAX_CHARS = 120
export const PLAN_MARKDOWN_MAX_BYTES = 98_304
export const PLAN_SUMMARY_MAX_CHARS = 300
export const PLAN_HANDOFF_MAX_BYTES = 131_072

/** Strict tool whitelist enforced during planning mode (read-only research + plan authoring tools only). */
export const PLAN_MODE_TOOL_WHITELIST: ReadonlySet<string> = new Set([
  'read',
  'read_artifact',
  'bash',
  'load_skill',
  PLAN_TOOL_SAVE,
  PLAN_TOOL_PROPOSE,
])

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

export type PlanToolPresentationMeta =
  | { kind: 'save'; title: string; version: number; lineCount: number; charCount: number }
  | {
      kind: 'propose'
      title: string
      version: number
      outcome: 'approved' | 'approved_handoff' | 'revised' | 'cancelled' | 'superseded' | 'error'
      artifactId?: string
      artifactName?: string
      executionModel?: string
    }

export interface PlanPluginConfig {
  executionModel?: string
}

export interface PlanPluginOptions {
  clientAssets?: PluginClientAssets
}

export interface PlanConversationRecord {
  conversationId: number
  mode: PlanMode
  pendingAskId?: string
  draft?: PlanDraftSummary
  approved?: PlanApprovedInfo
}

export const PLAN_SAVE_META_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['save'] },
    title: { type: 'string', minLength: 1, maxLength: PLAN_TITLE_MAX_CHARS },
    version: { type: 'integer', minimum: 1 },
    lineCount: { type: 'integer', minimum: 0 },
    charCount: { type: 'integer', minimum: 0 },
  },
  required: ['kind', 'title', 'version', 'lineCount', 'charCount'],
  additionalProperties: false,
}

export const PLAN_PROPOSE_META_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['propose'] },
    title: { type: 'string', minLength: 1, maxLength: PLAN_TITLE_MAX_CHARS },
    version: { type: 'integer', minimum: 1 },
    outcome: {
      type: 'string',
      enum: ['approved', 'approved_handoff', 'revised', 'cancelled', 'superseded', 'error'],
    },
    artifactId: { type: 'string', minLength: 1 },
    artifactName: { type: 'string', minLength: 1 },
    executionModel: { type: 'string', minLength: 1 },
  },
  required: ['kind', 'title', 'version', 'outcome'],
  additionalProperties: false,
}

export const PLAN_TOOL_META_SCHEMA: JsonSchema = {
  anyOf: [PLAN_SAVE_META_SCHEMA, PLAN_PROPOSE_META_SCHEMA],
}

const PLAN_DRAFT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    markdown: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
    updatedAt: { type: 'number' },
  },
  required: ['title', 'markdown', 'version', 'updatedAt'],
  additionalProperties: false,
}

const PLAN_APPROVED_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
    artifactId: { type: 'string' },
    artifactName: { type: 'string' },
    approvedAt: { type: 'number' },
    handoffUsed: { type: 'boolean' },
    executionModel: { type: 'string' },
  },
  required: ['title', 'version', 'artifactId', 'artifactName', 'approvedAt', 'handoffUsed'],
  additionalProperties: false,
}

export const PLAN_SESSION_VIEW_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['normal', 'planning'] },
    awaitingApproval: { type: 'boolean' },
    draft: PLAN_DRAFT_SCHEMA,
    approved: PLAN_APPROVED_SCHEMA,
  },
  required: ['mode', 'awaitingApproval'],
  additionalProperties: false,
}

const PLAN_SLASH_RE = /^\/plan(?:\s+([\s\S]*))?$/

/** Plan mode is restricted strictly to top-level human-owned conversations. */
export function isPlanConversationEligible(
  conv: Pick<ConversationSummary, 'parentConversationId' | 'ownedBy'>,
): boolean {
  return conv.parentConversationId === undefined && (conv.ownedBy ?? 'human') === 'human'
}

export function asPlanDeletedConversationId(payload: unknown): number | undefined {
  if (!isJsonObject(payload)) return undefined
  if (payload['type'] !== undefined && payload['type'] !== 'conversation.deleted') return undefined
  const id = payload['conversationId']
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 1 ? id : undefined
}

export function parsePlanSlashInput(
  text: string,
): { matched: false } | { matched: true; remainder: string } {
  const match = PLAN_SLASH_RE.exec(text.trim())
  if (match === null) return { matched: false }
  return { matched: true, remainder: (match[1] ?? '').trim() }
}

/** Check whether `input.meta['builtin:plan']` explicitly requests entering planning mode. */
export function hasPlanModeInputMeta(meta: unknown): boolean {
  if (!isJsonObject(meta)) return false
  if (!Object.hasOwn(meta, PLAN_INPUT_META_KEY)) return false
  const entry = meta[PLAN_INPUT_META_KEY]
  if (!isJsonObject(entry)) return false
  return Object.hasOwn(entry, 'mode') && entry['mode'] === 'planning'
}
