import { useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  Badge,
  Button,
  Callout,
  CopyButton,
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  HelmxIcon,
  IconButton,
  LoadingState,
} from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { formatBytes } from '../lib/format.js'
import { useIsMobile } from './composer-model.js'
import type { FilePreviewLoadState } from './use-file-preview.js'

export interface PreviewModalShellProps {
  title: string
  ariaLabel: string
  inline?: boolean
  onClose: () => void
  onDownload: () => void
  state: FilePreviewLoadState
  fallbackSize?: number
  loadingLabel: string
  errorLabel: string
  copyText?: string | null
  headerBadges?: ReactNode
  headerActions?: ReactNode
  modalBodyRef: RefObject<HTMLDivElement | null>
  children?: ReactNode
}

/**
 * Shared modal shell for ArtifactPreviewModal and WorkspaceFilePreviewModal:
 * Radix Dialog, mobile/desktop fullscreen toggle, copy/download/close controls,
 * and standard loading/error states.
 */
export function PreviewModalShell({
  title,
  ariaLabel,
  inline,
  onClose,
  onDownload,
  state,
  fallbackSize,
  loadingLabel,
  errorLabel,
  copyText,
  headerBadges,
  headerActions,
  modalBodyRef,
  children,
}: PreviewModalShellProps): ReactNode {
  const { t } = useWebLocale()
  const [desktopFullscreen, setDesktopFullscreen] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const isMobile = useIsMobile(680)
  const isFullscreen = isMobile || desktopFullscreen

  // Escape dismissal is delegated strictly to Radix Dialog's DismissableLayer
  // so nested popovers/menus (e.g. MarkdownOutlinePopover, Select) close first
  // without tearing down the modal, and modals layered above the drawer stack
  // close only themselves.
  return (
    <Dialog open inline={inline} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal inline={inline}>
        <DialogOverlay className={`modal-backdrop${isFullscreen ? ' modal-fullscreen-backdrop' : ''}`}>
          <DialogContent
            ref={contentRef}
            tabIndex={-1}
            className={`modal${isFullscreen ? ' modal-fullscreen' : ''}`}
            aria-label={ariaLabel}
            style={isFullscreen ? undefined : { maxWidth: 'min(1280px, 94vw)', maxHeight: '90vh' }}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              contentRef.current?.focus({ preventScroll: true })
            }}
          >
            <div className="modal-header artifact-preview-header">
              <span className="preview-modal-title-group">
                <HelmxIcon name="file-text" size={14} />
                <DialogTitle className="modal-title preview-modal-title" title={title}>
                  {title}
                </DialogTitle>
                {state.phase === 'loaded' ? (
                  <Badge tone="neutral" mono className="tabular-nums">{formatBytes(state.blob.size)}</Badge>
                ) : fallbackSize !== undefined ? (
                  <Badge tone="neutral" mono className="tabular-nums">{formatBytes(fallbackSize)}</Badge>
                ) : null}
                {headerBadges}
              </span>
              <span className="preview-modal-actions">
                {headerActions}
                {!isMobile ? (
                  <Button
                    size="sm"
                    icon={<HelmxIcon name={desktopFullscreen ? 'minimize-2' : 'maximize-2'} size={12} />}
                    onClick={() => setDesktopFullscreen((v) => !v)}
                    title={desktopFullscreen ? t('conv.artifact.windowModeTitle') : t('conv.artifact.fullscreenTitle')}
                  >
                    {desktopFullscreen ? t('conv.artifact.windowLabel') : t('conv.pane.fullscreen')}
                  </Button>
                ) : null}
                {copyText !== undefined && copyText !== null ? (
                  <CopyButton
                    text={copyText}
                    label={isMobile ? undefined : t('conv.artifact.copy')}
                    className={isMobile ? 'btn btn-secondary btn-icon-sm' : 'btn btn-secondary btn-sm'}
                  />
                ) : null}
                {isMobile ? (
                  <IconButton
                    variant="secondary"
                    size="sm"
                    icon={<HelmxIcon name="download" size={12} />}
                    label={t('common.download')}
                    onClick={onDownload}
                  />
                ) : (
                  <Button
                    size="sm"
                    icon={<HelmxIcon name="download" size={12} />}
                    onClick={onDownload}
                    title={t('common.download')}
                  >
                    {t('common.download')}
                  </Button>
                )}
                <DialogClose asChild>
                  <IconButton
                    icon={<HelmxIcon name="x" size={14} />}
                    variant="ghost"
                    size="sm"
                    title={t('conv.artifact.closeTitle')}
                    aria-label={t('conv.artifact.closeAria')}
                  />
                </DialogClose>
              </span>
            </div>
            <div className="modal-body preview-modal-body" ref={modalBodyRef}>
              {state.phase === 'loading' ? (
                <LoadingState label={loadingLabel} iconSize={14} className="preview-modal-loading" />
              ) : null}
              {state.phase === 'error' ? (
                <Callout tone="err">
                  <span className="callout-text">{errorLabel}</span>
                </Callout>
              ) : null}
              {children}
            </div>
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}
