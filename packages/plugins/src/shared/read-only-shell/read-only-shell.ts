/**
 * Quote-aware read-only shell command validator for `builtin:plan` (`plan_bash`).
 *
 * Rejects file redirections (other than `/dev/null` and fd dups like `2>&1`),
 * mutating/destructive commands, in-place file edits, and write git/package-manager
 * subcommands, while never mis-triggering on keywords inside quoted arguments
 * (e.g. `rg "rm -rf" src/` or `git log --grep="commit"`).
 */
import { validateWordSequence } from './command-validators.js'
import {
  scanShell,
  splitSegments,
  type ReadOnlyShellValidationResult,
  type ShellToken,
} from './shell-scanner.js'

export type { ReadOnlyShellValidationResult } from './shell-scanner.js'

const REDIRECT_OUT_OPS: ReadonlySet<string> = new Set([
  '>',
  '>>',
  '>|',
  '&>',
  '&>>',
  '1>',
  '1>>',
  '1>|',
  '2>',
  '2>>',
  '2>|',
])
const ALLOWED_FD_DUPS: ReadonlySet<string> = new Set(['2>&1', '1>&2', '>&1', '>&2'])

function validateSegment(segment: ShellToken[]): ReadOnlyShellValidationResult {
  const words: string[] = []
  let i = 0
  while (i < segment.length) {
    const tok = segment[i]
    if (tok === undefined) break
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
      if (tok.value === '<' || tok.value === '<<' || tok.value === '<<-' || tok.value === '<<<') {
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
