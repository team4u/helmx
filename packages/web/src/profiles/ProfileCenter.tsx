import type * as React from 'react'
import { useMemo, useState } from 'react'
import { HelmxIcon } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  useLocationTargets,
  useModelDefaults,
  useProfilesSlice,
  useStoreActions,
} from '../lib/store-context.js'
import { SystemCenterEmpty, SystemCenterShell, SystemCenterToolbar } from '../ui/SystemCenterShell.js'
import { usePaneSplitToggle } from '../ui/use-pane-split-toggle.js'
import { ProfileCard } from './ProfileCard.js'
import { ProfileDetailDrawer } from './ProfileDetailDrawer.js'
import type { Profile } from './profile-center-model.js'
import {
  buildProfileCategoryCounts,
  buildProfileCategoryTabs,
  filterProfiles,
  type ProfileCategoryTab,
} from './profile-center-model.js'

export interface ProfileCenterProps {
  isSplit?: boolean
  onCloseSplit?: () => void
  /** Render the detail drawer inline explicitly (for tests and unified SSR assertions). */
  inlineDrawer?: boolean
}

/**
 * Full-screen agent profile center (primary stage):
 * - top bar, search + category pills, responsive card grid, and 540px right
 *   slide-over ProfileDetailDrawer synced with URL hash;
 * - reads global default model from store (`useModelDefaults`) with zero redundant HTTP fetch.
 */
export function ProfileCenter({
  isSplit = false,
  onCloseSplit,
  inlineDrawer = false,
}: ProfileCenterProps): React.JSX.Element {
  const { profiles } = useProfilesSlice()
  const modelDefaults = useModelDefaults()
  const { primaryTarget, splitTarget } = useLocationTargets()
  const { openTarget, refreshAssets, pushNotice } = useStoreActions()
  const { t } = useWebLocale()
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState<ProfileCategoryTab>('all')
  const [isCreatingNew, setIsCreatingNew] = useState(false)

  const effectiveDefaultModelInfo = useMemo(() => {
    if (modelDefaults.defaultModel === undefined && modelDefaults.defaultThinkingLevel === undefined) {
      return null
    }
    return {
      defaultModel: modelDefaults.defaultModel ?? '',
      defaultThinkingLevel: modelDefaults.defaultThinkingLevel ?? '',
    }
  }, [modelDefaults.defaultModel, modelDefaults.defaultThinkingLevel])

  const categoryTabs = useMemo(() => buildProfileCategoryTabs(t), [t])
  const effectiveTab: ProfileCategoryTab = categoryTabs.some((tab) => tab.key === activeTab)
    ? activeTab
    : 'all'

  const categoryCounts = useMemo(() => buildProfileCategoryCounts(profiles), [profiles])
  const pills = useMemo(
    () => categoryTabs.map((tab) => ({ key: tab.key, label: tab.label, count: categoryCounts[tab.key] ?? 0 })),
    [categoryTabs, categoryCounts],
  )

  const filteredProfiles = useMemo(
    () => filterProfiles(profiles, { query, categoryTab: effectiveTab }),
    [profiles, query, effectiveTab],
  )

  const activeTarget = isSplit ? splitTarget : primaryTarget
  const selectedProfileId = activeTarget?.kind === 'profiles' ? activeTarget.profileId : undefined
  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId],
  )
  const isDrawerOpen = Boolean((selectedProfileId && selectedProfile) || isCreatingNew || selectedProfileId === 'new')

  const openCenterTarget = (profileId?: string) => {
    const target = profileId !== undefined ? { kind: 'profiles' as const, profileId } : { kind: 'profiles' as const }
    openTarget(target, isSplit ? { split: true } : undefined)
  }

  const handleSelectProfile = (profileId: string) => {
    setIsCreatingNew(false)
    openCenterTarget(profileId)
  }

  const handleCreateNew = () => {
    setIsCreatingNew(true)
    openCenterTarget('new')
  }

  const handleCloseDrawer = () => {
    setIsCreatingNew(false)
    openCenterTarget(undefined)
  }

  const handleProfileSaved = (saved: Profile) => {
    setIsCreatingNew(false)
    void refreshAssets()
    pushNotice({
      type: 'notification',
      level: 'info',
      title: t('profiles.notice.savedTitle'),
      body: t('profiles.notice.savedBody', { name: saved.name || saved.id }),
    })
    openCenterTarget(saved.id)
  }

  const handleProfileDeleted = (deletedId: string) => {
    setIsCreatingNew(false)
    void refreshAssets()
    pushNotice({
      type: 'notification',
      level: 'info',
      title: t('profiles.notice.deletedTitle'),
      body: t('profiles.notice.deletedBody', { id: deletedId }),
    })
    openCenterTarget(undefined)
  }

  const { isSplitActive, toggleSplit } = usePaneSplitToggle({
    isSplit,
    onCloseSplit,
    getSplitTarget: () => ({ kind: 'profiles', profileId: selectedProfileId }),
  })

  return (
    <SystemCenterShell
      dataView="profile-center"
      isSplit={isSplit}
      isSplitActive={isSplitActive}
      onCloseSplit={onCloseSplit}
      onToggleSplit={toggleSplit}
      icon="bot"
      title={t('profiles.center.title')}
      headerActions={
        <button type="button" className="btn btn-sm" onClick={handleCreateNew}>
          <HelmxIcon name="plus" size={12} />
          <span className="pane-action-label">{t('profiles.center.newProfile')}</span>
        </button>
      }
      toolbar={
        <SystemCenterToolbar
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder={t('profiles.center.searchPlaceholder')}
          searchAriaLabel={t('profiles.center.searchLabel')}
          clearSearchLabel={t('profiles.center.clearSearch')}
          filterAriaLabel={t('profiles.center.filterLabel')}
          pills={pills}
          activePill={effectiveTab}
          onSelectPill={setActiveTab}
        />
      }
      overlays={
        <ProfileDetailDrawer
          profile={selectedProfile}
          isNew={isCreatingNew || selectedProfileId === 'new'}
          open={isDrawerOpen}
          onClose={handleCloseDrawer}
          inline={inlineDrawer}
          onSaved={handleProfileSaved}
          onDeleted={handleProfileDeleted}
        />
      }
    >
      {filteredProfiles.length > 0 ? (
        <div className="primary-center-grid">
          {filteredProfiles.map((p) => (
            <ProfileCard
              key={p.id}
              profile={p}
              selected={selectedProfileId === p.id}
              defaultModelInfo={effectiveDefaultModelInfo}
              onSelect={() => handleSelectProfile(p.id)}
            />
          ))}
        </div>
      ) : (
        <SystemCenterEmpty
          title={t('profiles.center.emptyTitle')}
          hint={t('profiles.center.emptyHint')}
          showReset={Boolean(query) || effectiveTab !== 'all'}
          resetLabel={t('profiles.center.resetFilters')}
          onReset={() => {
            setQuery('')
            setActiveTab('all')
          }}
        />
      )}
    </SystemCenterShell>
  )
}
