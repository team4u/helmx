import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React, { act } from 'react'
import { renderToString } from 'react-dom/server'
import type { HelmxLocale } from '@helmx/protocol'
import type { SelectOption, SelectChangeEvent } from '../src/index.js'
import { ensureHappyDom, resetHappyDom } from './helpers/dom-harness.js'

ensureHappyDom()
const ReactDOMClient = await import('react-dom/client')
const { Select, UiLocaleProvider } = await import('../src/index.js')

const e = React.createElement

afterEach(() => {
  resetHappyDom()
}, { timeout: 60_000 })

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

  assert.match(html, /class="helmx-select composer-env-select"/)
  assert.match(html, /class="helmx-select-trigger"/)
  assert.match(html, /aria-label="会话执行节点"/)
  assert.match(html, /aria-haspopup="listbox"/)
  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /<span class="helmx-select-label">local \(本机\)<\/span>/)
  assert.match(html, /helmx-select-chevron/)
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
// 2. Radix UI 无障碍属性、状态机与 DOM 交互契约测试
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

  const trigger = container.querySelector('[role="combobox"]')
  assert.ok(trigger, 'Trigger 必须具备 role="combobox"')
  assert.equal(trigger.getAttribute('aria-expanded'), 'true')
  assert.equal(trigger.getAttribute('aria-haspopup'), 'listbox')
  assert.equal(trigger.getAttribute('aria-label'), '目标执行节点')

  const listbox = container.querySelector('[role="listbox"]')
  assert.ok(listbox, '下拉浮层必须具备 role="listbox"')
  assert.equal(listbox.getAttribute('data-state'), 'open')

  const optionElements = container.querySelectorAll('[role="option"]')
  assert.equal(optionElements.length, 3, '应渲染全部 3 个选项')

  const selectedOptionEl = optionElements[0]
  assert.equal(selectedOptionEl?.getAttribute('data-state'), 'checked')
  assert.ok(selectedOptionEl?.querySelector('.helmx-select-check'), '选中项应渲染 check 勾选指示器')

  const unselectedOptionEl = optionElements[1]
  assert.equal(unselectedOptionEl?.getAttribute('data-state'), 'unchecked')
  assert.ok(unselectedOptionEl?.querySelector('.helmx-select-check') === null, '未选中项不应渲染勾选')

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

  await act(async () => {
    listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true }))
  })

  const optionElements = Array.from(container.querySelectorAll('[role="option"]'))
  const bananaOption = optionElements.find((el) => el.textContent?.includes('Banana'))
  assert.ok(bananaOption, '应找到 Banana 选项')
  assert.ok(bananaOption.hasAttribute('data-highlighted'), '输入 b 之后 Banana 选项应被高亮（data-highlighted）')

  await act(async () => {
    bananaOption.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })

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

  assert.match(html, /class="[^"]*helmx-select-multi[^"]*"/)
  assert.match(html, /2 selected/)
  assert.match(html, /aria-label="模型多选"/)
  assert.match(html, /Select all/)
  assert.match(html, /Clear/)
  assert.match(html, /role="checkbox"/)
  assert.match(html, /Model 1/)
  assert.match(html, /Model 2/)
  assert.match(html, /200K/)
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

test('Select multiple: 点击复选框仅触发一次 onChange，支持键盘导航与多语言空态', { timeout: 60_000 }, async () => {
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
  let locale: HelmxLocale = 'en'
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const setLocale = (next: HelmxLocale) => {
    locale = next
    for (const listener of listeners) listener()
  }

  const renderSelect = () =>
    e(
      UiLocaleProvider,
      { subscribe, getLocale: () => locale },
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

    const checkboxes = container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')
    assert.equal(checkboxes.length, 5)
    await act(async () => {
      checkboxes[0]!.click()
    })
    assert.deepEqual(changes, [['a']], 'clicking Checkbox must invoke onValuesChange once, not twice')

    await act(async () => {
      root.render(renderSelect())
    })

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
      setLocale('zh-CN')
    })
    assert.equal(container.querySelector('.helmx-select-empty')?.textContent, '无匹配选项')
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})
