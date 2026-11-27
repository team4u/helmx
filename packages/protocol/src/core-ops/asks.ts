/**
 * Declarative Core Operation specifications for the `asks` domain.
 * Drives HTTP (`/api/asks*`), `core:asks.*` actions, and static `helmx asks *` CLI commands.
 */
import { REQUEST_SCHEMAS } from '../request-schemas.js'
import {
  CORE_ARRAY_OUTPUT_SCHEMA,
  CORE_HOST_GOVERNANCE_SCOPE,
  CORE_ID_SCHEMA,
  CORE_NO_CONVERSATION_SCOPE,
  CORE_OK_OUTPUT_SCHEMA,
  cloneProtocolJsonSchema,
  extendCoreObjectSchema,
  type CoreOperationSpec,
} from './types.js'
import type { JsonSchema } from '../plugin-contract-types.js'

const MAX_SAFE_INTEGER = 9007199254740991
const SAFE_POSITIVE_INT: JsonSchema = { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER }

export const ASK_CORE_OPERATIONS = [
  {
    key: 'asks.list',
    domain: 'asks',
    id: 'list',
    description: 'List AskDoc approval requests, optionally filtered by conversationId and/or status',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: SAFE_POSITIVE_INT,
        status: { type: 'string', enum: ['pending', 'answered', 'cancelled', 'superseded'] },
      },
      additionalProperties: false,
    },
    outputSchema: CORE_ARRAY_OUTPUT_SCHEMA,
    http: {
      method: 'GET',
      path: '/api/asks',
      queryParams: ['conversationId', 'status'],
      bodyMode: 'none',
    },
    cli: {
      command: ['asks', 'list'],
      flagAliases: { conversationId: 'conversation' },
    },
    action: {
      idempotent: true,
      exposeToPrompt: false,
    },
  },
  {
    key: 'asks.cancel',
    domain: 'asks',
    id: 'cancel',
    description: 'Cancel a pending AskDoc approval request',
    inputSchema: {
      type: 'object',
      properties: { id: CORE_ID_SCHEMA },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: CORE_OK_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/asks/:askId/cancel',
      pathParams: { askId: 'id' },
      pathValidators: { askId: 'id' },
      bodyMode: 'none',
    },
    cli: {
      command: ['asks', 'cancel'],
      positional: [{ field: 'id', required: true, label: 'id' }],
    },
    action: {
      scope: CORE_HOST_GOVERNANCE_SCOPE,
      exposeToPrompt: false,
    },
  },
  {
    key: 'asks.answer',
    domain: 'asks',
    id: 'answer',
    description: 'Answer a pending AskDoc approval request (human HTTP/CLI only; blocked in all conversation contexts)',
    inputSchema: extendCoreObjectSchema(REQUEST_SCHEMAS.askAnswer, { id: CORE_ID_SCHEMA }, ['id']),
    outputSchema: CORE_OK_OUTPUT_SCHEMA,
    http: {
      method: 'POST',
      path: '/api/asks/:askId/answer',
      pathParams: { askId: 'id' },
      pathValidators: { askId: 'id' },
      bodyMode: 'required',
      bodySchema: cloneProtocolJsonSchema(REQUEST_SCHEMAS.askAnswer),
    },
    cli: {
      command: ['asks', 'answer'],
      positional: [{ field: 'id', required: true, label: 'id' }],
    },
    action: {
      scope: CORE_NO_CONVERSATION_SCOPE,
      exposeToPrompt: false,
    },
  },
] as const satisfies readonly CoreOperationSpec[]

export type AskCoreOperation = (typeof ASK_CORE_OPERATIONS)[number]
export type AskCoreOperationKey = AskCoreOperation['key']
