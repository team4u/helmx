/**
 * builtin:triggers cron 模块契约测试：真实 schedule/timezone 解析、持久
 * next/lastRun、catchUp 语义、持久 claim 防重、single-flight、失败显式、
 * stop/delete race、delete+create 同 id 代次隔离。可控时钟驱动真实 timer 流。
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HelmxError,
  type ConversationSummary,
  type ExternalTriggerEnvelope,
  type PluginDefinition,
} from '@helmx/protocol'
import { PluginHost } from '@helmx/kernel'
import {
  advanceAfterFire,
  assertValidSchedule,
  buildCronEnvelope,
  createCronScheduler,
  decideTick,
  nextFireTime,
  normalizeCronInput,
  parseCronDoc,
  type CronClock,
  type CronDoc,
  type CronJob,
} from '../src/triggers/cron.js'
import type { TriggerDeliveryTarget, TriggerDispatchResult } from '../src/triggers/delivery.js'
import { hostBackendStub } from '../../kernel/test/helpers/host-backend-stub.js'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { MemoryDocStore, waitFor as baseWaitFor } from './helpers/plugin-test-env.js'

// ---------------------------------------------------------------------------
// 测试基建：内存 doc store + 可控时钟 + host fake
// ---------------------------------------------------------------------------

/** 可控时钟：手动推进 now；setTimeout 暂存，advance 时触发到期项（含 unref 语义）。 */
class FakeClock {
  private current: number
  private seq = 0
  private pending: Array<{ at: number; seq: number; fn: () => void; cleared: boolean }> = []

  readonly api: CronClock = {
    now: () => this.current,
    setTimeout: (fn, ms) => {
      const entry = { at: this.current + Math.max(0, ms), seq: this.seq++, fn, cleared: false }
      this.pending.push(entry)
      return {
        clear: () => {
          entry.cleared = true
        },
      }
    },
  }

  constructor(start: number) {
    this.current = start
  }

  /** 推进到 current+ms，依序触发沿途到期 timer（timer 回调内再排程亦可触发）。 */
  /** 推进到 current+ms，依序触发沿途到期 timer。每个 timer 触发后让出一轮
   * 微任务（对齐真实事件循环：tick 首个 await 会让出，后续排程得以生效）。 */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms
    for (;;) {
      const due = this.pending
        .filter((e) => !e.cleared && e.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0]
      if (!due) break
      this.current = due.at
      due.cleared = true
      due.fn()
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve()
      }
    }
    this.current = target
  }

  activeTimers(): number {
    return this.pending.filter((e) => !e.cleared).length
  }
}

interface Harness {
  host: PluginHost
  docs: MemoryDocStore
  clock: FakeClock
  /** 已投递信封与解析后的目标描述。 */
  dispatched: Array<{ envelope: ExternalTriggerEnvelope; target: TriggerDeliveryTarget }>
  /** dispatch 行为注入：抛错模拟投递失败。 */
  dispatchImpl: (envelope: ExternalTriggerEnvelope, target: TriggerDeliveryTarget) => Promise<TriggerDispatchResult>
  /** 可选在途运行查询注入（验证慢任务重叠跳过）。 */
  findActiveRunImpl: (jobId: string) => ConversationSummary | undefined
  /** doc.flush 调用计数（假持久断言用）。 */
  flushCalls: number
  /** flush 行为注入：抛错模拟持久化失败。 */
  flushImpl: () => Promise<void>
  events: Array<{ type: string; payload: unknown }>
  runtime: ReturnType<typeof createCronScheduler>
  registration: Promise<void>
  dataDir: string
}

function makeHarness(
  startMs: number,
  docSeed?: CronDoc,
  options?: { profileIds?: Iterable<string>; redact?: (text: string) => string },
): Harness {
  const docs = new MemoryDocStore()
  if (docSeed !== undefined) docs.set('builtin:triggers:crons', docSeed)
  const clock = new FakeClock(startMs)
  const dispatched: Array<{ envelope: ExternalTriggerEnvelope; target: TriggerDeliveryTarget }> = []
  const events: Array<{ type: string; payload: unknown }> = []
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-cron-test-'))
  const profileSet = options?.profileIds === undefined ? undefined : new Set(options.profileIds)
  const h: Harness = {
    host: undefined as never,
    docs,
    clock,
    dispatched,
    dispatchImpl: async (envelope, target) => {
      dispatched.push({ envelope, target })
      return { conversationId: target.kind === 'conversation' ? target.conversationId : 42 }
    },
    findActiveRunImpl: () => undefined,
    flushCalls: 0,
    flushImpl: async () => {},
    events,
    runtime: undefined as never,
    registration: undefined as never,
    dataDir,
  }
  // doc.flush 注入：生产走 doc 句柄 flush（真实 SQLite 排队冲刷），此处将
  // 内存 store 的 flush 指向可控实现以模拟持久化失败。
  const innerFlush = (): Promise<void> => {
    h.flushCalls += 1
    return h.flushImpl()
  }
  docs.flush = innerFlush
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(),
    dataDir,
    docs,
    host: {
      ...hostBackendStub(),
      dispatchTrigger: async () => {},
      submitInput: async () => {},
      createConversation: async (init) => ({ id: 42, title: init.title ?? 'x' }) as never,
      listConversations: () => [],
      getConversation: () => ({ id: 1 }) as never,
      updateConversation: async (id) => ({ id }) as never,
      manageConversation: () => () => {},
      markConversationOwnership: () => {},
      createAsk: async () => ({}) as never,
      cancelAsk: async () => {},
      onEvent: () => () => {},
    abortConversation: async () => {},
    getConversationOwnership(): 'helmx' | 'human' {
      return 'human'
    },
    isClosing: () => false,
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    execEnv: async () => { throw new HelmxError('unsupported', '本 fixture 不执行节点命令', 501) },
      emitEvent(type: string, payload: unknown) {
        events.push({ type, payload })
      },
      ...(options?.redact !== undefined ? { redact: options.redact } : {}),
    },
  })
  h.host = host
  h.registration = host.register({
      id: 'builtin:triggers',
      definePlugin: (ctx) => {
        h.runtime = createCronScheduler(
          ctx,
          {
            dispatchTrigger: async (envelope, target) => h.dispatchImpl(envelope, target),
            findActiveRun: (jobId) => h.findActiveRunImpl(jobId),
            ...(profileSet !== undefined
              ? {
                  profiles: {
                    get: async (id: string) => (profileSet.has(id) ? { id } : undefined),
                  },
                }
              : {}),
          },
          clock.api,
        )
      },
    } as PluginDefinition)
  return h
}

/** 等待真实注册与 service.start 完成，注册失败直接交给测试。 */
async function ready(h: Harness): Promise<void> {
  await h.registration
}

const MIN = 60_000
const T0 = Date.parse('2026-01-01T00:00:00Z')
const T0_5 = T0 + 5 * MIN
const T10 = T0 + 10 * MIN
const T15 = T0 + 15 * MIN

function seedJob(over: Partial<CronJob> = {}): CronJob {
  const base: CronJob = {
    id: 'j1',
    rev: 'rev-a',
    schedule: '*/5 * * * *',
    timezone: 'UTC',
    text: 'hello',
    enabled: true,
    catchUp: false,
    ...(over.targetConversationId === undefined ? { mode: over.mode ?? 'isolated' } : {}),
    ...over,
  }
  return base
}

let harnesses: Harness[] = []

beforeEach(() => {
  harnesses = []
})

afterEach(async () => {
  for (const h of harnesses) {
    try {
      await h.host.dispose()
    } catch {
      // dispose 聚合错误不阻断清理
    }
    rmSync(h.dataDir, { recursive: true, force: true })
  }
}, { timeout: 60_000 })

function track<T extends Harness>(h: T): T {
  harnesses.push(h)
  return h
}

async function listJobs(h: Harness): Promise<Array<Record<string, unknown>>> {
  const out = (await h.host.invokeAction('builtin:triggers', 'cron_list', {})) as {
    jobs: Array<Record<string, unknown>>
  }
  return out.jobs
}

/** 取唯一 job（断言非空，noUncheckedIndexedAccess 收敛）。 */
async function soleJob(h: Harness): Promise<Record<string, unknown>> {
  const [job] = await listJobs(h)
  assert.ok(job !== undefined, '应有且仅有一个 job')
  return job
}

/** 轮询等待条件成立（上限 5s）。 */
const waitFor = (cond: () => boolean, timeoutMs = 5_000): Promise<void> =>
  baseWaitFor(cond, { timeoutMs, intervalMs: 5, message: 'waitFor 超时' })

// ---------------------------------------------------------------------------
// 纯函数：表达式与时区（真实 cron-parser）
// ---------------------------------------------------------------------------

test('assertValidSchedule：合法五字段通过；六字段/越界/非法时区显式拒绝', { timeout: 60_000 }, () => {
  assertValidSchedule('*/5 * * * *', 'UTC')
  assertValidSchedule('0 3 * * 1-5', 'Asia/Shanghai')
  assert.throws(() => assertValidSchedule('* * * * * *', 'UTC'), /five fields/)
  assert.throws(() => assertValidSchedule('61 * * * *', 'UTC'), /invalid cron schedule/)
  assert.throws(() => assertValidSchedule('* * * * *', 'Not/AZone'), /invalid cron schedule|timezone/)
  assert.throws(() => assertValidSchedule('', 'UTC'), /must not be empty/)
})

test('nextFireTime：严格晚于 after；时区真实生效；DST 跳变正确', { timeout: 60_000 }, () => {
  assert.equal(nextFireTime('*/5 * * * *', 'UTC', T0), T0_5)
  assert.equal(nextFireTime('*/5 * * * *', 'UTC', T0_5), T10)
  assert.equal(nextFireTime('*/5 * * * *', 'UTC', T0_5 + 1), T10)
  // 时区真实生效：同一表达式在上海与 UTC 给出不同绝对时点（本地 = UTC+8）
  const base = Date.parse('2026-06-01T00:00:00Z')
  assert.equal(nextFireTime('0 8 * * *', 'UTC', base), Date.parse('2026-06-01T08:00:00Z'))
  // base 恰为上海 06-01 08:00，严格晚于 after → 上海下次是 06-02 08:00 本地
  assert.equal(nextFireTime('0 8 * * *', 'Asia/Shanghai', base), Date.parse('2026-06-02T00:00:00Z'))
  // 柏林 2026-03-29 春进：当日 02:30 不存在，相邻两时点跨两天差 47h（48h-1h）
  const before = nextFireTime('30 2 * * *', 'Europe/Berlin', Date.parse('2026-03-28T00:00:00Z'))
  const after = nextFireTime('30 2 * * *', 'Europe/Berlin', Date.parse('2026-03-29T03:30:00Z'))
  assert.ok(before !== undefined && after !== undefined)
  assert.equal(after - before, 47 * 60 * MIN)
})

test('nextFireTime：不可达表达式（2 月 30 日）显式拒绝', { timeout: 60_000 }, () => {
  assert.throws(() => nextFireTime('0 0 30 2 *', 'UTC', T0), HelmxError)
})

test('advanceAfterFire：错过多时段时跳到 now 之后（catchUp 只补跑一次）', { timeout: 60_000 }, () => {
  assert.equal(advanceAfterFire('*/5 * * * *', 'UTC', T0_5, T0_5), T10)
  assert.equal(advanceAfterFire('*/5 * * * *', 'UTC', T0_5, T0 + 12 * MIN), T15)
})

// ---------------------------------------------------------------------------
// 纯函数：输入归一 / 文档校验 / 决策
// ---------------------------------------------------------------------------

test('normalizeCronInput：默认值/互斥/非法输入', { timeout: 60_000 }, () => {
  const job = normalizeCronInput({ id: 'a_1', schedule: '*/5 * * * *', text: 'hi' })
  assert.equal(job.timezone, 'UTC')
  assert.equal(job.enabled, true)
  assert.equal(job.catchUp, false)
  assert.equal(job.mode, 'isolated')
  assert.equal(job.keepLast, 10)
  assert.ok(job.rev.length > 0)

  assert.throws(
    () =>
      normalizeCronInput({
        id: 'a',
        schedule: '* * * * *',
        text: 'x',
        targetConversationId: 1,
        profileId: 'p',
      }),
    /mutually exclusive/,
  )
  assert.throws(
    () =>
      normalizeCronInput({
        id: 'a',
        schedule: '* * * * *',
        text: 'x',
        mode: 'dedicated',
        keepLast: 5,
      }),
    /keepLast/,
  )
  assert.throws(() => normalizeCronInput({ id: 'bad.id', schedule: '* * * * *', text: 'x' }), /invalid cron id/)
  assert.throws(() => normalizeCronInput({ id: 'a', schedule: '* * * * *', text: '' }), /text/)
  assert.throws(() => normalizeCronInput({ id: 'a', schedule: 'nope', text: 'x' }), /five fields|invalid cron/)
})

test('parseCronDoc：好文档通过；坏数据显式拒绝不静默重置', { timeout: 60_000 }, () => {
  assert.equal(parseCronDoc({ version: 1, jobs: [seedJob()] }).jobs.length, 1)

  assert.throws(() => parseCronDoc({ version: 2, jobs: [] }), /version/)
  assert.throws(() => parseCronDoc({ version: 1, jobs: {} }), /jobs/)
  assert.throws(() => parseCronDoc({ version: 1, jobs: [{ ...seedJob(), rev: undefined }] }), /rev/)
  assert.throws(
    () => parseCronDoc({ version: 1, jobs: [seedJob({ nextRunAt: 'soon' as unknown as number })] }),
    /nextRunAt/,
  )
  assert.throws(() => parseCronDoc({ version: 1, jobs: [seedJob(), seedJob()] }), /duplicate/)
})

test('decideTick：未启用/未来 noop；准点与单时段错过均 fire；多时段错过按 catchUp 分流', { timeout: 60_000 }, async () => {
  assert.deepEqual(decideTick(seedJob({ enabled: false, nextRunAt: T0 }), T0_5), { action: 'noop' })
  assert.deepEqual(decideTick(seedJob({ nextRunAt: T10 }), T0_5), { action: 'noop' })
  // 准点触发：fire（catchUp 任意值）
  assert.deepEqual(decideTick(seedJob({ nextRunAt: T0_5 }), T0_5), { action: 'fire', at: T0_5 })
  assert.deepEqual(decideTick(seedJob({ catchUp: true, nextRunAt: T0_5 }), T0_5), { action: 'fire', at: T0_5 })
  // 迟到但仍在同一时段窗口内（T10 在未来）：fire 错过的 T0_5
  assert.deepEqual(decideTick(seedJob({ nextRunAt: T0_5 }), T0 + 7 * MIN), { action: 'fire', at: T0_5 })
  // 多时段错过（T10 也已过）：catchUp=false 跳未来 / true 补跑最近一个
  assert.deepEqual(decideTick(seedJob({ nextRunAt: T0_5 }), T0 + 12 * MIN), {
    action: 'skip-to-future',
    from: T0_5,
    to: T15,
  })
  assert.deepEqual(decideTick(seedJob({ catchUp: true, nextRunAt: T0_5 }), T0 + 12 * MIN), {
    action: 'fire',
    at: T0_5,
  })
})

test('buildCronEnvelope：source/id 稳定、目标字段透传', { timeout: 60_000 }, () => {
  const env = buildCronEnvelope(seedJob({ id: 'x', targetConversationId: 7 }), T0_5)
  assert.equal(env.source, 'cron:x')
  assert.equal(env.id, `cron:x:${T0_5}`)
  assert.equal(env.createdAt, T0_5)
  assert.equal(env.targetConversationId, 7)
})

// ---------------------------------------------------------------------------
// 动作契约：create/list/delete/trigger
// ---------------------------------------------------------------------------

test('cron_create/list/delete：完整动作契约与持久化（含 flush）', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  const created = (await h.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'daily',
    schedule: '*/5 * * * *',
    text: 'standup',
    timezone: 'UTC',
  })) as { job: Record<string, unknown> }
  assert.equal(created.job.id, 'daily')
  assert.equal(created.job.nextRunAt, T0_5)
  assert.ok(typeof created.job.rev === 'string')
  assert.ok(h.flushCalls >= 1, 'create 必须 flush 落盘')
  assert.equal((await listJobs(h)).length, 1)

  await assert.rejects(
    h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'daily', schedule: '* * * * *', text: 'x' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'cron_duplicate_id',
  )

  const del = (await h.host.invokeAction('builtin:triggers', 'cron_delete', { id: 'daily' })) as {
    deleted: boolean
  }
  assert.equal(del.deleted, true)
  await assert.rejects(
    h.host.invokeAction('builtin:triggers', 'cron_delete', { id: 'daily' }),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError && err.code === 'not_found')
      return true
    },
  )
  assert.equal((await listJobs(h)).length, 0)
  assert.equal(h.clock.activeTimers(), 0, '删除后无残留 timer')
})

test('cron_create：非法输入在动作边界拒绝；无未来时点拒绝创建', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  await assert.rejects(h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'x' }), HelmxError)
  await assert.rejects(
    h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'x', schedule: 'bad', text: 't' }),
    HelmxError,
  )
  await assert.rejects(
    h.host.invokeAction('builtin:triggers', 'cron_create', {
      id: 'x',
      schedule: '* * * * *',
      text: 't',
      targetConversationId: 1,
      profileId: 'p',
    }),
    (err: unknown) => err instanceof HelmxError && /互斥|mutually exclusive|validation/.test(`${err.code}${err.message}`),
  )
  await assert.rejects(
    h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'x', schedule: '0 0 30 2 *', text: 't' }),
    HelmxError,
  )
})

test('cron_trigger：真实投递（automated mode/profileId 透传并返回 conversationId）；失败抛错不假成功', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  await h.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'rep',
    schedule: '0 * * * *',
    text: 'report',
    mode: 'isolated',
    profileId: 'analyst',
    keepLast: 5,
  })
  const out = (await h.host.invokeAction('builtin:triggers', 'cron_trigger', { id: 'rep' })) as {
    triggered: boolean
    conversationId: number
  }
  assert.equal(out.triggered, true)
  assert.equal(out.conversationId, 42)
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.dispatched[0]!.envelope.source, 'cron:rep')
  assert.equal(h.dispatched[0]!.envelope.whenBusy, 'followUp')
  assert.equal(h.dispatched[0]!.target.kind, 'isolated')
  if (h.dispatched[0]!.target.kind === 'isolated') {
    assert.equal(h.dispatched[0]!.target.profileId, 'analyst')
    assert.equal(h.dispatched[0]!.target.keepLast, 5)
  }

  await assert.rejects(
    h.host.invokeAction('builtin:triggers', 'cron_trigger', { id: 'nope' }),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError && err.code === 'not_found')
      return true
    },
  )

  h.dispatchImpl = async () => {
    throw new HelmxError('runtime_closed', '内核正在关闭', 503)
  }
  await assert.rejects(
    h.host.invokeAction('builtin:triggers', 'cron_trigger', { id: 'rep' }),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError && err.code === 'runtime_closed')
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// 调度核心（FakeClock 驱动真实 timer 流）
// ---------------------------------------------------------------------------

test('到点投递一次：claim 推进 lastRunAt/nextRunAt 并 flush；未到点不投递', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  await h.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'f1',
    schedule: '*/5 * * * *',
    text: 'go',
  })
  assert.equal(h.clock.activeTimers(), 1, 'create 后排一个 timer')
  const flushBefore = h.flushCalls

  await h.clock.advance(4 * MIN) // 未到点
  assert.equal(h.dispatched.length, 0)
  assert.equal(h.flushCalls, flushBefore)

  await h.clock.advance(MIN) // 到 T0_5
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.dispatched[0]!.envelope.id, `cron:f1:${T0_5}`)
  const job = await soleJob(h)
  assert.equal(job.lastRunAt, T0_5)
  assert.equal(job.nextRunAt, T10)
  assert.equal(job.lastError, undefined)
  assert.ok(h.flushCalls >= flushBefore + 1, 'claim 必须 flush')
  assert.equal(h.clock.activeTimers(), 1, '投递后续排下一时点')

  await h.clock.advance(5 * MIN) // T10 第二个计划点
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 2)
  assert.equal(h.dispatched[1]!.envelope.id, `cron:f1:${T10}`)
})

test('catchUp=true：重启（service start）后对错过时段补跑一次，之后跳至未来', { timeout: 60_000 }, async () => {
  const h = track(
    makeHarness(
      T0 + 12 * MIN,
      { version: 1, jobs: [seedJob({ id: 'c1', catchUp: true, nextRunAt: T0_5 })] },
    ),
  )
  await ready(h) // service start 排 delay=0 timer
  await h.clock.advance(0) // 触发立即到期的 timer（真实环境由事件循环自动触发）
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.dispatched[0]!.envelope.id, `cron:c1:${T0_5}`)
  const job = await soleJob(h)
  assert.equal(job.lastRunAt, T0_5)
  assert.equal(job.nextRunAt, T15, '补跑一次后跳到 now 之后首个时点（不逐段重放 T10）')

  await h.clock.advance(3 * MIN) // 到 T15
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 2)
  assert.equal(h.dispatched[1]!.envelope.id, `cron:c1:${T15}`)
})

test('catchUp=false：重启后跳至未来时点（不投递错过时段），同样 flush 持久化', { timeout: 60_000 }, async () => {
  const h = track(
    makeHarness(
      T0 + 12 * MIN,
      { version: 1, jobs: [seedJob({ id: 's1', catchUp: false, nextRunAt: T0_5 })] },
    ),
  )
  await ready(h)
  // catchUp=false：service start 即刻决策（nextRunAt 已过期）→ timer 排到 T15，
  // 但 start 的调度扫描是 timer 触发型（到点才 tick）；这里手动 tickNow 驱动跳转
  await h.runtime.tickNow()
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 0)
  const flushBefore = h.flushCalls
  assert.ok(flushBefore >= 1, '跳至未来也必须 flush')
  const job = await soleJob(h)
  assert.equal(job.nextRunAt, T15)
  assert.equal(job.lastRunAt, undefined, '跳过不伪造运行记录')

  await h.clock.advance(3 * MIN) // 到 T15 正常投递
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.dispatched[0]!.envelope.id, `cron:s1:${T15}`)
})

test('dispatch 失败：写 lastError + notification，本计划点不重试，下时点恢复', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  let attempts = 0
  let fail = true
  h.dispatchImpl = async (envelope, target) => {
    attempts += 1
    if (fail) throw new Error('downstream broken')
    h.dispatched.push({ envelope, target })
    return { conversationId: 42 }
  }
  await h.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'e1',
    schedule: '*/5 * * * *',
    text: 'go',
  })
  await h.clock.advance(5 * MIN)
  await h.runtime.settle()
  assert.equal(attempts, 1)
  assert.equal(h.dispatched.length, 0)
  const job = await soleJob(h)
  assert.ok(typeof job.lastError === 'string' && (job.lastError as string).includes('downstream broken'))
  assert.equal(job.lastRunAt, T0_5, 'claim 已发生（最多一次尝试语义）')
  assert.ok(h.events.some((e) => e.type === 'notification'), '失败必须发 notification 事件')

  fail = false
  await h.clock.advance(5 * MIN) // T10
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 1)
  assert.equal(attempts, 2)
  const job2 = await soleJob(h)
  assert.equal(job2.lastError, undefined, '成功后清 lastError')
})

test('claim 持久化失败（flush 抛错）：不投递，显式诊断', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  await h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'p1', schedule: '*/5 * * * *', text: 'x' })
  h.flushImpl = async () => {
    throw new HelmxError('store_flush_failed', 'SQLite drain 失败', 500)
  }
  await h.clock.advance(5 * MIN)
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 0, 'claim 未落盘绝不投递')
  assert.ok(h.events.some((e) => e.type === 'notification'))
})

test('skip-to-future 落盘失败：异常后仍重排（不停摆），下个时点照常投递', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  await h.host.invokeAction('builtin:triggers', 'cron_create', { id: 's2', schedule: '*/5 * * * *', text: 'go' })
  let flushFailures = 0
  h.flushImpl = async () => {
    if (flushFailures++ === 0) throw new HelmxError('store_flush_failed', 'SQLite drain 失败', 500)
  }
  // 篡改 doc：nextRunAt 回拨两个时段（tick 时判 missed-multiple → skip-to-future；
  // 不能用 docSeed 预置过期时点——service start 会先行归一化，轮不到 tick 决策）
  const seeded = h.docs.store.get('builtin:triggers:crons') as CronDoc
  seeded.jobs[0] = { ...seeded.jobs[0]!, nextRunAt: T0 - 5 * MIN }
  h.docs.store.set('builtin:triggers:crons', seeded)
  await h.clock.advance(5 * MIN) // T0_5 timer 触发：skip 写盘失败，异常上抛由 timer 回调兜底通知
  await h.runtime.settle()
  assert.ok(h.events.some((e) => e.type === 'notification'), '落盘失败必须显式通知')
  assert.equal(h.dispatched.length, 0)
  assert.equal(h.clock.activeTimers(), 1, '落盘失败后必须重排（job 不得停摆）')
  // flush 抛错时回滚内存 doc.set(previous)，防止未落盘变更被并发写入捎带持久化；退避到期后自动重跑跳过
  assert.equal((await soleJob(h)).nextRunAt, T0 - 5 * MIN, '落盘失败时内存镜像回滚至 previous')

  await h.clock.advance(5 * MIN) // T0+6m 退避重试成功跳至 T10，随后 T10 正常投递
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.dispatched[0]!.envelope.id, `cron:s2:${T10}`)
})

test('投递失败且 lastError 落盘失败：仍通知原始失败并重排，下个时点照常', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  let attempts = 0
  h.dispatchImpl = async () => {
    attempts += 1
    throw new Error('downstream broken')
  }
  await h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'e2', schedule: '*/5 * * * *', text: 'go' })
  let flushes = 0
  h.flushImpl = async () => {
    flushes += 1
    // 第 1 次 flush 是 claim（成功）；第 2 次是 lastError 写回（失败）
    if (flushes === 2) throw new HelmxError('store_flush_failed', 'SQLite drain 失败', 500)
  }
  const stderr: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    stderr.push(args.map((a) => String(a)).join(' '))
  }
  try {
    await h.clock.advance(5 * MIN)
    await h.runtime.settle()
  } finally {
    console.error = originalError
  }
  assert.equal(attempts, 1)
  assert.equal(h.dispatched.length, 0)
  assert.ok(h.events.some((e) => e.type === 'notification'), '投递失败必须通知（不被落盘失败掩盖）')
  assert.equal(h.clock.activeTimers(), 1, '双重失败后仍重排')
  const job = await soleJob(h)
  // 第 2 次 flush 失败回滚未持久化的 lastError 写入，但第 1 次已落盘的 claim（nextRunAt=T10）完整保留
  assert.equal(job.lastError, undefined, '未落盘的 lastError 回滚以保持与持久层一致')
  assert.ok(
    stderr.some((line) => line.includes('lastError flush also failed')),
    '持久化失败必须显式记录',
  )
  assert.equal(job.nextRunAt, T10, 'claim 已推进（下时点照常）')

  await h.clock.advance(5 * MIN) // T10：flush 恢复，lastError 正常落盘
  await h.runtime.settle()
  assert.equal(attempts, 2, '下个时点照常尝试')
})

test('调度决策失败（doc 中途损坏）：显式通知不崩溃；修复后经 tickNow 恢复投递', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  await h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'c2', schedule: '*/5 * * * *', text: 'go' })
  const snapshot = structuredClone(h.docs.store.get('builtin:triggers:crons'))
  h.docs.store.set('builtin:triggers:crons', {
    version: 1,
    jobs: [{ ...seedJob({ id: 'c2' }), enabled: 'corrupt' as unknown as boolean }],
  })
  await h.clock.advance(5 * MIN) // 到点 tick：读 doc 即抛（调度决策失败）
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 0)
  assert.ok(
    h.events.filter((e) => e.type === 'notification').length >= 1,
    '决策失败必须显式通知（含重排时读取失败的双告警）',
  )
  assert.equal(h.clock.activeTimers(), 0, 'doc 损坏为终态：不排 timer（修复需人工/重启）')

  h.docs.store.set('builtin:triggers:crons', snapshot)
  await h.runtime.tickNow() // 修复后恢复：准点 fire（T0_5 即当前时刻）
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.dispatched[0]!.envelope.id, `cron:c2:${T0_5}`)
})

test('调度决策失败（表达式被写坏）：退避重排不热循环，修复后自动恢复', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  await h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'c3', schedule: '*/5 * * * *', text: 'go' })
  const snapshot = structuredClone(h.docs.store.get('builtin:triggers:crons'))
  // 形状合法但表达式非法（parseCronDoc 只验字符串，cron-parser 求值才抛）
  h.docs.store.set('builtin:triggers:crons', {
    version: 1,
    jobs: [{ ...seedJob({ id: 'c3' }), schedule: '61 * * * *', nextRunAt: T0_5 }],
  })
  await h.clock.advance(5 * MIN) // 到点 tick：decideTick 求值抛错
  await h.runtime.settle()
  assert.ok(h.events.some((e) => e.type === 'notification'), '决策失败必须显式通知')
  assert.equal(h.dispatched.length, 0)
  assert.equal(h.clock.activeTimers(), 1, '决策失败按退避下限重排（不热循环、不停摆）')

  h.docs.store.set('builtin:triggers:crons', snapshot)
  await h.clock.advance(60 * 1000) // 退避到期：修复后的 doc 正常补跑 T0_5
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.dispatched[0]!.envelope.id, `cron:c3:${T0_5}`)
})

test('single-flight：并发 tick 同 job 只投递一次', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  let release: (() => void) | undefined
  h.dispatchImpl = (envelope, target) =>
    new Promise<TriggerDispatchResult>((resolve) => {
      h.dispatched.push({ envelope, target })
      release = () => resolve({ conversationId: 42 })
    })
  await h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'sf', schedule: '*/5 * * * *', text: 'x' })
  await h.clock.advance(5 * MIN) // timer 触发进入 dispatch 挂起
  await waitFor(() => h.dispatched.length === 1)
  const manual = h.runtime.tickNow() // 手动并发 tick
  release?.()
  await manual
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 1)
})

test('delete 并发执行不复活 doc：在途 tick 遇删除静默终止', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  let release: (() => void) | undefined
  h.dispatchImpl = (envelope, target) =>
    new Promise<TriggerDispatchResult>((resolve) => {
      h.dispatched.push({ envelope, target })
      release = () => resolve({ conversationId: 42 })
    })
  await h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'd1', schedule: '*/5 * * * *', text: 'x' })
  await h.clock.advance(5 * MIN)
  await waitFor(() => h.dispatched.length === 1)
  // dispatch 在途时删除：写回路径不得复活
  await h.host.invokeAction('builtin:triggers', 'cron_delete', { id: 'd1' })
  release?.()
  await h.runtime.settle()
  assert.equal((await listJobs(h)).length, 0, '删除后 doc 不得被在途写回复活')
})

test('delete 后 create 同 id：旧 tick 的 lastError 不污染新 job（rev 代次）', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  let fail = true
  let release: (() => void) | undefined
  h.dispatchImpl = (envelope, target) =>
    new Promise<TriggerDispatchResult>((resolve, reject) => {
      h.dispatched.push({ envelope, target })
      if (fail) release = () => reject(new Error('old job dispatch failed'))
      else resolve({ conversationId: 42 })
    })
  await h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'same', schedule: '*/5 * * * *', text: 'old' })
  await h.clock.advance(5 * MIN)
  await waitFor(() => h.dispatched.length === 1)
  // dispatch 挂起期间：删除旧 job 并重建同 id
  await h.host.invokeAction('builtin:triggers', 'cron_delete', { id: 'same' })
  fail = false
  await h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'same', schedule: '0 * * * *', text: 'new' })
  release?.()
  await h.runtime.settle()
  const job = await soleJob(h)
  assert.equal(job.text, 'new')
  assert.equal(job.lastError, undefined, '旧 tick 失败不得写到新 job')
  assert.equal(job.lastRunAt, undefined, '新 job 不继承旧 claim 记录')
})

test('stop（disable）取消 timer 禁止后续投递；重新启用恢复调度', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  await h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'r1', schedule: '*/5 * * * *', text: 'x' })
  assert.equal(h.clock.activeTimers(), 1)
  // 启用的 cron 任务为持久占用（inUse）：知情后 force 停用。
  await h.host.disable('builtin:triggers', { force: true })
  assert.equal(h.clock.activeTimers(), 0, 'stop 后 timer 全部取消')
  await h.clock.advance(30 * MIN) // 停用期间推进：无投递
  assert.equal(h.dispatched.length, 0)
  await assert.rejects(h.host.invokeAction('builtin:triggers', 'cron_list', {}), HelmxError)

  await h.host.enable('builtin:triggers')
  // 重新启用：definePlugin 重跑、service start 重排（doc 持久仍在）
  // 注意：新周期的 runtime 句柄是新的；用动作验证调度恢复
  const jobs = await listJobs(h)
  assert.equal(jobs.length, 1)
  const [job] = jobs
  assert.ok(job !== undefined)
  assert.equal(job.nextRunAt, T0 + 35 * MIN, '重新启用时跳过已错过计划，持久化下一未来时点')
  // now=T0+30min，nextRunAt=T0_5 已是过去：catchUp=false 跳到未来
  // （FakeClock now=T0+30min；新周期用真实时钟——故此处只验证文档未被破坏与动作可用）
})

test('停用时有在途 tick：liveTasks 报在途，禁用被宿主 409 拒绝', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  let release: (() => void) | undefined
  h.dispatchImpl = (envelope, target) =>
    new Promise<TriggerDispatchResult>((resolve) => {
      h.dispatched.push({ envelope, target })
      release = () => resolve({ conversationId: 42 })
    })
  await h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'lt', schedule: '*/5 * * * *', text: 'x' })
  await h.clock.advance(5 * MIN)
  await waitFor(() => h.dispatched.length === 1)
  // 在途 dispatch 未完成时停用：宿主 liveTasks 闸门拒绝
  await assert.rejects(
    h.host.disable('builtin:triggers'),
    (err: unknown) => err instanceof HelmxError && err.code === 'plugin_has_live_tasks',
  )
  release?.()
  await h.runtime.settle()
  // 在途结束后停用成功（cron 任务持久占用 → force）
  await h.host.disable('builtin:triggers', { force: true })
  assert.equal(h.clock.activeTimers(), 0)
})

test('catchUp=false：重启只错过一个计划点时也跳过，不冒充正常 timer 延迟', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0 + 6 * MIN, { version: 1, jobs: [seedJob({ catchUp: false, nextRunAt: T0_5 })] }))
  await ready(h)
  await h.clock.advance(0)
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 0)
  assert.equal((await soleJob(h)).nextRunAt, T10)
  assert.ok(h.flushCalls > 0)
})

test('claim 冲刷期间删除任务，旧计划点不再投递', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  await h.host.invokeAction('builtin:triggers', 'cron_create', { id: 'claim-delete', schedule: '*/5 * * * *', text: '旧任务' })
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  h.flushImpl = () => { entered(); return gate }
  await h.clock.advance(5 * MIN)
  await started
  h.flushImpl = async () => {}
  let deleteFinished = false
  const deleting = h.host.invokeAction('builtin:triggers', 'cron_delete', { id: 'claim-delete' }).then(() => {
    deleteFinished = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(deleteFinished, false, 'cron_delete 必须等待 active write lock 释放')
  release()
  await deleting
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 0)
  assert.deepEqual(await listJobs(h), [])
})

test('crons 文档损坏：注册失败并回滚，不伪装启用成功', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0, { version: 9, jobs: [] } as unknown as CronDoc))
  await assert.rejects(h.registration, { code: 'cron_doc_corrupt' })
  assert.ok(h.events.some((e) => e.type === 'notification'), '坏文档必须显式通知')
  assert.equal(h.host.list().some((plugin) => plugin.enabled), false)
  assert.equal(h.clock.activeTimers(), 0, '坏文档不排任何 timer')
})

test('大间隔不溢出：超 2^31-1ms 的延迟先以安全窗口排程（advance 分段触发）', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  // 每月 1 次：下一次远超 24.8 天上限
  await h.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'monthly',
    schedule: '0 0 1 * *',
    text: 'monthly',
  })
  const job = await soleJob(h)
  const next = job.nextRunAt as number
  const delay = next - T0
  assert.ok(delay > 2_147_483_647, '测试前置：延迟必须超过 setTimeout 上限')
  // FakeClock 直接 advance 大跨度：真实实现以安全窗口唤醒后续排（未到点 noop
  // 重排剩余延迟），这里验证多次唤醒后最终恰好投递一次、时点精确
  await h.clock.advance(delay)
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.dispatched[0]!.envelope.createdAt, next)
})

test('慢任务防重入：前一次自动化运行仍在 working/blocked 时跳过本次计划并推进 nextRunAt，结束后恢复', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  await h.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'slow',
    schedule: '*/5 * * * *',
    text: 'inspect',
  })
  let activeRun: ConversationSummary | undefined = { id: 88, status: 'working' } as ConversationSummary
  h.findActiveRunImpl = () => activeRun

  await h.clock.advance(5 * MIN) // T0_5: active run exists -> skip
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 0, '前一次运行仍在途时不重复投递')
  assert.equal(h.events.some((e) => e.type === 'notification'), false, '正常重叠跳过不发错误通知')
  const skippedJob = await soleJob(h)
  assert.equal(skippedJob.nextRunAt, T10, '跳过后仍推进 nextRunAt 不死循环')
  assert.equal(skippedJob.lastSkippedAt, T0_5)
  assert.match(String(skippedJob.lastSkipReason), /#88.*working/)

  // 上一轮完成后：下一计划点正常投递并清除跳过记录
  activeRun = undefined
  await h.clock.advance(5 * MIN) // T10
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.dispatched[0]!.envelope.id, `cron:slow:${T10}`)
  const recoveredJob = await soleJob(h)
  assert.equal(recoveredJob.lastSkippedAt, undefined)
  assert.equal(recoveredJob.lastSkipReason, undefined)
})

test('落盘失败防 0ms 热循环与并发写串行回滚：claim / overlap-skip 落盘失败按 60s 退避且绝不被并发任务 flush 捎带提交', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  await h.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'job-a',
    schedule: '*/5 * * * *',
    text: 'a',
    catchUp: true,
  })
  await h.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'job-b',
    schedule: '*/5 * * * *',
    text: 'b',
    catchUp: true,
  })

  // 1) job-a 的 claim flush 失败，紧接着 job-b 的 claim flush 成功：
  // 串行写队列 + previous 回滚保证 job-a 未投递的 claim 绝不被 job-b 的 flush 捎带落盘！
  let tickFlushes = 0
  h.flushImpl = async () => {
    tickFlushes += 1
    if (tickFlushes === 1) throw new HelmxError('store_flush_failed', 'job-a claim failed', 500)
  }
  await h.clock.advance(5 * MIN) // T0_5: job-a fails flush, job-b succeeds flush
  await h.runtime.settle()

  assert.equal(tickFlushes, 2, '若存在 0ms 热循环，advance(5 * MIN) 内会在 T0_5 无限重试；退避下仅触发 a、b 各一次')
  assert.deepEqual(
    h.dispatched.map((d) => d.envelope.id),
    [`cron:job-b:${T0_5}`],
    '仅 job-b 成功投递',
  )
  const jobsAfterRace = await listJobs(h)
  const jobA = jobsAfterRace.find((j) => j.id === 'job-a')!
  const jobB = jobsAfterRace.find((j) => j.id === 'job-b')!
  assert.equal(jobA.lastRunAt, undefined, 'job-a 失败的 claim 已回滚，绝不被 job-b 捎带提交')
  assert.equal(jobA.nextRunAt, T0_5, 'job-a 保持原计划时点供退避后补跑')
  assert.equal(jobB.lastRunAt, T0_5)
  assert.equal(jobB.nextRunAt, T10)

  // 推进 30s（未达 60s 退避下限）：不触发重试
  await h.clock.advance(30_000)
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 1)

  // 再推进 30s（到达 T0_5 + 60s 退避点）：job-a 自动补跑成功！
  await h.clock.advance(30_000)
  await h.runtime.settle()
  assert.deepEqual(
    h.dispatched.map((d) => d.envelope.id),
    [`cron:job-b:${T0_5}`, `cron:job-a:${T0_5}`],
  )

  // 2) overlap-skip 落盘失败同样按 60s 退避，绝不在当前毫秒 0ms 死循环
  h.findActiveRunImpl = (id) => (id === 'job-a' ? ({ id: 99, status: 'working' } as ConversationSummary) : undefined)
  let overlapFlushes = 0
  h.flushImpl = async () => {
    overlapFlushes += 1
    if (overlapFlushes === 1) throw new HelmxError('store_flush_failed', 'overlap skip flush failed', 500)
  }
  await h.clock.advance(4 * MIN) // 到 T10
  await h.runtime.settle()
  assert.equal(overlapFlushes, 2, 'overlap-skip flush 失败必须退避，不在 T10 产生 0ms 死循环')
})

test('findActiveRun 抛错防 0ms 热循环：按 60s 退避重排并通知，恢复后正常投递', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  await h.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'active-check-err',
    schedule: '*/5 * * * *',
    text: 'ping',
    catchUp: true,
  })

  let checkCalls = 0
  let shouldThrow = true
  h.findActiveRunImpl = () => {
    checkCalls += 1
    if (shouldThrow) throw new Error('sqlite busy during listConversations')
    return undefined
  }

  await h.clock.advance(5 * MIN) // T0_5: findActiveRun throws once -> must back off 60s, not loop at 0ms
  await h.runtime.settle()
  assert.equal(checkCalls, 1, 'findActiveRun 抛错必须 60s 退避，绝不在同一毫秒 0ms 无限重试')
  assert.equal(h.dispatched.length, 0)
  assert.ok(h.events.some((e) => e.type === 'notification'), 'findActiveRun 失败必须发出错误通知')

  // 推进 30s（未到 60s 退避点）：不提前重试
  await h.clock.advance(30_000)
  await h.runtime.settle()
  assert.equal(checkCalls, 1)

  // 恢复后推进至 T0_5 + 60s：自动重试并投递
  shouldThrow = false
  await h.clock.advance(30_000)
  await h.runtime.settle()
  assert.equal(checkCalls, 2)
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.dispatched[0]!.envelope.id, `cron:active-check-err:${T0_5}`)
})

// ---------------------------------------------------------------------------
// cron_update：字段更新、启停重排、并发 (id, rev) 隔离、模式切换与边界校验
// ---------------------------------------------------------------------------

test('cron_update：基础字段更新、description 空串清空、运行历史保留与 flush 落盘', { timeout: 60_000 }, async () => {
  const h = track(
    makeHarness(T0, {
      version: 1,
      jobs: [
        seedJob({
          id: 'upd',
          rev: 'rev-init',
          description: '旧说明',
          schedule: '*/5 * * * *',
          timezone: 'UTC',
          text: 'old prompt',
          nextRunAt: T0_5,
          lastRunAt: T0 - 5 * MIN,
          lastError: 'prior error',
          lastSkippedAt: T0 - MIN,
          lastSkipReason: 'previous run #9 is still working',
        }),
      ],
    }),
  )
  await ready(h)
  const flushBefore = h.flushCalls
  const res = (await h.host.invokeAction('builtin:triggers', 'cron_update', {
    id: 'upd',
    description: '新说明',
    schedule: '0 8 * * *',
    timezone: 'Asia/Shanghai',
    text: 'new prompt',
    catchUp: true,
  })) as { job: CronJob }

  assert.equal(res.job.id, 'upd')
  assert.notEqual(res.job.rev, 'rev-init', 'update 必须换代 rev')
  assert.equal(res.job.description, '新说明')
  assert.equal(res.job.schedule, '0 8 * * *')
  assert.equal(res.job.timezone, 'Asia/Shanghai')
  assert.equal(res.job.text, 'new prompt')
  assert.equal(res.job.catchUp, true)
  assert.equal(res.job.enabled, true)
  // T0 = 2026-01-01T00:00:00Z = 上海 08:00:00，严格晚于 T0 的下次 08:00 是 2026-01-02T00:00:00Z
  assert.equal(res.job.nextRunAt, Date.parse('2026-01-02T00:00:00Z'))
  // 保留运行历史字段
  assert.equal(res.job.lastRunAt, T0 - 5 * MIN)
  assert.equal(res.job.lastError, 'prior error')
  assert.equal(res.job.lastSkippedAt, T0 - MIN)
  assert.equal(res.job.lastSkipReason, 'previous run #9 is still working')
  assert.ok(h.flushCalls >= flushBefore + 1, 'cron_update 必须 flush 落盘')

  // description 传空串清空字段
  const cleared = (await h.host.invokeAction('builtin:triggers', 'cron_update', {
    id: 'upd',
    description: '',
  })) as { job: CronJob }
  assert.equal(cleared.job.description, undefined)
  assert.equal('description' in cleared.job, false, '清空 description 后不得保留空串键')
  assert.notEqual(cleared.job.rev, res.job.rev)
})

test('cron_update：enabled 启停切换、timer 重排与 flush 失败完整回滚重排', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0))
  await ready(h)
  const created = (await h.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'sched',
    schedule: '*/5 * * * *',
    text: 'ping',
  })) as { job: CronJob }
  assert.equal(h.clock.activeTimers(), 1)

  // 1) flush 失败：原 job（含 rev）回滚且原 timer 重排，正常触发
  h.flushImpl = async () => {
    throw new HelmxError('store_flush_failed', 'flush failed', 500)
  }
  await assert.rejects(
    h.host.invokeAction('builtin:triggers', 'cron_update', { id: 'sched', enabled: false }),
    (err: unknown) => err instanceof HelmxError && err.code === 'store_flush_failed',
  )
  h.flushImpl = async () => {}
  const afterRollback = await soleJob(h)
  assert.equal(afterRollback.enabled, true)
  assert.equal(afterRollback.rev, created.job.rev, 'flush 失败应回滚至原 rev')
  assert.equal(h.clock.activeTimers(), 1, 'flush 失败后应重排原 timer')

  // 2) 停用（enabled: false）：取消 timer，推进期间不投递（nextRunAt 保持与 cron_create 一致的非空计算值）
  const disabled = (await h.host.invokeAction('builtin:triggers', 'cron_update', {
    id: 'sched',
    enabled: false,
  })) as { job: CronJob }
  assert.equal(disabled.job.enabled, false)
  assert.equal(disabled.job.nextRunAt, T0_5, '停用更新与 cron_create 一致计算 nextRunAt')
  assert.equal(h.clock.activeTimers(), 0, '停用后不得残留 timer')
  await h.clock.advance(12 * MIN) // 到 T0+12m
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 0)

  // 3) 重新启用：按当前时钟 T0+12m 重算 nextRunAt=T15，不补跑停用期错过时点
  const reenabled = (await h.host.invokeAction('builtin:triggers', 'cron_update', {
    id: 'sched',
    enabled: true,
  })) as { job: CronJob }
  assert.equal(reenabled.job.enabled, true)
  assert.equal(reenabled.job.nextRunAt, T15)
  assert.equal(h.clock.activeTimers(), 1)
  await h.clock.advance(3 * MIN) // 到 T15
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.dispatched[0]!.envelope.id, `cron:sched:${T15}`)

  // 4) 修改 schedule 重排 timer：T15+1m 改每小时整点，T20 不触发，T0+60m 触发
  await h.clock.advance(MIN) // T16
  const rescheduled = (await h.host.invokeAction('builtin:triggers', 'cron_update', {
    id: 'sched',
    schedule: '0 * * * *',
    text: 'hourly',
  })) as { job: CronJob }
  assert.equal(rescheduled.job.nextRunAt, T0 + 60 * MIN)
  assert.equal(h.clock.activeTimers(), 1)
  await h.clock.advance(4 * MIN) // T20（旧 5 分钟点）
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 1, '旧 timer 必须已被清除')
  await h.clock.advance(40 * MIN) // T60（新整点）
  await h.runtime.settle()
  assert.equal(h.dispatched.length, 2)
  assert.equal(h.dispatched[1]!.envelope.id, `cron:sched:${T0 + 60 * MIN}`)
  assert.equal(h.dispatched[1]!.envelope.text, 'hourly')
})

test('cron_update：并发 (id, rev) 换代防在途旧 tick 写回污染且与 activeTickWrite 串行', { timeout: 60_000 }, async () => {
  // 场景 A：dispatch 挂起失败期间 cron_update 换代 rev，旧 tick 的 lastError 不得污染更新后的 job
  const h1 = track(makeHarness(T0))
  await ready(h1)
  let rejectOld!: (err: Error) => void
  h1.dispatchImpl = (envelope, target) =>
    new Promise<TriggerDispatchResult>((_, reject) => {
      h1.dispatched.push({ envelope, target })
      rejectOld = reject
    })
  await h1.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'race-err',
    schedule: '*/5 * * * *',
    text: 'old',
  })
  await h1.clock.advance(5 * MIN)
  await waitFor(() => h1.dispatched.length === 1)

  const updated = (await h1.host.invokeAction('builtin:triggers', 'cron_update', {
    id: 'race-err',
    schedule: '0 * * * *',
    text: 'new',
  })) as { job: CronJob }
  rejectOld(new Error('old dispatch boom'))
  await h1.runtime.settle()
  const finalJob = await soleJob(h1)
  assert.equal(finalJob.rev, updated.job.rev)
  assert.equal(finalJob.text, 'new')
  assert.equal(finalJob.lastError, undefined, '旧 tick 失败写回必须被 (id, rev) 守卫拦截')

  // 场景 B：claim flush 持锁期间并发 cron_update 必须排队等待，随后换代 rev 阻止旧 tick 继续投递
  const h2 = track(makeHarness(T0))
  await ready(h2)
  await h2.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'race-lock',
    schedule: '*/5 * * * *',
    text: 'before',
  })
  let claimEntered!: () => void
  let releaseClaim!: () => void
  const claimStarted = new Promise<void>((r) => { claimEntered = r })
  const claimGate = new Promise<void>((r) => { releaseClaim = r })
  h2.flushImpl = () => {
    claimEntered()
    return claimGate
  }
  await h2.clock.advance(5 * MIN)
  await claimStarted

  let updateFinished = false
  h2.flushImpl = async () => {}
  const updatePromise = h2.host
    .invokeAction('builtin:triggers', 'cron_update', { id: 'race-lock', text: 'after' })
    .then((res) => {
      updateFinished = true
      return res as { job: CronJob }
    })
  await new Promise((r) => setImmediate(r))
  assert.equal(updateFinished, false, 'cron_update 必须等待 activeTickWrite 释放')

  releaseClaim()
  const res = await updatePromise
  await h2.runtime.settle()
  assert.equal(res.job.text, 'after')
  assert.equal(res.job.lastRunAt, T0_5, '串行化后应保留先落盘的 lastRunAt')
  assert.equal(h2.dispatched.length, 0, 'claim 后 rev 已被 cron_update 换代，旧 tick 不得继续投递旧文本')
})

test('cron_update：目标模式切换与合并（isolated <-> dedicated <-> targetConversationId）', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0, undefined, { profileIds: ['assistant', 'p1', 'p2'] }))
  await ready(h)
  await h.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'mode-job',
    schedule: '*/5 * * * *',
    text: 'run',
    mode: 'isolated',
    profileId: 'p1',
    keepLast: 5,
  })

  // isolated 内更新 keepLast
  const iso1 = (await h.host.invokeAction('builtin:triggers', 'cron_update', {
    id: 'mode-job',
    keepLast: 20,
  })) as { job: CronJob }
  assert.equal(iso1.job.mode, 'isolated')
  assert.equal(iso1.job.profileId, 'p1')
  assert.equal(iso1.job.keepLast, 20)

  // isolated -> dedicated：丢弃 keepLast，保留 profileId
  const ded1 = (await h.host.invokeAction('builtin:triggers', 'cron_update', {
    id: 'mode-job',
    mode: 'dedicated',
  })) as { job: CronJob }
  assert.equal(ded1.job.mode, 'dedicated')
  assert.equal(ded1.job.profileId, 'p1')
  assert.equal(ded1.job.keepLast, undefined)

  // 模拟已有 dedicatedConversationId：只改 description 保留；改同 profileId 保留；改不同 profileId 清空
  const rawDoc = h.docs.store.get('builtin:triggers:crons') as CronDoc
  rawDoc.jobs[0] = { ...rawDoc.jobs[0]!, dedicatedConversationId: 77 }
  const dedDesc = (await h.host.invokeAction('builtin:triggers', 'cron_update', {
    id: 'mode-job',
    description: 'keep dedicated binding',
  })) as { job: CronJob }
  assert.equal(dedDesc.job.dedicatedConversationId, 77)

  const dedSameProfile = (await h.host.invokeAction('builtin:triggers', 'cron_update', {
    id: 'mode-job',
    profileId: 'p1',
  })) as { job: CronJob }
  assert.equal(dedSameProfile.job.dedicatedConversationId, 77)

  const dedNewProfile = (await h.host.invokeAction('builtin:triggers', 'cron_update', {
    id: 'mode-job',
    profileId: 'p2',
  })) as { job: CronJob }
  assert.equal(dedNewProfile.job.profileId, 'p2')
  assert.equal(dedNewProfile.job.dedicatedConversationId, undefined, 'dedicated 切换 profileId 必须清空旧会话绑定')

  // dedicated -> isolated：清空 dedicatedConversationId 并补默认 keepLast=10
  const rawDoc2 = h.docs.store.get('builtin:triggers:crons') as CronDoc
  rawDoc2.jobs[0] = { ...rawDoc2.jobs[0]!, dedicatedConversationId: 88 }
  const backToIso = (await h.host.invokeAction('builtin:triggers', 'cron_update', {
    id: 'mode-job',
    mode: 'isolated',
  })) as { job: CronJob }
  assert.equal(backToIso.job.mode, 'isolated')
  assert.equal(backToIso.job.profileId, 'p2')
  assert.equal(backToIso.job.keepLast, 10)
  assert.equal(backToIso.job.dedicatedConversationId, undefined)

  // automated -> targetConversationId：清空全部自动化字段
  const convTarget = (await h.host.invokeAction('builtin:triggers', 'cron_update', {
    id: 'mode-job',
    targetConversationId: 9,
  })) as { job: CronJob }
  assert.equal(convTarget.job.targetConversationId, 9)
  assert.equal(convTarget.job.mode, undefined)
  assert.equal(convTarget.job.profileId, undefined)
  assert.equal(convTarget.job.keepLast, undefined)
  assert.equal(convTarget.job.dedicatedConversationId, undefined)

  // targetConversationId -> automated（省略 mode 默认 isolated + keepLast=10）
  const convToIso = (await h.host.invokeAction('builtin:triggers', 'cron_update', {
    id: 'mode-job',
    profileId: 'p1',
  })) as { job: CronJob }
  assert.equal(convToIso.job.targetConversationId, undefined)
  assert.equal(convToIso.job.mode, 'isolated')
  assert.equal(convToIso.job.profileId, 'p1')
  assert.equal(convToIso.job.keepLast, 10)

  // targetConversationId -> dedicated
  await h.host.invokeAction('builtin:triggers', 'cron_update', { id: 'mode-job', targetConversationId: 9 })
  const convToDed = (await h.host.invokeAction('builtin:triggers', 'cron_update', {
    id: 'mode-job',
    mode: 'dedicated',
    profileId: 'p2',
  })) as { job: CronJob }
  assert.equal(convToDed.job.targetConversationId, undefined)
  assert.equal(convToDed.job.mode, 'dedicated')
  assert.equal(convToDed.job.profileId, 'p2')
  assert.equal(convToDed.job.keepLast, undefined)

  // 验证触发时实际路由到更新后的目标
  await h.host.invokeAction('builtin:triggers', 'cron_trigger', { id: 'mode-job' })
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.dispatched[0]!.target.kind, 'dedicated')
  if (h.dispatched[0]!.target.kind === 'dedicated') {
    assert.equal(h.dispatched[0]!.target.profileId, 'p2')
  }
})

test('cron_update：校验边界（空 patch、404、互斥字段、dedicated+keepLast、非法 schedule/timezone、不存在 profileId）', { timeout: 60_000 }, async () => {
  const h = track(makeHarness(T0, undefined, { profileIds: ['assistant', 'worker'] }))
  await ready(h)
  await h.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'v1',
    schedule: '*/5 * * * *',
    text: 'ok',
    mode: 'dedicated',
  })
  await h.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'v2',
    schedule: '*/5 * * * *',
    text: 'ok',
    targetConversationId: 3,
  })

  const expectCode = async (p: Promise<unknown>, code: string, status: number): Promise<void> => {
    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof HelmxError, `期望 HelmxError，实际：${String(err)}`)
      assert.equal(err.code, code)
      assert.equal(err.status, status)
      return true
    })
  }

  // 空 patch（无除 id 外可更新字段）
  await expectCode(h.host.invokeAction('builtin:triggers', 'cron_update', { id: 'v1' }), 'validation_error', 400)
  // 不存在的 job
  await expectCode(h.host.invokeAction('builtin:triggers', 'cron_update', { id: 'ghost', text: 'x' }), 'not_found', 404)
  // 额外字段被 additionalProperties: false 拒绝
  await expectCode(
    h.host.invokeAction('builtin:triggers', 'cron_update', { id: 'v1', text: 'x', extra: 1 }),
    'validation_error',
    400,
  )
  // targetConversationId 与自动化字段互斥
  await expectCode(
    h.host.invokeAction('builtin:triggers', 'cron_update', { id: 'v1', targetConversationId: 1, mode: 'isolated' }),
    'validation_error',
    400,
  )
  await expectCode(
    h.host.invokeAction('builtin:triggers', 'cron_update', { id: 'v1', targetConversationId: 1, profileId: 'worker' }),
    'validation_error',
    400,
  )
  await expectCode(
    h.host.invokeAction('builtin:triggers', 'cron_update', { id: 'v1', targetConversationId: 1, keepLast: 3 }),
    'validation_error',
    400,
  )
  // dedicated 模式下传 keepLast 拒绝（保持 dedicated 或从 targetConversationId 切 dedicated）
  await expectCode(
    h.host.invokeAction('builtin:triggers', 'cron_update', { id: 'v1', keepLast: 5 }),
    'validation_error',
    400,
  )
  await expectCode(
    h.host.invokeAction('builtin:triggers', 'cron_update', { id: 'v2', mode: 'dedicated', keepLast: 5 }),
    'validation_error',
    400,
  )
  // 非法 schedule / timezone / 空白 text / 不存在 profileId
  await expectCode(
    h.host.invokeAction('builtin:triggers', 'cron_update', { id: 'v1', schedule: 'bad' }),
    'validation_error',
    400,
  )
  await expectCode(
    h.host.invokeAction('builtin:triggers', 'cron_update', { id: 'v1', schedule: '0 0 30 2 *' }),
    'validation_error',
    400,
  )
  await expectCode(
    h.host.invokeAction('builtin:triggers', 'cron_update', { id: 'v1', timezone: 'Not/AZone' }),
    'validation_error',
    400,
  )
  await expectCode(
    h.host.invokeAction('builtin:triggers', 'cron_update', { id: 'v1', text: '   ' }),
    'validation_error',
    400,
  )
  await expectCode(
    h.host.invokeAction('builtin:triggers', 'cron_update', { id: 'v1', profileId: 'nonexistent' }),
    'validation_error',
    400,
  )

  // 全部失败后原有 timer 与配置未受破坏
  assert.equal(h.clock.activeTimers(), 2)
  assert.equal(h.runtime.getJob('v1')?.schedule, '*/5 * * * *')
})

test('cron_delete：持写锁串行等待且 flush 失败回滚重排', { timeout: 60_000 }, async () => {
  // 1) claim flush 持锁期间并发 cron_delete 必须排队等待，随后干净删除而不被残留写入复活
  const h1 = track(makeHarness(T0))
  await ready(h1)
  await h1.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'del-race',
    schedule: '*/5 * * * *',
    text: 'run',
  })
  let claimEntered!: () => void
  let releaseClaim!: () => void
  const claimStarted = new Promise<void>((r) => { claimEntered = r })
  const claimGate = new Promise<void>((r) => { releaseClaim = r })
  h1.flushImpl = () => {
    claimEntered()
    return claimGate
  }
  await h1.clock.advance(5 * MIN)
  await claimStarted

  let deleteFinished = false
  h1.flushImpl = async () => {}
  const deletePromise = h1.host
    .invokeAction('builtin:triggers', 'cron_delete', { id: 'del-race' })
    .then((res) => {
      deleteFinished = true
      return res as { deleted: boolean }
    })
  await new Promise((r) => setImmediate(r))
  assert.equal(deleteFinished, false, 'cron_delete 必须等待 active write lock 释放')

  releaseClaim()
  const deleted = await deletePromise
  await h1.runtime.settle()
  assert.deepEqual(deleted, { deleted: true })
  assert.equal(h1.runtime.getJob('del-race'), undefined, '持锁完成后删除生效且不得被旧 claim 复活')

  // 2) cron_delete flush 失败必须回滚 job 且重新调度启用任务的 timer
  const h2 = track(makeHarness(T0))
  await ready(h2)
  await h2.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'del-fail',
    schedule: '*/5 * * * *',
    text: 'still alive',
  })
  assert.equal(h2.clock.activeTimers(), 1)
  h2.flushImpl = async () => {
    throw new HelmxError('store_flush_failed', 'flush boom', 500)
  }
  await assert.rejects(
    h2.host.invokeAction('builtin:triggers', 'cron_delete', { id: 'del-fail' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'store_flush_failed',
  )
  assert.equal(h2.runtime.getJob('del-fail')?.id, 'del-fail', 'delete flush 失败必须回滚 job')
  assert.equal(h2.clock.activeTimers(), 1, 'delete flush 失败必须恢复原 timer')

  h2.flushImpl = async () => {}
  await h2.clock.advance(5 * MIN)
  await h2.runtime.settle()
  assert.equal(h2.dispatched.length, 1, '回滚恢复后的 cron 仍按计划触发')
})

test('error redaction：lastError 落盘与 SSE notification 均经过 ctx.host.redact 脱敏', { timeout: 60_000 }, async () => {
  const redact = (text: string): string => text.replace(/sk-cron-secret/g, '[REDACTED]')
  const h = track(makeHarness(T0, undefined, { redact }))
  await ready(h)
  h.dispatchImpl = async () => {
    throw new Error('gateway rejected Bearer sk-cron-secret')
  }
  await h.host.invokeAction('builtin:triggers', 'cron_create', {
    id: 'secret-err',
    schedule: '*/5 * * * *',
    text: 'go',
  })
  await h.clock.advance(5 * MIN)
  await h.runtime.settle()

  const job = await soleJob(h)
  assert.ok(typeof job.lastError === 'string')
  assert.equal(job.lastError.includes('sk-cron-secret'), false, 'lastError 不得包含明文秘钥')
  assert.equal(job.lastError.includes('[REDACTED]'), true, 'lastError 必须保留脱敏占位符')

  const notif = h.events.find((e) => e.type === 'notification')?.payload as
    | { title?: string; body?: string }
    | undefined
  assert.ok(notif !== undefined, '失败必须发 notification 事件')
  assert.equal(notif.body?.includes('sk-cron-secret'), false, 'notification body 不得包含明文秘钥')
  assert.equal(notif.body?.includes('[REDACTED]'), true, 'notification body 必须保留脱敏占位符')
})
