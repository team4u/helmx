import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { ConversationSummary } from '@helmx/protocol'
import { resetOverviewSearchDebounceMs } from '../../src/overview/overview-timing.js'
import { flushMicrotasks, resetHappyDom } from './dom-harness.js'
import { makeTestStore, type TestStoreOverrides } from './store.js'
import type { HelmxExternalStore } from '../../src/lib/helmx-store.js'

const e = React.createElement

export const BASE_PROFILES = [
  { id: 'assistant', name: '个人助理' },
  { id: 'coder', name: '编码专员' },
]

const createdStores: HelmxExternalStore[] = []

export function disposeOverviewTestEnv(): void {
  while (createdStores.length > 0) {
    createdStores.pop()!.dispose()
  }
  resetOverviewSearchDebounceMs()
  resetHappyDom()
}

export function conv(partial: Partial<ConversationSummary> & { id: number }): ConversationSummary {
  return {
    title: `会话 ${partial.id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'zhipu/glm-4.6',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 1,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: partial.id * 1000,
    updatedAt: partial.id * 1000,
    ...partial,
  }
}

export function overviewStore(overrides: TestStoreOverrides = {}): HelmxExternalStore {
  const store = makeTestStore({ profiles: BASE_PROFILES, ...overrides })
  createdStores.push(store)
  return store
}

export function overviewScenarioStore(): HelmxExternalStore {
  return overviewStore({
    conversations: [
      conv({ id: 1, title: '出错的重构', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 11, parentConversationId: 1, title: '待审批子任务', status: 'blocked', createdAt: 9100, updatedAt: 9200 }),
      conv({ id: 2, title: '在跑的调研', profileId: 'coder', status: 'working', doing: '正在检索文档', createdAt: 8000, updatedAt: 8000 }),
      conv({ id: 3, title: '安静会话', profileId: 'coder', status: 'idle', createdAt: 7000, updatedAt: 7000 }),
    ],
    primaryTarget: { kind: 'overview' },
  })
}

/** 批量场景：常规根 x2 + helmx 托管根（在 source=all 混合视图下验证人机批量边界）。 */
export function batchScenarioStore(): HelmxExternalStore {
  return overviewStore({
    conversations: [
      conv({ id: 1, title: '常规根 A', profileId: 'assistant', createdAt: 9000, updatedAt: 9000 }),
      conv({ id: 2, title: '常规根 B', profileId: 'coder', createdAt: 8000, updatedAt: 8000 }),
      conv({ id: 4, title: 'helmx 会话根', ownedBy: 'helmx', createdAt: 6000, updatedAt: 6000 }),
    ],
    primaryTarget: { kind: 'overview', params: { source: 'all' } },
  })
}

export async function mountOverview(store: HelmxExternalStore): Promise<{
  container: HTMLElement
  unmount: () => Promise<void>
}> {
  const [{ createRoot }, { ConversationOverview }, { HostStoreProviders }] = await Promise.all([
    import('react-dom/client'),
    import('../../src/overview/ConversationOverview.js'),
    import('./host-store.js'),
  ])
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  await act(async () => {
    root = createRoot(container)
    root.render(e(HostStoreProviders, { value: store }, e(ConversationOverview)))
  })
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root?.unmount()
      })
      container.remove()
    },
  }
}

export async function overviewSettle(): Promise<void> {
  await flushMicrotasks()
}

export function cardById(container: HTMLElement, id: number): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('.overview-card')].find((card) =>
    card.textContent?.includes(`#${id}`),
  )
}

/** 总览批量/菜单交互的 fetch 桩：记录会话 PATCH（归档 tag）、单删 DELETE 与 bulk-delete。 */
export function installConversationMutationStub(): {
  patches: Array<{ id: number; tags?: string[] }>
  deletes: number[]
  bulkDeletes: number[][]
  restore: () => void
} {
  const original = globalThis.fetch
  const patches: Array<{ id: number; tags?: string[] }> = []
  const deletes: number[] = []
  const bulkDeletes: number[][] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const match = /^\/api\/conversations\/(\d+)$/.exec(url)
    const method = init?.method ?? 'GET'
    if (match !== null && method === 'PATCH') {
      const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as { tags?: string[] })
      patches.push({ id: Number(match[1]), tags: body.tags })
      return new Response(JSON.stringify({ id: Number(match[1]), tags: body.tags ?? [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (match !== null && method === 'DELETE') {
      deletes.push(Number(match[1]))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (url === '/api/conversations/bulk-delete' && method === 'POST') {
      const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as { ids?: number[] })
      const ids = body.ids ?? []
      bulkDeletes.push(ids)
      return new Response(JSON.stringify({ deleted: ids, failures: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  })
  return { patches, deletes, bulkDeletes, restore: () => { globalThis.fetch = original } }
}
