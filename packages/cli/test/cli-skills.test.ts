/**
 * CLI tests for `skills list/read` scoping flags (`--current`, `--node`+`--cwd`):
 * - No scope flags keeps the Hub global semantics (GET /api/skills).
 * - --current reads HELMX_CONVERSATION_ID, resolves the conversation's (nodeId, cwd) via
 *   GET /api/conversations/:id, then calls GET /api/skills/scoped/catalog or GET /api/skills/:id
 *   with explicit coordinates only; missing env / missing workspace cwd fail explicitly.
 * - Explicit --node+--cwd travel in query parameters verbatim (trusted CLI surface).
 * - Local validation: --node/--cwd pair enforcement, mutual exclusion with --current, empty values.
 * - Boundary validation: malformed scoped catalog / read responses fail explicitly.
 * - Human vs --json rendering for the scoped catalog (scope line, shadowed ids, nodeUnavailable).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  makeCliEnv,
  parseCliError,
  runCliCaptured,
  startMockHub,
  useTempDir,
} from './helpers/cli-harness.js'

const CONVERSATION_42 = 'GET /api/conversations/42?limit=1'
const CONVERSATION_42_BODY = { id: 42, title: 'work', nodeId: 'node-a', cwd: '/srv/work' }

const CATALOG_OK = {
  nodeId: 'local',
  cwd: '/srv/work',
  skills: [
    { id: 'helmx-cli', name: 'Helmx CLI', references: [], source: 'data' },
    { id: 'deploy', name: 'Deploy', references: ['refs/runbook.md'], source: 'node' },
  ],
  shadowedNodeSkillIds: ['demo'],
}

test('skills list without scope flags keeps Hub global GET semantics', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    {
      'GET /api/skills': () => ({ body: [{ id: 'helmx-cli', name: 'Helmx CLI', references: [] }] }),
    },
    { autoRegisterCleanup: t },
  )
  // HELMX_CONVERSATION_ID present must NOT reroute an unflagged call
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '7' })
  const r = await runCliCaptured(['skills', 'list', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.equal(hub.hits.filter((h) => h.path.includes('/api/skills/scoped/catalog')).length, 0)
  assert.equal(hub.hits.filter((h) => h.path.includes('/api/actions/')).length, 0)
  assert.deepEqual(JSON.parse(r.out), [{ id: 'helmx-cli', name: 'Helmx CLI', references: [] }])
})

test('skills list --current resolves conversation coordinates and requests scoped catalog explicitly', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    {
      'GET /api/conversations/42?limit=1': () => ({ body: { id: 42, title: 'work', nodeId: 'node-a', cwd: '/srv/work' } }),
      'GET /api/skills/scoped/catalog?nodeId=node-a&cwd=%2Fsrv%2Fwork': () => ({ body: CATALOG_OK }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '42' })
  const r = await runCliCaptured(['skills', 'list', '--current', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.hits.find((h) => h.method === 'GET' && h.path.startsWith('/api/skills/scoped/catalog?'))
  assert.ok(hit, 'GET /api/skills/scoped/catalog must be called')
  const params = new URL(`http://hub${hit!.path}`).searchParams
  assert.equal(params.get('nodeId'), 'node-a')
  assert.equal(params.get('cwd'), '/srv/work')
  assert.deepEqual(JSON.parse(r.out), CATALOG_OK)
})

test('skills list --current defaults a missing conversation nodeId to local', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    {
      'GET /api/conversations/5?limit=1': () => ({ body: { id: 5, title: 'local chat', cwd: '/home/me/proj' } }),
      'GET /api/skills/scoped/catalog?nodeId=local&cwd=%2Fhome%2Fme%2Fproj': () => ({ body: CATALOG_OK }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '5' })
  const r = await runCliCaptured(['skills', 'list', '--current', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.hits.find((h) => h.path.startsWith('/api/skills/scoped/catalog?'))!
  const params = new URL(`http://hub${hit.path}`).searchParams
  assert.equal(params.get('nodeId'), 'local')
  assert.equal(params.get('cwd'), '/home/me/proj')
})

test('skills list --current fails explicitly when the conversation has no bound cwd', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    {
      'GET /api/conversations/7?limit=1': () => ({ body: { id: 7, title: 'bare', cwd: '' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '7' })
  const r = await runCliCaptured(['skills', 'list', '--current', '--json'], env)
  assert.notEqual(r.code, 0)
  assert.equal(parseCliError(r).code, 'conversation_without_cwd')
  assert.equal(hub.hits.filter((h) => h.path.includes('/api/skills/')).length, 0)
})

test('skills list --current without HELMX_CONVERSATION_ID fails explicitly', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const r = await runCliCaptured(['skills', 'list', '--current', '--json'], makeCliEnv(hub.url, dir))
  assert.notEqual(r.code, 0)
  assert.equal(parseCliError(r).code, 'current_conversation_missing')
  assert.equal(hub.hits.length, 0)
})

test('skills list --node+--cwd sends explicit query coordinates without conversationId', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    {
      'GET /api/skills/scoped/catalog?nodeId=node-a&cwd=%2Fsrv%2Fwork': () => ({ body: CATALOG_OK }),
    },
    { autoRegisterCleanup: t },
  )
  // Even inside a managed turn, explicit coordinates never attach conversation context
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '9' })
  const r = await runCliCaptured(['skills', 'list', '--node', 'node-a', '--cwd', '/srv/work', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.hits.find((h) => h.path.startsWith('/api/skills/scoped/catalog?'))!
  const params = new URL(`http://hub${hit.path}`).searchParams
  assert.equal(params.get('nodeId'), 'node-a')
  assert.equal(params.get('cwd'), '/srv/work')
  assert.equal(params.get('conversationId'), null)
})

test('skills list --node works standalone without --cwd; --cwd alone without --node fails explicitly', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const catalogNodeOnly = {
    nodeId: 'node-a',
    skills: [{ id: 'node-shared', name: 'Node Shared', references: [], source: 'node' }],
    shadowedNodeSkillIds: [],
  }
  const hub = await startMockHub(
    {
      'GET /api/skills/scoped/catalog?nodeId=node-a': () => ({ body: catalogNodeOnly }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const onlyNode = await runCliCaptured(['skills', 'list', '--node', 'node-a', '--json'], env)
  assert.equal(onlyNode.code, 0, onlyNode.err)
  const hit = hub.hits.find((h) => h.path.startsWith('/api/skills/scoped/catalog?'))!
  const params = new URL(`http://hub${hit.path}`).searchParams
  assert.equal(params.get('nodeId'), 'node-a')
  assert.equal(params.get('cwd'), null)
  assert.deepEqual(JSON.parse(onlyNode.out), catalogNodeOnly)

  const humanNode = await runCliCaptured(['skills', 'list', '--node', 'node-a'], env)
  assert.equal(humanNode.code, 0, humanNode.err)
  assert.ok(humanNode.out.includes('scope: node=node-a\n'), humanNode.out)

  const onlyCwd = await runCliCaptured(['skills', 'list', '--cwd', '/srv/work', '--json'], env)
  assert.equal(parseCliError(onlyCwd).code, 'missing_required_flag')
  assert.equal(hub.hits.length, 2, '--cwd without --node never hits the server')
})

test('skills read --node works standalone without --cwd', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    { 'GET /api/skills/node-shared?nodeId=node-a': () => ({ body: { text: '# node machine manual' } }) },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const r = await runCliCaptured(['skills', 'read', 'node-shared', '--node', 'node-a'], env)
  assert.equal(r.code, 0, r.err)
  assert.ok(r.out.startsWith('# node machine manual'))
  const hit = hub.hits.find((h) => h.path.startsWith('/api/skills/node-shared'))!
  const params = new URL(`http://hub${hit.path}`).searchParams
  assert.equal(params.get('nodeId'), 'node-a')
  assert.equal(params.get('cwd'), null)
})

test('skills list --current conflicts with explicit --node/--cwd', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '7' })
  const r = await runCliCaptured(['skills', 'list', '--current', '--node', 'node-a', '--cwd', '/srv/work', '--json'], env)
  assert.equal(parseCliError(r).code, 'conflicting_flags')
  assert.equal(hub.hits.length, 0)
})

test('skills list rejects empty --node/--cwd values locally', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)
  const r = await runCliCaptured(['skills', 'list', '--node', '  ', '--cwd', '/srv/work', '--json'], env)
  assert.equal(parseCliError(r).code, 'invalid_flag_value')
  assert.equal(hub.hits.length, 0)
})

test('skills list human output renders scope, shadowed ids, and nodeUnavailable diagnostics', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    {
      [CONVERSATION_42]: () => ({ body: CONVERSATION_42_BODY }),
      'GET /api/skills/scoped/catalog?nodeId=node-a&cwd=%2Fsrv%2Fwork': () => ({
        body: { ...CATALOG_OK, nodeUnavailable: 'node node-a is offline' },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '42' })
  const r = await runCliCaptured(['skills', 'list', '--current'], env)
  assert.equal(r.code, 0, r.err)
  assert.ok(r.out.includes('scope: node=local cwd=/srv/work'), r.out)
  assert.ok(r.out.includes('deploy'), 'merged skill table must list node skills')
  assert.ok(r.out.includes('node skills shadowed by same-name Hub/agents versions: demo'), r.out)
  assert.ok(r.out.includes('node skill library unavailable: node node-a is offline'), r.out)
})

test('skills list fails explicitly on malformed scoped catalog responses', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    {
      [CONVERSATION_42]: () => ({ body: CONVERSATION_42_BODY }),
      'GET /api/skills/scoped/catalog?nodeId=node-a&cwd=%2Fsrv%2Fwork': () => ({
        body: { nodeId: 'local', cwd: '/w', skills: 'nope', shadowedNodeSkillIds: [] },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '42' })
  const r = await runCliCaptured(['skills', 'list', '--current', '--json'], env)
  assert.notEqual(r.code, 0)
  assert.equal(parseCliError(r).code, 'invalid_response')
})

test('skills read --current requests GET /api/skills/:id with resolved coordinates and prints text', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    {
      'GET /api/conversations/42?limit=1': () => ({ body: { id: 42, title: 'work', nodeId: 'node-a', cwd: '/srv/work' } }),
      'GET /api/skills/deploy?nodeId=node-a&cwd=%2Fsrv%2Fwork': () => ({ body: { text: '# node skill manual' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '42' })
  const r = await runCliCaptured(['skills', 'read', 'deploy', '--current'], env)
  assert.equal(r.code, 0, r.err)
  assert.ok(r.out.startsWith('# node skill manual'))
  const hit = hub.hits.find((h) => h.path.startsWith('/api/skills/deploy'))!
  const params = new URL(`http://hub${hit.path}`).searchParams
  assert.equal(params.get('nodeId'), 'node-a')
  assert.equal(params.get('cwd'), '/srv/work')
})

test('skills read --node+--cwd passes path in query params; --json echoes {text}', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    {
      'GET /api/skills/deploy?path=refs%2Frunbook.md&nodeId=node-a&cwd=%2Fsrv%2Fwork': () => ({
        body: { text: 'runbook content' },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const r = await runCliCaptured(
    ['skills', 'read', 'deploy', '--path', 'refs/runbook.md', '--node', 'node-a', '--cwd', '/srv/work', '--json'],
    env,
  )
  assert.equal(r.code, 0, r.err)
  const hit = hub.hits.find((h) => h.path.startsWith('/api/skills/deploy'))!
  const params = new URL(`http://hub${hit.path}`).searchParams
  assert.equal(params.get('nodeId'), 'node-a')
  assert.equal(params.get('cwd'), '/srv/work')
  assert.equal(params.get('path'), 'refs/runbook.md')
  assert.deepEqual(JSON.parse(r.out), { text: 'runbook content' })
})

test('skills read scoped fails explicitly on malformed responses', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    {
      [CONVERSATION_42]: () => ({ body: CONVERSATION_42_BODY }),
      'GET /api/skills/deploy?nodeId=node-a&cwd=%2Fsrv%2Fwork': () => ({ body: { text: 42 } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '42' })
  const r = await runCliCaptured(['skills', 'read', 'deploy', '--current', '--json'], env)
  assert.notEqual(r.code, 0)
  assert.equal(parseCliError(r).code, 'invalid_response')
})

test('skills read stays on GET /api/skills/:id when no scope flags are passed', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-skills-')
  const hub = await startMockHub(
    {
      'GET /api/skills/demo': () => ({ body: { text: 'hub skill' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '42' })
  const r = await runCliCaptured(['skills', 'read', 'demo'], env)
  assert.equal(r.code, 0, r.err)
  assert.ok(r.out.startsWith('hub skill'))
  assert.equal(hub.hits.filter((h) => h.path.includes('/api/actions/')).length, 0)
})
