/**
 * Local plugin client compiler command (`helmx plugins build`):
 * precompiles plugin client modules into static `dist-client/` artifacts without contacting Hub.
 */
import {
  HelmxError,
  PREBUILT_CLIENT_DIR_NAME,
  type BuildPluginClientBundleDirOptions,
  type BuildPluginClientBundleDirResult,
  type PluginClientNpmRoot,
} from '@helmx/protocol'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CliError } from '../errors.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { assertNoExtraPositionals, printResult, repeatedValues } from './shared.js'

async function readOptionalManifestObject(
  filePath: string,
  label: string,
): Promise<Record<string, unknown> | undefined> {
  let text: string
  try {
    text = await fsp.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new CliError(
      `failed to read ${label} (${filePath}): ${err instanceof Error ? err.message : String(err)}`,
      'read_failed',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new CliError(
      `invalid JSON in ${label} (${filePath}): ${err instanceof Error ? err.message : String(err)}`,
      'invalid_plugin_manifest',
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(`${label} (${filePath}) must be a JSON object`, 'invalid_plugin_manifest')
  }
  return parsed as Record<string, unknown>
}

function manifestString(
  pluginJson: Record<string, unknown> | undefined,
  helmxField: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  if (typeof pluginJson?.[field] === 'string') return pluginJson[field]
  if (typeof helmxField?.[field] === 'string') return helmxField[field]
  return undefined
}

function isOutsidePluginBase(base: string, target: string): boolean {
  const rel = path.relative(base, target)
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
}

async function resolveNearestRealpath(
  target: string,
): Promise<{ kind: 'ok'; real: string } | { kind: 'dangling-symlink' }> {
  let cur = target
  for (;;) {
    try {
      return { kind: 'ok', real: await fsp.realpath(cur) }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
      // A dangling symlink fails realpath with ENOENT; surface it as a symlink escape rather than masking via parent.
      try {
        if ((await fsp.lstat(cur)).isSymbolicLink()) return { kind: 'dangling-symlink' }
      } catch {
        // Missing component: walk up to nearest existing ancestor.
      }
      const parent = path.dirname(cur)
      if (parent === cur) throw err
      cur = parent
    }
  }
}

async function assertPathInsidePluginRoot(
  pluginDir: string,
  dirReal: string,
  rawSubpath: string,
  resolvedPath: string,
  field: string,
): Promise<void> {
  // Compare lexical containment against pluginDir (same base used by path.resolve) so 8.3 short paths
  // (e.g. Windows RUNNER~1) or symlinked parent dirs (/var -> /private/var) do not falsely mismatch dirReal.
  const lexicalEscapes = path.isAbsolute(rawSubpath)
    ? isOutsidePluginBase(pluginDir, resolvedPath) && isOutsidePluginBase(dirReal, resolvedPath)
    : isOutsidePluginBase(pluginDir, resolvedPath)
  if (lexicalEscapes) {
    throw new CliError(
      `plugin ${pluginDir} ${field} escapes plugin directory: ${rawSubpath}`,
      'invalid_plugin_definition',
    )
  }
  try {
    const resolved = await resolveNearestRealpath(resolvedPath)
    if (resolved.kind === 'dangling-symlink' || isOutsidePluginBase(dirReal, resolved.real)) {
      throw new CliError(
        `plugin ${pluginDir} ${field} symlink escapes plugin directory: ${rawSubpath}`,
        'invalid_plugin_definition',
      )
    }
  } catch (err) {
    if (err instanceof CliError) throw err
    throw new CliError(
      `failed to resolve ${field} (${resolvedPath}): ${err instanceof Error ? err.message : String(err)}`,
      'read_failed',
    )
  }
}

async function loadPluginBuildCompiler(
  env: NodeJS.ProcessEnv,
): Promise<(options: BuildPluginClientBundleDirOptions) => Promise<BuildPluginClientBundleDirResult>> {
  // Dynamically load the workspace/runtime build package without creating a static @helmx/cli -> @helmx/plugin-build dependency edge.
  const pluginBuildPkg = ['@helmx', 'plugin-build'].join('/')
  let buildMod: {
    buildPluginClientBundleDir?: (
      options: BuildPluginClientBundleDirOptions,
    ) => Promise<BuildPluginClientBundleDirResult>
  }
  try {
    let entry: string
    try {
      entry = import.meta.resolve(pluginBuildPkg)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error
      const { readCurrentEntry, resolveInstallRoot } = await import('../launcher/index.js')
      const current = await readCurrentEntry(resolveInstallRoot(env))
      entry = pathToFileURL(createRequire(current.entryPath).resolve(pluginBuildPkg)).href
    }
    buildMod = (await import(entry)) as typeof buildMod
  } catch (err) {
    throw new CliError(
      `plugin client compiler unavailable (${pluginBuildPkg} failed to load: ${err instanceof Error ? err.message : String(err)})`,
      'plugin_build_unavailable',
    )
  }
  if (typeof buildMod.buildPluginClientBundleDir !== 'function') {
    throw new CliError(
      `plugin client compiler unavailable (${pluginBuildPkg} does not export buildPluginClientBundleDir)`,
      'plugin_build_unavailable',
    )
  }
  return buildMod.buildPluginClientBundleDir
}

async function runPluginsBuild(ctx: CommandContext): Promise<void> {
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
  const pluginDir = path.resolve(ctx.cwd, rawDir)

  let dirStat
  try {
    dirStat = await fsp.stat(pluginDir)
  } catch (err) {
    throw new CliError(
      `plugin directory not accessible (${pluginDir}): ${err instanceof Error ? err.message : String(err)}`,
      'client_root_invalid',
    )
  }
  if (!dirStat.isDirectory()) {
    throw new CliError(`plugin target is not a directory: ${pluginDir}`, 'client_root_invalid')
  }
  const dirReal = await fsp.realpath(pluginDir)

  const pluginJson = await readOptionalManifestObject(path.join(pluginDir, 'plugin.json'), 'plugin.json')
  const packageJson = await readOptionalManifestObject(path.join(pluginDir, 'package.json'), 'package.json')
  const helmxFieldRaw = packageJson?.['helmx']
  if (
    helmxFieldRaw !== undefined &&
    (helmxFieldRaw === null || typeof helmxFieldRaw !== 'object' || Array.isArray(helmxFieldRaw))
  ) {
    throw new CliError(`package.json helmx field in ${pluginDir} must be an object`, 'invalid_plugin_manifest')
  }
  const helmxField = helmxFieldRaw as Record<string, unknown> | undefined

  const rawId = pluginJson?.['id'] ?? helmxField?.['id'] ?? packageJson?.['name']
  const pluginId = typeof rawId === 'string' && rawId.trim().length > 0 ? rawId.trim() : path.basename(pluginDir)

  const manifestClientRoot = manifestString(pluginJson, helmxField, 'clientRoot')
  let clientRoot: string
  if (manifestClientRoot !== undefined && manifestClientRoot.length > 0) {
    clientRoot = path.resolve(pluginDir, manifestClientRoot)
    await assertPathInsidePluginRoot(pluginDir, dirReal, manifestClientRoot, clientRoot, 'clientRoot')
  } else {
    const defaultClientDir = path.join(pluginDir, 'client')
    const hasClientDir = await fsp.stat(defaultClientDir).then((s) => s.isDirectory(), () => false)
    clientRoot = hasClientDir ? defaultClientDir : pluginDir
  }

  const outFlag = ctx.flags.get('out')
  let outDir: string
  if (typeof outFlag === 'string' && outFlag.length > 0) {
    outDir = path.resolve(ctx.cwd, outFlag)
  } else {
    const manifestDist = manifestString(pluginJson, helmxField, 'clientDist')
    if (manifestDist !== undefined && manifestDist.length > 0) {
      outDir = path.resolve(pluginDir, manifestDist)
      await assertPathInsidePluginRoot(pluginDir, dirReal, manifestDist, outDir, 'clientDist')
    } else {
      outDir = path.join(pluginDir, PREBUILT_CLIENT_DIR_NAME)
    }
  }

  const specSet = new Set<string>()
  for (const list of [pluginJson?.['clientDependencies'], helmxField?.['clientDependencies']]) {
    if (list === undefined) continue
    if (!Array.isArray(list) || list.some((x) => typeof x !== 'string' || x.trim().length === 0)) {
      throw new CliError(`clientDependencies in ${pluginDir} must be an array of non-empty strings`, 'invalid_plugin_manifest')
    }
    for (const spec of list as string[]) specSet.add(spec.trim())
  }
  const npmRoots: PluginClientNpmRoot[] =
    specSet.size > 0 ? [{ specifiers: [...specSet], packageRoot: pluginDir }] : []
  const explicitModules = repeatedValues(ctx.flags, 'module')
  const buildPluginClientBundleDir = await loadPluginBuildCompiler(ctx.env)

  let result: BuildPluginClientBundleDirResult
  try {
    result = await buildPluginClientBundleDir({
      pluginId,
      clientRoot,
      outDir,
      ...(explicitModules.length > 0 ? { modules: explicitModules } : {}),
      ...(npmRoots.length > 0 ? { npmRoots } : {}),
    })
  } catch (err) {
    if (err instanceof HelmxError) {
      throw new CliError(err.message, err.code, 1, err.details)
    }
    throw err
  }

  if (ctx.json) {
    printResult(ctx, result)
    return
  }
  const moduleKeys = Object.keys(result.manifest.modules).sort()
  ctx.io.out(
    `Built ${moduleKeys.length} client module(s) for ${result.pluginId} -> ${result.outDir} (${(result.totalBytes / 1024).toFixed(1)} KiB)\n`,
  )
  for (const modRef of moduleKeys) {
    const entry = result.manifest.modules[modRef]!
    const chunkSuffix = entry.chunks && entry.chunks.length > 0 ? ` + ${entry.chunks.length} chunk(s)` : ''
    ctx.io.out(`  - ${modRef} -> ${entry.entryFile} (${entry.contentHash.slice(0, 12)}${chunkSuffix})\n`)
  }
}

export const pluginsBuildCommand: CommandSpec = {
  path: ['plugins', 'build'],
  description:
    'Local build: precompile a plugin directory client modules into static dist-client/ artifacts without contacting Hub',
  flags: [
    { name: 'dir', type: 'string', help: 'plugin directory path (defaults to current working directory)' },
    { name: 'out', type: 'string', help: 'output prebuilt directory (defaults to manifest clientDist or <dir>/dist-client)' },
    {
      name: 'module',
      type: 'string',
      repeated: true,
      help: 'explicit relative .ts/.tsx entry module(s) inside clientRoot (repeatable; auto-scans clientRoot when omitted)',
    },
  ],
  positional: '[dir]',
  run: runPluginsBuild,
}
