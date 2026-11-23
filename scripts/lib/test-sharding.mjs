/**
 * Static 4-pool classification, mtime/size+helper AST caching, and concurrent LPT shard
 * planning for test files (TypeScript Compiler API, zero external deps).
 *
 * Pools:
 * - `pure`: strictly pure in-memory tests (zero DOM, zero fs writes, zero network/sqlite/
 *   subprocess/global mutation). Runs in persistent `--test-isolation=none` workers.
 * - `dom-shared`: happy-dom / React DOM / client-compile tests without process-global
 *   mutations, `GlobalRegistrator.unregister`, `mock.timers`/`mock.method`, or backend
 *   subprocess/SQLite/KernelRuntime/createHelmx usage. Runs in persistent workers with
 *   `dom-shard-preload.mjs` + inter-file DOM reset.
 * - `node-shared`: Node tests using isolated temp dirs, SQLite, ephemeral HTTP/net,
 *   `KernelRuntime`, `createHelmx`, or `@helmx/plugin-build` without process-global
 *   mutations (`process.env`, `process.chdir`, `process.argv`, `process.exit`, non-0
 *   `process.kill`, `process.stdin/stdout/stderr`, unpaired `process.on`, `globalThis`
 *   writes, `mock.timers`/`mock.method`, `worker_threads`/`cluster`). Runs in persistent
 *   `--test-isolation=none` workers (each file gets its own fresh `node:test` root suite).
 * - `isolated`: remaining files (or files containing `// @test-isolation: process`) that
 *   genuinely require `--test-isolation=process`.
 *
 * When pass-through args explicitly set semantics-sensitive switches like
 * `--test-isolation` / `--test-reporter` / `--test-name-pattern` / `--test-concurrency`,
 * everything falls back to a single regular runner invocation.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const TEST_POOL_CACHE_SCHEMA_VERSION = 1;
export const DEFAULT_PURITY_CACHE_REL = path.join('node_modules', '.cache', 'helmx-test-purity-cache.json');

const ISOLATION_PROCESS_PRAGMA_RE = /@test-isolation\s*:\s*process\b/;

/**
 * Match `@test-isolation: process` only inside leading comments at the top of a test file
 * (before the first non-comment statement), so fixture strings inside tests like
 * `build-runner.test.ts` never self-classify as isolated.
 */
function hasLeadingIsolationProcessPragma(source) {
  let idx = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (source.startsWith('#!', idx)) {
    const nl = source.indexOf('\n', idx);
    if (nl === -1) return false;
    idx = nl + 1;
  }
  while (idx < source.length) {
    while (idx < source.length && /\s/.test(source[idx])) idx += 1;
    if (source.startsWith('//', idx)) {
      const nl = source.indexOf('\n', idx + 2);
      const comment = nl === -1 ? source.slice(idx + 2) : source.slice(idx + 2, nl);
      if (ISOLATION_PROCESS_PRAGMA_RE.test(comment)) return true;
      if (nl === -1) return false;
      idx = nl + 1;
      continue;
    }
    if (source.startsWith('/*', idx)) {
      const end = source.indexOf('*/', idx + 2);
      const comment = end === -1 ? source.slice(idx + 2) : source.slice(idx + 2, end);
      if (ISOLATION_PROCESS_PRAGMA_RE.test(comment)) return true;
      if (end === -1) return false;
      idx = end + 2;
      continue;
    }
    break;
  }
  return false;
}

const WORKER_MODULE_PREFIXES = [
  'node:worker_threads',
  'worker_threads',
  'node:cluster',
  'cluster',
];

const DOM_MODULE_PREFIXES = [
  '@happy-dom',
  'happy-dom',
  'react-dom/client',
];

const NODE_BACKEND_MODULE_PREFIXES = [
  'node:child_process',
  'child_process',
  'node:sqlite',
  'sqlite',
  'node:http',
  'http',
  'node:https',
  'https',
  'node:http2',
  'http2',
  'node:net',
  'net',
  'node:dgram',
  'dgram',
  'node:tls',
  'tls',
];

const PLUGIN_BUILD_MODULE_PREFIX = '@helmx/plugin-build';

const FS_WRITE_IMPORTS = new Set([
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'mkdtemp',
  'mkdtempSync',
  'mkdir',
  'mkdirSync',
  'rm',
  'rmSync',
  'unlink',
  'unlinkSync',
  'rmdir',
  'rmdirSync',
  'rename',
  'renameSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'chmod',
  'chmodSync',
  'chown',
  'chownSync',
  'truncate',
  'truncateSync',
  'createWriteStream',
  'open',
  'openSync',
]);

// Method names on non-fs receivers that collide with ordinary domain APIs (`modal.open()`).
const FS_NAMESPACE_ONLY_METHODS = new Set(['open']);

const SUBPROCESS_CALL_NAMES = new Set([
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
]);

const NODE_BACKEND_CALLS = new Set([
  'createServer',
  'listen',
  'KernelRuntime',
  'createHelmx',
  'DatabaseSync',
  'runWorkflow',
]);

const NODE_BACKEND_CONSTRUCTORS = new Set(['KernelRuntime', 'DatabaseSync']);

const PROCESS_STRICT_PROPS = new Set([
  'stdin',
  'chdir',
  'exit',
  'stdout',
  'stderr',
]);

const MUTATED_GLOBAL_IDENTIFIERS = new Set([
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'setImmediate',
  'console',
]);

const DESTRUCTIVE_DOM_GLOBAL_PROPS = new Set(['window', 'document', 'navigator']);

const DOM_SAFE_GLOBAL_PROPS = new Set([
  'React',
  'IS_REACT_ACT_ENVIRONMENT',
  'ResizeObserver',
]);

function isDomSafeGlobalProp(name) {
  return typeof name === 'string' && (DOM_SAFE_GLOBAL_PROPS.has(name) || name.startsWith('__helmx_shared_'));
}

/** Unwrap parentheses, type assertions, satisfies, and non-null assertions. */
function unwrapExpr(ts, node) {
  let cur = node;
  while (
    cur &&
    (ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isNonNullExpression(cur))
  ) {
    cur = cur.expression;
  }
  return cur;
}

function matchesModulePrefix(specifier, prefixes) {
  return prefixes.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`));
}

function isFsModule(specifier) {
  return (
    specifier === 'node:fs' ||
    specifier === 'fs' ||
    specifier === 'node:fs/promises' ||
    specifier === 'fs/promises'
  );
}

function isChildProcessModule(specifier) {
  return specifier === 'node:child_process' || specifier === 'child_process';
}

function isPluginBuildModule(specifier) {
  return specifier === PLUGIN_BUILD_MODULE_PREFIX || specifier.startsWith(`${PLUGIN_BUILD_MODULE_PREFIX}/`);
}

function isAssignmentExpr(ts, node) {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

function isProcessPropExpr(ts, node, propName) {
  const cur = unwrapExpr(ts, node);
  if (!cur || !ts.isPropertyAccessExpression(cur) || cur.name.text !== propName) return false;
  const host = unwrapExpr(ts, cur.expression);
  return Boolean(host && ts.isIdentifier(host) && host.text === 'process');
}

function isProcessEnvMemberExpr(ts, node) {
  const cur = unwrapExpr(ts, node);
  if (!cur) return false;
  if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
    return isProcessPropExpr(ts, cur.expression, 'env');
  }
  return false;
}

function isDomSafeGlobalObjectLiteral(ts, node) {
  const expr = unwrapExpr(ts, node);
  if (!expr || !ts.isObjectLiteralExpression(expr) || expr.properties.length === 0) return false;
  return expr.properties.every((prop) => {
    if (ts.isShorthandPropertyAssignment(prop)) {
      return isDomSafeGlobalProp(prop.name.text);
    }
    if (ts.isPropertyAssignment(prop)) {
      if (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) {
        return isDomSafeGlobalProp(prop.name.text);
      }
      if (ts.isComputedPropertyName(prop.name)) {
        // e.g. [CLIENT_SHARED_GLOBALS['react']!]: React in plugin-namespace.ts
        const inner = unwrapExpr(ts, prop.name.expression);
        if (inner && ts.isElementAccessExpression(inner)) {
          const base = unwrapExpr(ts, inner.expression);
          if (base && ts.isIdentifier(base) && base.text === 'CLIENT_SHARED_GLOBALS') return true;
        }
      }
    }
    return false;
  });
}

function isClientSharedGlobalIndexExpr(ts, node) {
  const idx = unwrapExpr(ts, node);
  if (!idx || !ts.isElementAccessExpression(idx)) return false;
  const base = unwrapExpr(ts, idx.expression);
  return Boolean(base && ts.isIdentifier(base) && base.text === 'CLIENT_SHARED_GLOBALS');
}

/** Collect runtime imports, module namespaces, and local RegExp variable declarations. */
function collectFileBindings(ts, sourceFile) {
  const importedBindings = new Set();
  const fsNamespaces = new Set();
  const cpNamespaces = new Set();
  const cpExecBindings = new Set();
  let importsChildProcess = false;

  for (const st of sourceFile.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause || st.importClause.isTypeOnly) continue;
    const mod = ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : '';
    const isCp = isChildProcessModule(mod);
    const isFs = isFsModule(mod);
    if (isCp) importsChildProcess = true;

    const { name, namedBindings } = st.importClause;
    if (name) {
      importedBindings.add(name.text);
      if (isCp) cpNamespaces.add(name.text);
      if (isFs) fsNamespaces.add(name.text);
    }
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      importedBindings.add(namedBindings.name.text);
      if (isCp) cpNamespaces.add(namedBindings.name.text);
      if (isFs) fsNamespaces.add(namedBindings.name.text);
    } else if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const el of namedBindings.elements) {
        if (el.isTypeOnly) continue;
        importedBindings.add(el.name.text);
        const orig = (el.propertyName ?? el.name).text;
        if (isCp && SUBPROCESS_CALL_NAMES.has(orig)) {
          cpExecBindings.add(el.name.text);
        }
      }
    }
  }

  const regexBindings = new Set();
  let hasUnhandledRejectionOff = false;

  const scan = (node) => {
    if (ts.isTypeNode(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrapExpr(ts, node.initializer);
      if (
        init &&
        (ts.isRegularExpressionLiteral(init) ||
          (ts.isNewExpression(init) &&
            ts.isIdentifier(unwrapExpr(ts, init.expression)) &&
            unwrapExpr(ts, init.expression).text === 'RegExp'))
      ) {
        regexBindings.add(node.name.text);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpr(ts, node.expression);
      if (
        callee &&
        ts.isPropertyAccessExpression(callee) &&
        (callee.name.text === 'off' || callee.name.text === 'removeListener') &&
        node.arguments.length >= 1
      ) {
        const host = unwrapExpr(ts, callee.expression);
        const arg0 = unwrapExpr(ts, node.arguments[0]);
        if (
          host &&
          ts.isIdentifier(host) &&
          host.text === 'process' &&
          arg0 &&
          ts.isStringLiteralLike(arg0) &&
          arg0.text === 'unhandledRejection'
        ) {
          hasUnhandledRejectionOff = true;
        }
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(sourceFile);

  return {
    importedBindings,
    fsNamespaces,
    cpNamespaces,
    cpExecBindings,
    importsChildProcess,
    regexBindings,
    hasUnhandledRejectionOff,
  };
}

/** Resolve a same-repo test-directory relative helper module path from a test file path. */
export function resolveRelativeTestHelper(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const raw = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [raw];
  if (raw.endsWith('.js') || raw.endsWith('.jsx')) {
    const stem = raw.slice(0, raw.endsWith('.jsx') ? -4 : -3);
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  } else if (raw.endsWith('.mjs')) {
    candidates.push(`${raw.slice(0, -4)}.mts`);
  } else if (raw.endsWith('.cjs')) {
    candidates.push(`${raw.slice(0, -4)}.cts`);
  } else {
    candidates.push(
      `${raw}.ts`,
      `${raw}.tsx`,
      `${raw}.mts`,
      `${raw}.js`,
      `${raw}.mjs`,
      path.join(raw, 'index.ts'),
      path.join(raw, 'index.tsx'),
    );
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        // Only recurse into helper modules/fixtures inside the test directory; never cross into the src under test.
        const parts = candidate.split(path.sep);
        if (parts.includes('test')) return candidate;
      }
    } catch {
      // Ignore invalid paths
    }
  }
  return null;
}

/**
 * Derive the target worker pool from categorized static signals.
 * @param {{ strictIsolatedReasons: string[], domReasons: string[], nodeBackendReasons: string[], nodeFsReasons: string[], nodeGlobalReasons: string[] }} signals
 * @returns {'pure' | 'dom-shared' | 'node-shared' | 'isolated'}
 */
function resolvePoolFromSignals(signals) {
  if (signals.strictIsolatedReasons.length > 0) return 'isolated';
  if (signals.domReasons.length > 0) {
    // Files mixing DOM with backend subprocesses / SQLite / HTTP servers / KernelRuntime stay isolated.
    if (signals.nodeBackendReasons.length > 0) return 'isolated';
    return 'dom-shared';
  }
  if (signals.nodeGlobalReasons.length > 0) return 'isolated';
  if (signals.nodeBackendReasons.length > 0 || signals.nodeFsReasons.length > 0) return 'node-shared';
  return 'pure';
}

/**
 * Statically analyze one test source (plus optional relative helper resolution) into the
 * 4-pool taxonomy (`pure`, `dom-shared`, `node-shared`, `isolated`).
 *
 * @param {typeof import('typescript')} ts
 * @param {string} filePath
 * @param {string} source
 * @param {(fromFile: string, specifier: string) => { path: string, source: string } | null} [resolveHelper]
 * @param {Set<string>} [visited]
 * @returns {{ pure: boolean, pool: 'pure' | 'dom-shared' | 'node-shared' | 'isolated', reasons: string[], strictIsolatedReasons: string[], domReasons: string[], nodeBackendReasons: string[], nodeFsReasons: string[], nodeGlobalReasons: string[] }}
 */
export function analyzeTestSourcePurity(
  ts,
  filePath,
  source,
  resolveHelper = undefined,
  visited = new Set(),
) {
  if (visited.has(filePath)) {
    return {
      pure: true,
      pool: 'pure',
      reasons: [],
      strictIsolatedReasons: [],
      domReasons: [],
      nodeBackendReasons: [],
      nodeFsReasons: [],
      nodeGlobalReasons: [],
    };
  }
  visited.add(filePath);

  const strictIsolated = new Set();
  const dom = new Set();
  const nodeBackend = new Set();
  const nodeFs = new Set();
  const nodeGlobal = new Set();

  if (hasLeadingIsolationProcessPragma(source)) {
    strictIsolated.add('pragma:test-isolation:process');
  }

  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const bindings = collectFileBindings(ts, sourceFile);

  const visitHelper = (specifier) => {
    if (!resolveHelper || !specifier.startsWith('.')) return;
    const helper = resolveHelper(filePath, specifier);
    if (!helper) return;
    const sub = analyzeTestSourcePurity(ts, helper.path, helper.source, resolveHelper, visited);
    for (const r of sub.strictIsolatedReasons) strictIsolated.add(r);
    for (const r of sub.domReasons) dom.add(r);
    for (const r of sub.nodeBackendReasons) nodeBackend.add(r);
    for (const r of sub.nodeFsReasons) nodeFs.add(r);
    for (const r of sub.nodeGlobalReasons) nodeGlobal.add(r);
  };

  const checkMutatedTarget = (targetExpr, contextLabel, callNode) => {
    const target = unwrapExpr(ts, targetExpr);
    if (!target) return;
    if (ts.isIdentifier(target)) {
      if (target.text === 'document' || target.text === 'window' || target.text === 'GlobalRegistrator') {
        dom.add(`${contextLabel}:${target.text}`);
      } else if (MUTATED_GLOBAL_IDENTIFIERS.has(target.text)) {
        strictIsolated.add(`${contextLabel}:${target.text}`);
      } else if (target.text === 'globalThis') {
        if (contextLabel === 'Object.assign' && callNode.arguments.length >= 2 && isDomSafeGlobalObjectLiteral(ts, callNode.arguments[1])) {
          dom.add('Object.assign:globalThis:dom');
        } else if (contextLabel === 'Object.defineProperty' && callNode.arguments.length >= 2) {
          const keyArg = unwrapExpr(ts, callNode.arguments[1]);
          if (keyArg && ts.isStringLiteralLike(keyArg) && DESTRUCTIVE_DOM_GLOBAL_PROPS.has(keyArg.text)) {
            strictIsolated.add(`Object.defineProperty:globalThis.${keyArg.text}`);
          } else {
            nodeGlobal.add(`${contextLabel}:globalThis`);
          }
        } else {
          nodeGlobal.add(`${contextLabel}:globalThis`);
        }
      } else if (bindings.importedBindings.has(target.text)) {
        strictIsolated.add(`${contextLabel}:imported:${target.text}`);
      }
      return;
    }
    if (isProcessPropExpr(ts, target, 'env')) {
      strictIsolated.add(`${contextLabel}:process.env`);
    }
  };

  const visit = (node) => {
    if (ts.isTypeNode(node)) return;

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.isTypeOnly) return;
      const nb = clause?.namedBindings;
      const allNamedTypeOnly =
        !clause?.name &&
        nb &&
        ts.isNamedImports(nb) &&
        nb.elements.length > 0 &&
        nb.elements.every((el) => el.isTypeOnly);
      if (allNamedTypeOnly) return;

      const mod = node.moduleSpecifier.text;
      if (matchesModulePrefix(mod, WORKER_MODULE_PREFIXES)) {
        strictIsolated.add(`import:${mod}`);
      } else if (matchesModulePrefix(mod, DOM_MODULE_PREFIXES)) {
        dom.add(`import:${mod}`);
      } else if (matchesModulePrefix(mod, NODE_BACKEND_MODULE_PREFIXES)) {
        nodeBackend.add(`import:${mod}`);
      } else if (isPluginBuildModule(mod)) {
        nodeFs.add(`import:${mod}`);
      } else if (isFsModule(mod) && nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          if (el.isTypeOnly) continue;
          const importedName = (el.propertyName ?? el.name).text;
          if (FS_WRITE_IMPORTS.has(importedName)) {
            nodeFs.add(`import-fs:${importedName}`);
          }
        }
      }
      visitHelper(mod);
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const obj = unwrapExpr(ts, node.expression);
      const prop = ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
      if (obj && ts.isIdentifier(obj)) {
        if (obj.text === 'document' || obj.text === 'window') {
          dom.add(`global:${obj.text}${prop ? `.${prop}` : '[]'}`);
        } else if (obj.text === 'GlobalRegistrator') {
          if (prop === 'unregister') {
            strictIsolated.add('GlobalRegistrator.unregister');
          } else {
            dom.add(`global:GlobalRegistrator${prop ? `.${prop}` : '[]'}`);
          }
        } else if (obj.text === 'process' && prop && PROCESS_STRICT_PROPS.has(prop)) {
          strictIsolated.add(`process.${prop}`);
        }
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        (prop === 'timers' || prop === 'method') &&
        ts.isPropertyAccessExpression(obj) &&
        obj.name.text === 'mock'
      ) {
        strictIsolated.add(`mock.${prop}`);
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        (prop === 'timers' || prop === 'method') &&
        obj &&
        ts.isIdentifier(obj) &&
        obj.text === 'mock'
      ) {
        strictIsolated.add(`mock.${prop}`);
      }
    }

    if (ts.isDeleteExpression(node)) {
      const expr = unwrapExpr(ts, node.expression);
      if (isProcessEnvMemberExpr(ts, expr)) {
        strictIsolated.add('delete:process.env');
      } else if (expr && (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr))) {
        const host = unwrapExpr(ts, expr.expression);
        const prop = ts.isPropertyAccessExpression(expr) ? expr.name.text : undefined;
        if (host && ts.isIdentifier(host) && host.text === 'globalThis') {
          if (prop && DESTRUCTIVE_DOM_GLOBAL_PROPS.has(prop)) {
            strictIsolated.add(`delete:globalThis.${prop}`);
          } else {
            nodeGlobal.add(`delete:globalThis${prop ? `.${prop}` : '[]'}`);
          }
        }
      }
    }

    if (isAssignmentExpr(ts, node)) {
      const left = unwrapExpr(ts, node.left);
      if (isProcessPropExpr(ts, left, 'env') || isProcessEnvMemberExpr(ts, left)) {
        strictIsolated.add('assign:process.env');
      } else if (isProcessPropExpr(ts, left, 'argv')) {
        strictIsolated.add('assign:process.argv');
      } else if (left && ts.isIdentifier(left) && MUTATED_GLOBAL_IDENTIFIERS.has(left.text)) {
        strictIsolated.add(`override:${left.text}`);
      } else if (left && ts.isIdentifier(left) && left.text === 'fetch') {
        nodeGlobal.add('override:fetch');
      } else if (
        left &&
        ts.isPropertyAccessExpression(left) &&
        ts.isIdentifier(unwrapExpr(ts, left.expression)) &&
        MUTATED_GLOBAL_IDENTIFIERS.has(unwrapExpr(ts, left.expression).text)
      ) {
        strictIsolated.add(`override:${unwrapExpr(ts, left.expression).text}.${left.name.text}`);
      } else if (left && (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left))) {
        const host = unwrapExpr(ts, left.expression);
        const prop = ts.isPropertyAccessExpression(left) ? left.name.text : undefined;
        if (host && ts.isIdentifier(host) && host.text === 'globalThis') {
          if (prop && isDomSafeGlobalProp(prop)) {
            dom.add(`global:globalThis.${prop}`);
          } else if (ts.isElementAccessExpression(left) && isClientSharedGlobalIndexExpr(ts, left.argumentExpression)) {
            dom.add('global:globalThis[CLIENT_SHARED_GLOBALS]');
          } else if (prop && (DESTRUCTIVE_DOM_GLOBAL_PROPS.has(prop) || MUTATED_GLOBAL_IDENTIFIERS.has(prop))) {
            strictIsolated.add(`assign:globalThis.${prop}`);
          } else {
            nodeGlobal.add(`assign:globalThis${prop ? `.${prop}` : '[]'}`);
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1) {
        const arg0 = unwrapExpr(ts, node.arguments[0]);
        if (arg0 && ts.isStringLiteralLike(arg0)) {
          if (matchesModulePrefix(arg0.text, WORKER_MODULE_PREFIXES)) {
            strictIsolated.add(`dyn-import:${arg0.text}`);
          } else if (matchesModulePrefix(arg0.text, DOM_MODULE_PREFIXES)) {
            dom.add(`dyn-import:${arg0.text}`);
          } else if (matchesModulePrefix(arg0.text, NODE_BACKEND_MODULE_PREFIXES)) {
            nodeBackend.add(`dyn-import:${arg0.text}`);
          } else if (isPluginBuildModule(arg0.text)) {
            nodeFs.add(`dyn-import:${arg0.text}`);
          }
          visitHelper(arg0.text);
        } else {
          nodeFs.add('dyn-import:dynamic');
        }
      }

      const callee = unwrapExpr(ts, node.expression);
      if (callee && ts.isIdentifier(callee)) {
        if (callee.text === 'require' && node.arguments.length >= 1) {
          const arg0 = unwrapExpr(ts, node.arguments[0]);
          if (arg0 && ts.isStringLiteralLike(arg0)) {
            if (matchesModulePrefix(arg0.text, WORKER_MODULE_PREFIXES)) {
              strictIsolated.add(`require:${arg0.text}`);
            } else if (matchesModulePrefix(arg0.text, DOM_MODULE_PREFIXES)) {
              dom.add(`require:${arg0.text}`);
            } else if (matchesModulePrefix(arg0.text, NODE_BACKEND_MODULE_PREFIXES)) {
              nodeBackend.add(`require:${arg0.text}`);
            } else if (isPluginBuildModule(arg0.text)) {
              nodeFs.add(`require:${arg0.text}`);
            }
          } else {
            nodeFs.add('require:dynamic');
          }
        }
        if (bindings.cpExecBindings.has(callee.text) || (bindings.importsChildProcess && SUBPROCESS_CALL_NAMES.has(callee.text))) {
          nodeBackend.add(`call:${callee.text}`);
        } else if (NODE_BACKEND_CALLS.has(callee.text)) {
          nodeBackend.add(`call:${callee.text}`);
        } else if (
          FS_WRITE_IMPORTS.has(callee.text) ||
          callee.text === 'compilePluginClientModule' ||
          callee.text === 'createRequire'
        ) {
          nodeFs.add(`call:${callee.text}`);
        }
      } else if (callee && ts.isPropertyAccessExpression(callee)) {
        const host = unwrapExpr(ts, callee.expression);
        const method = callee.name.text;
        if (host && ts.isIdentifier(host) && host.text === 'GlobalRegistrator') {
          if (method === 'register') dom.add('call:GlobalRegistrator.register');
          else if (method === 'unregister') strictIsolated.add('call:GlobalRegistrator.unregister');
        } else if (host && ts.isIdentifier(host) && host.text === 'process') {
          if (method === 'kill') {
            // `process.kill(pid, 0)` is a read-only liveness probe; actual signals stay isolated.
            const sigArg = node.arguments[1] ? unwrapExpr(ts, node.arguments[1]) : null;
            if (sigArg && ts.isNumericLiteral(sigArg) && sigArg.text === '0') {
              nodeFs.add('process.kill:probe');
            } else {
              strictIsolated.add('process.kill');
            }
          } else if (method === 'on' || method === 'once') {
            const evArg = node.arguments[0] ? unwrapExpr(ts, node.arguments[0]) : null;
            if (
              method === 'on' &&
              evArg &&
              ts.isStringLiteralLike(evArg) &&
              evArg.text === 'unhandledRejection' &&
              bindings.hasUnhandledRejectionOff
            ) {
              nodeFs.add('process.on:unhandledRejection-scoped');
            } else {
              strictIsolated.add(`process.${method}`);
            }
          }
        } else if (host && ts.isIdentifier(host) && bindings.cpNamespaces.has(host.text) && SUBPROCESS_CALL_NAMES.has(method)) {
          nodeBackend.add(`call:${method}`);
        } else if (method === 'exec') {
          const isRegexHost =
            Boolean(host && ts.isRegularExpressionLiteral(host)) ||
            Boolean(host && ts.isIdentifier(host) && bindings.regexBindings.has(host.text));
          if (!isRegexHost) {
            nodeBackend.add('call:exec');
          }
        } else if (SUBPROCESS_CALL_NAMES.has(method) && method !== 'fork') {
          nodeBackend.add(`call:${method}`);
        } else if (NODE_BACKEND_CALLS.has(method)) {
          nodeBackend.add(`call:${method}`);
        } else if (FS_WRITE_IMPORTS.has(method)) {
          if (!FS_NAMESPACE_ONLY_METHODS.has(method) || (host && ts.isIdentifier(host) && bindings.fsNamespaces.has(host.text))) {
            nodeFs.add(`call:${method}`);
          }
        } else if (method === 'compilePluginClientModule' || method === 'createRequire') {
          nodeFs.add(`call:${method}`);
        }

        if (
          host &&
          ts.isIdentifier(host) &&
          ((host.text === 'Object' && (method === 'assign' || method === 'defineProperty' || method === 'defineProperties')) ||
            (host.text === 'Reflect' && (method === 'set' || method === 'defineProperty' || method === 'deleteProperty'))) &&
          node.arguments.length >= 1
        ) {
          checkMutatedTarget(node.arguments[0], `${host.text}.${method}`, node);
        }
        if (isProcessPropExpr(ts, host, 'argv')) {
          strictIsolated.add(`mutate:process.argv.${method}`);
        }
      }
    }

    if (ts.isNewExpression(node)) {
      const cls = unwrapExpr(ts, node.expression);
      if (cls && ts.isIdentifier(cls)) {
        if (cls.text === 'Worker') strictIsolated.add('new:Worker');
        else if (NODE_BACKEND_CONSTRUCTORS.has(cls.text)) nodeBackend.add(`new:${cls.text}`);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  const signals = {
    strictIsolatedReasons: [...strictIsolated].sort(),
    domReasons: [...dom].sort(),
    nodeBackendReasons: [...nodeBackend].sort(),
    nodeFsReasons: [...nodeFs].sort(),
    nodeGlobalReasons: [...nodeGlobal].sort(),
  };
  const pool = resolvePoolFromSignals(signals);
  const reasons = [
    ...new Set([
      ...signals.strictIsolatedReasons,
      ...signals.domReasons,
      ...signals.nodeBackendReasons,
      ...signals.nodeFsReasons,
      ...signals.nodeGlobalReasons,
    ]),
  ].sort();

  return {
    pure: pool === 'pure',
    pool,
    reasons,
    ...signals,
  };
}

function normalizeCacheKey(repoRoot, absFilePath) {
  const rel = path.relative(repoRoot, absFilePath);
  return rel.split(path.sep).join('/');
}

function statFingerprint(absPath) {
  try {
    const st = statSync(absPath);
    if (!st.isFile()) return null;
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

export function emptyPurityCache() {
  return { schemaVersion: TEST_POOL_CACHE_SCHEMA_VERSION, entries: {} };
}

/**
 * Load persisted AST purity/pool classification cache. Returns empty cache on miss/corruption.
 * @param {string} cachePath
 */
export function loadPurityCache(cachePath) {
  if (!cachePath || !existsSync(cachePath)) return emptyPurityCache();
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.schemaVersion !== TEST_POOL_CACHE_SCHEMA_VERSION ||
      !parsed.entries ||
      typeof parsed.entries !== 'object' ||
      Array.isArray(parsed.entries)
    ) {
      return emptyPurityCache();
    }
    return { schemaVersion: TEST_POOL_CACHE_SCHEMA_VERSION, entries: parsed.entries };
  } catch {
    return emptyPurityCache();
  }
}

/**
 * Atomically persist the AST purity/pool classification cache. Never throws on IO failures.
 * @param {string} cachePath
 * @param {{ schemaVersion: number, entries: Record<string, unknown> }} cache
 */
export function savePurityCache(cachePath, cache) {
  try {
    mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache), 'utf8');
    renameSync(tmp, cachePath);
    return true;
  } catch {
    return false;
  }
}

function isCacheEntryValid(repoRoot, absFilePath, entry) {
  if (!entry || typeof entry !== 'object' || !entry.result || typeof entry.result.pool !== 'string') {
    return false;
  }
  const mainStat = statFingerprint(absFilePath);
  if (!mainStat || mainStat.mtimeMs !== entry.mtimeMs || mainStat.size !== entry.size) {
    return false;
  }
  if (!Array.isArray(entry.helpers)) return false;
  for (const helper of entry.helpers) {
    if (!helper || typeof helper.path !== 'string') return false;
    const helperAbs = path.isAbsolute(helper.path) ? helper.path : path.join(repoRoot, helper.path);
    const hStat = statFingerprint(helperAbs);
    if (!hStat || hStat.mtimeMs !== helper.mtimeMs || hStat.size !== helper.size) {
      return false;
    }
  }
  return true;
}

/**
 * Analyze and classify a single test file on disk into one of the 4 pools, using an optional
 * mtime/size + helper-fingerprint cache to avoid redundant TS AST parses.
 *
 * @param {typeof import('typescript') | null} tsOrNull
 * @param {string} absFilePath
 * @param {{ repoRoot?: string, cache?: { schemaVersion: number, entries: Record<string, any> }, getTs?: () => typeof import('typescript') }} [options]
 * @returns {{ pure: boolean, pool: 'pure' | 'dom-shared' | 'node-shared' | 'isolated', reasons: string[], cacheHit: boolean }}
 */
export function classifyTestFilePool(tsOrNull, absFilePath, options = {}) {
  const repoRoot = options.repoRoot ?? process.cwd();
  const cache = options.cache;
  const key = normalizeCacheKey(repoRoot, absFilePath);

  if (cache && isCacheEntryValid(repoRoot, absFilePath, cache.entries[key])) {
    const cached = cache.entries[key].result;
    return {
      pure: cached.pool === 'pure',
      pool: cached.pool,
      reasons: Array.isArray(cached.reasons) ? cached.reasons : [],
      cacheHit: true,
    };
  }

  let source;
  try {
    source = readFileSync(absFilePath, 'utf8');
  } catch (err) {
    return { pure: false, pool: 'isolated', reasons: [`read-error:${err.message}`], cacheHit: false };
  }

  const ts = tsOrNull ?? options.getTs?.();
  if (!ts) {
    throw new Error('[test-sharding] TypeScript compiler instance is required on AST cache miss');
  }

  const visitedHelpers = new Set();
  const resolveHelper = (fromFile, specifier) => {
    const resolved = resolveRelativeTestHelper(fromFile, specifier);
    if (!resolved) return null;
    visitedHelpers.add(resolved);
    try {
      return { path: resolved, source: readFileSync(resolved, 'utf8') };
    } catch {
      return { path: resolved, source: '' };
    }
  };

  const analysis = analyzeTestSourcePurity(ts, absFilePath, source, resolveHelper, new Set());
  if (cache) {
    const mainStat = statFingerprint(absFilePath);
    if (mainStat) {
      const helpers = [];
      for (const helperAbs of [...visitedHelpers].sort()) {
        const hStat = statFingerprint(helperAbs);
        if (hStat) {
          helpers.push({
            path: normalizeCacheKey(repoRoot, helperAbs),
            mtimeMs: hStat.mtimeMs,
            size: hStat.size,
          });
        }
      }
      cache.entries[key] = {
        mtimeMs: mainStat.mtimeMs,
        size: mainStat.size,
        helpers,
        result: {
          pool: analysis.pool,
          pure: analysis.pure,
          reasons: analysis.reasons,
        },
      };
    }
  }

  return {
    pure: analysis.pure,
    pool: analysis.pool,
    reasons: analysis.reasons,
    cacheHit: false,
  };
}

/**
 * Analyze a single test file on disk (backwards-compatible wrapper around `classifyTestFilePool`).
 * @param {typeof import('typescript')} ts
 * @param {string} absFilePath
 * @returns {{ pure: boolean, pool: 'pure' | 'dom-shared' | 'node-shared' | 'isolated', reasons: string[] }}
 */
export function analyzeTestFilePurity(ts, absFilePath) {
  const { pure, pool, reasons } = classifyTestFilePool(ts, absFilePath);
  return { pure, pool, reasons };
}

/** Decide whether pass-through args alter runner isolation, concurrency, or the output report format. */
export function shouldDisableSharding(extraArgs) {
  return extraArgs.some((arg) => {
    if (
      arg === '-t' ||
      arg === '--watch' ||
      arg === '--test-only' ||
      arg === '--test-force-exit' ||
      arg === '--experimental-test-coverage'
    ) {
      return true;
    }
    return [
      '--test-isolation',
      '--test-name-pattern',
      '--test-skip-pattern',
      '--test-timeout',
      '--test-reporter',
      '--test-reporter-destination',
      '--test-shard',
      '--test-concurrency',
      '--test-coverage',
    ].some((prefix) => arg === prefix || arg.startsWith(`${prefix}=`));
  });
}

/**
 * Distribute files across `shardCount` buckets using Longest Processing Time first (LPT) bin packing.
 * @param {string[]} files
 * @param {number} shardCount
 * @param {(relPath: string) => number} weightFn
 * @returns {Array<{ files: string[], weight: number }>}
 */
export function balanceShardsLpt(files, shardCount, weightFn) {
  if (files.length === 0) return [];
  const count = Math.max(1, Math.min(files.length, Math.floor(shardCount)));
  const sorted = [...files].sort((a, b) => weightFn(b) - weightFn(a) || a.localeCompare(b));
  const buckets = Array.from({ length: count }, () => ({
    weight: 0,
    files: /** @type {string[]} */ ([]),
  }));

  for (const rel of sorted) {
    let lightest = buckets[0];
    for (let i = 1; i < buckets.length; i += 1) {
      if (buckets[i].weight < lightest.weight) lightest = buckets[i];
    }
    lightest.files.push(rel);
    lightest.weight += Math.max(1, weightFn(rel));
  }

  return buckets
    .filter((b) => b.files.length > 0)
    .sort((a, b) => b.weight - a.weight || a.files[0].localeCompare(b.files[0]));
}

/**
 * Legacy helper: split files into pure shards and non-pure files (retained for unit tests/callers).
 */
export function partitionFilesForSharding({
  ts,
  repoRoot,
  files,
  cpus,
  filesPerShard = 8,
  weightFn,
}) {
  const pureFiles = [];
  const isolatedFiles = [];
  for (const rel of files) {
    const abs = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
    if (classifyTestFilePool(ts, abs, { repoRoot }).pure) pureFiles.push(rel);
    else isolatedFiles.push(rel);
  }

  const byWeightDesc = (a, b) => weightFn(b) - weightFn(a) || a.localeCompare(b);
  pureFiles.sort(byWeightDesc);
  isolatedFiles.sort(byWeightDesc);

  if (pureFiles.length === 0) {
    return { pureFiles, isolatedFiles, shards: [] };
  }

  const shardCount = Math.min(
    Math.max(1, cpus),
    Math.max(1, Math.ceil(pureFiles.length / filesPerShard)),
  );
  const shards = balanceShardsLpt(pureFiles, shardCount, weightFn).map((b) => b.files);
  return { pureFiles, isolatedFiles, shards };
}

const POOL_TIEBREAK_ORDER = {
  isolated: 0,
  'node-shared': 1,
  'dom-shared': 2,
  pure: 3,
};

/**
 * Partition test files across the 4 pools and generate concurrent `permits: 1` LPT execution
 * plans (sorted heaviest-first across all pools so every core starts busy at t=0 with zero
 * serial pure barrier).
 *
 * @param {{
 *   ts?: typeof import('typescript') | null,
 *   getTs?: () => typeof import('typescript'),
 *   repoRoot: string,
 *   files: string[],
 *   workerBudget: number,
 *   weightFn: (relPath: string) => number,
 *   cachePath?: string,
 *   useCache?: boolean,
 * }} input
 */
export function planFourPoolSchedule({
  ts = null,
  getTs = undefined,
  repoRoot,
  files,
  workerBudget,
  weightFn,
  cachePath = path.join(repoRoot, DEFAULT_PURITY_CACHE_REL),
  useCache = true,
}) {
  const cache = useCache ? loadPurityCache(cachePath) : null;
  let tsInstance = ts;
  const resolveTs = () => {
    if (!tsInstance) tsInstance = getTs?.() ?? null;
    return tsInstance;
  };

  /** @type {{ pure: string[], 'dom-shared': string[], 'node-shared': string[], isolated: string[] }} */
  const pools = {
    pure: [],
    'dom-shared': [],
    'node-shared': [],
    isolated: [],
  };

  let cacheHits = 0;
  let cacheMisses = 0;
  for (const rel of files) {
    const abs = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
    const res = classifyTestFilePool(tsInstance, abs, {
      repoRoot,
      cache: cache ?? undefined,
      getTs: resolveTs,
    });
    if (res.cacheHit) cacheHits += 1;
    else cacheMisses += 1;
    pools[res.pool].push(rel);
  }

  if (cache && cacheMisses > 0) {
    savePurityCache(cachePath, cache);
  }

  const byWeightDesc = (a, b) => weightFn(b) - weightFn(a) || a.localeCompare(b);
  for (const list of Object.values(pools)) {
    list.sort(byWeightDesc);
  }

  const budget = Math.max(1, Math.floor(workerBudget));
  const poolWeights = {
    pure: pools.pure.reduce((s, f) => s + Math.max(1, weightFn(f)), 0),
    'dom-shared': pools['dom-shared'].reduce((s, f) => s + Math.max(1, weightFn(f)), 0),
    'node-shared': pools['node-shared'].reduce((s, f) => s + Math.max(1, weightFn(f)), 0),
    isolated: pools.isolated.reduce((s, f) => s + Math.max(1, weightFn(f)), 0),
  };
  const totalWeight =
    poolWeights.pure + poolWeights['dom-shared'] + poolWeights['node-shared'] + poolWeights.isolated;

  // Target ~1.75x oversubscription across pools so finished workers steal queued shards
  // cleanly without tail bubbles, while keeping per-shard work large enough to amortize tsx boot.
  const targetShardWeight = Math.max(1_500, totalWeight / Math.max(1, budget * 1.75));

  const maxShardsByPool = {
    pure: pools.pure.length === 0 ? 0 : Math.min(budget, Math.max(1, Math.ceil(pools.pure.length / 8))),
    'dom-shared': pools['dom-shared'].length === 0 ? 0 : Math.min(pools['dom-shared'].length, budget * 2),
    'node-shared': pools['node-shared'].length === 0 ? 0 : Math.min(pools['node-shared'].length, budget * 2),
    isolated: pools.isolated.length === 0 ? 0 : Math.min(pools.isolated.length, budget * 2),
  };

  const minWeightByPool = {
    pure: 3_000,
    'dom-shared': 2_000,
    'node-shared': 2_000,
    isolated: 1_500,
  };

  /** @type {Record<'pure' | 'dom-shared' | 'node-shared' | 'isolated', number>} */
  const shardCounts = { pure: 0, 'dom-shared': 0, 'node-shared': 0, isolated: 0 };
  for (const pool of /** @type {const} */ (['pure', 'dom-shared', 'node-shared', 'isolated'])) {
    if (pools[pool].length === 0) continue;
    const desired = Math.ceil(poolWeights[pool] / Math.max(targetShardWeight, minWeightByPool[pool]));
    shardCounts[pool] = Math.max(1, Math.min(maxShardsByPool[pool], desired));
  }

  // If total shards < workerBudget, expand the heaviest expandable pool until cores are utilized.
  let totalShards =
    shardCounts.pure + shardCounts['dom-shared'] + shardCounts['node-shared'] + shardCounts.isolated;
  while (totalShards < budget) {
    let bestPool = null;
    let bestAvgWeight = 0;
    for (const pool of /** @type {const} */ (['isolated', 'node-shared', 'dom-shared', 'pure'])) {
      if (shardCounts[pool] > 0 && shardCounts[pool] < maxShardsByPool[pool]) {
        const avgWeight = poolWeights[pool] / shardCounts[pool];
        if (avgWeight > bestAvgWeight && avgWeight >= 300) {
          bestAvgWeight = avgWeight;
          bestPool = pool;
        }
      }
    }
    if (!bestPool) break;
    shardCounts[bestPool] += 1;
    totalShards += 1;
  }

  /** @type {Array<{ label: string, pool: 'pure' | 'dom-shared' | 'node-shared' | 'isolated', mode: 'shard-worker' | 'isolated', files: string[], permits: number, estimatedWeight: number }>} */
  const plans = [];

  for (const pool of /** @type {const} */ (['pure', 'dom-shared', 'node-shared', 'isolated'])) {
    const count = shardCounts[pool];
    if (count === 0) continue;
    const buckets = balanceShardsLpt(pools[pool], count, weightFn);
    const mode = pool === 'isolated' ? 'isolated' : 'shard-worker';
    buckets.forEach((bucket, idx) => {
      plans.push({
        label: `${pool}-${idx + 1}/${buckets.length}`,
        pool,
        mode,
        files: bucket.files,
        permits: 1,
        estimatedWeight: bucket.weight,
      });
    });
  }

  // Launch heaviest shards across ALL 4 pools first at t=0 — zero serial pure barrier!
  plans.sort(
    (a, b) =>
      b.estimatedWeight - a.estimatedWeight ||
      POOL_TIEBREAK_ORDER[a.pool] - POOL_TIEBREAK_ORDER[b.pool] ||
      a.label.localeCompare(b.label),
  );

  return {
    pools,
    shardCounts,
    plans,
    cacheStats: { hits: cacheHits, misses: cacheMisses },
  };
}
