/**
 * builtin:magpie 独立验收测试。
 *
 * 组合纪律：真实 PluginHost + 真实 providers 挂载端口（service.start 前
 * 注册 / stop 后注销，与 runtime 相同生命周期）+ 真实 pi-ai Models
 * （createModels）；零参工厂（无 DI 后门）：网络经 mock.method(globalThis,
 * 'fetch')（结束恢复），绝不触真实外网 / 真实 magpie。
 *
 * 诚实性重点用例：
 * - provider.refreshModels 网络失败一律 throw → models.refresh errors['magpie']
 *   显式可见（绝不静默 errors:{} 弹「刷新成功」）；
 * - 切换网关后旧 root 缓存绝不冒充新网关目录（servedByRoot 过滤 +
 *   sameGateway 发布守卫：fetch 期间切 root 的挂起结果不发布）；
 * - auth.resolve 冻结 root+token 同一快照（env 携带 MAGPIE_GW_URL）；
 * - reachable:false 时 modelCount 保留缓存计数但 summary 不称已连接；
 * - 配额读取失败不吞：diagnostics 明确记录不可用原因；
 * - turn_settled 只对 magpie/ 模型会话触发侧读，不阻塞结算。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁；命令加总超时。
 */
import { mock, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createModels } from '@earendil-works/pi-ai/models'
import type { Provider } from '@earendil-works/pi-ai'
import { COMPOSER_STATUS_SLOT, HelmxError, redactJsonValue, resolveLocalizedText, type ConversationSummary } from '@helmx/protocol'
import { quotaRows } from '../src/magpie/quota.js'
import { MAGPIE_COL_PROVIDER } from '../src/magpie/client/copy.js'
import {
  PluginHost,
  type PluginHostBackend,
  type PluginProviderPort,
} from '../../kernel/src/plugins/index.js'
import { hostBackendStub } from '../../kernel/test/helpers/host-backend-stub.js'
import { createMagpiePlugin } from '../src/magpie.js'
import { compilePluginClientModule, createPluginBuildProvider } from '@helmx/plugin-build'
import {
  MemoryConfigStore,
  MemoryDocStore,
  deferred,
  makeConversationSummary,
  waitFor as baseWaitFor,
} from './helpers/plugin-test-env.js'
import {
  MAGPIE_PLUGIN_ID,
  MAGPIE_PROVIDER_ID,
  DEFAULT_MAGPIE_ROOT,
  DEFAULT_MAGPIE_TOKEN,
} from '../src/magpie/contracts.js'
import {
  DEFAULT_CONTEXT_WINDOW,
  magpieApi,
  toPiModels,
  adaptiveThinking,
  thinkingLevelMap,
} from '../src/magpie/catalog.js'
import { normalizeRoot, isLoopback, isLoopbackConnectionError, resolveGateway } from '../src/magpie/gateway.js'

const MAGPIE = MAGPIE_PLUGIN_ID

// ---------------------------------------------------------------------------
// 测试样本数据
// ---------------------------------------------------------------------------

const CATALOG = {
  data: [
    { id: 'openai/gpt-5.2', display_name: 'GPT-5.2', native_endpoints: ['/v1/responses'], reasoning: true, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }], context_length: 400_000, max_output_tokens: 128_000 },
    { id: 'anthropic/claude-sonnet-4.6', display_name: 'Claude Sonnet 4.6', native_endpoints: ['/v1/messages'], reasoning: true, supported_reasoning_levels: [{ effort: 'none' }, { effort: 'low' }, { effort: 'high' }], context_window: 200_000, max_output_tokens: 64_000 },
    { id: 'anthropic/claude-sonnet-4.5', native_endpoints: ['/v1/messages'], reasoning: true },
    { id: 'kimi/k2-chat', display_name: 'Kimi K2', native_endpoints: [], modalities: { input: ['text', 'image'] } },
    { id: 'group/relay', native_endpoints: [], owned_by: 'opencode-go' },
  ],
}

const QUOTAS = {
  data: [
    {
      provider: 'opencode-go', name: 'OpenCode Go', kind: 'subscription', plan: 'plus', user: 'user@example.com',
      windows: [{ name: '5h', remaining: 16, resetsAt: new Date(Date.now() + 3 * 3600_000).toISOString() }],
    },
    { provider: 'moonshot', name: 'Moonshot', windows: [{ name: 'daily', used: 40 }] },
  ],
}

// ---------------------------------------------------------------------------
// 受控网络（mock.method(globalThis,'fetch')，结束恢复）
// ---------------------------------------------------------------------------

interface FakeBackend {
  models?: unknown
  quotas?: unknown
  failModels?: string
  failQuotas?: string
  /** 挂起 models 请求（等待 gate 释放）：验证切 root 后旧结果不发布。 */
  gateModels?: Promise<void>
}

/** mock globalThis.fetch：按 origin 分发受控后端（未知 origin 显式 unreachable）。 */
function installFetchMock(backends: Map<string, FakeBackend>): { calls: string[]; restore(): void } {
  const calls: string[] = []
  const impl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    calls.push(url)
    const parsed = new URL(url)
    const backend = backends.get(parsed.origin)
    const path = parsed.pathname
    if (backend === undefined) throw new TypeError(`fetch failed: ${parsed.origin} unreachable`)
    if (path === '/v1/models') {
      if (backend.gateModels) await backend.gateModels
      if (backend.failModels) throw new Error(backend.failModels)
      return new Response(JSON.stringify(backend.models ?? { data: [] }), { status: 200 })
    }
    if (path === '/v1/magpie/quotas') {
      if (backend.failQuotas) throw new Error(backend.failQuotas)
      return new Response(JSON.stringify(backend.quotas ?? { data: [] }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }
  const mocked = mock.method(globalThis, 'fetch', impl)
  return { calls, restore: () => mocked.mock.restore() }
}

// ---------------------------------------------------------------------------
// 测试基建：真实 providers 端口（挂载即 setProvider，卸载即 deleteProvider）
// ---------------------------------------------------------------------------

/** 真实端口实现：与 runtime 相同语义（register→unregister，禁止伪造）。 */
class ModelsProviderPort implements PluginProviderPort {
  constructor(private readonly models: ReturnType<typeof createModels>) {}
  async register(provider: Provider, _pluginId: string): Promise<() => Promise<void>> {
    this.models.setProvider(provider)
    return async () => {
      this.models.deleteProvider(provider.id)
    }
  }
}

const makeConversation = (id: number, model = 'test/model'): ConversationSummary =>
  makeConversationSummary({ id, profileId: 'default', model })

function makeHostApi(overrides: Partial<PluginHostBackend> = {}): PluginHostBackend {
  return {
    ...hostBackendStub(),
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async (init) => ({ ...makeConversation(42), title: init.title ?? 'new' }),
    listConversations: () => [makeConversation(1)],
    getConversation: (id) => makeConversation(id),
    updateConversation: async (id) => makeConversation(id),
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    createAsk: async () => ({ id: 'ask-1', status: 'answered', answers: {} }),
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
    emitEvent: () => {},
    ...overrides,
  }
}

interface TestEnv {
  dataDir: string
  models: ReturnType<typeof createModels>
  fetchState: { calls: string[] }
  backends: Map<string, FakeBackend>
  refreshCalls: Array<{ providers?: string[]; allowNetwork?: boolean; force?: boolean }>
  host: PluginHost
  config: MemoryConfigStore
  docs: MemoryDocStore
  setRefreshError(error: string | undefined): void
  close(): Promise<void>
}

/** makeEnv 内部形态：close 在 host 构建后补挂（返回前已就位）。 */
interface TestEnvInit extends Omit<TestEnv, 'close'> {
  close?(): Promise<void>
}

async function makeEnv(options: { backendAtDefault?: FakeBackend; hostApi?: Partial<PluginHostBackend> } = {}): Promise<TestEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-magpie-test-'))
  const models = createModels()
  const backends = new Map<string, FakeBackend>([
    [new URL(DEFAULT_MAGPIE_ROOT).origin, options.backendAtDefault ?? { models: CATALOG, quotas: QUOTAS }],
  ])
  const fetchMock = installFetchMock(backends)
  const fetchCalls = fetchMock.calls
  const config = new MemoryConfigStore()
  const docs = new MemoryDocStore()
  const refreshResult: { errors: Record<string, string> } = { errors: {} }
  const env: TestEnvInit = {
    dataDir,
    models,
    backends,
    fetchState: { calls: fetchCalls },
    refreshCalls: [],
    config,
    docs,
    setRefreshError(error) {
      refreshResult.errors = error === undefined ? {} : { magpie: error }
    },
    host: undefined as unknown as PluginHost,
  }
  // 宿主 refreshModels 后端端口：真实 models.refresh({ providers:['magpie'] })
  // 同链路（记录调用 + 返回 errors 映射；注入式失败可覆盖）。
  const hostRefreshModels = async (opts?: { providers?: string[]; allowNetwork?: boolean; force?: boolean }) => {
    env.refreshCalls.push({ ...opts })
    if (Object.keys(refreshResult.errors).length > 0) {
      return { providers: opts?.providers ?? [], aborted: false, errors: { ...refreshResult.errors }, models: [], providerCatalog: [] }
    }
    const result = await models.refresh({
      allowNetwork: opts?.allowNetwork ?? true,
      force: opts?.force,
      providers: opts?.providers ?? [MAGPIE_PROVIDER_ID],
    })
    const errors: Record<string, string> = {}
    for (const [id, err] of result.errors) errors[id] = err instanceof Error ? err.message : String(err)
    return { providers: opts?.providers ?? [MAGPIE_PROVIDER_ID], aborted: result.aborted, errors, models: [], providerCatalog: [] }
  }
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(),
    dataDir,
    host: makeHostApi({
      refreshModels: hostRefreshModels as never,
      isClosing: () => false,
      ...options.hostApi,
    }),
    docs,
    config,
    providers: new ModelsProviderPort(models),
  })
  await host.register(
    createMagpiePlugin(),
    { enabled: false },
  )
  env.host = host
  env.close = async () => {
    try {
      await host.dispose()
    } finally {
      fetchMock.restore()
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
  return env as TestEnv
}

/** 等待谓词成立（轮询，默认 5s）。 */
const waitFor = (predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> =>
  baseWaitFor(predicate, { timeoutMs, message: 'waitFor 超时：条件在限定时间内未成立' })

interface StatusView {
  gatewayUrl: string; configuredRoot: boolean; local: boolean; reachable: boolean
  modelCount: number; summaryText: string; lastError?: string; lastRefreshedAt?: number
  quotasRefreshedAt?: number; quotasUpdatedAt?: number; quotasError?: string
  modelOwners: Record<string, string>
  quotas: Array<Record<string, unknown>>; diagnostics: string[]
}

const statusDoc = (env: TestEnv): StatusView =>
  env.host.getPublicDoc(MAGPIE, 'status').value as StatusView

let savedEnv: Array<[string, string | undefined]> = []

beforeEach(() => {
  savedEnv = []
  for (const name of ['MAGPIE_GW_URL', 'MAGPIE_ADDR']) {
    savedEnv.push([name, process.env[name]])
    delete process.env[name]
  }
})

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value !== undefined) process.env[name] = value
  }
})

// ---------------------------------------------------------------------------
// 1. catalog：协议分流 / thinkingLevelMap / adaptiveThinking
// ---------------------------------------------------------------------------

test('magpie1: magpieApi 协议分流与 baseUrl 挂点', { timeout: 60_000 }, () => {
  assert.deepEqual(magpieApi(['/v1/responses']), { api: 'openai-responses', endpoint: 'v1' })
  assert.deepEqual(magpieApi(['/v1/messages']), { api: 'anthropic-messages', endpoint: 'root' })
  assert.deepEqual(magpieApi([]), { api: 'openai-completions', endpoint: 'v1' })
  assert.deepEqual(magpieApi(undefined), { api: 'openai-completions', endpoint: 'v1' })
  assert.deepEqual(magpieApi(['/v1/messages', '/v1/responses']), { api: 'openai-responses', endpoint: 'v1' }, 'responses 优先')
})

test('magpie2: toPiModels 完整映射——api/baseUrl/thinkingLevelMap/forceAdaptiveThinking/ownedBy', { timeout: 60_000 }, () => {
  const root = 'http://127.0.0.1:3425'
  const models = toPiModels(CATALOG.data as never, root)
  const byId = new Map(models.map((m) => [m.id, m]))

  const gpt = byId.get('openai/gpt-5.2')!
  assert.equal(gpt.api, 'openai-responses')
  assert.equal(gpt.baseUrl, `${root}/v1`)
  assert.equal(gpt.reasoning, true)
  assert.deepEqual(gpt.thinkingLevelMap, { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null })

  const sonnet46 = byId.get('anthropic/claude-sonnet-4.6')!
  assert.equal(sonnet46.api, 'anthropic-messages')
  assert.equal(sonnet46.baseUrl, root, 'anthropic-messages 挂 root（SDK 自行加 /v1）')
  assert.deepEqual(
    sonnet46.thinkingLevelMap,
    { off: 'none', minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null },
    'Anthropic 有 none 档 → off 映射 none',
  )
  assert.deepEqual(sonnet46.compat, { forceAdaptiveThinking: true }, 'Claude 4.6+ 必须 forceAdaptiveThinking')

  const sonnet45 = byId.get('anthropic/claude-sonnet-4.5')!
  assert.equal(sonnet45.compat, undefined, 'Claude 4.5 不加 forceAdaptiveThinking')

  const kimi = byId.get('kimi/k2-chat')!
  assert.equal(kimi.api, 'openai-completions')
  assert.deepEqual(kimi.input, ['text', 'image'], 'modalities 透传')
  assert.equal(kimi.thinkingLevelMap, undefined, '无 reasoning levels 则无 map')

  const relay = byId.get('group/relay')!
  assert.equal(relay.magpieOwnedBy, 'opencode-go', 'owned_by 透传供配额归属')

  // 窗口来源诚实性：上游窗口为正数才标记已知；缺省兑底值不得冒充真实窗口。
  assert.equal(gpt.helmxContextWindowKnown, true, 'context_length 正数 → 已知窗口')
  assert.equal(gpt.contextWindow, 400_000)
  assert.equal(byId.get('anthropic/claude-sonnet-4.6')!.helmxContextWindowKnown, true, 'context_window 正数 → 已知窗口')
  for (const id of ['anthropic/claude-sonnet-4.5', 'kimi/k2-chat', 'group/relay']) {
    const model = byId.get(id)!
    assert.equal(model.helmxContextWindowKnown, false, `无上游窗口（${id}）必须标记未知`)
    assert.equal(model.contextWindow, DEFAULT_CONTEXT_WINDOW, '兑底值仍满足 pi-ai Model 契约')
  }
})

test('magpie3: thinkingLevelMap 边界——空档位 / Anthropic off 键语义', { timeout: 60_000 }, () => {
  assert.equal(thinkingLevelMap([], false), undefined)
  const map = thinkingLevelMap(['none', 'high'], true)!
  assert.equal(map.off, 'none', '有 none 档时 off → none')
  const mapNoNone = thinkingLevelMap(['high'], true)!
  assert.equal('off' in mapNoNone, false, 'Anthropic 无 none 档时 off 键删除（SDK 缺省发送禁用 thinking）')
})

test('magpie4: adaptiveThinking 版本判定', { timeout: 60_000 }, () => {
  assert.equal(adaptiveThinking('claude-sonnet-4.6'), true)
  assert.equal(adaptiveThinking('anthropic/claude-opus-4.6-x'), true)
  assert.equal(adaptiveThinking('claude-opus-5-5'), true)
  assert.equal(adaptiveThinking('claude-sonnet-4.5'), false)
  assert.equal(adaptiveThinking('gpt-5.2'), false)
})

// ---------------------------------------------------------------------------
// 2. gateway 配置解析
// ---------------------------------------------------------------------------

test('magpie5: resolveGateway 优先级 / configuredRoot 语义 / 非法显式 URL 显式报错', { timeout: 60_000 }, () => {
  const none = resolveGateway({}, {})
  assert.equal(none.root, DEFAULT_MAGPIE_ROOT)
  assert.equal(none.token, DEFAULT_MAGPIE_TOKEN)
  assert.equal(none.configuredRoot, false)
  assert.equal(none.local, true)

  // gatewayUrl 显式（即使值等于默认地址字符串）→ configuredRoot=true
  const explicitDefault = resolveGateway({ gatewayUrl: 'http://127.0.0.1:3425' }, {})
  assert.equal(explicitDefault.configuredRoot, true)

  // apiKey 显式（远端密钥）→ configuredRoot=true
  const keyOnly = resolveGateway({ apiKey: 'sk-remote' }, {})
  assert.equal(keyOnly.token, 'sk-remote')
  assert.equal(keyOnly.configuredRoot, true)

  // 环境变量
  const envOnly = resolveGateway({}, { MAGPIE_GW_URL: 'http://10.0.0.5:3425/' })
  assert.equal(envOnly.root, 'http://10.0.0.5:3425')
  assert.equal(envOnly.configuredRoot, true)
  assert.equal(envOnly.local, false)

  // 插件配置优先于环境变量
  const both = resolveGateway({ gatewayUrl: 'http://192.168.1.9:3425' }, { MAGPIE_GW_URL: 'http://10.0.0.5:3425' })
  assert.equal(both.root, 'http://192.168.1.9:3425')

  // 归一化
  assert.equal(normalizeRoot('http://h:1/v1/'), 'http://h:1')
  assert.equal(normalizeRoot('h:1'), 'http://h:1')
  assert.equal(normalizeRoot('not a url'), undefined)
  assert.equal(isLoopback('http://localhost:3425'), true)
  assert.equal(isLoopback('http://127.0.0.1:3425'), true)
  assert.equal(isLoopback('http://10.0.0.5:3425'), false)

  // 诚实性：非法显式 gatewayUrl / 非法环境变量显式报错，绝不静默回退默认
  assert.throws(
    () => resolveGateway({ gatewayUrl: 'not a url' }, {}),
    (err: unknown) => err instanceof HelmxError && err.code === 'magpie_invalid_gateway_url' && err.status === 400,
  )
  assert.throws(
    () => resolveGateway({}, { MAGPIE_GW_URL: '::bad::' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'magpie_invalid_gateway_url',
  )
  assert.throws(
    () => resolveGateway({}, { MAGPIE_ADDR: 'ftp://only' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'magpie_invalid_gateway_url',
    '非 http(s) scheme 同样显式拒绝',
  )
  // 无配置（全空）永不抛：默认回环是合法回落
  assert.equal(resolveGateway({}, {}).root, DEFAULT_MAGPIE_ROOT)
})

// ---------------------------------------------------------------------------
// 3. 真实宿主生命周期：providers 端口挂载 / 缺端口 501 / 默认停用不挂载
// ---------------------------------------------------------------------------

test('magpie6: 启用经 providers 端口挂载并拉取目录；停用后注销；baseUrl getter 跟随配置', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    assert.equal(env.host.list().find((p) => p.id === MAGPIE)!.enabled, false, '默认停用注册')
    assert.equal(env.models.getProvider('magpie'), undefined, '停用态 provider 不挂载（零副作用）')

    await env.host.enable(MAGPIE)
    const provider = env.models.getProvider('magpie')!
    assert.ok(provider, 'enable 经 providers 端口真实挂载（service.start 前）')
    await waitFor(() => env.models.getModels('magpie').length > 0)
    assert.equal(env.models.getModels('magpie').length, 5, '目录全量转换')

    const available = await env.models.getAvailable('magpie')
    assert.equal(available.length, 5, 'auth.check 恒有效 → available')

    // baseUrl getter 投影当前 root；切配置后即时跟随（无需重新挂载）
    assert.equal(provider.baseUrl, `${DEFAULT_MAGPIE_ROOT}/v1`)
    await env.host.setConfig(MAGPIE, { gatewayUrl: 'http://127.0.0.1:9999' })
    assert.equal(provider.baseUrl, 'http://127.0.0.1:9999/v1', 'baseUrl getter 动态投影新 root')
    await env.host.setConfig(MAGPIE, {})

    const actions = env.host.listActions().filter((a) => a.pluginId === MAGPIE).map((a) => a.id).sort()
    assert.deepEqual(actions, ['quota', 'refresh', 'status'])
    const uiItems = env.host.listUi().filter((u) => u.pluginId === MAGPIE)
    const surfaces = uiItems.map((u) => u.surface).sort()
    assert.deepEqual(surfaces, ['commandPalette', 'plugin.slot', 'settings.panel'])
    const statusSlot = uiItems.find((u) => u.surface === 'plugin.slot')
    assert.equal((statusSlot?.spec as { target?: string })?.target, COMPOSER_STATUS_SLOT)

    await waitFor(() => statusDoc(env).reachable === true)
    const doc = statusDoc(env)
    assert.equal(doc.modelCount, 5)
    assert.equal(doc.summaryText, 'Magpie · 5 models')
    assert.equal(doc.gatewayUrl, DEFAULT_MAGPIE_ROOT)
    assert.equal(doc.configuredRoot, false)
    assert.equal(JSON.stringify(doc).includes(DEFAULT_MAGPIE_TOKEN), false, 'token 不进 doc')

    await env.host.disable(MAGPIE)
    assert.equal(env.models.getProvider('magpie'), undefined, '停用后 provider 真实注销')
    assert.deepEqual(env.host.listActions().filter((a) => a.pluginId === MAGPIE), [])
    assert.throws(() => env.host.getPublicDoc(MAGPIE, 'status'), (e: unknown) => e instanceof HelmxError && e.code === 'plugin_doc_not_found')
  } finally {
    await env.close()
  }
})

test('magpie7: 宿主缺 providers 端口时启用显式 501（不静默降级）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-magpie-test-'))
  const backends = new Map<string, FakeBackend>()
  const fetchMock = installFetchMock(backends)
  try {
    const host = new PluginHost({ buildProvider: createPluginBuildProvider(),
      dataDir,
      host: makeHostApi({
        refreshModels: (async () => ({ providers: [], aborted: false, errors: {}, models: [], providerCatalog: [] })) as never,
      }),
      docs: new MemoryDocStore(),
      config: new MemoryConfigStore(),
    })
    await host.register(createMagpiePlugin(), { enabled: false })
    // 注册（停用探测）成功：只收集声明零挂载；启用阶段才显式拒绝
    assert.equal(host.list().find((p) => p.id === MAGPIE)!.enabled, false)
    await assert.rejects(
      () => host.enable(MAGPIE),
      (err: unknown) => {
        assert.ok(err instanceof HelmxError)
        assert.equal(err.code, 'provider_port_unavailable')
        assert.equal(err.status, 501)
        return true
      },
    )
    // 回滚后插件回到停用形态，可再次注册探测
    assert.equal(host.list().find((p) => p.id === MAGPIE)!.enabled, false)
    await host.dispose()
  } finally {
    fetchMock.restore()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. 动作契约
// ---------------------------------------------------------------------------

test('magpie8: 动作契约——status / refresh / quota（不含路由追踪动作）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true)

    const magpieActions = env.host.listActions().filter((a) => a.pluginId === MAGPIE)
    const actionIds = magpieActions.map((a) => a.id).sort()
    assert.deepEqual(actionIds, ['quota', 'refresh', 'status'], '只暴露 status / refresh / quota 三个动作')
    for (const action of magpieActions) {
      assert.equal(action.exposeToPrompt, false, `magpie.${action.id} 不常驻模型 <available_actions>`)
    }
    assert.equal(env.fetchState.calls.some((c) => c.includes('/v1/magpie/trace')), false, '启动与刷新绝不请求 /v1/magpie/trace')

    const status = (await env.host.invokeAction(MAGPIE, 'status', {})) as StatusView
    assert.equal(status.reachable, true)
    assert.ok(Array.isArray(status.quotas), '配额随目录刷新加载')
    assert.deepEqual(status.diagnostics, [], '配额可用时无诊断')

    const refreshed = (await env.host.invokeAction(MAGPIE, 'refresh', {})) as { refreshed: boolean; modelCount: number; reachable: boolean }
    assert.deepEqual(refreshed, { refreshed: true, modelCount: 5, reachable: true })

    const quota = (await env.host.invokeAction(MAGPIE, 'quota', {})) as { quotas: Array<{ provider: string; remainingPercent: number }>; local: boolean }
    assert.equal(quota.local, true)
    assert.equal(quota.quotas.length, 2)
    assert.equal(quota.quotas[0]!.provider, 'opencode-go')
    assert.equal(quota.quotas[0]!.remainingPercent, 16)
    assert.equal(quota.quotas[1]!.remainingPercent, 60, 'used 40 → remaining 60')

    const filtered = (await env.host.invokeAction(MAGPIE, 'quota', { model: 'magpie/group/relay' })) as { quotas: Array<{ provider: string }> }
    assert.deepEqual(filtered.quotas.map((q) => q.provider), ['opencode-go'], '按 modelOwners 主归属过滤配额')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 5. 诚实性纪律：失败显式 / 缓存与网关隔离 / 数据源隔离
// ---------------------------------------------------------------------------

test('magpie9: 显式配置网关失败——refresh 动作显式抛错（不静默）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.config.set(MAGPIE, { gatewayUrl: 'http://10.255.255.1:3425' })
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === false && statusDoc(env).lastError !== undefined)
    const doc = statusDoc(env)
    assert.equal(doc.configuredRoot, true)
    assert.equal(doc.gatewayUrl, 'http://10.255.255.1:3425')
    assert.ok(doc.lastError!.length > 0)

    await assert.rejects(
      () => env.host.invokeAction(MAGPIE, 'refresh', {}),
      (err: unknown) => err instanceof HelmxError && err.code === 'magpie_gateway_unreachable' && err.status === 502,
    )
    await assert.rejects(
      () => env.host.invokeAction(MAGPIE, 'quota', {}),
      (err: unknown) => err instanceof HelmxError && err.code === 'magpie_gateway_unreachable',
    )
  } finally {
    await env.close()
  }
})

test('magpie10: 未配置默认 loopback 不可达静默空闲（无 errors[magpie] 噪音），显式 refresh 仍诚实 502；cache-only 永不失败', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ backendAtDefault: { failModels: 'connect ECONNREFUSED 127.0.0.1:3425' } })
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => env.fetchState.calls.some((url) => url.endsWith('/v1/models')))
    // 等待启动后台刷新结算
    await new Promise((resolve) => setTimeout(resolve, 20))

    // 全局 models.refresh 在未显式配置且默认 loopback 拒绝连接时不产生 errors['magpie'] 噪音
    const result = await env.models.refresh({ providers: ['magpie'], allowNetwork: true, force: true })
    assert.equal(result.errors.size, 0, '未配置默认 loopback 未运行时不污染全局 models.refresh errors')
    assert.equal(statusDoc(env).reachable, false)
    assert.equal(statusDoc(env).lastError, undefined, '未配置空闲态不记录错误噪音')
    assert.equal(statusDoc(env).summaryText, 'Magpie · not connected')

    // 显式运行 helmx magpie refresh（调用 refresh 动作）必须诚实抛 502 magpie_gateway_unreachable
    await assert.rejects(
      () => env.host.invokeAction(MAGPIE, 'refresh', {}),
      (err: unknown) => err instanceof HelmxError && err.code === 'magpie_gateway_unreachable' && err.status === 502,
    )
    assert.match(statusDoc(env).lastError ?? '', /ECONNREFUSED/, '显式 refresh 失败后记录真实诊断')

    // cache-only 刷新（allowNetwork:false）永不失败：无缓存时空目录，且不触发网络成功伪装
    const cacheOnly = await env.models.refresh({ providers: ['magpie'], allowNetwork: false })
    assert.equal(cacheOnly.errors.size, 0)
    assert.equal(env.models.getModels('magpie').length, 0)
    assert.equal(statusDoc(env).reachable, false, 'cache-only 不推进 reachable')

    // isLoopbackConnectionError 诚实性边界：含非拒绝类错误码（ECONNRESET/ETIMEDOUT/UND_ERR_HEADERS_TIMEOUT）的
    // fetch failed 绝不误判为空闲未检测到，必须继续诚实抛错。
    assert.equal(
      isLoopbackConnectionError(new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) })),
      true,
    )
    assert.equal(isLoopbackConnectionError(new TypeError('fetch failed')), true)
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT'] as const) {
      assert.equal(
        isLoopbackConnectionError(new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) })),
        false,
        `${code} 表示已运行但异常的本地网关，绝不能静默归类为空闲未检测到`,
      )
    }
    assert.equal(isLoopbackConnectionError(new Error('http://127.0.0.1:3425/v1/models answered 503')), false)
  } finally {
    await env.close()
  }
})

test('magpie11: 通用 models.refresh 触发 status 更新（onCatalogChange 端口）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true && statusDoc(env).modelCount === 5)

    // 直接走通用 models.refresh（不经插件 refresh 动作）：插件 status 必须同步
    const result = await env.models.refresh({ providers: ['magpie'], allowNetwork: true, force: true })
    assert.equal(result.errors.size, 0)
    const doc = statusDoc(env)
    assert.equal(doc.reachable, true)
    assert.equal(doc.modelCount, 5)
    assert.ok(doc.lastRefreshedAt !== undefined)

    // 网关随后故障：通用刷新的失败同样反映到 status（lastError 更新，成功时先清除旧错误）
    env.backends.get(new URL(DEFAULT_MAGPIE_ROOT).origin)!.failModels = 'gateway exploded'
    const failed = await env.models.refresh({ providers: ['magpie'], allowNetwork: true, force: true })
    assert.equal(failed.errors.size, 1)
    await waitFor(() => statusDoc(env).reachable === false)
    const failedDoc = statusDoc(env)
    assert.match(failedDoc.lastError!, /exploded/)
    assert.equal(failedDoc.modelCount, 5, '缓存计数保留')

    // 恢复后再成功：lastError 清除（成功清除旧失败结论）
    env.backends.get(new URL(DEFAULT_MAGPIE_ROOT).origin)!.failModels = undefined
    await env.models.refresh({ providers: ['magpie'], allowNetwork: true, force: true })
    await waitFor(() => statusDoc(env).reachable === true)
    assert.equal(statusDoc(env).lastError, undefined, '成功刷新清除旧 lastError')
  } finally {
    await env.close()
  }
})

test('magpie12: 缓存与网关隔离——切 root 后旧缓存不冒充；挂起请求结果不发布', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true && statusDoc(env).modelCount === 5)

    // 切换到不可达远端：refreshModels 恢复阶段必须过滤旧 root 缓存
    await env.host.setConfig(MAGPIE, { gatewayUrl: 'http://10.255.255.1:3425' })
    const result = await env.models.refresh({ providers: ['magpie'], allowNetwork: true, force: true })
    assert.equal(result.errors.size, 1, '新网关不可达显式报错')
    assert.equal(env.models.getModels('magpie').length, 0, '旧网关缓存被清空，绝不冒充新网关目录')

    await assert.rejects(
      () => env.host.invokeAction(MAGPIE, 'refresh', {}),
      (err: unknown) => err instanceof HelmxError && err.code === 'magpie_gateway_unreachable',
    )
    const doc = statusDoc(env)
    assert.equal(doc.gatewayUrl, 'http://10.255.255.1:3425', 'doc 指向新网关')
    assert.equal(doc.reachable, false)
    assert.equal(doc.summaryText, 'Magpie · not connected')
    await env.host.setConfig(MAGPIE, {})
    // 回切默认网关：正确 root 的缓存经 cache-only 也可恢复
    await env.models.refresh({ providers: ['magpie'], allowNetwork: false })
    assert.equal(env.models.getModels('magpie').length, 5, 'cache-only 恢复当前 root 的持久缓存')
  } finally {
    await env.close()
  }
})

test('magpie13: fetch 期间切 root——旧网关挂起结果不发布到新网关名下', { timeout: 60_000 }, async () => {
  // 第二次目录刷新挂起（gate）；发起刷新后切 root，释放 gate：
  // 挂起的旧 root 目录绝不 install / persist / 更新 status。
  let releaseGate: (() => void) | undefined
  const backend: FakeBackend = { models: CATALOG, quotas: QUOTAS }
  const env = await makeEnv({ backendAtDefault: backend })
  try {
    await env.host.enable(MAGPIE)
    // 启动刷新完成（无 gate）后才挂上下一次刷新的 gate
    await waitFor(() => statusDoc(env).reachable === true && statusDoc(env).modelCount === 5)
    backend.gateModels = new Promise<void>((r) => { releaseGate = r })
    env.fetchState.calls.length = 0

    const pending = env.models.refresh({ providers: ['magpie'], allowNetwork: true, force: true })
    await waitFor(() => env.fetchState.calls.some((c) => c.includes('/v1/models') && c.includes(DEFAULT_MAGPIE_ROOT)))
    // fetch 挂起期间切换网关
    await env.host.setConfig(MAGPIE, { gatewayUrl: 'http://10.255.255.1:3425' })
    releaseGate!()
    const result = await pending
    assert.equal(result.errors.size, 1, '结果未采用必须显式返回诊断，不能提示刷新成功')
    assert.match(result.errors.get('magpie')?.message ?? '', /网关配置已变化/)
    // 但结果不得发布：内存目录与持久缓存都不被旧 root 目录污染
    assert.equal(env.models.getModels('magpie').length, 0, '挂起结果未 install（切 root 后被 sameGateway 守卫拦下）')
    const status = (await env.host.invokeAction(MAGPIE, 'status', {})) as StatusView
    assert.equal(status.gatewayUrl, 'http://10.255.255.1:3425', 'status 读取时投影当前生效网关')
    assert.equal(status.modelCount, 0, '旧网关 5 模型不写成新网关目录')
    assert.equal(status.reachable, false, '挂起结果不推进 reachable')
  } finally {
    await env.close()
  }
})

test('magpie14: 可达后失败——reachable:false 时 modelCount 不冒充实时成功', { timeout: 60_000 }, async () => {
  const backend: FakeBackend = { models: CATALOG, quotas: QUOTAS }
  const env = await makeEnv({ backendAtDefault: backend })
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true && statusDoc(env).modelCount === 5)
    assert.ok(statusDoc(env).lastRefreshedAt !== undefined)

    backend.failModels = 'gateway exploded'
    await env.host.invokeAction(MAGPIE, 'refresh', {}).then(
      () => assert.fail('故障后 refresh 必须拒绝'),
      (err: unknown) => assert.ok(err instanceof HelmxError && err.code === 'magpie_gateway_unreachable'),
    )
    const doc = statusDoc(env)
    assert.equal(doc.reachable, false)
    assert.equal(doc.summaryText, 'Magpie · not connected')
    assert.equal(doc.modelCount, 5, '缓存计数保留（不是 0），但 reachable:false 明示非实时')
    assert.match(doc.lastError!, /exploded/)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 6. turn_settled：会话过滤 + 诊断
// ---------------------------------------------------------------------------

test('magpie17: turn_settled 只刷新 magpie/ 模型会话（kept 读法；不阻塞结算）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true)
    const quotaCallsBefore = env.fetchState.calls.filter((c) => c.includes('quotas')).length

    // 非 magpie 会话 settled：不触发任何网关读
    await env.host.runHook('turn_settled', {
      conversation: makeConversation(1, 'anthropic/claude-sonnet-4.6'),
      inputs: [], outcome: 'completed', settledAt: Date.now(),
    })
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(
      env.fetchState.calls.filter((c) => c.includes('quotas')).length,
      quotaCallsBefore,
      '其它 Provider 会话 settled 不触发配额读',
    )

    // magpie 会话 settled：kept=1 侧读（不问供应商），runHook 立即返回（不阻塞）
    const start = Date.now()
    await env.host.runHook('turn_settled', {
      conversation: makeConversation(2, 'magpie/anthropic/claude-sonnet-4.6'),
      inputs: [], outcome: 'completed', settledAt: Date.now(),
    })
    assert.ok(Date.now() - start < 500, 'turn_settled 不被侧读 await 阻塞')
    await waitFor(() => env.fetchState.calls.filter((c) => c.includes('quotas')).length > quotaCallsBefore)
    const lastQuota = env.fetchState.calls.filter((c) => c.includes('quotas')).at(-1)!
    assert.match(lastQuota, /kept=1/, 'settled 刷新用 kept=1（不问供应商）')
    assert.equal(env.fetchState.calls.some((c) => c.includes('/v1/magpie/trace')), false, 'settled 侧读不请求 trace')
  } finally {
    await env.close()
  }
})

test('magpie18: 配额失败不清空成「没有配额」——diagnostics 明确记录原因', { timeout: 60_000 }, async () => {
  const backend: FakeBackend = { models: CATALOG, quotas: QUOTAS }
  const env = await makeEnv({ backendAtDefault: backend })
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true && statusDoc(env).quotas.length > 0)
    assert.deepEqual(statusDoc(env).diagnostics, [])

    // 配额接口故障：settled 侧读后 quotas 区清空但 diagnostics 记录原因
    backend.failQuotas = 'quota endpoint exploded'
    await env.host.runHook('turn_settled', {
      conversation: makeConversation(1, 'magpie/group/relay'),
      inputs: [], outcome: 'completed', settledAt: Date.now(),
    })
    await waitFor(() => statusDoc(env).diagnostics.length > 0)
    const doc = statusDoc(env)
    assert.deepEqual(doc.quotas, [], '配额区清空（旧数据不冒充当前读数）')
    assert.ok(doc.diagnostics.some((d) => d.includes('quotas unavailable') && d.includes('exploded')), `诊断含原因：${JSON.stringify(doc.diagnostics)}`)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 7. UI spec：无 Emoji / 求值表达式真实可取值 / scope 绑定
// ---------------------------------------------------------------------------

test('magpie19: UI spec 无 Emoji、scope 绑定 magpie、client 轨道组件导出真实可用', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ backendAtDefault: { models: { data: [] }, quotas: { data: [] } } })
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true)
    const ui = env.host.listUi().filter((u) => u.pluginId === MAGPIE)
    const emoji = /\p{Extended_Pictographic}/u
    for (const item of ui) {
      assert.equal(emoji.test(JSON.stringify(item.spec)), false, `UI ${item.surface} 不得含 Emoji`)
    }
    assert.equal(ui.some((u) => u.surface === 'composer.pill'), false, 'magpie 不再向 composer 注册占位胶囊')

    // settingsPanel：client 轨道（不再声明 json；真实编译产物可编译且导出组件函数）
    const panel = ui.find((u) => u.surface === 'settings.panel')!.spec as {
      label: { en?: unknown; 'zh-CN'?: unknown }; json?: unknown; docs?: unknown; client?: { module: string; export: string }
    }
    assert.deepEqual(panel.label, { en: 'Magpie Gateway', 'zh-CN': 'Magpie 网关' }, 'settingsPanel label 为 en+zh-CN 双语资源')
    assert.equal(panel.json, undefined, 'settingsPanel 不再声明 JSON Spec（单轨 client）')
    assert.equal(panel.docs, undefined, 'settingsPanel 不再声明 docs（组件 usePluginDoc 自主订阅）')
    assert.equal(panel.client!.module, 'settings.tsx')
    assert.equal(panel.client!.export, 'MagpieSettingsPanel')

    // 真实编译：clientRoot 内按 surface 拆分的模块均可独立编译为浏览器 ESM
    const clientRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'magpie', 'client')
    const cacheDir = mkdtempSync(join(tmpdir(), 'helmx-magpie-client-'))
    try {
      for (const entry of ['composer-quota.tsx', 'settings.tsx']) {
        const { code } = await compilePluginClientModule(MAGPIE, clientRoot, entry, cacheDir)
        assert.ok(code.length > 0, `${entry} 编译产物非空`)
        assert.doesNotMatch(code, /\p{Extended_Pictographic}/u, `${entry} 编译产物不含 Emoji`)
      }
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }

    const command = ui.find((u) => u.surface === 'commandPalette')!.spec as { title: { en?: unknown; 'zh-CN'?: unknown }; actionId: string }
    assert.deepEqual(command.title, { en: 'Refresh the Magpie model catalog', 'zh-CN': '刷新 Magpie 模型目录' }, 'command title 为 en+zh-CN 双语资源')
    assert.equal(command.actionId, 'refresh')
    assert.equal(resolveLocalizedText(MAGPIE_COL_PROVIDER, 'en'), 'Provider')
    assert.equal(resolveLocalizedText(MAGPIE_COL_PROVIDER, 'zh-CN'), '供应商')

    // 无模型目录时非 magpie 会话 settled 不触网（保持原行为回归）
    const callsBefore = env.fetchState.calls.length
    await env.host.runHook('turn_settled', {
      conversation: makeConversation(1, 'other/model'),
      inputs: [], outcome: 'completed', settledAt: Date.now(),
    })
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(env.fetchState.calls.length, callsBefore, '无关会话 settled 不读网关')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 8. provider 请求路径：auth 快照冻结 / stream 委托 baseUrl 修正
// ---------------------------------------------------------------------------

test('magpie20: auth.resolve 携带冻结 root 的 env；apiKey 与 root 同次快照', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => env.models.getModels('magpie').length > 0)
    const provider = env.models.getProvider('magpie')!

    const resolved = await provider.auth.apiKey!.resolve({ signal: new AbortController().signal } as never)
    assert.ok(resolved, 'auth.resolve 返回有效结果')
    assert.equal(resolved!.auth.apiKey, DEFAULT_MAGPIE_TOKEN)
    assert.equal(resolved!.env?.MAGPIE_GW_URL, DEFAULT_MAGPIE_ROOT, 'auth 快照冻结 root 进 env')

    // Models.getAuth 走 credential store：resolve 结果同样携带 env
    const viaModels = await env.models.getAuth('magpie')
    assert.ok(viaModels)
    assert.equal(viaModels.env?.MAGPIE_GW_URL, DEFAULT_MAGPIE_ROOT)
  } finally {
    await env.close()
  }
})

test('magpie21: provider stream 按请求时刻 root 修正 baseUrl（委托产生事件流）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => env.models.getModels('magpie').length > 0)
    const provider = env.models.getProvider('magpie')!
    const anthropicModel = env.models.getModel('magpie', 'anthropic/claude-sonnet-4.6')!
    const openaiModel = env.models.getModel('magpie', 'openai/gpt-5.2')!
    assert.equal(anthropicModel.baseUrl, DEFAULT_MAGPIE_ROOT)
    assert.equal(openaiModel.baseUrl, `${DEFAULT_MAGPIE_ROOT}/v1`)
    // stream 委托：compat 实现对未知 host 以流事件报错而非 throw——
    // 验证委托路径可走通（错误事件也是显式结果，不静默）。
    const events: string[] = []
    const stream = provider.streamSimple(anthropicModel, { messages: [] } as never)
    for await (const event of stream) {
      events.push((event as { type: string }).type)
      if (events.length > 3) break
    }
    assert.ok(events.length >= 1, 'stream 委托产生事件流')
  } finally {
    await env.close()
  }
})

test('magpie22: stop() 取消启动后台刷新任务，停止后不再写 status doc 或触发 sidecar 读取', { timeout: 60_000 }, async () => {
  // 1) 后台刷新在途期间 dispose/stop，随后 resolve 成功结果：不写 status、不拉 quotas/trace
  {
    const refreshGate = deferred<{ providers: string[]; aborted: boolean; errors: Record<string, string>; models: never[]; providerCatalog: never[] }>()
    const entered = deferred<void>()
    const env = await makeEnv({
      hostApi: {
        refreshModels: (async () => {
          entered.resolve()
          return refreshGate.promise
        }) as never,
      },
    })
    try {
      await env.host.enable(MAGPIE)
      await entered.promise
      const writesAtStop = env.docs.writes.length
      const fetchCallsAtStop = env.fetchState.calls.length

      await env.host.dispose()
      refreshGate.resolve({ providers: [MAGPIE_PROVIDER_ID], aborted: false, errors: {}, models: [], providerCatalog: [] })
      await new Promise((r) => setTimeout(r, 30))

      assert.equal(env.docs.writes.length, writesAtStop, 'stop 后后台刷新返回不得再写 status doc')
      assert.equal(env.fetchState.calls.length, fetchCallsAtStop, 'stop 后不得再发起 quotas/trace sidecar 读取')
    } finally {
      await env.close()
    }
  }

  // 2) 后台刷新在途期间 dispose/stop，随后 reject：同样静默退出不写 status doc
  {
    const refreshGate = deferred<never>()
    const entered = deferred<void>()
    const env = await makeEnv({
      hostApi: {
        refreshModels: (async () => {
          entered.resolve()
          return refreshGate.promise
        }) as never,
      },
    })
    try {
      await env.host.enable(MAGPIE)
      await entered.promise
      const writesAtStop = env.docs.writes.length

      await env.host.dispose()
      refreshGate.reject(new Error('late refresh rejection'))
      await new Promise((r) => setTimeout(r, 30))

      assert.equal(env.docs.writes.length, writesAtStop, 'stop 后后台刷新异常不得再写 status doc')
    } finally {
      await env.close()
    }
  }
})

// ---------------------------------------------------------------------------
// 23-24. 配额投影扩展（单位/池子/主账号）、modelOwners、onlyIfChanged 轮询与 refreshIntervalSec 配置
// ---------------------------------------------------------------------------

test('magpie23: quotaRows 保留非百分比单位、pool、last、readAt、resetsAt 与错误字段', { timeout: 60_000 }, () => {
  const now = Date.parse('2026-11-21T12:00:00Z')
  const resetsAt = '2026-11-21T14:00:00Z'
  const rows = quotaRows(
    [
      {
        provider: 'antigravity-bridge',
        alias: 'halt',
        user: 'halt@example.com',
        last: true,
        lastServedAt: '2026-11-21T11:59:00Z',
        readAt: '2026-11-21T11:58:00Z',
        windows: [
          { name: 'Gemini · 5 hours', pool: 'Gemini', remaining: 96, resetsAt, display: '4% used' },
          { name: 'Unlimited tier', unlimited: true, used: 0 },
          { name: 'Text reading', text: true, used: 0, display: '0 / 6900' },
          { name: 'Wallet', balance: 12.5, unit: 'USD', used: 0 },
        ],
      },
      {
        provider: 'ai-studio',
        user: 'key-1',
        error: 'external service exposes no quota API',
        windows: [],
      },
      {
        provider: 'openrouter',
        kind: 'balance',
        user: 'key-2',
        balance: '$8.40',
        windows: [],
      },
      {
        // 无 kind: 'balance' 的余额卡片（如 newapi）：绝不得生成 windowLabel: undefined 导致 jsonClone / redactJsonValue 500
        provider: 'newapi',
        user: 'key-3',
        balance: '$15.00',
        windows: [],
      },
      {
        provider: 'numeric-wallet',
        balance: 42.5,
      },
      {
        provider: 'plain-empty',
        windows: [],
      },
    ],
    now,
  )

  // 严格 JSON 契约校验：所有输出行绝不含 undefined 自有键、NaN 或非 JSON 值
  assert.doesNotThrow(() => redactJsonValue(rows, (s) => s))

  assert.equal(rows.length, 9)
  assert.equal(rows[0]!.account, 'halt', '优先展示 alias')
  assert.equal(rows[0]!.pool, 'Gemini')
  assert.equal(rows[0]!.last, true)
  assert.equal(rows[0]!.resetsAt, resetsAt)
  assert.equal(rows[0]!.resetText, '2h')
  assert.equal(rows[0]!.remainingPercent, 96)
  assert.equal(rows[0]!.displayText, '4% used')
  assert.equal(rows[0]!.readAt, '2026-11-21T11:58:00Z')

  assert.equal(rows[1]!.remainingPercent, -1, 'unlimited 不得把 used=0 误算成 100%')
  assert.equal(rows[1]!.unlimited, true)
  assert.equal(rows[1]!.displayText, '∞')

  assert.equal(rows[2]!.remainingPercent, -1, 'text 窗口不得把 used=0 误算成 100%')
  assert.equal(rows[2]!.displayText, '0 / 6900')

  assert.equal(rows[3]!.remainingPercent, -1, '预付余额不得把 used=0 误算成 100%')
  assert.equal(rows[3]!.displayText, '$12.50')

  assert.equal(rows[4]!.error, 'external service exposes no quota API')
  assert.equal(rows[4]!.remainingPercent, -1)

  assert.equal(rows[5]!.displayText, '$8.40')
  assert.equal(rows[5]!.windowLabel, 'Balance')

  assert.equal(rows[6]!.displayText, '$15.00')
  assert.equal(rows[6]!.windowLabel, 'Balance')
  assert.equal(Object.values(rows[6]!).includes(undefined), false)

  assert.equal(rows[7]!.displayText, '42.5')
  assert.equal(rows[7]!.windowLabel, 'Balance')

  assert.equal(rows[8]!.remainingPercent, -1)
  assert.equal('windowLabel' in rows[8]!, false)
})

test('magpie24: status 暴露 modelOwners；onlyIfChanged 轮询无变更跳过目录落盘、变更时热更新；quota 回写 status；configSchema 含 showQuotaStatus 与 refreshIntervalSec', { timeout: 60_000 }, async () => {
  const backend: FakeBackend = {
    models: {
      data: [
        { id: 'auto/gemini-4-carbon', native_endpoints: ['/v1/messages'], owned_by: 'antigravity-bridge' },
        { id: 'group/relay', native_endpoints: [], owned_by: 'opencode-go' },
        { id: 'zhipu/glm-5.3', native_endpoints: [] },
      ],
    },
    quotas: {
      data: [
        ...QUOTAS.data,
        // 无 kind: 'balance' 的余额供应商卡片：验证真实 status.set (jsonClone) 与 quota 动作输出均无 undefined 报错
        { provider: 'newapi', user: 'key-balance', balance: '$19.80', windows: [] },
      ],
    },
  }
  let hostRefreshCount = 0
  const env = await makeEnv({
    backendAtDefault: backend,
  })
  // 包装 refreshModels 以计数（仍委托真实 models.refresh）
  const origRefresh = env.models.refresh.bind(env.models)
  const refreshSpy = mock.method(env.models, 'refresh', async (opts?: Parameters<typeof origRefresh>[0]) => {
    hostRefreshCount += 1
    return origRefresh(opts)
  })
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true && statusDoc(env).quotas.length > 0)

    const initial = statusDoc(env)
    assert.deepEqual(initial.modelOwners, {
      'auto/gemini-4-carbon': 'antigravity-bridge',
      'group/relay': 'opencode-go',
      'zhipu/glm-5.3': 'zhipu',
    })
    assert.equal(initial.quotasRefreshedAt, undefined, '启动侧读使用 kept=1，不冒充供应商实时刷新')

    const refreshBeforePoll = hostRefreshCount
    // 1) 目录未变化时，onlyIfChanged 跳过 host.refreshModels（零磁盘重写 / 零全站资产风暴），但走实时配额接口
    const pollRes = (await env.host.invokeAction(MAGPIE, 'refresh', { onlyIfChanged: true })) as {
      refreshed: boolean
      modelCount: number
      reachable: boolean
    }
    assert.deepEqual(pollRes, { refreshed: true, modelCount: 3, reachable: true })
    assert.equal(hostRefreshCount, refreshBeforePoll, '目录未变时不得重复触发 host.refreshModels')
    assert.ok(typeof statusDoc(env).quotasRefreshedAt === 'number', '实时轮询成功推进 quotasRefreshedAt')
    const lastQuotaCall = env.fetchState.calls.filter((c) => c.includes('/v1/magpie/quotas')).at(-1)!
    assert.equal(lastQuotaCall.includes('kept=1'), false, '自动轮询拉取最新配额不带 kept=1')

    // 2) 网关新增模型后，下一次 onlyIfChanged 立刻感知并触发 host.refreshModels 热更新模型目录与 modelOwners
    backend.models = {
      data: [
        { id: 'auto/gemini-4-carbon', native_endpoints: ['/v1/messages'], owned_by: 'antigravity-bridge' },
        { id: 'group/relay', native_endpoints: [], owned_by: 'opencode-go' },
        { id: 'zhipu/glm-5.3', native_endpoints: [] },
        { id: 'auto/gpt-6.2-sol', native_endpoints: ['/v1/responses'], owned_by: 'newapi' },
      ],
    }
    const pollChanged = (await env.host.invokeAction(MAGPIE, 'refresh', { onlyIfChanged: true })) as {
      refreshed: boolean
      modelCount: number
      reachable: boolean
    }
    assert.equal(pollChanged.modelCount, 4)
    assert.equal(hostRefreshCount, refreshBeforePoll + 1, '目录变化时必须触发真实目录刷新')
    assert.equal(statusDoc(env).modelOwners['auto/gpt-6.2-sol'], 'newapi')

    // 3) quota 动作失败时保留旧 quotas 缓存并如实记录 quotasError，再显式抛出 502
    backend.failQuotas = 'upstream timeout'
    await assert.rejects(
      () => env.host.invokeAction(MAGPIE, 'quota', {}),
      (err: unknown) => err instanceof HelmxError && err.code === 'magpie_gateway_unreachable' && err.status === 502,
    )
    assert.ok(statusDoc(env).quotas.length > 0, '实时配额拉取失败保留旧缓存便于诚实展示过期读数')
    assert.match(statusDoc(env).quotasError ?? '', /upstream timeout/)

    // 4) 恢复后调用 quota 动作：写回最新配额并清除 quotasError
    backend.failQuotas = undefined
    await env.host.invokeAction(MAGPIE, 'quota', {})
    assert.equal(statusDoc(env).quotasError, undefined, '成功后必须清除旧 quotasError')

    // 5) configSchema 声明 showQuotaStatus（默认 true）与 refreshIntervalSec（默认 5 秒，整数 0..3600）
    const schema = env.host.getConfigSchema(MAGPIE)
    const showField = schema['showQuotaStatus']
    assert.equal(showField?.type, 'boolean')
    assert.equal(showField?.default, true)
    const intervalField = schema['refreshIntervalSec']
    assert.equal(intervalField?.type, 'number')
    assert.equal(intervalField?.default, 5)
    assert.equal(intervalField?.minimum, 0)
    assert.equal(intervalField?.maximum, 3600)
    assert.equal(intervalField?.integer, true)
  } finally {
    refreshSpy.mock.restore()
    await env.close()
  }
})

test('magpie25: onlyIfChanged 目录变化仅请求一次 /v1/models、turn_settled 忽略 resetText 倒计时跳变、错误消息经 redact 脱敏、auto-refresh 跨实例正确移除 visibilitychange 监听', { timeout: 60_000 }, async () => {
  const secretToken = 'sk-magpie-err-secret-777'
  const backend: FakeBackend = {
    models: {
      data: [{ id: 'group/relay', native_endpoints: [], owned_by: 'opencode-go' }],
    },
    quotas: {
      data: [
        {
          provider: 'opencode-go',
          user: 'u1',
          windows: [{ label: '5h', remaining_percent: 80, reset_at: Math.floor((Date.now() + 7200_000) / 1000) }],
        },
      ],
    },
  }
  const env = await makeEnv({
    backendAtDefault: backend,
    hostApi: {
      redact: (text: string) => text.replaceAll(secretToken, '[REDACTED]'),
    },
  })
  try {
    await env.host.enable(MAGPIE)
    await waitFor(() => statusDoc(env).reachable === true && statusDoc(env).quotas.length === 1)

    // 1) onlyIfChanged 检测到新模型时：预拉取目录直接复用，全程仅请求 1 次 /v1/models（绝不二次重复拉取）
    env.fetchState.calls.length = 0
    backend.models = {
      data: [
        { id: 'group/relay', native_endpoints: [], owned_by: 'opencode-go' },
        { id: 'auto/new-model', native_endpoints: ['/v1/messages'], owned_by: 'opencode-go' },
      ],
    }
    await env.host.invokeAction(MAGPIE, 'refresh', { onlyIfChanged: true })
    const modelFetches = env.fetchState.calls.filter((u) => u.includes('/v1/models'))
    assert.equal(modelFetches.length, 1, `目录变化时 /v1/models 应仅请求 1 次，实际 ${modelFetches.length}`)
    assert.equal(statusDoc(env).modelCount, 2)

    // 2) turn_settled skipIfUnchanged: 仅 reset_at 引起派生 resetText 变化但核心配额不变时不触发冗余 status 文档写放大
    let statusWrites = 0
    const origSet = env.docs.set.bind(env.docs)
    env.docs.set = (key: string, val: unknown) => {
      if (key === `${MAGPIE}:status`) statusWrites += 1
      origSet(key, val)
    }
    backend.quotas = {
      data: [
        {
          provider: 'opencode-go',
          user: 'u1',
          windows: [{ label: '5h', remaining_percent: 80, reset_at: Math.floor((Date.now() + 3600_000) / 1000) }],
        },
      ],
    }
    statusWrites = 0
    env.fetchState.calls.length = 0
    await env.host.runHook('turn_settled', {
      conversation: makeConversation(1, 'magpie/group/relay'),
      inputs: [],
      outcome: 'completed',
      settledAt: Date.now(),
    })
    await waitFor(() => env.fetchState.calls.some((u) => u.includes('/v1/magpie/quotas')))
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(statusWrites, 0, '仅倒计时文本变化但配额实质未变时 skipIfUnchanged 应跳过写盘/广播')

    // 3) 网关与配额错误消息经过 ctx.host.redact 脱敏，绝不泄漏已登记机密
    backend.failQuotas = `upstream rejected key ${secretToken}`
    await assert.rejects(() => env.host.invokeAction(MAGPIE, 'quota', {}))
    assert.equal(JSON.stringify(statusDoc(env)).includes(secretToken), false, 'quotasError 必须脱敏')
    assert.match(statusDoc(env).quotasError ?? '', /\[REDACTED\]/)

    // 4) auto-refresh.ts 将 visibilitychange 监听器保存在全局共享状态上，卸载后精确移除监听器
    const { subscribeMagpieAutoRefresh, resetMagpieAutoRefreshForTest } = await import('../src/magpie/client/auto-refresh.js')
    const added: EventListener[] = []
    const removed: EventListener[] = []
    const origDoc = (globalThis as Record<string, unknown>)['document']
    ;(globalThis as Record<string, unknown>)['document'] = {
      visibilityState: 'visible',
      addEventListener: (_ev: string, fn: EventListener) => added.push(fn),
      removeEventListener: (_ev: string, fn: EventListener) => removed.push(fn),
    }
    try {
      resetMagpieAutoRefreshForTest()
      const release = subscribeMagpieAutoRefresh({ intervalMs: 60_000, run: async () => {} })
      assert.equal(added.length, 1)
      release()
      assert.equal(removed.length, 1)
      assert.ok(added[0] === removed[0], 'removeEventListener 必须移除实际注册的同一个监听器引用')
    } finally {
      resetMagpieAutoRefreshForTest()
      if (origDoc === undefined) delete (globalThis as Record<string, unknown>)['document']
      else (globalThis as Record<string, unknown>)['document'] = origDoc
    }
  } finally {
    await env.close()
  }
})

