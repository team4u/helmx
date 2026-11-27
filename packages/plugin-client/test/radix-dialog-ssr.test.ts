import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToString } from 'react-dom/server'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '../src/ui/Dialog.js'
import { ModalDialog } from '../src/ui/ModalDialog.js'
import { Kbd } from '../src/ui/Kbd.js'
import { Tabs, TabsList, TabsTrigger } from '../src/ui/Tabs.js'
import { SearchBox } from '../src/ui/SearchBox.js'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from '../src/ui/DropdownMenu.js'

const e = React.createElement

test('Dialog SSR (renderToString): in a pure Node environment DialogPortal degrades to inline automatically and never returns an empty string', { timeout: 60_000 }, () => {
  assert.equal(typeof window, 'undefined', 'the test initially runs in a pure Node / SSR environment')

  const html = renderToString(
    e(
      Dialog,
      { open: true },
      e(
        DialogPortal,
        null,
        e(
          DialogOverlay,
          { className: 'modal-backdrop' },
          e(
            DialogContent,
            { className: 'modal', 'aria-label': 'SSR dialog' },
            e(
              'div',
              { className: 'modal-header' },
              e(DialogTitle, { className: 'modal-title' }, 'Title text'),
              e(
                DialogClose,
                { asChild: true },
                e('button', { type: 'button', className: 'btn btn-ghost btn-sm', 'aria-label': 'Close' }, 'Close'),
              ),
            ),
            e(DialogDescription, { className: 'modal-desc' }, 'This is a detailed dialog description text'),
            e('div', { className: 'modal-body' }, e('p', null, 'Body content')),
          ),
        ),
      ),
    ),
  )

  // Must not be an empty string
  assert.ok(html.length > 0, 'the SSR rendering result must not be an empty string')
  // Basic class names and attributes
  assert.ok(html.includes('class="modal-backdrop"'), 'must include the .modal-backdrop overlay class')
  assert.ok(html.includes('class="modal"'), 'must include the .modal dialog class')
  assert.ok(html.includes('role="dialog"'), 'must include the role="dialog" accessibility semantic')
  assert.ok(html.includes('data-state="open"'), 'must include the data-state="open" state marker')
  assert.ok(html.includes('Title text'), 'must emit the title text verbatim')
  assert.ok(html.includes('This is a detailed dialog description text'), 'must emit the description text verbatim')
  assert.ok(html.includes('Body content'), 'must emit the body content verbatim')
})

test('Dialog compound properties (Dialog.Portal, Dialog.Content, etc.) behave identically under SSR', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(
      Dialog,
      { open: true },
      e(
        Dialog.Portal,
        null,
        e(
          Dialog.Overlay,
          { className: 'modal-backdrop' },
          e(
            Dialog.Content,
            { className: 'modal modal-lg' },
            e(Dialog.Title, { className: 'modal-title' }, 'Compound title'),
            e(Dialog.Description, null, 'Compound description'),
          ),
        ),
      ),
    ),
  )

  assert.ok(html.includes('class="modal modal-lg"'), 'compound class names must be supported')
  assert.ok(html.includes('role="dialog"'))
  assert.ok(html.includes('Compound title'))
  assert.ok(html.includes('Compound description'))
})

test('Pure-Node SSR (window === undefined): ModalDialog, Kbd, TabsList scrollable, SearchBox surface, and DropdownMenuItem slots render cleanly', { timeout: 60_000 }, () => {
  assert.equal(typeof window, 'undefined', 'pure Node SSR environment must not define window')

  const modalHtml = renderToString(
    e(
      ModalDialog,
      {
        open: true,
        onClose: () => {},
        title: 'Save template',
        icon: 'bookmark',
        description: 'Reusable model tier preset.',
        size: 'sm',
        footer: e('button', { type: 'button', className: 'btn btn-primary btn-sm' }, 'Save'),
        children: e('div', null, 'Modal body'),
      },
    ),
  )
  assert.ok(modalHtml.includes('helmx-modal-backdrop'), 'ModalDialog must inline portal in pure Node SSR')
  assert.ok(modalHtml.includes('helmx-modal helmx-modal-sm'), 'ModalDialog size="sm" class lands')
  assert.ok(modalHtml.includes('Save template') && modalHtml.includes('Reusable model tier preset.'))
  assert.ok(modalHtml.includes('helmx-modal-footer'))

  const kbdHtml = renderToString(e(Kbd, { size: 'sm', desktopOnly: true }, 'Ctrl+.'))
  assert.ok(kbdHtml.includes('<kbd class="helmx-kbd helmx-kbd-sm helmx-kbd-desktop-only">Ctrl+.</kbd>'))

  const tabsHtml = renderToString(
    e(
      Tabs,
      { value: 'a', variant: 'underline', size: 'sm' },
      e(
        TabsList,
        { scrollable: true, 'aria-label': 'Scrollable tabs' },
        e(TabsTrigger, { value: 'a' }, 'Tab A'),
        e(TabsTrigger, { value: 'b' }, 'Tab B'),
      ),
    ),
  )
  assert.ok(tabsHtml.includes('tabs-bar helmx-tabs-scrollable'), 'TabsList scrollable renders .helmx-tabs-scrollable in SSR')
  assert.ok(!tabsHtml.includes('data-overflow-left='), 'no overflow attrs in pure SSR')

  const searchHtml = renderToString(
    e(SearchBox, { value: '', onChange: () => {}, surface: 'frameless', placeholder: 'Jump...' }),
  )
  assert.ok(searchHtml.includes('search-box search-box-frameless'))

  const menuHtml = renderToString(
    e(
      DropdownMenu,
      { open: true },
      e(
        DropdownMenuContent,
        null,
        e(
          DropdownMenuItem,
          { icon: 'list-tree', description: 'Draft plan before editing', shortcut: 'Ctrl+.', checked: true },
          'Plan mode',
        ),
      ),
    ),
  )
  assert.ok(menuHtml.includes('helmx-dropdown-item-has-desc'))
  assert.ok(menuHtml.includes('data-checked="true"'))
  assert.ok(menuHtml.includes('helmx-dropdown-item-shortcut'))
  assert.ok(menuHtml.includes('helmx-dropdown-item-check'))
})
