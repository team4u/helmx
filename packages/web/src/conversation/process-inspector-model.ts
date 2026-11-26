/**
 * Pure domain model for the right-side process inspector drawer and compact
 * timeline live-execution preview. Zero React / DOM dependencies; unit-tested
 * directly and shared by ConversationTimeline, TimelineRows, and ProcessInspectorDrawer.
 */
import type { AssistantTurn, FoldableStep, TimelineItem } from './timeline-types.js'

export type ProcessInspectMode = 'default' | 'io' | 'raw'

export type ProcessInspectTarget =
  | {
      kind: 'step-group'
      turnKey: string
      segmentKey: string
      selectedStepKey?: string
      selectedStepIndex?: number
      followLive?: boolean
    }
  | {
      kind: 'standalone-tool'
      turnKey: string
      toolKey: string
      mode: ProcessInspectMode
    }

export interface ResolvedProcessInspection {
  kind: 'step-group' | 'standalone-tool'
  turnKey: string
  segmentKey: string
  steps: ReadonlyArray<FoldableStep>
  active: boolean
  selectedIndex: number
  selectedStep: FoldableStep
  mode: ProcessInspectMode
}

export interface LivePreviewStep {
  step: FoldableStep
  index: number
  stepKey: string
}

export function stepKeyOf(step: FoldableStep, index: number): string {
  if (step.kind === 'tool') return step.tool.key
  return step.thinking.key !== '' ? step.thinking.key : `think:${index}`
}

export function isStepFailed(step: FoldableStep): boolean {
  return step.kind === 'tool' && (step.tool.isError || step.tool.status === 'error')
}

export function isStepRunning(step: FoldableStep): boolean {
  return step.kind === 'thinking' ? step.thinking.active === true : step.tool.status === 'running'
}

export function thinkingPreviewLine(text: string): string {
  for (const rawLine of text.split(/\r?\n/)) {
    const normalized = rawLine.replace(/\s+/g, ' ').trim()
    if (normalized !== '') return normalized
  }
  return ''
}

export function liveThinkingTailPreview(
  text: string,
  maxLines = 4,
): { visible: string; truncated: boolean } {
  const lines = text.split(/\r?\n/)
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
    lines.pop()
  }
  if (lines.length === 0) return { visible: '', truncated: false }
  if (maxLines <= 0) return { visible: '', truncated: true }
  if (lines.length <= maxLines) {
    return { visible: lines.join('\n'), truncated: false }
  }
  return {
    visible: lines.slice(-maxLines).join('\n'),
    truncated: true,
  }
}

export function selectLivePreviewSteps(
  steps: ReadonlyArray<FoldableStep>,
  maxRows = 4,
): LivePreviewStep[] {
  if (steps.length === 0 || maxRows <= 0) return []
  const indexed: LivePreviewStep[] = steps.map((step, index) => ({
    step,
    index,
    stepKey: stepKeyOf(step, index),
  }))
  const running = indexed.filter((item) => isStepRunning(item.step))
  if (running.length > 0) {
    return running.slice(-maxRows)
  }
  const fallbackCount = Math.min(2, maxRows)
  return indexed.slice(-fallbackCount)
}

export interface ResolveSelectedStepOptions {
  selectedStepKey?: string
  selectedStepIndex?: number
  followLive?: boolean
  active: boolean
}

export function resolveSelectedStepIndex(
  steps: ReadonlyArray<FoldableStep>,
  opts: ResolveSelectedStepOptions,
): number {
  if (steps.length === 0) return -1
  if (opts.followLive === true && opts.active) {
    return steps.length - 1
  }
  if (opts.selectedStepKey !== undefined) {
    const matched = steps.findIndex((step, index) => stepKeyOf(step, index) === opts.selectedStepKey)
    if (matched >= 0) return matched
  }
  if (opts.selectedStepIndex !== undefined && Number.isFinite(opts.selectedStepIndex)) {
    const truncated = Math.trunc(opts.selectedStepIndex)
    return Math.max(0, Math.min(steps.length - 1, truncated))
  }
  if (opts.active) {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      if (isStepRunning(steps[i]!)) return i
    }
    return steps.length - 1
  }
  return 0
}

function findAssistantTurn(
  items: ReadonlyArray<TimelineItem>,
  turnKey: string,
): AssistantTurn | undefined {
  for (const item of items) {
    if (item.kind === 'assistant' && item.key === turnKey) return item
  }
  return undefined
}

export function resolveProcessInspection(
  items: ReadonlyArray<TimelineItem>,
  target: ProcessInspectTarget | null,
): ResolvedProcessInspection | null {
  if (target === null) return null
  const turn = findAssistantTurn(items, target.turnKey)
  if (turn === undefined) return null

  if (target.kind === 'step-group') {
    const segment = turn.segments.find(
      (seg): seg is Extract<AssistantTurn['segments'][number], { kind: 'step-group' }> =>
        seg.kind === 'step-group' && seg.key === target.segmentKey,
    )
    if (segment === undefined || segment.steps.length === 0) return null
    const active = segment.active === true
    const selectedIndex = resolveSelectedStepIndex(segment.steps, {
      selectedStepKey: target.selectedStepKey,
      selectedStepIndex: target.selectedStepIndex,
      followLive: target.followLive,
      active,
    })
    if (selectedIndex < 0) return null
    const selectedStep = segment.steps[selectedIndex]
    if (selectedStep === undefined) return null
    return {
      kind: 'step-group',
      turnKey: target.turnKey,
      segmentKey: segment.key,
      steps: segment.steps,
      active,
      selectedIndex,
      selectedStep,
      mode: 'default',
    }
  }

  const toolSegment = turn.segments.find(
    (seg): seg is Extract<AssistantTurn['segments'][number], { kind: 'tool' }> =>
      seg.kind === 'tool' && seg.tool.key === target.toolKey,
  )
  if (toolSegment === undefined) return null
  const step: FoldableStep = { kind: 'tool', tool: toolSegment.tool }
  return {
    kind: 'standalone-tool',
    turnKey: target.turnKey,
    segmentKey: toolSegment.key,
    steps: [step],
    active: toolSegment.tool.status === 'running',
    selectedIndex: 0,
    selectedStep: step,
    mode: target.mode,
  }
}

export function findLatestProcessTarget(items: ReadonlyArray<TimelineItem>): ProcessInspectTarget | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!
    if (item.kind !== 'assistant') continue
    for (let j = item.segments.length - 1; j >= 0; j -= 1) {
      const seg = item.segments[j]!
      if (seg.kind === 'step-group' && seg.steps.length > 0) {
        return {
          kind: 'step-group',
          turnKey: item.key,
          segmentKey: seg.key,
          followLive: seg.active === true,
        }
      }
    }
  }
  return null
}

export function filterVisibleStepIndices(
  steps: ReadonlyArray<FoldableStep>,
  onlyErrors: boolean,
): number[] {
  if (onlyErrors) {
    const failedIndices: number[] = []
    for (let i = 0; i < steps.length; i += 1) {
      if (isStepFailed(steps[i]!)) failedIndices.push(i)
    }
    if (failedIndices.length > 0) return failedIndices
  }
  return steps.map((_, index) => index)
}
