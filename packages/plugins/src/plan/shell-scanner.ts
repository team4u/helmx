/**
 * Quote-aware shell lexer, substitution/heredoc extractor, and shared flag helpers
 * for `builtin:plan` read-only command validation.
 */

export type ReadOnlyShellValidationResult =
  | { ok: true }
  | { ok: false; reason: string }

export interface ShellToken {
  kind: 'word' | 'op'
  value: string
  quoted: boolean
}

export interface ScannedShellCommand {
  tokens: ShellToken[]
  substitutions: string[]
}

export type ShortFlagClusterResult = 'none' | 'consume-next' | 'consume-inline' | { blocked: string }

export interface SubcommandScanSpec {
  commandName: string
  boolFlags: ReadonlySet<string>
  valueFlags: ReadonlySet<string>
  shortBoolChars: string
  shortValueChars: string
  blockedFlags?: ReadonlySet<string>
  allowPlusToolchain?: boolean
}

export type ResolveSubcommandResult =
  | { ok: true; subcommand: string | undefined; subArgs: string[] }
  | { ok: false; reason: string }

interface PendingHeredoc {
  delimiter: string
  stripTabs: boolean
  quoted: boolean
}

const METACHAR_OR_SPACE: ReadonlySet<string> = new Set([
  ' ',
  '\t',
  '\r',
  '\n',
  ';',
  '&',
  '|',
  '<',
  '>',
  '(',
  ')',
])

const SEGMENT_SEPARATORS: ReadonlySet<string> = new Set(['|', '|&', '&&', '||', ';', '\n', '&'])

export function commandBaseName(cmd: string): string {
  const idx = Math.max(cmd.lastIndexOf('/'), cmd.lastIndexOf('\\'))
  const base = idx >= 0 ? cmd.slice(idx + 1) : cmd
  return base.replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase()
}

export function splitSegments(tokens: ShellToken[]): ShellToken[][] {
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

/**
 * Inspect a POSIX short-flag cluster (e.g. `-iS`, `-iC`, `-ca`, `-rI`, `-0n`) char-by-char:
 * - Returns `{ blocked }` if a blocked option char appears before any value-taking option.
 * - Returns `'consume-next'` if a value-taking option char is at the end of the cluster (consumes next token),
 *   or `'consume-inline'` if remaining chars in the same token form its value.
 * - Returns `'none'` for non-short tokens or purely boolean clusters.
 */
export function classifyShortFlagCluster(
  token: string,
  valueChars: string,
  blockedChars = '',
): ShortFlagClusterResult {
  if (!token.startsWith('-') || token.startsWith('--') || token.length < 2) {
    return 'none'
  }
  for (let i = 1; i < token.length; i += 1) {
    const ch = token.charAt(i)
    if (blockedChars.includes(ch)) {
      return { blocked: `-${ch}` }
    }
    if (valueChars.includes(ch)) {
      return i === token.length - 1 ? 'consume-next' : 'consume-inline'
    }
  }
  return 'none'
}

/**
 * Scan flags before a command's subcommand and fail closed on unknown flags or missing flag values.
 */
export function resolveSubcommand(
  args: readonly string[],
  spec: SubcommandScanSpec,
  startIdx = 0,
): ResolveSubcommandResult {
  let i = startIdx
  while (i < args.length) {
    const arg = args[i]
    if (arg === undefined) break
    if (arg === '--') {
      const subcommand = args[i + 1]
      return { ok: true, subcommand, subArgs: subcommand === undefined ? [] : args.slice(i + 2) }
    }
    if (spec.allowPlusToolchain && arg.startsWith('+') && arg.length > 1) {
      i += 1
      continue
    }
    if (!arg.startsWith('-') || arg === '-') {
      return { ok: true, subcommand: arg, subArgs: args.slice(i + 1) }
    }
    if (spec.blockedFlags !== undefined) {
      const eqPos = arg.indexOf('=')
      const rawFlag = eqPos === -1 ? arg : arg.slice(0, eqPos)
      if (spec.blockedFlags.has(rawFlag)) {
        return {
          ok: false,
          reason: `${spec.commandName} option '${arg}' is blocked in read-only mode`,
        }
      }
    }
    if (arg.startsWith('--')) {
      const eqPos = arg.indexOf('=')
      const flagName = eqPos === -1 ? arg : arg.slice(0, eqPos)
      if (spec.valueFlags.has(flagName)) {
        if (eqPos !== -1) {
          i += 1
          continue
        }
        if (args[i + 1] === undefined) {
          return {
            ok: false,
            reason: `${spec.commandName} option '${flagName}' is missing a value`,
          }
        }
        i += 2
        continue
      }
      if (spec.boolFlags.has(flagName) && eqPos === -1) {
        i += 1
        continue
      }
      return {
        ok: false,
        reason: `${spec.commandName} option '${arg}' before subcommand is not allowed in read-only mode`,
      }
    }

    // Short flag / cluster: verify every option char before subcommand.
    let consumed = false
    for (let k = 1; k < arg.length; k += 1) {
      const ch = arg.charAt(k)
      if (spec.shortValueChars.includes(ch)) {
        if (k < arg.length - 1) {
          i += 1
        } else {
          if (args[i + 1] === undefined) {
            return {
              ok: false,
              reason: `${spec.commandName} option '-${ch}' is missing a value`,
            }
          }
          i += 2
        }
        consumed = true
        break
      }
      if (!spec.shortBoolChars.includes(ch)) {
        return {
          ok: false,
          reason: `${spec.commandName} option '${arg}' before subcommand is not allowed in read-only mode`,
        }
      }
    }
    if (!consumed) i += 1
  }

  return { ok: true, subcommand: undefined, subArgs: [] }
}

function skipBacktick(
  input: string,
  startIdx: number,
): { endIdx: number; inner: string } | { error: string } {
  let i = startIdx
  let inner = ''
  while (i < input.length) {
    const ch = input.charAt(i)
    if (ch === '\\' && i + 1 < input.length) {
      inner += input.charAt(i + 1)
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

function skipBalancedParen(
  input: string,
  startIdx: number,
  options: { allowSingleQuote?: boolean } = {},
): { endIdx: number; inner: string; firstDropToDepth1Idx: number | undefined } | { error: string } {
  const allowSingleQuote = options.allowSingleQuote ?? true
  let depth = 1
  let i = startIdx
  let inSingle = false
  let inDouble = false
  let firstDropToDepth1Idx: number | undefined

  while (i < input.length) {
    const ch = input.charAt(i)
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
      if (ch === '$' && input.charAt(i + 1) === '(') {
        const nested = skipBalancedParen(input, i + 2)
        if ('error' in nested) return nested
        i = nested.endIdx + 1
        continue
      }
      if (ch === '`') {
        const bt = skipBacktick(input, i + 1)
        if ('error' in bt) return bt
        i = bt.endIdx + 1
        continue
      }
      i += 1
      continue
    }
    if (ch === '\\' && i + 1 < input.length) {
      i += 2
      continue
    }
    if (allowSingleQuote && ch === "'") {
      inSingle = true
      i += 1
      continue
    }
    if (ch === '"') {
      inDouble = true
      i += 1
      continue
    }
    if (ch === '`') {
      const bt = skipBacktick(input, i + 1)
      if ('error' in bt) return bt
      i = bt.endIdx + 1
      continue
    }
    if (ch === '$' && input.charAt(i + 1) === '(') {
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
      if (depth === 1 && firstDropToDepth1Idx === undefined) {
        firstDropToDepth1Idx = i
      }
      if (depth === 0) {
        return { endIdx: i, inner: input.slice(startIdx, i), firstDropToDepth1Idx }
      }
      i += 1
      continue
    }
    i += 1
  }
  return { error: 'unclosed subshell or command substitution' }
}

/**
 * Scan unquoted expansion regions (used inside arithmetic `$((...))` and unquoted heredoc bodies),
 * where bash still evaluates `$((...))`, `$(...)`, and backticks even around single quotes `'...'`.
 */
function scanExpansionRegion(
  region: string,
  substitutions: string[],
): { error: string } | undefined {
  let i = 0
  let inDouble = false
  while (i < region.length) {
    const ch = region.charAt(i)
    if (inDouble) {
      if (ch === '\\' && i + 1 < region.length) {
        i += 2
        continue
      }
      if (ch === '"') {
        inDouble = false
        i += 1
        continue
      }
      if (ch === '$' && region.charAt(i + 1) === '(') {
        const res = consumeDollarParen(region, i, substitutions)
        if ('error' in res) return res
        i = res.endIdx + 1
        continue
      }
      if (ch === '`') {
        const bt = skipBacktick(region, i + 1)
        if ('error' in bt) return bt
        substitutions.push(bt.inner)
        i = bt.endIdx + 1
        continue
      }
      i += 1
      continue
    }
    if (ch === '\\' && i + 1 < region.length) {
      i += 2
      continue
    }
    if (ch === '"') {
      inDouble = true
      i += 1
      continue
    }
    if (ch === '$' && region.charAt(i + 1) === '(') {
      const res = consumeDollarParen(region, i, substitutions)
      if ('error' in res) return res
      i = res.endIdx + 1
      continue
    }
    if (ch === '`') {
      const bt = skipBacktick(region, i + 1)
      if ('error' in bt) return bt
      substitutions.push(bt.inner)
      i = bt.endIdx + 1
      continue
    }
    i += 1
  }
  return undefined
}

/**
 * Handle both `$(...)` command substitution and `$((...))` arithmetic expansion
 * (including Bash fallback `$( (cmd); ... )` when the second `(` does not close right before the outer `)`).
 */
function consumeDollarParen(
  input: string,
  startIdx: number,
  substitutions: string[],
): { endIdx: number } | { error: string } {
  if (input.charAt(startIdx + 2) !== '(') {
    const sub = skipBalancedParen(input, startIdx + 2)
    if ('error' in sub) return sub
    substitutions.push(sub.inner)
    return { endIdx: sub.endIdx }
  }

  // First try arithmetic paren balancing without treating `'...'` as suppressing quotes,
  // unless an early depth drop proves Bash fallback `$( (subshell); ... )`.
  const arithTry = skipBalancedParen(input, startIdx + 2, { allowSingleQuote: false })
  if ('error' in arithTry) {
    const cmdSub = skipBalancedParen(input, startIdx + 2, { allowSingleQuote: true })
    if ('error' in cmdSub) return cmdSub
    substitutions.push(cmdSub.inner)
    return { endIdx: cmdSub.endIdx }
  }

  const isArithmetic =
    arithTry.firstDropToDepth1Idx !== undefined && arithTry.firstDropToDepth1Idx === arithTry.endIdx - 1
  if (!isArithmetic) {
    // Re-scan with normal single-quote rules for `$( (subshell); ... )` and validate the full subshell body.
    const cmdSub = skipBalancedParen(input, startIdx + 2, { allowSingleQuote: true })
    if ('error' in cmdSub) return cmdSub
    substitutions.push(cmdSub.inner)
    return { endIdx: cmdSub.endIdx }
  }

  const expr = input.slice(startIdx + 3, arithTry.endIdx - 1)
  const exprScan = scanExpansionRegion(expr, substitutions)
  if (exprScan !== undefined) return exprScan
  return { endIdx: arithTry.endIdx }
}

function consumeSingleQuoteText(
  input: string,
  startAfterQuote: number,
): { text: string; nextIdx: number } | { error: string } {
  let i = startAfterQuote
  let text = ''
  while (i < input.length) {
    const c = input.charAt(i)
    if (c === "'") {
      return { text, nextIdx: i + 1 }
    }
    text += c
    i += 1
  }
  return { error: 'unclosed single quote' }
}

function consumeDoubleQuoteText(
  input: string,
  startAfterQuote: number,
  substitutions: string[],
): { text: string; nextIdx: number } | { error: string } {
  let i = startAfterQuote
  let text = ''
  while (i < input.length) {
    const c = input.charAt(i)
    if (c === '"') {
      return { text, nextIdx: i + 1 }
    }
    if (c === '\\' && i + 1 < input.length) {
      text += input.charAt(i + 1)
      i += 2
      continue
    }
    if (c === '$' && input.charAt(i + 1) === '(') {
      const res = consumeDollarParen(input, i, substitutions)
      if ('error' in res) return res
      text += input.slice(i, res.endIdx + 1)
      i = res.endIdx + 1
      continue
    }
    if (c === '`') {
      const sub = skipBacktick(input, i + 1)
      if ('error' in sub) return sub
      substitutions.push(sub.inner)
      text += input.slice(i, sub.endIdx + 1)
      i = sub.endIdx + 1
      continue
    }
    text += c
    i += 1
  }
  return { error: 'unclosed double quote' }
}

function consumeHeredocDelimiter(
  input: string,
  startIdx: number,
): { delimiter: string; quoted: boolean; nextIdx: number } | { error: string } {
  let i = startIdx
  while (i < input.length && (input.charAt(i) === ' ' || input.charAt(i) === '\t')) {
    i += 1
  }
  let delimiter = ''
  let quoted = false
  let hasToken = false
  while (i < input.length) {
    const ch = input.charAt(i)
    if (METACHAR_OR_SPACE.has(ch)) break
    hasToken = true
    if (ch === "'") {
      quoted = true
      const sq = consumeSingleQuoteText(input, i + 1)
      if ('error' in sq) return sq
      delimiter += sq.text
      i = sq.nextIdx
      continue
    }
    if (ch === '"') {
      quoted = true
      i += 1
      let closed = false
      while (i < input.length) {
        const c = input.charAt(i)
        if (c === '"') {
          closed = true
          i += 1
          break
        }
        if (c === '\\' && i + 1 < input.length) {
          delimiter += input.charAt(i + 1)
          i += 2
          continue
        }
        delimiter += c
        i += 1
      }
      if (!closed) return { error: 'unclosed double quote' }
      continue
    }
    if (ch === '\\' && i + 1 < input.length) {
      quoted = true
      delimiter += input.charAt(i + 1)
      i += 2
      continue
    }
    delimiter += ch
    i += 1
  }
  if (!hasToken) {
    return { error: 'missing heredoc delimiter' }
  }
  return { delimiter, quoted, nextIdx: i }
}

function consumePendingHeredocs(
  input: string,
  startIdx: number,
  pending: PendingHeredoc[],
  substitutions: string[],
): { nextIdx: number } | { error: string } {
  let pos = startIdx
  while (pending.length > 0) {
    const hd = pending.shift()
    if (hd === undefined) break
    let closed = false
    const bodyLines: string[] = []
    while (pos <= input.length) {
      if (pos === input.length && input.length === startIdx) break
      const nlIdx = input.indexOf('\n', pos)
      const lineEnd = nlIdx === -1 ? input.length : nlIdx
      const line = input.slice(pos, lineEnd)
      const candidate = hd.stripTabs ? line.replace(/^\t+/, '') : line
      const atEofBeforeDelimiter = pos >= input.length
      if (atEofBeforeDelimiter) break
      pos = nlIdx === -1 ? input.length : nlIdx + 1
      if (candidate === hd.delimiter) {
        closed = true
        break
      }
      bodyLines.push(line)
      if (nlIdx === -1) break
    }
    if (!closed) {
      return { error: `unterminated heredoc delimiter '${hd.delimiter}'` }
    }
    if (!hd.quoted && bodyLines.length > 0) {
      const scanErr = scanExpansionRegion(bodyLines.join('\n'), substitutions)
      if (scanErr !== undefined) return scanErr
    }
  }
  return { nextIdx: pos }
}

export function scanShell(input: string): ScannedShellCommand | { error: string } {
  const tokens: ShellToken[] = []
  const substitutions: string[] = []
  const pendingHeredocs: PendingHeredoc[] = []
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
    const ch = input.charAt(i)

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flushWord()
      i += 1
      continue
    }

    if (ch === '#' && !hasWord) {
      while (i < input.length && input.charAt(i) !== '\n') i += 1
      continue
    }

    if (ch === '\n' || ch === ';') {
      flushWord()
      tokens.push({ kind: 'op', value: ch, quoted: false })
      i += 1
      if (ch === '\n' && pendingHeredocs.length > 0) {
        const consumed = consumePendingHeredocs(input, i, pendingHeredocs, substitutions)
        if ('error' in consumed) return consumed
        i = consumed.nextIdx
      }
      continue
    }

    if (ch === "'") {
      hasWord = true
      wordQuoted = true
      const sq = consumeSingleQuoteText(input, i + 1)
      if ('error' in sq) return sq
      buf += sq.text
      i = sq.nextIdx
      continue
    }

    if (ch === '"') {
      hasWord = true
      wordQuoted = true
      const dq = consumeDoubleQuoteText(input, i + 1, substitutions)
      if ('error' in dq) return dq
      buf += dq.text
      i = dq.nextIdx
      continue
    }

    if (ch === '\\') {
      if (i + 1 < input.length) {
        hasWord = true
        buf += input.charAt(i + 1)
        i += 2
      } else {
        i += 1
      }
      continue
    }

    if (ch === '$' && input.charAt(i + 1) === '(') {
      const res = consumeDollarParen(input, i, substitutions)
      if ('error' in res) return res
      hasWord = true
      buf += input.slice(i, res.endIdx + 1)
      i = res.endIdx + 1
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

    if ((ch === '<' || ch === '>') && input.charAt(i + 1) === '(') {
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
    if (ch === '&' && input.charAt(i + 1) === '&') {
      flushWord()
      tokens.push({ kind: 'op', value: '&&', quoted: false })
      i += 2
      continue
    }
    if (ch === '|' && input.charAt(i + 1) === '|') {
      flushWord()
      tokens.push({ kind: 'op', value: '||', quoted: false })
      i += 2
      continue
    }
    if (ch === '|' && input.charAt(i + 1) === '&') {
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
    if (ch === '&' && input.charAt(i + 1) === '>') {
      flushWord()
      const op = input.charAt(i + 2) === '>' ? '&>>' : '&>'
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
    if (!hasWord && (ch === '1' || ch === '2') && input.charAt(i + 1) === '>') {
      const rest = input.slice(i)
      if (rest.startsWith('2>&1') || rest.startsWith('1>&2')) {
        tokens.push({ kind: 'op', value: rest.slice(0, 4), quoted: false })
        i += 4
        continue
      }
      const op = input.charAt(i + 2) === '>' ? `${ch}>>` : input.charAt(i + 2) === '|' ? `${ch}>|` : `${ch}>`
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
      const op = input.charAt(i + 1) === '>' ? '>>' : input.charAt(i + 1) === '|' ? '>|' : '>'
      tokens.push({ kind: 'op', value: op, quoted: false })
      i += op.length
      continue
    }

    if (ch === '<') {
      flushWord()
      if (input.startsWith('<<<', i)) {
        tokens.push({ kind: 'op', value: '<<<', quoted: false })
        i += 3
        continue
      }
      if (input.charAt(i + 1) === '<') {
        const stripTabs = input.charAt(i + 2) === '-'
        const op = stripTabs ? '<<-' : '<<'
        tokens.push({ kind: 'op', value: op, quoted: false })
        i += op.length
        const delim = consumeHeredocDelimiter(input, i)
        if ('error' in delim) return delim
        tokens.push({ kind: 'word', value: delim.delimiter, quoted: delim.quoted })
        pendingHeredocs.push({
          delimiter: delim.delimiter,
          stripTabs,
          quoted: delim.quoted,
        })
        i = delim.nextIdx
        continue
      }
      tokens.push({ kind: 'op', value: '<', quoted: false })
      i += 1
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
  const firstPending = pendingHeredocs[0]
  if (firstPending !== undefined) {
    return { error: `unterminated heredoc delimiter '${firstPending.delimiter}'` }
  }
  return { tokens, substitutions }
}
