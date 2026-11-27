/**
 * dsl/meta.ts — Comment-safe pure-literal `export const meta = { ... }` extraction.
 *
 * Improvements over legacy meta.ts:
 * - Scans JS tokens outside comments/strings/regex to find the real `export const meta =`
 *   declaration (never fooled by `/* export const meta = ... *\/` doc comments);
 * - Requires `{` immediately after `=` (skipping whitespace/comments only; never skips over
 *   arbitrary expressions to a later unrelated `{`);
 * - Properly handles regex character classes (`[/}]`) and double-quoted line endings;
 * - Evaluates the literal with DETERMINISM_PRELUDE + codeGeneration disabled + assertBoundarySafe,
 *   blocking Date.now(), Math.random(), eval/Function, functions, symbols, and class instances.
 */
import { createContext, Script } from 'node:vm'
import { assertBoundarySafe } from './boundary-safe.js'
import type { MetaExtraction, WorkflowMeta, WorkflowPhaseMeta } from './types.js'

export class WorkflowMetaError extends Error {}

const META_EVAL_TIMEOUT_MS = 100
const PURE_LITERAL_HINT =
  'The `meta` object must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation.'

/** Single-line determinism prelude shared by meta evaluation and the worker VM root context. */
export const DETERMINISM_PRELUDE =
  'const Date = (function () {' +
  ' const RealDate = globalThis.Date;' +
  ' const die = function (what) {' +
  ' throw new Error(what + " is unavailable in workflow scripts (breaks resume). " +' +
  '   "Stamp results after the workflow returns, or pass timestamps via args.");' +
  ' };' +
  ' RealDate.now = function () { return die("Date.now()"); };' +
  ' Math.random = function () { return die("Math.random()"); };' +
  ' const Restricted = class WorkflowDate extends RealDate {' +
  ' constructor() { if (arguments.length === 0) die("new Date()"); super(...arguments); }' +
  ' };' +
  ' Object.defineProperty(globalThis, "Date", { value: Restricted, writable: false, configurable: false });' +
  ' return Restricted;' +
  '})();'

function fail(message: string): never {
  throw new WorkflowMetaError(message)
}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch)
}

function isRegexPosition(source: string, i: number): boolean {
  let j = i - 1
  while (j >= 0 && /\s/.test(source.charAt(j))) j--
  if (j < 0) return true
  return !/[\w$)\]]/.test(source.charAt(j))
}

function skipWhitespaceAndComments(source: string, start: number): number {
  let i = start
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++
      continue
    }
    if (c === '/' && next === '/') {
      i += 2
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++
      if (i >= source.length) return source.length
      i += 2
      continue
    }
    break
  }
  return i
}

/** Find the first real (non-comment, non-string, top-level) `export const meta =` declaration. */
function findMetaDeclaration(source: string): { exportAt: number; afterEquals: number } | undefined {
  let i = 0
  let braceDepth = 0
  while (i < source.length) {
    const c = source[i]!
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      i += 2
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      const quote = c
      i++
      while (i < source.length && source[i] !== quote && source[i] !== '\n') {
        i += source[i] === '\\' ? 2 : 1
      }
      i++
      continue
    }
    if (c === '`') {
      i++
      while (i < source.length && source[i] !== '`') {
        i += source[i] === '\\' ? 2 : 1
      }
      i++
      continue
    }
    if (c === '{') {
      braceDepth++
      i++
      continue
    }
    if (c === '}') {
      if (braceDepth > 0) braceDepth--
      i++
      continue
    }
    if (braceDepth === 0 && source.startsWith('export', i) && !isIdentChar(source[i - 1]) && !isIdentChar(source[i + 6])) {
      const p1 = skipWhitespaceAndComments(source, i + 6)
      if (source.startsWith('const', p1) && !isIdentChar(source[p1 + 5])) {
        const p2 = skipWhitespaceAndComments(source, p1 + 5)
        if (source.startsWith('meta', p2) && !isIdentChar(source[p2 + 4])) {
          const p3 = skipWhitespaceAndComments(source, p2 + 4)
          if (source[p3] === '=' && source[p3 + 1] !== '=') {
            return { exportAt: i, afterEquals: p3 + 1 }
          }
        }
      }
    }
    i++
  }
  return undefined
}

export function hasMetaDeclaration(source: string): boolean {
  return findMetaDeclaration(source) !== undefined
}

type ScanMode = 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template' | 'regex'

interface LiteralScanResult {
  end: number
  sawInterpolation: boolean
}

/**
 * Mutable state of the object-literal scanner. One step function per lexical mode reads and
 * advances it; the main loop only dispatches on the current mode.
 */
interface LiteralScannerState {
  i: number
  /** Nesting depth of `{` in code mode; back at 0 the literal is closed. */
  depth: number
  mode: ScanMode
  inRegexCharClass: boolean
  /** Depth recorded when a `${` interpolation opened, so its matching `}` resumes the template text. */
  templateStack: number[]
  sawInterpolation: boolean
}

type ScanStep = (source: string, s: LiteralScannerState) => LiteralScanResult | undefined

/** Switch lexical mode and advance `width` chars; `undefined` means the literal is not closed yet. */
function enterMode(s: LiteralScannerState, mode: ScanMode, width: number): undefined {
  s.mode = mode
  s.i += width
  return undefined
}

/** Line comment: the newline itself belongs to code. */
function scanLineComment(source: string, s: LiteralScannerState): undefined {
  if (source[s.i] === '\n') s.mode = 'code'
  s.i++
  return undefined
}

/** Block comment: ends at `*\/`; an unterminated one runs to end of input (reported as never closed). */
function scanBlockComment(source: string, s: LiteralScannerState): undefined {
  if (source[s.i] === '*' && source[s.i + 1] === '/') return enterMode(s, 'code', 2)
  s.i++
  return undefined
}

/** Single/double-quoted string: escapes advance as one unit; the matching quote or a newline returns to code. */
function scanQuoted(source: string, s: LiteralScannerState): undefined {
  const c = source[s.i]
  if (c === '\\') {
    s.i += 2
    return undefined
  }
  const closingQuote = s.mode === 'single' ? "'" : '"'
  if (c === closingQuote || c === '\n') s.mode = 'code'
  s.i++
  return undefined
}

function setRegexCharClass(s: LiteralScannerState, inside: boolean): undefined {
  s.inRegexCharClass = inside
  s.i++
  return undefined
}

/** Regex literal: `/` inside a character class does not close it; an unterminated regex ends at a newline. */
function scanRegex(source: string, s: LiteralScannerState): undefined {
  const c = source[s.i]
  if (c === '\\') {
    s.i += 2
    return undefined
  }
  if (c === '[') return setRegexCharClass(s, true)
  if (c === ']') return setRegexCharClass(s, false)
  if ((c === '/' && !s.inRegexCharClass) || c === '\n') {
    s.inRegexCharClass = false
    return enterMode(s, 'code', 1)
  }
  s.i++
  return undefined
}

/** Template string: a backquote returns to code; `${` opens interpolation code and records the depth to resume at. */
function scanTemplate(source: string, s: LiteralScannerState): undefined {
  const c = source[s.i]
  if (c === '\\') {
    s.i += 2
    return undefined
  }
  if (c === '`') return enterMode(s, 'code', 1)
  if (c === '$' && source[s.i + 1] === '{') {
    s.sawInterpolation = true
    s.templateStack.push(s.depth)
    s.depth++
    return enterMode(s, 'code', 2)
  }
  s.i++
  return undefined
}

/** `}`: resume the enclosing template interpolation, or close the literal when the outermost depth is left. */
function leaveBrace(s: LiteralScannerState): LiteralScanResult | undefined {
  s.depth--
  s.i++
  const stack = s.templateStack
  if (stack.length > 0 && s.depth === stack[stack.length - 1]) {
    stack.pop()
    s.mode = 'template'
    return undefined
  }
  if (s.depth === 0) return { end: s.i, sawInterpolation: s.sawInterpolation }
  return undefined
}

/**
 * Code mode: enter comments / strings / templates / regexes and track `{` `}` depth.
 * A `/` only starts a regex when the previous non-blank char cannot end an expression (else it is division).
 */
function scanCode(source: string, s: LiteralScannerState): LiteralScanResult | undefined {
  const c = source[s.i]
  const next = source[s.i + 1]
  if (c === '/' && next === '/') return enterMode(s, 'line-comment', 2)
  if (c === '/' && next === '*') return enterMode(s, 'block-comment', 2)
  if (c === "'") return enterMode(s, 'single', 1)
  if (c === '"') return enterMode(s, 'double', 1)
  if (c === '`') return enterMode(s, 'template', 1)
  if (c === '/' && isRegexPosition(source, s.i)) {
    s.inRegexCharClass = false
    return enterMode(s, 'regex', 1)
  }
  if (c === '{') {
    s.depth++
    s.i++
    return undefined
  }
  if (c === '}') return leaveBrace(s)
  s.i++
  return undefined
}

const SCAN_STEPS: Record<ScanMode, ScanStep> = {
  code: scanCode,
  'line-comment': scanLineComment,
  'block-comment': scanBlockComment,
  single: scanQuoted,
  double: scanQuoted,
  template: scanTemplate,
  regex: scanRegex,
}

/**
 * Scan the object literal starting at `source[open] === '{'` lexically (comments / strings /
 * templates / regexes never affect brace depth) and report the index just past its closing `}`
 * (-1 when it is never closed) plus whether a template interpolation was seen.
 */
function scanObjectLiteral(source: string, open: number): LiteralScanResult {
  const s: LiteralScannerState = {
    i: open,
    depth: 0,
    mode: 'code',
    inRegexCharClass: false,
    templateStack: [],
    sawInterpolation: false,
  }
  while (s.i < source.length) {
    const closed = SCAN_STEPS[s.mode](source, s)
    if (closed !== undefined) return closed
  }
  return { end: -1, sawInterpolation: s.sawInterpolation }
}

function assertPhases(value: unknown): WorkflowPhaseMeta[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) fail('`meta.phases` must be an array of { title, detail?, model? } objects.')
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`\`meta.phases[${index}]\` must be an object with a \`title\`.`)
    }
    const { title, detail, model } = entry as Record<string, unknown>
    if (typeof title !== 'string' || title.trim() === '') {
      fail(`\`meta.phases[${index}].title\` must be a non-empty string.`)
    }
    if (detail !== undefined && typeof detail !== 'string') {
      fail(`\`meta.phases[${index}].detail\` must be a string.`)
    }
    if (model !== undefined && typeof model !== 'string') {
      fail(`\`meta.phases[${index}].model\` must be a string.`)
    }
    return {
      title,
      ...(detail !== undefined ? { detail } : {}),
      ...(model !== undefined ? { model } : {}),
    }
  })
}

export function extractMeta(source: string): MetaExtraction {
  const decl = findMetaDeclaration(source)
  if (!decl) {
    fail('A workflow script must begin with `export const meta = { name, description }`.\n' + PURE_LITERAL_HINT)
  }

  const open = skipWhitespaceAndComments(source, decl.afterEquals)
  if (source[open] !== '{') {
    fail('`export const meta` must be assigned an object literal.\n' + PURE_LITERAL_HINT)
  }

  const { end: close, sawInterpolation } = scanObjectLiteral(source, open)
  if (close === -1) fail('`meta` object literal is never closed — check for an unbalanced `{`.')
  if (sawInterpolation) fail('`meta` must not use template interpolation (`${...}`).\n' + PURE_LITERAL_HINT)

  const fragment = source.slice(open, close)
  let value: unknown
  try {
    const ctx = createContext({}, { codeGeneration: { strings: false, wasm: false } })
    const rawValue = new Script(`(() => { ${DETERMINISM_PRELUDE} return (${fragment}); })()`, {
      filename: 'workflow-meta.js',
    }).runInContext(ctx, { timeout: META_EVAL_TIMEOUT_MS })
    // Cross-realm normalization + strict pure-JSON validation (rejects functions/symbols/Date/cycles).
    value = JSON.parse(JSON.stringify(rawValue))
    assertBoundarySafe(value, 'meta')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (/timed out|Script execution/i.test(detail)) {
      fail(`\`meta\` did not finish evaluating within ${META_EVAL_TIMEOUT_MS}ms — it must be a literal, not a computation.\n` + PURE_LITERAL_HINT)
    }
    fail(`\`meta\` could not be evaluated: ${detail}\n${PURE_LITERAL_HINT}`)
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('`meta` must be an object literal.\n' + PURE_LITERAL_HINT)
  }
  const raw = value as Record<string, unknown>
  if (typeof raw['name'] !== 'string' || raw['name'].trim() === '') {
    fail('`meta.name` is required and must be a non-empty string.')
  }
  if (typeof raw['description'] !== 'string' || raw['description'].trim() === '') {
    fail('`meta.description` is required and must be a non-empty string.')
  }
  if (raw['whenToUse'] !== undefined && typeof raw['whenToUse'] !== 'string') {
    fail('`meta.whenToUse` must be a string.')
  }
  const phases = assertPhases(raw['phases'])

  const meta: WorkflowMeta = {
    name: raw['name'],
    description: raw['description'],
    ...(raw['whenToUse'] !== undefined ? { whenToUse: raw['whenToUse'] } : {}),
    ...(phases !== undefined ? { phases } : {}),
  }

  const body = `${source.slice(0, decl.exportAt)}${' '.repeat(6)}${source.slice(decl.exportAt + 6)}`
  return { meta, body }
}
