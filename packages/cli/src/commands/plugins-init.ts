/**
 * Local plugin scaffold command (`helmx plugins init`):
 * generates an external plugin skeleton without contacting Hub.
 * File templates live in `scaffold-templates.ts` (pure data module).
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { CliError } from '../errors.js'
import {
  SCAFFOLD_CLIENT_APP_TSX,
  SCAFFOLD_CLIENT_INDEX_TSX,
  SCAFFOLD_INDEX_TS_APP,
  SCAFFOLD_INDEX_TS_FULL,
  SCAFFOLD_INDEX_TS_MINIMAL,
  SCAFFOLD_PLUGIN_JSON,
  SCAFFOLD_README,
  SCAFFOLD_TEMPLATES,
  SCAFFOLD_TSCONFIG,
  type ScaffoldTemplate,
} from './scaffold-templates.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { assertNoExtraPositionals, printResult } from './shared.js'

/** Plugin ID / directory name: starts with alphanumeric, allows - _ (aligned with protocol plugin ID rules; builtin: forbidden). */
const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** Generate plugin skeleton files (validates parent dir, rejects non-empty targets, selects template, reports outputs). */
async function runPluginsInit(ctx: CommandContext): Promise<void> {
  const nameFlag = ctx.flags.get('name')
  const namePositional = ctx.positionals[0]
  const name = typeof nameFlag === 'string' && nameFlag.length > 0 ? nameFlag : namePositional
  if (typeof name !== 'string' || name.length === 0) {
    throw new CliError('missing <name> (--name or positional argument)', 'missing_id')
  }
  if (!PLUGIN_NAME_PATTERN.test(name) || name.startsWith('builtin:')) {
    throw new CliError(
      `invalid plugin name: ${name} (must match ${PLUGIN_NAME_PATTERN}, and builtin: prefix is forbidden)`,
      'invalid_flag_value',
    )
  }
  const templateRaw = ctx.flags.get('template')
  if (templateRaw !== undefined && !SCAFFOLD_TEMPLATES.includes(templateRaw as ScaffoldTemplate)) {
    throw new CliError(`--template must be one of ${SCAFFOLD_TEMPLATES.join(' | ')}`, 'invalid_flag_value')
  }
  const template = (templateRaw ?? 'full') as ScaffoldTemplate
  assertNoExtraPositionals(ctx.positionals, name === namePositional ? 1 : 0)

  const dirFlag = ctx.flags.get('dir')
  const parentDir = typeof dirFlag === 'string' && dirFlag.length > 0
    ? dirFlag
    : path.join(ctx.dataDir, 'installed-plugins')
  const target = path.join(parentDir, name)
  const force = ctx.flags.get('force') === true

  // Parent directory: create if missing (matches plugins directory convention); fail explicitly if it exists as a non-directory.
  try {
    const st = await fsp.stat(parentDir)
    if (!st.isDirectory()) throw new CliError(`--dir is not a directory: ${parentDir}`, 'invalid_flag_value')
  } catch (err) {
    if (err instanceof CliError) throw err
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new CliError(
        `failed to inspect --dir (${parentDir}): ${err instanceof Error ? err.message : String(err)}`,
        'read_failed',
      )
    }
    await fsp.mkdir(parentDir, { recursive: true })
  }

  // Target directory: reject by default if existing and non-empty (--force proceeds); reuse if empty.
  let targetExisted = false
  try {
    const st = await fsp.stat(target)
    if (!st.isDirectory()) {
      throw new CliError(`target path already exists and is not a directory: ${target}`, 'conflict')
    }
    targetExisted = true
    const existing = await fsp.readdir(target)
    if (existing.length > 0 && !force) {
      throw new CliError(
        `target directory is non-empty: ${target} (pass --force to proceed; existing unrelated files are kept, matching filenames will be overwritten)`,
        'conflict',
      )
    }
  } catch (err) {
    if (err instanceof CliError) throw err
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new CliError(
        `failed to inspect target directory (${target}): ${err instanceof Error ? err.message : String(err)}`,
        'read_failed',
      )
    }
  }

  // Create target directory if missing (minimal template has no client subdir, so root must be created explicitly).
  await fsp.mkdir(target, { recursive: true })
  const files: string[] = ['plugin.json', 'index.ts', 'tsconfig.json']
  const indexContent =
    template === 'minimal'
      ? SCAFFOLD_INDEX_TS_MINIMAL(name)
      : template === 'app'
        ? SCAFFOLD_INDEX_TS_APP(name, `${name} App`)
        : SCAFFOLD_INDEX_TS_FULL(name)
  await fsp.writeFile(path.join(target, 'plugin.json'), SCAFFOLD_PLUGIN_JSON(name, template), 'utf8')
  await fsp.writeFile(path.join(target, 'index.ts'), indexContent, 'utf8')
  await fsp.writeFile(path.join(target, 'tsconfig.json'), SCAFFOLD_TSCONFIG, 'utf8')
  if (template !== 'minimal') {
    await fsp.mkdir(path.join(target, 'client'), { recursive: true })
    await fsp.writeFile(
      path.join(target, 'client', 'index.tsx'),
      template === 'app' ? SCAFFOLD_CLIENT_APP_TSX : SCAFFOLD_CLIENT_INDEX_TSX,
      'utf8',
    )
    files.push('client/index.tsx')
  }
  await fsp.writeFile(path.join(target, 'README.md'), SCAFFOLD_README(template), 'utf8')
  files.push('README.md')

  const summary = {
    pluginId: name,
    dir: target,
    template,
    files,
    targetExisted,
    nextSteps:
      template === 'app'
        ? [`helmx plugins doctor ${target}`, `helmx plugins install ${target} --enable`]
        : [`helmx plugins doctor ${target}`, 'helmx plugins rescan', `helmx plugins enable ${name}`],
  }
  if (ctx.json) {
    printResult(ctx, summary)
    return
  }
  ctx.io.out(
    `Generated ${template === 'app' ? 'full-stack micro-app' : 'plugin'} skeleton (template ${template}): ${target}${targetExisted ? ' (directory existed; files written/overwritten)' : ''}\n`,
  )
  for (const file of summary.files) ctx.io.out(`  - ${file}\n`)
  ctx.io.out('Next steps:\n')
  for (const step of summary.nextSteps) ctx.io.out(`  ${step}\n`)
}

export const pluginsInitCommand: CommandSpec = {
  path: ['plugins', 'init'],
  description:
    'Local scaffold: generate an external plugin skeleton in the target directory without contacting Hub; --template app declares a Screen and passes helmx plugins doctor',
  flags: [
    { name: 'dir', type: 'string', help: 'target parent directory (defaults to <dataDir>/installed-plugins; must exist or be creatable)' },
    { name: 'name', type: 'string', help: 'plugin directory name and default id (alphanumeric plus - _, defaults to sample-plugin)' },
    {
      name: 'template',
      type: 'string',
      help: 'skeleton template: minimal (backend ping action only) | full (doc/action/workbench panel) | app (full-stack micro-app: doc/actions/screen + sidebar item, passes helmx plugins doctor); defaults to full',
    },
    { name: 'force', type: 'boolean', help: 'proceed even if target directory is non-empty (rejected by default to prevent overwriting)' },
  ],
  positional: '[name]',
  run: runPluginsInit,
}
