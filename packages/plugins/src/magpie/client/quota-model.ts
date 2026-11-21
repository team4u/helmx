/**
 * Pure per-model quota filtering, account selection, compact formatting, and
 * auto-refresh interval resolution for builtin:magpie composer status UI.
 *
 * Fast Refresh friendly (no React components exported).
 *
 * Filtering contract (user-confirmed):
 * - Only quotas belonging to the currently selected Magpie model are kept:
 *   1. Match only the provider associated with the current model (`modelOwners` +
 *      direct `<provider>/<model>` prefix fallback);
 *   2. Exclude non-chat modality windows (`Image generation`, `Video generation`,
 *      `Audio`) and side tool quotas (`MCP · *`) when primary model windows exist;
 *   3. Match shared/model quota pools (`pool` field or `<Pool> · <Window>` prefix)
 *      strictly against the current model identity so unrelated pools (e.g.
 *      `Claude & GPT` when a `Gemini` model is active) never leak in;
 *   4. Exclude any account whose windows were all filtered out as unrelated pools;
 * - Status bar always displays ONLY the single primary account (preferring accounts
 *   with remaining quota over exhausted ones, then the gateway's `last` active
 *   account, then latest `lastServedAt`, then first order);
 * - Clicking opens a Popover listing ONLY the related accounts & windows for the
 *   current model.
 */
import type { ModelTierCatalogEntry } from '@helmx/protocol/browser'
import type { MagpieStatusQuotaView, MagpieStatusView } from './models.ts'
import { quotaRowTone } from './models.ts'

export const DEFAULT_REFRESH_INTERVAL_SEC = 5
export const MAX_REFRESH_INTERVAL_SEC = 3600
export const DEFAULT_SHOW_QUOTA_STATUS = true

export interface ResolvedMagpieModel {
  /** Model id after stripping the `magpie/` prefix (e.g. `auto/gemini-4-carbon`, `codex/gpt-5.2`). */
  bareModelId: string
  /** Human-readable short model name (e.g. `gemini-4-carbon`, `gpt-5.2`). */
  displayModelName: string
  /** True when the id uses Magpie routing namespaces (`auto/*` or `group/*`). */
  isRoutingGroup: boolean
}

export interface FormattedQuotaWindow {
  label: string
  valueText: string
  resetText?: string
  tone: 'ok' | 'warn' | 'err' | 'neutral'
  remainingPercent: number
  unlimited: boolean
  /** Optional raw unit detail (e.g. "0 / 6900") when percentage is also present. */
  detailText?: string
  sortRank: number
}

export interface ModelQuotaAccount {
  key: string
  provider: string
  account?: string
  last: boolean
  exhausted: boolean
  lastServedAtMs?: number
  readAtMs?: number
  windows: FormattedQuotaWindow[]
  error?: string
  tone: 'ok' | 'warn' | 'err' | 'neutral'
}

export interface ModelQuotaSummary {
  model: ResolvedMagpieModel
  providers: string[]
  /** All related accounts for the active model (primary account is `accounts[0]`). */
  accounts: ModelQuotaAccount[]
  /** Single account shown directly in the composer status line. */
  primary: ModelQuotaAccount | null
  /** Count of additional related accounts beyond primary (`accounts.length - 1`). */
  extraAccountCount: number
  /** Overall tone for the status-line trigger (follows the primary account). */
  triggerTone: 'ok' | 'warn' | 'err' | 'neutral'
  /** Latest known quota freshness timestamp in epoch ms. */
  updatedAt?: number
}

/** Resolve foreground auto-refresh interval in seconds from public plugin config (0 disables). */
export function resolveRefreshIntervalSec(config: Record<string, unknown> | undefined): number {
  const raw = config?.refreshIntervalSec
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_REFRESH_INTERVAL_SEC
  if (raw <= 0) return 0
  return Math.min(MAX_REFRESH_INTERVAL_SEC, Math.max(1, Math.round(raw)))
}

/** Resolve whether Magpie quota UI is enabled from public plugin config (defaults to true). */
export function resolveShowQuotaStatus(config: Record<string, unknown> | undefined): boolean {
  if (typeof config?.showQuotaStatus === 'boolean') return config.showQuotaStatus
  return DEFAULT_SHOW_QUOTA_STATUS
}

/** Resolve raw conversation/standby model reference (`provider/model` or `tier/<id>`) to a Magpie model, or null. */
export function resolveEffectiveMagpieModel(
  rawModel: string | undefined,
  modelTiers?: readonly ModelTierCatalogEntry[],
): ResolvedMagpieModel | null {
  const trimmed = rawModel?.trim()
  if (!trimmed) return null
  let concrete = trimmed
  if (trimmed.startsWith('tier/')) {
    const tierId = trimmed.slice('tier/'.length)
    const matched = modelTiers?.find((tier) => tier.id === tierId)
    if (!matched?.model) return null
    concrete = matched.model.trim()
  }
  if (!concrete.startsWith('magpie/')) return null
  const bareModelId = concrete.slice('magpie/'.length).trim()
  if (!bareModelId) return null
  const isRoutingGroup = bareModelId.startsWith('auto/') || bareModelId.startsWith('group/')
  const slash = bareModelId.indexOf('/')
  const displayModelName = slash > 0 && slash < bareModelId.length - 1
    ? bareModelId.slice(slash + 1)
    : bareModelId
  return { bareModelId, displayModelName, isRoutingGroup }
}

/** Resolve owning Magpie provider id for the given bare Magpie model id. */
export function resolveModelProviders(bareModelId: string, status: MagpieStatusView): string[] {
  const out: string[] = []
  const add = (candidate: string | undefined): void => {
    const trimmed = candidate?.trim()
    if (!trimmed || trimmed === 'auto' || trimmed === 'group') return
    if (!out.includes(trimmed)) out.push(trimmed)
  }
  add(status.modelOwners[bareModelId])
  if (out.length === 0) {
    const slash = bareModelId.indexOf('/')
    if (slash > 0) add(bareModelId.slice(0, slash))
  }
  return out
}

// ---------------------------------------------------------------------------
// Per-model window pool & modality filtering
// ---------------------------------------------------------------------------

const NON_CHAT_WINDOW_RE = /\b(image\s+generation|video\s+generation|audio\s+generation|tts|speech|whisper)\b/i
const MCP_SIDE_WINDOW_RE = /^mcp(?:\s*[·:-]|\s+|$)/i
const KNOWN_MODEL_POOL_RE = /\b(gemini|claude|gpt|codex|opus|sonnet|haiku|o[134](?:\b|-)|deepseek|qwen|glm|kimi|minimax|mimo|llama|mistral|grok|sonar|nova)\b/i

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
}

/** Check whether `needleTokens` appears as a contiguous token sequence inside `haystackTokens`. */
function containsTokenSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false
  for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    let ok = true
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

/** Infer a model pool label from structured `row.pool` or a `<Pool> · <Window>` label prefix. */
function extractWindowPool(row: MagpieStatusQuotaView): string | undefined {
  if (row.pool?.trim()) return row.pool.trim()
  const label = row.windowLabel?.trim()
  if (!label) return undefined
  const sep = label.indexOf(' · ')
  if (sep <= 0) return undefined
  const prefix = label.slice(0, sep).trim()
  if (!prefix) return undefined
  if (KNOWN_MODEL_POOL_RE.test(prefix)) return prefix
  return undefined
}

/** Match a pool name (e.g. "Gemini", "Claude & GPT", "Gemini 4 Argon") against the model tokens. */
function matchPoolSpecificity(pool: string, modelTokens: readonly string[]): number {
  const parts = pool
    .split(/\s*(?:&|,|\/|\band\b)\s*/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  let best = 0
  for (const part of parts) {
    const tokens = tokenize(part)
    if (tokens.length === 0) continue
    if (containsTokenSequence(modelTokens, tokens)) {
      const hasDigit = tokens.some((token) => /\d/.test(token))
      // Versioned model-specific pools (e.g. "Gemini 4 Argon") outrank family pools ("Gemini").
      const score = tokens.length * 10 + (hasDigit ? 100 : 0)
      if (score > best) best = score
    }
  }
  return best
}

function isNonChatWindow(row: MagpieStatusQuotaView): boolean {
  const label = row.windowLabel?.trim() ?? ''
  return label !== '' && NON_CHAT_WINDOW_RE.test(label)
}

function isMcpSideWindow(row: MagpieStatusQuotaView): boolean {
  const label = row.windowLabel?.trim() ?? ''
  return label !== '' && MCP_SIDE_WINDOW_RE.test(label)
}

/** Filter one account's raw quota rows down to ONLY windows relevant to the current model. */
function filterAccountRowsForModel(
  rawRows: readonly MagpieStatusQuotaView[],
  model: ResolvedMagpieModel,
): { rows: MagpieStatusQuotaView[]; excludedByPool: boolean } {
  // Error-only or windowless account cards pass through intact (honest unavailability reporting).
  const hasRealWindow = rawRows.some((row) => !row.error && (row.windowLabel !== undefined || row.remainingPercent >= 0 || row.displayText !== undefined || row.unlimited))
  if (!hasRealWindow) {
    return { rows: [...rawRows], excludedByPool: false }
  }

  const chatRows = rawRows.filter((row) => !isNonChatWindow(row))
  const nonMcpRows = chatRows.filter((row) => !isMcpSideWindow(row))
  const working = nonMcpRows.length > 0 ? nonMcpRows : chatRows
  if (working.length === 0) {
    return { rows: [], excludedByPool: true }
  }

  const modelTokens = tokenize(`${model.displayModelName} ${model.bareModelId}`)
  const annotated = working.map((row) => {
    const pool = extractWindowPool(row)
    const score = pool !== undefined ? matchPoolSpecificity(pool, modelTokens) : -1
    return { row, pool, score }
  })

  const hasAnyPooled = annotated.some((item) => item.pool !== undefined)
  if (!hasAnyPooled) {
    return { rows: working, excludedByPool: false }
  }

  const maxMatchedScore = annotated.reduce((best, item) => (item.score > best ? item.score : best), 0)
  const kept: MagpieStatusQuotaView[] = []
  for (const item of annotated) {
    if (item.pool === undefined) {
      kept.push(item.row)
      continue
    }
    if (item.score > 0 && item.score === maxMatchedScore) {
      kept.push(item.row)
    }
  }
  return { rows: kept, excludedByPool: kept.length === 0 }
}

// ---------------------------------------------------------------------------
// Formatting & sorting
// ---------------------------------------------------------------------------

/** Dynamic reset countdown relative to `nowMs` (falls back to server `resetText`). */
export function formatDynamicReset(
  resetsAt: string | undefined,
  fallbackResetText: string | undefined,
  nowMs: number | undefined,
): string | undefined {
  if (resetsAt && nowMs !== undefined && Number.isFinite(nowMs)) {
    const at = Date.parse(resetsAt)
    if (Number.isFinite(at)) {
      const left = at - nowMs
      if (left <= 60_000) return 'now'
      const minutes = Math.round(left / 60_000)
      if (minutes < 60) return `${minutes}m`
      const hours = Math.round(left / 3_600_000)
      if (hours < 48) return `${hours}h`
      const days = Math.round(left / 86_400_000)
      if (days < 7) return `${days}d`
      return new Date(at).toISOString().slice(5, 10)
    }
  }
  if (!fallbackResetText) return undefined
  // Compact YYYY-MM-DD to MM-DD for tight status rows.
  if (/^\d{4}-\d{2}-\d{2}$/.test(fallbackResetText)) return fallbackResetText.slice(5)
  return fallbackResetText
}

/** Compact window label after removing redundant matched model pool prefix. */
export function compactWindowLabel(row: MagpieStatusQuotaView): string {
  let label = row.windowLabel?.trim() ?? ''
  if (!label) return 'Quota'
  const pool = extractWindowPool(row)
  if (pool) {
    const prefix = `${pool} · `
    if (label.toLowerCase().startsWith(prefix.toLowerCase())) {
      label = label.slice(prefix.length).trim()
    }
  }
  label = label
    .replace(/\b(\d+)\s*hours?\b/gi, '$1h')
    .replace(/\b(\d+)\s*days?\b/gi, '$1d')
    .replace(/\b(\d+)\s*minutes?\b/gi, '$1m')
    .replace(/^daily$/i, '1d')
    .replace(/^weekly$/i, '7d')
    .replace(/^monthly$/i, '30d')
    .replace(/^5\s*h$/i, '5h')
    .replace(/^7\s*d$/i, '7d')
  return label || 'Quota'
}

/** Order shorter / tighter windows first so 5h precedes 7d, 30d, total credits. */
function windowSortRank(compactLabel: string): number {
  const lower = compactLabel.toLowerCase()
  const unitMatch = /^(\d+)\s*([mhd])$/.exec(lower)
  if (unitMatch && unitMatch[1] && unitMatch[2]) {
    const n = Number(unitMatch[1])
    if (unitMatch[2] === 'm') return n
    if (unitMatch[2] === 'h') return n * 60
    if (unitMatch[2] === 'd') return n * 60 * 24
  }
  if (lower.includes('session')) return 300
  if (lower.includes('day') || lower.includes('daily')) return 1440
  if (lower.includes('week')) return 10_080
  if (lower.includes('month')) return 43_200
  if (lower === 'credits') return 50_000
  if (lower.includes('extra')) return 60_000
  if (lower.includes('total')) return 70_000
  return 55_000
}

function formatWindow(row: MagpieStatusQuotaView, nowMs: number | undefined): FormattedQuotaWindow {
  const label = compactWindowLabel(row)
  const tone = quotaRowTone(row)
  let valueText: string
  let detailText: string | undefined
  if (row.unlimited) {
    valueText = '∞'
  } else if (row.remainingPercent >= 0) {
    valueText = `${row.remainingPercent}%`
    if (row.displayText && row.displayText !== valueText) detailText = row.displayText
  } else if (row.displayText) {
    valueText = row.displayText
  } else {
    valueText = row.error ? 'n/a' : '—'
  }
  return {
    label,
    valueText,
    resetText: formatDynamicReset(row.resetsAt, row.resetText, nowMs),
    tone,
    remainingPercent: row.remainingPercent,
    unlimited: row.unlimited === true,
    ...(detailText !== undefined ? { detailText } : {}),
    sortRank: windowSortRank(label),
  }
}

const TOTAL_CREDIT_WINDOW_RE = /\btotal\b.*\bcredits?\b|\bcredits?\b.*\btotal\b/i
const EXTRA_CREDIT_WINDOW_RE = /\bextra\b/i
const BASE_CREDIT_WINDOW_RE = /^credits?$/i
const PURE_BALANCE_TEXT_RE = /^([+-])?\s*(?:[$¥€£])?\s*([+-])?(\d+(?:\.\d+)?)\s*(?:USD|CNY|RMB|EUR|GBP|credits?)?$/i

/** Parse a pure non-percentage balance string (e.g. "$0.00", "-$1.50", "$32.12"); returns undefined for ratios ("0 / 6900") or free text ("Unknown"). */
function parsePureBalanceValue(text: string): number | undefined {
  const trimmed = text.trim()
  if (!trimmed || trimmed.includes('/') || trimmed.includes('%')) return undefined
  const match = PURE_BALANCE_TEXT_RE.exec(trimmed)
  if (!match || !match[3]) return undefined
  if (match[1] && match[2]) return undefined
  const sign = match[1] === '-' || match[2] === '-' ? -1 : 1
  const magnitude = Number(match[3])
  return Number.isFinite(magnitude) ? sign * magnitude : undefined
}

function isWindowExhausted(win: FormattedQuotaWindow): boolean {
  if (win.unlimited) return false
  if (win.remainingPercent >= 0) return win.remainingPercent <= 0
  const balance = parsePureBalanceValue(win.valueText)
  return balance !== undefined && balance <= 0
}

/**
 * Determine whether an account's active-model quota is exhausted (0% remaining on a gating
 * window, or <=0 prepaid balance):
 * - Unlimited windows are never exhausted;
 * - Additive credit pools (`Credits` + `Extra credits` / `Total credits`) stay available while
 *   `Total credits` (or either base/extra credit pool) still has remaining quota;
 * - Optional `Extra` windows never mark an account exhausted while primary windows still have quota;
 * - Standard rate-limit / subscription windows (e.g. `5h`, `7d`, `Subscription`) are conjunctive:
 *   hitting 0% on any gating window makes the account unusable until reset;
 * - Non-percentage prepaid balance windows (`$0.00`) count as exhausted when <= 0; ratios
 *   ("0 / 6900") and free text ("Unknown") are never falsely marked exhausted.
 */
export function isAccountExhausted(windows: readonly FormattedQuotaWindow[]): boolean {
  if (windows.length === 0) return false

  const totalCreditWindows: FormattedQuotaWindow[] = []
  const extraCreditWindows: FormattedQuotaWindow[] = []
  const baseCreditWindows: FormattedQuotaWindow[] = []
  const standardWindows: FormattedQuotaWindow[] = []

  for (const win of windows) {
    if (TOTAL_CREDIT_WINDOW_RE.test(win.label)) {
      totalCreditWindows.push(win)
    } else if (EXTRA_CREDIT_WINDOW_RE.test(win.label)) {
      extraCreditWindows.push(win)
    } else if (BASE_CREDIT_WINDOW_RE.test(win.label)) {
      baseCreditWindows.push(win)
    } else {
      standardWindows.push(win)
    }
  }

  if (standardWindows.some(isWindowExhausted)) return true

  if (totalCreditWindows.length > 0) {
    return totalCreditWindows.some(isWindowExhausted)
  }
  if (baseCreditWindows.length > 0 && extraCreditWindows.length > 0) {
    return [...baseCreditWindows, ...extraCreditWindows].every(isWindowExhausted)
  }
  if (baseCreditWindows.length > 0) {
    return baseCreditWindows.some(isWindowExhausted)
  }
  if (standardWindows.length === 0 && extraCreditWindows.length > 0) {
    return extraCreditWindows.every(isWindowExhausted)
  }
  return false
}

function worstTone(tones: readonly ('ok' | 'warn' | 'err' | 'neutral')[]): 'ok' | 'warn' | 'err' | 'neutral' {
  if (tones.includes('err')) return 'err'
  if (tones.includes('warn')) return 'warn'
  if (tones.includes('ok')) return 'ok'
  return 'neutral'
}

function parseTimestampMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * Project Magpie status doc into the current model's strictly filtered quota view:
 * - Only accounts and windows relevant to `model`;
 * - `primary` is the single active/default account for the composer status bar;
 * - `accounts` is the filtered list shown when opening the popover.
 */
export function selectModelQuotas(
  model: ResolvedMagpieModel,
  status: MagpieStatusView,
  nowMs?: number,
): ModelQuotaSummary {
  const providers = resolveModelProviders(model.bareModelId, status)
  const providerSet = new Set(providers)

  // Group raw quota rows by (provider, account) while preserving gateway insertion order.
  const grouped = new Map<string, { provider: string; account?: string; rows: MagpieStatusQuotaView[]; order: number }>()
  for (const row of status.quotas) {
    if (providerSet.size === 0 || !providerSet.has(row.provider)) continue
    const key = `${row.provider}\0${row.account ?? ''}`
    let bucket = grouped.get(key)
    if (!bucket) {
      bucket = { provider: row.provider, account: row.account, rows: [], order: grouped.size }
      grouped.set(key, bucket)
    }
    bucket.rows.push(row)
  }

  const accountsWithOrder: Array<ModelQuotaAccount & { order: number }> = []
  for (const [key, bucket] of grouped) {
    const filtered = filterAccountRowsForModel(bucket.rows, model)
    if (filtered.excludedByPool || filtered.rows.length === 0) continue

    const errorRow = filtered.rows.find((row) => row.error !== undefined)
    const windowRows = filtered.rows.filter((row) => row.error === undefined && (row.windowLabel !== undefined || row.remainingPercent >= 0 || row.displayText !== undefined || row.unlimited))
    const windows = windowRows
      .map((row) => formatWindow(row, nowMs))
      .sort((a, b) => a.sortRank - b.sortRank)

    const last = bucket.rows.some((row) => row.last === true)
    let lastServedAtMs: number | undefined
    let readAtMs: number | undefined
    for (const row of bucket.rows) {
      const served = parseTimestampMs(row.lastServedAt)
      if (served !== undefined && (lastServedAtMs === undefined || served > lastServedAtMs)) lastServedAtMs = served
      const read = parseTimestampMs(row.readAt)
      if (read !== undefined && (readAtMs === undefined || read > readAtMs)) readAtMs = read
    }

    const tone = windows.length > 0
      ? worstTone(windows.map((w) => w.tone))
      : errorRow !== undefined
        ? 'warn'
        : 'neutral'

    const exhausted = isAccountExhausted(windows)

    accountsWithOrder.push({
      key,
      provider: bucket.provider,
      ...(bucket.account !== undefined ? { account: bucket.account } : {}),
      last,
      exhausted,
      ...(lastServedAtMs !== undefined ? { lastServedAtMs } : {}),
      ...(readAtMs !== undefined ? { readAtMs } : {}),
      windows,
      ...(errorRow?.error !== undefined && windows.length === 0 ? { error: errorRow.error } : {}),
      tone,
      order: bucket.order,
    })
  }

  // Primary account priority:
  // 1. Accounts with real quota windows before error/windowless accounts;
  // 2. Accounts with remaining quota before exhausted accounts;
  // 3. Gateway `last: true` (account that served the most recent request);
  // 4. Most recent `lastServedAtMs`;
  // 5. Gateway provider/account order.
  accountsWithOrder.sort((a, b) => {
    const aHasWindows = a.windows.length > 0 ? 0 : 1
    const bHasWindows = b.windows.length > 0 ? 0 : 1
    if (aHasWindows !== bHasWindows) return aHasWindows - bHasWindows
    if (a.exhausted !== b.exhausted) return a.exhausted ? 1 : -1
    if (a.last !== b.last) return a.last ? -1 : 1
    const aServed = a.lastServedAtMs ?? -1
    const bServed = b.lastServedAtMs ?? -1
    if (aServed !== bServed) return bServed - aServed
    return a.order - b.order
  })

  const accounts: ModelQuotaAccount[] = accountsWithOrder.map(({ order: _order, ...account }) => account)
  const primary = accounts[0] ?? null
  const updatedAt = status.quotasRefreshedAt ?? status.quotasUpdatedAt ?? status.lastRefreshedAt

  return {
    model,
    providers,
    accounts,
    primary,
    extraAccountCount: Math.max(0, accounts.length - 1),
    triggerTone: primary ? primary.tone : status.quotasError ? 'warn' : 'neutral',
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  }
}

/** Generic window labels that add noise without distinguishing duration or bucket in the tight status row. */
const INLINE_OMIT_WINDOW_LABEL_RE = /^(?:subscriptions?|订阅|quota)$/i

/** Whether a window label should be rendered inline in the composer status row (Popover always shows full labels). */
export function shouldShowInlineWindowLabel(label: string): boolean {
  const trimmed = label.trim()
  return trimmed.length > 0 && !INLINE_OMIT_WINDOW_LABEL_RE.test(trimmed)
}

/** Build the compact single-account window items shown inline in the composer status row. */
export function inlineSummaryWindows(account: ModelQuotaAccount): {
  visible: FormattedQuotaWindow[]
  hiddenCount: number
} {
  if (account.windows.length <= 3) {
    return { visible: account.windows, hiddenCount: 0 }
  }
  return {
    visible: account.windows.slice(0, 2),
    hiddenCount: account.windows.length - 2,
  }
}
