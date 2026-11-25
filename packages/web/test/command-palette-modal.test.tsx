/**
 * DOM & integration tests for CommandPaletteModal:
 * - Empty state grouping (no per-plugin detail noise, includes overview & dynamic humanSelectable profiles)
 * - Focused panel navigation vs Mod+Enter split (without leaking focusedPanel into URL/non-navigable commands)
 * - Async FTS AbortController cancellation, generation guard, anti-empty-flicker, and honest error display
 * - Safe React <mark> highlight rendering (highlights spans, [] title-only honesty, undefined fallback, XSS safety)
 * - IME composition deferral & Enter/Arrow/Esc guarding
 * - Stable selectionId across async updates & mouse-hover guard against hijacking keyboard selection
 * - Layered Escape (preview -> clear query -> close modal)
 * - Plugin CommandSpec (client preview with conversationId + explicit Run button when actionId also set + scope filtering)
 * - WAI-ARIA combobox/listbox/option semantics & visualViewport CSS variable sync
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { describe, before, afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { ConversationSummary, PluginSummary, PluginUiContribution, Profile } from '@helmx/protocol'
import { jsonResponse } from '@helmx/test-kit'
import { ensureHappyDom, flushMacrotask, typeIntoControl, waitForCondition } from './helpers/dom-harness.js'
import { makeTestStore } from './helpers/store.js'

ensureHappyDom()
const { resetPluginClientCache, seedPluginClientModule } = await import('../src/lib/plugin-client.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { mountSharedPluginNamespaces } = await import('./helpers/builtin-clients.js')

const { createRoot } = await import('react-dom/client')
const { CommandPaletteModal } = await import('../src/modals/CommandPaletteModal.js')

const originalFetch = globalThis.fetch

let root: Root | undefined
let host: HTMLElement | undefined

function mount(element: React.ReactElement): void {
  if (root !== undefined) {
    act(() => root?.unmount())
  }
  host?.remove()
  host = document.createElement('div')
  document.body.appendChild(host)
  act(() => {
    root = createRoot(host!)
    root.render(element)
  })
}
describe("command-palette-modal", () => {
  before(() => {
    mountSharedPluginNamespaces({ realHooks: true })
  })


  afterEach(() => {
    globalThis.fetch = originalFetch
    if (root !== undefined) {
      act(() => root?.unmount())
      root = undefined
    }
    resetPluginClientCache()
    host?.remove()
    host = undefined
  })

  function makeConv(id: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
    return {
      id,
      title: `Conversation #${id}`,
      profileId: 'assistant',
      model: 'anthropic/claude-sonnet-4',
      thinkingLevel: 'medium',
      status: 'idle',
      stateChangeSeq: 1,
      completionSeq: 1,
      nodeId: 'local',
      cwd: '/tmp/work',
      createdAt: 1000,
      updatedAt: 2000,
      tags: [],
      unread: false,
      pinned: false,
      pendingAskCount: 0,
      ...overrides,
    }
  }

  function getInput(): HTMLInputElement {
    const el = document.querySelector<HTMLInputElement>('.palette-modal .search-box input')
    assert.ok(el !== null, 'search input must render inside .palette-modal')
    return el
  }

  function getOptions(): HTMLButtonElement[] {
    return [...document.querySelectorAll<HTMLButtonElement>('.palette-listbox [data-idx].nav-item')]
  }

  test('CommandPaletteModal empty state: grouped headers, removes per-plugin detail noise, exposes overview & visible profiles', { timeout: 60_000 }, async () => {
    const plugins: PluginSummary[] = [
      { id: 'builtin:memory', name: { en: 'Memory', 'zh-CN': '记忆' }, version: '1.0.0', enabled: true, locked: false, hooks: [], actions: ['get'], tools: [] },
      { id: 'ext:disabled', name: 'Disabled Plugin', version: '1.0.0', enabled: false, locked: false, hooks: [], actions: [], tools: [] },
    ]
    const profiles: Profile[] = [
      { id: 'assistant', name: 'Assistant' },
      { id: 'coder', name: 'Coder' },
      { id: 'hidden-plugin-role', name: 'Hidden Role', managedByPlugin: 'ext:disabled' },
    ]
    const store = makeTestStore({
      plugins,
      profiles,
      conversations: [makeConv(1, { title: 'Current chat', profileId: 'coder' }), makeConv(2, { title: 'Other chat' })],
      primaryTarget: { kind: 'conversation', conversationId: 1 },
    })

    mount(
      <HostStoreProviders value={store}>
        <CommandPaletteModal onClose={() => {}} searchDebounceMs={25} />
      </HostStoreProviders>,
    )
    await flushMacrotask(0)

    const modal = document.querySelector<HTMLElement>('.palette-modal')
    assert.ok(modal !== null)

    // Group headers exist and have role="presentation" (never hijack [data-idx] selection)
    const headers = [...modal.querySelectorAll<HTMLElement>('.palette-group-header')]
    assert.deepEqual(
      headers.map((h) => h.textContent?.trim()),
      ['Current context', 'Recent conversations', 'Navigate', 'Commands'],
    )
    for (const header of headers) {
      assert.equal(header.getAttribute('role'), 'presentation')
    }

    const options = getOptions()
    const labels = options.map((o) => o.textContent ?? '')
    // Per-plugin detail rows are gone
    assert.equal(labels.some((l) => l.includes('Plugin: Memory') || l.includes('View and configure')), false)
    // Overview & visible profiles appear
    assert.equal(labels.some((l) => l.includes('Open conversation overview')), true)
    assert.equal(labels.some((l) => l.includes('Open agent: Assistant')), true)
    assert.equal(labels.some((l) => l.includes('Open agent: Coder')), true)
    // Disabled-plugin profiles are excluded
    assert.equal(labels.some((l) => l.includes('Hidden Role')), false)

    // First actionable option [data-idx="0"] is selected initially and ArrowDown moves directly to [data-idx="1"]
    assert.equal(options[0]?.getAttribute('aria-selected'), 'true')
    await act(async () => {
      modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    assert.equal(options[1]?.getAttribute('aria-selected'), 'true')
  })

  test('CommandPaletteModal navigation follows focusedPanel on Enter and targets split on Mod+Enter without splitting action commands', { timeout: 60_000 }, async () => {
    const opened: Array<{ target: unknown; opts: unknown }> = []
    const store = makeTestStore({
      profiles: [{ id: 'coder', name: 'Coder' }],
      conversations: [
        makeConv(1, { title: 'Primary conv', profileId: 'coder' }),
        makeConv(2, { title: 'Split conv', profileId: 'coder' }),
        makeConv(3, { title: 'Target conv', profileId: 'coder' }),
      ],
      primaryTarget: { kind: 'conversation', conversationId: 1 },
      splitTarget: { kind: 'conversation', conversationId: 2 },
      focusedPanel: 'split',
    })
    const origOpenTarget = store.actions.openTarget
    ;(store.actions as unknown as { openTarget: (t: unknown, o?: unknown) => void }).openTarget = (t, o) => {
      opened.push({ target: t, opts: o })
      origOpenTarget(t as never, o as never)
    }

    let closedCount = 0
    mount(
      <HostStoreProviders value={store}>
        <CommandPaletteModal onClose={() => { closedCount += 1 }} />
      </HostStoreProviders>,
    )
    await flushMacrotask(0)

    // 1) Ordinary Enter when focusedPanel='split' navigates the split pane
    const modal = document.querySelector<HTMLElement>('.palette-modal')!
    const overviewIdx = getOptions().findIndex((o) => o.textContent?.includes('Open conversation overview'))
    assert.ok(overviewIdx >= 0)
    for (let i = 0; i < overviewIdx; i++) {
      await act(async () => {
        modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      })
    }
    await act(async () => {
      modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.equal(closedCount, 1)
    assert.deepEqual(opened[0], { target: { kind: 'overview' }, opts: { split: true } })

    // 2) FocusedPanel='primary' + Mod+Enter opens in split while preserving focusedPanel='primary'
    const storePrimary = makeTestStore({
      profiles: [{ id: 'coder', name: 'Coder' }],
      conversations: [makeConv(1, { title: 'Primary conv', profileId: 'coder' })],
      primaryTarget: { kind: 'conversation', conversationId: 1 },
      splitTarget: null,
      focusedPanel: 'primary',
    })
    const openedPrimary: Array<{ target: unknown; opts: unknown }> = []
    ;(storePrimary.actions as unknown as { openTarget: (t: unknown, o?: unknown) => void }).openTarget = (t, o) => {
      openedPrimary.push({ target: t, opts: o })
    }

    mount(
      <HostStoreProviders value={storePrimary}>
        <CommandPaletteModal onClose={() => { closedCount += 1 }} />
      </HostStoreProviders>,
    )
    await flushMacrotask(0)
    const modal2 = document.querySelector<HTMLElement>('.palette-modal')!
    const coderIdx = getOptions().findIndex((o) => o.textContent?.includes('Open agent: Coder'))
    assert.ok(coderIdx >= 0)
    for (let i = 0; i < coderIdx; i++) {
      await act(async () => {
        modal2.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      })
    }
    await act(async () => {
      modal2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
    })
    assert.equal(closedCount, 2)
    assert.deepEqual(openedPrimary[0], { target: { kind: 'agent', profileId: 'coder' }, opts: { split: true } })
    assert.equal(storePrimary.getLocationTargetsSlice().focusedPanel, 'primary')

    // 3) Mod+Enter on a non-navigable command never calls openTarget / never splits
    mount(
      <HostStoreProviders value={storePrimary}>
        <CommandPaletteModal onClose={() => { closedCount += 1 }} />
      </HostStoreProviders>,
    )
    await flushMacrotask(0)
    const modal3 = document.querySelector<HTMLElement>('.palette-modal')!
    const themeIdx = getOptions().findIndex((o) => o.textContent?.includes('Switch to'))
    assert.ok(themeIdx >= 0)
    for (let i = 0; i < themeIdx; i++) {
      await act(async () => {
        modal3.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      })
    }
    const beforeCount = openedPrimary.length
    await act(async () => {
      modal3.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
    })
    assert.equal(openedPrimary.length, beforeCount, 'non-navigable action command must not split on Mod+Enter')
  })

  test('CommandPaletteModal FTS AbortController cancellation, generation race guard, anti-empty-flicker, and honest error notice', { timeout: 60_000 }, async () => {
    const requests: Array<{ q: string; signal?: AbortSignal; resolve: (res: Response) => void; reject: (err: unknown) => void }> = []
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const q = new URL(url, 'http://localhost').searchParams.get('q') ?? ''
      return new Promise<Response>((resolve, reject) => {
        requests.push({ q, signal: init?.signal ?? undefined, resolve, reject })
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
    }) as typeof fetch

    const store = makeTestStore({ conversations: [makeConv(1)] })
    mount(
      <HostStoreProviders value={store}>
        <CommandPaletteModal onClose={() => {}} searchDebounceMs={25} />
      </HostStoreProviders>,
    )
    await flushMacrotask(0)

    const input = getInput()
    // Type first query that matches nothing locally
    await act(async () => {
      typeIntoControl(input, 'zzq1')
    })
    // During 200ms debounce, "No matching results" MUST NOT flicker; searching hint appears instead
    const emptyStatusDuringDebounce = document.querySelector('.palette-empty')?.textContent ?? ''
    assert.equal(emptyStatusDuringDebounce.includes('No matching results'), false)
    assert.ok(emptyStatusDuringDebounce.includes('Searching message history'))

    // Wait for debounce to fire request #1
    await waitForCondition(() => requests.length === 1)
    assert.equal(requests[0]?.q, 'zzq1')
    assert.equal(requests[0]?.signal?.aborted, false)

    // Type second query while request #1 is still pending -> request #1 must abort
    await act(async () => {
      typeIntoControl(input, 'zzq2')
    })
    assert.equal(requests[0]?.signal?.aborted, true, 'stale in-flight FTS request must be aborted on new query')

    await waitForCondition(() => requests.length === 2)
    assert.equal(requests[1]?.q, 'zzq2')

    // Even if request #1 resolves late (if abort didn't prevent resolution), generation guard ignores it;
    // resolve request #2 with an explicit HTTP 500 error -> honest unavailable notice instead of "No matching results"
    await act(async () => {
      requests[1]!.resolve(jsonResponse({ error: { code: 'db_error', message: 'fts down' } }, 500))
    })
    await waitForCondition(() =>
      (document.querySelector('.palette-empty')?.textContent ?? '').includes('Full-text message search is temporarily unavailable'),
    )
    assert.equal((document.body.textContent ?? '').includes('No matching results'), false)

    // Now type a third query that genuinely returns 0 hits -> "No matching results" settles cleanly
    await act(async () => {
      typeIntoControl(input, 'zzq3')
    })
    await waitForCondition(() => requests.length === 3)
    await act(async () => {
      requests[2]!.resolve(jsonResponse([]))
    })
    await waitForCondition(() => (document.querySelector('.palette-empty')?.textContent ?? '').includes('No matching results'))
  })

  test('CommandPaletteModal safe React <mark> highlights: honors backend spans, respects [] on title-only hits, falls back on undefined, escapes HTML', { timeout: 60_000 }, async () => {
    globalThis.fetch = (async () =>
      jsonResponse([
        {
          conversationId: 10,
          entryId: 'e5',
          title: 'Deploy check',
          snippet: 'Run <script>alert(1)</script> deploy now',
          highlights: [{ start: 30, end: 36 }],
        },
        {
          conversationId: 11,
          title: 'Deploy plan',
          snippet: 'Unmatched body words',
          highlights: [],
        },
        {
          conversationId: 12,
          entryId: 'e9',
          snippet: 'Legacy deploy stub',
        },
      ])) as typeof fetch

    const store = makeTestStore({
      conversations: [makeConv(12, { title: 'Conv twelve' })],
    })
    mount(
      <HostStoreProviders value={store}>
        <CommandPaletteModal onClose={() => {}} searchDebounceMs={25} />
      </HostStoreProviders>,
    )
    await flushMacrotask(0)

    const input = getInput()
    await act(async () => {
      typeIntoControl(input, 'deploy')
    })

    await waitForCondition(() => getOptions().some((o) => o.textContent?.includes('#10')))
    const options = getOptions()

    // Hit #10: backend span highlights "deploy" and renders <script> literally (no raw script tag!)
    const hit10 = options.find((o) => o.textContent?.includes('#10'))!
    assert.equal(hit10.querySelectorAll('script').length, 0)
    assert.ok(hit10.textContent?.includes('<script>alert(1)</script>'))
    const marks10 = [...hit10.querySelectorAll('mark.palette-highlight')].map((m) => m.textContent)
    assert.deepEqual(marks10, ['Deploy', 'deploy'])

    // Hit #11: highlights: [] means title-only hit -> title highlights "Deploy", snippet has ZERO <mark>
    const hit11 = options.find((o) => o.textContent?.includes('#11'))!
    const snippetMarks11 = hit11.querySelectorAll('.palette-hit-snippet mark')
    assert.equal(snippetMarks11.length, 0)
    assert.deepEqual(
      [...hit11.querySelectorAll('.nav-item-label mark')].map((m) => m.textContent),
      ['Deploy'],
    )

    // Hit #12: highlights: undefined falls back to token highlighting in snippet AND title fallback from store conv
    const hit12 = options.find((o) => o.textContent?.includes('#12'))!
    assert.ok(hit12.textContent?.includes('Conv twelve'))
    assert.deepEqual(
      [...hit12.querySelectorAll('.palette-hit-snippet mark')].map((m) => m.textContent),
      ['deploy'],
    )
  })

  test('CommandPaletteModal IME composition guard, stable selectionId across async FTS arrivals, mouse-hover guard, and layered Esc', { timeout: 60_000 }, async () => {
    let fetchCount = 0
    let resolveSearch: ((res: Response) => void) | undefined
    globalThis.fetch = (() => {
      fetchCount += 1
      return new Promise<Response>((resolve) => {
        resolveSearch = resolve
      })
    }) as typeof fetch

    let closed = false
    const store = makeTestStore({
      conversations: [
        makeConv(1, { title: 'Alpha thread', updatedAt: 3000 }),
        makeConv(2, { title: 'Alpha secondary', updatedAt: 2000 }),
      ],
    })

    mount(
      <HostStoreProviders value={store}>
        <CommandPaletteModal onClose={() => { closed = true }} searchDebounceMs={25} />
      </HostStoreProviders>,
    )
    await flushMacrotask(0)

    const input = getInput()
    const modal = document.querySelector<HTMLElement>('.palette-modal')!

    // 1) IME composition: compositionstart defers FTS and prevents Enter / ArrowDown / Escape from firing
    await act(async () => {
      input.dispatchEvent(new Event('compositionstart'))
      typeIntoControl(input, 'alpha')
    })
    await flushMacrotask(45)
    assert.equal(fetchCount, 0, 'FTS must not fire while IME composition is active')

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }))
    })
    assert.equal(closed, false)
    assert.equal(input.value, 'alpha', 'Esc during IME composition must not clear query')

    // compositionend triggers FTS search
    await act(async () => {
      input.dispatchEvent(new Event('compositionend'))
    })
    await waitForCondition(() => fetchCount === 1)

    // Move keyboard selection to second local option (conv:2) before FTS arrives
    const beforeOpts = getOptions()
    assert.equal(beforeOpts.length, 2)
    await act(async () => {
      modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    assert.equal(getOptions()[1]?.getAttribute('aria-selected'), 'true')

    // Stationary mouseEnter on option 0 after ArrowDown must NOT hijack keyboard selection
    await act(async () => {
      getOptions()[0]!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
    })
    assert.equal(getOptions()[1]?.getAttribute('aria-selected'), 'true', 'stationary mouseEnter must not steal keyboard selection')

    // Async FTS arrives and appends hit:1:e1 -> selection stays on conv:2 (not reset to 0!)
    await act(async () => {
      resolveSearch!(jsonResponse([{ conversationId: 1, entryId: 'e1', title: 'Alpha thread', snippet: 'alpha line', highlights: [{ start: 0, end: 5 }] }]))
    })
    await waitForCondition(() => getOptions().length === 3)
    assert.equal(getOptions()[1]?.getAttribute('aria-selected'), 'true')

    // Real mousemove with changed coordinates updates selection to row 2
    await act(async () => {
      getOptions()[2]!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: 120 }))
    })
    assert.equal(getOptions()[2]?.getAttribute('aria-selected'), 'true')

    // Layered Escape: query non-empty -> Esc clears query (keeps modal open)
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.equal(input.value, '')
    assert.equal(closed, false)

    // Layered Escape: empty query & no preview -> Esc closes modal
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.equal(closed, true)
  })

  test('CommandPaletteModal plugin client+actionId command preview, scoped conversationId, explicit Run button, and ARIA/visualViewport', { timeout: 60_000 }, async () => {
    const { usePluginContext } = await import('@helmx/plugin-client')
    let observedConvId: number | undefined
    function PreviewWidget() {
      const ctx = usePluginContext()
      observedConvId = ctx.conversationId
      return <div className="test-cmd-preview">Preview for conv {String(ctx.conversationId)}</div>
    }

    const plugin: PluginSummary = {
      id: 'ext:diag',
      name: 'Diag',
      version: '1.0.0',
      enabled: true,
      locked: false,
      hooks: [],
      actions: ['run-diag'],
      tools: [],
      clientHashes: { 'index.tsx': 'hash-1' },
    }
    seedPluginClientModule('ext:diag', 'index.tsx', { PreviewWidget }, 'hash-1')

    const uiContributions: PluginUiContribution[] = [
      {
        pluginId: 'ext:diag',
        surface: 'command',
        spec: {
          id: 'inspect',
          title: 'Inspect session state',
          client: { module: 'index.tsx', export: 'PreviewWidget' },
          actionId: 'run-diag',
          input: { depth: 2 },
          scope: { tags: ['scoped'] },
        },
      },
      {
        pluginId: 'ext:diag',
        surface: 'command',
        spec: {
          id: 'other-only',
          title: 'Out of scope command',
          actionId: 'run-diag',
          scope: { tags: ['unrelated'] },
        },
      },
    ]

    const vvTarget = new EventTarget() as EventTarget & { height: number }
    vvTarget.height = 460
    const prevVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vvTarget })

    const invoked: Array<{ pluginId: string; actionId: string; input: unknown; conversationId?: number }> = []
    const store = makeTestStore({
      plugins: [plugin],
      uiContributions,
      conversations: [makeConv(77, { title: 'Scoped conv', tags: ['scoped'] })],
      primaryTarget: { kind: 'conversation', conversationId: 77 },
    })
    ;(store.actions as unknown as { invokePluginAction: (p: string, a: string, i: unknown, c?: number) => Promise<unknown> }).invokePluginAction = async (p, a, i, c) => {
      invoked.push({ pluginId: p, actionId: a, input: i, conversationId: c })
      return { ok: true }
    }

    let closed = false
    try {
      mount(
        <HostStoreProviders value={store}>
          <CommandPaletteModal onClose={() => { closed = true }} />
        </HostStoreProviders>,
      )
      await flushMacrotask(0)

      const modal = document.querySelector<HTMLElement>('.palette-modal')!
      assert.equal(modal.style.getPropertyValue('--palette-vvh'), '460px')
      await act(async () => {
        vvTarget.height = 380
        vvTarget.dispatchEvent(new Event('resize'))
      })
      assert.equal(modal.style.getPropertyValue('--palette-vvh'), '380px')

      // Verify scope filtering hides out-of-scope commands
      assert.equal(getOptions().some((o) => o.textContent?.includes('Out of scope command')), false)

      // Verify WAI-ARIA combobox + listbox wiring
      const input = getInput()
      const listbox = document.querySelector<HTMLElement>('.palette-listbox[role="listbox"]')
      assert.ok(listbox !== null)
      assert.equal(input.getAttribute('role'), 'combobox')
      assert.equal(input.getAttribute('aria-autocomplete'), 'list')
      assert.equal(input.getAttribute('aria-controls'), listbox.id)
      assert.equal(input.getAttribute('aria-expanded'), 'true')
      const activeId = input.getAttribute('aria-activedescendant')
      assert.ok(activeId !== null && document.getElementById(activeId) !== null)

      // Verify SearchBox clear button clears non-empty query
      await act(async () => {
        typeIntoControl(input, 'Inspect')
      })
      const clearBtn = document.querySelector<HTMLButtonElement>('.palette-search-box button[aria-label="Clear search query"]')
      assert.ok(clearBtn !== null)
      await act(async () => {
        clearBtn.click()
      })
      assert.equal(input.value, '')

      // Click client+actionId command -> opens inline preview (does not close, does not falsely execute action or toast)
      const cmdRow = getOptions().find((o) => o.textContent?.includes('Inspect session state'))
      assert.ok(cmdRow !== undefined)
      await act(async () => {
        cmdRow.click()
        await Promise.resolve()
      })
      await waitForCondition(() => document.querySelector('.test-cmd-preview') !== null)
      assert.equal(closed, false)
      assert.equal(observedConvId, 77, 'client command preview must receive scoped conversationId')
      assert.equal(invoked.length, 0)
      assert.equal(store.getNotices().length, 0)

      // Explicit Run button in preview header executes actionId and closes
      const runBtn = [...document.querySelectorAll<HTMLButtonElement>('.palette-preview-actions button')].find((b) =>
        b.textContent?.includes('Run'),
      )
      assert.ok(runBtn !== undefined, 'command declaring both client and actionId must expose an explicit Run button')

      // First test Esc Layer 1: closes preview without closing palette or running action
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      })
      assert.ok(document.querySelector('.palette-preview') === null)
      assert.equal(closed, false)

      // Re-open preview and click explicit Run button
      await act(async () => {
        cmdRow.click()
        await Promise.resolve()
      })
      await waitForCondition(() => document.querySelector('.palette-preview-actions button') !== null)
      const runBtn2 = [...document.querySelectorAll<HTMLButtonElement>('.palette-preview-actions button')].find((b) =>
        b.textContent?.includes('Run'),
      )!
      await act(async () => {
        runBtn2.click()
      })
      assert.equal(closed, true)
      assert.deepEqual(invoked, [{ pluginId: 'ext:diag', actionId: 'run-diag', input: { depth: 2 }, conversationId: 77 }])
    } finally {
      if (prevVisualViewport !== undefined) {
        Object.defineProperty(window, 'visualViewport', prevVisualViewport)
      } else {
        Reflect.deleteProperty(window, 'visualViewport')
      }
    }
  })

  test('CommandPaletteModal wires New conversation via resolveNewTopicTarget, displays plugin shortcut badge, exposes open-shortcuts command and desktop footer', { timeout: 60_000 }, async () => {
    const opened: Array<{ target: unknown; opts: unknown }> = []
    const uiContributions: PluginUiContribution[] = [
      {
        pluginId: 'ext:sample',
        surface: 'commandPalette',
        spec: {
          id: 'toggle-sample',
          title: { en: 'Toggle Sample mode', 'zh-CN': '切换示例模式' },
          shortcut: 'Ctrl+.',
          actionId: 'toggle',
        },
      },
    ]
    const store = makeTestStore({
      profiles: [
        { id: 'assistant', name: 'Assistant' },
        { id: 'coder', name: 'Coder' },
      ],
      conversations: [
        makeConv(5, { profileId: 'coder', updatedAt: 9000 }),
        makeConv(6, { profileId: 'assistant', updatedAt: 1000 }),
      ],
      uiContributions,
      primaryTarget: { kind: 'overview' },
    })
    ;(store.actions as unknown as { openTarget: (t: unknown, o?: unknown) => void }).openTarget = (t, o) => {
      opened.push({ target: t, opts: o })
    }
    const modals: unknown[] = []
    const origSetActiveModal = store.actions.setActiveModal
    ;(store.actions as unknown as { setActiveModal: (m: unknown) => void }).setActiveModal = (m) => {
      modals.push(m)
      origSetActiveModal(m as never)
    }

    let closedCount = 0
    mount(
      <HostStoreProviders value={store}>
        <CommandPaletteModal onClose={() => { closedCount += 1 }} />
      </HostStoreProviders>,
    )
    await flushMacrotask(0)

    const options = getOptions()
    // 1) New conversation on Overview targets first human-selectable candidate (coder), NOT Profile Center, and shows Mod+Shift+O badge
    const newConvRow = options.find((o) => o.textContent?.includes('New conversation'))
    assert.ok(newConvRow !== undefined)
    assert.ok(newConvRow.textContent?.includes('coder'))
    const newConvKbd = newConvRow.querySelector('kbd.kbd-hint')?.textContent ?? ''
    assert.ok(newConvKbd === '⌘⇧O' || newConvKbd === 'Ctrl+Shift+O')

    await act(async () => {
      newConvRow.click()
    })
    assert.equal(closedCount, 1)
    assert.deepEqual(opened[0], { target: { kind: 'agent', profileId: 'coder' }, opts: undefined })

    // Re-mount to check plugin shortcut badge, open-shortcuts row, and footer button
    mount(
      <HostStoreProviders value={store}>
        <CommandPaletteModal onClose={() => { closedCount += 1 }} />
      </HostStoreProviders>,
    )
    await flushMacrotask(0)

    const options2 = getOptions()
    const pluginRow = options2.find((o) => o.textContent?.includes('Toggle Sample mode'))
    assert.ok(pluginRow !== undefined)
    assert.equal(pluginRow.querySelector('kbd.kbd-hint')?.textContent, 'Ctrl+.')

    const shortcutsRow = options2.find((o) => o.textContent?.includes('Keyboard shortcuts'))
    assert.ok(shortcutsRow !== undefined)
    const shortcutsKbd = shortcutsRow.querySelector('kbd.kbd-hint')?.textContent ?? ''
    assert.ok(shortcutsKbd === '⌘/' || shortcutsKbd === 'Ctrl+/')

    // Footer renders desktop hints + Shortcuts trigger button
    const footer = document.querySelector<HTMLElement>('.palette-footer')
    assert.ok(footer !== null, '.palette-footer must render')
    const footerText = footer.textContent ?? ''
    assert.ok(footerText.includes('↑↓'))
    assert.ok(footerText.includes('Enter'))
    assert.ok(footerText.includes('Esc'))

    const footerBtn = footer.querySelector<HTMLButtonElement>('.palette-footer-shortcuts-btn')
    assert.ok(footerBtn !== null)
    await act(async () => {
      footerBtn.click()
    })
    assert.deepEqual(modals[modals.length - 1], { kind: 'shortcuts' })
  })
})
