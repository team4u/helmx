/**
 * Builds the `HelmxPluginContext` passed to `definePlugin` (hook, action, tool, route, doc, sessionDoc, service, provider, ui, and host).
 */
import {
  HelmxError,
  validatePluginConfigFieldSchema,
  type CommandSpec,
  type ComposerCompleterSpec,
  type HelmxPluginContext,
  type HookHandler,
  type HookName,
  type HookOptions,
  type MarkdownCodeBlockSpec,
  type PluginConfigFieldSchema,
  type PluginServiceSpec,
  type PluginSlotContributionSpec,
  type ScreenSpec,
  type SettingsPanelSpec,
  type SidebarItemSpec,
  type TimelineRendererSpec,
  type ToolViewSpec,
  type WorkbenchPanelSpec,
} from '@helmx/protocol';
import type { Provider } from '@earendil-works/pi-ai';
import type { HookPipeline } from './hooks.js';
import type { CapabilityRegistry } from './capability-registry.js';
import type { UiRegistry } from './ui-registry.js';
import type { PluginDocRegistry } from './doc-registry.js';
import { assertValidId, jsonClone } from './shared.js';
import { assertValidProviderShape } from './provider-coordinator.js';
import { wrapHostApi, type HostApiDependencies } from './host-api.js';
import type {
  PluginConfigStore,
  PluginState,
} from './types.js';

interface CreatePluginContextOptions {
  state: PluginState;
  epoch: number;
  pipelines: Map<HookName, HookPipeline<HookName>>;
  capabilityRegistry: CapabilityRegistry;
  uiRegistry: UiRegistry;
  docRegistry: PluginDocRegistry;
  configStore?: PluginConfigStore;
  hostDeps: HostApiDependencies;
  assertNotDisposed: () => void;
  assertContextUsable: (state: PluginState, epoch: number, what: string) => void;
  isRegisteredState: (state: PluginState) => boolean;
}

const UNSAFE_CONFIG_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9:_-]+$/;

/**
 * Declaration boundary guard for `ctx.configSchema`: validates field keys, types (`string | number |
 * boolean | string[]`), display copy (`label` / `description`), `format`, `enum`, numeric bounds,
 * `secret` / `required` flags, and `default` via the single shared protocol validator.
 */
function assertValidConfigSchema(
  pluginId: string,
  schema: Record<string, PluginConfigFieldSchema>,
): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new HelmxError('invalid_config_schema', `plugin ${pluginId} configSchema must be object`, 400, { pluginId });
  }
  for (const [key, field] of Object.entries(schema)) {
    if (key.length === 0 || UNSAFE_CONFIG_KEYS.has(key)) {
      throw new HelmxError(
        'invalid_config_schema',
        `Plugin ${pluginId} config field key ${JSON.stringify(key)} is invalid`,
        400,
        { pluginId, field: key },
      );
    }
    const reason = validatePluginConfigFieldSchema(field, {
      allowSecretDefault: true,
      requireBooleanFlags: false,
    });
    if (reason !== undefined) {
      throw new HelmxError(
        'invalid_config_schema',
        `Plugin ${pluginId} config field ${key} ${reason}`,
        400,
        { pluginId, field: key },
      );
    }
  }
}

/** Validates and deduplicates optional `service.reconcileAfter` soft-ordering plugin IDs. */
function normalizeServiceReconcileAfter(
  pluginId: string,
  serviceId: string,
  targets: readonly string[] | undefined,
): string[] | undefined {
  if (targets === undefined) return undefined;
  if (!Array.isArray(targets) || targets.some((t) => typeof t !== 'string' || !PLUGIN_ID_PATTERN.test(t))) {
    throw new HelmxError(
      'invalid_service_spec',
      `Plugin ${pluginId} service ${serviceId} reconcileAfter must be an array of valid plugin IDs`,
      400,
      { pluginId, serviceId },
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const target of targets) {
    if (target === pluginId) {
      throw new HelmxError(
        'plugin_dependency_cycle',
        `Plugin ${pluginId} service ${serviceId} reconcileAfter cannot reference itself`,
        409,
        { pluginId, serviceId, cycle: [pluginId, pluginId] },
      );
    }
    if (seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out.length > 0 ? out : undefined;
}

export function createPluginContext(options: CreatePluginContextOptions): HelmxPluginContext {
  const {
    state,
    epoch,
    pipelines,
    capabilityRegistry,
    uiRegistry,
    docRegistry,
    configStore,
    hostDeps,
    assertNotDisposed,
    assertContextUsable,
    isRegisteredState,
  } = options;
  const pluginId = state.definition.id;

  /** Registration methods are only valid during `definePlugin` execution for this enablement cycle. */
  const assertOpen = (what: string) => {
    assertNotDisposed();
    if (epoch !== state.epoch || state.phase !== 'defining') {
      throw new HelmxError(
        'plugin_context_closed',
        `Plugin ${pluginId} definePlugin context has closed (disabled or entered a new enablement cycle); cannot ${what}`,
        409,
      );
    }
  };

  /**
   * Doc handles remain writable throughout the active cycle and invalidate on disable or cycle advance.
   * Exception: during a controlled service shutdown window (`PluginState.stopWindow`), handles of matching
   * epoch may still flush final state.
   */
  const assertDocUsable = (name: string) => {
    if (state.stopWindow && isRegisteredState(state) && state.epoch === epoch) {
      return;
    }
    assertContextUsable(state, epoch, `doc ${name} handle`);
  };

  const addHook = <N extends HookName>(name: N, fn: HookHandler<N>, opts?: HookOptions) => {
    assertOpen(`add ${name} hook`);
    (pipelines.get(name) as unknown as HookPipeline<N>).add(pluginId, fn, opts?.priority ?? 0);
    state.hooks.add(name);
  };

  const host = wrapHostApi(state, epoch, hostDeps);

  const ctx: HelmxPluginContext = {
    pluginId,
    dataDir: state.dataDir,
    getConfig: () => (configStore ? configStore.get(pluginId) : {}) as never,
    configSchema: (schema) => {
      assertOpen('declare configSchema');
      if (state.configSchema) {
        throw new HelmxError('duplicate_config_schema', `Plugin ${pluginId} declared duplicate configSchema`, 409);
      }
      assertValidConfigSchema(pluginId, schema);
      state.configSchema = jsonClone(schema);
    },

    hook: {
      onInput: (fn, o) => addHook('input', fn, o),
      onBeforeTurn: (fn, o) => addHook('before_turn', fn, o),
      onAgentSpawn: (fn, o) => addHook('agent_spawn', fn, o),
      onTurnSettled: (fn, o) => addHook('turn_settled', fn, o),
    },

    action: (spec) => {
      assertOpen(`declare action ${spec.id}`);
      capabilityRegistry.registerAction(pluginId, spec);
    },

    tool: (spec) => {
      assertOpen(`declare tool ${spec.name}`);
      capabilityRegistry.registerTool(pluginId, spec);
    },

    route: (spec) => {
      assertOpen(`declare route ${spec.path}`);
      capabilityRegistry.registerRoute(pluginId, spec);
    },

    doc: (name, initial, opts) => {
      assertOpen(`declare doc ${name}`);
      return docRegistry.registerDoc(pluginId, name, initial, opts, () => assertDocUsable(name));
    },

    sessionDoc: (name, initial, opts) => {
      assertOpen(`declare sessionDoc ${name}`);
      return docRegistry.registerSessionDoc(pluginId, name, initial, opts, () => assertDocUsable(name));
    },

    service: (spec: PluginServiceSpec) => {
      assertOpen(`declare service ${spec.id}`);
      assertValidId('service', spec.id);
      if (spec.liveTasks !== undefined && typeof spec.liveTasks !== 'function') {
        throw new HelmxError(
          'invalid_service_spec',
          `Plugin ${pluginId} service ${spec.id} liveTasks must be a function returning a string array`,
          400,
          { pluginId, serviceId: spec.id },
        );
      }
      if (spec.prepare !== undefined && typeof spec.prepare !== 'function') {
        throw new HelmxError(
          'invalid_service_spec',
          `Plugin ${pluginId} service ${spec.id} prepare must be a function`,
          400,
          { pluginId, serviceId: spec.id },
        );
      }
      if (spec.reconcile !== undefined && typeof spec.reconcile !== 'function') {
        throw new HelmxError(
          'invalid_service_spec',
          `Plugin ${pluginId} service ${spec.id} reconcile must be a function`,
          400,
          { pluginId, serviceId: spec.id },
        );
      }
      const reconcileAfter = normalizeServiceReconcileAfter(pluginId, spec.id, spec.reconcileAfter);
      if (state.services.some((s) => s.id === spec.id)) {
        throw new HelmxError('duplicate_service', `Plugin ${pluginId} declared duplicate service ${spec.id}`, 409);
      }
      state.services.push({
        ...spec,
        ...(reconcileAfter !== undefined ? { reconcileAfter } : {}),
        pluginId,
        started: false,
        prepared: false,
        reconciled: false,
      });
    },

    provider: (provider: Provider) => {
      assertOpen(`declare provider ${(provider as { id?: unknown })?.id ?? '<unknown>'}`);
      assertValidProviderShape(pluginId, provider);
      if (state.providers.some((p) => p.provider.id === provider.id)) {
        throw new HelmxError('duplicate_provider', `Plugin ${pluginId} declared duplicate provider ${provider.id}`, 409);
      }
      state.providers.push({ provider, unregister: null });
    },

    ui: {
      sidebarItem: (spec: SidebarItemSpec) => {
        assertOpen('declare ui.sidebarItem');
        uiRegistry.registerUi(pluginId, 'sidebar.item', spec, 'sidebarItem', state.definition.clientRoot);
      },
      screen: (spec: ScreenSpec) => {
        assertOpen('declare ui.screen');
        uiRegistry.registerUi(pluginId, 'screen', spec, 'screen', state.definition.clientRoot);
      },
      timelineRenderer: (spec: TimelineRendererSpec) => {
        assertOpen('declare ui.timelineRenderer');
        uiRegistry.registerUi(pluginId, 'timeline.renderer', spec, 'timelineRenderer', state.definition.clientRoot);
      },
      markdownCodeBlock: (spec: MarkdownCodeBlockSpec) => {
        assertOpen('declare ui.markdownCodeBlock');
        uiRegistry.registerUi(pluginId, 'markdown.codeBlock', spec, 'markdownCodeBlock', state.definition.clientRoot);
      },
      toolView: (spec: ToolViewSpec) => {
        assertOpen('declare ui.toolView');
        uiRegistry.registerUi(pluginId, 'tool.view', spec, 'toolView', state.definition.clientRoot);
      },
      composerCompleter: (spec: ComposerCompleterSpec) => {
        assertOpen('declare ui.composerCompleter');
        uiRegistry.registerUi(pluginId, 'composer.completer', spec, 'composerCompleter', state.definition.clientRoot);
      },
      workbenchPanel: (spec: WorkbenchPanelSpec) => {
        assertOpen('declare ui.workbenchPanel');
        uiRegistry.registerUi(pluginId, 'workbench.panel', spec, 'workbenchPanel', state.definition.clientRoot);
      },
      command: (spec: CommandSpec) => {
        assertOpen('declare ui.command');
        uiRegistry.registerUi(pluginId, 'commandPalette', spec, 'command', state.definition.clientRoot);
      },
      settingsPanel: (spec: SettingsPanelSpec) => {
        assertOpen('declare ui.settingsPanel');
        uiRegistry.registerUi(pluginId, 'settings.panel', spec, 'settingsPanel', state.definition.clientRoot);
      },
      slot: (spec: PluginSlotContributionSpec) => {
        assertOpen('declare ui.slot');
        uiRegistry.registerUi(pluginId, 'plugin.slot', spec, 'slot', state.definition.clientRoot);
      },
    },

    host,
  };

  return ctx;
}
