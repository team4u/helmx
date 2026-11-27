import React from 'react'
import type { Profile } from './profile-center-model.js'
import {
  formatProfileLocation,
  formatShortModelName,
  isSystemProfile,
  resolveEffectiveProfileModel,
  summarizeProfileActivity,
} from './profile-center-model.js'
import {
  Badge,
  Button,
  HelmxIcon,
  SelectCard,
  Stack,
  StatusLight,
  useHostModels,
  type StatusLightTone,
} from '@helmx/plugin-client'
import {
  useOptionalConversations,
  useOptionalPlugins,
  useOptionalStoreActions,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { openStandbyWithFocus } from '../conversation/standby-focus.js'

export interface ProfileCardProps {
  profile: Profile
  selected?: boolean
  onSelect: () => void
  /** Optional: global default model info (parent supplies the fetched /api/models/default result). */
  defaultModelInfo?: { defaultModel: string; defaultThinkingLevel: string } | null
  /** Optional: bottom-right "Conversation" direct action (defaults to store.openTarget -> #/a/<profileId>). */
  onStartChat?: () => void
}

/** Activity state → strongly typed StatusLightTone. */
const ACTIVITY_LIGHT_TONE: Record<
  'working' | 'blocked' | 'error' | 'plugin-disabled' | 'active' | 'idle',
  StatusLightTone
> = {
  working: 'working',
  blocked: 'blocked',
  error: 'failed',
  'plugin-disabled': 'idle',
  active: 'working',
  idle: 'idle',
}

/**
 * Agent profile card:
 * - built on SelectCard (<article> + <button aria-pressed> + sibling footer),
 *   compactly showing the profile name/ID, system lock, activity state,
 *   effective model (with thinking level / global-inheritance markers), node
 *   and working directory, skill count, and the bottom-right direct-conversation
 *   button;
 * - follows the zero-emoji and zero-inline-style rules strictly.
 */
export function ProfileCard({
  profile,
  selected = false,
  onSelect,
  defaultModelInfo,
  onStartChat,
}: ProfileCardProps): React.JSX.Element {
  const storeConversations = useOptionalConversations()
  const storePlugins = useOptionalPlugins()
  const actions = useOptionalStoreActions()
  const { t } = useWebLocale()
  const isSystem = isSystemProfile(profile)
  const hostModels = useHostModels()
  const effectiveModel = resolveEffectiveProfileModel(profile, defaultModelInfo, hostModels)
  const location = formatProfileLocation(profile)
  const activity = summarizeProfileActivity(
    profile,
    storeConversations ?? [],
    storePlugins ?? [],
    t,
  )
  const displayName = profile.name || profile.id

  const skillsLabel =
    profile.skills === undefined
      ? t('profiles.card.allSkills')
      : t('profiles.card.skillsCount', { count: profile.skills.length })

  const handleChatClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (activity.managingPluginDisabled) return
    if (onStartChat) {
      onStartChat()
      return
    }
    openStandbyWithFocus(
      { panel: 'primary', profileId: profile.id },
      () => actions?.openTarget({ kind: 'agent', profileId: profile.id }),
    )
  }

  const shortModelName = formatShortModelName(effectiveModel.model)

  const thinkingSuffix = effectiveModel.thinkingLevel
    ? t('profiles.card.thinkingSuffix', { level: effectiveModel.thinkingLevel })
    : ''
  const modelTitle = effectiveModel.model
    ? effectiveModel.source === 'bound'
      ? t('profiles.card.boundModel', { model: effectiveModel.model }) + thinkingSuffix
      : t('profiles.card.inheritModel', { model: effectiveModel.model }) + thinkingSuffix
    : t('profiles.card.followGlobalTitle')

  const locationText = location.cwd
    ? `${location.nodeId} · ${location.cwd}`
    : t('profiles.card.defaultCwd', { nodeId: location.nodeId })

  return (
    <SelectCard
      data-profile-id={profile.id}
      selected={selected}
      onSelect={onSelect}
      title={<span title={displayName}>{displayName}</span>}
      badges={
        <>
          {isSystem && (
            <Badge tone="neutral" mono icon="lock" title={t('profiles.card.systemPillTitle')}>
              {t('profiles.card.systemPill')}
            </Badge>
          )}
          <StatusLight
            tone={ACTIVITY_LIGHT_TONE[activity.stateKind]}
            label={activity.stateLabel}
            className="tabular-nums"
          />
        </>
      }
      subtitle={<span className="mono break-word">{profile.id}</span>}
      description={
        <span title={profile.description || undefined}>
          {profile.description || t('profiles.card.noDescription')}
        </span>
      }
      footer={
        <>
          <span className="text-subtle tabular-nums">
            {activity.conversationCount > 0
              ? t('profiles.card.linkedConversations', { count: activity.conversationCount })
              : t('profiles.card.noLinkedConversations')}
          </span>
          <Button
            size="sm"
            icon="message-square"
            disabled={activity.managingPluginDisabled}
            title={
              activity.managingPluginDisabled
                ? t('profiles.card.chatDisabledTitle')
                : t('profiles.card.startConversationTitle', { name: displayName })
            }
            onClick={handleChatClick}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {t('profiles.card.conversationAction')}
          </Button>
        </>
      }
    >
      <Stack direction="vertical" gap="xs">
        <Stack
          direction="horizontal"
          gap="xs"
          align="start"
          className="profile-card-location text-subtle mono"
          title={t('profiles.card.locationTitle', { location: locationText })}
        >
          <HelmxIcon name={location.isRemoteNode ? 'server' : 'laptop'} size={11} />
          <span className="break-word">{locationText}</span>
        </Stack>

        <Stack direction="horizontal" gap="xs" align="center" wrap className="profile-card-pills">
          {shortModelName ? (
            <Badge tone="neutral" mono icon="cpu" title={modelTitle}>
              <span className="profile-card-pill-inner">
                <span className="profile-card-pill-label">{shortModelName}</span>
                {effectiveModel.thinkingLevel && (
                  <span className="profile-card-pill-suffix">· {effectiveModel.thinkingLevel}</span>
                )}
              </span>
            </Badge>
          ) : (
            <Badge tone="neutral" icon="cpu" title={modelTitle}>
              <span className="profile-card-pill-label">{t('profiles.card.followGlobalDefault')}</span>
            </Badge>
          )}
          {effectiveModel.source === 'global' && (
            <Badge
              tone="neutral"
              title={t('profiles.card.inheritModel', { model: effectiveModel.model ?? '' })}
            >
              {t('profiles.card.globalDefault')}
            </Badge>
          )}
          <Badge tone="neutral" icon="wrench" title={t('profiles.card.skillsTitle', { label: skillsLabel })}>
            {skillsLabel}
          </Badge>
        </Stack>
      </Stack>
    </SelectCard>
  )
}
