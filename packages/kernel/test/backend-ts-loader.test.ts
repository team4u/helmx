/**
 * Security boundary tests for backend-ts-loader (`registerPluginTsRoot` & `PUBLIC_BACKEND_HELMX_PACKAGES`):
 * - Explicit `@helmx/*` public allowlist: only `@helmx/protocol` and `@helmx/protocol/browser` resolve
 *   from the host (preserving exact singleton identity such as `HelmxError`, including across `?helmxgen`
 *   hot-reload generations);
 * - Private `@helmx/*` packages (`@helmx/kernel`, `@helmx/env-io`, `@helmx/env-io/hub-payload`,
 *   `@helmx/hub`, `@helmx/plugins`, `@helmx/plugins/contracts`, `@helmx/plugin-build`,
 *   `@helmx/plugin-client`, `@helmx/node`, plus query/subpath bypasses like `@helmx/protocol?bypass=1`
 *   and `@helmx/protocol/internal`) are explicitly rejected with `plugin_load_failed` — statically,
 *   dynamically, from `.mjs` files, and even when a local `node_modules/@helmx/*` exists inside the plugin;
 * - Host modules outside registered plugin roots remain completely unaffected;
 * - Relative symlink escapes (both `.js -> .ts` and explicit `.ts` symlinks), direct `load()` symlink
 *   escapes, and cross-plugin-root relative escapes between simultaneously registered roots are rejected
 *   with zero execution of external target files.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HelmxError as HostHelmxError } from '@helmx/protocol'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import {
  PUBLIC_BACKEND_HELMX_PACKAGES,
  registerPluginTsRoot,
} from '../src/plugins/backend-ts-loader.js'
import { useTempDir } from './helpers.js'

const loaderUrl = pathToFileURL(fileURLToPath(new URL('../src/plugins/backend-ts-loader.ts', import.meta.url))).href
const protocolUrl = import.meta.resolve('@helmx/protocol')
const providerUrl = import.meta.resolve('@helmx/plugin-build')

function runNodeChild(workDir: string, scriptName: string, scriptBody: string): string {
  const childPath = join(workDir, scriptName)
  writeFileSync(childPath, scriptBody, 'utf8')
  try {
    return execFileSync(process.execPath, [childPath], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout ?? ''
    const stderr = (err as { stderr?: string }).stderr ?? ''
    assert.fail(`pure Node child ${scriptName} failed:\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
  }
}

test('PUBLIC_BACKEND_HELMX_PACKAGES exposes only public protocol entrypoints and excludes private host packages', { timeout: 60_000 }, () => {
  assert.deepEqual([...PUBLIC_BACKEND_HELMX_PACKAGES].sort(), ['@helmx/protocol', '@helmx/protocol/browser'])
  for (const denied of [
    '@helmx/kernel',
    '@helmx/env-io',
    '@helmx/env-io/hub-payload',
    '@helmx/hub',
    '@helmx/plugins',
    '@helmx/plugins/contracts',
    '@helmx/plugin-build',
    '@helmx/plugin-client',
    '@helmx/node',
    '@helmx/cli',
    '@helmx/web',
  ]) {
    assert.equal(PUBLIC_BACKEND_HELMX_PACKAGES.has(denied), false, `${denied} must not be allowlisted`)
  }
})

test('backend-ts-loader: allows public @helmx/protocol singletons and rejects private @helmx/* packages (pure Node subprocess)', { timeout: 60_000 }, (t) => {
  const workDir = useTempDir(t, 'helmx-ts-loader-allowlist-')
  const pluginDir = join(workDir, 'ext-plugin')
  mkdirSync(pluginDir, { recursive: true })

  // Plant a local node_modules/@helmx/kernel inside the plugin to prove private @helmx/* imports
  // fail explicitly and NEVER fall through to plugin-local node_modules.
  const fakeKernelDir = join(pluginDir, 'node_modules', '@helmx', 'kernel')
  mkdirSync(fakeKernelDir, { recursive: true })
  writeFileSync(
    join(fakeKernelDir, 'package.json'),
    JSON.stringify({ name: '@helmx/kernel', version: '0.0.0', type: 'module', main: './index.js' }),
    'utf8',
  )
  writeFileSync(join(fakeKernelDir, 'index.js'), 'globalThis.__fakeKernelExecuted = true\nexport const leaked = 1\n', 'utf8')

  writeFileSync(
    join(pluginDir, 'public-ok.ts'),
    [
      "import { HelmxError } from '@helmx/protocol'",
      "import { HelmxError as BrowserHelmxError, isAbsoluteTargetPath } from '@helmx/protocol/browser'",
      'export const errorCtor = HelmxError',
      'export const browserErrorCtor = BrowserHelmxError',
      'export const errInstance = new HelmxError("probe", "probe")',
      'export const absCheck = isAbsoluteTargetPath("/workspace")',
      'export const dynImport = (spec: string) => import(spec)',
    ].join('\n') + '\n',
    'utf8',
  )

  const deniedSpecifiers = [
    '@helmx/kernel',
    '@helmx/env-io',
    '@helmx/env-io/hub-payload',
    '@helmx/hub',
    '@helmx/plugins',
    '@helmx/plugins/contracts',
    '@helmx/plugin-build',
    '@helmx/plugin-client',
    '@helmx/node',
    '@helmx/protocol/internal',
    '@helmx/protocol?bypass=1',
  ]
  for (let i = 0; i < deniedSpecifiers.length; i += 1) {
    const spec = deniedSpecifiers[i]!
    writeFileSync(
      join(pluginDir, `denied-${i}.ts`),
      `import * as m from ${JSON.stringify(spec)}\nexport const loaded = m\n`,
      'utf8',
    )
  }
  // Non-TS .mjs file inside the registered plugin root must also be blocked from importing private @helmx/* packages.
  writeFileSync(
    join(pluginDir, 'denied-mjs.mjs'),
    `import * as envIo from '@helmx/env-io'\nexport const loaded = envIo\n`,
    'utf8',
  )
  // CJS createRequire inside the plugin root must also be blocked from loading private @helmx/* packages.
  writeFileSync(
    join(pluginDir, 'denied-require.ts'),
    `import { createRequire } from 'node:module'\nconst req = createRequire(import.meta.url)\nexport const loaded = req('@helmx/kernel')\n`,
    'utf8',
  )

  const out = runNodeChild(
    workDir,
    'verify-allowlist.mjs',
    `
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
const { HelmxError: HostHelmxError } = await import(${JSON.stringify(protocolUrl)})
const { registerPluginTsRoot, nextPluginGeneration } = await import(${JSON.stringify(loaderUrl)})
const { createPluginBuildProvider } = await import(${JSON.stringify(providerUrl)})

const pluginDir = ${JSON.stringify(pluginDir)}
const deniedSpecifiers = ${JSON.stringify(deniedSpecifiers)}
const release = registerPluginTsRoot(pluginDir, { transform: createPluginBuildProvider().transformBackendTs })

try {
  // 1. Public @helmx/protocol & @helmx/protocol/browser resolve to the exact host singleton.
  const okUrl = pathToFileURL(join(pluginDir, 'public-ok.ts')).href
  const mod1 = await import(okUrl)
  if (mod1.errorCtor !== HostHelmxError) throw new Error('HelmxError singleton identity broken')
  if (mod1.browserErrorCtor !== HostHelmxError) throw new Error('@helmx/protocol/browser HelmxError singleton broken')
  if (!(mod1.errInstance instanceof HostHelmxError)) throw new Error('instanceof HostHelmxError failed')
  if (mod1.absCheck !== true) throw new Error('isAbsoluteTargetPath failed')

  // 2. Singleton identity survives generation hot-reload (?helmxgen=N).
  const gen = nextPluginGeneration(pluginDir)
  const mod2 = await import(okUrl + '?helmxgen=' + gen)
  if (mod2.errorCtor !== HostHelmxError) throw new Error('HelmxError singleton broken across generation reload')

  // 3. Static imports of every private @helmx/* specifier fail with plugin_load_failed.
  for (let i = 0; i < deniedSpecifiers.length; i += 1) {
    const spec = deniedSpecifiers[i]
    let failed = false
    try {
      await import(pathToFileURL(join(pluginDir, 'denied-' + i + '.ts')).href)
    } catch (err) {
      if (err?.code !== 'plugin_load_failed' || !String(err.message).includes('private host package')) {
        throw new Error('unexpected error for static ' + spec + ': ' + String(err?.code) + ' ' + String(err?.message))
      }
      failed = true
    }
    if (!failed) throw new Error('static import unexpectedly succeeded for ' + spec)
  }

  // 4. Dynamic import() inside plugin code is also blocked for private @helmx/* packages.
  for (const spec of ['@helmx/kernel', '@helmx/env-io', '@helmx/plugin-build']) {
    let failed = false
    try {
      await mod1.dynImport(spec)
    } catch (err) {
      if (err?.code !== 'plugin_load_failed') {
        throw new Error('unexpected error for dynamic ' + spec + ': ' + String(err?.code) + ' ' + String(err?.message))
      }
      failed = true
    }
    if (!failed) throw new Error('dynamic import unexpectedly succeeded for ' + spec)
  }

  // 5. Non-TS .mjs file and CJS createRequire inside the plugin root are also blocked.
  for (const extraFile of ['denied-mjs.mjs', 'denied-require.ts']) {
    let blocked = false
    try {
      await import(pathToFileURL(join(pluginDir, extraFile)).href)
    } catch (err) {
      if (err?.code !== 'plugin_load_failed') {
        throw new Error('unexpected error for ' + extraFile + ': ' + String(err?.code) + ' ' + String(err?.message))
      }
      blocked = true
    }
    if (!blocked) throw new Error(extraFile + ' private @helmx/* import unexpectedly succeeded')
  }

  // 6. Local node_modules/@helmx/kernel must never have executed via fallback.
  if (globalThis.__fakeKernelExecuted !== undefined) {
    throw new Error('local node_modules/@helmx/kernel executed via fallback')
  }

  // 7. Host code outside registered plugin roots can still freely import @helmx/plugin-build.
  const hostBuild = await import(${JSON.stringify(providerUrl)})
  if (typeof hostBuild.createPluginBuildProvider !== 'function') {
    throw new Error('host import outside plugin root was disrupted')
  }
} finally {
  release()
}
console.log('ALLOWLIST_CHILD_OK')
`,
  )
  assert.ok(out.includes('ALLOWLIST_CHILD_OK'), `unexpected child output: ${out}`)
})

test('backend-ts-loader: in-process plugin root preserves host HelmxError singleton and rejects private @helmx/kernel & @helmx/env-io', { timeout: 60_000 }, async (t) => {
  const workDir = useTempDir(t, 'helmx-ts-loader-inproc-')
  const pluginDir = join(workDir, 'inproc-plugin')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(
    join(pluginDir, 'ok.ts'),
    `import { HelmxError } from '@helmx/protocol'\nexport const ctor = HelmxError\nexport const instance = new HelmxError('ok', 'ok')\n`,
    'utf8',
  )
  writeFileSync(join(pluginDir, 'bad-kernel.ts'), `import '@helmx/kernel'\nexport const x = 1\n`, 'utf8')
  writeFileSync(join(pluginDir, 'bad-envio.ts'), `import '@helmx/env-io'\nexport const x = 1\n`, 'utf8')

  const release = registerPluginTsRoot(pluginDir, {
    transform: createPluginBuildProvider().transformBackendTs,
  })
  try {
    const okMod = (await import(pathToFileURL(join(pluginDir, 'ok.ts')).href)) as {
      ctor: typeof HostHelmxError
      instance: unknown
    }
    assert.equal(okMod.ctor, HostHelmxError)
    assert.ok(okMod.instance instanceof HostHelmxError)

    for (const file of ['bad-kernel.ts', 'bad-envio.ts']) {
      await assert.rejects(
        import(pathToFileURL(join(pluginDir, file)).href),
        (err: unknown) =>
          err instanceof HostHelmxError &&
          err.code === 'plugin_load_failed' &&
          err.message.includes('private host package'),
        `${file} must reject private @helmx/* import`,
      )
    }
  } finally {
    release()
  }
})

test('backend-ts-loader: rejects explicit .ts symlink escapes, direct load symlink escapes, and cross-plugin-root relative escapes (pure Node subprocess)', { timeout: 60_000 }, (t) => {
  const workDir = useTempDir(t, 'helmx-ts-loader-escapes-')
  const outsideDir = join(workDir, 'outside')
  const pluginA = join(workDir, 'plugin-a')
  const pluginB = join(workDir, 'plugin-b')
  mkdirSync(outsideDir, { recursive: true })
  mkdirSync(pluginA, { recursive: true })
  mkdirSync(pluginB, { recursive: true })

  const outsideTs = join(outsideDir, 'evil.ts')
  writeFileSync(outsideTs, 'globalThis.__evilOutsideExecuted = true\nexport const evil = 1\n', 'utf8')

  // 1. Explicit `.ts` symlink inside plugin-a pointing outside all roots (static, .js-mapped, and file: URL dynamic import).
  symlinkSync(outsideTs, join(pluginA, 'sym-out.ts'))
  writeFileSync(join(pluginA, 'import-sym-ts.ts'), `import { evil } from './sym-out.ts'\nexport const v = evil\n`, 'utf8')
  writeFileSync(join(pluginA, 'import-sym-js.ts'), `import { evil } from './sym-out.js'\nexport const v = evil\n`, 'utf8')
  writeFileSync(
    join(pluginA, 'import-sym-file-url.ts'),
    `const m = await import(new URL('./sym-out.ts', import.meta.url).href)\nexport const v = m.evil\n`,
    'utf8',
  )

  // 2. Sibling plugin-b secret TS file (also registered as its own plugin root) & absolute TS path imports.
  const pluginBSecret = join(pluginB, 'secret.ts')
  writeFileSync(pluginBSecret, 'globalThis.__crossRootExecuted = true\nexport const secret = 2\n', 'utf8')
  const crossSpecTs = relative(pluginA, pluginBSecret).split(sep).join('/')
  const crossSpecJs = crossSpecTs.replace(/\.ts$/, '.js')
  writeFileSync(join(pluginA, 'cross-root-ts.ts'), `import { secret } from ${JSON.stringify(crossSpecTs)}\nexport const v = secret\n`, 'utf8')
  writeFileSync(join(pluginA, 'cross-root-js.ts'), `import { secret } from ${JSON.stringify(crossSpecJs)}\nexport const v = secret\n`, 'utf8')
  writeFileSync(join(pluginA, 'abs-outside-ts.ts'), `import { evil } from ${JSON.stringify(outsideTs)}\nexport const v = evil\n`, 'utf8')
  writeFileSync(join(pluginA, 'abs-cross-root-ts.ts'), `import { secret } from ${JSON.stringify(pluginBSecret)}\nexport const v = secret\n`, 'utf8')

  const out = runNodeChild(
    workDir,
    'verify-escapes.mjs',
    `
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
const { registerPluginTsRoot } = await import(${JSON.stringify(loaderUrl)})
const { createPluginBuildProvider } = await import(${JSON.stringify(providerUrl)})

const pluginA = ${JSON.stringify(pluginA)}
const pluginB = ${JSON.stringify(pluginB)}
const transform = createPluginBuildProvider().transformBackendTs
const releaseA = registerPluginTsRoot(pluginA, { transform })
const releaseB = registerPluginTsRoot(pluginB, { transform })

try {
  for (const file of ['import-sym-ts.ts', 'import-sym-js.ts', 'import-sym-file-url.ts', 'sym-out.ts', 'cross-root-ts.ts', 'cross-root-js.ts', 'abs-outside-ts.ts', 'abs-cross-root-ts.ts']) {
    let rejected = false
    try {
      await import(pathToFileURL(join(pluginA, file)).href)
    } catch (err) {
      if (err?.code !== 'plugin_load_failed') {
        throw new Error('unexpected error for ' + file + ': ' + String(err?.code) + ' ' + String(err?.message))
      }
      rejected = true
    }
    if (!rejected) throw new Error(file + ' unexpectedly succeeded')
  }

  if (globalThis.__evilOutsideExecuted !== undefined) {
    throw new Error('external evil.ts executed despite containment')
  }
  if (globalThis.__crossRootExecuted !== undefined) {
    throw new Error('cross-plugin-root secret.ts executed despite owning-root containment')
  }
} finally {
  releaseB()
  releaseA()
}
console.log('ESCAPES_CHILD_OK')
`,
  )
  assert.ok(out.includes('ESCAPES_CHILD_OK'), `unexpected child output: ${out}`)
})
