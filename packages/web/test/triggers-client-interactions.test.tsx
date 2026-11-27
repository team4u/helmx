/**
 * builtin:triggers 插件 client 组件测试（真实编译产物 + 共享宿主 SDK + DOM 事件）。
 *
 * 覆盖：manager screen（cron / webhook 管理表、行动作 trigger/delete、空态与
 * 加载态、secret 提示文案）与 settingsPanel（计数、CLI 引导、管理入口导航）。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { describe, before, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { PluginClientContext as PluginClientContextType, ScreenProps } from '@helmx/protocol'
import { PluginClientContext, resolveLocalizedText, type HelmxLocale } from '@helmx/plugin-client'
import { importBuiltinClientModule, mountSharedPluginNamespaces, setBuiltinClientStub } from './helpers/builtin-clients.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as Record<string, unknown>).React = React

interface Components {
  TriggersManagerScreen: (p: Partial<ScreenProps> & { inlineDrawer?: boolean }) => React.ReactElement
  TriggersSettingsPanel: () => React.ReactElement
}

let components: Components
describe("triggers-client-interactions", () => {


  before(async () => {
    mountSharedPluginNamespaces()
    const [managerMod, settingsMod] = await Promise.all([
      importBuiltinClientModule('builtin:triggers', 'manager.tsx'),
      importBuiltinClientModule('builtin:triggers', 'settings.tsx'),
    ])
    components = {
      TriggersManagerScreen: managerMod['TriggersManagerScreen'] as Components['TriggersManagerScreen'],
      TriggersSettingsPanel: settingsMod['TriggersSettingsPanel'] as Components['TriggersSettingsPanel'],
    }
  }, { timeout: 60_000 })

  interface SpyCtx extends PluginClientContextType {
    screenCalls: string[]
    drawerCalls: number[]
    actionCalls: Array<{ actionId: string; input: unknown }>
    notifications: Array<{ message: string; tone: string }>
  }

  function makeSpyCtx(locale: HelmxLocale = 'en'): SpyCtx {
    const screenCalls: string[] = []
    const drawerCalls: number[] = []
    const actionCalls: Array<{ actionId: string; input: unknown }> = []
    const notifications: Array<{ message: string; tone: string }> = []
    const base: PluginClientContextType = {
      pluginId: 'builtin:triggers',
      callAction: async (actionId, input) => {
        actionCalls.push({ actionId, input })
        return {}
      },
      fetchRoute: async () => { throw new Error('fetchRoute not implemented in test stub') },
      submitInput: async () => {},
      openScreen: (t) => {
        screenCalls.push(t)
      },
      openSplitScreen: () => {},
      openConversationDrawer: (id) => {
        drawerCalls.push(id)
      },
      openArtifact: () => {},
      openWorkbench: () => {},
      closeWorkbench: () => {},
      notify: (message, tone = 'info') => {
        notifications.push({ message, tone })
      },
      getPluginDoc: async () => undefined,
      getPluginSessionDoc: async () => undefined,
      theme: 'dark',
      locale,
      translate: (text) => resolveLocalizedText(text, locale),
    }
    return Object.assign(base, { screenCalls, drawerCalls, actionCalls, notifications })
  }

  async function mount(
    ctx: PluginClientContextType,
    element: React.ReactElement,
  ): Promise<{ host: HTMLElement; unmount: () => void }> {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(e(PluginClientContext.Provider, { value: ctx }, element))
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

  const CRONS_DOC = {
    version: 1,
    jobs: [
      { id: 'daily-report', schedule: '0 9 * * *', text: '生成日报', mode: 'isolated', profileId: 'assistant', keepLast: 10, enabled: true, timezone: 'UTC', catchUp: false, lastRunAt: 1_800_000_000_000, nextRunAt: 1_800_086_400_000 },
      { id: 'broken', schedule: '0 * * * *', text: '失败任务', mode: 'isolated', profileId: 'assistant', keepLast: 5, enabled: false, timezone: 'UTC', catchUp: false, lastError: '投递失败：目标会话不存在' },
    ],
  }

  const WEBHOOKS_DOC = {
    webhooks: [
      { id: 'ci', hasSecret: true, description: 'CI 构建', mode: 'isolated', profileId: 'assistant', keepLast: 10, createdAt: 1_800_000_000_000 },
    ],
  }

  const SAMPLE_RUNS = [
    {
      id: 901,
      title: 'Cron · daily-report · 09:00',
      profileId: 'assistant',
      ownedBy: 'helmx' as const,
      tags: ['trigger', 'cron:daily-report'],
      cwd: '/tmp',
      model: 'faux/faux-1',
      thinkingLevel: '',
      status: 'error' as const,
      lastError: 'upstream 502',
      stateChangeSeq: 3,
      completionSeq: 1,
      unread: true,
      pinned: false,
      pendingAskCount: 0,
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_010_000,
    },
    {
      id: 902,
      title: 'Webhook · ci · 09:05',
      profileId: 'assistant',
      ownedBy: 'helmx' as const,
      tags: ['trigger', 'webhook:ci'],
      cwd: '/tmp',
      model: 'faux/faux-1',
      thinkingLevel: '',
      status: 'done' as const,
      stateChangeSeq: 2,
      completionSeq: 1,
      unread: false,
      pinned: false,
      pendingAskCount: 0,
      createdAt: 1_800_000_300_000,
      updatedAt: 1_800_000_305_000,
    },
  ]

  before(() => {
    setBuiltinClientStub({ docs: { crons: CRONS_DOC, webhooks: WEBHOOKS_DOC }, conversations: SAMPLE_RUNS })
  })

  test('manager screen：cron 表渲染行、状态徽章与错误列', { timeout: 60_000 }, async () => {
    const spy = makeSpyCtx()
    const { host, unmount } = await mount(
      spy,
      e(components.TriggersManagerScreen, { pluginId: 'builtin:triggers', screenId: 'manager', isSplit: false, params: {}, setParams: () => {} }),
    )
    try {
      assert.match(host.textContent ?? '', /Triggers/, '标题')
      assert.match(host.textContent ?? '', /Cron jobs/, 'cron 区块')
      assert.match(host.textContent ?? '', /daily-report/, 'cron 行 id')
      assert.match(host.textContent ?? '', /生成日报/, 'cron 指令')
      assert.match(host.textContent ?? '', /Enabled/, '启用徽章')
      assert.match(host.textContent ?? '', /Disabled/, '停用徽章')
      assert.match(host.textContent ?? '', /投递失败：目标会话不存在/, '最近错误')
      assert.match(host.textContent ?? '', /Cron 2 · Webhook 1/, '统计')
    } finally {
      unmount()
    }
  })

  test('manager screen：cron 行动作立即触发 / 删除；在途时统一禁用全部行按钮', { timeout: 60_000 }, async () => {
    const spy = makeSpyCtx()
    let release: (() => void) | undefined
    spy.callAction = async (actionId, input) => {
      spy.actionCalls.push({ actionId, input })
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return {}
    }
    const { host, unmount } = await mount(
      spy,
      e(components.TriggersManagerScreen, { pluginId: 'builtin:triggers', screenId: 'manager', isSplit: false, params: {}, setParams: () => {} }),
    )
    try {
      const trigger = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Trigger now'))
      assert.ok(trigger, '立即触发按钮')
      await act(async () => {
        trigger!.click()
      })
      assert.deepEqual(spy.actionCalls[0], { actionId: 'cron_trigger', input: { id: 'daily-report' } }, '触发 cron_trigger')
      // 在途期间：同一守卫的全部行按钮统一 disabled，且仅当前触发按钮带 aria-busy="true"
      const allRowButtons = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(
        (b) => b.textContent?.includes('Trigger now') || b.textContent?.includes('Delete'),
      )
      assert.equal(allRowButtons.length, 5, 'cron 2行×2 + webhook 1行×1 = 5 个行按钮')
      assert.equal(trigger!.getAttribute('aria-busy'), 'true', '发起动作的按钮应标记 aria-busy="true"')
      for (const b of allRowButtons) {
        assert.equal(b.disabled, true, `在途时行按钮统一禁用：${b.textContent}`)
        if (b !== trigger) {
          assert.equal(b.getAttribute('aria-busy'), null, `其余行按钮不得误标 aria-busy：${b.textContent}`)
        }
      }
      // 恢复后重新可点且移除 aria-busy
      await act(async () => {
        release?.()
      })
      assert.deepEqual(spy.notifications[0], { message: 'Triggered cron job "daily-report".', tone: 'info' })
      assert.equal(trigger!.getAttribute('aria-busy'), null, '完成后移除 aria-busy')
      for (const b of allRowButtons) {
        assert.equal(b.disabled, false, `完成后恢复可点：${b.textContent}`)
      }
      const del = [...host.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent?.includes('Delete'))
      // First click opens ConfirmDialog without calling cron_delete immediately; Cancel aborts cleanly
      await act(async () => {
        del[0]!.click()
      })
      assert.equal(spy.actionCalls.length, 1, 'clicking Delete must open confirmation dialog before calling cron_delete')
      let confirmDialog = document.body.querySelector('[role="alertdialog"]')
      assert.ok(confirmDialog !== null, 'cron Delete opens AlertDialog confirmation')
      const cancelBtn = [...confirmDialog.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes('Cancel'),
      )
      assert.ok(cancelBtn !== undefined)
      await act(async () => {
        cancelBtn.click()
      })
      assert.equal(spy.actionCalls.length, 1, 'cancelling confirmation dialog must not invoke cron_delete')

      // Confirm cron delete
      await act(async () => {
        del[0]!.click()
      })
      confirmDialog = document.body.querySelector('[role="alertdialog"]')
      assert.ok(confirmDialog !== null)
      const confirmCronBtn = [...confirmDialog.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.className.includes('btn-danger'),
      )
      assert.ok(confirmCronBtn !== undefined)
      await act(async () => {
        confirmCronBtn.click()
      })
      assert.deepEqual(spy.actionCalls[1], { actionId: 'cron_delete', input: { id: 'daily-report' } }, '触发 cron_delete')
      assert.equal(del[0]!.getAttribute('aria-busy'), 'true', 'cron_delete 在途时仅目标删除按钮带 aria-busy="true"')
      for (const b of allRowButtons) {
        assert.equal(b.disabled, true)
        if (b !== del[0]) assert.equal(b.getAttribute('aria-busy'), null, `其余行按钮不得带 aria-busy：${b.textContent}`)
      }
      await act(async () => {
        release?.()
      })
      assert.deepEqual(spy.notifications[1], { message: 'Deleted cron job "daily-report".', tone: 'info' })

      // Confirm webhook delete
      await act(async () => {
        del[2]!.click()
      })
      confirmDialog = document.body.querySelector('[role="alertdialog"]')
      assert.ok(confirmDialog !== null, 'webhook Delete opens AlertDialog confirmation')
      const confirmWhBtn = [...confirmDialog.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.className.includes('btn-danger'),
      )
      assert.ok(confirmWhBtn !== undefined)
      await act(async () => {
        confirmWhBtn.click()
      })
      assert.deepEqual(spy.actionCalls[2], { actionId: 'webhook_delete', input: { id: 'ci' } }, '触发 webhook_delete')
      assert.equal(del[2]!.getAttribute('aria-busy'), 'true', 'webhook_delete 在途时仅目标删除按钮带 aria-busy="true"')
      for (const b of allRowButtons) {
        assert.equal(b.disabled, true)
        if (b !== del[2]) assert.equal(b.getAttribute('aria-busy'), null, `其余行按钮不得带 aria-busy：${b.textContent}`)
      }
      await act(async () => {
        release?.()
      })
      assert.deepEqual(spy.notifications[2], { message: 'Deleted webhook endpoint "ci".', tone: 'info' })
    } finally {
      unmount()
    }
  })

  test('manager screen：webhook 表渲染与 secret 边界提示', { timeout: 60_000 }, async () => {
    const spy = makeSpyCtx()
    const { host, unmount } = await mount(
      spy,
      e(components.TriggersManagerScreen, { pluginId: 'builtin:triggers', screenId: 'manager', isSplit: false, params: {}, setParams: () => {} }),
    )
    try {
      assert.match(host.textContent ?? '', /Webhook endpoints/, 'webhook 区块')
      assert.match(host.textContent ?? '', /ci/, 'webhook id')
      assert.match(host.textContent ?? '', /CI 构建/, '描述')
      assert.match(host.textContent ?? '', /Secrets are never shown in docs/, 'secret 边界提示')
      assert.doesNotMatch(host.textContent ?? '', /hasSecret/, '布尔协作字段不进展示')
    } finally {
      unmount()
    }
  })

  test('manager screen：doc 未到达展示加载态、空 doc 展示空表', { timeout: 60_000 }, async () => {
    setBuiltinClientStub({ docs: { crons: undefined, webhooks: undefined } })
    try {
      const spy = makeSpyCtx()
      const { host, unmount } = await mount(
        spy,
        e(components.TriggersManagerScreen, { pluginId: 'builtin:triggers', screenId: 'manager', isSplit: false, params: {}, setParams: () => {} }),
      )
      try {
        assert.match(host.textContent ?? '', /Loading cron jobs…/, 'cron 加载态')
        assert.match(host.textContent ?? '', /Loading webhooks…/, 'webhook 加载态')
      } finally {
        unmount()
      }
      setBuiltinClientStub({ docs: { crons: { version: 1, jobs: [] }, webhooks: { webhooks: [] } } })
      const { host: host2, unmount: unmount2 } = await mount(
        spy,
        e(components.TriggersManagerScreen, { pluginId: 'builtin:triggers', screenId: 'manager', isSplit: false, params: {}, setParams: () => {} }),
      )
      try {
        assert.match(host2.textContent ?? '', /No data/, '空表如实展示')
        assert.doesNotMatch(host2.textContent ?? '', /Loading/, '空 doc 不残留加载态')
      } finally {
        unmount2()
      }
    } finally {
      setBuiltinClientStub({ docs: { crons: CRONS_DOC, webhooks: WEBHOOKS_DOC }, conversations: SAMPLE_RUNS })
    }
  })

  test('manager screen：动作失败显式展示错误不静默', { timeout: 60_000 }, async () => {
    const failing = makeSpyCtx()
    failing.callAction = async () => {
      throw new Error('目标会话不存在')
    }
    const { host, unmount } = await mount(
      failing,
      e(components.TriggersManagerScreen, { pluginId: 'builtin:triggers', screenId: 'manager', isSplit: false, params: {}, setParams: () => {} }),
    )
    try {
      const trigger = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Trigger now'))
      await act(async () => {
        trigger!.click()
      })
      await act(async () => {})
      assert.match(host.textContent ?? '', /cron_trigger failed: 目标会话不存在/, '错误显式展示')
      const errCallout = host.querySelector('.callout.callout-error')
      assert.ok(errCallout, '动作失败必须渲染统一 .callout-error 原语')
    } finally {
      unmount()
    }
  })

  async function mountHostedScreen(
    ctx: PluginClientContextType,
    initialParams: Record<string, string> = {},
  ): Promise<{
    host: HTMLElement
    getParams: () => Record<string, string>
    paramCalls: Array<{ patch: Record<string, string | undefined>; options?: { push?: boolean } }>
    unmount: () => void
  }> {
    let latestParams = { ...initialParams }
    const paramCalls: Array<{ patch: Record<string, string | undefined>; options?: { push?: boolean } }> = []
    function Harness() {
      const [params, setParamsState] = React.useState<Record<string, string>>(initialParams)
      latestParams = params
      return e(
        PluginClientContext.Provider,
        { value: ctx },
        e(components.TriggersManagerScreen, {
          pluginId: 'builtin:triggers',
          screenId: 'manager',
          isSplit: false,
          params,
          setParams: (patch, options) => {
            paramCalls.push({ patch, options })
            setParamsState((prev) => {
              const next = { ...prev }
              for (const [k, v] of Object.entries(patch)) {
                if (v === undefined) delete next[k]
                else next[k] = v
              }
              latestParams = next
              return next
            })
          },
          inlineDrawer: true,
        }),
      )
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(e(Harness))
    })
    await act(async () => {})
    return {
      host,
      getParams: () => latestParams,
      paramCalls,
      unmount: () => {
        act(() => root.unmount())
        host.remove()
      },
    }
  }

  test('manager screen：Screen .screen-heading 排版，点击 Cron / Webhook 行打开右侧详情抽屉', { timeout: 60_000 }, async () => {
    const spy = makeSpyCtx()
    const mounted = await mountHostedScreen(spy)
    const { host, unmount } = mounted
    try {
      const heading = host.querySelector('.screen-header .screen-heading')
      assert.ok(heading, 'Screen 页头必须使用 .screen-heading 紧致组排')

      const brokenRow = Array.from(host.querySelectorAll('tbody tr')).find((tr) =>
        tr.textContent?.includes('broken'),
      )
      assert.ok(brokenRow, '应存在 broken cron 行')
      await act(async () => {
        brokenRow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      await act(async () => {})

      assert.deepEqual(mounted.paramCalls.at(-1), {
        patch: { trigger: 'cron:broken' },
        options: { push: true },
      })

      const dialog = host.querySelector('[role="dialog"].primary-drawer-content')
      assert.ok(dialog, '点击行应展开右侧 540px 详情抽屉')
      assert.match(dialog.textContent ?? '', /broken/)
      assert.match(dialog.textContent ?? '', /0 \* \* \* \*/)
      assert.match(dialog.textContent ?? '', /失败任务/)
      assert.ok(dialog.querySelector('.callout.callout-error'), '抽屉内最近错误应使用 .callout-error')

      const closeBtn = dialog.querySelector('button.tg-drawer-close.btn-icon-sm')
      assert.ok(closeBtn, '抽屉右上角关闭按钮应具备 .tg-drawer-close.btn-icon-sm')
      await act(async () => {
        closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      await act(async () => {})
      assert.deepEqual(mounted.paramCalls.at(-1), {
        patch: { trigger: undefined },
        options: undefined,
      })
      assert.ok(host.querySelector('[role="dialog"].primary-drawer-content') === null, '关闭按钮应收起抽屉')

      const webhookRow = Array.from(host.querySelectorAll('tbody tr')).find((tr) =>
        tr.textContent?.includes('CI 构建'),
      )
      assert.ok(webhookRow)
      await act(async () => {
        webhookRow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      await act(async () => {})
      assert.deepEqual(mounted.paramCalls.at(-1), {
        patch: { trigger: 'webhook:ci' },
        options: { push: true },
      })
      const whDialog = host.querySelector('[role="dialog"].primary-drawer-content')
      assert.ok(whDialog, '点击 Webhook 行应展开详情抽屉')
      assert.match(whDialog.textContent ?? '', /CI 构建/)
      assert.doesNotMatch(whDialog.textContent ?? '', /hasSecret/, '抽屉同样不得暴露 hasSecret 内部键名')

      // 删除当前已打开的 webhook 应自动清理 trigger 参数并收起抽屉
      const deleteBtn = Array.from(whDialog.querySelectorAll('button')).find((b) =>
        (b.textContent ?? '').includes('Delete'),
      )
      assert.ok(deleteBtn !== undefined)
      await act(async () => {
        deleteBtn.click()
      })
      const confirmDialog = host.querySelector('[role="alertdialog"]')
      assert.ok(confirmDialog !== null)
      const confirmDeleteBtn = confirmDialog.querySelector<HTMLButtonElement>('button.btn-danger')
      assert.ok(confirmDeleteBtn !== null)
      await act(async () => {
        confirmDeleteBtn.click()
      })
      await act(async () => {})
      assert.deepEqual(mounted.getParams(), {}, '删除当前打开的触发器后必须清理 URL trigger 参数')
    } finally {
      unmount()
    }
  })

  test('manager screen：实时运行记录从 conversations 投影，支持抽屉速览与整页打开', { timeout: 60_000 }, async () => {
    const spy = makeSpyCtx()
    const mounted = await mountHostedScreen(spy)
    const { host, unmount } = mounted
    try {
      const dailyRow = Array.from(host.querySelectorAll('tbody tr')).find((tr) =>
        tr.textContent?.includes('daily-report'),
      )
      assert.ok(dailyRow, 'daily-report row renders')
      assert.ok(
        dailyRow.querySelector('.helmx-status-light[data-tone="failed"]') !== null,
        'failed run surfaces error status light on cron row',
      )

      await act(async () => {
        dailyRow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      await act(async () => {})

      const dialog = host.querySelector('[role="dialog"].primary-drawer-content')
      assert.ok(dialog, 'detail drawer opens for daily-report')
      assert.match(dialog.textContent ?? '', /Recent runs/, 'runs section renders')
      assert.match(dialog.textContent ?? '', /#901/, 'live run conversation id renders')
      assert.match(dialog.textContent ?? '', /upstream 502/, 'run error surfaces')

      const runMain = dialog.querySelector<HTMLButtonElement>('.tg-run-main')
      assert.ok(runMain)
      await act(async () => {
        runMain.click()
      })
      assert.deepEqual(spy.drawerCalls, [901], 'clicking run row peeks conversation in drawer')

      const openBtn = dialog.querySelector<HTMLButtonElement>('.tg-run-open-btn')
      assert.ok(openBtn)
      await act(async () => {
        openBtn.click()
      })
      assert.deepEqual(spy.screenCalls, ['conversation:901'], 'clicking open button navigates to conversation')
    } finally {
      unmount()
    }
  })

  test('settingsPanel：计数、CLI 引导与打开管理入口', { timeout: 60_000 }, async () => {
    const spy = makeSpyCtx()
    const { host, unmount } = await mount(spy, e(components.TriggersSettingsPanel, {}))
    try {
      assert.match(host.textContent ?? '', /Triggers/, '标题')
      assert.match(host.textContent ?? '', /Cron jobs/, 'KV 键')
      assert.match(host.textContent ?? '', /Webhook endpoints/, 'KV 键')
      assert.match(host.textContent ?? '', /helmx CLI/, 'CLI 引导文案')
      const open = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Open trigger manager'))
      assert.ok(open, '管理入口按钮')
      await act(async () => {
        open!.click()
      })
      assert.deepEqual(spy.screenCalls, ['screen:builtin:triggers/manager'], '入口导航到管理视图')
    } finally {
      unmount()
    }
  })

  test('zh-CN locale：Triggers 管理页与设置面板切为中文文案', { timeout: 60_000 }, async () => {
    const spy = makeSpyCtx('zh-CN')
    const { host: mgrHost, unmount: unmountMgr } = await mount(
      spy,
      e(components.TriggersManagerScreen, { pluginId: 'builtin:triggers', screenId: 'manager', isSplit: false, params: {}, setParams: () => {} }),
    )
    try {
      assert.match(mgrHost.textContent ?? '', /触发器管理/)
      assert.match(mgrHost.textContent ?? '', /Cron 定时任务/)
      assert.match(mgrHost.textContent ?? '', /Webhook 端点/)
      assert.match(mgrHost.textContent ?? '', /立即触发/)
    } finally {
      unmountMgr()
    }
    const { host: setHost, unmount: unmountSet } = await mount(spy, e(components.TriggersSettingsPanel, {}))
    try {
      assert.match(setHost.textContent ?? '', /Cron 任务数/)
      assert.match(setHost.textContent ?? '', /Webhook 端点数/)
      assert.match(setHost.textContent ?? '', /打开触发器管理/)
    } finally {
      unmountSet()
    }
  })
})
