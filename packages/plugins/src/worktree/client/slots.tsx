/**
 * builtin:worktree UI slot contributions rendered inside sibling plugins
 * (`builtin:workflow`, `builtin:swarm`, `builtin:changes`):
 * - WorktreeCleanupSlot: managed worktree cleanup action button with unverified-usage confirm dialog.
 *
 * When `builtin:worktree` is disabled, these slots unregister cleanly and render
 * nothing — leaving zero broken worktree actions anywhere.
 * Exports only components and TS types (Fast Refresh compliant).
 */
import './styles.css'
import { useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import {
  Button,
  ConfirmDialog,
  IconButton,
  resolveLocalizedText,
  usePluginContext,
  usePluginLocale,
} from '@helmx/plugin-client'
import {
  WT_COPY,
  buildWorktreeSelector,
  isWorktreeUsageUnverifiableError,
  wtCleanupDone,
  wtCleanupFailed,
  wtCleanupUnverifiedDone,
  wtUnverifiedConfirmDesc,
} from './model-worktree.ts'

export interface WorktreeRef {
  id?: string
  path: string
  branch: string
}

export interface WorktreeCleanupSlotProps {
  worktree?: WorktreeRef
  nodeId?: string
  compact?: boolean
  variant?: 'default' | 'compact'
  onCleaned?: () => void
}

export function WorktreeCleanupSlot(props: WorktreeCleanupSlotProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const [cleaning, setCleaning] = useState(false)
  const [unverifiedDetail, setUnverifiedDetail] = useState<string | undefined>(undefined)
  const { worktree, nodeId, compact, variant, onCleaned } = props
  if (worktree === undefined) return null
  const isCompact = compact === true || variant === 'compact'

  const runCleanup = (allowUnverifiedUsage: boolean): void => {
    if (cleaning) return
    setCleaning(true)
    ctx
      .callAction(
        'cleanup_worktree',
        {
          ...buildWorktreeSelector(worktree, nodeId),
          ...(allowUnverifiedUsage ? { allowUnverifiedUsage: true } : {}),
        },
        { pluginId: 'builtin:worktree' },
      )
      .then(() => {
        ctx.notify(
          allowUnverifiedUsage
            ? wtCleanupUnverifiedDone(worktree.branch, locale)
            : wtCleanupDone(worktree.branch, locale),
        )
        onCleaned?.()
      })
      .catch((err: unknown) => {
        if (!allowUnverifiedUsage && isWorktreeUsageUnverifiableError(err)) {
          setUnverifiedDetail(err instanceof Error ? err.message : String(err))
          return
        }
        ctx.notify(wtCleanupFailed(err instanceof Error ? err.message : String(err), locale), 'error')
      })
      .finally(() => setCleaning(false))
  }

  const handleCleanup = (e: MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation()
    runCleanup(false)
  }

  const trigger = isCompact ? (
    <IconButton
      variant="default"
      size="xs"
      icon="trash-2"
      pending={cleaning}
      className="worktree-cleanup-compact"
      label={resolveLocalizedText(WT_COPY.cleanupAria, locale)}
      title={resolveLocalizedText(WT_COPY.cleanupTitle, locale)}
      onClick={handleCleanup}
    />
  ) : (
    <Button
      variant="default"
      size="xs"
      icon="trash-2"
      pending={cleaning}
      title={resolveLocalizedText(WT_COPY.cleanupTitle, locale)}
      onClick={handleCleanup}
    >
      {resolveLocalizedText(WT_COPY.cleanupLabel, locale)}
    </Button>
  )

  return (
    <>
      {trigger}
      <ConfirmDialog
        open={unverifiedDetail !== undefined}
        onOpenChange={(open) => {
          if (!open) setUnverifiedDetail(undefined)
        }}
        title={resolveLocalizedText(WT_COPY.unverifiedConfirmTitle, locale)}
        description={wtUnverifiedConfirmDesc(worktree.branch, unverifiedDetail ?? '', locale)}
        confirmText={resolveLocalizedText(WT_COPY.unverifiedConfirmButton, locale)}
        cancelText={resolveLocalizedText(WT_COPY.unverifiedCancelButton, locale)}
        danger
        pending={cleaning}
        onConfirm={() => {
          setUnverifiedDetail(undefined)
          runCleanup(true)
        }}
        onCancel={() => setUnverifiedDetail(undefined)}
      />
    </>
  )
}
