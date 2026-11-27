/**
 * ToolRegistry: `ctx.tool` declarations with registration-time validation and lookup.
 *
 * Tool names share one provider-safe namespace with `exposeAsTool` action aliases, so registration
 * receives the sibling actions as a parameter instead of depending on `ActionRegistry`.
 */
import {
  HelmxError,
  isJsonObject,
  type PluginToolSpec,
} from '@helmx/protocol';
import { assertSchemaCompilable } from '../schema.js';
import { assertConversationScope, assertValidId } from '../shared.js';
import {
  KERNEL_TOOL_NAME_SET,
  PROVIDER_SAFE_TOOL_NAME,
  validatedPromptFields,
} from '../action-validation.js';
import { PluginEntryRegistry } from './plugin-entry-registry.js';

export interface ToolEntry {
  pluginId: string;
  spec: PluginToolSpec;
}

/** Registration-relevant projection of a sibling action for tool-name collision checks. */
export interface ActionToolAliasView {
  readonly id: string;
  readonly exposeAsTool: boolean;
  readonly toolAlias: string;
}

/**
 * Registration-time spec validation (name, description, schemas, replay, prompt fields, execute,
 * conversation scope). Returns the validated prompt fields to merge into the stored spec snapshot.
 */
function validateToolSpec<TIn>(pluginId: string, spec: PluginToolSpec<TIn>): { promptSnippet?: string; promptGuidelines?: string[] } {
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
  return prompt;
}

export class ToolRegistry extends PluginEntryRegistry<ToolEntry> {
  /** Validate and store one tool; `siblingActions` keep an `exposeAsTool` alias from being shadowed. */
  register<TIn>(pluginId: string, spec: PluginToolSpec<TIn>, siblingActions: Iterable<ActionToolAliasView>): void {
    const prompt = validateToolSpec(pluginId, spec);
    this.assertToolNameAvailable(pluginId, spec.name, siblingActions);
    assertSchemaCompilable(spec.inputSchema);

    // Save a snapshot copy so caller mutations after registration cannot bypass prompt validation.
    const storedToolSpec: PluginToolSpec<TIn> = { ...spec, ...prompt };
    this.setEntry(pluginId, spec.name, { pluginId, spec: storedToolSpec as PluginToolSpec });
  }

  /** Kernel tool names, the plugin's own tools, and its `exposeAsTool` aliases all reserve a name. */
  private assertToolNameAvailable(pluginId: string, name: string, siblingActions: Iterable<ActionToolAliasView>): void {
    if (KERNEL_TOOL_NAME_SET.has(name)) {
      throw new HelmxError(
        'duplicate_tool_name',
        `Plugin ${pluginId} tool "${name}" conflicts with built-in kernel tool "${name}"`,
        409,
        { pluginId, toolName: name, owner: 'kernel' },
      );
    }
    if (this.entry(pluginId, name) !== undefined) {
      throw new HelmxError(
        'duplicate_tool_name',
        `Plugin ${pluginId} declared duplicate tool "${name}"`,
        409,
        { pluginId, toolName: name },
      );
    }
    for (const action of siblingActions) {
      if (action.exposeAsTool && action.toolAlias === name) {
        throw new HelmxError(
          'duplicate_tool_name',
          `Plugin ${pluginId} tool "${name}" conflicts with exposeAsTool action ${pluginId}.${action.id}`,
          409,
          { pluginId, toolName: name, conflictingActionId: action.id },
        );
      }
    }
  }

  /** Tool names the plugin registered directly (`ctx.tool`), excluding `exposeAsTool` action aliases. */
  names(pluginId: string): string[] {
    return [...this.entriesOf(pluginId).keys()];
  }
}
