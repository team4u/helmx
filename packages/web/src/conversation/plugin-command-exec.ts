/**
 * Shared plugin slash-command dispatch helper for Conversation Composer and AgentStandbyPane:
 * handles local command-registry invocation vs remote action invocation, generation guards,
 * optimistic draft clear/token removal, and untouched-draft rollback on error.
 */
import type { HelmxLocale } from '@helmx/protocol/browser'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import { executePluginSlashAction, type QualifiedCommand } from '../lib/commands-model.js'
import type { ToastNotice } from '../lib/types.js'
import { errorText } from '../lib/error-text.js'
import type { ComposerCommandRegistry } from '@helmx/plugin-client'

export interface PluginCommandDispatchOptions {
  cmd: QualifiedCommand
  generation: number
  isCurrentGeneration: (gen: number) => boolean
  commandRegistry?: ComposerCommandRegistry | null
  conversationId?: number
  invokePluginAction: (pluginId: string, actionId: string, input: unknown, conversationId?: number) => Promise<unknown>
  pushNotice: (notice: Omit<ToastNotice, 'id' | 'createdAt'>) => void
  locale: HelmxLocale
  t: WebMessageTranslator
  applyDraftUpdate: () => void
  restoreDraftIfUntouched: () => void
  setPending: (pending: boolean, command: QualifiedCommand | null) => void
  afterStateChange?: () => void
  awaitLocalResult?: boolean
  noticeTarget?: ToastNotice['target']
}

export async function dispatchPluginSlashCommand(opts: PluginCommandDispatchOptions): Promise<void> {
  const {
    cmd,
    generation,
    isCurrentGeneration,
    commandRegistry,
    conversationId,
    invokePluginAction,
    pushNotice,
    locale,
    t,
    applyDraftUpdate,
    restoreDraftIfUntouched,
    setPending,
    afterStateChange,
    awaitLocalResult = false,
    noticeTarget,
  } = opts

  if (commandRegistry?.has(cmd.pluginId, cmd.spec.id)) {
    applyDraftUpdate()
    afterStateChange?.()
    const notifyFailure = (err: unknown): void => {
      restoreDraftIfUntouched()
      pushNotice({
        type: 'notification',
        level: 'error',
        title: t('composer.command.failed', { command: `/${cmd.spec.slash ?? cmd.spec.id}` }),
        body: errorText(err),
        ...(noticeTarget !== undefined ? { target: noticeTarget } : {}),
      })
    }
    try {
      const invoked = commandRegistry.invoke(cmd.pluginId, cmd.spec.id)
      if (invoked.handled) {
        if (
          invoked.result !== undefined &&
          invoked.result !== null &&
          typeof (invoked.result as PromiseLike<void>).then === 'function'
        ) {
          if (awaitLocalResult) {
            await invoked.result
          } else {
            void Promise.resolve(invoked.result).catch(notifyFailure)
          }
        }
        return
      }
    } catch (error) {
      notifyFailure(error)
      throw error
    }
  }

  setPending(true, cmd)
  applyDraftUpdate()
  afterStateChange?.()
  try {
    await executePluginSlashAction(cmd, {
      invokePluginAction,
      pushNotice,
      locale,
      t,
      ...(conversationId !== undefined ? { conversationId } : {}),
    })
  } catch (error) {
    restoreDraftIfUntouched()
    throw error
  } finally {
    if (isCurrentGeneration(generation)) {
      setPending(false, null)
      afterStateChange?.()
    }
  }
}
