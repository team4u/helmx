/**
 * DOM & integration tests for OmniboxModal and useSearchFocusAnchor:
 * - Scope tabs (`All`, `Pages & Settings`, `Commands`, `Conversations`) + `Tab`/`Shift+Tab` cycling + `View all N · Tab`
 * - Primary `Enter`, split `Mod+Enter`, secondary `Alt+Enter` & inline secondary action button
 * - Single debounced `/api/omnibox/search` call: AbortController, generation race guard,
 *   Sync-Upper / Async-Lower selection pinning, safe `<mark>` highlights, honest degraded callouts
 * - IME composition guard, pointer-hover guard, layered `Esc` (IME -> preview -> query -> scope -> close)
 * - Plugin `client + actionId` preview & declarative `target` navigation
 * - `useSearchFocusAnchor` landing highlight (immediate + async MutationObserver) never serialized to URL hash
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {
  ConversationSummary,
  OmniboxSearchResponse,
  PluginConfigCatalogEntry,
  PluginSummary,
  PluginUiContribution,
} from '@helmx/protocol/browser'
import { ensureHappyDom, resetHappyDom, typeIntoControl } from './helpers/dom-harness.js'
import { makeTestStore } from './helpers/store.js'

ensureHappyDom()

const { HostStoreProviders } = await import('./helpers/host-store.js')
const { OmniboxModal } = await import('../src/omnibox/OmniboxModal.js')
const { useSearchFocusAnchor, SEARCH_FOCUS_HIGHLIGHT_CLASS } = await import('../src/lib/use-search-focus-anchor.js')
const { formatLocationHash } = await import('../src/lib/url-hash-model.js')
const { OMNIBOX_FRECENCY_STORAGE_KEY } = await import('../src/omnibox/frecency.js')

function makeConversation(id: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title: `Topic ${id}`,
    profileId: 'coder',
    tags: [],
    ownedBy: 'human',
    nodeId: 'local',
    cwd: '/work',
    model: 'faux/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: id * 1000,
    updatedAt: id * 1000,
    ...overrides,
  }
}

function makePlugin(id: string, name: string, enabled = true): PluginSummary {
  return {
    id,
    name: { en: name, 'zh-CN': name },
    version: '1.0.0',
    enabled,
    locked: false,
    hooks: [],
    actions: [],
    tools: [],
  }
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

function getInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('.palette-header input')
  assert.ok(el !== null, 'omnibox search input should be rendered')
  return el
}

function getRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.palette-listbox [data-idx].nav-item')]
}

describe('omnibox-modal', () => {
  let host: HTMLDivElement
  let root: Root
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    resetHappyDom()
    window.localStorage.removeItem(OMNIBOX_FRECENCY_STORAGE_KEY)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }, { timeout: 60_000 })

  test('scope tabs cycle on Tab/Shift+Tab without leaving input and View all jumps to dedicated scope', { timeout: 60_000 }, async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ query: 'skill', messages: [], pluginItems: [] } satisfies OmniboxSearchResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    const skills = Array.from({ length: 8 }, (_, idx) => ({
      id: `skill-${idx}`,
      name: `Skill Alpha ${idx}`,
      description: 'Reusable automation skill',
      source: 'data' as const,
      references: [],
    }))

    const store = makeTestStore({
      activeModal: { kind: 'command-palette' },
      skills,
      conversations: [makeConversation(1, { title: 'Skill planning' })],
    })

    await act(async () => {
      root.render(
        <HostStoreProviders value={store}>
          <OmniboxModal onClose={() => {}} searchDebounceMs={20} />
        </HostStoreProviders>,
      )
    })
    await settle()

    const input = getInput()
    // Empty state hides the 8 skills
    assert.equal(getRows().some((row) => row.textContent?.includes('Skill Alpha 0')), false)

    // Type query -> All scope caps pages at 5 and shows "View all N · Tab" button
    await act(async () => {
      typeIntoControl(input, 'Skill Alpha')
    })
    await settle(40)

    const viewAllBtn = document.querySelector<HTMLButtonElement>('.omnibox-view-all-btn')
    assert.ok(viewAllBtn !== null, 'truncated section should render View all button')
    assert.ok(viewAllBtn.textContent?.includes('View all 8'))

    // Tab cycles All -> Pages & Settings without leaving input
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    })
    const activeTab = document.querySelector<HTMLElement>('[data-omnibox-scope="pages"][data-state="active"], [data-omnibox-scope="pages"].is-active')
    assert.ok(activeTab !== null, 'Tab should switch active scope to pages')
    assert.ok(document.activeElement === input, 'focus must stay on the search input after Tab')
    assert.equal(
      getRows().filter((row) => row.textContent?.includes('Skill Alpha')).length,
      8,
      'dedicated Pages scope should display all 8 matched skills',
    )

    // Shift+Tab cycles back to All
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    })
    const allTab = document.querySelector<HTMLElement>('[data-omnibox-scope="all"][data-state="active"], [data-omnibox-scope="all"].is-active')
    assert.ok(allTab !== null, 'Shift+Tab should cycle back to all')

    // Clicking "View all" jumps directly to Pages scope
    const jumpBtn = document.querySelector<HTMLButtonElement>('.omnibox-view-all-btn')
    assert.ok(jumpBtn !== null)
    await act(async () => {
      jumpBtn.click()
    })
    assert.equal(
      getRows().filter((row) => row.textContent?.includes('Skill Alpha')).length,
      8,
    )
  })

  test('primary Enter, split Mod+Enter, and Alt+Enter / button secondary action on single-entity dedup rows', { timeout: 60_000 }, async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ query: 'coder', messages: [], pluginItems: [] } satisfies OmniboxSearchResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    const opened: Array<{ target: unknown; opts: unknown }> = []
    let closedCount = 0
    const store = makeTestStore({
      activeModal: { kind: 'command-palette' },
      profiles: [{ id: 'coder', name: 'Coder' }],
      primaryTarget: { kind: 'overview' },
    })
    const origOpen = store.actions.openTarget
    ;(store.actions as unknown as { openTarget: (t: unknown, o?: unknown) => void }).openTarget = (target, opts) => {
      opened.push({ target, opts })
      origOpen(target as never, opts as never)
    }

    const renderModal = async () => {
      await act(async () => {
        root.render(
          <HostStoreProviders value={store}>
            <OmniboxModal onClose={() => { closedCount += 1 }} searchDebounceMs={20} />
          </HostStoreProviders>,
        )
      })
      await settle()
    }

    // 1) Alt+Enter triggers secondary action: Configure Profile -> #/settings/profiles/coder
    await renderModal()
    let input = getInput()
    await act(async () => {
      typeIntoControl(input, 'coder')
    })
    await settle()

    const coderRow = getRows().find((r) => r.dataset.omniboxId === 'profile:coder')
    assert.ok(coderRow !== undefined)
    // Top hit or first row is profile:coder
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }))
    })
    assert.equal(closedCount, 1)
    assert.deepEqual(opened[0]?.target, { kind: 'profiles', profileId: 'coder' })

    // 2) Clicking inline secondary action button also configures profile cleanly
    await act(async () => {
      root.unmount()
    })
    root = createRoot(host)
    await renderModal()
    input = getInput()
    await act(async () => {
      typeIntoControl(input, 'coder')
    })
    await settle()
    const secondaryBtn = document.querySelector<HTMLButtonElement>('[data-omnibox-id="profile:coder"] .omnibox-secondary-btn')
    assert.ok(secondaryBtn !== null)
    await act(async () => {
      secondaryBtn.click()
    })
    assert.equal(closedCount, 2)
    assert.deepEqual(opened[1]?.target, { kind: 'profiles', profileId: 'coder' })

    // 3) Ctrl+Enter opens primary target in right split
    await act(async () => {
      root.unmount()
    })
    root = createRoot(host)
    await renderModal()
    input = getInput()
    await act(async () => {
      typeIntoControl(input, 'coder')
    })
    await settle()
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    })
    assert.equal(closedCount, 3)
    assert.deepEqual(opened[2]?.target, { kind: 'agent', profileId: 'coder' })
    assert.deepEqual(opened[2]?.opts, { split: true })
  })

  test('async /api/omnibox/search: Sync-Upper selection pinning, AbortController cancellation, safe <mark> highlights, and honest degraded notices', { timeout: 60_000 }, async () => {
    const requests: Array<{ url: string; signal: AbortSignal | undefined; resolve: (res: Response) => void }> = []
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      return new Promise<Response>((resolve) => {
        requests.push({ url: urlStr, signal: init?.signal ?? undefined, resolve })
      })
    }) as typeof fetch

    const store = makeTestStore({
      activeModal: { kind: 'command-palette' },
      conversations: [makeConversation(11, { title: 'Deploy notes' })],
      skills: [
        { id: 'deploy-one', name: 'Deploy One', description: 'First deploy skill', source: 'data', references: [] },
        { id: 'deploy-two', name: 'Deploy Two', description: 'Second deploy skill', source: 'data', references: [] },
      ],
    })

    await act(async () => {
      root.render(
        <HostStoreProviders value={store}>
          <OmniboxModal onClose={() => {}} searchDebounceMs={25} />
        </HostStoreProviders>,
      )
    })
    await settle()

    const input = getInput()
    await act(async () => {
      typeIntoControl(input, 'dep')
    })
    await settle(40)
    assert.equal(requests.length, 1)
    assert.ok(requests[0]!.url.includes('/api/omnibox/search'))

    // Typing continuation aborts first in-flight request
    await act(async () => {
      typeIntoControl(input, 'deploy')
    })
    assert.equal(requests[0]!.signal?.aborted, true, 'superseding query must abort prior request')

    // User picks the 2nd sync row (`skill:deploy-two`) BEFORE async results arrive
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    const activeBefore = document.querySelector<HTMLElement>('.palette-listbox [aria-selected="true"]')
    assert.equal(activeBefore?.dataset.omniboxId, 'skill:deploy-two')

    await settle(40)
    assert.equal(requests.length, 2)

    // Async lower-zone payload arrives with plugin hit, FTS message with HTML & highlights, AND degraded warnings
    const payload: OmniboxSearchResponse = {
      query: 'deploy',
      messages: [
        {
          conversationId: 99,
          entryId: 'e-xss',
          title: '<b>Release</b>',
          snippet: 'run <script>deploy</script> now',
          highlights: [{ start: 12, end: 18 }],
        },
      ],
      pluginItems: [
        {
          id: 'builtin:workflow/wf-1',
          pluginId: 'builtin:workflow',
          itemId: 'wf-1',
          kind: 'resource',
          title: { en: 'Deploy Pipeline #1', 'zh-CN': '部署流水线 #1' },
          target: 'screen:builtin:workflow/runs?runId=wf-1',
          score: 95,
        },
      ],
      messagesUnavailable: false,
      failedPlugins: ['ext:slow'],
    }

    await act(async () => {
      requests[1]!.resolve(
        new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
      )
      await Promise.resolve()
    })
    await settle()

    // Pinned selection NEVER jumps when async lower-zone results arrive!
    const activeAfter = document.querySelector<HTMLElement>('.palette-listbox [aria-selected="true"]')
    assert.equal(activeAfter?.dataset.omniboxId, 'skill:deploy-two')

    // Async divider separates upper sync rows from lower async rows
    assert.ok(document.querySelector('.omnibox-zone-divider') !== null)
    // Safe React <mark> escapes HTML tags (zero injected <script> elements)
    assert.equal(document.querySelectorAll('.palette-listbox script').length, 0)
    const msgMarks = [...document.querySelectorAll('.palette-hit-snippet mark.palette-highlight')].map((m) => m.textContent)
    assert.deepEqual(msgMarks, ['deploy'])

    // Honest degraded callout displays failed plugin ID
    const notice = document.querySelector('.palette-status-notice')
    assert.ok(notice !== null)
    assert.ok(notice.textContent?.includes('ext:slow'))

    // Clicking an async plugin resource hit must NOT pollute localStorage frecency LRU
    const pluginHitRow = getRows().find((r) => r.dataset.omniboxId === 'plugin-hit:builtin:workflow/wf-1')
    assert.ok(pluginHitRow !== undefined)
    await act(async () => {
      pluginHitRow.click()
    })
    assert.equal(window.localStorage.getItem(OMNIBOX_FRECENCY_STORAGE_KEY), null)

    // Strict `#999` pin skips remote `/api/omnibox/search` and shows "No matching results" (not empty hint)
    const prevRequestCount = requests.length
    await act(async () => {
      typeIntoControl(input, '#999')
    })
    await settle(40)
    assert.equal(requests.length, prevRequestCount, 'exact #id pin must not trigger remote search')
    const emptyStatus = document.querySelector('.palette-empty')
    assert.ok(emptyStatus !== null)
    assert.ok(emptyStatus.textContent?.includes('No matching results'))
  })

  test('IME guard, layered Esc (IME -> preview -> query -> scope -> close), and plugin command preview / target', { timeout: 60_000 }, async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ query: 'x', messages: [], pluginItems: [] } satisfies OmniboxSearchResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    const plugin = makePlugin('demo:tools', 'Demo Tools')
    const uiContributions: PluginUiContribution[] = [
      {
        pluginId: 'demo:tools',
        surface: 'commandPalette',
        spec: {
          id: 'inspect',
          title: { en: 'Inspect Tool', 'zh-CN': '检查工具' },
          actionId: 'runInspect',
          client: { module: 'client.js', export: 'InspectView' },
        },
      },
      {
        pluginId: 'demo:tools',
        surface: 'commandPalette',
        spec: {
          id: 'go-archive',
          title: { en: 'Open Archived Overview', 'zh-CN': '打开已归档总览' },
          target: 'overview?bucket=archived',
        },
      },
    ]

    let closed = false
    const store = makeTestStore({
      activeModal: { kind: 'command-palette' },
      plugins: [plugin],
      uiContributions,
    })

    await act(async () => {
      root.render(
        <HostStoreProviders value={store}>
          <OmniboxModal onClose={() => { closed = true }} searchDebounceMs={25} />
        </HostStoreProviders>,
      )
    })
    await settle()

    const input = getInput()
    // Open client command preview
    const previewRow = getRows().find((r) => r.dataset.omniboxId === 'plugin:demo:tools/inspect')
    assert.ok(previewRow !== undefined)
    await act(async () => {
      previewRow.click()
    })
    assert.ok(document.querySelector('.palette-preview') !== null)
    assert.equal(closed, false)

    // Switch scope to commands and type a query
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
      typeIntoControl(input, 'inspect')
    })

    // 1) During IME composition, Escape is ignored
    await act(async () => {
      input.dispatchEvent(new Event('compositionstart'))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.ok(document.querySelector('.palette-preview') !== null)
    assert.equal(input.value, 'inspect')
    assert.equal(closed, false)

    // End IME composition
    await act(async () => {
      input.dispatchEvent(new Event('compositionend'))
    })

    // 2) First Esc closes preview
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.ok(document.querySelector('.palette-preview') === null)
    assert.equal(input.value, 'inspect')
    assert.equal(closed, false)

    // 3) Second Esc clears query
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.equal(input.value, '')
    assert.equal(closed, false)

    // 4) Third Esc resets scope back to All
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.equal(closed, false)

    // 5) Fourth Esc closes modal
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.equal(closed, true)

    // 6) Declarative `CommandSpec.target` navigates directly to `overview?bucket=archived`
    closed = false
    await act(async () => {
      root.unmount()
    })
    root = createRoot(host)
    await act(async () => {
      root.render(
        <HostStoreProviders value={store}>
          <OmniboxModal onClose={() => { closed = true }} searchDebounceMs={25} />
        </HostStoreProviders>,
      )
    })
    await settle()
    const targetCmdRow = getRows().find((r) => r.dataset.omniboxId === 'plugin:demo:tools/go-archive')
    assert.ok(targetCmdRow !== undefined)
    await act(async () => {
      targetCmdRow.click()
    })
    assert.equal(closed, true)
    assert.deepEqual(store.getPrimaryTarget(), { kind: 'overview', params: { bucket: 'archived' } })
  })

  test('selecting pluginConfigCatalog field triggers transient searchFocusAnchor highlight and never leaks into URL hash', { timeout: 60_000 }, async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ query: 'retention', messages: [], pluginItems: [] } satisfies OmniboxSearchResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    const catalog: PluginConfigCatalogEntry[] = [
      {
        pluginId: 'builtin:memory',
        pluginName: { en: 'Memory', 'zh-CN': '记忆' },
        enabled: true,
        fields: [
          {
            key: 'retentionDays',
            type: 'number',
            secret: false,
            required: false,
            label: { en: 'Retention Days', 'zh-CN': '保留天数' },
          },
        ],
      },
    ]

    const store = makeTestStore({
      activeModal: { kind: 'command-palette' },
      plugins: [makePlugin('builtin:memory', 'Memory')],
      pluginConfigCatalog: catalog,
    })

    let modalOpen = true
    let scrolled = false
    function LandingView({ showAnchor }: { showAnchor: boolean }) {
      useSearchFocusAnchor()
      return (
        <div>
          {modalOpen && <OmniboxModal onClose={() => { modalOpen = false }} searchDebounceMs={25} />}
          {showAnchor && (
            <div
              data-search-anchor="config:builtin:memory/retentionDays"
              ref={(el) => {
                if (el) {
                  el.scrollIntoView = () => {
                    scrolled = true
                  }
                }
              }}
            >
              Retention field
            </div>
          )}
        </div>
      )
    }

    await act(async () => {
      root.render(
        <HostStoreProviders value={store}>
          <LandingView showAnchor={false} />
        </HostStoreProviders>,
      )
    })
    await settle()

    const input = getInput()
    await act(async () => {
      typeIntoControl(input, 'retentionDays')
    })
    await settle()

    const cfgRow = getRows().find((r) => r.dataset.omniboxId === 'plugin-config:builtin:memory/retentionDays')
    assert.ok(cfgRow !== undefined, 'pluginConfigCatalog field should appear in Omnibox at 0ms')

    await act(async () => {
      cfgRow.click()
    })

    assert.deepEqual(store.getPrimaryTarget(), { kind: 'plugins', pluginId: 'builtin:memory' })
    assert.equal(store.getSearchFocusAnchor()?.anchorId, 'config:builtin:memory/retentionDays')
    // URL hash NEVER contains searchFocusAnchor!
    const hash = formatLocationHash({
      primaryTarget: store.getPrimaryTarget(),
      splitTarget: null,
      drawerStack: [],
      activeModal: null,
    })
    assert.equal(hash, '#/settings/plugins/builtin:memory')

    // Async mount of target anchor via MutationObserver receives highlight class and scrollIntoView
    await act(async () => {
      root.render(
        <HostStoreProviders value={store}>
          <LandingView showAnchor={true} />
        </HostStoreProviders>,
      )
    })
    await settle(30)

    const anchorEl = document.querySelector<HTMLElement>('[data-search-anchor="config:builtin:memory/retentionDays"]')
    assert.ok(anchorEl !== null)
    assert.equal(scrolled, true)
    assert.equal(anchorEl.classList.contains(SEARCH_FOCUS_HIGHLIGHT_CLASS), true)
  })
})
