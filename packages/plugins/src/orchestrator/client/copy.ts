/** Display copy for builtin:orchestrator client (Fast Refresh friendly; zero Emoji). */
import type { HelmxLocale, LocalizedText, ModelPickerControlCopy } from '@helmx/plugin-client'
import { formatModelShortName } from '@helmx/plugin-client'
import type { OrchestratorDraftValidationError, OrchestratorPhase } from './models.ts'

export const ORCHESTRATOR_COPY = {
  screenTitle: { en: 'Orchestrator', 'zh-CN': '编排器' },
  loading: { en: 'Loading orchestrators…', 'zh-CN': '正在加载编排器…' },
  createItem: { en: 'New Orchestrator', 'zh-CN': '新建编排器' },
  deleteItem: { en: 'Delete', 'zh-CN': '删除' },
  filterAria: { en: 'Filter orchestrators', 'zh-CN': '筛选编排器' },
  filterAll: { en: 'All', 'zh-CN': '全部' },
  filterReady: { en: 'Available', 'zh-CN': '可用' },
  filterAttention: { en: 'Attention', 'zh-CN': '异常' },
  searchPlaceholder: {
    en: 'Search orchestrators or models…',
    'zh-CN': '搜索编排器或模型…',
  },
  searchLabel: { en: 'Search orchestrators', 'zh-CN': '搜索编排器' },
  resetFilters: { en: 'Reset filters', 'zh-CN': '重置筛选' },

  emptyTitle: { en: 'No orchestrators yet', 'zh-CN': '暂无编排器' },
  emptyHint: {
    en: 'Pair a read-only Planner model with an Executor model into a selectable tier/<id>.',
    'zh-CN': '将只读规划模型与工作区执行模型配对为可直接选用的 tier/<id>。',
  },
  startersHeading: { en: 'Starter orchestrators', 'zh-CN': '推荐编排器' },
  starterPresetsLabel: { en: 'Presets', 'zh-CN': '推荐' },
  useStarter: { en: 'Bind', 'zh-CN': '绑定' },
  noMatchTitle: { en: 'No matching orchestrators', 'zh-CN': '未找到匹配的编排器' },

  statusAvailable: { en: 'Available', 'zh-CN': '可用' },
  statusDisabled: { en: 'Model disabled', 'zh-CN': '模型已禁用' },
  statusUnavailable: { en: 'Unavailable', 'zh-CN': '不可用' },

  plannerLabel: { en: 'Planner', 'zh-CN': '规划模型' },
  executorLabel: { en: 'Executor', 'zh-CN': '执行模型' },
  stepsLabel: { en: 'Execution steps', 'zh-CN': '执行步数' },
  activeBadge: { en: 'Active', 'zh-CN': '当前' },
  overrideBadge: { en: 'Override', 'zh-CN': '临时覆盖' },

  drawerCreateTitle: { en: 'New Orchestrator', 'zh-CN': '新建编排器' },
  drawerNotFoundTitle: { en: 'Orchestrator not found', 'zh-CN': '编排器不存在' },
  drawerNotFoundHint: {
    en: 'This orchestrator was removed or is not yet synced.',
    'zh-CN': '该编排器已被移除或尚未同步。',
  },
  fieldId: { en: 'Orchestrator ID', 'zh-CN': '编排器 ID' },
  fieldIdHintCreate: {
    en: 'Lowercase letters, digits, "-" or "_"; selected in model picker as tier/<id>.',
    'zh-CN': '支持小写字母、数字、"-" 或 "_"；保存后在模型选择器中作为 tier/<id> 选用。',
  },
  fieldIdHintLocked: {
    en: 'Orchestrator ID stays fixed after creation to preserve existing bindings.',
    'zh-CN': '创建后编排器 ID 保持固定，避免破坏已有角色或会话绑定。',
  },
  fieldName: { en: 'Display name', 'zh-CN': '显示名称' },
  fieldNamePlaceholder: { en: 'e.g. Orchestrator (Opus)', 'zh-CN': '例如：编排器（Opus）' },
  fieldPlanner: { en: 'Planner model', 'zh-CN': '规划模型' },
  fieldExecutor: { en: 'Executor model', 'zh-CN': '执行模型' },
  pickModelPlaceholder: {
    en: 'Select model or single-model tier',
    'zh-CN': '选择模型或单模型档位',
  },
  fieldMaxSteps: { en: 'Max execution steps', 'zh-CN': '执行步数上限' },
  fieldMaxStepsHint: { en: '0 = unlimited', 'zh-CN': '0 为不限' },
  stepsUnit: { en: 'steps', 'zh-CN': '步' },
  fieldDescription: { en: 'Description', 'zh-CN': '定位说明' },
  fieldDescriptionPlaceholder: {
    en: 'When to use this orchestrator (optional)',
    'zh-CN': '适用场景说明（可选）',
  },
  clearModel: { en: 'Clear model', 'zh-CN': '清空模型' },
  close: { en: 'Close', 'zh-CN': '关闭' },
  cancel: { en: 'Cancel', 'zh-CN': '取消' },
  saving: { en: 'Saving…', 'zh-CN': '正在保存…' },
  saveCreate: { en: 'Create', 'zh-CN': '创建' },
  saveUpdate: { en: 'Save', 'zh-CN': '保存' },

  deleteConfirmTitle: { en: 'Delete orchestrator?', 'zh-CN': '删除编排器？' },
  deleteConfirmDescription: {
    en: 'Removes tier/<id> from the model catalog immediately.',
    'zh-CN': '删除后 tier/<id> 将立即从模型目录移除。',
  },
  forceDeleteConfirmTitle: { en: 'Orchestrator is currently in use', 'zh-CN': '该编排器正在被使用' },
  forceDeleteConfirmAction: { en: 'Force delete', 'zh-CN': '强制删除' },

  settingsSummary: {
    en: 'Orchestrators pair a read-only Planner model with an Executor model as selectable tier/<id> options.',
    'zh-CN': '编排器将只读规划模型与工作区执行模型配对为可直接选用的 tier/<id> 档位。',
  },
  settingsKvTotal: { en: 'Orchestrators', 'zh-CN': '编排器总数' },
  settingsKvReady: { en: 'Available', 'zh-CN': '可用' },
  settingsOpenManager: { en: 'Open Orchestrator', 'zh-CN': '打开编排器管理' },
  settingsDisabledAlert: {
    en: 'Enable builtin:orchestrator to configure and run Orchestrators.',
    'zh-CN': '启用 builtin:orchestrator 插件后即可配置并运行编排器。',
  },

  statusPlan: { en: 'Plan', 'zh-CN': '规划' },
  statusExec: { en: 'Exec', 'zh-CN': '执行' },
  statusCoord: { en: 'Coord', 'zh-CN': '协调' },
  phasePlanning: { en: 'Planning', 'zh-CN': '规划阶段' },
  phaseExecution: { en: 'Execution', 'zh-CN': '执行阶段' },
  phaseCoordinator: { en: 'Coordinator', 'zh-CN': '协调让位' },
  pillEdit: { en: 'Edit orchestrator', 'zh-CN': '编辑编排器' },
  pillClearOverride: { en: 'Reset override', 'zh-CN': '恢复默认' },
  pillStepLimitPaused: {
    en: 'Execution step limit reached — workspace tools paused until handed back to Planner.',
    'zh-CN': '已达执行步数上限，工作区写工具已暂停，等待交回规划模型。',
  },
  pillCoordinatorHint: {
    en: 'Swarm coordinator stays on Planner while dispatched workers inherit this Executor.',
    'zh-CN': 'Swarm 协调者保持使用规划模型，派发出的 Worker 会继承下方执行模型。',
  },

  toolExitPlanTitle: { en: 'Enter execution phase', 'zh-CN': '切换执行阶段' },
  toolHandBackTitle: { en: 'Hand back to planner', 'zh-CN': '交回规划阶段' },
  toolPhaseExec: { en: 'Executor', 'zh-CN': '执行' },
  toolPhasePlan: { en: 'Planner', 'zh-CN': '规划' },
  toolStatusRunning: { en: 'Switching', 'zh-CN': '切换中' },
  toolStatusError: { en: 'Failed', 'zh-CN': '失败' },
} as const satisfies Record<string, LocalizedText>

const ZH_PICKER_COPY: Partial<ModelPickerControlCopy> = {
  searchPlaceholder: '搜索模型或单模型档位…',
  searchAria: '搜索模型或单模型档位',
  tiersHeader: '单模型档位',
  listHeader: '全部模型',
  emptyCatalog: '暂无可用模型',
  noMatches: '无匹配模型',
  thinkingHeader: '思考档位',
  refreshCatalog: '刷新模型目录',
  navHint: '↑↓ 选择 · Enter 确认',
  catalogUnavailable: '模型目录不可用',
}

const EN_PICKER_COPY: Partial<ModelPickerControlCopy> = {
  searchPlaceholder: 'Search models or single-model tiers…',
  tiersHeader: 'Single-model tiers',
}

export const buildOrchestratorPickerCopy = (locale: HelmxLocale): Partial<ModelPickerControlCopy> =>
  locale === 'zh-CN' ? ZH_PICKER_COPY : EN_PICKER_COPY

export function getOrchestratorValidationMessage(
  err: OrchestratorDraftValidationError,
  locale: HelmxLocale,
): string {
  const zh = locale === 'zh-CN'
  switch (err) {
    case 'id_required':
      return zh ? '请填写编排器 ID。' : 'Orchestrator ID is required.'
    case 'id_invalid':
      return zh
        ? '编排器 ID 仅支持小写字母、数字、"-" 与 "_"，且须以字母或数字开头。'
        : 'Orchestrator ID must match /^[a-z0-9][a-z0-9_-]{0,63}$/.'
    case 'id_conflict':
      return zh ? '该 ID 已被其他模型档位或编排器占用。' : 'This ID is already used by another tier or orchestrator.'
    case 'name_required':
      return zh ? '请填写显示名称。' : 'Display name is required.'
    case 'name_too_long':
      return zh ? '显示名称不得超过 80 个字符。' : 'Display name must be 80 characters or fewer.'
    case 'planner_required':
      return zh ? '请选择规划模型。' : 'Planner model is required.'
    case 'planner_orchestrator_ref':
      return zh ? '规划模型不能引用编排器自身或其他编排器。' : 'Planner model cannot reference an Orchestrator.'
    case 'executor_required':
      return zh ? '请选择执行模型。' : 'Executor model is required.'
    case 'executor_orchestrator_ref':
      return zh ? '执行模型不能引用编排器自身或其他编排器。' : 'Executor model cannot reference an Orchestrator.'
    case 'steps_invalid':
      return zh ? '执行步数上限须为 0 到 100 的整数。' : 'Max execution steps must be an integer from 0 to 100.'
    case 'description_too_long':
      return zh ? '定位说明不得超过 240 个字符。' : 'Description must be 240 characters or fewer.'
  }
}

export function formatOrchestratorPopoverStepsValue(
  steps: number,
  maxSteps: number,
  locale: HelmxLocale,
): string {
  if (maxSteps > 0) return `${steps} / ${maxSteps}`
  return locale === 'zh-CN' ? `${steps}（不限）` : `${steps} (unlimited)`
}

export function formatOrchestratorStepsBadge(maxSteps: number, locale: HelmxLocale): string {
  if (maxSteps <= 0) return locale === 'zh-CN' ? '不限步数' : 'Unlimited'
  return locale === 'zh-CN' ? `${maxSteps} 步` : `${maxSteps} steps`
}

export function formatOrchestratorStatusTitle(
  orchestratorName: string,
  orchestratorId: string,
  phase: OrchestratorPhase,
  suppressed: boolean,
  plannerModel: string,
  executorModel: string,
  steps: number,
  maxSteps: number,
  locale: HelmxLocale,
): string {
  if (locale === 'zh-CN') {
    const phaseLabel = suppressed
      ? '协调让位（保持规划模型）'
      : phase === 'execution'
        ? maxSteps > 0
          ? `执行阶段（${steps}/${maxSteps} 步）`
          : `执行阶段（第 ${steps} 步 · 不限步数）`
        : '规划阶段'
    return `${orchestratorName}（tier/${orchestratorId}） · ${phaseLabel}（规划模型: ${plannerModel} / 执行模型: ${executorModel}）`
  }
  const phaseLabel = suppressed
    ? 'Coordinator (stays on Planner)'
    : phase === 'execution'
      ? maxSteps > 0
        ? `Execution (${steps}/${maxSteps} steps)`
        : `Execution (step ${steps} · unlimited)`
      : 'Planning'
  return `${orchestratorName} (tier/${orchestratorId}) · ${phaseLabel} (Planner: ${plannerModel} / Executor: ${executorModel})`
}

export function formatOrchestratorSavedNotice(id: string, locale: HelmxLocale): string {
  return locale === 'zh-CN' ? `已保存编排器 tier/${id}` : `Saved orchestrator tier/${id}`
}

export function formatOrchestratorRemovedNotice(id: string, locale: HelmxLocale): string {
  return locale === 'zh-CN' ? `已删除编排器 tier/${id}` : `Deleted orchestrator tier/${id}`
}

export function formatOrchestratorOverrideUpdatedNotice(modelRef: string, locale: HelmxLocale): string {
  const short = formatModelShortName(modelRef)
  return locale === 'zh-CN'
    ? `当前会话执行模型已临时覆盖为 ${short}`
    : `Temporarily overrode Executor to ${short}`
}

export function formatOrchestratorOverrideClearedNotice(locale: HelmxLocale): string {
  return locale === 'zh-CN' ? '已恢复编排器默认执行模型' : 'Reset Executor to orchestrator default'
}

export function formatOrchestratorTransitionSummary(
  tool: 'exit_plan_mode' | 'hand_back_to_planner',
  toModelShort: string,
  reason: string | undefined,
  locale: HelmxLocale,
): string {
  if (tool === 'exit_plan_mode') {
    return locale === 'zh-CN'
      ? `切换至执行模型 ${toModelShort}`
      : `Switched to executor ${toModelShort}`
  }
  const base = locale === 'zh-CN'
    ? `交回规划模型 ${toModelShort}`
    : `Returned to planner ${toModelShort}`
  return reason !== undefined && reason !== '' ? `${base} · ${reason}` : base
}
