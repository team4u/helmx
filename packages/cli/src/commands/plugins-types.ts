/**
 * Local offline SDK type snapshot sync (`helmx plugins types [dir]`):
 * writes `.helmx/types/` declarations (`@helmx/protocol`, `@helmx/protocol/browser`,
 * `@helmx/plugin-client`, plus minimal standalone shims) into an external plugin directory
 * without contacting Hub and without destructively modifying existing `tsconfig.json`.
 */
import { randomUUID } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { CliError } from '../errors.js'
import { HELMX_SDK_TSCONFIG_PATHS } from './scaffold-templates.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { assertNoExtraPositionals, isOutsideDir, printResult } from './shared.js'

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

function isNotFoundErrno(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

function isModuleNotFoundErrno(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ERR_MODULE_NOT_FOUND'
}

async function removeDirIfPresent(dirPath: string): Promise<void> {
  try {
    await fsp.rm(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch (err) {
    if (isNotFoundErrno(err)) return
    throw err
  }
}

function maxTsMtimeMs(dirPath: string): number {
  let max = 0
  let entries
  try {
    entries = readdirSync(dirPath, { withFileTypes: true })
  } catch (err) {
    if (isNotFoundErrno(err)) return Number.POSITIVE_INFINITY
    throw new CliError(
      `failed to scan SDK source directory (${dirPath}): ${err instanceof Error ? err.message : String(err)}`,
      'read_failed',
    )
  }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === 'dist') continue
    const full = path.join(dirPath, ent.name)
    if (ent.isDirectory()) {
      const sub = maxTsMtimeMs(full)
      if (sub > max) max = sub
    } else if (ent.isFile() && /\.(?:ts|tsx)$/.test(ent.name)) {
      try {
        const m = statSync(full).mtimeMs
        if (m > max) max = m
      } catch (err) {
        if (isNotFoundErrno(err)) return Number.POSITIVE_INFINITY
        throw new CliError(
          `failed to stat SDK source file (${full}): ${err instanceof Error ? err.message : String(err)}`,
          'read_failed',
        )
      }
    }
  }
  return max
}

async function tryLoadFreshDistSnapshot(): Promise<SdkTypesBundle | undefined> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const distRel = ['..', '..', 'dist', 'sdk-types-snapshot.js'].join('/')
  const distPath = path.resolve(here, distRel)
  if (distPath === path.resolve(here, '../sdk-types-snapshot.js')) return undefined
  let distMtimeMs: number
  try {
    distMtimeMs = statSync(distPath).mtimeMs
  } catch (err) {
    if (isNotFoundErrno(err)) return undefined
    throw new CliError(
      `failed to inspect built SDK types snapshot (${distPath}): ${err instanceof Error ? err.message : String(err)}`,
      'sdk_types_unavailable',
    )
  }
  const pkgRoot = path.resolve(here, '../..')
  const packagesRoot = path.resolve(pkgRoot, '..')
  const sourcesFresh =
    maxTsMtimeMs(path.join(packagesRoot, 'protocol', 'src')) <= distMtimeMs &&
    maxTsMtimeMs(path.join(packagesRoot, 'plugin-client', 'src')) <= distMtimeMs
  if (!sourcesFresh) return undefined
  for (const rel of [
    'scripts/generate-sdk-types.mjs',
    'package.json',
    '../protocol/package.json',
    '../plugin-client/package.json',
  ]) {
    const depPath = path.resolve(pkgRoot, rel)
    try {
      if (statSync(depPath).mtimeMs > distMtimeMs) return undefined
    } catch (err) {
      if (isNotFoundErrno(err)) return undefined
      throw new CliError(
        `failed to inspect workspace manifest (${depPath}): ${err instanceof Error ? err.message : String(err)}`,
        'sdk_types_unavailable',
      )
    }
  }
  try {
    const mod = (await import(pathToFileURL(distPath).href)) as { EMBEDDED_SDK_TYPES_PAYLOAD?: unknown }
    if (typeof mod.EMBEDDED_SDK_TYPES_PAYLOAD === 'string' && mod.EMBEDDED_SDK_TYPES_PAYLOAD.length > 0) {
      const jsonText = inflateRawSync(Buffer.from(mod.EMBEDDED_SDK_TYPES_PAYLOAD, 'base64')).toString('utf8')
      return validateSdkTypesBundle(JSON.parse(jsonText))
    }
  } catch (err) {
    if (err instanceof CliError) throw err
    if (!isModuleNotFoundErrno(err)) {
      throw new CliError(
        `built SDK types snapshot (${distPath}) is unreadable or corrupt: ${err instanceof Error ? err.message : String(err)}`,
        'sdk_types_corrupt',
      )
    }
  }
  return undefined
}

/**
 * Load the SDK declaration bundle.
 * - Built/bundled CLI: decodes the statically inlined `EMBEDDED_SDK_TYPES_PAYLOAD` via `node:zlib`
 *   (zero filesystem or `node_modules` lookup).
 * - Source-execution mode (`tsx` during workspace dev/unit tests when `dist/` is not loaded):
 *   reuses a fresh built `packages/cli/dist/sdk-types-snapshot.js` when up-to-date, otherwise
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

  const freshDist = await tryLoadFreshDistSnapshot()
  if (freshDist !== undefined) {
    cachedBundle = freshDist
    return cachedBundle
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

function stripJsonCommentsAndTrailingCommas(text: string): string {
  // Phase 1: strip // and /* */ comments while preserving string literals untouched.
  let withoutComments = ''
  let i = 0
  let inString = false
  let escaped = false
  while (i < text.length) {
    const ch = text[i]!
    if (inString) {
      withoutComments += ch
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      withoutComments += ch
      i += 1
      continue
    }
    const next = text[i + 1]
    if (ch === '/' && next === '/') {
      i += 2
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      const closeIdx = text.indexOf('*/', i + 2)
      if (closeIdx === -1) return text
      i = closeIdx + 2
      continue
    }
    withoutComments += ch
    i += 1
  }

  // Phase 2: drop commas immediately followed by '}' or ']' (outside strings).
  let out = ''
  inString = false
  escaped = false
  for (let idx = 0; idx < withoutComments.length; idx += 1) {
    const ch = withoutComments[idx]!
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ',') {
      let look = idx + 1
      while (look < withoutComments.length && /\s/.test(withoutComments[look]!)) look += 1
      if (withoutComments[look] === '}' || withoutComments[look] === ']') {
        continue
      }
    }
    out += ch
  }
  return out
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
    if (!isNotFoundErrno(err)) {
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
    if (isNotFoundErrno(err)) return 'missing'
    return 'unreadable'
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(text))
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

  const pathsMap = paths as Record<string, unknown>
  for (const [specifier, targets] of Object.entries(HELMX_SDK_TSCONFIG_PATHS)) {
    const entries = pathsMap[specifier]
    if (!Array.isArray(entries)) return 'needs_paths'
    const expectedTargets = new Set(targets.map(normalizeTsconfigTarget))
    const matched = entries.some((item) => typeof item === 'string' && expectedTargets.has(normalizeTsconfigTarget(item)))
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
export async function writeSdkTypesToDir(
  pluginDir: string,
  ops?: { rename?: (src: string, dest: string) => Promise<void> },
): Promise<SyncPluginTypesResult> {
  const doRename = ops?.rename ?? renameWithWindowsRetry
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
  const runSuffix = `${process.pid}-${randomUUID().slice(0, 8)}`
  const stagingDir = path.join(helmxDir, `.types-staging-${runSuffix}`)
  const backupDir = path.join(helmxDir, `.types-backup-${runSuffix}`)
  await fsp.mkdir(stagingDir, { recursive: true })
  let backedUp = false
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
    try {
      await doRename(typesDir, backupDir)
      backedUp = true
    } catch (err) {
      if (!isNotFoundErrno(err)) throw err
    }
    try {
      await doRename(stagingDir, typesDir)
    } catch (swapErr) {
      if (backedUp) {
        try {
          await doRename(backupDir, typesDir)
          backedUp = false
        } catch (restoreErr) {
          throw new CliError(
            `failed to replace SDK types in ${typesDir} (${swapErr instanceof Error ? swapErr.message : String(swapErr)}) and failed to restore backup at ${backupDir} (${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)})`,
            'write_failed',
          )
        }
      }
      throw swapErr
    }
    if (backedUp) {
      await removeDirIfPresent(backupDir)
    }
  } catch (err) {
    let cleanupDiagnostic = ''
    try {
      await removeDirIfPresent(stagingDir)
    } catch (cleanupErr) {
      cleanupDiagnostic = ` (staging cleanup also failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)})`
    }
    if (err instanceof CliError) throw err
    throw new CliError(
      `failed to write SDK types into ${typesDir}: ${err instanceof Error ? err.message : String(err)}${cleanupDiagnostic}`,
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
