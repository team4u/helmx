/**
 * Kernel built-in `ask_user` tool: structured human-in-the-loop clarification questions
 * backed by `AskService` (top-level human-owned conversations only).
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { defineTool, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from '@earendil-works/pi-durable'
import { arr, bool, obj, oneOf, opt, str, type Static } from '@earendil-works/pi-schema'
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

type NormalizedOption = { value: string; label: string; description?: string; recommended?: boolean }

interface NormalizedQuestion {
  id: string
  question: string
  type: AskQuestionType
  options?: NormalizedOption[]
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

function toolError(message: string, details?: JsonValue): ToolExecutionResult {
  return {
    output: [{ type: 'text', text: message }],
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
/** One question as the schema admits it (already validated by the harness; normalization stays defensive anyway). */
type RawAskQuestion = Static<typeof askUserParameters>['questions'][number]

/** Step outcome of argument normalization: the accepted value, or the tool error to return verbatim. */
type Accepted<T> = { ok: true; value: T } | { ok: false; error: ToolExecutionResult }

function resolveAskConversation(deps: AskUserToolDeps, conversationId: number): Accepted<ConversationSummary> {
  let conv: ConversationSummary
  try {
    conv = deps.getConversation(conversationId)
  } catch (err) {
    return {
      ok: false,
      error: toolError(`ask_user_failed: ${deps.redact(err instanceof Error ? err.message : String(err))}`),
    }
  }
  if (!matchesConversationScope(ASK_USER_SCOPE, conv)) {
    return { ok: false, error: toolError('ask_user is only available in top-level human conversations.') }
  }
  return { ok: true, value: conv }
}

/** Redacted explicit title (`undefined` when omitted); the raw and the redacted title are each length-checked. */
function resolveAskTitle(deps: AskUserToolDeps, rawTitleArg: string | undefined): Accepted<string | undefined> {
  const rawTitle = typeof rawTitleArg === 'string' ? rawTitleArg.trim() : ''
  if (rawTitleArg !== undefined && (rawTitle.length === 0 || rawTitle.length > ASK_TITLE_MAX_CHARS)) {
    return { ok: false, error: toolError(`ask_user title must be 1-${ASK_TITLE_MAX_CHARS} characters when provided.`) }
  }
  const explicitTitle = rawTitle !== '' ? deps.redact(rawTitle).trim() : undefined
  if (rawTitle !== '' && (explicitTitle === undefined || explicitTitle.length === 0 || explicitTitle.length > ASK_TITLE_MAX_CHARS)) {
    return { ok: false, error: toolError(`ask_user title after redaction must be 1-${ASK_TITLE_MAX_CHARS} characters.`) }
  }
  return { ok: true, value: explicitTitle }
}

function normalizeQuestions(deps: AskUserToolDeps, rawQuestions: RawAskQuestion[] | undefined): Accepted<NormalizedQuestion[]> {
  if (!Array.isArray(rawQuestions) || rawQuestions.length < 1 || rawQuestions.length > ASK_MAX_QUESTIONS) {
    return { ok: false, error: toolError(`ask_user requires 1-${ASK_MAX_QUESTIONS} questions.`) }
  }
  const questionIds = new Set<string>()
  const normalized: NormalizedQuestion[] = []
  for (const rawQ of rawQuestions) {
    const question = normalizeQuestion(deps, rawQ, questionIds)
    if (!question.ok) return question
    normalized.push(question.value)
  }
  return { ok: true, value: normalized }
}

/** Type-independent part of a question (identity + prompt), validated before any type-specific rule. */
interface QuestionBase {
  id: string
  question: string
  required: boolean
}

function normalizeQuestion(deps: AskUserToolDeps, rawQ: RawAskQuestion, questionIds: Set<string>): Accepted<NormalizedQuestion> {
  const base = normalizeQuestionBase(deps, rawQ, questionIds)
  if (!base.ok) return base
  const { type, ...identity } = base.value
  if (type === 'single_select' || type === 'multi_select') return normalizeSelectionQuestion(deps, rawQ, identity, type)
  if (type === 'text') return normalizeTextQuestion(deps, rawQ, identity)
  return normalizeConfirmQuestion(deps, rawQ, identity)
}

function normalizeQuestionBase(
  deps: AskUserToolDeps,
  rawQ: RawAskQuestion,
  questionIds: Set<string>,
): Accepted<QuestionBase & { type: AskQuestionType }> {
  const id = typeof rawQ?.id === 'string' ? rawQ.id.trim() : ''
  if (!QUESTION_ID_RE.test(id)) {
    return { ok: false, error: toolError(`Invalid ask_user question id "${id}": must match /^[A-Za-z0-9_-]{1,40}$/.`) }
  }
  if (questionIds.has(id)) {
    return { ok: false, error: toolError(`Duplicate ask_user question id: "${id}".`) }
  }
  questionIds.add(id)
  const rawPrompt = typeof rawQ?.question === 'string' ? rawQ.question.trim() : ''
  const safePrompt = deps.redact(rawPrompt).trim()
  if (safePrompt.length === 0 || safePrompt.length > ASK_QUESTION_MAX_CHARS) {
    return { ok: false, error: toolError(`Question "${id}" prompt must be 1-${ASK_QUESTION_MAX_CHARS} characters.`) }
  }
  return {
    ok: true,
    value: {
      id,
      question: safePrompt,
      required: rawQ?.required ?? true,
      // Selection questions default to single_select when options are given; everything else is open text.
      type: rawQ?.type ?? (rawQ?.options !== undefined ? 'single_select' : 'text'),
    },
  }
}

/** Redacted optional placeholder; a blank placeholder collapses to `undefined`, over-long ones are rejected. */
function normalizePlaceholder(deps: AskUserToolDeps, rawPlaceholder: string | undefined, id: string): Accepted<string | undefined> {
  if (rawPlaceholder === undefined) return { ok: true, value: undefined }
  const trimmed = deps.redact(rawPlaceholder.trim()).trim()
  if (trimmed.length > ASK_PLACEHOLDER_MAX_CHARS) {
    return { ok: false, error: toolError(`Question "${id}" placeholder exceeds ${ASK_PLACEHOLDER_MAX_CHARS} characters.`) }
  }
  return { ok: true, value: trimmed !== '' ? trimmed : undefined }
}

function normalizeSelectionQuestion(
  deps: AskUserToolDeps,
  rawQ: RawAskQuestion,
  base: QuestionBase,
  type: 'single_select' | 'multi_select',
): Accepted<NormalizedQuestion> {
  const { id } = base
  if (rawQ?.multiline !== undefined) {
    return { ok: false, error: toolError(`Question "${id}" (${type}) cannot set multiline.`) }
  }
  if (rawQ?.confirmLabel !== undefined || rawQ?.rejectLabel !== undefined) {
    return { ok: false, error: toolError(`Question "${id}" (${type}) cannot set confirmLabel or rejectLabel.`) }
  }
  if (!Array.isArray(rawQ?.options) || rawQ.options.length < ASK_MIN_OPTIONS || rawQ.options.length > ASK_MAX_OPTIONS) {
    return { ok: false, error: toolError(`Question "${id}" (${type}) must provide ${ASK_MIN_OPTIONS}-${ASK_MAX_OPTIONS} options.`) }
  }
  const allowCustom = rawQ?.allowCustom ?? true
  if (rawQ?.placeholder !== undefined && !allowCustom) {
    return { ok: false, error: toolError(`Question "${id}" placeholder is only allowed when allowCustom is true.`) }
  }
  const placeholder = normalizePlaceholder(deps, rawQ?.placeholder, id)
  if (!placeholder.ok) return placeholder
  const options = normalizeOptions(deps, rawQ.options, id)
  if (!options.ok) return options
  return {
    ok: true,
    value: {
      id,
      question: base.question,
      type,
      options: options.value,
      allowCustom,
      ...(placeholder.value !== undefined ? { placeholder: placeholder.value } : {}),
      required: base.required,
    },
  }
}

function normalizeOptions(
  deps: AskUserToolDeps,
  rawOptions: NonNullable<RawAskQuestion['options']>,
  questionId: string,
): Accepted<NormalizedOption[]> {
  const optValues = new Set<string>()
  const normalizedOptions: NormalizedOption[] = []
  for (const rawOpt of rawOptions) {
    const option = normalizeOption(deps, rawOpt, questionId, optValues)
    if (!option.ok) return option
    normalizedOptions.push(option.value)
  }
  return { ok: true, value: normalizedOptions }
}

function normalizeOption(
  deps: AskUserToolDeps,
  rawOpt: NonNullable<RawAskQuestion['options']>[number],
  questionId: string,
  optValues: Set<string>,
): Accepted<NormalizedOption> {
  const val = typeof rawOpt?.value === 'string' ? rawOpt.value.trim() : ''
  if (val === '' || val.length > ASK_OPTION_VALUE_MAX_CHARS) {
    return { ok: false, error: toolError(`Question "${questionId}" option value must be 1-${ASK_OPTION_VALUE_MAX_CHARS} characters.`) }
  }
  if (optValues.has(val)) {
    return { ok: false, error: toolError(`Question "${questionId}" has duplicate option value "${val}".`) }
  }
  optValues.add(val)
  const safeLabel = deps.redact(typeof rawOpt?.label === 'string' ? rawOpt.label.trim() : '').trim()
  if (safeLabel.length === 0 || safeLabel.length > ASK_OPTION_LABEL_MAX_CHARS) {
    return { ok: false, error: toolError(`Question "${questionId}" option "${val}" label must be 1-${ASK_OPTION_LABEL_MAX_CHARS} characters.`) }
  }
  const rawDesc = rawOpt?.description
  let safeDesc: string | undefined
  if (rawDesc !== undefined) {
    const trimmedDesc = deps.redact(rawDesc.trim()).trim()
    if (trimmedDesc.length > ASK_OPTION_DESC_MAX_CHARS) {
      return { ok: false, error: toolError(`Question "${questionId}" option "${val}" description exceeds ${ASK_OPTION_DESC_MAX_CHARS} characters.`) }
    }
    if (trimmedDesc !== '') safeDesc = trimmedDesc
  }
  return {
    ok: true,
    value: {
      value: val,
      label: safeLabel,
      ...(safeDesc !== undefined ? { description: safeDesc } : {}),
      ...(rawOpt.recommended === true ? { recommended: true } : {}),
    },
  }
}

function normalizeTextQuestion(deps: AskUserToolDeps, rawQ: RawAskQuestion, base: QuestionBase): Accepted<NormalizedQuestion> {
  const { id } = base
  if (rawQ?.options !== undefined) {
    return { ok: false, error: toolError(`Question "${id}" (text) cannot specify options.`) }
  }
  if (rawQ?.allowCustom !== undefined) {
    return { ok: false, error: toolError(`Question "${id}" (text) cannot specify allowCustom.`) }
  }
  if (rawQ?.confirmLabel !== undefined || rawQ?.rejectLabel !== undefined) {
    return { ok: false, error: toolError(`Question "${id}" (text) cannot specify confirmLabel or rejectLabel.`) }
  }
  const placeholder = normalizePlaceholder(deps, rawQ?.placeholder, id)
  if (!placeholder.ok) return placeholder
  return {
    ok: true,
    value: {
      id,
      question: base.question,
      type: 'text',
      ...(rawQ?.multiline === true ? { multiline: true } : {}),
      ...(placeholder.value !== undefined ? { placeholder: placeholder.value } : {}),
      required: base.required,
    },
  }
}

/** Redacted custom button label for confirm questions (1-40 chars). */
function normalizeButtonLabel(
  deps: AskUserToolDeps,
  rawLabel: string | undefined,
  id: string,
  attr: 'confirmLabel' | 'rejectLabel',
): Accepted<string | undefined> {
  if (rawLabel === undefined) return { ok: true, value: undefined }
  const trimmed = deps.redact(rawLabel.trim()).trim()
  if (trimmed.length === 0 || trimmed.length > ASK_CONFIRM_LABEL_MAX_CHARS) {
    return { ok: false, error: toolError(`Question "${id}" ${attr} must be 1-${ASK_CONFIRM_LABEL_MAX_CHARS} characters.`) }
  }
  return { ok: true, value: trimmed }
}

function normalizeConfirmQuestion(deps: AskUserToolDeps, rawQ: RawAskQuestion, base: QuestionBase): Accepted<NormalizedQuestion> {
  const { id } = base
  if (rawQ?.options !== undefined || rawQ?.allowCustom !== undefined || rawQ?.multiline !== undefined || rawQ?.placeholder !== undefined) {
    return { ok: false, error: toolError(`Question "${id}" (confirm) cannot specify options, allowCustom, multiline, or placeholder.`) }
  }
  const confirmLabel = normalizeButtonLabel(deps, rawQ?.confirmLabel, id, 'confirmLabel')
  if (!confirmLabel.ok) return confirmLabel
  const rejectLabel = normalizeButtonLabel(deps, rawQ?.rejectLabel, id, 'rejectLabel')
  if (!rejectLabel.ok) return rejectLabel
  return {
    ok: true,
    value: {
      id,
      question: base.question,
      type: 'confirm',
      ...(confirmLabel.value !== undefined ? { confirmLabel: confirmLabel.value } : {}),
      ...(rejectLabel.value !== undefined ? { rejectLabel: rejectLabel.value } : {}),
      required: base.required,
    },
  }
}

function toAskFields(questions: readonly NormalizedQuestion[]): AskFieldSpec[] {
  return questions.map((q): AskFieldSpec => {
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
}

/**
 * Create the ask and race it against the tool's abort signal: on abort the ask is cancelled and the race rejects
 * so the tool ends promptly. An abort surfaces as a thrown error (`throwIfToolAborted`); any other failure is
 * returned raw for the caller to report.
 */
async function submitAsk(
  asks: Pick<AskService, 'createAsk' | 'cancelAsk'>,
  context: Context,
  askSpec: AskCreateSpec & { id: string },
): Promise<{ ok: true; result: AskResult } | { ok: false; error: unknown }> {
  const askId = askSpec.id
  let abortRaceReject: ((err: unknown) => void) | undefined
  const abortPromise = context.abortSignal
    ? new Promise<never>((_resolve, reject) => {
        abortRaceReject = reject
      })
    : undefined
  const onAbort = (): void => {
    void Promise.resolve()
      .then(() => asks.cancelAsk(askId, 'cancelled'))
      .catch(() => {
        abortRaceReject?.(context.abortSignal?.reason ?? new Error('aborted'))
      })
  }
  context.abortSignal?.addEventListener('abort', onAbort, { once: true })
  if (context.abortSignal?.aborted) {
    onAbort()
  }
  try {
    const result = await (abortPromise ? Promise.race([asks.createAsk(askSpec), abortPromise]) : asks.createAsk(askSpec))
    return { ok: true, result }
  } catch (error) {
    throwIfToolAborted(context.abortSignal)
    return { ok: false, error }
  } finally {
    context.abortSignal?.removeEventListener('abort', onAbort)
  }
}

/** UI channel metadata shared by every non-abort outcome (`ARTIFACT`-style details for the Web AskDock card). */
interface AskOutcomeMeta {
  title: string
  questionCount: number
}

/** Terminal outcome other than a thrown abort: superseded / cancelled carry guidance text, answered carries the answers. */
function formatAskOutcome(
  result: AskResult,
  questions: readonly NormalizedQuestion[],
  meta: AskOutcomeMeta,
  redact: (text: string) => string,
): ToolExecutionResult {
  if (result.status === 'superseded') {
    return {
      output: [
        {
          type: 'text',
          text: 'Question prompt was superseded because a new user message arrived or the conversation state changed (no structured answers were received). Do not treat this as confirmation; read the subsequent user message first and only ask again if required information is still missing.',
        },
      ],
      details: { ...meta, outcome: 'superseded' } as JsonValue,
    }
  }
  if (result.status === 'cancelled') {
    return {
      output: [{ type: 'text', text: 'Question prompt was skipped or cancelled by the user.' }],
      details: { ...meta, outcome: 'cancelled' } as JsonValue,
    }
  }
  const lines: string[] = ['User answers:']
  const metaItems: Array<{ id: string; question: string; answer: string }> = []
  for (const q of questions) {
    const display = formatQuestionAnswer(q, result.answers[q.id], redact)
    lines.push(`- ${q.id} (${q.question}): ${display}`)
    metaItems.push({
      id: q.id,
      question: q.question,
      answer: truncateChars(display, ASK_META_ANSWER_MAX_CHARS),
    })
  }
  return {
    output: [{ type: 'text', text: lines.join('\n') }],
    details: { ...meta, outcome: 'answered', items: metaItems } as JsonValue,
  }
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
      const conversation = resolveAskConversation(deps, api.conversationId)
      if (!conversation.ok) return conversation.error
      const title = resolveAskTitle(deps, args?.title)
      if (!title.ok) return title.error
      const explicitTitle = title.value
      const questions = normalizeQuestions(deps, args?.questions)
      if (!questions.ok) return questions.error
      const normalizedQuestions = questions.value
      throwIfToolAborted(context.abortSignal)

      const meta: AskOutcomeMeta = { title: explicitTitle ?? 'Clarifying Questions', questionCount: normalizedQuestions.length }
      const askSpec: AskCreateSpec & { id: string } = {
        id: randomUUID(),
        conversationId: api.conversationId,
        ownerPluginId: ASK_USER_OWNER_ID,
        kind: 'question',
        title: explicitTitle !== undefined ? explicitTitle : { en: 'Clarifying Questions', 'zh-CN': '问题确认' },
        expectedStateSeq: conversation.value.stateChangeSeq,
        fields: toAskFields(normalizedQuestions),
      }
      const submitted = await submitAsk(deps.asks, context, askSpec)
      if (!submitted.ok) {
        return toolError(`Failed to ask user: ${deps.redact(submitted.error instanceof Error ? submitted.error.message : String(submitted.error))}`, {
          ...meta,
          outcome: 'error',
        } as JsonValue)
      }
      throwIfToolAborted(context.abortSignal)
      return formatAskOutcome(submitted.result, normalizedQuestions, meta, deps.redact)
    },
  })
}
