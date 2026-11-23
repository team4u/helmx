/**
 * Sidebar "Archived" group (Web host policy, not a plugin sidebar.section):
 *
 * - Shows only human-owned root conversations carrying the host archive tag
 *   (same exposure rule as agent standings: conversations with a parent chain,
 *   bot/helmx ownership, or taken over by a plugin section never enter);
 * - Collapsed by default; once expanded, rows are identified by owning agent +
 *   title; single-row restore goes through the inline "more actions" menu
 *   (which automatically offers restore for archived conversations), or use
 *   bulk restore; the batch bar also offers bulk delete (confirm-gated, same
 *   channel as the agent standings group);
 * - Restore uses the existing conversation PATCH (archive-ops); bulk delete goes
 *   through the single bulk-delete endpoint with server-side per-item
 *   aggregation (partial failures never mask successes); failures produce
 *   explicit notices and are never silently swallowed; deletion navigation is
 *   owned solely by the conversation.deleted SSE fallback pipeline, never here;
 * - An empty group renders nothing at all — zero visual residue.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Checkbox, HelmxIcon, Tooltip } from '@helmx/plugin-client'
import { useBatchConversationDelete } from './use-batch-conversation-delete.js'
import {
  useConversations,
  useLocationTargets,
  usePlugins,
  useProfilesSlice,
  useStoreActions,
  type LocationTargetsSlice,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { BatchActionBar } from '../ui/BatchActionBar.js'
import { ConversationRowActionsMenu } from '../ui/ConversationRowActionsMenu.js'
import {
  activeConversationIdsOf,
  buildArchivedConversationList,
  getConversationPresence,
  presenceNavClassSuffix,
  shouldSkipNavRowClick,
} from './sidebar-model.js'
import type { ArchivedConversationListItem } from './sidebar-model.js'
import { archiveBatchNotice, patchConversationsArchived } from './archive-ops.js'
import type { ConversationBackgroundIndex } from './background-activity-model.js'
import { ConversationStatusDot, SidebarPaneTag } from './SidebarPrimitives.js'

/** One conversation row in the archived group: leading status light + title + owning-agent badge + actions menu. */
function ArchivedConversationRow({
  item,
  locationTargets,
  onOpenConversation,
  background,
  onNavigate,
  batchMode,
  selected,
  onToggleSelect,
}: {
  item: ArchivedConversationListItem
  locationTargets: LocationTargetsSlice
  onOpenConversation: (conversationId: number) => void
  background: ConversationBackgroundIndex
  onNavigate?: () => void
  batchMode?: boolean
  selected?: boolean
  onToggleSelect?: (id: number) => void
}): ReactNode {
  const { t } = useWebLocale()
  const conv = item.conv
  const presence = getConversationPresence(locationTargets, conv.id)

  return (
    <div
      className={`nav-item nav-item-sub${presenceNavClassSuffix(presence)}`}
      onClick={(e) => {
        if (shouldSkipNavRowClick(e.target, e.currentTarget)) return
        if (batchMode) {
          onToggleSelect?.(conv.id)
          return
        }
        onOpenConversation(conv.id)
        onNavigate?.()
      }}
    >
      {batchMode && (
        <span onClick={(e) => e.stopPropagation()}>
          <Checkbox
            className="sidebar-batch-checkbox"
            checked={Boolean(selected)}
            onChange={() => onToggleSelect?.(conv.id)}
          />
        </span>
      )}
      <button
        type="button"
        className="nav-item-main nav-open"
        onClick={(e) => {
          if (batchMode) {
            e.stopPropagation()
            onToggleSelect?.(conv.id)
            return
          }
          onOpenConversation(conv.id)
          onNavigate?.()
        }}
        aria-current={presence.active ? 'page' : undefined}
      >
        <span className="nav-status-slot">
          <ConversationStatusDot conv={conv} background={background.get(conv.id)} />
        </span>
        <span className="nav-item-label">{conv.title || t('shell.conversationFallback', { id: conv.id })}</span>
      </button>
      <span className="nav-item-meta">
        <SidebarPaneTag paneTag={presence.paneTag} />
        <span
          className="badge badge-neutral archived-profile-label"
          title={t('shell.archived.owningAgent', { label: item.profileLabel })}
        >
          {item.profileLabel}
        </span>
        <span className="tabular-nums">#{conv.id}</span>
        <span className="nav-item-row-actions">
          <ConversationRowActionsMenu conversation={conv} />
        </span>
      </span>
    </div>
  )
}

/** The "Archived" group: collapsed by default; expanded rows restore individually or in bulk. */
export function ArchivedConversationsGroup({
  background,
  onNavigate,
}: {
  background: ConversationBackgroundIndex
  onNavigate?: () => void
}): ReactNode {
  const conversations = useConversations()
  const { profiles } = useProfilesSlice()
  const plugins = usePlugins()
  const locationTargets = useLocationTargets()
  const { openTarget, pushNotice } = useStoreActions()
  const { t } = useWebLocale()
  const items = useMemo(
    () =>
      buildArchivedConversationList({
        conversations,
        profiles,
        plugins,
      }),
    [conversations, profiles, plugins],
  )

  const activeConversationIds = activeConversationIdsOf(locationTargets)
  const hasActiveArchived = items.some((item) => activeConversationIds.has(item.conv.id))
  const [open, setOpen] = useState(hasActiveArchived)
  const [restoring, setRestoring] = useState(false)
  const selectableIds = useMemo(() => items.map((item) => item.conv.id), [items])
  const batch = useBatchConversationDelete({
    selectableIds,
    pushNotice,
    t,
    busy: restoring,
  })

  useEffect(() => {
    if (hasActiveArchived) setOpen(true)
  }, [hasActiveArchived, locationTargets.primaryTarget, locationTargets.splitTarget])

  const executeBatchRestore = async () => {
    if (batch.selectedIds.size === 0 || restoring || batch.deleting) return
    setRestoring(true)
    try {
      const convs = items
        .filter((item) => batch.selectedIds.has(item.conv.id))
        .map((item) => item.conv)
      const outcome = await patchConversationsArchived(convs, false)
      pushNotice(archiveBatchNotice(false, outcome, t))
      batch.exitBatchMode()
    } finally {
      setRestoring(false)
    }
  }

  if (items.length === 0) return null

  return (
    <div className="sidebar-group archived-conversations-group">
      <div className="sidebar-group-header">
        <button
          type="button"
          className="sidebar-group-header-toggle"
          title={open ? t('shell.archived.collapseGroup') : t('shell.archived.expandGroup')}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
            <HelmxIcon name="archive" size={12} />
            <span className="nav-item-label">{t('shell.archived.groupTitle')}</span>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span className="badge badge-neutral tabular-nums">{items.length}</span>
            <HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          </span>
        </button>
        {open && (
          <Tooltip content={batch.batchMode ? t('shell.archived.exitBulk') : t('shell.archived.manageBulk')} side="top">
            <button
              type="button"
              className="btn btn-ghost btn-icon-xs"
              style={{ color: batch.batchMode ? 'var(--accent)' : undefined }}
              aria-label={batch.batchMode ? t('shell.archived.exitBulk') : t('shell.archived.manageBulk')}
              onClick={batch.toggleBatchMode}
            >
              <HelmxIcon name="check-square" size={12} />
            </button>
          </Tooltip>
        )}
      </div>
      {open && batch.batchMode && (
        <BatchActionBar
          className="sidebar-batch-bar"
          selectedCount={batch.selectedIds.size}
          selectableCount={items.length}
          isAllSelected={batch.isAllSelected}
          deleting={batch.deleting}
          busy={restoring}
          exitTitle={t('shell.archived.exitBulk')}
          onExit={batch.exitBatchMode}
          onToggleSelectAll={batch.toggleSelectAll}
          extraActions={
            <button
              type="button"
              className="btn btn-sm"
              disabled={batch.selectedIds.size === 0 || restoring || batch.deleting}
              onClick={() => void executeBatchRestore()}
            >
              {restoring ? t('shell.archived.restoring') : t('shell.archived.restoreCount', { count: batch.selectedIds.size })}
            </button>
          }
          confirmOpen={batch.confirmOpen}
          onConfirmOpenChange={batch.setConfirmOpen}
          onRequestDelete={batch.requestDeleteConfirm}
          onConfirmDelete={() => void batch.executeBatchDelete()}
        />
      )}
      {open &&
        items.map((item) => (
          <ArchivedConversationRow
            key={item.conv.id}
            item={item}
            locationTargets={locationTargets}
            onOpenConversation={(conversationId) => openTarget({ kind: 'conversation', conversationId })}
            background={background}
            onNavigate={onNavigate}
            batchMode={batch.batchMode}
            selected={batch.selectedIds.has(item.conv.id)}
            onToggleSelect={batch.toggleSelect}
          />
        ))}
    </div>
  )
}
