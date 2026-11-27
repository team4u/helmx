import { useEffect, useMemo, useState } from 'react'
import { Kbd } from '@helmx/ui'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { isImeComposing } from '../lib/ime.js'
import { ComposerPopoverShell } from './ComposerPopoverShell.js'

// ---------------------------------------------------------------------------
// Slash command popover (Radix Popover over .composer-box anchor with WAI-ARIA
// listbox semantics; falls back inline when rendered standalone without anchorRef)
// ---------------------------------------------------------------------------

export interface PopoverItem {
  id: string
  label: string
  hint?: string
  /** Trigger word written back into the draft (plugin commands run instead). */
  apply?: string
  /** Plugin command: picked items execute immediately (no draft write-back). */
  run?: () => void
}
/** Keyboard-visible candidate cap: ↑↓ cycling stays inside this list. */
const SLASH_VISIBLE_LIMIT = 12

export interface CommandPopoverProps {
  query: string
  /** Pre-merged slash menu items (incl. plugin commands); omitted falls back to host builtin items. */
  slashItems?: ReadonlyArray<PopoverItem>
  onPick: (apply: string, caretSuffix?: string) => void
  onClose: () => void
  /** Host anchor (.composer-box); when supplied renders through Radix Popover. */
  anchorRef?: { current: HTMLElement | null }
  /** Owner composer input (<textarea>): interactions/focus returning to it never dismiss the popover. */
  inputRef?: { current: HTMLElement | null }
}

export function CommandPopover({
  query,
  slashItems,
  onPick,
  onClose,
  anchorRef,
  inputRef,
}: CommandPopoverProps) {
  const { t } = useWebLocale()
  const [active, setActive] = useState(0)

  const items = useMemo<PopoverItem[]>(() => {
    const q = query.toLowerCase()
    if (slashItems !== undefined) {
      return slashItems.filter((i) => i.id.toLowerCase().includes(q) || i.label.toLowerCase().includes(q))
    }
    const builtin: PopoverItem[] = [
      { id: '/new', label: '/new', hint: t('composer.command.newHint'), apply: '/new' },
      { id: '/clear', label: '/clear', hint: t('composer.command.clearHint'), apply: '/clear' },
      { id: '/compact', label: '/compact', hint: t('composer.command.compactHint'), apply: '/compact' },
    ]
    return builtin.filter((i) => i.id.toLowerCase().includes(q))
  }, [query, slashItems, t])

  // Keyboard cycling is limited to the visible candidates, fixing the old bug
  // where the index could reach past the truncated list. Memoization keeps the
  // array identity stable so the keyboard effect does not re-bind listeners
  // while the item set is unchanged.
  const visible = useMemo(() => items.slice(0, SLASH_VISIBLE_LIMIT), [items])
  const visibleKeys = visible.map((item) => item.id).join('|')

  useEffect(() => {
    setActive(0)
  }, [query, visibleKeys])

  const commitItem = (item: PopoverItem | undefined): void => {
    if (item === undefined) return
    if (item.run !== undefined) {
      onClose()
      item.run()
    } else if (item.apply !== undefined) {
      onPick(item.apply)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Never intercept while IME is composing (syllables may contain triggers;
      // Enter belongs to candidate confirmation).
      if (isImeComposing(e)) return
      if (visible.length === 0) {
        if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          onClose()
        }
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        setActive((i) => (i + 1) % visible.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        setActive((i) => (i - 1 + visible.length) % visible.length)
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        commitItem(visible[active])
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible, active, onPick, onClose])

  const body =
    visible.length === 0 ? (
      <div className="popover-item composer-completion-state" role="status">
        {t('composer.command.noMatches')}
      </div>
    ) : (
      <>
        <div className="popover-header">
          {t('composer.command.header')}
          <Kbd size="sm" desktopOnly>{t('composer.kbd.navConfirmClose')}</Kbd>
        </div>
        <div role="listbox" aria-label={t('composer.command.header')} className="composer-completion-list">
          {visible.map((item, idx) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={idx === active}
              className={`popover-item${idx === active ? ' popover-item-active' : ''}`}
              onMouseEnter={() => setActive(idx)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commitItem(item)}
            >
              <span className="mono">{item.label}</span>
              {item.hint !== undefined ? <span className="popover-item-meta">{item.hint}</span> : null}
            </button>
          ))}
        </div>
        {items.length > visible.length ? (
          <div className="popover-item composer-completion-state" role="status">
            {t('composer.completion.tooManyTitle', { limit: SLASH_VISIBLE_LIMIT })}
          </div>
        ) : null}
      </>
    )

  const anchor = anchorRef?.current ?? null
  if (anchor !== null) {
    return (
      <ComposerPopoverShell
        open
        anchor={anchor}
        inputRef={inputRef}
        ariaLabel={t('composer.command.header')}
        onClose={onClose}
      >
        {body}
      </ComposerPopoverShell>
    )
  }

  return (
    <div className="composer-popover" aria-label={t('composer.command.header')}>
      {body}
    </div>
  )
}
