/**
 * Helmx kernel service layer tests: real filesystem behavior without fake runtimes.
 * Covers: paths/atomic-file, profiles/skills (traversal & symlink rejection), watcher,
 * SecretStash isolation, AuthService scrypt/tokens, credentials 0600 without leaks,
 * and ArtifactService spill thresholds & UTF-8 safety.
 */
import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, symlink, writeFile, rm, realpath, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HelmxError,
  PLUGIN_UI_METHOD_NAMES,
  PLUGIN_HOOK_NAMES,
  RESERVED_SLASH_COMMANDS,
  UI_SHARED_EXPORTS,
  PLUGIN_CLIENT_SHARED_EXPORTS,
  CORE_CLI_COMMAND_PATHS,
  parseSkillFrontmatter,
} from '@helmx/protocol'
import {
  APP_BUILDER_FULLSTACK_TEMPLATE_MD,
  APP_BUILDER_SKILL_ASSET,
  APP_BUILDER_SKILL_ID,
  APP_BUILDER_SKILL_MD,
  APP_BUILDER_SKILL_OWNER,
  CONVERSATIONS_SKILL_ASSET,
  CONVERSATIONS_SKILL_ID,
  CONVERSATIONS_SKILL_MD,
  CONVERSATIONS_SKILL_OWNER,
  CORE_MANAGED_SKILLS,
  HELMX_CLI_SKILL_MD,
  HELMX_CLI_SKILL_AND_PLUGIN_DEV_MD,
  HELMX_CLI_SKILL_ASSET,
  HELMX_CLI_SKILL_ID,
  HELMX_CLI_SKILL_OWNER,
  HELMX_CLI_UI_HIG_MD,
  HELMX_UI_HIG_BODY_MD,
  HELMX_UI_HIG_PATTERNS_MD,
  PROFILES_SKILL_ASSET,
  PROFILES_SKILL_ID,
  PROFILES_SKILL_MD,
  PROFILES_SKILL_OWNER,
  bootstrapCoreSkills,
  renderSkillTemplate,
} from '../src/runtime/core-skills/index.js'
import { KernelRuntime } from '../src/runtime/index.js'
import { scanPluginTsxUiHygiene } from '../src/plugins/plugin-ui-hygiene.js'
import { MANAGED_EXEC_ENV_VARS } from '../src/env/scoped-env.js'
import { MemoryStore } from '../../plugins/src/memory/store.js'
import { createProfileFileHost } from './helpers/profile-file-host.js'
import { assert } from './helpers.js'
import { waitFor } from './helpers.js'
import {
  ArtifactService,
  AssetWatcher,
  AuthService,
  ConfigService,
  CredentialService,
  InMemoryArtifactRepository,
  ProfileService,
  ProviderService,
  type ProviderConfig,
  SecretStash,
  SkillService,
  atomicWriteFile,
  atomicWriteJson,
  ensureDataDir,
  isPrivateMode,
  readJsonFile,
  readTextFile,
  resolveDataDir,
  withProcessFileLock,
} from '../src/services/index.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const scratchRoot = await mkdtemp(join(tmpdir(), 'helmx-svc-e2e-'))
let scratchSeq = 0

/** Isolated temporary dataDir per test (real file semantics). */
async function freshDataDir(): Promise<string> {
  scratchSeq += 1
  const dir = join(scratchRoot, String(scratchSeq))
  await mkdir(dir, { recursive: true })
  return dir
}

/** Temporary source file for register/spill tests. */
async function tempSourceFile(content: string | Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'helmx-src-'))
  const path = join(dir, `src-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await writeFile(path, content)
  return path
}

/** Assert promise rejects with error matching regex (suppresses unhandled rejection noise). */
async function expectReject(fn: () => Promise<unknown>, re: RegExp): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    assert.match(String(err), re)
    return err
  }
  assert.fail(`expected error matching: ${re}`)
}

// ---------------------------------------------------------------------------
// paths.ts
// ---------------------------------------------------------------------------
test('paths: resolveDataDir priority (override > env > default) and ensureDataDir directory layout', { timeout: 60_000 }, async () => {
  const dir = await freshDataDir()
  assert.equal(resolveDataDir(dir), dir)
  const prev = process.env.HELMX_DATA_DIR
  const envDir = join(scratchRoot, 'env-dir')
  process.env.HELMX_DATA_DIR = envDir
  try {
    assert.equal(resolveDataDir(), envDir)
    assert.equal(resolveDataDir(dir), dir)
  } finally {
    if (prev === undefined) delete process.env.HELMX_DATA_DIR
    else process.env.HELMX_DATA_DIR = prev
  }
  assert.throws(() => resolveDataDir(''), /empty/)
  assert.throws(() => resolveDataDir('relative/path'), /absolute path/)
  await ensureDataDir(dir)
  for (const sub of ['profiles', 'skills', 'plugins', 'installed-plugins', 'artifacts', 'cache']) {
    assert.ok(existsSync(join(dir, sub)), `should create ${sub}`)
  }
  assert.ok(!existsSync(join(dir, 'workflows')), 'workflows dir belongs to builtin:workflow, not kernel dataDir layout')
  await ensureDataDir(dir)
})

// ---------------------------------------------------------------------------
// atomic-file.ts
// ---------------------------------------------------------------------------
test('atomic-file: atomic writes leave no tmp files, enforce 0600, and surface JSON errors', { timeout: 60_000 }, async () => {
  const dir = await freshDataDir()
  const path = join(dir, 'profiles', 'p1', 'MEMORY.md')
  await atomicWriteFile(path, 'hello 世界')
  assert.equal(await readTextFile(path), 'hello 世界')
  assert.deepEqual(await readdir(dirname(path)), ['MEMORY.md'])
  assert.ok(await isPrivateMode(path))
  await atomicWriteFile(path, 'second')
  assert.equal(await readTextFile(path), 'second')

  const jsonPath = join(dir, 'config.json')
  await atomicWriteJson(jsonPath, { a: 1 })
  assert.deepEqual(await readJsonFile(jsonPath), { a: 1 })

  await assert.rejects(() => readJsonFile(join(dir, 'nope.json')), /nope\.json/)
  await writeFile(join(dir, 'bad.json'), '{oops')
  await assert.rejects(() => readJsonFile(join(dir, 'bad.json')), /bad\.json/)
})

// ---------------------------------------------------------------------------
// ProfileService
// ---------------------------------------------------------------------------
test('profiles: ensureDefault leaves model empty, skips overwriting existing entries, enforces CRUD and default protection', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const profiles = new ProfileService(dataDir)
  const p = await profiles.ensureDefault()
  assert.equal(p.id, 'assistant')
  assert.equal(p.model, undefined) // unconfigured default triggers explicit runtime error
  assert.ok(p.tags?.includes('assistant'))
  assert.ok((await profiles.getSystem('assistant')).length > 0)

  // Subsequent ensureDefault preserves user edits (including model selection)
  await profiles.save({ ...p, model: 'openai/gpt-4o', name: 'assistant', tags: ['assistant'] })
  const again = await profiles.ensureDefault()
  assert.equal(again.model, 'openai/gpt-4o')

  // list / get / save / delete
  await profiles.save({ id: 'worker', name: 'worker', tags: ['worker'] })
  const ids = (await profiles.list()).map((x) => x.id)
  assert.ok(ids.includes('assistant') && ids.includes('worker'))
  assert.notEqual((await profiles.get('worker'))?.name, undefined)

  await profiles.delete('worker')
  assert.equal(await profiles.get('worker'), undefined)

  // default item protection + invalid id
  await assert.rejects(() => profiles.delete('assistant'), /cannot be deleted/)
  await assert.rejects(() => profiles.get('../etc'), /illegal profile id/)
  await assert.rejects(
    () => profiles.save({ id: 'UPPER', name: 'x', model: '', tags: [] }),
    /illegal profile id/,
  )
  await assert.rejects(
    () => profiles.save({ id: 'ok1', name: '', tags: [] }),
    /name/,
  )
})

test('profiles: save never reads or writes MEMORY.md (memory owned by builtin:memory)', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()
  await profiles.save({ id: 'writer', name: 'writer', tags: [] })
  const entries = await readdir(join(dataDir, 'profiles', 'writer'))
  assert.ok(!entries.includes('MEMORY.md'), 'ProfileService.save must not create MEMORY.md')
  // Legacy memory field is rejected explicitly at ProfileService boundary (no silent stripping).
  await assert.rejects(
    () => profiles.save({ id: 'writer2', name: 'writer2', tags: [], memory: '# old field' } as never),
    /unknown field 'memory'/i,
  )
  assert.ok(!existsSync(join(dataDir, 'profiles', 'writer2', 'MEMORY.md')))
})

// ---------------------------------------------------------------------------
// SkillService
// ---------------------------------------------------------------------------
async function seedSkill(dataDir: string, id: string, refs: string[] = []): Promise<void> {
  const dir = join(dataDir, 'skills', id)
  await mkdir(join(dir, 'references'), { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${id} skill\ndescription: used to test ${id}\n---\n\nbody text content.\n`,
  )
  for (const rel of refs) {
    const full = join(dir, rel)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, `# ${rel}\nsee content.\n`)
  }
}

test('skills: list returns references paths; readFile defaults to SKILL.md and reads nested files', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const skills = new SkillService(dataDir)
  await seedSkill(dataDir, 'demo', ['references/guide.md', 'references/rules/table.md'])

  const list = await skills.list()
  assert.equal(list.length, 1)
  assert.equal(list[0]!.id, 'demo')
  assert.deepEqual(list[0]!.references, [
    'references/guide.md',
    'references/rules/table.md',
  ])

  const main = await skills.readFile('demo')
  assert.ok(main.includes('body text content'))
  const ref = await skills.readFile('demo', 'references/guide.md')
  assert.ok(ref.includes('see content'))
  const nested = await skills.readFile('demo', 'references/rules/table.md')
  assert.ok(nested.includes('table'))
})

test('skills: strictly rejects absolute paths, .. traversal, backslashes, and symlink escapes', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const skills = new SkillService(dataDir)
  await seedSkill(dataDir, 'demo', ['references/guide.md'])

  await assert.rejects(() => skills.readFile('demo', '/etc/passwd'), /absolute path/)
  await assert.rejects(() => skills.readFile('demo', 'references/../../etc/passwd'), /path traversal|out of bounds|illegal/)
  await assert.rejects(() => skills.readFile('demo', '..'), /path traversal|illegal|path/)
  await assert.rejects(() => skills.readFile('demo', 'references\\..\\secret'), /backslash|illegal/)
  await assert.rejects(() => skills.readFile('demo', ''), /path cannot be empty/)

  // Symlink escape: references/evil.md -> outside dataDir
  const outside = join(scratchRoot, 'outside-secret.md')
  await writeFile(outside, 'secret external content')
  await symlink(outside, join(dataDir, 'skills', 'demo', 'references', 'evil.md'))
  await assert.rejects(
    () => skills.readFile('demo', 'references/evil.md'),
    /symlink/,
  )
  const list = await skills.list()
  const refs = list[0]!.references
  assert.ok(!refs.includes('references/evil.md'), 'symlinks must not appear in skill catalog')

  // Symlinked skill directory pointing outside skills root rejected via two-layer realpath check
  const evilSkill = join(scratchRoot, 'evil-skill')
  await mkdir(join(evilSkill, 'references'), { recursive: true })
  await writeFile(join(evilSkill, 'SKILL.md'), 'malicious skill')
  await symlink(evilSkill, join(dataDir, 'skills', 'evil-link'))
  await assert.rejects(
    () => skills.readFile('evil-link'),
    /symlink|out of bounds/,
  )

  // Internal symlink skill directory rejected segment-by-segment despite realpath landing inside
  await symlink(join(dataDir, 'skills', 'demo'), join(dataDir, 'skills', 'inner-link'))
  await assert.rejects(
    () => skills.readFile('inner-link'),
    /symlink|out of bounds/,
  )
  await assert.rejects(() => skills.readFile('../demo'), /illegal skill id/)
})

test('profiles: SYSTEM_DEFAULT Layer 0 retains artifact rule without hardcoded plugin names or UI catalogs', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()
  const system = await profiles.getSystem('assistant')
  assert.ok(system.includes('# System Prompt'))
  for (const component of ['MetricGrid', 'CheckboxGroup', 'ActionBar', 'BarList', 'KeyValueList', 'Accordion', 'helmx:action', 'helmx:open', 'helmx:send']) {
    assert.ok(!system.includes(component), `SYSTEM_DEFAULT must not contain Layer 2 details: ${component}`)
  }
  for (const name of ['helmx-cli', 'load_skill', 'generative-ui', 'app-builder']) {
    assert.ok(!system.includes(name), `SYSTEM_DEFAULT must not hardcode plugin skills or tools: ${name}`)
  }
  assert.ok(system.includes('artifact:<id>'), 'must retain artifact registration and inline render rule')
})

test('helmx-cli skill assets stay synchronized with UI extensions and runtime capabilities (drift guard)', { timeout: 60_000 }, () => {
  assert.ok(!HELMX_CLI_SKILL_MD.includes('references/generative-ui.md'), 'must not reference migrated generative-ui.md')
  assert.ok(!Object.hasOwn(HELMX_CLI_SKILL_ASSET.references, 'workflows-and-agents.md'), 'workflow reference belongs to builtin:workflow, not helmx-cli')
  assert.ok(!HELMX_CLI_SKILL_MD.includes('helmx workflows'), 'workflow CLI guidance belongs to builtin:workflow, not helmx-cli')
  assert.ok(HELMX_CLI_SKILL_MD.includes("the current turn's available skill descriptions"), 'available skill catalog must drive extension docs')
  for (const optionalSkill of ['generative-ui', 'app-builder']) {
    assert.ok(!HELMX_CLI_SKILL_MD.includes(optionalSkill), `core CLI skill must not name optional skill ${optionalSkill}`)
  }

  assert.ok(HELMX_CLI_SKILL_MD.includes('--conversation'), 'SKILL.md should document --conversation for session doc reads')
  assert.ok(HELMX_CLI_SKILL_MD.includes('--watch'), 'SKILL.md should document --watch subscriptions')

  assert.ok(
    HELMX_CLI_SKILL_AND_PLUGIN_DEV_MD.includes(`Frontend ${PLUGIN_UI_METHOD_NAMES.length} ctx.ui registration methods`),
    `should document ${PLUGIN_UI_METHOD_NAMES.length} ctx.ui registration methods`,
  )
  for (const method of PLUGIN_UI_METHOD_NAMES) {
    assert.ok(
      HELMX_CLI_SKILL_AND_PLUGIN_DEV_MD.includes(method),
      `plugin-dev reference must include ctx.ui registration method ${method}`,
    )
  }

  for (const hook of PLUGIN_HOOK_NAMES) {
    assert.ok(
      HELMX_CLI_SKILL_AND_PLUGIN_DEV_MD.includes(hook),
      `plugin-dev reference must include backend hook ${hook}`,
    )
  }

  for (const slash of RESERVED_SLASH_COMMANDS) {
    assert.ok(
      HELMX_CLI_SKILL_AND_PLUGIN_DEV_MD.includes(slash),
      `plugin-dev reference must include reserved slash command ${slash}`,
    )
  }

  for (const exportName of UI_SHARED_EXPORTS) {
    assert.ok(
      HELMX_CLI_SKILL_AND_PLUGIN_DEV_MD.includes(exportName),
      `plugin-dev reference must include @helmx/ui export ${exportName}`,
    )
  }

  for (const exportName of PLUGIN_CLIENT_SHARED_EXPORTS) {
    assert.ok(
      HELMX_CLI_SKILL_AND_PLUGIN_DEV_MD.includes(exportName),
      `plugin-dev reference must include @helmx/plugin-client export ${exportName}`,
    )
  }

  for (const api of [
    'ctx.sessionDoc',
    'composer',
    'ctx.host.forkConversation(id, { entryId?, title? })',
    'fork_empty_history',
    'useTimelineToolCalls',
    'TimelineToolCallSummary',
    'PluginToolResultEnvelope',
    'structuredOutputSchema',
    'presentationMeta',
    'presentationMetaSchema',
    'projectPresentationMeta',
    'visibility',
    'callerPluginId',
    'formatOutput',
    '64 KiB UTF-8',
    'depth 12',
    '2000 nodes',
  ]) {
    assert.ok(HELMX_CLI_SKILL_AND_PLUGIN_DEV_MD.includes(api), `plugin-dev reference must include ${api}`)
  }
  assert.ok(
    HELMX_CLI_SKILL_MD.includes('helmx conversations fork [id] [--current] [--entry-id <n>] [--title <t>]'),
    'SKILL.md should document optional --entry-id on helmx conversations fork',
  )
  assert.ok(
    HELMX_CLI_SKILL_MD.includes('--node <id> [--cwd <dir>]') && HELMX_CLI_SKILL_MD.includes('same-name priority Hub'),
    'SKILL.md should document skills node/workspace scoping (--current / --node [--cwd] with the same-name Hub-wins priority)',
  )
  assert.ok(HELMX_CLI_SKILL_AND_PLUGIN_DEV_MD.includes('sp.<key>'), 'should document sp./ssp. deep-link namespaces')

  for (const cmdPath of CORE_CLI_COMMAND_PATHS) {
    const parts = cmdPath.split(' ')
    if (parts.length === 1) {
      assert.ok(
        HELMX_CLI_SKILL_MD.includes(`helmx ${cmdPath}`),
        `SKILL.md should contain single-word core command "helmx ${cmdPath}"`,
      )
    } else {
      const [root, sub] = parts
      const pattern = new RegExp(`helmx ${root} [\\w|]*\\b${sub}\\b`)
      const matched = HELMX_CLI_SKILL_MD.includes(`helmx ${cmdPath}`) || pattern.test(HELMX_CLI_SKILL_MD)
      assert.ok(
        matched,
        `SKILL.md should contain (directly or via compact alternation) core command "helmx ${cmdPath}"`,
      )
    }
  }

  for (const envVar of MANAGED_EXEC_ENV_VARS) {
    assert.ok(
      HELMX_CLI_SKILL_MD.includes(envVar),
      `SKILL.md should contain managed environment variable ${envVar}`,
    )
  }

  assert.ok(
    !HELMX_CLI_SKILL_ASSET.skillMd.includes('{{') && !HELMX_CLI_SKILL_ASSET.skillMd.includes('}}'),
    'HELMX_CLI_SKILL_ASSET.skillMd must leave zero template placeholders',
  )
  for (const [refName, refContent] of Object.entries(HELMX_CLI_SKILL_ASSET.references)) {
    assert.ok(
      !refContent.includes('{{') && !refContent.includes('}}'),
      `HELMX_CLI_SKILL_ASSET reference "${refName}" must leave zero template placeholders`,
    )
  }

  assert.ok(
    HELMX_CLI_SKILL_MD.includes('helmx search <query> [--profile <id>] [--owned-by human|helmx] [--top-level] [--limit <n>] [--max-per-conversation <1..20>]'),
    'SKILL.md should document helmx search filter flags and max-per-conversation',
  )
  assert.ok(
    HELMX_CLI_SKILL_MD.includes('helmx models refresh [--provider <id>] [--providers <list>] [--force]'),
    'SKILL.md should document helmx models refresh --providers and --force flags',
  )
  assert.ok(
    HELMX_CLI_SKILL_MD.includes('--parent-conversation-id <id>') &&
      HELMX_CLI_SKILL_MD.includes('--instructions <text>') &&
      HELMX_CLI_SKILL_MD.includes('--restrict-to-cwd'),
    'SKILL.md should document conversations create/compact and profiles flags',
  )
  assert.ok(
    HELMX_CLI_SKILL_MD.includes('run_action({ list: true, pluginId?: "<pluginId>" })') &&
      HELMX_CLI_SKILL_MD.includes('pluginId: "core:"') &&
      HELMX_CLI_SKILL_MD.includes('pluginId: "builtin:"'),
    'SKILL.md should document run_action list discovery with core:/builtin: prefix filters',
  )
  assert.ok(
    HELMX_CLI_SKILL_MD.includes('helmx actions list --json') &&
      HELMX_CLI_SKILL_MD.includes('run_action({ actionId, describe: true })'),
    'SKILL.md should direct dynamic discovery and describe introspection',
  )

  for (const coreActionId of [
    'core:models.list',
    'core:models.providers',
    'core:models.refresh',
    'core:models.default_get',
    'core:models.default',
    'core:models.filter',
    'core:nodes.list',
    'core:nodes.endpoints',
    'core:nodes.upgrade_check',
    'core:nodes.upgrade',
    'core:nodes.remove',
    'core:nodes.forwards',
    'core:nodes.forward_inspect',
    'core:nodes.forward_stop',
    'core:plugins.list',
    'core:plugins.manifest',
    'core:plugins.doc',
    'core:plugins.config_get',
    'core:plugins.doctor',
    'core:plugins.config_set',
    'core:plugins.enable',
    'core:plugins.disable',
    'core:plugins.reload',
    'core:plugins.rescan',
    'core:asks.list',
    'core:asks.cancel',
  ]) {
    assert.ok(
      HELMX_CLI_SKILL_MD.includes(coreActionId),
      `SKILL.md should document in-session core action "${coreActionId}"`,
    )
  }

  assert.throws(
    () => renderSkillTemplate('hello {{UNKNOWN_VAR}}', {}),
    (err: unknown) => err instanceof HelmxError && err.code === 'unreplaced_skill_placeholder',
  )
})

test('helmx-ui HIG single-source sync: repo skill (.helmx/skills/helmx-ui) matches helmx-cli references/ui-hig.md byte-for-byte and wires mandatory gates', { timeout: 60_000 }, async () => {
  const repoRoot = resolve(testDir, '..', '..', '..')
  const skillRaw = (await readFile(join(repoRoot, '.helmx', 'skills', 'helmx-ui', 'SKILL.md'), 'utf8')).replace(/\r\n/g, '\n')
  const patternsRaw = (await readFile(join(repoRoot, '.helmx', 'skills', 'helmx-ui', 'references', 'patterns.md'), 'utf8')).replace(/\r\n/g, '\n')

  const fm = parseSkillFrontmatter(skillRaw)
  assert.equal(fm.name, 'helmx-ui')
  assert.ok(fm.description.length > 0, 'helmx-ui SKILL.md must declare a non-empty description')
  assert.equal(fm.managedByPlugin, undefined, 'repo workspace skill must not declare managedByPlugin')

  const fmMatch = skillRaw.match(/^---\n[\s\S]*?\n---\n+/)
  assert.ok(fmMatch !== null, 'helmx-ui SKILL.md must start with YAML frontmatter')
  const repoSkillBody = skillRaw.slice(fmMatch[0].length)

  assert.equal(
    HELMX_UI_HIG_BODY_MD,
    repoSkillBody,
    'HELMX_UI_HIG_BODY_MD must stay byte-for-byte identical to .helmx/skills/helmx-ui/SKILL.md body',
  )
  assert.equal(
    HELMX_UI_HIG_PATTERNS_MD,
    patternsRaw,
    'HELMX_UI_HIG_PATTERNS_MD must stay byte-for-byte identical to .helmx/skills/helmx-ui/references/patterns.md',
  )
  assert.equal(
    HELMX_CLI_SKILL_ASSET.references['ui-hig.md'],
    HELMX_CLI_UI_HIG_MD,
    'helmx-cli references/ui-hig.md must wire HELMX_CLI_UI_HIG_MD directly',
  )
  assert.equal(
    HELMX_CLI_UI_HIG_MD,
    `${repoSkillBody}\n\n---\n\n${patternsRaw}`,
    'helmx-cli references/ui-hig.md must combine SKILL.md body and references/patterns.md byte-for-byte',
  )

  // Hard-gate routing pointers across helmx-cli and app-builder
  assert.ok(
    HELMX_CLI_SKILL_MD.includes('load_skill({ skillId: "helmx-cli", path: "references/ui-hig.md" })'),
    'helmx-cli SKILL.md Topic manuals must point to references/ui-hig.md',
  )
  assert.ok(
    HELMX_CLI_SKILL_AND_PLUGIN_DEV_MD.includes('references/ui-hig.md'),
    'helmx-cli skill-and-plugin-dev.md must point to references/ui-hig.md',
  )
  assert.ok(
    APP_BUILDER_SKILL_MD.includes('load_skill({ skillId: "helmx-cli", path: "references/ui-hig.md" })'),
    'app-builder Step 2 must require loading helmx-cli references/ui-hig.md before writing client/*.tsx',
  )

  // Phase 1 & Round 2 shared SDK exports documented across plugin-dev and app-builder manuals
  for (const symbol of ['List', 'ListRow', 'TabCount', 'ModalDialog', 'Kbd']) {
    assert.ok(
      HELMX_CLI_SKILL_AND_PLUGIN_DEV_MD.includes(symbol),
      `helmx-cli skill-and-plugin-dev.md must document shared SDK export ${symbol}`,
    )
    assert.ok(
      APP_BUILDER_SKILL_MD.includes(symbol),
      `app-builder SKILL.md must document shared SDK export ${symbol}`,
    )
  }

  // Round 2 HIG rules codified in SKILL.md single source
  for (const ruleMarker of [
    '<TabsList scrollable>',
    '<DropdownMenuItem icon description shortcut trailing checked danger>',
    'surface="subtle"',
    'surface="frameless"',
    '<ModalDialog size="sm|md|lg|fullscreen">',
    '<Kbd',
    '.helmx-toolbar-pill',
    '.section-flat',
    '.modal-header',
    '.kbd-hint',
    '<EmptyState compact|prominent>',
    '<LoadingState>',
  ]) {
    assert.ok(
      HELMX_UI_HIG_BODY_MD.includes(ruleMarker),
      `HELMX_UI_HIG_BODY_MD must codify Round 2 HIG contract marker ${ruleMarker}`,
    )
  }

  // Hygiene & no-regression checks: zero Emoji, zero legacy raw CounterScreen markup, zero variant="default" in TSX examples
  assert.ok(!/\p{Extended_Pictographic}/u.test(skillRaw), '.helmx/skills/helmx-ui/SKILL.md must contain zero Emoji')
  assert.ok(!/\p{Extended_Pictographic}/u.test(patternsRaw), '.helmx/skills/helmx-ui/references/patterns.md must contain zero Emoji')

  const extractTsxBlocks = (md: string): string[] =>
    Array.from(md.matchAll(/```tsx\n([\s\S]*?)```/g), (match) => match[1]!)

  const uiExportSet = new Set<string>(UI_SHARED_EXPORTS)
  const pluginClientExportSet = new Set<string>(PLUGIN_CLIENT_SHARED_EXPORTS)
  const assertSharedImportSplit = (label: string, code: string): void => {
    for (const match of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](@helmx\/(?:ui|plugin-client))['"]/g)) {
      const pkg = match[2]!
      const allowed = pkg === '@helmx/ui' ? uiExportSet : pluginClientExportSet
      const names = match[1]!
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && !part.startsWith('type '))
        .map((part) => part.split(/\s+as\s+/)[0]!.trim())
      for (const sym of names) {
        assert.ok(allowed.has(sym), `${label} imports ${sym} from ${pkg}, which is not in ${pkg === '@helmx/ui' ? 'UI_SHARED_EXPORTS' : 'PLUGIN_CLIENT_SHARED_EXPORTS'}`)
      }
    }
  }

  const devTsxBlocks = extractTsxBlocks(HELMX_CLI_SKILL_AND_PLUGIN_DEV_MD)
  const counterBlock = devTsxBlocks.find((block) => block.includes('export function CounterScreen'))
  assert.ok(counterBlock !== undefined, 'skill-and-plugin-dev.md must contain a CounterScreen tsx example')
  assert.ok(
    counterBlock.includes('<Screen') &&
      counterBlock.includes('<Card') &&
      counterBlock.includes('variant="primary"') &&
      !counterBlock.includes('<div className="card">') &&
      !counterBlock.includes('<button type="button" className="btn') &&
      !counterBlock.includes('variant="default"') &&
      !counterBlock.includes('direction="row"'),
    'CounterScreen example in skill-and-plugin-dev.md must use valid SDK primitives (<Screen>/<Card>/<Stack direction="horizontal">/<Button variant="primary">)',
  )
  assertSharedImportSplit('skill-and-plugin-dev.tsx', counterBlock)
  assert.deepEqual(
    scanPluginTsxUiHygiene('skill-and-plugin-dev.tsx', counterBlock),
    [],
    'CounterScreen example must pass static UI hygiene scanner',
  )

  const appTsxBlocks = extractTsxBlocks(APP_BUILDER_FULLSTACK_TEMPLATE_MD)
  assert.ok(appTsxBlocks.length >= 1, 'app-builder fullstack template must include a tsx client example')
  const appClientTsx = appTsxBlocks.join('\n')
  assert.ok(
    !appClientTsx.includes('variant="default"') &&
      !appClientTsx.includes('<select') &&
      !appClientTsx.includes('type="search"'),
    'app-builder fullstack template tsx must never use removed Button variant="default", native <select>, or type="search"',
  )
  assert.ok(
    appClientTsx.includes('<Screen') &&
      appClientTsx.includes('toolbar={') &&
      appClientTsx.includes('<List') &&
      appClientTsx.includes('<ListRow') &&
      appClientTsx.includes('<DetailDrawer'),
    'app-builder fullstack template tsx must follow the unified Screen toolbar + List + DetailDrawer HIG',
  )
  assertSharedImportSplit('app-builder-template.tsx', appClientTsx)
  assert.deepEqual(
    scanPluginTsxUiHygiene('app-builder-template.tsx', appClientTsx),
    [],
    'app-builder fullstack template tsx must pass static UI hygiene scanner',
  )

  const patternTsxBlocks = extractTsxBlocks(patternsRaw)
  assert.equal(patternTsxBlocks.length, 5, '.helmx/skills/helmx-ui/references/patterns.md must provide all 5 canonical tsx recipes')
  for (const [index, block] of patternTsxBlocks.entries()) {
    assert.ok(
      !block.includes('variant="default"') &&
        !block.includes('direction="row"') &&
        !block.includes('<select') &&
        !block.includes('type="search"') &&
        !block.includes('<button type="button" className="btn'),
      'HIG canonical tsx patterns must stay free of deprecated Button/Tabs default variant, invalid Stack direction="row", native controls, and raw .btn markup',
    )
    assertSharedImportSplit(`patterns-${index + 1}.tsx`, block)
    assert.deepEqual(
      scanPluginTsxUiHygiene(`patterns-${index + 1}.tsx`, block),
      [],
      `HIG canonical tsx pattern #${index + 1} must pass static UI hygiene scanner`,
    )
  }
})

test('core-skills: kernel-owned core skills declare core:* ownership, split conversations/profiles, and leave zero placeholders', { timeout: 60_000 }, () => {
  assert.deepEqual(
    CORE_MANAGED_SKILLS.map((entry) => [entry.asset.id, entry.owner]),
    [
      [HELMX_CLI_SKILL_ID, HELMX_CLI_SKILL_OWNER],
      [APP_BUILDER_SKILL_ID, APP_BUILDER_SKILL_OWNER],
      [CONVERSATIONS_SKILL_ID, CONVERSATIONS_SKILL_OWNER],
      [PROFILES_SKILL_ID, PROFILES_SKILL_OWNER],
    ],
  )
  assert.equal(HELMX_CLI_SKILL_OWNER, 'core:host')
  assert.equal(APP_BUILDER_SKILL_OWNER, 'core:plugins')
  assert.equal(CONVERSATIONS_SKILL_OWNER, 'core:conversations')
  assert.equal(PROFILES_SKILL_OWNER, 'core:profiles')
  assert.ok(
    !CORE_MANAGED_SKILLS.some((entry) => entry.asset.id === 'profile'),
    'legacy combined profile skill id must be retired in favor of conversations + profiles',
  )

  for (const entry of CORE_MANAGED_SKILLS) {
    const fm = parseSkillFrontmatter(entry.asset.skillMd)
    assert.equal(fm.name, entry.asset.id)
    assert.equal(fm.managedByPlugin, entry.owner)
    assert.ok(fm.description.length > 0, `${entry.asset.id} must have a non-empty description`)
    assert.ok(
      !/\{\{[^}]*\}\}/.test(entry.asset.skillMd),
      `${entry.asset.id} SKILL.md must leave zero template placeholders`,
    )
    for (const [refName, refContent] of Object.entries(entry.asset.references)) {
      assert.ok(
        !/\{\{[^}]*\}\}/.test(refContent),
        `${entry.asset.id} reference "${refName}" must leave zero template placeholders`,
      )
    }
  }

  // app-builder migrated to core:plugins with fullstack-template reference
  assert.equal(APP_BUILDER_SKILL_ASSET.skillMd, APP_BUILDER_SKILL_MD)
  assert.ok(Object.hasOwn(APP_BUILDER_SKILL_ASSET.references, 'fullstack-template.md'))
  assert.ok(APP_BUILDER_SKILL_MD.includes('helmx plugins doctor') && APP_BUILDER_SKILL_MD.includes('helmx plugins install'))

  // conversations split out under core:conversations
  assert.equal(CONVERSATIONS_SKILL_ASSET.skillMd, CONVERSATIONS_SKILL_MD)
  assert.ok(CONVERSATIONS_SKILL_MD.includes('core:conversations.search'))
  assert.ok(CONVERSATIONS_SKILL_MD.includes('core:conversations.list'))
  assert.ok(CONVERSATIONS_SKILL_MD.includes('core:conversations.get'))
  assert.ok(CONVERSATIONS_SKILL_MD.includes('core:conversations.entry'))
  assert.ok(CONVERSATIONS_SKILL_MD.includes('403 ownership_violation'))
  assert.ok(CONVERSATIONS_SKILL_MD.includes('409 self_mutation_forbidden'))
  assert.ok(!CONVERSATIONS_SKILL_MD.includes('## Profile Management Actions'))

  // profiles split out under core:profiles
  assert.equal(PROFILES_SKILL_ASSET.skillMd, PROFILES_SKILL_MD)
  assert.ok(PROFILES_SKILL_MD.includes('core:profiles.list'))
  assert.ok(PROFILES_SKILL_MD.includes('core:profiles.get'))
  assert.ok(PROFILES_SKILL_MD.includes('core:profiles.create'))
  assert.ok(PROFILES_SKILL_MD.includes('core:profiles.update'))
  assert.ok(PROFILES_SKILL_MD.includes('core:profiles.delete'))
  assert.ok(PROFILES_SKILL_MD.includes('restrictToCwd'))
  assert.ok(!PROFILES_SKILL_MD.includes('## Conversation Lifecycle Actions'))
})

test('skills: ensureSkill managed overrides — bootstrap, restore source on restart, fill missing files, reject symlink targets, enforce read-only', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const skills = new SkillService(dataDir)
  const asset = {
    id: 'demo-asset',
    skillMd: '---\nname: demo-asset\ndescription: self-managed skill\n---\n\n# body text\n',
    references: {
      'guide.md': '# guide\ncontent.\n',
      'extra.md': '# additional\ncontent.\n',
    },
  }

  await skills.ensureSkill(asset)
  assert.ok((await skills.readFile('demo-asset')).includes('self-managed skill'))
  assert.ok((await skills.readFile('demo-asset', 'references/guide.md')).includes('guide'))
  assert.ok((await skills.readFile('demo-asset', 'references/extra.md')).includes('additional'))

  await assert.rejects(
    () => skills.writeFile('demo-asset', 'SKILL.md', 'tamper'),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError)
      assert.equal(err.code, 'managed_skill_readonly')
      assert.equal(err.status, 403)
      return true
    },
  )
  await assert.rejects(
    () => skills.writeFile('demo-asset', 'references/other.md', 'tamper'),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError)
      assert.equal(err.code, 'managed_skill_readonly')
      return true
    },
  )

  const customMd = '---\nname: demo-asset\ndescription: user modified\n---\n\nCustom body text\n'
  const customGuide = '# custom guide\n'
  await writeFile(join(dataDir, 'skills', 'demo-asset', 'SKILL.md'), customMd)
  await writeFile(join(dataDir, 'skills', 'demo-asset', 'references', 'guide.md'), customGuide)
  await skills.ensureSkill(asset)
  assert.equal(
    await readTextFile(join(dataDir, 'skills', 'demo-asset', 'SKILL.md')),
    asset.skillMd,
    're-sync must restore SKILL.md to source content',
  )
  assert.equal(
    await readTextFile(join(dataDir, 'skills', 'demo-asset', 'references', 'guide.md')),
    asset.references['guide.md']!,
    're-sync must restore reference to source content',
  )

  await rm(join(dataDir, 'skills', 'demo-asset', 'references', 'extra.md'))
  await skills.ensureSkill(asset)
  assert.equal(
    await readTextFile(join(dataDir, 'skills', 'demo-asset', 'references', 'extra.md')),
    asset.references['extra.md']!,
  )

  // Skip rewrite when content matches (avoids mtime churn and spurious watcher events).
  const stablePath = join(dataDir, 'skills', 'demo-asset', 'SKILL.md')
  const stableBefore = await lstat(stablePath)
  const backdatedMs = stableBefore.mtimeMs - 60_000
  const backdated = new Date(backdatedMs)
  await utimes(stablePath, backdated, backdated)
  await skills.ensureSkill(asset)
  const stableAfter = await lstat(stablePath)
  assert.ok(
    Math.abs(stableAfter.mtimeMs - backdatedMs) <= 2,
    `identical content must skip rewrite (mtime should stay ~${backdatedMs}, actual ${stableAfter.mtimeMs})`,
  )
  assert.equal(await readTextFile(stablePath), asset.skillMd)

  // Refuse overwrite if existing target is a symlink.
  const outside = join(scratchRoot, 'outside-target.md')
  await writeFile(outside, 'external content')
  await rm(join(dataDir, 'skills', 'demo-asset', 'references', 'extra.md'))
  await symlink(outside, join(dataDir, 'skills', 'demo-asset', 'references', 'extra.md'))
  await assert.rejects(() => skills.ensureSkill(asset), /not a regular file/)
  assert.equal(await readFile(outside, 'utf8'), 'external content')

  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: '../evil' }),
    /illegal skill id/,
  )
  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: 'ok-id', references: { '../evil.md': 'x' } }),
    /path traversal|illegal/,
  )
  assert.ok(!existsSync(join(dataDir, 'skills', 'ok-id')), 'invalid reference must not leave partial asset')
})

test('skills: user-authored skills are unaffected by managed overrides (ensureSkill untouched, writeFile permitted)', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const skills = new SkillService(dataDir)
  await seedSkill(dataDir, 'user-skill', ['references/guide.md'])
  const before = await readTextFile(join(dataDir, 'skills', 'user-skill', 'SKILL.md'))

  await skills.ensureSkill({
    id: 'managed-asset',
    skillMd: '---\nname: managed-asset\ndescription: managed\n---\n\nbody text\n',
    references: {},
  })
  assert.equal(await readTextFile(join(dataDir, 'skills', 'user-skill', 'SKILL.md')), before)
  assert.ok(!(await skills.list()).some((s) => s.id === 'user-skill' && s.managedByPlugin), 'user skill carries no managed marker')

  await skills.writeFile('user-skill', 'SKILL.md', '---\nname: user-skill\ndescription: user skill\n---\nuser can write\n')
  assert.ok((await skills.readFile('user-skill')).includes('user can write'))
  await skills.writeFile('user-skill', 'references/extra.md', '# user appended\n')
  assert.ok((await skills.readFile('user-skill', 'references/extra.md')).includes('user appended'))
})

test('skills: ensureSkill rejects symlinked dirs and file/dir collisions without writing outside skills root', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const skills = new SkillService(dataDir)
  const asset = {
    id: 'demo-guard',
    skillMd: '---\nname: demo-guard\ndescription: guard\n---\n\n# body text\n',
    references: { 'guide.md': '# guide\n', 'rules/table.md': '# rule\n' },
  }

  // Symlinked skills root resolves cleanly via realpath consistently with requireSkillsRoot
  const realRoot = join(dataDir, 'real-skills')
  await mkdir(realRoot, { recursive: true })
  await symlink(realRoot, join(dataDir, 'skills'))
  await skills.ensureSkill(asset)
  assert.ok((await skills.readFile('demo-guard')).includes('guard'))
  assert.ok((await skills.readFile('demo-guard', 'references/rules/table.md')).includes('rule'))

  // Symlinked skill subdir rejected without writing outside
  const evilDir = join(scratchRoot, 'evil-skill-dir')
  await rm(evilDir, { recursive: true, force: true })
  await mkdir(evilDir, { recursive: true })
  await symlink(evilDir, join(realRoot, 'linked-skill'))
  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: 'linked-skill' }),
    /symlink/,
  )
  assert.deepEqual(await readdir(evilDir), [])

  // Symlinked references subdir rejected without writing outside
  const outsideRefs = join(scratchRoot, 'outside-refs')
  await rm(outsideRefs, { recursive: true, force: true })
  await mkdir(outsideRefs, { recursive: true })
  await mkdir(join(realRoot, 'ref-link-skill'), { recursive: true })
  await symlink(outsideRefs, join(realRoot, 'ref-link-skill', 'references'))
  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: 'ref-link-skill' }),
    /symlink/,
  )
  assert.deepEqual(await readdir(outsideRefs), [])
  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: 'ref-link-skill', references: {} }),
    /symlink/,
  )

  // Target path is a directory -> rejected cleanly
  await mkdir(join(realRoot, 'dir-as-file', 'SKILL.md'), { recursive: true })
  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: 'dir-as-file' }),
    /not a regular file/,
  )

  await mkdir(join(realRoot, 'ref-as-dir', 'references', 'guide.md'), { recursive: true })
  await assert.rejects(
    () => skills.ensureSkill({ ...asset, id: 'ref-as-dir' }),
    /not a regular file/,
  )
})

test('skills: ensureSkill reconciles to the declared asset — prunes retired references and retired same-owner skill dirs', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const skills = new SkillService(dataDir)
  const owner = 'builtin:demo-owner'
  const asset = {
    id: 'demo-live',
    skillMd: `---\nname: demo-live\ndescription: managed\nmanagedByPlugin: ${owner}\n---\n\n# body\n`,
    references: { 'guide.md': '# guide\n' },
  }

  // Retired same-owner dir (rename residue, e.g. swarm-collab -> swarm), foreign-owner dir, ownerless user skill,
  // and a dir without SKILL.md coexist next to the live asset.
  await mkdir(join(dataDir, 'skills', 'demo-retired'), { recursive: true })
  await writeFile(
    join(dataDir, 'skills', 'demo-retired', 'SKILL.md'),
    `---\nname: demo-retired\ndescription: stale\nmanagedByPlugin: ${owner}\n---\n\nold body\n`,
  )
  await mkdir(join(dataDir, 'skills', 'demo-retired', 'references'), { recursive: true })
  await writeFile(join(dataDir, 'skills', 'demo-retired', 'references', 'old.md'), '# stale manual\n')
  await seedSkill(dataDir, 'foreign-skill')
  const foreignMd = await readFile(join(dataDir, 'skills', 'foreign-skill', 'SKILL.md'), 'utf8')
  await writeFile(
    join(dataDir, 'skills', 'foreign-skill', 'SKILL.md'),
    foreignMd.replace('---\n', `---\nmanagedByPlugin: builtin:other-owner\n`),
  )
  await seedSkill(dataDir, 'user-skill', ['references/notes.md'])
  await mkdir(join(dataDir, 'skills', 'no-frontmatter-dir', 'references'), { recursive: true })

  // Stale undeclared references inside the live asset: a retired file, a retired nested dir, and an empty leftover dir.
  await skills.ensureSkill(asset)
  await writeFile(join(dataDir, 'skills', 'demo-live', 'references', 'retired.md'), '# retired manual\n')
  await mkdir(join(dataDir, 'skills', 'demo-live', 'references', 'retired-tree'), { recursive: true })
  await writeFile(join(dataDir, 'skills', 'demo-live', 'references', 'retired-tree', 'nested.md'), '# nested\n')
  await mkdir(join(dataDir, 'skills', 'demo-live', 'references', 'empty-leftover'), { recursive: true })
  await mkdir(join(dataDir, 'skills', 'demo-live', 'outside-managed'), { recursive: true })
  await writeFile(join(dataDir, 'skills', 'demo-live', 'outside-managed', 'keep.txt'), 'not a reference\n')

  await skills.ensureSkill(asset)

  // Declared reference kept; retired file/nested dir/empty dir pruned; files outside the references tree untouched.
  assert.ok((await skills.readFile('demo-live', 'references/guide.md')).includes('guide'))
  await assert.rejects(() => skills.readFile('demo-live', 'references/retired.md'), /ENOENT|not found/i)
  assert.ok(!existsSync(join(dataDir, 'skills', 'demo-live', 'references', 'retired-tree')))
  assert.ok(!existsSync(join(dataDir, 'skills', 'demo-live', 'references', 'empty-leftover')))
  assert.equal(
    await readFile(join(dataDir, 'skills', 'demo-live', 'outside-managed', 'keep.txt'), 'utf8'),
    'not a reference\n',
  )

  // Retired same-owner dir removed; foreign-owner, ownerless, and frontmatter-less dirs survive.
  assert.ok(!existsSync(join(dataDir, 'skills', 'demo-retired')), 'retired same-owner dir must be swept')
  assert.ok(existsSync(join(dataDir, 'skills', 'foreign-skill', 'SKILL.md')))
  assert.ok(existsSync(join(dataDir, 'skills', 'user-skill', 'SKILL.md')))
  assert.ok(existsSync(join(dataDir, 'skills', 'no-frontmatter-dir')))

  // A second skill of the same owner stays once the owner declares it in the same session (accumulated set).
  await skills.ensureSkill({
    id: 'demo-sibling',
    skillMd: `---\nname: demo-sibling\ndescription: managed\nmanagedByPlugin: ${owner}\n---\n\n# sibling\n`,
    references: {},
  })
  await skills.ensureSkill(asset)
  assert.ok(existsSync(join(dataDir, 'skills', 'demo-sibling', 'SKILL.md')), 'sibling must survive re-ensure of the first skill')

  // Malformed frontmatter fails up front without leaving partial directories on disk.
  await assert.rejects(
    () =>
      skills.ensureSkill({
        id: 'bad-frontmatter',
        skillMd: '---\nname: bad-frontmatter\nmanagedByPlugin:\n---\nbody\n',
        references: {},
      }),
    /managedByPlugin value is empty/,
  )
  assert.ok(!existsSync(join(dataDir, 'skills', 'bad-frontmatter')), 'malformed frontmatter must not leave partial dir')
})

test('skills: bootstrapCoreSkills and reconcileManagedOwners retire zero-skill active owners while preserving disabled plugin skills and symlink safety', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const skills = new SkillService(dataDir)

  // Seed legacy pre-migration layout under builtin:profile, a retired core:host dir, a disabled plugin skill,
  // a user-authored skill, a symlinked skill dir, a dir with symlinked SKILL.md, and malformed frontmatter.
  const writeRawSkill = async (id: string, skillMd: string) => {
    await mkdir(join(dataDir, 'skills', id), { recursive: true })
    await writeFile(join(dataDir, 'skills', id, 'SKILL.md'), skillMd)
  }
  await writeRawSkill('helmx-cli', '---\nname: helmx-cli\ndescription: old\nmanagedByPlugin: builtin:profile\n---\nold\n')
  await writeRawSkill('app-builder', '---\nname: app-builder\ndescription: old\nmanagedByPlugin: builtin:profile\n---\nold\n')
  await writeRawSkill('profile', '---\nname: profile\ndescription: legacy\nmanagedByPlugin: builtin:profile\n---\nlegacy\n')
  await writeRawSkill('legacy-core-host', '---\nname: legacy-core-host\ndescription: stale\nmanagedByPlugin: core:host\n---\nstale\n')
  await writeRawSkill('triggers', '---\nname: triggers\ndescription: disabled plugin\nmanagedByPlugin: builtin:triggers\n---\nkeep\n')
  await seedSkill(dataDir, 'user-custom')
  await writeRawSkill('broken-fm', '---\nname: broken-fm\nmanagedByPlugin:\n---\nbroken\n')

  const outsideDir = join(scratchRoot, 'outside-retired-target')
  await mkdir(outsideDir, { recursive: true })
  await writeFile(join(outsideDir, 'SKILL.md'), '---\nname: linked\nmanagedByPlugin: builtin:profile\n---\noutside\n')
  await symlink(outsideDir, join(dataDir, 'skills', 'linked-retired-dir'))

  await mkdir(join(dataDir, 'skills', 'linked-skill-md-dir'), { recursive: true })
  await symlink(join(outsideDir, 'SKILL.md'), join(dataDir, 'skills', 'linked-skill-md-dir', 'SKILL.md'))

  // Step 1: Kernel core skills bootstrap overwrites helmx-cli/app-builder to core:*, writes conversations/profiles,
  // and sweeps stale core:host residue while leaving builtin:profile/disabled plugin dirs untouched.
  await bootstrapCoreSkills(skills)
  assert.ok(!existsSync(join(dataDir, 'skills', 'legacy-core-host')), 'retired core:host dir must be swept')
  assert.ok(existsSync(join(dataDir, 'skills', 'profile', 'SKILL.md')), 'plugin-owned dir waits for active plugin reconciliation')

  // Step 2: Reconcile active plugin owners (builtin:profile is active with zero declared skills; builtin:triggers is disabled and omitted).
  await skills.reconcileManagedOwners(['builtin:profile'])

  // Legacy builtin:profile dir is retired; migrated core:* skills survive; disabled plugin & user & symlinked entries survive.
  assert.ok(!existsSync(join(dataDir, 'skills', 'profile')), 'retired builtin:profile skill dir must be removed')
  assert.equal(parseSkillFrontmatter(await skills.readFile('helmx-cli')).managedByPlugin, 'core:host')
  assert.equal(parseSkillFrontmatter(await skills.readFile('app-builder')).managedByPlugin, 'core:plugins')
  assert.equal(parseSkillFrontmatter(await skills.readFile('conversations')).managedByPlugin, 'core:conversations')
  assert.equal(parseSkillFrontmatter(await skills.readFile('profiles')).managedByPlugin, 'core:profiles')
  assert.ok(existsSync(join(dataDir, 'skills', 'triggers', 'SKILL.md')), 'disabled plugin skill dir must be preserved')
  assert.ok(existsSync(join(dataDir, 'skills', 'user-custom', 'SKILL.md')), 'user-authored skill must be preserved')
  assert.ok(existsSync(join(dataDir, 'skills', 'broken-fm', 'SKILL.md')), 'unparseable frontmatter dir must not be deleted')
  assert.ok(existsSync(join(dataDir, 'skills', 'linked-retired-dir')), 'symlinked skill dir must never be deleted')
  assert.ok(existsSync(join(outsideDir, 'SKILL.md')), 'symlink target outside skills root must stay untouched')
  assert.ok(existsSync(join(dataDir, 'skills', 'linked-skill-md-dir', 'SKILL.md')), 'dir with symlinked SKILL.md must be skipped')
})

test('runtime: startup bootstraps core:* skills, retires active zero-skill builtin:profile dirs while keeping disabled plugin skills, and unifies ensurePluginSkill frontmatter parsing', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await mkdir(join(dataDir, 'skills', 'profile'), { recursive: true })
  await writeFile(
    join(dataDir, 'skills', 'profile', 'SKILL.md'),
    '---\nname: profile\ndescription: legacy\nmanagedByPlugin: builtin:profile\n---\nlegacy\n',
  )
  await mkdir(join(dataDir, 'skills', 'helmx-cli'), { recursive: true })
  await writeFile(
    join(dataDir, 'skills', 'helmx-cli', 'SKILL.md'),
    '---\nname: helmx-cli\ndescription: old\nmanagedByPlugin: builtin:profile\n---\nold\n',
  )
  await mkdir(join(dataDir, 'skills', 'disabled-guide'), { recursive: true })
  await writeFile(
    join(dataDir, 'skills', 'disabled-guide', 'SKILL.md'),
    '---\nname: disabled-guide\ndescription: disabled\nmanagedByPlugin: ext-disabled\n---\nkeep\n',
  )
  await seedSkill(dataDir, 'user-custom')

  const kernel = await KernelRuntime.open({
    dataDir,
    cwd: dataDir,
    autoResume: false,
    externalSkillRoots: [],
  })
  try {
    // Core skills are bootstrapped & read-only immediately after open().
    const afterOpen = await kernel.skills.list()
    assert.equal(afterOpen.find((s) => s.id === 'helmx-cli')?.managedByPlugin, 'core:host')
    assert.equal(afterOpen.find((s) => s.id === 'app-builder')?.managedByPlugin, 'core:plugins')
    assert.equal(afterOpen.find((s) => s.id === 'conversations')?.managedByPlugin, 'core:conversations')
    assert.equal(afterOpen.find((s) => s.id === 'profiles')?.managedByPlugin, 'core:profiles')
    await assert.rejects(
      () => kernel.skills.writeFile('conversations', 'SKILL.md', 'tamper'),
      (err: unknown) => err instanceof HelmxError && err.code === 'managed_skill_readonly' && err.status === 403,
    )

    // Register an active zero-skill builtin:profile plugin and a disabled ext-disabled plugin, then start().
    await kernel.plugins.register(
      {
        id: 'builtin:profile',
        name: 'Profile Stub',
        version: '0.1.0',
        definePlugin() {},
      },
      { enabled: true },
    )
    await kernel.plugins.register(
      {
        id: 'ext-disabled',
        name: 'Disabled Plugin Stub',
        version: '0.1.0',
        definePlugin() {},
      },
      { enabled: false },
    )
    await kernel.start()

    assert.ok(!existsSync(join(dataDir, 'skills', 'profile')), 'active zero-skill builtin:profile must retire old profile skill dir')
    assert.ok(existsSync(join(dataDir, 'skills', 'disabled-guide', 'SKILL.md')), 'disabled plugin skill dir must survive startup')
    assert.ok(existsSync(join(dataDir, 'skills', 'user-custom', 'SKILL.md')), 'user skill must survive startup')

    // Unified parseSkillFrontmatter enforcement in ensurePluginSkill:
    // 1) body-only managedByPlugin (without YAML frontmatter fence) must be rejected (no ad-hoc regex bypass).
    await assert.rejects(
      () =>
        kernel.ensurePluginSkill(
          {
            id: 'body-spoof',
            skillMd: '# No frontmatter\n\nmanagedByPlugin: ext-valid\n',
            references: {},
          },
          'ext-valid',
        ),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_plugin_skill' && err.status === 400,
    )
    // 2) empty managedByPlugin value in frontmatter -> 400 invalid_plugin_skill.
    await assert.rejects(
      () =>
        kernel.ensurePluginSkill(
          {
            id: 'empty-owner',
            skillMd: '---\nname: empty-owner\nmanagedByPlugin:\n---\nbody\n',
            references: {},
          },
          'ext-valid',
        ),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_plugin_skill' && err.status === 400,
    )
    // 3) mismatched core:* owner claimed by a plugin -> 400 invalid_plugin_skill.
    await assert.rejects(
      () =>
        kernel.ensurePluginSkill(
          {
            id: 'core-spoof',
            skillMd: '---\nname: core-spoof\nmanagedByPlugin: core:host\n---\nbody\n',
            references: {},
          },
          'ext-valid',
        ),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_plugin_skill' && err.status === 400,
    )
    // 4) quoted YAML scalar in frontmatter is parsed consistently and accepted.
    await kernel.ensurePluginSkill(
      {
        id: 'quoted-valid',
        skillMd: '---\nname: quoted-valid\ndescription: ok\nmanagedByPlugin: "ext-valid"\n---\nbody\n',
        references: {},
      },
      'ext-valid',
    )
    assert.equal((await kernel.skills.list()).find((s) => s.id === 'quoted-valid')?.managedByPlugin, 'ext-valid')
  } finally {
    await kernel.close()
  }
})

test('profiles: skills tri-state (omitted default, empty array persisted, allowlist deduped, invalid rejected)', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()

  // 1. Default omitted: not written to profile.json
  await profiles.save({ id: 'p-default', name: 'default', tags: [] })
  assert.equal((await profiles.get('p-default'))?.skills, undefined)
  const onDiskDefault = JSON.parse(await readFile(join(dataDir, 'profiles', 'p-default', 'profile.json'), 'utf8')) as Record<string, unknown>
  assert.equal('skills' in onDiskDefault, false, 'omitted skills should not be written to profile.json')

  // 2. Empty array: persisted explicitly to disable all skills
  await profiles.save({ id: 'p-none', name: 'all disabled', tags: [], skills: [] })
  assert.deepEqual((await profiles.get('p-none'))?.skills, [])
  const onDiskNone = JSON.parse(await readFile(join(dataDir, 'profiles', 'p-none', 'profile.json'), 'utf8')) as { skills?: string[] }
  assert.deepEqual(onDiskNone.skills, [], 'empty array must persist intact')

  // 3. Non-empty allowlist: duplicates stripped; unknown IDs permitted for forward compatibility
  await profiles.save({ id: 'p-white', name: 'allowlist', tags: [], skills: ['helmx-cli', 'watchdog-playbooks', 'helmx-cli', 'future-skill'] })
  assert.deepEqual((await profiles.get('p-white'))?.skills, ['helmx-cli', 'watchdog-playbooks', 'future-skill'])

  // Invalid values rejected
  await assert.rejects(
    () => profiles.save({ id: 'p-bad', tags: [], skills: 'helmx-cli' } as unknown as Parameters<ProfileService['save']>[0]),
    /skills must be a string array/,
  )
  await assert.rejects(
    () => profiles.save({ id: 'p-bad', tags: [], skills: ['ok-skill', 42] } as unknown as Parameters<ProfileService['save']>[0]),
    /skills must be a string array/,
  )
  await assert.rejects(
    () => profiles.save({ id: 'p-bad', tags: [], skills: ['../profiles/assistant'] }),
    /illegal skill id/,
  )
})

// ---------------------------------------------------------------------------
// AssetWatcher
// ---------------------------------------------------------------------------
test('watcher: 150ms debounce catches atomic renames without tmp files and stops reporting after close', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const events: string[][] = []
  const errors: Error[] = []
  const watcher = new AssetWatcher(
    dataDir,
    (paths) => events.push(paths),
    { onError: (err) => errors.push(err) },
  )
  watcher.start()
  try {
    await atomicWriteFile(join(dataDir, 'profiles', 'assistant', 'MEMORY.md'), 'first edition')
    await waitFor(() => events.some((batch) => batch.some((p) => p === 'profiles/assistant/MEMORY.md')))
    await atomicWriteFile(join(dataDir, 'profiles', 'assistant', 'MEMORY.md'), 'second edition')
    await waitFor(() => {
      const batches = events.filter((b) => b.includes('profiles/assistant/MEMORY.md'))
      return batches.length >= 2
    })
    for (const batch of events) {
      for (const p of batch) assert.ok(!p.includes('.tmp'), `tmp file must not emit watcher event: ${p}`)
    }
    assert.deepEqual(errors, [])
  } finally {
    watcher.close()
  }
  const countBefore = events.length
  await atomicWriteFile(join(dataDir, 'profiles', 'assistant', 'SYSTEM.md'), 'x')
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(events.length, countBefore)
})

test('watcher: missing directory emits explicit error via onError rather than failing silently', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const missing = join(dataDir, 'no-such-dir')
  const errors: Error[] = []
  const watcher = new AssetWatcher(missing, () => {}, { onError: (err) => errors.push(err) })
  watcher.start()
  try {
    await waitFor(() => errors.length > 0, 8_000)
    assert.ok(errors[0]!.message.length > 0, 'error must be reported explicitly')
  } finally {
    watcher.close()
  }
})

// ---------------------------------------------------------------------------
// SecretStash
// ---------------------------------------------------------------------------
test('stash: addRedaction global literal redaction, regex-special characters, ref-counted release, and clear', { timeout: 60_000 }, async () => {
  const stash = new SecretStash()
  const managed = 'managed-token-value-abc123'
  stash.addRedaction(managed)
  assert.equal(stash.redact(`token=${managed}`), 'token=[REDACTED]')
  assert.equal(stash.redact('[REDACTED]'), '[REDACTED]')

  const special = 'example.*+?^${}()|[]\\value'
  stash.addRedaction(special)
  assert.equal(stash.redact(`x=${special}`), 'x=[REDACTED]')

  stash.clear()
  assert.equal(stash.redact(managed), managed, 'clear() must clear global registrations')

  const r1 = stash.addRedaction(managed)
  const r2 = stash.addRedaction(managed)
  r1()
  r1()
  assert.equal(stash.redact(managed), '[REDACTED]')
  r2()
  assert.equal(stash.redact(managed), managed)

  assert.throws(() => stash.addRedaction(''), /non-empty/)
})

test('stash: idempotent markers and stale release handles stay isolated', { timeout: 60_000 }, () => {
  const stash = new SecretStash()
  const value = 'internal-example-for-redaction'
  const releaseOld = stash.addRedaction(value)
  assert.equal(stash.redact(value), '[REDACTED]')

  stash.clear()
  const releaseCurrent = stash.addRedaction(value)
  releaseOld()
  assert.equal(stash.redact(value), '[REDACTED]', 'stale release handle must not undo newer registration')
  releaseCurrent()
  assert.equal(stash.redact(value), value)

  stash.addRedaction('REDACTED')
  assert.equal(stash.redact('[REDACTED]'), '[REDACTED]', 'existing redaction markers remain intact')
})

// ---------------------------------------------------------------------------
// AuthService
// ---------------------------------------------------------------------------
test('auth: single setup, rejects weak passwords, login signs tokens, persists token digests without plaintext', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const auth = new AuthService(dataDir)
  assert.deepEqual(await auth.status(), { configured: false })

  await assert.rejects(() => auth.setup('short'), /at least 8/)
  await assert.rejects(() => auth.setup(''), /at least 8/)
  assert.deepEqual(await auth.status(), { configured: false })

  const { token } = await auth.setup('correct horse battery staple')
  assert.ok(token.length >= 32)
  assert.deepEqual(await auth.status(), { configured: true })

  await assert.rejects(() => auth.setup('another password 99'), /already configured|duplicate|already setup/)

  const configText = await readTextFile(join(dataDir, 'config.json'))
  assert.ok(!configText.includes('correct horse'), 'plaintext password must never hit config')
  assert.ok(!configText.includes(token), 'plaintext token must never hit config')

  await assert.rejects(() => auth.login('wrong password!!'), /invalid password/)
  const auth2 = new AuthService(await freshDataDir())
  await assert.rejects(() => auth2.login('some password'), /setup|initialize/)

  const { token: token2 } = await auth.login('correct horse battery staple')
  assert.notEqual(token, token2)
  assert.equal(await auth.verifyToken(token), true)
  assert.equal(await auth.verifyToken(token2), true)
  assert.equal(await auth.verifyToken('f'.repeat(64)), false)
  assert.equal(await auth.verifyToken(''), false)
  const config = JSON.parse(configText) as { auth?: { tokens?: Record<string, { digest: string }> } }
  const digests = Object.values(config.auth?.tokens ?? {})
  assert.ok(digests.length >= 1)
  assert.ok(digests.every((d) => /^[0-9a-f]{64}$/.test(d.digest)))
})

test('auth: createProcessToken is in-memory only — works unconfigured, invalidates on dispose, never persists, rejects anonymous', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const auth = new AuthService(dataDir)
  assert.deepEqual(await auth.status(), { configured: false })
  const managed = auth.createProcessToken()
  assert.ok(managed.token.length >= 32)
  assert.equal(await auth.verifyToken(managed.token), true)

  assert.equal(await new AuthService(dataDir).verifyToken(managed.token), true)

  const configText = await readTextFile(join(dataDir, 'config.json')).catch(() => '')
  assert.ok(!configText.includes(managed.token), 'managed token plaintext must not hit disk')
  assert.ok(!configText.includes(managed.token.slice(0, 16)), 'managed token must not appear on disk in any form')

  const { token: persisted } = await auth.setup('process token pw 12345678')
  assert.equal(await auth.verifyToken(persisted), true)
  managed.dispose()
  managed.dispose()
  assert.equal(await auth.verifyToken(managed.token), false)
  assert.equal(await auth.verifyToken(persisted), true)

  assert.equal(await auth.verifyToken(''), false)
  assert.equal(await auth.verifyToken('anonymous'), false)
  assert.equal(await auth.verifyToken('0'.repeat(64)), false)
})

test('auth: concurrent setups allow only one success; concurrent updates preserve unrelated config keys', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const auth = new AuthService(dataDir)
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) => auth.setup(`password-number-${i}000000`)),
  )
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  assert.equal(fulfilled.length, 1, 'exactly one concurrent setup should succeed')
  for (const r of results) {
    if (r.status === 'rejected') assert.match(String(r.reason), /already configured|duplicate/)
  }

  const config = new ConfigService(dataDir)
  await Promise.all([
    config.update({ theme: 'dark' }),
    config.update({ locale: 'zh-CN' }),
    config.update({ featureX: true }),
  ])
  const final = await config.get()
  assert.deepEqual(
    { theme: final['theme'], locale: final['locale'], featureX: final['featureX'] },
    { theme: 'dark', locale: 'zh-CN', featureX: true },
  )
  assert.ok(final['auth'], 'concurrent updates must not drop auth key')
})

// ---------------------------------------------------------------------------
// CredentialService & ProviderService
// ---------------------------------------------------------------------------
test('credentials: set/get/list/delete enforce 0600 and stay isolated from providers.json secrets', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const credentials = new CredentialService(dataDir)
  assert.deepEqual(await credentials.list(), [])

  await credentials.set('openai', 'sk-live-abcdef123456')
  await credentials.set('anthropic', 'sk-ant-zzz')
  assert.deepEqual(await credentials.list(), ['anthropic', 'openai'])
  assert.equal(await credentials.get('openai'), 'sk-live-abcdef123456')

  assert.ok(await isPrivateMode(join(dataDir, 'credentials.json')))

  await chmod(join(dataDir, 'credentials.json'), 0o644)
  await credentials.set('openai', 'sk-rotated-999')
  assert.ok(await isPrivateMode(join(dataDir, 'credentials.json')))
  assert.equal(await credentials.get('openai'), 'sk-rotated-999')

  await credentials.delete('anthropic')
  assert.deepEqual(await credentials.list(), ['openai'])
  await assert.rejects(() => credentials.delete('anthropic'), /missing|not found|anthropic/)

  await credentials.setPluginSecret('builtin:triggers', 'webhookSecret', 'whsec_abc')
  assert.equal(await credentials.getPluginSecret('builtin:triggers', 'webhookSecret'), 'whsec_abc')
  await credentials.deletePluginSecrets('builtin:triggers')
  assert.equal(await credentials.getPluginSecret('builtin:triggers', 'webhookSecret'), undefined)

  await assert.rejects(() => credentials.get('../x'), /invalid providerId/)
  await assert.rejects(() => credentials.set('openai', ''), /cannot be empty/)

  const providers = new ProviderService(dataDir)
  await providers.save([
    {
      id: 'openai',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-4o'],
      label: 'OpenAI',
      enabled: true,
    },
  ])
  const providerList = await providers.list()
  assert.equal(providerList.length, 1)
  const providerText = await readTextFile(join(dataDir, 'providers.json'))
  assert.ok(!providerText.includes('sk-'), 'providers.json must never contain secret key values')
  await assert.rejects(
    () =>
      providers.save([
        {
          id: 'x', protocol: 'openai', baseUrl: 'https://x.example.com',
          models: ['m1'], enabled: true, apiKey: 'sk-leak',
        } as unknown as ProviderConfig[],
      ] as never),
    /must not contain secret field/,
  )
  assert.ok(existsSync(join(dataDir, 'providers.json')))
  assert.ok(existsSync(join(dataDir, 'credentials.json')))
})

// ---------------------------------------------------------------------------
// ArtifactService
// ---------------------------------------------------------------------------
test('artifacts: register copies files cleanly, readContent reads, list & deleteConversation cascade', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const repository = new InMemoryArtifactRepository()
  const artifacts = new ArtifactService(dataDir, repository)

  const src = await tempSourceFile('# report\ncontent'.repeat(100))
  const meta = await artifacts.register(1, src, { name: 'report.md' })
  assert.equal(meta.conversationId, 1)
  assert.equal(meta.kind, 'registered')
  assert.equal(meta.name, 'report.md')
  assert.ok(meta.path.startsWith('artifacts/1/'))
  assert.ok(!meta.path.includes('\\'))
  assert.ok(meta.size > 0)
  assert.ok((await artifacts.readContent(meta.id)).includes('report'))
  assert.equal((await artifacts.list(1)).length, 1)
  assert.ok(existsSync(src))

  await artifacts.register(2, src)
  assert.equal((await artifacts.list(1)).length, 1)
  assert.equal((await artifacts.list(2)).length, 1)

  await artifacts.deleteConversation(1)
  assert.equal((await artifacts.list(1)).length, 0)
  assert.equal((await artifacts.list(2)).length, 1)
  assert.deepEqual(await artifacts.listFiles(1), [])

  await assert.rejects(() => artifacts.register(0, src), /conversationId/)
  await assert.rejects(() => artifacts.register(1, ''), /sourcePath/)
  const evilName = await artifacts.register(1, src).catch(() => undefined)
  assert.notEqual(evilName, undefined)
})

test('artifacts: spill 32KiB threshold, 4KiB UTF-8 safe preview, secret redaction, id/path references', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const repository = new InMemoryArtifactRepository()
  const stash = new SecretStash()
  const artifacts = new ArtifactService(dataDir, repository, stash)

  const small = 'x'.repeat(1024)
  const r1 = await artifacts.spill(1, 'call-1', small)
  assert.equal(r1.artifact, undefined)
  assert.equal(r1.text, small)

  const exact = 'y'.repeat(32 * 1024)
  const r2 = await artifacts.spill(1, 'call-2', exact)
  assert.equal(r2.artifact, undefined)

  const headZh = 'preview header content: '
  const big = headZh + 'z'.repeat(40 * 1024) + 'tail content TAIL'
  const r3 = await artifacts.spill(1, 'call-3', big)
  assert.notEqual(r3.artifact, undefined)
  const meta = r3.artifact!
  assert.equal(meta.conversationId, 1)
  assert.equal(meta.kind, 'spill')
  assert.ok(meta.path.includes('tool-spill-call-3.txt'))
  assert.ok(meta.size > 32 * 1024)
  assert.ok(r3.text.includes(headZh))
  assert.ok(r3.text.includes('truncated'))
  assert.ok(r3.text.includes('TAIL'))
  assert.ok(r3.text.includes(meta.id))
  assert.ok(r3.text.includes(meta.path))
  assert.ok(Buffer.byteLength(r3.text, 'utf8') < 8 * 1024)
  assert.ok((await artifacts.readContent(meta.id)).length === big.length)
  assert.ok((await artifacts.list(1)).some((a) => a.id === meta.id))

  // UTF-8 safe truncation: 3-byte char ('\u6c49') ensures 4KiB boundary lands mid-character
  const zhHead = '\u6c49'.repeat(2049)
  const r4 = await artifacts.spill(2, 'call-4', zhHead + 'a'.repeat(33 * 1024))
  assert.notEqual(r4.artifact, undefined)
  assert.ok(!r4.text.includes('\uFFFD'), 'UTF-8 truncation must not split multibyte characters')

  stash.addRedaction('super-secret-value')
  const placeholder = '[REDACTED]'
  const leak = `prefix${placeholder} super-secret-value` + 'q'.repeat(33 * 1024)
  const r5 = await artifacts.spill(9, 'call-5', leak)
  assert.ok(r5.artifact !== undefined)
  const spilled = await artifacts.readContent(r5.artifact!.id)
  assert.ok(!spilled.includes('super-secret-value'), 'secret plaintext must never hit spilled file')
  assert.ok(spilled.includes(placeholder), 'placeholder should remain intact')
  assert.ok(!r5.text.includes('super-secret-value'), 'preview must not contain plaintext secrets')

  // Responses API compound callId (containing `|`) passes and stays distinct from `_` filenames
  const responsesStyle = await artifacts.spill(1, 'call_ab12|fc_call_ab12', 'z'.repeat(33 * 1024))
  const underscoreStyle = await artifacts.spill(1, 'call_ab12_fc_call_ab12', 'w'.repeat(33 * 1024))
  assert.ok(responsesStyle.artifact !== undefined, 'compound callId must spill cleanly')
  assert.ok(underscoreStyle.artifact !== undefined)
  assert.notEqual(responsesStyle.artifact!.path, underscoreStyle.artifact!.path, 'escaped path must not collide with underscores')
  assert.equal((await artifacts.readContent(responsesStyle.artifact!.id))[0], 'z')
  assert.equal((await artifacts.readContent(underscoreStyle.artifact!.id))[0], 'w')

  await assert.rejects(() => artifacts.spill(1, '../evil', 'x'), /callId/)
  await assert.rejects(() => artifacts.spill(1, 'a/b', 'x'), /callId/)
  await assert.rejects(() => artifacts.spill(1, '   ', 'x'), /callId/)
  await assert.rejects(() => artifacts.spill(1, '.', 'x'), /callId/)
  await assert.rejects(() => artifacts.spill(1, '..', 'x'), /callId/)
})

test('artifacts: redacts text artifacts on register, preserves binary bytes, and rejects forged metadata paths', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const repository = new InMemoryArtifactRepository()
  const stash = new SecretStash()
  const artifacts = new ArtifactService(dataDir, repository, stash)

  const secretValue = 'live-secret-token-for-register-test'
  stash.addRedaction(secretValue)
  const srcText = await tempSourceFile(`report header.\nsecret=${secretValue}\nreport tail.\n`)
  const meta = await artifacts.register(1, srcText, { name: 'report.md' })
  const stored = await readFile(join(dataDir, meta.path), 'utf8')
  assert.ok(!stored.includes(secretValue), 'registered text artifact must not keep plaintext secrets')
  assert.ok(stored.includes('[REDACTED]'), 'redacted artifact must carry placeholder')
  assert.ok(stored.includes('report header.'), 'non-secret text stays intact')
  const readBack = await artifacts.readContent(meta.id)
  assert.ok(!readBack.includes(secretValue))
  assert.equal(meta.mimeType, 'text/markdown')

  const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80])
  const srcBin = await tempSourceFile(binary)
  const metaBin = await artifacts.register(1, srcBin, { name: 'photo.png' })
  assert.equal(metaBin.mimeType, 'image/png')
  const storedBin = await readFile(join(dataDir, metaBin.path))
  assert.deepEqual(new Uint8Array(storedBin), binary, 'binary bytes must copy verbatim')
  const buf = await artifacts.readBuffer(metaBin.id)
  assert.deepEqual(new Uint8Array(buf), binary)

  const evil1 = { ...meta, id: 'evil-1', path: '/etc/passwd' }
  repository.put(evil1 as never)
  await assert.rejects(() => artifacts.readContent('evil-1'), /escapes|reject/)
  await assert.rejects(() => artifacts.readBuffer('evil-1'), /escapes|reject/)
  const evil2 = { ...meta, id: 'evil-2', path: 'artifacts/../../credentials.json' }
  repository.put(evil2 as never)
  await assert.rejects(() => artifacts.readContent('evil-2'), /escapes|reject/)
  assert.ok((await artifacts.readContent(meta.id)).includes('report header.'))

  await assert.rejects(() => artifacts.list(-1), /conversationId/)
  await assert.rejects(() => artifacts.list(1.5), /conversationId/)
  await assert.rejects(() => artifacts.deleteConversation(-1), /conversationId/)
})

// ---------------------------------------------------------------------------
// Cross-instance in-process concurrency serialization
// ---------------------------------------------------------------------------
test('concurrency regression: separate ConfigService instances in same dataDir preserve all updated keys', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const services = Array.from({ length: 5 }, () => new ConfigService(dataDir))
  await Promise.all(
    services.map((svc, i) => svc.update({ [`key${i}`]: `value-${i}` })),
  )
  const final = await services[0]!.get()
  for (let i = 0; i < 5; i++) {
    assert.equal(final[`key${i}`], `value-${i}`, `concurrent update must preserve key${i}`)
  }

  const services2 = Array.from({ length: 8 }, () => new ConfigService(dataDir))
  await Promise.all(
    services2.map((svc, i) => svc.update({ [`wave2-${i}`]: i })),
  )
  const final2 = await services2[0]!.get()
  for (let i = 0; i < 8; i++) assert.equal(final2[`wave2-${i}`], i)
  for (let i = 0; i < 5; i++) assert.equal(final2[`key${i}`], `value-${i}`)

  const linked = join(scratchRoot, `link-dir-${Date.now()}`)
  await symlink(await realpath(dataDir), linked)
  await Promise.all([
    new ConfigService(dataDir).update({ viaReal: 1 }),
    new ConfigService(linked).update({ viaLink: 1 }),
  ])
  const final3 = await new ConfigService(dataDir).get()
  assert.equal(final3['viaReal'], 1)
  assert.equal(final3['viaLink'], 1)
})

test('concurrency regression: separate AuthService instances permit exactly one setup', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) => new AuthService(dataDir).setup(`instance-pw-${i}-12345678`)),
  )
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  assert.equal(fulfilled.length, 1, 'only one concurrent AuthService setup should succeed')
  for (const r of results) {
    if (r.status === 'rejected') assert.match(String(r.reason), /already configured|duplicate/)
  }
  const ok = fulfilled[0] as PromiseFulfilledResult<{ token: string }>
  assert.equal(await new AuthService(dataDir).verifyToken(ok.value.token), true)

  const dataDir2 = await freshDataDir()
  await Promise.all([
    new AuthService(dataDir2).setup('interleave-pw-12345678'),
    new ConfigService(dataDir2).update({ theme: 'dark' }),
    new ConfigService(dataDir2).update({ locale: 'zh-CN' }),
  ])
  const cfg = await new ConfigService(dataDir2).get()
  assert.ok(cfg['auth'], 'interleaved updates must not overwrite auth')
  assert.equal(cfg['theme'], 'dark')
  assert.equal(cfg['locale'], 'zh-CN')
})

test('concurrency regression: separate CredentialService instances preserve all written credentials', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const services = Array.from({ length: 5 }, () => new CredentialService(dataDir))
  await Promise.all(
    services.map((svc, i) => svc.set(`provider-${i}`, `sk-value-${i}`)),
  )
  const ids = await services[0]!.list()
  assert.deepEqual(ids, ['provider-0', 'provider-1', 'provider-2', 'provider-3', 'provider-4'])
  for (let i = 0; i < 5; i++) {
    assert.equal(await services[i]!.get(`provider-${i}`), `sk-value-${i}`)
  }
})

test('cross-process lock regression: rejects corrupt locks, breaks dead holders, waits on live holders, leaves zero residue', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const target = join(dataDir, 'credentials.json')
  const lockFile = `${target}.lock`

  // 1) Corrupt lock (no PID): explicit error without guessing or breaking
  await writeFile(lockFile, 'not-a-pid garbage\n', { mode: 0o600 })
  await expectReject(() => withProcessFileLock(target, async () => 'ok'), /corrupt/)
  await rm(lockFile, { force: true })

  // 2) Dead holder (non-existent PID): breaks stale lock and cleans up on completion
  const deadPid = 2 ** 22 + Math.floor(Math.random() * 1000)
  {
    const probe = spawnSync(process.execPath, ['-e', 'process.exit(42)'])
    assert.equal(probe.status, 42)
  }
  await writeFile(lockFile, `${deadPid} uuid-dead\n`, { mode: 0o600 })
  assert.equal(await withProcessFileLock(target, async () => 'recovered'), 'recovered')
  assert.ok(!existsSync(lockFile), 'lock must be released after stale recovery')

  // 3) Live holder: waits cleanly instead of preempting
  const order: string[] = []
  const child = spawn(process.execPath, [
    '-e',
    `const fs = require('node:fs');
     const lock = ${JSON.stringify(lockFile)};
     fs.writeFileSync(lock, process.pid + ' child-uuid\\n', { flag: 'wx', mode: 0o600 });
     setTimeout(() => { fs.unlinkSync(lock); process.exit(0) }, 400)`,
  ])
  const childExit = new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)))
  await waitFor(() => existsSync(lockFile))
  const acquired = await withProcessFileLock(target, async () => {
    order.push('parent')
    return 'after-child'
  })
  assert.equal(acquired, 'after-child', 'live holder lock must never be preempted')
  assert.deepEqual(order, ['parent'])
  assert.equal(await childExit, 0)
  assert.ok(!existsSync(lockFile))

  // 4) No lock leaks on happy path
  const svc = new CredentialService(dataDir)
  await svc.set('solo', 'sk-solo-1234567890')
  assert.equal(await svc.get('solo'), 'sk-solo-1234567890')
  const leftovers = (await readdir(dataDir)).filter((f) => f.endsWith('.lock'))
  assert.deepEqual(leftovers, [], 'no lock leftovers on clean path')
})

test('cross-process lock regression: waits for real child lock holder during CredentialService.set without losing updates', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const svc = new CredentialService(dataDir)
  await svc.set('pre', 'sk-pre-0123456789')
  const lockFile = join(dataDir, 'credentials.json.lock')

  const child = spawn(process.execPath, [
    '-e',
    `const fs = require('node:fs');
     const lock = ${JSON.stringify(lockFile)};
     fs.writeFileSync(lock, process.pid + ' holder\\n', { flag: 'wx', mode: 0o600 });
     const t0 = Date.now();
     while (Date.now() - t0 < 300) {}
     fs.unlinkSync(lock);`,
  ])
  const childExit = new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)))
  await waitFor(() => existsSync(lockFile))
  await svc.set('during', 'sk-during-9876543210')
  assert.equal(await childExit, 0)
  assert.deepEqual(await svc.list(), ['during', 'pre'])
  assert.equal(await svc.get('during'), 'sk-during-9876543210')
  assert.equal(await svc.get('pre'), 'sk-pre-0123456789')
})

test('cross-process lock regression: concurrent CLI-protocol process and CredentialService preserve both cli and provider keys', { timeout: 60_000 }, async () => {
  const require = createRequire(import.meta.url)
  const tsxCli = require.resolve('tsx/cli')
  const repoRoot = dirname(testDir)
  const cliEntry = join(repoRoot, 'packages', 'cli', 'src', 'index.ts')
  const dataDir = join(tmpdir(), `helmx-xproc-${process.pid}-${Date.now()}`)
  const credFile = join(dataDir, 'credentials.json')

  const runCliChild = (password: string): Promise<{ code: number | null; err: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [tsxCli, cliEntry, 'login', '--password', password, '--json'], {
        env: { ...process.env, HELMX_DATA_DIR: dataDir, HELMX_HUB_URL: 'http://127.0.0.1:1', HELMX_TOKEN: '' },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let err = ''
      child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')))
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, err }))
    })
  void runCliChild

  try {
    await mkdir(dataDir, { recursive: true })
    await writeFile(credFile, JSON.stringify({ providers: {}, pluginSecrets: {} }), { mode: 0o600 })
    const svc = new CredentialService(dataDir)
    await svc.set('base', 'sk-base-0123456789')

    const holder = spawn(process.execPath, [
      '-e',
      `const fs = require('node:fs');
       const file = ${JSON.stringify(credFile)};
       const lock = file + '.lock';
       fs.writeFileSync(lock, process.pid + ' holder\\n', { flag: 'wx', mode: 0o600 });
       const t0 = Date.now();
       while (Date.now() - t0 < 300) {}
       const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
       raw.cli = { hubUrl: 'http://127.0.0.1:3202', token: 'tok-child-write' };
       const tmp = file + '.tmp-child';
       fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\\n', { mode: 0o600 });
       fs.renameSync(tmp, file);
       fs.unlinkSync(lock);`,
    ])
    const holderExit = new Promise<number | null>((resolve) => holder.on('close', (c) => resolve(c)))
    const lockFile = `${credFile}.lock`
    await waitFor(() => existsSync(lockFile))
    await svc.set('concurrent', 'sk-concurrent-abcdef123456')
    assert.equal(await holderExit, 0)

    const final = JSON.parse(await readFile(credFile, 'utf8')) as {
      cli: { token: string }
      providers: Record<string, { value: string }>
    }
    assert.equal(final.cli.token, 'tok-child-write', 'CLI key must not be clobbered by concurrent Hub write')
    assert.deepEqual(Object.keys(final.providers).sort(), ['base', 'concurrent'])
    assert.equal(final.providers['concurrent']!.value, 'sk-concurrent-abcdef123456')
    assert.ok(!(await readdir(dataDir)).some((f) => f.endsWith('.lock') || f.includes('.tmp')), 'no leftover lock/tmp files')
  } finally {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('concurrency regression: separate MemoryStore instances appending concurrently lose zero lines', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const base = new MemoryStore(createProfileFileHost(dataDir))
  await base.ensureMemory('assistant')
  const stores = Array.from({ length: 5 }, () => new MemoryStore(createProfileFileHost(dataDir)))
  await Promise.all(
    stores.map((store, i) => store.updateMemory('assistant', `row-${i}`, 'append')),
  )
  const text = await base.getMemory('assistant')
  for (let i = 0; i < 5; i++) {
    assert.ok(text.includes(`row-${i}`), `concurrent appends must not drop row-${i}`)
  }
  const lines = text.split('\n').filter((l: string) => l.length > 0)
  assert.equal(lines.length, 1 + 5)
})

test('credentials regression: preserves unknown top-level CLI keys and rejects malformed structures without clobbering', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const credentials = new CredentialService(dataDir)

  const raw = {
    cli: { hubUrl: 'http://127.0.0.1:3202', token: 'cli-tok-abc' },
    providers: { openai: { value: 'sk-first', createdAt: 't1', updatedAt: 't1' } },
    pluginSecrets: {},
    extraFlag: true,
  }
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'credentials.json'), JSON.stringify(raw, null, 2), { mode: 0o600 })
  assert.equal(await credentials.get('openai'), 'sk-first')
  await credentials.set('anthropic', 'sk-second')
  const after = JSON.parse(await readFile(join(dataDir, 'credentials.json'), 'utf8')) as Record<string, unknown>
  assert.deepEqual(after['cli'], raw['cli'], 'CLI key must remain intact')
  assert.equal(after['extraFlag'], true, 'other unknown top-level keys remain intact')
  assert.equal(
    (after['providers'] as Record<string, { value: string }>)['openai']!.value,
    'sk-first',
    'existing provider credential must not be overwritten',
  )
  await credentials.delete('openai')
  const after2 = JSON.parse(await readFile(join(dataDir, 'credentials.json'), 'utf8')) as Record<string, unknown>
  assert.deepEqual(after2['cli'], raw['cli'])

  const badPath = join(dataDir, 'credentials.json')
  await writeFile(badPath, JSON.stringify({ providers: { broken: { note: 'no value' } } }), { mode: 0o600 })
  await expectReject(() => credentials.list(), /broken/)
  await expectReject(() => credentials.set('x', 'v'), /broken/)
  assert.equal(JSON.parse(await readFile(badPath, 'utf8')).providers.broken.note, 'no value', 'must preserve original file on rejection')

  await writeFile(badPath, JSON.stringify({ providers: 'oops' }), { mode: 0o600 })
  await expectReject(() => credentials.list(), /providers/)

  await writeFile(
    badPath,
    JSON.stringify({ pluginSecrets: { 'p:x': { k: 123 } } }),
    { mode: 0o600 },
  )
  await expectReject(() => credentials.getPluginSecret('p:x', 'k'), /k/)
  assert.equal(JSON.parse(await readFile(badPath, 'utf8')).pluginSecrets['p:x'].k, 123)

  await writeFile(badPath, JSON.stringify({ pluginSecrets: { p: 'flat' } }), { mode: 0o600 })
  await expectReject(() => credentials.list(), /pluginSecrets|p/)

  await writeFile(badPath, JSON.stringify([1, 2]), { mode: 0o600 })
  await expectReject(() => credentials.list(), /invalid credentials\.json structure/)

  await writeFile(badPath, JSON.stringify({ providers: {} }), { mode: 0o644 })
  await credentials.list()
  assert.ok(await isPrivateMode(badPath), 'reading overly permissive credentials.json tightens mode back to 0600')
})

// ---------------------------------------------------------------------------
// Integration: atomic memory update + real-time watcher awareness
// ---------------------------------------------------------------------------
test('integration: MemoryStore atomic updates detected cleanly by watcher without tmp file events', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await ensureDataDir(dataDir)
  const store = new MemoryStore(createProfileFileHost(dataDir))
  await store.ensureMemory('assistant')

  const seen: string[] = []
  const watcher = new AssetWatcher(
    dataDir,
    (paths) => seen.push(...paths),
    { onError: (err) => assert.fail(`watcher must not error: ${String(err)}`) },
  )
  watcher.start()
  try {
    await store.updateMemory('assistant', 'user preference: concise replies', 'append')
    await waitFor(() => seen.some((p) => p === 'profiles/assistant/MEMORY.md'))
    const memory = await store.getMemory('assistant')
    assert.ok(memory.includes('user preference: concise replies'))
    for (const p of seen) assert.ok(!p.includes('.tmp'))
  } finally {
    watcher.close()
  }
})

// ---------------------------------------------------------------------------
// Cross-process lock: write grace period (wait/retry when fresh empty lock mtime < 1500ms)
// ---------------------------------------------------------------------------

test('cross-process lock regression: waits during write grace window for fresh empty locks instead of flagging corrupt; errors once expired', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const target = join(dataDir, 'credentials.json')
  const lockFile = `${target}.lock`

  // 1) Simulate concurrent process that opened('wx') before writing payload (empty + fresh mtime=now).
  const child = spawn(process.execPath, [
    '-e',
    `const fs = require('node:fs');
     const lock = ${JSON.stringify(lockFile)};
     const fd = fs.openSync(lock, 'wx', 0o600);
     setTimeout(() => { fs.writeSync(fd, process.pid + ' writer'); fs.closeSync(fd); fs.unlinkSync(lock); }, 200);`,
  ])
  const childExit = new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)))
  await waitFor(() => existsSync(lockFile))
  const acquired = await withProcessFileLock(target, async () => 'waited-fresh-lock')
  assert.equal(acquired, 'waited-fresh-lock', 'fresh empty/partial lock within grace period must wait rather than flag corrupt')
  assert.equal(await childExit, 0)
  assert.ok(!existsSync(lockFile))

  // 2) Past grace period (aged mtime) + empty content -> explicit corrupt error.
  await writeFile(lockFile, '', { mode: 0o600 })
  const old = new Date(Date.now() - 60_000)
  await utimes(lockFile, old, old)
  await expectReject(() => withProcessFileLock(target, async () => 'nope'), /corrupt/)

  // 3) Within grace period but PID already dead -> breaks stale lock (liveness precedes grace period).
  await rm(lockFile, { force: true })
  const deadPid = 2 ** 22 + Math.floor(Math.random() * 1000)
  await writeFile(lockFile, `${deadPid}`, { mode: 0o600 })
  assert.equal(await withProcessFileLock(target, async () => 'stale-fresh'), 'stale-fresh')
  assert.ok(!existsSync(lockFile))
})

test('watcher ignores .tmp-<pid> atomic tempfiles and non-recursive mode; SecretStash 1-char streaming redactor and ArtifactService.readSlice work accurately', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  await mkdir(join(dataDir, 'nested'), { recursive: true })
  const seen: string[] = []
  const watcher = new AssetWatcher(
    dataDir,
    (paths) => seen.push(...paths),
    {
      recursive: false,
      debounceMs: 30,
      onError: (err) => assert.fail(`non-recursive watcher error: ${String(err)}`),
    },
  )
  watcher.start()
  try {
    await writeFile(join(dataDir, 'hub-activity.json.tmp-4242'), '{}')
    await writeFile(join(dataDir, 'nested', 'ignored.json'), '{}')
    await writeFile(join(dataDir, 'config.json'), '{"ok":true}')
    await waitFor(() => seen.includes('config.json'))
    for (const p of seen) {
      assert.ok(!p.includes('.tmp-'), `must ignore .tmp-<pid> tempfile, got ${p}`)
      assert.ok(!p.startsWith('nested/'), `non-recursive watcher must ignore nested path, got ${p}`)
    }
  } finally {
    watcher.close()
  }

  // SecretStash 1-char streaming redactor must not drop buffered text via slice(-0).
  const stash = new SecretStash()
  stash.addRedaction('Z')
  const redactor = stash.createStreamingRedactor()
  const out = redactor.push('alpha') + redactor.push('Zomega') + redactor.flush()
  assert.equal(out, 'alpha[REDACTED]omega')

  // ArtifactService.readSlice reads positioned byte window without reading entire file.
  const repo = new InMemoryArtifactRepository()
  const artifacts = new ArtifactService(dataDir, repo, stash)
  const uploaded = await artifacts.writeUploaded(1, {
    name: 'slice.bin',
    bytes: Buffer.from('0123456789abcdef', 'utf8'),
    mimeType: 'text/plain',
  })
  const res = await artifacts.readSlice(uploaded.id, 4, 6)
  assert.equal(res.totalSize, 16)
  assert.equal(Buffer.from(res.slice).toString('utf8'), '456789')
})

test('cleanup temp directory', { timeout: 60_000 }, async () => {
  await rm(scratchRoot, { recursive: true, force: true })
  const res = spawnSync('tsx', ['--version'], { encoding: 'utf8' })
  assert.equal(res.status, 0)
})

test('profiles: restrictToCwd persists and reloads; non-boolean rejects at the boundary', { timeout: 60_000 }, async () => {
  const dataDir = await freshDataDir()
  const profiles = new ProfileService(dataDir)
  await profiles.save({ id: 'worker', name: 'worker', tags: ['worker'], restrictToCwd: true })
  assert.equal((await profiles.get('worker'))?.restrictToCwd, true)
  // Full replacement semantics: omitting the key clears it back to the unrestricted default
  await profiles.save({ id: 'worker', name: 'worker', tags: ['worker'] })
  assert.equal((await profiles.get('worker'))?.restrictToCwd, undefined)
  await assert.rejects(
    () => profiles.save({ id: 'bad', tags: [], restrictToCwd: 'yes' } as never),
    /restrictToCwd/,
  )
})
