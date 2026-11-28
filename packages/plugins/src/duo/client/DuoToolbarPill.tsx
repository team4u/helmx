import { useCallback, useMemo, useState, type ReactNode } from 'react'
import {
  Badge,
  Button,
  Callout,
  HelmxIcon,
  IconButton,
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTrigger,
  StatusLight,
  type StatusLightTone,
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
import type { ComposerToolbarSlotProps } from '@helmx/protocol/browser'
import {
  DUO_COPY,
  buildDuoPickerCopy,
  formatDuoOverrideClearedNotice,
  formatDuoOverrideUpdatedNotice,
  formatDuoPhaseLabel,
  formatDuoStepBudgetLabel,
  formatDuoStepCounter,
} from './copy.ts'
import {
  DUO_PLUGIN_ID,
  DUO_SCREEN_ID,
  DUO_SESSION_DOC,
  DUO_STATE_DOC,
  matchDuoRecipeFromModelRef,
  parseDuoSessionDoc,
  parseDuoStateDoc,
  resolveEndpointDisplay,
} from './models.ts'
import './styles.css'

/**
 * Guard outer wrapper so ineligible conversations (sub-conversations or `helmx`-owned
 * sessions) return `null` before mounting hooks that subscribe to `duo` sessionDoc.
 */
export function DuoToolbarPill(props: ComposerToolbarSlotProps): ReactNode {
  const { conversation } = props
  const isTopLevelHuman =
    conversation === undefined ||
    (conversation.parentConversationId === undefined && (conversation.ownedBy ?? 'human') === 'human')
  if (!isTopLevelHuman) return null
  return <EligibleDuoToolbarPill {...props} />
}

function EligibleDuoToolbarPill({
  conversation,
  effectiveModel,
  disabled,
}: ComposerToolbarSlotProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const hostModels = useHostModels()
  const rawState = usePluginDocValue(DUO_PLUGIN_ID, DUO_STATE_DOC)
  const stateDoc = useMemo(() => parseDuoStateDoc(rawState), [rawState])
  const rawSession = usePluginSessionDocValue(DUO_SESSION_DOC, {
    conversationId: conversation?.id,
    pluginId: DUO_PLUGIN_ID,
  })
  const session = useMemo(() => parseDuoSessionDoc(rawSession), [rawSession])

  const actions = usePluginAction({
    formatError: (err) => (err instanceof Error ? err.message : String(err)),
  })

  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pickerCopy = useMemo(() => buildDuoPickerCopy(locale), [locale])

  const standbyRecipe = useMemo(() => {
    if (conversation !== undefined) return undefined
    return matchDuoRecipeFromModelRef(effectiveModel, stateDoc.recipes)
  }, [conversation, effectiveModel, stateDoc.recipes])

  const activeRecipe = useMemo(() => {
    if (session?.enabled) return stateDoc.recipes[session.recipeId]
    return standbyRecipe
  }, [session, standbyRecipe, stateDoc.recipes])

  const standbyResolved = useMemo(() => {
    if (!standbyRecipe) return undefined
    const planner = resolveEndpointDisplay(
      standbyRecipe.plannerModel,
      standbyRecipe.plannerThinkingLevel,
      hostModels,
    )
    const executor = resolveEndpointDisplay(
      standbyRecipe.executorModel,
      standbyRecipe.executorThinkingLevel,
      hostModels,
    )
    return { planner, executor }
  }, [standbyRecipe, hostModels])

  const handleOpenRecipeEditor = useCallback(
    (recipeId: string) => {
      setOpen(false)
      ctx.openScreen(`screen:${DUO_PLUGIN_ID}/${DUO_SCREEN_ID}?edit=${encodeURIComponent(recipeId)}`)
    },
    [ctx],
  )

  const handleOverrideExecutor = useCallback(
    (model: string, level: string | null) => {
      if (conversation === undefined) return
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
    [conversation, actions, ctx, locale],
  )

  const handleClearOverride = useCallback(() => {
    if (conversation === undefined) return
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
  }, [conversation, actions, ctx, locale])

  const activeMode = session !== null && session.enabled
  if (!activeMode && standbyRecipe === undefined) return null

  const recipeId = activeMode ? session.recipeId : standbyRecipe!.id
  const recipeName = activeMode ? session.recipeName : standbyRecipe!.name
  const suppressed = activeMode && session.suppressedByCoordinator === true
  const phase = activeMode ? session.phase : 'planning'

  const plannerConcrete = activeMode
    ? session.plannerModel
    : standbyResolved?.planner.concreteModel ?? standbyRecipe!.plannerModel
  const plannerThinking = activeMode
    ? session.plannerThinkingLevel
    : standbyResolved?.planner.thinkingLevel
  const executorConcrete = activeMode
    ? session.executorModel
    : standbyResolved?.executor.concreteModel ?? standbyRecipe!.executorModel
  const executorThinking = activeMode
    ? session.executorThinkingLevel
    : standbyResolved?.executor.thinkingLevel

  const maxSteps = activeMode ? session.maxExecutionSteps : standbyRecipe!.maxExecutionSteps
  const executionStepCount = activeMode ? session.executionStepCount : 0
  const hasOverride = activeMode && session.hasExecutorOverride

  const plannerShort = plannerConcrete ? formatModelShortName(plannerConcrete) : '—'
  const executorShort = executorConcrete ? formatModelShortName(executorConcrete) : '—'

  const pillText = suppressed
    ? t(DUO_COPY.pillSuppressed)
    : `${formatDuoPhaseLabel(phase, locale)} → ${executorShort}`

  const pillClassName = [
    'helmx-toolbar-pill',
    'duo-pill',
    activeMode ? 'duo-pill-active' : 'duo-pill-standby',
    phase === 'execution' && !suppressed ? 'duo-pill-executing' : '',
    suppressed ? 'duo-pill-suppressed' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const statusTone: StatusLightTone = suppressed
    ? 'blocked'
    : phase === 'execution'
      ? 'working'
      : 'done'

  const executorPickerDisplayModel =
    activeRecipe && !hasOverride ? activeRecipe.executorModel : executorConcrete
  const executorPickerThinking = resolveDefaultChainThinkingLevel(
    hostModels ?? undefined,
    executorPickerDisplayModel,
    executorThinking,
    'compaction',
  )
  const overriding = actions.pending && actions.pendingKey === 'override_executor'
  const clearing = actions.pending && actions.pendingKey === 'clear_override'
  const busy = Boolean(disabled) || overriding || clearing

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={pillClassName}
          disabled={disabled}
          aria-label={`${recipeName} · ${pillText}`}
          title={`${recipeName} (tier/${recipeId})`}
        >
          <span className="duo-pill-dot" aria-hidden="true" />
          <HelmxIcon name="git-pull-request" size={12} />
          <span>{pillText}</span>
          {activeMode && phase === 'execution' && (
            <span className="duo-pill-steps mono">
              {formatDuoStepCounter(executionStepCount, maxSteps, locale)}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="duo-popover" align="start" sideOffset={8}>
        <PopoverHeader
          divider
          title={recipeName}
          subtitle={
            <Badge tone="neutral" mono>
              tier/{recipeId}
            </Badge>
          }
          trailing={
            recipeId ? (
              <IconButton
                icon="pencil"
                variant="ghost"
                size="sm"
                label={t(DUO_COPY.pillEditRecipe)}
                title={t(DUO_COPY.pillEditRecipe)}
                onClick={() => handleOpenRecipeEditor(recipeId)}
              />
            ) : undefined
          }
        />
        <div className="duo-popover-body">
          {error && <Callout tone="err">{error}</Callout>}

          <div className="duo-popover-status-row">
            <span className="duo-popover-status-left">
              <StatusLight tone={statusTone} label={formatDuoPhaseLabel(phase, locale)} />
              <span>{suppressed ? t(DUO_COPY.pillSuppressed) : formatDuoPhaseLabel(phase, locale)}</span>
            </span>
            <span className="duo-pill-steps mono">
              {activeMode && phase === 'execution'
                ? formatDuoStepCounter(executionStepCount, maxSteps, locale)
                : formatDuoStepBudgetLabel(maxSteps, locale)}
            </span>
          </div>

          {activeMode && session.stepLimitPaused && (
            <Callout tone="warn">{t(DUO_COPY.pillStepLimitPaused)}</Callout>
          )}
          {suppressed && <Callout tone="warn">{t(DUO_COPY.pillCoordinatorHint)}</Callout>}

          <div className="duo-popover-role">
            <div className="duo-popover-role-head">
              <span>{t(DUO_COPY.plannerLabel)}</span>
              {activeRecipe && activeRecipe.plannerModel.startsWith('tier/') && (
                <Badge tone="neutral" mono>
                  {activeRecipe.plannerModel}
                </Badge>
              )}
            </div>
            <div className="duo-popover-role-readonly">
              <span>{plannerShort}</span>
              {plannerThinking && <Badge tone="neutral">{plannerThinking}</Badge>}
            </div>
          </div>

          <div className="duo-popover-role">
            <div className="duo-popover-role-head">
              <span>{t(DUO_COPY.executorLabel)}</span>
              {hasOverride && <Badge tone="accent">{t(DUO_COPY.overrideBadge)}</Badge>}
            </div>
            {activeMode ? (
              <ModelPickerControl
                variant="field"
                size="sm"
                buttonAriaLabel={t(DUO_COPY.fieldExecutor)}
                effectiveModel={executorPickerDisplayModel}
                activeThinkingLevel={executorPickerThinking}
                placeholderLabel={t(DUO_COPY.pickModelPlaceholder)}
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
            ) : (
              <div className="duo-popover-role-readonly">
                <span>{executorShort}</span>
                {executorThinking && <Badge tone="neutral">{executorThinking}</Badge>}
              </div>
            )}
          </div>

          {!activeMode && <span className="duo-popover-hint">{t(DUO_COPY.pillStandbyHint)}</span>}

          <div className="duo-popover-actions">
            {hasOverride && (
              <Button
                variant="ghost"
                size="sm"
                icon="rotate-ccw"
                pending={clearing}
                disabled={busy}
                onClick={handleClearOverride}
              >
                {t(DUO_COPY.pillClearOverride)}
              </Button>
            )}
            {recipeId && (
              <Button
                variant="secondary"
                size="sm"
                icon="pencil"
                onClick={() => handleOpenRecipeEditor(recipeId)}
              >
                {t(DUO_COPY.pillEditRecipe)}
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
