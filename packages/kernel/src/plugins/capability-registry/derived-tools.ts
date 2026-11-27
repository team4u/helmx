/**
 * Unified tool namespace projection: the `ctx.tool` registrations and `exposeAsTool` actions of the
 * active plugins become one `DerivedToolSpec[]` (direct tools first, then action aliases, per plugin).
 * Pure functions over both sub-registries; caching of the unscoped list stays with the facade.
 */
import {
  HelmxError,
  matchesConversationScope,
  type ConversationScope,
  type ConversationSummary,
  type JsonSchema,
  type PluginToolTextBlock,
} from '@helmx/protocol';
import { cloneScope } from '../action-validation.js';
import type { ActionEntry, ActionRegistry } from './action-registry.js';
import type { ToolEntry, ToolRegistry } from './tool-registry.js';

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

function fromToolEntry(pluginId: string, { spec }: ToolEntry): DerivedToolSpec {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    ...(spec.structuredOutputSchema !== undefined
      ? { structuredOutputSchema: spec.structuredOutputSchema }
      : {}),
    ...(spec.presentationMetaSchema !== undefined
      ? { presentationMetaSchema: spec.presentationMetaSchema }
      : {}),
    ...(spec.replay !== undefined ? { replay: spec.replay } : {}),
    ...(spec.scope !== undefined ? { scope: cloneScope(spec.scope) } : {}),
    ...(spec.promptSnippet !== undefined ? { promptSnippet: spec.promptSnippet } : {}),
    ...(spec.promptGuidelines !== undefined
      ? { promptGuidelines: [...spec.promptGuidelines] }
      : {}),
    sourcePluginId: pluginId,
    sourceKind: 'tool',
  };
}

function fromActionEntry(pluginId: string, action: ActionEntry): DerivedToolSpec {
  return {
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
  };
}

/** Scope-filtered unified tool list for `activePluginIds`; pass `conversation` to apply `ConversationScope`. */
export function deriveToolSpecs(
  tools: ToolRegistry,
  actions: ActionRegistry,
  activePluginIds: readonly string[],
  conversation: ConversationSummary | undefined,
): DerivedToolSpec[] {
  const out: DerivedToolSpec[] = [];
  for (const pluginId of activePluginIds) {
    for (const tool of tools.entriesOf(pluginId).values()) {
      if (conversation !== undefined && !matchesConversationScope(tool.spec.scope, conversation)) continue;
      out.push(fromToolEntry(pluginId, tool));
    }
    for (const action of actions.entriesOf(pluginId).values()) {
      if (!action.exposeAsTool) continue;
      if (conversation !== undefined && !matchesConversationScope(action.scope, conversation)) continue;
      out.push(fromActionEntry(pluginId, action));
    }
  }
  return out;
}

/** Provider-safe names must be globally unique; a duplicate here is a host defect (uniqueness is enforced at enable time). */
export function assertDerivedToolNamesUnique(tools: ReadonlyArray<DerivedToolSpec>): void {
  const seenNames = new Set<string>();
  const duplicateNames = new Set<string>();
  for (const tool of tools) {
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
}

/** Defensive copy so callers cannot mutate the cached unscoped list through shared `scope` / `promptGuidelines` references. */
export function cloneDerivedToolList(list: ReadonlyArray<DerivedToolSpec>): DerivedToolSpec[] {
  return list.map((spec) => ({
    ...spec,
    ...(spec.scope !== undefined ? { scope: cloneScope(spec.scope) } : {}),
    ...(spec.promptGuidelines !== undefined ? { promptGuidelines: [...spec.promptGuidelines] } : {}),
  }));
}
