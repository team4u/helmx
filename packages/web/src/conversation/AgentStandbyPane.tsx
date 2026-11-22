import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { COMPOSER_STATUS_SLOT, type ComposerStatusSlotProps, type ConversationSummary, type Profile } from '@helmx/protocol/browser'
import { HelmxIcon, PluginSlot, Tooltip, useHostModels } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { conversationsApi, type ModelCatalogDefaults } from '../lib/api.js'
import {
  executePluginSlashAction,
  matchExactPluginSlash,
  pluginSlashCommandsFor,
  removeTokenBeforeCaret,
  type QualifiedCommand,
} from '../lib/commands-model.js'
import { errorText } from '../lib/error-text.js'
import {
  useConversations,
  useGroupedUi,
  useLoadError,
  useLocationTargets,
  useModelDefaults,
  usePlugins,
  useProfilesSlice,
  useStoreActions,
} from '../lib/store-context.js'
import { isSameResolvedTarget, type ResolvedTarget } from '../lib/types.js'
import { useStableCallback } from '../lib/use-stable-callback.js'
import { collectEnabledPluginIds, isHumanSelectableProfile } from '../shell/sidebar-model.js'
import { standbySkillScope } from '../skills/skill-scope-model.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import { usePaneSplitToggle } from '../ui/use-pane-split-toggle.js'
import { ComposerInputShell, type ComposerAttachmentItem } from './ComposerInputShell.js'
import { StandbyEnvBar, StandbyModelPicker } from './StandbyControls.js'
import { focusWithCaret } from './composer-controller.js'
import { useIsMobile } from './composer-model.js'
import { isComposerSubmitEnterEvent } from './keybindings-model.js'
import {
  admitStandbyFiles,
  currentStandbyDraftEpoch,
  executeStandbySend,
  getStandbyDraft,
  inheritedEnvOf,
  resetEnvStandbyDraft,
  resolveStandbyEffectiveModel,
  standbyDraftKey,
  standbyEnvError,
  standbyManageAction,
  updateStandbyDraft,
  useStandbyDraft,
  type StandbyDraftState,
  type StandbySendResult,
} from './standby-model.js'
import { useComposerAttachments } from './use-composer-attachments.js'
import { useComposerCompletions } from './use-composer-completions.js'

export interface AgentStandbyPaneProps {
  profileId: string
  /** Draft environment carried by the target (delete-navigation / new-topic
   * inheritance; remote coordinates never silently fall back to local). */
  nodeId?: string
  cwd?: string
  isSplit?: boolean
  onCloseSplit?: () => void
}

/**
 * Agent standby pane (rendered on the main stage / split):
 * - entering the standby state creates no conversation; the first send persists it;
 * - shares ComposerInputShell, useComposerAttachments, useComposerCompletions, and
 *   ComposerEnvFields with active-conversation Composer;
 * - reads global model defaults from store (`useModelDefaults`) with zero redundant fetch.
 */
export function AgentStandbyPane({ profileId, nodeId, cwd, isSplit, onCloseSplit }: AgentStandbyPaneProps) {
  const { profiles, assetsLoaded } = useProfilesSlice()
  const hostModels = useHostModels()
  const modelDefaults = useModelDefaults()
  const plugins = usePlugins()
  const conversations = useConversations()
  const groupedUi = useGroupedUi()
  const { primaryTarget, splitTarget } = useLocationTargets()
  const profilesLoadError = useLoadError('assets:profiles')
  const { openTarget, pushNotice, invokePluginAction, refreshAssets } = useStoreActions()
  const { locale, t } = useWebLocale()
  const panel = isSplit ? 'split' : 'primary'
  const inheritedNodeId = nodeId !== undefined && nodeId !== '' ? nodeId : undefined
  const inheritedCwd = cwd !== undefined && cwd !== '' ? cwd : undefined
  const draftKey = standbyDraftKey({ panel, profileId, nodeId: inheritedNodeId, cwd: inheritedCwd })
  const draft = useStandbyDraft(draftKey)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const profile = useMemo(() => profiles.find((p) => p.id === profileId), [profiles, profileId])
  const enabledPluginIds = useMemo(() => collectEnabledPluginIds(plugins), [plugins])
  const humanSelectable = profile !== undefined && isHumanSelectableProfile(profile, enabledPluginIds)
  const anchoredConversation = useMemo(
    () => (draft.conversationId !== undefined ? conversations.find((c) => c.id === draft.conversationId) : undefined),
    [draft.conversationId, conversations],
  )
  const slashPluginCommands = useMemo(
    () => pluginSlashCommandsFor(groupedUi.commands, anchoredConversation),
    [groupedUi.commands, anchoredConversation],
  )
  const commandPendingRef = useRef(false)
  const [commandPending, setCommandPending] = useState(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    const record = getStandbyDraft(draftKey)
    if (record.envCustomized) return
    const env = inheritedEnvOf({ nodeId: inheritedNodeId, cwd: inheritedCwd })
    if (env.nodeId === undefined && env.cwd === undefined) return
    updateStandbyDraft(draftKey, { envCustomized: true, envNodeId: env.nodeId, envCwd: env.cwd })
  }, [draftKey, inheritedNodeId, inheritedCwd])

  const coordinateTarget = useMemo<ResolvedTarget>(
    () => ({
      kind: 'agent',
      profileId,
      ...(inheritedNodeId !== undefined ? { nodeId: inheritedNodeId } : {}),
      ...(inheritedCwd !== undefined ? { cwd: inheritedCwd } : {}),
    }),
    [profileId, inheritedNodeId, inheritedCwd],
  )
  const viewingRef = useRef(false)
  viewingRef.current = isSplit
    ? isSameResolvedTarget(splitTarget, coordinateTarget)
    : isSameResolvedTarget(primaryTarget, coordinateTarget)
  useEffect(() => {
    viewingRef.current = true
    return () => { viewingRef.current = false }
  }, [])

  const send = useCallback((): Promise<StandbySendResult> =>
    executeStandbySend(draftKey, profileId, {
      create: (init) => conversationsApi.create(init),
      patchThinkingLevel: (id, thinkingLevel) => conversationsApi.patch(id, { thinkingLevel }).then(() => undefined),
      upload: (id, file) => conversationsApi.uploadArtifact(id, file),
      submit: (id, payload) => conversationsApi.submitInput(id, payload).then(() => undefined),
      notifyError: (title, err, conversationId) => {
        pushNotice({
          type: 'notification',
          level: 'error',
          title,
          body: errorText(err),
          ...(conversationId !== undefined ? { conversationId } : {}),
        })
      },
      notifySentInBackground: (conversationId) => {
        pushNotice({
          type: 'notification',
          level: 'info',
          title: t('composer.standby.sentInBackgroundTitle'),
          body: t('composer.standby.sentInBackgroundBody', { id: conversationId }),
          conversationId,
        })
      },
      navigateToConversation: (conversationId) => {
        openTarget(
          { kind: 'conversation', conversationId },
          { history: 'replace', ...(isSplit ? { split: true } : {}) },
        )
      },
      isStillViewing: () => viewingRef.current,
    }, t), [draftKey, profileId, isSplit, openTarget, pushNotice, t])

  const addFiles = useCallback((files: ReadonlyArray<File>): void => {
    if (files.length === 0 || getStandbyDraft(draftKey).sending) return
    const { draft: patch, rejected } = admitStandbyFiles(getStandbyDraft(draftKey), files, t)
    updateStandbyDraft(draftKey, patch)
    for (const item of rejected) {
      pushNotice({
        type: 'notification',
        level: 'error',
        title: t('composer.standby.attachmentRejectedTitle', { name: item.file.name || t('composer.standby.unnamedFile') }),
        body: item.reason,
      })
    }
  }, [draftKey, pushNotice, t])

  const applyStarter = useCallback((prompt: string): void => {
    const record = getStandbyDraft(draftKey)
    if (record.sending) return
    if (record.text.trim() !== '' || record.localFiles.length > 0 || record.uploaded.length > 0) {
      pushNotice({ type: 'notification', level: 'warning', title: t('composer.draft.handleBeforeStarter') })
      return
    }
    updateStandbyDraft(draftKey, { text: prompt })
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [draftKey, pushNotice, t])

  const executeStandbyPluginCommand = useCallback((cmd: QualifiedCommand, mode: 'token' | 'clear'): void => {
    const record = getStandbyDraft(draftKey)
    if (commandPendingRef.current || record.sending) return
    commandPendingRef.current = true
    setCommandPending(true)
    const el = textareaRef.current
    const epoch = currentStandbyDraftEpoch()
    const beforeText = record.text
    const caret = el?.selectionStart ?? beforeText.length
    const resolved = mode === 'token' ? removeTokenBeforeCaret(beforeText, caret) : { next: '', nextCaret: 0 }
    void executePluginSlashAction(cmd, {
      invokePluginAction,
      pushNotice,
      locale,
      ...(record.conversationId !== undefined ? { conversationId: record.conversationId } : {}),
    }).then(() => {
      if (epoch !== currentStandbyDraftEpoch()) return
      if (getStandbyDraft(draftKey).text !== beforeText) return
      updateStandbyDraft(draftKey, { text: resolved.next })
      if (mode === 'token' && el !== null && el.isConnected) focusWithCaret(el, resolved.nextCaret)
    }).catch(() => {
      /* The action call already sent an explicit failure notice; keep the draft. */
    }).finally(() => {
      commandPendingRef.current = false
      if (mountedRef.current) setCommandPending(false)
    })
  }, [draftKey, invokePluginAction, locale, pushNotice])

  const runPluginCommand = useStableCallback((cmd: QualifiedCommand): void => {
    executeStandbyPluginCommand(cmd, 'token')
  })

  const submitDraft = useCallback((): void => {
    const record = getStandbyDraft(draftKey)
    if (commandPendingRef.current || record.sending) return
    const pluginCmd = matchExactPluginSlash(record.text.trim(), slashPluginCommands)
    if (pluginCmd !== undefined) {
      executeStandbyPluginCommand(pluginCmd, 'clear')
      return
    }
    const action = standbyManageAction(record.text)
    if (action !== null) {
      if (action.kind === 'clear-draft') {
        updateStandbyDraft(draftKey, { text: '', localFiles: [], uploaded: [], error: null })
        pushNotice({ type: 'notification', level: 'info', title: t('composer.standby.newDraftStartedTitle'), body: t('composer.standby.newDraftStartedBody') })
      } else {
        pushNotice({
          type: 'notification',
          level: 'warning',
          title: t('composer.standby.needsConversationTitle', { command: action.command }),
          body: t('composer.standby.needsConversationBody'),
        })
      }
      return
    }
    void send()
  }, [draftKey, executeStandbyPluginCommand, pushNotice, send, slashPluginCommands, t])

  const resetEnvToDefault = useCallback((): void => {
    if (draft.sending || draft.conversationId !== undefined) return
    const toKey = standbyDraftKey({ panel, profileId })
    if (toKey === draftKey) {
      resetEnvStandbyDraft(draftKey, toKey)
      return
    }
    const moved = resetEnvStandbyDraft(draftKey, toKey)
    if (!moved) {
      pushNotice({
        type: 'notification',
        level: 'warning',
        title: t('composer.standby.defaultEnvHasDraftTitle'),
        body: t('composer.standby.defaultEnvHasDraftBody'),
      })
    }
    openTarget({ kind: 'agent', profileId }, isSplit ? { split: true } : undefined)
  }, [draft.sending, draft.conversationId, draftKey, isSplit, openTarget, panel, profileId, pushNotice, t])

  const { isSplitActive, toggleSplit } = usePaneSplitToggle({
    isSplit,
    onCloseSplit,
    getSplitTarget: () => ({ kind: 'agent', profileId }),
  })

  const label = profile?.name || profileId
  const envError = standbyEnvError(draft, t)
  const hasUsableModel = useMemo(() => {
    if (hostModels === undefined) return true
    if (hostModels.models.some((m) => m.available && m.disabled !== true)) return true
    if ((hostModels.modelTiers ?? []).some((tier) => tier.available && tier.disabled !== true)) return true
    return false
  }, [hostModels])
  const showZeroModelCta = assetsLoaded && profile !== undefined && !hasUsableModel

  return (
    <div className="helmx-pane agent-standby-pane" data-agent={profileId}>
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

      <div className="agent-standby-body">
        {profilesLoadError !== undefined ? (
          <div className="timeline-empty-state" role="alert">
            <HelmxIcon name="alert-triangle" size={20} />
            <span>{t('composer.standby.profileLoadFailed', { error: profilesLoadError })}</span>
            <button type="button" className="btn btn-sm" onClick={() => void refreshAssets()}>
              {t('common.retry')}
            </button>
          </div>
        ) : !assetsLoaded ? (
          <div className="timeline-empty-state" role="status">
            <HelmxIcon name="loader" size={20} className="spin-slow" />
            <span>{t('composer.standby.loadingProfile')}</span>
          </div>
        ) : profile === undefined ? (
          <div className="timeline-empty-state" role="alert">
            <HelmxIcon name="circle-slash" size={20} />
            <span>{t('composer.standby.profileMissing', { profileId })}</span>
            <button type="button" className="btn btn-sm" onClick={() => openTarget({ kind: 'profiles' })}>
              {t('composer.standby.goToProfiles')}
            </button>
          </div>
        ) : !humanSelectable ? (
          <div className="timeline-empty-state" role="alert">
            <HelmxIcon name="lock" size={20} />
            <span>{t('composer.standby.notHumanSelectable')}</span>
          </div>
        ) : (
          <>
            <div className="agent-standby-intro">
              <span className="agent-standby-intro-name">{label}</span>
              <span className="agent-standby-intro-hint">{t('composer.standby.introHint')}</span>
            </div>
            {showZeroModelCta ? (
              <div className="callout callout-warn" role="status">
                <HelmxIcon name="alert-triangle" size={14} />
                <div className="flex-col-xs flex-1">
                  <strong>{t('composer.standby.noModelsTitle')}</strong>
                  <span className="callout-text">{t('composer.standby.noModelsHint')}</span>
                  <div>
                    <button
                      type="button"
                      className="btn btn-primary btn-xs"
                      onClick={() => openTarget({ kind: 'models' }, isSplit ? { split: true } : undefined)}
                    >
                      <HelmxIcon name="key" size={12} />
                      <span>{t('composer.standby.configureModels')}</span>
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
            {profile.starters !== undefined && profile.starters.length > 0 ? (
              <div className="timeline-starters">
                {profile.starters.map((starter, index) => (
                  <button
                    key={`starter-${index}-${starter.label}`}
                    type="button"
                    className="timeline-starter-btn"
                    title={starter.prompt}
                    disabled={draft.sending}
                    onClick={() => applyStarter(starter.prompt)}
                  >
                    <HelmxIcon name="corner-down-right" size={11} />
                    <span className="timeline-starter-label">{starter.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>

      {assetsLoaded && profile !== undefined && humanSelectable ? (
        <StandbyComposer
          draftKey={draftKey}
          draft={draft}
          profile={profile}
          modelDefaults={modelDefaults}
          envError={envError}
          anchored={draft.conversationId !== undefined}
          anchoredConversation={anchoredConversation}
          commandPending={commandPending}
          slashPluginCommands={slashPluginCommands}
          onRunPluginCommand={runPluginCommand}
          isSplit={isSplit}
          textareaRef={textareaRef}
          onSend={submitDraft}
          onAddFiles={addFiles}
          onResetEnvToDefault={resetEnvToDefault}
        />
      ) : null}
    </div>
  )
}

interface StandbyComposerProps {
  draftKey: string
  draft: StandbyDraftState
  profile: Profile
  modelDefaults: ModelCatalogDefaults
  envError: string | null
  anchored: boolean
  anchoredConversation: ConversationSummary | undefined
  commandPending: boolean
  slashPluginCommands: ReadonlyArray<QualifiedCommand>
  onRunPluginCommand: (cmd: QualifiedCommand) => void
  isSplit?: boolean
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  onSend: () => void
  onAddFiles: (files: ReadonlyArray<File>) => void
  onResetEnvToDefault: () => void
}

function StandbyComposer({
  draftKey,
  draft,
  profile,
  modelDefaults,
  envError,
  anchored,
  anchoredConversation,
  commandPending,
  slashPluginCommands,
  onRunPluginCommand,
  isSplit,
  textareaRef,
  onSend,
  onAddFiles,
  onResetEnvToDefault,
}: StandbyComposerProps) {
  const { openTarget } = useStoreActions()
  const { locale, t } = useWebLocale()
  const isMobile = useIsMobile(680)
  const busy = draft.sending
  const sendDisabled = busy || commandPending || draft.text.trim() === '' || envError !== null
  const configLocked = busy || anchored
  const effectiveModel = anchoredConversation?.model || resolveStandbyEffectiveModel(
    draft.model,
    profile.model,
    modelDefaults.defaultModel,
  )

  const readLiveDraft = useCallback((): string => getStandbyDraft(draftKey).text, [draftKey])
  const setDraftState = useCallback((next: string): void => {
    updateStandbyDraft(draftKey, { text: next })
  }, [draftKey])

  const standbyScope = useMemo(
    () => standbySkillScope(draft, profile),
    [draft.envCustomized, draft.envNodeId, draft.envCwd, profile],
  )

  const completions = useComposerCompletions({
    textareaRef,
    draftText: draft.text,
    isMobile,
    readLiveDraft,
    setDraftState,
    conversation: anchoredConversation,
    profile,
    skillScope: standbyScope,
    slashPluginCommands,
    onRunPluginCommand,
    locale,
    resetKey: draftKey,
    disabled: busy,
  })

  const fileHandlers = useComposerAttachments({ onFiles: onAddFiles, disabled: busy })

  const returnFocusToTextarea = useCallback(() => {
    const el = textareaRef.current
    if (el === null) return false
    el.focus()
    return true
  }, [textareaRef])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.defaultPrevented || e.nativeEvent.defaultPrevented) return
    if (completions.shouldDeferKeyToPopover(e)) return
    if (isComposerSubmitEnterEvent(e) && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (!sendDisabled) onSend()
    }
  }

  const attachmentItems = useMemo<ComposerAttachmentItem[]>(
    () => [
      ...draft.localFiles.map((att): ComposerAttachmentItem => ({
        key: att.key,
        name: att.name,
        size: att.size,
        icon: 'file',
        badge: {
          label: t('composer.standby.attachmentPending'),
          className: 'badge badge-neutral agent-standby-attachment-state',
        },
        removeDisabled: busy,
        onRemove: () => updateStandbyDraft(draftKey, { localFiles: draft.localFiles.filter((item) => item.key !== att.key) }),
      })),
      ...draft.uploaded.map((att): ComposerAttachmentItem => ({
        key: att.artifactId,
        name: att.name,
        size: att.size,
        icon: 'paperclip',
        badge: {
          label: t('composer.standby.attachmentUploaded'),
          className: 'badge badge-ok agent-standby-attachment-state',
        },
        removeDisabled: busy,
        onRemove: () => updateStandbyDraft(draftKey, { uploaded: draft.uploaded.filter((item) => item.artifactId !== att.artifactId) }),
      })),
    ],
    [draft.localFiles, draft.uploaded, draftKey, busy, t],
  )

  return (
    <ComposerInputShell
      aboveBox={
        <>
          <StandbyEnvBar
            draftKey={draftKey}
            draft={draft}
            profile={profile}
            disabled={configLocked}
            onResetToDefault={onResetEnvToDefault}
          />
          {anchored ? (
            <div className="agent-standby-anchored callout" role="status">
              <HelmxIcon name="lock" size={12} />
              <span className="agent-standby-anchored-text">
                {t('composer.standby.anchoredNotice', { id: draft.conversationId! })}
              </span>
              <Tooltip content={t('composer.standby.openCreatedInPanel')} side="top">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    if (draft.conversationId === undefined) return
                    openTarget(
                      { kind: 'conversation', conversationId: draft.conversationId },
                      isSplit ? { split: true } : undefined,
                    )
                  }}
                >
                  {t('composer.standby.viewConversation')}
                </button>
              </Tooltip>
            </div>
          ) : null}
          {draft.error !== null ? (
            <div className="agent-standby-error callout callout-error" role="alert">
              <span className="agent-standby-error-text">{draft.error}</span>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={onSend}>
                {t('common.retry')}
              </button>
            </div>
          ) : null}
        </>
      }
      attachments={attachmentItems}
      textareaRef={textareaRef}
      textareaAriaLabel={t('composer.standby.firstMessageAria', { name: profile.name || profile.id })}
      value={draft.text}
      readOnly={busy}
      placeholder={isMobile ? t('composer.standby.placeholderMobile') : t('composer.standby.placeholder')}
      onTextChange={(nextValue, caret) => {
        updateStandbyDraft(draftKey, { text: nextValue })
        completions.detectPopover(nextValue, caret)
      }}
      onKeyUp={completions.handleTextareaKeyUp}
      onClick={completions.handleTextareaClick}
      onKeyDown={onKeyDown}
      onPaste={fileHandlers.onPaste}
      dragging={fileHandlers.dragging}
      onDragEnter={fileHandlers.onDragEnter}
      onDragOver={fileHandlers.onDragOver}
      onDragLeave={fileHandlers.onDragLeave}
      onDrop={fileHandlers.onDrop}
      fileInputRef={fileHandlers.fileInputRef}
      uploadButtonLabel={t('composer.standby.chooseAttachments')}
      uploadDisabled={busy}
      onOpenFilePicker={fileHandlers.openFilePicker}
      onFileInputChange={fileHandlers.onFileInputChange}
      slashOpen={completions.slashOpen}
      popoverQuery={completions.popoverQuery}
      slashMenuItems={completions.slashMenuItems}
      onPickSlash={completions.applySlashPick}
      onCloseSlash={completions.closeSlashPopover}
      completionOpen={completions.completionOpen}
      completionTrigger={completions.completionTrigger}
      completionSnapshot={completions.completionSnapshot}
      onPickCompletion={completions.applyCompletionPick}
      onCloseCompletion={completions.closeCompletionPopover}
      modelPicker={
        <StandbyModelPicker
          draftKey={draftKey}
          draft={draft}
          profile={profile}
          modelDefaults={modelDefaults}
          disabled={configLocked}
          isSplit={isSplit}
          onReturnFocus={returnFocusToTextarea}
        />
      }
      sendControls={
        <span className="composer-toolbar-right">
          <button
            type="button"
            className="btn btn-sm btn-primary btn-pill btn-send"
            disabled={sendDisabled}
            onClick={onSend}
            title={envError !== null ? envError : t('composer.standby.sendTitle')}
            aria-label={busy ? t('composer.standby.sendingAria') : t('composer.sendControls.send')}
          >
            <HelmxIcon name={busy ? 'loader' : 'arrow-up'} size={18} className={busy ? 'spin-slow' : undefined} />
          </button>
        </span>
      }
      statusRow={
        <PluginSlot
          ownerPluginId="builtin:composer"
          name={COMPOSER_STATUS_SLOT}
          className="composer-status-slot"
          slotProps={{ effectiveModel, profileId: profile.id } satisfies ComposerStatusSlotProps}
        />
      }
    />
  )
}
