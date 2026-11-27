/**
 * Environment strip under the top bar of a drawer-hosted conversation pane: the child
 * conversation's id / agent / node:cwd / ownership at a glance (the drawer body itself only
 * shows the transcript).
 */
import type { ConversationSummary } from '@helmx/protocol/browser'
import { Badge, HelmxIcon } from '@helmx/ui'
import { useWebLocale } from '../../i18n/use-web-locale.js'

export interface ConversationDrawerEnvBarProps {
  conversation: ConversationSummary
  currentNodeId: string
}

export function ConversationDrawerEnvBar({ conversation, currentNodeId }: ConversationDrawerEnvBarProps) {
  const { t } = useWebLocale()
  const envText = `${currentNodeId}:${conversation.cwd || t('conv.pane.cwdNotSet')}`
  return (
    <div className="pane-drawer-env-bar" aria-label={t('conv.pane.childEnv')}>
      <span className="pane-drawer-env-item mono">#{conversation.id}</span>
      <span className="pane-drawer-env-sep" aria-hidden="true">·</span>
      <span className="pane-drawer-env-item">
        <HelmxIcon name="bot" size={11} />
        <span>{conversation.profileId}</span>
      </span>
      <span className="pane-drawer-env-sep" aria-hidden="true">·</span>
      <span className="pane-drawer-env-item mono" title={envText}>
        <HelmxIcon name={currentNodeId === 'local' ? 'laptop' : 'server'} size={11} />
        <span>{envText}</span>
      </span>
      {conversation.ownedBy !== undefined ? (
        <>
          <span className="pane-drawer-env-sep" aria-hidden="true">·</span>
          <Badge tone="neutral">{t('conv.pane.ownerBadge', { owner: conversation.ownedBy })}</Badge>
        </>
      ) : null}
    </div>
  )
}
