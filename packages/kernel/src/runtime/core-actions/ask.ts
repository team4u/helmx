/**
 * `core:asks`: AskDoc listing, human-only answering, and host-governance cancellation.
 * Driven by `@helmx/protocol` `ASK_CORE_OPERATIONS` via `registerCoreActionsFromOperations`.
 */
import { ASK_CORE_OPERATIONS, type AskAnswers, type AskStatus } from '@helmx/protocol'
import type { CoreActionsRuntimeHost } from '../runtime-types.js'
import { registerCoreActionsFromOperations } from './from-operations.js'
import type { CoreActionRegistrar } from './shared.js'

export function registerAskCoreActions(
  runtime: CoreActionsRuntimeHost,
  pluginHost: CoreActionRegistrar,
): void {
  registerCoreActionsFromOperations(pluginHost, ASK_CORE_OPERATIONS, {
    'asks.list': (input) => {
      const conversationId = input.conversationId as number | undefined
      const status = input.status as string | undefined
      if (conversationId === undefined && status === undefined) {
        return runtime.asks.listAsks()
      }
      return runtime.asks.listAsks({
        ...(conversationId !== undefined ? { conversationId } : {}),
        ...(status !== undefined ? { status: status as AskStatus } : {}),
      })
    },

    'asks.cancel': async (input) => {
      await runtime.asks.cancelAsk(input.id as string)
      return { ok: true }
    },

    'asks.answer': async (input) => {
      await runtime.asks.answerAsk(
        input.id as string,
        { ...(input.answers as AskAnswers) },
        input.expectedStateSeq as number | undefined,
      )
      return { ok: true }
    },
  })
}
