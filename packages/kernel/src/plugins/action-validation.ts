/**
 * Focused registration-time validators for `CapabilityRegistry.registerAction`
 * (extracted from `capability-registry.ts` to keep action spec checks modular and shallow).
 */
import {
  CORE_CLI_COMMAND_PATHS,
  HelmxError,
  KERNEL_TOOL_NAMES,
  isCoreNamespace,
  isJsonObject,
  isPlainObject,
  stripBuiltinNamespace,
  type ConversationScope,
  type PluginActionSpec,
  type PluginActionToolSpec,
  type PluginActionVisibility,
  type PluginToolTextBlock,
} from '@helmx/protocol';
import { assertConversationScope, assertValidId } from './shared.js';

export const PROVIDER_SAFE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const VALID_ACTION_VISIBILITIES = new Set<PluginActionVisibility>(['public', 'ui', 'internal']);
const ALLOWED_EXPOSE_AS_TOOL_KEYS = new Set(['name', 'description', 'replay', 'formatOutput']);
export const KERNEL_TOOL_NAME_SET: ReadonlySet<string> = new Set<string>(KERNEL_TOOL_NAMES);
const CORE_CLI_COMMAND_PATH_SET: ReadonlySet<string> = new Set<string>(CORE_CLI_COMMAND_PATHS);
export const CORE_CLI_COMMAND_SEGMENT_LIST: ReadonlyArray<readonly string[]> = CORE_CLI_COMMAND_PATHS.map((p) => p.split(' '));

export interface NormalizedExposeAsTool {
  readonly enabled: boolean;
  readonly explicitToolName?: string;
  readonly toolDescription?: string;
  readonly toolReplay?: 'safe' | 'unsafe';
  readonly formatOutput?: (input: never, output: never) => string | PluginToolTextBlock[];
}

/**
 * Resolves the effective dynamic CLI command path for a plugin action, or `undefined` if hidden,
 * non-public, or kernel-owned.
 */
export function resolveActionCliCommand(
  pluginId: string,
  actionId: string,
  visibility: PluginActionVisibility,
  cli?: PluginActionSpec<unknown, unknown>['cli'],
): readonly string[] | undefined {
  if (isCoreNamespace(pluginId)) return undefined;
  if (visibility !== 'public' || cli?.hidden === true) return undefined;
  if (cli?.command !== undefined) return cli.command;
  return [stripBuiltinNamespace(pluginId), actionId];
}

/** Matches CLI `assertNoConflict` semantics: exact equality or either path being a prefix of the other. */
export function cliPathsConflict(a: readonly string[], b: readonly string[]): boolean {
  const minLen = Math.min(a.length, b.length);
  if (minLen === 0) return false;
  for (let i = 0; i < minLen; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Validates and defensively copies `promptSnippet` / `promptGuidelines` at registration so blank strings
 * cannot pollute prompts and post-registration caller mutations cannot bypass validation.
 */
export function validatedPromptFields(
  what: string,
  fields: { promptSnippet?: unknown; promptGuidelines?: unknown },
  code: 'invalid_tool_spec' | 'invalid_action_spec',
): { promptSnippet?: string; promptGuidelines?: string[] } {
  if (
    fields.promptSnippet !== undefined &&
    (typeof fields.promptSnippet !== 'string' || fields.promptSnippet.trim().length === 0)
  ) {
    throw new HelmxError(code, `${what} promptSnippet must be a non-empty non-whitespace string`, 400);
  }
  const guidelines = fields.promptGuidelines;
  if (
    guidelines !== undefined &&
    (!Array.isArray(guidelines) ||
      guidelines.length === 0 ||
      Array.from(guidelines).some((item) => typeof item !== 'string' || item.trim().length === 0))
  ) {
    throw new HelmxError(code, `${what} promptGuidelines must be a non-empty array of non-whitespace strings`, 400);
  }
  return {
    ...(typeof fields.promptSnippet === 'string' ? { promptSnippet: fields.promptSnippet } : {}),
    ...(Array.isArray(guidelines) ? { promptGuidelines: [...(guidelines as string[])] } : {}),
  };
}

export function cloneScope(scope: ConversationScope): ConversationScope {
  return {
    ...(scope.conversationIds !== undefined ? { conversationIds: [...scope.conversationIds] } : {}),
    ...(scope.tags !== undefined ? { tags: [...scope.tags] } : {}),
    ...(scope.profileIds !== undefined ? { profileIds: [...scope.profileIds] } : {}),
    ...(scope.modelProviders !== undefined ? { modelProviders: [...scope.modelProviders] } : {}),
    ...(scope.ownedBy !== undefined ? { ownedBy: scope.ownedBy } : {}),
    ...(scope.topLevelOnly !== undefined ? { topLevelOnly: scope.topLevelOnly } : {}),
  };
}

export function validateActionBasics<TIn, TOut>(pluginId: string, spec: PluginActionSpec<TIn, TOut>): void {
  assertValidId('action', spec.id);
  if (spec.id.includes('.')) {
    throw new HelmxError(
      'invalid_action_spec',
      `Plugin ${pluginId} action id cannot contain '.' (qualified names split on first '.'): ${spec.id}`,
      400,
    );
  }
  if (typeof spec.description !== 'string' || spec.description.length === 0) {
    throw new HelmxError('invalid_action_spec', `Plugin ${pluginId} action ${spec.id} is missing description`, 400);
  }
  if (!isJsonObject(spec.inputSchema) || !isJsonObject(spec.outputSchema)) {
    throw new HelmxError(
      'invalid_action_spec',
      `Plugin ${pluginId} action ${spec.id} must declare both inputSchema and outputSchema`,
      400,
    );
  }
  if (typeof spec.handler !== 'function') {
    throw new HelmxError('invalid_action_spec', `Plugin ${pluginId} action ${spec.id} is missing handler`, 400);
  }
}

export function validateActionCliConfig<TIn, TOut>(pluginId: string, spec: PluginActionSpec<TIn, TOut>): void {
  if (
    spec.cli?.command !== undefined &&
    (!Array.isArray(spec.cli.command) ||
      spec.cli.command.length === 0 ||
      !spec.cli.command.every((seg) => typeof seg === 'string' && seg.length > 0))
  ) {
    throw new HelmxError(
      'invalid_action_spec',
      `Plugin ${pluginId} action ${spec.id} cli.command must be a non-empty string array`,
      400,
    );
  }
  if (spec.cli?.positional !== undefined) {
    if (!Array.isArray(spec.cli.positional)) {
      throw new HelmxError(
        'invalid_action_spec',
        `Plugin ${pluginId} action ${spec.id} cli.positional must be an array`,
        400,
      );
    }
    const properties =
      spec.inputSchema.type === 'object' && isJsonObject(spec.inputSchema.properties)
        ? (spec.inputSchema.properties as Record<string, unknown>)
        : undefined;
    if (properties === undefined) {
      throw new HelmxError(
        'invalid_action_spec',
        `Plugin ${pluginId} action ${spec.id} declared cli.positional, but inputSchema is not an object with properties`,
        400,
      );
    }
    validateCliPositionals(pluginId, spec.id, spec.cli.positional, properties);
  }
  if (
    spec.cli?.timeoutMs !== undefined &&
    (typeof spec.cli.timeoutMs !== 'number' || !Number.isFinite(spec.cli.timeoutMs) || spec.cli.timeoutMs < 0)
  ) {
    throw new HelmxError(
      'invalid_action_spec',
      `Plugin ${pluginId} action ${spec.id} cli.timeoutMs must be a finite number >= 0 (0 disables timeout)`,
      400,
    );
  }
}

function validateCliPositionals(
  pluginId: string,
  actionId: string,
  positional: readonly unknown[],
  properties: Record<string, unknown>,
): void {
  const writeTargets = new Set<string>();
  let seenOptional = false;
  for (const pos of positional) {
    if (!isPlainObject(pos) || Object.keys(pos).some((k) => k !== 'field' && k !== 'required' && k !== 'readFileInto')) {
      throw new HelmxError(
        'invalid_action_spec',
        `Plugin ${pluginId} action ${actionId} cli.positional entries may only contain { field, required?, readFileInto? }`,
        400,
      );
    }
    if (typeof pos.field !== 'string' || pos.field.length === 0) {
      throw new HelmxError(
        'invalid_action_spec',
        `Plugin ${pluginId} action ${actionId} cli.positional[].field must be a non-empty string`,
        400,
      );
    }
    if (pos.required !== undefined && typeof pos.required !== 'boolean') {
      throw new HelmxError(
        'invalid_action_spec',
        `Plugin ${pluginId} action ${actionId} cli.positional[${pos.field}].required must be a boolean`,
        400,
      );
    }
    if (pos.readFileInto !== undefined && (typeof pos.readFileInto !== 'string' || pos.readFileInto.length === 0)) {
      throw new HelmxError(
        'invalid_action_spec',
        `Plugin ${pluginId} action ${actionId} cli.positional[${pos.field}].readFileInto must be a non-empty field name`,
        400,
      );
    }
    for (const name of [pos.field, pos.readFileInto] as const) {
      if (name === undefined) continue;
      if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
        throw new HelmxError(
          'invalid_action_spec',
          `Plugin ${pluginId} action ${actionId} cli.positional field name "${name}" is forbidden (prototype key)`,
          400,
        );
      }
      if (writeTargets.has(name)) {
        throw new HelmxError(
          'invalid_action_spec',
          `Plugin ${pluginId} action ${actionId} cli.positional duplicates write target "${name}" (field and readFileInto must not overlap)`,
          400,
        );
      }
      writeTargets.add(name);
      if (!Object.hasOwn(properties, name)) {
        throw new HelmxError(
          'invalid_action_spec',
          `Plugin ${pluginId} action ${actionId} cli.positional field "${name}" is not in inputSchema.properties`,
          400,
        );
      }
    }
    if (pos.readFileInto !== undefined) {
      const target = properties[pos.readFileInto] as { type?: unknown } | undefined;
      if (target === null || typeof target !== 'object' || target.type !== 'string') {
        throw new HelmxError(
          'invalid_action_spec',
          `Plugin ${pluginId} action ${actionId} cli.positional "${pos.field}" readFileInto target "${pos.readFileInto}" must have type: string`,
          400,
        );
      }
    }
    if (pos.required === true) {
      if (seenOptional) {
        throw new HelmxError(
          'invalid_action_spec',
          `Plugin ${pluginId} action ${actionId} cli.positional required field "${pos.field}" appears after an optional positional (required fields must be contiguous)`,
          400,
        );
      }
    } else {
      seenOptional = true;
    }
  }
}

export function parseExposeAsToolSpec<TIn, TOut>(
  pluginId: string,
  spec: PluginActionSpec<TIn, TOut>,
): NormalizedExposeAsTool {
  if (spec.exposeAsTool === undefined || spec.exposeAsTool === false) {
    return { enabled: false };
  }
  if (spec.exposeAsTool === true) {
    return { enabled: true };
  }
  if (!isPlainObject(spec.exposeAsTool)) {
    throw new HelmxError(
      'invalid_action_spec',
      `Plugin ${pluginId} action ${spec.id} exposeAsTool must be a boolean or plain options object`,
      400,
    );
  }
  const toolCfg = spec.exposeAsTool as PluginActionToolSpec<TIn, TOut> & Record<string, unknown>;
  for (const key of Object.keys(toolCfg)) {
    if (!ALLOWED_EXPOSE_AS_TOOL_KEYS.has(key)) {
      throw new HelmxError(
        'invalid_action_spec',
        `Plugin ${pluginId} action ${spec.id} exposeAsTool contains unsupported key "${key}" (allowed: name, description, replay, formatOutput)`,
        400,
      );
    }
  }
  let explicitToolName: string | undefined;
  if (toolCfg.name !== undefined) {
    if (typeof toolCfg.name !== 'string') {
      throw new HelmxError('invalid_action_spec', `Plugin ${pluginId} action ${spec.id} exposeAsTool.name must be a string`, 400);
    }
    assertValidId('tool', toolCfg.name);
    if (!PROVIDER_SAFE_TOOL_NAME.test(toolCfg.name)) {
      throw new HelmxError(
        'invalid_action_spec',
        `Plugin ${pluginId} action ${spec.id} exposeAsTool.name "${toolCfg.name}" must match ${PROVIDER_SAFE_TOOL_NAME.source} (provider function naming constraint)`,
        400,
      );
    }
    explicitToolName = toolCfg.name;
  }
  if (toolCfg.description !== undefined && (typeof toolCfg.description !== 'string' || toolCfg.description.trim().length === 0)) {
    throw new HelmxError(
      'invalid_action_spec',
      `Plugin ${pluginId} action ${spec.id} exposeAsTool.description must be a non-empty non-whitespace string`,
      400,
    );
  }
  if (toolCfg.replay !== undefined && toolCfg.replay !== 'safe' && toolCfg.replay !== 'unsafe') {
    throw new HelmxError(
      'invalid_action_spec',
      `Plugin ${pluginId} action ${spec.id} exposeAsTool.replay must be 'safe' | 'unsafe' (received ${String(toolCfg.replay)})`,
      400,
    );
  }
  if (toolCfg.formatOutput !== undefined && typeof toolCfg.formatOutput !== 'function') {
    throw new HelmxError('invalid_action_spec', `Plugin ${pluginId} action ${spec.id} exposeAsTool.formatOutput must be a function`, 400);
  }
  return {
    enabled: true,
    ...(explicitToolName !== undefined ? { explicitToolName } : {}),
    ...(toolCfg.description !== undefined ? { toolDescription: toolCfg.description } : {}),
    ...(toolCfg.replay !== undefined ? { toolReplay: toolCfg.replay } : {}),
    ...(toolCfg.formatOutput !== undefined
      ? { formatOutput: toolCfg.formatOutput as (input: never, output: never) => string | PluginToolTextBlock[] }
      : {}),
  };
}

export function validateActionVisibilityAndMeta<TIn, TOut>(
  pluginId: string,
  spec: PluginActionSpec<TIn, TOut>,
  exposeAsToolEnabled: boolean,
): { visibility: PluginActionVisibility; prompt: { promptSnippet?: string; promptGuidelines?: string[] } } {
  assertConversationScope(pluginId, `Plugin ${pluginId} action ${spec.id}`, spec.scope);
  if (
    spec.visibility !== undefined &&
    (typeof spec.visibility !== 'string' || !VALID_ACTION_VISIBILITIES.has(spec.visibility))
  ) {
    throw new HelmxError(
      'invalid_action_spec',
      `Plugin ${pluginId} action ${spec.id} visibility must be 'public' | 'ui' | 'internal'`,
      400,
    );
  }
  const visibility: PluginActionVisibility = spec.visibility ?? 'public';
  if (spec.exposeToPrompt !== undefined && typeof spec.exposeToPrompt !== 'boolean') {
    throw new HelmxError('invalid_action_spec', `Plugin ${pluginId} action ${spec.id} exposeToPrompt must be a boolean`, 400);
  }
  if (visibility !== 'public') {
    if (exposeAsToolEnabled) {
      throw new HelmxError(
        'invalid_action_spec',
        `Plugin ${pluginId} action ${spec.id} with visibility '${visibility}' cannot enable exposeAsTool`,
        400,
      );
    }
    if (spec.exposeToPrompt === true) {
      throw new HelmxError(
        'invalid_action_spec',
        `Plugin ${pluginId} action ${spec.id} with visibility '${visibility}' cannot set exposeToPrompt: true`,
        400,
      );
    }
    if (
      spec.cli !== undefined &&
      (spec.cli.hidden === false || spec.cli.command !== undefined || spec.cli.positional !== undefined)
    ) {
      throw new HelmxError(
        'invalid_action_spec',
        `Plugin ${pluginId} action ${spec.id} with visibility '${visibility}' cannot expose CLI command/positional options`,
        400,
      );
    }
  }
  if (spec.idempotent !== undefined && typeof spec.idempotent !== 'boolean') {
    throw new HelmxError('validation_error', `Plugin ${pluginId} action ${spec.id} idempotent must be a boolean`, 400);
  }
  if (!exposeAsToolEnabled && (spec.presentationMetaSchema !== undefined || spec.projectPresentationMeta !== undefined)) {
    throw new HelmxError(
      'invalid_action_spec',
      `Plugin ${pluginId} action ${spec.id} may only declare presentationMetaSchema/projectPresentationMeta when exposeAsTool is enabled`,
      400,
    );
  }
  if (spec.presentationMetaSchema !== undefined && !isJsonObject(spec.presentationMetaSchema)) {
    throw new HelmxError(
      'invalid_action_spec',
      `Plugin ${pluginId} action ${spec.id} presentationMetaSchema must be a JSON Schema object`,
      400,
    );
  }
  if (spec.projectPresentationMeta !== undefined) {
    if (typeof spec.projectPresentationMeta !== 'function') {
      throw new HelmxError(
        'invalid_action_spec',
        `Plugin ${pluginId} action ${spec.id} projectPresentationMeta must be a function`,
        400,
      );
    }
    if (spec.presentationMetaSchema === undefined) {
      throw new HelmxError(
        'invalid_action_spec',
        `Plugin ${pluginId} action ${spec.id} projectPresentationMeta requires presentationMetaSchema`,
        400,
      );
    }
  }
  const prompt = validatedPromptFields(`Plugin ${pluginId} action ${spec.id}`, spec, 'invalid_action_spec');
  return { visibility, prompt };
}

export function validateCoreNamespaceAction<TIn, TOut>(
  pluginId: string,
  spec: PluginActionSpec<TIn, TOut>,
  visibility: PluginActionVisibility,
  exposeAsToolEnabled: boolean,
): void {
  if (!isCoreNamespace(pluginId)) return;
  if (exposeAsToolEnabled) {
    throw new HelmxError(
      'invalid_action_spec',
      `Core action ${pluginId}.${spec.id} cannot enable exposeAsTool (kernel tools are registered via RuntimeToolRegistry)`,
      400,
      { pluginId, actionId: spec.id },
    );
  }
  if (spec.cli?.command !== undefined) {
    const joined = spec.cli.command.join(' ');
    if (!CORE_CLI_COMMAND_PATH_SET.has(joined)) {
      throw new HelmxError(
        'invalid_action_spec',
        `Core action ${pluginId}.${spec.id} cli.command "helmx ${joined}" must match a static command in CORE_CLI_COMMAND_PATHS`,
        400,
        { pluginId, actionId: spec.id, command: [...spec.cli.command] },
      );
    }
  } else if (visibility === 'public' && spec.cli?.hidden !== true) {
    throw new HelmxError(
      'invalid_action_spec',
      `Core action ${pluginId}.${spec.id} must declare cli.command pointing to a static CORE_CLI_COMMAND_PATHS entry or set cli.hidden: true`,
      400,
      { pluginId, actionId: spec.id },
    );
  }
}

export function assertNoIntraPluginActionConflicts(
  pluginId: string,
  specId: string,
  exposeAsToolEnabled: boolean,
  resolvedToolName: string,
  cliCommand: readonly string[] | undefined,
  existingTools: ReadonlyMap<string, unknown> | undefined,
  existingActions: ReadonlyMap<string, {
    id: string;
    exposeAsTool: boolean;
    toolAlias: string;
    visibility: PluginActionVisibility;
    cli?: PluginActionSpec<unknown, unknown>['cli'];
  }>,
): void {
  if (exposeAsToolEnabled) {
    if (KERNEL_TOOL_NAME_SET.has(resolvedToolName)) {
      throw new HelmxError(
        'duplicate_tool_name',
        `Plugin ${pluginId} action ${specId} tool name "${resolvedToolName}" conflicts with built-in kernel tool "${resolvedToolName}"`,
        409,
        { pluginId, actionId: specId, toolName: resolvedToolName, owner: 'kernel' },
      );
    }
    if (existingTools?.has(resolvedToolName)) {
      throw new HelmxError(
        'duplicate_tool_name',
        `Plugin ${pluginId} action ${specId} tool name "${resolvedToolName}" conflicts with existing tool "${resolvedToolName}"`,
        409,
        { pluginId, actionId: specId, toolName: resolvedToolName },
      );
    }
    for (const existing of existingActions.values()) {
      if (existing.exposeAsTool && existing.toolAlias === resolvedToolName) {
        throw new HelmxError(
          'duplicate_tool_name',
          `Plugin ${pluginId} action ${specId} tool name "${resolvedToolName}" conflicts with exposeAsTool action ${pluginId}.${existing.id}`,
          409,
          { pluginId, actionId: specId, toolName: resolvedToolName, conflictingActionId: existing.id },
        );
      }
    }
  }
  if (cliCommand === undefined) return;
  for (const corePath of CORE_CLI_COMMAND_SEGMENT_LIST) {
    if (cliPathsConflict(corePath, cliCommand)) {
      throw new HelmxError(
        'duplicate_cli_command',
        `Plugin ${pluginId} action ${specId} CLI command "helmx ${cliCommand.join(' ')}" conflicts with core CLI command "helmx ${corePath.join(' ')}"`,
        409,
        {
          pluginId,
          actionId: specId,
          command: [...cliCommand],
          conflictingCommand: [...corePath],
          owner: 'core',
        },
      );
    }
  }
  for (const existing of existingActions.values()) {
    const existingCmd = resolveActionCliCommand(pluginId, existing.id, existing.visibility, existing.cli);
    if (existingCmd !== undefined && cliPathsConflict(existingCmd, cliCommand)) {
      throw new HelmxError(
        'duplicate_cli_command',
        `Plugin ${pluginId} action ${specId} CLI command "helmx ${cliCommand.join(' ')}" conflicts with action ${pluginId}.${existing.id} ("helmx ${existingCmd.join(' ')}")`,
        409,
        {
          pluginId,
          actionId: specId,
          command: [...cliCommand],
          conflictingActionId: existing.id,
          conflictingCommand: [...existingCmd],
        },
      );
    }
  }
}
