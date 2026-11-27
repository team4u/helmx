/**
 * Decoupled read-only UI slot contributions from `builtin:changes` into sibling plugins
 * (`builtin:workflow` and `builtin:swarm`):
 * - WorkflowWorktreeInspectSlot (`builtin:workflow/worktree-inspect`): slim compact bar
 *   opening diff preview (`ctx.openSplitScreen`);
 * - WorktreeTraceInspectSlot (`builtin:workflow/worktree-trace-inspect`): compact icon
 *   button inside timeline SubagentToolView rows;
 * - SwarmWorktreeActionsSlot (`builtin:swarm/worktree-actions`): compact diff-preview
 *   trigger on member, retained-branch, and snapshot rows.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import './styles.css'
import type { MouseEvent, ReactNode } from 'react'
import {
  Button,
  HelmxIcon,
  IconButton,
  resolveLocalizedText,
  usePluginContext,
  usePluginLocale,
  type LocalizedText,
} from '@helmx/plugin-client'
import { CHG_COPY, chgInspectTitle, chgSlotBrief } from './copy.ts'
import { buildChangesScreenTarget } from './diff-model.ts'

export interface WorktreeRef {
  id?: string
  path: string
  branch: string
}

export interface WorkflowWorktreeInspectSlotProps {
  worktree?: WorktreeRef
  nodeId?: string
  baseCommit?: string
  taskLabel?: string
  parentConversationId?: number
}

export interface WorktreeTraceInspectSlotProps {
  worktree?: WorktreeRef
  nodeId?: string
  parentConversationId?: number
}

export interface SwarmWorktreeActionsSlotProps {
  worktreeId?: string
  path?: string
  branch?: string
  nodeId?: string
  parentConversationId?: number
  mode?: 'member' | 'retained' | 'snapshot'
}

function resolveWorktreeTargetId(worktree: WorktreeRef, nodeId?: string): string {
  return worktree.id ?? (nodeId ? `${nodeId}:${worktree.path}` : `local:${worktree.path}`)
}

export function WorkflowWorktreeInspectSlot(props: WorkflowWorktreeInspectSlotProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = (text: LocalizedText): string => resolveLocalizedText(text, locale)
  const { worktree, nodeId } = props
  if (worktree === undefined) return null

  const resolvedWtId = resolveWorktreeTargetId(worktree, nodeId)
  const target = buildChangesScreenTarget({ wt: resolvedWtId })

  return (
    <div className="chg-slot-bar">
      <div className="chg-slot-summary">
        <HelmxIcon name="git-branch" size={11} />
        <span className="mono chg-slot-branch" title={`${worktree.branch} @ ${worktree.path}`}>
          {chgSlotBrief(worktree.branch, nodeId, locale)}
        </span>
      </div>
      <Button
        variant="default"
        size="xs"
        icon="file-diff"
        onClick={() => ctx.openSplitScreen(target)}
      >
        {t(CHG_COPY.viewChanges)}
      </Button>
    </div>
  )
}

export function WorktreeTraceInspectSlot(props: WorktreeTraceInspectSlotProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const { worktree, nodeId } = props
  if (worktree === undefined) return null
  const resolvedWtId = resolveWorktreeTargetId(worktree, nodeId)
  const target = buildChangesScreenTarget({ wt: resolvedWtId })
  const label = chgInspectTitle(worktree.branch, locale)

  return (
    <IconButton
      variant="ghost"
      size="xs"
      icon="file-diff"
      className="chg-compact-slot-btn"
      label={label}
      title={label}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation()
        ctx.openSplitScreen(target)
      }}
    />
  )
}

export function SwarmWorktreeActionsSlot(props: SwarmWorktreeActionsSlotProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const { worktreeId, path, branch, nodeId } = props

  const resolvedWtId = worktreeId ?? (path ? (nodeId ? `${nodeId}:${path}` : `local:${path}`) : undefined)
  if (resolvedWtId === undefined) return null

  const target = buildChangesScreenTarget({ wt: resolvedWtId })
  const inspectLabel = chgInspectTitle(branch ?? resolvedWtId, locale)

  return (
    <IconButton
      variant="ghost"
      size="xs"
      icon="file-diff"
      className="chg-compact-slot-btn"
      label={inspectLabel}
      title={inspectLabel}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation()
        ctx.openSplitScreen(target)
      }}
    />
  )
}
