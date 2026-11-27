import { HelmxIcon } from '@helmx/ui'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { formatPluginCommandLabel, type QualifiedCommand } from '../lib/commands-model.js'

export interface ComposerCommandBannerProps {
  command: QualifiedCommand
}

export function ComposerCommandBanner({ command }: ComposerCommandBannerProps) {
  const { locale, t } = useWebLocale()
  const label = formatPluginCommandLabel(command, locale)
  return (
    <div className="composer-command-banner" role="status" aria-live="polite">
      <span className="composer-command-banner-text">
        <HelmxIcon name="loader" size={12} className="spin-slow" />
        <span className="composer-command-banner-label">{t('composer.command.running', { label })}</span>
      </span>
    </div>
  )
}
