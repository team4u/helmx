/**
 * Pure functions for global single-key shortcuts, split-focus routing, desktop
 * sidebar-collapse persistence, new-topic resolution, shortcuts catalog, and
 * command-palette ordering. Zero React / DOM mount side effects; shared by
 * HelmxStoreProvider / CommandPaletteModal / ShortcutsModal / Sidebar.
 */
import {
  resolveLocalizedText,
  type CommandSpec,
  type ConversationSummary,
  type HelmxLocale,
  type PluginSummary,
  type Profile,
  type SidebarItemSpec,
} from '@helmx/protocol/browser'
import { createWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import { isConversationArchived } from '../conversation/archive-model.js'
import { buildNewTopicCandidates } from '../overview/overview-model.js'
import type { ConversationBackgroundIndex } from './background-activity-model.js'
import { collectEnabledPluginIds, isHumanSelectableProfile } from './sidebar-model.js'
import type { ActiveModal, FocusedPanel, QualifiedUiSpec, ResolvedTarget } from '../lib/types.js'

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'helmx:sidebar-collapsed'
export const ESC_ABORT_WINDOW_MS = 1500

export type HelmxShortcutAction =
  | 'toggle-model-picker'
  | 'toggle-process-groups'
  | 'toggle-plan-mode'
  | 'focus-composer'
  | 'focus-search'
  | 'open-shortcuts'

export interface HelmxShortcutDetail {
  action: HelmxShortcutAction
  panel: FocusedPanel
}

export interface ShortcutKeyEventShape {
  key: string
  code?: string
  isComposing?: boolean
  keyCode?: number
}

export interface ResolveNewTopicTargetInput {
  activeTarget: ResolvedTarget
  conversations: ReadonlyArray<ConversationSummary>
  profiles: ReadonlyArray<Profile>
  plugins?: ReadonlyArray<PluginSummary>
  sidebarItems?: ReadonlyArray<QualifiedUiSpec<SidebarItemSpec>>
  locale?: HelmxLocale
}

export type ShortcutCatalogSectionKey = 'navigation' | 'conversation' | 'composer'

export interface ShortcutCatalogItem {
  id: string
  keys: string
  label: string
  description?: string
}

export interface ShortcutCatalogSection {
  key: ShortcutCatalogSectionKey
  title: string
  items: ShortcutCatalogItem[]
}

export interface BuildShortcutCatalogInput {
  pluginCommands: ReadonlyArray<QualifiedUiSpec<CommandSpec>>
  locale: HelmxLocale
  t?: WebMessageTranslator
}

const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '.helmx-popover-content',
  '.helmx-dropdown-content',
  '.helmx-select-popover',
  '.pane-more-popover',
  '.conversation-outline-popover',
  '.composer-popover',
  'details.composer-extras[open]',
].join(', ')

const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]'
// 统一抽屉栈是完整的会话/工作台视图（非阻断性弹窗）：对工作台快捷键视为会话上下文，
// 不计入「其他对话框打开」的阻断判定。
const NON_WORKBENCH_DIALOG_SELECTOR =
  '[role="alertdialog"], [role="dialog"]:not(.drawer-stack-dialog):not(.helmx-workbench):not(.conversation-drawer)'
const NON_MODEL_PICKER_DIALOG_SELECTOR = '[role="alertdialog"], [role="dialog"]:not(.composer-model-popover)'

export function getStoredSidebarCollapsed(): boolean {
  try {
    const saved = localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)
    return saved === '1' || saved === 'true'
  } catch {
    return false
  }
}

export function persistSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0')
  } catch {
    /* Keep the in-memory collapse state when storage is disabled */
  }
}

export function resolveFocusedPanel(
  focusedPanel: FocusedPanel,
  splitTarget: ResolvedTarget | null,
): FocusedPanel {
  return splitTarget !== null && focusedPanel === 'split' ? 'split' : 'primary'
}

export function activeTargetForPanel(
  primaryTarget: ResolvedTarget,
  splitTarget: ResolvedTarget | null,
  focusedPanel: FocusedPanel,
): ResolvedTarget {
  return resolveFocusedPanel(focusedPanel, splitTarget) === 'split' && splitTarget !== null
    ? splitTarget
    : primaryTarget
}

export function isConversationAbortable(
  conversation: Pick<ConversationSummary, 'status' | 'contextUsage'> | undefined,
): boolean {
  if (conversation === undefined) return false
  return (
    conversation.status === 'working' ||
    conversation.status === 'blocked' ||
    conversation.contextUsage?.compacting === true
  )
}

export function hasBlockingAlertDialog(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector('[role="alertdialog"]') !== null
}

export function hasDialogOpen(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector(DIALOG_SELECTOR) !== null
}

export function hasNonWorkbenchDialogOpen(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector(NON_WORKBENCH_DIALOG_SELECTOR) !== null
}

/** Detect blocking dialogs other than the ModelPicker popover (so a second Ctrl+L can toggle the open picker closed). */
export function hasNonModelPickerDialogOpen(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector(NON_MODEL_PICKER_DIALOG_SELECTOR) !== null
}

export function hasAnyOpenOverlay(activeModal: ActiveModal, drawerOpen: boolean): boolean {
  if (activeModal !== null || drawerOpen) return true
  if (typeof document === 'undefined') return false
  return document.querySelector(OVERLAY_SELECTOR) !== null
}

export function isInlineInputEscapeTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false
  return target.closest('.pane-topbar input') !== null
}

/**
 * Whether a keyboard event target is an editable control (input, textarea,
 * select, or contenteditable region) where plain single-key shortcuts like `/`
 * must not hijack typing.
 */
export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable === true) return true
  const attr = target.getAttribute('contenteditable')
  if (attr !== null && attr.trim().toLowerCase() !== 'false') return true
  const editableHost = target.closest('[contenteditable]')
  if (editableHost !== null) {
    const hostAttr = editableHost.getAttribute('contenteditable')
    if (hostAttr !== null && hostAttr.trim().toLowerCase() !== 'false') return true
  }
  return false
}

export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = nav.userAgentData?.platform ?? nav.platform ?? ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}

/** The single Mod-shortcut display label (strictly one key; no multi-key aliases). */
export function formatModShortcut(key: string): string {
  const label = key.length === 1 ? key.toUpperCase() : key
  return isApplePlatform() ? `⌘${label}` : `Ctrl+${label}`
}

/** The single Mod+Shift-shortcut display label (strictly one key; no multi-key aliases). */
export function formatModShiftShortcut(key: string): string {
  const label = key.length === 1 ? key.toUpperCase() : key
  return isApplePlatform() ? `⌘⇧${label}` : `Ctrl+Shift+${label}`
}

function isImeComposingEvent(event: ShortcutKeyEventShape): boolean {
  return event.isComposing === true || event.keyCode === 229
}

/** IME-safe matcher for '/' (supports Chinese IME producing '、' with physical code 'Slash'). */
export function isSlashShortcutKey(event: ShortcutKeyEventShape): boolean {
  if (isImeComposingEvent(event)) return false
  return event.key === '/' || event.code === 'Slash'
}

/** IME-safe matcher for '.' (supports Chinese IME producing '。' with physical code 'Period'). */
export function isPeriodShortcutKey(event: ShortcutKeyEventShape): boolean {
  if (isImeComposingEvent(event)) return false
  return event.key === '.' || event.code === 'Period'
}

/**
 * Resolve the standby target for "New topic" (shared by Mod+Shift+O and CommandPalette):
 * - Human-owned conversation with a human-selectable profile -> inherits (nodeId, cwd);
 * - Standby page of a human-selectable profile -> stays on activeTarget (preserving draft env);
 * - Overview / Settings / Screen / automated or non-selectable conversation -> first candidate
 *   from buildNewTopicCandidates, falling back to Profile Center when no selectable profile exists.
 */
export function resolveNewTopicTarget(input: ResolveNewTopicTargetInput): ResolvedTarget {
  const {
    activeTarget,
    conversations,
    profiles,
    plugins = [],
    sidebarItems = [],
    locale = 'en',
  } = input
  const enabledPluginIds = collectEnabledPluginIds(plugins)

  if (activeTarget.kind === 'conversation') {
    const conv = conversations.find((c) => c.id === activeTarget.conversationId)
    if (conv !== undefined && (conv.ownedBy ?? 'human') === 'human') {
      const profile = profiles.find((p) => p.id === conv.profileId)
      if (profile !== undefined && isHumanSelectableProfile(profile, enabledPluginIds)) {
        const nodeId = conv.nodeId || 'local'
        return {
          kind: 'agent',
          profileId: conv.profileId,
          ...(nodeId !== 'local' ? { nodeId } : {}),
          ...(conv.cwd !== '' ? { cwd: conv.cwd } : {}),
        }
      }
    }
  } else if (activeTarget.kind === 'agent') {
    const profile = profiles.find((p) => p.id === activeTarget.profileId)
    if (profile !== undefined && isHumanSelectableProfile(profile, enabledPluginIds)) {
      return activeTarget
    }
  }

  const candidates = buildNewTopicCandidates({
    profiles: [...profiles],
    conversations: [...conversations],
    plugins,
    sidebarItems: [...sidebarItems],
    locale,
  })
  const first = candidates[0]
  return first !== undefined ? { kind: 'agent', profileId: first.profileId } : { kind: 'profiles' }
}

/**
 * Single-source grouped shortcut catalog for ShortcutsModal.
 * Plugin-declared shortcuts are pulled generically from enabled `groupedUi.commands`
 * without conversation-scope filtering or plugin-ID hardcoding.
 */
export function buildShortcutCatalog(input: BuildShortcutCatalogInput): ShortcutCatalogSection[] {
  const { pluginCommands, locale } = input
  const t = input.t ?? createWebTranslator(locale)

  const navigationItems: ShortcutCatalogItem[] = [
    {
      id: 'nav:command-palette',
      keys: formatModShortcut('K'),
      label: t('modals.shortcuts.item.commandPalette'),
    },
    {
      id: 'nav:focus-search',
      keys: '/',
      label: t('modals.shortcuts.item.focusSearch'),
    },
    {
      id: 'nav:new-topic',
      keys: formatModShiftShortcut('O'),
      label: t('modals.shortcuts.item.newTopic'),
    },
    {
      id: 'nav:toggle-sidebar',
      keys: formatModShortcut('B'),
      label: t('modals.shortcuts.item.toggleSidebar'),
    },
    {
      id: 'nav:open-shortcuts',
      keys: formatModShortcut('/'),
      label: t('modals.shortcuts.item.openShortcuts'),
    },
  ]

  const conversationItems: ShortcutCatalogItem[] = [
    {
      id: 'conv:toggle-workbench',
      keys: formatModShortcut('J'),
      label: t('modals.shortcuts.item.toggleWorkbench'),
    },
    {
      id: 'conv:switch-model',
      keys: 'Ctrl+L',
      label: t('modals.shortcuts.item.switchModel'),
    },
    {
      id: 'conv:toggle-process-steps',
      keys: 'Ctrl+O',
      label: t('modals.shortcuts.item.toggleProcessSteps'),
    },
    {
      id: 'conv:abort-turn',
      keys: 'Esc × 2',
      label: t('modals.shortcuts.item.abortTurn'),
    },
  ]

  for (const cmd of pluginCommands) {
    const shortcut = typeof cmd.spec.shortcut === 'string' ? cmd.spec.shortcut.trim() : ''
    if (shortcut === '') continue
    const label = resolveLocalizedText(cmd.spec.title, locale).trim()
    if (label === '') continue
    const description =
      cmd.spec.description !== undefined
        ? resolveLocalizedText(cmd.spec.description, locale).trim() || undefined
        : undefined
    conversationItems.push({
      id: `plugin:${cmd.pluginId}/${cmd.spec.id}`,
      keys: shortcut,
      label,
      ...(description !== undefined ? { description } : {}),
    })
  }

  const composerItems: ShortcutCatalogItem[] = [
    {
      id: 'composer:send-or-steer',
      keys: 'Enter',
      label: t('modals.shortcuts.item.sendOrSteer'),
    },
    {
      id: 'composer:queue-send',
      keys: formatModShortcut('Enter'),
      label: t('modals.shortcuts.item.queueSend'),
    },
    {
      id: 'composer:newline',
      keys: 'Shift+Enter',
      label: t('modals.shortcuts.item.newline'),
    },
    {
      id: 'composer:recall-or-edit',
      keys: '↑',
      label: t('modals.shortcuts.item.recallOrEdit'),
    },
    {
      id: 'composer:slash-commands',
      keys: '/',
      label: t('modals.shortcuts.item.slashCommands'),
    },
    {
      id: 'composer:mentions',
      keys: '@',
      label: t('modals.shortcuts.item.mentions'),
    },
    {
      id: 'composer:dismiss-or-cancel',
      keys: 'Esc',
      label: t('modals.shortcuts.item.dismissOrCancel'),
    },
  ]

  return [
    {
      key: 'navigation',
      title: t('modals.shortcuts.section.navigation'),
      items: navigationItems,
    },
    {
      key: 'conversation',
      title: t('modals.shortcuts.section.conversation'),
      items: conversationItems,
    },
    {
      key: 'composer',
      title: t('modals.shortcuts.section.composer'),
      items: composerItems,
    },
  ]
}

/**
 * Pick the first N non-archived conversations for an empty search term
 * (excluding the currently viewed one).
 *
 * Attention-first ordering (shares the global attention verdict, zero
 * re-implementation): conversations that need attention (error / blocked)
 * outrank running ones (working or background in flight, when the background
 * index is provided), which outrank unread completions (done && unread); the
 * rest keep the updatedAt-descending recency order. Existing callers without
 * a background index keep working — background in-flight simply cannot be
 * detected there and falls through to the base five-state verdicts.
 */
export function selectRecentConversationsForPalette(
  conversations: ReadonlyArray<ConversationSummary>,
  activeConversationId: number | undefined,
  limit = 5,
  background?: ConversationBackgroundIndex,
): ConversationSummary[] {
  const attentionTier = (conversation: ConversationSummary): number => {
    if (conversation.status === 'error' || conversation.status === 'blocked') return 0
    if (conversation.status === 'working' || background?.get(conversation.id)?.active === true) return 1
    if (conversation.status === 'done' && conversation.unread === true) return 2
    return 3
  }
  return conversations
    .filter((c) => {
      if (isConversationArchived(c) || c.id === activeConversationId) return false
      if (c.parentConversationId === undefined && c.ownedBy === 'helmx') {
        return c.status === 'error' || c.status === 'blocked' || c.pendingAskCount > 0
      }
      return true
    })
    .slice()
    .sort((a, b) => attentionTier(a) - attentionTier(b) || b.updatedAt - a.updatedAt || b.id - a.id)
    .slice(0, limit)
}
