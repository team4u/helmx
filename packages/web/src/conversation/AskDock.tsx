import { useMemo } from 'react'
import type { AskSpec } from '@helmx/protocol/browser'
import { Stack } from '@helmx/ui'
import { useConversations, usePendingAsks } from '../lib/store-context.js'
import { collectSubtreeIds } from './ancestry-model.js'
import { AskCard } from './ask-dock/AskCard.js'

export interface AskDockProps {
  conversationId: number
  shortcutPanel?: 'primary' | 'split' | 'drawer'
  shortcutActive?: boolean
  onFocusReturn?: () => void
}

function AskDockActive({
  conversationId,
  pendingAsks,
  shortcutPanel,
  shortcutActive,
  onFocusReturn,
}: {
  conversationId: number
  pendingAsks: ReadonlyArray<AskSpec>
  shortcutPanel: 'primary' | 'split' | 'drawer'
  shortcutActive: boolean
  onFocusReturn?: () => void
}) {
  const conversations = useConversations()
  // Ancestry derives purely from conversations; pending asks of
  // descendant conversations are surfaced as well.
  const subtreeIds = useMemo(
    () => collectSubtreeIds(conversations, conversationId),
    [conversations, conversationId],
  )
  const pending = pendingAsks.filter(
    (a) => a.status === 'pending' && subtreeIds.has(a.conversationId),
  )
  if (pending.length === 0) return null
  return (
    <Stack gap="sm" className="ask-dock-stack">
      {pending.map((ask, cardIndex) => (
        <AskCard
          key={ask.id}
          ask={ask}
          hostConversationId={conversationId}
          isPrimaryCard={cardIndex === 0}
          hasNextPendingAsk={pending.length > 1}
          shortcutPanel={shortcutPanel}
          shortcutActive={shortcutActive}
          onFocusReturn={onFocusReturn}
          {...(ask.conversationId !== conversationId
            ? {
                source: {
                  conversationId: ask.conversationId,
                  title: conversations.find((conv) => conv.id === ask.conversationId)?.title ?? '',
                },
              }
            : {})}
        />
      ))}
    </Stack>
  )
}

/** Bottom-docked ask & approval stack: pending AskDoc cards of the current
 * conversation and all of its descendants. AskDoc is conversation-scoped:
 * answer/cancel still go through the original asksApi (with the
 * expectedStateSeq CAS); this dock only aggregates display and changes nothing
 * about the approval chain. */
export function AskDock({
  conversationId,
  shortcutPanel = 'primary',
  shortcutActive = true,
  onFocusReturn,
}: AskDockProps) {
  const pendingAsks = usePendingAsks()
  if (!pendingAsks.some((a) => a.status === 'pending')) return null
  return (
    <AskDockActive
      conversationId={conversationId}
      pendingAsks={pendingAsks}
      shortcutPanel={shortcutPanel}
      shortcutActive={shortcutActive}
      onFocusReturn={onFocusReturn}
    />
  )
}
