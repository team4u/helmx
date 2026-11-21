/**
 * Read-only, deterministically ordered plugin extension contract projection builder.
 *
 * Reuses the live registries (`CapabilityRegistry`, `UiRegistry`, `PluginDocRegistry`, `PluginState`)
 * with zero second registry, zero provider execution, and strict secret / private-doc / handler isolation.
 */
import {
  PLUGIN_HOOK_NAMES,
  assertPluginManifestProjection,
  compareCodeUnit,
  type PluginDiagnosticError,
  type PluginManifestAction,
  type PluginManifestClientModule,
  type PluginManifestConfigField,
  type PluginManifestProjection,
  type PluginManifestProvider,
  type PluginManifestRoute,
  type PluginManifestRouteMethod,
  type PluginManifestTool,
  type PluginManifestUiItem,
  type PluginStatus,
} from '@helmx/protocol';
import { redactJsonValue } from '../redact.js';
import { actionToolAlias, type CapabilityRegistry } from './capability-registry.js';
import type { PluginDocRegistry } from './doc-registry.js';
import { isPluginStateActive } from './lifecycle-helpers.js';
import { jsonClone } from './shared.js';
import type { PluginState } from './types.js';
import type { UiRegistry } from './ui-registry.js';

export interface BuildManifestProjectionOptions {
  state: PluginState;
  capabilityRegistry: CapabilityRegistry;
  uiRegistry: UiRegistry;
  docRegistry: PluginDocRegistry;
  redactText?: (text: string) => string;
  /**
   * When true, reads current registrations in the registries regardless of `state.enabled` / `state.phase`
   * (used during dry-run registration inspection in `doctor` before teardown clears registries).
   */
  includeCurrentRegistrations?: boolean;
}

/** Strips `undefined` own keys from diagnostic error details so failed-plugin manifests remain JSON-safe. */
function cloneDiagnosticValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => (item === undefined ? null : cloneDiagnosticValue(item, seen)));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = cloneDiagnosticValue(v, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function normalizeDiagnosticError(error: PluginDiagnosticError): PluginDiagnosticError {
  return {
    code: error.code,
    message: error.message,
    stage: error.stage,
    ...(error.details !== undefined
      ? { details: cloneDiagnosticValue(error.details) as Record<string, unknown> }
      : {}),
  };
}

/**
 * Projects a single plugin's current extension contract directly from the host's registries.
 * Never executes providers or action/tool/route handlers, omits secret config defaults, omits private
 * docs and doc values, and validates the final shape through `assertPluginManifestProjection`.
 */
export function buildPluginManifestProjection(
  options: BuildManifestProjectionOptions,
): PluginManifestProjection {
  const { state, capabilityRegistry, uiRegistry, docRegistry, redactText } = options;
  const pluginId = state.definition.id;
  const failed = state.lastError !== undefined;
  const active = isPluginStateActive(state);
  const status: PluginStatus = failed ? 'failed' : active ? 'active' : 'disabled';
  const includeRegistrations = options.includeCurrentRegistrations === true || active;

  const dependencies = [...state.dependencies].sort(compareCodeUnit);
  const hooks = includeRegistrations
    ? PLUGIN_HOOK_NAMES.filter((hookName) => state.hooks.has(hookName))
    : [];

  const actions: PluginManifestAction[] = includeRegistrations
    ? capabilityRegistry
        .listActions([pluginId])
        .map((manifest): PluginManifestAction => ({
          ...jsonClone(manifest),
          ...(manifest.exposeAsTool === true
            ? { toolName: actionToolAlias(pluginId, manifest.id) }
            : {}),
        }))
        .sort((a, b) => compareCodeUnit(a.id, b.id))
    : [];

  // Invoking `listTools([pluginId])` also catches intra-plugin `duplicate_tool_name` collisions
  // between `ctx.tool` declarations and `exposeAsTool` aliases during static inspection.
  const tools: PluginManifestTool[] = includeRegistrations
    ? capabilityRegistry
        .listTools([pluginId])
        .map((spec): PluginManifestTool => ({
          name: spec.name,
          description: spec.description,
          inputSchema: jsonClone(spec.inputSchema),
          ...(spec.structuredOutputSchema !== undefined
            ? { structuredOutputSchema: jsonClone(spec.structuredOutputSchema) }
            : {}),
          ...(spec.presentationMetaSchema !== undefined
            ? { presentationMetaSchema: jsonClone(spec.presentationMetaSchema) }
            : {}),
          ...(spec.replay !== undefined ? { replay: spec.replay } : {}),
          ...(spec.scope !== undefined ? { scope: jsonClone(spec.scope) } : {}),
          ...(spec.promptSnippet !== undefined ? { promptSnippet: spec.promptSnippet } : {}),
          ...(spec.promptGuidelines !== undefined
            ? { promptGuidelines: [...spec.promptGuidelines] }
            : {}),
          sourceKind: spec.sourceKind,
          ...(spec.qualifiedId !== undefined ? { qualifiedId: spec.qualifiedId } : {}),
        }))
        .sort((a, b) => compareCodeUnit(a.name, b.name))
    : [];

  const ui: PluginManifestUiItem[] = includeRegistrations
    ? uiRegistry
        .getUiByPlugin(pluginId)
        .map((contrib): PluginManifestUiItem => {
          const clonedSpec = jsonClone(contrib.spec) as Record<string, unknown>;
          return {
            surface: contrib.surface,
            id: String(clonedSpec['id']),
            spec: clonedSpec,
          };
        })
        .sort((a, b) => compareCodeUnit(a.surface, b.surface) || compareCodeUnit(a.id, b.id))
    : [];

  const routes: PluginManifestRoute[] = includeRegistrations
    ? capabilityRegistry
        .listRoutes([pluginId])
        .map((route): PluginManifestRoute => ({
          method: route.method as PluginManifestRouteMethod,
          path: route.path,
          public: route.public === true,
        }))
        .sort((a, b) => compareCodeUnit(a.path, b.path) || compareCodeUnit(a.method, b.method))
    : [];

  const docs = includeRegistrations ? docRegistry.listPublicDocDescriptors(pluginId) : [];

  const configFields: PluginManifestConfigField[] = Object.entries(state.configSchema ?? {})
    .sort(([a], [b]) => compareCodeUnit(a, b))
    .map(([key, field]): PluginManifestConfigField => {
      const secret = field.secret === true;
      return {
        key,
        type: field.type,
        secret,
        required: field.required === true,
        ...(field.format !== undefined ? { format: field.format } : {}),
        ...(field.label !== undefined ? { label: jsonClone(field.label) } : {}),
        ...(field.description !== undefined ? { description: jsonClone(field.description) } : {}),
        // Never project `default` for secret fields (prevents hardcoded default secret leaks).
        ...(!secret && field.default !== undefined ? { default: field.default } : {}),
        ...(field.minimum !== undefined ? { minimum: field.minimum } : {}),
        ...(field.maximum !== undefined ? { maximum: field.maximum } : {}),
        ...(field.integer !== undefined ? { integer: field.integer } : {}),
      };
    });

  // Read-only provider metadata only; never read `auth` or invoke `getModels` / `stream` / `streamSimple`.
  const providers: PluginManifestProvider[] = includeRegistrations
    ? state.providers
        .map((entry): PluginManifestProvider => ({
          id: entry.provider.id,
          name: entry.provider.name,
        }))
        .sort((a, b) => compareCodeUnit(a.id, b.id))
    : [];

  const services: string[] = includeRegistrations
    ? state.services.map((svc) => svc.id).sort(compareCodeUnit)
    : [];

  const hashes = active ? uiRegistry.getClientHashes(pluginId) : undefined;
  const clientModules: PluginManifestClientModule[] = includeRegistrations
    ? uiRegistry
        .getDeclaredClientModules(pluginId)
        .map((mod): PluginManifestClientModule => ({
          module: mod,
          ...(hashes?.[mod] !== undefined ? { contentHash: hashes[mod] } : {}),
        }))
        .sort((a, b) => compareCodeUnit(a.module, b.module))
    : [];

  const raw: PluginManifestProjection = {
    id: pluginId,
    name: jsonClone(state.definition.name ?? pluginId),
    ...(state.definition.description !== undefined
      ? { description: jsonClone(state.definition.description) }
      : {}),
    ...(state.definition.icon ? { icon: state.definition.icon } : {}),
    ...(state.definition.version !== undefined ? { version: state.definition.version } : {}),
    locked: state.definition.locked === true,
    enabled: state.enabled,
    status,
    ...(failed && state.lastError !== undefined
      ? { error: normalizeDiagnosticError(state.lastError) }
      : {}),
    dependencies,
    hooks,
    actions,
    tools,
    ui,
    routes,
    docs,
    configFields,
    providers,
    services,
    clientModules,
  };

  const redacted = redactText !== undefined ? redactJsonValue(raw, redactText) : raw;
  return assertPluginManifestProjection(redacted);
}
