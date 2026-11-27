/**
 * Hub reachable endpoint discovery (`buildHubAccessInfo`) and HTTP route projection tests:
 * - Wildcard `0.0.0.0` (IPv4 NICs + OS hostname + virtual bridges + loopback fallback, skips APIPA/IPv6/link-local)
 * - Wildcard `::` (IPv4 + global/ULA IPv6 + OS hostname, skips link-local fe80::)
 * - Specific bound IP (only that IP with matched NIC + OS hostname, excludes unrelated NICs)
 * - Specific bound hostname (bound hostname + resolved socket IP + OS hostname)
 * - Loopback-only (`127.0.0.1` / `::1` / `localhost`, `loopbackOnly: true`, never fabricates LAN IPs)
 * - Live `startHub` integration (`GET /api/nodes` `local.hubAccess` + `POST /api/nodes/issue` `hubAccess`)
 */
import assert from 'node:assert/strict'
import type { NetworkInterfaceInfo } from 'node:os'
import { test } from 'node:test'
import { useTempDir } from '@helmx/test-kit/node'
import { KernelRuntime } from '../src/runtime/index.js'
import { buildHubAccessInfo, isUsableFqdn, parseHostsFileForFqdn, resolveHostFqdn } from '../src/runtime/hub-access.js'
import { startHub } from '../src/http/index.js'
import { makeFauxModels } from './helpers.js'

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: internal ? '255.0.0.0' : '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/${internal ? 8 : 24}`,
  }
}

function ipv6(address: string, internal = false, scopeid = 0): NetworkInterfaceInfo {
  return {
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: '00:00:00:00:00:00',
    internal,
    scopeid,
    cidr: `${address}/64`,
  }
}

const SAMPLE_INTERFACES: NodeJS.Dict<NetworkInterfaceInfo[]> = {
  lo: [ipv4('127.0.0.1', true), ipv6('::1', true)],
  docker0: [ipv4('172.17.0.1')],
  'br-deadbeef': [ipv4('172.22.0.1')],
  eth0: [
    ipv4('192.168.1.10'),
    ipv4('172.16.0.5'),
    ipv4('169.254.1.2'),
    ipv6('fd00::1'),
    ipv6('fe80::1%eth0', false, 2),
  ],
  tailscale0: [ipv4('100.88.1.5')],
  eth1: [ipv4('203.0.113.10')],
}

test('buildHubAccessInfo wildcard 0.0.0.0: sorts reachable IPv4 + hostname + virtual + loopback', { timeout: 60_000 }, () => {
  const info = buildHubAccessInfo({
    listen: { host: '0.0.0.0', port: 3202 },
    interfaces: SAMPLE_INTERFACES,
    osHostname: 'dev-box.local',
  })
  assert.ok(info !== undefined)
  assert.equal(info.listenHost, '0.0.0.0')
  assert.equal(info.listenPort, 3202)
  assert.equal(info.wildcard, true)
  assert.equal(info.loopbackOnly, false)

  assert.deepEqual(info.endpoints, [
    { url: 'http://192.168.1.10:3202', host: '192.168.1.10', kind: 'lan', interface: 'eth0' },
    { url: 'http://172.16.0.5:3202', host: '172.16.0.5', kind: 'lan', interface: 'eth0' },
    { url: 'http://100.88.1.5:3202', host: '100.88.1.5', kind: 'vpn', interface: 'tailscale0' },
    { url: 'http://203.0.113.10:3202', host: '203.0.113.10', kind: 'public', interface: 'eth1' },
    { url: 'http://dev-box.local:3202', host: 'dev-box.local', kind: 'hostname' },
    { url: 'http://172.22.0.1:3202', host: '172.22.0.1', kind: 'virtual', interface: 'br-deadbeef' },
    { url: 'http://172.17.0.1:3202', host: '172.17.0.1', kind: 'virtual', interface: 'docker0' },
    { url: 'http://127.0.0.1:3202', host: '127.0.0.1', kind: 'loopback' },
  ])
})

test('buildHubAccessInfo wildcard ::: includes IPv4 and global/ULA IPv6 while skipping link-local fe80::', { timeout: 60_000 }, () => {
  const info = buildHubAccessInfo({
    listen: { host: '::', port: 3202 },
    interfaces: {
      lo: [ipv4('127.0.0.1', true), ipv6('::1', true)],
      eth0: [ipv4('192.168.1.10'), ipv6('fd00::1'), ipv6('fe80::1234%eth0', false, 2)],
    },
    osHostname: 'dev-box',
  })
  assert.ok(info !== undefined)
  assert.equal(info.wildcard, true)
  assert.equal(info.loopbackOnly, false)
  assert.deepEqual(info.endpoints, [
    { url: 'http://192.168.1.10:3202', host: '192.168.1.10', kind: 'lan', interface: 'eth0' },
    { url: 'http://dev-box:3202', host: 'dev-box', kind: 'hostname' },
    { url: 'http://[fd00::1]:3202', host: 'fd00::1', kind: 'ipv6', interface: 'eth0' },
    { url: 'http://127.0.0.1:3202', host: '127.0.0.1', kind: 'loopback' },
  ])
})

test('buildHubAccessInfo specific non-loopback IP: exposes only bound IP + matched NIC + OS hostname', { timeout: 60_000 }, () => {
  const lan = buildHubAccessInfo({
    listen: { host: '192.168.1.10', port: 3202 },
    interfaces: SAMPLE_INTERFACES,
    osHostname: 'dev-box.local',
  })
  assert.ok(lan !== undefined)
  assert.equal(lan.wildcard, false)
  assert.equal(lan.loopbackOnly, false)
  assert.deepEqual(lan.endpoints, [
    { url: 'http://192.168.1.10:3202', host: '192.168.1.10', kind: 'lan', interface: 'eth0' },
    { url: 'http://dev-box.local:3202', host: 'dev-box.local', kind: 'hostname' },
  ])

  const vpn = buildHubAccessInfo({
    listen: { host: '100.88.1.5', port: 3202 },
    interfaces: SAMPLE_INTERFACES,
    osHostname: 'dev-box.local',
  })
  assert.deepEqual(vpn?.endpoints, [
    { url: 'http://100.88.1.5:3202', host: '100.88.1.5', kind: 'vpn', interface: 'tailscale0' },
    { url: 'http://dev-box.local:3202', host: 'dev-box.local', kind: 'hostname' },
  ])

  const v6 = buildHubAccessInfo({
    listen: { host: '[fd00::1]', port: 3202 },
    interfaces: SAMPLE_INTERFACES,
    osHostname: 'localhost',
  })
  assert.deepEqual(v6?.endpoints, [
    { url: 'http://[fd00::1]:3202', host: 'fd00::1', kind: 'ipv6', interface: 'eth0' },
  ])
})

test('buildHubAccessInfo specific hostname: exposes bound hostname, resolved socket IP, and OS hostname', { timeout: 60_000 }, () => {
  const info = buildHubAccessInfo({
    listen: { host: 'hub.lan', resolvedAddress: '192.168.1.10', port: 3202 },
    interfaces: SAMPLE_INTERFACES,
    osHostname: 'dev-box.local',
  })
  assert.ok(info !== undefined)
  assert.equal(info.wildcard, false)
  assert.equal(info.loopbackOnly, false)
  assert.deepEqual(info.endpoints, [
    { url: 'http://192.168.1.10:3202', host: '192.168.1.10', kind: 'lan', interface: 'eth0' },
    { url: 'http://hub.lan:3202', host: 'hub.lan', kind: 'hostname' },
    { url: 'http://dev-box.local:3202', host: 'dev-box.local', kind: 'hostname' },
  ])
})

test('buildHubAccessInfo loopback-only: sets loopbackOnly=true and never fabricates LAN IPs or hostname', { timeout: 60_000 }, () => {
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    const info = buildHubAccessInfo({
      listen: { host, port: 3202 },
      interfaces: SAMPLE_INTERFACES,
      osHostname: 'dev-box.local',
    })
    assert.ok(info !== undefined)
    assert.equal(info.wildcard, false)
    assert.equal(info.loopbackOnly, true)
    assert.equal(info.endpoints.length, 1)
    assert.equal(info.endpoints[0]?.kind, 'loopback')
    assert.equal(info.endpoints[0]?.host, host)
  }
})

test('startHub integration: GET /api/nodes local.hubAccess and POST /api/nodes/issue hubAccess reflect real listener', { timeout: 60_000 }, async (t) => {
  const { models } = makeFauxModels()
  // 1. Loopback listener
  const dir1 = useTempDir(t, 'helmx-hub-access-lo-')
  const kernel1 = await KernelRuntime.open({
    dataDir: dir1,
    cwd: dir1,
    model: 'faux/faux-1',
    models: models as never,
    autoResume: false,
  })
  const hub1 = await startHub({ kernel: kernel1, port: 0, hostname: '127.0.0.1' })
  try {
    await kernel1.start()
    const setupRes1 = await fetch(`${hub1.url}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'hub-access-test-pass' }),
    })
    assert.equal(setupRes1.status, 200)
    const { token: authToken1 } = (await setupRes1.json()) as { token: string }
    const headers1 = { 'content-type': 'application/json', authorization: `Bearer ${authToken1}` }

    const actualPort = new URL(hub1.url).port
    const nodesRes = await fetch(`${hub1.url}/api/nodes`, { headers: headers1 })
    assert.equal(nodesRes.status, 200)
    const nodes = (await nodesRes.json()) as Array<{ id: string; hubAccess?: { listenHost: string; listenPort: number; loopbackOnly: boolean; wildcard: boolean; endpoints: Array<{ url: string; kind: string }> } }>
    const local1 = nodes.find((n) => n.id === 'local')
    assert.ok(local1?.hubAccess !== undefined)
    assert.equal(local1.hubAccess.listenHost, '127.0.0.1')
    assert.equal(local1.hubAccess.listenPort, Number(actualPort))
    assert.equal(local1.hubAccess.loopbackOnly, true)
    assert.equal(local1.hubAccess.wildcard, false)
    assert.deepEqual(local1.hubAccess.endpoints, [
      { url: `http://127.0.0.1:${actualPort}`, host: '127.0.0.1', kind: 'loopback' },
    ])

    const issueRes = await fetch(`${hub1.url}/api/nodes/issue`, {
      method: 'POST',
      headers: headers1,
      body: JSON.stringify({ nodeId: 'worker-lo' }),
    })
    assert.equal(issueRes.status, 201)
    const issued = (await issueRes.json()) as { nodeId: string; token: string; hubAccess?: { listenHost: string; listenPort: number; loopbackOnly: boolean } }
    assert.equal(issued.nodeId, 'worker-lo')
    assert.ok(issued.token.startsWith('worker-lo:'))
    assert.equal(issued.hubAccess?.listenHost, '127.0.0.1')
    assert.equal(issued.hubAccess?.listenPort, Number(actualPort))
    assert.equal(issued.hubAccess?.loopbackOnly, true)
  } finally {
    await hub1.close()
    await kernel1.close()
  }

  // 2. Wildcard 0.0.0.0 listener
  const dir2 = useTempDir(t, 'helmx-hub-access-any-')
  const kernel2 = await KernelRuntime.open({
    dataDir: dir2,
    cwd: dir2,
    model: 'faux/faux-1',
    models: models as never,
    autoResume: false,
  })
  const hub2 = await startHub({ kernel: kernel2, port: 0, hostname: '0.0.0.0' })
  try {
    await kernel2.start()
    const actualPort = new URL(hub2.url).port
    const base = `http://127.0.0.1:${actualPort}`
    const setupRes2 = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'hub-access-test-pass' }),
    })
    assert.equal(setupRes2.status, 200)
    const { token: authToken2 } = (await setupRes2.json()) as { token: string }
    const headers2 = { 'content-type': 'application/json', authorization: `Bearer ${authToken2}` }

    const nodesRes = await fetch(`${base}/api/nodes`, { headers: headers2 })
    assert.equal(nodesRes.status, 200)
    const nodes = (await nodesRes.json()) as Array<{ id: string; hubAccess?: { listenHost: string; listenPort: number; loopbackOnly: boolean; wildcard: boolean; endpoints: Array<{ url: string; kind: string }> } }>
    const local2 = nodes.find((n) => n.id === 'local')
    assert.ok(local2?.hubAccess !== undefined)
    assert.equal(local2.hubAccess.listenHost, '0.0.0.0')
    assert.equal(local2.hubAccess.listenPort, Number(actualPort))
    assert.equal(local2.hubAccess.wildcard, true)
    assert.equal(local2.hubAccess.loopbackOnly, false)
    assert.ok(
      local2.hubAccess.endpoints.some((e) => e.kind === 'loopback' && e.url === `http://127.0.0.1:${actualPort}`),
    )
    assert.ok(
      local2.hubAccess.endpoints.every((e) => e.url.endsWith(`:${actualPort}`)),
    )

    const issueRes = await fetch(`${base}/api/nodes/issue`, {
      method: 'POST',
      headers: headers2,
      body: JSON.stringify({ nodeId: 'worker-any' }),
    })
    assert.equal(issueRes.status, 201)
    const issued = (await issueRes.json()) as { nodeId: string; token: string; hubAccess?: { listenHost: string; listenPort: number; wildcard: boolean } }
    assert.ok(issued.token.startsWith('worker-any:'))
    assert.equal(issued.hubAccess?.listenHost, '0.0.0.0')
    assert.equal(issued.hubAccess?.listenPort, Number(actualPort))
    assert.equal(issued.hubAccess?.wildcard, true)
  } finally {
    await hub2.close()
    await kernel2.close()
  }
})

test('parseHostsFileForFqdn & resolveHostFqdn: discovers canonical FQDN via hosts/DNS/Win32 while rejecting stubs', { timeout: 60_000 }, async () => {
  // 1. parseHostsFileForFqdn skips comments & loopback stubs, preferring `<shortHost>.<domain>`
  const hosts = [
    '127.0.0.1 localhost localhost.localdomain',
    '# 127.0.1.1 ignored-comment.example.com code2',
    '127.0.1.1 code2.fjay.top code2',
  ].join('\n')
  assert.equal(parseHostsFileForFqdn(hosts, 'code2'), 'code2.fjay.top')
  assert.equal(parseHostsFileForFqdn('127.0.0.1 localhost localhost.localdomain\n', 'localhost'), undefined)
  assert.equal(isUsableFqdn('dev-box.local'), true)
  assert.equal(isUsableFqdn('localhost.localdomain'), false)
  assert.equal(isUsableFqdn('node.localdomain.'), false)

  // 2. os.hostname() already carrying an FQDN returns immediately without touching hosts/DNS
  let dnsCalled = false
  let hostsCalled = false
  assert.equal(
    await resolveHostFqdn({
      osHostname: () => 'host.example.com.',
      readHostsFile: async () => {
        hostsCalled = true
        return ''
      },
      lookup: async () => {
        dnsCalled = true
        return []
      },
    }),
    'host.example.com',
  )
  assert.equal(hostsCalled, false)
  assert.equal(dnsCalled, false)

  // 3. /etc/hosts FQDN resolution wins over DNS
  assert.equal(
    await resolveHostFqdn({
      platform: 'linux',
      osHostname: () => 'code2',
      readHostsFile: async () => '127.0.1.1 code2.fjay.top code2\n',
      lookup: async () => {
        throw new Error('DNS should not run when /etc/hosts already matched')
      },
    }),
    'code2.fjay.top',
  )

  // 4. DNS lookup + lookupService canonical reverse resolution fallback
  assert.equal(
    await resolveHostFqdn({
      platform: 'linux',
      osHostname: () => 'code2',
      readHostsFile: async () => '127.0.0.1 localhost\n',
      lookup: async () => [{ address: '192.168.1.20', family: 4 }],
      lookupService: async () => ({ hostname: 'code2.corp.internal.', service: '0' }),
    }),
    'code2.corp.internal',
  )

  // 5. Win32 USERDNSDOMAIN fallback
  assert.equal(
    await resolveHostFqdn({
      platform: 'win32',
      osHostname: () => 'workstation',
      lookup: async () => [],
      env: { USERDNSDOMAIN: 'office.example.net' },
    }),
    'workstation.office.example.net',
  )

  // 6. Bounded timeout on slow DNS lookup fails open to undefined without hanging
  assert.equal(
    await resolveHostFqdn({
      platform: 'linux',
      osHostname: () => 'slowbox',
      readHostsFile: async () => '',
      lookup: () => new Promise(() => undefined),
      timeoutMs: 25,
    }),
    undefined,
  )
})

test('buildHubAccessInfo hostFqdn: prefers valid FQDN over short osHostname and ignores loopback stubs', { timeout: 60_000 }, () => {
  const wildcard = buildHubAccessInfo({
    listen: { host: '0.0.0.0', port: 3202 },
    interfaces: { eth0: [ipv4('192.168.1.10')] },
    osHostname: 'code2',
    hostFqdn: 'code2.fjay.top',
  })
  assert.deepEqual(
    wildcard?.endpoints.filter((e) => e.kind === 'hostname'),
    [{ url: 'http://code2.fjay.top:3202', host: 'code2.fjay.top', kind: 'hostname' }],
  )

  const specificIp = buildHubAccessInfo({
    listen: { host: '192.168.1.10', port: 3202 },
    interfaces: { eth0: [ipv4('192.168.1.10')] },
    osHostname: 'code2',
    hostFqdn: 'code2.fjay.top',
  })
  assert.deepEqual(
    specificIp?.endpoints.filter((e) => e.kind === 'hostname'),
    [{ url: 'http://code2.fjay.top:3202', host: 'code2.fjay.top', kind: 'hostname' }],
  )

  const stubRejected = buildHubAccessInfo({
    listen: { host: '0.0.0.0', port: 3202 },
    interfaces: { eth0: [ipv4('192.168.1.10')] },
    osHostname: 'code2',
    hostFqdn: 'localhost.localdomain',
  })
  assert.deepEqual(
    stubRejected?.endpoints.filter((e) => e.kind === 'hostname'),
    [{ url: 'http://code2:3202', host: 'code2', kind: 'hostname' }],
  )
})
