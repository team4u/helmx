/**
 * Read-only `git` command validator for `builtin:plan` (`plan_bash`).
 */
import {
  classifyShortFlagCluster,
  resolveSubcommand,
  type ReadOnlyShellValidationResult,
  type SubcommandScanSpec,
} from './shell-scanner.js'

const GIT_GLOBAL_SCAN_SPEC: SubcommandScanSpec = {
  commandName: 'git',
  boolFlags: new Set([
    '--version',
    '--help',
    '--bare',
    '--no-pager',
    '--paginate',
    '--no-replace-objects',
    '--literal-pathspecs',
    '--glob-pathspecs',
    '--noglob-pathspecs',
    '--icase-pathspecs',
    '--no-optional-locks',
    '--no-lazy-fetch',
    '--no-advice',
    '--html-path',
    '--man-path',
    '--info-path',
  ]),
  valueFlags: new Set([
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--super-prefix',
    '--config-env',
  ]),
  shortBoolChars: 'hvPp',
  shortValueChars: 'Cc',
  blockedFlags: new Set(['--exec-path']),
}

const GIT_STASH_SCAN_SPEC: SubcommandScanSpec = {
  commandName: 'git stash',
  boolFlags: new Set(['--help']),
  valueFlags: new Set(['--message']),
  shortBoolChars: 'h',
  shortValueChars: 'm',
}

const GIT_WORKTREE_SCAN_SPEC: SubcommandScanSpec = {
  commandName: 'git worktree',
  boolFlags: new Set(['--help']),
  valueFlags: new Set(),
  shortBoolChars: 'h',
  shortValueChars: '',
}

const GIT_SUBMODULE_SCAN_SPEC: SubcommandScanSpec = {
  commandName: 'git submodule',
  boolFlags: new Set(['--quiet', '--cached', '--help']),
  valueFlags: new Set(),
  shortBoolChars: 'qh',
  shortValueChars: '',
}

const GIT_REMOTE_SCAN_SPEC: SubcommandScanSpec = {
  commandName: 'git remote',
  boolFlags: new Set(['--verbose', '--help']),
  valueFlags: new Set(),
  shortBoolChars: 'vh',
  shortValueChars: '',
}

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

const GIT_TAG_VALUE_FLAGS: ReadonlySet<string> = new Set([
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

function validateGitStash(subArgs: readonly string[]): ReadOnlyShellValidationResult {
  const scanned = resolveSubcommand(subArgs, GIT_STASH_SCAN_SPEC)
  if (!scanned.ok) return scanned
  const action = scanned.subcommand
  if (action !== 'list' && action !== 'show') {
    return { ok: false, reason: `git stash ${action ?? '(default push)'} mutates stash state` }
  }
  return { ok: true }
}

function validateGitBranch(subArgs: readonly string[]): ReadOnlyShellValidationResult {
  let j = 0
  while (j < subArgs.length) {
    const a = subArgs[j]
    if (a === undefined) break
    if (
      GIT_BRANCH_WRITE_FLAGS.has(a) ||
      a.startsWith('--delete=') ||
      a.startsWith('--move=') ||
      a.startsWith('--copy=') ||
      a.startsWith('--set-upstream-to=')
    ) {
      return { ok: false, reason: `git branch ${a} mutates branches` }
    }
    const shortWrite = classifyShortFlagCluster(a, '', 'dDmMcCf')
    if (typeof shortWrite === 'object') {
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
  return { ok: true }
}

function validateGitTag(subArgs: readonly string[]): ReadOnlyShellValidationResult {
  let hasReadFlag = false
  let hasPositional = false
  let j = 0
  while (j < subArgs.length) {
    const a = subArgs[j]
    if (a === undefined) break
    if (a === '--') {
      if (j + 1 < subArgs.length) hasPositional = true
      break
    }
    const eqPos = a.indexOf('=')
    const baseFlag = eqPos === -1 ? a : a.slice(0, eqPos)
    if (GIT_TAG_WRITE_FLAGS.has(baseFlag)) {
      return { ok: false, reason: 'git tag creation/deletion is not allowed in read-only mode' }
    }
    const shortCluster = classifyShortFlagCluster(a, 'n', 'dasufmF')
    if (typeof shortCluster === 'object') {
      return { ok: false, reason: 'git tag creation/deletion is not allowed in read-only mode' }
    }
    if (GIT_TAG_VALUE_FLAGS.has(baseFlag)) {
      j += eqPos === -1 ? 2 : 1
      continue
    }
    if (a === '-l' || a === '--list' || a === '-v' || a === '--verify') {
      hasReadFlag = true
      j += 1
      continue
    }
    if (shortCluster === 'consume-next') {
      j += 2
      continue
    }
    if (a.startsWith('-')) {
      if (a.includes('l') || a.includes('v')) hasReadFlag = true
      j += 1
      continue
    }
    hasPositional = true
    j += 1
  }
  if (!hasReadFlag && hasPositional) {
    return { ok: false, reason: 'git tag creation/deletion is not allowed in read-only mode' }
  }
  return { ok: true }
}

function validateGitConfig(subArgs: readonly string[]): ReadOnlyShellValidationResult {
  const isRead = subArgs.some(
    (a) => a === '--get' || a === '--get-all' || a === '--get-regexp' || a === '--list' || a === '-l',
  )
  const hasWrite = subArgs.some(
    (a) =>
      a === '--unset' ||
      a === '--unset-all' ||
      a === '--replace-all' ||
      a === '--add' ||
      a === '--remove-section' ||
      a === '--rename-section',
  )
  if (!isRead || hasWrite) {
    return { ok: false, reason: 'git config write operations are not allowed in read-only mode' }
  }
  return { ok: true }
}

export function validateGitArgs(args: readonly string[]): ReadOnlyShellValidationResult {
  const globalScan = resolveSubcommand(args, GIT_GLOBAL_SCAN_SPEC)
  if (!globalScan.ok) return globalScan

  const sub = globalScan.subcommand
  if (sub === undefined) return { ok: true }
  if (GIT_WRITE_SUBCOMMANDS.has(sub)) {
    return { ok: false, reason: `git ${sub} mutates the repository` }
  }
  const subArgs = globalScan.subArgs

  if (sub === 'stash') return validateGitStash(subArgs)
  if (sub === 'worktree') {
    const wt = resolveSubcommand(subArgs, GIT_WORKTREE_SCAN_SPEC)
    if (!wt.ok) return wt
    if (wt.subcommand !== 'list') {
      return { ok: false, reason: `git worktree ${wt.subcommand ?? ''} is not allowed in read-only mode`.trim() }
    }
    return { ok: true }
  }
  if (sub === 'submodule') {
    const sm = resolveSubcommand(subArgs, GIT_SUBMODULE_SCAN_SPEC)
    if (!sm.ok) return sm
    if (sm.subcommand !== undefined && sm.subcommand !== 'status' && sm.subcommand !== 'summary') {
      return { ok: false, reason: `git submodule ${sm.subcommand} is not allowed in read-only mode` }
    }
    return { ok: true }
  }
  if (sub === 'remote') {
    const rm = resolveSubcommand(subArgs, GIT_REMOTE_SCAN_SPEC)
    if (!rm.ok) return rm
    if (rm.subcommand !== undefined && rm.subcommand !== 'show' && rm.subcommand !== 'get-url') {
      return { ok: false, reason: `git remote ${rm.subcommand} mutates remotes` }
    }
    return { ok: true }
  }
  if (sub === 'config') return validateGitConfig(subArgs)
  if (sub === 'branch') return validateGitBranch(subArgs)
  if (sub === 'tag') return validateGitTag(subArgs)

  return { ok: true }
}
