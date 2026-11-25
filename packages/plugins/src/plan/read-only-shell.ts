/**
 * Quote-aware read-only shell command validator for `builtin:plan` (`plan_bash`).
 *
 * Rejects file redirections (other than `/dev/null` and fd dups like `2>&1`),
 * mutating/destructive commands, in-place file edits, and write git/package-manager
 * subcommands, while never mis-triggering on keywords inside quoted arguments
 * (e.g. `rg "rm -rf" src/` or `git log --grep="commit"`).
 */

export type ReadOnlyShellValidationResult =
  | { ok: true }
  | { ok: false; reason: string }

interface ShellToken {
  kind: 'word' | 'op'
  value: string
  quoted: boolean
}

const MUTATING_COMMANDS: ReadonlySet<string> = new Set([
  'rm',
  'rmdir',
  'mv',
  'cp',
  'mkdir',
  'touch',
  'chmod',
  'chown',
  'chgrp',
  'ln',
  'dd',
  'truncate',
  'tee',
  'install',
  'patch',
  'mktemp',
  'shred',
  'unlink',
  'sudo',
  'su',
  'doas',
  'kill',
  'pkill',
  'killall',
  'wget',
  'apt',
  'apt-get',
  'yum',
  'dnf',
  'pacman',
  'apk',
  'ed',
  'ex',
  'vi',
  'vim',
  'nano',
  'emacs',
  'eval',
  'source',
  '.',
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
])

const GIT_GLOBAL_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--exec-path',
])

const GIT_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'add',
  'am',
  'apply',
  'bisect',
  'checkout',
  'cherry-pick',
  'clean',
  'clone',
  'commit',
  'init',
  'merge',
  'mv',
  'pull',
  'push',
  'rebase',
  'reset',
  'restore',
  'revert',
  'rm',
  'switch',
])

const GIT_BRANCH_WRITE_FLAGS: ReadonlySet<string> = new Set([
  '-d',
  '-D',
  '-m',
  '-M',
  '-c',
  '-C',
  '-f',
  '--delete',
  '--move',
  '--copy',
  '--force',
  '--set-upstream-to',
  '--unset-upstream',
  '--edit-description',
])

const GIT_BRANCH_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at',
  '--sort',
  '--format',
  '--color',
  '--column',
])

const GIT_TAG_WRITE_FLAGS: ReadonlySet<string> = new Set([
  '-d',
  '-a',
  '-s',
  '-u',
  '-f',
  '-m',
  '-F',
  '--delete',
  '--annotate',
  '--sign',
  '--local-user',
  '--force',
  '--file',
  '--message',
])

const NODE_PM_COMMANDS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const NODE_PM_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'install',
  'i',
  'ci',
  'add',
  'remove',
  'rm',
  'uninstall',
  'un',
  'update',
  'up',
  'upgrade',
  'publish',
  'link',
  'unlink',
  'init',
  'create',
  'build',
  'prune',
  'dedupe',
  'dlx',
  'exec',
  'x',
])

const BREW_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'install',
  'uninstall',
  'remove',
  'rm',
  'upgrade',
  'reinstall',
  'link',
  'unlink',
  'tap',
  'untap',
  'cleanup',
])

const PIP_COMMANDS: ReadonlySet<string> = new Set(['pip', 'pip3'])
const PIP_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set(['install', 'uninstall'])

const CARGO_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'install',
  'uninstall',
  'publish',
  'add',
  'remove',
  'build',
  'run',
  'clean',
])

const DOCKER_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'run',
  'exec',
  'rm',
  'rmi',
  'build',
  'stop',
  'kill',
  'prune',
  'create',
  'start',
  'restart',
  'cp',
  'push',
  'pull',
])

const CURL_MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'DELETE', 'PATCH'])

/** Daemon binaries with no safe read-only invocation in plan mode (`helmx-hub` ignores `--help` and starts a server). */
const HELMX_BLOCKED_BINARIES: ReadonlySet<string> = new Set(['helmx-hub', 'helmx-node'])

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
  'swarm board-read',
  'swarm board-status',
  'swarm inspect-worker',
  'swarm list-groups',
  'profile list_mentionable',
  'profile skill_catalog',
  'profile skill_read',
])

const HELMX_TWO_WORD_GROUPS: ReadonlySet<string> = new Set(
  [...HELMX_READONLY_CORE_TWO_WORD, ...HELMX_READONLY_PLUGIN_TWO_WORD].map((cmd) => cmd.split(' ', 1)[0]!),
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

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

function commandBaseName(cmd: string): string {
  const idx = Math.max(cmd.lastIndexOf('/'), cmd.lastIndexOf('\\'))
  const base = idx >= 0 ? cmd.slice(idx + 1) : cmd
  return base.replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase()
}

function skipBalancedParen(
  input: string,
  startIdx: number,
): { endIdx: number; inner: string } | { error: string } {
  let depth = 1
  let i = startIdx
  let inSingle = false
  let inDouble = false
  while (i < input.length) {
    const ch = input[i]!
    if (inSingle) {
      if (ch === "'") inSingle = false
      i += 1
      continue
    }
    if (inDouble) {
      if (ch === '\\' && i + 1 < input.length) {
        i += 2
        continue
      }
      if (ch === '"') {
        inDouble = false
        i += 1
        continue
      }
      if (ch === '$' && input[i + 1] === '(') {
        const nested = skipBalancedParen(input, i + 2)
        if ('error' in nested) return nested
        i = nested.endIdx + 1
        continue
      }
      i += 1
      continue
    }
    if (ch === '\\' && i + 1 < input.length) {
      i += 2
      continue
    }
    if (ch === "'") {
      inSingle = true
      i += 1
      continue
    }
    if (ch === '"') {
      inDouble = true
      i += 1
      continue
    }
    if (ch === '$' && input[i + 1] === '(') {
      depth += 1
      i += 2
      continue
    }
    if (ch === '(') {
      depth += 1
      i += 1
      continue
    }
    if (ch === ')') {
      depth -= 1
      if (depth === 0) {
        return { endIdx: i, inner: input.slice(startIdx, i) }
      }
      i += 1
      continue
    }
    i += 1
  }
  return { error: 'unclosed subshell or command substitution' }
}

function skipBacktick(
  input: string,
  startIdx: number,
): { endIdx: number; inner: string } | { error: string } {
  let i = startIdx
  let inner = ''
  while (i < input.length) {
    const ch = input[i]!
    if (ch === '\\' && i + 1 < input.length) {
      inner += input[i + 1]!
      i += 2
      continue
    }
    if (ch === '`') {
      return { endIdx: i, inner }
    }
    inner += ch
    i += 1
  }
  return { error: 'unclosed backtick command substitution' }
}

function scanShell(
  input: string,
): { tokens: ShellToken[]; substitutions: string[] } | { error: string } {
  const tokens: ShellToken[] = []
  const substitutions: string[] = []
  let buf = ''
  let hasWord = false
  let wordQuoted = false

  const flushWord = (): void => {
    if (!hasWord) return
    tokens.push({ kind: 'word', value: buf, quoted: wordQuoted })
    buf = ''
    hasWord = false
    wordQuoted = false
  }

  let i = 0
  while (i < input.length) {
    const ch = input[i]!

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flushWord()
      i += 1
      continue
    }

    if (ch === '#' && !hasWord) {
      while (i < input.length && input[i] !== '\n') i += 1
      continue
    }

    if (ch === '\n' || ch === ';') {
      flushWord()
      tokens.push({ kind: 'op', value: ch, quoted: false })
      i += 1
      continue
    }

    if (ch === "'" ) {
      hasWord = true
      wordQuoted = true
      i += 1
      let closed = false
      while (i < input.length) {
        const c = input[i]!
        if (c === "'") {
          closed = true
          i += 1
          break
        }
        buf += c
        i += 1
      }
      if (!closed) return { error: 'unclosed single quote' }
      continue
    }

    if (ch === '"') {
      hasWord = true
      wordQuoted = true
      i += 1
      let closed = false
      while (i < input.length) {
        const c = input[i]!
        if (c === '"') {
          closed = true
          i += 1
          break
        }
        if (c === '\\' && i + 1 < input.length) {
          buf += input[i + 1]!
          i += 2
          continue
        }
        if (c === '$' && input[i + 1] === '(') {
          if (input[i + 2] === '(') {
            // Arithmetic expansion $((...))
            const arith = skipBalancedParen(input, i + 2)
            if ('error' in arith) return arith
            buf += input.slice(i, arith.endIdx + 1)
            i = arith.endIdx + 1
            continue
          }
          const sub = skipBalancedParen(input, i + 2)
          if ('error' in sub) return sub
          substitutions.push(sub.inner)
          buf += input.slice(i, sub.endIdx + 1)
          i = sub.endIdx + 1
          continue
        }
        if (c === '`') {
          const sub = skipBacktick(input, i + 1)
          if ('error' in sub) return sub
          substitutions.push(sub.inner)
          buf += input.slice(i, sub.endIdx + 1)
          i = sub.endIdx + 1
          continue
        }
        buf += c
        i += 1
      }
      if (!closed) return { error: 'unclosed double quote' }
      continue
    }

    if (ch === '\\') {
      if (i + 1 < input.length) {
        hasWord = true
        buf += input[i + 1]!
        i += 2
      } else {
        i += 1
      }
      continue
    }

    if (ch === '$' && input[i + 1] === '(') {
      if (input[i + 2] === '(') {
        const arith = skipBalancedParen(input, i + 2)
        if ('error' in arith) return arith
        hasWord = true
        buf += input.slice(i, arith.endIdx + 1)
        i = arith.endIdx + 1
        continue
      }
      const sub = skipBalancedParen(input, i + 2)
      if ('error' in sub) return sub
      substitutions.push(sub.inner)
      hasWord = true
      buf += input.slice(i, sub.endIdx + 1)
      i = sub.endIdx + 1
      continue
    }

    if (ch === '`') {
      const sub = skipBacktick(input, i + 1)
      if ('error' in sub) return sub
      substitutions.push(sub.inner)
      hasWord = true
      buf += input.slice(i, sub.endIdx + 1)
      i = sub.endIdx + 1
      continue
    }

    if ((ch === '<' || ch === '>') && input[i + 1] === '(') {
      if (ch === '>') return { error: 'output process substitution >(...) is not allowed in read-only mode' }
      const sub = skipBalancedParen(input, i + 2)
      if ('error' in sub) return sub
      substitutions.push(sub.inner)
      hasWord = true
      buf += input.slice(i, sub.endIdx + 1)
      i = sub.endIdx + 1
      continue
    }

    // Compound operators & redirections
    if (ch === '&' && input[i + 1] === '&') {
      flushWord()
      tokens.push({ kind: 'op', value: '&&', quoted: false })
      i += 2
      continue
    }
    if (ch === '|' && input[i + 1] === '|') {
      flushWord()
      tokens.push({ kind: 'op', value: '||', quoted: false })
      i += 2
      continue
    }
    if (ch === '|' && input[i + 1] === '&') {
      flushWord()
      tokens.push({ kind: 'op', value: '|&', quoted: false })
      i += 2
      continue
    }
    if (ch === '|') {
      flushWord()
      tokens.push({ kind: 'op', value: '|', quoted: false })
      i += 1
      continue
    }
    if (ch === '&' && input[i + 1] === '>') {
      flushWord()
      const op = input[i + 2] === '>' ? '&>>' : '&>'
      tokens.push({ kind: 'op', value: op, quoted: false })
      i += op.length
      continue
    }
    if (ch === '&') {
      flushWord()
      tokens.push({ kind: 'op', value: '&', quoted: false })
      i += 1
      continue
    }

    // Output fd redirections like `2>&1`, `1>&2`, `2>`, `1>>`, `>|`, `>>`, `>`
    if (!hasWord && (ch === '1' || ch === '2') && input[i + 1] === '>') {
      const rest = input.slice(i)
      if (rest.startsWith('2>&1') || rest.startsWith('1>&2')) {
        tokens.push({ kind: 'op', value: rest.slice(0, 4), quoted: false })
        i += 4
        continue
      }
      const op = input[i + 2] === '>' ? `${ch}>>` : input[i + 2] === '|' ? `${ch}>|` : `${ch}>`
      tokens.push({ kind: 'op', value: op, quoted: false })
      i += op.length
      continue
    }

    if (ch === '>') {
      flushWord()
      const rest = input.slice(i)
      if (rest.startsWith('>&2') || rest.startsWith('>&1')) {
        tokens.push({ kind: 'op', value: rest.slice(0, 3), quoted: false })
        i += 3
        continue
      }
      const op = input[i + 1] === '>' ? '>>' : input[i + 1] === '|' ? '>|' : '>'
      tokens.push({ kind: 'op', value: op, quoted: false })
      i += op.length
      continue
    }

    if (ch === '<') {
      flushWord()
      const op = input.slice(i).startsWith('<<<') ? '<<<' : input[i + 1] === '<' ? '<<' : '<'
      tokens.push({ kind: 'op', value: op, quoted: false })
      i += op.length
      continue
    }

    if (ch === '(' || ch === ')') {
      flushWord()
      tokens.push({ kind: 'op', value: ch, quoted: false })
      i += 1
      continue
    }

    hasWord = true
    buf += ch
    i += 1
  }

  flushWord()
  return { tokens, substitutions }
}

const SEGMENT_SEPARATORS: ReadonlySet<string> = new Set(['|', '|&', '&&', '||', ';', '\n', '&'])
const REDIRECT_OUT_OPS: ReadonlySet<string> = new Set(['>', '>>', '>|', '&>', '&>>', '1>', '1>>', '1>|', '2>', '2>>', '2>|'])
const ALLOWED_FD_DUPS: ReadonlySet<string> = new Set(['2>&1', '1>&2', '>&1', '>&2'])

function splitSegments(tokens: ShellToken[]): ShellToken[][] {
  const segments: ShellToken[][] = []
  let current: ShellToken[] = []
  for (const tok of tokens) {
    if (tok.kind === 'op' && SEGMENT_SEPARATORS.has(tok.value)) {
      if (current.length > 0) {
        segments.push(current)
        current = []
      }
      continue
    }
    current.push(tok)
  }
  if (current.length > 0) segments.push(current)
  return segments
}

function validateGitArgs(args: string[]): ReadOnlyShellValidationResult {
  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg === '--') {
      i += 1
      break
    }
    if (GIT_GLOBAL_FLAGS_WITH_VALUE.has(arg)) {
      i += 2
      continue
    }
    if (arg.startsWith('-')) {
      i += 1
      continue
    }
    break
  }

  const sub = args[i]
  if (sub === undefined) return { ok: true }
  if (GIT_WRITE_SUBCOMMANDS.has(sub)) {
    return { ok: false, reason: `git ${sub} mutates the repository` }
  }
  const subArgs = args.slice(i + 1)

  if (sub === 'stash') {
    const action = subArgs.find((a) => !a.startsWith('-'))
    if (action !== 'list' && action !== 'show') {
      return { ok: false, reason: `git stash ${action ?? '(default push)'} mutates stash state` }
    }
  } else if (sub === 'worktree') {
    const action = subArgs.find((a) => !a.startsWith('-'))
    if (action !== 'list') {
      return { ok: false, reason: `git worktree ${action ?? ''} is not allowed in read-only mode`.trim() }
    }
  } else if (sub === 'submodule') {
    const action = subArgs.find((a) => !a.startsWith('-'))
    if (action !== undefined && action !== 'status' && action !== 'summary') {
      return { ok: false, reason: `git submodule ${action} is not allowed in read-only mode` }
    }
  } else if (sub === 'config') {
    const isRead = subArgs.some((a) => a === '--get' || a === '--get-all' || a === '--get-regexp' || a === '--list' || a === '-l')
    const hasWrite = subArgs.some((a) =>
      a === '--unset' || a === '--unset-all' || a === '--replace-all' || a === '--add' || a === '--remove-section' || a === '--rename-section',
    )
    if (!isRead || hasWrite) {
      return { ok: false, reason: 'git config write operations are not allowed in read-only mode' }
    }
  } else if (sub === 'branch') {
    let j = 0
    while (j < subArgs.length) {
      const a = subArgs[j]!
      if (GIT_BRANCH_WRITE_FLAGS.has(a) || a.startsWith('--delete=') || a.startsWith('--set-upstream-to=')) {
        return { ok: false, reason: `git branch ${a} mutates branches` }
      }
      if (GIT_BRANCH_VALUE_FLAGS.has(a)) {
        j += 2
        continue
      }
      if (a.startsWith('-')) {
        j += 1
        continue
      }
      return { ok: false, reason: `git branch creation/modification (${a}) is not allowed in read-only mode` }
    }
  } else if (sub === 'tag') {
    const hasReadFlag = subArgs.some((a) => a === '-l' || a === '--list' || a === '-v' || a === '--verify')
    const hasWriteFlag = subArgs.some((a) => GIT_TAG_WRITE_FLAGS.has(a))
    const hasPositional = subArgs.some((a) => !a.startsWith('-'))
    if (hasWriteFlag || (!hasReadFlag && hasPositional)) {
      return { ok: false, reason: 'git tag creation/deletion is not allowed in read-only mode' }
    }
  } else if (sub === 'remote') {
    const action = subArgs.find((a) => !a.startsWith('-'))
    if (action !== undefined && action !== 'show' && action !== 'get-url') {
      return { ok: false, reason: `git remote ${action} mutates remotes` }
    }
  }

  return { ok: true }
}

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
  const tok = args[idx]!
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

function parseHelmxSubArgs(
  subArgs: readonly string[],
): { ok: true; flags: ParsedHelmxFlag[]; positionals: string[] } | { ok: false; reason: string } {
  const flags: ParsedHelmxFlag[] = []
  const positionals: string[] = []
  let i = 0
  while (i < subArgs.length) {
    const tok = subArgs[i]!
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

function validateHelmxArgs(args: readonly string[]): ReadOnlyShellValidationResult {
  if (args.length === 0 || isCleanHelmxHelp(args) || isCleanHelmxVersion(args)) {
    return { ok: true }
  }

  let idx = 0
  while (idx < args.length) {
    const consumed = consumeHelmxGlobalOption(args, idx)
    if (consumed === undefined) break
    if ('error' in consumed) return { ok: false, reason: consumed.error }
    idx += consumed.consumed
  }

  if (idx >= args.length) {
    return { ok: false, reason: 'helmx requires an allowlisted read-only subcommand in read-only plan mode' }
  }

  const first = args[idx]!
  if (first === '--' || first.startsWith('-')) {
    return { ok: false, reason: `helmx option '${first}' before subcommand is not allowed in read-only plan mode` }
  }
  idx += 1

  let commandKey: string
  let isPluginCommand = false
  if (HELMX_READONLY_SINGLE_COMMANDS.has(first)) {
    commandKey = first
  } else if (HELMX_TWO_WORD_GROUPS.has(first)) {
    while (idx < args.length) {
      const consumed = consumeHelmxGlobalOption(args, idx)
      if (consumed === undefined) break
      if ('error' in consumed) return { ok: false, reason: consumed.error }
      idx += consumed.consumed
    }
    if (idx >= args.length) {
      return { ok: false, reason: `helmx ${first} requires an allowlisted read-only subcommand in read-only plan mode` }
    }
    const second = args[idx]!
    if (second === '--' || second.startsWith('-')) {
      return { ok: false, reason: `helmx ${first} option '${second}' before subcommand is not allowed in read-only plan mode` }
    }
    idx += 1
    commandKey = `${first} ${second}`
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

function validateWordSequence(words: string[]): ReadOnlyShellValidationResult {
  let idx = 0
  while (idx < words.length) {
    const w = words[idx]!
    if (ENV_ASSIGN_RE.test(w)) {
      idx += 1
      continue
    }
    const base = commandBaseName(w)
    if (base === 'command' || base === 'time' || base === 'nohup') {
      idx += 1
      while (idx < words.length && words[idx]!.startsWith('-')) idx += 1
      continue
    }
    if (base === 'nice') {
      idx += 1
      while (idx < words.length) {
        const arg = words[idx]!
        if (arg === '--') {
          idx += 1
          break
        }
        if (arg === '-n' || arg === '--adjustment') {
          idx += 2
          continue
        }
        if (arg.startsWith('-')) {
          idx += 1
          continue
        }
        break
      }
      continue
    }
    if (base === 'exec') {
      idx += 1
      while (idx < words.length) {
        const arg = words[idx]!
        if (arg === '--') {
          idx += 1
          break
        }
        if (arg === '-a') {
          idx += 2
          continue
        }
        if (arg.startsWith('-')) {
          idx += 1
          continue
        }
        break
      }
      continue
    }
    if (base === 'env') {
      idx += 1
      while (idx < words.length) {
        const arg = words[idx]!
        if (arg === '--') {
          idx += 1
          break
        }
        if (arg === '-S' || arg.startsWith('-S') || arg === '--split-string' || arg.startsWith('--split-string=')) {
          return { ok: false, reason: `env flag '${arg}' is blocked in read-only mode` }
        }
        if (arg === '-u' || arg === '--unset' || arg === '-C' || arg === '--chdir') {
          idx += 2
          continue
        }
        if (arg.startsWith('-') || ENV_ASSIGN_RE.test(arg)) {
          idx += 1
          continue
        }
        break
      }
      continue
    }
    break
  }

  if (idx >= words.length) return { ok: true }
  const cmd = commandBaseName(words[idx]!)
  const args = words.slice(idx + 1)

  if (MUTATING_COMMANDS.has(cmd) || HELMX_BLOCKED_BINARIES.has(cmd)) {
    return { ok: false, reason: `command '${cmd}' is blocked in read-only plan mode` }
  }

  if (cmd === 'helmx') {
    return validateHelmxArgs(args)
  }

  if (cmd === 'xargs') {
    let i = 0
    while (i < args.length) {
      const a = args[i]!
      if (a === '--') {
        i += 1
        break
      }
      if (
        a === '-n' ||
        a === '-I' ||
        a === '-L' ||
        a === '-P' ||
        a === '-d' ||
        a === '-E' ||
        a === '-s' ||
        a === '-a' ||
        a === '--arg-file' ||
        a === '--max-args' ||
        a === '--max-procs' ||
        a === '--replace' ||
        a === '--delimiter'
      ) {
        i += 2
        continue
      }
      if (a.startsWith('-')) {
        i += 1
        continue
      }
      break
    }
    const targetWords = args.slice(i)
    if (targetWords.length > 0) {
      return validateWordSequence(targetWords)
    }
    return { ok: true }
  }

  if (cmd === 'sed') {
    let i = 0
    while (i < args.length) {
      const a = args[i]!
      if (a === '--') break
      if (a === '-e' || a === '-f' || a === '--expression' || a === '--file') {
        i += 2
        continue
      }
      if (a === '-i' || a === '--in-place' || a.startsWith('--in-place=')) {
        return { ok: false, reason: 'sed in-place editing (-i / --in-place) is blocked in read-only mode' }
      }
      if (a.startsWith('-') && !a.startsWith('--') && a.slice(1).includes('i')) {
        return { ok: false, reason: `sed flag '${a}' enables in-place editing` }
      }
      i += 1
    }
    return { ok: true }
  }

  if (cmd === 'perl' || cmd === 'ruby') {
    for (const a of args) {
      if (a === '--' || a === '-e' || a === '-E') break
      if (a === '-i' || a.startsWith('-i') || (a.startsWith('-') && !a.startsWith('--') && a.slice(1).includes('i'))) {
        return { ok: false, reason: `${cmd} in-place editing (-i) is blocked in read-only mode` }
      }
    }
    return { ok: true }
  }

  if (cmd === 'find') {
    for (const a of args) {
      if (
        a === '-delete' ||
        a === '-exec' ||
        a === '-execdir' ||
        a === '-ok' ||
        a === '-okdir' ||
        a === '-fprint' ||
        a === '-fprintf' ||
        a === '-fls'
      ) {
        return { ok: false, reason: `find action '${a}' is blocked in read-only mode` }
      }
    }
    return { ok: true }
  }

  if (cmd === 'curl') {
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i]!
      if (
        a === '-o' ||
        a === '--output' ||
        a === '-O' ||
        a === '--remote-name' ||
        a === '-d' ||
        a === '--data' ||
        a === '--data-raw' ||
        a === '--data-binary' ||
        a === '--data-urlencode' ||
        a === '-F' ||
        a === '--form' ||
        a === '-T' ||
        a === '--upload-file' ||
        a.startsWith('--output=') ||
        a.startsWith('--data=')
      ) {
        return { ok: false, reason: `curl flag '${a}' writes files or sends mutating payloads` }
      }
      if (a === '-X' || a === '--request') {
        const method = (args[i + 1] ?? '').toUpperCase()
        if (CURL_MUTATING_METHODS.has(method)) {
          return { ok: false, reason: `curl -X ${method} is blocked in read-only mode` }
        }
        i += 1
      } else if (a.startsWith('-X') && CURL_MUTATING_METHODS.has(a.slice(2).toUpperCase())) {
        return { ok: false, reason: `curl ${a} is blocked in read-only mode` }
      }
    }
    return { ok: true }
  }

  if (cmd === 'git') {
    return validateGitArgs(args)
  }

  if (NODE_PM_COMMANDS.has(cmd)) {
    const sub = args.find((a) => !a.startsWith('-'))
    if (sub !== undefined && NODE_PM_WRITE_SUBCOMMANDS.has(sub)) {
      return { ok: false, reason: `${cmd} ${sub} mutates dependencies or build output` }
    }
    return { ok: true }
  }

  if (cmd === 'brew') {
    const sub = args.find((a) => !a.startsWith('-'))
    if (sub !== undefined && BREW_WRITE_SUBCOMMANDS.has(sub)) {
      return { ok: false, reason: `brew ${sub} is blocked in read-only mode` }
    }
    return { ok: true }
  }

  if (PIP_COMMANDS.has(cmd) || cmd === 'uv') {
    const firstNonFlag = args.find((a) => !a.startsWith('-'))
    const targetSub =
      cmd === 'uv' && firstNonFlag === 'pip'
        ? args.slice(args.indexOf('pip') + 1).find((a) => !a.startsWith('-'))
        : firstNonFlag
    if (
      targetSub !== undefined &&
      (PIP_WRITE_SUBCOMMANDS.has(targetSub) || (cmd === 'uv' && (targetSub === 'add' || targetSub === 'remove' || targetSub === 'sync')))
    ) {
      return { ok: false, reason: `${cmd} ${targetSub} mutates packages` }
    }
    return { ok: true }
  }

  if (cmd === 'cargo') {
    const sub = args.find((a) => !a.startsWith('-'))
    if (sub !== undefined && CARGO_WRITE_SUBCOMMANDS.has(sub)) {
      return { ok: false, reason: `cargo ${sub} is blocked in read-only mode` }
    }
    return { ok: true }
  }

  if (cmd === 'docker') {
    const sub = args.find((a) => !a.startsWith('-'))
    if (sub !== undefined && DOCKER_WRITE_SUBCOMMANDS.has(sub)) {
      return { ok: false, reason: `docker ${sub} is blocked in read-only mode` }
    }
    return { ok: true }
  }

  return { ok: true }
}

function validateSegment(segment: ShellToken[]): ReadOnlyShellValidationResult {
  const words: string[] = []
  let i = 0
  while (i < segment.length) {
    const tok = segment[i]!
    if (tok.kind === 'op') {
      if (ALLOWED_FD_DUPS.has(tok.value)) {
        i += 1
        continue
      }
      if (REDIRECT_OUT_OPS.has(tok.value)) {
        const target = segment[i + 1]
        if (target?.kind === 'word' && !target.quoted && target.value === '/dev/null' && !tok.value.includes('>>')) {
          i += 2
          continue
        }
        return { ok: false, reason: `file output redirection '${tok.value}' is blocked in read-only mode` }
      }
      if (tok.value === '<' || tok.value === '<<' || tok.value === '<<<') {
        i += 2
        continue
      }
      if (tok.value === '(' || tok.value === ')') {
        i += 1
        continue
      }
    } else {
      words.push(tok.value)
    }
    i += 1
  }
  return validateWordSequence(words)
}

/**
 * Validate whether a shell command is safe for read-only exploration in planning mode.
 */
export function validateReadOnlyShellCommand(command: string): ReadOnlyShellValidationResult {
  if (typeof command !== 'string' || command.trim() === '') {
    return { ok: false, reason: 'command must be a non-empty string' }
  }
  const scanned = scanShell(command)
  if ('error' in scanned) {
    return { ok: false, reason: scanned.error }
  }

  for (const sub of scanned.substitutions) {
    const subRes = validateReadOnlyShellCommand(sub)
    if (!subRes.ok) return subRes
  }

  const segments = splitSegments(scanned.tokens)
  for (const segment of segments) {
    const segRes = validateSegment(segment)
    if (!segRes.ok) return segRes
  }

  return { ok: true }
}
