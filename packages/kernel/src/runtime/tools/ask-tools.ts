/**
 * Kernel built-in `ask_user` tool: structured human-in-the-loop clarification questions
 * backed by `AskService` (top-level human-owned conversations only).
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { defineTool, type ToolExecutionApi, type ToolRegistration } from '@earendil-works/pi-durable'
import { arr, bool, obj, oneOf, opt, str } from '@earendil-works/pi-schema'
import {
  matchesConversationScope,
  type AskCreateSpec,
  type AskFieldOption,
  type AskFieldSpec,
  type AskResult,
  type ConversationScope,
  type ConversationSummary,
} from '@helmx/protocol'
import type { AskService } from '../asks.js'
import { throwIfToolAborted } from '../tool-deps.js'

export const ASK_USER_TOOL_NAME = 'ask_user' as const
export const ASK_USER_OWNER_ID = 'core:ask_user' as const
export const ASK_USER_SCOPE: ConversationScope = {
  topLevelOnly: true,
  ownedBy: 'human',
}

export const ASK_USER_PROMPT_SNIPPET = [
  '<ask_user>',
  'Use `ask_user` to ask the user structured questions when you hit genuine requirement ambiguity, architectural trade-offs, missing required inputs (e.g. target host/path/policy), or high-impact irreversible decisions.',
  '- Do NOT call `ask_user` for trivial details you can safely infer from the codebase or standard conventions.',
  '- Pick the best-fitting question type: `single_select` (default when `options` are given), `multi_select`, `text` (open-ended or multiline input), or `confirm` (quick binary confirmation).',
  '- Mark at most one best default option with `recommended: true` when helpful; selection questions allow an inline custom "Other" answer by default unless you set `allowCustom: false`.',
  '- If the user sends a new chat message instead of submitting the card, the pending ask resolves as `superseded` with empty answers. Never treat `superseded` or `cancelled` as user approval or confirmation — read the new user message first, continue directly if it already answered your question, and avoid re-asking the same prompt.',
  '</ask_user>',
].join('\n')

const ASK_TITLE_MAX_CHARS = 120
const ASK_MAX_QUESTIONS = 4
const ASK_MIN_OPTIONS = 2
const ASK_MAX_OPTIONS = 8
const ASK_QUESTION_MAX_CHARS = 300
const ASK_OPTION_VALUE_MAX_CHARS = 64
const ASK_OPTION_LABEL_MAX_CHARS = 120
const ASK_OPTION_DESC_MAX_CHARS = 200
const ASK_PLACEHOLDER_MAX_CHARS = 160
const ASK_CONFIRM_LABEL_MAX_CHARS = 40
const ASK_META_ANSWER_MAX_CHARS = 1000
const QUESTION_ID_RE = /^[A-Za-z0-9_-]{1,40}$/

type AskQuestionType = 'single_select' | 'multi_select' | 'text' | 'confirm'

interface NormalizedQuestion {
  id: string
  question: string
  type: AskQuestionType
  options?: Array<{ value: string; label: string; description?: string; recommended?: boolean }>
  allowCustom?: boolean
  multiline?: boolean
  placeholder?: string
  required: boolean
  confirmLabel?: string
  rejectLabel?: string
}

export interface AskUserToolDeps {
  asks?: Pick<AskService, 'createAsk' | 'cancelAsk'>
  getConversation: (conversationId: number) => ConversationSummary
  redact: (text: string) => string
}

const askUserParameters = obj({
  title: opt(str({ minLength: 1, maxLength: ASK_TITLE_MAX_CHARS, description: 'Optional card title (1-120 chars)' })),
  questions: arr(
    obj({
      id: str({
        minLength: 1,
        maxLength: 40,
        pattern: QUESTION_ID_RE.source,
        description: 'Unique identifier matching ^[A-Za-z0-9_-]{1,40}$',
      }),
      question: str({ minLength: 1, maxLength: ASK_QUESTION_MAX_CHARS, description: 'Concise question prompt (1-300 chars)' }),
      type: opt(
        oneOf(['single_select', 'multi_select', 'text', 'confirm'], {
          description: 'Question type (defaults to single_select when options are provided, otherwise text)',
        }),
      ),
      options: opt(
        arr(
          obj({
            value: str({ minLength: 1, maxLength: ASK_OPTION_VALUE_MAX_CHARS, description: 'Option machine value' }),
            label: str({ minLength: 1, maxLength: ASK_OPTION_LABEL_MAX_CHARS, description: 'Option display label' }),
            description: opt(str({ maxLength: ASK_OPTION_DESC_MAX_CHARS, description: 'Optional secondary explanation' })),
            recommended: opt(bool({ description: 'Mark this option as the recommended choice' })),
          }),
          { minItems: ASK_MIN_OPTIONS, maxItems: ASK_MAX_OPTIONS, description: '2-8 options (for single_select/multi_select)' },
        ),
      ),
      allowCustom: opt(bool({ description: 'Allow inline custom free-text input alongside options (default true for selection questions)' })),
      multiline: opt(bool({ description: 'Use a multiline textarea for text questions' })),
      placeholder: opt(str({ maxLength: ASK_PLACEHOLDER_MAX_CHARS, description: 'Optional input placeholder (for text or custom choice input)' })),
      required: opt(bool({ description: 'Whether an answer is required (default true)' })),
      confirmLabel: opt(str({ minLength: 1, maxLength: ASK_CONFIRM_LABEL_MAX_CHARS, description: 'Custom positive button label (confirm only)' })),
      rejectLabel: opt(str({ minLength: 1, maxLength: ASK_CONFIRM_LABEL_MAX_CHARS, description: 'Custom negative button label (confirm only)' })),
    }),
    { minItems: 1, maxItems: ASK_MAX_QUESTIONS, description: '1-4 concise structured questions' },
  ),
})

function toolError(message: string, details?: JsonValue) {
  return {
    output: [{ type: 'text' as const, text: message }],
    isError: true,
    ...(details !== undefined ? { details } : {}),
  }
}

function truncateChars(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function formatQuestionAnswer(
  q: NormalizedQuestion,
  rawAnswer: string | string[] | undefined,
  redact: (text: string) => string,
): string {
  if (q.type === 'multi_select') {
    const selected = Array.isArray(rawAnswer) ? rawAnswer : []
    if (selected.length === 0) return '(skipped)'
    return selected
      .map((val) => {
        const cleanVal = redact(val)
        const optMatch = q.options?.find((o) => o.value === val)
        return optMatch !== undefined ? `${cleanVal} (${optMatch.label})` : `${cleanVal} (custom)`
      })
      .join(', ')
  }

  const val = typeof rawAnswer === 'string' ? rawAnswer : ''
  if (val.trim() === '') return '(skipped)'
  const cleanVal = redact(val.trim())

  if (q.type === 'single_select') {
    const optMatch = q.options?.find((o) => o.value === val)
    return optMatch !== undefined ? `${cleanVal} (${optMatch.label})` : `${cleanVal} (custom)`
  }
  if (q.type === 'confirm') {
    if (val === 'true') return q.confirmLabel ?? 'Yes (true)'
    if (val === 'false') return q.rejectLabel ?? 'No (false)'
    return cleanVal
  }
  return cleanVal
}

/** `ask_user` kernel tool: structured interactive user prompt for top-level human conversations. */
export function createAskUserTool(deps: AskUserToolDeps): ToolRegistration<typeof askUserParameters> {
  return defineTool({
    name: ASK_USER_TOOL_NAME,
    description:
      'Ask the human user 1-4 structured questions (single_select, multi_select, open text, or confirm) via the interactive AskDock card and wait for their reply. Top-level human conversations only.',
    parameters: askUserParameters,
    async execute(args, api: ToolExecutionApi, context: Context) {
      if (deps.asks === undefined) {
        return toolError('ask_user_failed: AskService is not configured.')
      }
      const conversationId = api.conversationId
      let conv: ConversationSummary
      try {
        conv = deps.getConversation(conversationId)
      } catch (err) {
        return toolError(`ask_user_failed: ${deps.redact(err instanceof Error ? err.message : String(err))}`)
      }
      if (!matchesConversationScope(ASK_USER_SCOPE, conv)) {
        return toolError('ask_user is only available in top-level human conversations.')
      }

      const rawTitle = typeof args?.title === 'string' ? args.title.trim() : ''
      if (args?.title !== undefined && (rawTitle.length === 0 || rawTitle.length > ASK_TITLE_MAX_CHARS)) {
        return toolError(`ask_user title must be 1-${ASK_TITLE_MAX_CHARS} characters when provided.`)
      }
      const explicitTitle = rawTitle !== '' ? deps.redact(rawTitle).trim() : undefined
      if (rawTitle !== '' && (explicitTitle === undefined || explicitTitle.length === 0 || explicitTitle.length > ASK_TITLE_MAX_CHARS)) {
        return toolError(`ask_user title after redaction must be 1-${ASK_TITLE_MAX_CHARS} characters.`)
      }
      const metaTitle = explicitTitle ?? 'Clarifying Questions'

      if (!Array.isArray(args?.questions) || args.questions.length < 1 || args.questions.length > ASK_MAX_QUESTIONS) {
        return toolError(`ask_user requires 1-${ASK_MAX_QUESTIONS} questions.`)
      }

      const questionIds = new Set<string>()
      const normalizedQuestions: NormalizedQuestion[] = []

      for (const rawQ of args.questions) {
        const id = typeof rawQ?.id === 'string' ? rawQ.id.trim() : ''
        if (!QUESTION_ID_RE.test(id)) {
          return toolError(`Invalid ask_user question id "${id}": must match /^[A-Za-z0-9_-]{1,40}$/.`)
        }
        if (questionIds.has(id)) {
          return toolError(`Duplicate ask_user question id: "${id}".`)
        }
        questionIds.add(id)

        const rawPrompt = typeof rawQ?.question === 'string' ? rawQ.question.trim() : ''
        const safePrompt = deps.redact(rawPrompt).trim()
        if (safePrompt.length === 0 || safePrompt.length > ASK_QUESTION_MAX_CHARS) {
          return toolError(`Question "${id}" prompt must be 1-${ASK_QUESTION_MAX_CHARS} characters.`)
        }

        const qType: AskQuestionType = rawQ?.type ?? (rawQ?.options !== undefined ? 'single_select' : 'text')
        const required = rawQ?.required ?? true

        if (qType === 'single_select' || qType === 'multi_select') {
          if (rawQ?.multiline !== undefined) {
            return toolError(`Question "${id}" (${qType}) cannot set multiline.`)
          }
          if (rawQ?.confirmLabel !== undefined || rawQ?.rejectLabel !== undefined) {
            return toolError(`Question "${id}" (${qType}) cannot set confirmLabel or rejectLabel.`)
          }
          if (!Array.isArray(rawQ?.options) || rawQ.options.length < ASK_MIN_OPTIONS || rawQ.options.length > ASK_MAX_OPTIONS) {
            return toolError(`Question "${id}" (${qType}) must provide ${ASK_MIN_OPTIONS}-${ASK_MAX_OPTIONS} options.`)
          }
          const allowCustom = rawQ?.allowCustom ?? true
          let safePlaceholder: string | undefined
          if (rawQ?.placeholder !== undefined) {
            if (!allowCustom) {
              return toolError(`Question "${id}" placeholder is only allowed when allowCustom is true.`)
            }
            const trimmedPh = deps.redact(rawQ.placeholder.trim()).trim()
            if (trimmedPh.length > ASK_PLACEHOLDER_MAX_CHARS) {
              return toolError(`Question "${id}" placeholder exceeds ${ASK_PLACEHOLDER_MAX_CHARS} characters.`)
            }
            if (trimmedPh !== '') safePlaceholder = trimmedPh
          }

          const optValues = new Set<string>()
          const normalizedOptions: Array<{ value: string; label: string; description?: string; recommended?: boolean }> = []
          for (const rawOpt of rawQ.options) {
            const val = typeof rawOpt?.value === 'string' ? rawOpt.value.trim() : ''
            if (val === '' || val.length > ASK_OPTION_VALUE_MAX_CHARS) {
              return toolError(`Question "${id}" option value must be 1-${ASK_OPTION_VALUE_MAX_CHARS} characters.`)
            }
            if (optValues.has(val)) {
              return toolError(`Question "${id}" has duplicate option value "${val}".`)
            }
            optValues.add(val)

            const safeLabel = deps.redact(typeof rawOpt?.label === 'string' ? rawOpt.label.trim() : '').trim()
            if (safeLabel.length === 0 || safeLabel.length > ASK_OPTION_LABEL_MAX_CHARS) {
              return toolError(`Question "${id}" option "${val}" label must be 1-${ASK_OPTION_LABEL_MAX_CHARS} characters.`)
            }

            let safeDesc: string | undefined
            if (rawOpt?.description !== undefined) {
              const trimmedDesc = deps.redact(rawOpt.description.trim()).trim()
              if (trimmedDesc.length > ASK_OPTION_DESC_MAX_CHARS) {
                return toolError(`Question "${id}" option "${val}" description exceeds ${ASK_OPTION_DESC_MAX_CHARS} characters.`)
              }
              if (trimmedDesc !== '') safeDesc = trimmedDesc
            }

            normalizedOptions.push({
              value: val,
              label: safeLabel,
              ...(safeDesc !== undefined ? { description: safeDesc } : {}),
              ...(rawOpt.recommended === true ? { recommended: true } : {}),
            })
          }

          normalizedQuestions.push({
            id,
            question: safePrompt,
            type: qType,
            options: normalizedOptions,
            allowCustom,
            ...(safePlaceholder !== undefined ? { placeholder: safePlaceholder } : {}),
            required,
          })
          continue
        }

        if (qType === 'text') {
          if (rawQ?.options !== undefined) {
            return toolError(`Question "${id}" (text) cannot specify options.`)
          }
          if (rawQ?.allowCustom !== undefined) {
            return toolError(`Question "${id}" (text) cannot specify allowCustom.`)
          }
          if (rawQ?.confirmLabel !== undefined || rawQ?.rejectLabel !== undefined) {
            return toolError(`Question "${id}" (text) cannot specify confirmLabel or rejectLabel.`)
          }
          let safePlaceholder: string | undefined
          if (rawQ?.placeholder !== undefined) {
            const trimmedPh = deps.redact(rawQ.placeholder.trim()).trim()
            if (trimmedPh.length > ASK_PLACEHOLDER_MAX_CHARS) {
              return toolError(`Question "${id}" placeholder exceeds ${ASK_PLACEHOLDER_MAX_CHARS} characters.`)
            }
            if (trimmedPh !== '') safePlaceholder = trimmedPh
          }
          normalizedQuestions.push({
            id,
            question: safePrompt,
            type: 'text',
            ...(rawQ?.multiline === true ? { multiline: true } : {}),
            ...(safePlaceholder !== undefined ? { placeholder: safePlaceholder } : {}),
            required,
          })
          continue
        }

        // confirm
        if (rawQ?.options !== undefined || rawQ?.allowCustom !== undefined || rawQ?.multiline !== undefined || rawQ?.placeholder !== undefined) {
          return toolError(`Question "${id}" (confirm) cannot specify options, allowCustom, multiline, or placeholder.`)
        }
        let safeConfirmLabel: string | undefined
        if (rawQ?.confirmLabel !== undefined) {
          const trimmed = deps.redact(rawQ.confirmLabel.trim()).trim()
          if (trimmed.length === 0 || trimmed.length > ASK_CONFIRM_LABEL_MAX_CHARS) {
            return toolError(`Question "${id}" confirmLabel must be 1-${ASK_CONFIRM_LABEL_MAX_CHARS} characters.`)
          }
          safeConfirmLabel = trimmed
        }
        let safeRejectLabel: string | undefined
        if (rawQ?.rejectLabel !== undefined) {
          const trimmed = deps.redact(rawQ.rejectLabel.trim()).trim()
          if (trimmed.length === 0 || trimmed.length > ASK_CONFIRM_LABEL_MAX_CHARS) {
            return toolError(`Question "${id}" rejectLabel must be 1-${ASK_CONFIRM_LABEL_MAX_CHARS} characters.`)
          }
          safeRejectLabel = trimmed
        }
        normalizedQuestions.push({
          id,
          question: safePrompt,
          type: 'confirm',
          ...(safeConfirmLabel !== undefined ? { confirmLabel: safeConfirmLabel } : {}),
          ...(safeRejectLabel !== undefined ? { rejectLabel: safeRejectLabel } : {}),
          required,
        })
      }

      throwIfToolAborted(context.abortSignal)

      const askId = randomUUID()
      const fields: AskFieldSpec[] = normalizedQuestions.map((q): AskFieldSpec => {
        if (q.type === 'single_select' || q.type === 'multi_select') {
          return {
            name: q.id,
            label: q.question,
            type: 'choice',
            multiple: q.type === 'multi_select',
            allowCustom: q.allowCustom === true,
            required: q.required,
            ...(q.placeholder !== undefined ? { placeholder: q.placeholder } : {}),
            options: q.options!.map((o): AskFieldOption => ({
              value: o.value,
              label: o.label,
              ...(o.description !== undefined ? { description: o.description } : {}),
              ...(o.recommended === true ? { recommended: true } : {}),
            })),
          }
        }
        if (q.type === 'confirm') {
          return {
            name: q.id,
            label: q.question,
            type: 'confirm',
            required: q.required,
            ...(q.confirmLabel !== undefined ? { confirmLabel: q.confirmLabel } : {}),
            ...(q.rejectLabel !== undefined ? { rejectLabel: q.rejectLabel } : {}),
          }
        }
        return {
          name: q.id,
          label: q.question,
          type: 'text',
          required: q.required,
          ...(q.multiline === true ? { multiline: true } : {}),
          ...(q.placeholder !== undefined ? { placeholder: q.placeholder } : {}),
        }
      })

      const askSpec: AskCreateSpec = {
        id: askId,
        conversationId,
        ownerPluginId: ASK_USER_OWNER_ID,
        kind: 'question',
        title: explicitTitle !== undefined ? explicitTitle : { en: 'Clarifying Questions', 'zh-CN': '问题确认' },
        expectedStateSeq: conv.stateChangeSeq,
        fields,
      }

      let abortRaceReject: ((err: unknown) => void) | undefined
      const abortPromise = context.abortSignal
        ? new Promise<never>((_resolve, reject) => {
            abortRaceReject = reject
          })
        : undefined
      const onAbort = (): void => {
        void Promise.resolve()
          .then(() => deps.asks!.cancelAsk(askId, 'cancelled'))
          .catch(() => {
            abortRaceReject?.(context.abortSignal?.reason ?? new Error('aborted'))
          })
      }
      context.abortSignal?.addEventListener('abort', onAbort, { once: true })
      if (context.abortSignal?.aborted) {
        onAbort()
      }

      let askResult: AskResult
      try {
        askResult = await (abortPromise ? Promise.race([deps.asks.createAsk(askSpec), abortPromise]) : deps.asks.createAsk(askSpec))
      } catch (err) {
        context.abortSignal?.removeEventListener('abort', onAbort)
        throwIfToolAborted(context.abortSignal)
        return toolError(
          `Failed to ask user: ${deps.redact(err instanceof Error ? err.message : String(err))}`,
          {
            title: metaTitle,
            questionCount: normalizedQuestions.length,
            outcome: 'error',
          } as JsonValue,
        )
      } finally {
        context.abortSignal?.removeEventListener('abort', onAbort)
      }

      throwIfToolAborted(context.abortSignal)

      const questionCount = normalizedQuestions.length
      if (askResult.status === 'superseded') {
        return {
          output: [
            {
              type: 'text' as const,
              text: 'Question prompt was superseded because a new user message arrived or the conversation state changed (no structured answers were received). Do not treat this as confirmation; read the subsequent user message first and only ask again if required information is still missing.',
            },
          ],
          details: {
            title: metaTitle,
            questionCount,
            outcome: 'superseded',
          } as JsonValue,
        }
      }

      if (askResult.status === 'cancelled') {
        return {
          output: [{ type: 'text' as const, text: 'Question prompt was skipped or cancelled by the user.' }],
          details: {
            title: metaTitle,
            questionCount,
            outcome: 'cancelled',
          } as JsonValue,
        }
      }

      const lines: string[] = ['User answers:']
      const metaItems: Array<{ id: string; question: string; answer: string }> = []
      for (const q of normalizedQuestions) {
        const display = formatQuestionAnswer(q, askResult.answers[q.id], deps.redact)
        lines.push(`- ${q.id} (${q.question}): ${display}`)
        metaItems.push({
          id: q.id,
          question: q.question,
          answer: truncateChars(display, ASK_META_ANSWER_MAX_CHARS),
        })
      }

      return {
        output: [{ type: 'text' as const, text: lines.join('\n') }],
        details: {
          title: metaTitle,
          questionCount,
          outcome: 'answered',
          items: metaItems,
        } as JsonValue,
      }
    },
  })
}
