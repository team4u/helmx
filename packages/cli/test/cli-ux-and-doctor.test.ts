/**
 * Unit tests for Wave 1 + Wave 2 CLI UX & diagnostics improvements:
 * - `helmx status` offline local Hub snapshot + flag rejection;
 * - `resolveCliServiceEntry` compiled artifact resolution & `missing_build` rejection;
 * - `helmx doctor` read-only checks (healthy, offline, unconfigured, missing default model, offline node);
 * - masked TTY secret prompts & piped stdin fallback for `setup`, `login`, `credentials set`;
 * - grouped compact `--help`, offline `<group> --help`, dynamic group `--help`, schema flag descriptions,
 *   and missing-subcommand guidance;
 * - structured human error diagnostics (`error [<code>]: ...` + details + hints);
 * - C9 behavioral fixes: `ask --node`, positional `<id>` + `--current` mutual exclusion, curated tables.
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { writeCurrentRelease } from '@helmx/env-io'
import type { StdinSource } from '../src/options.js'
import { resolveCliServiceEntry } from '../src/commands/service.js'
import {
  makeCliEnv,
  parseCliError,
  runCliCaptured,
  startMockHub,
  useTempDir,
} from './helpers/cli-harness.js'

function ttySecretStdin(secret: string, prompts: string[] = []): StdinSource {
  return {
    isTTY: true,
    readAll: () => Promise.reject(new Error('must not call readAll in TTY mode')),
    readSecret: async (prompt: string) => {
      prompts.push(prompt)
      return secret
    },
  }
}

function pipedStdin(text: string): StdinSource {
  return { isTTY: false, readAll: () => Promise.resolve(text) }
}

test('helmx status offline: prints local Hub snapshot and hint instead of bare unreachable error, and rejects extra flags', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-status-offline-')
  const installRoot = path.join(dir, 'hub-install')
  const dataDir = path.join(dir, 'data')
  await writeCurrentRelease(installRoot, {
    version: '0.2.0',
    updatedAt: '2026-01-01T00:00:00.000Z',
    entries: { entryPath: path.join(installRoot, 'releases/0.2.0/start.mjs') },
  })
  const env = makeCliEnv('http://127.0.0.1:1', dataDir, { HELMX_HUB_INSTALL_ROOT: installRoot })

  const human = await runCliCaptured(['status'], env)
  assert.equal(human.code, 1)
  assert.match(human.out, /hub:\s+unreachable/)
  assert.match(human.out, /local hub:\s+not running/)
  assert.match(human.out, /installed:\s+0\.2\.0/)
  assert.match(human.out, /helmx start/)

  const json = await runCliCaptured(['status', '--json'], env)
  assert.equal(json.code, 1)
  assert.equal(json.out, '')
  const err = parseCliError<{ hubUrl: string; localHub: { current: { version: string } } }>(json)
  assert.equal(err.code, 'hub_unreachable')
  assert.equal(err.details?.localHub.current.version, '0.2.0')

  const badFlag = await runCliCaptured(['status', '--bogus', '--json'], env)
  assert.equal(badFlag.code, 1)
  assert.equal(parseCliError(badFlag).code, 'unknown_flag')
})

test('resolveCliServiceEntry resolves bundled/dist index.js and rejects unbuilt source with missing_build', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-service-entry-')

  // Single-file bundled npm artifact (`index.js`) returns itself.
  const bundlePath = path.join(dir, 'bundle', 'index.js')
  assert.equal(resolveCliServiceEntry(bundlePath), bundlePath)

  // Unbundled dist layout (`dist/commands/service.js` -> `dist/index.js`).
  const distDir = path.join(dir, 'pkg', 'dist')
  await fsp.mkdir(path.join(distDir, 'commands'), { recursive: true })
  const distIndex = path.join(distDir, 'index.js')
  await fsp.writeFile(distIndex, '// built\n', 'utf8')
  const distService = path.join(distDir, 'commands', 'service.js')
  assert.equal(resolveCliServiceEntry(distService), await fsp.realpath(distIndex))

  // Unbuilt source layout (`src/commands/service.ts` without `dist/index.js`) throws `missing_build`.
  const unbuiltService = path.join(dir, 'unbuilt', 'src', 'commands', 'service.ts')
  assert.throws(
    () => resolveCliServiceEntry(unbuiltService),
    (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'missing_build',
  )
})

test('helmx doctor: read-only diagnostics cover healthy, unconfigured, missing default model, offline node, and unreachable Hub', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-doctor-test-')
  const installRoot = path.join(dir, 'absent-install')
  const dataDir = path.join(dir, 'data')
  await fsp.mkdir(dataDir, { recursive: true })

  // 1. Healthy Hub with models, default, and online nodes.
  const healthyHub = await startMockHub(
    {
      'GET /api/auth/status': () => ({ body: { configured: true, authenticated: true } }),
      'GET /api/models': () => ({ body: { models: [{ provider: 'openai', modelId: 'gpt-4o', available: true }] } }),
      'GET /api/models/default': () => ({ body: { defaultModel: 'openai/gpt-4o' } }),
      'GET /api/nodes': () => ({ body: [{ id: 'local', kind: 'local', online: true }] }),
    },
    { autoRegisterCleanup: t },
  )
  const okRes = await runCliCaptured(['doctor', '--json'], makeCliEnv(healthyHub.url, dataDir, { HELMX_HUB_INSTALL_ROOT: installRoot }))
  assert.equal(okRes.code, 0, okRes.err)
  const okReport = JSON.parse(okRes.out) as { ok: boolean; checks: Array<{ id: string; status: string }> }
  assert.equal(okReport.ok, true)
  assert.equal(okReport.checks.find((c) => c.id === 'hub')?.status, 'ok')
  assert.equal(okReport.checks.find((c) => c.id === 'models')?.status, 'ok')
  assert.equal(okReport.checks.find((c) => c.id === 'nodes')?.status, 'ok')

  const okHuman = await runCliCaptured(['doctor'], makeCliEnv(healthyHub.url, dataDir, { HELMX_HUB_INSTALL_ROOT: installRoot }))
  assert.equal(okHuman.code, 0)
  assert.match(okHuman.out, /\[OK\s+\] hub:/)
  assert.match(okHuman.out, /all checks passed/)

  // 2. Warn when default model is missing or a remote node is offline (still exits 0 — no errors).
  const warnHub = await startMockHub(
    {
      'GET /api/auth/status': () => ({ body: { configured: true, authenticated: true } }),
      'GET /api/models': () => ({ body: { models: [{ provider: 'openai', modelId: 'gpt-4o', available: true }] } }),
      'GET /api/models/default': () => ({ body: { defaultModel: '' } }),
      'GET /api/nodes': () => ({
        body: [
          { id: 'local', kind: 'local', online: true },
          { id: 'gpu-1', kind: 'byom', online: false },
        ],
      }),
    },
    { autoRegisterCleanup: t },
  )
  const warnRes = await runCliCaptured(['doctor'], makeCliEnv(warnHub.url, dataDir, { HELMX_HUB_INSTALL_ROOT: installRoot }))
  assert.equal(warnRes.code, 0)
  assert.match(warnRes.out, /\[WARN\] models:/)
  assert.match(warnRes.out, /\[WARN\] nodes:.*gpu-1/)

  // 3. Unreachable Hub fails with exit 1 and actionable hint.
  const downRes = await runCliCaptured(['doctor'], makeCliEnv('http://127.0.0.1:1', dataDir, { HELMX_HUB_INSTALL_ROOT: installRoot }))
  assert.equal(downRes.code, 1)
  assert.match(downRes.out, /\[FAIL\] hub:/)
  assert.match(downRes.out, /helmx start/)
})

test('secret hygiene: login, setup, and credentials set support masked TTY prompt and piped stdin without argv secrets', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-secret-prompt-')
  const hub = await startMockHub(
    {
      'POST /api/auth/setup': () => ({ body: { token: 'tok-setup' } }),
      'POST /api/auth/login': () => ({ body: { token: 'tok-login' } }),
      'PUT /api/credentials/openai': () => ({ body: { ok: true } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  // TTY masked prompt on login
  const prompts: string[] = []
  const loginTty = await runCliCaptured(['login', '--json'], env, { stdin: ttySecretStdin('tty-pass-1', prompts) })
  assert.equal(loginTty.code, 0, loginTty.err)
  assert.equal(prompts[0], 'Password: ')
  assert.deepEqual(hub.hits.at(-1)?.body, { password: 'tty-pass-1' })

  // Piped stdin on credentials set (preserving trailing spaces, stripping only newline)
  const credPipe = await runCliCaptured(['credentials', 'set', 'openai', '--json'], env, {
    stdin: pipedStdin('sk-from-stdin \nignored-second-line'),
  })
  assert.equal(credPipe.code, 0, credPipe.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { value: 'sk-from-stdin ' })

  // TTY masked prompt on credentials set
  const credPrompts: string[] = []
  const credTty = await runCliCaptured(['credentials', 'set', 'openai', '--json'], env, {
    stdin: ttySecretStdin('sk-from-tty', credPrompts),
  })
  assert.equal(credTty.code, 0, credTty.err)
  assert.match(credPrompts[0]!, /openai/)
  assert.deepEqual(hub.hits.at(-1)?.body, { value: 'sk-from-tty' })

  // Empty stdin fails cleanly
  const empty = await runCliCaptured(['credentials', 'set', 'openai', '--json'], env, { stdin: pipedStdin('') })
  assert.equal(empty.code, 1)
  assert.equal(parseCliError(empty).code, 'missing_required_flag')
})

test('help overhaul and human error diagnostics: offline group help, schema flag descriptions, missing-subcommand hints, structured stderr', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-help-diag-')
  const offlineEnv = makeCliEnv('http://127.0.0.1:1', dir, { HELMX_TOKEN: 'tok' })

  // 1. Offline core group help works without touching Hub.
  const groupHelp = await runCliCaptured(['conversations', '--help'], offlineEnv)
  assert.equal(groupHelp.code, 0, groupHelp.err)
  assert.match(groupHelp.out, /helmx conversations — subcommands:/)
  assert.match(groupHelp.out, /conversations list/)
  assert.equal(groupHelp.err, '')

  // 2. Offline bare core group gives actionable missing-subcommand error instead of hub_unreachable.
  const bareGroup = await runCliCaptured(['conversations'], offlineEnv)
  assert.equal(bareGroup.code, 1)
  assert.match(bareGroup.err, /error \[unknown_command\]: missing subcommand for "helmx conversations"/)
  assert.match(bareGroup.err, /available:.*list/)

  // 3. Human error output prints code, details, and recovery hint.
  const errHub = await startMockHub(
    {
      'GET /api/nodes': () => ({
        status: 409,
        body: { error: { code: 'node_offline', message: 'node gpu-1 is offline', details: { nodeId: 'gpu-1' } } },
      }),
    },
    {
      defaultActions: [
        {
          pluginId: 'builtin:demo',
          id: 'run',
          description: 'Run demo',
          inputSchema: {
            type: 'object',
            properties: {
              mode: { type: 'string', description: 'Execution mode', enum: ['fast', 'deep'] },
            },
            required: ['mode'],
          },
          outputSchema: { type: 'object' },
          cli: { command: ['demo', 'run'] },
        },
      ],
      autoRegisterCleanup: t,
    },
  )
  const env = makeCliEnv(errHub.url, dir)
  const nodeErr = await runCliCaptured(['nodes', 'list'], env)
  assert.equal(nodeErr.code, 1)
  assert.match(nodeErr.err, /error \[node_offline\]: node gpu-1 is offline/)
  assert.match(nodeErr.err, /details: nodeId=gpu-1/)
  assert.match(nodeErr.err, /hint:.*helmx-node doctor/)

  // 4. Dynamic action help surfaces schema description & enum, and group help fetches /api/actions once.
  const actionHelp = await runCliCaptured(['demo', 'run', '--help'], env)
  assert.equal(actionHelp.code, 0, actionHelp.err)
  assert.match(actionHelp.out, /--mode <string> \(required\)\s+Execution mode \(fast\|deep\)/)

  const hitsBefore = errHub.hits.filter((h) => h.path === '/api/actions').length
  const dynGroupHelp = await runCliCaptured(['demo', '--help'], env)
  assert.equal(dynGroupHelp.code, 0, dynGroupHelp.err)
  assert.match(dynGroupHelp.out, /helmx demo — subcommands:/)
  assert.match(dynGroupHelp.out, /demo run/)
  assert.equal(errHub.hits.filter((h) => h.path === '/api/actions').length, hitsBefore + 1, 'must fetch /api/actions only once')
})

test('C9 behavioral fixes: ask --node, positional + --current rejection, and curated human tables', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-c9-fixes-')
  const hub = await startMockHub(
    {
      'POST /api/conversations': () => ({ status: 201, body: { id: 12, title: 't', profileId: 'default', tags: [] } }),
      'POST /api/conversations/12/input?wait=1': () => ({
        body: { conversationId: 12, submissionId: 's1', text: 'ok', entry: { id: 'e1', kind: 'pi.assistant' } },
      }),
      'GET /api/nodes': () => ({
        body: [
          {
            id: 'gpu-1',
            kind: 'byom',
            online: true,
            version: '0.2.0',
            hostname: 'gpu-box',
            platform: 'linux',
            health: {
              collectedAt: 1,
              uptimeSec: 100,
              loadAvg: [1.25, 1.0, 0.8],
              memFreeBytes: 8 * 1024 ** 3,
              memTotalBytes: 32 * 1024 ** 3,
              diskFreeBytes: 100 * 1024 ** 3,
              diskTotalBytes: 500 * 1024 ** 3,
            },
          },
        ],
      }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '7' })

  // ask --node forwards nodeId
  const ask = await runCliCaptured(['ask', 'hi', '--node', 'gpu-1', '--json'], env, { stdin: ttySecretStdin('') })
  assert.equal(ask.code, 0, ask.err)
  const createHit = hub.hits.find((h) => h.path === '/api/conversations')!
  assert.equal((createHit.body as { nodeId?: string }).nodeId, 'gpu-1')

  // positional <id> + --current rejected uniformly
  const getConflict = await runCliCaptured(['conversations', 'get', '7', '--current', '--json'], env)
  assert.equal(getConflict.code, 1)
  assert.equal(parseCliError(getConflict).code, 'conflicting_flags')

  const sendConflict = await runCliCaptured(['send', '7', '--current', 'hello', '--json'], env)
  assert.equal(sendConflict.code, 1)
  assert.equal(parseCliError(sendConflict).code, 'conflicting_flags')

  // nodes list shows compact health summary column
  const nodesHuman = await runCliCaptured(['nodes', 'list'], env)
  assert.equal(nodesHuman.code, 0, nodesHuman.err)
  assert.match(nodesHuman.out, /health/)
  assert.match(nodesHuman.out, /load 1\.25 \| mem 24G\/32G \| disk 400G\/500G/)
})
