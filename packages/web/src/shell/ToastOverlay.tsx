import { Button, HelmxIcon, IconButton } from '@helmx/plugin-client'
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

function ToastOverlayList({ notices }: { notices: ReadonlyArray<ToastNotice> }) {
  const conversations = useConversations()
  const { openTarget, dismissNotice, pauseNoticeTimer, resumeNoticeTimer } = useStoreActions()
  const { t } = useWebLocale()

  return (
    <div className="toast-overlay">
      {notices.map((n) => {
        const toneClass =
          n.level === 'error'
            ? 'callout-error'
            : n.level === 'warning'
              ? 'callout-warn'
              : ''
        const actionTarget = resolveNoticeTarget(n, conversations)
        return (
          <div
            key={n.id}
            data-notice-id={n.id}
            role={n.level === 'error' ? 'alert' : 'status'}
            className={`callout toast-item ${toneClass}`.trim()}
            onMouseEnter={() => pauseNoticeTimer(n.id)}
            onMouseLeave={() => resumeNoticeTimer(n.id)}
            onFocus={() => pauseNoticeTimer(n.id)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                resumeNoticeTimer(n.id)
              }
            }}
          >
            <div className="toast-content">
              <div className="toast-title">
                <HelmxIcon
                  name={
                    n.level === 'error'
                      ? 'alert-circle'
                      : n.level === 'warning'
                        ? 'alert-triangle'
                        : 'activity'
                  }
                  size={13}
                />
                <span>{n.title}</span>
              </div>
              {n.body && (
                <div className="toast-body">
                  {n.body}
                </div>
              )}
              {actionTarget && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="toast-action-btn"
                  onClick={() => {
                    openTarget(actionTarget)
                    dismissNotice(n.id)
                  }}
                >
                  {t('shell.toast.view')}
                </Button>
              )}
            </div>
            <IconButton
              variant="ghost"
              size="xs"
              className="toast-close-btn"
              icon="x"
              aria-label={t('shell.toast.dismiss')}
              onClick={() => dismissNotice(n.id)}
            />
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
