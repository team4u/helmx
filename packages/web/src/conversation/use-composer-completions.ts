/**
 * Shared auto-grow, scoped skill catalog, slash menu, and trigger-popover
 * orchestration hook used by both Composer and AgentStandbyPane.
 */
import { useLayoutEffect, useMemo } from 'react'
import type { ConversationSummary, HelmxLocale, Profile } from '@helmx/protocol/browser'
import { buildSlashMenuItems, type QualifiedCommand, type SlashMenuItem } from '../lib/commands-model.js'
import { useGroupedUi, usePlugins, useSkills, useStoreActions } from '../lib/store-context.js'
import { collectEnabledPluginIds } from '../shell/sidebar-model.js'
import type { SkillScope } from '../skills/skill-scope-model.js'
import { useScopedSkillCatalog } from '../skills/use-scoped-skills.js'
import { slashMenuSkillsWithScope } from './slash-menu-skills.js'
import {
  autoGrowTextarea,
  useComposerPopovers,
  useElementWidthResize,
  type UseComposerPopoversResult,
} from './use-composer-popovers.js'

export interface UseComposerCompletionsInput {
  textareaRef: { current: HTMLTextAreaElement | null }
  draftText: string
  isMobile: boolean
  readLiveDraft: () => string
  setDraftState: (next: string) => void
  conversation: ConversationSummary | undefined
  profile: Profile | undefined
  skillScope: SkillScope | undefined
  slashPluginCommands: ReadonlyArray<QualifiedCommand>
  onRunPluginCommand: (cmd: QualifiedCommand) => void
  locale: HelmxLocale
  resetKey: string | number
  disabled?: boolean
}

export interface UseComposerCompletionsResult extends UseComposerPopoversResult {
  slashMenuItems: SlashMenuItem[]
}

export function useComposerCompletions({
  textareaRef,
  draftText,
  isMobile,
  readLiveDraft,
  setDraftState,
  conversation,
  profile,
  skillScope,
  slashPluginCommands,
  onRunPluginCommand,
  locale,
  resetKey,
  disabled = false,
}: UseComposerCompletionsInput): UseComposerCompletionsResult {
  const groupedUi = useGroupedUi()
  const plugins = usePlugins()
  const skills = useSkills()
  const { invokePluginAction } = useStoreActions()

  useLayoutEffect(() => {
    autoGrowTextarea(textareaRef.current)
  }, [textareaRef, draftText, isMobile])
  useElementWidthResize(textareaRef, () => autoGrowTextarea(textareaRef.current))

  const popovers = useComposerPopovers({
    textareaRef,
    draftText,
    readLiveDraft,
    setDraftState,
    completers: groupedUi.composerCompleters,
    conversation,
    profileId: profile?.id,
    resetKey,
    disabled,
  })

  const enabledPluginIds = useMemo(() => collectEnabledPluginIds(plugins), [plugins])
  const scopedSkillCatalog = useScopedSkillCatalog(skillScope, invokePluginAction)
  const availableSkills = useMemo(
    () =>
      slashMenuSkillsWithScope(
        profile,
        skills,
        enabledPluginIds,
        scopedSkillCatalog.catalog?.skills,
      ),
    [profile, skills, enabledPluginIds, scopedSkillCatalog.catalog],
  )
  const slashMenuItems = useMemo(
    () => buildSlashMenuItems(availableSkills, slashPluginCommands, onRunPluginCommand, locale),
    [availableSkills, slashPluginCommands, onRunPluginCommand, locale],
  )

  return {
    ...popovers,
    slashMenuItems,
  }
}
