/**
 * Destructive confirmations of the conversation pane (context reset, delete). Both clear the
 * pending action before running so the dialog closes even when the request fails.
 */
import { ConfirmDialog } from '@helmx/plugin-client'
import { useWebLocale } from '../../i18n/use-web-locale.js'

/** Destructive action awaiting confirmation (null = no dialog). */
export type ConversationConfirmAction = 'reset' | 'delete'

export interface ConversationConfirmDialogsProps {
  conversationId: number
  confirmAction: ConversationConfirmAction | null
  onConfirmActionChange: (action: ConversationConfirmAction | null) => void
  onConfirmReset: () => void
  onConfirmDelete: () => void
}

export function ConversationConfirmDialogs({
  conversationId,
  confirmAction,
  onConfirmActionChange,
  onConfirmReset,
  onConfirmDelete,
}: ConversationConfirmDialogsProps) {
  const { t } = useWebLocale()
  return (
    <>
      <ConfirmDialog
        open={confirmAction === 'reset'}
        onOpenChange={(open) => {
          if (!open) onConfirmActionChange(null)
        }}
        title={t('conv.pane.resetConfirmTitle', { id: conversationId })}
        description={t('conv.pane.resetConfirmDesc')}
        confirmText={t('conv.pane.resetConfirmAction')}
        danger
        onConfirm={() => {
          onConfirmActionChange(null)
          onConfirmReset()
        }}
        onCancel={() => onConfirmActionChange(null)}
      />
      <ConfirmDialog
        open={confirmAction === 'delete'}
        onOpenChange={(open) => {
          if (!open) onConfirmActionChange(null)
        }}
        title={t('conv.pane.deleteConfirmTitle', { id: conversationId })}
        description={t('conv.pane.deleteConfirmDesc')}
        confirmText={t('conv.pane.deleteConversation')}
        danger
        onConfirm={() => {
          onConfirmActionChange(null)
          onConfirmDelete()
        }}
        onCancel={() => onConfirmActionChange(null)}
      />
    </>
  )
}
