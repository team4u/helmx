/**
 * Shared primitive layer of the composer send pipeline: the draft triple state with its live
 * draft version, the in-flight sentinels (state drives render, refs are read after awaits),
 * the environment block, and the conversation identity guards. The concern hooks (env
 * blocker / draft / upload / slash commands / send pipeline / dirty report) compose on top
 * of it and never re-declare these primitives, so the hook order of the composed
 * `useComposerSend` stays the one the single hook had before the split.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import type { QualifiedCommand } from '../../lib/commands-model.js'
import {
  draftVersionOf,
  ENV_BLOCKER_CLEAR,
  type ComposerDraftVersion,
  type PendingAttachment,
  type SessionEnvBlocker,
} from '../composer-model.js'
import type { ComposerDirtySnapshot } from '../composer-dirty.js'
import type { ComposerSendInput } from './types.js'

export interface ComposerSendCore {
  readonly conversationId: number
  /** Draft triple (text / edit anchor / attachments). */
  readonly text: string
  readonly setText: Dispatch<SetStateAction<string>>
  readonly attachments: PendingAttachment[]
  readonly setAttachments: Dispatch<SetStateAction<PendingAttachment[]>>
  readonly editingEntryId: number | null
  readonly setEditingEntryId: Dispatch<SetStateAction<number | null>>
  /** Live draft version mirrored from the triple; read after awaits, never from stale closures. */
  readonly liveDraftRef: MutableRefObject<ComposerDraftVersion>
  readonly syncLiveDraft: (
    text: string,
    target: number | null,
    attachments: ReadonlyArray<PendingAttachment>,
  ) => void
  /** In-flight sentinels shared by send / upload / plugin commands. */
  readonly sending: boolean
  readonly setSending: Dispatch<SetStateAction<boolean>>
  readonly sendingRef: MutableRefObject<boolean>
  readonly uploading: number
  readonly setUploading: Dispatch<SetStateAction<number>>
  readonly uploadingRef: MutableRefObject<number>
  readonly runningCommand: QualifiedCommand | null
  readonly setRunningCommand: Dispatch<SetStateAction<QualifiedCommand | null>>
  readonly commandPendingRef: MutableRefObject<boolean>
  readonly commandGenRef: MutableRefObject<number>
  readonly withdrawingRef: MutableRefObject<boolean>
  /** Environment block (SessionEnvBar report); the ref is the send-time gate. */
  readonly envBlocker: SessionEnvBlocker
  readonly setEnvBlocker: Dispatch<SetStateAction<SessionEnvBlocker>>
  readonly envBlockedRef: MutableRefObject<boolean>
  /** Identity guards for post-await write-backs. */
  readonly mountedRef: MutableRefObject<boolean>
  readonly isActiveConversation: (targetConversationId: number) => boolean
  readonly isActiveMountedConversation: (targetConversationId: number) => boolean
  /** Re-publishes the dirty snapshot to the keep-alive window sink after an in-flight change
   * settled outside render. */
  readonly publishHiddenDirty: () => void
}

export function useComposerSendCore(input: ComposerSendInput): ComposerSendCore {
  const { conversation, dirtySink } = input
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [editingEntryId, setEditingEntryId] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(0)
  const [runningCommand, setRunningCommand] = useState<QualifiedCommand | null>(null)
  const [envBlocker, setEnvBlocker] = useState<SessionEnvBlocker>(ENV_BLOCKER_CLEAR)
  const sendingRef = useRef(false)
  const uploadingRef = useRef(0)
  const envBlockedRef = useRef(false)
  const commandPendingRef = useRef(false)
  const commandGenRef = useRef(0)
  const withdrawingRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  // Live draft version: advanced by any change to text / edit target /
  // attachments; after a send failure it tells whether the user already
  // modified the draft.
  const liveDraftRef = useRef<ComposerDraftVersion>(draftVersionOf('', null, []))
  // Instance refs only, no state closures: empty deps keep a constant
  // identity, serving as the stable dependency of downstream useCallbacks.
  const syncLiveDraft = useCallback(
    (text: string, target: number | null, attachments: ReadonlyArray<PendingAttachment>): void => {
      liveDraftRef.current = draftVersionOf(text, target, attachments)
    },
    [],
  )
  const dirtySinkRef = useRef(dirtySink)
  dirtySinkRef.current = dirtySink
  const publishHiddenDirty = useCallback((): void => {
    const sink = dirtySinkRef.current
    if (sink == null) return
    const live = liveDraftRef.current
    const snap: ComposerDirtySnapshot = {
      hasDraftText: live.text.trim() !== '',
      editingEntry: live.targetEntryId !== null,
      hasAttachments: live.attachments.length > 0,
      busy: sendingRef.current || uploadingRef.current > 0 || commandPendingRef.current,
    }
    sink.current = snap
    sink.publish?.(snap)
  }, [])

  // The active conversation is tracked through a ref committed in the layout phase so that
  // write-backs after an await can tell whether the user already navigated elsewhere.
  const activeConversationIdRef = useRef(conversation.id)
  useLayoutEffect(() => {
    activeConversationIdRef.current = conversation.id
  }, [conversation.id])

  const isActiveConversation = useCallback(
    (targetConversationId: number): boolean => activeConversationIdRef.current === targetConversationId,
    [],
  )

  const isActiveMountedConversation = useCallback(
    (targetConversationId: number): boolean =>
      mountedRef.current && activeConversationIdRef.current === targetConversationId,
    [],
  )

  return {
    conversationId: conversation.id,
    text,
    setText,
    attachments,
    setAttachments,
    editingEntryId,
    setEditingEntryId,
    liveDraftRef,
    syncLiveDraft,
    sending,
    setSending,
    sendingRef,
    uploading,
    setUploading,
    uploadingRef,
    runningCommand,
    setRunningCommand,
    commandPendingRef,
    commandGenRef,
    withdrawingRef,
    envBlocker,
    setEnvBlocker,
    envBlockedRef,
    mountedRef,
    isActiveConversation,
    isActiveMountedConversation,
    publishHiddenDirty,
  }
}
