/**
 * Step-group folding and thinking-activity invariant for assistant turns.
 */
import type { AssistantSegment, FoldableStep, ToolTrace } from './timeline-types.js'

export interface RawSegment {
  kind: 'text' | 'thinking' | 'tool'
  key: string
  text?: string
  tool?: ToolTrace
  /** Eligible model-response duration attached to (only) the first thinking segment of its message. */
  responseDurationMs?: number
  /** Streaming provenance of a live thinking block (see ThinkingTrace.live). */
  live?: 'generation' | 'flat'
}

/** Fold exemption: thinking and ordinary tool rows (running, done, failed) fold; only tool.view business cards stay standalone. */
export function isFoldableStep(step: FoldableStep): boolean {
  if (step.kind === 'thinking') return true
  return step.tool.toolView === undefined
}

function foldableOfRaw(seg: RawSegment): FoldableStep {
  if (seg.kind === 'thinking') {
    return {
      kind: 'thinking',
      thinking: {
        key: seg.key,
        text: seg.text ?? '',
        ...(seg.live !== undefined ? { live: seg.live } : {}),
        ...(seg.responseDurationMs !== undefined ? { responseDurationMs: seg.responseDurationMs } : {}),
      },
    }
  }
  return { kind: 'tool', tool: seg.tool! }
}

/**
 * Raw segments -> render segments: consecutive foldable steps enter a step-group from the first step,
 * avoiding node moves when steps append. Exempt items (tool.view) and text blocks stay standalone.
 */
export function foldTurnSegments(raw: ReadonlyArray<RawSegment>, live = false): AssistantSegment[] {
  const out: AssistantSegment[] = []
  let buffer: FoldableStep[] = []
  const flushBuffer = (): void => {
    if (buffer.length > 0) {
      out.push({
        kind: 'step-group',
        key: `group:${out.length}`,
        stepCount: buffer.length,
        steps: buffer,
      })
    }
    buffer = []
  }
  for (const seg of raw) {
    if (seg.kind === 'text') {
      if ((seg.text ?? '') === '') continue
      flushBuffer()
      const last = out.length > 0 ? out[out.length - 1] : undefined
      if (last !== undefined && last.kind === 'text') {
        last.text += seg.text ?? ''
        continue
      }
      out.push({ kind: 'text', key: `text:${out.length}`, text: seg.text ?? '' })
      continue
    }
    const step = foldableOfRaw(seg)
    if (isFoldableStep(step)) {
      buffer.push(step)
    } else {
      flushBuffer()
      if (step.kind === 'tool') out.push({ kind: 'tool', key: step.tool.key, tool: step.tool })
      else buffer.push(step)
    }
  }
  flushBuffer()
  for (let i = 0; i < out.length; i++) {
    const seg = out[i]!
    if (seg.kind !== 'step-group') continue
    const hasRunningTool = seg.steps.some((s) => s.kind === 'tool' && s.tool.status === 'running')
    const isTrailing = i === out.length - 1
    const groupActive = live && (isTrailing || hasRunningTool)
    seg.active = groupActive

    for (let sIdx = 0; sIdx < seg.steps.length; sIdx++) {
      const step = seg.steps[sIdx]!
      if (step.kind !== 'thinking') continue
      if (step.thinking.live === 'generation') {
        step.thinking.active = live === true
      } else if (step.thinking.live === 'flat') {
        const hasSubsequentTool = seg.steps.slice(sIdx + 1).some((s) => s.kind === 'tool')
        step.thinking.active = groupActive && !hasSubsequentTool && !hasRunningTool && isTrailing
      } else {
        step.thinking.active = false
      }
    }
  }
  return out
}
