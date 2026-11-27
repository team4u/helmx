import './helpers/register-happy-dom.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { renderToString } from 'react-dom/server'
import { ensureHappyDom } from './helpers/dom-harness.js'

ensureHappyDom()
const { createRoot } = await import('react-dom/client')
const {
  Screen,
  ScreenToolbar,
  SearchBox,
  SegmentedControl,
  TabCount,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} = await import('@helmx/ui')

// ---------------------------------------------------------------------------
// 1. SSR 渲染与数据属性（data-state="active"）契约测试
// ---------------------------------------------------------------------------

test('SSR：Tabs 默认渲染下划线选项卡（tabs-bar 与 tab-btn），包含 WAI-ARIA 语义与 data-state', { timeout: 60_000 }, () => {
  const html = renderToString(
    React.createElement(
      Tabs,
      { value: 'tab1' },
      React.createElement(
        TabsList,
        { 'aria-label': 'Main navigation' },
        React.createElement(TabsTrigger, { value: 'tab1' }, '选项卡一'),
        React.createElement(TabsTrigger, { value: 'tab2' }, '选项卡二'),
      ),
      React.createElement(TabsContent, { value: 'tab1' }, '内容一'),
      React.createElement(TabsContent, { value: 'tab2' }, '内容二'),
    ),
  )

  // 1. WAI-ARIA 语义
  assert.match(html, /role="tablist"/, 'TabsList 应渲染 role="tablist"')
  assert.match(html, /role="tab"/, 'TabsTrigger 应渲染 role="tab"')
  assert.match(html, /role="tabpanel"/, 'TabsContent 应渲染 role="tabpanel"')

  // 2. 下划线选项卡类名契约
  assert.match(html, /class="[^"]*tabs-bar[^"]*"/, '默认 List 类名应包含 tabs-bar')
  assert.match(html, /class="[^"]*tab-btn[^"]*tab-btn-active[^"]*"/, '激活项应包含 tab-btn 与 tab-btn-active')

  // 3. 数据属性状态
  assert.match(html, /data-state="active"/, '激活项必须带有 data-state="active"')
  assert.match(html, /data-state="inactive"/, '未激活项必须带有 data-state="inactive"')
  assert.match(html, /aria-selected="true"/, '激活项应具备 aria-selected="true"')
  assert.match(html, /aria-selected="false"/, '未激活项应具备 aria-selected="false"')
  assert.match(html, /内容一/, '激活的内容区域应被渲染')
})

test('SSR：Tabs variant="segmented" 渲染分段控制器（segmented-control 与 segmented-control-btn）', { timeout: 60_000 }, () => {
  const html = renderToString(
    React.createElement(
      Tabs,
      { value: 'rich', variant: 'segmented' },
      React.createElement(
        TabsList,
        { 'aria-label': 'View mode' },
        React.createElement(TabsTrigger, { value: 'rich' }, 'Rich text'),
        React.createElement(TabsTrigger, { value: 'source' }, '源码'),
      ),
    ),
  )

  assert.match(html, /class="[^"]*segmented-control[^"]*"/, 'List 类名应包含 segmented-control')
  assert.match(html, /class="[^"]*segmented-control-btn[^"]*is-active[^"]*"/, '激活按钮应包含 is-active')
  assert.match(html, /data-state="active"/, '激活项带有 data-state="active"')
})

test('SSR：SegmentedControl 语义化封装组件渲染与属性传递', { timeout: 60_000 }, () => {
  const html = renderToString(
    React.createElement(SegmentedControl, {
      value: 'all',
      'aria-label': '状态筛选',
      className: 'provider-filters',
      items: [
        { value: 'all', label: '全部', title: '查看全部供应商' },
        { value: 'configured', label: '已配置', disabled: true },
        { value: 'unconfigured', label: '待配置' },
      ],
    }),
  )

  assert.match(html, /class="[^"]*segmented-control[^"]*provider-filters[^"]*"/, '应合并外部 className')
  assert.match(html, /data-state="active"/, '激活项应具备 data-state="active"')
  assert.match(html, /title="查看全部供应商"/, '应透传 item title')
  assert.match(html, /disabled=""/, '禁用项应带有 disabled 属性')
  assert.match(html, /data-disabled=""/, '禁用项应带有 data-disabled 数据属性')
})

// ---------------------------------------------------------------------------
// 2. DOM 交互与 onValueChange 回调测试
// ---------------------------------------------------------------------------

test('DOM：SegmentedControl 受控模式点击项触发 onValueChange 回调', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  let currentValue = 'rich'
  const changes: string[] = []

  await act(async () => {
    root.render(
      React.createElement(SegmentedControl, {
        value: currentValue,
        onValueChange: (val: string) => {
          changes.push(val)
          currentValue = val
        },
        items: [
          { value: 'rich', label: 'Rich text' },
          { value: 'source', label: '源码' },
        ],
      }),
    )
  })

  const buttons = host.querySelectorAll('button')
  assert.equal(buttons.length, 2)
  assert.equal(buttons[0]?.getAttribute('data-state'), 'active')
  assert.equal(buttons[1]?.getAttribute('data-state'), 'inactive')

  // 点击源码按钮
  await act(async () => {
    buttons[1]?.click()
  })

  assert.deepEqual(changes, ['source'], '点击非激活项应触发 onValueChange')

  root.unmount()
  host.remove()
})

test('DOM：SegmentedControl 禁用项点击不触发 onValueChange 回调', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  const changes: string[] = []

  await act(async () => {
    root.render(
      React.createElement(SegmentedControl, {
        value: 'a',
        onValueChange: (val: string) => changes.push(val),
        items: [
          { value: 'a', label: '选项 A' },
          { value: 'b', label: '选项 B (禁用)', disabled: true },
        ],
      }),
    )
  })

  const buttons = host.querySelectorAll('button')
  assert.equal(buttons[1]?.disabled, true)

  await act(async () => {
    buttons[1]?.click()
  })

  assert.deepEqual(changes, [], '禁用项点击不应触发 onValueChange 回调')

  root.unmount()
  host.remove()
})

test('DOM：Tabs.Root / Tabs.List / Tabs.Trigger 复合组件语法与激活态切换', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  let selected = 'basic'
  const changes: string[] = []

  await act(async () => {
    root.render(
      React.createElement(
        Tabs,
        {
          value: selected,
          onValueChange: (val) => {
            changes.push(val)
            selected = val
          },
          variant: 'underline',
        },
        React.createElement(
          TabsList,
          null,
          React.createElement(TabsTrigger, { value: 'basic' }, '基础信息'),
          React.createElement(TabsTrigger, { value: 'system' }, 'SYSTEM.md'),
          React.createElement(TabsTrigger, { value: 'memory' }, 'MEMORY.md'),
        ),
      ),
    )
  })

  const triggers = host.querySelectorAll('button')
  assert.equal(triggers.length, 3)
  assert.equal(triggers[0]?.getAttribute('data-state'), 'active')
  assert.ok(triggers[0]?.classList.contains('tab-btn-active'))

  // 点击第二个 trigger
  await act(async () => {
    triggers[1]?.click()
  })

  assert.deepEqual(changes, ['system'])

  root.unmount()
  host.remove()
})

// ---------------------------------------------------------------------------
// 3. 键盘导航合规性测试（WAI-ARIA Tabs）
// ---------------------------------------------------------------------------

test('键盘导航：ArrowRight / ArrowLeft 箭头键移动焦点与自动激活，支持回环', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  let currentTab = 'tab1'
  const changes: string[] = []

  await act(async () => {
    root.render(
      React.createElement(
        Tabs,
        {
          defaultValue: 'tab1',
          onValueChange: (val) => {
            changes.push(val)
            currentTab = val
          },
        },
        React.createElement(
          TabsList,
          null,
          React.createElement(TabsTrigger, { value: 'tab1' }, '选项 1'),
          React.createElement(TabsTrigger, { value: 'tab2' }, '选项 2'),
          React.createElement(TabsTrigger, { value: 'tab3' }, '选项 3'),
        ),
      ),
    )
  })

  const triggers = host.querySelectorAll('button')
  assert.equal(triggers.length, 3)

  // 1. 初始焦点位于 tab1，触发 ArrowRight
  await act(async () => {
    triggers[0]?.focus()
    triggers[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await new Promise((r) => setTimeout(r, 20))
  })

  assert.equal(currentTab, 'tab2', 'ArrowRight 导航至下一个 tab 并激活')

  // 2. 再次触发 ArrowRight
  await act(async () => {
    const active = document.activeElement as HTMLElement
    active?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await new Promise((r) => setTimeout(r, 20))
  })

  assert.equal(currentTab, 'tab3', 'ArrowRight 再次导航至第三个 tab 并激活')

  // 3. 触发 ArrowLeft 回到 tab2
  await act(async () => {
    const active = document.activeElement as HTMLElement
    active?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    await new Promise((r) => setTimeout(r, 20))
  })

  assert.equal(currentTab, 'tab2', 'ArrowLeft 导航回前一个 tab 并激活')

  root.unmount()
  host.remove()
})

test('键盘导航：Enter 与 Space 键激活聚焦的 Trigger 项', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  let currentTab = 'first'
  const changes: string[] = []

  await act(async () => {
    root.render(
      React.createElement(
        Tabs,
        {
          defaultValue: 'first',
          activationMode: 'manual',
          onValueChange: (val) => {
            changes.push(val)
            currentTab = val
          },
        },
        React.createElement(
          TabsList,
          null,
          React.createElement(TabsTrigger, { value: 'first' }, 'First'),
          React.createElement(TabsTrigger, { value: 'second' }, 'Second'),
        ),
      ),
    )
  })

  const triggers = host.querySelectorAll('button')

  // 在 manual 模式下，Enter 键激活
  await act(async () => {
    triggers[1]?.focus()
    triggers[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })

  assert.equal(currentTab, 'second', 'Enter 键成功激活 second tab')

  // Space 键激活 first
  await act(async () => {
    triggers[0]?.focus()
    triggers[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  })

  assert.equal(currentTab, 'first', 'Space 键成功激活 first tab')

  root.unmount()
  host.remove()
})

test('键盘导航：Roving tabindex 确保当前选项卡 tabindex=0，非激活项 tabindex=-1', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  await act(async () => {
    root.render(
      React.createElement(
        Tabs,
        { defaultValue: 't2' },
        React.createElement(
          TabsList,
          null,
          React.createElement(TabsTrigger, { value: 't1' }, 'T1'),
          React.createElement(TabsTrigger, { value: 't2' }, 'T2'),
          React.createElement(TabsTrigger, { value: 't3' }, 'T3'),
        ),
      ),
    )
  })

  const triggers = host.querySelectorAll('button')
  await act(async () => {
    triggers[1]?.focus()
  })

  assert.equal(triggers[0]?.getAttribute('tabindex'), '-1', '非激活项 tabIndex 应为 -1')
  assert.equal(triggers[1]?.getAttribute('tabindex'), '0', '激活项 tabIndex 应为 0（Tab 键焦点直接落入）')
  assert.equal(triggers[2]?.getAttribute('tabindex'), '-1', '非激活项 tabIndex 应为 -1')

  root.unmount()
  host.remove()
})

// ---------------------------------------------------------------------------
// 4. Tabs variant="pills"（系统中心分类筛选胶囊：语义、交互、去重与键盘导航）
// ---------------------------------------------------------------------------

test('SSR：Tabs variant="pills" 渲染胶囊筛选条（helmx-tabs-pills / tabs-pills / tabs-pill）', { timeout: 60_000 }, () => {
  const html = renderToString(
    React.createElement(
      Tabs,
      { value: 'enabled', variant: 'pills' },
      React.createElement(
        TabsList,
        { 'aria-label': 'Filter plugins' },
        React.createElement(TabsTrigger, { value: 'all' }, 'All'),
        React.createElement(TabsTrigger, { value: 'enabled' }, 'Enabled'),
        React.createElement(TabsTrigger, { value: 'disabled', disabled: true }, 'Disabled'),
      ),
    ),
  )

  assert.match(html, /class="[^"]*helmx-tabs-pills[^"]*"/, '根容器应带 helmx-tabs-pills')
  assert.match(html, /class="[^"]*tabs-pills[^"]*"/, 'TabsList 应使用公共类 tabs-pills')
  assert.match(html, /role="tablist"/, 'TabsList 应具备 role="tablist"')
  assert.match(html, /class="[^"]*tabs-pill[^"]*is-active[^"]*"/, '激活胶囊应同步 .is-active')
  assert.match(html, /data-state="active"/, '激活胶囊应带 data-state="active"')
  assert.match(html, /aria-selected="true"/, '激活胶囊应带 aria-selected="true"')
  assert.match(html, /data-disabled=""/, '禁用胶囊应带 data-disabled')
})

test('DOM：Tabs variant="pills" 点击（含 mousedown+click）仅触发一次 onValueChange，且支持左右方向键与 roving tabindex', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  const changes: string[] = []
  function ControlledPills() {
    const [active, setActive] = React.useState('all')
    return React.createElement(
      Tabs,
      {
        value: active,
        variant: 'pills',
        onValueChange: (nextVal: string) => {
          changes.push(nextVal)
          setActive(nextVal)
        },
      },
      React.createElement(
        TabsList,
        { 'aria-label': 'Category filters' },
        React.createElement(TabsTrigger, { value: 'all' }, 'All'),
        React.createElement(TabsTrigger, { value: 'local' }, 'Local'),
        React.createElement(TabsTrigger, { value: 'remote' }, 'Remote'),
      ),
    )
  }

  try {
    await act(async () => {
      root.render(React.createElement(ControlledPills))
    })

    const getTriggers = () => Array.from(host.querySelectorAll<HTMLButtonElement>('.tabs-pill'))
    assert.equal(getTriggers().length, 3)
    assert.equal(getTriggers()[0]!.getAttribute('aria-selected'), 'true')
    assert.equal(getTriggers()[0]!.getAttribute('data-state'), 'active')
    assert.ok(getTriggers()[0]!.classList.contains('is-active'))

    // 1) 模拟真实指针点击序列（mousedown + click）：onValueChange 仅触发一次
    await act(async () => {
      const target = getTriggers()[1]!
      target.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      target.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true }))
    })
    assert.deepEqual(changes, ['local'], '真实 mousedown+click 序列不得重复触发 onValueChange')
    assert.equal(getTriggers()[1]!.getAttribute('aria-selected'), 'true')
    assert.equal(getTriggers()[1]!.getAttribute('data-state'), 'active')
    assert.ok(getTriggers()[1]!.classList.contains('is-active'))
    assert.equal(getTriggers()[0]!.classList.contains('is-active'), false)

    // 2) Roving tabindex：当前激活项为 0，非激活项为 -1
    await act(async () => {
      getTriggers()[1]!.focus()
    })
    assert.equal(getTriggers()[0]!.getAttribute('tabindex'), '-1')
    assert.equal(getTriggers()[1]!.getAttribute('tabindex'), '0')
    assert.equal(getTriggers()[2]!.getAttribute('tabindex'), '-1')

    // 3) ArrowRight 切换至 remote，ArrowLeft 回到 local
    await act(async () => {
      getTriggers()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))
    })
    assert.deepEqual(changes, ['local', 'remote'], 'ArrowRight 应导航并激活下一个胶囊')
    assert.equal(getTriggers()[2]!.getAttribute('aria-selected'), 'true')
    assert.equal(getTriggers()[2]!.getAttribute('data-state'), 'active')
    assert.ok(getTriggers()[2]!.classList.contains('is-active'))

    await act(async () => {
      const activeEl = document.activeElement as HTMLElement | null
      activeEl?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))
    })
    assert.deepEqual(changes, ['local', 'remote', 'local'], 'ArrowLeft 应导航回前一个胶囊')
    assert.equal(getTriggers()[1]!.getAttribute('aria-selected'), 'true')

    // 4) 程序化 .click()（无前置 mousedown，兼容单测与辅助技术）：同样触发一次
    await act(async () => {
      getTriggers()[0]!.click()
    })
    assert.deepEqual(changes, ['local', 'remote', 'local', 'all'])
    assert.equal(getTriggers()[0]!.getAttribute('aria-selected'), 'true')
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

test('DOM：ScreenToolbar 组合 Radix Tabs pills + TabCount 与 SearchBox toolbar(sm)，支持方向键切换分类胶囊', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  const selected: string[] = []
  const pills = [
    { key: 'all' as const, label: 'All', count: 5 },
    { key: 'enabled' as const, label: 'Enabled', count: 3 },
    { key: 'disabled' as const, label: 'Disabled', count: 2 },
  ]
  function ToolbarHarness() {
    const [query, setQuery] = React.useState('')
    const [activePill, setActivePill] = React.useState<'all' | 'enabled' | 'disabled'>('all')
    return React.createElement(
      ScreenToolbar,
      {
        label: 'Status filter',
        actions: React.createElement(SearchBox, {
          variant: 'toolbar',
          size: 'sm',
          value: query,
          onChange: setQuery,
          placeholder: 'Search items',
          ariaLabel: 'Search items',
          clearLabel: 'Clear',
        }),
      },
      React.createElement(
        Tabs,
        {
          value: activePill,
          onValueChange: (key: string) => {
            selected.push(key)
            setActivePill(key as 'all' | 'enabled' | 'disabled')
          },
          variant: 'pills',
          size: 'sm',
        },
        React.createElement(
          TabsList,
          { 'aria-label': 'Status filter' },
          pills.map((pill) =>
            React.createElement(
              TabsTrigger,
              { key: pill.key, value: pill.key, 'aria-controls': undefined },
              React.createElement('span', null, pill.label),
              React.createElement(TabCount, null, pill.count),
            ),
          ),
        ),
      ),
    )
  }

  try {
    await act(async () => {
      root.render(React.createElement(ToolbarHarness))
    })

    assert.ok(host.querySelector('.search-box.search-box-toolbar.search-box-sm') !== null, '应渲染 SearchBox toolbar sm 变体')
    const tablist = host.querySelector<HTMLElement>('.tabs-pills[role="tablist"]')
    assert.ok(tablist !== null, '应渲染 Radix TabsList .tabs-pills')
    assert.equal(tablist.getAttribute('aria-label'), 'Status filter')

    const renderedPills = Array.from(host.querySelectorAll<HTMLButtonElement>('.tabs-pill[role="tab"]'))
    assert.equal(renderedPills.length, 3)
    assert.equal(renderedPills[0]!.getAttribute('aria-selected'), 'true')
    assert.equal(host.querySelectorAll('.helmx-tab-count.tabular-nums').length, 3, '每个分类胶囊应渲染 TabCount')
    for (const pill of renderedPills) {
      assert.equal(pill.hasAttribute('aria-controls'), false, '独立渲染 ScreenToolbar 不得输出悬空 aria-controls')
    }

    await act(async () => {
      renderedPills[0]!.focus()
      renderedPills[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))
    })

    assert.deepEqual(selected, ['enabled'])
    assert.equal(renderedPills[1]!.getAttribute('aria-selected'), 'true')
    assert.equal(renderedPills[1]!.getAttribute('data-state'), 'active')
    assert.equal(renderedPills[1]!.getAttribute('tabindex'), '0')
    assert.equal(renderedPills[0]!.getAttribute('tabindex'), '-1')
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

test('DOM：Screen(topbar) + ScreenToolbar 的每个 [role="tab"] aria-controls 均指向真实 [role="tabpanel"]', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  function ShellToolbarHarness() {
    const panelId = React.useId()
    const [query, setQuery] = React.useState('')
    const [activePill, setActivePill] = React.useState<'all' | 'enabled'>('all')
    return React.createElement(
      Screen,
      {
        topbar: true,
        dataView: 'test-center',
        icon: 'layers',
        title: 'Test Center',
        bodyId: panelId,
        bodyRole: 'tabpanel',
        toolbar: React.createElement(
          ScreenToolbar,
          {
            label: 'Status filter',
            actions: React.createElement(SearchBox, {
              variant: 'toolbar',
              size: 'sm',
              value: query,
              onChange: setQuery,
              placeholder: 'Search',
              ariaLabel: 'Search',
              clearLabel: 'Clear',
            }),
          },
          React.createElement(
            Tabs,
            {
              value: activePill,
              onValueChange: (val: string) => setActivePill(val as 'all' | 'enabled'),
              variant: 'pills',
              size: 'sm',
            },
            React.createElement(
              TabsList,
              { 'aria-label': 'Status filter' },
              React.createElement(
                TabsTrigger,
                { value: 'all', 'aria-controls': panelId },
                React.createElement('span', null, 'All'),
                React.createElement(TabCount, null, 2),
              ),
              React.createElement(
                TabsTrigger,
                { value: 'enabled', 'aria-controls': panelId },
                React.createElement('span', null, 'Enabled'),
                React.createElement(TabCount, null, 1),
              ),
            ),
          ),
        ),
      },
      React.createElement('div', { className: 'test-center-cards' }, 'Cards'),
    )
  }

  try {
    await act(async () => {
      root.render(React.createElement(ShellToolbarHarness))
    })
    const tabs = Array.from(host.querySelectorAll<HTMLElement>('[role="tab"]'))
    assert.equal(tabs.length, 2)
    for (const tab of tabs) {
      const controlsId = tab.getAttribute('aria-controls')
      assert.ok(controlsId && controlsId.length > 0, '中心壳内每个 [role="tab"] 必须携带 aria-controls')
      const panel = host.querySelector(`[id="${CSS.escape(controlsId)}"]`)
      assert.ok(panel !== null, `aria-controls=${controlsId} 必须指向真实 DOM 元素`)
      assert.equal(panel.getAttribute('role'), 'tabpanel', '目标面板必须具备 role="tabpanel"')
    }
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

// ---------------------------------------------------------------------------
// 3. TabsTrigger 事件裁决回归测试（Ctrl-click / 右键 / 异步受控键盘 / 纯程序化 click）
// ---------------------------------------------------------------------------

test('DOM：TabsTrigger Ctrl-click 与非主按键 mousedown+click 被 Radix 拒绝，绝不通过 fallback 激活', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const changes: string[] = []

  function Harness() {
    const [val, setVal] = React.useState('a')
    return React.createElement(
      Tabs,
      {
        value: val,
        onValueChange: (next) => {
          changes.push(next)
          setVal(next)
        },
      },
      React.createElement(
        TabsList,
        { 'aria-label': 'Filter' },
        React.createElement(TabsTrigger, { value: 'a' }, 'A'),
        React.createElement(TabsTrigger, { value: 'b' }, 'B'),
      ),
    )
  }

  try {
    await act(async () => {
      root.render(React.createElement(Harness))
    })
    const [, tabB] = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    assert.ok(tabB !== undefined)

    // 1) mousedown(ctrlKey=true) + click
    await act(async () => {
      tabB.dispatchEvent(new MouseEvent('mousedown', { button: 0, ctrlKey: true, bubbles: true, cancelable: true }))
      tabB.dispatchEvent(new MouseEvent('click', { button: 0, ctrlKey: true, bubbles: true, cancelable: true }))
    })
    assert.deepEqual(changes, [], 'mousedown(ctrlKey=true)+click 不得触发 onValueChange')
    assert.equal(tabB.getAttribute('aria-selected'), 'false')

    // 2) 非主按键（button: 2）mousedown + click
    await act(async () => {
      tabB.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true }))
      tabB.dispatchEvent(new MouseEvent('click', { button: 2, bubbles: true, cancelable: true }))
    })
    assert.deepEqual(changes, [], '非主按键 mousedown+click 不得触发 onValueChange')
    assert.equal(tabB.getAttribute('aria-selected'), 'false')
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

test('DOM：受控父级异步未更新 value 时，keydown(Enter/Space) + click 各只触发一次 onValueChange', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const enterChanges: string[] = []
  const spaceChanges: string[] = []

  try {
    // 1) keydown('Enter') + click（受控 value 保持 'a' 不变）
    await act(async () => {
      root.render(
        React.createElement(
          Tabs,
          {
            value: 'a',
            onValueChange: (next) => {
              enterChanges.push(next)
            },
          },
          React.createElement(
            TabsList,
            { 'aria-label': 'Async Enter' },
            React.createElement(TabsTrigger, { value: 'a' }, 'A'),
            React.createElement(TabsTrigger, { value: 'b' }, 'B'),
          ),
        ),
      )
    })
    let [, tabB] = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    await act(async () => {
      tabB!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      tabB!.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true }))
    })
    assert.deepEqual(enterChanges, ['b'], 'Enter + click 在受控未同步更新时绝不能重复回调 [b, b]')

    // 2) keydown(' ') + click（受控 value 保持 'a' 不变）
    await act(async () => {
      root.render(
        React.createElement(
          Tabs,
          {
            value: 'a',
            onValueChange: (next) => {
              spaceChanges.push(next)
            },
          },
          React.createElement(
            TabsList,
            { 'aria-label': 'Async Space' },
            React.createElement(TabsTrigger, { value: 'a' }, 'A'),
            React.createElement(TabsTrigger, { value: 'b' }, 'B'),
          ),
        ),
      )
    })
    ;[, tabB] = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    await act(async () => {
      tabB!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
      tabB!.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true }))
    })
    assert.deepEqual(spaceChanges, ['b'], 'Space + click 在受控未同步更新时绝不能重复回调 [b, b]')
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

test('DOM：受控/非受控纯程序化 .click() 及 keydown(Enter) 切走再切回后 .click() 均正常单次触发', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  const controlledChanges: string[] = []
  const uncontrolledChanges: string[] = []

  function ControlledHarness() {
    const [val, setVal] = React.useState('a')
    return React.createElement(
      Tabs,
      {
        value: val,
        onValueChange: (next) => {
          controlledChanges.push(next)
          setVal(next)
        },
      },
      React.createElement(
        TabsList,
        { 'aria-label': 'Controlled click' },
        React.createElement(TabsTrigger, { value: 'a' }, 'A'),
        React.createElement(TabsTrigger, { value: 'b' }, 'B'),
      ),
    )
  }

  try {
    // 1) 受控模式：纯程序化 .click() + keydown('Enter') 无 click 切走再切回后 .click()
    await act(async () => {
      root.render(React.createElement(ControlledHarness))
    })
    const getControlledTabs = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))

    await act(async () => {
      getControlledTabs()[1]!.click()
    })
    assert.deepEqual(controlledChanges, ['b'], '受控纯程序化 .click() 触发一次')
    assert.equal(getControlledTabs()[1]!.getAttribute('aria-selected'), 'true')

    await act(async () => {
      getControlledTabs()[0]!.click()
    })
    assert.deepEqual(controlledChanges, ['b', 'a'])

    // 仅派发 keydown('Enter') 切到 B（无后续 click），再切回 A，随后对 B 调纯程序化 .click()
    await act(async () => {
      getControlledTabs()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.deepEqual(controlledChanges, ['b', 'a', 'b'])
    await act(async () => {
      getControlledTabs()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.deepEqual(controlledChanges, ['b', 'a', 'b', 'a'])
    await act(async () => {
      getControlledTabs()[1]!.click()
    })
    assert.deepEqual(controlledChanges, ['b', 'a', 'b', 'a', 'b'], '切走再切回后 .click() 不得被残留 suppress 标志吞掉')

    // 2) 非受控模式：纯程序化 .click() 单次触发
    await act(async () => {
      root.render(
        React.createElement(
          Tabs,
          {
            defaultValue: 'a',
            onValueChange: (next) => {
              uncontrolledChanges.push(next)
            },
          },
          React.createElement(
            TabsList,
            { 'aria-label': 'Uncontrolled click' },
            React.createElement(TabsTrigger, { value: 'a' }, 'A'),
            React.createElement(TabsTrigger, { value: 'b' }, 'B'),
          ),
        ),
      )
    })
    const uncontrolledTabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    await act(async () => {
      uncontrolledTabs[1]!.click()
    })
    assert.deepEqual(uncontrolledChanges, ['b'], '非受控纯程序化 .click() 触发一次')
    assert.equal(uncontrolledTabs[1]!.getAttribute('aria-selected'), 'true')
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})
