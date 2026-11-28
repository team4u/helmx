/**
 * Composer status-row indicator & detail popover for builtin:duo Orchestrator
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
  DUO_COPY,
  buildDuoPickerCopy,
  formatDuoOverrideClearedNotice,
  formatDuoOverrideUpdatedNotice,
  formatDuoPopoverStepsValue,
  formatDuoStatusTitle,
} from './copy.ts'
import {
  DUO_PLUGIN_ID,
  DUO_SCREEN_ID,
  DUO_SESSION_DOC,
  DUO_STATE_DOC,
  isDuoEligibleConversation,
  matchDuoRecipeFromModelRef,
  parseDuoSessionDoc,
  parseDuoStateDoc,
  resolveEndpointDisplay,
} from './models.ts'
import './styles.css'

export function DuoToolbarPill(props: ComposerStatusSlotProps): ReactNode {
  if (props.conversation === undefined || !isDuoEligibleConversation(props.conversation)) {
    return null
  }
  return <EligibleDuoStatusPill conversation={props.conversation} />
}

function EligibleDuoStatusPill({
  conversation,
}: {
  conversation: ConversationSummary
}): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const hostModels = useHostModels()
  const rawState = usePluginDocValue(DUO_PLUGIN_ID, DUO_STATE_DOC)
  const stateDoc = useMemo(() => parseDuoStateDoc(rawState), [rawState])
  const rawSession = usePluginSessionDocValue(DUO_SESSION_DOC, {
    conversationId: conversation.id,
    pluginId: DUO_PLUGIN_ID,
  })
  const session = useMemo(() => parseDuoSessionDoc(rawSession), [rawSession])

  const actions = usePluginAction({
    formatError: (err) => (err instanceof Error ? err.message : String(err)),
  })

  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pickerCopy = useMemo(() => buildDuoPickerCopy(locale), [locale])

  useEffect(() => {
    setOpen(false)
    setError(null)
  }, [conversation.id])

  const fallbackRecipe = useMemo(
    () =>
      matchDuoRecipeFromModelRef(
        conversation.effectiveModelRef ?? conversation.modelOverride,
        stateDoc.recipes,
      ),
    [conversation.effectiveModelRef, conversation.modelOverride, stateDoc.recipes],
  )

  const handleOpenEditor = useCallback(
    (recipeId: string) => {
      setOpen(false)
      ctx.openScreen(`screen:${DUO_PLUGIN_ID}/${DUO_SCREEN_ID}?edit=${encodeURIComponent(recipeId)}`)
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
            ctx.notify(formatDuoOverrideUpdatedNotice(model, locale), 'info')
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
          ctx.notify(formatDuoOverrideClearedNotice(locale), 'info')
        },
        onError: (msg) => {
          setError(msg)
        },
      },
    )
  }, [conversation.id, actions, ctx, locale])

  const hasSession = session !== null && session.enabled
  if (!hasSession && fallbackRecipe === undefined) {
    return null
  }

  const recipeId = hasSession ? session.recipeId : fallbackRecipe!.id
  const recipeName = hasSession ? session.recipeName : fallbackRecipe!.name
  const activeRecipe = stateDoc.recipes[recipeId] ?? fallbackRecipe
  const suppressed = hasSession
    ? session.suppressedByCoordinator === true
    : Array.isArray(conversation.tags) && conversation.tags.includes('swarm-coordinator')
  const phase = suppressed ? 'planning' : hasSession ? session.phase : 'planning'
  const stepLimitPaused = hasSession && session.stepLimitPaused && !suppressed
  const hasOverride = hasSession && session.hasExecutorOverride
  const stepCount = hasSession ? session.executionStepCount : 0
  const maxSteps = hasSession ? session.maxExecutionSteps : fallbackRecipe!.maxExecutionSteps

  const fallbackPlanner = !hasSession
    ? resolveEndpointDisplay(fallbackRecipe!.plannerModel, fallbackRecipe!.plannerThinkingLevel, hostModels)
    : undefined
  const fallbackExecutor = !hasSession
    ? resolveEndpointDisplay(fallbackRecipe!.executorModel, fallbackRecipe!.executorThinkingLevel, hostModels)
    : undefined

  const plannerConcrete = hasSession
    ? session.plannerModel
    : (fallbackPlanner?.concreteModel ?? fallbackRecipe!.plannerModel)
  const plannerThinking = hasSession ? session.plannerThinkingLevel : fallbackPlanner?.thinkingLevel
  const executorConcrete = hasSession
    ? session.executorModel
    : (fallbackExecutor?.concreteModel ?? fallbackRecipe!.executorModel)
  const executorThinking = hasSession ? session.executorThinkingLevel : fallbackExecutor?.thinkingLevel

  const activeModelShort =
    phase === 'execution' && !suppressed
      ? formatModelShortName(executorConcrete)
      : formatModelShortName(plannerConcrete)

  const phaseLabel = suppressed
    ? t(DUO_COPY.statusCoord)
    : phase === 'execution'
      ? t(DUO_COPY.statusExec)
      : t(DUO_COPY.statusPlan)

  const phaseBadgeLabel = suppressed
    ? t(DUO_COPY.phaseCoordinator)
    : phase === 'execution'
      ? t(DUO_COPY.phaseExecution)
      : t(DUO_COPY.phasePlanning)

  const statusTitle = formatDuoStatusTitle(
    recipeName,
    recipeId,
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
    activeRecipe?.plannerModel ?? plannerConcrete,
    plannerThinking,
    'tier',
  )
  const plannerBaseDisplay =
    activeRecipe &&
    activeRecipe.plannerModel.startsWith('tier/') &&
    plannerConcrete &&
    plannerConcrete !== activeRecipe.plannerModel
      ? `${activeRecipe.plannerModel} (${formatModelShortName(plannerConcrete)})`
      : (plannerConcrete || activeRecipe?.plannerModel || '—')
  const plannerFullDisplay =
    plannerDisplayLevel !== '' && plannerDisplayLevel !== 'off'
      ? `${plannerBaseDisplay} · ${plannerDisplayLevel}`
      : plannerBaseDisplay

  const executorPickerDisplayModel =
    activeRecipe && !hasOverride ? activeRecipe.executorModel : executorConcrete
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
    : t(DUO_COPY.pickModelPlaceholder)

  const overriding = actions.pending && actions.pendingKey === 'override_executor'
  const clearing = actions.pending && actions.pendingKey === 'clear_override'
  const busy = overriding || clearing

  const pillClassName = `helmx-toolbar-pill duo-status-trigger${stepLimitPaused ? ' helmx-toolbar-pill--warn' : ''}`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={pillClassName}
          data-duo-phase={phase}
          data-duo-suppressed={suppressed ? 'true' : undefined}
          aria-label={statusTitle}
          title={statusTitle}
        >
          <span className="duo-status-phase">{phaseLabel}</span>
          {activeModelShort !== '' ? (
            <>
              <span className="duo-status-sep" aria-hidden="true">·</span>
              <span className="duo-status-model mono">{activeModelShort}</span>
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
        className="duo-popover"
      >
        <PopoverHeader
          divider
          className="duo-popover-header"
          title={
            <span className="duo-popover-title-wrap">
              <span className="duo-popover-title">{recipeName}</span>
              <MonoId value={`tier/${recipeId}`} copyable={false} />
              <Badge tone={stepLimitPaused ? 'warn' : 'neutral'}>{phaseBadgeLabel}</Badge>
            </span>
          }
          trailing={
            <Stack direction="horizontal" gap="xs">
              {recipeId ? (
                <IconButton
                  variant="ghost"
                  size="xs"
                  icon="pencil"
                  label={t(DUO_COPY.pillEdit)}
                  title={t(DUO_COPY.pillEdit)}
                  onClick={() => handleOpenEditor(recipeId)}
                />
              ) : null}
              <PopoverClose asChild>
                <IconButton variant="ghost" size="xs" icon="x" label={t(DUO_COPY.close)} />
              </PopoverClose>
            </Stack>
          }
        />
        <div className="duo-popover-rows">
          {error !== null ? <Callout tone="err">{error}</Callout> : null}
          {stepLimitPaused ? <Callout tone="warn">{t(DUO_COPY.pillStepLimitPaused)}</Callout> : null}
          {suppressed ? <Callout tone="warn">{t(DUO_COPY.pillCoordinatorHint)}</Callout> : null}

          <div
            className="duo-popover-row"
            data-active={phase === 'planning' && !suppressed ? 'true' : undefined}
          >
            <div className="duo-popover-row-head">
              <span className="duo-popover-label">{t(DUO_COPY.plannerLabel)}</span>
              {phase === 'planning' && !suppressed ? (
                <Badge tone="neutral">{t(DUO_COPY.activeBadge)}</Badge>
              ) : null}
            </div>
            <span className="duo-popover-model mono">{plannerFullDisplay}</span>
          </div>

          <div
            className="duo-popover-row"
            data-active={phase === 'execution' && !suppressed ? 'true' : undefined}
          >
            <div className="duo-popover-row-head">
              <span className="duo-popover-label">{t(DUO_COPY.executorLabel)}</span>
              <span className="duo-popover-badges">
                {hasOverride ? <Badge tone="accent">{t(DUO_COPY.overrideBadge)}</Badge> : null}
                {phase === 'execution' && !suppressed ? (
                  <Badge tone="neutral">{t(DUO_COPY.activeBadge)}</Badge>
                ) : null}
              </span>
            </div>
            <ModelPickerControl
              variant="field"
              size="sm"
              buttonAriaLabel={t(DUO_COPY.fieldExecutor)}
              effectiveModel={executorPickerDisplayModel || undefined}
              activeThinkingLevel={executorPickerThinking}
              placeholderLabel={t(DUO_COPY.pickModelPlaceholder)}
              buttonTitle={executorButtonTitle}
              resetLabel={t(DUO_COPY.pillClearOverride)}
              resetTitle={t(DUO_COPY.pillClearOverride)}
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
              <div className="duo-popover-override-actions">
                <Button
                  variant="ghost"
                  size="xs"
                  icon="rotate-ccw"
                  pending={clearing}
                  disabled={busy}
                  onClick={handleClearOverride}
                >
                  {t(DUO_COPY.pillClearOverride)}
                </Button>
              </div>
            ) : null}
          </div>

          <div className="duo-popover-row duo-popover-row--inline">
            <span className="duo-popover-label">{t(DUO_COPY.stepsLabel)}</span>
            <span className="duo-popover-steps mono tabular-nums">
              {formatDuoPopoverStepsValue(stepCount, maxSteps, locale)}
            </span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
