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
const { TraceRow } = await import('../src/conversation/TimelineRows.js')
const { ToolExpandedBody } = await import('../src/conversation/ToolExpandedBody.js')
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

async function renderAskDock(
  store: HelmxExternalStore,
  conversationId: number,
  onFocusReturn?: () => void,
): Promise<void> {
  // When rendering multiple times in one test (switching viewpoints), tear down the
  // previous tree first so no stale card DOM lingers.
  if (root !== undefined) act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    root = createRoot(host!)
    root.render(
      e(
        TestStoreProvider,
        { value: store },
        e(AskDock, { conversationId, ...(onFocusReturn !== undefined ? { onFocusReturn } : {}) }),
      ),
    )
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
    assert.equal(document.querySelectorAll('.ask-dock-header .helmx-status-light').length, 0, 'minimalist header omits StatusLight chrome')
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

  test('minimalist header omits ownerPluginId, seq, and metadata info popover chrome', { timeout: 60_000 }, async () => {
    installFetch()
    const ownerAsks = [
      { ...ask('ask-meta', 1, 7), ownerPluginId: 'builtin:triggers' },
    ]
    await renderAskDock(makeStore({ pendingAsks: ownerAsks }), 1)
    const header = document.querySelector('.ask-dock-header') as HTMLElement | null
    assert.ok(header !== null)
    assert.equal((header.textContent ?? '').includes('seq'), false, 'seq 不再暴露在 header')
    assert.equal((header.textContent ?? '').includes('builtin:triggers'), false, 'owner 插件不再暴露在 header')
    assert.ok(header.querySelector('.badge-warn') === null)
    assert.ok(header.querySelector('.ask-dock-meta-btn') === null, 'metadata info popover button removed')
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
    //    and renders confirm Field as role="group" + aria-labelledby (no orphan <label>).
    const ctxCard = cards[0]!
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

  test('LocalizedText AskSpec renders zh-CN title/description/labels/select options/input placeholder and switches live to en across AskDock', { timeout: 60_000 }, async () => {
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

      // Live locale toggle zh-CN -> en updates AskDock + selected trigger label in place
      const toggleBtn = [...host2.querySelectorAll('button')].find((b) => b.textContent === 'toggle-locale')!
      await act(async () => {
        toggleBtn.click()
      })
      assert.equal(host2.querySelector('.ask-dock-title')?.textContent, 'Plan Approval v1: Refactor Auth')
      assert.equal(host2.querySelector('.ask-dock-desc')?.textContent, 'English summary')
      assert.equal(host2.querySelector<HTMLInputElement>('input.input')?.placeholder, 'Feedback (optional)')
      assert.equal(selectTrigger.querySelector('.helmx-select-label')?.textContent, 'Approve & keep current context')
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

  test('choice radiogroup implements WAI-ARIA roving tabIndex and Arrow/Home/End keyboard navigation', { timeout: 60_000 }, async () => {
    installFetch()
    const multiChoiceAsk: AskSpec = {
      id: 'ask-choice-kbd',
      conversationId: 1,
      title: 'Pick Execution Mode',
      fields: [
        {
          name: 'mode',
          label: 'Mode',
          type: 'choice',
          required: true,
          options: [
            { value: 'alpha', label: 'Alpha' },
            { value: 'beta', label: 'Beta' },
            { value: 'gamma', label: 'Gamma' },
          ],
        },
      ],
      status: 'pending',
      createdAt: 100,
    }
    await renderAskDock(makeStore({ pendingAsks: [multiChoiceAsk] }), 1)

    const radios = [...document.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] [role="radio"]')]
    assert.equal(radios.length, 3)

    // With no initial selection, index 0 receives tabIndex=0 and all others receive -1
    assert.deepEqual(radios.map((r) => r.tabIndex), [0, -1, -1], 'first option is the sole tab stop when unselected')
    assert.deepEqual(radios.map((r) => r.getAttribute('aria-checked')), ['false', 'false', 'false'])

    const press = async (target: HTMLButtonElement, key: string, extra: KeyboardEventInit = {}): Promise<KeyboardEvent> => {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })
      await act(async () => {
        target.dispatchEvent(ev)
      })
      return ev
    }

    radios[0]!.focus()
    assert.ok(document.activeElement === radios[0])

    // ArrowDown: 0 -> 1
    const downEv = await press(radios[0]!, 'ArrowDown')
    assert.equal(downEv.defaultPrevented, true)
    assert.ok(document.activeElement === radios[1], 'ArrowDown moves DOM focus to next option')
    assert.deepEqual(radios.map((r) => r.tabIndex), [-1, 0, -1], 'roving tabIndex tracks selected option')
    assert.deepEqual(radios.map((r) => r.getAttribute('aria-checked')), ['false', 'true', 'false'])

    // ArrowRight: 1 -> 2
    const rightEv = await press(radios[1]!, 'ArrowRight')
    assert.equal(rightEv.defaultPrevented, true)
    assert.ok(document.activeElement === radios[2], 'ArrowRight moves DOM focus to next option')
    assert.deepEqual(radios.map((r) => r.tabIndex), [-1, -1, 0])

    // ArrowDown wraps: 2 -> 0
    const wrapDownEv = await press(radios[2]!, 'ArrowDown')
    assert.equal(wrapDownEv.defaultPrevented, true)
    assert.ok(document.activeElement === radios[0], 'ArrowDown wraps from last to first option')
    assert.deepEqual(radios.map((r) => r.tabIndex), [0, -1, -1])

    // ArrowUp wraps: 0 -> 2
    const wrapUpEv = await press(radios[0]!, 'ArrowUp')
    assert.equal(wrapUpEv.defaultPrevented, true)
    assert.ok(document.activeElement === radios[2], 'ArrowUp wraps from first to last option')
    assert.deepEqual(radios.map((r) => r.tabIndex), [-1, -1, 0])

    // ArrowLeft: 2 -> 1
    const leftEv = await press(radios[2]!, 'ArrowLeft')
    assert.equal(leftEv.defaultPrevented, true)
    assert.ok(document.activeElement === radios[1], 'ArrowLeft moves DOM focus to previous option')
    assert.deepEqual(radios.map((r) => r.tabIndex), [-1, 0, -1])

    // Home -> 0, End -> 2
    const homeEv = await press(radios[1]!, 'Home')
    assert.equal(homeEv.defaultPrevented, true)
    assert.ok(document.activeElement === radios[0], 'Home moves DOM focus to first option')
    assert.deepEqual(radios.map((r) => r.tabIndex), [0, -1, -1])

    const endEv = await press(radios[0]!, 'End')
    assert.equal(endEv.defaultPrevented, true)
    assert.ok(document.activeElement === radios[2], 'End moves DOM focus to last option')
    assert.deepEqual(radios.map((r) => r.tabIndex), [-1, -1, 0])

    // Modifier-held arrow key is ignored (does not hijack browser shortcuts)
    const altLeftEv = await press(radios[2]!, 'ArrowLeft', { altKey: true })
    assert.equal(altLeftEv.defaultPrevented, false)
    assert.ok(document.activeElement === radios[2])
    assert.deepEqual(radios.map((r) => r.getAttribute('aria-checked')), ['false', 'false', 'true'])

    // Submitting sends the keyboard-selected value ('gamma')
    const submitBtn = document.querySelector<HTMLButtonElement>('button[type="submit"]')!
    await act(async () => {
      submitBtn.click()
    })
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0]?.body, { answers: { mode: 'gamma' } })
  })

  test('choice radiogroup pre-selected defaultValue gets initial tabIndex=0 and ignores arrow keys while submitting (disabled)', { timeout: 60_000 }, async () => {
    let releaseAnswer!: () => void
    const gate = new Promise<void>((resolve) => { releaseAnswer = resolve })
    posts = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if ((init?.method ?? 'GET') === 'POST') {
        const raw = typeof init?.body === 'string' ? init.body : '{}'
        posts.push({ url, body: JSON.parse(raw) as Record<string, unknown> })
        await gate
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const preselectedAsk: AskSpec = {
      id: 'ask-choice-default',
      conversationId: 1,
      title: 'Confirm Target',
      fields: [
        {
          name: 'target',
          label: 'Target',
          type: 'choice',
          required: true,
          defaultValue: 'second',
          options: [
            { value: 'first', label: 'First' },
            { value: 'second', label: 'Second' },
          ],
        },
      ],
      status: 'pending',
      createdAt: 100,
    }
    await renderAskDock(makeStore({ pendingAsks: [preselectedAsk] }), 1)

    const radios = [...document.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] [role="radio"]')]
    assert.deepEqual(radios.map((r) => r.tabIndex), [-1, 0], 'selected defaultValue option receives tabIndex=0')
    assert.deepEqual(radios.map((r) => r.getAttribute('aria-checked')), ['false', 'true'])

    // Trigger submit so radios become disabled while in flight
    const submitBtn = document.querySelector<HTMLButtonElement>('button[type="submit"]')!
    await act(async () => {
      submitBtn.click()
    })
    assert.equal(radios[1]?.disabled, true)

    const ev = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
    await act(async () => {
      radios[1]!.dispatchEvent(ev)
    })
    assert.equal(ev.defaultPrevented, false, 'disabled radiogroup ignores arrow navigation')
    assert.deepEqual(radios.map((r) => r.getAttribute('aria-checked')), ['false', 'true'])

    releaseAnswer()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  })

  test('model field with thinkingLevelField shows thinking chips, updates both answers atomically, and resets both', { timeout: 60_000 }, async () => {
    installFetch()
    const thinkingAsk: AskSpec = {
      id: 'ask-model-thinking',
      conversationId: 1,
      title: 'Approve With Thinking Level',
      fields: [
        {
          name: 'decision',
          label: 'Decision',
          type: 'choice',
          required: true,
          defaultValue: 'approve_handoff',
          options: [{ label: 'Approve', value: 'approve_handoff' }],
        },
        {
          name: 'executionModel',
          label: 'Execution Model',
          type: 'model',
          defaultValue: 'openai/gpt-5',
          thinkingLevelField: 'executionThinkingLevel',
        },
      ],
      status: 'pending',
      createdAt: 100,
    }
    const store = makeStore({
      pendingAsks: [thinkingAsk],
      models: [
        {
          id: 'openai/gpt-5',
          provider: 'openai',
          modelId: 'gpt-5',
          label: 'GPT-5',
          available: true,
          contextWindow: 200_000,
          thinkingLevels: ['off', 'low', 'medium', 'high'],
        },
      ],
    })
    await renderAskDock(store, 1)

    const modelBtn = document.querySelector<HTMLButtonElement>('button.composer-model-button')
    assert.ok(modelBtn !== null)
    assert.match(modelBtn.textContent ?? '', /gpt-5/)

    // Open ModelPickerControl popover
    await act(async () => {
      modelBtn.click()
    })
    const levelChips = [...document.querySelectorAll<HTMLButtonElement>('.composer-model-level-chip')]
    assert.deepEqual(
      levelChips.map((c) => c.textContent?.trim()),
      ['off', 'low', 'medium', 'high'],
      'thinkingLevelField enables inline thinking level chips in AskDock model picker',
    )

    const highChip = levelChips.find((c) => c.textContent?.trim() === 'high')!
    await act(async () => {
      highChip.click()
    })
    assert.match(modelBtn.textContent ?? '', /gpt-5/)
    assert.match(modelBtn.textContent ?? '', /high/)

    // Submit includes both executionModel and executionThinkingLevel
    const submitBtn = [...document.querySelectorAll<HTMLButtonElement>('button[type="submit"]')][0]!
    await act(async () => {
      submitBtn.click()
    })
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0]?.body, {
      answers: {
        decision: 'approve_handoff',
        executionModel: 'openai/gpt-5',
        executionThinkingLevel: 'high',
      },
    })

    // Reopen and click resetDefault -> clears BOTH executionModel and executionThinkingLevel
    await act(async () => {
      modelBtn.click()
    })
    const resetItem = [...document.querySelectorAll<HTMLButtonElement>('.composer-model-popover .composer-model-reset')][0]!
    assert.ok(resetItem !== undefined)
    await act(async () => {
      resetItem.click()
    })
    assert.match(modelBtn.textContent ?? '', /Keep current/)
    assert.equal((modelBtn.textContent ?? '').includes('high'), false)
    await act(async () => {
      submitBtn.click()
    })
    assert.equal(posts.length, 2)
    assert.deepEqual(posts[1]?.body, {
      answers: {
        decision: 'approve_handoff',
        executionModel: '',
        executionThinkingLevel: '',
      },
    })
  })

  test('minimalist question AskDock hides empty radio circles, promotes generic single-question label, and submits immediately on click', { timeout: 60_000 }, async () => {
    installFetch()
    const genericSingleAsk: AskSpec = {
      id: 'ask-q-generic',
      conversationId: 1,
      ownerPluginId: 'core:ask_user',
      kind: 'question',
      title: { en: 'Clarifying Questions', 'zh-CN': '问题确认' },
      fields: [
        {
          name: 'framework',
          label: 'Which framework should we scaffold?',
          type: 'choice',
          required: true,
          options: [
            { value: 'react', label: 'React', recommended: true, description: 'Team default' },
            { value: 'vue', label: 'Vue', description: 'Lightweight SPA' },
          ],
        },
      ],
      status: 'pending',
      createdAt: 100,
    }
    await renderAskDock(makeStore({ pendingAsks: [genericSingleAsk] }), 1)

    const card = document.querySelector<HTMLFormElement>('form.ask-dock')!
    assert.ok(card.classList.contains('ask-dock--question'))
    assert.equal(card.getAttribute('data-ask-kind'), 'question')
    assert.equal(document.querySelectorAll('.ask-dock-choice-radio').length, 0)
    assert.equal(card.querySelectorAll('.ask-dock-choice-check').length, 0, 'unselected single-select omits trailing circle/check placeholder')
    assert.ok(card.querySelector('.ask-dock-header .helmx-status-light') === null)
    assert.equal(card.querySelector('.ask-dock-title')?.textContent, 'Which framework should we scaffold?')
    assert.equal(card.querySelectorAll('.ask-dock-field label').length, 0, 'generic single-question header avoids duplicate field label')

    assert.deepEqual(
      [...card.querySelectorAll('.ask-dock-choice-key')].map((el) => el.textContent),
      ['1', '2'],
    )
    assert.match(card.querySelector('.ask-dock-choice-badge')?.textContent ?? '', /Recommended/)

    const actionLabels = [...card.querySelectorAll<HTMLButtonElement>('.ask-dock-actions button')].map((b) =>
      b.textContent?.trim(),
    )
    assert.ok(actionLabels.includes('Skip'))
    assert.ok(actionLabels.includes('Confirm'))

    // Option 1A: clicking a preset option in single-question single-select question submits immediately
    const radios = [...card.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    await act(async () => {
      radios[1]!.click()
    })
    assert.equal(radios[1]?.getAttribute('aria-checked'), 'true')
    assert.equal(card.querySelectorAll('.ask-dock-choice-check').length, 1, 'only the selected single-select row renders a check mark')
    assert.equal(posts.length, 1, 'clicking single-question choice submits immediately')
    assert.deepEqual(posts[0]?.body, { answers: { framework: 'vue' } })
  })

  test('multi-select choice uses role=checkbox, supports inline Other custom input + IME Enter guard, and submits string[]', { timeout: 60_000 }, async () => {
    installFetch()
    const multiAsk: AskSpec = {
      id: 'ask-q-multi',
      conversationId: 1,
      kind: 'question',
      title: 'Capabilities',
      fields: [
        {
          name: 'features',
          label: 'Select features to enable',
          type: 'choice',
          multiple: true,
          allowCustom: true,
          required: true,
          placeholder: 'Add custom capability...',
          options: [
            { value: 'auth', label: 'Authentication' },
            { value: 'db', label: 'Database' },
          ],
        },
      ],
      status: 'pending',
      createdAt: 100,
    }
    await renderAskDock(makeStore({ pendingAsks: [multiAsk] }), 1)

    const group = document.querySelector('[role="group"]')
    assert.ok(group !== null)
    const boxes = [...document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')]
    assert.equal(boxes.length, 3, 'two preset options + Other custom option')

    await act(async () => {
      boxes[0]!.click()
    })
    await act(async () => {
      boxes[1]!.click()
    })
    assert.equal(boxes[0]?.getAttribute('aria-checked'), 'true')
    assert.equal(boxes[1]?.getAttribute('aria-checked'), 'true')

    await act(async () => {
      boxes[2]!.click()
    })
    assert.equal(boxes[2]?.getAttribute('aria-checked'), 'true')
    const customInput = document.querySelector<HTMLInputElement>('.ask-dock-choice-custom input.input')!
    assert.ok(customInput !== null)
    assert.equal(customInput.placeholder, 'Add custom capability...')
    assert.ok(document.activeElement === customInput, 'activating Other focuses the inline custom input')

    await act(async () => {
      setInputValue(customInput, 'audit-log')
    })
    const composingEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    })
    await act(async () => {
      customInput.dispatchEvent(composingEnter)
    })
    assert.equal(composingEnter.defaultPrevented, true, 'IME composing Enter must not submit')
    assert.equal(posts.length, 0)

    const submitBtn = document.querySelector<HTMLButtonElement>('button[type="submit"]')!
    await act(async () => {
      submitBtn.click()
    })
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0]?.body, {
      answers: {
        features: ['auth', 'db', 'audit-log'],
      },
    })
  })

  test('digit shortcuts 1-9 select preset or activate Other without stealing focus inside inputs', { timeout: 60_000 }, async () => {
    installFetch()
    const customSingleAsk: AskSpec = {
      id: 'ask-q-digits',
      conversationId: 1,
      kind: 'question',
      title: 'Target Runtime',
      fields: [
        {
          name: 'runtime',
          label: 'Runtime',
          type: 'choice',
          allowCustom: true,
          required: true,
          options: [
            { value: 'node', label: 'Node.js' },
            { value: 'deno', label: 'Deno' },
          ],
        },
      ],
      status: 'pending',
      createdAt: 100,
    }
    await renderAskDock(makeStore({ pendingAsks: [customSingleAsk] }), 1)

    const card = document.querySelector<HTMLFormElement>('form.ask-dock')!
    const radios = [...card.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    card.focus()

    await act(async () => {
      card.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }))
    })
    assert.equal(radios[1]?.getAttribute('aria-checked'), 'true')
    assert.equal(posts.length, 0)

    // Key 3 activates "Other" inline input and focuses it
    await act(async () => {
      card.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true, cancelable: true }))
    })
    const customInput = card.querySelector<HTMLInputElement>('.ask-dock-choice-custom input.input')!
    assert.ok(customInput !== null)
    assert.ok(document.activeElement === customInput)

    // Digit key typed inside input must NOT jump back to preset option 1
    await act(async () => {
      customInput.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }))
    })
    assert.equal(radios[0]?.getAttribute('aria-checked'), 'false')

    await act(async () => {
      setInputValue(customInput, 'bun')
    })
    await act(async () => {
      customInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0]?.body, { answers: { runtime: 'bun' } })
  })

  test('multi-question prompt renders 1/N stepper, hides inactive steps, auto-advances on single-select click, and submits via Confirm', { timeout: 60_000 }, async () => {
    installFetch()
    const stepperAsk: AskSpec = {
      id: 'ask-q-stepper',
      conversationId: 1,
      kind: 'question',
      title: 'Service Wizard',
      fields: [
        {
          name: 'transport',
          label: 'Transport',
          type: 'choice',
          required: true,
          options: [
            { value: 'http', label: 'HTTP' },
            { value: 'grpc', label: 'gRPC' },
          ],
        },
        {
          name: 'addons',
          label: 'Add-ons',
          type: 'choice',
          multiple: true,
          required: true,
          options: [
            { value: 'metrics', label: 'Metrics' },
            { value: 'tracing', label: 'Tracing' },
          ],
        },
        {
          name: 'notes',
          label: 'Notes',
          type: 'text',
          multiline: true,
          required: false,
          placeholder: 'Optional rollout notes',
        },
      ],
      status: 'pending',
      createdAt: 100,
    }
    await renderAskDock(makeStore({ pendingAsks: [stepperAsk] }), 1)

    const card = document.querySelector<HTMLFormElement>('form.ask-dock')!
    const counter = () => card.querySelector('.ask-dock-step-counter')?.textContent?.trim()
    const panels = [...card.querySelectorAll<HTMLElement>('.ask-dock-step-panel')]
    assert.equal(counter(), '1 / 3')
    assert.deepEqual(panels.map((p) => p.hidden), [false, true, true])

    // Arrow key navigation on step 0 does NOT skip ahead
    const step0Radios = [...panels[0]!.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    await act(async () => {
      step0Radios[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    assert.equal(counter(), '1 / 3')

    // Explicit click on preset option auto-advances to next unanswered step (2 / 3)
    await act(async () => {
      step0Radios[0]!.click()
    })
    assert.equal(counter(), '2 / 3')
    assert.deepEqual(panels.map((p) => p.hidden), [true, false, true])

    // Multi-select step lets user toggle multiple without jumping away
    const step1Boxes = [...panels[1]!.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')]
    await act(async () => {
      step1Boxes[0]!.click()
    })
    await act(async () => {
      step1Boxes[1]!.click()
    })
    assert.equal(counter(), '2 / 3')

    // Header step-nav Previous returns to 1 / 3; Next advances to 2 / 3 and 3 / 3
    assert.equal(card.querySelectorAll('.ask-dock-step-pill').length, 0, 'heavy second-row step pills removed')
    const prevBtn = card.querySelector<HTMLButtonElement>('.ask-dock-step-nav-btn[aria-label="Previous"]')!
    const nextBtn = card.querySelector<HTMLButtonElement>('.ask-dock-step-nav-btn[aria-label="Next"]')!
    await act(async () => {
      prevBtn.click()
    })
    assert.equal(counter(), '1 / 3')

    await act(async () => {
      nextBtn.click()
    })
    assert.equal(counter(), '2 / 3')
    await act(async () => {
      nextBtn.click()
    })
    assert.equal(counter(), '3 / 3')
    const textarea = panels[2]!.querySelector<HTMLTextAreaElement>('textarea.textarea')!
    assert.ok(textarea !== null)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'canary first')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const confirmBtn = card.querySelector<HTMLButtonElement>('button[type="submit"]')!
    await act(async () => {
      confirmBtn.click()
    })
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0]?.body, {
      answers: {
        transport: 'http',
        addons: ['metrics', 'tracing'],
        notes: 'canary first',
      },
    })
  })

  test('TraceRow renders chronological ask_user prompts (running, answered inline summary + clean Q&A without Raw JSON, skipped, superseded)', { timeout: 60_000 }, async () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host!)
      root.render(
        e(
          TestStoreProvider,
          { value: makeStore() },
          e('div', null,
            e(TraceRow, {
              conversationId: 1,
              defaultOpen: false,
              tool: {
                key: 'tool:ask_user:running',
                toolName: 'ask_user',
                callId: 'call-run',
                status: 'running',
                isError: false,
                input: { questions: [{ id: 'db', question: 'Pick engine' }] },
              },
            }),
            e(TraceRow, {
              conversationId: 1,
              defaultOpen: false,
              tool: {
                key: 'tool:ask_user:answered',
                toolName: 'ask_user',
                callId: 'call-ans',
                status: 'done',
                isError: false,
                presentationMeta: {
                  title: 'Clarifying Questions',
                  questionCount: 1,
                  outcome: 'answered',
                  items: [{ id: 'db', question: 'Engine?', answer: 'sqlite (SQLite)' }],
                },
              },
            }),
            e(TraceRow, {
              conversationId: 1,
              defaultOpen: false,
              tool: {
                key: 'tool:ask_user:cancelled',
                toolName: 'ask_user',
                callId: 'call-cancel',
                status: 'done',
                isError: false,
                presentationMeta: {
                  title: 'Optional Note',
                  questionCount: 1,
                  outcome: 'cancelled',
                },
              },
            }),
            e(TraceRow, {
              conversationId: 1,
              defaultOpen: false,
              tool: {
                key: 'tool:ask_user:superseded',
                toolName: 'ask_user',
                callId: 'call-sup',
                status: 'done',
                isError: false,
                presentationMeta: {
                  title: 'Old Prompt',
                  questionCount: 1,
                  outcome: 'superseded',
                },
              },
            }),
            e(ToolExpandedBody, {
              conversationId: 1,
              tool: {
                key: 'tool:ask_user:named',
                toolName: 'ask_user',
                callId: 'call-named',
                status: 'done',
                isError: false,
                presentationMeta: {
                  title: 'Database Choice',
                  questionCount: 1,
                  outcome: 'answered',
                  items: [{ id: 'db', question: 'Engine?', answer: 'sqlite (SQLite)' }],
                },
              },
            }),
          ),
        ),
      )
    })

    const rows = [...host.querySelectorAll<HTMLDivElement>('.trace-row')]
    assert.equal(rows.length, 4)

    // 1. Running row
    assert.match(rows[0]!.textContent ?? '', /Question/)
    assert.match(rows[0]!.textContent ?? '', /Pick engine/)
    assert.match(rows[0]!.textContent ?? '', /Awaiting reply/)

    // 2. Answered row: inline summary + Replied badge, expanding omits generic title + Raw JSON clutter
    assert.match(rows[1]!.textContent ?? '', /Engine\? → sqlite \(SQLite\)/)
    assert.match(rows[1]!.textContent ?? '', /Replied/)
    await act(async () => {
      rows[1]!.click()
    })
    const entries = [...host.querySelectorAll('.trace-entry')]
    const answeredExpanded = entries[1]!.querySelector('.trace-expanded-body')!
    assert.ok(answeredExpanded !== null)
    assert.ok(answeredExpanded.querySelector('.ask-user-tool-head') === null, 'generic Clarifying Questions title is omitted inside expanded Q&A')
    assert.match(answeredExpanded.querySelector('.ask-user-tool-items')?.textContent ?? '', /Engine\?.*sqlite \(SQLite\)/)
    assert.ok(answeredExpanded.querySelector('.trace-raw-toggle') === null, 'Raw JSON toggle omitted from ask_user view')

    // 3 & 4. Skipped and Superseded badges
    assert.match(rows[2]!.textContent ?? '', /Optional Note/)
    assert.match(rows[2]!.textContent ?? '', /Skipped/)
    assert.match(rows[3]!.textContent ?? '', /Old Prompt/)
    assert.match(rows[3]!.textContent ?? '', /Superseded/)

    // Explicit non-generic title inside ToolExpandedBody retains header + Q&A without Raw JSON
    const toolHead = host.querySelector('.ask-user-tool-head')?.textContent ?? ''
    assert.match(toolHead, /Database Choice/)
    assert.match(toolHead, /1 question/)
    assert.match(toolHead, /Answered/)
  })

  test('auto-focuses primary control on mount from body or empty composer-textarea, without stealing focus from non-empty draft', { timeout: 60_000 }, async () => {
    installFetch()
    const qAsk: AskSpec = {
      id: 'ask-autofocus-1',
      conversationId: 1,
      kind: 'question',
      title: 'AutoFocus Pick',
      fields: [
        {
          name: 'pick',
          label: 'Pick',
          type: 'choice',
          required: true,
          options: [
            { value: 'a', label: 'Option A' },
            { value: 'b', label: 'Option B' },
          ],
        },
      ],
      status: 'pending',
      createdAt: 100,
    }

    // 1. Neutral focus (document.body) -> moves focus to first radio option
    document.body.focus()
    await renderAskDock(makeStore({ pendingAsks: [qAsk] }), 1)
    const radios1 = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    assert.ok(document.activeElement === radios1[0], 'auto-focuses first option when body had focus')

    // 2. Empty composer textarea -> yields focus to AskDock
    const emptyComposer = document.createElement('textarea')
    emptyComposer.className = 'composer-textarea'
    emptyComposer.value = ''
    document.body.appendChild(emptyComposer)
    emptyComposer.focus()
    assert.ok(document.activeElement === emptyComposer)

    await renderAskDock(
      makeStore({ pendingAsks: [{ ...qAsk, id: 'ask-autofocus-2' }] }),
      1,
    )
    const radios2 = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    assert.ok(document.activeElement === radios2[0], 'auto-focuses when composer textarea is empty')
    emptyComposer.remove()

    // 3. Non-empty composer draft -> preserves user's typing focus
    const draftComposer = document.createElement('textarea')
    draftComposer.className = 'composer-textarea'
    draftComposer.value = 'User is typing a message'
    document.body.appendChild(draftComposer)
    draftComposer.focus()
    assert.ok(document.activeElement === draftComposer)

    await renderAskDock(
      makeStore({ pendingAsks: [{ ...qAsk, id: 'ask-autofocus-3' }] }),
      1,
    )
    assert.ok(document.activeElement === draftComposer, 'must not steal focus from non-empty draft')
    draftComposer.remove()
  })

  test('window-level keyboard navigation operates AskDock when focus is outside card, and yields when modal or unfocused split is active', { timeout: 60_000 }, async () => {
    installFetch()
    const winAsk: AskSpec = {
      id: 'ask-win-kbd',
      conversationId: 1,
      kind: 'question',
      title: 'Window Kbd',
      fields: [
        {
          name: 'env',
          label: 'Env',
          type: 'choice',
          required: true,
          options: [
            { value: 'dev', label: 'Dev' },
            { value: 'prod', label: 'Prod' },
          ],
        },
      ],
      status: 'pending',
      createdAt: 100,
    }
    const store = makeStore({ pendingAsks: [winAsk] })
    await renderAskDock(store, 1)

    // Move focus back to outside element so AskCard window listener handles keys
    const outside = document.createElement('div')
    outside.tabIndex = 0
    document.body.appendChild(outside)
    outside.focus()
    assert.ok(document.activeElement === outside)

    // Suppressed when an alertdialog / modal overlay is open
    const hydrateNav = store as unknown as { patchNav: (patch: Record<string, unknown>) => void }
    await act(async () => {
      hydrateNav.patchNav({ activeModal: { kind: 'shortcuts' } })
    })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }))
    })
    const radios = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    assert.equal(radios[1]?.getAttribute('aria-checked'), 'false', 'blocked while modal is open')

    // Suppressed when split panel has focus instead of primary panel
    await act(async () => {
      hydrateNav.patchNav({
        activeModal: null,
        splitTarget: { kind: 'conversation', conversationId: 9 },
        focusedPanel: 'split',
      })
    })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }))
    })
    assert.equal(radios[1]?.getAttribute('aria-checked'), 'false', 'blocked while split panel is focused')

    await act(async () => {
      hydrateNav.patchNav({ focusedPanel: 'primary', splitTarget: null })
    })
    outside.focus()

    // ArrowDown from outside moves focus into AskDock and selects option 1
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    assert.ok(document.activeElement === radios[0], 'window ArrowDown focuses first radio')
    assert.equal(radios[0]?.getAttribute('aria-checked'), 'true')

    // Blur back outside, pick '2' via window, then 'Enter' via window submits
    outside.focus()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }))
    })
    assert.equal(radios[1]?.getAttribute('aria-checked'), 'true')
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0]?.body, { answers: { env: 'prod' } })
    outside.remove()
  })

  test('single-select ArrowDown selects option and Enter on focused option submits immediately', { timeout: 60_000 }, async () => {
    installFetch()
    const singleAsk: AskSpec = {
      id: 'ask-single-enter',
      conversationId: 1,
      kind: 'question',
      title: 'Single Enter Submit',
      fields: [
        {
          name: 'choice',
          label: 'Choice',
          type: 'choice',
          required: true,
          options: [
            { value: 'first', label: 'First' },
            { value: 'second', label: 'Second' },
          ],
        },
      ],
      status: 'pending',
      createdAt: 100,
    }
    await renderAskDock(makeStore({ pendingAsks: [singleAsk] }), 1)
    const radios = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    assert.ok(document.activeElement === radios[0])

    await act(async () => {
      radios[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    assert.ok(document.activeElement === radios[1])
    assert.equal(radios[1]?.getAttribute('aria-checked'), 'true')
    assert.equal(posts.length, 0)

    const enterEv = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => {
      radios[1]!.dispatchEvent(enterEv)
    })
    assert.equal(enterEv.defaultPrevented, true)
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0]?.body, { answers: { choice: 'second' } })
  })

  test('multi-select supports ArrowUp/Down/Home/End focus movement without toggling and Enter confirms string[]', { timeout: 60_000 }, async () => {
    installFetch()
    const multiAsk: AskSpec = {
      id: 'ask-multi-kbd',
      conversationId: 1,
      kind: 'question',
      title: 'Multi Select Keyboard',
      fields: [
        {
          name: 'items',
          label: 'Items',
          type: 'choice',
          multiple: true,
          required: true,
          options: [
            { value: 'alpha', label: 'Alpha' },
            { value: 'beta', label: 'Beta' },
            { value: 'gamma', label: 'Gamma' },
          ],
        },
      ],
      status: 'pending',
      createdAt: 100,
    }
    await renderAskDock(makeStore({ pendingAsks: [multiAsk] }), 1)

    const boxes = [...document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')]
    assert.deepEqual(boxes.map((b) => b.tabIndex), [0, -1, -1])
    assert.ok(document.activeElement === boxes[0])

    // ArrowDown moves focus without toggling aria-checked
    await act(async () => {
      boxes[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    assert.ok(document.activeElement === boxes[1])
    assert.deepEqual(boxes.map((b) => b.tabIndex), [-1, 0, -1])
    assert.deepEqual(boxes.map((b) => b.getAttribute('aria-checked')), ['false', 'false', 'false'])

    // Toggle Beta with click (browser Space triggers click on button)
    await act(async () => {
      boxes[1]!.click()
    })
    assert.equal(boxes[1]?.getAttribute('aria-checked'), 'true')

    // End moves focus to Gamma without toggling Beta/Gamma; click toggles Gamma
    await act(async () => {
      boxes[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
    })
    assert.ok(document.activeElement === boxes[2])
    await act(async () => {
      boxes[2]!.click()
    })
    assert.deepEqual(boxes.map((b) => b.getAttribute('aria-checked')), ['false', 'true', 'true'])

    // Pressing Enter on focused checkbox submits ['beta', 'gamma'] WITHOUT unchecking Gamma
    const enterEv = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => {
      boxes[2]!.dispatchEvent(enterEv)
    })
    assert.equal(enterEv.defaultPrevented, true)
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0]?.body, { answers: { items: ['beta', 'gamma'] } })
  })

  test('stepper end-to-end pure keyboard flow advances across steps, keeps focus on active control, supports PgUp/PgDn, and submits on final Enter', { timeout: 60_000 }, async () => {
    installFetch()
    const wizardAsk: AskSpec = {
      id: 'ask-wizard-kbd',
      conversationId: 1,
      kind: 'question',
      title: 'Wizard Kbd Flow',
      fields: [
        {
          name: 'framework',
          label: 'Framework',
          type: 'choice',
          required: true,
          options: [
            { value: 'react', label: 'React' },
            { value: 'vue', label: 'Vue' },
          ],
        },
        {
          name: 'addons',
          label: 'Add-ons',
          type: 'choice',
          multiple: true,
          required: true,
          options: [
            { value: 'lint', label: 'Lint' },
            { value: 'test', label: 'Tests' },
          ],
        },
        {
          name: 'extra',
          label: 'Extra note',
          type: 'text',
          required: false,
        },
      ],
      status: 'pending',
      createdAt: 100,
    }
    await renderAskDock(makeStore({ pendingAsks: [wizardAsk] }), 1)

    const card = document.querySelector<HTMLFormElement>('form.ask-dock')!
    const counter = () => card.querySelector('.ask-dock-step-counter')?.textContent?.trim()
    const panels = [...card.querySelectorAll<HTMLElement>('.ask-dock-step-panel')]
    assert.equal(counter(), '1 / 3')

    // Step 1: digit '2' selects 'vue' and auto-advances to step 2 AND moves focus to step 2 checkbox
    const step1Radios = [...panels[0]!.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    await act(async () => {
      step1Radios[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }))
    })
    assert.equal(counter(), '2 / 3')
    const step2Boxes = [...panels[1]!.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')]
    assert.ok(document.activeElement === step2Boxes[0], 'auto-advance moves focus into step 2 control')

    // Step 2: ArrowDown to second box + toggle + Enter advances to step 3 and focuses text input
    await act(async () => {
      step2Boxes[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    assert.ok(document.activeElement === step2Boxes[1])
    await act(async () => {
      step2Boxes[1]!.click()
    })
    await act(async () => {
      step2Boxes[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.equal(counter(), '3 / 3')
    const step3Input = panels[2]!.querySelector<HTMLInputElement>('input.input')!
    assert.ok(document.activeElement === step3Input, 'step 3 auto-focuses text input')

    // Escape exits text input back to card, PageUp returns to step 2, PageDown forward to step 3
    const escEv = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => {
      step3Input.dispatchEvent(escEv)
    })
    assert.equal(escEv.defaultPrevented, true)
    assert.ok(document.activeElement === card)

    await act(async () => {
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true }))
    })
    assert.equal(counter(), '2 / 3')

    await act(async () => {
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }))
    })
    assert.equal(counter(), '3 / 3')

    await act(async () => {
      setInputValue(step3Input, 'strict mode')
    })
    await act(async () => {
      step3Input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0]?.body, {
      answers: {
        framework: 'vue',
        addons: ['test'],
        extra: 'strict mode',
      },
    })
  })

  test('digit shortcut opening Other on single-select clears prior preset and Escape returns focus to Other option button', { timeout: 60_000 }, async () => {
    installFetch()
    const askOther: AskSpec = {
      id: 'ask-other-esc',
      conversationId: 1,
      kind: 'question',
      title: 'Other Escape Test',
      fields: [
        {
          name: 'tool',
          label: 'Build tool',
          type: 'choice',
          required: true,
          defaultValue: 'vite',
          options: [
            { value: 'vite', label: 'Vite' },
            { value: 'esbuild', label: 'esbuild' },
          ],
          allowCustom: true,
        },
      ],
      status: 'pending',
      createdAt: 100,
    }
    await renderAskDock(makeStore({ pendingAsks: [askOther] }), 1)

    const card = document.querySelector<HTMLFormElement>('form.ask-dock')!
    const radios = [...card.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    assert.equal(radios[0]?.getAttribute('aria-checked'), 'true')
    assert.ok(document.activeElement === radios[0])

    // Press '3' -> opens "Other" custom input, clears preset 'vite' selection, disables Confirm until typed
    await act(async () => {
      radios[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true, cancelable: true }))
    })
    assert.equal(radios[0]?.getAttribute('aria-checked'), 'false', 'activating Other clears prior preset selection')
    assert.equal(radios[2]?.getAttribute('aria-checked'), 'true')
    const customInput = card.querySelector<HTMLInputElement>('.ask-dock-choice-custom input.input')!
    assert.ok(document.activeElement === customInput)
    const confirmBtn = card.querySelector<HTMLButtonElement>('button[type="submit"]')!
    assert.equal(confirmBtn.disabled, true, 'empty Other keeps Confirm disabled when required')

    // Pressing Escape inside custom input prevents default (does not trigger Escx2 abort) and returns focus to Other button
    const escEv = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => {
      customInput.dispatchEvent(escEv)
    })
    assert.equal(escEv.defaultPrevented, true)
    assert.ok(document.activeElement === radios[2], 'Escape returns focus from custom input to Other option button')
  })

  test('Escape moves focus to Skip/Cancel button safely, and second Escape on Skip yields to global abort', { timeout: 60_000 }, async () => {
    installFetch()
    const skipAsk: AskSpec = {
      id: 'ask-esc-skip',
      conversationId: 1,
      kind: 'question',
      title: 'Esc Skip Check',
      fields: [
        {
          name: 'pick',
          label: 'Pick',
          type: 'choice',
          required: true,
          options: [
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' },
          ],
        },
      ],
      status: 'pending',
      createdAt: 100,
    }
    await renderAskDock(makeStore({ pendingAsks: [skipAsk] }), 1)
    const card = document.querySelector<HTMLFormElement>('form.ask-dock')!
    const radios = [...card.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    const skipBtn = card.querySelector<HTMLButtonElement>('.ask-dock-actions-left button')!
    assert.ok(document.activeElement === radios[0])

    // First Escape on option focuses Skip button instead of immediately cancelling
    const firstEsc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => {
      radios[0]!.dispatchEvent(firstEsc)
    })
    assert.equal(firstEsc.defaultPrevented, true)
    assert.equal(posts.length, 0)
    assert.ok(document.activeElement === skipBtn, 'Escape focuses Skip button without immediate cancel')

    // Second Escape while already on Skip yields (defaultPrevented=false) for global Escx2 abort
    const secondEsc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => {
      skipBtn.dispatchEvent(secondEsc)
    })
    assert.equal(secondEsc.defaultPrevented, false)
    assert.equal(posts.length, 0)

    // Activating Skip (native Enter -> click) cancels the ask
    await act(async () => {
      skipBtn.click()
    })
    assert.equal(posts.length, 1)
    assert.equal(posts[0]?.url, '/api/asks/ask-esc-skip/cancel')
  })

  test('ArrowUp/ArrowDown navigate smoothly out of Other custom input without trapping focus', { timeout: 60_000 }, async () => {
    installFetch()
    const customAsk: AskSpec = {
      id: 'ask-other-arrows',
      conversationId: 1,
      kind: 'question',
      title: 'Other Arrow Navigation',
      fields: [
        {
          name: 'tool',
          label: 'Tool',
          type: 'choice',
          required: true,
          options: [
            { value: 'vite', label: 'Vite' },
            { value: 'esbuild', label: 'esbuild' },
          ],
          allowCustom: true,
        },
      ],
      status: 'pending',
      createdAt: 100,
    }
    await renderAskDock(makeStore({ pendingAsks: [customAsk] }), 1)
    const card = document.querySelector<HTMLFormElement>('form.ask-dock')!
    const radios = [...card.querySelectorAll<HTMLButtonElement>('[role="radio"]')]

    // Open Other via '3'
    await act(async () => {
      radios[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true, cancelable: true }))
    })
    const input1 = card.querySelector<HTMLInputElement>('.ask-dock-choice-custom input.input')!
    assert.ok(document.activeElement === input1)

    // ArrowUp on empty custom input moves back to last preset and selects it
    const upEmpty = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
    await act(async () => {
      input1.dispatchEvent(upEmpty)
    })
    assert.equal(upEmpty.defaultPrevented, true)
    assert.ok(document.activeElement === radios[1], 'ArrowUp on empty Other moves focus to last preset')
    assert.equal(radios[1]?.getAttribute('aria-checked'), 'true')
    assert.ok(card.querySelector('.ask-dock-choice-custom') === null)

    // Re-open Other via '3', type text, ArrowUp returns focus to Other button keeping draft intact
    await act(async () => {
      radios[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true, cancelable: true }))
    })
    const input2 = card.querySelector<HTMLInputElement>('.ask-dock-choice-custom input.input')!
    await act(async () => {
      setInputValue(input2, 'rolldown')
    })
    const upFilled = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
    await act(async () => {
      input2.dispatchEvent(upFilled)
    })
    assert.equal(upFilled.defaultPrevented, true)
    assert.ok(document.activeElement === radios[2], 'ArrowUp with non-empty text focuses Other button')
    const retainedInput = card.querySelector<HTMLInputElement>('.ask-dock-choice-custom input.input')!
    assert.equal(retainedInput.value, 'rolldown')

    // ArrowDown from custom input wraps cleanly to first preset ('vite')
    retainedInput.focus()
    const downEv = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    await act(async () => {
      retainedInput.dispatchEvent(downEv)
    })
    assert.equal(downEv.defaultPrevented, true)
    assert.ok(document.activeElement === radios[0], 'ArrowDown from Other input wraps to first preset')
    assert.equal(radios[0]?.getAttribute('aria-checked'), 'true')
  })

  test('multi-question stepper switches questions via ArrowLeft/ArrowRight', { timeout: 60_000 }, async () => {
    installFetch()
    const stepAsk: AskSpec = {
      id: 'ask-stepper-lr',
      conversationId: 1,
      kind: 'question',
      title: 'Stepper L/R',
      fields: [
        {
          name: 'one',
          label: 'Question 1',
          type: 'choice',
          required: true,
          options: [
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' },
          ],
        },
        {
          name: 'two',
          label: 'Question 2',
          type: 'text',
          required: false,
        },
      ],
      status: 'pending',
      createdAt: 100,
    }
    await renderAskDock(makeStore({ pendingAsks: [stepAsk] }), 1)
    const card = document.querySelector<HTMLFormElement>('form.ask-dock')!
    const counter = () => card.querySelector('.ask-dock-step-counter')?.textContent?.trim()
    const panels = [...card.querySelectorAll<HTMLElement>('.ask-dock-step-panel')]
    const step1Radios = [...panels[0]!.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    assert.equal(counter(), '1 / 2')
    assert.ok(document.activeElement === step1Radios[0])

    // ArrowRight on stepper option switches to question 2 and focuses input
    const rightEv = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    await act(async () => {
      step1Radios[0]!.dispatchEvent(rightEv)
    })
    assert.equal(rightEv.defaultPrevented, true)
    assert.equal(counter(), '2 / 2')
    const step2Input = panels[1]!.querySelector<HTMLInputElement>('input.input')!
    assert.ok(document.activeElement === step2Input, 'ArrowRight moves to step 2 and focuses control')

    // Escape exits input to card, ArrowLeft returns to step 1
    await act(async () => {
      step2Input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.ok(document.activeElement === card)
    const leftEv = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })
    await act(async () => {
      card.dispatchEvent(leftEv)
    })
    assert.equal(leftEv.defaultPrevented, true)
    assert.equal(counter(), '1 / 2')
    assert.ok(document.activeElement === step1Radios[0])
  })

  test('non-choice confirm Ask supports window ArrowDown entry, ArrowLeft/Right wrap, and 1/2 focus before activation', { timeout: 60_000 }, async () => {
    installFetch()
    const confirmAsk: AskSpec = {
      id: 'ask-confirm-kbd',
      conversationId: 1,
      kind: 'approval',
      title: 'Confirm Action',
      fields: [{ name: 'approved', label: 'Allow', type: 'confirm', required: true }],
      status: 'pending',
      createdAt: 100,
    }
    await renderAskDock(makeStore({ pendingAsks: [confirmAsk] }), 1)
    const confirmBtns = [...document.querySelectorAll<HTMLButtonElement>('.ask-dock-confirm-actions button')]
    assert.equal(confirmBtns.length, 2)
    assert.ok(document.activeElement === confirmBtns[0])

    // Move focus outside
    const outside = document.createElement('div')
    outside.tabIndex = 0
    document.body.appendChild(outside)
    outside.focus()
    assert.ok(document.activeElement === outside)

    // Window ArrowDown enters primary Approve button without submitting
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    assert.ok(document.activeElement === confirmBtns[0])
    assert.equal(posts.length, 0)

    // ArrowLeft wraps Approve -> Reject; ArrowRight wraps Reject -> Approve
    await act(async () => {
      confirmBtns[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    })
    assert.ok(document.activeElement === confirmBtns[1], 'ArrowLeft wraps Approve to Reject')

    await act(async () => {
      confirmBtns[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    assert.ok(document.activeElement === confirmBtns[0], 'ArrowRight wraps Reject to Approve')

    // Window '2' focuses Reject safely without auto-submitting; click confirms rejection
    outside.focus()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }))
    })
    assert.ok(document.activeElement === confirmBtns[1])
    assert.equal(posts.length, 0)

    await act(async () => {
      confirmBtns[1]!.click()
    })
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0]?.body, { answers: { approved: 'false' } })
    outside.remove()
  })

  test('resolving last Ask invokes onFocusReturn; when stacked, resolving first auto-focuses second Ask instead', { timeout: 60_000 }, async () => {
    installFetch()
    const makeChoiceAsk = (id: string): AskSpec => ({
      id,
      conversationId: 1,
      kind: 'question',
      title: `Ask ${id}`,
      fields: [
        {
          name: 'pick',
          label: 'Pick',
          type: 'choice',
          required: true,
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
        },
      ],
      status: 'pending',
      createdAt: 100,
    })

    let focusReturnCount = 0
    const ask1 = makeChoiceAsk('ask-q1')
    const ask2 = makeChoiceAsk('ask-q2')
    const store = makeStore({ pendingAsks: [ask1, ask2] })
    await renderAskDock(store, 1, () => { focusReturnCount += 1 })

    const cardsBefore = [...document.querySelectorAll<HTMLFormElement>('form.ask-dock')]
    assert.equal(cardsBefore.length, 2)
    const ask1Radios = [...cardsBefore[0]!.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    assert.ok(document.activeElement === ask1Radios[0])

    // Submit ask1 while ask2 is still queued -> does not call onFocusReturn yet
    await act(async () => {
      ask1Radios[0]!.click()
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    assert.equal(focusReturnCount, 0, 'stacked queue holds focus return until final ask closes')

    // Store drops ask1 -> ask2 promotes to primary card and receives focus automatically
    await act(async () => {
      store.updateLive((prev) => ({ ...prev, pendingAsks: [ask2] }))
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    const ask2Radios = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    assert.ok(document.activeElement === ask2Radios[0], 'next queued Ask auto-focuses when promoted')
    assert.equal(focusReturnCount, 0)

    // Submit final ask2 -> calls onFocusReturn once
    await act(async () => {
      ask2Radios[1]!.click()
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    assert.equal(focusReturnCount, 1, 'onFocusReturn called once final ask resolves')
  })

  test('Escape focuses only Cancel/Skip button even when source badge and terminal snapshot are rendered; IME composition ignores Enter/Escape', { timeout: 60_000 }, async () => {
    const childAskWithSnapshot: AskSpec = {
      id: 'ask-child-snap',
      conversationId: 11,
      kind: 'approval',
      title: 'Run shell command',
      description: 'Approval requested.\n```sh\nls -la\n```',
      fields: [
        {
          name: 'note',
          label: 'Note',
          type: 'text',
        },
      ],
      status: 'pending',
      createdAt: 200,
    }
    await renderAskDock(makeStore({ pendingAsks: [childAskWithSnapshot] }), 1)

    const sourceBtn = document.querySelector<HTMLButtonElement>('.ask-dock-source-btn')
    const snapshotBtn = document.querySelector<HTMLButtonElement>('.ask-dock-snapshot-btn')
    const cancelBtn = document.querySelector<HTMLButtonElement>('.ask-dock-actions-left > button')
    const textInput = document.querySelector<HTMLInputElement>('.ask-dock-field input')
    assert.ok(sourceBtn && snapshotBtn && cancelBtn && textInput, 'source, snapshot, cancel, and input should render')

    // IME Enter (keyCode 229) inside text input must NOT submit the form
    installFetch()
    await act(async () => {
      textInput.focus()
      textInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }))
    })
    assert.equal(posts.length, 0, 'IME Enter must not trigger submit')

    // Escape inside card moves focus strictly to Cancel button (not source or snapshot buttons)
    await act(async () => {
      sourceBtn.focus()
      sourceBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.ok(document.activeElement === cancelBtn, 'Escape must move focus to Cancel button only')
    assert.ok(document.activeElement !== sourceBtn)
    assert.ok(document.activeElement !== snapshotBtn)
  })
})
