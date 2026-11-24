/**
 * 受管 worktree 上下文的唯一渲染源与 before_turn 注入判定：`agent_spawn` 提示词尾注与
 * `before_turn` 系统段落共用同一份事实，确保 subagent / resume / reattach / Swarm 成员
 * （经 acquire_worktree 只改写 cwd、从未收到尾注）拿到一致的 worktree 坐标与提交提醒。
 */
import type { ManagedWorktreeRecord } from './worktree.js'

export const WORKTREE_CONTEXT_SECTION_ID = 'builtin:worktree.context'

/** before_turn 注入段落的形状（与 @helmx/protocol BeforeTurnHookPayload.sections 元素同构）。 */
export interface TurnSection {
  id: string
  text: string
}

export function worktreeContextLines(record: ManagedWorktreeRecord): string[] {
  return [
    '当前工作目录为独立 Git Worktree：',
    `- worktreeId: ${record.id}`,
    `- path: ${record.path}`,
    `- branch: ${record.branch}`,
    ...(record.baseCommit !== '' ? [`- baseCommit: ${record.baseCommit.slice(0, 12)}`] : []),
    ...(record.baseBranch !== undefined && record.baseBranch !== '' ? [`- baseBranch: ${record.baseBranch}`] : []),
    ...(record.parentWorktreeId !== undefined && record.parentWorktreeId !== ''
      ? [`- parentWorktreeId: ${record.parentWorktreeId}`]
      : []),
    record.dirtySource
      ? '- 注意：源工作区存在未提交修改，本隔离工作树基于源 HEAD 创建，不包含源工作区未提交的改动。'
      : '- 源工作区干净。',
    '请在结束回合前运行 git add 与 git commit 提交全部改动，保持工作区干净。',
  ]
}

/** 提示词尾注（agent_spawn 新建 / resume 时追加到子代理 prompt 末尾）。 */
export function worktreeContextPrompt(record: ManagedWorktreeRecord): string {
  return `\n\n<worktree_context>\n${worktreeContextLines(record).join('\n')}\n</worktree_context>`
}

/** 系统段落文本（before_turn 注入；每回合重算，反映最新登记事实）。 */
export function worktreeContextSectionText(record: ManagedWorktreeRecord): string {
  return `<worktree_context>\n${worktreeContextLines(record).join('\n')}\n</worktree_context>`
}

/**
 * 当前会话应注入的 worktree 上下文段落：仅对「活跃 + 带 hold」的记录生效。
 * hold 是 acquire_worktree（Swarm 等长占用方）独有的标记；agent_spawn 路径的记录无 hold，
 * 其上下文已由提示词尾注提供，不在此重复注入。
 */
export function resolveWorktreeContextSection(
  record: ManagedWorktreeRecord | undefined,
): TurnSection | undefined {
  if (record === undefined || record.status !== 'active' || record.hold === undefined) return undefined
  return { id: WORKTREE_CONTEXT_SECTION_ID, text: worktreeContextSectionText(record) }
}
