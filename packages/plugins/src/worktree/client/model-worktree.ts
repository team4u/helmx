/**
 * Pure logic and bilingual copy for the `builtin:worktree` cleanup slot:
 * - worktree action selector builder (registered ID first, path + nodeId fallback);
 * - structural error predicate for `worktree_usage_unverifiable`.
 * Zero React/DOM dependencies; Fast Refresh friendly.
 */
import { DEFAULT_HELMX_LOCALE, resolveLocalizedText, type HelmxLocale, type LocalizedText } from '@helmx/plugin-client'

const L = (en: string, zh: string): LocalizedText => ({ en, 'zh-CN': zh })

/**
 * Build the selector for `inspect_worktree` / `cleanup_worktree`: registered
 * worktree ID wins; otherwise fall back to `{ path, nodeId }` disambiguation.
 */
export function buildWorktreeSelector(
  worktree: { id?: string; path: string },
  nodeId?: string,
): { worktreeId: string } | { path: string; nodeId?: string } {
  const id = worktree.id?.trim()
  if (id !== undefined && id !== '') return { worktreeId: id }
  return { path: worktree.path, ...(nodeId !== undefined && nodeId !== '' ? { nodeId } : {}) }
}

export const WT_COPY = {
  cleanupLabel: L('Clean up worktree', '清理工作树'),
  cleanupTitle: L(
    'Clean up the isolated worktree (registered ID first for precise targeting, avoiding same-path ambiguity across nodes)',
    '清理隔离工作树（优先登记 ID 精确定位，避免跨节点同名路径歧义）',
  ),
  cleanupAria: L('Clean up isolated worktree', '清理隔离工作树'),
  unverifiedConfirmTitle: L('Clean up without process occupancy check?', '确认跳过进程占用扫描并清理？'),
  unverifiedConfirmButton: L('Clean up anyway', '确认承担风险清理'),
  unverifiedCancelButton: L('Cancel', '取消'),
} as const

/** Structural check across plugin boundary (never import host ApiClientError directly). */
export function isWorktreeUsageUnverifiableError(err: unknown): boolean {
  return err !== null && typeof err === 'object' && (err as { code?: unknown }).code === 'worktree_usage_unverifiable'
}

export function wtCleanupDone(branch: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Cleaned up isolated worktree ${branch}`, `已清理隔离工作树 ${branch}`), locale)
}

export function wtCleanupUnverifiedDone(branch: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(
    L(
      `Cleaned up isolated worktree ${branch} (process occupancy unverified)`,
      `已清理隔离工作树 ${branch}（未校验进程占用）`,
    ),
    locale,
  )
}

export function wtUnverifiedConfirmDesc(
  branch: string,
  detail: string,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  return resolveLocalizedText(
    L(
      `Worktree (${branch}) could not be scanned for running processes (${detail}). If you are certain no terminal, editor, or background process is using this directory, you can proceed at your own risk.`,
      `无法在目标节点对工作树（${branch}）执行进程占用扫描（${detail}）。若确认无终端、编辑器或后台进程占用该目录，可承担风险继续清理。`,
    ),
    locale,
  )
}

export function wtCleanupFailed(err: string, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return resolveLocalizedText(L(`Failed to clean up worktree: ${err}`, `清理工作树失败：${err}`), locale)
}
