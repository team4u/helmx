import React from 'react'
import { Button, Kbd } from '@helmx/ui'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { formatModShortcut } from '../shell/shortcuts-model.js'

export interface OmniboxFooterProps {
  secondaryActionLabel?: string
  onOpenShortcuts: () => void
}

export function OmniboxFooter({
  secondaryActionLabel,
  onOpenShortcuts,
}: OmniboxFooterProps): React.JSX.Element {
  const { t } = useWebLocale()
  const modEnterHint = formatModShortcut('Enter')
  const shortcutsHint = formatModShortcut('/')
  return (
    <div className="palette-footer">
      <div className="palette-footer-hints" aria-hidden="true">
        <span className="palette-footer-hint">
          <Kbd size="sm">↑↓</Kbd>
          <span>{t('modals.palette.footerSelect')}</span>
        </span>
        <span className="palette-footer-hint">
          <Kbd size="sm">Enter</Kbd>
          <span>{t('modals.palette.footerOpen')}</span>
        </span>
        <span className="palette-footer-hint">
          <Kbd size="sm">{modEnterHint}</Kbd>
          <span>{t('modals.palette.footerSplit')}</span>
        </span>
        {secondaryActionLabel !== undefined && (
          <span className="palette-footer-hint">
            <Kbd size="sm">Alt+Enter</Kbd>
            <span>{secondaryActionLabel}</span>
          </span>
        )}
        <span className="palette-footer-hint">
          <Kbd size="sm">Tab</Kbd>
          <span>{t('modals.omnibox.footerSwitchScope')}</span>
        </span>
        <span className="palette-footer-hint">
          <Kbd size="sm">Esc</Kbd>
          <span>{t('modals.palette.footerClose')}</span>
        </span>
      </div>
      <Button
        variant="ghost"
        size="xs"
        className="palette-footer-shortcuts-btn"
        onClick={onOpenShortcuts}
      >
        <span>{t('modals.palette.footerShortcuts')}</span>
        <Kbd size="sm">{shortcutsHint}</Kbd>
      </Button>
    </div>
  )
}
