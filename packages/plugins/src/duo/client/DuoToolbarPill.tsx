/**
 * Compact `22px` composer toolbar status & quick-control pill (`COMPOSER_TOOLBAR_SLOT`)
 * for `builtin:duo`. Shows phase + Planner -> Executor pairing with a Radix Popover editor.
 * Returns null on non-eligible conversations; when inactive, only listens for `+` menu setup.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ComposerToolbarSlotProps } from '@helmx/protocol/browser'
import { Badge, Button, HelmxIcon, Popover } from '@helmx/ui'
import {
  ModelPickerControl,
  formatModelShortName,
  resolveDefaultChainThinkingLevel,
  useHostModels,
  usePluginAction,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginSessionDoc,
  usePluginTranslator,
} from '@helmx/plugin-client'
import {
  DUO_COPY as C,
  buildDuoPickerCopy,
  duoActionFailed,
  duoPillTitle,
  duoPopoverStepsValue,
} from './copy.ts'
import { DuoSetupDialog } from './DuoSetupDialog.tsx'
import {
  DUO_DEFAULT_MAX_STEPS,
  DUO_PLUGIN_ID,
  DUO_PROFILES_DOC,
  DUO_SESSION_DOC,
  isDuoEligibleConversation,
  parseDuoProfilesDoc,
  parseDuoSessionDoc,
  parseDuoStandbyMeta,
} from './models.ts'
import { duoSetupTargetKey, subscribeDuoSetup } from './setup-bus.ts'
import './styles.css'

function DuoToolbarPillConversation({
  conversationId,
  profileId,
  disabled,
}: {
  conversationId: number
  profileId?: string
  disabled: boolean
}): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const locale = usePluginLocale()
  const hostModels = useHostModels()
  const pickerCopy = useMemo(() => buildDuoPickerCopy(locale), [locale])
  const { value: rawSession } = { value: usePluginSessionDoc(DUO_SESSION_DOC, { conversationId }) }
  const rawProfiles = usePluginDoc(DUO_PROFILES_DOC)
  const session = useMemo(() => parseDuoSessionDoc(rawSession), [rawSession])
  const profiles = useMemo(() => parseDuoProfilesDoc(rawProfiles), [rawProfiles])
  const profileCfg = profileId ? profiles[profileId] : undefined

  const actions = usePluginAction({
    formatError: (err) => duoActionFailed(err, locale),
  })
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)

  useEffect(
    () => subscribeDuoSetup(duoSetupTargetKey(conversationId, profileId), () => setSetupOpen(true)),
    [conversationId, profileId],
  )

  const setupDialog = (
    <DuoSetupDialog
      open={setupOpen}
      initialExecutorModel={profileCfg?.executorModel}
      initialExecutorThinkingLevel={profileCfg?.executorThinkingLevel}
      initialMaxSteps={profileCfg?.maxExecutionSteps}
      pending={actions.pending}
      error={actions.error ?? null}
      onClose={() => setSetupOpen(false)}
      onConfirm={(cfg) => {
        void (async () => {
          const res = await actions.run(
            'set_conversation',
            {
              conversationId,
              enabled: true,
              ...cfg,
            },
            { conversationId },
          )
          if (res !== undefined) setSetupOpen(false)
        })()
      }}
    />
  )

  if (session === null) {
    return setupDialog
  }

  const executorModel = session.executorModel ?? ''
  const plannerShort = session.plannerModel ? formatModelShortName(session.plannerModel) : '—'
  const executorShort = executorModel ? formatModelShortName(executorModel) : '—'
  const suppressed = session.suppressedByCoordinator === true
  const isExecution = !suppressed && session.phase === 'execution'
  const toneClass = isExecution ? 'helmx-toolbar-pill--accent' : ''

  const phaseText = suppressed
    ? t(C.pillPhaseCoord)
    : isExecution
      ? session.maxExecutionSteps > 0
        ? `${t(C.pillPhaseExec)} ${session.executionStepCount}/${session.maxExecutionSteps}`
        : `${t(C.pillPhaseExec)} #${session.executionStepCount}`
      : t(C.pillPhasePlan)

  const title = duoPillTitle(
    session.phase,
    session.plannerModel,
    executorModel,
    session.executionStepCount,
    session.maxExecutionSteps,
    suppressed,
    locale,
  )

  const execDisplayLevel = resolveDefaultChainThinkingLevel(
    hostModels,
    executorModel,
    session.executorThinkingLevel,
  )

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className={`helmx-toolbar-pill ${toneClass} duo-pill-trigger`}
            aria-label={title}
            title={title}
            disabled={disabled}
            data-duo-phase={session.phase}
            data-duo-suppressed={suppressed ? 'true' : 'false'}
          >
            <HelmxIcon name="git-pull-request" size={11.5} />
            <span className="duo-pill-phase">{phaseText}</span>
            <span className="duo-pill-sep" aria-hidden="true">·</span>
            <span className="duo-pill-model mono">
              {plannerShort} → {executorShort}
            </span>
          </button>
        </Popover.Trigger>
        <Popover.Content align="start" sideOffset={6} className="duo-popover">
          <Popover.Header className="duo-popover-header">
            <div className="duo-popover-title-wrap">
              <span className="duo-popover-title">{t(C.pillBrand)}</span>
              <Badge tone={suppressed ? 'neutral' : isExecution ? 'accent' : 'neutral'}>
                {suppressed
                  ? t(C.pillPhaseCoord)
                  : t(isExecution ? C.popoverPhaseExecution : C.popoverPhasePlanning)}
              </Badge>
            </div>
          </Popover.Header>

          <div className="duo-popover-rows">
            <div className="duo-popover-row" data-active={!isExecution ? 'true' : undefined}>
              <div className="duo-popover-row-head">
                <span className="duo-popover-label">{t(C.popoverPlanner)}</span>
                {!isExecution && <Badge tone="neutral">{t(C.popoverActiveBadge)}</Badge>}
              </div>
              <span className="duo-popover-model mono">
                {session.plannerModel || '—'}
                {session.plannerThinkingLevel && session.plannerThinkingLevel !== 'off'
                  ? ` · ${session.plannerThinkingLevel}`
                  : ''}
              </span>
            </div>

            <div className="duo-popover-row" data-active={isExecution ? 'true' : undefined}>
              <div className="duo-popover-row-head">
                <span className="duo-popover-label">{t(C.popoverExecutor)}</span>
                {isExecution && <Badge tone="accent">{t(C.popoverActiveBadge)}</Badge>}
              </div>
              <ModelPickerControl
                variant="field"
                size="sm"
                buttonAriaLabel={t(C.fieldExecutorModel)}
                effectiveModel={executorModel || undefined}
                activeThinkingLevel={execDisplayLevel}
                placeholderLabel={t(C.pickExecutorModel)}
                resetLabel={t(C.clearModel)}
                resetTitle={t(C.clearModel)}
                enableShortcut={false}
                allowTiers={true}
                disabled={disabled || actions.pending}
                copy={pickerCopy}
                onNotice={(msg, tone) => ctx.notify(msg, tone)}
                onApply={(model, level) => {
                  void actions.run(
                    'set_conversation',
                    {
                      conversationId,
                      enabled: true,
                      executorModel: model,
                      ...(level ? { executorThinkingLevel: level } : {}),
                      maxExecutionSteps: session.maxExecutionSteps,
                    },
                    { conversationId },
                  )
                }}
                onResetDefault={() => {
                  if (profileCfg?.enabled) {
                    void actions.run('clear_conversation', { conversationId }, { conversationId })
                  } else {
                    void actions.run(
                      'set_conversation',
                      { conversationId, enabled: false },
                      { conversationId },
                    )
                    setPopoverOpen(false)
                  }
                }}
              />
            </div>

            <div className="duo-popover-row duo-popover-row--inline">
              <span className="duo-popover-label">{t(C.popoverSteps)}</span>
              <span className="duo-popover-steps mono tabular-nums">
                {duoPopoverStepsValue(session.executionStepCount, session.maxExecutionSteps, locale)}
              </span>
            </div>
          </div>

          <div className="duo-popover-divider" />

          <div className="duo-popover-actions">
            {session.hasConversationOverride && profileCfg?.enabled && (
              <Button
                variant="ghost"
                size="xs"
                disabled={disabled || actions.pending}
                onClick={() => {
                  void actions.run('clear_conversation', { conversationId }, { conversationId })
                  setPopoverOpen(false)
                }}
              >
                {t(C.popoverRevertProfile)}
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              disabled={disabled || actions.pending}
              onClick={() => {
                void (profileCfg?.enabled
                  ? actions.run('set_conversation', { conversationId, enabled: false }, { conversationId })
                  : actions.run('clear_conversation', { conversationId }, { conversationId }))
                setPopoverOpen(false)
              }}
            >
              {t(C.popoverDisable)}
            </Button>
          </div>
        </Popover.Content>
      </Popover>
      {setupDialog}
    </>
  )
}

function DuoToolbarPillStandby({
  profileId,
  effectiveModel,
  draftMeta,
  setDraftMeta,
  disabled,
}: {
  profileId: string
  effectiveModel?: string
  draftMeta?: Readonly<Record<string, unknown>>
  setDraftMeta: (key: string, value: unknown) => void
  disabled: boolean
}): ReactNode {
  const t = usePluginTranslator()
  const locale = usePluginLocale()
  const hostModels = useHostModels()
  const pickerCopy = useMemo(() => buildDuoPickerCopy(locale), [locale])
  const rawProfiles = usePluginDoc(DUO_PROFILES_DOC)
  const profiles = useMemo(() => parseDuoProfilesDoc(rawProfiles), [rawProfiles])
  const profileCfg = profiles[profileId]
  const standby = parseDuoStandbyMeta(draftMeta)

  const [popoverOpen, setPopoverOpen] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)

  useEffect(
    () => subscribeDuoSetup(duoSetupTargetKey(undefined, profileId), () => setSetupOpen(true)),
    [profileId],
  )

  const setupDialog = (
    <DuoSetupDialog
      open={setupOpen}
      initialExecutorModel={standby?.executorModel ?? profileCfg?.executorModel}
      initialExecutorThinkingLevel={standby?.executorThinkingLevel ?? profileCfg?.executorThinkingLevel}
      initialMaxSteps={standby?.maxExecutionSteps ?? profileCfg?.maxExecutionSteps}
      onClose={() => setSetupOpen(false)}
      onConfirm={(cfg) => {
        setDraftMeta(DUO_PLUGIN_ID, { enabled: true, ...cfg })
        setSetupOpen(false)
      }}
    />
  )

  const enabled = standby !== undefined ? standby.enabled : profileCfg?.enabled === true
  const executorModel = standby?.executorModel ?? profileCfg?.executorModel ?? ''
  const executorThinking =
    standby?.executorModel !== undefined
      ? standby.executorThinkingLevel
      : (standby?.executorThinkingLevel ?? profileCfg?.executorThinkingLevel)
  const maxSteps = standby?.maxExecutionSteps ?? profileCfg?.maxExecutionSteps ?? DUO_DEFAULT_MAX_STEPS

  if (!enabled || !executorModel) {
    return setupDialog
  }

  const plannerShort = effectiveModel ? formatModelShortName(effectiveModel) : '—'
  const executorShort = formatModelShortName(executorModel)
  const title = duoPillTitle('planning', effectiveModel ?? '', executorModel, 0, maxSteps, false, locale)
  const execDisplayLevel = resolveDefaultChainThinkingLevel(hostModels, executorModel, executorThinking)

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="helmx-toolbar-pill duo-pill-trigger"
            aria-label={title}
            title={title}
            disabled={disabled}
            data-duo-phase="planning"
          >
            <HelmxIcon name="git-pull-request" size={11.5} />
            <span className="duo-pill-phase">{t(C.pillPhasePlan)}</span>
            <span className="duo-pill-sep" aria-hidden="true">·</span>
            <span className="duo-pill-model mono">
              {plannerShort} → {executorShort}
            </span>
          </button>
        </Popover.Trigger>
        <Popover.Content align="start" sideOffset={6} className="duo-popover">
          <Popover.Header className="duo-popover-header">
            <div className="duo-popover-title-wrap">
              <span className="duo-popover-title">{t(C.pillBrand)}</span>
              <Badge tone="neutral">{t(C.popoverPhasePlanning)}</Badge>
            </div>
          </Popover.Header>
          <div className="duo-popover-rows">
            <div className="duo-popover-row" data-active="true">
              <div className="duo-popover-row-head">
                <span className="duo-popover-label">{t(C.popoverPlanner)}</span>
                <Badge tone="neutral">{t(C.popoverActiveBadge)}</Badge>
              </div>
              <span className="duo-popover-model mono">{effectiveModel || '—'}</span>
            </div>
            <div className="duo-popover-row">
              <span className="duo-popover-label">{t(C.popoverExecutor)}</span>
              <ModelPickerControl
                variant="field"
                size="sm"
                buttonAriaLabel={t(C.fieldExecutorModel)}
                effectiveModel={executorModel}
                activeThinkingLevel={execDisplayLevel}
                placeholderLabel={t(C.pickExecutorModel)}
                resetLabel={t(C.clearModel)}
                resetTitle={t(C.clearModel)}
                enableShortcut={false}
                allowTiers={true}
                disabled={disabled}
                copy={pickerCopy}
                onApply={(model, level) => {
                  setDraftMeta(DUO_PLUGIN_ID, {
                    enabled: true,
                    executorModel: model,
                    ...(level ? { executorThinkingLevel: level } : {}),
                    maxExecutionSteps: maxSteps,
                  })
                }}
                onResetDefault={() => {
                  setDraftMeta(DUO_PLUGIN_ID, profileCfg?.enabled ? { enabled: false } : undefined)
                  setPopoverOpen(false)
                }}
              />
            </div>
          </div>
          <div className="duo-popover-divider" />
          <div className="duo-popover-actions">
            <Button
              variant="ghost"
              size="xs"
              disabled={disabled}
              onClick={() => {
                setDraftMeta(DUO_PLUGIN_ID, profileCfg?.enabled ? { enabled: false } : undefined)
                setPopoverOpen(false)
              }}
            >
              {t(C.popoverDisable)}
            </Button>
          </div>
        </Popover.Content>
      </Popover>
      {setupDialog}
    </>
  )
}

export function DuoToolbarPill(props: ComposerToolbarSlotProps): ReactNode {
  if (props.conversation !== undefined) {
    if (!isDuoEligibleConversation(props.conversation)) {
      return null
    }
    return (
      <DuoToolbarPillConversation
        conversationId={props.conversation.id}
        profileId={props.conversation.profileId}
        disabled={props.disabled === true}
      />
    )
  }
  if (props.profileId === undefined || props.setDraftMeta === undefined) {
    return null
  }
  return (
    <DuoToolbarPillStandby
      profileId={props.profileId}
      effectiveModel={props.effectiveModel}
      draftMeta={props.draftMeta}
      setDraftMeta={props.setDraftMeta}
      disabled={props.disabled === true}
    />
  )
}
