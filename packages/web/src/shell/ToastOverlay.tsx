import { Button, HelmxIcon, IconButton } from '@helmx/ui'
import type { ConversationSummary } from '@helmx/protocol/browser'
import { useConversations, useNotices, useStoreActions } from '../lib/store-context.js'
import { resolveTargetString, type ResolvedTarget, type ToastNotice } from '../lib/types.js'
import { useWebLocale } from '../i18n/use-web-locale.js'

/**
 * Resolve the single standard "View" action target of a notice:
 * - explicit `target` wins;
 * - otherwise parses declarative `view` deep-link strings (returning null when unresolvable).
 */
function resolveNoticeTarget(
  notice: Pick<ToastNotice, 'target' | 'view'>,
  conversations: ConversationSummary[],
): ResolvedTarget | null {
  if (notice.target !== undefined) return notice.target
  if (notice.view !== undefined) {
    return resolveTargetString(notice.view, conversations)
  }
  return null
}

const MAX_VISIBLE_TOASTS = 4

function ToastOverlayList({ notices }: { notices: ReadonlyArray<ToastNotice> }) {
  const conversations = useConversations()
  const { openTarget, dismissNotice, pauseNoticeTimer, resumeNoticeTimer } = useStoreActions()
  const { t } = useWebLocale()
  const visibleNotices = (
    notices.length > MAX_VISIBLE_TOASTS ? notices.slice(-MAX_VISIBLE_TOASTS) : notices
  )
    .slice()
    .reverse()

  return (
    <div className="toast-overlay" data-helmx-toast-overlay="true" role="region" aria-label={t('shell.toast.region')}>
      {visibleNotices.map((n) => {
        const hasBody = Boolean(n.body?.trim())
        const isCompact = !hasBody
        const iconName = n.level === 'error' ? 'alert-circle' : n.level === 'warning' ? 'alert-triangle' : 'info'
        const actionTarget = resolveNoticeTarget(n, conversations)
        const actionButton = actionTarget ? (
          <Button
            variant="secondary"
            size="xs"
            className="toast-action-btn"
            onClick={() => {
              openTarget(actionTarget)
              dismissNotice(n.id)
            }}
          >
            <span>{t('shell.toast.view')}</span>
            <HelmxIcon name="arrow-right" size={11} />
          </Button>
        ) : null

        return (
          <div
            key={n.id}
            data-notice-id={n.id}
            data-level={n.level}
            data-compact={isCompact ? 'true' : undefined}
            role={n.level === 'error' ? 'alert' : 'status'}
            className="toast-item"
            onMouseEnter={() => pauseNoticeTimer(n.id)}
            onMouseLeave={() => resumeNoticeTimer(n.id)}
            onFocus={() => pauseNoticeTimer(n.id)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                resumeNoticeTimer(n.id)
              }
            }}
          >
            <span className="toast-icon-badge" aria-hidden="true">
              <HelmxIcon name={iconName} size={14} />
            </span>
            <div className="toast-content">
              <div className="toast-title">{n.title}</div>
              {hasBody && <div className="toast-body">{n.body}</div>}
              {!isCompact && actionButton && <div className="toast-actions">{actionButton}</div>}
            </div>
            <div className="toast-trailing">
              {isCompact && actionButton}
              <IconButton
                variant="ghost"
                size="xs"
                className="toast-close-btn"
                icon="x"
                aria-label={t('shell.toast.dismiss')}
                onClick={() => dismissNotice(n.id)}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function ToastOverlay() {
  const notices = useNotices()
  if (notices.length === 0) return null
  return <ToastOverlayList notices={notices} />
}
