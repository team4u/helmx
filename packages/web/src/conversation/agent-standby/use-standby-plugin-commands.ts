/**
 * Plugin slash commands of the standby pane: the panel-local command registry (claims
 * interactive commands before the action RPC), in-flight command state, and the executor
 * with optimistic trigger removal restored on failure only while the draft is untouched.
 * Switching drafts (profile / environment) retires the previous command generation.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { createComposerCommandRegistry, type ComposerCommandRegistry } from '@helmx/plugin-client'
import type { HelmxLocale } from '@helmx/protocol/browser'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import { removeTokenBeforeCaret, type QualifiedCommand } from '../../lib/commands-model.js'
import type { HelmxStoreActions } from '../../lib/store/types.js'
import { useStableCallback } from '../../lib/use-stable-callback.js'
import { focusWithCaret } from '../composer-controller.js'
import { dispatchPluginSlashCommand } from '../plugin-command-exec.js'
import {
  currentStandbyDraftEpoch,
  getStandbyDraft,
  updateStandbyDraft,
} from '../standby-model.js'

export interface StandbyPluginCommands {
  readonly commandRegistry: ComposerCommandRegistry
  readonly commandRegistryVersion: number
  /** Active in-flight plugin command (null when idle). */
  readonly runningCommand: QualifiedCommand | null
  /** In-flight sentinel read by the submit decision (ref, never a stale render snapshot). */
  readonly commandPendingRef: RefObject<boolean>
  /** `token` strips the trigger before the caret; `clear` empties the draft (exact hit). */
  readonly executeStandbyPluginCommand: (cmd: QualifiedCommand, mode: 'token' | 'clear') => void
  /** Slash-menu entry (stable identity). */
  readonly runPluginCommand: (cmd: QualifiedCommand) => void
}

export function useStandbyPluginCommands(input: {
  draftKey: string
  textareaRef: RefObject<HTMLTextAreaElement | null>
  invokePluginAction: HelmxStoreActions['invokePluginAction']
  pushNotice: HelmxStoreActions['pushNotice']
  locale: HelmxLocale
  t: WebMessageTranslator
}): StandbyPluginCommands {
  const { draftKey, textareaRef, invokePluginAction, pushNotice, locale, t } = input
  const [commandRegistry] = useState(() => createComposerCommandRegistry())
  const commandRegistryVersion = useSyncExternalStore(
    commandRegistry.subscribe,
    commandRegistry.getVersion,
    commandRegistry.getVersion,
  )
  const commandPendingRef = useRef(false)
  const [runningCommand, setRunningCommand] = useState<QualifiedCommand | null>(null)
  const commandGenRef = useRef(0)
  const prevDraftKeyRef = useRef(draftKey)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  useEffect(() => {
    if (prevDraftKeyRef.current === draftKey) return
    prevDraftKeyRef.current = draftKey
    commandGenRef.current += 1
    commandPendingRef.current = false
    setRunningCommand(null)
  }, [draftKey])

  const executeStandbyPluginCommand = useCallback((cmd: QualifiedCommand, mode: 'token' | 'clear'): void => {
    const record = getStandbyDraft(draftKey)
    if (commandPendingRef.current || record.sending) return
    const gen = ++commandGenRef.current
    const el = textareaRef.current
    const epoch = currentStandbyDraftEpoch()
    const beforeText = record.text
    const caret = el?.selectionStart ?? beforeText.length
    const resolved = mode === 'token' ? removeTokenBeforeCaret(beforeText, caret) : { next: '', nextCaret: 0 }
    const restoreDraftIfUntouched = (): void => {
      if (
        mountedRef.current &&
        epoch === currentStandbyDraftEpoch() &&
        gen === commandGenRef.current &&
        getStandbyDraft(draftKey).text === resolved.next
      ) {
        updateStandbyDraft(draftKey, { text: beforeText })
      }
    }
    const applyDraftUpdate = (): void => {
      updateStandbyDraft(draftKey, { text: resolved.next })
      if (mode === 'token' && el !== null && el.isConnected) focusWithCaret(el, resolved.nextCaret)
    }

    void dispatchPluginSlashCommand({
      cmd,
      generation: gen,
      isCurrentGeneration: (g) => g === commandGenRef.current,
      commandRegistry,
      ...(record.conversationId !== undefined ? { conversationId: record.conversationId } : {}),
      invokePluginAction,
      pushNotice,
      locale,
      t,
      applyDraftUpdate,
      restoreDraftIfUntouched,
      setPending: (pending, command) => {
        commandPendingRef.current = pending
        if (mountedRef.current) setRunningCommand(command)
      },
      ...(record.conversationId !== undefined
        ? { noticeTarget: { kind: 'conversation' as const, conversationId: record.conversationId } }
        : {}),
    }).catch(() => {})
  }, [commandRegistry, draftKey, invokePluginAction, locale, pushNotice, t])

  const runPluginCommand = useStableCallback((cmd: QualifiedCommand): void => {
    executeStandbyPluginCommand(cmd, 'token')
  })

  return { commandRegistry, commandRegistryVersion, runningCommand, commandPendingRef, executeStandbyPluginCommand, runPluginCommand }
}
