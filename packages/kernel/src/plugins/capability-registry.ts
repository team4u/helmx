/**
 * capability-registry.ts: manages registration, lookup, visibility, and execution of plugin tools,
 * actions, and dynamic routes.
 *
 * Responsibilities:
 * - Pre-compile schemas and strictly validate specs at registration (CLI commands/positionals,
 *   provider-safe aliases, relative route namespacing);
 * - Enforce `ConversationScope` visibility filtering and runtime re-validation;
 * - Derive unified tool specs (`DerivedToolSpec` from `ctx.tool` and `exposeAsTool` actions) with global uniqueness;
 * - Preflight (`prepareAction`) and execute (`invokeAction`, `executeTool`) tracked via `PluginTaskTracker`.
 */
import { createHash } from 'node:crypto';
import {
  CORE_CLI_COMMAND_PATHS,
  HelmxError,
  KERNEL_TOOL_NAMES,
  matchesConversationScope,
  type ActionManifest,
  type ConversationScope,
  type ConversationSummary,
  type JsonSchema,
  type MaybePromise,
  type PluginActionContext,
  type PluginActionSpec,
  type PluginActionToolSpec,
  type PluginActionVisibility,
  type PluginRouteContext,
  type PluginRouteMethod,
  type PluginRouteSpec,
  type PluginToolContext,
  type PluginToolSpec,
  type PluginToolTextBlock,
  isJsonObject,
  isPlainObject,
} from '@helmx/protocol';
import { assertSchemaCompilable, validatePluginInput, validatePluginOutput } from './schema.js';
import type { PluginTaskTracker } from './tracking.js';
import {
  assertConversationScope,
  assertValidId,
  decodeSegmentStrict,
  jsonClone,
} from './shared.js'

/** Trusted invocation surface for action visibility enforcement. */
export type ActionInvocationSurface = 'http' | 'run_action' | 'tool' | 'plugin';

/** Host-trusted caller identity (never read from user-supplied `PluginActionContext`). */
export interface ActionCallerIdentity {
  readonly surface: ActionInvocationSurface;
  /** Host-stamped calling plugin ID; ONLY honored when `surface === 'plugin'`. */
  readonly callerPluginId?: string;
}

export interface DerivedToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Structured output schema (forwarded from `ctx.tool.structuredOutputSchema` or `exposeAsTool` action's `outputSchema`). */
  structuredOutputSchema?: JsonSchema;
  /** Bounded UI presentation metadata schema (forwarded from `ctx.tool` or `exposeAsTool` action). */
  presentationMetaSchema?: JsonSchema;
  /** Pure projection function forwarded for `exposeAsTool` actions when declared (never serialized). */
  projectPresentationMeta?: (input: unknown, output: unknown) => Record<string, unknown> | undefined;
  /** Pure model-facing output formatter forwarded for `exposeAsTool` actions when declared (never serialized). */
  formatOutput?: (input: unknown, output: unknown) => string | PluginToolTextBlock[];
  /** Cross-restart tool replay safety (forwarded from `ctx.tool` or `exposeAsTool` action; defaults to 'unsafe'). */
  replay?: 'safe' | 'unsafe';
  /** Conversation scope visibility constraint (forwarded when declared). */
  scope?: ConversationScope;
  /** Full tool usage guidance paragraph (projected only for active tools). */
  promptSnippet?: string;
  /** Concise single-line guidelines (aggregated into shared `prompt.tools.guidelines`). */
  promptGuidelines?: string[];
  sourcePluginId: string;
  sourceKind: 'action' | 'tool';
  /** Fully-qualified `pluginId.actionId` when `sourceKind === 'action'`. */
  qualifiedId?: string;
}

export interface PluginRouteEntry extends Omit<PluginRouteSpec, 'handler'> {
  pluginId: string;
  handler(req: Request, ctx?: PluginRouteContext): MaybePromise<Response>;
}

const VALID_ROUTE_METHODS: ReadonlySet<PluginRouteMethod> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
]);
const ROUTE_PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const UNSAFE_PARAM_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const EMPTY_ROUTE_CONTEXT: PluginRouteContext = Object.freeze({ params: Object.freeze({}) });

interface StoredPluginRoute {
  entry: PluginRouteEntry;
  relativePath: string;
  signature: string;
}

/** Provider-safe tool name constraint (OpenAI function naming subset across providers). */
export const PROVIDER_SAFE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Generates a deterministic provider-safe alias for an `exposeAsTool` action:
 * semantic prefix + short hash of the qualified ID (avoids illegal `:`/`.`, and hash prevents collisions).
 */
export function actionToolAlias(pluginId: string, actionId: string): string {
  const semantic = `${pluginId.replace(/^builtin:/, '')}.${actionId}`
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
  const hash = createHash('sha1').update(`${pluginId}.${actionId}`).digest('hex').slice(0, 8);
  return `${semantic}_${hash}`;
}

/**
 * Parses a qualified `pluginId.actionId` identifier. Since `pluginId` may contain `:`
 * (e.g. `builtin:profile`), split at the first `.` rather than the last.
 */
export function parseQualifiedActionId(qualified: string): { pluginId: string; actionId: string } {
  const dot = qualified.indexOf('.');
  if (dot <= 0 || dot >= qualified.length - 1) {
    throw new HelmxError('invalid_action_id', `Invalid qualified action id: ${qualified} (expected pluginId.actionId)`, 400, {
      qualified,
    });
  }
  return { pluginId: qualified.slice(0, dot), actionId: qualified.slice(dot + 1) };
}

const VALID_ACTION_VISIBILITIES = new Set<PluginActionVisibility>(['public', 'ui', 'internal']);
const ALLOWED_EXPOSE_AS_TOOL_KEYS = new Set(['name', 'description', 'replay', 'formatOutput']);
const KERNEL_TOOL_NAME_SET: ReadonlySet<string> = new Set<string>(KERNEL_TOOL_NAMES);
const CORE_CLI_COMMAND_SEGMENT_LIST: ReadonlyArray<readonly string[]> = CORE_CLI_COMMAND_PATHS.map((p) => p.split(' '));

/** Resolves the effective CLI command path for a CLI-exposed action, or `undefined` if hidden/non-public. */
function resolveActionCliCommand(
  pluginId: string,
  actionId: string,
  visibility: PluginActionVisibility,
  cli?: PluginActionSpec<unknown, unknown>['cli'],
): readonly string[] | undefined {
  if (visibility !== 'public' || cli?.hidden === true) return undefined;
  if (cli?.command !== undefined) return cli.command;
  const prefix = pluginId.startsWith('builtin:') ? pluginId.slice('builtin:'.length) : pluginId;
  return [prefix, actionId];
}

/** Matches CLI `assertNoConflict` semantics: exact equality or either path being a prefix of the other. */
function cliPathsConflict(a: readonly string[], b: readonly string[]): boolean {
  const minLen = Math.min(a.length, b.length);
  if (minLen === 0) return false;
  for (let i = 0; i < minLen; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

interface ActionEntry {
  pluginId: string;
  id: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  visibility: PluginActionVisibility;
  cli?: PluginActionSpec<unknown, unknown>['cli'];
  exposeAsTool: boolean;
  toolDescription?: string;
  toolReplay?: 'safe' | 'unsafe';
  formatOutput?: (input: never, output: never) => string | PluginToolTextBlock[];
  presentationMetaSchema?: JsonSchema;
  projectPresentationMeta?: (input: never, output: never) => Record<string, unknown> | undefined;
  exposeToPrompt?: boolean;
  idempotent?: boolean;
  /** Usage guidance paragraph (projected when reachable via `run_action` or direct tool; defensively copied). */
  promptSnippet?: string;
  promptGuidelines?: string[];
  toolAlias: string;
  scope?: ConversationScope;
  handler: (input: never, context: PluginActionContext) => unknown;
}

interface ToolEntry {
  pluginId: string;
  spec: PluginToolSpec;
}

/**
 * Runtime scope enforcement: bypassed when no scope or no conversation context (human call);
 * otherwise verifies `matchesConversationScope`. Missing conversations fail via `getConversation`.
 */
export function assertScopeAllows(
  pluginId: string,
  what: string,
  scope: ConversationScope | undefined,
  conversationId: number | undefined,
  getConversation: (id: number) => ConversationSummary,
): void {
  if (scope === undefined || conversationId === undefined) return;
  const conversation = getConversation(conversationId);
  if (!matchesConversationScope(scope, conversation)) {
    throw new HelmxError('conversation_scope_violation', `${what} is not allowed on conversation ${conversationId} (outside scope)`, 403, {
      pluginId,
      conversationId,
    });
  }
}

function pluginRoutePrefix(pluginId: string): string {
  return `/api/plugins/${encodeURIComponent(pluginId)}/routes`;
}

/**
 * Validates and defensively copies `promptSnippet` / `promptGuidelines` at registration so blank strings
 * cannot pollute prompts and post-registration caller mutations cannot bypass validation.
 */
function validatedPromptFields(
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

function cloneScope(scope: ConversationScope): ConversationScope {
  return {
    ...(scope.conversationIds !== undefined ? { conversationIds: [...scope.conversationIds] } : {}),
    ...(scope.tags !== undefined ? { tags: [...scope.tags] } : {}),
    ...(scope.profileIds !== undefined ? { profileIds: [...scope.profileIds] } : {}),
    ...(scope.modelProviders !== undefined ? { modelProviders: [...scope.modelProviders] } : {}),
  };
}

function assertVisibilityAllows(entry: ActionEntry, caller: ActionCallerIdentity): void {
  const { visibility } = entry;
  if (visibility === 'public') return;
  if (visibility === 'ui') {
    if (caller.surface === 'http' || caller.surface === 'plugin') return;
    throw new HelmxError(
      'action_visibility_forbidden',
      `Action ${entry.pluginId}.${entry.id} has visibility 'ui' and cannot be invoked from ${caller.surface}`,
      403,
      { pluginId: entry.pluginId, actionId: entry.id, visibility, surface: caller.surface },
    );
  }
  if (
    caller.surface === 'plugin' &&
    typeof caller.callerPluginId === 'string' &&
    caller.callerPluginId.trim().length > 0
  ) {
    return;
  }
  throw new HelmxError(
    'action_visibility_forbidden',
    `Action ${entry.pluginId}.${entry.id} has visibility 'internal' and can only be invoked via ctx.host.invokeAction by a plugin`,
    403,
    { pluginId: entry.pluginId, actionId: entry.id, visibility, surface: caller.surface },
  );
}

function toManifest(entry: ActionEntry): ActionManifest {
  const manifest: ActionManifest = {
    pluginId: entry.pluginId,
    id: entry.id,
    description: entry.description,
    inputSchema: entry.inputSchema,
    outputSchema: entry.outputSchema,
    visibility: entry.visibility,
    exposeAsTool: entry.exposeAsTool,
    ...(entry.exposeAsTool ? { toolName: entry.toolAlias } : {}),
    ...(entry.presentationMetaSchema !== undefined ? { presentationMetaSchema: entry.presentationMetaSchema } : {}),
    ...(entry.exposeToPrompt !== undefined ? { exposeToPrompt: entry.exposeToPrompt } : {}),
    ...(entry.scope !== undefined ? { scope: cloneScope(entry.scope) } : {}),
    ...(entry.idempotent !== undefined ? { idempotent: entry.idempotent } : {}),
    ...(entry.promptSnippet !== undefined ? { promptSnippet: entry.promptSnippet } : {}),
    ...(entry.promptGuidelines !== undefined
      ? { promptGuidelines: [...entry.promptGuidelines] }
      : {}),
  };
  if (entry.cli) manifest.cli = entry.cli;
  return manifest;
}

export interface CapabilityExecutionOptions {
  assertActive: (pluginId: string) => void;
  getConversation: (id: number) => ConversationSummary;
  tracker: PluginTaskTracker;
  isPluginRegistered: (pluginId: string) => boolean;
  /** Trusted invocation surface and host-stamped callerPluginId (defaults to fail-closed `{ surface: 'http' }`). */
  caller?: ActionCallerIdentity;
}

export class CapabilityRegistry {
  private actions = new Map<string, Map<string, ActionEntry>>();
  private tools = new Map<string, Map<string, ToolEntry>>();
  private routes = new Map<string, StoredPluginRoute[]>();

  registerAction<TIn, TOut>(pluginId: string, spec: PluginActionSpec<TIn, TOut>): void {
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
      const writeTargets = new Set<string>();
      let seenOptional = false;
      for (const pos of spec.cli.positional) {
        if (!isPlainObject(pos) || Object.keys(pos).some((k) => k !== 'field' && k !== 'required' && k !== 'readFileInto')) {
          throw new HelmxError(
            'invalid_action_spec',
            `Plugin ${pluginId} action ${spec.id} cli.positional entries may only contain { field, required?, readFileInto? }`,
            400,
          );
        }
        if (typeof pos.field !== 'string' || pos.field.length === 0) {
          throw new HelmxError(
            'invalid_action_spec',
            `Plugin ${pluginId} action ${spec.id} cli.positional[].field must be a non-empty string`,
            400,
          );
        }
        if (pos.required !== undefined && typeof pos.required !== 'boolean') {
          throw new HelmxError(
            'invalid_action_spec',
            `Plugin ${pluginId} action ${spec.id} cli.positional[${pos.field}].required must be a boolean`,
            400,
          );
        }
        if (pos.readFileInto !== undefined && (typeof pos.readFileInto !== 'string' || pos.readFileInto.length === 0)) {
          throw new HelmxError(
            'invalid_action_spec',
            `Plugin ${pluginId} action ${spec.id} cli.positional[${pos.field}].readFileInto must be a non-empty field name`,
            400,
          );
        }
        for (const name of [pos.field, pos.readFileInto] as const) {
          if (name === undefined) continue;
          if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
            throw new HelmxError(
              'invalid_action_spec',
              `Plugin ${pluginId} action ${spec.id} cli.positional field name "${name}" is forbidden (prototype key)`,
              400,
            );
          }
          if (writeTargets.has(name)) {
            throw new HelmxError(
              'invalid_action_spec',
              `Plugin ${pluginId} action ${spec.id} cli.positional duplicates write target "${name}" (field and readFileInto must not overlap)`,
              400,
            );
          }
          writeTargets.add(name);
          if (!Object.hasOwn(properties, name)) {
            throw new HelmxError(
              'invalid_action_spec',
              `Plugin ${pluginId} action ${spec.id} cli.positional field "${name}" is not in inputSchema.properties`,
              400,
            );
          }
        }
        if (pos.readFileInto !== undefined) {
          const target = properties[pos.readFileInto] as { type?: unknown } | undefined;
          if (target === null || typeof target !== 'object' || target.type !== 'string') {
            throw new HelmxError(
              'invalid_action_spec',
              `Plugin ${pluginId} action ${spec.id} cli.positional "${pos.field}" readFileInto target "${pos.readFileInto}" must have type: string`,
              400,
            );
          }
        }
        if (pos.required === true) {
          if (seenOptional) {
            throw new HelmxError(
              'invalid_action_spec',
              `Plugin ${pluginId} action ${spec.id} cli.positional required field "${pos.field}" appears after an optional positional (required fields must be contiguous)`,
              400,
            );
          }
        } else {
          seenOptional = true;
        }
      }
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

    let exposeAsToolEnabled = false;
    let explicitToolName: string | undefined;
    let toolDescription: string | undefined;
    let toolReplay: 'safe' | 'unsafe' | undefined;
    let formatOutput: ((input: never, output: never) => string | PluginToolTextBlock[]) | undefined;
    if (spec.exposeAsTool === undefined || spec.exposeAsTool === false) {
      exposeAsToolEnabled = false;
    } else if (spec.exposeAsTool === true) {
      exposeAsToolEnabled = true;
    } else if (isPlainObject(spec.exposeAsTool)) {
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
      if (toolCfg.name !== undefined) {
        if (typeof toolCfg.name !== 'string') {
          throw new HelmxError(
            'invalid_action_spec',
            `Plugin ${pluginId} action ${spec.id} exposeAsTool.name must be a string`,
            400,
          );
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
      if (toolCfg.description !== undefined) {
        if (typeof toolCfg.description !== 'string' || toolCfg.description.trim().length === 0) {
          throw new HelmxError(
            'invalid_action_spec',
            `Plugin ${pluginId} action ${spec.id} exposeAsTool.description must be a non-empty non-whitespace string`,
            400,
          );
        }
        toolDescription = toolCfg.description;
      }
      if (toolCfg.replay !== undefined) {
        if (toolCfg.replay !== 'safe' && toolCfg.replay !== 'unsafe') {
          throw new HelmxError(
            'invalid_action_spec',
            `Plugin ${pluginId} action ${spec.id} exposeAsTool.replay must be 'safe' | 'unsafe' (received ${String(toolCfg.replay)})`,
            400,
          );
        }
        toolReplay = toolCfg.replay;
      }
      if (toolCfg.formatOutput !== undefined) {
        if (typeof toolCfg.formatOutput !== 'function') {
          throw new HelmxError(
            'invalid_action_spec',
            `Plugin ${pluginId} action ${spec.id} exposeAsTool.formatOutput must be a function`,
            400,
          );
        }
        formatOutput = toolCfg.formatOutput as (input: never, output: never) => string | PluginToolTextBlock[];
      }
      exposeAsToolEnabled = true;
    } else {
      throw new HelmxError(
        'invalid_action_spec',
        `Plugin ${pluginId} action ${spec.id} exposeAsTool must be a boolean or plain options object`,
        400,
      );
    }

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
    if (
      !exposeAsToolEnabled &&
      (spec.presentationMetaSchema !== undefined || spec.projectPresentationMeta !== undefined)
    ) {
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

    let pluginActions = this.actions.get(pluginId);
    if (!pluginActions) {
      pluginActions = new Map();
      this.actions.set(pluginId, pluginActions);
    }
    if (pluginActions.has(spec.id)) {
      throw new HelmxError('duplicate_action', `Plugin ${pluginId} declared duplicate action ${spec.id}`, 409);
    }

    const resolvedToolName = explicitToolName ?? actionToolAlias(pluginId, spec.id);
    if (exposeAsToolEnabled) {
      if (KERNEL_TOOL_NAME_SET.has(resolvedToolName)) {
        throw new HelmxError(
          'duplicate_tool_name',
          `Plugin ${pluginId} action ${spec.id} tool name "${resolvedToolName}" conflicts with built-in kernel tool "${resolvedToolName}"`,
          409,
          { pluginId, actionId: spec.id, toolName: resolvedToolName, owner: 'kernel' },
        );
      }
      if (this.tools.get(pluginId)?.has(resolvedToolName)) {
        throw new HelmxError(
          'duplicate_tool_name',
          `Plugin ${pluginId} action ${spec.id} tool name "${resolvedToolName}" conflicts with existing tool "${resolvedToolName}"`,
          409,
          { pluginId, actionId: spec.id, toolName: resolvedToolName },
        );
      }
      for (const existing of pluginActions.values()) {
        if (existing.exposeAsTool && existing.toolAlias === resolvedToolName) {
          throw new HelmxError(
            'duplicate_tool_name',
            `Plugin ${pluginId} action ${spec.id} tool name "${resolvedToolName}" conflicts with exposeAsTool action ${pluginId}.${existing.id}`,
            409,
            { pluginId, actionId: spec.id, toolName: resolvedToolName, conflictingActionId: existing.id },
          );
        }
      }
    }

    const cliCommand = resolveActionCliCommand(pluginId, spec.id, visibility, spec.cli);
    if (cliCommand !== undefined) {
      for (const corePath of CORE_CLI_COMMAND_SEGMENT_LIST) {
        if (cliPathsConflict(corePath, cliCommand)) {
          throw new HelmxError(
            'duplicate_cli_command',
            `Plugin ${pluginId} action ${spec.id} CLI command "helmx ${cliCommand.join(' ')}" conflicts with core CLI command "helmx ${corePath.join(' ')}"`,
            409,
            {
              pluginId,
              actionId: spec.id,
              command: [...cliCommand],
              conflictingCommand: [...corePath],
              owner: 'core',
            },
          );
        }
      }
      for (const existing of pluginActions.values()) {
        const existingCmd = resolveActionCliCommand(pluginId, existing.id, existing.visibility, existing.cli);
        if (existingCmd !== undefined && cliPathsConflict(existingCmd, cliCommand)) {
          throw new HelmxError(
            'duplicate_cli_command',
            `Plugin ${pluginId} action ${spec.id} CLI command "helmx ${cliCommand.join(' ')}" conflicts with action ${pluginId}.${existing.id} ("helmx ${existingCmd.join(' ')}")`,
            409,
            {
              pluginId,
              actionId: spec.id,
              command: [...cliCommand],
              conflictingActionId: existing.id,
              conflictingCommand: [...existingCmd],
            },
          );
        }
      }
    }

    assertSchemaCompilable(spec.inputSchema);
    assertSchemaCompilable(spec.outputSchema);
    if (spec.presentationMetaSchema !== undefined) {
      assertSchemaCompilable(spec.presentationMetaSchema);
    }

    pluginActions.set(spec.id, {
      pluginId,
      id: spec.id,
      description: spec.description,
      inputSchema: spec.inputSchema,
      outputSchema: spec.outputSchema,
      visibility,
      cli: spec.cli !== undefined ? jsonClone(spec.cli) : undefined,
      exposeAsTool: exposeAsToolEnabled,
      ...(toolDescription !== undefined ? { toolDescription } : {}),
      ...(toolReplay !== undefined ? { toolReplay } : {}),
      ...(formatOutput !== undefined ? { formatOutput } : {}),
      ...(spec.presentationMetaSchema !== undefined ? { presentationMetaSchema: spec.presentationMetaSchema } : {}),
      ...(spec.projectPresentationMeta !== undefined
        ? {
            projectPresentationMeta: spec.projectPresentationMeta as (
              input: never,
              output: never,
            ) => Record<string, unknown> | undefined,
          }
        : {}),
      ...(spec.exposeToPrompt !== undefined ? { exposeToPrompt: spec.exposeToPrompt } : {}),
      ...(spec.idempotent !== undefined ? { idempotent: spec.idempotent } : {}),
      ...(prompt.promptSnippet !== undefined ? { promptSnippet: prompt.promptSnippet } : {}),
      ...(prompt.promptGuidelines !== undefined ? { promptGuidelines: prompt.promptGuidelines } : {}),
      toolAlias: resolvedToolName,
      ...(spec.scope !== undefined ? { scope: spec.scope } : {}),
      handler: spec.handler as (input: never, context: PluginActionContext) => unknown,
    });
  }

  registerTool<TIn>(pluginId: string, spec: PluginToolSpec<TIn>): void {
    assertValidId('tool', spec.name);
    if (!PROVIDER_SAFE_TOOL_NAME.test(spec.name)) {
      throw new HelmxError(
        'invalid_tool_spec',
        `Plugin ${pluginId} tool name ${spec.name} must match ${PROVIDER_SAFE_TOOL_NAME.source} (provider function naming constraint)`,
        400,
      );
    }
    if (typeof spec.description !== 'string' || spec.description.length === 0) {
      throw new HelmxError('invalid_tool_spec', `Plugin ${pluginId} tool ${spec.name} is missing description`, 400);
    }
    if (!isJsonObject(spec.inputSchema)) {
      throw new HelmxError('invalid_tool_spec', `Plugin ${pluginId} tool ${spec.name} is missing inputSchema`, 400);
    }
    if (spec.structuredOutputSchema !== undefined) {
      if (!isJsonObject(spec.structuredOutputSchema)) {
        throw new HelmxError(
          'invalid_tool_spec',
          `Plugin ${pluginId} tool ${spec.name} structuredOutputSchema must be a JSON Schema object`,
          400,
        );
      }
      assertSchemaCompilable(spec.structuredOutputSchema);
    }
    if (spec.presentationMetaSchema !== undefined) {
      if (!isJsonObject(spec.presentationMetaSchema)) {
        throw new HelmxError(
          'invalid_tool_spec',
          `Plugin ${pluginId} tool ${spec.name} presentationMetaSchema must be a JSON Schema object`,
          400,
        );
      }
      assertSchemaCompilable(spec.presentationMetaSchema);
    }
    if (spec.replay !== undefined && spec.replay !== 'safe' && spec.replay !== 'unsafe') {
      throw new HelmxError(
        'invalid_tool_spec',
        `Plugin ${pluginId} tool ${spec.name} replay must be 'safe' | 'unsafe' (received ${String(spec.replay)})`,
        400,
      );
    }
    const prompt = validatedPromptFields(`Plugin ${pluginId} tool ${spec.name}`, spec, 'invalid_tool_spec');
    if (typeof spec.execute !== 'function') {
      throw new HelmxError('invalid_tool_spec', `Plugin ${pluginId} tool ${spec.name} is missing execute`, 400);
    }
    assertConversationScope(pluginId, `Plugin ${pluginId} tool ${spec.name}`, spec.scope);

    let pluginTools = this.tools.get(pluginId);
    if (!pluginTools) {
      pluginTools = new Map();
      this.tools.set(pluginId, pluginTools);
    }
    if (KERNEL_TOOL_NAME_SET.has(spec.name)) {
      throw new HelmxError(
        'duplicate_tool_name',
        `Plugin ${pluginId} tool "${spec.name}" conflicts with built-in kernel tool "${spec.name}"`,
        409,
        { pluginId, toolName: spec.name, owner: 'kernel' },
      );
    }
    if (pluginTools.has(spec.name)) {
      throw new HelmxError(
        'duplicate_tool_name',
        `Plugin ${pluginId} declared duplicate tool "${spec.name}"`,
        409,
        { pluginId, toolName: spec.name },
      );
    }
    const existingActions = this.actions.get(pluginId);
    if (existingActions) {
      for (const action of existingActions.values()) {
        if (action.exposeAsTool && action.toolAlias === spec.name) {
          throw new HelmxError(
            'duplicate_tool_name',
            `Plugin ${pluginId} tool "${spec.name}" conflicts with exposeAsTool action ${pluginId}.${action.id}`,
            409,
            { pluginId, toolName: spec.name, conflictingActionId: action.id },
          );
        }
      }
    }
    assertSchemaCompilable(spec.inputSchema);

    // Save a snapshot copy so caller mutations after registration cannot bypass prompt validation.
    const storedToolSpec: PluginToolSpec<TIn> = { ...spec, ...prompt };
    pluginTools.set(spec.name, { pluginId, spec: storedToolSpec as PluginToolSpec });
  }

  registerRoute(pluginId: string, spec: PluginRouteSpec): void {
    if (typeof spec.method !== 'string' || !VALID_ROUTE_METHODS.has(spec.method)) {
      throw new HelmxError(
        'validation_error',
        `Plugin ${pluginId} route method ${String(spec.method)} is unsupported (allowed: ${[...VALID_ROUTE_METHODS].join(', ')})`,
        400,
        { pluginId, method: String(spec.method) },
      );
    }
    if (typeof spec.path !== 'string' || !spec.path.startsWith('/')) {
      throw new HelmxError(
        'invalid_route_path',
        `Plugin ${pluginId} route path must be a relative path starting with '/' (mounted under the plugin namespace): ${String(spec.path)}`,
        400,
      );
    }
    if (spec.path === '/api' || spec.path.startsWith('/api/')) {
      throw new HelmxError(
        'invalid_route_path',
        `Plugin ${pluginId} route ${spec.method} ${spec.path} cannot include the '/api' prefix (declare a relative path; the host handles namespacing)`,
        400,
      );
    }
    if (spec.path === '/') {
      throw new HelmxError('invalid_route_path', `Plugin ${pluginId} route relative path must have at least one segment ('/' alone is disallowed)`, 400);
    }
    if (spec.path.includes('?') || spec.path.includes('#')) {
      throw new HelmxError(
        'invalid_route_path',
        `Plugin ${pluginId} route ${spec.method} ${spec.path} cannot contain a query string or fragment`,
        400,
      );
    }
    const seenParams = new Set<string>();
    const signatureParts: string[] = [];
    for (const seg of spec.path.slice(1).split('/')) {
      if (seg.length === 0) {
        throw new HelmxError(
          'invalid_route_path',
          `Plugin ${pluginId} route ${spec.method} ${spec.path} cannot contain empty path segments ('//' or trailing slash)`,
          400,
        );
      }
      const decoded = decodeSegmentStrict(seg);
      if (decoded === '.' || decoded === '..' || decoded.includes('/')) {
        throw new HelmxError(
          'invalid_route_path',
          `Plugin ${pluginId} route ${spec.method} ${spec.path} cannot contain dot segments ('.' / '..') or encoded slashes`,
          400,
        );
      }
      if (decoded.startsWith(':')) {
        const paramName = decoded.slice(1);
        if (!ROUTE_PARAM_NAME_PATTERN.test(paramName) || UNSAFE_PARAM_NAMES.has(paramName)) {
          throw new HelmxError(
            'validation_error',
            `Plugin ${pluginId} route ${spec.method} ${spec.path} contains invalid path parameter segment '${decoded}'`,
            400,
            { pluginId, method: spec.method, path: spec.path, segment: decoded },
          );
        }
        if (seenParams.has(paramName)) {
          throw new HelmxError(
            'validation_error',
            `Plugin ${pluginId} route ${spec.method} ${spec.path} declares duplicate path parameter ':${paramName}'`,
            400,
            { pluginId, method: spec.method, path: spec.path, param: paramName },
          );
        }
        seenParams.add(paramName);
        signatureParts.push(':');
      } else {
        signatureParts.push(decoded);
      }
    }
    if (typeof spec.handler !== 'function') {
      throw new HelmxError('invalid_route_handler', `Plugin ${pluginId} route ${spec.path} is missing handler`, 400);
    }

    const signature = signatureParts.join('\0');
    let pluginRoutes = this.routes.get(pluginId);
    if (!pluginRoutes) {
      pluginRoutes = [];
      this.routes.set(pluginId, pluginRoutes);
    }
    const conflicting = pluginRoutes.find(
      (existing) => existing.entry.method === spec.method && existing.signature === signature,
    );
    if (conflicting !== undefined) {
      throw new HelmxError(
        'validation_error',
        `Plugin ${pluginId} route ${spec.method} ${spec.path} conflicts with existing route ${conflicting.entry.method} ${conflicting.relativePath}`,
        400,
        {
          pluginId,
          method: spec.method,
          path: spec.path,
          conflictingPath: conflicting.relativePath,
        },
      );
    }
    const rawHandler = spec.handler;
    const wrappedHandler: PluginRouteEntry['handler'] = (req, ctx = EMPTY_ROUTE_CONTEXT) =>
      rawHandler(req, ctx);
    pluginRoutes.push({
      relativePath: spec.path,
      signature,
      entry: {
        ...spec,
        handler: wrappedHandler,
        path: `${pluginRoutePrefix(pluginId)}${spec.path}`,
        pluginId,
      },
    });
  }

  getActionIds(pluginId: string): string[] {
    const list = this.actions.get(pluginId);
    return list ? [...list.keys()] : [];
  }

  getToolNames(pluginId: string): string[] {
    const names: string[] = [];
    const list = this.tools.get(pluginId);
    if (list) names.push(...list.keys());
    const actions = this.actions.get(pluginId);
    if (actions) {
      for (const action of actions.values()) {
        if (action.exposeAsTool) names.push(action.toolAlias);
      }
    }
    return names;
  }

  /**
   * Read-only action binding lookup (used to validate action existence, `idempotent`, and `visibility`
   * flags referenced by UI specs). Returns `undefined` when undeclared without triggering registration side effects.
   */
  getActionBinding(
    pluginId: string,
    actionId: string,
  ): { idempotent: boolean; visibility: PluginActionVisibility } | undefined {
    const entry = this.actions.get(pluginId)?.get(actionId);
    return entry ? { idempotent: entry.idempotent === true, visibility: entry.visibility } : undefined;
  }

  listActions(activePluginIds: Iterable<string>): ActionManifest[] {
    const out: ActionManifest[] = [];
    for (const pluginId of activePluginIds) {
      const pluginActions = this.actions.get(pluginId);
      if (!pluginActions) continue;
      for (const entry of pluginActions.values()) {
        out.push(toManifest(entry));
      }
    }
    return out;
  }

  listTools(activePluginIds: Iterable<string>, conversation?: ConversationSummary): DerivedToolSpec[] {
    const out: DerivedToolSpec[] = [];
    for (const pluginId of activePluginIds) {
      const pluginTools = this.tools.get(pluginId);
      if (pluginTools) {
        for (const tool of pluginTools.values()) {
          if (conversation !== undefined && !matchesConversationScope(tool.spec.scope, conversation)) continue;
          out.push({
            name: tool.spec.name,
            description: tool.spec.description,
            inputSchema: tool.spec.inputSchema,
            ...(tool.spec.structuredOutputSchema !== undefined
              ? { structuredOutputSchema: tool.spec.structuredOutputSchema }
              : {}),
            ...(tool.spec.presentationMetaSchema !== undefined
              ? { presentationMetaSchema: tool.spec.presentationMetaSchema }
              : {}),
            ...(tool.spec.replay !== undefined ? { replay: tool.spec.replay } : {}),
            ...(tool.spec.scope !== undefined ? { scope: cloneScope(tool.spec.scope) } : {}),
            ...(tool.spec.promptSnippet !== undefined ? { promptSnippet: tool.spec.promptSnippet } : {}),
            ...(tool.spec.promptGuidelines !== undefined
              ? { promptGuidelines: [...tool.spec.promptGuidelines] }
              : {}),
            sourcePluginId: pluginId,
            sourceKind: 'tool',
          });
        }
      }
      const pluginActions = this.actions.get(pluginId);
      if (pluginActions) {
        for (const action of pluginActions.values()) {
          if (!action.exposeAsTool) continue;
          if (conversation !== undefined && !matchesConversationScope(action.scope, conversation)) continue;
          out.push({
            name: action.toolAlias,
            description: action.toolDescription ?? action.description,
            inputSchema: action.inputSchema,
            structuredOutputSchema: action.outputSchema,
            ...(action.presentationMetaSchema !== undefined
              ? { presentationMetaSchema: action.presentationMetaSchema }
              : {}),
            ...(action.projectPresentationMeta !== undefined
              ? {
                  projectPresentationMeta: action.projectPresentationMeta as (
                    input: unknown,
                    output: unknown,
                  ) => Record<string, unknown> | undefined,
                }
              : {}),
            ...(action.formatOutput !== undefined
              ? {
                  formatOutput: action.formatOutput as (
                    input: unknown,
                    output: unknown,
                  ) => string | PluginToolTextBlock[],
                }
              : {}),
            ...(action.toolReplay !== undefined ? { replay: action.toolReplay } : {}),
            ...(action.scope !== undefined ? { scope: cloneScope(action.scope) } : {}),
            ...(action.promptSnippet !== undefined ? { promptSnippet: action.promptSnippet } : {}),
            ...(action.promptGuidelines !== undefined
              ? { promptGuidelines: [...action.promptGuidelines] }
              : {}),
            sourcePluginId: pluginId,
            sourceKind: 'action',
            qualifiedId: `${pluginId}.${action.id}`,
          });
        }
      }
    }
    const dups = out.filter((t, i) => out.findIndex((x) => x.name === t.name) !== i);
    if (dups.length > 0) {
      throw new HelmxError(
        'duplicate_tool_name',
        `Plugin tool name conflict (provider-safe names must be unique): ${[...new Set(dups.map((d) => d.name))].join(', ')}`,
        500,
        { duplicates: [...new Set(dups.map((d) => d.name))] },
      );
    }
    return out;
  }

  listRoutes(activePluginIds: Iterable<string>): PluginRouteEntry[] {
    const out: PluginRouteEntry[] = [];
    for (const pluginId of activePluginIds) {
      const pluginRoutes = this.routes.get(pluginId);
      if (!pluginRoutes) continue;
      for (const r of pluginRoutes) out.push({ ...r.entry });
    }
    return out;
  }

  prepareAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context: PluginActionContext,
    options: Pick<CapabilityExecutionOptions, 'assertActive' | 'getConversation' | 'caller'>,
  ): { idempotent: boolean } {
    options.assertActive(pluginId);
    const actions = this.actions.get(pluginId);
    const entry = actions?.get(actionId);
    if (!entry) {
      throw new HelmxError('unknown_action', `Plugin ${pluginId} action ${actionId} is not declared (not declaration)`, 404, { pluginId, actionId });
    }
    const caller: ActionCallerIdentity = options.caller ?? { surface: 'http' };
    assertVisibilityAllows(entry, caller);
    assertScopeAllows(pluginId, `Action ${pluginId}.${actionId}`, entry.scope, context.conversationId, options.getConversation);
    validatePluginInput(pluginId, actionId, entry.inputSchema, input);
    return { idempotent: entry.idempotent === true };
  }

  async invokeAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context: PluginActionContext,
    options: Pick<CapabilityExecutionOptions, 'assertActive' | 'getConversation' | 'tracker' | 'caller'>,
  ): Promise<unknown> {
    this.prepareAction(pluginId, actionId, input, context, options);
    const entry = this.actions.get(pluginId)!.get(actionId)!;
    const caller: ActionCallerIdentity = options.caller ?? { surface: 'http' };
    // Construct a fresh sanitized context: never trust caller-supplied `callerPluginId` or `callId`.
    // `callerPluginId` is stamped exclusively from the host-trusted plugin invocation channel.
    const effectiveContext: PluginActionContext = {
      ...(context.conversationId !== undefined ? { conversationId: context.conversationId } : {}),
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
      ...(caller.surface === 'plugin' &&
      typeof caller.callerPluginId === 'string' &&
      caller.callerPluginId.trim().length > 0
        ? { callerPluginId: caller.callerPluginId }
        : {}),
      ...(caller.surface === 'tool' &&
      typeof context.callId === 'string' &&
      context.callId.trim().length > 0
        ? { callId: context.callId }
        : {}),
    };
    const raw = await options.tracker.withTask(pluginId, `action:${pluginId}.${actionId}`, () =>
      Promise.resolve(entry.handler(input as never, effectiveContext)),
    );
    validatePluginOutput(pluginId, actionId, entry.outputSchema, raw);
    return jsonClone(raw);
  }

  async executeTool(
    name: string,
    input: unknown,
    context: PluginToolContext,
    options: CapabilityExecutionOptions,
  ): Promise<unknown> {
    const found = this.findToolByName(name, options);
    if (!found) throw new HelmxError('unknown_tool', `Tool is not registered: ${name}`, 404, { name });

    const { pluginId, spec } = found;
    options.assertActive(pluginId);
    assertScopeAllows(pluginId, `Tool ${name}`, spec.scope, context.conversationId, options.getConversation);
    validatePluginInput(pluginId, spec.name, spec.inputSchema, input);
    return options.tracker.withTask(pluginId, `tool:${name}`, () =>
      Promise.resolve(spec.execute(input as never, context)),
    );
  }

  private findToolByName(
    name: string,
    options: CapabilityExecutionOptions,
  ): { pluginId: string; spec: PluginToolSpec } | undefined {
    // 1. ctx.tool direct name (provider-safe, without '.')
    for (const [pluginId, pluginTools] of this.tools) {
      if (!options.isPluginRegistered(pluginId)) continue;
      const direct = pluginTools.get(name);
      if (direct) return { pluginId, spec: direct.spec };
    }
    // 2. fully-qualified action name pluginId.actionId (pluginId may contain ':', split on first '.')
    const dot = name.indexOf('.');
    if (dot > 0) {
      const pluginId = name.slice(0, dot);
      const actionId = name.slice(dot + 1);
      if (options.isPluginRegistered(pluginId)) {
        const spec = this.derivedToolSpec(pluginId, actionId, name, 'id', options);
        if (spec) return spec;
      }
    }
    // 3. provider-safe tool name / alias (excludes '.', scans exposeAsTool actions by resolved toolAlias)
    for (const pluginId of this.actions.keys()) {
      if (!options.isPluginRegistered(pluginId)) continue;
      const spec = this.derivedToolSpec(pluginId, name, name, 'alias', options);
      if (spec) return spec;
    }
    return undefined;
  }

  private derivedToolSpec(
    pluginId: string,
    key: string,
    displayName: string,
    matchBy: 'id' | 'alias',
    options: CapabilityExecutionOptions,
  ): { pluginId: string; spec: PluginToolSpec } | undefined {
    const actions = this.actions.get(pluginId);
    if (!actions) return undefined;
    for (const action of actions.values()) {
      const match = action.exposeAsTool && (matchBy === 'id' ? action.id === key : action.toolAlias === key);
      if (!match) continue;
      const actionId = action.id;
      return {
        pluginId,
        spec: {
          name: displayName,
          description: action.toolDescription ?? action.description,
          inputSchema: action.inputSchema,
          structuredOutputSchema: action.outputSchema,
          ...(action.presentationMetaSchema !== undefined
            ? { presentationMetaSchema: action.presentationMetaSchema }
            : {}),
          ...(action.toolReplay !== undefined ? { replay: action.toolReplay } : {}),
          ...(action.scope !== undefined ? { scope: action.scope } : {}),
          execute: (input: unknown, ctx: PluginToolContext) =>
            this.invokeAction(
              pluginId,
              actionId,
              input,
              {
                conversationId: ctx.conversationId,
                ...(ctx.callId !== undefined ? { callId: ctx.callId } : {}),
                signal: ctx.signal,
              },
              { ...options, caller: { surface: 'tool' } },
            ),
        },
      };
    }
    return undefined;
  }

  /**
   * Final cross-plugin uniqueness check across all active enabled plugins (plus pending `pluginId`):
   * - Tool names (`ctx.tool` and `exposeAsTool` resolved names/aliases) must be globally unique
   *   and must not collide with `KERNEL_TOOL_NAMES` (`409 duplicate_tool_name`);
   * - CLI-exposed action command paths must not exact- or prefix-collide with `CORE_CLI_COMMAND_PATHS`
   *   or another active plugin's CLI command (`409 duplicate_cli_command`).
   *
   * Called by `PluginHost` during enable preflight and at the synchronous enable commit point so
   * disabled pre-registrations never occupy global names and conflicting commits roll back cleanly.
   */
  assertCrossPluginUnique(pluginId: string, activePluginIds: Iterable<string>): void {
    const toolOwners = new Map<string, string>();
    const cliOwners: Array<{ pluginId: string; actionId: string; command: readonly string[] }> = [];

    const sweep = (ownerPluginId: string): void => {
      const pluginTools = this.tools.get(ownerPluginId);
      if (pluginTools) {
        for (const toolName of pluginTools.keys()) {
          if (KERNEL_TOOL_NAME_SET.has(toolName)) {
            throw new HelmxError(
              'duplicate_tool_name',
              `Plugin ${ownerPluginId} tool "${toolName}" conflicts with built-in kernel tool "${toolName}"`,
              409,
              { pluginId: ownerPluginId, toolName, owner: 'kernel' },
            );
          }
          const prev = toolOwners.get(toolName);
          if (prev !== undefined) {
            throw new HelmxError(
              'duplicate_tool_name',
              `Plugin ${ownerPluginId} tool "${toolName}" conflicts with plugin ${prev}`,
              409,
              { pluginId: ownerPluginId, toolName, ownerPluginId: prev },
            );
          }
          toolOwners.set(toolName, ownerPluginId);
        }
      }
      const pluginActions = this.actions.get(ownerPluginId);
      if (pluginActions) {
        for (const action of pluginActions.values()) {
          if (action.exposeAsTool) {
            const toolName = action.toolAlias;
            if (KERNEL_TOOL_NAME_SET.has(toolName)) {
              throw new HelmxError(
                'duplicate_tool_name',
                `Plugin ${ownerPluginId} action ${action.id} tool name "${toolName}" conflicts with built-in kernel tool "${toolName}"`,
                409,
                { pluginId: ownerPluginId, actionId: action.id, toolName, owner: 'kernel' },
              );
            }
            const prev = toolOwners.get(toolName);
            if (prev !== undefined) {
              throw new HelmxError(
                'duplicate_tool_name',
                `Plugin ${ownerPluginId} action ${action.id} tool name "${toolName}" conflicts with plugin ${prev}`,
                409,
                { pluginId: ownerPluginId, actionId: action.id, toolName, ownerPluginId: prev },
              );
            }
            toolOwners.set(toolName, ownerPluginId);
          }
          const cliCommand = resolveActionCliCommand(ownerPluginId, action.id, action.visibility, action.cli);
          if (cliCommand !== undefined) {
            for (const corePath of CORE_CLI_COMMAND_SEGMENT_LIST) {
              if (cliPathsConflict(corePath, cliCommand)) {
                throw new HelmxError(
                  'duplicate_cli_command',
                  `Plugin ${ownerPluginId} action ${action.id} CLI command "helmx ${cliCommand.join(' ')}" conflicts with core CLI command "helmx ${corePath.join(' ')}"`,
                  409,
                  {
                    pluginId: ownerPluginId,
                    actionId: action.id,
                    command: [...cliCommand],
                    conflictingCommand: [...corePath],
                    owner: 'core',
                  },
                );
              }
            }
            for (const prev of cliOwners) {
              if (cliPathsConflict(prev.command, cliCommand)) {
                throw new HelmxError(
                  'duplicate_cli_command',
                  `Plugin ${ownerPluginId} action ${action.id} CLI command "helmx ${cliCommand.join(' ')}" conflicts with plugin ${prev.pluginId} action ${prev.actionId} ("helmx ${prev.command.join(' ')}")`,
                  409,
                  {
                    pluginId: ownerPluginId,
                    actionId: action.id,
                    command: [...cliCommand],
                    ownerPluginId: prev.pluginId,
                    conflictingActionId: prev.actionId,
                    conflictingCommand: [...prev.command],
                  },
                );
              }
            }
            cliOwners.push({ pluginId: ownerPluginId, actionId: action.id, command: cliCommand });
          }
        }
      }
    };

    for (const activeId of activePluginIds) {
      if (activeId === pluginId) continue;
      sweep(activeId);
    }
    sweep(pluginId);
  }

  clear(pluginId: string): void {
    this.actions.get(pluginId)?.clear();
    this.tools.get(pluginId)?.clear();
    const r = this.routes.get(pluginId);
    if (r) r.length = 0;
  }

  removePlugin(pluginId: string): void {
    this.actions.delete(pluginId);
    this.tools.delete(pluginId);
    this.routes.delete(pluginId);
  }
}
