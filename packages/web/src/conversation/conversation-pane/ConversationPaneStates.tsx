/**
 * Non-content states of the conversation pane: detail load failure (retry + close affordances)
 * and the first detail read still pending.
 */
import { Button, HelmxIcon, IconButton, LoadingState } from '@helmx/ui'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import { CloseSplitButton } from '../../ui/SplitControls.js'

interface PaneStateProps {
  conversationId: number
  isSplit?: boolean
  onCloseSplit?: () => void
  isDrawer?: boolean
  onCloseDrawer?: () => void
}

export interface ConversationPaneErrorProps extends PaneStateProps {
  detailError: string
  onRetry: () => void
}

export function ConversationPaneError({ conversationId, detailError, isSplit, onCloseSplit, isDrawer, onCloseDrawer, onRetry }: ConversationPaneErrorProps) {
  const { t } = useWebLocale()
  return (
    <div className={`${isSplit ? 'helmx-split-pane' : 'helmx-pane'} pane-error`} role="alert">
      <div className="pane-error-row">
        <p>{t('conv.pane.loadFailed', { id: conversationId, error: detailError })}</p>
        <span className="pane-error-actions">
          <Button size="sm" onClick={onRetry}>{t('common.retry')}</Button>
          {isDrawer && onCloseDrawer !== undefined ? (
            <Button size="sm" variant="ghost" className="conversation-drawer-close-btn" aria-label={t('conv.pane.closeDrawerAria')} onClick={onCloseDrawer}>{t('common.close')}</Button>
          ) : isSplit && onCloseSplit !== undefined ? <CloseSplitButton onCloseSplit={onCloseSplit} /> : null}
        </span>
      </div>
    </div>
  )
}

export function ConversationPaneLoading({ conversationId, isSplit, onCloseSplit, isDrawer, onCloseDrawer }: PaneStateProps) {
  const { t } = useWebLocale()
  return (
    <div className={`${isSplit ? 'helmx-split-pane' : 'helmx-pane'} pane-loading`}>
      <LoadingState label={t('conv.pane.loading', { id: conversationId })} iconSize={13} />
      {isDrawer && onCloseDrawer !== undefined ? (
        <span className="pane-loading-split-close">
          <IconButton
            icon={<HelmxIcon name="x" size={14} />}
            variant="ghost"
            size="sm"
            className="conversation-drawer-close-btn"
            aria-label={t('conv.pane.closeDrawerAria')}
            onClick={onCloseDrawer}
          />
        </span>
      ) : isSplit && onCloseSplit !== undefined ? (
        <span className="pane-loading-split-close">
          <CloseSplitButton onCloseSplit={onCloseSplit} />
        </span>
      ) : null}
    </div>
  )
}
