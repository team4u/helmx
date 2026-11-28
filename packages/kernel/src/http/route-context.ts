/**
 * Shared request context and small helpers for domain routers (no business semantics).
 *
 * `RouteContext.segments` holds strictly decoded path segments (the `api` prefix is stripped, and invalid
 * percent-encoding is rejected upfront with 400 by `routes.ts` before entering domain handlers). Each
 * domain handler matches only segments at or below its own prefix: exact method + path segment matching,
 * exact segment count required, and extra segments always return domain-level 404 (never fall through).
 */
import { errorResponse, readBinaryBodyWithLimit, type JsonRedactor } from './http-utils.js'
import { ValidationError } from './validate.js'

export interface RouteContext {
  request: Request
  method: string
  /** Strictly decoded path segments (with leading `api` prefix stripped). */
  segments: string[]
  url: URL
}

export function methodNotAllowed(redactor: JsonRedactor | undefined, method: string): Response {
  return errorResponse(redactor, 405, 'method_not_allowed', `method not allowed: ${method}`)
}

/** `?flag=1/true/0/false` query parameter: any other value fails with 400 (never guesses truthiness). */
export function parseOptionalBooleanFlag(url: URL, param: string): boolean | undefined {
  const raw = url.searchParams.get(param)
  if (raw === null) return undefined
  if (raw === '1' || raw === 'true') return true
  if (raw === '0' || raw === 'false') return false
  throw new ValidationError(`${param} must be 1/0 or true/false`)
}

/**
 * Optional JSON object body: empty body is parsed as `{}` (matching original semantics so `parse`
 * decides whether `{}` is valid); non-empty bodies must be a JSON object (arrays/scalars rejected).
 */
export async function parseOptionalJsonObjectBody<T>(
  request: Request,
  parse: (body: Record<string, unknown>) => T,
): Promise<T> {
  const raw = await readBinaryBodyWithLimit(request, 1024 * 1024)
  if (raw.length === 0) return parse({})
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    throw new ValidationError('request body is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('request body must be a JSON object')
  }
  return parse(parsed as Record<string, unknown>)
}
