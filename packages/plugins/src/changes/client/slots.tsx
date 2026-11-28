/**
 * Decoupled read-only UI slot contributions from `builtin:changes` into sibling plugins
 * (`builtin:workflow` and `builtin:swarm`):
 * - WorkflowWorktreeInspectSlot (`builtin:workflow/worktree-inspect`): slim compact bar
 *   switching directly to Workbench `Changes` tab when inside a conversation (or split fallback);
 * - WorktreeTraceInspectSlot (`builtin:workflow/worktree-trace-inspect`): compact icon
 *   button inside timeline SubagentToolView rows;
 * - SwarmWorktreeActionsSlot (`builtin:swarm/worktree-actions`): compact diff-preview
 *   trigger on member, retained-branch, and snapshot rows.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import './styles.css'
import type { MouseEvent, ReactNode } from 'react'
import type { PluginClientContext } from '@helmx/protocol/browser'
import { Button, HelmxIcon, IconButton, resolveLocalizedText, type LocalizedText } from '@helmx/ui'
import { usePluginContext, usePluginLocale } from '@helmx/plugin-client'
import { CHG_COPY, chgInspectTitle, chgSlotBrief } from './copy.ts'
import { buildChangesScreenTarget } from './diff-model.ts'

const CHANGES_WORKBENCH_TAB_ID = 'plugin:builtin:changes/changes'

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

function openWorktreeChanges(ctx: PluginClientContext, worktreeId: string): void {
  if (ctx.conversationId !== undefined) {
    ctx.openWorkbench(CHANGES_WORKBENCH_TAB_ID, { wt: worktreeId })
    return
  }
  ctx.openSplitScreen(buildChangesScreenTarget({ wt: worktreeId }))
}

export function WorkflowWorktreeInspectSlot(props: WorkflowWorktreeInspectSlotProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = (text: LocalizedText): string => resolveLocalizedText(text, locale)
  const { worktree, nodeId } = props
  if (worktree === undefined) return null

  const resolvedWtId = resolveWorktreeTargetId(worktree, nodeId)

  return (
    <div className="chg-slot-bar">
      <div className="chg-slot-summary">
        <HelmxIcon name="git-branch" size={11} />
        <span className="mono chg-slot-branch" title={`${worktree.branch} @ ${worktree.path}`}>
          {chgSlotBrief(worktree.branch, nodeId, locale)}
        </span>
      </div>
      <Button
        variant="secondary"
        size="xs"
        icon="file-diff"
        onClick={() => openWorktreeChanges(ctx, resolvedWtId)}
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
        openWorktreeChanges(ctx, resolvedWtId)
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
        openWorktreeChanges(ctx, resolvedWtId)
      }}
    />
  )
}
