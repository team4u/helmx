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
import { Activity, Suspense, lazy, useEffect, useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  HelmxIcon,
} from '@helmx/plugin-client'
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
import {
  clearComposerDirty,
  isComposerDirtySnapshot,
  setComposerDirty,
} from './composer-dirty.js'
import {
  ConversationDirtySinkContext,
  type ConversationDirtySink,
} from './conversation-window-model.js'
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
  const frameDirtyKey = `drawer-conversation:${conversationId}`
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const dirtySinkRef = useRef<ConversationDirtySink | null>(null)
  if (dirtySinkRef.current === null) {
    dirtySinkRef.current = { current: null }
  }
  const dirtySink = dirtySinkRef.current
  dirtySink.publish = (snapshot) => {
    if (!mountedRef.current || visibleRef.current) return
    if (isComposerDirtySnapshot(snapshot)) setComposerDirty(frameDirtyKey, snapshot, conversationId)
    else clearComposerDirty(frameDirtyKey)
  }
  const wasVisibleRef = useRef(visible)

  // Preserve dirty-draft visibility while hidden under another drawer layer.
  useEffect(() => {
    if (visible) {
      clearComposerDirty(frameDirtyKey)
      return
    }
    const snapshot = dirtySink.current
    if (snapshot !== null && isComposerDirtySnapshot(snapshot)) {
      setComposerDirty(frameDirtyKey, snapshot, conversationId)
    } else {
      clearComposerDirty(frameDirtyKey)
    }
    return () => clearComposerDirty(frameDirtyKey)
  }, [visible, frameDirtyKey, conversationId, dirtySink])

  useEffect(() => {
    const wasVisible = wasVisibleRef.current
    wasVisibleRef.current = visible
    if (!visible || wasVisible) return
    void loadConversationDetail(conversationId, true, { silent: true })
  }, [visible, conversationId, loadConversationDetail])

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

export function DrawerStackShell({ activeConversationId, inline = false }: DrawerStackShellProps) {
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

  return (
    <Dialog
      open
      inline={inline}
      onOpenChange={(open) => {
        if (!open) closeAllDrawers()
      }}
    >
      <DialogPortal inline={inline}>
        <DialogOverlay
          className="drawer-stack-backdrop"
          aria-label={t('conv.drawer.closeAll')}
        />
        <DialogContent
          ref={contentRef}
          tabIndex={-1}
          className={`drawer-stack-dialog ${isWide ? 'drawer-stack-dialog-wide' : 'drawer-stack-dialog-narrow'}`}
          aria-label={dialogAriaLabel}
          data-drawer-depth={drawerStack.length}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            contentRef.current?.focus({ preventScroll: true })
          }}
          onEscapeKeyDown={(event) => {
            if (event.defaultPrevented) return
            event.preventDefault()
            popDrawer()
          }}
        >
          <DialogTitle className="helmx-sr-only">{dialogAriaLabel}</DialogTitle>
          <div className="drawer-stack-header">
            <div className="drawer-stack-nav">
              {prevLabel !== undefined ? (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost drawer-stack-back-btn"
                  aria-label={t('conv.drawer.backAria', { label: prevLabel })}
                  title={t('conv.drawer.backAria', { label: prevLabel })}
                  onClick={popDrawer}
                >
                  <HelmxIcon name="arrow-left" size={13} />
                  <span className="drawer-stack-back-label">{t('conv.drawer.backLabel')}</span>
                </button>
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
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost drawer-stack-split-btn"
                    aria-label={t('conv.drawer.openSplit')}
                    title={t('conv.drawer.openSplit')}
                    onClick={() => {
                      openTarget({ kind: 'conversation', conversationId: topFrame.conversationId }, { split: true })
                      closeAllDrawers()
                    }}
                  >
                    <HelmxIcon name="columns" size={12} />
                    <span className="pane-action-label">{t('conv.drawer.splitLabel')}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost conversation-drawer-primary-btn drawer-stack-fullscreen-btn"
                    aria-label={t('conv.pane.openFullscreen')}
                    title={t('conv.pane.openFullscreenTitle')}
                    onClick={() => {
                      openTarget({ kind: 'conversation', conversationId: topFrame.conversationId })
                    }}
                  >
                    <HelmxIcon name="external-link" size={12} />
                    <span className="pane-action-label">{t('conv.pane.fullscreen')}</span>
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="btn btn-ghost btn-icon-sm drawer-stack-close-btn"
                aria-label={t('conv.drawer.closeAll')}
                title={t('conv.drawer.closeAll')}
                onClick={closeAllDrawers}
              >
                <HelmxIcon name="x" size={14} />
              </button>
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
                        <div className="screen-loading" role="status">
                          {t('conv.shell.loadingWorkbench')}
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
