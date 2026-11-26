/**
 * Slash-command concern of the composer send pipeline:
 * - plugin commands (exact first-token hits and menu-triggered): optimistic trigger/token
 *   removal while the command is in flight, draft restored on failure only if untouched;
 * - session management commands (/new, /clear, /compact) executed immediately on the spot.
 */
import { useCallback } from 'react'
import type { HelmxLocale } from '@helmx/protocol/browser'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import { conversationsApi } from '../../lib/api.js'
import {
  removeTokenBeforeCaret,
  type QualifiedCommand,
} from '../../lib/commands-model.js'
import type { HelmxStoreActions } from '../../lib/store/types.js'
import { useStableCallback } from '../../lib/use-stable-callback.js'
import {
  draftVersionOf,
  parseCompactSlashCommand,
  shouldRestoreEditOnFailure,
} from '../composer-model.js'
import { focusWithCaret } from '../composer-controller.js'
import { dispatchPluginSlashCommand } from '../plugin-command-exec.js'
import type { ComposerSendCore } from './core.js'
import type { ComposerNotices } from './notices.js'
import type { ComposerSendInput } from './types.js'

export interface ComposerSlashCommands {
  /** Active in-flight plugin slash command (null when idle). */
  readonly runningCommand: QualifiedCommand | null
  /** Shared executor: `token` strips the trigger before the caret, `clear` empties the draft
   * (exact first-token hit from `send`), `none` leaves the draft alone; `strict` turns the
   * busy refusal and failures into rejections for the caller. */
  readonly executePluginCommand: (
    cmd: QualifiedCommand,
    mode: 'token' | 'clear' | 'none',
    strict: boolean,
  ) => Promise<void>
  /** Execute a plugin command from the slash menu (optimistic trigger cleanup
   * with rollback on untouched failure; stable identity). */
  readonly runPluginCommand: (cmd: QualifiedCommand) => void
  /** Execute a plugin command triggered outside the text draft (e.g. unified + menu)
   * without stripping any draft token; stable identity. */
  readonly runPluginCommandDirect: (cmd: QualifiedCommand) => void
  /** Session management command (/new, /clear, /compact). Returns true when the payload was
   * consumed as a command. Plain function on purpose: `send` lists it as a dependency. */
  readonly runSlashCommand: (raw: string) => boolean
}

export function useComposerSlashCommands(
  core: ComposerSendCore,
  input: ComposerSendInput,
  ctx: {
    t: WebMessageTranslator
    locale: HelmxLocale
    invokePluginAction: HelmxStoreActions['invokePluginAction']
    pushNotice: HelmxStoreActions['pushNotice']
    notices: ComposerNotices
  },
): ComposerSlashCommands {
  const { conversation, onNewThread, textareaRef, commandRegistry } = input
  const { t, locale, invokePluginAction, pushNotice } = ctx
  const { notifyErrorFor } = ctx.notices
  const {
    attachments,
    setText,
    liveDraftRef,
    syncLiveDraft,
    runningCommand,
    setRunningCommand,
    commandPendingRef,
    commandGenRef,
    isActiveConversation,
    isActiveMountedConversation,
    publishHiddenDirty,
  } = core

  // Optimistically remove the trigger/command text while tracking an in-flight
  // command state; restore the original draft on failure only if the user has
  // not modified it in the meantime.
  const executePluginCommand = useCallback(
    async (cmd: QualifiedCommand, mode: 'token' | 'clear' | 'none', strict: boolean): Promise<void> => {
      if (commandPendingRef.current) {
        if (strict) throw new Error(t('composer.send.busyOrEmpty'))
        return
      }
      const targetConversationId = conversation.id
      const gen = ++commandGenRef.current
      const el = textareaRef.current
      const before = liveDraftRef.current
      const currentTarget = before.targetEntryId
      const caret = el?.selectionStart ?? before.text.length
      const resolved = mode === 'token' ? removeTokenBeforeCaret(before.text, caret) : { next: '', nextCaret: 0 }
      const expectedAfterClear = draftVersionOf(resolved.next, currentTarget, attachments)

      try {
        await dispatchPluginSlashCommand({
          cmd,
          generation: gen,
          isCurrentGeneration: (currentGen) => currentGen === commandGenRef.current,
          commandRegistry,
          conversationId: targetConversationId,
          invokePluginAction,
          pushNotice,
          locale,
          t,
          awaitLocalResult: true,
          noticeTarget: { kind: 'conversation', conversationId: targetConversationId },
          applyDraftUpdate: () => {
            if (mode !== 'none' && isActiveMountedConversation(targetConversationId)) {
              setText(resolved.next)
              syncLiveDraft(resolved.next, currentTarget, attachments)
              if (mode === 'token' && el !== null && el.isConnected) {
                focusWithCaret(el, resolved.nextCaret)
              }
            }
          },
          restoreDraftIfUntouched: () => {
            if (
              mode !== 'none' &&
              isActiveMountedConversation(targetConversationId) &&
              gen === commandGenRef.current &&
              shouldRestoreEditOnFailure(liveDraftRef.current, expectedAfterClear)
            ) {
              setText(before.text)
              syncLiveDraft(before.text, currentTarget, attachments)
            }
          },
          setPending: (pending, command) => {
            commandPendingRef.current = pending
            if (isActiveConversation(targetConversationId)) setRunningCommand(command)
          },
          afterStateChange: () => {
            if (isActiveConversation(targetConversationId)) publishHiddenDirty()
          },
        })
      } catch (error) {
        if (strict) throw error
      }
    },
    [
      attachments,
      commandRegistry,
      conversation.id,
      invokePluginAction,
      isActiveConversation,
      isActiveMountedConversation,
      locale,
      publishHiddenDirty,
      pushNotice,
      syncLiveDraft,
      t,
      textareaRef,
    ],
  )

  const runPluginCommandImpl = useCallback((cmd: QualifiedCommand): void => {
    void executePluginCommand(cmd, 'token', false)
  }, [executePluginCommand])
  const runPluginCommandDirectImpl = useCallback((cmd: QualifiedCommand): void => {
    void executePluginCommand(cmd, 'none', false)
  }, [executePluginCommand])
  // Slash menu entries persist across renders: the entry point takes the
  // latest implementation through a stable wrapper (instead of writing a
  // latest ref during render).
  const runPluginCommand = useStableCallback(runPluginCommandImpl)
  const runPluginCommandDirect = useStableCallback(runPluginCommandDirectImpl)

  const runSlashCommand = (raw: string): boolean => {
    const cmd = raw.trim()
    if (cmd === '/new') {
      // /new is the new-topic entry: navigate to this agent's standby pane
      // (the conversation is only created on first send) without resetting the
      // original one; when no callback is provided (a non-conversation host),
      // notify explicitly — never guess a target or harm the original
      // conversation.
      if (onNewThread !== undefined) {
        onNewThread()
      } else {
        pushNotice({
          type: 'notification',
          level: 'warning',
          title: t('composer.send.newTopicFromTopBar'),
          target: { kind: 'conversation', conversationId: conversation.id },
        })
      }
      return true
    }
    if (cmd === '/clear') {
      const targetConversationId = conversation.id
      void conversationsApi
        .reset(targetConversationId)
        .then(() => {
          if (!isActiveMountedConversation(targetConversationId)) return
          pushNotice({
            type: 'notification',
            level: 'info',
            title: t('composer.compaction.resetDone'),
            target: { kind: 'conversation', conversationId: targetConversationId },
          })
        })
        .catch((err: unknown) => {
          if (isActiveMountedConversation(targetConversationId)) {
            notifyErrorFor(targetConversationId, t('composer.compaction.resetFailed'), err)
          }
        })
      return true
    }
    const compactCmd = parseCompactSlashCommand(cmd)
    if (compactCmd !== null) {
      if (conversation.contextUsage?.compacting === true) {
        pushNotice({
          type: 'notification',
          level: 'info',
          title: t('composer.compaction.inProgress'),
          target: { kind: 'conversation', conversationId: conversation.id },
        })
        return true
      }
      const targetConversationId = conversation.id
      void conversationsApi
        .compact(targetConversationId, compactCmd.instructions)
        .then(() => {
          if (!isActiveMountedConversation(targetConversationId)) return
          pushNotice({
            type: 'notification',
            level: 'info',
            title: t('composer.compaction.submitted'),
            target: { kind: 'conversation', conversationId: targetConversationId },
          })
        })
        .catch((err: unknown) => {
          if (isActiveMountedConversation(targetConversationId)) {
            notifyErrorFor(targetConversationId, t('composer.compaction.failed'), err)
          }
        })
      return true
    }
    return false
  }

  return { runningCommand, executePluginCommand, runPluginCommand, runPluginCommandDirect, runSlashCommand }
}
