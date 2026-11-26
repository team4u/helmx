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
  fillStarter: { en: 'Fill 5-tier starter draft', 'zh-CN': '填入推荐 5 档草稿' },
  saveAll: { en: 'Save tiers', 'zh-CN': '保存档位' },
  saving: { en: 'Saving…', 'zh-CN': '正在保存…' },
  discard: { en: 'Discard changes', 'zh-CN': '放弃更改' },
  unsavedBadge: { en: 'Unsaved edits', 'zh-CN': '有未保存更改' },
  savedNotice: { en: 'Model tiers saved and synced to kernel.', 'zh-CN': '模型档位已保存并同步至内核。' },
  emptyTitle: { en: 'No model tiers configured yet', 'zh-CN': '尚未配置模型档位' },
  emptyHint: {
    en: 'Add tiers manually or start from the 5-tier draft (scout / coder / senior / architect / reviewer), then bind your concrete models and save.',
    'zh-CN': '可手动新增档位，或一键填入 5 档推荐草稿（scout / coder / senior / architect / reviewer），绑定具体模型后保存即可生效。',
  },
  fieldId: { en: 'Tier ID', 'zh-CN': '档位 ID' },
  fieldIdPlaceholder: { en: 'e.g. coder', 'zh-CN': '例如 coder' },
  fieldModel: { en: 'Target model & thinking level', 'zh-CN': '目标模型与思考档位' },
  pickModel: { en: 'Select model & thinking level', 'zh-CN': '选择模型与思考档位' },
  clearModel: { en: 'Clear model & level', 'zh-CN': '清空模型绑定' },
  fieldDescription: { en: 'Routing guidance', 'zh-CN': '定位与使用边界' },
  fieldDescriptionPlaceholder: { en: 'When to pick this tier and when to avoid it (<= 240 chars)', 'zh-CN': '说明适用场景、成本标签与反向禁区（<= 240 字）' },
  removeRow: { en: 'Remove', 'zh-CN': '移除' },
  statusAvailable: { en: 'Available', 'zh-CN': '可用' },
  statusDisabled: { en: 'Model disabled', 'zh-CN': '模型已禁用' },
  statusUnavailable: { en: 'Unavailable', 'zh-CN': '不可用' },
  statusDraft: { en: 'Draft', 'zh-CN': '草稿' },
  templateSaveTitle: { en: 'Save current active tiers as a reusable template', 'zh-CN': '将当前生效档位另存为可复用模板' },
  templateIdLabel: { en: 'Template ID', 'zh-CN': '模板 ID' },
  templateIdPlaceholder: { en: 'e.g. flagship-5', 'zh-CN': '例如 flagship-5' },
  templateNameLabel: { en: 'Template name', 'zh-CN': '模板名称' },
  templateNamePlaceholder: { en: 'e.g. Flagship Engineering Roster', 'zh-CN': '例如 主力研发 5 档' },
  templateDescLabel: { en: 'Notes (optional)', 'zh-CN': '备注（可选）' },
  templateDescPlaceholder: { en: 'When to activate this preset', 'zh-CN': '说明何时切换这套模板' },
  templateSaveBtn: { en: 'Save template', 'zh-CN': '保存模板' },
  templateEmpty: { en: 'No preset templates saved yet. Save your active tiers above to switch rosters in one click.', 'zh-CN': '尚未保存编制模板。可在上方将当前生效档位存为模板，日后一键切换。' },
  templateActiveBadge: { en: 'Active', 'zh-CN': '当前生效' },
  templateApply: { en: 'Apply', 'zh-CN': '一键应用' },
  templateDelete: { en: 'Delete', 'zh-CN': '删除' },
  cancel: { en: 'Cancel', 'zh-CN': '取消' },
  templateDeleteConfirmTitle: { en: 'Delete preset template', 'zh-CN': '确认删除编制模板' },
  colTemplate: { en: 'Template', 'zh-CN': '模板' },
  colRoster: { en: 'Tiers', 'zh-CN': '档位映射' },
  colUpdated: { en: 'Updated', 'zh-CN': '更新时间' },
  colActions: { en: 'Actions', 'zh-CN': '操作' },
  settingsKvActive: { en: 'Active tiers', 'zh-CN': '生效档位数' },
  settingsKvTemplates: { en: 'Saved templates', 'zh-CN': '已存模板数' },
  settingsKvTemplate: { en: 'Active template', 'zh-CN': '当前模板' },
  settingsNone: { en: 'None (custom)', 'zh-CN': '无（自定义）' },
  settingsOpen: { en: 'Open Model Tiers', 'zh-CN': '打开模型档位管理' },
  settingsHint: { en: 'Manage semantic model tiers (tier/<id>), descriptions, and switchable preset templates.', 'zh-CN': '管理语义模型档位（tier/<id>）、路由职责边界与可一键切换的编制模板。' },
  errIdRequired: { en: 'Every tier must have a non-empty lowercase slug ID (e.g. scout, coder).', 'zh-CN': '每个档位都必须填写非空的小写标识 ID（如 scout、coder）。' },
  errDuplicateId: { en: 'Duplicate tier ID found; each tier ID must be unique.', 'zh-CN': '存在重复的档位 ID，请保持每个档位 ID 唯一。' },
  errModelRequired: { en: 'Every tier must bind a concrete target model before saving.', 'zh-CN': '保存前请为每个档位绑定一个具体目标模型。' },
  errTemplateFields: { en: 'Template ID and name are both required.', 'zh-CN': '请填写模板 ID 与模板名称。' },
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
} as const satisfies Record<string, LocalizedText>

export const tiersTemplateDeleteConfirmBody = (name: string, id: string, locale: HelmxLocale): string =>
  locale === 'zh-CN' ? `确定删除编制模板「${name}」（${id}）吗？此操作无法撤销。` : `Delete preset template "${name}" (${id})? This action cannot be undone.`

export const tiersPickModelWithHint = (level: string, locale: HelmxLocale): string =>
  locale === 'zh-CN' ? `选择模型与思考档位（建议 ${level}）` : `Select model & level (suggested: ${level})`

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
