import { useMemo, useId, useRef, useState } from 'react'
import { resolveLocalizedText, type AskSpec } from '@helmx/protocol/browser'
import { Callout, HelperText } from '@helmx/plugin-client'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import { useStoreActions } from '../../lib/store-context.js'
import {
  extractTerminalSnapshot,
  isMultiChoiceField,
  isSingleQuickChoiceQuestion,
  isSingleRequiredConfirm,
  missingRequiredFields,
  resolveAskKeyboardChoiceTarget,
  resolveAskKind,
  shouldPromoteFieldLabelToHeader,
  shouldUseQuestionStepper,
} from '../ask-dock-model.js'
import { AskCardFieldList } from './AskCardFieldList.js'
import { AskCardFooter } from './AskCardFooter.js'
import { AskCardHeader, type AskSourceInfo } from './AskCardHeader.js'
import { AskCardSnapshot } from './AskCardSnapshot.js'
import { useAskCardAnswers } from './use-ask-card-answers.js'
import { useAskCardFocus } from './use-ask-card-focus.js'
import { useAskCardKeyboard } from './use-ask-card-keyboard.js'
import { useAskCardSubmission } from './use-ask-card-submission.js'

export function AskCard({
  ask,
  source,
  hostConversationId,
  isPrimaryCard,
  hasNextPendingAsk,
  shortcutPanel,
  shortcutActive,
  onFocusReturn,
}: {
  ask: AskSpec
  source?: AskSourceInfo
  hostConversationId: number
  isPrimaryCard: boolean
  hasNextPendingAsk: boolean
  shortcutPanel: 'primary' | 'split' | 'drawer'
  shortcutActive: boolean
  onFocusReturn?: () => void
}) {
  const { openConversationDrawer } = useStoreActions()
  const { locale, t } = useWebLocale()
  // The same approval/prompt can appear in both an ancestor panel and a child
  // conversation drawer; form labels associate with this instance only.
  const formId = useId()
  const formRef = useRef<HTMLFormElement | null>(null)
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null)

  const askKind = resolveAskKind(ask)
  const isQuestion = askKind === 'question'
  const isStepper = shouldUseQuestionStepper(ask)
  const isSingleConfirm = isSingleRequiredConfirm(ask)
  const isSingleQuickChoice = isSingleQuickChoiceQuestion(ask)
  const lastStepIndex = Math.max(0, ask.fields.length - 1)

  const titleText = resolveLocalizedText(ask.title, locale)
  const singleField = ask.fields.length === 1 ? ask.fields[0] : undefined
  const promoteLabelToHeader =
    singleField !== undefined &&
    shouldPromoteFieldLabelToHeader(ask, titleText, resolveLocalizedText(singleField.label, locale))
  const headerTitle =
    promoteLabelToHeader && singleField !== undefined ? resolveLocalizedText(singleField.label, locale) : titleText
  const descText = ask.description !== undefined ? resolveLocalizedText(ask.description, locale) : ''
  const hintText = ask.hint !== undefined ? resolveLocalizedText(ask.hint, locale) : ''
  const snapshot = useMemo(() => extractTerminalSnapshot(ask, descText), [ask, descText])

  const [activeStep, setActiveStep] = useState(0)
  const safeActiveStep = isStepper ? Math.min(activeStep, Math.max(0, ask.fields.length - 1)) : 0
  const safeActiveStepRef = useRef(safeActiveStep)
  safeActiveStepRef.current = safeActiveStep
  const [snapshotOpen, setSnapshotOpen] = useState(false)

  const { isWindowShortcutOwner, focusStepPrimaryControl } = useAskCardFocus({
    askId: ask.id,
    formRef,
    isPrimaryCard,
    safeActiveStep,
    safeActiveStepRef,
    shortcutPanel,
    shortcutActive,
    hostConversationId,
  })
  const { submitting, submittingRef, error, submitAnswers, cancel } = useAskCardSubmission({
    ask,
    formRef,
    hasNextPendingAsk,
    onFocusReturn,
  })
  const { answers, answersRef, applyFieldPatch, advanceOrSubmitFromStep, submitSingleOption, enterNextOrSubmit, submitForm } =
    useAskCardAnswers({
      ask,
      isStepper,
      isSingleConfirm,
      isSingleQuickChoice,
      lastStepIndex,
      submittingRef,
      submitAnswers,
      focusStepPrimaryControl,
      setActiveStep,
    })
  const { handleSharedKeyDown, optionFocusReqs, customFocusSignals } = useAskCardKeyboard({
    ask,
    isStepper,
    isSingleConfirm,
    lastStepIndex,
    formRef,
    cancelBtnRef,
    safeActiveStepRef,
    answersRef,
    submittingRef,
    isWindowShortcutOwner,
    focusStepPrimaryControl,
    submitAnswers,
    applyFieldPatch,
    advanceOrSubmitFromStep,
    setActiveStep,
  })

  const missingRequired = useMemo(() => missingRequiredFields(ask, answers), [ask, answers])

  const visibleDescription =
    snapshot?.source === 'description'
      ? snapshot.prefix
      : descText.trim() ? descText : undefined

  const activeField = isStepper ? ask.fields[safeActiveStep] : undefined
  const activeChoiceField = resolveAskKeyboardChoiceTarget(ask, isStepper, safeActiveStep)?.field
  const shortcutHintKey = isStepper
    ? 'composer.ask.shortcutHintStepper'
    : activeChoiceField !== undefined && isMultiChoiceField(activeChoiceField)
      ? 'composer.ask.shortcutHintMulti'
      : 'composer.ask.shortcutHint'
  const showShortcutHint =
    activeChoiceField !== undefined || (isStepper && activeField !== undefined)

  const goToPrevStep = (): void => setActiveStep((step) => Math.max(0, step - 1))
  const goToNextStep = (): void => setActiveStep((step) => Math.min(lastStepIndex, step + 1))

  return (
    <form
      ref={formRef}
      className={`ask-dock ask-dock--${askKind}`}
      data-ask-kind={askKind}
      tabIndex={-1}
      onKeyDown={(e) => handleSharedKeyDown(e, 'form')}
      onSubmit={(e) => {
        e.preventDefault()
        void submitForm()
      }}
    >
      <AskCardHeader
        headerTitle={headerTitle}
        isStepper={isStepper}
        safeActiveStep={safeActiveStep}
        lastStepIndex={lastStepIndex}
        totalSteps={ask.fields.length}
        disabled={submitting !== null}
        source={source}
        onPrevStep={goToPrevStep}
        onNextStep={goToNextStep}
        onOpenSource={openConversationDrawer}
      />
      {visibleDescription !== undefined ? (
        <div className="ask-dock-desc">{visibleDescription}</div>
      ) : null}
      {snapshot !== undefined ? (
        <AskCardSnapshot
          text={snapshot.text}
          open={snapshotOpen}
          onToggle={() => setSnapshotOpen((v) => !v)}
        />
      ) : null}
      <AskCardFieldList
        ask={ask}
        askKind={askKind}
        isStepper={isStepper}
        formId={formId}
        promoteLabelToHeader={promoteLabelToHeader}
        safeActiveStep={safeActiveStep}
        submitting={submitting}
        answers={answers}
        optionFocusReqs={optionFocusReqs}
        customFocusSignals={customFocusSignals}
        applyFieldPatch={applyFieldPatch}
        submitSingleOption={submitSingleOption}
        enterNextOrSubmit={enterNextOrSubmit}
        focusForm={() => formRef.current?.focus()}
      />
      {hintText.trim() !== '' ? (
        <HelperText className="ask-dock-hint">{hintText}</HelperText>
      ) : null}
      {error !== null ? (
        <Callout tone="err">
          <span className="callout-text">{error}</span>
        </Callout>
      ) : null}
      <AskCardFooter
        isQuestion={isQuestion}
        isSingleConfirm={isSingleConfirm}
        isStepper={isStepper}
        safeActiveStep={safeActiveStep}
        lastStepIndex={lastStepIndex}
        missingRequiredCount={missingRequired.length}
        submitting={submitting}
        shortcutHint={showShortcutHint ? t(shortcutHintKey) : null}
        cancelBtnRef={cancelBtnRef}
        onCancel={() => void cancel()}
        onNextStep={goToNextStep}
      />
    </form>
  )
}
