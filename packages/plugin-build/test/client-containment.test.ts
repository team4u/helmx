/**
 * Security containment boundary tests for PluginClientCompiler (`containmentPlugin` & `findPackageDirOf`):
 * - Unauthorized absolute path imports (POSIX, Windows drive, UNC, CSS `@import`, dynamic import,
 *   in-root absolute paths, and absolute paths into `node_modules`) are explicitly rejected;
 * - Empty `npmRoots` permits zero `node_modules` resolution via bare specifiers, relative traversal,
 *   nested `./node_modules`, symlinks (with or without extension), or absolute paths;
 * - Symlink escapes from `clientRoot`, into declared `node_modules`, inside declared npm packages,
 *   and via `package.json` `main`/`exports` are explicitly rejected while valid in-root and pnpm-style
 *   package symlinks continue to work;
 * - Transitive npm dependencies work when reachable from a declared package (including multi-hop,
 *   scoped packages, pnpm-style symlinked stores, and package `#imports`), while direct undeclared
 *   imports from `clientRoot`, relative escapes across packages, symlink escapes inside transitive
 *   packages, and orphan `node_modules` dirs without `package.json` are rejected;
 * - `findPackageDirOf` returns `null` (never `fileReal` and never walking past `node_modules` into
 *   an ancestor workspace `package.json`).
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmxError } from '@helmx/protocol'
import {
  clearClientCompilerMemoryCache,
  compilePluginClientModule,
  findPackageDirOf,
} from '../src/client-compiler.js'

let workDir: string

beforeEach(() => {
  clearClientCompilerMemoryCache()
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'helmx-client-containment-')))
})

afterEach(() => {
  clearClientCompilerMemoryCache()
  rmSync(workDir, { recursive: true, force: true })
})

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writeFakePkg(
  nodeModulesDir: string,
  name: string,
  files: Record<string, string>,
  pkgJsonExtra: Record<string, unknown> = {},
): string {
  const pkgDir = join(nodeModulesDir, ...name.split('/'))
  mkdirSync(pkgDir, { recursive: true })
  writeJson(join(pkgDir, 'package.json'), {
    name,
    version: '1.0.0',
    type: 'module',
    main: './index.js',
    ...pkgJsonExtra,
  })
  for (const [rel, content] of Object.entries(files)) {
    const full = join(pkgDir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return pkgDir
}

async function evalBundle(code: string): Promise<Record<string, unknown>> {
  const url = `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}#${Math.random()}`
  return (await import(url)) as Record<string, unknown>
}

test('unauthorized absolute imports are rejected across POSIX, Windows/UNC, in-root, node_modules, dynamic import, and CSS @import', { timeout: 60_000 }, async () => {
  const outsideDir = join(workDir, 'outside')
  const outsideNmDir = join(outsideDir, 'node_modules')
  mkdirSync(outsideDir, { recursive: true })
  const outsideTs = join(outsideDir, 'secret.ts')
  const outsideCss = join(outsideDir, 'secret.css')
  writeFileSync(outsideTs, 'export const secret = "leaked"\n', 'utf8')
  writeFileSync(outsideCss, '.leaked { color: red }\n', 'utf8')
  const evilPkgDir = writeFakePkg(outsideNmDir, 'evil-abs-pkg', {
    'index.js': 'export const evil = "abs-nm-leaked"\n',
    'style.css': '.evil-nm { color: red }\n',
  })
  const evilPkgEntry = join(evilPkgDir, 'index.js')
  const evilPkgCss = join(evilPkgDir, 'style.css')

  const pluginDir = join(workDir, 'plugin-abs')
  const declaredPkgDir = writeFakePkg(join(pluginDir, 'node_modules'), 'declared-pkg', {
    'index.js': 'export const ok = "declared"\n',
    'internal.js': 'export const hidden = "internal"\n',
  })
  const declaredInternal = join(declaredPkgDir, 'internal.js')
  const npmRoots = [{ packageRoot: pluginDir, specifiers: ['declared-pkg'] }]

  const cases: Array<{
    name: string
    source: string
    extraFiles?: Record<string, string>
    roots?: typeof npmRoots
    expectPattern: RegExp
  }> = [
    {
      name: 'posix-outside-file',
      source: `import { secret } from ${JSON.stringify(outsideTs)}\nexport const v = secret\n`,
      expectPattern: /unauthorized absolute/i,
    },
    {
      name: 'posix-outside-node-modules-empty-roots',
      source: `import { evil } from ${JSON.stringify(evilPkgEntry)}\nexport const v = evil\n`,
      expectPattern: /unauthorized absolute/i,
    },
    {
      name: 'posix-outside-node-modules-with-other-roots',
      source: `import { evil } from ${JSON.stringify(evilPkgEntry)}\nexport const v = evil\n`,
      roots: npmRoots,
      expectPattern: /unauthorized absolute/i,
    },
    {
      name: 'posix-declared-node-modules-bypass-exports',
      source: `import { ok } from 'declared-pkg'\nimport { hidden } from ${JSON.stringify(declaredInternal)}\nexport const v = ok + hidden\n`,
      roots: npmRoots,
      expectPattern: /unauthorized absolute/i,
    },
    {
      name: 'dynamic-absolute-node-modules',
      source: `export const load = () => import(${JSON.stringify(evilPkgEntry)})\n`,
      expectPattern: /unauthorized absolute/i,
    },
    {
      name: 'windows-drive-absolute',
      source: `import { x } from 'C:\\\\outside\\\\secret.ts'\nexport const v = x\n`,
      expectPattern: /unauthorized absolute/i,
    },
    {
      name: 'windows-unc-absolute',
      source: `import { x } from '\\\\\\\\server\\\\share\\\\secret.ts'\nexport const v = x\n`,
      expectPattern: /unauthorized absolute/i,
    },
    {
      name: 'css-absolute-outside',
      source: `import './styles.css'\nexport const v = 1\n`,
      extraFiles: { 'styles.css': `@import ${JSON.stringify(outsideCss)};\n.a { color: blue }\n` },
      expectPattern: /unauthorized absolute/i,
    },
    {
      name: 'css-absolute-node-modules',
      source: `import './styles.css'\nexport const v = 1\n`,
      extraFiles: { 'styles.css': `@import ${JSON.stringify(evilPkgCss)};\n.a { color: blue }\n` },
      expectPattern: /unauthorized absolute/i,
    },
  ]

  for (const tc of cases) {
    const clientRoot = join(workDir, `abs-case-${tc.name}`)
    mkdirSync(clientRoot, { recursive: true })
    if (tc.extraFiles) {
      for (const [rel, content] of Object.entries(tc.extraFiles)) {
        writeFileSync(join(clientRoot, rel), content, 'utf8')
      }
    }
    writeFileSync(join(clientRoot, 'index.tsx'), tc.source, 'utf8')
    await assert.rejects(
      compilePluginClientModule(`test:abs-${tc.name}`, clientRoot, 'index.tsx', join(workDir, 'cache'), {
        npmRoots: tc.roots ?? [],
      }),
      (err: unknown) =>
        err instanceof HelmxError &&
        err.code === 'client_compile_failed' &&
        tc.expectPattern.test(err.message),
      `case ${tc.name} must be explicitly rejected`,
    )
  }

  // Absolute path even when pointing inside clientRoot itself must also be rejected (portable relative imports only).
  const inRootClient = join(workDir, 'abs-case-in-root')
  mkdirSync(inRootClient, { recursive: true })
  const localHelper = join(inRootClient, 'helper.ts')
  writeFileSync(localHelper, 'export const n = 1\n', 'utf8')
  writeFileSync(
    join(inRootClient, 'index.tsx'),
    `import { n } from ${JSON.stringify(localHelper)}\nexport const v = n\n`,
    'utf8',
  )
  await assert.rejects(
    compilePluginClientModule('test:abs-in-root', inRootClient, 'index.tsx', join(workDir, 'cache')),
    (err: unknown) =>
      err instanceof HelmxError &&
      err.code === 'client_compile_failed' &&
      /unauthorized absolute/i.test(err.message),
  )
})

test('empty npmRoots forbids all node_modules access (bare, relative, extensionless, nested ./node_modules, symlink, absolute)', { timeout: 60_000 }, async () => {
  const pluginDir = join(workDir, 'empty-roots-plugin')
  const clientRoot = join(pluginDir, 'client')
  mkdirSync(clientRoot, { recursive: true })
  const pkgDir = writeFakePkg(join(pluginDir, 'node_modules'), 'sneaky-pkg', {
    'index.js': 'export const leaked = "from-nm"\n',
  })
  const pkgEntry = join(pkgDir, 'index.js')

  // Also test when clientRoot itself contains a nested node_modules directory (e.g. clientRoot === ".").
  writeFakePkg(join(clientRoot, 'node_modules'), 'nested-pkg', {
    'index.js': 'export const nested = "from-nested-nm"\n',
  })

  // Symlink inside clientRoot pointing into node_modules (both with and without extension in import specifier).
  symlinkSync(pkgEntry, join(clientRoot, 'linked-nm.js'))

  const vectors: Array<{ name: string; source: string; expectPattern: RegExp }> = [
    {
      name: 'bare',
      source: `import { leaked } from 'sneaky-pkg'\nexport const v = leaked\n`,
      expectPattern: /reject bare dependency/,
    },
    {
      name: 'relative-explicit',
      source: `import { leaked } from '../node_modules/sneaky-pkg/index.js'\nexport const v = leaked\n`,
      expectPattern: /out of bounds/,
    },
    {
      name: 'relative-extensionless',
      source: `import { leaked } from '../node_modules/sneaky-pkg/index'\nexport const v = leaked\n`,
      expectPattern: /out of bounds/,
    },
    {
      name: 'nested-relative-node-modules',
      source: `import { nested } from './node_modules/nested-pkg/index.js'\nexport const v = nested\n`,
      expectPattern: /out of bounds/,
    },
    {
      name: 'symlink-explicit',
      source: `import { leaked } from './linked-nm.js'\nexport const v = leaked\n`,
      expectPattern: /out of bounds/,
    },
    {
      name: 'symlink-extensionless',
      source: `import { leaked } from './linked-nm'\nexport const v = leaked\n`,
      expectPattern: /out of bounds/,
    },
    {
      name: 'absolute-node-modules',
      source: `import { leaked } from ${JSON.stringify(pkgEntry)}\nexport const v = leaked\n`,
      expectPattern: /unauthorized absolute/i,
    },
  ]

  for (const vec of vectors) {
    const entryName = `entry-${vec.name}.tsx`
    writeFileSync(join(clientRoot, entryName), vec.source, 'utf8')
    await assert.rejects(
      compilePluginClientModule(`test:empty-roots-${vec.name}`, clientRoot, entryName, join(workDir, 'cache'), {
        npmRoots: [],
      }),
      (err: unknown) =>
        err instanceof HelmxError &&
        err.code === 'client_compile_failed' &&
        vec.expectPattern.test(err.message),
      `empty npmRoots vector ${vec.name} must be rejected without auto-authorizing node_modules`,
    )
  }
})

test('symlink boundaries: rejects escapes from clientRoot, into declared npm, inside declared npm, and via package.json main; permits valid internal and pnpm-style symlinks', { timeout: 60_000 }, async () => {
  const outsideDir = join(workDir, 'sym-outside')
  mkdirSync(outsideDir, { recursive: true })
  const outsideFile = join(outsideDir, 'secret.ts')
  writeFileSync(outsideFile, 'export const secret = "outside"\n', 'utf8')

  const pluginDir = join(workDir, 'sym-plugin')
  const clientRoot = join(pluginDir, 'client')
  const nmDir = join(pluginDir, 'node_modules')
  mkdirSync(clientRoot, { recursive: true })
  mkdirSync(nmDir, { recursive: true })

  // Valid in-root symlink (alias to sibling file inside clientRoot).
  writeFileSync(join(clientRoot, 'real-helper.ts'), 'export const helperVal = "in-root-ok"\n', 'utf8')
  symlinkSync(join(clientRoot, 'real-helper.ts'), join(clientRoot, 'alias-helper.ts'))

  // Valid pnpm-style symlinked package directory pointing to an external package store.
  const storePkgDir = join(workDir, 'pnpm-store', 'good-pkg@1.0.0', 'node_modules', 'good-pkg')
  mkdirSync(storePkgDir, { recursive: true })
  writeJson(join(storePkgDir, 'package.json'), {
    name: 'good-pkg',
    version: '1.0.0',
    type: 'module',
    main: './index.js',
  })
  writeFileSync(join(storePkgDir, 'index.js'), 'export const pkgVal = "pnpm-pkg-ok"\n', 'utf8')
  symlinkSync(storePkgDir, join(nmDir, 'good-pkg'), 'dir')

  writeFileSync(
    join(clientRoot, 'valid.tsx'),
    `import { helperVal } from './alias-helper'\nimport { pkgVal } from 'good-pkg'\nexport const out = helperVal + ':' + pkgVal\n`,
    'utf8',
  )
  const validBundle = await compilePluginClientModule('test:sym-valid', clientRoot, 'valid.tsx', join(workDir, 'cache'), {
    npmRoots: [{ packageRoot: pluginDir, specifiers: ['good-pkg'] }],
  })
  const validMod = await evalBundle(validBundle.code)
  assert.equal(validMod.out, 'in-root-ok:pnpm-pkg-ok')

  // 1. Extensionless file symlink & directory symlink escaping clientRoot.
  symlinkSync(outsideFile, join(clientRoot, 'escape-file.ts'))
  symlinkSync(outsideDir, join(clientRoot, 'escape-dir'), 'dir')
  writeFileSync(join(clientRoot, 'bad-file-sym.tsx'), `import { secret } from './escape-file'\nexport const v = secret\n`, 'utf8')
  writeFileSync(join(clientRoot, 'bad-dir-sym.tsx'), `import { secret } from './escape-dir/secret'\nexport const v = secret\n`, 'utf8')
  for (const modName of ['bad-file-sym.tsx', 'bad-dir-sym.tsx']) {
    await assert.rejects(
      compilePluginClientModule(`test:sym-${modName}`, clientRoot, modName, join(workDir, 'cache')),
      (err: unknown) => err instanceof HelmxError && err.code === 'client_compile_failed' && /out of bounds/.test(err.message),
    )
  }

  // 2. Symlink inside clientRoot pointing into an otherwise declared npm package must still be rejected.
  symlinkSync(join(storePkgDir, 'index.js'), join(clientRoot, 'sym-into-declared.js'))
  writeFileSync(
    join(clientRoot, 'bad-into-declared.tsx'),
    `import { pkgVal } from './sym-into-declared'\nexport const v = pkgVal\n`,
    'utf8',
  )
  await assert.rejects(
    compilePluginClientModule('test:sym-into-declared', clientRoot, 'bad-into-declared.tsx', join(workDir, 'cache'), {
      npmRoots: [{ packageRoot: pluginDir, specifiers: ['good-pkg'] }],
    }),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_compile_failed' && /out of bounds/.test(err.message),
  )

  // 3. Declared npm package with internal relative symlink escaping outside package dir.
  const escapingPkgDir = writeFakePkg(nmDir, 'escaping-pkg', {
    'index.js': `import { secret } from './escape.ts'\nexport const v = secret\n`,
  })
  symlinkSync(outsideFile, join(escapingPkgDir, 'escape.ts'))
  writeFileSync(join(clientRoot, 'bad-pkg-sym.tsx'), `import { v } from 'escaping-pkg'\nexport const out = v\n`, 'utf8')
  await assert.rejects(
    compilePluginClientModule('test:sym-pkg-escape', clientRoot, 'bad-pkg-sym.tsx', join(workDir, 'cache'), {
      npmRoots: [{ packageRoot: pluginDir, specifiers: ['escaping-pkg'] }],
    }),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_compile_failed' && /out of bounds/.test(err.message),
  )

  // 4. Declared npm package whose package.json main escapes pkgDir via symlink or ../.
  const badMainDir = join(nmDir, 'bad-main-pkg')
  mkdirSync(badMainDir, { recursive: true })
  writeJson(join(badMainDir, 'package.json'), {
    name: 'bad-main-pkg',
    version: '1.0.0',
    type: 'module',
    main: './index.js',
  })
  symlinkSync(outsideFile, join(badMainDir, 'index.js'))
  writeFileSync(join(clientRoot, 'bad-main.tsx'), `import { secret } from 'bad-main-pkg'\nexport const out = secret\n`, 'utf8')
  await assert.rejects(
    compilePluginClientModule('test:sym-bad-main', clientRoot, 'bad-main.tsx', join(workDir, 'cache'), {
      npmRoots: [{ packageRoot: pluginDir, specifiers: ['bad-main-pkg'] }],
    }),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_compile_failed' && /cannot parse declared frontend dependency/.test(err.message),
  )
})

test('transitive dependencies: allows declared package transitive chains (multi-hop, scoped, pnpm symlink, #imports) while blocking direct undeclared imports, sibling traversal, symlink escapes, and orphan dirs', { timeout: 60_000 }, async () => {
  const outsideDir = join(workDir, 'trans-outside')
  mkdirSync(outsideDir, { recursive: true })
  const outsideSecret = join(outsideDir, 'secret.js')
  writeFileSync(outsideSecret, 'export const secret = "trans-leaked"\n', 'utf8')

  const pluginDir = join(workDir, 'trans-plugin')
  const clientRoot = join(pluginDir, 'client')
  const nmDir = join(pluginDir, 'node_modules')
  mkdirSync(clientRoot, { recursive: true })
  mkdirSync(nmDir, { recursive: true })
  // Ancestor package.json above node_modules to verify orphan dirs cannot climb past node_modules.
  writeJson(join(pluginDir, 'package.json'), { name: 'trans-plugin', version: '1.0.0', type: 'module' })

  // Valid multi-hop transitive graph: pkg-a -> pkg-b -> @scope/pkg-c (via pnpm-style symlink) + #internal + relative helper.
  const storeScopeC = join(workDir, 'store', '@scope+pkg-c@1.0.0', 'node_modules', '@scope', 'pkg-c')
  mkdirSync(storeScopeC, { recursive: true })
  writeJson(join(storeScopeC, 'package.json'), {
    name: '@scope/pkg-c',
    version: '1.0.0',
    type: 'module',
    main: './dist/esm/index.js',
  })
  mkdirSync(join(storeScopeC, 'dist', 'esm'), { recursive: true })
  mkdirSync(join(storeScopeC, 'dist', 'shared'), { recursive: true })
  // Sub-directory package.json (common in dual-format npm packages) must not clip pkg-c's root to dist/esm.
  writeJson(join(storeScopeC, 'dist', 'esm', 'package.json'), { type: 'module' })
  writeFileSync(join(storeScopeC, 'dist', 'shared', 'leaf.js'), 'export const leaf = "leaf-c"\n', 'utf8')
  writeFileSync(join(storeScopeC, 'dist', 'esm', 'index.js'), 'import { leaf } from "../shared/leaf.js"\nexport const cVal = leaf\n', 'utf8')

  mkdirSync(join(nmDir, '@scope'), { recursive: true })
  symlinkSync(storeScopeC, join(nmDir, '@scope', 'pkg-c'), 'dir')

  writeFakePkg(
    nmDir,
    'pkg-b',
    {
      'index.js': 'import { cVal } from "@scope/pkg-c"\nimport { inner } from "#inner"\nexport const bVal = inner + ":" + cVal\n',
      'internal.js': 'export const inner = "inner-b"\n',
    },
    { imports: { '#inner': './internal.js' } },
  )
  writeFakePkg(nmDir, 'pkg-a', {
    'index.js': 'import { bVal } from "pkg-b"\nimport { local } from "./helper.js"\nexport const aVal = local + ":" + bVal\n',
    'helper.js': 'export const local = "a-local"\n',
  })

  // Undeclared sibling package in node_modules.
  writeFakePkg(nmDir, 'undeclared-sibling', {
    'index.js': 'export const sib = "should-not-escape"\n',
  })

  const npmRoots = [{ packageRoot: pluginDir, specifiers: ['pkg-a'] }]

  // 1. Valid declared import with deep transitive chain succeeds and evaluates accurately.
  writeFileSync(join(clientRoot, 'valid.tsx'), `import { aVal } from 'pkg-a'\nexport const result = aVal\n`, 'utf8')
  const ok = await compilePluginClientModule('test:trans-ok', clientRoot, 'valid.tsx', join(workDir, 'cache'), { npmRoots })
  const mod = await evalBundle(ok.code)
  assert.equal(mod.result, 'a-local:inner-b:leaf-c')

  // 2. Direct import of transitive `pkg-b` from clientRoot MUST still be rejected even when `pkg-a` is also imported.
  writeFileSync(
    join(clientRoot, 'direct-trans.tsx'),
    `import { aVal } from 'pkg-a'\nimport { bVal } from 'pkg-b'\nexport const result = aVal + bVal\n`,
    'utf8',
  )
  await assert.rejects(
    compilePluginClientModule('test:trans-direct', clientRoot, 'direct-trans.tsx', join(workDir, 'cache'), { npmRoots }),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_compile_failed' && /reject bare dependency "pkg-b"/.test(err.message),
  )

  // 3. Authorized package attempting relative ../ escape into an undeclared sibling package must be rejected.
  writeFakePkg(nmDir, 'pkg-rel-escape', {
    'index.js': 'import { sib } from "../undeclared-sibling/index.js"\nexport const v = sib\n',
  })
  writeFileSync(join(clientRoot, 'rel-escape.tsx'), `import { v } from 'pkg-rel-escape'\nexport const out = v\n`, 'utf8')
  await assert.rejects(
    compilePluginClientModule('test:trans-rel-escape', clientRoot, 'rel-escape.tsx', join(workDir, 'cache'), {
      npmRoots: [{ packageRoot: pluginDir, specifiers: ['pkg-rel-escape'] }],
    }),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_compile_failed' && /out of bounds/.test(err.message),
  )

  // 4. Authorized package attempting absolute path import must be rejected.
  writeFakePkg(nmDir, 'pkg-abs-escape', {
    'index.js': `import { secret } from ${JSON.stringify(outsideSecret)}\nexport const v = secret\n`,
  })
  writeFileSync(join(clientRoot, 'abs-escape.tsx'), `import { v } from 'pkg-abs-escape'\nexport const out = v\n`, 'utf8')
  await assert.rejects(
    compilePluginClientModule('test:trans-abs-escape', clientRoot, 'abs-escape.tsx', join(workDir, 'cache'), {
      npmRoots: [{ packageRoot: pluginDir, specifiers: ['pkg-abs-escape'] }],
    }),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_compile_failed' && /unauthorized absolute/i.test(err.message),
  )

  // 5. Transitive package whose entry file is a symlink escaping outside that transitive package must be rejected.
  const badTransDir = join(nmDir, 'bad-trans-sym')
  mkdirSync(badTransDir, { recursive: true })
  writeJson(join(badTransDir, 'package.json'), { name: 'bad-trans-sym', version: '1.0.0', type: 'module', main: './index.js' })
  symlinkSync(outsideSecret, join(badTransDir, 'index.js'))
  writeFakePkg(nmDir, 'pkg-uses-bad-sym', {
    'index.js': 'import { secret } from "bad-trans-sym"\nexport const v = secret\n',
  })
  writeFileSync(join(clientRoot, 'bad-trans-sym.tsx'), `import { v } from 'pkg-uses-bad-sym'\nexport const out = v\n`, 'utf8')
  await assert.rejects(
    compilePluginClientModule('test:trans-bad-sym', clientRoot, 'bad-trans-sym.tsx', join(workDir, 'cache'), {
      npmRoots: [{ packageRoot: pluginDir, specifiers: ['pkg-uses-bad-sym'] }],
    }),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_compile_failed' && /unauthorized transitive dependency/.test(err.message),
  )

  // 6. Transitive import resolving into an orphan node_modules directory without package.json must be rejected
  //    (even though pluginDir/package.json exists right above node_modules).
  const orphanDir = join(nmDir, 'orphan-no-manifest')
  mkdirSync(orphanDir, { recursive: true })
  writeFileSync(join(orphanDir, 'index.js'), 'export const orphan = "no-pkg-json"\n', 'utf8')
  writeFakePkg(nmDir, 'pkg-uses-orphan', {
    'index.js': 'import { orphan } from "orphan-no-manifest"\nexport const v = orphan\n',
  })
  writeFileSync(join(clientRoot, 'orphan-trans.tsx'), `import { v } from 'pkg-uses-orphan'\nexport const out = v\n`, 'utf8')
  await assert.rejects(
    compilePluginClientModule('test:trans-orphan', clientRoot, 'orphan-trans.tsx', join(workDir, 'cache'), {
      npmRoots: [{ packageRoot: pluginDir, specifiers: ['pkg-uses-orphan'] }],
    }),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_compile_failed' && /unauthorized transitive dependency/.test(err.message),
  )

  // 7. Workspace/`npm link` transitive package symlink pointing outside any `node_modules` directory:
  //    permitted when the symlinked package directory owns a regular `package.json`, rejected otherwise.
  const linkedStorePkg = join(workDir, 'workspace-pkgs', 'linked-trans')
  mkdirSync(linkedStorePkg, { recursive: true })
  writeJson(join(linkedStorePkg, 'package.json'), { name: 'linked-trans', version: '1.0.0', type: 'module', main: './index.js' })
  writeFileSync(join(linkedStorePkg, 'index.js'), 'export const linkedVal = "workspace-link-ok"\n', 'utf8')
  symlinkSync(linkedStorePkg, join(nmDir, 'linked-trans'), 'dir')
  writeFakePkg(nmDir, 'pkg-uses-linked', {
    'index.js': 'import { linkedVal } from "linked-trans"\nexport const v = linkedVal\n',
  })
  writeFileSync(join(clientRoot, 'linked-trans.tsx'), `import { v } from 'pkg-uses-linked'\nexport const out = v\n`, 'utf8')
  const linkedBundle = await compilePluginClientModule('test:trans-linked-ok', clientRoot, 'linked-trans.tsx', join(workDir, 'cache'), {
    npmRoots: [{ packageRoot: pluginDir, specifiers: ['pkg-uses-linked'] }],
  })
  const linkedMod = await evalBundle(linkedBundle.code)
  assert.equal(linkedMod.out, 'workspace-link-ok')

  const linkedNoManifest = join(workDir, 'workspace-pkgs', 'linked-orphan')
  mkdirSync(linkedNoManifest, { recursive: true })
  writeFileSync(join(linkedNoManifest, 'index.js'), 'export const bad = "no-manifest"\n', 'utf8')
  symlinkSync(linkedNoManifest, join(nmDir, 'linked-orphan'), 'dir')
  writeFakePkg(nmDir, 'pkg-uses-linked-orphan', {
    'index.js': 'import { bad } from "linked-orphan"\nexport const v = bad\n',
  })
  writeFileSync(join(clientRoot, 'linked-orphan.tsx'), `import { v } from 'pkg-uses-linked-orphan'\nexport const out = v\n`, 'utf8')
  await assert.rejects(
    compilePluginClientModule('test:trans-linked-orphan', clientRoot, 'linked-orphan.tsx', join(workDir, 'cache'), {
      npmRoots: [{ packageRoot: pluginDir, specifiers: ['pkg-uses-linked-orphan'] }],
    }),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_compile_failed' && /unauthorized transitive dependency/.test(err.message),
  )

  // 8. Nested `node_modules` inside an authorized package: valid nested transitive package works,
  //    nested package cannot relative-escape into parent package, and nested orphan without package.json is rejected.
  const nestedHostDir = writeFakePkg(nmDir, 'nested-host', {
    'index.js': 'import { inner } from "nested-child"\nexport const out = inner\n',
    'secret.js': 'export const hostSecret = "parent-pkg-secret"\n',
  })
  writeFakePkg(join(nestedHostDir, 'node_modules'), 'nested-child', {
    'index.js': 'export const inner = "nested-ok"\n',
  })
  writeFileSync(join(clientRoot, 'nested-ok.tsx'), `import { out } from 'nested-host'\nexport const v = out\n`, 'utf8')
  const nestedBundle = await compilePluginClientModule('test:trans-nested-ok', clientRoot, 'nested-ok.tsx', join(workDir, 'cache'), {
    npmRoots: [{ packageRoot: pluginDir, specifiers: ['nested-host'] }],
  })
  assert.equal((await evalBundle(nestedBundle.code)).v, 'nested-ok')

  const nestedEscapeHost = writeFakePkg(nmDir, 'nested-escape-host', {
    'index.js': 'import { leaked } from "escaping-child"\nexport const out = leaked\n',
    'secret.js': 'export const hostSecret = "escaped-into-parent"\n',
  })
  writeFakePkg(join(nestedEscapeHost, 'node_modules'), 'escaping-child', {
    'index.js': 'import { hostSecret } from "../../secret.js"\nexport const leaked = hostSecret\n',
  })
  writeFileSync(join(clientRoot, 'nested-escape.tsx'), `import { out } from 'nested-escape-host'\nexport const v = out\n`, 'utf8')
  await assert.rejects(
    compilePluginClientModule('test:trans-nested-escape', clientRoot, 'nested-escape.tsx', join(workDir, 'cache'), {
      npmRoots: [{ packageRoot: pluginDir, specifiers: ['nested-escape-host'] }],
    }),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_compile_failed' && /out of bounds/.test(err.message),
  )

  const nestedOrphanHost = writeFakePkg(nmDir, 'nested-orphan-host', {
    'index.js': 'import { x } from "./node_modules/nested-orphan/index.js"\nexport const out = x\n',
  })
  mkdirSync(join(nestedOrphanHost, 'node_modules', 'nested-orphan'), { recursive: true })
  writeFileSync(join(nestedOrphanHost, 'node_modules', 'nested-orphan', 'index.js'), 'export const x = "bad"\n', 'utf8')
  writeFileSync(join(clientRoot, 'nested-orphan.tsx'), `import { out } from 'nested-orphan-host'\nexport const v = out\n`, 'utf8')
  await assert.rejects(
    compilePluginClientModule('test:trans-nested-orphan', clientRoot, 'nested-orphan.tsx', join(workDir, 'cache'), {
      npmRoots: [{ packageRoot: pluginDir, specifiers: ['nested-orphan-host'] }],
    }),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_compile_failed' && /out of bounds/.test(err.message),
  )

  // 9. tsconfig.json `paths` escape attempt from clientRoot must be rejected as an undeclared bare dependency.
  const tsClient = join(workDir, 'tsconfig-escape-client')
  mkdirSync(tsClient, { recursive: true })
  writeJson(join(tsClient, 'tsconfig.json'), {
    compilerOptions: {
      baseUrl: '.',
      paths: {
        'secret-alias': ['../trans-outside/secret.js'],
      },
    },
  })
  writeFileSync(join(tsClient, 'index.tsx'), `import { secret } from 'secret-alias'\nexport const v = secret\n`, 'utf8')
  await assert.rejects(
    compilePluginClientModule('test:tsconfig-paths-escape', tsClient, 'index.tsx', join(workDir, 'cache')),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_compile_failed' && /reject bare dependency "secret-alias"/.test(err.message),
  )
})

test('symlink-free fast-path safety: authorized package containing a relative symlink escape still rejects out of bounds', { timeout: 60_000 }, async () => {
  const outsideDir = join(workDir, 'pkg-rel-sym-outside')
  mkdirSync(outsideDir, { recursive: true })
  const outsideSecret = join(outsideDir, 'secret.js')
  writeFileSync(outsideSecret, 'export const secret = "pkg-rel-sym-leaked"\n', 'utf8')

  const pluginDir = join(workDir, 'pkg-rel-sym-plugin')
  const clientRoot = join(pluginDir, 'client')
  const nmDir = join(pluginDir, 'node_modules')
  mkdirSync(clientRoot, { recursive: true })
  mkdirSync(nmDir, { recursive: true })

  const pkgDir = writeFakePkg(nmDir, 'sym-rel-pkg', {
    'index.js': 'import { secret } from "./escaped.js"\nexport const out = secret\n',
  })
  symlinkSync(outsideSecret, join(pkgDir, 'escaped.js'))
  writeFileSync(join(clientRoot, 'index.tsx'), `import { out } from 'sym-rel-pkg'\nexport const v = out\n`, 'utf8')

  await assert.rejects(
    compilePluginClientModule('test:pkg-rel-symlink-escape', clientRoot, 'index.tsx', join(workDir, 'cache'), {
      npmRoots: [{ packageRoot: pluginDir, specifiers: ['sym-rel-pkg'] }],
    }),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_compile_failed' && /out of bounds/.test(err.message),
  )
})

test('findPackageDirOf: resolves package root across normal/scoped/pnpm/sub-package.json layouts and returns null instead of fileReal or climbing past node_modules', { timeout: 60_000 }, () => {
  const repoDir = join(workDir, 'repo')
  const nmDir = join(repoDir, 'node_modules')
  mkdirSync(nmDir, { recursive: true })
  // Ancestor workspace package.json that MUST NEVER be returned for orphan files under node_modules.
  writeJson(join(repoDir, 'package.json'), { name: 'workspace-root', private: true })

  // 1. Standard package with nested dist/esm/package.json -> resolves to package root, not dist/esm.
  const normalPkg = writeFakePkg(nmDir, 'normal-pkg', {
    'dist/esm/package.json': '{"type":"module"}\n',
    'dist/esm/index.js': 'export {}\n',
  })
  assert.equal(findPackageDirOf(join(normalPkg, 'dist', 'esm', 'index.js')), normalPkg)
  assert.equal(findPackageDirOf(join(normalPkg, 'package.json')), normalPkg)

  // 2. Scoped package.
  const scopedPkg = writeFakePkg(nmDir, '@org/scoped-pkg', {
    'lib/entry.js': 'export {}\n',
  })
  assert.equal(findPackageDirOf(join(scopedPkg, 'lib', 'entry.js')), scopedPkg)

  // 3. pnpm virtual store layout (nested node_modules/.pnpm/<ver>/node_modules/<pkg>).
  const pnpmNm = join(nmDir, '.pnpm', 'demo@1.0.0', 'node_modules')
  const pnpmPkg = writeFakePkg(pnpmNm, 'demo', { 'dist/index.mjs': 'export {}\n' })
  assert.equal(findPackageDirOf(join(pnpmPkg, 'dist', 'index.mjs')), pnpmPkg)

  // 4. Orphan dir inside node_modules without package.json -> null (must NOT climb to repoDir/package.json).
  const orphanFile = join(nmDir, 'orphan-pkg', 'index.js')
  mkdirSync(join(nmDir, 'orphan-pkg'), { recursive: true })
  writeFileSync(orphanFile, 'export {}\n', 'utf8')
  assert.equal(findPackageDirOf(orphanFile), null)

  // 5. Loose files directly in node_modules/, @scope/, or hidden .cache/ dirs -> null.
  const looseFile = join(nmDir, 'loose.js')
  writeFileSync(looseFile, 'export {}\n', 'utf8')
  assert.equal(findPackageDirOf(looseFile), null)

  const looseScopeFile = join(nmDir, '@org', 'loose.js')
  writeFileSync(looseScopeFile, 'export {}\n', 'utf8')
  assert.equal(findPackageDirOf(looseScopeFile), null)

  const hiddenDirFile = join(nmDir, '.cache', 'pkg', 'index.js')
  mkdirSync(join(nmDir, '.cache', 'pkg'), { recursive: true })
  writeJson(join(nmDir, '.cache', 'pkg', 'package.json'), { name: 'hidden' })
  writeFileSync(hiddenDirFile, 'export {}\n', 'utf8')
  assert.equal(findPackageDirOf(hiddenDirFile), null)

  // 6. Directory named `package.json` is not a valid manifest file -> null.
  const fakeManifestPkg = join(nmDir, 'dir-manifest-pkg')
  mkdirSync(join(fakeManifestPkg, 'package.json'), { recursive: true })
  const fakeManifestEntry = join(fakeManifestPkg, 'index.js')
  writeFileSync(fakeManifestEntry, 'export {}\n', 'utf8')
  assert.equal(findPackageDirOf(fakeManifestEntry), null)

  // 7. Non-node_modules path with no package.json anywhere up to filesystem root -> null (NEVER returns fileReal).
  const noPkgFile = join(workDir, 'isolated-no-pkg', 'deep', 'file.js')
  mkdirSync(join(workDir, 'isolated-no-pkg', 'deep'), { recursive: true })
  writeFileSync(noPkgFile, 'export {}\n', 'utf8')
  const found = findPackageDirOf(noPkgFile)
  assert.notEqual(found, noPkgFile, 'findPackageDirOf must never return the input file path itself')
  assert.equal(found, null)
})
