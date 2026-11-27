/**
 * Agent standby pane (rendered on the main stage / split):
 * - entering the standby state creates no conversation; the first send persists it;
 * - shares ComposerInputShell, useComposerAttachments, useComposerCompletions, and
 *   ComposerEnvFields with active-conversation Composer;
 * - reads global model defaults from store (`useModelDefaults`) with zero redundant fetch.
 * The concerns live in the `agent-standby/` hooks (profile scope, focus, plugin commands,
 * command scope, send, draft actions, profile navigation) and sibling components (body,
 * composer); the pane composes them in a fixed order so effect phases keep their order.
 */
import { useEffect, useMemo, useRef } from 'react'
import {
  ComposerCommandContext,
  ComposerModelPickerModeContext,
  createComposerModelPickerModeRegistry,
  useHostModels,
} from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useLoadError, useModelDefaults, useStoreActions } from '../lib/store-context.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import { usePaneSplitToggle } from '../ui/use-pane-split-toggle.js'
import {
  getStandbyDraft,
  inheritedEnvOf,
  standbyDraftKey,
  standbyEnvError,
  updateStandbyDraft,
  useStandbyDraft,
} from './standby-model.js'
import { AgentStandbyBody } from './agent-standby/AgentStandbyBody.js'
import { StandbyComposer } from './agent-standby/StandbyComposer.js'
import { StandbyIntro } from './agent-standby/StandbyIntro.js'
import { useStandbyCommandScope } from './agent-standby/use-standby-command-scope.js'
import { useStandbyDraftActions } from './agent-standby/use-standby-draft-actions.js'
import { useStandbyFocus } from './agent-standby/use-standby-focus.js'
import { useStandbyPluginCommands } from './agent-standby/use-standby-plugin-commands.js'
import { useStandbyProfileNavigation } from './agent-standby/use-standby-profile-navigation.js'
import { useStandbyProfileScope } from './agent-standby/use-standby-profile-scope.js'
import { useStandbySend } from './agent-standby/use-standby-send.js'

export interface AgentStandbyPaneProps {
  profileId: string
  /** Draft environment carried by the target (delete-navigation / new-topic
   * inheritance; remote coordinates never silently fall back to local). */
  nodeId?: string
  cwd?: string
  isSplit?: boolean
  onCloseSplit?: () => void
}

export function AgentStandbyPane({ profileId, nodeId, cwd, isSplit, onCloseSplit }: AgentStandbyPaneProps) {
  const hostModels = useHostModels()
  const modelDefaults = useModelDefaults()
  const profilesLoadError = useLoadError('assets:profiles')
  const { invokePluginAction, pushNotice } = useStoreActions()
  const { locale, t } = useWebLocale()
  const panel: 'primary' | 'split' = isSplit ? 'split' : 'primary'
  const inheritedNodeId = nodeId !== undefined && nodeId !== '' ? nodeId : undefined
  const inheritedCwd = cwd !== undefined && cwd !== '' ? cwd : undefined
  const draftKey = standbyDraftKey({ panel, profileId, nodeId: inheritedNodeId, cwd: inheritedCwd })
  const draft = useStandbyDraft(draftKey)
  const paneRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const configLocked = draft.sending || draft.conversationId !== undefined
  const {
    assetsLoaded,
    profile,
    humanSelectable,
    standbyProfileOptions,
    currentRemoteNodeId,
    standbyReady,
    canSwitchProfile,
    label,
  } = useStandbyProfileScope({ profileId, configLocked })
  const standbyIdentity = `${panel}:${draftKey}`

  useStandbyFocus({
    panel,
    profileId,
    standbyIdentity,
    standbyReady,
    assetsLoaded,
    humanSelectable,
    sending: draft.sending,
    textareaRef,
    paneRef,
  })

  const commands = useStandbyPluginCommands({ draftKey, textareaRef, invokePluginAction, pushNotice, locale, t })
  const { anchoredConversation, slashPluginCommands } = useStandbyCommandScope({
    draft,
    profile,
    humanSelectable,
    modelDefaults,
    commandRegistry: commands.commandRegistry,
    commandRegistryVersion: commands.commandRegistryVersion,
  })
  const modelPickerModeRegistry = useMemo(() => createComposerModelPickerModeRegistry(), [])

  // A target-carried environment (new-topic / delete-navigation inheritance) becomes the
  // draft's own customized environment on first visit; later inheritance never overwrites it.
  useEffect(() => {
    const record = getStandbyDraft(draftKey)
    if (record.envCustomized) return
    const env = inheritedEnvOf({ nodeId: inheritedNodeId, cwd: inheritedCwd })
    if (env.nodeId === undefined && env.cwd === undefined) return
    updateStandbyDraft(draftKey, { envCustomized: true, envNodeId: env.nodeId, envCwd: env.cwd })
  }, [draftKey, inheritedNodeId, inheritedCwd])

  const { submitDraft } = useStandbySend({
    draftKey,
    profileId,
    inheritedNodeId,
    inheritedCwd,
    isSplit,
    commandPendingRef: commands.commandPendingRef,
    executeStandbyPluginCommand: commands.executeStandbyPluginCommand,
    slashPluginCommands,
    pushNotice,
    t,
  })
  const { addFiles, applyStarter } = useStandbyDraftActions({ draftKey, textareaRef, pushNotice, t })
  const { resetEnvToDefault, switchProfile } = useStandbyProfileNavigation({
    draftKey,
    draft,
    panel,
    profileId,
    isSplit,
    pushNotice,
    t,
  })

  const { isSplitActive, toggleSplit } = usePaneSplitToggle({
    isSplit,
    onCloseSplit,
    getSplitTarget: () => ({ kind: 'agent', profileId }),
  })

  const envError = standbyEnvError(draft, t)
  const hasUsableModel = useMemo(() => {
    if (hostModels === undefined) return true
    if (hostModels.models.some((m) => m.available && m.disabled !== true)) return true
    if ((hostModels.modelTiers ?? []).some((tier) => tier.available && tier.disabled !== true)) return true
    return false
  }, [hostModels])
  const showZeroModelCta = assetsLoaded && profile !== undefined && !hasUsableModel

  return (
    <div ref={paneRef} className="helmx-pane agent-standby-pane" data-agent={profileId}>
      <header className="pane-topbar conversation-topbar">
        <div className="pane-title-group">
          <span className="pane-title">{label}</span>
          <span className="pane-cwd-subtitle">
            <span className="env-subtitle-full">{t('composer.standby.newTopic')}</span>
          </span>
        </div>
        <div className="pane-actions">
          {isSplit && onCloseSplit !== undefined ? (
            <CloseSplitButton onCloseSplit={onCloseSplit} />
          ) : (
            <SplitToggleButton isSplitActive={isSplitActive} onToggleSplit={toggleSplit} />
          )}
        </div>
      </header>

      <AgentStandbyBody
        profileId={profileId}
        profilesLoadError={profilesLoadError}
        assetsLoaded={assetsLoaded}
        profile={profile}
        humanSelectable={humanSelectable}
      >
        {profile !== undefined ? (
          <StandbyIntro
            panel={panel}
            profileId={profileId}
            label={label}
            isSplit={isSplit}
            profile={profile}
            showZeroModelCta={showZeroModelCta}
            canSwitchProfile={canSwitchProfile}
            currentRemoteNodeId={currentRemoteNodeId}
            standbyProfileOptions={standbyProfileOptions}
            sending={draft.sending}
            textareaRef={textareaRef}
            onSwitchProfile={switchProfile}
            onApplyStarter={applyStarter}
          />
        ) : null}
      </AgentStandbyBody>

      {standbyReady && profile !== undefined ? (
        <ComposerCommandContext.Provider value={commands.commandRegistry}>
          <ComposerModelPickerModeContext.Provider value={modelPickerModeRegistry}>
            <StandbyComposer
              draftKey={draftKey}
              draft={draft}
              profile={profile}
              modelDefaults={modelDefaults}
              envError={envError}
              anchored={draft.conversationId !== undefined}
              anchoredConversation={anchoredConversation}
              runningCommand={commands.runningCommand}
              slashPluginCommands={slashPluginCommands}
              onRunPluginCommand={commands.runPluginCommand}
              isSplit={isSplit}
              textareaRef={textareaRef}
              onSend={submitDraft}
              onAddFiles={addFiles}
              onResetEnvToDefault={resetEnvToDefault}
            />
          </ComposerModelPickerModeContext.Provider>
        </ComposerCommandContext.Provider>
      ) : null}
    </div>
  )
}
