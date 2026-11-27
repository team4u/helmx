/**
 * Unified right-hand stacked inspection drawer:
 * - Hosts an ordered stack of workbench frames and child conversation frames
 *   inside ONE Radix Dialog container (no multi-backdrop visual clutter);
 * - Outer navigation bar owns Back (`<-`), clickable breadcrumb trail,
 *   Split promote (`[Split]`), Fullscreen promote (`[Fullscreen]`), and the
 *   sole Close (`[x]`) button;
 * - Pressing Escape or clicking Back pops one layer (`popDrawer`); clicking
 *   `[x]` or the backdrop dismisses the stack (`closeAllDrawers`);
 * - Keeps the topmost 3 frames mounted under React 19 `<Activity>` so stepping
 *   back restores scroll position, expanded folds, and composer drafts.
 */
import { Activity, Suspense, lazy, useRef } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  HelmxIcon,
  IconButton,
  LoadingState,
} from '@helmx/ui'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  drawerFrameKey,
  isDrawerFrameKeepAlive,
  resolveDrawerWorkbenchConversationId,
  topDrawerFrame,
} from '../lib/drawer-stack-model.js'
import {
  useConversationDetailsMap,
  useConversations,
  useDrawerStack,
  useGroupedUi,
  useStoreActions,
} from '../lib/store-context.js'
import { ConversationPane } from './ConversationPane.js'
import { ConversationDirtySinkContext } from './conversation-window-model.js'
import { useActivityFrameLifecycle } from './use-activity-frame-lifecycle.js'
import {
  resolveDrawerDialogAriaLabel,
  resolveDrawerFrameLabel,
} from './drawer-stack-view-model.js'

const WorkbenchView = lazy(() =>
  import('./WorkbenchView.js').then((m) => ({ default: m.WorkbenchView })),
)

export interface DrawerStackShellProps {
  /** Active conversation in the underlying primary/split stage (used by unbound root workbench frames). */
  activeConversationId?: number
  /** Dock the drawer non-modally beside the main stage on wide single-pane desktop viewports. */
  docked?: boolean
  /** Render inline without Portal (for happy-dom / SSR tests). */
  inline?: boolean
}

function DrawerConversationFrame({
  conversationId,
  visible,
}: {
  conversationId: number
  visible: boolean
}) {
  const { loadConversationDetail } = useStoreActions()
  const dirtySink = useActivityFrameLifecycle({
    frameDirtyKey: `drawer-conversation:${conversationId}`,
    conversationId,
    visible,
    loadConversationDetail,
  })

  return (
    <ConversationDirtySinkContext.Provider value={dirtySink}>
      <Activity mode={visible ? 'visible' : 'hidden'}>
        <div className="drawer-stack-frame conversation-drawer" data-drawer-frame-visible={visible ? 'true' : 'false'}>
          <ConversationPane conversationId={conversationId} isDrawer staged={visible} />
        </div>
      </Activity>
    </ConversationDirtySinkContext.Provider>
  )
}

export function DrawerStackShell({ activeConversationId, docked = false, inline = false }: DrawerStackShellProps) {
  const drawerStack = useDrawerStack()
  const conversations = useConversations()
  const conversationDetails = useConversationDetailsMap()
  const groupedUi = useGroupedUi()
  const {
    popDrawer,
    truncateDrawerStack,
    closeAllDrawers,
    setWorkbenchTab,
    openTarget,
  } = useStoreActions()
  const { locale, t } = useWebLocale()
  const contentRef = useRef<HTMLDivElement | null>(null)

  const topFrame = topDrawerFrame(drawerStack)
  if (topFrame === undefined) return null

  const frameLabels = drawerStack.map((frame, index) =>
    resolveDrawerFrameLabel({
      frame,
      resolvedConversationId:
        frame.kind === 'workbench'
          ? resolveDrawerWorkbenchConversationId(drawerStack, index, activeConversationId)
          : frame.conversationId,
      conversations,
      conversationDetails,
      workbenchPanels: groupedUi.workbenchPanels,
      locale,
      t,
    }),
  )
  const topLabel = frameLabels[frameLabels.length - 1] ?? t('conv.drawer.stackAria')
  const prevLabel = drawerStack.length > 1 ? frameLabels[drawerStack.length - 2] : undefined
  const dialogAriaLabel = resolveDrawerDialogAriaLabel({
    topFrame,
    topLabel,
    conversations,
    conversationDetails,
    t,
  })
  const isWide = topFrame.kind === 'conversation'
  const isDocked = docked === true
  const renderInline = inline || isDocked

  return (
    <Dialog
      open
      modal={!isDocked}
      inline={renderInline}
      onOpenChange={(open) => {
        if (!open) closeAllDrawers()
      }}
    >
      <DialogPortal inline={renderInline}>
        {!isDocked ? (
          <DialogOverlay
            className="drawer-stack-backdrop"
            aria-label={t('conv.drawer.closeAll')}
          />
        ) : null}
        <DialogContent
          ref={contentRef}
          tabIndex={-1}
          className={`drawer-stack-dialog ${isWide ? 'drawer-stack-dialog-wide' : 'drawer-stack-dialog-narrow'}${isDocked ? ' is-docked' : ''}`}
          aria-label={dialogAriaLabel}
          data-drawer-depth={drawerStack.length}
          data-drawer-docked={isDocked ? 'true' : undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            contentRef.current?.focus({ preventScroll: true })
          }}
          onEscapeKeyDown={(event) => {
            if (event.defaultPrevented) return
            event.preventDefault()
            popDrawer()
          }}
          onPointerDownOutside={(event) => {
            if (isDocked) event.preventDefault()
          }}
          onFocusOutside={(event) => {
            if (isDocked) event.preventDefault()
          }}
          onInteractOutside={(event) => {
            if (isDocked) event.preventDefault()
          }}
        >
          <DialogTitle className="helmx-sr-only">{dialogAriaLabel}</DialogTitle>
          <div className="drawer-stack-header">
            <div className="drawer-stack-nav">
              {prevLabel !== undefined ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon="arrow-left"
                  className="drawer-stack-back-btn"
                  aria-label={t('conv.drawer.backAria', { label: prevLabel })}
                  title={t('conv.drawer.backAria', { label: prevLabel })}
                  onClick={popDrawer}
                >
                  <span className="drawer-stack-back-label">{t('conv.drawer.backLabel')}</span>
                </Button>
              ) : null}
              <nav className="drawer-stack-crumbs" aria-label={t('conv.drawer.breadcrumbAria')}>
                {drawerStack.map((frame, index) => {
                  const key = drawerFrameKey(frame)
                  const label = frameLabels[index] ?? ''
                  const isLast = index === drawerStack.length - 1
                  return (
                    <span key={key} className="drawer-stack-crumb-item">
                      {index > 0 ? (
                        <HelmxIcon name="chevron-right" size={11} className="drawer-stack-crumb-sep" />
                      ) : null}
                      {isLast ? (
                        <span className="drawer-stack-crumb-current" aria-current="page" title={label}>
                          {label}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="drawer-stack-crumb-btn"
                          title={label}
                          onClick={() => truncateDrawerStack(index)}
                        >
                          {label}
                        </button>
                      )}
                    </span>
                  )
                })}
              </nav>
            </div>
            <div className="drawer-stack-actions">
              {topFrame.kind === 'conversation' ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<HelmxIcon name="columns" size={12} />}
                    className="drawer-stack-split-btn"
                    aria-label={t('conv.drawer.openSplit')}
                    title={t('conv.drawer.openSplit')}
                    onClick={() => {
                      openTarget({ kind: 'conversation', conversationId: topFrame.conversationId }, { split: true })
                      closeAllDrawers()
                    }}
                  >
                    <span className="pane-action-label">{t('conv.drawer.splitLabel')}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<HelmxIcon name="external-link" size={12} />}
                    className="conversation-drawer-primary-btn drawer-stack-fullscreen-btn"
                    aria-label={t('conv.pane.openFullscreen')}
                    title={t('conv.pane.openFullscreenTitle')}
                    onClick={() => {
                      openTarget({ kind: 'conversation', conversationId: topFrame.conversationId })
                    }}
                  >
                    <span className="pane-action-label">{t('conv.pane.fullscreen')}</span>
                  </Button>
                </>
              ) : null}
              <IconButton
                icon={<HelmxIcon name="x" size={14} />}
                variant="ghost"
                size="sm"
                className="drawer-stack-close-btn"
                label={t('conv.drawer.closeAll')}
                onClick={closeAllDrawers}
              />
            </div>
          </div>

          <div className="drawer-stack-body">
            {drawerStack.map((frame, index) => {
              if (!isDrawerFrameKeepAlive(drawerStack.length, index)) return null
              const key = drawerFrameKey(frame)
              const isTop = index === drawerStack.length - 1
              if (frame.kind === 'conversation') {
                return (
                  <DrawerConversationFrame
                    key={key}
                    conversationId={frame.conversationId}
                    visible={isTop}
                  />
                )
              }
              const resolvedConvId = resolveDrawerWorkbenchConversationId(
                drawerStack,
                index,
                activeConversationId,
              )
              return (
                <Activity key={key} mode={isTop ? 'visible' : 'hidden'}>
                  <div className="drawer-stack-frame helmx-workbench" data-drawer-frame-visible={isTop ? 'true' : 'false'}>
                    <Suspense
                      fallback={
                        <div className="screen-loading">
                          <LoadingState label={t('conv.shell.loadingWorkbench')} iconSize={13} />
                        </div>
                      }
                    >
                      <WorkbenchView
                        conversationId={resolvedConvId}
                        tab={frame.tab}
                        onTabChange={setWorkbenchTab}
                        active={isTop}
                      />
                    </Suspense>
                  </div>
                </Activity>
              )
            })}
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
