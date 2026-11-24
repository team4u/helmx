/**
 * PluginHost / Hook pipeline / action total line / in-flight task protect test.
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock.
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SecretStash, AuthService } from '../src/services/index.js';
import { createHubHandler, type KernelRuntimeLike } from '../src/http/index.js';
import {
  HelmxError,
  type InputHookPayload,
  type PluginConfigFieldSchema,
  type PluginDefinition,
  type PluginDocHandle,
  type PluginManifestProjection,
  type PluginSessionDocHandle,
  type PluginSummary,
} from '@helmx/protocol';
import {
  PluginHost,
  actionToolAlias,
  doctorPluginDir,
  validatePluginInput,
  type PluginConfigStore,
  type PluginDocStore,
  type PluginHostBackend,
  type PluginSessionDocStore,
} from '../src/plugins/index.js';
import { HookPipeline } from '../src/plugins/hooks.js';
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js';
import { pluginDataDirName } from '../src/plugins/plugin-dir-name.js';

import { createPluginBuildProvider } from '@helmx/plugin-build';
import type { PluginBuildProvider } from '@helmx/protocol';
import {
  MemoryConfigStore,
  MemoryDocStore,
  assertRejectsCode,
  cleanupDir,
  deferred,
  makeConversationSummary,
  makeTempDir,
} from './helpers.js';

// ---------------------------------------------------------------------------
// test base create
// ---------------------------------------------------------------------------

function makeConversation(id: number) {
  return makeConversationSummary({ id, profileId: 'default' });
}

/**
 * plugin host backend port complete fake(new contract:AskResult three state + lifecycle port).
 * record manageConversation / onEvent invoke,
 * supply lifecycle release test assertion.
 */
function makeHostApi(events: string[] = []): PluginHostBackend {
  return {
    ...createPluginHostBackendFixture(),
    dispatchTrigger: async () => {
      events.push('dispatchTrigger');
    },
    submitInput: async () => {
      events.push('submitInput');
    },
    createConversation: async (init) => ({
      ...makeConversation(42),
      title: init.title ?? 'new',
    }),
    listConversations: () => [makeConversation(1)],
    getConversation: (id) => makeConversation(id),
    updateConversation: async (id) => makeConversation(id),
    manageConversation: (id, pluginId) => {
      events.push(`manage:${pluginId}:${id}`);
      return () => events.push(`release:${pluginId}:${id}`);
    },
    markConversationOwnership: () => {},
    createAsk: async () => ({ id: 'ask-1', status: 'answered', answers: {} }),
    cancelAsk: async () => {},
    onEvent: () => () => {
      events.push('unregister-workflow-settled');
    },
    abortConversation: async () => {},
    getConversationOwnership(): 'helmx' | 'human' {
      return 'human'
    },
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    execEnv: async () => {
      throw new HelmxError('unsupported', 'this fixture do not execute node command', 501);
    },
    emitEvent(type: string, payload: unknown) {
      events.push(`event:${type}`);
      eventPayloads.push({ type, payload });
    },
  };
}

function makeInput(over: Partial<InputHookPayload> = {}): InputHookPayload {
  return {
    conversationId: 1,
    input: {
      id: 'inp-1',
      text: 'hello',
      origin: 'human',
      createdAt: 1,
    },
    ...over,
  };
}

let dataDir: string;
let docs: MemoryDocStore;
let events: string[];
/** emitEvent complete payload (plugin.changed  ui field etc. assertion use). */
let eventPayloads: Array<{ type: string; payload: unknown }>;

/** assertion sync function throw designate code  HelmxError. */
function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof HelmxError, `expectation HelmxError, actual:${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

function makeHost(config?: PluginConfigStore, extra?: { buildProvider?: PluginBuildProvider }): PluginHost {
  return new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: makeHostApi(events), docs, config, ...(extra?.buildProvider !== undefined ? { buildProvider: extra.buildProvider } : {}) });
}

beforeEach(async () => {
  dataDir = await makeTempDir('helmx-plugins-test-');
  docs = new MemoryDocStore();
  events = [];
  eventPayloads = [];
});

afterEach(async () => {
  await cleanupDir(dataDir);
});

// ---------------------------------------------------------------------------
// Hook pipeline: priority / transform / handled / block / illegal artifact
// ---------------------------------------------------------------------------

test('priority and same priority register order: high priority first run, same priority by register order', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const order: string[] = [];
  await host.register({
    id: 'p:a',
    definePlugin: (ctx) => {
      ctx.hook.onInput(() => {
        order.push('a-p0');
        return { action: 'continue' };
      });
      ctx.hook.onInput(
        () => {
          order.push('a-p10');
          return { action: 'continue' };
        },
        { priority: 10 },
      );
    },
  });
  await host.register({
    id: 'p:b',
    definePlugin: (ctx) => {
      ctx.hook.onInput(
        () => {
          order.push('b-p10');
          return { action: 'continue' };
        },
        { priority: 10 },
      );
    },
  });
  await host.runHook('input', makeInput());
  assert.deepEqual(order, ['a-p10', 'b-p10', 'a-p0']);
});

test('transform.value pass downstream: after continue handle see to change write after payload', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const seen: string[] = [];
  await host.register({
    id: 'p:route',
    definePlugin: (ctx) => {
      ctx.hook.onInput(
        (p) => ({ action: 'transform', value: { ...p, input: { ...p.input, text: 'rewritten' } } }),
        { priority: 10 },
      );
      ctx.hook.onInput((p) => {
        seen.push(`low:${p.input.text}`);
        return { action: 'continue' };
      });
    },
  });
  const result = await host.runHook('input', makeInput());
  assert.equal(result.action, 'transform');
  if (result.action === 'transform') {
    assert.equal(result.value.input.text, 'rewritten');
  }
  assert.deepEqual(seen, ['low:rewritten']);
});

test('handled short route: after continue handle do not execute, by default behavior by take over', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let downstreamRan = false;
  await host.register({
    id: 'p:gate',
    definePlugin: (ctx) => {
      ctx.hook.onInput(
        () => ({ action: 'handled', result: { dropped: true } }),
        { priority: 10 },
      );
      ctx.hook.onInput(() => {
        downstreamRan = true;
        return { action: 'continue' };
      });
    },
  });
  const result = await host.runHook('input', makeInput());
  assert.deepEqual(result, { action: 'handled', result: { dropped: true } });
  assert.equal(downstreamRan, false);
});

test('input block carry reason short route; block missing reason explicit errors', { timeout: 60_000 }, async () => {
  const inputBlockedHost = makeHost();
  await inputBlockedHost.register({
    id: 'p:input-guard',
    definePlugin: (ctx) => {
      ctx.hook.onInput((p) =>
        p.input.text.startsWith('/swarm') ? { action: 'block', reason: 'ineligible conversation' } : { action: 'continue' },
      );
    },
  });
  const inputBlocked = await inputBlockedHost.runHook('input', {
    conversationId: 1,
    input: { id: 'i1', text: '/swarm task', origin: 'human', createdAt: 1 },
  });
  assert.deepEqual(inputBlocked, { action: 'block', reason: 'ineligible conversation' });

  const host2 = makeHost();
  await host2.register({
    id: 'p:bad-block',
    definePlugin: (ctx) => {
      ctx.hook.onInput(() => ({ action: 'block', reason: '' }) as never);
    },
  });
  await assert.rejects(
    host2.runHook('input', makeInput()),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError);
      assert.equal(err.code, 'invalid_hook_result');
      assert.equal(err.status, 500);
      return true;
    },
  );
});

test('before_turn return block explicit invalid_hook_result;turn_settled block rotate exception isolated alert do not block assert downstream', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:illegal',
    definePlugin: (ctx) => {
      ctx.hook.onBeforeTurn(() => ({ action: 'block', reason: 'not allowed' }) as never);
    },
  });
  await assert.rejects(
    host.runHook('before_turn', {
      conversation: makeConversation(1),
      inputs: [],
      tools: [],
      sections: [],
      messages: [],
    }),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError);
      assert.equal(err.code, 'invalid_hook_result');
      return true;
    },
  );

  // turn_settled for unsupported action (block) do single plugin exception isolated: notification alert,
  // do not block assert downstream plugin compute handle, also do not to on throws.
  const host2 = makeHost();
  const settled: string[] = [];
  await host2.register({
    id: 'p:settle-bad',
    definePlugin: (ctx) => {
      ctx.hook.onTurnSettled(() => ({ action: 'block', reason: 'not allowed' }) as never, { priority: 10 });
    },
  });
  await host2.register({
    id: 'p:settle-ok',
    definePlugin: (ctx) => {
      ctx.hook.onTurnSettled(() => {
        settled.push('ok');
        return { action: 'continue' };
      });
    },
  });
  const result = await host2.runHook('turn_settled', {
    conversation: makeConversation(1),
    inputs: [],
    outcome: 'completed',
    settledAt: 1,
  });
  assert.equal(result.action, 'transform');
  assert.deepEqual(settled, ['ok'], 'downstream turn_settled handle per common execute');
  const notified = eventPayloads.filter((e) => e.type === 'notification');
  assert.equal(notified.length, 1, 'exception plugin receives a warning alert');
  const payload = notified[0]!.payload as { level: string; title: string };
  assert.equal(payload.level, 'warning');
  assert.match(payload.title, /p:settle-bad turn compute hook exception/);
});

test('hook return undefined etc. price continue;transform missing value / break must want field / unknown action all explicit errors', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:void',
    definePlugin: (ctx) => {
      ctx.hook.onInput(() => undefined);
    },
  });
  const ok = await host.runHook('input', makeInput());
  assert.equal(ok.action, 'transform'); // pipeline only void handle, payload original pass out

  // transform missing value
  const h2 = makeHost();
  await h2.register({
    id: 'p:no-value',
    definePlugin: (ctx) => {
      ctx.hook.onInput(() => ({ action: 'transform' }) as never);
    },
  });
  await assertRejectsCode(() => h2.runHook('input', makeInput()), 'invalid_hook_result');

  // transform break must want field (input.id by delete)
  const h3 = makeHost();
  await h3.register({
    id: 'p:break',
    definePlugin: (ctx) => {
      ctx.hook.onInput((p) => {
        const broken = { ...p, input: { ...p.input, id: '' } };
        return { action: 'transform', value: broken };
      });
    },
  });
  await assert.rejects(h3.runHook('input', makeInput()), (err: unknown) => {
    assert.ok(err instanceof HelmxError);
    assert.equal(err.code, 'invalid_hook_result');
    return true;
  });

  // unknown action
  const h4 = makeHost();
  await h4.register({
    id: 'p:unknown-action',
    definePlugin: (ctx) => {
      ctx.hook.onInput(() => ({ action: 'resend' }) as never);
    },
  });
  await assertRejectsCode(() => h4.runHook('input', makeInput()), 'invalid_hook_result');
});

test('hook execute throw exception: wrap hook_execution_failed and not silently', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:throw',
    definePlugin: (ctx) => {
      ctx.hook.onInput(() => {
        throw new Error('plugin internal crash');
      });
    },
  });
  await assert.rejects(
    host.runHook('input', {
      conversationId: 1,
      input: { id: 'i1', text: 'hi', origin: 'human', createdAt: 1 },
    }),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError);
      assert.equal(err.code, 'hook_execution_failed');
      assert.equal(err.status, 500);
      assert.match(err.message, /plugin internal crash/);
      return true;
    },
  );
});

test('HookPipeline: concurrent add+sort during run() never re-orders active iteration array (no skip/duplicate)', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline('input');
  const calls: string[] = [];
  const payload = {
    conversationId: 1,
    input: { id: 'i1', text: 'x', origin: 'human' as const, createdAt: 1 },
  };

  pipeline.add('p:a', async () => {
    calls.push('a');
    // Register a higher-priority hook mid-iteration and trigger sort path (simulates another runHook calling entries())
    pipeline.add('p:c', () => { calls.push('c'); }, 10);
    pipeline.entries();
    return { action: 'continue' as const };
  });
  pipeline.add('p:b', () => {
    calls.push('b');
    return { action: 'continue' as const };
  });

  await pipeline.run(payload);
  assert.deepEqual(calls, ['a', 'b']);

  // Next round: high-priority hook c runs first
  await pipeline.run(payload);
  assert.deepEqual(calls, ['a', 'b', 'c', 'a', 'b']);
});

// ---------------------------------------------------------------------------
// action total line:schema validate / all limit set id parse / five end shared use entry
// ---------------------------------------------------------------------------

test('invokeAction: reference validation failed 400 validation_error, output violate about 500 invalid_plugin_output', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'builtin:demo',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'echo',
        description: 'back visible',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        outputSchema: { type: 'object', properties: { greeting: { type: 'string' } }, required: ['greeting'] },
        handler: (input: { name: string }) => ({ greeting: `hello ${input.name}` }),
      });
      ctx.action({
        id: 'bad-output',
        description: 'output violate about',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object', properties: { must: { type: 'number' } }, required: ['must'] },
        handler: () => ({ must: 'not-a-number' }) as never,
      });
    },
  });

  const ok = (await host.invokeAction('builtin:demo', 'echo', { name: 'helmx' })) as { greeting: string };
  assert.equal(ok.greeting, 'hello helmx');

  await assert.rejects(host.invokeAction('builtin:demo', 'echo', {}), (err: unknown) => {
    assert.ok(err instanceof HelmxError);
    assert.equal(err.code, 'validation_error');
    assert.equal(err.status, 400);
    return true;
  });

  await assert.rejects(host.invokeAction('builtin:demo', 'bad-output', {}), (err: unknown) => {
    assert.ok(err instanceof HelmxError);
    assert.equal(err.code, 'invalid_plugin_output');
    assert.equal(err.status, 500);
    return true;
  });

  await assert.rejects(host.invokeAction('builtin:demo', 'missing', {}), (err: unknown) => {
    assert.ok(err instanceof HelmxError);
    assert.equal(err.code, 'unknown_action');
    assert.equal(err.status, 404);
    return true;
  });
});

test('parseQualifiedActionId:pluginId contains ":" when by first "." correct split', { timeout: 60_000 }, () => {
  assert.deepEqual(PluginHost.parseQualifiedActionId('builtin:profile.update_memory'), {
    pluginId: 'builtin:profile',
    actionId: 'update_memory',
  });
  assert.deepEqual(PluginHost.parseQualifiedActionId('triggers.cron.create'), {
    pluginId: 'triggers',
    actionId: 'cron.create',
  });
  assert.throws(() => PluginHost.parseQualifiedActionId('no-dot'), HelmxError);
  assert.throws(() => PluginHost.parseQualifiedActionId('trailing.'), HelmxError);
});

test('listActions / listTools:manifest field accurate,exposeAsTool action derive tool', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'builtin:mixed',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'visible',
        description: 'direct throw tool',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        exposeAsTool: true,
        handler: () => ({}),
      });
      ctx.action({
        id: 'hidden_tool',
        description: 'via run_action invoke',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: () => ({}),
      });
      ctx.tool({
        name: 'dedicated_tool',
        description: 'dedicated use tool',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        execute: () => 'ok',
      });
    },
  });

  const actions = host.listActions();
  assert.equal(actions.length, 2);
  const visible = actions.find((a) => a.id === 'visible')!;
  assert.equal(visible.pluginId, 'builtin:mixed');
  assert.equal(visible.id, 'visible');
  assert.equal(visible.exposeAsTool, true);

  const tools = host.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('dedicated_tool'));
  // action derive tool use provider-safe alias (excludes ':'/'.'),manifest still all limit set ID
  const derived = tools.find((t) => t.sourceKind === 'action')!;
  assert.equal(derived.qualifiedId, 'builtin:mixed.visible');
  assert.match(derived.name, /^[A-Za-z0-9_-]{1,64}$/);
  assert.ok(!derived.name.includes(':') && !derived.name.includes('.'));
  assert.ok(!names.includes('builtin:mixed.hidden_tool'));

  // executeTool away derive action: alias and all limit set name all can, input via the same schema validate
  const r = await host.executeTool(derived.name, {}, { conversationId: 1 });
  assert.deepEqual(r, {});
  const r2 = await host.executeTool('builtin:mixed.visible', {}, { conversationId: 1 });
  assert.deepEqual(r2, {});
  await assert.rejects(
    host.executeTool('dedicated_tool', { q: 123 }, { conversationId: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError);
      assert.equal(err.code, 'validation_error');
      return true;
    },
  );
});

test('action declaration missing inputSchema/outputSchema in register boundary explicit reject', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await assert.rejects(
    host.register({
      id: 'p:bad-schema',
      definePlugin: (ctx) => {
        ctx.action({
          id: 'x',
          description: 'missing schema',
          inputSchema: undefined as never,
          outputSchema: { type: 'object' },
          handler: () => ({}),
        });
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError);
      assert.equal(err.code, 'invalid_action_spec');
      return true;
    },
  );
  // register failed i.e. rollback: do not appear in manifest
  assert.equal(host.list().length, 0);
});

// ---------------------------------------------------------------------------
// definition display copy boundary (LocalizedText name/description)
// ---------------------------------------------------------------------------

test('definition display copy: name/description LocalizedText one rule at register boundary, no builtin ID special-casing', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const badCopy: unknown[] = [
    '', '   ', 42, true, null, [], {},
    { fr: 'x' }, { 'zh-cn': 'x' }, { en: 1 }, { en: '' }, { en: 'Hi', 'zh-CN': ' ' },
  ];
  // builtin: and external (colon-free) ids follow the exact same display-copy guard
  for (const id of ['builtin:copy-demo', 'copy-demo']) {
    for (const field of ['name', 'description'] as const) {
      for (const value of badCopy) {
        await assert.rejects(
          host.register({ id, [field]: value, definePlugin: () => {} } as unknown as PluginDefinition),
          (err: unknown) => {
            assert.ok(err instanceof HelmxError, `expected HelmxError for ${field}=${JSON.stringify(value)}`);
            assert.equal(err.code, 'invalid_plugin_definition');
            assert.ok(err.message.includes(field), `message should locate field ${field}:${err.message}`);
            return true;
          },
        );
      }
    }
  }
  assert.equal(host.list().length, 0, 'failed registrations leave no summary behind (rollback)');

  // valid display copy registers fine: plain strings and supported-locale maps both accepted
  await host.register({
    id: 'builtin:copy-demo',
    name: { en: 'Demo', 'zh-CN': '演示' },
    description: 'demo plugin',
    definePlugin: () => {},
  });
  await host.register({
    id: 'copy-demo-ext',
    name: 'Plain',
    description: { en: 'desc', 'zh-CN': '描述' },
    definePlugin: () => {},
  });
  // name/description stay optional: omitting them falls back to the id for display
  await host.register({ id: 'copy-demo-min', definePlugin: () => {} });

  const summaries = host.list();
  const builtin = summaries.find((s) => s.id === 'builtin:copy-demo')!;
  const external = summaries.find((s) => s.id === 'copy-demo-ext')!;
  const minimal = summaries.find((s) => s.id === 'copy-demo-min')!;
  // raw localized shape passes through to the summary (no locale coercion at the kernel boundary)
  assert.deepEqual(builtin.name, { en: 'Demo', 'zh-CN': '演示' });
  assert.deepEqual(builtin.description, 'demo plugin');
  assert.deepEqual(external.name, 'Plain');
  assert.deepEqual(external.description, { en: 'desc', 'zh-CN': '描述' });
  assert.equal(minimal.name, 'copy-demo-min');
  assert.equal(minimal.description, undefined);
});

test('ctx.configSchema: label/description display copy validated at declaration (invalid_config_schema)', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const badCopy: unknown[] = [
    '', '   ', 42, true, null, [], { fr: 'x' }, { 'zh-cn': 'x' }, { en: 1 }, { en: '' }, { en: 'Hi', 'zh-CN': ' ' },
  ];
  for (const copyField of ['label', 'description'] as const) {
    for (const value of badCopy) {
      await assert.rejects(
        host.register({
          id: `p:cfg-copy-${copyField}`,
          definePlugin: (ctx) => {
            ctx.configSchema({ token: { type: 'string', [copyField]: value } as unknown as PluginConfigFieldSchema });
          },
        }),
        (err: unknown) => {
          assert.ok(err instanceof HelmxError, `expected HelmxError for ${copyField}=${JSON.stringify(value)}`);
          assert.equal(err.code, 'invalid_config_schema');
          assert.ok(err.message.includes(copyField), `message should locate field ${copyField}:${err.message}`);
          return true;
        },
      );
    }
  }
  assert.equal(host.list().length, 0, 'failed registrations leave no summary behind (rollback)');

  // valid declarations pass: plain string label + localized map description, raw shape preserved
  await host.register({
    id: 'p:cfg-copy-ok',
    definePlugin: (ctx) => {
      ctx.configSchema({
        token: {
          type: 'string',
          label: { en: 'Token', 'zh-CN': '令牌' },
          description: 'API token for upstream service',
        },
        model: {
          type: 'string',
          format: 'model',
          default: '',
          label: { en: 'Model', 'zh-CN': '模型' },
        },
        node: {
          type: 'string',
          format: 'node',
          default: 'local',
          label: { en: 'Node', 'zh-CN': '节点' },
        },
        profile: {
          type: 'string',
          format: 'profile',
          default: '',
          label: { en: 'Profile', 'zh-CN': 'Profile' },
        },
      });
    },
  });
  assert.deepEqual(host.getConfigSchema('p:cfg-copy-ok').token, {
    type: 'string',
    label: { en: 'Token', 'zh-CN': '令牌' },
    description: 'API token for upstream service',
  });
  assert.equal(host.getConfigSchema('p:cfg-copy-ok').model?.format, 'model');
  assert.equal(host.getConfigSchema('p:cfg-copy-ok').node?.format, 'node');
  assert.equal(host.getConfigSchema('p:cfg-copy-ok').profile?.format, 'profile');

  // format is a closed host enum, string fields only; unknown format or non-string rejects explicitly
  for (const badField of [
    { type: 'number', format: 'model' },
    { type: 'number', format: 'node' },
    { type: 'string', format: 'unknown' },
    { type: 'string', format: 'model', enum: ['m1'] },
    { type: 'boolean', enum: ['true'] },
    { type: 'string', secret: true, enum: ['s1'] },
    { type: 'string[]', secret: true },
    { type: 'string', enum: [] },
    { type: 'string', enum: ['a', 'a'] },
    { type: 'string', enum: ['a', 'b'], default: 'c' },
    { type: 'string[]', enum: ['a', 'b'], default: ['a', 'c'] },
    { type: 'string[]', default: 'not-array' },
    { type: 'number', enum: [1, 2], integer: true, default: 3 },
  ] as unknown as PluginConfigFieldSchema[]) {
    await assert.rejects(
      host.register({
        id: `p:cfg-bad-${Math.random().toString(36).slice(2)}`,
        definePlugin: (ctx) => {
          ctx.configSchema({ target: badField });
        },
      }),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_config_schema',
    );
  }

  // enum and string[] declarations succeed, clone defaults safely, and project into PluginManifestProjection
  await host.register({
    id: 'p:cfg-enum-arr',
    definePlugin: (ctx) => {
      ctx.configSchema({
        mode: { type: 'string', enum: ['fast', 'balanced'], default: 'fast' },
        retries: { type: 'number', enum: [1, 2, 4], integer: true, minimum: 1, maximum: 4, default: 2 },
        tags: { type: 'string[]', default: ['alpha'] },
        channels: { type: 'string[]', enum: ['cron', 'webhook', 'manual'], default: ['cron'] },
      });
    },
  });
  const cfg = host.getConfig('p:cfg-enum-arr');
  assert.deepEqual(cfg, { mode: 'fast', retries: 2, tags: ['alpha'], channels: ['cron'] });
  // Mutating returned array default must not corrupt schema defaults on subsequent reads.
  (cfg['tags'] as string[]).push('mutated');
  assert.deepEqual(host.getConfig('p:cfg-enum-arr')['tags'], ['alpha']);

  const manifest = host.getManifest('p:cfg-enum-arr');
  assert.deepEqual(manifest.configFields, [
    { key: 'channels', type: 'string[]', secret: false, required: false, enum: ['cron', 'webhook', 'manual'], default: ['cron'] },
    { key: 'mode', type: 'string', secret: false, required: false, enum: ['fast', 'balanced'], default: 'fast' },
    { key: 'retries', type: 'number', secret: false, required: false, enum: [1, 2, 4], default: 2, minimum: 1, maximum: 4, integer: true },
    { key: 'tags', type: 'string[]', secret: false, required: false, default: ['alpha'] },
  ]);
  await host.dispose();
});

// ---------------------------------------------------------------------------
// in-flight task protect (409 plugin_has_live_tasks)
// ---------------------------------------------------------------------------

test('disable encounter in-flight action / tool / suspended spawn one rule 409, after end can deactivate', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  await host.register({
    id: 'p:busy',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'slow',
        description: 'slow action',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: async () => {
          await gate;
          return { done: true };
        },
      });
    },
  });

  const running = host.invokeAction('p:busy', 'slow', {});
  await new Promise((r) => setTimeout(r, 20));
  await assertRejectsCode(() => host.disable('p:busy'), 'plugin_has_live_tasks', 409);

  release();
  assert.deepEqual(await running, { done: true });
  await host.disable('p:busy');
  assert.equal(host.list().find((p) => p.id === 'p:busy')!.enabled, false);
});

test('suspended agent_spawn and self define task also count in-flight protect', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:spawner',
    definePlugin: (ctx) => {
      void ctx;
    },
  });
  host.beginSpawnTask('p:spawner', 'spawn-1');
  await assertRejectsCode(() => host.disable('p:spawner'), 'plugin_has_live_tasks');
  host.endSpawnTask('p:spawner', 'spawn-1');

  const task = host.withTask('p:spawner', 'custom', async () => {
    await new Promise((r) => setTimeout(r, 30));
    return 1;
  });
  await assertRejectsCode(() => host.disable('p:spawner'), 'plugin_has_live_tasks');
  assert.equal(await task, 1);
  await host.disable('p:spawner');
});

test('runHook execute during disable by reject (hook in-flight count is task)', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  await host.register({
    id: 'p:hooky',
    definePlugin: (ctx) => {
      ctx.hook.onInput(async () => {
        await gate;
        return { action: 'continue' };
      });
    },
  });
  const running = host.runHook('input', makeInput());
  await new Promise((r) => setTimeout(r, 20));
  await assertRejectsCode(() => host.disable('p:hooky'), 'plugin_has_live_tasks');
  release();
  await running;
  await host.disable('p:hooky');
});

// ---------------------------------------------------------------------------
// service lifecycle:rollback and inverse to stop
// ---------------------------------------------------------------------------

test('service start failed: already start inverse to stop, register whole rollback', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const events: string[] = [];
  await assert.rejects(
    host.register({
      id: 'p:svc-fail',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'a',
          start: () => {
            events.push('a:start');
          },
          stop: () => {
            events.push('a:stop');
          },
        });
        ctx.service({
          id: 'b',
          start: () => {
            events.push('b:start');
            throw new Error('b start crash');
          },
          stop: () => {
            events.push('b:stop');
          },
        });
        ctx.action({
          id: 'never',
          description: 'x',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          handler: () => ({}),
        });
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError);
      assert.equal(err.code, 'plugin_service_start_failed');
      assert.equal(err.status, 500);
      return true;
    },
  );
  assert.deepEqual(events, ['a:start', 'b:start', 'a:stop']);
  // rollback after plugin missing, action invisible
  assert.equal(host.list().length, 0);
  assert.equal(host.listActions().length, 0);
});

test('normal disable: service by register inverse order stop', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const stops: string[] = [];
  await host.register({
    id: 'p:svc-ok',
    definePlugin: (ctx) => {
      ctx.service({ id: 'first', start: () => {}, stop: () => { stops.push('first'); } });
      ctx.service({ id: 'second', start: () => {}, stop: () => { stops.push('second'); } });
    },
  });
  await host.disable('p:svc-ok');
  assert.deepEqual(stops, ['second', 'first']);
  // again enable: service re- start
  await host.enable('p:svc-ok');
  assert.equal(host.list().find((p) => p.id === 'p:svc-ok')!.enabled, true);
});

// ---------------------------------------------------------------------------
// locked plugin / doc namespacing / config honesty
// ---------------------------------------------------------------------------

test('locked plugin disable/unregister 403 plugin_locked', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'builtin:profile',
    locked: true,
    definePlugin: () => {},
  });
  await assert.rejects(host.disable('builtin:profile'), (err: unknown) => {
    assert.ok(err instanceof HelmxError);
    assert.equal(err.code, 'plugin_locked');
    assert.equal(err.status, 403);
    return true;
  });
  await assertRejectsCode(() => host.unregister('builtin:profile'), 'plugin_locked', 403);
});

test('doc namespace isolation pluginId:name; get returns clone preventing unpersisted mutations', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:docs',
    definePlugin: (ctx) => {
      const doc = ctx.doc('counter', { n: 0, items: [] as string[] });
      doc.update((s) => ({ ...s, n: s.n + 1 }));
      doc.set({ n: 99, items: ['a'] });
      // get returns a clone: in-place push must not pollute the store
      doc.get().items.push('MUTANT');
    },
  });
  await host.register({
    id: 'p:docs2',
    definePlugin: (ctx) => {
      const doc = ctx.doc('counter', { n: 0, items: [] as string[] });
      doc.update((s) => ({ ...s, n: s.n + 5 }));
    },
  });

  const a = docs.get('p:docs:counter', { n: -1, items: [] as string[] });
  const b = docs.get('p:docs2:counter', { n: -1, items: [] as string[] });
  assert.equal(a.n, 99);
  assert.deepEqual(a.items, ['a']); // MUTANT does not leak into store
  assert.equal(b.n, 5); // namespace isolated per plugin
});

test('setConfig explicitly rejects with 501 when ConfigStore is absent; persists when provided', { timeout: 60_000 }, async () => {
  const noStore = makeHost();
  await noStore.register({ id: 'p:cfg', definePlugin: () => {} });
  await assert.rejects(noStore.setConfig('p:cfg', { k: 1 }), (err: unknown) => {
    assert.ok(err instanceof HelmxError);
    assert.equal(err.code, 'config_store_unavailable');
    assert.equal(err.status, 501);
    return true;
  });

  const store = new MemoryConfigStore();
  const withStore = makeHost(store);
  await withStore.register({
    id: 'p:cfg2',
    definePlugin: (ctx) => {
      ctx.configSchema({ token: { type: 'string', secret: true } });
    },
  });
  await withStore.setConfig('p:cfg2', { token: 'abc' });
  assert.deepEqual(store.get('p:cfg2'), { token: 'abc' });
  assert.equal(withStore.getConfigSchema('p:cfg2').token?.type, 'string');
});

// ---------------------------------------------------------------------------
// routing / UI collect / dispose
// ---------------------------------------------------------------------------

test('routing declaration relative path: host prepends plugin namespace; rejects full /api prefix, dot segments, query strings, and empty segments', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'triggers',
    definePlugin: (ctx) => {
      ctx.route({
        method: 'POST',
        path: '/hook',
        public: true,
        handler: () => new Response('ok'),
      });
    },
  });
  const routes = host.listRoutes();
  assert.equal(routes.length, 1);
  assert.equal(routes[0]!.path, '/api/plugins/triggers/routes/hook');
  assert.equal(routes[0]!.public, true);

  // smoke number plugin id via encodeURIComponent piece together prefix; parameter segment legal
  const h2 = makeHost();
  await h2.register({
    id: 'builtin:webhook',
    definePlugin: (ctx) => {
      ctx.route({ method: 'GET', path: '/cb', handler: () => new Response('ok') });
    },
  });
  assert.equal(h2.listRoutes()[0]!.path, '/api/plugins/builtin%3Awebhook/routes/cb');
  await h2.register({
    id: 'p:params',
    definePlugin: (ctx) => {
      ctx.route({ method: 'GET', path: '/webhook/:id', handler: () => new Response('ok') });
    },
  });
  assert.ok(
    h2
      .listRoutes()
      .some((r) => r.pluginId === 'p:params' && r.path === '/api/plugins/p%3Aparams/routes/webhook/:id'),
  );

  // Reject full /api prefix (contract accepts relative paths only; host owns plugin namespace prefixing)
  await assertRejectsCode(
    () =>
      host.register({
        id: 'p:evil',
        definePlugin: (ctx) => {
          ctx.route({ method: 'GET', path: '/api/conversations', handler: () => new Response('x') });
        },
      }),
    'invalid_route_path',
  );
  await assertRejectsCode(
    () =>
      host.register({
        id: 'p:evil2',
        definePlugin: (ctx) =>
          void ctx.route({ method: 'GET', path: '/api/plugins/p%3Aevil2/routes/x', handler: () => new Response('x') }),
      }),
    'invalid_route_path',
  );
  // point segment / encode point segment / query string / fragment / empty segment / tail slash / only: relative path form illegal
  const rejectPath = async (suffix: string) => {
    const pluginId = `p:seg-${suffix.length}-${suffix.replaceAll(/[^A-Za-z0-9]/g, 'p')}`;
    await assertRejectsCode(
      () =>
        host.register({
          id: pluginId,
          definePlugin: (ctx) => {
            ctx.route({ method: 'GET', path: suffix, handler: () => new Response('x') });
          },
        }),
      'invalid_route_path',
    );
  };
  await rejectPath('/../x');
  await rejectPath('/%2E%2E/x');
  await rejectPath('/a?b=1');
  await rejectPath('/a#frag');
  await rejectPath('//x');
  await rejectPath('/x/');
  await rejectPath('/');
});

test('UI seven class ten function unify collect can serialization spec; cannot serialization spec reject', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const uiClientRoot = join(dataDir, 'p-ui-client');
  mkdirSync(uiClientRoot, { recursive: true });
  writeFileSync(join(uiClientRoot, 'index.tsx'), 'export function Graph() { return null; }\n');
  await host.register({
    id: 'p:ui',
    clientRoot: uiClientRoot,
    definePlugin: (ctx) => {
      ctx.action({
        id: 'search',
        description: 'search items',
        idempotent: true,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: () => ({ items: [] }),
      });
      ctx.ui.sidebarItem({ id: 'home', label: 'person assist', target: 'conversation:1' });
      ctx.ui.screen({ id: 'graph', label: 'recall graph', client: { module: 'index.tsx', export: 'Graph' } });
      ctx.ui.timelineRenderer({ id: 'report', kinds: ['worker.report'] });
      ctx.ui.markdownCodeBlock({ id: 'fence', languages: ['mermaid'], client: { module: 'index.tsx', export: 'Graph' } });
      ctx.ui.toolView({ id: 'term', toolNames: ['bash'] });
      ctx.ui.composerCompleter({ id: 'at', label: 'Mention', trigger: '@', source: { kind: 'action', actionId: 'search' } });
      ctx.ui.workbenchPanel({ id: 'panel', label: 'artifact' });
      ctx.ui.command({ id: 'cmd', title: 'run inspection', actionPluginId: 'builtin:superagent', actionId: 'patrol' });
      ctx.ui.settingsPanel({ id: 'set', label: 'settings' });
      ctx.ui.slot({ id: 'badge', target: 'p:ui/header', client: { module: 'index.tsx', export: 'Graph' } });
    },
  });
  const ui = host.listUi();
  assert.equal(ui.length, 10);
  const surfaces = new Set(ui.map((u) => u.surface));
  for (const expected of [
    'sidebar.item',
    'screen',
    'timeline.renderer',
    'markdown.codeBlock',
    'tool.view',
    'composer.completer',
    'workbench.panel',
    'commandPalette',
    'settings.panel',
    'plugin.slot',
  ]) {
    assert.ok(surfaces.has(expected), `missing ${expected}`);
  }
  const home = ui.find((u) => u.surface === 'sidebar.item')!;
  assert.deepEqual(home.spec, { id: 'home', label: 'person assist', target: 'conversation:1' });

  await assert.rejects(
    host.register({
      id: 'p:ui-bad',
      definePlugin: (ctx) => {
        // JSON-safe boundary:client of outside any spec field carry function must reject (new contract without json field).
        ctx.ui.screen({ id: 'fn', label: 'x', client: { module: 'index.tsx', export: 'X' }, cb: () => 1 } as never);
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError);
      assert.equal(err.code, 'invalid_ui_spec');
      return true;
    },
  );
});

test('dispose inverse order deactivate all plugin;dispose after invoke explicit errors', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const stops: string[] = [];
  await host.register({
    id: 'p:first',
    definePlugin: (ctx) => {
      ctx.service({ id: 's', start: () => {}, stop: () => { stops.push('first'); } });
    },
  });
  await host.register({
    id: 'p:second',
    definePlugin: (ctx) => {
      ctx.service({ id: 's2', start: () => {}, stop: () => { stops.push('second'); } });
    },
  });
  await host.dispose();
  assert.deepEqual(stops, ['second', 'first']);
  throwsCode(() => host.listActions(), 'plugin_host_disposed');
  await assertRejectsCode(() => host.register({ id: 'p:x', definePlugin: () => {} }), 'plugin_host_disposed');
  await host.dispose(); // idempotent
});

test('cli.command semantic path: valid declarations propagate to manifest; action id forbids dots', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'builtin:triggers',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'cron_create',
        description: 'create cron job',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        cli: { command: ['cron', 'create'] },
        handler: () => ({}),
      });
    },
  });
  const manifest = host.listActions().find((a) => a.id === 'cron_create')!;
  assert.deepEqual(manifest.cli?.command, ['cron', 'create']);

  // action id forbids dots because CLI resolution splits qualified names on the first '.'
  const hDot = makeHost();
  await assertRejectsCode(
    () =>
      hDot.register({
        id: 'p:dot-action',
        definePlugin: (ctx) => {
          ctx.action({
            id: 'cron.create',
            description: 'x',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
            handler: () => ({}),
          });
        },
      }),
    'invalid_action_spec',
  );
  assert.equal(hDot.list().length, 0);
  // doc id and service id still permit dots (dot restriction applies only to action ids)
  await hDot.register({
    id: 'p:dot-ok',
    definePlugin: (ctx) => {
      ctx.doc('cron.create', { n: 0 });
      ctx.service({ id: 'tick.keep', start: () => {}, stop: () => {} });
    },
  });
  assert.equal(hDot.list().length, 1);

  const h2 = makeHost();
  await assertRejectsCode(
    () =>
      h2.register({
        id: 'p:bad-cli',
        definePlugin: (ctx) => {
          ctx.action({
            id: 'x',
            description: 'x',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
            cli: { command: [] },
            handler: () => ({}),
          });
        },
      }),
    'invalid_action_spec',
  );
  await assertRejectsCode(
    () =>
      h2.register({
        id: 'p:bad-cli2',
        definePlugin: (ctx) => {
          ctx.action({
            id: 'x',
            description: 'x',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
            cli: { command: ['ok', ''] },
            handler: () => ({}),
          });
        },
      }),
    'invalid_action_spec',
  );
});

test('duplicate register / unknown plugin / not enabled plugin action invoke all explicit errors', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const def: PluginDefinition = { id: 'p:dup', definePlugin: () => {} };
  await host.register(def);
  await assertRejectsCode(() => host.register(def), 'plugin_already_registered');

  await assertRejectsCode(() => host.disable('p:none'), 'unknown_plugin');
  await assertRejectsCode(() => host.invokeAction('p:none', 'a', {}), 'unknown_plugin');

  await host.register({ id: 'p:off', definePlugin: () => {} });
  await host.disable('p:off');
  await assertRejectsCode(() => host.invokeAction('p:off', 'x', {}), 'plugin_disabled');
});

// ---------------------------------------------------------------------------
// regression:enable rebuild cycle / epoch protect / dataDir
// ---------------------------------------------------------------------------

test('disable→enable rebuild complete register cycle: duplicate ctx.doc / configSchema no longer throw duplicate, durable data keep', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:cycle',
    definePlugin: (ctx) => {
      const doc = ctx.doc('state', { n: 0 });
      doc.set({ n: doc.get().n + 1 }); // each cycle +1
      ctx.configSchema({ token: { type: 'string', secret: true } });
      ctx.action({
        id: 'ping',
        description: 'x',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: () => ({ pong: true }),
      });
      ctx.hook.onInput(() => undefined);
    },
  });
  await host.disable('p:cycle');
  await host.enable('p:cycle'); // old implement this where throw duplicate_doc
  await host.enable('p:cycle'); // again come one round also do not throw duplicate_config_schema

  // doc durable data across cycle keep: two cycle each +1
  const seen = docs.get('p:cycle:state', { n: -1 });
  assert.equal(seen.n, 2);
  // action/hook/schema all rebuild
  assert.deepEqual(await host.invokeAction('p:cycle', 'ping', {}), { pong: true });
  assert.equal(host.getConfigSchema('p:cycle').token?.type, 'string');
  assert.deepEqual(host.list().find((p) => p.id === 'p:cycle')!.hooks, ['input']);
});

test('old context in disable after disallows continue register/modify:epoch make handle i.e. moment expires', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let stolen: Parameters<NonNullable<PluginDefinition['definePlugin']>>[0] | undefined;
  let stolenDoc: ReturnType<Parameters<NonNullable<PluginDefinition['definePlugin']>>[0]['doc']> | undefined;
  await host.register({
    id: 'p:steal',
    definePlugin: (ctx) => {
      stolen = ctx;
      stolenDoc = ctx.doc('k', { n: 0 });
      stolenDoc.set({ n: 0 }); // cycle inside write base allow value, verify after continue expires reject produces no new write
    },
  });
  await host.disable('p:steal');

  // old context: everything register method reject
  throwsCode(() => stolen!.action({ id: 'x', description: 'x', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, handler: () => ({}) }), 'plugin_context_closed');
  throwsCode(() => stolen!.hook.onInput(() => undefined), 'plugin_context_closed');
  throwsCode(() => stolen!.configSchema({ a: { type: 'string' } }), 'plugin_context_closed');
  throwsCode(() => stolen!.route({ method: 'GET', path: '/x', handler: () => new Response('x') }), 'plugin_context_closed');
  // old doc handle: read write reject, and not pollute durable layer (still is cycle inside write 0)
  throwsCode(() => stolenDoc!.set({ n: 1 }), 'plugin_context_expired');
  throwsCode(() => stolenDoc!.get(), 'plugin_context_expired');
  assert.equal(docs.get('p:steal:k', { n: -1 }).n, 0);

  // new cycle re- gets doc handle restore normal (re- register after write verify durable layer)
  await host.unregister('p:steal');
  await host.register({
    id: 'p:steal',
    definePlugin: (ctx) => {
      const fresh = ctx.doc('k', { n: 0 });
      fresh.set({ n: 5 });
    },
  });
  assert.equal(docs.get('p:steal:k', { n: -1 }).n, 5);
  void stolen;
});

test('ctx.dataDir is dedicated plugin subdirectory join(root, plugins, id) and created eagerly', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let seen: string | undefined;
  await host.register({
    id: 'builtin:sub',
    definePlugin: (ctx) => {
      seen = ctx.dataDir;
    },
  });
  // Escape `:` as `%3A` (Windows NTFS alternate data stream rule) via pluginDataDirName.
  assert.equal(seen, join(dataDir, 'plugins', pluginDataDirName('builtin:sub')));
  assert.ok(existsSync(seen!), 'plugin data directory should be created at registration');
});

// ---------------------------------------------------------------------------
// regression: lifecycle async race
// ---------------------------------------------------------------------------

test('disable awaits stop while gating invokeAction/executeTool/runHook; stop failure leaves no fake enabled state', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((res) => (releaseStop = res));
  let stopStarted = false;
  await host.register({
    id: 'p:race',
    definePlugin: (ctx) => {
      ctx.service({
        id: 'svc',
        start: () => {},
        stop: () => {
          stopStarted = true;
          return stopGate;
        },
      });
      ctx.action({
        id: 'ping',
        description: 'x',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: () => ({}),
      });
      ctx.hook.onInput(() => undefined);
    },
  });

  const disabling = host.disable('p:race');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(stopStarted, 'stop should already have started before await settles');
  // While stopping, new invocations reject and hooks skip the disabling plugin's handlers.
  await assertRejectsCode(() => host.invokeAction('p:race', 'ping', {}), 'plugin_disabled');
  await assertRejectsCode(() => host.executeTool('nope', {}, { conversationId: 1 }), 'unknown_tool');
  const hookResult = await host.runHook('input', makeInput());
  assert.equal(hookResult.action, 'continue');
  releaseStop();
  await disabling;
  assert.equal(host.list().find((p) => p.id === 'p:race')!.enabled, false);
});

test('runHook in disable await during do not by execute: not enabled plugin handler never invoke', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((res) => (releaseStop = res));
  let hookRan = false;
  await host.register({
    id: 'p:dying',
    definePlugin: (ctx) => {
      ctx.service({ id: 'svc', start: () => {}, stop: () => stopGate });
      ctx.hook.onInput(() => {
        hookRan = true;
        return { action: 'continue' };
      });
    },
  });
  const disabling = host.disable('p:dying');
  await new Promise((r) => setTimeout(r, 20));
  // stop await in (enabled still true but phase=deactivating):handler do not execute
  const r = await host.runHook('input', makeInput());
  assert.equal(r.action, 'continue');
  assert.equal(hookRan, false);
  releaseStop();
  await disabling;
});

test('teardown phase hides plugin from action listings immediately even while enabled remains true', { timeout: 60_000 }, async () => {
  const host = makeHost();
  try {
    const stopGate = deferred<void>();
    await host.register({
      id: 'p:tearing-down',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          start() {},
          // Pause stop to hold open the teardown window (enabled still true, phase=deactivating)
          stop: () => stopGate.promise,
        });
        ctx.action({
          id: 'ping',
          description: 'probe action',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
          handler: () => ({ pong: true }),
        });
      },
    }, { enabled: true });

    assert.equal(host.listActions().filter((a) => a.pluginId === 'p:tearing-down').length, 1);
    const disabling = host.disable('p:tearing-down', { force: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Inside teardown window: enabled stays true while stop finishes, yet listings clear immediately so stopping services receive no new calls
    assert.equal(host.get('p:tearing-down')?.enabled, true, 'enabled stays true during teardown window');
    assert.deepEqual(host.listActions().filter((a) => a.pluginId === 'p:tearing-down'), [], 'listings clear immediately on teardown entry');
    stopGate.resolve();
    await disabling;
    assert.equal(host.get('p:tearing-down')?.enabled, false);
  } finally {
    await host.dispose();
  }
});

test('register route in (definePlugin await suspended)runHook do not execute not enabled plugin handler', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let releaseDefine!: () => void;
  const defineGate = new Promise<void>((res) => (releaseDefine = res));
  let hookRan = false;
  const registering = host.register({
    id: 'p:defining',
    definePlugin: async (ctx) => {
      ctx.hook.onInput(() => {
        hookRan = true;
        return { action: 'continue' };
      });
      await defineGate;
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  const r = await host.runHook('input', makeInput());
  assert.equal(r.action, 'continue');
  assert.equal(hookRan, false);
  releaseDefine();
  await registering;
  // register after completion can execute
  const r2 = await host.runHook('input', makeInput());
  assert.equal(r2.action, 'transform');
  assert.equal(hookRan, true);
});

test('same plugin enable/disable serial: concurrency invoke do not hand over wrong execute', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const order: string[] = [];
  let gateA!: () => void;
  const g = new Promise<void>((r) => (gateA = r));
  await host.register({
    id: 'p:serial',
    definePlugin: (ctx) => {
      void ctx;
    },
  });
  await host.disable('p:serial');

  const enabling = host.enable('p:serial').then(() => order.push('enable-done'));
  const disabling = host.disable('p:serial').then(() => order.push('disable-done'));
  await Promise.all([enabling, disabling]);
  // serial chain guarantee enable-done first at disable-done(after to wait for before)
  assert.deepEqual(order, ['enable-done', 'disable-done']);
  assert.equal(host.list().find((p) => p.id === 'p:serial')!.enabled, false);
  void gateA;
});

test('disable encounter stop failed: state deactivated (do not fake enabled=true) and error such as on throw', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:stopfail',
    definePlugin: (ctx) => {
      ctx.service({ id: 'svc', start: () => {}, stop: () => { throw new Error('stop crash'); } });
    },
  });
  await assertRejectsCode(() => host.disable('p:stopfail'), 'plugin_service_stop_failed');
  // key: do not dimension hold enabled=true but register already empty fake state
  const summary = host.list().find((p) => p.id === 'p:stopfail')!;
  assert.equal(summary.enabled, false);
  assert.deepEqual(summary.actions, []);
  // again disable idempotent succeeded (deactivated directly return)
  await host.disable('p:stopfail');
});

// ---------------------------------------------------------------------------
// regression: when stop fails after state transition, still emit real plugin.changed
// (enabled: false / ui: []) while clearly distinguishing failures before transition
// ---------------------------------------------------------------------------

/** All captured `plugin.changed` event payloads. */
function changedPayloads(): Array<{ plugin: { id: string; enabled: boolean }; ui: unknown[] }> {
  return eventPayloads
    .filter((e) => e.type === 'plugin.changed')
    .map((e) => e.payload as { plugin: { id: string; enabled: boolean }; ui: unknown[] });
}

/** Declare a full plugin with UI / action / tool / service / host assets (injectable stop handler). */
function fullPlugin(id: string, stop: () => void): PluginDefinition {
  return {
    id,
    definePlugin: (ctx) => {
      ctx.ui.screen({ id: 'scr', label: 'screen' });
      ctx.ui.sidebarItem({ id: 'nav', label: 'navigation' });
      ctx.action({
        id: 'act',
        description: 'action',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        exposeAsTool: true,
        handler: () => ({ ok: true }),
      });
      ctx.tool({
        name: 'direct_tool',
        description: 'tool',
        inputSchema: { type: 'object' },
        execute: () => 'ok',
      });
      ctx.service({ id: 'svc', start: () => {}, stop });
      void ctx.host.manageConversation(7);
    },
  };
}

test('disable stop failure: already deactivated, still emits plugin.changed(enabled:false, ui:[]), rethrows original error, expires capabilities', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register(fullPlugin('p:dfail', () => { throw new Error('svc blast'); }));
  assert.equal(host.listUi().length, 2);
  assert.equal(host.listTools().length, 2);
  assert.ok(events.includes('manage:p:dfail:7'));

  const changedBefore = changedPayloads().length;
  let disableDiag: HelmxError | undefined;
  await assert.rejects(host.disable('p:dfail'), (err: unknown) => {
    assert.ok(err instanceof HelmxError, `expected HelmxError, got: ${String(err)}`);
    assert.equal(err.code, 'plugin_service_stop_failed');
    // Diagnostics are JSON-safe: service ID and stop error message survive HTTP serialization.
    const details = err.details as { pluginId: string; stopErrors: Array<{ serviceId: string; error: { message: string } }> };
    assert.equal(details.pluginId, 'p:dfail');
    assert.deepEqual(
      details.stopErrors.map((e) => [e.serviceId, e.error.message]),
      [['svc', 'svc blast']],
    );
    assert.doesNotThrow(() => JSON.stringify(err.details));
    disableDiag = err;
    return true;
  });
  assert.ok(disableDiag instanceof HelmxError);

  // plugin.changed exactly once,enabled:false,ui:[](do not rely reconnect snapshot only then remove UI)
  const changed = changedPayloads();
  assert.equal(changed.length, changedBefore + 1);
  assert.equal(changed.at(-1)!.plugin.id, 'p:dfail');
  assert.equal(changed.at(-1)!.plugin.enabled, false);
  assert.deepEqual(changed.at(-1)!.ui, []);

  // actual state:list/listUi/listTools/action/tool all expires
  assert.deepEqual(host.listUi(), []);
  assert.deepEqual(host.listTools(), []);
  const summary = host.list().find((p) => p.id === 'p:dfail')!;
  assert.equal(summary.enabled, false);
  assert.deepEqual(summary.actions, []);
  assert.deepEqual(summary.tools, []);
  assert.deepEqual(summary.hooks, []);
  await assertRejectsCode(() => host.invokeAction('p:dfail', 'act', {}), 'plugin_disabled');
  await assertRejectsCode(() => host.executeTool('direct_tool', {}, { conversationId: 1 }), 'unknown_tool');

  // host hosting asset in stop failed path same by release
  assert.ok(events.includes('release:p:dfail:7'));

  // again away unregister(deactivated path): per real remove event (enabled:false / ui:[])
  const beforeUnregister = changedPayloads().length;
  await host.unregister('p:dfail');
  assert.equal(changedPayloads().length, beforeUnregister + 1);
  const removed = changedPayloads().at(-1)!;
  assert.equal(removed.plugin.id, 'p:dfail');
  assert.equal(removed.plugin.enabled, false);
  assert.deepEqual(removed.ui, []);
  assert.equal(host.list().find((p) => p.id === 'p:dfail'), undefined);
});

test('unregister stop failure: plugin removed, still emits plugin.changed(enabled:false, ui:[]), rethrows original error', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register(fullPlugin('p:ufail', () => { throw new Error('svc crash'); }));
  assert.equal(host.listUi().length, 2);

  const changedBefore = changedPayloads().length;
  await assert.rejects(host.unregister('p:ufail'), (err: unknown) => {
    assert.ok(err instanceof HelmxError && err.code === 'plugin_service_stop_failed');
    const details = err.details as { stopErrors: Array<{ serviceId: string; error: { message: string } }> };
    assert.deepEqual(
      details.stopErrors.map((e) => [e.serviceId, e.error.message]),
      [['svc', 'svc crash']],
    );
    assert.doesNotThrow(() => JSON.stringify(err.details));
    return true;
  });

  const changed = changedPayloads();
  assert.equal(changed.length, changedBefore + 1);
  assert.equal(changed.at(-1)!.plugin.id, 'p:ufail');
  assert.equal(changed.at(-1)!.plugin.enabled, false);
  assert.deepEqual(changed.at(-1)!.ui, []);

  // Registry entry is already removed
  assert.equal(host.list().find((p) => p.id === 'p:ufail'), undefined);
  assert.deepEqual(host.listUi(), []);
  assert.deepEqual(host.listTools(), []);
  assert.ok(events.includes('release:p:ufail:7'));
});

test('stop and event publish both fail: preserves stop diagnostics (adds eventError) without masking root cause', { timeout: 60_000 }, async () => {
  const stopErr = new Error('stop diagnose');
  // Throw on `plugin.changed` in emitEvent while forwarding other events normally.
  const backend = makeHostApi(events);
  const originalEmit = backend.emitEvent;
  let emitBroken = false;
  backend.emitEvent = (type: string, payload: unknown) => {
    if (emitBroken && type === 'plugin.changed') throw new Error('event pipeline crash');
    originalEmit.call(backend, type, payload);
  };
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs });
  await host.register(fullPlugin('p:double', () => { throw stopErr; }));
  emitBroken = true;

  // Teardown failure stays `HelmxError(plugin_service_stop_failed)` with JSON-safe diagnostics.
  await assert.rejects(host.disable('p:double'), (err: unknown) => {
    assert.ok(err instanceof HelmxError, `expected HelmxError, got: ${String(err)}`);
    assert.equal(err.code, 'plugin_service_stop_failed');
    const details = err.details as {
      stopErrors?: Array<{ serviceId: string; error: { name: string; message: string } }>;
      eventError?: { name: string; message: string };
    };
    const stopDiag = details.stopErrors?.find((e) => e.serviceId === 'svc')?.error;
    assert.equal(stopDiag?.message, 'stop diagnose', 'stop diagnostic preserves original message in details.stopErrors');
    assert.equal(stopDiag?.name, 'Error');
    assert.equal(details.eventError?.message, 'event pipeline crash', 'event publish error aggregate in details.eventError(original message)');
    assert.equal(details.eventError?.name, 'Error');
    // the whole details must can serialization (HTTP error message seal out station hard rule)
    assert.doesNotThrow(() => JSON.stringify(details));
    return true;
  });
  // actual state still: deactivated (event failed do not rollback state, also do not fake report succeeded)
  assert.equal(host.list().find((p) => p.id === 'p:double')!.enabled, false);
});

test('real HTTP bridge:stop failed disable error message seal can serialization can redaction (500 plugin_service_stop_failed),UI event still reach', { timeout: 60_000 }, async () => {
  // real AuthService + SecretStash + createHubHandler: verify error message seal truly out obtain remove
  // (redactJsonValue strictly reject Error- - if diagnose not in produce where archive one, this in will change 500 invalid_json_value)
  const auth = new AuthService(dataDir);
  const stash = new SecretStash();
  const secretValue = 'sk-stopfail-supersecret';
  stash.addRedaction(secretValue);
  const httpHost = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: makeHostApi(events), docs });
  await httpHost.register(fullPlugin('p:http', () => { throw new Error(`stop failed contains secret ${secretValue}`); }));

  const kernel = {
    dataDir,
    auth,
    events: { response: () => new Response(null, { status: 500 }) },
    plugins: httpHost,
    stash,
  } as unknown as KernelRuntimeLike;
  const handler = createHubHandler(kernel);

  const setup = await handler(new Request('http://127.0.0.1:3202/api/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pw-stopfail-test' }),
  }));
  assert.equal(setup.status, 200);
  const token = ((await setup.json()) as { token: string }).token;
  const authed = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const changedBefore = changedPayloads().length;
  // POST /api/plugins/:id/disable:500 plugin_service_stop_failed, message seal real serialization succeeded
  const res = await handler(new Request('http://127.0.0.1:3202/api/plugins/p:http/disable', { method: 'POST', headers: authed }));
  assert.equal(res.status, 500);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  const body = (await res.json()) as {
    error: {
      code: string;
      message: string;
      details: { pluginId: string; stopErrors: Array<{ serviceId: string; error: { name: string; message: string } }> };
    };
  };
  assert.equal(body.error.code, 'plugin_service_stop_failed');
  assert.equal(body.error.details.pluginId, 'p:http');
  assert.deepEqual(
    body.error.details.stopErrors.map((e) => [e.serviceId, e.error.name, e.error.message]),
    [['svc', 'Error', 'stop failed contains secret [REDACTED]']],
    'service ID and original stop message keep, secret one by one value redaction',
  );

  // state deactivated and plugin.changed event in error before already reach (enabled:false / ui:[])
  assert.equal(httpHost.list().find((p) => p.id === 'p:http')!.enabled, false);
  assert.equal(changedPayloads().length, changedBefore + 1);
  assert.deepEqual(changedPayloads().at(-1)!.ui, []);
});

test('real HTTP bridge: double failed (stop + event publish) message seal same can serialization and keep double diagnose', { timeout: 60_000 }, async () => {
  const auth = new AuthService(dataDir);
  const backend = makeHostApi(events);
  // event pipeline crash:emitEvent in plugin.changed when throws, and stop failed stack add
  const originalEmit = backend.emitEvent;
  let emitBroken = false;
  backend.emitEvent = (type: string, payload: unknown) => {
    if (emitBroken && type === 'plugin.changed') throw new Error('event pipeline crash');
    originalEmit.call(backend, type, payload);
  };
  const httpHost = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs });
  await httpHost.register(fullPlugin('p:dbl', () => { throw new Error('stop double failed diagnose'); }));
  emitBroken = true;

  const kernel = {
    dataDir,
    auth,
    events: { response: () => new Response(null, { status: 500 }) },
    plugins: httpHost,
  } as unknown as KernelRuntimeLike;
  const handler = createHubHandler(kernel);
  const setup = await handler(new Request('http://127.0.0.1:3202/api/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pw-dbl-test' }),
  }));
  const token = ((await setup.json()) as { token: string }).token;

  const res = await handler(new Request('http://127.0.0.1:3202/api/plugins/p:dbl/disable', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  }));
  assert.equal(res.status, 500);
  const body = (await res.json()) as {
    error: {
      code: string;
      details: {
        stopErrors: Array<{ serviceId: string; error: { message: string } }>;
        eventError: { name: string; message: string };
      };
    };
  };
  // main error still is stop failed (do not mask), double diagnose all can serialization and keep original message
  assert.equal(body.error.code, 'plugin_service_stop_failed');
  assert.deepEqual(
    body.error.details.stopErrors.map((e) => [e.serviceId, e.error.message]),
    [['svc', 'stop double failed diagnose']],
  );
  assert.deepEqual(body.error.details.eventError, { name: 'Error', message: 'event pipeline crash' });
  // state still deactivated
  assert.equal(httpHost.list().find((p) => p.id === 'p:dbl')!.enabled, false);
});

// ---------------------------------------------------------------------------
// regression:plugin.changed event and failed do not fake report
// ---------------------------------------------------------------------------

test('register/enable/disable/unregister after success plugin.changed event; without state change reject do not', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const changed = () => events.filter((e) => e === 'event:plugin.changed').length;
  await host.register({ id: 'p:ev', definePlugin: () => {} });
  assert.equal(changed(), 1);
  await host.disable('p:ev');
  assert.equal(changed(), 2);
  await host.enable('p:ev');
  assert.equal(changed(), 3);
  await host.unregister('p:ev');
  assert.equal(changed(), 4);

  // reject but without state change (locked / in-flight task / missing) do not fake change event
  const h2 = makeHost();
  await h2.register({ id: 'p:locked', locked: true, definePlugin: () => {} });
  const before = events.length;
  await assertRejectsCode(() => h2.disable('p:locked'), 'plugin_locked');
  await assertRejectsCode(() => h2.unregister('p:locked'), 'plugin_locked');
  await assertRejectsCode(() => h2.disable('p:none'), 'unknown_plugin');
  await assertRejectsCode(() => h2.unregister('p:none'), 'unknown_plugin');
  assert.equal(events.length, before); // reject not new increase event
});

test('plugin.changed carry ui contribution: enable contains all declaration, deactivate/unload is empty array', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:ui-sync',
    definePlugin: (ctx) => {
      ctx.ui.screen({ id: 'graph', label: 'graph' });
      ctx.ui.sidebarItem({ id: 'home', label: 'main page' });
    },
  });
  const changedEvents = () =>
    eventPayloads
      .filter((e) => e.type === 'plugin.changed')
      .map((e) => e.payload as { plugin: { id: string }; ui: Array<{ surface: string; spec: { id?: string } }> });

  // register (enable) event:ui contains the plugin all contribution
  const registered = changedEvents().at(-1)!;
  assert.equal(registered.plugin.id, 'p:ui-sync');
  assert.deepEqual(
    registered.ui.map((u) => `${u.surface}:${String(u.spec.id)}`).sort(),
    ['screen:graph', 'sidebar.item:home'],
  );

  // deactivate:ui is empty array (frontend rely on single frame remove the plugin all UI, do not rely polling/reconnect)
  await host.disable('p:ui-sync');
  const disabled = changedEvents().at(-1)!;
  assert.equal(disabled.plugin.id, 'p:ui-sync');
  assert.deepEqual(disabled.ui, []);

  // re- enable:ui restore all contribution
  await host.enable('p:ui-sync');
  const enabled = changedEvents().at(-1)!;
  assert.equal(enabled.ui.length, 2);

  // unload:ui again is empty
  await host.unregister('p:ui-sync');
  const unregistered = changedEvents().at(-1)!;
  assert.deepEqual(unregistered.ui, []);

  // only carry this plugin contribution: another plugin event excludes other person UI
  await host.register({
    id: 'p:other',
    definePlugin: (ctx) => {
      ctx.ui.screen({ id: 'other-screen', label: 'another' });
    },
  });
  const other = changedEvents().at(-1)!;
  assert.equal(other.plugin.id, 'p:other');
  assert.ok(other.ui.every((u) => String(u.spec.id) === 'other-screen'));
});

// ---------------------------------------------------------------------------
// regression:JSON-safe boundary (ui spec / doc / action output)
// ---------------------------------------------------------------------------

test('ui spec boundary refuse Map/Date/BigInt/loop/undefined:structuredClone will let through but JSON must lose data', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const bad: Array<[string, unknown]> = [
    ['Map', { id: 'x', json: { m: new Map([[1, 2]]) } }],
    ['Set', { id: 'x', json: { s: new Set([1]) } }],
    ['Date', { id: 'x', json: { d: new Date(0) } }],
    ['BigInt', { id: 'x', json: { b: 10n } }],
    ['undefined', { id: 'x', json: { u: undefined } }],
    ['NaN', { id: 'x', json: { n: NaN } }],
    ['fn', { id: 'x', cb: () => 1 }],
    ['cycle', (() => { const o: Record<string, unknown> = { id: 'x' }; o.self = o; return o; })()],
  ];
  for (const [label, spec] of bad) {
    await assert.rejects(
      host.register({ id: `p:ui-json-${label}`, definePlugin: (ctx) => void ctx.ui.screen(spec as never) }),
      (err: unknown) => {
        assert.ok(err instanceof HelmxError, `${label} should refuse`);
        assert.equal(err.code, 'invalid_ui_spec', `${label} should invalid_ui_spec`);
        return true;
      },
    );
  }
  // legal spec(finite number array + null + pure object) accept
  await host.register({
    id: 'p:ui-ok',
    definePlugin: (ctx) => {
      ctx.ui.screen({ id: 'fine', label: 'Fine', nums: [1, 2.5], nil: null, s: 'x' } as never);
    },
  });
  const ui = host.listUi();
  assert.equal(ui.length, 1);
  // artifact itself can without loss JSON serialization
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(ui)));
});

test('doc initial value/set/update boundary refuse non- JSON value; legal pure object/finite number array/null accept', { timeout: 60_000 }, async () => {
  const host = makeHost();
  // initial value contains Map: register failed rollback (invalid_json_value is HelmxError, original on throw)
  await assert.rejects(
    host.register({
      id: 'p:doc-bad-init',
      definePlugin: (ctx) => {
        ctx.doc('m', { m: new Map() } as never);
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError);
      assert.equal(err.code, 'invalid_json_value');
      return true;
    },
  );
  assert.equal(host.list().length, 0);

  let doc: PluginDocHandle<{ n: number; items: string[] }> | undefined;
  await host.register({
    id: 'p:doc',
    definePlugin: (ctx) => {
      doc = ctx.doc('k', { n: 0, items: [] });
    },
  });
  doc!.set({ n: 1, items: ['a'] }); // legal set do not throw
  assert.equal(docs.get('p:doc:k', { n: -1, items: [] }).n, 1);
  throwsCode(() => doc!.set({ n: NaN, items: [] } as never), 'invalid_json_value');
  throwsCode(() => doc!.set({ n: 1, items: ['a'], d: new Date() } as never), 'invalid_json_value');
  // Reject undefined fields rather than silently stripping them
  throwsCode(() => doc!.set({ n: 1, items: [], extra: undefined } as never), 'invalid_json_value');
  // Rejected updates likewise leave storage clean
  throwsCode(
    () =>
      doc!.update(() => ({ n: 1, items: [10n as unknown as string] })),
    'invalid_json_value',
  );
  // Backing store stays untouched
  const cur = docs.get('p:doc:k', { n: -1, items: [] });
  assert.equal(cur.n, 1);
  assert.deepEqual(cur.items, ['a']);
  // get returns a JSON-safe clone
  const got = doc!.get();
  assert.deepEqual(got, { n: 1, items: ['a'] });
  got.items.push('MUT');
  assert.deepEqual(docs.get('p:doc:k', { n: -1, items: [] }).items, ['a']);
});

test('action output with Map/undefined/cycles fails explicitly at boundary without silent data loss', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:out',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'map-out',
        description: 'x',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: () => ({ m: new Map([[1, 2]]) }) as never,
      });
      ctx.action({
        id: 'undef-out',
        description: 'x',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: () => ({ a: 1, b: undefined }),
      });
    },
  });
  await assertRejectsCode(() => host.invokeAction('p:out', 'map-out', {}), 'invalid_json_value');
  await assertRejectsCode(() => host.invokeAction('p:out', 'undef-out', {}), 'invalid_json_value');
});

// ---------------------------------------------------------------------------
// regression: $async Schema and register-phase precompilation
// ---------------------------------------------------------------------------

test('action declaration with $async schema fails immediately at register boundary (invalid_plugin_schema) with full rollback', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await assertRejectsCode(
    () =>
      host.register({
        id: 'p:async-schema',
        definePlugin: (ctx) => {
          ctx.action({
            id: 'a',
            description: 'x',
            inputSchema: { type: 'object', $async: true },
            outputSchema: { type: 'object' },
            handler: () => ({}),
          });
        },
      }),
    'invalid_plugin_schema',
  );
  assert.equal(host.list().length, 0);

  // Uncompilable schema also rolls back at register boundary instead of waiting for first invocation
  await assertRejectsCode(
    () =>
      host.register({
        id: 'p:bad-schema2',
        definePlugin: (ctx) => {
          ctx.action({
            id: 'a',
            description: 'x',
            inputSchema: { type: 'quux' } as never,
            outputSchema: { type: 'object' },
            handler: () => ({}),
          });
        },
      }),
    'invalid_plugin_schema',
  );
  assert.equal(host.list().length, 0);
});

test('$async schema passed directly to validatePluginInput still rejects invalid input rather than treating Promise as truthy', { timeout: 60_000 }, async () => {
  // AJV $async validators return a Promise; boolean checks would mistakenly accept them as truthy.
  // Verify direct calls reject invalid input synchronously as well as at compile time.
  const schema = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], $async: true } as never;
  throwsCode(() => validatePluginInput('p', 'a', schema, { n: 'not-a-number' }), 'invalid_plugin_schema');
});

// ---------------------------------------------------------------------------
// regression:provider-safe tool name
// ---------------------------------------------------------------------------

test('exposeAsTool derive tool name provider-safe: simulated provider request tool name regex all via', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'builtin:test',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'do_thing',
        description: 'underscore action',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        exposeAsTool: true,
        handler: () => ({ ok: true }),
      });
      ctx.tool({
        name: 'plain_tool',
        description: 'x',
        inputSchema: { type: 'object' },
        execute: () => 'ok',
      });
    },
  });
  const tools = host.listTools();
  // OpenAI function name constraint:^[a-zA-Z0-9_-]{1,64}$(real provider will reject the rest form)
  const providerToolNameRegex = /^[a-zA-Z0-9_-]{1,64}$/;
  for (const t of tools) {
    assert.match(t.name, providerToolNameRegex, `tool name ${t.name} not via provider regex`);
  }
  const derived = tools.find((t) => t.sourceKind === 'action')!;
  assert.equal(derived.qualifiedId, 'builtin:test.do_thing');
  // alias stable (across host instance same name same id same hash)
  assert.equal(derived.name, actionToolAlias('builtin:test', 'do_thing'));
  // manifest still use original ID:run_action / HTTP / CLI do not subject to alias affect
  assert.equal(host.listActions().find((a) => a.id === 'do_thing')!.pluginId, 'builtin:test');
  // executeTool alias mapping back original action and via schema validate
  assert.deepEqual(await host.executeTool(derived.name, {}, { conversationId: 1 }), { ok: true });
  // all limit set name still can parse
  assert.deepEqual(await host.executeTool('builtin:test.do_thing', {}, { conversationId: 1 }), { ok: true });
});

test('ctx.tool name provider-safe validate: point/over long reject; different long id alias do not collision', { timeout: 60_000 }, async () => {
  const host = makeHost();
  // point and over long can through use id validate but however provider-safe validate
  for (const [i, name] of ['has.dot', 'a'.repeat(65)].entries()) {
    await assertRejectsCode(
      () =>
        host.register({
          id: `p:tn-${i}`,
          definePlugin: (ctx) =>
            void ctx.tool({ name, description: 'x', inputSchema: { type: 'object' }, execute: () => 'ok' }),
        }),
      'invalid_tool_spec',
    );
  }
  // smoke number/space/empty name in through use id validate i.e. refuse (invalid_identifier), same rollback
  for (const [i, name] of ['has:colon', 'has space', ''].entries()) {
    await assertRejectsCode(
      () =>
        host.register({
          id: `p:tn2-${i}`,
          definePlugin: (ctx) =>
            void ctx.tool({ name, description: 'x', inputSchema: { type: 'object' }, execute: () => 'ok' }),
        }),
      'invalid_identifier',
    );
  }
  // legal name normal register (64 cap boundary)
  await host.register({
    id: 'p:tn-ok',
    definePlugin: (ctx) => {
      ctx.tool({ name: 'a'.repeat(64), description: 'x', inputSchema: { type: 'object' }, execute: () => 'ok' });
      ctx.tool({ name: 'ab-01_XY', description: 'x', inputSchema: { type: 'object' }, execute: () => 'ok' });
    },
  });
  assert.equal(host.listTools().length, 2);

  // alias do not collision: two plugin same action id, same plugin different action, cleanse after prefix identical also do not conflict
  const h2 = makeHost();
  await h2.register({
    id: 'p:one',
    definePlugin: (ctx) => {
      ctx.action({ id: 'run', description: 'x', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, exposeAsTool: true, handler: () => ({}) });
      ctx.action({ id: 'run_x', description: 'x', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, exposeAsTool: true, handler: () => ({}) });
    },
  });
  await h2.register({
    id: 'p:on-e',
    definePlugin: (ctx) => {
      ctx.action({ id: 'run', description: 'x', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, exposeAsTool: true, handler: () => ({}) });
    },
  });
  const names = h2.listTools().map((t) => t.name);
  assert.equal(new Set(names).size, names.length); // three alias mutual do not identical
});

// ---------------------------------------------------------------------------
// regression:hook payload validate tight (model empty string / number field integer / trigger.id)
// ---------------------------------------------------------------------------

test('model allows empty string: without model config root conversation also can before_turn validate', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let ran = false;
  await host.register({
    id: 'p:bt',
    definePlugin: (ctx) => {
      ctx.hook.onBeforeTurn(() => {
        ran = true;
      });
    },
  });
  const conv = makeConversation(1);
  conv.model = ''; // not config model conversation
  // do not throw invalid_hook_result and hook normal execute
  const r = await host.runHook('before_turn', { conversation: conv, inputs: [], tools: [], sections: [], messages: [] });
  assert.equal(r.action, 'transform');
  assert.equal(ran, true);
});

test('hook number field tight: non- integer/negative id/negative seq reject, legal empty text by default data via', { timeout: 60_000 }, async () => {
  const host = makeHost();
  // drive plugin: payload validate only for actual reference and pipeline execute
  await host.register({
    id: 'p:drive',
    definePlugin: (ctx) => {
      ctx.hook.onBeforeTurn(() => undefined);
      ctx.hook.onInput(() => undefined);
    },
  });
  const expectInvalid = async (operation: Promise<unknown>) => {
    await assert.rejects(operation, (err: unknown) => {
      assert.ok(err instanceof HelmxError);
      assert.equal(err.code, 'invalid_hook_result');
      return true;
    });
  };
  // conversation.id must positive integer;seq class field non- negative integer
  await expectInvalid(
    host.runHook('before_turn', { conversation: { ...makeConversation(1), id: 1.5 }, inputs: [], tools: [], sections: [], messages: [] }),
  );
  await expectInvalid(
    host.runHook('before_turn', { conversation: { ...makeConversation(1), id: 0 }, inputs: [], tools: [], sections: [], messages: [] }),
  );
  await expectInvalid(
    host.runHook('before_turn', { conversation: { ...makeConversation(1), stateChangeSeq: -1 }, inputs: [], tools: [], sections: [], messages: [] }),
  );
  await expectInvalid(
    host.runHook('input', { conversationId: 1, input: { id: 'i', text: 'hi', origin: 'human', createdAt: -1 } }),
  );
  await expectInvalid(
    host.runHook('input', { conversationId: 1.5, input: { id: 'i', text: 'hi', origin: 'human', createdAt: 1 } }),
  );

  // legal empty text(by default data) do not reject: only type validate do not force non-empty;createdAt=0 legal
  const ok = await host.runHook('input', { conversationId: 1, input: { id: 'i', text: '', origin: 'human', createdAt: 0 } });
  assert.equal(ok.action, 'transform');
});

// ---------------------------------------------------------------------------
// ctx.host.execEnv / prepareAction / idempotent
// ---------------------------------------------------------------------------

test('ctx.host.execEnv: real invoke backend(required port)+ in-flight task protect (withTask) block stop disable', { timeout: 60_000 }, async () => {
  let finishExec!: (res: { ok: boolean; exitCode: number; output: string; timedOut: boolean }) => void;
  const execPromise = new Promise<{ ok: boolean; exitCode: number; output: string; timedOut: boolean }>((resolve) => {
    finishExec = resolve;
  });

  const backend: PluginHostBackend = {
    ...makeHostApi(events),
    execEnv: async () => {
      return execPromise;
    },
  };
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs });

  let actionPromise!: Promise<unknown>;
  await host.register({
    id: 'p:exec-live',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'run-cmd',
        description: 'run',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        async handler() {
          const res = await ctx.host.execEnv({ command: 'long-job' });
          return { out: res.output };
        },
      });
    },
  });

  // start action, card in execEnv in
  actionPromise = host.invokeAction('p:exec-live', 'run-cmd', {});
  await new Promise((r) => setTimeout(r, 20));

  // now in-flight has host.execEnv and action:p:exec-live.run-cmd,disable must by 409 reject
  await assertRejectsCode(() => host.disable('p:exec-live'), 'plugin_has_live_tasks', 409);

  // let through execEnv
  finishExec({ ok: true, exitCode: 0, output: 'finished', timedOut: false });
  const actionRes = (await actionPromise) as { out: string };
  assert.equal(actionRes.out, 'finished');

  // in-flight task empty after, can succeeded disable
  await host.disable('p:exec-live');
  assert.equal(host.list().find((p) => p.id === 'p:exec-live')!.enabled, false);
});

test('ctx.action idempotent: register phase validate and manifest reverse reflect', { timeout: 60_000 }, async () => {
  const host = makeHost();
  // must be boolean
  await assert.rejects(
    host.register({
      id: 'p:bad-idempotent',
      definePlugin: (ctx) => {
        ctx.action({
          id: 'act',
          description: 'x',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          idempotent: 'yes' as never,
          handler: () => ({}),
        });
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError);
      assert.equal(err.code, 'validation_error');
      return true;
    },
  );

  await host.register({
    id: 'p:good-idempotent',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'read-act',
        description: 'x',
        idempotent: true,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: () => ({}),
      });
      ctx.action({
        id: 'write-act',
        description: 'x',
        idempotent: false,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: () => ({}),
      });
    },
  });

  const manifests = host.listActions();
  const readM = manifests.find((m) => m.id === 'read-act');
  const writeM = manifests.find((m) => m.id === 'write-act');
  assert.equal(readM?.idempotent, true);
  assert.equal(writeM?.idempotent, false);
});

test('prepareAction:Pre-flight pre- validate state,scope and inputSchema and return idempotent', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:prep',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'safe-read',
        description: 'x',
        idempotent: true,
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
        outputSchema: { type: 'object' },
        handler: () => ({}),
      });
    },
  });

  // 1) validate via, return define end idempotent: true
  const prepOk = host.prepareAction('p:prep', 'safe-read', { name: 'helmx' });
  assert.equal(prepOk.idempotent, true);

  // 2) unknown action -> 404
  throwsCode(() => host.prepareAction('p:prep', 'non-existent', {}), 'unknown_action');

  // 3) inputSchema validation failed -> 400 validation_error
  throwsCode(() => host.prepareAction('p:prep', 'safe-read', { name: 123 }), 'validation_error');

  // 4) plugin not enabled -> 409 plugin_disabled
  await host.disable('p:prep');
  throwsCode(() => host.prepareAction('p:prep', 'safe-read', { name: 'helmx' }), 'plugin_disabled');
});

test('doc lifecycle regression: same ID unload after re- register (epoch reset is 1), old doc handle all reject and no side effects, new handle available', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let oldHandle: PluginDocHandle<{ count: number }> | undefined;
  let newHandle: PluginDocHandle<{ count: number }> | undefined;

  // 1. register plugin P and get old doc handle (initial epoch is 1)
  await host.register({
    id: 'p:doc-lifecycle',
    definePlugin: (ctx) => {
      oldHandle = ctx.doc('state', { count: 10 }, { public: true });
    },
  });

  assert.ok(oldHandle);
  assert.deepEqual(oldHandle.get(), { count: 10 });
  oldHandle.set({ count: 20 });
  assert.deepEqual(oldHandle.get(), { count: 20 });

  // 2. cancel register P
  await host.unregister('p:doc-lifecycle');

  // empty event history with convenient precise allow assertion after continue no side effects
  eventPayloads.length = 0;
  const storeBefore = (docs as unknown as { get: (k: string, init: unknown) => unknown }).get('p:doc-lifecycle:state', null);

  // 3. again with identical ID register P(all new PluginState,epoch re- is 1)
  await host.register({
    id: 'p:doc-lifecycle',
    definePlugin: (ctx) => {
      newHandle = ctx.doc('state', { count: 100 }, { public: true });
    },
  });

  assert.ok(newHandle);
  // New handle reads persisted value
  assert.deepEqual(newHandle.get(), { count: 20 });

  // 4. Old handle get / set / update / flush all reject with plugin_context_expired
  throwsCode(() => oldHandle!.get(), 'plugin_context_expired');
  throwsCode(() => oldHandle!.set({ count: 999 }), 'plugin_context_expired');
  throwsCode(() => oldHandle!.update((s) => ({ count: s.count + 1 })), 'plugin_context_expired');
  await assert.rejects(
    async () => {
      await oldHandle!.flush();
    },
    (err: unknown) => err instanceof HelmxError && err.code === 'plugin_context_expired',
  );

  // 5. Rejected old handle produces no store mutation or event side effects
  assert.deepEqual((docs as unknown as { get: (k: string, init: unknown) => unknown }).get('p:doc-lifecycle:state', null), storeBefore);
  const docUpdatedEvents = eventPayloads.filter((e) => e.type === 'plugin.doc.updated');
  assert.equal(docUpdatedEvents.length, 0, 'rejected operations on expired doc handle must not emit plugin.doc.updated');

  // 6. New handle remains fully operational
  newHandle.set({ count: 42 });
  assert.deepEqual(newHandle.get(), { count: 42 });
  await newHandle.flush();
  assert.deepEqual((docs as unknown as { get: (k: string, init: unknown) => unknown }).get('p:doc-lifecycle:state', null), { count: 42 });
});

test('in-flight client module compile regression: unregister then re-register same ID (epoch resets to 1) rejects stale artifact', { timeout: 60_000 }, async (t) => {
  let compileStartedResolve!: () => void;
  const compileStarted = new Promise<void>((r) => { compileStartedResolve = r; });
  let compileFinishResolve!: () => void;
  const compileFinishGate = new Promise<void>((r) => { compileFinishResolve = r; });

  const host = makeHost(undefined, {
    buildProvider: {
      compileClientModule: async () => {
        compileStartedResolve();
        await compileFinishGate;
        return {
          code: `console.log('compiled')`,
          contentHash: 'hash-v1',
          exports: [],
        };
      },
      transformBackendTs: () => {
        throw new HelmxError('not_supported', 'test stub does not provide backend transpilation', 501);
      },
    },
  });
  t.after(() => host.dispose());

  const clientDir = join(dataDir, 'client-src');
  mkdirSync(clientDir, { recursive: true });

  const def: PluginDefinition = {
    id: 'p:client-race',
    clientRoot: clientDir,
    definePlugin: () => {},
  };

  // 1. Register plugin P
  await host.register(def);

  // 2. Start compiling client module and suspend at test gate
  const compilingPromise = host.getClientModule('p:client-race', 'index.tsx');

  // Wait deterministically for compile to enter suspended state
  await compileStarted;

  // 3. Unregister P while compile is in-flight
  await host.unregister('p:client-race');

  // 4. Re-register P with identical ID (fresh PluginState with epoch=1, phase=idle)
  await host.register(def);

  // 5. Release compile gate
  compileFinishResolve();

  // 6. Verify stale in-flight compile rejects due to mismatched registration identity (409 plugin_client_unavailable)
  await assert.rejects(
    compilingPromise,
    (err: unknown) => err instanceof HelmxError && err.code === 'plugin_client_unavailable',
  );
});

// ---------------------------------------------------------------------------
// clientHashes precompilation lifecycle, hot reload, and client.mjs ?hash= immutable cache
// ---------------------------------------------------------------------------

test('clientHashes: precompiled on register/enable, carried in list/get/plugin.changed, cleared on disable/unregister', { timeout: 60_000 }, async (t) => {
  const host = makeHost();
  t.after(() => host.dispose());

  const changedSummaries = () =>
    eventPayloads
      .filter((e) => e.type === 'plugin.changed')
      .map((e) => (e.payload as { plugin: { id: string; enabled: boolean; status: string; clientHashes?: Record<string, string> } }).plugin);

  // 1. Plugin without client UI modules never carries clientHashes.
  await host.register({
    id: 'p:no-client-ui',
    definePlugin: (ctx) => {
      ctx.ui.sidebarItem({ id: 'home', label: 'Home', target: 'conversation:1' });
    },
  });
  assert.equal(host.get('p:no-client-ui')?.clientHashes, undefined);
  assert.equal(host.list().find((p) => p.id === 'p:no-client-ui')?.clientHashes, undefined);
  assert.equal(changedSummaries().at(-1)?.clientHashes, undefined);

  // 2. Plugin with multiple declared client modules (including duplicate moduleRef across surfaces).
  const clientRoot = join(dataDir, 'hashes-client');
  mkdirSync(join(clientRoot, 'panels'), { recursive: true });
  writeFileSync(join(clientRoot, 'index.tsx'), 'export function MainScreen() { return "v1"; }\nexport function SideWidget() { return "w1"; }\n');
  writeFileSync(join(clientRoot, 'panels', 'Extra.tsx'), 'export function ExtraPanel() { return "e1"; }\n');

  const multiUiDef: PluginDefinition = {
    id: 'p:multi-client',
    clientRoot,
    definePlugin: (ctx) => {
      ctx.ui.screen({ id: 'main', label: 'Main', client: { module: 'index.tsx', export: 'MainScreen' } });
      ctx.ui.slot({ id: 'widget', target: 'p:multi-client/side', client: { module: 'index.tsx', export: 'SideWidget' } });
      ctx.ui.workbenchPanel({ id: 'extra', label: 'Extra', client: { module: 'panels/Extra.tsx', export: 'ExtraPanel' } });
    },
  };

  // Registered disabled: must NOT precompile or expose clientHashes.
  await host.register(multiUiDef, { enabled: false });
  assert.equal(host.get('p:multi-client')?.clientHashes, undefined);
  assert.equal(changedSummaries().at(-1)?.clientHashes, undefined);

  // Enable: precompiles every declared moduleRef and publishes hashes in list/get/plugin.changed.
  await host.enable('p:multi-client');
  const mainCompiled = await host.getClientModule('p:multi-client', 'index.tsx');
  const extraCompiled = await host.getClientModule('p:multi-client', 'panels/Extra.tsx');
  const expectedHashes = {
    'index.tsx': mainCompiled.contentHash,
    'panels/Extra.tsx': extraCompiled.contentHash,
  };
  assert.deepEqual(host.get('p:multi-client')?.clientHashes, expectedHashes);
  assert.deepEqual(host.list().find((p) => p.id === 'p:multi-client')?.clientHashes, expectedHashes);
  assert.deepEqual(changedSummaries().at(-1)?.clientHashes, expectedHashes);

  // Disable: clears clientHashes immediately across get/list/plugin.changed.
  await host.disable('p:multi-client');
  assert.equal(host.get('p:multi-client')?.clientHashes, undefined);
  assert.equal(host.list().find((p) => p.id === 'p:multi-client')?.clientHashes, undefined);
  assert.equal(changedSummaries().at(-1)?.clientHashes, undefined);

  // Modify source while disabled and re-enable: updated module gets new hash.
  writeFileSync(join(clientRoot, 'index.tsx'), 'export function MainScreen() { return "v2-updated"; }\nexport function SideWidget() { return "w2"; }\n');
  await host.enable('p:multi-client');
  const mainV2 = await host.getClientModule('p:multi-client', 'index.tsx');
  assert.notEqual(mainV2.contentHash, mainCompiled.contentHash);
  assert.deepEqual(host.get('p:multi-client')?.clientHashes, {
    'index.tsx': mainV2.contentHash,
    'panels/Extra.tsx': extraCompiled.contentHash,
  });

  // Unregister: plugin.changed clears clientHashes.
  await host.unregister('p:multi-client');
  const afterUnregister = changedSummaries().at(-1)!;
  assert.equal(afterUnregister.id, 'p:multi-client');
  assert.equal(afterUnregister.enabled, false);
  assert.equal(afterUnregister.clientHashes, undefined);
});

test('clientHashes: precompile failure preserves explicit error and isolated failure diagnostic without fabricating hashes', { timeout: 60_000 }, async (t) => {
  const host = makeHost();
  t.after(() => host.dispose());

  const brokenRoot = join(dataDir, 'broken-client');
  mkdirSync(brokenRoot, { recursive: true });
  writeFileSync(join(brokenRoot, 'index.tsx'), 'export const Broken = (((\n');

  const brokenDef = (id: string): PluginDefinition => ({
    id,
    clientRoot: brokenRoot,
    definePlugin: (ctx) => {
      ctx.ui.screen({ id: 'main', label: 'Main', client: { module: 'index.tsx', export: 'Broken' } });
    },
  });

  // Non-isolated register rejects explicitly and leaves no plugin residue.
  await assert.rejects(
    host.register(brokenDef('p:broken-strict')),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_compile_failed',
  );
  assert.equal(host.get('p:broken-strict'), undefined);

  // Isolated external register degrades to failed status without clientHashes.
  await host.register(brokenDef('ext-broken-isolated'), { isolateFailure: true });
  const isolated = host.get('ext-broken-isolated');
  assert.equal(isolated?.enabled, false);
  assert.equal(isolated?.status, 'failed');
  assert.equal(isolated?.error?.code, 'client_compile_failed');
  assert.equal(isolated?.clientHashes, undefined);

  // Broken source introduced while disabled makes enable() fail and roll back cleanly.
  const toggleRoot = join(dataDir, 'toggle-client');
  mkdirSync(toggleRoot, { recursive: true });
  writeFileSync(join(toggleRoot, 'index.tsx'), 'export function Ok() { return null; }\n');
  await host.register(
    {
      id: 'ext-toggle-broken',
      clientRoot: toggleRoot,
      definePlugin: (ctx) => {
        ctx.ui.screen({ id: 'main', label: 'Main', client: { module: 'index.tsx', export: 'Ok' } });
      },
    },
    { enabled: false },
  );
  writeFileSync(join(toggleRoot, 'index.tsx'), 'export const Bad = (((\n');
  await assert.rejects(
    host.enable('ext-toggle-broken'),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_compile_failed',
  );
  const rolledBack = host.get('ext-toggle-broken');
  assert.equal(rolledBack?.enabled, false);
  assert.equal(rolledBack?.status, 'failed');
  assert.equal(rolledBack?.clientHashes, undefined);
});

test('pluginSummaryOf / emitPluginChanged: deactivating window and enabled+lastError never leak active status, clientHashes, or UI', { timeout: 60_000 }, async (t) => {
  const host = makeHost();
  t.after(() => host.dispose());

  const clientRoot = join(dataDir, 'deactivating-client');
  mkdirSync(clientRoot, { recursive: true });
  writeFileSync(join(clientRoot, 'index.tsx'), 'export function Main() { return "ok"; }\n');

  const stopEntered = deferred<void>();
  const stopRelease = deferred<void>();
  await host.register({
    id: 'p:deactivating-window',
    clientRoot,
    definePlugin: (ctx) => {
      ctx.ui.screen({ id: 'main', label: 'Main', client: { module: 'index.tsx', export: 'Main' } });
      ctx.action({
        id: 'ping',
        description: 'ping',
        inputSchema: { type: 'object', additionalProperties: false },
        outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
        handler: () => ({ ok: true }),
      });
      ctx.service({
        id: 'svc',
        start() {},
        async stop() {
          stopEntered.resolve();
          await stopRelease.promise;
        },
      });
    },
  });

  const active = host.get('p:deactivating-window')!;
  assert.equal(active.status, 'active');
  assert.ok(active.clientHashes?.['index.tsx']);
  assert.deepEqual(active.actions, ['ping']);

  const disabling = host.disable('p:deactivating-window');
  await stopEntered.promise;
  try {
    const midDisable = host.get('p:deactivating-window')!;
    assert.notEqual(midDisable.status, 'active', 'deactivating plugin must not be reported as active');
    assert.equal(midDisable.clientHashes, undefined, 'deactivating plugin must not expose clientHashes');
    assert.deepEqual(midDisable.actions, []);
    assert.deepEqual(host.listUi().filter((u) => u.pluginId === 'p:deactivating-window'), []);
  } finally {
    stopRelease.resolve();
    await disabling;
  }

  const afterDisable = host.get('p:deactivating-window')!;
  assert.equal(afterDisable.enabled, false);
  assert.equal(afterDisable.status, 'disabled');
  assert.equal(afterDisable.clientHashes, undefined);
});

test('clientHashes: reloadExternalPlugin recompiles and emits updated clientHashes immediately', { timeout: 60_000 }, async (t) => {
  const host = makeHost();
  t.after(() => host.dispose());

  const pluginDir = join(dataDir, 'installed-plugins', 'ext-hash-reload');
  mkdirSync(join(pluginDir, 'client'), { recursive: true });
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({ id: 'ext-hash-reload', main: 'index.mjs', clientRoot: './client' }),
  );
  writeFileSync(
    join(pluginDir, 'index.mjs'),
    `export default {
  id: 'ext-hash-reload',
  name: 'Ext Hash Reload',
  definePlugin(ctx) {
    ctx.ui.screen({ id: 'main', label: 'Main', client: { module: 'index.tsx', export: 'MainScreen' } });
  },
}
`,
  );
  writeFileSync(join(pluginDir, 'client', 'index.tsx'), 'export function MainScreen() { return "rel-v1"; }\n');

  const rescan = await host.rescanExternalPlugins();
  assert.ok(rescan.registered.includes('ext-hash-reload'));
  assert.equal(host.get('ext-hash-reload')?.clientHashes, undefined);

  await host.enable('ext-hash-reload');
  const hashV1 = host.get('ext-hash-reload')?.clientHashes?.['index.tsx'];
  assert.ok(hashV1 && hashV1.length > 0);
  assert.equal(hashV1, (await host.getClientModule('ext-hash-reload', 'index.tsx')).contentHash);

  // Edit client.tsx on disk and trigger reloadExternalPlugin.
  writeFileSync(join(pluginDir, 'client', 'index.tsx'), 'export function MainScreen() { return "rel-v2"; }\n');
  eventPayloads.length = 0;
  const reloaded = await host.reloadExternalPlugin('ext-hash-reload');
  assert.equal(reloaded.wasEnabled, true);
  const hashV2 = reloaded.summary.clientHashes?.['index.tsx'];
  assert.ok(hashV2 && hashV2.length > 0);
  assert.notEqual(hashV2, hashV1);
  assert.deepEqual(host.get('ext-hash-reload')?.clientHashes, { 'index.tsx': hashV2 });
  assert.deepEqual(host.list().find((p) => p.id === 'ext-hash-reload')?.clientHashes, { 'index.tsx': hashV2 });

  const changed = eventPayloads
    .filter((e) => e.type === 'plugin.changed')
    .map((e) => (e.payload as { plugin: { id: string; enabled: boolean; clientHashes?: Record<string, string> } }).plugin)
    .filter((p) => p.id === 'ext-hash-reload');
  assert.ok(changed.some((p) => p.enabled && p.clientHashes?.['index.tsx'] === hashV2));
});

test('HTTP client.mjs main module ?hash=: immutable cache on match, 304 on ETag, 409 client_module_stale on mismatch, no-cache without hash', { timeout: 60_000 }, async (t) => {
  const auth = new AuthService(dataDir);
  const httpHost = makeHost();
  t.after(() => httpHost.dispose());

  const clientRoot = join(dataDir, 'http-client-hash');
  mkdirSync(clientRoot, { recursive: true });
  writeFileSync(join(clientRoot, 'index.tsx'), 'export function Screen() { return "immutable-ok"; }\n');

  await httpHost.register({
    id: 'p:http-hash',
    clientRoot,
    definePlugin: (ctx) => {
      ctx.ui.screen({ id: 'main', label: 'Main', client: { module: 'index.tsx', export: 'Screen' } });
    },
  });

  const expectedHash = httpHost.get('p:http-hash')?.clientHashes?.['index.tsx'];
  assert.ok(expectedHash && expectedHash.length > 0);

  const kernel = {
    dataDir,
    auth,
    events: { response: () => new Response(null, { status: 204 }) },
    plugins: httpHost,
  } as unknown as KernelRuntimeLike;
  const handler = createHubHandler(kernel);
  const setup = await handler(new Request('http://127.0.0.1:3202/api/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pw-client-hash-test' }),
  }));
  assert.equal(setup.status, 200);
  const token = ((await setup.json()) as { token: string }).token;
  const callClient = (query: string, opts?: { method?: string; headers?: Record<string, string> }) =>
    handler(new Request(`http://127.0.0.1:3202/api/plugins/p%3Ahttp-hash/client.mjs?${query}`, {
      method: opts?.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, ...(opts?.headers ?? {}) },
    }));

  // 1. Without ?hash=: private, no-cache (200 and 304).
  const unhashed = await callClient('module=index.tsx');
  assert.equal(unhashed.status, 200);
  assert.equal(unhashed.headers.get('cache-control'), 'private, no-cache');
  assert.equal(unhashed.headers.get('etag'), `"${expectedHash}"`);
  assert.equal(unhashed.headers.get('x-helmx-client-hash'), expectedHash);
  const unhashed304 = await callClient('module=index.tsx', { headers: { 'if-none-match': `"${expectedHash}"` } });
  assert.equal(unhashed304.status, 304);
  assert.equal(unhashed304.headers.get('cache-control'), 'private, no-cache');

  // 2. With matching ?hash=: private, max-age=31536000, immutable (200, gzip, HEAD, and 304).
  const immutableRes = await callClient(`module=index.tsx&hash=${encodeURIComponent(expectedHash)}`);
  assert.equal(immutableRes.status, 200);
  assert.equal(immutableRes.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(immutableRes.headers.get('etag'), `"${expectedHash}"`);
  assert.equal(immutableRes.headers.get('x-helmx-client-hash'), expectedHash);
  assert.match(await immutableRes.text(), /immutable-ok/);

  const immutableHead = await callClient(`module=index.tsx&hash=${encodeURIComponent(expectedHash)}`, { method: 'HEAD' });
  assert.equal(immutableHead.status, 200);
  assert.equal(immutableHead.headers.get('cache-control'), 'private, max-age=31536000, immutable');

  const immutable304 = await callClient(`module=index.tsx&hash=${encodeURIComponent(expectedHash)}`, {
    headers: { 'if-none-match': `"${expectedHash}"` },
  });
  assert.equal(immutable304.status, 304);
  assert.equal(immutable304.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(immutable304.headers.get('etag'), `"${expectedHash}"`);

  // 3. With mismatched or empty ?hash= (even if If-None-Match matches the stale hash): explicit 409 client_module_stale.
  for (const staleQuery of ['module=index.tsx&hash=stale-hash-000', 'module=index.tsx&hash=']) {
    const staleRes = await callClient(staleQuery, { headers: { 'if-none-match': '"stale-hash-000"' } });
    assert.equal(staleRes.status, 409);
    assert.notEqual(staleRes.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    const staleBody = (await staleRes.json()) as { error?: { code?: string; details?: { currentHash?: string } } };
    assert.equal(staleBody.error?.code, 'client_module_stale');
    assert.equal(staleBody.error?.details?.currentHash, expectedHash);
  }

  // 4. Direct PluginHost.getClientModule also enforces 409 client_module_stale on main module hash mismatch.
  await assert.rejects(
    httpHost.getClientModule('p:http-hash', 'index.tsx', { hash: 'stale-hash-000' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_module_stale' && err.status === 409,
  );
});

// ---------------------------------------------------------------------------
// Transient docs (durable: false) & PluginSummary.publicConfig
// ---------------------------------------------------------------------------

test('ctx.doc durable: false keeps state strictly in memory (zero store I/O, clone, 2 MiB limit, public SSE/snapshot, eviction on disable)', { timeout: 60_000 }, async (t) => {
  const ops: string[] = [];
  const spyDocs: PluginDocStore = {
    get: (key, initial) => {
      ops.push(`get:${key}`);
      return docs.get(key, initial);
    },
    set: (key, value) => {
      ops.push(`set:${key}`);
      docs.set(key, value);
    },
    deletePlugin: (pluginId) => {
      ops.push(`deletePlugin:${pluginId}`);
      docs.deletePlugin(pluginId);
    },
    flush: async () => {
      ops.push('flush');
    },
  };
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: makeHostApi(events), docs: spyDocs });
  t.after(() => host.dispose());

  let privDoc!: PluginDocHandle<{ count: number }>;
  let pubDoc!: PluginDocHandle<{ phase: string; items: string[] }>;

  await host.register({
    id: 'p:transient-global',
    definePlugin: (ctx) => {
      privDoc = ctx.doc('priv', { count: 0 }, { durable: false });
      pubDoc = ctx.doc('pub', { phase: 'idle', items: [] as string[] }, { public: true, durable: false });
    },
  });

  // Invalid `durable` option rejects cleanly at declaration time.
  await assertRejectsCode(
    () =>
      host.register({
        id: 'p:bad-durable',
        definePlugin: (ctx) => {
          ctx.doc('bad', {}, { durable: 'yes' as never });
        },
      }),
    'invalid_doc_spec',
  );

  privDoc.set({ count: 7 });
  pubDoc.update((prev) => ({ ...prev, phase: 'active', items: ['x'] }));
  // Returned handle clone must not mutate internal transient memory.
  pubDoc.get().items.push('MUTATED');
  assert.deepEqual(pubDoc.get(), { phase: 'active', items: ['x'] });
  assert.deepEqual(privDoc.get(), { count: 7 });

  // Public doc snapshot & events work identically to durable docs.
  assert.deepEqual(host.getPublicDoc('p:transient-global', 'pub').value, { phase: 'active', items: ['x'] });
  assert.ok(host.listPublicDocs().some((d) => d.pluginId === 'p:transient-global' && d.name === 'pub'));
  const docEvents = eventPayloads.filter((e) => e.type === 'plugin.doc.updated');
  assert.equal(docEvents.length, 1);

  // Enforce JSON value & 2 MiB size limit even in transient mode.
  throwsCode(() => pubDoc.set({ phase: 'bad', items: [undefined as never] }), 'invalid_json_value');
  throwsCode(() => pubDoc.set({ phase: 'huge', items: ['a'.repeat(2 * 1024 * 1024 + 100)] }), 'plugin_doc_too_large');

  // flush() resolves immediately without hitting persistent doc store.
  await pubDoc.flush();
  assert.deepEqual(ops.filter((op) => !op.startsWith('flush')), [], 'durable: false 绝不触发 PluginDocStore get/set/delete');

  // Disable clears transient docs immediately; re-enabling starts fresh from initial.
  await host.disable('p:transient-global');
  throwsCode(() => host.getPublicDoc('p:transient-global', 'pub'), 'plugin_doc_not_found');

  await host.enable('p:transient-global');
  assert.deepEqual(host.getPublicDoc('p:transient-global', 'pub').value, { phase: 'idle', items: [] });
  assert.deepEqual(ops.filter((op) => op.startsWith('get:') || op.startsWith('set:')), []);
});

test('ctx.sessionDoc durable: false works without sessionDocs store, performs zero SQLite/store I/O, and cleans up on conversation.deleted & disable', { timeout: 60_000 }, async (t) => {
  const sessionOps: string[] = [];
  const backing = new Map<string, string>();
  const spySessionDocs: PluginSessionDocStore = {
    get: (pluginId, name, conversationId) => {
      sessionOps.push(`get:${pluginId}:${name}:${conversationId}`);
      return backing.get(`${pluginId}:${name}:${conversationId}`);
    },
    put: (pluginId, name, conversationId, valueJson) => {
      sessionOps.push(`put:${pluginId}:${name}:${conversationId}`);
      backing.set(`${pluginId}:${name}:${conversationId}`, valueJson);
    },
    delete: (pluginId, name, conversationId) => {
      sessionOps.push(`delete:${pluginId}:${name}:${conversationId}`);
      backing.delete(`${pluginId}:${name}:${conversationId}`);
    },
    deletePlugin: (pluginId) => {
      sessionOps.push(`deletePlugin:${pluginId}`);
    },
    listConversationIds: (pluginId, name) => {
      sessionOps.push(`list:${pluginId}:${name}`);
      return [];
    },
    flush: async () => {
      sessionOps.push('flush');
    },
  };

  const deletedListeners = new Set<(payload: unknown) => void>();
  const baseHost = makeHostApi(events);
  const hostApi: PluginHostBackend = {
    ...baseHost,
    onEvent(type: string, listener: (payload: unknown) => void | Promise<void>) {
      if (type === 'conversation.deleted') {
        deletedListeners.add(listener as (payload: unknown) => void);
        return () => {
          deletedListeners.delete(listener as (payload: unknown) => void);
        };
      }
      return baseHost.onEvent(type, listener);
    },
  };

  // Pre-seed stale durable row to verify transient mode ignores durable backing store completely.
  backing.set('p:transient-sess:speed:1', JSON.stringify({ tps: 999 }));

  // 1. Works even with sessionDocs omitted completely.
  const noStoreHost = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: hostApi, docs });
  t.after(() => noStoreHost.dispose());
  await noStoreHost.register({
    id: 'p:transient-no-store',
    definePlugin: (ctx) => {
      const s = ctx.sessionDoc('s', { n: 0 }, { public: true, durable: false });
      s.set(1, { n: 5 });
    },
  });
  assert.deepEqual(noStoreHost.getPublicSessionDoc('p:transient-no-store', 's', 1).value, { n: 5 });

  // 2. With spy sessionDocs store present, zero durable reads/writes happen.
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    host: hostApi,
    docs,
    sessionDocs: spySessionDocs,
  });
  t.after(() => host.dispose());

  let transientHandle!: PluginSessionDocHandle<{ tps: number } | null>;
  await host.register({
    id: 'p:transient-sess',
    definePlugin: (ctx) => {
      transientHandle = ctx.sessionDoc<{ tps: number } | null>('speed', null, { public: true, durable: false });
    },
  });
  transientHandle.set(1, { tps: 42 });
  transientHandle.set(2, { tps: 84 });

  // Never reads pre-seeded stale durable row; reads in-memory values only.
  assert.deepEqual(host.getPublicSessionDoc('p:transient-sess', 'speed', 1).value, { tps: 42 });
  assert.deepEqual(sessionOps, [], '注册并写入瞬态 sessionDoc 全程零持久存储访问');

  // conversation.deleted event automatically evicts transient sessionDoc entry for conversation 1.
  for (const listener of deletedListeners) listener({ type: 'conversation.deleted', conversationId: 1 });
  assert.equal(host.getPublicSessionDoc('p:transient-sess', 'speed', 1).value, null, 'conversation.deleted 自动清理瞬态会话文档');
  assert.deepEqual(host.getPublicSessionDoc('p:transient-sess', 'speed', 2).value, { tps: 84 });

  // Disable immediately clears all remaining transient session entries (conv 2).
  await host.disable('p:transient-sess');
  throwsCode(() => host.getPublicSessionDoc('p:transient-sess', 'speed', 2), 'plugin_doc_not_found');
  await host.enable('p:transient-sess');
  assert.equal(host.getPublicSessionDoc('p:transient-sess', 'speed', 2).value, null);
  assert.deepEqual(sessionOps.filter((op) => op !== 'flush'), []);
});

test('PluginSummary.publicConfig filters secret fields, merges defaults, redacts secrets, and updates via plugin.changed', { timeout: 60_000 }, async (t) => {
  const cfgStore = new MemoryConfigStore();
  cfgStore.set('p:cfg-mixed', {
    apiKey: 'sk-live-secret',
    note: 'token is sk-live-secret',
    windowMs: 2_000,
    undeclaredKey: 'ignored',
  });

  const baseBackend = makeHostApi(events);
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    host: baseBackend,
    docs,
    config: cfgStore,
    redactText: (text) => text.replaceAll('sk-live-secret', '[REDACTED]'),
  });
  t.after(() => host.dispose());

  await host.register({
    id: 'p:cfg-no-schema',
    definePlugin: () => {},
  });
  await host.register({
    id: 'p:cfg-secret-only',
    definePlugin: (ctx) => {
      ctx.configSchema({
        token: { type: 'string', secret: true, default: 's1' },
      });
    },
  });
  await host.register({
    id: 'p:cfg-mixed',
    definePlugin: (ctx) => {
      ctx.configSchema({
        windowMs: { type: 'number', default: 1_000 },
        label: { type: 'string', default: 'fast' },
        note: { type: 'string' },
        apiKey: { type: 'string', secret: true, default: 'sk-default' },
      });
    },
  });

  assert.equal(host.get('p:cfg-no-schema')?.publicConfig, undefined);
  assert.equal(host.get('p:cfg-secret-only')?.publicConfig, undefined);
  assert.deepEqual(host.get('p:cfg-mixed')?.publicConfig, {
    windowMs: 2_000,
    label: 'fast',
    note: 'token is [REDACTED]',
  });
  assert.equal('apiKey' in (host.get('p:cfg-mixed')?.publicConfig ?? {}), false);
  assert.equal('undeclaredKey' in (host.get('p:cfg-mixed')?.publicConfig ?? {}), false);

  const changedStart = eventPayloads.filter((e) => e.type === 'plugin.changed').length;
  await host.setConfig('p:cfg-mixed', { windowMs: 3_500, apiKey: 'sk-live-secret', note: null });
  const updated = host.get('p:cfg-mixed')!;
  assert.deepEqual(updated.publicConfig, { windowMs: 3_500, label: 'fast' });

  const afterHostSet = eventPayloads.filter((e) => e.type === 'plugin.changed').slice(changedStart);
  assert.equal(afterHostSet.length, 1);
  assert.deepEqual((afterHostSet[0]!.payload as { plugin: PluginSummary }).plugin.publicConfig, {
    windowMs: 3_500,
    label: 'fast',
  });

  await host.setConfig('p:cfg-mixed', { windowMs: 4_000, label: 'turbo', apiKey: 'another-secret' });
  const lastChanged = eventPayloads.filter((e) => e.type === 'plugin.changed').at(-1)!.payload as { plugin: PluginSummary };
  assert.deepEqual(lastChanged.plugin.publicConfig, { windowMs: 4_000, label: 'turbo' });
  assert.equal('apiKey' in (lastChanged.plugin.publicConfig ?? {}), false);
});

test('PluginHost.getManifest / listManifests: stably sorted read-only projection without provider execution or secret/private leaks', { timeout: 60_000 }, async (t) => {
  const testDataDir = await makeTempDir('helmx-manifest-host-');
  t.after(() => cleanupDir(testDataDir));
  const clientRoot = join(testDataDir, 'client-src');
  mkdirSync(join(clientRoot, 'panels'), { recursive: true });
  writeFileSync(join(clientRoot, 'index.tsx'), 'export function MainView() { return "ok"; }\n');
  writeFileSync(join(clientRoot, 'panels', 'Side.tsx'), 'export function SideView() { return "side"; }\n');

  const cfgStore = new MemoryConfigStore();
  cfgStore.set('z:full', { apiKey: 'LIVE_SECRET_XYZ', endpoint: 'https://runtime.internal' });
  const localEvents: string[] = [];
  const baseBackend = makeHostApi(localEvents);

  let providerCallbackCalls = 0;
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir: testDataDir,
    host: {
      ...baseBackend,
      redact: (text) => text.replaceAll('TOP_SECRET_MARKER', '[HOST_REDACTED]'),
    },
    docs: new MemoryDocStore(),
    config: cfgStore,
    providers: {
      register: async () => async () => {},
    },
    redactText: (text) => text.replaceAll('PLUGIN_SECRET_MARKER', '[REDACTED]'),
  });
  t.after(() => host.dispose());

  await host.register({
    id: 'a:dep',
    name: 'Dep Plugin',
    definePlugin: () => {},
  });

  await host.register({
    id: 'z:full',
    name: { en: 'Full Plugin', 'zh-CN': '全量插件' },
    description: 'Contains TOP_SECRET_MARKER and PLUGIN_SECRET_MARKER',
    icon: 'layers',
    version: '2.0.0',
    dependencies: ['a:dep'],
    clientRoot,
    definePlugin: (ctx) => {
      ctx.configSchema({
        endpoint: { type: 'string', default: 'https://default.example', label: 'Endpoint' },
        apiKey: { type: 'string', secret: true, required: true, default: 'hardcoded-secret-default' },
      });
      // Register in deliberately non-sorted order to verify deterministic sorting.
      ctx.hook.onTurnSettled(() => {});
      ctx.hook.onInput(() => {});
      ctx.hook.onBeforeTurn(() => {});

      ctx.action({
        id: 'zeta',
        description: 'Zeta action',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        idempotent: true,
        handler: () => ({ ok: true }),
      });
      ctx.action({
        id: 'alpha',
        description: 'Alpha exposed action',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        exposeAsTool: true,
        presentationMetaSchema: { type: 'object', properties: { badge: { type: 'string' } }, additionalProperties: false },
        projectPresentationMeta: () => ({ badge: 'alpha' }),
        scope: { profileIds: ['assistant'] },
        handler: () => ({ ok: true }),
      });

      ctx.tool({
        name: 'zebra_tool',
        description: 'Direct tool',
        inputSchema: { type: 'object' },
        structuredOutputSchema: { type: 'object' },
        presentationMetaSchema: { type: 'object', properties: { count: { type: 'integer' } }, additionalProperties: false },
        replay: 'safe',
        scope: { tags: ['ops'] },
        execute: () => ({ ok: true }),
      });

      ctx.ui.workbenchPanel({
        id: 'panel-b',
        label: 'Panel B',
        client: { module: 'panels/Side.tsx', export: 'SideView' },
      });
      ctx.ui.screen({
        id: 'main',
        label: 'Main',
        client: { module: 'index.tsx', export: 'MainView' },
      });

      ctx.route({ method: 'POST', path: '/items', handler: () => new Response('ok') });
      ctx.route({ method: 'GET', path: '/health', public: true, handler: () => new Response('ok') });

      ctx.doc('private_state', { secret: 'never-projected' });
      ctx.doc('public_board', { count: 7 }, { public: true });
      ctx.sessionDoc('live_stream', { n: 0 }, { public: true, durable: false });
      ctx.sessionDoc('private_sess', { n: 1 }, { public: false, durable: false });

      ctx.service({ id: 'svc-z', start: () => {}, stop: () => {} });
      ctx.service({ id: 'svc-a', start: () => {}, stop: () => {} });

      ctx.provider({
        id: 'prov-b',
        name: 'Provider B',
        auth: {
          apiKey: {
            name: 'prov-b key',
            resolve: async () => {
              providerCallbackCalls += 1;
              return undefined;
            },
          },
        },
        getModels: () => {
          providerCallbackCalls += 1;
          return [];
        },
        stream: () => {
          providerCallbackCalls += 1;
          throw new Error('should never execute stream');
        },
        streamSimple: () => {
          providerCallbackCalls += 1;
          throw new Error('should never execute streamSimple');
        },
      });
    },
  });

  // Fail-isolated external plugin to inspect failed projection state.
  await host.register(
    {
      id: 'm:broken',
      name: 'Broken Plugin',
      definePlugin: () => {
        throw new HelmxError('boom_define', 'broken TOP_SECRET_MARKER', 500, { extra: undefined, nested: 'x' });
      },
    },
    { isolateFailure: true },
  );

  const manifests = host.listManifests();
  assert.deepEqual(manifests.map((m) => m.id), ['a:dep', 'm:broken', 'z:full']);

  const full: PluginManifestProjection = host.getManifest('z:full');
  assert.equal(full.status, 'active');
  assert.equal(full.enabled, true);
  assert.equal(full.description, 'Contains [HOST_REDACTED] and [REDACTED]');
  assert.deepEqual(full.dependencies, ['a:dep']);
  // Canonical PLUGIN_HOOK_NAMES order regardless of registration order
  assert.deepEqual(full.hooks, ['input', 'before_turn', 'turn_settled']);
  assert.deepEqual(full.actions.map((a) => a.id), ['alpha', 'zeta']);
  assert.equal(full.actions[0]!.toolName, actionToolAlias('z:full', 'alpha'));
  assert.equal(full.actions[1]!.toolName, undefined);
  assert.deepEqual(full.tools.map((tool) => tool.name), [actionToolAlias('z:full', 'alpha'), 'zebra_tool']);
  assert.deepEqual(full.tools[0]!.scope, { profileIds: ['assistant'] });
  assert.deepEqual(full.tools[0]!.structuredOutputSchema, { type: 'object' });
  assert.deepEqual(full.tools[0]!.presentationMetaSchema, {
    type: 'object',
    properties: { badge: { type: 'string' } },
    additionalProperties: false,
  });
  assert.deepEqual(full.tools[1]!.scope, { tags: ['ops'] });
  assert.deepEqual(full.tools[1]!.structuredOutputSchema, { type: 'object' });
  assert.deepEqual(full.tools[1]!.presentationMetaSchema, {
    type: 'object',
    properties: { count: { type: 'integer' } },
    additionalProperties: false,
  });
  assert.equal(full.tools[1]!.replay, 'safe');
  assert.deepEqual(full.ui.map((u) => `${u.surface}:${u.id}`), ['screen:main', 'workbench.panel:panel-b']);
  assert.deepEqual(full.routes, [
    { method: 'GET', path: '/api/plugins/z%3Afull/routes/health', public: true },
    { method: 'POST', path: '/api/plugins/z%3Afull/routes/items', public: false },
  ]);
  assert.deepEqual(full.docs, [
    { name: 'public_board', kind: 'doc', public: true, durable: true },
    { name: 'live_stream', kind: 'sessionDoc', public: true, durable: false },
  ]);
  assert.deepEqual(full.configFields, [
    { key: 'apiKey', type: 'string', secret: true, required: true },
    { key: 'endpoint', type: 'string', secret: false, required: false, label: 'Endpoint', default: 'https://default.example' },
  ]);
  assert.deepEqual(full.providers, [{ id: 'prov-b', name: 'Provider B' }]);
  assert.deepEqual(full.services, ['svc-a', 'svc-z']);
  assert.deepEqual(full.clientModules.map((c) => c.module), ['index.tsx', 'panels/Side.tsx']);
  assert.ok(full.clientModules.every((c) => typeof c.contentHash === 'string' && c.contentHash.length > 0));

  const serialized = JSON.stringify(full);
  assert.ok(!serialized.includes('LIVE_SECRET_XYZ'), 'runtime config values must never appear in manifest');
  assert.ok(!serialized.includes('https://runtime.internal'), 'runtime config values must never appear in manifest');
  assert.ok(!serialized.includes('hardcoded-secret-default'), 'secret field default must never appear in manifest');
  assert.ok(!serialized.includes('private_state'), 'private doc descriptors must never appear in manifest');
  assert.ok(!serialized.includes('private_sess'), 'private sessionDoc descriptors must never appear in manifest');
  assert.ok(!serialized.includes('never-projected'), 'doc values must never appear in manifest');
  assert.ok(!serialized.includes('TOP_SECRET_MARKER'), 'host redactor must scrub projected text');
  assert.ok(!serialized.includes('PLUGIN_SECRET_MARKER'), 'redactText must scrub projected text');
  assert.equal(providerCallbackCalls, 0, 'manifest introspection must never invoke provider callbacks');

  const broken = host.getManifest('m:broken');
  assert.equal(broken.status, 'failed');
  assert.equal(broken.enabled, false);
  assert.equal(broken.error?.code, 'boom_define');
  assert.equal(broken.error?.message, 'broken [HOST_REDACTED]');
  assert.deepEqual(broken.actions, []);

  // Disabling removes live capabilities immediately while keeping config schema (without secret defaults) & dependencies
  await host.disable('z:full');
  const disabled = host.getManifest('z:full');
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.enabled, false);
  assert.deepEqual(disabled.hooks, []);
  assert.deepEqual(disabled.actions, []);
  assert.deepEqual(disabled.tools, []);
  assert.deepEqual(disabled.ui, []);
  assert.deepEqual(disabled.routes, []);
  assert.deepEqual(disabled.docs, []);
  assert.deepEqual(disabled.providers, []);
  assert.deepEqual(disabled.services, []);
  assert.deepEqual(disabled.clientModules, []);
  assert.deepEqual(disabled.dependencies, ['a:dep']);
  assert.equal(disabled.configFields.length, 2);

  throwsCode(() => host.getManifest('no:such-plugin'), 'unknown_plugin');
  await host.dispose();
  throwsCode(() => host.getManifest('a:dep'), 'plugin_host_disposed');
  throwsCode(() => host.listManifests(), 'plugin_host_disposed');
});

test('doctorPluginDir captures validated PluginManifestProjection during dry-run and rejects intra-plugin tool conflicts', { timeout: 60_000 }, async (t) => {
  const baseDir = await makeTempDir('helmx-doctor-manifest-');
  t.after(() => cleanupDir(baseDir));
  const buildProvider = createPluginBuildProvider();

  // 1. Healthy plugin with capabilities -> report.manifest carries full dry-run capabilities before teardown
  const okDir = join(baseDir, 'healthy-ext');
  mkdirSync(join(okDir, 'client'), { recursive: true });
  writeFileSync(
    join(okDir, 'plugin.json'),
    JSON.stringify({ id: 'ext-doc-manifest', name: 'Healthy Ext', main: 'index.ts', clientRoot: './client' }),
  );
  writeFileSync(join(okDir, 'client', 'index.tsx'), 'export function MainScreen() { return "hi"; }\n');
  writeFileSync(
    join(okDir, 'index.ts'),
    `export default {
  id: 'ext-doc-manifest',
  name: 'Healthy Ext',
  definePlugin(ctx: any) {
    ctx.configSchema({ token: { type: 'string', secret: true, default: 'leak-nope' } });
    ctx.action({
      id: 'ping',
      description: 'Ping',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      exposeAsTool: true,
      handler: () => ({ ok: true }),
    });
    ctx.ui.screen({ id: 'main', label: 'Main', client: { module: 'index.tsx', export: 'MainScreen' } });
    ctx.route({ method: 'GET', path: '/status', handler: () => new Response('ok') });
    ctx.doc('priv', { secret: 1 });
    ctx.doc('pub', { count: 1 }, { public: true });
  },
};\n`,
  );

  const okReport = await doctorPluginDir(okDir, { buildProvider });
  assert.equal(okReport.ok, true);
  assert.ok(okReport.manifest, 'doctor report should carry manifest when register succeeds');
  assert.equal(okReport.manifest.id, 'ext-doc-manifest');
  assert.deepEqual(okReport.manifest.actions.map((a) => a.id), ['ping']);
  assert.deepEqual(okReport.manifest.tools.map((tool) => tool.sourceKind), ['action']);
  assert.deepEqual(okReport.manifest.ui.map((u) => u.id), ['main']);
  assert.deepEqual(okReport.manifest.docs, [{ name: 'pub', kind: 'doc', public: true, durable: true }]);
  assert.deepEqual(okReport.manifest.configFields, [{ key: 'token', type: 'string', secret: true, required: false }]);
  assert.deepEqual(okReport.manifest.clientModules, [{ module: 'index.tsx' }]);
  assert.equal('default' in okReport.manifest.configFields[0]!, false);

  // 2. Intra-plugin tool collision between ctx.tool and exposeAsTool alias fails in register stage without manifest
  const collideAlias = actionToolAlias('ext-doc-collide', 'ping');
  const collideDir = join(baseDir, 'collide-ext');
  mkdirSync(collideDir, { recursive: true });
  writeFileSync(
    join(collideDir, 'plugin.json'),
    JSON.stringify({ id: 'ext-doc-collide', main: 'index.ts' }),
  );
  writeFileSync(
    join(collideDir, 'index.ts'),
    `export default {
  id: 'ext-doc-collide',
  definePlugin(ctx: any) {
    ctx.action({
      id: 'ping',
      description: 'Ping',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      exposeAsTool: true,
      handler: () => ({ ok: true }),
    });
    ctx.tool({
      name: ${JSON.stringify(collideAlias)},
      description: 'Colliding tool',
      inputSchema: { type: 'object' },
      execute: () => ({ ok: true }),
    });
  },
};\n`,
  );
  const badReport = await doctorPluginDir(collideDir, { buildProvider });
  assert.equal(badReport.ok, false);
  const regCheck = badReport.checks.find((c) => c.id === 'register');
  assert.equal(regCheck?.error?.code, 'duplicate_tool_name');
  assert.equal(badReport.manifest, undefined, 'failed register must not emit partial manifest');
});

test('PluginHost: ctx.host.invokeAction stamps unforgeable callerPluginId and enforces action visibility', { timeout: 60_000 }, async () => {
  const host = makeHost();
  try {
    await host.register({
      id: 'sec:provider',
      definePlugin(ctx) {
        ctx.action({
          id: 'internal_op',
          description: 'Plugin-internal operation',
          visibility: 'internal',
          inputSchema: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] },
          outputSchema: {
            type: 'object',
            properties: { caller: { type: 'string' }, tag: { type: 'string' } },
            required: ['caller', 'tag'],
          },
          handler(input: { tag: string }, actionCtx) {
            if (!actionCtx.callerPluginId) {
              throw new HelmxError('missing_caller', 'callerPluginId missing', 500);
            }
            return { caller: actionCtx.callerPluginId, tag: input.tag };
          },
        });
        ctx.action({
          id: 'ui_op',
          description: 'UI-facing operation',
          visibility: 'ui',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object', properties: { caller: { type: ['string', 'null'] } }, required: ['caller'] },
          handler(_input, actionCtx) {
            return { caller: actionCtx.callerPluginId ?? null };
          },
        });
      },
    });

    await host.register({
      id: 'sec:consumer',
      definePlugin(ctx) {
        ctx.action({
          id: 'delegate_internal',
          description: 'Delegates to sec:provider.internal_op via ctx.host.invokeAction',
          inputSchema: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] },
          outputSchema: {
            type: 'object',
            properties: { caller: { type: 'string' }, tag: { type: 'string' } },
            required: ['caller', 'tag'],
          },
          async handler(input: { tag: string }) {
            // Even attempting to forge callerPluginId in context is ignored by PluginHost
            return (await ctx.host.invokeAction('sec:provider', 'internal_op', input, {
              callerPluginId: 'evil:spoof',
            } as never)) as { caller: string; tag: string };
          },
        });
      },
    });

    // Manifest projection carries visibility
    const manifest = host.getManifest('sec:provider');
    assert.equal(manifest.actions.find((a) => a.id === 'internal_op')?.visibility, 'internal');
    assert.equal(manifest.actions.find((a) => a.id === 'ui_op')?.visibility, 'ui');

    // Direct host.invokeAction (defaults to surface: 'http') rejects internal even with spoofed context
    await assertRejectsCode(
      () =>
        host.invokeAction(
          'sec:provider',
          'internal_op',
          { tag: 'direct' },
          { callerPluginId: 'sec:consumer' } as never,
        ),
      'action_visibility_forbidden',
    );
    await assertRejectsCode(
      () => host.invokeAction('sec:provider', 'internal_op', { tag: 'ra' }, {}, { surface: 'run_action' }),
      'action_visibility_forbidden',
    );

    // Real plugin-to-plugin invocation via ctx.host.invokeAction succeeds and stamps genuine callerPluginId
    const delegated = (await host.invokeAction('sec:consumer', 'delegate_internal', { tag: 'ok' })) as {
      caller: string;
      tag: string;
    };
    assert.deepEqual(delegated, { caller: 'sec:consumer', tag: 'ok' });

    // UI action allowed on HTTP (callerPluginId=null), rejected on run_action
    assert.deepEqual(await host.invokeAction('sec:provider', 'ui_op', {}), { caller: null });
    await assertRejectsCode(
      () => host.invokeAction('sec:provider', 'ui_op', {}, {}, { surface: 'run_action' }),
      'action_visibility_forbidden',
    );
  } finally {
    await host.dispose();
  }
});

test('ctx.doc.set uses single-pass serialization via store.setJson and enforces 2 MiB limit before writing', { timeout: 60_000 }, async () => {
  const setJsonCalls: Array<{ key: string; json: string }> = [];
  let fallbackSetCalls = 0;
  const raw = new Map<string, string>();
  const fastStore: PluginDocStore = {
    get: <T>(key: string, initial: T): T => (raw.has(key) ? (JSON.parse(raw.get(key)!) as T) : initial),
    set: () => {
      fallbackSetCalls += 1;
    },
    setJson: (key: string, valueJson: string) => {
      setJsonCalls.push({ key, json: valueJson });
      raw.set(key, valueJson);
    },
    deletePlugin: () => {},
    flush: async () => {},
  };
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    host: makeHostApi(events),
    docs: fastStore,
  });
  try {
    let handle!: PluginDocHandle<{ items: number[]; pad?: string }>;
    await host.register({
      id: 'p:fast-doc',
      definePlugin: (ctx) => {
        handle = ctx.doc('board', { items: [] }, { public: true });
      },
    });
    const input = { items: [1, 2, 3] };
    handle.set(input);
    // Mutating caller object after set must not corrupt emitted/stored data.
    input.items.push(999);
    assert.equal(fallbackSetCalls, 0, 'store.set should be bypassed when store.setJson is available');
    assert.equal(setJsonCalls.length, 1);
    assert.equal(setJsonCalls[0]!.key, 'p:fast-doc:board');
    assert.equal(setJsonCalls[0]!.json, JSON.stringify({ items: [1, 2, 3] }));
    assert.deepEqual(handle.get(), { items: [1, 2, 3] });
    const docEvents = eventPayloads.filter((e) => e.type === 'plugin.doc.updated');
    assert.equal(docEvents.length, 1);
    assert.deepEqual((docEvents[0]!.payload as { doc: { value: unknown } }).doc.value, { items: [1, 2, 3] });

    // Oversized payload (> 2 MiB) is rejected with 413 before writing to store or emitting events.
    const huge = 'x'.repeat(2 * 1024 * 1024 + 64);
    throwsCode(() => handle.set({ items: [], pad: huge }), 'plugin_doc_too_large');
    assert.equal(setJsonCalls.length, 1, 'oversized write must not touch store.setJson');
    assert.deepEqual(handle.get(), { items: [1, 2, 3] });
  } finally {
    await host.dispose();
  }
});

test('agent_spawn hook validates onResolved, onGateResult, attachments, meta, and gateTimeoutMs fields', { timeout: 60_000 }, async () => {
  const host = makeHost();
  try {
      await host.register({
        id: 'p:spawn-validate',
        definePlugin: (ctx) => {
          ctx.hook.onAgentSpawn(async (req, next) => {
            await next(req);
          });
        },
      });
    const validReq = {
      parentConversationId: 1,
      prompt: 'build feature',
      gateTimeoutMs: 5_000,
      attachments: ['art-1', 'art-2'],
      meta: { trace: { ok: true } },
      onResolved: () => {},
      onGateResult: () => {},
    };
    const ok = await host.runHookAround('agent_spawn', validReq, async (r) => ({ output: r.prompt }));
    assert.deepEqual(ok, { output: 'build feature' });

    const invalidCases: Array<Record<string, unknown>> = [
      { ...validReq, onResolved: 'not-a-function' },
      { ...validReq, onGateResult: 123 },
      { ...validReq, attachments: [42] },
      { ...validReq, meta: 'not-an-object' },
      { ...validReq, gateTimeoutMs: 0 },
    ];
    for (const bad of invalidCases) {
      await assertRejectsCode(
        () => host.runHookAround('agent_spawn', bad as never, async () => ({})),
        'invalid_hook_result',
      );
    }
  } finally {
    await host.dispose();
  }
});

test('doctorPluginDir rejects arbitrary top-level ctx.host.* and nested sub-port calls via Proxy with 501 unsupported', { timeout: 60_000 }, async (t) => {
  const baseDir = await makeTempDir('helmx-doctor-proxy-');
  t.after(() => cleanupDir(baseDir));
  const buildProvider = createPluginBuildProvider();

  for (const [slug, callExpr] of [
    ['direct-host', 'ctx.host.createConversation({})'],
    ['nested-profiles', 'ctx.host.profiles.list()'],
    ['nested-secrets', 'ctx.host.secrets.get("k")'],
  ] as const) {
    const dir = join(baseDir, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: `ext-proxy-${slug}`, main: 'index.ts' }));
    writeFileSync(
      join(dir, 'index.ts'),
      `export default {\n  id: 'ext-proxy-${slug}',\n  async definePlugin(ctx: any) {\n    await ${callExpr};\n  },\n};\n`,
    );
    const report = await doctorPluginDir(dir, { buildProvider });
    assert.equal(report.ok, false, `${slug} should fail doctor`);
    const reg = report.checks.find((c) => c.id === 'register');
    assert.equal(reg?.error?.code, 'unsupported', `${slug} should fail with 501 unsupported`);
  }
});

test('ctx.getConfig(): merges configSchema defaults, clones non-secret values, allows defining/idle/stopWindow, and rejects with plugin_context_closed after disable/epoch advance', { timeout: 60_000 }, async () => {
  const store = new MemoryConfigStore();
  store.set('p:cfg-ctx', { custom: 'persisted', retries: 5, unsetKey: undefined });
  const host = makeHost(store);
  let defineCfg: Record<string, unknown> | undefined;
  let stopCfg: Record<string, unknown> | undefined;
  let capturedGetConfig!: () => Record<string, unknown>;

  try {
    await host.register({
      id: 'p:cfg-ctx',
      definePlugin(ctx) {
        capturedGetConfig = () => ctx.getConfig();
        ctx.configSchema({
          mode: { type: 'string', default: 'fast' },
          retries: { type: 'number', default: 2 },
          tags: { type: 'string[]', default: ['alpha'] },
          unsetKey: { type: 'string', default: 'fallback' },
          apiKey: { type: 'string', secret: true, default: 'sec-default' },
        });
        defineCfg = ctx.getConfig();
        ctx.action({
          id: 'read_cfg',
          description: 'Read effective config at runtime',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          handler: () => ctx.getConfig(),
        });
        ctx.service({
          id: 'svc',
          start() {},
          stop() {
            stopCfg = ctx.getConfig();
          },
        });
      },
    });

    // 1. definePlugin saw schema defaults merged with persisted overrides (explicit undefined did not erase default)
    assert.deepEqual(defineCfg, {
      mode: 'fast',
      retries: 5,
      tags: ['alpha'],
      unsetKey: 'fallback',
      apiKey: 'sec-default',
      custom: 'persisted',
    });

    // 2. Runtime ctx.getConfig matches PluginHost.getConfig and safely clones non-secret array defaults
    const runtimeCfg = capturedGetConfig();
    assert.deepEqual(runtimeCfg, host.getConfig('p:cfg-ctx'));
    (runtimeCfg['tags'] as string[]).push('mutated');
    assert.deepEqual(capturedGetConfig()['tags'], ['alpha']);
    assert.deepEqual(host.getConfig('p:cfg-ctx')['tags'], ['alpha']);

    // Persisted updates are reflected live on ctx.getConfig()
    await host.setConfig('p:cfg-ctx', { mode: 'deep', tags: ['beta'] });
    const afterSet = (await host.invokeAction('p:cfg-ctx', 'read_cfg', {})) as Record<string, unknown>;
    assert.equal(afterSet['mode'], 'deep');
    assert.deepEqual(afterSet['tags'], ['beta']);

    // 3. Works during service.stop() stopWindow, then rejects with 409 plugin_context_closed after disable
    const staleGetConfig = capturedGetConfig;
    await host.disable('p:cfg-ctx');
    assert.equal(stopCfg?.['mode'], 'deep');
    assert.throws(
      () => staleGetConfig(),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_context_closed' && err.status === 409,
    );

    // 4. After re-enable (epoch advance), old ctx.getConfig still rejects while new cycle works
    await host.enable('p:cfg-ctx');
    assert.throws(
      () => staleGetConfig(),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_context_closed' && err.status === 409,
    );
    assert.equal(capturedGetConfig()['mode'], 'deep');

    // 5. Registering with enabled: false allows getConfig in definePlugin, then rejects with plugin_context_closed once idle+disabled
    let disabledDefCfg: Record<string, unknown> | undefined;
    let disabledStaleGet!: () => Record<string, unknown>;
    await host.register(
      {
        id: 'p:cfg-disabled',
        definePlugin(ctx) {
          ctx.configSchema({ level: { type: 'string', default: 'info' } });
          disabledDefCfg = ctx.getConfig();
          disabledStaleGet = () => ctx.getConfig();
        },
      },
      { enabled: false },
    );
    assert.deepEqual(disabledDefCfg, { level: 'info' });
    assert.throws(
      () => disabledStaleGet(),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_context_closed' && err.status === 409,
    );
  } finally {
    await host.dispose();
  }
});

test('doctorPluginDir supports durable/transient ctx.sessionDoc and top-level ctx.host.onEvent while still rejecting runtime conversation reads', { timeout: 60_000 }, async (t) => {
  const baseDir = await makeTempDir('helmx-doctor-parity-');
  t.after(() => cleanupDir(baseDir));
  const buildProvider = createPluginBuildProvider();

  // 1. External plugin declaring durable + transient sessionDocs and top-level host.onEvent passes doctor cleanly
  const okDir = join(baseDir, 'parity-ok');
  mkdirSync(okDir, { recursive: true });
  writeFileSync(join(okDir, 'plugin.json'), JSON.stringify({ id: 'ext-parity-ok', main: 'index.ts' }));
  writeFileSync(
    join(okDir, 'index.ts'),
    `export default {
  id: 'ext-parity-ok',
  definePlugin(ctx: any) {
    ctx.sessionDoc('runs', { items: [] }, { public: true });
    ctx.sessionDoc('live', { status: 'idle' }, { public: true, durable: false });
    ctx.host.onEvent('conversation.deleted', () => {});
  },
};\n`,
  );
  const okReport = await doctorPluginDir(okDir, { buildProvider });
  assert.equal(okReport.ok, true, `expected doctor ok, got checks: ${JSON.stringify(okReport.checks)}`);
  assert.ok(okReport.manifest, 'doctor must produce manifest projection');
  assert.deepEqual(okReport.manifest.docs, [
    { name: 'live', kind: 'sessionDoc', public: true, durable: false },
    { name: 'runs', kind: 'sessionDoc', public: true, durable: true },
  ]);

  // 2. Top-level sessionDoc tuple read still fails honestly with 501 unsupported (never fabricates conversations)
  const badDir = join(baseDir, 'parity-runtime-read');
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, 'plugin.json'), JSON.stringify({ id: 'ext-parity-bad', main: 'index.ts' }));
  writeFileSync(
    join(badDir, 'index.ts'),
    `export default {
  id: 'ext-parity-bad',
  definePlugin(ctx: any) {
    const runs = ctx.sessionDoc('runs', { items: [] }, { public: true });
    runs.get(1);
  },
};\n`,
  );
  const badReport = await doctorPluginDir(badDir, { buildProvider });
  assert.equal(badReport.ok, false);
  const regCheck = badReport.checks.find((c) => c.id === 'register');
  assert.equal(regCheck?.error?.code, 'unsupported');
});

test('tool & CLI command uniqueness: rejects kernel/core/intra-plugin collisions at registration and cross-plugin collisions at enable commit', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const emptySchema = { type: 'object', properties: {} } as const;
  try {
    // 1. Kernel tool name collision rejected at registration (ctx.tool and exposeAsTool)
    await assertRejectsCode(
      () =>
        host.register({
          id: 'p:kernel-tool',
          definePlugin(ctx) {
            ctx.tool({ name: 'bash', description: 'shadow bash', inputSchema: emptySchema, execute: () => 'x' });
          },
        }),
      'duplicate_tool_name',
      409,
    );
    await assertRejectsCode(
      () =>
        host.register({
          id: 'p:kernel-action-tool',
          definePlugin(ctx) {
            ctx.action({
              id: 'shadow',
              description: 'shadow run_action',
              inputSchema: emptySchema,
              outputSchema: emptySchema,
              exposeAsTool: { name: 'run_action' },
              handler: () => ({}),
            });
          },
        }),
      'duplicate_tool_name',
      409,
    );

    // 2. Intra-plugin tool collisions (tool+tool, tool+exposeAsTool, exposeAsTool+tool, exposeAsTool+exposeAsTool)
    await assertRejectsCode(
      () =>
        host.register({
          id: 'p:intra-t-t',
          definePlugin(ctx) {
            ctx.tool({ name: 'dup_local', description: 'a', inputSchema: emptySchema, execute: () => 'a' });
            ctx.tool({ name: 'dup_local', description: 'b', inputSchema: emptySchema, execute: () => 'b' });
          },
        }),
      'duplicate_tool_name',
      409,
    );
    await assertRejectsCode(
      () =>
        host.register({
          id: 'p:intra-t-a',
          definePlugin(ctx) {
            ctx.tool({ name: 'shared_fn', description: 'a', inputSchema: emptySchema, execute: () => 'a' });
            ctx.action({
              id: 'op',
              description: 'b',
              inputSchema: emptySchema,
              outputSchema: emptySchema,
              exposeAsTool: { name: 'shared_fn' },
              handler: () => ({}),
            });
          },
        }),
      'duplicate_tool_name',
      409,
    );
    await assertRejectsCode(
      () =>
        host.register({
          id: 'p:intra-a-a',
          definePlugin(ctx) {
            ctx.action({
              id: 'op1',
              description: 'a',
              inputSchema: emptySchema,
              outputSchema: emptySchema,
              exposeAsTool: { name: 'same_exposed' },
              handler: () => ({}),
            });
            ctx.action({
              id: 'op2',
              description: 'b',
              inputSchema: emptySchema,
              outputSchema: emptySchema,
              exposeAsTool: { name: 'same_exposed' },
              handler: () => ({}),
            });
          },
        }),
      'duplicate_tool_name',
      409,
    );

    // 3. Core CLI command collisions (exact, prefix-of-core, subcommand-under-core, default path)
    for (const [slug, pluginId, actionId, command] of [
      ['exact-two', 'p:cli-1', 'a', ['plugins', 'list']],
      ['exact-one', 'p:cli-2', 'a', ['search']],
      ['prefix-core', 'p:cli-3', 'a', ['plugins']],
      ['under-core-two', 'p:cli-4', 'a', ['plugins', 'list', 'all']],
      ['under-core-one', 'p:cli-5', 'a', ['status', 'detail']],
      ['default-path', 'builtin:plugins', 'list', undefined],
    ] as const) {
      await assertRejectsCode(
        () =>
          host.register({
            id: pluginId,
            definePlugin(ctx) {
              ctx.action({
                id: actionId,
                description: slug,
                inputSchema: emptySchema,
                outputSchema: emptySchema,
                ...(command !== undefined ? { cli: { command: [...command] } } : {}),
                handler: () => ({}),
              });
            },
          }),
        'duplicate_cli_command',
        409,
      );
    }

    // 4. Intra-plugin CLI collisions (exact and prefix in both orders)
    await assertRejectsCode(
      () =>
        host.register({
          id: 'p:cli-intra-exact',
          definePlugin(ctx) {
            ctx.action({ id: 'a1', description: 'a1', cli: { command: ['alpha', 'run'] }, inputSchema: emptySchema, outputSchema: emptySchema, handler: () => ({}) });
            ctx.action({ id: 'a2', description: 'a2', cli: { command: ['alpha', 'run'] }, inputSchema: emptySchema, outputSchema: emptySchema, handler: () => ({}) });
          },
        }),
      'duplicate_cli_command',
      409,
    );
    await assertRejectsCode(
      () =>
        host.register({
          id: 'p:cli-intra-prefix',
          definePlugin(ctx) {
            ctx.action({ id: 'a1', description: 'a1', cli: { command: ['alpha', 'run'] }, inputSchema: emptySchema, outputSchema: emptySchema, handler: () => ({}) });
            ctx.action({ id: 'a2', description: 'a2', cli: { command: ['alpha'] }, inputSchema: emptySchema, outputSchema: emptySchema, handler: () => ({}) });
          },
        }),
      'duplicate_cli_command',
      409,
    );

    // 5. Hidden / ui / internal actions and non-colliding sibling subcommands are allowed
    await host.register({
      id: 'p:cli-non-colliding',
      definePlugin(ctx) {
        ctx.action({ id: 'ui_list', description: 'ui', visibility: 'ui', inputSchema: emptySchema, outputSchema: emptySchema, handler: () => ({}) });
        ctx.action({ id: 'hidden_list', description: 'hidden', cli: { hidden: true, command: ['plugins', 'list'] }, inputSchema: emptySchema, outputSchema: emptySchema, handler: () => ({}) });
        ctx.action({ id: 'sibling', description: 'sibling', cli: { command: ['plugins', 'custom-ext'] }, inputSchema: emptySchema, outputSchema: emptySchema, handler: () => ({}) });
      },
    });

    // 6. Cross-plugin tool & CLI collisions rejected at enable commit (never poison listTools()),
    //    while disabled plugins do not reserve global names.
    await host.register(
      {
        id: 'p:tool-holder',
        definePlugin(ctx) {
          ctx.tool({ name: 'global_unique_tool', description: 'holder', inputSchema: emptySchema, execute: () => 'ok' });
          ctx.action({
            id: 'do_thing',
            description: 'holder cli',
            cli: { command: ['team', 'deploy'] },
            inputSchema: emptySchema,
            outputSchema: emptySchema,
            handler: () => ({}),
          });
        },
      },
      { enabled: false },
    );

    // Active plugin succeeds while p:tool-holder is disabled
    await host.register({
      id: 'p:tool-active',
      definePlugin(ctx) {
        ctx.action({
          id: 'deploy',
          description: 'active cli + tool',
          cli: { command: ['team', 'deploy', 'prod'] },
          exposeAsTool: { name: 'global_unique_tool' },
          inputSchema: emptySchema,
          outputSchema: emptySchema,
          handler: () => ({}),
        });
      },
    });
    assert.deepEqual(
      host.listTools().map((t) => t.name),
      ['global_unique_tool'],
    );

    // Enabling p:tool-holder now rejects with 409 duplicate_tool_name and leaves listTools() healthy
    await assertRejectsCode(() => host.enable('p:tool-holder'), 'duplicate_tool_name', 409);
    assert.equal(host.get('p:tool-holder')?.enabled, false);
    assert.deepEqual(
      host.listTools().map((t) => t.name),
      ['global_unique_tool'],
    );

    // Cross-plugin CLI prefix collision (distinct tool name) rejects with 409 duplicate_cli_command
    await host.register(
      {
        id: 'p:cli-prefix-rival',
        definePlugin(ctx) {
          ctx.action({
            id: 'root',
            description: 'rival cli prefix',
            cli: { command: ['team', 'deploy'] },
            inputSchema: emptySchema,
            outputSchema: emptySchema,
            handler: () => ({}),
          });
        },
      },
      { enabled: false },
    );
    await assertRejectsCode(() => host.enable('p:cli-prefix-rival'), 'duplicate_cli_command', 409);
    assert.equal(host.get('p:cli-prefix-rival')?.enabled, false);

    // Disabling active holder releases both tool name and CLI prefix so disabled plugins can enable
    await host.disable('p:tool-active');
    await host.enable('p:tool-holder');
    assert.equal(host.get('p:tool-holder')?.enabled, true);
    assert.deepEqual(
      host.listTools().map((t) => t.name),
      ['global_unique_tool'],
    );
  } finally {
    await host.dispose();
  }
});

test('concurrent enable race with colliding tool or CLI command commits only one winner and rolls back loser', { timeout: 60_000 }, async () => {
  const emptySchema = { type: 'object', properties: {} } as const;
  for (const kind of ['tool', 'cli'] as const) {
    const enabled = new Map<string, boolean>();
    let arrived = 0;
    const gate = deferred();
    const ready = deferred();
    const host = makeHost({
      get: () => ({}),
      set: () => {},
      getEnabled: (id) => enabled.get(id),
      setEnabled: async (id, value) => {
        enabled.set(id, value);
        if (!value) return;
        arrived += 1;
        if (arrived === 2) ready.resolve();
        await gate.promise;
      },
    });
    const makeDef = (id: string): PluginDefinition => ({
      id,
      definePlugin(ctx) {
        if (kind === 'tool') {
          ctx.tool({ name: 'race_shared_tool', description: id, inputSchema: emptySchema, execute: () => id });
        } else {
          ctx.action({
            id: 'op',
            description: id,
            cli: { command: ['racecmd', 'run'] },
            inputSchema: emptySchema,
            outputSchema: emptySchema,
            handler: () => ({}),
          });
        }
      },
    });
    try {
      await host.register(makeDef(`p:race-${kind}-a`), { enabled: false });
      await host.register(makeDef(`p:race-${kind}-b`), { enabled: false });
      const settled = Promise.allSettled([host.enable(`p:race-${kind}-a`), host.enable(`p:race-${kind}-b`)]);
      await ready.promise;
      gate.resolve();
      const results = await settled;
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
      assert.ok(failed.reason instanceof HelmxError);
      assert.equal(failed.reason.status, 409);
      assert.equal(failed.reason.code, kind === 'tool' ? 'duplicate_tool_name' : 'duplicate_cli_command');
      assert.equal(host.list().filter((p) => p.enabled).length, 1);
      assert.doesNotThrow(() => host.listTools());
    } finally {
      gate.resolve();
      await host.dispose();
    }
  }
});

test('concurrent register race with colliding tool or CLI command commits only one winner and rolls back loser', { timeout: 60_000 }, async () => {
  const emptySchema = { type: 'object', properties: {} } as const;
  for (const kind of ['tool', 'cli'] as const) {
    let arrived = 0;
    const gate = deferred();
    const ready = deferred();
    const stopped: string[] = [];
    const host = makeHost();
    await host.start();
    const makeDef = (id: string): PluginDefinition => ({
      id,
      definePlugin(ctx) {
        if (kind === 'tool') {
          ctx.tool({ name: 'reg_race_shared_tool', description: id, inputSchema: emptySchema, execute: () => id });
        } else {
          ctx.action({
            id: 'op',
            description: id,
            cli: { command: ['regrace', 'run'] },
            inputSchema: emptySchema,
            outputSchema: emptySchema,
            handler: () => ({}),
          });
        }
        ctx.service({
          id: 'svc',
          async start() {
            arrived += 1;
            if (arrived === 2) ready.resolve();
            await gate.promise;
          },
          stop() {
            stopped.push(id);
          },
        });
      },
    });
    try {
      const settled = Promise.allSettled([
        host.register(makeDef(`p:reg-race-${kind}-a`), { enabled: true }),
        host.register(makeDef(`p:reg-race-${kind}-b`), { enabled: true }),
      ]);
      await ready.promise;
      gate.resolve();
      const results = await settled;
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
      assert.ok(failed.reason instanceof HelmxError);
      assert.equal(failed.reason.status, 409);
      assert.equal(failed.reason.code, kind === 'tool' ? 'duplicate_tool_name' : 'duplicate_cli_command');
      const enabledPlugins = host.list().filter((p) => p.enabled);
      assert.equal(enabledPlugins.length, 1);
      assert.equal(stopped.length, 1, 'loser service must be stopped during rollback');
      assert.notEqual(stopped[0], enabledPlugins[0]!.id);
      assert.doesNotThrow(() => host.listTools());
      assert.doesNotThrow(() => host.listActions());
    } finally {
      gate.resolve();
      await host.dispose();
    }
  }
});

test('input/before_turn/turn_settled hooks validate ConversationInput attachments and meta schemas; ConversationInputPipeline enforces boundary independently', { timeout: 60_000 }, async () => {
  const host = makeHost();
  try {
    let transformedInput: unknown;
    await host.register({
      id: 'p:input-attachment-schema',
      definePlugin: (ctx) => {
        ctx.hook.onInput((payload) => ({
          action: 'transform',
          value: { ...payload, input: transformedInput as never },
        }));
        ctx.hook.onBeforeTurn(() => undefined);
        ctx.hook.onAgentSpawn(async (req, next) => {
          await next(req);
        });
      },
    });
    const baseInput = {
      id: 'in-1',
      text: 'hello',
      origin: 'human' as const,
      createdAt: 1_000,
    };
    const validRef = { id: 'art-1', name: 'note.txt', mimeType: 'text/plain', size: 0 };

    // Valid attachments + meta pass transform validation.
    transformedInput = { ...baseInput, meta: { trace: 'ok' }, attachments: [validRef] };
    const ok = await host.runHook('input', { conversationId: 1, input: baseInput });
    assert.equal(ok.action, 'transform');

    const invalidInputs: unknown[] = [
      { ...baseInput, attachments: 'not-array' },
      { ...baseInput, attachments: [null] },
      { ...baseInput, attachments: ['art-1'] },
      { ...baseInput, attachments: [{ ...validRef, id: '   ' }] },
      { ...baseInput, attachments: [{ ...validRef, name: '' }] },
      { ...baseInput, attachments: [{ ...validRef, mimeType: '' }] },
      { ...baseInput, attachments: [{ ...validRef, size: -1 }] },
      { ...baseInput, attachments: [{ ...validRef, size: 1.5 }] },
      { ...baseInput, meta: 'not-an-object' },
      { ...baseInput, meta: [] },
    ];
    for (const bad of invalidInputs) {
      transformedInput = bad;
      await assertRejectsCode(
        () => host.runHook('input', { conversationId: 1, input: baseInput }),
        'invalid_hook_result',
      );
      await assertRejectsCode(
        () =>
          host.runHook('before_turn', {
            conversation: makeConversation(1),
            inputs: [bad as never],
            tools: [],
            sections: [],
            messages: [],
          }),
        'invalid_hook_result',
      );
    }

    // agent_spawn rejects blank attachment IDs.
    await assertRejectsCode(
      () =>
        host.runHookAround(
          'agent_spawn',
          { parentConversationId: 1, prompt: 'go', attachments: ['   '] },
          async () => ({}),
        ),
      'invalid_hook_result',
    );
  } finally {
    await host.dispose();
  }

  // Defense-in-depth: ConversationInputPipeline.prepareInput also rejects malformed hook attachments
  // directly with invalid_hook_result (never raw TypeError) even if runInputHook bypasses HookPipeline.
  const { ConversationInputPipeline } = await import('../src/runtime/conversation-input.js');
  for (const badAttachments of ['not-array', [null], [{ id: '', name: 'a', mimeType: 'text/plain', size: 1 }]]) {
    const pipeline = new ConversationInputPipeline({
      harness: {} as never,
      store: {} as never,
      tracker: {} as never,
      stash: { redact: (t: string) => t } as never,
      runInputHook: async (p) => {
        const typed = p as { conversationId: number; input: Record<string, unknown> };
        return {
          action: 'transform',
          value: { conversationId: typed.conversationId, input: { ...typed.input, attachments: badAttachments } },
        };
      },
      resolveAuthorizedAttachments: async () => [],
      assertMutationGuard: () => {},
    });
    await assertRejectsCode(() => pipeline.prepareInput(1, 'hi', undefined, undefined), 'invalid_hook_result');
  }
});
