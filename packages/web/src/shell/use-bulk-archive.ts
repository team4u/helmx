/**
 * Shared bulk conversation delete + archive/restore hook used by
 * ConversationOverview and SidebarConversationList.
 */
import { useCallback, useMemo, useState } from 'react'
import type { ConversationSummary } from '@helmx/protocol/browser'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import type { ToastNotice } from '../lib/types.js'
import { archiveBatchNotice, patchConversationsArchived } from './archive-ops.js'
import { isConversationArchivable, isConversationBulkSelectable } from './sidebar-model.js'
import { useBatchConversationDelete, type UseBatchConversationDeleteResult } from './use-batch-conversation-delete.js'

export interface UseBulkArchiveOptions {
  /** Currently rendered cards whose selectable items belong in the bulk action set. */
  renderedRoots: ReadonlyArray<ConversationSummary>
  /** Pool of roots to pull archive targets from (falls back to `renderedRoots` when omitted). */
  archiveSourceRoots?: ReadonlyArray<ConversationSummary>
  targetArchived: boolean
  pushNotice: (notice: Omit<ToastNotice, 'id' | 'createdAt'>) => void
  t: WebMessageTranslator
}

export interface UseBulkArchiveResult extends UseBatchConversationDeleteResult {
  selectableIds: number[]
  archiving: boolean
  effectiveArchivableSelectedIds: number[]
  executeBatchArchive: () => Promise<void>
}

export function useBulkArchive({
  renderedRoots,
  archiveSourceRoots,
  targetArchived,
  pushNotice,
  t,
}: UseBulkArchiveOptions): UseBulkArchiveResult {
  const [archiving, setArchiving] = useState(false)

  const selectableIds = useMemo(
    () => renderedRoots.filter((conv) => isConversationBulkSelectable(conv)).map((conv) => conv.id),
    [renderedRoots],
  )

  const batch = useBatchConversationDelete({
    selectableIds,
    pushNotice,
    t,
    busy: archiving,
  })

  const effectiveArchivableSelectedIds = useMemo(
    () =>
      renderedRoots
        .filter((conv) => batch.selectedIds.has(conv.id) && isConversationArchivable(conv))
        .map((conv) => conv.id),
    [renderedRoots, batch.selectedIds],
  )

  const executeBatchArchive = useCallback(async (): Promise<void> => {
    if (effectiveArchivableSelectedIds.length === 0 || archiving || batch.deleting) return
    setArchiving(true)
    try {
      const archivableSet = new Set(effectiveArchivableSelectedIds)
      const pool = archiveSourceRoots ?? renderedRoots
      const convs = pool.filter((conv) => archivableSet.has(conv.id) && isConversationArchivable(conv))
      if (convs.length === 0) return
      const outcome = await patchConversationsArchived(convs, targetArchived)
      pushNotice(archiveBatchNotice(targetArchived, outcome, t))
      batch.exitBatchMode()
    } finally {
      setArchiving(false)
    }
  }, [
    effectiveArchivableSelectedIds,
    archiving,
    batch,
    archiveSourceRoots,
    renderedRoots,
    targetArchived,
    pushNotice,
    t,
  ])

  return {
    ...batch,
    selectableIds,
    archiving,
    effectiveArchivableSelectedIds,
    executeBatchArchive,
  }
}
