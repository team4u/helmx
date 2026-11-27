/**
 * Standby composer: the input shell (shared with the active-conversation Composer) bound to
 * the standby draft store — completions, file handlers, attachment chips, plugin menu /
 * toolbar / status slots, env bar, model picker and the send control. The draft itself lives
 * in `standby-model` (per standby key), not in component state.
 */
import { useCallback, useMemo, type RefObject } from 'react'
import {
  COMPOSER_MENU_SLOT,
  COMPOSER_STATUS_SLOT,
  COMPOSER_TOOLBAR_SLOT,
  type ComposerMenuSlotProps,
  type ComposerStatusSlotProps,
  type ComposerToolbarSlotProps,
  type ConversationSummary,
  type Profile,
} from '@helmx/protocol/browser'
import { HelmxIcon, IconButton, PluginSlot } from '@helmx/plugin-client'
import type { ModelCatalogDefaults } from '../../lib/api.js'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import type { QualifiedCommand } from '../../lib/commands-model.js'
import { isImeComposing } from '../../lib/ime.js'
import { ComposerCommandBanner } from '../ComposerCommandBanner.js'
import { ComposerInputShell, type ComposerAttachmentItem } from '../ComposerInputShell.js'
import {
  buildComposerCompletionGroup,
  buildComposerDndGroup,
  buildComposerDraftGroup,
  buildComposerPlusMenuGroup,
} from '../composer-shell-props.js'
import { useIsMobile } from '../composer-model.js'
import { StandbyModelPicker } from '../StandbyControls.js'
import { resolveStandbyEffectiveModel, setStandbyDraftInputMeta, updateStandbyDraft, getStandbyDraft, type StandbyDraftState } from '../standby-model.js'
import { standbySkillScope } from '../../skills/skill-scope-model.js'
import { isComposerSubmitEnterEvent } from '../keybindings-model.js'
import { useComposerAttachments } from '../use-composer-attachments.js'
import { useComposerCompletions } from '../use-composer-completions.js'
import { buildStandbyAttachmentItems } from './standby-attachment-items.js'
import { StandbyComposerAboveBox } from './StandbyComposerAboveBox.js'

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
  textareaRef: RefObject<HTMLTextAreaElement | null>
  onSend: () => void
  onAddFiles: (files: ReadonlyArray<File>) => void
  onResetEnvToDefault: () => void
}

export function StandbyComposer({
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
    if (isComposerSubmitEnterEvent(e) && !isImeComposing(e)) {
      e.preventDefault()
      if (!sendDisabled) onSend()
    }
  }

  const attachmentItems = useMemo<ComposerAttachmentItem[]>(
    () => buildStandbyAttachmentItems(draft, draftKey, busy, t),
    [draft.localFiles, draft.uploaded, draftKey, busy, t],
  )

  return (
    <ComposerInputShell
      attachments={attachmentItems}
      shortcuts={{ panel: isSplit ? 'split' : 'primary' }}
      draft={buildComposerDraftGroup({
        textareaRef,
        ariaLabel: t('composer.standby.firstMessageAria', { name: profile.name || profile.id }),
        value: draft.text,
        readOnly: busy,
        placeholder: isMobile ? t('composer.standby.placeholderMobile') : t('composer.standby.placeholder'),
        onDraftTextChange: setDraftState,
        onKeyDown,
        completions,
        fileHandlers,
      })}
      dnd={buildComposerDndGroup(fileHandlers)}
      plusMenu={buildComposerPlusMenuGroup(fileHandlers, {
        uploadButtonLabel: t('composer.standby.chooseAttachments'),
        uploadDisabled: busy,
        disabled: busy,
        renderSlot: (closeMenu) => (
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
        ),
      })}
      completions={buildComposerCompletionGroup(completions)}
      slots={{
        aboveBox: (
          <StandbyComposerAboveBox
            draftKey={draftKey}
            draft={draft}
            profile={profile}
            isSplit={isSplit}
            disabled={configLocked}
            onResetToDefault={onResetEnvToDefault}
            onRetry={onSend}
          />
        ),
        boxBanner: runningCommand !== null ? <ComposerCommandBanner command={runningCommand} /> : undefined,
        modelPicker: (
          <StandbyModelPicker
            draftKey={draftKey}
            draft={draft}
            profile={profile}
            modelDefaults={modelDefaults}
            disabled={configLocked}
            isSplit={isSplit}
            onReturnFocus={returnFocusToTextarea}
          />
        ),
        toolbar: (
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
        ),
        sendControls: (
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
        ),
        statusRow: (
          <PluginSlot
            ownerPluginId="builtin:composer"
            name={COMPOSER_STATUS_SLOT}
            className="composer-status-slot"
            slotProps={{ effectiveModel, profileId: profile.id } satisfies ComposerStatusSlotProps}
          />
        ),
      }}
    />
  )
}
