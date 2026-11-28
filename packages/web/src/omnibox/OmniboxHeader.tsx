import React from 'react'
import { Badge, Button, DialogClose, HelmxIcon, LoadingState, SearchBox } from '@helmx/ui'
import { useWebLocale } from '../i18n/use-web-locale.js'

export interface OmniboxHeaderProps {
  query: string
  onQueryChange: (next: string) => void
  searching: boolean
  listboxId: string
  ariaExpanded: boolean
  activeDescendantId: string | undefined
  attachInputRef: (el: HTMLInputElement | null) => void
  onCleared: () => void
}

export function OmniboxHeader({
  query,
  onQueryChange,
  searching,
  listboxId,
  ariaExpanded,
  activeDescendantId,
  attachInputRef,
  onCleared,
}: OmniboxHeaderProps): React.JSX.Element {
  const { t } = useWebLocale()
  return (
    <div className="palette-header">
      <div className="palette-search-wrap">
        <SearchBox
          surface="frameless"
          className="palette-search-box"
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
        <LoadingState label={t('modals.palette.searching')} iconSize={12} className="palette-searching" />
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
