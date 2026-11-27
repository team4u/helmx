/**
 * Composer status-row indicator & detail popover for builtin:tiers dual-phase
 * orchestrator tiers (`COMPOSER_STATUS_SLOT`).
 * - Returns `null` before opening any `sessionDoc` subscription on standby
 *   drafts, non-eligible conversations (subagent / `helmx`-owned), or
 *   conversations without an orchestrator tier bound.
 * - Suppresses rendering when a one-turn model borrow (`armed` / `active`)
 *   currently owns the composer toolbar pill so the two surfaces stay mutually
 *   exclusive.
 * - Clicking the compact trigger opens a Radix Popover displaying the full
 *   `tier/<id>`, active phase, Planner & Executor models, and execution steps.
 * Exports only React components (Fast Refresh compliant).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ComposerStatusSlotProps, ConversationSummary } from '@helmx/protocol/browser'
import {
  Badge,
  IconButton,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  resolveLocalizedText,
  useHostModels,
  usePluginLocale,
  usePluginSessionDoc,
} from '@helmx/plugin-client'
import {
  TIERS_BORROW_SESSION_DOC,
  isTiersBorrowEligibleConversation,
  parseTierBorrowSessionView,
} from './borrow-models.ts'
import { ORCHESTRATOR_DEFAULT_MAX_STEPS } from './models.ts'
import {
  TIERS_ORCHESTRATOR_SESSION_DOC,
  formatOrchestratorActiveModelShort,
  hasOrchestratorTierBound,
  parseTierOrchestratorSessionView,
} from './orchestrator-models.ts'
import {
  TIERS_COPY as C,
  orchestratorPopoverStepsValue,
  orchestratorStatusTitle,
} from './copy.ts'
import './styles.css'

function OrchestratorStatusBadgeConversation({
  conversation,
}: {
  conversation: ConversationSummary
}): ReactNode {
  const locale = usePluginLocale()
  const t = useCallback(
    (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale),
    [locale],
  )
  const rawOrchDoc = usePluginSessionDoc<unknown>(TIERS_ORCHESTRATOR_SESSION_DOC, {
    conversationId: conversation.id,
  })
  const rawBorrowDoc = usePluginSessionDoc<unknown>(TIERS_BORROW_SESSION_DOC, {
    conversationId: conversation.id,
  })
  const hostModels = useHostModels()
  const [open, setOpen] = useState(false)

  const borrowView = parseTierBorrowSessionView(rawBorrowDoc)
  const suppressedByBorrow = borrowView !== null

  useEffect(() => {
    setOpen(false)
  }, [conversation.id, suppressedByBorrow])

  if (suppressedByBorrow) {
    return null
  }

  const orchView = parseTierOrchestratorSessionView(rawOrchDoc)
  const fallbackTierId = conversation.modelTier!.replace(/^tier\//, '')
  const tierId = orchView?.tierId ?? fallbackTierId
  const catalogTier = hostModels?.modelTiers?.find((entry) => entry.id === tierId)
  const phase = orchView?.phase ?? 'planning'
  const activeModel = orchView?.activeModel ?? (conversation.model || conversation.modelTier || '')
  const plannerModel = orchView?.plannerModel ?? catalogTier?.model ?? conversation.model
  const executorModel = orchView?.executorModel ?? catalogTier?.executorModel ?? ''
  const stepCount = orchView?.executionStepCount ?? 0
  const maxSteps = orchView?.maxExecutionSteps ?? catalogTier?.maxExecutionSteps ?? ORCHESTRATOR_DEFAULT_MAX_STEPS

  const phaseLabel = phase === 'execution' ? t(C.orchestratorStatusExec) : t(C.orchestratorStatusPlan)
  const modelShort = formatOrchestratorActiveModelShort(activeModel)
  const statusTitle = orchestratorStatusTitle(
    tierId,
    phase,
    plannerModel,
    executorModel,
    stepCount,
    maxSteps,
    locale,
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="tiers-orch-status-trigger"
          data-tiers-orchestrator-phase={phase}
          data-tiers-orchestrator-tier={tierId}
          aria-label={statusTitle}
          title={statusTitle}
        >
          <span className="tiers-orch-status-phase">{phaseLabel}</span>
          {modelShort !== '' ? (
            <>
              <span className="tiers-orch-status-sep" aria-hidden="true">·</span>
              <span className="tiers-orch-status-model mono">{modelShort}</span>
            </>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        portalled
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="tiers-orch-popover"
      >
        <div className="tiers-orch-popover-header">
          <div className="tiers-orch-popover-title-wrap">
            <span className="tiers-orch-popover-title mono">{`tier/${tierId}`}</span>
            <Badge tone="neutral">
              {phase === 'execution' ? t(C.orchestratorPhaseExecution) : t(C.orchestratorPhasePlanning)}
            </Badge>
          </div>
          <PopoverClose asChild>
            <IconButton
              variant="ghost"
              size="xs"
              icon="x"
              label={t(C.close)}
            />
          </PopoverClose>
        </div>
        <div className="tiers-orch-popover-rows">
          <div className="tiers-orch-popover-row" data-active={phase === 'planning' ? 'true' : undefined}>
            <div className="tiers-orch-popover-row-head">
              <span className="tiers-orch-popover-label">{t(C.orchestratorPopoverPlanner)}</span>
              {phase === 'planning' ? (
                <Badge tone="neutral">{t(C.orchestratorPopoverActiveBadge)}</Badge>
              ) : null}
            </div>
            <span className="tiers-orch-popover-model mono">{plannerModel || '—'}</span>
          </div>
          <div className="tiers-orch-popover-row" data-active={phase === 'execution' ? 'true' : undefined}>
            <div className="tiers-orch-popover-row-head">
              <span className="tiers-orch-popover-label">{t(C.orchestratorPopoverExecutor)}</span>
              {phase === 'execution' ? (
                <Badge tone="neutral">{t(C.orchestratorPopoverActiveBadge)}</Badge>
              ) : null}
            </div>
            <span className="tiers-orch-popover-model mono">{executorModel || '—'}</span>
          </div>
          <div className="tiers-orch-popover-row tiers-orch-popover-row--inline">
            <span className="tiers-orch-popover-label">{t(C.orchestratorPopoverSteps)}</span>
            <span className="tiers-orch-popover-steps mono tabular-nums">
              {orchestratorPopoverStepsValue(stepCount, maxSteps, locale)}
            </span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function OrchestratorStatusBadge(props: ComposerStatusSlotProps): ReactNode {
  if (
    props.conversation === undefined ||
    !isTiersBorrowEligibleConversation(props.conversation) ||
    !hasOrchestratorTierBound(props.conversation)
  ) {
    return null
  }
  return <OrchestratorStatusBadgeConversation conversation={props.conversation} />
}
