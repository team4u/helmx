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
export const PLAN_TOOL_ASK = 'plan_ask' as const
export const PLAN_TOOL_BASH = 'plan_bash' as const

export const PLAN_KV_NAMESPACE = 'plans' as const
export const PLAN_MODE_SECTION_ID = 'plan.mode' as const
export const PLAN_INPUT_META_KEY = PLAN_PLUGIN_ID

export const PLAN_TITLE_MAX_CHARS = 120
export const PLAN_MARKDOWN_MAX_BYTES = 98_304
export const PLAN_SUMMARY_MAX_CHARS = 300
export const PLAN_HANDOFF_MAX_BYTES = 131_072
export const PLAN_ASK_MAX_QUESTIONS = 4
export const PLAN_ASK_MIN_OPTIONS = 2
export const PLAN_ASK_MAX_OPTIONS = 6
export const PLAN_ASK_QUESTION_MAX_CHARS = 300
export const PLAN_ASK_OPTION_LABEL_MAX_CHARS = 120
export const PLAN_ASK_OPTION_DESC_MAX_CHARS = 200
export const PLAN_BASH_DEFAULT_TIMEOUT_MS = 60_000
export const PLAN_BASH_MAX_TIMEOUT_MS = 120_000

/** Strict tool whitelist enforced during planning mode (read-only research + plan authoring & clarification tools only). */
export const PLAN_MODE_TOOL_WHITELIST: ReadonlySet<string> = new Set([
  'read',
  'read_artifact',
  'load_skill',
  PLAN_TOOL_BASH,
  PLAN_TOOL_ASK,
  PLAN_TOOL_SAVE,
  PLAN_TOOL_PROPOSE,
])

export type PlanMode = 'normal' | 'planning'
export type PlanAskKind = 'propose' | 'clarify'

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
  | {
      kind: 'ask'
      title: string
      questionCount: number
      outcome: 'answered' | 'cancelled' | 'superseded' | 'error'
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
  pendingAskKind?: PlanAskKind
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

export const PLAN_ASK_META_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['ask'] },
    title: { type: 'string', minLength: 1, maxLength: PLAN_TITLE_MAX_CHARS },
    questionCount: { type: 'integer', minimum: 1, maximum: PLAN_ASK_MAX_QUESTIONS },
    outcome: {
      type: 'string',
      enum: ['answered', 'cancelled', 'superseded', 'error'],
    },
  },
  required: ['kind', 'title', 'questionCount', 'outcome'],
  additionalProperties: false,
}

export const PLAN_TOOL_META_SCHEMA: JsonSchema = {
  anyOf: [PLAN_SAVE_META_SCHEMA, PLAN_PROPOSE_META_SCHEMA, PLAN_ASK_META_SCHEMA],
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
    awaitingClarification: { type: 'boolean' },
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

/** Extract `{ conversationId, kind }` from a `conversation.entry` host event payload. */
export function asConversationEntryEvent(
  payload: unknown,
): { conversationId: number; kind: string } | undefined {
  if (!isJsonObject(payload)) return undefined
  if (payload['type'] !== undefined && payload['type'] !== 'conversation.entry') return undefined
  const conversationId = payload['conversationId']
  if (typeof conversationId !== 'number' || !Number.isSafeInteger(conversationId) || conversationId < 1) {
    return undefined
  }
  const entry = payload['entry']
  if (!isJsonObject(entry) || typeof entry['kind'] !== 'string' || entry['kind'] === '') {
    return undefined
  }
  return { conversationId, kind: entry['kind'] }
}

/** Check whether `input.meta['builtin:plan']` explicitly requests entering planning mode. */
export function hasPlanModeInputMeta(meta: unknown): boolean {
  if (!isJsonObject(meta)) return false
  if (!Object.hasOwn(meta, PLAN_INPUT_META_KEY)) return false
  const entry = meta[PLAN_INPUT_META_KEY]
  if (!isJsonObject(entry)) return false
  return Object.hasOwn(entry, 'mode') && entry['mode'] === 'planning'
}

/** Validate, redact, and enforce size bounds on plan draft `title` and `markdown`. */
export function validateAndRedactPlanDraft(
  rawTitle: unknown,
  rawMarkdown: unknown,
  redact: (text: string) => string,
): { ok: true; title: string; markdown: string } | { ok: false; message: string } {
  const trimmedTitle = typeof rawTitle === 'string' ? rawTitle.trim() : ''
  if (trimmedTitle.length === 0 || trimmedTitle.length > PLAN_TITLE_MAX_CHARS) {
    return {
      ok: false,
      message: `Plan title must be a non-empty string within ${PLAN_TITLE_MAX_CHARS} characters.`,
    }
  }
  const rawMd = typeof rawMarkdown === 'string' ? rawMarkdown : ''
  if (rawMd.trim().length === 0) {
    return { ok: false, message: 'Plan markdown must be a non-empty string.' }
  }
  if (Buffer.byteLength(rawMd, 'utf8') > PLAN_MARKDOWN_MAX_BYTES) {
    return {
      ok: false,
      message: `Plan markdown exceeds maximum size of ${PLAN_MARKDOWN_MAX_BYTES} UTF-8 bytes.`,
    }
  }
  const title = redact(trimmedTitle).trim()
  if (title.length === 0 || title.length > PLAN_TITLE_MAX_CHARS) {
    return {
      ok: false,
      message: `Plan title after redaction must be 1-${PLAN_TITLE_MAX_CHARS} characters.`,
    }
  }
  const markdown = redact(rawMd)
  if (markdown.trim().length === 0) {
    return { ok: false, message: 'Plan markdown cannot be empty after redaction.' }
  }
  if (Buffer.byteLength(markdown, 'utf8') > PLAN_MARKDOWN_MAX_BYTES) {
    return {
      ok: false,
      message: `Plan markdown exceeds maximum size of ${PLAN_MARKDOWN_MAX_BYTES} UTF-8 bytes.`,
    }
  }
  return { ok: true, title, markdown }
}
