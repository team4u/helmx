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
  ComposerScopeProps,
  ComposerStatusSlotProps,
  ComposerToolbarSlotProps,
  ConversationSummary,
} from '@helmx/protocol'
import { COMPOSER_STATUS_SLOT, COMPOSER_TOOLBAR_SLOT } from '@helmx/protocol'
import {
  getStandbyDraft,
  resetStandbyDrafts,
  standbyDraftKey,
  standbyDraftsDirty,
} from '../src/conversation/standby-model.js'
import { applySnapshot, emptyLiveState, mergeConversationDetail } from '../src/lib/live-state.js'
import { makeTestStore } from './helpers/store.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'
import { seedPluginClientModule } from '../src/lib/plugin-client.js'
import { groupUiContributions } from '../src/lib/types.js'
import type { HelmxStoreValue } from '../src/lib/types.js'

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { renderToStaticMarkup } = await import('react-dom/server')
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
    assert.ok(host.querySelector('button[aria-label="上传附件"]') !== null)
    assert.equal(statusSpan(host)?.textContent, '精简中…')

    await act(async () => {
      storeZh.setLocale('en')
      root.render(e(HostStoreProviders, { value: storeZh }, e(Composer, { conversation, prefill: null })))
    })
    assert.ok(host.querySelector('textarea[aria-label="Type a message"]') !== null)
    assert.ok(host.querySelector('button[aria-label="Uploaded attachment"]') !== null)
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
