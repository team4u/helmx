import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { ConversationSummary, Profile } from '@helmx/protocol'
import { jsonResponse } from '@helmx/test-kit'
import type { ModelDescriptor } from '../../src/lib/api.js'
import { resetCompletionQueryDebounceMs } from '../../src/conversation/composer-completion-model.js'
import { resetStandbyDrafts, standbyDraftKey } from '../../src/conversation/standby-model.js'
import type { HelmxExternalStore } from '../../src/lib/helmx-store.js'
import { resetPluginClientCache } from '../../src/lib/plugin-client.js'
import type { ResolvedTarget } from '../../src/lib/types.js'
import { flushMicrotasks, resetHappyDom, typeIntoControl, waitForCondition } from './dom-harness.js'
import { hangingEventStream, type SseFrameSender } from './sse-stream.js'
import { makeTestStore, type TestStoreOverrides } from './store.js'

const e = React.createElement

export interface Gate {
  promise: Promise<void>
  resolve: () => void
}

export function makeGate(): Gate {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

export function summary(id: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title: `会话 ${id}`,
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

export const initialConversations = [
  summary(1),
  summary(3, { nodeId: 'remote-1', cwd: '/remote/work' }),
]

export const DEFAULT_STANDBY_PROFILES = [
  {
    id: 'assistant',
    name: '个人助理',
    starters: [{ label: '打个招呼', prompt: 'say hi' }],
  },
  { id: 'coder', name: '编码专员' },
  { id: 'singleton', name: '常驻单例', humanSelectable: false },
  { id: 'managed', name: '插件托管角色', managedByPlugin: 'builtin:gone' },
]

export const DEFAULT_MODEL_CATALOG = {
  models: [{ provider: 'faux', modelId: 'glm-4.6', available: true }],
  thinkingLevels: { 'faux/glm-4.6': ['off', 'low', 'high'] },
}

export interface StandbyHarnessState {
  conversations: ConversationSummary[]
  nextId: number
  createCalls: Array<Record<string, unknown>>
  submitCalls: Array<{ id: number; body: Record<string, unknown> }>
  patchCalls: Array<{ id: number; body: Record<string, unknown> }>
  uploadCalls: Array<{ id: number; name: string }>
  uploadStarted: boolean
  createGate: Gate | undefined
  submitGate: Gate | undefined
  uploadGate: Gate | undefined
  assetsGate: Gate | undefined
  actionGate: Gate | undefined
  createFailures: number
  submitFailures: number
  uploadFailures: number
  profilesFail: boolean
  resetCalls: number[]
  profiles: Array<Record<string, unknown>> | undefined
  skills: Array<Record<string, unknown>>
  plugins: Array<Record<string, unknown>>
  ui: Array<Record<string, unknown>>
  actions: Array<Record<string, unknown>>
  docs: Record<string, unknown>
  actionCalls: Array<{ pluginId: string; actionId: string; body: Record<string, unknown> }>
  actionResponse: ((pluginId: string, actionId: string, body: Record<string, unknown>) => unknown) | undefined
  actionError: string | undefined
  modelsOverride:
    | {
        models: Array<{ provider: string; modelId: string; available: boolean }>
        thinkingLevels: Record<string, string[]>
      }
    | undefined
}

export const standbyState: StandbyHarnessState = {
  conversations: [...initialConversations],
  nextId: 9,
  createCalls: [],
  submitCalls: [],
  patchCalls: [],
  uploadCalls: [],
  uploadStarted: false,
  createGate: undefined,
  submitGate: undefined,
  uploadGate: undefined,
  assetsGate: undefined,
  actionGate: undefined,
  createFailures: 0,
  submitFailures: 0,
  uploadFailures: 0,
  profilesFail: false,
  resetCalls: [],
  profiles: undefined,
  skills: [],
  plugins: [],
  ui: [],
  actions: [],
  docs: {},
  actionCalls: [],
  actionResponse: undefined,
  actionError: undefined,
  modelsOverride: undefined,
}

export function eventFrame(seq: number, event: unknown): Uint8Array {
  return new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ seq, event })}\n\n`)
}

const originalFetch = globalThis.fetch
let eventSeq = 1
let sendEvent: SseFrameSender | undefined
let activeRoot: Root | undefined
let activeHost: HTMLElement | undefined
let activeStore: HelmxExternalStore | undefined

export function sendStandbySseEvent(event: unknown): void {
  sendEvent?.(eventFrame(++eventSeq, event))
}

export function installStandbyFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === '/api/auth/status') {
      return jsonResponse({ configured: true, authenticated: true })
    }
    if (url === '/api/events') {
      return new Response(
        hangingEventStream(
          (send) => {
            sendEvent = send
            send(
              new TextEncoder().encode(
                `event: snapshot\ndata: ${JSON.stringify({
                  bootId: 'test-boot',
                  seq: eventSeq,
                  conversations: standbyState.conversations,
                  pendingAsks: [],
                  plugins: standbyState.plugins,
                  ui: standbyState.ui,
                  nodes: [
                    { id: 'local', name: '本机', online: true },
                    { id: 'remote-1', name: '远端一', online: true },
                  ],
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
    if (url === '/api/profiles' && method === 'GET') {
      if (standbyState.assetsGate !== undefined) await standbyState.assetsGate.promise
      if (standbyState.profilesFail) {
        return jsonResponse({ error: { code: 'internal_error', message: 'profiles down' } }, 500)
      }
      return jsonResponse(standbyState.profiles ?? DEFAULT_STANDBY_PROFILES)
    }
    if (url === '/api/skills' && method === 'GET') return jsonResponse(standbyState.skills)
    if (url === '/api/actions' && method === 'GET') return jsonResponse(standbyState.actions)
    const docMatch = /^\/api\/plugins\/([^/]+)\/docs\/([^/?]+)$/.exec(url)
    if (docMatch && method === 'GET') {
      const pluginId = decodeURIComponent(docMatch[1]!)
      const name = decodeURIComponent(docMatch[2]!)
      return jsonResponse({ pluginId, name, value: standbyState.docs[`${pluginId}/${name}`] ?? null })
    }
    const actionMatch = /^\/api\/actions\/([^/]+)\/([^/]+)$/.exec(url)
    if (actionMatch && method === 'POST') {
      const pluginId = decodeURIComponent(actionMatch[1]!)
      const actionId = decodeURIComponent(actionMatch[2]!)
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      standbyState.actionCalls.push({ pluginId, actionId, body })
      if (standbyState.actionGate !== undefined) await standbyState.actionGate.promise
      if (standbyState.actionError !== undefined) {
        return jsonResponse({ error: { code: 'action_failed', message: standbyState.actionError } }, 500)
      }
      if (standbyState.actionResponse !== undefined) {
        return jsonResponse(standbyState.actionResponse(pluginId, actionId, body))
      }
      return jsonResponse({ ok: true })
    }
    if (url === '/api/models' && method === 'GET') {
      return jsonResponse(standbyState.modelsOverride ?? DEFAULT_MODEL_CATALOG)
    }
    if (url === '/api/nodes' && method === 'GET') {
      return jsonResponse([
        { id: 'local', name: '本机', online: true },
        { id: 'remote-1', name: '远端一', online: true },
      ])
    }
    if (url === '/api/conversations' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      standbyState.createCalls.push(body)
      if (standbyState.createGate !== undefined) await standbyState.createGate.promise
      if (standbyState.createFailures > 0) {
        standbyState.createFailures--
        return jsonResponse({ error: { code: 'internal_error', message: 'create failed' } }, 500)
      }
      const created = summary(standbyState.nextId++, { profileId: String(body.profileId ?? 'assistant') })
      standbyState.conversations = [created, ...standbyState.conversations]
      sendEvent?.(eventFrame(++eventSeq, { type: 'conversation.upsert', conversation: created }))
      return jsonResponse(created)
    }
    const inputMatch = /^\/api\/conversations\/(\d+)\/input$/.exec(url)
    if (inputMatch && method === 'POST') {
      const id = Number(inputMatch[1])
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      if (standbyState.submitGate !== undefined) await standbyState.submitGate.promise
      standbyState.submitCalls.push({ id, body })
      if (standbyState.submitFailures > 0) {
        standbyState.submitFailures--
        return jsonResponse({ error: { code: 'internal_error', message: 'submit failed' } }, 500)
      }
      return jsonResponse({ submissionId: 'sub-1' })
    }
    const uploadMatch = /^\/api\/conversations\/(\d+)\/artifacts$/.exec(url)
    if (uploadMatch && method === 'POST') {
      const id = Number(uploadMatch[1])
      const name = decodeURIComponent(
        new Headers(init?.headers as HeadersInit | undefined).get('X-Artifact-Filename') ?? 'attachment.bin',
      )
      standbyState.uploadStarted = true
      if (standbyState.uploadGate !== undefined) await standbyState.uploadGate.promise
      standbyState.uploadCalls.push({ id, name })
      if (standbyState.uploadFailures > 0) {
        standbyState.uploadFailures--
        return jsonResponse({ error: { code: 'internal_error', message: 'upload failed' } }, 500)
      }
      return jsonResponse({
        id: `art-${standbyState.uploadCalls.length}`,
        conversationId: id,
        kind: 'upload',
        name,
        path: `artifacts/${id}/${name}`,
        size: 5,
        mimeType: 'text/plain',
        createdAt: 0,
      })
    }
    const resetMatch = /^\/api\/conversations\/(\d+)\/reset$/.exec(url)
    if (resetMatch && method === 'POST') {
      standbyState.resetCalls.push(Number(resetMatch[1]))
      return jsonResponse(standbyState.conversations.find((c) => c.id === Number(resetMatch[1])) ?? summary(1))
    }
    const patchMatch = /^\/api\/conversations\/(\d+)$/.exec(url)
    if (patchMatch && method === 'PATCH') {
      const id = Number(patchMatch[1])
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      standbyState.patchCalls.push({ id, body })
      return jsonResponse(standbyState.conversations.find((c) => c.id === id) ?? summary(id))
    }
    const detailMatch = /^\/api\/conversations\/(\d+)/.exec(url)
    if (detailMatch && method === 'GET') {
      const id = Number(detailMatch[1])
      const found = standbyState.conversations.find((item) => item.id === id)
      return jsonResponse({ ...(found ?? summary(id)), entries: [] })
    }
    if (method === 'GET') return jsonResponse([])
    return jsonResponse({})
  }) as typeof fetch
}

export function resetStandbyHarnessState(): void {
  standbyState.conversations = [...initialConversations]
  standbyState.nextId = 9
  standbyState.createCalls = []
  standbyState.submitCalls = []
  standbyState.patchCalls = []
  standbyState.uploadCalls = []
  standbyState.uploadStarted = false
  standbyState.resetCalls = []
  standbyState.createGate = undefined
  standbyState.submitGate = undefined
  standbyState.uploadGate = undefined
  standbyState.assetsGate = undefined
  standbyState.actionGate = undefined
  standbyState.createFailures = 0
  standbyState.submitFailures = 0
  standbyState.uploadFailures = 0
  standbyState.profilesFail = false
  standbyState.profiles = undefined
  standbyState.skills = []
  standbyState.plugins = []
  standbyState.ui = []
  standbyState.actions = []
  standbyState.docs = {}
  standbyState.actionCalls = []
  standbyState.actionResponse = undefined
  standbyState.actionError = undefined
  standbyState.modelsOverride = undefined
}

export function resetStandbyHarness(clearPluginCache = false): void {
  if (activeRoot !== undefined) act(() => activeRoot?.unmount())
  activeRoot = undefined
  activeHost?.remove()
  activeHost = undefined
  activeStore?.dispose()
  activeStore = undefined
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/')
  globalThis.fetch = originalFetch
  sendEvent = undefined
  eventSeq = 1
  resetStandbyHarnessState()
  resetStandbyDrafts()
  resetCompletionQueryDebounceMs()
  if (clearPluginCache) resetPluginClientCache()
  resetHappyDom()
}

export async function mountStandbyApp(hash: string): Promise<void> {
  const [{ createRoot }, { App }] = await Promise.all([
    import('react-dom/client'),
    import('../../src/App.js'),
  ])
  window.history.replaceState(null, '', hash)
  activeHost = document.createElement('div')
  document.body.appendChild(activeHost)
  installStandbyFetch()
  await act(async () => {
    activeRoot = createRoot(activeHost!)
    activeRoot.render(e(App))
  })
  await waitForCondition(
    () =>
      document.querySelector('.helmx-shell') !== null &&
      document.querySelector('.connection-banner') === null &&
      (standbyState.profilesFail || !document.body.textContent?.includes('Loading profile info')),
  )
  await flushMicrotasks()
}

function toModelDescriptors(catalog: NonNullable<StandbyHarnessState['modelsOverride']>): ModelDescriptor[] {
  return catalog.models.map((m) => ({
    id: `${m.provider}/${m.modelId}`,
    provider: m.provider,
    modelId: m.modelId,
    available: m.available,
    thinkingLevels: catalog.thinkingLevels[`${m.provider}/${m.modelId}`] ?? ['off'],
  }))
}

export async function mountStandbyPane(
  primaryTarget: ResolvedTarget = { kind: 'agent', profileId: 'assistant' },
  overrides: TestStoreOverrides = {},
): Promise<HelmxExternalStore> {
  const [
    { createRoot },
    { AgentStandbyPane },
    { HostStoreProviders },
    { usePrimaryTarget, useSplitTarget },
  ] = await Promise.all([
    import('react-dom/client'),
    import('../../src/conversation/AgentStandbyPane.js'),
    import('./host-store.js'),
    import('../../src/lib/store-context.js'),
  ])
  installStandbyFetch()
  const catalog = standbyState.modelsOverride ?? DEFAULT_MODEL_CATALOG
  const store = makeTestStore({
    profiles: (standbyState.profiles ?? DEFAULT_STANDBY_PROFILES) as unknown as Profile[],
    models: toModelDescriptors(catalog),
    skills: standbyState.skills as unknown as TestStoreOverrides['skills'],
    plugins: standbyState.plugins as unknown as TestStoreOverrides['plugins'],
    uiContributions: standbyState.ui as unknown as TestStoreOverrides['uiContributions'],
    actions: standbyState.actions as unknown as TestStoreOverrides['actions'],
    pluginDocs: Object.fromEntries(
      Object.entries(standbyState.docs).map(([k, v]) => [k, v]),
    ),
    nodes: [
      { id: 'local', kind: 'local', online: true },
      { id: 'remote-1', kind: 'byom', online: true },
    ],
    conversations: standbyState.conversations,
    primaryTarget,
    focusedPanel: 'primary',
    ...overrides,
  })
  activeStore = store

  function StandbyPaneTestHost(): React.ReactNode {
    const primary = usePrimaryTarget()
    const split = useSplitTarget()
    return e(
      'div',
      { className: 'helmx-shell' },
      primary.kind === 'agent'
        ? e(
            'div',
            { 'data-helmx-panel': 'primary' },
            e(AgentStandbyPane, {
              key: standbyDraftKey({ panel: 'primary', ...primary }),
              profileId: primary.profileId,
              nodeId: primary.nodeId,
              cwd: primary.cwd,
            }),
          )
        : null,
      split?.kind === 'agent'
        ? e(
            'div',
            { className: 'helmx-split-pane', 'data-helmx-panel': 'split' },
            e(AgentStandbyPane, {
              key: standbyDraftKey({ panel: 'split', ...split }),
              profileId: split.profileId,
              nodeId: split.nodeId,
              cwd: split.cwd,
              isSplit: true,
            }),
          )
        : null,
    )
  }

  activeHost = document.createElement('div')
  document.body.appendChild(activeHost)
  await act(async () => {
    activeRoot = createRoot(activeHost!)
    activeRoot.render(e(HostStoreProviders, { value: store }, e(StandbyPaneTestHost)))
  })
  await flushMicrotasks()
  return store
}

export async function settle(): Promise<void> {
  await flushMicrotasks()
}

export const MAIN_LABEL = 'Type the first message to 个人助理'
export const typeInto = typeIntoControl

export function textarea(label: string): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)
  if (!el) {
    throw new Error(`the input must exist: ${label}`)
  }
  return el
}

export function pressEnter(el: HTMLTextAreaElement): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
}

export function dropFiles(el: HTMLElement, files: File[]): void {
  const ev = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'dataTransfer', { value: { files } })
  el.dispatchEvent(ev)
}

export function clickButton(selector: string, container: ParentNode = document): void {
  const btn = container.querySelector<HTMLButtonElement>(selector)
  if (!btn) {
    throw new Error(`the button must exist: ${selector}`)
  }
  act(() => {
    btn.click()
  })
}

export function hasNotice(store: HelmxExternalStore, text: string): boolean {
  return store.getNotices().some((n) => n.title.includes(text) || (n.body ?? '').includes(text))
}
