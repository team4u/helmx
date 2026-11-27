/**
 * Managed external plugin package lifecycle commands:
 * plugins install / update / remove (custom handlers registered via `commandsFromOperations`).
 */
import {
  PLUGIN_CORE_OPERATIONS,
  type PluginInstallResult,
  type PluginRemoveResult,
  type PluginSummary,
  type PluginUpdateResult,
} from '@helmx/protocol'
import { CliError } from '../errors.js'
import { schemaFlagsForOperation, type CoreCliCustomCommandHandler } from './from-operations.js'
import type { CommandContext } from './shared.js'
import { assertNoExtraPositionals, printResult, requirePositional } from './shared.js'

const PLUGIN_INSTALL_SPEC = PLUGIN_CORE_OPERATIONS.find((op) => op.key === 'plugins.install')!
const INSTALL_SCHEMA_FLAGS = new Map(
  schemaFlagsForOperation(PLUGIN_INSTALL_SPEC).map((flag) => [flag.name, flag] as const),
)

const PLUGIN_UPDATE_SPEC = PLUGIN_CORE_OPERATIONS.find((op) => op.key === 'plugins.update')!
const UPDATE_SCHEMA_FLAGS = new Map(
  schemaFlagsForOperation(PLUGIN_UPDATE_SPEC).map((flag) => [flag.name, flag] as const),
)

/**
 * Destructive removal confirmation (routes exclusively through `ctx.io`):
 * --yes and --json proceed non-interactively; TTY prompts one line on `ctx.io.stdin` (y/yes confirms);
 * non-TTY without --yes rejects explicitly — never hangs waiting for input on unattended pipes.
 */
async function confirmRemove(ctx: CommandContext, assumedYes: boolean, pluginId: string): Promise<void> {
  if (ctx.json || assumedYes) return
  if (ctx.io.stdin.isTTY !== true) {
    throw new CliError(
      `removing ${pluginId} is destructive (deletes Hub host install directory irreversibly): pass --yes in non-interactive environments`,
      'confirmation_required',
    )
  }
  const prompt = `Remove plugin ${pluginId} and its install directory (irreversible)? Type yes to confirm: `
  let answer: string
  if (ctx.io.stdin.readLine !== undefined) {
    answer = await ctx.io.stdin.readLine(prompt)
  } else {
    ctx.io.err(prompt)
    answer = await ctx.io.stdin.readAll()
  }
  const normalized = answer.trim().toLowerCase()
  if (normalized !== 'y' && normalized !== 'yes') {
    throw new CliError('cancelled: removal not confirmed', 'not_confirmed')
  }
}

export function pluginPackageCustomHandlers(): Record<string, CoreCliCustomCommandHandler> {
  return {
    'plugins install': {
      description:
        'Install and register an external plugin package from npm/git/local path (POST /api/plugins/install; disabled by default unless --enable; reinstalling the same canonical local directory performs an idempotent hot update preserving ctx.doc data). source is resolved on the Hub host; enabled plugins run trusted code in-process with no sandbox',
      flags: [
        {
          ...(INSTALL_SCHEMA_FLAGS.get('enable') ?? { name: 'enable', type: 'boolean' as const }),
          help: 'enable immediately after install (registered as disabled by default)',
        },
      ],
      positional: '<source>',
      async run(ctx: CommandContext) {
        const source = requirePositional(ctx.positionals, 0, 'source')
        if (source.trim() === '') {
          throw new CliError(
            '<source> cannot be empty (npm:<spec> / git:<repo>@<ref> / HTTPS Git URL / local path; parsed by Hub)',
            'invalid_flag_value',
          )
        }
        assertNoExtraPositionals(ctx.positionals, 1)
        const enable = ctx.flags.get('enable') === true
        const hub = await ctx.hub()
        const result = await hub.post<PluginInstallResult>('/api/plugins/install', {
          source,
          ...(enable ? { enable: true } : {}),
        })
        if (ctx.json) {
          printResult(ctx, result)
          return result.enableError !== undefined ? 1 : 0
        }
        const pluginId = result.summary?.id ?? '(unknown)'
        const version = result.record?.version ?? ''
        const sourceRaw = result.record?.source?.raw ?? source
        ctx.io.out(
          `Installed ${pluginId}${version === '' ? '' : ` ${version}`} (source: ${sourceRaw})\n`,
        )
        if (result.record?.installPath !== undefined) {
          ctx.io.out(`Install directory (Hub host): ${result.record.installPath}\n`)
        }
        if (result.enableError !== undefined) {
          ctx.io.err(
            `Status: installed, but --enable failed [${result.enableError.code}]: ${result.enableError.message}\n`,
          )
          throw new CliError(
            `installed ${pluginId}, but enable failed (${result.enableError.code}): ${result.enableError.message}`,
            result.enableError.code,
            1,
            result.enableError,
          )
        }
        ctx.io.out(
          result.summary?.enabled === true
            ? 'Status: enabled\n'
            : `Status: disabled (enable with: helmx plugins enable ${pluginId})\n`,
        )
      },
    },

    'plugins update': {
      description:
        'Update an installed external plugin package (or --all managed packages) and reload (POST /api/plugins/:id/update; optional --source <source> switches/upgrades pinned sources while preserving plugin data)',
      flags: [
        {
          name: 'all',
          type: 'boolean',
          help: 'update all managed external plugins sequentially (mutually exclusive with <id> and --source)',
        },
        {
          ...(UPDATE_SCHEMA_FLAGS.get('source') ?? { name: 'source', type: 'string' as const }),
          help: 'optional new package source to switch/upgrade to while preserving plugin data (single plugin only)',
        },
      ],
      positional: '[<id>]',
      async run(ctx: CommandContext) {
        const all = ctx.flags.get('all') === true
        const hasSource = ctx.flags.has('source')
        const rawSource = ctx.flags.get('source')
        const id = ctx.positionals[0]
        if (all && id !== undefined) {
          throw new CliError('<id> and --all are mutually exclusive', 'conflicting_flags')
        }
        if (all && hasSource) {
          throw new CliError('--all and --source are mutually exclusive', 'conflicting_flags')
        }
        if (!all && id === undefined) {
          throw new CliError('missing target: provide <id> or --all', 'missing_id')
        }
        assertNoExtraPositionals(ctx.positionals, id !== undefined ? 1 : 0)
        if (hasSource && (typeof rawSource !== 'string' || rawSource.trim() === '')) {
          throw new CliError('--source cannot be empty', 'invalid_flag_value')
        }
        const source = typeof rawSource === 'string' ? rawSource.trim() : undefined
        const hub = await ctx.hub()
        const ver = (v: string): string => (v === '' ? 'unknown version' : v)
        if (!all) {
          const reqPath = `/api/plugins/${encodeURIComponent(id!)}/update`
          const result =
            source !== undefined
              ? await hub.post<PluginUpdateResult>(reqPath, { source })
              : await hub.post<PluginUpdateResult>(reqPath)
          if (ctx.json) {
            printResult(ctx, result)
            return
          }
          if (result.changed) {
            ctx.io.out(`Updated ${result.record.pluginId}: ${ver(result.previousVersion)} -> ${ver(result.record.version)}\n`)
          } else {
            ctx.io.out(`${result.record.pluginId} source unchanged; no update (current ${ver(result.record.version)})\n`)
          }
          ctx.io.out(
            `Install directory (Hub host): ${result.record.installPath}; status: ${result.summary.enabled ? 'enabled' : 'disabled'}\n`,
          )
          return
        }
        const list = await hub.get<PluginSummary[]>('/api/plugins')
        const managed = Array.isArray(list) ? list.filter((p) => p.managed !== undefined) : []
        if (managed.length === 0) {
          if (ctx.json) {
            printResult(ctx, { total: 0, updated: 0, unchanged: 0, failed: 0, results: [] })
          } else {
            ctx.io.out('No managed external plugins installed.\n')
          }
          return
        }
        interface BatchUpdateItem {
          pluginId: string
          status: 'updated' | 'unchanged' | 'failed'
          result?: PluginUpdateResult
          error?: { code: string; message: string }
        }
        const results: BatchUpdateItem[] = []
        let updatedCount = 0
        let unchangedCount = 0
        let failedCount = 0
        for (let i = 0; i < managed.length; i += 1) {
          const plugin = managed[i]!
          try {
            const result = await hub.post<PluginUpdateResult>(`/api/plugins/${encodeURIComponent(plugin.id)}/update`)
            if (result.changed) {
              updatedCount += 1
              results.push({ pluginId: plugin.id, status: 'updated', result })
              if (!ctx.json) {
                ctx.io.out(
                  `[${i + 1}/${managed.length}] Updated ${plugin.id}: ${ver(result.previousVersion)} -> ${ver(result.record.version)}\n`,
                )
              }
            } else {
              unchangedCount += 1
              results.push({ pluginId: plugin.id, status: 'unchanged', result })
              if (!ctx.json) {
                ctx.io.out(`[${i + 1}/${managed.length}] Unchanged ${plugin.id} (${ver(result.record.version)})\n`)
              }
            }
          } catch (err) {
            failedCount += 1
            const code = err instanceof CliError ? err.code : 'plugin_package_update_failed'
            const message = err instanceof Error ? err.message : String(err)
            results.push({ pluginId: plugin.id, status: 'failed', error: { code, message } })
            if (!ctx.json) {
              ctx.io.out(`[${i + 1}/${managed.length}] Failed ${plugin.id} (${code}): ${message}\n`)
            }
          }
        }
        if (ctx.json) {
          printResult(ctx, {
            total: managed.length,
            updated: updatedCount,
            unchanged: unchangedCount,
            failed: failedCount,
            results,
          })
        } else {
          ctx.io.out(
            `Summary: ${updatedCount} updated, ${unchangedCount} unchanged, ${failedCount} failed (${managed.length} total)\n`,
          )
        }
        if (failedCount > 0) {
          throw new CliError(
            `${failedCount} of ${managed.length} plugin update(s) failed`,
            'plugin_update_partial_failed',
          )
        }
      },
    },

    'plugins remove': {
      description:
        'Remove a managed external plugin package (POST /api/plugins/:id/remove; disables plugin and deletes its Hub install directory and record irreversibly). Prompts for confirmation on TTY; pass --yes non-interactively',
      flags: [{ name: 'yes', type: 'boolean', help: 'skip confirmation prompt (for non-interactive/scripted usage)' }],
      positional: '<id>',
      async run(ctx: CommandContext) {
        const id = requirePositional(ctx.positionals, 0, 'id')
        assertNoExtraPositionals(ctx.positionals, 1)
        await confirmRemove(ctx, ctx.flags.get('yes') === true, id)
        const hub = await ctx.hub()
        const result = await hub.post<PluginRemoveResult>(`/api/plugins/${encodeURIComponent(id)}/remove`)
        if (ctx.json) {
          printResult(ctx, result)
          return
        }
        ctx.io.out(`Removed ${result.pluginId} (install record ${result.installId}; was ${result.wasEnabled ? 'enabled' : 'disabled'})\n`)
        ctx.io.out(`Removed directory (Hub host): ${result.installPath}\n`)
      },
    },
  }
}
