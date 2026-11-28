/**
 * Composer status-row indicator & detail popover for builtin:orchestrator
 * (`COMPOSER_STATUS_SLOT`).
 * - Returns `null` before opening any `sessionDoc` subscription on standby
 *   drafts (`props.conversation === undefined`) or non-eligible conversations
 *   (subagent / `helmx`-owned).
 * - Clicking the compact `22px` trigger opens a Radix Popover displaying the
 *   Orchestrator name, `tier/<id>`, active phase, Planner & interactive
 *   Executor models, and execution steps.
 * Exports only React components (Fast Refresh compliant).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ComposerStatusSlotProps, ConversationSummary } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  Callout,
  IconButton,
  MonoId,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverHeader,
  PopoverTrigger,
  Stack,
} from '@helmx/ui'
import {
  ModelPickerControl,
  formatModelShortName,
  resolveDefaultChainThinkingLevel,
  useHostModels,
  usePluginAction,
  usePluginContext,
  usePluginDocValue,
  usePluginLocale,
  usePluginSessionDocValue,
  usePluginTranslator,
} from '@helmx/plugin-client'
import {
  ORCHESTRATOR_COPY,
  buildOrchestratorPickerCopy,
  formatOrchestratorOverrideClearedNotice,
  formatOrchestratorOverrideUpdatedNotice,
  formatOrchestratorPopoverStepsValue,
  formatOrchestratorStatusTitle,
} from './copy.ts'
import {
  ORCHESTRATOR_PLUGIN_ID,
  ORCHESTRATOR_SCREEN_ID,
  ORCHESTRATOR_SESSION_DOC,
  ORCHESTRATOR_STATE_DOC,
  isOrchestratorEligibleConversation,
  matchOrchestratorItemFromModelRef,
  parseOrchestratorSessionDoc,
  parseOrchestratorStateDoc,
  resolveEndpointDisplay,
} from './models.ts'
import './styles.css'

export function OrchestratorStatusPill(props: ComposerStatusSlotProps): ReactNode {
  if (props.conversation === undefined || !isOrchestratorEligibleConversation(props.conversation)) {
    return null
  }
  return <EligibleOrchestratorStatusPill conversation={props.conversation} />
}

function EligibleOrchestratorStatusPill({
  conversation,
}: {
  conversation: ConversationSummary
}): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const hostModels = useHostModels()
  const rawState = usePluginDocValue(ORCHESTRATOR_PLUGIN_ID, ORCHESTRATOR_STATE_DOC)
  const stateDoc = useMemo(() => parseOrchestratorStateDoc(rawState), [rawState])
  const rawSession = usePluginSessionDocValue(ORCHESTRATOR_SESSION_DOC, {
    conversationId: conversation.id,
    pluginId: ORCHESTRATOR_PLUGIN_ID,
  })
  const session = useMemo(() => parseOrchestratorSessionDoc(rawSession), [rawSession])

  const actions = usePluginAction({
    formatError: (err) => (err instanceof Error ? err.message : String(err)),
  })

  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pickerCopy = useMemo(() => buildOrchestratorPickerCopy(locale), [locale])

  useEffect(() => {
    setOpen(false)
    setError(null)
  }, [conversation.id])

  const fallbackItem = useMemo(
    () =>
      matchOrchestratorItemFromModelRef(
        conversation.effectiveModelRef ?? conversation.modelOverride,
        stateDoc.items,
      ),
    [conversation.effectiveModelRef, conversation.modelOverride, stateDoc.items],
  )

  const handleOpenEditor = useCallback(
    (orchestratorId: string) => {
      setOpen(false)
      ctx.openScreen(
        `screen:${ORCHESTRATOR_PLUGIN_ID}/${ORCHESTRATOR_SCREEN_ID}?edit=${encodeURIComponent(orchestratorId)}`,
      )
    },
    [ctx],
  )

  const handleOverrideExecutor = useCallback(
    (model: string, level: string | null) => {
      setError(null)
      void actions.run(
        'override_executor',
        {
          conversationId: conversation.id,
          executorModel: model,
          ...(level !== null ? { executorThinkingLevel: level } : {}),
        },
        {
          key: 'override_executor',
          onSuccess: () => {
            ctx.notify(formatOrchestratorOverrideUpdatedNotice(model, locale), 'info')
          },
          onError: (msg) => {
            setError(msg)
          },
        },
      )
    },
    [conversation.id, actions, ctx, locale],
  )

  const handleClearOverride = useCallback(() => {
    setError(null)
    void actions.run(
      'clear_override',
      { conversationId: conversation.id },
      {
        key: 'clear_override',
        onSuccess: () => {
          ctx.notify(formatOrchestratorOverrideClearedNotice(locale), 'info')
        },
        onError: (msg) => {
          setError(msg)
        },
      },
    )
  }, [conversation.id, actions, ctx, locale])

  const hasSession = session !== null && session.enabled
  if (!hasSession && fallbackItem === undefined) {
    return null
  }

  const orchestratorId = hasSession ? session.orchestratorId : fallbackItem!.id
  const orchestratorName = hasSession ? session.orchestratorName : fallbackItem!.name
  const activeItem = stateDoc.items[orchestratorId] ?? fallbackItem
  const suppressed = hasSession
    ? session.suppressedByCoordinator === true
    : Array.isArray(conversation.tags) && conversation.tags.includes('swarm-coordinator')
  const phase = suppressed ? 'planning' : hasSession ? session.phase : 'planning'
  const stepLimitPaused = hasSession && session.stepLimitPaused && !suppressed
  const hasOverride = hasSession && session.hasExecutorOverride
  const stepCount = hasSession ? session.executionStepCount : 0
  const maxSteps = hasSession ? session.maxExecutionSteps : fallbackItem!.maxExecutionSteps

  const fallbackPlanner = !hasSession
    ? resolveEndpointDisplay(fallbackItem!.plannerModel, fallbackItem!.plannerThinkingLevel, hostModels)
    : undefined
  const fallbackExecutor = !hasSession
    ? resolveEndpointDisplay(fallbackItem!.executorModel, fallbackItem!.executorThinkingLevel, hostModels)
    : undefined

  const plannerConcrete = hasSession
    ? session.plannerModel
    : (fallbackPlanner?.concreteModel ?? fallbackItem!.plannerModel)
  const plannerThinking = hasSession ? session.plannerThinkingLevel : fallbackPlanner?.thinkingLevel
  const executorConcrete = hasSession
    ? session.executorModel
    : (fallbackExecutor?.concreteModel ?? fallbackItem!.executorModel)
  const executorThinking = hasSession ? session.executorThinkingLevel : fallbackExecutor?.thinkingLevel

  const activeModelShort =
    phase === 'execution' && !suppressed
      ? formatModelShortName(executorConcrete)
      : formatModelShortName(plannerConcrete)

  const phaseLabel = suppressed
    ? t(ORCHESTRATOR_COPY.statusCoord)
    : phase === 'execution'
      ? t(ORCHESTRATOR_COPY.statusExec)
      : t(ORCHESTRATOR_COPY.statusPlan)

  const phaseBadgeLabel = suppressed
    ? t(ORCHESTRATOR_COPY.phaseCoordinator)
    : phase === 'execution'
      ? t(ORCHESTRATOR_COPY.phaseExecution)
      : t(ORCHESTRATOR_COPY.phasePlanning)

  const statusTitle = formatOrchestratorStatusTitle(
    orchestratorName,
    orchestratorId,
    phase,
    suppressed,
    plannerConcrete || '—',
    executorConcrete || '—',
    stepCount,
    maxSteps,
    locale,
  )

  const plannerDisplayLevel = resolveDefaultChainThinkingLevel(
    hostModels ?? undefined,
    activeItem?.plannerModel ?? plannerConcrete,
    plannerThinking,
    'tier',
  )
  const plannerBaseDisplay =
    activeItem &&
    activeItem.plannerModel.startsWith('tier/') &&
    plannerConcrete &&
    plannerConcrete !== activeItem.plannerModel
      ? `${activeItem.plannerModel} (${formatModelShortName(plannerConcrete)})`
      : (plannerConcrete || activeItem?.plannerModel || '—')
  const plannerFullDisplay =
    plannerDisplayLevel !== '' && plannerDisplayLevel !== 'off'
      ? `${plannerBaseDisplay} · ${plannerDisplayLevel}`
      : plannerBaseDisplay

  const executorPickerDisplayModel =
    activeItem && !hasOverride ? activeItem.executorModel : executorConcrete
  const executorPickerThinking = resolveDefaultChainThinkingLevel(
    hostModels ?? undefined,
    executorPickerDisplayModel,
    executorThinking,
    'tier',
  )
  const executorButtonTitle = executorPickerDisplayModel
    ? executorPickerThinking !== '' && executorPickerThinking !== 'off'
      ? `${executorPickerDisplayModel} · ${executorPickerThinking}`
      : executorPickerDisplayModel
    : t(ORCHESTRATOR_COPY.pickModelPlaceholder)

  const overriding = actions.pending && actions.pendingKey === 'override_executor'
  const clearing = actions.pending && actions.pendingKey === 'clear_override'
  const busy = overriding || clearing

  const pillClassName = `helmx-toolbar-pill orch-status-trigger${stepLimitPaused ? ' helmx-toolbar-pill--warn' : ''}`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={pillClassName}
          data-orch-phase={phase}
          data-orch-suppressed={suppressed ? 'true' : undefined}
          aria-label={statusTitle}
          title={statusTitle}
        >
          <span className="orch-status-phase">{phaseLabel}</span>
          {activeModelShort !== '' ? (
            <>
              <span className="orch-status-sep" aria-hidden="true">·</span>
              <span className="orch-status-model mono">{activeModelShort}</span>
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
        className="orch-popover"
      >
        <PopoverHeader
          divider
          className="orch-popover-header"
          title={
            <span className="orch-popover-title-wrap">
              <span className="orch-popover-title">{orchestratorName}</span>
              <MonoId value={`tier/${orchestratorId}`} copyable={false} />
              <Badge tone={stepLimitPaused ? 'warn' : 'neutral'}>{phaseBadgeLabel}</Badge>
            </span>
          }
          trailing={
            <Stack direction="horizontal" gap="xs">
              {orchestratorId ? (
                <IconButton
                  variant="ghost"
                  size="xs"
                  icon="pencil"
                  label={t(ORCHESTRATOR_COPY.pillEdit)}
                  title={t(ORCHESTRATOR_COPY.pillEdit)}
                  onClick={() => handleOpenEditor(orchestratorId)}
                />
              ) : null}
              <PopoverClose asChild>
                <IconButton variant="ghost" size="xs" icon="x" label={t(ORCHESTRATOR_COPY.close)} />
              </PopoverClose>
            </Stack>
          }
        />
        <div className="orch-popover-rows">
          {error !== null ? <Callout tone="err">{error}</Callout> : null}
          {stepLimitPaused ? <Callout tone="warn">{t(ORCHESTRATOR_COPY.pillStepLimitPaused)}</Callout> : null}
          {suppressed ? <Callout tone="warn">{t(ORCHESTRATOR_COPY.pillCoordinatorHint)}</Callout> : null}

          <div
            className="orch-popover-row"
            data-active={phase === 'planning' && !suppressed ? 'true' : undefined}
          >
            <div className="orch-popover-row-head">
              <span className="orch-popover-label">{t(ORCHESTRATOR_COPY.plannerLabel)}</span>
              {phase === 'planning' && !suppressed ? (
                <Badge tone="neutral">{t(ORCHESTRATOR_COPY.activeBadge)}</Badge>
              ) : null}
            </div>
            <span className="orch-popover-model mono">{plannerFullDisplay}</span>
          </div>

          <div
            className="orch-popover-row"
            data-active={phase === 'execution' && !suppressed ? 'true' : undefined}
          >
            <div className="orch-popover-row-head">
              <span className="orch-popover-label">{t(ORCHESTRATOR_COPY.executorLabel)}</span>
              <span className="orch-popover-badges">
                {hasOverride ? <Badge tone="accent">{t(ORCHESTRATOR_COPY.overrideBadge)}</Badge> : null}
                {phase === 'execution' && !suppressed ? (
                  <Badge tone="neutral">{t(ORCHESTRATOR_COPY.activeBadge)}</Badge>
                ) : null}
              </span>
            </div>
            <ModelPickerControl
              variant="field"
              size="sm"
              buttonAriaLabel={t(ORCHESTRATOR_COPY.fieldExecutor)}
              effectiveModel={executorPickerDisplayModel || undefined}
              activeThinkingLevel={executorPickerThinking}
              placeholderLabel={t(ORCHESTRATOR_COPY.pickModelPlaceholder)}
              buttonTitle={executorButtonTitle}
              resetLabel={t(ORCHESTRATOR_COPY.pillClearOverride)}
              resetTitle={t(ORCHESTRATOR_COPY.pillClearOverride)}
              enableShortcut={false}
              allowTiers
              allowPreserveRefTiers={false}
              disabled={busy}
              copy={pickerCopy}
              onNotice={(msg, tone) => ctx.notify(msg, tone)}
              onApply={handleOverrideExecutor}
              onResetDefault={hasOverride ? handleClearOverride : undefined}
            />
            {hasOverride ? (
              <div className="orch-popover-override-actions">
                <Button
                  variant="ghost"
                  size="xs"
                  icon="rotate-ccw"
                  pending={clearing}
                  disabled={busy}
                  onClick={handleClearOverride}
                >
                  {t(ORCHESTRATOR_COPY.pillClearOverride)}
                </Button>
              </div>
            ) : null}
          </div>

          <div className="orch-popover-row orch-popover-row--inline">
            <span className="orch-popover-label">{t(ORCHESTRATOR_COPY.stepsLabel)}</span>
            <span className="orch-popover-steps mono tabular-nums">
              {formatOrchestratorPopoverStepsValue(stepCount, maxSteps, locale)}
            </span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
