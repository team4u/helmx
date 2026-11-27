/** Display copy for builtin:tiers client (Fast Refresh friendly; zero Emoji). */
import type { ModelPickerControlCopy } from '@helmx/plugin-client'
import type { HelmxLocale, LocalizedText } from '@helmx/protocol/browser'

export const TIERS_COPY = {
  screenTitle: { en: 'Model Tiers', 'zh-CN': '模型档位' },
  screenSubtitle: { en: 'Map semantic tiers (tier/<id>) to concrete models and switchable preset templates.', 'zh-CN': '将语义档位（tier/<id>）映射到具体模型，并保存可一键切换的编制模板。' },
  activeSection: { en: 'Active model tiers', 'zh-CN': '当前生效档位' },
  templatesSection: { en: 'Saved preset templates', 'zh-CN': '已保存编制模板' },
  loading: { en: 'Loading model tiers…', 'zh-CN': '正在加载模型档位…' },
  addRow: { en: 'Add tier', 'zh-CN': '新增档位' },
  saveAll: { en: 'Save tiers', 'zh-CN': '保存档位' },
  saving: { en: 'Saving…', 'zh-CN': '正在保存…' },
  discard: { en: 'Discard changes', 'zh-CN': '放弃更改' },
  savedNotice: { en: 'Model tiers saved and synced to kernel.', 'zh-CN': '模型档位已保存并同步至内核。' },
  emptyTitle: { en: 'No model tiers configured yet', 'zh-CN': '尚未配置模型档位' },
  emptyHint: {
    en: 'Add a tier manually or click one of the 5 starter tiers below (scout / coder / senior / architect / reviewer) to bind a model.',
    'zh-CN': '可点击右上角新增档位，或直接点选下方推荐 5 档（scout / coder / senior / architect / reviewer）快速绑定模型。',
  },
  tabTiers: { en: 'Active tiers', 'zh-CN': '生效档位' },
  tabTemplates: { en: 'Preset templates', 'zh-CN': '编制模板' },
  filterAll: { en: 'All', 'zh-CN': '全部' },
  filterSingle: { en: 'Single', 'zh-CN': '单模型' },
  filterOrchestrator: { en: 'Dual-phase', 'zh-CN': '双相编排' },
  searchPlaceholder: { en: 'Search tier ID, model, or guidance…', 'zh-CN': '搜索档位 ID、模型或定位说明…' },
  filterEmptyTitle: { en: 'No matching tiers', 'zh-CN': '未找到匹配的档位' },
  resetFilters: { en: 'Reset filters', 'zh-CN': '重置筛选' },
  starterSectionTitle: { en: 'Quick-start with recommended 5 tiers', 'zh-CN': '推荐 5 档快速起步' },
  starterCardCta: { en: 'Click to bind model', 'zh-CN': '点击绑定模型' },
  starterPresetsLabel: { en: 'Quick-fill preset', 'zh-CN': '快捷套用推荐定位' },
  drawerCreateTitle: { en: 'New model tier', 'zh-CN': '新建模型档位' },
  drawerEditTitle: { en: 'Edit model tier', 'zh-CN': '编辑模型档位' },
  drawerNotFoundTitle: { en: 'Model tier not found', 'zh-CN': '未找到该模型档位' },
  drawerNotFoundBody: { en: 'This tier no longer exists or was removed.', 'zh-CN': '该模型档位不存在或已被移除。' },
  createTier: { en: 'Create tier', 'zh-CN': '创建档位' },
  saveTier: { en: 'Save changes', 'zh-CN': '保存更改' },
  deleteTier: { en: 'Delete tier', 'zh-CN': '删除档位' },
  tierDeleteConfirmTitle: { en: 'Delete model tier', 'zh-CN': '确认删除模型档位' },
  fieldId: { en: 'Tier ID', 'zh-CN': '档位 ID' },
  fieldIdPlaceholder: { en: 'e.g. coder', 'zh-CN': '例如 coder' },
  fieldIdHint: {
    en: "Lowercase letters, digits, '-' or '_' (referenced as tier/<id>).",
    'zh-CN': '小写字母、数字、连字符或下划线（引用格式为 tier/<id>）。',
  },
  fieldIdLockedHint: {
    en: 'Tier ID cannot be changed after creation to keep existing bindings valid.',
    'zh-CN': '创建后档位 ID 保持固定，避免破坏已有 Profile 或全局默认引用。',
  },
  fieldModel: { en: 'Target model & thinking level', 'zh-CN': '目标模型与思考档位' },
  pickModel: { en: 'Select model & thinking level', 'zh-CN': '选择模型与思考档位' },
  clearModel: { en: 'Clear model & level', 'zh-CN': '清空模型绑定' },
  fieldDescription: { en: 'Routing guidance', 'zh-CN': '定位与使用边界' },
  fieldDescriptionPlaceholder: { en: 'When to pick this tier and when to avoid it (<= 240 chars)', 'zh-CN': '说明适用场景、成本标签与反向禁区（<= 240 字）' },
  removeRow: { en: 'Remove', 'zh-CN': '移除' },
  statusAvailable: { en: 'Available', 'zh-CN': '可用' },
  statusDisabled: { en: 'Model disabled', 'zh-CN': '模型已禁用' },
  statusUnavailable: { en: 'Unavailable', 'zh-CN': '不可用' },
  saveAsTemplate: { en: 'Save as template', 'zh-CN': '另存为模板' },
  templateSaveTitle: { en: 'Save current active tiers as a reusable template', 'zh-CN': '将当前生效档位另存为可复用模板' },
  templateIdLabel: { en: 'Template ID', 'zh-CN': '模板 ID' },
  templateIdPlaceholder: { en: 'e.g. flagship-5', 'zh-CN': '例如 flagship-5' },
  templateNameLabel: { en: 'Template name', 'zh-CN': '模板名称' },
  templateNamePlaceholder: { en: 'e.g. Flagship Engineering Roster', 'zh-CN': '例如 主力研发 5 档' },
  templateDescLabel: { en: 'Notes (optional)', 'zh-CN': '备注（可选）' },
  templateDescPlaceholder: { en: 'When to activate this preset', 'zh-CN': '说明何时切换这套模板' },
  templateSaveBtn: { en: 'Save template', 'zh-CN': '保存模板' },
  templateEmptyTitle: { en: 'No preset templates saved', 'zh-CN': '尚未保存编制模板' },
  templateEmpty: { en: 'Save your active tiers as a preset template to switch rosters in one click.', 'zh-CN': '可将当前生效档位另存为编制模板，日后一键整体切换。' },
  templateActiveBadge: { en: 'Active', 'zh-CN': '当前生效' },
  templateApply: { en: 'Apply', 'zh-CN': '一键应用' },
  templateDelete: { en: 'Delete', 'zh-CN': '删除' },
  cancel: { en: 'Cancel', 'zh-CN': '取消' },
  close: { en: 'Close', 'zh-CN': '关闭' },
  templateDeleteConfirmTitle: { en: 'Delete preset template', 'zh-CN': '确认删除编制模板' },
  settingsKvActive: { en: 'Active tiers', 'zh-CN': '生效档位数' },
  settingsKvTemplates: { en: 'Saved templates', 'zh-CN': '已存模板数' },
  settingsKvTemplate: { en: 'Active template', 'zh-CN': '当前模板' },
  settingsNone: { en: 'None (custom)', 'zh-CN': '无（自定义）' },
  settingsOpen: { en: 'Open Model Tiers', 'zh-CN': '打开模型档位管理' },
  settingsHint: { en: 'Manage semantic model tiers (tier/<id>), descriptions, and switchable preset templates.', 'zh-CN': '管理语义模型档位（tier/<id>）、路由职责边界与可一键切换的编制模板。' },
  errIdRequired: { en: 'Every tier must have a non-empty lowercase slug ID (e.g. scout, coder).', 'zh-CN': '每个档位都必须填写非空的小写标识 ID（如 scout、coder）。' },
  errDuplicateId: { en: 'A tier with this ID already exists; choose a different ID.', 'zh-CN': '该档位 ID 已存在，请更换其他标识 ID。' },
  errModelRequired: { en: 'Every tier must bind a concrete target model before saving.', 'zh-CN': '保存前请为每个档位绑定一个具体目标模型。' },
  errTemplateFields: { en: 'Template ID and name are both required.', 'zh-CN': '请填写模板 ID 与模板名称。' },
  errTemplateIdInvalid: {
    en: "Template ID must use lowercase letters, digits, '-' or '_'.",
    'zh-CN': '模板 ID 仅支持小写字母、数字、连字符或下划线。',
  },
  oneTurnTabLabel: { en: 'Next turn', 'zh-CN': '仅下一轮' },
  oneTurnModeHint: {
    en: 'Applies only to your next message, then restores automatically',
    'zh-CN': '仅对下一条消息生效，回合结束后自动恢复原模型',
  },
  borrowPillArmedPrefix: { en: 'Next turn:', 'zh-CN': '下一轮:' },
  borrowPillActivePrefix: { en: 'This turn:', 'zh-CN': '本轮借用:' },
  borrowClearArmedAria: { en: 'Cancel armed one-turn model', 'zh-CN': '取消下一轮借用模型' },
  borrowClearActiveAria: {
    en: 'Cancel auto-restore and stay on the borrowed model',
    'zh-CN': '取消自动恢复并留在当前模型',
  },
  toolSwitchModelTitle: { en: 'Switch model', 'zh-CN': '切换模型' },
  toolSwitchModelBadgeOneTurn: { en: 'One-turn', 'zh-CN': '单轮' },
  toolSwitchModelBadgePermanent: { en: 'Persistent', 'zh-CN': '持久' },
  toolStatusRunning: { en: 'Switching', 'zh-CN': '切换中' },
  toolStatusDone: { en: 'Switched', 'zh-CN': '已切换' },
  toolStatusError: { en: 'Failed', 'zh-CN': '失败' },
  tierKindSingle: { en: 'Single model', 'zh-CN': '单模型' },
  tierKindOrchestrator: { en: 'Dual-phase (Planner -> Executor)', 'zh-CN': '双相编排（规划 -> 执行）' },
  tierKindAria: { en: 'Tier mode', 'zh-CN': '档位模式' },
  fieldPlannerModel: { en: 'Planner model & thinking level', 'zh-CN': '规划模型（Planner）与思考档位' },
  fieldExecutorModel: { en: 'Executor model & thinking level', 'zh-CN': '执行模型（Executor）与思考档位' },
  fieldMaxSteps: { en: 'Max execution steps (0 = unlimited)', 'zh-CN': '最大执行步数（0 = 不限）' },
  fieldMaxStepsPlaceholder: { en: '30', 'zh-CN': '30' },
  errExecutorRequired: {
    en: 'Dual-phase tiers must bind an Executor model before saving.',
    'zh-CN': '双相编排档位保存前必须绑定执行模型（Executor）。',
  },
  errMaxStepsInvalid: {
    en: 'Max execution steps must be an integer between 0 and 100 (0 = unlimited).',
    'zh-CN': '最大执行步数必须为 0 到 100 之间的整数（0 表示不限）。',
  },
  orchestratorPillPlanning: { en: 'Planning:', 'zh-CN': '规划中:' },
  orchestratorPillExecuting: { en: 'Executing:', 'zh-CN': '执行中:' },
  toolExitPlanTitle: { en: 'Enter execution phase', 'zh-CN': '切换执行阶段' },
  toolHandBackTitle: { en: 'Hand back to planner', 'zh-CN': '交回规划阶段' },
  toolOrchPhaseExec: { en: 'Executor', 'zh-CN': '执行' },
  toolOrchPhasePlan: { en: 'Planner', 'zh-CN': '规划' },
} as const satisfies Record<string, LocalizedText>

export const tiersTemplateDeleteConfirmBody = (name: string, id: string, locale: HelmxLocale): string =>
  locale === 'zh-CN' ? `确定删除编制模板「${name}」（${id}）吗？此操作无法撤销。` : `Delete preset template "${name}" (${id})? This action cannot be undone.`

export const tiersTierDeleteConfirmBody = (id: string, model: string, locale: HelmxLocale): string =>
  locale === 'zh-CN' ? `确定删除模型档位「tier/${id}」（${model}）吗？此操作无法撤销。` : `Delete model tier "tier/${id}" (${model})? This action cannot be undone.`

export const tiersPickModelWithHint = (level: string, locale: HelmxLocale): string =>
  locale === 'zh-CN' ? `选择模型与思考档位（建议 ${level}）` : `Select model & level (suggested: ${level})`

export const tiersSuggestedLevelBadge = (level: string, locale: HelmxLocale): string =>
  locale === 'zh-CN' ? `建议 ${level}` : `suggested ${level}`

export const tiersOrchestratorStepsBadge = (steps: number, locale: HelmxLocale): string => {
  if (steps === 0) return locale === 'zh-CN' ? '双相 · 不限' : 'Dual · Unlimited'
  return locale === 'zh-CN' ? `双相 · ${steps} 步` : `Dual · ${steps} steps`
}

export const tiersTierSavedNotice = (id: string, locale: HelmxLocale): string =>
  locale === 'zh-CN' ? `已保存档位「tier/${id}」并同步至内核。` : `Saved tier "tier/${id}" and synced to kernel.`

export const tiersTierDeletedNotice = (id: string, locale: HelmxLocale): string =>
  locale === 'zh-CN' ? `已删除档位「tier/${id}」。` : `Deleted tier "tier/${id}".`

export const tiersTemplateCountSummary = (count: number, locale: HelmxLocale): string =>
  locale === 'zh-CN' ? `基于当前 ${count} 个生效档位创建可一键切换的编制模板。` : `Snapshot your ${count} active tier(s) as a reusable preset template.`

export const tiersTemplateAppliedNotice = (name: string, locale: HelmxLocale): string =>
  locale === 'zh-CN' ? `已切换到模板「${name}」。` : `Applied template "${name}".`

export const tiersTemplateSavedNotice = (name: string, locale: HelmxLocale): string =>
  locale === 'zh-CN' ? `已保存模板「${name}」。` : `Saved template "${name}".`

export const tiersTemplateDeletedNotice = (name: string, locale: HelmxLocale): string =>
  locale === 'zh-CN' ? `已删除模板「${name}」。` : `Deleted template "${name}".`

export const tiersActionFailed = (err: unknown, locale: HelmxLocale): string => {
  const detail = err instanceof Error ? err.message : String(err)
  return locale === 'zh-CN' ? `操作失败：${detail}` : `Operation failed: ${detail}`
}

export const borrowArmedPillTitle = (concreteModel: string, locale: HelmxLocale): string =>
  locale === 'zh-CN'
    ? `下一条消息将临时使用 ${concreteModel}（回合结束后自动恢复原模型）；点击可重选`
    : `Next message will temporarily use ${concreteModel} (auto-restores after the turn); click to change`

export const borrowActivePillTitle = (concreteModel: string, locale: HelmxLocale): string =>
  locale === 'zh-CN'
    ? `本轮正在借用 ${concreteModel}，本轮结束后自动恢复原模型；点击 × 取消自动恢复并留在当前模型`
    : `Borrowing ${concreteModel} for this turn (auto-restores when done); click × to cancel auto-restore and stay on this model`

export const switchModelSummaryLabel = (
  target: string,
  restoreAfterTurn: boolean,
  locale: HelmxLocale,
): string => {
  if (restoreAfterTurn) {
    return locale === 'zh-CN'
      ? `切换到 ${target}（本轮结束自动恢复）`
      : `Switched to ${target} (auto-restores after turn)`
  }
  return locale === 'zh-CN' ? `永久切换到 ${target}` : `Permanently switched to ${target}`
}

export const orchestratorPillTitle = (
  tierId: string,
  phase: 'planning' | 'execution',
  plannerModel: string,
  executorModel: string,
  steps: number,
  maxSteps: number,
  locale: HelmxLocale,
): string => {
  if (locale === 'zh-CN') {
    const phaseLabel =
      phase === 'execution'
        ? maxSteps > 0
          ? `执行阶段（${steps}/${maxSteps} 步）`
          : `执行阶段（第 ${steps} 步 · 不限步数）`
        : '规划阶段'
    return `双相编排 tier/${tierId} · ${phaseLabel}（Planner: ${plannerModel} / Executor: ${executorModel}）`
  }
  const phaseLabel =
    phase === 'execution'
      ? maxSteps > 0
        ? `Execution (${steps}/${maxSteps} steps)`
        : `Execution (step ${steps} · unlimited)`
      : 'Planning'
  return `Dual-phase tier/${tierId} · ${phaseLabel} (Planner: ${plannerModel} / Executor: ${executorModel})`
}

export const orchestratorTransitionSummary = (
  tool: 'exit_plan_mode' | 'hand_back_to_planner',
  toModelShort: string,
  reason: string | undefined,
  locale: HelmxLocale,
): string => {
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

export const buildTiersPickerCopy = (locale: HelmxLocale): Partial<ModelPickerControlCopy> =>
  locale === 'zh-CN' ? ZH_PICKER_COPY : {}
