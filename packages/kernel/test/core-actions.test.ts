/**
 * End-to-end integration tests for kernel-owned `core:*` actions (`packages/kernel/src/runtime/core-actions.ts`):
 * - Every domain (`core:conversations`, `core:profiles`, `core:models`, `core:nodes`, `core:plugins`, `core:asks`, `core:skills`)
 *   exercised through real `KernelRuntime.open` + `POST /api/actions/core%3A<domain>/<action>` + `run_action` tool;
 * - Plugin isolation: `GET /api/plugins` & `PluginHost.list()` exclude `core:*`, `before_turn` omits `core:*` from `<available_actions>`;
 * - Security invariants: Watchdog Ownership Red Line (`403 ownership_violation`), self-mutation guard (`409 self_mutation_forbidden`),
 *   honest `origin: 'agent'` forcing on `core:conversations.send`, `scope: { conversationIds: [] }` blocking `core:asks.answer` and
 *   `core:skills.{list,read}`, `scope: { topLevelOnly: true, ownedBy: 'human' }` guarding host-governance mutations, secret masking
 *   on `core:plugins.config_get`, sanitized `core:models.providers`, and non-exposure of credentials/providers.set/nodes.issue/env.exec;
 * - Discovery: `run_action({ list: true, pluginId: 'core:' })` & `describe: true`;
 * - `GET /api/search?maxPerConversation=...` validation (`1..20`) and real FTS per-conversation hit bounding.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import {
  assertSchemaCompilable,
  CORE_CLI_COMMAND_PATHS,
  HelmxError,
  validateOrThrow,
  type ActionManifest,
  type ConversationSummary,
  type JsonSchema,
} from '@helmx/protocol'
import { handleApi } from '../src/http/routes.js'
import { actionCliCommand } from '../src/runtime/action-prompts.js'
import { systemSectionsOf } from '../src/runtime/hook-projection.js'
import { KernelRuntime } from '../src/runtime/index.js'
import { cleanupDir, makeFauxModels, makeTempDir, waitFor } from './helpers.js'

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']

async function openRuntime(dir: string): Promise<KernelRuntime & { __faux: FauxHandle }> {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models,
  })
  return Object.assign(runtime, { __faux: faux })
}

async function apiCall(
  kernel: KernelRuntime,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; code?: string; body: any }> {
  try {
    const response = await handleApi(
      new Request(`http://hub${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { 'content-type': 'application/json' },
            }),
      }),
      kernel as never,
    )
    const parsed = (await response.json().catch(() => undefined)) as any
    return { status: response.status, code: parsed?.error?.code, body: parsed }
  } catch (error) {
    if (error instanceof HelmxError) {
      return {
        status: error.status,
        code: error.code,
        body: { error: { code: error.code, message: error.message, details: error.details } },
      }
    }
    throw error
  }
}

async function postCoreAction(
  kernel: KernelRuntime,
  domain: string,
  actionId: string,
  input: unknown,
  conversationId?: number,
): Promise<{ status: number; code?: string; body: any }> {
  const owner = `core:${domain}`
  return apiCall(
    kernel,
    'POST',
    `/api/actions/${encodeURIComponent(owner)}/${encodeURIComponent(actionId)}`,
    {
      input,
      ...(conversationId !== undefined ? { conversationId } : {}),
    },
  )
}

async function invokeRunActionTool(
  kernel: KernelRuntime,
  args: Record<string, unknown>,
  conversationId: number,
): Promise<{ text: string; isError?: boolean }> {
  const tool = kernel.registry
    .snapshot()
    .tools()
    .find((entry) => entry.tool.name === 'run_action')?.tool as unknown as {
    execute(
      args: Record<string, unknown>,
      api: { conversationId: number },
      context: { abortSignal?: AbortSignal },
    ): Promise<{ output: Array<{ type: 'text'; text: string }>; isError?: boolean }>
  } | undefined
  assert.ok(tool, 'run_action tool must be registered on KernelRuntime.registry')
  const res = await tool.execute(args, { conversationId }, {})
  return { text: res.output[0]?.text ?? '', isError: res.isError }
}

let root: string

before(async () => {
  root = await makeTempDir('helmx-core-actions-')
})

after(async () => {
  await cleanupDir(root)
}, { timeout: 60_000 })

describe('Core actions (core:*) parity, discovery, and security invariants', { timeout: 60_000 }, () => {
  it('registers all 7 core domains cleanly, excludes core:* from /api/plugins, and enforces discovery/CLI hiding invariants', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'catalog'))
    try {
      // GET /api/plugins & PluginHost.list() must NEVER include `core:*`.
      const pluginsRes = await apiCall(kernel, 'GET', '/api/plugins')
      assert.equal(pluginsRes.status, 200)
      assert.ok(Array.isArray(pluginsRes.body))
      assert.equal(
        (pluginsRes.body as Array<{ id: string }>).some((p) => p.id.startsWith('core:')),
        false,
        'GET /api/plugins must never expose core:* owners',
      )
      assert.equal(kernel.plugins.list().some((p) => p.id.startsWith('core:')), false)
      assert.equal(kernel.plugins.listManifests().some((m) => m.id.startsWith('core:')), false)

      const coreManifests = kernel.plugins
        .listActions()
        .filter((m) => m.pluginId.startsWith('core:'))
      const domains = [...new Set(coreManifests.map((m) => m.pluginId))].sort()
      assert.deepEqual(domains, [
        'core:asks',
        'core:conversations',
        'core:models',
        'core:nodes',
        'core:plugins',
        'core:profiles',
        'core:skills',
      ])

      const profileActionIds = coreManifests.filter((m) => m.pluginId === 'core:profiles').map((m) => m.id)
      assert.deepEqual(profileActionIds, ['list', 'get', 'create', 'update', 'delete'])
      const modelActionIds = coreManifests.filter((m) => m.pluginId === 'core:models').map((m) => m.id)
      assert.deepEqual(modelActionIds, ['list', 'providers', 'refresh', 'default_get', 'default', 'filter'])

      // Every core:* action must set exposeToPrompt: false and declare an explicit static cli.command
      // matching CORE_CLI_COMMAND_PATHS (never lying with cli.hidden: true), and actionCliCommand must
      // render the real `helmx ...` command while CLI dynamic mounting skips core:* by namespace.
      const coreCliPathSet = new Set<string>(CORE_CLI_COMMAND_PATHS)
      for (const m of coreManifests) {
        assert.equal(m.exposeToPrompt, false, `${m.pluginId}.${m.id} must set exposeToPrompt: false`)
        assert.equal(m.cli?.hidden, undefined, `${m.pluginId}.${m.id} must not use legacy cli.hidden: true`)
        assert.ok(
          Array.isArray(m.cli?.command) && m.cli!.command!.length > 0,
          `${m.pluginId}.${m.id} must declare cli.command`,
        )
        const joined = m.cli!.command!.join(' ')
        assert.ok(coreCliPathSet.has(joined), `${m.pluginId}.${m.id} cli.command "${joined}" must exist in CORE_CLI_COMMAND_PATHS`)
        assert.equal(actionCliCommand(m), `helmx ${joined}`, `${m.pluginId}.${m.id} must render real static CLI command`)
      }

      // Forbidden sensitive capabilities must never be registered as core:* actions.
      const qualifiedIds = new Set(coreManifests.map((m) => `${m.pluginId}.${m.id}`))
      for (const forbidden of [
        'core:credentials.set',
        'core:credentials.delete',
        'core:providers.set',
        'core:nodes.issue',
        'core:env.exec',
      ]) {
        assert.equal(qualifiedIds.has(forbidden), false, `forbidden action ${forbidden} must not be registered`)
      }
      assert.equal(
        coreManifests.some((m) => m.pluginId === 'core:credentials' || m.pluginId === 'core:env'),
        false,
      )

      // run_action({ list: true, pluginId: 'core:' }) discovers reachable actions in top-level human session #1,
      // surfaces `cli: 'helmx ...'`, and omits `core:asks.answer` and `core:skills.{list,read}`.
      const listed = await invokeRunActionTool(kernel, { list: true, pluginId: 'core:' }, 1)
      assert.equal(listed.isError, undefined)
      const items = JSON.parse(listed.text) as Array<{ actionId: string; cli?: string; idempotent?: boolean }>
      const listedIds = new Set(items.map((i) => i.actionId))
      assert.ok(listedIds.has('core:conversations.search'))
      assert.ok(listedIds.has('core:profiles.list'))
      assert.ok(listedIds.has('core:models.default_get'), 'core:models.default_get should be discoverable and idempotent')
      assert.ok(listedIds.has('core:plugins.config_get'))
      assert.ok(listedIds.has('core:nodes.endpoints'), 'core:nodes.endpoints should be discoverable and idempotent')
      assert.ok(listedIds.has('core:nodes.remove'), 'top-level human session should see host-governance mutations')
      const defaultGetMeta = items.find((i) => i.actionId === 'core:models.default_get')!
      assert.equal(defaultGetMeta.cli, 'helmx models default')
      assert.equal(defaultGetMeta.idempotent, true)
      const endpointsMeta = items.find((i) => i.actionId === 'core:nodes.endpoints')!
      assert.equal(endpointsMeta.cli, 'helmx nodes endpoints')
      assert.equal(endpointsMeta.idempotent, true)
      assert.equal(listedIds.has('core:asks.answer'), false, 'core:asks.answer must be hidden in any session')
      assert.equal(listedIds.has('core:skills.list'), false, 'core:skills.list must be hidden in any session')
      assert.equal(listedIds.has('core:skills.read'), false, 'core:skills.read must be hidden in any session')

      const searchMeta = items.find((i) => i.actionId === 'core:conversations.search')!
      assert.equal(searchMeta.cli, 'helmx search')
      assert.equal(searchMeta.idempotent, true)

      // run_action describe returns full schema for in-scope core action, and rejects out-of-scope core:skills.read.
      const descOk = await invokeRunActionTool(
        kernel,
        { describe: true, actionId: 'core:conversations.search' },
        1,
      )
      assert.equal(descOk.isError, undefined)
      const manifest = JSON.parse(descOk.text) as ActionManifest
      assert.equal(manifest.pluginId, 'core:conversations')
      assert.equal(manifest.id, 'search')
      assert.ok((manifest.inputSchema.properties as Record<string, unknown>)['maxPerConversation'])

      const descBlocked = await invokeRunActionTool(
        kernel,
        { describe: true, actionId: 'core:skills.read' },
        1,
      )
      assert.equal(descBlocked.isError, true)
      assert.match(descBlocked.text, /outside allowed scope/i)

      // Subagent (child) and helmx-owned sessions must NOT see host-governance mutations in list: true.
      const child = await kernel.conversations.createConversation({
        title: 'child-subagent',
        parentConversationId: 1,
        ownedBy: 'helmx',
      })
      const childListed = await invokeRunActionTool(kernel, { list: true, pluginId: 'core:' }, child.id)
      assert.equal(childListed.isError, undefined)
      const childIds = new Set(
        (JSON.parse(childListed.text) as Array<{ actionId: string }>).map((i) => i.actionId),
      )
      assert.ok(childIds.has('core:conversations.search'))
      assert.equal(childIds.has('core:nodes.remove'), false)
      assert.equal(childIds.has('core:plugins.enable'), false)
      assert.equal(childIds.has('core:asks.cancel'), false)

      // Zero prompt bloat: outgoing LLM <available_actions> section includes exposeToPrompt:true plugin actions
      // while completely excluding every core:* action (exposeToPrompt: false).
      await kernel.plugins.register({
        id: 'test:prompt-spy',
        definePlugin: (ctx) => {
          ctx.action({
            id: 'ping',
            description: 'Public probe action for prompt projection verification',
            inputSchema: { type: 'object', additionalProperties: false },
            outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
            handler: async () => ({ ok: true }),
          })
        },
      })
      const capturedSections: Array<{ id: string; text: string }> = []
      kernel.__faux.setResponses([
        (context) => {
          capturedSections.push(...systemSectionsOf(context.messages))
          return fauxAssistantMessage('ok')
        },
      ])
      await kernel.conversations.submitInput(1, 'check prompt')
      await kernel.conversations.waitForIdle(1)
      const promptActions = capturedSections.find((s) => s.id === 'prompt.actions')
      assert.ok(
        promptActions,
        'expected outgoing system prompt to contain prompt.actions section for exposeToPrompt:true plugin action',
      )
      assert.ok(
        promptActions.text.includes('test:prompt-spy.ping'),
        'expected <available_actions> to list public test:prompt-spy.ping action',
      )
      assert.equal(
        promptActions.text.includes('core:'),
        false,
        'core:* actions must never be injected into <available_actions>',
      )
    } finally {
      await kernel.close()
    }
  })

  it('core:conversations end-to-end lifecycle + FTS maxPerConversation (1..20) via HTTP and run_action', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'conversations'))
    try {
      // Create a second conversation via core:conversations.create
      const createdRes = await postCoreAction(kernel, 'conversations', 'create', {
        title: 'Searchable Alpha',
        tags: ['alpha'],
      })
      assert.equal(createdRes.status, 200)
      const convA = createdRes.body as ConversationSummary
      assert.equal(convA.title, 'Searchable Alpha')

      // Update conversation via core:conversations.update
      const updatedRes = await postCoreAction(kernel, 'conversations', 'update', {
        conversationId: convA.id,
        title: 'Searchable Alpha Updated',
        pinned: true,
      })
      assert.equal(updatedRes.status, 200)
      assert.equal(updatedRes.body.title, 'Searchable Alpha Updated')
      assert.equal(updatedRes.body.pinned, true)

      // Send 3 turns containing the same search token so we can test maxPerConversation=1 vs maxPerConversation=3
      kernel.__faux.setResponses([
        fauxAssistantMessage('quantumreply one'),
        fauxAssistantMessage('quantumreply two'),
        fauxAssistantMessage('quantumreply three'),
      ])
      for (const idx of [1, 2, 3]) {
        const sent = await postCoreAction(kernel, 'conversations', 'send', {
          conversationId: convA.id,
          text: `quantumtoken message ${idx}`,
          wait: true,
        })
        assert.equal(sent.status, 200)
        assert.match(sent.body.text, /quantumreply/)
      }

      // Search via GET /api/search?maxPerConversation=1 vs 3 and reject out-of-range 0 / 21
      const httpOne = await apiCall(kernel, 'GET', '/api/search?q=quantumtoken&maxPerConversation=1')
      assert.equal(httpOne.status, 200)
      assert.equal(
        (httpOne.body as Array<{ conversationId: number }>).filter((h) => h.conversationId === convA.id).length,
        1,
      )
      const httpThree = await apiCall(kernel, 'GET', '/api/search?q=quantumtoken&maxPerConversation=3')
      assert.equal(httpThree.status, 200)
      assert.equal(
        (httpThree.body as Array<{ conversationId: number }>).filter((h) => h.conversationId === convA.id).length,
        3,
      )
      for (const badVal of ['0', '21', '-1', 'abc']) {
        const badRes = await apiCall(kernel, 'GET', `/api/search?q=quantumtoken&maxPerConversation=${badVal}`)
        assert.equal(badRes.status, 400)
        assert.equal(badRes.code, 'validation_error')
      }

      // Same search via run_action (core:conversations.search)
      const searchToolRes = await invokeRunActionTool(
        kernel,
        {
          actionId: 'core:conversations.search',
          input: { q: 'quantumtoken', maxPerConversation: 2, topLevelOnly: true },
        },
        1,
      )
      assert.equal(searchToolRes.isError, undefined)
      const toolHits = JSON.parse(searchToolRes.text) as Array<{ conversationId: number; entryId?: string }>
      assert.equal(toolHits.filter((h) => h.conversationId === convA.id).length, 2)

      // Invalid maxPerConversation: 21 rejected by schema
      const badActionSearch = await postCoreAction(kernel, 'conversations', 'search', {
        q: 'quantumtoken',
        maxPerConversation: 21,
      })
      assert.equal(badActionSearch.status, 400)
      assert.equal(badActionSearch.code, 'validation_error')

      // core:conversations.get (with pagination limit & cursor) + core:conversations.entry
      const page1 = await postCoreAction(kernel, 'conversations', 'get', {
        conversationId: convA.id,
        limit: 2,
      })
      assert.equal(page1.status, 200)
      assert.equal(page1.body.entries.length, 2)
      assert.equal(typeof page1.body.nextCursor, 'string')

      const page2 = await postCoreAction(kernel, 'conversations', 'get', {
        conversationId: convA.id,
        limit: 2,
        cursor: page1.body.nextCursor,
      })
      assert.equal(page2.status, 200)
      assert.ok(page2.body.entries.length >= 1)

      const firstEntryId = Number(page1.body.entries[0].id)
      const entryRes = await postCoreAction(kernel, 'conversations', 'entry', {
        conversationId: convA.id,
        entryId: firstEntryId,
      })
      assert.equal(entryRes.status, 200)
      assert.equal(entryRes.body.id, String(firstEntryId))

      // core:conversations.list mirrors GET /api/conversations defaults & rejects mutually exclusive flags
      const childHelmx = await kernel.conversations.createConversation({
        title: 'Child Helmx',
        parentConversationId: convA.id,
        ownedBy: 'helmx',
      })
      const defaultList = await postCoreAction(kernel, 'conversations', 'list', {})
      assert.equal(defaultList.status, 200)
      const defaultIds = (defaultList.body as ConversationSummary[]).map((c) => c.id)
      assert.ok(defaultIds.includes(convA.id))
      assert.equal(defaultIds.includes(childHelmx.id), false)

      const allList = await postCoreAction(kernel, 'conversations', 'list', { all: true })
      assert.equal(allList.status, 200)
      assert.ok((allList.body as ConversationSummary[]).some((c) => c.id === childHelmx.id))

      const childrenList = await postCoreAction(kernel, 'conversations', 'list', {
        parentConversationId: convA.id,
      })
      assert.equal(childrenList.status, 200)
      assert.deepEqual(
        (childrenList.body as ConversationSummary[]).map((c) => c.id),
        [childHelmx.id],
      )

      const conflictList = await postCoreAction(kernel, 'conversations', 'list', {
        all: true,
        parentConversationId: convA.id,
      })
      assert.equal(conflictList.status, 400)
      assert.equal(conflictList.code, 'validation_error')

      const includeChildrenList = await postCoreAction(kernel, 'conversations', 'list', {
        topLevelOnly: false,
      })
      assert.equal(includeChildrenList.status, 200)
      assert.ok((includeChildrenList.body as ConversationSummary[]).some((c) => c.id === childHelmx.id))

      // core:conversations.fork
      const forkRes = await postCoreAction(kernel, 'conversations', 'fork', {
        conversationId: convA.id,
        title: 'Forked Alpha',
      })
      assert.equal(forkRes.status, 200)
      const forkedId = forkRes.body.id as number
      assert.equal(forkRes.body.title, 'Forked Alpha')
      assert.equal(forkRes.body.parentConversationId, convA.id)

      // core:conversations.reset / abort / compact / withdraw / delete
      const resetRes = await postCoreAction(kernel, 'conversations', 'reset', {
        conversationId: forkedId,
        handoff: 'fresh start',
      })
      assert.equal(resetRes.status, 200)
      assert.equal(resetRes.body.id, forkedId)

      const abortRes = await postCoreAction(kernel, 'conversations', 'abort', {
        conversationId: forkedId,
      })
      assert.equal(abortRes.status, 200)
      assert.deepEqual(abortRes.body, { ok: true })

      const compactRes = await postCoreAction(kernel, 'conversations', 'compact', {
        conversationId: convA.id,
        instructions: 'keep key facts',
      })
      assert.equal(compactRes.status, 200)
      assert.equal(typeof compactRes.body.taskId, 'number')

      const withdrawMissing = await postCoreAction(kernel, 'conversations', 'withdraw', {
        conversationId: forkedId,
        submissionId: 999999,
      })
      assert.equal(withdrawMissing.status, 404)
      assert.equal(withdrawMissing.code, 'not_found')

      const deleteRes = await postCoreAction(kernel, 'conversations', 'delete', {
        conversationId: forkedId,
      })
      assert.equal(deleteRes.status, 200)
      assert.deepEqual(deleteRes.body, { ok: true })
    } finally {
      await kernel.close()
    }
  })

  it('enforces Watchdog ownership red line (403), self-mutation guard (409), and honest origin="agent" on core:conversations', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'conv-security'))
    try {
      const humanTarget = await kernel.conversations.createConversation({
        title: 'Human Owned Target',
        ownedBy: 'human',
      })
      const helmxCaller = await kernel.conversations.createConversation({
        title: 'Helmx Background Caller',
        ownedBy: 'helmx',
      })
      const helmxTarget = await kernel.conversations.createConversation({
        title: 'Helmx Owned Target',
        ownedBy: 'helmx',
      })
      const helmxParentWithHumanChild = await kernel.conversations.createConversation({
        title: 'Helmx Parent',
        ownedBy: 'helmx',
      })
      await kernel.conversations.createConversation({
        title: 'Human Child',
        parentConversationId: helmxParentWithHumanChild.id,
        ownedBy: 'human',
      })

      // 1. Watchdog Ownership Red Line: helmx-owned caller MUST get 403 ownership_violation for all 7 mutations on human target.
      const mutationPayloads: Array<[string, Record<string, unknown>]> = [
        ['update', { conversationId: humanTarget.id, title: 'hijack' }],
        ['send', { conversationId: humanTarget.id, text: 'inject' }],
        ['withdraw', { conversationId: humanTarget.id, submissionId: 1 }],
        ['abort', { conversationId: humanTarget.id }],
        ['reset', { conversationId: humanTarget.id }],
        ['compact', { conversationId: humanTarget.id }],
        ['delete', { conversationId: humanTarget.id }],
      ]
      for (const [actionId, payload] of mutationPayloads) {
        const res = await postCoreAction(kernel, 'conversations', actionId, payload, helmxCaller.id)
        assert.equal(res.status, 403, `helmx -> human core:conversations.${actionId} must return 403`)
        assert.equal(res.code, 'ownership_violation', `helmx -> human core:conversations.${actionId} must return ownership_violation`)
      }

      // Cascading delete through a helmx parent that has a human-owned descendant must also fail with 403 ownership_violation.
      const cascadeBlocked = await postCoreAction(
        kernel,
        'conversations',
        'delete',
        { conversationId: helmxParentWithHumanChild.id },
        helmxCaller.id,
      )
      assert.equal(cascadeBlocked.status, 403)
      assert.equal(cascadeBlocked.code, 'ownership_violation')

      // Read-only actions from helmx caller against human target MUST still succeed.
      const readHuman = await postCoreAction(
        kernel,
        'conversations',
        'get',
        { conversationId: humanTarget.id },
        helmxCaller.id,
      )
      assert.equal(readHuman.status, 200)

      // helmx caller mutating another helmx target MUST succeed.
      const mutateHelmx = await postCoreAction(
        kernel,
        'conversations',
        'update',
        { conversationId: helmxTarget.id, title: 'Helmx Updated' },
        helmxCaller.id,
      )
      assert.equal(mutateHelmx.status, 200)
      assert.equal(mutateHelmx.body.title, 'Helmx Updated')

      // 2. Self-Mutation Guard: abort/reset/delete targeting caller's own conversationId MUST return 409 self_mutation_forbidden.
      for (const callerId of [1, helmxCaller.id]) {
        for (const actionId of ['abort', 'reset', 'delete'] as const) {
          const selfRes = await postCoreAction(
            kernel,
            'conversations',
            actionId,
            { conversationId: callerId },
            callerId,
          )
          assert.equal(selfRes.status, 409, `self ${actionId} on #${callerId} must return 409`)
          assert.equal(selfRes.code, 'self_mutation_forbidden')
        }
      }

      // 3. Honest origin: core:conversations.send inside conversation context ALWAYS forces origin: 'agent'
      // even when caller passes origin: 'human' or 'trigger'.
      const observedOrigins: string[] = []
      await kernel.plugins.register({
        id: 'test:origin-spy',
        definePlugin: (ctx) => {
          ctx.hook.onInput((payload) => {
            observedOrigins.push(payload.input.origin)
          })
        },
      })
      kernel.__faux.setResponses([
        fauxAssistantMessage('ack 1'),
        fauxAssistantMessage('ack 2'),
        fauxAssistantMessage('ack 3'),
      ])

      const spoofHuman = await postCoreAction(
        kernel,
        'conversations',
        'send',
        { conversationId: helmxTarget.id, text: 'from session', origin: 'human', wait: true },
        1,
      )
      assert.equal(spoofHuman.status, 200)
      const spoofTrigger = await invokeRunActionTool(
        kernel,
        {
          actionId: 'core:conversations.send',
          input: { conversationId: helmxTarget.id, text: 'from run_action', origin: 'trigger', wait: true },
        },
        helmxCaller.id,
      )
      assert.equal(spoofTrigger.isError, undefined)
      // Direct HTTP without conversationId preserves explicit caller origin ('trigger').
      const directHttp = await postCoreAction(kernel, 'conversations', 'send', {
        conversationId: helmxTarget.id,
        text: 'from direct http',
        origin: 'trigger',
        wait: true,
      })
      assert.equal(directHttp.status, 200)
      assert.deepEqual(observedOrigins, ['agent', 'agent', 'trigger'])
    } finally {
      await kernel.close()
    }
  })

  it('core:profiles, core:models, core:nodes, core:plugins, core:asks, and core:skills end-to-end + secret/scope enforcement', { timeout: 60_000 }, async () => {
    const dir = join(root, 'all-domains')
    const kernel = await openRuntime(dir)
    try {
      // ---- core:profiles ----
      const createdProfile = await postCoreAction(kernel, 'profiles', 'create', {
        id: 'reviewer',
        name: 'Reviewer',
        cwd: dir,
        restrictToCwd: true,
        system: 'You review code carefully.',
      })
      assert.equal(createdProfile.status, 200)
      assert.equal(createdProfile.body.id, 'reviewer')
      assert.equal(createdProfile.body.restrictToCwd, true)
      assert.equal(createdProfile.body.system, 'You review code carefully.')

      // Reject managedByPlugin spoofing on create.
      const spoofManaged = await postCoreAction(kernel, 'profiles', 'create', {
        id: 'spoofed',
        managedByPlugin: 'builtin:profile',
      })
      assert.equal(spoofManaged.status, 403)
      assert.equal(spoofManaged.code, 'profile_managed_by_plugin')

      // Partial update preserves untouched fields (cwd, restrictToCwd, system).
      const updatedProfile = await postCoreAction(kernel, 'profiles', 'update', {
        id: 'reviewer',
        name: 'Senior Reviewer',
      })
      assert.equal(updatedProfile.status, 200)
      assert.equal(updatedProfile.body.name, 'Senior Reviewer')
      assert.equal(updatedProfile.body.cwd, dir)
      assert.equal(updatedProfile.body.restrictToCwd, true)
      assert.equal(updatedProfile.body.system, 'You review code carefully.')

      // Plugin-managed profile preserves managedByPlugin on update, rejects modifying it, and blocks delete.
      await kernel.profiles.save({
        id: 'managed-role',
        name: 'Managed',
        managedByPlugin: 'builtin:demo',
      })
      const keepManaged = await postCoreAction(kernel, 'profiles', 'update', {
        id: 'managed-role',
        name: 'Managed Renamed',
      })
      assert.equal(keepManaged.status, 200)
      assert.equal(keepManaged.body.managedByPlugin, 'builtin:demo')

      const tamperManaged = await postCoreAction(kernel, 'profiles', 'update', {
        id: 'managed-role',
        managedByPlugin: 'other:plugin',
      })
      assert.equal(tamperManaged.status, 403)
      assert.equal(tamperManaged.code, 'profile_managed_by_plugin')

      const deleteManaged = await postCoreAction(kernel, 'profiles', 'delete', { id: 'managed-role' })
      assert.equal(deleteManaged.status, 403)
      assert.equal(deleteManaged.code, 'profile_managed_by_plugin')

      const profileList = await postCoreAction(kernel, 'profiles', 'list', {})
      assert.equal(profileList.status, 200)
      assert.ok((profileList.body as Array<{ id: string }>).some((p) => p.id === 'reviewer'))

      const profileGet = await postCoreAction(kernel, 'profiles', 'get', { id: 'reviewer' })
      assert.equal(profileGet.status, 200)
      assert.equal(profileGet.body.name, 'Senior Reviewer')

      const deleteProfile = await postCoreAction(kernel, 'profiles', 'delete', { id: 'reviewer' })
      assert.equal(deleteProfile.status, 200)
      assert.deepEqual(deleteProfile.body, { ok: true })

      // ---- core:models ----
      const secretApiKey = 'sk-super-secret-provider-key-9999'
      await kernel.credentials.set('openai', secretApiKey)
      kernel.stash.addRedaction(secretApiKey)

      const modelsList = await postCoreAction(kernel, 'models', 'list', {})
      assert.equal(modelsList.status, 200)
      assert.ok(Array.isArray(modelsList.body.models))

      const providersRes = await postCoreAction(kernel, 'models', 'providers', {})
      assert.equal(providersRes.status, 200)
      assert.ok(Array.isArray(providersRes.body))
      assert.equal(JSON.stringify(providersRes.body).includes(secretApiKey), false)

      const setDefault = await postCoreAction(kernel, 'models', 'default', {
        model: 'faux/faux-1',
        thinkingLevel: 'low',
      })
      assert.equal(setDefault.status, 200)
      assert.equal(setDefault.body.ok, true)
      assert.equal(setDefault.body.defaultModel, 'faux/faux-1')
      assert.equal(setDefault.body.defaultThinkingLevel, 'low')

      const setFilter = await postCoreAction(kernel, 'models', 'filter', {
        provider: 'faux',
        disabledModels: ['faux-2'],
      })
      assert.equal(setFilter.status, 200)
      assert.equal(setFilter.body.ok, true)

      const clearFilter = await postCoreAction(kernel, 'models', 'filter', {
        provider: 'faux',
        disabledModels: [],
      })
      assert.equal(clearFilter.status, 200)

      // External test Models rejects refresh with 400 runtime_provider_unsupported (real ModelRegistry dispatch).
      const refreshRes = await postCoreAction(kernel, 'models', 'refresh', { force: true })
      assert.equal(refreshRes.status, 400)
      assert.equal(refreshRes.code, 'runtime_provider_unsupported')

      // ---- core:nodes + host-governance scope ----
      const subagentConv = await kernel.conversations.createConversation({
        title: 'subagent',
        parentConversationId: 1,
        ownedBy: 'human',
      })
      const helmxConv = await kernel.conversations.createConversation({
        title: 'bg-helmx',
        ownedBy: 'helmx',
      })

      const nodesList = await postCoreAction(kernel, 'nodes', 'list', {})
      assert.equal(nodesList.status, 200)
      assert.ok((nodesList.body as Array<{ id: string }>).some((n) => n.id === 'local'))

      const forwardsList = await postCoreAction(kernel, 'nodes', 'forwards', {})
      assert.equal(forwardsList.status, 200)
      assert.deepEqual(forwardsList.body, [])

      const forwardInspectMissing = await postCoreAction(kernel, 'nodes', 'forward_inspect', {
        id: 'fwd-11111111-2222-3333-4444-555555555555',
      })
      assert.equal(forwardInspectMissing.status, 404)

      // upgrade_check defaults to current conversation's nodeId ('local') when omitted -> 400 cannot_upgrade_local.
      const upgradeCheckLocal = await postCoreAction(kernel, 'nodes', 'upgrade_check', {}, 1)
      assert.equal(upgradeCheckLocal.status, 400)
      assert.equal(upgradeCheckLocal.code, 'cannot_upgrade_local')

      for (const blockedConvId of [subagentConv.id, helmxConv.id]) {
        for (const [actionId, payload] of [
          ['remove', { id: 'node-1' }],
          ['upgrade', { id: 'node-1' }],
          ['forward_stop', { id: 'fwd-11111111-2222-3333-4444-555555555555' }],
        ] as const) {
          const res = await postCoreAction(kernel, 'nodes', actionId, payload, blockedConvId)
          assert.equal(res.status, 403, `core:nodes.${actionId} must be rejected for conv #${blockedConvId}`)
          assert.equal(res.code, 'conversation_scope_violation')
        }
      }

      // ---- core:plugins + secret masking + host-governance scope ----
      const secretCfgValue = 'plugin-secret-token-xyz-789'
      await kernel.plugins.register({
        id: 'test:secret-cfg',
        name: 'Secret Config Test',
        definePlugin: (ctx) => {
          ctx.configSchema({
            apiToken: { type: 'string', secret: true },
            mode: { type: 'string', default: 'standard' },
          })
          ctx.doc('status', { ready: true }, { public: true })
        },
      })
      await kernel.plugins.setConfig('test:secret-cfg', { apiToken: secretCfgValue, mode: 'fast' })

      const cfgGet = await postCoreAction(kernel, 'plugins', 'config_get', { id: 'test:secret-cfg' }, 1)
      assert.equal(cfgGet.status, 200)
      assert.equal(cfgGet.body.values.apiToken, '******', 'secret config field must be masked')
      assert.equal(cfgGet.body.values.mode, 'fast')
      assert.equal(JSON.stringify(cfgGet.body).includes(secretCfgValue), false)

      const pluginDoc = await postCoreAction(
        kernel,
        'plugins',
        'doc',
        { pluginId: 'test:secret-cfg', name: 'status' },
        1,
      )
      assert.equal(pluginDoc.status, 200)
      assert.deepEqual(pluginDoc.body.value, { ready: true })

      const pluginManifest = await postCoreAction(kernel, 'plugins', 'manifest', { id: 'test:secret-cfg' }, 1)
      assert.equal(pluginManifest.status, 200)
      assert.equal(pluginManifest.body.id, 'test:secret-cfg')

      const allManifests = await postCoreAction(kernel, 'plugins', 'manifest', {}, 1)
      assert.equal(allManifests.status, 200)
      assert.ok(Array.isArray(allManifests.body))
      assert.equal((allManifests.body as Array<{ id: string }>).some((m) => m.id.startsWith('core:')), false)

      const pluginList = await postCoreAction(kernel, 'plugins', 'list', {}, 1)
      assert.equal(pluginList.status, 200)
      assert.ok((pluginList.body as Array<{ id: string }>).some((p) => p.id === 'test:secret-cfg'))
      assert.equal((pluginList.body as Array<{ id: string }>).some((p) => p.id.startsWith('core:')), false)

      // core:plugins.doctor validates relative path with assertDoctorTargetDir -> 400 validation_error.
      const doctorBadPath = await postCoreAction(kernel, 'plugins', 'doctor', { target: './relative-dir' }, 1)
      assert.equal(doctorBadPath.status, 400)
      assert.equal(doctorBadPath.code, 'validation_error')

      // Host-governance plugin mutations blocked from subagent & helmx sessions, allowed from top-level human #1.
      for (const blockedConvId of [subagentConv.id, helmxConv.id]) {
        for (const [actionId, payload] of [
          ['config_set', { id: 'test:secret-cfg', values: { mode: 'x' } }],
          ['disable', { id: 'test:secret-cfg' }],
          ['enable', { id: 'test:secret-cfg' }],
          ['reload', { id: 'test:secret-cfg' }],
          ['rescan', {}],
        ] as const) {
          const res = await postCoreAction(kernel, 'plugins', actionId, payload, blockedConvId)
          assert.equal(res.status, 403, `core:plugins.${actionId} must be rejected for conv #${blockedConvId}`)
          assert.equal(res.code, 'conversation_scope_violation')
        }
      }

      const cfgSetOk = await postCoreAction(
        kernel,
        'plugins',
        'config_set',
        { id: 'test:secret-cfg', values: { mode: 'turbo' } },
        1,
      )
      assert.equal(cfgSetOk.status, 200)
      assert.equal(kernel.plugins.getConfig('test:secret-cfg').mode, 'turbo')

      const disableOk = await postCoreAction(kernel, 'plugins', 'disable', { id: 'test:secret-cfg' }, 1)
      assert.equal(disableOk.status, 200)
      assert.equal(kernel.plugins.get('test:secret-cfg')?.enabled, false)

      const enableOk = await postCoreAction(kernel, 'plugins', 'enable', { id: 'test:secret-cfg' }, 1)
      assert.equal(enableOk.status, 200)
      assert.equal(kernel.plugins.get('test:secret-cfg')?.enabled, true)

      const rescanOk = await postCoreAction(kernel, 'plugins', 'rescan', {}, 1)
      assert.equal(rescanOk.status, 200)
      assert.ok(Array.isArray(rescanOk.body.registered))

      // ---- core:asks ----
      const askPromise1 = kernel.asks.createAsk({
        id: 'ask-answer-test',
        conversationId: 1,
        title: 'Approve action?',
        fields: [{ name: 'ok', label: 'Confirm', type: 'confirm', required: true }],
      })
      const askPromise2 = kernel.asks.createAsk({
        id: 'ask-cancel-test',
        conversationId: 1,
        title: 'Cancel me?',
        fields: [{ name: 'note', label: 'Note', type: 'text' }],
      })
      await waitFor(() => kernel.asks.listAsks('pending').length >= 2)

      const asksList = await postCoreAction(kernel, 'asks', 'list', { conversationId: 1, status: 'pending' }, 1)
      assert.equal(asksList.status, 200)
      assert.equal(asksList.body.length, 2)

      const httpPending1 = await apiCall(kernel, 'GET', '/api/asks?conversationId=1&status=pending')
      assert.equal(httpPending1.status, 200)
      assert.deepEqual(
        (httpPending1.body as Array<{ id: string }>).map((a) => a.id),
        ['ask-answer-test', 'ask-cancel-test'],
      )
      const httpOtherConv = await apiCall(kernel, 'GET', `/api/asks?conversationId=${subagentConv.id}&status=pending`)
      assert.equal(httpOtherConv.status, 200)
      assert.deepEqual(httpOtherConv.body, [])

      // core:asks.answer MUST be rejected from ANY conversation context (even top-level human #1!).
      const answerFromSession = await postCoreAction(
        kernel,
        'asks',
        'answer',
        { id: 'ask-answer-test', answers: { ok: 'yes' } },
        1,
      )
      assert.equal(answerFromSession.status, 403)
      assert.equal(answerFromSession.code, 'conversation_scope_violation')

      const answerFromTool = await invokeRunActionTool(
        kernel,
        { actionId: 'core:asks.answer', input: { id: 'ask-answer-test', answers: { ok: 'yes' } } },
        1,
      )
      assert.equal(answerFromTool.isError, true)

      // Direct HTTP without conversationId succeeds.
      const answerDirect = await postCoreAction(kernel, 'asks', 'answer', {
        id: 'ask-answer-test',
        answers: { ok: 'true' },
      })
      assert.equal(answerDirect.status, 200)
      const ask1Result = await askPromise1
      assert.equal(ask1Result.status, 'answered')
      assert.equal(ask1Result.answers.ok, 'true')

      // core:asks.cancel blocked from subagent/helmx sessions, allowed from top-level human #1.
      for (const blockedConvId of [subagentConv.id, helmxConv.id]) {
        const cancelBlocked = await postCoreAction(
          kernel,
          'asks',
          'cancel',
          { id: 'ask-cancel-test' },
          blockedConvId,
        )
        assert.equal(cancelBlocked.status, 403)
        assert.equal(cancelBlocked.code, 'conversation_scope_violation')
      }
      const cancelOk = await postCoreAction(kernel, 'asks', 'cancel', { id: 'ask-cancel-test' }, 1)
      assert.equal(cancelOk.status, 200)
      const ask2Result = await askPromise2
      assert.equal(ask2Result.status, 'cancelled')

      const httpAnswered = await apiCall(kernel, 'GET', '/api/asks?conversationId=1&status=answered')
      assert.equal(httpAnswered.status, 200)
      assert.deepEqual(
        (httpAnswered.body as Array<{ id: string }>).map((a) => a.id),
        ['ask-answer-test'],
      )
      const httpCancelled = await apiCall(kernel, 'GET', '/api/asks?status=cancelled')
      assert.equal(httpCancelled.status, 200)
      assert.deepEqual(
        (httpCancelled.body as Array<{ id: string }>).map((a) => a.id),
        ['ask-cancel-test'],
      )

      // ---- core:skills ----
      const skillDir = join(dir, 'skills', 'demo-skill')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        '---\nname: demo-skill\ndescription: Demo skill\n---\n# Demo\nHello skill.',
      )

      // Blocked from ANY conversation context (even top-level human #1).
      for (const [actionId, payload] of [
        ['list', {}],
        ['read', { id: 'demo-skill' }],
      ] as const) {
        const blocked = await postCoreAction(kernel, 'skills', actionId, payload, 1)
        assert.equal(blocked.status, 403, `core:skills.${actionId} must be rejected in session context`)
        assert.equal(blocked.code, 'conversation_scope_violation')
      }

      // Allowed from direct HTTP (no conversationId); path traversal rejected.
      const skillsList = await postCoreAction(kernel, 'skills', 'list', {})
      assert.equal(skillsList.status, 200)
      assert.ok((skillsList.body as Array<{ id: string }>).some((s) => s.id === 'demo-skill'))

      const skillRead = await postCoreAction(kernel, 'skills', 'read', { id: 'demo-skill' })
      assert.equal(skillRead.status, 200)
      assert.match(skillRead.body.text, /Hello skill/)

      const skillTraversal = await postCoreAction(kernel, 'skills', 'read', {
        id: 'demo-skill',
        path: '../escape.txt',
      })
      assert.equal(skillTraversal.status, 400)
      assert.equal(skillTraversal.code, 'path_traversal')
    } finally {
      await kernel.close()
    }
  })

  it('enforces guarded CAS APIs (expectedOwnership + expectedStateSeq) on automated core:conversations.send/abort and closes ownership flip TOCTOU races', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'conv-guarded-cas'))
    try {
      const helmxCaller = await kernel.conversations.createConversation({
        title: 'Helmx Automated Caller',
        ownedBy: 'helmx',
      })
      const sendRaceTarget = await kernel.conversations.createConversation({
        title: 'Send Race Target',
        ownedBy: 'helmx',
      })
      const abortRaceTarget = await kernel.conversations.createConversation({
        title: 'Abort Race Target',
        ownedBy: 'helmx',
      })
      const casTarget = await kernel.conversations.createConversation({
        title: 'CAS Watermark Target',
        ownedBy: 'helmx',
      })

      // 1. Deterministic TOCTOU race on core:conversations.send:
      // Pause inside onInput hook, flip target ownership to 'human', release -> submitInputGuarded
      // must atomically reject with 409 ownership_conflict without delivering the message.
      let enteredHook!: () => void
      const hookEntered = new Promise<void>((resolve) => {
        enteredHook = resolve
      })
      let releaseHook!: () => void
      const hookGate = new Promise<void>((resolve) => {
        releaseHook = resolve
      })
      await kernel.plugins.register({
        id: 'test:send-race-barrier',
        definePlugin: (ctx) => {
          ctx.hook.onInput(async (payload) => {
            if (payload.conversationId === sendRaceTarget.id) {
              enteredHook()
              await hookGate
            }
          })
        },
      })

      const sendRacePromise = postCoreAction(
        kernel,
        'conversations',
        'send',
        { conversationId: sendRaceTarget.id, text: 'race payload' },
        helmxCaller.id,
      )
      await hookEntered
      kernel.ownership.markOwnership(sendRaceTarget.id, 'human')
      releaseHook()

      const sendRaceRes = await sendRacePromise
      assert.equal(sendRaceRes.status, 409)
      assert.equal(sendRaceRes.code, 'ownership_conflict')
      const sendDetail = await kernel.conversations.getConversationDetail(sendRaceTarget.id)
      assert.equal(
        sendDetail.entries.some((e) => JSON.stringify(e).includes('race payload')),
        false,
        'rejected guarded send must not persist message',
      )

      // 2. Deterministic TOCTOU race on core:conversations.abort:
      // Pause at harness.conversation await point, flip target ownership to 'human', release ->
      // abortConversationGuarded must atomically reject with 409 ownership_conflict.
      type ConversationFn = (id: never, ctx: unknown) => Promise<unknown>
      const harness = (kernel as unknown as { harness: { conversation: ConversationFn } }).harness
      const realConversation = harness.conversation.bind(harness) as ConversationFn
      let abortLookupEntered!: () => void
      const abortLookupPromise = new Promise<void>((resolve) => {
        abortLookupEntered = resolve
      })
      let releaseAbortLookup!: () => void
      const abortLookupGate = new Promise<void>((resolve) => {
        releaseAbortLookup = resolve
      })
      let interceptOnce = true
      harness.conversation = async (id, ctx) => {
        const conv = await realConversation(id, ctx)
        if (interceptOnce && (id as unknown as number) === abortRaceTarget.id) {
          interceptOnce = false
          abortLookupEntered()
          await abortLookupGate
        }
        return conv
      }

      const abortRacePromise = postCoreAction(
        kernel,
        'conversations',
        'abort',
        { conversationId: abortRaceTarget.id },
        helmxCaller.id,
      )
      await abortLookupPromise
      kernel.ownership.markOwnership(abortRaceTarget.id, 'human')
      releaseAbortLookup()
      harness.conversation = realConversation

      const abortRaceRes = await abortRacePromise
      assert.equal(abortRaceRes.status, 409)
      assert.equal(abortRaceRes.code, 'ownership_conflict')

      // 3. Stale expectedStateSeq rejects with 409 state_seq_conflict; exact expectedStateSeq succeeds;
      // automated send rejects history rewrite (replaceFromEntryId).
      const currentSeq = kernel.conversations.getConversation(casTarget.id).stateChangeSeq
      const staleSend = await postCoreAction(
        kernel,
        'conversations',
        'send',
        { conversationId: casTarget.id, text: 'stale', expectedStateSeq: currentSeq + 99 },
        helmxCaller.id,
      )
      assert.equal(staleSend.status, 409)
      assert.equal(staleSend.code, 'state_seq_conflict')

      const staleAbort = await postCoreAction(
        kernel,
        'conversations',
        'abort',
        { conversationId: casTarget.id, expectedStateSeq: currentSeq + 99 },
        helmxCaller.id,
      )
      assert.equal(staleAbort.status, 409)
      assert.equal(staleAbort.code, 'state_seq_conflict')

      const rewriteBlocked = await postCoreAction(
        kernel,
        'conversations',
        'send',
        { conversationId: casTarget.id, text: 'rewrite attempt', replaceFromEntryId: 1 },
        helmxCaller.id,
      )
      assert.equal(rewriteBlocked.status, 400)
      assert.equal(rewriteBlocked.code, 'validation_error')

      kernel.__faux.setResponses([fauxAssistantMessage('cas accepted')])
      const okSend = await postCoreAction(
        kernel,
        'conversations',
        'send',
        { conversationId: casTarget.id, text: 'fresh cas', expectedStateSeq: currentSeq, wait: true },
        helmxCaller.id,
      )
      assert.equal(okSend.status, 200)
      assert.match(okSend.body.text, /cas accepted/)

      const nextSeq = kernel.conversations.getConversation(casTarget.id).stateChangeSeq
      assert.ok(nextSeq > currentSeq)
      const okAbort = await postCoreAction(
        kernel,
        'conversations',
        'abort',
        { conversationId: casTarget.id, expectedStateSeq: nextSeq },
        helmxCaller.id,
      )
      assert.equal(okAbort.status, 200)
      assert.deepEqual(okAbort.body, { ok: true })

      // Direct HTTP explicit expectedStateSeq also enforces CAS honestly.
      const httpStaleAbort = await postCoreAction(kernel, 'conversations', 'abort', {
        conversationId: casTarget.id,
        expectedStateSeq: currentSeq,
      })
      assert.equal(httpStaleAbort.status, 409)
      assert.equal(httpStaleAbort.code, 'state_seq_conflict')
    } finally {
      await kernel.close()
    }
  })

  it('enforces automation ownership on core:conversations.create and core:conversations.fork (never defaulting automated sessions to human)', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'conv-create-fork-ownership'))
    try {
      const helmxCaller = await kernel.conversations.createConversation({
        title: 'Helmx Caller',
        ownedBy: 'helmx',
      })
      const humanSource = await kernel.conversations.createConversation({
        title: 'Human Source',
        ownedBy: 'human',
      })
      const helmxSource = await kernel.conversations.createConversation({
        title: 'Helmx Source',
        ownedBy: 'helmx',
      })

      kernel.__faux.setResponses([
        fauxAssistantMessage('human history'),
        fauxAssistantMessage('helmx history'),
      ])
      await kernel.conversations.submitInput(humanSource.id, 'seed human')
      await kernel.conversations.waitForIdle(humanSource.id)
      await kernel.conversations.submitInput(helmxSource.id, 'seed helmx')
      await kernel.conversations.waitForIdle(helmxSource.id)

      // 1. helmx-owned caller creating a conversation MUST default to ownedBy: 'helmx' (never 'human'),
      // and explicitly requesting ownedBy: 'human' MUST fail with 403 ownership_violation.
      const autoCreated = await postCoreAction(
        kernel,
        'conversations',
        'create',
        { title: 'Auto Created' },
        helmxCaller.id,
      )
      assert.equal(autoCreated.status, 200)
      assert.equal(autoCreated.body.ownedBy, 'helmx')
      assert.equal(kernel.ownership.getOwnership(autoCreated.body.id), 'helmx')

      const autoCreateHumanSpoof = await postCoreAction(
        kernel,
        'conversations',
        'create',
        { title: 'Spoof Human', ownedBy: 'human' },
        helmxCaller.id,
      )
      assert.equal(autoCreateHumanSpoof.status, 403)
      assert.equal(autoCreateHumanSpoof.code, 'ownership_violation')

      // Creating a child under a helmx parent inherits 'helmx' even from direct HTTP.
      const underHelmxParent = await postCoreAction(kernel, 'conversations', 'create', {
        title: 'Child Under Helmx',
        parentConversationId: helmxSource.id,
      })
      assert.equal(underHelmxParent.status, 200)
      assert.equal(underHelmxParent.body.ownedBy, 'helmx')
      assert.equal(kernel.ownership.getOwnership(underHelmxParent.body.id), 'helmx')

      // Direct HTTP explicit ownedBy: 'helmx' succeeds.
      const explicitHelmxCreate = await postCoreAction(kernel, 'conversations', 'create', {
        title: 'Explicit Helmx',
        ownedBy: 'helmx',
      })
      assert.equal(explicitHelmxCreate.status, 200)
      assert.equal(explicitHelmxCreate.body.ownedBy, 'helmx')
      assert.equal(kernel.ownership.getOwnership(explicitHelmxCreate.body.id), 'helmx')

      // 2. helmx-owned caller forking a human-owned or helmx-owned source MUST produce ownedBy: 'helmx',
      // and explicitly requesting ownedBy: 'human' MUST fail with 403 ownership_violation.
      const autoForkFromHuman = await postCoreAction(
        kernel,
        'conversations',
        'fork',
        { conversationId: humanSource.id, title: 'Auto Fork From Human' },
        helmxCaller.id,
      )
      assert.equal(autoForkFromHuman.status, 200)
      assert.equal(autoForkFromHuman.body.ownedBy, 'helmx')
      assert.equal(kernel.ownership.getOwnership(autoForkFromHuman.body.id), 'helmx')

      const autoForkSpoofHuman = await postCoreAction(
        kernel,
        'conversations',
        'fork',
        { conversationId: humanSource.id, title: 'Spoof Fork', ownedBy: 'human' },
        helmxCaller.id,
      )
      assert.equal(autoForkSpoofHuman.status, 403)
      assert.equal(autoForkSpoofHuman.code, 'ownership_violation')

      // Direct HTTP fork inherits source ownership: helmx -> helmx, human -> human (overridable to helmx).
      const inheritedHelmxFork = await postCoreAction(kernel, 'conversations', 'fork', {
        conversationId: helmxSource.id,
        title: 'Inherited Helmx Fork',
      })
      assert.equal(inheritedHelmxFork.status, 200)
      assert.equal(inheritedHelmxFork.body.ownedBy, 'helmx')
      assert.equal(kernel.ownership.getOwnership(inheritedHelmxFork.body.id), 'helmx')

      const inheritedHumanFork = await postCoreAction(kernel, 'conversations', 'fork', {
        conversationId: humanSource.id,
        title: 'Inherited Human Fork',
      })
      assert.equal(inheritedHumanFork.status, 200)
      assert.equal(inheritedHumanFork.body.ownedBy, 'human')
      assert.equal(kernel.ownership.getOwnership(inheritedHumanFork.body.id), 'human')

      const explicitHelmxFork = await postCoreAction(kernel, 'conversations', 'fork', {
        conversationId: humanSource.id,
        title: 'Explicit Helmx Fork',
        ownedBy: 'helmx',
      })
      assert.equal(explicitHelmxFork.status, 200)
      assert.equal(explicitHelmxFork.body.ownedBy, 'helmx')
      assert.equal(kernel.ownership.getOwnership(explicitHelmxFork.body.id), 'helmx')
    } finally {
      await kernel.close()
    }
  })

  it('closes human-ownership races across all automated core:conversations mutations and enforces create/fork ownership', { timeout: 60_000 }, async () => {
    const dir = join(root, 'conv-guarded-races')
    const kernel = await openRuntime(dir)
    const harness = (kernel as unknown as {
      harness: {
        conversation: (id: never, ctx: unknown) => Promise<unknown>
        submission: (id: never, ctx: unknown) => Promise<unknown>
      }
    }).harness
    const realConversation = harness.conversation.bind(harness)
    const realSubmission = harness.submission.bind(harness)
    let pendingRelease: (() => void) | undefined
    const pauseNextConversationLookup = (): { release: () => void } => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      pendingRelease = release
      let armed = true
      harness.conversation = (id: never, ctx: unknown) => {
        if (!armed) return realConversation(id, ctx)
        armed = false
        return new Promise((resolve, reject) => {
          void gate.then(() => {
            void realConversation(id, ctx).then(resolve, reject)
          }, reject)
        })
      }
      return {
        release: () => {
          harness.conversation = realConversation
          release()
        },
      }
    }
    const flushTick = () => new Promise((resolve) => setImmediate(resolve))

    try {
      const helmxCaller = await kernel.conversations.createConversation({
        title: 'Helmx Automation Caller',
        ownedBy: 'helmx',
      })

      // 1. Create / fork ownership enforcement for automated helmx callers vs human/direct callers.
      const autoCreated = await postCoreAction(
        kernel,
        'conversations',
        'create',
        { title: 'Auto Created Scratch' },
        helmxCaller.id,
      )
      assert.equal(autoCreated.status, 200)
      assert.equal(autoCreated.body.ownedBy, 'helmx', 'helmx caller create must default to ownedBy=helmx, never human')
      assert.equal(kernel.ownership.getOwnership(autoCreated.body.id), 'helmx')

      // Automated caller can immediately mutate the conversation it created.
      const autoUpdateSelfCreated = await postCoreAction(
        kernel,
        'conversations',
        'update',
        { conversationId: autoCreated.body.id, title: 'Auto Created Renamed' },
        helmxCaller.id,
      )
      assert.equal(autoUpdateSelfCreated.status, 200)
      assert.equal(autoUpdateSelfCreated.body.title, 'Auto Created Renamed')
      assert.equal(autoUpdateSelfCreated.body.ownedBy, 'helmx')

      // Automated caller attempting explicit ownedBy='human' on create -> 403 ownership_violation.
      const autoCreateHumanForbidden = await postCoreAction(
        kernel,
        'conversations',
        'create',
        { title: 'Spoofed Human', ownedBy: 'human' },
        helmxCaller.id,
      )
      assert.equal(autoCreateHumanForbidden.status, 403)
      assert.equal(autoCreateHumanForbidden.code, 'ownership_violation')

      // Direct HTTP create under helmx parent inherits 'helmx'; explicit 'human' overrides.
      const directChildInherited = await postCoreAction(kernel, 'conversations', 'create', {
        title: 'Child Inherited',
        parentConversationId: helmxCaller.id,
      })
      assert.equal(directChildInherited.status, 200)
      assert.equal(directChildInherited.body.ownedBy, 'helmx')

      const directChildExplicitHuman = await postCoreAction(kernel, 'conversations', 'create', {
        title: 'Child Explicit Human',
        parentConversationId: helmxCaller.id,
        ownedBy: 'human',
      })
      assert.equal(directChildExplicitHuman.status, 200)
      assert.equal(directChildExplicitHuman.body.ownedBy, 'human')

      // Seed a human-owned conversation with a completed turn so it can be forked.
      const humanSeed = await kernel.conversations.createConversation({
        title: 'Human Source',
        ownedBy: 'human',
      })
      kernel.__faux.setResponses([fauxAssistantMessage('human seed reply')])
      await kernel.conversations.submitInput(humanSeed.id, 'seed question')
      await kernel.conversations.waitForIdle(humanSeed.id)

      // Automated caller forking a human conversation always produces ownedBy='helmx' and rejects explicit 'human'.
      const autoForkOfHuman = await postCoreAction(
        kernel,
        'conversations',
        'fork',
        { conversationId: humanSeed.id, title: 'Auto Experiment Fork' },
        helmxCaller.id,
      )
      assert.equal(autoForkOfHuman.status, 200)
      assert.equal(autoForkOfHuman.body.ownedBy, 'helmx', 'helmx caller fork must produce ownedBy=helmx')
      assert.equal(kernel.ownership.getOwnership(autoForkOfHuman.body.id), 'helmx')

      const autoForkHumanForbidden = await postCoreAction(
        kernel,
        'conversations',
        'fork',
        { conversationId: humanSeed.id, ownedBy: 'human' },
        helmxCaller.id,
      )
      assert.equal(autoForkHumanForbidden.status, 403)
      assert.equal(autoForkHumanForbidden.code, 'ownership_violation')

      // Direct HTTP fork inherits source ownership ('helmx' vs 'human') and honors explicit ownedBy override.
      const directForkOfHelmx = await postCoreAction(kernel, 'conversations', 'fork', {
        conversationId: autoForkOfHuman.body.id,
        title: 'Inherited Helmx Fork',
      })
      assert.equal(directForkOfHelmx.status, 200)
      assert.equal(directForkOfHelmx.body.ownedBy, 'helmx')

      const directForkPromoted = await postCoreAction(kernel, 'conversations', 'fork', {
        conversationId: autoForkOfHuman.body.id,
        title: 'Promoted Human Fork',
        ownedBy: 'human',
      })
      assert.equal(directForkPromoted.status, 200)
      assert.equal(directForkPromoted.body.ownedBy, 'human')

      // 2. Automated caller send rejects replaceFromEntryId via submitInputGuarded (400 validation_error).
      const autoRewriteBlocked = await postCoreAction(
        kernel,
        'conversations',
        'send',
        { conversationId: autoCreated.body.id, text: 'rewrite', replaceFromEntryId: 1 },
        helmxCaller.id,
      )
      assert.equal(autoRewriteBlocked.status, 400)
      assert.equal(autoRewriteBlocked.code, 'validation_error')

      // 3. Stale expectedStateSeq rejects with 409 state_seq_conflict on automated mutations.
      const seqNow = kernel.conversations.getConversation(autoCreated.body.id).stateChangeSeq
      for (const [actionId, payload] of [
        ['update', { conversationId: autoCreated.body.id, title: 'stale', expectedStateSeq: seqNow + 50 }],
        ['send', { conversationId: autoCreated.body.id, text: 'stale', expectedStateSeq: seqNow + 50 }],
        ['abort', { conversationId: autoCreated.body.id, expectedStateSeq: seqNow + 50 }],
        ['reset', { conversationId: autoCreated.body.id, expectedStateSeq: seqNow + 50 }],
        ['compact', { conversationId: autoCreated.body.id, expectedStateSeq: seqNow + 50 }],
        ['delete', { conversationId: autoCreated.body.id, expectedStateSeq: seqNow + 50 }],
      ] as const) {
        const staleRes = await postCoreAction(kernel, 'conversations', actionId, payload, helmxCaller.id)
        assert.equal(staleRes.status, 409, `stale expectedStateSeq on core:conversations.${actionId} must return 409`)
        assert.equal(staleRes.code, 'state_seq_conflict')
      }

      // 4. Deterministic mid-await human-ownership takeover race tests across send/abort/update/reset/compact/delete/withdraw.
      const raceOps: Array<{
        name: string
        actionId: string
        buildPayload: (convId: number) => Record<string, unknown>
        verifyUntouched: (convId: number, seqBefore: number) => Promise<void> | void
      }> = [
        {
          name: 'send',
          actionId: 'send',
          buildPayload: (convId) => ({ conversationId: convId, text: 'race inject' }),
          verifyUntouched: async (convId) => {
            const detail = await kernel.conversations.getConversationDetail(convId, { limit: 20 })
            assert.equal(detail.entries.filter((e) => e.kind === 'helmx.input').length, 0)
            assert.equal(kernel.conversations.getConversation(convId).title, '')
          },
        },
        {
          name: 'update',
          actionId: 'update',
          buildPayload: (convId) => ({ conversationId: convId, title: 'race hijack' }),
          verifyUntouched: (convId, seqBefore) => {
            assert.equal(kernel.conversations.getConversation(convId).title, '')
            assert.equal(kernel.conversations.getConversation(convId).stateChangeSeq, seqBefore)
          },
        },
        {
          name: 'abort',
          actionId: 'abort',
          buildPayload: (convId) => ({ conversationId: convId }),
          verifyUntouched: (convId, seqBefore) => {
            assert.equal(kernel.conversations.getConversation(convId).stateChangeSeq, seqBefore)
          },
        },
        {
          name: 'reset',
          actionId: 'reset',
          buildPayload: (convId) => ({ conversationId: convId, handoff: 'race wipe' }),
          verifyUntouched: (convId, seqBefore) => {
            assert.equal(kernel.conversations.getConversation(convId).stateChangeSeq, seqBefore)
          },
        },
        {
          name: 'compact',
          actionId: 'compact',
          buildPayload: (convId) => ({ conversationId: convId, instructions: 'race compact' }),
          verifyUntouched: (convId, seqBefore) => {
            assert.equal(kernel.conversations.getConversation(convId).stateChangeSeq, seqBefore)
          },
        },
        {
          name: 'delete',
          actionId: 'delete',
          buildPayload: (convId) => ({ conversationId: convId }),
          verifyUntouched: (convId) => {
            assert.equal(kernel.conversations.getConversation(convId).ownedBy, 'human')
          },
        },
      ]

      for (const op of raceOps) {
        const target = await kernel.conversations.createConversation({ ownedBy: 'helmx' })
        const seqBefore = target.stateChangeSeq
        const barrier = pauseNextConversationLookup()
        const promise = postCoreAction(
          kernel,
          'conversations',
          op.actionId,
          op.buildPayload(target.id),
          helmxCaller.id,
        )
        await flushTick()
        kernel.ownership.markOwnership(target.id, 'human')
        barrier.release()

        const res = await promise
        assert.equal(res.status, 409, `mid-await human takeover during core:conversations.${op.name} must return 409`)
        assert.equal(res.code, 'ownership_conflict', `core:conversations.${op.name} must fail with ownership_conflict`)
        await op.verifyUntouched(target.id, seqBefore)
      }

      // Deterministic race test for core:conversations.withdraw via harness.submission barrier.
      let releaseTurn!: () => void
      const turnGate = new Promise<void>((resolve) => {
        releaseTurn = resolve
      })
      const withdrawTarget = await kernel.conversations.createConversation({
        title: 'Withdraw Race Target',
        ownedBy: 'helmx',
      })
      kernel.__faux.setResponses([
        (async () => {
          await turnGate
          return fauxAssistantMessage('first turn ok')
        }) as never,
        fauxAssistantMessage('queued survives'),
      ])
      await kernel.conversations.submitInput(withdrawTarget.id, 'hold')
      await waitFor(() => kernel.conversations.getConversation(withdrawTarget.id).status === 'working')
      const queued = await kernel.conversations.submitInput(withdrawTarget.id, 'queued item', {
        whenBusy: 'followUp',
      })
      let releaseSub!: () => void
      const subGate = new Promise<void>((resolve) => {
        releaseSub = resolve
      })
      let subArmed = true
      harness.submission = (id: never, ctx: unknown) => {
        if (!subArmed) return realSubmission(id, ctx)
        subArmed = false
        return new Promise((resolve, reject) => {
          void subGate.then(() => {
            void realSubmission(id, ctx).then(resolve, reject)
          }, reject)
        })
      }
      try {
        const withdrawAttempt = postCoreAction(
          kernel,
          'conversations',
          'withdraw',
          { conversationId: withdrawTarget.id, submissionId: Number(queued.submissionId) },
          helmxCaller.id,
        )
        await flushTick()
        kernel.ownership.markOwnership(withdrawTarget.id, 'human')
        harness.submission = realSubmission
        releaseSub()

        const withdrawRes = await withdrawAttempt
        assert.equal(withdrawRes.status, 409)
        assert.equal(withdrawRes.code, 'ownership_conflict')
      } finally {
        harness.submission = realSubmission
        releaseSub()
        releaseTurn()
        await kernel.conversations.waitForIdle(withdrawTarget.id).catch(() => {})
      }
      assert.equal(await kernel.conversations.getLastAssistantText(withdrawTarget.id), 'queued survives')
    } finally {
      harness.conversation = realConversation
      harness.submission = realSubmission
      pendingRelease?.()
      await kernel.close()
    }
  })

  it('single-source domain parity between HTTP routes, core:* actions, and kernel services', { timeout: 60_000 }, async () => {
    const dir = join(root, 'domain-single-source-parity')
    const kernel = await openRuntime(dir)
    try {
      // 1. Profile CRUD single source: disabled-model 409 preflight, model clearing + alignment, and default lock 403.
      await kernel.models.setDisabledModels('faux', ['faux-2'])
      const httpDisabledCreate = await apiCall(kernel, 'POST', '/api/profiles', {
        id: 'blocked-http',
        model: 'faux/faux-2',
      })
      const actionDisabledCreate = await postCoreAction(kernel, 'profiles', 'create', {
        id: 'blocked-action',
        model: 'faux/faux-2',
      })
      assert.equal(httpDisabledCreate.status, 409)
      assert.equal(httpDisabledCreate.code, 'model_disabled')
      assert.equal(actionDisabledCreate.status, 409)
      assert.equal(actionDisabledCreate.code, 'model_disabled')

      // Create an unbound profile, bind a conversation, then update profile model -> bound conversation aligns.
      const createdProf = await postCoreAction(kernel, 'profiles', 'create', {
        id: 'align-role',
        name: 'Align Role',
        model: 'faux/faux-1',
      })
      assert.equal(createdProf.status, 200)
      const boundConv = await kernel.conversations.createConversation({
        title: 'Bound To Align Role',
        profileId: 'align-role',
      })
      assert.equal(boundConv.model, 'faux/faux-1')
      // Attempt patching to disabled model -> 409 model_disabled.
      const actionDisabledUpdate = await postCoreAction(kernel, 'profiles', 'update', {
        id: 'align-role',
        model: 'faux/faux-2',
      })
      assert.equal(actionDisabledUpdate.status, 409)
      assert.equal(actionDisabledUpdate.code, 'model_disabled')
      await kernel.models.setDisabledModels('faux', [])
      const switchedProf = await postCoreAction(kernel, 'profiles', 'update', {
        id: 'align-role',
        model: 'faux/faux-2',
      })
      assert.equal(switchedProf.status, 200)
      assert.equal(kernel.conversations.getConversation(boundConv.id).model, 'faux/faux-2')

      // Default `assistant` profile deletion returns structured 403 profile_default_locked when unbound.
      await kernel.conversations.updateConversation(1, { profileId: 'align-role' })
      const httpDelDefault = await apiCall(kernel, 'DELETE', '/api/profiles/assistant')
      const actionDelDefault = await postCoreAction(kernel, 'profiles', 'delete', { id: 'assistant' })
      assert.equal(httpDelDefault.status, 403)
      assert.equal(httpDelDefault.code, 'profile_default_locked')
      assert.equal(actionDelDefault.status, 403)
      assert.equal(actionDelDefault.code, 'profile_default_locked')

      // 2. Model defaults single source: cross-field validation & snapshot parity across HTTP, action, and ModelRegistry.
      for (const badBody of [
        { modelThinking: 'faux/faux-1' },
        { modelThinkingLevel: 'high' },
        {
          modelThinking: 'faux/faux-1',
          modelThinkingLevel: 'high',
          modelThinkingLevels: { 'faux/faux-1': 'low' },
        },
      ]) {
        const httpBad = await apiCall(kernel, 'PUT', '/api/models/default', badBody)
        const actionBad = await postCoreAction(kernel, 'models', 'default', badBody)
        assert.equal(httpBad.status, 400)
        assert.equal(httpBad.code, 'validation_error')
        assert.equal(actionBad.status, 400)
        assert.equal(actionBad.code, 'validation_error')
        await assert.rejects(
          () => kernel.models.updateDefaults(badBody),
          (err: unknown) => err instanceof HelmxError && err.status === 400 && err.code === 'validation_error',
        )
      }
      const actionSetDefaults = await postCoreAction(kernel, 'models', 'default', {
        model: 'faux/faux-1',
        modelThinking: 'faux/faux-1',
        modelThinkingLevel: 'medium',
      })
      assert.equal(actionSetDefaults.status, 200)
      const httpGetDefaults = await apiCall(kernel, 'GET', '/api/models/default')
      const actionGetDefaults = await postCoreAction(kernel, 'models', 'default_get', {})
      const directDefaults = await kernel.models.getDefaults()
      assert.equal(httpGetDefaults.status, 200)
      assert.equal(actionGetDefaults.status, 200)
      assert.deepEqual(httpGetDefaults.body, directDefaults)
      assert.deepEqual(actionGetDefaults.body, directDefaults)
      assert.equal(directDefaults.defaultModel, 'faux/faux-1')
      assert.equal(directDefaults.modelThinkingLevels['faux/faux-1'], 'medium')

      // 3. Plugin config redaction & doctor target resolution single source parity.
      const leakedCred = 'sk-embedded-in-note-secret-98765'
      kernel.stash.addRedaction(leakedCred)
      await kernel.plugins.register({
        id: 'test:parity-cfg',
        name: 'Parity Config Plugin',
        definePlugin: (ctx) => {
          ctx.configSchema({
            token: { type: 'string', secret: true },
            emptySecret: { type: 'string', secret: true, default: '' },
            unsetSecret: { type: 'string', secret: true },
            note: { type: 'string', default: '' },
          })
        },
      })
      await kernel.plugins.setConfig('test:parity-cfg', {
        token: 'super-secret-token',
        note: `ref ${leakedCred}`,
      })
      const httpCfg = await apiCall(kernel, 'GET', '/api/plugins/test%3Aparity-cfg/config')
      const actionCfg = await postCoreAction(kernel, 'plugins', 'config_get', { id: 'test:parity-cfg' })
      assert.equal(httpCfg.status, 200)
      assert.equal(actionCfg.status, 200)
      assert.deepEqual(httpCfg.body, actionCfg.body)
      assert.equal(httpCfg.body.values.token, '******')
      assert.equal(httpCfg.body.values.emptySecret, '')
      assert.equal(httpCfg.body.values.unsetSecret, undefined)
      assert.equal(httpCfg.body.sources.unsetSecret, 'unset')
      assert.equal(JSON.stringify(httpCfg.body).includes(leakedCred), false)

      for (const badDoctor of [
        {},
        { path: './relative-plugin' },
        { path: '/abs/plugin', id: 'test:parity-cfg' },
      ]) {
        const httpDoc = await apiCall(kernel, 'POST', '/api/plugins/doctor', badDoctor)
        const actionDoc = await postCoreAction(kernel, 'plugins', 'doctor', badDoctor)
        assert.equal(httpDoc.status, 400)
        assert.equal(httpDoc.code, 'validation_error')
        assert.equal(actionDoc.status, 400)
        assert.equal(actionDoc.code, 'validation_error')
      }

      // 4. Conversation search validation single source across HTTP, core:conversations.search, and ConversationService.
      for (const emptyQuery of ['', '   ', '\u0000']) {
        const httpEmpty = await apiCall(kernel, 'GET', `/api/search?q=${encodeURIComponent(emptyQuery)}`)
        assert.equal(httpEmpty.status, 400)
        assert.equal(httpEmpty.code, 'validation_error')
        await assert.rejects(
          () => kernel.conversations.search(emptyQuery),
          (err: unknown) => err instanceof HelmxError && err.status === 400 && err.code === 'validation_error',
        )
      }
      const actionNulSearch = await postCoreAction(kernel, 'conversations', 'search', { q: '\u0000' })
      assert.equal(actionNulSearch.status, 400)
      assert.equal(actionNulSearch.code, 'validation_error')

      // 5. core:conversations.get supports turns (1..50) and enforces limit + turns mutual exclusion in its JSON Schema and HTTP boundary.
      const getManifest = kernel.plugins
        .listActions()
        .find((m) => m.pluginId === 'core:conversations' && m.id === 'get')
      assert.ok(getManifest !== undefined)
      assertSchemaCompilable(getManifest.inputSchema)
      validateOrThrow(getManifest.inputSchema, { conversationId: 1 }, 'core:conversations.get')
      validateOrThrow(getManifest.inputSchema, { conversationId: 1, limit: 10 }, 'core:conversations.get')
      validateOrThrow(getManifest.inputSchema, { conversationId: 1, turns: 2 }, 'core:conversations.get')
      assert.throws(
        () => validateOrThrow(getManifest.inputSchema, { conversationId: 1, limit: 10, turns: 2 }, 'core:conversations.get'),
        (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
      )

      const getByTurns = await postCoreAction(kernel, 'conversations', 'get', {
        conversationId: 1,
        turns: 2,
      })
      assert.equal(getByTurns.status, 200)
      const getConflict = await postCoreAction(kernel, 'conversations', 'get', {
        conversationId: 1,
        limit: 10,
        turns: 2,
      })
      assert.equal(getConflict.status, 400)
      assert.equal(getConflict.code, 'validation_error')
    } finally {
      await kernel.close()
    }
  })

  it('core:conversations mutations keep their shared target request schema, registration order, CLI mapping, prompt hiding and output schemas', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'mutation-manifests'))
    try {
      const manifests = kernel.plugins.listActions().filter((m) => m.pluginId === 'core:conversations')
      assert.deepEqual(
        manifests.map((m) => m.id),
        ['search', 'list', 'get', 'entry', 'create', 'update', 'send', 'withdraw', 'abort', 'reset', 'compact', 'fork', 'delete'],
      )

      const safePositiveInt: JsonSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
      const safeNonNegativeInt: JsonSchema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
      const okOutput: JsonSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
      const objectOutput: JsonSchema = { type: 'object' }
      const expectations: Record<
        string,
        {
          cli: string[]
          outputSchema: JsonSchema
          /** Required request fields: the target id first, then the domain body's own required fields. */
          required: string[]
          /** Control properties declared between the target id and the CAS watermark. */
          controls?: Record<string, JsonSchema>
          /** Minimal valid body for the domain request (target fields added by the test). */
          body?: Record<string, unknown>
        }
      > = {
        update: { cli: ['conversations', 'update'], outputSchema: objectOutput, required: ['conversationId'] },
        send: {
          cli: ['send'],
          outputSchema: { type: 'object', properties: { submissionId: { type: 'string' } }, required: ['submissionId'] },
          required: ['conversationId', 'text'],
          controls: { wait: { type: 'boolean' } },
          body: { text: 'hello' },
        },
        withdraw: {
          cli: ['conversations', 'withdraw'],
          outputSchema: objectOutput,
          required: ['conversationId', 'submissionId'],
          body: { submissionId: 1 },
        },
        abort: { cli: ['abort'], outputSchema: okOutput, required: ['conversationId'] },
        reset: { cli: ['conversations', 'reset'], outputSchema: objectOutput, required: ['conversationId'] },
        compact: { cli: ['conversations', 'compact'], outputSchema: objectOutput, required: ['conversationId'] },
        delete: { cli: ['conversations', 'delete'], outputSchema: okOutput, required: ['conversationId'] },
      }
      for (const [actionId, expected] of Object.entries(expectations)) {
        const manifest = manifests.find((m) => m.id === actionId)
        assert.ok(manifest !== undefined, `core:conversations.${actionId} must be registered`)
        const label = `core:conversations.${actionId}`
        assert.equal(manifest.exposeToPrompt, false, `${label} must stay out of the prompt catalog`)
        assert.deepEqual(manifest.cli?.command, expected.cli, `${label} CLI mapping`)
        assert.deepEqual(manifest.outputSchema, expected.outputSchema, `${label} output schema`)
        assert.equal(manifest.inputSchema.type, 'object', `${label} request schema type`)
        assert.deepEqual(manifest.inputSchema.required, expected.required, `${label} required request fields`)
        assert.equal(manifest.inputSchema.additionalProperties, false, `${label} rejects unknown request fields`)
        const properties = manifest.inputSchema.properties as Record<string, JsonSchema>
        assert.deepEqual(properties.conversationId, safePositiveInt, `${label} conversationId`)
        assert.deepEqual(properties.expectedStateSeq, safeNonNegativeInt, `${label} expectedStateSeq`)
        const controls = Object.keys(expected.controls ?? {})
        assert.deepEqual(
          Object.keys(properties).slice(0, 2 + controls.length),
          ['conversationId', ...controls, 'expectedStateSeq'],
          `${label} declares the target id, its controls and the CAS watermark first`,
        )
        for (const [key, schema] of Object.entries(expected.controls ?? {})) {
          assert.deepEqual(properties[key], schema, `${label} ${key}`)
        }
        if (actionId === 'abort' || actionId === 'delete') {
          assert.deepEqual(
            properties,
            { conversationId: safePositiveInt, expectedStateSeq: safeNonNegativeInt },
            `${label} carries no body`,
          )
        }
        assertSchemaCompilable(manifest.inputSchema)
        const body = expected.body ?? {}
        validateOrThrow(manifest.inputSchema, { ...body, conversationId: 1 }, label)
        validateOrThrow(manifest.inputSchema, { ...body, conversationId: 1, expectedStateSeq: 0 }, label)
        for (const invalid of [
          { ...body },
          { ...body, conversationId: 0 },
          { ...body, conversationId: 1, expectedStateSeq: -1 },
          { ...body, conversationId: 1, expectedStateSeq: 1.5 },
          { ...body, conversationId: 1, unexpected: true },
        ]) {
          assert.throws(
            () => validateOrThrow(manifest.inputSchema, invalid, label),
            (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
            `${label} must reject ${JSON.stringify(invalid)}`,
          )
        }
      }
    } finally {
      await kernel.close()
    }
  })

  it('core:plugins & core:skills preserve exact registration order, exclude install/update/remove, and expose doctor target', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime(join(root, 'plugins-skills-manifests'))
    try {
      const pluginActions = kernel.plugins.listActions().filter((m) => m.pluginId === 'core:plugins')
      assert.deepEqual(
        pluginActions.map((m) => m.id),
        ['list', 'config_catalog', 'manifest', 'doc', 'config_get', 'doctor', 'config_set', 'enable', 'disable', 'reload', 'rescan'],
      )
      for (const excluded of ['install', 'update', 'remove']) {
        assert.equal(pluginActions.some((m) => m.id === excluded), false, `core:plugins.${excluded} must not exist`)
      }
      const doctorManifest = pluginActions.find((m) => m.id === 'doctor')!
      assert.ok((doctorManifest.inputSchema.properties as Record<string, unknown>)['target'])
      const manifestOp = pluginActions.find((m) => m.id === 'manifest')!
      assert.equal(manifestOp.inputSchema.required, undefined)

      const skillActions = kernel.plugins.listActions().filter((m) => m.pluginId === 'core:skills')
      assert.deepEqual(skillActions.map((m) => m.id), ['list', 'read'])
      for (const action of skillActions) {
        assert.deepEqual(action.scope, { conversationIds: [] })
      }
    } finally {
      await kernel.close()
    }
  })
})
