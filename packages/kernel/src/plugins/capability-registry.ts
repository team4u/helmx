/**
 * capability-registry.ts (facade): registration, lookup, visibility, and execution of plugin tools,
 * actions, and dynamic routes.
 *
 * Per-kind registries and the cross-registry projections live under `./capability-registry/`
 * (`PluginEntryRegistry` storage mechanism + `ActionRegistry` / `ToolRegistry` / `RouteRegistry`
 * policies). This class only orchestrates across them; registration-time spec validation lives in
 * the registries, invocation-time enforcement (visibility, scope, input/output validation, task
 * tracking via `PluginTaskTracker`) stays here because it spans both registries:
 * - Registration feeds each registry the sibling registry's read-only entries for intra-plugin
 *   conflicts (action alias vs. tool name), and advances `mutationEpoch` on every action / tool mutation
 *   so the unscoped `listTools` cache never serves stale lists;
 * - `listTools` projects the unified tool namespace (`ctx.tool` + `exposeAsTool` actions) with caching;
 * - `executeTool` resolves a name to a direct tool or an `exposeAsTool` action (re-entering `invokeAction`);
 * - `assertCrossPluginUnique` sweeps all active plugins at enable time.
 */
import {
  HelmxError,
  matchesConversationScope,
  type ActionManifest,
  type ConversationScope,
  type ConversationSummary,
  type PluginActionContext,
  type PluginActionSpec,
  type PluginActionVisibility,
  type PluginRouteSpec,
  type PluginToolContext,
  type PluginToolSpec,
} from '@helmx/protocol';
import { validatePluginInput, validatePluginOutput } from './schema.js';
import type { PluginTaskTracker } from './tracking.js';
import { jsonClone } from './shared.js';
import { ActionRegistry, type ActionCallerIdentity } from './capability-registry/action-registry.js';
import { ToolRegistry } from './capability-registry/tool-registry.js';
import { RouteRegistry, type PluginRouteEntry } from './capability-registry/route-registry.js';
import {
  assertDerivedToolNamesUnique,
  cloneDerivedToolList,
  deriveToolSpecs,
  type DerivedToolSpec,
} from './capability-registry/derived-tools.js';
import { assertCrossPluginUnique as assertUniqueAcrossPlugins } from './capability-registry/cross-plugin-uniqueness.js';

export { PROVIDER_SAFE_TOOL_NAME } from './action-validation.js';
export {
  actionToolAlias,
  parseQualifiedActionId,
  type ActionCallerIdentity,
  type ActionInvocationSurface,
} from './capability-registry/action-registry.js';
export type { DerivedToolSpec } from './capability-registry/derived-tools.js';
export type { PluginRouteEntry } from './capability-registry/route-registry.js';

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

export interface CapabilityExecutionOptions {
  assertActive: (pluginId: string) => void;
  getConversation: (id: number) => ConversationSummary;
  tracker: PluginTaskTracker;
  isPluginRegistered: (pluginId: string) => boolean;
  /** Trusted invocation surface and host-stamped callerPluginId (defaults to fail-closed `{ surface: 'http' }`). */
  caller?: ActionCallerIdentity;
}

export class CapabilityRegistry {
  private readonly actions = new ActionRegistry();
  private readonly tools = new ToolRegistry();
  private readonly routes = new RouteRegistry();
  private mutationEpoch = 0;
  private cachedUnscopedTools?: {
    epoch: number;
    activeKey: string;
    list: DerivedToolSpec[];
  };

  registerAction<TIn, TOut>(pluginId: string, spec: PluginActionSpec<TIn, TOut>): void {
    this.actions.register(pluginId, spec, this.tools.entriesOf(pluginId));
    this.mutationEpoch += 1;
  }

  registerTool<TIn>(pluginId: string, spec: PluginToolSpec<TIn>): void {
    this.tools.register(pluginId, spec, this.actions.entriesOf(pluginId).values());
    this.mutationEpoch += 1;
  }

  registerRoute(pluginId: string, spec: PluginRouteSpec): void {
    this.routes.register(pluginId, spec);
  }

  getActionIds(pluginId: string): string[] {
    return this.actions.getActionIds(pluginId);
  }

  /** Direct tool names plus the `exposeAsTool` action aliases of the plugin. */
  getToolNames(pluginId: string): string[] {
    return [...this.tools.names(pluginId), ...this.actions.toolAliases(pluginId)];
  }

  /**
   * Read-only action binding lookup (used to validate action existence, `idempotent`, and `visibility`
   * flags referenced by UI specs). Returns `undefined` when undeclared without triggering registration side effects.
   */
  getActionBinding(
    pluginId: string,
    actionId: string,
  ): { idempotent: boolean; visibility: PluginActionVisibility } | undefined {
    return this.actions.getActionBinding(pluginId, actionId);
  }

  listActions(activePluginIds: Iterable<string>): ActionManifest[] {
    return this.actions.listManifests(activePluginIds);
  }

  /**
   * Unified tool namespace for the active plugins. The conversation-independent list is cached per
   * active-plugin set until the next action / tool mutation; conversation-scoped lists are always derived fresh.
   */
  listTools(activePluginIds: Iterable<string>, conversation?: ConversationSummary): DerivedToolSpec[] {
    const activeList = Array.isArray(activePluginIds) ? activePluginIds : [...activePluginIds];
    const activeKey = activeList.join('\0');
    if (
      conversation === undefined &&
      this.cachedUnscopedTools !== undefined &&
      this.cachedUnscopedTools.epoch === this.mutationEpoch &&
      this.cachedUnscopedTools.activeKey === activeKey
    ) {
      return cloneDerivedToolList(this.cachedUnscopedTools.list);
    }
    const out = deriveToolSpecs(this.tools, this.actions, activeList, conversation);
    assertDerivedToolNamesUnique(out);
    if (conversation === undefined) {
      this.cachedUnscopedTools = {
        epoch: this.mutationEpoch,
        activeKey,
        list: cloneDerivedToolList(out),
      };
    }
    return out;
  }

  listRoutes(activePluginIds: Iterable<string>): PluginRouteEntry[] {
    return this.routes.list(activePluginIds);
  }

  prepareAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context: PluginActionContext,
    options: Pick<CapabilityExecutionOptions, 'assertActive' | 'getConversation' | 'caller'>,
  ): { idempotent: boolean } {
    options.assertActive(pluginId);
    const entry = this.actions.get(pluginId, actionId);
    if (!entry) {
      throw new HelmxError('unknown_action', `Plugin ${pluginId} action ${actionId} is not declared`, 404, { pluginId, actionId });
    }
    const caller: ActionCallerIdentity = options.caller ?? { surface: 'http' };
    this.actions.assertInvocableBy(entry, caller);
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
    const entry = this.actions.get(pluginId, actionId)!;
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

  /** Resolution order: direct tool name, then `pluginId.actionId`, then provider-safe alias across plugins. */
  private findToolByName(
    name: string,
    options: CapabilityExecutionOptions,
  ): { pluginId: string; spec: PluginToolSpec } | undefined {
    // 1. ctx.tool direct name (provider-safe, without '.')
    for (const pluginId of this.tools.pluginIds()) {
      if (!options.isPluginRegistered(pluginId)) continue;
      const direct = this.tools.entry(pluginId, name);
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
    for (const pluginId of this.actions.pluginIds()) {
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
    for (const action of this.actions.entriesOf(pluginId).values()) {
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
   * Final cross-plugin uniqueness check across all active enabled plugins (plus pending `pluginId`);
   * see `./capability-registry/cross-plugin-uniqueness.ts` for the exact rules and sweep order.
   */
  assertCrossPluginUnique(pluginId: string, activePluginIds: Iterable<string>): void {
    assertUniqueAcrossPlugins(this.actions, this.tools, pluginId, activePluginIds);
  }

  clear(pluginId: string): void {
    this.actions.clear(pluginId);
    this.tools.clear(pluginId);
    this.routes.clear(pluginId);
    this.mutationEpoch += 1;
  }

  removePlugin(pluginId: string): void {
    this.actions.removePlugin(pluginId);
    this.tools.removePlugin(pluginId);
    this.routes.removePlugin(pluginId);
    this.mutationEpoch += 1;
  }
}
