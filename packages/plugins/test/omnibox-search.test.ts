/**
 * Omnibox metadata & dynamic `helmx.search` capability tests across built-in plugins:
 * - Pure unit tests for `search-utils.ts` (scoring hierarchy, multi-token AND matching,
 *   limit bounds, deterministic sorting, AbortSignal cancellation, one-line compaction);
 * - Real `createHelmx` / `PluginHost` registration validation for enriched `ScreenSpec`,
 *   `SettingsPanelSpec`, and declarative navigation `CommandSpec` (`target`) across
 *   `builtin:triggers`, `builtin:tiers`, `builtin:port-forward`, `builtin:changes`,
 *   `builtin:magpie`, and `builtin:workflow` (bilingual `en` + `zh-CN`, zero Emoji);
 * - Dynamic `helmx.search` provider verification for `builtin:workflow`, `builtin:triggers`,
 *   `builtin:tiers`, and `builtin:port-forward`: accurate deep-link targets matching real
 *   client screen/drawer params, `limit` enforcement, `AbortSignal` honoring, zero secret
 *   leakage (especially webhook secrets), clean release on plugin disable, and end-to-end
 *   `GET /api/omnibox/search` aggregation.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  HELMX_SEARCH_CAPABILITY_ID,
  parseNonEmptyLocalizedText,
  type LocalizedText,
  type OmniboxSearchResponse,
  type PluginSearchProvider,
} from '@helmx/protocol'
import { createHubHandler } from '@helmx/kernel'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { createHelmx } from '../../hub/src/app.js'
import { CHANGES_PLUGIN_ID, CHANGES_SCREEN_ID } from '../src/changes.js'
import { MAGPIE_PLUGIN_ID } from '../src/magpie.js'
import { PORT_FORWARD_PLUGIN_ID, PORT_FORWARD_SCREEN_ID } from '../src/port-forward.js'
import { compactOneLine, rankSearchCandidates, scoreSearchFields } from '../src/search-utils.js'
import { TIERS_PLUGIN_ID, TIERS_SCREEN_ID } from '../src/tiers.js'
import { TRIGGERS_PLUGIN_ID } from '../src/triggers.js'
import { WORKFLOW_PLUGIN_ID } from '../src/workflow.js'
import {
  cleanupDir,
  makeFauxProvider,
  makeTempDir,
} from './helpers/plugin-test-env.js'

const TIMEOUT = { timeout: 60_000 } as const

/** Emoji detector for UI metadata hygiene checks (pictographs, symbols, variation selectors). */
const EMOJI_RE = /\p{Extended_Pictographic}/u

function assertNoEmoji(where: string, value: unknown): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  assert.equal(EMOJI_RE.test(serialized), false, `${where} must not contain Emoji: ${serialized}`)
}

function assertBilingualMetadata(where: string, value: unknown): void {
  assert.ok(value !== undefined && typeof value === 'object' && value !== null, `${where} must be a bilingual LocalizedText object`)
  assert.notEqual(parseNonEmptyLocalizedText(value as LocalizedText), undefined, `${where} must pass parseNonEmptyLocalizedText`)
  const rec = value as Record<string, unknown>
  assert.ok(typeof rec['en'] === 'string' && rec['en'].trim().length > 0, `${where}.en must be non-empty`)
  assert.ok(typeof rec['zh-CN'] === 'string' && rec['zh-CN'].trim().length > 0, `${where}['zh-CN'] must be non-empty`)
  assertNoEmoji(where, value)
}

function parseTargetQuery(target: string, expectedPrefix: string): URLSearchParams {
  assert.ok(target.startsWith(`${expectedPrefix}?`), `expected target "${target}" to start with "${expectedPrefix}?"`)
  return new URLSearchParams(target.slice(expectedPrefix.length + 1))
}

async function openTestApp() {
  const dataDir = await makeTempDir('helmx-omnibox-plugins-')
  const faux = makeFauxProvider({
    models: [
      { id: 'fast', name: 'Fast', reasoning: true },
      { id: 'flagship', name: 'Flagship', reasoning: true },
    ],
  })
  const app = await createHelmx({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    cwd: dataDir,
    model: 'faux/fast',
    providers: [faux.provider],
  })
  const handler = createHubHandler(app.kernel)
  const credential = app.kernel.auth.createProcessToken()
  return {
    dataDir,
    app,
    handler,
    token: credential.token,
    async close() {
      credential.dispose()
      try {
        await app.close()
      } finally {
        await cleanupDir(dataDir)
      }
    },
  }
}

function findProvider(
  app: Awaited<ReturnType<typeof createHelmx>>,
  pluginId: string,
): PluginSearchProvider | undefined {
  return app.kernel.plugins
    .consumeCapability<PluginSearchProvider>(HELMX_SEARCH_CAPABILITY_ID)
    .find((entry) => entry.pluginId === pluginId)?.impl
}

async function queryOmniboxHttp(
  env: { handler: (req: Request) => Promise<Response>; token: string },
  query: string,
  limit = 10,
): Promise<OmniboxSearchResponse> {
  const url = `http://127.0.0.1:3202/api/omnibox/search?q=${encodeURIComponent(query)}&limit=${limit}`
  const res = await env.handler(
    new Request(url, {
      headers: { authorization: `Bearer ${env.token}` },
    }),
  )
  assert.equal(res.status, 200, `GET ${url} should succeed`)
  return (await res.json()) as OmniboxSearchResponse
}

test('search-utils: scoring hierarchy, multi-token matching, limit, abort, and one-line compaction', TIMEOUT, () => {
  assert.equal(scoreSearchFields('', { primary: ['alpha'] }), undefined)
  assert.equal(scoreSearchFields('   ', { primary: ['alpha'] }), undefined)

  const exact = scoreSearchFields('release', { primary: ['release'] })
  const prefix = scoreSearchFields('rel', { primary: ['release'] })
  const sub = scoreSearchFields('eas', { primary: ['release'] })
  const secPrefix = scoreSearchFields('deploy', { primary: ['job-1'], secondary: ['deploy production'] })
  const secSub = scoreSearchFields('prod', { primary: ['job-1'], secondary: ['deploy production'] })
  const kwExact = scoreSearchFields('cron', { primary: ['job-1'], keywords: ['cron', 'schedule'] })

  assert.ok(exact !== undefined && prefix !== undefined && sub !== undefined)
  assert.ok(secPrefix !== undefined && secSub !== undefined && kwExact !== undefined)
  assert.ok(exact > prefix && prefix > sub && sub > secPrefix && secPrefix > secSub && secSub > kwExact)

  // Multi-token AND match across keyword + primary + secondary
  const multi = scoreSearchFields('cron nightly prod', {
    primary: ['nightly-backup'],
    secondary: ['Run prod database check'],
    keywords: ['cron', 'schedule'],
  })
  assert.ok(multi !== undefined && multi > 0 && multi <= 100)
  assert.equal(
    scoreSearchFields('cron nightly nonexistent', {
      primary: ['nightly-backup'],
      secondary: ['Run prod database check'],
      keywords: ['cron'],
    }),
    undefined,
  )

  // Limit and deterministic sorting
  const items = [
    { id: 'b-deploy', desc: 'secondary deploy' },
    { id: 'deploy', desc: 'exact match' },
    { id: 'deploy-canary', desc: 'prefix match' },
  ]
  const ranked = rankSearchCandidates({
    query: 'deploy',
    limit: 2,
    items,
    fields: (i) => ({ primary: [i.id], secondary: [i.desc] }),
    tieBreaker: (i) => i.id,
    toResult: (i, score) => ({ id: i.id, score }),
  })
  assert.deepEqual(
    ranked.map((r) => r.id),
    ['deploy', 'deploy-canary'],
  )

  // Aborted signal short-circuits cleanly
  const aborted = AbortSignal.abort()
  assert.deepEqual(
    rankSearchCandidates({
      query: 'deploy',
      limit: 5,
      signal: aborted,
      items,
      fields: (i) => ({ primary: [i.id] }),
      tieBreaker: (i) => i.id,
      toResult: (i) => i.id,
    }),
    [],
  )

  // Abort mid-iteration stops cleanly
  const controller = new AbortController()
  const iterable = {
    *[Symbol.iterator]() {
      yield { id: 'deploy-1' }
      controller.abort()
      yield { id: 'deploy-2' }
    },
  }
  assert.deepEqual(
    rankSearchCandidates({
      query: 'deploy',
      limit: 5,
      signal: controller.signal,
      items: iterable,
      fields: (i) => ({ primary: [i.id] }),
      tieBreaker: (i) => i.id,
      toResult: (i) => i.id,
    }),
    [],
  )

  // Limit edge cases
  assert.deepEqual(
    rankSearchCandidates({
      query: 'deploy',
      limit: 0,
      items,
      fields: (i) => ({ primary: [i.id] }),
      tieBreaker: (i) => i.id,
      toResult: (i) => i.id,
    }),
    [],
  )

  // compactOneLine
  assert.equal(compactOneLine('  hello \n\t  world  '), 'hello world')
  assert.equal(compactOneLine('   '), undefined)
  assert.equal(compactOneLine('abcdefghij', 6), 'abcde…')
})

test('enriched UI specs: screens, settingsPanels, and navigation commands pass PluginHost validation with bilingual copy and zero Emoji', TIMEOUT, async () => {
  const env = await openTestApp()
  try {
    const contributions = env.app.kernel.plugins.listUi()

    const findUi = (pluginId: string, surface: string, id: string): Record<string, unknown> | undefined => {
      const match = contributions.find(
        (c) =>
          c.pluginId === pluginId &&
          c.surface === surface &&
          typeof c.spec === 'object' &&
          c.spec !== null &&
          (c.spec as Record<string, unknown>)['id'] === id,
      )
      return match === undefined ? undefined : (match.spec as Record<string, unknown>)
    }

    // 1) builtin:triggers
    const triggersScreen = findUi(TRIGGERS_PLUGIN_ID, 'screen', 'manager')
    assert.ok(triggersScreen, 'builtin:triggers screen should register')
    assertBilingualMetadata('triggers screen.description', triggersScreen['description'])
    assert.ok(Array.isArray(triggersScreen['keywords']) && (triggersScreen['keywords'] as string[]).includes('cron'))
    assertNoEmoji('triggers screen.keywords', triggersScreen['keywords'])

    const triggersSettings = findUi(TRIGGERS_PLUGIN_ID, 'settings.panel', 'triggers-settings')
    assert.ok(triggersSettings, 'builtin:triggers settingsPanel should register')
    assertBilingualMetadata('triggers settingsPanel.description', triggersSettings['description'])
    assert.ok(Array.isArray(triggersSettings['keywords']) && (triggersSettings['keywords'] as string[]).includes('webhook'))
    assertNoEmoji('triggers settingsPanel.keywords', triggersSettings['keywords'])

    const triggersWebhookCmd = findUi(TRIGGERS_PLUGIN_ID, 'commandPalette', 'triggers-open-webhooks')
    assert.ok(triggersWebhookCmd, 'builtin:triggers webhook command should register')
    assertBilingualMetadata('triggers command.title', triggersWebhookCmd['title'])
    assertBilingualMetadata('triggers command.description', triggersWebhookCmd['description'])
    assert.equal(triggersWebhookCmd['target'], `screen:${TRIGGERS_PLUGIN_ID}/manager?tab=webhook`)
    assertNoEmoji('triggers command.keywords', triggersWebhookCmd['keywords'])

    // 2) builtin:tiers (screen ID is 'main', createParam is 'create')
    const tiersScreen = findUi(TIERS_PLUGIN_ID, 'screen', TIERS_SCREEN_ID)
    assert.ok(tiersScreen, 'builtin:tiers screen should register')
    assertBilingualMetadata('tiers screen.description', tiersScreen['description'])
    assert.ok(Array.isArray(tiersScreen['keywords']) && (tiersScreen['keywords'] as string[]).includes('tier'))
    assertNoEmoji('tiers screen.keywords', tiersScreen['keywords'])

    const tiersSettings = findUi(TIERS_PLUGIN_ID, 'settings.panel', 'tiers-settings')
    assert.ok(tiersSettings, 'builtin:tiers settingsPanel should register')
    assertBilingualMetadata('tiers settingsPanel.description', tiersSettings['description'])
    assert.ok(Array.isArray(tiersSettings['keywords']) && (tiersSettings['keywords'] as string[]).includes('routing'))
    assertNoEmoji('tiers settingsPanel.keywords', tiersSettings['keywords'])

    const tiersCreateCmd = findUi(TIERS_PLUGIN_ID, 'commandPalette', 'tiers-create')
    assert.ok(tiersCreateCmd, 'builtin:tiers create command should register')
    assertBilingualMetadata('tiers command.title', tiersCreateCmd['title'])
    assertBilingualMetadata('tiers command.description', tiersCreateCmd['description'])
    assert.equal(tiersCreateCmd['target'], `screen:${TIERS_PLUGIN_ID}/${TIERS_SCREEN_ID}?create=1`)
    assertNoEmoji('tiers command.keywords', tiersCreateCmd['keywords'])

    // 3) builtin:port-forward (screen ID is 'main', createParam is 'create')
    const pfScreen = findUi(PORT_FORWARD_PLUGIN_ID, 'screen', PORT_FORWARD_SCREEN_ID)
    assert.ok(pfScreen, 'builtin:port-forward screen should register')
    assertBilingualMetadata('port-forward screen.description', pfScreen['description'])
    assert.ok(Array.isArray(pfScreen['keywords']) && (pfScreen['keywords'] as string[]).includes('tunnel'))
    assertNoEmoji('port-forward screen.keywords', pfScreen['keywords'])

    const pfSettings = findUi(PORT_FORWARD_PLUGIN_ID, 'settings.panel', 'port-forward-settings')
    assert.ok(pfSettings, 'builtin:port-forward settingsPanel should register')
    assertBilingualMetadata('port-forward settingsPanel.description', pfSettings['description'])
    assert.ok(Array.isArray(pfSettings['keywords']) && (pfSettings['keywords'] as string[]).includes('tcp'))
    assertNoEmoji('port-forward settingsPanel.keywords', pfSettings['keywords'])

    const pfCreateCmd = findUi(PORT_FORWARD_PLUGIN_ID, 'commandPalette', 'port-forward-create')
    assert.ok(pfCreateCmd, 'builtin:port-forward create command should register')
    assertBilingualMetadata('port-forward command.title', pfCreateCmd['title'])
    assertBilingualMetadata('port-forward command.description', pfCreateCmd['description'])
    assert.equal(pfCreateCmd['target'], `screen:${PORT_FORWARD_PLUGIN_ID}/${PORT_FORWARD_SCREEN_ID}?create=1`)
    assertNoEmoji('port-forward command.keywords', pfCreateCmd['keywords'])

    // 4) builtin:changes
    const changesScreen = findUi(CHANGES_PLUGIN_ID, 'screen', CHANGES_SCREEN_ID)
    assert.ok(changesScreen, 'builtin:changes screen should register')
    assertBilingualMetadata('changes screen.description', changesScreen['description'])
    assert.ok(Array.isArray(changesScreen['keywords']) && (changesScreen['keywords'] as string[]).includes('diff'))
    assertNoEmoji('changes screen.keywords', changesScreen['keywords'])

    // 5) builtin:magpie
    const magpieSettings = findUi(MAGPIE_PLUGIN_ID, 'settings.panel', 'magpie-panel')
    assert.ok(magpieSettings, 'builtin:magpie settingsPanel should register')
    assertBilingualMetadata('magpie settingsPanel.description', magpieSettings['description'])
    assert.ok(Array.isArray(magpieSettings['keywords']) && (magpieSettings['keywords'] as string[]).includes('quota'))
    assertNoEmoji('magpie settingsPanel.keywords', magpieSettings['keywords'])

    // 6) builtin:workflow
    const wfScreen = findUi(WORKFLOW_PLUGIN_ID, 'screen', 'library')
    assert.ok(wfScreen, 'builtin:workflow screen should register')
    assertBilingualMetadata('workflow screen.description', wfScreen['description'])
    assert.ok(Array.isArray(wfScreen['keywords']) && (wfScreen['keywords'] as string[]).includes('workflow'))
    assertNoEmoji('workflow screen.keywords', wfScreen['keywords'])
  } finally {
    await env.close()
  }
})

test('builtin:workflow helmx.search: searches saved definitions, returns valid ?wf= deep links, respects limit/signal, and releases on disable', TIMEOUT, async () => {
  const env = await openTestApp()
  try {
    await env.app.kernel.plugins.invokeAction(WORKFLOW_PLUGIN_ID, 'save', {
      script: [
        'export const meta = {',
        '  name: "release-pipeline",',
        '  description: "Automated canary release verification",',
        '  whenToUse: "Run before shipping a tag",',
        '  phases: [{ title: "Build" }, { title: "Verify" }],',
        '}',
        'return { ok: true }',
      ].join('\n'),
    })
    await env.app.kernel.plugins.invokeAction(WORKFLOW_PLUGIN_ID, 'save', {
      script: [
        'export const meta = {',
        '  name: "release-notes",',
        '  description: "Draft bilingual changelog summary",',
        '}',
        'return { ok: true }',
      ].join('\n'),
    })

    const provider = findProvider(env.app, WORKFLOW_PLUGIN_ID)
    assert.ok(provider, 'builtin:workflow should provide helmx.search')

    const hits = await provider.search({ query: 'canary', limit: 8 }, new AbortController().signal)
    assert.equal(hits.length, 1)
    const hit = hits[0]!
    assert.equal(hit.kind, 'resource')
    assert.equal(hit.title, 'release-pipeline')
    assert.equal(hit.icon, 'workflow')
    assert.deepEqual(hit.breadcrumb, [{ en: 'Workflow Library', 'zh-CN': '工作流库' }])
    assert.equal(hit.target, `screen:${WORKFLOW_PLUGIN_ID}/library?wf=${encodeURIComponent('release-pipeline')}`)
    const wfParams = parseTargetQuery(hit.target, `screen:${WORKFLOW_PLUGIN_ID}/library`)
    assert.equal(wfParams.get('wf'), 'release-pipeline')

    // Limit enforcement
    const limited = await provider.search({ query: 'release', limit: 1 }, new AbortController().signal)
    assert.equal(limited.length, 1)

    // AbortSignal enforcement
    const abortedHits = await provider.search({ query: 'release', limit: 8 }, AbortSignal.abort())
    assert.deepEqual(abortedHits, [])

    // HTTP omnibox aggregation includes workflow hit
    const httpRes = await queryOmniboxHttp(env, 'canary')
    assert.ok(
      httpRes.pluginItems.some((item) => item.pluginId === WORKFLOW_PLUGIN_ID && item.target === hit.target),
      'GET /api/omnibox/search should include builtin:workflow hit',
    )

    // Disabling plugin immediately releases capability and removes hits from /api/omnibox/search
    await env.app.kernel.plugins.disable(WORKFLOW_PLUGIN_ID)
    assert.equal(findProvider(env.app, WORKFLOW_PLUGIN_ID), undefined)
    const afterDisable = await queryOmniboxHttp(env, 'canary')
    assert.equal(
      afterDisable.pluginItems.some((item) => item.pluginId === WORKFLOW_PLUGIN_ID),
      false,
    )
  } finally {
    await env.close()
  }
})

test('builtin:triggers helmx.search: searches crons + webhooks with parseTriggerSelection targets, leaks ZERO secrets, and releases on disable', TIMEOUT, async () => {
  const env = await openTestApp()
  try {
    const webhookSecret = 'whsec_ultra_sensitive_secret_token_987654321'

    await env.app.kernel.plugins.invokeAction(TRIGGERS_PLUGIN_ID, 'cron_create', {
      id: 'nightly-audit',
      description: 'Nightly security sweep',
      schedule: '0 2 * * *',
      text: `Run audit and never expose ${webhookSecret}`,
      enabled: true,
    })
    await env.app.kernel.plugins.invokeAction(TRIGGERS_PLUGIN_ID, 'cron_create', {
      id: 'weekly-digest',
      description: 'Weekly engineering report',
      schedule: '30 9 * * 1',
      text: 'Summarize merged PRs',
      enabled: false,
    })
    await env.app.kernel.plugins.invokeAction(TRIGGERS_PLUGIN_ID, 'webhook_create', {
      id: 'github-deploy',
      description: 'GitHub release deployment hook',
      secret: webhookSecret,
    })

    const provider = findProvider(env.app, TRIGGERS_PLUGIN_ID)
    assert.ok(provider, 'builtin:triggers should provide helmx.search')

    // Cron search by schedule & id
    const cronHits = await provider.search({ query: 'nightly', limit: 8 }, new AbortController().signal)
    assert.equal(cronHits.length, 1)
    const cronHit = cronHits[0]!
    assert.equal(cronHit.kind, 'resource')
    assert.equal(cronHit.title, 'nightly-audit')
    assert.equal(cronHit.icon, 'clock')
    const cronParams = parseTargetQuery(cronHit.target, `screen:${TRIGGERS_PLUGIN_ID}/manager`)
    assert.equal(cronParams.get('tab'), 'cron')
    assert.equal(cronParams.get('trigger'), 'cron:nightly-audit')

    // Webhook search by id / path / description
    const hookHits = await provider.search({ query: 'github-deploy', limit: 8 }, new AbortController().signal)
    assert.equal(hookHits.length, 1)
    const hookHit = hookHits[0]!
    assert.equal(hookHit.kind, 'resource')
    assert.equal(hookHit.title, 'github-deploy')
    assert.equal(hookHit.icon, 'webhook')
    const hookParams = parseTargetQuery(hookHit.target, `screen:${TRIGGERS_PLUGIN_ID}/manager`)
    assert.equal(hookParams.get('tab'), 'webhook')
    assert.equal(hookParams.get('trigger'), 'webhook:github-deploy')

    // ZERO secret leaks: searching the secret yields 0 hits and NO hit serialization contains the secret
    const secretQueryHits = await provider.search({ query: webhookSecret, limit: 8 }, new AbortController().signal)
    assert.deepEqual(secretQueryHits, [], 'searching webhook secret must return zero hits (no oracle)')

    const allTriggerHits = await provider.search({ query: 'trigger', limit: 10 }, new AbortController().signal)
    assert.equal(allTriggerHits.length, 3)
    assert.equal(JSON.stringify(allTriggerHits).includes(webhookSecret), false, 'webhook secret must never appear in hits')

    // Limit enforcement across combined crons + webhooks
    const limited = await provider.search({ query: 'trigger', limit: 2 }, new AbortController().signal)
    assert.equal(limited.length, 2)

    // AbortSignal
    assert.deepEqual(await provider.search({ query: 'trigger', limit: 8 }, AbortSignal.abort()), [])

    // HTTP omnibox aggregation + secret check
    const httpRes = await queryOmniboxHttp(env, 'github-deploy')
    assert.ok(httpRes.pluginItems.some((i) => i.pluginId === TRIGGERS_PLUGIN_ID && i.target === hookHit.target))
    assert.equal(JSON.stringify(httpRes).includes(webhookSecret), false)

    // Disable releases capability cleanly
    await env.app.kernel.plugins.disable(TRIGGERS_PLUGIN_ID, { force: true })
    assert.equal(findProvider(env.app, TRIGGERS_PLUGIN_ID), undefined)
    const afterDisable = await queryOmniboxHttp(env, 'github-deploy')
    assert.equal(afterDisable.pluginItems.some((i) => i.pluginId === TRIGGERS_PLUGIN_ID), false)
  } finally {
    await env.close()
  }
})

test('builtin:tiers helmx.search: searches tiers + templates with valid ?edit= and ?tab=templates targets, respects limit/signal, and releases on disable', TIMEOUT, async () => {
  const env = await openTestApp()
  try {
    await env.app.kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'architect',
      model: 'faux/flagship',
      description: 'Deep design planning and execution',
    })
    await env.app.kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', {
      id: 'scout',
      model: 'faux/fast',
      description: 'Quick codebase exploration',
    })
    await env.app.kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'save_template', {
      id: 'eng-default',
      name: 'Daily Engineering',
      description: 'Balanced flagship and fast roster',
    })

    const provider = findProvider(env.app, TIERS_PLUGIN_ID)
    assert.ok(provider, 'builtin:tiers should provide helmx.search')

    // Search tier by id / model ref
    const tierHits = await provider.search({ query: 'architect', limit: 8 }, new AbortController().signal)
    const tierHit = tierHits.find((h) => h.id === 'tier:architect')
    assert.ok(tierHit, 'should find tier:architect')
    assert.equal(tierHit.kind, 'resource')
    assert.equal(tierHit.title, 'tier/architect')
    assert.equal(tierHit.icon, 'layers')
    const tierParams = parseTargetQuery(tierHit.target, `screen:${TIERS_PLUGIN_ID}/${TIERS_SCREEN_ID}`)
    assert.equal(tierParams.get('edit'), 'architect')

    // Search template by display name
    const tplHits = await provider.search({ query: 'Daily Engineering', limit: 8 }, new AbortController().signal)
    assert.equal(tplHits.length, 1)
    const tplHit = tplHits[0]!
    assert.equal(tplHit.id, 'template:eng-default')
    assert.equal(tplHit.title, 'Daily Engineering')
    const tplParams = parseTargetQuery(tplHit.target, `screen:${TIERS_PLUGIN_ID}/${TIERS_SCREEN_ID}`)
    assert.equal(tplParams.get('tab'), 'templates')

    // Limit & AbortSignal
    const limited = await provider.search({ query: 'faux/fast', limit: 1 }, new AbortController().signal)
    assert.equal(limited.length, 1)
    assert.deepEqual(await provider.search({ query: 'faux/fast', limit: 8 }, AbortSignal.abort()), [])

    // HTTP omnibox aggregation
    const httpRes = await queryOmniboxHttp(env, 'architect')
    assert.ok(httpRes.pluginItems.some((i) => i.pluginId === TIERS_PLUGIN_ID && i.target === tierHit.target))

    // Disable releases capability cleanly
    await env.app.kernel.plugins.disable(TIERS_PLUGIN_ID, { force: true })
    assert.equal(findProvider(env.app, TIERS_PLUGIN_ID), undefined)
    const afterDisable = await queryOmniboxHttp(env, 'architect')
    assert.equal(afterDisable.pluginItems.some((i) => i.pluginId === TIERS_PLUGIN_ID), false)
  } finally {
    await env.close()
  }
})

test('builtin:port-forward helmx.search: searches rules by name/node/ports with valid ?edit= targets, respects limit/signal, and releases on disable', TIMEOUT, async () => {
  const env = await openTestApp()
  try {
    const r1 = (await env.app.kernel.plugins.invokeAction(PORT_FORWARD_PLUGIN_ID, 'create', {
      name: 'Postgres Staging',
      nodeId: 'gpu-west-1',
      listenHost: '127.0.0.1',
      listenPort: 15432,
      targetHost: '10.0.0.12',
      targetPort: 5432,
      enabled: false,
    })) as { item: { id: string } }
    const r2 = (await env.app.kernel.plugins.invokeAction(PORT_FORWARD_PLUGIN_ID, 'create', {
      name: 'Redis Cache',
      nodeId: 'gpu-west-1',
      listenHost: '127.0.0.1',
      listenPort: 16379,
      targetHost: '127.0.0.1',
      targetPort: 6379,
      enabled: false,
    })) as { item: { id: string } }

    const provider = findProvider(env.app, PORT_FORWARD_PLUGIN_ID)
    assert.ok(provider, 'builtin:port-forward should provide helmx.search')

    // Search by label
    const byName = await provider.search({ query: 'Postgres', limit: 8 }, new AbortController().signal)
    assert.equal(byName.length, 1)
    const pgHit = byName[0]!
    assert.equal(pgHit.id, `rule:${r1.item.id}`)
    assert.equal(pgHit.kind, 'resource')
    assert.equal(pgHit.title, 'Postgres Staging')
    assert.equal(pgHit.icon, 'network')
    const pgParams = parseTargetQuery(pgHit.target, `screen:${PORT_FORWARD_PLUGIN_ID}/${PORT_FORWARD_SCREEN_ID}`)
    assert.equal(pgParams.get('edit'), r1.item.id)

    // Search by listenPort / remoteHost / nodeId
    const byPort = await provider.search({ query: '16379', limit: 8 }, new AbortController().signal)
    assert.equal(byPort.length, 1)
    assert.equal(byPort[0]!.id, `rule:${r2.item.id}`)

    const byRemoteHost = await provider.search({ query: '10.0.0.12', limit: 8 }, new AbortController().signal)
    assert.equal(byRemoteHost.length, 1)
    assert.equal(byRemoteHost[0]!.id, `rule:${r1.item.id}`)

    const byNodeLimited = await provider.search({ query: 'gpu-west-1', limit: 1 }, new AbortController().signal)
    assert.equal(byNodeLimited.length, 1)

    // AbortSignal
    assert.deepEqual(await provider.search({ query: 'gpu-west-1', limit: 8 }, AbortSignal.abort()), [])

    // HTTP omnibox aggregation
    const httpRes = await queryOmniboxHttp(env, '15432')
    assert.ok(httpRes.pluginItems.some((i) => i.pluginId === PORT_FORWARD_PLUGIN_ID && i.target === pgHit.target))

    // Disable releases capability cleanly
    await env.app.kernel.plugins.disable(PORT_FORWARD_PLUGIN_ID, { force: true })
    assert.equal(findProvider(env.app, PORT_FORWARD_PLUGIN_ID), undefined)
    const afterDisable = await queryOmniboxHttp(env, '15432')
    assert.equal(afterDisable.pluginItems.some((i) => i.pluginId === PORT_FORWARD_PLUGIN_ID), false)
  } finally {
    await env.close()
  }
})
