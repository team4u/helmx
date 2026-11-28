import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import test, { describe } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ConversationSummary } from '@helmx/protocol'
import type { ActiveModal } from '../src/lib/types.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'
import { setStoredToken } from '../src/lib/api.js'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as Record<string, unknown>).React = React

const { MarkdownView } = await import('../src/conversation/MarkdownView.js')
const { WorkspaceFilePreviewModal } = await import('../src/conversation/WorkspaceFilePreviewModal.js')
const { makeTestStore } = await import('./helpers/store.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')

const e = React.createElement

function conv(
  id: number,
  cwd: string,
  extra: Partial<Pick<ConversationSummary, 'nodeId' | 'parentConversationId' | 'status' | 'updatedAt'>> = {},
): ConversationSummary {
  return {
    id,
    title: `Conv ${id}`,
    profileId: 'assistant',
    nodeId: extra.nodeId ?? 'local',
    cwd,
    ...(extra.parentConversationId !== undefined ? { parentConversationId: extra.parentConversationId } : {}),
    tags: [],
    status: extra.status ?? 'idle',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: extra.updatedAt ?? '2026-01-01T00:00:00Z',
  } as unknown as ConversationSummary
}

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
  }
}

function resetBody(): void {
  for (const node of [...document.body.children]) {
    if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') continue
    node.remove()
  }
}

function installObjectUrlShim(): { active: () => string[]; created: () => string[]; restore: () => void } {
  const origCreate = URL.createObjectURL
  const origRevoke = URL.revokeObjectURL
  const created: string[] = []
  const live = new Set<string>()
  let seq = 0
  URL.createObjectURL = (() => {
    seq += 1
    const url = `blob:ws-test-${seq}`
    created.push(url)
    live.add(url)
    return url
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = ((url: string) => {
    live.delete(url)
  }) as typeof URL.revokeObjectURL
  return {
    active: () => [...live],
    created: () => [...created],
    restore: () => {
      URL.createObjectURL = origCreate
      URL.revokeObjectURL = origRevoke
    },
  }
}

function mount(element: React.ReactElement): { host: HTMLElement; root: Root; unmount: () => void } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(element)
  })
  return {
    host,
    root,
    unmount: () => {
      act(() => {
        root.unmount()
      })
      host.remove()
    },
  }
}

/** 记录真实 setActiveModal 调用序列（委托真实动作）。 */
function spyActiveModal(store: HelmxExternalStore, opened: ActiveModal[]): void {
  const real = store.actions.setActiveModal
  ;(store.actions as unknown as { setActiveModal: (modal: ActiveModal) => void }).setActiveModal = (modal) => {
    opened.push(modal)
    real(modal)
  }
}

describe('MarkdownView workspace file links and inline images', { timeout: 60_000 }, () => {
  test('clicking a relative workspace link opens workspace-file modal with line range', { timeout: 60_000 }, async () => {
    const opened: ActiveModal[] = []
    const store = makeTestStore({
      conversations: [conv(12, '/repo')],
    })
    spyActiveModal(store, opened)

    resetBody()
    const mounted = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(MarkdownView, {
          text: 'See [App](src/App.tsx#L10-L25) and [External](github.com/foo/bar)',
          conversationId: 12,
        }),
      ),
    )

    try {
      const chip = mounted.host.querySelector<HTMLButtonElement>('button.attachment-chip')
      assert.ok(chip !== null, 'relative link renders as attachment-chip button')
      assert.match(chip.textContent ?? '', /App/)

      // Bare web host remains a normal <a>
      const external = mounted.host.querySelector<HTMLAnchorElement>('a')
      assert.ok(external !== null, 'bare domain stays an <a> tag')
      assert.match(external.textContent ?? '', /External/)

      await act(async () => {
        chip.click()
      })
      assert.deepEqual(opened, [
        {
          kind: 'workspace-file',
          conversationId: 12,
          path: 'src/App.tsx',
          startLine: 10,
          endLine: 25,
        },
      ])
    } finally {
      mounted.unmount()
      resetBody()
    }
  })

  test('clicking a bare absolute link inside conversationCwd opens workspace-file modal while outside paths stay safe', { timeout: 60_000 }, async () => {
    const opened: ActiveModal[] = []
    const store = makeTestStore({
      conversations: [conv(15, '/root/code/helm')],
    })
    spyActiveModal(store, opened)

    resetBody()
    const mounted = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(MarkdownView, {
          text: [
            '在 [SKILL.md](/root/code/helm/packages/plugins/src/profile/skill/SKILL.md#L12) 查看索引，',
            '外置路径 [Etc](/etc/passwd) 与 [WinOutside](C:/secret.txt)。',
          ].join(''),
          conversationId: 15,
        }),
      ),
    )

    try {
      const chip = mounted.host.querySelector<HTMLButtonElement>('button.attachment-chip')
      assert.ok(chip !== null, 'cwd-contained bare absolute link renders as attachment-chip')
      assert.match(chip.textContent ?? '', /SKILL\.md/)

      const outsidePosix = mounted.host.querySelector<HTMLAnchorElement>('a[href="/etc/passwd"]')
      assert.ok(outsidePosix !== null, 'outside POSIX path keeps default <a>')

      const disallowedWin = mounted.host.querySelector('.msg-md-disallowed-file')
      assert.ok(disallowedWin !== null, 'outside Windows drive path renders disallowed span')
      assert.equal(disallowedWin.textContent, 'WinOutside')

      await act(async () => {
        chip.click()
      })
      assert.deepEqual(opened, [
        {
          kind: 'workspace-file',
          conversationId: 15,
          path: 'packages/plugins/src/profile/skill/SKILL.md',
          startLine: 12,
        },
      ])
    } finally {
      mounted.unmount()
      resetBody()
    }
  })

  test('non-streaming relative image fetches with auth header and renders thumbnail; disallowed file:// emits no <a> or fetch', { timeout: 60_000 }, async () => {
    const requests: Array<{ url: string; auth: string | null }> = []
    const origFetch = globalThis.fetch
    const shim = installObjectUrlShim()
    setStoredToken('secret-token-42')
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      requests.push({ url, auth: headers.get('Authorization') })
      return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), { status: 200 })
    }) as typeof fetch

    const opened: ActiveModal[] = []
    const store = makeTestStore({
      conversations: [conv(9, '/repo')],
    })
    spyActiveModal(store, opened)

    resetBody()
    const mounted = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(MarkdownView, {
          text: [
            '![Diagram](docs/arch.png)',
            '',
            '[Outside](file:///etc/passwd)',
            '',
            '![OutsideImg](file:///etc/secret.png)',
          ].join('\n'),
          conversationId: 9,
          streaming: false,
        }),
      ),
    )

    try {
      await flush()
      assert.equal(requests.length, 1, 'only workspace-relative image triggers fetch')
      assert.equal(requests[0]!.url, '/api/conversations/9/files/content?path=docs%2Farch.png&inline=1')
      assert.equal(requests[0]!.auth, 'Bearer secret-token-42')

      const thumb = mounted.host.querySelector<HTMLButtonElement>('button.attachment-image-thumb')
      assert.ok(thumb !== null, 'image thumbnail renders after blob load')
      const thumbImg = thumb.querySelector('img')
      assert.ok(thumbImg !== null)
      assert.match(thumbImg.getAttribute('src') ?? '', /^blob:ws-test-/)

      const disallowed = mounted.host.querySelector('.msg-md-disallowed-file')
      assert.ok(disallowed !== null, 'disallowed file:// link renders span')
      assert.equal(disallowed.textContent, 'Outside')
      assert.ok(mounted.host.querySelector('a[href^="file:"]') === null, 'must never emit <a href="file:...">')
      assert.ok(mounted.host.querySelector('img[src^="file:"]') === null, 'must never emit <img src="file:...">')

      await act(async () => {
        thumb.click()
      })
      assert.deepEqual(opened, [{ kind: 'workspace-file', conversationId: 9, path: 'docs/arch.png' }])
    } finally {
      mounted.unmount()
      assert.equal(shim.active().length, 0, 'ObjectURL revoked on unmount')
      shim.restore()
      globalThis.fetch = origFetch
      setStoredToken(null)
      resetBody()
    }
  })

  test('streaming tail block defers workspace image fetch until block settles or streaming ends', { timeout: 60_000 }, async () => {
    const requests: string[] = []
    const origFetch = globalThis.fetch
    const shim = installObjectUrlShim()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return new Response(new Blob([new Uint8Array([1, 2])], { type: 'image/png' }), { status: 200 })
    }) as typeof fetch

    const store = makeTestStore({
      conversations: [conv(5, '/repo')],
    })

    resetBody()
    const mounted = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(MarkdownView, {
          text: '![Prefix](prefix.png)\n\n![Tail](tail.png)',
          conversationId: 5,
          streaming: true,
        }),
      ),
    )

    try {
      await flush()
      assert.deepEqual(
        requests,
        ['/api/conversations/5/files/content?path=prefix.png&inline=1'],
        'prefix block fetches immediately while trailing streaming block defers fetch',
      )

      // Streaming completes -> trailing block now fetches
      await act(async () => {
        mounted.root.render(
          e(
            HostStoreProviders,
            { value: store },
            e(MarkdownView, {
              text: '![Prefix](prefix.png)\n\n![Tail](tail.png)',
              conversationId: 5,
              streaming: false,
            }),
          ),
        )
      })
      await flush()
      assert.equal(requests.length, 2)
      assert.equal(requests[1], '/api/conversations/5/files/content?path=tail.png&inline=1')
    } finally {
      mounted.unmount()
      shim.restore()
      globalThis.fetch = origFetch
      resetBody()
    }
  })

  test('resolves same-tree worktree absolute paths from parent & reviewer sibling while rejecting unrelated trees', { timeout: 60_000 }, async () => {
    const opened: ActiveModal[] = []
    const store = makeTestStore({
      conversations: [
        conv(1, '/root/code/helm'),
        conv(2, '/root/code/.helmx-worktrees/helm-bbcc88d1', { parentConversationId: 1 }),
        conv(3, '/root/code/helm', { parentConversationId: 1 }),
        conv(99, '/root/code/.helmx-worktrees/helm-other'),
      ],
    })
    spyActiveModal(store, opened)

    const md = [
      '- [conversations.ts:137](/root/code/.helmx-worktrees/helm-bbcc88d1/packages/cli/src/commands/conversations.ts:137)',
      '- [other.ts:12](/root/code/.helmx-worktrees/helm-other/src/other.ts:12)',
    ].join('\n')

    resetBody()
    const fromParent = mount(
      e(HostStoreProviders, { value: store }, e(MarkdownView, { text: md, conversationId: 1 })),
    )
    try {
      const chips = [...fromParent.host.querySelectorAll<HTMLButtonElement>('button.attachment-chip')]
      assert.equal(chips.length, 1, 'only same-tree worktree link renders as attachment-chip')
      assert.match(chips[0]!.textContent ?? '', /conversations\.ts:137/)

      const unrelated = fromParent.host.querySelector<HTMLAnchorElement>('a[href*="helm-other"]')
      assert.ok(unrelated !== null, 'unrelated tree link stays a plain <a>')

      await act(async () => {
        chips[0]!.click()
      })
      assert.deepEqual(opened, [
        {
          kind: 'workspace-file',
          conversationId: 2,
          path: 'packages/cli/src/commands/conversations.ts',
          startLine: 137,
        },
      ])
    } finally {
      fromParent.unmount()
      resetBody()
    }

    opened.length = 0
    const fromReviewer = mount(
      e(HostStoreProviders, { value: store }, e(MarkdownView, { text: md, conversationId: 3 })),
    )
    try {
      const chips = [...fromReviewer.host.querySelectorAll<HTMLButtonElement>('button.attachment-chip')]
      assert.equal(chips.length, 1)
      await act(async () => {
        chips[0]!.click()
      })
      assert.deepEqual(opened, [
        {
          kind: 'workspace-file',
          conversationId: 2,
          path: 'packages/cli/src/commands/conversations.ts',
          startLine: 137,
        },
      ])
    } finally {
      fromReviewer.unmount()
      resetBody()
    }
  })

  test('supports className merging on single .msg-ai-body root and onLinkClick for hash links without target=_blank', { timeout: 60_000 }, async () => {
    const store = makeTestStore({
      conversations: [conv(1, '/root/code/helm')],
    })
    const clicked: Array<{ href: string; defaultPrevented: boolean }> = []

    resetBody()
    const mounted = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(MarkdownView, {
          text: 'See [#7](#swarm-post-7) and [Docs](https://example.com)',
          conversationId: 1,
          className: 'sw-panel-post-text',
          onLinkClick: (href, ev) => {
            if (href === '#swarm-post-7') ev.preventDefault()
            clicked.push({ href, defaultPrevented: ev.defaultPrevented })
          },
        }),
      ),
    )

    try {
      const roots = [...mounted.host.querySelectorAll('.msg-ai-body')]
      assert.equal(roots.length, 1, 'single .msg-ai-body root with zero nested wrappers')
      assert.ok(roots[0]!.classList.contains('sw-panel-post-text'), 'className merged onto .msg-ai-body root')

      const hashAnchor = mounted.host.querySelector<HTMLAnchorElement>('a[href="#swarm-post-7"]')
      assert.ok(hashAnchor !== null)
      assert.equal(hashAnchor.getAttribute('target'), null, 'hash-only anchor omits target=_blank')
      assert.equal(hashAnchor.getAttribute('rel'), null, 'hash-only anchor omits rel')

      const extAnchor = mounted.host.querySelector<HTMLAnchorElement>('a[href="https://example.com"]')
      assert.ok(extAnchor !== null)
      assert.equal(extAnchor.getAttribute('target'), '_blank')

      await act(async () => {
        hashAnchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      assert.deepEqual(clicked, [{ href: '#swarm-post-7', defaultPrevented: true }])
    } finally {
      mounted.unmount()
      resetBody()
    }
  })

  test('isolates MarkdownView from status/updatedAt churn while refreshing on workspace topology changes', { timeout: 60_000 }, async () => {
    const opened: ActiveModal[] = []
    const store = makeTestStore({
      conversations: [
        conv(1, '/root/code/helm'),
        conv(2, '/root/code/.helmx-worktrees/helm-bbcc88d1', { parentConversationId: 1 }),
      ],
    })
    spyActiveModal(store, opened)

    let renderCount = 0
    const text = 'New child link [foo.ts:9](/root/code/.helmx-worktrees/helm-new4/src/foo.ts:9)'

    resetBody()
    const mounted = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(
          React.Profiler,
          {
            id: 'md-isolation',
            onRender: () => {
              renderCount += 1
            },
          },
          e(MarkdownView, { text, conversationId: 1 }),
        ),
      ),
    )

    try {
      assert.equal(renderCount, 1)
      assert.equal(mounted.host.querySelectorAll('button.attachment-chip').length, 0)

      // High-frequency status / updatedAt updates on child #2 must NOT re-render MarkdownView for #1.
      await act(async () => {
        store.updateLive((prev) => ({
          ...prev,
          conversations: prev.conversations.map((c) =>
            c.id === 2 ? ({ ...c, status: 'working', updatedAt: 999_999 } as unknown as ConversationSummary) : c,
          ),
        }))
      })
      assert.equal(renderCount, 1, 'status/updatedAt update does not trigger MarkdownView re-render')

      // Adding child #4 with a new worktree cwd DOES update workspaceTopology and enable the preview chip.
      await act(async () => {
        store.updateLive((prev) => ({
          ...prev,
          conversations: [
            ...prev.conversations,
            conv(4, '/root/code/.helmx-worktrees/helm-new4', { parentConversationId: 1 }),
          ],
        }))
      })
      assert.equal(renderCount, 2, 'topology addition triggers MarkdownView re-render')

      const chip = mounted.host.querySelector<HTMLButtonElement>('button.attachment-chip')
      assert.ok(chip !== null, 'new child worktree link becomes clickable attachment-chip')
      await act(async () => {
        chip.click()
      })
      assert.deepEqual(opened, [
        { kind: 'workspace-file', conversationId: 4, path: 'src/foo.ts', startLine: 9 },
      ])
    } finally {
      mounted.unmount()
      resetBody()
    }
  })

  test('renders colon line ranges, file:// URLs, and Windows backslash links as workspace chips while blocking outside/unsafe links', { timeout: 60_000 }, async () => {
    const opened: ActiveModal[] = []
    const store = makeTestStore({
      conversations: [conv(21, '/repo'), conv(22, 'C:\\repo')],
    })
    spyActiveModal(store, opened)

    resetBody()
    const posixMount = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(MarkdownView, {
          text: '[CHANGELOG.md](CHANGELOG.md:3) · [v0.6.0](CHANGELOG.md:3-74) · [FileUrl](file:///repo/CHANGELOG.md:3)',
          conversationId: 21,
        }),
      ),
    )
    try {
      const chips = [...posixMount.host.querySelectorAll<HTMLButtonElement>('button.attachment-chip')]
      assert.equal(chips.length, 3)
      assert.ok(posixMount.host.querySelector('a') === null, 'all resolved links render as chips without <a>')
      for (const chip of chips) {
        await act(async () => {
          chip.click()
        })
      }
      assert.deepEqual(opened, [
        { kind: 'workspace-file', conversationId: 21, path: 'CHANGELOG.md', startLine: 3 },
        { kind: 'workspace-file', conversationId: 21, path: 'CHANGELOG.md', startLine: 3, endLine: 74 },
        { kind: 'workspace-file', conversationId: 21, path: 'CHANGELOG.md', startLine: 3 },
      ])
    } finally {
      posixMount.unmount()
      resetBody()
    }

    opened.length = 0
    const winMount = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(MarkdownView, {
          text: String.raw`[WinBackslash](C:\repo\src\app.ts:7) · [WinOutside](C:\secret.txt)`,
          conversationId: 22,
        }),
      ),
    )
    try {
      const chips = [...winMount.host.querySelectorAll<HTMLButtonElement>('button.attachment-chip')]
      assert.equal(chips.length, 1)
      assert.match(chips[0]!.textContent ?? '', /WinBackslash/)
      const disallowed = winMount.host.querySelector('.msg-md-disallowed-file')
      assert.ok(disallowed !== null, 'outside Windows backslash link renders disallowed span')
      assert.equal(disallowed.textContent, 'WinOutside')
      assert.ok(winMount.host.querySelector('a') === null, 'no <a> rendered for Windows local paths')

      await act(async () => {
        chips[0]!.click()
      })
      assert.deepEqual(opened, [
        { kind: 'workspace-file', conversationId: 22, path: 'src/app.ts', startLine: 7 },
      ])
    } finally {
      winMount.unmount()
      resetBody()
    }
  })

  test('degrades unresolved colon links, bare port hosts, unsafe schemes, and unsafe images to inert spans/chips with zero <a> or <img>', { timeout: 60_000 }, () => {
    const store = makeTestStore({
      conversations: [conv(23, '/repo')],
    })

    resetBody()
    const noConvMount = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(MarkdownView, {
          text: 'See [CHANGELOG.md](CHANGELOG.md:3)',
        }),
      ),
    )
    try {
      assert.ok(noConvMount.host.querySelector('a') === null, 'missing conversationId must not emit <a> for CHANGELOG.md:3')
      assert.ok(noConvMount.host.querySelector('button.attachment-chip') === null)
      const fallbackSpan = [...noConvMount.host.querySelectorAll('span')].find(
        (el) => el.textContent === 'CHANGELOG.md',
      )
      assert.ok(fallbackSpan !== undefined, 'degrades to ordinary <span>')
    } finally {
      noConvMount.unmount()
      resetBody()
    }

    const withConvMount = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(MarkdownView, {
          text: '[Port](EXAMPLE.ORG:8443) · [Js](javascript:alert(1)) · [Custom](custom:foo) · ![Bad](javascript:alert(1))',
          conversationId: 23,
        }),
      ),
    )
    try {
      assert.ok(withConvMount.host.querySelector('a') === null, 'zero <a> elements rendered')
      assert.ok(withConvMount.host.querySelector('img') === null, 'zero <img> elements rendered')
      for (const label of ['Port', 'Js', 'Custom']) {
        const span = [...withConvMount.host.querySelectorAll('span')].find(
          (el) => el.className === '' && el.textContent === label,
        )
        assert.ok(span !== undefined, `${label} renders as ordinary <span>`)
      }
      const badChip = withConvMount.host.querySelector('span.attachment-chip')
      assert.ok(badChip !== null, 'dangerous image renders as inert .attachment-chip')
      assert.match(badChip.textContent ?? '', /Bad/)
    } finally {
      withConvMount.unmount()
      resetBody()
    }
  })
})

describe('WorkspaceFilePreviewModal', { timeout: 60_000 }, () => {
  test('renders Markdown with workspaceBaseDir so nested relative links resolve recursively', { timeout: 60_000 }, async () => {
    const opened: ActiveModal[] = []
    const origFetch = globalThis.fetch
    const shim = installObjectUrlShim()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('path=docs%2Fguide.md')) {
        return new Response(
          new Blob(['# Guide\n\nSee [API](./api.md#L3) and [Root](../README.md)'], { type: 'text/markdown' }),
          { status: 200 },
        )
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const store = makeTestStore({
      conversations: [conv(3, '/repo')],
    })
    spyActiveModal(store, opened)

    resetBody()
    const mounted = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(WorkspaceFilePreviewModal, {
          conversationId: 3,
          path: 'docs/guide.md',
          onClose: () => {},
          inline: true,
        }),
      ),
    )

    try {
      await flush()
      assert.ok(
        document.querySelector('.helmx-tabs-segmented.helmx-tabs-sm') !== null,
        'Markdown preview mode switcher uses sm SegmentedControl',
      )
      const chips = [...document.querySelectorAll<HTMLButtonElement>('button.attachment-chip')]
      const apiChip = chips.find((c) => (c.textContent ?? '').includes('API'))
      const rootChip = chips.find((c) => (c.textContent ?? '').includes('Root'))
      assert.ok(apiChip !== undefined, 'nested ./api.md chip rendered')
      assert.ok(rootChip !== undefined, 'nested ../README.md chip rendered')

      await act(async () => {
        apiChip.click()
      })
      await act(async () => {
        rootChip.click()
      })
      assert.deepEqual(opened, [
        { kind: 'workspace-file', conversationId: 3, path: 'docs/api.md', startLine: 3 },
        { kind: 'workspace-file', conversationId: 3, path: 'README.md' },
      ])
    } finally {
      mounted.unmount()
      assert.equal(shim.active().length, 0)
      shim.restore()
      globalThis.fetch = origFetch
      resetBody()
    }
  })

  test('renders code file with octet-stream mime fallback and highlights target line range', { timeout: 60_000 }, async () => {
    const origFetch = globalThis.fetch
    const shim = installObjectUrlShim()
    globalThis.fetch = (async () =>
      new Response(
        new Blob(['line 1\nline 2\nline 3\nline 4\n'], { type: 'application/octet-stream' }),
        { status: 200 },
      )) as typeof fetch

    const store = makeTestStore({ conversations: [conv(8, '/repo')] })
    resetBody()
    const mounted = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(WorkspaceFilePreviewModal, {
          conversationId: 8,
          path: 'src/index.ts',
          startLine: 2,
          endLine: 3,
          onClose: () => {},
          inline: true,
        }),
      ),
    )

    try {
      await flush()
      const rows = [...document.querySelectorAll<HTMLElement>('.code-line')]
      assert.equal(rows.length, 4)
      assert.equal(rows[0]!.dataset.highlighted, undefined)
      assert.equal(rows[1]!.dataset.highlighted, 'true')
      assert.equal(rows[2]!.dataset.highlighted, 'true')
      assert.equal(rows[3]!.dataset.highlighted, undefined)
      assert.match(document.body.textContent ?? '', /L2-3/)
    } finally {
      mounted.unmount()
      shim.restore()
      globalThis.fetch = origFetch
      resetBody()
    }
  })

  test('renders explicit error callout when file fetch fails', { timeout: 60_000 }, async () => {
    const origFetch = globalThis.fetch
    const shim = installObjectUrlShim()
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: 'not_found', message: 'File missing' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch

    const store = makeTestStore({ conversations: [conv(8, '/repo')] })
    resetBody()
    const mounted = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(WorkspaceFilePreviewModal, {
          conversationId: 8,
          path: 'missing.txt',
          onClose: () => {},
          inline: true,
        }),
      ),
    )

    try {
      await flush()
      const errCallout = document.querySelector('.callout-error')
      assert.ok(errCallout !== null, 'error callout rendered')
      assert.match(errCallout.textContent ?? '', /File missing/)
    } finally {
      mounted.unmount()
      shim.restore()
      globalThis.fetch = origFetch
      resetBody()
    }
  })

  test('Escape closes a nested outline popover first without closing PreviewModalShell', { timeout: 60_000 }, async () => {
    const origFetch = globalThis.fetch
    const shim = installObjectUrlShim()
    globalThis.fetch = (async () =>
      new Response('# Title\n\n## Section A\n\nBody text\n', {
        status: 200,
        headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      })) as typeof fetch

    let closeCalls = 0
    const store = makeTestStore({ conversations: [conv(8, '/repo')] })
    resetBody()
    const mounted = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(WorkspaceFilePreviewModal, {
          conversationId: 8,
          path: 'docs/guide.md',
          onClose: () => { closeCalls += 1 },
          inline: true,
        }),
      ),
    )

    try {
      await flush()
      const outlineBtn = document.querySelector<HTMLButtonElement>('button[aria-label*="Markdown outline"]')
      assert.ok(outlineBtn !== null, 'markdown outline trigger rendered')
      await act(async () => {
        outlineBtn!.click()
      })
      await flush()
      assert.ok(document.querySelector('.conversation-outline-popover') !== null, 'outline popover opened')

      // First Escape closes only the outline popover; PreviewModalShell stays open
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      })
      await flush()
      assert.equal(closeCalls, 0, 'first Escape must not dismiss PreviewModalShell while nested popover is open')

      // Second Escape closes PreviewModalShell itself
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      })
      await flush()
      assert.equal(closeCalls, 1, 'second Escape closes PreviewModalShell')
    } finally {
      mounted.unmount()
      shim.restore()
      globalThis.fetch = origFetch
      resetBody()
    }
  })

  test('defaults CHANGELOG.md with startLine=3 to source mode with L3 badge and line 3 highlight, then switches cleanly to rich view', { timeout: 60_000 }, async () => {
    const origFetch = globalThis.fetch
    const shim = installObjectUrlShim()
    globalThis.fetch = (async () =>
      new Response('# Changelog\n\n## v0.6.0\n\nRelease notes.\n', {
        status: 200,
        headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      })) as typeof fetch

    const store = makeTestStore({ conversations: [conv(8, '/repo')] })
    resetBody()
    const mounted = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(WorkspaceFilePreviewModal, {
          conversationId: 8,
          path: 'CHANGELOG.md',
          startLine: 3,
          onClose: () => {},
          inline: true,
        }),
      ),
    )

    try {
      await flush()
      assert.ok(document.querySelector('.preview-modal-code') !== null, 'defaults to source view when startLine is provided')
      assert.ok(document.querySelector('.artifact-markdown-preview') === null)
      assert.match(document.body.textContent ?? '', /L3/)

      const line3 = document.querySelector<HTMLElement>('.code-line[data-line="3"]')
      const line1 = document.querySelector<HTMLElement>('.code-line[data-line="1"]')
      assert.ok(line3 !== null)
      assert.equal(line3.getAttribute('data-highlighted'), 'true')
      assert.equal(line1?.getAttribute('data-highlighted') ?? null, null)

      const richTab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((el) =>
        el.textContent?.includes('Rich text'),
      )
      assert.ok(richTab !== undefined, 'Rich text tab rendered')
      await act(async () => {
        richTab.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
        richTab.click()
      })
      await flush()

      assert.ok(document.querySelector('.artifact-markdown-preview') !== null, 'switches to rich Markdown preview')
      assert.ok(document.querySelector('.preview-modal-code') === null)
      assert.equal(document.querySelector('.artifact-markdown-preview h2')?.textContent, 'v0.6.0')
    } finally {
      mounted.unmount()
      shim.restore()
      globalThis.fetch = origFetch
      resetBody()
    }
  })
})
