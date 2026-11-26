/**
 * Plugin commands: list/manifest/enable/disable/config, DX loop (doctor/reload/rescan),
 * actions list, and composition of doc/client (`plugins-doc.ts`), packages (`plugins-packages.ts`),
 * and local offline DX (`plugins-init.ts`, `plugins-types.ts`, `plugins-build.ts`).
 */
import {
  isAbsoluteTargetPath,
  isCoreNamespace,
  stripBuiltinNamespace,
  type ActionManifest,
  type PluginDoctorReport,
  type PluginManifestProjection,
  type PluginReloadResult,
  type PluginRescanResult,
  type PluginSummary,
} from '@helmx/protocol'
import { CliError } from '../errors.js'
import { printTableColumns, resolveDisplayString } from '../output.js'
import { pluginsBuildCommand } from './plugins-build.js'
import { pluginsClientCommand, pluginsDocCommand } from './plugins-doc.js'
import { pluginsInitCommand } from './plugins-init.js'
import { pluginPackageCommands } from './plugins-packages.js'
import { pluginsTypesCommand } from './plugins-types.js'
import type { CommandContext, CommandSpec } from './shared.js'
import {
  assertNoExtraPositionals,
  coerceMetaFlag,
  parseKeyValues,
  printResult,
  repeatedValues,
  requirePositional,
} from './shared.js'

export function pluginsCommands(): CommandSpec[] {
  return [
    {
      path: ['plugins', 'list'],
      description: 'List plugins (GET /api/plugins)',
      async run(ctx: CommandContext) {
        assertNoExtraPositionals(ctx.positionals, 0)
        const hub = await ctx.hub()
        const list = await hub.get<PluginSummary[]>('/api/plugins')
        if (ctx.json || !Array.isArray(list)) {
          printResult(ctx, list)
          return
        }
        printTableColumns(ctx.io, list, [
          { label: 'id', value: (p) => p.id },
          { label: 'status', value: (p) => p.status ?? (p.enabled ? 'active' : 'disabled') },
          { label: 'name', value: (p) => resolveDisplayString(p.name) },
          { label: 'description', value: (p) => (p.description !== undefined ? resolveDisplayString(p.description) : '') },
          { label: 'error', value: (p) => (p.error ? `${p.error.code} (${p.error.stage}): ${p.error.message}` : '') },
        ])
      },
    },

    {
      path: ['plugins', 'manifest'],
      description: 'Inspect read-only plugin extension contract projection (GET /api/plugins/:id/manifest)',
      positional: '<id>',
      async run(ctx: CommandContext) {
        const id = requirePositional(ctx.positionals, 0, 'id')
        assertNoExtraPositionals(ctx.positionals, 1)
        const hub = await ctx.hub()
        printResult(ctx, await hub.get<PluginManifestProjection>(`/api/plugins/${encodeURIComponent(id)}/manifest`))
      },
    },

    {
      path: ['plugins', 'enable'],
      description: 'Enable a plugin (POST /api/plugins/:id/enable)',
      positional: '<id>',
      async run(ctx: CommandContext) {
        const id = requirePositional(ctx.positionals, 0, 'id')
        assertNoExtraPositionals(ctx.positionals, 1)
        const hub = await ctx.hub()
        printResult(ctx, await hub.post<unknown>(`/api/plugins/${encodeURIComponent(id)}/enable`))
      },
    },

    {
      path: ['plugins', 'disable'],
      description: 'Disable a plugin (POST /api/plugins/:id/disable; --force ignores persistent resource-in-use warnings)',
      flags: [
        { name: 'force', type: 'boolean', help: 'force disable (ignore persistent config/resource warnings; live in-flight tasks still cannot be bypassed)' },
      ],
      positional: '<id>',
      async run(ctx: CommandContext) {
        const id = requirePositional(ctx.positionals, 0, 'id')
        assertNoExtraPositionals(ctx.positionals, 1)
        const force = ctx.flags.get('force') === true
        const hub = await ctx.hub()
        const reqPath = `/api/plugins/${encodeURIComponent(id)}/disable`
        try {
          // Without --force, send no body: if persistent resources are in use, the server returns 409
          // plugin_in_use, which we enrich below with usage details and a --force hint.
          printResult(
            ctx,
            force ? await hub.post<unknown>(reqPath, { force: true }) : await hub.post<unknown>(reqPath),
          )
        } catch (err) {
          if (!force && err instanceof CliError && err.code === 'plugin_in_use') {
            throw enrichPluginInUseError(err)
          }
          throw err
        }
      },
    },

    {
      path: ['plugins', 'config'],
      description: 'View or update plugin config (GET returns {values,schema}; PUT sends {values}; --set key=value and --unset key are repeatable)',
      flags: [
        { name: 'input', type: 'json', help: 'full values JSON object (can be combined with --set; --set overrides matching keys)' },
        { name: 'set', type: 'string', repeated: true, help: 'set a single key=value (repeatable; values parsed as JSON bool/number when valid, otherwise string)' },
        { name: 'unset', type: 'string', repeated: true, help: 'reset a config key to its default (sends null to remove explicit override; repeatable)' },
      ],
      positional: '<id>',
      async run(ctx: CommandContext) {
        const id = requirePositional(ctx.positionals, 0, 'id')
        assertNoExtraPositionals(ctx.positionals, 1)
        const hasInput = ctx.flags.has('input')
        const sets = repeatedValues(ctx.flags, 'set')
        const unsets = repeatedValues(ctx.flags, 'unset')
        for (const key of unsets) {
          if (key.length === 0 || key.includes('=')) {
            throw new CliError(`--unset must be a config key name (non-empty, without =), got "${key}"`, 'invalid_flag_value')
          }
        }
        const hub = await ctx.hub()
        const reqPath = `/api/plugins/${encodeURIComponent(id)}/config`
        if (!hasInput && sets.length === 0 && unsets.length === 0) {
          printResult(ctx, await hub.get<unknown>(reqPath))
          return
        }
        const setValues = parseKeyValues(sets, 'set')
        for (const key of unsets) {
          if (key in setValues) {
            throw new CliError(`--set and --unset cannot target the same key: ${key}`, 'conflicting_flags')
          }
        }
        const values: Record<string, unknown> = hasInput ? coerceMetaFlag(ctx.flags.get('input'), 'input') : {}
        Object.assign(values, setValues)
        for (const key of unsets) values[key] = null
        printResult(ctx, await hub.put<unknown>(reqPath, { values }))
      },
    },

    pluginsDocCommand,
    pluginsClientCommand,

    {
      path: ['plugins', 'doctor'],
      description: 'Run static self-check on external plugin source (POST /api/plugins/doctor; loads, registers, and compiles client)',
      flags: [
        { name: 'path', type: 'string', help: 'absolute path to external plugin source directory (mutually exclusive with --id/<id>)' },
        { name: 'id', type: 'string', help: 'registered external plugin ID (server resolves its source directory; mutually exclusive with path)' },
      ],
      positional: '[<id> | <dir>]',
      async run(ctx: CommandContext) {
        const pathFlag = ctx.flags.get('path')
        const idFlag = ctx.flags.get('id')
        const positional = ctx.positionals[0]
        // Infer positional intent: absolute path -> directory target; otherwise -> plugin ID.
        const positionalIsPath = positional !== undefined && isAbsoluteTargetPath(positional)
        const pathDir =
          typeof pathFlag === 'string' && pathFlag.length > 0
            ? pathFlag
            : positionalIsPath
              ? positional
              : undefined
        const id =
          typeof idFlag === 'string' && idFlag.length > 0
            ? idFlag
            : !positionalIsPath && positional !== undefined
              ? positional
              : undefined
        if (pathDir === undefined && id === undefined) {
          throw new CliError('missing target: provide <id>, --path <dir>, or an absolute-path positional', 'missing_id')
        }
        if (pathDir !== undefined && id !== undefined) {
          throw new CliError('id and directory path cannot both be provided', 'conflicting_flags')
        }
        const usedPositionals = positional !== undefined && (positionalIsPath ? pathDir === positional : id === positional) ? 1 : 0
        assertNoExtraPositionals(ctx.positionals, usedPositionals)
        const hub = await ctx.hub()
        const report = await hub.post<PluginDoctorReport>('/api/plugins/doctor', pathDir !== undefined ? { path: pathDir } : { id: id! })
        if (ctx.json) {
          printResult(ctx, report)
        } else {
          ctx.io.out(
            `Plugin doctor: ${report.dir}${report.pluginId ? ` (id: ${report.pluginId})` : ''}${report.requestedId ? ` (target id: ${report.requestedId})` : ''}\n`,
          )
          for (const check of report.checks) {
            if (check.error === undefined) {
              ctx.io.out(`  [ok] ${check.id} — ${check.label}\n`)
            } else {
              ctx.io.out(`  [!!] ${check.id} — ${check.label}\n        ${check.error.code}: ${check.error.message}\n`)
            }
          }
          ctx.io.out(report.ok ? 'Result: all checks passed\n' : 'Result: failed checks found (see above)\n')
        }
        // Preflight failed: report is already printed to stdout; exit non-zero for script callers.
        if (!report.ok) {
          throw new CliError(
            `plugin doctor found failures (${report.checks.filter((c) => c.error !== undefined).length} check(s))`,
            'doctor_failed',
          )
        }
      },
    },

    {
      path: ['plugins', 'reload'],
      description: 'Hot-reload an external plugin with preflight checks (POST /api/plugins/:id/reload; keeps previous instance if preflight fails)',
      positional: '<id>',
      async run(ctx: CommandContext) {
        const id = requirePositional(ctx.positionals, 0, 'id')
        assertNoExtraPositionals(ctx.positionals, 1)
        const hub = await ctx.hub()
        const result = await hub.post<PluginReloadResult>(`/api/plugins/${encodeURIComponent(id)}/reload`)
        if (ctx.json) {
          printResult(ctx, result)
          return
        }
        ctx.io.out(
          `Reloaded ${result.pluginId} (generation ${result.generation}, enabled state preserved: ${result.wasEnabled ? 'enabled' : 'disabled'})\n`,
        )
        printResult(ctx, result.summary)
      },
    },

    {
      path: ['plugins', 'rescan'],
      description: 'Incrementally rescan the plugins directory (POST /api/plugins/rescan; registers new external plugins as disabled by default)',
      async run(ctx: CommandContext) {
        assertNoExtraPositionals(ctx.positionals, 0)
        const hub = await ctx.hub()
        const result = await hub.post<PluginRescanResult>('/api/plugins/rescan')
        if (ctx.json) {
          printResult(ctx, result)
          return
        }
        if (result.registered.length === 0) {
          ctx.io.out('No new plugins found (already registered plugins and data-only directories are unchanged)\n')
        } else {
          ctx.io.out(`Registered ${result.registered.length} new plugin(s) (disabled by default):\n`)
          for (const id of result.registered) ctx.io.out(`  - ${id}\n`)
          ctx.io.out('Enable with: helmx plugins enable <id>\n')
        }
        ctx.io.out(`(skipped ${result.skipped} directory(ies); ${result.plugins.length} plugin(s) total)\n`)
      },
    },

    pluginsInitCommand,
    pluginsTypesCommand,
    pluginsBuildCommand,
    ...pluginPackageCommands(),

    {
      path: ['actions', 'list'],
      description: 'List registered plugin actions (GET /api/actions)',
      async run(ctx: CommandContext) {
        assertNoExtraPositionals(ctx.positionals, 0)
        const hub = await ctx.hub()
        const list = await hub.get<ActionManifest[]>('/api/actions')
        if (ctx.json || !Array.isArray(list)) {
          printResult(ctx, list)
          return
        }
        printTableColumns(ctx.io, list, [
          { label: 'action', value: (a) => `${a.pluginId}.${a.id}` },
          {
            label: 'cli',
            value: (a) => {
              if (a.cli?.hidden === true || a.visibility === 'ui' || a.visibility === 'internal') return '(hidden)'
              if (isCoreNamespace(a.pluginId)) {
                return a.cli?.command !== undefined && a.cli.command.length > 0
                  ? `helmx ${a.cli.command.join(' ')}`
                  : '(hidden)'
              }
              const prefix = stripBuiltinNamespace(a.pluginId)
              return `helmx ${(a.cli?.command ?? [prefix, a.id]).join(' ')}`
            },
          },
          { label: 'description', value: (a) => a.cli?.description ?? a.description },
        ])
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// 409 plugin_in_use enrichment: preserve code/details while appending occupied resources and --force hint
// ---------------------------------------------------------------------------

/** Extract valid usage entries (usages: [{kind,id,label}]) from error details. */
function extractInUseUsages(details: unknown): Array<{ kind: string; id: string; label: string }> {
  if (details === null || typeof details !== 'object') return []
  const usages = (details as { usages?: unknown }).usages
  if (!Array.isArray(usages)) return []
  return usages.filter(
    (item): item is { kind: string; id: string; label: string } =>
      item !== null &&
      typeof item === 'object' &&
      typeof (item as { kind?: unknown }).kind === 'string' &&
      typeof (item as { id?: unknown }).id === 'string' &&
      typeof (item as { label?: unknown }).label === 'string',
  )
}

/** Preserve original CliError code/details/exitCode while enriching the human-readable message. */
function enrichPluginInUseError(err: CliError): CliError {
  const usages = extractInUseUsages(err.details)
  if (usages.length === 0) return err
  const lines = [err.message, 'Occupied persistent resources:']
  for (const usage of usages) {
    lines.push(`  - [${usage.kind}] ${usage.id}: ${usage.label}`)
  }
  lines.push('Pass --force to disable anyway (live in-flight tasks still cannot be bypassed).')
  return new CliError(lines.join('\n'), err.code, err.exitCode, err.details)
}
