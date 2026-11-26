/**
 * Auth domain routes: GET /api/auth/status, POST /api/auth/setup,
 * POST /api/auth/login (all three endpoints are public and pre-allowed in hub.ts; all other auth subpaths return 404).
 */
import { REQUEST_SCHEMAS } from '@helmx/protocol'
import type { AuthService } from '../services/index.js'
import { jsonOk, errorResponse, readJsonBody, bearerToken, type JsonRedactor } from './http-utils.js'
import { assertBodySchema } from './validate.js'
import type { RouteContext } from './route-context.js'

export interface AuthRoutesTarget {
  readonly auth: Pick<AuthService, 'status' | 'verifyToken' | 'setup' | 'login'>
}

export async function handleAuthDomain(
  ctx: RouteContext,
  kernel: AuthRoutesTarget,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
  if (second === 'status' && method === 'GET' && third === undefined) {
    const status = await kernel.auth.status()
    // authenticated reflects the Bearer token check on this request;
    // unconfigured, missing, or invalid tokens all report false while configured is reported independently.
    const token = bearerToken(ctx.request)
    const authenticated = token !== undefined && (await kernel.auth.verifyToken(token)) === true
    return jsonOk(redactor, { configured: status.configured, authenticated })
  }
  if (second === 'setup' && method === 'POST' && third === undefined) {
    const body = await readJsonBody(ctx.request)
    assertBodySchema(REQUEST_SCHEMAS.authPassword, body, 'auth setup body')
    const issued = await kernel.auth.setup(body.password as string)
    return jsonOk(redactor, { token: issued.token })
  }
  if (second === 'login' && method === 'POST' && third === undefined) {
    const body = await readJsonBody(ctx.request)
    assertBodySchema(REQUEST_SCHEMAS.authPassword, body, 'auth login body')
    const issued = await kernel.auth.login(body.password as string)
    return jsonOk(redactor, { token: issued.token })
  }
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}
