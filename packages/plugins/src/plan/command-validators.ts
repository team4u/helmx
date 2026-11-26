/**
 * Read-only command and shell-wrapper validators for `builtin:plan` (`plan_bash`).
 */
import {
  classifyShortFlagCluster,
  commandBaseName,
  resolveSubcommand,
  type ReadOnlyShellValidationResult,
  type SubcommandScanSpec,
} from './shell-scanner.js'
import { validateGitArgs } from './git-validator.js'
import { HELMX_BLOCKED_BINARIES, validateHelmxArgs } from './helmx-validator.js'

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

const NODE_PM_SPECS: Record<string, SubcommandScanSpec> = {
  npm: {
    commandName: 'npm',
    boolFlags: new Set(['--json', '--silent', '--verbose', '--version', '--help', '--workspaces']),
    valueFlags: new Set(['--prefix', '--userconfig', '--cache', '--registry', '--workspace', '--loglevel']),
    shortBoolChars: 'svVh',
    shortValueChars: 'Cw',
  },
  pnpm: {
    commandName: 'pnpm',
    boolFlags: new Set([
      '--workspace-root',
      '--recursive',
      '--stream',
      '--aggregate-output',
      '--silent',
      '--json',
      '--version',
      '--help',
      '--offline',
      '--prefer-offline',
    ]),
    valueFlags: new Set(['--dir', '--filter', '--reporter', '--loglevel', '--config', '--store-dir', '--virtual-store-dir']),
    shortBoolChars: 'wrsvVh',
    shortValueChars: 'CF',
  },
  yarn: {
    commandName: 'yarn',
    boolFlags: new Set(['--json', '--silent', '--verbose', '--version', '--help', '--offline', '--non-interactive']),
    valueFlags: new Set(['--cwd', '--modules-folder', '--cache-folder', '--registry']),
    shortBoolChars: 'svVh',
    shortValueChars: '',
  },
  bun: {
    commandName: 'bun',
    boolFlags: new Set(['--bun', '--silent', '--verbose', '--version', '--help']),
    valueFlags: new Set(['--cwd', '--config', '--env-file']),
    shortBoolChars: 'bsvVh',
    shortValueChars: 'c',
  },
}

const BREW_SCAN_SPEC: SubcommandScanSpec = {
  commandName: 'brew',
  boolFlags: new Set(['--version', '--help', '--verbose', '--debug', '--quiet']),
  valueFlags: new Set(),
  shortBoolChars: 'vhdq',
  shortValueChars: '',
}

const PIP_SCAN_SPEC: SubcommandScanSpec = {
  commandName: 'pip',
  boolFlags: new Set([
    '--verbose',
    '--quiet',
    '--version',
    '--help',
    '--isolated',
    '--no-input',
    '--disable-pip-version-check',
    '--no-color',
    '--no-python-version-warning',
    '--require-virtualenv',
    '--break-system-packages',
  ]),
  valueFlags: new Set(['--python', '--exists-action', '--timeout', '--retries', '--cache-dir', '--proxy', '--cert', '--client-cert', '--log']),
  shortBoolChars: 'vqVh',
  shortValueChars: '',
}

const UV_SCAN_SPEC: SubcommandScanSpec = {
  commandName: 'uv',
  boolFlags: new Set([
    '--quiet',
    '--verbose',
    '--no-cache',
    '--offline',
    '--no-config',
    '--no-progress',
    '--version',
    '--help',
    '--managed-python',
    '--no-managed-python',
    '--system',
    '--preview',
  ]),
  valueFlags: new Set(['--directory', '--project', '--python', '--cache-dir', '--config-file', '--color', '--native-tls']),
  shortBoolChars: 'qvnVh',
  shortValueChars: '',
}

const UV_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set(['add', 'remove', 'sync'])

const CARGO_SCAN_SPEC: SubcommandScanSpec = {
  commandName: 'cargo',
  boolFlags: new Set(['--verbose', '--quiet', '--offline', '--frozen', '--locked', '--version', '--help', '--list']),
  valueFlags: new Set(['--color', '--config', '--explain']),
  shortBoolChars: 'vqVh',
  shortValueChars: 'CZ',
  allowPlusToolchain: true,
}

const DOCKER_SCAN_SPEC: SubcommandScanSpec = {
  commandName: 'docker',
  boolFlags: new Set(['--debug', '--tls', '--tlsverify', '--version', '--help']),
  valueFlags: new Set(['--host', '--context', '--config', '--log-level', '--tlscacert', '--tlscert', '--tlskey']),
  shortBoolChars: 'Dvh',
  shortValueChars: 'Hcl',
}

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

const XARGS_LONG_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--arg-file',
  '--delimiter',
  '--max-lines',
  '--max-args',
  '--max-procs',
  '--max-chars',
  '--process-slot-var',
])

const TIME_VALUE_FLAGS: ReadonlySet<string> = new Set(['-f', '--format'])
const TIME_BLOCKED_FLAGS: ReadonlySet<string> = new Set(['-o', '--output', '-a', '--append'])
const FIND_BLOCKED_ACTIONS: ReadonlySet<string> = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprintf',
  '-fls',
])
const CURL_BLOCKED_FLAGS: ReadonlySet<string> = new Set([
  '-o',
  '--output',
  '-O',
  '--remote-name',
  '-d',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-urlencode',
  '-F',
  '--form',
  '-T',
  '--upload-file',
])

interface WrapperScanSpec {
  longValueFlags?: ReadonlySet<string>
  shortValueChars?: string
  allowEnvAssign?: boolean
}

function advanceWrapperOptions(words: readonly string[], startIdx: number, spec: WrapperScanSpec): number {
  let idx = startIdx
  while (idx < words.length) {
    const arg = words[idx]
    if (arg === undefined) break
    if (arg === '--') return idx + 1
    if (spec.longValueFlags?.has(arg)) {
      idx += 2
      continue
    }
    if (spec.shortValueChars !== undefined && classifyShortFlagCluster(arg, spec.shortValueChars) === 'consume-next') {
      idx += 2
      continue
    }
    if (arg.startsWith('-') || (spec.allowEnvAssign && ENV_ASSIGN_RE.test(arg))) {
      idx += 1
      continue
    }
    return idx
  }
  return idx
}

function advanceCommandBuiltinPrefix(
  base: string,
  words: readonly string[],
  startIdx: number,
): { ok: true; nextIdx: number } | { ok: false; reason: string } {
  let idx = startIdx
  while (idx < words.length) {
    const arg = words[idx]
    if (arg === undefined) break
    if (arg === '--') return { ok: true, nextIdx: idx + 1 }
    if (!arg.startsWith('-') || arg === '-') return { ok: true, nextIdx: idx }

    if (base === 'command') {
      if (arg === '-p' || arg === '-v' || arg === '-V') {
        idx += 1
        continue
      }
      return { ok: false, reason: `command option '${arg}' is not allowed in read-only mode` }
    }

    if (base === 'nohup') {
      if (arg === '--help' || arg === '--version') {
        idx += 1
        continue
      }
      return { ok: false, reason: `nohup option '${arg}' is not allowed in read-only mode` }
    }

    // base === 'time'
    const eqPos = arg.indexOf('=')
    const baseFlag = eqPos === -1 ? arg : arg.slice(0, eqPos)
    if (TIME_BLOCKED_FLAGS.has(baseFlag)) {
      return { ok: false, reason: `time option '${arg}' writes files and is blocked in read-only mode` }
    }
    if (TIME_VALUE_FLAGS.has(baseFlag)) {
      if (eqPos === -1 && words[idx + 1] === undefined) {
        return { ok: false, reason: `time option '${baseFlag}' is missing a value` }
      }
      idx += eqPos === -1 ? 2 : 1
      continue
    }
    if (arg === '-p' || arg === '-v' || arg === '-q' || arg === '--portability' || arg === '--verbose' || arg === '--quiet') {
      idx += 1
      continue
    }
    return { ok: false, reason: `time option '${arg}' is not allowed in read-only mode` }
  }
  return { ok: true, nextIdx: idx }
}

function advanceEnvOptions(
  words: readonly string[],
  startIdx: number,
): { ok: true; nextIdx: number } | { ok: false; reason: string } {
  let idx = startIdx
  while (idx < words.length) {
    const arg = words[idx]
    if (arg === undefined) break
    if (arg === '--') return { ok: true, nextIdx: idx + 1 }
    if (arg === '--split-string' || arg.startsWith('--split-string=')) {
      return { ok: false, reason: `env flag '${arg}' is blocked in read-only mode` }
    }
    if (arg === '--unset' || arg === '--chdir' || arg === '--argv0') {
      idx += 2
      continue
    }
    const cluster = classifyShortFlagCluster(arg, 'uCa', 'S')
    if (typeof cluster === 'object') {
      return { ok: false, reason: `env flag '${arg}' (${cluster.blocked}) is blocked in read-only mode` }
    }
    if (cluster === 'consume-next') {
      idx += 2
      continue
    }
    if (arg.startsWith('-') || ENV_ASSIGN_RE.test(arg)) {
      idx += 1
      continue
    }
    return { ok: true, nextIdx: idx }
  }
  return { ok: true, nextIdx: idx }
}

function validateXargs(args: readonly string[]): ReadOnlyShellValidationResult {
  const nextIdx = advanceWrapperOptions(args, 0, {
    longValueFlags: XARGS_LONG_VALUE_FLAGS,
    shortValueChars: 'adEILnPs',
  })
  const targetWords = args.slice(nextIdx)
  if (targetWords.length > 0) {
    return validateWordSequence(targetWords)
  }
  return { ok: true }
}

function validateSed(args: readonly string[]): ReadOnlyShellValidationResult {
  let i = 0
  while (i < args.length) {
    const a = args[i]
    if (a === undefined || a === '--') break
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

function validatePerlOrRuby(cmd: string, args: readonly string[]): ReadOnlyShellValidationResult {
  for (const a of args) {
    if (a === '--' || a === '-e' || a === '-E') break
    if (a === '-i' || a.startsWith('-i') || (a.startsWith('-') && !a.startsWith('--') && a.slice(1).includes('i'))) {
      return { ok: false, reason: `${cmd} in-place editing (-i) is blocked in read-only mode` }
    }
  }
  return { ok: true }
}

function validateFind(args: readonly string[]): ReadOnlyShellValidationResult {
  for (const a of args) {
    if (FIND_BLOCKED_ACTIONS.has(a)) {
      return { ok: false, reason: `find action '${a}' is blocked in read-only mode` }
    }
  }
  return { ok: true }
}

function validateCurl(args: readonly string[]): ReadOnlyShellValidationResult {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === undefined) break
    const eqPos = a.indexOf('=')
    const baseFlag = eqPos === -1 ? a : a.slice(0, eqPos)
    if (CURL_BLOCKED_FLAGS.has(baseFlag)) {
      return { ok: false, reason: `curl flag '${a}' writes files or sends mutating payloads` }
    }
    const shortCluster = classifyShortFlagCluster(a, 'HAuX', 'oOdFT')
    if (typeof shortCluster === 'object') {
      return { ok: false, reason: `curl flag '${a}' (${shortCluster.blocked}) writes files or sends mutating payloads` }
    }
    if (baseFlag === '-X' || baseFlag === '--request') {
      const methodRaw = eqPos !== -1 ? a.slice(eqPos + 1) : (args[i + 1] ?? '')
      const method = methodRaw.toUpperCase()
      if (CURL_MUTATING_METHODS.has(method)) {
        return { ok: false, reason: `curl ${baseFlag} ${method} is blocked in read-only mode` }
      }
      if (eqPos === -1) i += 1
      continue
    }
    if (a.startsWith('-X') && CURL_MUTATING_METHODS.has(a.slice(2).toUpperCase())) {
      return { ok: false, reason: `curl ${a} is blocked in read-only mode` }
    }
    if (shortCluster === 'consume-next') {
      i += 1
    }
  }
  return { ok: true }
}

function validateSubcommandAllowlist(
  cmd: string,
  args: readonly string[],
  spec: SubcommandScanSpec,
  writeSubcommands: ReadonlySet<string>,
  makeReason: (command: string, subcommand: string) => string,
): ReadOnlyShellValidationResult {
  const scanned = resolveSubcommand(args, spec)
  if (!scanned.ok) return scanned
  if (scanned.subcommand !== undefined && writeSubcommands.has(scanned.subcommand)) {
    return { ok: false, reason: makeReason(cmd, scanned.subcommand) }
  }
  return { ok: true }
}

function validatePipOrUv(cmd: string, args: readonly string[]): ReadOnlyShellValidationResult {
  if (PIP_COMMANDS.has(cmd)) {
    return validateSubcommandAllowlist(cmd, args, PIP_SCAN_SPEC, PIP_WRITE_SUBCOMMANDS, (c, sub) => `${c} ${sub} mutates packages`)
  }
  const uvScan = resolveSubcommand(args, UV_SCAN_SPEC)
  if (!uvScan.ok) return uvScan
  if (uvScan.subcommand === undefined) return { ok: true }
  if (UV_WRITE_SUBCOMMANDS.has(uvScan.subcommand)) {
    return { ok: false, reason: `uv ${uvScan.subcommand} mutates packages` }
  }
  if (uvScan.subcommand === 'pip') {
    const pipScan = resolveSubcommand(uvScan.subArgs, PIP_SCAN_SPEC)
    if (!pipScan.ok) return pipScan
    if (pipScan.subcommand !== undefined && PIP_WRITE_SUBCOMMANDS.has(pipScan.subcommand)) {
      return { ok: false, reason: `uv ${pipScan.subcommand} mutates packages` }
    }
  }
  return { ok: true }
}

export function validateWordSequence(words: string[]): ReadOnlyShellValidationResult {
  let idx = 0
  while (idx < words.length) {
    const w = words[idx]
    if (w === undefined) break
    if (ENV_ASSIGN_RE.test(w)) {
      idx += 1
      continue
    }
    const base = commandBaseName(w)
    if (base === 'command' || base === 'time' || base === 'nohup') {
      const res = advanceCommandBuiltinPrefix(base, words, idx + 1)
      if (!res.ok) return res
      idx = res.nextIdx
      continue
    }
    if (base === 'nice') {
      idx = advanceWrapperOptions(words, idx + 1, {
        longValueFlags: new Set(['--adjustment']),
        shortValueChars: 'n',
      })
      continue
    }
    if (base === 'exec') {
      idx = advanceWrapperOptions(words, idx + 1, { shortValueChars: 'a' })
      continue
    }
    if (base === 'env') {
      const res = advanceEnvOptions(words, idx + 1)
      if (!res.ok) return res
      idx = res.nextIdx
      continue
    }
    break
  }

  const head = words[idx]
  if (head === undefined) return { ok: true }
  const cmd = commandBaseName(head)
  const args = words.slice(idx + 1)

  if (MUTATING_COMMANDS.has(cmd) || HELMX_BLOCKED_BINARIES.has(cmd)) {
    return { ok: false, reason: `command '${cmd}' is blocked in read-only plan mode` }
  }
  if (cmd === 'helmx') return validateHelmxArgs(args)
  if (cmd === 'xargs') return validateXargs(args)
  if (cmd === 'sed') return validateSed(args)
  if (cmd === 'perl' || cmd === 'ruby') return validatePerlOrRuby(cmd, args)
  if (cmd === 'find') return validateFind(args)
  if (cmd === 'curl') return validateCurl(args)
  if (cmd === 'git') return validateGitArgs(args)

  const nodePmSpec = NODE_PM_SPECS[cmd]
  if (nodePmSpec !== undefined) {
    return validateSubcommandAllowlist(
      cmd,
      args,
      nodePmSpec,
      NODE_PM_WRITE_SUBCOMMANDS,
      (c, sub) => `${c} ${sub} mutates dependencies or build output`,
    )
  }
  if (cmd === 'brew') {
    return validateSubcommandAllowlist(
      cmd,
      args,
      BREW_SCAN_SPEC,
      BREW_WRITE_SUBCOMMANDS,
      (c, sub) => `${c} ${sub} is blocked in read-only mode`,
    )
  }
  if (PIP_COMMANDS.has(cmd) || cmd === 'uv') return validatePipOrUv(cmd, args)
  if (cmd === 'cargo') {
    return validateSubcommandAllowlist(
      cmd,
      args,
      CARGO_SCAN_SPEC,
      CARGO_WRITE_SUBCOMMANDS,
      (c, sub) => `${c} ${sub} is blocked in read-only mode`,
    )
  }
  if (cmd === 'docker') {
    return validateSubcommandAllowlist(
      cmd,
      args,
      DOCKER_SCAN_SPEC,
      DOCKER_WRITE_SUBCOMMANDS,
      (c, sub) => `${c} ${sub} is blocked in read-only mode`,
    )
  }

  return { ok: true }
}
