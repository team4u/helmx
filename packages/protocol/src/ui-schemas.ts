/**
 * Single source of truth for server-side plugin UI spec TypeBox schemas and validation patterns.
 *
 * Every schema here is bi-directionally compile-time locked against the TypeScript interfaces in
 * `./ui.ts` (`Static<typeof Schema>` === contract slice) and consumed directly by kernel's
 * `ui-spec-validators.ts` — eliminating dual definitions between protocol and kernel.
 *
 * Exported ONLY from `@helmx/protocol` (never from `@helmx/protocol/browser`) so browser bundles
 * do not pull in server-side TypeBox schema builders or registration validators.
 */
import { Type, type Static } from 'typebox'
import {
  COMPOSER_COMPLETER_DOC_KINDS,
  COMPOSER_COMPLETER_TRIGGERS,
  type CommandSpec,
  type ComposerCompleterSpec,
  type ComposerCompletionSource,
  type MarkdownCodeBlockSpec,
  type PluginSlotContributionSpec,
  type ScreenSpec,
  type SettingsPanelSpec,
  type SidebarItemBadgeSpec,
  type SidebarItemSpec,
  type TimelineRendererSpec,
  type ToolViewSpec,
  type WorkbenchPanelBadgeSpec,
  type WorkbenchPanelSpec,
} from './ui.js'

/** Single source of truth of UI spec field format regex patterns. */
export const UI_SPEC_PATTERNS = Object.freeze({
  actionIdNoDot: /^[^.]+$/,
  commandActionId: /^[A-Za-z0-9_-]+$/,
  commandSlash: /^[a-z0-9][a-z0-9:_-]{0,63}$/,
  commandShortcut: /^\S(?:[^\r\n\t]{0,30}\S)?$/,
  commandTarget: /^\S(?:[^\r\n\t\x00-\x1f\x7f]{0,510}\S)?$/,
  searchKeyword: /^\S(?:[^\r\n\t\x00-\x1f\x7f]*\S)?$/,
  markdownLanguage: /^[a-z0-9][a-z0-9-]{0,31}$/,
  completerDocName: /^[A-Za-z0-9._-]+$/,
  completerItemsField: /^[A-Za-z0-9_$][A-Za-z0-9_$-]{0,127}$/,
  slotOwnerPluginId: /^[A-Za-z0-9:_-]+$/,
  slotName: /^[A-Za-z0-9._-]+$/,
})

const NonEmptyString = Type.String({ minLength: 1 })
const ActionIdNoDotSchema = Type.String({ minLength: 1, pattern: UI_SPEC_PATTERNS.actionIdNoDot.source })
const CommandActionIdSchema = Type.String({ pattern: UI_SPEC_PATTERNS.commandActionId.source })
const CommandSlashSchema = Type.String({ pattern: UI_SPEC_PATTERNS.commandSlash.source })
const CommandShortcutSchema = Type.String({
  minLength: 1,
  maxLength: 32,
  pattern: UI_SPEC_PATTERNS.commandShortcut.source,
})
const CommandTargetSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: UI_SPEC_PATTERNS.commandTarget.source,
})
const SearchKeywordSchema = Type.String({
  minLength: 1,
  pattern: UI_SPEC_PATTERNS.searchKeyword.source,
})
const KeywordsSchema = Type.Array(SearchKeywordSchema)
const MarkdownLanguageSchema = Type.String({ pattern: UI_SPEC_PATTERNS.markdownLanguage.source })
const CompleterDocNameSchema = Type.String({ pattern: UI_SPEC_PATTERNS.completerDocName.source })
const CompleterItemsFieldSchema = Type.String({ pattern: UI_SPEC_PATTERNS.completerItemsField.source })

const CommandPaletteSpecSchema = Type.Object({
  slash: Type.Optional(CommandSlashSchema),
  actionId: Type.Optional(CommandActionIdSchema),
  actionPluginId: Type.Optional(NonEmptyString),
  shortcut: Type.Optional(CommandShortcutSchema),
  target: Type.Optional(CommandTargetSchema),
  keywords: Type.Optional(KeywordsSchema),
})

const ScreenSpecSchema = Type.Object({
  keywords: Type.Optional(KeywordsSchema),
})

const SettingsPanelSpecSchema = Type.Object({
  keywords: Type.Optional(KeywordsSchema),
})

const PluginSlotTargetSchema = Type.Object({
  target: Type.String({ minLength: 1, maxLength: 512 }),
})

const TimelineRendererMatchMetaSchema = Type.Object(
  { renderer: NonEmptyString },
  { additionalProperties: false },
)

const TimelineRendererSpecSchema = Type.Object({
  matchMeta: Type.Optional(TimelineRendererMatchMetaSchema),
})

const MarkdownCodeBlockSpecSchema = Type.Object({
  languages: Type.Array(MarkdownLanguageSchema, { minItems: 1 }),
})

const ToolViewSpecSchema = Type.Object({
  replaceRow: Type.Optional(Type.Boolean()),
  foldable: Type.Optional(Type.Boolean()),
  toolNames: Type.Array(NonEmptyString, { minItems: 1 }),
})

const ComposerCompletionSourceSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('action'),
      actionId: ActionIdNoDotSchema,
      actionPluginId: Type.Optional(NonEmptyString),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Enum(COMPOSER_COMPLETER_DOC_KINDS),
      name: CompleterDocNameSchema,
      itemsField: CompleterItemsFieldSchema,
    },
    { additionalProperties: false },
  ),
])

const ComposerCompleterSpecSchema = Type.Object({
  trigger: Type.Enum(COMPOSER_COMPLETER_TRIGGERS),
  source: ComposerCompletionSourceSchema,
})

const WorkbenchPanelBadgeSchema = Type.Object(
  {
    doc: NonEmptyString,
    countField: Type.Optional(NonEmptyString),
    toneField: Type.Optional(NonEmptyString),
    byConversationField: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
)

const WorkbenchPanelSpecSchema = Type.Object({
  badge: Type.Optional(WorkbenchPanelBadgeSchema),
})

const SidebarItemBadgeSchema = Type.Object(
  {
    doc: NonEmptyString,
    countField: NonEmptyString,
    toneField: Type.Optional(NonEmptyString),
    dotField: Type.Optional(NonEmptyString),
    summaryField: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
)

const SidebarItemSpecSchema = Type.Object({
  badge: Type.Optional(SidebarItemBadgeSchema),
})

/**
 * Single source of truth of TypeBox schemas for all validated plugin UI extension surfaces.
 * Kernel compiles these directly via `typebox/compile` instead of re-declaring schemas by hand.
 */
export const UI_SPEC_SCHEMAS = Object.freeze({
  commandPalette: CommandPaletteSpecSchema,
  screen: ScreenSpecSchema,
  settingsPanel: SettingsPanelSpecSchema,
  pluginSlot: PluginSlotTargetSchema,
  timelineRenderer: TimelineRendererSpecSchema,
  markdownCodeBlock: MarkdownCodeBlockSpecSchema,
  toolView: ToolViewSpecSchema,
  composerCompleter: ComposerCompleterSpecSchema,
  workbenchPanel: WorkbenchPanelSpecSchema,
  sidebarItem: SidebarItemSpecSchema,
})

// ---------------------------------------------------------------------------
// Bi-directional compile-time locks against `./ui.ts` interfaces
// ---------------------------------------------------------------------------

type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

const _uiSchemaParityLocks: [
  AssertExact<Static<typeof CommandPaletteSpecSchema>, Pick<CommandSpec, 'slash' | 'actionId' | 'actionPluginId' | 'shortcut' | 'target' | 'keywords'>>,
  AssertExact<Static<typeof ScreenSpecSchema>, Pick<ScreenSpec, 'keywords'>>,
  AssertExact<Static<typeof SettingsPanelSpecSchema>, Pick<SettingsPanelSpec, 'keywords'>>,
  AssertExact<Static<typeof PluginSlotTargetSchema>, Pick<PluginSlotContributionSpec, 'target'>>,
  AssertExact<Static<typeof TimelineRendererMatchMetaSchema>, NonNullable<TimelineRendererSpec['matchMeta']>>,
  AssertExact<Static<typeof TimelineRendererSpecSchema>, Pick<TimelineRendererSpec, 'matchMeta'>>,
  AssertExact<Static<typeof MarkdownCodeBlockSpecSchema>, Pick<MarkdownCodeBlockSpec, 'languages'>>,
  AssertExact<Static<typeof ToolViewSpecSchema>, Pick<ToolViewSpec, 'replaceRow' | 'foldable' | 'toolNames'>>,
  AssertExact<Static<typeof ComposerCompletionSourceSchema>, ComposerCompletionSource>,
  AssertExact<Static<typeof ComposerCompleterSpecSchema>, Pick<ComposerCompleterSpec, 'trigger' | 'source'>>,
  AssertExact<Static<typeof WorkbenchPanelBadgeSchema>, WorkbenchPanelBadgeSpec>,
  AssertExact<Static<typeof WorkbenchPanelSpecSchema>, Pick<WorkbenchPanelSpec, 'badge'>>,
  AssertExact<Static<typeof SidebarItemBadgeSchema>, SidebarItemBadgeSpec>,
  AssertExact<Static<typeof SidebarItemSpecSchema>, Pick<SidebarItemSpec, 'badge'>>,
] = [
  true, true, true, true, true, true, true, true, true, true, true, true, true, true,
]
void _uiSchemaParityLocks
