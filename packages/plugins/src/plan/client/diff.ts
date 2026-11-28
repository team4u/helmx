/**
 * Pure line-based LCS diff computation for comparing plan draft revisions (`vN` vs baseline).
 * Zero React, DOM, or external dependencies (Fast Refresh & clientRoot safe).
 */
import type { PlanDraftSummary } from './types.ts'

export const MAX_PLAN_DIFF_LINES = 1500
export const MAX_PLAN_DIFF_DP_CELLS = 2_500_000
export const PLAN_DIFF_CONTEXT_LINES = 3

export interface PlanDiffRow {
  kind: 'context' | 'add' | 'remove'
  oldLine?: number
  newLine?: number
  text: string
}

export interface PlanDiffHunk {
  skippedBefore: number
  rows: PlanDiffRow[]
}

export type PlanDraftDiffResult =
  | {
      kind: 'diff'
      titleChanged: boolean
      prevTitle: string
      nextTitle: string
      addedLines: number
      removedLines: number
      hasChanges: boolean
      hunks: PlanDiffHunk[]
      trailingSkipped: number
    }
  | {
      kind: 'too_large'
      prevLineCount: number
      nextLineCount: number
    }

function splitNormalizedLines(markdown: string): string[] {
  return markdown.replaceAll('\r\n', '\n').split('\n')
}

export function computePlanDraftDiff(
  prev: Pick<PlanDraftSummary, 'title' | 'markdown'>,
  next: Pick<PlanDraftSummary, 'title' | 'markdown'>,
): PlanDraftDiffResult {
  const titleChanged = prev.title !== next.title
  const prevLines = splitNormalizedLines(prev.markdown)
  const nextLines = splitNormalizedLines(next.markdown)

  const minLen = Math.min(prevLines.length, nextLines.length)
  let prefixLen = 0
  while (prefixLen < minLen && prevLines[prefixLen] === nextLines[prefixLen]) {
    prefixLen += 1
  }

  let suffixLen = 0
  while (
    suffixLen < minLen - prefixLen &&
    prevLines[prevLines.length - 1 - suffixLen] === nextLines[nextLines.length - 1 - suffixLen]
  ) {
    suffixLen += 1
  }

  const midPrev = prevLines.slice(prefixLen, prevLines.length - suffixLen)
  const midNext = nextLines.slice(prefixLen, nextLines.length - suffixLen)
  const m = midPrev.length
  const n = midNext.length

  if (m + n > MAX_PLAN_DIFF_LINES || m * n > MAX_PLAN_DIFF_DP_CELLS) {
    return {
      kind: 'too_large',
      prevLineCount: prevLines.length,
      nextLineCount: nextLines.length,
    }
  }

  if (m === 0 && n === 0) {
    return {
      kind: 'diff',
      titleChanged,
      prevTitle: prev.title,
      nextTitle: next.title,
      addedLines: 0,
      removedLines: 0,
      hasChanges: titleChanged,
      hunks: [],
      trailingSkipped: 0,
    }
  }

  const cols = n + 1
  const dp = new Int32Array((m + 1) * cols)
  for (let i = m - 1; i >= 0; i -= 1) {
    const rowOffset = i * cols
    const nextRowOffset = (i + 1) * cols
    const prevLine = midPrev[i]!
    for (let j = n - 1; j >= 0; j -= 1) {
      if (prevLine === midNext[j]) {
        dp[rowOffset + j] = dp[nextRowOffset + j + 1]! + 1
      } else {
        const down = dp[nextRowOffset + j]!
        const right = dp[rowOffset + j + 1]!
        dp[rowOffset + j] = down >= right ? down : right
      }
    }
  }

  const allRows: PlanDiffRow[] = []
  for (let k = 0; k < prefixLen; k += 1) {
    allRows.push({
      kind: 'context',
      oldLine: k + 1,
      newLine: k + 1,
      text: prevLines[k]!,
    })
  }

  let addedLines = 0
  let removedLines = 0
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (midPrev[i] === midNext[j]) {
      allRows.push({
        kind: 'context',
        oldLine: prefixLen + i + 1,
        newLine: prefixLen + j + 1,
        text: midPrev[i]!,
      })
      i += 1
      j += 1
    } else if (dp[(i + 1) * cols + j]! >= dp[i * cols + j + 1]!) {
      allRows.push({
        kind: 'remove',
        oldLine: prefixLen + i + 1,
        text: midPrev[i]!,
      })
      removedLines += 1
      i += 1
    } else {
      allRows.push({
        kind: 'add',
        newLine: prefixLen + j + 1,
        text: midNext[j]!,
      })
      addedLines += 1
      j += 1
    }
  }
  while (i < m) {
    allRows.push({
      kind: 'remove',
      oldLine: prefixLen + i + 1,
      text: midPrev[i]!,
    })
    removedLines += 1
    i += 1
  }
  while (j < n) {
    allRows.push({
      kind: 'add',
      newLine: prefixLen + j + 1,
      text: midNext[j]!,
    })
    addedLines += 1
    j += 1
  }

  const prevSuffixStart = prevLines.length - suffixLen
  const nextSuffixStart = nextLines.length - suffixLen
  for (let k = 0; k < suffixLen; k += 1) {
    allRows.push({
      kind: 'context',
      oldLine: prevSuffixStart + k + 1,
      newLine: nextSuffixStart + k + 1,
      text: prevLines[prevSuffixStart + k]!,
    })
  }

  const hunks: PlanDiffHunk[] = []
  let activeStart = -1
  let activeEnd = -1
  let prevHunkEnd = -1

  for (let idx = 0; idx < allRows.length; idx += 1) {
    if (allRows[idx]!.kind === 'context') continue
    const rangeStart = Math.max(0, idx - PLAN_DIFF_CONTEXT_LINES)
    const rangeEnd = Math.min(allRows.length - 1, idx + PLAN_DIFF_CONTEXT_LINES)
    if (activeStart === -1) {
      activeStart = rangeStart
      activeEnd = rangeEnd
    } else if (rangeStart <= activeEnd + 1) {
      activeEnd = Math.max(activeEnd, rangeEnd)
    } else {
      hunks.push({
        skippedBefore: activeStart - (prevHunkEnd + 1),
        rows: allRows.slice(activeStart, activeEnd + 1),
      })
      prevHunkEnd = activeEnd
      activeStart = rangeStart
      activeEnd = rangeEnd
    }
  }

  if (activeStart !== -1) {
    hunks.push({
      skippedBefore: activeStart - (prevHunkEnd + 1),
      rows: allRows.slice(activeStart, activeEnd + 1),
    })
    prevHunkEnd = activeEnd
  }

  const trailingSkipped = hunks.length === 0 ? 0 : allRows.length - 1 - prevHunkEnd
  const hasChanges = titleChanged || addedLines > 0 || removedLines > 0

  return {
    kind: 'diff',
    titleChanged,
    prevTitle: prev.title,
    nextTitle: next.title,
    addedLines,
    removedLines,
    hasChanges,
    hunks,
    trailingSkipped,
  }
}
