/**
 * Lightweight layout primitives shared by plugins (composable, stateless, SSR safe):
 * - All of them reuse the generic design-system classes from the host styles.css
 *   (.screen-container / .screen-header / .screen-toolbar / .helmx-table-wrap /
 *   .helmx-table / .table-empty / .loading-state / .kv-grid, etc.). No new CSS theme is
 *   introduced and there is no opaque columns/data table — structure and cells
 *   are still expressed as JSX;
 * - No document / window access, renderToString works directly. The single
 *   portal is `Screen actions` into the host-provided top bar slot
 *   (`ScreenHostContext.headerActionsSlot`); without a slot the actions render
 *   inline, so SSR and unhosted mounts never touch a Portal;
 * - This file only exports components and TS types (same contract as the host
 *   Fast Refresh rule).
 */
import { Children, Fragment, isValidElement, type AriaRole, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { usePluginTranslator } from './i18n.js'
import { HelmxIcon } from './icons.js'
import { useScreenHost } from './screen-host.js'
import { uiCopy } from './ui-copy.js'
import { EmptyState } from './ui/EmptyState.js'
import { LoadingState } from './ui/LoadingState.js'
import { usePluginScopeId } from './ui/plugin-scope.js'
import { ScreenToolbarContext } from './ui/screen-toolbar-context.js'

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function hasRenderable(node: ReactNode): boolean {
  return node !== undefined && node !== null && typeof node !== 'boolean'
}

// ---------------------------------------------------------------------------
// Screen: unified full-screen page shell (topbar / sticky toolbar / scroll stage)
// ---------------------------------------------------------------------------

/**
 * Page layout mode contract shared between Screen and the host ScreenHost stage:
 * - 'contained' (default): standard centered max-width reading/management flow;
 * - 'full-bleed': edge-to-edge full-width workspace (wide tables, split views, canvases).
 */
export type ScreenLayout = 'contained' | 'full-bleed'

export interface ScreenProps {
  /** Extra container class name (`.screen-container`, or `.helmx-pane.screen-pane` when `topbar` is enabled). */
  className?: string
  /** Extra class name appended to the inner `.screen-container` when `topbar` is enabled. */
  contentClassName?: string
  /** Page layout mode ('contained' default, or 'full-bleed' for edge-to-edge screens). */
  layout?: ScreenLayout
  /**
   * Optional host-pane topbar mode for core full-screen views (System Centers, Overview)
   * that are not mounted inside `ScreenHost`:
   * - `true`: renders `.helmx-pane.screen-pane` + 46px `.pane-topbar` (`icon`, `title`,
   *   `subtitle`, `actions`, `topbarEnd`) + fixed `.screen-toolbar-bar` + `.screen-host-body`;
   * - custom `ReactNode`: renders that node directly as the topbar inside `.helmx-pane.screen-pane`;
   * - omitted / `false` (default): standard `<Screen>` for `ScreenHost` and standalone/SSR views.
   */
  topbar?: boolean | ReactNode
  /** Optional leading icon for the 46px topbar (HelmxIcon name string or custom ReactNode). */
  icon?: string | ReactNode
  /** Page header content (inline mode): defaults to the title/subtitle/actions composition. */
  header?: ReactNode
  /** Main title text; rendered in `.pane-topbar .pane-title` in `topbar={true}` mode. */
  title?: ReactNode
  /** Subtitle text (inline header, or beside the title in `topbar={true}` mode). */
  subtitle?: ReactNode
  /**
   * Action area on the right of the header/topbar (buttons etc.). Inside a host
   * ScreenHost it portals into `.pane-topbar .pane-actions` (before split controls);
   * in `topbar={true}` mode it sits inside `.pane-topbar .pane-actions` before `topbarEnd`;
   * otherwise it sits at the right of the inline `.screen-header`.
   * Ignored when a custom `header` is passed in inline mode.
   */
  actions?: ReactNode
  /**
   * Trailing host controls rendered at the far right of `.pane-topbar .pane-actions`
   * (after `actions`) in `topbar={true}` mode (e.g. split toggle / close-split button).
   */
  topbarEnd?: ReactNode
  /**
   * Fixed single-row toolbar rendered directly below the 46px topbar with a hairline
   * bottom border (`.screen-toolbar-bar`). Inside `ScreenHost` with `toolbarSlot`,
   * portals above `.screen-host-body`; in `topbar` mode renders directly between
   * `.pane-topbar` and `.screen-host-body`; otherwise renders sticky inline (SSR-safe).
   */
  toolbar?: ReactNode
  /** Optional diagnostics / notice banner rendered above the main body content. */
  banner?: ReactNode
  /** Optional overlays (DetailDrawer, Dialog, ConfirmDialog) rendered outside the scroll body. */
  overlays?: ReactNode
  /** Optional `data-view` attribute stamped on the outer root element. */
  dataView?: string
  /** Optional `id` forwarded to the scrollable `.screen-host-body` in `topbar` mode. */
  bodyId?: string
  /** Optional ARIA `role` forwarded to the scrollable `.screen-host-body` in `topbar` mode. */
  bodyRole?: AriaRole
  children?: ReactNode
}

function renderTopbarIcon(icon: string | ReactNode): ReactNode {
  if (typeof icon === 'string') {
    return <HelmxIcon name={icon} size={14} />
  }
  return icon
}

/**
 * Full-screen page shell: unified vertical rhythm, layout width, topbar, sticky
 * hairline toolbar, and scroll stage shared by core centers and plugin screens.
 *
 * When mounted inside the host ScreenHost (`ScreenHostContext.hosted === true`)
 * without a custom `header`, omits the duplicate `.screen-title` structurally,
 * portals `actions` into `headerActionsSlot` and `toolbar` into `toolbarSlot`
 * when provided, and collapses `.screen-header` when nothing remains.
 * When `topbar` is enabled (core centers / overview), renders the identical
 * `.helmx-pane` + `.pane-topbar` + `.screen-toolbar-bar` + `.screen-host-body`
 * skeleton without importing any web store or routing code.
 */
export function Screen(props: ScreenProps): ReactNode {
  const {
    className,
    contentClassName,
    layout = 'contained',
    topbar,
    icon,
    header,
    title,
    subtitle,
    actions,
    topbarEnd,
    toolbar,
    banner,
    overlays,
    dataView,
    bodyId,
    bodyRole,
    children,
  } = props
  const pluginScopeId = usePluginScopeId()
  const { hosted, headerActionsSlot, toolbarSlot } = useScreenHost()
  const hasToolbar = hasRenderable(toolbar)
  const hasBanner = hasRenderable(banner)
  const hasOverlays = hasRenderable(overlays)

  if (topbar !== undefined && topbar !== false) {
    const hasIcon = hasRenderable(icon)
    const hasTitle = hasRenderable(title)
    const hasSubtitle = hasRenderable(subtitle)
    const hasActions = hasRenderable(actions)
    const hasTopbarEnd = hasRenderable(topbarEnd)
    const customTopbar = topbar !== true ? topbar : null

    return (
      <div
        className={joinClass('helmx-pane', 'screen-pane', className)}
        data-view={dataView}
        data-plugin-id={pluginScopeId}
      >
        {customTopbar !== null ? (
          customTopbar
        ) : (
          <div className="pane-topbar">
            <div className="pane-title-group">
              {hasIcon && renderTopbarIcon(icon)}
              {hasTitle && <span className="pane-title">{title}</span>}
              {hasSubtitle && <span className="screen-subtitle">{subtitle}</span>}
            </div>
            {(hasActions || hasTopbarEnd) && (
              <div className="pane-actions">
                {actions}
                {topbarEnd}
              </div>
            )}
          </div>
        )}
        {hasToolbar && (
          <div className="screen-toolbar-bar" data-screen-layout={layout} data-plugin-id={pluginScopeId}>
            {toolbar}
          </div>
        )}
        <div
          id={bodyId}
          role={bodyRole}
          className="screen-host-body"
          data-screen-host="true"
        >
          <div
            className={joinClass('screen-container', contentClassName)}
            data-screen-layout={layout}
            data-plugin-id={pluginScopeId}
          >
            {hasBanner && <div className="screen-banner">{banner}</div>}
            {children}
          </div>
        </div>
        {hasOverlays ? overlays : null}
      </div>
    )
  }

  const hasCustomHeader = hasRenderable(header)
  const showTitle = !hosted && hasRenderable(title)
  const showSubtitle = hasRenderable(subtitle)
  const showActions = !hasCustomHeader && hasRenderable(actions)
  // Hosted with a top bar slot: the action cluster is portalled into the host
  // `.pane-topbar .pane-actions` (React tree stays here, so plugin context and
  // `data-plugin-id` scoped CSS keep working); the inline header row then only
  // remains for a subtitle.
  const actionsInHostTopbar = hosted && headerActionsSlot != null && showActions
  const toolbarInHostSlot = hosted && toolbarSlot != null && hasToolbar
  const hasHeader = hasCustomHeader || showTitle || showSubtitle || (showActions && !actionsInHostTopbar)
  const actionsCluster = showActions ? (
    <div className="stack-row" data-plugin-id={pluginScopeId}>
      {actions}
    </div>
  ) : null
  const toolbarBar = hasToolbar ? (
    <div
      className={joinClass('screen-toolbar-bar', !toolbarInHostSlot ? 'screen-toolbar-bar-inline' : undefined)}
      data-screen-layout={layout}
      data-plugin-id={pluginScopeId}
    >
      {toolbar}
    </div>
  ) : null

  return (
    <div
      className={joinClass('screen-container', className)}
      data-screen-layout={layout}
      data-view={dataView}
      data-plugin-id={pluginScopeId}
    >
      {hasHeader &&
        (hasCustomHeader ? (
          header
        ) : (
          <div className="screen-header">
            <div className="screen-heading">
              {showTitle && <div className="screen-title">{title}</div>}
              {showSubtitle && <span className="screen-subtitle">{subtitle}</span>}
            </div>
            {!actionsInHostTopbar && actionsCluster}
          </div>
        ))}
      {actionsInHostTopbar && headerActionsSlot ? createPortal(actionsCluster, headerActionsSlot) : null}
      {toolbarInHostSlot && toolbarSlot ? createPortal(toolbarBar, toolbarSlot) : toolbarBar}
      {hasBanner && <div className="screen-banner">{banner}</div>}
      {children}
      {hasOverlays ? overlays : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ScreenSection: page section
// ---------------------------------------------------------------------------

export interface ScreenSectionProps {
  /** Section title text (plain strings recommended; compose with titleExtra for complex titles). */
  title?: ReactNode
  /** Extra content on the right of the title row (e.g. count badge, entry button). */
  titleExtra?: ReactNode
  className?: string
  children?: ReactNode
}

/** Page section: optional title + vertically stacked content. */
export function ScreenSection(props: ScreenSectionProps): ReactNode {
  const { title, titleExtra, className, children } = props
  return (
    <section className={joinClass('screen-section', className)}>
      {(title !== undefined || titleExtra !== undefined) && (
        <div className="screen-section-title">
          {title}
          {titleExtra !== undefined && <span className="screen-subtitle">{titleExtra}</span>}
        </div>
      )}
      {children}
    </section>
  )
}

// ---------------------------------------------------------------------------
// ScreenToolbar: header-to-content toolbar row
// ---------------------------------------------------------------------------

export interface ScreenToolbarProps {
  /** Main area (search box, filter selects, category pills…); children compose freely. */
  children?: ReactNode
  /** Right-aligned action cluster (buttons etc.); omitted renders nothing. */
  actions?: ReactNode
  /** Toolbar semantic description (accessibility: aria-label). */
  label?: string
  /** Extra class name (extension point for custom layouts). */
  className?: string
}

/**
 * Standard toolbar row between the page header and content: one flex-wrap row
 * (.screen-toolbar) with the main area on the left and the optional actions
 * cluster pushed right (.screen-toolbar-actions). Reuses the host public CSS
 * vocabulary — plugins stop re-rolling per-plugin toolbar flex rules.
 */
export function ScreenToolbar(props: ScreenToolbarProps): ReactNode {
  const { children, actions, label, className } = props
  return (
    <div className={joinClass('screen-toolbar', className)} aria-label={label}>
      <ScreenToolbarContext.Provider value={true}>
        {children}
        {actions !== undefined && <div className="screen-toolbar-actions">{actions}</div>}
      </ScreenToolbarContext.Provider>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DataTable: host table primitive + unified loading / empty states
// ---------------------------------------------------------------------------

export interface DataTableProps {
  /** Column count: colSpan for the loading / empty placeholder row (defaults to inference from thead, or 1). */
  columns?: number
  /** Data is loading: renders the unified loading row (children not rendered). */
  loading?: boolean
  /** Loading label text. */
  loadingLabel?: string
  /** Data is empty: renders the unified empty row (children not rendered). */
  empty?: boolean
  /** Empty-state label text (defaults to "No data"). */
  emptyLabel?: string
  /** Table semantic description (accessibility: aria-label). */
  label?: string
  className?: string
  /**
   * Table content: thead (custom header) and tbody (data rows) are composed by
   * the caller as JSX. This primitive does not take over column definitions —
   * stay composable, no opaque columns/data table.
   */
  children: ReactNode
}

/** Flattens JSX Fragments, keeping valid React elements. */
function flattenElements(node: ReactNode): ReactElement[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement(child)) return []
    if (child.type === Fragment) {
      const props = child.props as { children?: ReactNode }
      return flattenElements(props.children)
    }
    return [child]
  })
}

/** Computes the placeholder-row colSpan: explicit declaration wins, otherwise sum the colSpans of the first thead row cells. */
function inferColSpan(columns: number | undefined, children: ReactNode): number {
  if (columns !== undefined && Number.isInteger(columns) && columns > 0) return columns
  const thead = flattenElements(children).find((child) => child.type === 'thead')
  const row = thead === undefined
    ? undefined
    : flattenElements((thead.props as { children?: ReactNode }).children).find((child) => child.type === 'tr')
  if (row === undefined) return 1

  const cells = flattenElements((row.props as { children?: ReactNode }).children)
  const span = cells.reduce((total, cell) => {
    const cellProps = cell.props as { colSpan?: unknown }
    const colSpan = typeof cellProps.colSpan === 'number' && Number.isInteger(cellProps.colSpan) && cellProps.colSpan > 0
      ? cellProps.colSpan
      : 1
    return total + colSpan
  }, 0)
  return span || 1
}

/**
 * Composable table: the shell reuses the host .helmx-table-wrap / .helmx-table
 * primitives and unifies the loading / empty placeholder rows; the header and
 * data cells are fully expressed by children JSX:
 *
 * ```tsx
 * <DataTable loading={rows === undefined} empty={rows?.length === 0} columns={4}>
 *   <thead>
 *     <tr><th>ID</th><th>Name</th><th>Status</th><th>Actions</th></tr>
 *   </thead>
 *   <tbody>
 *     {rows?.map((r) => <tr key={r.id}><td>{r.id}</td>…</tr>)}
 *   </tbody>
 * </DataTable>
 * ```
 *
 * Default labels follow the shared UI locale; explicit loadingLabel and
 * emptyLabel props take precedence.
 */
export function DataTable(props: DataTableProps): ReactNode {
  const t = usePluginTranslator()
  const {
    columns,
    loading = false,
    loadingLabel = t(uiCopy.loading),
    empty = false,
    emptyLabel = t(uiCopy.noData),
    label,
    className,
    children,
  } = props
  const colSpan = inferColSpan(columns, children)
  return (
    <div className="helmx-table-wrap">
      <table className={joinClass('helmx-table', className)} aria-label={label}>
        {loading ? (
          <tbody>
            <tr>
              <td colSpan={colSpan}>
                <LoadingState label={loadingLabel} />
              </td>
            </tr>
          </tbody>
        ) : empty ? (
          <tbody>
            <tr>
              <td colSpan={colSpan} className="table-empty">
                <EmptyState compact title={emptyLabel} />
              </td>
            </tr>
          </tbody>
        ) : (
          children
        )}
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// KvGrid: key-value overview
// ---------------------------------------------------------------------------

export interface KvGridProps {
  /** Key-value pairs rendered in declaration order (key is the label, value is the content). */
  items: ReadonlyArray<{ key: ReactNode; value: ReactNode }>
  className?: string
}

/** Key-value overview grid: reuses the host .kv-grid two-column adaptive primitive (key/value are direct grid children). */
export function KvGrid(props: KvGridProps): ReactNode {
  const { items, className } = props
  return (
    <div className={joinClass('kv-grid', className)}>
      {items.map((item, index) => (
        <Fragment key={index}>
          <div className="kv-key">{item.key}</div>
          <div className="kv-val">{item.value}</div>
        </Fragment>
      ))}
    </div>
  )
}
