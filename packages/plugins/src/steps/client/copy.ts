/**
 * Bilingual display copy dictionary for builtin:steps client surfaces (en / zh-CN).
 * Zero Emoji; concise engineering language (Fast Refresh friendly).
 */
import {
  DEFAULT_HELMX_LOCALE,
  resolveLocalizedText,
  type HelmxLocale,
  type LocalizedText,
} from '@helmx/ui'
import type { StepStatus, StepsSettledOutcome, StepsToolPresentationMeta } from './types.ts'
import type { StepsTraySummary } from './models.ts'

const isZh = (locale: HelmxLocale): boolean => locale === 'zh-CN'

export const STEPS_COPY = {
  trayRegionAria: { en: 'Task checklist', 'zh-CN': '任务步骤清单' },
  trayTitle: { en: 'Steps', 'zh-CN': '步骤' },
  trayExpand: { en: 'Expand checklist', 'zh-CN': '展开步骤清单' },
  trayCollapse: { en: 'Collapse checklist', 'zh-CN': '收起步骤清单' },
  trayDismiss: { en: 'Dismiss checklist', 'zh-CN': '收起关闭清单' },
  actionDismiss: { en: 'Dismiss steps', 'zh-CN': '关闭步骤清单' },

  statusWorking: { en: 'In progress', 'zh-CN': '执行中' },
  statusCompleted: { en: 'Completed', 'zh-CN': '已完成' },
  statusPaused: { en: 'Paused', 'zh-CN': '已暂停' },
  statusInterrupted: { en: 'Stopped', 'zh-CN': '已中断' },
  statusPending: { en: 'Pending', 'zh-CN': '待开始' },
  statusDone: { en: 'Done', 'zh-CN': '已完成' },
  statusSkipped: { en: 'Skipped', 'zh-CN': '已跳过' },
  statusFailed: { en: 'Failed', 'zh-CN': '失败' },

  toolTitle: { en: 'Update steps', 'zh-CN': '更新步骤' },
  toolCleared: { en: 'Cleared checklist', 'zh-CN': '已清空清单' },
  toolStatusRunning: { en: 'Running', 'zh-CN': '运行中' },
  toolStatusDone: { en: 'Done', 'zh-CN': '已完成' },
  toolStatusError: { en: 'Failed', 'zh-CN': '失败' },
  toolFallbackUnavailable: { en: 'Details unavailable', 'zh-CN': '暂无结构化摘要' },
} as const satisfies Record<string, LocalizedText>

export function stepsHeaderStatusLabel(
  summary: StepsTraySummary,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  switch (summary.phase) {
    case 'completed':
      return resolveLocalizedText(STEPS_COPY.statusCompleted, locale)
    case 'completed_with_failures':
      return resolveLocalizedText(STEPS_COPY.statusFailed, locale)
    case 'working':
      return resolveLocalizedText(STEPS_COPY.statusWorking, locale)
    case 'paused':
      return resolveLocalizedText(STEPS_COPY.statusPaused, locale)
    case 'interrupted':
      return resolveLocalizedText(STEPS_COPY.statusInterrupted, locale)
    case 'pending':
      return resolveLocalizedText(STEPS_COPY.statusPending, locale)
  }
}

export function stepsItemStatusLabel(
  status: StepStatus,
  isWorking: boolean,
  settledOutcome: StepsSettledOutcome | undefined,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  switch (status) {
    case 'done':
      return resolveLocalizedText(STEPS_COPY.statusDone, locale)
    case 'failed':
      return resolveLocalizedText(STEPS_COPY.statusFailed, locale)
    case 'skipped':
      return resolveLocalizedText(STEPS_COPY.statusSkipped, locale)
    case 'pending':
      return resolveLocalizedText(STEPS_COPY.statusPending, locale)
    case 'in_progress':
      if (isWorking) return resolveLocalizedText(STEPS_COPY.statusWorking, locale)
      return resolveLocalizedText(
        settledOutcome === 'aborted' ? STEPS_COPY.statusInterrupted : STEPS_COPY.statusPaused,
        locale,
      )
  }
}

export function stepsTrayHeaderCount(
  summary: StepsTraySummary,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  if (summary.phase === 'completed') {
    return isZh(locale) ? `已完成 ${summary.done}/${summary.total} 步` : `Completed ${summary.done}/${summary.total} steps`
  }
  if (summary.phase === 'completed_with_failures') {
    return isZh(locale)
      ? `${summary.done}/${summary.total} 完成 · ${summary.failed} 项失败`
      : `${summary.done}/${summary.total} done · ${summary.failed} failed`
  }
  if (summary.phase === 'paused') {
    return isZh(locale) ? '已暂停' : 'Paused'
  }
  if (summary.phase === 'interrupted') {
    return isZh(locale) ? '已中断' : 'Stopped'
  }
  return isZh(locale) ? '步骤进度' : 'Steps'
}

export function stepsTrayFrontline(
  summary: StepsTraySummary,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string | undefined {
  if (summary.phase === 'completed') return undefined
  if (summary.activeTitle !== undefined) return summary.activeTitle
  return isZh(locale)
    ? `共 ${summary.total} 步`
    : `${summary.total} steps`
}

export function stepsToolRowSummary(
  meta: StepsToolPresentationMeta,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  if (meta.cleared) {
    return resolveLocalizedText(STEPS_COPY.toolCleared, locale)
  }
  if (meta.allTerminal && meta.failedCount === 0) {
    return isZh(locale)
      ? `已完成 ${meta.done}/${meta.total} 步`
      : `Completed ${meta.done}/${meta.total}`
  }
  if (meta.inProgressTitle !== undefined) {
    return meta.inProgressTitle
  }
  if (meta.failedCount > 0) {
    return isZh(locale) ? `${meta.failedCount} 项失败` : `${meta.failedCount} failed`
  }
  return isZh(locale) ? `共 ${meta.total} 步` : `${meta.total} steps`
}

export function stepsDismissFailedNotice(
  message: string,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  const action = resolveLocalizedText(STEPS_COPY.actionDismiss, locale)
  return isZh(locale) ? `${action}失败：${message}` : `${action} failed: ${message}`
}
