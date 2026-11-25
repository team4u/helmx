import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Extension } from '@earendil-works/pi-durable'
import {
  ARTIFACT_READ_META_SCHEMA,
  ARTIFACT_REGISTER_META_SCHEMA,
  HelmxError,
  TOOL_PRESENTATION_META_MAX_BYTES,
  TOOL_PRESENTATION_META_MAX_DEPTH,
  TOOL_PRESENTATION_META_MAX_NODES,
  type ActionManifest,
  type PluginToolResultEnvelope,
} from '@helmx/protocol'
import {
  RuntimeToolRegistry,
  wrapToolExecute,
  type PluginHostToolTarget,
} from '../src/runtime/tool-registry.js'
import {
  HookBridge,
  prepareToolResultWith,
} from '../src/runtime/hook-bridge.js'
import {
  actionToolResult,
  guardToolExecutionResult,
  pluginToolResult,
} from '../src/runtime/tools/tool-result-contract.js'
import type { HelmxToolDeps } from '../src/runtime/tool-deps.js'
import type { DerivedToolSpec, PluginHost } from '../src/plugins/index.js'
import { CapabilityRegistry } from '../src/plugins/capability-registry.js'
import { PluginTaskTracker } from '../src/plugins/tracking.js'

describe('RuntimeToolRegistry and wrapToolExecute unit tests', { timeout: 60_000 }, () => {
  it('wrapToolExecute: passes through to underlying tool execute when not aborted', { timeout: 60_000 }, async () => {
    let calledWith: unknown = undefined
    const wrapped = wrapToolExecute(async (args) => {
      calledWith = args
      return { output: [{ type: 'text', text: 'normal-output' }] }
    })

    const res = (await wrapped({ param: 123 } as never, { callId: 'call-none' } as never, {})) as {
      output: Array<{ type: 'text'; text: string }>
    }
    assert.deepEqual(calledWith, { param: 123 })
    assert.deepEqual(res.output, [{ type: 'text', text: 'normal-output' }])
  })

  it('installKernelTools: registers helmx-core extension (7 core tools) all wrapped with wrapToolExecute', { timeout: 60_000 }, async () => {
    const installed: Extension[] = []
    const fakeRegistry = {
      install(ext: Extension) {
        installed.push(ext)
      },
    }

    const fakeToolDeps: HelmxToolDeps = {
      dataDir: '/tmp/test',
      defaultCwd: '/tmp/test',
      hubUrl: 'http://127.0.0.1:3202',
      redact: (t) => t.replace(/secret/g, '[REDACTED]'),
      artifacts: {
        spill: async () => ({ text: 'spill' }),
        get: async () => ({} as never),
        readContent: async () => '',
        readBuffer: async () => new Uint8Array(),
      },
    }

    let invokedAction: { pluginId: string; actionId: string; input: unknown } | undefined
    const demoManifest: ActionManifest = {
      pluginId: 'demo',
      id: 'test',
      description: 'test action',
      inputSchema: { type: 'object', properties: { nested: { type: 'object', properties: { deep: { type: 'string' } } } }, required: ['nested'] },
      outputSchema: { type: 'object' },
      scope: { tags: ['alpha'] },
    }
    let listedActions: ActionManifest[] = [demoManifest]
    let conversationTags: string[] = ['alpha']
    const fakeHost: PluginHostToolTarget = {
      invokeAction: async (pluginId: string, actionId: string, input: unknown) => {
        invokedAction = { pluginId, actionId, input }
        return { message: `done with secret` }
      },
      executeTool: async () => {
        throw new Error('not implemented')
      },
      listTools: () => [],
      listActions: () => listedActions,
    }

    const registryModule = new RuntimeToolRegistry({
      registry: fakeRegistry,
      toolDeps: fakeToolDeps,
      getPluginHost: () => fakeHost,
      isArtifactAuthorized: (_c, _a) => true,
      redact: (t) => t.replace(/secret/g, '[REDACTED]'),
      getConversation: (id) => ({
        id,
        title: 'test',
        profileId: 'assistant',
        tags: conversationTags,
        cwd: '/tmp/test',
        model: 'faux/faux-1',
        thinkingLevel: '',
        status: 'idle',
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: 0,
        updatedAt: 0,
      }),
    })

    registryModule.installKernelTools()

    assert.equal(installed.length, 1)
    const coreExt = installed[0]!
    assert.equal(coreExt.name, 'helmx-core')
    assert.ok(Array.isArray(coreExt.tools))
    const toolNames = coreExt.tools!.map((t) => t.name)
    assert.deepEqual(
      toolNames.sort(),
      ['bash', 'edit', 'read', 'read_artifact', 'register_artifact', 'run_action', 'write'].sort(),
    )

    // Verify run_action meta-tool behavior
    const runActionTool = coreExt.tools!.find((t) => t.name === 'run_action') as unknown as {
      execute: (args: Record<string, unknown>, api: { conversationId: number }, ctx: { abortSignal?: AbortSignal }) => Promise<{
        output: Array<{ type: 'text'; text: string }>
        isError?: boolean
      }>
    }
    assert.ok(runActionTool)

    // Invalid action ID
    const badIdRes = await runActionTool.execute({ actionId: 'no-dot' }, { conversationId: 1 }, {})
    assert.equal(badIdRes.isError, true)
    assert.ok(badIdRes.output[0]!.text.includes('invalid action ID'))

    // Normal invocation and redaction
    const okRes = await runActionTool.execute({ actionId: 'demo.test', input: { foo: 'bar' } }, { conversationId: 1 }, {})
    assert.equal(okRes.isError, undefined)
    assert.deepEqual(invokedAction, { pluginId: 'demo', actionId: 'test', input: { foo: 'bar' } })
    assert.ok(okRes.output[0]!.text.includes('[REDACTED]'))
    assert.ok(!okRes.output[0]!.text.includes('secret'))

    // describe mode: returns full manifest (including nested schema) without calling handler
    invokedAction = undefined
    const descRes = await runActionTool.execute({ actionId: 'demo.test', describe: true }, { conversationId: 1 }, {})
    assert.equal(descRes.isError, undefined)
    assert.equal(invokedAction, undefined, 'describe mode must not invoke invokeAction')
    const parsed = JSON.parse(descRes.output[0]!.text) as ActionManifest
    assert.equal(parsed.pluginId, 'demo')
    assert.equal(parsed.id, 'test')
    assert.deepEqual(parsed.inputSchema, demoManifest.inputSchema, 'nested schema must remain intact and readable')
    assert.deepEqual(parsed.outputSchema, demoManifest.outputSchema)

    // describe: undeclared or disabled action rejects explicitly
    const unknownRes = await runActionTool.execute({ actionId: 'demo.missing', describe: true }, { conversationId: 1 }, {})
    assert.equal(unknownRes.isError, true)
    assert.ok(unknownRes.output[0]!.text.includes('does not declare action'))

    // describe: out-of-scope conversation is rejected without leaking schema
    conversationTags = ['beta']
    const scopedOut = await runActionTool.execute({ actionId: 'demo.test', describe: true }, { conversationId: 1 }, {})
    assert.equal(scopedOut.isError, true)
    assert.ok(scopedOut.output[0]!.text.includes('scope'))
    assert.ok(!scopedOut.output[0]!.text.includes('deep'), 'out-of-scope error must not leak schema contents')
    conversationTags = ['alpha']

    // describe: deactivated plugin (absent from listActions) is rejected as well
    listedActions = []
    const disabledRes = await runActionTool.execute({ actionId: 'demo.test', describe: true }, { conversationId: 1 }, {})
    assert.equal(disabledRes.isError, true)
    assert.ok(disabledRes.output[0]!.text.includes('does not declare action'))
  })

  it('installPluginTools and refreshPluginTools: hot-install and refresh plugin DerivedToolSpec definitions', { timeout: 60_000 }, async () => {
    const installed: Extension[] = []
    const fakeRegistry = {
      install(ext: Extension) {
        installed.push(ext)
      },
    }

    const fakeToolDeps: HelmxToolDeps = {
      dataDir: '/tmp/test',
      defaultCwd: '/tmp/test',
      hubUrl: 'http://127.0.0.1:3202',
      redact: (t) => t.replace(/token-123/g, '***'),
      artifacts: {
        spill: async () => ({ text: 'spill' }),
        get: async () => ({} as never),
        readContent: async () => '',
        readBuffer: async () => new Uint8Array(),
      },
    }

    let executedToolCall: { name: string; args: unknown; context: unknown } | undefined
    let currentTools: DerivedToolSpec[] = [
      {
        name: 'custom_search',
        description: 'search tool',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        sourcePluginId: 'test-plugin',
        sourceKind: 'tool',
      },
    ]

    const fakeHost: PluginHostToolTarget = {
      invokeAction: async () => {
        throw new Error('not implemented')
      },
      listTools: () => currentTools,
      listActions: () => [],
      executeTool: async (name: string, args: unknown, context: unknown) => {
        executedToolCall = { name, args, context }
        return `result contains token-123`
      },
    }

    const registryModule = new RuntimeToolRegistry({
      registry: fakeRegistry,
      toolDeps: fakeToolDeps,
      getPluginHost: () => fakeHost,
      isArtifactAuthorized: () => true,
      redact: (t) => t.replace(/token-123/g, '***'),
      getConversation: (id) => ({
        id,
        title: 'test',
        profileId: 'assistant',
        tags: [],
        cwd: '/tmp/test',
        model: 'faux/faux-1',
        thinkingLevel: '',
        status: 'idle',
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: 0,
        updatedAt: 0,
      }),
    })

    registryModule.refreshPluginTools()
    assert.equal(installed.length, 1)
    assert.equal(installed[0]!.name, 'helmx-plugins')
    assert.equal(installed[0]!.tools?.length, 1)
    assert.equal(installed[0]!.tools?.[0]?.name, 'custom_search')

    // Execute plugin tool and verify redaction + context forwarding
    const tool = installed[0]!.tools?.[0] as unknown as {
      execute: (args: unknown, api: unknown, ctx: unknown) => Promise<{
        output: Array<{ type: 'text'; text: string }>
      }>
    }
    const res = await tool.execute(
      { q: 'helmx' },
      { conversationId: 10, callId: 'call-custom-1' },
      { abortSignal: undefined },
    )
    assert.deepEqual(executedToolCall, {
      name: 'custom_search',
      args: { q: 'helmx' },
      context: { conversationId: 10, callId: 'call-custom-1', signal: undefined },
    })
    assert.ok(res.output[0]!.text.includes('***'))
    assert.ok(!res.output[0]!.text.includes('token-123'))

    // Refresh plugin tools after clearing list
    currentTools = []
    registryModule.refreshPluginTools()
    assert.equal(installed.length, 2)
    assert.equal(installed[1]!.name, 'helmx-plugins')
    assert.equal(installed[1]!.tools?.length, 0)
  })

  it('wrapToolExecute: throws unified abort error if abortSignal fired during underlying execution (preserving Error reason)', { timeout: 60_000 }, async () => {
    const ac1 = new AbortController()
    const wrappedNormal = wrapToolExecute(async () => {
      ac1.abort()
      return { output: [{ type: 'text', text: 'late-ok' }] }
    })
    await assert.rejects(
      () => wrappedNormal({} as never, { callId: 'call-abort-1' } as never, { abortSignal: ac1.signal }),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    )

    const ac2 = new AbortController()
    const customReason = new Error('kernel closing')
    const wrappedErrResult = wrapToolExecute(async () => {
      ac2.abort(customReason)
      return { output: [{ type: 'text', text: 'late-error-result' }], isError: true }
    })
    await assert.rejects(
      () => wrappedErrResult({} as never, { callId: 'call-abort-2' } as never, { abortSignal: ac2.signal }),
      (error: unknown) => error === customReason,
    )
  })

  it('installKernelTools: only read-only tools read and read_artifact declare replay: "safe"; others remain non-safe by default', { timeout: 60_000 }, () => {
    const installed: Extension[] = []
    const fakeToolDeps: HelmxToolDeps = {
      dataDir: '/tmp/test',
      defaultCwd: '/tmp/test',
      hubUrl: 'http://127.0.0.1:3202',
      redact: (t) => t,
      artifacts: {
        spill: async () => ({ text: 'spill' }),
        get: async () => ({} as never),
        readContent: async () => '',
        readBuffer: async () => new Uint8Array(),
      },
    }
    const registryModule = new RuntimeToolRegistry({
      registry: {
        install(ext: Extension) {
          installed.push(ext)
        },
      },
      toolDeps: fakeToolDeps,
      getPluginHost: () => undefined,
      isArtifactAuthorized: () => true,
      redact: (t) => t,
      getConversation: (id) => ({
        id,
        title: 'test',
        profileId: 'assistant',
        tags: [],
        cwd: '/tmp/test',
        model: 'faux/faux-1',
        thinkingLevel: '',
        status: 'idle',
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: 0,
        updatedAt: 0,
      }),
    })

    registryModule.installKernelTools()
    const tools = installed[0]!.tools!
    const byName = new Map(tools.map((t) => [t.name, t]))
    assert.equal(byName.get('read')?.replay, 'safe')
    assert.equal(byName.get('read_artifact')?.replay, 'safe')
    for (const unsafeName of ['bash', 'write', 'edit', 'register_artifact', 'run_action']) {
      assert.notEqual(byName.get(unsafeName)?.replay, 'safe', `${unsafeName} must not declare replay: safe`)
    }
  })

  it('installPluginTools and CapabilityRegistry: validate and forward PluginToolSpec.replay (safe/unsafe/omitted)', { timeout: 60_000 }, () => {
    const cap = new CapabilityRegistry()
    cap.registerTool('demo', {
      name: 'safe_tool',
      description: 'safe',
      inputSchema: { type: 'object' },
      replay: 'safe',
      execute: () => ({ ok: true }),
    })
    cap.registerTool('demo', {
      name: 'unsafe_tool',
      description: 'unsafe',
      inputSchema: { type: 'object' },
      replay: 'unsafe',
      execute: () => ({ ok: true }),
    })
    cap.registerTool('demo', {
      name: 'default_tool',
      description: 'default',
      inputSchema: { type: 'object' },
      execute: () => ({ ok: true }),
    })
    assert.throws(
      () =>
        cap.registerTool('demo', {
          name: 'bad_replay_tool',
          description: 'bad',
          inputSchema: { type: 'object' },
          replay: 'always' as never,
          execute: () => ({ ok: true }),
        }),
      (error: unknown) => error instanceof HelmxError && error.code === 'invalid_tool_spec' && error.status === 400,
    )

    const derived = cap.listTools(['demo'])
    const installed: Extension[] = []
    const fakeToolDeps: HelmxToolDeps = {
      dataDir: '/tmp/test',
      defaultCwd: '/tmp/test',
      hubUrl: 'http://127.0.0.1:3202',
      redact: (t) => t,
      artifacts: {
        spill: async () => ({ text: 'spill' }),
        get: async () => ({} as never),
        readContent: async () => '',
        readBuffer: async () => new Uint8Array(),
      },
    }
    const registryModule = new RuntimeToolRegistry({
      registry: {
        install(ext: Extension) {
          installed.push(ext)
        },
      },
      toolDeps: fakeToolDeps,
      getPluginHost: () => ({
        invokeAction: async () => undefined,
        executeTool: async () => undefined,
        listTools: () => derived,
        listActions: () => [],
      }),
      isArtifactAuthorized: () => true,
      redact: (t) => t,
      getConversation: (id) => ({
        id,
        title: 'test',
        profileId: 'assistant',
        tags: [],
        cwd: '/tmp/test',
        model: 'faux/faux-1',
        thinkingLevel: '',
        status: 'idle',
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: 0,
        updatedAt: 0,
      }),
    })

    registryModule.refreshPluginTools()
    const tools = installed[0]!.tools!
    const byName = new Map(tools.map((t) => [t.name, t]))
    assert.equal(byName.get('safe_tool')?.replay, 'safe')
    assert.equal(byName.get('unsafe_tool')?.replay, 'unsafe')
    assert.equal(byName.get('default_tool')?.replay, undefined)
    assert.equal(Object.hasOwn(byName.get('default_tool')!, 'replay'), false)
  })

  it('pluginToolResult: explicitly separates output, structuredOutput, and presentationMeta (no details auto-mirror, strict schema + budget)', { timeout: 60_000 }, () => {
    const redact = (t: string) => t.replaceAll('SECRET', '[REDACTED]')
    const structuredSchema = {
      type: 'object',
      properties: { ok: { type: 'boolean' }, payload: { type: 'string' } },
      required: ['ok', 'payload'],
      additionalProperties: false,
    }
    const metaSchema = {
      type: 'object',
      properties: { badge: { type: 'string' }, count: { type: 'integer' } },
      required: ['badge'],
      additionalProperties: false,
    }

    // 1. structuredOutput alone NEVER auto-mirrors to details.
    const noMeta = pluginToolResult(
      { output: 'text SECRET', structuredOutput: { ok: true, payload: 'big SECRET' } },
      redact,
      { structuredOutputSchema: structuredSchema, toolName: 'demo', callId: 'c1' },
    )
    assert.deepEqual(noMeta.output, [{ type: 'text', text: 'text [REDACTED]' }])
    assert.deepEqual(noMeta.structuredOutput, { ok: true, payload: 'big [REDACTED]' })
    assert.equal(noMeta.details, undefined, 'structuredOutput must NOT auto-mirror into persisted details')

    // 2. Both structuredOutput and presentationMeta separated, redacted, and validated independently.
    const both = pluginToolResult(
      {
        output: 'text SECRET',
        structuredOutput: { ok: true, payload: 'full SECRET' },
        presentationMeta: { badge: 'ok SECRET', count: 3 },
      },
      redact,
      { structuredOutputSchema: structuredSchema, presentationMetaSchema: metaSchema, toolName: 'demo', callId: 'c2' },
    )
    assert.deepEqual(both.structuredOutput, { ok: true, payload: 'full [REDACTED]' })
    assert.deepEqual(both.details, { badge: 'ok [REDACTED]', count: 3 })

    // 3. Invalid structuredOutput fails synchronously (never writes dirty details).
    assert.throws(
      () =>
        pluginToolResult(
          {
            output: 'ok',
            structuredOutput: { ok: 'not-bool', payload: 'x' },
            presentationMeta: { badge: 'should-not-persist' },
          },
          redact,
          { structuredOutputSchema: structuredSchema, presentationMetaSchema: metaSchema, toolName: 'demo' },
        ),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('structuredOutputSchema'),
    )

    // 4. Returning presentationMeta without declaring presentationMetaSchema fails explicitly.
    assert.throws(
      () =>
        pluginToolResult(
          { output: 'ok', presentationMeta: { badge: 'orphan' } },
          redact,
          { toolName: 'demo', callId: 'c3' },
        ),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('presentationMetaSchema'),
    )

    // 5. Legacy `details` field inside a tool envelope fails explicitly (no backward compatibility layer).
    assert.throws(
      () => pluginToolResult({ output: 'ok', details: { badge: 'legacy' } }, redact, { presentationMetaSchema: metaSchema, toolName: 'demo' }),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('presentationMeta'),
    )

    // 6. Oversized (>64 KiB), non-plain, prototype-key, or schema-invalid presentationMeta fails without truncation.
    assert.throws(
      () =>
        pluginToolResult(
          { output: 'ok', presentationMeta: { badge: 'x'.repeat(TOOL_PRESENTATION_META_MAX_BYTES) } },
          redact,
          { presentationMetaSchema: metaSchema, toolName: 'demo' },
        ),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('max byte size'),
    )
    assert.throws(
      () =>
        pluginToolResult(
          { output: 'ok', presentationMeta: { badge: 'ok', extra: 1 } },
          redact,
          { presentationMetaSchema: metaSchema, toolName: 'demo' },
        ),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('presentationMetaSchema'),
    )
    assert.throws(
      () =>
        pluginToolResult(
          { output: 'ok', presentationMeta: [1, 2] },
          redact,
          { presentationMetaSchema: metaSchema, toolName: 'demo' },
        ),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result',
    )
    assert.throws(
      () =>
        pluginToolResult(
          { output: 'ok', presentationMeta: JSON.parse('{"badge":"ok","__proto__":1}') },
          redact,
          { presentationMetaSchema: { type: 'object' }, toolName: 'demo' },
        ),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('prototype key'),
    )
  })

  it('exposeAsTool action via RuntimeToolRegistry: forwards structuredOutputSchema, never misidentifies business objects as envelopes, and guards projectPresentationMeta', { timeout: 60_000 }, async () => {
    const cap = new CapabilityRegistry()
    const tracker = new PluginTaskTracker()
    const outSchema = {
      type: 'object',
      properties: {
        output: { type: 'number' },
        isError: { type: 'string' },
        structuredOutput: { type: 'string' },
        presentationMeta: { type: 'number' },
        details: { type: 'string' },
        secretLine: { type: 'string' },
      },
      required: ['output', 'isError'],
    }
    const metaSchema = {
      type: 'object',
      properties: { code: { type: 'integer' }, label: { type: 'string' } },
      required: ['code', 'label'],
      additionalProperties: false,
    }
    let metaMode: 'valid' | 'undefined' | 'invalid_schema' | 'oversized' = 'valid'
    cap.registerAction('biz', {
      id: 'report',
      description: 'returns raw business object colliding with envelope keys',
      inputSchema: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] },
      outputSchema: outSchema,
      exposeAsTool: true,
      presentationMetaSchema: metaSchema,
      projectPresentationMeta: (input: { tag: string }, out: { output: number }) => {
        if (metaMode === 'undefined') return undefined
        if (metaMode === 'invalid_schema') return { wrong: true }
        if (metaMode === 'oversized') return { code: out.output, label: 'z'.repeat(TOOL_PRESENTATION_META_MAX_BYTES) }
        return { code: out.output, label: `${input.tag}:SEC"RET\nLINE` }
      },
      handler: () => ({
        output: 42,
        isError: 'not-a-boolean',
        structuredOutput: 'business-str',
        presentationMeta: 99,
        details: 'business-details',
        secretLine: 'SEC"RET\nLINE',
      }),
    })

    const fakeConv = {
      id: 1,
      title: 't',
      profileId: 'assistant',
      tags: [],
      cwd: '/tmp/test',
      model: 'faux/faux-1',
      thinkingLevel: '',
      status: 'idle' as const,
      stateChangeSeq: 1,
      completionSeq: 0,
      unread: false,
      pinned: false,
      pendingAskCount: 0,
      createdAt: 0,
      updatedAt: 0,
    }
    const execOpts = {
      assertActive: () => {},
      getConversation: () => fakeConv,
      tracker,
      isPluginRegistered: () => true,
    }
    const installed: Extension[] = []
    const redact = (t: string) => t.replaceAll('SEC"RET\nLINE', '[REDACTED]')
    const fakeToolDeps: HelmxToolDeps = {
      dataDir: '/tmp/test',
      defaultCwd: '/tmp/test',
      hubUrl: 'http://127.0.0.1:3202',
      redact,
      artifacts: {
        spill: async () => ({ text: 'spill' }),
        get: async () => ({} as never),
        readContent: async () => '',
        readBuffer: async () => new Uint8Array(),
      },
    }
    const registryModule = new RuntimeToolRegistry({
      registry: { install(ext: Extension) { installed.push(ext) } },
      toolDeps: fakeToolDeps,
      getPluginHost: () => ({
        invokeAction: (p, a, input, ctx) => cap.invokeAction(p, a, input, ctx ?? {}, execOpts),
        executeTool: (name, input, ctx) => cap.executeTool(name, input, ctx, execOpts),
        listTools: () => cap.listTools(['biz']),
        listActions: () => cap.listActions(['biz']),
      }),
      isArtifactAuthorized: () => true,
      redact,
      getConversation: () => fakeConv,
    })

    registryModule.installKernelTools()
    registryModule.refreshPluginTools()

    const pluginExt = installed.find((e) => e.name === 'helmx-plugins')!
    const derivedTool = pluginExt.tools![0]!
    // Gap A fixed: structuredOutputSchema forwarded to pi-durable defineTool.
    assert.deepEqual((derivedTool as { structuredOutputSchema?: unknown }).structuredOutputSchema, outSchema)
    assert.deepEqual(registryModule.getToolSchemas(derivedTool.name), {
      structuredOutputSchema: outSchema,
      presentationMetaSchema: metaSchema,
    })
    assert.ok(registryModule.getToolSchemas('edit')?.presentationMetaSchema !== undefined)
    assert.ok(registryModule.getToolSchemas('read')?.presentationMetaSchema !== undefined)
    assert.equal(registryModule.getToolSchemas('register_artifact')?.presentationMetaSchema, ARTIFACT_REGISTER_META_SCHEMA)
    assert.equal(registryModule.getToolSchemas('read_artifact')?.presentationMetaSchema, ARTIFACT_READ_META_SCHEMA)

    // Gap C fixed: naked business object with output/isError/structuredOutput/presentationMeta/details keys succeeds.
    const res = await derivedTool.execute({ tag: 'run' }, { conversationId: 1, callId: 'c1' } as never, {} as never)
    assert.equal(res.isError, undefined)
    const parsedText = JSON.parse((res.output as Array<{ text: string }>)[0]!.text) as Record<string, unknown>
    assert.equal(parsedText['output'], 42)
    assert.equal(parsedText['isError'], 'not-a-boolean')
    assert.equal(parsedText['secretLine'], '[REDACTED]', 'per-value JSON redaction must redact secrets containing quotes and newlines')
    assert.deepEqual(res.structuredOutput, parsedText)
    assert.deepEqual(res.details, { code: 42, label: 'run:[REDACTED]' })

    // Undefined projection omits details cleanly (no structuredOutput auto-mirror).
    metaMode = 'undefined'
    const noMetaRes = await derivedTool.execute({ tag: 'run' }, { conversationId: 1, callId: 'c2' } as never, {} as never)
    assert.equal(noMetaRes.details, undefined)
    assert.deepEqual(noMetaRes.structuredOutput, parsedText)

    // Invalid schema or oversized projection fails explicitly without truncation.
    metaMode = 'invalid_schema'
    await assert.rejects(
      () => derivedTool.execute({ tag: 'run' }, { conversationId: 1, callId: 'c3' } as never, {} as never),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('presentationMetaSchema'),
    )
    metaMode = 'oversized'
    await assert.rejects(
      () => derivedTool.execute({ tag: 'run' }, { conversationId: 1, callId: 'c4' } as never, {} as never),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('max byte size'),
    )

    // Direct actionToolResult sanity check: no details without projector.
    const bare = actionToolResult({ output: 1, isError: 'x' }, {}, redact, { structuredOutputSchema: outSchema, toolName: 'biz_act' })
    assert.equal(bare.details, undefined)
    assert.deepEqual(bare.structuredOutput, { output: 1, isError: 'x' })
  })

  it('HookBridge.afterTool & prepareToolResultWith: enforce presentationMeta/structuredOutput guard once without double-redaction', { timeout: 60_000 }, async () => {
    let redactCalls = 0
    const redact = (t: string) => {
      redactCalls += 1
      return t.replaceAll('SECRET', '[REDACTED]')
    }
    const metaSchema = {
      type: 'object',
      properties: { badge: { type: 'string' } },
      required: ['badge'],
      additionalProperties: false,
    }
    const structuredSchema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    }

    const fakeHost = {
      listTools: () => [
        {
          name: 'guarded_tool',
          description: 'guarded',
          inputSchema: { type: 'object' },
          structuredOutputSchema: structuredSchema,
          presentationMetaSchema: metaSchema,
          sourcePluginId: 'demo',
          sourceKind: 'tool' as const,
        },
        {
          name: 'plain_tool',
          description: 'plain',
          inputSchema: { type: 'object' },
          sourcePluginId: 'demo',
          sourceKind: 'tool' as const,
        },
      ],
      listActions: () => [],
      runHook: async () => ({ action: 'continue' }),
      runHookAround: async (_name: string, payload: unknown, next: (p: unknown) => Promise<unknown>) => next(payload),
    } as unknown as PluginHost

    let installedExt: Extension | undefined
    const artifacts = {
      spill: async (_convId: number, _id: string, text: string) => ({ text }),
    }
    const bridge = new HookBridge({
      registry: { install(ext: Extension) { installedExt = ext } },
      pluginHost: () => fakeHost,
      prepareToolResult: (convId, res, opts) => prepareToolResultWith(artifacts, redact, convId, res, opts),
      safeSummary: () => undefined,
      currentRunInputs: () => [],
      redact,
      artifacts,
    })
    bridge.install()

    const toolHook = (installedExt!.hooks![0] as unknown as {
      handlers: {
        afterTool: (
          call: { id: string; name: string; arguments: Record<string, unknown> },
          result: Record<string, unknown>,
          api: { conversationId: number },
        ) => Promise<Record<string, unknown>>
      }
    }).handlers

    // 1. Valid result: redacts output, structuredOutput, and details in a single guard pass (no double guardToolExecutionResult).
    const sampleRaw = {
      output: [{ type: 'text' as const, text: 'out SECRET' }],
      structuredOutput: { ok: true },
      details: { badge: 'new SECRET' },
    }
    redactCalls = 0
    await prepareToolResultWith(artifacts, redact, 1, sampleRaw, {
      toolName: 'guarded_tool',
      callId: 'c0',
      structuredOutputSchema: structuredSchema,
      presentationMetaSchema: metaSchema,
      enforceSchemas: true,
    })
    const singlePassCalls = redactCalls
    assert.ok(singlePassCalls > 0)

    redactCalls = 0
    const okRes = await toolHook.afterTool(
      { id: 'c1', name: 'guarded_tool', arguments: {} },
      sampleRaw,
      { conversationId: 1 },
    )
    assert.equal(okRes['isError'], undefined)
    assert.deepEqual(okRes['output'], [{ type: 'text', text: 'out [REDACTED]' }])
    assert.deepEqual(okRes['structuredOutput'], { ok: true })
    assert.deepEqual(okRes['details'], { badge: 'new [REDACTED]' })
    // Single pass: afterTool must match one prepareToolResultWith pass (double guard would be 2x).
    assert.equal(
      redactCalls,
      singlePassCalls,
      `afterTool must run guardToolExecutionResult only once (got ${redactCalls} redact calls vs single-pass baseline ${singlePassCalls})`,
    )

    // 2. Invalid raw tool results MUST all converge to `isError: true` with `details: undefined` and `structuredOutput: undefined`.
    const deep13 = (() => {
      let cur: unknown = { leaf: 1 }
      for (let i = 0; i < TOOL_PRESENTATION_META_MAX_DEPTH; i += 1) cur = { next: cur }
      return cur
    })()
    const tooManyNodes = { items: Array.from({ length: TOOL_PRESENTATION_META_MAX_NODES }, (_, i) => i) }
    const nonEnumMeta: Record<string, unknown> = { badge: 'ok' }
    Object.defineProperty(nonEnumMeta, 'hidden', { value: 'SECRET', enumerable: false })
    const symbolMeta: Record<PropertyKey, unknown> = { badge: 'ok', [Symbol('k')]: 'v' }
    const arrWithExtra = [1] as unknown[] & { extra?: string }
    arrWithExtra.extra = 'dropped'
    const badCases: Array<{ label: string; toolName: string; rawResult: Record<string, unknown>; pattern: RegExp }> = [
      {
        label: 'details on tool without presentationMetaSchema rejected',
        toolName: 'plain_tool',
        rawResult: { output: [{ type: 'text', text: 'ok' }], details: { badge: 'x' } },
        pattern: /presentationMetaSchema/,
      },
      {
        label: 'details violating schema rejected',
        toolName: 'guarded_tool',
        rawResult: { output: [{ type: 'text', text: 'ok' }], details: { badge: 123 } },
        pattern: /presentationMetaSchema/,
      },
      {
        label: 'details > 64 KiB rejected without truncation',
        toolName: 'guarded_tool',
        rawResult: { output: [{ type: 'text', text: 'ok' }], details: { badge: 'a'.repeat(TOOL_PRESENTATION_META_MAX_BYTES) } },
        pattern: /max byte size/,
      },
      {
        label: 'details depth > 12 rejected',
        toolName: 'guarded_tool',
        rawResult: { output: [{ type: 'text', text: 'ok' }], details: deep13 },
        pattern: /max nesting depth/,
      },
      {
        label: 'details nodes > 2000 rejected',
        toolName: 'guarded_tool',
        rawResult: { output: [{ type: 'text', text: 'ok' }], details: tooManyNodes },
        pattern: /max node count/,
      },
      {
        label: 'details prototype key rejected',
        toolName: 'guarded_tool',
        rawResult: { output: [{ type: 'text', text: 'ok' }], details: JSON.parse('{"badge":"ok","__proto__":1}') },
        pattern: /prototype key/,
      },
      {
        label: 'details NaN rejected (not laundered to null)',
        toolName: 'guarded_tool',
        rawResult: { output: [{ type: 'text', text: 'ok' }], details: { badge: 'ok', bad: Number.NaN } },
        pattern: /non-finite/,
      },
      {
        label: 'details non-enumerable own property rejected (not silently dropped)',
        toolName: 'guarded_tool',
        rawResult: { output: [{ type: 'text', text: 'ok' }], details: nonEnumMeta },
        pattern: /non-enumerable/,
      },
      {
        label: 'details symbol own key rejected (not silently dropped)',
        toolName: 'guarded_tool',
        rawResult: { output: [{ type: 'text', text: 'ok' }], details: symbolMeta },
        pattern: /symbol key/,
      },
      {
        label: 'details array extra own property rejected (not silently dropped)',
        toolName: 'guarded_tool',
        rawResult: { output: [{ type: 'text', text: 'ok' }], details: { badge: 'ok', items: arrWithExtra } },
        pattern: /extra own property/,
      },
      {
        label: 'structuredOutput violating schema rejected',
        toolName: 'guarded_tool',
        rawResult: { output: [{ type: 'text', text: 'ok' }], structuredOutput: { ok: 'nope' }, details: { badge: 'ok' } },
        pattern: /structuredOutputSchema/,
      },
      {
        label: 'structuredOutput on tool without structuredOutputSchema rejected',
        toolName: 'plain_tool',
        rawResult: { output: [{ type: 'text', text: 'ok' }], structuredOutput: { ok: true } },
        pattern: /structuredOutputSchema/,
      },
    ]
    for (const c of badCases) {
      const res = await toolHook.afterTool(
        { id: `bad-${c.label}`, name: c.toolName, arguments: {} },
        c.rawResult,
        { conversationId: 1 },
      )
      assert.equal(res['isError'], true, `${c.label}: must set isError: true`)
      assert.equal(res['details'], undefined, `${c.label}: must NOT persist details`)
      assert.equal(res['structuredOutput'], undefined, `${c.label}: must NOT persist structuredOutput`)
      const text = ((res['output'] as Array<{ text: string }>)[0] ?? { text: '' }).text
      assert.match(text, c.pattern, `${c.label}: unexpected error text "${text}"`)
    }

    // 3. Direct prepareToolResultWith rejects non-finite / undefined / prototype key / accessor / oversized details before JSON.stringify.
    await assert.rejects(
      () => prepareToolResultWith(artifacts, redact, 1, { output: [{ type: 'text', text: 'ok' }], details: { n: Number.NaN } as never }),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result',
    )
    await assert.rejects(
      () => prepareToolResultWith(artifacts, redact, 1, { output: [{ type: 'text', text: 'ok' }], details: { u: undefined } as never }),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result',
    )
    await assert.rejects(
      () => prepareToolResultWith(artifacts, redact, 1, { output: [{ type: 'text', text: 'ok' }], details: JSON.parse('{"__proto__":1}') }),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result',
    )

    // 4. Enumerable getters on details must NEVER execute and must fail closed (cleared details + isError: true).
    let detailsGetterCalled = false
    const makeDetailsGetter = () => {
      const obj: Record<string, unknown> = {}
      Object.defineProperty(obj, 'badge', {
        get() {
          detailsGetterCalled = true
          return 'forged'
        },
        enumerable: true,
      })
      return obj
    }

    await assert.rejects(
      () => prepareToolResultWith(artifacts, redact, 1, { output: [{ type: 'text', text: 'ok' }], details: makeDetailsGetter() as never }),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.message.includes('accessor'),
    )
    assert.equal(detailsGetterCalled, false, 'prepareToolResultWith must reject details getter without invocation')

    const rawDetailsRes = await toolHook.afterTool(
      { id: 'bad-details-getter-raw', name: 'guarded_tool', arguments: {} },
      { output: [{ type: 'text', text: 'orig' }], details: makeDetailsGetter() },
      { conversationId: 1 },
    )
    assert.equal(detailsGetterCalled, false, 'HookBridge.afterTool must reject raw details getter without invocation')
    assert.equal(rawDetailsRes['isError'], true)
    assert.equal(rawDetailsRes['details'], undefined)
    assert.match(((rawDetailsRes['output'] as Array<{ text: string }>)[0] ?? { text: '' }).text, /accessor/)
  })

  it('guardToolExecutionResult: validates and redacts rest envelope fields without JSON.stringify, preserving output/diagnostics/usage/control and rejecting non-JSON disguises', { timeout: 60_000 }, () => {
    const redact = (s: string) => s.replaceAll('SECRET', '[REDACTED]')

    // 1. Valid complete envelope (output text+image, isError, diagnostics, usage, control, structuredOutput, details)
    const guarded = guardToolExecutionResult(
      {
        output: [
          { type: 'text', text: 'hello SECRET', textSignature: 'sig-SECRET' },
          { type: 'image', data: 'base64-SECRET', mimeType: 'image/png' },
        ],
        isError: false,
        diagnostics: [
          { severity: 'info', message: 'info SECRET' },
          { severity: 'warn', message: 'warn SECRET', code: 'CODE_SECRET' },
          { severity: 'error', message: 'err' },
        ],
        usage: {
          input: 12,
          output: 8,
          cacheRead: 2,
          cacheWrite: 1,
          cacheWrite1h: 1,
          reasoning: 3,
          totalTokens: 23,
          cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03, totalFromProvider: true },
        },
        control: {
          addTools: ['tool_SECRET'],
          terminate: false,
          handoff: 'continue with SECRET',
        },
        structuredOutput: { ok: true, token: 'SECRET' },
        details: { badge: 'ok SECRET' },
      },
      redact,
      {
        toolName: 'full_tool',
        callId: 'call-1',
        structuredOutputSchema: { type: 'object', properties: { ok: { type: 'boolean' }, token: { type: 'string' } }, required: ['ok', 'token'], additionalProperties: false },
        presentationMetaSchema: { type: 'object', properties: { badge: { type: 'string' } }, required: ['badge'], additionalProperties: false },
        enforceSchemas: true,
      },
    )
    assert.deepEqual(guarded, {
      output: [
        { type: 'text', text: 'hello [REDACTED]', textSignature: 'sig-[REDACTED]' },
        { type: 'image', data: 'base64-[REDACTED]', mimeType: 'image/png' },
      ],
      isError: false,
      diagnostics: [
        { severity: 'info', message: 'info [REDACTED]' },
        { severity: 'warn', message: 'warn [REDACTED]', code: 'CODE_[REDACTED]' },
        { severity: 'error', message: 'err' },
      ],
      usage: {
        input: 12,
        output: 8,
        cacheRead: 2,
        cacheWrite: 1,
        cacheWrite1h: 1,
        reasoning: 3,
        totalTokens: 23,
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03, totalFromProvider: true },
      },
      control: {
        addTools: ['tool_[REDACTED]'],
        terminate: false,
        handoff: 'continue with [REDACTED]',
      },
      structuredOutput: { ok: true, token: '[REDACTED]' },
      details: { badge: 'ok [REDACTED]' },
    })

    // pi-durable finalResult spreads `details: undefined` when no presentationMeta is emitted; must stay valid.
    const withoutDetails = guardToolExecutionResult(
      { output: [{ type: 'text', text: 'ok' }], details: undefined, diagnostics: [] },
      redact,
    )
    assert.deepEqual(withoutDetails, { output: [{ type: 'text', text: 'ok' }], diagnostics: [] })
    assert.equal('details' in withoutDetails, false)

    // 2. Every non-JSON / disguised / dangerous rest-field payload must fail explicitly with invalid_tool_result.
    let getterOrToJsonInvoked = false
    const makeGetterObj = (key: string, enumerable: boolean) => {
      const o: Record<string, unknown> = { type: 'text', text: 'ok' }
      Object.defineProperty(o, key, {
        get() {
          getterOrToJsonInvoked = true
          return 'forged'
        },
        enumerable,
      })
      return o
    }

    class DisguisedBlock {
      toJSON() {
        getterOrToJsonInvoked = true
        return { type: 'text', text: 'forged' }
      }
    }
    class DisguisedResult {
      toJSON() {
        getterOrToJsonInvoked = true
        return { output: [{ type: 'text', text: 'forged' }] }
      }
    }
    const plainWithToJson = {
      type: 'text',
      text: 'ok',
      toJSON() {
        getterOrToJsonInvoked = true
        return { type: 'text', text: 'forged' }
      },
    }
    const nonEnumToJson = { type: 'text', text: 'ok' }
    Object.defineProperty(nonEnumToJson, 'toJSON', {
      value: () => {
        getterOrToJsonInvoked = true
        return { type: 'text', text: 'forged' }
      },
      enumerable: false,
    })

    const cyclicDiag: Record<string, unknown> = { severity: 'warn', message: 'loop' }
    cyclicDiag['self'] = cyclicDiag

    const nonEnumRoot: Record<string, unknown> = { output: [{ type: 'text', text: 'ok' }] }
    Object.defineProperty(nonEnumRoot, 'SECRET_HIDDEN', { value: 'SECRET', enumerable: false })

    const symRoot: Record<PropertyKey, unknown> = { output: [{ type: 'text', text: 'ok' }] }
    symRoot[Symbol('SECRET_SYM')] = 'x'

    const symNested: Record<PropertyKey, unknown> = { severity: 'info', message: 'ok' }
    symNested[Symbol('nested')] = 1

    // eslint-disable-next-line no-sparse-arrays
    const sparseOutput = [, { type: 'text', text: 'ok' }]
    const extraPropArray = [{ type: 'text', text: 'ok' }] as unknown[] & { extra?: string }
    extraPropArray.extra = 'sneaky'
    const protoKeyArray = [{ type: 'text', text: 'ok' }]
    Object.defineProperty(protoKeyArray, '__proto__', { value: { polluted: true }, enumerable: false })
    const getterElemArray = [{ type: 'text', text: 'ok' }]
    Object.defineProperty(getterElemArray, '0', {
      get() {
        getterOrToJsonInvoked = true
        return { type: 'text', text: 'forged' }
      },
      enumerable: true,
    })

    const badPayloads: Array<{ label: string; value: unknown }> = [
      { label: 'non-plain result (class with toJSON)', value: new DisguisedResult() },
      { label: 'null result', value: null },
      { label: 'undefined top-level output', value: { output: undefined } },
      { label: 'undefined top-level isError', value: { output: [], isError: undefined } },
      { label: 'undefined nested output property', value: { output: [{ type: 'text', text: 'ok', textSignature: undefined }] } },
      { label: 'undefined nested diagnostic code', value: { diagnostics: [{ severity: 'warn', message: 'm', code: undefined }] } },
      { label: 'symbol value in output', value: { output: [{ type: 'text', text: Symbol('s') }] } },
      { label: 'symbol own key on root', value: symRoot },
      { label: 'symbol own key on nested diagnostic', value: { diagnostics: [symNested] } },
      { label: 'function value in output', value: { output: [{ type: 'text', text: () => 'x' }] } },
      { label: 'bigint in usage', value: { usage: { input: 10n, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
      { label: 'NaN in usage', value: { usage: { input: Number.NaN, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
      { label: 'Infinity in usage cost', value: { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: Number.POSITIVE_INFINITY } } } },
      { label: 'circular reference in diagnostics', value: { diagnostics: [cyclicDiag] } },
      { label: 'non-enumerable root key', value: nonEnumRoot },
      { label: 'enumerable getter on output block', value: { output: [makeGetterObj('textSignature', true)] } },
      { label: 'non-enumerable getter on output block', value: { output: [makeGetterObj('lazy', false)] } },
      { label: 'enumerable getter on array element', value: { output: getterElemArray } },
      { label: 'prototype key __proto__ on root', value: JSON.parse('{"output":[],"__proto__":1}') },
      { label: 'prototype key constructor in diagnostics', value: { diagnostics: [{ severity: 'warn', message: 'm', constructor: {} }] } },
      { label: 'prototype key prototype in control', value: { control: { terminate: true, prototype: {} } } },
      { label: 'prototype key on output array', value: { output: protoKeyArray } },
      { label: 'toJSON method on plain object', value: { output: [plainWithToJson] } },
      { label: 'non-enumerable toJSON on plain object', value: { output: [nonEnumToJson] } },
      { label: 'class instance with toJSON in output', value: { output: [new DisguisedBlock()] } },
      { label: 'Date (builtin toJSON) in output', value: { output: [new Date()] } },
      { label: 'sparse array hole in output', value: { output: sparseOutput } },
      { label: 'extra own property on output array', value: { output: extraPropArray } },
      { label: 'unsupported top-level field', value: { output: [], forged: 'SECRET' } },
      { label: 'unsupported field in diagnostic', value: { diagnostics: [{ severity: 'info', message: 'ok', extra: 1 }] } },
      { label: 'non-finite structuredOutput without schema', value: { output: [], structuredOutput: { n: Number.NEGATIVE_INFINITY } } },
      {
        label: 'enumerable getter on details root',
        value: {
          output: [],
          details: Object.defineProperty({ ok: true }, 'SECRET_BADGE', {
            get() {
              getterOrToJsonInvoked = true
              return 'forged'
            },
            enumerable: true,
          }),
        },
      },
      {
        label: 'enumerable getter nested inside details',
        value: {
          output: [],
          details: {
            nested: Object.defineProperty({ ok: true }, 'badge', {
              get() {
                getterOrToJsonInvoked = true
                return 'forged'
              },
              enumerable: true,
            }),
          },
        },
      },
      {
        label: 'write-only setter on details',
        value: {
          output: [],
          details: Object.defineProperty({ ok: true }, 'writeOnly', {
            set() {
              getterOrToJsonInvoked = true
            },
            enumerable: true,
          }),
        },
      },
      {
        label: 'enumerable getter on array element inside details',
        value: {
          output: [],
          details: {
            items: Object.defineProperty(['a'], '0', {
              get() {
                getterOrToJsonInvoked = true
                return 'forged'
              },
              enumerable: true,
            }),
          },
        },
      },
    ]

    for (const c of badPayloads) {
      assert.throws(
        () => guardToolExecutionResult(c.value as never, redact, { toolName: 'test_tool' }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError, `${c.label}: expected HelmxError, got ${String(err)}`)
          assert.equal(err.code, 'invalid_tool_result', `${c.label}: expected invalid_tool_result, got ${err.code}`)
          assert.equal(err.status, 500, `${c.label}: expected status 500`)
          assert.equal(err.message.includes('SECRET'), false, `${c.label}: error message leaked secret: ${err.message}`)
          return true
        },
        `${c.label}: must throw invalid_tool_result`,
      )
    }
    assert.equal(getterOrToJsonInvoked, false, 'getters and toJSON disguises must never be invoked during guard')
  })
})
