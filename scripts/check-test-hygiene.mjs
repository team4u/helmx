#!/usr/bin/env node
/**
 * pnpm check:hygiene — static test hygiene checks (TypeScript Compiler API, zero new deps).
 *
 * Rules are documented in the scripts/lib/test-hygiene.mjs header comment:
 *   timeout-missing / skip-without-reason / suite-timeout-env（AGENTS §5）。
 * Newly added t.test calls and cross-package test helper imports receive additional AST checks
 * in --changed/--files mode; existing code remains visible to the historical rules without
 * forcing a broad test rewrite.
 * Existing violations get no baseline exemption — every one is reported faithfully and the
 * run fails with exit code 1; each fixed is one fewer.
 *
 * Usage (pnpm needs the -- separator; this script accepts and skips a leading literal --
 * that pnpm passes through verbatim):
 *   pnpm check:hygiene                       # every *.test.ts / *.test.tsx under all packages' test dirs
 *   pnpm check:hygiene -- --changed          # only test files inside the change set (baseline rules as check-changed)
 *   pnpm check:hygiene -- --changed --base main
 *   pnpm check:hygiene -- --files <path...>  # explicit file list (must live inside this repo; outside paths rejected)
 *
 * Exit codes: 0 clean; 1 violations found; 2 usage/baseline error. No HELMX_* env vars are
 * injected.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectChangedFiles, GitChangeError, resolveBaseline } from './lib/git-changes.mjs';
import { analyzeTestSource, collectAllTestFiles, isTestFilePath } from './lib/test-hygiene.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Return added source line numbers from a zero-context git diff. The hygiene gate keeps
 * existing violations visible, while the stricter subtest/helper rules apply only to newly
 * introduced code so a focused test-infrastructure change does not require rewriting history.
 */
function collectAddedLines({ base, files }) {
  const selected = new Set(files);
  const lineSets = new Map();
  const addDiff = (args) => {
    const result = spawnSync('git', ['diff', '--unified=0', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) return;
    let current = null;
    let nextLine = 0;
    for (const line of (result.stdout ?? '').split(/\r?\n/)) {
      if (line.startsWith('+++ b/')) {
        current = line.slice('+++ b/'.length);
        nextLine = 0;
        continue;
      }
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        nextLine = Number(hunk[1]);
        continue;
      }
      if (current === null || nextLine === 0) continue;
      if (line.startsWith('+') && !line.startsWith('+++')) {
        if (!selected.has(current)) continue;
        let lines = lineSets.get(current);
        if (!lines) lineSets.set(current, (lines = new Set()));
        lines.add(nextLine);
        nextLine += 1;
      } else if (!line.startsWith('-') && !line.startsWith('\\')) {
        nextLine += 1;
      }
    }
  };

  if (base) {
    addDiff([base, 'HEAD']);
  } else {
    try {
      const baseline = resolveBaseline({ cwd: repoRoot });
      if (baseline.mergeBase) addDiff([baseline.mergeBase, 'HEAD']);
    } catch {
      // Explicit --files is also used by check:changed. Without a usable baseline, inspect
      // the worktree diff and untracked files rather than failing a source-only hygiene pass.
    }
  }
  addDiff(['HEAD']);

  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (untracked.status === 0) {
    for (const rel of (untracked.stdout ?? '').split('\0').filter(Boolean)) {
      if (!selected.has(rel)) continue;
      const abs = path.join(repoRoot, rel);
      try {
        const lines = new Set(readFileSync(abs, 'utf8').split(/\r?\n/).map((_, index) => index + 1));
        lineSets.set(rel, lines);
      } catch {
        // The caller reports unreadable files through the normal source-read path.
      }
    }
  }
  return lineSets;
}

function packageOfTestPath(rel) {
  const match = /^packages\/([^/]+)\/test(?:\/|$)/.exec(rel);
  return match?.[1] ?? null;
}

function isCrossPackageTestHelperImport(rel, specifier) {
  if (!specifier.startsWith('.')) return false;
  const fromPackage = packageOfTestPath(rel);
  if (!fromPackage) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), specifier));
  const match = /^packages\/([^/]+)\/test\/helpers(?:\/|\.|$)/.exec(resolved);
  return match !== null && match[1] !== fromPackage;
}

function collectNodeTestBindings(ts, sourceFile) {
  const testFunctions = new Set();
  const namespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== 'node:test') continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) testFunctions.add(clause.name.text);
    const named = clause.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (imported === 'test' || imported === 'it') testFunctions.add(element.name.text);
      }
    } else if (named && ts.isNamespaceImport(named)) {
      namespaces.add(named.name.text);
    }
  }
  return { testFunctions, namespaces };
}

function isNodeTestCall(ts, expression, bindings) {
  if (ts.isIdentifier(expression)) return bindings.testFunctions.has(expression.text);
  if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.expression)) return false;
  return bindings.namespaces.has(expression.expression.text) && (expression.name.text === 'test' || expression.name.text === 'it');
}

function isSubtestCall(ts, expression, contextNames) {
  return ts.isPropertyAccessExpression(expression) && expression.name.text === 'test' &&
    ts.isIdentifier(expression.expression) && contextNames.has(expression.expression.text);
}

function hasExplicitTimeout(ts, call) {
  const options = call.arguments[1];
  if (!options || ts.isFunctionLike(options)) return false;
  const unwrapped = options.kind === ts.SyntaxKind.AsExpression || options.kind === ts.SyntaxKind.SatisfiesExpression
    ? options.expression
    : options;
  if (ts.isIdentifier(unwrapped)) return true;
  if (!ts.isObjectLiteralExpression(unwrapped)) return false;
  return unwrapped.properties.some((property) => {
    if (ts.isPropertyAssignment(property)) {
      const name = property.name;
      return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'timeout';
    }
    return ts.isShorthandPropertyAssignment(property) && property.name.text === 'timeout';
  });
}

/** Find newly added t.test calls without an explicit options.timeout. */
function analyzeAddedSubtests(ts, filePath, source, addedLines) {
  if (!addedLines || addedLines.size === 0) return [];
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const bindings = collectNodeTestBindings(ts, sourceFile);
  const violations = [];
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const callbackOf = (call) => {
    for (let index = call.arguments.length - 1; index >= 0; index -= 1) {
      const candidate = call.arguments[index];
      if (candidate && ts.isFunctionLike(candidate)) return candidate;
    }
    return null;
  };
  const visit = (node, contextNames) => {
    if (ts.isCallExpression(node)) {
      if (isSubtestCall(ts, node.expression, contextNames)) {
        const line = lineOf(node);
        if (addedLines.has(line) && !hasExplicitTimeout(ts, node)) {
          violations.push({
            file: filePath,
            line,
            rule: 'subtest-timeout-missing',
            message: 't.test(...) must declare an explicit { timeout: ... } option; parent/default timeouts are not a substitute',
          });
        }
        const callback = callbackOf(node);
        if (callback) {
          const nestedNames = new Set(contextNames);
          const contextParameter = callback.parameters[0];
          if (contextParameter && ts.isIdentifier(contextParameter.name)) nestedNames.add(contextParameter.name.text);
          callback.body.forEachChild((child) => visit(child, nestedNames));
        }
        return;
      }
      if (isNodeTestCall(ts, node.expression, bindings)) {
        const callback = callbackOf(node);
        if (callback) {
          const nestedNames = new Set(contextNames);
          const contextParameter = callback.parameters[0];
          if (contextParameter && ts.isIdentifier(contextParameter.name)) nestedNames.add(contextParameter.name.text);
          callback.body.forEachChild((child) => visit(child, nestedNames));
        }
        return;
      }
    }
    node.forEachChild((child) => visit(child, contextNames));
  };
  sourceFile.forEachChild((child) => visit(child, new Set()));
  return violations;
}

/** Find newly added relative imports that reach another package's test/helpers directory. */
function analyzeAddedTestHelperImports(ts, filePath, source, addedLines) {
  if (!addedLines || addedLines.size === 0) return [];
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const violations = [];
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const inspect = (specifierNode) => {
    if (!ts.isStringLiteral(specifierNode) || !isCrossPackageTestHelperImport(filePath, specifierNode.text)) return;
    const line = lineOf(specifierNode);
    if (addedLines.has(line)) {
      violations.push({
        file: filePath,
        line,
        rule: 'cross-package-test-helper',
        message: `relative test helper import crosses package boundary: ${specifierNode.text}; move reusable helpers to @helmx/test-kit or keep package-specific fixtures local`,
      });
    }
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) inspect(node.moduleSpecifier);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) inspect(node.moduleSpecifier);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) inspect(node.argument.literal);
    else if (ts.isCallExpression(node) && node.arguments[0] &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      inspect(node.arguments[0]);
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return violations;
}

function usage() {
  console.error(`Usage: node scripts/check-test-hygiene.mjs [--changed [--base <ref>]] [--files <path...>]
  (default)      check every test file in the repo
  --changed      check only test files inside the change set (committed ∪ worktree ∪ untracked)
  --base <ref>   only with --changed; baseline semantics identical to check-changed
  --files p...   explicit file list to check (must live inside this repo, relative or absolute; outside paths rejected)
Note: when invoked through pnpm, arguments must be separated with -- (e.g. pnpm check:hygiene -- --files x.test.ts);
      a leading literal -- is ignored by this script; a direct node scripts/check-test-hygiene.mjs call needs no --.`);
}

const argv = process.argv.slice(2);
const opts = { changed: false, base: null, files: [] };
let filesRequested = false;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  // The leading -- separator passed through by pnpm: only skipped in the first position;
  // a -- anywhere else is reported as an unknown argument.
  if (a === '--' && i === 0) continue;
  if (a === '--changed') opts.changed = true;
  else if (a === '--base' && argv[i + 1]) {
    opts.base = argv[i + 1];
    i += 1;
  } else if (a.startsWith('--base=')) opts.base = a.slice('--base='.length);
  else if (a === '--files') {
    filesRequested = true;
    for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j += 1) {
      opts.files.push(argv[j]);
      i = j;
    }
  } else {
    console.error(`[check-hygiene] Unknown argument: ${a}`);
    usage();
    process.exit(2);
  }
}
if (filesRequested && opts.files.length === 0) {
  console.error('[check-hygiene] --files requires at least one in-repository test path (refusing to scan the whole repository)');
  usage();
  process.exit(2);
}
if (opts.base && !opts.changed) {
  console.error('[check-hygiene] --base may only be combined with --changed');
  usage();
  process.exit(2);
}

// Scope resolution: whole repo / change set / explicit file list (out-of-repo paths are
// rejected; never silently check some other repository).
let scopeLabel;
let files;
if (opts.files.length > 0) {
  files = opts.files.map((f) => {
    const abs = path.resolve(process.cwd(), f);
    const rel = path.relative(repoRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      console.error(
        `[check-hygiene] Rejected path outside repository: ${f} (only tests in this repository are inspected; resolved to ${abs})`,
      );
      process.exit(2);
    }
    return rel;
  });
  scopeLabel = `explicit ${files.length} file(s)`;
} else if (opts.changed) {
  let changes;
  try {
    changes = collectChangedFiles({ base: opts.base, cwd: repoRoot });
  } catch (err) {
    if (err instanceof GitChangeError) {
      console.error(`[check-hygiene] ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  files = changes.files.map((f) => f.path).filter((p) => isTestFilePath(p) && existsSync(path.join(repoRoot, p)));
  scopeLabel = `change set, ${files.length} test file(s) (baseline ${changes.baseline.ref})`;
} else {
  files = collectAllTestFiles(repoRoot);
  scopeLabel = `whole repo, ${files.length} test file(s)`;
}

console.error(`[check-hygiene] scope: ${scopeLabel}`);

// typescript comes from the repo root devDependency; createRequire anchors resolution there.
const requireFromRoot = createRequire(path.join(repoRoot, 'package.json'));
const ts = requireFromRoot('typescript');

const shouldCheckNewRules = opts.changed || opts.files.length > 0;
const addedLines = shouldCheckNewRules ? collectAddedLines({ base: opts.base, files }) : new Map();
const allViolations = [];
const totals = { testCalls: 0, skipCalls: 0, todoCalls: 0, subtestCalls: 0, helperImports: 0 };
for (const rel of files) {
  const abs = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
  let source;
  try {
    source = readFileSync(abs, 'utf8');
  } catch (err) {
    console.error(`[check-hygiene] cannot read ${rel}: ${err.message}`);
    process.exit(2);
  }
  const report = analyzeTestSource(ts, rel, source);
  const changedLines = addedLines.get(rel);
  const extraViolations = [
    ...analyzeAddedSubtests(ts, rel, source, changedLines),
    ...analyzeAddedTestHelperImports(ts, rel, source, changedLines),
  ];
  allViolations.push(...report.violations, ...extraViolations);
  totals.testCalls += report.stats.testCalls;
  totals.skipCalls += report.stats.skipCalls;
  totals.todoCalls += report.stats.todoCalls;
  totals.subtestCalls += report.stats.subtestCalls;
  totals.helperImports += extraViolations.filter((v) => v.rule === 'cross-package-test-helper').length;
}

allViolations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
for (const v of allViolations) {
  console.error(`[check-hygiene] ${v.file}:${v.line} [${v.rule}] ${v.message}`);
}

const byRule = {};
for (const v of allViolations) byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
const ruleSummary = Object.entries(byRule)
  .map(([r, n]) => `${r} ${n}`)
  .join(' / ');
console.error(
  `[check-hygiene] stats: test/it ${totals.testCalls} (skip ${totals.skipCalls}, todo ${totals.todoCalls});` +
    ` t.test subtests: ${totals.subtestCalls}; cross-package test helper imports: ${totals.helperImports}`,
);
if (allViolations.length > 0) {
  console.error(`[check-hygiene] ${allViolations.length} violation(s) (${ruleSummary}), exiting 1`);
  process.exit(1);
}
console.error('[check-hygiene] clean, exiting 0');
process.exit(0);
