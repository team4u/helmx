/** `core:asks`: AskDoc listing, human-only answering, and host-governance cancellation. */
import { REQUEST_SCHEMAS, type AskAnswers, type AskStatus } from '@helmx/protocol'
import type { CoreActionsRuntimeHost } from '../runtime-types.js'
import {
  ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
  HOST_GOVERNANCE_SCOPE,
  ID_STRING,
  NO_CONVERSATION_SCOPE,
  OK_OUTPUT_SCHEMA,
  SAFE_POSITIVE_INT,
  extendRequestSchema,
  type CoreActionRegistrar,
} from './shared.js'

export function registerAskCoreActions(runtime: CoreActionsRuntimeHost, pluginHost: CoreActionRegistrar): void {
  const owner = 'core:asks'

  pluginHost.registerCoreAction(owner, {
    id: 'list',
    description: 'List AskDoc approval requests, optionally filtered by conversationId and/or status',
    idempotent: true,
    exposeToPrompt: false,
    cli: { command: ['asks', 'list'] },
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: SAFE_POSITIVE_INT,
        status: { type: 'string', enum: ['pending', 'answered', 'cancelled', 'superseded'] },
      },
      additionalProperties: false,
    },
    outputSchema: ARRAY_OF_OBJECTS_OUTPUT_SCHEMA,
    handler: (input: { conversationId?: number; status?: string }) => {
      if (input.conversationId === undefined && input.status === undefined) {
        return runtime.asks.listAsks()
      }
      return runtime.asks.listAsks({
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
        ...(input.status !== undefined ? { status: input.status as AskStatus } : {}),
      })
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'cancel',
    description: 'Cancel a pending AskDoc approval request',
    scope: HOST_GOVERNANCE_SCOPE,
    exposeToPrompt: false,
    cli: { command: ['asks', 'cancel'] },
    inputSchema: {
      type: 'object',
      properties: { id: ID_STRING },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: OK_OUTPUT_SCHEMA,
    handler: async (input: { id: string }) => {
      await runtime.asks.cancelAsk(input.id)
      return { ok: true }
    },
  })

  pluginHost.registerCoreAction(owner, {
    id: 'answer',
    description: 'Answer a pending AskDoc approval request (human HTTP/CLI only; blocked in all conversation contexts)',
    scope: NO_CONVERSATION_SCOPE,
    exposeToPrompt: false,
    cli: { command: ['asks', 'answer'] },
    inputSchema: extendRequestSchema(REQUEST_SCHEMAS.askAnswer, { id: ID_STRING }, ['id']),
    outputSchema: OK_OUTPUT_SCHEMA,
    handler: async (input: { id: string; answers: AskAnswers; expectedStateSeq?: number }) => {
      await runtime.asks.answerAsk(input.id, { ...input.answers }, input.expectedStateSeq)
      return { ok: true }
    },
  })
}
