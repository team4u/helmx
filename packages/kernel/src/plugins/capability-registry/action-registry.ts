/**
 * ActionRegistry: plugin action declarations (`ctx.action` / `registerCoreAction`) with their
 * registration-time validation, lookup, and manifest projection.
 *
 * An `exposeAsTool` action also occupies the plugin tool namespace through `toolAlias`; the
 * cross-namespace check receives the sibling tool names as a parameter, so this registry never
 * depends on `ToolRegistry` (the facade wires both directions).
 */
import { createHash } from 'node:crypto';
import {
  HelmxError,
  stripBuiltinNamespace,
  type ActionManifest,
  type ConversationScope,
  type JsonSchema,
  type PluginActionContext,
  type PluginActionSpec,
  type PluginActionVisibility,
  type PluginToolTextBlock,
} from '@helmx/protocol';
import { assertSchemaCompilable } from '../schema.js';
import { jsonClone } from '../shared.js';
import {
  assertNoIntraPluginActionConflicts,
  cloneScope,
  type NormalizedExposeAsTool,
  parseExposeAsToolSpec,
  resolveActionCliCommand,
  validateActionBasics,
  validateActionCliConfig,
  validateActionVisibilityAndMeta,
  validateCoreNamespaceAction,
} from '../action-validation.js';
import { PluginEntryRegistry } from './plugin-entry-registry.js';

/** Trusted invocation surface for action visibility enforcement. */
export type ActionInvocationSurface = 'http' | 'run_action' | 'tool' | 'plugin';

/** Host-trusted caller identity (never read from user-supplied `PluginActionContext`). */
export interface ActionCallerIdentity {
  readonly surface: ActionInvocationSurface;
  /** Host-stamped calling plugin ID; ONLY honored when `surface === 'plugin'`. */
  readonly callerPluginId?: string;
}

export interface ActionEntry {
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
 * (e.g. `builtin:mentions`), split at the first `.` rather than the last.
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

/** Registration-time facts about an action that its stored entry is built from. */
interface ValidatedActionSpec {
  readonly visibility: PluginActionVisibility;
  readonly prompt: { promptSnippet?: string; promptGuidelines?: string[] };
  readonly tool: NormalizedExposeAsTool;
  /** Resolved provider-safe tool name (`exposeAsTool.name` or the generated alias). */
  readonly toolName: string;
}

/** Snapshot of the spec plus its validated facts; `cli` is cloned so later caller mutations cannot alter it. */
function toActionEntry<TIn, TOut>(pluginId: string, spec: PluginActionSpec<TIn, TOut>, validated: ValidatedActionSpec): ActionEntry {
  const { visibility, prompt, tool, toolName } = validated;
  return {
    pluginId,
    id: spec.id,
    description: spec.description,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    visibility,
    cli: spec.cli !== undefined ? jsonClone(spec.cli) : undefined,
    exposeAsTool: tool.enabled,
    ...(tool.toolDescription !== undefined ? { toolDescription: tool.toolDescription } : {}),
    ...(tool.toolReplay !== undefined ? { toolReplay: tool.toolReplay } : {}),
    ...(tool.formatOutput !== undefined ? { formatOutput: tool.formatOutput } : {}),
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
    toolAlias: toolName,
    ...(spec.scope !== undefined ? { scope: spec.scope } : {}),
    handler: spec.handler as (input: never, context: PluginActionContext) => unknown,
  };
}

export class ActionRegistry extends PluginEntryRegistry<ActionEntry> {
  /**
   * Validate and store one action. `siblingTools` are the tool names the same plugin already
   * registered (`ctx.tool`), so an `exposeAsTool` alias cannot shadow them.
   */
  register<TIn, TOut>(
    pluginId: string,
    spec: PluginActionSpec<TIn, TOut>,
    siblingTools: ReadonlyMap<string, unknown>,
  ): void {
    validateActionBasics(pluginId, spec);
    validateActionCliConfig(pluginId, spec);
    const tool = parseExposeAsToolSpec(pluginId, spec);
    const { visibility, prompt } = validateActionVisibilityAndMeta(pluginId, spec, tool.enabled);
    validateCoreNamespaceAction(pluginId, spec, visibility, tool.enabled);

    if (this.entry(pluginId, spec.id) !== undefined) {
      throw new HelmxError('duplicate_action', `Plugin ${pluginId} declared duplicate action ${spec.id}`, 409);
    }

    const toolName = tool.explicitToolName ?? actionToolAlias(pluginId, spec.id);
    const cliCommand = resolveActionCliCommand(pluginId, spec.id, visibility, spec.cli);
    assertNoIntraPluginActionConflicts({
      pluginId,
      actionId: spec.id,
      exposeAsToolEnabled: tool.enabled,
      resolvedToolName: toolName,
      cliCommand,
      existingTools: siblingTools,
      existingActions: this.entriesOf(pluginId),
    });

    assertSchemaCompilable(spec.inputSchema);
    assertSchemaCompilable(spec.outputSchema);
    if (spec.presentationMetaSchema !== undefined) {
      assertSchemaCompilable(spec.presentationMetaSchema);
    }

    this.setEntry(pluginId, spec.id, toActionEntry(pluginId, spec, { visibility, prompt, tool, toolName }));
  }

  get(pluginId: string, actionId: string): ActionEntry | undefined {
    return this.entry(pluginId, actionId);
  }

  getActionIds(pluginId: string): string[] {
    return [...this.entriesOf(pluginId).keys()];
  }

  /** Tool aliases of the plugin's `exposeAsTool` actions (registration order). */
  toolAliases(pluginId: string): string[] {
    const aliases: string[] = [];
    for (const action of this.entriesOf(pluginId).values()) {
      if (action.exposeAsTool) aliases.push(action.toolAlias);
    }
    return aliases;
  }

  /**
   * Read-only action binding lookup (used to validate action existence, `idempotent`, and `visibility`
   * flags referenced by UI specs). Returns `undefined` when undeclared without triggering registration side effects.
   */
  getActionBinding(
    pluginId: string,
    actionId: string,
  ): { idempotent: boolean; visibility: PluginActionVisibility } | undefined {
    const entry = this.entry(pluginId, actionId);
    return entry ? { idempotent: entry.idempotent === true, visibility: entry.visibility } : undefined;
  }

  listManifests(activePluginIds: Iterable<string>): ActionManifest[] {
    const out: ActionManifest[] = [];
    for (const pluginId of activePluginIds) {
      for (const entry of this.entriesOf(pluginId).values()) {
        out.push(toManifest(entry));
      }
    }
    return out;
  }

  /** Throw unless `caller` may invoke `entry` per its visibility (`ui` / `internal` restrictions). */
  assertInvocableBy(entry: ActionEntry, caller: ActionCallerIdentity): void {
    assertVisibilityAllows(entry, caller);
  }
}
