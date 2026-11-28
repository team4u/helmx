/**
 * 工作流历史列表完整性回归（tsx --test；真实 WorkflowService + 注入故障的 KV store）。
 *
 * 覆盖：
 * 1. KV RunHeader 形状非法（非对象 / id 失配 / status 或 phase 越界 / 必需字段缺失 / settledAt / errorCode 非法）
 *    → listRuns / getRun 显式 workflow_record_corrupt（500），绝不返回少项或伪摘要；
 * 2. RunDetail 文件损坏（非 JSON / 非对象 / id 失配）→ getRun / inspect 显式 workflow_record_corrupt（500）；
 * 3. KV list() 抛错（IO 故障）→ 显式 workflow_index_corrupt（500），不吞；
 * 4. 正常路径不受影响：活跃 run 实时列出、终态 run 跨重启列出、活跃与历史去重、createdAt 倒序、getRun 404 保持；
 * 5. HTTP 层可见故障（createHubHandler + 真 AuthService）：runs / inspect 损坏返回 500；
 * 6. CLI 层非零退出（真 createHelmx + port 0 Hub + tsx 子进程真 CLI）：helmx workflows runs 在损坏时 exitCode !== 0。
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it, test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { HelmxError } from '@helmx/protocol'
import {
  createMemoryKvStore,
  WorkflowService,
  type RunDetail,
  type RunHeader,
  type WorkflowKvStore,
  type WorkflowServiceHost,
} from '../src/workflow/runs/index.js'
import {
  AuthService,
  createHubHandler,
  PluginHost,
  startHub,
  type HttpEventHub,
  type KernelHttpTarget,
  type PluginHostBackend,
  type PluginSessionDocStore,
} from '@helmx/kernel'
import { createHelmx } from '../../hub/src/app.js'
import { createWorkflowPlugin } from '../src/workflow.js'
import { createPluginHostBackendFixture } from '../../kernel/test/helpers/plugin-host-backend.js'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { deferred, makeFauxProvider, MemoryKvStore } from './helpers/plugin-test-env.js'

const timeout = { timeout: 60_000 } as const

function detailFileOf(dataDir: string, runId: string, conversationId = 1): string {
  return join(dataDir, 'artifacts', String(conversationId), `wf-${runId}.detail.json`)
}

function pluginEngineDataDir(hostDataDir: string): string {
  return join(hostDataDir, 'plugins', 'builtin%3Aworkflow')
}

const memorySessionDocData = new Map<string, string>()
const memorySessionDocs: PluginSessionDocStore = {
  get(pluginId, name, conversationId) { return memorySessionDocData.get(`${pluginId}\0${name}\0${conversationId}`) },
  put(pluginId, name, conversationId, valueJson) { memorySessionDocData.set(`${pluginId}\0${name}\0${conversationId}`, valueJson) },
  delete(pluginId, name, conversationId) { memorySessionDocData.delete(`${pluginId}\0${name}\0${conversationId}`) },
  deletePlugin(pluginId) {
    const prefix = `${pluginId}\0`
    for (const k of [...memorySessionDocData.keys()]) {
      if (k.startsWith(prefix)) memorySessionDocData.delete(k)
    }
  },
  listConversationIds(pluginId, name) {
    return [...memorySessionDocData.keys()]
      .filter((k) => k.startsWith(`${pluginId}\0${name}\0`))
      .map((k) => Number(k.split('\0')[2]))
      .sort((a, b) => a - b)
  },
  async flush() {},
}

const META = (name: string) => `export const meta = { name: "${name}", description: "test" }\n`

function conversationSummary(id: number) {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [] as string[],
    cwd: '/tmp',
    model: 'x/y',
    thinkingLevel: '',
    status: 'idle' as const,
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 0,
    updatedAt: 0,
  }
}

function makeServiceHost(): WorkflowServiceHost {
  return {
    async spawnAgent() {
      return 'text'
    },
    async invokeAction() {
      throw new Error('no actions in this host')
    },
    listActions() {
      return []
    },
    getConversation: (id: number) => conversationSummary(id),
    async abortConversationGuarded() {},
    emitEvent() {},
  }
}

async function runTwoSettledRuns(dataDir: string, kv: WorkflowKvStore<RunHeader>): Promise<{ service: WorkflowService; ids: string[] }> {
  const service = new WorkflowService({ dataDir, host: makeServiceHost(), kv })
  const first = await service.run({ conversationId: 1, script: META('hist-int-1') + 'return 1' })
  await service.wait(first.id)
  const second = await service.run({ conversationId: 1, script: META('hist-int-2') + 'return 2' })
  await service.wait(second.id)
  return { service, ids: [first.id, second.id] }
}

function makeValidHeader(over: Record<string, unknown> = {}): RunHeader {
  return {
    id: 'wf_aaaaaaaaaaaa',
    kind: 'workflow',
    name: 'valid',
    conversationId: 1,
    status: 'completed',
    phase: 'settled',
    createdAt: 1,
    updatedAt: 1,
    journalPath: '/tmp/wf_aaaaaaaaaaaa.jsonl',
    ...over,
  } as RunHeader
}

// ---------------------------------------------------------------------------
// service 层：KV Header & RunDetail 损坏边界显式失败
// ---------------------------------------------------------------------------

describe('WorkflowService listRuns integrity', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-list-int-'))

  after(() => rmSync(dataDir, { recursive: true, force: true }))

  it('normal path: active + settled runs, restart, dedupe, createdAt desc, getRun 404 preserved', timeout, async (t) => {
    const kv = createMemoryKvStore<RunHeader>()
    const { service } = await runTwoSettledRuns(dataDir, kv)
    const ready = deferred()
    const resume = deferred()
    const host = makeServiceHost()
    const realSpawn = host.spawnAgent.bind(host)
    host.spawnAgent = async (request) => {
      ready.resolve()
      await resume.promise
      return realSpawn(request)
    }
    const activeService = new WorkflowService({ dataDir, host, kv })
    t.after(async () => {
      resume.resolve()
      await activeService.close()
      await service.close()
    }, { timeout: 60_000 })
    const active = await activeService.run({ conversationId: 1, script: META('hist-int-active') + 'return await agent("hang")' })
    await ready.promise
    let runs = activeService.listRuns()
    assert.equal(runs.length, 3, 'active + two settled runs all listed')
    for (let i = 1; i < runs.length; i++) {
      assert.ok(runs[i - 1]!.createdAt >= runs[i]!.createdAt, `desc order broken at ${i}`)
    }
    resume.resolve()
    await activeService.wait(active.id)
    runs = activeService.listRuns()
    assert.equal(runs.filter((r) => r.id === active.id).length, 1, 'no duplicate after settle')

    const revived = new WorkflowService({ dataDir, host: makeServiceHost(), kv })
    const revivedRuns = revived.listRuns()
    assert.equal(revivedRuns.length, 3, 'runs survive restart via KV store')

    assert.throws(
      () => revived.getRun('wf_nosuchrun0000'),
      (error: unknown) => {
        assert.ok(error instanceof HelmxError)
        assert.equal(error.code, 'not_found')
        assert.equal(error.status, 404)
        return true
      },
    )
    await revived.close()
  })

  it('KV header shape violations (non-object / id mismatch / bad fields) fail as workflow_record_corrupt', timeout, async () => {
    const cases: Array<{ name: string; key: string; value: unknown; wantProblem: string }> = [
      { name: 'null header', key: 'wf_null00000001', value: null, wantProblem: 'not an object' },
      { name: 'array header', key: 'wf_arr000000001', value: [], wantProblem: 'not an object' },
      { name: 'id mismatch', key: 'wf_expected0001', value: makeValidHeader({ id: 'wf_other0000001' }), wantProblem: 'id mismatch' },
      { name: 'missing name', key: 'wf_noname000001', value: makeValidHeader({ id: 'wf_noname000001', name: undefined }), wantProblem: 'name invalid' },
      { name: 'bad conversationId', key: 'wf_badconv00001', value: makeValidHeader({ id: 'wf_badconv00001', conversationId: 0 }), wantProblem: 'conversationId invalid' },
      { name: 'bad status', key: 'wf_badstat00001', value: makeValidHeader({ id: 'wf_badstat00001', status: 'weird' }), wantProblem: 'status invalid' },
      { name: 'bad phase', key: 'wf_badphase0001', value: makeValidHeader({ id: 'wf_badphase0001', phase: 'bogus' }), wantProblem: 'phase invalid' },
      { name: 'bad createdAt', key: 'wf_badcat000001', value: makeValidHeader({ id: 'wf_badcat000001', createdAt: 'soon' }), wantProblem: 'createdAt invalid' },
      { name: 'bad updatedAt', key: 'wf_baduat000001', value: makeValidHeader({ id: 'wf_baduat000001', updatedAt: null }), wantProblem: 'updatedAt invalid' },
      { name: 'bad settledAt', key: 'wf_badsat000001', value: makeValidHeader({ id: 'wf_badsat000001', settledAt: -5 }), wantProblem: 'settledAt invalid' },
      { name: 'bad errorCode', key: 'wf_badec0000001', value: makeValidHeader({ id: 'wf_badec0000001', errorCode: 123 }), wantProblem: 'errorCode invalid' },
    ]
    for (const c of cases) {
      const kv = createMemoryKvStore<RunHeader>()
      kv.set(c.key, c.value as RunHeader)
      const service = new WorkflowService({ dataDir, host: makeServiceHost(), kv })
      assert.throws(
        () => service.listRuns(),
        (error: unknown) => {
          assert.ok(error instanceof HelmxError, `[${c.name}] expect HelmxError`)
          assert.equal(error.code, 'workflow_record_corrupt', c.name)
          assert.equal(error.status, 500, c.name)
          assert.ok(error.message.includes(c.wantProblem), `[${c.name}] ${error.message}`)
          return true
        },
      )
      await service.close()
    }
  })

  it('global createdAt desc order: two actives straddle a newer settled run; dedupe holds', timeout, async (t) => {
    const kv = createMemoryKvStore<RunHeader>()
    const host = makeServiceHost()
    const ready = [deferred(), deferred()]
    const resume = [deferred(), deferred()]
    const realSpawn = host.spawnAgent.bind(host)
    let hangSlot = 0
    host.spawnAgent = async (request) => {
      const slot = hangSlot++
      ready[slot]!.resolve()
      await resume[slot]!.promise
      return realSpawn(request)
    }
    const service = new WorkflowService({ dataDir, host, kv })
    t.after(async () => {
      for (const gate of resume) gate.resolve()
      await service.close()
    }, { timeout: 60_000 })
    const olderActive = await service.run({ conversationId: 1, script: META('ord-a') + 'return await agent("hang-a")' })
    await ready[0]!.promise
    const settled = await service.run({ conversationId: 1, script: META('ord-mid') + 'return 1' })
    await service.wait(settled.id)
    const newerActive = await service.run({ conversationId: 1, script: META('ord-b') + 'return await agent("hang-b")' })
    await ready[1]!.promise

    const runs = service.listRuns()
    assert.deepEqual(runs.map((r) => r.id), [newerActive.id, settled.id, olderActive.id])
    for (const gate of resume) gate.resolve()
    await service.wait(olderActive.id)
    await service.wait(newerActive.id)
    const final = service.listRuns()
    assert.deepEqual(final.map((r) => r.id), [newerActive.id, settled.id, olderActive.id])
  })

  it('detail file corruption (invalid JSON / non-object / id mismatch) fails getRun as workflow_record_corrupt; listRuns stays zero-IO', timeout, async () => {
    const kv = createMemoryKvStore<RunHeader>()
    const { service, ids } = await runTwoSettledRuns(dataDir, kv)
    const victim = ids[0]!
    await service.close()

    // 1) 无效 JSON
    writeFileSync(detailFileOf(dataDir, victim), 'garbage', 'utf8')
    const s1 = new WorkflowService({ dataDir, host: makeServiceHost(), kv })
    // listRuns 仅读内存 RunHeader，零磁盘 I/O
    assert.equal(s1.listRuns().length, 2)
    assert.throws(
      () => s1.getRun(victim),
      (error: unknown) => error instanceof HelmxError && error.code === 'workflow_record_corrupt',
    )
    await s1.close()

    // 2) 合法 JSON 但非对象（数组）
    writeFileSync(detailFileOf(dataDir, victim), '[]', 'utf8')
    const s2 = new WorkflowService({ dataDir, host: makeServiceHost(), kv })
    assert.throws(
      () => s2.getRun(victim),
      (error: unknown) => error instanceof HelmxError && error.code === 'workflow_record_corrupt',
    )
    await s2.close()

    // 3) id 不符
    writeFileSync(detailFileOf(dataDir, victim), JSON.stringify({ id: 'wf_someother9999' }), 'utf8')
    const s3 = new WorkflowService({ dataDir, host: makeServiceHost(), kv })
    assert.throws(
      () => s3.getRun(victim),
      (error: unknown) => error instanceof HelmxError && error.code === 'workflow_record_corrupt',
    )
    await s3.close()
  })

  it('KV list() throwing surfaces as explicit workflow_index_corrupt; listActiveRuns zero KV reads', timeout, async () => {
    const inner = createMemoryKvStore<RunHeader>()
    const { service, ids } = await runTwoSettledRuns(dataDir, inner)
    const victim = ids[0]!
    await service.close()

    let listCalls = 0
    const trackedKv: WorkflowKvStore<RunHeader> = {
      ...inner,
      list(opts) {
        listCalls++
        return inner.list(opts)
      },
    }
    const cleanSvc = new WorkflowService({ dataDir, host: makeServiceHost(), kv: trackedKv })
    assert.deepEqual(cleanSvc.listActiveRuns(), [])
    assert.equal(listCalls, 0, 'listActiveRuns 不得触碰 KV')
    assert.equal(cleanSvc.listRuns().length, 2)
    assert.equal(listCalls, 1, 'listRuns 一次 hydrate 缓存')
    await cleanSvc.close()

    const failingKv: WorkflowKvStore<RunHeader> = {
      ...inner,
      list() {
        throw new Error('simulated KV read failure')
      },
    }
    const failingSvc = new WorkflowService({ dataDir, host: makeServiceHost(), kv: failingKv })
    assert.throws(
      () => failingSvc.listRuns(),
      (error: unknown) =>
        error instanceof HelmxError &&
        error.code === 'workflow_index_corrupt' &&
        error.status === 500 &&
        error.message.includes('simulated KV read failure'),
    )
    assert.throws(
      () => failingSvc.getRun(victim),
      (error: unknown) => error instanceof HelmxError && error.code === 'workflow_index_corrupt',
    )
    await failingSvc.close()
  })

  it('restart (init) over corrupt KV header blocks recovery explicitly (no silent skip)', timeout, async () => {
    const kv = createMemoryKvStore<RunHeader>()
    kv.set('wf_corrupt_init01', { id: 'wf_corrupt_init01', status: 'bogus' } as unknown as RunHeader)
    const revived = new WorkflowService({ dataDir, host: makeServiceHost(), kv })
    await assert.rejects(() => revived.init(), (error: unknown) => {
      assert.ok(error instanceof HelmxError)
      assert.equal(error.code, 'workflow_record_corrupt')
      return true
    })
    assert.equal(kv.list().items.length, 1, 'corrupt KV row is not silently deleted')
    await revived.close()
  })
})

// ---------------------------------------------------------------------------
// HTTP 层：编排经 builtin:workflow 插件动作（/api/actions）
// ---------------------------------------------------------------------------

class NoopEventHub implements HttpEventHub {
  response(): Response {
    return new Response(null, { status: 204 })
  }
}

function makeBackend(): PluginHostBackend {
  return {
    ...createPluginHostBackendFixture(),
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async () => ({}) as never,
    listConversations: () => [],
    getConversation: () => ({}) as never,
    updateConversation: async () => ({}) as never,
    abortConversationGuarded: async () => {},
    getConversationOwnership: () => 'human' as const,
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    execEnv: async () => { throw new HelmxError('unsupported', '本 fixture 不执行节点命令', 501) },
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    createAsk: async () => ({}) as never,
    cancelAsk: async () => {},
    onEvent: () => () => {},
    emitEvent: () => {},
  }
}

describe('workflow listRuns failure visibility over HTTP (plugin actions)', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-http-int-'))
  let auth: AuthService
  let token: string

  before(async () => {
    auth = new AuthService(dataDir)
    const handler = createHubHandler(
      {
        dataDir,
        auth,
        events: new NoopEventHub(),
        plugins: new PluginHost({
          buildProvider: createPluginBuildProvider(),
          dataDir,
          host: makeBackend(),
          kv: new MemoryKvStore(),
          docs: { get: <T>(_k: string, initial: T): T => initial, set: () => {}, deletePlugin: () => {}, flush: async () => {} },
        }),
      } as unknown as KernelHttpTarget,
    )
    const res = await handler(
      new Request('http://127.0.0.1/api/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'integration-test-password' }),
      }),
    )
    assert.equal(res.status, 200)
    token = ((await res.json()) as { token: string }).token
  })

  after(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('POST /api/actions/.../runs returns 500 workflow_record_corrupt on corrupt KV row, never a short 200 list', timeout, async () => {
    const kv = new MemoryKvStore()
    kv.put('builtin:workflow', 'runs', 'wf_http_bad00001', JSON.stringify({ id: 'wf_http_bad00001', status: 'weird' }))
    const host = new PluginHost({
      buildProvider: createPluginBuildProvider(),
      dataDir: join(dataDir, 'corrupt-kv-plugins'),
      host: makeBackend(),
      kv,
      deferServices: true,
      docs: { get: <T>(_k: string, initial: T): T => initial, set: () => {}, deletePlugin: () => {}, flush: async () => {} },
      sessionDocs: memorySessionDocs,
    })
    await host.register(createWorkflowPlugin())
    const handler = createHubHandler(
      { dataDir, auth, events: new NoopEventHub(), plugins: host } as unknown as KernelHttpTarget,
    )
    const res = await handler(
      new Request('http://127.0.0.1/api/actions/builtin%3Aworkflow/runs', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ input: {} }),
      }),
    )
    assert.equal(res.status, 500)
    const body = (await res.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'workflow_record_corrupt')
    await host.dispose()
  })

  it('inspect action for a corrupt detail file returns 500 workflow_record_corrupt (404 kept for missing)', timeout, async () => {
    const pluginDataDir = join(dataDir, 'corrupt-detail-plugins')
    const engineDir = pluginEngineDataDir(pluginDataDir)
    const kv = new MemoryKvStore()
    const victim = 'wf_http_detail01'
    kv.put('builtin:workflow', 'runs', victim, JSON.stringify(makeValidHeader({ id: victim, journalPath: join(engineDir, 'artifacts', '1', `workflow-${victim}.jsonl`) })))
    mkdirSync(join(engineDir, 'artifacts', '1'), { recursive: true })
    writeFileSync(detailFileOf(engineDir, victim), '{bad-json', 'utf8')

    const host = new PluginHost({
      buildProvider: createPluginBuildProvider(),
      dataDir: pluginDataDir,
      host: makeBackend(),
      kv,
      docs: { get: <T>(_k: string, initial: T): T => initial, set: () => {}, deletePlugin: () => {}, flush: async () => {} },
      sessionDocs: memorySessionDocs,
    })
    await host.register(createWorkflowPlugin())
    const handler = createHubHandler(
      { dataDir, auth, events: new NoopEventHub(), plugins: host } as unknown as KernelHttpTarget,
    )
    const corrupt = await handler(
      new Request('http://127.0.0.1/api/actions/builtin%3Aworkflow/inspect', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ input: { runId: victim } }),
      }),
    )
    assert.equal(corrupt.status, 500)
    const corruptBody = (await corrupt.json()) as { error: { code: string } }
    assert.equal(corruptBody.error.code, 'workflow_record_corrupt')

    const missing = await handler(
      new Request('http://127.0.0.1/api/actions/builtin%3Aworkflow/inspect', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ input: { runId: 'wf_nosuchrun0000' } }),
      }),
    )
    assert.equal(missing.status, 404)
    await host.dispose()
  })
})

// ---------------------------------------------------------------------------
// CLI 层：真 createHelmx + port 0 Hub + tsx 子进程真 CLI，非零退出可见
// ---------------------------------------------------------------------------

const testDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(testDir, '..', '..', '..')
const distCliEntry = join(repoRoot, 'packages', 'cli', 'dist', 'index.js')
const cliUseDist = existsSync(distCliEntry) && existsSync(join(repoRoot, 'packages', 'protocol', 'dist', 'index.js'))
const cliEntry = join(repoRoot, 'packages', 'cli', 'src', 'index.ts')
const require = createRequire(import.meta.url)
const tsxCli = cliUseDist ? '' : require.resolve('tsx/cli')

function runCliChild(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      cliUseDist ? [distCliEntry, ...args] : [tsxCli, cliEntry, ...args],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: null, out, err })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  })
}

test('CLI: helmx workflows inspect 在 detail 损坏时非零退出并显示错误码（真 Hub + 真 CLI 子进程）', timeout, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-wf-cli-int-'))
  const faux = makeFauxProvider()
  const app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir, cwd: dataDir, model: 'faux/faux-1', providers: [faux.provider] })
  let app2: Awaited<ReturnType<typeof createHelmx>> | undefined
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  let procToken: { token: string; dispose(): void } | undefined
  try {
    const conversationId = app.kernel.conversations.listConversations()[0]!.id
    await app.kernel.plugins.invokeAction('builtin:workflow', 'run', { script: META('cli-int-1') + 'return 1', wait: true }, { conversationId })
    await app.kernel.plugins.invokeAction('builtin:workflow', 'run', { script: META('cli-int-2') + 'return 2', wait: true }, { conversationId })
    const runsList = (await app.kernel.plugins.invokeAction('builtin:workflow', 'runs', {})) as { runs: Array<{ id: string }> }
    assert.equal(runsList.runs.length, 2)
    const victim = runsList.runs[0]!.id
    await app.close()

    // 破坏磁盘上的 detail 文件再重启（绕过内存 LRU）
    let detailFile = ''
    const locate = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === `wf-${victim}.detail.json`) detailFile = join(dir, entry.name)
        else if (entry.isDirectory() && entry.name !== 'cli-home') locate(join(dir, entry.name))
      }
    }
    locate(dataDir)
    assert.ok(detailFile !== '', `detail file must exist under dataDir (runId=${victim})`)
    writeFileSync(detailFile, '{corrupt', 'utf8')

    app2 = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir, cwd: dataDir, model: 'faux/faux-1', providers: [faux.provider] })
    hub = await startHub({ kernel: app2.kernel as never, port: 0 })
    procToken = app2.kernel.auth.createProcessToken()
    const userToken = procToken.token

    const healthy = await runCliChild(['workflows', 'runs', '--json'], {
      ...process.env,
      HELMX_HUB_URL: hub.url,
      HELMX_DATA_DIR: join(dataDir, 'cli-home'),
      HELMX_TOKEN: userToken,
    })
    assert.equal(healthy.code, 0, `listRuns stays healthy over KV headers: ${healthy.err}`)
    assert.equal((JSON.parse(healthy.out) as { runs: unknown[] }).runs.length, 2)

    const broken = await runCliChild(['workflows', 'inspect', victim, '--json'], {
      ...process.env,
      HELMX_HUB_URL: hub.url,
      HELMX_DATA_DIR: join(dataDir, 'cli-home'),
      HELMX_TOKEN: userToken,
    })
    assert.notEqual(broken.code, 0, 'corrupt detail must make CLI exit non-zero')
    assert.ok(broken.err.includes('workflow_record_corrupt'), `stderr should carry error code: ${broken.err}`)
    assert.ok(broken.err.includes(victim), `stderr should name runId: ${broken.err}`)
  } finally {
    procToken?.dispose()
    await hub?.close()
    await app2?.close().catch(() => {})
    await app.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})
