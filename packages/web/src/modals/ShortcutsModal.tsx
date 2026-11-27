/**
 * Keyboard shortcuts cheat sheet modal (transient centered Radix Dialog).
 * Consumes the single-source catalog from `buildShortcutCatalog` so built-in
 * and plugin-declared shortcuts stay synchronized without plugin-ID hardcoding.
 */
import { useMemo, type ReactNode } from 'react'
import { Kbd, ModalDialog } from '@helmx/ui'
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
    <ModalDialog
      open
      inline={inline}
      onClose={onClose}
      size="md"
      icon="terminal"
      title={t('modals.shortcuts.title')}
      closeLabel={t('modals.shortcuts.closeTitle')}
      className="shortcuts-modal"
      bodyClassName="shortcuts-modal-body"
      aria-label={t('modals.shortcuts.title')}
    >
      {sections.map((section) => (
        <section key={section.key} className="shortcuts-section" aria-label={section.title}>
          <h3 className="shortcuts-section-title">{section.title}</h3>
          <ul className="shortcuts-list">
            {section.items.map((item) => (
              <li key={item.id} className="shortcuts-row" title={item.description}>
                <span className="shortcuts-row-label">{item.label}</span>
                <span className="shortcuts-row-keys">
                  <Kbd>{item.keys}</Kbd>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </ModalDialog>
  )
}
