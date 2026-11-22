/**
 * Single authoritative resolution chain for spawn targets (pure internal kernel helper; shared by native
 * execution and `ctx.host.resolveSpawnTarget` so plugins never duplicate resolution rules).
 *
 * Must be resolved lazily at actual invocation time rather than pre-normalized up front: `agent_spawn`
 * around hooks can rewrite the request via `next(finalRequest)`, invalidating any pre-input snapshot;
 * resume semantics also rely on `request.cwd === undefined` (explicit inheritance fallback) which pre-filling
 * would break (see `resolveSpawnTarget` docstring in `protocol/plugin.ts` for full contract).
 *
 * Semantics:
 * - Node chain:
 *   - Explicit `requestNodeId` always wins (explicit `'local'` overrides a remote parent or Profile);
 *   - Otherwise, normal or cross-profile fork: `profile.nodeId` > parent conversation bound node > `'local'`;
 *   - Same-profile fork (`forkSameProfile=true`): parent conversation bound node > `profile.nodeId` > `'local'`;
 * - Cross-node cwd isolation:
 *   - `profile.cwd` is eligible only when `profile.nodeId === undefined || profile.nodeId === nodeId`;
 *   - `parentCwd` is eligible only when `(parentNodeId ?? 'local') === nodeId`;
 *   - `defaultCwd` is eligible only when `nodeId === 'local'`;
 *   - Normal or cross-profile fork: `request.cwd` > `usableProfileCwd` > `usableParentCwd` > `fallbackDefaultCwd`;
 *   - Same-profile fork (`forkSameProfile=true`): `request.cwd` > `usableParentCwd` > `usableProfileCwd` > `fallbackDefaultCwd`;
 *   - Missing cwd for a remote target (`nodeId !== 'local'`) throws `400 validation_error`;
 * - `cwd` is normalized consistently per target node platform (`normalizeSessionCwd`: unmappable POSIX
 *   `cwd` on win32 targets is explicitly rejected; passed through when remote platform is unknown), via a
 *   caller-supplied `normalize` closure (carrying its `trustedPlatform` fact source).
 */

import { HelmxError } from '@helmx/protocol'

interface SpawnTargetChainInput {
  /** Explicit target node requested by caller (highest precedence; `'local'` overrides remote parent/Profile). */
  requestNodeId?: string
  /** Target node explicitly declared by Profile (defaults to inheriting parent conversation). */
  profileNodeId?: string
  /** Parent conversation's bound node snapshot. */
  parentNodeId?: string
  /** Explicit cwd from request (takes precedence over Profile/parent conversation cwd). */
  requestCwd?: string
  /** Explicit cwd from Profile. */
  profileCwd?: string
  /** Parent conversation's cwd snapshot. */
  parentCwd?: string
  /** Host default cwd (tail of the cwd fallback chain, used only when target node is `'local'`). */
  defaultCwd: string
  /** Whether this is a same-Profile fork (if true, parent conversation nodeId/cwd take precedence over Profile defaults). */
  forkSameProfile?: boolean
  /** Platform normalization closure: `normalize(rawCwd, nodeId) -> normalizedCwd` (throws if invalid). */
  normalize: (cwd: string, nodeId: string) => string
}

interface SpawnTargetChain {
  nodeId: string
  sourceCwd: string
}

/** Pure node-chain resolution (shared by external runtimes such as Herdr and kernel for identical fallback semantics). */
export function resolveSpawnTargetNodeId(
  profileNodeId: string | undefined,
  parentNodeId: string | undefined,
  forkSameProfile?: boolean,
  requestNodeId?: string,
): string {
  if (requestNodeId !== undefined) return requestNodeId
  return forkSameProfile === true
    ? (parentNodeId ?? profileNodeId ?? 'local')
    : (profileNodeId ?? parentNodeId ?? 'local')
}

/** Full chain resolution: node + cross-node cwd isolation + platform-normalized source cwd. */
export function resolveSpawnTargetChain(input: SpawnTargetChainInput): SpawnTargetChain {
  const nodeId = resolveSpawnTargetNodeId(
    input.profileNodeId,
    input.parentNodeId,
    input.forkSameProfile,
    input.requestNodeId,
  )
  const usableProfileCwd =
    input.profileNodeId === undefined || input.profileNodeId === nodeId ? input.profileCwd : undefined
  const usableParentCwd = (input.parentNodeId ?? 'local') === nodeId ? input.parentCwd : undefined
  const fallbackDefaultCwd = nodeId === 'local' ? input.defaultCwd : undefined
  const rawCwd =
    input.forkSameProfile === true
      ? (input.requestCwd ?? usableParentCwd ?? usableProfileCwd ?? fallbackDefaultCwd)
      : (input.requestCwd ?? usableProfileCwd ?? usableParentCwd ?? fallbackDefaultCwd)
  if (rawCwd === undefined) {
    throw new HelmxError(
      'validation_error',
      `spawn targets remote node '${nodeId}' without a cwd (request.cwd, compatible Profile.cwd, and same-node parent cwd are all unavailable; specify cwd explicitly)`,
      400,
      { nodeId },
    )
  }
  return { nodeId, sourceCwd: input.normalize(rawCwd, nodeId) }
}
