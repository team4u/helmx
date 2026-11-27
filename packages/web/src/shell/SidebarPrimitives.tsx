import type { ConversationSummary } from '@helmx/protocol/browser'
import { HelmxIcon, IconButton, StatusLight, Tooltip } from '@helmx/ui'
import { useWebLocale } from '../i18n/use-web-locale.js'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import { sidebarPaneTagLabel, type SidebarTargetPresence } from './sidebar-model.js'
import type { ConversationBackgroundActivity } from './conversation-status-model.js'
import {
  backgroundAwareStatusTooltip,
  resolveAggregateConversationStatus,
  resolveStatusLight,
  type StatusAggregateCounts,
} from './background-activity-model.js'

export function StatusDot({ connected }: { connected: boolean }) {
  const { t } = useWebLocale()
  const label = connected ? t('shell.status.liveHealthy') : t('shell.status.liveLost')
  return (
    <span className="activity-rail-status-light" title={label}>
      <StatusLight tone={connected ? 'done' : 'idle'} label={label} />
    </span>
  )
}

export function HoverIconButton({
  title,
  icon,
  onClick,
  className,
}: {
  title: string
  icon: string
  onClick: (e: React.MouseEvent) => void
  className?: string
}) {
  return (
    <Tooltip content={title} side="top">
      <IconButton
        variant="ghost"
        size="xs"
        className={className}
        icon={<HelmxIcon name={icon} size={13} />}
        aria-label={title}
        onClick={onClick}
      />
    </Tooltip>
  )
}

/**
 * Single-light-slot status light: dotClass is adjudicated by the pure
 * resolveStatusLight; each row renders exactly one light and never stacks a
 * second by order (working/blocked/error status lights are exclusive;
 * idle/done yield to the background hollow ring; with nothing in flight the
 * five states stay as-is). The tooltip shares the light's source; the
 * background summary is appended only on the hollow-ring slot.
 */
function StatusLightDot({
  status,
  doing,
  lastError,
  backgroundActive,
  backgroundSummary,
  showDone = true,
}: {
  status: ConversationSummary['status']
  doing?: string
  lastError?: string
  backgroundActive: boolean
  backgroundSummary?: string
  showDone?: boolean
}) {
  const { t } = useWebLocale()
  if (status === 'done' && !showDone && !backgroundActive) return null
  const light = resolveStatusLight(status, backgroundActive)
  if (light.dotClass === null) return null
  const tooltip = backgroundAwareStatusTooltip({
    status,
    doing,
    lastError,
    backgroundActive,
    backgroundSummary,
    t,
  })
  return (
    <span className={light.dotClass} title={tooltip} aria-label={tooltip} role="status" />
  )
}

/** The conversation row's single status light: main status first; idle/done with background work yields to the hollow ring. */
export function ConversationStatusDot({
  conv,
  background,
  showDone = true,
  aggregate,
}: {
  conv: ConversationSummary
  background?: ConversationBackgroundActivity
  showDone?: boolean
  /** Optional descendant facts. The light remains one slot, but reflects the visible subtree. */
  aggregate?: StatusAggregateCounts
}) {
  const aggregateStatus = resolveAggregateConversationStatus(conv, aggregate)
  return (
    <StatusLightDot
      status={aggregateStatus}
      doing={conv.doing}
      lastError={conv.lastError}
      backgroundActive={background?.active === true && aggregateStatus !== 'working'}
      backgroundSummary={background?.summary}
      showDone={showDone}
    />
  )
}

/** Compact read-only marker for remote conversations: non-local rows at a glance. */
export function RemoteNodeTag({ nodeId }: { nodeId: string }) {
  const { t } = useWebLocale()
  return (
    <span
      className="mono remote-node-tag"
      title={t('shell.node.title', { id: nodeId })}
    >
      @{nodeId}
    </span>
  )
}

const PANE_TAG_TITLE_KEYS: Record<NonNullable<SidebarTargetPresence['paneTag']>, 'shell.pane.main' | 'shell.pane.split' | 'shell.pane.both'> = {
  Main: 'shell.pane.main',
  Split: 'shell.pane.split',
  'Main·Split': 'shell.pane.both',
}

/** Resolve a pane tag's tooltip title through the given translator (pure helper). */
function paneTagTitle(t: WebMessageTranslator, paneTag: NonNullable<SidebarTargetPresence['paneTag']>): string {
  return t(PANE_TAG_TITLE_KEYS[paneTag])
}

/** Pane-affinity micro badge shown at sidebar row ends when the split view is open (Main / Split / Main·Split). */
export function SidebarPaneTag({ paneTag }: { paneTag: SidebarTargetPresence['paneTag'] }) {
  const { t } = useWebLocale()
  if (paneTag === null) return null
  return (
    <span className="nav-pane-tag" title={paneTagTitle(t, paneTag)}>
      {sidebarPaneTagLabel(paneTag, t)}
    </span>
  )
}
