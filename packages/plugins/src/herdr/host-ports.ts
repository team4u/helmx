/**
 * builtin:herdr's consumption of host public ports (ctx.host generic mechanisms -> plugin-internal dependencies).
 *
 * Division discipline (mechanism vs policy separation):
 * - The host exposes generic mechanisms on ctx.host: profiles / buildSpawnEnv / redact /
 *   runGate / getArtifact / completeText / nodeIpc / openTunnel / executionEnv -- with zero Herdr semantics;
 * - Gate execution delegates directly to `ctx.host.runGate` for both local (`nodeId: 'local'`) and remote nodes;
 * - Node channel uses `openTunnel({ socketPath })` + `getNodeHostEnv`:
 *   NOTE (follow-up Host API integration):
 *   1. `protocol/src/plugin.ts` (`HelmxHostOpenTunnelPort`) and `kernel/src/plugins/host-api.ts` still type
 *      `openTunnel`'s target as `{ host?: string; port: number }` rather than `NodeTunnelTarget` (at runtime
 *      `host-api.ts` forwards `target` directly to `backend.openTunnel`);
 *   2. `protocol/src/plugin.ts` (`HelmxHostApi`) and `kernel/src/plugins/host-api.ts` + `runtime-host-backend.ts`
 *      have not yet wired `getNodeHostEnv` — until integrated, invoking `getNodeHostEnv` through `nodeChannelFromHost`
 *      throws an explicit `501 node_host_env_not_supported` (never silently falling back to Hub local env).
 */

import type { Duplex } from 'node:stream'
import {
  HelmxError,
  type HelmxHostApi,
  type NodeHostEnv,
  type NodeHostEnvQuery,
  type NodeTunnelTarget,
} from '@helmx/protocol'
import type { HerdrNodeChannel, HerdrPluginDependencies, HerdrTransport } from './contracts.js'
import { createBlockedSnapshotAnalyzer } from './snapshot-analysis.js'

/** Forward-looking structural shape for `ctx.host` once Host API integration wires `getNodeHostEnv` + `NodeTunnelTarget`. */
interface HostWithTargetEnvAndTunnel {
  getNodeHostEnv?: (nodeId: string, query?: NodeHostEnvQuery, signal?: AbortSignal) => Promise<NodeHostEnv>
  openTunnel: (nodeId: string, target: NodeTunnelTarget, signal?: AbortSignal) => Promise<Duplex>
}

export function nodeChannelFromHost(host: HelmxHostApi): HerdrNodeChannel {
  const extended = host as unknown as HostWithTargetEnvAndTunnel
  return {
    isOnline: (nodeId) => host.nodeIpc.isOnline(nodeId),
    getNodeHubUrl: (nodeId) => host.nodeIpc.getNodeHubUrl?.(nodeId),
    ...(host.nodeIpc.nodePlatform !== undefined
      ? { nodePlatform: (nodeId: string) => host.nodeIpc.nodePlatform?.(nodeId) }
      : {}),
    getNodeHostEnv: (nodeId, query, signal) => {
      if (typeof extended.getNodeHostEnv === 'function') {
        return extended.getNodeHostEnv(nodeId, query, signal)
      }
      return Promise.reject(
        new HelmxError(
          'node_host_env_not_supported',
          `Host API has not wired getNodeHostEnv port for node '${nodeId}' yet; refusing to fall back to Hub local env`,
          501,
          { nodeId },
        ),
      )
    },
    openTunnel: (nodeId, target, signal) => extended.openTunnel(nodeId, target, signal),
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
