/**
 * Hub HTTP/SSE transport layer.
 *
 * - createHubHandler(kernel): Web Standard handler (testable independently of node:http).
 * - startHub(options): node:http listener (defaults to 3202 / 127.0.0.1; tests should pass port: 0).
 */
export {
  createHubHandler,
  type HubHandlerOptions,
  type KernelHttpTarget,
  type ProductRouteHandler,
} from './hub.js'
export {
  startHub,
  writeWebResponse,
  type StartHubOptions,
  type HubHandle,
  type NodeServerKernelTarget,
} from './node-server.js'
export type { CoreRoutesTarget, HttpEventHub } from './routes.js'
export type { AuthRoutesTarget } from './auth-routes.js'
export type { AssetRoutesTarget, ConversationArtifactUploadTarget } from './asset-routes.js'
export type { ConversationRoutesTarget } from './conversation-routes.js'
export type { ModelRoutesTarget } from './model-routes.js'
export type { NodeRoutesTarget } from './node-routes.js'
export type { OmniboxRoutesTarget } from './omnibox-routes.js'
export type { PluginRoutesTarget, PluginRoutesHost, PluginRoutesStash } from './plugin-routes.js'
export type { ProfileRoutesTarget } from './profile-routes.js'
export type { SessionDocRoutesTarget } from './session-doc-routes.js'
export type { ConversationFileContent } from '../runtime/conversation-service.js'
export { createStaticServe, StaticServe } from './static.js'
export {
  DEFAULT_MAX_BODY_BYTES,
  jsonOk,
  errorResponse,
  errorToResponse,
  makeJsonRedactor,
  readBinaryBodyWithLimit,
  readJsonBody,
  readJsonValue,
  type JsonRedactor,
} from './http-utils.js'
export { decodeSegment, decodeSegments, PathDecodeError } from './route-match.js'
export { openSse } from './sse.js'
export {
  parseConversationCompactBody,
  parseConversationForkBody,
  parseConversationResetBody,
  parseDetailPagination,
  parseInputBody,
  ValidationError,
} from './validate.js'
