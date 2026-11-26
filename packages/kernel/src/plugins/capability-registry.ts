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
  HelmxError,
  matchesConversationScope,
  stripBuiltinNamespace,
  type ActionManifest,
  type ConversationScope,
  type ConversationSummary,
  type JsonSchema,
  type MaybePromise,
  type PluginActionContext,
  type PluginActionSpec,
  type PluginActionVisibility,
  type PluginRouteContext,
  type PluginRouteMethod,
  type PluginRouteSpec,
  type PluginToolContext,
  type PluginToolSpec,
  type PluginToolTextBlock,
  isJsonObject,
} from '@helmx/protocol';
import { assertSchemaCompilable, validatePluginInput, validatePluginOutput } from './schema.js';
import type { PluginTaskTracker } from './tracking.js';
import {
  assertConversationScope,
  assertValidId,
  decodeSegmentStrict,
  jsonClone,
} from './shared.js';
import {
  CORE_CLI_COMMAND_SEGMENT_LIST,
  KERNEL_TOOL_NAME_SET,
  PROVIDER_SAFE_TOOL_NAME,
  assertNoIntraPluginActionConflicts,
  cliPathsConflict,
  cloneScope,
  parseExposeAsToolSpec,
  resolveActionCliCommand,
  validateActionBasics,
  validateActionCliConfig,
  validateActionVisibilityAndMeta,
  validateCoreNamespaceAction,
  validatedPromptFields,
} from './action-validation.js';

export { PROVIDER_SAFE_TOOL_NAME };

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

/**
 * Generates a deterministic provider-safe alias for an `exposeAsTool` action:
 * semantic prefix + short hash of the qualified ID (avoids illegal `:`/`.`, and hash prevents collisions).
 */
export function actionToolAlias(pluginId: string, actionId: string): string {
  const semantic = `${stripBuiltinNamespace(pluginId)}.${actionId}`
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
  private mutationEpoch = 0;
  private cachedUnscopedTools?: {
    epoch: number;
    activeKey: string;
    list: DerivedToolSpec[];
  };

  registerAction<TIn, TOut>(pluginId: string, spec: PluginActionSpec<TIn, TOut>): void {
    validateActionBasics(pluginId, spec);
    validateActionCliConfig(pluginId, spec);
    const toolSpec = parseExposeAsToolSpec(pluginId, spec);
    const { visibility, prompt } = validateActionVisibilityAndMeta(pluginId, spec, toolSpec.enabled);
    validateCoreNamespaceAction(pluginId, spec, visibility, toolSpec.enabled);

    let pluginActions = this.actions.get(pluginId);
    if (!pluginActions) {
      pluginActions = new Map();
      this.actions.set(pluginId, pluginActions);
    }
    if (pluginActions.has(spec.id)) {
      throw new HelmxError('duplicate_action', `Plugin ${pluginId} declared duplicate action ${spec.id}`, 409);
    }

    const resolvedToolName = toolSpec.explicitToolName ?? actionToolAlias(pluginId, spec.id);
    const cliCommand = resolveActionCliCommand(pluginId, spec.id, visibility, spec.cli);
    assertNoIntraPluginActionConflicts({
      pluginId,
      actionId: spec.id,
      exposeAsToolEnabled: toolSpec.enabled,
      resolvedToolName,
      cliCommand,
      existingTools: this.tools.get(pluginId),
      existingActions: pluginActions,
    });

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
      exposeAsTool: toolSpec.enabled,
      ...(toolSpec.toolDescription !== undefined ? { toolDescription: toolSpec.toolDescription } : {}),
      ...(toolSpec.toolReplay !== undefined ? { toolReplay: toolSpec.toolReplay } : {}),
      ...(toolSpec.formatOutput !== undefined ? { formatOutput: toolSpec.formatOutput } : {}),
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
    this.mutationEpoch += 1;
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
    this.mutationEpoch += 1;
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

  private cloneDerivedToolList(list: ReadonlyArray<DerivedToolSpec>): DerivedToolSpec[] {
    return list.map((spec) => ({
      ...spec,
      ...(spec.scope !== undefined ? { scope: cloneScope(spec.scope) } : {}),
      ...(spec.promptGuidelines !== undefined ? { promptGuidelines: [...spec.promptGuidelines] } : {}),
    }));
  }

  listTools(activePluginIds: Iterable<string>, conversation?: ConversationSummary): DerivedToolSpec[] {
    const activeList = Array.isArray(activePluginIds) ? activePluginIds : [...activePluginIds];
    const activeKey = activeList.join('\0');
    if (
      conversation === undefined &&
      this.cachedUnscopedTools !== undefined &&
      this.cachedUnscopedTools.epoch === this.mutationEpoch &&
      this.cachedUnscopedTools.activeKey === activeKey
    ) {
      return this.cloneDerivedToolList(this.cachedUnscopedTools.list);
    }
    const out: DerivedToolSpec[] = [];
    for (const pluginId of activeList) {
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
    const seenNames = new Set<string>();
    const duplicateNames = new Set<string>();
    for (const tool of out) {
      if (seenNames.has(tool.name)) duplicateNames.add(tool.name);
      else seenNames.add(tool.name);
    }
    if (duplicateNames.size > 0) {
      const duplicates = [...duplicateNames];
      throw new HelmxError(
        'duplicate_tool_name',
        `Plugin tool name conflict (provider-safe names must be unique): ${duplicates.join(', ')}`,
        500,
        { duplicates },
      );
    }
    if (conversation === undefined) {
      this.cachedUnscopedTools = {
        epoch: this.mutationEpoch,
        activeKey,
        list: this.cloneDerivedToolList(out),
      };
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
      throw new HelmxError('unknown_action', `Plugin ${pluginId} action ${actionId} is not declared`, 404, { pluginId, actionId });
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
    this.mutationEpoch += 1;
  }

  removePlugin(pluginId: string): void {
    this.actions.delete(pluginId);
    this.tools.delete(pluginId);
    this.routes.delete(pluginId);
    this.mutationEpoch += 1;
  }
}
