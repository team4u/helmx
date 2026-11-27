/**
 * Pure data models for the builtin:triggers client.tsx (no component exports,
 * Fast Refresh friendly).
 *
 * Doc shapes mirror the server-side triggers/cron.ts and triggers/webhook.ts
 * contracts; run history is projected directly from live store conversations
 * tagged `cron:<id>` / `webhook:<id>` (zero double-writing in plugin docs).
 */
import type { ConversationSummary } from '@helmx/protocol/browser'
import { DEFAULT_HELMX_LOCALE, resolveLocalizedText, type HelmxLocale } from '@helmx/ui'
import {
  TRIGGER_MODE_DEDICATED,
  TRIGGERS_STATUS_BLOCKED,
  TRIGGERS_STATUS_DONE,
  TRIGGERS_STATUS_ERROR,
  TRIGGERS_STATUS_IDLE,
  TRIGGERS_STATUS_WORKING,
  triggerModeIsolated,
  triggerTargetConversation,
  triggerTargetProfile,
} from './copy.ts'

export type TriggerSessionMode = 'isolated' | 'dedicated'

/** Row shape of the CronDoc (public doc 'crons'), display field subset. */
export interface CronJobRow {
  id: string
  description?: string
  schedule: string
  timezone: string
  text: string
  enabled: boolean
  catchUp: boolean
  targetConversationId?: number
  mode?: TriggerSessionMode
  profileId?: string
  keepLast?: number
  dedicatedConversationId?: number
  lastRunAt?: number
  nextRunAt?: number
  lastError?: string
  lastSkippedAt?: number
  lastSkipReason?: string
}

/** Row shape of the WebhooksDoc (public doc 'webhooks'), display field subset. */
export interface WebhookRow {
  id: string
  hasSecret: boolean
  description?: string
  targetConversationId?: number
  mode?: TriggerSessionMode
  profileId?: string
  keepLast?: number
  dedicatedConversationId?: number
  createdAt: number
}

export type TriggerDetailSelection =
  | { kind: 'cron'; id: string }
  | { kind: 'webhook'; id: string }

/** Serialize a trigger drawer selection into a URL-safe `trigger` screen param. */
export function encodeTriggerSelection(selection: TriggerDetailSelection): string {
  return `${selection.kind}:${selection.id}`
}

/** Parse a `trigger` screen param back into a typed selection (null when malformed or empty). */
export function parseTriggerSelection(raw: string | undefined): TriggerDetailSelection | null {
  if (raw === undefined || raw === '') return null
  if (raw.startsWith('cron:')) {
    const id = raw.slice('cron:'.length)
    return id !== '' ? { kind: 'cron', id } : null
  }
  if (raw.startsWith('webhook:')) {
    const id = raw.slice('webhook:'.length)
    return id !== '' ? { kind: 'webhook', id } : null
  }
  return null
}

/**
 * Human-readable summary of a trigger's delivery mode & target.
 * Copy resolves against the given locale (defaults to en).
 */
export function formatTriggerTargetSummary(
  row: {
    targetConversationId?: number
    mode?: TriggerSessionMode
    profileId?: string
    keepLast?: number
  },
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): string {
  if (row.targetConversationId !== undefined) {
    return triggerTargetConversation(row.targetConversationId, locale)
  }
  const modeLabel =
    row.mode === 'dedicated'
      ? resolveLocalizedText(TRIGGER_MODE_DEDICATED, locale)
      : triggerModeIsolated(row.keepLast, locale)
  const profileLabel = triggerTargetProfile(row.profileId || 'assistant', locale)
  return `${modeLabel} · ${profileLabel}`
}

/**
 * Select root conversations belonging to a cron job or webhook endpoint directly
 * from the live conversation list (SSOT: tagged `cron:<id>` / `webhook:<id>`, newest first).
 */
export function selectTriggerRuns(
  conversations: ReadonlyArray<ConversationSummary>,
  kind: 'cron' | 'webhook',
  id: string,
): ConversationSummary[] {
  const sourceTag = `${kind}:${id}`
  return conversations
    .filter((c) => c.parentConversationId === undefined && c.tags.includes(sourceTag))
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
}

/** Aggregate live status of a trigger's runs for compact table health indicators. */
export interface TriggerRunHealth {
  count: number
  status: 'error' | 'blocked' | 'working' | 'done' | null
}

export function summarizeTriggerRunHealth(runs: ReadonlyArray<ConversationSummary>): TriggerRunHealth {
  let hasError = false
  let hasBlocked = false
  let hasWorking = false
  for (const run of runs) {
    if (run.status === 'error') hasError = true
    else if (run.status === 'blocked' || run.pendingAskCount > 0) hasBlocked = true
    else if (run.status === 'working') hasWorking = true
  }
  const status = hasError
    ? 'error'
    : hasBlocked
      ? 'blocked'
      : hasWorking
        ? 'working'
        : runs.length > 0
          ? 'done'
          : null
  return { count: runs.length, status }
}

/** 需要在 ID 列常显状态灯的运行态（其余状态不显示灯）。 */
export type AlertingRunStatus = Extract<TriggerRunHealth['status'], 'error' | 'blocked' | 'working'>

export function asAlertingRunStatus(status: TriggerRunHealth['status']): AlertingRunStatus | undefined {
  return status === 'error' || status === 'blocked' || status === 'working' ? status : undefined
}

export type TriggersManagerTab = 'cron' | 'webhook'

/** Filter cron jobs by id, schedule, command text, description, or last error. */
export function filterCronJobs(jobs: ReadonlyArray<CronJobRow>, query: string): CronJobRow[] {
  const q = query.trim().toLowerCase()
  if (q === '') return jobs.slice()
  return jobs.filter(
    (job) =>
      job.id.toLowerCase().includes(q) ||
      job.schedule.toLowerCase().includes(q) ||
      job.text.toLowerCase().includes(q) ||
      (job.description?.toLowerCase().includes(q) ?? false) ||
      (job.lastError?.toLowerCase().includes(q) ?? false),
  )
}

/** Filter webhooks by id or description. */
export function filterWebhooks(hooks: ReadonlyArray<WebhookRow>, query: string): WebhookRow[] {
  const q = query.trim().toLowerCase()
  if (q === '') return hooks.slice()
  return hooks.filter(
    (hook) =>
      hook.id.toLowerCase().includes(q) ||
      (hook.description?.toLowerCase().includes(q) ?? false),
  )
}

/** Localized accessible label for a conversation status light. */
export function triggerRunStatusLabel(status: ConversationSummary['status'], locale: HelmxLocale): string {
  switch (status) {
    case 'working':
      return resolveLocalizedText(TRIGGERS_STATUS_WORKING, locale)
    case 'blocked':
      return resolveLocalizedText(TRIGGERS_STATUS_BLOCKED, locale)
    case 'error':
      return resolveLocalizedText(TRIGGERS_STATUS_ERROR, locale)
    case 'done':
      return resolveLocalizedText(TRIGGERS_STATUS_DONE, locale)
    default:
      return resolveLocalizedText(TRIGGERS_STATUS_IDLE, locale)
  }
}

export function parseCronJobs(doc: { jobs?: unknown } | undefined): CronJobRow[] {
  return Array.isArray(doc?.jobs) ? (doc!.jobs as CronJobRow[]) : []
}

export function parseWebhooks(doc: { webhooks?: unknown } | undefined): WebhookRow[] {
  return Array.isArray(doc?.webhooks) ? (doc!.webhooks as WebhookRow[]) : []
}
