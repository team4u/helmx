import { useState, type ReactNode, type RefObject } from 'react'
import {
  Badge,
  Button,
  Callout,
  CopyButton,
  HelmxIcon,
  IconButton,
  LoadingState,
  ModalDialog,
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
 * ModalDialog, mobile/desktop fullscreen toggle, copy/download/close controls,
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
  const isMobile = useIsMobile(680)
  const isFullscreen = isMobile || desktopFullscreen

  // Escape dismissal is delegated strictly to Radix Dialog's DismissableLayer
  // so nested popovers/menus (e.g. MarkdownOutlinePopover, Select) close first
  // without tearing down the modal, and modals layered above the drawer stack
  // close only themselves.
  return (
    <ModalDialog
      open
      inline={inline}
      onClose={onClose}
      size={isFullscreen ? 'fullscreen' : 'lg'}
      flushBody
      icon="file-text"
      title={<span className="preview-modal-title" title={title}>{title}</span>}
      titleExtra={
        <>
          {state.phase === 'loaded' ? (
            <Badge tone="neutral" mono className="tabular-nums">{formatBytes(state.blob.size)}</Badge>
          ) : fallbackSize !== undefined ? (
            <Badge tone="neutral" mono className="tabular-nums">{formatBytes(fallbackSize)}</Badge>
          ) : null}
          {headerBadges}
        </>
      }
      headerActions={
        <>
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
        </>
      }
      closeLabel={t('conv.artifact.closeAria')}
      className="preview-modal"
      aria-label={ariaLabel}
    >
      <div className="preview-modal-body" ref={modalBodyRef}>
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
    </ModalDialog>
  )
}
