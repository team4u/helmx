/**
 * Pure data models for the builtin:magpie client.tsx (no component exports,
 * Fast Refresh friendly).
 *
 * The doc shape mirrors the MagpieStatusDoc contract from magpie/contracts.ts;
 * parsing is lenient: when the doc has not arrived we return safe defaults
 * instead of fabricating data.
 */
import { DEFAULT_HELMX_LOCALE, type HelmxLocale } from '@helmx/ui'
import { magpieBoolLabel } from './copy.ts'

export interface MagpieStatusQuotaView {
  provider: string
  account?: string
  windowLabel?: string
  remainingPercent: number
  resetText?: string
  resetsAt?: string
  displayText?: string
  unlimited?: boolean
  pool?: string
  last?: boolean
  lastServedAt?: string
  readAt?: string
  error?: string
}

/** Display field subset of MagpieStatusDoc. */
export interface MagpieStatusView {
  gatewayUrl: string
  configuredRoot: boolean
  local: boolean
  reachable: boolean
  modelCount: number
  lastRefreshedAt?: number
  lastError?: string
  quotasRefreshedAt?: number
  quotasUpdatedAt?: number
  quotasError?: string
  summaryText: string
  modelOwners: Record<string, string>
  quotas: MagpieStatusQuotaView[]
  diagnostics: string[]
}

const EMPTY: MagpieStatusView = {
  gatewayUrl: '',
  configuredRoot: false,
  local: true,
  reachable: false,
  modelCount: 0,
  summaryText: '',
  modelOwners: {},
  quotas: [],
  diagnostics: [],
}

function parseModelOwners(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim()
  }
  return out
}

/** Lenient read of the status doc (missing fields fall back to safe defaults). */
export function parseStatus(doc: Partial<MagpieStatusView> | undefined): MagpieStatusView {
  if (doc === undefined || typeof doc !== 'object') return EMPTY
  return {
    gatewayUrl: typeof doc.gatewayUrl === 'string' ? doc.gatewayUrl : '',
    configuredRoot: doc.configuredRoot === true,
    local: doc.local !== false,
    reachable: doc.reachable === true,
    modelCount: typeof doc.modelCount === 'number' ? doc.modelCount : 0,
    lastRefreshedAt: typeof doc.lastRefreshedAt === 'number' ? doc.lastRefreshedAt : undefined,
    lastError: typeof doc.lastError === 'string' ? doc.lastError : undefined,
    quotasRefreshedAt: typeof doc.quotasRefreshedAt === 'number' ? doc.quotasRefreshedAt : undefined,
    quotasUpdatedAt: typeof doc.quotasUpdatedAt === 'number' ? doc.quotasUpdatedAt : undefined,
    quotasError: typeof doc.quotasError === 'string' ? doc.quotasError : undefined,
    summaryText: typeof doc.summaryText === 'string' ? doc.summaryText : '',
    modelOwners: parseModelOwners(doc.modelOwners),
    quotas: Array.isArray(doc.quotas) ? doc.quotas : [],
    diagnostics: Array.isArray(doc.diagnostics) ? doc.diagnostics.filter((d) => typeof d === 'string') : [],
  }
}

/** Boolean display: yes / no (resolved against the given locale, defaults to en). */
export function boolLabel(value: boolean, locale: HelmxLocale = DEFAULT_HELMX_LOCALE): string {
  return magpieBoolLabel(value, locale)
}

/** Quota remaining-percent tone (<20% warning threshold). */
export function quotaTone(remainingPercent: number): 'ok' | 'warn' | 'err' {
  if (remainingPercent < 5) return 'err'
  if (remainingPercent < 20) return 'warn'
  return 'ok'
}

/** Display tone for a quota row (distinguishes non-percentage / unlimited / error rows honestly). */
export function quotaRowTone(row: Pick<MagpieStatusQuotaView, 'remainingPercent' | 'unlimited' | 'error'>): 'ok' | 'warn' | 'err' | 'neutral' {
  if (row.unlimited) return 'ok'
  if (row.error) return 'warn'
  if (row.remainingPercent < 0) return 'neutral'
  return quotaTone(row.remainingPercent)
}

/** Settings-table display text for a quota row's remaining column. */
export function quotaRowRemainingText(row: Pick<MagpieStatusQuotaView, 'remainingPercent' | 'displayText' | 'unlimited' | 'error'>): string {
  if (row.unlimited) return '∞'
  if (row.remainingPercent >= 0) return `${row.remainingPercent}%`
  if (row.displayText) return row.displayText
  return row.error ? 'n/a' : '—'
}
