/**
 * Frontend extension surface: base UI, micro interactions, runtime metadata and plugin sub-slots.
 * Each extension point is referenced and rendered via named exports from client.tsx
 * (the host shares the React runtime; this package does not import React types).
 */

import type { ModelCatalog, Profile } from './assets.js'
import type { ConversationAttachmentRef, ConversationEntry, ConversationScope, ConversationSummary, ToolResultTruncation, WhenBusy } from './conversation.js'
import type { NodeInfo } from './env-rpc.js'
import type { HelmxLocale, LocaleTranslator, LocalizedText } from './locale.js'
import type { PluginSummary } from './plugin-dto.js'

/** Reserved CSS text export name kept by the compiler; the loader mounts it onto the page only after validating the module. */
export const PLUGIN_CLIENT_CSS_EXPORT = '__helmxClientCss' as const

/** Named export reference inside a plugin client.tsx build artifact. */
export interface ClientComponentRef {
  /** Source module path relative to the plugin clientRoot (e.g. 'client.tsx', 'panels/Status.tsx'; absolute paths / escaping the root via ../ are forbidden). */
  module: string
  /** Named export name. */
  export: string
}

/**
 * Common shape of all UI extension points (client.tsx track only: the declarative JSON spec track has moved out of the kernel and is provided by the builtin:json-render plugin via markdown code blocks).
 *
 * Display copy fields (`title` and the per-surface `label` / `description`) are
 * `LocalizedText`: a plain string or a per-locale map resolved by the host UI
 * via its active locale. They never influence execution. The registration
 * boundary validates them with `parseNonEmptyLocalizedText` (supported locale
 * keys, non-blank copy) — invalid declarations are rejected, never silently
 * stripped.
 */
export interface UiSpecBase {
  /** Extension-point-unique ID (final addressing is <extension>:<pluginId>/<id>). */
  id: string
  /** Display copy for the extension (resolved by the active UI locale). */
  title?: LocalizedText
  /** client.tsx component reference (requires the plugin definition to provide clientRoot). */
  client?: ClientComponentRef
  /** Conversation scope: render this extension point only for matching conversations (or when no conversation context exists). */
  scope?: ConversationScope
}

// 1. sidebar.item & sidebar.section

/**
 * Host-resolved sidebar badge tone vocabulary (drives badge coloring on the
 * activity rail, mobile quick nav and sidebar view rows). Plugins put one of
 * these strings into the doc field referenced by `SidebarItemBadgeSpec.toneField`.
 */
export const SIDEBAR_BADGE_TONES = ['error', 'warn', 'accent', 'ok', 'neutral'] as const
export type SidebarBadgeTone = (typeof SIDEBAR_BADGE_TONES)[number]

/**
 * Sidebar item attention badge: a generic doc-driven declaration (zero plugin-id
 * knowledge on the host). The host subscribes to the contributing plugin's
 * public doc and derives a count badge / quiet activity dot from plain fields.
 */
export interface SidebarItemBadgeSpec {
  /** Public doc name of this plugin to subscribe to. */
  doc: string
  /** Numeric counter field on the doc (top-level key, e.g. 'attentionCount'). Values > 0 show a count badge. */
  countField: string
  /** Optional tone field on the doc (values: SidebarBadgeTone 'error' | 'warn' | 'accent' | 'ok' | 'neutral'). */
  toneField?: string
  /**
   * Optional boolean field: when count === 0 and doc[dotField] === true, render
   * a subtle tone indicator dot (no number) for quiet background activity.
   */
  dotField?: string
  /** Optional LocalizedText or plain string summary field on the doc appended to the button tooltip / aria-label. */
  summaryField?: string
}

/** Single source of truth of allowed top-level keys on `SidebarItemBadgeSpec`. */
export const SIDEBAR_ITEM_BADGE_FIELDS = [
  'doc',
  'countField',
  'toneField',
  'dotField',
  'summaryField',
] as const satisfies readonly (keyof SidebarItemBadgeSpec)[]

export type SidebarItemBadgeField = (typeof SIDEBAR_ITEM_BADGE_FIELDS)[number]

type _AssertAllSidebarBadgeFieldsListed =
  Exclude<keyof SidebarItemBadgeSpec, SidebarItemBadgeField> extends never ? true : never
const _assertAllSidebarBadgeFieldsListed: _AssertAllSidebarBadgeFieldsListed = true
void _assertAllSidebarBadgeFieldsListed

export interface SidebarItemSpec extends UiSpecBase {
  label: LocalizedText
  icon?: string
  /** Click target, e.g. 'conversation:1', 'conversation:profile:assistant', 'screen:builtin:triggers/triggers'. */
  target?: string
  order?: number
  /**
   * Doc-driven attention badge declaration: the host subscribes to this
   * plugin's public doc and renders a generic count badge (or quiet activity
   * dot) on the sidebar view row, activity-rail quick entry and mobile quick
   * nav — no plugin-id special casing anywhere.
   */
  badge?: SidebarItemBadgeSpec
  /**
   * Global quick entry: the host surfaces this item (screen targets) as a
   * one-tap entry in the collapsed activity rail / mobile drawer regardless of
   * the active sidebar space — no new sidebar space, no plugin-id special
   * casing. Rendering still requires the referenced screen to exist among the
   * enabled plugin's contributions (a disabled plugin's items vanish with its
   * contributions), and the click goes through the standard host navigation.
   */
  quickEntry?: boolean
}

// 2. screen (full-screen custom view, supports left/right split view side by side)
export interface ScreenSpec extends UiSpecBase {
  label: LocalizedText
  icon?: string
}

// 3. timeline.renderer (take over timeline entries by entry kind / metadata)
export interface TimelineRendererSpec extends UiSpecBase {
  /** Priority descending; same priority keeps contribution order, default 0. */
  priority?: number
  /** Entry kinds to take over; omit to take over all. */
  kinds?: string[]
  /** Take over entries whose entry.data.renderer equals this value (AND with kinds). */
  matchMeta?: { renderer: string }
}

// 3.5 markdown.codeBlock (take over markdown code block rendering by fenced language)
export interface MarkdownCodeBlockSpec extends UiSpecBase {
  /** Fenced languages to take over (e.g. ['ui', 'json-render'], ['mermaid']; must be non-empty, no duplicates). */
  languages: string[]
  /** Priority descending; same priority keeps contribution order, default 0. On same-language multi-plugin conflicts the highest priority wins, ties go to the earlier contribution. */
  priority?: number
  /** Component reference (requires the plugin definition to provide clientRoot); falls back to a plain code block when no matching registration exists or the plugin is disabled. */
  client: ClientComponentRef
}

/** Standard props received by markdown.codeBlock components. */
export interface MarkdownCodeBlockProps {
  /** Lower-cased fenced language (exact match with declared languages; no substring/prefix matching). */
  language: string
  /** Raw code block text (trailing newline stripped; not parsed in any way — JSON validity is up to the component). */
  code: string
  /** Owning conversation context (undefined when rendered without a conversation). */
  conversationId?: number
}

// 4. tool.view (take over tool-call inline cards by toolName)
export interface ToolViewSpec extends UiSpecBase {
  priority?: number
  toolNames: string[]
  /**
   * When true, fully replaces the outer default .trace-row tool row (the plugin
   * component renders the pill bar and inline details itself),
   * avoiding double bars.
   */
  replaceRow?: boolean
}

// 5. composer.completer
/**
 * Completions only insert text; they never execute commands carried by
 * candidates. Item labels are runtime data produced by plugin actions/docs
 * (not registration-time display metadata), so they stay plain strings.
 */
export interface ComposerCompletionItem {
  id: string
  label: string
  insertText: string
  hint?: string
  icon?: string
}

/** Query actions receive only text and context identity (real conversations pass conversationId; the standby draft state may pass profileId). */
export interface ComposerCompletionQuery {
  query: string
  conversationId?: number
  profileId?: string
}

export interface ComposerCompletionResult {
  items: ComposerCompletionItem[]
}

/** Allowed composer completer trigger prefixes ('/' is reserved for host commands and skills). */
export const COMPOSER_COMPLETER_TRIGGERS = ['@', '#', ':'] as const
export type ComposerCompleterTrigger = (typeof COMPOSER_COMPLETER_TRIGGERS)[number]

/** Document source kinds supported by `ComposerCompletionSource`. */
export const COMPOSER_COMPLETER_DOC_KINDS = ['doc', 'sessionDoc'] as const
export type ComposerCompleterDocKind = (typeof COMPOSER_COMPLETER_DOC_KINDS)[number]

/** Document sources only read the contributing plugin's own public docs; itemsField is the top-level array field name. */
export type ComposerCompletionSource =
  | { kind: 'action'; actionId: string; actionPluginId?: string }
  | { kind: ComposerCompleterDocKind; name: string; itemsField: string }

/** Completions are rendered uniformly by the host and accept no client callbacks or views. '/' is reserved for commands and skills. */
export interface ComposerCompleterSpec extends Omit<UiSpecBase, 'client'> {
  label: LocalizedText
  trigger: ComposerCompleterTrigger
  priority?: number
  source: ComposerCompletionSource
}

// 6. workbench.panel (conversation-aware right-drawer panel)
export interface WorkbenchPanelBadgeSpec {
  /** Subscribed public doc name of this plugin. */
  doc: string
  /** Global numeric counter field name (reads docValue[countField]). */
  countField?: string
  /** Global badge tone field name (reads docValue[toneField], values: 'warn' | 'accent' | 'neutral'). */
  toneField?: string
  /**
   * Field name of the stats map indexed by conversation ID (reads
   * docValue[byConversationField][String(conversationId)], shaped as
   * { count: number; tone?: 'warn' | 'accent' | 'neutral'; footerText?: LocalizedText }).
   */
  byConversationField?: string
}

/** Single source of truth of allowed top-level keys on `WorkbenchPanelBadgeSpec`. */
export const WORKBENCH_PANEL_BADGE_FIELDS = [
  'doc',
  'countField',
  'toneField',
  'byConversationField',
] as const satisfies readonly (keyof WorkbenchPanelBadgeSpec)[]

export type WorkbenchPanelBadgeField = (typeof WORKBENCH_PANEL_BADGE_FIELDS)[number]

type _AssertAllWorkbenchBadgeFieldsListed =
  Exclude<keyof WorkbenchPanelBadgeSpec, WorkbenchPanelBadgeField> extends never ? true : never
const _assertAllWorkbenchBadgeFieldsListed: _AssertAllWorkbenchBadgeFieldsListed = true
void _assertAllWorkbenchBadgeFieldsListed

export interface WorkbenchPanelSpec extends UiSpecBase {
  label: LocalizedText
  icon?: string
  order?: number
  /** Dynamic badge and status bar config (drives workbench drawer tab counts, footer summaries and the top bar "Workbench" aggregate badge). */
  badge?: WorkbenchPanelBadgeSpec
}

// 7. commandPalette (⌘K) & settings.panel
export interface CommandSpec extends UiSpecBase {
  title: LocalizedText
  icon?: string
  /** Trigger word without /; also derives the composer slash menu. Must not override host reserved commands. */
  slash?: string
  /** Display copy describing the command (resolved by the active UI locale). */
  description?: LocalizedText
  /** Short display shortcut label shown in the command palette and shortcuts modal (e.g. 'Ctrl+.'; max 32 chars). */
  shortcut?: string
  /** Quick commands reuse the ctx.action endpoint. */
  actionId?: string
  actionPluginId?: string
  input?: Record<string, unknown>
  keywords?: string[]
}

export interface SettingsPanelSpec extends UiSpecBase {
  label: LocalizedText
  order?: number
}

/** Injects content into a named sub-slot of another plugin. */
export interface PluginSlotContributionSpec extends UiSpecBase {
  /** <ownerPluginId>/<slotName>, must contain exactly one /. */
  target: string
  /** Component reference (requires the plugin definition to provide clientRoot or prebuiltClientDir; slots only support the client track). */
  client: ClientComponentRef
  order?: number
  priority?: number
}

/** Fully qualified name of the Profile detail drawer plugin extension sub-slot (provided by builtin:profile, injected by other plugins). */
export const PROFILE_DETAIL_SECTION_SLOT = 'builtin:profile/detail-section' as const

/** Namespace reserved by the host node center; does not imply a builtin:node plugin exists. */
export const NODE_DETAIL_SECTION_SLOT = 'builtin:node/detail-section' as const

/** Namespace reserved by the host composer status row; does not imply a builtin:composer plugin exists.
 * Contribution components receive ComposerStatusSlotProps (real conversations
 * pass ComposerScopeProps with conversation + composer; standby drafts pass
 * effectiveModel + profileId) and render next to the read-only context usage
 * state; metrics such as builtin:token-speed and builtin:magpie quota
 * indicators are contributed through this slot; on mobile they also stay in
 * the toolbar status area (not folded into the more menu). */
export const COMPOSER_STATUS_SLOT = 'builtin:composer/status' as const

/** Namespace reserved by the host composer interactive toolbar; does not imply a builtin:composer plugin exists.
 * Intended strictly for compact active-state pills or minimal inline indicators inside
 * `.composer-toolbar-left` next to `ModelPicker` (real conversations pass
 * `conversation` + `composer`; standby drafts pass `effectiveModel`, `profileId`,
 * per-draft `draftMeta`, `setDraftMeta`, and `disabled`). */
export const COMPOSER_TOOLBAR_SLOT = 'builtin:composer/toolbar' as const

/** Namespace reserved by the host composer unified `+` menu; does not imply a builtin:composer plugin exists.
 * Intended for mode toggles and action items (`DropdownMenuItem`) mounted inside the unified
 * composer `+` DropdownMenu (real conversations pass `conversation` + `composer` + `onCloseMenu`;
 * standby drafts pass `effectiveModel`, `profileId`, `draftMeta`, `setDraftMeta`, `disabled`, and `onCloseMenu`). */
export const COMPOSER_MENU_SLOT = 'builtin:composer/menu' as const

/** Namespace reserved by the host composer top tray; does not imply a builtin:composer plugin exists.
 * Contribution components receive ComposerScopeProps (conversation + composer)
 * and render directly above the AskDock (not folded into a more menu on either
 * desktop or mobile); with nothing in flight they should return null to zero
 * the height. */
export const COMPOSER_DOCK_SLOT = 'builtin:composer/dock' as const

/** Namespace reserved by the host conversation overview card metadata area; does not imply a builtin:overview plugin exists.
 * Read-only badge/link pills (e.g. task number + column link) are contributed via ctx.ui.slot; heavy actions belong in the plugin's own screen/drawer. */
export const OVERVIEW_CARD_META_SLOT = 'builtin:overview/card-meta' as const

/** Single source of truth of the 7 host-reserved sub-slot target identifiers. */
export const HOST_SLOT_TARGETS = [
  PROFILE_DETAIL_SECTION_SLOT,
  NODE_DETAIL_SECTION_SLOT,
  COMPOSER_STATUS_SLOT,
  COMPOSER_TOOLBAR_SLOT,
  COMPOSER_MENU_SLOT,
  COMPOSER_DOCK_SLOT,
  OVERVIEW_CARD_META_SLOT,
] as const

export type HostSlotTarget = (typeof HOST_SLOT_TARGETS)[number]

export interface HostSlotCatalogEntry {
  readonly target: HostSlotTarget
  readonly ownerPluginId: string
  readonly slotName: string
  readonly mode: 'list' | 'single'
  readonly propsType: string
  readonly conversationContext: 'none' | 'optional' | 'required'
  readonly description: string
}

/** Single read-only protocol catalog of the 7 real host-mounted sub-slots. */
export const HOST_SLOT_CATALOG = Object.freeze([
  Object.freeze({
    target: PROFILE_DETAIL_SECTION_SLOT,
    ownerPluginId: 'builtin:profile',
    slotName: 'detail-section',
    mode: 'list',
    propsType: 'ProfileDetailSlotProps',
    conversationContext: 'none',
    description: 'Profile detail drawer extension section',
  }),
  Object.freeze({
    target: NODE_DETAIL_SECTION_SLOT,
    ownerPluginId: 'builtin:node',
    slotName: 'detail-section',
    mode: 'list',
    propsType: 'NodeDetailSlotProps',
    conversationContext: 'none',
    description: 'Existing node detail drawer extension section',
  }),
  Object.freeze({
    target: COMPOSER_STATUS_SLOT,
    ownerPluginId: 'builtin:composer',
    slotName: 'status',
    mode: 'list',
    propsType: 'ComposerStatusSlotProps',
    conversationContext: 'optional',
    description: 'Read-only telemetry row below composer (persisted conversation or standby draft)',
  }),
  Object.freeze({
    target: COMPOSER_TOOLBAR_SLOT,
    ownerPluginId: 'builtin:composer',
    slotName: 'toolbar',
    mode: 'list',
    propsType: 'ComposerToolbarSlotProps',
    conversationContext: 'optional',
    description: 'Compact interactive input controls inside composer toolbar (persisted conversation or standby draft)',
  }),
  Object.freeze({
    target: COMPOSER_MENU_SLOT,
    ownerPluginId: 'builtin:composer',
    slotName: 'menu',
    mode: 'list',
    propsType: 'ComposerMenuSlotProps',
    conversationContext: 'optional',
    description: 'Action and mode items inside the composer unified + dropdown menu (persisted conversation or standby draft)',
  }),
  Object.freeze({
    target: COMPOSER_DOCK_SLOT,
    ownerPluginId: 'builtin:composer',
    slotName: 'dock',
    mode: 'list',
    propsType: 'ComposerScopeProps',
    conversationContext: 'required',
    description: 'In-flight activity tray directly above AskDock in the composer',
  }),
  Object.freeze({
    target: OVERVIEW_CARD_META_SLOT,
    ownerPluginId: 'builtin:overview',
    slotName: 'card-meta',
    mode: 'list',
    propsType: 'OverviewCardMetaSlotProps',
    conversationContext: 'required',
    description: 'Read-only metadata pill area on conversation overview cards',
  }),
] as const satisfies readonly HostSlotCatalogEntry[])

type _AssertAllHostSlotsCataloged =
  Exclude<HostSlotTarget, (typeof HOST_SLOT_CATALOG)[number]['target']> extends never
    ? true
    : never
const _assertAllHostSlotsCataloged: _AssertAllHostSlotsCataloged = true
void _assertAllHostSlotsCataloged

/** Only mounted for existing nodes; contains no node access tokens or other credentials. */
export interface NodeDetailSlotProps {
  nodeId: string
  isLocal: boolean
  isOnline: boolean
  isNew: boolean
}

/** Generic props passed to plugin client.tsx components for the target: PROFILE_DETAIL_SECTION_SLOT sub-slot (without concrete plugin business fields). */
export interface ProfileDetailSlotProps {
  /** The single Profile ID currently being viewed/edited (empty string in create mode). */
  profileId: string
  /** Whether the drawer is in new-Profile mode (not yet persisted). */
  isNew: boolean
  /** Whether the host drawer is in a saving/deleting disabled state. */
  disabled: boolean
}

/** Props passed to plugin client.tsx components for the target: OVERVIEW_CARD_META_SLOT sub-slot (read-only metadata pills on a host conversation overview card). */
export interface OverviewCardMetaSlotProps {
  /** Root conversation of the overview card. */
  rootConversation: ConversationSummary
  /** All conversation IDs in this tree (root included). */
  memberIds: ReadonlyArray<number>
}

/** ctx.ui: base extension surface plus fine-grained composition extension surfaces. */
export interface PluginUiRegistry {
  sidebarItem(spec: SidebarItemSpec): void
  screen(spec: ScreenSpec): void
  timelineRenderer(spec: TimelineRendererSpec): void
  markdownCodeBlock(spec: MarkdownCodeBlockSpec): void
  toolView(spec: ToolViewSpec): void
  composerCompleter(spec: ComposerCompleterSpec): void
  workbenchPanel(spec: WorkbenchPanelSpec): void
  command(spec: CommandSpec): void
  settingsPanel(spec: SettingsPanelSpec): void
  slot(spec: PluginSlotContributionSpec): void
}

// ---------------------------------------------------------------------------
// Standard component props (pure data shapes, consumed by client.tsx
// implementations and passed by the host; no React types imported)
// ---------------------------------------------------------------------------

/** screen: full-screen custom view (supports left/right split view side by side). */
export interface ScreenProps {
  pluginId: string
  screenId: string
  isSplit: boolean
  params: Readonly<Record<string, string>>
  /** undefined deletes the key; default replaces history, explicit push appends a new entry. */
  setParams(patch: Record<string, string | undefined>, options?: { push?: boolean }): void
}

/**
 * Screen params scope exposed by useScreenParams() inside a full-screen screen
 * component tree: the host ScreenHost establishes it around the mounted view
 * (main and split panes each bind their own scope; the URL hash stays the
 * single source of truth — params are the pane target's sp. / ssp. namespace
 * values, setParams is the very same implementation ScreenProps carries, no
 * second write path). Returns null outside a full-screen screen (e.g. a
 * component reused inside settings.panel) — honest absence, never a
 * fabricated no-op.
 */
export interface ScreenParamsScope {
  /** Deep-link params of the pane this component tree is mounted in (sp.* / ssp.* namespace). */
  readonly params: Readonly<Record<string, string>>
  /** Same contract as ScreenProps.setParams (bound to the owning pane). */
  setParams(patch: Record<string, string | undefined>, options?: { push?: boolean }): void
  /** Whether this component tree is mounted in the right split pane. */
  readonly isSplit: boolean
}

/** timeline.renderer: takes over rendering of a single timeline entry. */
export interface TimelineRendererProps {
  entry: ConversationEntry
  conversationId: number
}

/** tool.view: serializable data of a tool call process and result. */
export interface ToolViewProps {
  callId: string
  toolName: string
  input?: unknown
  status: 'running' | 'done' | 'error'
  result?: unknown
  /** Bounded UI presentation metadata persisted on toolResult.details (never carries bulky structuredOutput). */
  presentationMeta?: Readonly<Record<string, unknown>>
  /** Present when the result is a truncated preview from the detail endpoint; plugins must not treat result as the full original text. */
  resultTruncation?: ToolResultTruncation
  isError?: boolean
  startedAt?: number
  durationMs?: number
  artifactRef?: string
  conversationId: number
}

export interface ComposerController {
  readonly draft: string
  readonly attachments: ReadonlyArray<ConversationAttachmentRef>
  readonly sending: boolean
  setDraft(text: string): void
  insertText(text: string): void
  /** Omits text to submit the current draft with attachments; explicit text does not consume the original draft. Must reject on failure. */
  submit(text?: string, options?: { whenBusy?: WhenBusy }): Promise<void>
}

/** composer.pill / composer.widget: composer area extensions. */
export interface ComposerScopeProps {
  conversation: ConversationSummary
  composer: ComposerController
}

/** COMPOSER_STATUS_SLOT: real conversations pass ComposerScopeProps; standby drafts pass effectiveModel + profileId. */
export interface ComposerStatusSlotProps {
  conversation?: ConversationSummary
  composer?: ComposerController
  /** Effective model reference ('provider/model' or 'tier/<id>') on standby drafts before persistence. */
  effectiveModel?: string
  /** Profile ID on standby drafts before persistence. */
  profileId?: string
}

/** COMPOSER_TOOLBAR_SLOT: compact interactive input controls inside `.composer-toolbar-left`. */
export interface ComposerToolbarSlotProps {
  conversation?: ConversationSummary
  composer?: ComposerController
  /** Effective model reference ('provider/model' or 'tier/<id>') on standby drafts before persistence. */
  effectiveModel?: string
  /** Profile ID on standby drafts before persistence. */
  profileId?: string
  /** Per-draft input metadata map carried onto the first `submitInput` on standby drafts. */
  draftMeta?: Readonly<Record<string, unknown>>
  /** Update or clear a single entry in the standby draft's `inputMeta` map (`undefined` deletes). */
  setDraftMeta?: (key: string, value: unknown) => void
  /** True when the standby draft is locked/busy or ineligible for input controls. */
  disabled?: boolean
}

/** COMPOSER_MENU_SLOT: action and mode items rendered inside the composer unified `+` DropdownMenu. */
export interface ComposerMenuSlotProps extends ComposerToolbarSlotProps {
  /** Optional callback to close the host dropdown menu when a custom item needs explicit dismissal. */
  onCloseMenu?: () => void
}

/** workbench.panel: conversation-aware right-drawer panel. */
export interface WorkbenchPanelProps {
  conversation: ConversationSummary
  /** Optional transient focus/deep-link parameters passed via `ctx.openWorkbench(panelId, params)`. */
  params?: Readonly<Record<string, unknown>>
}

/**
 * Serialized UI contribution (element of the ui array in event snapshots):
 * surface is the extension point name (e.g. 'sidebar.item', 'screen', 'timeline.renderer').
 */
export interface PluginUiContribution {
  pluginId: string
  surface: string
  spec: unknown
}

/**
 * Known UI contributions of the discriminated union: covers all registered
 * surfaces so consumers (e.g. groupUiContributions) can skip `as unknown as`
 * casts after the guard.
 */
export type KnownPluginUiContribution =
  | { pluginId: string; surface: 'sidebar.item'; spec: SidebarItemSpec }
  | { pluginId: string; surface: 'screen'; spec: ScreenSpec }
  | { pluginId: string; surface: 'timeline.renderer'; spec: TimelineRendererSpec }
  | { pluginId: string; surface: 'markdown.codeBlock'; spec: MarkdownCodeBlockSpec }
  | { pluginId: string; surface: 'tool.view'; spec: ToolViewSpec }
  | { pluginId: string; surface: 'composer.completer'; spec: ComposerCompleterSpec }
  | { pluginId: string; surface: 'workbench.panel'; spec: WorkbenchPanelSpec }
  | { pluginId: string; surface: 'commandPalette' | 'command'; spec: CommandSpec }
  | { pluginId: string; surface: 'settings.panel'; spec: SettingsPanelSpec }
  | { pluginId: string; surface: 'plugin.slot'; spec: PluginSlotContributionSpec }

/** Single source of truth of known UI contribution surfaces (bi-directionally locked with KnownPluginUiContribution). */
export const KNOWN_PLUGIN_UI_SURFACES = [
  'sidebar.item',
  'screen',
  'timeline.renderer',
  'markdown.codeBlock',
  'tool.view',
  'composer.completer',
  'workbench.panel',
  'commandPalette',
  'command',
  'settings.panel',
  'plugin.slot',
] as const satisfies readonly KnownPluginUiContribution['surface'][]

type _AssertAllKnownUiSurfacesListed =
  Exclude<KnownPluginUiContribution['surface'], (typeof KNOWN_PLUGIN_UI_SURFACES)[number]> extends never
    ? true
    : never
const _assertAllKnownUiSurfacesListed: _AssertAllKnownUiSurfacesListed = true
void _assertAllKnownUiSurfacesListed

const KNOWN_PLUGIN_UI_SURFACE_SET: ReadonlySet<string> = new Set(KNOWN_PLUGIN_UI_SURFACES)

const COMMAND_SHORTCUT_MAX_LENGTH = 32

/**
 * Validate and narrow a PluginUiContribution: checks the known surface and a
 * non-null plain-object spec, then returns the discriminated-union member;
 * unknown surfaces or non-object specs return undefined.
 */
export function parsePluginUiContribution(
  item: PluginUiContribution,
): KnownPluginUiContribution | undefined {
  if (item === null || typeof item !== 'object') return undefined
  if (typeof item.pluginId !== 'string' || typeof item.surface !== 'string') return undefined
  if (!KNOWN_PLUGIN_UI_SURFACE_SET.has(item.surface)) return undefined
  if (item.spec === null || typeof item.spec !== 'object' || Array.isArray(item.spec)) return undefined
  if (item.surface === 'commandPalette' || item.surface === 'command') {
    const rawSpec = item.spec as Record<string, unknown>
    if (Object.hasOwn(rawSpec, 'shortcut')) {
      const rawShortcut = rawSpec['shortcut']
      const trimmed = typeof rawShortcut === 'string' ? rawShortcut.trim() : ''
      if (trimmed.length >= 1 && trimmed.length <= COMMAND_SHORTCUT_MAX_LENGTH) {
        if (trimmed !== rawShortcut) {
          return {
            pluginId: item.pluginId,
            surface: item.surface,
            spec: { ...rawSpec, shortcut: trimmed } as unknown as CommandSpec,
          }
        }
      } else {
        const { shortcut: _ignored, ...rest } = rawSpec
        return {
          pluginId: item.pluginId,
          surface: item.surface,
          spec: rest as unknown as CommandSpec,
        }
      }
    }
  }
  return item as KnownPluginUiContribution
}

// ---------------------------------------------------------------------------
// client.tsx track: runtime contract between host and plugin components
// (pure types, no React import)
// ---------------------------------------------------------------------------

/**
 * Host context inside client.tsx components (return value of usePluginContext()):
 * all capabilities come from the real host (callAction goes through
 * POST /api/actions, openScreen/openSplitScreen go through host navigation,
 * getPluginDoc is a one-shot read); no mocks.
 * For reactive doc subscriptions use usePluginDoc from the shared module
 * (import from '@helmx/plugin-client').
 */
export interface CallActionOptions {
  pluginId?: string
  conversationId?: number
}

export interface PluginClientContext {
  pluginId: string
  /** Defaults to addressing the current plugin and slot conversation; can explicitly cross plugins. */
  callAction(actionId: string, input?: unknown, options?: CallActionOptions): Promise<unknown>
  /**
   * Authenticated HTTP fetch scoped to `/api/plugins/<encodeURIComponent(pluginId)>/routes<path>`.
   * The host injects the Bearer auth token without exposing it to plugin code.
   * `path` must start with `/` and stay strictly inside this plugin's route namespace
   * (traversal or attempts to escape the namespace are explicitly rejected).
   */
  fetchRoute(path: string, init?: RequestInit): Promise<Response>
  /** Submits input to the target or current conversation; explicitly rejects when there is none. */
  submitInput(text: string, options?: { conversationId?: number; whenBusy?: WhenBusy }): Promise<void>
  /** Opens a target on the main screen (conversation:<id> / screen:<pluginId>/<screenId> etc.). */
  openScreen(target: string): void
  /** Opens a target in the right split pane. */
  openSplitScreen(target: string): void
  /** Opens the sub-conversation side drawer modal (unified sub-conversation view entry; does not change workbench open state). */
  openConversationDrawer(conversationId: number): void
  /** Opens the artifact preview modal. */
  openArtifact(artifactId: string): void
  /**
   * Opens the workbench drawer.
   * - `panelId`: local panel ID registered by this plugin (automatically qualified to
   *   `plugin:<pluginId>/<panelId>`), a built-in host tab (`'artifacts'` / `'files'`),
   *   or an explicit `'plugin:<id>/<panel>'` target;
   * - `params`: optional focus/deep-link payload delivered via `WorkbenchPanelProps.params`.
   */
  openWorkbench(panelId?: string, params?: Record<string, unknown>): void
  /** Closes the workbench drawer. */
  closeWorkbench(): void
  /** Sends a global notification toast. */
  notify(message: string, tone?: 'info' | 'warning' | 'error'): void
  /** Reads the current value of this plugin's public doc (one-shot Promise; for subscription updates use the usePluginDoc shared hook). */
  getPluginDoc(docName: string, pluginId?: string): Promise<unknown>
  getPluginSessionDoc(docName: string, options?: { conversationId?: number; pluginId?: string }): Promise<unknown>
  /** Provided only by composer-area extensions and their sub-slots. */
  composer?: ComposerController
  /** Current conversation ID (undefined for slots without conversation context, e.g. some settings.panel). */
  conversationId?: number
  /** Current host theme. */
  theme: 'light' | 'dark'
  /** Current host UI locale (normalized via HELMX_LOCALES / normalizeLocaleTag). */
  locale: HelmxLocale
  /** Minimal translator: resolves LocalizedText display copy for the current locale. */
  translate: LocaleTranslator
}

/**
 * Host shared module importable by plugin client.tsx (the compiler virtualizes
 * it into the __helmx_shared_plugin_client global namespace, sharing the same
 * mechanism as React — never bundles a second React copy).
 *
 * The single source of truth of exported symbols is PLUGIN_CLIENT_SHARED_EXPORTS:
 * - hooks: usePluginContext / usePluginLocale / usePluginTranslator / usePluginDoc /
 *   usePluginDocState / usePluginSessionDoc / usePluginSessionDocState /
 *   useToolActivity / useTimelineToolCalls / useConversations / useConversation /
 *   usePlugins / useScreenParams (screen-local params scope provided by the host ScreenHost) /
 *   usePluginConfig / useHostModels / useHostNodes / useHostProfiles (stable-handle reads of host
 *   read-only catalog slices; isolation contract pinned by @helmx/plugin-client tests — unrelated
 *   host port revisions must not re-render consumers);
 * - ModelPickerControl: shared model + thinking-level picker (reads the catalog via the useHostModels
 *   host port slice; apply/reset callbacks keep the PI follow-default semantics);
 * - model formatting pure functions: formatModelShortName / resolveEffectiveThinkingLevel;
 * - accessibility base components: Switch / Select / MultiSelect / Checkbox / Tabs family /
 *   SegmentedControl / HelmxIcon / ViewBoundary / Callout / Dialog family / AlertDialog family
 *   (confirm dialogs) / ConfirmDialog (minimal double-confirm composition);
 * - unified light patterns: SearchBox (container-class search input with the single clear button,
 *   always type="text" per the shared search-box spec) / EmptyState (host .empty-state vocabulary
 *   with optional icon/title/hint/compact);
 * - StatusLight: unified status light (visually dot-only; the localized label
 *   becomes the screen-reader accessible name, never visible status text) for
 *   card main status slots, reusing the host .status-dot vocabulary;
 * - lightweight layout primitives: Screen (page container + header) / ScreenSection (sectioning) /
 *   ScreenToolbar (header-to-content toolbar row) / DataTable (composable table with unified
 *   loading/empty) / KvGrid (key-value overview) / DetailDrawer (right-side detail drawer shell
 *   over the host .primary-drawer-* vocabulary; the header/meta/body/footer stay composable JSX,
 *   state and data belong to the caller) / DockTray & DockTrayRow (shared composer-dock in-flight
 *   HUD tray over the host .dock-tray* vocabulary);
 * - content display: MarkdownView (standard markdown rendering) / CodeBlockView
 *   (syntax-highlighted code block) / CopyButton (copy button);
 * - formatting pure functions: formatTime (compact MM-DD HH:mm) / formatCompactTimestamp
 *   (MM-DD HH:mm:ss log timestamp) / formatDurationMs (millisecond duration summary) /
 *   formatStopwatchMs (1Hz whole-second stopwatch Xs / XmYYs / XhYYm) /
 *   formatOffsetMs (relative offset +MM:SS / +H:MM:SS) /
 *   resolveConversationTiming (honest conversation timing snapshot) /
 *   formatBytes (human-readable bytes, 1024-based);
 * - PluginSlot: inter-plugin sub-slot rendering primitive.
 */

/** Honest three-state lifecycle for reactive plugin doc / sessionDoc state hooks. */
export type PluginDocLoadStatus = 'loading' | 'ready' | 'error'

/** Reactive state returned by `usePluginDocState` and `usePluginSessionDocState`. */
export interface PluginDocState<T = unknown> {
  data: T | undefined
  status: PluginDocLoadStatus
  error?: string
  retry: () => void
}

/** usePlugins(): reactive snapshot of host plugin list and Screen contributions (SSE driven, no polling). */
export interface UsePluginsResult {
  /** Current plugin summaries of the host (kept in sync with SSE plugin.changed in real time). */
  plugins: PluginSummary[]
  /** Screen contribution list registered by currently enabled plugins (with owning pluginId). */
  screens: Array<{ pluginId: string; spec: ScreenSpec }>
}


// ---------------------------------------------------------------------------
// Host capability slices: read-only host facts shared with plugin views
// (reactively read through stable host handles — never as churning Context
// data members; an absent capability means "unknown", never fabricated data)
// ---------------------------------------------------------------------------

/**
 * Normalized per-model view of the host model catalog: the exact shape the
 * host derives from `GET /api/models` (single implementation of the
 * normalization stays in the host; the SDK forwards the same reference, never
 * a copy or a mock). Contract single source of this shape — web may alias its
 * legacy descriptor to it, parallel field sets are forbidden.
 */
export interface HostModelEntry {
  /** Full `'provider/modelId'` reference (the value stored in configs / overrides). */
  id: string
  provider: string
  modelId: string
  /** false = listed in the catalog but currently unusable (render dimmed), not "removed". */
  available: boolean
  /** Host-side model disable-filter annotation (independent from `available`). */
  disabled?: boolean
  /** Display label (defaults to modelId). */
  label?: string
  /** Capability table of thinking levels in display order; carries no profile-effective values. */
  thinkingLevels: readonly string[]

  /** Real known model context window (tokens); omitted when unknown. */
  contextWindow?: number
}

/**

 * useHostModels(): reactive read-only model catalog slice — normalized
 * entries plus the global default chain (the top-level fields of
 * `ModelCatalog`; per-model thinking levels are already embedded in each
 * entry, so the catalog's separate `thinkingLevels` map is not carried). The
 * slice is a faithful read-only view of one `GET /api/models` response.
 * `undefined` = the capability is not injected or the catalog has not
 * finished its first load (render unknown/loading and disable selection,
 * never a fabricated empty catalog); a slice with `models: []` = loaded and
 * genuinely empty — the two states are strictly distinct. Dynamic refresh,
 * when offered, is the handle's optional refreshModels action.
 */
export interface HostModelsSlice extends Omit<ModelCatalog, 'models' | 'thinkingLevels'> {
  models: ReadonlyArray<HostModelEntry>
}

/**
 * useHostNodes(): reactive read-only compute node list slice (`GET /api/nodes` /
 * SSE `snapshot.nodes` + `node.changed`; never exposes node access tokens).
 * Preserves the same honest three-state semantics as `HostModelsSlice`:
 * `undefined` = capability is not injected or initial load has not completed
 * (render unknown/loading and disable selection, never fabricate an empty list);
 * `[]` = loaded and genuinely empty.
 */
export type HostNodesSlice = ReadonlyArray<NodeInfo>

/**
 * useHostProfiles(): reactive read-only Profile catalog slice (`GET /api/profiles` /
 * SSE `profile.changed`; excludes `SYSTEM.md` bodies).
 * Preserves the same honest three-state semantics as `HostModelsSlice`:
 * `undefined` = capability is not injected or initial load has not completed
 * (render unknown/loading and disable selection, never fabricate an empty list);
 * `[]` = loaded and genuinely empty.
 */
export type HostProfilesSlice = ReadonlyArray<Profile>

/** Execution status of a timeline tool call summary. */
export type TimelineToolCallStatus = 'running' | 'done' | 'error'

/**
 * Lightweight, toolName-sharded summary of one tool call in the active timeline
 * (returned by `useTimelineToolCalls(toolName)`).
 * Omits bulky `result` text and truncation payloads; carries only bounded UI metadata.
 */
export interface TimelineToolCallSummary {
  callId: string
  toolName: string
  /** Chronological 0-based position of this tool call within the loaded timeline. */
  index: number
  status: TimelineToolCallStatus
  input?: unknown
  /** Bounded UI metadata persisted on toolResult.details (never carries raw result text). */
  presentationMeta?: Readonly<Record<string, unknown>>
}

/** GET /api/plugins/:id/client.mjs response metadata (HTTP error envelope on failure, never JS). */
export interface PluginClientModuleInfo {
  pluginId: string
  /** Requested module relative path. */
  module: string
  /** Build artifact content hash (including all local dependencies; recompiled when sources change). */
  contentHash: string
}

/** Single source of truth of all ctx.ui registration method names (bi-directionally locked with the PluginUiRegistry interface). */
export const PLUGIN_UI_METHOD_NAMES = [
  'sidebarItem',
  'screen',
  'timelineRenderer',
  'markdownCodeBlock',
  'toolView',
  'composerCompleter',
  'workbenchPanel',
  'command',
  'settingsPanel',
  'slot',
] as const satisfies readonly (keyof PluginUiRegistry)[]

type _AssertAllPluginUiMethodsListed =
  Exclude<keyof PluginUiRegistry, (typeof PLUGIN_UI_METHOD_NAMES)[number]> extends never
    ? true
    : never
const _assertAllPluginUiMethodsListed: _AssertAllPluginUiMethodsListed = true
void _assertAllPluginUiMethodsListed

/** Host reserved in-conversation slash command triggers (plugin command.slash must not occupy them). */
export const RESERVED_SLASH_COMMANDS = ['new', 'clear', 'compact'] as const

/** Single source of truth of runtime symbols exported by @helmx/plugin-client for plugin client.tsx. */
export const PLUGIN_CLIENT_SHARED_EXPORTS = [
  'usePluginContext',
  'usePluginLocale',
  'usePluginTranslator',
  'usePluginDoc',
  'usePluginDocState',
  'usePluginSessionDoc',
  'usePluginSessionDocState',
  'useToolActivity',
  'useTimelineToolCalls',
  'useConversations',
  'useConversation',
  'usePlugins',
  'usePluginConfig',
  'useScreenParams',
  'useHostModels',
  'useHostNodes',
  'useHostProfiles',
  'useSharedNowMs',
  'usePluginAction',
  'ModelPickerControl',
  'formatModelShortName',
  'resolveEffectiveThinkingLevel',
  'usePanelShortcut',
  'useComposerCommand',
  'PluginSlot',
  'PluginScope',
  'Switch',
  'Select',
  'MultiSelect',
  'Checkbox',
  'Tabs',
  'TabsList',
  'TabsTrigger',
  'TabsContent',
  'SegmentedControl',
  'HelmxIcon',
  'MarkdownView',
  'MarkdownText',
  'CodeBlockView',
  'ToolCallDetails',
  'CopyButton',
  'ViewBoundary',
  'Callout',
  'StatusLight',
  'STATUS_LIGHT_TONES',
  'normalizeStatusLightTone',
  'isKnownStatusLightStatus',
  'Button',
  'IconButton',
  'Badge',
  'Stack',
  'Input',
  'Textarea',
  'Field',
  'HelperText',
  'ErrorText',
  'Card',
  'SelectCard',
  'CardGrid',
  'MonoId',
  'Dialog',
  'DialogPortal',
  'DialogOverlay',
  'DialogContent',
  'DialogTitle',
  'DialogDescription',
  'DialogClose',
  'DialogTrigger',
  'Popover',
  'PopoverTrigger',
  'PopoverContent',
  'PopoverClose',
  'Tooltip',
  'TooltipProvider',
  'TooltipRoot',
  'TooltipTrigger',
  'TooltipContent',
  'DropdownMenu',
  'DropdownMenuRoot',
  'DropdownMenuTrigger',
  'DropdownMenuPortal',
  'DropdownMenuContent',
  'DropdownMenuItem',
  'DropdownMenuSeparator',
  'DropdownMenuLabel',
  'DropdownMenuGroup',
  'AlertDialog',
  'AlertDialogPortal',
  'AlertDialogOverlay',
  'AlertDialogContent',
  'AlertDialogTitle',
  'AlertDialogDescription',
  'AlertDialogAction',
  'AlertDialogCancel',
  'AlertDialogTrigger',
  'ConfirmDialog',
  'SearchBox',
  'EmptyState',
  'LoadingState',
  'Screen',
  'ScreenSection',
  'ScreenToolbar',
  'DataTable',
  'KvGrid',
  'DetailDrawer',
  'DockTray',
  'DockTrayRow',
  'formatTime',
  'formatCompactTimestamp',
  'formatDurationMs',
  'formatStopwatchMs',
  'formatOffsetMs',
  'resolveConversationTiming',
  'formatBytes',
] as const
