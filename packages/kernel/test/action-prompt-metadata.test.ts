/**
 * action-prompt-metadata.test.ts
 *
 * Registration contracts for action/tool prompt metadata (`promptSnippet` / `promptGuidelines`):
 * - malformed metadata is rejected explicitly at the registration boundary (same rules for actions and tools);
 * - `ActionManifest` preserves declared metadata faithfully (omitting keys when undeclared);
 * - derived tools from `exposeAsTool` actions carry prompt metadata;
 * - derived tools excluded by scope remain completely hidden without leaking phantom metadata;
 * - mutating caller arrays/specs after registration does not pollute validated registry state (defensive copies).
 * runner: tsx --test; explicit timeout: 60_000 per test to guard against deadlocks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HelmxError, type ConversationSummary, type PluginActionSpec, type PluginToolSpec } from '@helmx/protocol';
import {
  CapabilityRegistry,
  actionToolAlias,
} from '../src/plugins/capability-registry.js';
import { actionCliCommand } from '../src/runtime/action-prompts.js';
import { actionToolResult } from '../src/runtime/runtime-helpers.js';

function fakeConversation(tags: string[]): ConversationSummary {
  return {
    id: 1,
    title: 'test',
    profileId: 'assistant',
    tags,
    cwd: '/tmp',
    model: 'm',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function baseAction(over: Partial<PluginActionSpec<unknown, unknown>> = {}): PluginActionSpec<unknown, unknown> {
  return {
    id: 'act',
    description: 'action description',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: {} },
    handler: () => ({}),
    ...over,
  };
}

function baseTool(over: Partial<PluginToolSpec> = {}): PluginToolSpec {
  return {
    name: 'toolX',
    description: 'tool description',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => 'ok',
    ...over,
  };
}

function expectHelmxError(code: string, field: string): (err: unknown) => boolean {
  return (err: unknown): boolean => {
    assert.ok(err instanceof HelmxError, `expected HelmxError, got ${String(err)}`);
    assert.equal(err.code, code);
    assert.ok(err.message.includes(field), `error message should reference field ${field}: ${err.message}`);
    return true;
  };
}

test('malformed prompt metadata rejects explicitly at registration boundary for both actions and tools', { timeout: 60_000 }, () => {
  const cap = new CapabilityRegistry();

  // action: whitespace-only / non-string snippet; empty / non-array / whitespace-element / non-string / sparse guidelines
  assert.throws(
    () => cap.registerAction('p', baseAction({ promptSnippet: '   \t ' })),
    expectHelmxError('invalid_action_spec', 'promptSnippet'),
  );
  assert.throws(
    () => cap.registerAction('p', baseAction({ promptSnippet: 42 as unknown as string })),
    expectHelmxError('invalid_action_spec', 'promptSnippet'),
  );
  assert.throws(
    () => cap.registerAction('p', baseAction({ promptGuidelines: [] })),
    expectHelmxError('invalid_action_spec', 'promptGuidelines'),
  );
  assert.throws(
    () => cap.registerAction('p', baseAction({ promptGuidelines: 'x' as unknown as string[] })),
    expectHelmxError('invalid_action_spec', 'promptGuidelines'),
  );
  assert.throws(
    () => cap.registerAction('p', baseAction({ promptGuidelines: ['ok', '  '] })),
    expectHelmxError('invalid_action_spec', 'promptGuidelines'),
  );
  assert.throws(
    () => cap.registerAction('p', baseAction({ promptGuidelines: [1] as unknown as string[] })),
    expectHelmxError('invalid_action_spec', 'promptGuidelines'),
  );

  assert.throws(
    () => cap.registerAction('p', baseAction({ promptGuidelines: new Array<string>(1) })),
    expectHelmxError('invalid_action_spec', 'promptGuidelines'),
  );

  // tool: same validation rules (invalid_tool_spec)
  assert.throws(
    () => cap.registerTool('p', baseTool({ promptSnippet: '\n' })),
    expectHelmxError('invalid_tool_spec', 'promptSnippet'),
  );
  assert.throws(
    () => cap.registerTool('p', baseTool({ promptGuidelines: [' '] })),
    expectHelmxError('invalid_tool_spec', 'promptGuidelines'),
  );

  assert.throws(
    () => cap.registerTool('p', baseTool({ promptGuidelines: new Array<string>(1) })),
    expectHelmxError('invalid_tool_spec', 'promptGuidelines'),
  );

  // Rejected declarations leave no leftover registrations
  assert.deepEqual(cap.getActionIds('p'), []);
  assert.deepEqual(cap.getToolNames('p'), []);

  // Valid declarations (surrounding whitespace allowed when non-empty content present) pass
  cap.registerAction('p', baseAction({ promptSnippet: ' sync config via act.' }));
  cap.registerTool('p', baseTool({ promptGuidelines: ['read SKILL.md first'] }));
  assert.deepEqual(cap.getActionIds('p'), ['act']);
  assert.deepEqual(cap.getToolNames('p'), ['toolX']);
});

test('ActionManifest preserves prompt fields faithfully and omits undeclared keys', { timeout: 60_000 }, () => {
  const cap = new CapabilityRegistry();
  cap.registerAction(
    'p',
    baseAction({
      id: 'withPrompt',
      promptSnippet: 'sync config via withPrompt.',
      promptGuidelines: ['verify target node is online first', 'result matching outputSchema is valid'],
    }),
  );
  cap.registerAction('p', baseAction({ id: 'bare' }));

  const manifests = cap.listActions(['p']);
  const withPrompt = manifests.find((m) => m.id === 'withPrompt');
  const bare = manifests.find((m) => m.id === 'bare');
  assert.ok(withPrompt && bare);

  assert.equal(withPrompt.promptSnippet, 'sync config via withPrompt.');
  assert.deepEqual(withPrompt.promptGuidelines, ['verify target node is online first', 'result matching outputSchema is valid']);
  assert.equal('promptSnippet' in bare, false);
  assert.equal('promptGuidelines' in bare, false);
});

test('exposeAsTool derived tool carries prompt metadata and disappears completely when excluded by scope', { timeout: 60_000 }, () => {
  const cap = new CapabilityRegistry();
  cap.registerAction(
    'p',
    baseAction({
      id: 'scoped',
      exposeAsTool: true,
      scope: { tags: ['worker'] },
      promptSnippet: 'scoped action snippet.',
      promptGuidelines: ['only available in worker conversations'],
    }),
  );
  cap.registerTool('p', baseTool({ promptGuidelines: ['direct tool guideline'] }));

  const worker = cap.listTools(['p'], fakeConversation(['worker']));
  const derived = worker.find((t) => t.sourceKind === 'action');
  assert.ok(derived);
  assert.equal(derived.name, actionToolAlias('p', 'scoped'));
  assert.equal(derived.qualifiedId, 'p.scoped');
  assert.equal(derived.promptSnippet, 'scoped action snippet.');
  assert.deepEqual(derived.promptGuidelines, ['only available in worker conversations']);

  const direct = worker.find((t) => t.sourceKind === 'tool');
  assert.ok(direct);
  assert.deepEqual(direct.promptGuidelines, ['direct tool guideline']);

  // Excluded by scope: derived tool is omitted without leaking prompt metadata; unscoped direct tool stays visible
  const other = cap.listTools(['p'], fakeConversation(['other']));
  assert.equal(other.some((t) => t.sourceKind === 'action'), false);
  assert.equal(other.every((t) => t.promptSnippet === undefined), true);
  assert.equal(other.some((t) => t.name === 'toolX'), true);
});

test('mutating caller promptGuidelines/spec after registration does not pollute registered state', { timeout: 60_000 }, () => {
  const cap = new CapabilityRegistry();
  const guidelines = ['original guideline'];
  cap.registerAction('p', baseAction({ id: 'a', promptGuidelines: guidelines }));
  const toolSpec = baseTool({ promptSnippet: 'original snippet', promptGuidelines: guidelines });
  cap.registerTool('p', toolSpec);

  guidelines.push('polluted item');
  guidelines[0] = 'overwritten';
  toolSpec.promptSnippet = 'rebound snippet';
  toolSpec.promptGuidelines = ['rebound guideline'];

  const manifest = cap.listActions(['p']).find((m) => m.id === 'a');
  assert.ok(manifest);
  assert.deepEqual(manifest.promptGuidelines, ['original guideline']);

  const tool = cap.listTools(['p']).find((t) => t.name === 'toolX');
  assert.ok(tool);
  assert.equal(tool.promptSnippet, 'original snippet');
  assert.deepEqual(tool.promptGuidelines, ['original guideline']);

  // External mutation of returned manifest copies also must not write back into registry state
  manifest.promptGuidelines!.push('external pollution');
  const again = cap.listActions(['p']).find((m) => m.id === 'a');
  assert.ok(again);
  assert.deepEqual(again.promptGuidelines, ['original guideline']);
});

test('exposeToPrompt rejects non-booleans at registration and preserves boolean flag on ActionManifest', { timeout: 60_000 }, () => {
  const cap = new CapabilityRegistry();
  assert.throws(
    () => cap.registerAction('p', baseAction({ exposeToPrompt: 'false' as unknown as boolean })),
    expectHelmxError('invalid_action_spec', 'exposeToPrompt'),
  );
  cap.registerAction('p', baseAction({ id: 'hidden', exposeToPrompt: false }));
  const hidden = cap.listActions(['p']).find((m) => m.id === 'hidden');
  assert.equal(hidden?.exposeToPrompt, false);
});

test('actionCliCommand suppresses ui and internal visibility actions while advertising public actions', { timeout: 60_000 }, () => {
  const cap = new CapabilityRegistry();
  cap.registerAction('builtin:demo', baseAction({ id: 'pub', visibility: 'public' }));
  cap.registerAction('builtin:demo', baseAction({ id: 'ui_act', visibility: 'ui' }));
  cap.registerAction('builtin:demo', baseAction({ id: 'int_act', visibility: 'internal' }));

  const byId = new Map(cap.listActions(['builtin:demo']).map((m) => [m.id, m]));
  assert.equal(actionCliCommand(byId.get('pub')!), 'helmx demo pub');
  assert.equal(actionCliCommand(byId.get('ui_act')!), undefined);
  assert.equal(actionCliCommand(byId.get('int_act')!), undefined);
});

test('actionToolResult supports formatOutput with redaction, validation, and three-channel separation', { timeout: 60_000 }, () => {
  const redact = (text: string) => text.replaceAll('SECRET_TOKEN', '[REDACTED]');
  const outputSchema = {
    type: 'object',
    properties: { id: { type: 'string' }, note: { type: 'string' } },
    required: ['id', 'note'],
    additionalProperties: false,
  };
  const presentationMetaSchema = {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  };

  // String formatOutput: redacted model text + redacted structuredOutput + bounded presentationMeta
  const strRes = actionToolResult({ id: 'item-1', note: 'val=SECRET_TOKEN' }, { q: '1' }, redact, {
    toolName: 'demo_tool',
    structuredOutputSchema: outputSchema,
    presentationMetaSchema,
    projectPresentationMeta: (_input, out) => ({ id: (out as { id: string }).id }),
    formatOutput: (_input, out) => `Formatted ${(out as { id: string; note: string }).id}: ${(out as { note: string }).note}`,
  });
  assert.deepEqual(strRes.output, [{ type: 'text', text: 'Formatted item-1: val=[REDACTED]' }]);
  assert.deepEqual(strRes.structuredOutput, { id: 'item-1', note: 'val=[REDACTED]' });
  assert.deepEqual(strRes.details, { id: 'item-1' });

  // Text-block array formatOutput
  const arrRes = actionToolResult({ id: 'item-2', note: 'ok' }, {}, redact, {
    toolName: 'demo_tool',
    structuredOutputSchema: outputSchema,
    formatOutput: () => [{ type: 'text', text: 'line SECRET_TOKEN' }],
  });
  assert.deepEqual(arrRes.output, [{ type: 'text', text: 'line [REDACTED]' }]);
  assert.equal(arrRes.details, undefined);

  // Undefined or malformed formatOutput return fails explicitly with 500 invalid_tool_result
  assert.throws(
    () =>
      actionToolResult({ id: 'item-3', note: 'ok' }, {}, redact, {
        toolName: 'demo_tool',
        formatOutput: () => undefined as unknown as string,
      }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.status === 500,
  );
  assert.throws(
    () =>
      actionToolResult({ id: 'item-3', note: 'ok' }, {}, redact, {
        toolName: 'demo_tool',
        formatOutput: () => [{ type: 'image', data: 'abc' }] as never,
      }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_tool_result' && err.status === 500,
  );
});
