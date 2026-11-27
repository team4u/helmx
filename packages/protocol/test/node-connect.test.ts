import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertSchemaCompilable,
  CORE_CLI_COMMAND_PATHS,
  NODE_CORE_OPERATIONS,
  buildNodeConnectGuide,
  formatHubListenSummary,
  isLoopbackHubUrl,
  resolveDefaultHubUrl,
} from '../src/index.js'

test('node-connect: buildNodeConnectGuide formats normal URLs/tokens & placeholders unquoted and single-quotes special chars', { timeout: 60_000 }, () => {
  const normal = buildNodeConnectGuide('https://hub.example.com:3202/', {
    nodeId: 'gpu-1',
    token: 'gpu-1:sec_abc-123',
  })
  assert.equal(normal.hubUrl, 'https://hub.example.com:3202')
  assert.equal(normal.loopbackWarning, false)
  assert.equal(normal.installCommand, 'npm install -g @helmx/node')
  assert.equal(normal.oneLineCommand, 'helmx-node start -d --hub https://hub.example.com:3202 --token gpu-1:sec_abc-123')
  assert.equal(normal.connectCommand, 'helmx-node connect https://hub.example.com:3202 --token gpu-1:sec_abc-123')
  assert.equal(normal.startDaemonCommand, 'helmx-node start -d')
  assert.equal(normal.serviceInstallCommand, 'helmx-node service install')
  assert.equal(normal.doctorCommand, 'helmx-node doctor')

  const placeholder = buildNodeConnectGuide('<HUB_URL>', { nodeId: 'gpu-1', token: '<TOKEN>' })
  assert.equal(placeholder.hubUrl, '<HUB_URL>')
  assert.equal(placeholder.loopbackWarning, false)
  assert.equal(placeholder.oneLineCommand, 'helmx-node start -d --hub <HUB_URL> --token <TOKEN>')
  assert.equal(placeholder.connectCommand, 'helmx-node connect <HUB_URL> --token <TOKEN>')

  const ipv6 = buildNodeConnectGuide('http://[::1]:3202/', { nodeId: 'gpu-1', token: 'gpu-1:sec' })
  assert.equal(ipv6.hubUrl, 'http://[::1]:3202')
  assert.equal(ipv6.loopbackWarning, true)
  assert.equal(ipv6.oneLineCommand, "helmx-node start -d --hub 'http://[::1]:3202' --token gpu-1:sec")

  const special = buildNodeConnectGuide('https://hub.example.com/a?x=1&y=2', {
    nodeId: 'gpu-1',
    token: "tok'with space",
  })
  assert.equal(special.oneLineCommand, "helmx-node start -d --hub 'https://hub.example.com/a?x=1&y=2' --token 'tok'\\''with space'")
})

test('node-connect: loopback detection, listen summary formatting, and default URL selection', { timeout: 60_000 }, () => {
  assert.equal(isLoopbackHubUrl('http://127.0.0.1:3202'), true)
  assert.equal(isLoopbackHubUrl('http://localhost:3202'), true)
  assert.equal(isLoopbackHubUrl('http://[::1]:3202'), true)
  assert.equal(isLoopbackHubUrl('http://192.168.1.10:3202'), false)
  assert.equal(isLoopbackHubUrl('<HUB_URL>'), false)

  assert.equal(
    formatHubListenSummary({ listenHost: '::', listenPort: 3202, wildcard: true, loopbackOnly: false, endpoints: [] }),
    '[::]:3202',
  )
  assert.equal(
    formatHubListenSummary({ listenHost: '0.0.0.0', listenPort: 3202, wildcard: true, loopbackOnly: false, endpoints: [] }),
    '0.0.0.0:3202',
  )

  assert.equal(
    resolveDefaultHubUrl({
      listenHost: '0.0.0.0',
      listenPort: 3202,
      wildcard: true,
      loopbackOnly: false,
      endpoints: [
        { url: 'http://127.0.0.1:3202', host: '127.0.0.1', kind: 'loopback' },
        { url: 'http://192.168.1.20:3202/', host: '192.168.1.20', kind: 'lan' },
      ],
    }, 'http://127.0.0.1:3202'),
    'http://192.168.1.20:3202',
  )
  assert.equal(
    resolveDefaultHubUrl({
      listenHost: '127.0.0.1',
      listenPort: 3202,
      wildcard: false,
      loopbackOnly: true,
      endpoints: [{ url: 'http://127.0.0.1:3202/', host: '127.0.0.1', kind: 'loopback' }],
    }),
    'http://127.0.0.1:3202',
  )
  assert.equal(resolveDefaultHubUrl(undefined, 'http://10.0.0.5:3202/'), 'http://10.0.0.5:3202')
  assert.equal(resolveDefaultHubUrl(undefined), '<HUB_URL>')
})

test('core-ops/nodes: declarative NODE_CORE_OPERATIONS specs stay structurally valid and security-compliant', { timeout: 60_000 }, () => {
  assert.equal(NODE_CORE_OPERATIONS.length, 9)

  const seenKeys = new Set<string>()
  const seenHttpRoutes = new Set<string>()
  const cliPathSet = new Set<string>(CORE_CLI_COMMAND_PATHS)

  for (const op of NODE_CORE_OPERATIONS) {
    assert.ok(!seenKeys.has(op.key), `duplicate key: ${op.key}`)
    seenKeys.add(op.key)

    const httpRoute = `${op.http.method} ${op.http.path}`
    assert.ok(!seenHttpRoutes.has(httpRoute), `duplicate HTTP route: ${httpRoute}`)
    seenHttpRoutes.add(httpRoute)

    assertSchemaCompilable(op.inputSchema)
    assertSchemaCompilable(op.outputSchema)
    assert.ok(cliPathSet.has(op.cli.command.join(' ')), `CLI command missing in CORE_CLI_COMMAND_PATHS: ${op.cli.command.join(' ')}`)
  }

  const issue = NODE_CORE_OPERATIONS.find((op) => op.key === 'nodes.issue')
  assert.ok(issue)
  assert.equal(issue.action, false)
  assert.equal(issue.http.status, 201)
  assert.equal(issue.http.redactResponse, false)
  assert.deepEqual(issue.http.responseHeaders, { 'cache-control': 'no-store' })
})
