/**
 * Agent standby pane interaction tests: real HelmxStoreProvider + real App.
 *
 * Covers: deep-link standby without POST, sidebar name/plus new-entry into standby,
 * the first-send chain (create -> submit) with double-click dedupe, create/submit
 * failures preserving drafts for retry reuse, attachments staged locally until send,
 * starters never overwriting a non-empty draft, URL environment inheritance,
 * primary/split draft isolation, switching away mid-send never hijacking navigation,
 * the new-topic button entering standby, and draft -> real conversation replace.
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { describe, afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import {
  COMPOSER_TOOLBAR_SLOT,
  type ComposerToolbarSlotProps,
  type ConversationSummary,
} from '@helmx/protocol'
import { hangingEventStream, type SseFrameSender } from './helpers/sse-stream.js'
import { jsonResponse } from '@helmx/test-kit'
import {
  ensureHappyDom,
  flushMacrotask,
  typeIntoControl,
  waitForCondition,
} from './helpers/dom-harness.js'

ensureHappyDom()
const { createRoot } = await import('react-dom/client')
const { useComposerCommand } = await import('@helmx/plugin-client')
const { App } = await import('../src/App.js')
const { getStandbyDraft, resetStandbyDrafts, standbyDraftKey } = await import('../src/conversation/standby-model.js')
const { resetPluginClientCache, seedPluginClientModule } = await import('../src/lib/plugin-client.js')

const e = React.createElement
const originalFetch = globalThis.fetch
let root: Root | undefined
let host: HTMLElement | undefined

interface Gate {
  promise: Promise<void>
  resolve: () => void
}

function makeGate(): Gate {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

function summary(id: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
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

const initialConversations = [
  summary(1),
  summary(3, { nodeId: 'remote-1', cwd: '/remote/work' }),
]

const state = {
  conversations: [...initialConversations],
  nextId: 9,
  createCalls: [] as Array<Record<string, unknown>>,
  submitCalls: [] as Array<{ id: number; body: Record<string, unknown> }>,
  patchCalls: [] as Array<{ id: number; body: Record<string, unknown> }>,
  uploadCalls: [] as Array<{ id: number; name: string }>,
  uploadStarted: false,
  createGate: undefined as Gate | undefined,
  submitGate: undefined as Gate | undefined,
  uploadGate: undefined as Gate | undefined,
  assetsGate: undefined as Gate | undefined,
  actionGate: undefined as Gate | undefined,
  createFailures: 0,
  submitFailures: 0,
  uploadFailures: 0,
  profilesFail: false,
  resetCalls: [] as number[],
  profiles: undefined as Array<Record<string, unknown>> | undefined,
  skills: [] as Array<Record<string, unknown>>,
  plugins: [] as Array<Record<string, unknown>>,
  ui: [] as Array<Record<string, unknown>>,
  actions: [] as Array<Record<string, unknown>>,
  docs: {} as Record<string, unknown>,
  actionCalls: [] as Array<{ pluginId: string; actionId: string; body: Record<string, unknown> }>,
  actionResponse: undefined as ((pluginId: string, actionId: string, body: Record<string, unknown>) => unknown) | undefined,
  actionError: undefined as string | undefined,
  modelsOverride: undefined as { models: unknown[]; thinkingLevels: Record<string, string[]> } | undefined,
}

function resetState(): void {
  state.conversations = [...initialConversations]
  state.nextId = 9
  state.createCalls = []
  state.submitCalls = []
  state.patchCalls = []
  state.uploadCalls = []
  state.uploadStarted = false
  state.resetCalls = []
  state.createGate = undefined
  state.submitGate = undefined
  state.uploadGate = undefined
  state.assetsGate = undefined
  state.actionGate = undefined
  state.createFailures = 0
  state.submitFailures = 0
  state.uploadFailures = 0
  state.profilesFail = false
  state.profiles = undefined
  state.skills = []
  state.plugins = []
  state.ui = []
  state.actions = []
  state.docs = {}
  state.actionCalls = []
  state.actionResponse = undefined
  state.actionError = undefined
  state.modelsOverride = undefined
}

const profiles = [
  {
    id: 'assistant',
    name: '个人助理',
    starters: [{ label: '打个招呼', prompt: 'say hi' }],
  },
  { id: 'coder', name: '编码专员' },
  { id: 'singleton', name: '常驻单例', humanSelectable: false },
  { id: 'managed', name: '插件托管角色', managedByPlugin: 'builtin:gone' },
]

const modelCatalog = {
  models: [
    { provider: 'faux', modelId: 'glm-4.6', available: true },
  ],
  thinkingLevels: { 'faux/glm-4.6': ['off', 'low', 'high'] },
}

function eventFrame(seq: number, event: unknown): Uint8Array {
  return new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ seq, event })}\n\n`)
}

let eventSeq = 1
/** The currently pending /api/events stream sender: auto-invalidated once the stream ends (abort/cancel). */
let sendEvent: SseFrameSender | undefined

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === '/api/auth/status') {
      return jsonResponse({ configured: true, authenticated: true })
    }
    if (url === '/api/events') {
      return new Response(hangingEventStream((send) => {
        sendEvent = send
        send(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify({
          bootId: 'test-boot',
          seq: eventSeq,
          conversations: state.conversations,
          pendingAsks: [],
          plugins: state.plugins,
          ui: state.ui,
          nodes: [
            { id: 'local', name: '本机', online: true },
            { id: 'remote-1', name: '远端一', online: true },
          ],
        })}\n\n`))
      }, { signal: init?.signal, onTeardown: () => { sendEvent = undefined } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (url === '/api/profiles' && method === 'GET') {
      if (state.assetsGate !== undefined) await state.assetsGate.promise
      if (state.profilesFail) return jsonResponse({ error: { code: 'internal_error', message: 'profiles down' } }, 500)
      return jsonResponse(state.profiles ?? profiles)
    }
    if (url === '/api/skills' && method === 'GET') return jsonResponse(state.skills)
    if (url === '/api/actions' && method === 'GET') return jsonResponse(state.actions)
    const docMatch = /^\/api\/plugins\/([^/]+)\/docs\/([^/?]+)$/.exec(url)
    if (docMatch && method === 'GET') {
      const pluginId = decodeURIComponent(docMatch[1]!)
      const name = decodeURIComponent(docMatch[2]!)
      return jsonResponse({ pluginId, name, value: state.docs[`${pluginId}/${name}`] ?? null })
    }
    const actionMatch = /^\/api\/actions\/([^/]+)\/([^/]+)$/.exec(url)
    if (actionMatch && method === 'POST') {
      const pluginId = decodeURIComponent(actionMatch[1]!)
      const actionId = decodeURIComponent(actionMatch[2]!)
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      state.actionCalls.push({ pluginId, actionId, body })
      if (state.actionGate !== undefined) await state.actionGate.promise
      if (state.actionError !== undefined) {
        return jsonResponse({ error: { code: 'action_failed', message: state.actionError } }, 500)
      }
      if (state.actionResponse !== undefined) {
        return jsonResponse(state.actionResponse(pluginId, actionId, body))
      }
      return jsonResponse({ ok: true })
    }
    if (url === '/api/models' && method === 'GET') return jsonResponse(state.modelsOverride ?? modelCatalog)
    if (url === '/api/nodes' && method === 'GET') {
      return jsonResponse([
        { id: 'local', name: '本机', online: true },
        { id: 'remote-1', name: '远端一', online: true },
      ])
    }
    // create: POST /api/conversations (no id suffix)
    if (url === '/api/conversations' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      state.createCalls.push(body)
      if (state.createGate !== undefined) await state.createGate.promise
      if (state.createFailures > 0) {
        state.createFailures--
        return jsonResponse({ error: { code: 'internal_error', message: 'create failed' } }, 500)
      }
      const created = summary(state.nextId++, { profileId: String(body.profileId ?? 'assistant') })
      state.conversations = [created, ...state.conversations]
      sendEvent?.(eventFrame(++eventSeq, { type: 'conversation.upsert', conversation: created }))
      return jsonResponse(created)
    }
    const inputMatch = /^\/api\/conversations\/(\d+)\/input$/.exec(url)
    if (inputMatch && method === 'POST') {
      const id = Number(inputMatch[1])
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      if (state.submitGate !== undefined) await state.submitGate.promise
      state.submitCalls.push({ id, body })
      if (state.submitFailures > 0) {
        state.submitFailures--
        return jsonResponse({ error: { code: 'internal_error', message: 'submit failed' } }, 500)
      }
      return jsonResponse({ submissionId: 'sub-1' })
    }
    const uploadMatch = /^\/api\/conversations\/(\d+)\/artifacts$/.exec(url)
    if (uploadMatch && method === 'POST') {
      const id = Number(uploadMatch[1])
      const name = decodeURIComponent(new Headers(init?.headers as HeadersInit | undefined).get('X-Artifact-Filename') ?? 'attachment.bin')
      state.uploadStarted = true
      if (state.uploadGate !== undefined) await state.uploadGate.promise
      state.uploadCalls.push({ id, name })
      if (state.uploadFailures > 0) {
        state.uploadFailures--
        return jsonResponse({ error: { code: 'internal_error', message: 'upload failed' } }, 500)
      }
      return jsonResponse({ id: `art-${state.uploadCalls.length}`, conversationId: id, kind: 'upload', name, path: `artifacts/${id}/${name}`, size: 5, mimeType: 'text/plain', createdAt: 0 })
    }
    const resetMatch = /^\/api\/conversations\/(\d+)\/reset$/.exec(url)
    if (resetMatch && method === 'POST') {
      state.resetCalls.push(Number(resetMatch[1]))
      return jsonResponse(state.conversations.find((c) => c.id === Number(resetMatch[1])) ?? summary(1))
    }
    const patchMatch = /^\/api\/conversations\/(\d+)$/.exec(url)
    if (patchMatch && method === 'PATCH') {
      const id = Number(patchMatch[1])
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      state.patchCalls.push({ id, body })
      return jsonResponse(state.conversations.find((c) => c.id === id) ?? summary(id))
    }
    const detailMatch = /^\/api\/conversations\/(\d+)/.exec(url)
    if (detailMatch && method === 'GET') {
      const id = Number(detailMatch[1])
      const found = state.conversations.find((item) => item.id === id)
      return jsonResponse({ ...(found ?? summary(id)), entries: [] })
    }
    if (method === 'GET') return jsonResponse([])
    return jsonResponse({})
  }) as typeof fetch
}

async function mount(hash: string): Promise<void> {
  window.history.replaceState(null, '', hash)
  host = document.createElement('div')
  document.body.appendChild(host)
  installFetch()
  await act(async () => {
    root = createRoot(host!)
    root.render(e(App))
  })
  await waitForCondition(
    () =>
      document.querySelector('.helmx-shell') !== null &&
      document.querySelector('.connection-banner') === null &&
      (state.profilesFail || !document.body.textContent?.includes('Loading profile info')),
  )
  await flushMacrotask(0)
}

async function settle(): Promise<void> {
  await flushMacrotask(0)
}

function reset(): void {
  if (root !== undefined) act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/')
  globalThis.fetch = originalFetch
  sendEvent = undefined
  eventSeq = 1
  resetState()
  resetStandbyDrafts()
  resetPluginClientCache()
}
describe("agent-standby", () => {


  afterEach(reset)

  function textarea(label: string): HTMLTextAreaElement {
    const el = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)
    assert.ok(el, `the input must exist: ${label}`)
    return el
  }

  const MAIN_LABEL = 'Type the first message to 个人助理'

  const typeInto = typeIntoControl

  function pressEnter(el: HTMLTextAreaElement): void {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  }

  function dropFiles(el: HTMLElement, files: File[]): void {
    const ev = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'dataTransfer', { value: { files } })
    el.dispatchEvent(ev)
  }

  function clickButton(selector: string, container: ParentNode = document): void {
    const btn = container.querySelector<HTMLButtonElement>(selector)
    assert.ok(btn, `the button must exist: ${selector}`)
    act(() => { btn.click() })
  }

  // ---------------------------------------------------------------------------

  test('deep-linked standby pane: renders intro and input with zero POST create throughout', { timeout: 60_000 }, async () => {
    await mount('#/a/assistant')
    assert.ok(document.querySelector('.agent-standby-pane'), 'the main stage renders the standby pane')
    assert.ok(document.body.textContent?.includes('Send the first message to start a new topic'), 'shows the start-a-new-topic intro')
    assert.ok(document.body.textContent?.includes('打个招呼'), 'shows the starter')
    assert.ok(textarea(MAIN_LABEL), 'renders the draft input')
    assert.equal(state.createCalls.length, 0, 'visiting the standby pane must not pre-create a conversation')
  })

  test('sidebar new-topic entry: multi-profile dropdown enters standby without pre-creating; standby highlights the new-topic row', { timeout: 60_000 }, async () => {
    await mount('#/c/1')
    const newTopicTrigger = document.querySelector<HTMLButtonElement>('.sidebar-new-topic-btn')
    assert.ok(newTopicTrigger, 'sidebar renders the permanent New topic entry')
    await act(async () => {
      newTopicTrigger!.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    await settle()
    const assistantItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((el) => el.textContent?.includes('个人助理'))
    assert.ok(assistantItem, 'multi-profile dropdown lists the agent candidates')
    await act(async () => { assistantItem!.click() })
    await settle()
    assert.equal(window.location.hash, '#/a/assistant', 'picking an agent enters its standby page')
    assert.ok(document.querySelector('.agent-standby-pane'), 'renders the standby pane')
    assert.ok(document.querySelector('.sidebar-new-topic-btn')?.className.includes('is-active'), 'new-topic entry highlights while on standby')
    assert.equal(state.createCalls.length, 0, 'entering standby must not pre-create a conversation')

    // Navigating to a zero-conversation agent standby keeps the standby pane and new-topic active state intact
    await act(async () => { navigateHash('#/a/coder') })
    await waitForCondition(() => window.location.hash === '#/a/coder')
    assert.ok(document.querySelector('.agent-standby-pane'), 'zero-conversation agent renders standby pane')
    assert.ok(document.querySelector('.sidebar-new-topic-btn')?.className.includes('is-active'), 'new-topic entry stays active on standby')
    assert.equal(state.createCalls.length, 0)
  })

  test('first-send chain: Enter creates and submits, double-click dedupes, success replaces into the real conversation', { timeout: 60_000 }, async () => {
    const pushes: string[] = []
    const replaces: string[] = []
    const originalPush = history.pushState.bind(history)
    const originalReplace = history.replaceState.bind(history)
    history.pushState = ((data: unknown, unused: string, url?: string | URL | null) => {
      pushes.push(String(url))
      return originalPush(data, unused, url)
    }) as typeof history.pushState
    history.replaceState = ((data: unknown, unused: string, url?: string | URL | null) => {
      replaces.push(String(url))
      return originalReplace(data, unused, url)
    }) as typeof history.replaceState
    try {
      state.createGate = makeGate()
      await mount('#/a/assistant')
      const input = textarea(MAIN_LABEL)
      act(() => { typeInto(input, '你好，Start new topic') })
      await act(async () => { pressEnter(input); pressEnter(input) })
      assert.equal(state.createCalls.length, 1, 'double Enter triggers exactly one create (synchronous dedupe)')
      assert.deepEqual(state.createCalls[0], { profileId: 'assistant' }, 'no extra fields without customized environment/model')
      await act(async () => { state.createGate!.resolve() })
      await waitForCondition(() => window.location.hash === '#/c/9' && document.body.textContent?.includes('会话 9') === true)
      assert.equal(state.submitCalls.length, 1, 'submitInput exactly once')
      assert.equal(state.submitCalls[0]!.id, 9)
      assert.equal((state.submitCalls[0]!.body as { text?: string }).text, '你好，Start new topic')
      assert.equal((state.submitCalls[0]!.body as { origin?: string }).origin, 'human')
      assert.equal(window.location.hash, '#/c/9', 'navigates to the real conversation on success')
      assert.equal(replaces[replaces.length - 1], '#/c/9', 'draft -> real conversation uses replace without polluting the back stack')
      assert.ok(document.body.textContent?.includes('会话 9'), 'the real conversation pane renders (HTTP detail fallback, no SSE dependency)')
      assert.ok(document.querySelector(`textarea[aria-label="${MAIN_LABEL}"]`) === null, 'the standby input unmounts')
    } finally {
      history.pushState = originalPush
      history.replaceState = originalReplace
    }
  })

  test('create failure: draft and attachments preserved, explicit error, retry succeeds', { timeout: 60_000 }, async () => {
    state.createFailures = 1
    await mount('#/a/assistant')
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '第一条') })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => document.querySelector('.agent-standby-error') !== null)
    assert.equal(state.createCalls.length, 1)
    const alert = document.querySelector('.agent-standby-error')
    assert.ok(alert, 'the explicit error banner shows')
    assert.ok(alert!.textContent?.includes('create failed'))
    assert.equal(input.value, '第一条', 'the draft is preserved')
    // Retry: the second create succeeds
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => window.location.hash === '#/c/9')
    assert.equal(state.createCalls.length, 2, 'retry re-creates (the previous one never succeeded)')
    assert.equal(state.submitCalls.length, 1, 'the retry submits successfully')
    assert.equal(window.location.hash, '#/c/9')
  })

  test('submit failure after create: keeps the real conversation id; retry never re-creates', { timeout: 60_000 }, async () => {
    state.submitFailures = 1
    await mount('#/a/assistant')
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '会创建但发送失败') })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => document.querySelector('.agent-standby-error') !== null)
    assert.equal(state.createCalls.length, 1)
    assert.equal(state.submitCalls.length, 1)
    assert.ok(document.querySelector('.agent-standby-error'), 'the failure banner shows')
    assert.equal(input.value, '会创建但发送失败', 'the draft is preserved')
    assert.equal(window.location.hash, '#/a/assistant', 'no navigation without full-chain success')
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => window.location.hash === '#/c/9')
    assert.equal(state.createCalls.length, 1, 'retry reuses the created conversation without re-creating')
    assert.equal(state.submitCalls.length, 2, 'retry submits again')
    assert.equal(state.submitCalls[1]!.id, 9)
    assert.equal(window.location.hash, '#/c/9')
  })

  test('attachments: staged locally only before send; the first send follows create -> upload -> submit order', { timeout: 60_000 }, async () => {
    await mount('#/a/assistant')
    const input = textarea(MAIN_LABEL)
    const box = document.querySelector<HTMLElement>('.agent-standby-pane .composer-box')
    assert.ok(box, 'the standby input container exists')
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })
    await act(async () => { dropFiles(box!, [file]) })
    await settle()
    assert.ok(document.body.textContent?.includes('note.txt'), 'the attachment chip shows')
    assert.ok(document.body.textContent?.includes('Pending'), 'the local-staging badge shows')
    assert.equal(state.uploadCalls.length, 0, 'never uploads before sending (no real conversation)')
    assert.equal(state.createCalls.length, 0)
    act(() => { typeInto(input, '带附件') })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => window.location.hash === '#/c/9')
    assert.equal(state.createCalls.length, 1)
    assert.deepEqual(state.uploadCalls, [{ id: 9, name: 'note.txt' }], 'uploads to the real conversation after create')
    assert.deepEqual((state.submitCalls[0]!.body as { attachments?: string[] }).attachments, ['art-1'])
    assert.equal(window.location.hash, '#/c/9')
  })

  test('starter: prefills an empty draft; never overwrites a non-empty one and notifies', { timeout: 60_000 }, async () => {
    await mount('#/a/assistant')
    const starterBtn = document.querySelector<HTMLButtonElement>('button.timeline-starter-btn')
    assert.ok(starterBtn, 'the starter button exists')
    act(() => { starterBtn!.click() })
    await settle()
    const input = textarea(MAIN_LABEL)
    assert.equal(input.value, 'say hi', 'the empty draft prefills the starter')
    act(() => { typeInto(input, '我自己写的') })
    await act(async () => { starterBtn!.click() })
    await settle()
    assert.equal(textarea(MAIN_LABEL).value, '我自己写的', 'a non-empty draft is not overwritten by the starter')
    assert.ok(document.body.textContent?.includes('Handle the current draft'), 'an explicit notice is given')
  })

  test('URL environment inheritance: the standby target carries remote node and directory; create passes them faithfully', { timeout: 60_000 }, async () => {
    await mount(`#/a/assistant?node=remote-1&cwd=${encodeURIComponent('/remote/work')}`)
    const cwdInput = document.querySelector<HTMLInputElement>('input[aria-label="New conversation working directory"]')
    assert.ok(cwdInput, 'the environment bar enters customized mode')
    assert.equal(cwdInput!.value, '/remote/work')
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '继续远端工作') })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => state.createCalls.length === 1)
    assert.deepEqual(state.createCalls[0], {
      profileId: 'assistant',
      nodeId: 'remote-1',
      cwd: '/remote/work',
    }, 'the inherited remote coordinates ride with create; never silently falling back to local')
  })

  test('primary/split draft isolation: two standby drafts in one browser never cross-talk', { timeout: 60_000 }, async () => {
    await mount('#/a/assistant?split=a/coder')
    const main = textarea(MAIN_LABEL)
    const split = textarea('Type the first message to 编码专员')
    assert.ok(split, 'the split standby input exists')
    act(() => { typeInto(main, '主屏草稿') })
    await settle()
    assert.equal(textarea(MAIN_LABEL).value, '主屏草稿')
    assert.equal(textarea('Type the first message to 编码专员').value, '', 'the split draft is unaffected by the primary panel')
  })

  test('switching away mid-wait: success never hijacks navigation; a notice announces the new conversation instead', { timeout: 60_000 }, async () => {
    state.createGate = makeGate()
    await mount('#/a/assistant')
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '等待期切走') })
    await act(async () => { pressEnter(input) })
    // The user switches to an existing conversation while in flight
    const convRow = [...document.querySelectorAll<HTMLButtonElement>('.sidebar-overview-item .sidebar-overview-open')]
      .find((btn) => btn.textContent?.includes('会话 1'))
    assert.ok(convRow, 'the sidebar has the historical conversation row')
    await act(async () => { convRow!.click() })
    await settle()
    assert.equal(window.location.hash, '#/c/1')
    await act(async () => { state.createGate!.resolve() })
    await waitForCondition(
      () => state.submitCalls.length === 1 && document.body.textContent?.includes('Sent and conversation created') === true,
    )
    assert.equal(state.submitCalls.length, 1, 'the send chain completes')
    assert.equal(window.location.hash, '#/c/1', 'the late success never overwrites the new navigation')
    assert.ok(document.body.textContent?.includes('Sent and conversation created'), 'a clickable notice is given')
  })

  test('new-topic button: enters standby inheriting the remote environment, pre-creating nothing', { timeout: 60_000 }, async () => {
    await mount('#/c/3')
    clickButton('button[title^="Start a new topic under the current agent"]')
    await settle()
    assert.equal(window.location.hash, `#/a/assistant?node=remote-1&cwd=${encodeURIComponent('/remote/work')}`)
    assert.equal(state.createCalls.length, 0, 'new topic pre-creates no empty conversation')
    const cwdInput = document.querySelector<HTMLInputElement>('input[aria-label="New conversation working directory"]')
    assert.equal(cwdInput?.value, '/remote/work', 'the standby environment bar inherited the remote directory')
  })

  test('unavailable states shown honestly: plugin-disabled profile', { timeout: 60_000 }, async () => {
    await mount('#/a/managed')
    assert.ok(document.body.textContent?.includes('This profile does not support manual new conversations'), 'a profile managed by a disabled plugin reports explicit unavailability')
    assert.equal(document.querySelectorAll('textarea').length, 0, 'no draft input renders')
    assert.equal(state.createCalls.length, 0)
  })

  test('assets not loaded never mis-judged as missing: explicit loading state', { timeout: 60_000 }, async () => {
    state.assetsGate = makeGate()
    window.history.replaceState(null, '', '#/a/assistant')
    host = document.createElement('div')
    document.body.appendChild(host)
    installFetch()
    await act(async () => {
      root = createRoot(host!)
      root.render(e(App))
    })
    await waitForCondition(() => document.body.textContent?.includes('Loading profile info') === true)
    assert.ok(document.body.textContent?.includes('Loading profile info'), 'the loading state is explicitly visible')
    assert.ok(!document.body.textContent?.includes('does not exist or was deleted'), 'must not mis-judge as missing')
    await act(async () => { state.assetsGate!.resolve() })
    await waitForCondition(() => document.querySelector(`textarea[aria-label="${MAIN_LABEL}"]`) !== null)
    assert.ok(textarea(MAIN_LABEL), 'the input renders once assets are ready')
  })

  test('model & thinking level: the model rides with create; the thinking level patches after creation', { timeout: 60_000 }, async () => {
    await mount('#/a/assistant')
    clickButton('button.composer-model-button')
    const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
    assert.ok(popover, 'the model popover opens')
    // Each row carries its thinking levels inline: one chip click applies
    // model + level together in a single commit
    const glmRow = [...popover!.querySelectorAll<HTMLElement>('.composer-model-row')]
      .find((row) => row.querySelector('.composer-model-row-main')?.textContent?.includes('glm-4.6'))
    assert.ok(glmRow, 'an available model row exists in the catalog')
    const high = [...glmRow!.querySelectorAll<HTMLButtonElement>('.composer-model-level-chip')]
      .find((btn) => btn.textContent?.trim() === 'high')
    assert.ok(high, 'the row renders its inline thinking level chips')
    await act(async () => { high!.click() })
    await settle()
    const modelBtn = document.querySelector<HTMLButtonElement>('button.composer-model-button')
    assert.ok(document.body.querySelector('.composer-model-popover') === null, 'the chip click closes the popover')
    assert.ok(modelBtn!.textContent?.includes('glm-4.6'), 'the button shows the applied pick')
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '带模型偏好') })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => state.submitCalls.length === 1 && state.patchCalls.length === 1)
    assert.equal((state.createCalls[0] as { model?: string }).model, 'faux/glm-4.6', 'the model rides with create')
    assert.deepEqual(state.patchCalls, [{ id: 9, body: { thinkingLevel: 'high' } }], 'the thinking level patches after creation')
    assert.equal(state.submitCalls.length, 1)
  })

  test('split-pane standby first send: the primary conversation stays untouched; the new conversation lands on the split only', { timeout: 60_000 }, async () => {
    await mount('#/c/1?split=a/assistant')
    assert.ok(document.body.textContent?.includes('会话 1'), 'the primary panel keeps the original conversation')
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '右屏首发') })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => window.location.hash === '#/c/1?split=c%2F9')
    assert.equal(state.createCalls.length, 1)
    assert.equal(state.submitCalls.length, 1)
    assert.equal(window.location.hash, '#/c/1?split=c%2F9', 'the new conversation replaces onto the split without hijacking the primary')
    assert.ok(document.body.textContent?.includes('会话 1'), 'the primary conversation still renders')
    const splitPanes = document.querySelectorAll('.helmx-split-pane')
    assert.ok(splitPanes.length > 0 && splitPanes[0]!.textContent?.includes('会话 9'), 'the split renders the new conversation')
  })

  test('model selection restores defaults: after an explicit pick you can still return to the profile default; create carries no model', { timeout: 60_000 }, async () => {
    await mount('#/a/assistant')
    clickButton('button.composer-model-button')
    const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
    const glmMain = [...popover!.querySelectorAll<HTMLButtonElement>('.composer-model-row-main')]
      .find((btn) => btn.textContent?.includes('glm-4.6'))
    assert.ok(glmMain !== undefined, 'the glm row main button exists')
    await act(async () => { glmMain!.click() })
    await settle()
    assert.ok(document.body.querySelector('.composer-model-popover') === null, 'the row click closes the popover')
    assert.ok(document.querySelector('button.composer-model-button')?.textContent?.includes('glm-4.6'), 'the row body click commits the draft model with the default level')
    // Reopen: the restore-default item returns to following the profile default
    clickButton('button.composer-model-button')
    const resetPopover = document.body.querySelector<HTMLElement>('.composer-model-popover')
    assert.ok(resetPopover !== null, 'the popover reopens after an explicit pick')
    const resetBtn = [...resetPopover!.querySelectorAll<HTMLButtonElement>('button.composer-model-reset')]
      .find((btn) => btn.textContent?.includes('Follow profile default'))
    assert.ok(resetBtn, 'the restore-default item exists')
    assert.equal(resetBtn!.disabled, false, 'after an explicit pick you can still return to following the default')
    await act(async () => { resetBtn!.click() })
    await settle()
    assert.ok(document.querySelector('button.composer-model-button')?.textContent?.includes('Default model'))
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, 'Default model发送') })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => state.createCalls.length === 1)
    assert.deepEqual(state.createCalls[0], { profileId: 'assistant' }, 'after restoring defaults, create carries no model')
  })

  test('sidebar conversation row vs standby state: entering a conversation lights the working-set row; entering standby lights the new-topic row and survives SSE updates', { timeout: 60_000 }, async () => {
    state.conversations.push(summary(5, { profileId: 'coder' }))
    await mount('#/c/1')

    // Entering a conversation lights only the matching working-set row; new-topic entry stays inert
    const activeConvRow = document.querySelector('.sidebar-overview-item.nav-item-active')
    assert.ok(activeConvRow?.textContent?.includes('会话 1'), 'the current conversation row lights up in the working set')
    assert.equal(activeConvRow?.querySelector('.sidebar-overview-open')?.getAttribute('aria-current'), 'page')
    assert.ok(!document.querySelector('.sidebar-new-topic-btn')?.className.includes('is-active'))

    // Selecting coder from the New topic dropdown enters #/a/coder without pre-creating
    const newTopicBtn = document.querySelector<HTMLButtonElement>('.sidebar-new-topic-btn')!
    await act(async () => {
      newTopicBtn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    })
    await settle()
    const coderItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((el) => el.textContent?.includes('编码专员'))!
    await act(async () => { coderItem.click() })
    await settle()
    assert.equal(window.location.hash, '#/a/coder', 'picking coder enters its standby page')
    assert.equal(state.createCalls.length, 0, 'no conversation pre-created')
    assert.ok(document.querySelector('.sidebar-new-topic-btn')?.className.includes('is-active'), 'new-topic entry lights up in standby')
    assert.equal(document.querySelector('.sidebar-new-topic-btn')?.getAttribute('aria-current'), 'page')
    assert.ok(document.querySelector('.sidebar-overview-item.nav-item-active') === null, 'no conversation row lights up in standby')

    // SSE live updates preserve the standby highlight
    await act(async () => {
      sendEvent?.(eventFrame(++eventSeq, {
        type: 'conversation.upsert',
        conversation: { ...summary(1), updatedAt: 99 },
      }))
    })
    await settle()
    assert.ok(document.querySelector('.sidebar-new-topic-btn')?.className.includes('is-active'), 'after live updates the standby highlight persists')
  })

  test('real-conversation Composer /new: enters standby inheriting the environment, no reset, no create', { timeout: 60_000 }, async () => {
    await mount('#/c/1')
    const composerInput = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Type a message"]')
    assert.ok(composerInput, 'the conversation input exists')
    act(() => { typeInto(composerInput!, '/new') })
    // The first Enter is captured by the slash popover writing '/new' back; the second Enter submits the management command
    await act(async () => { pressEnter(composerInput!) })
    await flushMacrotask(0)
    await act(async () => { pressEnter(composerInput!) })
    await waitForCondition(() => window.location.hash.startsWith('#/a/assistant'))
    assert.equal(window.location.hash, `#/a/assistant?cwd=${encodeURIComponent('/tmp')}`, '/new enters standby inheriting the current directory')
    assert.equal(state.resetCalls.length, 0, '/new no longer resets the original conversation')
    assert.equal(state.createCalls.length, 0, '/new pre-creates nothing')
  })

  test('standby management commands: /new clears the draft; /clear notices that a conversation must exist first; neither persists anything', { timeout: 60_000 }, async () => {
    await mount('#/a/assistant')
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '/new') })
    // The first Enter is captured by the slash popover writing '/new' back; the second Enter submits the management command
    await act(async () => { pressEnter(input) })
    await act(async () => { pressEnter(input) })
    await settle()
    assert.equal(state.createCalls.length, 0)
    assert.equal(state.submitCalls.length, 0)
    assert.equal(input.value, '', '/new clears the draft text')
    act(() => { typeInto(input, '/clear') })
    await act(async () => { pressEnter(input) })
    await act(async () => { pressEnter(input) })
    await settle()
    assert.equal(state.createCalls.length, 0, '/clear creates no conversation')
    assert.equal(state.submitCalls.length, 0, '/clear is not sent as plain input')
    assert.equal(input.value, '/clear', '/clear keeps the draft for the user to handle')
    assert.ok(document.body.textContent?.includes('requires an existing conversation'), 'explicitly notices that a conversation must be created first')
  })

  test('profile asset load failure: explicit error and retry; never fakes success with a done signal', { timeout: 60_000 }, async () => {
    state.profilesFail = true
    await mount('#/a/assistant')
    assert.ok(document.body.textContent?.includes('Profile info failed to load'), 'shows the real error')
    assert.ok(document.body.textContent?.includes('profiles down'), 'carries the error detail')
    assert.ok(!document.body.textContent?.includes('does not exist or was deleted'), 'must not mis-judge as missing')
    assert.equal(document.querySelectorAll('textarea').length, 0, 'the error state renders no input')
    const retry = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((btn) => btn.textContent?.trim() === 'Retry')
    assert.ok(retry, 'a retry button is offered')
    state.profilesFail = false
    await act(async () => { retry!.click() })
    await waitForCondition(() => document.querySelector(`textarea[aria-label="${MAIN_LABEL}"]`) !== null)
    assert.ok(textarea(MAIN_LABEL), 'the input renders after a successful retry')
  })

  // ---------------------------------------------------------------------------
  // A. Full-coordinate draft identity / B. anchored configuration locking / C. logout epoch release
  // ---------------------------------------------------------------------------

  function navigateHash(hash: string): void {
    window.history.pushState(null, '', hash)
    window.dispatchEvent(new Event('hashchange'))
  }

  test('same Profile at different remote coordinates: drafts isolate per coordinate; first sends use their own; old coordinates are preserved', { timeout: 60_000 }, async () => {
    await mount('#/a/assistant?node=remote-1&cwd=%2Fremote%2Fwork')
    act(() => { typeInto(textarea(MAIN_LABEL), 'r1 草稿') })
    await act(async () => { navigateHash('#/a/assistant?node=remote-2&cwd=%2Fremote%2Fwork2') })
    await settle()
    const r2 = textarea(MAIN_LABEL)
    assert.equal(r2.value, '', 'the r2-coordinate draft starts fresh, sharing none of the r1 text')
    act(() => { typeInto(r2, 'r2 草稿') })
    await act(async () => { pressEnter(r2) })
    await settle()
    assert.deepEqual(state.createCalls[0], {
      profileId: 'assistant',
      nodeId: 'remote-2',
      cwd: '/remote/work2',
    }, 'create uses the r2 coordinates, never carrying the r1 environment')
    // Back to r1: the old-coordinate draft is preserved
    await act(async () => { navigateHash('#/a/assistant?node=remote-1&cwd=%2Fremote%2Fwork') })
    await settle()
    assert.equal(textarea(MAIN_LABEL).value, 'r1 草稿', 'the old-coordinate draft is preserved')
  })

  test('switching to another environment of the same Profile mid-send: no navigation hijack, no draft cross-talk; the response becomes a background notice', { timeout: 60_000 }, async () => {
    state.createGate = makeGate()
    await mount('#/a/assistant?node=remote-1&cwd=%2Fremote%2Fwork')
    const r1 = textarea(MAIN_LABEL)
    act(() => { typeInto(r1, 'r1 在途') })
    await act(async () => { pressEnter(r1) })
    await act(async () => { navigateHash('#/a/assistant?node=remote-2&cwd=%2Fremote%2Fwork2') })
    await settle()
    const r2 = textarea(MAIN_LABEL)
    assert.equal(r2.value, '', 'the r2 draft is unaffected by the r1 in-flight task')
    await act(async () => { state.createGate!.resolve() })
    await waitForCondition(
      () => state.submitCalls.length === 1 && document.body.textContent?.includes('Sent and conversation created') === true,
    )
    assert.equal(state.submitCalls.length, 1, 'the r1 task completes its submit (with the r1 configuration)')
    assert.deepEqual((state.createCalls[0] as { nodeId?: string }).nodeId, 'remote-1')
    assert.equal(window.location.hash, '#/a/assistant?node=remote-2&cwd=%2Fremote%2Fwork2', 'no navigation hijack')
    assert.ok(document.body.textContent?.includes('Sent and conversation created'), 'becomes a background notice')
  })

  test('restore defaults (no conflict): the text moves with the coordinate to the default environment and URL inheritance params are removed', { timeout: 60_000 }, async () => {
    await mount(`#/a/assistant?node=remote-1&cwd=${encodeURIComponent('/remote/work')}`)
    act(() => { typeInto(textarea(MAIN_LABEL), '跟随正文') })
    const resetBtn = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((btn) => btn.textContent?.trim() === 'Restore defaults')
    assert.ok(resetBtn, 'the restore-defaults button exists (URL-coordinate customized mode)')
    await act(async () => { resetBtn!.click() })
    await settle()
    assert.equal(window.location.hash, '#/a/assistant', 'the sole navigation removes the inherited environment params; no revival on refresh')
    assert.equal(textarea(MAIN_LABEL).value, '跟随正文', 'the text moves with the coordinate')
    assert.ok(document.body.textContent?.includes('Execution environment follows the profile default'), 'the environment returns to the default state')
  })

  test('restore defaults (target holds a draft): never overwrites it and says so; the source draft is preserved', { timeout: 60_000 }, async () => {
    await mount('#/a/assistant')
    act(() => { typeInto(textarea(MAIN_LABEL), '默认坐标已有草稿') })
    await act(async () => { navigateHash(`#/a/assistant?node=remote-1&cwd=${encodeURIComponent('/remote/work')}`) })
    await settle()
    assert.equal(textarea(MAIN_LABEL).value, '', 'the r1-coordinate draft is independent')
    act(() => { typeInto(textarea(MAIN_LABEL), 'r1 正文') })
    const resetBtn = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((btn) => btn.textContent?.trim() === 'Restore defaults')
    await act(async () => { resetBtn!.click() })
    await settle()
    assert.equal(window.location.hash, '#/a/assistant')
    assert.ok(document.body.textContent?.includes('The default environment already has another draft'), 'explicitly reports the non-overwrite')
    assert.equal(textarea(MAIN_LABEL).value, '默认坐标已有草稿', 'the existing draft is never silently overwritten')
    await act(async () => { navigateHash(`#/a/assistant?node=remote-1&cwd=${encodeURIComponent('/remote/work')}`) })
    await settle()
    assert.equal(textarea(MAIN_LABEL).value, 'r1 正文', 'the source draft stays at its original coordinate')
  })

  test('anchored configuration locking: model/environment immutable with a banner about the bound conversation; text and attachments stay editable for retry', { timeout: 60_000 }, async () => {
    state.submitFailures = 1
    await mount('#/a/assistant')
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '首发锚定') })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => document.body.textContent?.includes('Conversation #9 created') === true)
    assert.ok(document.body.textContent?.includes('Conversation #9 created'), 'the locking banner is visible')
    assert.equal(document.querySelector<HTMLButtonElement>('button.composer-model-button')?.disabled, true, 'model selection locks')
    const customizeBtn = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((btn) => btn.textContent?.trim() === 'Custom')
    assert.equal(customizeBtn?.disabled, true, 'the starting environment locks')
    act(() => { typeInto(input, '（已修正）') })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => window.location.hash === '#/c/9')
    assert.equal(state.createCalls.length, 1, 'retry reuses the conversation')
    assert.equal(state.submitCalls.length, 2)
    assert.equal(window.location.hash, '#/c/9')
  })

  test('logout during the create wait: releases the draft and voids the in-flight response — no revival, no submit, no notice', { timeout: 60_000 }, async () => {
    state.createGate = makeGate()
    await mount('#/a/assistant')
    act(() => { typeInto(textarea(MAIN_LABEL), '将被释放') })
    await act(async () => { pressEnter(textarea(MAIN_LABEL)) })
    await act(async () => { window.dispatchEvent(new Event('helmx:unauthorized')) })
    await settle()
    const key = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
    assert.equal(getStandbyDraft(key).text, '', 'logout releases the draft synchronously')
    await act(async () => { state.createGate!.resolve() })
    await flushMacrotask(0)
    await flushMacrotask(0)
    assert.equal(state.createCalls.length, 1, 'an already-issued request is never claimed as retractable')
    assert.equal(state.submitCalls.length, 0, 'no further submit after the epoch voiding')
    assert.equal(getStandbyDraft(key).conversationId, undefined, 'the response must not write an anchor')
    assert.equal(getStandbyDraft(key).text, '', 'the response must not revive the text')
    assert.ok(!document.body.textContent?.includes('Sent and conversation created'), 'no notice sent')
  })

  test('logout during the upload wait: no further submit, no attachment revival; the same coordinate is draft-empty after re-login', { timeout: 60_000 }, async () => {
    state.uploadGate = makeGate()
    await mount('#/a/assistant')
    const box = document.querySelector<HTMLElement>('.agent-standby-pane .composer-box')!
    await act(async () => { dropFiles(box, [new File(['hi'], 'wait.txt', { type: 'text/plain' })]) })
    await settle()
    act(() => { typeInto(textarea(MAIN_LABEL), '上传中释放') })
    await act(async () => { pressEnter(textarea(MAIN_LABEL)) })
    await waitForCondition(() => state.uploadStarted)
    await act(async () => { window.dispatchEvent(new Event('helmx:unauthorized')) })
    await settle()
    await act(async () => { state.uploadGate!.resolve() })
    await flushMacrotask(0)
    await flushMacrotask(0)
    const key = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
    assert.equal(state.submitCalls.length, 0, 'no further submit after the upload response is voided')
    assert.equal(getStandbyDraft(key).uploaded.length, 0, 'the response must not revive attachments')
    assert.equal(getStandbyDraft(key).text, '', 'no old text at the same coordinate after re-login')
  })

  test('fake-File injection rejected at the boundary: plain objects enter no draft and render no chip; sending is never cut in half', { timeout: 60_000 }, async () => {
    await mount('#/a/assistant')
    // Simulate a synthetic change event carrying a plain object with only name/size (the shape browser
    // QA once injected): the old implementation rendered a normal chip, then the first send's
    // uploadArtifact threw a synchronous TypeError at file.arrayBuffer() after create succeeded —
    // the chain broke before upload (zero uploads / zero input / zero navigation).
    const fileInput = document.querySelector<HTMLInputElement>('.agent-standby-pane input[type=file]')
    assert.ok(fileInput, 'the hidden file input exists')
    const fake = { name: 'fake-attach.txt', size: 20, type: 'text/plain' } as unknown as File
    await act(async () => {
      Object.defineProperty(fileInput!, 'files', { configurable: true, get: () => [fake] })
      fileInput!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    assert.ok(document.body.textContent?.includes('Unsupported attachment source'), 'the admission boundary rejects explicitly with a notice')
    assert.equal(document.querySelectorAll('.attachment-chip').length, 0, 'fake objects render no attachment chip')
    // Normal text sends are unaffected: no interruption by the fake attachment
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '伪附件被拒后的正常首发') })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => window.location.hash === '#/c/9')
    assert.equal(state.createCalls.length, 1)
    assert.equal(state.uploadCalls.length, 0)
    assert.equal(state.submitCalls.length, 1, 'the full chain completes as usual')
    assert.equal(window.location.hash, '#/c/9')
  })

  test('real File through the input change event path: full first-send chain (create -> upload -> submit -> navigate)', { timeout: 60_000 }, async () => {
    await mount('#/a/assistant')
    const fileInput = document.querySelector<HTMLInputElement>('.agent-standby-pane input[type=file]')
    assert.ok(fileInput)
    const real = new File(['real input content'], 'real-input.txt', { type: 'text/plain' })
    await act(async () => {
      Object.defineProperty(fileInput!, 'files', { configurable: true, get: () => [real] })
      fileInput!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    assert.ok(document.body.textContent?.includes('real-input.txt'), 'the real file renders a chip')
    assert.equal(state.uploadCalls.length, 0, 'zero uploads before send')
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '真实文件首发') })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => window.location.hash === '#/c/9')
    assert.deepEqual(state.uploadCalls, [{ id: 9, name: 'real-input.txt' }], 'create 后上传到真实会话')
    assert.deepEqual((state.submitCalls[0]!.body as { attachments?: string[] }).attachments, ['art-1'])
    assert.equal(window.location.hash, '#/c/9')
  })

  // ---------------------------------------------------------------------------
  // Standby pane (draft state) '/' slash skill & command popover
  // ---------------------------------------------------------------------------

  test('draft-state /: pops builtin commands, Profile-filtered skills and global plugin commands; excludes conversation-scoped and disabled-plugin items', { timeout: 60_000 }, async () => {
    state.profiles = [
      { id: 'assistant', name: '个人助理', skills: ['review', 'herdr-tool'] },
      { id: 'coder', name: '编码专员', skills: [] },
    ]
    state.skills = [
      { id: 'review', name: '代码审查', references: [] },
      { id: 'tally', name: '记账汇总', references: [] },
      { id: 'herdr-tool', name: '终端工具', managedByPlugin: 'builtin:herdr', references: [] },
    ]
    state.plugins = [
      { id: 'builtin:profile', name: 'assistant', locked: true, enabled: true, hooks: [], actions: [], tools: [] },
      { id: 'builtin:herdr', name: 'herdr', locked: false, enabled: false, hooks: [], actions: [], tools: [] },
      { id: 'p1', name: 'p1', locked: false, enabled: true, hooks: [], actions: ['ping'], tools: [] },
    ]
    state.ui = [
      {
        pluginId: 'p1',
        surface: 'commandPalette',
        spec: { id: 'ping', title: '全局诊断', slash: 'ping', description: '全局斜杠命令', actionId: 'ping' },
      },
      {
        pluginId: 'p1',
        surface: 'commandPalette',
        spec: { id: 'scoped', title: '仅工作流会话', slash: 'wf-only', actionId: 'ping', scope: { tags: ['worker'] } },
      },
    ]

    await mount('#/a/assistant')
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '/') })
    await settle()

    const popover = document.querySelector<HTMLElement>('.agent-standby-pane .composer-popover')
    assert.ok(popover, "draft-state / must pop the slash popover")
    const text = popover!.textContent ?? ''
    assert.match(text, /\/new/, 'includes the builtin /new')
    assert.match(text, /\/clear/, 'includes the builtin /clear')
    assert.match(text, /\/compact/, 'includes the builtin /compact')
    assert.match(text, /\/skill:review/, 'includes the whitelisted available skill')
    assert.doesNotMatch(text, /\/skill:tally/, 'excludes skills outside the whitelist')
    assert.doesNotMatch(text, /\/skill:herdr-tool/, 'excludes skills of disabled plugins')
    assert.match(text, /\/ping/, 'includes plugin commands without conversation-scope restrictions')
    assert.doesNotMatch(text, /\/wf-only/, 'excludes plugin commands with conversation-scope restrictions')

    // Escape closes the popover without creating or sending
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.ok(document.querySelector('.agent-standby-pane .composer-popover') === null, 'Esc closes the slash popover')
    assert.equal(state.createCalls.length, 0)

    // Switch to the coder standby pane with skills: []: the popover closes and shows no skills
    await act(async () => { navigateHash('#/a/coder') })
    await settle()
    const coderInput = textarea('Type the first message to 编码专员')
    act(() => { typeInto(coderInput, '/') })
    await settle()
    const coderPopover = document.querySelector<HTMLElement>('.agent-standby-pane .composer-popover')
    assert.ok(coderPopover, "typing / on the coder standby pane pops the popover")
    assert.doesNotMatch(coderPopover!.textContent ?? '', /skill:/, 'with skills=[] no skills are shown')
  })

  test('draft-state / filter and skill write-back: replaces only the trigger token; only the later send creates and submits the full text', { timeout: 60_000 }, async () => {
    state.skills = [
      { id: 'review', name: '代码审查', references: [] },
      { id: 'tally', name: '记账汇总', references: [] },
    ]
    await mount('#/a/assistant')
    const input = textarea(MAIN_LABEL)

    // A mid-path slash never mis-triggers
    act(() => { typeInto(input, 'src/index') })
    await settle()
    assert.ok(document.querySelector('.agent-standby-pane .composer-popover') === null, 'a mid-path / never pops')

    // Keep the prefix + trigger /rev filter; Enter picks and writes back /skill:review (with trailing
    // space) without pre-creating a conversation
    act(() => { typeInto(input, '请执行 /rev') })
    await settle()
    const popover = document.querySelector<HTMLElement>('.agent-standby-pane .composer-popover')
    assert.ok(popover, '/rev after whitespace pops the popover')
    assert.match(popover!.textContent ?? '', /\/skill:review/)
    assert.doesNotMatch(popover!.textContent ?? '', /\/skill:tally/)

    // Enter during IME composing picks no candidate and submits nothing
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))
    })
    assert.equal(input.value, '请执行 /rev')
    assert.ok(document.querySelector('.agent-standby-pane .composer-popover'), 'the popover stays during IME composing')

    await act(async () => { pressEnter(input) })
    await settle()
    assert.equal(input.value, '请执行 /skill:review ', 'replaces only the /rev token, keeping the prefix text')
    assert.ok(document.querySelector('.agent-standby-pane .composer-popover') === null, 'the popover closes after the pick write-back')
    assert.equal(state.createCalls.length, 0, 'writing back a skill creates no conversation early')

    // Only after appending instructions does Enter actually create -> submit
    act(() => { typeInto(input, '请执行 /skill:review 检查变更') })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => state.submitCalls.length === 1)
    assert.equal(state.createCalls.length, 1)
    assert.equal(state.submitCalls.length, 1)
    assert.equal(state.submitCalls[0]!.body.text, '请执行 /skill:review 检查变更')
  })

  test('draft-state plugin slash commands: popover picks execute and close; failures keep the draft; none create a conversation', { timeout: 60_000 }, async () => {
    state.plugins = [
      { id: 'p1', name: 'p1', locked: false, enabled: true, hooks: [], actions: ['ping'], tools: [] },
    ]
    state.ui = [
      {
        pluginId: 'p1',
        surface: 'commandPalette',
        spec: { id: 'ping', title: '诊断探针', slash: 'ping', actionId: 'ping', input: { source: 'standby' } },
      },
    ]

    await mount('#/a/assistant')
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '草稿前缀 /pi') })
    await settle()
    assert.ok(document.querySelector('.agent-standby-pane .composer-popover'), 'the plugin-command popover pops')

    await act(async () => { pressEnter(input) })
    await waitForCondition(() => state.actionCalls.length === 1)
    assert.equal(state.actionCalls.length, 1, 'the plugin action fires')
    assert.equal(state.actionCalls[0]!.pluginId, 'p1')
    assert.equal(state.actionCalls[0]!.actionId, 'ping')
    assert.deepEqual(state.actionCalls[0]!.body, { input: { source: 'standby' } }, 'no fabricated conversationId while unanchored')
    assert.ok(document.querySelector('.agent-standby-pane .composer-popover') === null, 'the popover closes after executing the plugin command')
    assert.equal(input.value, '草稿前缀 ', 'consumes only the trigger token, keeping the rest of the draft')
    assert.equal(state.createCalls.length, 0, 'executing a plugin command creates no conversation')

    // Submitting /ping directly (no popover): also hits and executes the plugin command; failure keeps the draft
    state.actionError = 'plugin offline'
    act(() => { typeInto(input, '/ping') })
    await settle()
    // Esc closes the popover, then Enter submits directly
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => state.actionCalls.length === 2)
    assert.equal(state.actionCalls.length, 2)
    assert.equal(input.value, '/ping', 'a failed plugin command keeps the original draft')
    assert.ok(document.body.textContent?.includes('Command failed: /ping'), 'an explicit error notice')
    assert.equal(state.createCalls.length, 0)
  })

  test('draft-state plugin slash commands: optimistic clear, in-flight banner + spinner, and rollback on untouched failure', { timeout: 60_000 }, async () => {
    state.plugins = [
      { id: 'p1', name: 'p1', locked: false, enabled: true, hooks: [], actions: ['ping'], tools: [] },
    ]
    state.ui = [
      {
        pluginId: 'p1',
        surface: 'commandPalette',
        spec: { id: 'ping', title: '诊断探针', slash: 'ping', actionId: 'ping' },
      },
    ]
    const gate = makeGate()
    state.actionGate = gate

    await mount('#/a/assistant')
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '草稿前缀 /pi') })
    await settle()
    assert.ok(document.querySelector('.agent-standby-pane .composer-popover') !== null)

    await act(async () => { pressEnter(input) })
    await waitForCondition(() => state.actionCalls.length === 1)
    assert.equal(input.value, '草稿前缀 ', 'partial token clears optimistically while in-flight')
    const banner = document.querySelector('.agent-standby-pane .composer-command-banner')
    assert.ok(banner !== null, 'running banner shows while command is in-flight')
    assert.match(banner.textContent ?? '', /\/ping/)
    const sendBtn = document.querySelector<HTMLButtonElement>('.agent-standby-pane button.btn-send')
    assert.ok(sendBtn !== null)
    assert.equal(sendBtn.disabled, true, 'send button disables while plugin command runs')
    assert.ok(sendBtn.querySelector('.spin-slow') !== null, 'send button spins while plugin command runs')

    gate.resolve()
    await waitForCondition(() => document.querySelector('.agent-standby-pane .composer-command-banner') === null)

    const failGate = makeGate()
    state.actionGate = failGate
    state.actionError = 'plugin offline'
    act(() => { typeInto(input, '保留前文 /pi') })
    await settle()
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => state.actionCalls.length === 2)
    assert.equal(input.value, '保留前文 ', 'clears optimistically while pending')
    assert.ok(document.querySelector('.agent-standby-pane .composer-command-banner') !== null)

    failGate.resolve()
    await waitForCondition(() => document.querySelector('.agent-standby-pane .composer-command-banner') === null)
    assert.equal(input.value, '保留前文 /pi', 'untouched draft rolls back after failure')
  })

  // ---------------------------------------------------------------------------
  // Standby pane (draft state) '@ / # / :' composerCompleter popovers
  // ---------------------------------------------------------------------------

  test('draft-state @: pops mentionable profile candidates (carrying profileId), filters and inserts on pick; only the later send creates and submits', { timeout: 60_000 }, async () => {
    state.plugins = [
      { id: 'builtin:profile', name: '角色与技能底座', locked: true, enabled: true, hooks: [], actions: ['list_mentionable'], tools: [] },
    ]
    state.ui = [
      {
        pluginId: 'builtin:profile',
        surface: 'composer.completer',
        spec: {
          id: 'profile-mentions',
          label: '点名角色',
          trigger: '@',
          priority: 100,
          source: { kind: 'action', actionId: 'list_mentionable' },
        },
      },
    ]
    state.actions = [
      {
        pluginId: 'builtin:profile',
        id: 'list_mentionable',
        description: '列出可点名角色',
        idempotent: true,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            conversationId: { type: 'number' },
            profileId: { type: 'string' },
          },
          additionalProperties: false,
        },
        outputSchema: { type: 'object' },
      },
    ]
    state.actionResponse = (_pluginId, _actionId, body) => {
      const input = (body.input ?? {}) as { query?: string; profileId?: string }
      const q = (input.query ?? '').toLowerCase()
      const all = [
        { id: 'coder', label: '@coder · 编码专员', insertText: '@coder ', hint: '编码协作', icon: 'bot' },
        { id: 'reviewer', label: '@reviewer · 代码评审', insertText: '@reviewer ', hint: '评审协作', icon: 'bot' },
      ].filter((c) => c.id !== input.profileId && (q === '' || c.label.toLowerCase().includes(q)))
      return { items: all }
    }

    await mount('#/a/assistant')
    const input = textarea(MAIN_LABEL)

    // A mid-email @ never mis-triggers
    act(() => { typeInto(input, 'user@example.com') })
    await flushMacrotask(170)
    assert.ok(document.querySelector('.composer-completion-popover') === null, 'a mid-email @ never pops')

    // Typing @co after whitespace mid-line: the debounce fires the action query (carrying
    // profileId: assistant, fabricating no conversationId)
    act(() => { typeInto(input, '请帮我找 @co') })
    await waitForCondition(
      () => state.actionCalls.length === 1 && document.querySelector('.composer-completion-popover') !== null,
    )
    assert.equal(state.actionCalls.length, 1, 'one debounced completion query issued')
    assert.deepEqual(state.actionCalls[0]!.body, { input: { query: 'co', profileId: 'assistant' } }, 'carries the standby profileId and fabricates no conversationId')

    const popover = document.querySelector<HTMLElement>('.composer-completion-popover')
    assert.ok(popover, "draft-state @ pops the completion popover")
    assert.match(popover!.textContent ?? '', /@coder · 编码专员/)
    assert.doesNotMatch(popover!.textContent ?? '', /@reviewer/)

    // Enter picks the candidate: replaces only @co, keeps the prefix, closes the popover, and neither
    // creates nor submits a conversation early
    await act(async () => { pressEnter(input) })
    await settle()
    assert.equal(input.value, '请帮我找 @coder ', 'replaces only the @co token, keeping the prefix')
    assert.ok(document.querySelector('.composer-completion-popover') === null, 'the popover closes after the pick')
    assert.equal(state.createCalls.length, 0, 'picking an @ candidate creates no conversation early')
    assert.equal(state.submitCalls.length, 0)

    // Only after appending text does the next Enter actually create -> submit
    act(() => { typeInto(input, '请帮我找 @coder 看下代码') })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => state.submitCalls.length === 1)
    assert.equal(state.createCalls.length, 1)
    assert.equal(state.submitCalls.length, 1)
    assert.equal(state.submitCalls[0]!.body.text, '请帮我找 @coder 看下代码')
  })

  test('draft-state # / :: global doc completion sources work with proper replacement; sessionDoc sources explicitly require an existing conversation', { timeout: 60_000 }, async () => {
    state.plugins = [
      { id: 'p1', name: 'p1', locked: false, enabled: true, hooks: [], actions: [], tools: [] },
    ]
    state.ui = [
      {
        pluginId: 'p1',
        surface: 'composer.completer',
        spec: { id: 'tags', label: '标签', trigger: '#', source: { kind: 'doc', name: 'tags', itemsField: 'items' } },
      },
      {
        pluginId: 'p1',
        surface: 'composer.completer',
        spec: { id: 'sess', label: '会话项', trigger: ':', source: { kind: 'sessionDoc', name: 'items', itemsField: 'items' } },
      },
    ]
    state.docs = {
      'p1/tags': { items: [{ id: 'bug', label: '#缺陷', insertText: '#缺陷 ' }] },
    }

    await mount('#/a/assistant')
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '#') })
    await settle()
    const hashPopover = document.querySelector<HTMLElement>('.composer-completion-popover')
    assert.ok(hashPopover, 'doc completion sources pop in draft state')
    assert.match(hashPopover!.textContent ?? '', /#缺陷/)
    await act(async () => { pressEnter(input) })
    await settle()
    assert.equal(input.value, '#缺陷 ')
    assert.ok(document.querySelector('.composer-completion-popover') === null)
    assert.equal(state.createCalls.length, 0)

    // sessionDoc sources give an explicit notice in the conversation-less draft state instead of loading forever
    act(() => { typeInto(input, ':') })
    await settle()
    const colonPopover = document.querySelector<HTMLElement>('.composer-completion-popover')
    assert.ok(colonPopover, 'sessionDoc sources pop a popover with an explicit diagnosis')
    assert.match(colonPopover!.textContent ?? '', /requires an existing conversation/)
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.ok(document.querySelector('.composer-completion-popover') === null, 'Escape closes the completion popover')
  })

  test('zero available models on standby shows onboarding CTA linking to Models Center (#/settings/models)', { timeout: 60_000 }, async () => {
    state.modelsOverride = { models: [], thinkingLevels: {} }
    await mount('#/a/assistant')
    const ctaBanner = document.querySelector('.agent-standby-pane .callout-warn')
    assert.ok(ctaBanner !== null, 'zero-model standby pane renders onboarding callout')
    const ctaBtn = ctaBanner.querySelector<HTMLButtonElement>('button')
    assert.ok(ctaBtn !== null, 'onboarding callout includes clickable button to Models Center')
    await act(async () => {
      ctaBtn.click()
    })
    await waitForCondition(() => window.location.hash === '#/settings/models')
    assert.equal(window.location.hash, '#/settings/models')
  })

  test('draft-state /plan with useComposerCommand: visible in / menu (while server-only /title stays hidden), toggles local draftMeta cleanly, and preserves /plan <task> first send', { timeout: 60_000 }, async () => {
    function StandbyPlanToolbarProbe(props: ComposerToolbarSlotProps) {
      const armed =
        typeof props.draftMeta?.['builtin:plan'] === 'object' &&
        props.draftMeta['builtin:plan'] !== null &&
        (props.draftMeta['builtin:plan'] as { mode?: unknown }).mode === 'planning'
      useComposerCommand('toggle-plan', () => {
        if (!props.disabled) {
          props.setDraftMeta?.('builtin:plan', armed ? undefined : { mode: 'planning' })
        }
      })
      return armed ? e('span', { className: 'plan-standby-armed-probe', 'data-armed': 'true' }, 'Plan') : null
    }

    seedPluginClientModule('builtin:plan', 'index.tsx', { PlanToolbarProbe: StandbyPlanToolbarProbe })
    state.plugins = [
      {
        id: 'builtin:plan',
        name: 'Plan Mode',
        locked: false,
        enabled: true,
        hooks: [],
        actions: ['toggle'],
        tools: [],
        clientHashes: { 'index.tsx': 'seeded' },
      },
      {
        id: 'builtin:title',
        name: 'Title',
        locked: false,
        enabled: true,
        hooks: [],
        actions: ['generate'],
        tools: [],
      },
    ]
    state.ui = [
      {
        pluginId: 'builtin:plan',
        surface: 'plugin.slot',
        spec: {
          id: 'plan-toolbar',
          target: COMPOSER_TOOLBAR_SLOT,
          order: 20,
          client: { module: 'index.tsx', export: 'PlanToolbarProbe' },
        },
      },
      {
        pluginId: 'builtin:plan',
        surface: 'commandPalette',
        spec: {
          id: 'toggle-plan',
          title: { en: 'Toggle Plan mode', 'zh-CN': '切换计划模式' },
          description: { en: 'Toggle read-only plan mode', 'zh-CN': '切换只读计划模式' },
          icon: 'list-tree',
          slash: 'plan',
          actionId: 'toggle',
          input: {},
          scope: { topLevelOnly: true, ownedBy: 'human' },
        },
      },
      {
        pluginId: 'builtin:title',
        surface: 'commandPalette',
        spec: {
          id: 'generate-title',
          title: 'Generate conversation title',
          slash: 'title',
          actionId: 'generate',
          input: {},
          scope: {},
        },
      },
    ]

    await mount('#/a/assistant')
    const input = textarea(MAIN_LABEL)

    // Typing / opens popover showing /plan right after /new, /clear, /compact while server-only /title stays hidden
    act(() => { typeInto(input, '/') })
    await settle()
    const popover = document.querySelector<HTMLElement>('.agent-standby-pane .composer-popover')
    assert.ok(popover, 'draft-state / pops the slash popover')
    const optionLabels = [...popover.querySelectorAll('[role="option"]')].map((el) => el.textContent ?? '')
    assert.ok(optionLabels.some((label) => label.includes('/plan')), 'standby / menu shows /plan via registered useComposerCommand')
    assert.equal(optionLabels.some((label) => label.includes('/title')), false, 'server-only /title stays hidden in standby')

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.ok(document.querySelector('.agent-standby-pane .composer-popover') === null)

    // Pick /plan after prefix text: removes only /pl token, toggles draft inputMeta with zero HTTP calls & zero toasts
    act(() => { typeInto(input, '草稿前缀 /pl') })
    await settle()
    await act(async () => { pressEnter(input) })
    await settle()

    const draftKey = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
    assert.equal(input.value, '草稿前缀 ', 'keeps prefix text and strips only /pl')
    assert.deepEqual(getStandbyDraft(draftKey).inputMeta, { 'builtin:plan': { mode: 'planning' } })
    assert.ok(document.querySelector('.plan-standby-armed-probe') !== null, 'Plan pill renders immediately after /plan toggle')
    assert.equal(state.actionCalls.length, 0, 'zero HTTP action calls in standby')
    assert.equal(state.createCalls.length, 0, 'zero conversation creation')
    assert.ok(document.querySelector('.agent-standby-pane .composer-command-banner') === null)
    assert.equal(document.body.textContent?.includes('Command executed') ?? false, false)

    // Submit bare /plan directly (Esc popover -> Enter): toggles standby plan mode back off locally
    act(() => { typeInto(input, '/plan') })
    await settle()
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await act(async () => { pressEnter(input) })
    await settle()

    assert.equal(input.value, '')
    assert.equal(getStandbyDraft(draftKey).inputMeta, undefined)
    assert.ok(document.querySelector('.plan-standby-armed-probe') === null)
    assert.equal(state.actionCalls.length, 0)
    assert.equal(state.createCalls.length, 0)

    // Submitting /plan <task> still enters the first-send conversation create -> submit path
    act(() => { typeInto(input, '/plan 帮我设计方案') })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => state.submitCalls.length === 1)
    assert.equal(state.createCalls.length, 1)
    assert.equal(state.submitCalls[0]!.body.text, '/plan 帮我设计方案')
  })
})
