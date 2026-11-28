import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { Checkbox, Switch } from '../src/index.js'

const e = React.createElement

// ---------------------------------------------------------------------------
// 1. Switch 组件 SSR 渲染与无障碍契约
// ---------------------------------------------------------------------------

test('Switch：基础状态、受控 checked、WAI-ARIA 属性与零 Emoji', { timeout: 60_000 }, () => {
  const offHtml = renderToString(
    e(Switch, {
      checked: false,
      onChange: () => {},
      label: '网关状态',
      id: 'gateway-switch',
    }),
  )

  assert.match(offHtml, /<span class="helmx-switch-wrap">/)
  assert.match(offHtml, /role="switch"/)
  assert.match(offHtml, /aria-checked="false"/)
  assert.match(offHtml, /id="gateway-switch"/)
  assert.match(offHtml, /class="helmx-switch"/)
  assert.match(offHtml, /class="helmx-switch-thumb"/)
  assert.match(offHtml, /<label for="gateway-switch" class="helmx-switch-label">网关状态<\/label>/)
  assert.doesNotMatch(offHtml, /<label[^>]*>[\s\S]*<button/, 'Switch <label> must be a sibling of <button>, never wrapping it')
  assert.doesNotMatch(offHtml, /is-checked/)
  assert.doesNotMatch(offHtml, /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u)

  const onHtml = renderToString(
    e(Switch, {
      checked: true,
      onChange: () => {},
      label: '已开启',
    }),
  )

  assert.match(onHtml, /aria-checked="true"/)
  assert.match(onHtml, /is-checked/)

  const disabledHtml = renderToString(
    e(Switch, {
      checked: true,
      disabled: true,
      onChange: () => {},
      label: '只读开关',
    }),
  )

  assert.match(disabledHtml, /class="helmx-switch-wrap is-disabled"/)
  assert.match(disabledHtml, /disabled=""/)

  const noLabelHtml = renderToString(
    e(Switch, {
      checked: false,
      onChange: () => {},
      'aria-label': '静默开关',
    }),
  )
  assert.match(noLabelHtml, /<span class="helmx-switch-wrap">/)
  assert.match(noLabelHtml, /aria-label="静默开关"/)
  assert.doesNotMatch(noLabelHtml, /helmx-switch-label/)
})

// ---------------------------------------------------------------------------
// 2. Checkbox 组件 SSR 渲染与半选状态契约
// ---------------------------------------------------------------------------

test('Checkbox：未选、勾选、半选（indeterminate）、无障碍与零 Emoji', { timeout: 60_000 }, () => {
  const uncheckedHtml = renderToString(
    e(Checkbox, {
      checked: false,
      onChange: () => {},
      label: '多选条目',
      id: 'item-chk',
    }),
  )

  assert.match(uncheckedHtml, /<span class="helmx-checkbox-wrap">/)
  assert.match(uncheckedHtml, /role="checkbox"/)
  assert.match(uncheckedHtml, /aria-checked="false"/)
  assert.match(uncheckedHtml, /id="item-chk"/)
  assert.match(uncheckedHtml, /class="helmx-checkbox"/)
  assert.match(uncheckedHtml, /<label for="item-chk" class="helmx-checkbox-label">多选条目<\/label>/)
  assert.doesNotMatch(uncheckedHtml, /<label[^>]*>[\s\S]*<button/, 'Checkbox <label> must be a sibling of <button>, never wrapping it')
  assert.doesNotMatch(uncheckedHtml, /is-checked/)
  assert.doesNotMatch(uncheckedHtml, /is-indeterminate/)
  assert.doesNotMatch(uncheckedHtml, /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u)

  const checkedHtml = renderToString(
    e(Checkbox, {
      checked: true,
      onChange: () => {},
      label: '强制重装/重试',
    }),
  )

  assert.match(checkedHtml, /aria-checked="true"/)
  assert.match(checkedHtml, /is-checked/)
  assert.match(checkedHtml, /<svg/)

  const indHtml = renderToString(
    e(Checkbox, {
      checked: false,
      indeterminate: true,
      onChange: () => {},
      label: 'Select all（部分选中）',
    }),
  )

  assert.match(indHtml, /aria-checked="mixed"/)
  assert.match(indHtml, /is-indeterminate/)
  assert.match(indHtml, /<svg/)

  const disabledHtml = renderToString(
    e(Checkbox, {
      checked: true,
      disabled: true,
      onChange: () => {},
      label: '受保护',
    }),
  )

  assert.match(disabledHtml, /class="helmx-checkbox-wrap is-disabled"/)
  assert.match(disabledHtml, /disabled=""/)

  const noLabelHtml = renderToString(
    e(Checkbox, {
      className: 'sidebar-batch-checkbox',
      checked: true,
      onChange: () => {},
      'aria-label': '选择会话',
    }),
  )
  assert.match(noLabelHtml, /class="helmx-checkbox-wrap sidebar-batch-checkbox"/)
  assert.doesNotMatch(noLabelHtml, /helmx-checkbox-label/)
})
