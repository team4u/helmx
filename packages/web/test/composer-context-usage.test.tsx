/**
 * DOM regression for the Composer context-usage read-only status text (real mount).
 *
 * Contract (mirroring the pi footer display rules):
 * - a read-only span: no button / no Popover / no gauge icon; clicks open nothing;
 * - known window shows `${percent.toFixed(1)}%/${formatTokens(window)}` (e.g. 37.5%/200k);
 *   >90 red (composer-context-status-high), >70 yellow (-warn), else default gray;
 * - tokens=null (no valid usage yet after compaction) shows `?/window`; unknown window
 *   shows the compact estimate;
 * - tokens=0（空会话/刚 reset）不渲染；压缩中显示「精简中…」；
 * - 无 contextUsage（内核尚未刷新）不渲染；
 * - rate metrics are not rendered built-in by the host (policy belongs to the optional
 *   builtin:token-speed plugin, contributed via the COMPOSER_STATUS_SLOT).
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import * as React from 'react'
import { act } from 'react'
import type {
  ComposerMenuSlotProps,
  ComposerScopeProps,
  ComposerStatusSlotProps,
  ComposerToolbarSlotProps,
  ConversationSummary,
} from '@helmx/protocol'
import { COMPOSER_MENU_SLOT, COMPOSER_STATUS_SLOT, COMPOSER_TOOLBAR_SLOT } from '@helmx/protocol'
import {
  getStandbyDraft,
  resetStandbyDrafts,
  standbyDraftKey,
  standbyDraftsDirty,
} from '../src/conversation/standby-model.js'
import { applySnapshot, emptyLiveState, mergeConversationDetail } from '../src/lib/live-state.js'
import { makeTestStore } from './helpers/store.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'
import { resetPluginClientCache, seedPluginClientModule } from '../src/lib/plugin-client.js'
import { groupUiContributions } from '../src/lib/types.js'
import type { HelmxStoreValue } from '../src/lib/types.js'

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { renderToStaticMarkup } = await import('react-dom/server')
const { DropdownMenuItem } = await import('@helmx/ui')
const { useComposerCommand } = await import('@helmx/plugin-client')
const { Composer } = await import('../src/conversation/Composer.js')
const { AgentStandbyPane } = await import('../src/conversation/AgentStandbyPane.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')

const e = React.createElement

function conv(contextUsage: ConversationSummary['contextUsage']): ConversationSummary {
  return {
    id: 1, title: '会话 1', profileId: 'assistant', tags: [], cwd: '/tmp',
    model: 'faux/faux-1', thinkingLevel: '', status: 'idle',
    stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false,
    pendingAskCount: 0, createdAt: 0, updatedAt: 0, contextUsage,
  }
}

function storeOf(conversation: ConversationSummary): HelmxExternalStore {
  return makeTestStore({ conversations: [conversation] })
}

async function mountComposer(conversation: ConversationSummary): Promise<{ host: HTMLElement; unmount: () => void }> {
  const store = storeOf(conversation)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(e(HostStoreProviders, { value: store }, e(Composer, { conversation, prefill: null })))
  })
  return { host, unmount: () => { act(() => root.unmount()); host.remove() } }
}

function statusSpan(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>('.composer-context-status')
}

/** Assert read-only: no button, no gauge icon, no popover on click. */
function assertReadOnly(host: HTMLElement): void {
  const span = statusSpan(host)
  assert.ok(span, 'the status text must render')
  assert.ok(span.querySelector('button') === null, 'no nested button')
  assert.ok(span.querySelector('svg') === null, 'no gauge or other icons')
  assert.ok(host.querySelector('button.composer-context-status') === null, 'the status text must not be a button')
  act(() => { span.click() })
  assert.ok(document.body.querySelector('.composer-context-popover') === null, 'clicks must not open any popover')
  assert.ok(document.body.querySelector('[data-radix-popper-content-wrapper]') === null)
}

test('no status text renders without contextUsage or with tokens=0', { timeout: 60_000 }, async () => {
  const none = await mountComposer(conv(undefined))
  try {
    assert.ok(statusSpan(none.host) === null)
  } finally {
    none.unmount()
  }
  const zero = await mountComposer(conv({ tokens: 0 }))
  try {
    assert.ok(statusSpan(zero.host) === null, 'an empty conversation or fresh reset (tokens=0) shows no status text')
  } finally {
    zero.unmount()
  }
})

test('known window: pi-style 37.5%/200k, default gray, read-only', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ tokens: 75_000, contextWindow: 200_000 }))
  try {
    const span = statusSpan(host)
    assert.ok(span)
    assert.equal(span.textContent, '37.5%/200k')
    assert.equal(span.classList.contains('composer-context-status-high'), false)
    assert.equal(span.classList.contains('composer-context-status-warn'), false)
    assertReadOnly(host)
  } finally {
    unmount()
  }
})

test('ratio >70 yellow, >90 red (strictly greater than the thresholds)', { timeout: 60_000 }, async () => {
  const warn = await mountComposer(conv({ tokens: 75_100, contextWindow: 100_000 }))
  try {
    const span = statusSpan(warn.host)
    assert.equal(span?.textContent, '75.1%/100k')
    assert.equal(span?.classList.contains('composer-context-status-warn'), true)
    assert.equal(span?.classList.contains('composer-context-status-high'), false)
  } finally {
    warn.unmount()
  }
  const high = await mountComposer(conv({ tokens: 92_000, contextWindow: 100_000 }))
  try {
    const span = statusSpan(high.host)
    assert.equal(span?.textContent, '92.0%/100k')
    assert.equal(span?.classList.contains('composer-context-status-high'), true)
  } finally {
    high.unmount()
  }
})

test('tokens=null (no valid usage yet after compaction): shows ?/window, uncolored', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ tokens: null, contextWindow: 200_000 }))
  try {
    const span = statusSpan(host)
    assert.equal(span?.textContent, '?/200k')
    assert.equal(span?.classList.contains('composer-context-status-warn'), false)
    assert.equal(span?.classList.contains('composer-context-status-high'), false)
  } finally {
    unmount()
  }
})

test('unknown window: shows only the compact estimate (no fake percentage/denominator), uncolored', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ tokens: 12_345 }))
  try {
    const span = statusSpan(host)
    assert.equal(span?.textContent, '12k')
    assert.ok(!span!.textContent.includes('%'))
    assert.equal(span?.classList.contains('composer-context-status-warn'), false)
    assert.equal(span?.classList.contains('composer-context-status-high'), false)
  } finally {
    unmount()
  }
})

test('while compacting: the read-only compacting text', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ tokens: null, contextWindow: 100_000, compacting: true }))
  try {
    const span = statusSpan(host)
    assert.equal(span?.textContent, 'Compacting…')
    assertReadOnly(host)
  } finally {
    unmount()
  }
})

test('first open of an idle conversation after restart: the merged list summary carries contextUsage and the status text renders', { timeout: 60_000 }, async () => {
  // The kernel fills the usage cache silently without an SSE frame: the snapshot summary
  // has no usage; only the HTTP detail carries it
  const base = conv(undefined)
  let state = applySnapshot(emptyLiveState(), { bootId: 'test-boot', seq: 3, conversations: [base], pendingAsks: [], plugins: [], ui: [] })
  state = mergeConversationDetail(state, { ...base, entries: [], contextUsage: { tokens: 25_000, contextWindow: 100_000 } })
  // ConversationPane passes summary ?? detail to the Composer: the status text data source is the merged list summary
  const merged = state.conversations.find((c) => c.id === 1)
  assert.ok(merged?.contextUsage, 'the merged list summary must carry contextUsage')
  const { host, unmount } = await mountComposer(merged)
  try {
    assert.equal(statusSpan(host)?.textContent, '25.0%/100k')
  } finally {
    unmount()
  }
})

test('CSS specificity regression: load the real composer.css and verify tone classes truly override the default gray', { timeout: 60_000 }, () => {
  // Regression background: the base rule `.composer-status-row .composer-context-status` (0,2,0)
  // must never outrank `.composer-status-row .composer-context-status-warn/-high` (0,2,0, declared later),
  // otherwise yellow/red never apply. DOM class assertions cannot catch that bug: verify with computedStyle from the real stylesheet.
  const css = readFileSync(new URL('../src/styles/composer.css', import.meta.url), 'utf8')
  const style = document.createElement('style')
  style.textContent = `:root { --fg-muted: rgb(11, 12, 13); --warn: rgb(21, 22, 23); --err: rgb(31, 32, 33); }\n${css}`
  document.head.appendChild(style)
  const row = document.createElement('div')
  row.className = 'composer-status-row'
  const base = document.createElement('span')
  base.className = 'composer-context-status'
  const warn = document.createElement('span')
  warn.className = 'composer-context-status composer-context-status-warn'
  const high = document.createElement('span')
  high.className = 'composer-context-status composer-context-status-high'
  row.append(base, warn, high)
  document.body.appendChild(row)
  try {
    assert.equal(getComputedStyle(base).color, 'rgb(11, 12, 13)')
    assert.equal(getComputedStyle(warn).color, 'rgb(21, 22, 23)', 'the warn tone must override the default gray (specificity must not fall below the base rule)')
    assert.equal(getComputedStyle(high).color, 'rgb(31, 32, 33)', 'the high tone must override the default gray')
  } finally {
    row.remove()
    style.remove()
  }
})

test('rate metrics are not rendered built-in: contextUsage has no response field (policy belongs to optional plugins)', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ tokens: 75_000, contextWindow: 200_000 }))
  try {
    // @ts-expect-error response is removed: rate display belongs entirely to the builtin:token-speed plugin via COMPOSER_STATUS_SLOT
    conv({ tokens: 1, response: { responseTps: 52.4 } })
    assert.ok(host.querySelector('.composer-context-tps') === null, 'the host renders no built-in rate text')
    assert.equal(statusSpan(host)?.textContent, '37.5%/200k', 'the context status is unaffected')
  } finally {
    unmount()
  }
})

test('composer/status host slot: PluginSlot mounts in the status area; contributed components receive ComposerScopeProps', { timeout: 60_000 }, async () => {
  const { usePluginContext } = await import('@helmx/plugin-client')
  // SSR render (same convention as the profile-center slot tests): client components are
  // ready synchronously from the seeded cache, no real fetch from the dynamic-load effect.
  function ComposerStatusProbe(props: ComposerScopeProps) {
    const ctx = usePluginContext()
    return e(
      'span',
      { className: 'probe-composer-status', 'data-probe': 'composer-status' },
      `conv:${props.conversation.id} draft:${props.composer.draft.length} ctx-composer:${ctx.composer !== undefined}`,
    )
  }
  seedPluginClientModule('builtin:demo', 'index.tsx', { ComposerStatusProbe })
  const conversation = conv({
    tokens: 75_000,
    contextWindow: 200_000,
  })
  const store = makeTestStore({
    conversations: [conversation],
    uiContributions: [
      {
        pluginId: 'builtin:demo',
        surface: 'plugin.slot',
        spec: {
          id: 'demo-status',
          target: COMPOSER_STATUS_SLOT,
          client: { module: 'index.tsx', export: 'ComposerStatusProbe' },
        },
      },
    ],
  })
  const html = renderToStaticMarkup(
    e(HostStoreProviders, { value: store }, e(Composer, { conversation, prefill: null })),
  )
  const probeAt = html.indexOf('data-probe="composer-status"')
  assert.ok(probeAt >= 0, 'slot contributions must render through PluginSlot')
  assert.match(html, /conv:1 draft:0 ctx-composer:true/, 'contributed components receive the standard conversation + composer Props; usePluginContext().composer also gets the host input controller')
  // Mount position: dedicated read-only telemetry row below .composer-box (decoupled from .composer-toolbar controls and never inside .composer-extras).
  const boxAt = html.indexOf('composer-box')
  const toolbarAt = html.indexOf('composer-toolbar')
  const rowAt = html.indexOf('composer-status-row')
  const statusAt = html.indexOf('composer-context-status')
  const slotAt = html.indexOf('composer-status-slot')
  const extrasAt = html.indexOf('composer-extras')
  assert.ok(boxAt >= 0 && toolbarAt > boxAt && rowAt > toolbarAt, 'the status row sits below .composer-box and outside .composer-toolbar')
  assert.ok(statusAt > rowAt && slotAt > statusAt, 'the slot sits inside .composer-status-row right after ContextUsageStatus')
  assert.ok(extrasAt < 0 || extrasAt < rowAt, 'the status row is never inside the more-menu container')
  assert.ok(html.includes('probe-composer-status'), 'slot contributions render in the same telemetry row as the context status')
})

test('composer/status DOM placement & empty collapse: telemetry row sits below .composer-box and collapses when empty', { timeout: 60_000 }, async () => {
  function EmptyStatusProbe() {
    return null
  }
  seedPluginClientModule('builtin:empty-status', 'index.tsx', { EmptyStatusProbe })
  const css = readFileSync(new URL('../src/styles/composer.css', import.meta.url), 'utf8')
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)

  const conversation = conv(undefined)
  const store = makeTestStore({
    conversations: [conversation],
    plugins: [
      {
        id: 'builtin:empty-status',
        name: 'empty-status',
        version: '1.0.0',
        locked: false,
        enabled: true,
        status: 'active',
        hooks: [],
        actions: [],
        tools: [],
        clientHashes: { 'index.tsx': 'seeded' },
      },
    ],
    uiContributions: [
      {
        pluginId: 'builtin:empty-status',
        surface: 'plugin.slot',
        spec: {
          id: 'empty-status',
          target: COMPOSER_STATUS_SLOT,
          client: { module: 'index.tsx', export: 'EmptyStatusProbe' },
        },
      },
    ],
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(e(HostStoreProviders, { value: store }, e(Composer, { conversation, prefill: null })))
    })
    const row = host.querySelector<HTMLElement>('.composer-status-row')
    assert.ok(row !== null)
    assert.ok(row.previousElementSibling?.classList.contains('composer-box') === true, 'telemetry row is the sibling right below .composer-box')
    assert.ok(host.querySelector('.composer-toolbar .composer-context-status') === null)
    assert.ok(host.querySelector('.composer-toolbar .composer-status-slot') === null)
    assert.equal(getComputedStyle(row).display, 'none', 'empty telemetry row (no contextUsage and null slot output) collapses to display:none')

    const populated = conv({ tokens: 75_000, contextWindow: 200_000 })
    const populatedStore = makeTestStore({ conversations: [populated] })
    await act(async () => {
      root.render(e(HostStoreProviders, { value: populatedStore }, e(Composer, { conversation: populated, prefill: null })))
    })
    const rowWithUsage = host.querySelector<HTMLElement>('.composer-status-row')
    assert.ok(rowWithUsage !== null)
    assert.equal(getComputedStyle(rowWithUsage).display, 'flex', 'telemetry row is visible when contextUsage renders')

    // Multi-contribution flat wrapping regression: .composer-status-slot must use display:contents so
    // short badges (e.g. token-speed) stay on the first line beside ContextUsageStatus instead of
    // wrapping as one nested flex block with a wider quota trigger onto line 2.
    const flatSlot = document.createElement('div')
    flatSlot.className = 'composer-status-slot'
    const child = document.createElement('span')
    child.textContent = '127 tok/s'
    flatSlot.appendChild(child)
    rowWithUsage.appendChild(flatSlot)
    try {
      assert.equal(getComputedStyle(flatSlot).display, 'contents', 'status slot flattens into the parent flex row for per-item wrapping')
    } finally {
      flatSlot.remove()
    }
  } finally {
    act(() => root.unmount())
    host.remove()
    style.remove()
  }
})

test('composer/status renders no container without contributions (zero noise in the host status area)', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ tokens: 75_000, contextWindow: 200_000 }))
  try {
    assert.ok(host.querySelector('.composer-status-slot') === null, 'PluginSlot renders null without contributions')
    assert.ok(host.querySelector('[data-probe]') === null)
  } finally {
    unmount()
  }
})

test('Composer localizes input aria, upload button, placeholder and compacting status in zh-CN', { timeout: 60_000 }, async () => {
  const conversation = conv({ tokens: null, contextWindow: 100_000, compacting: true })
  const storeZh = makeTestStore({ locale: 'zh-CN', conversations: [conversation] })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(e(HostStoreProviders, { value: storeZh }, e(Composer, { conversation, prefill: null })))
    })
    assert.ok(host.querySelector('textarea[aria-label="输入消息"]') !== null)
    assert.ok(host.querySelector('button[aria-label="更多操作与附件"]') !== null)
    assert.equal(statusSpan(host)?.textContent, '精简中…')

    await act(async () => {
      storeZh.setLocale('en')
      root.render(e(HostStoreProviders, { value: storeZh }, e(Composer, { conversation, prefill: null })))
    })
    assert.ok(host.querySelector('textarea[aria-label="Type a message"]') !== null)
    assert.ok(host.querySelector('button[aria-label="More actions and attachments"]') !== null)
    assert.equal(statusSpan(host)?.textContent, 'Compacting…')
  } finally {
    localStorage.removeItem('helmx:locale')
    act(() => root.unmount())
    host.remove()
  }
})

test('AgentStandbyPane mounts COMPOSER_STATUS_SLOT below .composer-box with effectiveModel and profileId', { timeout: 60_000 }, async () => {
  let received: ComposerStatusSlotProps | undefined
  function StandbyStatusProbe(props: ComposerStatusSlotProps) {
    received = props
    return e('span', { className: 'standby-status-probe' }, props.effectiveModel ?? '')
  }
  seedPluginClientModule('builtin:standby-status', 'index.tsx', { StandbyStatusProbe })

  const store = makeTestStore({
    profiles: [
      {
        id: 'assistant',
        name: 'Assistant',
        model: 'magpie/auto/gemini-4-carbon',
        thinkingLevel: 'high',
        cwd: '/tmp',
        nodeId: 'local',
      },
    ],
    plugins: [
      {
        id: 'builtin:standby-status',
        name: 'standby-status',
        version: '1.0.0',
        locked: false,
        enabled: true,
        status: 'active',
        hooks: [],
        actions: [],
        tools: [],
        clientHashes: { 'index.tsx': 'seeded' },
      },
    ],
    uiContributions: [
      {
        pluginId: 'builtin:standby-status',
        surface: 'plugin.slot',
        spec: {
          id: 'standby-status',
          target: COMPOSER_STATUS_SLOT,
          client: { module: 'index.tsx', export: 'StandbyStatusProbe' },
        },
      },
    ],
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(e(HostStoreProviders, { value: store }, e(AgentStandbyPane, { profileId: 'assistant' })))
    })
    const probe = host.querySelector<HTMLElement>('.composer-status-row .standby-status-probe')
    assert.ok(probe !== null, '待命页应在 .composer-status-row 挂载 COMPOSER_STATUS_SLOT 贡献')
    assert.equal(received?.effectiveModel, 'magpie/auto/gemini-4-carbon')
    assert.equal(received?.profileId, 'assistant')
    assert.equal(received?.conversation, undefined)
  } finally {
    localStorage.removeItem('helmx:locale')
    act(() => root.unmount())
    host.remove()
  }
})

test('COMPOSER_TOOLBAR_SLOT mounts inside .composer-toolbar-left on both Composer and AgentStandbyPane with non-dirty setDraftMeta', { timeout: 60_000 }, async () => {
  let receivedPersisted: ComposerToolbarSlotProps | undefined
  let receivedStandby: ComposerToolbarSlotProps | undefined
  function PersistedToolbarProbe(props: ComposerToolbarSlotProps) {
    receivedPersisted = props
    return e('button', { type: 'button', className: 'persisted-toolbar-probe' }, 'Tool')
  }
  function StandbyToolbarProbe(props: ComposerToolbarSlotProps) {
    receivedStandby = props
    return e(
      'button',
      {
        type: 'button',
        className: 'standby-toolbar-probe',
        onClick: () => props.setDraftMeta?.('builtin:plan', { mode: 'planning' }),
      },
      props.draftMeta ? 'Armed' : 'Arm',
    )
  }
  seedPluginClientModule('builtin:toolbar-probe-persisted', 'index.tsx', { PersistedToolbarProbe })
  seedPluginClientModule('builtin:toolbar-probe-standby', 'index.tsx', { StandbyToolbarProbe })

  // 1. Persisted conversation mounts COMPOSER_TOOLBAR_SLOT inside .composer-toolbar-left (not inside .composer-status-row)
  const conversation = conv(undefined)
  const persistedStore = makeTestStore({
    conversations: [conversation],
    uiContributions: [
      {
        pluginId: 'builtin:toolbar-probe-persisted',
        surface: 'plugin.slot',
        spec: {
          id: 'persisted-toolbar-probe',
          target: COMPOSER_TOOLBAR_SLOT,
          client: { module: 'index.tsx', export: 'PersistedToolbarProbe' },
        },
      },
    ],
  })
  const html = renderToStaticMarkup(
    e(HostStoreProviders, { value: persistedStore }, e(Composer, { conversation, prefill: null })),
  )
  const leftAt = html.indexOf('composer-toolbar-left')
  const modelAt = html.indexOf('composer-model-button')
  const probeAt = html.indexOf('persisted-toolbar-probe')
  const rightAt = html.indexOf('composer-toolbar-right')
  assert.ok(leftAt >= 0 && modelAt > leftAt && probeAt > modelAt && rightAt > probeAt, 'COMPOSER_TOOLBAR_SLOT mounts in .composer-toolbar-left right after .composer-model-button')
  assert.equal(receivedPersisted?.conversation?.id, 1)
  assert.equal(receivedPersisted?.conversation?.profileId, 'assistant')
  assert.ok(receivedPersisted?.composer !== undefined)
  assert.equal(receivedPersisted?.setDraftMeta, undefined)

  // 2. Standby pane passes draftMeta + setDraftMeta without marking drafts dirty
  resetStandbyDrafts()
  const standbyStore = makeTestStore({
    profiles: [
      {
        id: 'assistant',
        name: 'Assistant',
        model: 'magpie/auto/gemini-4-carbon',
        thinkingLevel: 'high',
        cwd: '/tmp',
        nodeId: 'local',
      },
    ],
    plugins: [
      {
        id: 'builtin:toolbar-probe-standby',
        name: 'toolbar-probe-standby',
        version: '1.0.0',
        locked: false,
        enabled: true,
        status: 'active',
        hooks: [],
        actions: [],
        tools: [],
        clientHashes: { 'index.tsx': 'seeded' },
      },
    ],
    uiContributions: [
      {
        pluginId: 'builtin:toolbar-probe-standby',
        surface: 'plugin.slot',
        spec: {
          id: 'standby-toolbar-probe',
          target: COMPOSER_TOOLBAR_SLOT,
          client: { module: 'index.tsx', export: 'StandbyToolbarProbe' },
        },
      },
    ],
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(e(HostStoreProviders, { value: standbyStore }, e(AgentStandbyPane, { profileId: 'assistant' })))
    })
    const btn = host.querySelector<HTMLButtonElement>('.composer-toolbar-left .standby-toolbar-probe')
    assert.ok(btn !== null, '待命页应在 .composer-toolbar-left 挂载 COMPOSER_TOOLBAR_SLOT 贡献')
    assert.ok(host.querySelector('.composer-status-row .standby-toolbar-probe') === null)
    assert.equal(receivedStandby?.conversation, undefined)
    assert.equal(receivedStandby?.profileId, 'assistant')
    assert.equal(typeof receivedStandby?.setDraftMeta, 'function')

    await act(async () => {
      btn.click()
    })
    assert.deepEqual(getStandbyDraft(standbyDraftKey({ panel: 'primary', profileId: 'assistant' })).inputMeta, {
      'builtin:plan': { mode: 'planning' },
    })
    assert.equal(standbyDraftsDirty(), false, 'setDraftMeta must not mark empty standby draft dirty')
    assert.equal(btn.textContent, 'Armed')
  } finally {
    resetStandbyDrafts()
    localStorage.removeItem('helmx:locale')
    act(() => root.unmount())
    host.remove()
  }
})

test('conversationDurationLabel：仅 blocked 渲染「等待审批」秒表且不附累计，working / 空闲 / 完成一律 null；活跃态仍需共享时钟', { timeout: 60_000 }, async () => {
  const { conversationDurationLabel, conversationDurationNeedsLiveClock } = await import(
    '../src/conversation/conversation-duration-model.js'
  )
  const { createWebTranslator } = await import('../src/i18n/catalog.js')
  const tZh = createWebTranslator('zh-CN')
  const tEn = createWebTranslator('en')

  const createdAt = new Date(2026, 10, 10, 14, 0, 0).getTime()
  const now = createdAt + 120_000

  // 1. 空闲无累计 -> null 且零时钟需求
  assert.equal(conversationDurationNeedsLiveClock({ status: 'idle', runDurationMs: 0 }), false)
  assert.equal(conversationDurationLabel({ status: 'idle', runDurationMs: 0 }, now, tZh), null)

  // 2. 空闲/完成/错误：已有累计运行时长也不在状态行重复（累计归标题浮层与大纲头部）
  assert.equal(
    conversationDurationLabel(
      { status: 'done', runDurationMs: 125_000, completionSeq: 3, createdAt, updatedAt: createdAt + 300_000 },
      now,
      tEn,
    ),
    null,
  )

  // 3. working：本轮秒表归时间线独占，第 2 轮起也不再显示累计 -> null；
  //    共享时钟需求仍为 true：标题浮层等活跃消费者继续订阅
  assert.equal(
    conversationDurationNeedsLiveClock({ status: 'working', runDurationMs: 0, runStartedAt: now - 12_300 }),
    true,
  )
  assert.equal(
    conversationDurationLabel(
      {
        status: 'working',
        runDurationMs: 60_000,
        runStartedAt: now - 12_300,
        completionSeq: 1,
        createdAt,
        updatedAt: now,
      },
      now,
      tZh,
    ),
    null,
  )

  // 4. blocked 等待审批：仅「等待审批 <秒表>」，有累计历史也不附带「· 累计」
  const blockedBase = { status: 'blocked', pendingAskCount: 1, pendingAskSince: now - 15_400 } as const
  assert.equal(conversationDurationLabel({ ...blockedBase, runDurationMs: 0 }, now, tZh), '等待审批 15s')
  assert.equal(
    conversationDurationLabel(
      { ...blockedBase, runDurationMs: 65_000, runStartedAt: now - 15_400, completionSeq: 2, createdAt, updatedAt: now },
      now,
      tZh,
    ),
    '等待审批 15s',
  )
  assert.equal(conversationDurationLabel({ ...blockedBase }, now, tEn), 'Waiting 15s')
  assert.equal(conversationDurationNeedsLiveClock({ ...blockedBase }), true)

  // 5. blocked 但无 pendingAskSince 锚点：不伪造秒表
  assert.equal(conversationDurationLabel({ status: 'blocked', pendingAskCount: 1 }, now, tZh), null)
})

test('Composer ConversationDurationStatus：blocked 渲染「等待审批」warn 只读文本并撑开状态行，无等待审批时不渲染', { timeout: 60_000 }, async () => {
  const { resetServerClock } = await import('../src/lib/server-clock.js')
  resetServerClock()
  const css = readFileSync(new URL('../src/styles/composer.css', import.meta.url), 'utf8')
  const style = document.createElement('style')
  style.textContent = `:root { --fg-muted: rgb(11, 12, 13); --warn: rgb(21, 22, 23); --err: rgb(31, 32, 33); }\n${css}`
  document.head.appendChild(style)

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    // 1. 无等待审批（done 且无 contextUsage）：状态行不渲染时长读数
    const doneSettled: ConversationSummary = {
      ...conv(undefined),
      status: 'done',
      runDurationMs: 65_000,
      completionSeq: 2,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_200_000,
    }
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: makeTestStore({ locale: 'zh-CN', conversations: [doneSettled] }) },
          e(Composer, { conversation: doneSettled, prefill: null }),
        ),
      )
    })
    assert.ok(host.querySelector('.composer-duration-status') === null, 'no duration readout without pending ask')

    // 2. blocked（无 contextUsage）：时长读数撑开 .composer-status-row，warn 色调，只读无按钮
    const now = Date.now()
    const blockedConv: ConversationSummary = {
      ...conv(undefined),
      status: 'blocked',
      pendingAskCount: 1,
      pendingAskSince: now - 10_400,
      runDurationMs: 30_000,
    }
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: makeTestStore({ locale: 'zh-CN', conversations: [blockedConv] }) },
          e(Composer, { conversation: blockedConv, prefill: null }),
        ),
      )
    })
    const row = host.querySelector<HTMLElement>('.composer-status-row')
    const durationEl = host.querySelector<HTMLElement>('.composer-duration-status')
    assert.ok(row !== null && durationEl !== null)
    assert.equal(getComputedStyle(row).display, 'flex', 'duration status keeps .composer-status-row visible')
    assert.equal(durationEl.textContent, '等待审批 10s')
    assert.ok(durationEl.querySelector('button') === null, 'duration status must stay read-only')
    assert.equal(getComputedStyle(durationEl).color, 'rgb(21, 22, 23)', 'warn tone must override default gray')
  } finally {
    resetServerClock()
    localStorage.removeItem('helmx:locale')
    act(() => root.unmount())
    host.remove()
    style.remove()
  }
})

test('Unified composer + menu opens Upload / COMPOSER_MENU_SLOT (with plugin dedupe) / non-slot plugin commands', { timeout: 60_000 }, async () => {
  const originalFetch = globalThis.fetch
  const fetchCalls: Array<{ url: string; method: string; body?: string }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    fetchCalls.push({ url, method, ...(body !== undefined ? { body } : {}) })
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  function MenuSlotProbe(props: ComposerMenuSlotProps) {
    return e(
      DropdownMenuItem,
      {
        className: 'menu-slot-probe-item',
        onSelect: () => {
          props.setDraftMeta?.('builtin:menu-probe', { armed: true })
          props.onCloseMenu?.()
        },
      },
      props.conversation !== undefined ? 'Slot Conv Action' : 'Slot Standby Action',
    )
  }
  seedPluginClientModule('builtin:menu-probe', 'index.tsx', { MenuSlotProbe })

  const openPlusMenu = async (container: HTMLElement): Promise<void> => {
    const trigger = container.querySelector<HTMLButtonElement>('button.composer-plus-trigger')
    assert.ok(trigger !== null, 'expected unified + menu trigger')
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }

  const conversation = conv(undefined)
  const menuProbePlugin = {
    id: 'builtin:menu-probe',
    name: 'menu-probe',
    version: '1.0.0',
    locked: false,
    enabled: true,
    status: 'active' as const,
    hooks: [],
    actions: [],
    tools: [],
    clientHashes: { 'index.tsx': 'seeded' },
  }
  const store = makeTestStore({
    locale: 'en',
    conversations: [conversation],
    plugins: [menuProbePlugin],
    uiContributions: [
      {
        pluginId: 'builtin:menu-probe',
        surface: 'plugin.slot',
        spec: {
          id: 'menu-probe-slot',
          target: COMPOSER_MENU_SLOT,
          client: { module: 'index.tsx', export: 'MenuSlotProbe' },
        },
      },
      {
        // Plugin already contributing to COMPOSER_MENU_SLOT must be deduped from menuCommands.
        pluginId: 'builtin:menu-probe',
        surface: 'commandPalette',
        spec: {
          id: 'dup-cmd',
          title: 'Duplicate Menu Cmd',
          slash: 'dup',
          actionId: 'dup',
        },
      },
      {
        pluginId: 'builtin:other-plugin',
        surface: 'commandPalette',
        spec: {
          id: 'other-cmd',
          title: 'Refresh Summary',
          slash: 'summary',
          actionId: 'refresh',
          icon: 'sparkles',
        },
      },
    ],
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    // 1. Persisted conversation menu
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: store },
          e(Composer, { conversation, prefill: null }),
        ),
      )
    })

    // Seed draft text ending with @agent to verify non-slot plugin command preserves draft text.
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'hello @helper')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await openPlusMenu(host)
    const menuText = () =>
      [...document.querySelectorAll('.composer-plus-menu [role="menuitem"]')].map((el) => el.textContent ?? '')
    const itemsText = menuText()
    assert.ok(itemsText.some((t) => t.includes('Upload attachment')), 'Upload item present')
    assert.ok(itemsText.some((t) => t.includes('Slot Conv Action')), 'COMPOSER_MENU_SLOT item present')
    assert.equal(
      itemsText.some((t) => t.includes('Duplicate Menu Cmd')),
      false,
      'plugin contributing COMPOSER_MENU_SLOT must be deduped from menuCommands without hardcoding pluginId',
    )
    assert.ok(itemsText.some((t) => t.includes('Refresh Summary') && t.includes('/summary')), 'non-slot plugin command present')

    // Execute non-slot plugin command -> invokes action AND preserves draft text including @helper
    const refreshItem = [...document.querySelectorAll<HTMLElement>('.composer-plus-menu [role="menuitem"]')].find((el) =>
      (el.textContent ?? '').includes('Refresh Summary'),
    )!
    await act(async () => {
      refreshItem.click()
    })
    assert.equal(textarea.value, 'hello @helper', 'menu plugin command must never strip trailing @mention text')
    assert.ok(
      fetchCalls.some((c) => c.url === '/api/actions/builtin%3Aother-plugin/refresh' && c.method === 'POST'),
      'non-slot plugin command dispatches action POST',
    )

    // Reopen and trigger Upload attachment -> clicks hidden file input
    await openPlusMenu(host)
    const fileInput = host.querySelector<HTMLInputElement>('input[type="file"]')!
    let fileInputClicks = 0
    fileInput.click = () => {
      fileInputClicks += 1
    }
    const uploadItem = [...document.querySelectorAll<HTMLElement>('.composer-plus-menu [role="menuitem"]')].find((el) =>
      (el.textContent ?? '').includes('Upload attachment'),
    )!
    await act(async () => {
      uploadItem.click()
    })
    assert.equal(fileInputClicks, 1)

    // 2. Standby pane menu: shows Upload + COMPOSER_MENU_SLOT
    resetStandbyDrafts()
    const standbyStore = makeTestStore({
      locale: 'en',
      profiles: [{ id: 'assistant', name: 'Assistant', model: 'faux/faux-1', thinkingLevel: '', cwd: '/tmp', nodeId: 'local' }],
      plugins: [menuProbePlugin],
      uiContributions: [
        {
          pluginId: 'builtin:menu-probe',
          surface: 'plugin.slot',
          spec: {
            id: 'menu-probe-standby',
            target: COMPOSER_MENU_SLOT,
            client: { module: 'index.tsx', export: 'MenuSlotProbe' },
          },
        },
      ],
    })
    await act(async () => {
      root.render(e(HostStoreProviders, { value: standbyStore }, e(AgentStandbyPane, { profileId: 'assistant' })))
    })
    await openPlusMenu(host)
    const standbyItems = menuText()
    assert.ok(standbyItems.some((t) => t.includes('Choose attachments')))
    assert.ok(standbyItems.some((t) => t.includes('Slot Standby Action')))

    const standbySlotItem = document.querySelector<HTMLElement>('.menu-slot-probe-item')!
    await act(async () => {
      standbySlotItem.click()
    })
    assert.deepEqual(
      getStandbyDraft(standbyDraftKey({ panel: 'primary', profileId: 'assistant' })).inputMeta,
      { 'builtin:menu-probe': { armed: true } },
    )
    assert.equal(standbyDraftsDirty(), false, 'standby menu slot setDraftMeta must not mark empty draft dirty')
  } finally {
    resetStandbyDrafts()
    resetPluginClientCache()
    globalThis.fetch = originalFetch
    localStorage.removeItem('helmx:locale')
    act(() => root.unmount())
    host.remove()
  }
})

test('Composer /plan executes registered useComposerCommand handler without banner or RPC and respects topLevelOnly/ownedBy scopes', { timeout: 60_000 }, async () => {
  const originalFetch = globalThis.fetch
  const fetchCalls: Array<{ url: string; method: string }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), method: init?.method ?? 'GET' })
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  let toggleCount = 0
  function ConvPlanToolbarProbe(props: ComposerToolbarSlotProps) {
    const eligible =
      props.conversation !== undefined &&
      props.conversation.parentConversationId === undefined &&
      (props.conversation.ownedBy ?? 'human') === 'human'
    useComposerCommand('toggle-plan', eligible ? () => { toggleCount += 1 } : undefined)
    return null
  }
  seedPluginClientModule('builtin:plan', 'index.tsx', { PlanToolbarProbe: ConvPlanToolbarProbe })

  const typeInto = (ta: HTMLTextAreaElement, text: string): void => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    const tracker = (ta as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
    const prev = tracker?.getValue() ?? ''
    setter.call(ta, text)
    tracker?.setValue(prev)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  }

  const planPlugin = {
    id: 'builtin:plan',
    name: 'Plan Mode',
    version: '1.0.0',
    locked: false,
    enabled: true,
    status: 'active' as const,
    hooks: [],
    actions: ['toggle'],
    tools: [],
    clientHashes: { 'index.tsx': 'seeded' },
  }
  const planUi = [
    {
      pluginId: 'builtin:plan',
      surface: 'plugin.slot' as const,
      spec: {
        id: 'plan-toolbar',
        target: COMPOSER_TOOLBAR_SLOT,
        order: 20,
        client: { module: 'index.tsx', export: 'PlanToolbarProbe' },
      },
    },
    {
      pluginId: 'builtin:plan',
      surface: 'commandPalette' as const,
      spec: {
        id: 'toggle-plan',
        title: 'Toggle Plan mode',
        slash: 'plan',
        actionId: 'toggle',
        input: {},
        scope: { topLevelOnly: true, ownedBy: 'human' as const },
      },
    },
  ]

  const rootConv = conv(undefined)
  const subagentConv: ConversationSummary = { ...conv(undefined), id: 2, parentConversationId: 1 }
  const helmxConv: ConversationSummary = { ...conv(undefined), id: 3, ownedBy: 'helmx' }

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    // 1. Eligible top-level human conversation: /plan appears and invokes local handler with 0 HTTP RPCs
    const rootStore = makeTestStore({
      locale: 'en',
      conversations: [rootConv],
      plugins: [planPlugin],
      uiContributions: planUi,
    })
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: rootStore },
          e(Composer, { key: rootConv.id, conversation: rootConv, prefill: null }),
        ),
      )
    })
    const input = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    await act(async () => { typeInto(input, 'prefix /pl') })
    const popover = document.querySelector<HTMLElement>('.composer-popover')
    assert.ok(popover !== null && (popover.textContent ?? '').includes('/plan'), 'root human conversation shows /plan')

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.equal(toggleCount, 1)
    assert.equal(input.value, 'prefix ')
    assert.equal(fetchCalls.some((c) => c.url.includes('/api/actions/builtin%3Aplan')), false)
    assert.ok(host.querySelector('.composer-command-banner') === null)

    // Submitting bare /plan directly also invokes local handler with 0 RPC calls
    await act(async () => { typeInto(input, '/plan') })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.equal(toggleCount, 2)
    assert.equal(input.value, '')
    assert.equal(fetchCalls.some((c) => c.url.includes('/api/actions/builtin%3Aplan')), false)

    // 2. Subagent conversation excludes /plan
    const subStore = makeTestStore({
      locale: 'en',
      conversations: [subagentConv],
      plugins: [planPlugin],
      uiContributions: planUi,
    })
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: subStore },
          e(Composer, { key: subagentConv.id, conversation: subagentConv, prefill: null }),
        ),
      )
    })
    const subInput = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    await act(async () => { typeInto(subInput, '/') })
    const subPopover = document.querySelector<HTMLElement>('.composer-popover')
    assert.ok(subPopover !== null)
    assert.equal((subPopover.textContent ?? '').includes('/plan'), false, 'subagent excludes /plan')

    // 3. helmx-owned conversation excludes /plan
    const helmxStore = makeTestStore({
      locale: 'en',
      conversations: [helmxConv],
      plugins: [planPlugin],
      uiContributions: planUi,
    })
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: helmxStore },
          e(Composer, { key: helmxConv.id, conversation: helmxConv, prefill: null }),
        ),
      )
    })
    const helmxInput = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    await act(async () => { typeInto(helmxInput, '/') })
    const helmxPopover = document.querySelector<HTMLElement>('.composer-popover')
    assert.ok(helmxPopover !== null)
    assert.equal((helmxPopover.textContent ?? '').includes('/plan'), false, 'helmx-owned excludes /plan')
  } finally {
    resetPluginClientCache()
    globalThis.fetch = originalFetch
    localStorage.removeItem('helmx:locale')
    act(() => root.unmount())
    host.remove()
  }
})

test('ComposerInputShell + menu: Escape returns focus to .composer-plus-trigger; action selection (onCloseMenu / menuCommands) does not steal focus from opened overlay', { timeout: 60_000 }, async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

  let focusTargetAfterMenuClose: (() => void) | undefined
  function MenuSlotFocusProbe(props: ComposerMenuSlotProps) {
    return e(
      DropdownMenuItem,
      {
        className: 'menu-slot-focus-probe-item',
        onSelect: () => {
          props.onCloseMenu?.()
          queueMicrotask(() => {
            setTimeout(() => {
              focusTargetAfterMenuClose?.()
            }, 0)
          })
        },
      },
      'Open Deferred Overlay',
    )
  }
  seedPluginClientModule('builtin:menu-focus-probe', 'index.tsx', { MenuSlotFocusProbe })

  const conversation = conv(undefined)
  const store = makeTestStore({
    locale: 'en',
    conversations: [conversation],
    plugins: [
      {
        id: 'builtin:menu-focus-probe',
        name: 'menu-focus-probe',
        version: '1.0.0',
        locked: false,
        enabled: true,
        status: 'active',
        hooks: [],
        actions: [],
        tools: [],
        clientHashes: { 'index.tsx': 'seeded' },
      },
    ],
    uiContributions: [
      {
        pluginId: 'builtin:menu-focus-probe',
        surface: 'plugin.slot',
        spec: {
          id: 'menu-focus-probe-slot',
          target: COMPOSER_MENU_SLOT,
          client: { module: 'index.tsx', export: 'MenuSlotFocusProbe' },
        },
      },
      {
        pluginId: 'builtin:cmd-focus-probe',
        surface: 'commandPalette',
        spec: {
          id: 'cmd-focus-probe',
          title: 'Focus Textarea Cmd',
          slash: 'focus-cmd',
          actionId: 'run',
        },
      },
    ],
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  let deferredOverlay: HTMLDivElement | undefined

  try {
    await act(async () => {
      root.render(e(HostStoreProviders, { value: store }, e(Composer, { conversation, prefill: null })))
    })
    const trigger = host.querySelector<HTMLButtonElement>('button.composer-plus-trigger')
    assert.ok(trigger !== null, 'expected .composer-plus-trigger')
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')
    assert.ok(textarea !== null)

    const openMenu = async (): Promise<HTMLElement> => {
      await act(async () => {
        trigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
      const menu = document.body.querySelector<HTMLElement>('.composer-plus-menu')
      assert.ok(menu !== null, 'expected open .composer-plus-menu')
      return menu
    }

    // 1. Escape closes + menu and returns focus to .composer-plus-trigger
    const menuForEsc = await openMenu()
    await act(async () => {
      menuForEsc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    assert.ok(document.body.querySelector('.composer-plus-menu') === null, 'Escape must close .composer-plus-menu')
    assert.ok(document.activeElement === trigger, 'Escape must return focus to .composer-plus-trigger')

    // 2. Clicking COMPOSER_MENU_SLOT item (which calls onCloseMenu + opens an overlay via microtask->setTimeout(0))
    //    must NOT let DropdownMenu onCloseAutoFocus steal focus back to .composer-plus-trigger
    focusTargetAfterMenuClose = () => {
      deferredOverlay = document.createElement('div')
      deferredOverlay.className = 'probe-opened-overlay'
      deferredOverlay.tabIndex = -1
      document.body.appendChild(deferredOverlay)
      deferredOverlay.focus()
    }
    await openMenu()
    const slotItem = document.body.querySelector<HTMLElement>('.menu-slot-focus-probe-item')
    assert.ok(slotItem !== null)
    await act(async () => {
      slotItem.click()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    assert.ok(document.body.querySelector('.composer-plus-menu') === null, 'menu item closed .composer-plus-menu')
    assert.ok(deferredOverlay !== undefined && document.activeElement === deferredOverlay, 'new overlay must keep focus after menu closes')
    assert.ok(document.activeElement !== trigger, '.composer-plus-trigger must not steal focus back')

    // 3. Clicking a menuCommands item when focus moves to another control must also not steal focus back
    ;(store.actions as unknown as { invokePluginAction: () => Promise<unknown> }).invokePluginAction = async () => {
      textarea.focus()
      return { ok: true }
    }
    await openMenu()
    const cmdItem = [...document.body.querySelectorAll<HTMLElement>('.composer-plus-menu [role="menuitem"]')].find(
      (el) => (el.textContent ?? '').includes('Focus Textarea Cmd'),
    )
    assert.ok(cmdItem !== undefined)
    await act(async () => {
      cmdItem.click()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    assert.ok(document.activeElement === textarea, 'menuCommands action target focus must not be stolen by .composer-plus-trigger')
  } finally {
    deferredOverlay?.remove()
    resetPluginClientCache()
    globalThis.fetch = originalFetch
    localStorage.removeItem('helmx:locale')
    act(() => root.unmount())
    host.remove()
  }
})

test('composer/status single-line layout CSS: nowrap, overflow-x auto, non-shrinking telemetry, display:contents slot & empty collapse', { timeout: 60_000 }, async () => {
  const css = readFileSync(new URL('../src/styles/composer.css', import.meta.url), 'utf8')
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)

  const populated = conv({ tokens: 75_000, contextWindow: 200_000 })
  const empty = conv(undefined)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    function DemoStatusProbe() {
      return e('span', { className: 'demo-status-probe' }, '120 t/s')
    }
    seedPluginClientModule('builtin:demo-scroll', 'index.tsx', { DemoStatusProbe })
    const store = makeTestStore({
      conversations: [populated, empty],
      plugins: [
        {
          id: 'builtin:demo-scroll',
          name: 'demo-scroll',
          version: '1.0.0',
          locked: false,
          enabled: true,
          status: 'active',
          hooks: [],
          actions: [],
          tools: [],
          clientHashes: { 'index.tsx': 'seeded' },
        },
      ],
      uiContributions: [
        {
          pluginId: 'builtin:demo-scroll',
          surface: 'plugin.slot',
          spec: {
            id: 'demo-scroll',
            target: COMPOSER_STATUS_SLOT,
            client: { module: 'index.tsx', export: 'DemoStatusProbe' },
          },
        },
      ],
    })

    await act(async () => {
      root.render(e(HostStoreProviders, { value: store }, e(Composer, { conversation: populated, prefill: null })))
    })
    const row = host.querySelector<HTMLElement>('.composer-status-row')
    const contextEl = host.querySelector<HTMLElement>('.composer-context-status')
    const slotEl = host.querySelector<HTMLElement>('.composer-status-slot')
    assert.ok(row !== null && contextEl !== null && slotEl !== null)
    const rowStyle = getComputedStyle(row)
    assert.equal(rowStyle.flexWrap, 'nowrap')
    assert.equal(rowStyle.overflowX, 'auto')
    assert.equal(getComputedStyle(contextEl).flexShrink, '0')
    assert.equal(getComputedStyle(slotEl).display, 'contents')

    const emptyStore = makeTestStore({ conversations: [empty] })
    await act(async () => {
      root.render(e(HostStoreProviders, { value: emptyStore }, e(Composer, { conversation: empty, prefill: null })))
    })
    const emptyRow = host.querySelector<HTMLElement>('.composer-status-row')
    assert.ok(emptyRow !== null)
    assert.equal(getComputedStyle(emptyRow).display, 'none')
  } finally {
    resetPluginClientCache()
    act(() => root.unmount())
    host.remove()
    style.remove()
  }
})

test('composer/status horizontal overflow fade masks & vertical-wheel horizontal scrolling', { timeout: 60_000 }, async () => {
  const { host, unmount } = await mountComposer(conv({ tokens: 75_000, contextWindow: 200_000 }))
  try {
    const row = host.querySelector<HTMLElement>('.composer-status-row')
    assert.ok(row !== null)

    let mockClientWidth = 200
    let mockScrollWidth = 420
    let mockScrollLeft = 0
    Object.defineProperty(row, 'clientWidth', {
      configurable: true,
      get: () => mockClientWidth,
    })
    Object.defineProperty(row, 'scrollWidth', {
      configurable: true,
      get: () => mockScrollWidth,
    })
    Object.defineProperty(row, 'scrollLeft', {
      configurable: true,
      get: () => mockScrollLeft,
      set: (val: number) => {
        const max = Math.max(0, mockScrollWidth - mockClientWidth)
        mockScrollLeft = Math.max(0, Math.min(max, Number(val) || 0))
      },
    })

    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    assert.equal(row.getAttribute('data-overflow-left'), null)
    assert.equal(row.getAttribute('data-overflow-right'), 'true')

    const verticalEv = new window.WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true })
    await act(async () => {
      row.dispatchEvent(verticalEv)
    })
    assert.equal(mockScrollLeft, 60)
    assert.equal(verticalEv.defaultPrevented, true)

    await act(async () => {
      row.dispatchEvent(new Event('scroll'))
    })
    assert.equal(row.getAttribute('data-overflow-left'), 'true')
    assert.equal(row.getAttribute('data-overflow-right'), 'true')

    row.scrollLeft = 220
    await act(async () => {
      row.dispatchEvent(new Event('scroll'))
    })
    assert.equal(row.getAttribute('data-overflow-left'), 'true')
    assert.equal(row.getAttribute('data-overflow-right'), null)

    const horizontalEv = new window.WheelEvent('wheel', { deltaX: 40, deltaY: 10, bubbles: true, cancelable: true })
    await act(async () => {
      row.dispatchEvent(horizontalEv)
    })
    assert.equal(horizontalEv.defaultPrevented, false)
    assert.equal(mockScrollLeft, 220)

    mockScrollWidth = 200
    mockScrollLeft = 0
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    assert.equal(row.getAttribute('data-overflow-left'), null)
    assert.equal(row.getAttribute('data-overflow-right'), null)

    const noOverflowEv = new window.WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true })
    await act(async () => {
      row.dispatchEvent(noOverflowEv)
    })
    assert.equal(noOverflowEv.defaultPrevented, false)
    assert.equal(mockScrollLeft, 0)
  } finally {
    unmount()
  }
})
