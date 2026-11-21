/**
 * 配额读取（GET /v1/magpie/quotas）→ 展示行投影。
 * 与 Magpie 网关 Quota / QuotaSpan 契约对齐（纯投影，无副作用）：
 * - 百分比窗口归一为 remainingPercent（0-100），同时保留供应商原始 displayText；
 * - 非百分比窗口（unlimited / text / prepaid balance）remainingPercent 保持 -1，
 *   绝不把 used=0 误算成 100%，而是通过 displayText / unlimited 如实表达；
 * - 保留 pool / last / lastServedAt / readAt / resetsAt / error 元数据，供前端按当前模型精确过滤与主账号定位。
 */

/** 单个配额窗口（对齐 Magpie QuotaSpan）。 */
interface QuotaWindow {
  name?: string
  /** 窗口已用百分比 0-100（非百分比窗口不可作百分比解读）。 */
  used?: number
  /** 窗口剩余百分比 0-100（非百分比窗口不可作百分比解读）。 */
  remaining?: number
  resetsAt?: string
  /** 供应商原始表述（如 "0 / 6900"、"$12.34"）。 */
  display?: string
  /** 纯文本窗口：只有 display 有意义，used/remaining 不是百分比。 */
  text?: boolean
  /** 无限额度窗口。 */
  unlimited?: boolean
  /** 共享配额池名称（如 "Gemini"、"Claude & GPT"、"Gemini 4 Argon"）。 */
  pool?: string
  /** 预付钱包剩余金额（配合 unit 使用，非百分比）。 */
  balance?: number
  amount?: number
  limit?: number
  unit?: string
}

/** 单个订阅 / 计划 / 密钥的配额卡片（对齐 Magpie Quota）。 */
export interface QuotaEntry {
  provider?: string
  name?: string
  kind?: string
  plan?: string
  user?: string
  alias?: string
  windows?: QuotaWindow[]
  balance?: string
  until?: string
  resets?: { count?: number; until?: string }
  error?: string
  readAt?: string
  asOf?: string
  last?: boolean
  lastServedAt?: string
}

/** 窗口剩余百分比；非百分比窗口或 vendor 未给出时 undefined。 */
export function remainingPercent(window: QuotaWindow): number | undefined {
  if (window.unlimited === true || window.text === true) return undefined
  if (typeof window.balance === 'number' && Number.isFinite(window.balance)) return undefined
  if (typeof window.remaining === 'number' && Number.isFinite(window.remaining)) {
    return Math.max(0, Math.min(100, window.remaining))
  }
  if (typeof window.used === 'number' && Number.isFinite(window.used)) {
    return Math.max(0, Math.min(100, 100 - window.used))
  }
  return undefined
}

function formatCompactNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return Number(value.toFixed(2)).toString()
}

function formatBalanceText(balance: number, unit: string | undefined): string {
  const trimmed = unit?.trim() ?? ''
  const upper = trimmed.toUpperCase()
  if (trimmed === '$' || upper === 'USD') return `$${balance.toFixed(2)}`
  if (trimmed === '¥' || upper === 'CNY' || upper === 'RMB') return `¥${balance.toFixed(2)}`
  if (trimmed === '€' || upper === 'EUR') return `€${balance.toFixed(2)}`
  const num = formatCompactNumber(balance)
  return trimmed !== '' ? `${num} ${trimmed}` : num
}

function formatWindowDisplayText(window: QuotaWindow): string | undefined {
  if (window.unlimited === true) return '∞'
  if (typeof window.balance === 'number' && Number.isFinite(window.balance)) {
    return formatBalanceText(window.balance, window.unit)
  }
  const rawDisplay = window.display?.trim()
  if (rawDisplay) return rawDisplay
  if (
    typeof window.limit === 'number'
    && Number.isFinite(window.limit)
    && window.limit > 0
    && typeof window.amount === 'number'
    && Number.isFinite(window.amount)
  ) {
    const unit = window.unit?.trim()
    return `${formatCompactNumber(window.amount)} / ${formatCompactNumber(window.limit)}${unit ? ` ${unit}` : ''}`
  }
  return undefined
}

/** 重置时间的人读形式（相对时长）。 */
export function formatReset(resetsAt: string | undefined, now: number): string | undefined {
  if (!resetsAt) return undefined
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return undefined
  const left = at - now
  if (left <= 60_000) return 'now'
  const minutes = Math.round(left / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(left / 3_600_000)
  if (hours < 48) return `${hours}h`
  const days = Math.round(left / 86_400_000)
  if (days < 7) return `${days}d`
  return new Date(at).toISOString().slice(0, 10)
}

/** 展示行：单个窗口 → status doc 行（remainingPercent -1 表示无百分比读数）。 */
export interface QuotaRow {
  provider: string
  account?: string
  remainingPercent: number
  resetText?: string
  resetsAt?: string
  windowLabel?: string
  /** 非百分比窗口的真实读数或供应商原始单位表述（如 "0 / 6900"、"$12.50"、"∞"）。 */
  displayText?: string
  unlimited?: boolean
  /** 共享配额池名称（如 "Gemini"、"Claude & GPT"），供按模型精确过滤。 */
  pool?: string
  /** 网关标记的最近一次实际响应请求的账号。 */
  last?: boolean
  /** 网关记录的账号最近服务时间（ISO 字符串）。 */
  lastServedAt?: string
  /** 上游记录的本次配额读取时间（ISO 字符串）。 */
  readAt?: string
  /** 账号级读取错误原文（截断脱敏）。 */
  error?: string
}

/** 全部配额卡片 → 展示行（每窗口一行；无 windows 的卡片输出一行 -1）。 */
export function quotaRows(entries: readonly QuotaEntry[], now = Date.now()): QuotaRow[] {
  const rows: QuotaRow[] = []
  for (const entry of entries) {
    const provider = entry.provider?.trim() || entry.name?.trim() || 'provider'
    const account = entry.alias?.trim() || entry.user?.trim() || entry.plan?.trim() || undefined
    const readAt = entry.readAt?.trim() || entry.asOf?.trim() || undefined
    const lastServedAt = entry.lastServedAt?.trim() || undefined
    const last = entry.last === true ? true : undefined
    const sharedMeta = {
      ...(account !== undefined ? { account } : {}),
      ...(last !== undefined ? { last } : {}),
      ...(lastServedAt !== undefined ? { lastServedAt } : {}),
      ...(readAt !== undefined ? { readAt } : {}),
    }
    const windows = entry.windows ?? []
    if (windows.length === 0) {
      const errorText = entry.error?.trim() ? entry.error.trim().slice(0, 120) : undefined
      const balanceText = entry.balance?.trim() || undefined
      rows.push({
        provider,
        ...sharedMeta,
        remainingPercent: -1,
        ...(errorText !== undefined
          ? { error: errorText, windowLabel: `error: ${errorText}` }
          : balanceText !== undefined
            ? { displayText: balanceText, windowLabel: entry.kind === 'balance' ? 'Balance' : undefined }
            : {}),
      })
      continue
    }
    for (const window of windows) {
      const remaining = remainingPercent(window)
      const reset = formatReset(window.resetsAt, now)
      const resetsAt = window.resetsAt && Number.isFinite(Date.parse(window.resetsAt)) ? window.resetsAt : undefined
      const displayText = formatWindowDisplayText(window)
      const pool = window.pool?.trim() || undefined
      rows.push({
        provider,
        ...sharedMeta,
        remainingPercent: remaining === undefined ? -1 : Math.round(remaining),
        ...(reset !== undefined ? { resetText: reset } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        ...(window.name?.trim() ? { windowLabel: window.name.trim() } : {}),
        ...(displayText !== undefined ? { displayText } : {}),
        ...(window.unlimited === true ? { unlimited: true } : {}),
        ...(pool !== undefined ? { pool } : {}),
      })
    }
  }
  return rows
}
