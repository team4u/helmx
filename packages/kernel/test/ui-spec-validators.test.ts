/**
 * ui-spec-validators: minimal unit tests per UI surface extracted from registerUi.
 * Each surface covers one valid declaration (does not throw) + one representative set of invalid declarations (error code assertions);
 * error codes and messages stay character-for-character consistent with pre-extraction inline rules in registerUi (equivalence refactor regression anchor).
 *
 * runner: tsx --test; explicit timeout: 60_000 per test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HelmxError, type PluginUiContribution } from '@helmx/protocol';
import { validateUiSpecEarly, validateUiSpecLate, type UiSpecContext } from '../src/plugins/ui-spec-validators.js';

function makeCtx(surface: string, siblings: PluginUiContribution[] = []): UiSpecContext {
  return {
    pluginId: 'p1',
    fnName: 'fn',
    surface,
    clientRoot: undefined,
    hasBuildProvider: true,
    siblings,
  };
}

const isHelmxError = (code: string) => (err: unknown): boolean => err instanceof HelmxError && err.code === code;

function expectThrow(
  run: () => void,
  code: string,
  messageIncludes?: string,
): void {
  assert.throws(run, (err: unknown) => {
    if (!(err instanceof HelmxError)) return false;
    assert.equal(err.code, code);
    if (messageIncludes !== undefined) {
      assert.ok(err.message.includes(messageIncludes), `message should include "${messageIncludes}", got: ${err.message}`);
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Early phase: commandPalette / plugin.slot
// ---------------------------------------------------------------------------

test('commandPalette: slash+actionId+shortcut pass; reserved words, duplicate slash, and invalid shortcut reject', { timeout: 60_000 }, () => {
  const ctx = makeCtx('commandPalette', [
    { pluginId: 'p1', surface: 'commandPalette', spec: { id: 'c0', slash: 'chart' } },
  ]);
  validateUiSpecEarly('commandPalette', { id: 'c1', slash: 'diagram', shortcut: 'Ctrl+.', actionId: 'act' }, 'c1', ctx);
  validateUiSpecEarly('commandPalette', { id: 'c2', shortcut: 'A'.repeat(32), actionId: 'act' }, 'c2', ctx);
  expectThrow(
    () => validateUiSpecEarly('commandPalette', { id: 'c1', slash: 'new', actionId: 'act' }, 'c1', makeCtx('commandPalette')),
    'invalid_ui_spec',
    'conflicts with a host reserved command',
  );
  expectThrow(() => validateUiSpecEarly('commandPalette', { id: 'c1', slash: 'chart', actionId: 'act' }, 'c1', ctx), 'duplicate_command_slash');
  expectThrow(
    () => validateUiSpecEarly('commandPalette', { id: 'c1', slash: 'chart' }, 'c1', makeCtx('commandPalette')),
    'invalid_ui_spec',
    'must bind actionId when declaring slash',
  );
  for (const badShortcut of ['', '   ', ' Ctrl+.', 'Ctrl+. ', 'Ctrl+\n.', 'A'.repeat(33), 123]) {
    expectThrow(
      () => validateUiSpecEarly('commandPalette', { id: 'c1', shortcut: badShortcut, actionId: 'act' }, 'c1', makeCtx('commandPalette')),
      'invalid_ui_spec',
      'shortcut must be a trimmed non-empty string',
    );
  }
});

test('commandPalette: target / keywords / description validation and triggerability (actionId | client | target)', { timeout: 60_000 }, () => {
  const ctx = makeCtx('commandPalette');
  // Valid declarative navigation target alone (no actionId or client required)
  validateUiSpecEarly(
    'commandPalette',
    {
      id: 'nav-tiers',
      target: 'screen:builtin:tiers/manager?create=1',
      description: { en: 'Create a model tier', 'zh-CN': '新建模型档位' },
      keywords: ['tier', 'model routing', '模型档位'],
    },
    'nav-tiers',
    ctx,
  );
  // Boundary length 512 target passes
  validateUiSpecEarly(
    'commandPalette',
    { id: 'max-target', target: 'a'.repeat(512), keywords: [] },
    'max-target',
    ctx,
  );
  // Client alone still passes
  validateUiSpecEarly(
    'commandPalette',
    { id: 'client-only', client: { module: 'index.tsx', export: 'Cmd' } },
    'client-only',
    ctx,
  );

  // Missing all three (actionId, client, target) rejects
  expectThrow(
    () => validateUiSpecEarly('commandPalette', { id: 'untriggerable', title: 'Nothing' }, 'untriggerable', ctx),
    'invalid_ui_spec',
    'must provide at least one of actionId, client, or target',
  );

  // Declaring slash still requires actionId even when target is provided
  expectThrow(
    () =>
      validateUiSpecEarly(
        'commandPalette',
        { id: 'slash-target', slash: 'open', target: 'screen:p1/main' },
        'slash-target',
        ctx,
      ),
    'invalid_ui_spec',
    'must bind actionId when declaring slash',
  );

  // Invalid target values reject
  for (const badTarget of ['', '   ', ' screen:p1/main', 'screen:p1/main ', 'screen:p1/main\nx', 'screen:p1/main\tx', 'a'.repeat(513), 42]) {
    expectThrow(
      () => validateUiSpecEarly('commandPalette', { id: 'bad-t', target: badTarget }, 'bad-t', ctx),
      'invalid_ui_spec',
      'target must be a trimmed non-empty string',
    );
  }

  // Invalid keywords reject
  for (const badKeywords of ['not-array', [''], ['   '], [' leading'], ['trailing '], ['a\nb'], [123]]) {
    expectThrow(
      () =>
        validateUiSpecEarly(
          'commandPalette',
          { id: 'bad-kw', target: 'screen:p1/main', keywords: badKeywords },
          'bad-kw',
          ctx,
        ),
      'invalid_ui_spec',
      'keywords must be an array of non-empty trimmed strings',
    );
  }

  // Invalid description rejects
  for (const badDesc of ['', '   ', { fr: 'bonjour' }, { en: 'ok', 'zh-CN': '  ' }, 42]) {
    expectThrow(
      () =>
        validateUiSpecEarly(
          'commandPalette',
          { id: 'bad-desc', target: 'screen:p1/main', description: badDesc },
          'bad-desc',
          ctx,
        ),
      'invalid_ui_spec',
      'description must be display copy',
    );
  }
});

test('screen and settings.panel: optional description and keywords validate cleanly', { timeout: 60_000 }, () => {
  for (const surface of ['screen', 'settings.panel'] as const) {
    const ctx = makeCtx(surface);
    validateUiSpecLate(
      surface,
      {
        id: 'ok1',
        label: { en: 'Manager', 'zh-CN': '管理' },
        description: { en: 'Manage rules', 'zh-CN': '管理规则' },
        keywords: ['cron', 'webhook', '定时'],
      },
      'ok1',
      ctx,
    );
    validateUiSpecLate(surface, { id: 'ok2', label: 'Simple', description: 'Plain description', keywords: [] }, 'ok2', ctx);

    for (const badDesc of ['', '  ', { de: 'Hallo' }, { en: '' }, 99]) {
      expectThrow(
        () => validateUiSpecLate(surface, { id: 'bad-d', label: 'X', description: badDesc }, 'bad-d', ctx),
        'invalid_ui_spec',
        'description must be display copy',
      );
    }
    for (const badKeywords of ['cron', [''], ['  '], [' padded'], ['padded '], ['a\tb'], [null]]) {
      expectThrow(
        () => validateUiSpecLate(surface, { id: 'bad-k', label: 'X', keywords: badKeywords }, 'bad-k', ctx),
        'invalid_ui_spec',
        'keywords must be an array of non-empty trimmed strings',
      );
    }
  }
});

test('plugin.slot: valid target+client passes; missing client, extra slashes, and invalid segment identifiers reject', { timeout: 60_000 }, () => {
  const validClient = { module: 'a.tsx', export: 'X' };
  validateUiSpecEarly('plugin.slot', { id: 's1', target: 'owner/panel', client: validClient }, 's1', makeCtx('plugin.slot'));
  expectThrow(
    () => validateUiSpecEarly('plugin.slot', { id: 's1', target: 'owner/panel' }, 's1', makeCtx('plugin.slot')),
    'invalid_ui_spec',
    'must declare client component reference',
  );
  expectThrow(
    () => validateUiSpecEarly('plugin.slot', { id: 's1', target: 'a/b/c', client: validClient }, 's1', makeCtx('plugin.slot')),
    'invalid_ui_spec',
    "must exactly contains a '/'",
  );
  expectThrow(
    () => validateUiSpecEarly('plugin.slot', { id: 's1', target: 'ow ner/panel', client: validClient }, 's1', makeCtx('plugin.slot')),
    'invalid_ui_spec',
    'segment identifier illegal',
  );
});

// ---------------------------------------------------------------------------
// Late phase
// ---------------------------------------------------------------------------

test('timeline.renderer: valid matchMeta passes; extra keys reject', { timeout: 60_000 }, () => {
  validateUiSpecLate('timeline.renderer', { id: 't1', matchMeta: { renderer: 'bash' } }, 't1', makeCtx('timeline.renderer'));
  expectThrow(
    () => validateUiSpecLate('timeline.renderer', { id: 't1', matchMeta: { renderer: 'bash', extra: 1 } }, 't1', makeCtx('timeline.renderer')),
    'invalid_ui_spec',
    'matchMeta only allows { renderer: non-empty string }',
  );
});

test('markdown.codeBlock: valid languages+client passes; duplicate languages and missing client reject', { timeout: 60_000 }, () => {
  validateUiSpecLate(
    'markdown.codeBlock',
    { id: 'm1', languages: ['mermaid'], client: { module: 'a.tsx', export: 'X' } },
    'm1',
    makeCtx('markdown.codeBlock'),
  );
  expectThrow(
    () => validateUiSpecLate('markdown.codeBlock', { id: 'm1', languages: ['mermaid', 'mermaid'], client: { module: 'a.tsx', export: 'X' } }, 'm1', makeCtx('markdown.codeBlock')),
    'invalid_ui_spec',
    'languages contains duplicate items',
  );
  expectThrow(
    () => validateUiSpecLate('markdown.codeBlock', { id: 'm1', languages: ['mermaid'] }, 'm1', makeCtx('markdown.codeBlock')),
    'invalid_ui_spec',
    'must declare a client component reference',
  );
});

test('tool.view: valid toolNames+replaceRow+foldable passes; non-boolean replaceRow or foldable rejects', { timeout: 60_000 }, () => {
  validateUiSpecLate('tool.view', { id: 'v1', toolNames: ['bash'], replaceRow: true, foldable: true }, 'v1', makeCtx('tool.view'));
  expectThrow(
    () => validateUiSpecLate('tool.view', { id: 'v1', toolNames: ['bash'], replaceRow: 'yes' }, 'v1', makeCtx('tool.view')),
    'invalid_ui_spec',
    'replaceRow must be boolean value',
  );
  expectThrow(
    () => validateUiSpecLate('tool.view', { id: 'v2', toolNames: ['update_steps'], foldable: 'yes' }, 'v2', makeCtx('tool.view')),
    'invalid_ui_spec',
    'foldable must be boolean value',
  );
});

test('composer.completer: valid action/doc sources pass; invalid trigger, client track, and __proto__ itemsField reject', { timeout: 60_000 }, () => {
  validateUiSpecLate(
    'composer.completer',
    { id: 'cp1', label: 'L', trigger: '@', source: { kind: 'action', actionId: 'list' } },
    'cp1',
    makeCtx('composer.completer'),
  );
  validateUiSpecLate(
    'composer.completer',
    { id: 'cp2', label: 'L', trigger: '#', source: { kind: 'doc', name: 'items', itemsField: 'rows' } },
    'cp2',
    makeCtx('composer.completer'),
  );
  expectThrow(
    () => validateUiSpecLate('composer.completer', { id: 'cp1', label: 'L', trigger: '/' }, 'cp1', makeCtx('composer.completer')),
    'invalid_ui_spec',
    "trigger only allows '@' | '#' | ':'",
  );
  expectThrow(
    () =>
      validateUiSpecLate(
        'composer.completer',
        { id: 'cp1', label: 'L', trigger: '@', client: { module: 'a.tsx', export: 'X' }, source: { kind: 'action', actionId: 'x' } },
        'cp1',
        makeCtx('composer.completer'),
      ),
    'invalid_ui_spec',
    'disallows declaring client',
  );
  expectThrow(
    () =>
      validateUiSpecLate(
        'composer.completer',
        { id: 'cp1', label: 'L', trigger: '@', source: { kind: 'doc', name: 'items', itemsField: '__proto__' } },
        'cp1',
        makeCtx('composer.completer'),
      ),
    'invalid_ui_spec',
    'safe top-level key',
  );
});

test('workbench.panel: valid badge shape passes; unknown badge keys reject', { timeout: 60_000 }, () => {
  validateUiSpecLate(
    'workbench.panel',
    { id: 'w1', badge: { doc: 'stats', countField: 'count', toneField: 'tone' } },
    'w1',
    makeCtx('workbench.panel'),
  );
  expectThrow(
    () => validateUiSpecLate('workbench.panel', { id: 'w1', badge: { doc: 'stats', unknown: 1 } }, 'w1', makeCtx('workbench.panel')),
    'invalid_ui_spec',
    'badge only allows',
  );
});
