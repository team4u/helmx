/**
 * cron 动作层：`cron_list / cron_create / cron_update / cron_delete / cron_trigger`
 * 五个 `ctx.action` 声明（inputSchema / outputSchema / CLI 映射见 `./inputs.ts`），
 * 处理器只做「校验 → 存储 → 重排 timer」，不含调度决策。
 */
import { randomUUID } from 'node:crypto'
import { HelmxError, type HelmxPluginContext } from '@helmx/protocol'
import { assertTriggerProfileExists, type TriggerDeliveryTarget } from '../delivery.js'
import { type CronClock, type CronDeps, type CronJob } from './contracts.js'
import {
  CRON_CREATE_INPUT_SCHEMA,
  CRON_DELETE_OUTPUT_SCHEMA,
  CRON_ID_INPUT_SCHEMA,
  CRON_JOB_OUTPUT_SCHEMA,
  CRON_LIST_OUTPUT_SCHEMA,
  CRON_TRIGGER_OUTPUT_SCHEMA,
  CRON_UPDATE_INPUT_SCHEMA,
  parseCronUpdateInput,
} from './inputs.js'
import { normalizeCronInput } from './parse.js'
import type { CronStore } from './store.js'
import { buildCronEnvelope } from './tick.js'

/** 动作层共用的调度器句柄（timer 表与 scheduler 单例同源）。 */
export interface CronActionRuntime {
  store: CronStore
  deps: CronDeps
  clock: CronClock
  targetForJob: (job: CronJob) => TriggerDeliveryTarget
  scheduleJob: (id: string) => void
  clearJobTimer: (id: string) => void
}

export function registerCronActions(ctx: HelmxPluginContext, runtime: CronActionRuntime): void {
  const { store, deps, clock, targetForJob, scheduleJob, clearJobTimer } = runtime

  ctx.action({
    id: 'cron_list',
    description: 'List all cron jobs (incl. mode/lastRunAt/nextRunAt/lastError/lastSkippedAt scheduling state)',
    exposeToPrompt: false,
    idempotent: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: CRON_LIST_OUTPUT_SCHEMA,
    cli: { command: ['cron', 'list'] },
    handler: () => ({ jobs: store.readDoc().jobs.map((job) => structuredClone(job)) }),
  })

  ctx.action({
    id: 'cron_create',
    description:
      'Create a periodic cron job (5-field schedule, IANA timezone defaulting to UTC; defaults to isolated automated sessions with keepLast=10, or dedicated / explicit targetConversationId)',
    exposeToPrompt: false,
    inputSchema: CRON_CREATE_INPUT_SCHEMA,
    outputSchema: CRON_JOB_OUTPUT_SCHEMA,
    cli: { command: ['cron', 'create'] },
    handler: async (input: Record<string, unknown>) => {
      const job = normalizeCronInput(input as Parameters<typeof normalizeCronInput>[0])
      await assertTriggerProfileExists(deps.profiles, job.profileId, 'refusing to schedule against the wrong role')
      const created = await store.createJob(job)
      if (created.enabled) scheduleJob(created.id)
      return { job: structuredClone(created) }
    },
  })

  ctx.action({
    id: 'cron_update',
    description:
      'Update an existing cron job (description, schedule, timezone, text, enabled, catchUp, or delivery target); recomputes nextRunAt and reschedules timer while preserving runtime history',
    exposeToPrompt: false,
    inputSchema: CRON_UPDATE_INPUT_SCHEMA,
    outputSchema: CRON_JOB_OUTPUT_SCHEMA,
    cli: { command: ['cron', 'update'] },
    handler: async (rawInput: Record<string, unknown>) => {
      const input = parseCronUpdateInput(rawInput)
      if (store.findJob(input.id) === undefined) {
        throw new HelmxError('not_found', `cron job does not exist: ${input.id}`, 404, { id: input.id })
      }
      await assertTriggerProfileExists(deps.profiles, input.profileId, 'refusing to schedule against the wrong role')
      const updated = await store.updateJob(
        input,
        () => clearJobTimer(input.id),
        (prevJob) => {
          if (prevJob.enabled) scheduleJob(input.id)
        },
      )
      if (updated.enabled) scheduleJob(updated.id)
      return { job: structuredClone(updated) }
    },
  })

  ctx.action({
    id: 'cron_delete',
    description: 'Delete a cron job (in-flight deliveries end naturally; nothing revives)',
    exposeToPrompt: false,
    inputSchema: CRON_ID_INPUT_SCHEMA,
    outputSchema: CRON_DELETE_OUTPUT_SCHEMA,
    cli: { command: ['cron', 'delete'] },
    handler: async (input: { id: string }) => {
      await store.deleteJob(
        input.id,
        () => clearJobTimer(input.id),
        (deletedJob) => {
          if (deletedJob.enabled) scheduleJob(deletedJob.id)
        },
      )
      return { deleted: true }
    },
  })

  ctx.action({
    id: 'cron_trigger',
    description: 'Manually trigger a cron job once now (a real delivery; failures throw without affecting later scheduled runs)',
    exposeToPrompt: false,
    inputSchema: CRON_ID_INPUT_SCHEMA,
    outputSchema: CRON_TRIGGER_OUTPUT_SCHEMA,
    cli: { command: ['cron', 'trigger'] },
    handler: async (input: { id: string }) => {
      const job = store.findJob(input.id)
      if (!job) throw new HelmxError('not_found', `cron job does not exist: ${input.id}`, 404, { id: input.id })
      const res = await deps.dispatchTrigger(
        { ...buildCronEnvelope(job, clock.now()), id: `cron:${job.id}:manual:${randomUUID()}` },
        targetForJob(job),
      )
      return { triggered: true, conversationId: res.conversationId }
    },
  })
}
