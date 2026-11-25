import { memo, useCallback, useId, useMemo, useRef, useState } from 'react'
import type { ComposerMenuSlotProps, ComposerScopeProps, ConversationSummary, WhenBusy } from '@helmx/protocol/browser'
import { COMPOSER_DOCK_SLOT, COMPOSER_MENU_SLOT, COMPOSER_STATUS_SLOT, COMPOSER_TOOLBAR_SLOT } from '@helmx/protocol/browser'
import { Button, ComposerCommandContext, HelmxIcon, PluginSlot, createComposerCommandRegistry, useSharedNowMs } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { conversationsApi } from '../lib/api.js'
import { pluginSlashCommandsFor } from '../lib/commands-model.js'
import {
  useConversationDetail,
  useGroupedUi,
  useHelmxExternalStore,
  useProfilesSlice,
} from '../lib/store-context.js'
import { conversationSkillScope } from '../skills/skill-scope-model.js'
import { AskDock } from './AskDock.js'
import { ComposerCommandBanner } from './ComposerCommandBanner.js'
import { ComposerInputShell, type ComposerAttachmentItem } from './ComposerInputShell.js'
import { ComposerSendControls } from './ComposerSendControls.js'
import { ModelPicker } from './ModelPicker.js'
import { SessionEnvBar } from './SessionEnvBar.js'
import { useComposerController, useFocusComposerShortcut } from './composer-controller.js'
import {
  busyEnterMode,
  canConfigureSessionEnv,
  getComposerPlaceholder,
  useIsMobile,
} from './composer-model.js'
import { useComposerSend, type ComposerPrefill } from './composer-send.js'
import { contextUsageLabel } from './context-usage-model.js'
import {
  conversationDurationLabel,
  conversationDurationNeedsLiveClock,
} from './conversation-duration-model.js'
import { useConversationDirtySink } from './conversation-window-model.js'
import {
  canRecallOnArrowUp,
  isComposerSubmitEnterEvent,
  isPlainArrowUpEvent,
  latestHumanQueuedInput,
} from './keybindings-model.js'
import { lastEditableHumanInput } from './timeline-model.js'
import { useComposerAttachments } from './use-composer-attachments.js'
import { useComposerCompletions } from './use-composer-completions.js'

export interface ComposerProps {
  conversation: ConversationSummary
  /** 请求回填文本（时间线「编辑并重发」）；每次递增 tick 保证同文本也能再次触发。 */
  prefill: ComposerPrefill | null
  /** 真实发送请求开始/结束时通知父层（在途反馈；斜杠命令不触发）。 */
  onSendingChange?: (sending: boolean) => void
  /** /new 新话题入口：进入本智能体待命页（首次发送才落库）；宿主传入面板位置明确的导航回调。 */
  onNewThread?: (opts?: { flush?: boolean }) => void
  isSplit?: boolean
  staged?: boolean
  isDrawer?: boolean
}

function ContextUsageStatus({ conversation }: { conversation: ConversationSummary }) {
  const { t } = useWebLocale()
  const usage = conversation.contextUsage
  if (usage === undefined) return null
  const label = contextUsageLabel(usage, t)
  if (label === null) return null
  return (
    <span
      className={`composer-context-status${label.tone === 'high' ? ' composer-context-status-high' : label.tone === 'warn' ? ' composer-context-status-warn' : ''}`}
      title={label.title}
    >
      <span className="mono tabular-nums">{label.text}</span>
    </span>
  )
}

function ConversationDurationStatus({ conversation }: { conversation: ConversationSummary }) {
  const { t } = useWebLocale()
  const liveActive = conversationDurationNeedsLiveClock(conversation)
  const nowMs = useSharedNowMs(liveActive)
  const label = conversationDurationLabel(conversation, nowMs, t)
  if (label === null) return null
  return (
    <span className="composer-duration-status">
      <span className="mono tabular-nums">{label}</span>
    </span>
  )
}

export const Composer = memo(function Composer({
  conversation,
  prefill,
  onSendingChange,
  onNewThread,
  isSplit = false,
  staged = true,
  isDrawer = false,
}: ComposerProps) {
  const externalStore = useHelmxExternalStore()
  const detail = useConversationDetail(conversation.id)
  const groupedUi = useGroupedUi()
  const { profiles } = useProfilesSlice()
  const { locale, t } = useWebLocale()
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useFocusComposerShortcut({
    textareaRef,
    panel: isSplit ? 'split' : 'primary',
    staged,
    isDrawer,
    conversationId: conversation.id,
  })

  const compacting = conversation.contextUsage?.compacting === true
  const working = conversation.status === 'working' || conversation.status === 'blocked' || compacting
  const isMobile = useIsMobile(680)
  const detailEntries = detail?.nextCursor && !detail.entries.some((entry) => entry.kind === 'pi.reset')
    ? undefined
    : detail?.entries
  const envConfigurable = canConfigureSessionEnv(detailEntries, conversation.status)

  const slashPluginCommands = useMemo(
    () => pluginSlashCommandsFor(groupedUi.commands, conversation),
    [groupedUi.commands, conversation],
  )
  const menuSlotPluginIds = useMemo(
    () =>
      new Set(
        groupedUi.pluginSlots
          .filter((entry) => entry.spec.target === COMPOSER_MENU_SLOT)
          .map((entry) => entry.pluginId),
      ),
    [groupedUi.pluginSlots],
  )
  const plusMenuCommands = useMemo(
    () => slashPluginCommands.filter((cmd) => !menuSlotPluginIds.has(cmd.pluginId)),
    [slashPluginCommands, menuSlotPluginIds],
  )

  const composerDirtyKey = useId()
  const dirtySink = useConversationDirtySink()
  const [commandRegistry] = useState(() => createComposerCommandRegistry())
  const {
    text,
    attachments,
    editingEntryId,
    sending,
    uploading,
    runningCommand,
    envBlocker,
    sendInFlight,
    setDraftState,
    insertTextState,
    readLiveDraft,
    cancelEdit,
    uploadFiles,
    removeAttachment,
    applyHistoryEdit,
    withdrawQueuedInput,
    send,
    sendExplicit,
    runPluginCommand,
    runPluginCommandDirect,
    handleEnvBlocker,
    notifyError,
  } = useComposerSend(
    {
      conversation,
      prefill,
      onSendingChange,
      onNewThread,
      textareaRef,
      slashPluginCommands,
      envConfigurable,
      working,
      dirtyKey: composerDirtyKey,
      dirtySink,
      commandRegistry,
    },
    t,
  )

  const conversationProfile = useMemo(
    () => profiles.find((p) => p.id === conversation.profileId),
    [profiles, conversation.profileId],
  )
  const conversationScope = useMemo(
    () => conversationSkillScope(conversation),
    [conversation.nodeId, conversation.cwd],
  )

  const completions = useComposerCompletions({
    textareaRef,
    draftText: text,
    isMobile,
    readLiveDraft,
    setDraftState,
    conversation,
    profile: conversationProfile,
    skillScope: conversationScope,
    slashPluginCommands,
    onRunPluginCommand: runPluginCommand,
    locale,
    resetKey: conversation.id,
  })

  const handleUploadFiles = useCallback((files: File[]) => {
    void uploadFiles(files)
  }, [uploadFiles])

  const fileHandlers = useComposerAttachments({ onFiles: handleUploadFiles })

  const submitDraft = useCallback(
    (whenBusy?: WhenBusy) => send(whenBusy ?? 'steer', true),
    [send],
  )

  const composer = useComposerController({
    text,
    readDraft: readLiveDraft,
    attachments,
    sending,
    textareaRef,
    setDraftState,
    insertTextState,
    submitDraft,
    submitExplicitText: sendExplicit,
  })

  const composerSlotProps = useMemo<ComposerScopeProps & Record<string, unknown>>(
    () => ({ conversation, composer }),
    [conversation, composer],
  )

  const returnFocusToTextarea = useCallback(() => {
    const el = textareaRef.current
    if (el === null) return false
    el.focus()
    return true
  }, [])

  const abortTurn = async (): Promise<void> => {
    try {
      await conversationsApi.abort(conversation.id)
    } catch (err) {
      notifyError(t('conv.composer.abortFailed'), err)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.defaultPrevented || e.nativeEvent.defaultPrevented) return
    if (completions.shouldDeferKeyToPopover(e)) return
    if (e.key === 'Escape' && !completions.slashOpen && !completions.completionOpen && editingEntryId !== null) {
      e.preventDefault()
      e.stopPropagation()
      cancelEdit()
      return
    }
    if (isComposerSubmitEnterEvent(e) && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (editingEntryId !== null) {
        void send('followUp')
        return
      }
      void send(working ? busyEnterMode(e.metaKey || e.ctrlKey) : 'followUp')
      return
    }
    if (
      isPlainArrowUpEvent(e) &&
      !e.nativeEvent.isComposing &&
      editingEntryId === null &&
      canRecallOnArrowUp(e.currentTarget.value, e.currentTarget.selectionStart)
    ) {
      const liveQueued = externalStore?.getConversationLive(conversation.id)?.queuedInputs
      const queued = latestHumanQueuedInput(liveQueued)
      if (queued !== undefined) {
        e.preventDefault()
        void withdrawQueuedInput(queued)
        return
      }
      const target = lastEditableHumanInput(detail?.entries ?? [])
      if (target !== undefined) {
        e.preventDefault()
        applyHistoryEdit(target)
      }
    }
  }

  const attachmentItems = useMemo<ComposerAttachmentItem[]>(
    () =>
      attachments.map((att) => ({
        key: att.artifactId,
        name: att.name,
        size: att.size,
        icon: 'paperclip',
        onRemove: () => removeAttachment(att.artifactId),
      })),
    [attachments, removeAttachment],
  )

  return (
    <ComposerCommandContext.Provider value={commandRegistry}>
      <ComposerInputShell
        aboveBox={
        <>
          <PluginSlot
            ownerPluginId="builtin:composer"
            name={COMPOSER_DOCK_SLOT}
            conversationId={conversation.id}
            composer={composer}
            className="composer-dock-slot"
            slotProps={composerSlotProps}
          />
          <AskDock conversationId={conversation.id} />
          {envConfigurable ? (
            <SessionEnvBar
              key={`env-${conversation.id}`}
              conversation={conversation}
              sendBlocked={sendInFlight}
              onBlockerChange={handleEnvBlocker}
            />
          ) : null}
        </>
      }
      boxBanner={
        editingEntryId !== null || runningCommand !== null ? (
          <>
            {runningCommand !== null ? <ComposerCommandBanner command={runningCommand} /> : null}
            {editingEntryId !== null ? (
              <div className="composer-edit-banner" role="status">
                <span className="composer-edit-banner-text">
                  <HelmxIcon name="edit" size={12} />
                  <span>{working ? t('conv.composer.editingWorking') : t('conv.composer.editingIdle')}</span>
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  icon="x"
                  className="composer-edit-cancel"
                  onClick={cancelEdit}
                  title={t('conv.composer.cancelEditTitle')}
                >
                  <span>{t('common.cancel')}</span>
                  <span className="kbd-hint composer-inline-kbd">Esc</span>
                </Button>
              </div>
            ) : null}
          </>
        ) : undefined
      }
      attachments={attachmentItems}
      textareaRef={textareaRef}
      textareaAriaLabel={t('conv.composer.inputAria')}
      value={text}
      placeholder={getComposerPlaceholder(working, isMobile, t)}
      onTextChange={(nextValue, caret) => {
        setDraftState(nextValue)
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
      uploadButtonLabel={t('composer.plusMenu.upload')}
      onOpenFilePicker={fileHandlers.openFilePicker}
      onFileInputChange={fileHandlers.onFileInputChange}
      renderMenuSlot={(closeMenu) => (
        <PluginSlot
          ownerPluginId="builtin:composer"
          name={COMPOSER_MENU_SLOT}
          conversationId={conversation.id}
          composer={composer}
          slotProps={{ ...composerSlotProps, onCloseMenu: closeMenu } satisfies ComposerMenuSlotProps & Record<string, unknown>}
        />
      )}
      menuCommands={plusMenuCommands}
      menuCommandsDisabled={runningCommand !== null}
      onRunMenuCommand={runPluginCommandDirect}
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
      modelPicker={<ModelPicker conversation={conversation} onReturnFocus={returnFocusToTextarea} />}
      toolbarSlot={
        <PluginSlot
          ownerPluginId="builtin:composer"
          name={COMPOSER_TOOLBAR_SLOT}
          conversationId={conversation.id}
          composer={composer}
          className="composer-toolbar-slot"
          slotProps={composerSlotProps}
        />
      }
      sendControls={
        <ComposerSendControls
          working={working}
          editingEntryId={editingEntryId}
          sending={sending}
          uploading={uploading}
          commandRunning={runningCommand !== null}
          envBlocker={envBlocker}
          text={text}
          isMobile={isMobile}
          send={send}
          abortTurn={abortTurn}
        />
      }
      statusRow={
        <>
          <ContextUsageStatus conversation={conversation} />
          <ConversationDurationStatus conversation={conversation} />
          <PluginSlot
            ownerPluginId="builtin:composer"
            name={COMPOSER_STATUS_SLOT}
            conversationId={conversation.id}
            composer={composer}
            className="composer-status-slot"
            slotProps={composerSlotProps}
          />
        </>
      }
      />
    </ComposerCommandContext.Provider>
  )
})
