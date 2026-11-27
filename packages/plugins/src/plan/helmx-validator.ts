/**
 * Strict read-only `helmx` CLI validator for `builtin:plan` (`plan_bash`).
 */
import type { ReadOnlyShellValidationResult } from './shell-scanner.js'

/** Daemon binaries with no safe read-only invocation in plan mode (`helmx-hub` ignores `--help` and starts a server). */
export const HELMX_BLOCKED_BINARIES: ReadonlySet<string> = new Set(['helmx-hub', 'helmx-node'])

const HELMX_GLOBAL_BOOL_FLAGS: ReadonlySet<string> = new Set(['json'])
const HELMX_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set(['hub', 'hub-url', 'url', 'token', 'data-dir'])

const HELMX_READONLY_SINGLE_COMMANDS: ReadonlySet<string> = new Set(['status', 'doctor', 'search', 'api'])

const HELMX_READONLY_CORE_TWO_WORD: ReadonlySet<string> = new Set([
  'conversations list',
  'conversations get',
  'conversations entry',
  'conversations file',
  'profiles list',
  'profiles get',
  'skills list',
  'skills read',
  'models list',
  'models providers',
  'models default',
  'models filter',
  'providers list',
  'credentials list',
  'asks list',
  'artifacts list',
  'artifacts get',
  'nodes list',
  'nodes forwards',
  'nodes forward-inspect',
  'nodes upgrade',
  'plugins list',
  'plugins manifest',
  'plugins client',
  'plugins doctor',
  'plugins config',
  'plugins doc',
  'actions list',
])

const HELMX_READONLY_PLUGIN_TWO_WORD: ReadonlySet<string> = new Set([
  'plan get',
  'memory get',
  'memory dream_status',
  'tiers list',
  'magpie status',
  'magpie quota',
  'cron list',
  'webhook list',
  'workflows list',
  'workflows get',
  'workflows runs',
  'workflows inspect',
  'worktrees list',
  'worktrees inspect',
  'worktrees file',
  'changes inspect',
  'changes file',
  'swarm board-read',
  'swarm board-status',
  'swarm inspect-worker',
  'swarm list-groups',
  'profile list_mentionable',
  'profile skill_catalog',
  'profile skill_read',
])

const HELMX_TWO_WORD_GROUPS: ReadonlySet<string> = new Set(
  [...HELMX_READONLY_CORE_TWO_WORD, ...HELMX_READONLY_PLUGIN_TWO_WORD].map(
    (cmd) => cmd.slice(0, cmd.indexOf(' ')),
  ),
)

/** Flags that mutate Hub state, write local files, or stream indefinitely on `helmx` subcommands. */
const HELMX_ALWAYS_BLOCKED_FLAGS: ReadonlySet<string> = new Set([
  'output',
  'set',
  'unset',
  'disable',
  'clear',
  'delete',
  'force',
  'yes',
  'attach',
  'replace-from',
  'wait',
  'field',
  'thinking',
  'model-thinking',
  'compaction',
  'compaction-thinking',
  'watch',
])

/** Known value-taking flags across global and allowed read-only `helmx` commands so values are never misread as positionals/flags. */
const HELMX_VALUE_FLAGS: ReadonlySet<string> = new Set([
  ...HELMX_GLOBAL_VALUE_FLAGS,
  'profile',
  'profile-id',
  'conversation',
  'conversation-id',
  'node',
  'node-id',
  'cwd',
  'limit',
  'max-per-conversation',
  'cursor',
  'parent',
  'path',
  'status',
  'tag',
  'owned-by',
  'format',
  'group-id',
  'run-id',
  'worktree-id',
  'file-path',
  'old-path',
  'scope',
  'commit',
  'base-commit',
  'context-lines',
  'worker-conversation-id',
  'member-name',
  'coordinator-conversation-id',
  'since-seq',
  'seqs',
  'model',
  'name',
  'id',
  'query',
  'skill-id',
  'module',
  'chunk',
  'registry',
  'input',
])

/** Dual read/write core commands whose read-only mode accepts only global flags (rejects any write/unknown flag, fail-closed). */
const HELMX_GLOBAL_ONLY_FLAG_COMMANDS: ReadonlySet<string> = new Set([
  'api',
  'models default',
  'models filter',
  'plugins config',
])

const HELMX_NODES_UPGRADE_ALLOWED_FLAGS: ReadonlySet<string> = new Set([
  ...HELMX_GLOBAL_BOOL_FLAGS,
  ...HELMX_GLOBAL_VALUE_FLAGS,
  'check',
  'current',
  'registry',
])

interface ParsedHelmxFlag {
  name: string
  inline: string | undefined
  raw: string
  isShort: boolean
}

function isCleanHelmxHelp(args: readonly string[]): boolean {
  let hasHelp = false
  for (const tok of args) {
    if (tok === '--') return false
    if (tok === '--help' || tok === '-h') {
      hasHelp = true
      continue
    }
    if (tok === '--json') continue
    if (tok.startsWith('-')) return false
  }
  return hasHelp
}

function isCleanHelmxVersion(args: readonly string[]): boolean {
  let hasVersion = false
  for (const tok of args) {
    if (tok === '--version' || tok === '-V') {
      hasVersion = true
      continue
    }
    if (tok === '--json') continue
    return false
  }
  return hasVersion
}

function consumeHelmxGlobalOption(
  args: readonly string[],
  idx: number,
): { consumed: number } | { error: string } | undefined {
  const tok = args[idx]
  if (tok === undefined) return undefined
  if (tok === '--json') return { consumed: 1 }
  if (!tok.startsWith('--') || tok.length <= 2) return undefined
  const eq = tok.indexOf('=')
  const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq)
  if (!HELMX_GLOBAL_VALUE_FLAGS.has(name)) return undefined
  if (eq !== -1) return { consumed: 1 }
  const next = args[idx + 1]
  if (next === undefined || next === '--' || (next.startsWith('--') && next.length > 2)) {
    return { error: `helmx option '--${name}' is missing a value` }
  }
  return { consumed: 2 }
}

function skipHelmxGlobalOptions(
  args: readonly string[],
  startIdx: number,
): { nextIdx: number } | { error: string } {
  let idx = startIdx
  while (idx < args.length) {
    const consumed = consumeHelmxGlobalOption(args, idx)
    if (consumed === undefined) break
    if ('error' in consumed) return consumed
    idx += consumed.consumed
  }
  return { nextIdx: idx }
}

function nextHelmxSubcommandWord(
  args: readonly string[],
  startIdx: number,
  groupPrefix?: string,
): { ok: true; word: string; nextIdx: number } | { ok: false; reason: string } {
  const skipped = skipHelmxGlobalOptions(args, startIdx)
  if ('error' in skipped) return { ok: false, reason: skipped.error }
  const idx = skipped.nextIdx
  const label = groupPrefix !== undefined ? `helmx ${groupPrefix}` : 'helmx'
  const word = args[idx]
  if (word === undefined) {
    return {
      ok: false,
      reason: `${label} requires an allowlisted read-only subcommand in read-only plan mode`,
    }
  }
  if (word === '--' || word.startsWith('-')) {
    return {
      ok: false,
      reason: `${label} option '${word}' before subcommand is not allowed in read-only plan mode`,
    }
  }
  return { ok: true, word, nextIdx: idx + 1 }
}

function parseHelmxSubArgs(
  subArgs: readonly string[],
): { ok: true; flags: ParsedHelmxFlag[]; positionals: string[] } | { ok: false; reason: string } {
  const flags: ParsedHelmxFlag[] = []
  const positionals: string[] = []
  let i = 0
  while (i < subArgs.length) {
    const tok = subArgs[i]
    if (tok === undefined) break
    if (tok === '--') {
      positionals.push(...subArgs.slice(i + 1))
      break
    }
    if (tok.startsWith('--') && tok.length > 2) {
      const eq = tok.indexOf('=')
      const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq)
      const inline = eq === -1 ? undefined : tok.slice(eq + 1)
      flags.push({ name, inline, raw: tok, isShort: false })
      if (inline === undefined && HELMX_VALUE_FLAGS.has(name)) {
        const next = subArgs[i + 1]
        if (next === undefined || next === '--' || (next.startsWith('--') && next.length > 2)) {
          return { ok: false, reason: `helmx option '--${name}' is missing a value` }
        }
        i += 2
        continue
      }
      i += 1
      continue
    }
    if (tok.startsWith('-') && !tok.startsWith('--') && tok.length >= 2) {
      if (tok === '-o' || tok.startsWith('-o')) {
        return { ok: false, reason: `helmx option '${tok}' writes local files and is blocked in read-only plan mode` }
      }
      flags.push({ name: tok.slice(1), inline: undefined, raw: tok, isShort: true })
      i += 1
      continue
    }
    positionals.push(tok)
    i += 1
  }
  return { ok: true, flags, positionals }
}

export function validateHelmxArgs(args: readonly string[]): ReadOnlyShellValidationResult {
  if (args.length === 0 || isCleanHelmxHelp(args) || isCleanHelmxVersion(args)) {
    return { ok: true }
  }

  const firstRes = nextHelmxSubcommandWord(args, 0)
  if (!firstRes.ok) return firstRes
  const first = firstRes.word
  let idx = firstRes.nextIdx

  let commandKey: string
  let isPluginCommand = false
  if (HELMX_READONLY_SINGLE_COMMANDS.has(first)) {
    commandKey = first
  } else if (HELMX_TWO_WORD_GROUPS.has(first)) {
    const secondRes = nextHelmxSubcommandWord(args, idx, first)
    if (!secondRes.ok) return secondRes
    idx = secondRes.nextIdx
    commandKey = `${first} ${secondRes.word}`
    if (HELMX_READONLY_CORE_TWO_WORD.has(commandKey)) {
      isPluginCommand = false
    } else if (HELMX_READONLY_PLUGIN_TWO_WORD.has(commandKey)) {
      isPluginCommand = true
    } else {
      return { ok: false, reason: `helmx ${commandKey} is not allowed in read-only plan mode` }
    }
  } else {
    return { ok: false, reason: `helmx ${first} is not allowed in read-only plan mode` }
  }

  const parsed = parseHelmxSubArgs(args.slice(idx))
  if (!parsed.ok) return parsed

  for (const flag of parsed.flags) {
    if (!flag.isShort && HELMX_ALWAYS_BLOCKED_FLAGS.has(flag.name)) {
      return { ok: false, reason: `helmx ${commandKey} option '--${flag.name}' is blocked in read-only plan mode` }
    }
    if (!isPluginCommand && !flag.isShort && flag.name === 'input') {
      return { ok: false, reason: `helmx ${commandKey} option '--input' is blocked in read-only plan mode` }
    }
  }

  if (HELMX_GLOBAL_ONLY_FLAG_COMMANDS.has(commandKey)) {
    for (const flag of parsed.flags) {
      if (flag.isShort || (!HELMX_GLOBAL_BOOL_FLAGS.has(flag.name) && !HELMX_GLOBAL_VALUE_FLAGS.has(flag.name))) {
        return { ok: false, reason: `helmx ${commandKey} option '${flag.raw}' is not allowed in read-only plan mode` }
      }
    }
  }

  if (commandKey === 'api') {
    const method = parsed.positionals[0]
    if (method === undefined) {
      return { ok: false, reason: 'helmx api requires HTTP method GET and a path in read-only plan mode' }
    }
    if (method.toUpperCase() !== 'GET') {
      return { ok: false, reason: `helmx api ${method.toUpperCase()} is blocked in read-only plan mode (only GET is allowed)` }
    }
    if (parsed.positionals.length !== 2) {
      return { ok: false, reason: 'helmx api GET requires a single <path> argument in read-only plan mode' }
    }
  } else if (commandKey === 'nodes upgrade') {
    let checkEnabled = false
    for (const flag of parsed.flags) {
      if (flag.isShort || !HELMX_NODES_UPGRADE_ALLOWED_FLAGS.has(flag.name)) {
        return { ok: false, reason: `helmx nodes upgrade option '${flag.raw}' is blocked in read-only plan mode` }
      }
      if (flag.name === 'check') {
        if (flag.inline !== undefined && flag.inline !== 'true') {
          return { ok: false, reason: `helmx nodes upgrade requires '--check' in read-only plan mode (got '${flag.raw}')` }
        }
        checkEnabled = true
      }
    }
    if (!checkEnabled) {
      return { ok: false, reason: 'helmx nodes upgrade requires --check in read-only plan mode' }
    }
  }

  return { ok: true }
}
