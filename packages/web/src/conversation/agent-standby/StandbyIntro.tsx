/**
 * Ready content of the standby body: profile picker with hint, zero-model call to action,
 * starter prompts, and the shortcut hints (including the focus-return discipline the picker
 * and its fallback rely on).
 */
import { useCallback, type RefObject } from 'react'
import type { Profile } from '@helmx/protocol/browser'
import {
  Button,
  HelmxIcon,
  Stack,
  type HelmxShortcutEventDetail,
} from '@helmx/plugin-client'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import { useStoreActions } from '../../lib/store-context.js'
import { formatModShiftShortcut, formatModShortcut } from '../../shell/shortcuts-model.js'
import { useIsMobile } from '../composer-model.js'
import { COMPOSER_SHORTCUTS } from '../keybindings-model.js'
import { StandbyProfilePicker } from '../StandbyProfilePicker.js'
import { isCoarseTouchViewport, type StandbyProfileOption } from '../standby-model.js'

const HELMX_SHORTCUT_EVENT = 'helmx:shortcut' as const

export interface StandbyIntroProps {
  panel: 'primary' | 'split'
  profileId: string
  label: string
  isSplit?: boolean
  profile: Profile
  showZeroModelCta: boolean
  canSwitchProfile: boolean
  currentRemoteNodeId: string | null
  standbyProfileOptions: ReadonlyArray<StandbyProfileOption>
  sending: boolean
  textareaRef: RefObject<HTMLTextAreaElement | null>
  onSwitchProfile: (nextProfileId: string, closePicker?: () => void) => void
  onApplyStarter: (prompt: string) => void
}

export function StandbyIntro({
  panel,
  profileId,
  label,
  isSplit,
  profile,
  showZeroModelCta,
  canSwitchProfile,
  currentRemoteNodeId,
  standbyProfileOptions,
  sending,
  textareaRef,
  onSwitchProfile,
  onApplyStarter,
}: StandbyIntroProps) {
  const { openTarget } = useStoreActions()
  const { t } = useWebLocale()
  const isMobile = useIsMobile(680)

  const returnFocusToStandbyTextarea = useCallback(
    (explicit = false): boolean => {
      if (!explicit && (isMobile || isCoarseTouchViewport())) return false
      const el = textareaRef.current
      if (el === null || !el.isConnected) return false
      el.focus({ preventScroll: true })
      return true
    },
    [isMobile],
  )

  const focusStandbyTextareaFallback = useCallback((): void => {
    textareaRef.current?.focus({ preventScroll: true })
  }, [])

  const openAllShortcuts = useCallback((): void => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(
      new CustomEvent<HelmxShortcutEventDetail>(HELMX_SHORTCUT_EVENT, {
        detail: { action: 'open-shortcuts', panel },
      }),
    )
  }, [panel])

  return (
    <>
      <div className="agent-standby-intro">
        <StandbyProfilePicker
          profileId={profileId}
          label={label}
          remoteNodeId={currentRemoteNodeId}
          options={standbyProfileOptions}
          canSwitch={canSwitchProfile}
          panel={panel}
          onSelectProfile={onSwitchProfile}
          onReturnFocus={returnFocusToStandbyTextarea}
          onFallbackFocusComposer={focusStandbyTextareaFallback}
        />
        <span className="agent-standby-intro-hint">{t('composer.standby.introHint')}</span>
      </div>
      {showZeroModelCta ? (
        <div className="callout callout-warn" role="status">
          <HelmxIcon name="alert-triangle" size={14} />
          <Stack gap="xs" className="flex-1">
            <strong>{t('composer.standby.noModelsTitle')}</strong>
            <span className="callout-text">{t('composer.standby.noModelsHint')}</span>
            <div>
              <Button
                variant="primary"
                size="xs"
                icon="key"
                onClick={() => openTarget({ kind: 'models' }, isSplit ? { split: true } : undefined)}
              >
                {t('composer.standby.configureModels')}
              </Button>
            </div>
          </Stack>
        </div>
      ) : null}
      {profile.starters !== undefined && profile.starters.length > 0 ? (
        <div className="timeline-starters">
          {profile.starters.map((starter, index) => (
            <button
              key={`starter-${index}-${starter.label}`}
              type="button"
              className="timeline-starter-btn"
              title={starter.prompt}
              disabled={sending}
              onClick={() => onApplyStarter(starter.prompt)}
            >
              <HelmxIcon name="corner-down-right" size={11} />
              <span className="timeline-starter-label">{starter.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      {!showZeroModelCta ? (
        <div className="agent-standby-shortcuts" aria-label={t('composer.standby.shortcutsAria')}>
          {canSwitchProfile ? (
            <span className="agent-standby-shortcut-item">
              <kbd className="kbd-hint">{formatModShiftShortcut('O')}</kbd>
              <span>{t('composer.standby.shortcutProfile')}</span>
            </span>
          ) : null}
          <span className="agent-standby-shortcut-item">
            <kbd className="kbd-hint">{formatModShortcut('K')}</kbd>
            <span>{t('composer.standby.shortcutSearch')}</span>
          </span>
          <span className="agent-standby-shortcut-item">
            <kbd className="kbd-hint">{COMPOSER_SHORTCUTS.toggleModelPicker}</kbd>
            <span>{t('composer.standby.shortcutModel')}</span>
          </span>
          <span className="agent-standby-shortcut-item">
            <kbd className="kbd-hint">/</kbd>
            <span>{t('composer.standby.shortcutCommands')}</span>
          </span>
          <button
            type="button"
            className="btn-inline agent-standby-shortcuts-all"
            onClick={openAllShortcuts}
          >
            <span>{t('composer.standby.shortcutAll')}</span>
            <kbd className="kbd-hint">{formatModShortcut('/')}</kbd>
          </button>
        </div>
      ) : null}
    </>
  )
}
