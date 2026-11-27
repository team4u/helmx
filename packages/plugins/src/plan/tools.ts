/**
 * builtin:plan model tools (`plan_save` and `plan_propose`).
 */
import { randomUUID } from 'node:crypto'
import {
  HelmxError,
  type AskCreateSpec,
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
  validateAndRedactPlanDraft,
  type PlanApprovedInfo,
  type PlanConversationRecord,
  type PlanDraftSummary,
  type PlanToolPresentationMeta,
} from './contracts.js'
import type { PlanStateManager } from './state.js'
import { errorMessageOf } from '../shared-helpers.js'

const utf8Encoder = new TextEncoder()

type AwaitPlanAskSettled =
  | {
      ok: true
      askResult: AskResult
      latest: PlanConversationRecord | undefined
      clearPendingOnly: () => Promise<void>
    }
  | {
      ok: false
      error: unknown
      latest: PlanConversationRecord | undefined
      clearPendingOnly: () => Promise<void>
    }

interface ParsedProposalAnswers {
  decision: string
  feedback: string
  selectedModel?: string
  selectedThinkingLevel?: string
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

async function persistRecordOrRollback(
  state: PlanStateManager,
  conversationId: number,
  prevRecord: PlanConversationRecord | undefined,
  nextRecord: PlanConversationRecord,
): Promise<void> {
  state.writeRecord(conversationId, nextRecord)
  try {
    await state.flushKv()
  } catch (err) {
    if (prevRecord !== undefined) state.writeRecord(conversationId, prevRecord)
    else state.deleteRecord(conversationId)
    throw err
  }
  state.syncProjections(conversationId, nextRecord)
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
  onSettled: (outcome: AwaitPlanAskSettled) => Promise<PluginToolResultEnvelope>
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
        const { pendingAskId: _cleared, ...rest } = latest
        await persistRecordOrRollback(state, conversationId, latest, rest)
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
        const { pendingAskId: _cleared, ...rest } = latest
        await persistRecordOrRollback(state, conversationId, latest, rest)
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
  toolName: string
}): Promise<
  | {
      ok: true
      askId: string
      expectedStateSeq: number
      current: PlanConversationRecord
      draft: PlanDraftSummary
    }
  | { ok: false; result: PluginToolResultEnvelope }
> {
  const { ctx, state, conversationId, toolName } = params
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
    if (current === undefined || current.mode !== 'planning') {
      return {
        ok: false as const,
        result: toolError(`${toolName} is only allowed while in planning mode.`),
      }
    }
    const draft = current.draft
    if (draft === undefined) {
      return {
        ok: false as const,
        result: toolError(`No plan draft exists yet. Call \`${PLAN_TOOL_SAVE}\` first.`),
      }
    }
    if (current.pendingAskId !== undefined || state.hasInFlightAsk(conversationId)) {
      return {
        ok: false as const,
        result: toolError(
          `A plan ask (${current.pendingAskId ?? 'in-flight'}) is already pending for this conversation.`,
          {
            kind: 'propose',
            title: draft.title,
            version: draft.version,
            outcome: 'error',
          },
        ),
      }
    }

    const askId = randomUUID()
    const nextRecord: PlanConversationRecord = {
      ...current,
      conversationId,
      mode: 'planning',
      pendingAskId: askId,
    }
    await persistRecordOrRollback(state, conversationId, current, nextRecord)
    return {
      ok: true as const,
      askId,
      expectedStateSeq: conv.stateChangeSeq,
      current: nextRecord,
      draft,
    }
  })
}

function validateProposeSummary(
  ctx: HelmxPluginContext,
  rawInput: unknown,
): { ok: true; summary: string } | { ok: false; result: PluginToolResultEnvelope } {
  const rawSummary = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (rawSummary.length === 0 || rawSummary.length > PLAN_SUMMARY_MAX_CHARS) {
    return {
      ok: false,
      result: toolError(
        `plan_propose summary must be a non-empty string within ${PLAN_SUMMARY_MAX_CHARS} characters.`,
      ),
    }
  }
  if (rawSummary.includes('```')) {
    return {
      ok: false,
      result: toolError(
        'plan_propose summary must be plain text without triple-backtick code fences (```).',
      ),
    }
  }
  const safeSummary = ctx.host.redact(rawSummary).trim()
  if (
    safeSummary.length === 0 ||
    safeSummary.length > PLAN_SUMMARY_MAX_CHARS ||
    safeSummary.includes('```')
  ) {
    return {
      ok: false,
      result: toolError(
        `plan_propose summary after redaction must be 1-${PLAN_SUMMARY_MAX_CHARS} plain-text characters without code fences.`,
      ),
    }
  }
  return { ok: true, summary: safeSummary }
}

function buildPlanApprovalAskSpec(params: {
  askId: string
  conversationId: number
  expectedStateSeq: number
  draft: PlanDraftSummary
  summary: string
  configuredExecutionModel?: string
}): AskCreateSpec {
  const { askId, conversationId, expectedStateSeq, draft, summary, configuredExecutionModel } = params
  return {
    id: askId,
    conversationId,
    ownerPluginId: PLAN_PLUGIN_ID,
    kind: 'approval',
    title: {
      en: `Plan Approval v${draft.version}: ${draft.title}`,
      'zh-CN': `计划审批 v${draft.version}：${draft.title}`,
    },
    description: summary,
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
            recommended: true,
            description: {
              en: 'Archive plan and start execution with a clean context',
              'zh-CN': '归档计划并以干净上下文开始执行',
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
        thinkingLevelField: 'executionThinkingLevel',
      },
      {
        name: 'feedback',
        label: { en: 'Additional notes (optional)', 'zh-CN': '补充说明（可选）' },
        type: 'text',
        required: false,
      },
    ],
  }
}

function parsePlanApprovalAnswers(
  ctx: HelmxPluginContext,
  answers: Readonly<Record<string, unknown>>,
): ParsedProposalAnswers {
  const decision = typeof answers['decision'] === 'string' ? answers['decision'] : ''
  const rawFeedback = typeof answers['feedback'] === 'string' ? answers['feedback'] : ''
  const feedback = ctx.host.redact(rawFeedback).trim()
  const rawSelectedModel = answers['executionModel']
  const selectedModel =
    typeof rawSelectedModel === 'string' && rawSelectedModel.trim() !== ''
      ? ctx.host.redact(rawSelectedModel.trim()).trim()
      : undefined
  const rawSelectedThinking = answers['executionThinkingLevel']
  const redactedThinking =
    typeof rawSelectedThinking === 'string' && rawSelectedThinking.trim() !== ''
      ? ctx.host.redact(rawSelectedThinking.trim()).trim()
      : ''
  const selectedThinkingLevel = redactedThinking !== '' ? redactedThinking : undefined
  return {
    decision,
    feedback,
    ...(selectedModel !== undefined ? { selectedModel } : {}),
    ...(selectedThinkingLevel !== undefined ? { selectedThinkingLevel } : {}),
  }
}

async function applyApprovalModelSwitch(params: {
  ctx: HelmxPluginContext
  conversationId: number
  effectiveDraft: PlanDraftSummary
  selectedModel?: string
  selectedThinkingLevel?: string
  clearPendingOnly: () => Promise<void>
}): Promise<{ ok: true; appliedExecutionModel?: string } | { ok: false; result: PluginToolResultEnvelope }> {
  const { ctx, conversationId, effectiveDraft, selectedModel, selectedThinkingLevel, clearPendingOnly } = params
  if (selectedModel === undefined) return { ok: true }
  try {
    await ctx.host.updateConversation(conversationId, {
      model: selectedModel,
      ...(selectedThinkingLevel !== undefined ? { thinkingLevel: selectedThinkingLevel } : {}),
    })
    return { ok: true, appliedExecutionModel: selectedModel }
  } catch (err) {
    await clearPendingOnly()
    return {
      ok: false,
      result: toolError(
        `Failed to switch conversation model to "${selectedModel}": ${ctx.host.redact(errorMessageOf(err))}. Staying in planning mode.`,
        {
          kind: 'propose',
          title: effectiveDraft.title,
          version: effectiveDraft.version,
          outcome: 'error',
          executionModel: selectedModel,
        },
      ),
    }
  }
}

async function createApprovedPlanArtifact(params: {
  ctx: HelmxPluginContext
  conversationId: number
  effectiveDraft: PlanDraftSummary
  appliedExecutionModel?: string
  clearPendingOnly: () => Promise<void>
}): Promise<
  | { ok: true; artifact: Awaited<ReturnType<typeof params.ctx.host.createArtifact>> }
  | { ok: false; result: PluginToolResultEnvelope }
> {
  const { ctx, conversationId, effectiveDraft, appliedExecutionModel, clearPendingOnly } = params
  const artifactName = `plan-v${effectiveDraft.version}.md`
  try {
    const artifact = await ctx.host.createArtifact(conversationId, {
      name: artifactName,
      bytes: utf8Encoder.encode(effectiveDraft.markdown),
      mimeType: 'text/markdown',
    })
    return { ok: true, artifact }
  } catch (err) {
    await clearPendingOnly()
    return {
      ok: false,
      result: toolError(
        `Failed to save approved plan artifact ${artifactName}: ${ctx.host.redact(errorMessageOf(err))}. Staying in planning mode.`,
        {
          kind: 'propose',
          title: effectiveDraft.title,
          version: effectiveDraft.version,
          outcome: 'error',
          ...(appliedExecutionModel !== undefined ? { executionModel: appliedExecutionModel } : {}),
        },
      ),
    }
  }
}

async function settlePlanProposal(params: {
  ctx: HelmxPluginContext
  state: PlanStateManager
  conversationId: number
  draft: PlanDraftSummary
  settled: AwaitPlanAskSettled
}): Promise<PluginToolResultEnvelope> {
  const { ctx, state, conversationId, draft, settled } = params
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

  const parsed = parsePlanApprovalAnswers(ctx, askResult.answers)

  if (parsed.decision === 'revise') {
    await clearPendingOnly()
    return {
      output:
        parsed.feedback !== ''
          ? `User requested revisions to plan v${effectiveDraft.version} ("${effectiveDraft.title}"):\n${parsed.feedback}\n\nUpdate the draft via \`${PLAN_TOOL_SAVE}\` and call \`${PLAN_TOOL_PROPOSE}\` again.`
          : `User requested revisions to plan v${effectiveDraft.version} ("${effectiveDraft.title}"). Clarify any needed details or update the draft via \`${PLAN_TOOL_SAVE}\`.`,
      presentationMeta: {
        kind: 'propose',
        title: effectiveDraft.title,
        version: effectiveDraft.version,
        outcome: 'revised',
      },
    }
  }

  if (parsed.decision !== 'approve' && parsed.decision !== 'approve_handoff') {
    await clearPendingOnly()
    return toolError(`Unsupported plan approval decision: ${String(parsed.decision)}`, {
      kind: 'propose',
      title: effectiveDraft.title,
      version: effectiveDraft.version,
      outcome: 'error',
    })
  }

  const modelSwitch = await applyApprovalModelSwitch({
    ctx,
    conversationId,
    effectiveDraft,
    selectedModel: parsed.selectedModel,
    selectedThinkingLevel: parsed.selectedThinkingLevel,
    clearPendingOnly,
  })
  if (!modelSwitch.ok) return modelSwitch.result
  const { appliedExecutionModel } = modelSwitch

  const artifactRes = await createApprovedPlanArtifact({
    ctx,
    conversationId,
    effectiveDraft,
    appliedExecutionModel,
    clearPendingOnly,
  })
  if (!artifactRes.ok) return artifactRes.result
  const { artifact } = artifactRes

  const handoffUsed = parsed.decision === 'approve_handoff'
  const approved: PlanApprovedInfo = {
    title: effectiveDraft.title,
    version: effectiveDraft.version,
    artifactId: artifact.id,
    artifactName: artifact.name,
    approvedAt: Date.now(),
    handoffUsed,
    ...(appliedExecutionModel !== undefined ? { executionModel: appliedExecutionModel } : {}),
  }

  if (latest !== undefined) {
    const { pendingAskId: _cleared, ...rest } = latest
    const nextRecord: PlanConversationRecord = {
      ...rest,
      conversationId,
      mode: 'normal',
      approved,
    }
    await persistRecordOrRollback(state, conversationId, latest, nextRecord)
  }

  if (!handoffUsed) {
    const modelClause =
      appliedExecutionModel !== undefined
        ? ` Conversation model switched to ${appliedExecutionModel}.`
        : ''
    const output =
      parsed.feedback !== ''
        ? `Plan v${effectiveDraft.version} ("${effectiveDraft.title}") approved and saved as artifact ${artifact.name} (${artifact.id}).${modelClause} Plan mode exited.\nUser feedback: ${parsed.feedback}`
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
        ...(appliedExecutionModel !== undefined ? { executionModel: appliedExecutionModel } : {}),
      },
    }
  }

  const handoff = buildHandoffText({
    draft: effectiveDraft,
    artifactId: artifact.id,
    artifactName: artifact.name,
    feedback: parsed.feedback,
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
      ...(appliedExecutionModel !== undefined ? { executionModel: appliedExecutionModel } : {}),
    },
    control: { handoff },
  }
}

function registerPlanSaveTool(ctx: HelmxPluginContext, state: PlanStateManager): void {
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
      if (!validated.ok) return toolError(validated.message)
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
        await persistRecordOrRollback(state, conversationId, current, nextRecord)

        const lineCount = markdown.split(/\r?\n/).length
        const charCount = markdown.length
        return {
          output: `Saved plan draft v${nextVersion}: "${title}" (${lineCount} lines, ${charCount} chars). Call \`${PLAN_TOOL_PROPOSE}\` when ready for user approval.`,
          presentationMeta: {
            kind: 'save',
            title,
            version: nextVersion,
            lineCount,
            charCount,
          },
        }
      })
    },
  })
}

function registerPlanProposeTool(
  ctx: HelmxPluginContext,
  state: PlanStateManager,
  getExecutionModel: () => string | undefined,
): void {
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
      const checkedSummary = validateProposeSummary(ctx, input?.summary)
      if (!checkedSummary.ok) return checkedSummary.result
      if (context.signal?.aborted) {
        return toolError('plan_propose aborted before creating approval prompt.')
      }

      const conversationId = context.conversationId
      const prepared = await preparePlanningAsk({
        ctx,
        state,
        conversationId,
        toolName: PLAN_TOOL_PROPOSE,
      })
      if (!prepared.ok) return prepared.result

      const { askId, expectedStateSeq, draft } = prepared
      const askSpec = buildPlanApprovalAskSpec({
        askId,
        conversationId,
        expectedStateSeq,
        draft,
        summary: checkedSummary.summary,
        configuredExecutionModel: getExecutionModel(),
      })

      return awaitPlanAsk({
        ctx,
        state,
        conversationId,
        askId,
        askSpec,
        signal: context.signal,
        onSettled: (settled) => settlePlanProposal({ ctx, state, conversationId, draft, settled }),
      })
    },
  })
}

export function registerPlanTools(
  ctx: HelmxPluginContext,
  state: PlanStateManager,
  getExecutionModel: () => string | undefined,
): void {
  registerPlanSaveTool(ctx, state)
  registerPlanProposeTool(ctx, state, getExecutionModel)
}
