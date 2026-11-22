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
  UI_ACTION_PLACEMENTS,
  UI_ACTION_ROLES,
  type ArtifactPreviewerSpec,
  type CommandSpec,
  type ComposerCompleterSpec,
  type ComposerCompletionSource,
  type MarkdownCodeBlockSpec,
  type PluginSlotContributionSpec,
  type ProfileRuntimeUiSpec,
  type SidebarItemBadgeSpec,
  type SidebarItemSpec,
  type TimelineRendererSpec,
  type ToolViewSpec,
  type UiActionSpec,
  type WorkbenchPanelBadgeSpec,
  type WorkbenchPanelSpec,
} from './ui.js'

/** Single source of truth of UI spec field format regex patterns. */
export const UI_SPEC_PATTERNS = Object.freeze({
  actionIdNoDot: /^[^.]+$/,
  commandActionId: /^[A-Za-z0-9_-]+$/,
  commandSlash: /^[a-z0-9][a-z0-9:_-]{0,63}$/,
  runtimeKind: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  markdownLanguage: /^[a-z0-9][a-z0-9-]{0,31}$/,
  /** Canonical MIME: lowercase `type/subtype` or `type/*` (rejects global wildcard, parameters, globs, uppercase). */
  canonicalMime: /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:[a-z0-9][a-z0-9!#$&^_.+-]*|\*)$/,
  /** Lowercase leading-dot multi-segment extension (e.g. `.md`, `.tar.gz`); rejects path segments/wildcards. */
  artifactExtension: /^\.[a-z0-9]+(?:\.[a-z0-9]+)*$/,
  completerDocName: /^[A-Za-z0-9._-]+$/,
  completerItemsField: /^[A-Za-z0-9_$][A-Za-z0-9_$-]{0,127}$/,
  slotOwnerPluginId: /^[A-Za-z0-9:_-]+$/,
  slotName: /^[A-Za-z0-9._-]+$/,
})

const NonEmptyString = Type.String({ minLength: 1 })
const ActionIdNoDotSchema = Type.String({ minLength: 1, pattern: UI_SPEC_PATTERNS.actionIdNoDot.source })
const CommandActionIdSchema = Type.String({ pattern: UI_SPEC_PATTERNS.commandActionId.source })
const CommandSlashSchema = Type.String({ pattern: UI_SPEC_PATTERNS.commandSlash.source })
const RuntimeKindSchema = Type.String({ pattern: UI_SPEC_PATTERNS.runtimeKind.source })
const MarkdownLanguageSchema = Type.String({ pattern: UI_SPEC_PATTERNS.markdownLanguage.source })
const CanonicalMimeSchema = Type.String({ pattern: UI_SPEC_PATTERNS.canonicalMime.source })
const ArtifactExtensionSchema = Type.String({ pattern: UI_SPEC_PATTERNS.artifactExtension.source })
const CompleterDocNameSchema = Type.String({ pattern: UI_SPEC_PATTERNS.completerDocName.source })
const CompleterItemsFieldSchema = Type.String({ pattern: UI_SPEC_PATTERNS.completerItemsField.source })

const UI_ACTION_BASE_PROPS = {
  actionId: Type.Optional(ActionIdNoDotSchema),
  actionPluginId: Type.Optional(NonEmptyString),
}

const UiActionHeaderSchema = Type.Object({
  ...UI_ACTION_BASE_PROPS,
  placement: Type.Optional(Type.Enum(UI_ACTION_PLACEMENTS)),
  kinds: Type.Optional(Type.Never()),
  roles: Type.Optional(Type.Never()),
})

const UiActionRowSchema = Type.Object({
  ...UI_ACTION_BASE_PROPS,
  placement: Type.Optional(Type.Never()),
  kinds: Type.Optional(Type.Never()),
  roles: Type.Optional(Type.Never()),
})

const UiActionTimelineEntrySchema = Type.Object({
  ...UI_ACTION_BASE_PROPS,
  placement: Type.Optional(Type.Never()),
  kinds: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
  roles: Type.Optional(Type.Array(Type.Enum(UI_ACTION_ROLES), { minItems: 1 })),
})

const CommandPaletteSpecSchema = Type.Object({
  slash: Type.Optional(CommandSlashSchema),
  actionId: Type.Optional(CommandActionIdSchema),
  actionPluginId: Type.Optional(NonEmptyString),
})

const ProfileRuntimeKindSchema = Type.Object({
  kind: RuntimeKindSchema,
})

const ProfileRuntimeSuggestionsSchema = Type.Object({
  agentSuggestions: Type.Optional(Type.Array(NonEmptyString)),
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
  toolNames: Type.Array(NonEmptyString, { minItems: 1 }),
})

const ArtifactPreviewerSpecSchema = Type.Object({
  mimeTypes: Type.Optional(Type.Array(CanonicalMimeSchema, { minItems: 1 })),
  extensions: Type.Optional(Type.Array(ArtifactExtensionSchema, { minItems: 1 })),
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
  uiAction: Object.freeze({
    'conversation:header': UiActionHeaderSchema,
    'conversation:row': UiActionRowSchema,
    'timeline:entry': UiActionTimelineEntrySchema,
  }),
  commandPalette: CommandPaletteSpecSchema,
  profileRuntimeKind: ProfileRuntimeKindSchema,
  profileRuntimeSuggestions: ProfileRuntimeSuggestionsSchema,
  pluginSlot: PluginSlotTargetSchema,
  timelineRenderer: TimelineRendererSpecSchema,
  markdownCodeBlock: MarkdownCodeBlockSpecSchema,
  toolView: ToolViewSpecSchema,
  artifactPreviewer: ArtifactPreviewerSpecSchema,
  composerCompleter: ComposerCompleterSpecSchema,
  workbenchPanel: WorkbenchPanelSpecSchema,
  sidebarItem: SidebarItemSpecSchema,
})

// ---------------------------------------------------------------------------
// Bi-directional compile-time locks against `./ui.ts` interfaces
// ---------------------------------------------------------------------------

type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

const _uiSchemaParityLocks: [
  AssertExact<Static<typeof UiActionHeaderSchema>, Pick<UiActionSpec, 'actionId' | 'actionPluginId' | 'placement'> & { kinds?: never; roles?: never }>,
  AssertExact<Static<typeof UiActionRowSchema>, Pick<UiActionSpec, 'actionId' | 'actionPluginId'> & { placement?: never; kinds?: never; roles?: never }>,
  AssertExact<Static<typeof UiActionTimelineEntrySchema>, Pick<UiActionSpec, 'actionId' | 'actionPluginId' | 'kinds' | 'roles'> & { placement?: never }>,
  AssertExact<Static<typeof CommandPaletteSpecSchema>, Pick<CommandSpec, 'slash' | 'actionId' | 'actionPluginId'>>,
  AssertExact<Static<typeof ProfileRuntimeKindSchema>, Pick<ProfileRuntimeUiSpec, 'kind'>>,
  AssertExact<Static<typeof ProfileRuntimeSuggestionsSchema>, Pick<ProfileRuntimeUiSpec, 'agentSuggestions'>>,
  AssertExact<Static<typeof PluginSlotTargetSchema>, Pick<PluginSlotContributionSpec, 'target'>>,
  AssertExact<Static<typeof TimelineRendererMatchMetaSchema>, NonNullable<TimelineRendererSpec['matchMeta']>>,
  AssertExact<Static<typeof TimelineRendererSpecSchema>, Pick<TimelineRendererSpec, 'matchMeta'>>,
  AssertExact<Static<typeof MarkdownCodeBlockSpecSchema>, Pick<MarkdownCodeBlockSpec, 'languages'>>,
  AssertExact<Static<typeof ToolViewSpecSchema>, Pick<ToolViewSpec, 'replaceRow' | 'toolNames'>>,
  AssertExact<Static<typeof ArtifactPreviewerSpecSchema>, Pick<ArtifactPreviewerSpec, 'mimeTypes' | 'extensions'>>,
  AssertExact<Static<typeof ComposerCompletionSourceSchema>, ComposerCompletionSource>,
  AssertExact<Static<typeof ComposerCompleterSpecSchema>, Pick<ComposerCompleterSpec, 'trigger' | 'source'>>,
  AssertExact<Static<typeof WorkbenchPanelBadgeSchema>, WorkbenchPanelBadgeSpec>,
  AssertExact<Static<typeof WorkbenchPanelSpecSchema>, Pick<WorkbenchPanelSpec, 'badge'>>,
  AssertExact<Static<typeof SidebarItemBadgeSchema>, SidebarItemBadgeSpec>,
  AssertExact<Static<typeof SidebarItemSpecSchema>, Pick<SidebarItemSpec, 'badge'>>,
] = [
  true, true, true, true, true, true, true, true, true,
  true, true, true, true, true, true, true, true, true,
]
void _uiSchemaParityLocks
