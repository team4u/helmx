import type { HelmxLocale, LocalizedText, ModelPickerControlCopy } from '@helmx/plugin-client'
import { formatModelShortName } from '@helmx/plugin-client'
import type { DuoDraftValidationError, DuoPhase } from './models.ts'

export const DUO_COPY = {
  screenTitle: { en: 'Duo Recipes', 'zh-CN': '双相配方' },
  screenSubtitle: {
    en: 'Pair a Planner model with an Executor model and expose them as selectable tier/<id> recipes.',
    'zh-CN': '将规划模型与执行模型配对为 tier/<id> 双相配方，可在会话与角色中直接选用。',
  },
  searchPlaceholder: {
    en: 'Search recipes by name, id, or model…',
    'zh-CN': '按配方名、ID 或模型检索…',
  },
  searchLabel: { en: 'Search Duo recipes', 'zh-CN': '搜索双相配方' },
  createRecipe: { en: 'New recipe', 'zh-CN': '新建配方' },
  editRecipe: { en: 'Edit', 'zh-CN': '编辑' },
  deleteRecipe: { en: 'Delete', 'zh-CN': '删除' },
  clearSearch: { en: 'Clear search', 'zh-CN': '清空搜索' },

  emptyTitle: { en: 'No Duo recipes yet', 'zh-CN': '尚未配置双相配方' },
  emptyHint: {
    en: 'Create a Planner + Executor recipe so conversations can plan read-only and execute with a dedicated model.',
    'zh-CN': '创建一个“规划模型 + 执行模型”配方，会话即可自动在只读规划与工作区执行间切换。',
  },
  startersHeading: { en: 'Starter recipes', 'zh-CN': '推荐起步配对' },
  startersHint: {
    en: 'Pre-fill a recipe draft from your configured models or single-model tiers.',
    'zh-CN': '基于当前可用模型与单模型档位一键预填配方草稿。',
  },
  useStarter: { en: 'Use template', 'zh-CN': '使用此配对' },
  noMatchTitle: { en: 'No matching Duo recipes', 'zh-CN': '没有匹配的双相配方' },

  statusAvailable: { en: 'Ready', 'zh-CN': '就绪' },
  statusDisabled: { en: 'Disabled model', 'zh-CN': '关联模型已禁用' },
  statusUnavailable: { en: 'Unavailable', 'zh-CN': '不可用' },

  plannerLabel: { en: 'Planner', 'zh-CN': '规划' },
  executorLabel: { en: 'Executor', 'zh-CN': '执行' },
  unlimitedSteps: { en: 'Unlimited steps', 'zh-CN': '不限步数' },
  stepsCapSuffix: { en: 'steps max', 'zh-CN': '步上限' },
  overrideBadge: { en: 'Override', 'zh-CN': '临时覆盖' },

  drawerCreateTitle: { en: 'Create Duo Recipe', 'zh-CN': '新建双相配方' },
  drawerNotFoundTitle: { en: 'Recipe not found', 'zh-CN': '配方不存在' },
  drawerNotFoundHint: {
    en: 'This recipe was removed or is not yet synced.',
    'zh-CN': '该配方已被移除或尚未同步。',
  },
  fieldId: { en: 'Recipe ID', 'zh-CN': '配方 ID' },
  fieldIdHintCreate: {
    en: 'Lowercase letters, digits, "-" or "_"; selected in model picker as tier/<id>.',
    'zh-CN': '支持小写字母、数字、"-" 或 "_"；保存后在模型选择器中作为 tier/<id> 选用。',
  },
  fieldIdHintLocked: {
    en: 'Mounted in the model picker as tier/<id>.',
    'zh-CN': '当前已在模型选择器中挂载为 tier/<id>。',
  },
  fieldName: { en: 'Display name', 'zh-CN': '配方名称' },
  fieldNamePlaceholder: { en: 'e.g. Architect -> Coder', 'zh-CN': '例如：架构规划 -> 工程实现' },
  fieldPlanner: { en: 'Planner model', 'zh-CN': '规划模型' },
  fieldExecutor: { en: 'Executor model', 'zh-CN': '执行模型' },
  pickModelPlaceholder: {
    en: 'Select model or single-model tier',
    'zh-CN': '选择模型或单模型档位',
  },
  fieldMaxSteps: { en: 'Max execution steps', 'zh-CN': '最大执行步数' },
  fieldMaxStepsHint: {
    en: 'Auto-pauses execution to hand back to Planner after N steps (0 = unlimited).',
    'zh-CN': '达到步数上限后自动暂停并交还规划端评估（填 0 表示不限）。',
  },
  fieldDescription: { en: 'Description', 'zh-CN': '说明' },
  fieldDescriptionPlaceholder: {
    en: 'Optional short summary shown in the model picker and search results.',
    'zh-CN': '可选简短描述，将展示在模型选择器与全局搜索结果中。',
  },
  clearModel: { en: 'Clear selection', 'zh-CN': '清除选择' },
  close: { en: 'Close', 'zh-CN': '关闭' },
  cancel: { en: 'Cancel', 'zh-CN': '取消' },
  saveCreate: { en: 'Create recipe', 'zh-CN': '创建配方' },
  saveUpdate: { en: 'Save changes', 'zh-CN': '保存修改' },

  deleteConfirmTitle: { en: 'Delete Duo recipe?', 'zh-CN': '删除双相配方？' },
  deleteConfirmDescription: {
    en: 'Removes tier/<id> from the model catalog immediately.',
    'zh-CN': '删除后 tier/<id> 将立即从模型目录移除。',
  },
  forceDeleteConfirmTitle: { en: 'Recipe is currently in use', 'zh-CN': '该配方正在被使用' },
  forceDeleteConfirmAction: { en: 'Force delete', 'zh-CN': '强制删除' },

  settingsSummary: {
    en: 'Dual-phase recipes pair a read-only Planner with an Executor model and mount as selectable tier/<id> options.',
    'zh-CN': '双相配方将只读规划模型与工作区执行模型配对，并挂载为可直接选用的 tier/<id> 档位。',
  },
  settingsKvRecipes: { en: 'Recipes', 'zh-CN': '已配置配方' },
  settingsKvReady: { en: 'Ready', 'zh-CN': '可用配方' },
  settingsOpenManager: { en: 'Manage Duo Recipes', 'zh-CN': '打开双相配方管理' },
  settingsDisabledAlert: {
    en: 'Enable builtin:duo to configure and run Dual-Phase Recipes.',
    'zh-CN': '启用 builtin:duo 插件后即可配置并运行双相协同配方。',
  },

  pillPlanning: { en: 'Planning', 'zh-CN': '规划' },
  pillExecuting: { en: 'Executing', 'zh-CN': '执行' },
  pillStandby: { en: 'Duo', 'zh-CN': '双相' },
  pillSuppressed: { en: 'Coordinator · Planner', 'zh-CN': '协调者 · 规划模型' },
  pillEditRecipe: { en: 'Edit recipe', 'zh-CN': '编辑配方' },
  pillClearOverride: { en: 'Reset override', 'zh-CN': '恢复配方默认' },
  pillStepLimitPaused: { en: 'Step budget paused', 'zh-CN': '已达步数上限' },
  pillStandbyHint: {
    en: 'Send a message to start the session; temporary Executor overrides can be set once started.',
    'zh-CN': '发送首条消息开始会话后，可在此临时覆盖当前会话的执行模型。',
  },
  pillCoordinatorHint: {
    en: 'Swarm coordinator stays on Planner while dispatched workers inherit this Executor.',
    'zh-CN': 'Swarm 协调者保持使用规划模型，派发出的 Worker 会继承下方执行模型。',
  },

  toolTransitionPrefix: { en: 'Duo phase switch', 'zh-CN': '双相切换' },
  toolToExecution: { en: 'Entered Execution', 'zh-CN': '进入执行阶段' },
  toolToPlanning: { en: 'Returned to Planner', 'zh-CN': '交还规划阶段' },
  toolReasonLabel: { en: 'Reason', 'zh-CN': '原因' },
} as const satisfies Record<string, LocalizedText>

const ZH_PICKER_COPY: Partial<ModelPickerControlCopy> = {
  searchPlaceholder: '搜索模型或单模型档位…',
  searchAria: '搜索模型或单模型档位',
  tiersHeader: '单模型档位',
  listHeader: '全部模型',
  emptyCatalog: '暂无可用模型',
  noMatches: '无匹配模型',
  thinkingHeader: '思考深度',
  refreshCatalog: '刷新模型列表',
  navHint: '方向键选择 · Enter 确认',
  catalogUnavailable: '模型目录不可用',
}

const EN_PICKER_COPY: Partial<ModelPickerControlCopy> = {
  searchPlaceholder: 'Search models or single-model tiers…',
  tiersHeader: 'Single-model tiers',
}

export const buildDuoPickerCopy = (locale: HelmxLocale): Partial<ModelPickerControlCopy> =>
  locale === 'zh-CN' ? ZH_PICKER_COPY : EN_PICKER_COPY

export function getDuoValidationMessage(
  err: DuoDraftValidationError,
  locale: HelmxLocale,
): string {
  const zh = locale === 'zh-CN'
  switch (err) {
    case 'id_required':
      return zh ? '请填写配方 ID。' : 'Recipe ID is required.'
    case 'id_invalid':
      return zh
        ? '配方 ID 仅支持小写字母、数字、"-" 与 "_"，且须以字母或数字开头。'
        : 'Recipe ID must match /^[a-z0-9][a-z0-9_-]{0,63}$/.'
    case 'id_conflict':
      return zh ? '该 ID 已被其他模型档位或双相配方占用。' : 'This ID is already used by another tier or recipe.'
    case 'name_required':
      return zh ? '请填写配方显示名称。' : 'Display name is required.'
    case 'name_too_long':
      return zh ? '配方名称不得超过 80 个字符。' : 'Display name must be 80 characters or fewer.'
    case 'planner_required':
      return zh ? '请选择规划模型。' : 'Planner model is required.'
    case 'planner_duo_ref':
      return zh ? '规划模型不能引用双相配方自身或其他双相配方。' : 'Planner model cannot reference a Duo recipe.'
    case 'executor_required':
      return zh ? '请选择执行模型。' : 'Executor model is required.'
    case 'executor_duo_ref':
      return zh ? '执行模型不能引用双相配方自身或其他双相配方。' : 'Executor model cannot reference a Duo recipe.'
    case 'steps_invalid':
      return zh ? '最大执行步数须为 0 到 100 的整数。' : 'Max execution steps must be an integer from 0 to 100.'
    case 'description_too_long':
      return zh ? '描述不得超过 240 个字符。' : 'Description must be 240 characters or fewer.'
  }
}

export function formatDuoPhaseLabel(phase: DuoPhase, locale: HelmxLocale): string {
  return phase === 'execution' ? DUO_COPY.pillExecuting[locale] : DUO_COPY.pillPlanning[locale]
}

export function formatDuoStepCounter(
  step: number,
  maxSteps: number,
  locale: HelmxLocale,
): string {
  if (maxSteps <= 0) {
    return `${step} / ${locale === 'zh-CN' ? '不限' : '∞'}`
  }
  return `${step}/${maxSteps}`
}

export function formatDuoStepBudgetLabel(maxSteps: number, locale: HelmxLocale): string {
  if (maxSteps <= 0) return DUO_COPY.unlimitedSteps[locale]
  return `${maxSteps} ${DUO_COPY.stepsCapSuffix[locale]}`
}

export function formatDuoRecipeSavedNotice(id: string, locale: HelmxLocale): string {
  return locale === 'zh-CN' ? `已保存双相配方 tier/${id}` : `Saved Duo recipe tier/${id}`
}

export function formatDuoRecipeRemovedNotice(id: string, locale: HelmxLocale): string {
  return locale === 'zh-CN' ? `已删除双相配方 tier/${id}` : `Deleted Duo recipe tier/${id}`
}

export function formatDuoOverrideUpdatedNotice(modelRef: string, locale: HelmxLocale): string {
  const short = formatModelShortName(modelRef)
  return locale === 'zh-CN'
    ? `当前会话执行模型已临时覆盖为 ${short}`
    : `Temporarily overrode Executor to ${short}`
}

export function formatDuoOverrideClearedNotice(locale: HelmxLocale): string {
  return locale === 'zh-CN' ? '已恢复配方默认执行模型' : 'Reset Executor to recipe default'
}

export function formatDuoTransitionSummary(
  tool: 'exit_plan_mode' | 'hand_back_to_planner',
  fromModel: string,
  toModel: string,
  locale: HelmxLocale,
): string {
  const fromShort = formatModelShortName(fromModel)
  const toShort = formatModelShortName(toModel)
  if (tool === 'exit_plan_mode') {
    return locale === 'zh-CN'
      ? `规划完成，切换至 ${toShort}`
      : `Plan ready -> ${toShort}`
  }
  return locale === 'zh-CN'
    ? `从 ${fromShort} 交还 ${toShort}`
    : `Handed back ${fromShort} -> ${toShort}`
}
