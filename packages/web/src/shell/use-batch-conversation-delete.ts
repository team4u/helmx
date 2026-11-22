/**
 * Shared batch conversation selection & bulk-delete state machine used by
 * ConversationOverview, SidebarAgentStandings, and SidebarArchivedConversations.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import type { ToastNotice } from '../lib/types.js'
import { bulkDeleteConversations, bulkDeleteNotice } from './bulk-delete-ops.js'

export interface UseBatchConversationDeleteOptions {
  selectableIds: ReadonlyArray<number>
  pushNotice: (notice: Omit<ToastNotice, 'id' | 'createdAt'>) => void
  t: WebMessageTranslator
  /** External in-flight batch action (e.g. archive / restore) blocking concurrent delete. */
  busy?: boolean
}

export interface UseBatchConversationDeleteResult {
  batchMode: boolean
  setBatchMode: (open: boolean) => void
  toggleBatchMode: () => void
  exitBatchMode: () => void
  selectedIds: ReadonlySet<number>
  isAllSelected: boolean
  toggleSelect: (id: number) => void
  toggleSelectAll: () => void
  deleting: boolean
  confirmOpen: boolean
  setConfirmOpen: (open: boolean) => void
  requestDeleteConfirm: () => void
  executeBatchDelete: () => Promise<void>
}

export function useBatchConversationDelete({
  selectableIds,
  pushNotice,
  t,
  busy = false,
}: UseBatchConversationDeleteOptions): UseBatchConversationDeleteResult {
  const [batchMode, setBatchModeState] = useState(false)
  const [rawSelectedIds, setRawSelectedIds] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [confirmSnapshotIds, setConfirmSnapshotIds] = useState<ReadonlySet<number> | null>(null)

  // Convergence boundary: selection is always a subset of currently visible & selectable IDs.
  const selectedIds = useMemo<ReadonlySet<number>>(() => {
    if (rawSelectedIds.size === 0) return rawSelectedIds
    const allowed = new Set(selectableIds)
    const effective = new Set<number>()
    for (const id of rawSelectedIds) {
      if (allowed.has(id)) effective.add(id)
    }
    return effective
  }, [rawSelectedIds, selectableIds])

  useEffect(() => {
    setRawSelectedIds((prev) => {
      if (prev.size !== selectedIds.size) return new Set(selectedIds)
      for (const id of selectedIds) {
        if (!prev.has(id)) return new Set(selectedIds)
      }
      return prev
    })
  }, [selectedIds])

  const isAllSelected = selectableIds.length > 0 && selectableIds.length === selectedIds.size

  const confirmOpen =
    confirmSnapshotIds !== null &&
    confirmSnapshotIds.size === selectedIds.size &&
    [...confirmSnapshotIds].every((id) => selectedIds.has(id))

  useEffect(() => {
    if (!confirmOpen && confirmSnapshotIds !== null) {
      setConfirmSnapshotIds(null)
    }
  }, [confirmOpen, confirmSnapshotIds])

  const exitBatchMode = useCallback(() => {
    setBatchModeState(false)
    setRawSelectedIds(new Set())
    setConfirmSnapshotIds(null)
  }, [])

  const setBatchMode = useCallback((open: boolean) => {
    if (!open) {
      exitBatchMode()
    } else {
      setBatchModeState(true)
    }
  }, [exitBatchMode])

  const toggleBatchMode = useCallback(() => {
    setBatchModeState((prev) => {
      if (prev) {
        setRawSelectedIds(new Set())
        setConfirmSnapshotIds(null)
      }
      return !prev
    })
  }, [])

  const toggleSelect = useCallback((id: number) => {
    setRawSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleSelectAll = useCallback(() => {
    if (isAllSelected) {
      setRawSelectedIds(new Set())
    } else {
      setRawSelectedIds(new Set(selectableIds))
    }
  }, [isAllSelected, selectableIds])

  const requestDeleteConfirm = useCallback(() => {
    if (selectedIds.size === 0 || deleting || busy) return
    setConfirmSnapshotIds(new Set(selectedIds))
  }, [selectedIds, deleting, busy])

  const setConfirmOpen = useCallback((open: boolean) => {
    if (!open) setConfirmSnapshotIds(null)
  }, [])

  const executeBatchDelete = useCallback(async (): Promise<void> => {
    if (!confirmOpen || confirmSnapshotIds === null || deleting || busy) return
    const ids = Array.from(confirmSnapshotIds)
    setConfirmSnapshotIds(null)
    setDeleting(true)
    try {
      const outcome = await bulkDeleteConversations(ids)
      pushNotice(bulkDeleteNotice(outcome, t))
      exitBatchMode()
    } catch (err) {
      pushNotice({
        type: 'notification',
        level: 'error',
        title: t('shell.batch.bulkDeleteError'),
        body: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setDeleting(false)
    }
  }, [confirmOpen, confirmSnapshotIds, deleting, busy, pushNotice, t, exitBatchMode])

  return {
    batchMode,
    setBatchMode,
    toggleBatchMode,
    exitBatchMode,
    selectedIds,
    isAllSelected,
    toggleSelect,
    toggleSelectAll,
    deleting,
    confirmOpen,
    setConfirmOpen,
    requestDeleteConfirm,
    executeBatchDelete,
  }
}
