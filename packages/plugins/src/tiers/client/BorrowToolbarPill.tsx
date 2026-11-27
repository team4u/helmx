/**
 * Composer toolbar pill + ModelPicker mode registration for builtin:tiers
 * one-turn model borrow (`COMPOSER_TOOLBAR_SLOT`).
 * - Registers the `tiers:one-turn` mode in the host `ModelPickerControl` via
 *   `useComposerModelPickerMode` when eligible and idle (not `active` / `busy` / `disabled`);
 * - Idle & unarmed: returns `null` (zero DOM / zero Tab stops);
 * - Armed (`armed` or standby `draftMeta`): compact 24px pill `[ Next turn: <label> × ]`
 *   where clicking the pill opens the host `ModelPicker` straight to the `Next turn` tab
 *   and clicking sibling `×` clears the armed borrow;
 * - Active (`active`): compact 24px pill `[ This turn: <label> × ]` with main button
 *   disabled and sibling `×` still enabled even while busy to cancel auto-restore.
 * Exports only React components (Fast Refresh compliant).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ComposerToolbarSlotProps, ConversationSummary } from '@helmx/protocol/browser'
import {
  HelmxIcon,
  formatModelShortName,
  resolveLocalizedText,
  useComposerModelPickerMode,
  usePluginAction,
  usePluginLocale,
  usePluginSessionDoc,
  type ComposerModelPickerModeSelection,
  type ComposerModelPickerModeSpec,
} from '@helmx/plugin-client'
import {
  TIERS_BORROW_SESSION_DOC,
  TIERS_INPUT_META_KEY,
  formatBorrowTargetLabel,
  isConversationBusyForBorrow,
  isTiersBorrowEligibleConversation,
  makeStandbyBorrowMetaValue,
  parseTierBorrowSessionView,
  readStandbyBorrowDraft,
  type TierBorrowSessionView,
} from './borrow-models.ts'
import {
  ORCHESTRATOR_DEFAULT_MAX_STEPS,
} from './models.ts'
import {
  TIERS_ORCHESTRATOR_SESSION_DOC,
  formatOrchestratorPillModelLabel,
  hasOrchestratorTierBound,
  parseTierOrchestratorSessionView,
} from './orchestrator-models.ts'
import {
  TIERS_COPY as C,
  borrowActivePillTitle,
  borrowArmedPillTitle,
  orchestratorPillTitle,
  tiersActionFailed,
} from './copy.ts'
import './styles.css'

function BorrowToolbarPillConversation({
  conversation,
  disabled,
}: {
  conversation: ConversationSummary
  disabled: boolean
}): ReactNode {
  const locale = usePluginLocale()
  const t = useCallback(
    (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale),
    [locale],
  )
  const rawDoc = usePluginSessionDoc<unknown>(TIERS_BORROW_SESSION_DOC, {
    conversationId: conversation.id,
  })
  const rawOrchDoc = usePluginSessionDoc<unknown>(TIERS_ORCHESTRATOR_SESSION_DOC, {
    conversationId: conversation.id,
  })
  const rawDocRef = useRef<unknown>(rawDoc)
  rawDocRef.current = rawDoc
  const hasOrchTier = hasOrchestratorTierBound(conversation)
  const orchView = hasOrchTier ? parseTierOrchestratorSessionView(rawOrchDoc) : null

  const [optimistic, setOptimistic] = useState<{
    conversationId: number
    baseDoc: unknown
    view: TierBorrowSessionView | null
  } | null>(null)

  useEffect(() => {
    setOptimistic((prev) =>
      prev !== null && prev.conversationId === conversation.id && prev.baseDoc === rawDoc ? prev : null,
    )
  }, [conversation.id, rawDoc])

  const docView = parseTierBorrowSessionView(rawDoc)
  const effectiveBorrow =
    optimistic !== null && optimistic.conversationId === conversation.id && optimistic.baseDoc === rawDoc
      ? optimistic.view
      : docView

  const busy = isConversationBusyForBorrow(conversation)

  const borrowAction = usePluginAction({
    notifyError: true,
    formatError: (err) => tiersActionFailed(err, locale),
  })

  const handleApply = useCallback(
    async ({ modelKey, thinkingLevel }: ComposerModelPickerModeSelection): Promise<void> => {
      if (borrowAction.pending) return
      const baseDoc = rawDocRef.current
      await borrowAction.run(
        'set_borrow',
        {
          conversationId: conversation.id,
          model: modelKey,
          ...(thinkingLevel !== '' ? { effort: thinkingLevel } : {}),
        },
        {
          conversationId: conversation.id,
          onSuccess: (raw) => {
            const parsed = parseTierBorrowSessionView(raw)
            if (parsed !== null && rawDocRef.current === baseDoc) {
              setOptimistic({ conversationId: conversation.id, baseDoc, view: parsed })
            }
          },
        },
      )
    },
    [borrowAction, conversation.id],
  )

  const handleClear = useCallback(async (): Promise<void> => {
    if (borrowAction.pending) return
    const baseDoc = rawDocRef.current
    await borrowAction.run(
      'clear_borrow',
      { conversationId: conversation.id },
      {
        conversationId: conversation.id,
        onSuccess: () => {
          if (rawDocRef.current === baseDoc) {
            setOptimistic({ conversationId: conversation.id, baseDoc, view: null })
          }
        },
      },
    )
  }, [borrowAction, conversation.id])

  const isActive = effectiveBorrow?.phase === 'active'
  const modeSpec: ComposerModelPickerModeSpec | null =
    !disabled && !busy && !isActive
      ? {
          id: 'tiers:one-turn',
          label: t(C.oneTurnTabLabel),
          hint: t(C.oneTurnModeHint),
          ...(effectiveBorrow !== null ? { effectiveModel: effectiveBorrow.targetModel } : {}),
          activeThinkingLevel: effectiveBorrow?.effort ?? '',
          hideResetDefault: true,
          onApply: handleApply,
        }
      : null

  const { openMode } = useComposerModelPickerMode('tiers:one-turn', modeSpec)

  if (effectiveBorrow === null) {
    if (!hasOrchTier) {
      return null
    }
    const phase = orchView?.phase ?? 'planning'
    const activeModel = orchView?.activeModel ?? (conversation.model || conversation.modelTier || '')
    const stepCount = orchView?.executionStepCount ?? 0
    const maxSteps = orchView?.maxExecutionSteps ?? ORCHESTRATOR_DEFAULT_MAX_STEPS
    const prefix = phase === 'execution' ? t(C.orchestratorPillExecuting) : t(C.orchestratorPillPlanning)
    const modelLabel =
      orchView !== null
        ? formatOrchestratorPillModelLabel(activeModel, phase, stepCount, maxSteps)
        : (formatModelShortName(activeModel) || activeModel)
    const tierId = orchView?.tierId ?? conversation.modelTier!.replace(/^tier\//, '')
    const pillTitle = orchestratorPillTitle(
      tierId,
      phase,
      orchView?.plannerModel ?? conversation.model,
      orchView?.executorModel ?? '',
      stepCount,
      maxSteps,
      locale,
    )
    return (
      <span
        className={`tiers-borrow-pill tiers-orchestrator-pill ${
          phase === 'execution' ? 'tiers-borrow-pill--active' : 'tiers-borrow-pill--armed'
        }`}
        data-tiers-orchestrator-phase={phase}
        data-tiers-orchestrator-tier={tierId}
        title={pillTitle}
      >
        <span className="tiers-borrow-pill-main tiers-orchestrator-pill-body">
          <HelmxIcon name="workflow" size={11} />
          <span className="tiers-borrow-pill-prefix">{prefix}</span>
          <span className="tiers-borrow-pill-model mono">{modelLabel}</span>
        </span>
      </span>
    )
  }

  const mainDisabled = disabled || busy || isActive || borrowAction.pending
  const clearDisabled = disabled || borrowAction.pending
  const targetText = formatBorrowTargetLabel(effectiveBorrow.targetLabel, effectiveBorrow.effort)
  const pillPrefix = isActive ? t(C.borrowPillActivePrefix) : t(C.borrowPillArmedPrefix)
  const mainTitle = isActive
    ? borrowActivePillTitle(effectiveBorrow.targetConcreteModel, locale)
    : borrowArmedPillTitle(effectiveBorrow.targetConcreteModel, locale)
  const clearAria = isActive ? t(C.borrowClearActiveAria) : t(C.borrowClearArmedAria)

  return (
    <span
      className={`tiers-borrow-pill ${isActive ? 'tiers-borrow-pill--active' : 'tiers-borrow-pill--armed'}`}
      data-tiers-borrow-phase={effectiveBorrow.phase}
      data-tiers-borrow-model={effectiveBorrow.targetModel}
    >
      <button
        type="button"
        className="tiers-borrow-pill-main"
        disabled={mainDisabled}
        title={mainTitle}
        onClick={() => {
          if (!mainDisabled) {
            openMode()
          }
        }}
      >
        {borrowAction.pending ? (
          <HelmxIcon name="loader" size={11} className="spin-slow" />
        ) : (
          <HelmxIcon name="sparkles" size={11} />
        )}
        <span className="tiers-borrow-pill-prefix">{pillPrefix}</span>
        <span className="tiers-borrow-pill-model mono">{targetText}</span>
      </button>
      <button
        type="button"
        className="tiers-borrow-pill-clear"
        aria-label={clearAria}
        title={clearAria}
        disabled={clearDisabled}
        onClick={() => void handleClear()}
      >
        <HelmxIcon name="x" size={11} />
      </button>
    </span>
  )
}

function BorrowToolbarPillStandby({
  draftMeta,
  setDraftMeta,
  disabled,
}: {
  draftMeta?: Readonly<Record<string, unknown>>
  setDraftMeta: (key: string, value: unknown) => void
  disabled: boolean
}): ReactNode {
  const locale = usePluginLocale()
  const t = useCallback(
    (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale),
    [locale],
  )
  const standbyBorrow = readStandbyBorrowDraft(draftMeta)

  const handleApply = useCallback(
    ({ modelKey, thinkingLevel }: ComposerModelPickerModeSelection): void => {
      setDraftMeta(TIERS_INPUT_META_KEY, makeStandbyBorrowMetaValue(modelKey, thinkingLevel))
    },
    [setDraftMeta],
  )

  const handleClear = useCallback((): void => {
    setDraftMeta(TIERS_INPUT_META_KEY, undefined)
  }, [setDraftMeta])

  const modeSpec: ComposerModelPickerModeSpec | null = !disabled
    ? {
        id: 'tiers:one-turn',
        label: t(C.oneTurnTabLabel),
        hint: t(C.oneTurnModeHint),
        ...(standbyBorrow !== null ? { effectiveModel: standbyBorrow.borrowModel } : {}),
        activeThinkingLevel: standbyBorrow?.effort ?? '',
        hideResetDefault: true,
        onApply: handleApply,
      }
    : null

  const { openMode } = useComposerModelPickerMode('tiers:one-turn', modeSpec)

  if (standbyBorrow === null) {
    return null
  }

  const targetText = formatBorrowTargetLabel(standbyBorrow.borrowModel, standbyBorrow.effort)
  const mainTitle = borrowArmedPillTitle(standbyBorrow.borrowModel, locale)
  const clearAria = t(C.borrowClearArmedAria)

  return (
    <span
      className="tiers-borrow-pill tiers-borrow-pill--armed"
      data-tiers-borrow-phase="armed"
      data-tiers-borrow-model={standbyBorrow.borrowModel}
    >
      <button
        type="button"
        className="tiers-borrow-pill-main"
        disabled={disabled}
        title={mainTitle}
        onClick={() => {
          if (!disabled) {
            openMode()
          }
        }}
      >
        <HelmxIcon name="sparkles" size={11} />
        <span className="tiers-borrow-pill-prefix">{t(C.borrowPillArmedPrefix)}</span>
        <span className="tiers-borrow-pill-model mono">{targetText}</span>
      </button>
      <button
        type="button"
        className="tiers-borrow-pill-clear"
        aria-label={clearAria}
        title={clearAria}
        disabled={disabled}
        onClick={handleClear}
      >
        <HelmxIcon name="x" size={11} />
      </button>
    </span>
  )
}

export function BorrowToolbarPill(props: ComposerToolbarSlotProps): ReactNode {
  if (props.conversation !== undefined) {
    if (!isTiersBorrowEligibleConversation(props.conversation)) {
      return null
    }
    return (
      <BorrowToolbarPillConversation
        conversation={props.conversation}
        disabled={props.disabled === true}
      />
    )
  }
  if (props.profileId === undefined || props.setDraftMeta === undefined) {
    return null
  }
  return (
    <BorrowToolbarPillStandby
      draftMeta={props.draftMeta}
      setDraftMeta={props.setDraftMeta}
      disabled={props.disabled === true}
    />
  )
}
