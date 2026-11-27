/**
 * Core Operation Contract barrel (server/CLI-only; re-exported from `@helmx/protocol`, never `/browser`).
 */
import { ASK_CORE_OPERATIONS } from './asks.js'
import { AUTH_CORE_OPERATIONS } from './auth.js'
import { CONVERSATION_CORE_OPERATIONS } from './conversations.js'
import { CREDENTIAL_CORE_OPERATIONS, MODEL_CORE_OPERATIONS, PROVIDER_CORE_OPERATIONS } from './models.js'
import { NODE_CORE_OPERATIONS } from './nodes.js'
import { PROFILE_CORE_OPERATIONS } from './profiles.js'
import type { CoreOperationSpec } from './types.js'

export type {
  CoreActionOperationKey,
  CoreActionOperations,
  CoreOperationActionSpec,
  CoreOperationBodyMode,
  CoreOperationCliSpec,
  CoreOperationHttpMethod,
  CoreOperationHttpSpec,
  CoreOperationKey,
  CoreOperationParamValidator,
  CoreOperationPositionalSpec,
  CoreOperationSpec,
} from './types.js'
export {
  NODE_CORE_OPERATIONS,
  type NodeCoreOperation,
  type NodeCoreOperationKey,
} from './nodes.js'
export {
  CONVERSATION_CORE_OPERATIONS,
  type ConversationCoreOperation,
  type ConversationCoreOperationKey,
} from './conversations.js'
export {
  ASK_CORE_OPERATIONS,
  type AskCoreOperation,
  type AskCoreOperationKey,
} from './asks.js'
export {
  PROFILE_CORE_OPERATIONS,
  type ProfileCoreOperation,
  type ProfileCoreOperationKey,
} from './profiles.js'
export {
  MODEL_CORE_OPERATIONS,
  PROVIDER_CORE_OPERATIONS,
  CREDENTIAL_CORE_OPERATIONS,
  type ModelCoreOperation,
  type ModelCoreOperationKey,
  type ProviderCoreOperation,
  type ProviderCoreOperationKey,
  type CredentialCoreOperation,
  type CredentialCoreOperationKey,
} from './models.js'
export {
  AUTH_CORE_OPERATIONS,
  type AuthCoreOperation,
  type AuthCoreOperationKey,
} from './auth.js'

export const CORE_OPERATIONS = [
  ...NODE_CORE_OPERATIONS,
  ...CONVERSATION_CORE_OPERATIONS,
  ...ASK_CORE_OPERATIONS,
  ...PROFILE_CORE_OPERATIONS,
  ...MODEL_CORE_OPERATIONS,
  ...PROVIDER_CORE_OPERATIONS,
  ...CREDENTIAL_CORE_OPERATIONS,
  ...AUTH_CORE_OPERATIONS,
] as const satisfies readonly CoreOperationSpec[]

export type AnyCoreOperation = (typeof CORE_OPERATIONS)[number]
export type AnyCoreOperationKey = AnyCoreOperation['key']
