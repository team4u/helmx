/**
 * 节点详情抽屉展示小原语契约测试（拆分自 NodeDetailDrawer，DOM 结构与类名须与拆分前一致）：
 * - MonoValue：等宽可选中单元格；
 * - NodeSectionTitle：行首 13px 图标 + 文案，保持 inline 横向 Stack；
 * - CopyableCommandRow：代码块占满剩余宽度 + 右侧复制按钮（label 可选，缺省走 SDK 默认 aria-label）。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ensureHappyDom } from './helpers/dom-harness.js'
import {
  CopyableCommandRow,
  MonoValue,
  NodeSectionTitle,
} from '../src/nodes/node-detail/NodeDetailPrimitives.js'

ensureHappyDom()
const e = React.createElement

test('MonoValue / NodeSectionTitle：类名与图标尺寸契约不变', { timeout: 60_000 }, () => {
  const mono = renderToStaticMarkup(e(MonoValue, null, 'x86_64'))
  assert.match(mono, /^<span class="mono selectable">x86_64<\/span>$/)

  const title = renderToStaticMarkup(e(NodeSectionTitle, { icon: 'activity', label: 'Health' }))
  assert.match(title, /^<div class="helmx-stack helmx-stack-inline helmx-stack-horizontal helmx-stack-gap-xs helmx-stack-align-center">/)
  assert.match(title, /<svg[^>]*width="13"[^>]*height="13"/)
  assert.ok(title.endsWith('<span>Health</span></div>'), title)
})

test('CopyableCommandRow：代码块类名与复制按钮 label 透传', { timeout: 60_000 }, () => {
  const withLabel = renderToStaticMarkup(e(CopyableCommandRow, { text: 'helmx-node start', label: 'Copy command' }))
  assert.match(withLabel, /<code class="code-box selectable flex-1 mono">helmx-node start<\/code>/)
  assert.match(withLabel, /<button[^>]*aria-label="Copy command"[^>]*>/)
  assert.match(withLabel, /<span>Copy command<\/span>/)

  const withoutLabel = renderToStaticMarkup(e(CopyableCommandRow, { text: 'helmx-node doctor' }))
  assert.match(withoutLabel, /<code class="code-box selectable flex-1 mono">helmx-node doctor<\/code>/)
  assert.doesNotMatch(withoutLabel, /<span>Copy<\/span>/)
})
