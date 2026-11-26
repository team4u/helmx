/**
 * @helmx/plugin-client lightweight layout primitive tests (real React SSR
 * renderToString):
 * - Screen / ScreenSection / DataTable / KvGrid are really exported from the
 *   shared SDK and bidirectionally locked against the protocol
 *   PLUGIN_CLIENT_SHARED_EXPORTS single manifest (every listed symbol actually
 *   exists at runtime);
 * - SSR safe: renderToString renders directly, no Portal, no browser side effects;
 * - Host generic classes are reused (.screen-container / .helmx-table-wrap /
 *   .kv-grid etc.), no new CSS theme;
 * - DataTable unifies the loading / empty placeholders (role=status /
 *   .table-empty); the data state passes children through.
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Window } from 'happy-dom'
import * as React from 'react'
import { Fragment } from 'react'
import { renderToString } from 'react-dom/server'
import { PLUGIN_CLIENT_SHARED_EXPORTS } from '@helmx/protocol'
import * as HelmxPluginClient from '../src/index.js'
import * as HelmxPluginClientPure from '../src/pure.js'
import { Screen, ScreenSection, ScreenToolbar, DataTable, KvGrid } from '../src/primitives.js'
import { ScreenHostContext } from '../src/screen-host.js'
import { StatusLight } from '../src/ui/StatusLight.js'
import {
  STATUS_LIGHT_TONES,
  isKnownStatusLightStatus,
  normalizeStatusLightTone,
  statusLightDotClass,
} from '../src/ui/status-light-model.js'
import { Button, IconButton } from '../src/ui/Button.js'
import { Badge } from '../src/ui/Badge.js'
import { Stack } from '../src/ui/Stack.js'
import { Input, Textarea } from '../src/ui/Input.js'
import { Field, HelperText, ErrorText } from '../src/ui/Field.js'
import { Card, SelectCard, CardGrid } from '../src/ui/Card.js'
import { MonoId } from '../src/ui/MonoId.js'
import { Select, MultiSelect } from '../src/ui/Select.js'
import { Switch } from '../src/ui/Switch.js'
import { Checkbox } from '../src/ui/Checkbox.js'
import { ToolCallDetails } from '../src/tool-details.js'
import { PluginClientContext } from '../src/plugin-context.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

test('layout primitives are in the shared SDK and the protocol manifest, and every manifest symbol is really exported (bidirectional locking)', { timeout: 60_000 }, () => {
  for (const name of ['Screen', 'ScreenSection', 'ScreenToolbar', 'DataTable', 'KvGrid']) {
    assert.ok(
      (PLUGIN_CLIENT_SHARED_EXPORTS as readonly string[]).includes(name),
      `PLUGIN_CLIENT_SHARED_EXPORTS must include ${name}`,
    )
    assert.equal(typeof HelmxPluginClient[name as keyof typeof HelmxPluginClient], 'function', `the shared SDK must really export ${name}`)
  }
  // Every manifest symbol really exists in the SDK runtime namespace (guards
  // against manifest/implementation drift).
  const exportedNames = new Set(Object.keys(HelmxPluginClient))
  for (const name of PLUGIN_CLIENT_SHARED_EXPORTS) {
    assert.ok(exportedNames.has(name), `the shared SDK is missing manifest symbol ${name} (PLUGIN_CLIENT_SHARED_EXPORTS drifted from the implementation)`)
  }
})

test('Screen: header composition renders screen-container / screen-header / screen-heading(title+subtitle) / actions siblings (SSR)', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(
      Screen,
      {
        title: 'Task Center',
        subtitle: '3 items',
        actions: e('button', { type: 'button' }, 'Refresh'),
      },
      e('div', { 'data-testid': 'body' }, 'Body'),
    ),
  )
  assert.match(html, /screen-container/)
  assert.match(html, /screen-header/)
  assert.match(html, /screen-heading/)
  assert.match(html, /screen-title/)
  assert.match(html, /screen-subtitle/)
  assert.match(html, /Task Center/)
  assert.match(html, /3 items/)

  const win = new Window()
  win.document.body.innerHTML = html
  const header = win.document.body.querySelector('.screen-header')
  assert.ok(header !== null, '.screen-header must be rendered')
  const children = Array.from(header.children)
  assert.equal(children.length, 2, '.screen-header contains only two direct children: .screen-heading on the left and .stack-row on the right')
  assert.equal(children[0]!.className, 'screen-heading')
  assert.equal(children[1]!.className, 'stack-row')
  assert.equal(children[0]!.querySelector('.screen-title')?.textContent, 'Task Center')
  assert.equal(children[0]!.querySelector('.screen-subtitle')?.textContent, '3 items')
  assert.ok(children[0]!.querySelector('.stack-row') === null, 'actions must not be wrapped into .screen-heading')
  assert.equal(children[1]!.querySelector('button')?.textContent, 'Refresh')

  // Only subtitle + actions (title omitted): .screen-heading still wraps the
  // subtitle and no empty .screen-title is rendered
  const subOnly = renderToString(
    e(Screen, { subtitle: 'Subtitle only', actions: e('button', { type: 'button' }, 'Act') }),
  )
  win.document.body.innerHTML = subOnly
  const subHeader = win.document.body.querySelector('.screen-header')!
  assert.equal(subHeader.children[0]!.className, 'screen-heading')
  assert.ok(subHeader.children[0]!.querySelector('.screen-title') === null)
  assert.equal(subHeader.children[0]!.querySelector('.screen-subtitle')?.textContent, 'Subtitle only')
  assert.equal(subHeader.children[1]!.className, 'stack-row')

  // Only actions: keep the .screen-heading placeholder to preserve the
  // justify-content: space-between right alignment
  const actionsOnly = renderToString(
    e(Screen, { actions: e('button', { type: 'button' }, 'New') }),
  )
  win.document.body.innerHTML = actionsOnly
  const actHeader = win.document.body.querySelector('.screen-header')!
  assert.equal(actHeader.children.length, 2)
  assert.equal(actHeader.children[0]!.className, 'screen-heading')
  assert.equal(actHeader.children[1]!.className, 'stack-row')
  void win.close()
})

test('Screen: a passed header replaces the default header entirely; with everything omitted no header is rendered', { timeout: 60_000 }, () => {
  const custom = renderToString(
    e(Screen, { header: e('div', { className: 'my-header' }, 'Custom') }, e('div', null, 'x')),
  )
  assert.match(custom, /my-header/)
  assert.doesNotMatch(custom, /screen-header/, 'a custom header must not double-render the default header')

  const bare = renderToString(e(Screen, null, e('div', null, 'x')))
  assert.match(bare, /screen-container/)
  assert.doesNotMatch(bare, /screen-header/, 'no header is rendered without title/subtitle/actions/header')
})

test('Screen: ScreenHostContext(hosted=true) omits duplicate title and collapses empty header structurally (SSR)', { timeout: 60_000 }, () => {
  const win = new Window()

  // 1) Hosted with title only: zero .screen-header and zero .screen-title (no empty DOM)
  const titleOnly = renderToString(
    e(
      ScreenHostContext.Provider,
      { value: { hosted: true } },
      e(Screen, { title: 'Duplicate Title' }, e('div', null, 'body')),
    ),
  )
  win.document.body.innerHTML = titleOnly
  assert.ok(win.document.body.querySelector('.screen-header') === null, 'hosted title-only Screen must not render .screen-header')
  assert.ok(win.document.body.querySelector('.screen-title') === null, 'hosted title-only Screen must not render .screen-title')
  assert.equal(win.document.body.querySelector('.screen-container')?.getAttribute('data-screen-layout'), 'contained')

  // 2) Hosted with title + subtitle + actions: omits .screen-title while preserving subtitle & actions
  const withSubAndActions = renderToString(
    e(
      ScreenHostContext.Provider,
      { value: { hosted: true } },
      e(
        Screen,
        {
          title: 'Duplicate Title',
          subtitle: '3 active rules',
          actions: e('button', { type: 'button' }, 'Reload'),
        },
        e('div', null, 'body'),
      ),
    ),
  )
  win.document.body.innerHTML = withSubAndActions
  const header = win.document.body.querySelector('.screen-header')
  assert.ok(header !== null, 'hosted Screen with subtitle/actions still renders .screen-header')
  assert.ok(header.querySelector('.screen-title') === null, 'hosted Screen omits duplicate .screen-title')
  assert.equal(header.querySelector('.screen-subtitle')?.textContent, '3 active rules')
  assert.equal(header.querySelector('.stack-row button')?.textContent, 'Reload')

  // 3) Hosted with title + actions (subtitle omitted): keeps actions without rendering .screen-title
  const actionsOnlyHosted = renderToString(
    e(
      ScreenHostContext.Provider,
      { value: { hosted: true } },
      e(
        Screen,
        {
          title: 'Duplicate Title',
          actions: e('button', { type: 'button' }, 'Create'),
        },
        e('div', null, 'body'),
      ),
    ),
  )
  win.document.body.innerHTML = actionsOnlyHosted
  assert.ok(win.document.body.querySelector('.screen-title') === null)
  assert.equal(win.document.body.querySelector('.screen-header .stack-row button')?.textContent, 'Create')

  // 4) Hosted with explicit custom header: custom header renders untouched
  const customHosted = renderToString(
    e(
      ScreenHostContext.Provider,
      { value: { hosted: true } },
      e(Screen, { header: e('div', { className: 'custom-hosted-header' }, 'Custom'), layout: 'full-bleed' }, e('div', null, 'body')),
    ),
  )
  win.document.body.innerHTML = customHosted
  assert.equal(win.document.body.querySelector('.custom-hosted-header')?.textContent, 'Custom')
  assert.equal(win.document.body.querySelector('.screen-container')?.getAttribute('data-screen-layout'), 'full-bleed')

  void win.close()
})

test('ScreenSection: an optional title renders screen-section / screen-section-title', { timeout: 60_000 }, () => {
  const withTitle = renderToString(e(ScreenSection, { title: 'Cron Jobs', titleExtra: '2 items' }, e('div', null, 'x')))
  assert.match(withTitle, /screen-section(?!-)/)
  assert.match(withTitle, /screen-section-title/)
  assert.match(withTitle, /Cron Jobs/)
  const noTitle = renderToString(e(ScreenSection, null, e('div', null, 'x')))
  assert.doesNotMatch(noTitle, /screen-section-title/)
})

test('ScreenToolbar: main area and right-aligned actions cluster render on one .screen-toolbar row (SSR)', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(
      ScreenToolbar,
      { label: 'Pane filters', className: 'demo-filters', actions: e(Button, null, 'Reload') },
      e('div', { className: 'search-box' }, 'search'),
    ),
  )
  assert.match(html, /screen-toolbar demo-filters/, 'host public toolbar class plus the scoping extension class')
  assert.match(html, /screen-toolbar-actions/, 'the actions cluster renders inside .screen-toolbar-actions')
  assert.match(html, /aria-label="Pane filters"/, 'label becomes the aria-label')
  const noActions = renderToString(e(ScreenToolbar, null, e('div', { className: 'search-box' }, 'search')))
  assert.doesNotMatch(noActions, /screen-toolbar-actions/, 'omitted actions render no empty cluster')
})

test('DataTable: the loading state renders the unified loading row (role=status) and not children', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(DataTable, {
      loading: true,
      loadingLabel: 'Loading rows…',
      columns: 3,
      children: e('thead', null, e('tr', null, e('th', null, 'a'))),
    }),
  )
  assert.match(html, /helmx-table-wrap/)
  assert.match(html, /helmx-table/)
  assert.match(html, /loading-state/)
  assert.match(html, /role="status"/)
  assert.match(html, /Loading rows…/)
  assert.doesNotMatch(html, /<thead/, 'the children thead is not rendered while loading')
})

test('DataTable: without explicit columns the colSpan is inferred from the single thead including Fragments (with cell colSpans)', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(
      DataTable,
      {
        loading: true,
        children: e(
          'thead',
          null,
          e('tr', null, e('th', { colSpan: 2 }, 'Group'), e(Fragment, { key: 'status' }, e('th', null, 'Status'))),
        ),
      },
    ),
  )
  assert.match(html, /<td colSpan="3">/, 'the colSpans of the first-row cells must be summed')
})

test('DataTable: the empty state renders the .table-empty placeholder row; the data state passes children through', { timeout: 60_000 }, () => {
  const empty = renderToString(
    e(DataTable, {
      empty: true,
      columns: 2,
      emptyLabel: 'No records',
      children: e('thead', null, 'h'),
    }),
  )
  assert.match(empty, /table-empty/)
  assert.match(empty, /No records/)
  assert.doesNotMatch(empty, /<thead/)

  const data = renderToString(
    e(DataTable, {
      label: 'Tasks',
      children: [
        e('thead', { key: 'head' }, e('tr', null, e('th', null, 'ID'), e('th', null, 'Name'))),
        e('tbody', { key: 'body' }, e('tr', null, e('td', null, '1'), e('td', null, 'Task one'))),
      ],
    }),
  )
  assert.match(data, /<thead/)
  assert.match(data, /Task one/)
  assert.match(data, /aria-label="Tasks"/)
})

test('KvGrid: items render as paired kv-grid direct children by key/value', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(KvGrid, {
      items: [
        { key: 'Cron jobs', value: 2 },
        { key: 'Webhook endpoints', value: 1 },
      ],
    }),
  )
  assert.match(html, /kv-grid/)
  assert.match(html, /kv-key/)
  assert.match(html, /kv-val/)
  assert.match(html, /Cron jobs/)
  assert.match(html, /Webhook endpoints/)
})

// ---------------------------------------------------------------------------
// StatusLight: unified status light (visually dot-only)
// ---------------------------------------------------------------------------

test('StatusLight: renders dot-only; the label is a screen-reader accessible name, never visible text', { timeout: 60_000 }, () => {
  const html = renderToString(e(StatusLight, { status: 'running', label: 'Running' }))
  assert.match(html, /helmx-status-light helmx-status-light-working/)
  assert.match(html, /status-dot status-dot-working/)
  assert.equal((html.match(/status-dot /g) ?? []).length, 1, 'exactly one dot')
  // Accessible name: role=img + aria-label + sr-only text (no visible label node, no width cost).
  assert.match(html, /role="img"/)
  assert.match(html, /aria-label="Running"/)
  assert.match(html, /helmx-sr-only">Running</)
  assert.doesNotMatch(html, /helmx-status-light-label/, 'no visible label element')
})

test('StatusLight: settled and neutral tones map honestly (completed/aborted/skipped/offline/unknown)', { timeout: 60_000 }, () => {
  assert.match(renderToString(e(StatusLight, { status: 'completed' })), /helmx-status-light-done/)
  assert.match(renderToString(e(StatusLight, { status: 'error' })), /status-dot-error/)
  // Aborted is NOT the plain gray idle dot: it keeps the dedicated diamond class.
  const aborted = renderToString(e(StatusLight, { status: 'aborted', label: 'Aborted' }))
  assert.match(aborted, /status-dot-aborted/)
  assert.doesNotMatch(aborted, /helmx-status-light-idle/)
  assert.match(renderToString(e(StatusLight, { status: 'skipped' })), /status-dot-pending/)
  assert.match(renderToString(e(StatusLight, { status: 'offline' })), /helmx-status-light-idle/)
  // Unknown statuses never fabricate a done/failed verdict.
  assert.match(renderToString(e(StatusLight, { status: 'weird-state' })), /helmx-status-light-pending/)
})

test('StatusLight: without a label the raw status word becomes the accessible-name fallback; extra className is appended; non-string labels keep the sr-only text', { timeout: 60_000 }, () => {
  const html = renderToString(e(StatusLight, { status: 'blocked', className: 'tray-status' }))
  assert.match(html, /helmx-status-light helmx-status-light-blocked tray-status/)
  assert.match(html, /status-dot status-dot-blocked/)
  assert.match(html, /aria-label="blocked"/, 'role=img never ends up nameless: raw status fallback')
  assert.doesNotMatch(html, /helmx-sr-only/, 'no sr-only node without an explicit label')
  const richLabel = renderToString(e(StatusLight, { status: 'done', label: e('em', undefined, 'Done') }))
  assert.match(richLabel, /helmx-sr-only"><em[^>]*>Done<\/em>/, 'ReactNode labels render as sr-only content')
  assert.equal(typeof normalizeStatusLightTone, 'function')
  assert.equal(statusLightDotClass('failed'), 'status-dot status-dot-error')
})

test('normalizeStatusLightTone: alias families collapse into the seven honest tones', { timeout: 60_000 }, () => {
  assert.equal(normalizeStatusLightTone('RUNNING'), 'working')
  assert.equal(normalizeStatusLightTone('superseded'), 'aborted')
  assert.equal(normalizeStatusLightTone('queued'), 'pending')
  assert.equal(normalizeStatusLightTone(undefined), 'pending')
  assert.equal(normalizeStatusLightTone(''), 'pending')
})

test('Screen: layout defaults to contained, supports full-bleed, and stamps data-plugin-id inside plugin context only', { timeout: 60_000 }, () => {
  const hostDefault = renderToString(e(Screen, { title: 'Overview' }, e('div', null, 'Body')))
  assert.match(hostDefault, /data-screen-layout="contained"/)
  assert.doesNotMatch(hostDefault, /data-plugin-id/, 'host Screen outside plugin context must omit data-plugin-id')

  const fullBleed = renderToString(e(Screen, { layout: 'full-bleed', className: 'canvas-screen' }, e('div', null, 'Canvas')))
  assert.match(fullBleed, /data-screen-layout="full-bleed"/)
  assert.match(fullBleed, /class="screen-container canvas-screen"/)

  const pluginCtx = {
    pluginId: 'builtin:herdr',
    callAction: async () => ({}),
    fetchRoute: async () => { throw new Error('fetchRoute not implemented in test stub') },
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
    theme: 'dark' as const,
    locale: 'en' as const,
    translate: (text: unknown) => (typeof text === 'string' ? text : ''),
  }
  const pluginScreen = renderToString(
    e(
      PluginClientContext.Provider,
      { value: pluginCtx },
      e(Screen, { layout: 'full-bleed' }, e('div', null, 'Grid')),
    ),
  )
  assert.match(pluginScreen, /data-screen-layout="full-bleed"/)
  assert.match(pluginScreen, /data-plugin-id="builtin:herdr"/)
})

test('StatusLight: explicit tone mode, connection aliases, pure exports, and prototype-safe predicate', { timeout: 60_000 }, () => {
  assert.deepEqual([...STATUS_LIGHT_TONES], ['working', 'blocked', 'done', 'failed', 'aborted', 'pending', 'idle'])
  assert.equal(HelmxPluginClient.STATUS_LIGHT_TONES, STATUS_LIGHT_TONES)
  assert.equal(HelmxPluginClient.normalizeStatusLightTone, normalizeStatusLightTone)
  assert.equal(HelmxPluginClient.isKnownStatusLightStatus, isKnownStatusLightStatus)
  assert.equal(HelmxPluginClientPure.STATUS_LIGHT_TONES, STATUS_LIGHT_TONES)
  assert.equal(HelmxPluginClientPure.normalizeStatusLightTone, normalizeStatusLightTone)
  assert.equal(HelmxPluginClientPure.isKnownStatusLightStatus, isKnownStatusLightStatus)

  assert.equal(normalizeStatusLightTone('connected'), 'done')
  assert.equal(normalizeStatusLightTone('disconnected'), 'idle')
  assert.equal(normalizeStatusLightTone('constructor'), 'pending')
  assert.equal(normalizeStatusLightTone('toString'), 'pending')
  assert.equal(isKnownStatusLightStatus('connected'), true)
  assert.equal(isKnownStatusLightStatus('RUNNING'), true)
  assert.equal(isKnownStatusLightStatus('weird-state'), false)
  assert.equal(isKnownStatusLightStatus('constructor'), false)
  assert.equal(isKnownStatusLightStatus(''), false)
  assert.equal(isKnownStatusLightStatus(undefined), false)

  const withLabel = renderToString(e(StatusLight, { tone: 'done', label: 'Connected' }))
  assert.match(withLabel, /data-tone="done"/)
  assert.match(withLabel, /aria-label="Connected"/)
  assert.match(withLabel, /helmx-sr-only">Connected<\/span>/)

  const withAriaOnly = renderToString(e(StatusLight, { tone: 'blocked', 'aria-label': 'Degraded link' }))
  assert.match(withAriaOnly, /data-tone="blocked"/)
  assert.match(withAriaOnly, /aria-label="Degraded link"/)
  assert.doesNotMatch(withAriaOnly, /helmx-sr-only/)

  // Rich ReactNode label wires aria-labelledby to the sr-only span so role="img" always has an accessible name
  const richToneHtml = renderToString(
    e(StatusLight, { tone: 'done', label: e('span', null, 'Connected') } as unknown as Parameters<typeof StatusLight>[0]),
  )
  const richDoc = new Window().document
  richDoc.body.innerHTML = richToneHtml
  const richImg = richDoc.querySelector('[role="img"]')
  const richSr = richDoc.querySelector('.helmx-sr-only')
  assert.ok(richImg !== null && richSr !== null)
  assert.ok(richSr.id.length > 0 && richImg.getAttribute('aria-labelledby') === richSr.id)
  assert.equal(richSr.textContent, 'Connected')

  // Blank string label in tone mode still falls back to tone so role="img" is never nameless
  const blankToneHtml = renderToString(e(StatusLight, { tone: 'failed', label: '   ' }))
  assert.match(blankToneHtml, /aria-label="failed"/)
  assert.doesNotMatch(blankToneHtml, /helmx-sr-only/)

  // Blank aria-label + empty rich node label falls back to tone instead of wiring aria-labelledby to empty text
  const emptyRichToneHtml = renderToString(
    e(StatusLight, { tone: 'done', 'aria-label': '   ', label: e('span', null) }),
  )
  assert.match(emptyRichToneHtml, /aria-label="done"/)
  assert.doesNotMatch(emptyRichToneHtml, /aria-labelledby=/)
  assert.doesNotMatch(emptyRichToneHtml, /helmx-sr-only/)
})

test('Button and IconButton: variants, sizes, pending busy state, and required accessible name (SSR)', { timeout: 60_000 }, () => {
  const defaultBtn = renderToString(e(Button, null, 'Save'))
  assert.match(defaultBtn, /<button[^>]*type="button"[^>]*class="btn"/)
  assert.match(defaultBtn, /<span>Save<\/span>/)

  const primarySm = renderToString(e(Button, { variant: 'primary', size: 'sm', pill: true, icon: 'check' }, 'Apply'))
  assert.match(primarySm, /class="btn btn-primary btn-sm btn-pill"/)
  assert.match(primarySm, /<svg/)

  const dangerSm = renderToString(e(Button, { variant: 'danger', size: 'sm' }, 'Delete'))
  assert.match(dangerSm, /class="btn btn-danger btn-sm"/)
  assert.doesNotMatch(dangerSm, /btn-danger-sm/)

  const pendingBtn = renderToString(e(Button, { variant: 'secondary', size: 'xs', icon: 'save', pending: true, 'aria-busy': false }, 'Saving'))
  assert.match(pendingBtn, /class="btn btn-secondary btn-xs"/)
  assert.match(pendingBtn, /disabled=""/)
  assert.match(pendingBtn, /aria-busy="true"/, 'pending=true must not be overridden by caller aria-busy=false')
  assert.match(pendingBtn, /spin-slow/)

  const iconBtn = renderToString(e(IconButton, { icon: 'refresh-cw', label: 'Refresh', size: 'sm' }))
  assert.match(iconBtn, /class="btn btn-ghost btn-icon-sm"/)
  assert.match(iconBtn, /aria-label="Refresh"/)
  assert.match(iconBtn, /title="Refresh"/)

  const iconBtnPending = renderToString(e(IconButton, { icon: 'trash-2', 'aria-label': 'Remove', variant: 'danger', size: 'xs', pending: true, 'aria-busy': false }))
  assert.match(iconBtnPending, /class="btn btn-danger btn-icon-xs"/)
  assert.match(iconBtnPending, /aria-busy="true"/, 'IconButton pending=true must not be overridden by caller aria-busy=false')
  assert.match(iconBtnPending, /spin-slow/)

  const iconBtnFallbackAria = renderToString(e(IconButton, { icon: 'x', label: '   ', 'aria-label': 'Close' }))
  assert.match(iconBtnFallbackAria, /aria-label="Close"/)
  assert.doesNotMatch(iconBtnFallbackAria, /title="/)
  assert.doesNotMatch(iconBtnFallbackAria, /aria-pressed=/)

  const inlineBtn = renderToString(e(Button, { variant: 'inline', icon: 'chevron-down' }, 'Expand'))
  assert.match(inlineBtn, /class="btn btn-inline"/)
  assert.match(inlineBtn, /width="11"/)
  assert.match(inlineBtn, /<span>Expand<\/span>/)

  const activeToggle = renderToString(e(IconButton, { icon: 'list-filter', label: 'Filter', size: 'xs', active: true }))
  assert.match(activeToggle, /class="btn btn-ghost btn-icon-xs is-active"/)
  assert.match(activeToggle, /aria-pressed="true"/)

  const inactiveToggle = renderToString(e(IconButton, { icon: 'list-filter', label: 'Filter', size: 'xs', active: false }))
  assert.match(inactiveToggle, /class="btn btn-ghost btn-icon-xs"/)
  assert.match(inactiveToggle, /aria-pressed="false"/)

  assert.throws(
    () => renderToString(e(IconButton, { icon: 'x', label: '' })),
    /non-empty/,
    'IconButton must reject empty label',
  )
  assert.throws(
    () => renderToString(e(IconButton, { icon: 'x', label: '   ' })),
    /non-empty/,
    'IconButton must reject whitespace-only label',
  )
  assert.throws(
    () => renderToString(e(IconButton, { icon: 'x', 'aria-label': '   ' })),
    /non-empty/,
    'IconButton must reject whitespace-only aria-label',
  )
})

test('ToolCallDetails: bootstraps artifact trigger via SDK Button size="xs" (SSR)', { timeout: 60_000 }, () => {
  const pluginCtx = {
    pluginId: 'builtin:workflow',
    callAction: async () => ({}),
    fetchRoute: async () => { throw new Error('fetchRoute not implemented in test stub') },
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
    theme: 'dark' as const,
    locale: 'en' as const,
    translate: (text: unknown) => (typeof text === 'string' ? text : ''),
  }

  const withArtifact = renderToString(
    e(
      PluginClientContext.Provider,
      { value: pluginCtx },
      e(ToolCallDetails, { input: { cmd: 'ls' }, result: 'ok', artifactRef: 'art_42', defaultOpen: true }),
    ),
  )
  assert.match(
    withArtifact,
    /<button[^>]*type="button"[^>]*class="btn btn-xs"[^>]*><span>[\s\S]*?#[\s\S]*?art_42<\/span><\/button>/,
    'ToolCallDetails artifact button must render through SDK Button size="xs"',
  )

  const withoutArtifact = renderToString(
    e(
      PluginClientContext.Provider,
      { value: pluginCtx },
      e(ToolCallDetails, { input: { cmd: 'ls' }, result: 'ok', artifactRef: '' }),
    ),
  )
  assert.doesNotMatch(withoutArtifact, /<button/, 'empty artifactRef must not render an artifact button')
})

test('Badge and Stack: static host classes without inline style hacks (SSR)', { timeout: 60_000 }, () => {
  const badgeHtml = renderToString(e(Badge, { tone: 'ok', icon: 'check', mono: true }, 'v1.2.3'))
  assert.match(badgeHtml, /class="badge badge-ok mono"/)
  assert.match(badgeHtml, /<span>v1\.2\.3<\/span>/)

  const stackHtml = renderToString(
    e(Stack, { direction: 'horizontal', gap: 'md', align: 'center', justify: 'between', wrap: true, inline: true }, 'A', 'B'),
  )
  assert.match(
    stackHtml,
    /class="helmx-stack helmx-stack-inline helmx-stack-horizontal helmx-stack-gap-md helmx-stack-align-center helmx-stack-justify-between helmx-stack-wrap"/,
  )
  assert.doesNotMatch(stackHtml, /style=/)
})

test('Field, Input, Textarea, Select, MultiSelect, Switch, Checkbox: FieldContext wiring and non-wrapping labels (SSR)', { timeout: 60_000 }, () => {
  const inputFieldHtml = renderToString(
    e(
      Field,
      { label: 'API Key', hint: 'Stored encrypted', error: 'Key is required', required: true },
      e(Input, { size: 'sm', mono: true, 'aria-describedby': 'custom-note', value: '', readOnly: true }),
    ),
  )
  const doc = new Window().document
  doc.body.innerHTML = inputFieldHtml
  const label = doc.querySelector('label.helmx-field-label')
  const input = doc.querySelector('input.input.input-sm.mono')
  const errEl = doc.querySelector('p.helmx-error-text')
  const hintEl = doc.querySelector('p.helmx-helper-text')
  assert.ok(label !== null && input !== null && errEl !== null && hintEl !== null)
  assert.ok(!label.contains(input), 'Field label must never wrap children controls')
  assert.equal(label.getAttribute('for'), input.id)
  assert.equal(input.getAttribute('aria-invalid'), 'true')
  assert.equal(input.hasAttribute('required'), true)
  assert.equal(input.getAttribute('aria-describedby'), `custom-note ${errEl.id} ${hintEl.id}`)
  assert.equal(errEl.getAttribute('role'), null, 'static per-field ErrorText omits role="alert" by default')

  const liveErrHtml = renderToString(e(ErrorText, { live: true }, 'Submit failed'))
  assert.match(liveErrHtml, /role="alert"/)
  const helperHtml = renderToString(e(HelperText, null, 'Optional note'))
  assert.match(helperHtml, /class="helmx-helper-text"/)

  // Explicit caller overrides beat FieldContext
  const overrideHtml = renderToString(
    e(
      Field,
      { label: 'Notes', error: 'Too long', required: true },
      e(Textarea, { id: 'notes-custom', invalid: false, required: false, mono: true }),
    ),
  )
  const doc2 = new Window().document
  doc2.body.innerHTML = overrideHtml
  const textarea = doc2.querySelector('textarea.textarea.mono')
  assert.ok(textarea !== null)
  assert.equal(textarea.id, 'notes-custom')
  assert.equal(textarea.getAttribute('aria-invalid'), null)
  assert.equal(textarea.hasAttribute('required'), false)

  // Select + MultiSelect + Switch + Checkbox wiring, plus MultiSelect inner Checkbox isolation
  const controlsHtml = renderToString(
    e(
      Fragment,
      null,
      e(
        Field,
        { label: 'Region', error: 'Select a region', required: true },
        e(Select, { value: 'us', options: [{ value: 'us', label: 'US' }], onChange: () => {} }),
      ),
      e(
        Field,
        { label: 'Scopes', error: 'Pick at least one' },
        e(MultiSelect, {
          open: true,
          inline: true,
          value: [],
          options: [{ value: 'read', label: 'Read' }],
        }),
      ),
      e(
        Field,
        { label: 'Enable sync', hint: 'Runs hourly' },
        e(Switch, { checked: true, onChange: () => {} }),
      ),
      e(
        Field,
        { label: 'Notifications', htmlFor: false, error: 'Choose an option' },
        e(Checkbox, { checked: false, onChange: () => {}, label: 'Email alerts' }),
      ),
    ),
  )
  const doc3 = new Window().document
  doc3.body.innerHTML = controlsHtml
  const fields = [...doc3.querySelectorAll('.helmx-field')]
  assert.equal(fields.length, 4)

  // 1) Single Select
  const selectLabel = fields[0]!.querySelector('label.helmx-field-label')
  const selectTrigger = fields[0]!.querySelector('.helmx-select-trigger')
  assert.ok(selectLabel !== null && selectTrigger !== null)
  assert.equal(selectLabel.getAttribute('for'), selectTrigger.id)
  assert.equal(selectTrigger.getAttribute('aria-invalid'), 'true')
  assert.equal(selectTrigger.getAttribute('aria-required'), 'true')
  assert.ok((selectTrigger.getAttribute('aria-describedby') ?? '').includes('-error'))

  // 2) MultiSelect trigger gets aria-invalid, inner option Checkbox does NOT inherit parent FieldContext
  const multiTrigger = fields[1]!.querySelector('.helmx-select-trigger')
  const innerCheckbox = fields[1]!.querySelector('[role="checkbox"]')
  assert.ok(multiTrigger !== null && innerCheckbox !== null)
  assert.equal(multiTrigger.getAttribute('aria-invalid'), 'true')
  assert.equal(innerCheckbox.getAttribute('aria-invalid'), null, 'MultiSelect inner option Checkbox must be isolated from outer FieldContext')
  assert.ok(innerCheckbox.id !== multiTrigger.id, 'inner option Checkbox must not reuse MultiSelect trigger ID')

  // 3) Switch without own label connects to Field <label htmlFor>
  const switchLabel = fields[2]!.querySelector('label.helmx-field-label')
  const switchBtn = fields[2]!.querySelector('[role="switch"]')
  assert.ok(switchLabel !== null && switchBtn !== null)
  assert.equal(switchLabel.getAttribute('for'), switchBtn.id)
  assert.ok((switchBtn.getAttribute('aria-describedby') ?? '').includes('-hint'))

  // 4) Group Field (htmlFor={false}) renders role="group" + aria-labelledby, zero nested <label>
  assert.equal(fields[3]!.getAttribute('role'), 'group')
  const groupSpan = fields[3]!.querySelector('span.helmx-field-label')
  assert.ok(groupSpan !== null)
  assert.equal(fields[3]!.getAttribute('aria-labelledby'), groupSpan.id)
  const checkboxEl = fields[3]!.querySelector('[role="checkbox"]')
  assert.ok(checkboxEl !== null)
  assert.equal(checkboxEl.getAttribute('aria-invalid'), 'true')
  assert.equal(fields[3]!.querySelectorAll('label label').length, 0, 'must never produce nested <label> elements')
})

test('Card, SelectCard, CardGrid, and MonoId: accessible landmarks, sibling actions, and truncation (SSR)', { timeout: 60_000 }, () => {
  const cardHtml = renderToString(
    e(
      Card,
      {
        variant: 'subtle',
        tone: 'danger',
        title: 'Danger Zone',
        subtitle: 'Irreversible actions',
        actions: e(Button, { variant: 'danger', size: 'sm' }, 'Delete'),
        footer: e('span', null, 'Requires confirmation'),
      },
      e('p', null, 'Removes all stored tokens.'),
    ),
  )
  const doc = new Window().document
  doc.body.innerHTML = cardHtml
  const section = doc.querySelector('section.helmx-card.helmx-card-subtle.helmx-card-danger')
  const heading = doc.querySelector('h3.helmx-card-title')
  assert.ok(section !== null && heading !== null)
  assert.equal(section.getAttribute('aria-labelledby'), heading.id)

  const gridHtml = renderToString(
    e(
      CardGrid,
      { minWidth: 'sm', gap: 'lg' },
      e(
        SelectCard,
        {
          title: 'vmi-bot',
          subtitle: 'Sync connector',
          selected: true,
          tone: 'warn',
          actions: e(Switch, { checked: true, onChange: () => {}, 'aria-label': 'Toggle vmi-bot' }),
          footer: e(MonoId, { value: 'bot_1234567890abcdef', display: 'bot_1234...cdef' }),
          onSelect: () => {},
        },
        e('p', null, 'Body text'),
      ),
    ),
  )
  const doc2 = new Window().document
  doc2.body.innerHTML = gridHtml
  const grid = doc2.querySelector('.helmx-card-grid.helmx-card-grid-sm.helmx-card-grid-gap-lg')
  const article = doc2.querySelector('article.helmx-select-card.is-selected.helmx-select-card-warn')
  const trigger = doc2.querySelector('button.helmx-select-card-trigger')
  const switchBtn = doc2.querySelector('[role="switch"]')
  const monoCode = doc2.querySelector('code.helmx-mono-id-code')
  const copyBtn = doc2.querySelector('button.helmx-mono-id-copy')
  assert.ok(grid !== null && article !== null && trigger !== null && switchBtn !== null && monoCode !== null && copyBtn !== null)
  assert.equal(trigger.getAttribute('aria-pressed'), 'true')
  assert.ok(!trigger.contains(switchBtn), 'actions Switch must be a sibling of the trigger button, never nested inside it')
  assert.equal(article.getAttribute('role'), null, 'SelectCard article must not wear role="button" over interactive descendants')
  assert.equal(monoCode.getAttribute('title'), 'bot_1234567890abcdef')
  assert.equal(monoCode.textContent, 'bot_1234...cdef')

  const plainMono = renderToString(e(MonoId, { value: 'id-999', copyable: false }))
  assert.match(plainMono, /helmx-mono-id-code/)
  assert.doesNotMatch(plainMono, /helmx-mono-id-copy/)
})
