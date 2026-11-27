/**
 * Error-notice outlets of the composer send pipeline: every failure after an await reports
 * against the conversation the operation was started on (never the one currently shown).
 */
import { useCallback } from 'react'
import type { HelmxStoreActions } from '../../lib/store/types.js'

export interface ComposerNotices {
  /** Error notice bound to the conversation the failed operation targeted. */
  readonly notifyErrorFor: (targetConversationId: number, title: string, err: unknown) => void
  /** Error notice bound to the current conversation. */
  readonly notifyError: (title: string, err: unknown) => void
}

export function useComposerNotices(
  pushNotice: HelmxStoreActions['pushNotice'],
  conversationId: number,
): ComposerNotices {
  const notifyErrorFor = useCallback(
    (targetConversationId: number, title: string, err: unknown) => {
      pushNotice({
        type: 'notification',
        level: 'error',
        title,
        body: err instanceof Error ? err.message : String(err),
        target: { kind: 'conversation', conversationId: targetConversationId },
      })
    },
    [pushNotice],
  )

  const notifyError = useCallback(
    (title: string, err: unknown) => {
      notifyErrorFor(conversationId, title, err)
    },
    [notifyErrorFor, conversationId],
  )

  return { notifyErrorFor, notifyError }
}
