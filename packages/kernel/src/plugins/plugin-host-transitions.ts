/**
 * Plugin state transition helpers: registration cleanup, fault isolation/rollback,
 * placeholder registration, UI validation, and summary decoration.
 */
import { join } from 'node:path';
import {
  HelmxError,
  isBuiltinNamespace,
  type HookName,
  type LocalizedText,
  type PluginConfigFieldSchema,
  type PluginDefinition,
  type PluginDiagnosticError,
  type PluginPackageManagerPort,
  type PluginSummary,
} from '@helmx/protocol';
import type { CapabilityRegistry } from './capability-registry.js';
import type { CapabilityServiceRegistry } from './capability-service-registry.js';
import type { PluginDocRegistry } from './doc-registry.js';
import type { HookPipeline } from './hooks.js';
import {
  persistEnabled,
  pluginSummaryOf,
  teardownPlugin,
  toDiagnosticError,
  wrapEnableError,
  wrapRegistrationError,
} from './lifecycle-helpers.js';
import { pluginDataDirName } from './plugin-dir-name.js';
import { toJsonSafeError, type JsonSafeErrorInfo } from './shared.js';
import type { PluginTaskTracker } from './tracking.js';
import type { PluginConfigStore, PluginState } from './types.js';
import type { UiRegistry } from './ui-registry.js';
import { assertUiCompleterActionBindings } from './ui-validation.js';

export interface PluginHostRegistries {
  pipelines: ReadonlyMap<HookName, HookPipeline<HookName>>;
  capabilityRegistry: CapabilityRegistry;
  capabilityServiceRegistry: CapabilityServiceRegistry;
  uiRegistry: UiRegistry;
  docRegistry: PluginDocRegistry;
}

export interface PluginTransitionContext extends PluginHostRegistries {
  plugins: Map<string, PluginState>;
  tracker: PluginTaskTracker;
  configStore?: PluginConfigStore;
  dataDir: string;
  emitPluginChanged: (state: PluginState) => void;
}

export function requirePlugin(
  plugins: ReadonlyMap<string, PluginState>,
  pluginId: string,
): PluginState {
  const state = plugins.get(pluginId);
  if (!state) throw new HelmxError('unknown_plugin', `Unregistered plugin: ${pluginId}`, 404, { pluginId });
  return state;
}

export function removePluginRegistries(
  pluginId: string,
  registries: Pick<PluginHostRegistries, 'capabilityRegistry' | 'capabilityServiceRegistry' | 'uiRegistry' | 'docRegistry'>,
  notifyCapabilities = true,
): void {
  registries.capabilityRegistry.removePlugin(pluginId);
  const affectedCapabilities = registries.capabilityServiceRegistry.removePlugin(pluginId);
  registries.uiRegistry.removePlugin(pluginId);
  registries.docRegistry.removePlugin(pluginId);
  if (notifyCapabilities && affectedCapabilities.length > 0) {
    registries.capabilityServiceRegistry.notifyChanged(affectedCapabilities);
  }
}

export function clearPluginRegistrations(
  state: PluginState,
  registries: PluginHostRegistries,
): void {
  const pluginId = state.definition.id;
  for (const pipeline of registries.pipelines.values()) {
    pipeline.removeByPlugin(pluginId);
  }
  state.hooks.clear();
  state.services.length = 0;
  state.providers.length = 0;
  state.hostReleases.clear();
  removePluginRegistries(pluginId, registries, state.enabled);
}

export async function teardownPluginState(
  state: PluginState,
  opts: { stopServices: boolean },
  registries: PluginHostRegistries,
): Promise<void> {
  await teardownPlugin(state, opts, (s) => clearPluginRegistrations(s, registries));
}

/** Fault isolation rollback for external plugins: cleans up partial registrations/mounts without rethrowing. */
export async function rollbackIsolatedPlugin(
  state: PluginState,
  err: unknown,
  stage: PluginDiagnosticError['stage'],
  ctx: PluginTransitionContext,
): Promise<void> {
  try {
    await teardownPluginState(state, { stopServices: stage === 'enable' }, ctx);
  } catch {
    // Do not mask the original failure during cleanup.
  }
  clearPluginRegistrations(state, ctx);
  state.enabled = false;
  state.epoch += 1;
  state.phase = 'idle';
  state.lastError = toDiagnosticError(err, stage);
  ctx.emitPluginChanged(state);
}

export function purgePluginEntries(
  pluginId: string,
  ctx: Pick<
    PluginTransitionContext,
    'plugins' | 'tracker' | 'capabilityRegistry' | 'capabilityServiceRegistry' | 'uiRegistry' | 'docRegistry'
  >,
): void {
  const existing = ctx.plugins.get(pluginId);
  const wasEnabled = existing?.enabled === true;
  if (existing?.releaseTsRoot !== undefined) {
    const release = existing.releaseTsRoot;
    existing.releaseTsRoot = undefined;
    release();
  }
  ctx.plugins.delete(pluginId);
  ctx.tracker.removePlugin(pluginId);
  removePluginRegistries(pluginId, ctx, wasEnabled);
}

export async function rollbackAndRemovePlugin(
  state: PluginState,
  seq: number,
  err: unknown,
  stopServices: boolean,
  ctx: PluginTransitionContext,
): Promise<never> {
  let rollbackError: JsonSafeErrorInfo | undefined;
  try {
    await teardownPluginState(state, { stopServices }, ctx);
  } catch (rollbackErr) {
    rollbackError = toJsonSafeError(rollbackErr);
  }
  state.enabled = false;
  const pluginId = state.definition.id;
  purgePluginEntries(pluginId, ctx);
  throw wrapRegistrationError(pluginId, seq, err, rollbackError);
}

export async function rollbackEnablePlugin(
  state: PluginState,
  prevConfigSchema: Record<string, PluginConfigFieldSchema> | null,
  err: unknown,
  persistedEnabled: boolean,
  ctx: PluginTransitionContext,
): Promise<never> {
  let rollbackError: JsonSafeErrorInfo | undefined;
  try {
    await teardownPluginState(state, { stopServices: true }, ctx);
  } catch (teardownErr) {
    rollbackError = toJsonSafeError(teardownErr);
  }
  clearPluginRegistrations(state, ctx);
  state.configSchema = prevConfigSchema;
  state.enabled = false;
  state.epoch += 1;
  state.phase = 'idle';
  if (persistedEnabled && ctx.configStore?.setEnabled) {
    try {
      await persistEnabled(ctx.configStore, state, false);
    } catch (persistErr) {
      rollbackError = rollbackError ?? toJsonSafeError(persistErr);
    }
  }
  const pluginId = state.definition.id;
  if (!isBuiltinNamespace(pluginId)) {
    state.lastError = toDiagnosticError(err, 'enable');
    ctx.emitPluginChanged(state);
  }
  throw wrapEnableError(pluginId, err, rollbackError);
}

/**
 * Registers a failed placeholder entry for an external plugin that failed during scan/load
 * (without a valid definition); never overwrites an existing valid plugin.
 */
export function registerFailedPlaceholder(
  spec: {
    id: string;
    name?: LocalizedText;
    description?: LocalizedText;
    version?: string;
    error: PluginDiagnosticError;
  },
  ctx: PluginTransitionContext,
): void {
  const existing = ctx.plugins.get(spec.id);
  if (existing !== undefined && !existing.loadFailed) {
    throw new HelmxError(
      'plugin_already_registered',
      `Plugin ${spec.id} is already registered (conflict with failed placeholder); refusing to overwrite`,
      409,
      { pluginId: spec.id },
    );
  }
  const definition: PluginDefinition = {
    id: spec.id,
    name: spec.name ?? spec.id,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    ...(spec.version !== undefined ? { version: spec.version } : {}),
    definePlugin() {},
  };
  const state: PluginState =
    existing ??
    ({
      definition,
      dependencies: [],
      enabled: false,
      phase: 'idle',
      epoch: 1,
      dataDir: join(ctx.dataDir, 'plugins', pluginDataDirName(spec.id)),
      hooks: new Set(),
      services: [],
      providers: [],
      configSchema: null,
      hostReleases: new Set(),
      stopWindow: false,
    } satisfies PluginState);
  state.definition = definition;
  state.dependencies = [];
  state.enabled = false;
  state.phase = 'idle';
  state.epoch += 1;
  state.loadFailed = true;
  state.lastError = spec.error;
  clearPluginRegistrations(state, ctx);
  ctx.plugins.set(spec.id, state);
  ctx.emitPluginChanged(state);
}

export function validateUiDeclarations(
  pluginId: string,
  crossPlugin: boolean,
  deps: Pick<PluginHostRegistries, 'uiRegistry' | 'capabilityRegistry'> & {
    plugins: Map<string, PluginState>;
  },
): void {
  assertUiCompleterActionBindings(
    pluginId,
    deps.uiRegistry,
    deps.capabilityRegistry,
    deps.plugins,
    crossPlugin,
  );
}

export function summaryWithManagedPackage(
  state: PluginState,
  capabilityRegistry: CapabilityRegistry,
  uiRegistry: UiRegistry,
  packageManager?: Pick<PluginPackageManagerPort, 'getRecord'>,
  publicConfig?: Record<string, unknown>,
): PluginSummary {
  const base = pluginSummaryOf(state, capabilityRegistry, uiRegistry, publicConfig);
  const record = packageManager?.getRecord(base.id);
  if (record === undefined || isBuiltinNamespace(base.id)) return base;
  return {
    ...base,
    managed: {
      source: record.source,
      installId: record.id,
      installedVersion: record.version,
      installedAt: record.updatedAt,
    },
  };
}
