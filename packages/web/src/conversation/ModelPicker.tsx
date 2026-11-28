import { useState } from 'react'
import type { ConversationSummary } from '@helmx/protocol/browser'
import { conversationsApi } from '../lib/api.js'
import {
  formatModelShortName,
  ModelPickerControl,
  resolveEffectiveThinkingLevel,
  useHostModels,
  type ModelPickerNextTurnMode,
} from '@helmx/plugin-client'
import { Badge } from '@helmx/ui'
import { useModels, useStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { COMPOSER_SHORTCUTS } from './keybindings-model.js'
import { useModelPickerControlAdapter } from './model-picker-adapter.js'

// ---------------------------------------------------------------------------
// ModelPicker (conversation mode): thin host adapter over the shared SDK
// ModelPickerControl — applies model / thinking-level overrides via
// conversationsApi.patch, supports one-turn local draft overrides via
// `nextTurnMode`, and surfaces `conversation.runtimeModelOverride` when a
// temporary per-turn override is active on the server.
// ---------------------------------------------------------------------------

export interface ModelPickerProps {
  conversation: ConversationSummary
  nextTurnMode?: ModelPickerNextTurnMode
  onReturnFocus?: () => boolean | void
}

export function ModelPicker({ conversation, nextTurnMode, onReturnFocus }: ModelPickerProps) {
  const models = useModels()
  const hostModels = useHostModels()
  const { pushNotice } = useStoreActions()
  const { t } = useWebLocale()
  const { copy, onNotice } = useModelPickerControlAdapter(conversation.id)
  const [pending, setPending] = useState(false)

  const configuredBaseline =
    conversation.effectiveModelRef !== undefined && conversation.effectiveModelRef !== ''
      ? conversation.effectiveModelRef
      : conversation.modelOverride !== undefined && conversation.modelOverride !== ''
        ? conversation.modelOverride
        : undefined
  const baselineTier =
    configuredBaseline !== undefined && configuredBaseline.startsWith('tier/')
      ? hostModels?.modelTiers?.find((item) => `tier/${item.id}` === configuredBaseline)
      : undefined
  const isPreserveRefBaseline = baselineTier?.preserveRef === true
  const displayEffectiveModel =
    conversation.runtimeModelOverride === true && !isPreserveRefBaseline
      ? conversation.model
      : (configuredBaseline ?? conversation.model)
  const displayThinkingLevel =
    isPreserveRefBaseline && conversation.runtimeModelOverride === true
      ? (baselineTier?.thinkingLevel ?? '')
      : conversation.thinkingLevel
  const allowPreserveRefTiers =
    conversation.parentConversationId === undefined && (conversation.ownedBy ?? 'human') === 'human'

  const stagedNextTurnModel =
    nextTurnMode?.model !== undefined && nextTurnMode.model !== '' ? nextTurnMode.model : undefined
  const stagedNextTurnThinking =
    nextTurnMode?.thinkingLevel !== undefined && nextTurnMode.thinkingLevel !== ''
      ? nextTurnMode.thinkingLevel
      : undefined
  const hasStagedNextTurn =
    nextTurnMode !== undefined &&
    (stagedNextTurnModel !== undefined || stagedNextTurnThinking !== undefined)
  const isRuntimeOverride =
    conversation.runtimeModelOverride === true && !hasStagedNextTurn && !isPreserveRefBaseline

  const apply = async (model: string, level: string | null): Promise<void> => {
    // Same model + null level only clears the thinking override (back to the
    // default chain); a model switch without an explicit level lets the kernel
    // drop the stale override automatically. While a temporary runtime override
    // is active, promote any explicit selection as a full `{ model }` patch.
    const sameModel = conversation.runtimeModelOverride !== true && model === displayEffectiveModel
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

  const resolveLevelsFor = (modelId: string | undefined): ReadonlyArray<string> => {
    if (modelId === undefined || modelId === '') return ['off']
    const concrete = models.find((model) => model.id === modelId)
    if (concrete !== undefined) return concrete.thinkingLevels ?? ['off']
    if (modelId.startsWith('tier/')) {
      const tier = hostModels?.modelTiers?.find((item) => `tier/${item.id}` === modelId)
      if (tier !== undefined) return tier.thinkingLevels ?? ['off']
    }
    return ['off']
  }

  const currentLevels = resolveLevelsFor(
    isPreserveRefBaseline && conversation.runtimeModelOverride === true
      ? displayEffectiveModel
      : (conversation.model || displayEffectiveModel),
  )
  const supportsThinking = currentLevels.some((level) => level !== 'off')
  const effectiveLevel = resolveEffectiveThinkingLevel(currentLevels, displayThinkingLevel)
  const showLevel = supportsThinking && effectiveLevel !== '' && effectiveLevel !== 'off'
  const thinkingSuffix = showLevel ? t('composer.model.thinkingSuffix', { level: effectiveLevel }) : ''
  const titleModel =
    !isRuntimeOverride &&
    configuredBaseline !== undefined &&
    conversation.model !== '' &&
    configuredBaseline !== conversation.model
      ? `${configuredBaseline} (${conversation.model})`
      : displayEffectiveModel

  let buttonTitle: string
  let buttonAriaLabel: string | undefined
  if (hasStagedNextTurn) {
    const stagedTargetModel = stagedNextTurnModel ?? displayEffectiveModel
    const stagedLevels = resolveLevelsFor(stagedTargetModel)
    const stagedSupportsThinking = stagedLevels.some((level) => level !== 'off')
    const stagedThinkingInput =
      stagedNextTurnThinking ?? (stagedNextTurnModel !== undefined ? '' : conversation.thinkingLevel)
    const stagedEffectiveLevel = resolveEffectiveThinkingLevel(stagedLevels, stagedThinkingInput)
    const stagedShowLevel =
      stagedSupportsThinking && stagedEffectiveLevel !== '' && stagedEffectiveLevel !== 'off'
    const stagedThinkingSuffix = stagedShowLevel
      ? t('composer.model.thinkingSuffix', { level: stagedEffectiveLevel })
      : ''
    const baselineLabel =
      configuredBaseline ??
      (conversation.model !== '' ? conversation.model : t('composer.model.baselineDefault'))
    buttonTitle = t('composer.model.nextTurnTitle', {
      model: stagedTargetModel,
      thinking: stagedThinkingSuffix,
      baseline: baselineLabel,
      shortcut: COMPOSER_SHORTCUTS.toggleModelPicker,
    })
  } else if (isRuntimeOverride) {
    const shortEffective =
      formatModelShortName(displayEffectiveModel) ||
      displayEffectiveModel ||
      t('composer.model.defaultLabel')
    const levelAriaSuffix = showLevel ? t('composer.model.levelSuffix', { level: effectiveLevel }) : ''
    if (configuredBaseline !== undefined) {
      buttonTitle = t('composer.model.runtimeOverrideTitle', {
        model: titleModel,
        thinking: thinkingSuffix,
        baseline: configuredBaseline,
        shortcut: COMPOSER_SHORTCUTS.toggleModelPicker,
      })
      buttonAriaLabel = t('composer.model.runtimeOverrideAria', {
        model: shortEffective,
        level: levelAriaSuffix,
        baseline: formatModelShortName(configuredBaseline) || configuredBaseline,
      })
    } else {
      buttonTitle = t('composer.model.runtimeOverrideDefaultTitle', {
        model: titleModel,
        thinking: thinkingSuffix,
        shortcut: COMPOSER_SHORTCUTS.toggleModelPicker,
      })
      buttonAriaLabel = t('composer.model.runtimeOverrideDefaultAria', {
        model: shortEffective,
        level: levelAriaSuffix,
      })
    }
  } else {
    buttonTitle = t('composer.model.currentTitle', {
      model: titleModel,
      thinking: thinkingSuffix,
      shortcut: COMPOSER_SHORTCUTS.toggleModelPicker,
    })
  }

  const picker = (
    <ModelPickerControl
      effectiveModel={displayEffectiveModel}
      activeThinkingLevel={displayThinkingLevel}
      nextTurnMode={nextTurnMode}
      allowPreserveRefTiers={allowPreserveRefTiers}
      resetLabel={t('composer.model.clearOverride')}
      resetTitle={t('composer.model.clearOverride')}
      buttonTitle={buttonTitle}
      buttonAriaLabel={buttonAriaLabel}
      pending={pending}
      copy={copy}
      onNotice={onNotice}
      onApply={apply}
      onResetDefault={resetToProfileDefault}
      onReturnFocus={onReturnFocus}
    />
  )

  if (!isRuntimeOverride) return picker

  return (
    <span className="composer-model-runtime-wrap" data-runtime-override="true">
      {picker}
      <Badge tone="accent" className="composer-model-runtime-badge">
        {t('composer.model.runtimeOverrideBadge')}
      </Badge>
    </span>
  )
}
