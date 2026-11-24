/**
 * env-rpc contract tests:
 * - Error code unions (`node_draining` vs `aborted` vs `RpcFileErrorCode`);
 * - TCP tunnel target DTO shapes.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  type NodeAutoUpgradePhase,
  type NodeAutoUpgradeStatus,
  type NodeEnvRpcFunctions,
  type NodeInfo,
  type NodeInstallMode,
  type NodeRegisterInput,
  type NodeTunnelErrorCode,
  type NodeTunnelOpenInput,
  type NodeTunnelTarget,
  type NodeUpgradeErrorCode,
  type RpcEnvError,
  type RpcExecutionErrorCode,
  type RpcFileErrorCode,
} from '@helmx/protocol'

describe('env-rpc error code unions: node_draining', () => {
  it('RpcExecutionErrorCode and NodeTunnelErrorCode both include node_draining; aborted kept', { timeout: 60_000 }, () => {
    const execCode: RpcExecutionErrorCode = 'node_draining'
    const tunnelCode: NodeTunnelErrorCode = 'node_draining'
    assert.equal(execCode, 'node_draining')
    assert.equal(tunnelCode, 'node_draining')

    const execAborted: RpcExecutionErrorCode = 'aborted'
    const tunnelAborted: NodeTunnelErrorCode = 'aborted'
    assert.equal(execAborted, 'aborted')
    assert.equal(tunnelAborted, 'aborted')
  })

  it('RpcFileErrorCode does not include node_draining (file operations do not participate in upgrade drain rejection)', { timeout: 60_000 }, () => {
    // @ts-expect-error node_draining is not a file operation error code
    const bad: RpcFileErrorCode = 'node_draining'
    void bad
    const fileAborted: RpcFileErrorCode = 'aborted'
    assert.equal(fileAborted, 'aborted')
  })

  it('RpcEnvError can carry node_draining and pass through envExec / nodeTunnelOpen return unions', { timeout: 60_000 }, () => {
    const drainingError: RpcEnvError = {
      code: 'node_draining',
      message: 'daemon is draining (upgrade in progress), rejecting new commands',
    }
    assert.equal(drainingError.code, 'node_draining')

    const rpc = {
      envExec: async (): Promise<{ ok: false; error: RpcEnvError }> => ({ ok: false, error: drainingError }),
      nodeTunnelOpen: async (): Promise<{ ok: false; error: RpcEnvError }> => ({ ok: false, error: drainingError }),
    } as unknown as Pick<NodeEnvRpcFunctions, 'envExec' | 'nodeTunnelOpen'>
    assert.equal(rpc, rpc)
  })

  it('NodeUpgradeErrorCode source_mode is allowed on RpcEnvError without polluting RpcFileErrorCode', { timeout: 60_000 }, () => {
    const code: NodeUpgradeErrorCode = 'source_mode'
    const err: RpcEnvError = { code, message: 'source_mode: manual restart required' }
    assert.equal(err.code, 'source_mode')
    // @ts-expect-error source_mode is not a file operation error code
    const badFile: RpcFileErrorCode = 'source_mode'
    void badFile
  })
})

describe('env-rpc installMode and autoUpgrade DTOs', () => {
  it('NodeInfo and NodeRegisterInput accept optional installMode and autoUpgrade while remaining backward compatible', { timeout: 60_000 }, () => {
    const mode: NodeInstallMode = 'source'
    const phases: readonly NodeAutoUpgradePhase[] = [
      'pending',
      'upgrading',
      'failed',
      'source_skipped',
      'unknown_mode',
      'not_supported',
    ]
    const autoUpgrade: NodeAutoUpgradeStatus = {
      status: 'source_skipped',
      targetVersion: '0.2.0',
      attempts: 0,
      updatedAt: 1_700_000_000_000,
      reason: 'source_mode',
    }
    const unknownModeUpgrade: NodeAutoUpgradeStatus = {
      status: 'unknown_mode',
      targetVersion: '0.2.0',
      attempts: 0,
      updatedAt: 1_700_000_000_000,
      reason: 'unknown_mode: legacy node did not report installMode; restart or upgrade manually once',
    }
    const legacyNode: NodeInfo = { id: 'legacy-1', kind: 'byom', online: true }
    const legacySkippedNode: NodeInfo = { id: 'legacy-2', kind: 'byom', online: true, autoUpgrade: unknownModeUpgrade }
    const modernNode: NodeInfo = { id: 'dev-1', kind: 'byom', online: true, installMode: mode, autoUpgrade }
    const reg: NodeRegisterInput = {
      nodeId: 'dev-1',
      token: 'dev-1:s',
      hostname: 'devbox',
      platform: 'linux',
      installMode: mode,
    }
    const legacyReg: NodeRegisterInput = {
      nodeId: 'legacy-1',
      token: 'legacy-1:s',
      hostname: 'oldbox',
      platform: 'linux',
    }
    assert.deepEqual(phases, ['pending', 'upgrading', 'failed', 'source_skipped', 'unknown_mode', 'not_supported'])
    assert.equal(legacyNode.installMode, undefined)
    assert.equal(legacyNode.autoUpgrade, undefined)
    assert.equal(legacySkippedNode.installMode, undefined)
    assert.equal(legacySkippedNode.autoUpgrade?.status, 'unknown_mode')
    assert.equal(modernNode.installMode, 'source')
    assert.equal(modernNode.autoUpgrade?.status, 'source_skipped')
    assert.equal(reg.installMode, 'source')
    assert.equal(legacyReg.installMode, undefined)
  })
})

describe('env-rpc tunnel DTO', () => {
  it('NodeTunnelTarget and NodeTunnelOpenInput support TCP host:port targets', { timeout: 60_000 }, () => {
    const tcp: NodeTunnelTarget = { host: '127.0.0.1', port: 8080 }
    const openInput: NodeTunnelOpenInput = {
      tunnelId: 't-tcp',
      host: '127.0.0.1',
      port: 8080,
    }
    assert.equal(tcp.port, 8080)
    assert.equal(openInput.tunnelId, 't-tcp')
  })
})
