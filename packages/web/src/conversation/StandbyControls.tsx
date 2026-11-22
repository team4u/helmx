/**
 * Standby-specific model picker and starting-environment bar extracted from
 * AgentStandbyPane to keep standby orchestration concise and reuse shared
 * ComposerEnvFields + ModelPickerControl primitives.
 */
import type * as React from 'react'
import type { Profile } from '@helmx/protocol/browser'
import { HelmxIcon, ModelPickerControl, useHostModels } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import type { ModelCatalogDefaults } from '../lib/api.js'
import { useModels, useNodes } from '../lib/store-context.js'
import { ComposerEnvFields } from './ComposerEnvFields.js'
import { envDraftOnNodeChange } from './composer-model.js'
import { COMPOSER_SHORTCUTS } from './keybindings-model.js'
import { useModelPickerControlAdapter } from './model-picker-adapter.js'
import {
  resolveStandbyEffectiveModel,
  resolveStandbyThinkingLevel,
  updateStandbyDraft,
  type StandbyDraftState,
} from './standby-model.js'

export interface StandbyModelPickerProps {
  draftKey: string
  draft: StandbyDraftState
  profile: Profile
  modelDefaults: ModelCatalogDefaults
  disabled: boolean
  isSplit?: boolean
  onReturnFocus?: () => boolean | void
}

export function StandbyModelPicker({
  draftKey,
  draft,
  profile,
  modelDefaults,
  disabled,
  isSplit,
  onReturnFocus,
}: StandbyModelPickerProps): React.JSX.Element {
  const models = useModels()
  const hostModels = useHostModels()
  const { t } = useWebLocale()
  const { copy, onNotice } = useModelPickerControlAdapter()
  const lockedNote = t('composer.model.lockedNote')

  const effectiveModel = resolveStandbyEffectiveModel(
    draft.model,
    profile.model,
    modelDefaults.defaultModel,
  )
  const activeTier =
    effectiveModel !== undefined && effectiveModel.startsWith('tier/')
      ? hostModels?.modelTiers?.find((tier) => `tier/${tier.id}` === effectiveModel)
      : undefined
  const resolvedConcreteModel = activeTier?.model ?? effectiveModel
  const currentModel = resolvedConcreteModel !== undefined
    ? models.find((model) => model.id === resolvedConcreteModel)
    : undefined
  const currentLevels = currentModel?.thinkingLevels ?? activeTier?.thinkingLevels ?? ['off']
  const supportsThinking = currentLevels.some((level) => level !== 'off')
  const effectiveThinkingLevel = resolveStandbyThinkingLevel(
    currentLevels,
    draft.thinkingLevel ?? activeTier?.thinkingLevel,
    resolvedConcreteModel !== undefined ? modelDefaults.modelThinkingLevels?.[resolvedConcreteModel] : undefined,
    profile.thinkingLevel,
    modelDefaults.defaultThinkingLevel,
  )
  const showThinkingBadge = supportsThinking && effectiveThinkingLevel !== '' && effectiveThinkingLevel !== 'off'
  const thinkingSuffix = showThinkingBadge ? t('composer.model.thinkingSuffix', { level: effectiveThinkingLevel }) : ''

  return (
    <ModelPickerControl
      effectiveModel={effectiveModel}
      activeThinkingLevel={effectiveThinkingLevel}
      fallbackPanel={isSplit ? 'split' : 'primary'}
      resetLabel={
        profile.model !== undefined && profile.model !== ''
          ? t('composer.model.followProfileDefaultModel', { model: profile.model })
          : t('composer.model.followProfileDefault')
      }
      resetTitle={t('composer.model.standbyResetTitle')}
      buttonTitle={
        disabled
          ? lockedNote
          : effectiveModel !== undefined && effectiveModel !== ''
            ? t('composer.model.currentTitle', { model: effectiveModel, thinking: thinkingSuffix, shortcut: COMPOSER_SHORTCUTS.toggleModelPicker })
            : t('composer.model.followsDefaultTitle', { thinking: thinkingSuffix, shortcut: COMPOSER_SHORTCUTS.toggleModelPicker })
      }
      disabled={disabled}
      copy={copy}
      onNotice={onNotice}
      onReturnFocus={onReturnFocus}
      onApply={(model, level) => {
        updateStandbyDraft(draftKey, { model, thinkingLevel: level ?? undefined })
      }}
      onResetDefault={() => {
        updateStandbyDraft(draftKey, { model: undefined, thinkingLevel: undefined })
      }}
    />
  )
}

export interface StandbyEnvBarProps {
  draftKey: string
  draft: StandbyDraftState
  profile: Profile
  disabled: boolean
  onResetToDefault: () => void
}

export function StandbyEnvBar({
  draftKey,
  draft,
  profile,
  disabled,
  onResetToDefault,
}: StandbyEnvBarProps): React.JSX.Element {
  const nodes = useNodes()
  const { t } = useWebLocale()

  if (!draft.envCustomized) {
    return (
      <div className="composer-env-bar agent-standby-env-bar">
        <HelmxIcon name="monitor" size={12} />
        <span className="agent-standby-env-hint">
          {t('composer.standby.envFollowsProfile', {
            node: profile.nodeId !== undefined && profile.nodeId !== '' ? t('composer.standby.envSuffix', { value: profile.nodeId }) : '',
            cwd: profile.cwd ? t('composer.standby.envSuffix', { value: profile.cwd }) : '',
          })}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          disabled={disabled}
          onClick={() => {
            if (disabled) return
            updateStandbyDraft(draftKey, {
              envCustomized: true,
              envNodeId: profile.nodeId || 'local',
              envCwd: profile.cwd ?? '',
            })
          }}
        >
          {t('composer.standby.customEnvButton')}
        </button>
      </div>
    )
  }

  const nodeId = draft.envNodeId || 'local'
  const draftNode = nodes.find((n) => n.id === nodeId)
  return (
    <div className="composer-env-bar agent-standby-env-bar" data-dirty="true">
      <ComposerEnvFields
        nodeId={nodeId}
        cwd={draft.envCwd ?? ''}
        disabled={disabled}
        nodeAriaLabel={t('composer.standby.envNodeAria')}
        cwdAriaLabel={t('composer.standby.envCwdAria')}
        cwdPlaceholder={t('composer.env.cwdPlaceholder')}
        onNodeChange={(nextNodeId) => {
          const next = envDraftOnNodeChange({ nodeId, cwd: draft.envCwd ?? '' }, nextNodeId)
          updateStandbyDraft(draftKey, { envNodeId: next.nodeId, envCwd: next.cwd })
        }}
        onCwdChange={(nextCwd) => updateStandbyDraft(draftKey, { envCwd: nextCwd })}
      />
      <button
        type="button"
        className="btn btn-sm"
        disabled={disabled}
        onClick={onResetToDefault}
        title={disabled ? t('composer.standby.envLockedTitle') : t('composer.standby.clearEnvTitle')}
      >
        {t('composer.standby.restoreDefaults')}
      </button>
      <span className="composer-env-hint">{t('composer.standby.envEffectOnSend')}</span>
      {draftNode !== undefined && !draftNode.online && draft.envNodeId !== 'local' ? (
        <span className="composer-env-warn">{t('composer.standby.nodeOfflineWarn')}</span>
      ) : null}
    </div>
  )
}
