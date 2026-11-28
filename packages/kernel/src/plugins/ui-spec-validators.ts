/**
 * ui-spec-validators.ts: per-surface `registerUi` validation and two-phase dispatch table.
 *
 * Mechanical shape/type/pattern/unknown-key rules compile directly from `@helmx/protocol`'s
 * single-source `UI_SPEC_SCHEMAS` and `UI_SPEC_PATTERNS` (zero schema duplication with
 * `protocol/src/ui.ts`); cross-field semantics (commandPalette slash reservations/duplicates,
 * slot two-segment split, completer exclusion, and unsafe prototype keys) remain explicit.
 * Two-phase dispatch (`validateUiSpecEarly` before scope/client checks, `validateUiSpecLate`
 * after) preserves original error precedence.
 */
import type { TObject, TProperties } from 'typebox';
import { Compile, type Validator } from 'typebox/compile';
import type { TLocalizedValidationError } from 'typebox/error';
import {
  HelmxError,
  RESERVED_SLASH_COMMANDS,
  SIDEBAR_ITEM_BADGE_FIELDS,
  UI_SPEC_PATTERNS,
  UI_SPEC_SCHEMAS,
  WORKBENCH_PANEL_BADGE_FIELDS,
  isPlainObject,
  parseNonEmptyLocalizedText,
  type PluginUiContribution,
} from '@helmx/protocol';

/** Host-reserved command slash triggers (`skill:` prefix is also reserved). */
const RESERVED_COMMAND_SLASH: ReadonlySet<string> = new Set(RESERVED_SLASH_COMMANDS);

const UNSAFE_TOP_LEVEL_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface UiSpecContext {
  pluginId: string;
  fnName: string;
  surface: string;
  clientRoot?: string;
  hasBuildProvider: boolean;
  siblings: readonly PluginUiContribution[];
}

type UiSpecValidator = (spec: Record<string, unknown>, id: string, ctx: UiSpecContext) => void;

// ---------------------------------------------------------------------------
// Compiled validator helper
// ---------------------------------------------------------------------------

interface DiagnosticError {
  message: string;
  details?: Record<string, unknown>;
}

type DiagnosticResolver = (
  errors: readonly TLocalizedValidationError[],
  spec: Record<string, unknown>,
  id: string,
  ctx: UiSpecContext,
) => DiagnosticError;

function runCompiledUiSchema<T extends TProperties>(
  validator: Validator<TProperties, TObject<T>>,
  spec: Record<string, unknown>,
  id: string,
  ctx: UiSpecContext,
  resolveError: DiagnosticResolver,
): void {
  if (validator.Check(spec)) return;
  const { message, details } = resolveError(validator.Errors(spec), spec, id, ctx);
  throw new HelmxError('invalid_ui_spec', message, 400, details);
}

/** Picks the first matching error path according to an explicit precedence list. */
function findErrorByPathPrefix(
  errors: readonly TLocalizedValidationError[],
  prefixes: readonly string[],
): TLocalizedValidationError | undefined {
  for (const prefix of prefixes) {
    const match = errors.find((e) => e.instancePath === prefix || e.instancePath.startsWith(`${prefix}/`));
    if (match) return match;
  }
  return errors[0];
}

function assertUniqueStrings(
  values: readonly string[],
  pluginId: string,
  message: string,
  details: Record<string, unknown>,
): void {
  if (new Set(values).size !== values.length) {
    throw new HelmxError('invalid_ui_spec', `plugin ${pluginId} ${message}`, 400, details);
  }
}

function validateOptionalDescription(
  spec: Record<string, unknown>,
  id: string,
  ctx: UiSpecContext,
): void {
  const value = spec['description'];
  if (value !== undefined && parseNonEmptyLocalizedText(value) === undefined) {
    throw new HelmxError(
      'invalid_ui_spec',
      `plugin ${ctx.pluginId} ui.${ctx.fnName} description must be display copy (non-empty string or { en, 'zh-CN' } map with non-blank values)`,
      400,
      { pluginId: ctx.pluginId, id, field: 'description' },
    );
  }
}

// ---------------------------------------------------------------------------
// Early phase validators
// ---------------------------------------------------------------------------

const COMMAND_PALETTE_CHECKER = Compile(UI_SPEC_SCHEMAS.commandPalette);

function validateCommandPaletteSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  validateOptionalDescription(spec, id, ctx);
  runCompiledUiSchema(COMMAND_PALETTE_CHECKER, spec, id, ctx, (errors) => {
    const err = findErrorByPathPrefix(errors, [
      '/slash',
      '/actionId',
      '/actionPluginId',
      '/shortcut',
      '/target',
      '/keywords',
    ]);
    if (err?.instancePath.startsWith('/slash')) {
      return {
        message: `plugin ${pluginId} ui.command slash must match /^[a-z0-9][a-z0-9:_-]{0,63}$/ (without leading /)`,
        details: { pluginId, id, slash: String(spec['slash']) },
      };
    }
    if (err?.instancePath.startsWith('/actionId')) {
      return { message: `plugin ${pluginId} ui.command actionId must be a valid action identifier` };
    }
    if (err?.instancePath.startsWith('/shortcut')) {
      return {
        message: `plugin ${pluginId} ui.command shortcut must be a trimmed non-empty string (max 32 chars)`,
        details: { pluginId, id, shortcut: String(spec['shortcut']) },
      };
    }
    if (err?.instancePath.startsWith('/target')) {
      return {
        message: `plugin ${pluginId} ui.command target must be a trimmed non-empty string (max 512 chars)`,
        details: { pluginId, id, target: String(spec['target']) },
      };
    }
    if (err?.instancePath.startsWith('/keywords')) {
      return {
        message: `plugin ${pluginId} ui.command keywords must be an array of non-empty trimmed strings`,
        details: { pluginId, id },
      };
    }
    return { message: `plugin ${pluginId} ui.command actionPluginId must be a non-empty plugin ID`, details: { pluginId, id } };
  });
  const slash = spec['slash'] as string | undefined;
  if (slash !== undefined) {
    if (RESERVED_COMMAND_SLASH.has(slash) || slash.startsWith('skill:')) {
      throw new HelmxError(
        'invalid_ui_spec',
        `plugin ${pluginId} ui.command slash "${slash}" conflicts with a host reserved command (new/clear/compact or skill: prefix)`,
        400,
        { pluginId, id, slash },
      );
    }
    for (const u of ctx.siblings) {
      if (u.surface === 'commandPalette' && (u.spec as { slash?: unknown }).slash === slash) {
        throw new HelmxError('duplicate_command_slash', `plugin ${pluginId} duplicate declaration slash trigger term /${slash}`, 409, {
          pluginId,
          slash,
        });
      }
    }
  }
  const actionId = spec['actionId'];
  if (slash !== undefined && actionId === undefined) {
    throw new HelmxError('invalid_ui_spec', `plugin ${pluginId} ui.command must bind actionId when declaring slash`, 400);
  }
  if (actionId === undefined && spec['client'] === undefined && spec['target'] === undefined) {
    throw new HelmxError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.command must provide at least one of actionId, client, or target (command must be triggerable)`,
      400,
      { pluginId, id },
    );
  }
}

const PLUGIN_SLOT_CHECKER = Compile(UI_SPEC_SCHEMAS.pluginSlot);

function validateSlotSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  runCompiledUiSchema(PLUGIN_SLOT_CHECKER, spec, id, ctx, () => ({
    message: `plugin ${pluginId} ui.slot  target must be non-empty string (<ownerPluginId>/<slotName>)`,
    details: { pluginId, id },
  }));
  const target = spec['target'] as string;
  const slash = target.indexOf('/');
  if (slash <= 0 || slash !== target.lastIndexOf('/')) {
    throw new HelmxError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.slot  target "${target}" must exactly contains a '/'(<ownerPluginId>/<slotName>)`,
      400,
      { pluginId, id, target },
    );
  }
  const owner = target.slice(0, slash);
  const slotName = target.slice(slash + 1);
  if (!UI_SPEC_PATTERNS.slotOwnerPluginId.test(owner) || !UI_SPEC_PATTERNS.slotName.test(slotName)) {
    throw new HelmxError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.slot  target "${target}" segment identifier illegal (ownerPluginId allows : _ -,slotName allows . _ -)`,
      400,
      { pluginId, id, target },
    );
  }
  if (spec['client'] === undefined) {
    throw new HelmxError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.slot must declare client component reference`,
      400,
      { pluginId, id, target },
    );
  }
}

// ---------------------------------------------------------------------------
// Late phase validators
// ---------------------------------------------------------------------------

const TIMELINE_RENDERER_CHECKER = Compile(UI_SPEC_SCHEMAS.timelineRenderer);

function validateTimelineRendererSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  if (spec['matchMeta'] !== undefined && !isPlainObject(spec['matchMeta'])) {
    throw new HelmxError('invalid_ui_spec', `plugin ${pluginId} ui.timelineRenderer  matchMeta only allows { renderer: non-empty string }`, 400);
  }
  runCompiledUiSchema(TIMELINE_RENDERER_CHECKER, spec, id, ctx, () => ({
    message: `plugin ${pluginId} ui.timelineRenderer  matchMeta only allows { renderer: non-empty string }`,
  }));
}

const MARKDOWN_CODE_BLOCK_CHECKER = Compile(UI_SPEC_SCHEMAS.markdownCodeBlock);

function validateMarkdownCodeBlockSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  runCompiledUiSchema(MARKDOWN_CODE_BLOCK_CHECKER, spec, id, ctx, () => ({
    message: `plugin ${pluginId} ui.markdownCodeBlock languages must be a non-empty string array of lowercase language identifiers matching /^[a-z0-9][a-z0-9-]{0,31}$/`,
    details: { pluginId, id },
  }));
  assertUniqueStrings(spec['languages'] as string[], pluginId, 'ui.markdownCodeBlock languages contains duplicate items', {
    pluginId,
    id,
  });
  if (spec['client'] === undefined) {
    throw new HelmxError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.markdownCodeBlock must declare a client component reference`,
      400,
      { pluginId, id },
    );
  }
}

const TOOL_VIEW_CHECKER = Compile(UI_SPEC_SCHEMAS.toolView);

function validateToolViewSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  runCompiledUiSchema(TOOL_VIEW_CHECKER, spec, id, ctx, (errors) => {
    const err = findErrorByPathPrefix(errors, ['/replaceRow', '/foldable', '/toolNames']);
    if (err?.instancePath.startsWith('/replaceRow')) {
      return {
        message: `plugin ${pluginId} ui.toolView  replaceRow must be boolean value (actual:${typeof spec['replaceRow']})`,
        details: { pluginId, id },
      };
    }
    if (err?.instancePath.startsWith('/foldable')) {
      return {
        message: `plugin ${pluginId} ui.toolView foldable must be boolean value (actual:${typeof spec['foldable']})`,
        details: { pluginId, id },
      };
    }
    return { message: `plugin ${pluginId} ui.toolView  toolNames must be non-empty string array`, details: { pluginId, id } };
  });
}

const COMPLETER_TRIGGER_AND_SOURCE_CHECKER = Compile(UI_SPEC_SCHEMAS.composerCompleter);

function validateComposerCompleterSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  if (parseNonEmptyLocalizedText(spec['label']) === undefined) {
    throw new HelmxError('invalid_ui_spec', `plugin ${pluginId} ui.composerCompleter need to non-empty display label`, 400, {
      pluginId,
      id,
    });
  }
  // '/' is reserved for host command and skill completion; completer renders uniformly without client track.
  if (spec['client'] !== undefined) {
    throw new HelmxError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.composerCompleter disallows declaring client (completions render uniformly via host data sources)`,
      400,
      { pluginId, id, field: 'client' },
    );
  }
  runCompiledUiSchema(COMPLETER_TRIGGER_AND_SOURCE_CHECKER, spec, id, ctx, (errors) => {
    const triggerErr = findErrorByPathPrefix(errors, ['/trigger']);
    if (triggerErr?.instancePath.startsWith('/trigger')) {
      return {
        message: `plugin ${pluginId} ui.composerCompleter trigger only allows '@' | '#' | ':' ('/' is reserved for commands and skills)`,
        details: { pluginId, id, trigger: String(spec['trigger']) },
      };
    }
    const source = spec['source'];
    if (!isPlainObject(source)) {
      return {
        message: `plugin ${pluginId} ui.composerCompleter requires source ({ kind: 'action' | 'doc' | 'sessionDoc', ... })`,
        details: { pluginId, id },
      };
    }
    const kind = source['kind'];
    if (kind === 'action') {
      if (Object.keys(source).some((k) => k !== 'kind' && k !== 'actionId' && k !== 'actionPluginId')) {
        return {
          message: `plugin ${pluginId} ui.composerCompleter action source only allows { kind, actionId, actionPluginId? }`,
          details: { pluginId, id },
        };
      }
      if (typeof source['actionId'] !== 'string' || source['actionId'].length === 0 || source['actionId'].includes('.')) {
        return {
          message: `plugin ${pluginId} ui.composerCompleter actionId must be a non-empty action ID without dots (use actionPluginId for cross-plugin actions)`,
          details: { pluginId, id },
        };
      }
      return {
        message: `plugin ${pluginId} ui.composerCompleter actionPluginId must be a non-empty plugin ID`,
        details: { pluginId, id },
      };
    }
    if (kind === 'doc' || kind === 'sessionDoc') {
      if (Object.keys(source).some((k) => k !== 'kind' && k !== 'name' && k !== 'itemsField')) {
        return {
          message: `plugin ${pluginId} ui.composerCompleter ${kind} source only allows { kind, name, itemsField }`,
          details: { pluginId, id },
        };
      }
      if (typeof source['name'] !== 'string' || !UI_SPEC_PATTERNS.completerDocName.test(source['name'])) {
        return {
          message: `plugin ${pluginId} ui.composerCompleter ${kind} source name must be a valid public doc name (A-Za-z0-9._-)`,
          details: { pluginId, id, name: String(source['name']) },
        };
      }
      return {
        message: `plugin ${pluginId} ui.composerCompleter itemsField must be a safe top-level key (rejecting __proto__/constructor/prototype and control characters)`,
        details: { pluginId, id, itemsField: String(source['itemsField']) },
      };
    }
    return {
      message: `plugin ${pluginId} ui.composerCompleter source.kind only allows 'action' | 'doc' | 'sessionDoc'`,
      details: { pluginId, id, kind: String(kind) },
    };
  });
  const source = spec['source'] as Record<string, unknown>;
  if (!isPlainObject(source)) {
    throw new HelmxError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.composerCompleter requires source ({ kind: 'action' | 'doc' | 'sessionDoc', ... })`,
      400,
      { pluginId, id },
    );
  }
  if (
    (source['kind'] === 'doc' || source['kind'] === 'sessionDoc') &&
    UNSAFE_TOP_LEVEL_KEYS.has(source['itemsField'] as string)
  ) {
    throw new HelmxError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.composerCompleter itemsField must be a safe top-level key (rejecting __proto__/constructor/prototype and control characters)`,
      400,
      { pluginId, id, itemsField: String(source['itemsField']) },
    );
  }
}

const WORKBENCH_PANEL_CHECKER = Compile(UI_SPEC_SCHEMAS.workbenchPanel);

function validateWorkbenchPanelSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  if (spec['badge'] !== undefined && !isPlainObject(spec['badge'])) {
    throw new HelmxError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.workbenchPanel  badge only allows { doc, countField?, toneField?, byConversationField? }`,
      400,
    );
  }
  runCompiledUiSchema(WORKBENCH_PANEL_CHECKER, spec, id, ctx, (errors) => {
    const err = findErrorByPathPrefix(
      errors,
      [...WORKBENCH_PANEL_BADGE_FIELDS.map((field) => `/badge/${field}`), '/badge'],
    );
    const p = err?.instancePath ?? '';
    if (p === '/badge/doc') {
      return {
        message: `plugin ${pluginId} ui.workbenchPanel  badge.doc must be non-empty string (subscribe this plugin public doc name)`,
        details: { pluginId, id },
      };
    }
    for (const field of WORKBENCH_PANEL_BADGE_FIELDS) {
      if (field !== 'doc' && p === `/badge/${field}`) {
        return {
          message: `plugin ${pluginId} ui.workbenchPanel  badge.${field} must be non-empty string field name`,
          details: { pluginId, id, field },
        };
      }
    }
    return {
      message: `plugin ${pluginId} ui.workbenchPanel  badge only allows { doc, countField?, toneField?, byConversationField? }`,
    };
  });
}

const SIDEBAR_ITEM_CHECKER = Compile(UI_SPEC_SCHEMAS.sidebarItem);

function validateSidebarItemSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  if (spec['badge'] !== undefined && !isPlainObject(spec['badge'])) {
    throw new HelmxError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.sidebarItem badge must be a plain object { doc, countField, toneField?, dotField?, summaryField? }`,
      400,
      { pluginId, id },
    );
  }
  runCompiledUiSchema(SIDEBAR_ITEM_CHECKER, spec, id, ctx, (errors) => {
    const err = findErrorByPathPrefix(
      errors,
      [...SIDEBAR_ITEM_BADGE_FIELDS.map((field) => `/badge/${field}`), '/badge'],
    );
    const p = err?.instancePath ?? '';
    for (const field of SIDEBAR_ITEM_BADGE_FIELDS) {
      if (p === `/badge/${field}`) {
        return {
          message: `plugin ${pluginId} ui.sidebarItem badge.${field} must be non-empty string field name`,
          details: { pluginId, id, field },
        };
      }
    }
    return {
      message: `plugin ${pluginId} ui.sidebarItem badge only allows { doc, countField, toneField?, dotField?, summaryField? }`,
      details: { pluginId, id },
    };
  });
  // Field names become doc-key reads on the host; unsafe prototype keys must never pass.
  const badge = spec['badge'] as Record<string, unknown> | undefined;
  if (badge !== undefined) {
    for (const field of SIDEBAR_ITEM_BADGE_FIELDS) {
      const value = badge[field];
      if (typeof value === 'string' && UNSAFE_TOP_LEVEL_KEYS.has(value)) {
        throw new HelmxError(
          'invalid_ui_spec',
          `plugin ${pluginId} ui.sidebarItem badge.${field} must be a safe top-level doc key (rejecting __proto__/constructor/prototype)`,
          400,
          { pluginId, id, field, value },
        );
      }
    }
  }
}

const SCREEN_CHECKER = Compile(UI_SPEC_SCHEMAS.screen);

function validateScreenSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  validateOptionalDescription(spec, id, ctx);
  runCompiledUiSchema(SCREEN_CHECKER, spec, id, ctx, () => ({
    message: `plugin ${pluginId} ui.screen keywords must be an array of non-empty trimmed strings`,
    details: { pluginId, id },
  }));
}

const SETTINGS_PANEL_CHECKER = Compile(UI_SPEC_SCHEMAS.settingsPanel);

function validateSettingsPanelSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  validateOptionalDescription(spec, id, ctx);
  runCompiledUiSchema(SETTINGS_PANEL_CHECKER, spec, id, ctx, () => ({
    message: `plugin ${pluginId} ui.settingsPanel keywords must be an array of non-empty trimmed strings`,
    details: { pluginId, id },
  }));
}

// ---------------------------------------------------------------------------
// Two-phase dispatch tables
// ---------------------------------------------------------------------------

const EARLY_VALIDATORS: Readonly<Record<string, UiSpecValidator>> = {
  commandPalette: validateCommandPaletteSpec,
  'plugin.slot': validateSlotSpec,
};

const LATE_VALIDATORS: Readonly<Record<string, UiSpecValidator>> = {
  'sidebar.item': validateSidebarItemSpec,
  screen: validateScreenSpec,
  'settings.panel': validateSettingsPanelSpec,
  'timeline.renderer': validateTimelineRendererSpec,
  'markdown.codeBlock': validateMarkdownCodeBlockSpec,
  'tool.view': validateToolViewSpec,
  'composer.completer': validateComposerCompleterSpec,
  'workbench.panel': validateWorkbenchPanelSpec,
};

export function validateUiSpecEarly(
  surface: string,
  spec: Record<string, unknown>,
  id: string,
  ctx: UiSpecContext,
): void {
  EARLY_VALIDATORS[surface]?.(spec, id, ctx);
}

export function validateUiSpecLate(
  surface: string,
  spec: Record<string, unknown>,
  id: string,
  ctx: UiSpecContext,
): void {
  LATE_VALIDATORS[surface]?.(spec, id, ctx);
}
