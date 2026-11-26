import { Button, HelmxIcon } from '@helmx/plugin-client'
import { useWebLocale } from '../../i18n/use-web-locale.js'

/** Source-conversation badge: shown when the ask belongs to another
 * conversation; clicking opens that child conversation's drawer. */
export interface AskSourceInfo {
  conversationId: number
  title: string
}

export function AskCardHeader({
  headerTitle,
  isStepper,
  safeActiveStep,
  lastStepIndex,
  totalSteps,
  disabled,
  source,
  onPrevStep,
  onNextStep,
  onOpenSource,
}: {
  headerTitle: string
  isStepper: boolean
  safeActiveStep: number
  lastStepIndex: number
  totalSteps: number
  disabled: boolean
  source?: AskSourceInfo
  onPrevStep: () => void
  onNextStep: () => void
  onOpenSource: (conversationId: number) => void
}) {
  const { t } = useWebLocale()
  return (
    <div className="ask-dock-header">
      <span className="ask-dock-title">{headerTitle}</span>
      {isStepper ? (
        <div className="ask-dock-step-nav">
          <button
            type="button"
            className="ask-dock-step-nav-btn"
            aria-label={t('composer.ask.stepPrev')}
            title={t('composer.ask.stepPrev')}
            disabled={disabled || safeActiveStep === 0}
            onClick={onPrevStep}
          >
            <HelmxIcon name="chevron-left" size={13} />
          </button>
          <span className="ask-dock-step-counter tabular-nums" aria-live="polite">
            {t('composer.ask.stepCounter', {
              current: safeActiveStep + 1,
              total: totalSteps,
            })}
          </span>
          <button
            type="button"
            className="ask-dock-step-nav-btn"
            aria-label={t('composer.ask.stepNext')}
            title={t('composer.ask.stepNext')}
            disabled={disabled || safeActiveStep >= lastStepIndex}
            onClick={onNextStep}
          >
            <HelmxIcon name="chevron-right" size={13} />
          </button>
        </div>
      ) : null}
      {source !== undefined ? (
        <Button
          variant="ghost"
          size="sm"
          icon={<HelmxIcon name="corner-down-right" size={11} />}
          className="ask-dock-source-btn"
          title={source.title !== ''
            ? t('composer.ask.openChildTitle', { id: source.conversationId, title: source.title })
            : t('composer.ask.openChildDrawer', { id: source.conversationId })}
          aria-label={t('composer.ask.openChildDrawer', { id: source.conversationId })}
          onClick={() => onOpenSource(source.conversationId)}
        >
          {t('composer.ask.fromSource', { id: source.conversationId })}
        </Button>
      ) : null}
    </div>
  )
}
