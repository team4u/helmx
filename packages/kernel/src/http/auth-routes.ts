/**
 * Auth domain routes driven by `AUTH_CORE_OPERATIONS` via `createCoreOperationRouter`:
 * GET /api/auth/status, POST /api/auth/setup, POST /api/auth/login (all three endpoints are public
 * and pre-allowed in hub.ts; all other auth subpaths return 404).
 */
import { AUTH_CORE_OPERATIONS } from '@helmx/protocol'
import type { AuthService } from '../services/index.js'
import { createCoreOperationRouter } from './core-operation-router.js'
import { bearerToken, errorResponse, type JsonRedactor } from './http-utils.js'
import type { RouteContext } from './route-context.js'

export interface AuthRoutesTarget {
  readonly auth: Pick<AuthService, 'status' | 'verifyToken' | 'setup' | 'login'>
}

function dispatchAuthRoutes(
  kernel: AuthRoutesTarget,
): (ctx: RouteContext, redactor: JsonRedactor | undefined) => Promise<Response | undefined> {
  return createCoreOperationRouter(AUTH_CORE_OPERATIONS, {
    'auth.status': async (_input, { route }) => {
      const status = await kernel.auth.status()
      // authenticated reflects the Bearer token check on this request;
      // unconfigured, missing, or invalid tokens all report false while configured is reported independently.
      const token = bearerToken(route.request)
      const authenticated = token !== undefined && (await kernel.auth.verifyToken(token)) === true
      return { configured: status.configured, authenticated }
    },

    'auth.setup': async (input) => {
      const issued = await kernel.auth.setup(input.password as string)
      return { token: issued.token }
    },

    'auth.login': async (input) => {
      const issued = await kernel.auth.login(input.password as string)
      return { token: issued.token }
    },
  })
}

export async function handleAuthDomain(
  ctx: RouteContext,
  kernel: AuthRoutesTarget,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const matched = await dispatchAuthRoutes(kernel)(ctx, redactor)
  if (matched !== undefined) return matched
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}
