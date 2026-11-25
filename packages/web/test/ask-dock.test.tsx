import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { describe, afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { AskSpec, ConversationSummary } from '@helmx/protocol'
import type { HelmxLocale } from '@helmx/protocol/browser'
import type { ActiveModal, HelmxStoreValue } from '../src/lib/types.js'

/**
 * AskDock descendant-approval aggregation regression:
 * - the current conversation shows its own + all descendant conversations' pending
 *   asks (unrelated conversations never appear);
 * - descendant asks carry a source badge; clicking opens that child conversation's drawer;
 * - answer/cancel still go through the original asksApi (with the expectedStateSeq
 *   CAS watermark); the approval chain is unchanged.
 */
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { AskDock } = await import('../src/conversation/AskDock.js')
const { ResolvedAskRow } = await import('../src/conversation/TimelineAuxRows.js')
const { makeTestStore } = await import('./helpers/store.js')
type HelmxExternalStore = import('../src/lib/helmx-store.js').HelmxExternalStore
const { TestStoreProvider } = await import('./helpers/host-store.js')
const e = React.createElement
const originalFetch = globalThis.fetch
let root: Root | undefined
let host: HTMLElement | undefined
let activeModal: ActiveModal = null
let posts: Array<{ url: string; body: Record<string, unknown> }> = []

function summary(id: number, parentConversationId?: number): ConversationSummary {
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
    ...(parentConversationId !== undefined ? { parentConversationId } : {}),
  }
}

// Ancestry: 1 <- 11 <- 111 (two levels); 9 is an unrelated root conversation.
const conversations = [summary(1), summary(11, 1), summary(111, 11), summary(9)]

function ask(id: string, conversationId: number, expectedStateSeq?: number): AskSpec {
  return {
    id,
    conversationId,
    title: `审批 ${id}`,
    fields: [{ name: 'word', label: '词语', type: 'text', required: true }],
    status: 'pending',
    createdAt: Number(conversationId) * 100,
    ...(expectedStateSeq !== undefined ? { expectedStateSeq } : {}),
  }
}

const pendingAsks = [
  ask('ask-root', 1, 7),
  ask('ask-child', 11, 42),
  ask('ask-grand', 111),
  ask('ask-other', 9),
]

function makeStore(overrides: Partial<HelmxStoreValue> = {}): HelmxExternalStore {
  const store = makeTestStore({
    conversations,
    pendingAsks,
    ...overrides,
  })
  ;(store.actions as unknown as { setActiveModal: (modal: ActiveModal) => void }).setActiveModal = (modal) => { activeModal = modal }
  return store
}

function installFetch(status = 200): void {
  posts = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const request = init
    if ((request?.method ?? 'GET') === 'POST') {
      const raw = typeof request?.body === 'string' ? request.body : '{}'
      posts.push({ url, body: JSON.parse(raw) as Record<string, unknown> })
      return new Response(JSON.stringify({ ok: true }), { status, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

async function renderAskDock(store: HelmxExternalStore, conversationId: number): Promise<void> {
  // When rendering multiple times in one test (switching viewpoints), tear down the
  // previous tree first so no stale card DOM lingers.
  if (root !== undefined) act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    root = createRoot(host!)
    root.render(e(TestStoreProvider, { value: store }, e(AskDock, { conversationId })))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
}

/** React controlled inputs need to bypass the native value setter to trigger onChange. */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function cardTitles(): string[] {
  return [...document.querySelectorAll('.ask-dock-title')].map((node) => node.textContent ?? '')
}

function sourceButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.ask-dock-source-btn')]
}

function reset(): void {
  if (root !== undefined) act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ''
  globalThis.fetch = originalFetch
  activeModal = null
  posts = []
}
describe("ask-dock", () => {


  afterEach(reset)

  test('AskDock aggregates pending asks of the current conversation and all descendants; unrelated ones never show', { timeout: 60_000 }, async () => {
    installFetch()
    await renderAskDock(makeStore(), 1)
    assert.deepEqual(cardTitles(), ['审批 ask-root', '审批 ask-child', '审批 ask-grand'], 'shows own + child + grandchild asks')
    assert.equal(cardTitles().includes('审批 ask-other'), false, 'the ask of unrelated conversation #9 must not show')
    // Card main status: one blocked status light with a visible label (no icon-only hover dependency)
    const lights = [...document.querySelectorAll('.ask-dock-header .helmx-status-light')]
    assert.equal(lights.length, 3, 'each ask card renders exactly one status light')
    for (const light of lights) {
      assert.equal(light.getAttribute('data-tone'), 'blocked')
      assert.equal((light.textContent ?? '').length > 0, true, 'status light carries a visible label')
    }
    // Grandchild (#111) viewpoint: itself only, no propagation to parents/siblings
    await renderAskDock(makeStore(), 111)
    assert.deepEqual(cardTitles(), ['审批 ask-grand'], 'a descendant viewpoint aggregates only its own subtree')
  })

  test('descendant asks carry a source badge; the current conversation own card carries none', { timeout: 60_000 }, async () => {
    installFetch()
    await renderAskDock(makeStore(), 1)
    const labels = sourceButtons().map((b) => b.textContent ?? '')
    assert.deepEqual(labels.sort(), ['From #11', 'From #111'], 'both descendant cards carry a source badge')
    const titled = sourceButtons().find((b) => b.textContent === 'From #11')
    assert.ok(titled, 'the child card must have a source button')
    assert.equal((titled!.getAttribute('title') ?? '').includes('会话 11'), true, 'the source button tooltip contains the source conversation title')
  })

  test('清亮化：seq / owner 插件不再是常驻徽章，改为 info 入口 + 可访问 Popover（CAS 提交与来源导航不变）', { timeout: 60_000 }, async () => {
    installFetch()
    const ownerAsks = [
      { ...ask('ask-meta', 1, 7), ownerPluginId: 'builtin:triggers' },
    ]
    await renderAskDock(makeStore({ pendingAsks: ownerAsks }), 1)
    const header = document.querySelector('.ask-dock-header') as HTMLElement | null
    assert.ok(header !== null)
    // 常驻徽章移除：头部不再出现 seq N 文本与 owner 插件徽章。
    assert.equal((header.textContent ?? '').includes('seq'), false, 'seq 不再常驻外露')
    assert.equal((header.textContent ?? '').includes('builtin:triggers'), false, 'owner 插件不再常驻外露')
    assert.equal(header.querySelector('.badge-warn') === null, true, 'owner 不再渲染警示徽章')
    // info 入口为真实按钮。
    const infoBtn = header.querySelector('button.ask-dock-meta-btn') as HTMLButtonElement | null
    assert.ok(infoBtn !== null, '元数据 info 入口为真实按钮')
    // 打开 Popover 后 owner / seq 可见（不依赖 title）。
    await act(async () => { infoBtn.click() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    const popoverText = [...document.querySelectorAll('[data-radix-popper-content-wrapper], .ask-dock-meta-popover')]
      .map((el) => el.textContent ?? '')
      .join('\n')
    assert.ok(popoverText.includes('builtin:triggers'), 'Popover 展示 owner 插件')
    assert.ok(popoverText.includes('7'), 'Popover 展示 CAS seq')
  })

  test('clicking the source badge opens the corresponding child conversation drawer', { timeout: 60_000 }, async () => {
    installFetch()
    const store = makeStore()
    await renderAskDock(store, 1)
    const btn = sourceButtons().find((b) => b.textContent === 'From #11')
    assert.ok(btn)
    await act(async () => { btn!.click() })
    assert.deepEqual(
      store.getDrawerStack(),
      [{ kind: 'conversation', conversationId: 11 }],
      'child conversation #11 drawer opens on the drawer stack',
    )
  })

  test('submitting a descendant ask answer goes through the original asksApi with the CAS watermark', { timeout: 60_000 }, async () => {
    installFetch()
    await renderAskDock(makeStore(), 1)
    // The second card is #11 child conversation's ask-child (expectedStateSeq = 42)
    const cards = [...document.querySelectorAll('.ask-dock')]
    assert.equal(cards.length, 3)
    const childCard = cards[1]
    assert.ok(childCard, 'the child ask card must exist')
    const childInput = childCard.querySelector<HTMLInputElement>('input.input')
    assert.ok(childInput, 'the child ask must render an input')
    await act(async () => { setInputValue(childInput!, 'yes') })
    const submit = [...childCard.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Submit'))
    assert.ok(submit)
    await act(async () => { submit!.click() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    assert.equal(posts.length, 1, 'exactly one answer request is sent')
    const answerPost = posts[0]
    assert.ok(answerPost, 'the answer request must exist')
    assert.equal(answerPost.url, '/api/asks/ask-child/answer')
    assert.deepEqual(answerPost.body, { answers: { word: 'yes' }, expectedStateSeq: 42 }, 'the CAS watermark rides along with the answer')
  })

  test('cancelling a descendant ask goes through the original asksApi cancel', { timeout: 60_000 }, async () => {
    installFetch()
    await renderAskDock(makeStore(), 1)
    const cards = [...document.querySelectorAll('.ask-dock')]
    const grandCard = cards[2]
    assert.ok(grandCard, 'the grandchild ask card must exist')
    const cancel = [...grandCard.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Cancel')
    assert.ok(cancel)
    await act(async () => { cancel!.click() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    assert.equal(posts.length, 1)
    const cancelPost = posts[0]
    assert.ok(cancelPost)
    assert.equal(cancelPost.url, '/api/asks/ask-grand/cancel', 'cancelling the grandchild ask targets its conversation-scoped askId')
  })

  test('the same approval in an ancestor panel and a child drawer keeps form labels per instance', { timeout: 60_000 }, async () => {
    installFetch()
    const store = makeStore({ pendingAsks: [ask('shared-ask', 11, 42)] })
    await renderAskDock(store, 1)
    await act(async () => {
      root?.render(e(TestStoreProvider, { value: store },
        e(React.Fragment, null, e(AskDock, { conversationId: 1 }), e(AskDock, { conversationId: 11 })),
      ))
    })
    const inputs = [...document.querySelectorAll<HTMLInputElement>('.ask-dock input')]
    assert.equal(inputs.length, 2)
    assert.notEqual(inputs[0]!.id, inputs[1]!.id, 'different form instances of the same AskDoc need distinct DOM ids')
    for (const card of document.querySelectorAll('.ask-dock')) {
      assert.equal(card.querySelector('label')?.htmlFor, card.querySelector('input')?.id)
    }
  })

  test('a card disappears immediately once its ask leaves the pending state', { timeout: 60_000 }, async () => {
    installFetch()
    const store = makeStore()
    await renderAskDock(store, 1)
    assert.equal(cardTitles().length, 3)
    // ask-child answered: once pendingAsks drops it, AskDock no longer renders the card
    await act(async () => {
      root?.render(e(TestStoreProvider, {
        value: makeStore({ pendingAsks: pendingAsks.filter((a) => a.id !== 'ask-child') }),
      }, e(AskDock, { conversationId: 1 })))
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    assert.deepEqual(cardTitles(), ['审批 ask-root', '审批 ask-grand'])
  })

  test('zh-CN locale: AskDock renders the Chinese catalog copy', { timeout: 60_000 }, async () => {
    installFetch()
    await renderAskDock(makeStore({ locale: 'zh-CN' }), 1)
    const buttons = [...document.querySelectorAll('.ask-dock-actions button')].map((b) => b.textContent)
    assert.ok(buttons.includes('取消'), 'the cancel button shows the zh-CN copy')
    assert.ok(buttons.includes('提交'), 'the submit button shows the zh-CN copy')
    const badges = sourceButtons().map((b) => b.textContent)
    assert.ok(badges.some((text) => text === '来自 #11'), 'the source badge shows the zh-CN copy')
  })

  test('setLocale switches AskDock copy en -> zh-CN -> en immediately in place', { timeout: 60_000 }, async () => {
    installFetch()
    const host2 = document.createElement('div')
    document.body.appendChild(host2)
    let committedLocale: HelmxLocale = 'en'
    function Harness(): React.JSX.Element {
      const [locale, setLocale] = React.useState<HelmxLocale>('en')
      committedLocale = locale
      const store = React.useMemo(() => makeStore({ locale, setLocale }), [locale])
      return e(TestStoreProvider, { value: store },
        e(AskDock, { conversationId: 1 }),
        e('button', { type: 'button', onClick: () => setLocale(locale === 'en' ? 'zh-CN' : 'en') }, 'switch-locale'))
    }
    const harnessRoot = createRoot(host2)
    try {
      await act(async () => { harnessRoot.render(e(Harness)) })
      const submitEn = [...host2.querySelectorAll('.ask-dock-actions button')].map((b) => b.textContent)
      assert.ok(submitEn.includes('Submit'), 'renders the en catalog copy by default')

      const switchBtn = [...host2.querySelectorAll('button')].find((b) => b.textContent === 'switch-locale') as HTMLButtonElement
      await act(async () => { switchBtn.click() })
      assert.equal(committedLocale, 'zh-CN')
      const submitZh = [...host2.querySelectorAll('.ask-dock-actions button')].map((b) => b.textContent)
      assert.ok(submitZh.includes('提交'), 'locale switch re-renders AskDock in place with zh-CN copy')
      assert.ok(submitZh.includes('取消'), 'the cancel button switched too')

      await act(async () => { switchBtn.click() })
      assert.equal(committedLocale, 'en')
      const submitBack = [...host2.querySelectorAll('.ask-dock-actions button')].map((b) => b.textContent)
      assert.ok(submitBack.includes('Submit'), 'switching back to en restores English immediately')
    } finally {
      await act(async () => { harnessRoot.unmount() })
      host2.remove()
    }
  })

  test('description stays visible with context terminalSnapshot, fenced snapshot strips delimiters, and single-confirm supports 1-click Approve/Reject', { timeout: 60_000 }, async () => {
    installFetch()
    const richAsks: AskSpec[] = [
      {
        id: 'ask-ctx',
        conversationId: 1,
        title: 'Run shell command?',
        description: 'Needs confirmation before running rm -rf build/',
        context: { terminalSnapshot: '$ ls -la\nbuild/' },
        fields: [{ name: 'approve', label: 'Decision', type: 'confirm', required: true }],
        status: 'pending',
        expectedStateSeq: 19,
        createdAt: 100,
      } as AskSpec,
      {
        id: 'ask-fence',
        conversationId: 1,
        title: 'Review output',
        description: 'Summary line before fence\n\n```text\nline-1\nline-2\n```',
        fields: [{ name: 'note', label: 'Note', type: 'text', required: true }],
        status: 'pending',
        createdAt: 200,
      },
    ]
    await renderAskDock(makeStore({ pendingAsks: richAsks }), 1)
    const cards = [...document.querySelectorAll<HTMLFormElement>('form.ask-dock')]
    assert.equal(cards.length, 2, 'AskCard renders as a semantic <form>')

    // 1. Context snapshot does NOT hide ask.description; single-confirm hides redundant Submit button
    //    and renders confirm Field as role="group" + aria-labelledby (no orphan <label>), with StatusLight tone="blocked".
    const ctxCard = cards[0]!
    assert.equal(
      ctxCard.querySelector('.ask-dock-header .helmx-status-light')?.getAttribute('data-tone'),
      'blocked',
      'AskCard header StatusLight uses strongly-typed tone="blocked"',
    )
    const confirmField = ctxCard.querySelector('.ask-dock-field')
    assert.equal(confirmField?.getAttribute('role'), 'group', 'confirm Field uses role="group" instead of orphan <label>')
    const confirmLabelId = confirmField?.getAttribute('aria-labelledby') ?? ''
    assert.ok(confirmLabelId !== '', 'confirm Field exposes aria-labelledby')
    assert.equal(ctxCard.querySelector(`#${CSS.escape(confirmLabelId)}`)?.textContent, 'Decision')
    assert.match(ctxCard.querySelector('.ask-dock-desc')?.textContent ?? '', /Needs confirmation before running rm -rf build\//)
    const ctxSubmitBtns = [...ctxCard.querySelectorAll('.ask-dock-actions button')].filter((b) =>
      b.textContent?.includes('Submit'),
    )
    assert.equal(ctxSubmitBtns.length, 0, 'single-confirm ask omits redundant Submit button')

    // 1-click Approve submits immediately with CAS watermark
    const approveBtn = [...ctxCard.querySelectorAll<HTMLButtonElement>('.ask-dock-confirm-actions button')].find((b) =>
      b.textContent?.includes('Approve'),
    )!
    assert.ok(approveBtn !== undefined)
    await act(async () => {
      approveBtn.click()
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    assert.equal(posts.length, 1)
    assert.equal(posts[0]!.url, '/api/asks/ask-ctx/answer')
    assert.deepEqual(posts[0]!.body, { answers: { approve: 'true' }, expectedStateSeq: 19 })

    // 2. Fenced snapshot strips fence delimiters and keeps prefix description; Enter submits form
    const fenceCard = cards[1]!
    assert.equal(fenceCard.querySelector('.ask-dock-desc')?.textContent, 'Summary line before fence')
    const snapToggle = fenceCard.querySelector<HTMLButtonElement>('.ask-dock-snapshot-btn')!
    await act(async () => {
      snapToggle.click()
    })
    const snapText = fenceCard.querySelector('.ask-dock-snapshot-pre code')?.textContent ?? ''
    assert.equal(snapText, 'line-1\nline-2', 'fenced snapshot strips opening and closing triple backticks')
    assert.equal(snapText.includes('```'), false)

    const noteInput = fenceCard.querySelector<HTMLInputElement>('input.input')!
    await act(async () => {
      setInputValue(noteInput, 'looks good')
    })
    await act(async () => {
      fenceCard.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    assert.equal(posts.length, 2)
    assert.equal(posts[1]!.url, '/api/asks/ask-fence/answer')
    assert.deepEqual(posts[1]!.body, { answers: { note: 'looks good' } })
  })

  test('LocalizedText AskSpec renders zh-CN title/description/labels/select options/input placeholder and switches live to en across AskDock and ResolvedAskRow', { timeout: 60_000 }, async () => {
    installFetch()
    const bilingualAsk: AskSpec = {
      id: 'ask-plan-i18n',
      conversationId: 1,
      ownerPluginId: 'builtin:plan',
      title: { en: 'Plan Approval v1: Refactor Auth', 'zh-CN': '计划审批 v1：Refactor Auth' },
      description: { en: 'English summary', 'zh-CN': '中文方案摘要' },
      fields: [
        {
          name: 'decision',
          label: { en: 'Decision', 'zh-CN': '审批决策' },
          type: 'select',
          required: true,
          options: [
            { value: 'approve', label: { en: 'Approve & keep current context', 'zh-CN': '批准并保留当前上下文' } },
            { value: 'revise', label: { en: 'Request revisions', 'zh-CN': '要求修订方案' } },
          ],
        },
        {
          name: 'feedback',
          label: { en: 'Feedback (optional)', 'zh-CN': '补充意见（可选）' },
          type: 'text',
          required: false,
        },
      ],
      status: 'pending',
      createdAt: 300,
    }
    const host2 = document.createElement('div')
    document.body.appendChild(host2)
    function Harness(): React.JSX.Element {
      const [locale, setLocale] = React.useState<HelmxLocale>('zh-CN')
      const store = React.useMemo(
        () => makeStore({ locale, setLocale, pendingAsks: [bilingualAsk] }),
        [locale],
      )
      return e(
        TestStoreProvider,
        { value: store },
        e(AskDock, { conversationId: 1 }),
        e(ResolvedAskRow, { ask: bilingualAsk, status: 'answered' }),
        e('button', { type: 'button', onClick: () => setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN') }, 'toggle-locale'),
      )
    }
    const harnessRoot = createRoot(host2)
    try {
      await act(async () => {
        harnessRoot.render(e(Harness))
      })

      assert.equal(host2.querySelector('.ask-dock-title')?.textContent, '计划审批 v1：Refactor Auth')
      assert.equal(host2.querySelector('.ask-dock-desc')?.textContent, '中文方案摘要')
      const fieldLabelsZh = [...host2.querySelectorAll('.ask-dock-field label')].map((el) => el.textContent ?? '')
      assert.ok(fieldLabelsZh.some((text) => text.includes('审批决策')))
      assert.ok(fieldLabelsZh.some((text) => text.includes('补充意见（可选）')))
      assert.equal(host2.querySelector<HTMLInputElement>('input.input')?.placeholder, '补充意见（可选）')

      // Open select trigger in happy-dom and choose the localized 'approve' option
      const selectTrigger = host2.querySelector<HTMLButtonElement>('.helmx-select-trigger')!
      assert.ok(selectTrigger !== null)
      await act(async () => {
        selectTrigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      const zhOptions = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((el) => el.textContent ?? '')
      assert.ok(zhOptions.some((text) => text.includes('批准并保留当前上下文')), `expected zh-CN select option, got ${zhOptions.join(', ')}`)
      assert.ok(zhOptions.some((text) => text.includes('要求修订方案')))

      const approveOpt = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((el) =>
        (el.textContent ?? '').includes('批准并保留当前上下文'),
      )!
      await act(async () => {
        approveOpt.click()
      })
      assert.equal(selectTrigger.querySelector('.helmx-select-label')?.textContent, '批准并保留当前上下文')

      // ResolvedAskRow renders bilingual title and expanded description
      const traceBtn = host2.querySelector<HTMLButtonElement>('.trace-row')!
      assert.equal(traceBtn.querySelector('.trace-tool-summary')?.textContent, '计划审批 v1：Refactor Auth')
      await act(async () => {
        traceBtn.click()
      })
      assert.equal(host2.querySelector('.trace-expanded-body')?.textContent, '中文方案摘要')

      // Live locale toggle zh-CN -> en updates AskDock + selected trigger label + ResolvedAskRow in place
      const toggleBtn = [...host2.querySelectorAll('button')].find((b) => b.textContent === 'toggle-locale')!
      await act(async () => {
        toggleBtn.click()
      })
      assert.equal(host2.querySelector('.ask-dock-title')?.textContent, 'Plan Approval v1: Refactor Auth')
      assert.equal(host2.querySelector('.ask-dock-desc')?.textContent, 'English summary')
      assert.equal(host2.querySelector<HTMLInputElement>('input.input')?.placeholder, 'Feedback (optional)')
      assert.equal(selectTrigger.querySelector('.helmx-select-label')?.textContent, 'Approve & keep current context')
      assert.equal(traceBtn.querySelector('.trace-tool-summary')?.textContent, 'Plan Approval v1: Refactor Auth')
      assert.equal(host2.querySelector('.trace-expanded-body')?.textContent, 'English summary')
    } finally {
      await act(async () => {
        harnessRoot.unmount()
      })
      host2.remove()
    }
  })

  test('choice radio group, model picker field, defaultValue prefill, and hint rendering work together cleanly', { timeout: 60_000 }, async () => {
    installFetch()
    const choiceAsk: AskSpec = {
      id: 'ask-rich-fields',
      conversationId: 1,
      title: 'Clarify Execution',
      hint: 'Reply directly in composer if you want to skip this form.',
      fields: [
        {
          name: 'strategy',
          label: 'Strategy',
          type: 'choice',
          required: true,
          defaultValue: 'handoff',
          options: [
            {
              label: 'Fresh context',
              description: 'Clears planning noise before execution.',
              value: 'handoff',
            },
            {
              label: 'Same session',
              description: 'Continues in the current thread.',
              value: 'same',
            },
          ],
        },
        {
          name: 'executionModel',
          label: 'Execution Model',
          type: 'model',
          defaultValue: 'openai/gpt-5',
        },
        {
          name: 'secondaryModel',
          label: 'Fallback Model',
          type: 'model',
        },
      ],
      status: 'pending',
      createdAt: 100,
    }
    await renderAskDock(makeStore({ pendingAsks: [choiceAsk] }), 1)

    const radioGroup = document.querySelector('[role="radiogroup"]')
    assert.ok(radioGroup !== null, 'choice field renders a radiogroup')
    const radios = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    assert.equal(radios.length, 2)
    assert.equal(radios[0]?.getAttribute('aria-checked'), 'true', 'defaultValue pre-selects the matching radio option')
    assert.equal(radios[1]?.getAttribute('aria-checked'), 'false')
    assert.match(radios[0]?.textContent ?? '', /Clears planning noise before execution\./)

    const hintEl = document.querySelector('.ask-dock-hint')
    assert.equal(hintEl?.textContent, 'Reply directly in composer if you want to skip this form.')

    const modelButtons = [...document.querySelectorAll<HTMLButtonElement>('button.composer-model-button')]
    assert.equal(modelButtons.length, 2, 'each model field renders a ModelPickerControl button')
    assert.match(modelButtons[0]?.textContent ?? '', /gpt-5/, 'model field honors defaultValue')
    assert.match(modelButtons[1]?.textContent ?? '', /Keep current/, 'blank model field renders Keep current placeholder')

    await act(async () => {
      radios[1]?.click()
    })
    assert.equal(radios[0]?.getAttribute('aria-checked'), 'false')
    assert.equal(radios[1]?.getAttribute('aria-checked'), 'true')

    const submitBtn = [...document.querySelectorAll<HTMLButtonElement>('button[type="submit"]')][0]
    assert.ok(submitBtn && !submitBtn.disabled)
    await act(async () => {
      submitBtn.click()
    })
    assert.equal(posts.length, 1)
    assert.equal(posts[0]?.url, '/api/asks/ask-rich-fields/answer')
    assert.deepEqual(posts[0]?.body, {
      answers: {
        strategy: 'same',
        executionModel: 'openai/gpt-5',
      },
    })
  })
})
