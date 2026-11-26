/**
 * Send pipeline of the composer: the host's real send (gating, plugin command / session
 * command dispatch, optimistic clear with rollback by live draft version, whenBusy policy),
 * explicit text submission, and the queued-input withdraw re-edit.
 */
import { useCallback } from 'react'
import type { QueuedConversationInput, WhenBusy } from '@helmx/protocol/browser'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import { conversationsApi } from '../../lib/api.js'
import { matchExactPluginSlash } from '../../lib/commands-model.js'
import type { HelmxStoreActions } from '../../lib/store/types.js'
import {
  draftVersionOf,
  shouldRestoreEditOnFailure,
} from '../composer-model.js'
import type { EditRequestTarget } from '../timeline-model.js'
import type { ComposerSendCore } from './core.js'
import type { ComposerDraft } from './draft.js'
import type { ComposerEnvBlocker } from './env-blocker.js'
import type { ComposerNotices } from './notices.js'
import type { ComposerSlashCommands } from './slash-commands.js'
import type { ComposerSendInput } from './types.js'

export interface ComposerSendPipeline {
  /** A real send request is in flight (optimistic clear already applied). */
  readonly sending: boolean
  /** Host's real send flow (optimistic clear + rollback by live draft version
   * on failure + whenBusy policy). */
  readonly send: (busyMode?: WhenBusy, strict?: boolean) => Promise<void>
  /** Submit explicit text (consumes no draft / edit anchor / attachments;
   * rejects honestly on failure). */
  readonly sendExplicit: (raw: string, whenBusy?: WhenBusy) => Promise<void>
  /** ↑ queued-withdraw re-edit: withdraws the newest human queued input from
   * queuedInputs and prefills the draft (no history-rollback banner). */
  readonly withdrawQueuedInput: (queued: QueuedConversationInput) => Promise<void>
}

export function useComposerSendPipeline(
  core: ComposerSendCore,
  input: ComposerSendInput,
  ctx: {
    t: WebMessageTranslator
    pushNotice: HelmxStoreActions['pushNotice']
    notices: ComposerNotices
    env: ComposerEnvBlocker
    commands: ComposerSlashCommands
    draft: ComposerDraft
  },
): ComposerSendPipeline {
  const { conversation, onSendingChange, slashPluginCommands, working } = input
  const { t, pushNotice } = ctx
  const { notifyErrorFor } = ctx.notices
  const { envBlocker } = ctx.env
  const { executePluginCommand, runSlashCommand } = ctx.commands
  const { applyHistoryEdit } = ctx.draft
  const {
    attachments,
    editingEntryId,
    sending,
    setSending,
    sendingRef,
    uploadingRef,
    commandPendingRef,
    withdrawingRef,
    liveDraftRef,
    syncLiveDraft,
    setText,
    setAttachments,
    setEditingEntryId,
    envBlockedRef,
    mountedRef,
    isActiveConversation,
    isActiveMountedConversation,
    publishHiddenDirty,
  } = core

  /** ↑ queued-withdraw re-edit: withdraw the newest human queued input from
   * pi.inbox first, then prefill text and attachments. */
  const withdrawQueuedInput = useCallback(async (queued: QueuedConversationInput): Promise<void> => {
    if (withdrawingRef.current || sendingRef.current || uploadingRef.current > 0 || commandPendingRef.current) return
    const targetConversationId = conversation.id
    withdrawingRef.current = true
    try {
      const res = await conversationsApi.withdraw(targetConversationId, queued.submissionId)
      if (!isActiveMountedConversation(targetConversationId)) return
      const baseTarget: EditRequestTarget = {
        text: queued.text,
        ...(queued.attachments !== undefined && queued.attachments.length > 0
          ? { attachments: queued.attachments }
          : {}),
      }
      const live = liveDraftRef.current
      const draftModified = live.text !== '' || live.targetEntryId !== null
      if (res.status === 'withdrawn') {
        if (draftModified) {
          pushNotice({
            type: 'notification',
            level: 'info',
            title: t('composer.send.withdrawnTitle'),
            body: t('composer.send.withdrawnBody', { text: queued.text }),
            target: { kind: 'conversation', conversationId: targetConversationId },
          })
          return
        }
        applyHistoryEdit(baseTarget)
      } else if ((res.status === 'already_placed' || res.status === 'settled') && res.entryId !== undefined) {
        if (draftModified) {
          pushNotice({
            type: 'notification',
            level: 'warning',
            title: t('composer.send.enteredExecutionTitle'),
            body: t('composer.send.enteredExecutionBody'),
            target: { kind: 'conversation', conversationId: targetConversationId },
          })
          return
        }
        applyHistoryEdit({ ...baseTarget, entryId: res.entryId })
      } else {
        pushNotice({
          type: 'notification',
          level: 'warning',
          title: t('composer.send.cannotWithdrawTitle'),
          body: t('composer.send.cannotWithdrawBody', { status: res.status }),
          target: { kind: 'conversation', conversationId: targetConversationId },
        })
      }
    } catch (err) {
      if (isActiveMountedConversation(targetConversationId)) {
        notifyErrorFor(targetConversationId, t('composer.send.withdrawFailed'), err)
      }
    } finally {
      withdrawingRef.current = false
    }
  }, [conversation.id, applyHistoryEdit, isActiveMountedConversation, notifyErrorFor, pushNotice, t])

  const send = useCallback(async (busyMode: WhenBusy = 'steer', strict = false): Promise<void> => {
    const draft = liveDraftRef.current.text
    const payload = draft.trim()
    if (payload === '' || sendingRef.current || uploadingRef.current > 0 || commandPendingRef.current) {
      if (strict) throw new Error(t('composer.send.busyOrEmpty'))
      return
    }
    const targetConversationId = conversation.id
    // Sending is disallowed while the environment is unsaved or still saving
    // (covers both Enter and the send button).
    if (envBlockedRef.current) {
      pushNotice({
        type: 'notification',
        level: 'warning',
        title: t('composer.env.saveOrCancelFirst'),
        body: envBlocker.reason ?? undefined,
        target: { kind: 'conversation', conversationId: targetConversationId },
      })
      if (strict) throw new Error(t('composer.env.saveOrCancelFirst'))
      return
    }
    // Plugin slash commands: executed when the draft's first token exactly
    // hits an in-scope plugin command (non-editing mode only).
    const pluginCmd = matchExactPluginSlash(payload, slashPluginCommands)
    const editing = editingEntryId !== null
    if (!editing && pluginCmd !== undefined) {
      await executePluginCommand(pluginCmd, 'clear', strict)
      return
    }
    // Management commands like /new appearing inside edited text are just the
    // edited message's text, never executed immediately; only non-editing
    // input executes them as session management commands.
    const slash = editing ? false : runSlashCommand(payload)
    if (slash) {
      setText('')
      syncLiveDraft('', editingEntryId, attachments)
      return
    }
    const targetEntryId = editingEntryId
    const sentAttachments = new Set(attachments.map((attachment) => attachment.artifactId))
    // Freeze the draft at the send instant: on failure the rollback only
    // applies while the Composer is still in the expected post-optimistic-clear
    // state (no new input, no other target, no attachment change) — an old
    // target must never bind to new input.
    const frozenDraft = draftVersionOf(draft, targetEntryId, attachments)
    const expectedAfterClear = draftVersionOf('', null, attachments)
    sendingRef.current = true
    setSending(true)
    onSendingChange?.(true)
    setText('')
    // Optimistically exit edit mode; on failure roll back per the frozen version.
    setEditingEntryId(null)
    syncLiveDraft('', null, attachments)
    // Restore text and edit target only while the Composer is still in the
    // expected post-clear state; if the user already started new input or
    // picked another edit target, keep the present state — the old target
    // never flows back.
    const restoreDraftIfUntouched = (): void => {
      if (!shouldRestoreEditOnFailure(liveDraftRef.current, expectedAfterClear)) return
      setText(draft)
      if (frozenDraft.targetEntryId !== null) setEditingEntryId(frozenDraft.targetEntryId)
      syncLiveDraft(draft, frozenDraft.targetEntryId, attachments)
    }
    const notifyFailure = (err: unknown): void => {
      if (!mountedRef.current) return
      notifyErrorFor(
        targetConversationId,
        targetEntryId !== null ? t('composer.send.updateFailed') : t('composer.send.sendFailed'),
        err,
      )
    }
    try {
      await conversationsApi.submitInput(targetConversationId, {
        text: payload,
        origin: 'human',
        ...(targetEntryId !== null ? { replaceFromEntryId: targetEntryId } : working ? { whenBusy: busyMode } : {}),
        ...(attachments.length > 0 ? { attachments: attachments.map((a) => a.artifactId) } : {}),
      })
      if (isActiveConversation(targetConversationId)) {
        liveDraftRef.current = {
          ...liveDraftRef.current,
          attachments: liveDraftRef.current.attachments.filter((artifactId) => !sentAttachments.has(artifactId)),
        }
        setAttachments((current) => current.filter((attachment) => !sentAttachments.has(attachment.artifactId)))
      }
    } catch (err) {
      if (isActiveConversation(targetConversationId)) {
        restoreDraftIfUntouched()
        notifyFailure(err)
      }
      if (strict) throw err
    } finally {
      sendingRef.current = false
      if (isActiveConversation(targetConversationId)) {
        setSending(false)
        publishHiddenDirty()
      }
      onSendingChange?.(false)
    }
  }, [
    attachments,
    editingEntryId,
    working,
    runSlashCommand,
    syncLiveDraft,
    onSendingChange,
    notifyErrorFor,
    pushNotice,
    conversation.id,
    envBlocker,
    executePluginCommand,
    isActiveConversation,
    slashPluginCommands,
    publishHiddenDirty,
    t,
  ])

  // Explicit text submission: consumes no draft / edit anchor / attachments
  // (content not typed by the user, e.g. plugin command output). Shares the
  // sendingRef concurrency guard and onSendingChange in-flight feedback with
  // send; rejects honestly on failure.
  const sendExplicit = useCallback(async (raw: string, whenBusy?: WhenBusy): Promise<void> => {
    const payload = raw.trim()
    if (payload === '' || sendingRef.current || uploadingRef.current > 0) {
      throw new Error(t('composer.send.busyOrEmpty'))
    }
    const targetConversationId = conversation.id
    if (envBlockedRef.current) {
      pushNotice({
        type: 'notification',
        level: 'warning',
        title: t('composer.env.saveOrCancelFirst'),
        body: envBlocker.reason ?? undefined,
        target: { kind: 'conversation', conversationId: targetConversationId },
      })
      throw new Error(t('composer.env.saveOrCancelFirst'))
    }
    sendingRef.current = true
    setSending(true)
    onSendingChange?.(true)
    try {
      await conversationsApi.submitInput(targetConversationId, {
        text: payload,
        origin: 'human',
        ...(working ? { whenBusy: whenBusy ?? 'steer' } : {}),
      })
    } catch (err) {
      if (isActiveMountedConversation(targetConversationId)) {
        notifyErrorFor(targetConversationId, t('composer.send.sendFailed'), err)
      }
      throw err
    } finally {
      sendingRef.current = false
      if (isActiveConversation(targetConversationId)) {
        setSending(false)
        publishHiddenDirty()
      }
      onSendingChange?.(false)
    }
  }, [working, onSendingChange, notifyErrorFor, pushNotice, conversation.id, envBlocker, isActiveConversation, isActiveMountedConversation, publishHiddenDirty, t])

  return { sending, send, sendExplicit, withdrawQueuedInput }
}
