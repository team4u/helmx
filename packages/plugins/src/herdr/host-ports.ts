/**
 * builtin:herdr's consumption of host public ports (ctx.host generic mechanisms -> plugin-internal dependencies).
 *
 * Division discipline (mechanism vs policy separation):
 * - The host exposes generic mechanisms on ctx.host: profiles / buildSpawnEnv / redact /
 *   runGate / getArtifact / completeText / nodeIpc / getNodeHostEnv / openTunnel / executionEnv
 *   -- with zero Herdr semantics;
 * - Gate execution delegates directly to `ctx.host.runGate` for both local (`nodeId: 'local'`) and remote nodes;
 * - Node channel uses `ctx.host.getNodeHostEnv` + `ctx.host.openTunnel({ socketPath })` directly.
 */

import type { HelmxHostApi } from '@helmx/protocol'
import type { HerdrNodeChannel, HerdrPluginDependencies, HerdrTransport } from './contracts.js'
import { createBlockedSnapshotAnalyzer } from './snapshot-analysis.js'

export function nodeChannelFromHost(host: HelmxHostApi): HerdrNodeChannel {
  return {
    isOnline: (nodeId) => host.nodeIpc.isOnline(nodeId),
    getNodeHubUrl: (nodeId) => host.nodeIpc.getNodeHubUrl?.(nodeId),
    ...(host.nodeIpc.nodePlatform !== undefined
      ? { nodePlatform: (nodeId: string) => host.nodeIpc.nodePlatform?.(nodeId) }
      : {}),
    getNodeHostEnv: (nodeId, query, signal) => host.getNodeHostEnv(nodeId, query, signal),
    openTunnel: (nodeId, target, signal) => host.openTunnel(nodeId, target, signal),
    envFor: (nodeId, cwd) => host.executionEnv(nodeId, cwd),
  }
}

/**
 * ctx.host -> HerdrPluginDependencies (the assembly point of the zero-arg factory).
 * Both local and remote gates delegate directly to `ctx.host.runGate` with explicit `nodeId`.
 * `analyzeBlockedSnapshot` is assembled via `host.completeText`.
 */
export function assembleHerdrDepsFromHost(
  host: HelmxHostApi,
  options: { transport?: HerdrTransport; nodeChannel?: HerdrNodeChannel } = {},
): HerdrPluginDependencies {
  const analyzer = createBlockedSnapshotAnalyzer({ completeConversationText: (input) => host.completeText(input) })
  const nodeChannel = options.nodeChannel ?? nodeChannelFromHost(host)
  return {
    profiles: { get: (id) => host.profiles.get(id) },
    buildSpawnEnv: (conversationId, cwd, nodeId, opts) => host.buildSpawnEnv(conversationId, cwd, nodeId, opts),
    redact: (text) => host.redact(text),
    runGate: (command, opts) => host.runGate(command, opts),
    getArtifact: (id, conversationId) => host.getArtifact(id, conversationId),
    nodeChannel,
    analyzeBlockedSnapshot: (input) => analyzer.analyze(input),
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
  }
}
