/**
 * DOM interaction tests for standby UX enhancements:
 * - central StandbyProfilePicker (Radix Popover, static intro for 1 profile or configLocked,
 *   search threshold >= 6, coarse touch auto-focus guard, keyboard nav, panel-scoped
 *   `toggle-profile-picker`, history:'replace', migrating/preserving draft);
 * - 4-guard auto-focus (focused panel, modals/drawers/DOM dialogs, mobile/coarse pointer, other inputs);
 * - helmx:shortcut `focus-composer` panel-scoped listener;
 * - compact desktop shortcut hints strip (Switch profile hint when switchable + 3 hints +
 *   All shortcuts button dispatching `open-shortcuts`, hidden on zero-model CTA);
 * - StandbyEnvBar custom-env click auto-focusing the cwd input on desktop non-touch.
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Profile } from '@helmx/protocol'
import {
  ensureHappyDom,
  flushMacrotask,
  mountDomRoot,
  resetHappyDom,
  typeIntoControl,
  waitForCondition,
  type MountedDomRoot,
} from './helpers/dom-harness.js'
import { makeTestStore, type TestStoreOverrides } from './helpers/store.js'
import {
  getStandbyDraft,
  getStandbyFocusRequest,
  requestStandbyFocus,
  resetStandbyDrafts,
  setStandbyDraftInputMeta,
  standbyDraftKey,
  updateStandbyDraft,
} from '../src/conversation/standby-model.js'

ensureHappyDom()

const { HostStoreProviders } = await import('./helpers/host-store.js')
const { AgentStandbyPane } = await import('../src/conversation/AgentStandbyPane.js')

const e = React.createElement
const HELMX_SHORTCUT_EVENT = 'helmx:shortcut'

const twoProfiles: Profile[] = [
  { id: 'assistant', name: 'Assistant' },
  { id: 'coder', name: 'Coder', nodeId: 'remote-1', cwd: '/remote/repo' },
]

const defaultModels = [
  { id: 'openai/gpt-5', provider: 'openai', modelId: 'gpt-5', available: true, thinkingLevels: ['off', 'high'] },
]

const createdStores: Array<ReturnType<typeof makeTestStore>> = []

function makeStandbyStore(overrides: TestStoreOverrides = {}) {
  const store = makeTestStore({
    profiles: twoProfiles,
    models: defaultModels,
    nodes: [
      { id: 'local', kind: 'local', online: true },
      { id: 'remote-1', kind: 'byom', online: true },
    ],
    primaryTarget: { kind: 'agent', profileId: 'assistant' },
    splitTarget: null,
    focusedPanel: 'primary',
    ...overrides,
  })
  createdStores.push(store)
  return store
}

async function flushAnimationFrames(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
  await flushMacrotask(0)
}

function stubMatchMedia(predicate: (query: string) => boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: predicate(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

let mounted: MountedDomRoot | undefined

function cleanup(): void {
  mounted?.unmount()
  mounted = undefined
  while (createdStores.length > 0) {
    createdStores.pop()!.dispose()
  }
  resetStandbyDrafts()
  resetHappyDom()
}

describe('standby-pane UX', () => {
  afterEach(cleanup, { timeout: 60_000 })

  test('4-guard auto-focus: focuses textarea on mount when focused desktop fine-pointer panel has no overlays or other focused input', { timeout: 60_000 }, async () => {
    stubMatchMedia(() => false)
    const store = makeStandbyStore()
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: store }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )
    const ta = mounted.host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    assert.ok(ta !== null)
    await waitForCondition(() => document.activeElement === ta)
    assert.ok(document.activeElement === ta, 'focused primary standby pane auto-focuses its textarea')
  })

  test('4-guard auto-focus: blocks unfocused split pane, open modal/drawer/dialog, mobile/coarse pointer, and other focused input', { timeout: 60_000 }, async () => {
    stubMatchMedia(() => false)

    // 1. Unfocused split pane (focusedPanel='primary', split pane mounts)
    const splitStore = makeStandbyStore({
      primaryTarget: { kind: 'conversation', conversationId: 1 },
      splitTarget: { kind: 'agent', profileId: 'coder' },
      focusedPanel: 'primary',
    })
    mounted = await mountDomRoot(
      e(
        'div',
        { 'data-helmx-panel': 'split' },
        e(HostStoreProviders, { value: splitStore }, e(AgentStandbyPane, { profileId: 'coder', isSplit: true })),
      ),
    )
    await flushAnimationFrames()
    const splitTa = mounted.host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    assert.ok(document.activeElement !== splitTa, 'unfocused split pane must never steal focus')
    cleanup()

    // 2. Active modal open
    stubMatchMedia(() => false)
    const modalStore = makeStandbyStore({ activeModal: { kind: 'command-palette' } })
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: modalStore }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )
    await flushAnimationFrames()
    assert.ok(
      document.activeElement !== mounted.host.querySelector('textarea.composer-textarea'),
      'open activeModal blocks auto-focus',
    )
    cleanup()

    // 3. Drawer stack open
    stubMatchMedia(() => false)
    const drawerStore = makeStandbyStore({ drawerStack: [{ kind: 'workbench', tab: 'artifacts' }] })
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: drawerStore }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )
    await flushAnimationFrames()
    assert.ok(
      document.activeElement !== mounted.host.querySelector('textarea.composer-textarea'),
      'open drawer stack blocks auto-focus',
    )
    cleanup()

    // 4. DOM [role="dialog"] open
    stubMatchMedia(() => false)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: makeStandbyStore() }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )
    await flushAnimationFrames()
    assert.ok(
      document.activeElement !== mounted.host.querySelector('textarea.composer-textarea'),
      'open DOM dialog blocks auto-focus',
    )
    cleanup()

    // 5. Mobile / coarse-pointer viewport: passive mount blocks focus, while explicit focus ticket focuses synchronously
    stubMatchMedia((q) => q === '(hover: none) and (pointer: coarse)')
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: makeStandbyStore() }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )
    await flushAnimationFrames()
    assert.ok(
      document.activeElement !== mounted.host.querySelector('textarea.composer-textarea'),
      'passive coarse touch mount blocks auto-focus',
    )
    cleanup()

    requestStandbyFocus({ panel: 'primary', profileId: 'assistant', explicit: true })
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: makeStandbyStore() }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )
    const explicitMobileTa = mounted.host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    assert.ok(
      document.activeElement === explicitMobileTa,
      'explicit focus ticket synchronously focuses standby textarea on coarse-touch mount',
    )
    assert.equal(getStandbyFocusRequest(), null, 'consumed explicit focus ticket is cleared')
    cleanup()

    // 6. External input / hidden <Activity> textarea do NOT block standby focus,
    //    while an editable input in the opposite split pane or inside this standby pane DOES block.
    stubMatchMedia(() => false)
    const externalInput = document.createElement('input')
    externalInput.type = 'text'
    document.body.appendChild(externalInput)
    externalInput.focus()
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: makeStandbyStore() }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )
    const primaryTa = mounted.host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    await waitForCondition(() => document.activeElement === primaryTa)
    assert.ok(document.activeElement === primaryTa, 'external search input outside standby does not block auto-focus')
    cleanup()

    stubMatchMedia(() => false)
    const hiddenActivityWrap = document.createElement('div')
    hiddenActivityWrap.style.display = 'none'
    const hiddenTa = document.createElement('textarea')
    hiddenActivityWrap.appendChild(hiddenTa)
    document.body.appendChild(hiddenActivityWrap)
    hiddenTa.focus()
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: makeStandbyStore() }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )
    const taAfterHidden = mounted.host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    await waitForCondition(() => document.activeElement === taAfterHidden)
    assert.ok(document.activeElement === taAfterHidden, 'hidden <Activity> textarea does not block auto-focus')
    cleanup()

    stubMatchMedia(() => false)
    const oppositePanel = document.createElement('div')
    oppositePanel.setAttribute('data-helmx-panel', 'primary')
    const oppositeInput = document.createElement('input')
    oppositeInput.type = 'text'
    oppositePanel.appendChild(oppositeInput)
    document.body.appendChild(oppositePanel)
    oppositeInput.focus()
    const oppositeFocusStore = makeStandbyStore({
      primaryTarget: { kind: 'conversation', conversationId: 1 },
      splitTarget: { kind: 'agent', profileId: 'coder' },
      focusedPanel: 'split',
    })
    mounted = await mountDomRoot(
      e(
        'div',
        { 'data-helmx-panel': 'split' },
        e(HostStoreProviders, { value: oppositeFocusStore }, e(AgentStandbyPane, { profileId: 'coder', isSplit: true })),
      ),
    )
    await flushAnimationFrames()
    assert.ok(document.activeElement === oppositeInput, 'editable input in opposite split panel keeps focus')
  })

  test('focus-composer panel shortcut focuses matching standby textarea without modifying draft and ignores other panel', { timeout: 60_000 }, async () => {
    stubMatchMedia(() => false)
    const key = standbyDraftKey({ panel: 'split', profileId: 'coder' })
    updateStandbyDraft(key, { text: 'keep my draft' })
    const store = makeStandbyStore({
      primaryTarget: { kind: 'conversation', conversationId: 1 },
      splitTarget: { kind: 'agent', profileId: 'coder' },
      focusedPanel: 'primary',
    })
    mounted = await mountDomRoot(
      e(
        'div',
        { 'data-helmx-panel': 'split' },
        e(HostStoreProviders, { value: store }, e(AgentStandbyPane, { profileId: 'coder', isSplit: true })),
      ),
    )
    await flushAnimationFrames()
    const ta = mounted.host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    assert.ok(document.activeElement !== ta)

    // Primary panel event is ignored by split standby pane
    await act(async () => {
      window.dispatchEvent(new CustomEvent(HELMX_SHORTCUT_EVENT, { detail: { action: 'focus-composer', panel: 'primary' } }))
    })
    assert.ok(document.activeElement !== ta, 'primary focus-composer event ignores split pane')

    // Split panel event focuses split standby textarea without touching draft
    await act(async () => {
      window.dispatchEvent(new CustomEvent(HELMX_SHORTCUT_EVENT, { detail: { action: 'focus-composer', panel: 'split' } }))
    })
    assert.ok(document.activeElement === ta, 'matching panel focus-composer focuses textarea')
    assert.equal(ta.value, 'keep my draft', 'focus-composer preserves existing draft text')
  })

  test('central StandbyProfilePicker: static label for single profile or configLocked; switches with history replace and migrates/preserves draft', { timeout: 60_000 }, async () => {
    stubMatchMedia(() => false)

    // Single profile -> static central label, plain topbar title, no picker trigger
    const singleStore = makeStandbyStore({ profiles: [{ id: 'assistant', name: 'Assistant' }] })
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: singleStore }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )
    assert.ok(mounted.host.querySelector('.pane-topbar button.agent-standby-profile-trigger') === null)
    assert.ok(mounted.host.querySelector('button.agent-standby-profile-trigger') === null, 'single profile hides picker trigger')
    assert.ok(mounted.host.querySelector('.agent-standby-intro .agent-standby-profile-static') !== null)
    assert.equal(mounted.host.querySelector('span.pane-title')?.textContent, 'Assistant')
    cleanup()

    // configLocked (conversation anchored) -> static label even with 2 profiles
    stubMatchMedia(() => false)
    const lockedKey = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
    updateStandbyDraft(lockedKey, { text: 'retry text', conversationId: 99 })
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: makeStandbyStore() }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )
    assert.ok(mounted.host.querySelector('button.agent-standby-profile-trigger') === null, 'anchored standby locks profile picker')
    assert.ok(mounted.host.querySelector('.agent-standby-intro .agent-standby-profile-static') !== null)
    assert.equal(mounted.host.querySelector('span.pane-title')?.textContent, 'Assistant')
    cleanup()

    // 2 profiles -> central trigger renders with aria-haspopup="dialog", topbar stays static,
    // popover shows remote node + metadata + check icon, switches with history:'replace', migrates draft, restores textarea focus
    stubMatchMedia(() => false)
    const richProfiles: Profile[] = [
      { id: 'assistant', name: 'Assistant' },
      { id: 'coder', name: 'Coder', nodeId: 'remote-1', cwd: '/remote/repo', model: 'openai/gpt-5' },
    ]
    const assistantKey = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
    const coderKey = standbyDraftKey({ panel: 'primary', profileId: 'coder' })
    updateStandbyDraft(assistantKey, { text: 'migrate me', model: 'openai/gpt-5' })
    setStandbyDraftInputMeta(assistantKey, 'builtin:plan', { mode: 'planning' })
    const multiStore = makeStandbyStore({ profiles: richProfiles })
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: multiStore }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )
    assert.ok(mounted.host.querySelector('.pane-topbar button.agent-standby-profile-trigger') === null, 'topbar stays plain title')
    const trigger = mounted.host.querySelector<HTMLButtonElement>('.agent-standby-intro button.agent-standby-profile-trigger')!
    assert.ok(trigger !== null, 'multi-profile standby renders central picker trigger')
    assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog')
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')

    await act(async () => {
      trigger.click()
    })
    await flushMacrotask(0)
    const popover = document.querySelector<HTMLElement>('.agent-standby-profile-popover')
    assert.ok(popover !== null, 'clicking trigger opens central profile popover')
    assert.ok(popover.querySelector('input') === null, '2 profiles (<= 5) hides search box')
    const items = [...popover.querySelectorAll<HTMLElement>('.agent-standby-profile-item')]
    assert.equal(items.length, 2, 'popover lists both human-selectable profiles')
    const assistantItem = items.find((item) => item.getAttribute('data-profile-id') === 'assistant')!
    const coderItem = items.find((item) => item.getAttribute('data-profile-id') === 'coder')!
    assert.ok(assistantItem.querySelector('.agent-standby-profile-item-check') !== null, 'current profile shows check icon')
    assert.ok(coderItem.querySelector('.agent-standby-profile-item-check') === null)
    assert.match(coderItem.textContent ?? '', /remote-1/, 'remote-node profile shows remote node tag')
    assert.match(coderItem.querySelector('.popover-item-meta')?.textContent ?? '', /\/remote\/repo · gpt-5/)

    await act(async () => {
      coderItem.click()
    })
    await flushMacrotask(0)
    assert.ok(document.querySelector('.agent-standby-profile-popover') === null, 'picking profile closes popover')
    assert.deepEqual(multiStore.getPrimaryTarget(), { kind: 'agent', profileId: 'coder' })
    assert.equal(multiStore.pendingHistoryMode, 'replace', 'switching standby profile replaces history')
    assert.equal(getStandbyDraft(assistantKey).text, '', 'original draft moved away')
    assert.equal(getStandbyDraft(coderKey).text, 'migrate me', 'draft text migrated to target profile')
    assert.deepEqual(getStandbyDraft(coderKey).inputMeta, { 'builtin:plan': { mode: 'planning' } })
    assert.equal(getStandbyDraft(coderKey).model, undefined, 'model does not carry across profiles')
    assert.equal(multiStore.getNotices().length, 0, 'no warning toast when target was empty')
    const ta = mounted.host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    await waitForCondition(() => document.activeElement === ta)
    assert.ok(document.activeElement === ta, 'selecting profile returns focus to textarea on desktop')
    cleanup()

    // Target occupied -> preserves both drafts and pushes warning toast
    stubMatchMedia(() => false)
    updateStandbyDraft(assistantKey, { text: 'assistant draft' })
    updateStandbyDraft(coderKey, { text: 'coder existing draft' })
    const occupiedStore = makeStandbyStore()
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: occupiedStore }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )
    const trigger2 = mounted.host.querySelector<HTMLButtonElement>('button.agent-standby-profile-trigger')!
    await act(async () => {
      trigger2.click()
    })
    await flushMacrotask(0)
    const coderItem2 = document.querySelector<HTMLElement>('.agent-standby-profile-item[data-profile-id="coder"]')!
    await act(async () => {
      coderItem2.click()
    })
    await flushMacrotask(0)
    assert.deepEqual(occupiedStore.getPrimaryTarget(), { kind: 'agent', profileId: 'coder' })
    assert.equal(getStandbyDraft(assistantKey).text, 'assistant draft', 'previous draft preserved under original profile')
    assert.equal(getStandbyDraft(coderKey).text, 'coder existing draft', 'target draft never overwritten')
    const notices = occupiedStore.getNotices()
    assert.equal(notices.length, 1)
    assert.equal(notices[0]?.level, 'warning')
    assert.match(notices[0]?.title ?? '', /Target profile already has an unsent draft/)
  })

  test('StandbyProfilePicker search threshold (>= 6), keyboard nav, Escape return-focus, and coarse touch guard', { timeout: 60_000 }, async () => {
    const sixProfiles: Profile[] = [
      { id: 'assistant', name: 'Assistant' },
      { id: 'coder', name: 'Coder', tags: ['engineering'], cwd: '/repo/code' },
      { id: 'reviewer', name: 'Reviewer', model: 'anthropic/claude-opus-4' },
      { id: 'planner', name: 'Planner', tags: ['design'] },
      { id: 'ops', name: 'Ops', nodeId: 'prod-1' },
      { id: 'writer', name: 'Writer', tags: ['docs'] },
    ]
    stubMatchMedia(() => false)
    const store = makeStandbyStore({ profiles: sixProfiles })
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: store }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )
    const ta = mounted.host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    const trigger = mounted.host.querySelector<HTMLButtonElement>('button.agent-standby-profile-trigger')!

    await act(async () => {
      trigger.click()
    })
    await flushMacrotask(0)
    const popover = document.querySelector<HTMLElement>('.agent-standby-profile-popover')!
    assert.ok(popover !== null)
    const searchBox = popover.querySelector<HTMLElement>('.search-box.search-box-sm.composer-model-search-input')
    assert.ok(searchBox !== null, '6+ profiles render SDK SearchBox(size="sm")')
    const searchInput = searchBox.querySelector<HTMLInputElement>('input')!
    assert.ok(searchInput !== null, '6+ profiles show search box')
    await waitForCondition(() => document.activeElement === searchInput)
    assert.ok(document.activeElement === searchInput, 'desktop non-touch focuses search box on open')

    // Non-matching query shows empty state and Enter does nothing
    await act(async () => {
      typeIntoControl(searchInput, 'non-existent-role')
    })
    assert.match(popover.textContent ?? '', /No matching profiles/)
    await act(async () => {
      searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.ok(document.querySelector('.agent-standby-profile-popover') !== null, 'Enter on empty filter keeps popover open')

    // Escape closes popover and restores focus to textarea
    await act(async () => {
      searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await waitForCondition(() => document.querySelector('.agent-standby-profile-popover') === null)
    await waitForCondition(() => document.activeElement === ta)
    assert.ok(document.activeElement === ta, 'Escape closes popover and restores focus to textarea')

    // Reopen, filter by tag/model/node, and pick with ArrowDown + Enter
    await act(async () => {
      trigger.click()
    })
    await flushMacrotask(0)
    const searchInput2 = document.querySelector<HTMLInputElement>('.agent-standby-profile-popover input')!
    await act(async () => {
      typeIntoControl(searchInput2, 'engineering')
    })
    let visibleOptions = [...document.querySelectorAll<HTMLElement>('.agent-standby-profile-item')]
    assert.deepEqual(visibleOptions.map((el) => el.getAttribute('data-profile-id')), ['coder'])

    await act(async () => {
      typeIntoControl(searchInput2, '')
    })
    visibleOptions = [...document.querySelectorAll<HTMLElement>('.agent-standby-profile-item')]
    assert.equal(visibleOptions.length, 6)

    // Starts on assistant (index 0); ArrowDown moves to index 1; Enter switches
    const secondProfileId = visibleOptions[1]!.getAttribute('data-profile-id')!
    await act(async () => {
      searchInput2.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    await act(async () => {
      searchInput2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await flushMacrotask(0)
    assert.deepEqual(store.getPrimaryTarget(), { kind: 'agent', profileId: secondProfileId })
    assert.equal(store.pendingHistoryMode, 'replace')
    cleanup()

    // Coarse touch viewport -> opening 6-profile popover does NOT focus search input (avoids soft keyboard),
    // Escape cancel does NOT force-focus textarea, while explicitly picking a profile focuses the new textarea
    stubMatchMedia((q) => q === '(hover: none) and (pointer: coarse)')
    const touchStore = makeStandbyStore({ profiles: sixProfiles })
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: touchStore }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )
    const touchTa = mounted.host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    const touchTrigger = mounted.host.querySelector<HTMLButtonElement>('button.agent-standby-profile-trigger')!
    await act(async () => {
      touchTrigger.click()
    })
    await flushAnimationFrames()
    const touchSearch = document.querySelector<HTMLInputElement>('.agent-standby-profile-popover input')!
    assert.ok(touchSearch !== null)
    assert.ok(document.activeElement !== touchSearch, 'coarse touch skips focusing search input on open')

    await act(async () => {
      touchSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await flushAnimationFrames()
    assert.ok(document.activeElement !== touchTa, 'canceling picker on coarse touch does not force-focus textarea')

    await act(async () => {
      touchTrigger.click()
    })
    await flushAnimationFrames()
    const touchCoderItem = document.querySelector<HTMLElement>('.agent-standby-profile-item[data-profile-id="coder"]')!
    await act(async () => {
      touchCoderItem.click()
    })
    await flushAnimationFrames()
    assert.deepEqual(touchStore.getPrimaryTarget(), { kind: 'agent', profileId: 'coder' })
    assert.ok(document.activeElement === mounted.host.querySelector('textarea.composer-textarea'), 'explicitly picking profile on coarse touch focuses standby textarea')
  })

  test('toggle-profile-picker shortcut opens/toggles popover in matching panel, ignores other panel, and falls back to composer when locked', { timeout: 60_000 }, async () => {
    stubMatchMedia(() => false)
    const splitStore = makeStandbyStore({
      primaryTarget: { kind: 'conversation', conversationId: 1 },
      splitTarget: { kind: 'agent', profileId: 'assistant' },
      focusedPanel: 'split',
    })
    mounted = await mountDomRoot(
      e(
        'div',
        { 'data-helmx-panel': 'split' },
        e(HostStoreProviders, { value: splitStore }, e(AgentStandbyPane, { profileId: 'assistant', isSplit: true })),
      ),
    )
    await flushAnimationFrames()
    const splitTa = mounted.host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!

    // Primary shortcut ignored by split standby pane
    await act(async () => {
      window.dispatchEvent(new CustomEvent(HELMX_SHORTCUT_EVENT, { detail: { action: 'toggle-profile-picker', panel: 'primary' } }))
    })
    assert.ok(document.querySelector('.agent-standby-profile-popover') === null)

    // Split shortcut opens split popover
    await act(async () => {
      window.dispatchEvent(new CustomEvent(HELMX_SHORTCUT_EVENT, { detail: { action: 'toggle-profile-picker', panel: 'split' } }))
    })
    await flushMacrotask(0)
    assert.ok(document.querySelector('.agent-standby-profile-popover') !== null, 'matching panel opens profile picker')

    // Second split shortcut closes popover and returns focus to split textarea
    await act(async () => {
      window.dispatchEvent(new CustomEvent(HELMX_SHORTCUT_EVENT, { detail: { action: 'toggle-profile-picker', panel: 'split' } }))
    })
    await waitForCondition(() => document.querySelector('.agent-standby-profile-popover') === null)
    await waitForCondition(() => document.activeElement === splitTa)
    assert.ok(document.activeElement === splitTa, 'toggling closed returns focus to textarea')
    cleanup()

    // configLocked -> toggle-profile-picker falls back to focusing textarea without opening popover
    stubMatchMedia(() => false)
    const lockedKey = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
    updateStandbyDraft(lockedKey, { text: 'locked draft', conversationId: 99 })
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: makeStandbyStore() }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )
    const lockedTa = mounted.host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    lockedTa.blur()
    await act(async () => {
      window.dispatchEvent(new CustomEvent(HELMX_SHORTCUT_EVENT, { detail: { action: 'toggle-profile-picker', panel: 'primary' } }))
    })
    assert.ok(document.querySelector('.agent-standby-profile-popover') === null)
    assert.ok(document.activeElement === lockedTa, 'locked standby falls back to focusing textarea')
  })

  test('shortcut hints strip: shows Switch profile hint when switchable, 3 hints for single profile, localizes in zh-CN, and hides on zero-model CTA', { timeout: 60_000 }, async () => {
    stubMatchMedia(() => false)
    const store = makeStandbyStore()
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: store }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )

    const strip = mounted.host.querySelector('.agent-standby-shortcuts')
    assert.ok(strip !== null, 'renders shortcut hints strip when usable models exist')
    const items = [...strip.querySelectorAll('.agent-standby-shortcut-item')]
    assert.equal(items.length, 4, 'renders Switch profile + 3 hints when switchable')
    const stripText = strip.textContent ?? ''
    assert.match(stripText, /Switch profile/)
    assert.match(stripText, /Search & commands/)
    assert.match(stripText, /Ctrl\+L/)
    assert.match(stripText, /Switch model/)
    assert.match(stripText, /Commands & skills/)
    assert.doesNotMatch(stripText, /New topic/i, 'does not repeat new topic shortcut on standby page')

    const dispatched: Array<{ action?: string; panel?: string }> = []
    const onShortcut = (ev: Event): void => {
      dispatched.push((ev as CustomEvent<{ action?: string; panel?: string }>).detail)
    }
    window.addEventListener(HELMX_SHORTCUT_EVENT, onShortcut)
    try {
      const allBtn = strip.querySelector<HTMLButtonElement>('button.btn.btn-inline.agent-standby-shortcuts-all')!
      assert.ok(allBtn !== null, 'All shortcuts control uses SDK Button(variant="inline")')
      assert.match(allBtn.textContent ?? '', /All shortcuts/)
      await act(async () => {
        allBtn.click()
      })
      assert.deepEqual(dispatched, [{ action: 'open-shortcuts', panel: 'primary' }])
    } finally {
      window.removeEventListener(HELMX_SHORTCUT_EVENT, onShortcut)
    }
    cleanup()

    // Single profile -> omits Switch profile hint (3 hints)
    stubMatchMedia(() => false)
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: makeStandbyStore({ profiles: [{ id: 'assistant', name: 'Assistant' }] }) }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )
    const singleStrip = mounted.host.querySelector('.agent-standby-shortcuts')!
    assert.equal(singleStrip.querySelectorAll('.agent-standby-shortcut-item').length, 3, 'single profile omits Switch profile hint')
    assert.doesNotMatch(singleStrip.textContent ?? '', /Switch profile/)
    cleanup()

    // zh-CN copy
    stubMatchMedia(() => false)
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: makeStandbyStore({ locale: 'zh-CN' }) }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )
    const zhText = mounted.host.querySelector('.agent-standby-shortcuts')?.textContent ?? ''
    assert.match(zhText, /切换角色/)
    assert.match(zhText, /搜索与命令/)
    assert.match(zhText, /切换模型/)
    assert.match(zhText, /命令与技能/)
    assert.match(zhText, /全部快捷键/)
    cleanup()

    // Zero usable models -> hides hints strip while showing onboarding CTA
    stubMatchMedia(() => false)
    const zeroModelStore = makeStandbyStore({ models: [] })
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: zeroModelStore }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )
    assert.ok(mounted.host.querySelector('.callout-warn') !== null, 'zero-model CTA renders')
    assert.ok(mounted.host.querySelector('.agent-standby-shortcuts') === null, 'shortcut hints strip hides when showZeroModelCta is true')
    cleanup()

    // Split panel dispatches open-shortcuts with panel='split' and switches profile within split pane
    stubMatchMedia(() => false)
    const splitAssistantKey = standbyDraftKey({ panel: 'split', profileId: 'assistant' })
    const splitCoderKey = standbyDraftKey({ panel: 'split', profileId: 'coder' })
    updateStandbyDraft(splitAssistantKey, { text: 'split draft' })
    const splitStore = makeStandbyStore({
      primaryTarget: { kind: 'conversation', conversationId: 1 },
      splitTarget: { kind: 'agent', profileId: 'assistant' },
      focusedPanel: 'split',
    })
    mounted = await mountDomRoot(
      e(
        'div',
        { 'data-helmx-panel': 'split' },
        e(HostStoreProviders, { value: splitStore }, e(AgentStandbyPane, { profileId: 'assistant', isSplit: true })),
      ),
    )
    const splitEvents: Array<{ action?: string; panel?: string }> = []
    const onSplitShortcut = (ev: Event): void => {
      splitEvents.push((ev as CustomEvent<{ action?: string; panel?: string }>).detail)
    }
    window.addEventListener(HELMX_SHORTCUT_EVENT, onSplitShortcut)
    try {
      const splitAllBtn = mounted.host.querySelector<HTMLButtonElement>('button.agent-standby-shortcuts-all')!
      await act(async () => {
        splitAllBtn.click()
      })
      assert.deepEqual(splitEvents, [{ action: 'open-shortcuts', panel: 'split' }])
    } finally {
      window.removeEventListener(HELMX_SHORTCUT_EVENT, onSplitShortcut)
    }
    const splitTrigger = mounted.host.querySelector<HTMLButtonElement>('button.agent-standby-profile-trigger')!
    await act(async () => {
      splitTrigger.click()
    })
    await flushMacrotask(0)
    const splitCoderItem = document.querySelector<HTMLElement>('.agent-standby-profile-item[data-profile-id="coder"]')!
    await act(async () => {
      splitCoderItem.click()
    })
    await flushMacrotask(0)
    assert.deepEqual(splitStore.getSplitTarget(), { kind: 'agent', profileId: 'coder' })
    assert.equal(splitStore.pendingHistoryMode, 'replace')
    assert.equal(getStandbyDraft(splitCoderKey).text, 'split draft')
    assert.equal(getStandbyDraft(splitAssistantKey).text, '')
  })

  test('StandbyEnvBar Custom button auto-focuses cwd input on desktop non-touch and skips focus on coarse touch', { timeout: 60_000 }, async () => {
    stubMatchMedia(() => false)
    const store = makeStandbyStore()
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: store }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )
    const customBtn = [...mounted.host.querySelectorAll<HTMLButtonElement>('.agent-standby-env-bar button')]
      .find((btn) => btn.textContent?.trim() === 'Custom')!
    assert.ok(customBtn !== null)
    await act(async () => {
      customBtn.click()
    })
    await waitForCondition(() => mounted?.host.querySelector('input.composer-env-cwd-input') !== null)
    const cwdInput = mounted.host.querySelector<HTMLInputElement>('input.composer-env-cwd-input')!
    await waitForCondition(() => document.activeElement === cwdInput)
    assert.ok(document.activeElement === cwdInput, 'clicking Custom focuses the cwd input on desktop non-touch')
    act(() => {
      typeIntoControl(cwdInput, '/tmp/custom')
    })
    assert.equal(cwdInput.value, '/tmp/custom')
    cleanup()

    // Coarse touch viewport: expanding Custom env does NOT steal focus into cwd input
    stubMatchMedia((q) => q === '(hover: none) and (pointer: coarse)')
    mounted = await mountDomRoot(
      e(HostStoreProviders, { value: makeStandbyStore() }, e(AgentStandbyPane, { profileId: 'assistant' })),
    )
    const touchCustomBtn = [...mounted.host.querySelectorAll<HTMLButtonElement>('.agent-standby-env-bar button')]
      .find((btn) => btn.textContent?.trim() === 'Custom')!
    await act(async () => {
      touchCustomBtn.click()
    })
    await flushAnimationFrames()
    const touchCwdInput = mounted.host.querySelector<HTMLInputElement>('input.composer-env-cwd-input')!
    assert.ok(touchCwdInput !== null)
    assert.ok(document.activeElement !== touchCwdInput, 'coarse touch device does not auto-focus cwd input')
  })
})
