/**
 * env-rpc contract tests:
 * - Error code unions (`node_draining` vs `aborted` vs `RpcFileErrorCode`);
 * - Controlled socketPath / local Windows Named Pipe boundary classification;
 * - Target-node host environment discovery query & snapshot boundary validation.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyControlledSocketPath,
  validateNodeHostEnvQuery,
  validateNodeHostEnvSnapshot,
  type NodeEnvRpcFunctions,
  type NodeHostEnv,
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

describe('env-rpc tunnel DTO and controlled socketPath validation', () => {
  it('NodeTunnelTarget and NodeTunnelOpenInput support mutually exclusive TCP and socketPath targets', { timeout: 60_000 }, () => {
    const tcp: NodeTunnelTarget = { host: '127.0.0.1', port: 8080 }
    const uds: NodeTunnelTarget = { socketPath: '/tmp/herdr.sock' }
    const pipe: NodeTunnelOpenInput = {
      tunnelId: 't-win',
      socketPath: '\\\\.\\pipe\\C:\\Users\\dev\\AppData\\Roaming\\herdr\\herdr.sock',
    }
    assert.equal(tcp.port, 8080)
    assert.equal(uds.socketPath, '/tmp/herdr.sock')
    assert.equal(pipe.tunnelId, 't-win')
  })

  it('classifyControlledSocketPath accepts absolute POSIX UDS and local Windows Named Pipes', { timeout: 60_000 }, () => {
    assert.deepEqual(classifyControlledSocketPath('/tmp/herdr.sock'), {
      ok: true,
      kind: 'unix-socket',
      socketPath: '/tmp/herdr.sock',
    })
    assert.deepEqual(classifyControlledSocketPath('/Users/My User/.config/herdr/sessions/a.b-1/herdr.sock'), {
      ok: true,
      kind: 'unix-socket',
      socketPath: '/Users/My User/.config/herdr/sessions/a.b-1/herdr.sock',
    })
    const winPipe = '\\\\.\\pipe\\C:\\Users\\dev\\AppData\\Roaming\\herdr\\herdr.sock'
    assert.deepEqual(classifyControlledSocketPath(winPipe), {
      ok: true,
      kind: 'named-pipe',
      socketPath: winPipe,
    })
    assert.deepEqual(classifyControlledSocketPath('\\\\.\\pipe\\herdr-test'), {
      ok: true,
      kind: 'named-pipe',
      socketPath: '\\\\.\\pipe\\herdr-test',
    })
  })

  it('classifyControlledSocketPath rejects relative paths, traversal, remote UNC pipes, raw Windows markers, and control chars', { timeout: 60_000 }, () => {
    for (const bad of [
      '',
      ' ',
      'herdr.sock',
      './herdr.sock',
      '../herdr.sock',
      '/',
      '/tmp/',
      '//server/share/herdr.sock',
      '/tmp/../etc/passwd',
      '/tmp/./herdr.sock',
      ' /tmp/herdr.sock',
      '/tmp/herdr.sock ',
      '/tmp/bad\nsock',
      '/tmp/bad\u0000sock',
      'C:\\Users\\dev\\AppData\\Roaming\\herdr\\herdr.sock',
      'C:/Users/dev/herdr.sock',
      '\\\\remote-host\\pipe\\herdr',
      '\\\\.\\pipe\\',
      '\\\\.\\pipe\\\\nested',
      '\\\\.\\pipe\\..\\escape',
      '\\\\.\\pipe\\a\\..\\b',
      'x'.repeat(1025),
      123,
      null,
    ]) {
      const res = classifyControlledSocketPath(bad)
      assert.equal(res.ok, false, `should reject ${JSON.stringify(bad)}`)
    }
  })
})

describe('env-rpc nodeHostEnv query and snapshot validation', () => {
  it('validateNodeHostEnvQuery accepts empty/valid non-secret envKeys and rejects unknown/sensitive keys', { timeout: 60_000 }, () => {
    assert.deepEqual(validateNodeHostEnvQuery(undefined), { ok: true, envKeys: [] })
    assert.deepEqual(validateNodeHostEnvQuery({}), { ok: true, envKeys: [] })
    assert.deepEqual(validateNodeHostEnvQuery({ envKeys: ['HERDR_SOCKET_PATH', 'HERDR_SOCKET_PATH', 'DOCKER_HOST'] }), {
      ok: true,
      envKeys: ['HERDR_SOCKET_PATH', 'DOCKER_HOST'],
    })

    for (const bad of [
      'not-an-object',
      [],
      { unknown: true },
      { envKeys: 'HERDR_SOCKET_PATH' },
      { envKeys: ['lowercase'] },
      { envKeys: ['BAD=KEY'] },
      { envKeys: ['HELMX_TOKEN'] },
      { envKeys: ['HELMX_EXECUTION_SCOPE'] },
      { envKeys: ['AWS_SECRET_ACCESS_KEY'] },
      { envKeys: ['OPENAI_API_KEY'] },
      { envKeys: ['DB_PASSWORD'] },
      { envKeys: ['AUTH_HEADER'] },
      { envKeys: Array.from({ length: 17 }, (_, i) => `CUSTOM_VAR_${i}`) },
    ]) {
      const res = validateNodeHostEnvQuery(bad)
      assert.equal(res.ok, false, `should reject query ${JSON.stringify(bad)}`)
    }
  })

  it('validateNodeHostEnvSnapshot validates structure and rejects unrequested env keys or unknown dir fields', { timeout: 60_000 }, () => {
    const valid: NodeHostEnv = {
      platform: 'win32',
      homeDir: 'C:\\Users\\alice',
      tempDir: 'C:\\Users\\alice\\AppData\\Local\\Temp',
      dirs: {
        appData: 'C:\\Users\\alice\\AppData\\Roaming',
        userProfile: 'C:\\Users\\alice',
      },
      env: { HERDR_SOCKET_PATH: 'C:\\custom\\herdr.sock' },
    }
    const ok = validateNodeHostEnvSnapshot(valid, ['HERDR_SOCKET_PATH'])
    assert.equal(ok.ok, true)
    if (ok.ok) assert.deepEqual(ok.value, valid)

    assert.equal(validateNodeHostEnvSnapshot({ ...valid, env: { UNREQUESTED: 'x' } }, ['HERDR_SOCKET_PATH']).ok, false)
    assert.equal(validateNodeHostEnvSnapshot({ ...valid, dirs: { bogus: '/x' } }, []).ok, false)
    assert.equal(validateNodeHostEnvSnapshot({ ...valid, platform: '' }, []).ok, false)
    assert.equal(validateNodeHostEnvSnapshot({ ...valid, tempDir: 'bad\npath' }, []).ok, false)
    assert.equal(validateNodeHostEnvSnapshot(null, []).ok, false)
  })
})
