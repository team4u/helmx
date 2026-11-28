/**
 * Bilingual UI copy (en / zh-CN) for `builtin:duo` client components (zero Emoji).
 */
import type { ModelPickerControlCopy } from '@helmx/plugin-client'
import type { HelmxLocale, LocalizedText } from '@helmx/protocol/browser'

export const DUO_COPY = {
  profileTitle: { en: 'Duo Mode (Planner / Executor)', 'zh-CN': '双相协同（规划 / 执行）' },
  profileSwitchLabel: { en: 'Enable Duo Mode', 'zh-CN': '开启双相协同' },
  profileSaveFirst: {
    en: 'Save this Profile first before configuring Duo execution defaults.',
    'zh-CN': '请先保存此 Profile，再配置双相协同的执行模型。',
  },
  profileDisabledHint: {
    en: 'Off by default. When enabled, top-level conversations using this Profile start in Planning Phase and switch to Executor for workspace edits.',
    'zh-CN': '默认关闭。开启后，使用此 Profile 的顶层会话将先由规划模型制定方案，再切换执行模型落地与验证。',
  },
  profilePlannerNote: {
    en: 'Planner always uses the conversation or Profile model. Choose the Executor model below:',
    'zh-CN': '规划模型跟随当前会话/Profile 配置；在下方设置执行模型：',
  },
  fieldExecutorModel: { en: 'Executor model', 'zh-CN': '执行模型' },
  pickExecutorModel: { en: 'Select executor model', 'zh-CN': '选择执行模型' },
  clearModel: { en: 'Clear model', 'zh-CN': '清空' },
  fieldMaxSteps: { en: 'Max execution steps', 'zh-CN': '执行步数上限' },
  fieldMaxStepsHint: { en: '0 = unlimited', 'zh-CN': '0 为不限' },
  fieldMaxStepsUnit: { en: 'steps', 'zh-CN': '步' },
  save: { en: 'Save', 'zh-CN': '保存' },
  saving: { en: 'Saving…', 'zh-CN': '保存中…' },
  savedNotice: { en: 'Duo defaults saved.', 'zh-CN': '双相配置已保存。' },
  clearOverride: { en: 'Reset', 'zh-CN': '清除配置' },
  clearedNotice: { en: 'Duo configuration cleared.', 'zh-CN': '已清除双相配置。' },
  errExecutorRequired: {
    en: 'Select an Executor model before saving Duo Mode.',
    'zh-CN': '开启双相协同前请先选择执行模型。',
  },
  errMaxStepsInvalid: {
    en: 'Max execution steps must be an integer between 0 and 100 (0 = unlimited).',
    'zh-CN': '执行步数上限必须为 0 到 100 之间的整数（0 表示不限）。',
  },
  errModelDisabled: {
    en: 'The selected Executor model is currently disabled.',
    'zh-CN': '所选执行模型当前已禁用。',
  },
  errModelUnavailable: {
    en: 'The selected Executor model is currently unavailable in the model catalog.',
    'zh-CN': '所选执行模型当前不可用。',
  },
  menuLabel: { en: 'Duo Mode', 'zh-CN': '双相协同' },
  setupDialogTitle: { en: 'Enable Duo Mode', 'zh-CN': '开启双相协同' },
  setupDialogDescription: {
    en: 'Your current model acts as Planner. Pick an Executor model for code edits and verification.',
    'zh-CN': '当前会话模型将担任规划（Planner），请选择负责代码修改与验证的执行模型（Executor）。',
  },
  setupEnableBtn: { en: 'Enable Duo', 'zh-CN': '开启双相协同' },
  cancel: { en: 'Cancel', 'zh-CN': '取消' },
  pillBrand: { en: 'Duo', 'zh-CN': '双相' },
  pillPhasePlan: { en: 'Plan', 'zh-CN': '规划' },
  pillPhaseExec: { en: 'Exec', 'zh-CN': '执行' },
  pillPhaseCoord: { en: 'Coordinator', 'zh-CN': '协调' },
  popoverPhasePlanning: { en: 'Planning Phase', 'zh-CN': '规划阶段' },
  popoverPhaseExecution: { en: 'Execution Phase', 'zh-CN': '执行阶段' },
  popoverPhaseCoordinator: {
    en: 'Swarm Coordinator (Planner only; workers inherit Executor)',
    'zh-CN': 'Swarm 协调者（仅用规划模型；Worker 自动继承执行模型）',
  },
  popoverPlanner: { en: 'Planner', 'zh-CN': '规划模型' },
  popoverExecutor: { en: 'Executor', 'zh-CN': '执行模型' },
  popoverSteps: { en: 'Execution steps', 'zh-CN': '执行步数' },
  popoverActiveBadge: { en: 'Active', 'zh-CN': '当前' },
  popoverDisable: { en: 'Turn off Duo for this chat', 'zh-CN': '关闭本会话双相协同' },
  popoverRevertProfile: { en: 'Revert to Profile default', 'zh-CN': '恢复跟随 Profile' },
  toolExitPlanTitle: { en: 'Enter execution phase', 'zh-CN': '进入执行阶段' },
  toolHandBackTitle: { en: 'Hand back to planner', 'zh-CN': '交回规划阶段' },
  toolPhaseExec: { en: 'Executor', 'zh-CN': '执行' },
  toolPhasePlan: { en: 'Planner', 'zh-CN': '规划' },
  toolStatusRunning: { en: 'Switching', 'zh-CN': '切换中' },
  toolStatusDone: { en: 'Switched', 'zh-CN': '已切换' },
  toolStatusError: { en: 'Failed', 'zh-CN': '失败' },
} as const satisfies Record<string, LocalizedText>

export const duoActionFailed = (err: unknown, locale: HelmxLocale): string => {
  const detail = err instanceof Error ? err.message : String(err)
  return locale === 'zh-CN' ? `操作失败：${detail}` : `Operation failed: ${detail}`
}

export const duoPillTitle = (
  phase: 'planning' | 'execution',
  plannerModel: string,
  executorModel: string,
  steps: number,
  maxSteps: number,
  suppressed: boolean,
  locale: HelmxLocale,
): string => {
  if (suppressed) {
    return locale === 'zh-CN'
      ? `双相协同（Swarm 协调者 · 规划: ${plannerModel || '默认'} / 子 Worker: ${executorModel}）`
      : `Duo Mode (Swarm Coordinator · Planner: ${plannerModel || 'default'} / Worker default: ${executorModel})`
  }
  if (locale === 'zh-CN') {
    const phaseLabel =
      phase === 'execution'
        ? maxSteps > 0
          ? `执行阶段（${steps}/${maxSteps} 步）`
          : `执行阶段（第 ${steps} 步）`
        : '规划阶段'
    return `双相协同 · ${phaseLabel}（Planner: ${plannerModel || '默认'} / Executor: ${executorModel}）`
  }
  const phaseLabel =
    phase === 'execution'
      ? maxSteps > 0
        ? `Execution (${steps}/${maxSteps})`
        : `Execution (step ${steps})`
      : 'Planning'
  return `Duo Mode · ${phaseLabel} (Planner: ${plannerModel || 'default'} / Executor: ${executorModel})`
}

export const duoPopoverStepsValue = (steps: number, maxSteps: number, locale: HelmxLocale): string => {
  if (maxSteps > 0) return `${steps} / ${maxSteps}`
  return locale === 'zh-CN' ? `${steps}（不限）` : `${steps} (unlimited)`
}

export const duoTransitionSummary = (
  tool: 'exit_plan_mode' | 'hand_back_to_planner',
  toModelShort: string,
  reason: string | undefined,
  locale: HelmxLocale,
): string => {
  if (tool === 'exit_plan_mode') {
    return locale === 'zh-CN' ? `切换至执行模型 ${toModelShort}` : `Switched to executor ${toModelShort}`
  }
  const base =
    locale === 'zh-CN' ? `交回规划模型 ${toModelShort}` : `Returned to planner ${toModelShort}`
  return reason !== undefined && reason !== '' ? `${base} · ${reason}` : base
}

const ZH_PICKER_COPY: Partial<ModelPickerControlCopy> = {
  buttonAria: '模型与思考档位：{model}{level}',
  levelSuffix: ' · {level}',
  defaultLabel: '选择模型与思考档位',
  searchAria: '搜索模型',
  searchPlaceholder: '搜索模型…',
  refreshCatalog: '刷新动态模型目录',
  tiersHeader: '模型档位',
  tierRowTitle: '使用 {tier}（{model}）',
  listHeader: '模型列表',
  navHint: '↑↓ 选择 · Enter 确认',
  emptyCatalog: '暂无可用模型；请先在「模型与凭据」配置供应商密钥',
  noMatches: '没有匹配的模型',
  thinkingHeader: '思考档位',
  rowDefaultTitle: '使用 {model}（思考档位跟随默认）',
  levelChipTitle: '使用 {model} · 思考 {level}',
  catalogUnavailable: '模型目录不可用',
  catalogPartialFailure: '部分供应商目录刷新失败',
  catalogRefreshed: '已刷新模型目录',
  catalogRefreshFailed: '刷新模型目录失败',
}

export const buildDuoPickerCopy = (locale: HelmxLocale): Partial<ModelPickerControlCopy> =>
  locale === 'zh-CN' ? ZH_PICKER_COPY : {}
