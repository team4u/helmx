/**
 * External plugin doctor UI/CSS hygiene gate tests (Option A: runs inside the existing `'client'` check,
 * keeping `checks.map(c => c.id)` equal to `['manifest', 'backend', 'register', 'client']` and failing
 * with structured error code `plugin_client_ui_hygiene_failed` plus exact `file:line:rule` details).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { createPluginBuildProvider } from '@helmx/plugin-build';
import { cleanupDir, makeTempDir } from '@helmx/test-kit/node';
import { analyzeUiSource, collectSourceUiFiles } from '../../../scripts/lib/ui-hygiene.mjs';
import { doctorPluginDir } from '../src/plugins/plugin-doctor.js';
import { scanPluginCssUiHygiene, scanPluginTsxUiHygiene } from '../src/plugins/plugin-ui-hygiene.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface UiHygieneDetails {
  pluginId: string;
  violations: Array<{
    file: string;
    line: number;
    rule: string;
    message: string;
    location: string;
  }>;
}

function writeExternalClientPlugin(
  baseDir: string,
  id: string,
  files: { tsx: string; css?: string; extraFiles?: Record<string, string> },
): string {
  const dir = join(baseDir, id);
  mkdirSync(join(dir, 'client'), { recursive: true });
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({ id, name: `${id} Plugin`, version: '0.1.0', main: 'index.ts', clientRoot: './client' }, null, 2),
  );
  writeFileSync(
    join(dir, 'index.ts'),
    `export default {
  id: '${id}',
  name: '${id} Plugin',
  version: '0.1.0',
  clientRoot: './client',
  definePlugin(ctx: { ui: { screen: (spec: unknown) => void } }) {
    ctx.ui.screen({ id: 'main', label: 'Main', client: { module: 'index.tsx', export: 'MainScreen' } });
  },
};\n`,
  );
  writeFileSync(join(dir, 'client', 'index.tsx'), files.tsx);
  if (files.css !== undefined) {
    writeFileSync(join(dir, 'client', 'styles.css'), files.css);
  }
  for (const [rel, content] of Object.entries(files.extraFiles ?? {})) {
    const abs = join(dir, 'client', rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

test('doctorPluginDir: clean external plugin (SDK primitives, gated :hover, comments with Emoji, hyphenated classes, typography) passes 4-stage check', { timeout: 60_000 }, async (t) => {
  const baseDir = await makeTempDir('helmx-doctor-ui-clean-');
  t.after(() => cleanupDir(baseDir), { timeout: 60_000 });
  const buildProvider = createPluginBuildProvider();

  const pluginDir = writeExternalClientPlugin(baseDir, 'ext-ui-clean', {
    tsx: `// Comment with Emoji 🚀 and <select> and type="search" must not fail doctor
/* Block comment 🎉 <button className="btn"> */
import { Button, CopyButton, List, ListRow, Screen, ScreenToolbar, SearchBox, Select } from '@helmx/ui'
import './styles.css'

export function MainScreen() {
  const label = '127.0.0.1:3000 → 127.0.0.1:8080 • ⌘K — ✓ ✕ ×'
  return (
    <Screen
      title="Clean App"
      actions={<Button variant="primary" size="sm">Create</Button>}
      toolbar={
        <ScreenToolbar actions={<SearchBox variant="toolbar" size="sm" value="" onChange={() => {}} />}>
          <Select value="a" options={[{ value: 'a', label: 'A' }]} onChange={() => {}} />
        </ScreenToolbar>
      }
    >
      {/* JSX comment 🔥 <select> */}
      <p>Don't break on apostrophes or https://example.com URLs</p>
      <div className={label === 'input' ? 'domain-row' : 'other-row'}>
        <CopyButton className="btn btn-ghost btn-sm" text={label} />
        <button type="button" className="my-domain-slot-btn">Domain</button>
        <input
          // Never type="search"
          type={label === 'search' ? 'text' : 'password'}
          className="domain-search-input"
        />
      </div>
      <List label="Items">
        <ListRow title={label} interactive={false} />
      </List>
    </Screen>
  )
}
`,
    css: `/* Comment mentioning :hover is allowed */
.domain-row { padding: 8px; }
@media (hover: hover) {
  .domain-row:hover { background: var(--bg-subtle); }
}
@media (hover: none) {
  .domain-row:hover { background: transparent; }
}
`,
  });

  const report = await doctorPluginDir(pluginDir, { buildProvider });
  assert.equal(report.ok, true, `expected clean plugin to pass doctor: ${JSON.stringify(report.checks)}`);
  assert.deepEqual(
    report.checks.map((c) => c.id),
    ['manifest', 'backend', 'register', 'client'],
  );
  assert.deepEqual(report.screens, ['main']);
});

test('doctorPluginDir: each UI/CSS hygiene violation fails the client check with plugin_client_ui_hygiene_failed and exact file:line:rule details', { timeout: 60_000 }, async (t) => {
  const baseDir = await makeTempDir('helmx-doctor-ui-fail-');
  t.after(() => cleanupDir(baseDir), { timeout: 60_000 });
  const buildProvider = createPluginBuildProvider();

  const cases: ReadonlyArray<{
    id: string;
    tsx: string;
    css?: string;
    expectedLocation: string;
    expectedRule: string;
  }> = [
    {
      id: 'ext-bad-select',
      tsx: `export function MainScreen() {
  return (
    <select value="a" onChange={() => {}}>
      <option value="a">A</option>
    </select>
  )
}
`,
      expectedLocation: 'client/index.tsx:3:no-native-select',
      expectedRule: 'no-native-select',
    },
    {
      id: 'ext-bad-search',
      tsx: `export function MainScreen() {
  return (
    <div>
      <input type="search" placeholder="Find" />
    </div>
  )
}
`,
      expectedLocation: 'client/index.tsx:4:no-search-input',
      expectedRule: 'no-search-input',
    },
    {
      id: 'ext-bad-search-expr',
      tsx: `export function MainScreen() {
  return (
    <div>
      <input type={'search'} />
    </div>
  )
}
`,
      expectedLocation: 'client/index.tsx:4:no-search-input',
      expectedRule: 'no-search-input',
    },
    {
      id: 'ext-bad-emoji-jsx',
      tsx: `export function MainScreen() {
  return (
    <div>
      <span>Deploy 🚀 now</span>
    </div>
  )
}
`,
      expectedLocation: 'client/index.tsx:4:no-ui-emoji',
      expectedRule: 'no-ui-emoji',
    },
    {
      id: 'ext-bad-emoji-string',
      tsx: `export function MainScreen() {
  const title = 'Status ✅ ok'
  return <div>{title}</div>
}
`,
      expectedLocation: 'client/index.tsx:2:no-ui-emoji',
      expectedRule: 'no-ui-emoji',
    },
    {
      id: 'ext-bad-raw-btn',
      tsx: `export function MainScreen() {
  return (
    <button type="button" className="btn btn-primary btn-sm">
      Save
    </button>
  )
}
`,
      expectedLocation: 'client/index.tsx:3:no-raw-control-class',
      expectedRule: 'no-raw-control-class',
    },
    {
      id: 'ext-bad-raw-input',
      tsx: `export function MainScreen() {
  return (
    <input type="text" className="input input-sm" />
  )
}
`,
      expectedLocation: 'client/index.tsx:3:no-raw-control-class',
      expectedRule: 'no-raw-control-class',
    },
    {
      id: 'ext-bad-legacy-modal',
      tsx: `export function MainScreen() {
  return (
    <div className="modal-header custom-header">
      <span>Title</span>
    </div>
  )
}
`,
      expectedLocation: 'client/index.tsx:3:no-raw-control-class',
      expectedRule: 'no-raw-control-class',
    },
    {
      id: 'ext-bad-legacy-card-kbd',
      tsx: `export function MainScreen() {
  return (
    <div className="section-flat">
      <div className="card">
        <kbd className="kbd-hint">Esc</kbd>
      </div>
    </div>
  )
}
`,
      expectedLocation: 'client/index.tsx:3:no-raw-control-class',
      expectedRule: 'no-raw-control-class',
    },
    {
      id: 'ext-bad-css-hover',
      tsx: `import './styles.css'
export function MainScreen() {
  return <div className="row">Row</div>
}
`,
      css: `.row { color: inherit; }
.row:hover {
  color: var(--accent);
}
`,
      expectedLocation: 'client/styles.css:2:hover-media-gate',
      expectedRule: 'hover-media-gate',
    },
  ];

  for (const tc of cases) {
    const dir = writeExternalClientPlugin(baseDir, tc.id, { tsx: tc.tsx, css: tc.css });
    const report = await doctorPluginDir(dir, { buildProvider });
    assert.equal(report.ok, false, `${tc.id} must fail doctor`);
    assert.deepEqual(
      report.checks.map((c) => c.id),
      ['manifest', 'backend', 'register', 'client'],
      `${tc.id} must keep 4-stage check IDs`,
    );
    const clientCheck = report.checks.find((c) => c.id === 'client');
    assert.ok(clientCheck?.error, `${tc.id} must fail inside client check`);
    assert.equal(clientCheck.error.code, 'plugin_client_ui_hygiene_failed', `${tc.id} error code`);
    assert.ok(
      clientCheck.error.message.includes(tc.expectedLocation),
      `${tc.id} error message should include ${tc.expectedLocation}, got: ${clientCheck.error.message}`,
    );
    const details = clientCheck.error.details as UiHygieneDetails | undefined;
    assert.ok(details && Array.isArray(details.violations), `${tc.id} should attach structured violations`);
    assert.ok(
      details.violations.some((v) => v.location === tc.expectedLocation && v.rule === tc.expectedRule),
      `${tc.id} details missing ${tc.expectedLocation}: ${JSON.stringify(details.violations)}`,
    );
  }
});

test('plugin-ui-hygiene scanners: handle nested JSX props, JSX text apostrophes/URLs, template classes, and CSS OR/not media lists accurately', { timeout: 60_000 }, () => {
  const tsxViolations = scanPluginTsxUiHygiene(
    'client/nested.tsx',
    `import { Screen } from '@helmx/ui'
export function Nested({ active, prefix, variant }: { active: boolean; prefix: string; variant: string }) {
  return (
    <Screen
      title="Clean"
      actions={<button type="button" className={\`btn-\${variant}\`}>Go</button>}
    >
      <p>Don't trip on https://example.com — then catch 🔥</p>
      <button type="button" className={\`\${prefix}-btn\`}>Allowed prefix</button>
      <a href="#x" className={active ? 'btn-inline' : 'link'}>Inline</a>
    </Screen>
  )
}
`,
  );

  assert.deepEqual(
    tsxViolations.map((v) => ({ line: v.line, rule: v.rule })),
    [
      { line: 6, rule: 'no-raw-control-class' },
      { line: 8, rule: 'no-ui-emoji' },
      { line: 10, rule: 'no-raw-control-class' },
    ],
  );

  const cssViolations = scanPluginCssUiHygiene(
    'client/styles.css',
    `@media (max-width: 680px), (hover: hover) {
  .or-bad:hover { color: red; }
}
@media not all and (hover: hover) {
  .not-bad:hover { color: red; }
}
@media (hover: hover) and (pointer: fine), (hover: hover) and (min-width: 1200px) {
  .ok:hover { color: green; }
}
`,
  );
  assert.deepEqual(
    cssViolations.map((v) => ({ line: v.line, rule: v.rule })),
    [
      { line: 2, rule: 'hover-media-gate' },
      { line: 5, rule: 'hover-media-gate' },
    ],
  );
});

test('plugin-ui-hygiene TSX scanner matches AST ui-hygiene.mjs across legacy container/modal/tab/kbd edge cases and all repo UI files', { timeout: 60_000 }, () => {
  const edgeCorpus = `import { Card, Kbd, Tabs, TabsList, TabsTrigger } from '@helmx/ui'
export function EdgeCorpus({ active, variant, suffix }: { active: boolean; variant: string; suffix: string }) {
  return (
    <div className="section-flat">
      <div className="form-grid" />
      <div className="kv-list trace-kv" />
      <div className="tabs-bar">
        <button type="button" className={\`tab-btn\${active ? ' tab-btn-active' : ''}\`}>Tab</button>
      </div>
      <div className="modal-header custom-header" />
      <div className="modal-footer" />
      <div className="dropdown-panel" />
      <kbd className="kbd-hint">Esc</kbd>
      <div className="card" />
      <div className={\`card\${active ? ' is-selected' : ''}\`} />
      <div className={\`\${active ? 'card ' : ''}extra\`} />
      <div className="overview-card plan-draft-card form-grid-value section-flat-title mermaid-modal-header popover-kbd-hint" />
      <div className={\`overview-\${active ? 'card' : 'row'}\`} />
      <div className={\`\${active ? 'card' : 'row'}-item\`} />
      <div className={\`card-\${variant}\`} />
      <div className={\`card\${suffix}\`} />
      <Card className="card">SDK</Card>
      <Tabs value="a" variant="underline">
        <TabsList className="tabs-bar">
          <TabsTrigger value="a" className="tab-btn">Ok</TabsTrigger>
        </TabsList>
      </Tabs>
      <Kbd className="kbd-hint">K</Kbd>
    </div>
  )
}
`;

  const zeroDepEdge = scanPluginTsxUiHygiene('client/edge.tsx', edgeCorpus);
  const astEdge = analyzeUiSource(ts, 'client/edge.tsx', edgeCorpus).violations;
  assert.deepEqual(zeroDepEdge, astEdge, 'zero-dep scanner must match AST scanner exactly on legacy edge corpus');
  assert.equal(zeroDepEdge.length, 12, `expected 12 intrinsic legacy violations, got ${zeroDepEdge.length}`);

  const repoFiles = collectSourceUiFiles(repoRoot);
  assert.ok(repoFiles.length > 0, 'expected repo UI files for cross-validation');
  const mismatches: string[] = [];
  for (const rel of repoFiles) {
    const source = readFileSync(join(repoRoot, rel), 'utf8');
    const astViolations = analyzeUiSource(ts, rel, source).violations;
    const zeroDepViolations = scanPluginTsxUiHygiene(rel, source);
    if (JSON.stringify(zeroDepViolations) !== JSON.stringify(astViolations)) {
      mismatches.push(`${rel}\n  AST: ${JSON.stringify(astViolations)}\n  ZeroDep: ${JSON.stringify(zeroDepViolations)}`);
    }
  }
  assert.deepEqual(mismatches, [], `zero-dep scanner drifted from AST scanner:\n${mismatches.join('\n')}`);
});
