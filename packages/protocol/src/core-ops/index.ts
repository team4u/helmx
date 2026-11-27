/**
 * Core Operation Contract barrel (server/CLI-only; re-exported from `@helmx/protocol`, never `/browser`).
 */
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

import { ASK_CORE_OPERATIONS } from './asks.js'
import { CONVERSATION_CORE_OPERATIONS } from './conversations.js'
import { NODE_CORE_OPERATIONS } from './nodes.js'
import type { CoreOperationSpec } from './types.js'

export const CORE_OPERATIONS = [
  ...NODE_CORE_OPERATIONS,
  ...CONVERSATION_CORE_OPERATIONS,
  ...ASK_CORE_OPERATIONS,
] as const satisfies readonly CoreOperationSpec[]

export type AnyCoreOperation = (typeof CORE_OPERATIONS)[number]
export type AnyCoreOperationKey = AnyCoreOperation['key']
