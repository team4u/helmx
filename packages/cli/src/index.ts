#!/usr/bin/env node
/**
 * helmx CLI main entry point.
 * - runCli(argv, options) is the sole test/embed entry; direct CLI invocation executes only when import.meta.url === argv[1].
 * - Command dispatch: core static commands match exactly with top priority; /api/actions is fetched to build
 *   dynamic commands only when no core command matches (and conflicts are validated and reported there).
 *   Core management commands (such as `plugins disable`) never break due to a bad plugin manifest — fault-isolated.
 * - --json applies globally: stdout JSON on success, stderr JSON + non-zero exit code on failure.
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import type { CommandContext, CommandSpec } from './commands/index.js'
import { coreCommands } from './commands/index.js'
import { loadDynamicCommands } from './actions.js'
import { HubClient, resolveEndpoint } from './hub-client.js'
import { buildIo, type Io, type RunCliOptions } from './options.js'
import { CliError, describeError, errorEnvelope, formatHumanError } from './errors.js'
import { dataDirFor, loadCliCredential } from './credentials.js'

export interface CompletedRun {
  exitCode: number
}

function isDirectRun(): boolean {
  if (process.argv[1] === undefined) return false
  try {
    const self = fileURLToPath(import.meta.url)
    const entry = path.resolve(process.argv[1]!)
    return realpathSync(self) === realpathSync(entry)
  } catch {
    return false
  }
}

const HELP_GROUPS: ReadonlyArray<{ title: string; prefixes: ReadonlySet<string> }> = [
  { title: 'Auth & Diagnostics', prefixes: new Set(['setup', 'login', 'status', 'doctor']) },
  { title: 'Local Hub Lifecycle', prefixes: new Set(['start', 'stop', 'restart', 'service', 'update']) },
  { title: 'Conversations & Messaging', prefixes: new Set(['conversations', 'ask', 'send', 'abort', 'events', 'search']) },
  { title: 'Approvals & Artifacts', prefixes: new Set(['asks', 'artifacts']) },
  { title: 'Profiles & Skills', prefixes: new Set(['profiles', 'skills']) },
  { title: 'Models, Providers & Credentials', prefixes: new Set(['models', 'providers', 'credentials']) },
  { title: 'Nodes & Execution', prefixes: new Set(['nodes', 'env']) },
  { title: 'Plugins & Actions', prefixes: new Set(['plugins', 'actions']) },
  { title: 'Raw HTTP Escape Hatch', prefixes: new Set(['api']) },
]

function shortSummary(description: string): string {
  const trimmed = description.trim()
  const idx = trimmed.indexOf(' (')
  if (idx > 0 && idx <= 72) return trimmed.slice(0, idx)
  return trimmed.length > 88 ? `${trimmed.slice(0, 85)}...` : trimmed
}

function formatCompactCommandList(io: Io, commands: readonly CommandSpec[]): void {
  const labels = commands.map((cmd) => `${cmd.path.join(' ')}${cmd.positional ? ` ${cmd.positional}` : ''}`)
  const width = Math.min(44, Math.max(20, ...labels.map((l) => l.length)))
  for (let i = 0; i < commands.length; i++) {
    const label = labels[i]!
    const pad = label.length < width ? ' '.repeat(width - label.length) : ' '
    io.out(`  ${label}${pad}  ${shortSummary(commands[i]!.description)}\n`)
  }
}

function printHelp(
  io: Io,
  core: readonly CommandSpec[],
  dynamic: readonly CommandSpec[],
  diagnostics: readonly string[],
): void {
  io.out('helmx — minimalist durable microkernel personal assistant CLI (parity with the Web API)\n\n')
  io.out('Usage: helmx <command> [subcommand] [--flags] [--json]\n')
  io.out('Run "helmx <group> --help" or "helmx <command> --help" for subcommands and flag details.\n\n')
  io.out('Global options:\n')
  io.out('  --json            machine-readable JSON output (stdout; errors on stderr + non-zero exit code)\n')
  io.out('  --help, -h        show help\n\n')
  io.out('Core commands (including cross-node execution and raw HTTP escape hatch):\n')
  const placed = new Set<CommandSpec>()
  for (const group of HELP_GROUPS) {
    const members = core.filter((cmd) => group.prefixes.has(cmd.path[0] ?? ''))
    if (members.length === 0) continue
    for (const m of members) placed.add(m)
    io.out(`\n  ${group.title}:\n`)
    formatCompactCommandList(io, members)
  }
  const restCore = core.filter((cmd) => !placed.has(cmd))
  if (restCore.length > 0) {
    io.out('\n  Other:\n')
    formatCompactCommandList(io, restCore)
  }
  if (dynamic.length > 0) {
    io.out('\nPlugin commands (dynamically generated from GET /api/actions):\n')
    formatCompactCommandList(io, dynamic)
  } else {
    io.out('\n(No plugin action commands fetched; expected when the Hub is stopped, not logged in, or no actions are available)\n')
  }
  io.out('\nEnvironment variables: HELMX_HUB_URL (default http://127.0.0.1:3202) · HELMX_TOKEN · HELMX_DATA_DIR (default ~/.helmx) · HELMX_CONVERSATION_ID (--current) · HELMX_NODE_ID\n')
  for (const d of diagnostics) io.err(`helmx: ${d}\n`)
}

function commandsUnderPrefix(commands: readonly CommandSpec[], prefix: readonly string[]): CommandSpec[] {
  if (prefix.length === 0) return []
  return commands.filter(
    (c) => c.path.length > prefix.length && prefix.every((seg, i) => c.path[i] === seg),
  )
}

function printGroupHelp(io: Io, prefix: readonly string[], members: readonly CommandSpec[]): void {
  io.out(`helmx ${prefix.join(' ')} — subcommands:\n\n`)
  formatCompactCommandList(io, members)
  io.out(`\nRun "helmx ${prefix.join(' ')} <subcommand> --help" for full flag details.\n`)
}

/**
 * Strip global --json/-h/--help (allowed at any position); anything after `--` is kept verbatim
 * for command-level parsing (so `send 1 -- --json` sends `--json` as message text).
 */
function extractGlobals(argv: readonly string[]): { rest: string[]; json: boolean; help: boolean } {
  const rest: string[] = []
  let json = false
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--') {
      rest.push(...argv.slice(i))
      break
    }
    if (token === '--json') json = true
    else if (token === '--help' || token === '-h') help = true
    else rest.push(token)
  }
  return { rest, json, help }
}

const isOptionLike = (token: string): boolean => token.startsWith('-') && token !== '-' && token !== '--'

/** Find an exact command match; return negative consumed count when more subcommands are needed. */
function matchCommand(
  commands: readonly CommandSpec[],
  tokens: readonly string[],
): { command: CommandSpec; consumed: number } | undefined {
  const maxDepth = Math.min(tokens.length, Math.max(...commands.map((c) => c.path.length)))
  // Try longest path first (deep commands take precedence so parent paths do not swallow subcommands)
  for (let depth = maxDepth; depth >= 1; depth--) {
    const prefix = tokens.slice(0, depth)
    const exact = commands.filter((c) => c.path.length === prefix.length && c.path.every((seg, i) => seg === prefix[i]))
    if (exact.length > 0) return { command: exact[0]!, consumed: depth }
  }
  // No exact match: try longest common prefix to hint that a subcommand is missing
  for (let depth = maxDepth; depth >= 1; depth--) {
    const prefix = tokens.slice(0, depth)
    const partial = commands.filter((c) => c.path.length > prefix.length && c.path.slice(0, prefix.length).every((seg, i) => seg === prefix[i]))
    if (partial.length > 0) {
      return { command: partial[0]!, consumed: -1 } // -1 = needs more subcommands, used for error reporting only
    }
  }
  return undefined
}

function printCommandDetail(io: Io, cmd: CommandSpec): void {
  io.out(`${cmd.path.join(' ')}${cmd.positional ? ` ${cmd.positional}` : ''}\n  ${cmd.description}\n`)
  for (const flag of cmd.flags ?? []) {
    const req = flag.required ? ' (required)' : ''
    io.out(`  --${flag.name} <${flag.type}>${req}${flag.help ? `  ${flag.help}` : ''}\n`)
  }
}

/**
 * Load credentials and build a HubClient; throws on corrupt credentials rather than treating them as missing.
 * HELMX_TOKEN takes precedence: when explicitly set, short-circuit disk access without touching credential files.
 */
async function hubFromEnv(env: NodeJS.ProcessEnv, dataDir: string, io: Io): Promise<HubClient> {
  if (env['HELMX_TOKEN']) {
    return new HubClient(resolveEndpoint(env, {}), io)
  }
  const credential = await loadCliCredential(dataDir)
  return new HubClient(resolveEndpoint(env, credential), io)
}

export async function runCli(argv: readonly string[] = [], options: RunCliOptions = {}): Promise<number> {
  const io = buildIo(options)
  const { rest, json, help } = extractGlobals(argv)
  const emitError = (described: ReturnType<typeof describeError>): number => {
    if (json) io.err(`${JSON.stringify(errorEnvelope(described))}\n`)
    else io.err(formatHumanError(described))
    return described.exitCode
  }

  const core = coreCommands()
  const corePaths = core.map((c) => c.path)
  const env = options.env ?? process.env
  const dataDir = dataDirFor(env)

  const makeContext = (): CommandContext => {
    const clientHolder: { client?: HubClient } = {}
    return {
      io,
      env,
      json,
      args: [],
      dataDir,
      cwd: options.cwd ?? process.cwd(),
      async hub() {
        if (!clientHolder.client) clientHolder.client = await hubFromEnv(env, dataDir, io)
        return clientHolder.client
      },
    }
  }

  // Help for static commands and static command groups depends only on static declarations;
  // Hub/plugin failures must not block management help.
  if (help && rest.length > 0) {
    const matched = matchCommand(core, rest)
    if (matched && matched.consumed > 0) {
      printCommandDetail(io, matched.command)
      return 0
    }
    const nonOptionPrefix = rest.filter((t) => !isOptionLike(t))
    const coreGroup = commandsUnderPrefix(core, nonOptionPrefix)
    if (coreGroup.length > 0) {
      printGroupHelp(io, nonOptionPrefix, coreGroup)
      return 0
    }
  }

  // Help / bare invocation: core help is always available; dynamic commands and credential diagnostics are fetched at most once.
  if (rest.length === 0 || help) {
    const diagnostics: string[] = []
    let dynamic: CommandSpec[] = []
    let dynamicFetched = false
    const loadDynamicOnce = async (): Promise<CommandSpec[]> => {
      if (dynamicFetched) return dynamic
      dynamicFetched = true
      try {
        dynamic = (await loadDynamicCommands(await hubFromEnv(env, dataDir, io), corePaths)).map((d) => d.spec)
      } catch (err) {
        // Help must never fail due to Hub/credential/manifest issues: fall back to core help + separate diagnostic line (stderr)
        diagnostics.push(`dynamic plugin commands unavailable: ${describeError(err).message}`)
      }
      return dynamic
    }
    if (rest.length === 0) {
      // Bare `helmx --json` is invalid (help is plain text; never fabricate JSON output)
      if (json) return emitError(describeError(new CliError('missing command (run helmx --help for usage)', 'missing_command')))
      await loadDynamicOnce()
      printHelp(io, core, dynamic, diagnostics)
      return 0
    }
    const dyn = await loadDynamicOnce()
    const dm = matchCommand(dyn, rest)
    if (dm && dm.consumed > 0) {
      printCommandDetail(io, dm.command)
      return 0
    }
    const nonOptionPrefix = rest.filter((t) => !isOptionLike(t))
    const dynGroup = commandsUnderPrefix(dyn, nonOptionPrefix)
    if (dynGroup.length > 0) {
      printGroupHelp(io, nonOptionPrefix, dynGroup)
      return 0
    }
    printHelp(io, core, dynamic, diagnostics)
    return 0
  }

  // Execute exact core command match immediately (management plane fault-isolated).
  // Note: do not reject partial subcommand prefix matches here — if a broken plugin registers a parent path
  // shadowing a core subcommand (e.g. dynamic ["asks"] shadowing `asks list`), we must detect and reject it after loading the manifest.
  const coreMatched = matchCommand(core, rest)
  if (coreMatched !== undefined && coreMatched.consumed > 0) {
    const ctx = makeContext()
    ctx.args = rest.slice(coreMatched.consumed)
    try {
      return (await coreMatched.command.run(ctx)) ?? 0
    } catch (err) {
      return emitError(describeError(err))
    }
  }

  // No exact core match: resolve dynamic commands (/api/actions + conflict check; invalid cases fail explicitly).
  // Note: if a core prefix needing more subcommands exists (e.g. `asks` from `helmx asks list`),
  // a dynamic parent-path declaration could shadow the core subcommand — reject before execution.
  const corePartial = coreMatched !== undefined && coreMatched.consumed < 0 ? coreMatched.command.path : undefined
  const nonOptionTokens = rest.filter((t) => !isOptionLike(t))
  const coreGroupMembers = commandsUnderPrefix(core, nonOptionTokens)
  const formatMissingSubcommand = (prefix: readonly string[], members: readonly CommandSpec[]): CliError => {
    const nextSegments = [...new Set(members.map((m) => m.path[prefix.length]).filter((s): s is string => s !== undefined))]
    return new CliError(
      `missing subcommand for "helmx ${prefix.join(' ')}"; available: ${nextSegments.join(', ')} (run helmx ${prefix.join(' ')} --help)`,
      'unknown_command',
    )
  }

  let dynamicSpecs: CommandSpec[]
  try {
    dynamicSpecs = (await loadDynamicCommands(await hubFromEnv(env, dataDir, io), corePaths)).map((d) => d.spec)
  } catch (err) {
    // If the user invoked a known core command group without a subcommand while offline/unauthenticated,
    // surface the missing-subcommand guidance rather than an opaque Hub connection failure.
    if (coreGroupMembers.length > 0) {
      return emitError(describeError(formatMissingSubcommand(nonOptionTokens, coreGroupMembers)))
    }
    return emitError(describeError(err))
  }
  const allCommands = [...core, ...dynamicSpecs]
  const matched = matchCommand(allCommands, rest)
  if (!matched || matched.consumed < 0) {
    const groupMembers = commandsUnderPrefix(allCommands, nonOptionTokens)
    if (groupMembers.length > 0) {
      return emitError(describeError(formatMissingSubcommand(nonOptionTokens, groupMembers)))
    }
    const head = nonOptionTokens.slice(0, 2).join(' ')
    return emitError(describeError(new CliError(`unknown command: helmx ${head || '(empty)'} (run helmx --help for available commands)`, 'unknown_command')))
  }
  // Dynamic command shadowing a core command (exact or prefix): reject explicitly rather than executing under an alias
  const isDynamic = !core.some((c) => c === matched.command)
  if (isDynamic && corePartial !== undefined) {
    const joined = matched.command.path.join(' ')
    return emitError(describeError(new CliError(
      `plugin action command "helmx ${joined}" shadows core command path "helmx ${corePartial.join(' ')}": execution refused (check plugin cli.command declaration)`,
      'command_conflict',
    )))
  }
  const ctx = makeContext()
  ctx.args = rest.slice(matched.consumed)
  try {
    return (await matched.command.run(ctx)) ?? 0
  } catch (err) {
    return emitError(describeError(err))
  }
}

if (isDirectRun()) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (err) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    },
  )
}
