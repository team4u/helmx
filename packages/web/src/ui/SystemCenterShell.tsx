/**
 * Shared full-screen primary-stage shell, search/filter toolbar, and empty
 * state primitives for the five System Centers (Profiles, Plugins, Skills,
 * Nodes, Models). Zero Emoji; Fast Refresh compliant (components & types only).
 */
import type * as React from 'react'
import { HelmxIcon, SearchBox } from '@helmx/plugin-client'
import { CloseSplitButton, SplitToggleButton } from './SplitControls.js'

export interface SystemCenterCategoryPill<K extends string = string> {
  key: K
  label: string
  count: number
}

export interface SystemCenterToolbarProps<K extends string = string> {
  className?: string
  leading?: React.ReactNode
  query: string
  onQueryChange: (value: string) => void
  searchPlaceholder: string
  searchAriaLabel: string
  clearSearchLabel: string
  filterAriaLabel: string
  pills: ReadonlyArray<SystemCenterCategoryPill<K>>
  activePill: K
  onSelectPill: (key: K) => void
}

export function SystemCenterToolbar<K extends string = string>({
  className,
  leading,
  query,
  onQueryChange,
  searchPlaceholder,
  searchAriaLabel,
  clearSearchLabel,
  filterAriaLabel,
  pills,
  activePill,
  onSelectPill,
}: SystemCenterToolbarProps<K>): React.JSX.Element {
  return (
    <div className={className ? `primary-center-toolbar ${className}` : 'primary-center-toolbar'}>
      {leading}
      <SearchBox
        className="primary-search-box"
        clearButtonClassName="btn btn-ghost btn-sm primary-search-clear"
        value={query}
        onChange={onQueryChange}
        placeholder={searchPlaceholder}
        ariaLabel={searchAriaLabel}
        clearLabel={clearSearchLabel}
      />
      <div className="primary-category-pills" role="tablist" aria-label={filterAriaLabel}>
        {pills.map((pill) => {
          const isActive = activePill === pill.key
          return (
            <button
              key={pill.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`primary-category-pill${isActive ? ' is-active' : ''}`}
              onClick={() => onSelectPill(pill.key)}
            >
              <span>{pill.label}</span>
              <span className="badge tabular-nums">{pill.count}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export interface SystemCenterEmptyProps {
  icon?: string
  iconSize?: number
  title: string
  hint: string
  hintSubtle?: boolean
  showReset?: boolean
  resetLabel?: string
  resetIcon?: boolean
  resetButtonClassName?: string
  onReset?: () => void
}

export function SystemCenterEmpty({
  icon = 'search',
  iconSize = 28,
  title,
  hint,
  hintSubtle = false,
  showReset = false,
  resetLabel,
  resetIcon = true,
  resetButtonClassName = 'btn btn-sm',
  onReset,
}: SystemCenterEmptyProps): React.JSX.Element {
  return (
    <div className="primary-center-empty">
      <div className="primary-center-empty-icon">
        <HelmxIcon name={icon} size={iconSize} />
      </div>
      <div className="primary-center-empty-text">{title}</div>
      <div className={hintSubtle ? 'primary-center-empty-hint text-subtle' : 'primary-center-empty-hint'}>
        {hint}
      </div>
      {showReset && onReset !== undefined && resetLabel !== undefined && (
        <button type="button" className={resetButtonClassName} onClick={onReset}>
          {resetIcon && <HelmxIcon name="rotate-ccw" size={12} />}
          <span>{resetLabel}</span>
        </button>
      )}
    </div>
  )
}

export interface SystemCenterShellProps {
  dataView: string
  className?: string
  isSplit?: boolean
  isSplitActive: boolean
  onCloseSplit?: () => void
  onToggleSplit: () => void
  icon: string
  title: string
  headerActions?: React.ReactNode
  belowTopbar?: React.ReactNode
  toolbar?: React.ReactNode
  diagnostics?: React.ReactNode
  /** When true (default), wraps `children` in `.primary-center-content`. */
  wrapContent?: boolean
  children: React.ReactNode
  overlays?: React.ReactNode
}

export function SystemCenterShell({
  dataView,
  className,
  isSplit = false,
  isSplitActive,
  onCloseSplit,
  onToggleSplit,
  icon,
  title,
  headerActions,
  belowTopbar,
  toolbar,
  diagnostics,
  wrapContent = true,
  children,
  overlays,
}: SystemCenterShellProps): React.JSX.Element {
  const rootClass = `primary-center${className ? ` ${className}` : ''}${isSplit ? ' is-split' : ''}`
  return (
    <div className={rootClass} data-view={dataView}>
      <div className="primary-center-topbar pane-topbar">
        <div className="primary-center-title-wrap pane-title-group">
          <div className="primary-center-title">
            <HelmxIcon name={icon} size={14} />
            <span>{title}</span>
          </div>
        </div>
        <div className="primary-center-topbar-actions pane-actions">
          {headerActions}
          {isSplit ? (
            <CloseSplitButton onCloseSplit={onCloseSplit} />
          ) : (
            <SplitToggleButton isSplitActive={isSplitActive} onToggleSplit={onToggleSplit} />
          )}
        </div>
      </div>
      {belowTopbar}
      {toolbar}
      {diagnostics}
      {wrapContent ? <div className="primary-center-content">{children}</div> : children}
      {overlays}
    </div>
  )
}
