/**
 * Shared full-screen primary-stage shell and search/filter toolbar primitives
 * for the five System Centers (Profiles, Plugins, Skills, Nodes, Models).
 * Empty states are rendered directly via `@helmx/plugin-client` `<EmptyState prominent />`.
 * Zero Emoji; Fast Refresh compliant (components & types only).
 */
import * as React from 'react'
import { Badge, HelmxIcon, SearchBox, Tabs, TabsList, TabsTrigger } from '@helmx/plugin-client'
import { CloseSplitButton, SplitToggleButton } from './SplitControls.js'

const SystemCenterPanelContext = React.createContext<string | undefined>(undefined)

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
  /** Explicit tabpanel ID for aria-controls; defaults to enclosing SystemCenterShell panel ID. */
  controlsId?: string
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
  controlsId,
}: SystemCenterToolbarProps<K>): React.JSX.Element {
  const inheritedControlsId = React.useContext(SystemCenterPanelContext)
  const resolvedControlsId = controlsId ?? inheritedControlsId
  return (
    <div className={className ? `primary-center-toolbar ${className}` : 'primary-center-toolbar'}>
      {leading}
      <SearchBox
        variant="toolbar"
        value={query}
        onChange={onQueryChange}
        placeholder={searchPlaceholder}
        ariaLabel={searchAriaLabel}
        clearLabel={clearSearchLabel}
      />
      <Tabs
        value={activePill}
        onValueChange={(nextValue) => onSelectPill(nextValue as K)}
        variant="pills"
      >
        <TabsList aria-label={filterAriaLabel}>
          {pills.map((pill) => (
            <TabsTrigger key={pill.key} value={pill.key} aria-controls={resolvedControlsId}>
              <span>{pill.label}</span>
              <Badge className="tabular-nums">{pill.count}</Badge>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
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
  const panelId = React.useId()
  const rootClass = `primary-center${className ? ` ${className}` : ''}${isSplit ? ' is-split' : ''}`
  return (
    <SystemCenterPanelContext.Provider value={wrapContent ? panelId : undefined}>
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
        {wrapContent ? (
          <div id={panelId} role="tabpanel" className="primary-center-content">
            {children}
          </div>
        ) : (
          children
        )}
        {overlays}
      </div>
    </SystemCenterPanelContext.Provider>
  )
}
