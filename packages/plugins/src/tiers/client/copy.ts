/** Display copy for builtin:tiers client (Fast Refresh friendly; zero Emoji). */
import type { ModelPickerControlCopy } from '@helmx/plugin-client'
import type { HelmxLocale, LocalizedText } from '@helmx/protocol/browser'

export const TIERS_COPY = {
  screenTitle: { en: 'Model Tiers', 'zh-CN': '模型档位' },
  screenSubtitle: { en: 'Map semantic tiers (tier/<id>) to concrete models and switchable templates.', 'zh-CN': '将语义档位（tier/<id>）映射到具体模型，并保存可一键切换的模板。' },
  activeSection: { en: 'Active model tiers', 'zh-CN': '当前生效档位' },
  templatesSection: { en: 'Saved templates', 'zh-CN': '已保存模板' },
  loading: { en: 'Loading model tiers…', 'zh-CN': '正在加载模型档位…' },
  addRow: { en: 'Add tier', 'zh-CN': '新增档位' },
  saveAll: { en: 'Save tiers', 'zh-CN': '保存档位' },
  saving: { en: 'Saving…', 'zh-CN': '正在保存…' },
  discard: { en: 'Discard changes', 'zh-CN': '放弃更改' },
  savedNotice: { en: 'Model tiers saved and synced to kernel.', 'zh-CN': '模型档位已保存并同步至内核。' },
  emptyTitle: { en: 'No model tiers yet', 'zh-CN': '暂无模型档位' },
  emptyHint: {
    en: 'Add a tier or pick a starter below to bind a model.',
    'zh-CN': '点击右上角新增档位，或选用下方推荐档位绑定模型。',
  },
  tabTiers: { en: 'Tiers', 'zh-CN': '档位' },
  tabTemplates: { en: 'Templates', 'zh-CN': '模板' },
  searchPlaceholder: { en: 'Search tiers or models…', 'zh-CN': '搜索档位或模型…' },
  filterEmptyTitle: { en: 'No matching tiers', 'zh-CN': '未找到匹配的档位' },
  resetFilters: { en: 'Reset filters', 'zh-CN': '重置筛选' },
  starterSectionTitle: { en: 'Starter tiers', 'zh-CN': '推荐档位' },
  starterCardCta: { en: 'Bind', 'zh-CN': '绑定' },
  starterPresetsLabel: { en: 'Presets', 'zh-CN': '推荐' },
  drawerCreateTitle: { en: 'New tier', 'zh-CN': '新建档位' },
  drawerEditTitle: { en: 'Edit tier', 'zh-CN': '编辑档位' },
  drawerNotFoundTitle: { en: 'Tier not found', 'zh-CN': '档位不存在' },
  drawerNotFoundBody: { en: 'This tier no longer exists or was removed.', 'zh-CN': '该档位不存在或已被删除。' },
  createTier: { en: 'Create', 'zh-CN': '创建' },
  saveTier: { en: 'Save', 'zh-CN': '保存' },
  deleteTier: { en: 'Delete', 'zh-CN': '删除' },
  tierDeleteConfirmTitle: { en: 'Delete tier', 'zh-CN': '删除档位' },
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
  fieldModel: { en: 'Model', 'zh-CN': '目标模型' },
  pickModel: { en: 'Select model', 'zh-CN': '选择模型' },
  clearModel: { en: 'Clear model', 'zh-CN': '清空模型' },
  fieldDescription: { en: 'Guidance', 'zh-CN': '定位说明' },
  fieldDescriptionPlaceholder: { en: 'When to use or avoid this tier (optional)', 'zh-CN': '适用场景与使用边界（可选）' },
  removeRow: { en: 'Remove', 'zh-CN': '移除' },
  statusAvailable: { en: 'Available', 'zh-CN': '可用' },
  statusDisabled: { en: 'Model disabled', 'zh-CN': '模型已禁用' },
  statusUnavailable: { en: 'Unavailable', 'zh-CN': '不可用' },
  saveAsTemplate: { en: 'Save template', 'zh-CN': '存为模板' },
  templateSaveTitle: { en: 'Save template', 'zh-CN': '存为模板' },
  templateIdLabel: { en: 'Template ID', 'zh-CN': '模板 ID' },
  templateIdPlaceholder: { en: 'e.g. flagship-5', 'zh-CN': '例如 flagship-5' },
  templateNameLabel: { en: 'Template name', 'zh-CN': '模板名称' },
  templateNamePlaceholder: { en: 'e.g. Daily Engineering', 'zh-CN': '例如 主力研发' },
  templateDescLabel: { en: 'Notes', 'zh-CN': '备注' },
  templateDescPlaceholder: { en: 'When to use this template (optional)', 'zh-CN': '说明适用场景（可选）' },
  templateSaveBtn: { en: 'Save template', 'zh-CN': '保存模板' },
  templateEmptyTitle: { en: 'No templates yet', 'zh-CN': '暂无模板' },
  templateEmpty: { en: 'Save your active tiers as a template to switch configurations in one click.', 'zh-CN': '可将当前档位存为模板，日后一键切换。' },
  templateActiveBadge: { en: 'Active', 'zh-CN': '当前生效' },
  templateApply: { en: 'Apply', 'zh-CN': '应用' },
  templateDelete: { en: 'Delete', 'zh-CN': '删除' },
  cancel: { en: 'Cancel', 'zh-CN': '取消' },
  close: { en: 'Close', 'zh-CN': '关闭' },
  templateDeleteConfirmTitle: { en: 'Delete template', 'zh-CN': '删除模板' },
  settingsKvActive: { en: 'Active tiers', 'zh-CN': '档位数' },
  settingsKvTemplates: { en: 'Templates', 'zh-CN': '模板数' },
  settingsKvTemplate: { en: 'Active template', 'zh-CN': '当前模板' },
  settingsNone: { en: 'None (custom)', 'zh-CN': '无（自定义）' },
  settingsOpen: { en: 'Open Model Tiers', 'zh-CN': '打开模型档位管理' },
  settingsHint: { en: 'Manage semantic model tiers (tier/<id>), guidance, and switchable templates.', 'zh-CN': '管理语义模型档位（tier/<id>）、定位说明与可一键切换的模板。' },
  errIdRequired: { en: 'Every tier must have a non-empty lowercase slug ID (e.g. scout, coder).', 'zh-CN': '每个档位都必须填写非空的小写标识 ID（如 scout、coder）。' },
  errDuplicateId: { en: 'A tier with this ID already exists; choose a different ID.', 'zh-CN': '该档位 ID 已存在，请更换其他标识 ID。' },
  errModelRequired: { en: 'Every tier must bind a concrete target model before saving.', 'zh-CN': '保存前请为每个档位绑定一个具体目标模型。' },
  errTemplateFields: { en: 'Template ID and name are both required.', 'zh-CN': '请填写模板 ID 与模板名称。' },
  errTemplateIdInvalid: {
    en: "Template ID must use lowercase letters, digits, '-' or '_'.",
    'zh-CN': '模板 ID 仅支持小写字母、数字、连字符或下划线。',
  },
} as const satisfies Record<string, LocalizedText>

export const tiersTemplateDeleteConfirmBody = (name: string, id: string, locale: HelmxLocale): string =>
  locale === 'zh-CN' ? `确定删除模板「${name}」（${id}）吗？此操作无法撤销。` : `Delete template "${name}" (${id})? This action cannot be undone.`

export const tiersTierDeleteConfirmBody = (id: string, model: string, locale: HelmxLocale): string =>
  locale === 'zh-CN' ? `确定删除模型档位「tier/${id}」（${model}）吗？此操作无法撤销。` : `Delete model tier "tier/${id}" (${model})? This action cannot be undone.`

export const tiersPickModelWithHint = (level: string, locale: HelmxLocale): string =>
  locale === 'zh-CN' ? `选择模型（建议 ${level}）` : `Select model (suggested: ${level})`

export const tiersSuggestedLevelBadge = (level: string, locale: HelmxLocale): string =>
  locale === 'zh-CN' ? `建议 ${level}` : `suggested ${level}`

export const tiersTierSavedNotice = (id: string, locale: HelmxLocale): string =>
  locale === 'zh-CN' ? `已保存档位「tier/${id}」并同步至内核。` : `Saved tier "tier/${id}" and synced to kernel.`

export const tiersTierDeletedNotice = (id: string, locale: HelmxLocale): string =>
  locale === 'zh-CN' ? `已删除档位「tier/${id}」。` : `Deleted tier "tier/${id}".`

export const tiersTemplateCountSummary = (count: number, locale: HelmxLocale): string =>
  locale === 'zh-CN' ? `将当前 ${count} 个档位保存为可一键切换的模板。` : `Save your ${count} active tier(s) as a reusable template.`

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
