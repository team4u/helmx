import { Field, Stack } from '@helmx/ui'
import { resolveLocalizedText, type AskAnswers, type AskKind, type AskSpec } from '@helmx/protocol/browser'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import { AskFieldInput, type FocusChoiceOptionRequest } from '../AskDockFields.js'
import type { AskSubmitting } from './use-ask-card-submission.js'

type FieldPatchMeta = { fromPresetClick?: boolean }

/** One step panel per field; in a stepper only the active step is visible. A promoted sole question drops its field label (header carries it). */
export function AskCardFieldList({
  ask,
  askKind,
  isStepper,
  formId,
  promoteLabelToHeader,
  safeActiveStep,
  submitting,
  answers,
  optionFocusReqs,
  customFocusSignals,
  applyFieldPatch,
  submitSingleOption,
  enterNextOrSubmit,
  focusForm,
}: {
  ask: AskSpec
  askKind: AskKind
  isStepper: boolean
  /** Per-card form id prefix: the same ask can render in an ancestor panel and a child drawer, labels must not collide. */
  formId: string
  promoteLabelToHeader: boolean
  safeActiveStep: number
  submitting: AskSubmitting
  answers: AskAnswers
  optionFocusReqs: Readonly<Record<string, FocusChoiceOptionRequest>>
  customFocusSignals: Readonly<Record<string, number>>
  applyFieldPatch: (fieldIndex: number, patch: AskAnswers, meta?: FieldPatchMeta) => AskAnswers
  submitSingleOption: (fieldIndex: number, fieldName: string, optValue: string) => void
  enterNextOrSubmit: (fieldIndex: number) => void
  focusForm: () => void
}) {
  const { locale } = useWebLocale()
  const isQuestion = askKind === 'question'
  if (ask.fields.length === 0) return null
  return (
    <Stack gap="sm" className="ask-dock-fields">
      {ask.fields.map((field, index) => {
        const fieldLabel = resolveLocalizedText(field.label, locale)
        const fieldId = `${formId}-${field.name}`
        const rawThinking =
          typeof field.thinkingLevelField === 'string' && field.thinkingLevelField !== ''
            ? answers[field.thinkingLevelField]
            : undefined
        const stepHidden = isStepper && index !== safeActiveStep
        const control = (
          <AskFieldInput
            conversationId={ask.conversationId}
            askKind={askKind}
            isStepper={isStepper}
            field={field}
            fieldId={fieldId}
            fieldLabel={fieldLabel}
            value={answers[field.name]}
            thinkingLevelValue={typeof rawThinking === 'string' ? rawThinking : undefined}
            focusCustomSignal={customFocusSignals[field.name] ?? 0}
            focusOptionReq={optionFocusReqs[field.name]}
            disabled={submitting !== null}
            onPatchAnswers={(patch, meta) => applyFieldPatch(index, patch, meta)}
            onSingleOptionEnter={(optValue) => submitSingleOption(index, field.name, optValue)}
            onEnterNextOrSubmit={() => enterNextOrSubmit(index)}
            onExitTextToCard={focusForm}
          />
        )
        return (
          <div
            key={field.name}
            className="ask-dock-step-panel"
            hidden={stepHidden}
          >
            {promoteLabelToHeader ? (
              <div className="ask-dock-field">{control}</div>
            ) : (
              <Field
                className="ask-dock-field"
                label={fieldLabel}
                required={!isQuestion && field.required === true}
                htmlFor={field.type === 'confirm' || field.type === 'choice' ? false : fieldId}
              >
                {control}
              </Field>
            )}
          </div>
        )
      })}
    </Stack>
  )
}
