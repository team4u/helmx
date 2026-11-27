import type * as React from 'react'
import { Button, HelmxIcon, Stack } from '@helmx/plugin-client'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import type { AskSubmitting } from './use-ask-card-submission.js'

/** Footer actions: Skip/Cancel on the left, then either the stepper's Next or the submit button. */
export function AskCardFooter({
  isQuestion,
  isSingleConfirm,
  isStepper,
  safeActiveStep,
  lastStepIndex,
  missingRequiredCount,
  submitting,
  shortcutHint,
  cancelBtnRef,
  onCancel,
  onNextStep,
}: {
  isQuestion: boolean
  isSingleConfirm: boolean
  isStepper: boolean
  safeActiveStep: number
  lastStepIndex: number
  missingRequiredCount: number
  submitting: AskSubmitting
  shortcutHint: string | null
  cancelBtnRef: React.RefObject<HTMLButtonElement | null>
  onCancel: () => void
  onNextStep: () => void
}) {
  const { t } = useWebLocale()
  return (
    <Stack direction="horizontal" justify="between" wrap gap="sm" className="ask-dock-actions">
      <div className="ask-dock-actions-left">
        <Button
          ref={cancelBtnRef}
          variant="ghost"
          size="sm"
          pending={submitting === 'cancel'}
          disabled={submitting !== null && submitting !== 'cancel'}
          onClick={onCancel}
        >
          {t(isQuestion ? 'composer.ask.skip' : 'common.cancel')}
        </Button>
        {shortcutHint !== null ? (
          <span className="ask-dock-shortcut-hint">{shortcutHint}</span>
        ) : null}
      </div>
      {isSingleConfirm ? null : isStepper && safeActiveStep < lastStepIndex && missingRequiredCount > 0 ? (
        <Button
          variant="primary"
          size="sm"
          disabled={submitting !== null}
          onClick={onNextStep}
        >
          {t('composer.ask.stepNext')}
        </Button>
      ) : (
        <Button
          type="submit"
          variant="primary"
          size="sm"
          icon={<HelmxIcon name="check" size={12} />}
          pending={submitting === 'answer'}
          disabled={(submitting !== null && submitting !== 'answer') || missingRequiredCount > 0}
        >
          {t(isQuestion ? 'composer.ask.confirm' : 'composer.ask.submit')}
        </Button>
      )}
    </Stack>
  )
}
