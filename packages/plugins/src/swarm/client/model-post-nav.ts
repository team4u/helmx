/**
 * Pure navigation state transitions and Markdown `#seq` linkification for
 * Swarm board post references (peek popover trail + list jump-back stack).
 * Zero React/DOM dependencies (Fast Refresh compliant).
 */

export const MAX_POST_PEEK_DEPTH = 20
export const MAX_POST_JUMP_BACK_DEPTH = 20
export const SWARM_POST_HREF_PREFIX = '#swarm-post-'

export interface PostPeekState {
  /** Post seq from which the user opened the peek popover (used for list jump-back). */
  originSeq: number
  /** Ordered trail of peeked post seqs (oldest -> current). */
  trail: number[]
}

export function openPostPeek(originSeq: number, targetSeq: number): PostPeekState {
  return { originSeq, trail: [targetSeq] }
}

export function pushPostPeek(
  state: PostPeekState,
  targetSeq: number,
  maxDepth = MAX_POST_PEEK_DEPTH,
): PostPeekState {
  const existingIdx = state.trail.indexOf(targetSeq)
  if (existingIdx !== -1) {
    if (existingIdx === state.trail.length - 1) return state
    return { ...state, trail: state.trail.slice(0, existingIdx + 1) }
  }
  const appended = [...state.trail, targetSeq]
  const trail = appended.length > maxDepth ? appended.slice(appended.length - maxDepth) : appended
  return { ...state, trail }
}

export function popPostPeek(state: PostPeekState): PostPeekState | undefined {
  if (state.trail.length <= 1) return undefined
  return { ...state, trail: state.trail.slice(0, -1) }
}

export function currentPeekSeq(state: PostPeekState): number {
  return state.trail[state.trail.length - 1]!
}

export function previousPeekSeq(state: PostPeekState): number | undefined {
  return state.trail.length >= 2 ? state.trail[state.trail.length - 2] : undefined
}

export function pushJumpBack(
  stack: readonly number[],
  originSeq: number,
  targetSeq: number,
  maxDepth = MAX_POST_JUMP_BACK_DEPTH,
): number[] {
  if (originSeq === targetSeq) return stack as number[]
  if (stack.length > 0 && stack[stack.length - 1] === originSeq) return stack as number[]
  const next = [...stack, originSeq]
  return next.length > maxDepth ? next.slice(next.length - maxDepth) : next
}

export function popJumpBack(
  stack: readonly number[],
): { targetSeq: number | undefined; nextStack: number[] } {
  if (stack.length === 0) return { targetSeq: undefined, nextStack: [] }
  return {
    targetSeq: stack[stack.length - 1],
    nextStack: stack.slice(0, -1),
  }
}

export function parseSwarmPostHref(href: string): number | undefined {
  if (!href.startsWith(SWARM_POST_HREF_PREFIX)) return undefined
  const raw = href.slice(SWARM_POST_HREF_PREFIX.length)
  if (!/^[1-9]\d*$/.test(raw)) return undefined
  const num = Number(raw)
  return Number.isSafeInteger(num) && num > 0 ? num : undefined
}

const POST_REF_TOKEN_RE = /(^|[\s(\[（【，。：；、·])#([1-9]\d*)\b/g
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/

function linkifyPlainSegment(segment: string, selfSeq: number | undefined): string {
  return segment.replace(POST_REF_TOKEN_RE, (full, prefix: string, digits: string) => {
    const seq = Number(digits)
    if (!Number.isSafeInteger(seq) || seq <= 0 || seq === selfSeq) return full
    return `${prefix}[#${digits}](${SWARM_POST_HREF_PREFIX}${digits})`
  })
}

/**
 * Linkify `#seq` references inside a single non-fenced Markdown line while
 * leaving inline code spans and existing Markdown links untouched.
 */
function linkifyLine(line: string, selfSeq: number | undefined): string {
  let out = ''
  let plainStart = 0
  let i = 0
  const flushPlain = (end: number): void => {
    if (end > plainStart) {
      out += linkifyPlainSegment(line.slice(plainStart, end), selfSeq)
    }
  }

  while (i < line.length) {
    const ch = line[i]
    // Inline code span: skip to matching run of backticks.
    if (ch === '`') {
      let tickCount = 1
      while (i + tickCount < line.length && line[i + tickCount] === '`') tickCount += 1
      const closer = '`'.repeat(tickCount)
      const closeIdx = line.indexOf(closer, i + tickCount)
      if (closeIdx !== -1) {
        flushPlain(i)
        const spanEnd = closeIdx + tickCount
        out += line.slice(i, spanEnd)
        i = spanEnd
        plainStart = spanEnd
        continue
      }
      i += tickCount
      continue
    }
    // Existing Markdown link `[label](url)`: skip entire link verbatim so we
    // never produce nested `[[#12](...)](#12)`.
    if (ch === '[') {
      const closeBracket = line.indexOf(']', i + 1)
      if (closeBracket !== -1 && line[closeBracket + 1] === '(') {
        const closeParen = line.indexOf(')', closeBracket + 2)
        if (closeParen !== -1) {
          flushPlain(i)
          const linkEnd = closeParen + 1
          out += line.slice(i, linkEnd)
          i = linkEnd
          plainStart = linkEnd
          continue
        }
      }
    }
    i += 1
  }
  flushPlain(line.length)
  return out
}

/**
 * Convert `#seq` post references in Markdown prose into `#swarm-post-<seq>`
 * links, preserving fenced code blocks, inline code spans, and existing links.
 */
export function linkifyPostRefs(markdown: string, selfSeq?: number): string {
  const lines = markdown.split('\n')
  let activeFenceChar: string | null = null
  let activeFenceLen = 0
  const result: string[] = []

  for (const line of lines) {
    const fenceMatch = FENCE_LINE_RE.exec(line)
    if (activeFenceChar !== null) {
      result.push(line)
      if (
        fenceMatch !== null &&
        fenceMatch[1]![0] === activeFenceChar &&
        fenceMatch[1]!.length >= activeFenceLen &&
        line.slice(fenceMatch[0].length).trim() === ''
      ) {
        activeFenceChar = null
        activeFenceLen = 0
      }
      continue
    }
    if (fenceMatch !== null) {
      activeFenceChar = fenceMatch[1]![0]!
      activeFenceLen = fenceMatch[1]!.length
      result.push(line)
      continue
    }
    result.push(linkifyLine(line, selfSeq))
  }

  return result.join('\n')
}
