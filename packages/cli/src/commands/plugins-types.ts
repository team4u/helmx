/**
 * Local offline SDK type snapshot sync (`helmx plugins types [dir]`):
 * writes `.helmx/types/` declarations (`@helmx/protocol`, `@helmx/protocol/browser`,
 * `@helmx/plugin-client`, plus minimal standalone shims) into an external plugin directory
 * without contacting Hub and without destructively modifying existing `tsconfig.json`.
 */
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { CliError } from '../errors.js'
import { HELMX_SDK_TSCONFIG_PATHS } from './scaffold-templates.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { assertNoExtraPositionals, printResult } from './shared.js'

export const SDK_TYPES_SUBDIR = '.helmx/types'

export interface SdkTypesBundle {
  readonly formatVersion: number
  readonly sdkVersion: string
  readonly files: Readonly<Record<string, string>>
}

export type TsconfigTypesStatus = 'configured' | 'missing' | 'needs_paths' | 'unreadable'

export interface SyncPluginTypesResult {
  readonly dir: string
  readonly typesDir: string
  readonly sdkVersion: string
  readonly filesWritten: number
  readonly files: readonly string[]
  readonly tsconfigPath: string
  readonly tsconfigStatus: TsconfigTypesStatus
  readonly recommendedCompilerOptions: {
    readonly baseUrl: '.'
    readonly paths: Readonly<Record<string, readonly string[]>>
  }
}

let cachedBundle: SdkTypesBundle | undefined

function isSafeRelativePosixPath(rel: string): boolean {
  if (rel.length === 0 || rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return false
  const segments = rel.split('/')
  return segments.every((seg) => seg.length > 0 && seg !== '.' && seg !== '..')
}

function validateSdkTypesBundle(raw: unknown): SdkTypesBundle {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError('embedded SDK types bundle is corrupt (expected object)', 'sdk_types_corrupt')
  }
  const obj = raw as Record<string, unknown>
  if (obj['formatVersion'] !== 1 || typeof obj['sdkVersion'] !== 'string') {
    throw new CliError('embedded SDK types bundle has unsupported format or version', 'sdk_types_corrupt')
  }
  const filesRaw = obj['files']
  if (filesRaw === null || typeof filesRaw !== 'object' || Array.isArray(filesRaw)) {
    throw new CliError('embedded SDK types bundle is missing files map', 'sdk_types_corrupt')
  }
  const files: Record<string, string> = {}
  const entries = Object.entries(filesRaw as Record<string, unknown>)
  for (const [rel, content] of entries) {
    if (!isSafeRelativePosixPath(rel) || typeof content !== 'string') {
      throw new CliError(`embedded SDK types bundle contains invalid entry: ${rel}`, 'sdk_types_corrupt')
    }
    files[rel] = content
  }
  for (const required of ['protocol/index.d.ts', 'protocol/browser.d.ts', 'plugin-client/index.d.ts']) {
    if (!(required in files)) {
      throw new CliError(`embedded SDK types bundle is missing required declaration: ${required}`, 'sdk_types_corrupt')
    }
  }
  return {
    formatVersion: 1,
    sdkVersion: obj['sdkVersion'],
    files,
  }
}

/**
 * Load the SDK declaration bundle.
 * - Built/bundled CLI: decodes the statically inlined `EMBEDDED_SDK_TYPES_PAYLOAD` via `node:zlib`
 *   (zero filesystem or `node_modules` lookup).
 * - Source-execution mode (`tsx` during workspace dev/unit tests when `dist/` is not loaded):
 *   invokes the monorepo generator script through a computed dynamic URL so esbuild never pulls
 *   `typescript` into the single-file CLI artifact.
 */
export async function loadSdkTypesBundle(): Promise<SdkTypesBundle> {
  if (cachedBundle !== undefined) return cachedBundle

  const { EMBEDDED_SDK_TYPES_PAYLOAD } = await import('../sdk-types-snapshot.js')
  if (typeof EMBEDDED_SDK_TYPES_PAYLOAD === 'string' && EMBEDDED_SDK_TYPES_PAYLOAD.length > 0) {
    try {
      const jsonText = inflateRawSync(Buffer.from(EMBEDDED_SDK_TYPES_PAYLOAD, 'base64')).toString('utf8')
      cachedBundle = validateSdkTypesBundle(JSON.parse(jsonText))
      return cachedBundle
    } catch (err) {
      if (err instanceof CliError) throw err
      throw new CliError(
        `failed to decode embedded SDK types snapshot: ${err instanceof Error ? err.message : String(err)}`,
        'sdk_types_corrupt',
      )
    }
  }

  // Computed specifier keeps esbuild from statically bundling the build-time generator or `typescript`.
  const generatorRel = ['..', '..', 'scripts', 'generate-sdk-types.mjs'].join('/')
  const generatorUrl = new URL(generatorRel, import.meta.url).href
  try {
    const mod = (await import(generatorUrl)) as { buildSdkTypesBundle?: () => unknown }
    if (typeof mod.buildSdkTypesBundle !== 'function') {
      throw new CliError('workspace SDK types generator does not export buildSdkTypesBundle', 'sdk_types_unavailable')
    }
    cachedBundle = validateSdkTypesBundle(mod.buildSdkTypesBundle())
    return cachedBundle
  } catch (err) {
    if (err instanceof CliError) throw err
    throw new CliError(
      `SDK types snapshot unavailable (${err instanceof Error ? err.message : String(err)})`,
      'sdk_types_unavailable',
    )
  }
}

function isOutsideDir(base: string, target: string): boolean {
  const rel = path.relative(base, target)
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
}

/** Guard `.helmx` and `.helmx/types` against symlink escapes or non-directory collisions. */
async function assertSafeManagedSubdir(dirReal: string, subPath: string, label: string): Promise<void> {
  try {
    const st = await fsp.lstat(subPath)
    if (st.isSymbolicLink()) {
      throw new CliError(`refusing to write through symlink at ${label}: ${subPath}`, 'invalid_target_dir')
    }
    if (!st.isDirectory()) {
      throw new CliError(`expected directory at ${label}, found non-directory: ${subPath}`, 'invalid_target_dir')
    }
    const real = await fsp.realpath(subPath)
    if (isOutsideDir(dirReal, real)) {
      throw new CliError(`${label} resolves outside target directory: ${subPath}`, 'invalid_target_dir')
    }
  } catch (err) {
    if (err instanceof CliError) throw err
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new CliError(
        `failed to inspect ${label} (${subPath}): ${err instanceof Error ? err.message : String(err)}`,
        'read_failed',
      )
    }
  }
}

function normalizeTsconfigTarget(p: string): string {
  const normalized = p.replace(/\\/g, '/')
  return normalized.startsWith('./') ? normalized.slice(2) : normalized
}

async function inspectTsconfigStatus(pluginDir: string): Promise<TsconfigTypesStatus> {
  const tsconfigPath = path.join(pluginDir, 'tsconfig.json')
  let text: string
  try {
    text = await fsp.readFile(tsconfigPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    return 'unreadable'
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return 'unreadable'
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable'
  const compilerOptions = (parsed as Record<string, unknown>)['compilerOptions']
  if (compilerOptions === null || typeof compilerOptions !== 'object' || Array.isArray(compilerOptions)) {
    return 'needs_paths'
  }
  const paths = (compilerOptions as Record<string, unknown>)['paths']
  if (paths === null || typeof paths !== 'object' || Array.isArray(paths)) return 'needs_paths'

  const requiredMappings: ReadonlyArray<readonly [string, string]> = [
    ['@helmx/protocol', '.helmx/types/protocol/index.d.ts'],
    ['@helmx/protocol/browser', '.helmx/types/protocol/browser.d.ts'],
    ['@helmx/plugin-client', '.helmx/types/plugin-client/index.d.ts'],
  ]
  const pathsMap = paths as Record<string, unknown>
  for (const [specifier, expectedTarget] of requiredMappings) {
    const entries = pathsMap[specifier]
    if (!Array.isArray(entries)) return 'needs_paths'
    const matched = entries.some((item) => typeof item === 'string' && normalizeTsconfigTarget(item) === expectedTarget)
    if (!matched) return 'needs_paths'
  }
  return 'configured'
}

async function renameWithWindowsRetry(src: string, dest: string): Promise<void> {
  const maxAttempts = process.platform === 'win32' ? 5 : 1
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsp.rename(src, dest)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (!retryable || attempt >= maxAttempts) throw err
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
  }
}

/**
 * Write or refresh `.helmx/types/` inside `pluginDir` from the embedded SDK declaration bundle.
 * Never modifies existing `tsconfig.json`; inspects it read-only and reports status + snippet.
 */
export async function writeSdkTypesToDir(pluginDir: string): Promise<SyncPluginTypesResult> {
  const resolvedDir = path.resolve(pluginDir)
  let dirStat
  try {
    dirStat = await fsp.stat(resolvedDir)
  } catch (err) {
    throw new CliError(
      `target directory not accessible (${resolvedDir}): ${err instanceof Error ? err.message : String(err)}`,
      'invalid_target_dir',
    )
  }
  if (!dirStat.isDirectory()) {
    throw new CliError(`target path is not a directory: ${resolvedDir}`, 'invalid_target_dir')
  }
  const dirReal = await fsp.realpath(resolvedDir)

  const helmxDir = path.join(resolvedDir, '.helmx')
  const typesDir = path.join(helmxDir, 'types')
  await assertSafeManagedSubdir(dirReal, helmxDir, '.helmx')
  await assertSafeManagedSubdir(dirReal, typesDir, SDK_TYPES_SUBDIR)

  const bundle = await loadSdkTypesBundle()
  const sortedRelPaths = Object.keys(bundle.files).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  await fsp.mkdir(helmxDir, { recursive: true })
  const stagingDir = path.join(helmxDir, `.types-staging-${process.pid}-${randomUUID().slice(0, 8)}`)
  await fsp.mkdir(stagingDir, { recursive: true })
  try {
    const createdDirs = new Set<string>([stagingDir])
    for (const rel of sortedRelPaths) {
      const dest = path.join(stagingDir, ...rel.split('/'))
      const parent = path.dirname(dest)
      if (!createdDirs.has(parent)) {
        await fsp.mkdir(parent, { recursive: true })
        createdDirs.add(parent)
      }
      await fsp.writeFile(dest, bundle.files[rel]!, 'utf8')
    }
    await fsp.rm(typesDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    await renameWithWindowsRetry(stagingDir, typesDir)
  } catch (err) {
    await fsp.rm(stagingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {})
    if (err instanceof CliError) throw err
    throw new CliError(
      `failed to write SDK types into ${typesDir}: ${err instanceof Error ? err.message : String(err)}`,
      'write_failed',
    )
  }

  const tsconfigPath = path.join(resolvedDir, 'tsconfig.json')
  const tsconfigStatus = await inspectTsconfigStatus(resolvedDir)

  return {
    dir: resolvedDir,
    typesDir,
    sdkVersion: bundle.sdkVersion,
    filesWritten: sortedRelPaths.length,
    files: sortedRelPaths,
    tsconfigPath,
    tsconfigStatus,
    recommendedCompilerOptions: {
      baseUrl: '.',
      paths: HELMX_SDK_TSCONFIG_PATHS,
    },
  }
}

async function runPluginsTypes(ctx: CommandContext): Promise<void> {
  const dirFlag = ctx.flags.get('dir')
  const positionalDir = ctx.positionals[0]
  if (typeof dirFlag === 'string' && dirFlag.length > 0 && positionalDir !== undefined) {
    throw new CliError('--dir and positional <dir> are mutually exclusive', 'conflicting_flags')
  }
  assertNoExtraPositionals(ctx.positionals, positionalDir !== undefined ? 1 : 0)

  const rawDir =
    typeof dirFlag === 'string' && dirFlag.length > 0
      ? dirFlag
      : positionalDir ?? ctx.cwd
  const targetDir = path.resolve(ctx.cwd, rawDir)

  const result = await writeSdkTypesToDir(targetDir)
  if (ctx.json) {
    printResult(ctx, result)
    return
  }

  ctx.io.out(
    `Synced Helmx SDK types (v${result.sdkVersion}, ${result.filesWritten} file(s)) -> ${result.typesDir}\n`,
  )
  ctx.io.out('  - @helmx/protocol -> ./.helmx/types/protocol/index.d.ts\n')
  ctx.io.out('  - @helmx/protocol/browser -> ./.helmx/types/protocol/browser.d.ts\n')
  ctx.io.out('  - @helmx/plugin-client -> ./.helmx/types/plugin-client/index.d.ts\n')
  if (result.tsconfigStatus === 'configured') {
    ctx.io.out('tsconfig.json already configures Helmx SDK paths.\n')
  } else {
    const snippet = JSON.stringify({ compilerOptions: result.recommendedCompilerOptions }, null, 2)
    ctx.io.out(
      `tsconfig.json was not modified (status: ${result.tsconfigStatus}). Add to tsconfig.json if needed:\n${snippet}\n`,
    )
  }
}

export const pluginsTypesCommand: CommandSpec = {
  path: ['plugins', 'types'],
  description:
    'Local types: write or refresh offline .helmx/types/ TypeScript declarations (@helmx/protocol, @helmx/plugin-client, and standalone shims) without contacting Hub',
  flags: [
    { name: 'dir', type: 'string', help: 'target plugin directory (defaults to current working directory)' },
  ],
  positional: '[dir]',
  run: runPluginsTypes,
}
