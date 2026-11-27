/**
 * Generic HTTP matcher, boundary validator, and dispatcher driven by `CoreOperationSpec[]`.
 *
 * Guarantees static-before-param precedence, percent-decoded path parameter validation,
 * query coercion, `bodyMode` (`required | optional | none`), JSON Schema enforcement,
 * SecretStash redaction control (`redactResponse: false`), and mapped-type exhaustiveness.
 */
import {
  isValidNodeId,
  type CoreOperationHttpMethod,
  type CoreOperationParamValidator,
  type CoreOperationSpec,
  type JsonSchema,
} from '@helmx/protocol'
import { errorResponse, jsonOk, readJsonBody, type JsonRedactor } from './http-utils.js'
import {
  methodNotAllowed,
  parseOptionalBooleanFlag,
  parseOptionalJsonObjectBody,
  type RouteContext,
} from './route-context.js'
import { decodeSegment } from './route-match.js'
import { parseIdParam, requireIdParam, ValidationError, assertBodySchema } from './validate.js'

const CORE_HTTP_CUSTOM_RESPONSE_TAG = Symbol('CoreOperationHttpCustomResponse')
const FORWARD_ID_REGEX = /^fwd-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface CoreOperationHttpHandlerContext {
  readonly route: RouteContext
  readonly redactor: JsonRedactor | undefined
}

export interface CoreOperationHttpCustomResponse {
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body: unknown
  readonly redactResponse?: boolean
}

type TaggedCustomResponse = CoreOperationHttpCustomResponse & {
  readonly [CORE_HTTP_CUSTOM_RESPONSE_TAG]: true
}

/** Wrap a custom HTTP status/header payload from a `CoreOperationSpec` route handler. */
export function coreOperationResponse(
  response: CoreOperationHttpCustomResponse,
): CoreOperationHttpCustomResponse {
  return { ...response, [CORE_HTTP_CUSTOM_RESPONSE_TAG]: true } as TaggedCustomResponse
}

function isTaggedCustomResponse(value: unknown): value is TaggedCustomResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[CORE_HTTP_CUSTOM_RESPONSE_TAG] === true
  )
}

export type CoreOperationHttpHandlerFn<TInput = Record<string, unknown>, TResult = unknown> = (
  input: TInput,
  ctx: CoreOperationHttpHandlerContext,
) => Promise<TResult> | TResult

export interface CoreOperationHttpHandlerObject<TInput = Record<string, unknown>, TResult = unknown> {
  /** Optional semantic validation / normalization executed after JSON Schema validation. */
  readonly validate?: (input: TInput, ctx: CoreOperationHttpHandlerContext) => TInput | void
  readonly handle: CoreOperationHttpHandlerFn<TInput, TResult>
}

export type CoreOperationHttpHandler<TInput = Record<string, unknown>, TResult = unknown> =
  | CoreOperationHttpHandlerObject<TInput, TResult>
  | CoreOperationHttpHandlerFn<TInput, TResult>

export type CoreOperationHttpHandlers<TOps extends readonly CoreOperationSpec[]> = {
  readonly [K in TOps[number]['key']]: CoreOperationHttpHandler
}

export interface CoreOperationRouterOptions {
  /** Router-wide default for `405 method_not_allowed` vs `404` on wrong HTTP method (default `false`). */
  readonly defaultMethodNotAllowed?: boolean
}

interface CompiledSegmentLiteral {
  readonly kind: 'literal'
  readonly value: string
}

interface CompiledSegmentParam {
  readonly kind: 'param'
  readonly paramName: string
  readonly fieldName: string
  readonly validator?: CoreOperationParamValidator
}

type CompiledSegment = CompiledSegmentLiteral | CompiledSegmentParam

interface CompiledRoute {
  readonly spec: CoreOperationSpec
  readonly patternKey: string
  readonly segments: readonly CompiledSegment[]
  readonly literalCount: number
  readonly paramCount: number
  readonly literalBitmask: number
  readonly handler: CoreOperationHttpHandlerObject
}

interface CompiledRouteGroup {
  readonly patternKey: string
  readonly segments: readonly CompiledSegment[]
  readonly literalCount: number
  readonly paramCount: number
  readonly literalBitmask: number
  readonly routes: ReadonlyMap<CoreOperationHttpMethod, CompiledRoute>
  readonly methodNotAllowed: boolean
  readonly allowedMethods: readonly CoreOperationHttpMethod[]
}

function normalizePathPattern(path: string): readonly string[] {
  const parts = path.split('/').filter((s) => s.length > 0)
  if (parts[0] === 'api') parts.shift()
  return parts
}

function compilePatternSegments(spec: CoreOperationSpec): {
  patternKey: string
  segments: CompiledSegment[]
  literalCount: number
  paramCount: number
  literalBitmask: number
} {
  const rawParts = normalizePathPattern(spec.http.path)
  const segments: CompiledSegment[] = []
  let literalCount = 0
  let paramCount = 0
  let literalBitmask = 0
  const keyParts: string[] = []

  for (let i = 0; i < rawParts.length; i++) {
    const part = rawParts[i]!
    if (part.startsWith(':')) {
      const paramName = part.slice(1)
      const fieldName = spec.http.pathParams?.[paramName] ?? paramName
      const validator = spec.http.pathValidators?.[paramName]
      segments.push({
        kind: 'param',
        paramName,
        fieldName,
        ...(validator !== undefined ? { validator } : {}),
      })
      paramCount++
      keyParts.push('*')
    } else {
      segments.push({ kind: 'literal', value: part })
      literalCount++
      // Set higher bit weight for earlier static segments so `/nodes/forward/:id` precedes `/nodes/:id/forward`.
      literalBitmask += 2 ** Math.max(0, 30 - i)
      keyParts.push(`=${part}`)
    }
  }

  return {
    patternKey: keyParts.join('/'),
    segments,
    literalCount,
    paramCount,
    literalBitmask,
  }
}

function normalizeHandler(handler: CoreOperationHttpHandler): CoreOperationHttpHandlerObject {
  return typeof handler === 'function' ? { handle: handler } : handler
}

function validatePathParam(
  raw: string,
  fieldName: string,
  validator?: CoreOperationParamValidator,
): string | number {
  const decoded = decodeSegment(raw)
  switch (validator) {
    case 'nodeId':
      if (!isValidNodeId(decoded)) {
        throw new ValidationError(
          `${fieldName === 'id' ? 'nodeId' : fieldName} must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ (starts with an alphanumeric character, may contain . _ -)`,
        )
      }
      return decoded
    case 'forwardId':
      if (!FORWARD_ID_REGEX.test(decoded)) {
        throw new ValidationError('forwardId must be in fwd-<uuid> format')
      }
      return decoded
    case 'positiveInt':
      return parseIdParam(decoded, fieldName)
    case 'id':
      return requireIdParam(decoded, fieldName)
    case 'nonEmpty':
      if (decoded.length === 0) {
        throw new ValidationError(`${fieldName} is required`)
      }
      return decoded
    default:
      return decoded
  }
}

function resolveSchemaPropertyTypes(schema: JsonSchema, field: string): Set<string> {
  const props = schema['properties'] as Record<string, JsonSchema> | undefined
  const prop = props?.[field]
  if (!prop || typeof prop !== 'object') return new Set()
  const t = prop['type']
  if (typeof t === 'string') return new Set([t])
  if (Array.isArray(t)) return new Set(t.filter((x): x is string => typeof x === 'string'))
  return new Set()
}

function extractQueryParams(
  spec: CoreOperationSpec,
  url: URL,
): Record<string, unknown> {
  const names = spec.http.queryParams
  if (!names || names.length === 0) return {}
  const out: Record<string, unknown> = {}
  for (const name of names) {
    const raw = url.searchParams.get(name)
    if (raw === null) continue
    const types = resolveSchemaPropertyTypes(spec.inputSchema, name)
    if (types.has('boolean')) {
      const parsed = parseOptionalBooleanFlag(url, name)
      if (parsed !== undefined) out[name] = parsed
    } else if (types.has('integer')) {
      if (/^-?\d+$/.test(raw)) {
        const num = Number(raw)
        out[name] = Number.isSafeInteger(num) ? num : raw
      } else {
        out[name] = raw
      }
    } else if (types.has('number')) {
      const num = Number(raw)
      out[name] = raw.trim() !== '' && Number.isFinite(num) ? num : raw
    } else {
      out[name] = raw
    }
  }
  return out
}

async function readOperationBody(
  spec: CoreOperationSpec,
  ctx: RouteContext,
): Promise<Record<string, unknown>> {
  const bodyMode = spec.http.bodyMode ?? (spec.http.method === 'GET' || spec.http.method === 'DELETE' ? 'none' : 'required')
  if (bodyMode === 'none') return {}
  if (bodyMode === 'optional') {
    return parseOptionalJsonObjectBody(ctx.request, (obj) => obj)
  }
  const raw = await readJsonBody(ctx.request)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError(`${spec.key} body must be a JSON object`)
  }
  return raw as Record<string, unknown>
}

function matchGroup(
  group: CompiledRouteGroup,
  segments: readonly string[],
): Record<string, string | number> | undefined {
  if (segments.length !== group.segments.length) return undefined
  const pathObj: Record<string, string | number> = {}
  for (let i = 0; i < group.segments.length; i++) {
    const expected = group.segments[i]!
    const actual = segments[i]!
    if (expected.kind === 'literal') {
      if (actual !== expected.value) return undefined
    } else {
      pathObj[expected.fieldName] = validatePathParam(actual, expected.fieldName, expected.validator)
    }
  }
  return pathObj
}

/**
 * Compile a declarative `CoreOperationSpec[]` array into a fast, static-first HTTP dispatcher.
 * Returns a `Response` when a registered path matches, or `undefined` when no pattern matches
 * (allowing adjacent streaming/binary domain routes to run cleanly).
 */
export function createCoreOperationRouter<const TOps extends readonly CoreOperationSpec[]>(
  operations: TOps,
  handlers: CoreOperationHttpHandlers<TOps>,
  options: CoreOperationRouterOptions = {},
): (ctx: RouteContext, redactor: JsonRedactor | undefined) => Promise<Response | undefined> {
  const defaultMethodNotAllowed = options.defaultMethodNotAllowed === true
  const groupsByKey = new Map<
    string,
    {
      patternKey: string
      segments: CompiledSegment[]
      literalCount: number
      paramCount: number
      literalBitmask: number
      routes: Map<CoreOperationHttpMethod, CompiledRoute>
      methodNotAllowed: boolean
    }
  >()

  const handlerRecord = handlers as Record<string, CoreOperationHttpHandler>
  for (const spec of operations) {
    const compiled = compilePatternSegments(spec)
    let group = groupsByKey.get(compiled.patternKey)
    if (group === undefined) {
      group = {
        ...compiled,
        routes: new Map(),
        methodNotAllowed: false,
      }
      groupsByKey.set(compiled.patternKey, group)
    }
    const opMethodNotAllowed = spec.http.methodNotAllowed ?? defaultMethodNotAllowed
    if (opMethodNotAllowed) group.methodNotAllowed = true
    group.routes.set(spec.http.method, {
      spec,
      patternKey: compiled.patternKey,
      segments: compiled.segments,
      literalCount: compiled.literalCount,
      paramCount: compiled.paramCount,
      literalBitmask: compiled.literalBitmask,
      handler: normalizeHandler(handlerRecord[spec.key]!),
    })
  }

  const orderedGroups: CompiledRouteGroup[] = [...groupsByKey.values()]
    .map((g) => ({
      ...g,
      allowedMethods: [...g.routes.keys()],
    }))
    .sort((a, b) => {
      if (a.literalCount !== b.literalCount) return b.literalCount - a.literalCount
      if (a.literalBitmask !== b.literalBitmask) return b.literalBitmask - a.literalBitmask
      return a.paramCount - b.paramCount
    })

  return async (ctx: RouteContext, redactor: JsonRedactor | undefined): Promise<Response | undefined> => {
    for (const group of orderedGroups) {
      // Quick literal-segment check BEFORE decoding params so non-matching patterns never throw PathDecodeError/ValidationError.
      if (ctx.segments.length !== group.segments.length) continue
      let literalsMatch = true
      for (let i = 0; i < group.segments.length; i++) {
        const seg = group.segments[i]!
        if (seg.kind === 'literal' && ctx.segments[i] !== seg.value) {
          literalsMatch = false
          break
        }
      }
      if (!literalsMatch) continue

      const route = group.routes.get(ctx.method as CoreOperationHttpMethod)
      if (route === undefined) {
        if (group.methodNotAllowed) {
          return methodNotAllowed(redactor, ctx.method)
        }
        return errorResponse(redactor, 404, 'not_found', 'route not found')
      }

      const pathObj = matchGroup(group, ctx.segments)!
      const bodyObj = await readOperationBody(route.spec, ctx)
      if (route.spec.http.bodyMode !== 'none' && route.spec.http.pathParams) {
        for (const fieldName of Object.values(route.spec.http.pathParams)) {
          if (Object.hasOwn(bodyObj, fieldName)) {
            throw new ValidationError(
              `${route.spec.key} body does not allow unknown field ${fieldName}`,
            )
          }
        }
      }
      const queryObj = extractQueryParams(route.spec, ctx.url)
      const merged: Record<string, unknown> = { ...bodyObj, ...queryObj, ...pathObj }
      assertBodySchema(route.spec.inputSchema, merged, `${route.spec.key} request`)

      const handlerCtx: CoreOperationHttpHandlerContext = { route: ctx, redactor }
      const validated = route.handler.validate
        ? (route.handler.validate(merged, handlerCtx) ?? merged)
        : merged
      const result = await route.handler.handle(validated, handlerCtx)

      if (result instanceof Response) return result
      if (isTaggedCustomResponse(result)) {
        const status = result.status ?? route.spec.http.status ?? 200
        const headers = result.headers ?? route.spec.http.responseHeaders
        const redact = result.redactResponse ?? (route.spec.http.redactResponse !== false)
        if (!redact) {
          return new Response(JSON.stringify(result.body), {
            status,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              ...(headers ?? {}),
            },
          })
        }
        return jsonOk(redactor, result.body, {
          status,
          ...(headers !== undefined ? { headers: { ...headers } } : {}),
        })
      }

      const status = route.spec.http.status ?? 200
      const headers = route.spec.http.responseHeaders
      if (route.spec.http.redactResponse === false) {
        return new Response(JSON.stringify(result), {
          status,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            ...(headers ?? {}),
          },
        })
      }
      return jsonOk(redactor, result, {
        status,
        ...(headers !== undefined ? { headers: { ...headers } } : {}),
      })
    }
    return undefined
  }
}
