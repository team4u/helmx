/**
 * Real diff computation for the `edit` tool (sole implementation; shared by local and remote execution paths).
 *
 * Contract (aligned with `@helmx/protocol` `EDIT_TOOL_RESULT_SCHEMA`):
 * - Inputs are the full texts before/after an exact unique replacement and the replaced span: `original`,
 *   `updated` (must match real updated content), and `matchOffset` / `replacedLength` (the unique matched range
 *   of `oldText` in `original`). Throws immediately on broken preconditions (`edit_failed` before writing so the file
 *   is never modified);
 * - Diff computes only a `+-3` line context window around the modified lines (never diffs whole huge files);
 *   line numbers come from real newline scans (fast prefix scan without sacrificing correctness for `O(changes)`);
 * - Redact first: redact full `original` and `updated` before slicing window lines (slicing first then redacting
 *   could leak multi-line secrets crossing window boundaries);
 * - Line numbers and counts always reflect the raw text: `addedLines` / `removedLines` / `firstChangedLine` come
 *   from raw `diffLines` differences across the unredacted window, unaffected by row display truncation;
 * - If full-text redaction alters line count (e.g. a secret contains newlines replaced by a single-line placeholder),
 *   window lines no longer align with real file line numbers — falls back to `rows = []`, `truncated = true`, while
 *   keeping raw line counts; never fabricates line numbers or leaks secrets;
 * - Display budgets count post-redaction text: `rows <= TOOL_DIFF_MAX_ROWS`, per-row chars <= `TOOL_DIFF_MAX_ROW_CHARS`
 *   (long rows truncate for display while counts reflect full lines), cumulative chars <= `TOOL_DIFF_MAX_TEXT_CHARS`;
 *   any truncation sets `truncated = true`;
 * - Algorithmic diff budget: `diffLines` uses `maxEditLength` (returns `undefined` when exceeded) so huge diffs never
 *   stall the kernel; falls back to full-span replacement (strip common prefix/suffix lines, remove old, add new —
 *   valid though non-minimal, with consistent counts and explicit `truncated = true`);
 * - No-op (`updated === original`, i.e. `oldText === newText`): `rows = []`, counts `0`, `firstChangedLine` = match line.
 */

import { diffLines, type Change } from 'diff'
import {
  TOOL_DIFF_MAX_ROW_CHARS,
  TOOL_DIFF_MAX_ROWS,
  TOOL_DIFF_MAX_TEXT_CHARS,
  type ToolDiffRow,
  type ToolEditDiff,
} from '@helmx/protocol'

/** Context lines retained before and after edited spans. */
const EDIT_CONTEXT_LINES = 3

/**
 * Algorithmic edit-length budget for `diffLines`: 10x `TOOL_DIFF_MAX_ROWS` — diffs exceeding this always
 * produce far more add/remove rows than fit the row budget anyway, so falling back to full-span replacement
 * preserves all renderable info while bounding kernel CPU cost.
 */
const EDIT_DIFF_MAX_EDIT_LENGTH = 2_000

const LF = 10
const CR = 13

/** Line count: `''` is 0 lines; counts `\n`, adding 1 when no trailing newline (matches `splitLineTexts`). */
function countLines(text: string): number {
  if (text === '') return 0
  let newlines = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === LF) newlines += 1
  }
  return text.charCodeAt(text.length - 1) === LF ? newlines : newlines + 1
}

/** Split into lines (strips trailing `\n` and adjacent `\r`; preserves blank lines; `''` -> `[]`). */
function splitLineTexts(text: string): string[] {
  if (text === '') return []
  const lines: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === LF) {
      const end = i > start && text.charCodeAt(i - 1) === CR ? i - 1 : i
      lines.push(text.slice(start, end))
      start = i + 1
    }
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

/**
 * Scan line start offsets: `lineStarts[k]` is the start offset of line `k+1`; a trailing `\n` with nothing
 * after it does not open an empty line (consistent with `countLines`/`splitLineTexts`); `''` yields `[]`.
 */
function scanLineStarts(original: string): number[] {
  if (original === '') return []
  const lineStarts = [0]
  for (let i = 0; i < original.length; i++) {
    if (original.charCodeAt(i) === LF && i + 1 < original.length) lineStarts.push(i + 1)
  }
  return lineStarts
}

/** Line number containing `offset` (1-based): binary-searches ascending `lineStarts` for last start <= `offset`. */
function lineAt(lineStarts: number[], offset: number): number {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** Diff skeleton row (exact line numbers; text populated later by line number from redacted window). */
type SkeletonRow =
  | { kind: 'context'; oldLine: number; newLine: number }
  | { kind: 'remove'; oldLine: number }
  | { kind: 'add'; newLine: number }

/** Prioritize actual changes inside the row budget so trailing changes aren't crowded out by long unchanged middle spans. */
function trimUnchangedContext(skeleton: readonly SkeletonRow[]): SkeletonRow[] {
  const rows: SkeletonRow[] = []
  for (let start = 0; start < skeleton.length;) {
    if (skeleton[start]!.kind !== 'context') {
      rows.push(skeleton[start++]!)
      continue
    }
    let end = start + 1
    while (end < skeleton.length && skeleton[end]!.kind === 'context') end++
    const before = start > 0
    const after = end < skeleton.length
    for (let i = start; i < end; i++) {
      if ((before && i < start + EDIT_CONTEXT_LINES) || (after && i >= end - EDIT_CONTEXT_LINES)) {
        rows.push(skeleton[i]!)
      }
    }
    start = end
  }
  return rows
}

/** Raw (unredacted) `±EDIT_CONTEXT_LINES` line window around the replaced span, before and after the edit. */
interface RawEditWindow {
  windowStartLine: number
  windowEndLine: number
  rawOldWindow: string
  rawNewWindow: string
}

/** Raw line-level diff outcome: exact line numbers and counts from the unredacted window (text is attached later). */
interface RawDiffSkeleton {
  rows: SkeletonRow[]
  addedLines: number
  removedLines: number
  /** First changed new-file line (`0` when nothing changed). */
  firstChanged: number
  /** The algorithmic budget forced the non-minimal full-span fallback (always reported as truncated). */
  budgetExceeded: boolean
}

/** Redacted line slices of the window, aligned 1:1 with raw line numbers (redaction preserved the line count). */
interface RedactedWindow {
  startLine: number
  oldLines: string[]
  newLines: string[]
}

/** Throws before any write when the replaced span does not address a real range of `original` (`edit_failed`). */
function assertReplacedSpanInBounds(original: string, matchOffset: number, replacedLength: number): void {
  if (
    !Number.isInteger(matchOffset) ||
    matchOffset < 0 ||
    !Number.isInteger(replacedLength) ||
    replacedLength < 1 ||
    matchOffset + replacedLength > original.length
  ) {
    throw new Error(
      `Edit diff precondition failed: replaced range [${matchOffset}, ${matchOffset + replacedLength}) is out of bounds (file has ${original.length} chars)`,
    )
  }
}

function buildRawEditWindow(
  original: string,
  updated: string,
  matched: { lineStarts: number[]; firstLine: number; lastLine: number },
  span: { matchOffset: number; replacedLength: number },
): RawEditWindow {
  const totalLines = matched.lineStarts.length
  const matchEnd = span.matchOffset + span.replacedLength
  const windowStartLine = Math.max(1, matched.firstLine - EDIT_CONTEXT_LINES)
  const windowEndLine = Math.min(matched.lastLine + EDIT_CONTEXT_LINES, totalLines)
  const windowStartOffset = matched.lineStarts[windowStartLine - 1]!
  const windowEndOffset = windowEndLine < totalLines ? matched.lineStarts[windowEndLine]! : original.length
  const rawOldWindow = original.slice(windowStartOffset, windowEndOffset)
  // Length of the replacement text inside `updated`: the edit only changes length by (new text - old text).
  const insertedLength = updated.length - original.length + span.replacedLength
  const rawNewWindow =
    original.slice(windowStartOffset, span.matchOffset) +
    updated.slice(span.matchOffset, span.matchOffset + insertedLength) +
    original.slice(matchEnd, windowEndOffset)
  return { windowStartLine, windowEndLine, rawOldWindow, rawNewWindow }
}

/**
 * Raw line-level skeleton and counts. `diffLines` runs under `maxEditLength` (returns `undefined` when exceeded) so
 * huge diffs never stall the kernel; the full-span fallback keeps counts consistent with the skeleton.
 */
function buildRawDiffSkeleton(rawOldWindow: string, rawNewWindow: string, windowStartLine: number): RawDiffSkeleton {
  const changes = diffLines(rawOldWindow, rawNewWindow, {
    maxEditLength: EDIT_DIFF_MAX_EDIT_LENGTH,
    timeout: 250,
  })
  if (changes === undefined) return fullSpanSkeleton(rawOldWindow, rawNewWindow, windowStartLine)
  return hunkSkeleton(changes, windowStartLine)
}

function hunkSkeleton(changes: readonly Change[], windowStartLine: number): RawDiffSkeleton {
  const builder = new SkeletonBuilder(windowStartLine)
  for (const change of changes) {
    const lineCount = splitLineTexts(change.value).length
    if (change.added === true) builder.add(lineCount)
    else if (change.removed === true) builder.remove(lineCount)
    else builder.context(lineCount)
  }
  return builder.toSkeleton(false)
}

/**
 * Algorithmic budget exceeded: fall back to full-span replacement — strip the common prefix/suffix lines, remove
 * the rest of the old window and add the rest of the new one (valid though non-minimal; counts match the skeleton).
 */
function fullSpanSkeleton(rawOldWindow: string, rawNewWindow: string, windowStartLine: number): RawDiffSkeleton {
  const oldLines = splitLineTexts(rawOldWindow)
  const newLines = splitLineTexts(rawNewWindow)
  const prefix = commonPrefixLineCount(oldLines, newLines)
  const suffix = commonSuffixLineCount(oldLines, newLines, prefix)
  const builder = new SkeletonBuilder(windowStartLine)
  builder.context(prefix)
  builder.remove(oldLines.length - prefix - suffix)
  builder.add(newLines.length - prefix - suffix)
  builder.context(suffix)
  // The first replaced line is the first line after the common prefix, whichever side changed.
  const skeleton = builder.toSkeleton(true)
  return { ...skeleton, firstChanged: windowStartLine + prefix }
}

function commonPrefixLineCount(oldLines: readonly string[], newLines: readonly string[]): number {
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1
  return prefix
}

function commonSuffixLineCount(oldLines: readonly string[], newLines: readonly string[], prefix: number): number {
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }
  return suffix
}

/** Accumulates skeleton rows while walking the old/new window line numbers in lockstep. */
class SkeletonBuilder {
  private readonly rows: SkeletonRow[] = []
  private addedLines = 0
  private removedLines = 0
  /** First changed new-file line (`0` until the first added/removed row is emitted). */
  private firstChanged = 0
  private oldLine: number
  private newLine: number

  constructor(windowStartLine: number) {
    this.oldLine = windowStartLine
    this.newLine = windowStartLine
  }

  add(lineCount: number): void {
    for (let i = 0; i < lineCount; i++) {
      this.noteChanged()
      this.rows.push({ kind: 'add', newLine: this.newLine })
      this.addedLines += 1
      this.newLine += 1
    }
  }

  remove(lineCount: number): void {
    // For pure deletions, `firstChanged` targets the new-file line at the deletion point (matching the first
    // subsequent context/added line, clamped to end-of-file for trailing deletions).
    for (let i = 0; i < lineCount; i++) {
      this.noteChanged()
      this.rows.push({ kind: 'remove', oldLine: this.oldLine })
      this.removedLines += 1
      this.oldLine += 1
    }
  }

  context(lineCount: number): void {
    for (let i = 0; i < lineCount; i++) {
      this.rows.push({ kind: 'context', oldLine: this.oldLine, newLine: this.newLine })
      this.oldLine += 1
      this.newLine += 1
    }
  }

  toSkeleton(budgetExceeded: boolean): RawDiffSkeleton {
    return {
      rows: this.rows,
      addedLines: this.addedLines,
      removedLines: this.removedLines,
      firstChanged: this.firstChanged,
      budgetExceeded,
    }
  }

  private noteChanged(): void {
    if (this.firstChanged === 0) this.firstChanged = this.newLine
  }
}

function sliceRedactedWindow(redOriginal: string, redUpdated: string, window: RawEditWindow): RedactedWindow {
  const newWindowCount = countLines(window.rawNewWindow)
  return {
    startLine: window.windowStartLine,
    // Slice the window directly from the redacted full texts (earlier lines before the window stay aligned).
    oldLines: splitLineTexts(redOriginal).slice(window.windowStartLine - 1, window.windowEndLine),
    newLines: splitLineTexts(redUpdated).slice(
      window.windowStartLine - 1,
      window.windowStartLine - 1 + newWindowCount,
    ),
  }
}

/** Window line text for a skeleton row: from the new slice when added, otherwise from the old slice. */
function windowRowText(entry: SkeletonRow, window: RedactedWindow): string {
  if (entry.kind === 'add') return window.newLines[entry.newLine - window.startLine]!
  return window.oldLines[entry.oldLine - window.startLine]!
}

/** Truncate an oversized row for display (counts unaffected); backs up 1 code unit to avoid splitting UTF-16 surrogates. */
function truncateRowForDisplay(text: string): { text: string; truncated: boolean } {
  if (text.length <= TOOL_DIFF_MAX_ROW_CHARS) return { text, truncated: false }
  let cut = TOOL_DIFF_MAX_ROW_CHARS
  const prev = text.charCodeAt(cut - 1)
  if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1
  return { text: text.slice(0, cut), truncated: true }
}

function toToolDiffRow(entry: SkeletonRow, text: string): ToolDiffRow {
  switch (entry.kind) {
    case 'context':
      return { kind: 'context', oldLine: entry.oldLine, newLine: entry.newLine, text }
    case 'remove':
      return { kind: 'remove', oldLine: entry.oldLine, text }
    case 'add':
      return { kind: 'add', newLine: entry.newLine, text }
  }
}

/** Enforce the display budgets on post-redaction text: rows, per-row chars, cumulative chars; any cut sets `truncated`. */
function renderDiffRows(
  skeleton: readonly SkeletonRow[],
  window: RedactedWindow,
  budgetExceeded: boolean,
): { rows: ToolDiffRow[]; truncated: boolean } {
  const rows: ToolDiffRow[] = []
  let usedChars = 0
  let truncated = budgetExceeded
  for (const entry of trimUnchangedContext(skeleton)) {
    if (rows.length >= TOOL_DIFF_MAX_ROWS) {
      truncated = true
      break
    }
    const row = truncateRowForDisplay(windowRowText(entry, window))
    if (usedChars + row.text.length > TOOL_DIFF_MAX_TEXT_CHARS) {
      truncated = true
      break
    }
    usedChars += row.text.length
    truncated = truncated || row.truncated
    rows.push(toToolDiffRow(entry, row.text))
  }
  return { rows, truncated }
}

/**
 * Compute `ToolEditDiff` from before/after full texts and matched span (pure, zero IO).
 *
 * `redact` requirement: placeholders must not introduce newlines (true for `[REDACTED]` in `SecretStash`).
 * Preserving line count across redaction confirms no secret spanned a newline so redacted window lines correspond
 * 1:1 with real line numbers; on mismatch, falls back by contract to `rows = []` rather than fabricating.
 */
export function computeEditDiff(
  original: string,
  updated: string,
  matchOffset: number,
  replacedLength: number,
  redact: (text: string) => string,
): ToolEditDiff {
  assertReplacedSpanInBounds(original, matchOffset, replacedLength)
  const lineStarts = scanLineStarts(original)
  const totalLines = lineStarts.length
  const firstLine = lineAt(lineStarts, matchOffset)
  // No-op (`oldText === newText`): no diff rows to display; line number points to the matched span.
  if (updated === original) {
    return { rows: [], addedLines: 0, removedLines: 0, firstChangedLine: firstLine, truncated: false }
  }
  const matched = {
    lineStarts,
    firstLine,
    lastLine: lineAt(lineStarts, matchOffset + replacedLength - 1),
  }
  const window = buildRawEditWindow(original, updated, matched, { matchOffset, replacedLength })
  const skeleton = buildRawDiffSkeleton(window.rawOldWindow, window.rawNewWindow, window.windowStartLine)
  // Clamp `firstChangedLine` to the actual new-file line count (handles EOF deletions; empty files clamp to 1).
  const firstChangedLine =
    skeleton.firstChanged === 0 ? firstLine : Math.min(skeleton.firstChanged, Math.max(1, countLines(updated)))
  const counts = {
    addedLines: skeleton.addedLines,
    removedLines: skeleton.removedLines,
    firstChangedLine,
  }

  // Redact full texts first so multi-line secrets crossing window boundaries are fully caught.
  const redOriginal = redact(original)
  const redUpdated = redact(updated)
  if (countLines(redOriginal) !== totalLines || countLines(redUpdated) !== countLines(updated)) {
    // Full-text redaction changed line count (secret contained newlines): window lines no longer align with real lines.
    // Honest fallback: return no rows (never leak), keeping raw counts and firstChangedLine.
    return { rows: [], ...counts, truncated: true }
  }
  const rendered = renderDiffRows(
    skeleton.rows,
    sliceRedactedWindow(redOriginal, redUpdated, window),
    skeleton.budgetExceeded,
  )
  return { rows: rendered.rows, ...counts, truncated: rendered.truncated }
}
