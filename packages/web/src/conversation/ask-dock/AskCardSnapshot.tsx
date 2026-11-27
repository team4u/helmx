import { Button, HelmxIcon } from '@helmx/ui'
import { useWebLocale } from '../../i18n/use-web-locale.js'

/** Collapsible tail of a terminal snapshot attached to the ask (context or fenced description block). */
export function AskCardSnapshot({
  text,
  open,
  onToggle,
}: {
  text: string
  open: boolean
  onToggle: () => void
}) {
  const { t } = useWebLocale()
  return (
    <div className="ask-dock-snapshot">
      <Button
        variant="ghost"
        size="sm"
        icon={<HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />}
        className="ask-dock-snapshot-btn"
        onClick={onToggle}
      >
        {t('composer.ask.terminalSnapshot')}
      </Button>
      {open ? (
        <pre className="code-block-pre selectable ask-dock-snapshot-pre">
          <code>{text}</code>
        </pre>
      ) : null}
    </div>
  )
}
