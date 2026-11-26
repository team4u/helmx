/**
 * Pure frame-based token decoding speed tracker (no IO, injectable clock).
 * Segments key by `(taskId, attempt)`; completed segments fold into totals immediately while
 * failed attempts (`error`/`aborted`) are discarded; mid-stream joins omit TTFT and settled rate.
 */
import type { ConversationLiveMessage } from '@helmx/protocol'
import { contentCharsOfBlocks, type TokenSpeedSource, type TokenSpeedStatus } from './contracts.js'

interface Segment {
  id: number; taskId: number; attempt: number; closed: boolean
  chars: number; providerOutput: number; tokens: number
  usedEstimate: boolean; usedProvider: boolean
  firstGrowthAt?: number; lastGrowthAt?: number; emptySeenAt?: number
  baselineOnly: boolean; rateExcluded: boolean
}

export interface CompletionFact {
  taskId: number | undefined; entryId: string | undefined
  usageOutput: number | undefined; stopReason: string | undefined; contentChars?: number | undefined
}

const COMPACT_AT = 5000
const MAX_TRACKED = 256
const emptyTotals = () => ({ tokens: 0, decodeMs: 0, rateTokens: 0, rateDecodeMs: 0, provider: false, estimate: false, count: 0 })
const spanOf = (s: Segment): number =>
  s.firstGrowthAt === undefined || s.lastGrowthAt === undefined ? 0 : Math.max(0, s.lastGrowthAt - s.firstGrowthAt)

export const generatedCharsOf = (message: ConversationLiveMessage | undefined): number =>
  message === undefined ? 0 : contentCharsOfBlocks(message.content)

export const estimateTokensOf = (deltaChars: number): number =>
  deltaChars <= 0 ? 0 : Math.max(1, Math.ceil(deltaChars / 4))

export class SlidingWindow {
  private readonly events: Array<{ time: number; tokens: number; segment: number }> = []
  private start = 0
  constructor(private windowMs: number, private readonly minSpanMs: number) {}

  setWindowMs(windowMs: number): void {
    if (windowMs > this.windowMs) this.start = 0
    this.windowMs = windowMs
  }

  record(time: number, tokens: number, segment: number): void {
    if (tokens <= 0) return
    this.events.push({ time, tokens, segment })
    if (this.start >= COMPACT_AT) { this.events.splice(0, this.start); this.start = 0 }
  }

  getTps(now: number): number {
    const cutoff = now - this.windowMs
    while (this.start < this.events.length) {
      const head = this.events[this.start]
      if (!head || head.time >= cutoff) break
      this.start += 1
    }
    if (this.start >= this.events.length) return 0
    let tokens = 0
    for (let i = this.start; i < this.events.length; i += 1) {
      const ev = this.events[i]
      if (ev) tokens += ev.tokens
    }
    if (tokens <= 0) return 0
    const first = this.events[this.start]
    const last = this.events[this.events.length - 1]
    if (!first || !last) return 0
    const prev = this.start > 0 ? this.events[this.start - 1] : undefined
    const spanStart =
      first.time === last.time && first.segment === last.segment && prev !== undefined && prev.segment === first.segment
        ? prev.time
        : first.time
    return (1000 * tokens) / Math.max(now - spanStart, this.minSpanMs)
  }

  reset(): void { this.events.length = 0; this.start = 0 }
}

export class ConversationTokenSpeedTracker {
  private segmentSeq = 0
  private active?: Segment
  private readonly pending = new Map<number, Segment>()
  private readonly seenEntries = new Set<string>()
  private readonly completedAttempts = new Map<number, number>()
  private highestTaskId = 0
  private readonly totals = emptyTotals()
  private readonly window: SlidingWindow
  private windowMs: number
  private readonly minSpanMs: number
  private lastLiveTps?: number
  private firstContentAt?: number
  private ttftMs?: number
  private sawEmptyGeneration = false
  private phase: 'decoding' | 'tools' = 'decoding'

  constructor(options: { windowMs: number; minSpanMs: number }) {
    this.windowMs = options.windowMs
    this.minSpanMs = options.minSpanMs
    this.window = new SlidingWindow(options.windowMs, options.minSpanMs)
  }

  setWindowMs(windowMs: number): void {
    if (this.windowMs === windowMs) return
    this.windowMs = windowMs
    this.window.setWindowMs(windowMs)
  }

  noteCompletion(fact: CompletionFact, now?: number): void {
    if (fact.taskId === undefined) return
    if (fact.entryId !== undefined) {
      if (this.seenEntries.has(fact.entryId)) return
      this.seenEntries.add(fact.entryId)
      if (this.seenEntries.size > MAX_TRACKED) {
        const oldestEntry = this.seenEntries.values().next().value
        if (oldestEntry !== undefined) this.seenEntries.delete(oldestEntry)
      }
    }
    const seg = this.pending.get(fact.taskId)
    if (!seg) return
    this.pending.delete(fact.taskId)
    this.completedAttempts.set(fact.taskId, seg.attempt)
    if (this.completedAttempts.size > MAX_TRACKED) {
      const oldestTask = this.completedAttempts.keys().next().value
      if (oldestTask !== undefined) this.completedAttempts.delete(oldestTask)
    }

    if (fact.stopReason === 'error' || fact.stopReason === 'aborted') {
      if (this.active === seg) { this.active = undefined; this.window.reset() }
      if (this.totals.tokens + [...this.pending.values()].reduce((n, s) => n + s.tokens, 0) <= 0) this.lastLiveTps = undefined
      return
    }
    if (this.active === seg) this.active = undefined

    const prevChars = seg.chars
    const contentChars = typeof fact.contentChars === 'number' && Number.isFinite(fact.contentChars) && fact.contentChars >= 0 ? fact.contentChars : undefined
    const deltaChars = contentChars !== undefined ? Math.max(0, contentChars - prevChars) : 0
    const usageOutput = typeof fact.usageOutput === 'number' && Number.isFinite(fact.usageOutput) && fact.usageOutput > 0 ? fact.usageOutput : undefined
    if ((deltaChars > 0 || usageOutput !== undefined) && !seg.baselineOnly) this.captureFirstContent(seg, now)

    let estDelta = 0
    if (contentChars !== undefined && deltaChars > 0) {
      estDelta = estimateTokensOf(contentChars) - estimateTokensOf(prevChars)
      const tailTokens = usageOutput !== undefined && !seg.baselineOnly ? Math.max(0, usageOutput - seg.tokens) : estDelta
      seg.chars = Math.max(seg.chars, contentChars)
      if (now !== undefined) {
        if (seg.firstGrowthAt !== undefined && now > seg.firstGrowthAt) {
          seg.lastGrowthAt = now
          this.recordWindow(now, tailTokens, seg.id)
        } else if (seg.firstGrowthAt === undefined && !seg.baselineOnly && seg.emptySeenAt !== undefined && now >= seg.emptySeenAt) {
          const eff = usageOutput !== undefined ? usageOutput : estDelta
          if (eff > 0) this.lastLiveTps = (eff * 1000) / Math.max(now - seg.emptySeenAt, this.minSpanMs)
        }
      }
    }

    if (typeof fact.usageOutput === 'number' && fact.usageOutput >= 0) {
      if (seg.baselineOnly) seg.rateExcluded = true
      seg.tokens = fact.usageOutput
      seg.usedProvider = true
      seg.usedEstimate = false
    } else if (deltaChars > 0) {
      seg.tokens += estDelta
      seg.usedEstimate ||= estDelta > 0
    }
    this.foldSegment(seg)
  }

  observeFrame(now: number, frame: { generation?: { taskId: number; attempt: number; message?: ConversationLiveMessage }; hasTools?: boolean }): void {
    const gen = frame.generation
    if (!gen) { this.phase = 'tools'; this.closeActive(); return }
    if (gen.taskId < this.highestTaskId || gen.attempt <= (this.completedAttempts.get(gen.taskId) ?? 0)) return
    const held = this.pending.get(gen.taskId)
    if (held && gen.attempt < held.attempt) return
    this.highestTaskId = Math.max(this.highestTaskId, gen.taskId)
    this.phase = 'decoding'

    const chars = generatedCharsOf(gen.message)
    if (this.active && (this.active.taskId !== gen.taskId || this.active.attempt !== gen.attempt)) this.closeActive()
    if (!this.active) {
      if (held && held.attempt === gen.attempt && held.closed) {
        held.closed = false
        this.active = held
      } else {
        const baselineOnly = chars > 0 && this.firstContentAt === undefined && !this.sawEmptyGeneration
        const seg: Segment = {
          id: ++this.segmentSeq, taskId: gen.taskId, attempt: gen.attempt, closed: false,
          chars: baselineOnly ? chars : 0, providerOutput: baselineOnly ? (gen.message?.usage?.output ?? 0) : 0,
          tokens: 0, usedEstimate: false, usedProvider: false, baselineOnly, rateExcluded: false,
        }
        this.window.reset()
        if (held) this.foldSegment(held)
        this.pending.set(seg.taskId, seg)
        this.active = seg
      }
    }

    const seg = this.active
    if (chars === 0) { seg.emptySeenAt ??= now; this.sawEmptyGeneration = true }
    const deltaChars = Math.max(0, chars - seg.chars)
    const provider = gen.message?.usage?.output
    let deltaTokens = 0
    if (provider !== undefined && provider > seg.providerOutput) {
      deltaTokens = provider - seg.providerOutput
      seg.providerOutput = provider
      seg.usedProvider = true
    } else if (deltaChars > 0) {
      deltaTokens = estimateTokensOf(chars) - estimateTokensOf(seg.chars)
      seg.usedEstimate ||= deltaTokens > 0
    }
    seg.chars = Math.max(seg.chars, chars)
    if (deltaChars <= 0 && deltaTokens <= 0) return

    this.captureFirstContent(seg, now)
    seg.firstGrowthAt ??= now
    seg.lastGrowthAt = now
    seg.tokens += deltaTokens
    this.recordWindow(now, deltaTokens, seg.id)
  }

  liveStatus(now: number): TokenSpeedStatus | undefined {
    const base = this.buildStatus(this.phase, now)
    if (!base) return undefined
    if (this.phase === 'decoding' && this.active?.firstGrowthAt !== undefined) {
      const tps = this.window.getTps(now)
      if (tps > 0) { this.lastLiveTps = tps; return { ...base, tps } }
    }
    return this.lastLiveTps && this.lastLiveTps > 0 ? { ...base, tps: this.lastLiveTps } : base
  }

  settle(now: number): TokenSpeedStatus | undefined {
    this.closeActive()
    const base = this.buildStatus('settled', now)
    if (!base) return undefined
    let rateTokens = this.totals.rateTokens
    let rateDecodeMs = this.totals.rateDecodeMs
    for (const s of this.pending.values()) {
      const span = spanOf(s)
      if (!s.rateExcluded && span > 0) { rateTokens += s.tokens; rateDecodeMs += span }
    }
    const tps = rateTokens > 0 && rateDecodeMs > 0 ? (rateTokens / rateDecodeMs) * 1000 : 0
    return Number.isFinite(tps) && tps > 0 ? { ...base, tps } : base
  }

  resetChain(): void {
    this.active = undefined; this.pending.clear(); this.seenEntries.clear(); this.completedAttempts.clear()
    this.highestTaskId = 0; Object.assign(this.totals, emptyTotals()); this.window.reset()
    this.lastLiveTps = this.firstContentAt = this.ttftMs = undefined
    this.sawEmptyGeneration = false; this.phase = 'decoding'; this.segmentSeq = 0
  }

  private recordWindow(now: number, tokens: number, segId: number): void {
    if (tokens <= 0) return
    this.window.record(now, tokens, segId)
    const tps = this.window.getTps(now)
    if (tps > 0) this.lastLiveTps = tps
  }

  private captureFirstContent(seg: Segment, now: number | undefined): void {
    if (this.firstContentAt !== undefined) return
    const hasPrior = this.totals.count > 0 || [...this.pending.values()].some((s) => s !== seg)
    if (now !== undefined && !hasPrior && seg.emptySeenAt !== undefined && seg.emptySeenAt < now) this.ttftMs = now - seg.emptySeenAt
    this.firstContentAt = now ?? -1
  }

  private foldSegment(seg: Segment): void {
    const span = spanOf(seg)
    this.totals.count += 1; this.totals.tokens += seg.tokens; this.totals.decodeMs += span
    this.totals.provider ||= seg.usedProvider; this.totals.estimate ||= seg.usedEstimate
    if (!seg.rateExcluded && span > 0) { this.totals.rateTokens += seg.tokens; this.totals.rateDecodeMs += span }
  }

  private closeActive(): void { if (this.active) { this.active.closed = true; this.active = undefined } }

  private buildStatus(phase: TokenSpeedStatus['phase'], now: number): TokenSpeedStatus | undefined {
    let { tokens, decodeMs, provider, estimate } = this.totals
    for (const s of this.pending.values()) {
      tokens += s.tokens; decodeMs += spanOf(s); provider ||= s.usedProvider; estimate ||= s.usedEstimate
    }
    if (tokens <= 0) return undefined
    const source: TokenSpeedSource = provider && estimate ? 'mixed' : provider ? 'provider' : 'estimate'
    return { phase, outputTokens: tokens, decodeMs, source, ...(this.ttftMs !== undefined ? { ttftMs: this.ttftMs } : {}), windowMs: this.windowMs, updatedAt: now }
  }
}
