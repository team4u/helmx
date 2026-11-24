/**
 * Plugin commands: plugins list/enable/disable/config/doc/client, doctor/reload/rescan
 * (DX loop), install/update/remove (managed package management), and actions list.
 * Local offline DX commands live in sibling modules (`plugins-init.ts`, `plugins-types.ts`, `plugins-build.ts`).
 */
import type {
  ActionManifest,
  PluginDoctorReport,
  PluginInstallResult,
  PluginManifestProjection,
  PluginReloadResult,
  PluginRemoveResult,
  PluginRescanResult,
  PluginSummary,
  PluginUpdateResult,
} from '@helmx/protocol'
import { CliError } from '../errors.js'
import { printTableColumns, printValue, resolveDisplayString } from '../output.js'
import type { HubClient } from '../hub-client.js'
import { watchJsonSse } from '../stream.js'
import { pluginsInitCommand } from './plugins-init.js'
import { pluginsBuildCommand } from './plugins-build.js'
import { pluginsTypesCommand } from './plugins-types.js'
import type { CommandContext, CommandSpec } from './shared.js'
import {
  assertNoExtraPositionals,
  coerceMetaFlag,
  parseKeyValues,
  printPlainText,
  printResult,
  repeatedValues,
  requirePositional,
  resolveConversationTarget,
} from './shared.js'

/**
 * Session document subscription (--watch): consumes dedicated SSE (GET /api/plugins/:id/docs/:name/events?conversationId=N).
 * - --json: emits NDJSON per frame (both snapshot and incremental frames verbatim);
 * - human mode: snapshot prints current value; incremental frames print a change summary line + new value;
 * - 404 on connect (plugin disabled / conversation deleted / document not public) fails explicitly and stops without retrying.
 */
async function watchSessionDoc(
  ctx: CommandContext,
  hub: HubClient,
  base: string,
  conversationId: number,
  pluginId: string,
  name: string,
): Promise<void> {
  const label = `${pluginId}/${name}#conversation-${conversationId}`
  await watchJsonSse(hub, ctx.io, `${base}/events?conversationId=${conversationId}`, (event, payload) => {
    if (ctx.json) {
      ctx.io.out(`${JSON.stringify(payload ?? null)}\n`)
      return
    }
    if (event === 'snapshot') {
      const snap = payload as { doc?: { value?: unknown; deleted?: boolean } }
      ctx.io.out(`[${label}] snapshot\n`)
      printValue(ctx.io, snap.doc?.value ?? null, false)
      return
    }
    const frame = payload as { seq?: number; event?: { doc?: { value?: unknown; deleted?: boolean } } }
    const doc = frame.event?.doc
    ctx.io.out(`[${label}] update seq=${frame.seq ?? '?'}${doc?.deleted === true ? ' (deleted)' : ''}\n`)
    printValue(ctx.io, doc?.value ?? null, false)
  })
}

/**
 * Destructive removal confirmation (reuses CLI TTY/non-TTY convention, matching login password prompt):
 * --yes and --json proceed non-interactively; TTY prompts one line on stdin (y/yes confirms);
 * non-TTY without --yes rejects explicitly — never hangs waiting for input on unattended pipes.
 */
async function confirmRemove(ctx: CommandContext, assumedYes: boolean, pluginId: string): Promise<void> {
  if (ctx.json || assumedYes) return
  if (process.stdin.isTTY !== true) {
    throw new CliError(
      `removing ${pluginId} is destructive (deletes Hub host install directory irreversibly): pass --yes in non-interactive environments`,
      'confirmation_required',
    )
  }
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question(`Remove plugin ${pluginId} and its install directory (irreversible)? Type yes to confirm: `)
    const normalized = answer.trim().toLowerCase()
    if (normalized !== 'y' && normalized !== 'yes') {
      throw new CliError('cancelled: removal not confirmed', 'not_confirmed')
    }
  } finally {
    rl.close()
  }
}

export function pluginsCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['plugins', 'list'],
    description: 'List plugins (GET /api/plugins)',
    async run(ctx: CommandContext) {
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
  })

  cmds.push({
    path: ['plugins', 'manifest'],
    description: 'Inspect read-only plugin extension contract projection (GET /api/plugins/:id/manifest)',
    positional: '<id>',
    async run(ctx: CommandContext) {
      const id = requirePositional(ctx.positionals, 0, 'id')
      assertNoExtraPositionals(ctx.positionals, 1)
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<PluginManifestProjection>(`/api/plugins/${encodeURIComponent(id)}/manifest`))
    },
  })

  cmds.push({
    path: ['plugins', 'enable'],
    description: 'Enable a plugin (POST /api/plugins/:id/enable)',
    positional: '<id>',
    async run(ctx: CommandContext) {
      const id = requirePositional(ctx.positionals, 0, 'id')
      const hub = await ctx.hub()
      printResult(ctx, await hub.post<unknown>(`/api/plugins/${encodeURIComponent(id)}/enable`))
    },
  })

  cmds.push({
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
      const path = `/api/plugins/${encodeURIComponent(id)}/disable`
      try {
        // Without --force, send no body: if persistent resources are in use, the server returns 409
        // plugin_in_use, which we enrich below with usage details and a --force hint.
        printResult(
          ctx,
          force ? await hub.post<unknown>(path, { force: true }) : await hub.post<unknown>(path),
        )
      } catch (err) {
        if (!force && err instanceof CliError && err.code === 'plugin_in_use') {
          throw enrichPluginInUseError(err)
        }
        throw err
      }
    },
  })

  cmds.push({
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
      const path = `/api/plugins/${encodeURIComponent(id)}/config`
      if (!hasInput && sets.length === 0 && unsets.length === 0) {
        printResult(ctx, await hub.get<unknown>(path))
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
      printResult(ctx, await hub.put<unknown>(path, { values }))
    },
  })

  cmds.push({
    path: ['plugins', 'doc'],
    description:
      'Read a public plugin document (GET /api/plugins/:id/docs/:name; --conversation/--current reads a session doc; --watch subscribes to session doc SSE)',
    flags: [
      { name: 'conversation', type: 'number', help: 'target conversation ID for session document (mutually exclusive with --current)' },
      { name: 'current', type: 'boolean', help: 'use HELMX_CONVERSATION_ID from environment (mutually exclusive with --conversation)' },
      { name: 'watch', type: 'boolean', help: 'subscribe to dedicated SSE for a session document (requires --conversation/--current; Ctrl-C to exit)' },
    ],
    positional: '<pluginId> <name>',
    async run(ctx: CommandContext) {
      const pluginId = ctx.positionals[0]
      const name = ctx.positionals[1]
      if (pluginId === undefined || name === undefined) {
        throw new CliError('missing positional arguments: plugins doc <pluginId> <name>', 'missing_id')
      }
      assertNoExtraPositionals(ctx.positionals, 2)
      const hasConversation = ctx.flags.has('conversation')
      const hasCurrent = ctx.flags.get('current') === true
      if (hasConversation && hasCurrent) {
        throw new CliError('--conversation and --current are mutually exclusive', 'conflicting_flags')
      }
      let conversationId: number | undefined
      if (hasConversation) {
        const value = ctx.flags.get('conversation')
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
          throw new CliError('--conversation must be a positive integer conversation ID', 'invalid_flag_value')
        }
        conversationId = value
      } else if (hasCurrent) {
        conversationId = resolveConversationTarget(ctx.flags, undefined, ctx.env)
      }
      const base = `/api/plugins/${encodeURIComponent(pluginId)}/docs/${encodeURIComponent(name)}`
      const hub = await ctx.hub()
      if (ctx.flags.get('watch') === true) {
        if (conversationId === undefined) {
          throw new CliError('--watch requires a target conversation (--conversation <id> or --current)', 'missing_conversation_target')
        }
        await watchSessionDoc(ctx, hub, base, conversationId, pluginId, name)
        return
      }
      const path = conversationId === undefined ? base : `${base}?conversationId=${conversationId}`
      const doc = await hub.get<{
        pluginId: string
        name: string
        conversationId?: number
        value: unknown
        deleted?: boolean
      }>(path)
      if (ctx.json) {
        printResult(ctx, doc)
        return
      }
      // Human mode: document name + value (preserve JSON fidelity; print string values verbatim)
      if (typeof doc.value === 'string') {
        ctx.io.out(`${doc.name}\n`)
        printPlainText(ctx, doc.value)
        return
      }
      printValue(ctx.io, doc.value, false)
    },
  })

  cmds.push({
    path: ['plugins', 'client'],
    description: 'Fetch compiled plugin client.tsx bundle (GET /api/plugins/:id/client.mjs?module=...; --module defaults to client.tsx)',
    flags: [
      { name: 'module', type: 'string', help: 'module path relative to plugin clientRoot (defaults to client.tsx)' },
      { name: 'chunk', type: 'string', help: 'optional chunk filename (e.g. vendor.js)' },
      { name: 'output', type: 'string', help: 'write output to file path (defaults to stdout; still writes file and prints metadata with --json)' },
    ],
    positional: '<id>',
    async run(ctx: CommandContext) {
      const id = requirePositional(ctx.positionals, 0, 'id')
      assertNoExtraPositionals(ctx.positionals, 1)
      const moduleRef = (ctx.flags.get('module') as string | undefined) ?? 'client.tsx'
      const chunk = ctx.flags.get('chunk') as string | undefined
      if (ctx.flags.has('output') && typeof ctx.flags.get('output') !== 'string') {
        throw new CliError('--output requires a file path', 'invalid_flag_value')
      }
      const outPath = ctx.flags.get('output') as string | undefined
      const hub = await ctx.hub()
      let path = `/api/plugins/${encodeURIComponent(id)}/client.mjs?module=${encodeURIComponent(moduleRef)}`
      if (chunk !== undefined) path += `&chunk=${encodeURIComponent(chunk)}`
      const response = await hub.raw(path)
      const code = await response.text()
      const contentHash = response.headers.get('x-helmx-client-hash') ?? ''
      if (ctx.json) {
        printResult(ctx, {
          pluginId: id,
          module: moduleRef,
          ...(chunk !== undefined ? { chunk } : {}),
          contentHash,
          bytes: code.length,
        })
      }
      if (outPath !== undefined) {
        const { writeFile } = await import('node:fs/promises')
        await writeFile(outPath, code, 'utf8')
        if (!ctx.json) ctx.io.out(`wrote ${outPath} (${code.length} bytes, hash ${contentHash})\n`)
        return
      }
      if (!ctx.json) ctx.io.out(code)
    },
  })

  cmds.push({
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
      const positionalIsPath =
        positional !== undefined &&
        (positional.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(positional) || positional.startsWith('\\\\'))
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
  })

  cmds.push({
    path: ['plugins', 'reload'],
    description: 'Hot-reload an external plugin with preflight checks (POST /api/plugins/:id/reload; keeps previous instance if preflight fails)',
    positional: '<id>',
    async run(ctx: CommandContext) {
      const id = requirePositional(ctx.positionals, 0, 'id')
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
  })

  cmds.push({
    path: ['plugins', 'rescan'],
    description: 'Incrementally rescan the plugins directory (POST /api/plugins/rescan; registers new external plugins as disabled by default)',
    async run(ctx: CommandContext) {
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
  })

  cmds.push(pluginsInitCommand, pluginsTypesCommand, pluginsBuildCommand)

  cmds.push({
    path: ['plugins', 'install'],
    description:
      'Install and register an external plugin package from npm/git/local path (POST /api/plugins/install; disabled by default unless --enable; reinstalling the same canonical local directory performs an idempotent hot update preserving ctx.doc data). source is resolved on the Hub host; enabled plugins run trusted code in-process with no sandbox',
    flags: [{ name: 'enable', type: 'boolean', help: 'enable immediately after install (registered as disabled by default)' }],
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
        return
      }
      ctx.io.out(
        `Installed ${result.summary.id}${result.record.version === '' ? '' : ` ${result.record.version}`} (source: ${result.record.source.raw})\n`,
      )
      ctx.io.out(`Install directory (Hub host): ${result.record.installPath}\n`)
      ctx.io.out(
        result.summary.enabled
          ? 'Status: enabled\n'
          : `Status: disabled (enable with: helmx plugins enable ${result.summary.id})\n`,
      )
    },
  })

  cmds.push({
    path: ['plugins', 'update'],
    description:
      'Update an installed external plugin package (or --all managed packages) and reload (POST /api/plugins/:id/update; optional --source <source> switches/upgrades pinned sources while preserving plugin data)',
    flags: [
      {
        name: 'all',
        type: 'boolean',
        help: 'update all managed external plugins sequentially (mutually exclusive with <id> and --source)',
      },
      {
        name: 'source',
        type: 'string',
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
        const path = `/api/plugins/${encodeURIComponent(id!)}/update`
        const result =
          source !== undefined
            ? await hub.post<PluginUpdateResult>(path, { source })
            : await hub.post<PluginUpdateResult>(path)
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
  })

  cmds.push({
    path: ['plugins', 'remove'],
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
  })

  cmds.push({
    path: ['actions', 'list'],
    description: 'List registered plugin actions (GET /api/actions)',
    async run(ctx: CommandContext) {
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
            const prefix = a.pluginId.startsWith('builtin:') ? a.pluginId.slice('builtin:'.length) : a.pluginId
            return `helmx ${(a.cli?.command ?? [prefix, a.id]).join(' ')}`
          },
        },
        { label: 'description', value: (a) => a.cli?.description ?? a.description },
      ])
    },
  })

  return cmds
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
