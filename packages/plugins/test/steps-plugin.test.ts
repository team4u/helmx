/**
 * builtin:steps unit & PluginHost behavior tests:
 * 1. Contracts & schema bounds: normalization (0..12 items, empty array clears, control-char/whitespace/length
 *    validation, status enum, extra property rejection, redaction), `STEPS_PRESENTATION_META_SCHEMA` via
 *    `assertBoundedPresentationMeta`, and compact text output.
 * 2. Plugin registration & UI specs: bilingual display metadata, English-only tool/action/schema text,
 *    `replay: 'safe'`, scope `{ topLevelOnly: true, ownedBy: 'human' }`, `COMPOSER_DOCK_SLOT`, and `toolView`.
 * 3. Tool & Action behavior: `update_steps`, `get`, `clear`, `dismiss`, version monotonicity, dismiss reset on
 *    new version, and ineligible conversation guards (`403 steps_unsupported_conversation`).
 * 4. Lifecycle convergence:
 *    - `turn_settled` (`aborted` / `failed` / `completed`) preserves incomplete steps and records `settledOutcome`;
 *    - `onInput` (`origin: 'human'`) clears completed (`allTerminal`) checklists while preserving incomplete lists
 *      and clearing stale `settledOutcome`; ignores non-human and `whenBusy: 'reject'` inputs;
 *    - `conversation.entry` (`pi.reset` clears; `helmx.rewind` scans visible history in reverse to restore the
 *      latest incomplete `update_steps` snapshot across pages, stops at `pi.reset`, clears when rewound past
 *      all calls or when latest visible snapshot is `allTerminal`);
 *    - `conversation.deleted` cleans KV and sessionDoc; restart hydration restores persisted KV to `sessionDoc`.
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  COMPOSER_DOCK_SLOT,
  HelmxError,
  assertBoundedPresentationMeta,
  parseNonEmptyLocalizedText,
  type ConversationDetail,
  type ConversationEntry,
  type ConversationSummary,
  type LocalizedText,
  type PluginToolResultEnvelope,
} from '@helmx/protocol'
import { PluginHost, type PluginHostBackend } from '@helmx/kernel'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import {
  STEPS_KV_NAMESPACE,
  STEPS_MAX_ITEMS,
  STEPS_PLUGIN_ID,
  STEPS_PRESENTATION_META_SCHEMA,
  STEPS_SESSION_DOC,
  STEPS_TITLE_MAX_CHARS,
  STEPS_TOOL_UPDATE,
  buildStepsPresentationMeta,
  createEmptyStepsSessionView,
  createStepsPlugin,
  formatStepsToolOutput,
  isStepsAllTerminal,
  isStepsConversationEligible,
  normalizeStepItems,
  parseStepsToolPresentationMeta,
  type StepsConversationRecord,
  type StepsPluginOptions,
  type StepsSessionView,
} from '../src/steps.js'
import {
  MemoryConfigStore,
  MemoryDocStore,
  MemoryKvStore,
  assertRejectsCode,
  cleanupDir,
  makeConversationSummary,
  makeTempDir,
} from './helpers/plugin-test-env.js'

const TIMEOUT = { timeout: 60_000 } as const
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
const HAN_RE = /[\u4e00-\u9fff]/

function unsupported(what: string): never {
  throw new HelmxError('unsupported', `steps test fixture does not implement: ${what}`, 501)
}

function makeBaseBackend(): PluginHostBackend {
  return {
    isClosing: () => false,
    redact: (text) => text,
    profiles: {
      list: () => unsupported('host.profiles.list'),
      get: () => unsupported('host.profiles.get'),
      getSystem: () => unsupported('host.profiles.getSystem'),
      save: () => unsupported('host.profiles.save'),
      directory: () => unsupported('host.profiles.directory'),
    },
    skills: {
      list: () => unsupported('host.skills.list'),
      readFile: () => unsupported('host.skills.readFile'),
      ensureSkill: async () => {},
    },
    secrets: {
      get: () => unsupported('host.secrets.get'),
      set: () => unsupported('host.secrets.set'),
      delete: () => unsupported('host.secrets.delete'),
      addRedaction: () => () => {},
    },
    dispatchTrigger: () => unsupported('host.dispatchTrigger'),
    submitInput: () => unsupported('host.submitInput'),
    createConversation: () => unsupported('host.createConversation'),
    forkConversation: () => unsupported('host.forkConversation'),
    listConversations: () => unsupported('host.listConversations'),
    getConversation: () => unsupported('host.getConversation'),
    getConversationDetail: () => unsupported('host.getConversationDetail'),
    updateConversation: () => unsupported('host.updateConversation'),
    abortConversation: () => unsupported('host.abortConversation'),
    getConversationOwnership: () => unsupported('host.getConversationOwnership'),
    markConversationOwnership: () => unsupported('host.markConversationOwnership'),
    spawnAgent: () => unsupported('host.spawnAgent'),
    runGate: () => unsupported('host.runGate'),
    resolveSpawnTarget: () => unsupported('host.resolveSpawnTarget'),
    listActiveSpawnExecutions: () => unsupported('host.listActiveSpawnExecutions'),
    inspectNodePathUsage: () => unsupported('host.inspectNodePathUsage'),
    withFileLock: () => unsupported('host.withFileLock'),
    atomicWriteFile: () => unsupported('host.atomicWriteFile'),
    refreshModels: () => unsupported('host.refreshModels'),
    completeText: () => unsupported('host.completeText'),
    executionEnv: () => unsupported('host.executionEnv'),
    execEnv: () => unsupported('host.execEnv'),
    listArtifacts: () => unsupported('host.listArtifacts'),
    createAsk: () => unsupported('host.createAsk'),
    cancelAsk: () => unsupported('host.cancelAsk'),
    onEvent: () => unsupported('host.onEvent'),
    emitEvent: () => unsupported('host.emitEvent'),
    manageConversation: () => unsupported('host.manageConversation'),
  }
}

interface StepsHarness {
  host: PluginHost
  kvStore: MemoryKvStore
  conversations: Map<number, ConversationSummary>
  emittedEvents: Array<{ type: string; payload: unknown }>
  detailPages: Map<number, ConversationEntry[][]>
  dispatchEvent(type: string, payload: unknown): Promise<void>
  readSessionDoc(conversationId: number): StepsSessionView | null
  readSessionDocState(conversationId: number): { value: StepsSessionView | null; deleted?: boolean }
  close(): Promise<void>
}

async function openStepsHarness(options: {
  pluginOptions?: StepsPluginOptions
  kvStore?: MemoryKvStore
  deferServices?: boolean
  skipClientRoot?: boolean
  seedConversations?: ConversationSummary[]
} = {}): Promise<StepsHarness> {
  const dataDir = await makeTempDir('helmx-steps-unit-')
  const clientDir = options.skipClientRoot ? undefined : await makeTempDir('helmx-steps-client-')
  if (clientDir !== undefined) {
    writeFileSync(
      join(clientDir, 'index.tsx'),
      [
        'export function StepsActiveTray() { return null }',
        'export function StepsToolRow() { return null }',
      ].join('\n'),
      'utf8',
    )
  }

  const kvStore = options.kvStore ?? new MemoryKvStore()
  const docStore = new MemoryDocStore()
  const configStore = new MemoryConfigStore()
  const conversations = new Map<number, ConversationSummary>()
  for (const conv of options.seedConversations ?? [makeConversationSummary({ id: 1, stateChangeSeq: 1 })]) {
    conversations.set(conv.id, conv)
  }
  const detailPages = new Map<number, ConversationEntry[][]>()
  const listeners = new Map<string, Set<(payload: unknown) => Promise<void> | void>>()
  const emittedEvents: Array<{ type: string; payload: unknown }> = []

  const backend: PluginHostBackend = {
    ...makeBaseBackend(),
    redact: (text) => text.replaceAll('SECRET_KEY', '[REDACTED]'),
    listConversations: () => [...conversations.values()].map((c) => structuredClone(c)),
    getConversation: (id) => {
      const conv = conversations.get(id)
      if (!conv) throw new HelmxError('not_found', `Conversation ${id} not found`, 404, { conversationId: id })
      return structuredClone(conv)
    },
    getConversationDetail: async (id, opts) => {
      const conv = conversations.get(id)
      if (!conv) throw new HelmxError('not_found', `Conversation ${id} not found`, 404, { conversationId: id })
      const pages = detailPages.get(id) ?? [[]]
      const pageIdx = opts?.cursor !== undefined ? Number(opts.cursor) : 0
      const entries = pages[pageIdx] ?? []
      const nextCursor = pageIdx + 1 < pages.length ? String(pageIdx + 1) : undefined
      return {
        ...structuredClone(conv),
        entries: structuredClone(entries),
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      } satisfies ConversationDetail
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

  await host.register(
    createStepsPlugin(
      options.pluginOptions ?? (clientDir !== undefined ? { clientAssets: { clientRoot: clientDir } } : { clientAssets: {} }),
    ),
  )

  return {
    host,
    kvStore,
    conversations,
    emittedEvents,
    detailPages,
    async dispatchEvent(type, payload) {
      const set = listeners.get(type)
      if (!set) return
      for (const fn of [...set]) {
        await fn(payload)
      }
    },
    readSessionDoc(conversationId) {
      return host.getPublicSessionDoc(STEPS_PLUGIN_ID, STEPS_SESSION_DOC, conversationId).value as StepsSessionView | null
    },
    readSessionDocState(conversationId) {
      const snap = host.getPublicSessionDoc(STEPS_PLUGIN_ID, STEPS_SESSION_DOC, conversationId)
      return { value: snap.value as StepsSessionView | null, deleted: snap.deleted }
    },
    async close() {
      await host.dispose().catch(() => {})
      await cleanupDir(dataDir)
      if (clientDir !== undefined) await cleanupDir(clientDir)
    },
  }
}

test('contracts & pure helpers: normalizeStepItems, bounds, redaction, and presentationMeta validation', TIMEOUT, () => {
  assert.equal(STEPS_MAX_ITEMS, 12)
  assert.equal(STEPS_TITLE_MAX_CHARS, 120)

  assert.equal(isStepsConversationEligible(undefined), false)
  assert.equal(isStepsConversationEligible(makeConversationSummary({ id: 1 })), true)
  assert.equal(isStepsConversationEligible(makeConversationSummary({ id: 2, ownedBy: 'helmx' })), false)
  assert.equal(isStepsConversationEligible(makeConversationSummary({ id: 3, parentConversationId: 1 })), false)

  assert.deepEqual(normalizeStepItems([]), [])
  assert.deepEqual(
    normalizeStepItems(
      [
        { title: '  Inspect   schema with SECRET_TOKEN  ', status: 'in_progress' },
        { title: 'Run verification', status: 'pending' },
      ],
      (s) => s.replaceAll('SECRET_TOKEN', '[REDACTED]'),
    ),
    [
      { title: 'Inspect   schema with [REDACTED]', status: 'in_progress' },
      { title: 'Run verification', status: 'pending' },
    ],
  )

  assert.throws(() => normalizeStepItems('bad'), (e: unknown) => e instanceof HelmxError && e.code === 'validation_error')
  assert.throws(
    () =>
      normalizeStepItems(
        Array.from({ length: STEPS_MAX_ITEMS + 1 }, (_, i) => ({ title: `Step ${i}`, status: 'pending' })),
      ),
    (e: unknown) => e instanceof HelmxError && e.code === 'validation_error',
  )
  assert.throws(
    () => normalizeStepItems([{ title: '   ', status: 'pending' }]),
    (e: unknown) => e instanceof HelmxError && e.code === 'validation_error',
  )
  assert.throws(
    () => normalizeStepItems([{ title: 'Line 1\nLine 2', status: 'pending' }]),
    (e: unknown) => e instanceof HelmxError && e.code === 'validation_error',
  )
  assert.throws(
    () => normalizeStepItems([{ title: 'x'.repeat(STEPS_TITLE_MAX_CHARS + 1), status: 'pending' }]),
    (e: unknown) => e instanceof HelmxError && e.code === 'validation_error',
  )
  assert.throws(
    () => normalizeStepItems([{ title: 'Step', status: 'invalid' }]),
    (e: unknown) => e instanceof HelmxError && e.code === 'validation_error',
  )
  assert.throws(
    () => normalizeStepItems([{ title: 'Step', status: 'pending', extra: true }]),
    (e: unknown) => e instanceof HelmxError && e.code === 'validation_error',
  )

  assert.equal(isStepsAllTerminal([]), false)
  assert.equal(isStepsAllTerminal([{ status: 'done' }, { status: 'in_progress' }]), false)
  assert.equal(isStepsAllTerminal([{ status: 'done' }, { status: 'skipped' }, { status: 'failed' }]), true)

  const meta = buildStepsPresentationMeta(
    [
      { title: 'Read files', status: 'done' },
      { title: 'Implement plugin', status: 'in_progress' },
      { title: 'Run tests', status: 'pending' },
    ],
    2,
  )
  const bounded = assertBoundedPresentationMeta(meta, { schema: STEPS_PRESENTATION_META_SCHEMA })
  assert.deepEqual(parseStepsToolPresentationMeta(bounded), meta)
  assert.equal(formatStepsToolOutput(meta), 'Updated steps: 1/3 done, current: Implement plugin.')
  assert.equal(formatStepsToolOutput(buildStepsPresentationMeta([], 3)), 'Cleared steps.')
  assert.equal(
    formatStepsToolOutput(buildStepsPresentationMeta([{ title: 'A', status: 'done' }], 4)),
    'Updated steps: 1/1 completed.',
  )
  assert.equal(EMOJI_RE.test(formatStepsToolOutput(meta)), false)
})

test('registration & manifest: bilingual UI copy, English tool schemas, replay=safe, dock slot & toolView', TIMEOUT, async () => {
  const h = await openStepsHarness()
  try {
    const manifest = h.host.getManifest(STEPS_PLUGIN_ID)
    assert.ok(parseNonEmptyLocalizedText(manifest.name as LocalizedText))
    assert.ok(parseNonEmptyLocalizedText(manifest.description as LocalizedText))
    assert.equal(manifest.icon, 'check-square')
    assert.equal(manifest.locked, false)

    const tool = h.host.listTools().find((t) => t.name === STEPS_TOOL_UPDATE)
    assert.ok(tool, 'update_steps must be registered')
    assert.equal(tool.replay, 'safe')
    assert.equal(HAN_RE.test(tool.description), false)
    assert.equal(HAN_RE.test(JSON.stringify(tool.promptGuidelines)), false)
    assert.deepEqual(tool.scope, { topLevelOnly: true, ownedBy: 'human' })

    const dockSlot = manifest.ui.find((u) => u.surface === 'plugin.slot')
    assert.equal(dockSlot?.spec['target'], COMPOSER_DOCK_SLOT)
    const toolView = manifest.ui.find((u) => u.surface === 'tool.view')
    assert.deepEqual(toolView?.spec['toolNames'], [STEPS_TOOL_UPDATE])
    assert.equal(toolView?.spec['replaceRow'], true)

    assert.equal(manifest.actions.find((a) => a.id === 'get')?.idempotent, true)
    assert.equal(manifest.actions.find((a) => a.id === 'dismiss')?.visibility, 'ui')
    assert.ok(manifest.actions.every((a) => a.exposeToPrompt === false))
  } finally {
    await h.close()
  }
})

test('update_steps tool, actions (get/clear/dismiss), redaction, and ineligible conversation guards', TIMEOUT, async () => {
  let clock = 1_700_000_000_000
  const childConv = makeConversationSummary({ id: 2, parentConversationId: 1 })
  const agentConv = makeConversationSummary({ id: 3, ownedBy: 'helmx' })
  const h = await openStepsHarness({
    pluginOptions: { clientAssets: {}, now: () => (clock += 100) },
    seedConversations: [makeConversationSummary({ id: 1 }), childConv, agentConv],
  })
  try {
    // 1. Initial get returns empty view and sessionDoc is null
    const empty = (await h.host.invokeAction(STEPS_PLUGIN_ID, 'get', { conversationId: 1 })) as StepsSessionView
    assert.deepEqual(empty, createEmptyStepsSessionView())
    assert.equal(h.readSessionDoc(1), null)

    // 2. Model calls update_steps with full list + secret redaction
    const res1 = (await h.host.executeTool(
      STEPS_TOOL_UPDATE,
      {
        steps: [
          { title: 'Inspect SECRET_KEY setup', status: 'done' },
          { title: 'Write plugin core', status: 'in_progress' },
          { title: 'Run verify', status: 'pending' },
        ],
      },
      { conversationId: 1 },
    )) as PluginToolResultEnvelope
    assert.equal(res1.output, 'Updated steps: 1/3 done, current: Write plugin core.')
    assert.deepEqual(parseStepsToolPresentationMeta(res1.presentationMeta), {
      version: 1,
      total: 3,
      done: 1,
      inProgressCount: 1,
      failedCount: 0,
      skippedCount: 0,
      allTerminal: false,
      cleared: false,
      inProgressTitle: 'Write plugin core',
      steps: [
        { title: 'Inspect [REDACTED] setup', status: 'done' },
        { title: 'Write plugin core', status: 'in_progress' },
        { title: 'Run verify', status: 'pending' },
      ],
    })

    const doc1 = h.readSessionDoc(1)!
    assert.equal(doc1.version, 1)
    assert.equal(doc1.dismissed, false)
    assert.equal(doc1.allTerminal, false)
    assert.equal(doc1.steps[0]?.title, 'Inspect [REDACTED] setup')

    // 3. dismiss hides version 1; new update_steps bumps version to 2 and auto-unhides
    const dismissed = (await h.host.invokeAction(STEPS_PLUGIN_ID, 'dismiss', { conversationId: 1 })) as StepsSessionView
    assert.equal(dismissed.dismissed, true)
    assert.equal(h.readSessionDoc(1)?.dismissed, true)

    await h.host.executeTool(
      STEPS_TOOL_UPDATE,
      {
        steps: [
          { title: 'Inspect [REDACTED] setup', status: 'done' },
          { title: 'Write plugin core', status: 'done' },
          { title: 'Run verify', status: 'done' },
        ],
      },
      { conversationId: 1 },
    )
    const doc2 = h.readSessionDoc(1)!
    assert.equal(doc2.version, 2)
    assert.equal(doc2.dismissed, false)
    assert.equal(doc2.allTerminal, true)

    // 4. update_steps({ steps: [] }) clears KV and sessionDoc
    const resClear = (await h.host.executeTool(STEPS_TOOL_UPDATE, { steps: [] }, { conversationId: 1 })) as PluginToolResultEnvelope
    assert.equal(resClear.output, 'Cleared steps.')
    assert.equal(parseStepsToolPresentationMeta(resClear.presentationMeta)?.cleared, true)
    assert.equal(h.kvStore.get(STEPS_PLUGIN_ID, STEPS_KV_NAMESPACE, '1'), undefined)
    assert.equal(h.readSessionDoc(1), null)

    // 5. clear action clears active list cleanly
    await h.host.executeTool(
      STEPS_TOOL_UPDATE,
      { steps: [{ title: 'Step A', status: 'in_progress' }] },
      { conversationId: 1 },
    )
    const clearedView = (await h.host.invokeAction(STEPS_PLUGIN_ID, 'clear', { conversationId: 1 })) as StepsSessionView
    assert.deepEqual(clearedView, createEmptyStepsSessionView())
    assert.equal(h.readSessionDoc(1), null)

    // 6. Scope guards for subagent / automated conversations
    await assertRejectsCode(
      () => h.host.executeTool(STEPS_TOOL_UPDATE, { steps: [{ title: 'X', status: 'pending' }] }, { conversationId: 2 }),
      'conversation_scope_violation',
    )
    await assertRejectsCode(
      () => h.host.invokeAction(STEPS_PLUGIN_ID, 'clear', { conversationId: 2 }),
      'steps_unsupported_conversation',
    )
    await assertRejectsCode(
      () => h.host.invokeAction(STEPS_PLUGIN_ID, 'dismiss', { conversationId: 3 }),
      'steps_unsupported_conversation',
    )
  } finally {
    await h.close()
  }
})

test('lifecycle convergence: turn_settled, human input auto-clear, pi.reset, multi-page rewind recovery, delete & hydrate', TIMEOUT, async () => {
  const sharedKv = new MemoryKvStore()
  const h = await openStepsHarness({ kvStore: sharedKv })
  try {
    // 1. Aborted turn while step is in_progress preserves steps and sets settledOutcome = 'aborted'
    await h.host.executeTool(
      STEPS_TOOL_UPDATE,
      {
        steps: [
          { title: 'Prepare files', status: 'done' },
          { title: 'Edit handler', status: 'in_progress' },
          { title: 'Verify', status: 'pending' },
        ],
      },
      { conversationId: 1 },
    )
    await h.host.runHook('turn_settled', {
      conversation: h.conversations.get(1)!,
      inputs: [],
      outcome: 'aborted',
      settledAt: Date.now(),
    })
    const afterAbort = h.readSessionDoc(1)!
    assert.equal(afterAbort.settledOutcome, 'aborted')
    assert.equal(afterAbort.steps[1]?.status, 'in_progress')

    // 2. Subsequent human input preserves incomplete list AND clears settledOutcome
    await h.host.runHook('input', {
      conversationId: 1,
      input: { id: 'in-1', text: 'continue', origin: 'human', createdAt: Date.now() },
    })
    const afterResumeInput = h.readSessionDoc(1)!
    assert.equal(afterResumeInput.settledOutcome, undefined)
    assert.equal(afterResumeInput.steps.length, 3)

    // 3. Completed allTerminal list is preserved on turn_settled, then cleared on next human input
    await h.host.executeTool(
      STEPS_TOOL_UPDATE,
      {
        steps: [
          { title: 'Prepare files', status: 'done' },
          { title: 'Edit handler', status: 'done' },
          { title: 'Verify', status: 'skipped' },
        ],
      },
      { conversationId: 1 },
    )
    await h.host.runHook('turn_settled', {
      conversation: h.conversations.get(1)!,
      inputs: [],
      outcome: 'completed',
      settledAt: Date.now(),
    })
    assert.equal(h.readSessionDoc(1)?.allTerminal, true)
    assert.equal(h.readSessionDoc(1)?.settledOutcome, undefined)

    // Non-human / reject inputs do NOT clear completed checklist
    await h.host.runHook('input', {
      conversationId: 1,
      input: { id: 'in-2', text: 'bg ping', origin: 'agent', createdAt: Date.now() },
    })
    await h.host.runHook('input', {
      conversationId: 1,
      input: { id: 'in-3', text: 'rejected', origin: 'human', whenBusy: 'reject', createdAt: Date.now() },
    })
    assert.equal(h.readSessionDoc(1)?.allTerminal, true)

    // Regular human input clears the completed checklist
    await h.host.runHook('input', {
      conversationId: 1,
      input: { id: 'in-4', text: 'new topic', origin: 'human', createdAt: Date.now() },
    })
    assert.equal(h.readSessionDoc(1), null)
    assert.equal(h.kvStore.get(STEPS_PLUGIN_ID, STEPS_KV_NAMESPACE, '1'), undefined)

    // 4. pi.reset clears immediately
    await h.host.executeTool(
      STEPS_TOOL_UPDATE,
      { steps: [{ title: 'Active task', status: 'in_progress' }] },
      { conversationId: 1 },
    )
    await h.dispatchEvent('conversation.entry', {
      type: 'conversation.entry',
      conversationId: 1,
      entry: { id: '10', kind: 'pi.reset' },
    })
    assert.equal(h.readSessionDoc(1), null)

    // 5. helmx.rewind restores latest incomplete update_steps snapshot across detail pages and stops at pi.reset
    await h.host.executeTool(
      STEPS_TOOL_UPDATE,
      { steps: [{ title: 'Future step', status: 'in_progress' }] },
      { conversationId: 1 },
    )
    const targetMeta = buildStepsPresentationMeta(
      [
        { title: 'Restored step 1', status: 'done' },
        { title: 'Restored step 2', status: 'in_progress' },
      ],
      1,
    )
    h.detailPages.set(1, [
      // Page 0 (newest visible entries): contains a newer failed update_steps call (ignored) and rewind marker
      [
        { id: '20', kind: 'helmx.rewind' },
        {
          id: '21',
          kind: 'pi.tool-result',
          model: [{ role: 'toolResult', toolName: STEPS_TOOL_UPDATE, isError: true, details: { version: 99, steps: [{ title: 'Bad', status: 'done' }] } }],
        },
      ],
      // Page 1 (older visible entries): holds the target incomplete update_steps call
      [
        {
          id: '5',
          kind: 'pi.tool-result',
          model: [{ role: 'toolResult', toolName: STEPS_TOOL_UPDATE, isError: false, details: targetMeta }],
        },
      ],
    ])
    await h.dispatchEvent('conversation.entry', {
      type: 'conversation.entry',
      conversationId: 1,
      entry: { id: '20', kind: 'helmx.rewind' },
    })
    const rewound = h.readSessionDoc(1)!
    assert.equal(rewound.steps.length, 2)
    assert.equal(rewound.steps[1]?.title, 'Restored step 2')

    // Rewinding when separated by pi.reset clears steps instead of crossing reset boundary
    h.detailPages.set(1, [
      [
        {
          id: '15',
          kind: 'pi.tool-result',
          model: [{ role: 'toolResult', toolName: STEPS_TOOL_UPDATE, isError: false, details: targetMeta }],
        },
        { id: '18', kind: 'pi.reset' },
        { id: '25', kind: 'helmx.rewind' },
      ],
    ])
    await h.dispatchEvent('conversation.entry', {
      type: 'conversation.entry',
      conversationId: 1,
      entry: { id: '25', kind: 'helmx.rewind' },
    })
    assert.equal(h.readSessionDoc(1), null)

    // 6. Restart hydration restores KV -> sessionDoc
    await h.host.executeTool(
      STEPS_TOOL_UPDATE,
      { steps: [{ title: 'Survive restart', status: 'in_progress' }] },
      { conversationId: 1 },
    )
  } finally {
    await h.close()
  }

  // Reopen new host against same MemoryKvStore
  const h2 = await openStepsHarness({ kvStore: sharedKv })
  try {
    const hydrated = h2.readSessionDoc(1)
    assert.equal(hydrated?.steps[0]?.title, 'Survive restart')

    // 7. conversation.deleted removes persisted KV entry
    h2.conversations.delete(1)
    await h2.dispatchEvent('conversation.deleted', { type: 'conversation.deleted', conversationId: 1 })
    assert.equal(sharedKv.get(STEPS_PLUGIN_ID, STEPS_KV_NAMESPACE, '1'), undefined)
  } finally {
    await h2.close()
  }
})

test('KV hydrate ignores corrupt records and missing conversations', TIMEOUT, async () => {
  const sharedKv = new MemoryKvStore()
  sharedKv.setParsed(STEPS_PLUGIN_ID, STEPS_KV_NAMESPACE, 'not-a-number', { steps: [{ title: 'x', status: 'done' }] })
  sharedKv.setParsed<StepsConversationRecord>(STEPS_PLUGIN_ID, STEPS_KV_NAMESPACE, '999', {
    steps: [{ title: 'Dead conv', status: 'pending' }],
    version: 1,
    updatedAt: 1000,
  })
  const h = await openStepsHarness({ kvStore: sharedKv })
  try {
    assert.equal(sharedKv.get(STEPS_PLUGIN_ID, STEPS_KV_NAMESPACE, 'not-a-number'), undefined)
    assert.equal(sharedKv.get(STEPS_PLUGIN_ID, STEPS_KV_NAMESPACE, '999'), undefined)
    assert.equal(h.readSessionDoc(1), null)
  } finally {
    await h.close()
  }
})
