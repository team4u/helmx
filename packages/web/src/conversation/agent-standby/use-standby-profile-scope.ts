/**
 * Profile scope of the standby pane: the selected profile and whether a human may start a
 * conversation with it, the switchable agent options (new-topic candidates) with the
 * currently bound remote node, and the resulting readiness flags.
 */
import { useMemo } from 'react'
import type { Profile } from '@helmx/protocol/browser'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import { useConversations, useGroupedUi, usePlugins, useProfilesSlice } from '../../lib/store-context.js'
import { collectEnabledPluginIds, isHumanSelectableProfile } from '../../shell/conversation-status-model.js'
import { buildNewTopicCandidates } from '../../shell/sidebar-model.js'
import { buildStandbyProfileOptions, type StandbyProfileOption } from '../standby-model.js'

export interface StandbyProfileScope {
  readonly assetsLoaded: boolean
  readonly profile: Profile | undefined
  readonly humanSelectable: boolean
  readonly standbyProfileOptions: ReadonlyArray<StandbyProfileOption>
  /** Remote node bound to the current profile (null = Hub / local). */
  readonly currentRemoteNodeId: string | null
  /** Assets loaded, profile known and human-selectable: the composer may mount. */
  readonly standbyReady: boolean
  readonly canSwitchProfile: boolean
  /** Display name of the standby header. */
  readonly label: string
}

export function useStandbyProfileScope(input: { profileId: string; configLocked: boolean }): StandbyProfileScope {
  const { profileId, configLocked } = input
  const { profiles, assetsLoaded } = useProfilesSlice()
  const plugins = usePlugins()
  const conversations = useConversations()
  const groupedUi = useGroupedUi()
  const { locale } = useWebLocale()

  const profile = useMemo(() => profiles.find((p) => p.id === profileId), [profiles, profileId])
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
  const standbyProfileOptions = useMemo(
    () => buildStandbyProfileOptions(profileCandidates, profiles),
    [profileCandidates, profiles],
  )
  const currentRemoteNodeId = useMemo(() => {
    const matched = standbyProfileOptions.find((opt) => opt.profileId === profileId)
    if (matched !== undefined) return matched.remoteNodeId
    const rawNodeId = profile?.nodeId
    return rawNodeId !== undefined && rawNodeId !== '' && rawNodeId !== 'local' ? rawNodeId : null
  }, [standbyProfileOptions, profileId, profile?.nodeId])
  const standbyReady = assetsLoaded && profile !== undefined && humanSelectable
  const canSwitchProfile = standbyReady && profileCandidates.length > 1 && !configLocked
  return {
    assetsLoaded,
    profile,
    humanSelectable,
    standbyProfileOptions,
    currentRemoteNodeId,
    standbyReady,
    canSwitchProfile,
    label: profile?.name || profileId,
  }
}
