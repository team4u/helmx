/**
 * Bilingual display copy dictionary for builtin:plan client surfaces (en / zh-CN).
 * Zero Emoji; concise engineering language (Fast Refresh friendly).
 */
import {
  DEFAULT_HELMX_LOCALE,
  resolveLocalizedText,
  type HelmxLocale,
  type LocalizedText,
} from '@helmx/plugin-client'
import type { PlanMode, PlanProposeOutcome } from './types.ts'

const isZh = (locale: HelmxLocale): boolean => locale === 'zh-CN'

export const PLAN_COPY = {
  // Toolbar button
  toolbarNormal: { en: 'Plan', 'zh-CN': '规划' },
  toolbarPlanning: { en: 'Planning', 'zh-CN': '规划中' },
  toolbarAwaiting: { en: 'Awaiting approval', 'zh-CN': '待审批' },
  toolbarTitleNormal: {
    en: 'Plan mode is off — click to enter planning mode',
    'zh-CN': '规划模式已关闭 — 点击进入规划模式',
  },
  toolbarTitlePlanning: {
    en: 'Planning mode active — click to exit planning mode',
    'zh-CN': '规划模式已开启 — 点击退出规划模式',
  },
  toolbarTitleAwaiting: {
    en: 'Plan awaiting approval — click to toggle planning mode',
    'zh-CN': '计划等待审批 — 点击切换规划模式',
  },
  toolbarTitleStandbyNormal: {
    en: 'Start first message in planning mode',
    'zh-CN': '首条消息将以规划模式开始',
  },
  toolbarTitleStandbyArmed: {
    en: 'Planning mode armed for first message — click to cancel',
    'zh-CN': '已预设首条消息进入规划模式 — 点击取消',
  },

  // Active tray
  trayRegionAria: { en: 'Active planning mode', 'zh-CN': '进行中的规划模式' },
  trayPlanningStatus: { en: 'Planning', 'zh-CN': '规划中' },
  trayAwaitingStatus: { en: 'Awaiting approval', 'zh-CN': '等待审批' },
  trayNoDraftTitle: { en: 'Planning session', 'zh-CN': '规划会话' },
  trayNoDraftHint: { en: 'No draft saved yet', 'zh-CN': '暂未保存计划草稿' },
  trayOpenPlan: { en: 'View plan', 'zh-CN': '查看计划' },
  trayExitPlanning: { en: 'Exit', 'zh-CN': '退出' },
  trayExpand: { en: 'Expand planning details', 'zh-CN': '展开规划详情' },
  trayCollapse: { en: 'Collapse planning details', 'zh-CN': '收起规划详情' },

  // Workbench panel
  panelTitle: { en: 'Plan', 'zh-CN': '执行计划' },
  modeNormal: { en: 'Normal', 'zh-CN': '普通模式' },
  modePlanning: { en: 'Planning', 'zh-CN': '规划模式' },
  modeAwaiting: { en: 'Awaiting approval', 'zh-CN': '等待审批' },
  enterPlanning: { en: 'Enter planning', 'zh-CN': '进入规划模式' },
  exitPlanning: { en: 'Exit planning', 'zh-CN': '退出规划模式' },
  loading: { en: 'Loading plan…', 'zh-CN': '正在加载计划…' },
  loadError: { en: 'Failed to sync plan state.', 'zh-CN': '计划状态同步失败。' },
  retry: { en: 'Retry', 'zh-CN': '重试' },
  noConversation: {
    en: 'Select a conversation to view its plan.',
    'zh-CN': '请选择一个会话以查看执行计划。',
  },
  ineligibleConversation: {
    en: 'Plan mode is only available on top-level human conversations.',
    'zh-CN': '仅顶层人类直连会话支持规划模式。',
  },
  emptyTitle: { en: 'No plan draft yet', 'zh-CN': '暂无计划草稿' },
  emptyHint: {
    en: 'Enter planning mode to draft and review an implementation plan before making edits.',
    'zh-CN': '进入规划模式后，可先起草并审阅执行计划再开始修改。',
  },
  draftEmptyMarkdown: { en: 'Plan draft body is empty.', 'zh-CN': '计划草稿内容为空。' },
  copyDraft: { en: 'Copy plan', 'zh-CN': '复制计划' },
  approvedSectionTitle: { en: 'Latest Approved Plan', 'zh-CN': '最近已批准计划' },
  approvedKvPlan: { en: 'Plan', 'zh-CN': '计划' },
  approvedKvArtifact: { en: 'Artifact', 'zh-CN': '产物' },
  approvedKvArtifactId: { en: 'Artifact ID', 'zh-CN': '产物 ID' },
  approvedKvApprovedAt: { en: 'Approved', 'zh-CN': '批准时间' },
  approvedKvHandoff: { en: 'Handoff', 'zh-CN': '模型切换执行' },
  approvedKvExecutionModel: { en: 'Execution model', 'zh-CN': '执行模型' },
  handoffYes: { en: 'Yes (switched on approval)', 'zh-CN': '是（批准后切换执行）' },
  handoffNo: { en: 'No (same session)', 'zh-CN': '否（当前会话继续）' },

  // Tool rows
  toolSaveTitle: { en: 'Save plan', 'zh-CN': '保存计划' },
  toolProposeTitle: { en: 'Propose plan', 'zh-CN': '提交计划审批' },
  toolStatusRunning: { en: 'Running', 'zh-CN': '运行中' },
  toolStatusSaved: { en: 'Saved', 'zh-CN': '已保存' },
  toolStatusDone: { en: 'Completed', 'zh-CN': '已完成' },
  toolStatusError: { en: 'Failed', 'zh-CN': '失败' },
  toolFallbackUnavailable: { en: 'Details unavailable', 'zh-CN': '暂无结构化摘要' },
  toolOpenWorkbench: { en: 'Open Plan panel', 'zh-CN': '在工作台查看计划' },

  // Outcomes
  outcomeApproved: { en: 'Approved', 'zh-CN': '已批准' },
  outcomeApprovedHandoff: { en: 'Approved · Handoff', 'zh-CN': '已批准 · 切换模型' },
  outcomeRevised: { en: 'Revision requested', 'zh-CN': '退回修改' },
  outcomeCancelled: { en: 'Cancelled', 'zh-CN': '已取消' },
  outcomeSuperseded: { en: 'Superseded', 'zh-CN': '已失效' },
  outcomeError: { en: 'Failed', 'zh-CN': '失败' },

  // Action labels
  actionToggle: { en: 'Toggle plan mode', 'zh-CN': '切换规划模式' },
  actionExit: { en: 'Exit planning mode', 'zh-CN': '退出规划模式' },
} as const satisfies Record<string, LocalizedText>

const OUTCOME_COPY: Record<PlanProposeOutcome, LocalizedText> = {
  approved: PLAN_COPY.outcomeApproved,
  approved_handoff: PLAN_COPY.outcomeApprovedHandoff,
  revised: PLAN_COPY.outcomeRevised,
  cancelled: PLAN_COPY.outcomeCancelled,
  superseded: PLAN_COPY.outcomeSuperseded,
  error: PLAN_COPY.outcomeError,
}

export function planVersionLabel(version: number): string {
  return `v${version}`
}

export function planModeLabel(
  mode: PlanMode,
  awaitingApproval: boolean,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  if (awaitingApproval) return resolveLocalizedText(PLAN_COPY.modeAwaiting, locale)
  return resolveLocalizedText(mode === 'planning' ? PLAN_COPY.modePlanning : PLAN_COPY.modeNormal, locale)
}

export function planOutcomeLabel(
  outcome: PlanProposeOutcome,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  return resolveLocalizedText(OUTCOME_COPY[outcome], locale)
}

export function planSaveStatsLabel(
  lineCount: number,
  charCount: number,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  if (isZh(locale)) {
    return `${lineCount} 行 · ${charCount} 字符`
  }
  const lineUnit = lineCount === 1 ? 'line' : 'lines'
  return `${lineCount} ${lineUnit} · ${charCount} chars`
}

export function planUpdatedLabel(
  formattedTimestamp: string,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  return isZh(locale) ? `更新于 ${formattedTimestamp}` : `Updated ${formattedTimestamp}`
}

export function planDraftTrayMeta(
  hasDraft: boolean,
  awaitingApproval: boolean,
  updatedText: string | undefined,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  if (!hasDraft) return resolveLocalizedText(PLAN_COPY.trayNoDraftHint, locale)
  const statusText = resolveLocalizedText(
    awaitingApproval ? PLAN_COPY.trayAwaitingStatus : PLAN_COPY.trayPlanningStatus,
    locale,
  )
  return updatedText ? `${statusText} · ${updatedText}` : statusText
}

export function planActionFailedNotice(
  actionLabel: string,
  message: string,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  return isZh(locale) ? `${actionLabel}失败：${message}` : `${actionLabel} failed: ${message}`
}
