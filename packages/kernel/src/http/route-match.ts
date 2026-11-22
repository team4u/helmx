/**
 * Shared path matching: segment decoding + full-path matching for dynamic plugin routes.
 *
 * `hub.ts` (public exemption check) and `routes.ts` (dispatch) MUST share the same matcher;
 * otherwise semantic drift could exempt a route without dispatching it, or vice versa.
 *
 * - Each segment is strictly decoded with `decodeURIComponent`: invalid percent-encoding throws immediately (400)
 *   rather than silently matching literals; decoded `/` (`%2F`) stays inside its segment and never re-splits the path.
 * - Plugin route declarations (`PluginHost.register(ctx.route)`) carry full mount paths
 *   `/api/plugins/<encodeURIComponent(id)>/routes/...`; declared and request segments are both decoded to the
 *   same canonical form before exact comparison (identical segment count), avoiding fragile relative-path reconstruction.
 */

import type { PluginRouteMethod } from '@helmx/protocol'

export class PathDecodeError extends Error {
  constructor(segment: string) {
    super(`path segment contains invalid percent-encoding: ${segment}`)
    this.name = 'PathDecodeError'
  }
}

/** Strictly decode a single path segment; invalid percent-encoding throws PathDecodeError (mapped to 400 by router). */
export function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment
  try {
    return decodeURIComponent(segment)
  } catch {
    throw new PathDecodeError(segment)
  }
}

/** Split pathname (with or without `/api` prefix) into strictly decoded segments. */
export function decodeSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeSegment(s))
}

/**
 * Convert a declared route path into segments. PluginHost enforces `encodeURIComponent(pluginId)`
 * in the prefix (e.g. `/api/plugins/builtin%3Atriggers/routes/...`), so decoding each segment here
 * aligns it with the decoded request segments. Declared paths are guaranteed valid at registration time
 * (`PluginHost` rejects malformed encodings), so decode failures here propagate as internal errors rather
 * than being masked as caller request errors.
 */
function declaredSegments(declared: string): string[] {
  return declared
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeSegment(s))
}

/**
 * Full-path match with `:param` extraction: compare decoded request segments against declared segments.
 * Segment counts must match exactly; `:param` matches any non-empty decoded segment (so `%2F` stays inside
 * its single param value). Returns extracted frozen `params` and the literal-segment count for static-before-param
 * tie-breaking, or `undefined` on mismatch.
 */
function matchFullPathWithParams(
  declared: string,
  requestSegments: string[],
): { params: Readonly<Record<string, string>>; literalCount: number } | undefined {
  const parts = declaredSegments(declared)
  if (parts.length !== requestSegments.length) return undefined
  const params: Record<string, string> = {}
  let literalCount = 0
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!
    const seg = requestSegments[i]!
    if (part.startsWith(':') && part.length > 1) {
      params[part.slice(1)] = seg
    } else if (part === seg) {
      literalCount += 1
    } else {
      return undefined
    }
  }
  return { params: Object.freeze(params), literalCount }
}

/**
 * Find the unique matching route (method + full path) in the plugin route list, or `undefined`.
 * Request segments must have the form `['api', 'plugins', <pluginId>, 'routes', ...rest...]`;
 * `pluginId` is compared using its decoded value. When both a static route (e.g. `/items/latest`)
 * and a parameterized route (`/items/:id`) match, the more specific route (more literal segments) wins.
 */
interface RouteCandidate {
  pluginId: string
  method: PluginRouteMethod
  path: string
  public?: boolean
}

export function findPluginRoute<T extends RouteCandidate>(
  routes: readonly T[],
  method: string,
  requestSegments: string[],
): { route: T; pluginId: string; restSegments: string[]; params: Readonly<Record<string, string>> } | undefined {
  // segment shape: api / plugins / :pluginId / routes / ...rest (rest at least one segment)
  if (requestSegments.length < 5) return undefined
  if (requestSegments[0] !== 'api' || requestSegments[1] !== 'plugins' || requestSegments[3] !== 'routes') {
    return undefined
  }
  const pluginId = requestSegments[2]
  if (pluginId === undefined) return undefined
  const rest = requestSegments.slice(4)
  let best:
    | { route: T; params: Readonly<Record<string, string>>; literalCount: number }
    | undefined
  for (const candidate of routes) {
    if (candidate.pluginId !== pluginId || candidate.method !== method) continue
    const matched = matchFullPathWithParams(candidate.path, requestSegments)
    if (matched === undefined) continue
    if (best === undefined || matched.literalCount > best.literalCount) {
      best = { route: candidate, params: matched.params, literalCount: matched.literalCount }
    }
  }
  if (best === undefined) return undefined
  return { route: best.route, pluginId, restSegments: rest, params: best.params }
}
