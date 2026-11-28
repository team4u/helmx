/**
 * Boundary field validation: mechanical type/shape/unknown-field rules consume the shared
 * TypeBox schemas in `@helmx/protocol` (`REQUEST_SCHEMAS`) compiled via `validateOrThrow`;
 * complex cross-field semantics, UTF-16 code-unit caps, trim rules, and path absoluteness remain
 * hand-written. Invalid input always fails with 400 validation_error.
 *
 * Never use `as` assertions as validation—type narrowing happens only after schema validation.
 */
import { type Static, type TSchema } from 'typebox'
import {
  assertJsonSafe,
  HelmxError,
  isAbsoluteTargetPath,
  REQUEST_SCHEMAS,
  REQUEST_SCHEMA_PATTERNS,
  validateOrThrow,
  type ConversationInit,
  type ConversationPatch,
  type InputOrigin,
  type JsonSchema,
  type Profile,
  type ProviderConfig,
  type WhenBusy,
  type WhenPendingAsk,
} from '@helmx/protocol'
import { validateProfileStarters } from '../services/profile-service.js'

export class ValidationError extends HelmxError {
  constructor(message: string, details?: unknown) {
    super('validation_error', message, 400, details)
  }
}

/**
 * JSON Schema body validation: reuses @helmx/protocol's AJV/TypeBox wrapper (compiled schema cache,
 * $async rejection, field-path diagnostics) and translates failures into HTTP-boundary
 * ValidationError (same 400 validation_error contract; message includes instancePath, details
 * carries the error list). Rejects non-plain class instances (e.g. Date/Map).
 */
export function assertBodySchema(schema: JsonSchema | TSchema, value: unknown, what: string): void {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new ValidationError(`${what} must be a plain JSON object`)
    }
  }
  try {
    validateOrThrow(schema as unknown as JsonSchema, value, what)
  } catch (error) {
    if (error instanceof HelmxError && error.code === 'validation_error') {
      const ajvErrors = (
        error.details as { errors?: Array<{ keyword?: string; params?: { additionalProperty?: unknown } }> } | undefined
      )?.errors
      const extras = ajvErrors
        ?.filter((e) => e.keyword === 'additionalProperties' && typeof e.params?.additionalProperty === 'string')
        .map((e) => String(e.params!.additionalProperty))
      const suffix = extras && extras.length > 0 ? ` (unsupported field(s): ${[...new Set(extras)].join(', ')})` : ''
      throw new ValidationError(`${error.message}${suffix}`, error.details)
    }
    throw error
  }
}

/** Validates `value` against a TypeBox schema via `assertBodySchema` and returns the narrowed type. */
function parseBodyWithSchema<T extends TSchema>(schema: T, value: unknown, what: string): Static<T> {
  assertBodySchema(schema as unknown as JsonSchema, value, what)
  return value as Static<T>
}

/** JSON Schema measures length in code points; these fields are capped in UTF-16 code units and must be checked separately. */
export function requireUtf16LengthAtMost(field: string, value: string, maxLength: number): void {
  if (value.length > maxLength) {
    throw new ValidationError(`${field} length must be <= ${maxLength}`)
  }
}

/** Numeric ID in route path params: non-numeric values fail immediately with 400 before reaching services. */
export function parseIdParam(raw: string, field = 'id'): number {
  if (!/^\d+$/.test(raw)) {
    throw new ValidationError(`${field} must be a positive integer`)
  }
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new ValidationError(`${field} must be a positive integer`)
  }
  return n
}

/** Identifier param (askId / pluginId / actionId / runId / profileId / artifactId). */
export function requireIdParam(raw: string, field: string): string {
  if (!REQUEST_SCHEMA_PATTERNS.id.test(raw)) {
    throw new ValidationError(`${field} must be a valid identifier (must start with an alphanumeric character and may contain . _ : -)`)
  }
  return raw
}

/** Validate http(s) URL: restricted scheme, parseable, non-empty hostname. */
export function requireHttpUrl(raw: unknown, field: string): string {
  if (typeof raw !== 'string') throw new ValidationError(`${field} must be an http(s) URL string`)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new ValidationError(`${field} must be a valid http(s) URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`${field} must be an http(s) URL`)
  }
  if (parsed.hostname === '' || /^\s+$/.test(parsed.hostname)) {
    throw new ValidationError(`${field} must contain a hostname`)
  }
  return raw
}

/** Validate bounded POSIX-style relative path without traversal segments. */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false
  if (path.startsWith('/') || path.includes('\\')) return false
  return path.split('/').every((p) => p.length > 0 && p !== '.' && p !== '..')
}

// ---------------------------------------------------------------------------
// Conversation bodies (init / patch / input / ask / reset / compact / fork / withdraw)
// ---------------------------------------------------------------------------

function extractConversationCommon(
  parsed: Static<typeof REQUEST_SCHEMAS.conversationInit> | Static<typeof REQUEST_SCHEMAS.conversationPatch>,
): ConversationInit {
  if (parsed.title !== undefined) requireUtf16LengthAtMost('title', parsed.title, 200)
  if (parsed.tags !== undefined && parsed.tags.some((t) => t.length > 64)) {
    throw new ValidationError('each tags item must be 1-64 characters')
  }
  if (parsed.cwd !== undefined && !isAbsoluteTargetPath(parsed.cwd)) {
    throw new ValidationError('cwd must be an absolute path (POSIX /..., Windows drive C:\\..., or UNC \\\\server\\share)')
  }
  return {
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
    ...(parsed.profileId !== undefined ? { profileId: parsed.profileId } : {}),
    ...(parsed.tags !== undefined ? { tags: [...parsed.tags] } : {}),
    ...(parsed.nodeId !== undefined ? { nodeId: parsed.nodeId } : {}),
    ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
  }
}

export function parseConversationInit(body: Record<string, unknown>): ConversationInit {
  const parsed = parseBodyWithSchema(REQUEST_SCHEMAS.conversationInit, body, 'conversation init body')
  const init = extractConversationCommon(parsed)
  if (parsed.parentConversationId !== undefined) init.parentConversationId = parsed.parentConversationId
  if (parsed.model !== undefined) init.model = parsed.model
  return init
}

export function parseConversationPatch(body: Record<string, unknown>): ConversationPatch {
  const parsed = parseBodyWithSchema(REQUEST_SCHEMAS.conversationPatch, body, 'conversation patch body')
  const patch: ConversationPatch = extractConversationCommon(parsed)
  if (parsed.model !== undefined) {
    // PATCH-only semantics: '' = clear explicit override (recompute Profile/global inheritance chain);
    // create (parseConversationInit) still requires provider/model and rejects empty strings.
    if (parsed.model !== '' && !REQUEST_SCHEMA_PATTERNS.modelRef.test(parsed.model)) {
      throw new ValidationError('model must be in provider/model format or an empty string (empty string clears override)')
    }
    patch.model = parsed.model
  }
  if (parsed.thinkingLevel !== undefined) patch.thinkingLevel = parsed.thinkingLevel
  if (parsed.unread !== undefined) patch.unread = parsed.unread
  if (parsed.pinned !== undefined) patch.pinned = parsed.pinned
  if (Object.keys(patch).length === 0) {
    throw new ValidationError('PATCH body must contain at least one updatable field')
  }
  return patch
}

export function parseInputBody(body: Record<string, unknown>): {
  text: string
  whenBusy?: WhenBusy
  whenPendingAsk?: WhenPendingAsk
  origin?: InputOrigin
  meta?: Record<string, unknown>
  attachments?: string[]
  replaceFromEntryId?: number
  model?: string
  thinkingLevel?: string
} {
  // Mechanical shape (text type, enums, attachment ID pattern, unknown fields) uses schema;
  // UTF-16 length cap on text, recursive strict plain-JSON check on meta, and attachment dedupe/empty-array
  // semantics are original business rules kept hand-written.
  const parsed = parseBodyWithSchema(REQUEST_SCHEMAS.conversationInput, body, 'input body')
  requireUtf16LengthAtMost('text', parsed.text, 512 * 1024)
  const meta = parseMetaObject(parsed.meta)
  const attachments = parseAttachmentIds(parsed.attachments)
  return {
    text: parsed.text,
    ...(parsed.whenBusy !== undefined ? { whenBusy: parsed.whenBusy } : {}),
    ...(parsed.whenPendingAsk !== undefined ? { whenPendingAsk: parsed.whenPendingAsk } : {}),
    ...(parsed.origin !== undefined ? { origin: parsed.origin } : {}),
    ...(meta !== undefined ? { meta } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(parsed.replaceFromEntryId !== undefined ? { replaceFromEntryId: parsed.replaceFromEntryId } : {}),
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    ...(parsed.thinkingLevel !== undefined ? { thinkingLevel: parsed.thinkingLevel } : {}),
  }
}

/** Attachment ID list: ID pattern per item is enforced by schema; this only deduplicates and treats [] as omitted. */
function parseAttachmentIds(raw: string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const ids = [...new Set(raw)]
  return ids.length > 0 ? ids : undefined
}

/** Plain JSON object validation via `@helmx/protocol`'s `assertJsonSafe`; returns an isolated deep clone. */
function parseMetaObject(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined
  try {
    return assertJsonSafe(raw, {
      path: 'meta',
      requirePlainObject: true,
      code: 'validation_error',
      status: 400,
    })
  } catch (error) {
    if (error instanceof HelmxError) {
      throw new ValidationError(error.message, error.details)
    }
    throw error
  }
}

export function parseAskAnswerBody(body: Record<string, unknown>): {
  answers: Record<string, string | string[]>
  expectedStateSeq?: number
} {
  const parsed = parseBodyWithSchema(REQUEST_SCHEMAS.askAnswer, body, 'ask answer body')
  const cloned: Record<string, string | string[]> = {}
  for (const [key, val] of Object.entries(parsed.answers as Record<string, string | string[]>)) {
    cloned[key] = Array.isArray(val) ? [...val] : val
  }
  return {
    answers: cloned,
    ...(parsed.expectedStateSeq !== undefined ? { expectedStateSeq: parsed.expectedStateSeq } : {}),
  }
}

/** POST /api/conversations/:id/reset: optional handoff text. */
export function parseConversationResetBody(body: Record<string, unknown>): { handoff?: string } {
  const parsed = parseBodyWithSchema(REQUEST_SCHEMAS.conversationReset, body, 'reset body')
  if (parsed.handoff !== undefined) requireUtf16LengthAtMost('handoff', parsed.handoff, 512 * 1024)
  return parsed.handoff !== undefined ? { handoff: parsed.handoff } : {}
}

/** POST /api/conversations/:id/compact: optional instructions text. */
export function parseConversationCompactBody(body: Record<string, unknown>): { instructions?: string } {
  const parsed = parseBodyWithSchema(REQUEST_SCHEMAS.conversationCompact, body, 'compact body')
  if (parsed.instructions !== undefined) requireUtf16LengthAtMost('instructions', parsed.instructions, 512 * 1024)
  return parsed.instructions !== undefined ? { instructions: parsed.instructions } : {}
}

/** POST /api/conversations/:id/fork: entryId is an optional safe positive integer; title is optional 1..200 UTF-16 code units. */
export function parseConversationForkBody(body: Record<string, unknown>): { entryId?: number; title?: string } {
  const parsed = parseBodyWithSchema(REQUEST_SCHEMAS.conversationFork, body, 'fork body')
  if (parsed.title !== undefined) requireUtf16LengthAtMost('title', parsed.title, 200)
  return {
    ...(parsed.entryId !== undefined ? { entryId: parsed.entryId } : {}),
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
  }
}

/** POST /api/conversations/:id/withdraw: submissionId is a required safe positive integer. */
export function parseConversationWithdrawBody(body: Record<string, unknown>): { submissionId: number } {
  const parsed = parseBodyWithSchema(REQUEST_SCHEMAS.conversationWithdraw, body, 'withdraw body')
  return { submissionId: parsed.submissionId }
}

/**
 * POST /api/conversations/bulk-delete: ids is a non-empty array (1..1000) of safe positive integers.
 * Order-preserving dedup happens in the service (first-seen wins), not here — validation stays mechanical.
 */
export function parseConversationBulkDeleteBody(body: Record<string, unknown>): { ids: number[] } {
  const parsed = parseBodyWithSchema(REQUEST_SCHEMAS.conversationBulkDelete, body, 'bulk-delete body')
  return { ids: parsed.ids }
}

// ---------------------------------------------------------------------------
// Profile body (TypeBox mechanical shape + cross-field / trim / code-point semantics)
// ---------------------------------------------------------------------------

const throwValidationError = (message: string): never => {
  throw new ValidationError(message)
}

export function parseProfileBody(body: Record<string, unknown>, opts: { requireId: boolean }): Profile {
  const parsed = opts.requireId
    ? parseBodyWithSchema(REQUEST_SCHEMAS.profileCreate, body, 'profile body')
    : parseBodyWithSchema(REQUEST_SCHEMAS.profileUpdate, body, 'profile body')

  if (parsed.managedByPlugin !== undefined && parsed.managedByPlugin.trim() === '') {
    throw new ValidationError('managedByPlugin must be a non-empty plugin ID')
  }
  if (parsed.system !== undefined) {
    requireUtf16LengthAtMost('system', parsed.system, 512 * 1024)
  }
  if (parsed.model !== undefined && parsed.model !== '' && !REQUEST_SCHEMA_PATTERNS.modelRef.test(parsed.model)) {
    throw new ValidationError('model must be in provider/model format or an empty string')
  }
  if (parsed.tags !== undefined && parsed.tags.some((t) => t.length > 64)) {
    throw new ValidationError('each tags item must be 1-64 characters')
  }

  const starters = parsed.starters !== undefined
    ? validateProfileStarters(parsed.starters, { fail: throwValidationError })
    : undefined

  const profile: Profile = { ...(parsed.id !== undefined ? { id: parsed.id } : {}) } as Profile
  if (parsed.name !== undefined) profile.name = parsed.name
  if (parsed.model !== undefined && parsed.model !== '') profile.model = parsed.model
  if (parsed.thinkingLevel !== undefined && parsed.thinkingLevel !== '') profile.thinkingLevel = parsed.thinkingLevel
  if (parsed.nodeId !== undefined) profile.nodeId = parsed.nodeId
  if (parsed.cwd !== undefined) profile.cwd = parsed.cwd
  if (parsed.tags !== undefined) profile.tags = [...parsed.tags]
  if (parsed.skills !== undefined) profile.skills = [...new Set(parsed.skills)]
  if (parsed.managedByPlugin !== undefined) profile.managedByPlugin = parsed.managedByPlugin
  if (parsed.restrictToCwd !== undefined) profile.restrictToCwd = parsed.restrictToCwd
  if (starters !== undefined) profile.starters = starters
  if (parsed.system !== undefined) profile.system = parsed.system
  return profile
}

// ---------------------------------------------------------------------------
// providers / credentials / actions / plugin config bodies
// ---------------------------------------------------------------------------

/** providers PUT body: `{ providers: ProviderConfig[] }`. */
export function parseProvidersBody(body: Record<string, unknown>): ProviderConfig[] {
  const parsed = parseBodyWithSchema(REQUEST_SCHEMAS.providersPut, body, 'providers body')
  return parsed.providers.map((p) => ({
    id: p.id,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    models: [...p.models],
    ...(p.label !== undefined ? { label: p.label } : {}),
    enabled: p.enabled,
  }))
}

export function parseCredentialBody(body: Record<string, unknown>): string {
  const parsed = parseBodyWithSchema(REQUEST_SCHEMAS.credentialPut, body, 'credential body')
  requireUtf16LengthAtMost('value', parsed.value, 64 * 1024)
  return parsed.value
}

export function parseActionInvokeBody(body: Record<string, unknown>): {
  input: unknown
  conversationId?: number
} {
  const parsed = parseBodyWithSchema(REQUEST_SCHEMAS.actionInvoke, body, 'action invoke body')
  return {
    input: parsed.input,
    ...(parsed.conversationId !== undefined ? { conversationId: parsed.conversationId } : {}),
  }
}

export function parsePluginConfigBody(body: Record<string, unknown>): Record<string, unknown> {
  const parsed = parseBodyWithSchema(REQUEST_SCHEMAS.pluginConfigPut, body, 'plugin config body')
  return { ...(parsed.values as Record<string, unknown>) }
}

// ---------------------------------------------------------------------------
// Query parsing (GET /api/conversations/:id) & param validation
// ---------------------------------------------------------------------------

const MAX_PAGE_LIMIT = 500
export const MAX_PAGE_TURNS = 50

/** Conversation detail pagination params: limit (1..500) and turns (1..50) are mutually exclusive; cursor must be a non-empty opaque string. */
export function parseDetailPagination(url: URL): { limit?: number; turns?: number; cursor?: string } {
  const limitRaw = url.searchParams.get('limit')
  let limit: number | undefined
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw) || !Number.isSafeInteger(Number(limitRaw)) || Number(limitRaw) < 1) {
      throw new ValidationError('limit must be a positive integer')
    }
    limit = Number(limitRaw)
    if (limit > MAX_PAGE_LIMIT) {
      throw new ValidationError(`limit must be <= ${MAX_PAGE_LIMIT}`)
    }
  }
  const turnsRaw = url.searchParams.get('turns')
  let turns: number | undefined
  if (turnsRaw !== null) {
    if (!/^\d+$/.test(turnsRaw) || !Number.isSafeInteger(Number(turnsRaw)) || Number(turnsRaw) < 1) {
      throw new ValidationError('turns must be a positive integer')
    }
    turns = Number(turnsRaw)
    if (turns > MAX_PAGE_TURNS) {
      throw new ValidationError(`turns must be <= ${MAX_PAGE_TURNS}`)
    }
  }
  if (limit !== undefined && turns !== undefined) {
    throw new ValidationError('limit and turns are mutually exclusive')
  }
  const cursor = url.searchParams.get('cursor') ?? undefined
  if (cursor !== undefined && cursor.length === 0) {
    throw new ValidationError('cursor must be a non-empty string')
  }
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  }
}

/** Plugin public doc name (GET /api/plugins/:id/docs/:name): identifier constraint matches doc declaration. */
export function parseDocNameParam(raw: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw)) {
    throw new ValidationError('doc name must be a valid identifier (starts with an alphanumeric character, may contain . _ -)')
  }
  return raw
}
