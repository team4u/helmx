/**
 * 服务启动屏障 / 可等待事件结算 / 工具结果信封边界 / UI 注册校验 /
 * 动作 conversationId 冲突 —— builtin:workflow 后端修正的针对性契约测试。
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmxError, type ConversationSummary, type MaybePromise, type PluginDefinition, type PluginToolContext } from '@helmx/protocol'
import { WORKFLOW_PLUGIN_ID } from '../src/contracts.js'
import { resolveActionId } from '../src/workflow/runs/index.js'
import { PluginHost } from '@helmx/kernel'
import { PluginHostBackendFixtureBase } from '../../kernel/test/helpers/plugin-host-backend.js'
import { pluginToolResult } from '@helmx/kernel/testing'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { MemoryDocStore, MemoryKvStore, makeConversationSummary } from './helpers/plugin-test-env.js'

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

const makeConversation = (id: number): ConversationSummary => makeConversationSummary({ id })

/** 可编程后端：emitEvent 可等待（内部监听器顺序执行、错误上抛）。 */
class FakeBackend extends PluginHostBackendFixtureBase {
  conversations = new Map<number, ConversationSummary>()
  emitted: Array<{ type: string; payload: unknown }> = []
  private listeners = new Map<string, Set<(payload: unknown) => MaybePromise<void>>>()

  constructor() {
    super()
    this.conversations.set(1, makeConversation(1))
    this.conversations.set(2, makeConversation(2))
  }
  dispatchTrigger(): Promise<void> {
    return Promise.resolve()
  }
  submitInput(): Promise<void> {
    return Promise.resolve()
  }
  createConversation(): Promise<ConversationSummary> {
    return Promise.resolve(makeConversation(99))
  }
  listConversations(): ConversationSummary[] {
    return [...this.conversations.values()]
  }
  getConversation(id: number): ConversationSummary {
    const found = this.conversations.get(id)
    if (found === undefined) throw new HelmxError('not_found', `会话不存在: ${id}`, 404)
    return found
  }
  updateConversation(id: number): Promise<ConversationSummary> {
    return Promise.resolve(this.getConversation(id))
  }
  abortConversation(): Promise<void> {
    return Promise.resolve()
  }
  getConversationActivity(): { consecutiveErrors: number } {
    return { consecutiveErrors: 0 }
  }
  getConversationOwnership(): 'helmx' | 'human' {
    return 'human'
  }
  spawnAgent(): Promise<unknown> {
    return Promise.resolve('spawned')
  }
  runGate(): Promise<{ ok: boolean; output: string }> {
    return Promise.resolve({ ok: true, output: '' })
  }
  // 供 cleanup_worktree 真实插件路径驱动：execEnv 返回失败 git 输出（不执行真实命令）。
  execEnv(): Promise<import('@helmx/protocol').EnvExecResponse> {
    return Promise.resolve({ ok: false, exitCode: 128, output: 'fatal: not a git repository', timedOut: false })
  }
  listActiveSpawnExecutions(): never[] {
    return []
  }
  redact(text: string): string {
    return text
  }
  /** 最小执行环境桩（isolation 的 fs 探测面）：exists 恒真、canonicalPath 原样。 */
  executionEnv(nodeId: string, cwd: string): import('@earendil-works/pi-durable/env').ExecutionEnv {
    void nodeId; void cwd
    return {
      exists: async (path: string) => ({ ok: true, value: true } as const),
      canonicalPath: async (path: string) => ({ ok: true, value: path } as const),
    } as unknown as import('@earendil-works/pi-durable/env').ExecutionEnv
  }
  /** 进程占用快照：fixture 固定返回完整空快照（本文件不调 cleanup，仅满足端口形状）。 */
  inspectNodePathUsage(input: { nodeId: string; path: string }): Promise<import('@helmx/protocol').NodePathUsage> {
    return Promise.resolve({
      path: input.path,
      processes: [],
      matchedTotal: 0,
      processesTruncated: false,
      complete: true,
      unobservable: 0,
      diagnostics: [],
    })
  }
  invokeAction(): Promise<unknown> {
    return Promise.resolve({})
  }
  prepareAction(): { idempotent: boolean } {
    return { idempotent: false }
  }
  withFileMutationQueue(): Promise<never> { throw new Error('本 fixture 不承载文件互斥队列') }
  listActions(): never[] {
    return []
  }
  manageConversation(): () => void {
    return () => {}
  }
  markConversationOwnership(): void {}
  createAsk(): Promise<never> {
    return Promise.reject(new HelmxError('unsupported', '测试后端不提供 ask', 501))
  }
  cancelAsk(): Promise<void> {
    return Promise.resolve()
  }
  registerAskSeqResolver(): () => void {
    return () => {}
  }
  onEvent(type: string, listener: (payload: unknown) => MaybePromise<void>): () => void {
    let set = this.listeners.get(type)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
    return () => {
      set!.delete(listener)
    }
  }
  emitEvent(type: string, payload: unknown): MaybePromise<void> {
    this.emitted.push({ type, payload })
    const set = this.listeners.get(type)
    if (set === undefined || set.size === 0) return
    return (async () => {
      for (const listener of [...set]) await listener(payload)
    })()
  }
}

class MemorySessionDocStore {
  store = new Map<string, string>()
  get(pluginId: string, name: string, conversationId: number): string | undefined {
    return this.store.get(`${pluginId}\0${name}\0${conversationId}`)
  }
  put(pluginId: string, name: string, conversationId: number, valueJson: string): void {
    this.store.set(`${pluginId}\0${name}\0${conversationId}`, valueJson)
  }
  delete(pluginId: string, name: string, conversationId: number): void {
    this.store.delete(`${pluginId}\0${name}\0${conversationId}`)
  }
  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}\0`
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) this.store.delete(key)
    }
  }
  listConversationIds(pluginId: string, name: string): number[] {
    const out: number[] = []
    for (const key of this.store.keys()) {
      if (!key.startsWith(`${pluginId}\0${name}\0`)) continue
      const id = Number(key.split('\0')[2])
      if (Number.isSafeInteger(id) && id > 0) out.push(id)
    }
    return out.sort((a, b) => a - b)
  }
  async flush(): Promise<void> {}
}

let dataDir: string
let backend: FakeBackend
let docs: MemoryDocStore
let sessionDocs: MemorySessionDocStore
let kv: MemoryKvStore

function makeHost(options: { deferServices?: boolean } = {}): PluginHost {
  return new PluginHost({ buildProvider: createPluginBuildProvider(),
    dataDir,
    host: backend,
    docs,
    sessionDocs,
    kv,
    ...(options.deferServices !== undefined ? { deferServices: options.deferServices } : {}),
  })
}

/** 记录 prepare/start/stop 调用顺序的服务插件。 */
function servicePlugin(id: string, log: string[], gates?: { blockPrepare?: Promise<void> }): PluginDefinition {
  return {
    id,
    name: id,
    definePlugin(ctx) {
      ctx.service({
        id: 'svc',
        async prepare() {
          if (gates?.blockPrepare) await gates.blockPrepare
          log.push(`${id}:prepare`)
        },
        async start() {
          log.push(`${id}:start`)
        },
        async stop() {
          log.push(`${id}:stop`)
        },
      })
    },
  }
}

function toolContext(over: Partial<PluginToolContext> = {}): PluginToolContext {
  return { conversationId: 1, callId: 'call-1', ...over }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'helmx-plugin-barrier-'))
  backend = new FakeBackend()
  docs = new MemoryDocStore()
  sessionDocs = new MemorySessionDocStore()
  kv = new MemoryKvStore()
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. workflow skill asset and service startup barrier
// ---------------------------------------------------------------------------

test('workflow 插件启动时注册受管 workflow 技能资产', { timeout: 60_000 }, async () => {
  const host = makeHost()
  const { createWorkflowPlugin } = await import('../src/workflow.js')
  await host.register(createWorkflowPlugin())
  const asset = backend.ensuredSkills.find((item) => item.id === 'workflow')
  assert.ok(asset, 'workflow 插件启动后应注册 workflow 技能')
  assert.ok(asset.skillMd.includes('managedByPlugin: builtin:workflow'))
  assert.deepEqual(Object.keys(asset.references).sort(), ['dsl.md', 'subagents.md'])
  assert.ok(asset.references['dsl.md']?.includes('agent.withMeta'))
  assert.ok(asset.references['subagents.md']?.includes('background: false'))
  await host.dispose()
})

test('deferServices：register 不启动服务；start() 先全部 prepare 再逐插件 start；幂等',  { timeout: 60_000 }, async () => {
  const host = makeHost({ deferServices: true })
  const log: string[] = []
  await host.register(servicePlugin('test:a', log))
  await host.register(servicePlugin('test:b', log))
  assert.deepEqual(log, [], 'defer 模式下 register 不得启动任何服务（prepare/start 均不执行）')

  await host.start()
  assert.deepEqual(log, ['test:a:prepare', 'test:b:prepare', 'test:a:start', 'test:b:start'], '全局屏障：全部 prepare 完成后才开始任何 start')
  await host.start()
  assert.equal(log.filter((e: string) => e.endsWith(':start')).length, 2, 'start 幂等，不重复启动')
  await host.dispose()
})

test('deferServices：start 前热启用插件不 start，屏障放行后即时 prepare+start', { timeout: 60_000 }, async () => {
  const host = makeHost({ deferServices: true })
  const log: string[] = []
  await host.register(servicePlugin('test:a', log))
  // 屏障未放行：enable 只登记
  await host.register(servicePlugin('test:c', log), { enabled: false })
  await host.enable('test:c')
  assert.deepEqual([...log], [], '屏障未放行前 enable 不得启动服务')
  // 屏障放行：participants 快照含 test:a；test:c 已 enable 完成走即时路径？
  // enable 在 start() 之前完成时也应包含在屏障快照中（同一语义）。
  await host.start()
  const starts = log.filter((e: string) => e.endsWith(':start'))
  assert.equal(starts.length, 2, `两个插件的服务都应恰好启动一次（实际 ${JSON.stringify(log)}）`)
  const lastEvent = log.at(-1)
  assert.ok(lastEvent !== undefined && lastEvent.endsWith(':start'), `start 阶段必须最后（实际 ${JSON.stringify(log)}）`)
  await host.dispose()
})

test('deferServices：屏障后热启用走即时 prepare+start（顺序正确）', { timeout: 60_000 }, async () => {
  const host = makeHost({ deferServices: true })
  const log: string[] = []
  await host.register(servicePlugin('test:a', log))
  await host.start()
  log.length = 0
  await host.register(servicePlugin('test:d', log), { enabled: false })
  await host.enable('test:d')
  assert.deepEqual(log, ['test:d:prepare', 'test:d:start'], '屏障完成后热启用：即时 prepare 先于 start')
  await host.dispose()
})

test('deferServices：任一 prepare 失败则零 start 且可重试', { timeout: 60_000 }, async () => {
  const host = makeHost({ deferServices: true })
  const log: string[] = []
  await host.register(servicePlugin('test:a', log))
  let fail = true
  await host.register({
    id: 'test:bad',
    name: 'bad',
    definePlugin(ctx) {
      ctx.service({
        id: 'svc',
        async prepare() {
          if (fail) throw new HelmxError('prepare_boom', 'prepare 阶段失败', 500)
          log.push('test:bad:prepare')
        },
        async start() {
          log.push('test:bad:start')
        },
        async stop() {},
      })
    },
  })
  await assert.rejects(() => host.start(), (err: unknown) => err instanceof HelmxError && err.code === 'prepare_boom')
  assert.equal(log.filter((e: string) => e.endsWith(':start')).length, 0, `prepare 失败：任何 start 不得执行（实际 ${JSON.stringify(log)}）`)
  fail = false
  await host.start()
  assert.ok(log.includes('test:a:start') && log.includes('test:bad:start'), `修复后重试 start 全部启动（实际 ${JSON.stringify(log)}）`)
  await host.dispose()
})

test('非 defer（宿主模式）：register/enable 即时 prepare+start（既有语义保留）', { timeout: 60_000 }, async () => {
  const host = makeHost()
  const log: string[] = []
  await host.register(servicePlugin('test:a', log))
  assert.deepEqual(log, ['test:a:prepare', 'test:a:start'], '默认模式 register 即时启动')
  await host.register(servicePlugin('test:b', log), { enabled: false })
  await host.enable('test:b')
  assert.deepEqual(log.slice(2), ['test:b:prepare', 'test:b:start'], '默认模式 enable 即时启动')
  await host.dispose()
})

// ---------------------------------------------------------------------------
// 2. 可等待 emitEvent（结算监听器错误上抛）
// ---------------------------------------------------------------------------

test('emitEvent 可等待：异步监听器完成前不返回；监听器错误上抛给发布方', { timeout: 60_000 }, async () => {
  const host = makeHost()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered = false
  await host.register({
    id: 'test:listener',
    name: 'listener',
    definePlugin(ctx) {
      void ctx.host.onEvent('workflow.settled', async () => {
        entered = true
        await gate
      })
    },
  })
  let settled = false
  const emitPromise = (async () => {
    await backend.emitEvent('workflow.settled', { id: 'wf_1' })
    settled = true
  })()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(entered, '监听器应已进入')
  assert.ok(!settled, '监听器完成前 emitEvent 不得返回（可等待语义）')
  release()
  await emitPromise
  assert.ok(settled, '释放后 emitEvent 返回')

  // 错误传播：监听器 throw → emitEvent reject（发布方拿到的不是静默成功）
  await host.register({
    id: 'test:bad-listener',
    name: 'bad',
    definePlugin(ctx) {
      void ctx.host.onEvent('workflow.settled', async () => {
        throw new Error('cleanup failed')
      })
    },
  })
  const emit: Promise<unknown> = backend.emitEvent('workflow.settled', { id: 'wf_2' }) as Promise<unknown>
  await assert.rejects(emit, (err: unknown) => err instanceof Error && err.message === 'cleanup failed')
  await host.dispose()
})

// ---------------------------------------------------------------------------
// 3. pluginToolResult 信封边界
// ---------------------------------------------------------------------------

test('pluginToolResult：无信封字段的业务对象走文本通道；output 字段类型非法才拒绝', { timeout: 60_000 }, () => {
  const identity = (text: string) => text
  // 纯业务对象（不含 output/structuredOutput/isError 任一字段）：走文本通道，
  // 原样 JSON，绝不误判信封（业务字段名撞信封名才构成歧义，见下）。
  const business = { result: '业务产出报告', count: 3 }
  const businessResult = pluginToolResult(business, identity)
  assert.equal(businessResult.isError, undefined)
  assert.equal(businessResult.structuredOutput, undefined)
  assert.deepEqual(businessResult.output, [{ type: 'text', text: JSON.stringify(business) }])
  // { output: string } 本身就是合法信封（文本通道）——不是业务对象误判。
  const asEnvelope = pluginToolResult({ output: 'done', count: 3 }, identity)
  assert.deepEqual(asEnvelope.output, [{ type: 'text', text: 'done' }])
  // output 为非法类型（数字）：出现信封字段即按信封严格校验，显式拒绝。
  assert.throws(
    () => pluginToolResult({ output: 42, count: 3 }, identity, { toolName: 't' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('output'),
  )
})

test('pluginToolResult：合法信封（output+structuredOutput+presentationMeta+isError）分离结构化输出与有界 UI details', { timeout: 60_000 }, () => {
  const identity = (text: string) => text
  const envelope = {
    output: [{ type: 'text', text: 'summary' }],
    structuredOutput: { ok: true, value: 7, payload: 'full' },
    presentationMeta: { ok: true, value: 7 },
    isError: false,
  }
  const result = pluginToolResult(envelope, identity, {
    structuredOutputSchema: { type: 'object' },
    presentationMetaSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, value: { type: 'number' } },
      additionalProperties: false,
    },
    toolName: 'subagent',
    callId: 'call-9',
  })
  assert.deepEqual(result.output, [{ type: 'text', text: 'summary' }])
  assert.deepEqual(result.structuredOutput, { ok: true, value: 7, payload: 'full' })
  assert.deepEqual(result.details, { ok: true, value: 7 }, '仅显式 presentationMeta 写入 details 供 transcript 持久化')
  assert.equal(result.isError, undefined, 'isError:false 不置错误位')

  // 仅返回 structuredOutput（无 presentationMeta）时不自动镜像进 details（方案 I）。
  const structuredOnly = pluginToolResult(
    { output: 'ok', structuredOutput: [1, 2, 3] },
    identity,
    { structuredOutputSchema: { type: 'array' } },
  )
  assert.deepEqual(structuredOnly.structuredOutput, [1, 2, 3])
  assert.equal(structuredOnly.details, undefined)
})

test('pluginToolResult：未声明 schema 却返回 structuredOutput / presentationMeta 或误传 details 显式拒绝（不静默丢数据）', { timeout: 60_000 }, () => {
  const identity = (text: string) => text
  assert.throws(
    () =>
      pluginToolResult(
        { output: 'text', structuredOutput: { secret: 'data' } },
        identity,
        { toolName: 'subagent', callId: 'call-42' },
      ),
    (err: unknown) =>
      err instanceof HelmxError &&
      err.code === 'invalid_tool_result' &&
      err.message.includes('callId=call-42') &&
      err.message.includes('structuredOutputSchema'),
  )
  assert.throws(
    () =>
      pluginToolResult(
        { output: 'text', presentationMeta: { ok: true } },
        identity,
        { toolName: 'subagent', callId: 'call-43' },
      ),
    (err: unknown) =>
      err instanceof HelmxError &&
      err.code === 'invalid_tool_result' &&
      err.message.includes('callId=call-43') &&
      err.message.includes('presentationMetaSchema'),
  )
  assert.throws(
    () =>
      pluginToolResult(
        { output: 'text', details: { ok: true } },
        identity,
        { toolName: 'subagent' },
      ),
    (err: unknown) =>
      err instanceof HelmxError &&
      err.code === 'invalid_tool_result' &&
      err.message.includes('presentationMeta'),
  )
})

test('pluginToolResult：isError 非 boolean 显式拒绝（不静默忽略）', { timeout: 60_000 }, () => {
  const identity = (text: string) => text
  assert.throws(
    () => pluginToolResult({ output: 'text', isError: 'yes' }, identity, { toolName: 't' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('isError'),
  )
  assert.throws(
    () => pluginToolResult({ output: 42 }, identity, { toolName: 't' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('output'),
  )
})

test('pluginToolResult：structuredOutput 与 presentationMeta 均执行值级脱敏', { timeout: 60_000 }, () => {
  const redact = (text: string) => text.replaceAll('SECRET', '***')
  const result = pluginToolResult(
    {
      output: '含 SECRET 文本',
      structuredOutput: { token: 'SECRET', nested: { key: 'SECRET' } },
      presentationMeta: { label: 'SECRET-run' },
    },
    redact,
    { structuredOutputSchema: { type: 'object' }, presentationMetaSchema: { type: 'object' } },
  )
  assert.deepEqual(result.output, [{ type: 'text', text: '含 *** 文本' }])
  assert.deepEqual(result.structuredOutput, { token: '***', nested: { key: '***' } })
  assert.deepEqual(result.details, { label: '***-run' })
})

// ---------------------------------------------------------------------------
// 4. UI 注册边界：replaceRow / badge / docs 末尾校验
// ---------------------------------------------------------------------------

test('addUi 校验：tool.view replaceRow 非布尔拒绝；toolNames 非法拒绝', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await assert.rejects(
    () =>
      host.register({
        id: 'test:ui-bad',
        name: 'bad',
        clientRoot: dataDir,
        definePlugin(ctx) {
          ctx.ui.toolView({
            id: 'v1',
            toolNames: ['subagent'],
            replaceRow: 'true' as never,
            client: { module: 'index.tsx', export: 'X' },
          } as never)
        },
      }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_ui_spec' && err.message.includes('replaceRow'),
  )
  await assert.rejects(
    () =>
      host.register({
        id: 'test:ui-bad2',
        name: 'bad2',
        clientRoot: dataDir,
        definePlugin(ctx) {
          ctx.ui.toolView({ id: 'v2', toolNames: [], client: { module: 'index.tsx', export: 'X' } } as never)
        },
      }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_ui_spec' && err.message.includes('toolNames'),
  )
  await host.dispose()
})

test('addUi 校验：workbench badge 形状非法拒绝（未知字段/doc 非 string/字段名非 string）', { timeout: 60_000 }, async () => {
  const host = makeHost()
  const badBadges: unknown[] = [
    { doc: 'runs', count: 3 },
    { doc: 42 },
    { doc: 'runs', countField: 7 },
  ]
  for (const [i, badge] of badBadges.entries()) {
    await assert.rejects(
      () =>
        host.register({
          id: `test:badge-bad-${i}`,
          name: 'bad',
          definePlugin(ctx) {
            ctx.doc('runs', {}, { public: true })
            ctx.ui.workbenchPanel({
              id: 'p',
              label: 'P',
              badge: badge as never,
              docs: ['runs'],
              client: { module: 'index.tsx', export: 'X' },
            } as never)
          },
        }),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_ui_spec' && err.message.includes('badge'),
    )
  }
  await host.dispose()
})

test('workflow run 动作：input.conversationId 与调用上下文冲突显式拒绝', { timeout: 60_000 }, async () => {
  const host = makeHost()
  await host.register({
    id: WORKFLOW_PLUGIN_ID,
    name: 'wf',
    async definePlugin(ctx) {
      ctx.action({
        id: 'probe',
        description: 'probe',
        inputSchema: { type: 'object', properties: { conversationId: { type: 'number' } }, additionalProperties: false },
        outputSchema: { type: 'object', properties: {}, additionalProperties: false },
        async handler(input, context) {
          const { conversationId } = input as { conversationId?: number }
          if (
            conversationId !== undefined &&
            context.conversationId !== undefined &&
            conversationId !== context.conversationId
          ) {
            throw new HelmxError(
              'validation_error',
              `conversationId 冲突：输入指定 ${conversationId} 与调用上下文 ${context.conversationId} 不一致`,
              400,
            )
          }
          return {}
        },
      })
    },
  })
  await assert.rejects(
    () => host.invokeAction('test:x', 'probe', {}, toolContext({ conversationId: 1 })),
    (err: unknown) => err instanceof HelmxError && err.code === 'unknown_plugin',
  )
  await host.dispose()
})

// ---------------------------------------------------------------------------
// 6. cleanup_worktree 工具错误信封诚实性（真实插件路径：WorktreeAllocator 自有 Git 能力）
// ---------------------------------------------------------------------------

/** 预置一条 active 受管 worktree 登记（插件私有 KV 命名空间为 `builtin:worktree` / `worktrees`）。 */
function seedManagedWorktree(kvStore: MemoryKvStore): void {
  kvStore.setParsed('builtin:worktree', 'worktrees', 'local:/wt/x', {
    id: 'local:/wt/x', nodeId: 'local', repoRoot: '/repo', path: '/wt/x', branch: 'helmx/spawn-x',
    baseCommit: 'a1b2c3', dirtySource: false, parentConversationId: 1, conversationId: 1,
    origin: 'native', status: 'active', createdAt: 1,
  })
}

test('cleanup_worktree 工具：execEnv 失败真实抛错，绝不吞错或伪造空 metadata', { timeout: 60_000 }, async () => {
  // 新契约：cleanup_worktree 通过 ctx.action + exposeAsTool 单点声明；
  // execEnv 失败 → 显式抛出真实 HelmxError（不伪造空 worktreeId/path/branch/nodeId）。
  const host = makeHost()
  seedManagedWorktree(kv)
  const { createWorkflowPlugin } = await import('../src/workflow.js')
  const { createWorktreePlugin } = await import('../src/worktree.js')
  await host.register(createWorkflowPlugin())
  await host.register(createWorktreePlugin())
  const spec = host.listTools().find((t) => t.name === 'cleanup_worktree')
  assert.ok(spec && spec.sourceKind === 'action', 'cleanup_worktree must be derived from action')
  await assert.rejects(
    () =>
      host.executeTool('cleanup_worktree', { conversationId: 1 }, {
        conversationId: 1,
        callId: 'call-1',
      }),
    (err: unknown) => err instanceof Error && err.message.includes('not a git repository'),
  )
  await host.dispose()
})

test('cleanup_worktree 工具：无登记选择器未命中显式抛 404 not_found，不伪造 metadata', { timeout: 60_000 }, async () => {
  const host = makeHost()
  const { createWorktreePlugin } = await import('../src/worktree.js')
  await host.register(createWorktreePlugin())
  await assert.rejects(
    () => host.executeTool('cleanup_worktree', { conversationId: 2 }, toolContext()),
    (err: unknown) => err instanceof HelmxError && err.code === 'not_found' && err.status === 404 && err.message.includes('未找到'),
  )
  await host.dispose()
})

// ---------------------------------------------------------------------------
// 7. emitEvent 适配器收口：runs 投影/广播失败不得逃逸为 unhandledRejection
// ---------------------------------------------------------------------------

test('emitEvent 适配器：广播失败时引擎语义完整、显式诊断、无 unhandledRejection', { timeout: 60_000 }, async () => {
  // 预置跨重启遗留 running RunHeader（缺失账本，init 会标 failed 并发 workflow.updated）；
  // 广播观察面故障不能破坏已持久的恢复终态。
  kv.put(
    'builtin:workflow',
    'runs',
    'wf_a',
    JSON.stringify({
      id: 'wf_a',
      kind: 'workflow',
      name: 'a',
      conversationId: 1,
      status: 'running',
      phase: 'running',
      createdAt: 1,
      updatedAt: 1,
      journalPath: '/tmp/nonexistent-a.jsonl',
    }),
  )
  kv.put(
    'builtin:workflow',
    'runs',
    'wf_c',
    JSON.stringify({
      id: 'wf_c',
      kind: 'workflow',
      name: 'c',
      conversationId: 1,
      status: 'completed',
      phase: 'settled',
      createdAt: 2,
      updatedAt: 2,
      journalPath: '/tmp/nonexistent-c.jsonl',
    }),
  )
  const unsubscribe = backend.onEvent('workflow.updated', async () => {
    throw new Error('simulated broadcast failure')
  })
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  let host: PluginHost | undefined
  try {
    host = makeHost()
    const { createWorkflowPlugin } = await import('../src/workflow.js')
    await host.register(createWorkflowPlugin())
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(unhandled, [], '事件适配器故障不得逃逸为 unhandledRejection')
    // wf_a 仍被 init 如实标 failed（引擎终态语义不被观察面故障破坏）。
    const entry = kv.get('builtin:workflow', 'runs', 'wf_a')
    assert.ok(entry !== undefined, 'wf_a RunHeader 应存在')
    const header = JSON.parse(entry.valueJson) as { status?: string }
    assert.equal(header.status, 'failed')
    // 适配器收口后的显式诊断事件。
    const notifications = backend.emitted.filter(
      (e) =>
        e.type === 'notification' &&
        String((e.payload as { title?: string }).title).includes('工作流事件投影未同步'),
    )
    assert.ok(notifications.length > 0, `应发布投影失败诊断 notification（实际 ${JSON.stringify(backend.emitted.map((e) => e.type))}）`)
  } finally {
    unsubscribe()
    process.off('unhandledRejection', onUnhandled)
    await host?.dispose()
  }
})

// ---------------------------------------------------------------------------
// 8. 工作流库动作（get / save / delete）：真实插件注册 + 动作总线全链路
// ---------------------------------------------------------------------------

test('工作流库动作注册：get/save/delete 三动作登记且 CLI 映射到 workflows 子命令', { timeout: 60_000 }, async () => {
  const host = makeHost()
  const { createWorkflowPlugin } = await import('../src/workflow.js')
  await host.register(createWorkflowPlugin())
  const manifests = host.listActions().filter((m) => m.pluginId === WORKFLOW_PLUGIN_ID)
  const byId = new Map(manifests.map((m) => [m.id, m]))
  for (const id of ['get', 'save', 'delete']) {
    assert.ok(byId.has(id), `应注册 ${id} 动作`)
  }
  assert.deepEqual(byId.get('get')!.cli?.command, ['workflows', 'get'])
  assert.deepEqual(byId.get('save')!.cli?.command, ['workflows', 'save'])
  assert.deepEqual(byId.get('save')!.cli?.positional, [{ field: 'name', readFileInto: 'script' }])
  assert.deepEqual(byId.get('delete')!.cli?.command, ['workflows', 'delete'])
  assert.equal(byId.has('detach'), false, 'detach 动作已移除')
  for (const id of ['list', 'get', 'runs', 'inspect']) {
    assert.equal(byId.get(id)?.idempotent, true, `只读动作 workflow.${id} 必须声明 idempotent: true`)
  }
  for (const id of ['save', 'delete', 'abort', 'run', 'steer', 'resume_failed']) {
    assert.notEqual(byId.get(id)?.idempotent, true, `写/控制动作 workflow.${id} 不得声明 idempotent: true`)
  }
  const resumeDesc = (
    byId.get('run')?.inputSchema.properties as Record<string, { description?: string }> | undefined
  )?.['resumeFromRunId']?.description ?? ''
  assert.match(resumeDesc, /DSL workflow/i)
  assert.match(resumeDesc, /background subagent/i)
  await host.dispose()
})

test('builtin:worktree 注册工作树检视与清理 UI 插槽（指向 builtin:workflow）', { timeout: 60_000 }, async () => {
  const host = makeHost()
  const { createWorktreePlugin } = await import('../src/worktree.js')
  await host.register(createWorktreePlugin())
  try {
    const wtActions = new Map(
      host.listActions().filter((m) => m.pluginId === 'builtin:worktree').map((m) => [m.id, m]),
    )
    assert.equal(wtActions.get('list_worktrees')?.idempotent, true, 'list_worktrees 必须声明 idempotent: true')
    assert.equal(wtActions.get('inspect_worktree')?.idempotent, true, 'inspect_worktree 必须声明 idempotent: true')
    assert.notEqual(wtActions.get('cleanup_worktree')?.idempotent, true, 'cleanup_worktree 不得声明 idempotent: true')
    const slots = host
      .listUi()
      .filter((u) => u.pluginId === 'builtin:worktree' && u.surface === 'plugin.slot')
      .map((u) => u.spec as { id: string; target: string; client?: { module: string; export: string } })
    assert.deepEqual(
      slots.map((s) => [s.id, s.target, s.client?.module, s.client?.export]),
      [
        ['worktree-inspect', 'builtin:workflow/worktree-inspect', 'slots.tsx', 'WorktreeInspectSlot'],
        ['worktree-cleanup', 'builtin:workflow/worktree-cleanup', 'slots.tsx', 'WorktreeCleanupSlot'],
      ],
    )
  } finally {
    await host.dispose()
  }
})

test('工作流库动作全链路：save 真实写入 → list 携带文件事实 → get 只读源码 → delete 后 404', { timeout: 60_000 }, async () => {
  const host = makeHost()
  const { createWorkflowPlugin } = await import('../src/workflow.js')
  await host.register(createWorkflowPlugin())
  const script = 'export const meta = { name: "release", description: "发布流程" }\nreturn 1'
  try {
    // save：真实写入并返回真实摘要。
    const saved = (await host.invokeAction(WORKFLOW_PLUGIN_ID, 'save', { script })) as {
      created: boolean
      workflow: { name: string; updatedAt: number; size: number; description?: string }
    }
    assert.equal(saved.created, true)
    assert.equal(saved.workflow.name, 'release')
    assert.equal(saved.workflow.description, '发布流程')
    assert.ok(saved.workflow.updatedAt > 0 && saved.workflow.size > 0)

    // 重复保存：动作边界透传 409 workflow_already_exists。
    await assert.rejects(
      () => host.invokeAction(WORKFLOW_PLUGIN_ID, 'save', { script }),
      (err: unknown) => err instanceof HelmxError && err.code === 'workflow_already_exists',
    )

    // inputSchema 边界：未知字段拒绝（additionalProperties: false）。
    await assert.rejects(
      () => host.invokeAction(WORKFLOW_PLUGIN_ID, 'save', { script, bogus: 1 }),
      (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
    )

    // list：文件事实进入摘要。
    const listed = (await host.invokeAction(WORKFLOW_PLUGIN_ID, 'list', {})) as {
      workflows: Array<{ name: string; updatedAt: number; size: number }>
    }
    assert.equal(listed.workflows.length, 1)
    assert.equal(listed.workflows[0]!.name, 'release')
    assert.ok(listed.workflows[0]!.updatedAt > 0 && listed.workflows[0]!.size > 0)

    // get：完整只读源码。
    const detail = (await host.invokeAction(WORKFLOW_PLUGIN_ID, 'get', { name: 'release' })) as {
      workflow: { name: string; script: string }
    }
    assert.equal(detail.workflow.name, 'release')
    assert.equal(detail.workflow.script, script)

    await assert.rejects(
      () => host.invokeAction(WORKFLOW_PLUGIN_ID, 'get', { name: 'nope' }),
      (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
    )

    // delete：删除定义；再删 404；list 回空。
    const removed = (await host.invokeAction(WORKFLOW_PLUGIN_ID, 'delete', { name: 'release' })) as {
      deleted: boolean
      name: string
    }
    assert.equal(removed.deleted, true)
    assert.equal(removed.name, 'release')
    await assert.rejects(
      () => host.invokeAction(WORKFLOW_PLUGIN_ID, 'delete', { name: 'release' }),
      (err: unknown) => err instanceof HelmxError && err.code === 'not_found',
    )
    const after = (await host.invokeAction(WORKFLOW_PLUGIN_ID, 'list', {})) as { workflows: unknown[] }
    assert.deepEqual(after.workflows, [])
  } finally {
    await host.dispose()
  }
})

test('Workflow DSL resolveActionId 拦截 visibility=ui/internal（全限定与短 id 均 403 action_visibility_forbidden）', { timeout: 60_000 }, () => {
  const host = {
    listActions: () => [
      {
        pluginId: 'builtin:worktree',
        id: 'acquire_worktree',
        description: 'internal',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        visibility: 'internal' as const,
      },
      {
        pluginId: 'builtin:tiers',
        id: 'replace',
        description: 'ui replace',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        visibility: 'ui' as const,
      },
      {
        pluginId: 'builtin:demo',
        id: 'shared_name',
        description: 'public shared',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        visibility: 'public' as const,
      },
      {
        pluginId: 'builtin:hidden',
        id: 'shared_name',
        description: 'internal shared',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        visibility: 'internal' as const,
      },
    ],
  } as unknown as Parameters<typeof resolveActionId>[0]

  // Qualified and bare short IDs for internal / ui actions reject with 403 action_visibility_forbidden
  for (const blocked of [
    'builtin:worktree.acquire_worktree',
    'acquire_worktree',
    'builtin:tiers.replace',
    'replace',
    'builtin:hidden.shared_name',
  ]) {
    assert.throws(
      () => resolveActionId(host, blocked),
      (err: unknown) => err instanceof HelmxError && err.code === 'action_visibility_forbidden' && err.status === 403,
      `Workflow DSL must reject ${blocked}`,
    )
  }

  // Bare short ID resolves to the single public action without false ambiguity from an internal peer
  assert.deepEqual(resolveActionId(host, 'shared_name'), {
    pluginId: 'builtin:demo',
    actionId: 'shared_name',
  })
  assert.deepEqual(resolveActionId(host, 'builtin:demo.shared_name'), {
    pluginId: 'builtin:demo',
    actionId: 'shared_name',
  })
})
