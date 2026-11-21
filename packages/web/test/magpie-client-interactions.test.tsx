/**
 * builtin:magpie 插件 client 组件测试（真实编译产物 + 共享宿主 SDK + DOM 事件）。
 *
 * 覆盖：
 * - settingsPanel（状态概览 KV、自动刷新间隔、诊断 / 配额双表与开关隐藏、缓存计数标注、
 *   刷新动作与失败显式错误、加载态与空态、无路由追踪区）；
 * - MagpieComposerQuotaStatus（单账号直出、省略泛化 Subscription/Quota 标签、多账号单主账号外层 +
 *   点击 Radix Popover 列表与右上角 X 关闭按钮、showQuotaStatus 开关默认开启与关闭停轮询、
 *   当前模型池严格过滤、待命页 tier/<id> 解引用、原始单位与报错诚实展示、前台自动刷新单飞去重）。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { describe, before, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { ComposerStatusSlotProps, ConversationSummary, PluginClientContext as PluginClientContextType } from '@helmx/protocol'
import { ensureHappyDom } from './helpers/dom-harness.js'

ensureHappyDom()
const { createRoot } = await import('react-dom/client')
const { PluginClientContext, resolveLocalizedText } = await import('@helmx/plugin-client')
const { importBuiltinClientModule, mountSharedPluginNamespaces, setBuiltinClientStub } = await import('./helpers/builtin-clients.js')
const {
  isAccountExhausted,
  selectModelQuotas,
  resolveEffectiveMagpieModel,
  resolveRefreshIntervalSec,
  resolveShowQuotaStatus,
  shouldShowInlineWindowLabel,
} = await import('../../plugins/src/magpie/client/quota-model.js')
const { parseStatus } = await import('../../plugins/src/magpie/client/models.js')
const {
  noteMagpieManualRefresh,
  resetMagpieAutoRefreshForTest,
  subscribeMagpieAutoRefresh,
} = await import('../../plugins/src/magpie/client/auto-refresh.js')
type HelmxLocale = 'en' | 'zh-CN'

const e = React.createElement

let MagpieSettingsPanel: () => React.ReactElement
let MagpieComposerQuotaStatus: (props: ComposerStatusSlotProps) => React.ReactElement | null
describe("magpie-client-interactions", () => {


  before(async () => {
    mountSharedPluginNamespaces()
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
    lastRefreshedAt: 1_800_000_000_000,
    summaryText: 'Magpie · 12 模型',
    modelOwners: {},
    quotas: [
      { provider: 'opencode-go', account: 'team', windowLabel: '5h', remainingPercent: 16, resetText: '3h' },
      { provider: 'moonshot', windowLabel: 'daily', remainingPercent: 60 },
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

  test('状态概览：KV 网关地址 / 可达 / 模型数 / 自动刷新间隔 / 最近刷新（无路由组项）', { timeout: 60_000 }, async () => {
    const spy = makeSpyCtx()
    const { host, unmount } = await mount(spy)
    try {
      assert.match(host.textContent ?? '', /Magpie Gateway/, '标题')
      assert.match(host.textContent ?? '', /Magpie · 12 模型/, 'summaryText')
      assert.match(host.textContent ?? '', /http:\/\/127\.0\.0\.1:3425/, '网关地址')
      assert.match(host.textContent ?? '', /Local loopback/, 'KV 键')
      assert.match(host.textContent ?? '', /Models/, '可达时模型数不带缓存标注')
      assert.doesNotMatch(host.textContent ?? '', /Route groups/, '已移除路由组数 KV 项')
      assert.match(host.textContent ?? '', /Auto-refresh interval/, '自动刷新间隔 KV 键')
      assert.match(host.textContent ?? '', /5s/, '默认 5 秒刷新间隔')
      assert.doesNotMatch(host.textContent ?? '', /Models \(cached\)/, 'reachable=true 不标注缓存')
      assert.doesNotMatch(host.textContent ?? '', /Last error/, '无错误时不渲染最近错误行')
    } finally {
      unmount()
    }
  })

  test('诊断与配额表渲染（窗口 / 剩余 / 重置，不含路由轨迹区）', { timeout: 60_000 }, async () => {
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
      assert.doesNotMatch(host.textContent ?? '', /Route history/, '已移除路由轨迹区')
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
      setBuiltinClientStub({ docs: { status: { ...STATUS_DOC, quotas: [], diagnostics: [], summaryText: '' } } })
      const { host: host2, unmount: unmount2 } = await mount(spy)
      try {
        assert.match(host2.textContent ?? '', /No quota data/, '空配额如实展示')
        assert.match(host2.textContent ?? '', /No diagnostics/, '空诊断如实展示')
        assert.doesNotMatch(host2.textContent ?? '', /Route history/, '不渲染路由轨迹区')
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
      assert.match(host.textContent ?? '', /配额/)
      assert.doesNotMatch(host.textContent ?? '', /路由轨迹|路由组数/)
    } finally {
      unmount()
    }
  })

  test('showQuotaStatus 配置开关：默认开启；关闭后隐藏状态栏与设置面板配额并停止前台轮询', { timeout: 60_000 }, async () => {
    assert.equal(resolveShowQuotaStatus(undefined), true, '缺省默认显示配额')
    assert.equal(resolveShowQuotaStatus({}), true, '未显式配置时默认显示配额')
    assert.equal(resolveShowQuotaStatus({ showQuotaStatus: true }), true)
    assert.equal(resolveShowQuotaStatus({ showQuotaStatus: false }), false)

    setBuiltinClientStub({
      docs: { status: MULTI_ACCOUNT_DOC },
      config: { showQuotaStatus: false, refreshIntervalSec: 5 },
    })
    try {
      const spy = makeSpyCtx('zh-CN')
      const composerMount = await mountComposerQuota(spy, {
        conversation: makeConversation('magpie/auto/gemini-4-carbon'),
      })
      try {
        assert.equal(composerMount.host.textContent, '', '关闭配额开关后状态栏返回 null')
        assert.equal(spy.actionCalls.length, 0, '关闭配额开关后不启动前台自动刷新轮询')
      } finally {
        composerMount.unmount()
      }

      const panelMount = await mount(spy)
      try {
        const text = panelMount.host.textContent ?? ''
        assert.match(text, /Magpie 网关/)
        assert.match(text, /已关闭/, '关闭配额展示时状态概览如实标示自动刷新已关闭')
        assert.doesNotMatch(text, /配额/, '关闭配额开关后设置面板隐藏配额表区块')
      } finally {
        panelMount.unmount()
      }
    } finally {
      setBuiltinClientStub({ docs: { status: STATUS_DOC }, config: {} })
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

        // 点击右上角 X 关闭按钮可收起 Popover
        const closeBtn = popover.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')
        assert.ok(closeBtn !== null, 'Popover 右上角含关闭按钮')
        await act(async () => {
          closeBtn.click()
        })
        assert.ok(document.body.querySelector('.magpie-quota-popover') === null, '点击关闭按钮后收起 Popover')
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

  test('Composer 状态栏多账号优先策略：已耗尽账号（含 order 靠前或 last: true）让位给仍有余量的账号', { timeout: 60_000 }, async () => {
    // 1) 真实场景：newapi 首账号 blue 已 0%，次账号 fjay 仍有 78% → 折叠状态栏优先展示 fjay，弹窗将 fjay 排第一并保留 blue
    const exhaustedFirstDoc = {
      ...MULTI_ACCOUNT_DOC,
      modelOwners: {
        'auto/gpt-6.2-sol': 'newapi',
        'auto/gemini-4-neon': 'antigravity-bridge',
      },
      quotas: [
        {
          provider: 'newapi',
          account: 'blue',
          windowLabel: 'Subscription',
          remainingPercent: 0,
          displayText: '$199.54 / $200.00',
          resetText: '2h',
          last: true,
          lastServedAt: '2026-11-21T14:10:00Z',
        },
        {
          provider: 'newapi',
          account: 'fjay',
          windowLabel: 'Subscription',
          remainingPercent: 78,
          displayText: '$44.96 / $200.00',
          resetText: '2h',
        },
        // 限流合取窗口：5h 归零（即便 7d 仍有 90% 且 last: true）视为已耗尽，让位给可用账号 randal
        {
          provider: 'antigravity-bridge',
          account: 'halt',
          windowLabel: 'Gemini · 5 hours',
          pool: 'Gemini',
          remainingPercent: 0,
          resetText: '3h',
          last: true,
        },
        {
          provider: 'antigravity-bridge',
          account: 'halt',
          windowLabel: 'Gemini · 7 days',
          pool: 'Gemini',
          remainingPercent: 90,
          resetText: '2026-11-28',
          last: true,
        },
        {
          provider: 'antigravity-bridge',
          account: 'randal',
          windowLabel: 'Gemini · 5 hours',
          pool: 'Gemini',
          remainingPercent: 100,
          resetText: '5h',
        },
        {
          provider: 'antigravity-bridge',
          account: 'randal',
          windowLabel: 'Gemini · 7 days',
          pool: 'Gemini',
          remainingPercent: 100,
          resetText: '2026-11-28',
        },
      ],
    }

    setBuiltinClientStub({ docs: { status: exhaustedFirstDoc }, config: { refreshIntervalSec: 0 } })
    try {
      const spy = makeSpyCtx('zh-CN')
      const newapiMount = await mountComposerQuota(spy, {
        conversation: makeConversation('magpie/auto/gpt-6.2-sol'),
      })
      try {
        assert.equal(shouldShowInlineWindowLabel('Subscription'), false, '状态栏省略泛化 Subscription 标签')
        assert.equal(shouldShowInlineWindowLabel('Quota'), false, '状态栏省略泛化 Quota 标签')
        assert.equal(shouldShowInlineWindowLabel('5h'), true, '状态栏保留有区分度的 5h 窗口标签')
        assert.equal(shouldShowInlineWindowLabel('Credits'), true, '状态栏保留 Credits 窗口标签')

        const trigger = newapiMount.host.querySelector<HTMLButtonElement>('button.magpie-quota-trigger')
        assert.ok(trigger !== null)
        const triggerText = trigger.textContent ?? ''
        assert.doesNotMatch(triggerText, /Subscription/, '状态栏折叠摘要不显示冗余 Subscription 标签')
        assert.match(triggerText, /78%.*\(2h\)/, '折叠时优先显示有额度的 fjay 而非 0% 的 blue')
        assert.match(triggerText, /\+1/, '仍显示 +1 多账号角标')
        assert.equal(trigger.classList.contains('magpie-quota-trigger--err'), false, '主展示账号有余量时不染红报警')

        await act(async () => {
          trigger.click()
        })
        const popover = document.body.querySelector<HTMLElement>('.magpie-quota-popover')
        assert.ok(popover !== null)
        assert.match(popover.textContent ?? '', /Subscription/, 'Popover 详情保留完整窗口名称 Subscription')
        const accountNames = [...popover.querySelectorAll('.magpie-quota-account-name')].map((el) => el.textContent)
        assert.deepEqual(accountNames, ['fjay', 'blue'], '展开列表有余量账号排首、已耗尽账号排后保留可见')
      } finally {
        newapiMount.unmount()
      }

      const geminiMount = await mountComposerQuota(spy, {
        conversation: makeConversation('magpie/auto/gemini-4-neon'),
      })
      try {
        const triggerText = geminiMount.host.textContent ?? ''
        assert.match(triggerText, /5h.*100%/, '5h 限流窗口归零的 last 账号让位给仍有额度的 randal')
        assert.match(triggerText, /7d.*100%/)
      } finally {
        geminiMount.unmount()
      }
    } finally {
      setBuiltinClientStub({ docs: { status: STATUS_DOC } })
    }

    // 2) 纯逻辑边界：加法积分池、预付余额、全耗尽回退与报错账号对比
    const wbModel = resolveEffectiveMagpieModel('magpie/workbuddy/wb-1')
    assert.ok(wbModel !== null)
    const wbStatus = parseStatus({
      ...MULTI_ACCOUNT_DOC,
      quotas: [
        // 基础 Credits=0%，但 Extra credits=100% / Total credits=94% → 仍有余量，不误判耗尽
        { provider: 'workbuddy', account: 'primary-with-extra', windowLabel: 'Credits', remainingPercent: 0, last: true },
        { provider: 'workbuddy', account: 'primary-with-extra', windowLabel: 'Extra credits', remainingPercent: 100, displayText: '0 / 7966' },
        { provider: 'workbuddy', account: 'primary-with-extra', windowLabel: 'Total credits', remainingPercent: 94 },
        { provider: 'workbuddy', account: 'backup', windowLabel: 'Credits', remainingPercent: 50 },
      ],
    })
    const wbSummary = selectModelQuotas(wbModel, wbStatus)
    assert.equal(wbSummary.primary?.account, 'primary-with-extra', 'Total credits 仍有余量时维持主账号不误切')
    assert.equal(wbSummary.primary?.exhausted, false)

    // 预付余额 $0.00 让位给 $32.12
    const balanceModel = resolveEffectiveMagpieModel('magpie/sub2api/test')
    assert.ok(balanceModel !== null)
    const balanceStatus = parseStatus({
      ...MULTI_ACCOUNT_DOC,
      quotas: [
        { provider: 'sub2api', account: 'empty', windowLabel: 'Balance', remainingPercent: -1, displayText: '$0.00', last: true },
        { provider: 'sub2api', account: 'funded', windowLabel: 'Balance', remainingPercent: -1, displayText: '$32.12' },
      ],
    })
    const balanceSummary = selectModelQuotas(balanceModel, balanceStatus)
    assert.equal(balanceSummary.primary?.account, 'funded', '预付余额 $0.00 视为已耗尽，优先显示有余额账号')
    assert.equal(balanceSummary.accounts[1]?.exhausted, true)

    // 全部账号耗尽：按 last / order 回退，且诚实标红；已耗尽真实读数仍优于无窗口报错账号
    const allOutModel = resolveEffectiveMagpieModel('magpie/newapi/gpt-6')
    assert.ok(allOutModel !== null)
    const allOutStatus = parseStatus({
      ...MULTI_ACCOUNT_DOC,
      quotas: [
        { provider: 'newapi', account: 'broken', remainingPercent: -1, error: 'timeout' },
        { provider: 'newapi', account: 'first-zero', windowLabel: 'Subscription', remainingPercent: 0 },
        { provider: 'newapi', account: 'last-zero', windowLabel: 'Subscription', remainingPercent: 0, last: true },
      ],
    })
    const allOutSummary = selectModelQuotas(allOutModel, allOutStatus)
    assert.equal(allOutSummary.primary?.account, 'last-zero', '全部耗尽时按 last 优先级回退且不落到报错账号')
    assert.equal(allOutSummary.primary?.exhausted, true)
    assert.equal(allOutSummary.triggerTone, 'err')
    assert.equal(allOutSummary.accounts.map((a) => a.account).join(','), 'last-zero,first-zero,broken')

    // 可选 Extra 窗口为 0% 时不误判仍有主窗口额度的账号，非百分比比值 "0 / 6900" 不误判耗尽
    assert.equal(
      isAccountExhausted([
        { label: '5h', valueText: '80%', tone: 'ok', remainingPercent: 80, unlimited: false, sortRank: 300 },
        { label: 'Extra usage', valueText: '0%', tone: 'err', remainingPercent: 0, unlimited: false, sortRank: 60_000 },
      ]),
      false,
    )
    assert.equal(
      isAccountExhausted([
        { label: 'Extra credits', valueText: '0 / 6900', tone: 'neutral', remainingPercent: -1, unlimited: false, sortRank: 60_000 },
      ]),
      false,
    )
    assert.equal(
      isAccountExhausted([
        { label: '5h', valueText: '∞', tone: 'ok', remainingPercent: -1, unlimited: true, sortRank: 300 },
      ]),
      false,
    )
  })
})
