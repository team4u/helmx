/**
 * Draft concern of the composer send pipeline: prefill consumption (edit-and-resend,
 * starters), conversation-switch reset, and every wholesale / incremental mutation of the
 * draft triple. Each mutation mirrors the live draft version so post-await readers never
 * act on a stale render snapshot.
 */
import { useCallback, useEffect, useRef } from 'react'
import { insertAtCaret } from '../../lib/commands-model.js'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import type { HelmxStoreActions } from '../../lib/store/types.js'
import { focusWithCaret } from '../composer-controller.js'
import {
  attachmentsOfEditTarget,
  isHistoricalEdit,
  type PendingAttachment,
} from '../composer-model.js'
import type { EditRequestTarget } from '../timeline-model.js'
import type { ComposerSendCore } from './core.js'
import type { ComposerPrefill, ComposerSendInput } from './types.js'

export interface ComposerDraft {
  readonly text: string
  readonly attachments: PendingAttachment[]
  readonly editingEntryId: number | null
  /** Replace the whole draft text (advances the live draft version like user
   * typing; anchor/attachments untouched). */
  readonly setDraftState: (next: string) => void
  /** Insert a fragment at the caret (focusWithCaret restores the caret). */
  readonly insertTextState: (fragment: string) => void
  /** Remove one pending attachment (synchronously advances the live draft version). */
  readonly removeAttachment: (artifactId: string) => void
  /** ↑ history edit: wholesale replacement of text / anchor / attachments
   * (an empty attachment list clears the old draft). */
  readonly applyHistoryEdit: (target: EditRequestTarget) => void
  /** Exit history-edit mode and clear the draft. */
  readonly cancelEdit: () => void
  /** Live draft text (for render-time reads such as the controller). */
  readonly readLiveDraft: () => string
}

export function useComposerDraft(
  core: ComposerSendCore,
  input: ComposerSendInput,
  t: WebMessageTranslator,
  pushNotice: HelmxStoreActions['pushNotice'],
): ComposerDraft {
  const { conversation, prefill, textareaRef } = input
  const {
    text,
    attachments,
    editingEntryId,
    setText,
    setAttachments,
    setEditingEntryId,
    liveDraftRef,
    syncLiveDraft,
    sendingRef,
    uploadingRef,
    commandPendingRef,
    commandGenRef,
    setRunningCommand,
    mountedRef,
  } = core

  // Consume each prefill request at most once (by reference and tick):
  // <Activity> keep-alive re-runs effects on wake while preserving parent
  // prefill state, and locale/callback dep updates must never re-inject an
  // already sent or manually cleared prefill back into the textarea.
  const lastPrefillRef = useRef<ComposerPrefill | null>(null)
  const lastPrefillTickRef = useRef<number | null>(null)
  const prevConversationIdRef = useRef(conversation.id)

  // Leaving history-edit mode only when the conversation actually switches
  // (<Activity> wake re-runs effects for the same conversation.id and must
  // preserve any in-progress history edit). In-flight command bookkeeping of
  // the previous conversation is retired with it.
  useEffect(() => {
    if (prevConversationIdRef.current === conversation.id) return
    prevConversationIdRef.current = conversation.id
    lastPrefillRef.current = null
    lastPrefillTickRef.current = null
    commandGenRef.current += 1
    commandPendingRef.current = false
    setEditingEntryId(null)
    setRunningCommand(null)
  }, [conversation.id])

  // Prefill (edit and resend): any prefill reference change triggers it, and
  // repeated prefills of the same text also apply. Each picked edit target
  // wholly replaces the attachments (cleared when the target has none);
  // residue from the previous target is never kept.
  useEffect(() => {
    if (prefill === null) return
    if (prefill === lastPrefillRef.current || prefill.tick === lastPrefillTickRef.current) return
    lastPrefillRef.current = prefill
    lastPrefillTickRef.current = prefill.tick
    // onlyIfEmpty: refuse prefill while the draft is non-empty/editing/in
    // flight (read via ref; no extra effect deps).
    if (prefill.onlyIfEmpty === true) {
      const live = liveDraftRef.current
      if (
        live.text.trim() !== '' ||
        live.attachments.length > 0 ||
        live.targetEntryId !== null ||
        sendingRef.current ||
        uploadingRef.current > 0 ||
        commandPendingRef.current
      ) {
        pushNotice({
          type: 'notification',
          level: 'warning',
          title: t('composer.draft.handleBeforeStarter'),
          target: { kind: 'conversation', conversationId: conversation.id },
        })
        return
      }
    }
    const target = { text: prefill.text, ...(prefill.entryId !== undefined ? { entryId: prefill.entryId } : {}), ...(prefill.attachments !== undefined ? { attachments: prefill.attachments } : {}) }
    const nextEditing = isHistoricalEdit(target) ? prefill.entryId! : null
    const nextAttachments = attachmentsOfEditTarget(target)
    setText(prefill.text)
    setEditingEntryId(nextEditing)
    setAttachments(nextAttachments)
    syncLiveDraft(prefill.text, nextEditing, nextAttachments)
    textareaRef.current?.focus()
  }, [prefill, syncLiveDraft, t, pushNotice, conversation.id, textareaRef])

  const cancelEdit = useCallback((): void => {
    setEditingEntryId(null)
    setText('')
    setAttachments([])
    syncLiveDraft('', null, [])
  }, [syncLiveDraft])

  const setDraftState = useCallback((next: string): void => {
    setText(next)
    syncLiveDraft(next, editingEntryId, attachments)
  }, [editingEntryId, attachments, syncLiveDraft])

  const insertTextState = useCallback((fragment: string): void => {
    const el = textareaRef.current
    const currentText = liveDraftRef.current.text
    if (el === null) {
      const appended = currentText + fragment
      setText(appended)
      syncLiveDraft(appended, editingEntryId, attachments)
      return
    }
    const caret = el.selectionStart ?? currentText.length
    const { next, nextCaret } = insertAtCaret(currentText, caret, fragment, el.selectionEnd ?? caret)
    setText(next)
    syncLiveDraft(next, editingEntryId, attachments)
    focusWithCaret(el, nextCaret)
  }, [editingEntryId, attachments, syncLiveDraft, textareaRef])

  const removeAttachment = useCallback((artifactId: string): void => {
    setAttachments((prev) => {
      const next = prev.filter((a) => a.artifactId !== artifactId)
      syncLiveDraft(liveDraftRef.current.text, liveDraftRef.current.targetEntryId, next)
      return next
    })
  }, [syncLiveDraft])

  const applyHistoryEdit = useCallback((target: EditRequestTarget): void => {
    setText(target.text)
    setEditingEntryId(target.entryId ?? null)
    // Entering a history edit also wholly replaces attachments (an empty list
    // clears the old draft).
    setAttachments(attachmentsOfEditTarget(target))
    syncLiveDraft(target.text, target.entryId ?? null, attachmentsOfEditTarget(target))
    requestAnimationFrame(() => {
      if (mountedRef.current) textareaRef.current?.focus()
    })
  }, [syncLiveDraft, textareaRef])

  const readLiveDraft = useCallback((): string => liveDraftRef.current.text, [])

  return {
    text,
    attachments,
    editingEntryId,
    setDraftState,
    insertTextState,
    removeAttachment,
    applyHistoryEdit,
    cancelEdit,
    readLiveDraft,
  }
}
