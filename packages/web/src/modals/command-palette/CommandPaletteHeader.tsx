import React from 'react'
import { Badge, Button, DialogClose, HelmxIcon, SearchBox } from '@helmx/plugin-client'
import { useWebLocale } from '../../i18n/use-web-locale.js'

export interface CommandPaletteHeaderProps {
  query: string
  onQueryChange: (next: string) => void
  searching: boolean
  listboxId: string
  ariaExpanded: boolean
  activeDescendantId: string | undefined
  attachInputRef: (el: HTMLInputElement | null) => void
  /** 清除按钮：重置选中并把焦点放回输入框。 */
  onCleared: () => void
}

/** 顶部搜索区：combobox 语义搜索框、检索中状态与关闭按钮（桌面 Esc 徽章 / 移动端关闭文案）。 */
export function CommandPaletteHeader({
  query,
  onQueryChange,
  searching,
  listboxId,
  ariaExpanded,
  activeDescendantId,
  attachInputRef,
  onCleared,
}: CommandPaletteHeaderProps): React.JSX.Element {
  const { t } = useWebLocale()
  return (
    <div className="modal-header palette-header">
      <div className="palette-search-wrap">
        <SearchBox
          className="search-box palette-search-box"
          icon={<HelmxIcon name="search" size={15} />}
          clearable
          clearLabel={t('modals.palette.clearSearch')}
          onCleared={onCleared}
          inputRef={attachInputRef}
          inputRole="combobox"
          ariaAutocomplete="list"
          ariaControls={listboxId}
          ariaExpanded={ariaExpanded}
          {...(activeDescendantId !== undefined ? { ariaActiveDescendant: activeDescendantId } : {})}
          ariaLabel={t('modals.palette.searchAria')}
          placeholder={t('modals.palette.searchPlaceholder')}
          value={query}
          onChange={onQueryChange}
        />
      </div>
      {searching && (
        <span className="palette-searching" role="status">
          <HelmxIcon name="loader" size={12} className="spin-slow" />
          {t('modals.palette.searching')}
        </span>
      )}
      <DialogClose asChild>
        <Button
          variant="ghost"
          size="xs"
          className="palette-close-btn"
          aria-label={t('common.close')}
        >
          <Badge tone="neutral" className="palette-close-desktop">{t('modals.palette.escToClose')}</Badge>
          <span className="palette-close-mobile">
            <HelmxIcon name="x" size={13} />
            <span className="palette-close-mobile-label">{t('common.close')}</span>
          </span>
        </Button>
      </DialogClose>
    </div>
  )
}
