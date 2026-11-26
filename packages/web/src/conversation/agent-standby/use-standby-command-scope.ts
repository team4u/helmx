/**
 * Command scope of the standby pane: the anchored conversation (first send already persisted
 * one), the effective model (anchor > draft pick > profile default > global default), the
 * standby scope target plugins resolve commands against, and the in-scope plugin slash
 * commands (re-qualified when the panel-local registry changes).
 */
import { useMemo } from 'react'
import type { ComposerCommandRegistry } from '@helmx/plugin-client'
import type { ConversationScopeTarget, ConversationSummary, Profile } from '@helmx/protocol/browser'
import type { ModelCatalogDefaults } from '../../lib/api.js'
import { pluginSlashCommandsFor, type QualifiedCommand } from '../../lib/commands-model.js'
import { useConversations, useGroupedUi } from '../../lib/store-context.js'
import { resolveStandbyEffectiveModel, type StandbyDraftState } from '../standby-model.js'

export interface StandbyCommandScope {
  readonly anchoredConversation: ConversationSummary | undefined
  readonly slashPluginCommands: ReadonlyArray<QualifiedCommand>
}

export function useStandbyCommandScope(input: {
  draft: StandbyDraftState
  profile: Profile | undefined
  humanSelectable: boolean
  modelDefaults: ModelCatalogDefaults
  commandRegistry: ComposerCommandRegistry
  commandRegistryVersion: number
}): StandbyCommandScope {
  const { draft, profile, humanSelectable, modelDefaults, commandRegistry, commandRegistryVersion } = input
  const conversations = useConversations()
  const groupedUi = useGroupedUi()
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
  return { anchoredConversation, slashPluginCommands }
}
