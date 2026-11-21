/**
 * builtin:magpie 插件 client 组件测试（真实编译产物 + 共享宿主 SDK + DOM 事件）。
 *
 * 覆盖：
 * - settingsPanel（状态概览 KV、自动刷新间隔、诊断 / 配额 / 路由三表、缓存计数标注、
 *   刷新动作与失败显式错误、加载态与空态）；
 * - MagpieComposerQuotaStatus（单账号直出、多账号单主账号外层 + 点击 Radix Popover 列表、
 *   当前模型池严格过滤、待命页 tier/<id> 解引用、原始单位与报错诚实展示、前台自动刷新单飞去重）。
 */
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { ComposerStatusSlotProps, ConversationSummary, PluginClientContext as PluginClientContextType } from '@helmx/protocol'
import { ensureHappyDom } from './helpers/dom-harness.js'

ensureHappyDom()
const { createRoot } = await import('react-dom/client')
const { PluginClientContext, resolveLocalizedText } = await import('@helmx/plugin-client')
const { importBuiltinClientModule, mountSharedPluginNamespaces, setBuiltinClientStub } = await import('./helpers/builtin-clients.js')
const { selectModelQuotas, resolveEffectiveMagpieModel, resolveRefreshIntervalSec } = await import('../../plugins/src/magpie/client/quota-model.js')
const { parseStatus } = await import('../../plugins/src/magpie/client/models.js')
const {
  noteMagpieManualRefresh,
  resetMagpieAutoRefreshForTest,
  subscribeMagpieAutoRefresh,
} = await import('../../plugins/src/magpie/client/auto-refresh.js')
type HelmxLocale = 'en' | 'zh-CN'

const e = React.createElement

mountSharedPluginNamespaces()

let MagpieSettingsPanel: () => React.ReactElement
let MagpieComposerQuotaStatus: (props: ComposerStatusSlotProps) => React.ReactElement | null

before(async () => {
  const mod = await importBuiltinClientModule('builtin:magpie')
  MagpieSettingsPanel = mod['MagpieSettingsPanel'] as () => React.ReactElement
  MagpieComposerQuotaStatus = mod['MagpieComposerQuotaStatus'] as (props: ComposerStatusSlotProps) => React.ReactElement | null
}, { timeout: 60_000 })

interface SpyCtx extends PluginClientContextType {
  actionCalls: Array<{ actionId: string; input: unknown }>
}

function makeSpyCtx(locale: HelmxLocale = 'en'): SpyCtx {
  const actionCalls: Array<{ actionId: string; input: unknown }> = []
  const base: PluginClientContextType = {
    pluginId: 'builtin:magpie',
    callAction: async (actionId, input) => {
      actionCalls.push({ actionId, input })
      return {}
    },
    submitInput: async () => {},
    openScreen: () => {},
    openSplitScreen: () => {},
    openConversationDrawer: () => {},
    openArtifact: () => {},
    openWorkbench: () => {},
    closeWorkbench: () => {},
    notify: () => {},
    getPluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    theme: 'dark',
    locale,
    translate: (text) => resolveLocalizedText(text, locale),
  }
  return Object.assign(base, { actionCalls })
}

async function mount(
  ctx: PluginClientContextType,
): Promise<{ host: HTMLElement; unmount: () => void }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(e(PluginClientContext.Provider, { value: ctx }, e(MagpieSettingsPanel, {})))
  })
  await act(async () => {})
  return {
    host,
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

function makeConversation(model: string): ConversationSummary {
  return {
    id: 1,
    title: 'Conv 1',
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model,
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 0,
    updatedAt: 0,
  }
}

async function mountComposerQuota(
  ctx: PluginClientContextType,
  props: ComposerStatusSlotProps,
): Promise<{ host: HTMLElement; unmount: () => void }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(e(PluginClientContext.Provider, { value: ctx }, e(MagpieComposerQuotaStatus, props)))
  })
  await act(async () => {})
  return {
    host,
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

const STATUS_DOC = {
  gatewayUrl: 'http://127.0.0.1:3425',
  configuredRoot: false,
  local: true,
  reachable: true,
  modelCount: 12,
  groupCount: 2,
  lastRefreshedAt: 1_800_000_000_000,
  summaryText: 'Magpie · 12 模型',
  modelOwners: {},
  quotas: [
    { provider: 'opencode-go', account: 'team', windowLabel: '5h', remainingPercent: 16, resetText: '3h' },
    { provider: 'moonshot', windowLabel: 'daily', remainingPercent: 60 },
  ],
  routes: [
    { group: 'relay', strategy: 'round-robin', provider: 'opencode-go', model: 'glm-4.7', timestamp: '2026-11-10T12:00:00Z' },
  ],
  diagnostics: [],
}

const MULTI_ACCOUNT_DOC = {
  ...STATUS_DOC,
  quotasRefreshedAt: 1_800_000_000_000,
  modelOwners: {
    'auto/gemini-4-carbon': 'antigravity-bridge',
    'auto/claude-sonnet-4.6': 'antigravity-bridge',
    'auto/glm-5.3': 'zhipu',
    'auto/gpt-6.2-sol': 'newapi',
    'codex/gpt-5.2': 'codex',
    'ai-studio/gemini-flash': 'ai-studio',
    'workbuddy/wb-1': 'workbuddy',
  },
  quotas: [
    // antigravity-bridge: 2 accounts, each with Gemini + Claude & GPT pools + a third account with Claude-only pool
    { provider: 'antigravity-bridge', account: 'ites', windowLabel: 'Gemini · 7 days', pool: 'Gemini', remainingPercent: 100, resetText: '2026-11-28' },
    { provider: 'antigravity-bridge', account: 'ites', windowLabel: 'Gemini · 5 hours', pool: 'Gemini', remainingPercent: 100, resetText: '5h' },
    { provider: 'antigravity-bridge', account: 'ites', windowLabel: 'Claude & GPT · 7 days', pool: 'Claude & GPT', remainingPercent: 100, resetText: '2026-11-28' },
    { provider: 'antigravity-bridge', account: 'halt', last: true, windowLabel: 'Gemini · 7 days', pool: 'Gemini', remainingPercent: 99, resetText: '2026-11-28' },
    { provider: 'antigravity-bridge', account: 'halt', last: true, windowLabel: 'Gemini · 5 hours', pool: 'Gemini', remainingPercent: 96, resetText: '2h' },
    { provider: 'antigravity-bridge', account: 'halt', last: true, windowLabel: 'Claude & GPT · 7 days', pool: 'Claude & GPT', remainingPercent: 80, resetText: '2026-11-28' },
    { provider: 'antigravity-bridge', account: 'halt', last: true, windowLabel: 'Claude & GPT · 5 hours', pool: 'Claude & GPT', remainingPercent: 75, resetText: '4h' },
    { provider: 'antigravity-bridge', account: 'claude-only', windowLabel: 'Claude & GPT · 5 hours', pool: 'Claude & GPT', remainingPercent: 50, resetText: '3h' },
    // zhipu: single account with primary 5h + MCP side window
    { provider: 'zhipu', account: 'max', windowLabel: 'MCP · Month', remainingPercent: 100, resetText: '2026-11-28' },
    { provider: 'zhipu', account: 'max', windowLabel: '5 hours', remainingPercent: 99, resetText: '4h' },
    // codex: includes non-chat Image generation window
    { provider: 'codex', account: 'dev@example.com', windowLabel: '5 hours', remainingPercent: 88, resetText: '1h' },
    { provider: 'codex', account: 'dev@example.com', windowLabel: 'Image generation', remainingPercent: 100 },
    // workbuddy: mixed raw unit & unlimited
    { provider: 'workbuddy', account: 'Jay', windowLabel: 'Credits', remainingPercent: -1, displayText: '0 / 6900' },
    { provider: 'workbuddy', account: 'Jay', windowLabel: 'Extra', remainingPercent: -1, unlimited: true, displayText: '∞' },
    // ai-studio: error-only account
    { provider: 'ai-studio', account: 'key-a03f', remainingPercent: -1, error: 'no admin API available', windowLabel: 'error: no admin API available' },
  ],
}

before(() => {
  setBuiltinClientStub({ docs: { status: STATUS_DOC } })
})

test('前台自动刷新：默认 5s 生效、分屏双实例单飞去重不重复发请求', { timeout: 60_000 }, async () => {
  setBuiltinClientStub({
    docs: { status: MULTI_ACCOUNT_DOC },
    config: { refreshIntervalSec: 5 },
  })
  try {
    let resolveFirst!: () => void
    const firstGate = new Promise<void>((r) => {
      resolveFirst = r
    })
    const spy = makeSpyCtx('en')
    spy.callAction = async (actionId, input) => {
      spy.actionCalls.push({ actionId, input })
      await firstGate
      return { refreshed: true, modelCount: 6, reachable: true }
    }
    const pane1 = await mountComposerQuota(spy, { conversation: makeConversation('magpie/auto/gemini-4-carbon') })
    const pane2 = await mountComposerQuota(spy, { conversation: makeConversation('magpie/auto/glm-5.3') })
    try {
      assert.equal(spy.actionCalls.length, 1, '主屏 + 分屏同时挂载只发 1 次单飞刷新')
      assert.deepEqual(spy.actionCalls[0], { actionId: 'refresh', input: { onlyIfChanged: true } })
      resolveFirst()
      await act(async () => {})
    } finally {
      pane1.unmount()
      pane2.unmount()
    }
  } finally {
    setBuiltinClientStub({ docs: { status: STATUS_DOC } })
  }
})

test('状态概览：KV 网关地址 / 可达 / 模型数 / 路由组数 / 最近刷新', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx()
  const { host, unmount } = await mount(spy)
  try {
    assert.match(host.textContent ?? '', /Magpie Gateway/, '标题')
    assert.match(host.textContent ?? '', /Magpie · 12 模型/, 'summaryText')
    assert.match(host.textContent ?? '', /http:\/\/127\.0\.0\.1:3425/, '网关地址')
    assert.match(host.textContent ?? '', /Local loopback/, 'KV 键')
    assert.match(host.textContent ?? '', /Models/, '可达时模型数不带缓存标注')
    assert.match(host.textContent ?? '', /Route groups/, 'KV 键')
    assert.match(host.textContent ?? '', /Auto-refresh interval/, '自动刷新间隔 KV 键')
    assert.match(host.textContent ?? '', /5s/, '默认 5 秒刷新间隔')
    assert.doesNotMatch(host.textContent ?? '', /Models \(cached\)/, 'reachable=true 不标注缓存')
    assert.doesNotMatch(host.textContent ?? '', /Last error/, '无错误时不渲染最近错误行')
  } finally {
    unmount()
  }
})

test('配额与路由轨迹表渲染（窗口 / 剩余 / 重置 / 命中模型）', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx()
  const { host, unmount } = await mount(spy)
  try {
    assert.match(host.textContent ?? '', /Diagnostics/, '诊断区块标题')
    assert.match(host.textContent ?? '', /No diagnostics/, '空诊断如实展示')
    assert.match(host.textContent ?? '', /Quotas/, '配额区块标题')
    assert.match(host.textContent ?? '', /opencode-go/, '配额 provider')
    assert.match(host.textContent ?? '', /5h/, '窗口列')
    assert.match(host.textContent ?? '', /3h/, '重置列')
    assert.match(host.textContent ?? '', /moonshot/, '第二行 provider')
    assert.match(host.textContent ?? '', /Route history/, '路由区块标题')
    assert.match(host.textContent ?? '', /relay/, '路由组')
    assert.match(host.textContent ?? '', /round-robin/, '策略')
    assert.match(host.textContent ?? '', /glm-4\.7/, '命中模型')
  } finally {
    unmount()
  }
})

test('reachable=false 时模型数标注缓存、lastError 与诊断如实展示', { timeout: 60_000 }, async () => {
  setBuiltinClientStub({
    docs: {
      status: {
        ...STATUS_DOC,
        reachable: false,
        modelCount: 5,
        summaryText: 'Magpie · 未连接',
        lastError: 'connect ECONNREFUSED',
        diagnostics: ['配额不可用：timeout'],
      },
    },
  })
  try {
    const spy = makeSpyCtx()
    const { host, unmount } = await mount(spy)
    try {
      assert.match(host.textContent ?? '', /Models \(cached\)/, '不可达时标注缓存计数')
      assert.match(host.textContent ?? '', /connect ECONNREFUSED/, 'lastError 如实展示')
      assert.match(host.textContent ?? '', /配额不可用：timeout/, '诊断如实展示')
      assert.match(host.textContent ?? '', /Magpie · 未连接/, 'summaryText 未连接')
    } finally {
      unmount()
    }
  } finally {
    setBuiltinClientStub({ docs: { status: STATUS_DOC } })
  }
})

test('刷新按钮触发 refresh 动作；失败显式展示错误', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx()
  const { host, unmount } = await mount(spy)
  try {
    const refresh = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Refresh model catalog'))
    assert.ok(refresh, '刷新按钮存在')
    await act(async () => {
      refresh!.click()
    })
    assert.deepEqual(
      spy.actionCalls.map((c) => ({ actionId: c.actionId, input: c.input })),
      [{ actionId: 'refresh', input: {} }],
      '点击触发 refresh 动作',
    )
  } finally {
    unmount()
  }
  const failing = makeSpyCtx()
  failing.callAction = async () => {
    throw new Error('网关不可达')
  }
  const { host: host2, unmount: unmount2 } = await mount(failing)
  try {
    const refresh = [...host2.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Refresh model catalog'))
    await act(async () => {
      refresh!.click()
    })
    await act(async () => {})
    assert.match(host2.textContent ?? '', /网关不可达/, '刷新失败显式展示错误')
  } finally {
    unmount2()
  }
})

test('doc 未到达展示加载态、空 doc 展示空表', { timeout: 60_000 }, async () => {
  setBuiltinClientStub({ docs: { status: undefined } })
  try {
    const spy = makeSpyCtx()
    const { host, unmount } = await mount(spy)
    try {
      assert.match(host.textContent ?? '', /Loading gateway status…/, '加载态展示')
    } finally {
      unmount()
    }
    setBuiltinClientStub({ docs: { status: { ...STATUS_DOC, quotas: [], routes: [], diagnostics: [], summaryText: '' } } })
    const { host: host2, unmount: unmount2 } = await mount(spy)
    try {
      assert.match(host2.textContent ?? '', /No quota data/, '空配额如实展示')
      assert.match(host2.textContent ?? '', /No route history/, '空路由如实展示')
      assert.match(host2.textContent ?? '', /No diagnostics/, '空诊断如实展示')
      assert.doesNotMatch(host2.textContent ?? '', /Loading gateway status/, '空 doc 不残留加载态')
    } finally {
      unmount2()
    }
  } finally {
    setBuiltinClientStub({ docs: { status: STATUS_DOC } })
  }
})

test('zh-CN locale：Magpie 设置面板切为中文表头与 KV 文案', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mount(makeSpyCtx('zh-CN'))
  try {
    assert.match(host.textContent ?? '', /Magpie 网关/)
    assert.match(host.textContent ?? '', /刷新模型目录/)
    assert.match(host.textContent ?? '', /本机 loopback/)
    assert.match(host.textContent ?? '', /自动刷新间隔/)
    assert.match(host.textContent ?? '', /5s/)
    assert.match(host.textContent ?? '', /无诊断信息/)
    assert.match(host.textContent ?? '', /路由轨迹/)
  } finally {
    unmount()
  }
})

test('Composer 状态栏：非 Magpie 模型返回 null 且不触发刷新', { timeout: 60_000 }, async () => {
  setBuiltinClientStub({ docs: { status: MULTI_ACCOUNT_DOC }, config: { refreshIntervalSec: 0 } })
  try {
    const spy = makeSpyCtx()
    const { host, unmount } = await mountComposerQuota(spy, {
      conversation: makeConversation('anthropic/claude-sonnet-4-6'),
    })
    try {
      assert.equal(host.textContent, '')
      assert.equal(spy.actionCalls.length, 0)
    } finally {
      unmount()
    }
  } finally {
    setBuiltinClientStub({ docs: { status: STATUS_DOC } })
  }
})

test('Composer 状态栏单账号模型：直接平铺当前模型窗口，剔除 MCP 辅窗口与生图窗口，不显示多账号角标', { timeout: 60_000 }, async () => {
  setBuiltinClientStub({ docs: { status: MULTI_ACCOUNT_DOC }, config: { refreshIntervalSec: 0 } })
  try {
    const spy = makeSpyCtx('zh-CN')
    const zhipuMount = await mountComposerQuota(spy, {
      conversation: makeConversation('magpie/auto/glm-5.3'),
    })
    try {
      const text = zhipuMount.host.textContent ?? ''
      assert.match(text, /5h/)
      assert.match(text, /99%/)
      assert.match(text, /\(4h\)/)
      assert.doesNotMatch(text, /MCP/, '存在主模型窗口时剔除 MCP 辅窗口')
      assert.doesNotMatch(text, /zhipu/, '不显示冗余 provider 前缀')
      assert.ok(zhipuMount.host.querySelector('.magpie-quota-trigger-more') === null, '单账号不显示 +N 角标')
    } finally {
      zhipuMount.unmount()
    }

    const codexMount = await mountComposerQuota(spy, {
      conversation: makeConversation('magpie/codex/gpt-5.2'),
    })
    try {
      const text = codexMount.host.textContent ?? ''
      assert.match(text, /5h/)
      assert.match(text, /88%/)
      assert.doesNotMatch(text, /Image/, '聊天模型剔除 Image generation 生图窗口')
    } finally {
      codexMount.unmount()
    }
  } finally {
    setBuiltinClientStub({ docs: { status: STATUS_DOC } })
  }
})

test('Composer 状态栏多账号模型：外层仅展示主账号单账号额度 + (+1) 角标；点开列表仅展示当前模型相关账号与池子窗口', { timeout: 60_000 }, async () => {
  setBuiltinClientStub({ docs: { status: MULTI_ACCOUNT_DOC }, config: { refreshIntervalSec: 0 } })
  try {
    const spy = makeSpyCtx('zh-CN')
    const { host, unmount } = await mountComposerQuota(spy, {
      conversation: makeConversation('magpie/auto/gemini-4-carbon'),
    })
    try {
      const trigger = host.querySelector<HTMLButtonElement>('button.magpie-quota-trigger')
      assert.ok(trigger !== null, '渲染紧凑状态栏触发按钮')
      const triggerText = trigger.textContent ?? ''
      // 主账号 halt (last: true) 的 Gemini 窗口
      assert.match(triggerText, /5h.*96%.*\(2h\)/, '外层直接展示主账号 5h 窗口')
      assert.match(triggerText, /7d.*99%/, '外层直接展示主账号 7d 窗口')
      assert.match(triggerText, /\+1/, '有 1 个其他相关账号（ites），claude-only 已剔除')
      assert.doesNotMatch(triggerText, /Claude/, '外层不得泄漏 Claude & GPT 池')
      assert.doesNotMatch(triggerText, /ites/, '外层仅展示单账号信息，不平铺第二个账号')
      assert.doesNotMatch(triggerText, /zhipu|codex/, '不得泄漏其他 provider')

      // 点击弹出列表（Radix Popover）
      await act(async () => {
        trigger.click()
      })
      const popover = document.body.querySelector<HTMLElement>('.magpie-quota-popover')
      assert.ok(popover !== null, '点击弹出 Radix Popover 列表')
      const popText = popover.textContent ?? ''
      assert.match(popText, /gemini-4-carbon/, '标题显示当前模型短名')
      assert.match(popText, /halt/, '包含主账号 halt')
      assert.match(popText, /当前/, '多账号列表标注当前主账号')
      assert.match(popText, /ites/, '包含同模型另一个相关账号 ites')
      assert.doesNotMatch(popText, /claude-only/, '不含该模型池子的账号整张剔除')
      assert.doesNotMatch(popText, /Claude & GPT/, '列表内彻底剔除同账号下的无关模型池')
      assert.doesNotMatch(popText, /zhipu|codex|workbuddy/, '列表内彻底剔除无关供应商')

      // 点击列表内手动刷新按钮触发强制 refresh({})
      const refreshBtn = popover.querySelector<HTMLButtonElement>('button[aria-label="立即刷新"]')
      assert.ok(refreshBtn !== null, 'Popover 内含手动立即刷新按钮')
      await act(async () => {
        refreshBtn.click()
      })
      assert.deepEqual(
        spy.actionCalls.map((c) => ({ actionId: c.actionId, input: c.input })),
        [{ actionId: 'refresh', input: {} }],
      )
    } finally {
      unmount()
    }
  } finally {
    setBuiltinClientStub({ docs: { status: STATUS_DOC } })
  }
})

test('Composer 状态栏：支持待命页 effectiveModel 的 tier/<id> 解引用、原始单位与报错诚实展示', { timeout: 60_000 }, async () => {
  setBuiltinClientStub({
    docs: { status: MULTI_ACCOUNT_DOC },
    config: { refreshIntervalSec: 0 },
    hostModels: {
      models: [],
      modelTiers: [
        { id: 'architect', model: 'magpie/auto/gemini-4-carbon', available: true, thinkingLevels: ['high'] },
      ],
    },
  })
  try {
    const spy = makeSpyCtx('en')
    // 1) 待命页 tier/architect 解引用到 magpie/auto/gemini-4-carbon
    const tierMount = await mountComposerQuota(spy, {
      effectiveModel: 'tier/architect',
      profileId: 'assistant',
    })
    try {
      const text = tierMount.host.textContent ?? ''
      assert.match(text, /5h.*96%/)
      assert.match(text, /\+1/)
    } finally {
      tierMount.unmount()
    }

    // 2) 非百分比单位（0 / 6900 与 ∞）原样保留
    const unitsMount = await mountComposerQuota(spy, {
      conversation: makeConversation('magpie/workbuddy/wb-1'),
    })
    try {
      const text = unitsMount.host.textContent ?? ''
      assert.match(text, /0 \/ 6900/)
      assert.match(text, /∞/)
    } finally {
      unitsMount.unmount()
    }

    // 3) 报错账号诚实展示 Quota n/a，点开看错误原文
    const errMount = await mountComposerQuota(spy, {
      conversation: makeConversation('magpie/ai-studio/gemini-flash'),
    })
    try {
      assert.match(errMount.host.textContent ?? '', /Quota n\/a/)
      const btn = errMount.host.querySelector<HTMLButtonElement>('button.magpie-quota-trigger')
      assert.ok(btn !== null)
      await act(async () => {
        btn.click()
      })
      const pop = document.body.querySelector<HTMLElement>('.magpie-quota-popover')
      assert.ok(pop !== null)
      assert.match(pop.textContent ?? '', /no admin API available/)
    } finally {
      errMount.unmount()
    }
  } finally {
    setBuiltinClientStub({ docs: { status: STATUS_DOC } })
  }
})

test('quota-model 与 auto-refresh 纯逻辑：版本专属池优先、刷新间隔钳位、定时触发与单飞抑制', { timeout: 60_000 }, async () => {
  assert.equal(resolveRefreshIntervalSec(undefined), 5)
  assert.equal(resolveRefreshIntervalSec({ refreshIntervalSec: 0 }), 0)
  assert.equal(resolveRefreshIntervalSec({ refreshIntervalSec: 12 }), 12)
  assert.equal(resolveRefreshIntervalSec({ refreshIntervalSec: 99999 }), 3600)

  const model = resolveEffectiveMagpieModel('magpie/auto/gemini-4-argon')
  assert.ok(model !== null)
  const status = parseStatus({
    ...MULTI_ACCOUNT_DOC,
    modelOwners: { 'auto/gemini-4-argon': 'antigravity-bridge' },
    quotas: [
      { provider: 'antigravity-bridge', account: 'halt', windowLabel: 'Gemini · 5 hours', pool: 'Gemini', remainingPercent: 90 },
      { provider: 'antigravity-bridge', account: 'halt', windowLabel: 'Gemini 4 Argon · 5 hours', pool: 'Gemini 4 Argon', remainingPercent: 42 },
      { provider: 'antigravity-bridge', account: 'halt', windowLabel: 'Claude & GPT · 5 hours', pool: 'Claude & GPT', remainingPercent: 100 },
    ],
  })
  const summary = selectModelQuotas(model, status, 1_800_000_000_000)
  assert.equal(summary.accounts.length, 1)
  assert.equal(summary.primary?.windows.length, 1, '精确版本池命中的窗口优先于泛家族池')
  assert.equal(summary.primary?.windows[0]?.remainingPercent, 42)

  // auto-refresh 协调器单飞 + 手动刷新抑制 + 0ms 关闭
  resetMagpieAutoRefreshForTest()
  try {
    let calls = 0
    const unsubOff = subscribeMagpieAutoRefresh({
      intervalMs: 0,
      run: async () => {
        calls += 1
      },
    })
    assert.equal(calls, 0, 'intervalMs=0 不触发刷新')
    unsubOff()

    noteMagpieManualRefresh(Date.now())
    const unsubRecent = subscribeMagpieAutoRefresh({
      intervalMs: 5000,
      run: async () => {
        calls += 1
      },
    })
    assert.equal(calls, 0, '刚手动刷新完不立刻重发自动刷新')
    unsubRecent()
  } finally {
    resetMagpieAutoRefreshForTest()
  }
})
