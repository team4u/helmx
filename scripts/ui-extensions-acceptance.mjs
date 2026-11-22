// Browser acceptance fixtures for UI extensions: real kernel/SQLite/PluginHost/HTTP/esbuild,
// zero model calls (no faux provider injected; the test plugins exercise only the UI/doc/action surface).
//
// Preconditions: pnpm build has run in this repo (packages/protocol/dist, packages/hub/dist,
// packages/kernel/dist and packages/web/dist exist).
//
// Usage:
//   node scripts/ui-extensions-acceptance.mjs
//     Starts the real Hub on a random port, writes login info (mode 0600) to
//     /tmp/helmx-ui-extensions-acceptance-info.json (or $HELMX_UI_EXT_ACCEPTANCE_INFO),
//     and stays running until SIGTERM/SIGINT for real browser interaction.
//   node scripts/ui-extensions-acceptance.mjs --check
//     Runs self-contained verification (plugin registration, current ctx.ui.action / client.tsx-only
//     settings.panel / plugin.slot contracts, HOST_SLOT_CATALOG alignment, client bundle compilation
//     over HTTP, action invocation + doc/sessionDoc updates), then shuts down and deletes dataDir.
//
// Covered surfaces (migrated from legacy ctx.ui.*Action and JSON-track specs to current contracts):
// - Parameterized Screen (props.params / isSplit / setParams / useScreenParams), usePluginDoc, usePluginSessionDoc;
// - PluginSlot (list multi-contributor ordering + inline slot + host slot COMPOSER_STATUS_SLOT);
// - composerPill, workbenchPanel, command (slash), multi-panel settingsPanel (client.tsx track);
// - Unified ctx.ui.action (conversation:header / conversation:row / timeline:entry).
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cliArgs = process.argv.slice(2)
if (cliArgs.includes('--help') || cliArgs.includes('-h')) {
  console.log('Usage: node scripts/ui-extensions-acceptance.mjs [--check]')
  process.exit(0)
}
const unknownArgs = cliArgs.filter((arg) => arg !== '--check')
if (unknownArgs.length > 0) {
  console.error(`Unknown argument(s): ${unknownArgs.join(' ')}`)
  console.error('Usage: node scripts/ui-extensions-acceptance.mjs [--check]')
  process.exit(2)
}
const checkOnly = cliArgs.includes('--check')

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const protocol = await import('../packages/protocol/dist/index.js')
const { createHelmx } = await import('../packages/hub/dist/app.js')
const { startHub } = await import('../packages/kernel/dist/http/index.js')

const {
  COMPOSER_DOCK_SLOT,
  COMPOSER_STATUS_SLOT,
  NODE_DETAIL_SECTION_SLOT,
  OVERVIEW_CARD_META_SLOT,
  PROFILE_DETAIL_SECTION_SLOT,
} = protocol

const CANONICAL_HOST_SLOT_TARGETS = [
  PROFILE_DETAIL_SECTION_SLOT,
  NODE_DETAIL_SECTION_SLOT,
  COMPOSER_STATUS_SLOT,
  COMPOSER_DOCK_SLOT,
  OVERVIEW_CARD_META_SLOT,
]

// 1. Isolated data dir (mkdtemp under the system temp dir; never reads or writes ~/.helmx or legacy system data)
const dataDir = await mkdtemp(join(tmpdir(), 'helmx-ui-ext-acceptance-'))

let app
let hub
let runtimeClosed = false

async function closeRuntime() {
  if (runtimeClosed) return
  runtimeClosed = true
  await hub?.close().catch(() => {})
  await app?.close().catch(() => {})
}

try {
  // 2. Real kernel: SQLite + PluginHost + the built-in esbuild client compiler all ready.
  //    No models injected: this fixture makes zero model calls (conversation creation and the
  //    UI/action surface do not depend on models).
  app = await createHelmx({ dataDir, cwd: projectRoot })

  // 3. Random test password for auth.setup (a UUID satisfies >=8 chars; the info JSON is written with mode 0600)
  const testPassword = crypto.randomUUID()
  const issued = await app.kernel.auth.setup(testPassword)

  // 4. Two non-root test conversations: the UI extension scope matches on the tag 'ui-ext'
  const mainConv = await app.kernel.createConversation({ title: 'UI 扩展验收主会话', tags: ['ui-ext'] })
  const auxConv = await app.kernel.createConversation({ title: 'UI 扩展验收辅助会话', tags: ['ui-ext'] })

  // 5. Owner plugin clientRoot: a real client.tsx inside the temp dir (esbuild compiles on
  //    demand; react/lucide/@helmx/plugin-client are virtualized by the compiler into the host's
  //    globally shared instances).
  const clientSrcDir = join(dataDir, 'client-src')
  await mkdir(join(clientSrcDir, 'parts'), { recursive: true })
  await writeFile(
    join(clientSrcDir, 'client.tsx'),
    [
      "import { useState } from 'react'",
      "import { Callout, PluginSlot, usePluginContext, usePluginDoc, usePluginSessionDoc, useScreenParams } from '@helmx/plugin-client'",
      "import { Plus, History, Gauge } from 'lucide-react'",
      "import { sessionNote } from './parts/note'",
      '',
      '// Screen: params/isSplit/setParams (deep links) + useScreenParams + <PluginSlot name="cards" /> + inline slot',
      'export function Screen(props) {',
      '  const [pushCount, setPushCount] = useState(0)',
      '  const status = usePluginDoc("status", "test:ui-owner")',
      '  const screenScope = useScreenParams()',
      '  return (',
      '    <div data-testid="owner-screen" style={{ display: \'flex\', flexDirection: \'column\', gap: 10 }}>',
      '      <p data-testid="screen-params">{JSON.stringify(props.params)}</p>',
      '      <p data-testid="screen-hook-params">{JSON.stringify(screenScope ? screenScope.params : null)}</p>',
      '      <p data-testid="screen-split">{String(props.isSplit)}</p>',
      '      <p data-testid="screen-doc">{JSON.stringify(status)}</p>',
      '      <p data-testid="screen-note">{sessionNote()}</p>',
      '      <div style={{ display: \'flex\', gap: 8 }}>',
      '        <button data-testid="set-filter" onClick={() => props.setParams({ filter: \'active\' })}><Plus size={12} />setParams replace</button>',
      '        <button data-testid="push-history" onClick={() => { props.setParams({ filter: `push-${pushCount + 1}` }, { push: true }); setPushCount(pushCount + 1) }}><History size={12} />setParams push</button>',
      '        <button data-testid="clear-filter" onClick={() => props.setParams({ filter: undefined })}>clear filter</button>',
      '      </div>',
      '      <div data-testid="owner-inline-slot">inline: <PluginSlot name="inline-meta" inline fallback={<span>no inline</span>} /></div>',
      '      <div data-testid="owner-cards"><PluginSlot name="cards" fallback={<span>no contributor</span>} /></div>',
      '    </div>',
      '  )',
      '}',
      '',
      '// composer.pill: read/write draft and attachment counts; never calls submit (avoids triggering model turns)',
      'export function ComposerPill(props) {',
      '  const composer = props.composer',
      '  const ctx = usePluginContext()',
      '  const [snap, setSnap] = useState(null)',
      '  if (composer === undefined) return <span data-testid="pill-no-composer">composer unavailable</span>',
      '  return (',
      '    <span data-testid="owner-pill" style={{ display: \'inline-flex\', gap: 6, alignItems: \'center\' }}>',
      '      <button data-testid="pill-insert" onClick={() => composer.insertText("[ui-ext]")}>insert</button>',
      '      <button data-testid="pill-setdraft" onClick={() => composer.setDraft("draft-by-pill")}>setDraft</button>',
      '      <button data-testid="pill-snapshot" onClick={() => setSnap({ draft: composer.draft, attachments: composer.attachments.length })}>snapshot</button>',
      '      {snap !== null && <span data-testid="pill-snap-result">{snap.draft}|{snap.attachments}</span>}',
      '      <span data-testid="pill-ctx-plugin">{ctx.pluginId}</span>',
      '    </span>',
      '  )',
      '}',
      '',
      '// workbench.panel: usePluginSessionDoc renders the current conversation metrics; the button invokes this plugin increment',
      'export function MetricsPanel(props) {',
      '  const ctx = usePluginContext()',
      '  const doc = usePluginSessionDoc("metrics")',
      '  const conversationId = props.conversation.id',
      '  const onIncrement = () => { void ctx.callAction("increment", { conversationId, delta: 1 }).catch((error) => ctx.notify(String(error), "error")) }',
      '  return (',
      '    <div data-testid="owner-panel" style={{ display: \'flex\', flexDirection: \'column\', gap: 6 }}>',
      '      <span style={{ display: \'flex\', alignItems: \'center\', gap: 4 }}><Gauge size={12} />会话 {conversationId} metrics</span>',
      '      <span data-testid="panel-count">{String(doc && doc.count)}</span>',
      '      <button data-testid="panel-increment" onClick={onIncrement}>',
      '        <Plus size={12} />increment',
      '      </button>',
      '    </div>',
      '  )',
      '}',
      '',
      '// settings.panel (client.tsx track): multi-panel ordering check in PluginDetailDrawer',
      'export function OwnerSettingsPrimary() {',
      '  return (',
      '    <div data-testid="owner-settings-primary">',
      '      <Callout title="test:ui-owner">',
      '        <span>owner 插件设置面板（第一块，client.tsx 轨道）。</span>',
      '      </Callout>',
      '    </div>',
      '  )',
      '}',
      '',
      'export function OwnerSettingsSecondary() {',
      '  return (',
      '    <div data-testid="owner-settings-secondary">',
      '      <Callout title="第二面板">',
      '        <span>同插件多 settings.panel 渲染验收（order 排序）。</span>',
      '      </Callout>',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n'),
  )
  await writeFile(join(clientSrcDir, 'parts', 'note.ts'), "export const sessionNote = () => 'owner client.tsx 本地依赖已编译'\n")

  // 6. Owner plugin: a public global status doc + public sessionDoc('metrics', {count:0})
  //    + increment / bump_status actions + Screen / workbench panel / composerPill /
  //    header & row ctx.ui.action (scope matched on 'ui-ext') / two client.tsx settings panels.
  await app.kernel.plugins.register({
    id: 'test:ui-owner',
    name: 'UI 扩展验收 owner',
    version: '1.0.0',
    clientRoot: clientSrcDir,
    definePlugin(ctx) {
      // Public global doc for cross-plugin usePluginDoc testing
      const status = ctx.doc('status', { source: 'test:ui-owner', ok: true, revisions: 0 }, { public: true })
      // Conversation-scoped projected doc: initial { count: 0 }
      const metrics = ctx.sessionDoc('metrics', { count: 0 }, { public: true })
      ctx.action({
        id: 'increment',
        description: '会话 metrics 计数（sessionDoc 写路径验收）',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: { type: 'integer', minimum: 1 },
            delta: { type: 'integer' },
          },
          required: ['conversationId'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { conversationId: { type: 'integer' }, count: { type: 'integer' } },
          required: ['conversationId', 'count'],
        },
        handler(input) {
          const delta = typeof input.delta === 'number' && Number.isSafeInteger(input.delta) ? input.delta : 1
          let next = 0
          metrics.update(input.conversationId, (current) => {
            next = (typeof current.count === 'number' ? current.count : 0) + delta
            return { count: next }
          })
          return { conversationId: input.conversationId, count: next }
        },
      })
      ctx.action({
        id: 'bump_status',
        description: '全局 status doc 计数（跨插件 usePluginDoc 与微操作写路径验收）',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: { type: 'integer', minimum: 1 },
            entryId: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
        outputSchema: { type: 'object', properties: { revisions: { type: 'integer' } }, required: ['revisions'] },
        handler() {
          let revisions = 0
          status.update((current) => {
            revisions = current.revisions + 1
            return { ...current, revisions }
          })
          return { revisions }
        },
      })
      ctx.ui.sidebarItem({ id: 'ui-ext-entry', label: 'UI 扩展验收', icon: 'layers', target: 'screen:test:ui-owner/main' })
      ctx.ui.screen({ id: 'main', label: 'UI 扩展验收主屏', client: { module: 'client.tsx', export: 'Screen' } })
      ctx.ui.workbenchPanel({
        id: 'metrics',
        label: '会话 metrics',
        icon: 'activity',
        client: { module: 'client.tsx', export: 'MetricsPanel' },
      })
      // Slash command: actionId='increment', input explicitly fills the test conversation id
      ctx.ui.command({
        id: 'metrics-increment',
        title: '会话 metrics 计数 +1',
        slash: 'ui-metrics',
        description: '对 UI 扩展验收主会话执行 increment（slash 命令）',
        icon: 'plus',
        actionId: 'increment',
        input: { conversationId: mainConv.id, delta: 1 },
        keywords: ['ui', 'metrics', 'session-doc'],
      })
      // Two client.tsx settings panels from the same plugin (multi-panel order sorting acceptance)
      ctx.ui.settingsPanel({
        id: 'owner-settings',
        label: 'owner 验收说明',
        order: 10,
        client: { module: 'client.tsx', export: 'OwnerSettingsPrimary' },
      })
      ctx.ui.settingsPanel({
        id: 'owner-settings-more',
        label: 'owner 第二面板',
        order: 20,
        client: { module: 'client.tsx', export: 'OwnerSettingsSecondary' },
      })
    },
  })

  // 7. Contributor plugin: injects two client.tsx cards (order 10 + order 20) into test:ui-owner/cards,
  //    an inline badge into test:ui-owner/inline-meta, a host composer status pill into
  //    COMPOSER_STATUS_SLOT, and a cross-plugin timeline:entry micro-action.
  const contributorSrcDir = join(dataDir, 'contributor-src')
  await mkdir(contributorSrcDir, { recursive: true })
  await writeFile(
    join(contributorSrcDir, 'client.tsx'),
    [
      "import { useState } from 'react'",
      "import { usePluginContext, usePluginDoc } from '@helmx/plugin-client'",
      "import { Boxes, ArrowRight } from 'lucide-react'",
      '',
      '// Injected into the owner <PluginSlot name="cards" /> (order 10): contributor context + cross-plugin action / doc',
      'export function ContributorCard(props) {',
      '  const ctx = usePluginContext()',
      '  const ownerStatus = usePluginDoc("status", "test:ui-owner")',
      '  const [result, setResult] = useState(null)',
      '  const onCross = () => {',
      '    void ctx.callAction("bump_status", {}, { pluginId: "test:ui-owner" })',
      '      .then((r) => setResult(JSON.stringify(r)))',
      '      .catch((error) => setResult(String(error)))',
      '  }',
      '  return (',
      '    <div data-testid="contributor-card" style={{ border: \'1px solid #ccc\', padding: 8, display: \'flex\', flexDirection: \'column\', gap: 6 }}>',
      '      <span style={{ display: \'flex\', alignItems: \'center\', gap: 4 }}><Boxes size={12} />contributor: {ctx.pluginId}</span>',
      '      <span data-testid="contributor-slot-props">{JSON.stringify(props)}</span>',
      '      <span data-testid="contributor-owner-doc">{JSON.stringify(ownerStatus)}</span>',
      '      <button data-testid="contributor-cross-action" onClick={onCross}><ArrowRight size={12} />跨插件 bump_status</button>',
      '      {result !== null && <span data-testid="contributor-cross-result">{result}</span>}',
      '    </div>',
      '  )',
      '}',
      '',
      '// Second client.tsx card in <PluginSlot name="cards" /> (order 20): replaces legacy JSON-track slot',
      'export function ContributorSecondaryCard() {',
      '  const ctx = usePluginContext()',
      '  return (',
      '    <div data-testid="contributor-secondary-card" className="card" style={{ padding: 8, display: \'flex\', flexDirection: \'column\', gap: 4 }}>',
      '      <strong>client 轨次级贡献卡</strong>',
      '      <span>{ctx.pluginId} 经 ctx.ui.slot (client.tsx, order=20) 注入。</span>',
      '    </div>',
      '  )',
      '}',
      '',
      '// Inline slot contribution rendered inside <PluginSlot name="inline-meta" inline />',
      'export function ContributorInlineBadge() {',
      '  return <span data-testid="contributor-inline-badge" className="badge badge-neutral">inline-slot</span>',
      '}',
      '',
      '// Host slot contribution targeting COMPOSER_STATUS_SLOT (scoped to ui-ext conversations)',
      'export function ContributorComposerStatus(props) {',
      '  const ownerStatus = usePluginDoc("status", "test:ui-owner")',
      '  if (!props.conversation) return null',
      '  const revisions = ownerStatus && typeof ownerStatus.revisions === \'number\' ? ownerStatus.revisions : 0',
      '  return (',
      '    <span data-testid="contributor-composer-status" className="badge badge-neutral">',
      '      ui-ext rev:{revisions}',
      '    </span>',
      '  )',
      '}',
      '',
    ].join('\n'),
  )
  await app.kernel.plugins.register({
    id: 'test:ui-contributor',
    name: 'UI 扩展验收 contributor',
    version: '1.0.0',
    clientRoot: contributorSrcDir,
    definePlugin(ctx) {
      // client.tsx-track contribution cards (order 10 sorts before order 20; slot requires client)
      ctx.ui.slot({
        id: 'react-card',
        target: 'test:ui-owner/cards',
        order: 10,
        client: { module: 'client.tsx', export: 'ContributorCard' },
      })
      ctx.ui.slot({
        id: 'secondary-card',
        target: 'test:ui-owner/cards',
        order: 20,
        client: { module: 'client.tsx', export: 'ContributorSecondaryCard' },
      })
      ctx.ui.slot({
        id: 'inline-badge',
        target: 'test:ui-owner/inline-meta',
        order: 10,
        client: { module: 'client.tsx', export: 'ContributorInlineBadge' },
      })
      ctx.ui.slot({
        id: 'composer-status-pill',
        target: COMPOSER_STATUS_SLOT,
        order: 50,
        scope: { tags: ['ui-ext'] },
        client: { module: 'client.tsx', export: 'ContributorComposerStatus' },
      })
    },
  })

  // 8. startHub: port 0 (random port; never occupies 3201/3202 or 3000/3001/3002/3101/3102),
  //    webDistDir explicitly points at this worktree's build output (a missing dir makes
  //    startHub fail explicitly with web_dist_invalid).
  hub = await startHub({ kernel: app.kernel, port: 0, webDistDir: join(projectRoot, 'packages/web/dist') })

  if (checkOnly) {
    await runSelfCheck({ app, hub, token: issued.token, mainConvId: mainConv.id })
    console.log('UI extension acceptance --check passed.')
  } else {
    // 9. Info JSON (mode 0600): default /tmp/helmx-ui-extensions-acceptance-info.json
    const infoPath = process.env.HELMX_UI_EXT_ACCEPTANCE_INFO ?? '/tmp/helmx-ui-extensions-acceptance-info.json'
    await writeFile(
      infoPath,
      JSON.stringify(
        {
          url: hub.url,
          token: issued.token,
          password: testPassword,
          dataDir,
          conversations: { main: mainConv.id, aux: auxConv.id },
          plugins: ['test:ui-owner', 'test:ui-contributor'],
          clientRoots: { owner: clientSrcDir, contributor: contributorSrcDir },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )

    console.log(`UI extension acceptance service ready: ${hub.url}`)
    console.log(`Test conversations: main=${mainConv.id} aux=${auxConv.id} (both tagged ui-ext; root conversation #1 untouched)`)
    console.log(`Plugins: test:ui-owner / test:ui-contributor; data dir ${dataDir}`)
    console.log(`Login info JSON (0600): ${infoPath}`)
    console.log('Service keeps running; SIGTERM/SIGINT shut it down gracefully.')

    // 10. Graceful shutdown: close the hub first (severing SSE/in-flight requests), then the
    //     kernel (SQLite flushed to disk); this fixture controls no Herdr/terminal panes.
    await new Promise((resolve) => {
      const shutdown = async () => {
        try {
          await closeRuntime()
        } finally {
          resolve()
        }
      }
      for (const signal of ['SIGTERM', 'SIGINT']) {
        process.once(signal, () => {
          void shutdown()
        })
      }
    })
  }
} catch (error) {
  await closeRuntime()
  throw error
} finally {
  if (checkOnly) {
    await closeRuntime()
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function runSelfCheck({ app: activeApp, hub: activeHub, token, mainConvId }) {
  const authHeaders = { authorization: `Bearer ${token}` }

  // 1) Verify plugins and client hashes are active
  const pluginList = await activeApp.kernel.plugins.list()
  const ownerSummary = pluginList.find((p) => p.id === 'test:ui-owner')
  const contribSummary = pluginList.find((p) => p.id === 'test:ui-contributor')
  assert.ok(ownerSummary?.enabled && ownerSummary.status === 'active', 'test:ui-owner must be active')
  assert.ok(contribSummary?.enabled && contribSummary.status === 'active', 'test:ui-contributor must be active')
  assert.ok(typeof ownerSummary.clientHashes?.['client.tsx'] === 'string' && ownerSummary.clientHashes['client.tsx'].length > 0)
  assert.ok(typeof contribSummary.clientHashes?.['client.tsx'] === 'string' && contribSummary.clientHashes['client.tsx'].length > 0)

  // 2) Verify UI contributions against current ctx.ui contracts and HOST_SLOT_CATALOG / plugin.slot client rule
  const fixtureUi = activeApp.kernel.plugins
    .listUi()
    .filter((u) => u.pluginId === 'test:ui-owner' || u.pluginId === 'test:ui-contributor')
  const ownerUi = fixtureUi.filter((u) => u.pluginId === 'test:ui-owner')
  const contributorUi = fixtureUi.filter((u) => u.pluginId === 'test:ui-contributor')
  assert.equal(ownerUi.length, 6, 'expected 6 owner UI contributions')
  assert.equal(contributorUi.length, 4, 'expected 4 contributor UI contributions')

  const hostSlotSet = new Set(
    Array.isArray(protocol.HOST_SLOT_TARGETS) ? protocol.HOST_SLOT_TARGETS : CANONICAL_HOST_SLOT_TARGETS,
  )
  assert.deepEqual([...hostSlotSet], CANONICAL_HOST_SLOT_TARGETS)
  if (Array.isArray(protocol.HOST_SLOT_CATALOG)) {
    assert.deepEqual(
      protocol.HOST_SLOT_CATALOG.map((entry) => entry.target),
      CANONICAL_HOST_SLOT_TARGETS,
    )
  }

  for (const item of fixtureUi) {
    const spec = item.spec
    assert.equal('json' in spec, false, `${item.pluginId}/${spec.id} must not declare legacy json spec`)
    if (item.surface === 'plugin.slot' || item.surface === 'settings.panel') {
      assert.ok(
        spec.client && typeof spec.client.module === 'string' && typeof spec.client.export === 'string',
        `${item.pluginId}/${spec.id} (${item.surface}) must declare client { module, export }`,
      )
    }
    if (item.surface === 'plugin.slot') {
      assert.match(spec.target, /^[A-Za-z0-9:_-]+\/[A-Za-z0-9._-]+$/, `valid slot target: ${spec.target}`)
      if (spec.target.startsWith('builtin:')) {
        assert.ok(hostSlotSet.has(spec.target), `builtin slot target must belong to HOST_SLOT_CATALOG: ${spec.target}`)
      }
    }
  }

  // 3) Verify HTTP serving of webDistDir, plugin list, and compiled client.tsx bundles
  const htmlRes = await fetch(`${activeHub.url}/`)
  assert.equal(htmlRes.status, 200)
  assert.match(htmlRes.headers.get('content-type') ?? '', /text\/html/)

  const pluginsRes = await fetch(`${activeHub.url}/api/plugins`, { headers: authHeaders })
  assert.equal(pluginsRes.status, 200)
  const pluginsJson = await pluginsRes.json()
  assert.ok(Array.isArray(pluginsJson) && pluginsJson.some((p) => p.id === 'test:ui-owner'))

  for (const [pluginId, expectedExports] of [
    ['test:ui-owner', ['Screen', 'ComposerPill', 'MetricsPanel', 'OwnerSettingsPrimary', 'OwnerSettingsSecondary']],
    ['test:ui-contributor', ['ContributorCard', 'ContributorSecondaryCard', 'ContributorInlineBadge', 'ContributorComposerStatus']],
  ]) {
    const res = await fetch(
      `${activeHub.url}/api/plugins/${encodeURIComponent(pluginId)}/client.mjs?module=client.tsx`,
      { headers: authHeaders },
    )
    assert.equal(res.status, 200, `client.mjs fetch failed for ${pluginId}`)
    const bundleCode = await res.text()
    for (const exportName of expectedExports) {
      assert.match(bundleCode, new RegExp(`\\b${exportName}\\b`), `${pluginId} bundle must export ${exportName}`)
    }
  }

  // 4) Verify action endpoints + sessionDoc / public doc updates (including micro-action injected fields)
  const incRes = await fetch(`${activeHub.url}/api/actions/${encodeURIComponent('test:ui-owner')}/increment`, {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ input: { conversationId: mainConvId, delta: 2 } }),
  })
  assert.equal(incRes.status, 200)
  assert.deepEqual(await incRes.json(), { conversationId: mainConvId, count: 2 })

  const metricsDocRes = await fetch(
    `${activeHub.url}/api/plugins/${encodeURIComponent('test:ui-owner')}/docs/metrics?conversationId=${mainConvId}`,
    { headers: authHeaders },
  )
  assert.equal(metricsDocRes.status, 200)
  const metricsDoc = await metricsDocRes.json()
  assert.deepEqual(metricsDoc.value, { count: 2 })

  for (const [step, payload] of [
    [1, {}],
    [2, { conversationId: mainConvId }],
    [3, { conversationId: mainConvId, entryId: 'entry-check-1' }],
  ]) {
    const bumpRes = await fetch(`${activeHub.url}/api/actions/${encodeURIComponent('test:ui-owner')}/bump_status`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ input: payload }),
    })
    assert.equal(bumpRes.status, 200, `bump_status step ${step} failed`)
    assert.deepEqual(await bumpRes.json(), { revisions: step })
  }

  const statusDocRes = await fetch(
    `${activeHub.url}/api/plugins/${encodeURIComponent('test:ui-owner')}/docs/status`,
    { headers: authHeaders },
  )
  assert.equal(statusDocRes.status, 200)
  const statusDoc = await statusDocRes.json()
  assert.deepEqual(statusDoc.value, { source: 'test:ui-owner', ok: true, revisions: 3 })
}
