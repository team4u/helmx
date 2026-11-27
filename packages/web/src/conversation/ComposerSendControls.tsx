import type { WhenBusy } from '@helmx/protocol/browser'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  HelmxIcon,
  IconButton,
  Kbd,
  Tooltip,
} from '@helmx/ui'
import { useWebLocale } from '../i18n/use-web-locale.js'
import type { SessionEnvBlocker } from './composer-model.js'

// ---------------------------------------------------------------------------
// Send / stop controls (extracted from Composer.tsx): unified across desktop
// and mobile with zero viewport forks. Idle/editing renders the circular send
// button; busy with empty input renders the circular stop button; busy with
// input renders an always-visible circular stop button alongside the split
// [Steer | v] capsule whose dropdown offers Steer (Enter) and Queue send
// (Cmd/Ctrl+Enter).
// ---------------------------------------------------------------------------

export interface ComposerSendControlsProps {
  working: boolean
  editingEntryId: number | null
  sending: boolean
  uploading: number
  commandRunning?: boolean
  envBlocker: SessionEnvBlocker
  text: string
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
  send,
  abortTurn,
}: ComposerSendControlsProps) {
  const { t } = useWebLocale()
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
      ) : (
        <div className="composer-busy-actions">
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
          <DropdownMenuRoot>
            <div className="composer-split-send">
              <button
                type="button"
                className="composer-split-main composer-steer-action"
                disabled={busyDisabled}
                onClick={() => void send('steer')}
                title={t('composer.sendControls.steerHintEnter')}
                aria-label={
                  uploading > 0
                    ? t('composer.sendControls.uploading', { count: uploading })
                    : t('composer.sendControls.steer')
                }
              >
                <HelmxIcon
                  name={inFlight ? 'loader' : 'corner-down-right'}
                  size={14}
                  className={inFlight ? 'spin-slow' : undefined}
                />
                <span className="composer-action-label">{t('composer.sendControls.steerShort')}</span>
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
                icon="corner-down-right"
                description={t('composer.sendControls.steerHint')}
                shortcut={<Kbd size="sm" desktopOnly>Enter</Kbd>}
                onClick={() => void send('steer')}
              >
                {t('composer.sendControls.steer')}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="composer-queue-button"
                icon="clock"
                description={t('composer.sendControls.queueHint')}
                shortcut={<Kbd size="sm" desktopOnly>⌘/Ctrl+Enter</Kbd>}
                onClick={() => void send('followUp')}
                title={t('composer.sendControls.queueHintKbd')}
                aria-label={t('composer.sendControls.queueSend')}
              >
                {t('composer.sendControls.queueSend')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuRoot>
        </div>
      )}
    </span>
  )
}
