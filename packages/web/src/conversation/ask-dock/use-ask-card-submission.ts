/**
 * Answer / cancel request lifecycle for one AskCard: both requests share the
 * same lock-and-report shape (lock the form while in flight, surface the error
 * in place, and hand focus back to the composer only when this was the last
 * pending ask and focus is not held elsewhere). Answering still goes through
 * asksApi with the ask's expectedStateSeq CAS watermark.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type * as React from 'react'
import type { AskAnswers, AskSpec } from '@helmx/protocol/browser'
import { asksApi } from '../../lib/api.js'

export type AskSubmitting = 'answer' | 'cancel' | null

interface AskCardSubmissionOptions {
  ask: AskSpec
  formRef: React.RefObject<HTMLFormElement | null>
  hasNextPendingAsk: boolean
  onFocusReturn?: () => void
}

export interface AskCardSubmission {
  submitting: AskSubmitting
  submittingRef: React.RefObject<AskSubmitting>
  error: string | null
  submitAnswers: (payload: AskAnswers) => Promise<void>
  cancel: () => Promise<void>
}

export function useAskCardSubmission({
  ask,
  formRef,
  hasNextPendingAsk,
  onFocusReturn,
}: AskCardSubmissionOptions): AskCardSubmission {
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const [submitting, setSubmitting] = useState<AskSubmitting>(null)
  const submittingRef = useRef<AskSubmitting>(submitting)
  submittingRef.current = submitting
  const [error, setError] = useState<string | null>(null)

  const runRequest = useCallback(
    async (kind: Exclude<AskSubmitting, null>, request: () => Promise<unknown>): Promise<void> => {
      const hadFocus = formRef.current?.contains(document.activeElement) ?? false
      setSubmitting(kind)
      submittingRef.current = kind
      setError(null)
      try {
        await request()
        if (
          !hasNextPendingAsk &&
          (hadFocus || document.activeElement === document.body || document.activeElement === null)
        ) {
          onFocusReturn?.()
        }
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        submittingRef.current = null
        if (mountedRef.current) {
          setSubmitting(null)
        }
      }
    },
    [formRef, hasNextPendingAsk, onFocusReturn],
  )

  const submitAnswers = useCallback(
    (payload: AskAnswers): Promise<void> =>
      runRequest('answer', () => asksApi.answer(ask.id, payload, ask.expectedStateSeq)),
    [ask.id, ask.expectedStateSeq, runRequest],
  )

  const cancel = useCallback(
    (): Promise<void> => runRequest('cancel', () => asksApi.cancel(ask.id)),
    [ask.id, runRequest],
  )

  return { submitting, submittingRef, error, submitAnswers, cancel }
}
