/**
 * builtin:title: silent first-turn conversation titling + `/title` on-demand refresh command.
 */
import { HelmxError, type PluginDefinition } from '@helmx/protocol'
import {
  asDeletedConversationId,
  errorMessageOf,
  getConversationOrUndefined,
  resolveTargetConversationId,
} from './shared-helpers.js'
import {
  TITLE_ACTION_GENERATE,
  TITLE_COMMAND_ID,
  TITLE_COMMAND_SLASH,
  TITLE_PLUGIN_ID,
  type TitleGenerateResult,
  type TitlePluginConfig,
  type TitlePluginOptions,
} from './title/contracts.js'
import {
  TITLE_DEFAULT_TIMEOUT_MS,
  TITLE_MAX_TOKENS,
  TITLE_SYSTEM_PROMPT,
  buildTitleUserPrompt,
  extractTitleTranscript,
  isAutoTitleCandidate,
  parseGeneratedTitle,
} from './title/generator.js'

export {
  TITLE_ACTION_GENERATE,
  TITLE_COMMAND_ID,
  TITLE_COMMAND_SLASH,
  TITLE_PLUGIN_ID,
  type TitleGenerateResult,
  type TitlePluginConfig,
  type TitlePluginOptions,
} from './title/contracts.js'
export {
  TITLE_DEFAULT_TIMEOUT_MS,
  TITLE_HARD_REJECT_CHARS,
  TITLE_MAX_CHARS,
  TITLE_MAX_MESSAGES,
  TITLE_MAX_TOKENS,
  TITLE_MIN_CHARS,
  TITLE_PER_MESSAGE_CAP_CHARS,
  TITLE_SYSTEM_PROMPT,
  TITLE_TRANSCRIPT_BUDGET_CHARS,
  buildTitleUserPrompt,
  extractTitleTranscript,
  isAutoTitleCandidate,
  parseGeneratedTitle,
  type AutoTitleEligibility,
  type ExtractedTitleTranscript,
  type TitleTranscriptTurn,
} from './title/generator.js'

interface AutoWriteGuard {
  expectedTitle: string
  firstTurnHumanCount: number
  settledCompletionSeq: number
  settledLastEntryId: number | undefined
}

interface TrackedTask<T> {
  controller: AbortController
  promise: Promise<T>
}

function titleAbortedError(conversationId: number): HelmxError {
  return new HelmxError(
    'title_aborted',
    `Title generation for conversation ${conversationId} was aborted before completing`,
    409,
    { conversationId },
  )
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  makeError: () => HelmxError,
): Promise<T> {
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(makeError())
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  aborted.catch(() => undefined)
  try {
    return await Promise.race([promise, aborted])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

export function createTitlePlugin(options: TitlePluginOptions = {}): PluginDefinition {
  const modelTimeoutMs = options.modelTimeoutMs ?? TITLE_DEFAULT_TIMEOUT_MS

  return {
    id: TITLE_PLUGIN_ID,
    name: { en: 'Conversation Title', 'zh-CN': '会话标题' },
    description: {
      en: 'Silently summarizes a clear title after the first turn and provides the /title command to refresh it on demand.',
      'zh-CN': '首轮对话结束后后台静默整理清晰标题，并提供 /title 命令随时按当前内容重新整理。',
    },
    icon: 'edit-3',
    version: '0.1.0',
    definePlugin(ctx) {
      ctx.configSchema({
        autoTitle: {
          type: 'boolean',
          default: true,
          label: { en: 'Auto-title first turn', 'zh-CN': '首轮静默自动命名' },
          description: {
            en: 'Silently summarize a concise title after the first completed human turn when no custom title was set.',
            'zh-CN': '在人类顶层会话首轮完成后，若未自定义标题，则后台静默整理简洁标题。',
          },
        },
        model: {
          type: 'string',
          format: 'model',
          default: '',
          label: { en: 'Title model', 'zh-CN': '标题整理模型' },
          description: {
            en: 'Optional model or tier (e.g. tier/fast) used for title generation; leave empty to follow the conversation model.',
            'zh-CN': '标题整理使用的模型或档位（如 tier/fast）；留空则沿用会话当前生效模型。',
          },
        },
      })

      let stopping = false
      const autoTasks = new Map<number, TrackedTask<void>>()
      const manualTasks = new Map<number, TrackedTask<TitleGenerateResult>>()

      const autoTitleEnabled = (): boolean => (ctx.getConfig() as TitlePluginConfig).autoTitle !== false
      const configuredModelOf = (): string | undefined => {
        const raw = (ctx.getConfig() as TitlePluginConfig).model
        return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
      }

      const abortConversationTasks = (conversationId: number): void => {
        autoTasks.get(conversationId)?.controller.abort()
        manualTasks.get(conversationId)?.controller.abort()
      }

      const runGenerate = async (
        conversationId: number,
        mode: 'auto' | 'manual',
        controller: AbortController,
        autoGuard?: AutoWriteGuard,
      ): Promise<TitleGenerateResult | undefined> => {
        if (stopping || controller.signal.aborted) {
          if (mode === 'auto') return undefined
          throw titleAbortedError(conversationId)
        }

        const detail = await ctx.host.getConversationDetail(conversationId, { limit: 100 })
        if (stopping || controller.signal.aborted) {
          if (mode === 'auto') return undefined
          throw titleAbortedError(conversationId)
        }

        const transcript = extractTitleTranscript(detail.entries, (text) => ctx.host.redact(text))
        if (mode === 'auto') {
          if (transcript.turns.length === 0) return undefined
          if (autoGuard !== undefined && transcript.humanInputCount > autoGuard.firstTurnHumanCount) {
            return undefined
          }
        } else if (transcript.turns.length === 0) {
          throw new HelmxError(
            'title_empty_conversation',
            'Conversation has no content to summarize into a title yet',
            400,
            { conversationId },
          )
        }

        const configuredModel = configuredModelOf()
        const deadline = setTimeout(() => controller.abort(), modelTimeoutMs)
        deadline.unref?.()
        let raw: string
        try {
          raw = await raceWithAbort(
            ctx.host.completeText({
              conversationId,
              ...(configuredModel !== undefined ? { model: configuredModel } : {}),
              systemPrompt: TITLE_SYSTEM_PROMPT,
              text: buildTitleUserPrompt(transcript.turns),
              maxTokens: TITLE_MAX_TOKENS,
              signal: controller.signal,
            }),
            controller.signal,
            () => titleAbortedError(conversationId),
          )
        } finally {
          clearTimeout(deadline)
        }

        if (stopping || controller.signal.aborted) {
          if (mode === 'auto') return undefined
          throw titleAbortedError(conversationId)
        }

        const nextTitle = parseGeneratedTitle(ctx.host.redact(raw))

        if (stopping || controller.signal.aborted) {
          if (mode === 'auto') return undefined
          throw titleAbortedError(conversationId)
        }

        const latest =
          mode === 'auto'
            ? getConversationOrUndefined(ctx.host, conversationId)
            : ctx.host.getConversation(conversationId)
        if (latest === undefined) return undefined

        if (mode === 'auto' && autoGuard !== undefined) {
          // Guard on title, pendingAskCount, active status, completionSeq, and lastEntryId rather than
          // stateChangeSeq so routine read-sync (`unread: false`, done -> idle) never vetoes auto-titling,
          // while concurrent AskDoc approvals or new turns safely abort the writeback.
          if (
            latest.title !== autoGuard.expectedTitle ||
            latest.pendingAskCount > 0 ||
            latest.status === 'working' ||
            latest.status === 'blocked' ||
            latest.completionSeq !== autoGuard.settledCompletionSeq ||
            latest.lastEntryId !== autoGuard.settledLastEntryId
          ) {
            return undefined
          }
        }

        if (nextTitle === latest.title) {
          return {
            conversationId,
            previousTitle: latest.title,
            title: latest.title,
            changed: false,
          }
        }

        await ctx.host.updateConversation(conversationId, { title: nextTitle })
        return {
          conversationId,
          previousTitle: latest.title,
          title: nextTitle,
          changed: true,
        }
      }

      ctx.service({
        id: 'title-generator',
        liveTasks: () => [
          ...Array.from(autoTasks.keys(), (id) => `title:auto:${id}`),
          ...Array.from(manualTasks.keys(), (id) => `title:manual:${id}`),
        ],
        start() {
          stopping = false
        },
        async stop() {
          stopping = true
          const pending: Promise<unknown>[] = []
          for (const task of autoTasks.values()) {
            task.controller.abort()
            pending.push(task.promise)
          }
          for (const task of manualTasks.values()) {
            task.controller.abort()
            pending.push(task.promise)
          }
          await Promise.allSettled(pending)
        },
      })

      ctx.host.onEvent('conversation.deleted', (payload) => {
        const conversationId = asDeletedConversationId(payload)
        if (conversationId !== undefined) {
          abortConversationTasks(conversationId)
        }
      })

      ctx.hook.onTurnSettled((payload) => {
        if (stopping) return
        const conversationId = payload.conversation.id
        if (autoTasks.has(conversationId) || manualTasks.has(conversationId)) return

        const decision = isAutoTitleCandidate(payload, autoTitleEnabled())
        if (!decision.eligible) return

        const controller = new AbortController()
        const guard: AutoWriteGuard = {
          expectedTitle: decision.expectedTitle,
          firstTurnHumanCount: decision.firstTurnHumanCount,
          settledCompletionSeq: payload.conversation.completionSeq,
          settledLastEntryId: payload.conversation.lastEntryId,
        }
        let entry!: TrackedTask<void>
        const promise = runGenerate(conversationId, 'auto', controller, guard)
          .then(() => undefined)
          .catch(() => undefined)
          .finally(() => {
            if (autoTasks.get(conversationId) === entry) {
              autoTasks.delete(conversationId)
            }
          })
        entry = { controller, promise }
        autoTasks.set(conversationId, entry)
      })

      ctx.action<{ conversationId?: number }, TitleGenerateResult>({
        id: TITLE_ACTION_GENERATE,
        description:
          'Generate and apply a concise title for a conversation from its current content (--conversation-id or --current)',
        exposeToPrompt: false,
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'integer',
              minimum: 1,
              description: 'Target conversation ID (defaults to current conversation context)',
            },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          required: ['conversationId', 'previousTitle', 'title', 'changed'],
          properties: {
            conversationId: { type: 'integer', description: 'Updated conversation ID' },
            previousTitle: { type: 'string', description: 'Title before generation' },
            title: { type: 'string', description: 'Generated conversation title' },
            changed: { type: 'boolean', description: 'Whether the title changed' },
          },
          additionalProperties: false,
        },
        handler(input, context) {
          const targetId = resolveTargetConversationId(input.conversationId, context)
          if (stopping) {
            throw new HelmxError('plugin_stopping', 'builtin:title is stopping', 409, { conversationId: targetId })
          }

          autoTasks.get(targetId)?.controller.abort()

          const existing = manualTasks.get(targetId)
          if (existing !== undefined) return existing.promise

          const controller = new AbortController()
          let detachAbort: (() => void) | undefined
          if (context.signal !== undefined) {
            const onCallerAbort = () => controller.abort()
            if (context.signal.aborted) {
              controller.abort()
            } else {
              context.signal.addEventListener('abort', onCallerAbort, { once: true })
              detachAbort = () => context.signal?.removeEventListener('abort', onCallerAbort)
            }
          }

          let entry!: TrackedTask<TitleGenerateResult>
          const promise = (async () => {
            try {
              const result = await runGenerate(targetId, 'manual', controller)
              if (result === undefined) throw titleAbortedError(targetId)
              return result
            } catch (err) {
              if (err instanceof HelmxError) throw err
              throw new HelmxError(
                'title_generation_failed',
                ctx.host.redact(errorMessageOf(err)).slice(0, 300),
                502,
                { conversationId: targetId },
              )
            } finally {
              detachAbort?.()
              if (manualTasks.get(targetId) === entry) {
                manualTasks.delete(targetId)
              }
            }
          })()
          entry = { controller, promise }
          manualTasks.set(targetId, entry)
          return promise
        },
      })

      ctx.ui.command({
        id: TITLE_COMMAND_ID,
        title: { en: 'Generate conversation title', 'zh-CN': '整理会话标题' },
        description: {
          en: 'Summarize the current conversation into a concise title',
          'zh-CN': '根据当前对话内容整理合适的会话标题',
        },
        icon: 'edit-3',
        slash: TITLE_COMMAND_SLASH,
        actionId: TITLE_ACTION_GENERATE,
        input: {},
        scope: {},
        keywords: ['title', 'rename', 'name', '标题', '取名', '重命名'],
      })
    },
  }
}
