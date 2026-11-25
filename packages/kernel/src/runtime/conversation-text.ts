/**
 * Out-of-band single-shot text completion helper against a conversation's effective model.
 */
import type { Models } from '@earendil-works/pi-ai'
import { HelmxError } from '@helmx/protocol'
import { requireModelRef } from './models.js'
import type { HelmxStore } from './store.js'

/** Underlying text-completion helper. */
export async function completeConversationTextHelper(
  deps: {
    store: HelmxStore
    conversations: { resolveEffectiveModel(modelOverride?: string, profileId?: string): Promise<string | undefined> }
    models: {
      models: Models
      isModelDisabled(providerId: string, modelId: string): boolean
      resolveModelRef?(ref: string): { provider: string; modelId: string; canonicalRef: string; tierThinkingLevel?: string }
    }
    stash: { redact(text: string): string }
  },
  input: {
    conversationId: number
    model?: string
    systemPrompt: string
    text: string
    maxTokens?: number
    signal?: AbortSignal
  },
): Promise<string> {
  input.signal?.throwIfAborted()
  const meta = deps.store.getConv(input.conversationId)
  if (meta === undefined) {
    throw new HelmxError('not_found', `Conversation not found: ${input.conversationId}`, 404, { conversationId: input.conversationId })
  }
  const explicitModel = input.model?.trim()
  const effective =
    explicitModel !== undefined && explicitModel !== ''
      ? explicitModel
      : await deps.conversations.resolveEffectiveModel(meta.modelOverride, meta.profileId)
  if (effective === undefined || effective === '') {
    throw new HelmxError('model_not_configured', `Conversation ${input.conversationId} has no effective model resolved; cannot run text completion`, 409, { conversationId: input.conversationId })
  }
  const ref = deps.models.resolveModelRef !== undefined
    ? deps.models.resolveModelRef(effective)
    : requireModelRef(effective)
  const model = deps.models.models.getModel(ref.provider, ref.modelId)
  if (model === undefined) {
    throw new HelmxError('model_not_found', `Effective model '${effective}' is not in the current model set (may have been removed on hot reload)`, 409, { model: effective })
  }
  if (deps.models.isModelDisabled(ref.provider, ref.modelId)) {
    throw new HelmxError('model_disabled', `Model ${ref.provider}/${ref.modelId} is disabled; cannot run text completion`, 409, { model: effective })
  }
  input.signal?.throwIfAborted()
  const message = await deps.models.models.completeSimple(
    model,
    {
      systemPrompt: deps.stash.redact(input.systemPrompt),
      messages: [
        {
          role: 'user',
          content: deps.stash.redact(input.text),
          timestamp: Date.now(),
        },
      ],
    },
    {
      signal: input.signal,
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    },
  )
  input.signal?.throwIfAborted()
  if (message.stopReason !== 'stop') {
    throw new HelmxError(
      'model_completion_unavailable',
      `Text completion did not finish cleanly (stopReason=${message.stopReason}${message.errorMessage !== undefined ? `: ${deps.stash.redact(String(message.errorMessage)).slice(0, 200)}` : ''}); refusing to return partial text`,
      502,
      { stopReason: message.stopReason },
    )
  }
  const text = (message.content as Array<{ type?: string; text?: string }>)
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
  return deps.stash.redact(text)
}
