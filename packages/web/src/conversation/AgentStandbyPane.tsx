import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  COMPOSER_MENU_SLOT,
  COMPOSER_STATUS_SLOT,
  COMPOSER_TOOLBAR_SLOT,
  type ComposerMenuSlotProps,
  type ComposerStatusSlotProps,
  type ComposerToolbarSlotProps,
  type ConversationScopeTarget,
  type ConversationSummary,
  type Profile,
} from '@helmx/protocol/browser'
import {
  Button,
  ComposerCommandContext,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  HelmxIcon,
  IconButton,
  PluginSlot,
  Stack,
  Tooltip,
  createComposerCommandRegistry,
  useHostModels,
  type HelmxShortcutEventDetail,
} from '@helmx/plugin-client'
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
  useActiveModal,
  useConversations,
  useDrawerStack,
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
import { buildNewTopicCandidates } from '../overview/overview-model.js'
import { formatModShortcut } from '../shell/shortcuts-model.js'
import { RemoteNodeTag } from '../shell/SidebarPrimitives.js'
import { collectEnabledPluginIds, isHumanSelectableProfile } from '../shell/sidebar-model.js'
import { standbySkillScope } from '../skills/skill-scope-model.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import { usePaneSplitToggle } from '../ui/use-pane-split-toggle.js'
import { ComposerCommandBanner } from './ComposerCommandBanner.js'
import { ComposerInputShell, type ComposerAttachmentItem } from './ComposerInputShell.js'
import { StandbyEnvBar, StandbyModelPicker } from './StandbyControls.js'
import { focusWithCaret, useFocusComposerShortcut } from './composer-controller.js'
import { useIsMobile } from './composer-model.js'
import { COMPOSER_SHORTCUTS, isComposerSubmitEnterEvent } from './keybindings-model.js'
import {
  admitStandbyFiles,
  currentStandbyDraftEpoch,
  executeStandbySend,
  getStandbyDraft,
  inheritedEnvOf,
  resetEnvStandbyDraft,
  resolveStandbyEffectiveModel,
  setStandbyDraftInputMeta,
  shouldAutoFocusStandbyTextarea,
  standbyDraftKey,
  standbyEnvError,
  standbyManageAction,
  transferStandbyDraftOnProfileSwitch,
  updateStandbyDraft,
  useStandbyDraft,
  type StandbyDraftState,
  type StandbySendResult,
} from './standby-model.js'
import { useComposerAttachments } from './use-composer-attachments.js'
import { useComposerCompletions } from './use-composer-completions.js'

const HELMX_SHORTCUT_EVENT = 'helmx:shortcut' as const

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
  const { primaryTarget, splitTarget, focusedPanel } = useLocationTargets()
  const activeModal = useActiveModal()
  const drawerStack = useDrawerStack()
  const profilesLoadError = useLoadError('assets:profiles')
  const { openTarget, pushNotice, invokePluginAction, refreshAssets } = useStoreActions()
  const { locale, t } = useWebLocale()
  const isMobile = useIsMobile(680)
  const panel: 'primary' | 'split' = isSplit ? 'split' : 'primary'
  const inheritedNodeId = nodeId !== undefined && nodeId !== '' ? nodeId : undefined
  const inheritedCwd = cwd !== undefined && cwd !== '' ? cwd : undefined
  const draftKey = standbyDraftKey({ panel, profileId, nodeId: inheritedNodeId, cwd: inheritedCwd })
  const draft = useStandbyDraft(draftKey)
  const paneRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const switchingProfileRef = useRef(false)

  const profile = useMemo(() => profiles.find((p) => p.id === profileId), [profiles, profileId])
  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p] as const)), [profiles])
  const enabledPluginIds = useMemo(() => collectEnabledPluginIds(plugins), [plugins])
  const humanSelectable = profile !== undefined && isHumanSelectableProfile(profile, enabledPluginIds)
  const profileCandidates = useMemo(
    () =>
      buildNewTopicCandidates({
        profiles,
        conversations,
        plugins,
        sidebarItems: groupedUi.sidebarItems,
        locale,
      }),
    [profiles, conversations, plugins, groupedUi.sidebarItems, locale],
  )
  const standbyReady = assetsLoaded && profile !== undefined && humanSelectable
  const configLocked = draft.sending || draft.conversationId !== undefined
  const canSwitchProfile = standbyReady && profileCandidates.length > 1 && !configLocked
  const standbyIdentity = `${panel}:${draftKey}`
  const autoFocusedKeyRef = useRef<string | null>(null)

  useFocusComposerShortcut({ textareaRef, panel })

  const autoFocusContextRef = useRef({
    panel,
    focusedPanel,
    splitTarget,
    activeModal,
    drawerStackLength: drawerStack.length,
    isMobile,
    sending: draft.sending,
  })
  autoFocusContextRef.current = {
    panel,
    focusedPanel,
    splitTarget,
    activeModal,
    drawerStackLength: drawerStack.length,
    isMobile,
    sending: draft.sending,
  }

  useEffect(() => {
    if (!standbyReady) return
    if (autoFocusedKeyRef.current === standbyIdentity) return
    const focusTextarea = (): void => {
      const el = textareaRef.current
      if (el === null || !el.isConnected) return
      const ctx = autoFocusContextRef.current
      if (ctx.sending) return
      if (
        !shouldAutoFocusStandbyTextarea({
          panel: ctx.panel,
          focusedPanel: ctx.focusedPanel,
          splitTarget: ctx.splitTarget,
          activeModal: ctx.activeModal,
          drawerStackLength: ctx.drawerStackLength,
          isMobile: ctx.isMobile,
          textarea: el,
          paneEl: paneRef.current,
        })
      ) {
        return
      }
      el.focus({ preventScroll: true })
      autoFocusedKeyRef.current = standbyIdentity
    }
    if (typeof requestAnimationFrame !== 'function') {
      focusTextarea()
      return
    }
    const rafId = requestAnimationFrame(focusTextarea)
    return () => cancelAnimationFrame(rafId)
  }, [standbyIdentity, standbyReady, activeModal, drawerStack.length])
  const [commandRegistry] = useState(() => createComposerCommandRegistry())
  const commandRegistryVersion = useSyncExternalStore(
    commandRegistry.subscribe,
    commandRegistry.getVersion,
    commandRegistry.getVersion,
  )
  const anchoredConversation = useMemo(
    () => (draft.conversationId !== undefined ? conversations.find((c) => c.id === draft.conversationId) : undefined),
    [draft.conversationId, conversations],
  )
  const effectiveModel =
    anchoredConversation?.model ||
    resolveStandbyEffectiveModel(draft.model, profile?.model, modelDefaults.defaultModel)
  const standbyScopeTarget = useMemo<ConversationScopeTarget | undefined>(
    () =>
      profile !== undefined && humanSelectable
        ? {
            profileId: profile.id,
            tags: [],
            ownedBy: 'human',
            ...(effectiveModel !== '' ? { model: effectiveModel } : {}),
          }
        : undefined,
    [profile, humanSelectable, effectiveModel],
  )
  const slashPluginCommands = useMemo(
    () =>
      pluginSlashCommandsFor(groupedUi.commands, anchoredConversation, {
        standbyTarget: anchoredConversation === undefined ? standbyScopeTarget : undefined,
        hasLocalHandler: (pluginId, commandId) => commandRegistry.has(pluginId, commandId),
      }),
    [groupedUi.commands, anchoredConversation, standbyScopeTarget, commandRegistry, commandRegistryVersion],
  )
  const commandPendingRef = useRef(false)
  const [runningCommand, setRunningCommand] = useState<QualifiedCommand | null>(null)
  const commandGenRef = useRef(0)
  const prevDraftKeyRef = useRef(draftKey)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  useEffect(() => {
    if (prevDraftKeyRef.current === draftKey) return
    prevDraftKeyRef.current = draftKey
    commandGenRef.current += 1
    commandPendingRef.current = false
    setRunningCommand(null)
  }, [draftKey])

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
    const gen = ++commandGenRef.current
    const el = textareaRef.current
    const epoch = currentStandbyDraftEpoch()
    const beforeText = record.text
    const caret = el?.selectionStart ?? beforeText.length
    const resolved = mode === 'token' ? removeTokenBeforeCaret(beforeText, caret) : { next: '', nextCaret: 0 }
    const restoreDraftIfUntouched = (): void => {
      if (
        mountedRef.current &&
        epoch === currentStandbyDraftEpoch() &&
        gen === commandGenRef.current &&
        getStandbyDraft(draftKey).text === resolved.next
      ) {
        updateStandbyDraft(draftKey, { text: beforeText })
      }
    }
    const applyTokenOrClear = (): void => {
      updateStandbyDraft(draftKey, { text: resolved.next })
      if (mode === 'token' && el !== null && el.isConnected) focusWithCaret(el, resolved.nextCaret)
    }

    if (commandRegistry.has(cmd.pluginId, cmd.spec.id)) {
      applyTokenOrClear()
      const handleLocalError = (err: unknown): void => {
        restoreDraftIfUntouched()
        pushNotice({
          type: 'notification',
          level: 'error',
          title: t('composer.command.failed', { command: `/${cmd.spec.slash ?? cmd.spec.id}` }),
          body: errorText(err),
          ...(record.conversationId !== undefined ? { conversationId: record.conversationId } : {}),
        })
      }
      try {
        const invoked = commandRegistry.invoke(cmd.pluginId, cmd.spec.id)
        if (invoked.handled) {
          if (
            invoked.result !== undefined &&
            invoked.result !== null &&
            typeof (invoked.result as PromiseLike<void>).then === 'function'
          ) {
            void Promise.resolve(invoked.result).catch(handleLocalError)
          }
          return
        }
      } catch (err) {
        handleLocalError(err)
        return
      }
    }

    commandPendingRef.current = true
    setRunningCommand(cmd)
    applyTokenOrClear()
    void executePluginSlashAction(cmd, {
      invokePluginAction,
      pushNotice,
      locale,
      t,
      ...(record.conversationId !== undefined ? { conversationId: record.conversationId } : {}),
    }).catch(() => {
      restoreDraftIfUntouched()
    }).finally(() => {
      if (gen === commandGenRef.current) {
        commandPendingRef.current = false
        if (mountedRef.current) setRunningCommand(null)
      }
    })
  }, [commandRegistry, draftKey, invokePluginAction, locale, pushNotice, t])

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
        updateStandbyDraft(draftKey, { text: '', localFiles: [], uploaded: [], inputMeta: undefined, error: null })
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

  const handleSwitchProfile = useCallback((nextProfileId: string): void => {
    if (nextProfileId === profileId) return
    if (draft.sending || draft.conversationId !== undefined) return
    const toKey = standbyDraftKey({ panel, profileId: nextProfileId })
    const result = transferStandbyDraftOnProfileSwitch(draftKey, toKey)
    if (result === 'target-occupied') {
      pushNotice({
        type: 'notification',
        level: 'warning',
        title: t('composer.standby.switchProfileTargetOccupiedTitle'),
        body: t('composer.standby.switchProfileTargetOccupiedBody'),
      })
    }
    switchingProfileRef.current = true
    openTarget({ kind: 'agent', profileId: nextProfileId }, isSplit ? { split: true } : undefined)
  }, [draft.sending, draft.conversationId, draftKey, isSplit, openTarget, panel, profileId, pushNotice, t])

  const openAllShortcuts = useCallback((): void => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(
      new CustomEvent<HelmxShortcutEventDetail>(HELMX_SHORTCUT_EVENT, {
        detail: { action: 'open-shortcuts', panel },
      }),
    )
  }, [panel])

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
    <div ref={paneRef} className="helmx-pane agent-standby-pane" data-agent={profileId}>
      <header className="pane-topbar conversation-topbar">
        <div className="pane-title-group">
          {canSwitchProfile ? (
            <DropdownMenu open={profileMenuOpen} onOpenChange={setProfileMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="pane-title pane-title-btn agent-standby-profile-trigger"
                  aria-label={t('composer.standby.switchProfileAria', { name: label })}
                  title={t('composer.standby.switchProfileTitle')}
                  aria-haspopup="menu"
                >
                  <span className="agent-standby-profile-trigger-label">{label}</span>
                  <HelmxIcon name="chevron-down" size={12} className="agent-standby-profile-trigger-chevron" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent
                  className="pane-more-popover agent-standby-profile-menu"
                  align="start"
                  sideOffset={4}
                  onCloseAutoFocus={(e) => {
                    if (switchingProfileRef.current) {
                      switchingProfileRef.current = false
                      e.preventDefault()
                    }
                  }}
                >
                  {profileCandidates.map((standing) => {
                    const selected = standing.profileId === profileId
                    const candidateProfile = profileById.get(standing.profileId)
                    const rawNodeId =
                      candidateProfile?.nodeId !== undefined &&
                      candidateProfile.nodeId !== '' &&
                      candidateProfile.nodeId !== 'local'
                        ? candidateProfile.nodeId
                        : standing.primaryConversation?.nodeId
                    const remoteNodeId =
                      rawNodeId !== undefined && rawNodeId !== '' && rawNodeId !== 'local'
                        ? rawNodeId
                        : null
                    return (
                      <DropdownMenuItem
                        key={standing.profileId}
                        className="agent-standby-profile-item"
                        data-profile-id={standing.profileId}
                        data-active={selected ? 'true' : undefined}
                        aria-checked={selected}
                        onSelect={() => handleSwitchProfile(standing.profileId)}
                      >
                        <span className="pane-more-item-label">
                          <HelmxIcon name="bot" size={13} />
                          <span className="agent-standby-profile-item-label">{standing.label}</span>
                          {remoteNodeId !== null ? <RemoteNodeTag nodeId={remoteNodeId} /> : null}
                        </span>
                        {selected ? (
                          <HelmxIcon name="check" size={12} className="agent-standby-profile-item-check" />
                        ) : null}
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenu>
          ) : (
            <span className="pane-title">{label}</span>
          )}
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
            <Button size="sm" onClick={() => void refreshAssets()}>
              {t('common.retry')}
            </Button>
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
            <Button size="sm" onClick={() => openTarget({ kind: 'profiles' })}>
              {t('composer.standby.goToProfiles')}
            </Button>
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
                <Stack gap="xs" className="flex-1">
                  <strong>{t('composer.standby.noModelsTitle')}</strong>
                  <span className="callout-text">{t('composer.standby.noModelsHint')}</span>
                  <div>
                    <Button
                      variant="primary"
                      size="xs"
                      icon="key"
                      onClick={() => openTarget({ kind: 'models' }, isSplit ? { split: true } : undefined)}
                    >
                      {t('composer.standby.configureModels')}
                    </Button>
                  </div>
                </Stack>
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
            {!showZeroModelCta ? (
              <div className="agent-standby-shortcuts" aria-label={t('composer.standby.shortcutsAria')}>
                <span className="agent-standby-shortcut-item">
                  <kbd className="kbd-hint">{formatModShortcut('K')}</kbd>
                  <span>{t('composer.standby.shortcutSearch')}</span>
                </span>
                <span className="agent-standby-shortcut-item">
                  <kbd className="kbd-hint">{COMPOSER_SHORTCUTS.toggleModelPicker}</kbd>
                  <span>{t('composer.standby.shortcutModel')}</span>
                </span>
                <span className="agent-standby-shortcut-item">
                  <kbd className="kbd-hint">/</kbd>
                  <span>{t('composer.standby.shortcutCommands')}</span>
                </span>
                <button
                  type="button"
                  className="btn-inline agent-standby-shortcuts-all"
                  onClick={openAllShortcuts}
                >
                  <span>{t('composer.standby.shortcutAll')}</span>
                  <kbd className="kbd-hint">{formatModShortcut('/')}</kbd>
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {standbyReady ? (
        <ComposerCommandContext.Provider value={commandRegistry}>
          <StandbyComposer
            draftKey={draftKey}
            draft={draft}
            profile={profile}
            modelDefaults={modelDefaults}
            envError={envError}
            anchored={draft.conversationId !== undefined}
            anchoredConversation={anchoredConversation}
            runningCommand={runningCommand}
            slashPluginCommands={slashPluginCommands}
            onRunPluginCommand={runPluginCommand}
            isSplit={isSplit}
            textareaRef={textareaRef}
            onSend={submitDraft}
            onAddFiles={addFiles}
            onResetEnvToDefault={resetEnvToDefault}
          />
        </ComposerCommandContext.Provider>
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
  runningCommand: QualifiedCommand | null
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
  runningCommand,
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
  const inFlight = busy || runningCommand !== null
  const sendDisabled = inFlight || draft.text.trim() === '' || envError !== null
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
  const setDraftMeta = useCallback((metaKey: string, value: unknown): void => {
    setStandbyDraftInputMeta(draftKey, metaKey, value)
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
          tone: 'neutral',
          className: 'agent-standby-attachment-state',
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
          tone: 'ok',
          className: 'agent-standby-attachment-state',
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
                <Button
                  size="sm"
                  onClick={() => {
                    if (draft.conversationId === undefined) return
                    openTarget(
                      { kind: 'conversation', conversationId: draft.conversationId },
                      isSplit ? { split: true } : undefined,
                    )
                  }}
                >
                  {t('composer.standby.viewConversation')}
                </Button>
              </Tooltip>
            </div>
          ) : null}
          {draft.error !== null ? (
            <div className="agent-standby-error callout callout-error" role="alert">
              <span className="agent-standby-error-text">{draft.error}</span>
              <Button size="sm" disabled={busy} onClick={onSend}>
                {t('common.retry')}
              </Button>
            </div>
          ) : null}
        </>
      }
      boxBanner={runningCommand !== null ? <ComposerCommandBanner command={runningCommand} /> : undefined}
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
      plusMenuDisabled={busy}
      onOpenFilePicker={fileHandlers.openFilePicker}
      onFileInputChange={fileHandlers.onFileInputChange}
      renderMenuSlot={(closeMenu) => (
        <PluginSlot
          ownerPluginId="builtin:composer"
          name={COMPOSER_MENU_SLOT}
          slotProps={{
            effectiveModel,
            profileId: profile.id,
            draftMeta: draft.inputMeta,
            setDraftMeta,
            disabled: configLocked,
            onCloseMenu: closeMenu,
          } satisfies ComposerMenuSlotProps}
        />
      )}
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
      toolbarSlot={
        <PluginSlot
          ownerPluginId="builtin:composer"
          name={COMPOSER_TOOLBAR_SLOT}
          className="composer-toolbar-slot"
          slotProps={{
            effectiveModel,
            profileId: profile.id,
            draftMeta: draft.inputMeta,
            setDraftMeta,
            disabled: configLocked,
          } satisfies ComposerToolbarSlotProps}
        />
      }
      sendControls={
        <span className="composer-toolbar-right">
          <IconButton
            variant="primary"
            size="md"
            pill
            pending={inFlight}
            disabled={sendDisabled}
            className="btn-send"
            icon={<HelmxIcon name="arrow-up" size={18} />}
            onClick={onSend}
            title={envError !== null ? envError : t('composer.standby.sendTitle')}
            aria-label={busy ? t('composer.standby.sendingAria') : runningCommand !== null ? t('composer.command.runningAria') : t('composer.sendControls.send')}
          />
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
