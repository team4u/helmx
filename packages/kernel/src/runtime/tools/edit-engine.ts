/**
 * Pure text-editing engine for the `edit` tool (zero IO; shared identically by local and remote nodes).
 *
 * Design highlights:
 * - Supports both single replacement (`oldText`/`newText` + `replaceAll`/`allowEmbeddedMatch`) and atomic batch
 *   (`edits[]`) mutually exclusively, with `prepareEditArguments` repairing JSON-stringified or single-object
 *   `edits` shapes commonly emitted by models;
 * - Preserves UTF-8 BOM and per-line mixed line endings (`\r\n` / `\n` / `\r`): untouched lines keep their exact
 *   original line separators, avoiding noisy CRLF/LF whole-file diffs on Windows/cross-platform repositories;
 * - Evaluates each edit item independently: exact match first, per-item `normalizeForFuzzyMatch` fallback only when
 *   exact matching yields 0 hits (never downgrading unrelated exact items in the same batch);
 * - Guards `replaceAll: true` against accidental partial-identifier corruption via Unicode `\p{ID_Continue}$`
 *   boundary checks unless `allowEmbeddedMatch: true` is specified;
 * - Emits high-signal redacted diagnostics on failure: approximate `(line, col)` + invisible/lookalike character
 *   hints when missing, and matched line ranges with surrounding context when ambiguous (`count > 1`).
 */
import type { EditReplacedSpan } from '../tool-edit-diff.js'

export type LineEnding = '\r\n' | '\n' | '\r'

export interface EditOperation {
  readonly oldText: string
  readonly newText: string
  readonly replaceAll: boolean
  readonly allowEmbeddedMatch: boolean
}

export type ExtractEditOperationsResult =
  | { ok: true; operations: EditOperation[] }
  | { ok: false; error: string }

export type ApplyEditsResult =
  | {
      ok: true
      updatedFileContent: string
      lfOriginal: string
      lfUpdated: string
      appliedSpans: EditReplacedSpan[]
      totalReplacements: number
    }
  | { ok: false; error: string }

const IDENTIFIER_CHAR_RE = /^[\p{ID_Continue}$]$/u
const MAX_DUPLICATE_MATCHES_SHOWN = 5
const MAX_DIFF_CANDIDATE_LINES = 4_000
const MAX_CANDIDATE_LINE_CHARS = 500
const DUPLICATE_LINE_CLIP_CHARS = 160

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSingleEditCandidate(value: unknown): value is { oldText: string; newText: string } {
  return (
    isPlainRecord(value) &&
    typeof value['oldText'] === 'string' &&
    typeof value['newText'] === 'string'
  )
}

/**
 * Repair malformed argument shapes models commonly emit:
 * - `edits` serialized as a JSON string (array or single edit object);
 * - `edits` passed directly as a single `{ oldText, newText }` object.
 * Mutates nothing; leaves top-level `{ oldText, newText }` untouched so mutual-exclusivity validation stays strict.
 */
export function prepareEditArguments(input: unknown): unknown {
  if (!isPlainRecord(input)) return input
  const copy: Record<string, unknown> = { ...input }
  if (typeof copy['edits'] === 'string') {
    try {
      const parsed: unknown = JSON.parse(copy['edits'])
      if (Array.isArray(parsed)) {
        copy['edits'] = parsed
      } else if (isSingleEditCandidate(parsed)) {
        copy['edits'] = [parsed]
      }
    } catch {
      // Invalid JSON string falls through cleanly to schema / `extractEditOperations` validation.
    }
  } else if (isSingleEditCandidate(copy['edits'])) {
    copy['edits'] = [copy['edits']]
  }
  return copy
}

function parseSingleOp(
  record: Record<string, unknown>,
  label: string,
): { ok: true; op: EditOperation } | { ok: false; error: string } {
  const oldText = record['oldText']
  const newText = record['newText']
  if (typeof oldText !== 'string' || typeof newText !== 'string') {
    return { ok: false, error: `edit_failed: invalid_edit_args: ${label} requires string oldText and newText` }
  }
  if (oldText.length === 0) {
    return { ok: false, error: `edit_failed: invalid_edit_args: ${label}.oldText must not be empty` }
  }
  const replaceAll = record['replaceAll']
  if (replaceAll !== undefined && typeof replaceAll !== 'boolean') {
    return { ok: false, error: `edit_failed: invalid_edit_args: ${label}.replaceAll must be a boolean` }
  }
  const allowEmbeddedMatch = record['allowEmbeddedMatch']
  if (allowEmbeddedMatch !== undefined && typeof allowEmbeddedMatch !== 'boolean') {
    return {
      ok: false,
      error: `edit_failed: invalid_edit_args: ${label}.allowEmbeddedMatch must be a boolean`,
    }
  }
  return {
    ok: true,
    op: {
      oldText,
      newText,
      replaceAll: replaceAll === true,
      allowEmbeddedMatch: allowEmbeddedMatch === true,
    },
  }
}

/** Validate and normalize either single-edit (`oldText`/`newText`) or batch (`edits[]`) request shape. */
export function extractEditOperations(rawInput: unknown): ExtractEditOperationsResult {
  const prepared = prepareEditArguments(rawInput)
  if (!isPlainRecord(prepared)) {
    return { ok: false, error: 'edit_failed: invalid_edit_args: input must be an object' }
  }
  const hasTopPair =
    prepared['oldText'] !== undefined ||
    prepared['newText'] !== undefined ||
    prepared['replaceAll'] !== undefined ||
    prepared['allowEmbeddedMatch'] !== undefined
  const hasEdits = prepared['edits'] !== undefined
  if (hasTopPair && hasEdits) {
    return {
      ok: false,
      error: 'edit_failed: invalid_edit_args: provide either top-level oldText/newText or edits[], not both',
    }
  }
  if (hasEdits) {
    const rawEdits = prepared['edits']
    if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
      return {
        ok: false,
        error: 'edit_failed: invalid_edit_args: edits must be a non-empty array of replacements',
      }
    }
    const operations: EditOperation[] = []
    for (let i = 0; i < rawEdits.length; i += 1) {
      const item = rawEdits[i]
      if (!isPlainRecord(item)) {
        return {
          ok: false,
          error: `edit_failed: invalid_edit_args: edits[${i}] must be an object`,
        }
      }
      const parsed = parseSingleOp(item, `edits[${i}]`)
      if (!parsed.ok) return parsed
      operations.push(parsed.op)
    }
    return { ok: true, operations }
  }
  const single = parseSingleOp(prepared, 'edit')
  if (!single.ok) return single
  return { ok: true, operations: [single.op] }
}

// ---------------------------------------------------------------------------
// BOM and per-line separator preservation
// ---------------------------------------------------------------------------

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith('\uFEFF')
    ? { bom: '\uFEFF', text: content.slice(1) }
    : { bom: '', text: content }
}

function toLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function detectDominantEnding(text: string): LineEnding {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i)
    if (ch === 13) return text.charCodeAt(i + 1) === 10 ? '\r\n' : '\r'
    if (ch === 10) return '\n'
  }
  return '\n'
}

function splitSeparators(text: string): LineEnding[] {
  const separators: LineEnding[] = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i)
    if (ch === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        separators.push('\r\n')
        i += 1
      } else {
        separators.push('\r')
      }
    } else if (ch === 10) {
      separators.push('\n')
    }
  }
  return separators
}

function countNewlinesInSlice(text: string, start = 0, end = text.length): number {
  let count = 0
  for (let i = start; i < end; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1
  }
  return count
}

/**
 * Reconstruct original line endings after applying disjoint replacements in LF space.
 * Untouched `\n` characters keep their exact original separator (`\r\n` | `\n` | `\r`); newlines added
 * by a replacement inherit the separator(s) from the replaced span, or nearest adjacent/dominant ending.
 */
function restorePerLineSeparators(
  lfOriginal: string,
  baseSeparators: readonly LineEnding[],
  dominantEnding: LineEnding,
  replacements: readonly { offset: number; length: number; text: string }[],
): string {
  if (replacements.length === 0) {
    let out = ''
    let sepIdx = 0
    for (let i = 0; i < lfOriginal.length; i += 1) {
      if (lfOriginal.charCodeAt(i) === 10) {
        out += baseSeparators[sepIdx] ?? dominantEnding
        sepIdx += 1
      } else {
        out += lfOriginal[i]!
      }
    }
    return out
  }

  let out = ''
  let origCursor = 0
  let sepCursor = 0

  const emitOriginalSlice = (upto: number): void => {
    for (let i = origCursor; i < upto; i += 1) {
      if (lfOriginal.charCodeAt(i) === 10) {
        out += baseSeparators[sepCursor] ?? dominantEnding
        sepCursor += 1
      } else {
        out += lfOriginal[i]!
      }
    }
    origCursor = upto
  }

  for (const r of replacements) {
    emitOriginalSlice(r.offset)
    const spanNewlineCount = countNewlinesInSlice(lfOriginal, r.offset, r.offset + r.length)
    const spanSeps = baseSeparators.slice(sepCursor, sepCursor + spanNewlineCount)
    const fallbackSep =
      spanSeps[0] ??
      baseSeparators[sepCursor] ??
      baseSeparators[sepCursor - 1] ??
      dominantEnding
    let localNewlineIdx = 0
    for (let i = 0; i < r.text.length; i += 1) {
      if (r.text.charCodeAt(i) === 10) {
        out +=
          spanSeps.length > 0
            ? (spanSeps[Math.min(localNewlineIdx, spanSeps.length - 1)] ?? fallbackSep)
            : fallbackSep
        localNewlineIdx += 1
      } else {
        out += r.text[i]!
      }
    }
    origCursor = r.offset + r.length
    sepCursor += spanNewlineCount
  }

  emitOriginalSlice(lfOriginal.length)
  return out
}

// ---------------------------------------------------------------------------
// Line indexing & fuzzy normalization
// ---------------------------------------------------------------------------

function scanLineStarts(text: string): number[] {
  if (text === '') return [0]
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10 && i + 1 < text.length) starts.push(i + 1)
  }
  return starts
}

function lineNumberAt(lineStarts: readonly number[], offset: number): number {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

function normalizeFuzzyLine(line: string): string {
  return line
    .normalize('NFKC')
    .trimEnd()
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
}

function normalizeForFuzzyMatch(text: string): string {
  return text.split('\n').map(normalizeFuzzyLine).join('\n')
}

interface LineSpan {
  start: number
  end: number
  text: string
}

function computeLineSpans(lfText: string): LineSpan[] {
  const spans: LineSpan[] = []
  let start = 0
  for (let i = 0; i < lfText.length; i += 1) {
    if (lfText.charCodeAt(i) === 10) {
      spans.push({ start, end: i + 1, text: lfText.slice(start, i) })
      start = i + 1
    }
  }
  if (start < lfText.length || lfText === '') {
    spans.push({ start, end: lfText.length, text: lfText.slice(start) })
  }
  return spans
}

function findNonOverlappingOccurrences(haystack: string, needle: string): number[] {
  if (needle === '') return []
  const offsets: number[] = []
  let pos = haystack.indexOf(needle)
  while (pos !== -1) {
    offsets.push(pos)
    pos = haystack.indexOf(needle, pos + needle.length)
  }
  return offsets
}

// ---------------------------------------------------------------------------
// Identifier isolation guard & failure diagnostics
// ---------------------------------------------------------------------------

function firstCodePointOf(text: string): string {
  const cp = text.codePointAt(0)
  return cp === undefined ? '' : String.fromCodePoint(cp)
}

function lastCodePointOf(text: string): string {
  if (text.length === 0) return ''
  const last = text.charCodeAt(text.length - 1)
  if (last >= 0xdc00 && last <= 0xdfff && text.length >= 2) {
    const prev = text.charCodeAt(text.length - 2)
    if (prev >= 0xd800 && prev <= 0xdbff) {
      return text.slice(text.length - 2)
    }
  }
  return text[text.length - 1]!
}

function codePointBefore(text: string, offset: number): string {
  if (offset <= 0) return ''
  const last = text.charCodeAt(offset - 1)
  if (last >= 0xdc00 && last <= 0xdfff && offset >= 2) {
    const prev = text.charCodeAt(offset - 2)
    if (prev >= 0xd800 && prev <= 0xdbff) {
      return text.slice(offset - 2, offset)
    }
  }
  return text[offset - 1]!
}

function extractSurroundingToken(text: string, start: number, end: number): string {
  let left = start
  while (left > 0) {
    const cp = codePointBefore(text, left)
    if (!IDENTIFIER_CHAR_RE.test(cp)) break
    left -= cp.length
  }
  let right = end
  while (right < text.length) {
    const cp = firstCodePointOf(text.slice(right))
    if (!cp || !IDENTIFIER_CHAR_RE.test(cp)) break
    right += cp.length
  }
  const token = text.slice(left, right)
  return token.length > 80 ? `${token.slice(0, 77)}...` : token
}

function checkMatchIsolation(
  haystack: string,
  lineStarts: readonly number[],
  offsets: readonly number[],
  matchLen: number,
  previewSource: string,
  redact: (text: string) => string,
): string | undefined {
  const checkLeft = IDENTIFIER_CHAR_RE.test(firstCodePointOf(previewSource))
  const checkRight = IDENTIFIER_CHAR_RE.test(lastCodePointOf(previewSource))
  if (!checkLeft && !checkRight) return undefined

  for (const start of offsets) {
    const end = start + matchLen
    const leftTouch = checkLeft && IDENTIFIER_CHAR_RE.test(codePointBefore(haystack, start))
    const rightTouch = checkRight && IDENTIFIER_CHAR_RE.test(firstCodePointOf(haystack.slice(end)))
    if (leftTouch || rightTouch) {
      const line = lineNumberAt(lineStarts, start)
      const token = redact(extractSurroundingToken(haystack, start, end))
      const singleLinePreview = redact(previewSource.split('\n')[0] ?? previewSource).slice(0, 60)
      return (
        `edit_failed: replaceAll match for "${singleLinePreview}" at line ${line} is embedded inside ` +
        `identifier "${token}". Include surrounding context or pass allowEmbeddedMatch: true if substring replacement is intended.`
      )
    }
  }
  return undefined
}

function clipLine(text: string, max = DUPLICATE_LINE_CLIP_CHARS): string {
  const clean = text.replace(/\n$/, '')
  return clean.length <= max ? clean : `${clean.slice(0, max - 3)}...`
}

function buildDuplicateDiagnostic(
  lfOriginal: string,
  lineStarts: readonly number[],
  offsets: readonly number[],
  matchLen: number,
  absPath: string,
  label: string,
  redact: (text: string) => string,
): string {
  const lines = lfOriginal.split('\n')
  const shown = offsets.slice(0, MAX_DUPLICATE_MATCHES_SHOWN)
  const items = shown.map((offset, idx) => {
    const startLine = lineNumberAt(lineStarts, offset)
    const endOffset = Math.max(offset, offset + matchLen - 1)
    const endLine = lineNumberAt(lineStarts, endOffset)
    const ctxFrom = Math.max(1, startLine - 1)
    const ctxTo = Math.min(lines.length, endLine + 1)
    const snippetRows: string[] = []
    for (let ln = ctxFrom; ln <= ctxTo; ln += 1) {
      snippetRows.push(`  ${ln} | ${redact(clipLine(lines[ln - 1] ?? ''))}`)
    }
    const rangeLabel = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`
    return `- Match ${idx + 1} (${rangeLabel}):\n${snippetRows.join('\n')}`
  })
  const omittedNote =
    offsets.length > shown.length ? `\n... and ${offsets.length - shown.length} more occurrences.` : ''
  return (
    `edit_failed: ${label} appeared ${offsets.length} times in ${absPath} ` +
    `(must match uniquely; include more surrounding context or pass replaceAll: true):\n` +
    `${items.join('\n')}${omittedNote}`
  )
}

function detectUnicodeClues(needle: string, candidate: string): string[] {
  const clues: string[] = []
  const invisibleRe = /[\u200B-\u200D\uFEFF]/
  if (invisibleRe.test(needle) !== invisibleRe.test(candidate)) {
    clues.push('zero-width character (U+200B..U+200D/U+FEFF) difference')
  }
  if (needle.includes('\u00A0') !== candidate.includes('\u00A0')) {
    clues.push('non-breaking space (U+00A0) difference')
  }
  const hasTabsNeedle = /^\t+/m.test(needle)
  const hasTabsCand = /^\t+/m.test(candidate)
  if (hasTabsNeedle !== hasTabsCand) {
    clues.push('tab vs space indentation difference')
  }
  const smartQuotesRe = /[\u2018\u2019\u201C\u201D\uFF01-\uFF5E]/
  if (smartQuotesRe.test(needle) !== smartQuotesRe.test(candidate)) {
    clues.push('smart-quote or fullwidth Unicode punctuation difference')
  }
  return clues
}

function charSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  if (a.length > MAX_CANDIDATE_LINE_CHARS || b.length > MAX_CANDIDATE_LINE_CHARS) {
    return 0
  }
  let prefix = 0
  const minLen = Math.min(a.length, b.length)
  while (prefix < minLen && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix += 1
  let suffix = 0
  while (
    suffix < minLen - prefix &&
    a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)
  ) {
    suffix += 1
  }
  return (prefix + suffix) / maxLen
}

function formatSnippetAround(text: string, index: number, radius = 24): string {
  const start = Math.max(0, index - 8)
  const end = Math.min(text.length, index + radius)
  const slice = text.slice(start, end)
  return JSON.stringify(slice)
}

function buildNotFoundDiagnostic(
  lfOriginal: string,
  oldText: string,
  absPath: string,
  label: string,
  redact: (text: string) => string,
): string {
  const baseMsg = `edit_failed: ${label} was not found in ${absPath} (edit rejected)`
  const fileLines = lfOriginal.split('\n')
  const needleLines = oldText.split('\n')
  if (fileLines.length === 0 || needleLines.length === 0 || fileLines.length > MAX_DIFF_CANDIDATE_LINES) {
    return baseMsg
  }

  const windowCount = Math.max(1, fileLines.length - needleLines.length + 1)
  let bestStart = -1
  let bestScore = 0

  for (let start = 0; start < windowCount; start += 1) {
    let scoreSum = 0
    let compareLines = 0
    for (let j = 0; j < needleLines.length; j += 1) {
      const candLine = fileLines[start + j] ?? ''
      const needLine = needleLines[j] ?? ''
      if (candLine.trim() === '' && needLine.trim() === '') continue
      compareLines += 1
      scoreSum += charSimilarity(candLine, needLine)
    }
    if (compareLines === 0) continue
    const avg = scoreSum / compareLines
    if (avg > bestScore) {
      bestScore = avg
      bestStart = start
    }
  }

  if (bestStart === -1 || bestScore < 0.55) {
    return baseMsg
  }

  const candidate = fileLines.slice(bestStart, bestStart + needleLines.length).join('\n')
  let mismatchIdx = 0
  const maxCheck = Math.min(candidate.length, oldText.length)
  while (mismatchIdx < maxCheck && candidate[mismatchIdx] === oldText[mismatchIdx]) {
    mismatchIdx += 1
  }
  const candSubStarts = scanLineStarts(candidate)
  const relLine = lineNumberAt(candSubStarts, mismatchIdx)
  const fileLine = bestStart + relLine
  const col = mismatchIdx - candSubStarts[relLine - 1]! + 1
  const fileGot = redact(formatSnippetAround(candidate, mismatchIdx))
  const expectedGot = redact(formatSnippetAround(oldText, mismatchIdx))
  const clues = detectUnicodeClues(oldText, candidate)
  const clueText = clues.length > 0 ? ` [${clues.join('; ')}]` : ''
  return (
    `${baseMsg}. Closest match near line ${fileLine}, col ${col}: ` +
    `file has ${fileGot} where oldText has ${expectedGot}${clueText}`
  )
}

// ---------------------------------------------------------------------------
// Main batched/single edit application
// ---------------------------------------------------------------------------

interface PlannedReplacement {
  readonly editIndex: number
  readonly offset: number
  readonly length: number
  readonly replacementText: string
}

function planSingleOperation(
  editIndex: number,
  op: EditOperation,
  totalOps: number,
  lfOriginal: string,
  lineStarts: readonly number[],
  absPath: string,
  redact: (text: string) => string,
  lazyFuzzy: {
    lines?: LineSpan[]
    origLines?: LineSpan[]
    fuzzyText?: string
    fuzzyLineStarts?: number[]
  },
): { ok: true; replacements: PlannedReplacement[] } | { ok: false; error: string } {
  const label = totalOps === 1 ? 'oldText' : `edits[${editIndex}].oldText`
  const needle = toLF(op.oldText)
  const newText = toLF(op.newText)

  const exactOffsets = findNonOverlappingOccurrences(lfOriginal, needle)
  if (exactOffsets.length > 0) {
    if (!op.replaceAll && exactOffsets.length > 1) {
      return {
        ok: false,
        error: buildDuplicateDiagnostic(
          lfOriginal,
          lineStarts,
          exactOffsets,
          needle.length,
          absPath,
          label,
          redact,
        ),
      }
    }
    if (op.replaceAll && !op.allowEmbeddedMatch) {
      const isolationErr = checkMatchIsolation(
        lfOriginal,
        lineStarts,
        exactOffsets,
        needle.length,
        needle,
        redact,
      )
      if (isolationErr !== undefined) return { ok: false, error: isolationErr }
    }
    return {
      ok: true,
      replacements: exactOffsets.map((offset) => ({
        editIndex,
        offset,
        length: needle.length,
        replacementText: newText,
      })),
    }
  }

  // Exact failed -> fall back to per-item fuzzy normalization without altering other exact items.
  const fuzzyOld = normalizeForFuzzyMatch(needle)
  if (fuzzyOld.length === 0) {
    return {
      ok: false,
      error: buildNotFoundDiagnostic(lfOriginal, needle, absPath, label, redact),
    }
  }

  if (lazyFuzzy.fuzzyText === undefined) {
    lazyFuzzy.origLines = computeLineSpans(lfOriginal)
    const fuzzyText = lfOriginal
      .split('\n')
      .map(normalizeFuzzyLine)
      .join('\n')
    lazyFuzzy.fuzzyText = fuzzyText
    lazyFuzzy.lines = computeLineSpans(fuzzyText)
    lazyFuzzy.fuzzyLineStarts = scanLineStarts(fuzzyText)
  }

  const origLines = lazyFuzzy.origLines!
  const fuzzyLines = lazyFuzzy.lines!
  const fuzzyText = lazyFuzzy.fuzzyText!
  const fuzzyLineStarts = lazyFuzzy.fuzzyLineStarts!

  if (origLines.length !== fuzzyLines.length) {
    return {
      ok: false,
      error: buildNotFoundDiagnostic(lfOriginal, needle, absPath, label, redact),
    }
  }

  const fuzzyOffsets = findNonOverlappingOccurrences(fuzzyText, fuzzyOld)
  if (fuzzyOffsets.length === 0) {
    return {
      ok: false,
      error: buildNotFoundDiagnostic(lfOriginal, needle, absPath, label, redact),
    }
  }
  if (!op.replaceAll && fuzzyOffsets.length > 1) {
    return {
      ok: false,
      error: buildDuplicateDiagnostic(
        lfOriginal,
        fuzzyLineStarts,
        fuzzyOffsets,
        fuzzyOld.length,
        absPath,
        label,
        redact,
      ),
    }
  }
  if (op.replaceAll && !op.allowEmbeddedMatch) {
    const isolationErr = checkMatchIsolation(
      fuzzyText,
      fuzzyLineStarts,
      fuzzyOffsets,
      fuzzyOld.length,
      fuzzyOld,
      redact,
    )
    if (isolationErr !== undefined) return { ok: false, error: isolationErr }
  }

  // Map each fuzzy match back to touched line block(s) in `lfOriginal`, merging contiguous line groups
  // when multiple occurrences under `replaceAll` fall on the same line block.
  interface LineGroup {
    startLine: number
    endLine: number
    matches: Array<{ start: number; length: number }>
  }
  const groups: LineGroup[] = []
  for (const fStart of fuzzyOffsets) {
    const startLine = lineNumberAt(fuzzyLineStarts, fStart) - 1
    const endOffset = Math.max(fStart, fStart + fuzzyOld.length - 1)
    const endLine = lineNumberAt(fuzzyLineStarts, endOffset) - 1
    const prev = groups[groups.length - 1]
    if (prev !== undefined && startLine <= prev.endLine) {
      prev.endLine = Math.max(prev.endLine, endLine)
      prev.matches.push({ start: fStart, length: fuzzyOld.length })
    } else {
      groups.push({ startLine, endLine, matches: [{ start: fStart, length: fuzzyOld.length }] })
    }
  }

  const replacements: PlannedReplacement[] = groups.map((group) => {
    const fuzzyBlockStart = fuzzyLines[group.startLine]!.start
    const fuzzyBlockEnd = fuzzyLines[group.endLine]!.end
    let blockText = fuzzyText.slice(fuzzyBlockStart, fuzzyBlockEnd)
    for (let m = group.matches.length - 1; m >= 0; m -= 1) {
      const match = group.matches[m]!
      const localOffset = match.start - fuzzyBlockStart
      blockText = blockText.slice(0, localOffset) + newText + blockText.slice(localOffset + match.length)
    }
    const origBlockStart = origLines[group.startLine]!.start
    const origBlockEnd = origLines[group.endLine]!.end
    return {
      editIndex,
      offset: origBlockStart,
      length: origBlockEnd - origBlockStart,
      replacementText: blockText,
    }
  })

  return { ok: true, replacements }
}

/**
 * Match and apply all operations atomically against `rawContent`. Preserves UTF-8 BOM and untouched lines'
 * exact line separators; produces exact LF before/after texts and sorted spans for `computeMultiEditDiff`.
 */
export function applyEditOperations(
  rawContent: string,
  operations: readonly EditOperation[],
  absPath: string,
  redact: (text: string) => string,
): ApplyEditsResult {
  const { bom, text: rawNoBom } = stripBom(rawContent)
  const dominantEnding = detectDominantEnding(rawNoBom)
  const baseSeparators = splitSeparators(rawNoBom)
  const lfOriginal = toLF(rawNoBom)
  const lineStarts = scanLineStarts(lfOriginal)
  const lazyFuzzy: {
    lines?: LineSpan[]
    origLines?: LineSpan[]
    fuzzyText?: string
    fuzzyLineStarts?: number[]
  } = {}

  const allReplacements: PlannedReplacement[] = []
  for (let i = 0; i < operations.length; i += 1) {
    const planned = planSingleOperation(
      i,
      operations[i]!,
      operations.length,
      lfOriginal,
      lineStarts,
      absPath,
      redact,
      lazyFuzzy,
    )
    if (!planned.ok) return planned
    allReplacements.push(...planned.replacements)
  }

  allReplacements.sort((a, b) => a.offset - b.offset)
  for (let i = 1; i < allReplacements.length; i += 1) {
    const prev = allReplacements[i - 1]!
    const curr = allReplacements[i]!
    if (prev.offset + prev.length > curr.offset) {
      const prevLabel = prev.editIndex === curr.editIndex ? `edits[${prev.editIndex}] matches` : `edits[${prev.editIndex}] and edits[${curr.editIndex}]`
      return {
        ok: false,
        error: `edit_failed: ${prevLabel} overlap in ${absPath} (merge adjacent changes into a single edit)`,
      }
    }
  }

  // Apply replacements literally in reverse offset order in LF space.
  let lfUpdated = lfOriginal
  for (let i = allReplacements.length - 1; i >= 0; i -= 1) {
    const r = allReplacements[i]!
    lfUpdated = lfUpdated.slice(0, r.offset) + r.replacementText + lfUpdated.slice(r.offset + r.length)
  }

  const restored = restorePerLineSeparators(
    lfOriginal,
    baseSeparators,
    dominantEnding,
    allReplacements.map((r) => ({ offset: r.offset, length: r.length, text: r.replacementText })),
  )

  const appliedSpans: EditReplacedSpan[] = allReplacements.map((r) => ({
    matchOffset: r.offset,
    replacedLength: r.length,
    insertedLength: r.replacementText.length,
  }))

  return {
    ok: true,
    updatedFileContent: bom + restored,
    lfOriginal,
    lfUpdated,
    appliedSpans,
    totalReplacements: allReplacements.length,
  }
}
