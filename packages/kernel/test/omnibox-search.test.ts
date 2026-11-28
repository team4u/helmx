/**
 * Tests for Global Omnibox Search & Static Plugin Config Catalog:
 * - `GET /api/plugins/config-catalog` & `PluginHost.listConfigCatalog()` (secret stripping,
 *   secret default omission, enabled/disabled reporting, deterministic ordering, redaction,
 *   zero `PluginSummary` SSE bloat);
 * - `GET /api/omnibox/search` & `runOmniboxSearch()` (parallel FTS5 + active `helmx.search`
 *   providers, pure `ConversationService.search` decoupling, immediate removal on plugin disable,
 *   per-provider timeout/error isolation -> `failedPlugins`, strict shape validation & score
 *   clamping, per-plugin 8-item cap, SecretStash redaction, `messagesUnavailable` handling,
 *   and strict HTTP query/method validation).
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import {
  HELMX_SEARCH_CAPABILITY_ID,
  type OmniboxSearchResponse,
  type PluginConfigCatalogEntry,
  type PluginSearchProvider,
} from '@helmx/protocol'
import { errorToResponse } from '../src/http/http-utils.js'
import { handleApi } from '../src/http/routes.js'
import { KernelRuntime, runOmniboxSearch } from '../src/runtime/index.js'
import { cleanupDir, makeFauxModels, makeTempDir, waitFor } from './helpers.js'

async function openRuntime(dir: string) {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models,
  })
  return Object.assign(runtime, { __faux: faux })
}

async function apiJson<T = unknown>(
  kernel: KernelRuntime,
  method: string,
  path: string,
  signal?: AbortSignal,
): Promise<{ status: number; body: T }> {
  let response: Response
  try {
    response = await handleApi(
      new Request(`http://hub${path}`, { method, ...(signal !== undefined ? { signal } : {}) }),
      kernel as never,
      (value) => JSON.stringify(value),
    )
  } catch (error) {
    response = errorToResponse(
      (value) => JSON.stringify(value),
      (text) => kernel.stash.redact(text),
      error,
    )
  }
  const body = (await response.json()) as T
  return { status: response.status, body }
}

test('GET /api/plugins/config-catalog: projects secret-stripped schemas across enabled & disabled plugins without bloating PluginSummary', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir('helmx-config-catalog-')
  t.after(() => cleanupDir(dir), { timeout: 60_000 })

  const kernel = await openRuntime(join(dir, 'data'))
  t.after(() => kernel.close(), { timeout: 60_000 })

  kernel.stash.addRedaction('SUPER_SECRET_STASH_VALUE')

  await kernel.plugins.register({
    id: 'z:alpha',
    name: { en: 'Alpha Plugin', 'zh-CN': '阿尔法插件' },
    icon: 'sliders',
    definePlugin(ctx) {
      ctx.configSchema({
        endpoint: {
          type: 'string',
          default: 'https://api.example.com',
          label: { en: 'Endpoint', 'zh-CN': '接口地址' },
          description: 'Endpoint with SUPER_SECRET_STASH_VALUE inside description',
        },
        apiToken: {
          type: 'string',
          secret: true,
          required: true,
          default: 'HARDCODED_SECRET_DEFAULT_DO_NOT_LEAK',
          label: 'API Token',
        },
        retries: {
          type: 'number',
          integer: true,
          minimum: 0,
          maximum: 5,
          default: 2,
        },
      })
    },
  })

  // Store a live secret value to ensure runtime secrets never appear in config-catalog
  await kernel.plugins.setConfig('z:alpha', {
    apiToken: 'LIVE_API_SECRET_999',
    endpoint: 'https://custom.example.com',
  })

  // Disabled plugin declaring configSchema must still appear with enabled: false
  await kernel.plugins.register(
    {
      id: 'a:disabled-cfg',
      name: 'Disabled Config Plugin',
      definePlugin(ctx) {
        ctx.configSchema({
          mode: {
            type: 'string',
            enum: ['fast', 'accurate'],
            default: 'fast',
            label: 'Mode',
          },
          webhookSecret: {
            type: 'string',
            secret: true,
            default: 'DISABLED_SECRET_DEFAULT',
          },
        })
      },
    },
    { enabled: false },
  )

  // Plugin without configSchema must be omitted
  await kernel.plugins.register({
    id: 'm:no-schema',
    name: 'No Schema Plugin',
    definePlugin() {},
  })

  // PluginSummary must stay slim (no configFields field added!)
  for (const summary of kernel.plugins.list()) {
    assert.equal(Object.hasOwn(summary, 'configFields'), false, 'PluginSummary must not carry configFields')
  }

  const res = await apiJson<PluginConfigCatalogEntry[]>(kernel, 'GET', '/api/plugins/config-catalog')
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.body))
  assert.deepEqual(
    res.body.map((e) => e.pluginId),
    ['a:disabled-cfg', 'z:alpha'],
  )

  const disabledEntry = res.body[0]!
  assert.equal(disabledEntry.enabled, false)
  assert.equal(disabledEntry.pluginName, 'Disabled Config Plugin')
  assert.equal(disabledEntry.pluginIcon, undefined)
  assert.deepEqual(
    disabledEntry.fields.map((f) => f.key),
    ['mode', 'webhookSecret'],
  )
  const webhookField = disabledEntry.fields.find((f) => f.key === 'webhookSecret')!
  assert.equal(webhookField.secret, true)
  assert.equal(Object.hasOwn(webhookField, 'default'), false, 'secret field must never expose default')

  const alphaEntry = res.body[1]!
  assert.equal(alphaEntry.enabled, true)
  assert.deepEqual(alphaEntry.pluginName, { en: 'Alpha Plugin', 'zh-CN': '阿尔法插件' })
  assert.equal(alphaEntry.pluginIcon, 'sliders')
  const apiTokenField = alphaEntry.fields.find((f) => f.key === 'apiToken')!
  assert.equal(apiTokenField.secret, true)
  assert.equal(apiTokenField.required, true)
  assert.equal(Object.hasOwn(apiTokenField, 'default'), false, 'secret default must be stripped')

  const endpointField = alphaEntry.fields.find((f) => f.key === 'endpoint')!
  assert.equal(endpointField.default, 'https://api.example.com')
  assert.equal(typeof endpointField.description, 'string')
  assert.ok(!(endpointField.description as string).includes('SUPER_SECRET_STASH_VALUE'))

  const serialized = JSON.stringify(res.body)
  assert.ok(!serialized.includes('LIVE_API_SECRET_999'), 'live secret value must never leak')
  assert.ok(!serialized.includes('HARDCODED_SECRET_DEFAULT_DO_NOT_LEAK'), 'hardcoded secret default must never leak')
  assert.ok(!serialized.includes('DISABLED_SECRET_DEFAULT'), 'disabled plugin secret default must never leak')
  assert.ok(!serialized.includes('SUPER_SECRET_STASH_VALUE'), 'stashed secret must be redacted')

  // Method & route guards
  const postRes = await apiJson<{ error: { code: string } }>(kernel, 'POST', '/api/plugins/config-catalog')
  assert.equal(postRes.status, 405)
  assert.equal(postRes.body.error.code, 'method_not_allowed')

  const extraRes = await apiJson<{ error: { code: string } }>(kernel, 'GET', '/api/plugins/config-catalog/extra')
  assert.equal(extraRes.status, 404)
})

test('GET /api/omnibox/search: aggregates FTS5 + multiple helmx.search providers, respects disable lifecycle, keeps /api/search pure', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir('helmx-omnibox-e2e-')
  t.after(() => cleanupDir(dir), { timeout: 60_000 })

  const kernel = await openRuntime(join(dir, 'data'))
  t.after(() => kernel.close(), { timeout: 60_000 })

  // Seed a real conversation with searchable FTS content
  kernel.__faux.setResponses([fauxAssistantMessage('Deploy nebula pipeline completed cleanly.')])
  const conv = await kernel.conversations.createConversation({ title: 'Nebula Rollout' })
  await kernel.conversations.submitInput(conv.id, 'Please inspect nebula deployment logs')
  await waitFor(() => kernel.conversations.getConversation(conv.id).status !== 'working', { timeoutMs: 10_000 })

  const receivedQueries: Array<{ pluginId: string; query: string; limit: number; locale?: string; conversationId?: number }> = []

  await kernel.plugins.register({
    id: 'demo:workflows',
    name: 'Demo Workflows',
    definePlugin(ctx) {
      ctx.provide<PluginSearchProvider>(HELMX_SEARCH_CAPABILITY_ID, {
        search(input) {
          receivedQueries.push({ pluginId: 'demo:workflows', ...input })
          return [
            {
              id: 'wf-nebula',
              kind: 'resource',
              title: { en: 'Nebula Release', 'zh-CN': '星云发布' },
              subtitle: { en: 'Automated release workflow', 'zh-CN': '自动发布工作流' },
              breadcrumb: [{ en: 'Workflows', 'zh-CN': '工作流' }],
              icon: 'workflow',
              badge: { en: 'Ready', 'zh-CN': '就绪' },
              target: 'screen:demo:workflows/library?wf=nebula',
              focusAnchor: 'wf:nebula',
              score: 92,
            },
          ]
        },
      })
    },
  })

  await kernel.plugins.register({
    id: 'demo:tiers',
    name: 'Demo Tiers',
    definePlugin(ctx) {
      ctx.provide<PluginSearchProvider>(HELMX_SEARCH_CAPABILITY_ID, {
        async search(input) {
          receivedQueries.push({ pluginId: 'demo:tiers', ...input })
          return [
            {
              id: 'tier-nebula',
              kind: 'setting',
              title: 'Nebula Fast Tier',
              target: 'screen:demo:tiers/manager?edit=nebula',
              score: 120, // clamped to 100
            },
          ]
        },
      })
    },
  })

  // /api/search stays completely pure (FTS hits only, zero plugin items)
  const pureRes = await apiJson<unknown[]>(kernel, 'GET', '/api/search?q=nebula')
  assert.equal(pureRes.status, 200)
  assert.ok(Array.isArray(pureRes.body))
  assert.ok(pureRes.body.length >= 1)

  // /api/omnibox/search combines both FTS messages and active plugin providers
  const omniRes = await apiJson<OmniboxSearchResponse>(
    kernel,
    'GET',
    `/api/omnibox/search?q=nebula&limit=5&locale=zh-CN&conversationId=${conv.id}`,
  )
  assert.equal(omniRes.status, 200)
  assert.equal(omniRes.body.query, 'nebula')
  assert.ok(omniRes.body.messages.length >= 1)
  assert.equal(omniRes.body.messagesUnavailable, undefined)
  assert.equal(omniRes.body.failedPlugins, undefined)
  assert.equal(omniRes.body.pluginItems.length, 2)

  // Sorted descending by clamped score: tier-nebula (100) before wf-nebula (92)
  assert.equal(omniRes.body.pluginItems[0]!.id, 'demo:tiers/tier-nebula')
  assert.equal(omniRes.body.pluginItems[0]!.pluginId, 'demo:tiers')
  assert.equal(omniRes.body.pluginItems[0]!.itemId, 'tier-nebula')
  assert.equal(omniRes.body.pluginItems[0]!.score, 100)

  assert.equal(omniRes.body.pluginItems[1]!.id, 'demo:workflows/wf-nebula')
  assert.deepEqual(omniRes.body.pluginItems[1]!.title, { en: 'Nebula Release', 'zh-CN': '星云发布' })
  assert.equal(omniRes.body.pluginItems[1]!.focusAnchor, 'wf:nebula')

  // Verify query parameters forwarded accurately
  for (const call of receivedQueries) {
    assert.equal(call.query, 'nebula')
    assert.equal(call.limit, 5)
    assert.equal(call.locale, 'zh-CN')
    assert.equal(call.conversationId, conv.id)
  }

  // Disabling a plugin removes its items immediately
  await kernel.plugins.disable('demo:tiers')
  const afterDisable = await apiJson<OmniboxSearchResponse>(kernel, 'GET', '/api/omnibox/search?q=nebula')
  assert.equal(afterDisable.status, 200)
  assert.deepEqual(
    afterDisable.body.pluginItems.map((i) => i.id),
    ['demo:workflows/wf-nebula'],
  )

  // Re-enabling restores them cleanly
  await kernel.plugins.enable('demo:tiers')
  const afterEnable = await apiJson<OmniboxSearchResponse>(kernel, 'GET', '/api/omnibox/search?q=nebula')
  assert.equal(afterEnable.status, 200)
  assert.equal(afterEnable.body.pluginItems.length, 2)
})

test('runOmniboxSearch: timeout/error isolation, shape validation, per-plugin 8-item cap, redaction, and messagesUnavailable', { timeout: 60_000 }, async () => {
  const SECRET = 'sk-live-secret-token-42'
  const redact = (text: string): string => text.replaceAll(SECRET, '[REDACTED]')
  let slowAborted = false

  const providers: Array<{ pluginId: string; impl: PluginSearchProvider }> = [
    {
      pluginId: 'p:slow',
      impl: {
        search(_input, signal) {
          return new Promise((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                slowAborted = true
                resolve([])
              },
              { once: true },
            )
          })
        },
      },
    },
    {
      pluginId: 'p:throws',
      impl: {
        search() {
          throw new Error('provider boom')
        },
      },
    },
    {
      pluginId: 'p:bad-return',
      impl: {
        search: () => ('not-an-array' as unknown as never),
      },
    },
    {
      pluginId: 'p:noisy',
      impl: {
        search() {
          return [
            // Invalid items (must be skipped cleanly without failing the plugin)
            null as never,
            { id: '', title: 'blank id', target: 'screen:a/b' },
            { id: 'bad-target', title: 'blank target', target: '   ' },
            { id: 'long-target', title: 'overlong target', target: 'x'.repeat(513) },
            { id: 'bad-title', title: { fr: 'Bonjour' } as never, target: 'screen:a/b' },
            { id: 'bad-kind', kind: 'bogus' as never, title: 'x', target: 'screen:a/b' },
            { id: 'nan-score', title: 'x', target: 'screen:a/b', score: Number.NaN },
            { id: 'inf-score', title: 'x', target: 'screen:a/b', score: Number.POSITIVE_INFINITY },
            // Valid item containing secrets across every string field + negative score clamped to 0
            {
              id: 'item-secret',
              kind: 'resource',
              title: { en: `Title ${SECRET}`, 'zh-CN': `标题 ${SECRET}` },
              subtitle: `Sub ${SECRET}`,
              breadcrumb: [{ en: `Crumb ${SECRET}` }],
              badge: `Badge ${SECRET}`,
              target: `screen:p:noisy/view?q=${SECRET}`,
              focusAnchor: `anchor:${SECRET}`,
              score: -25,
            },
            // Duplicate itemId must be deduplicated
            { id: 'item-secret', title: 'Duplicate', target: 'screen:p:noisy/dup', score: 99 },
            // 10 more valid items -> total per-plugin accepted must be capped at 8!
            ...Array.from({ length: 10 }, (_, idx) => ({
              id: `valid-${idx}`,
              title: `Item ${idx}`,
              target: `screen:p:noisy/item/${idx}`,
              score: 50 + idx,
            })),
          ]
        },
      },
    },
  ]

  // Case 1: FTS fails -> messagesUnavailable: true, messages: [], healthy plugin items still returned
  const res = await runOmniboxSearch(
    {
      conversations: {
        search() {
          throw new Error('sqlite busy')
        },
      },
      plugins: {
        consumeCapability<T>() {
          return providers as unknown as ReadonlyArray<{ pluginId: string; impl: T }>
        },
      },
    },
    { q: 'test', limit: 20 },
    { redact, providerTimeoutMs: 30 },
  )

  assert.equal(slowAborted, true, 'slow provider AbortSignal must be aborted on timeout')
  assert.equal(res.messagesUnavailable, true)
  assert.deepEqual(res.messages, [])
  assert.deepEqual(res.failedPlugins, ['p:bad-return', 'p:slow', 'p:throws'])

  // Per-plugin cap enforced at 8 even though limit=20 and provider returned >10 valid items
  assert.equal(res.pluginItems.length, 8)
  const secretHit = res.pluginItems.find((item) => item.itemId === 'item-secret')!
  assert.ok(secretHit !== undefined)
  assert.equal(secretHit.score, 0, 'negative finite score must clamp to 0')
  assert.deepEqual(secretHit.title, { en: 'Title [REDACTED]', 'zh-CN': '标题 [REDACTED]' })
  assert.equal(secretHit.subtitle, 'Sub [REDACTED]')
  assert.deepEqual(secretHit.breadcrumb, [{ en: 'Crumb [REDACTED]' }])
  assert.equal(secretHit.badge, 'Badge [REDACTED]')
  assert.equal(secretHit.target, 'screen:p:noisy/view?q=[REDACTED]')
  assert.equal(secretHit.focusAnchor, 'anchor:[REDACTED]')
  assert.ok(!JSON.stringify(res).includes(SECRET), 'secret must never appear anywhere in OmniboxSearchResponse')

  // Case 2: Smaller limit (limit=3) bounds per-plugin results to 3 and redacts message hits
  const limited = await runOmniboxSearch(
    {
      conversations: {
        async search() {
          return [
            {
              conversationId: 7,
              title: `Conv ${SECRET}`,
              snippet: `Leaked ${SECRET} value`,
              highlights: [{ start: 0, end: 6 }],
            },
          ]
        },
      },
      plugins: {
        consumeCapability<T>() {
          return [providers[3]!] as unknown as ReadonlyArray<{ pluginId: string; impl: T }>
        },
      },
    },
    { q: 'test', limit: 3 },
    { redact, providerTimeoutMs: 50 },
  )
  assert.equal(limited.messagesUnavailable, undefined)
  assert.equal(limited.failedPlugins, undefined)
  assert.equal(limited.pluginItems.length, 3)
  assert.equal(limited.messages.length, 1)
  assert.equal(limited.messages[0]!.title, 'Conv [REDACTED]')
  assert.equal(limited.messages[0]!.snippet, 'Leaked [REDACTED] value')
  assert.deepEqual(limited.messages[0]!.highlights, [], 'redacted snippet must clear shifted highlight spans')
})

test('GET /api/omnibox/search: validates query params strictly and rejects unsupported methods/routes', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir('helmx-omnibox-http-val-')
  t.after(() => cleanupDir(dir), { timeout: 60_000 })

  const kernel = await openRuntime(join(dir, 'data'))
  t.after(() => kernel.close(), { timeout: 60_000 })

  const badUrls = [
    '/api/omnibox/search',
    '/api/omnibox/search?q=',
    '/api/omnibox/search?q=%20%20',
    `/api/omnibox/search?q=${'a'.repeat(1001)}`,
    `/api/omnibox/search?q=${encodeURIComponent(Array.from({ length: 33 }, (_, i) => `t${i}`).join(' '))}`,
    '/api/omnibox/search?q=ok&limit=0',
    '/api/omnibox/search?q=ok&limit=101',
    '/api/omnibox/search?q=ok&limit=abc',
    '/api/omnibox/search?q=ok&limit=1.5',
    '/api/omnibox/search?q=ok&locale=fr',
    '/api/omnibox/search?q=ok&locale=',
    '/api/omnibox/search?q=ok&conversationId=0',
    '/api/omnibox/search?q=ok&conversationId=-3',
    '/api/omnibox/search?q=ok&conversationId=abc',
  ]
  for (const url of badUrls) {
    const res = await apiJson<{ error: { code: string } }>(kernel, 'GET', url)
    assert.equal(res.status, 400, `expected 400 for ${url}, got ${res.status}`)
    assert.equal(res.body.error.code, 'validation_error', `expected validation_error for ${url}`)
  }

  const postRes = await apiJson<{ error: { code: string } }>(kernel, 'POST', '/api/omnibox/search?q=ok')
  assert.equal(postRes.status, 405)
  assert.equal(postRes.body.error.code, 'method_not_allowed')

  const extraRes = await apiJson<{ error: { code: string } }>(kernel, 'GET', '/api/omnibox/search/extra')
  assert.equal(extraRes.status, 404)
})

test('HTTP routes return honest 501 not_supported when listConfigCatalog or consumeCapability is unwired', { timeout: 60_000 }, async () => {
  const minimalStub = {
    conversations: { search: () => [] },
    plugins: { list: () => [] },
  }
  const catalogRes = await handleApi(new Request('http://hub/api/plugins/config-catalog'), minimalStub as never)
  assert.equal(catalogRes.status, 501)
  assert.equal(((await catalogRes.json()) as { error: { code: string } }).error.code, 'not_supported')

  const omniboxRes = await handleApi(new Request('http://hub/api/omnibox/search?q=hello'), minimalStub as never)
  assert.equal(omniboxRes.status, 501)
  assert.equal(((await omniboxRes.json()) as { error: { code: string } }).error.code, 'not_supported')
})
