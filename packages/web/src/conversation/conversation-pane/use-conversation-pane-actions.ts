/**
 * Top-level actions of the conversation pane (more-menu operations): each runs under a
 * pending marker and reports success / failure as a notice targeted at this conversation.
 */
import { useState } from 'react'
import type { ConversationSummary } from '@helmx/protocol/browser'
import { conversationsApi } from '../../lib/api.js'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import { useStoreActions } from '../../lib/store-context.js'

export interface ConversationPaneActions {
  /** Name of the action in flight (rename / compact / archive / restore-archive / reset). */
  readonly actionPending: string | null
  readonly runAction: (name: string, fn: () => Promise<unknown>, successTitle: string) => Promise<void>
  /** Persists the title draft trimmed (no-op when empty or unchanged). */
  readonly saveTitle: (draft: string) => Promise<void>
  /** Resets the conversation context (confirmed destructive action). */
  readonly resetContext: () => Promise<void>
  /** Deletes the conversation; navigation follows the `conversation.deleted` event. */
  readonly deleteConversation: () => Promise<void>
}

export function useConversationPaneActions(
  conversationId: number,
  conversation: ConversationSummary | undefined,
): ConversationPaneActions {
  const { pushNotice } = useStoreActions()
  const { t } = useWebLocale()
  const [actionPending, setActionPending] = useState<string | null>(null)

  const runAction = async (name: string, fn: () => Promise<unknown>, successTitle: string): Promise<void> => {
    setActionPending(name)
    try {
      await fn()
      pushNotice({
        type: 'notification',
        level: 'info',
        title: successTitle,
        target: { kind: 'conversation', conversationId },
      })
    } catch (err) {
      pushNotice({
        type: 'notification',
        level: 'error',
        title: t('conv.pane.actionFailedTitle', { title: successTitle }),
        body: err instanceof Error ? err.message : String(err),
        target: { kind: 'conversation', conversationId },
      })
    } finally {
      setActionPending(null)
    }
  }

  const saveTitle = async (draft: string): Promise<void> => {
    const next = draft.trim()
    if (conversation === undefined || next === '' || next === conversation.title) return
    await runAction('rename', () => conversationsApi.patch(conversationId, { title: next }), t('conv.pane.conversationRenamed'))
  }

  const resetContext = async (): Promise<void> => {
    await runAction('reset', () => conversationsApi.reset(conversationId), t('conv.pane.contextReset'))
  }

  const deleteConversation = async (): Promise<void> => {
    try {
      await conversationsApi.remove(conversationId)
      // 导航由 conversation.deleted 事件按当前目标做条件更新；这里不使用
      // await 前捕获的主屏/分屏快照，避免删除完成时打断用户的新导航。
      pushNotice({
        type: 'notification',
        level: 'info',
        title: t('conv.pane.conversationDeleted'),
        body: t('conv.pane.conversationDeletedBody', { id: conversationId }),
      })
    } catch (err) {
      pushNotice({
        type: 'notification',
        level: 'error',
        title: t('conv.pane.deleteFailed'),
        body: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { actionPending, runAction, saveTitle, resetContext, deleteConversation }
}
