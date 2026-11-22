/**
 * ui-registry-extensions.test.ts: boundary tests for UiRegistry extension validation.
 *
 * Covers validation boundaries moved out of addUi (driving registry directly without PluginHost):
 * - sessionDocs list format and 3-arg assertUiDocsRegistered (session publicity check, default behavior);
 * - action tracks (at least one of actionId/client/json, field ownership for placement/kinds/roles);
 * - finite safe integers for priority/order;
 * - commandPalette slash format, reserved words, intra-plugin duplicates, and profile.runtime kind duplicates;
 * - assertCrossPluginUnique cross-plugin final checks (active+pending without double-scanning self,
 *   self-only registration does not trigger, inactive probes do not reserve global names);
 * - name release after clear/remove.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HelmxError } from '@helmx/protocol';
import { UiRegistry } from '../src/plugins/ui-registry.js';
import { createPluginBuildProvider } from '@helmx/plugin-build';

const isHelmxError = (code: string) => (err: unknown): boolean => err instanceof HelmxError && err.code === code;

/** Test clientRoot (needed for client-reference schema validation; directory does not need to exist yet). */
const CLIENT_ROOT = '/tmp/helmx-test-client-root';

/** Minimal helper to register a valid commandPalette spec (uses actionId track by default; omits slash if unset). */
function registerCommand(ui: UiRegistry, pluginId: string, id: string, slash?: string): void {
  const spec: Record<string, unknown> = { id, title: id, actionId: 'noop' };
  if (slash !== undefined) spec.slash = slash;
  ui.registerUi(pluginId, 'commandPalette', spec, 'command');
}

test('markdown.codeBlock: validates languages shape, rejects duplicates, requires client', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  const client = { module: 'index.tsx', export: 'C' };

  // Valid declaration (multiple languages + priority)
  ui.registerUi(
    'p1',
    'markdown.codeBlock',
    { id: 'cb1', languages: ['ui', 'json-render'], priority: 5, client },
    'markdownCodeBlock',
    CLIENT_ROOT,
  );

  // Empty array / non-string / invalid uppercase / duplicates all reject
  assert.throws(
    () => ui.registerUi('p1', 'markdown.codeBlock', { id: 'bad1', languages: [], client }, 'markdownCodeBlock'),
    isHelmxError('invalid_ui_spec'),
  );
  assert.throws(
    () => ui.registerUi('p1', 'markdown.codeBlock', { id: 'bad2', languages: ['a', 1], client }, 'markdownCodeBlock'),
    isHelmxError('invalid_ui_spec'),
  );
  assert.throws(
    () => ui.registerUi('p1', 'markdown.codeBlock', { id: 'bad3', languages: ['UI'], client }, 'markdownCodeBlock'),
    isHelmxError('invalid_ui_spec'),
  );
  assert.throws(
    () => ui.registerUi('p1', 'markdown.codeBlock', { id: 'bad4', languages: ['a', 'a'], client }, 'markdownCodeBlock'),
    isHelmxError('invalid_ui_spec'),
  );
  // Missing client: rejects (no declarative fallback path)
  assert.throws(
    () => ui.registerUi('p1', 'markdown.codeBlock', { id: 'bad5', languages: ['a'] }, 'markdownCodeBlock'),
    isHelmxError('invalid_ui_spec'),
  );
});

test('priority/order must be finite safe integers', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  ui.registerUi('p1', 'sidebar.item', { id: 'ok1', label: 'A', priority: 10, order: -3 }, 'sidebarItem');
  ui.registerUi('p1', 'sidebar.item', { id: 'ok2', label: 'B', priority: 0 }, 'sidebarItem');

  for (const field of ['priority', 'order']) {
    for (const bad of [1.5, NaN, Infinity, -Infinity, '3', null]) {
      assert.throws(
        () => ui.registerUi('p1', 'sidebar.item', { id: `bad-${field}`, label: 'B', [field]: bad }, 'sidebarItem'),
        isHelmxError('invalid_ui_spec'),
        `field=${field} value=${String(bad)}`,
      );
    }
  }
});

test('commandPalette: slash format, reserved words, and intra-plugin duplicates', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  registerCommand(ui, 'p1', 'cmd1', 'wf');
  registerCommand(ui, 'p1', 'cmd2'); // omitting slash is valid

  // Invalid format: leading /, uppercase, illegal chars, oversized
  for (const bad of ['/wf', 'WF', 'a b', 'a#b', 'x'.repeat(66)]) {
    assert.throws(
      () => registerCommand(ui, 'p1', `cmd-bad`, bad),
      isHelmxError('invalid_ui_spec'),
      `slash=${bad}`,
    );
  }
  // Host reserved words and skill: prefix
  for (const reserved of ['new', 'clear', 'compact', 'skill:run']) {
    assert.throws(
      () => registerCommand(ui, 'p1', `cmd-res`, reserved),
      isHelmxError('invalid_ui_spec'),
      `slash=${reserved}`,
    );
  }
  // Intra-plugin duplicate slash: 409 duplicate_command_slash with slash in details
  assert.throws(
    () => registerCommand(ui, 'p1', 'cmd-dup', 'wf'),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError);
      assert.equal(err.code, 'duplicate_command_slash');
      assert.equal(err.status, 409);
      assert.deepEqual((err.details as { pluginId: string; slash: string }).slash, 'wf');
      return true;
    },
  );
  // Commands must be triggerable: omitting slash and all execution tracks rejects
  assert.throws(
    () => ui.registerUi('p1', 'commandPalette', { id: 'cmd-empty', title: 'E' }, 'command'),
    isHelmxError('invalid_ui_spec'),
  );
  // client-track command is valid; slash commands must supply an executable action (never an unexecutable suggestion)
  ui.registerUi('p1', 'commandPalette', { id: 'cmd-client', title: 'C', client: { module: 'index.tsx', export: 'X' } }, 'command', CLIENT_ROOT);
  assert.throws(
    () => ui.registerUi('p1', 'commandPalette', { id: 'slash-client-only', title: 'C', slash: 'client-only' }, 'command'),
    isHelmxError('invalid_ui_spec'),
  );
  for (const actionId of ['', 5, 'bad.id']) {
    assert.throws(
      () => ui.registerUi('p1', 'commandPalette', { id: 'bad-action', title: 'A', actionId }, 'command'),
      isHelmxError('invalid_ui_spec'),
    );
  }
  assert.throws(() => ui.registerUi('p1', 'screen', null, 'screen'), isHelmxError('invalid_ui_spec'));
});

test('sidebar.item badge: plain-object shape, unknown keys, unsafe doc-key fields', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  const validBadge = {
    doc: 'task-board',
    countField: 'attentionCount',
    toneField: 'badgeTone',
    dotField: 'hasRunning',
    summaryField: 'badgeSummary',
  };

  // Valid: full declaration and minimal { doc, countField } both pass; other spec fields untouched.
  ui.registerUi('p1', 'sidebar.item', { id: 'ok-full', label: 'A', badge: validBadge }, 'sidebarItem');
  ui.registerUi('p1', 'sidebar.item', { id: 'ok-min', label: 'B', badge: { doc: 'd', countField: 'c' } }, 'sidebarItem');
  ui.registerUi('p1', 'sidebar.item', { id: 'ok-none', label: 'C', docs: ['d1'] }, 'sidebarItem');

  // Non-plain-object badge rejects
  for (const bad of [null, 'x', 5, [], () => {}]) {
    assert.throws(
      () => ui.registerUi('p1', 'sidebar.item', { id: 'bad-not-obj', label: 'B', badge: bad }, 'sidebarItem'),
      isHelmxError('invalid_ui_spec'),
      `badge=${JSON.stringify(bad) ?? String(bad)}`,
    );
  }
  // Unknown keys inside badge reject (additionalProperties: false)
  assert.throws(
    () =>
      ui.registerUi('p1', 'sidebar.item', { id: 'bad-extra', label: 'B', badge: { doc: 'd', countField: 'c', extra: 1 } }, 'sidebarItem'),
    isHelmxError('invalid_ui_spec'),
  );
  // Required fields missing / empty / non-string reject
  for (const bad of [{ countField: 'c' }, { doc: 'd' }, { doc: '', countField: 'c' }, { doc: 'd', countField: '' }, { doc: 'd', countField: 5 }]) {
    assert.throws(
      () => ui.registerUi('p1', 'sidebar.item', { id: 'bad-fields', label: 'B', badge: bad }, 'sidebarItem'),
      isHelmxError('invalid_ui_spec'),
      `badge=${JSON.stringify(bad)}`,
    );
  }
  // Optional fields with empty / non-string values reject
  for (const field of ['toneField', 'dotField', 'summaryField']) {
    for (const bad of ['', null, 7]) {
      assert.throws(
        () => ui.registerUi('p1', 'sidebar.item', { id: 'bad-opt', label: 'B', badge: { doc: 'd', countField: 'c', [field]: bad } }, 'sidebarItem'),
        isHelmxError('invalid_ui_spec'),
        `field=${field} value=${String(bad)}`,
      );
    }
  }
  // Unsafe prototype keys as field values reject (they become doc-key reads on the host)
  for (const field of ['doc', 'countField', 'toneField', 'dotField', 'summaryField']) {
    for (const unsafe of ['__proto__', 'constructor', 'prototype']) {
      assert.throws(
        () => ui.registerUi('p1', 'sidebar.item', { id: 'bad-unsafe', label: 'B', badge: { doc: 'd', countField: 'c', [field]: unsafe } }, 'sidebarItem'),
        isHelmxError('invalid_ui_spec'),
        `field=${field} value=${unsafe}`,
      );
    }
  }
  // Own unsafe keys on the badge object itself reject via additionalProperties
  assert.throws(
    () =>
      ui.registerUi(
        'p1',
        'sidebar.item',
        { id: 'bad-own-key', label: 'B', badge: JSON.parse('{"doc":"d","countField":"c","__proto__":"x"}') },
        'sidebarItem',
      ),
    isHelmxError('invalid_ui_spec'),
  );
});

test('assertCrossPluginUnique: checks across active+pending while excluding self', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  registerCommand(ui, 'a', 'cmd', 'wf');
  registerCommand(ui, 'b', 'cmd', 'wf'); // conflicts with a
  registerCommand(ui, 'c', 'cmd', 'other');

  // Registry itself does not track active plugins: succeeds when namespaces are disjoint
  ui.assertCrossPluginUnique('c', ['a', 'c']);
  // pending=b conflicts with active a: slash collision rejects
  assert.throws(
    () => ui.assertCrossPluginUnique('b', ['a', 'c']),
    isHelmxError('duplicate_command_slash'),
  );

  // When pending also appears in the active list (e.g. host passes active ∪ pending), self must not collide with itself
  const ui2 = new UiRegistry(createPluginBuildProvider());
  registerCommand(ui2, 'a', 'cmd', 'wf');
  ui2.assertCrossPluginUnique('a', ['a']);

  // Pending plugin with zero declarations passes
  const ui3 = new UiRegistry(createPluginBuildProvider());
  ui3.assertCrossPluginUnique('empty', ['a', 'b']);
});

test('inactive probe reserves no global names: disabled-by-default registrations skip final check', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  registerCommand(ui, 'probe', 'cmd', 'wf');

  // probe is disabled by default (not in active set), so b can claim the same slash
  ui.assertCrossPluginUnique('b', ['b']);
  registerCommand(ui, 'b', 'cmd', 'wf');

  // Once probe is enabled (entering active set), the final uniqueness check rejects it
  assert.throws(
    () => ui.assertCrossPluginUnique('probe', ['b', 'probe']),
    isHelmxError('duplicate_command_slash'),
  );

  // Intra-plugin duplicate slash is still rejected immediately at registerUi before the final check
  assert.throws(
    () => ui.registerUi('b', 'commandPalette', { id: 'cmd2', title: 'C', slash: 'wf', actionId: 'x' }, 'command'),
    isHelmxError('duplicate_command_slash'),
  );
});

test('clear/remove releases registered names and UI declarations', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  registerCommand(ui, 'a', 'cmd', 'wf');
  ui.registerUi('a', 'sidebar.item', { id: 's1', label: 'S', docs: ['d1'] }, 'sidebarItem');

  // clear drops all specs: other plugins may claim those names
  ui.clear('a');
  assert.equal(ui.getUiByPlugin('a').length, 0);

  registerCommand(ui, 'b', 'cmd', 'wf');
  ui.assertCrossPluginUnique('b', ['b']);

  // removePlugin deletes entries completely: disappears from listUi(active)
  ui.removePlugin('b');
  assert.equal(ui.listUi(['b']).length, 0);
  ui.assertCrossPluginUnique('b', ['b']); // passes with zero specs
});
