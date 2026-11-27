/**
 * 黑板帖子元数据与下方元信息片段（Fast Refresh compliant: components & types only）：
 * 偏离默认 wake 轻标签、`#seq` 引用跳转按钮组与 worktree 快照摘要行，
 * 被面板帖子列表、预览浮层与时间线回执卡共用。
 */
import type { ReactNode } from 'react'
import type { HelmxLocale } from '@helmx/protocol/browser'
import { Badge, HelmxIcon, resolveLocalizedText } from '@helmx/plugin-client'
import { resolveNonDefaultWakeBadge, type BoardPost } from './board-model.ts'
import * as C from './copy.ts'

export interface PostWakeBadgeProps {
  post: Pick<BoardPost, 'kind' | 'wake'>
  locale: HelmxLocale
}

export function PostWakeBadge({ post, locale }: PostWakeBadgeProps): ReactNode {
  const wakeBadge = resolveNonDefaultWakeBadge(post)
  if (wakeBadge === undefined) return null
  return (
    <Badge tone="neutral">
      {resolveLocalizedText(wakeBadge === 'silent' ? C.SW_WAKE_OVERRIDE_SILENT : C.SW_WAKE_OVERRIDE_WOKE, locale)}
    </Badge>
  )
}

export interface PostRefButtonsProps {
  refs: readonly number[]
  locale: HelmxLocale
  /** 追加到按钮组容器的额外类名（预览浮层用 `sw-peek-refs`）。 */
  className?: string
  /** 点击引用；`anchor` 为被点击按钮，供调用方定位浮层。 */
  onPick: (refSeq: number, anchor: HTMLButtonElement) => void
}

export function PostRefButtons({ refs, locale, className, onPick }: PostRefButtonsProps): ReactNode {
  if (refs.length === 0) return null
  return (
    <div className={className === undefined ? 'sw-panel-post-refs' : `sw-panel-post-refs ${className}`}>
      {refs.map((refSeq) => (
        <button
          key={refSeq}
          type="button"
          className="sw-panel-post-ref mono tabular-nums"
          aria-label={C.panelRefJumpLabel(refSeq, locale)}
          onClick={(e) => onPick(refSeq, e.currentTarget)}
        >
          {`#${refSeq}`}
        </button>
      ))}
    </div>
  )
}

export interface PostWorktreeLineProps {
  snapshot: BoardPost['worktreeSnapshot']
  locale: HelmxLocale
}

export function PostWorktreeLine({ snapshot, locale }: PostWorktreeLineProps): ReactNode {
  if (snapshot === undefined) return null
  return (
    <div className="sw-panel-post-worktree">
      <HelmxIcon name="git-branch" size={11} />
      <span>{C.panelWorktreeSummary(snapshot, locale)}</span>
    </div>
  )
}
