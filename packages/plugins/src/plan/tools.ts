/**
 * builtin:plan model tools (`plan_save` and `plan_propose`).
 */
import { randomUUID } from 'node:crypto'
import {
  HelmxError,
  type AskResult,
  type HelmxPluginContext,
  type PluginToolResultEnvelope,
} from '@helmx/protocol'
import {
  PLAN_HANDOFF_MAX_BYTES,
  PLAN_MARKDOWN_MAX_BYTES,
  PLAN_PLUGIN_ID,
  PLAN_SUMMARY_MAX_CHARS,
  PLAN_TITLE_MAX_CHARS,
  PLAN_TOOL_META_SCHEMA,
  PLAN_TOOL_PROPOSE,
  PLAN_TOOL_SAVE,
  isPlanConversationEligible,
  type PlanApprovedInfo,
  type PlanConversationRecord,
  type PlanDraftSummary,
  type PlanToolPresentationMeta,
} from './contracts.js'
import type { PlanStateManager } from './state.js'

const utf8Encoder = new TextEncoder()

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

export function registerPlanTools(
  ctx: HelmxPluginContext,
  state: PlanStateManager,
  getExecutionModel: () => string | undefined,
): void {
  ctx.tool<{ title: string; markdown: string }>({
    name: PLAN_TOOL_SAVE,
    description:
      'Save or update the current plan draft (planning mode only, top-level human conversations only).',
    promptGuidelines: [
      'Use plan_save only while in planning mode to record or refine a concrete implementation plan before calling plan_propose.',
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
          description: `Full implementation plan in Markdown (1-${PLAN_MARKDOWN_MAX_BYTES} UTF-8 bytes)`,
        },
      },
      required: ['title', 'markdown'],
      additionalProperties: false,
    },
    presentationMetaSchema: PLAN_TOOL_META_SCHEMA,
    async execute(input, context): Promise<PluginToolResultEnvelope> {
      const rawTitle = typeof input?.title === 'string' ? input.title.trim() : ''
      if (rawTitle.length === 0 || rawTitle.length > PLAN_TITLE_MAX_CHARS) {
        return toolError(
          `plan_save title must be a non-empty string within ${PLAN_TITLE_MAX_CHARS} characters.`,
        )
      }
      const rawMarkdown = typeof input?.markdown === 'string' ? input.markdown : ''
      if (rawMarkdown.trim().length === 0) {
        return toolError('plan_save markdown must be a non-empty string.')
      }
      if (Buffer.byteLength(rawMarkdown, 'utf8') > PLAN_MARKDOWN_MAX_BYTES) {
        return toolError(
          `plan_save markdown exceeds maximum size of ${PLAN_MARKDOWN_MAX_BYTES} UTF-8 bytes.`,
        )
      }

      const title = ctx.host.redact(rawTitle).trim()
      if (title.length === 0 || title.length > PLAN_TITLE_MAX_CHARS) {
        return toolError(
          `plan_save title after redaction must be 1-${PLAN_TITLE_MAX_CHARS} characters.`,
        )
      }
      const markdown = ctx.host.redact(rawMarkdown)
      if (markdown.trim().length === 0) {
        return toolError('plan_save markdown cannot be empty after redaction.')
      }
      if (Buffer.byteLength(markdown, 'utf8') > PLAN_MARKDOWN_MAX_BYTES) {
        return toolError(
          `plan_save markdown exceeds maximum size of ${PLAN_MARKDOWN_MAX_BYTES} UTF-8 bytes.`,
        )
      }

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
      'Submit the current saved plan draft for human approval via AskDoc (planning mode only).',
    promptGuidelines: [
      'Call plan_propose only after saving a draft with plan_save; pass a concise plain-text summary (1-300 chars, no code fences).',
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
      const prepared = await state.enqueueConversation(conversationId, async () => {
        if (state.isStopping()) {
          return { ok: false as const, result: toolError('builtin:plan is stopping; cannot propose plan.') }
        }
        const conv = ctx.host.getConversation(conversationId)
        if (!isPlanConversationEligible(conv)) {
          return {
            ok: false as const,
            result: toolError('plan_propose is only allowed in top-level human conversations.'),
          }
        }
        const current = state.getRecord(conversationId)
        if ((current?.mode ?? 'normal') !== 'planning') {
          return {
            ok: false as const,
            result: toolError('plan_propose is only allowed while in planning mode.'),
          }
        }
        if (current?.draft === undefined) {
          return {
            ok: false as const,
            result: toolError(`No plan draft exists yet. Call \`${PLAN_TOOL_SAVE}\` first.`),
          }
        }
        if (current.pendingAskId !== undefined || state.hasInFlightAsk(conversationId)) {
          return {
            ok: false as const,
            result: toolError(
              `A plan approval ask (${current.pendingAskId ?? 'in-flight'}) is already pending for this conversation.`,
              {
                kind: 'propose',
                title: current.draft.title,
                version: current.draft.version,
                outcome: 'error',
              },
            ),
          }
        }

        const askId = randomUUID()
        const executionModel = getExecutionModel()
        const nextRecord: PlanConversationRecord = {
          ...current,
          conversationId,
          mode: 'planning',
          pendingAskId: askId,
        }
        state.writeRecord(conversationId, nextRecord)
        try {
          await state.flushKv()
        } catch (err) {
          state.writeRecord(conversationId, current)
          throw err
        }
        state.syncProjections(conversationId, nextRecord)
        return {
          ok: true as const,
          askId,
          draft: current.draft,
          expectedStateSeq: conv.stateChangeSeq,
          executionModel,
        }
      })

      if (!prepared.ok) {
        return prepared.result
      }

      const { askId, draft, expectedStateSeq, executionModel } = prepared

      const runPromise = (async (): Promise<PluginToolResultEnvelope> => {
        const onAbort = () => {
          void state.cancelAskSafe(askId, 'cancelled').catch(() => {})
        }
        context.signal?.addEventListener('abort', onAbort, { once: true })
        if (context.signal?.aborted) {
          onAbort()
        }

        let askResult: AskResult
        let createAskFailed: unknown
        let hasCreateAskError = false
        try {
          askResult = await ctx.host.createAsk({
            id: askId,
            conversationId,
            ownerPluginId: PLAN_PLUGIN_ID,
            title: `Plan Approval v${draft.version}: ${draft.title}`,
            description: safeSummary,
            expectedStateSeq,
            fields: [
              {
                name: 'decision',
                label: 'Decision',
                type: 'select',
                required: true,
                options: [
                  { label: 'Approve & keep current context', value: 'approve' },
                  { label: 'Approve & start fresh handoff', value: 'approve_handoff' },
                  ...(executionModel !== undefined
                    ? [
                        {
                          label: `Approve & handoff to ${executionModel}`,
                          value: 'approve_handoff_model',
                        },
                      ]
                    : []),
                  { label: 'Request revisions', value: 'revise' },
                ],
              },
              {
                name: 'feedback',
                label: 'Feedback (optional)',
                type: 'text',
                required: false,
              },
            ],
          })
        } catch (err) {
          hasCreateAskError = true
          createAskFailed = err
          askResult = { id: askId, status: 'cancelled', answers: {} }
        } finally {
          context.signal?.removeEventListener('abort', onAbort)
        }

        return state.enqueueConversation(conversationId, async () => {
          const latest = state.getRecord(conversationId)
          const clearPendingOnly = async (): Promise<void> => {
            if (latest === undefined || latest.pendingAskId !== askId) return
            const { pendingAskId: _cleared, ...rest } = latest
            state.writeRecord(conversationId, rest)
            await state.flushKv()
            state.syncProjections(conversationId, rest)
          }

          if (hasCreateAskError) {
            await clearPendingOnly()
            return toolError(
              `Failed to create plan approval ask: ${ctx.host.redact(errorMessageOf(createAskFailed))}`,
              {
                kind: 'propose',
                title: draft.title,
                version: draft.version,
                outcome: 'error',
              },
            )
          }

          if (askResult.status === 'superseded') {
            await clearPendingOnly()
            return {
              output:
                'Plan proposal was superseded because the conversation state changed before approval. Review the latest state and propose again when ready.',
              presentationMeta: {
                kind: 'propose',
                title: draft.title,
                version: draft.version,
                outcome: 'superseded',
              },
            }
          }

          if (askResult.status === 'cancelled') {
            await clearPendingOnly()
            const exited = latest === undefined || latest.mode === 'normal'
            return {
              output: exited
                ? 'Plan proposal was cancelled and planning mode was exited.'
                : 'Plan proposal was cancelled. Remaining in planning mode so you can revise or ask the user how to proceed.',
              presentationMeta: {
                kind: 'propose',
                title: draft.title,
                version: draft.version,
                outcome: 'cancelled',
              },
            }
          }

          const decision = askResult.answers['decision'] ?? ''
          const rawFeedback = askResult.answers['feedback'] ?? ''
          const feedback = ctx.host.redact(rawFeedback).trim()

          if (decision === 'revise') {
            await clearPendingOnly()
            return {
              output:
                feedback !== ''
                  ? `User requested revisions to plan v${draft.version} ("${draft.title}"):\n${feedback}\n\nUpdate the draft via \`${PLAN_TOOL_SAVE}\` and call \`${PLAN_TOOL_PROPOSE}\` again.`
                  : `User requested revisions to plan v${draft.version} ("${draft.title}"). Clarify any needed details or update the draft via \`${PLAN_TOOL_SAVE}\`.`,
              presentationMeta: {
                kind: 'propose',
                title: draft.title,
                version: draft.version,
                outcome: 'revised',
              },
            }
          }

          if (
            decision !== 'approve' &&
            decision !== 'approve_handoff' &&
            decision !== 'approve_handoff_model'
          ) {
            await clearPendingOnly()
            return toolError(`Unsupported plan approval decision: ${String(decision)}`, {
              kind: 'propose',
              title: draft.title,
              version: draft.version,
              outcome: 'error',
            })
          }

          let appliedExecutionModel: string | undefined
          if (decision === 'approve_handoff_model') {
            const targetModel = executionModel ?? getExecutionModel()
            if (targetModel === undefined) {
              await clearPendingOnly()
              return toolError(
                'Cannot hand off to executionModel because no executionModel is configured. Staying in planning mode.',
                {
                  kind: 'propose',
                  title: draft.title,
                  version: draft.version,
                  outcome: 'error',
                },
              )
            }
            try {
              await ctx.host.updateConversation(conversationId, { model: targetModel })
              appliedExecutionModel = targetModel
            } catch (err) {
              await clearPendingOnly()
              return toolError(
                `Failed to switch conversation model to "${targetModel}": ${ctx.host.redact(errorMessageOf(err))}. Staying in planning mode.`,
                {
                  kind: 'propose',
                  title: draft.title,
                  version: draft.version,
                  outcome: 'error',
                  executionModel: targetModel,
                },
              )
            }
          }

          const artifactName = `plan-v${draft.version}.md`
          let artifact: Awaited<ReturnType<typeof ctx.host.createArtifact>>
          try {
            artifact = await ctx.host.createArtifact(conversationId, {
              name: artifactName,
              bytes: utf8Encoder.encode(draft.markdown),
              mimeType: 'text/markdown',
            })
          } catch (err) {
            await clearPendingOnly()
            return toolError(
              `Failed to save approved plan artifact ${artifactName}: ${ctx.host.redact(errorMessageOf(err))}. Staying in planning mode.`,
              {
                kind: 'propose',
                title: draft.title,
                version: draft.version,
                outcome: 'error',
                ...(appliedExecutionModel !== undefined
                  ? { executionModel: appliedExecutionModel }
                  : {}),
              },
            )
          }

          const handoffUsed =
            decision === 'approve_handoff' || decision === 'approve_handoff_model'
          const approved: PlanApprovedInfo = {
            title: draft.title,
            version: draft.version,
            artifactId: artifact.id,
            artifactName: artifact.name,
            approvedAt: Date.now(),
            handoffUsed,
            ...(appliedExecutionModel !== undefined
              ? { executionModel: appliedExecutionModel }
              : {}),
          }

          if (latest !== undefined) {
            const { pendingAskId: _cleared, ...rest } = latest
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
            const output =
              feedback !== ''
                ? `Plan v${draft.version} ("${draft.title}") approved and saved as artifact ${artifact.name} (${artifact.id}). Planning mode exited.\nUser feedback: ${feedback}`
                : `Plan v${draft.version} ("${draft.title}") approved and saved as artifact ${artifact.name} (${artifact.id}). Planning mode exited.`
            return {
              output,
              presentationMeta: {
                kind: 'propose',
                title: draft.title,
                version: draft.version,
                outcome: 'approved',
                artifactId: artifact.id,
                artifactName: artifact.name,
              },
            }
          }

          const handoff = buildHandoffText({
            draft,
            artifactId: artifact.id,
            artifactName: artifact.name,
            feedback,
            executionModel: appliedExecutionModel,
            redact: (text) => ctx.host.redact(text),
          })
          const output =
            appliedExecutionModel !== undefined
              ? `Plan v${draft.version} ("${draft.title}") approved, saved as ${artifact.name} (${artifact.id}), and handing off to ${appliedExecutionModel}.`
              : `Plan v${draft.version} ("${draft.title}") approved, saved as ${artifact.name} (${artifact.id}), and handing off to a fresh context.`
          return {
            output,
            presentationMeta: {
              kind: 'propose',
              title: draft.title,
              version: draft.version,
              outcome: 'approved_handoff',
              artifactId: artifact.id,
              artifactName: artifact.name,
              ...(appliedExecutionModel !== undefined
                ? { executionModel: appliedExecutionModel }
                : {}),
            },
            control: { handoff },
          }
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
            const { pendingAskId: _cleared, ...rest } = latest
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
    },
  })
}
