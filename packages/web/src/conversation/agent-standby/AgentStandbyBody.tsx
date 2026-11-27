/**
 * Body of the standby pane below the top bar: profile load states (error / loading /
 * missing / not human-selectable), otherwise the ready content passed as children.
 */
import type { ReactNode } from 'react'
import type { Profile } from '@helmx/protocol/browser'
import { Button, HelmxIcon } from '@helmx/plugin-client'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import { useStoreActions } from '../../lib/store-context.js'

export interface AgentStandbyBodyProps {
  profileId: string
  profilesLoadError: string | undefined
  assetsLoaded: boolean
  profile: Profile | undefined
  humanSelectable: boolean
  /** Ready content (profile picker, starters, shortcuts); mounted only once the profile is usable. */
  children: ReactNode
}

export function AgentStandbyBody({ profileId, profilesLoadError, assetsLoaded, profile, humanSelectable, children }: AgentStandbyBodyProps) {
  const { openTarget, refreshAssets } = useStoreActions()
  const { t } = useWebLocale()
  return (
    <div className="agent-standby-body">
      {profilesLoadError !== undefined ? (
        <div className="timeline-empty-state" role="alert">
          <HelmxIcon name="alert-triangle" size={20} />
          <span>{t('composer.standby.profileLoadFailed', { error: profilesLoadError })}</span>
          <Button size="sm" onClick={() => void refreshAssets()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : !assetsLoaded ? (
        <div className="timeline-empty-state" role="status">
          <HelmxIcon name="loader" size={20} className="spin-slow" />
          <span>{t('composer.standby.loadingProfile')}</span>
        </div>
      ) : profile === undefined ? (
        <div className="timeline-empty-state" role="alert">
          <HelmxIcon name="circle-slash" size={20} />
          <span>{t('composer.standby.profileMissing', { profileId })}</span>
          <Button size="sm" onClick={() => openTarget({ kind: 'profiles' })}>
            {t('composer.standby.goToProfiles')}
          </Button>
        </div>
      ) : !humanSelectable ? (
        <div className="timeline-empty-state" role="alert">
          <HelmxIcon name="lock" size={20} />
          <span>{t('composer.standby.notHumanSelectable')}</span>
        </div>
      ) : (
        children
      )}
    </div>
  )
}
