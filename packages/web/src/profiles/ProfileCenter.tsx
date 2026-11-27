import type * as React from 'react'
import { useId, useMemo, useState } from 'react'
import {
  Button,
  CardGrid,
  EmptyState,
  Screen,
  ScreenToolbar,
  SearchBox,
  TabCount,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  useLocationTargets,
  useModelDefaults,
  useProfilesSlice,
  useStoreActions,
} from '../lib/store-context.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
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
  const panelId = useId()

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
  const isCreatingNew = selectedProfileId === 'new' && selectedProfile === null
  const isDrawerOpen = isCreatingNew || Boolean(selectedProfileId && selectedProfile)

  const openCenterTarget = (profileId?: string) => {
    const target = profileId !== undefined ? { kind: 'profiles' as const, profileId } : { kind: 'profiles' as const }
    openTarget(target, isSplit ? { split: true } : undefined)
  }

  const handleSelectProfile = (profileId: string) => {
    openCenterTarget(profileId)
  }

  const handleCreateNew = () => {
    openCenterTarget('new')
  }

  const handleCloseDrawer = () => {
    openCenterTarget(undefined)
  }

  const handleProfileSaved = (saved: Profile) => {
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
    <Screen
      topbar
      dataView="profile-center"
      className={isSplit ? 'is-split' : undefined}
      icon="bot"
      title={t('profiles.center.title')}
      bodyId={panelId}
      bodyRole="tabpanel"
      actions={
        <Button variant="primary" size="sm" icon="plus" onClick={handleCreateNew}>
          <span className="pane-action-label">{t('profiles.center.newProfile')}</span>
        </Button>
      }
      topbarEnd={
        isSplit ? (
          <CloseSplitButton onCloseSplit={onCloseSplit} />
        ) : (
          <SplitToggleButton isSplitActive={isSplitActive} onToggleSplit={toggleSplit} />
        )
      }
      toolbar={
        <ScreenToolbar
          label={t('profiles.center.filterLabel')}
          actions={
            <SearchBox
              variant="toolbar"
              size="sm"
              value={query}
              onChange={setQuery}
              placeholder={t('profiles.center.searchPlaceholder')}
              ariaLabel={t('profiles.center.searchLabel')}
              clearLabel={t('profiles.center.clearSearch')}
            />
          }
        >
          <Tabs
            value={effectiveTab}
            onValueChange={(nextValue) => setActiveTab(nextValue as ProfileCategoryTab)}
            variant="pills"
            size="sm"
          >
            <TabsList aria-label={t('profiles.center.filterLabel')}>
              {pills.map((pill) => (
                <TabsTrigger key={pill.key} value={pill.key} aria-controls={panelId}>
                  <span>{pill.label}</span>
                  <TabCount>{pill.count}</TabCount>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </ScreenToolbar>
      }
      overlays={
        <ProfileDetailDrawer
          profile={selectedProfile}
          isNew={isCreatingNew}
          open={isDrawerOpen}
          onClose={handleCloseDrawer}
          inline={inlineDrawer}
          onSaved={handleProfileSaved}
          onDeleted={handleProfileDeleted}
        />
      }
    >
      {filteredProfiles.length > 0 ? (
        <CardGrid minWidth="md" gap="md">
          {filteredProfiles.map((p) => (
            <ProfileCard
              key={p.id}
              profile={p}
              selected={selectedProfileId === p.id}
              defaultModelInfo={effectiveDefaultModelInfo}
              onSelect={() => handleSelectProfile(p.id)}
            />
          ))}
        </CardGrid>
      ) : (
        <EmptyState
          prominent
          icon="search"
          title={t('profiles.center.emptyTitle')}
          hint={t('profiles.center.emptyHint')}
          action={
            Boolean(query) || effectiveTab !== 'all' ? (
              <Button
                size="sm"
                icon="rotate-ccw"
                onClick={() => {
                  setQuery('')
                  setActiveTab('all')
                }}
              >
                {t('profiles.center.resetFilters')}
              </Button>
            ) : undefined
          }
        />
      )}
    </Screen>
  )
}
