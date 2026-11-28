/**
 * Shared App/SSE fetch harness for shortcut DOM integration tests (`helmx-store-shortcuts*.test.tsx`).
 */
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { ConversationSummary, PluginSummary, PluginUiContribution, Profile } from '@helmx/protocol'
import { hangingEventStream, type SseFrameSender } from './sse-stream.js'
import { waitForCondition } from './dom-harness.js'
import { isApplePlatform, SIDEBAR_COLLAPSED_STORAGE_KEY } from '../../src/shell/shortcuts-model.js'
import { resetStandbyDrafts } from '../../src/conversation/standby-model.js'
import type { HelmxStoreValue } from '../../src/lib/types.js'

export interface FetchHarnessOptions {
  authenticated?: boolean
  conversations?: ConversationSummary[]
  profiles?: Profile[]
  plugins?: PluginSummary[]
  ui?: PluginUiContribution[]
}

export function makeShortcutConversation(
  id: number,
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id,
    title: `测试会话 ${id}`,
    profileId: 'assistant',
    tags: [],
    ownedBy: 'human',
    cwd: '/tmp',
    model: 'faux/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: id,
    updatedAt: id,
    ...overrides,
  }
}

export function dispatchWindowKey(
  init: KeyboardEventInit & { key: string },
  target: EventTarget = window,
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

export function modInit(key: string): KeyboardEventInit & { key: string } {
  return isApplePlatform() ? { key, metaKey: true } : { key, ctrlKey: true }
}

export function createShortcutsAppHarness(
  createRootFn: (container: Element) => Root,
  AppComponent: React.ComponentType,
) {
  const originalFetch = globalThis.fetch
  let root: Root | undefined
  let host: HTMLElement | undefined
  let sendEvent: SseFrameSender | undefined
  let abortCalls: number[] = []
  let artifactRequests: number[] = []

  function installFetch(options: FetchHarnessOptions = {}): void {
    const authenticated = options.authenticated ?? true
    const conversations = options.conversations ?? [
      makeShortcutConversation(1, { status: 'idle', title: '主屏会话' }),
      makeShortcutConversation(2, { status: 'working', title: '分屏会话' }),
    ]
    const profiles = options.profiles ?? [{ id: 'assistant', name: 'Assistant' }]
    const plugins = options.plugins ?? []
    const ui = options.ui ?? []

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/api/auth/status') {
        return new Response(JSON.stringify({ configured: true, authenticated }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === '/api/profiles' && method === 'GET') {
        return new Response(JSON.stringify(profiles), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === '/api/models' && method === 'GET') {
        return new Response(
          JSON.stringify({
            models: [
              {
                id: 'faux/model',
                provider: 'faux',
                modelId: 'model',
                available: true,
                thinkingLevels: ['off', 'high'],
              },
            ],
            thinkingLevels: ['off', 'high'],
            defaultModel: 'faux/model',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }
      if (url === '/api/nodes' && method === 'GET') {
        return new Response(
          JSON.stringify([{ id: 'local', kind: 'local', online: true }]),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }
      if (url === '/api/events') {
        return new Response(
          hangingEventStream(
            (send) => {
              sendEvent = send
              send(
                new TextEncoder().encode(
                  `event: snapshot\ndata: ${JSON.stringify({
                    bootId: 'shortcuts-test-boot',
                    seq: 1,
                    conversations,
                    pendingAsks: [],
                    plugins,
                    ui,
                  })}\n\n`,
                ),
              )
            },
            {
              signal: init?.signal,
              onTeardown: () => {
                sendEvent = undefined
              },
            },
          ),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      const abortMatch = /^\/api\/conversations\/(\d+)\/abort$/.exec(url)
      if (abortMatch && method === 'POST') {
        const id = Number(abortMatch[1])
        abortCalls.push(id)
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      const artifactsMatch = /^\/api\/conversations\/(\d+)\/artifacts$/.exec(url)
      if (artifactsMatch && method === 'GET') {
        const id = Number(artifactsMatch[1])
        artifactRequests.push(id)
        return new Response(
          JSON.stringify([
            {
              id: `art-${id}`,
              conversationId: id,
              name: id === 2 ? 'split-artifact.md' : 'primary-artifact.md',
              mimeType: 'text/markdown',
              size: 128,
              createdAt: id,
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      const detailMatch = /^\/api\/conversations\/(\d+)(?:\?|$)/.exec(url)
      if (detailMatch && method === 'GET') {
        const id = Number(detailMatch[1])
        const found = conversations.find((c) => c.id === id) ?? makeShortcutConversation(id)
        return new Response(JSON.stringify({ ...found, entries: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (method === 'GET') {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
  }

  async function mountApp(
    hash: string,
    readyPred: () => boolean,
    options: FetchHarnessOptions = {},
  ): Promise<void> {
    window.history.replaceState(null, '', hash)
    installFetch(options)
    host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRootFn(host!)
      root.render(React.createElement(AppComponent))
    })
    await waitForCondition(() => host?.querySelector('.helmx-shell') !== null && readyPred())
  }

  function cleanup(): void {
    if (root !== undefined) {
      act(() => root?.unmount())
    }
    root = undefined
    host?.remove()
    host = undefined
    document.body.innerHTML = ''
    window.history.replaceState(null, '', '/')
    globalThis.fetch = originalFetch
    sendEvent = undefined
    abortCalls = []
    artifactRequests = []
    resetStandbyDrafts()
    window.localStorage.removeItem(SIDEBAR_COLLAPSED_STORAGE_KEY)
  }

  return {
    getHost: () => host,
    getSendEvent: () => sendEvent,
    getAbortCalls: () => abortCalls,
    getArtifactRequests: () => artifactRequests,
    installFetch,
    mountApp,
    cleanup,
    setRoot: (r: Root | undefined) => {
      root = r
    },
    setHost: (h: HTMLElement | undefined) => {
      host = h
    },
  }
}

export type ShortcutsCapturedStore = HelmxStoreValue | undefined
