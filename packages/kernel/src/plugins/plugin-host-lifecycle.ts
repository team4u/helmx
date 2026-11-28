/**
 * Plugin registration, unregistration, enable, and disable lifecycle transactions.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  HelmxError,
  type HelmxPluginContext,
  type PluginBuildProvider,
  type PluginDefinition,
  type PluginManifestProjection,
} from '@helmx/protocol';
import { registerPluginTsRoot } from './backend-ts-loader.js';
import { getDefinitionTsRoot } from './external-loader.js';
import {
  getActiveEnabledPluginIds,
  normalizeDependencies,
  persistEnabled,
  resolveInitialEnabled,
  settleLifecycleChanged,
} from './lifecycle-helpers.js';
import { buildPluginManifestProjection } from './manifest-projection.js';
import { pluginDataDirName } from './plugin-dir-name.js';
import { activatePluginServices } from './plugin-host-barrier.js';
import {
  assertDependenciesSatisfied,
  assertNoDependencyCycle,
  assertNoEnabledDependents,
  markDependentsBroken,
} from './plugin-host-deps.js';
import { collectPluginInUse } from './plugin-host-inuse.js';
import {
  clearPluginRegistrations,
  purgePluginEntries,
  requirePlugin,
  rollbackAndRemovePlugin,
  rollbackEnablePlugin,
  rollbackIsolatedPlugin,
  teardownPluginState,
  validateUiDeclarations,
  type PluginTransitionContext,
} from './plugin-host-transitions.js';
import { assertProvidersIdle, registerProviders } from './provider-coordinator.js';
import { assertNoLiveTasks } from './service-coordinator.js';
import type { PluginHostBackend, PluginProviderPort, PluginState } from './types.js';
import type { ClientLifecycleLookup } from './ui-registry.js';

export interface PluginLifecycleContext extends PluginTransitionContext {
  host: PluginHostBackend;
  providers?: PluginProviderPort;
  buildProvider?: PluginBuildProvider;
  servicesStarted: boolean;
  servicesReconciled: boolean;
  redactText?: (text: string) => string;
  createPluginContext: (state: PluginState, epoch: number) => HelmxPluginContext;
  getPluginLifecycle: ClientLifecycleLookup['getPluginLifecycle'];
  ensureTransientSessionDocListener?: (pluginId: string) => void;
  isDisposed: () => boolean;
}

async function precompilePluginClientModules(state: PluginState, ctx: PluginLifecycleContext): Promise<void> {
  await ctx.uiRegistry.precompileClientModules(state.definition.id, {
    getPluginLifecycle: ctx.getPluginLifecycle,
    dataDir: ctx.dataDir,
    isDisposed: ctx.isDisposed,
  });
}

function assertPluginIdle(
  pluginId: string,
  state: PluginState,
  ctx: Pick<PluginLifecycleContext, 'tracker' | 'providers'>,
): void {
  assertNoLiveTasks(pluginId, state, ctx.tracker);
  assertProvidersIdle(pluginId, state, ctx.providers);
}

async function handleRegisterFailure(
  state: PluginState,
  seq: number,
  err: unknown,
  opts: { isolate: boolean; stage: 'define' | 'enable'; stopServices: boolean },
  ctx: PluginLifecycleContext,
): Promise<void> {
  if (opts.isolate) {
    await rollbackIsolatedPlugin(state, err, opts.stage, ctx);
    return;
  }
  await rollbackAndRemovePlugin(state, seq, err, opts.stopServices, ctx);
}

async function runDefinition(state: PluginState, ctx: PluginLifecycleContext): Promise<void> {
  await state.definition.definePlugin(ctx.createPluginContext(state, state.epoch));
  validateUiDeclarations(state.definition.id, false, ctx);
}

function assertEnableCommitChecks(state: PluginState, ctx: PluginLifecycleContext): void {
  const pluginId = state.definition.id;
  const activePluginIds = getActiveEnabledPluginIds(ctx.plugins);
  ctx.uiRegistry.assertCrossPluginUnique(pluginId, activePluginIds);
  ctx.capabilityRegistry.assertCrossPluginUnique(pluginId, activePluginIds);
  validateUiDeclarations(pluginId, true, ctx);
  assertDependenciesSatisfied(ctx.plugins, pluginId, state.dependencies);
}

function commitEnabled(state: PluginState, ctx: PluginLifecycleContext): void {
  state.enabled = true;
  state.phase = 'idle';
  const provided = ctx.capabilityServiceRegistry.getProvidedCapabilityIds(state.definition.id);
  if (provided.length > 0) {
    ctx.capabilityServiceRegistry.notifyChanged(provided);
  }
}

export async function runRegisterTransaction(
  definition: PluginDefinition,
  options: {
    enabled?: boolean;
    isolateFailure?: boolean;
    onManifestProjected?: (manifest: PluginManifestProjection) => void;
  },
  seq: number,
  isolate: boolean,
  ctx: PluginLifecycleContext,
): Promise<void> {
  const pluginId = definition.id;
  if (ctx.plugins.has(pluginId)) {
    throw new HelmxError('plugin_already_registered', `Plugin is already registered: ${pluginId}`, 409, { pluginId });
  }
  const dependencies = normalizeDependencies(definition);
  assertNoDependencyCycle(ctx.plugins, pluginId, dependencies);

  const wantsEnabled = resolveInitialEnabled(definition, ctx.configStore, options);
  if (wantsEnabled) assertDependenciesSatisfied(ctx.plugins, pluginId, dependencies);
  const dataDir = join(ctx.dataDir, 'plugins', pluginDataDirName(pluginId));
  mkdirSync(dataDir, { recursive: true });
  const tsRootDir = getDefinitionTsRoot(definition);
  const releaseTsRoot =
    tsRootDir !== undefined
      ? registerPluginTsRoot(tsRootDir, { transform: ctx.buildProvider?.transformBackendTs })
      : undefined;

  const state: PluginState = {
    definition,
    dependencies,
    enabled: false,
    phase: 'defining',
    epoch: 1,
    dataDir,
    hooks: new Set(),
    services: [],
    providers: [],
    configSchema: null,
    hostReleases: new Set(),
    ...(releaseTsRoot !== undefined ? { releaseTsRoot } : {}),
    stopWindow: false,
    ...(isolate ? { isolateFailure: true } : {}),
  };
  ctx.plugins.set(pluginId, state);

  try {
    await runDefinition(state, ctx);
    if (options.onManifestProjected !== undefined) {
      options.onManifestProjected(
        buildPluginManifestProjection({
          state,
          capabilityRegistry: ctx.capabilityRegistry,
          uiRegistry: ctx.uiRegistry,
          docRegistry: ctx.docRegistry,
          redactText: ctx.redactText,
          includeCurrentRegistrations: true,
        }),
      );
    }
  } catch (err) {
    await handleRegisterFailure(state, seq, err, { isolate, stage: 'define', stopServices: false }, ctx);
    return;
  }

  if (wantsEnabled) {
    try {
      // Commit enablement checks before marking enabled+idle so capabilities are not exposed early.
      assertEnableCommitChecks(state, ctx);
      ctx.ensureTransientSessionDocListener?.(pluginId);
      await precompilePluginClientModules(state, ctx);
      await registerProviders(state, ctx.providers);
      await activatePluginServices(state, ctx.servicesStarted, ctx.servicesReconciled);
      // Re-run commit checks synchronously right before commitEnabled so concurrent register/enable
      // transactions cannot bypass cross-plugin tool / CLI / UI / dependency uniqueness gates.
      assertEnableCommitChecks(state, ctx);
      commitEnabled(state, ctx);
    } catch (err) {
      await handleRegisterFailure(state, seq, err, { isolate, stage: 'enable', stopServices: true }, ctx);
      return;
    }
  } else {
    try {
      await teardownPluginState(state, { stopServices: false }, ctx);
    } catch (err) {
      await handleRegisterFailure(state, seq, err, { isolate, stage: 'define', stopServices: false }, ctx);
      return;
    }
    state.epoch += 1;
    state.phase = 'idle';
  }
  ctx.emitPluginChanged(state);
}

export async function runUnregisterTransaction(
  pluginId: string,
  ctx: PluginLifecycleContext,
): Promise<void> {
  const state = requirePlugin(ctx.plugins, pluginId);
  assertNoEnabledDependents(ctx.plugins, pluginId);
  if (!state.enabled) {
    await teardownPluginState(state, { stopServices: false }, ctx);
    purgePluginEntries(pluginId, ctx);
    ctx.emitPluginChanged(state);
    return;
  }
  assertPluginIdle(pluginId, state, ctx);
  state.phase = 'deactivating';
  let stopError: { err: unknown } | undefined;
  try {
    await teardownPluginState(state, { stopServices: true }, ctx);
  } catch (err) {
    stopError = { err };
  }
  state.enabled = false;
  purgePluginEntries(pluginId, ctx);
  settleLifecycleChanged(state, stopError, undefined, () => ctx.emitPluginChanged(state));
}

export async function runEnableTransaction(
  pluginId: string,
  ctx: PluginLifecycleContext,
): Promise<void> {
  const state = requirePlugin(ctx.plugins, pluginId);
  if (state.enabled) return;
  if (state.loadFailed === true) {
    throw new HelmxError(
      'plugin_load_failed',
      `Plugin ${pluginId} failed to load (${state.lastError?.message ?? 'unknown error'}); fix plugin source and reload or restart Hub`,
      409,
      { pluginId, error: state.lastError },
    );
  }
  assertDependenciesSatisfied(ctx.plugins, pluginId, state.dependencies);
  const prevConfigSchema = state.configSchema;
  state.epoch += 1;
  clearPluginRegistrations(state, ctx);
  state.configSchema = null;
  state.phase = 'defining';
  let persistedEnabled = false;
  try {
    await runDefinition(state, ctx);
    const activePluginIds = getActiveEnabledPluginIds(ctx.plugins);
    ctx.uiRegistry.assertCrossPluginUnique(pluginId, activePluginIds);
    ctx.capabilityRegistry.assertCrossPluginUnique(pluginId, activePluginIds);
    ctx.ensureTransientSessionDocListener?.(pluginId);
    await precompilePluginClientModules(state, ctx);
    await registerProviders(state, ctx.providers);
    await activatePluginServices(state, ctx.servicesStarted, ctx.servicesReconciled);
    await persistEnabled(ctx.configStore, state, true);
    persistedEnabled = true;
    // Commit enablement and idle phase in the same synchronous block to avoid TOCTOU races with concurrent disables.
    assertEnableCommitChecks(state, ctx);
    state.lastError = undefined;
    commitEnabled(state, ctx);
  } catch (err) {
    await rollbackEnablePlugin(state, prevConfigSchema, err, persistedEnabled, ctx);
  }
  ctx.emitPluginChanged(state);
}

export async function runDisableTransaction(
  pluginId: string,
  options: { force?: boolean },
  ctx: PluginLifecycleContext,
): Promise<void> {
  const state = requirePlugin(ctx.plugins, pluginId);
  if (!state.enabled) return;
  assertPluginIdle(pluginId, state, ctx);
  if (options.force !== true) {
    const usages = await collectPluginInUse(pluginId, state, {
      plugins: ctx.plugins,
      host: ctx.host,
    });
    if (usages.length > 0) {
      throw new HelmxError(
        'plugin_in_use',
        `Plugin ${pluginId} has ${usages.length} active resource usage(s); disabling may break dependent features (pass force to override)`,
        409,
        { pluginId, usages },
      );
    }
  }
  // Re-check idle after async in-use probes and mark deactivating synchronously to prevent TOCTOU races.
  assertPluginIdle(pluginId, state, ctx);
  state.phase = 'deactivating';
  let stopError: { err: unknown } | undefined;
  try {
    await teardownPluginState(state, { stopServices: true }, ctx);
  } catch (err) {
    stopError = { err };
  }
  state.enabled = false;
  state.epoch += 1;
  state.phase = 'idle';
  state.lastError = undefined;
  if (options.force === true) {
    markDependentsBroken(ctx.plugins, pluginId, (dep) => {
      const provided = ctx.capabilityServiceRegistry.getProvidedCapabilityIds(dep.definition.id);
      if (provided.length > 0) {
        ctx.capabilityServiceRegistry.notifyChanged(provided);
      }
      ctx.emitPluginChanged(dep);
    });
  }
  let persistError: { err: unknown } | undefined;
  try {
    await persistEnabled(ctx.configStore, state, false);
  } catch (err) {
    persistError = { err };
  }
  settleLifecycleChanged(state, stopError, persistError, () => ctx.emitPluginChanged(state));
}
