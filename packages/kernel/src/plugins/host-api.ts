/**
 * host-api: constructs the plugin-facing `ctx.host` facade forwarding explicitly to backend ports:
 * profiles / skills / nodeIpc / secrets / plugins / env / conversations / agents / asks / events / triggers / actions / artifacts / models.
 */
import {
  HelmxError,
  type ActionManifest,
  type HelmxHostApi,
  type HelmxHostOpenTunnelPort,
  type MaybePromise,
  type NodeTunnelTarget,
  type PluginActionContext,
  type PluginSummary,
  type PluginUiContribution,
} from '@helmx/protocol';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { redactJsonValue } from '../redact.js';
import { idempotentRelease } from './shared.js';
import type { PluginTaskTracker } from './tracking.js';
import {
  STOP_WINDOW_HOST_CALLS,
  type PluginHostBackend,
  type PluginHostOptions,
  type PluginState,
} from './types.js';

export interface HostApiDependencies {
  backend: PluginHostBackend;
  tracker: PluginTaskTracker;
  options: PluginHostOptions;
  plugins: Map<string, PluginState>;
  list(): PluginSummary[];
  listUi(): PluginUiContribution[];
  listActions(): ActionManifest[];
  invokeAction(
    targetPluginId: string,
    actionId: string,
    input: unknown,
    context?: PluginActionContext,
  ): Promise<unknown>;
  prepareAction(
    targetPluginId: string,
    actionId: string,
    input: unknown,
    context?: PluginActionContext,
  ): { idempotent: boolean };
  assertContextUsable(state: PluginState, epoch: number, what: string): void;
}

/**
 * Controlled `ExecutionEnv` proxy: validates epoch on every method call (invalidated on disable/re-enable)
 * and tracks async calls via `PluginTaskTracker`, preserving full `ExecutionEnv` method signatures.
 */
function createControlledExecutionEnv(
  state: PluginState,
  epoch: number,
  env: ExecutionEnv,
  deps: Pick<HostApiDependencies, 'assertContextUsable' | 'tracker'>,
): ExecutionEnv {
  const pluginId = state.definition.id;
  return new Proxy(env, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const name = String(prop);
      const fn = value as (...args: unknown[]) => unknown;
      const wrapped = (...args: unknown[]): unknown => {
        deps.assertContextUsable(state, epoch, `host.executionEnv.${name}`);
        const result = fn.apply(target, args);
        if (result instanceof Promise) {
          return deps.tracker.withTask(pluginId, `host.executionEnv.${name}`, () => result);
        }
        return result;
      };
      Object.defineProperty(wrapped, 'name', { value: name, configurable: true });
      return wrapped;
    },
  });
}

/**
 * Constructs `ctx.host`: forwards every method to backend ports, wraps lifecycle resources
 * (`manageConversation` / `onEvent` / `registerAskSeqResolver`) with epoch guards and idempotent release,
 * and tracks in-flight event callbacks in `PluginTaskTracker`.
 */
export function wrapHostApi(
  state: PluginState,
  epoch: number,
  deps: HostApiDependencies,
): HelmxHostApi {
  const pluginId = state.definition.id;
  const backend = deps.backend;

  /**
   * Epoch/lifecycle guard per host call.
   * During `stopWindow`, only `STOP_WINDOW_HOST_CALLS` (reads, cancellations, cleanup IPC, final events)
   * are allowed through — including during host `dispose`; all new-work entry points are rejected.
   */
  const guard = (what: string): void => {
    if (
      state.stopWindow &&
      STOP_WINDOW_HOST_CALLS.has(what) &&
      deps.plugins.get(pluginId) === state &&
      state.epoch === epoch
    ) {
      return;
    }
    deps.assertContextUsable(state, epoch, what);
  };

  /** Wraps async host calls with lifecycle guard + `PluginTaskTracker` tracking. */
  const tracked = <T>(what: string, op: () => Promise<T>): Promise<T> => {
    guard(what);
    return deps.tracker.withTask(pluginId, what, op);
  };

  const acquire =
    (what: string) =>
    (acquireFn: () => () => void): (() => void) => {
      guard(what);
      const release = idempotentRelease(acquireFn());
      state.hostReleases.add(release);
      return () => {
        state.hostReleases.delete(release);
        release();
      };
    };

  return {
    get isClosing() {
      return backend.isClosing();
    },

    // 1. profiles
    profiles: {
      list: () => tracked('host.profiles.list', () => backend.profiles.list()),
      get: (id) => tracked('host.profiles.get', () => backend.profiles.get(id)),
      getSystem: (id) => tracked('host.profiles.getSystem', () => backend.profiles.getSystem(id)),
      save: (profile) => tracked('host.profiles.save', () => backend.profiles.save(profile)),
      directory: (id) => tracked('host.profiles.directory', () => backend.profiles.directory(id)),
    },

    // 2. skills
    skills: {
      list: () => tracked('host.skills.list', () => backend.skills.list()),
      readFile: (skillId, path) => tracked('host.skills.readFile', () => backend.skills.readFile(skillId, path)),
      ensureSkill: (asset) => tracked('host.skills.ensureSkill', () => backend.skills.ensureSkill(asset, pluginId)),
    },

    // 3. nodeIpc (read-only node reachability/metadata; `nodePlatform` is reported by NodeRegistry or undefined when offline/unreported).
    nodeIpc: backend.nodeIpc === undefined
      ? {
          isOnline: () => {
            guard('host.nodeIpc.isOnline');
            throw new HelmxError('node_ipc_unavailable', 'Host does not provide a node IPC channel (EnvFabric not wired)', 501);
          },
        }
      : {
          isOnline: (nodeId) => {
            guard('host.nodeIpc.isOnline');
            return backend.nodeIpc!.isOnline(nodeId);
          },
          ...(backend.nodeIpc.getNodeHubUrl !== undefined
            ? {
                getNodeHubUrl: (nodeId: string) => {
                  guard('host.nodeIpc.getNodeHubUrl');
                  return backend.nodeIpc!.getNodeHubUrl?.(nodeId);
                },
              }
            : {}),
          ...(backend.nodeIpc.nodePlatform !== undefined
            ? {
                nodePlatform: (nodeId: string): string | undefined => {
                  guard('host.nodeIpc.nodePlatform');
                  return backend.nodeIpc!.nodePlatform?.(nodeId);
                },
              }
            : {}),
          ...(backend.nodeIpc.listNodes !== undefined
            ? {
                listNodes: () => {
                  guard('host.nodeIpc.listNodes');
                  return structuredClone(backend.nodeIpc!.listNodes!());
                },
              }
            : {}),
        },

    // 3.5 openTunnel: tracks active TCP Duplex tunnels until close/error/destroy (`disable` rejects with 409).
    openTunnel: backend.openTunnel === undefined
      ? ((nodeId: string): Promise<never> => {
          guard('host.openTunnel');
          throw new HelmxError(
            'node_tunnel_not_supported',
            `Current host has not wired the node tunnel port (host.openTunnel(${nodeId}) unavailable)`,
            501,
            { nodeId },
          );
        })
      : (async (nodeId: string, target: NodeTunnelTarget, signal?: AbortSignal) => {
          guard('host.openTunnel');
          const what = `host.openTunnel:${nodeId}`;
          // Begin tracking before dialing rather than around the connect promise so liveTasks covers the Duplex lifetime.
          deps.tracker.begin(pluginId, what);
          let ended = false;
          const end = (): void => {
            if (ended) return;
            ended = true;
            deps.tracker.end(pluginId, what);
          };
          try {
            const duplex = await backend.openTunnel!(nodeId, target, signal);
            const release = (): void => { duplex.destroy(); };
            const onClosed = (): void => {
              duplex.removeListener('close', onClosed);
              duplex.removeListener('error', onClosed);
              state.hostReleases.delete(release);
              end();
            };
            duplex.once('close', onClosed);
            duplex.once('error', onClosed);
            try {
              guard('host.openTunnel');
            } catch (error) {
              duplex.destroy();
              throw error;
            }
            state.hostReleases.add(release);
            if (duplex.destroyed) onClosed();
            return duplex;
          } catch (error) {
            end();
            throw error;
          }
        }) as HelmxHostOpenTunnelPort,

    // 4. secrets
    secrets: {
      get: (key) => tracked('host.secrets.get', () => backend.secrets.get(pluginId, key)),
      set: (key, value) => tracked('host.secrets.set', () => backend.secrets.set(pluginId, key, value)),
      delete: (key) => tracked('host.secrets.delete', () => backend.secrets.delete(pluginId, key)),
      addRedaction: (value) =>
        acquire('host.secrets.addRedaction')(() => backend.secrets.addRedaction(value)),
    },

    // 5. plugins & models
    listPlugins: () => {
      guard('host.listPlugins');
      return deps.list();
    },
    listUi: () => {
      guard('host.listUi');
      return deps.listUi();
    },
    refreshModels: (options) => tracked('host.refreshModels', () => backend.refreshModels(options)),
    listModels: () => {
      guard('host.listModels');
      const port = backend.listModels;
      if (port === undefined) {
        throw new HelmxError(
          'not_supported',
          'Current host has not wired model catalog reading (host.listModels)',
          501,
        );
      }
      return deps.tracker.withTask(pluginId, 'host.listModels', () => Promise.resolve(port()));
    },

    // 6. environment & file mutations
    withFileLock: <T,>(path: string, fn: () => Promise<T>, opts?: { signal?: AbortSignal }) => {
      guard('host.withFileLock');
      return deps.tracker.withTask(pluginId, 'host.withFileLock', () =>
        backend.withFileLock(path, async () => {
          guard('host.withFileLock.fn');
          return fn();
        }, opts),
      );
    },
    atomicWriteFile: (path, content) => tracked('host.atomicWriteFile', () => backend.atomicWriteFile(path, content)),
    redact: (text) => {
      guard('host.redact');
      return backend.redact(text);
    },
    executionEnv: (nodeId, cwd) => {
      guard('host.executionEnv');
      return createControlledExecutionEnv(state, epoch, backend.executionEnv(nodeId, cwd), deps);
    },
    execEnv: async (req, opts) => {
      guard('host.execEnv');
      return deps.tracker.withTask(pluginId, 'host.execEnv', () =>
        Promise.resolve(backend.execEnv(req, opts)),
      );
    },
    inspectNodePathUsage: (input) => tracked('host.inspectNodePathUsage', () => backend.inspectNodePathUsage(input)),

    // 7. triggers & inputs
    dispatchTrigger: (event) => {
      guard('host.dispatchTrigger');
      return deps.tracker.withTask(pluginId, 'host.dispatchTrigger', () =>
        Promise.resolve(backend.dispatchTrigger(event)),
      );
    },
    submitInput: (id, text, opts) => {
      guard('host.submitInput');
      return deps.tracker.withTask(pluginId, 'host.submitInput', () =>
        Promise.resolve(backend.submitInput(id, text, opts)),
      );
    },
    // 7.5 Guarded mutation ports (enforced by kernel): return explicit 501 when unwired; never fall back to unguarded variants.
    submitInputGuarded: (id, text, opts, mutationGuard) => {
      guard('host.submitInputGuarded');
      const port = backend.submitInputGuarded;
      if (port === undefined) {
        throw new HelmxError(
          'not_supported',
          'Current host has not wired guarded input submission (host.submitInputGuarded)',
          501,
          { conversationId: id },
        );
      }
      return deps.tracker.withTask(pluginId, 'host.submitInputGuarded', () =>
        Promise.resolve(port(id, text, opts, mutationGuard)),
      );
    },

    // 8. conversations
    createConversation: (init) => tracked('host.createConversation', () => backend.createConversation(init)),
    forkConversation: (id, opts) => tracked('host.forkConversation', () => backend.forkConversation(id, opts)),
    listConversations: (filter) => {
      guard('host.listConversations');
      return backend.listConversations(filter);
    },
    getConversation: (id) => {
      guard('host.getConversation');
      return backend.getConversation(id);
    },
    getConversationDetail: (id, options) =>
      tracked('host.getConversationDetail', () => backend.getConversationDetail(id, options)),
    getConversationSubmission: (id, requestId) => {
      guard('host.getConversationSubmission');
      const port = backend.getConversationSubmission;
      if (port === undefined) {
        throw new HelmxError(
          'not_supported',
          'Current host has not wired durable submission lookup (host.getConversationSubmission)',
          501,
          { conversationId: id },
        );
      }
      return deps.tracker.withTask(pluginId, 'host.getConversationSubmission', () =>
        Promise.resolve(port(id, requestId)),
      );
    },
    updateConversation: (id, patch) => tracked('host.updateConversation', () => backend.updateConversation(id, patch)),
    abortConversation: (id) => tracked('host.abortConversation', () => backend.abortConversation(id)),
    abortConversationGuarded: (id, mutationGuard) => {
      guard('host.abortConversationGuarded');
      const port = backend.abortConversationGuarded;
      if (port === undefined) {
        throw new HelmxError(
          'not_supported',
          'Current host has not wired guarded abort (host.abortConversationGuarded)',
          501,
          { conversationId: id },
        );
      }
      return deps.tracker.withTask(pluginId, 'host.abortConversationGuarded', () =>
        Promise.resolve(port(id, mutationGuard)),
      );
    },
    getConversationOwnership: (id) => {
      guard('host.getConversationOwnership');
      return backend.getConversationOwnership(id);
    },
    manageConversation: (id) =>
      acquire('host.manageConversation')(() => backend.manageConversation(id, pluginId)),
    markConversationOwnership: (id, owner) => {
      guard('host.markConversationOwnership');
      backend.markConversationOwnership(id, owner);
    },

    // 9. agents & spawn
    spawnAgent: (request) => {
      guard('host.spawnAgent');
      return deps.tracker.withTask(pluginId, 'host.spawnAgent', () =>
        Promise.resolve(backend.spawnAgent(request)),
      );
    },
    runGate: (command, options) => tracked('host.runGate', () => backend.runGate(command, options)),
    resolveSpawnTarget: (input) => tracked('host.resolveSpawnTarget', () => backend.resolveSpawnTarget(input)),
    listActiveSpawnExecutions: () => {
      guard('host.listActiveSpawnExecutions');
      return backend.listActiveSpawnExecutions();
    },

    // 10. artifacts & text completion
    listArtifacts: (conversationId) => tracked('host.listArtifacts', () => backend.listArtifacts(conversationId)),
    completeText: (input) => tracked('host.completeText', () => backend.completeText(input)),

    // 11. actions
    invokeAction: async (targetPluginId, actionId, input, context) => {
      guard('host.invokeAction');
      const raw = await deps.tracker.withTask(pluginId, `host.invokeAction:${targetPluginId}.${actionId}`, () =>
        Promise.resolve(deps.invokeAction(targetPluginId, actionId, input, context)),
      );
      const redactText = deps.options.redactText;
      return redactText ? redactJsonValue(raw, redactText) : raw;
    },
    listActions: () => {
      guard('host.listActions');
      return deps.listActions();
    },
    prepareAction: (targetPluginId, actionId, input, context) => {
      guard('host.prepareAction');
      return deps.prepareAction(targetPluginId, actionId, input, context);
    },

    // 12. asks
    createAsk: (spec) => tracked('host.createAsk', () => backend.createAsk(spec)),
    cancelAsk: (askId, reason) => tracked('host.cancelAsk', () => backend.cancelAsk(askId, reason)),

    // 13. events
    onEvent(type: string, listener: (payload: unknown) => MaybePromise<void>): () => void {
      return acquire(`host.onEvent:${type}`)(() =>
        backend.onEvent(type, (payload: unknown) =>
          deps.tracker.withTask(pluginId, `event:${type}`, async () => {
            await listener(payload);
          }),
        ),
      );
    },
    emitEvent(type: string, payload: unknown, options?: { broadcast?: boolean }): MaybePromise<void> {
      guard('host.emitEvent');
      return backend.emitEvent(type, payload, options);
    },
  };
}
