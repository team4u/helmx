/**
 * Pure unit tests for `shortcuts-model` & `panel-focus` (runs in `pure` pool).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary, PluginSummary, Profile } from '@helmx/protocol'
import { activeTargetForPanel, resolveFocusedPanel } from '../src/lib/panel-focus.js'
import type { ResolvedTarget } from '../src/lib/types.js'
import {
  buildShortcutCatalog,
  ESC_ABORT_WINDOW_MS,
  formatModShiftShortcut,
  formatModShortcut,
  hasAnyOpenOverlay,
  hasMultipleNewTopicProfiles,
  isApplePlatform,
  isConversationAbortable,
  isEditableShortcutTarget,
  isPeriodShortcutKey,
  isSemicolonShortcutKey,
  isSlashShortcutKey,
  resolveNewTopicTarget,
  resolveShortcutKeyLower,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
} from '../src/shell/shortcuts-model.js'

function makeConversation(
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

test('shortcuts-model pure functions: split focus, status checks, key matchers and catalog contracts', { timeout: 60_000 }, () => {
  assert.equal(SIDEBAR_COLLAPSED_STORAGE_KEY, 'helmx:sidebar-collapsed')
  assert.equal(ESC_ABORT_WINDOW_MS, 1500)

  const primary: ResolvedTarget = { kind: 'conversation', conversationId: 1 }
  const split: ResolvedTarget = { kind: 'conversation', conversationId: 2 }

  assert.equal(resolveFocusedPanel('split', null), 'primary')
  assert.equal(resolveFocusedPanel('split', split), 'split')
  assert.equal(resolveFocusedPanel('primary', split), 'primary')

  assert.deepEqual(activeTargetForPanel(primary, null, 'split'), primary)
  assert.deepEqual(activeTargetForPanel(primary, split, 'split'), split)
  assert.deepEqual(activeTargetForPanel(primary, split, 'primary'), primary)

  assert.equal(isConversationAbortable(undefined), false)
  assert.equal(isConversationAbortable(makeConversation(1, { status: 'idle' })), false)
  assert.equal(isConversationAbortable(makeConversation(2, { status: 'working' })), true)

  assert.equal(formatModShortcut('K').includes('/'), false)
  assert.equal(formatModShortcut('B').endsWith('B'), true)
  assert.equal(formatModShortcut('/').endsWith('/'), true)
  assert.equal(formatModShortcut('Enter').endsWith('Enter'), true)
  assert.equal(formatModShiftShortcut('O'), isApplePlatform() ? '⌘⇧O' : 'Ctrl+Shift+O')

  assert.equal(isSlashShortcutKey({ key: '/' }), true)
  assert.equal(isSlashShortcutKey({ key: '、', code: 'Slash' }), true)
  assert.equal(isSlashShortcutKey({ key: 'Process', code: 'Slash', keyCode: 229 }), true)
  assert.equal(isSlashShortcutKey({ key: '/', isComposing: true }), false)
  assert.equal(isSlashShortcutKey({ key: '、', code: 'Slash', keyCode: 229 }, { blockProcessKeyCode: true }), false)
  assert.equal(isSlashShortcutKey({ key: 'k', code: 'KeyK' }), false)

  assert.equal(isPeriodShortcutKey({ key: '.' }), true)
  assert.equal(isPeriodShortcutKey({ key: '。', code: 'Period' }), true)
  assert.equal(isPeriodShortcutKey({ key: 'Process', code: 'Period', keyCode: 229 }), true)
  assert.equal(isPeriodShortcutKey({ key: '.', isComposing: true }), false)
  assert.equal(isPeriodShortcutKey({ key: '。', code: 'Period', keyCode: 229 }, { blockProcessKeyCode: true }), false)
  assert.equal(isPeriodShortcutKey({ key: 'o', code: 'KeyO' }), false)

  assert.equal(isSemicolonShortcutKey({ key: ';' }), true)
  assert.equal(isSemicolonShortcutKey({ key: '；', code: 'Semicolon' }), true)
  assert.equal(isSemicolonShortcutKey({ key: '；' }), true)
  assert.equal(isSemicolonShortcutKey({ key: 'Process', code: 'Semicolon', keyCode: 229 }), true)
  assert.equal(isSemicolonShortcutKey({ key: ';', isComposing: true }), false)
  assert.equal(isSemicolonShortcutKey({ key: '；', code: 'Semicolon', keyCode: 229 }, { blockProcessKeyCode: true }), false)
  assert.equal(isSemicolonShortcutKey({ key: '.', code: 'Period' }), false)

  assert.equal(resolveShortcutKeyLower({ key: 'Process', code: 'KeyI', keyCode: 229 }), 'i')
  assert.equal(resolveShortcutKeyLower({ key: 'a', code: 'KeyQ' }), 'a')

  const testProfiles: Profile[] = [
    { id: 'assistant', name: 'Assistant' },
    { id: 'coder', name: 'Coder' },
    { id: 'managed-disabled', name: 'Managed', managedByPlugin: 'ext:off' },
  ]
  const testPlugins: PluginSummary[] = [
    { id: 'ext:off', name: 'Off', version: '1.0.0', enabled: false, hooks: [], actions: [], tools: [] },
  ]
  const testConvs: ConversationSummary[] = [
    makeConversation(10, { profileId: 'coder', nodeId: 'remote-box', cwd: '/srv/app', updatedAt: 500 }),
    makeConversation(11, { profileId: 'assistant', nodeId: 'local', cwd: '', updatedAt: 200 }),
    makeConversation(12, { profileId: 'coder', ownedBy: 'helmx', nodeId: 'remote-box', cwd: '/srv/auto', updatedAt: 900 }),
    makeConversation(13, { profileId: 'managed-disabled', ownedBy: 'human', cwd: '/srv/disabled', updatedAt: 300 }),
  ]
  assert.deepEqual(
    resolveNewTopicTarget({
      activeTarget: { kind: 'conversation', conversationId: 10 },
      conversations: testConvs,
      profiles: testProfiles,
      plugins: testPlugins,
      locale: 'en',
    }),
    { kind: 'agent', profileId: 'coder', nodeId: 'remote-box', cwd: '/srv/app' },
  )
  assert.deepEqual(
    resolveNewTopicTarget({
      activeTarget: { kind: 'conversation', conversationId: 11 },
      conversations: testConvs,
      profiles: testProfiles,
      plugins: testPlugins,
      locale: 'en',
    }),
    { kind: 'agent', profileId: 'assistant' },
  )
  const standbyTarget: ResolvedTarget = { kind: 'agent', profileId: 'coder', nodeId: 'remote-box', cwd: '/srv/app' }
  assert.deepEqual(
    resolveNewTopicTarget({
      activeTarget: standbyTarget,
      conversations: testConvs,
      profiles: testProfiles,
      plugins: testPlugins,
      locale: 'en',
    }),
    standbyTarget,
  )
  assert.deepEqual(
    resolveNewTopicTarget({
      activeTarget: { kind: 'overview' },
      conversations: testConvs,
      profiles: testProfiles,
      plugins: testPlugins,
      locale: 'en',
    }),
    { kind: 'agent', profileId: 'coder' },
  )
  assert.deepEqual(
    resolveNewTopicTarget({
      activeTarget: { kind: 'conversation', conversationId: 12 },
      conversations: testConvs,
      profiles: testProfiles,
      plugins: testPlugins,
      locale: 'en',
    }),
    { kind: 'agent', profileId: 'coder' },
  )
  assert.deepEqual(
    resolveNewTopicTarget({
      activeTarget: { kind: 'conversation', conversationId: 13 },
      conversations: testConvs,
      profiles: testProfiles,
      plugins: testPlugins,
      locale: 'en',
    }),
    { kind: 'agent', profileId: 'coder' },
  )
  assert.deepEqual(
    resolveNewTopicTarget({
      activeTarget: { kind: 'overview' },
      conversations: [],
      profiles: [],
      plugins: [],
      locale: 'en',
    }),
    { kind: 'profiles' },
  )

  const catalogWithPlugin = buildShortcutCatalog({
    pluginCommands: [
      {
        pluginId: 'ext:alpha',
        spec: {
          id: 'toggle-alpha',
          title: { en: 'Toggle Alpha mode', 'zh-CN': '切换 Alpha 模式' },
          shortcut: 'Ctrl+.',
          scope: { tags: ['restricted-tag'] },
        },
      },
      {
        pluginId: 'ext:beta',
        spec: {
          id: 'no-shortcut',
          title: 'No Shortcut Command',
        },
      },
    ],
    locale: 'en',
  })
  assert.deepEqual(catalogWithPlugin.map((s) => s.key), ['navigation', 'conversation', 'composer'])
  const navItemsEn = catalogWithPlugin.find((s) => s.key === 'navigation')?.items ?? []
  assert.deepEqual(
    navItemsEn.map((item) => item.id),
    ['nav:command-palette', 'nav:new-topic', 'nav:toggle-sidebar', 'nav:open-shortcuts'],
  )
  const catalogZh = buildShortcutCatalog({ pluginCommands: [], locale: 'zh-CN' })
  const navItemsZh = catalogZh.find((s) => s.key === 'navigation')?.items ?? []
  assert.deepEqual(
    navItemsZh.map((item) => item.id),
    ['nav:command-palette', 'nav:new-topic', 'nav:toggle-sidebar', 'nav:open-shortcuts'],
  )
  const convItems = catalogWithPlugin.find((s) => s.key === 'conversation')?.items ?? []
  const switchModelIdx = convItems.findIndex((item) => item.id === 'conv:switch-model')
  const togglePlusIdx = convItems.findIndex((item) => item.id === 'conv:toggle-plus-menu')
  assert.ok(switchModelIdx >= 0)
  assert.equal(togglePlusIdx, switchModelIdx + 1, 'Ctrl+; must appear immediately after Ctrl+L in conversation shortcuts')
  assert.equal(convItems[togglePlusIdx]?.keys, 'Ctrl+;')
  assert.equal(convItems[togglePlusIdx]?.label, 'Toggle attachments & actions menu')
  assert.equal(convItems.some((item) => item.keys === 'Ctrl+.' && item.label === 'Toggle Alpha mode'), true)
  assert.equal(convItems.some((item) => item.label === 'No Shortcut Command'), false)

  const convItemsZh = catalogZh.find((s) => s.key === 'conversation')?.items ?? []
  const togglePlusZh = convItemsZh.find((item) => item.id === 'conv:toggle-plus-menu')
  assert.equal(togglePlusZh?.keys, 'Ctrl+;')
  assert.equal(togglePlusZh?.label, '展开 / 收起附件与操作菜单')

  const catalogWithoutPlugin = buildShortcutCatalog({ pluginCommands: [], locale: 'en' })
  const convItemsEmpty = catalogWithoutPlugin.find((s) => s.key === 'conversation')?.items ?? []
  assert.equal(convItemsEmpty.some((item) => item.keys === 'Ctrl+.'), false)

  assert.equal(isEditableShortcutTarget(null), false)
  assert.equal(hasAnyOpenOverlay({ kind: 'command-palette' }, false), true)
  assert.equal(hasAnyOpenOverlay(null, true), true)
  assert.equal(hasAnyOpenOverlay(null, false), false)

  assert.equal(hasMultipleNewTopicProfiles([{ id: 'assistant', name: 'Assistant' }]), false)
  assert.equal(
    hasMultipleNewTopicProfiles([
      { id: 'assistant', name: 'Assistant' },
      { id: 'coder', name: 'Coder' },
    ]),
    true,
  )
  assert.equal(
    hasMultipleNewTopicProfiles(
      [
        { id: 'assistant', name: 'Assistant' },
        { id: 'managed', name: 'Managed', managedByPlugin: 'plugin:disabled' },
      ],
      [],
    ),
    false,
  )
})
