import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import React, { act } from 'react'
import { renderToString } from 'react-dom/server'
import type { SelectOption, SelectChangeEvent } from '@helmx/plugin-client'
import { ensureHappyDom } from './helpers/dom-harness.js'

ensureHappyDom()
const ReactDOMClient = await import('react-dom/client')
const { Select } = await import('@helmx/plugin-client')

const e = React.createElement

// ---------------------------------------------------------------------------
// 1. SSR 渲染与 DOM 契约测试
// ---------------------------------------------------------------------------

test('Select：基础触发器渲染符合无障碍与项目极简视觉规范', { timeout: 60_000 }, () => {
  const options: SelectOption<string>[] = [
    { value: 'local', label: 'local (本机)', icon: 'monitor' },
    { value: 'node-1', label: 'node-1', icon: 'network', meta: '在线' },
  ]

  const html = renderToString(
    e(Select, {
      value: 'local',
      options,
      onChange: () => {},
      'aria-label': '会话执行节点',
      className: 'composer-env-select',
    }),
  )

  // 1. 结构与容器类名
  assert.match(html, /class="helmx-select composer-env-select"/)
  assert.match(html, /class="helmx-select-trigger"/)

  // 2. 无障碍属性
  assert.match(html, /aria-label="会话执行节点"/)
  assert.match(html, /aria-haspopup="listbox"/)
  assert.match(html, /aria-expanded="false"/)

  // 3. 选中文案与 Lucide 旋转折叠图标
  assert.match(html, /<span class="helmx-select-label">local \(本机\)<\/span>/)
  assert.match(html, /helmx-select-chevron/)

  // 4. 严禁包含 Emoji
  assert.equal(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(html), false)
})

test('Select：支持前缀图标与禁用态', { timeout: 60_000 }, () => {
  const options: SelectOption<string>[] = [{ value: 'a', label: '选项 A' }]
  const html = renderToString(
    e(Select, {
      value: 'a',
      options,
      onChange: () => {},
      prefixIcon: 'network',
      disabled: true,
    }),
  )

  assert.match(html, /disabled=""/)
  assert.match(html, /helmx-select-prefix/)
})

test('Select：支持 placeholder 与自定义 size 类名', { timeout: 60_000 }, () => {
  const options: SelectOption<string>[] = [{ value: 'a', label: '选项 A' }]
  const html = renderToString(
    e(Select, {
      value: 'unmatched',
      placeholder: '请选择节点…',
      options,
      onChange: () => {},
      size: 'sm',
    }),
  )

  assert.match(html, /class="helmx-select helmx-select-sm"/)
  assert.match(html, /<span class="helmx-select-label helmx-select-placeholder">请选择节点…<\/span>/)
})

test('Select：空字符串作为合法选项值（如跟随全局默认）正常呈现与选中', { timeout: 60_000 }, () => {
  const options: SelectOption<string>[] = [
    { value: '', label: '跟随全局默认节点' },
    { value: 'node-worker', label: 'node-worker' },
  ]
  const html = renderToString(
    e(Select, {
      value: '',
      options,
      onChange: () => {},
      placeholder: '请选择节点',
    }),
  )

  assert.match(html, /<span class="helmx-select-label">跟随全局默认节点<\/span>/)
  assert.doesNotMatch(html, /helmx-select-placeholder/)
})

// ---------------------------------------------------------------------------
// 3. Radix UI 无障碍属性、状态机与 DOM 交互契约测试
// ---------------------------------------------------------------------------

test('Select：无障碍角色（role="combobox" / role="listbox"）与状态机契约', { timeout: 60_000 }, () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  const options: SelectOption<string>[] = [
    { value: 'node-local', label: '本机环境', icon: 'monitor' },
    { value: 'node-gpu', label: 'GPU 计算节点', icon: 'network', meta: '在线' },
    { value: 'node-offline', label: '离线节点', disabled: true },
  ]

  act(() => {
    root.render(
      e(Select, {
        value: 'node-local',
        options,
        open: true,
        inline: true,
        onChange: () => {},
        'aria-label': '目标执行节点',
      }),
    )
  })

  // 1. Trigger role="combobox" 与无障碍关联
  const trigger = container.querySelector('[role="combobox"]')
  assert.ok(trigger, 'Trigger 必须具备 role="combobox"')
  assert.equal(trigger.getAttribute('aria-expanded'), 'true')
  assert.equal(trigger.getAttribute('aria-haspopup'), 'listbox')
  assert.equal(trigger.getAttribute('aria-label'), '目标执行节点')

  // 2. Content role="listbox" 与选项 role="option"
  const listbox = container.querySelector('[role="listbox"]')
  assert.ok(listbox, '下拉浮层必须具备 role="listbox"')
  assert.equal(listbox.getAttribute('data-state'), 'open')

  const optionElements = container.querySelectorAll('[role="option"]')
  assert.equal(optionElements.length, 3, '应渲染全部 3 个选项')

  // 3. 激活态与勾选指示符
  const selectedOptionEl = optionElements[0]
  assert.equal(selectedOptionEl?.getAttribute('data-state'), 'checked')
  assert.ok(selectedOptionEl?.querySelector('.helmx-select-check'), '选中项应渲染 check 勾选指示器')

  const unselectedOptionEl = optionElements[1]
  assert.equal(unselectedOptionEl?.getAttribute('data-state'), 'unchecked')
  assert.ok(unselectedOptionEl?.querySelector('.helmx-select-check') === null, '未选中项不应渲染勾选')

  // 4. 禁用态选项
  const disabledOptionEl = optionElements[2]
  assert.ok(disabledOptionEl?.hasAttribute('data-disabled'), '禁用项应带有 data-disabled')

  act(() => {
    root.unmount()
  })
  container.remove()
})

test('Select：键盘首字母跳转（Typeahead Search）与 Enter 键选择触发 onChange', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  let changedEvent: SelectChangeEvent<string> | null = null

  const options: SelectOption<string>[] = [
    { value: 'apple', label: 'Apple' },
    { value: 'banana', label: 'Banana' },
    { value: 'cherry', label: 'Cherry' },
  ]

  act(() => {
    root.render(
      e(Select, {
        value: 'apple',
        name: 'fruitSelect',
        options,
        open: true,
        inline: true,
        onChange: (event: SelectChangeEvent<string>) => {
          changedEvent = event
        },
      }),
    )
  })

  const listbox = container.querySelector('[role="listbox"]')
  assert.ok(listbox, '浮层必须展开')

  // 1. 模拟在 listbox 上键入 'b'，应触发首字母跳转（Typeahead Search）
  await act(async () => {
    listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true }))
  })

  const optionElements = Array.from(container.querySelectorAll('[role="option"]'))
  const bananaOption = optionElements.find((el) => el.textContent?.includes('Banana'))
  assert.ok(bananaOption, '应找到 Banana 选项')
  assert.ok(bananaOption.hasAttribute('data-highlighted'), '输入 b 之后 Banana 选项应被高亮（data-highlighted）')

  // 2. 模拟回车确认选中
  await act(async () => {
    bananaOption.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })

  // 3. 校验 onChange 事件与 SelectChangeEvent 数据结构（包括 name）
  assert.ok(changedEvent, '回车后必须触发 onChange 回调')
  assert.equal((changedEvent as SelectChangeEvent<string>).target.value, 'banana')
  assert.equal((changedEvent as SelectChangeEvent<string>).target.name, 'fruitSelect')

  act(() => {
    root.unmount()
  })
  container.remove()
})

test('Select multiple: 渲染多选触发器、全选与清空操作栏及复选框，且零 Emoji', { timeout: 60_000 }, () => {
  const options: SelectOption<string>[] = [
    { value: 'm1', label: 'Model 1', meta: '200K' },
    { value: 'm2', label: 'Model 2', meta: '128K' },
    { value: 'm3', label: 'Model 3' },
  ]

  const html = renderToString(
    e(Select, {
      multiple: true,
      value: ['m1', 'm2'],
      options,
      onChange: () => {},
      inline: true,
      'aria-label': '模型多选',
    }),
  )

  // 1. 结构与多选类名
  assert.match(html, /class="[^"]*helmx-select-multi[^"]*"/)
  assert.match(html, /2 selected/)
  assert.match(html, /aria-label="模型多选"/)

  // 2. 快捷全选与清空按钮
  assert.match(html, /Select all/)
  assert.match(html, /Clear/)

  // 3. 复选框与选项呈现
  assert.match(html, /role="checkbox"/)
  assert.match(html, /Model 1/)
  assert.match(html, /Model 2/)
  assert.match(html, /200K/)

  // 4. 零 Emoji
  assert.equal(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(html), false)
})

test('Select multiple: 全选时触发器显示已全选摘要文案', { timeout: 60_000 }, () => {
  const options: SelectOption<string>[] = [
    { value: 'm1', label: 'Model 1' },
    { value: 'm2', label: 'Model 2' },
  ]

  const html = renderToString(
    e(Select, {
      multiple: true,
      value: ['m1', 'm2'],
      options,
      onChange: () => {},
    }),
  )

  assert.match(html, /All selected \(2\)/)
})

test('CSS stacking regression: Popover 内容节点必须声明 z-index: 80，Select 保持 120，Dialog 内联层叠仍可覆盖', { timeout: 60_000 }, () => {
  // Radix Popper reads getComputedStyle(content).zIndex and mirrors it inline onto
  // [data-radix-popper-content-wrapper]; if .helmx-popover-content computes to 'auto',
  // inline z-index: auto overrides the wrapper rule and lets .timeline-container::after (z-index: 2)
  // paint a horizontal seam straight across the popover.
  const formsCss = readFileSync(new URL('../src/styles/forms.css', import.meta.url), 'utf8')
  const overlaysCss = readFileSync(new URL('../src/styles/overlays.css', import.meta.url), 'utf8')
  const style = document.createElement('style')
  style.textContent = `${formsCss}\n${overlaysCss}`
  document.head.appendChild(style)

  const makeWrapped = (className: string, inlineZ?: string): HTMLElement => {
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-radix-popper-content-wrapper', '')
    const content = document.createElement('div')
    content.className = className
    if (inlineZ !== undefined) content.style.zIndex = inlineZ
    wrapper.appendChild(content)
    document.body.appendChild(wrapper)
    return content
  }

  const plainPopover = makeWrapped('helmx-popover-content magpie-quota-popover')
  const modelPopover = makeWrapped('helmx-popover-content composer-popover composer-model-popover')
  const selectPopover = makeWrapped('helmx-popover-content helmx-select-popover dropdown-panel')
  const nestedDialogPopover = makeWrapped('helmx-popover-content magpie-quota-popover', '1002')
  try {
    assert.equal(getComputedStyle(plainPopover).zIndex, '80', '普通 Popover 必须向 Radix Popper 暴露 z-index: 80 而非 auto')
    assert.equal(getComputedStyle(modelPopover).zIndex, '80', '模型选择器 Popover 统一处于 80 层，不被侧栏或底渐隐层遮挡')
    assert.equal(getComputedStyle(selectPopover).zIndex, '120', 'MultiSelect 复用 PopoverContent 时仍须维持 120 层高于旧弹窗')
    assert.equal(getComputedStyle(nestedDialogPopover).zIndex, '1002', 'Dialog 内浮层通过 useOverlayChildStyle 内联抬高层级不被压低')
  } finally {
    plainPopover.parentElement?.remove()
    modelPopover.parentElement?.remove()
    selectPopover.parentElement?.remove()
    nestedDialogPopover.parentElement?.remove()
    style.remove()
  }
})

test('Select multiple: 点击复选框仅触发一次 onChange，支持键盘导航与多语言空态', { timeout: 60_000 }, async () => {
  const { HostStoreProviders } = await import('./helpers/host-store.js')
  const { makeTestStore } = await import('./helpers/store.js')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  const options: SelectOption<string>[] = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta', disabled: true },
    { value: 'c', label: 'Charlie' },
    { value: 'd', label: 'Delta' },
    { value: 'e', label: 'Echo' },
  ]
  const changes: string[][] = []
  let current: string[] = []
  const store = makeTestStore({ locale: 'en' })

  const renderSelect = () =>
    e(
      HostStoreProviders,
      { value: store },
      e(Select, {
        multiple: true,
        inline: true,
        open: true,
        value: current,
        options,
        onValuesChange: (next: string[]) => {
          current = next
          changes.push(next)
        },
        'aria-label': 'Test multi select',
      }),
    )

  try {
    await act(async () => {
      root.render(renderSelect())
    })

    // 1. Clicking Checkbox fires onValuesChange exactly once (no parent-row double-trigger)
    const checkboxes = container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')
    assert.equal(checkboxes.length, 5)
    await act(async () => {
      checkboxes[0]!.click()
    })
    assert.deepEqual(changes, [['a']], 'clicking Checkbox must invoke onValuesChange once, not twice')

    await act(async () => {
      root.render(renderSelect())
    })

    // 2. Keyboard navigation skips disabled Beta and toggles Charlie on Enter,
    //    and exposes aria-activedescendant / aria-controls / option IDs
    const viewport = container.querySelector<HTMLElement>('.helmx-select-viewport')
    const listbox = container.querySelector<HTMLElement>('[role="listbox"]')
    const trigger = container.querySelector<HTMLButtonElement>('.helmx-select-trigger')
    const searchCombobox = container.querySelector<HTMLInputElement>('.helmx-select-search input')
    assert.ok(viewport !== null && listbox !== null && trigger !== null && searchCombobox !== null)
    assert.equal(listbox.getAttribute('aria-multiselectable'), 'true')
    assert.ok(listbox.id.length > 0, 'listbox must carry a deterministic id')
    assert.equal(trigger.getAttribute('aria-controls'), listbox.id, 'open trigger must reference listbox via aria-controls')
    assert.equal(searchCombobox.getAttribute('role'), 'combobox', 'searchable input exposes combobox role')
    assert.equal(searchCombobox.getAttribute('aria-controls'), listbox.id)
    assert.equal(listbox.getAttribute('aria-activedescendant'), null, 'no active descendant before navigation')

    await act(async () => {
      viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    await act(async () => {
      viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    const highlighted = container.querySelector<HTMLElement>('[role="option"][data-highlighted]')
    assert.ok(highlighted !== null && highlighted.textContent?.includes('Charlie'), 'ArrowDown skips disabled option to highlight Charlie')
    assert.ok(highlighted.id.length > 0, 'each multi-select option must carry a stable id')
    assert.equal(listbox.getAttribute('aria-activedescendant'), highlighted.id, 'listbox aria-activedescendant tracks active option id')
    assert.equal(searchCombobox.getAttribute('aria-activedescendant'), highlighted.id, 'search combobox aria-activedescendant tracks active option id')
    assert.ok(document.getElementById(highlighted.id) === highlighted, 'aria-activedescendant resolves to the active option node')

    await act(async () => {
      viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
    })
    const endOption = container.querySelector<HTMLElement>('[role="option"][data-highlighted]')
    assert.ok(endOption !== null && endOption.textContent?.includes('Echo'))
    assert.equal(listbox.getAttribute('aria-activedescendant'), endOption.id, 'End updates aria-activedescendant to last enabled option')

    await act(async () => {
      viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
      viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    })
    assert.equal(listbox.getAttribute('aria-activedescendant'), highlighted.id, 'ArrowUp returns active descendant to Charlie')

    await act(async () => {
      viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.deepEqual(changes[changes.length - 1], ['a', 'c'], 'Enter toggles highlighted option')

    // 3. Empty search state renders localized .helmx-select-empty without orphan .text-xs
    const searchInput = container.querySelector<HTMLInputElement>('.helmx-select-search input')
    assert.ok(searchInput !== null)
    const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      nativeValueSetter?.call(searchInput, 'zzz-no-hit')
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    assert.equal(listbox.getAttribute('aria-activedescendant'), null, 'clearing active index removes stale aria-activedescendant')
    assert.equal(searchCombobox.getAttribute('aria-activedescendant'), null)
    const emptyElEn = container.querySelector<HTMLElement>('.helmx-select-empty')
    assert.ok(emptyElEn !== null)
    assert.equal(emptyElEn.textContent, 'No matching options')
    assert.equal(emptyElEn.classList.contains('text-xs'), false)

    await act(async () => {
      store.setLocale('zh-CN')
    })
    assert.equal(container.querySelector('.helmx-select-empty')?.textContent, '无匹配选项')
  } finally {
    localStorage.removeItem('helmx:locale')
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})
