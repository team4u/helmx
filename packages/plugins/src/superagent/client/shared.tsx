/**
 * Shared internal micro-components for builtin:superagent surfaces (component
 * exports only, Fast Refresh friendly).
 */
import type { ReactNode } from 'react'
import type { ConversationSummary } from '@helmx/protocol'
import { HelmxIcon } from '@helmx/plugin-client'
import { resolveConversationTitle } from './models.ts'

export function ActionError({ message }: { message: string }): ReactNode {
  return (
    <div className="callout callout--error" role="alert">
      <span>{message}</span>
    </div>
  )
}

export function RowAction({
  label,
  iconName,
  disabled,
  danger,
  onClick,
}: {
  label: string
  iconName?: string
  disabled?: boolean
  danger?: boolean
  onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      className={`btn btn-xs ${danger === true ? 'btn-danger' : ''}`}
      disabled={disabled === true}
      onClick={onClick}
    >
      {disabled === true ? (
        <HelmxIcon name="loader" size={11} className="spin-slow" />
      ) : iconName !== undefined ? (
        <HelmxIcon name={iconName} size={11} />
      ) : null}
      <span>{label}</span>
    </button>
  )
}

export function ConversationCell({
  conversationId,
  conversationsById,
}: {
  conversationId: number
  conversationsById: ReadonlyMap<number, ConversationSummary>
}): ReactNode {
  const title = resolveConversationTitle(conversationsById, conversationId)
  if (title === undefined) {
    return <td className="tabular-nums">#{conversationId}</td>
  }
  return (
    <td>
      <span className="sa-conv-cell" title={`${title} (#${conversationId})`}>
        <span className="sa-conv-name">{title}</span>{' '}
        <span className="sa-conv-id tabular-nums">#{conversationId}</span>
      </span>
    </td>
  )
}
