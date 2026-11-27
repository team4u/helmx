/**
 * Unified centered modal dialog shell shared by host views and plugins.
 *
 * Symmetric to `DetailDrawer`: wraps the SSR-safe Radix `Dialog` primitives
 * from this package over the canonical `.helmx-modal*` CSS vocabulary
 * (backdrop blur, 14px surface radius, 1px hairline dividers, composable
 * icon/title/titleExtra/description/headerActions/body/footer slots, and
 * `sm | md | lg | fullscreen` width tiers).
 *
 * State and domain content stay with the caller; `closeDisabled` atomically
 * gates the close button, Escape dismissal, and outside-click dismissal during
 * in-flight async mutations.
 *
 * This file only exports components and TS types (Fast Refresh friendly).
 */
import { useRef, type ReactNode } from 'react'
import { HelmxIcon } from '../icons.js'
import { usePluginTranslator } from '../i18n.js'
import { uiCopy } from '../ui-copy.js'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  type DialogContentProps,
} from './Dialog.js'

export type ModalDialogSize = 'sm' | 'md' | 'lg' | 'fullscreen'

export interface ModalDialogProps {
  /** Whether the modal is open (fully controlled). */
  open: boolean
  /** Close request (invoked by close button, Escape, or outside click unless `closeDisabled`). */
  onClose: () => void
  /** Main dialog title rendered in `DialogTitle` (associated via `aria-labelledby`). */
  title: ReactNode
  /** Optional leading icon in the header: HelmxIcon name string or custom ReactNode. */
  icon?: string | ReactNode
  /** Optional inline extras right of the title (badges, version tags, status pills). */
  titleExtra?: ReactNode
  /** Optional muted subtitle rendered in `DialogDescription` (associated via `aria-describedby`). */
  description?: ReactNode
  /** Dialog width tier: `'sm'` (440px), `'md'` (540px default), `'lg'` (680px), or `'fullscreen'` (100vw x 100dvh). */
  size?: ModalDialogSize
  /** Remove default body padding/scroll so full-bleed viewers or custom lists control their own scroll region. */
  flushBody?: boolean
  /** Optional actions rendered on the right of the header before the close button. */
  headerActions?: ReactNode
  /** Optional footer action bar; omit to render no footer. */
  footer?: ReactNode
  /** Disable close button and block Escape / outside-click dismissal (e.g. while saving). */
  closeDisabled?: boolean
  /** Accessible name / tooltip for the header close button (defaults to the shared UI locale). */
  closeLabel?: string
  /** Force inline rendering without a DOM portal (SSR renders inline automatically). */
  inline?: boolean
  /** Extra class name appended to `.helmx-modal`. */
  className?: string
  /** Extra class name appended to `.helmx-modal-backdrop`. */
  overlayClassName?: string
  /** Extra class name appended to `.helmx-modal-body`. */
  bodyClassName?: string
  /** Explicit accessible name override; omit to use the `DialogTitle` association. */
  'aria-label'?: string
  /** Override Radix open auto-focus behavior (defaults to focusing the modal container, not the close button). */
  onOpenAutoFocus?: DialogContentProps['onOpenAutoFocus']
  /** Optional Escape key hook passed through to `DialogContent` when not `closeDisabled`. */
  onEscapeKeyDown?: DialogContentProps['onEscapeKeyDown']
  /** Modal body content. */
  children: ReactNode
}

const SIZE_CLASS: Record<ModalDialogSize, string> = {
  sm: 'helmx-modal-sm',
  md: 'helmx-modal-md',
  lg: 'helmx-modal-lg',
  fullscreen: 'helmx-modal-fullscreen',
}

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function hasRenderable(node: ReactNode): boolean {
  return node !== undefined && node !== null && typeof node !== 'boolean'
}

/**
 * Centered modal shell over the canonical `.helmx-modal*` host vocabulary:
 * header (icon + title/titleExtra + optional description + headerActions + close),
 * scrollable body (or flush body), and optional footer.
 */
export function ModalDialog(props: ModalDialogProps): ReactNode {
  const t = usePluginTranslator()
  const contentRef = useRef<HTMLDivElement | null>(null)
  const {
    open,
    onClose,
    title,
    icon,
    titleExtra,
    description,
    size = 'md',
    flushBody = false,
    headerActions,
    footer,
    closeDisabled = false,
    closeLabel = t(uiCopy.close),
    inline,
    className,
    overlayClassName,
    bodyClassName,
    'aria-label': ariaLabel,
    onOpenAutoFocus,
    onEscapeKeyDown,
    children,
  } = props

  const hasDescription = hasRenderable(description)
  const renderedIcon =
    typeof icon === 'string'
      ? icon !== ''
        ? <HelmxIcon name={icon} size={15} />
        : null
      : hasRenderable(icon)
        ? icon
        : null

  return (
    <Dialog
      open={open}
      inline={inline}
      onOpenChange={(isOpen) => {
        if (!isOpen && !closeDisabled) onClose()
      }}
    >
      <DialogPortal inline={inline}>
        <DialogOverlay
          className={joinClass(
            'helmx-modal-backdrop',
            size === 'fullscreen' ? 'helmx-modal-backdrop-fullscreen' : undefined,
            overlayClassName,
          )}
        >
          <DialogContent
            ref={contentRef}
            tabIndex={-1}
            className={joinClass('helmx-modal', SIZE_CLASS[size], className)}
            aria-label={ariaLabel}
            {...(hasDescription ? {} : { 'aria-describedby': undefined })}
            onOpenAutoFocus={(event) => {
              if (onOpenAutoFocus !== undefined) {
                onOpenAutoFocus(event)
                return
              }
              event.preventDefault()
              contentRef.current?.focus({ preventScroll: true })
            }}
            onEscapeKeyDown={(event) => {
              if (closeDisabled) {
                event.preventDefault()
                return
              }
              onEscapeKeyDown?.(event)
            }}
            onPointerDownOutside={(event) => {
              if (closeDisabled) event.preventDefault()
            }}
            onInteractOutside={(event) => {
              if (closeDisabled) event.preventDefault()
            }}
          >
            <div className="helmx-modal-header">
              <div className="helmx-modal-header-main">
                {renderedIcon !== null && (
                  <span className="helmx-modal-icon" aria-hidden="true">
                    {renderedIcon}
                  </span>
                )}
                <div className="helmx-modal-title-col">
                  <div className="helmx-modal-title-row">
                    <DialogTitle className="helmx-modal-title">{title}</DialogTitle>
                    {titleExtra}
                  </div>
                  {hasDescription && (
                    <DialogDescription className="helmx-modal-desc">{description}</DialogDescription>
                  )}
                </div>
              </div>
              <div className="helmx-modal-header-actions">
                {headerActions}
                <DialogClose asChild>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon-sm"
                    aria-label={closeLabel}
                    title={closeLabel}
                    disabled={closeDisabled}
                  >
                    <HelmxIcon name="x" size={14} />
                  </button>
                </DialogClose>
              </div>
            </div>
            <div className={joinClass('helmx-modal-body', flushBody ? 'helmx-modal-body-flush' : undefined, bodyClassName)}>
              {children}
            </div>
            {hasRenderable(footer) && <div className="helmx-modal-footer">{footer}</div>}
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}
