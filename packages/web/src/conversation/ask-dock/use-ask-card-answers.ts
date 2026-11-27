/**
 * Answer state machine for one AskCard: the current answers (mirrored into a ref
 * so synchronous handlers never read a stale render) and the patch / advance /
 * submit transitions the fields, the key chain and the footer all drive. The
 * stepper position is owned by the card and moved here through setActiveStep.
 * Single-confirm and single quick-choice prompts submit immediately on their first answer.
 */
import { useCallback, useRef, useState } from 'react'
import type * as React from 'react'
import type { AskAnswers, AskSpec } from '@helmx/protocol/browser'
import {
  findNextUnansweredStep,
  initialAskAnswers,
  isMultiChoiceField,
  missingRequiredFields,
} from '../ask-dock-model.js'
import type { AskSubmitting } from './use-ask-card-submission.js'

type FieldPatchMeta = { fromPresetClick?: boolean }

interface AskCardAnswersOptions {
  ask: AskSpec
  isStepper: boolean
  isSingleConfirm: boolean
  isSingleQuickChoice: boolean
  lastStepIndex: number
  submittingRef: React.RefObject<AskSubmitting>
  submitAnswers: (payload: AskAnswers) => Promise<void>
  focusStepPrimaryControl: (stepIndex: number) => boolean
  setActiveStep: React.Dispatch<React.SetStateAction<number>>
}

export interface AskCardAnswers {
  answers: AskAnswers
  answersRef: React.RefObject<AskAnswers>
  /** Merge a field patch; may also submit or auto-advance the stepper. Returns the merged answers. */
  applyFieldPatch: (fieldIndex: number, patch: AskAnswers, meta?: FieldPatchMeta) => AskAnswers
  /** Step to the next unanswered step, submit when complete, or focus the first missing field. */
  advanceOrSubmitFromStep: (fieldIndex: number, candidateAnswers: AskAnswers) => void
  /** Enter on a single-select option: pick it, then advance or submit. */
  submitSingleOption: (fieldIndex: number, fieldName: string, optValue: string) => void
  /** Enter inside a text control: advance or submit from that field. */
  enterNextOrSubmit: (fieldIndex: number) => void
  /** Form submit guard: never fires for single-confirm, while a request is in flight, or with missing required fields. */
  submitForm: () => Promise<void>
}

export function useAskCardAnswers({
  ask,
  isStepper,
  isSingleConfirm,
  isSingleQuickChoice,
  lastStepIndex,
  submittingRef,
  submitAnswers,
  focusStepPrimaryControl,
  setActiveStep,
}: AskCardAnswersOptions): AskCardAnswers {
  const [answers, setAnswers] = useState<AskAnswers>(() => initialAskAnswers(ask.fields))
  const answersRef = useRef<AskAnswers>(answers)
  answersRef.current = answers

  const applyFieldPatch = useCallback(
    (fieldIndex: number, patch: AskAnswers, meta?: FieldPatchMeta): AskAnswers => {
      const nextAnswers: AskAnswers = { ...answersRef.current, ...patch }
      answersRef.current = nextAnswers
      setAnswers((prev) => ({ ...prev, ...patch }))
      if (isSingleConfirm || (isSingleQuickChoice && meta?.fromPresetClick === true)) {
        void submitAnswers(isSingleConfirm ? patch : nextAnswers)
        return nextAnswers
      }
      const field = ask.fields[fieldIndex]
      if (
        isStepper &&
        meta?.fromPresetClick === true &&
        field !== undefined &&
        field.type === 'choice' &&
        !isMultiChoiceField(field)
      ) {
        const nextIdx = findNextUnansweredStep(ask, nextAnswers, fieldIndex)
        if (nextIdx !== -1) {
          setActiveStep(nextIdx)
        }
      }
      return nextAnswers
    },
    [ask, isSingleConfirm, isSingleQuickChoice, isStepper, submitAnswers, setActiveStep],
  )

  const advanceOrSubmitFromStep = useCallback(
    (fieldIndex: number, candidateAnswers: AskAnswers): void => {
      if (isSingleConfirm || submittingRef.current !== null) return
      if (isStepper) {
        const nextUnanswered = findNextUnansweredStep(ask, candidateAnswers, fieldIndex)
        if (nextUnanswered !== -1 && fieldIndex < lastStepIndex) {
          setActiveStep(nextUnanswered)
          return
        }
        if (missingRequiredFields(ask, candidateAnswers).length === 0) {
          void submitAnswers(candidateAnswers)
          return
        }
        if (nextUnanswered !== -1) {
          setActiveStep(nextUnanswered)
          return
        }
      }
      const missing = missingRequiredFields(ask, candidateAnswers)
      if (missing.length === 0) {
        void submitAnswers(candidateAnswers)
        return
      }
      const firstMissingIdx = ask.fields.findIndex((f) => f.name === missing[0]?.name)
      if (firstMissingIdx >= 0) {
        if (isStepper) setActiveStep(firstMissingIdx)
        else focusStepPrimaryControl(firstMissingIdx)
      }
    },
    [ask, focusStepPrimaryControl, isSingleConfirm, isStepper, lastStepIndex, setActiveStep, submitAnswers, submittingRef],
  )

  const submitSingleOption = useCallback(
    (fieldIndex: number, fieldName: string, optValue: string): void => {
      const nextAnswers = applyFieldPatch(fieldIndex, { [fieldName]: optValue }, { fromPresetClick: false })
      advanceOrSubmitFromStep(fieldIndex, nextAnswers)
    },
    [advanceOrSubmitFromStep, applyFieldPatch],
  )

  const enterNextOrSubmit = useCallback(
    (fieldIndex: number): void => {
      advanceOrSubmitFromStep(fieldIndex, answersRef.current)
    },
    [advanceOrSubmitFromStep, answersRef],
  )

  const submitForm = async (): Promise<void> => {
    const curAnswers = answersRef.current
    if (isSingleConfirm || submittingRef.current !== null || missingRequiredFields(ask, curAnswers).length > 0) {
      return
    }
    await submitAnswers(curAnswers)
  }

  return {
    answers,
    answersRef,
    applyFieldPatch,
    advanceOrSubmitFromStep,
    submitSingleOption,
    enterNextOrSubmit,
    submitForm,
  }
}
