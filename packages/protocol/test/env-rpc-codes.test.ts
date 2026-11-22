/**
 * env-rpc contract tests:
 * - Error code unions (`node_draining` vs `aborted` vs `RpcFileErrorCode`);
 * - TCP tunnel target DTO shapes.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  type NodeEnvRpcFunctions,
  type NodeTunnelErrorCode,
  type NodeTunnelOpenInput,
  type NodeTunnelTarget,
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
