import type { LocalizedText } from '@helmx/protocol/browser'

/** Defaults shared by host and plugin UI primitives. */
export const uiCopy = {
  copy: { en: 'Copy', 'zh-CN': '复制' },
  copied: { en: 'Copied', 'zh-CN': '已复制' },
  copyFailed: { en: 'Copy failed', 'zh-CN': '复制失败' },
  copyFailureHint: {
    en: 'Copy failed (environment restriction; select and copy manually)',
    'zh-CN': '复制失败（环境限制，请选中文字手动复制）',
  },
  loading: { en: 'Loading…', 'zh-CN': '加载中…' },
  noData: { en: 'No data', 'zh-CN': '暂无数据' },
  select: { en: 'Select…', 'zh-CN': '请选择…' },
  searchOptions: { en: 'Search options', 'zh-CN': '搜索选项' },
  searchPlaceholder: { en: 'Search options…', 'zh-CN': '搜索选项…' },
  selectAll: { en: 'Select all', 'zh-CN': '全选' },
  clear: { en: 'Clear', 'zh-CN': '清空' },
  view: { en: 'View', 'zh-CN': '视图' },
  renderAgain: { en: 'Render again', 'zh-CN': '重新渲染' },
  modelCatalogUnavailable: {
    en: 'Model catalog unavailable',
    'zh-CN': '模型目录不可用',
  },
} as const satisfies Record<string, LocalizedText>

/** Shared copy for ModelPickerControl (control-internal strings; wrapper labels stay with the consumer). */
export const modelPickerCopy = {
  buttonAria: { en: 'Model and thinking level: {model}{level}', 'zh-CN': '模型与思考档位：{model}{level}' },
  levelSuffix: { en: ' · {level}', 'zh-CN': ' · {level}' },
  defaultLabel: { en: 'Default model', 'zh-CN': '默认模型' },
  searchAria: { en: 'Search models', 'zh-CN': '搜索模型' },
  searchPlaceholder: { en: 'Search models…', 'zh-CN': '搜索模型…' },
  refreshCatalog: { en: 'Refresh dynamic model catalog', 'zh-CN': '刷新动态模型目录' },
  listHeader: { en: 'Model list', 'zh-CN': '模型列表' },
  emptyCatalog: {
    en: 'No models available; configure a provider key in Models & credentials first',
    'zh-CN': '暂无可用模型；请先在「模型与凭据」配置供应商密钥',
  },
  noMatches: { en: 'No matching models', 'zh-CN': '没有匹配的模型' },
  thinkingHeader: { en: 'Thinking level', 'zh-CN': '思考档位' },
  navHint: { en: '↑↓ select · Enter confirm', 'zh-CN': '↑↓ 选择 · Enter 确认' },
  rowDefaultTitle: { en: 'Use {model} (thinking level follows the default)', 'zh-CN': '使用 {model}（思考档位跟随默认）' },
  levelChipTitle: { en: 'Use {model} · thinking {level}', 'zh-CN': '使用 {model} · 思考 {level}' },
  catalogPartialFailure: { en: 'Some provider catalog refreshes failed', 'zh-CN': '部分供应商目录刷新失败' },
  catalogRefreshed: { en: 'Model catalog refreshed', 'zh-CN': '已刷新模型目录' },
  catalogCount: { en: '{count} models available', 'zh-CN': '共 {count} 个可用模型' },
  catalogRefreshFailed: { en: 'Failed to refresh model catalog', 'zh-CN': '刷新模型目录失败' },
} as const satisfies Record<string, LocalizedText>
