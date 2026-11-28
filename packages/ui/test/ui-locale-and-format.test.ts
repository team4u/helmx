/**
 * @helmx/ui decoupled context & pure formatter tests:
 * - UiScope / useUiScopeId: stamps data-plugin-id when scoped, passes through unwrapped when absent;
 * - UiLocaleProvider / useUiLocale / useUiTranslator: reactive subscribe/getLocale, static locale,
 *   bare default fallback ('en'), and zero re-renders for unrelated store changes;
 * - Shared primitives (CopyButton, DataTable, MultiSelect, ViewBoundary) react to UiLocaleProvider;
 * - Timing/byte formatters & resolveConversationTiming contract.
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { UI_SHARED_EXPORTS, type HelmxLocale } from '@helmx/protocol'
import * as HelmxUi from '../src/index.js'

const e = React.createElement

function mount(node: React.ReactNode): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(node)
  })
  return { host, root }
}

test('UiScope & useUiScopeId: stamps display:contents anchor when scoped, inherits ancestor scope, and passes through unwrapped when absent', { timeout: 60_000 }, () => {
  let observedOutside: string | undefined = 'sentinel'
  let observedInside: string | undefined
  let observedOverride: string | undefined

  function Probe({ explicit, onRead }: { explicit?: string; onRead: (v: string | undefined) => void }) {
    onRead(HelmxUi.useUiScopeId(explicit))
    return e('span', { className: 'probe' }, 'ok')
  }

  const outsideHtml = renderToString(
    e(HelmxUi.UiScope, null, e(Probe, { onRead: (v) => { observedOutside = v } })),
  )
  assert.doesNotMatch(outsideHtml, /data-plugin-id/)
  assert.equal(observedOutside, undefined)

  const insideHtml = renderToString(
    e(
      HelmxUi.UiScope,
      { scopeId: 'builtin:alpha' },
      e(Probe, { onRead: (v) => { observedInside = v } }),
      e(Probe, { explicit: 'ext:override', onRead: (v) => { observedOverride = v } }),
    ),
  )
  assert.match(insideHtml, /data-plugin-id="builtin:alpha"/)
  assert.match(insideHtml, /display:contents/)
  assert.equal(observedInside, 'builtin:alpha')
  assert.equal(observedOverride, 'ext:override')
})

test('UiLocaleProvider: supports static locale, reactive subscribe/getLocale, and bare DEFAULT_HELMX_LOCALE fallback', { timeout: 60_000 }, () => {
  const seen: Array<{ locale: string; translated: string }> = []
  function LocaleProbe(): React.ReactNode {
    const locale = HelmxUi.useUiLocale()
    const t = HelmxUi.useUiTranslator()
    seen.push({ locale, translated: t({ en: 'Hello', 'zh-CN': '你好' }) })
    return e('div', null, locale)
  }

  const bareHtml = renderToString(e(LocaleProbe))
  assert.equal(bareHtml, '<div>en</div>')

  const staticHtml = renderToString(e(HelmxUi.UiLocaleProvider, { locale: 'zh-CN' }, e(LocaleProbe)))
  assert.equal(staticHtml, '<div>zh-CN</div>')

  let currentLocale: HelmxLocale = 'en'
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const getLocale = () => currentLocale

  let renderCount = 0
  const CountingProbe = React.memo(function CountingProbe(): React.ReactNode {
    renderCount += 1
    const locale = HelmxUi.useUiLocale()
    return e('span', null, locale)
  })

  const { host, root } = mount(
    e(HelmxUi.UiLocaleProvider, { subscribe, getLocale }, e(CountingProbe)),
  )
  try {
    assert.equal(host.textContent, 'en')
    const baseCount = renderCount

    // Emitting without changing locale does not re-render CountingProbe
    act(() => {
      for (const l of listeners) l()
    })
    assert.equal(renderCount, baseCount)

    // Changing locale triggers a single re-render
    act(() => {
      currentLocale = 'zh-CN'
      for (const l of listeners) l()
    })
    assert.equal(host.textContent, 'zh-CN')
    assert.equal(renderCount, baseCount + 1)
  } finally {
    act(() => root.unmount())
    host.remove()
  }

  assert.deepEqual(seen, [
    { locale: 'en', translated: 'Hello' },
    { locale: 'zh-CN', translated: '你好' },
  ])
})

test('shared UI primitives update labels with UiLocaleProvider without changing selected values', { timeout: 60_000 }, () => {
  let currentLocale: HelmxLocale = 'en'
  const listeners = new Set<() => void>()
  const setLocale = (next: HelmxLocale) => {
    currentLocale = next
    for (const l of listeners) l()
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  const options = Array.from({ length: 5 }, (_, index) => ({ value: `v${index}`, label: `Option ${index}` }))
  const changes: string[][] = []
  const { root, host } = mount(
    e(
      HelmxUi.UiLocaleProvider,
      { subscribe, getLocale: () => currentLocale },
      e(
        'div',
        null,
        e(HelmxUi.CopyButton, { text: 'user text' }),
        e(HelmxUi.DataTable, { loading: true, children: null }),
        e(HelmxUi.DataTable, { empty: true, children: null }),
        e(HelmxUi.MultiSelect, {
          options,
          value: ['v0', 'v1'],
          open: true,
          inline: true,
          onValuesChange: (values: string[]) => changes.push(values),
        }),
      ),
    ),
  )
  try {
    assert.equal(host.querySelector('button')?.getAttribute('title'), 'Copy')
    assert.equal(host.querySelector('[role="status"]')?.textContent, 'Loading…')
    assert.equal(host.querySelector('.table-empty')?.textContent, 'No data')
    assert.equal(host.querySelector('.helmx-select-label')?.textContent, '2 selected')
    assert.equal(host.querySelector('input')?.getAttribute('placeholder'), 'Search options…')

    act(() => setLocale('zh-CN'))
    assert.equal(host.querySelector('button')?.getAttribute('title'), '复制')
    assert.equal(host.querySelector('[role="status"]')?.textContent, '加载中…')
    assert.equal(host.querySelector('.table-empty')?.textContent, '暂无数据')
    assert.equal(host.querySelector('.helmx-select-label')?.textContent, '已选择 2 项')
    assert.equal(host.querySelector('input')?.getAttribute('placeholder'), '搜索选项…')
    assert.equal(host.querySelectorAll('[role="option"][aria-selected="true"]').length, 2)
    assert.deepEqual(changes, [], 'changing locale never submits a selection change')

    act(() => setLocale('en'))
    assert.equal(host.querySelector('.helmx-select-label')?.textContent, '2 selected')
    assert.equal(host.querySelector('button')?.getAttribute('title'), 'Copy')
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

test('ViewBoundary translates its retry UI while preserving the original diagnostic across UiLocaleProvider changes', { timeout: 60_000 }, () => {
  let currentLocale: HelmxLocale = 'en'
  const listeners = new Set<() => void>()
  const setLocale = (next: HelmxLocale) => {
    currentLocale = next
    for (const l of listeners) l()
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  let failing = true
  function Content(): React.ReactNode {
    if (failing) throw new Error('stable render diagnostic')
    return e('span', null, 'restored user content')
  }
  const previousConsoleError = console.error
  let mounted: ReturnType<typeof mount> | undefined
  try {
    console.error = () => {}
    mounted = mount(
      e(
        HelmxUi.UiLocaleProvider,
        { subscribe, getLocale: () => currentLocale },
        e(HelmxUi.ViewBoundary, null, e(Content)),
      ),
    )
    const { host } = mounted
    assert.equal(host.querySelector('strong')?.textContent, 'View failed to render')
    assert.equal(host.querySelector('p')?.textContent, 'stable render diagnostic')
    act(() => setLocale('zh-CN'))
    assert.equal(host.querySelector('strong')?.textContent, '视图渲染失败')
    assert.equal(host.querySelector('p')?.textContent, 'stable render diagnostic')
    const retry = host.querySelector<HTMLButtonElement>('button')
    assert.ok(retry)
    assert.equal(retry.textContent, '重新渲染')
    failing = false
    act(() => retry.click())
    assert.ok(host.querySelector('[role="alert"]') === null)
    assert.equal(host.textContent, 'restored user content')
  } finally {
    if (mounted) {
      act(() => mounted!.root.unmount())
      mounted.host.remove()
    }
    console.error = previousConsoleError
  }
})

test('timing & byte formatters and resolveConversationTiming contract', { timeout: 60_000 }, () => {
  for (const name of ['formatTime', 'formatCompactTimestamp', 'formatDurationMs', 'formatStopwatchMs', 'formatOffsetMs', 'resolveConversationTiming', 'formatBytes'] as const) {
    assert.ok(
      (UI_SHARED_EXPORTS as readonly string[]).includes(name),
      `UI_SHARED_EXPORTS must include ${name}`,
    )
    assert.equal(typeof HelmxUi[name], 'function', `@helmx/ui must export ${name}`)
  }

  assert.equal(HelmxUi.formatDurationMs(undefined), '')
  assert.equal(HelmxUi.formatDurationMs(-1), '')
  assert.equal(HelmxUi.formatDurationMs(500), '500ms')
  assert.equal(HelmxUi.formatDurationMs(1500), '1.5s')
  assert.equal(HelmxUi.formatDurationMs(59_950), '1m0s')
  assert.equal(HelmxUi.formatDurationMs(125_000), '2m5s')
  assert.equal(HelmxUi.formatDurationMs(3_660_000), '1h1m')

  for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.01]) {
    assert.equal(HelmxUi.formatStopwatchMs(bad), '')
  }
  assert.equal(HelmxUi.formatStopwatchMs(0), '0s')
  assert.equal(HelmxUi.formatStopwatchMs(999), '0s')
  assert.equal(HelmxUi.formatStopwatchMs(1_000), '1s')
  assert.equal(HelmxUi.formatStopwatchMs(12_345), '12s')
  assert.equal(HelmxUi.formatStopwatchMs(59_999), '59s')
  assert.equal(HelmxUi.formatStopwatchMs(60_000), '1m00s')
  assert.equal(HelmxUi.formatStopwatchMs(65_999), '1m05s')
  assert.equal(HelmxUi.formatStopwatchMs(750_000), '12m30s')
  assert.equal(HelmxUi.formatStopwatchMs(3_599_999), '59m59s')
  assert.equal(HelmxUi.formatStopwatchMs(3_600_000), '1h00m')
  assert.equal(HelmxUi.formatStopwatchMs(3_900_000), '1h05m')
  assert.equal(HelmxUi.formatStopwatchMs(3_959_999), '1h05m')
  assert.equal(HelmxUi.formatStopwatchMs(36_000_000), '10h00m')

  for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.5]) {
    assert.equal(HelmxUi.formatOffsetMs(bad), '')
  }
  assert.equal(HelmxUi.formatOffsetMs(0), '+00:00')
  assert.equal(HelmxUi.formatOffsetMs(999), '+00:00')
  assert.equal(HelmxUi.formatOffsetMs(15_000), '+00:15')
  assert.equal(HelmxUi.formatOffsetMs(15_999), '+00:15')
  assert.equal(HelmxUi.formatOffsetMs(135_000), '+02:15')
  assert.equal(HelmxUi.formatOffsetMs(3_599_999), '+59:59')
  assert.equal(HelmxUi.formatOffsetMs(3_600_000), '+1:00:00')
  assert.equal(HelmxUi.formatOffsetMs(3_735_000), '+1:02:15')
  assert.equal(HelmxUi.formatOffsetMs(36_000_000), '+10:00:00')
  assert.equal(HelmxUi.formatBytes(1024), '1.0 KiB')
})
