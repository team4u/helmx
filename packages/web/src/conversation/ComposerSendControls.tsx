import type { WhenBusy } from '@helmx/protocol/browser'
import {
  Button,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  HelmxIcon,
  IconButton,
  Tooltip,
} from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useIsMobile, type SessionEnvBlocker } from './composer-model.js'

// ---------------------------------------------------------------------------
// Send / stop controls (extracted from Composer.tsx): idle send, busy stop and
// the steer/queue split. Desktop keeps the split dropdown (with .kbd-hint
// badges); on mobile with input present while busy, two explicit side-by-side
// buttons [steer] and [queue] render instead of a shortcut to memorize.
// ---------------------------------------------------------------------------

export interface ComposerSendControlsProps {
  working: boolean
  editingEntryId: number | null
  sending: boolean
  uploading: number
  commandRunning?: boolean
  envBlocker: SessionEnvBlocker
  text: string
  isMobile?: boolean
  send: (busyMode?: WhenBusy, strict?: boolean) => Promise<void>
  abortTurn: () => Promise<void>
}

export function ComposerSendControls({
  working,
  editingEntryId,
  sending,
  uploading,
  commandRunning = false,
  envBlocker,
  text,
  isMobile,
  send,
  abortTurn,
}: ComposerSendControlsProps) {
  const { t } = useWebLocale()
  const detectedMobile = useIsMobile(680)
  const mobile = isMobile ?? detectedMobile
  const inFlight = sending || uploading > 0 || commandRunning
  const busyDisabled = inFlight || envBlocker.blocked

  return (
    <span className="composer-toolbar-right">
      {!working || editingEntryId !== null ? (
        <IconButton
          variant="primary"
          size="md"
          pill
          pending={inFlight}
          disabled={envBlocker.blocked || text.trim() === ''}
          className="btn-send"
          icon={<HelmxIcon name="arrow-up" size={18} />}
          onClick={() => void send()}
          title={editingEntryId !== null
            ? working
              ? t('composer.sendControls.updateWorkingTitle')
              : t('composer.sendControls.updateTitle')
            : envBlocker.blocked
              ? envBlocker.reason ?? t('composer.env.saveOrCancelFirst')
              : t('composer.sendControls.sendTitle')}
          aria-label={
            editingEntryId !== null
              ? t('composer.sendControls.updateShort')
              : uploading > 0
                ? t('composer.sendControls.uploading', { count: uploading })
                : commandRunning
                  ? t('composer.command.runningAria')
                  : t('composer.sendControls.send')
          }
        />
      ) : text.trim() === '' ? (
        <Tooltip content={t('composer.sendControls.stopExecution')} side="top">
          <IconButton
            variant="danger"
            size="md"
            pill
            className="btn-send composer-abort-button"
            icon={<HelmxIcon name="square" size={14} />}
            onClick={() => void abortTurn()}
            aria-label={t('composer.sendControls.stopExecution')}
          />
        </Tooltip>
      ) : mobile ? (
        <div className="composer-busy-mobile-actions">
          <IconButton
            variant="danger"
            size="sm"
            pill
            className="composer-abort-button"
            icon={<HelmxIcon name="square" size={12} />}
            onClick={() => void abortTurn()}
            label={t('composer.sendControls.stopExecution')}
          />
          <Button
            variant="primary"
            size="sm"
            icon="corner-down-right"
            pending={inFlight}
            disabled={busyDisabled}
            className="composer-mobile-steer-btn composer-steer-action"
            onClick={() => void send('steer')}
            title={t('composer.sendControls.steerHint')}
            aria-label={uploading > 0 ? t('composer.sendControls.uploading', { count: uploading }) : t('composer.sendControls.steer')}
          >
            {t('composer.sendControls.steerShort')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon="clock"
            disabled={busyDisabled}
            className="composer-mobile-queue-btn"
            onClick={() => void send('followUp')}
            title={t('composer.sendControls.queueHint')}
            aria-label={t('composer.sendControls.queueSend')}
          >
            {t('composer.sendControls.queue')}
          </Button>
        </div>
      ) : (
        <DropdownMenuRoot>
          <div className="composer-split-send">
            <button
              type="button"
              className="composer-split-main composer-steer-action"
              disabled={busyDisabled}
              onClick={() => void send('steer')}
              title={t('composer.sendControls.steerHintEnter')}
              aria-label={uploading > 0 ? t('composer.sendControls.uploading', { count: uploading }) : editingEntryId !== null ? t('composer.sendControls.updateShort') : t('composer.sendControls.steer')}
            >
              <HelmxIcon
                name={inFlight ? 'loader' : 'corner-down-right'}
                size={14}
                className={inFlight ? 'spin-slow' : undefined}
              />
              <span className="composer-action-label">{editingEntryId !== null ? t('composer.sendControls.updateLabel') : t('composer.sendControls.insertLabel')}</span>
            </button>
            <div className="composer-split-divider" />
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="composer-split-trigger"
                disabled={busyDisabled}
                aria-label={t('composer.sendControls.chooseStrategy')}
                title={t('composer.sendControls.chooseStrategyTitle')}
              >
                <HelmxIcon name="chevron-down" size={12} />
              </button>
            </DropdownMenuTrigger>
          </div>
          <DropdownMenuContent portalled align="end" side="top" sideOffset={6} className="composer-busy-dropdown-content">
            <DropdownMenuItem
              className="composer-busy-menu-item"
              onClick={() => void send('steer')}
            >
              <HelmxIcon name="corner-down-right" size={14} className="composer-busy-menu-icon" />
              <div className="composer-busy-menu-text">
                <div className="composer-busy-menu-title">{t('composer.sendControls.steer')}</div>
                <div className="composer-busy-menu-desc">{t('composer.sendControls.steerHint')}</div>
              </div>
              <span className="composer-busy-menu-kbd kbd-hint">Enter</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="composer-busy-menu-item composer-queue-button"
              onClick={() => void send('followUp')}
              title={t('composer.sendControls.queueHintKbd')}
              aria-label={t('composer.sendControls.queueSend')}
            >
              <HelmxIcon name="clock" size={14} className="composer-busy-menu-icon" />
              <div className="composer-busy-menu-text">
                <div className="composer-busy-menu-title">{t('composer.sendControls.queueSend')}</div>
                <div className="composer-busy-menu-desc">{t('composer.sendControls.queueHint')}</div>
              </div>
              <span className="composer-busy-menu-kbd kbd-hint">⌘/Ctrl+Enter</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              danger
              className="composer-busy-menu-item"
              onClick={() => void abortTurn()}
              title={t('composer.sendControls.stopExecution')}
              aria-label={t('composer.sendControls.stopExecution')}
            >
              <HelmxIcon name="square" size={13} className="composer-busy-menu-icon" />
              <div className="composer-busy-menu-text">
                <div className="composer-busy-menu-title">{t('composer.sendControls.stopMenuTitle')}</div>
                <div className="composer-busy-menu-desc">{t('composer.sendControls.abortNow')}</div>
              </div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuRoot>
      )}
    </span>
  )
}
