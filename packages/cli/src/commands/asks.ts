/**
 * AskDoc commands: asks list / answer / cancel.
 * Driven by `@helmx/protocol` `ASK_CORE_OPERATIONS` via `commandsFromOperations`.
 */
import { ASK_CORE_OPERATIONS, type AskSpec } from '@helmx/protocol'
import { CliError } from '../errors.js'
import { printTableColumns, resolveDisplayString } from '../output.js'
import { formatAskWaiting } from '../timing.js'
import { commandsFromOperations } from './from-operations.js'
import type { CommandSpec } from './shared.js'
import { printResult, resolveConversationTarget, validateEnum } from './shared.js'

const ASK_STATUSES = ['pending', 'answered', 'cancelled', 'superseded'] as const

export function asksCommands(): CommandSpec[] {
  return commandsFromOperations(ASK_CORE_OPERATIONS, {
    extraFlags: {
      'asks.list': [
        { name: 'current', type: 'boolean', help: 'filter by HELMX_CONVERSATION_ID from environment' },
      ],
    },
    validateInput: {
      'asks.list': (input, ctx) => {
        const hasConv = ctx.flags.has('conversation')
        const useCurrent = ctx.flags.get('current') === true
        if (hasConv && useCurrent) {
          throw new CliError('--conversation and --current are mutually exclusive', 'conflicting_flags')
        }
        const next: Record<string, unknown> = { ...input }
        if (hasConv) {
          const convId = input.conversationId as number | undefined
          if (convId === undefined || !Number.isSafeInteger(convId) || convId < 1) {
            throw new CliError(`--conversation must be a positive integer, got "${String(convId)}"`, 'invalid_flag_value')
          }
        } else if (useCurrent) {
          next.conversationId = resolveConversationTarget(ctx.flags, undefined, ctx.env)
        }
        if (next.status !== undefined) {
          next.status = validateEnum(next.status, ASK_STATUSES, 'status')
        }
        return next
      },
      'asks.answer': (input) => {
        const answers = input.answers
        if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
          throw new CliError(
            '--answers must be a JSON object mapping field names to string or string[] values',
            'invalid_flag_value',
          )
        }
        return input
      },
    },
    formatHuman: {
      'asks.list': (ctx, result) => {
        if (!Array.isArray(result)) {
          printResult(ctx, result)
          return
        }
        const nowMs = Date.now()
        printTableColumns(ctx.io, result as AskSpec[], [
          { label: 'id', value: (a) => a.id ?? '' },
          {
            label: 'conversation',
            value: (a) => (typeof a.conversationId === 'number' ? `#${a.conversationId}` : ''),
          },
          { label: 'status', value: (a) => a.status ?? '' },
          { label: 'waiting', value: (a) => formatAskWaiting(a, nowMs) },
          { label: 'title', value: (a) => resolveDisplayString(a.title ?? '') },
        ])
      },
    },
  })
}
