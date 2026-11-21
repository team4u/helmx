/**
 * Display copy for builtin:tiers client (pure LocalizedText constants + helpers; zero Emoji).
 */
import type { HelmxLocale, LocalizedText } from '@helmx/protocol/browser'

export const TIERS_SCREEN_TITLE: LocalizedText = {
  en: 'Model Tiers',
  'zh-CN': '模型档位',
}

export const TIERS_SCREEN_SUBTITLE: LocalizedText = {
  en: 'Map semantic tiers (tier/<id>) to concrete models and switchable preset templates.',
  'zh-CN': '将语义档位（tier/<id>）映射到具体模型，并保存可一键切换的编制模板。',
}

export const TIERS_ACTIVE_SECTION: LocalizedText = {
  en: 'Active model tiers',
  'zh-CN': '当前生效档位',
}

export const TIERS_TEMPLATES_SECTION: LocalizedText = {
  en: 'Saved preset templates',
  'zh-CN': '已保存编制模板',
}

export const TIERS_LOADING: LocalizedText = {
  en: 'Loading model tiers…',
  'zh-CN': '正在加载模型档位…',
}

export const TIERS_ADD_ROW: LocalizedText = {
  en: 'Add tier',
  'zh-CN': '新增档位',
}

export const TIERS_FILL_STARTER: LocalizedText = {
  en: 'Fill 5-tier starter draft',
  'zh-CN': '填入推荐 5 档草稿',
}

export const TIERS_SAVE_ALL: LocalizedText = {
  en: 'Save tiers',
  'zh-CN': '保存档位',
}

export const TIERS_SAVING: LocalizedText = {
  en: 'Saving…',
  'zh-CN': '正在保存…',
}

export const TIERS_DISCARD: LocalizedText = {
  en: 'Discard changes',
  'zh-CN': '放弃更改',
}

export const TIERS_UNSAVED_BADGE: LocalizedText = {
  en: 'Unsaved edits',
  'zh-CN': '有未保存更改',
}

export const TIERS_SAVED_NOTICE: LocalizedText = {
  en: 'Model tiers saved and synced to kernel.',
  'zh-CN': '模型档位已保存并同步至内核。',
}

export const TIERS_EMPTY_TITLE: LocalizedText = {
  en: 'No model tiers configured yet',
  'zh-CN': '尚未配置模型档位',
}

export const TIERS_EMPTY_HINT: LocalizedText = {
  en: 'Add tiers manually or start from the 5-tier draft (scout / coder / senior / architect / reviewer), then bind your concrete models and save.',
  'zh-CN': '可手动新增档位，或一键填入 5 档推荐草稿（scout / coder / senior / architect / reviewer），绑定具体模型后保存即可生效。',
}

export const TIERS_FIELD_ID: LocalizedText = {
  en: 'Tier ID',
  'zh-CN': '档位 ID',
}

export const TIERS_FIELD_ID_PLACEHOLDER: LocalizedText = {
  en: 'e.g. coder',
  'zh-CN': '例如 coder',
}

export const TIERS_FIELD_MODEL: LocalizedText = {
  en: 'Target model',
  'zh-CN': '目标模型',
}

export const TIERS_PICK_MODEL: LocalizedText = {
  en: 'Select concrete model',
  'zh-CN': '选择具体模型',
}

export const TIERS_CLEAR_MODEL: LocalizedText = {
  en: 'Clear model',
  'zh-CN': '清空模型',
}

export const TIERS_FIELD_THINKING: LocalizedText = {
  en: 'Thinking level',
  'zh-CN': '思考强度',
}

export const TIERS_THINKING_DEFAULT: LocalizedText = {
  en: 'Follow default',
  'zh-CN': '跟随模型默认',
}

export const TIERS_FIELD_DESCRIPTION: LocalizedText = {
  en: 'Routing guidance',
  'zh-CN': '定位与使用边界',
}

export const TIERS_FIELD_DESCRIPTION_PLACEHOLDER: LocalizedText = {
  en: 'When to pick this tier and when to avoid it (<= 240 chars)',
  'zh-CN': '说明适用场景、成本标签与反向禁区（<= 240 字）',
}

export const TIERS_REMOVE_ROW: LocalizedText = {
  en: 'Remove',
  'zh-CN': '移除',
}

export const TIERS_STATUS_AVAILABLE: LocalizedText = {
  en: 'Available',
  'zh-CN': '可用',
}

export const TIERS_STATUS_DISABLED: LocalizedText = {
  en: 'Model disabled',
  'zh-CN': '模型已禁用',
}

export const TIERS_STATUS_UNAVAILABLE: LocalizedText = {
  en: 'Unavailable',
  'zh-CN': '不可用',
}

export const TIERS_STATUS_DRAFT: LocalizedText = {
  en: 'Draft',
  'zh-CN': '草稿',
}

export const TIERS_TEMPLATE_SAVE_TITLE: LocalizedText = {
  en: 'Save current active tiers as a reusable template',
  'zh-CN': '将当前生效档位另存为可复用模板',
}

export const TIERS_TEMPLATE_ID_LABEL: LocalizedText = {
  en: 'Template ID',
  'zh-CN': '模板 ID',
}

export const TIERS_TEMPLATE_ID_PLACEHOLDER: LocalizedText = {
  en: 'e.g. flagship-5',
  'zh-CN': '例如 flagship-5',
}

export const TIERS_TEMPLATE_NAME_LABEL: LocalizedText = {
  en: 'Template name',
  'zh-CN': '模板名称',
}

export const TIERS_TEMPLATE_NAME_PLACEHOLDER: LocalizedText = {
  en: 'e.g. Flagship Engineering Roster',
  'zh-CN': '例如 主力研发 5 档',
}

export const TIERS_TEMPLATE_DESC_LABEL: LocalizedText = {
  en: 'Notes (optional)',
  'zh-CN': '备注（可选）',
}

export const TIERS_TEMPLATE_DESC_PLACEHOLDER: LocalizedText = {
  en: 'When to activate this preset',
  'zh-CN': '说明何时切换这套模板',
}

export const TIERS_TEMPLATE_SAVE_BTN: LocalizedText = {
  en: 'Save template',
  'zh-CN': '保存模板',
}

export const TIERS_TEMPLATE_EMPTY: LocalizedText = {
  en: 'No preset templates saved yet. Save your active tiers above to switch rosters in one click.',
  'zh-CN': '尚未保存编制模板。可在上方将当前生效档位存为模板，日后一键切换。',
}

export const TIERS_TEMPLATE_ACTIVE_BADGE: LocalizedText = {
  en: 'Active',
  'zh-CN': '当前生效',
}

export const TIERS_TEMPLATE_APPLY: LocalizedText = {
  en: 'Apply',
  'zh-CN': '一键应用',
}

export const TIERS_TEMPLATE_DELETE: LocalizedText = {
  en: 'Delete',
  'zh-CN': '删除',
}

export const TIERS_COL_TEMPLATE: LocalizedText = {
  en: 'Template',
  'zh-CN': '模板',
}

export const TIERS_COL_ROSTER: LocalizedText = {
  en: 'Tiers',
  'zh-CN': '档位映射',
}

export const TIERS_COL_UPDATED: LocalizedText = {
  en: 'Updated',
  'zh-CN': '更新时间',
}

export const TIERS_COL_ACTIONS: LocalizedText = {
  en: 'Actions',
  'zh-CN': '操作',
}

export const TIERS_SETTINGS_SECTION: LocalizedText = {
  en: 'Model Tiers Overview',
  'zh-CN': '模型档位概览',
}

export const TIERS_SETTINGS_KV_ACTIVE: LocalizedText = {
  en: 'Active tiers',
  'zh-CN': '生效档位数',
}

export const TIERS_SETTINGS_KV_TEMPLATES: LocalizedText = {
  en: 'Saved templates',
  'zh-CN': '已存模板数',
}

export const TIERS_SETTINGS_KV_TEMPLATE: LocalizedText = {
  en: 'Active template',
  'zh-CN': '当前模板',
}

export const TIERS_SETTINGS_NONE: LocalizedText = {
  en: 'None (custom)',
  'zh-CN': '无（自定义）',
}

export const TIERS_SETTINGS_OPEN: LocalizedText = {
  en: 'Open Model Tiers',
  'zh-CN': '打开模型档位管理',
}

export const TIERS_SETTINGS_HINT: LocalizedText = {
  en: 'Manage semantic model tiers (tier/<id>), descriptions, and switchable preset templates.',
  'zh-CN': '管理语义模型档位（tier/<id>）、路由职责边界与可一键切换的编制模板。',
}

export const TIERS_ERR_ID_REQUIRED: LocalizedText = {
  en: 'Every tier must have a non-empty lowercase slug ID (e.g. scout, coder).',
  'zh-CN': '每个档位都必须填写非空的小写标识 ID（如 scout、coder）。',
}

export const TIERS_ERR_DUPLICATE_ID: LocalizedText = {
  en: 'Duplicate tier ID found; each tier ID must be unique.',
  'zh-CN': '存在重复的档位 ID，请保持每个档位 ID 唯一。',
}

export const TIERS_ERR_MODEL_REQUIRED: LocalizedText = {
  en: 'Every tier must bind a concrete target model before saving.',
  'zh-CN': '保存前请为每个档位绑定一个具体目标模型。',
}

export const TIERS_ERR_TEMPLATE_FIELDS: LocalizedText = {
  en: 'Template ID and name are both required.',
  'zh-CN': '请填写模板 ID 与模板名称。',
}

export function tiersTemplateAppliedNotice(name: string, locale: HelmxLocale): string {
  return locale === 'zh-CN' ? `已切换到模板「${name}」。` : `Applied template "${name}".`
}

export function tiersTemplateSavedNotice(name: string, locale: HelmxLocale): string {
  return locale === 'zh-CN' ? `已保存模板「${name}」。` : `Saved template "${name}".`
}

export function tiersActionFailed(err: unknown, locale: HelmxLocale): string {
  const detail = err instanceof Error ? err.message : String(err)
  return locale === 'zh-CN' ? `操作失败：${detail}` : `Operation failed: ${detail}`
}

export function buildTiersPickerCopy(locale: HelmxLocale): Record<string, string> {
  if (locale === 'zh-CN') {
    return {
      defaultLabel: '选择具体模型',
      searchAria: '搜索模型',
      searchPlaceholder: '搜索模型…',
      refreshCatalog: '刷新动态模型目录',
      listHeader: '模型列表',
      navHint: '↑↓ 选择 · Enter 确认',
      emptyCatalog: '暂无可用模型，请先在模型与凭据中配置提供商密钥',
      noMatches: '无匹配模型',
      rowDefaultTitle: '选择 {model}',
      catalogUnavailable: '模型目录暂不可用',
      catalogPartialFailure: '部分模型目录刷新失败',
      catalogRefreshed: '模型目录已刷新',
      catalogRefreshFailed: '刷新模型目录失败',
    }
  }
  return {}
}
