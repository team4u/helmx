/**
 * Content stacked above the standby input box: the draft environment bar, the "anchored"
 * notice once the first send persisted a conversation (with a jump to it), and the send
 * error with its retry.
 */
import type { Profile } from '@helmx/protocol/browser'
import { Button, HelmxIcon, Tooltip } from '@helmx/plugin-client'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import { useStoreActions } from '../../lib/store-context.js'
import { StandbyEnvBar } from '../StandbyControls.js'
import type { StandbyDraftState } from '../standby-model.js'

export interface StandbyComposerAboveBoxProps {
  draftKey: string
  draft: StandbyDraftState
  profile: Profile
  isSplit?: boolean
  /** Environment / model config locked (sending or anchored to a persisted conversation). */
  disabled: boolean
  onResetToDefault: () => void
  /** Retry after a failed send (re-runs the send). */
  onRetry: () => void
}

export function StandbyComposerAboveBox({ draftKey, draft, profile, isSplit, disabled, onResetToDefault, onRetry }: StandbyComposerAboveBoxProps) {
  const { openTarget } = useStoreActions()
  const { t } = useWebLocale()
  const conversationId = draft.conversationId
  return (
    <>
      <StandbyEnvBar
        draftKey={draftKey}
        draft={draft}
        profile={profile}
        disabled={disabled}
        onResetToDefault={onResetToDefault}
      />
      {conversationId !== undefined ? (
        <div className="agent-standby-anchored callout" role="status">
          <HelmxIcon name="lock" size={12} />
          <span className="agent-standby-anchored-text">
            {t('composer.standby.anchoredNotice', { id: conversationId })}
          </span>
          <Tooltip content={t('composer.standby.openCreatedInPanel')} side="top">
            <Button
              size="sm"
              onClick={() => {
                if (draft.conversationId === undefined) return
                openTarget(
                  { kind: 'conversation', conversationId: draft.conversationId },
                  isSplit ? { split: true } : undefined,
                )
              }}
            >
              {t('composer.standby.viewConversation')}
            </Button>
          </Tooltip>
        </div>
      ) : null}
      {draft.error !== null ? (
        <div className="agent-standby-error callout callout-error" role="alert">
          <span className="agent-standby-error-text">{draft.error}</span>
          <Button size="sm" disabled={draft.sending} onClick={onRetry}>
            {t('common.retry')}
          </Button>
        </div>
      ) : null}
    </>
  )
}
