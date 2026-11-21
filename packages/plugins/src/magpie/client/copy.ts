/**
 * Display copy for the builtin:magpie settings panel and composer quota status
 * (pure copy table, no component exports — Fast Refresh friendly; zero Emoji).
 *
 * Every human-visible string resolves against the active host locale; gateway
 * diagnostics, lastError and quota data from the status doc pass through unchanged.
 */
import type { HelmxLocale, LocalizedText } from '@helmx/plugin-client'
import { resolveLocalizedText } from '@helmx/plugin-client'

/** Panel header and refresh action. */
export const MAGPIE_TITLE: LocalizedText = { en: 'Magpie Gateway', 'zh-CN': 'Magpie 网关' }
export const MAGPIE_REFRESHING: LocalizedText = { en: 'Refreshing…', 'zh-CN': '刷新中...' }
export const MAGPIE_REFRESH: LocalizedText = { en: 'Refresh model catalog', 'zh-CN': '刷新模型目录' }
export const MAGPIE_LOADING: LocalizedText = { en: 'Loading gateway status…', 'zh-CN': '网关状态读取中...' }

/** Boolean yes/no display. */
const MAGPIE_YES: LocalizedText = { en: 'Yes', 'zh-CN': '是' }
const MAGPIE_NO: LocalizedText = { en: 'No', 'zh-CN': '否' }

/** Status overview KV keys. */
export const MAGPIE_KV_GATEWAY_URL: LocalizedText = { en: 'Gateway URL', 'zh-CN': '网关地址' }
export const MAGPIE_KV_LOCAL_LOOPBACK: LocalizedText = { en: 'Local loopback', 'zh-CN': '本机 loopback' }
export const MAGPIE_KV_REACHABLE: LocalizedText = { en: 'Reachable', 'zh-CN': '可达' }
export const MAGPIE_KV_MODELS: LocalizedText = { en: 'Models', 'zh-CN': '模型数' }
export const MAGPIE_KV_MODELS_CACHED: LocalizedText = { en: 'Models (cached)', 'zh-CN': '模型数（缓存）' }
export const MAGPIE_KV_GROUPS: LocalizedText = { en: 'Route groups', 'zh-CN': '路由组数' }
export const MAGPIE_KV_AUTO_REFRESH: LocalizedText = { en: 'Auto-refresh interval', 'zh-CN': '自动刷新间隔' }
export const MAGPIE_KV_LAST_REFRESHED: LocalizedText = { en: 'Last refreshed', 'zh-CN': '最近刷新' }
export const MAGPIE_KV_LAST_ERROR: LocalizedText = { en: 'Last error', 'zh-CN': '最近错误' }

const MAGPIE_AUTO_REFRESH_OFF: LocalizedText = { en: 'Off', 'zh-CN': '已关闭' }

/** Diagnostics table. */
export const MAGPIE_DIAGNOSTICS_SECTION: LocalizedText = { en: 'Diagnostics', 'zh-CN': '诊断' }
export const MAGPIE_DIAGNOSTICS_COL: LocalizedText = { en: 'Unavailable items', 'zh-CN': '不可用项' }
export const MAGPIE_DIAGNOSTICS_EMPTY: LocalizedText = { en: 'No diagnostics', 'zh-CN': '无诊断信息' }

/** Quota & route tables shared column. */
export const MAGPIE_COL_PROVIDER: LocalizedText = { en: 'Provider', 'zh-CN': '供应商' }

/** Quota table. */
export const MAGPIE_QUOTA_SECTION: LocalizedText = { en: 'Quotas', 'zh-CN': '配额' }
export const MAGPIE_QUOTA_COL_ACCOUNT: LocalizedText = { en: 'Account', 'zh-CN': '账号' }
export const MAGPIE_QUOTA_COL_WINDOW: LocalizedText = { en: 'Window', 'zh-CN': '窗口' }
export const MAGPIE_QUOTA_COL_REMAINING: LocalizedText = { en: 'Remaining', 'zh-CN': '剩余' }
export const MAGPIE_QUOTA_COL_RESET: LocalizedText = { en: 'Reset', 'zh-CN': '重置' }
export const MAGPIE_QUOTA_EMPTY: LocalizedText = { en: 'No quota data', 'zh-CN': '暂无配额数据' }

/** Route history table. */
export const MAGPIE_ROUTES_SECTION: LocalizedText = { en: 'Route history', 'zh-CN': '路由轨迹' }
export const MAGPIE_ROUTES_COL_GROUP: LocalizedText = { en: 'Route group', 'zh-CN': '路由组' }
export const MAGPIE_ROUTES_COL_STRATEGY: LocalizedText = { en: 'Strategy', 'zh-CN': '策略' }
export const MAGPIE_ROUTES_COL_MODEL: LocalizedText = { en: 'Hit model', 'zh-CN': '命中模型' }
export const MAGPIE_ROUTES_COL_TIME: LocalizedText = { en: 'Time', 'zh-CN': '时间' }
export const MAGPIE_ROUTES_EMPTY: LocalizedText = { en: 'No route history', 'zh-CN': '暂无路由记录' }

/** Composer status bar quota indicator & popover. */
export const MAGPIE_COMPOSER_QUOTA_ARIA: LocalizedText = { en: 'Current model quota details', 'zh-CN': '当前模型配额详情' }
export const MAGPIE_COMPOSER_REFRESH_NOW: LocalizedText = { en: 'Refresh now', 'zh-CN': '立即刷新' }
export const MAGPIE_COMPOSER_ACTIVE_ACCOUNT: LocalizedText = { en: 'active', 'zh-CN': '当前' }
export const MAGPIE_COMPOSER_DEFAULT_ACCOUNT: LocalizedText = { en: 'Default account', 'zh-CN': '默认账号' }
export const MAGPIE_COMPOSER_QUOTA_UNAVAILABLE: LocalizedText = { en: 'Quota unavailable', 'zh-CN': '配额不可用' }
export const MAGPIE_COMPOSER_QUOTA_NA_SHORT: LocalizedText = { en: 'Quota n/a', 'zh-CN': '配额不可用' }
export const MAGPIE_COMPOSER_NO_WINDOW_DATA: LocalizedText = { en: 'No quota window reported', 'zh-CN': '网关未返回配额窗口' }
export const MAGPIE_COMPOSER_ROUTING_GROUP_PREFIX: LocalizedText = { en: 'Primary route source:', 'zh-CN': '主路由源：' }
export const MAGPIE_COMPOSER_JUST_NOW: LocalizedText = { en: 'just now', 'zh-CN': '刚刚' }

/** Resolve the yes/no label used by models.ts boolLabel. */
export function magpieBoolLabel(value: boolean, locale: HelmxLocale): string {
  return resolveLocalizedText(value ? MAGPIE_YES : MAGPIE_NO, locale)
}

/** Resolve the auto-refresh interval label (e.g. '5s' or 'Off'/'已关闭'). */
export function magpieRefreshIntervalLabel(seconds: number, locale: HelmxLocale): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return resolveLocalizedText(MAGPIE_AUTO_REFRESH_OFF, locale)
  }
  return `${Math.round(seconds)}s`
}

/** Format relative age text for quota freshness (e.g. 'just now', '12s ago', '2m ago'). */
export function magpieRelativeAgeLabel(
  timestampMs: number | undefined,
  nowMs: number | undefined,
  locale: HelmxLocale,
): string | undefined {
  if (timestampMs === undefined || nowMs === undefined || !Number.isFinite(timestampMs) || !Number.isFinite(nowMs)) {
    return undefined
  }
  const elapsedSec = Math.max(0, Math.floor((nowMs - timestampMs) / 1000))
  if (elapsedSec < 10) return resolveLocalizedText(MAGPIE_COMPOSER_JUST_NOW, locale)
  if (elapsedSec < 60) return locale === 'zh-CN' ? `${elapsedSec}秒前` : `${elapsedSec}s ago`
  const minutes = Math.floor(elapsedSec / 60)
  if (minutes < 60) return locale === 'zh-CN' ? `${minutes}分钟前` : `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return locale === 'zh-CN' ? `${hours}小时前` : `${hours}h ago`
  const days = Math.floor(hours / 24)
  return locale === 'zh-CN' ? `${days}天前` : `${days}d ago`
}

/** Format extra-account badge text (+N) and aria hint. */
export function magpieMoreAccountsTitle(totalAccounts: number, locale: HelmxLocale): string {
  return locale === 'zh-CN' ? `共 ${totalAccounts} 个相关账号，点击查看列表` : `${totalAccounts} related accounts, click to view list`
}
