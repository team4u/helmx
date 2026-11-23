/**
 * builtin:triggers shared contracts: dependency ports, public doc shapes, session modes, and boundary validation.
 *
 * Design:
 * - cron and webhook share one delivery helper (`delivery.ts`): automated runs (`mode: 'isolated' | 'dedicated'`)
 *   create `ownedBy: 'helmx'` conversations tagged `[TRIGGER_TAG, triggerSourceTag(kind, id)]` so they stay
 *   completely separated from human conversations while retaining full Conversation timeline/AskDoc/artifact power;
 * - explicit `targetConversationId` delivers with `whenBusy: 'followUp'` to an existing conversation (mutually
 *   exclusive with automated mode fields `mode`/`profileId`/`keepLast`/`dedicatedConversationId`);
 * - The public doc stores metadata only (never the secret); the HMAC secret lands in credentials.json
 *   pluginSecrets['builtin:triggers']['webhook:<id>'] (0600, bound to this plugin's ID via ctx.host.secrets)
 *   and is globally redacted via secrets.addRedaction.
 */
import { HelmxError, isJsonObject } from '@helmx/protocol'
import type {
  ConversationInit,
  ConversationListFilter,
  ConversationSummary,
  HelmxHostApi,
} from '@helmx/protocol'

export const TRIGGERS_PLUGIN_ID = 'builtin:triggers'
export const TRIGGERS_SKILL_ID = 'triggers'

/** Umbrella tag placed on every automated conversation created by builtin:triggers. */
export const TRIGGER_TAG = 'trigger'

/** Default target Profile when automated triggers omit `profileId`. */
export const DEFAULT_TRIGGER_PROFILE_ID = 'assistant'

/** Default and upper bound for retained settled runs in `isolated` mode. */
export const DEFAULT_TRIGGER_KEEP_LAST = 10
export const MAX_TRIGGER_KEEP_LAST = 100

/** Automated session lifecycle mode when `targetConversationId` is omitted. */
export type TriggerSessionMode = 'isolated' | 'dedicated'

export type TriggerKind = 'cron' | 'webhook'

/** Deterministic conversation tag associating automated runs with a specific cron job or webhook endpoint. */
export function triggerSourceTag(kind: TriggerKind, id: string): string {
  return `${kind}:${id}`
}

/** Parse a `cron:<id>` / `webhook:<id>` tag back into `{ kind, id }` (undefined when absent). */
export function parseTriggerSourceTag(tags: readonly string[]): { kind: TriggerKind; id: string } | undefined {
  for (const tag of tags) {
    if (tag.startsWith('cron:')) {
      const id = tag.slice('cron:'.length)
      if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { kind: 'cron', id }
    } else if (tag.startsWith('webhook:')) {
      const id = tag.slice('webhook:'.length)
      if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { kind: 'webhook', id }
    }
  }
  return undefined
}

/** The webhook secret's key name in credentials.json (inside the pluginSecrets namespace). */
export function webhookSecretKey(id: string): string {
  return `webhook:${id}`
}

/** Secret boundary validation: non-empty, length-capped, no control characters (an HMAC shared secret needs none). */
export function assertWebhookSecret(secret: string): string {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new HelmxError('validation_error', 'the webhook secret must not be empty', 400, {})
  }
  if (secret.length > 512) {
    throw new HelmxError('validation_error', `webhook secret too long (<=512 chars, got ${secret.length})`, 400, {})
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(secret)) {
    throw new HelmxError('validation_error', 'the webhook secret must not contain control characters', 400, {})
  }
  return secret
}

/** Trigger id: non-empty, length-capped, url-safe (shared by cron/webhook; allows a-z A-Z 0-9 _ -). */
export function assertTriggerId(kind: TriggerKind, id: string): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new HelmxError(
      'validation_error',
      `invalid ${kind} id (1..64 chars; only alphanumeric _ - allowed; got: ${JSON.stringify(id)})`,
      400,
      { kind, id: String(id) },
    )
  }
  return id
}

/** Description text cap (a doc readability boundary). */
export const MAX_DESCRIPTION = 500

export function assertDescription(description: string): string {
  if (description.length > MAX_DESCRIPTION) {
    throw new HelmxError('validation_error', `description too long (<=${MAX_DESCRIPTION} chars)`, 400, {})
  }
  return description
}

/** Target Profile ID validation (1..64 chars, no whitespace or path separators). */
export function assertTriggerProfileId(profileId: unknown): string {
  if (typeof profileId !== 'string' || profileId.length === 0 || profileId.length > 64 || /\s|[/\\]/.test(profileId)) {
    throw new HelmxError('validation_error', `invalid profileId (1..64 non-whitespace chars, got: ${String(profileId)})`, 400, {
      field: 'profileId',
    })
  }
  return profileId
}

/** Trigger automated session mode validation ('isolated' | 'dedicated'). */
export function assertTriggerMode(mode: unknown): TriggerSessionMode {
  if (mode !== 'isolated' && mode !== 'dedicated') {
    throw new HelmxError('validation_error', `mode must be 'isolated' or 'dedicated' (got: ${String(mode)})`, 400, {
      field: 'mode',
    })
  }
  return mode
}

/** Isolated retention cap validation (integer 1..MAX_TRIGGER_KEEP_LAST). */
export function assertTriggerKeepLast(keepLast: unknown): number {
  if (typeof keepLast !== 'number' || !Number.isInteger(keepLast) || keepLast < 1 || keepLast > MAX_TRIGGER_KEEP_LAST) {
    throw new HelmxError(
      'validation_error',
      `keepLast must be an integer between 1 and ${MAX_TRIGGER_KEEP_LAST} (got: ${String(keepLast)})`,
      400,
      { field: 'keepLast' },
    )
  }
  return keepLast
}

export interface NormalizedTriggerTarget {
  targetConversationId?: number
  mode?: TriggerSessionMode
  profileId?: string
  keepLast?: number
}

/**
 * Shared boundary validation for trigger target/mode inputs (used by both `cron_create` and `webhook_create`):
 * - `targetConversationId` is mutually exclusive with automated-session options (`mode`, `profileId`, `keepLast`);
 * - When `targetConversationId` is omitted, defaults to `mode: 'isolated'` and `keepLast: DEFAULT_TRIGGER_KEEP_LAST`;
 * - `keepLast` is rejected when `mode === 'dedicated'`.
 */
export function normalizeTriggerTargetInput(input: {
  targetConversationId?: number
  mode?: TriggerSessionMode
  profileId?: string
  keepLast?: number
}): NormalizedTriggerTarget {
  const hasConv = input.targetConversationId !== undefined
  const hasAutomatedOption =
    input.mode !== undefined || input.profileId !== undefined || input.keepLast !== undefined
  if (hasConv && hasAutomatedOption) {
    throw new HelmxError(
      'validation_error',
      'targetConversationId is mutually exclusive with mode, profileId, and keepLast',
      400,
      { field: 'targetConversationId' },
    )
  }
  if (hasConv) {
    if (!Number.isInteger(input.targetConversationId) || (input.targetConversationId as number) <= 0) {
      throw new HelmxError(
        'validation_error',
        `targetConversationId must be a positive integer conversation ID (got: ${String(input.targetConversationId)})`,
        400,
        { field: 'targetConversationId' },
      )
    }
    return { targetConversationId: input.targetConversationId }
  }
  const mode = input.mode === undefined ? 'isolated' : assertTriggerMode(input.mode)
  const profileId = input.profileId === undefined ? undefined : assertTriggerProfileId(input.profileId)
  if (mode === 'dedicated') {
    if (input.keepLast !== undefined) {
      throw new HelmxError(
        'validation_error',
        'keepLast is only valid when mode is "isolated"',
        400,
        { field: 'keepLast' },
      )
    }
    return {
      mode,
      ...(profileId !== undefined ? { profileId } : {}),
    }
  }
  const keepLast = input.keepLast === undefined ? DEFAULT_TRIGGER_KEEP_LAST : assertTriggerKeepLast(input.keepLast)
  return {
    mode,
    ...(profileId !== undefined ? { profileId } : {}),
    keepLast,
  }
}

/** Target-Profile existence port (the minimal face of ctx.host.profiles). */
export interface ProfileLookup {
  get(id: string): Promise<{ id: string } | undefined>
}

// ---------------------------------------------------------------------------
// Webhook public doc shape and boundary validation (no secret, metadata only)
// ---------------------------------------------------------------------------

export interface WebhookMeta {
  id: string
  /** Collaboration contract: a boolean expressing that the secret is configured (true); never the secret itself. */
  hasSecret: boolean
  description?: string
  /** Explicit existing conversation target (mutually exclusive with mode/profileId/keepLast/dedicatedConversationId). */
  targetConversationId?: number
  /** Automated session mode when targetConversationId is omitted ('isolated' | 'dedicated'). */
  mode?: TriggerSessionMode
  /** Target Profile ID for automated sessions (defaults to 'assistant'). */
  profileId?: string
  /** Retention cap of settled isolated runs (only when mode === 'isolated'). */
  keepLast?: number
  /** Persisted dedicated conversation ID (only when mode === 'dedicated'). */
  dedicatedConversationId?: number
  createdAt: number
}

export interface WebhooksDoc {
  webhooks: WebhookMeta[]
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

function isFiniteTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

const docCorrupt = (detail: string): HelmxError =>
  new HelmxError('triggers_doc_corrupt', `plugin doc webhooks ${detail}`, 500, { pluginId: TRIGGERS_PLUGIN_ID })

function assertWebhookMeta(raw: unknown): void {
  if (!isJsonObject(raw)) throw docCorrupt('contains a non-object entry')
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.id)) {
    throw docCorrupt(`invalid entry id: ${JSON.stringify(raw.id)}`)
  }
  if (raw.hasSecret !== true) {
    throw docCorrupt(`entry ${raw.id} is missing hasSecret: true (the doc expresses secret-configured as a boolean; old dev docs are incompatible, no migration)`)
  }
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > MAX_DESCRIPTION)) {
    throw docCorrupt(`entry ${raw.id} description is not a string or exceeds ${MAX_DESCRIPTION} chars`)
  }
  if ('targetProfileId' in raw) {
    throw docCorrupt(`entry ${raw.id} uses removed targetProfileId field (use mode + profileId; old dev docs are incompatible, no migration)`)
  }
  const hasConv = raw.targetConversationId !== undefined
  if (hasConv && !isPosInt(raw.targetConversationId)) {
    throw docCorrupt(`entry ${raw.id} targetConversationId is not a positive integer`)
  }
  if (raw.mode !== undefined && raw.mode !== 'isolated' && raw.mode !== 'dedicated') {
    throw docCorrupt(`entry ${raw.id} mode must be 'isolated' or 'dedicated'`)
  }
  if (raw.profileId !== undefined && (typeof raw.profileId !== 'string' || raw.profileId.length === 0 || raw.profileId.length > 64 || /\s|[/\\]/.test(raw.profileId))) {
    throw docCorrupt(`entry ${raw.id} profileId is invalid (1..64 non-whitespace chars)`)
  }
  if (raw.keepLast !== undefined && (!isPosInt(raw.keepLast) || raw.keepLast > MAX_TRIGGER_KEEP_LAST)) {
    throw docCorrupt(`entry ${raw.id} keepLast must be an integer 1..${MAX_TRIGGER_KEEP_LAST}`)
  }
  if (raw.dedicatedConversationId !== undefined && !isPosInt(raw.dedicatedConversationId)) {
    throw docCorrupt(`entry ${raw.id} dedicatedConversationId is not a positive integer`)
  }
  if (hasConv) {
    if (
      raw.mode !== undefined ||
      raw.profileId !== undefined ||
      raw.keepLast !== undefined ||
      raw.dedicatedConversationId !== undefined
    ) {
      throw docCorrupt(`entry ${raw.id} targetConversationId is mutually exclusive with mode/profileId/keepLast/dedicatedConversationId`)
    }
  } else {
    if (raw.mode !== 'isolated' && raw.mode !== 'dedicated') {
      throw docCorrupt(`entry ${raw.id} must declare mode ('isolated' | 'dedicated') when targetConversationId is unset`)
    }
    if (raw.mode === 'isolated' && raw.dedicatedConversationId !== undefined) {
      throw docCorrupt(`entry ${raw.id} dedicatedConversationId is forbidden in isolated mode`)
    }
    if (raw.mode === 'dedicated' && raw.keepLast !== undefined) {
      throw docCorrupt(`entry ${raw.id} keepLast is forbidden in dedicated mode`)
    }
  }
  if (!isFiniteTime(raw.createdAt)) throw docCorrupt(`entry ${raw.id} createdAt is invalid`)
  if ('secret' in raw) {
    throw docCorrupt(`entry ${raw.id} contains a secret field (the doc stores metadata only; secrets live in credentials.json)`)
  }
}

/** webhooks doc read-in boundary validation: corruption errors explicitly; never silently rebuilds. */
export function assertWebhooksDoc(value: unknown): WebhooksDoc {
  if (!isJsonObject(value) || !Array.isArray(value.webhooks)) {
    throw docCorrupt('invalid structure (expected { webhooks: [] })')
  }
  const seen = new Set<string>()
  for (const item of value.webhooks) {
    assertWebhookMeta(item)
    const id = (item as WebhookMeta).id
    if (seen.has(id)) throw docCorrupt(`duplicate entry id '${id}'`)
    seen.add(id)
  }
  return value as unknown as WebhooksDoc
}

/** Metadata redaction view: action/doc outputs strip through this uniformly. */
export function webhookPublicMeta(meta: WebhookMeta): WebhookMeta {
  const {
    id,
    hasSecret,
    description,
    targetConversationId,
    mode,
    profileId,
    keepLast,
    dedicatedConversationId,
    createdAt,
  } = meta
  return {
    id,
    hasSecret,
    ...(description !== undefined ? { description } : {}),
    ...(targetConversationId !== undefined ? { targetConversationId } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(profileId !== undefined ? { profileId } : {}),
    ...(keepLast !== undefined ? { keepLast } : {}),
    ...(dedicatedConversationId !== undefined ? { dedicatedConversationId } : {}),
    createdAt,
  }
}

/** Conversation query/mutation port (the minimal face of ctx.host consumed by delivery/retention). */
export interface ConversationLookup {
  listConversations(filter?: ConversationListFilter): ConversationSummary[]
  getConversation(id: number): ConversationSummary
  createConversation(init: ConversationInit): Promise<ConversationSummary>
  deleteConversationGuarded?: HelmxHostApi['deleteConversationGuarded']
  markConversationOwnership?: HelmxHostApi['markConversationOwnership']
}
