/**
 * Shared client-side toggle hook for persisted builtin:plan conversation views.
 * Manages sessionDoc subscription, optimistic pending view, and error notices
 * so PlanToolbarButton and PlanMenuItem stay single-source.
 */
import { useEffect, useRef, useState } from 'react'
import { resolveLocalizedText } from '@helmx/ui'
import { usePluginAction, usePluginLocale, usePluginSessionDocState } from '@helmx/plugin-client'
import { PLAN_COPY, planActionFailedNotice } from './copy.ts'
import { parsePlanSessionView } from './models.ts'
import { PLAN_SESSION_DOC, type PlanSessionView } from './types.ts'

const DEFAULT_NORMAL_VIEW: PlanSessionView = {
  mode: 'normal',
  awaitingApproval: false,
}

export interface PlanConversationToggleState {
  effectiveView: PlanSessionView
  docError?: string
  pending: boolean
  toggle: () => void
}

export function usePlanConversationToggle(conversationId: number): PlanConversationToggleState {
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)
  const docState = usePluginSessionDocState<unknown>(PLAN_SESSION_DOC, { conversationId })
  const rawDocRef = useRef<unknown>(docState.data)
  rawDocRef.current = docState.data

  const [pendingView, setPendingView] = useState<{
    conversationId: number
    baseDoc: unknown
    view: PlanSessionView
  } | null>(null)

  useEffect(() => {
    setPendingView((prev) =>
      prev !== null && prev.conversationId === conversationId && prev.baseDoc === docState.data ? prev : null,
    )
  }, [conversationId, docState.data])

  const docView = parsePlanSessionView(docState.data)
  const effectiveView =
    pendingView !== null && pendingView.conversationId === conversationId && pendingView.baseDoc === docState.data
      ? pendingView.view
      : (docView ?? DEFAULT_NORMAL_VIEW)

  const toggleAction = usePluginAction({
    notifyError: true,
    formatError: (err) =>
      planActionFailedNotice(t(PLAN_COPY.actionToggle), err instanceof Error ? err.message : String(err), locale),
  })

  const toggle = (): void => {
    if (toggleAction.pending) return
    const baseDoc = rawDocRef.current
    void toggleAction.run(
      'toggle',
      { conversationId },
      {
        conversationId,
        onSuccess: (raw) => {
          const parsed = parsePlanSessionView(raw)
          if (parsed !== undefined && rawDocRef.current === baseDoc) {
            setPendingView({ conversationId, baseDoc, view: parsed })
          }
        },
      },
    )
  }

  return {
    effectiveView,
    ...(docState.status === 'error' && docState.error ? { docError: docState.error } : {}),
    pending: toggleAction.pending,
    toggle,
  }
}
