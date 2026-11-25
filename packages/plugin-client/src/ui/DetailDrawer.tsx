/**
 * Right-side detail drawer shell shared by host centers and plugin screens.
 *
 * Reuses only the host common CSS vocabulary (.primary-drawer-* family +
 * .modal-backdrop, defined in the host styles.css cascade and already consumed
 * by both host pages and builtin plugin clients such as the workflow library
 * drawer): no new CSS theme is introduced and no portal-free layout is
 * invented. The frame is a Radix Dialog (WAI-ARIA semantics, Escape / outside
 * click, focus trap via the Dialog wrapper in this package); the header, meta
 * line, body and footer are composable slots — business content stays in the
 * caller's JSX, this shell never touches data ports or navigation.
 *
 * SSR safe: under renderToString the DialogPortal inlines automatically, so
 * the shell renders real markup without a DOM (pass inline to force it in the
 * browser too).
 *
 * This file only exports components and TS types (Fast Refresh friendly).
 */
import { useRef, type ReactNode } from 'react'
import { HelmxIcon } from '../icons.js'
import { usePluginTranslator } from '../i18n.js'
import { uiCopy } from '../ui-copy.js'
import { Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle } from './Dialog.js'

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export interface DetailDrawerProps {
  /** Whether the drawer is open (fully controlled; onClose fires on Escape / outside click / close button). */
  open: boolean
  /** Close request: wire it to the owner state (also invoked by the header close button). */
  onClose: () => void
  /** Force inline rendering, skipping the DOM portal (SSR / renderToString default in Node). */
  inline?: boolean
  /** Main title (rendered as the Radix DialogTitle of the frame, associated via aria-labelledby). */
  title: ReactNode
  /** Inline extras right of the title (badges, versions; laid out by .primary-drawer-title-row). */
  titleExtra?: ReactNode
  /** Optional icon block on the left of the title column (.primary-drawer-icon-wrap, e.g. <HelmxIcon name="monitor" />). */
  icon?: ReactNode
  /** Secondary mono line below the title (entity id / file path). */
  meta?: ReactNode
  /** Extra consumer-styled line(s) below the meta line inside the title column. */
  belowTitle?: ReactNode
  /** Extra classes appended to the title (.primary-drawer-title), e.g. break-word. */
  titleClassName?: string
  /** Extra classes appended to the meta line (.primary-drawer-id mono), e.g. text-subtle break-word. */
  metaClassName?: string
  /** Explicit accessible name; omit to fall back to the DialogTitle association. */
  'aria-label'?: string
  /** Accessible name of the header close button (defaults to the shared UI locale). */
  closeLabel?: string
  /** Sticky footer action row (.primary-drawer-footer); omit to render no footer. */
  footer?: ReactNode
  /** Extra classes appended to .primary-drawer-content (screen-specific layout tweaks). */
  className?: string
  /** Extra classes appended to the backdrop overlay (.modal-backdrop .primary-drawer-backdrop). */
  overlayClassName?: string
  /** Extra classes appended to .primary-drawer-body. */
  bodyClassName?: string
  /** Close button classes (defaults to the icon-size ghost button used by host centers). */
  closeButtonClassName?: string
  /** Close button glyph (defaults to the shared HelmxIcon x). */
  closeIcon?: ReactNode
  /** Drawer body content (business JSX; empty / loading states belong to the caller). */
  children: ReactNode
  /**
   * Auxiliary overlay content rendered inside the Dialog root after the drawer
   * portal (e.g. nested confirm dialogs) so it shares the same overlay layer
   * stack; state and data belong to the caller.
   */
  aux?: ReactNode
}

/**
 * Right-side detail drawer frame over the host .primary-drawer-* common
 * vocabulary: header (icon + title row + meta line + close), scrollable body
 * and optional footer. Composes the SSR-safe Dialog primitives of this
 * package; state and data stay with the caller.
 */
export function DetailDrawer(props: DetailDrawerProps): ReactNode {
  const t = usePluginTranslator()
  const contentRef = useRef<HTMLDivElement | null>(null)
  const {
    open,
    onClose,
    inline,
    title,
    titleExtra,
    icon,
    meta,
    belowTitle,
    titleClassName,
    metaClassName,
    'aria-label': ariaLabel,
    closeLabel = t(uiCopy.close),
    footer,
    className,
    overlayClassName,
    bodyClassName,
    closeButtonClassName = 'btn btn-ghost btn-icon-sm',
    closeIcon = <HelmxIcon name="x" size={14} />,
    children,
    aux,
  } = props
  return (
    <Dialog
      open={open}
      inline={inline}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose()
      }}
    >
      <DialogPortal inline={inline}>
        <DialogOverlay className={joinClass('modal-backdrop', 'primary-drawer-backdrop', overlayClassName)} />
        <DialogContent
          ref={contentRef}
          tabIndex={-1}
          className={joinClass('primary-drawer-content', className)}
          aria-label={ariaLabel}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            contentRef.current?.focus({ preventScroll: true })
          }}
        >
          <div className="primary-drawer-header">
            <div className="primary-drawer-header-left">
              {icon !== undefined && <div className="primary-drawer-icon-wrap">{icon}</div>}
              <div className="primary-drawer-title-col">
                <div className="primary-drawer-title-row">
                  <DialogTitle className={joinClass('primary-drawer-title', titleClassName)}>{title}</DialogTitle>
                  {titleExtra}
                </div>
                {meta !== undefined && <div className={joinClass('primary-drawer-id', 'mono', metaClassName)}>{meta}</div>}
                {belowTitle}
              </div>
            </div>
            <DialogClose asChild>
              {/* Single close channel: DialogClose funnels through the controlled
                  onOpenChange(false) → onClose chain; an extra onClick here would
                  double-fire every close click. */}
              <button
                type="button"
                className={closeButtonClassName}
                aria-label={closeLabel}
                title={closeLabel}
              >
                {closeIcon}
              </button>
            </DialogClose>
          </div>
          <div className={joinClass('primary-drawer-body', bodyClassName)}>{children}</div>
          {footer !== undefined && <div className="primary-drawer-footer">{footer}</div>}
        </DialogContent>
      </DialogPortal>
      {aux}
    </Dialog>
  )
}
