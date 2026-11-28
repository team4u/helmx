import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToString } from 'react-dom/server'
import {
  Popover,
  PopoverRoot,
  PopoverTrigger,
  PopoverContent,
  DropdownMenu,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  Tooltip,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  TooltipContent,
} from '../src/index.js'

test('Popover 原语挂载、数据属性与无障碍属性（SSR）', { timeout: 60_000 }, () => {
  const openHtml = renderToString(
    React.createElement(
      PopoverRoot,
      { open: true },
      React.createElement(
        PopoverTrigger,
        { asChild: true },
        React.createElement('button', { type: 'button' }, '触发器'),
      ),
      React.createElement(
        PopoverContent,
        { className: 'custom-popover' },
        React.createElement('div', null, '浮层正文'),
      ),
    ),
  )

  assert.match(openHtml, /aria-haspopup="dialog"/)
  assert.match(openHtml, /aria-expanded="true"/)
  assert.match(openHtml, /data-state="open"/)
  assert.match(openHtml, /role="dialog"/)
  assert.match(openHtml, /helmx-popover-content/)
  assert.match(openHtml, /custom-popover/)
  assert.match(openHtml, /浮层正文/)

  const closedHtml = renderToString(
    React.createElement(
      PopoverRoot,
      { open: false },
      React.createElement(
        PopoverTrigger,
        { asChild: true },
        React.createElement('button', { type: 'button' }, '触发器'),
      ),
      React.createElement(PopoverContent, null, '不渲染内容'),
    ),
  )
  assert.match(closedHtml, /aria-expanded="false"/)
  assert.match(closedHtml, /data-state="closed"/)
  assert.doesNotMatch(closedHtml, /不渲染内容/)
})

test('DropdownMenu 原语挂载、数据属性与角色属性（SSR）', { timeout: 60_000 }, () => {
  const menuHtml = renderToString(
    React.createElement(
      DropdownMenuRoot,
      { open: true },
      React.createElement(
        DropdownMenuTrigger,
        { asChild: true },
        React.createElement('button', { type: 'button', 'aria-label': '操作菜单' }, '菜单'),
      ),
      React.createElement(
        DropdownMenuPortal,
        null,
        React.createElement(
          DropdownMenuContent,
          { className: 'pane-more-popover' },
          React.createElement(DropdownMenuLabel, null, 'Conversation actions'),
          React.createElement(
            DropdownMenuItem,
            { onSelect: () => {} },
            'Rename conversation',
          ),
          React.createElement(DropdownMenuSeparator, null),
          React.createElement(
            DropdownMenuItem,
            { danger: true, onSelect: () => {} },
            'Reset context',
          ),
        ),
      ),
    ),
  )

  assert.match(menuHtml, /aria-haspopup="menu"/)
  assert.match(menuHtml, /aria-expanded="true"/)
  assert.match(menuHtml, /data-state="open"/)
  assert.match(menuHtml, /role="menu"/)
  assert.match(menuHtml, /data-radix-menu-content/)
  assert.match(menuHtml, /helmx-dropdown-content/)
  assert.match(menuHtml, /pane-more-popover/)
  assert.match(menuHtml, /role="menuitem"/)
  assert.match(menuHtml, /Rename conversation/)
  assert.match(menuHtml, /role="separator"/)
  assert.match(menuHtml, /helmx-dropdown-separator/)
  assert.match(menuHtml, /popover-separator/)
  assert.match(menuHtml, /helmx-dropdown-item-danger/)
  assert.match(menuHtml, /popover-item-danger/)
})

test('Tooltip 原语挂载、无障碍属性与独立使用能力（SSR）', { timeout: 60_000 }, () => {
  const primitiveHtml = renderToString(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(
        TooltipRoot,
        { open: true },
        React.createElement(
          TooltipTrigger,
          { asChild: true },
          React.createElement('button', { type: 'button', 'aria-label': '关闭' }, 'X'),
        ),
        React.createElement(
          TooltipContent,
          null,
          '关闭弹窗',
        ),
      ),
    ),
  )

  assert.match(primitiveHtml, /aria-describedby=/)
  assert.match(primitiveHtml, /role="tooltip"/)
  assert.match(primitiveHtml, /helmx-tooltip-content/)
  assert.match(primitiveHtml, /关闭弹窗/)

  const wrapperHtml = renderToString(
    React.createElement(
      Tooltip,
      { content: '提示文本', open: true },
      React.createElement('button', { type: 'button', 'aria-label': '设置' }, 'S'),
    ),
  )
  assert.match(wrapperHtml, /role="tooltip"/)
  assert.match(wrapperHtml, /提示文本/)

  const disabledHtml = renderToString(
    React.createElement(
      Tooltip,
      { content: '提示文本', disabled: true },
      React.createElement('button', { type: 'button', className: 'raw-btn' }, 'Raw'),
    ),
  )
  assert.match(disabledHtml, /class="raw-btn"/)
  assert.doesNotMatch(disabledHtml, /role="tooltip"/)
})
