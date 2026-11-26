/**
 * builtin:triggers -- the cron scheduling module (public facade).
 *
 * Implementation lives in `./cron/` split by responsibility:
 * - `contracts.ts`: doc/job/deps/runtime types, shared constants, validation & corruption errors;
 * - `parse.ts`: schedule validation, next-fire computation, creation-input normalization, doc parsing;
 * - `tick.ts`: per-tick decision (`decideTick`), envelope construction and the tick executor;
 * - `inputs.ts`: `cron_*` action JSON schemas, update-input validation, updated-job construction;
 * - `store.ts`: `crons` doc store with (id, rev) generation guards, rollback and write lock;
 * - `actions.ts`: the five `ctx.action` declarations;
 * - `scheduler.ts`: timer table, single-flight ticks, `ctx.service` lifecycle.
 *
 * Uses `durable-scheduler.ts` primitives (`SchedulerClock`, `TimerHandle`, `defaultSchedulerClock`,
 * `parseNextCronTime`, `advanceCronAfterFire`, `armChunkedTimer`) for cron parsing, 24.8-day
 * chunked timer arming, and injectable clocks while managing multi-job state in the public `crons`
 * doc with `(id, rev)` generation guards, claim-flush-before-dispatch, single catch-up, overlap
 * skipping for in-flight automated runs, and decision-failure retry backoff.
 */

export type { CronClock, CronDeps, CronDoc, CronJob, CronRuntime } from './cron/contracts.js'
export { advanceAfterFire, assertValidSchedule, nextFireTime, normalizeCronInput, parseCronDoc } from './cron/parse.js'
export { buildCronEnvelope, decideTick } from './cron/tick.js'
export { createCronScheduler, registerCron } from './cron/scheduler.js'
