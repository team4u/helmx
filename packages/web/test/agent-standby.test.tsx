/**
 * Agent standby pane core lifecycle & first-send tests:
 * - True shell-navigation / split / sidebar E2E tests mount `<App />`;
 * - Pane-level lifecycle, attachment staging, starter, draft isolation, model/thinking picker
 *   and error/CTA states mount `<AgentStandbyPane />` directly under `HostStoreProviders` + `makeTestStore()`.
 * (Coordinate drafts, anchored locking, logout epoch release, file-input admission, slash commands
 * and composer completers live in agent-standby-commands.test.tsx for parallel dom-shared runs.)
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { describe, afterEach, test } from 'node:test'
import { act } from 'react'
import { ensureHappyDom, waitForCondition } from './helpers/dom-harness.js'
import {
  MAIN_LABEL,
  clickButton,
  dropFiles,
  hasNotice,
  makeGate,
  mountStandbyApp,
  mountStandbyPane,
  pressEnter,
  resetStandbyHarness,
  sendStandbySseEvent,
  settle,
  standbyState as state,
  summary,
  textarea,
  typeInto,
} from './helpers/standby-app-harness.js'

ensureHappyDom()

function navigateHash(hash: string): void {
  window.history.pushState(null, '', hash)
  window.dispatchEvent(new Event('hashchange'))
}

describe('agent-standby', () => {
  afterEach(() => {
    resetStandbyHarness(false)
  }, { timeout: 60_000 })

  test('deep-linked standby pane: renders intro and input with zero POST create throughout', { timeout: 60_000 }, async () => {
    await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
    assert.ok(document.querySelector('.agent-standby-pane'), 'the main stage renders the standby pane')
    assert.ok(document.body.textContent?.includes('Send the first message to start a new topic'), 'shows the start-a-new-topic intro')
    assert.ok(document.body.textContent?.includes('打个招呼'), 'shows the starter')
    assert.ok(textarea(MAIN_LABEL), 'renders the draft input')
    assert.equal(state.createCalls.length, 0, 'visiting the standby pane must not pre-create a conversation')
  })

  test('sidebar new-topic entry: multi-profile dropdown enters standby without pre-creating; standby highlights the new-topic row', { timeout: 60_000 }, async () => {
    await mountStandbyApp('#/c/1')
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
    const replaces: string[] = []
    const originalPush = history.pushState.bind(history)
    const originalReplace = history.replaceState.bind(history)
    history.pushState = ((data: unknown, unused: string, url?: string | URL | null) =>
      originalPush(data, unused, url)) as typeof history.pushState
    history.replaceState = ((data: unknown, unused: string, url?: string | URL | null) => {
      replaces.push(String(url))
      return originalReplace(data, unused, url)
    }) as typeof history.replaceState
    try {
      state.createGate = makeGate()
      await mountStandbyApp('#/a/assistant')
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
    const store = await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
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
    await waitForCondition(() => store.getPrimaryTarget().kind === 'conversation')
    assert.equal(state.createCalls.length, 2, 'retry re-creates (the previous one never succeeded)')
    assert.equal(state.submitCalls.length, 1, 'the retry submits successfully')
    assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 9 })
  })

  test('submit failure after create: keeps the real conversation id; retry never re-creates', { timeout: 60_000 }, async () => {
    state.submitFailures = 1
    const store = await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '会创建但发送失败') })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => document.querySelector('.agent-standby-error') !== null)
    assert.equal(state.createCalls.length, 1)
    assert.equal(state.submitCalls.length, 1)
    assert.ok(document.querySelector('.agent-standby-error'), 'the failure banner shows')
    assert.equal(input.value, '会创建但发送失败', 'the draft is preserved')
    assert.deepEqual(store.getPrimaryTarget(), { kind: 'agent', profileId: 'assistant' }, 'no navigation without full-chain success')
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => store.getPrimaryTarget().kind === 'conversation')
    assert.equal(state.createCalls.length, 1, 'retry reuses the created conversation without re-creating')
    assert.equal(state.submitCalls.length, 2, 'retry submits again')
    assert.equal(state.submitCalls[1]!.id, 9)
    assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 9 })
  })

  test('attachments: staged locally only before send; the first send follows create -> upload -> submit order', { timeout: 60_000 }, async () => {
    const store = await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
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
    await waitForCondition(() => store.getPrimaryTarget().kind === 'conversation')
    assert.equal(state.createCalls.length, 1)
    assert.deepEqual(state.uploadCalls, [{ id: 9, name: 'note.txt' }], 'uploads to the real conversation after create')
    assert.deepEqual((state.submitCalls[0]!.body as { attachments?: string[] }).attachments, ['art-1'])
    assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 9 })
  })

  test('starter: prefills an empty draft; never overwrites a non-empty one and notifies', { timeout: 60_000 }, async () => {
    const store = await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
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
    assert.ok(hasNotice(store, 'Handle the current draft'), 'an explicit notice is given')
  })

  test('URL environment inheritance: the standby target carries remote node and directory; create passes them faithfully', { timeout: 60_000 }, async () => {
    await mountStandbyPane({ kind: 'agent', profileId: 'assistant', nodeId: 'remote-1', cwd: '/remote/work' })
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
    await mountStandbyPane(
      { kind: 'agent', profileId: 'assistant' },
      { splitTarget: { kind: 'agent', profileId: 'coder' } },
    )
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
    const store = await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '等待期切走') })
    await act(async () => { pressEnter(input) })
    // The user switches to an existing conversation while in flight
    await act(async () => {
      store.actions.openTarget({ kind: 'conversation', conversationId: 1 })
    })
    await settle()
    assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 1 })
    await act(async () => { state.createGate!.resolve() })
    await waitForCondition(
      () => state.submitCalls.length === 1 && hasNotice(store, 'Sent and conversation created'),
    )
    assert.equal(state.submitCalls.length, 1, 'the send chain completes')
    assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 1 }, 'the late success never overwrites the new navigation')
    assert.ok(hasNotice(store, 'Sent and conversation created'), 'a clickable notice is given')
  })

  test('new-topic button: enters standby inheriting the remote environment, pre-creating nothing', { timeout: 60_000 }, async () => {
    await mountStandbyApp('#/c/3')
    clickButton('button[title^="Start a new topic under the current agent"]')
    await settle()
    assert.equal(window.location.hash, `#/a/assistant?node=remote-1&cwd=${encodeURIComponent('/remote/work')}`)
    assert.equal(state.createCalls.length, 0, 'new topic pre-creates no empty conversation')
    const cwdInput = document.querySelector<HTMLInputElement>('input[aria-label="New conversation working directory"]')
    assert.equal(cwdInput?.value, '/remote/work', 'the standby environment bar inherited the remote directory')
  })

  test('unavailable states shown honestly: plugin-disabled profile', { timeout: 60_000 }, async () => {
    await mountStandbyPane({ kind: 'agent', profileId: 'managed' })
    assert.ok(document.body.textContent?.includes('This profile does not support manual new conversations'), 'a profile managed by a disabled plugin reports explicit unavailability')
    assert.equal(document.querySelectorAll('textarea').length, 0, 'no draft input renders')
    assert.equal(state.createCalls.length, 0)
  })

  test('assets not loaded never mis-judged as missing: explicit loading state', { timeout: 60_000 }, async () => {
    state.assetsGate = makeGate()
    const store = await mountStandbyPane(
      { kind: 'agent', profileId: 'assistant' },
      { profiles: [], profilesLoaded: false, assetsLoaded: false },
    )
    const refreshPromise = store.actions.refreshAssets()
    await waitForCondition(() => document.body.textContent?.includes('Loading profile info') === true)
    assert.ok(document.body.textContent?.includes('Loading profile info'), 'the loading state is explicitly visible')
    assert.ok(!document.body.textContent?.includes('does not exist or was deleted'), 'must not mis-judge as missing')
    await act(async () => {
      state.assetsGate!.resolve()
      await refreshPromise
    })
    await waitForCondition(() => document.querySelector(`textarea[aria-label="${MAIN_LABEL}"]`) !== null)
    assert.ok(textarea(MAIN_LABEL), 'the input renders once assets are ready')
  })

  test('model & thinking level: the model rides with create; the thinking level patches after creation', { timeout: 60_000 }, async () => {
    await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
    clickButton('button.composer-model-button')
    const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
    assert.ok(popover, 'the model popover opens')
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
    await mountStandbyApp('#/c/1?split=a/assistant')
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
    await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
    clickButton('button.composer-model-button')
    const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
    const glmMain = [...popover!.querySelectorAll<HTMLButtonElement>('.composer-model-row-main')]
      .find((btn) => btn.textContent?.includes('glm-4.6'))
    assert.ok(glmMain !== undefined, 'the glm row main button exists')
    await act(async () => { glmMain!.click() })
    await settle()
    assert.ok(document.body.querySelector('.composer-model-popover') === null, 'the row click closes the popover')
    assert.ok(document.querySelector('button.composer-model-button')?.textContent?.includes('glm-4.6'), 'the row body click commits the draft model with the default level')
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
    await mountStandbyApp('#/c/1')

    const activeConvRow = document.querySelector('.sidebar-overview-item.nav-item-active')
    assert.ok(activeConvRow?.textContent?.includes('会话 1'), 'the current conversation row lights up in the working set')
    assert.equal(activeConvRow?.querySelector('.sidebar-overview-open')?.getAttribute('aria-current'), 'page')
    assert.ok(!document.querySelector('.sidebar-new-topic-btn')?.className.includes('is-active'))

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

    await act(async () => {
      sendStandbySseEvent({
        type: 'conversation.upsert',
        conversation: { ...summary(1), updatedAt: 99 },
      })
    })
    await settle()
    assert.ok(document.querySelector('.sidebar-new-topic-btn')?.className.includes('is-active'), 'after live updates the standby highlight persists')
  })

  test('profile asset load failure: explicit error and retry; never fakes success with a done signal', { timeout: 60_000 }, async () => {
    state.profilesFail = true
    await mountStandbyPane(
      { kind: 'agent', profileId: 'assistant' },
      { profiles: [], profilesLoaded: true, assetsLoaded: true, loadErrors: { 'assets:profiles': 'profiles down' } },
    )
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

  test('zero available models on standby shows onboarding CTA linking to Models Center (#/settings/models)', { timeout: 60_000 }, async () => {
    state.modelsOverride = { models: [], thinkingLevels: {} }
    const store = await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
    const ctaBanner = document.querySelector('.agent-standby-pane .callout-warn')
    assert.ok(ctaBanner !== null, 'zero-model standby pane renders onboarding callout')
    const ctaBtn = ctaBanner.querySelector<HTMLButtonElement>('button')
    assert.ok(ctaBtn !== null, 'onboarding callout includes clickable button to Models Center')
    await act(async () => {
      ctaBtn.click()
    })
    await waitForCondition(() => store.getPrimaryTarget().kind === 'models')
    assert.deepEqual(store.getPrimaryTarget(), { kind: 'models' })
  })

  test('standby one-turn override: stages nextTurnMode, supports clear, and sends { model, thinkingLevel } on first submit while keeping baseline on create/patch', { timeout: 60_000 }, async () => {
    state.modelsOverride = {
      models: [
        { provider: 'faux', modelId: 'glm-4.6', available: true },
        { provider: 'anthropic', modelId: 'claude-opus-4-6', available: true },
      ],
      thinkingLevels: {
        'faux/glm-4.6': ['off', 'low', 'high'],
        'anthropic/claude-opus-4-6': ['off', 'medium', 'max'],
      },
    }
    await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })

    clickButton('button.composer-model-button')
    const basePopover = document.body.querySelector<HTMLElement>('.composer-model-popover')!
    const glmRow = [...basePopover.querySelectorAll<HTMLElement>('.composer-model-row')]
      .find((row) => row.querySelector('.composer-model-row-main')?.textContent?.includes('glm-4.6'))!
    const lowChip = [...glmRow.querySelectorAll<HTMLButtonElement>('.composer-model-level-chip')]
      .find((btn) => btn.textContent?.trim() === 'low')!
    await act(async () => { lowChip.click() })
    await settle()

    clickButton('button.composer-model-button')
    const nextTurnPopover = document.body.querySelector<HTMLElement>('.composer-model-popover')!
    const nextTurnTab = [...nextTurnPopover.querySelectorAll<HTMLButtonElement>('[role="radio"], button')]
      .find((btn) => btn.textContent?.trim() === 'Next turn only')
    assert.ok(nextTurnTab, 'Standby ModelPicker renders Next turn only mode tab')
    await act(async () => { nextTurnTab.click() })
    await settle()

    const opusRow = [...nextTurnPopover.querySelectorAll<HTMLElement>('.composer-model-row')]
      .find((row) => row.querySelector('.composer-model-row-main')?.textContent?.includes('claude-opus-4-6'))!
    const maxChip = [...opusRow.querySelectorAll<HTMLButtonElement>('.composer-model-level-chip')]
      .find((btn) => btn.textContent?.trim() === 'max')!
    await act(async () => { maxChip.click() })
    await settle()

    assert.ok(document.querySelector('.composer-picker-root.composer-model-has-next-turn') !== null)
    assert.equal(document.querySelector('.composer-model-next-turn-badge')?.textContent?.trim(), 'Next turn')
    assert.equal(document.querySelector('.composer-model-label')?.textContent?.trim(), 'claude-opus-4-6')
    assert.equal(document.querySelector('.composer-model-level')?.textContent?.trim(), '· max')

    const clearBtn = document.querySelector<HTMLButtonElement>('button.composer-model-next-turn-clear')
    assert.ok(clearBtn, 'clear one-turn override button renders')
    await act(async () => { clearBtn.click() })
    await settle()
    assert.ok(document.querySelector('.composer-model-next-turn-badge') === null)
    assert.equal(document.querySelector('.composer-model-label')?.textContent?.trim(), 'glm-4.6')
    assert.equal(document.querySelector('.composer-model-level')?.textContent?.trim(), '· low')

    clickButton('button.composer-model-button')
    const rePopover = document.body.querySelector<HTMLElement>('.composer-model-popover')!
    const reNextTab = [...rePopover.querySelectorAll<HTMLButtonElement>('[role="radio"], button')]
      .find((btn) => btn.textContent?.trim() === 'Next turn only')!
    await act(async () => { reNextTab.click() })
    await settle()
    const reOpusRow = [...rePopover.querySelectorAll<HTMLElement>('.composer-model-row')]
      .find((row) => row.querySelector('.composer-model-row-main')?.textContent?.includes('claude-opus-4-6'))!
    const reMaxChip = [...reOpusRow.querySelectorAll<HTMLButtonElement>('.composer-model-level-chip')]
      .find((btn) => btn.textContent?.trim() === 'max')!
    await act(async () => { reMaxChip.click() })
    await settle()

    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '单轮模型首发') })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => state.submitCalls.length === 1 && state.patchCalls.length === 1)

    assert.equal((state.createCalls[0] as { model?: string }).model, 'faux/glm-4.6', 'POST create keeps baseline model')
    assert.deepEqual(state.patchCalls, [{ id: 9, body: { thinkingLevel: 'low' } }], 'PATCH keeps baseline thinking level')
    assert.deepEqual(state.submitCalls[0]?.body, {
      text: '单轮模型首发',
      origin: 'human',
      model: 'anthropic/claude-opus-4-6',
      thinkingLevel: 'max',
    }, 'first submitInput carries staged one-turn model and thinkingLevel')
  })
})
