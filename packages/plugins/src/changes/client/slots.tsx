/**
 * Decoupled UI slot contributions from `builtin:changes` into sibling plugins
 * (`builtin:workflow` and `builtin:swarm`):
 * - WorkflowWorktreeInspectSlot (`builtin:workflow/worktree-inspect`): slim compact bar
 *   opening split/full diff inspector + lazy review-and-merge submission to parent;
 * - WorktreeTraceInspectSlot (`builtin:workflow/worktree-trace-inspect`): compact icon
 *   button inside timeline SubagentToolView rows;
 * - SwarmWorktreeActionsSlot (`builtin:swarm/worktree-actions`): compact split-inspect
 *   (and retained review-request) triggers on member, retained-branch, and snapshot rows.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import './styles.css'
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import {
  Button,
  CopyButton,
  HelmxIcon,
  IconButton,
  Stack,
  resolveLocalizedText,
  usePluginContext,
  usePluginLocale,
  type LocalizedText,
} from '@helmx/plugin-client'
import { CHG_COPY, chgInspectTitle, chgSlotBrief, chgSubmitFailed } from './copy.ts'
import {
  buildChangesScreenTarget,
  buildWorktreeReviewRequest,
  parseWorktreeInspectResult,
  type WorktreeInspectView,
} from './diff-model.ts'

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

function buildWorktreeSelector(
  worktree: { id?: string; path?: string },
  nodeId?: string,
): { worktreeId: string } | { path: string; nodeId?: string } | undefined {
  const id = worktree.id?.trim()
  if (id !== undefined && id !== '') return { worktreeId: id }
  const path = worktree.path?.trim()
  if (path !== undefined && path !== '') {
    return { path, ...(nodeId !== undefined && nodeId !== '' ? { nodeId } : {}) }
  }
  return undefined
}

export function WorkflowWorktreeInspectSlot(props: WorkflowWorktreeInspectSlotProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = (text: LocalizedText): string => resolveLocalizedText(text, locale)
  const { worktree, nodeId, baseCommit, taskLabel, parentConversationId } = props
  const [sending, setSending] = useState(false)

  const reviewFallbackText = useMemo(
    () =>
      worktree === undefined
        ? ''
        : buildWorktreeReviewRequest(
            {
              path: worktree.path,
              branch: worktree.branch,
              nodeId,
              baseCommit,
              taskLabel,
            },
            locale,
          ),
    [worktree, nodeId, baseCommit, taskLabel, locale],
  )

  if (worktree === undefined || parentConversationId === undefined) return null

  const resolvedWtId = worktree.id ?? (nodeId ? `${nodeId}:${worktree.path}` : `local:${worktree.path}`)
  const target = buildChangesScreenTarget({
    wt: resolvedWtId,
    parent: parentConversationId,
  })

  const sendReview = async (): Promise<void> => {
    if (sending) return
    setSending(true)
    try {
      let inspect: WorktreeInspectView | undefined
      const selector = buildWorktreeSelector(worktree, nodeId)
      if (selector !== undefined) {
        const raw = await ctx.callAction('inspect_worktree', selector, { pluginId: 'builtin:worktree' }).catch(() => undefined)
        inspect = parseWorktreeInspectResult(raw)
      }
      const text = buildWorktreeReviewRequest(
        {
          path: worktree.path,
          branch: inspect?.record.branch ?? worktree.branch,
          nodeId: inspect?.record.nodeId ?? nodeId,
          baseCommit: inspect?.record.baseCommit || baseCommit,
          taskLabel,
          ...(inspect !== undefined ? { inspect } : {}),
        },
        locale,
      )
      await ctx.submitInput(text, { conversationId: parentConversationId, whenBusy: 'steer' })
      ctx.notify(t(CHG_COPY.slotReviewSubmitted))
    } catch (err) {
      ctx.notify(chgSubmitFailed(err instanceof Error ? err.message : String(err), locale), 'error')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="chg-slot-bar">
      <div className="chg-slot-summary">
        <HelmxIcon name="git-branch" size={11} />
        <span className="mono chg-slot-branch" title={`${worktree.branch} @ ${worktree.path}`}>
          {chgSlotBrief(worktree.branch, nodeId, locale)}
        </span>
      </div>
      <Stack direction="horizontal" gap="xs" align="center" wrap>
        <Button
          variant="default"
          size="xs"
          icon="file-diff"
          title={t(CHG_COPY.splitInspectTitle)}
          onClick={() => ctx.openSplitScreen(target)}
        >
          {t(CHG_COPY.splitInspect)}
        </Button>
        <IconButton
          variant="ghost"
          size="xs"
          icon="maximize-2"
          label={t(CHG_COPY.fullInspect)}
          title={t(CHG_COPY.fullInspect)}
          onClick={() => ctx.openScreen(target)}
        />
        <Button
          variant="ghost"
          size="xs"
          icon="git-pull-request"
          pending={sending}
          onClick={() => void sendReview()}
        >
          {t(CHG_COPY.reviewShort)}
        </Button>
        <CopyButton text={reviewFallbackText} label={t(CHG_COPY.copyReview)} />
      </Stack>
    </div>
  )
}

export function WorktreeTraceInspectSlot(props: WorktreeTraceInspectSlotProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const { worktree, nodeId, parentConversationId } = props
  if (worktree === undefined) return null
  const resolvedWtId = worktree.id ?? (nodeId ? `${nodeId}:${worktree.path}` : `local:${worktree.path}`)
  const target = buildChangesScreenTarget({
    wt: resolvedWtId,
    ...(parentConversationId !== undefined ? { parent: parentConversationId } : {}),
  })
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
  const t = (text: LocalizedText): string => resolveLocalizedText(text, locale)
  const { worktreeId, path, branch, nodeId, parentConversationId, mode = 'member' } = props
  const [sending, setSending] = useState(false)

  const resolvedWtId = worktreeId ?? (path ? (nodeId ? `${nodeId}:${path}` : `local:${path}`) : undefined)
  if (resolvedWtId === undefined) return null

  const target = buildChangesScreenTarget({
    wt: resolvedWtId,
    ...(parentConversationId !== undefined ? { parent: parentConversationId } : {}),
  })
  const inspectLabel = chgInspectTitle(branch ?? resolvedWtId, locale)

  const submitRetainedReview = async (e: MouseEvent<HTMLButtonElement>): Promise<void> => {
    e.stopPropagation()
    if (sending || parentConversationId === undefined || parentConversationId <= 0) return
    setSending(true)
    try {
      const raw = await ctx
        .callAction('inspect_worktree', { worktreeId: resolvedWtId }, { pluginId: 'builtin:worktree' })
        .catch(() => undefined)
      const inspect = parseWorktreeInspectResult(raw)
      const text = buildWorktreeReviewRequest(
        {
          path: inspect?.record.path ?? path ?? resolvedWtId,
          branch: inspect?.record.branch ?? branch ?? 'helmx/spawn',
          nodeId: inspect?.record.nodeId ?? nodeId,
          baseCommit: inspect?.record.baseCommit,
          ...(inspect !== undefined ? { inspect } : {}),
        },
        locale,
      )
      await ctx.submitInput(text, { conversationId: parentConversationId, whenBusy: 'steer' })
      ctx.notify(t(CHG_COPY.slotReviewSubmitted))
    } catch (err) {
      ctx.notify(chgSubmitFailed(err instanceof Error ? err.message : String(err), locale), 'error')
    } finally {
      setSending(false)
    }
  }

  return (
    <span className="chg-swarm-slot-actions">
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
      {mode === 'retained' && parentConversationId !== undefined && parentConversationId > 0 ? (
        <IconButton
          variant="ghost"
          size="xs"
          icon="git-pull-request"
          pending={sending}
          className="chg-compact-slot-btn"
          label={t(CHG_COPY.reviewSwarmButton)}
          title={t(CHG_COPY.reviewSwarmButton)}
          onClick={(e) => void submitRetainedReview(e)}
        />
      ) : null}
    </span>
  )
}
