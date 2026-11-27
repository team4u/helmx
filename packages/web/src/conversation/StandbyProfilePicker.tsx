/**
 * Central standby-stage profile selector (Radix Popover):
 * - renders a static label when only one selectable profile exists or when the
 *   draft is locked (sending / conversation-anchored);
 * - shows a compact search box once candidates exceed STANDBY_PROFILE_SEARCH_THRESHOLD;
 * - responds to panel-scoped `toggle-profile-picker` (second Mod+Shift+O on standby)
 *   and restores focus cleanly to the composer textarea on keyboard/pick close.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  HelmxIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SearchBox,
  usePanelShortcut,
} from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { formatModShiftShortcut } from '../shell/shortcuts-model.js'
import { RemoteNodeTag } from '../shell/SidebarPrimitives.js'
import { useIsMobile } from './composer-model.js'
import {
  STANDBY_PROFILE_SEARCH_THRESHOLD,
  filterStandbyProfileOptions,
  formatStandbyProfileMeta,
  initialStandbyProfileActiveIndex,
  isCoarseTouchViewport,
  stepStandbyProfileIndex,
  type StandbyProfileOption,
} from './standby-model.js'

export interface StandbyProfilePickerProps {
  profileId: string
  label: string
  remoteNodeId: string | null
  options: ReadonlyArray<StandbyProfileOption>
  canSwitch: boolean
  panel: 'primary' | 'split'
  onSelectProfile: (nextProfileId: string, closePicker: () => void) => void
  onReturnFocus: (explicit?: boolean) => boolean
  onFallbackFocusComposer: () => void
}

export function StandbyProfilePicker({
  profileId,
  label,
  remoteNodeId,
  options,
  canSwitch,
  panel,
  onSelectProfile,
  onReturnFocus,
  onFallbackFocusComposer,
}: StandbyProfilePickerProps): ReactNode {
  const { t } = useWebLocale()
  const isMobile = useIsMobile(680)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const interactedOutsideRef = useRef(false)
  const pickedRef = useRef(false)

  const showSearch = options.length > STANDBY_PROFILE_SEARCH_THRESHOLD
  const filtered = useMemo(
    () => (open ? filterStandbyProfileOptions(options, query) : []),
    [open, options, query],
  )
  const filteredKeys = useMemo(
    () => filtered.map((opt) => opt.profileId).join('\0'),
    [filtered],
  )
  const latestFilteredRef = useRef(filtered)
  latestFilteredRef.current = filtered

  useEffect(() => {
    if (!canSwitch) setOpen(false)
  }, [canSwitch])

  useEffect(() => {
    setQuery('')
    if (open) {
      interactedOutsideRef.current = false
      pickedRef.current = false
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      setActiveIndex(-1)
      return
    }
    setActiveIndex(initialStandbyProfileActiveIndex(latestFilteredRef.current, profileId, query))
  }, [open, query, filteredKeys, profileId])

  useEffect(() => {
    if (!open || activeIndex < 0) return
    itemRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeIndex])

  usePanelShortcut(
    rootRef,
    'toggle-profile-picker',
    () => {
      if (!canSwitch) {
        setOpen(false)
        onFallbackFocusComposer()
        return
      }
      setOpen((prev) => !prev)
    },
    panel,
  )

  const handlePick = (nextProfileId: string): void => {
    pickedRef.current = true
    if (nextProfileId !== profileId) {
      onSelectProfile(nextProfileId, () => setOpen(false))
      return
    }
    setOpen(false)
  }

  const handlePopoverKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((prev) => stepStandbyProfileIndex(prev, filtered.length, 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((prev) => stepStandbyProfileIndex(prev, filtered.length, -1))
    } else if ((event.key === 'Home' || event.key === 'End') && filtered.length > 0) {
      if (document.activeElement !== searchInputRef.current) {
        event.preventDefault()
        setActiveIndex(event.key === 'Home' ? 0 : filtered.length - 1)
      }
    } else if (event.key === 'Enter') {
      const chosen = filtered[activeIndex] ?? (filtered.length === 1 ? filtered[0] : undefined)
      if (chosen !== undefined) {
        event.preventDefault()
        event.stopPropagation()
        handlePick(chosen.profileId)
      }
    }
  }

  return (
    <div ref={rootRef} className="agent-standby-profile-picker">
      {!canSwitch ? (
        <span className="agent-standby-profile-static">
          <HelmxIcon name="bot" size={16} className="agent-standby-profile-icon" />
          <span className="agent-standby-intro-name">{label}</span>
          {remoteNodeId !== null ? <RemoteNodeTag nodeId={remoteNodeId} /> : null}
        </span>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="agent-standby-profile-trigger"
              aria-label={t('composer.standby.switchProfileAria', { name: label })}
              title={t('composer.standby.switchProfileTitleWithShortcut', {
                shortcut: formatModShiftShortcut('O'),
              })}
              aria-haspopup="dialog"
              aria-expanded={open}
            >
              <HelmxIcon name="bot" size={15} className="agent-standby-profile-icon" />
              <span className="agent-standby-profile-trigger-label">{label}</span>
              {remoteNodeId !== null ? <RemoteNodeTag nodeId={remoteNodeId} /> : null}
              <HelmxIcon name="chevron-down" size={13} className="agent-standby-profile-trigger-chevron" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            portalled
            side="bottom"
            align="center"
            sideOffset={8}
            className="composer-popover agent-standby-profile-popover"
            onKeyDown={handlePopoverKeyDown}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              if (showSearch && !isMobile && !isCoarseTouchViewport()) {
                searchInputRef.current?.focus({ preventScroll: true })
              } else {
                listRef.current?.focus({ preventScroll: true })
              }
            }}
            onInteractOutside={() => {
              interactedOutsideRef.current = true
            }}
            onEscapeKeyDown={(event) => {
              event.stopPropagation()
            }}
            onCloseAutoFocus={(event) => {
              if (interactedOutsideRef.current) {
                interactedOutsideRef.current = false
                pickedRef.current = false
                return
              }
              const picked = pickedRef.current
              pickedRef.current = false
              if (onReturnFocus(picked)) {
                event.preventDefault()
              }
            }}
          >
            {showSearch ? (
              <div className="composer-model-search-bar">
                <SearchBox
                  size="sm"
                  clearable={false}
                  clearOnEscape={false}
                  className="search-box composer-model-search-input"
                  inputRef={searchInputRef}
                  ariaLabel={t('composer.standby.searchProfilesAria')}
                  placeholder={t('composer.standby.searchProfilesPlaceholder')}
                  value={query}
                  onChange={setQuery}
                />
              </div>
            ) : null}
            <div className="popover-header">
              <span>{t('composer.standby.switchProfileHeader')}</span>
              <span className="kbd-hint popover-kbd-hint">{t('composer.kbd.navConfirm')}</span>
            </div>
            <div
              ref={listRef}
              tabIndex={-1}
              role="listbox"
              aria-label={t('composer.standby.switchProfileHeader')}
              className="agent-standby-profile-list"
            >
              {filtered.length === 0 ? (
                <div className="popover-item composer-model-empty">
                  {t('composer.standby.noMatchingProfiles')}
                </div>
              ) : (
                filtered.map((opt, idx) => {
                  const selected = opt.profileId === profileId
                  const active = idx === activeIndex
                  const meta = formatStandbyProfileMeta(opt)
                  return (
                    <button
                      key={opt.profileId}
                      ref={(node) => {
                        itemRefs.current[idx] = node
                      }}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      data-profile-id={opt.profileId}
                      data-active={selected ? 'true' : undefined}
                      className={`popover-item agent-standby-profile-item${active ? ' popover-item-active' : ''}`}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onFocus={() => setActiveIndex(idx)}
                      onClick={() => handlePick(opt.profileId)}
                    >
                      <span className="agent-standby-profile-item-main">
                        <span className="agent-standby-profile-item-head">
                          <HelmxIcon name="bot" size={13} className="agent-standby-profile-icon" />
                          <span className="agent-standby-profile-item-label">{opt.label}</span>
                          {opt.remoteNodeId !== null ? <RemoteNodeTag nodeId={opt.remoteNodeId} /> : null}
                        </span>
                        {meta !== '' ? (
                          <span className="agent-standby-profile-item-meta" title={meta}>
                            {meta}
                          </span>
                        ) : null}
                      </span>
                      {selected ? (
                        <HelmxIcon name="check" size={13} className="agent-standby-profile-item-check" />
                      ) : null}
                    </button>
                  )
                })
              )}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
