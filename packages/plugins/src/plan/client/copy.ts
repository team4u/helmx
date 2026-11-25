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
import type { PlanAskOutcome, PlanMode, PlanProposeOutcome } from './types.ts'

const isZh = (locale: HelmxLocale): boolean => locale === 'zh-CN'

export const PLAN_COPY = {
  // Unified + menu item & active-only toolbar pill
  menuLabel: { en: 'Plan mode', 'zh-CN': '计划模式' },
  toolbarNormal: { en: 'Plan', 'zh-CN': '计划' },
  toolbarPlanning: { en: 'Plan', 'zh-CN': '计划' },
  toolbarAwaiting: { en: 'Awaiting approval', 'zh-CN': '待审批' },
  toolbarAwaitingClarification: { en: 'Awaiting answers', 'zh-CN': '待澄清' },
  toolbarTitleNormal: {
    en: 'Plan mode is off — click to enter plan mode (Ctrl+.)',
    'zh-CN': '计划模式已关闭 — 点击进入计划模式 (Ctrl+.)',
  },
  toolbarTitlePlanning: {
    en: 'Plan mode active — click to exit plan mode (Ctrl+.)',
    'zh-CN': '计划模式已开启 — 点击退出计划模式 (Ctrl+.)',
  },
  toolbarTitleAwaiting: {
    en: 'Plan awaiting approval — click to toggle plan mode (Ctrl+.)',
    'zh-CN': '计划等待审批 — 点击切换计划模式 (Ctrl+.)',
  },
  toolbarTitleAwaitingClarification: {
    en: 'Clarifying questions awaiting response — click to toggle plan mode (Ctrl+.)',
    'zh-CN': '澄清问题等待回复 — 点击切换计划模式 (Ctrl+.)',
  },
  toolbarTitleStandbyNormal: {
    en: 'Start first message in plan mode (Ctrl+.)',
    'zh-CN': '首条消息将以计划模式开始 (Ctrl+.)',
  },
  toolbarTitleStandbyArmed: {
    en: 'Plan mode armed for first message — click to cancel (Ctrl+.)',
    'zh-CN': '已预设首条消息进入计划模式 — 点击取消 (Ctrl+.)',
  },

  // Active tray
  trayRegionAria: { en: 'Active plan mode', 'zh-CN': '进行中的计划模式' },
  trayPlanningStatus: { en: 'Planning', 'zh-CN': '计划中' },
  trayAwaitingStatus: { en: 'Awaiting approval', 'zh-CN': '等待审批' },
  trayClarifyingStatus: { en: 'Awaiting answers', 'zh-CN': '等待澄清' },
  trayNoDraftTitle: { en: 'Plan session', 'zh-CN': '计划会话' },
  trayNoDraftHint: { en: 'No draft saved yet', 'zh-CN': '暂未保存计划草稿' },
  trayOpenPlan: { en: 'View plan', 'zh-CN': '查看计划' },
  trayExitPlanning: { en: 'Exit', 'zh-CN': '退出' },
  trayExpand: { en: 'Expand plan details', 'zh-CN': '展开计划详情' },
  trayCollapse: { en: 'Collapse plan details', 'zh-CN': '收起计划详情' },

  // Workbench panel
  panelTitle: { en: 'Plan', 'zh-CN': '执行计划' },
  modeNormal: { en: 'Normal', 'zh-CN': '普通模式' },
  modePlanning: { en: 'Planning', 'zh-CN': '计划模式' },
  modeAwaiting: { en: 'Awaiting approval', 'zh-CN': '等待审批' },
  modeClarifying: { en: 'Awaiting answers', 'zh-CN': '等待澄清' },
  enterPlanning: { en: 'Enter plan mode', 'zh-CN': '进入计划模式' },
  exitPlanning: { en: 'Exit plan mode', 'zh-CN': '退出计划模式' },
  loading: { en: 'Loading plan…', 'zh-CN': '正在加载计划…' },
  loadError: { en: 'Failed to sync plan state.', 'zh-CN': '计划状态同步失败。' },
  retry: { en: 'Retry', 'zh-CN': '重试' },
  noConversation: {
    en: 'Select a conversation to view its plan.',
    'zh-CN': '请选择一个会话以查看执行计划。',
  },
  ineligibleConversation: {
    en: 'Plan mode is only available on top-level human conversations.',
    'zh-CN': '仅顶层人类直连会话支持计划模式。',
  },
  emptyTitle: { en: 'No plan draft yet', 'zh-CN': '暂无计划草稿' },
  emptyHint: {
    en: 'Enter plan mode to draft and review an implementation plan before making edits.',
    'zh-CN': '进入计划模式后，可先起草并审阅执行计划再开始修改。',
  },
  draftEmptyMarkdown: { en: 'Plan draft body is empty.', 'zh-CN': '计划草稿内容为空。' },
  copyDraft: { en: 'Copy plan', 'zh-CN': '复制计划' },
  editDraft: { en: 'Edit', 'zh-CN': '编辑' },
  saveDraft: { en: 'Save', 'zh-CN': '保存' },
  cancelEdit: { en: 'Cancel', 'zh-CN': '取消' },
  editTitleLabel: { en: 'Plan title', 'zh-CN': '计划标题' },
  editMarkdownLabel: { en: 'Plan markdown', 'zh-CN': '计划内容' },
  loadLatestDraft: { en: 'Load latest', 'zh-CN': '加载最新版' },
  approvedSectionTitle: { en: 'Latest Approved Plan', 'zh-CN': '最近已批准计划' },
  approvedKvPlan: { en: 'Plan', 'zh-CN': '计划' },
  approvedKvArtifact: { en: 'Artifact', 'zh-CN': '产物' },
  approvedKvArtifactId: { en: 'Artifact ID', 'zh-CN': '产物 ID' },
  approvedKvApprovedAt: { en: 'Approved', 'zh-CN': '批准时间' },
  approvedKvHandoff: { en: 'Context handoff', 'zh-CN': '上下文交接' },
  approvedKvExecutionModel: { en: 'Execution model', 'zh-CN': '执行模型' },
  handoffYes: { en: 'Fresh context', 'zh-CN': '新上下文执行' },
  handoffNo: { en: 'Same context', 'zh-CN': '沿用当前上下文' },

  // Tool rows
  toolSaveTitle: { en: 'Save plan', 'zh-CN': '保存计划' },
  toolProposeTitle: { en: 'Propose plan', 'zh-CN': '提交计划审批' },
  toolAskTitle: { en: 'Clarifying questions', 'zh-CN': '需求澄清' },
  toolStatusRunning: { en: 'Running', 'zh-CN': '运行中' },
  toolStatusSaved: { en: 'Saved', 'zh-CN': '已保存' },
  toolStatusDone: { en: 'Completed', 'zh-CN': '已完成' },
  toolStatusError: { en: 'Failed', 'zh-CN': '失败' },
  toolFallbackUnavailable: { en: 'Details unavailable', 'zh-CN': '暂无结构化摘要' },
  toolOpenWorkbench: { en: 'Open Plan panel', 'zh-CN': '在工作台查看计划' },

  // Propose outcomes
  outcomeApproved: { en: 'Approved', 'zh-CN': '已批准' },
  outcomeApprovedHandoff: { en: 'Approved · Fresh context', 'zh-CN': '已批准 · 新上下文' },
  outcomeRevised: { en: 'Revision requested', 'zh-CN': '退回修改' },
  outcomeCancelled: { en: 'Cancelled', 'zh-CN': '已取消' },
  outcomeSuperseded: { en: 'Superseded', 'zh-CN': '已失效' },
  outcomeError: { en: 'Failed', 'zh-CN': '失败' },

  // Ask outcomes
  askOutcomeAnswered: { en: 'Answered', 'zh-CN': '已回答' },
  askOutcomeCancelled: { en: 'Cancelled', 'zh-CN': '已取消' },
  askOutcomeSuperseded: { en: 'Superseded', 'zh-CN': '已失效' },
  askOutcomeError: { en: 'Failed', 'zh-CN': '失败' },

  // Action labels
  actionToggle: { en: 'Toggle plan mode', 'zh-CN': '切换计划模式' },
  actionExit: { en: 'Exit plan mode', 'zh-CN': '退出计划模式' },
  actionUpdateDraft: { en: 'Save plan draft', 'zh-CN': '保存计划草稿' },
} as const satisfies Record<string, LocalizedText>

const OUTCOME_COPY: Record<PlanProposeOutcome, LocalizedText> = {
  approved: PLAN_COPY.outcomeApproved,
  approved_handoff: PLAN_COPY.outcomeApprovedHandoff,
  revised: PLAN_COPY.outcomeRevised,
  cancelled: PLAN_COPY.outcomeCancelled,
  superseded: PLAN_COPY.outcomeSuperseded,
  error: PLAN_COPY.outcomeError,
}

const ASK_OUTCOME_COPY: Record<PlanAskOutcome, LocalizedText> = {
  answered: PLAN_COPY.askOutcomeAnswered,
  cancelled: PLAN_COPY.askOutcomeCancelled,
  superseded: PLAN_COPY.askOutcomeSuperseded,
  error: PLAN_COPY.askOutcomeError,
}

export function planVersionLabel(version: number): string {
  return `v${version}`
}

export function planModeLabel(
  mode: PlanMode,
  awaitingApproval: boolean,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
  awaitingClarification = false,
): string {
  if (awaitingApproval) return resolveLocalizedText(PLAN_COPY.modeAwaiting, locale)
  if (awaitingClarification) return resolveLocalizedText(PLAN_COPY.modeClarifying, locale)
  return resolveLocalizedText(mode === 'planning' ? PLAN_COPY.modePlanning : PLAN_COPY.modeNormal, locale)
}

export function planOutcomeLabel(
  outcome: PlanProposeOutcome,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  return resolveLocalizedText(OUTCOME_COPY[outcome], locale)
}

export function planAskOutcomeLabel(
  outcome: PlanAskOutcome,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  return resolveLocalizedText(ASK_OUTCOME_COPY[outcome], locale)
}

export function planAskQuestionCountLabel(
  count: number,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  if (isZh(locale)) return `${count} 个问题`
  return count === 1 ? '1 question' : `${count} questions`
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
  awaitingClarification = false,
): string {
  if (!hasDraft && !awaitingClarification) {
    return resolveLocalizedText(PLAN_COPY.trayNoDraftHint, locale)
  }
  const statusText = resolveLocalizedText(
    awaitingApproval
      ? PLAN_COPY.trayAwaitingStatus
      : awaitingClarification
        ? PLAN_COPY.trayClarifyingStatus
        : PLAN_COPY.trayPlanningStatus,
    locale,
  )
  return updatedText ? `${statusText} · ${updatedText}` : statusText
}

export function planStaleDraftWarning(
  latestVersion: number,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  return isZh(locale)
    ? `草稿已在外部更新至 v${latestVersion}，直接保存将触发版本冲突。`
    : `Draft updated externally to v${latestVersion}. Saving may conflict.`
}

export function planActionFailedNotice(
  actionLabel: string,
  message: string,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  return isZh(locale) ? `${actionLabel}失败：${message}` : `${actionLabel} failed: ${message}`
}
