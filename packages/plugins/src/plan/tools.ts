/**
 * builtin:plan model tools (`plan_save`, `plan_propose`, `plan_ask`, and `plan_bash`).
 */
import { randomUUID } from 'node:crypto'
import {
  HelmxError,
  type AskCreateSpec,
  type AskFieldSpec,
  type AskResult,
  type HelmxPluginContext,
  type PluginToolResultEnvelope,
} from '@helmx/protocol'
import {
  PLAN_ASK_MAX_OPTIONS,
  PLAN_ASK_MAX_QUESTIONS,
  PLAN_ASK_MIN_OPTIONS,
  PLAN_ASK_OPTION_DESC_MAX_CHARS,
  PLAN_ASK_OPTION_LABEL_MAX_CHARS,
  PLAN_ASK_QUESTION_MAX_CHARS,
  PLAN_BASH_DEFAULT_TIMEOUT_MS,
  PLAN_BASH_MAX_TIMEOUT_MS,
  PLAN_HANDOFF_MAX_BYTES,
  PLAN_MARKDOWN_MAX_BYTES,
  PLAN_PLUGIN_ID,
  PLAN_SUMMARY_MAX_CHARS,
  PLAN_TITLE_MAX_CHARS,
  PLAN_TOOL_ASK,
  PLAN_TOOL_BASH,
  PLAN_TOOL_META_SCHEMA,
  PLAN_TOOL_PROPOSE,
  PLAN_TOOL_SAVE,
  isPlanConversationEligible,
  validateAndRedactPlanDraft,
  type PlanApprovedInfo,
  type PlanAskKind,
  type PlanConversationRecord,
  type PlanDraftSummary,
  type PlanToolPresentationMeta,
} from './contracts.js'
import { validateReadOnlyShellCommand } from './read-only-shell.js'
import type { PlanStateManager } from './state.js'

const utf8Encoder = new TextEncoder()
const ASK_QUESTION_ID_RE = /^[A-Za-z0-9_-]{1,40}$/

interface PlanAskOptionInput {
  value: string
  label: string
  description?: string
}

interface PlanAskQuestionInput {
  id: string
  question: string
  options: PlanAskOptionInput[]
}

interface PlanAskInput {
  title?: string
  questions: PlanAskQuestionInput[]
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toolError(
  message: string,
  presentationMeta?: PlanToolPresentationMeta,
): PluginToolResultEnvelope {
  return {
    output: message,
    isError: true,
    ...(presentationMeta !== undefined ? { presentationMeta } : {}),
  }
}

/** Truncate UTF-8 text cleanly without splitting multi-byte sequences or surrogate pairs. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let end = 0
  let used = 0
  for (const ch of text) {
    const bytes = Buffer.byteLength(ch, 'utf8')
    if (used + bytes > maxBytes) break
    used += bytes
    end += ch.length
  }
  return text.slice(0, end)
}

function buildHandoffText(params: {
  draft: PlanDraftSummary
  artifactId: string
  artifactName: string
  feedback: string
  executionModel?: string
  redact: (text: string) => string
}): string {
  const { draft, artifactId, artifactName, feedback, executionModel, redact } = params
  const headerLines = [
    `Approved Plan v${draft.version}: ${draft.title}`,
    `Artifact: ${artifactName} (id: ${artifactId})`,
    ...(executionModel !== undefined ? [`Execution Model: ${executionModel}`] : []),
  ]
  const footer = 'Execute the approved plan above carefully and verify your changes.'
  const baseBody = `${headerLines.join('\n')}\n\n${draft.markdown}\n\n${footer}`

  if (feedback === '') {
    return truncateUtf8(redact(baseBody), PLAN_HANDOFF_MAX_BYTES)
  }

  const feedbackHeading = 'User Feedback:\n'
  const overheadBytes =
    Buffer.byteLength(baseBody, 'utf8') + Buffer.byteLength(`\n\n${feedbackHeading}`, 'utf8')
  const budget = PLAN_HANDOFF_MAX_BYTES - overheadBytes
  let safeFeedback = feedback
  if (Buffer.byteLength(safeFeedback, 'utf8') > budget) {
    const marker = '\n[feedback truncated to fit 128 KiB handoff limit]'
    const markerBytes = Buffer.byteLength(marker, 'utf8')
    safeFeedback =
      budget > markerBytes
        ? `${truncateUtf8(safeFeedback, budget - markerBytes)}${marker}`
        : ''
  }

  const full =
    safeFeedback !== ''
      ? `${headerLines.join('\n')}\n${feedbackHeading}${safeFeedback}\n\n${draft.markdown}\n\n${footer}`
      : baseBody
  return truncateUtf8(redact(full), PLAN_HANDOFF_MAX_BYTES)
}

async function awaitPlanAsk(params: {
  ctx: HelmxPluginContext
  state: PlanStateManager
  conversationId: number
  askId: string
  askSpec: AskCreateSpec
  signal: AbortSignal | undefined
  onSettled: (
    outcome:
      | { ok: true; askResult: AskResult; latest: PlanConversationRecord | undefined; clearPendingOnly: () => Promise<void> }
      | { ok: false; error: unknown; latest: PlanConversationRecord | undefined; clearPendingOnly: () => Promise<void> },
  ) => Promise<PluginToolResultEnvelope>
}): Promise<PluginToolResultEnvelope> {
  const { ctx, state, conversationId, askId, askSpec, signal, onSettled } = params

  const runPromise = (async (): Promise<PluginToolResultEnvelope> => {
    const onAbort = () => {
      void state.cancelAskSafe(askId, 'cancelled').catch(() => {})
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
    }

    let askResult: AskResult | undefined
    let createAskError: unknown
    let hasCreateAskError = false
    try {
      askResult = await ctx.host.createAsk(askSpec)
    } catch (err) {
      hasCreateAskError = true
      createAskError = err
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }

    return state.enqueueConversation(conversationId, async () => {
      const latest = state.getRecord(conversationId)
      const clearPendingOnly = async (): Promise<void> => {
        if (latest === undefined || latest.pendingAskId !== askId) return
        const { pendingAskId: _cleared, pendingAskKind: _clearedKind, ...rest } = latest
        state.writeRecord(conversationId, rest)
        await state.flushKv()
        state.syncProjections(conversationId, rest)
      }

      if (hasCreateAskError || askResult === undefined) {
        return onSettled({ ok: false, error: createAskError, latest, clearPendingOnly })
      }
      return onSettled({ ok: true, askResult, latest, clearPendingOnly })
    })
  })()

  state.trackInFlightAsk(askId, conversationId, runPromise)
  let result: PluginToolResultEnvelope | undefined
  let runErr: unknown
  let hasRunErr = false
  try {
    result = await runPromise
  } catch (err) {
    runErr = err
    hasRunErr = true
  }

  state.deleteInFlightAsk(askId)
  try {
    await state.enqueueConversation(conversationId, async () => {
      const latest = state.getRecord(conversationId)
      if (latest?.pendingAskId === askId) {
        const { pendingAskId: _cleared, pendingAskKind: _clearedKind, ...rest } = latest
        state.writeRecord(conversationId, rest)
        await state.flushKv()
        state.syncProjections(conversationId, rest)
      }
    })
  } catch (cleanupErr) {
    const ignorableCleanupError =
      cleanupErr instanceof HelmxError &&
      (cleanupErr.code === 'plugin_context_closed' || cleanupErr.status === 404)
    if (!ignorableCleanupError && !hasRunErr) {
      throw cleanupErr
    }
  }

  if (hasRunErr) {
    throw runErr
  }
  return result as PluginToolResultEnvelope
}

async function preparePlanningAsk(params: {
  ctx: HelmxPluginContext
  state: PlanStateManager
  conversationId: number
  kind: PlanAskKind
  toolName: string
  requireDraft?: boolean
}): Promise<
  | { ok: true; askId: string; expectedStateSeq: number; current: PlanConversationRecord }
  | { ok: false; result: PluginToolResultEnvelope }
> {
  const { ctx, state, conversationId, kind, toolName, requireDraft } = params
  return state.enqueueConversation(conversationId, async () => {
    if (state.isStopping()) {
      return {
        ok: false as const,
        result: toolError(`builtin:plan is stopping; cannot run ${toolName}.`),
      }
    }
    const conv = ctx.host.getConversation(conversationId)
    if (!isPlanConversationEligible(conv)) {
      return {
        ok: false as const,
        result: toolError(`${toolName} is only allowed in top-level human conversations.`),
      }
    }
    const current = state.getRecord(conversationId)
    if ((current?.mode ?? 'normal') !== 'planning') {
      return {
        ok: false as const,
        result: toolError(`${toolName} is only allowed while in planning mode.`),
      }
    }
    if (requireDraft && current?.draft === undefined) {
      return {
        ok: false as const,
        result: toolError(`No plan draft exists yet. Call \`${PLAN_TOOL_SAVE}\` first.`),
      }
    }
    if (current!.pendingAskId !== undefined || state.hasInFlightAsk(conversationId)) {
      const activeMeta: PlanToolPresentationMeta | undefined =
        kind === 'propose' && current?.draft !== undefined
          ? {
              kind: 'propose',
              title: current.draft.title,
              version: current.draft.version,
              outcome: 'error',
            }
          : undefined
      return {
        ok: false as const,
        result: toolError(
          `A plan ask (${current!.pendingAskId ?? 'in-flight'}) is already pending for this conversation.`,
          activeMeta,
        ),
      }
    }

    const askId = randomUUID()
    const nextRecord: PlanConversationRecord = {
      ...current!,
      conversationId,
      mode: 'planning',
      pendingAskId: askId,
      pendingAskKind: kind,
    }
    state.writeRecord(conversationId, nextRecord)
    try {
      await state.flushKv()
    } catch (err) {
      state.writeRecord(conversationId, current!)
      throw err
    }
    state.syncProjections(conversationId, nextRecord)
    return {
      ok: true as const,
      askId,
      expectedStateSeq: conv.stateChangeSeq,
      current: nextRecord,
    }
  })
}

export function registerPlanTools(
  ctx: HelmxPluginContext,
  state: PlanStateManager,
  getExecutionModel: () => string | undefined,
): void {
  ctx.tool<{ title: string; markdown: string }>({
    name: PLAN_TOOL_SAVE,
    description:
      'Save or update the current plan draft (plan mode only, top-level human conversations only).',
    promptGuidelines: [
      'Use plan_save only while in plan mode to record or refine a self-contained implementation plan before calling plan_propose.',
    ],
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          minLength: 1,
          maxLength: PLAN_TITLE_MAX_CHARS,
          description: `Concise plan title (1-${PLAN_TITLE_MAX_CHARS} characters)`,
        },
        markdown: {
          type: 'string',
          minLength: 1,
          description: `Full self-contained implementation plan in Markdown (1-${PLAN_MARKDOWN_MAX_BYTES} UTF-8 bytes)`,
        },
      },
      required: ['title', 'markdown'],
      additionalProperties: false,
    },
    presentationMetaSchema: PLAN_TOOL_META_SCHEMA,
    async execute(input, context): Promise<PluginToolResultEnvelope> {
      const validated = validateAndRedactPlanDraft(
        input?.title,
        input?.markdown,
        (text) => ctx.host.redact(text),
      )
      if (!validated.ok) {
        return toolError(validated.message)
      }
      const { title, markdown } = validated

      const conversationId = context.conversationId
      return state.enqueueConversation(conversationId, async () => {
        if (state.isStopping()) {
          return toolError('builtin:plan is stopping; cannot save plan draft.')
        }
        const conv = ctx.host.getConversation(conversationId)
        if (!isPlanConversationEligible(conv)) {
          return toolError('plan_save is only allowed in top-level human conversations.')
        }
        const current = state.getRecord(conversationId)
        if ((current?.mode ?? 'normal') !== 'planning') {
          return toolError('plan_save is only allowed while in planning mode.')
        }

        const nextVersion = (current?.draft?.version ?? 0) + 1
        const draft: PlanDraftSummary = {
          title,
          markdown,
          version: nextVersion,
          updatedAt: Date.now(),
        }
        const nextRecord: PlanConversationRecord = {
          ...current,
          conversationId,
          mode: 'planning',
          draft,
        }
        state.writeRecord(conversationId, nextRecord)
        try {
          await state.flushKv()
        } catch (err) {
          if (current !== undefined) state.writeRecord(conversationId, current)
          else state.deleteRecord(conversationId)
          throw err
        }
        state.syncProjections(conversationId, nextRecord)

        const lineCount = markdown.split(/\r?\n/).length
        const charCount = markdown.length
        const presentationMeta: PlanToolPresentationMeta = {
          kind: 'save',
          title,
          version: nextVersion,
          lineCount,
          charCount,
        }
        return {
          output: `Saved plan draft v${nextVersion}: "${title}" (${lineCount} lines, ${charCount} chars). Call \`${PLAN_TOOL_PROPOSE}\` when ready for user approval.`,
          presentationMeta,
        }
      })
    },
  })

  ctx.tool<{ summary: string }>({
    name: PLAN_TOOL_PROPOSE,
    description:
      'Submit the current saved plan draft for human approval via AskDoc (plan mode only).',
    promptGuidelines: [
      'Call plan_propose only after saving a self-contained draft with plan_save; pass a concise plain-text summary (1-300 chars, no code fences).',
    ],
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          minLength: 1,
          maxLength: PLAN_SUMMARY_MAX_CHARS,
          description: `Concise plain-text summary of the proposed plan (1-${PLAN_SUMMARY_MAX_CHARS} chars, no triple-backtick code fences)`,
        },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    presentationMetaSchema: PLAN_TOOL_META_SCHEMA,
    async execute(input, context): Promise<PluginToolResultEnvelope> {
      const rawSummary = typeof input?.summary === 'string' ? input.summary.trim() : ''
      if (rawSummary.length === 0 || rawSummary.length > PLAN_SUMMARY_MAX_CHARS) {
        return toolError(
          `plan_propose summary must be a non-empty string within ${PLAN_SUMMARY_MAX_CHARS} characters.`,
        )
      }
      if (rawSummary.includes('```')) {
        return toolError(
          'plan_propose summary must be plain text without triple-backtick code fences (```).',
        )
      }
      const safeSummary = ctx.host.redact(rawSummary).trim()
      if (
        safeSummary.length === 0 ||
        safeSummary.length > PLAN_SUMMARY_MAX_CHARS ||
        safeSummary.includes('```')
      ) {
        return toolError(
          `plan_propose summary after redaction must be 1-${PLAN_SUMMARY_MAX_CHARS} plain-text characters without code fences.`,
        )
      }
      if (context.signal?.aborted) {
        return toolError('plan_propose aborted before creating approval prompt.')
      }

      const conversationId = context.conversationId
      const prepared = await preparePlanningAsk({
        ctx,
        state,
        conversationId,
        kind: 'propose',
        toolName: PLAN_TOOL_PROPOSE,
        requireDraft: true,
      })
      if (!prepared.ok) {
        return prepared.result
      }

      const { askId, expectedStateSeq, current } = prepared
      const draft = current.draft!
      const configuredExecutionModel = getExecutionModel()

      const askSpec: AskCreateSpec = {
        id: askId,
        conversationId,
        ownerPluginId: PLAN_PLUGIN_ID,
        title: {
          en: `Plan Approval v${draft.version}: ${draft.title}`,
          'zh-CN': `计划审批 v${draft.version}：${draft.title}`,
        },
        description: safeSummary,
        hint: {
          en: 'Tip: To request changes, you can also reply directly in the composer below.',
          'zh-CN': '提示：如需修改计划，也可直接在下方输入框发送意见。',
        },
        expectedStateSeq,
        fields: [
          {
            name: 'decision',
            label: { en: 'Decision', 'zh-CN': '审批决定' },
            type: 'choice',
            required: true,
            defaultValue: 'approve_handoff',
            options: [
              {
                value: 'approve_handoff',
                label: { en: 'Approve & start fresh context', 'zh-CN': '批准并在新上下文执行' },
                description: {
                  en: 'Recommended — archive plan and start execution with a clean context',
                  'zh-CN': '推荐 — 归档计划并以干净上下文开始执行',
                },
              },
              {
                value: 'approve',
                label: { en: 'Approve & keep current context', 'zh-CN': '批准并在当前上下文继续' },
              },
              {
                value: 'revise',
                label: { en: 'Request revisions', 'zh-CN': '退回修改' },
              },
            ],
          },
          {
            name: 'executionModel',
            label: { en: 'Execution model (optional)', 'zh-CN': '执行模型（可选）' },
            type: 'model',
            required: false,
            defaultValue: configuredExecutionModel ?? '',
          },
          {
            name: 'feedback',
            label: { en: 'Additional notes (optional)', 'zh-CN': '补充说明（可选）' },
            type: 'text',
            required: false,
          },
        ],
      }

      return awaitPlanAsk({
        ctx,
        state,
        conversationId,
        askId,
        askSpec,
        signal: context.signal,
        async onSettled(settled) {
          const effectiveDraft = settled.latest?.draft ?? draft

          if (!settled.ok) {
            await settled.clearPendingOnly()
            return toolError(
              `Failed to create plan approval ask: ${ctx.host.redact(errorMessageOf(settled.error))}`,
              {
                kind: 'propose',
                title: effectiveDraft.title,
                version: effectiveDraft.version,
                outcome: 'error',
              },
            )
          }

          const { askResult, latest, clearPendingOnly } = settled

          if (askResult.status === 'superseded') {
            await clearPendingOnly()
            return {
              output:
                'Plan proposal was superseded because the conversation state changed before approval. Review the latest state and propose again when ready.',
              presentationMeta: {
                kind: 'propose',
                title: effectiveDraft.title,
                version: effectiveDraft.version,
                outcome: 'superseded',
              },
            }
          }

          if (askResult.status === 'cancelled') {
            await clearPendingOnly()
            const exited = latest === undefined || latest.mode === 'normal'
            return {
              output: exited
                ? 'Plan proposal was cancelled and plan mode was exited.'
                : 'Plan proposal was cancelled. Remaining in plan mode so you can revise or ask the user how to proceed.',
              presentationMeta: {
                kind: 'propose',
                title: effectiveDraft.title,
                version: effectiveDraft.version,
                outcome: 'cancelled',
              },
            }
          }

          const decision = askResult.answers['decision'] ?? ''
          const rawFeedback = askResult.answers['feedback'] ?? ''
          const feedback = ctx.host.redact(rawFeedback).trim()
          const rawSelectedModel = askResult.answers['executionModel']
          const selectedModel =
            typeof rawSelectedModel === 'string' && rawSelectedModel.trim() !== ''
              ? ctx.host.redact(rawSelectedModel.trim()).trim()
              : undefined

          if (decision === 'revise') {
            await clearPendingOnly()
            return {
              output:
                feedback !== ''
                  ? `User requested revisions to plan v${effectiveDraft.version} ("${effectiveDraft.title}"):\n${feedback}\n\nUpdate the draft via \`${PLAN_TOOL_SAVE}\` and call \`${PLAN_TOOL_PROPOSE}\` again.`
                  : `User requested revisions to plan v${effectiveDraft.version} ("${effectiveDraft.title}"). Clarify any needed details or update the draft via \`${PLAN_TOOL_SAVE}\`.`,
              presentationMeta: {
                kind: 'propose',
                title: effectiveDraft.title,
                version: effectiveDraft.version,
                outcome: 'revised',
              },
            }
          }

          if (decision !== 'approve' && decision !== 'approve_handoff') {
            await clearPendingOnly()
            return toolError(`Unsupported plan approval decision: ${String(decision)}`, {
              kind: 'propose',
              title: effectiveDraft.title,
              version: effectiveDraft.version,
              outcome: 'error',
            })
          }

          let appliedExecutionModel: string | undefined
          if (selectedModel !== undefined) {
            try {
              await ctx.host.updateConversation(conversationId, { model: selectedModel })
              appliedExecutionModel = selectedModel
            } catch (err) {
              await clearPendingOnly()
              return toolError(
                `Failed to switch conversation model to "${selectedModel}": ${ctx.host.redact(errorMessageOf(err))}. Staying in planning mode.`,
                {
                  kind: 'propose',
                  title: effectiveDraft.title,
                  version: effectiveDraft.version,
                  outcome: 'error',
                  executionModel: selectedModel,
                },
              )
            }
          }

          const artifactName = `plan-v${effectiveDraft.version}.md`
          let artifact: Awaited<ReturnType<typeof ctx.host.createArtifact>>
          try {
            artifact = await ctx.host.createArtifact(conversationId, {
              name: artifactName,
              bytes: utf8Encoder.encode(effectiveDraft.markdown),
              mimeType: 'text/markdown',
            })
          } catch (err) {
            await clearPendingOnly()
            return toolError(
              `Failed to save approved plan artifact ${artifactName}: ${ctx.host.redact(errorMessageOf(err))}. Staying in planning mode.`,
              {
                kind: 'propose',
                title: effectiveDraft.title,
                version: effectiveDraft.version,
                outcome: 'error',
                ...(appliedExecutionModel !== undefined
                  ? { executionModel: appliedExecutionModel }
                  : {}),
              },
            )
          }

          const handoffUsed = decision === 'approve_handoff'
          const approved: PlanApprovedInfo = {
            title: effectiveDraft.title,
            version: effectiveDraft.version,
            artifactId: artifact.id,
            artifactName: artifact.name,
            approvedAt: Date.now(),
            handoffUsed,
            ...(appliedExecutionModel !== undefined
              ? { executionModel: appliedExecutionModel }
              : {}),
          }

          if (latest !== undefined) {
            const { pendingAskId: _cleared, pendingAskKind: _clearedKind, ...rest } = latest
            const nextRecord: PlanConversationRecord = {
              ...rest,
              conversationId,
              mode: 'normal',
              approved,
            }
            state.writeRecord(conversationId, nextRecord)
            await state.flushKv()
            state.syncProjections(conversationId, nextRecord)
          }

          if (!handoffUsed) {
            const modelClause =
              appliedExecutionModel !== undefined
                ? ` Conversation model switched to ${appliedExecutionModel}.`
                : ''
            const output =
              feedback !== ''
                ? `Plan v${effectiveDraft.version} ("${effectiveDraft.title}") approved and saved as artifact ${artifact.name} (${artifact.id}).${modelClause} Plan mode exited.\nUser feedback: ${feedback}`
                : `Plan v${effectiveDraft.version} ("${effectiveDraft.title}") approved and saved as artifact ${artifact.name} (${artifact.id}).${modelClause} Plan mode exited.`
            return {
              output,
              presentationMeta: {
                kind: 'propose',
                title: effectiveDraft.title,
                version: effectiveDraft.version,
                outcome: 'approved',
                artifactId: artifact.id,
                artifactName: artifact.name,
                ...(appliedExecutionModel !== undefined
                  ? { executionModel: appliedExecutionModel }
                  : {}),
              },
            }
          }

          const handoff = buildHandoffText({
            draft: effectiveDraft,
            artifactId: artifact.id,
            artifactName: artifact.name,
            feedback,
            executionModel: appliedExecutionModel,
            redact: (text) => ctx.host.redact(text),
          })
          const output =
            appliedExecutionModel !== undefined
              ? `Plan v${effectiveDraft.version} ("${effectiveDraft.title}") approved, saved as ${artifact.name} (${artifact.id}), and handing off to ${appliedExecutionModel}.`
              : `Plan v${effectiveDraft.version} ("${effectiveDraft.title}") approved, saved as ${artifact.name} (${artifact.id}), and handing off to a fresh context.`

          state.markExpectedHandoffReset(conversationId)

          return {
            output,
            presentationMeta: {
              kind: 'propose',
              title: effectiveDraft.title,
              version: effectiveDraft.version,
              outcome: 'approved_handoff',
              artifactId: artifact.id,
              artifactName: artifact.name,
              ...(appliedExecutionModel !== undefined
                ? { executionModel: appliedExecutionModel }
                : {}),
            },
            control: { handoff },
          }
        },
      })
    },
  })

  ctx.tool<PlanAskInput>({
    name: PLAN_TOOL_ASK,
    description:
      'Ask 1-4 structured multiple-choice clarifying questions via AskDoc (plan mode only, top-level human conversations only).',
    promptGuidelines: [
      'Use plan_ask while in plan mode when genuine requirements or architectural choices need human clarification before drafting the plan.',
    ],
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          minLength: 1,
          maxLength: PLAN_TITLE_MAX_CHARS,
          description: `Optional card title (1-${PLAN_TITLE_MAX_CHARS} characters)`,
        },
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: PLAN_ASK_MAX_QUESTIONS,
          description: `1-${PLAN_ASK_MAX_QUESTIONS} concise clarifying questions`,
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                minLength: 1,
                maxLength: 40,
                description: 'Stable identifier (alphanumeric, _ or -; cannot be "notes")',
              },
              question: {
                type: 'string',
                minLength: 1,
                maxLength: PLAN_ASK_QUESTION_MAX_CHARS,
                description: `Question prompt (1-${PLAN_ASK_QUESTION_MAX_CHARS} characters)`,
              },
              options: {
                type: 'array',
                minItems: PLAN_ASK_MIN_OPTIONS,
                maxItems: PLAN_ASK_MAX_OPTIONS,
                items: {
                  type: 'object',
                  properties: {
                    value: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 64,
                      description: 'Option machine value',
                    },
                    label: {
                      type: 'string',
                      minLength: 1,
                      maxLength: PLAN_ASK_OPTION_LABEL_MAX_CHARS,
                      description: `Option display label (1-${PLAN_ASK_OPTION_LABEL_MAX_CHARS} characters)`,
                    },
                    description: {
                      type: 'string',
                      maxLength: PLAN_ASK_OPTION_DESC_MAX_CHARS,
                      description: `Optional option explanation (up to ${PLAN_ASK_OPTION_DESC_MAX_CHARS} characters)`,
                    },
                  },
                  required: ['value', 'label'],
                  additionalProperties: false,
                },
              },
            },
            required: ['id', 'question', 'options'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
    presentationMetaSchema: PLAN_TOOL_META_SCHEMA,
    async execute(input, context): Promise<PluginToolResultEnvelope> {
      const rawTitle = typeof input?.title === 'string' ? input.title.trim() : ''
      if (input?.title !== undefined && (rawTitle.length === 0 || rawTitle.length > PLAN_TITLE_MAX_CHARS)) {
        return toolError(`plan_ask title must be 1-${PLAN_TITLE_MAX_CHARS} characters when provided.`)
      }
      const explicitTitle = rawTitle !== '' ? ctx.host.redact(rawTitle).trim() : undefined
      if (rawTitle !== '' && (explicitTitle === undefined || explicitTitle.length === 0 || explicitTitle.length > PLAN_TITLE_MAX_CHARS)) {
        return toolError(`plan_ask title after redaction must be 1-${PLAN_TITLE_MAX_CHARS} characters.`)
      }
      const metaTitle = explicitTitle ?? 'Clarifying Questions'

      if (!Array.isArray(input?.questions) || input.questions.length < 1 || input.questions.length > PLAN_ASK_MAX_QUESTIONS) {
        return toolError(`plan_ask requires 1-${PLAN_ASK_MAX_QUESTIONS} questions.`)
      }

      const questionIds = new Set<string>()
      const normalizedQuestions: Array<{
        id: string
        question: string
        options: Array<{ value: string; label: string; description?: string }>
      }> = []

      for (const rawQ of input.questions) {
        const id = typeof rawQ?.id === 'string' ? rawQ.id.trim() : ''
        if (!ASK_QUESTION_ID_RE.test(id) || id === 'notes') {
          return toolError(`Invalid plan_ask question id "${id}": must match /^[A-Za-z0-9_-]{1,40}$/ and cannot be "notes".`)
        }
        if (questionIds.has(id)) {
          return toolError(`Duplicate plan_ask question id: "${id}".`)
        }
        questionIds.add(id)

        const rawPrompt = typeof rawQ?.question === 'string' ? rawQ.question.trim() : ''
        const safePrompt = ctx.host.redact(rawPrompt).trim()
        if (safePrompt.length === 0 || safePrompt.length > PLAN_ASK_QUESTION_MAX_CHARS) {
          return toolError(
            `Question "${id}" prompt must be 1-${PLAN_ASK_QUESTION_MAX_CHARS} characters.`,
          )
        }

        if (
          !Array.isArray(rawQ?.options) ||
          rawQ.options.length < PLAN_ASK_MIN_OPTIONS ||
          rawQ.options.length > PLAN_ASK_MAX_OPTIONS
        ) {
          return toolError(
            `Question "${id}" must have ${PLAN_ASK_MIN_OPTIONS}-${PLAN_ASK_MAX_OPTIONS} options.`,
          )
        }

        const optValues = new Set<string>()
        const normalizedOptions: Array<{ value: string; label: string; description?: string }> = []
        for (const rawOpt of rawQ.options) {
          const val = typeof rawOpt?.value === 'string' ? rawOpt.value.trim() : ''
          if (val === '' || val.length > 64) {
            return toolError(`Question "${id}" option value must be a non-empty string within 64 characters.`)
          }
          if (optValues.has(val)) {
            return toolError(`Question "${id}" has duplicate option value "${val}".`)
          }
          optValues.add(val)

          const rawLabel = typeof rawOpt?.label === 'string' ? rawOpt.label.trim() : ''
          const safeLabel = ctx.host.redact(rawLabel).trim()
          if (safeLabel.length === 0 || safeLabel.length > PLAN_ASK_OPTION_LABEL_MAX_CHARS) {
            return toolError(
              `Question "${id}" option "${val}" label must be 1-${PLAN_ASK_OPTION_LABEL_MAX_CHARS} characters.`,
            )
          }

          let safeDesc: string | undefined
          if (rawOpt?.description !== undefined) {
            if (typeof rawOpt.description !== 'string') {
              return toolError(`Question "${id}" option "${val}" description must be a string.`)
            }
            const trimmedDesc = ctx.host.redact(rawOpt.description.trim()).trim()
            if (trimmedDesc.length > PLAN_ASK_OPTION_DESC_MAX_CHARS) {
              return toolError(
                `Question "${id}" option "${val}" description exceeds ${PLAN_ASK_OPTION_DESC_MAX_CHARS} characters.`,
              )
            }
            if (trimmedDesc !== '') safeDesc = trimmedDesc
          }

          normalizedOptions.push({
            value: val,
            label: safeLabel,
            ...(safeDesc !== undefined ? { description: safeDesc } : {}),
          })
        }

        normalizedQuestions.push({
          id,
          question: safePrompt,
          options: normalizedOptions,
        })
      }

      if (context.signal?.aborted) {
        return toolError('plan_ask aborted before creating prompt.')
      }

      const conversationId = context.conversationId
      const prepared = await preparePlanningAsk({
        ctx,
        state,
        conversationId,
        kind: 'clarify',
        toolName: PLAN_TOOL_ASK,
      })
      if (!prepared.ok) {
        return prepared.result
      }

      const fields: AskFieldSpec[] = [
        ...normalizedQuestions.map(
          (q): AskFieldSpec => ({
            name: q.id,
            label: q.question,
            type: 'choice',
            required: true,
            options: q.options.map((o) => ({
              value: o.value,
              label: o.label,
              ...(o.description !== undefined ? { description: o.description } : {}),
            })),
          }),
        ),
        {
          name: 'notes',
          label: { en: 'Additional context (optional)', 'zh-CN': '补充说明（可选）' },
          type: 'text',
          required: false,
        },
      ]

      const askSpec: AskCreateSpec = {
        id: prepared.askId,
        conversationId,
        ownerPluginId: PLAN_PLUGIN_ID,
        title:
          explicitTitle !== undefined
            ? explicitTitle
            : { en: 'Clarifying Questions', 'zh-CN': '需求澄清' },
        hint: {
          en: 'Tip: You can also reply freely in the composer below.',
          'zh-CN': '提示：也可直接在下方输入框自由回复。',
        },
        expectedStateSeq: prepared.expectedStateSeq,
        fields,
      }

      const questionCount = normalizedQuestions.length
      return awaitPlanAsk({
        ctx,
        state,
        conversationId,
        askId: prepared.askId,
        askSpec,
        signal: context.signal,
        async onSettled(settled) {
          if (!settled.ok) {
            await settled.clearPendingOnly()
            return toolError(
              `Failed to create clarifying ask: ${ctx.host.redact(errorMessageOf(settled.error))}`,
              {
                kind: 'ask',
                title: metaTitle,
                questionCount,
                outcome: 'error',
              },
            )
          }

          await settled.clearPendingOnly()
          const { askResult } = settled

          if (askResult.status === 'superseded') {
            return {
              output:
                'Clarifying prompt was superseded because a new user message arrived or the conversation state changed.',
              presentationMeta: {
                kind: 'ask',
                title: metaTitle,
                questionCount,
                outcome: 'superseded',
              },
            }
          }

          if (askResult.status === 'cancelled') {
            return {
              output: 'Clarifying prompt was cancelled by the user.',
              presentationMeta: {
                kind: 'ask',
                title: metaTitle,
                questionCount,
                outcome: 'cancelled',
              },
            }
          }

          const lines: string[] = ['User clarification answers:']
          for (const q of normalizedQuestions) {
            const val = askResult.answers[q.id] ?? ''
            const matchedOpt = q.options.find((o) => o.value === val)
            const display = matchedOpt !== undefined ? `${val} (${matchedOpt.label})` : val
            lines.push(`- ${q.id} (${q.question}): ${display}`)
          }
          const notes = ctx.host.redact(askResult.answers['notes'] ?? '').trim()
          if (notes !== '') {
            lines.push(`- notes: ${notes}`)
          }

          return {
            output: lines.join('\n'),
            presentationMeta: {
              kind: 'ask',
              title: metaTitle,
              questionCount,
              outcome: 'answered',
            },
          }
        },
      })
    },
  })

  ctx.tool<{ command: string; timeoutMs?: number }>({
    name: PLAN_TOOL_BASH,
    description:
      'Execute a read-only inspection shell command on the conversation node (plan mode only; mutating commands and file redirects are blocked).',
    promptGuidelines: [
      'Use plan_bash strictly for read-only codebase inspection (e.g., rg, ls, git status, git diff, git log). Mutating commands and file redirects are blocked.',
    ],
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          minLength: 1,
          description: 'Read-only shell command to execute',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: PLAN_BASH_MAX_TIMEOUT_MS,
          description: `Optional timeout in milliseconds (default ${PLAN_BASH_DEFAULT_TIMEOUT_MS}, max ${PLAN_BASH_MAX_TIMEOUT_MS})`,
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    structuredOutputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        exitCode: { type: ['number', 'null'] },
        timedOut: { type: 'boolean' },
        output: { type: 'string' },
      },
      required: ['ok', 'exitCode', 'timedOut', 'output'],
    },
    async execute(input, context): Promise<PluginToolResultEnvelope> {
      const command = typeof input?.command === 'string' ? input.command : ''
      const check = validateReadOnlyShellCommand(command)
      if (!check.ok) {
        return toolError(
          `Blocked by read-only plan mode: ${check.reason}. Use read/read_artifact or a read-only inspection command.`,
        )
      }

      const rawTimeout = input?.timeoutMs
      if (
        rawTimeout !== undefined &&
        (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout < 1)
      ) {
        return toolError('plan_bash timeoutMs must be a positive integer.')
      }
      const timeoutMs =
        rawTimeout !== undefined
          ? Math.min(PLAN_BASH_MAX_TIMEOUT_MS, Math.max(1, Math.trunc(rawTimeout)))
          : PLAN_BASH_DEFAULT_TIMEOUT_MS

      const conversationId = context.conversationId
      if (state.isStopping()) {
        return toolError('builtin:plan is stopping; cannot execute command.')
      }
      const conv = ctx.host.getConversation(conversationId)
      if (!isPlanConversationEligible(conv)) {
        return toolError('plan_bash is only allowed in top-level human conversations.')
      }
      const current = state.getRecord(conversationId)
      if ((current?.mode ?? 'normal') !== 'planning') {
        return toolError('plan_bash is only allowed while in planning mode.')
      }

      const res = await ctx.host.execEnv(
        { command, conversationId, timeoutMs },
        { ...(context.signal !== undefined ? { signal: context.signal } : {}) },
      )
      const redactedOutput = ctx.host.redact(res.output)
      return {
        output: redactedOutput,
        structuredOutput: {
          ok: res.ok,
          exitCode: res.exitCode,
          timedOut: res.timedOut,
          output: redactedOutput,
        },
        isError: !res.ok,
      }
    },
  })
}
