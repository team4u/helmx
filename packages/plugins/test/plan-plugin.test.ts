/**
 * builtin:plan unit & PluginHost behavior tests:
 * 1. Contracts & pure helpers: scope eligibility, slash parsing, deleted event extraction,
 *    and `PLAN_TOOL_META_SCHEMA` validation via `assertBoundedPresentationMeta`.
 * 2. Registration, UI specs & metadata contracts:
 *    - Bilingual `{ en, 'zh-CN' }` display metadata + English-only action/tool execution copy;
 *    - `executionModel` configSchema (`type: 'string', format: 'model', default: ''`);
 *    - Valid `HelmxIcon` names, zero Emoji, clean registration & compilation of all 5 UI surfaces.
 * 3. Actions (`toggle`, `set_mode`, `get`) & scope guard:
 *    - Top-level human vs child / `helmx`-owned (`400 plan_unsupported_conversation`), 404, arg conflicts;
 *    - Cancelling active `pendingAskId` on `toggle` / `set_mode('normal')`, ignoring 404/409.
 * 4. `onInput` & `onBeforeTurn` hooks:
 *    - `/plan` bare -> `handled` + switches to `planning` + flushes KV + updates projections;
 *    - `/plan <task>` -> `transform` with trimmed remainder + switches to `planning`;
 *    - Ignores `/planner`, `agent`/`trigger` origin, and non-eligible conversations;
 *    - `normal` / non-eligible strips `plan_save` & `plan_propose` with no sections;
 *    - `planning` keeps strict whitelist (`read`, `read_artifact`, `bash`, `load_skill`, `plan_save`, `plan_propose`)
 *      and injects `plan.mode` guardrail section (suppressing profile collaboration catalog at `-100`).
 * 5. `plan_save` & `plan_propose`:
 *    - Title/markdown bounds, SecretStash redaction, version bump, flush, projection updates;
 *    - Summary bounds & code-fence rejection (`AskDock` snapshot guard), duplicate ask guard;
 *    - AbortSignal cancellation, `superseded` / `cancelled` / `revise` stay `planning` (unless toggled to `normal`);
 *    - `approve` creates `plan-v<N>.md`, switches to `normal`, flushes;
 *    - `approve_handoff` & `approve_handoff_model` (model switch first, honest error on `409 model_disabled` / `404 model_tier_not_found` staying `planning`; on success artifact + `normal` + `control.handoff` capped <= 128 KiB).
 * 6. Lifecycle & cleanup:
 *    - `conversation.deleted` cancels dangling `pendingAskId`, deletes KV, flushes, clears projections;
 *    - `start()` hydrates `plan-badges` & `sessionDoc`;
 *    - `reconcile()` cancels orphaned `pendingAskId` with `superseded` (ignoring 404/409) & clears KV;
 *    - `liveTasks()` blocks disable (`409 plugin_has_live_tasks`); `inUse()` blocks non-force disable (`409 plugin_in_use`);
 *    - `stop()` sets stopping, cancels & awaits in-flight waiters cleanly.
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  COMPOSER_DOCK_SLOT,
  COMPOSER_TOOLBAR_SLOT,
  HelmxError,
  assertBoundedPresentationMeta,
  parseNonEmptyLocalizedText,
  type ArtifactMetadata,
  type AskCreateSpec,
  type AskResult,
  type BeforeTurnHookPayload,
  type ConversationPatch,
  type ConversationSummary,
  type LocalizedText,
  type PluginToolResultEnvelope,
  type PluginToolSpec,
} from '@helmx/protocol'
import { PluginHost, type PluginHostBackend } from '@helmx/kernel'
import { pluginToolResult } from '@helmx/kernel/testing'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import {
  PLAN_ASK_META_SCHEMA,
  PLAN_BADGES_DOC,
  PLAN_COMMAND_ID,
  PLAN_COMMAND_SLASH,
  PLAN_HANDOFF_MAX_BYTES,
  PLAN_INPUT_META_KEY,
  PLAN_KV_NAMESPACE,
  PLAN_MARKDOWN_MAX_BYTES,
  PLAN_MODE_SECTION_ID,
  PLAN_MODE_TOOL_WHITELIST,
  PLAN_PANEL_ID,
  PLAN_PLUGIN_ID,
  PLAN_SESSION_DOC,
  PLAN_SUMMARY_MAX_CHARS,
  PLAN_TITLE_MAX_CHARS,
  PLAN_TOOL_ASK,
  PLAN_TOOL_BASH,
  PLAN_TOOL_META_SCHEMA,
  PLAN_TOOL_PROPOSE,
  PLAN_TOOL_SAVE,
  asPlanDeletedConversationId,
  createPlanPlugin,
  hasPlanModeInputMeta,
  isPlanConversationEligible,
  parsePlanSlashInput,
  validateReadOnlyShellCommand,
  type PlanAskKind,
  type PlanBadgesDoc,
  type PlanConversationRecord,
  type PlanPluginOptions,
  type PlanSessionView,
} from '../src/plan.js'
import {
  MemoryConfigStore,
  MemoryDocStore,
  MemoryKvStore,
  assertRejectsCode,
  cleanupDir,
  deferred,
  makeConversationSummary,
  makeTempDir,
  waitFor,
  type Deferred,
} from './helpers/plugin-test-env.js'

const TIMEOUT = { timeout: 60_000 } as const
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
const HAN_RE = /[\u4e00-\u9fff]/

function unsupportedHostCapability(what: string): never {
  throw new HelmxError(
    'unsupported',
    `plan test fixture does not implement host capability: ${what}`,
    501,
  )
}

function makeUnsupportedBackendBase(): PluginHostBackend {
  return {
    isClosing: () => false,
    redact: (text) => text,
    profiles: {
      list: () => unsupportedHostCapability('host.profiles.list'),
      get: () => unsupportedHostCapability('host.profiles.get'),
      getSystem: () => unsupportedHostCapability('host.profiles.getSystem'),
      save: () => unsupportedHostCapability('host.profiles.save'),
      directory: () => unsupportedHostCapability('host.profiles.directory'),
    },
    skills: {
      list: () => unsupportedHostCapability('host.skills.list'),
      readFile: () => unsupportedHostCapability('host.skills.readFile'),
      ensureSkill: async () => {},
    },
    secrets: {
      get: () => unsupportedHostCapability('host.secrets.get'),
      set: () => unsupportedHostCapability('host.secrets.set'),
      delete: () => unsupportedHostCapability('host.secrets.delete'),
      addRedaction: () => () => {},
    },
    dispatchTrigger: () => unsupportedHostCapability('host.dispatchTrigger'),
    submitInput: () => unsupportedHostCapability('host.submitInput'),
    createConversation: () => unsupportedHostCapability('host.createConversation'),
    forkConversation: () => unsupportedHostCapability('host.forkConversation'),
    listConversations: () => unsupportedHostCapability('host.listConversations'),
    getConversation: () => unsupportedHostCapability('host.getConversation'),
    getConversationDetail: () => unsupportedHostCapability('host.getConversationDetail'),
    updateConversation: () => unsupportedHostCapability('host.updateConversation'),
    abortConversation: () => unsupportedHostCapability('host.abortConversation'),
    getConversationOwnership: () => unsupportedHostCapability('host.getConversationOwnership'),
    markConversationOwnership: () => unsupportedHostCapability('host.markConversationOwnership'),
    spawnAgent: () => unsupportedHostCapability('host.spawnAgent'),
    runGate: () => unsupportedHostCapability('host.runGate'),
    resolveSpawnTarget: () => unsupportedHostCapability('host.resolveSpawnTarget'),
    listActiveSpawnExecutions: () => unsupportedHostCapability('host.listActiveSpawnExecutions'),
    inspectNodePathUsage: () => unsupportedHostCapability('host.inspectNodePathUsage'),
    withFileLock: () => unsupportedHostCapability('host.withFileLock'),
    atomicWriteFile: () => unsupportedHostCapability('host.atomicWriteFile'),
    refreshModels: () => unsupportedHostCapability('host.refreshModels'),
    completeText: () => unsupportedHostCapability('host.completeText'),
    executionEnv: () => unsupportedHostCapability('host.executionEnv'),
    execEnv: () => unsupportedHostCapability('host.execEnv'),
    listArtifacts: () => unsupportedHostCapability('host.listArtifacts'),
    createAsk: () => unsupportedHostCapability('host.createAsk'),
    cancelAsk: () => unsupportedHostCapability('host.cancelAsk'),
    onEvent: () => unsupportedHostCapability('host.onEvent'),
    emitEvent: () => unsupportedHostCapability('host.emitEvent'),
    manageConversation: () => unsupportedHostCapability('host.manageConversation'),
  }
}

function makeToolSpec(name: string): PluginToolSpec {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    execute: () => 'ok',
  }
}

interface PendingAskEntry {
  spec: AskCreateSpec
  id: string
  status: 'pending' | 'answered' | 'cancelled' | 'superseded'
  waiter: Deferred<AskResult>
}

interface PlanHarness {
  host: PluginHost
  kvStore: MemoryKvStore
  docStore: MemoryDocStore
  configStore: MemoryConfigStore
  conversations: Map<number, ConversationSummary>
  createdAsks: AskCreateSpec[]
  cancelledAsks: Array<{ askId: string; reason: 'cancelled' | 'superseded' }>
  createdArtifacts: Array<{ conversationId: number; name: string; text: string; artifact: ArtifactMetadata }>
  updateCalls: Array<{ id: number; patch: ConversationPatch }>
  emittedEvents: Array<{ type: string; payload: unknown }>
  pendingAsks: Map<string, PendingAskEntry>
  execEnvCalls: Array<Parameters<PluginHostBackend['execEnv']>[0]>
  setExecEnvHandler(
    fn:
      | ((input: Parameters<PluginHostBackend['execEnv']>[0]) => ReturnType<PluginHostBackend['execEnv']>)
      | undefined,
  ): void
  setCreateAskHandler(fn: ((spec: AskCreateSpec) => Promise<AskResult>) | undefined): void
  setCancelAskError(err: Error | undefined): void
  setUpdateConversationHandler(
    fn: ((id: number, patch: ConversationPatch) => Promise<ConversationSummary>) | undefined,
  ): void
  setCreateArtifactHandler(
    fn:
      | ((conversationId: number, input: { name: string; bytes: Uint8Array; mimeType?: string }) => Promise<ArtifactMetadata>)
      | undefined,
  ): void
  answerAsk(askId: string, answers: Record<string, string>): void
  cancelAsk(askId: string, reason: 'cancelled' | 'superseded'): void
  dispatchEvent(type: string, payload: unknown): Promise<void>
  readBadgesDoc(): PlanBadgesDoc
  readSessionDoc(conversationId: number): PlanSessionView
  close(): Promise<void>
}

async function openPlanHarness(options: {
  pluginOptions?: PlanPluginOptions
  initialConfig?: Record<string, unknown>
  deferServices?: boolean
  kvStore?: MemoryKvStore
  skipClientRoot?: boolean
  seedConversations?: ConversationSummary[]
} = {}): Promise<PlanHarness> {
  const dataDir = await makeTempDir('helmx-plan-unit-')
  const clientDir = options.skipClientRoot ? undefined : await makeTempDir('helmx-plan-client-')
  if (clientDir !== undefined) {
    writeFileSync(
      join(clientDir, 'index.tsx'),
      [
        'export function PlanToolbarButton() { return null }',
        'export function PlanActiveTray() { return null }',
        'export function PlanWorkbenchPanel() { return null }',
        'export function PlanToolRow() { return null }',
      ].join('\n'),
      'utf8',
    )
  }

  const kvStore = options.kvStore ?? new MemoryKvStore()
  const docStore = new MemoryDocStore()
  const configStore = new MemoryConfigStore(options.initialConfig ?? {})
  const conversations = new Map<number, ConversationSummary>()
  for (const conv of options.seedConversations ?? [makeConversationSummary({ id: 1, stateChangeSeq: 5 })]) {
    conversations.set(conv.id, conv)
  }

  const createdAsks: AskCreateSpec[] = []
  const cancelledAsks: Array<{ askId: string; reason: 'cancelled' | 'superseded' }> = []
  const createdArtifacts: Array<{ conversationId: number; name: string; text: string; artifact: ArtifactMetadata }> = []
  const updateCalls: Array<{ id: number; patch: ConversationPatch }> = []
  const emittedEvents: Array<{ type: string; payload: unknown }> = []
  const listeners = new Map<string, Set<(payload: unknown) => Promise<void> | void>>()
  const pendingAsks = new Map<string, PendingAskEntry>()
  const sessionDocMirror = new Map<number, PlanSessionView>()
  const execEnvCalls: Array<Parameters<PluginHostBackend['execEnv']>[0]> = []

  let customExecEnv:
    | ((input: Parameters<PluginHostBackend['execEnv']>[0]) => ReturnType<PluginHostBackend['execEnv']>)
    | undefined
  let customCreateAsk: ((spec: AskCreateSpec) => Promise<AskResult>) | undefined
  let cancelAskError: Error | undefined
  let customUpdateConversation:
    | ((id: number, patch: ConversationPatch) => Promise<ConversationSummary>)
    | undefined
  let customCreateArtifact:
    | ((conversationId: number, input: { name: string; bytes: Uint8Array; mimeType?: string }) => Promise<ArtifactMetadata>)
    | undefined
  let artifactSeq = 0

  const backend: PluginHostBackend = {
    ...makeUnsupportedBackendBase(),
    async execEnv(input) {
      execEnvCalls.push(structuredClone(input))
      if (customExecEnv !== undefined) {
        return customExecEnv(input)
      }
      return { ok: true, exitCode: 0, timedOut: false, output: 'mocked execEnv output' }
    },
    redact: (text) => text.replaceAll('SECRET_TOKEN', '[REDACTED]'),
    listConversations(filter) {
      let items = [...conversations.values()].map((c) => structuredClone(c))
      if (filter?.ownedBy !== undefined) {
        items = items.filter((c) => (c.ownedBy ?? 'human') === filter.ownedBy)
      }
      if (filter?.topLevelOnly) {
        items = items.filter((c) => c.parentConversationId === undefined)
      }
      return items
    },
    getConversation(id) {
      const conv = conversations.get(id)
      if (!conv) throw new HelmxError('not_found', `Conversation ${id} not found`, 404, { conversationId: id })
      return structuredClone(conv)
    },
    async updateConversation(id, patch) {
      updateCalls.push({ id, patch: structuredClone(patch) })
      if (customUpdateConversation !== undefined) {
        return customUpdateConversation(id, patch)
      }
      const existing = conversations.get(id)
      if (!existing) throw new HelmxError('not_found', `Conversation ${id} not found`, 404, { conversationId: id })
      const updated: ConversationSummary = {
        ...existing,
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        stateChangeSeq: existing.stateChangeSeq + 1,
        updatedAt: Date.now(),
      }
      conversations.set(id, updated)
      return structuredClone(updated)
    },
    async createArtifact(conversationId, input) {
      if (customCreateArtifact !== undefined) {
        return customCreateArtifact(conversationId, input)
      }
      if (!conversations.has(conversationId)) {
        throw new HelmxError('not_found', `Conversation ${conversationId} not found`, 404, { conversationId })
      }
      artifactSeq += 1
      const artifact: ArtifactMetadata = {
        id: `art-${artifactSeq}`,
        conversationId,
        kind: 'upload',
        name: input.name,
        mimeType: input.mimeType ?? 'text/markdown',
        size: input.bytes.byteLength,
        path: `uploads/art-${artifactSeq}-${input.name}`,
        createdAt: Date.now(),
      }
      createdArtifacts.push({
        conversationId,
        name: input.name,
        text: new TextDecoder().decode(input.bytes),
        artifact,
      })
      return structuredClone(artifact)
    },
    async createAsk(spec) {
      createdAsks.push(structuredClone(spec))
      if (customCreateAsk !== undefined) {
        return customCreateAsk(spec)
      }
      const id = spec.id ?? `ask-${createdAsks.length}`
      const existing = pendingAsks.get(id)
      if (existing !== undefined) {
        throw new HelmxError('ask_id_conflict', `AskDoc '${id}' already exists`, 409)
      }
      const entry: PendingAskEntry = {
        spec: structuredClone(spec),
        id,
        status: 'pending',
        waiter: deferred<AskResult>(),
      }
      pendingAsks.set(id, entry)
      return entry.waiter.promise
    },
    async cancelAsk(askId, reason = 'cancelled') {
      cancelledAsks.push({ askId, reason })
      if (cancelAskError !== undefined) {
        throw cancelAskError
      }
      const entry = pendingAsks.get(askId)
      if (!entry) {
        throw new HelmxError('not_found', `AskDoc not found: ${askId}`, 404)
      }
      if (entry.status !== 'pending') {
        throw new HelmxError('ask_already_settled', `AskDoc already settled: ${entry.status}`, 409)
      }
      entry.status = reason
      entry.waiter.resolve({ id: askId, status: reason, answers: {} })
    },
    onEvent(type: string, listener: (payload: unknown) => Promise<void> | void) {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(listener)
      return () => {
        set?.delete(listener)
      }
    },
    emitEvent(type: string, payload: unknown) {
      emittedEvents.push({ type, payload: structuredClone(payload) })
      if (type === 'plugin.session_doc.updated') {
        const doc = (payload as { doc?: { pluginId?: string; name?: string; conversationId?: number; value?: unknown; deleted?: boolean } }).doc
        if (doc?.pluginId === PLAN_PLUGIN_ID && doc.name === PLAN_SESSION_DOC && doc.conversationId !== undefined) {
          if (doc.deleted) sessionDocMirror.delete(doc.conversationId)
          else sessionDocMirror.set(doc.conversationId, structuredClone(doc.value as PlanSessionView))
        }
      }
    },
  }

  const host = new PluginHost({
    dataDir,
    host: backend,
    docs: docStore,
    kv: kvStore,
    config: configStore,
    buildProvider: createPluginBuildProvider(),
    deferServices: options.deferServices ?? false,
  })

  const pluginDef = createPlanPlugin(
    options.pluginOptions ?? (clientDir !== undefined ? { clientAssets: { clientRoot: clientDir } } : { clientAssets: {} }),
  )
  await host.register(pluginDef)

  return {
    host,
    kvStore,
    docStore,
    configStore,
    conversations,
    createdAsks,
    cancelledAsks,
    createdArtifacts,
    updateCalls,
    emittedEvents,
    pendingAsks,
    execEnvCalls,
    setExecEnvHandler: (fn) => {
      customExecEnv = fn
    },
    setCreateAskHandler: (fn) => {
      customCreateAsk = fn
    },
    setCancelAskError: (err) => {
      cancelAskError = err
    },
    setUpdateConversationHandler: (fn) => {
      customUpdateConversation = fn
    },
    setCreateArtifactHandler: (fn) => {
      customCreateArtifact = fn
    },
    answerAsk(askId, answers) {
      const entry = pendingAsks.get(askId)
      if (!entry) throw new Error(`No pending ask ${askId}`)
      if (entry.status !== 'pending') throw new Error(`Ask ${askId} already settled as ${entry.status}`)
      entry.status = 'answered'
      entry.waiter.resolve({ id: askId, status: 'answered', answers })
    },
    cancelAsk(askId, reason) {
      const entry = pendingAsks.get(askId)
      if (!entry) throw new Error(`No pending ask ${askId}`)
      if (entry.status !== 'pending') throw new Error(`Ask ${askId} already settled as ${entry.status}`)
      entry.status = reason
      entry.waiter.resolve({ id: askId, status: reason, answers: {} })
    },
    async dispatchEvent(type, payload) {
      const set = listeners.get(type)
      if (!set) return
      for (const fn of [...set]) {
        await fn(payload)
      }
    },
    readBadgesDoc(): PlanBadgesDoc {
      return host.getPublicDoc(PLAN_PLUGIN_ID, PLAN_BADGES_DOC).value as PlanBadgesDoc
    },
    readSessionDoc(conversationId: number): PlanSessionView {
      return host.getPublicSessionDoc(PLAN_PLUGIN_ID, PLAN_SESSION_DOC, conversationId).value as PlanSessionView
    },
    async close() {
      await host.dispose().catch(() => {})
      await cleanupDir(dataDir)
      if (clientDir !== undefined) {
        await cleanupDir(clientDir)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 1. Pure contracts & schemas
// ---------------------------------------------------------------------------

test('contracts: eligibility, slash parser, deleted event guard, and PLAN_TOOL_META_SCHEMA', TIMEOUT, () => {
  assert.equal(isPlanConversationEligible({ parentConversationId: undefined, ownedBy: undefined }), true)
  assert.equal(isPlanConversationEligible({ parentConversationId: undefined, ownedBy: 'human' }), true)
  assert.equal(isPlanConversationEligible({ parentConversationId: 1, ownedBy: 'human' }), false)
  assert.equal(isPlanConversationEligible({ parentConversationId: undefined, ownedBy: 'helmx' }), false)

  assert.deepEqual(parsePlanSlashInput('/plan'), { matched: true, remainder: '' })
  assert.deepEqual(parsePlanSlashInput('  /plan   \n  '), { matched: true, remainder: '' })
  assert.deepEqual(parsePlanSlashInput('/plan  design auth\nwith JWT  '), {
    matched: true,
    remainder: 'design auth\nwith JWT',
  })
  assert.deepEqual(parsePlanSlashInput('/planner foo'), { matched: false })
  assert.deepEqual(parsePlanSlashInput('hello /plan'), { matched: false })

  assert.equal(asPlanDeletedConversationId({ type: 'conversation.deleted', conversationId: 42 }), 42)
  assert.equal(asPlanDeletedConversationId({ type: 'conversation.upsert', conversationId: 42 }), undefined)
  assert.equal(asPlanDeletedConversationId({ type: 'conversation.deleted', conversationId: 0 }), undefined)

  const saveMeta = assertBoundedPresentationMeta(
    { kind: 'save', title: 'Auth Plan', version: 1, lineCount: 10, charCount: 250 },
    { schema: PLAN_TOOL_META_SCHEMA },
  )
  assert.equal(saveMeta['kind'], 'save')

  const proposeMeta = assertBoundedPresentationMeta(
    {
      kind: 'propose',
      title: 'Auth Plan',
      version: 1,
      outcome: 'approved_handoff',
      artifactId: 'art-1',
      artifactName: 'plan-v1.md',
      executionModel: 'tier/strong',
    },
    { schema: PLAN_TOOL_META_SCHEMA },
  )
  assert.equal(proposeMeta['outcome'], 'approved_handoff')

  assert.throws(
    () => assertBoundedPresentationMeta({ kind: 'save', title: 'X' }, { schema: PLAN_TOOL_META_SCHEMA }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result',
  )
})

// ---------------------------------------------------------------------------
// 2. UI declarations, config schema, bilingual display metadata, zero Emoji
// ---------------------------------------------------------------------------

test('registration: registers valid UI specs, model configSchema, bilingual labels, English execution copy, and zero Emoji', TIMEOUT, async () => {
  const harness = await openPlanHarness()
  try {
    const summary = harness.host.list().find((p) => p.id === PLAN_PLUGIN_ID)
    assert.ok(summary && summary.enabled)
    assert.equal(summary.icon, 'list-tree')
    assert.equal(summary.locked, false)

    // Bilingual display metadata + zero Emoji
    assert.notEqual(parseNonEmptyLocalizedText(summary.name as LocalizedText), undefined)
    assert.notEqual(parseNonEmptyLocalizedText(summary.description as LocalizedText), undefined)
    assert.equal(EMOJI_RE.test(JSON.stringify(summary)), false)

    // Config schema check
    const cfg = harness.host.getConfigSchema(PLAN_PLUGIN_ID)
    assert.ok(cfg['executionModel'])
    assert.equal(cfg['executionModel'].type, 'string')
    assert.equal(cfg['executionModel'].format, 'model')
    assert.equal(cfg['executionModel'].default, '')
    assert.notEqual(parseNonEmptyLocalizedText(cfg['executionModel'].label), undefined)
    assert.notEqual(parseNonEmptyLocalizedText(cfg['executionModel'].description), undefined)

    // UI contributions check
    const ui = harness.host.listUi().filter((u) => u.pluginId === PLAN_PLUGIN_ID)
    assert.equal(ui.length, 5)
    assert.equal(EMOJI_RE.test(JSON.stringify(ui)), false)

    const cmd = ui.find((u) => u.surface === 'commandPalette')?.spec as Record<string, unknown>
    assert.equal(cmd['id'], PLAN_COMMAND_ID)
    assert.equal(cmd['slash'], PLAN_COMMAND_SLASH)
    assert.equal(cmd['actionId'], 'toggle')
    assert.equal(cmd['icon'], 'list-tree')
    assert.deepEqual(cmd['scope'], {})

    const toolbarSlot = ui.find((u) => u.surface === 'plugin.slot' && (u.spec as { id?: string }).id === 'plan-toolbar')?.spec as Record<string, unknown>
    assert.equal(toolbarSlot['target'], COMPOSER_TOOLBAR_SLOT)
    assert.equal(toolbarSlot['order'], 20)
    assert.deepEqual(toolbarSlot['client'], { module: 'index.tsx', export: 'PlanToolbarButton' })

    const dockSlot = ui.find((u) => u.surface === 'plugin.slot' && (u.spec as { id?: string }).id === 'plan-active-tray')?.spec as Record<string, unknown>
    assert.equal(dockSlot['target'], COMPOSER_DOCK_SLOT)
    assert.equal(dockSlot['order'], 20)
    assert.deepEqual(dockSlot['client'], { module: 'index.tsx', export: 'PlanActiveTray' })

    const panel = ui.find((u) => u.surface === 'workbench.panel')?.spec as Record<string, unknown>
    assert.equal(panel['id'], PLAN_PANEL_ID)
    assert.equal(panel['icon'], 'list-tree')
    assert.deepEqual(panel['badge'], { doc: PLAN_BADGES_DOC, byConversationField: 'byConversation' })
    assert.deepEqual(panel['client'], { module: 'index.tsx', export: 'PlanWorkbenchPanel' })

    const toolView = ui.find((u) => u.surface === 'tool.view')?.spec as Record<string, unknown>
    assert.equal(toolView['id'], 'plan-tool-row')
    assert.deepEqual(toolView['toolNames'], [PLAN_TOOL_SAVE, PLAN_TOOL_PROPOSE, PLAN_TOOL_ASK])
    assert.equal(toolView['replaceRow'], true)
    assert.deepEqual(toolView['client'], { module: 'index.tsx', export: 'PlanToolRow' })

    // Verify client module compiles cleanly via plugin-build
    const compiled = await harness.host.getClientModule(PLAN_PLUGIN_ID, 'index.tsx')
    assert.ok(compiled.code.includes('PlanToolbarButton'))

    // Actions & tools: English-only execution copy and exposeToPrompt: false
    const actions = harness.host.listActions().filter((a) => a.pluginId === PLAN_PLUGIN_ID)
    assert.deepEqual(actions.map((a) => a.id).sort(), ['get', 'set_mode', 'toggle', 'update_draft'])
    for (const action of actions) {
      assert.equal(action.visibility, 'public')
      assert.equal(action.exposeToPrompt, false)
      assert.equal(HAN_RE.test(action.description), false)
      assert.equal(HAN_RE.test(JSON.stringify(action.inputSchema)), false)
      assert.equal(HAN_RE.test(JSON.stringify(action.outputSchema)), false)
    }
    const getManifest = actions.find((a) => a.id === 'get')
    assert.equal(getManifest?.idempotent, true)

    const tools = harness.host.listTools().filter((t) => t.sourcePluginId === PLAN_PLUGIN_ID)
    assert.deepEqual(tools.map((t) => t.name).sort(), [PLAN_TOOL_ASK, PLAN_TOOL_BASH, PLAN_TOOL_PROPOSE, PLAN_TOOL_SAVE])
    for (const tool of tools) {
      assert.equal(HAN_RE.test(tool.description), false)
      assert.equal(HAN_RE.test(JSON.stringify(tool.promptGuidelines ?? [])), false)
      assert.equal(HAN_RE.test(JSON.stringify(tool.inputSchema)), false)
    }
  } finally {
    await harness.close()
  }
})

// ---------------------------------------------------------------------------
// 3. Actions & scope guard
// ---------------------------------------------------------------------------

test('actions: toggle, set_mode, get enforce scope guard, flush KV, update projections, and cancel pendingAskId', TIMEOUT, async () => {
  const harness = await openPlanHarness({
    seedConversations: [
      makeConversationSummary({ id: 1, stateChangeSeq: 2 }),
      makeConversationSummary({ id: 2, parentConversationId: 1 }),
      makeConversationSummary({ id: 3, ownedBy: 'helmx' }),
    ],
  })
  try {
    // Missing conversation -> 404
    await assertRejectsCode(() => harness.host.invokeAction(PLAN_PLUGIN_ID, 'toggle', { conversationId: 999 }), 'not_found')
    await assertRejectsCode(() => harness.host.invokeAction(PLAN_PLUGIN_ID, 'get', { conversationId: 999 }), 'not_found')

    // Missing / conflicting conversationId -> 400 validation_error
    await assertRejectsCode(() => harness.host.invokeAction(PLAN_PLUGIN_ID, 'toggle', {}), 'validation_error')
    await assertRejectsCode(
      () => harness.host.invokeAction(PLAN_PLUGIN_ID, 'toggle', { conversationId: 1 }, { conversationId: 2 }),
      'validation_error',
    )

    // Child and helmx-owned conversations -> 400 plan_unsupported_conversation for toggle/set_mode; default view for get
    await assertRejectsCode(
      () => harness.host.invokeAction(PLAN_PLUGIN_ID, 'toggle', { conversationId: 2 }),
      'plan_unsupported_conversation',
    )
    await assertRejectsCode(
      () => harness.host.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: 3, mode: 'planning' }),
      'plan_unsupported_conversation',
    )
    assert.deepEqual(await harness.host.invokeAction(PLAN_PLUGIN_ID, 'get', { conversationId: 2 }), {
      mode: 'normal',
      awaitingApproval: false,
    })

    // Initial get on eligible conv 1
    assert.deepEqual(await harness.host.invokeAction(PLAN_PLUGIN_ID, 'get', {}, { conversationId: 1 }), {
      mode: 'normal',
      awaitingApproval: false,
    })

    // Toggle -> planning
    const flushesBefore = harness.kvStore.flushCount
    const toggledOn = (await harness.host.invokeAction(PLAN_PLUGIN_ID, 'toggle', {}, { conversationId: 1 })) as PlanSessionView
    assert.deepEqual(toggledOn, { mode: 'planning', awaitingApproval: false })
    assert.ok(harness.kvStore.flushCount > flushesBefore)
    assert.deepEqual(harness.readSessionDoc(1), { mode: 'planning', awaitingApproval: false })
    assert.equal(harness.readBadgesDoc().byConversation['1']?.tone, 'accent')

    // Seed a pendingAskId and verify set_mode('normal') cancels it (and ignores 404/409)
    const proposePromise = harness.host.executeTool(
      PLAN_TOOL_PROPOSE,
      { summary: 'Pending summary' },
      { conversationId: 1 },
    )
    // Wait until draft exists? No, save first!
    const proposeNoDraft = (await proposePromise) as PluginToolResultEnvelope
    assert.equal(proposeNoDraft.isError, true)

    await harness.host.executeTool(
      PLAN_TOOL_SAVE,
      { title: 'Temp Plan', markdown: '# Step 1\nDo it' },
      { conversationId: 1 },
    )
    const inFlight = harness.host.executeTool(
      PLAN_TOOL_PROPOSE,
      { summary: 'Ready for review' },
      { conversationId: 1 },
    ) as Promise<PluginToolResultEnvelope>

    await waitFor(() => harness.createdAsks.length === 1)
    const askId = harness.createdAsks[0]!.id!
    assert.equal(harness.readSessionDoc(1).awaitingApproval, true)
    assert.equal(harness.readBadgesDoc().byConversation['1']?.tone, 'warn')

    // Toggle off -> cancels ask and returns to normal
    const toggledOff = (await harness.host.invokeAction(PLAN_PLUGIN_ID, 'toggle', { conversationId: 1 })) as PlanSessionView
    assert.equal(toggledOff.mode, 'normal')
    assert.equal(toggledOff.awaitingApproval, false)
    assert.ok(harness.cancelledAsks.some((c) => c.askId === askId && c.reason === 'cancelled'))

    const proposeOutcome = await inFlight
    assert.equal((proposeOutcome.presentationMeta as { outcome?: string }).outcome, 'cancelled')
    assert.equal((await harness.host.invokeAction(PLAN_PLUGIN_ID, 'get', { conversationId: 1 }) as PlanSessionView).mode, 'normal')

    // Verify set_mode('normal') ignores 404/409 from cancelAsk
    await harness.host.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: 1, mode: 'planning' })
    const savedRecord = harness.kvStore.getParsed<PlanConversationRecord>(PLAN_PLUGIN_ID, PLAN_KV_NAMESPACE, '1')!
    harness.kvStore.setParsed(PLAN_PLUGIN_ID, PLAN_KV_NAMESPACE, '1', {
      ...savedRecord,
      pendingAskId: 'already-gone-ask',
    })
    const settledNormal = (await harness.host.invokeAction(PLAN_PLUGIN_ID, 'set_mode', {
      conversationId: 1,
      mode: 'normal',
    })) as PlanSessionView
    assert.equal(settledNormal.mode, 'normal')
    assert.equal(settledNormal.awaitingApproval, false)
  } finally {
    await harness.close()
  }
})

// ---------------------------------------------------------------------------
// 4. onInput & onBeforeTurn hooks
// ---------------------------------------------------------------------------

test('hooks: onInput handles bare /plan and transforms /plan <task>, while ignoring non-human/non-eligible inputs', TIMEOUT, async () => {
  const harness = await openPlanHarness({
    seedConversations: [
      makeConversationSummary({ id: 1 }),
      makeConversationSummary({ id: 2, parentConversationId: 1 }),
      makeConversationSummary({ id: 3, ownedBy: 'helmx' }),
    ],
  })
  try {
    // Non-human origin -> pass through unchanged
    const agentPayload = {
      conversationId: 1,
      input: { id: 'i1', text: '/plan do work', origin: 'agent' as const, createdAt: 1 },
    }
    const agentInput = await harness.host.runHook('input', agentPayload)
    assert.equal(agentInput.action, 'transform')
    if (agentInput.action === 'transform') assert.deepEqual(agentInput.value, agentPayload)

    // Non-matching /planner -> pass through unchanged
    const otherPayload = {
      conversationId: 1,
      input: { id: 'i2', text: '/planner do work', origin: 'human' as const, createdAt: 2 },
    }
    const otherSlash = await harness.host.runHook('input', otherPayload)
    assert.equal(otherSlash.action, 'transform')
    if (otherSlash.action === 'transform') assert.deepEqual(otherSlash.value, otherPayload)

    // Child / helmx conversations -> pass through unchanged
    const childPayload = {
      conversationId: 2,
      input: { id: 'i3', text: '/plan', origin: 'human' as const, createdAt: 3 },
    }
    const childSlash = await harness.host.runHook('input', childPayload)
    assert.equal(childSlash.action, 'transform')
    if (childSlash.action === 'transform') assert.deepEqual(childSlash.value, childPayload)
    const helmxPayload = {
      conversationId: 3,
      input: { id: 'i4', text: '/plan task', origin: 'human' as const, createdAt: 4 },
    }
    const helmxSlash = await harness.host.runHook('input', helmxPayload)
    assert.equal(helmxSlash.action, 'transform')
    if (helmxSlash.action === 'transform') assert.deepEqual(helmxSlash.value, helmxPayload)

    // Bare /plan -> handled + mode becomes planning
    const flushesBefore = harness.kvStore.flushCount
    const bareRes = await harness.host.runHook('input', {
      conversationId: 1,
      input: { id: 'i5', text: '  /plan  ', origin: 'human', createdAt: 5 },
    })
    assert.equal(bareRes.action, 'handled')
    assert.ok(harness.kvStore.flushCount > flushesBefore)
    assert.equal(harness.readSessionDoc(1).mode, 'planning')
    assert.equal(harness.readBadgesDoc().byConversation['1']?.tone, 'accent')

    // Exit back to normal, then `/plan <multiline task>` -> transform
    await harness.host.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: 1, mode: 'normal' })
    const withTaskRes = await harness.host.runHook('input', {
      conversationId: 1,
      input: {
        id: 'i6',
        text: '/plan   inspect auth\nand write plan  ',
        origin: 'human',
        whenBusy: 'steer',
        createdAt: 6,
      },
    })
    assert.equal(withTaskRes.action, 'transform')
    if (withTaskRes.action === 'transform') {
      assert.equal(withTaskRes.value.input.text, 'inspect auth\nand write plan')
      assert.equal(withTaskRes.value.input.whenBusy, 'steer')
    }
    assert.equal(harness.readSessionDoc(1).mode, 'planning')

    // Non-slash human input while a plan approval ask is pending supersedes it without leaving planning mode
    await harness.host.executeTool(
      PLAN_TOOL_SAVE,
      { title: 'Pending Supersede', markdown: '# Steps\n1. Check' },
      { conversationId: 1 },
    )
    const pPending = harness.host.executeTool(
      PLAN_TOOL_PROPOSE,
      { summary: 'Pending before composer steer' },
      { conversationId: 1 },
    ) as Promise<PluginToolResultEnvelope>
    await waitFor(() => harness.createdAsks.length === 1)
    const pendingId = harness.createdAsks[0]!.id!

    // Agent-origin input does NOT supersede the human approval ask
    await harness.host.runHook('input', {
      conversationId: 1,
      input: { id: 'i7-agent', text: 'background note', origin: 'agent', createdAt: 7 },
    })
    assert.equal(harness.cancelledAsks.length, 0)
    assert.equal(harness.readSessionDoc(1).awaitingApproval, true)

    // Human-origin non-slash input supersedes the pending approval ask cleanly
    const steerOutcome = await harness.host.runHook('input', {
      conversationId: 1,
      input: { id: 'i8-human', text: 'actually add rate limiting', origin: 'human', createdAt: 8 },
    })
    assert.equal(steerOutcome.action, 'transform')
    assert.ok(harness.cancelledAsks.some((c) => c.askId === pendingId && c.reason === 'superseded'))
    const pendingRes = await pPending
    assert.equal((pendingRes.presentationMeta as { outcome?: string }).outcome, 'superseded')
    assert.equal(harness.readSessionDoc(1).mode, 'planning')
    assert.equal(harness.readSessionDoc(1).awaitingApproval, false)
  } finally {
    await harness.close()
  }
})

test('hooks: onInput recognizes input.meta["builtin:plan"] planning intent on eligible human conversations and ignores ineligible targets', TIMEOUT, async () => {
  assert.equal(hasPlanModeInputMeta({ [PLAN_INPUT_META_KEY]: { mode: 'planning' } }), true)
  assert.equal(hasPlanModeInputMeta({ [PLAN_INPUT_META_KEY]: { mode: 'normal' } }), false)
  assert.equal(hasPlanModeInputMeta(undefined), false)
  assert.equal(hasPlanModeInputMeta({ [PLAN_INPUT_META_KEY]: null }), false)
  assert.equal(hasPlanModeInputMeta(JSON.parse('{"__proto__":{"mode":"planning"}}') as Record<string, unknown>), false)

  const harness = await openPlanHarness({
    seedConversations: [
      makeConversationSummary({ id: 1 }),
      makeConversationSummary({ id: 2, parentConversationId: 1 }),
      makeConversationSummary({ id: 3, ownedBy: 'helmx' }),
    ],
  })
  try {
    // Subagent and helmx-owned conversations ignore input.meta planning activation
    const subOutcome = await harness.host.runHook('input', {
      conversationId: 2,
      input: {
        id: 'meta-sub',
        text: 'subagent task',
        origin: 'human',
        createdAt: 1,
        meta: { [PLAN_INPUT_META_KEY]: { mode: 'planning' } },
      },
    })
    assert.equal(subOutcome.action, 'transform')
    assert.deepEqual(harness.readSessionDoc(2), { mode: 'normal', awaitingApproval: false })

    const helmxOutcome = await harness.host.runHook('input', {
      conversationId: 3,
      input: {
        id: 'meta-helmx',
        text: 'auto task',
        origin: 'human',
        createdAt: 2,
        meta: { [PLAN_INPUT_META_KEY]: { mode: 'planning' } },
      },
    })
    assert.equal(helmxOutcome.action, 'transform')
    assert.deepEqual(harness.readSessionDoc(3), { mode: 'normal', awaitingApproval: false })

    // Eligible top-level human conversation enters planning while keeping original text untouched
    const humanOutcome = await harness.host.runHook('input', {
      conversationId: 1,
      input: {
        id: 'meta-human',
        text: 'Audit auth\nand draft plan',
        origin: 'human',
        createdAt: 3,
        meta: { [PLAN_INPUT_META_KEY]: { mode: 'planning' } },
      },
    })
    assert.equal(humanOutcome.action, 'transform')
    if (humanOutcome.action === 'transform') {
      assert.equal(humanOutcome.value.input.text, 'Audit auth\nand draft plan')
    }
    assert.equal(harness.readSessionDoc(1).mode, 'planning')
    assert.equal(harness.readSessionDoc(1).awaitingApproval, false)
  } finally {
    await harness.close()
  }
})

test('hooks: onBeforeTurn strips plan tools in normal/ineligible mode and enforces strict tool whitelist + plan.mode section in planning mode', TIMEOUT, async () => {
  const harness = await openPlanHarness({
    seedConversations: [
      makeConversationSummary({ id: 1 }),
      makeConversationSummary({ id: 2, parentConversationId: 1 }),
    ],
  })
  try {
    const allTools = [
      makeToolSpec('read'),
      makeToolSpec('read_artifact'),
      makeToolSpec('bash'),
      makeToolSpec('load_skill'),
      makeToolSpec('write'),
      makeToolSpec('edit'),
      makeToolSpec('register_artifact'),
      makeToolSpec('run_action'),
      makeToolSpec('subagent'),
      makeToolSpec('SubagentWorkflow'),
      makeToolSpec('cleanup_worktree'),
      makeToolSpec('update_memory'),
      makeToolSpec('swarm_dispatch_worker'),
      makeToolSpec(PLAN_TOOL_BASH),
      makeToolSpec(PLAN_TOOL_ASK),
      makeToolSpec(PLAN_TOOL_SAVE),
      makeToolSpec(PLAN_TOOL_PROPOSE),
    ]

    const basePayload = (conv: ConversationSummary): BeforeTurnHookPayload => ({
      conversation: conv,
      inputs: [],
      tools: [...allTools],
      sections: [{ id: 'profile.system', text: 'base system' }],
      messages: [{ role: 'system', content: 'sys' }],
    })

    // Normal mode: strips plan-only tools (plan_bash, plan_ask, plan_save, plan_propose), injects NO sections
    const normalOutcome = await harness.host.runHook('before_turn', basePayload(harness.conversations.get(1)!))
    assert.equal(normalOutcome.action, 'transform')
    if (normalOutcome.action === 'transform') {
      const names = normalOutcome.value.tools.map((t) => t.name)
      assert.equal(names.includes(PLAN_TOOL_BASH), false)
      assert.equal(names.includes(PLAN_TOOL_ASK), false)
      assert.equal(names.includes(PLAN_TOOL_SAVE), false)
      assert.equal(names.includes(PLAN_TOOL_PROPOSE), false)
      assert.equal(names.includes('bash'), true)
      assert.equal(names.includes('write'), true)
      assert.equal(names.includes('edit'), true)
      assert.equal(normalOutcome.value.sections.some((s) => s.id === PLAN_MODE_SECTION_ID), false)
    }

    // Normal mode with no plan tools -> pass-through with no sections added
    const noopPayload = {
      ...basePayload(harness.conversations.get(1)!),
      tools: [makeToolSpec('read'), makeToolSpec('write')],
    }
    const noopNormal = await harness.host.runHook('before_turn', noopPayload)
    assert.equal(noopNormal.action, 'transform')
    if (noopNormal.action === 'transform') {
      assert.deepEqual(
        noopNormal.value.tools.map((t) => t.name),
        ['read', 'write'],
      )
      assert.deepEqual(noopNormal.value.sections, noopPayload.sections)
    }

    // Child conversation -> strips plan tools and injects NO sections
    const childOutcome = await harness.host.runHook('before_turn', basePayload(harness.conversations.get(2)!))
    assert.equal(childOutcome.action, 'transform')
    if (childOutcome.action === 'transform') {
      assert.equal(childOutcome.value.tools.some((t) => t.name === PLAN_TOOL_BASH), false)
      assert.equal(childOutcome.value.tools.some((t) => t.name === PLAN_TOOL_ASK), false)
      assert.equal(childOutcome.value.tools.some((t) => t.name === PLAN_TOOL_SAVE), false)
      assert.equal(childOutcome.value.tools.some((t) => t.name === PLAN_TOOL_PROPOSE), false)
      assert.equal(childOutcome.value.sections.some((s) => s.id === PLAN_MODE_SECTION_ID), false)
    }

    // Planning mode -> strict whitelist only + plan.mode section (note raw bash is stripped in favor of plan_bash)
    await harness.host.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: 1, mode: 'planning' })
    const planningOutcome = await harness.host.runHook('before_turn', basePayload(harness.conversations.get(1)!))
    assert.equal(planningOutcome.action, 'transform')
    if (planningOutcome.action === 'transform') {
      const names = planningOutcome.value.tools.map((t) => t.name)
      assert.deepEqual(names, ['read', 'read_artifact', 'load_skill', PLAN_TOOL_BASH, PLAN_TOOL_ASK, PLAN_TOOL_SAVE, PLAN_TOOL_PROPOSE])
      assert.equal(names.includes('bash'), false)
      assert.ok(names.every((n) => PLAN_MODE_TOOL_WHITELIST.has(n)))
      const section = planningOutcome.value.sections.find((s) => s.id === PLAN_MODE_SECTION_ID)
      assert.ok(section !== undefined)
      assert.match(section.text, /read-only/i)
      assert.match(section.text, /plan_bash/)
      assert.match(section.text, /plan_ask/)
      assert.match(section.text, /plan_save/)
      assert.match(section.text, /plan_propose/)
      assert.match(section.text, /self-contained/i)
    }
  } finally {
    await harness.close()
  }
})

// ---------------------------------------------------------------------------
// 5. plan_save validation, redaction, versioning, projections
// ---------------------------------------------------------------------------

test('plan_save: enforces planning mode, bounds, redaction, version bump, flush, and presentationMeta', TIMEOUT, async () => {
  const harness = await openPlanHarness({
    seedConversations: [
      makeConversationSummary({ id: 1 }),
      makeConversationSummary({ id: 2, parentConversationId: 1 }),
    ],
  })
  try {
    // Reject in normal mode
    const inNormal = (await harness.host.executeTool(
      PLAN_TOOL_SAVE,
      { title: 'Plan', markdown: '# Body' },
      { conversationId: 1 },
    )) as PluginToolResultEnvelope
    assert.equal(inNormal.isError, true)

    // Reject on child conversation
    const inChild = (await harness.host.executeTool(
      PLAN_TOOL_SAVE,
      { title: 'Plan', markdown: '# Body' },
      { conversationId: 2 },
    )) as PluginToolResultEnvelope
    assert.equal(inChild.isError, true)

    await harness.host.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: 1, mode: 'planning' })

    // Invalid title / markdown bounds
    const emptyTitle = (await harness.host.executeTool(
      PLAN_TOOL_SAVE,
      { title: '   ', markdown: '# Body' },
      { conversationId: 1 },
    )) as PluginToolResultEnvelope
    assert.equal(emptyTitle.isError, true)

    await assertRejectsCode(
      () =>
        harness.host.executeTool(
          PLAN_TOOL_SAVE,
          { title: 'x'.repeat(PLAN_TITLE_MAX_CHARS + 1), markdown: '# Body' },
          { conversationId: 1 },
        ),
      'validation_error',
    )

    const oversizedMd = (await harness.host.executeTool(
      PLAN_TOOL_SAVE,
      { title: 'Valid', markdown: 'a'.repeat(PLAN_MARKDOWN_MAX_BYTES + 1) },
      { conversationId: 1 },
    )) as PluginToolResultEnvelope
    assert.equal(oversizedMd.isError, true)

    // Valid save v1 with secret redaction
    const v1 = (await harness.host.executeTool(
      PLAN_TOOL_SAVE,
      { title: 'Auth SECRET_TOKEN', markdown: '# Step 1\nUse SECRET_TOKEN safely\n# Step 2' },
      { conversationId: 1 },
    )) as PluginToolResultEnvelope
    assert.equal(v1.isError, undefined)
    assert.deepEqual(v1.presentationMeta, {
      kind: 'save',
      title: 'Auth [REDACTED]',
      version: 1,
      lineCount: 3,
      charCount: '# Step 1\nUse [REDACTED] safely\n# Step 2'.length,
    })
    const formattedV1 = pluginToolResult(v1, (t) => t, { presentationMetaSchema: PLAN_TOOL_META_SCHEMA })
    assert.deepEqual(formattedV1.details, v1.presentationMeta)

    // Check KV & sessionDoc & badges
    const sessionV1 = harness.readSessionDoc(1)
    assert.equal(sessionV1.mode, 'planning')
    assert.equal(sessionV1.draft?.version, 1)
    assert.equal(sessionV1.draft?.title, 'Auth [REDACTED]')
    assert.equal(sessionV1.draft?.markdown.includes('SECRET_TOKEN'), false)

    // Save v2 bumps version
    const v2 = (await harness.host.executeTool(
      PLAN_TOOL_SAVE,
      { title: 'Auth Plan v2', markdown: 'Line 1\nLine 2' },
      { conversationId: 1 },
    )) as PluginToolResultEnvelope
    assert.equal((v2.presentationMeta as { version?: number }).version, 2)
    assert.equal(harness.readSessionDoc(1).draft?.version, 2)
  } finally {
    await harness.close()
  }
})

// ---------------------------------------------------------------------------
// 6. plan_propose flows (validation, abort, outcomes, handoff, model switch)
// ---------------------------------------------------------------------------

test('plan_propose: validates summary, prevents code fences/duplicates, handles AbortSignal, superseded, cancelled, and revise', TIMEOUT, async () => {
  const harness = await openPlanHarness({
    seedConversations: [makeConversationSummary({ id: 1, stateChangeSeq: 11 })],
  })
  try {
    await harness.host.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: 1, mode: 'planning' })
    await harness.host.executeTool(
      PLAN_TOOL_SAVE,
      { title: 'Refactor Auth', markdown: '# Plan\n1. Inspect\n2. Implement' },
      { conversationId: 1 },
    )

    // Reject code fences and >300 char summary
    const fenced = (await harness.host.executeTool(
      PLAN_TOOL_PROPOSE,
      { summary: 'Summary ```ts\nconst x = 1\n```' },
      { conversationId: 1 },
    )) as PluginToolResultEnvelope
    assert.equal(fenced.isError, true)
    assert.equal(harness.createdAsks.length, 0)

    await assertRejectsCode(
      () =>
        harness.host.executeTool(
          PLAN_TOOL_PROPOSE,
          { summary: 'a'.repeat(PLAN_SUMMARY_MAX_CHARS + 1) },
          { conversationId: 1 },
        ),
      'validation_error',
    )

    // 1) Revise outcome -> stays planning, clears pendingAskId, choice + model + hint fields present
    const pRevise = harness.host.executeTool(
      PLAN_TOOL_PROPOSE,
      { summary: 'Auth plan with SECRET_TOKEN redacted' },
      { conversationId: 1 },
    ) as Promise<PluginToolResultEnvelope>
    await waitFor(() => harness.createdAsks.length === 1)
    const ask1 = harness.createdAsks[0]!
    assert.equal(ask1.expectedStateSeq, 11)
    assert.deepEqual(ask1.title, {
      en: 'Plan Approval v1: Refactor Auth',
      'zh-CN': '计划审批 v1：Refactor Auth',
    })
    assert.equal(ask1.description, 'Auth plan with [REDACTED] redacted')
    assert.equal(typeof ask1.description === 'string' && ask1.description.includes('```'), false)
    const assertBilingual = (value: unknown, contextLabel: string): void => {
      assert.ok(parseNonEmptyLocalizedText(value) !== undefined, `${contextLabel} must be valid LocalizedText`)
      assert.equal(typeof value, 'object', `${contextLabel} must be localized map`)
      const map = value as Record<string, unknown>
      assert.equal(typeof map['en'], 'string', `${contextLabel}.en missing`)
      assert.equal(typeof map['zh-CN'], 'string', `${contextLabel}['zh-CN'] missing`)
    }
    assertBilingual(ask1.title, 'ask1.title')
    assertBilingual(ask1.hint, 'ask1.hint')
    const decisionField1 = ask1.fields.find((f) => f.name === 'decision')
    assert.ok(decisionField1 && decisionField1.type === 'choice')
    assert.equal(decisionField1.defaultValue, 'approve_handoff')
    assert.deepEqual(
      decisionField1.options?.map((o) => o.value),
      ['approve_handoff', 'approve', 'revise'],
    )
    assertBilingual(decisionField1.label, 'decision.label')
    for (const opt of decisionField1.options ?? []) {
      assertBilingual(opt.label, `decision.option.${opt.value}`)
      if (opt.description !== undefined) {
        assertBilingual(opt.description, `decision.option.${opt.value}.description`)
      }
    }
    const modelField1 = ask1.fields.find((f) => f.name === 'executionModel')
    assert.ok(modelField1 && modelField1.type === 'model')
    assert.equal(modelField1.defaultValue, '')
    assertBilingual(modelField1.label, 'executionModel.label')
    const feedbackField1 = ask1.fields.find((f) => f.name === 'feedback')
    assert.ok(feedbackField1)
    assertBilingual(feedbackField1.label, 'feedback.label')

    // Duplicate propose while ask1 is pending must reject
    const duplicate = (await harness.host.executeTool(
      PLAN_TOOL_PROPOSE,
      { summary: 'Second concurrent ask' },
      { conversationId: 1 },
    )) as PluginToolResultEnvelope
    assert.equal(duplicate.isError, true)
    assert.equal((duplicate.presentationMeta as { outcome?: string }).outcome, 'error')

    // liveTasks() tracks active ask and blocks non-force and force disable with 409 plugin_has_live_tasks
    await assertRejectsCode(() => harness.host.disable(PLAN_PLUGIN_ID), 'plugin_has_live_tasks')
    await assertRejectsCode(() => harness.host.disable(PLAN_PLUGIN_ID, { force: true }), 'plugin_has_live_tasks')

    harness.answerAsk(ask1.id!, { decision: 'revise', feedback: 'Add rollback SECRET_TOKEN plan' })
    const resRevise = await pRevise
    assert.equal(resRevise.isError, undefined)
    assert.match(String(resRevise.output), /\[REDACTED\]/)
    assert.deepEqual(resRevise.presentationMeta, {
      kind: 'propose',
      title: 'Refactor Auth',
      version: 1,
      outcome: 'revised',
    })
    assert.equal(harness.readSessionDoc(1).mode, 'planning')
    assert.equal(harness.readSessionDoc(1).awaitingApproval, false)

    // 2) Superseded outcome -> stays planning
    const pSuper = harness.host.executeTool(
      PLAN_TOOL_PROPOSE,
      { summary: 'Second proposal' },
      { conversationId: 1 },
    ) as Promise<PluginToolResultEnvelope>
    await waitFor(() => harness.createdAsks.length === 2)
    harness.cancelAsk(harness.createdAsks[1]!.id!, 'superseded')
    const resSuper = await pSuper
    assert.equal((resSuper.presentationMeta as { outcome?: string }).outcome, 'superseded')
    assert.equal(harness.readSessionDoc(1).mode, 'planning')

    // 3) AbortSignal cancels AskDoc via ctx.host.cancelAsk(askId, 'cancelled')
    const ac = new AbortController()
    const pAbort = harness.host.executeTool(
      PLAN_TOOL_PROPOSE,
      { summary: 'Abortable proposal' },
      { conversationId: 1, signal: ac.signal },
    ) as Promise<PluginToolResultEnvelope>
    await waitFor(() => harness.createdAsks.length === 3)
    const ask3Id = harness.createdAsks[2]!.id!
    ac.abort()
    const resAbort = await pAbort
    assert.ok(harness.cancelledAsks.some((c) => c.askId === ask3Id && c.reason === 'cancelled'))
    assert.equal((resAbort.presentationMeta as { outcome?: string }).outcome, 'cancelled')
    assert.equal(harness.readSessionDoc(1).mode, 'planning')
    assert.equal(harness.readSessionDoc(1).awaitingApproval, false)
  } finally {
    await harness.close()
  }
})

test('plan_propose: approve and approve_handoff with executionModel selection (success & error stay planning)', TIMEOUT, async () => {
  const harness = await openPlanHarness({
    initialConfig: { executionModel: 'tier/strong' },
    seedConversations: [makeConversationSummary({ id: 1, model: 'faux/fast', stateChangeSeq: 7 })],
  })
  try {
    await harness.host.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: 1, mode: 'planning' })
    await harness.host.executeTool(
      PLAN_TOOL_SAVE,
      { title: 'Feature X', markdown: '# Plan\nImplement Feature X with SECRET_TOKEN' },
      { conversationId: 1 },
    )

    // 1) approve_handoff + executionModel failure (409 model_disabled) -> stays planning, creates NO artifact
    harness.setUpdateConversationHandler(async () => {
      throw new HelmxError('model_disabled', 'Model tier/strong target is disabled', 409)
    })
    const pModelFail = harness.host.executeTool(
      PLAN_TOOL_PROPOSE,
      { summary: 'Try model handoff' },
      { conversationId: 1 },
    ) as Promise<PluginToolResultEnvelope>
    await waitFor(() => harness.createdAsks.length === 1)
    const askFail = harness.createdAsks[0]!
    const modelField = askFail.fields.find((f) => f.name === 'executionModel')
    assert.equal(modelField?.type, 'model')
    assert.equal(modelField?.defaultValue, 'tier/strong')

    harness.answerAsk(askFail.id!, {
      decision: 'approve_handoff',
      executionModel: 'tier/strong',
      feedback: 'go fast',
    })
    const resModelFail = await pModelFail
    assert.equal(resModelFail.isError, true)
    assert.match(String(resModelFail.output), /model_disabled|disabled/i)
    assert.equal(resModelFail.control, undefined)
    assert.equal(harness.createdArtifacts.length, 0)
    assert.equal(harness.readSessionDoc(1).mode, 'planning')
    assert.equal(harness.readSessionDoc(1).awaitingApproval, false)
    assert.deepEqual(resModelFail.presentationMeta, {
      kind: 'propose',
      title: 'Feature X',
      version: 1,
      outcome: 'error',
      executionModel: 'tier/strong',
    })

    // 2) approve_handoff + executionModel success -> updateConversation FIRST, then artifact, then normal + flush + control.handoff
    harness.setUpdateConversationHandler(undefined)
    const callOrder: string[] = []
    const origUpdate = harness.conversations.get(1)!
    assert.ok(origUpdate)
    harness.setUpdateConversationHandler(async (id, patch) => {
      callOrder.push('updateConversation')
      const updated = { ...harness.conversations.get(id)!, model: patch.model ?? 'faux/strong' }
      harness.conversations.set(id, updated)
      return updated
    })
    harness.setCreateArtifactHandler(async (conversationId, input) => {
      callOrder.push('createArtifact')
      const artifact: ArtifactMetadata = {
        id: 'art-handoff-1',
        conversationId,
        kind: 'upload',
        name: input.name,
        mimeType: input.mimeType ?? 'text/markdown',
        size: input.bytes.byteLength,
        path: `uploads/art-handoff-1-${input.name}`,
        createdAt: Date.now(),
      }
      harness.createdArtifacts.push({
        conversationId,
        name: input.name,
        text: new TextDecoder().decode(input.bytes),
        artifact,
      })
      return artifact
    })

    const pModelOk = harness.host.executeTool(
      PLAN_TOOL_PROPOSE,
      { summary: 'Handoff to tier/strong' },
      { conversationId: 1 },
    ) as Promise<PluginToolResultEnvelope>
    await waitFor(() => harness.createdAsks.length === 2)
    const askWithModel = harness.createdAsks[1]!
    harness.answerAsk(askWithModel.id!, {
      decision: 'approve_handoff',
      executionModel: 'tier/strong',
      feedback: 'Include tests for SECRET_TOKEN',
    })
    const resModelOk = await pModelOk
    assert.equal(resModelOk.isError, undefined)
    assert.deepEqual(callOrder, ['updateConversation', 'createArtifact'])
    assert.equal(harness.conversations.get(1)?.model, 'tier/strong')
    assert.equal(harness.createdArtifacts[0]?.name, 'plan-v1.md')
    assert.equal(resModelOk.presentationMeta?.['outcome'], 'approved_handoff')
    assert.equal(resModelOk.presentationMeta?.['artifactId'], 'art-handoff-1')
    assert.equal(resModelOk.presentationMeta?.['executionModel'], 'tier/strong')
    assert.ok(typeof resModelOk.control?.handoff === 'string')
    assert.match(resModelOk.control!.handoff!, /art-handoff-1/)
    assert.match(resModelOk.control!.handoff!, /Implement Feature X with \[REDACTED\]/)
    assert.match(resModelOk.control!.handoff!, /Include tests for \[REDACTED\]/)
    assert.ok(Buffer.byteLength(resModelOk.control!.handoff!, 'utf8') <= PLAN_HANDOFF_MAX_BYTES)
    assert.equal(harness.readSessionDoc(1).mode, 'normal')
    assert.equal(harness.readSessionDoc(1).approved?.handoffUsed, true)
    assert.equal(harness.readSessionDoc(1).approved?.executionModel, 'tier/strong')
    assert.equal(harness.readBadgesDoc().byConversation['1']?.tone, 'neutral')

    // 3) Plain `approve` (without model switch and with model override) + `approve_handoff` (no model switch) <= 128 KiB
    harness.setUpdateConversationHandler(undefined)
    harness.setCreateArtifactHandler(undefined)
    await harness.host.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: 1, mode: 'planning' })
    await harness.host.executeTool(
      PLAN_TOOL_SAVE,
      { title: 'Feature Y', markdown: 'a'.repeat(PLAN_MARKDOWN_MAX_BYTES) },
      { conversationId: 1 },
    )
    const pPlainApprove = harness.host.executeTool(
      PLAN_TOOL_PROPOSE,
      { summary: 'Approve without handoff' },
      { conversationId: 1 },
    ) as Promise<PluginToolResultEnvelope>
    await waitFor(() => harness.createdAsks.length === 3)
    harness.answerAsk(harness.createdAsks[2]!.id!, { decision: 'approve', executionModel: '' })
    const resPlain = await pPlainApprove
    assert.equal(resPlain.control, undefined)
    assert.equal(resPlain.presentationMeta?.['outcome'], 'approved')
    assert.equal(resPlain.presentationMeta?.['artifactName'], 'plan-v2.md')
    assert.equal(resPlain.presentationMeta?.['executionModel'], undefined)
    assert.equal(harness.readSessionDoc(1).approved?.handoffUsed, false)

    // Plain `approve` WITH executionModel override switches conversation model in-place without handoff
    await harness.host.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: 1, mode: 'planning' })
    const pSameSessionWithModel = harness.host.executeTool(
      PLAN_TOOL_PROPOSE,
      { summary: 'Approve same session with model override' },
      { conversationId: 1 },
    ) as Promise<PluginToolResultEnvelope>
    await waitFor(() => harness.createdAsks.length === 4)
    harness.answerAsk(harness.createdAsks[3]!.id!, { decision: 'approve', executionModel: 'tier/balanced' })
    const resSameModel = await pSameSessionWithModel
    assert.equal(resSameModel.control, undefined)
    assert.equal(resSameModel.presentationMeta?.['outcome'], 'approved')
    assert.equal(resSameModel.presentationMeta?.['executionModel'], 'tier/balanced')
    assert.equal(harness.conversations.get(1)?.model, 'tier/balanced')
    assert.equal(harness.readSessionDoc(1).approved?.executionModel, 'tier/balanced')

    // approve_handoff with huge feedback still enforces <= 128 KiB handoff cap
    await harness.host.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: 1, mode: 'planning' })
    const pHugeHandoff = harness.host.executeTool(
      PLAN_TOOL_PROPOSE,
      { summary: 'Handoff with huge feedback' },
      { conversationId: 1 },
    ) as Promise<PluginToolResultEnvelope>
    await waitFor(() => harness.createdAsks.length === 5)
    harness.answerAsk(harness.createdAsks[4]!.id!, {
      decision: 'approve_handoff',
      feedback: 'f'.repeat(60_000),
    })
    const resHuge = await pHugeHandoff
    assert.ok(typeof resHuge.control?.handoff === 'string')
    assert.ok(Buffer.byteLength(resHuge.control!.handoff!, 'utf8') <= PLAN_HANDOFF_MAX_BYTES)
    assert.equal(resHuge.presentationMeta?.['outcome'], 'approved_handoff')
    assert.equal(resHuge.presentationMeta?.['executionModel'], undefined)
  } finally {
    await harness.close()
  }
})

// ---------------------------------------------------------------------------
// 7. Lifecycle: start hydration, reconcile, inUse, conversation.deleted, stop
// ---------------------------------------------------------------------------

test('lifecycle: start hydrates badges, reconcile supersedes orphaned asks, inUse guards disable, conversation.deleted cleans up, stop awaits waiters', TIMEOUT, async () => {
  // Pre-seed KV before host start to simulate hub restart with an orphaned pendingAskId and a normal approved record
  const preseededKv = new MemoryKvStore()
  preseededKv.setParsed<PlanConversationRecord>(PLAN_PLUGIN_ID, PLAN_KV_NAMESPACE, '1', {
    conversationId: 1,
    mode: 'planning',
    pendingAskId: 'orphan-ask-1',
    draft: { title: 'Restart Plan', markdown: '# Steps', version: 1, updatedAt: 100 },
  })
  preseededKv.setParsed<PlanConversationRecord>(PLAN_PLUGIN_ID, PLAN_KV_NAMESPACE, '2', {
    conversationId: 2,
    mode: 'normal',
    approved: {
      title: 'Old Plan',
      version: 1,
      artifactId: 'art-old',
      artifactName: 'plan-v1.md',
      approvedAt: 90,
      handoffUsed: false,
    },
  })

  const harness = await openPlanHarness({
    deferServices: true,
    kvStore: preseededKv,
    seedConversations: [makeConversationSummary({ id: 1 }), makeConversationSummary({ id: 2 })],
  })
  try {
    // Allow cancelAsk to resolve cleanly even for pre-seeded orphan (or test 404 ignorance as well)
    harness.pendingAsks.set('orphan-ask-1', {
      id: 'orphan-ask-1',
      status: 'pending',
      spec: { id: 'orphan-ask-1', conversationId: 1, title: 'Orphan', fields: [{ name: 'decision', label: 'Decision', type: 'select', options: [{ label: 'Ok', value: 'approve' }] }] },
      waiter: deferred<AskResult>(),
    })

    await harness.host.start()

    // Start hydrated plan-badges & sessionDoc from KV
    assert.equal(harness.readBadgesDoc().byConversation['1']?.tone, 'warn')
    assert.equal(harness.readBadgesDoc().byConversation['2']?.tone, 'neutral')
    assert.equal(harness.readSessionDoc(1).awaitingApproval, true)

    // Reconcile supersedes orphaned pendingAskId and clears awaitingApproval
    await harness.host.reconcile()
    assert.ok(harness.cancelledAsks.some((c) => c.askId === 'orphan-ask-1' && c.reason === 'superseded'))
    assert.equal(harness.readSessionDoc(1).awaitingApproval, false)
    assert.equal(harness.readSessionDoc(1).mode, 'planning')
    assert.equal(harness.readBadgesDoc().byConversation['1']?.tone, 'accent')
    assert.equal(
      preseededKv.getParsed<PlanConversationRecord>(PLAN_PLUGIN_ID, PLAN_KV_NAMESPACE, '1')?.pendingAskId,
      undefined,
    )

    // inUse blocks non-force disable while conv 1 is in planning mode, force: true succeeds
    await assertRejectsCode(() => harness.host.disable(PLAN_PLUGIN_ID), 'plugin_in_use')
    await harness.host.enable(PLAN_PLUGIN_ID).catch(() => {}) // still enabled
    assert.equal(harness.host.list().find((p) => p.id === PLAN_PLUGIN_ID)?.enabled, true)

    // Start a live plan_propose, then delete conversation -> cancels ask, deletes KV, removes badge
    const pLive = harness.host.executeTool(
      PLAN_TOOL_PROPOSE,
      { summary: 'Delete while awaiting' },
      { conversationId: 1 },
    ) as Promise<PluginToolResultEnvelope>
    await waitFor(() => harness.createdAsks.length === 1)
    const liveAskId = harness.createdAsks[0]!.id!

    harness.conversations.delete(1)
    await harness.dispatchEvent('conversation.deleted', { type: 'conversation.deleted', conversationId: 1 })
    await pLive

    assert.ok(harness.cancelledAsks.some((c) => c.askId === liveAskId && c.reason === 'cancelled'))
    assert.equal(preseededKv.getParsed(PLAN_PLUGIN_ID, PLAN_KV_NAMESPACE, '1'), undefined)
    assert.equal(harness.readBadgesDoc().byConversation['1'], undefined)

    // Start another live plan_propose on conv 2, then call host.stop() -> cancels & awaits cleanly
    await harness.host.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: 2, mode: 'planning' })
    await harness.host.executeTool(
      PLAN_TOOL_SAVE,
      { title: 'Stop Plan', markdown: '# Stop test' },
      { conversationId: 2 },
    )
    const pStop = harness.host.executeTool(
      PLAN_TOOL_PROPOSE,
      { summary: 'Stop while awaiting' },
      { conversationId: 2 },
    ) as Promise<PluginToolResultEnvelope>
    await waitFor(() => harness.createdAsks.length === 2)
    const stopAskId = harness.createdAsks[1]!.id!

    await harness.host.stop()
    const stopRes = await pStop
    assert.ok(harness.cancelledAsks.some((c) => c.askId === stopAskId && c.reason === 'cancelled'))
    assert.equal((stopRes.presentationMeta as { outcome?: string }).outcome, 'cancelled')
    assert.equal(
      preseededKv.getParsed<PlanConversationRecord>(PLAN_PLUGIN_ID, PLAN_KV_NAMESPACE, '2')?.pendingAskId,
      undefined,
    )
  } finally {
    await harness.close()
  }
})

test('lifecycle: reconcile ignores 404/409 cancelAsk errors and force disable clears active planning inUse gate', TIMEOUT, async () => {
  const preseededKv = new MemoryKvStore()
  preseededKv.setParsed<PlanConversationRecord>(PLAN_PLUGIN_ID, PLAN_KV_NAMESPACE, '1', {
    conversationId: 1,
    mode: 'planning',
    pendingAskId: 'missing-ask-404',
    draft: { title: 'Orphan', markdown: '# Steps', version: 1, updatedAt: 100 },
  })
  const harness = await openPlanHarness({
    deferServices: true,
    kvStore: preseededKv,
    seedConversations: [makeConversationSummary({ id: 1 })],
  })
  try {
    await harness.host.start()
    // cancelAsk throws 404 not_found for 'missing-ask-404' -> reconcile must ignore and clear pendingAskId
    await harness.host.reconcile()
    assert.equal(
      preseededKv.getParsed<PlanConversationRecord>(PLAN_PLUGIN_ID, PLAN_KV_NAMESPACE, '1')?.pendingAskId,
      undefined,
    )
    assert.equal(harness.readSessionDoc(1).awaitingApproval, false)

    // inUse blocks non-force disable, while force: true succeeds and re-enable works cleanly
    await assertRejectsCode(() => harness.host.disable(PLAN_PLUGIN_ID), 'plugin_in_use')
    await harness.host.disable(PLAN_PLUGIN_ID, { force: true })
    assert.equal(harness.host.list().find((p) => p.id === PLAN_PLUGIN_ID)?.enabled, false)
    await harness.host.enable(PLAN_PLUGIN_ID)
    assert.equal(harness.host.list().find((p) => p.id === PLAN_PLUGIN_ID)?.enabled, true)
    assert.equal(harness.readSessionDoc(1).mode, 'planning')
  } finally {
    await harness.close()
  }
})

// ---------------------------------------------------------------------------
// 8. read-only-shell validator & plan_bash
// ---------------------------------------------------------------------------

test('validateReadOnlyShellCommand: quote-aware allowlist vs mutating / redirect / subshell guards', TIMEOUT, () => {
  const allowed = [
    'pwd',
    'ls -la',
    'rg "rm -rf" src/',
    "rg 'echo > file' packages/",
    'git log --grep="commit" -n 5',
    'git status && git diff --stat',
    'git branch -a --list',
    "sed -n '1,20p' packages/plugins/src/plan.ts",
    "find . -name '*.ts'",
    'cat README.md 2>&1',
    'echo ok >/dev/null',
  ]
  for (const cmd of allowed) {
    assert.equal(validateReadOnlyShellCommand(cmd).ok, true, `expected allowed: ${cmd}`)
  }

  const blocked = [
    '',
    '   ',
    'rm -rf ./tmp',
    'mv a b',
    'cp a b',
    'echo hacked > out.txt',
    'ls >> out.txt',
    "sed -i 's/a/b/g' file.ts",
    'git commit -m "msg"',
    'git checkout main',
    'git branch feat/new',
    'git tag v1.0.0',
    'find . -delete',
    'find . -exec rm {} +',
    'pnpm install',
    'curl -X POST https://example.com',
    '$(rm -rf x)',
    '`rm -rf x`',
    '(rm -rf x)',
  ]
  for (const cmd of blocked) {
    assert.equal(validateReadOnlyShellCommand(cmd).ok, false, `expected blocked: ${cmd}`)
  }
})

test('plan_bash: guards mode/scope, blocks mutating commands locally, executes allowed reads with redaction', TIMEOUT, async () => {
  const harness = await openPlanHarness({
    seedConversations: [
      makeConversationSummary({ id: 1, stateChangeSeq: 3 }),
      makeConversationSummary({ id: 2, parentConversationId: 1 }),
    ],
  })
  try {
    // Reject in normal mode & child conversation
    const inNormal = (await harness.host.executeTool(
      PLAN_TOOL_BASH,
      { command: 'pwd' },
      { conversationId: 1 },
    )) as PluginToolResultEnvelope
    assert.equal(inNormal.isError, true)

    const inChild = (await harness.host.executeTool(
      PLAN_TOOL_BASH,
      { command: 'pwd' },
      { conversationId: 2 },
    )) as PluginToolResultEnvelope
    assert.equal(inChild.isError, true)

    await harness.host.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: 1, mode: 'planning' })

    // Mutating / redirect commands blocked before hitting execEnv
    for (const badCmd of ['rm -rf /tmp/x', 'echo foo > bar.txt', 'git commit -m x']) {
      const blockedRes = (await harness.host.executeTool(
        PLAN_TOOL_BASH,
        { command: badCmd },
        { conversationId: 1 },
      )) as PluginToolResultEnvelope
      assert.equal(blockedRes.isError, true)
    }
    assert.equal(harness.execEnvCalls.length, 0)

    // Allowed command invokes execEnv with capped timeout and redacts secrets in output & structuredOutput
    harness.setExecEnvHandler(async () => ({
      ok: true,
      exitCode: 0,
      timedOut: false,
      output: 'found SECRET_TOKEN in config',
    }))
    const okRes = (await harness.host.executeTool(
      PLAN_TOOL_BASH,
      { command: 'rg "rm -rf" src/', timeoutMs: 5_000 },
      { conversationId: 1 },
    )) as PluginToolResultEnvelope
    assert.equal(okRes.isError, false)
    assert.equal(harness.execEnvCalls.length, 1)
    assert.deepEqual(harness.execEnvCalls[0], { command: 'rg "rm -rf" src/', conversationId: 1, timeoutMs: 5_000 })
    assert.equal(okRes.output, 'found [REDACTED] in config')
    assert.deepEqual(okRes.structuredOutput, {
      ok: true,
      exitCode: 0,
      timedOut: false,
      output: 'found [REDACTED] in config',
    })

    // Command failure propagates isError: true
    harness.setExecEnvHandler(async () => ({
      ok: false,
      exitCode: 2,
      timedOut: false,
      output: 'rg error',
    }))
    const failRes = (await harness.host.executeTool(
      PLAN_TOOL_BASH,
      { command: 'rg missing src/' },
      { conversationId: 1 },
    )) as PluginToolResultEnvelope
    assert.equal(failRes.isError, true)
  } finally {
    await harness.close()
  }
})

// ---------------------------------------------------------------------------
// 9. plan_ask: clarification questions, validation, awaitingClarification & badges
// ---------------------------------------------------------------------------

test('plan_ask: validates questions, projects awaitingClarification, and handles answered/superseded/cancelled', TIMEOUT, async () => {
  const harness = await openPlanHarness({
    seedConversations: [makeConversationSummary({ id: 1, stateChangeSeq: 9 })],
  })
  try {
    const outOfMode = (await harness.host.executeTool(
      PLAN_TOOL_ASK,
      {
        questions: [
          {
            id: 'auth',
            question: 'Auth method?',
            options: [
              { value: 'jwt', label: 'JWT' },
              { value: 'session', label: 'Session' },
            ],
          },
        ],
      },
      { conversationId: 1 },
    )) as PluginToolResultEnvelope
    assert.equal(outOfMode.isError, true)

    await harness.host.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: 1, mode: 'planning' })

    const reservedId = (await harness.host.executeTool(
      PLAN_TOOL_ASK,
      {
        questions: [
          {
            id: 'notes',
            question: 'Reserved?',
            options: [
              { value: 'a', label: 'A' },
              { value: 'b', label: 'B' },
            ],
          },
        ],
      },
      { conversationId: 1 },
    )) as PluginToolResultEnvelope
    assert.equal(reservedId.isError, true)

    const pAsk = harness.host.executeTool(
      PLAN_TOOL_ASK,
      {
        questions: [
          {
            id: 'auth',
            question: 'Auth SECRET_TOKEN storage?',
            options: [
              { value: 'cookie', label: 'HttpOnly cookie', description: 'Protected from XSS' },
              { value: 'header', label: 'Bearer header' },
            ],
          },
        ],
      },
      { conversationId: 1 },
    ) as Promise<PluginToolResultEnvelope>
    await waitFor(() => harness.createdAsks.length === 1)

    const askSpec = harness.createdAsks[0]!
    assert.equal(askSpec.expectedStateSeq, 9)
    assert.deepEqual(askSpec.title, { en: 'Clarifying Questions', 'zh-CN': '需求澄清' })
    assert.ok(askSpec.hint !== undefined && typeof askSpec.hint === 'object')
    assert.equal(askSpec.fields[0]?.type, 'choice')
    assert.equal(String(askSpec.fields[0]?.label).includes('SECRET_TOKEN'), false)
    assert.equal(askSpec.fields[1]?.name, 'notes')

    const sessionClarifying = harness.readSessionDoc(1)
    assert.equal(sessionClarifying.awaitingClarification, true)
    assert.equal(sessionClarifying.awaitingApproval, false)
    const clarifyBadge = harness.readBadgesDoc().byConversation['1']
    assert.equal(clarifyBadge?.tone, 'warn')
    assert.deepEqual(clarifyBadge?.footerText, { en: 'Awaiting clarification', 'zh-CN': '等待澄清回复' })

    harness.answerAsk(askSpec.id!, { auth: 'cookie', notes: 'Also rotate SECRET_TOKEN' })
    const resAnswered = await pAsk
    assert.equal(resAnswered.isError, undefined)
    assert.match(String(resAnswered.output), /cookie \(HttpOnly cookie\)/)
    assert.match(String(resAnswered.output), /\[REDACTED\]/)
    assert.deepEqual(resAnswered.presentationMeta, {
      kind: 'ask',
      title: 'Clarifying Questions',
      questionCount: 1,
      outcome: 'answered',
    })
    const formattedMeta = pluginToolResult(resAnswered, (t) => t, { presentationMetaSchema: PLAN_ASK_META_SCHEMA })
    assert.deepEqual(formattedMeta.details, resAnswered.presentationMeta)
    assert.equal(harness.readSessionDoc(1).awaitingClarification, undefined)

    // Superseded outcome
    const pSup = harness.host.executeTool(
      PLAN_TOOL_ASK,
      {
        title: 'API Version',
        questions: [
          {
            id: 'ver',
            question: 'Version?',
            options: [
              { value: 'v1', label: 'v1' },
              { value: 'v2', label: 'v2' },
            ],
          },
        ],
      },
      { conversationId: 1 },
    ) as Promise<PluginToolResultEnvelope>
    await waitFor(() => harness.createdAsks.length === 2)
    harness.cancelAsk(harness.createdAsks[1]!.id!, 'superseded')
    const resSup = await pSup
    assert.equal((resSup.presentationMeta as { outcome?: string }).outcome, 'superseded')
  } finally {
    await harness.close()
  }
})

// ---------------------------------------------------------------------------
// 10. update_draft action, CAS conflict, & pending approval draft refinement
// ---------------------------------------------------------------------------

test('update_draft: updates draft with redaction, enforces expectedVersion CAS 409, and reflects in pending plan_propose', TIMEOUT, async () => {
  const harness = await openPlanHarness({
    seedConversations: [
      makeConversationSummary({ id: 1, stateChangeSeq: 4 }),
      makeConversationSummary({ id: 2, ownedBy: 'helmx' }),
    ],
  })
  try {
    await assertRejectsCode(
      () =>
        harness.host.invokeAction(PLAN_PLUGIN_ID, 'update_draft', {
          conversationId: 2,
          title: 'X',
          markdown: '# Y',
        }),
      'plan_unsupported_conversation',
    )

    await harness.host.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: 1, mode: 'planning' })
    await harness.host.executeTool(
      PLAN_TOOL_SAVE,
      { title: 'Initial Title', markdown: '# v1 body' },
      { conversationId: 1 },
    )

    // Stale expectedVersion -> 409 plan_draft_conflict
    await assertRejectsCode(
      () =>
        harness.host.invokeAction(PLAN_PLUGIN_ID, 'update_draft', {
          conversationId: 1,
          title: 'Stale',
          markdown: '# Stale',
          expectedVersion: 0,
        }),
      'plan_draft_conflict',
    )

    // Start plan_propose pending on v1, then human edits draft -> v2 while ask is open
    const pPropose = harness.host.executeTool(
      PLAN_TOOL_PROPOSE,
      { summary: 'Ready for approval' },
      { conversationId: 1 },
    ) as Promise<PluginToolResultEnvelope>
    await waitFor(() => harness.createdAsks.length === 1)

    const updatedView = (await harness.host.invokeAction(PLAN_PLUGIN_ID, 'update_draft', {
      conversationId: 1,
      title: 'Edited SECRET_TOKEN Title',
      markdown: '# Human Edited v2\nCheck SECRET_TOKEN',
      expectedVersion: 1,
    })) as PlanSessionView
    assert.equal(updatedView.draft?.version, 2)
    assert.equal(updatedView.draft?.title, 'Edited [REDACTED] Title')
    assert.equal(updatedView.awaitingApproval, true)

    harness.answerAsk(harness.createdAsks[0]!.id!, { decision: 'approve' })
    const res = await pPropose
    assert.equal(res.isError, undefined)
    assert.equal(harness.createdArtifacts[0]?.name, 'plan-v2.md')
    assert.equal(harness.createdArtifacts[0]?.text, '# Human Edited v2\nCheck [REDACTED]')
    assert.equal(res.presentationMeta?.['version'], 2)
    assert.equal(res.presentationMeta?.['title'], 'Edited [REDACTED] Title')
  } finally {
    await harness.close()
  }
})

// ---------------------------------------------------------------------------
// 11. conversation.entry (pi.reset / helmx.rewind) & turn_settled cleanup
// ---------------------------------------------------------------------------

test('conversation.entry handles manual pi.reset, handoff pi.reset exemption, turn_settled cleanup, and helmx.rewind', TIMEOUT, async () => {
  const harness = await openPlanHarness({
    seedConversations: [makeConversationSummary({ id: 1, stateChangeSeq: 6 })],
  })
  try {
    await harness.host.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: 1, mode: 'planning' })
    await harness.host.executeTool(
      PLAN_TOOL_SAVE,
      { title: 'Reset Test Plan', markdown: '# Step 1' },
      { conversationId: 1 },
    )

    // Approve with handoff -> sets expectedHandoffReset, so immediate pi.reset keeps approved info
    const pHandoff = harness.host.executeTool(
      PLAN_TOOL_PROPOSE,
      { summary: 'Handoff plan' },
      { conversationId: 1 },
    ) as Promise<PluginToolResultEnvelope>
    await waitFor(() => harness.createdAsks.length === 1)
    harness.answerAsk(harness.createdAsks[0]!.id!, { decision: 'approve_handoff' })
    await pHandoff

    await harness.dispatchEvent('conversation.entry', {
      type: 'conversation.entry',
      conversationId: 1,
      entry: { kind: 'pi.reset' },
    })
    assert.equal(harness.readSessionDoc(1).approved?.title, 'Reset Test Plan')

    // Next manual /clear (pi.reset) clears all plan state, sessionDoc, KV, & badges
    await harness.dispatchEvent('conversation.entry', {
      type: 'conversation.entry',
      conversationId: 1,
      entry: { kind: 'pi.reset' },
    })
    assert.equal(harness.kvStore.get(PLAN_PLUGIN_ID, PLAN_KV_NAMESPACE, '1'), undefined)
    assert.deepEqual(harness.readSessionDoc(1), { mode: 'normal', awaitingApproval: false })
    const afterClearView = (await harness.host.invokeAction(PLAN_PLUGIN_ID, 'get', {
      conversationId: 1,
    })) as PlanSessionView
    assert.equal(afterClearView.mode, 'normal')
    assert.equal(afterClearView.draft, undefined)
    assert.equal(afterClearView.approved, undefined)
    assert.equal(harness.readBadgesDoc().byConversation['1'], undefined)

    // Re-enter planning, start pending ask, then helmx.rewind supersedes ask while preserving mode + draft
    await harness.host.invokeAction(PLAN_PLUGIN_ID, 'set_mode', { conversationId: 1, mode: 'planning' })
    await harness.host.executeTool(
      PLAN_TOOL_SAVE,
      { title: 'Rewind Preserved Plan', markdown: '# Keep Me' },
      { conversationId: 1 },
    )
    const pRewindAsk = harness.host.executeTool(
      PLAN_TOOL_PROPOSE,
      { summary: 'Will rewind' },
      { conversationId: 1 },
    ) as Promise<PluginToolResultEnvelope>
    await waitFor(() => harness.createdAsks.length === 2)

    await harness.dispatchEvent('conversation.entry', {
      type: 'conversation.entry',
      conversationId: 1,
      entry: { kind: 'helmx.rewind' },
    })
    const rewindRes = await pRewindAsk
    assert.equal((rewindRes.presentationMeta as { outcome?: string }).outcome, 'superseded')
    assert.equal(harness.readSessionDoc(1).mode, 'planning')
    assert.equal(harness.readSessionDoc(1).draft?.title, 'Rewind Preserved Plan')

    // turn_settled clears any leftover expected handoff counter
    await harness.host.runHook('turn_settled', {
      conversation: harness.conversations.get(1)!,
      inputs: [],
      outcome: 'completed',
      settledAt: Date.now(),
    })
  } finally {
    await harness.close()
  }
})
