/**
 * builtin:triggers cron 模块的共享词汇：持久化 `crons` doc 形状、调度依赖端口、
 * 运行时句柄，以及解析/存储层共用的两类显式失败（校验错误 / doc 损坏）。
 */
import { HelmxError, type ConversationSummary, type ExternalTriggerEnvelope } from '@helmx/protocol'
import type { SchedulerClock } from '../../durable-scheduler.js'
import type { ProfileLookup, TriggerSessionMode } from '../contracts.js'
import type { TriggerDeliveryTarget, TriggerDispatchResult } from '../delivery.js'

export const CRON_DOC_NAME = 'crons'
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
/** 决策失败后的最短重试间隔（避免损坏 doc 触发紧凑重试风暴）。 */
export const DECISION_RETRY_FLOOR_MS = 60_000

export type CronClock = SchedulerClock

export interface CronJob {
  id: string
  /** Creation generation (randomUUID) checked on claim/lastError write-backs against (id, rev). */
  rev: string
  description?: string
  /** Standard five-field cron expression (min hour day month weekday). */
  schedule: string
  /** IANA timezone, default 'UTC'. */
  timezone: string
  /** Text payload delivered at trigger time. */
  text: string
  enabled: boolean
  /** true: catch up missed intervals once after restart; false: jump to a future point. */
  catchUp: boolean
  /** Explicit existing conversation target (mutually exclusive with mode/profileId/keepLast/dedicatedConversationId). */
  targetConversationId?: number
  /** Automated session mode when targetConversationId is unset ('isolated' | 'dedicated'). */
  mode?: TriggerSessionMode
  /** Target Profile ID for automated sessions (defaults to 'assistant'). */
  profileId?: string
  /** Retention cap of settled isolated runs (only when mode === 'isolated'). */
  keepLast?: number
  /** Persisted dedicated conversation ID (only when mode === 'dedicated'). */
  dedicatedConversationId?: number
  lastRunAt?: number
  nextRunAt?: number
  lastError?: string
  /** Epoch ms of the latest scheduled tick skipped due to an overlapping in-flight run. */
  lastSkippedAt?: number
  lastSkipReason?: string
}

export interface CronDoc {
  version: 1
  jobs: CronJob[]
}

export interface CronDeps {
  dispatchTrigger(
    event: ExternalTriggerEnvelope,
    target: TriggerDeliveryTarget,
  ): Promise<TriggerDispatchResult>
  findActiveRun?(jobId: string): ConversationSummary | undefined
  profiles?: ProfileLookup
}

export interface CronRuntime {
  tickNow(): Promise<void>
  settle(): Promise<void>
  getJob(id: string): CronJob | undefined
}

/** `cron_update` 的已校验输入（id + 至少一个补丁字段）。 */
export interface CronUpdateInput {
  id: string
  description?: string
  schedule?: string
  timezone?: string
  text?: string
  enabled?: boolean
  catchUp?: boolean
  mode?: TriggerSessionMode
  profileId?: string
  keepLast?: number
  targetConversationId?: number
}

export function failValidation(message: string, field: string, extra?: Record<string, unknown>): never {
  throw new HelmxError('validation_error', message, 400, { field, ...extra })
}

export function failCorrupt(message: string, details?: Record<string, unknown>): never {
  throw new HelmxError('cron_doc_corrupt', `crons doc corrupted: ${message}`, 500, details)
}
