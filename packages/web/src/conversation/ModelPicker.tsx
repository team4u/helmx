import { useState } from 'react'
import type { ConversationSummary } from '@helmx/protocol/browser'
import { conversationsApi } from '../lib/api.js'
import { ModelPickerControl, resolveEffectiveThinkingLevel } from '@helmx/plugin-client'
import { useModels, useStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { COMPOSER_SHORTCUTS } from './keybindings-model.js'
import { useModelPickerControlAdapter } from './model-picker-adapter.js'

// ---------------------------------------------------------------------------
// ModelPicker (conversation mode): thin host adapter over the shared SDK
// ModelPickerControl — applies model / thinking-level overrides via
// conversationsApi.patch. The control itself (catalog slice, search, keyboard
// navigation, inline thinking chips, catalog refresh) lives in
// @helmx/plugin-client and is the single implementation shared with plugins.
// ---------------------------------------------------------------------------

export interface ModelPickerProps {
  conversation: ConversationSummary
  onReturnFocus?: () => boolean | void
}

export function ModelPicker({ conversation, onReturnFocus }: ModelPickerProps) {
  const models = useModels()
  const { pushNotice } = useStoreActions()
  const { t } = useWebLocale()
  const { copy, onNotice } = useModelPickerControlAdapter(conversation.id)
  const [pending, setPending] = useState(false)

  const apply = async (model: string, level: string | null): Promise<void> => {
    // Same model + null level only clears the thinking override (back to the
    // default chain); a model switch without an explicit level lets the kernel
    // drop the stale override automatically.
    const sameModel = model === conversation.model
    const body = sameModel
      ? { thinkingLevel: level ?? '' }
      : level === null
        ? { model }
        : { model, thinkingLevel: level }
    setPending(true)
    try {
      await conversationsApi.patch(conversation.id, body)
    } catch (err) {
      pushNotice({
        type: 'notification',
        level: 'error',
        title: sameModel ? t('composer.model.thinkingSwitchFailed') : t('composer.model.switchFailed'),
        body: err instanceof Error ? err.message : String(err),
        target: { kind: 'conversation', conversationId: conversation.id },
      })
    } finally {
      setPending(false)
    }
  }

  const resetToProfileDefault = async (): Promise<void> => {
    setPending(true)
    try {
      await conversationsApi.patch(conversation.id, { model: '', thinkingLevel: '' })
    } catch (err) {
      pushNotice({
        type: 'notification',
        level: 'error',
        title: t('composer.model.restoreFailed'),
        body: err instanceof Error ? err.message : String(err),
        target: { kind: 'conversation', conversationId: conversation.id },
      })
    } finally {
      setPending(false)
    }
  }

  const currentModel = models.find((model) => model.id === conversation.model)
  const currentLevels = currentModel?.thinkingLevels ?? ['off']
  const supportsThinking = currentLevels.some((level) => level !== 'off')
  const effectiveLevel = resolveEffectiveThinkingLevel(currentLevels, conversation.thinkingLevel)
  const showLevel = supportsThinking && effectiveLevel !== '' && effectiveLevel !== 'off'

  return (
    <ModelPickerControl
      effectiveModel={conversation.model}
      activeThinkingLevel={conversation.thinkingLevel}
      enableRegisteredModes={true}
      resetLabel={t('composer.model.clearOverride')}
      resetTitle={t('composer.model.clearOverride')}
      buttonTitle={t('composer.model.currentTitle', {
        model: conversation.model,
        thinking: showLevel ? t('composer.model.thinkingSuffix', { level: effectiveLevel }) : '',
        shortcut: COMPOSER_SHORTCUTS.toggleModelPicker,
      })}
      pending={pending}
      copy={copy}
      onNotice={onNotice}
      onApply={apply}
      onResetDefault={resetToProfileDefault}
      onReturnFocus={onReturnFocus}
    />
  )
}
