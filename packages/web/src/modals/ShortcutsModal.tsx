/**
 * Keyboard shortcuts cheat sheet modal (transient centered Radix Dialog).
 * Consumes the single-source catalog from `buildShortcutCatalog` so built-in
 * and plugin-declared shortcuts stay synchronized without plugin-ID hardcoding.
 */
import { useMemo, type ReactNode } from 'react'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  HelmxIcon,
  IconButton,
} from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useGroupedUi } from '../lib/store-context.js'
import { buildShortcutCatalog } from '../shell/shortcuts-model.js'

export interface ShortcutsModalProps {
  onClose: () => void
  inline?: boolean
}

export function ShortcutsModal({ onClose, inline = false }: ShortcutsModalProps): ReactNode {
  const { locale, t } = useWebLocale()
  const groupedUi = useGroupedUi()

  const sections = useMemo(
    () => buildShortcutCatalog({ pluginCommands: groupedUi.commands, locale, t }),
    [groupedUi.commands, locale, t],
  )

  return (
    <Dialog open inline={inline} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal inline={inline}>
        <DialogOverlay className="modal-backdrop">
          <DialogContent
            className="modal shortcuts-modal"
            aria-label={t('modals.shortcuts.title')}
          >
            <div className="modal-header shortcuts-modal-header">
              <span className="shortcuts-modal-title-group">
                <HelmxIcon name="terminal" size={14} />
                <DialogTitle className="modal-title">{t('modals.shortcuts.title')}</DialogTitle>
              </span>
              <DialogClose asChild>
                <IconButton
                  variant="ghost"
                  size="sm"
                  icon={<HelmxIcon name="x" size={14} />}
                  label={t('modals.shortcuts.closeTitle')}
                />
              </DialogClose>
            </div>
            <div className="modal-body shortcuts-modal-body">
              {sections.map((section) => (
                <section key={section.key} className="shortcuts-section" aria-label={section.title}>
                  <h3 className="shortcuts-section-title">{section.title}</h3>
                  <ul className="shortcuts-list">
                    {section.items.map((item) => (
                      <li key={item.id} className="shortcuts-row" title={item.description}>
                        <span className="shortcuts-row-label">{item.label}</span>
                        <span className="shortcuts-row-keys">
                          <kbd className="kbd-hint">{item.keys}</kbd>
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}
