import { hubVersion, KernelRuntime, loadExternalPlugins } from '@helmx/kernel';
import { createPluginBuildProvider } from '@helmx/plugin-build';
import { createProfilePlugin } from '@helmx/plugins/profile';
import { createWorkflowPlugin } from '@helmx/plugins/workflow';
import { createWorktreePlugin } from '@helmx/plugins/worktree';
import { createSwarmPlugin } from '@helmx/plugins/swarm';
import { createMemoryPlugin } from '@helmx/plugins/memory';
import { createJsonRenderPlugin } from '@helmx/plugins/json-render';
import { createMermaidPlugin } from '@helmx/plugins/mermaid';
import { createTriggersPlugin } from '@helmx/plugins/triggers';
import { createMagpiePlugin } from '@helmx/plugins/magpie';
import { createTokenSpeedPlugin } from '@helmx/plugins/token-speed';
import { createTiersPlugin } from '@helmx/plugins/tiers';
import { createTitlePlugin } from '@helmx/plugins/title';
import {
  NodeAutoUpgradeCoordinator,
  resolveAutoUpgradeNodesEnabled,
  type NodeAutoUpgradeRetryPolicy,
} from './node-auto-upgrade.js';

export type HelmxOptions = Omit<NonNullable<Parameters<typeof KernelRuntime.open>[0]>, 'autoResume'> & {
  /**
   * Two-phase boot switch (default `true` = createHelmx runs `kernel.start()` itself, unchanged for
   * all existing callers). When `false`, the returned kernel is assembled and recovered but NOT
   * started: the composition root should first open the HTTP listener (`startHub`, so `/ws/node`
   * accepts remote-node reconnections) and only then call `kernel.start()` — its bounded node-join
   * grace then waits for recovery-dependent registered nodes before driving plugin recovery and the
   * scheduler (fixes restart recovery racing node reconnection; see kernel `node-join-grace.ts`).
   */
  autoStart?: boolean;
  /** Override automatic node version-follow (defaults to enabled unless `HELMX_AUTO_UPGRADE_NODES=0|false|off|no`). */
  autoUpgradeNodes?: boolean;
  /** Retry/busy-poll timing overrides for automatic node upgrades (for tests). */
  nodeAutoUpgradePolicy?: NodeAutoUpgradeRetryPolicy;
};

/** Composition root selects plugins, default enabled states, and Hub-level product policies (like automatic node version-follow). */
export async function createHelmx(options: HelmxOptions = {}) {
  // Default product composition injects the plugin build provider (`client.tsx` compilation + external TS transpilation);
  // callers may override via `options.buildProvider`. The kernel itself does not bundle esbuild (separating mechanism from
  // tooling) and explicitly rejects client UI / TS plugins when unwired (`unsupported_client_build`, etc.).
  const {
    autoStart = true,
    autoUpgradeNodes,
    nodeAutoUpgradePolicy,
    ...kernelOptions
  } = options;
  const kernel = await KernelRuntime.open({
    ...kernelOptions,
    buildProvider: options.buildProvider ?? createPluginBuildProvider(),
    autoResume: false,
  });
  const autoUpgrade = new NodeAutoUpgradeCoordinator({
    isEnabled: () => autoUpgradeNodes ?? resolveAutoUpgradeNodesEnabled(process.env),
    isHubReady: () => kernel.started,
    getTargetVersion: () => hubVersion(),
    getOnlineNode: (nodeId) => kernel.nodes.getOnlineNode(nodeId),
    listOnlineNodeIds: () => kernel.nodes.listOnlineNodeIds(),
    hasNode: (nodeId) => kernel.nodes.hasNode(nodeId),
    hasUpgradeInFlight: (nodeId) => kernel.nodes.hasUpgradeInFlight(nodeId),
    describeNodeBusy: (nodeId) => kernel.describeNodeBusy(nodeId),
    runUpgrade: (nodeId, targetVersion) => kernel.upgradeNode(nodeId, { targetVersion }),
    publishNodeChanged: (nodeId) => kernel.nodes.publishNodeChanged(nodeId),
    publishNotification: (payload) => kernel.nodes.publishNotification(payload),
    log: (message) =>
      kernel.emitDiagnostic({
        level: 'info',
        source: 'nodes.auto-upgrade',
        message,
      }),
    policy: nodeAutoUpgradePolicy,
  });
  kernel.nodes.setAutoUpgradeStatusProvider((nodeId) => autoUpgrade.statusOf(nodeId));
  const offNodeConnectionChanged = kernel.nodes.onNodeConnectionChanged((nodeId, online) => {
    if (online) autoUpgrade.onNodeOnline(nodeId);
    else autoUpgrade.onNodeOffline(nodeId);
  });
  const offNodeRemoved = kernel.nodes.onNodeRemoved((nodeId) => {
    autoUpgrade.onNodeRemoved(nodeId);
  });
  const offStarted = kernel.onStarted(() => {
    autoUpgrade.onHubReady();
  });
  let autoUpgradeDisposed = false;
  let offClose: (() => void) | undefined;
  const disposeAutoUpgrade = (): void => {
    if (autoUpgradeDisposed) return;
    autoUpgradeDisposed = true;
    offClose?.();
    offStarted();
    offNodeRemoved();
    offNodeConnectionChanged();
    kernel.nodes.setAutoUpgradeStatusProvider(undefined);
    autoUpgrade.dispose();
  };
  offClose = kernel.onClose(disposeAutoUpgrade);
  try {
    // Default-enabled (12): profile (locked), workflow, worktree, swarm, memory, json-render, mermaid, triggers, magpie, token-speed, tiers, title.
    // Post-startup recovery ordering (workflow child-session convergence before worktree crashed-lease
    // reclamation) is enforced by PluginHost.reconcile() topological order via service.reconcileAfter,
    // independent of plugin registration order here.
    await kernel.plugins.register(createProfilePlugin());
    await kernel.plugins.register(createWorkflowPlugin());
    await kernel.plugins.register(createWorktreePlugin());
    await kernel.plugins.register(createSwarmPlugin());
    await kernel.plugins.register(createMemoryPlugin());
    await kernel.plugins.register(createJsonRenderPlugin());
    await kernel.plugins.register(createMermaidPlugin());
    await kernel.plugins.register(createTriggersPlugin());
    await kernel.plugins.register(createMagpiePlugin());
    await kernel.plugins.register(createTokenSpeedPlugin());
    await kernel.plugins.register(createTiersPlugin());
    await kernel.plugins.register(createTitlePlugin());
    await loadExternalPlugins(kernel.dataDir, kernel.plugins);
    // Run `prepare -> start` across all registered plugins before resuming the SDK scheduler.
    // Two-phase boot (autoStart: false) defers this to the entrypoint after the HTTP listener opens;
    // when `kernel.start()` finishes, `onStarted` wakes `autoUpgrade.onHubReady()`.
    if (autoStart) await kernel.start();
    return {
      kernel,
      autoUpgrade,
      close: async () => {
        disposeAutoUpgrade();
        await kernel.close();
      },
    };
  } catch (error) {
    disposeAutoUpgrade();
    await kernel.close();
    throw error;
  }
}
