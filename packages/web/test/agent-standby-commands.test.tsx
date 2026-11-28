/**
 * Agent standby pane commands, coordinate drafts, locking, logout epoch release,
 * file-input boundary, slash popovers and composer completer tests.
 * - Real-conversation `/new` & `helmx:unauthorized` logout E2E tests mount `<App />`;
 * - Pane-level command/draft/completer/plan tests mount `<AgentStandbyPane />` directly
 *   under `HostStoreProviders` + `makeTestStore()`.
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { describe, afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import {
  COMPOSER_TOOLBAR_SLOT,
  type ComposerToolbarSlotProps,
} from '@helmx/protocol'
import { patchCompletionQueryDebounceMs } from '../src/conversation/composer-completion-model.js'
import { getStandbyDraft, standbyDraftKey } from '../src/conversation/standby-model.js'
import { seedPluginClientModule } from '../src/lib/plugin-client.js'
import { ensureHappyDom, flushMacrotask, flushMicrotasks, waitForCondition } from './helpers/dom-harness.js'
import {
  MAIN_LABEL,
  dropFiles,
  hasNotice,
  makeGate,
  mountStandbyApp,
  mountStandbyPane,
  pressEnter,
  resetStandbyHarness,
  settle,
  standbyState as state,
  textarea,
  typeInto,
} from './helpers/standby-app-harness.js'

ensureHappyDom()
const { useComposerCommand } = await import('@helmx/plugin-client')

const e = React.createElement

describe('agent-standby-commands', () => {
  afterEach(() => {
    resetStandbyHarness(true)
  }, { timeout: 60_000 })

  // ---------------------------------------------------------------------------
  // Builtin management commands (/new, /clear)
  // ---------------------------------------------------------------------------

  test('real-conversation Composer /new: enters standby inheriting the environment, no reset, no create', { timeout: 60_000 }, async () => {
    await mountStandbyApp('#/c/1')
    const composerInput = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Type a message"]')
    assert.ok(composerInput, 'the conversation input exists')
    act(() => { typeInto(composerInput!, '/new') })
    await act(async () => { pressEnter(composerInput!) })
    await flushMacrotask(0)
    await act(async () => { pressEnter(composerInput!) })
    await waitForCondition(() => window.location.hash.startsWith('#/a/assistant'))
    assert.equal(window.location.hash, `#/a/assistant?cwd=${encodeURIComponent('/tmp')}`, '/new enters standby inheriting the current directory')
    assert.equal(state.resetCalls.length, 0, '/new no longer resets the original conversation')
    assert.equal(state.createCalls.length, 0, '/new pre-creates nothing')
  })

  test('standby management commands: /new clears the draft; /clear notices that a conversation must exist first; neither persists anything', { timeout: 60_000 }, async () => {
    const store = await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '/new') })
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
    assert.ok(hasNotice(store, 'requires an existing conversation'), 'explicitly notices that a conversation must be created first')
  })

  // ---------------------------------------------------------------------------
  // A. Full-coordinate draft identity / B. anchored configuration locking / C. logout epoch release
  // ---------------------------------------------------------------------------

  test('same Profile at different remote coordinates: drafts isolate per coordinate; first sends use their own; old coordinates are preserved', { timeout: 60_000 }, async () => {
    const store = await mountStandbyPane({ kind: 'agent', profileId: 'assistant', nodeId: 'remote-1', cwd: '/remote/work' })
    act(() => { typeInto(textarea(MAIN_LABEL), 'r1 草稿') })
    await act(async () => {
      store.actions.openTarget({ kind: 'agent', profileId: 'assistant', nodeId: 'remote-2', cwd: '/remote/work2' })
    })
    await settle()
    const r2 = textarea(MAIN_LABEL)
    assert.equal(r2.value, '', 'the r2-coordinate draft starts fresh, sharing none of the r1 text')
    act(() => { typeInto(r2, 'r2 草稿') })
    await act(async () => { pressEnter(r2) })
    await waitForCondition(() => state.createCalls.length === 1)
    assert.deepEqual(state.createCalls[0], {
      profileId: 'assistant',
      nodeId: 'remote-2',
      cwd: '/remote/work2',
    }, 'create uses the r2 coordinates, never carrying the r1 environment')
    await act(async () => {
      store.actions.openTarget({ kind: 'agent', profileId: 'assistant', nodeId: 'remote-1', cwd: '/remote/work' })
    })
    await settle()
    assert.equal(textarea(MAIN_LABEL).value, 'r1 草稿', 'the old-coordinate draft is preserved')
  })

  test('switching to another environment of the same Profile mid-send: no navigation hijack, no draft cross-talk; the response becomes a background notice', { timeout: 60_000 }, async () => {
    state.createGate = makeGate()
    const store = await mountStandbyPane({ kind: 'agent', profileId: 'assistant', nodeId: 'remote-1', cwd: '/remote/work' })
    const r1 = textarea(MAIN_LABEL)
    act(() => { typeInto(r1, 'r1 在途') })
    await act(async () => { pressEnter(r1) })
    await act(async () => {
      store.actions.openTarget({ kind: 'agent', profileId: 'assistant', nodeId: 'remote-2', cwd: '/remote/work2' })
    })
    await settle()
    const r2 = textarea(MAIN_LABEL)
    assert.equal(r2.value, '', 'the r2 draft is unaffected by the r1 in-flight task')
    await act(async () => { state.createGate!.resolve() })
    await waitForCondition(
      () => state.submitCalls.length === 1 && hasNotice(store, 'Sent and conversation created'),
    )
    assert.equal(state.submitCalls.length, 1, 'the r1 task completes its submit (with the r1 configuration)')
    assert.deepEqual((state.createCalls[0] as { nodeId?: string }).nodeId, 'remote-1')
    assert.deepEqual(
      store.getPrimaryTarget(),
      { kind: 'agent', profileId: 'assistant', nodeId: 'remote-2', cwd: '/remote/work2' },
      'no navigation hijack',
    )
    assert.ok(hasNotice(store, 'Sent and conversation created'), 'becomes a background notice')
  })

  test('restore defaults (no conflict): the text moves with the coordinate to the default environment and URL inheritance params are removed', { timeout: 60_000 }, async () => {
    const store = await mountStandbyPane({ kind: 'agent', profileId: 'assistant', nodeId: 'remote-1', cwd: '/remote/work' })
    act(() => { typeInto(textarea(MAIN_LABEL), '跟随正文') })
    const resetBtn = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((btn) => btn.textContent?.trim() === 'Restore defaults')
    assert.ok(resetBtn, 'the restore-defaults button exists (URL-coordinate customized mode)')
    await act(async () => { resetBtn!.click() })
    await settle()
    assert.deepEqual(
      store.getPrimaryTarget(),
      { kind: 'agent', profileId: 'assistant' },
      'the sole navigation removes the inherited environment params; no revival on refresh',
    )
    assert.equal(textarea(MAIN_LABEL).value, '跟随正文', 'the text moves with the coordinate')
    assert.ok(document.body.textContent?.includes('Execution environment follows the profile default'), 'the environment returns to the default state')
  })

  test('restore defaults (target holds a draft): never overwrites it and says so; the source draft is preserved', { timeout: 60_000 }, async () => {
    const store = await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
    act(() => { typeInto(textarea(MAIN_LABEL), '默认坐标已有草稿') })
    await act(async () => {
      store.actions.openTarget({ kind: 'agent', profileId: 'assistant', nodeId: 'remote-1', cwd: '/remote/work' })
    })
    await settle()
    assert.equal(textarea(MAIN_LABEL).value, '', 'the r1-coordinate draft is independent')
    act(() => { typeInto(textarea(MAIN_LABEL), 'r1 正文') })
    const resetBtn = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((btn) => btn.textContent?.trim() === 'Restore defaults')
    await act(async () => { resetBtn!.click() })
    await settle()
    assert.deepEqual(store.getPrimaryTarget(), { kind: 'agent', profileId: 'assistant' })
    assert.ok(hasNotice(store, 'The default environment already has another draft'), 'explicitly reports the non-overwrite')
    assert.equal(textarea(MAIN_LABEL).value, '默认坐标已有草稿', 'the existing draft is never silently overwritten')
    await act(async () => {
      store.actions.openTarget({ kind: 'agent', profileId: 'assistant', nodeId: 'remote-1', cwd: '/remote/work' })
    })
    await settle()
    assert.equal(textarea(MAIN_LABEL).value, 'r1 正文', 'the source draft stays at its original coordinate')
  })

  test('anchored configuration locking: model/environment immutable with a banner about the bound conversation; text and attachments stay editable for retry', { timeout: 60_000 }, async () => {
    state.submitFailures = 1
    const store = await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
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
    await waitForCondition(() => store.getPrimaryTarget().kind === 'conversation')
    assert.equal(state.createCalls.length, 1, 'retry reuses the conversation')
    assert.equal(state.submitCalls.length, 2)
    assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 9 })
  })

  test('logout during the create wait: releases the draft and voids the in-flight response — no revival, no submit, no notice', { timeout: 60_000 }, async () => {
    state.createGate = makeGate()
    await mountStandbyApp('#/a/assistant')
    act(() => { typeInto(textarea(MAIN_LABEL), '将被释放') })
    await act(async () => { pressEnter(textarea(MAIN_LABEL)) })
    await act(async () => { window.dispatchEvent(new Event('helmx:unauthorized')) })
    await settle()
    const key = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
    assert.equal(getStandbyDraft(key).text, '', 'logout releases the draft synchronously')
    await act(async () => { state.createGate!.resolve() })
    await flushMicrotasks()
    await flushMacrotask(0)
    assert.equal(state.createCalls.length, 1, 'an already-issued request is never claimed as retractable')
    assert.equal(state.submitCalls.length, 0, 'no further submit after the epoch voiding')
    assert.equal(getStandbyDraft(key).conversationId, undefined, 'the response must not write an anchor')
    assert.equal(getStandbyDraft(key).text, '', 'the response must not revive the text')
    assert.ok(!document.body.textContent?.includes('Sent and conversation created'), 'no notice sent')
  })

  test('logout during the upload wait: no further submit, no attachment revival; the same coordinate is draft-empty after re-login', { timeout: 60_000 }, async () => {
    state.uploadGate = makeGate()
    await mountStandbyApp('#/a/assistant')
    const box = document.querySelector<HTMLElement>('.agent-standby-pane .composer-box')!
    await act(async () => { dropFiles(box, [new File(['hi'], 'wait.txt', { type: 'text/plain' })]) })
    await settle()
    act(() => { typeInto(textarea(MAIN_LABEL), '上传中释放') })
    await act(async () => { pressEnter(textarea(MAIN_LABEL)) })
    await waitForCondition(() => state.uploadStarted)
    await act(async () => { window.dispatchEvent(new Event('helmx:unauthorized')) })
    await settle()
    await act(async () => { state.uploadGate!.resolve() })
    await flushMicrotasks()
    await flushMacrotask(0)
    const key = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
    assert.equal(state.submitCalls.length, 0, 'no further submit after the upload response is voided')
    assert.equal(getStandbyDraft(key).uploaded.length, 0, 'the response must not revive attachments')
    assert.equal(getStandbyDraft(key).text, '', 'no old text at the same coordinate after re-login')
  })

  test('fake-File injection rejected at the boundary: plain objects enter no draft and render no chip; sending is never cut in half', { timeout: 60_000 }, async () => {
    const store = await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
    const fileInput = document.querySelector<HTMLInputElement>('.agent-standby-pane input[type=file]')
    assert.ok(fileInput, 'the hidden file input exists')
    const fake = { name: 'fake-attach.txt', size: 20, type: 'text/plain' } as unknown as File
    await act(async () => {
      Object.defineProperty(fileInput!, 'files', { configurable: true, get: () => [fake] })
      fileInput!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    assert.ok(hasNotice(store, 'Unsupported attachment source'), 'the admission boundary rejects explicitly with a notice')
    assert.equal(document.querySelectorAll('.attachment-chip').length, 0, 'fake objects render no attachment chip')
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '伪附件被拒后的正常首发') })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => store.getPrimaryTarget().kind === 'conversation')
    assert.equal(state.createCalls.length, 1)
    assert.equal(state.uploadCalls.length, 0)
    assert.equal(state.submitCalls.length, 1, 'the full chain completes as usual')
    assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 9 })
  })

  test('real File through the input change event path: full first-send chain (create -> upload -> submit -> navigate)', { timeout: 60_000 }, async () => {
    const store = await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
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
    await waitForCondition(() => store.getPrimaryTarget().kind === 'conversation')
    assert.deepEqual(state.uploadCalls, [{ id: 9, name: 'real-input.txt' }], 'create 后上传到真实会话')
    assert.deepEqual((state.submitCalls[0]!.body as { attachments?: string[] }).attachments, ['art-1'])
    assert.deepEqual(store.getPrimaryTarget(), { kind: 'conversation', conversationId: 9 })
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

    const store = await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '/') })
    await settle()

    const popover = document.querySelector<HTMLElement>('.agent-standby-pane .composer-popover')
    assert.ok(popover, 'draft-state / must pop the slash popover')
    const text = popover!.textContent ?? ''
    assert.match(text, /\/new/, 'includes the builtin /new')
    assert.match(text, /\/clear/, 'includes the builtin /clear')
    assert.match(text, /\/compact/, 'includes the builtin /compact')
    assert.match(text, /\/skill:review/, 'includes the whitelisted available skill')
    assert.doesNotMatch(text, /\/skill:tally/, 'excludes skills outside the whitelist')
    assert.doesNotMatch(text, /\/skill:herdr-tool/, 'excludes skills of disabled plugins')
    assert.match(text, /\/ping/, 'includes plugin commands without conversation-scope restrictions')
    assert.doesNotMatch(text, /\/wf-only/, 'excludes plugin commands with conversation-scope restrictions')

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.ok(document.querySelector('.agent-standby-pane .composer-popover') === null, 'Esc closes the slash popover')
    assert.equal(state.createCalls.length, 0)

    await act(async () => {
      store.actions.openTarget({ kind: 'agent', profileId: 'coder' })
    })
    await settle()
    const coderInput = textarea('Type the first message to 编码专员')
    act(() => { typeInto(coderInput, '/') })
    await settle()
    const coderPopover = document.querySelector<HTMLElement>('.agent-standby-pane .composer-popover')
    assert.ok(coderPopover, 'typing / on the coder standby pane pops the popover')
    assert.doesNotMatch(coderPopover!.textContent ?? '', /skill:/, 'with skills=[] no skills are shown')
  })

  test('draft-state / filter and skill write-back: replaces only the trigger token; only the later send creates and submits the full text', { timeout: 60_000 }, async () => {
    state.skills = [
      { id: 'review', name: '代码审查', references: [] },
      { id: 'tally', name: '记账汇总', references: [] },
    ]
    await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
    const input = textarea(MAIN_LABEL)

    act(() => { typeInto(input, 'src/index') })
    await settle()
    assert.ok(document.querySelector('.agent-standby-pane .composer-popover') === null, 'a mid-path / never pops')

    act(() => { typeInto(input, '请执行 /rev') })
    await settle()
    const popover = document.querySelector<HTMLElement>('.agent-standby-pane .composer-popover')
    assert.ok(popover, '/rev after whitespace pops the popover')
    assert.match(popover!.textContent ?? '', /\/skill:review/)
    assert.doesNotMatch(popover!.textContent ?? '', /\/skill:tally/)

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

    const store = await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
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

    state.actionError = 'plugin offline'
    act(() => { typeInto(input, '/ping') })
    await settle()
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => state.actionCalls.length === 2)
    assert.equal(state.actionCalls.length, 2)
    assert.equal(input.value, '/ping', 'a failed plugin command keeps the original draft')
    assert.ok(hasNotice(store, 'Command failed: /ping'), 'an explicit error notice')
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

    await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
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
    patchCompletionQueryDebounceMs(5)
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

    await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
    const input = textarea(MAIN_LABEL)

    act(() => { typeInto(input, 'user@example.com') })
    await flushMacrotask(0)
    assert.ok(document.querySelector('.composer-completion-popover') === null, 'a mid-email @ never pops')
    assert.equal(state.actionCalls.length, 0, 'a mid-email @ schedules no completion query')

    act(() => { typeInto(input, '请帮我找 @co') })
    await waitForCondition(
      () => state.actionCalls.length === 1 && document.querySelector('.composer-completion-popover') !== null,
    )
    assert.equal(state.actionCalls.length, 1, 'one debounced completion query issued')
    assert.deepEqual(state.actionCalls[0]!.body, { input: { query: 'co', profileId: 'assistant' } }, 'carries the standby profileId and fabricates no conversationId')

    const popover = document.querySelector<HTMLElement>('.composer-completion-popover')
    assert.ok(popover, 'draft-state @ pops the completion popover')
    assert.match(popover!.textContent ?? '', /@coder · 编码专员/)
    assert.doesNotMatch(popover!.textContent ?? '', /@reviewer/)

    await act(async () => { pressEnter(input) })
    await settle()
    assert.equal(input.value, '请帮我找 @coder ', 'replaces only the @co token, keeping the prefix')
    assert.ok(document.querySelector('.composer-completion-popover') === null, 'the popover closes after the pick')
    assert.equal(state.createCalls.length, 0, 'picking an @ candidate creates no conversation early')
    assert.equal(state.submitCalls.length, 0)

    act(() => { typeInto(input, '请帮我找 @coder 看下代码') })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => state.submitCalls.length === 1)
    assert.equal(state.createCalls.length, 1)
    assert.equal(state.submitCalls.length, 1)
    assert.equal(state.submitCalls[0]!.body.text, '请帮我找 @coder 看下代码')
  })

  test('draft-state # / :: global doc completion sources work with proper replacement; sessionDoc sources explicitly require an existing conversation', { timeout: 60_000 }, async () => {
    patchCompletionQueryDebounceMs(5)
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

    await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
    const input = textarea(MAIN_LABEL)
    act(() => { typeInto(input, '#') })
    await waitForCondition(() => (document.querySelector('.composer-completion-popover')?.textContent ?? '').includes('#缺陷'))
    const hashPopover = document.querySelector<HTMLElement>('.composer-completion-popover')
    assert.ok(hashPopover, 'doc completion sources pop in draft state')
    assert.match(hashPopover!.textContent ?? '', /#缺陷/)
    await act(async () => { pressEnter(input) })
    await settle()
    assert.equal(input.value, '#缺陷 ')
    assert.ok(document.querySelector('.composer-completion-popover') === null)
    assert.equal(state.createCalls.length, 0)

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

    const store = await mountStandbyPane({ kind: 'agent', profileId: 'assistant' })
    const input = textarea(MAIN_LABEL)

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
    assert.equal(hasNotice(store, 'Command executed'), false)

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

    act(() => { typeInto(input, '/plan 帮我设计方案') })
    await act(async () => { pressEnter(input) })
    await waitForCondition(() => state.submitCalls.length === 1)
    assert.equal(state.createCalls.length, 1)
    assert.equal(state.submitCalls[0]!.body.text, '/plan 帮我设计方案')
  })
})
