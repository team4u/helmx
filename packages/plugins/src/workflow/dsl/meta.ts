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
import { assertBoundarySafe } from './boundary.js'
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
  while (j >= 0 && /\s/.test(source[j]!)) j--
  if (j < 0) return true
  return !/[\w$)\]]/.test(source[j]!)
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

function scanObjectLiteral(source: string, open: number): { end: number; sawInterpolation: boolean } {
  let depth = 0
  let i = open
  let sawInterpolation = false
  let mode: 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template' | 'regex' = 'code'
  let inRegexCharClass = false
  const templateStack: number[] = []

  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]

    if (mode === 'line-comment') {
      if (c === '\n') mode = 'code'
      i++
      continue
    }
    if (mode === 'block-comment') {
      if (c === '*' && next === '/') {
        mode = 'code'
        i += 2
        continue
      }
      i++
      continue
    }
    if (mode === 'single' || mode === 'double') {
      if (c === '\\') {
        i += 2
        continue
      }
      if ((mode === 'single' && c === "'") || (mode === 'double' && c === '"') || c === '\n') {
        mode = 'code'
      }
      i++
      continue
    }
    if (mode === 'regex') {
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '[') inRegexCharClass = true
      else if (c === ']') inRegexCharClass = false
      else if ((c === '/' && !inRegexCharClass) || c === '\n') {
        inRegexCharClass = false
        mode = 'code'
      }
      i++
      continue
    }
    if (mode === 'template') {
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '`') {
        mode = 'code'
        i++
        continue
      }
      if (c === '$' && next === '{') {
        sawInterpolation = true
        templateStack.push(depth)
        depth++
        mode = 'code'
        i += 2
        continue
      }
      i++
      continue
    }

    if (c === '/' && next === '/') {
      mode = 'line-comment'
      i += 2
      continue
    }
    if (c === '/' && next === '*') {
      mode = 'block-comment'
      i += 2
      continue
    }
    if (c === "'") {
      mode = 'single'
      i++
      continue
    }
    if (c === '"') {
      mode = 'double'
      i++
      continue
    }
    if (c === '`') {
      mode = 'template'
      i++
      continue
    }
    if (c === '/' && isRegexPosition(source, i)) {
      mode = 'regex'
      inRegexCharClass = false
      i++
      continue
    }
    if (c === '{') {
      depth++
      i++
      continue
    }
    if (c === '}') {
      depth--
      i++
      if (templateStack.length > 0 && depth === templateStack[templateStack.length - 1]!) {
        templateStack.pop()
        mode = 'template'
        continue
      }
      if (depth === 0) return { end: i, sawInterpolation }
      continue
    }
    i++
  }
  return { end: -1, sawInterpolation }
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
