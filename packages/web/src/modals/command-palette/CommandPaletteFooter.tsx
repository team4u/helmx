import React from 'react'
import { Button } from '@helmx/plugin-client'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import { formatModShortcut } from '../../shell/shortcuts-model.js'

/** 底部快捷键提示（方向 / 回车 / 分屏 / Esc）与「查看全部快捷键」入口。 */
export function CommandPaletteFooter({ onOpenShortcuts }: { onOpenShortcuts: () => void }): React.JSX.Element {
  const { t } = useWebLocale()
  const modEnterHint = formatModShortcut('Enter')
  const shortcutsHint = formatModShortcut('/')
  return (
    <div className="palette-footer">
      <div className="palette-footer-hints" aria-hidden="true">
        <span className="palette-footer-hint">
          <kbd className="kbd-hint">↑↓</kbd>
          <span>{t('modals.palette.footerSelect')}</span>
        </span>
        <span className="palette-footer-hint">
          <kbd className="kbd-hint">Enter</kbd>
          <span>{t('modals.palette.footerOpen')}</span>
        </span>
        <span className="palette-footer-hint">
          <kbd className="kbd-hint">{modEnterHint}</kbd>
          <span>{t('modals.palette.footerSplit')}</span>
        </span>
        <span className="palette-footer-hint">
          <kbd className="kbd-hint">Esc</kbd>
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
        <kbd className="kbd-hint">{shortcutsHint}</kbd>
      </Button>
    </div>
  )
}
